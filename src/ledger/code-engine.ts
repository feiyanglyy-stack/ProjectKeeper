/**
 * The general code engine (D98; PRD R-61; Spec §1.16 row 7 "代码结构", §1.19): structure and references of every language
 * the ledger's TypeScript path does not read, from @colbymchenry/codegraph (MIT, pinned in package.json). A project added
 * is read as it is — no project configuration, no SDK, no package fetch, no network — and ProjectKeeper has no code of its
 * own for any of these languages. TypeScript and JavaScript stay on the TypeScript compiler (code.ts `tsDeps`,
 * ts-symbols.ts), which is exact there (the owner, 2026-09-28: 「typescript我们已经写好了，可以就用我们的，其他语言就用通用工具。」).
 *
 * Where it reads: a snapshot of the current version — HEAD's blobs of a repository, the files of a directory outside
 * version control as read — mirrored into a folder ProjectKeeper owns next to the ledger,
 * `<project dir>/code-index/<repository>/tree`: only changed contents are written and removed files deleted. The engine
 * keeps its index in that folder too (`tree/.codegraph/`). Nothing is ever written into the project.
 *
 * How it runs: indexing in a child process of the rebuild (code-engine-child.ts), with V8's `--liftoff-only` — tree-sitter's
 * WASM grammars otherwise exhaust V8's compilation zone (a large Flutter project peaked at 3.9 GB without it, 1.0 GB with it) — with
 * `DO_NOT_TRACK=1`, and with git unable to see any repository around the snapshot; incrementally (`sync`) once an index
 * exists. A symbol question opens the index read-only in the asking process: plain database reads, nothing parsed. Reading
 * a historical version extracts in a child process too.
 *
 * What counts as a reference: one the engine resolved through an import, a path, a qualified name, a function reference or
 * an instance method — never one matched by a name alone (`import { resolve } from 'node:path'` was matched to an unrelated
 * `Ledger.resolve`). Two tiers the engine files under function-ref and instance-method are name matches in its own
 * resolver and do not count either: a cross-file function reference taken as the only function of that name (confidence
 * 0.8), and a method found by its name across the codebase (0.7, 0.65). Measured on a large Flutter project, 35–46% of those land outside the
 * calling file's import closure, against 98% inside at 0.8 and above. A symbol answer still lists every hit, each with its
 * method and confidence and whether it counts; a hit matched by name alone counts there when it is in the declaring file,
 * or its file reaches the declaring file through counted imports (`through`: directly, or through a barrel that re-exports
 * it) — the name is then the imported one. That is how Dart's constructor calls, which the engine matches by name, count as
 * references of their class; on that project every file with such a reference to its store class reaches the class's file that way.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodeGraph, Edge as EngineEdge, Node as EngineNode } from '@colbymchenry/codegraph';
import { OWN_TS_NODE_ARGS } from '../util/own-ts.ts';

type EngineModule = typeof import('@colbymchenry/codegraph');

const requireHere = createRequire(import.meta.url);

export const ENGINE_PACKAGE = '@colbymchenry/codegraph';
export const ENGINE_VERSION: string = (requireHere(`${ENGINE_PACKAGE}/package.json`) as { version: string }).version;
/** What a snapshot and its index were made with: another engine or another counting rule reads the code again. */
export const ENGINE_SIGNATURE = `${ENGINE_PACKAGE}@${ENGINE_VERSION};counted-1`;
export const ENGINE_LABEL = `the code engine (${ENGINE_PACKAGE} ${ENGINE_VERSION})`;

let loaded: EngineModule | string | null = null;
/** The engine, loaded on first use (JavaScript only: loading it compiles no grammar); a string says why it cannot load. */
function engine(): EngineModule | string {
  if (loaded === null) {
    try {
      loaded = requireHere(ENGINE_PACKAGE) as EngineModule;
      loaded.setLogger(loaded.silentLogger);
    } catch (error) {
      loaded = `${ENGINE_LABEL} cannot load on this machine: ${(error as Error).message.split('\n')[0]}`;
    }
  }
  return loaded;
}
/** Why the engine is not available here, or null when it is. */
export function engineUnavailable(): string | null {
  const e = engine();
  return typeof e === 'string' ? e : null;
}

// ───────────────────────── what counts ─────────────────────────

/**
 * The resolution methods whose references count, each from the confidence below which the engine's resolver matched by a
 * name (see the module comment). An edge the extractor made itself carries no method and counts, unless it is marked a
 * heuristic.
 */
export const COUNTED_FROM: Readonly<Record<string, number>> = { import: 0, 'file-path': 0, 'qualified-name': 0, 'function-ref': 0.85, 'instance-method': 0.8 };
export function counts(how: string | null | undefined, confidence: number | null | undefined, provenance?: string | null): boolean {
  if (!how) return provenance !== 'heuristic';
  const floor = COUNTED_FROM[how];
  return floor !== undefined && (typeof confidence !== 'number' || confidence >= floor);
}
/** The words a person reads for how a reference was resolved. */
export const COUNTED_RULE = 'counted: resolved through an import, a path, a qualified name, a function reference or an instance method (the tiers where the engine matched by a name alone do not count)';

// ───────────────────────── the snapshot ─────────────────────────

/** A file of the snapshot: its repository path, what identifies its content (a git blob, a content hash) and the content. */
export interface SnapshotFile { readonly path: string; readonly key: string; readonly content: Buffer }
export interface MirrorStats { readonly files: number; readonly written: number; readonly removed: number; readonly failed: readonly string[] }
interface Manifest { readonly engine: string; readonly files: Readonly<Record<string, string>> }

/** The folder of one repository's (or one directory's) snapshot and index under the project's `code-index/`. */
export function engineDirOf(engineRoot: string, id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '_').slice(0, 48) || 'repo';
  return join(engineRoot, `${safe}-${createHash('sha1').update(id).digest('hex').slice(0, 8)}`);
}
const treeOf = (dir: string): string => join(dir, 'tree');
const indexFileOf = (dir: string): string => join(dir, 'tree', '.codegraph', 'codegraph.db');
/** Whether a snapshot's index is there (a folder removed by hand is read again at the next rebuild). */
export const engineIndexExists = (dir: string): boolean => existsSync(indexFileOf(dir));
export const contentKey = (buf: Buffer): string => createHash('sha1').update(buf).digest('hex');
const osPath = (root: string, rel: string): string => join(root, ...rel.split('/'));

/** The engine's language for a path (its own extension table), or null when it reads no such file. */
export function engineLanguage(path: string): string | null {
  const e = engine();
  if (typeof e === 'string') return null;
  const lang = e.detectLanguage(path);
  return lang && lang !== 'unknown' ? lang : null;
}
/**
 * A tracked path the snapshot does not take: the engine's own data directory, and ignore files — the snapshot already is
 * exactly the tracked files, and a copied `.gitignore` would only drop some of them again.
 */
export const snapshotSkips = (path: string): boolean => /(^|\/)\.codegraph(-[^/]*)?\//i.test(path) || /(^|\/)\.gitignore$/i.test(path);

/** Everything of one snapshot and its index, removed (the repository left the scope, or it has no file the engine reads). */
export function dropEngineDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* the next rebuild tries again */ }
}

/**
 * Mirror the files into `<dir>/tree`: a file whose content is unchanged since the manifest is left alone, a changed or new
 * one written, one no longer there deleted. A folder the manifest does not describe — never mirrored, interrupted, made by
 * another engine — is started over, its index with it.
 */
export function mirrorSnapshot(dir: string, files: readonly SnapshotFile[]): MirrorStats {
  const tree = treeOf(dir);
  const manifestPath = join(dir, 'manifest.json');
  let before: Manifest | null = null;
  try { before = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest; } catch { before = null; }
  if (!before || before.engine !== ENGINE_SIGNATURE || typeof before.files !== 'object' || before.files === null || !existsSync(tree)) {
    dropEngineDir(dir);
    before = { engine: ENGINE_SIGNATURE, files: {} };
  }
  mkdirSync(tree, { recursive: true });
  const next: Record<string, string> = {};
  const failed: string[] = [];
  let written = 0;
  for (const f of files) {
    if (before.files[f.path] === f.key) { next[f.path] = f.key; continue; }
    const target = osPath(tree, f.path);
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content);
      next[f.path] = f.key;
      written += 1;
    } catch {
      failed.push(f.path);   // a name this file system cannot hold: left out of the snapshot, and said
    }
  }
  let removed = 0;
  const parents = new Set<string>();
  for (const path of Object.keys(before.files)) {
    if (path in next) continue;
    try { unlinkSync(osPath(tree, path)); } catch { /* already gone */ }
    removed += 1;
    for (let d = path.lastIndexOf('/'); d > 0; d = path.lastIndexOf('/', d - 1)) parents.add(path.slice(0, d));
  }
  // Directories a removal emptied go too, deepest first; one still holding a file stays.
  for (const d of [...parents].sort((a, b) => b.length - a.length)) { try { rmdirSync(osPath(tree, d)); } catch { /* not empty */ } }
  const tmp = `${manifestPath}.tmp`;
  writeFileSync(tmp, JSON.stringify({ engine: ENGINE_SIGNATURE, files: next } satisfies Manifest));
  renameSync(tmp, manifestPath);
  return { files: Object.keys(next).length, written, removed, failed };
}

// ───────────────────────── indexing, in a child process ─────────────────────────

export interface EngineRun {
  /** `full`: indexed from nothing; `sync`: brought up to date; `none`: nothing changed and the index stands. */
  readonly ran: 'full' | 'sync' | 'none';
  readonly ok: boolean;
  readonly ms: number;
  /** Peak memory of the indexing process. */
  readonly peakMemoryMB: number | null;
  readonly files: number;
  readonly indexBytes: number;
  readonly error: string | null;
}

const CHILD = fileURLToPath(new URL('./code-engine-child.ts', import.meta.url));
/** V8's baseline WASM compiler only (see the module comment), and node:sqlite's experimental notice kept quiet. */
export const ENGINE_NODE_FLAGS: readonly string[] = ['--liftoff-only', '--disable-warning=ExperimentalWarning'];
const INDEX_TIMEOUT_MS = 30 * 60_000;

/** The child's environment: no telemetry, no update check, and git blind to any repository around the snapshot. */
function childEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const k = key.toUpperCase();
    if (k.startsWith('GIT_') || k === 'NODE_TEST_CONTEXT' || k === 'CODEGRAPH_DIR') continue;
    env[key] = value;
  }
  env.DO_NOT_TRACK = '1';
  env.CODEGRAPH_TELEMETRY = '0';
  env.CODEGRAPH_NO_UPDATE_CHECK = '1';
  env.GIT_CEILING_DIRECTORIES = dir;
  return env;
}

function runChild(dir: string, args: readonly string[], input: string | null, timeoutMs: number): { json: Record<string, unknown> | null; error: string | null } {
  const r = spawnSync(process.execPath, [...ENGINE_NODE_FLAGS, ...OWN_TS_NODE_ARGS, CHILD, ...args], {
    cwd: dir, env: childEnv(dir), encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024,
    ...(input === null ? { stdio: ['ignore', 'pipe', 'pipe'] } : { input }),
  });
  const line = (r.stdout ?? '').trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
  let json: Record<string, unknown> | null = null;
  try { json = line ? JSON.parse(line) as Record<string, unknown> : null; } catch { json = null; }
  if (r.error) return { json, error: r.error.message };
  if (r.status !== 0 || !json || json.ok !== true) {
    const why = (typeof json?.error === 'string' ? json.error : '') || (r.stderr ?? '').trim().split('\n').slice(-3).join(' ') || `exit ${r.status ?? r.signal}`;
    return { json, error: why };
  }
  return { json, error: null };
}

/** Size of the engine's data directory in the snapshot. */
function indexBytesOf(dir: string): number {
  const data = join(treeOf(dir), '.codegraph');
  try { return readdirSync(data).reduce((n, f) => { try { return n + statSync(join(data, f)).size; } catch { return n; } }, 0); } catch { return 0; }
}

/** Index the snapshot, or bring its index up to date, unless nothing changed and a complete index stands. */
export function indexSnapshot(dir: string, changed: boolean): EngineRun {
  const unavailable = engineUnavailable();
  if (unavailable) return { ran: 'none', ok: false, ms: 0, peakMemoryMB: null, files: 0, indexBytes: 0, error: unavailable };
  if (!changed && existsSync(indexFileOf(dir))) return { ran: 'none', ok: true, ms: 0, peakMemoryMB: null, files: -1, indexBytes: indexBytesOf(dir), error: null };
  const started = Date.now();
  const { json, error } = runChild(dir, ['index', treeOf(dir)], null, INDEX_TIMEOUT_MS);
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    ran: json?.mode === 'sync' ? 'sync' : 'full', ok: error === null, ms: Date.now() - started,
    peakMemoryMB: typeof json?.peakMemoryMB === 'number' ? json.peakMemoryMB : null, files: num(json?.files), indexBytes: indexBytesOf(dir), error,
  };
}

// ───────────────────────── reading the index into the ledger ─────────────────────────

export interface EngineFile { readonly language: string; readonly code: boolean; readonly parseErrors: number }
export interface EngineDep { readonly src: string; readonly dst: string; readonly kind: string; readonly external: boolean }
export interface EngineLanguageReach {
  readonly language: string;
  /** Files it read references of, and files it only tracks (no symbol, no import: data such as YAML or a manifest). */
  readonly files: number;
  readonly trackedOnly: number;
  readonly parseErrors: number;
  /** Import specifiers resolved to a file of the repository, and not (packages, SDKs — and in-repo ones it missed). */
  readonly imports: { readonly resolved: number; readonly unresolved: number; readonly unresolvedNamingRepoFiles: number; readonly sample: readonly string[] };
  /** References between files by resolution method: counted, and matched by a name only (not counted). */
  readonly counted: Readonly<Record<string, number>>;
  readonly nameOnly: Readonly<Record<string, number>>;
}
export interface EngineRead {
  readonly files: ReadonlyMap<string, EngineFile>;
  readonly deps: readonly EngineDep[];
  readonly languages: readonly EngineLanguageReach[];
}

const sqlite = (): typeof import('node:sqlite') => requireHere('node:sqlite') as typeof import('node:sqlite');
const norm = (p: string): string => p.split('\\').join('/').replace(/^\.\//, '');
const lastSegment = (spec: string): string => spec.split(/[/\\:]/).pop() ?? spec;
/** The engine says `imports`; the ledger's words for a file dependency are the TypeScript path's (`import`). */
const depKind = (k: string): string => (k === 'imports' ? 'import' : k);

/**
 * The files, the counted references between files, the unresolved imports (the external dependencies) and the numbers per
 * language, read from the index. An unresolved import that names a file of its own language by its stem (`specifierNames`)
 * is counted apart: an in-repository import the engine did not resolve. A string when the index cannot be read.
 */
export function readEngineIndex(dir: string): EngineRead | string {
  let db: import('node:sqlite').DatabaseSync;
  try { db = new (sqlite().DatabaseSync)(indexFileOf(dir), { readOnly: true }); } catch (error) { return `the engine's index cannot be opened: ${(error as Error).message}`; }
  try {
    const files = new Map<string, EngineFile>();
    for (const r of db.prepare(`SELECT f.path, f.language, f.errors, EXISTS (SELECT 1 FROM nodes n WHERE n.file_path = f.path AND n.kind <> 'file') code FROM files f`).all() as { path: string; language: string; errors: string | null; code: number }[]) {
      let errors = 0;
      try { const e = JSON.parse(r.errors ?? '[]') as { severity?: string }[]; errors = Array.isArray(e) ? e.filter((x) => x?.severity !== 'warning').length : 0; } catch { errors = 0; }
      files.set(norm(r.path), { language: r.language, code: r.code === 1, parseErrors: errors });
    }
    const langOfFile = (p: string): string => files.get(p)?.language ?? 'unknown';
    const reach = new Map<string, { files: number; trackedOnly: number; parseErrors: number; resolved: number; unresolved: number; naming: number; sample: string[]; counted: Record<string, number>; nameOnly: Record<string, number> }>();
    const bucket = (lang: string) => {
      let b = reach.get(lang);
      if (!b) reach.set(lang, b = { files: 0, trackedOnly: 0, parseErrors: 0, resolved: 0, unresolved: 0, naming: 0, sample: [], counted: {}, nameOnly: {} });
      return b;
    };
    for (const f of files.values()) { const b = bucket(f.language); if (f.code) b.files += 1; else b.trackedOnly += 1; b.parseErrors += f.parseErrors; }

    const deps = new Map<string, EngineDep>();
    const importTargetsByLine = new Map<string, Set<string>>();
    const importTargetsByRef = new Map<string, Set<string>>();
    const add = (m: Map<string, Set<string>>, k: string, v: string) => { const s = m.get(k); if (s) s.add(v); else m.set(k, new Set([v])); };
    const edges = db.prepare(`SELECT e.kind, e.line, e.provenance prov, json_extract(e.metadata, '$.resolvedBy') how, json_extract(e.metadata, '$.confidence') conf,
        json_extract(e.metadata, '$.refName') ref, s.file_path sf, t.file_path tf
      FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE e.kind <> 'contains' AND s.file_path <> t.file_path AND t.kind <> 'import'`).all() as { kind: string; line: number | null; prov: string | null; how: string | null; conf: number | null; ref: string | null; sf: string; tf: string }[];
    for (const e of edges) {
      const src = norm(e.sf);
      const dst = norm(e.tf);
      const b = bucket(langOfFile(src));
      const method = e.how ?? 'extraction';
      if (!counts(e.how, e.conf, e.prov)) { b.nameOnly[method] = (b.nameOnly[method] ?? 0) + 1; continue; }
      b.counted[method] = (b.counted[method] ?? 0) + 1;
      const kind = depKind(e.kind);
      deps.set(`${src}\0${dst}\0${kind}`, { src, dst, kind, external: false });
      if (e.kind === 'imports') {
        if (e.line !== null) add(importTargetsByLine, `${src}\0${e.line}`, dst);
        if (e.ref) add(importTargetsByRef, `${src}\0${e.ref}`, dst);
      }
    }
    // The names and stems of each language's files, for an unresolved import that names one of them.
    const names = new Map<string, Set<string>>();
    const stems = new Map<string, Set<string>>();
    for (const [path, f] of files) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      (names.get(f.language) ?? names.set(f.language, new Set()).get(f.language)!).add(name);
      (stems.get(f.language) ?? stems.set(f.language, new Set()).get(f.language)!).add(name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name);
    }
    const namesARepoFile = (spec: string, lang: string): boolean => {
      const n = names.get(lang);
      const s = stems.get(lang);
      if (!n || !s) return false;
      if (n.has(spec)) return true;
      if (/[/\\:]/.test(spec)) { const last = lastSegment(spec); return n.has(last) || s.has(last) || (last.includes('.') && s.has(last.slice(0, last.lastIndexOf('.')))); }
      return s.has(spec.split('.').pop() ?? '');
    };
    // Each import statement: resolved when a counted import from its lines (or by its specifier) reaches another file.
    for (const i of db.prepare("SELECT file_path f, name, start_line a, end_line b FROM nodes WHERE kind = 'import'").all() as { f: string; name: string; a: number; b: number }[]) {
      const src = norm(i.f);
      let hit = importTargetsByRef.has(`${src}\0${i.name}`);
      for (let l = i.a; !hit && l <= Math.max(i.a, i.b); l++) hit = importTargetsByLine.has(`${src}\0${l}`);
      const lang = langOfFile(src);
      const b = bucket(lang);
      if (hit) { b.resolved += 1; continue; }
      b.unresolved += 1;
      deps.set(`${src}\0${i.name}\0import`, { src, dst: i.name, kind: 'import', external: true });
      if (namesARepoFile(i.name, lang)) { b.naming += 1; if (b.sample.length < 5) b.sample.push(`${src}: ${i.name}`); }
    }
    const languages: EngineLanguageReach[] = [...reach.entries()].sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0])).map(([language, b]) => ({
      language, files: b.files, trackedOnly: b.trackedOnly, parseErrors: b.parseErrors,
      imports: { resolved: b.resolved, unresolved: b.unresolved, unresolvedNamingRepoFiles: b.naming, sample: b.sample }, counted: b.counted, nameOnly: b.nameOnly,
    }));
    return { files, deps: [...deps.values()], languages };
  } catch (error) {
    return `the engine's index has another shape than ${ENGINE_LABEL} writes: ${(error as Error).message}`;
  } finally {
    db.close();
  }
}

// ───────────────────────── symbols, on demand ─────────────────────────

export type SymbolQueryKind = 'references' | 'implementations' | 'callers' | 'callees';
export interface EngineHit {
  readonly file: string;
  readonly line: number;
  readonly character?: number;
  readonly preview: string;
  /** The symbol at the other end: what refers (references, callers), what is referred to (callees), what implements. */
  readonly from?: string;
  readonly to?: string;
  /** The kind of reference (calls, references, imports, instantiates, extends, implements …). */
  readonly edge: string;
  /** How the engine resolved it, how sure it was, and whether the ledger counts it (see the module comment). */
  readonly how: string;
  readonly confidence: number | null;
  readonly counted: boolean;
  /**
   * Why a hit the engine matched by name alone counts all the same: it is in the declaring file, or its file imports the
   * declaring file (for a callee: the asking file imports the callee's) — the name is then the imported one.
   */
  readonly through?: string;
}
export interface EngineSymbolResult {
  readonly answeredBy: string;
  readonly symbol: string;
  readonly symbolKind: string;
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly locations?: readonly EngineHit[];
  readonly incoming?: readonly EngineHit[];
  readonly outgoing?: readonly EngineHit[];
}

const NOT_A_SYMBOL = new Set(['file', 'import', 'export', 'parameter']);

/**
 * Through counted imports, for a hit matched by name: the files reaching `file` (directly: they import it; or through files
 * that do, as a barrel that re-exports it), and the files `file` reaches — each with the number of hops.
 */
function importLinks(dir: string, file: string): { into: Map<string, number>; from: Map<string, number> } {
  const db = new (sqlite().DatabaseSync)(indexFileOf(dir), { readOnly: true });
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  try {
    for (const r of db.prepare(`SELECT DISTINCT s.file_path sf, t.file_path tf FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
        WHERE e.kind = 'imports' AND s.file_path <> t.file_path AND t.kind <> 'import'
          AND json_extract(e.metadata, '$.resolvedBy') IN ('import', 'file-path', 'qualified-name')`).all() as { sf: string; tf: string }[]) {
      const a = norm(r.sf); const b = norm(r.tf);
      forward.set(a, [...(forward.get(a) ?? []), b]);
      backward.set(b, [...(backward.get(b) ?? []), a]);
    }
  } finally {
    db.close();
  }
  const walk = (graph: Map<string, string[]>): Map<string, number> => {
    const hops = new Map<string, number>([[file, 0]]);
    const queue = [file];
    while (queue.length) { const x = queue.shift()!; for (const y of graph.get(x) ?? []) if (!hops.has(y)) { hops.set(y, hops.get(x)! + 1); queue.push(y); } }
    hops.delete(file);
    return hops;
  };
  return { into: walk(backward), from: walk(forward) };
}

/** A symbol question on a snapshot's index: `input.file` repository-relative, the symbol by name or by 1-based line and character. */
export function engineSymbol(dir: string, kind: SymbolQueryKind, input: { file: string; line?: number; character?: number; name?: string }): EngineSymbolResult | string {
  const e = engine();
  if (typeof e === 'string') return e;
  if (!existsSync(indexFileOf(dir))) return `${ENGINE_LABEL} has no index for this repository yet: the round's first step builds it.`;
  const file = norm(input.file);
  let cg: CodeGraph;
  try { cg = e.CodeGraph.openSync(treeOf(dir)); } catch (error) { return `The engine's index cannot be opened: ${(error as Error).message}`; }
  try {
    const nodes = cg.getNodesInFile(file).filter((n) => !NOT_A_SYMBOL.has(n.kind));
    if (!nodes.length && !cg.getFile(file)) return `${file} is not in ${ENGINE_LABEL}'s index of the current version.`;
    let target: EngineNode | undefined;
    if (input.name) {
      // A bare name, or one qualified by its container: `OrderStore.getOrder` or `OrderStore::getOrder`.
      const want = input.name.trim();
      const qualified = want.split('.').join('::');
      const byName = nodes.filter((n) => (/::|\./.test(want)
        ? [want, qualified].some((w) => n.qualifiedName === w || n.qualifiedName.endsWith(`::${w}`) || n.qualifiedName.endsWith(`.${w}`))
        : n.name === want));
      target = byName.sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn)[0];
      if (!target) return `No declaration named “${want}” in ${file}.`;
    } else if (typeof input.line === 'number') {
      const line = input.line;
      const col = typeof input.character === 'number' ? input.character - 1 : null;
      const inside = nodes.filter((n) => n.startLine <= line && line <= n.endLine && (col === null || ((n.startLine < line || n.startColumn <= col) && (n.endLine > line || n.endColumn >= col))));
      target = inside.sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine) || b.startLine - a.startLine || b.startColumn - a.startColumn)[0];
      if (!target) return `No symbol at ${file}:${line}${col !== null ? `:${col + 1}` : ''}.`;
    } else {
      return 'Give either line + character (1-based) or a symbol name.';
    }
    const lines = new Map<string, string[]>();
    const preview = (path: string, line: number): string => {
      let ls = lines.get(path);
      if (!ls) { try { ls = readFileSync(osPath(treeOf(dir), path), 'utf8').split(/\r?\n/); } catch { ls = []; } lines.set(path, ls); }
      const t = (ls[line - 1] ?? '').trim();
      return t.length > 200 ? `${t.slice(0, 200)}…` : t;
    };
    const targetFile = norm(target.filePath);
    const links = importLinks(dir, targetFile);
    /** `other` is the file at the far end: the referring one (in), or the referred one (out). */
    const meta = (edge: EngineEdge, other: string, direction: 'in' | 'out') => {
      const m = (edge.metadata ?? {}) as { resolvedBy?: string; confidence?: number };
      const how = m.resolvedBy ?? null;
      const confidence = typeof m.confidence === 'number' ? m.confidence : null;
      const counted = counts(how, confidence, edge.provenance ?? null);
      const hops = (direction === 'in' ? links.into : links.from).get(other);
      const through = counted ? null
        : other === targetFile ? 'in the declaring file'
        : hops === 1 ? (direction === 'in' ? 'its file imports the declaring file' : 'the asking file imports its file')
        : hops !== undefined ? (direction === 'in' ? `its file reaches the declaring file through imports (${hops} steps)` : `the asking file reaches its file through imports (${hops} steps)`)
        : null;
      return { edge: edge.kind, how: how ?? 'extraction', confidence, counted: counted || through !== null, ...(through ? { through } : {}) };
    };
    const name = (n: EngineNode) => `${n.kind} ${n.qualifiedName}`;
    const order = (a: EngineHit, b: EngineHit) => Number(b.counted) - Number(a.counted) || a.file.localeCompare(b.file) || a.line - b.line;
    const base = { answeredBy: ENGINE_LABEL, symbol: target.qualifiedName, symbolKind: target.kind, file: targetFile, line: target.startLine, rule: `${COUNTED_RULE}; a hit matched by name counts when it is in the declaring file or its file reaches the declaring file through imports (through)` };
    if (kind === 'references') {
      const hits = cg.findUsages(target.id).filter((u) => u.edge.kind !== 'contains').map((u): EngineHit => {
        const f = norm(u.node.filePath);
        const line = u.edge.line ?? u.node.startLine;
        return { file: f, line, ...(typeof u.edge.column === 'number' ? { character: u.edge.column + 1 } : {}), preview: preview(f, line), from: name(u.node), ...meta(u.edge, f, 'in') };
      });
      return { ...base, locations: hits.sort(order) };
    }
    if (kind === 'callers') {
      const hits = cg.getCallers(target.id, 1).map((c): EngineHit => {
        const f = norm(c.node.filePath);
        const line = c.edge.line ?? c.node.startLine;
        return { file: f, line, preview: preview(f, line), from: name(c.node), ...meta(c.edge, f, 'in') };
      });
      return { ...base, incoming: hits.sort(order) };
    }
    if (kind === 'callees') {
      const hits = cg.getCallees(target.id, 1).map((c): EngineHit => {
        const f = norm(c.node.filePath);
        return { file: f, line: c.node.startLine, preview: preview(f, c.node.startLine), to: name(c.node), ...meta(c.edge, f, 'out') };
      });
      return { ...base, outgoing: hits.sort(order) };
    }
    // Implementations: what extends or implements it, directly or through another that does — read from those edges.
    // (The engine's own getTypeHierarchy marks the symbol visited on its way to the ancestors, so in 1.6.0 it never
    // returns the descendants.)
    const hits: EngineHit[] = [];
    const seen = new Set<string>([target.id]);
    const queue = [target.id];
    while (queue.length) {
      for (const edge of cg.getIncomingEdges(queue.shift()!)) {
        if ((edge.kind !== 'extends' && edge.kind !== 'implements') || seen.has(edge.source)) continue;
        seen.add(edge.source);
        queue.push(edge.source);
        const n = cg.getNode(edge.source);
        if (!n) continue;
        const f = norm(n.filePath);
        hits.push({ file: f, line: n.startLine, preview: preview(f, n.startLine), from: name(n), ...meta(edge, f, 'in') });
      }
    }
    return { ...base, locations: hits.sort(order) };
  } finally {
    cg.close();
  }
}

// ───────────────────────── history, in a child process ─────────────────────────

/**
 * The import specifiers of each version of one file, as the engine extracts them (one child process for all of them); a
 * version given as null stays null. A string when the engine cannot read them.
 */
export function engineImportsOf(path: string, sources: readonly (string | null)[], workDir: string): (readonly string[] | null)[] | string {
  const unavailable = engineUnavailable();
  if (unavailable) return unavailable;
  mkdirSync(workDir, { recursive: true });
  const { json, error } = runChild(workDir, ['imports', path], JSON.stringify(sources), 10 * 60_000);
  if (error) return `${ENGINE_LABEL} could not read the versions of ${path}: ${error}`;
  const out = json?.imports;
  return Array.isArray(out) ? out as (string[] | null)[] : `${ENGINE_LABEL} gave no answer for ${path}.`;
}

/**
 * Whether an import specifier names a file by its stem: a path or URI-like specifier by its last segment (after `/`, `\`
 * or `:`), with or without the extension; a bare one by itself or by the last part of a dotted module path —
 * `package:shop_app/core/x.dart`, `../util`, `pkg.sub`, `com.example.Bar` name `x.dart`, `util.ts`, `sub.py`, `Bar.kt`.
 */
export function specifierNames(spec: string, fileName: string): boolean {
  const stem = fileName.includes('.') ? fileName.slice(0, fileName.lastIndexOf('.')) : fileName;
  if (spec === fileName) return true;
  if (/[/\\:]/.test(spec)) {
    const last = lastSegment(spec);
    return last === fileName || last === stem || (last.includes('.') && last.slice(0, last.lastIndexOf('.')) === stem);
  }
  return (spec.split('.').pop() ?? '') === stem;
}
