/**
 * Read project files into sources (Spec §1.2). Markdown is split into sections by heading,
 * each section a source with its heading path and line range; other text files become one
 * source each with a head excerpt. Binary and oversized files are skipped and reported.
 * Nothing is written to the project.
 *
 * What is read from where follows the scope (Spec §1.1; ../scope/skip.ts): the project's ignore rules leave content out
 * (git decides), generated output is not read, third-party material gives only its documents (as `Reference only`),
 * and a registered worktree gives only what it adds to the trunk (E60).
 */
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ScopeItem, Source } from '../model/types.ts';
import type { UsedAs } from '../model/vocab.ts';
import { fingerprint } from '../model/ids.ts';
import { isWithin, normalizePath, pathKey } from '../util/paths.ts';
import { extractIds, makeFileSource } from './anchor.ts';
import { isDocumentPath, isReadRoot, isSkippedName, overridesIgnoreRules, readingOf, treatmentOf } from '../scope/skip.ts';
import { ignoredPredicate } from '../scope/ignore.ts';
import { measureWorktree } from '../scope/worktree.ts';
import { OWN_TS_WORKER_OPTIONS } from '../util/own-ts.ts';

export interface FileEntry {
  readonly path: string;
  readonly scopeItemId: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  /** The `Used as` the file's location sets (§1.1: the documents third-party material brings are `Reference only`). */
  readonly usedAs?: { readonly value: UsedAs; readonly by: 'keeper' | 'owner'; readonly scopeItemId: string } | null;
}
export interface ScanResult {
  readonly files: readonly FileEntry[];
  readonly sources: readonly Source[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.kt', '.cs', '.c', '.cc', '.cpp', '.h', '.hpp', '.css', '.html', '.sh', '.ps1', '.bat', '.sql', '.xml', '.ini', '.cfg', '.env.example', '.gitignore', '.gitattributes']);
const MAX_FILE_BYTES = 2_000_000;
const MAX_SECTION_CHARS = 14_000;
const CODE_HEAD_LINES = 120;

export function isTextFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  const base = path.split(/[\\/]/).pop() ?? '';
  return ['README', 'LICENSE', 'AGENTS.md', 'CLAUDE.md', 'Makefile'].includes(base);
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4000);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

export interface MarkdownSection {
  readonly headingPath: readonly string[];
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly text: string;
}

/** Split markdown into sections by heading; text before the first heading is its own section. */
export function splitMarkdown(text: string): MarkdownSection[] {
  const lines = text.split(/\r?\n/);
  const sections: MarkdownSection[] = [];
  const stack: { level: number; title: string }[] = [];
  let start = 0;
  let inFence = false;
  const flush = (end: number) => {
    if (end < start) return;
    const body = lines.slice(start, end + 1).join('\n');
    if (body.trim().length === 0) return;
    sections.push({ headingPath: stack.map((s) => s.title), lineStart: start + 1, lineEnd: end + 1, text: body });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    flush(i - 1);
    const level = m[1]!.length;
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, title: m[2]!.trim().replace(/\s+#+\s*$/, '') });
    start = i;
  }
  flush(lines.length - 1);
  return sections;
}

/** Cut a long section into parts at paragraph boundaries so excerpts stay readable. */
function splitLong(section: MarkdownSection): MarkdownSection[] {
  if (section.text.length <= MAX_SECTION_CHARS) return [section];
  const parts: MarkdownSection[] = [];
  const lines = section.text.split('\n');
  let buf: string[] = [];
  let bufStart = section.lineStart;
  let part = 1;
  const flush = (endLine: number) => {
    if (buf.length === 0) return;
    parts.push({ headingPath: [...section.headingPath, `part ${part}`], lineStart: bufStart, lineEnd: endLine, text: buf.join('\n') });
    part += 1;
    buf = [];
    bufStart = endLine + 1;
  };
  let size = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (size + line.length > MAX_SECTION_CHARS && buf.length > 0 && line.trim() === '') flush(section.lineStart + i - 1);
    buf.push(line);
    size = buf.reduce((n, l) => n + l.length + 1, 0);
  }
  flush(section.lineEnd);
  return parts;
}

/**
 * The files of one scope item's own region: what the one skip list leaves out is not entered, links are not followed,
 * and a location that is a scope item of its own (`separate`) is left to that item. `ignored` is the project's ignore
 * rules for this root (relative paths), `keep` the ignored files the owner chose to include anyway.
 */
function walkRegion(root: string, scopeItemId: string, opts: {
  readonly separate?: ReadonlySet<string>; readonly ignored?: ((rel: string) => boolean) | null; readonly keep?: ReadonlySet<string>;
  readonly documentsOnly?: boolean; readonly usedAs?: FileEntry['usedAs'];
} = {}): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    let entries: Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (opts.separate?.has(pathKey(full))) continue;
      if (opts.ignored && opts.ignored(relative(root, full).split('\\').join('/')) && !opts.keep?.has(pathKey(full))) continue;
      if (e.isDirectory()) { if (!isSkippedName(e.name)) walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (opts.documentsOnly && !isDocumentPath(e.name)) continue;
      let st;
      try { st = statSync(full); } catch { continue; }
      out.push({ path: normalizePath(full), scopeItemId, bytes: st.size, mtimeMs: st.mtimeMs, usedAs: opts.usedAs ?? null });
    }
  };
  walk(root, 0);
  return out;
}

/** Every file under `root` except what the skip list leaves out and the `excluded` locations. */
export function listFiles(root: string, scopeItemId: string, excluded: readonly string[]): FileEntry[] {
  return walkRegion(root, scopeItemId).filter((f) => !excluded.some((e) => isWithin(e, f.path)));
}

/**
 * Read one file into sources. `scope`, when given, sets the `Used as` the file's location implies (third-party
 * documents are `Reference only`) for an entry that does not carry it already.
 */
export function readFileSources(projectId: string, entry: FileEntry, commit: string | null = null, scope: readonly ScopeItem[] | null = null): { sources: Source[]; skipped: string | null } {
  if (entry.bytes > MAX_FILE_BYTES) return { sources: [], skipped: `larger than ${MAX_FILE_BYTES} bytes` };
  if (!isTextFile(entry.path)) return { sources: [], skipped: 'not a text file type' };
  let buf: Buffer;
  try { buf = readFileSync(entry.path); } catch (e) { return { sources: [], skipped: `unreadable: ${(e as Error).message}` }; }
  if (looksBinary(buf)) return { sources: [], skipped: 'binary content' };
  const text = buf.toString('utf8');
  const readAt = new Date().toISOString();
  const ext = extname(entry.path).toLowerCase();
  const sources: Source[] = [];
  const usedAs = entry.usedAs ?? (scope ? readingOf(scope, entry.path).usedAs : null);
  const judged = (s: Source): Source => (usedAs ? { ...s, usedAs: usedAs.value, usedAsBy: usedAs.by, usedAsByScopeItemId: usedAs.scopeItemId } : s);
  if (ext === '.md' || ext === '.markdown') {
    for (const section of splitMarkdown(text).flatMap(splitLong)) {
      sources.push(judged(makeFileSource({
        projectId, path: entry.path, headingPath: section.headingPath, lineStart: section.lineStart, lineEnd: section.lineEnd,
        excerpt: section.text, fileText: text, scopeItemId: entry.scopeItemId, ids: extractIds(section.text), commit, readAt,
        title: section.headingPath.length ? section.headingPath[section.headingPath.length - 1]! : entry.path.split(/[\\/]/).pop()!,
      })));
    }
    return { sources, skipped: null };
  }
  const lines = text.split(/\r?\n/);
  const head = lines.slice(0, CODE_HEAD_LINES).join('\n');
  sources.push(judged(makeFileSource({
    projectId, path: entry.path, headingPath: [], lineStart: 1, lineEnd: Math.min(lines.length, CODE_HEAD_LINES),
    excerpt: lines.length > CODE_HEAD_LINES ? `${head}\n…(${lines.length} lines in total; the Keeper reads the rest on demand)` : head,
    fileText: text, scopeItemId: entry.scopeItemId, ids: extractIds(head), commit, readAt,
  })));
  return { sources, skipped: null };
}

/** Full scan of every included directory in scope. */
/** The same scan on a worker thread: a large project must not freeze the workbench while it is read (CKC-09 AC-1). */
export function scanFilesAsync(projectId: string, scope: readonly ScopeItem[]): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./scan-worker.ts', import.meta.url), { workerData: { projectId, scope }, ...OWN_TS_WORKER_OPTIONS });
    let settled = false;
    worker.once('message', (result: ScanResult) => { settled = true; resolve(result); void worker.terminate(); });
    worker.once('error', (error) => { settled = true; reject(error); });
    worker.once('exit', (code) => { if (!settled) reject(new Error(`file scan worker exited with code ${code}`)); });
  });
}

/** The files a registered worktree adds to the trunk (E60), measured now from git's records. */
function worktreeFiles(item: ScopeItem): FileEntry[] {
  if (!item.worktreeOf) return [];
  const measured = measureWorktree(item.path, item.worktreeOf);
  const out: FileEntry[] = [];
  for (const t of measured.taken) {
    if (t.deleted) continue;
    const full = join(item.path, t.path);
    try {
      const st = statSync(full);
      if (st.isFile()) out.push({ path: normalizePath(full), scopeItemId: item.id, bytes: st.size, mtimeMs: st.mtimeMs, usedAs: null });
    } catch { /* gone since it was measured */ }
  }
  return out;
}

/**
 * Every scope item read in its own region, as its relation says (../scope/skip.ts `treatmentOf`): a location that is
 * an item of its own is read — or not — by that item, so nothing is read twice and nothing left out comes in through
 * a directory above it.
 */
export function scanFiles(projectId: string, scope: readonly ScopeItem[]): ScanResult {
  const locations = scope.filter((i) => i.category !== 'Session source');
  // Locations read (or left out) by an item of their own. Ignored files the owner took in are read where they lie.
  const itemPaths = new Set(locations.filter((i) => !(i.ignoredBy?.paths && i.relation !== 'Excluded')).map((i) => pathKey(i.path)));
  // Ignored files the owner chose to include anyway (an answer to the scope question, or a correction).
  // Files ignored one by one are listed per directory, so each lives in the directory of its item's path.
  const keep = new Set(locations.filter((i) => i.relation !== 'Excluded' && i.ignoredBy?.paths).flatMap((i) => (i.ignoredBy!.paths ?? []).map((p) => pathKey(join(dirname(i.path), p.split('/').pop()!)))));
  const files: FileEntry[] = [];
  const sources: Source[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const root of locations.filter((i) => isReadRoot(scope, i))) {
    const treatment = treatmentOf(root);
    let entries: FileEntry[];
    if (root.category === 'Worktree' && (treatment === 'changes' || treatment === 'history')) {
      entries = worktreeFiles(root);
    } else {
      try { if (!statSync(root.path).isDirectory()) continue; } catch { continue; }
      const separate = new Set([...itemPaths].filter((p) => p !== pathKey(root.path)));
      const documents = treatment === 'documents';
      entries = walkRegion(root.path, root.id, {
        separate,
        ignored: overridesIgnoreRules(scope, root) ? null : ignoredPredicate(root.path),
        keep,
        documentsOnly: documents,
        usedAs: documents ? { value: 'Reference only', by: root.classification?.by === 'owner' ? 'owner' : 'keeper', scopeItemId: root.id } : null,
      });
    }
    for (const entry of entries) {
      files.push(entry);
      const read = readFileSources(projectId, entry);
      if (read.skipped) { if (isTextFile(entry.path) || entry.bytes > MAX_FILE_BYTES) skipped.push({ path: entry.path, reason: read.skipped }); continue; }
      sources.push(...read.sources);
    }
  }
  return { files, sources, skipped };
}

export function fileFingerprint(path: string): string | null {
  try { return fingerprint(readFileSync(path)); } catch { return null; }
}

export function displayPath(root: string, path: string): string {
  return relative(root, path).split('\\').join('/');
}
