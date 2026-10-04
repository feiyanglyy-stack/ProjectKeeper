/**
 * Project scope discovery (Spec §1.1, §3.7 stage 1, §6.7; CKC-04).
 *
 * From the locations the owner gave, work out what the project includes: directories,
 * repositories, registered worktrees (also outside the directory), nested independent
 * repositories, copies of other projects, archived or moved-out material with the reason
 * its own README gives, and where the sessions for these paths live. Everything is derived
 * from what is on disk; questions are raised only when the ambiguity would change the
 * result (§3.9). Nothing here changes project content.
 *
 * Spec v2.8 adds (CKC-04 AC-1, AC-13–AC-17): each registered worktree measured against the trunk from git's records
 * (./worktree.ts); what the project's own ignore rules leave out, listed by directory with the rule, and ignored
 * documents put to the owner (./ignore.ts); third-party material and generated output nobody ignored, offered for the
 * Keeper to judge (./candidates.ts); and what the Keeper, the project's rules and the owner then decide
 * (./decisions.ts). What each item means for reading is in ./skip.ts, the one skip list.
 */
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative } from 'node:path';
import type { ProjectRule, ScopeClassification, ScopeItem, ScopeJudgement, ScopeQuestion } from '../model/types.ts';
import type { ScopeRelation, SessionHost } from '../model/vocab.ts';
import { stableId } from '../model/ids.ts';
import { git, gitCommonDir, gitDir, gitRemotes, gitRootCommits, gitToplevel, gitWorktrees } from '../util/git.ts';
import { isWithin, normalizePath, pathKey, samePath } from '../util/paths.ts';
import { locateSessionsForHomes, type LocatedSession } from '../sources/sessions/locate.ts';
import { sameSessionItem } from '../sources/sessions/scope.ts';
import { discoverToolchain, type ToolchainRoot } from './toolchain.ts';
import { classifyName, isDocumentPath, isSkippedName, isVendoredName, NOT_READ_KINDS } from './skip.ts';
import { ignoredEntries, predicateFrom, type IgnoreRule } from './ignore.ts';
import { measureWorktree, trunkOf, worktreeSentence } from './worktree.ts';
import { findCandidates, licenseIn, type Candidate } from './candidates.ts';
import { applyDecisions, ignoredQuestionId } from './decisions.ts';

export interface ReasonRef {
  readonly path: string;
  readonly headingPath: readonly string[];
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly excerpt: string;
}

export interface DiscoveredItem extends ScopeItem {
  readonly reasonRef: ReasonRef | null;
  readonly sessions?: readonly LocatedSession[];
}

export interface DiscoveryResult {
  readonly items: readonly DiscoveredItem[];
  readonly questions: readonly ScopeQuestion[];
  readonly missingSourceKinds: readonly { readonly kind: string; readonly reason: string }[];
  readonly roles: readonly string[];
  readonly language: string;
  /** §6.7 (B2) toolchain locations the project's own config points at; also allowed read roots (§3.1). */
  readonly toolchain: readonly ToolchainRoot[];
}

export interface DiscoveryOptions {
  readonly home?: string;
  /** Answers the owner already gave (kept across rescans). */
  readonly existingQuestions?: readonly ScopeQuestion[];
  /** Items the owner added or removed by hand; kept as they are. */
  readonly ownerItems?: readonly ScopeItem[];
  /** B2: the ProjectKeeper home in use, so a toolchain location inside or above it is not used (§3.1). */
  readonly projectKeeperHome?: string;
  /** §1.15 the project's rules: the directories and branches a material rule names are marked with it (AC-1, AC-14). */
  readonly rules?: readonly ProjectRule[];
  /** §1.1 the Keeper's classifications and the owner's corrections (`pk_classify_scope`). */
  readonly judgements?: readonly ScopeJudgement[];
  /** Where a rule's source is, for the listing's reason (the asset store knows; discovery does not). */
  readonly sourceLabel?: (sourceId: string) => string | null;
}

const ARCHIVE_NAMES = /^(archive|archived|delete|deleted|discarded|superseded|trash|old|legacy)/i;
const REASON_FILES = ['README.md', 'RESTORE.md', 'readme.md', 'ARCHIVE.md', 'NOTES.md'];
const ROLE_NAMES = ['Main agent', 'Product architect', 'Execution orchestrator', 'Worker agent', 'QC reviewer'];
/** How many files an ignored directory is counted up to: enough to say what it holds, without walking a dependency tree to the end. */
const COUNT_LIMIT = 50_000;

function itemId(path: string, kind: string): string {
  return stableId('scope', kind, pathKey(path));
}

/** A session identity is structured data, not a relative pseudo-path resolved under the service's launch directory. */
function sessionItemId(host: SessionHost, cwd: string): string {
  return stableId('scope', 'sessions', host, pathKey(cwd));
}

/** First heading and first paragraph of a directory's explanatory file: the reason a folder exists. */
export function readReason(dir: string): ReasonRef | null {
  for (const name of REASON_FILES) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const headingPath: string[] = [];
    let start = -1;
    let end = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (/^#{1,6}\s/.test(line)) {
        if (headingPath.length === 0) headingPath.push(line.replace(/^#+\s*/, '').trim());
        continue;
      }
      if (line.trim() === '') { if (start >= 0) { end = i - 1; break; } continue; }
      if (start < 0) start = i;
    }
    if (start < 0) continue;
    if (end < 0) end = Math.min(lines.length - 1, start + 6);
    const excerpt = lines.slice(start, end + 1).join('\n').slice(0, 600);
    return { path: file, headingPath, lineStart: start + 1, lineEnd: end + 1, excerpt };
  }
  return null;
}

function reasonText(ref: ReasonRef | null, fallback: string): string {
  if (!ref) return fallback;
  const first = ref.excerpt.split('\n').map((l) => l.replace(/^[-*>\s]+/, '').trim()).find((l) => l.length > 0) ?? '';
  return `${basename(dirname(ref.path))}/${basename(ref.path)}: ${first.slice(0, 200)}`;
}

const entriesOf = (dir: string): Dirent[] => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

/** Subdirectories, not following links (a link is listed by the candidates walk, never entered). */
function listDirs(dir: string): string[] {
  return entriesOf(dir).filter((e) => e.isDirectory()).map((e) => e.name);
}

/** Repositories below `root` (depth-limited). A parent's ignore rules cannot hide a child's own `.git`. */
function findNestedRepos(root: string, maxDepth = 4): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const name of listDirs(dir)) {
      if (name === '.git' || name === '.worktrees') continue;
      const full = join(dir, name);
      const dotGit = join(full, '.git');
      if (existsSync(dotGit)) {
        out.push(normalizePath(full));
        continue;   // a repository's inside is its own business
      }
      if (isSkippedName(name) && !isVendoredName(name)) continue;   // each library in a vendored directory is told apart
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** A tracked gitlink is a submodule, not a nested independent repository. */
function isGitlink(root: string, nested: string): boolean {
  const rel = relative(root, nested).split('\\').join('/');
  const listed = git(root, ['ls-files', '--stage', '--', rel]);
  return listed.ok && /^160000\s/m.test(listed.out);
}

/** A `.git` *file* points at a worktree of some repository; return that repository's common dir. */
function linkedWorktreeTarget(dir: string): string | null {
  const dotGit = join(dir, '.git');
  try {
    if (!statSync(dotGit).isFile()) return null;
    const text = readFileSync(dotGit, 'utf8');
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (!m?.[1]) return null;
    const target = normalizePath(join(dir, m[1].trim()));
    // <repo>/.git/worktrees/<name> → <repo>/.git
    const idx = target.toLowerCase().lastIndexOf(`${'\\'}.git${'\\'}worktrees${'\\'}`);
    const idx2 = target.toLowerCase().lastIndexOf('/.git/worktrees/');
    if (idx >= 0) return target.slice(0, idx + 5);
    if (idx2 >= 0) return target.slice(0, idx2 + 5);
    return null;
  } catch {
    return null;
  }
}

function sameDriveSibling(path: string): string | null {
  // D:\trials\ledger → D:\ledger
  const root = parse(path).root;
  const candidate = join(root, basename(path));
  return !samePath(candidate, path) && existsSync(candidate) ? normalizePath(candidate) : null;
}

/** Copy detection: a sibling copy-log naming the source, or another repository with the same root commit. */
function detectCopy(dir: string, isRepo: boolean): { source: string; sessionStoreRoot?: string; reason: ReasonRef | null; how: string } | null {
  const log = `${dir}.copy-log.txt`;
  if (existsSync(log)) {
    try {
      const text = readFileSync(log, 'utf8');
      const sourceLine = /^(?:来源|source|from)\s*[:：]\s*(.+?)\s*$/im.exec(text)?.[1];
      // Older logs also say "from D:\\..." without a delimiter; keep recognising those.
      const source = sourceLine && isAbsolute(sourceLine) ? sourceLine
        : /(?:来源|source|from)[:：]?\s*([A-Za-z]:\\[^\s\r\n]+|\/[^\s\r\n]+)/i.exec(text)?.[1];
      const sessionRoot = /^(?:sessions|会话)\s*[:：]\s*(.+?)\s*$/im.exec(text)?.[1];
      const sessionStoreRoot = sessionRoot && isAbsolute(sessionRoot) ? normalizePath(sessionRoot) : undefined;
      const lines = text.split(/\r?\n/);
      const ref: ReasonRef = { path: log, headingPath: [], lineStart: 1, lineEnd: Math.min(lines.length, 5), excerpt: lines.slice(0, 5).join('\n') };
      if (source && isAbsolute(source)) return { source: normalizePath(source), sessionStoreRoot, reason: ref, how: 'copy log names the source' };
      return { source: '', sessionStoreRoot, reason: ref, how: 'copy log present' };
    } catch { /* fall through */ }
  }
  const sibling = sameDriveSibling(dir);
  if (sibling && isRepo && existsSync(join(sibling, '.git'))) {
    const a = gitRootCommits(dir);
    const b = gitRootCommits(sibling);
    if (a.length > 0 && a.join(',') === b.join(',')) {
      return { source: sibling, reason: null, how: 'same root commit as the same-named repository' };
    }
  }
  return null;
}

function detectRoles(root: string): string[] {
  const found = new Set<string>();
  const scan = (dir: string, depth: number) => {
    if (depth > 2) return;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { if (!isSkippedName(name) && !ARCHIVE_NAMES.test(name)) scan(full, depth + 1); continue; }
      if (!name.endsWith('.md') || st.size > 400_000) continue;
      let text = '';
      try { text = readFileSync(full, 'utf8').slice(0, 20_000); } catch { continue; }
      for (const role of ROLE_NAMES) if (text.includes(role)) found.add(role);
    }
  };
  scan(root, 0);
  return [...found];
}

function detectLanguage(root: string): string {
  let cjk = 0;
  let total = 0;
  const scan = (dir: string, depth: number) => {
    if (depth > 2 || total > 200_000) return;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { if (!isSkippedName(name)) scan(full, depth + 1); continue; }
      if (!name.endsWith('.md')) continue;
      let text = '';
      try { text = readFileSync(full, 'utf8').slice(0, 20_000); } catch { continue; }
      total += text.length;
      cjk += (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
    }
  };
  scan(root, 0);
  return total > 0 && cjk / total > 0.08 ? 'zh' : 'en';
}

/**
 * Does the material itself show Cursor use? Either Cursor's own files, or the project's instruction,
 * status and handoff documents naming Cursor (as an agent, so the capitalised word only).
 */
function cursorEvidence(location: string): string | null {
  if (existsSync(join(location, '.cursor')) || existsSync(join(location, '.cursorrules'))) return '.cursor/ or .cursorrules is present';
  const candidates = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'HANDOFF.md', 'STATUS.md'].map((f) => join(location, f));
  const docs = join(location, 'docs');
  try {
    if (existsSync(docs)) for (const f of readdirSync(docs)) if (/\.md$/i.test(f)) candidates.push(join(docs, f));
  } catch { /* unreadable docs directory: nothing to add */ }
  for (const file of candidates) {
    try {
      if (!existsSync(file) || statSync(file).size > 1_000_000) continue;
      if (/\bCursor\b/.test(readFileSync(file, 'utf8'))) return `${relative(location, file)} mentions Cursor`;
    } catch { /* unreadable file: skip */ }
  }
  return null;
}

// ───────────────────────── what the ignore rules leave out (AC-17) ─────────────────────────

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Files and documents under a directory the ignore rules leave out (not following links). */
function countFiles(dir: string, root: string): { files: number; documents: number; names: string[]; capped: boolean } {
  let files = 0;
  let documents = 0;
  const names: string[] = [];
  const walk = (d: string) => {
    for (const e of entriesOf(d)) {
      if (files >= COUNT_LIMIT) return;
      if (e.name === '.git') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) continue;
      files += 1;
      if (isDocumentPath(e.name)) { documents += 1; if (names.length < 6) names.push(relative(root, full).split('\\').join('/')); }
    }
  };
  walk(dir);
  return { files, documents, names, capped: files >= COUNT_LIMIT };
}

const ruleWords = (rule: IgnoreRule | null) => (rule ? `${rule.file} line ${rule.line}: ${rule.pattern}` : 'git’s ignore rules');
const programClass = (kind: string, evidence: readonly string[]): ScopeClassification => ({ by: 'program', basis: 'Inferred', kind, evidence, sourceIds: [], ruleId: null, jobId: null, at: null });

// ───────────────────────── third-party material and generated output (AC-13) ─────────────────────────

function candidateSentence(relation: 'Generated' | 'Third-party material', kind: string, evidence: readonly string[], history = false): string {
  const then = relation === 'Generated' ? 'not organized'
    : NOT_READ_KINDS.has(kind) ? 'nothing in it is read'
      : `its documents are read as Reference only; its code${history ? ' and its history are' : ' is'} not organized`;
  return `${relation} (candidate, not yet judged by the Keeper; Inferred): ${evidence.join('; ')} · ${then}`;
}

/** The part of discovery that reads the project: disk and git, nothing decided yet. */
export function discoverBase(
  project: { readonly id: string; readonly name: string; readonly locations: readonly string[] },
  options: DiscoveryOptions = {},
): DiscoveryBase {
  const home = options.home ?? homedir();
  const items: DiscoveredItem[] = [];
  const questions: ScopeQuestion[] = [];
  const missing: { kind: string; reason: string }[] = [];
  const seen = new Set<string>();
  const sessionCwds = new Set<string>();
  const sessionHomes = new Map<string, string>();
  const push = (item: DiscoveredItem) => {
    // A session item is one per host and working directory. They all sit at the host's log root, so telling them apart
    // by path kept only the first directory's item, and every other directory's sessions were filed under it.
    const key = item.category === 'Session source' && item.sessionCwd
      ? `${item.category}:${item.sessionHost}:${pathKey(item.sessionCwd)}`
      : `${item.category}:${pathKey(item.path)}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  const existingQuestion = (id: string) => options.existingQuestions?.find((q) => q.id === id);
  const base = { reasonSourceIds: [] as string[], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, missing: null, addedBy: 'keeper' as const, reasonRef: null };
  const locations = project.locations.filter((l) => existsSync(l)).map(normalizePath);

  /** List what the ignore rules of the git work tree at `root` leave out; returns the predicate the other walks prune with. */
  const listIgnored = (root: string, keep: readonly string[]): ((rel: string) => boolean) | null => {
    const entries = ignoredEntries(root);
    if (!entries) return null;
    const relOf = (p: string) => relative(root, p).split('\\').join('/');
    const listDir = (full: string, rule: IgnoreRule | null) => {
      const count = countFiles(full, root);
      const cls = classifyName(basename(full));
      const docsNote = count.documents ? `, ${count.documents} of them ${count.documents === 1 ? 'a document' : 'documents'} (${count.names.join(', ')}${count.documents > count.names.length ? ', …' : ''})` : '';
      const ask = count.documents > 0 && !cls;
      push({
        ...base, id: itemId(full, 'dir'), path: full, category: 'Directory', relation: 'Excluded', versionControl: 'git',
        reason: `Ignored by the project's ignore rules: ${ruleWords(rule)} · ${count.capped ? `more than ${COUNT_LIMIT} files` : plural(count.files, 'file')}${docsNote}${cls ? ` · ${cls.evidence}` : ''} · not organized${ask ? '; the owner decides whether to include the documents' : ''}`,
        ignoredBy: { file: rule?.file ?? 'git', line: rule?.line ?? 0, pattern: rule?.pattern ?? '', files: count.files, documents: count.documents, documentNames: count.names },
        classification: cls ? programClass(cls.kind, [cls.evidence]) : null,
      });
      if (ask) raiseIgnoredQuestion(full, relOf(full), rule, count.documents, count.names);
    };
    const listFiles = (dirRel: string, rule: IgnoreRule | null, rels: readonly string[]) => {
      const seg = (rule?.pattern ?? '').replace(/\/+$/, '').split('/').pop() ?? '';
      const groups = /[*?[]/.test(seg) ? [rels] : rels.map((r) => [r]);
      for (const group of groups) {
        const path = group.length === 1 && !/[*?[]/.test(seg) ? join(root, group[0]!) : join(root, dirRel === '.' ? '' : dirRel, seg);
        const docs = group.filter((r) => isDocumentPath(r));
        push({
          ...base, id: itemId(path, 'dir'), path: normalizePath(path), category: 'Directory', relation: 'Excluded', versionControl: 'git',
          reason: `Ignored by the project's ignore rules: ${ruleWords(rule)} · ${plural(group.length, 'file')}${dirRel === '.' ? '' : ` in ${dirRel}/`}${docs.length ? `, ${docs.length} of them ${docs.length === 1 ? 'a document' : 'documents'} (${docs.slice(0, 6).join(', ')})` : ''} · not organized${docs.length ? '; the owner decides whether to include the documents' : ''}`,
          ignoredBy: { file: rule?.file ?? 'git', line: rule?.line ?? 0, pattern: rule?.pattern ?? '', files: group.length, documents: docs.length, documentNames: docs.slice(0, 6), paths: group },
        });
        if (docs.length) raiseIgnoredQuestion(normalizePath(path), relOf(path), rule, docs.length, docs.slice(0, 6));
      }
    };
    // An ignored directory that holds registered worktrees: the worktrees are measured on their own; the rest is listed.
    const drill = (dir: string, rule: IgnoreRule | null) => {
      for (const e of entriesOf(dir)) {
        const full = normalizePath(join(dir, e.name));
        if (keep.some((k) => samePath(k, full))) continue;
        if (keep.some((k) => isWithin(full, k))) { drill(full, rule); continue; }
        if (e.isDirectory()) listDir(full, rule);
        else if (e.isFile()) listFiles(relOf(dirname(full)) || '.', rule, [relOf(full)]);
      }
    };
    const scattered = new Map<string, { dir: string; rule: IgnoreRule | null; rels: string[] }>();
    for (const e of entries) {
      const full = normalizePath(join(root, e.rel));
      if (keep.some((k) => samePath(k, full))) continue;
      if (e.dir) {
        if (keep.some((k) => isWithin(full, k))) drill(full, e.rule);
        else listDir(full, e.rule);
        continue;
      }
      const dir = dirname(e.rel) === '.' ? '.' : dirname(e.rel).split('\\').join('/');
      const key = `${dir}|${e.rule?.file}|${e.rule?.line}|${e.rule?.pattern}`;
      const group = scattered.get(key) ?? { dir, rule: e.rule, rels: [] };
      group.rels.push(e.rel);
      scattered.set(key, group);
    }
    for (const g of scattered.values()) listFiles(g.dir, g.rule, g.rels);
    return predicateFrom(entries);
  };
  const raiseIgnoredQuestion = (path: string, rel: string, rule: IgnoreRule | null, documents: number, names: readonly string[]) => {
    const id = ignoredQuestionId(path);
    questions.push(existingQuestion(id) ?? {
      id,
      question: `${rel} is left out by the project's ignore rules (${ruleWords(rule)}) but holds ${plural(documents, 'document')}. Should they be organized as project material?`,
      whyItMatters: 'What the ignore rules leave out is not organized. If these documents carry the project’s intent — notes, plans, decisions — leaving them out loses it.',
      clues: [ruleWords(rule), ...names],
      options: ['Include them', 'Leave them out'],
      answer: null,
    });
  };
  const listCandidates = (root: string, ignored: ((rel: string) => boolean) | null, separate: readonly string[], isGit: boolean) => {
    for (const c of findCandidates(root, { locations, ignored, separate, git: isGit })) pushCandidate(c, isGit);
  };
  const pushCandidate = (c: Candidate, isGit: boolean) => push({
    ...base, id: itemId(c.path, 'dir'), path: c.path, category: 'Directory', relation: c.relation, versionControl: isGit ? 'git' : 'none',
    reason: candidateSentence(c.relation, c.kind, c.evidence), classification: programClass(c.kind, c.evidence),
  });

  for (const rawLocation of project.locations) {
    const location = normalizePath(rawLocation);
    if (!existsSync(location)) {
      push({
        id: itemId(location, 'dir'), path: location, category: 'Directory', relation: 'Main project',
        reason: 'Owner-given location; it does not exist or cannot be read', reasonSourceIds: [], sessionHost: null,
        readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'unknown',
        missing: { reason: 'Path does not exist or is not readable' }, addedBy: 'owner', reasonRef: null,
      });
      continue;
    }
    sessionCwds.add(location);
    const toplevel = gitToplevel(location);
    const isRepo = toplevel !== null && samePath(toplevel, location);
    const insideRepo = toplevel !== null && !isRepo && isWithin(toplevel, location);
    // An answered copy question is the owner's word on the copy's source and outlives rescans.
    const answered = options.existingQuestions?.find((q) => q.id === stableId('scopeq', 'copy-source', pathKey(location)) && q.answer)?.answer?.text.trim() ?? null;
    const detected = detectCopy(location, isRepo);
    const namedSource = answered && /^[A-Za-z]:\\|^\//.test(answered) ? normalizePath(answered) : null;
    const copy = answered && /not a copy/i.test(answered) ? null
      : namedSource ? { source: namedSource, sessionStoreRoot: detected?.sessionStoreRoot, reason: detected?.reason ?? null, how: detected ? `${detected.how}; the owner named the source` : 'the owner named the source' }
        : detected;

    push({
      id: itemId(location, isRepo ? 'repo' : 'dir'), path: location,
      category: isRepo ? 'Repository' : 'Directory',
      relation: copy ? 'Copy of another project' : 'Main project',
      reason: copy
        ? `Copy of ${copy.source || 'another project'} (${copy.how}); the original stays read-only and is not merged in`
        : isRepo ? 'Owner-given location; git repository'
          : insideRepo ? `Owner-given location; a subdirectory of the repository at ${toplevel}`
            : 'Owner-given location; no version control (the project is read as its files and running processes)',
      reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: copy?.source || null, worktreeOf: null,
      versionControl: isRepo || insideRepo ? 'git' : 'none', missing: null, addedBy: 'owner',
      reasonRef: copy?.reason ?? null,
    });
    if (copy?.source) {
      sessionCwds.add(copy.source);
      if (copy.sessionStoreRoot) sessionHomes.set(pathKey(copy.source), copy.sessionStoreRoot);
    }

    // Registered worktrees of the main repository, wherever they live, each measured against the trunk (E60).
    const worktreePaths: string[] = [];
    if (isRepo) {
      const trunk = trunkOf(location);
      for (const wt of gitWorktrees(location)) {
        if (samePath(wt.path, location)) continue;
        worktreePaths.push(wt.path);
        const inside = isWithin(location, wt.path);
        const present = existsSync(wt.path);
        const measured = present ? measureWorktree(wt.path, location, trunk, { head: wt.head, branch: wt.branch }) : null;
        push({
          id: itemId(wt.path, 'worktree'), path: wt.path, category: 'Worktree', relation: 'Worktree of main repo',
          reason: `Registered worktree of ${location}${inside ? '' : ' (outside the project directory)'}${wt.branch ? `, branch ${wt.branch}` : wt.detached ? ', detached' : ''}${present ? '' : '; path missing on disk'}${measured ? ` · ${worktreeSentence(measured)}` : ''}`,
          reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: location,
          versionControl: 'git', missing: present ? null : { reason: 'Registered but not present on disk' },
          addedBy: 'keeper', reasonRef: null, worktree: measured,
        });
        if (present) sessionCwds.add(wt.path);
      }
    }

    // Find independent repositories before applying the parent's ignore rules. Their own rules govern their files.
    // One that lies inside a directory the parent ignores is not the project's — a test's temporary copies, a runtime
    // folder, build output — and stays out with that directory. One whose own root is what the parent ignores, the usual
    // way to keep a separate repository out of the parent's history (ContextKeeper's own `app/`), comes in. The same
    // rule holds for any project (D98): the live ContextKeeper keeps demo repositories under ignored temp/ folders.
    const parentIgnored = isRepo || insideRepo ? ignoredEntries(location) : null;
    const inIgnoredDir = parentIgnored ? predicateFrom(parentIgnored) : null;
    const nestedPaths = findNestedRepos(location).filter((nested) => !isGitlink(location, nested)).filter((nested) => {
      if (!inIgnoredDir) return true;
      const parentRel = relative(location, dirname(nested)).split('\\').join('/');
      return parentRel === '' || !inIgnoredDir(parentRel);
    });
    // What the project's own ignore rules leave out (none without version control).
    const ignored = isRepo || insideRepo ? listIgnored(location, [...worktreePaths, ...nestedPaths]) : null;

    // Nested independent repositories keep their own history; linked worktrees of other repos are experiments.
    const mainCommon = isRepo ? gitCommonDir(location) : null;
    const separate: string[] = [...worktreePaths];
    for (const nested of nestedPaths) {
      separate.push(nested);
      const target = linkedWorktreeTarget(nested);
      if (target) {
        const ofMain = mainCommon !== null && samePath(target, mainCommon);
        if (ofMain) continue; // already listed from `git worktree list`
        push({
          id: itemId(nested, 'worktree'), path: nested, category: 'Worktree', relation: 'Experiment',
          reason: `Linked worktree whose .git points at ${target}; it belongs to that repository, not to the main history`,
          reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: target,
          versionControl: 'git', missing: null, addedBy: 'keeper', reasonRef: null,
        });
        continue;
      }
      const nestedCommon = gitCommonDir(nested);
      const nestedDir = gitDir(nested);
      const isLinked = nestedCommon !== null && nestedDir !== null && !samePath(nestedCommon, nestedDir);
      if (isLinked && mainCommon && nestedCommon && samePath(nestedCommon, mainCommon)) continue;
      const remotes = gitRemotes(nested);
      const upstream = remotes.map((l) => l.split(/\s+/)[1]).find(Boolean) ?? null;
      const license = licenseIn(nested);
      if (upstream && license) {
        // Its own repository with an upstream and a license of its own: somebody else's code, distributed with the project.
        const evidence = [`its own git repository with upstream ${upstream}`, `license file ${license}`];
        push({
          id: itemId(nested, 'repo'), path: nested, category: 'Repository', relation: 'Third-party material',
          reason: candidateSentence('Third-party material', 'upstream repository', evidence, true),
          reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null,
          versionControl: 'git', missing: null, addedBy: 'keeper', reasonRef: null, classification: programClass('upstream repository', evidence),
        });
        continue;
      }
      push({
        id: itemId(nested, 'repo'), path: nested, category: 'Repository', relation: 'Nested repository',
        reason: `Has its own .git, so it belongs to its own repository and uses its own ignore rules rather than the parent's${remotes.length === 0 ? ' (no remote)' : ''}`,
        reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null,
        versionControl: 'git', missing: null, addedBy: 'keeper', reasonRef: null,
      });
      sessionCwds.add(nested);
      // A nested repository's registered worktrees belong to it, wherever they live (§1.1), measured against its trunk.
      const nestedTrunk = trunkOf(nested);
      const nestedWorktrees: string[] = [];
      for (const wt of gitWorktrees(nested)) {
        if (samePath(wt.path, nested)) continue;
        nestedWorktrees.push(wt.path);
        separate.push(wt.path);
        const measured = existsSync(wt.path) ? measureWorktree(wt.path, nested, nestedTrunk, { head: wt.head, branch: wt.branch }) : null;
        push({
          id: itemId(wt.path, 'worktree'), path: wt.path, category: 'Worktree', relation: 'Worktree of main repo',
          reason: `Registered worktree of the nested repository ${nested}${isWithin(location, wt.path) ? '' : ' (outside the project directory)'}${wt.branch ? `, branch ${wt.branch}` : wt.detached ? ', detached' : ''}${measured ? ` · ${worktreeSentence(measured)}` : ''}`,
          reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: nested,
          versionControl: 'git', missing: existsSync(wt.path) ? null : { reason: 'Registered but not present on disk' }, addedBy: 'keeper', reasonRef: null, worktree: measured,
        });
        sessionCwds.add(wt.path);
      }
      const nestedIgnored = listIgnored(nested, nestedWorktrees);
      listCandidates(nested, nestedIgnored, nestedWorktrees, true);
    }

    // Third-party material and generated output nobody ignored: offered for the Keeper to judge.
    listCandidates(location, ignored, separate, isRepo || insideRepo);

    // Archived or moved-out material: listed with the reason its own file gives. Looked for at
    // the top level and one level down (e.g. `design/archive/`).
    const relOf = (p: string) => relative(location, p).split('\\').join('/');
    const candidates: { name: string; full: string }[] = [];
    for (const name of listDirs(location)) {
      const full = normalizePath(join(location, name));
      if (isSkippedName(name) || ignored?.(relOf(full))) continue;
      candidates.push({ name, full });
      if (!ARCHIVE_NAMES.test(name) && !existsSync(join(full, '.git'))) {
        for (const sub of listDirs(full)) {
          const subFull = normalizePath(join(full, sub));
          if (!isSkippedName(sub) && !ignored?.(relOf(subFull))) candidates.push({ name: sub, full: subFull });
        }
      }
    }
    for (const { name, full } of candidates) {
      if (!ARCHIVE_NAMES.test(name)) continue;
      const ref = readReason(full);
      const movedOut = /^(delete|deleted|trash)/i.test(name);
      push({
        id: itemId(full, 'dir'), path: full, category: 'Directory', relation: movedOut ? 'Excluded' : 'Main project',
        reason: reasonText(ref, movedOut
          ? `${name}/ holds material the owner moved out of the active project`
          : `${name}/ holds archived history of this project`),
        reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null,
        versionControl: 'unknown', missing: null, addedBy: 'keeper', reasonRef: ref,
      });
      // Archives often contain one more level of dated folders with their own README.
      for (const sub of listDirs(full)) {
        const subFull = normalizePath(join(full, sub));
        const subRef = readReason(subFull);
        if (!subRef) continue;
        push({
          id: itemId(subFull, 'dir'), path: subFull, category: 'Directory', relation: movedOut ? 'Excluded' : 'Main project',
          reason: reasonText(subRef, `${name}/${sub}/`), reasonSourceIds: [], sessionHost: null, readOnly: false,
          copyOf: null, worktreeOf: null, versionControl: 'unknown', missing: null, addedBy: 'keeper', reasonRef: subRef,
        });
      }
    }
  }

  // Session sources: Claude Code and Codex logs for every working directory in scope (PA-2).
  const cwds = [...sessionCwds];
  const located = locateSessionsForHomes(cwds, (_host, cwd) => sessionHomes.get(pathKey(cwd)) ?? home);
  const byCwd = new Map<string, { claude: LocatedSession[]; codex: LocatedSession[] }>();
  for (const cwd of cwds) byCwd.set(pathKey(cwd), { claude: [], codex: [] });
  for (const s of located) if (s.host !== 'pi') byCwd.get(pathKey(s.cwd ?? ''))?.[s.host].push(s);
  for (const cwd of cwds) {
    const found = byCwd.get(pathKey(cwd))!;
    const isOriginalOfCopy = items.some((i) => i.copyOf && samePath(i.copyOf, cwd));
    const sessionStoreRoot = sessionHomes.get(pathKey(cwd));
    const sourceHome = sessionStoreRoot ?? home;
    const pairs: [SessionHost, LocatedSession[], string][] = [
      ['claude', found.claude, join(sourceHome, '.claude', 'projects')],
      ['codex', found.codex, [...new Set(found.codex.map((s) => s.home))].join('; ') || join(sourceHome, '.codex', 'sessions')],
    ];
    for (const [host, sessions, where] of pairs) {
      if (sessions.length === 0 && !isOriginalOfCopy) continue;
      push({
        id: sessionItemId(host, cwd), path: where, category: 'Session source', relation: 'Session source',
        reason: `${host === 'claude' ? 'Claude Code' : 'Codex'} sessions whose working directory is ${cwd}${isOriginalOfCopy ? ' (the original of a copy; read-only)' : ''}: ${sessions.length} found${sessions.some((s) => s.isSubagent) ? `, ${sessions.filter((s) => s.isSubagent).length} sub-agent` : ''}; read from ${sessionStoreRoot ? `frozen session storage ${sessionStoreRoot}` : `host session storage ${home}`}`,
        reasonSourceIds: [], sessionHost: host, readOnly: true, copyOf: null, worktreeOf: null,
        versionControl: 'unknown', missing: sessions.length === 0 ? { reason: 'No sessions found for this directory' } : null,
        addedBy: 'keeper', reasonRef: null, sessions, sessionCwd: cwd,
        ...(sessionStoreRoot ? { sessionStoreRoot } : {}),
      });
    }
  }

  // Missing source kinds: only what the material itself points at.
  for (const location of project.locations.filter((l) => existsSync(l))) {
    const evidence = cursorEvidence(location);
    if (evidence && !missing.some((m) => m.kind === 'Cursor sessions')) {
      missing.push({ kind: 'Cursor sessions', reason: `The project shows Cursor use (${evidence}), but ProjectKeeper does not read Cursor session logs yet` });
    }
  }

  // Ambiguities that change the result (§3.9): a copy whose source could not be named.
  for (const item of items) {
    if (item.relation === 'Copy of another project' && !item.copyOf) {
      const id = stableId('scopeq', 'copy-source', pathKey(item.path));
      const previous = options.existingQuestions?.find((q) => q.id === id);
      questions.push(previous ?? {
        id, question: `${item.path} looks like a copy. Which project is it a copy of?`,
        whyItMatters: 'The sessions and the original repository of a copy live under the original path; without it those sources are missed.',
        clues: ['A copy log exists next to the directory, but it does not name the source.'],
        options: ['Give the original path', 'It is not a copy'], answer: null,
      });
    }
  }

  const roots = project.locations.filter((l) => existsSync(l));
  const roles = roots.flatMap((r) => detectRoles(r));
  const language = roots.length > 0 ? detectLanguage(roots[0]!) : 'en';
  // B2: toolchain the project's own config points at (Spec §6.7); an allowed read root for the Keeper (§3.1). Read here
  // with the rest of the on-disk discovery; a location too broad to open is flagged (not used) inside discoverToolchain.
  const toolchain = discoverToolchain(locations, { home, projectKeeperHome: options.projectKeeperHome });
  return { items, questions, missingSourceKinds: missing, roles: [...new Set(roles)], language, locations, toolchain };
}

/**
 * What the disk and git say, before anything is decided about it: the part of discovery that reads the project. A
 * change in what the Keeper, the project's rules or the owner decided is applied to it again (`decideScope`) without
 * reading the project again.
 */
export interface DiscoveryBase extends DiscoveryResult {
  readonly locations: readonly string[];
}

/** Scope discovery: read the project, then apply what was decided about it. */
export function discoverScope(
  project: { readonly id: string; readonly name: string; readonly locations: readonly string[] },
  options: DiscoveryOptions = {},
): DiscoveryResult {
  return decideScope(discoverBase(project, options), options);
}

/** What the Keeper, the project's rules and the owner decided about the locations (§1.1, §1.15, §3.9), applied to a base. */
export function decideScope(base: DiscoveryBase, options: DiscoveryOptions = {}): DiscoveryResult {
  const { locations } = base;
  // Answers the owner gave since the base was read.
  const questions: ScopeQuestion[] = base.questions.map((q) => options.existingQuestions?.find((x) => x.id === q.id && x.answer) ?? q);
  const owning = (path: string) => base.items.filter((i) => i.category !== 'Session source' && isWithin(i.path, path)).sort((a, b) => b.path.length - a.path.length)[0];
  const decided = applyDecisions<DiscoveredItem>(base.items, {
    locations, rules: options.rules ?? [], judgements: options.judgements ?? [], questions: options.existingQuestions ?? [],
    sourceLabel: options.sourceLabel ?? (() => null),
    resolveDir: (words) => {
      if (!words || /[*?]/.test(words)) return null;
      for (const location of locations) {
        const full = normalizePath(isAbsolute(words) ? words : join(location, words.replace(/[\\/]+$/, '')));
        if (!locations.some((l) => isWithin(l, full))) continue;
        try { if (statSync(full).isDirectory()) return full; } catch { /* not a directory here */ }
      }
      return null;
    },
    newItem: (path: string, relation: ScopeRelation): DiscoveredItem => {
      const repo = existsSync(join(path, '.git'));
      return {
        id: itemId(path, repo ? 'repo' : 'dir'), path: normalizePath(path), category: repo ? 'Repository' : 'Directory', relation, reason: '',
        reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, addedBy: 'keeper', reasonRef: null,
        versionControl: repo ? 'git' : owning(path)?.versionControl ?? 'unknown', missing: existsSync(path) ? null : { reason: 'Path does not exist or is not readable' },
      };
    },
  });
  questions.push(...decided.questions.filter((q) => !questions.some((x) => x.id === q.id)));

  // Owner-edited items win over discovery.
  const ownerItems = options.ownerItems ?? [];
  const merged: DiscoveredItem[] = [];
  const matchedOwners = new Set<ScopeItem>();
  for (const item of decided.items) {
    // Pre-D5 session ids accidentally included the service cwd. Match those persisted owner edits by the intended
    // identity (host + complete cwd), then write the canonical id so later launches do not need another migration.
    const owner = ownerItems.find((o) => o.id === item.id) ?? (item.category === 'Session source' ? ownerItems.find((o) => sameSessionItem(o, item)) : undefined);
    if (owner) matchedOwners.add(owner);
    // Which directory a session item reads is a fact discovery finds, like its sessions, not a decision: an item the
    // owner edited before items recorded it gets it back.
    merged.push(owner ? { ...owner, id: item.id, reasonRef: item.reasonRef, sessions: item.sessions, ...(item.sessionCwd ? { sessionCwd: item.sessionCwd } : {}), sessionStoreRoot: item.sessionStoreRoot } : item);
  }
  for (const owner of ownerItems) {
    if (owner.addedBy === 'owner' && !matchedOwners.has(owner) && !merged.some((m) => m.id === owner.id)) merged.push({ ...owner, reasonRef: null });
  }
  // Answered questions stay on record even when the ambiguity no longer arises, so the answer keeps applying.
  for (const q of options.existingQuestions ?? []) if (q.answer && !questions.some((x) => x.id === q.id)) questions.push(q);
  // B2: the toolchain was read with the base (discoverBase) and carried through unchanged.
  return { items: merged, questions, missingSourceKinds: base.missingSourceKinds, roles: base.roles, language: base.language, toolchain: base.toolchain };
}
