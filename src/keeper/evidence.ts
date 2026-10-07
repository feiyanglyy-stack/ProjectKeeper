/**
 * Evidence the Keeper cites, resolved by the program (Spec v3.0 §1.16, §1.18, §2.11; D77, D83). The model never writes
 * a date, a count, a label of evidence or a quoted line the program cannot check: it names what it points at — a ledger
 * entry, a source, a commit, a file or an object of the assets, and at most one line of it — and the program checks
 * that it is there, reads its label, finds the line as the original has it and reads when it happened.
 *
 * When it happened (`Occurred`, §2.11) comes from the material, never from the model:
 * - a commit: its author time (`Commit`);
 * - a session message: the message's time (`Session`); a session source cited without a line, its first message's;
 * - a document: the commit of the version cited — the commit a cited line first appeared in, or the last commit that
 *   touched the file up to the version read (`Commit`); a file with no commit behind it, its file time (`File time`,
 *   a weak basis: copying and moving change it);
 * - what gives no time at all is `Undated · first seen <when the program first saw it>` (`First observed`, `undated`).
 * Precision is the source's: a date stays a date; a clock time is stored as its instant in UTC (model/time.ts). A date
 * written in the text that disagrees with the commit (`other`) is left to the ledger, which reads the text.
 *
 * Everything here only reads: the assets, the files of the project's scope, and git with read-only commands.
 */
import { existsSync, readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { EvidenceRef, Occurred, OccurredBasis } from '../model/k-types.ts';
import type { Project, Source } from '../model/types.ts';
import { normalizeMaterialTime } from '../model/time.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { anchorLabel } from '../sources/anchor.ts';
import { MAX_REVISION_BYTES } from '../sources/history.ts';
import { parseClaudeSession, parseCodexSession, type ParsedSession } from '../sources/sessions/read.ts';
import { gitCommitMeta, gitRead, gitResolveCommit, gitTreeEntry } from '../util/git.ts';
import { isWithin, nameForm, normalizePath, pathKey, samePath } from '../util/paths.ts';
import { resolveMergedId } from './merge.ts';
import { checkVerbatim, findWords } from './verbatim.ts';

export const EVIDENCE_KINDS = ['ledger', 'source', 'commit', 'file', 'object'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** What a tool call names as evidence. Everything else about it is read by the program. */
export interface EvidenceInput {
  readonly kind: EvidenceKind;
  /** Ledger entry id, source id, commit hash (full or short), repository-relative path, or object id. */
  readonly id: string;
  /** One line of it, as the original has it (checked; stored as the original has it). */
  readonly line?: string;
  /** For a file or a commit: which repository of the scope (its scope item id or path); default the main one. */
  readonly repo?: string;
}

/** One entry of the ledger (§1.16), as the ledger answers for it. */
export interface LedgerEntry { readonly label: string; readonly occurred: Occurred; readonly text?: string }
/** The ledger is built in its own package; the tools reach it through this hook when a build has one. */
export interface LedgerHook { resolve(id: string): LedgerEntry | null }

export interface EvidenceContext {
  readonly store: ProjectStore;
  readonly project: Project;
  readonly ledger?: LedgerHook | null;
}

/** What a caller may not hand in as evidence: the program reads these from what the evidence names. */
const PROGRAM_READS = ['label', 'occurred', 'at', 'date', 'time', 'when'] as const;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const now = () => new Date().toISOString();
function snippet(s: string, max = 120): string {
  const cps = [...s.replace(/\s+/g, ' ').trim()];
  return cps.length <= max ? cps.join('') : `${cps.slice(0, max).join('')}…`;
}
const HOW_A_LINE_IS_READ = 'A cited line is checked against the original: case, spacing, punctuation, quotation marks and Markdown marks make no difference, but every word has to be there, in that order. Copy the line from the original instead of rewording it.';

// ───────────────────────── when it happened ─────────────────────────

function dated(at: string, basis: OccurredBasis, anchor: string | null): Occurred | null {
  const time = normalizeMaterialTime(at);
  return time ? { at: time, basis, anchor } : null;
}
function undatedAt(firstSeen: string | null | undefined, anchor: string | null): Occurred {
  const seen = firstSeen && !Number.isNaN(Date.parse(firstSeen)) ? (normalizeMaterialTime(firstSeen) ?? firstSeen) : now();
  return { at: seen, basis: 'First observed', anchor, undated: true };
}

function instant(o: Occurred): number | null {
  const ms = Date.parse(o.at);
  return Number.isNaN(ms) ? null : ms;
}
/** Oldest first, by the instant each time names; on a tie a dated time goes before an undated one. */
export function compareOccurred(a: Occurred, b: Occurred): number {
  const x = instant(a);
  const y = instant(b);
  const byTime = x !== null && y !== null ? x - y : a.at.localeCompare(b.at);
  return byTime !== 0 ? byTime : Number(a.undated === true) - Number(b.undated === true);
}
/**
 * The earliest of these times. An undated time is when the program first saw something, not when it happened, so it is
 * the answer only when nothing is dated.
 */
export function earliestOccurred(list: readonly (Occurred | null | undefined)[]): Occurred | null {
  const all = list.filter((o): o is Occurred => o !== null && o !== undefined);
  const pool = all.some((o) => o.undated !== true) ? all.filter((o) => o.undated !== true) : all;
  return [...pool].sort(compareOccurred)[0] ?? null;
}

// ───────────────────────── the project's locations ─────────────────────────

export interface ProjectRoot {
  /** The scope item's id (or `location-<n>` for a location given with no scope yet). */
  readonly id: string;
  readonly path: string;
  readonly git: boolean;
  readonly main: boolean;
}

/** The repositories and directories of the scope a path can be in, the main repository first. */
export function projectRoots(project: Project): ProjectRoot[] {
  const roots: ProjectRoot[] = project.scope
    .filter((i) => i.category !== 'Session source' && i.relation !== 'Excluded' && i.relation !== 'Session source' && !i.missing)
    .map((i) => ({
      id: i.id, path: i.path, main: i.relation === 'Main project',
      git: i.versionControl === 'git' || ((i.category === 'Repository' || i.category === 'Worktree') && i.versionControl !== 'none'),
    }));
  if (roots.length === 0) {
    for (const [n, loc] of project.locations.entries()) roots.push({ id: `location-${n}`, path: loc, git: existsSync(join(loc, '.git')), main: n === 0 });
  }
  const rank = (r: ProjectRoot) => (r.main && r.git ? 0 : r.git ? 1 : r.main ? 2 : 3);
  return roots.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

/**
 * The repository a piece of evidence is in when it is not the project's first one (`EvidenceRef.repo`): its path. What
 * is in the first repository names none — a path or a commit is the project's main repository's unless it says otherwise.
 */
export function otherRepository(project: Project, rootPath: string): string | null {
  const first = projectRoots(project)[0];
  return first && samePath(first.path, rootPath) ? null : rootPath;
}

export interface ProjectPath { readonly root: ProjectRoot; readonly rel: string }

/**
 * Which location and path a call means: `repo` names a scope item by id or path; an absolute path picks the location
 * that holds it; otherwise the main repository. The path is relative to that location, with forward slashes; a path
 * that leaves it is refused.
 */
export function resolvePath(project: Project, input: { readonly path: string; readonly repo?: string | null }): ProjectPath | string {
  const roots = projectRoots(project);
  if (roots.length === 0) return 'This project has no location in its scope, so no path can be found in it.';
  const raw = (input.path ?? '').trim();
  const repoArg = (input.repo ?? '').trim();
  let root: ProjectRoot | undefined;
  if (repoArg) {
    root = roots.find((r) => r.id === repoArg) ?? roots.find((r) => samePath(r.path, repoArg));
    if (!root) return `${repoArg} is not a repository or directory of this project’s scope. Use one of: ${roots.map((r) => `${r.id} (${r.path})`).join(', ')}.`;
  } else if (raw && isAbsolute(raw)) {
    root = roots.filter((r) => isWithin(r.path, raw)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!root) return `${raw} is not inside this project’s scope. Give the path relative to the repository root.`;
  } else {
    root = roots[0]!;
  }
  let rel = raw;
  if (raw && isAbsolute(raw)) {
    if (!isWithin(root.path, raw)) return `${raw} is not inside ${root.path}. Give the path relative to the repository root.`;
    rel = relative(normalizePath(root.path), normalizePath(raw));
  }
  // In the form names are kept in: a path copied from a directory listing on a Mac is in another one than git's.
  rel = nameForm(rel).split('\\').join('/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (rel === '.') rel = '';
  if (rel.split('/').some((seg) => seg === '..') || /^[A-Za-z]:/.test(rel) || rel.startsWith('/')) return `${raw} leaves ${root.path}; give a path inside it.`;
  return { root, rel };
}

// ───────────────────────── read-only git, as evidence needs it ─────────────────────────

export interface CommitFacts { readonly hash: string; readonly at: string; readonly subject: string; readonly parents: readonly string[] }
const FORMAT = '--format=%x1e%H%x1f%aI%x1f%P%x1f%s';
function commitsOf(out: string): CommitFacts[] {
  return out.split('\x1e').map((b) => b.trim()).filter(Boolean).map((b) => {
    const [hash, at, parents, subject] = b.split(/\r?\n/)[0]!.split('\x1f');
    return { hash: hash ?? '', at: at ?? '', parents: (parents ?? '').split(' ').filter(Boolean), subject: subject ?? '' };
  }).filter((c) => /^[0-9a-f]{40}$/.test(c.hash));
}

const factsCache = new Map<string, CommitFacts | null>();
/** Author time, subject and parents of one commit (a full hash: what it says never changes). */
export function commitFacts(root: string, hash: string): CommitFacts | null {
  const key = `${pathKey(root)}|${hash}`;
  if (!factsCache.has(key)) {
    const meta = gitCommitMeta(root, hash);
    factsCache.set(key, meta ? { hash: meta.hash, at: meta.at, subject: meta.subject, parents: meta.parents } : null);
  }
  return factsCache.get(key) ?? null;
}
function commitMessage(root: string, hash: string): string | null {
  const r = gitRead(root, ['log', '-1', '--format=%B', hash, '--'], { timeoutMs: 8000 });
  return r.ok ? r.out : null;
}
/** History read up to a full hash never changes, so it is read once per process; HEAD and `--all` are read each time. */
const historyCache = new Map<string, CommitFacts | null>();
function cachedLog(root: string, upTo: string, key: readonly string[], read: () => CommitFacts | null): CommitFacts | null {
  if (!/^[0-9a-f]{40}$/.test(upTo)) return read();
  const k = [pathKey(root), upTo, ...key].join('\x1f');
  if (!historyCache.has(k)) historyCache.set(k, read());
  return historyCache.get(k) ?? null;
}
/** The newest commit reachable from `from` (a ref, or `--all`) that touched the path. */
function lastTouching(root: string, rel: string, from: string): CommitFacts | null {
  return cachedLog(root, from, ['last', rel], () => {
    const r = gitRead(root, ['log', '-1', FORMAT, from, '--', rel], { timeoutMs: 20_000 });
    return r.ok ? commitsOf(r.out)[0] ?? null : null;
  });
}
/** The commit these exact words first appeared in, in the history of the path up to `upTo` (following renames). */
function firstWithText(root: string, rel: string, text: string, upTo: string): CommitFacts | null {
  if (!text.trim()) return null;
  return cachedLog(root, upTo, ['first', rel, text], () => {
    const r = gitRead(root, ['log', '--follow', FORMAT, `-S${text}`, upTo, '--', rel], { timeoutMs: 30_000 });
    if (!r.ok) return null;
    const all = commitsOf(r.out);
    return all[all.length - 1] ?? null;
  });
}
const inTree = (root: string, commit: string, rel: string): boolean => gitTreeEntry(root, commit, rel) !== null;

/**
 * A path that is not in the working tree, as history last had it: the commit whose tree holds its last version (for a
 * deleted file, the parent of the commit that deleted it) and when that version was made. HEAD's history first, then
 * every branch.
 */
function lastVersionInHistory(root: string, rel: string): { treeish: string; made: CommitFacts } | null {
  for (const from of ['HEAD', '--all']) {
    const newest = lastTouching(root, rel, from);
    if (!newest) continue;
    if (inTree(root, newest.hash, rel)) return { treeish: newest.hash, made: newest };
    for (const parent of newest.parents) {
      if (!inTree(root, parent, rel)) continue;
      return { treeish: parent, made: lastTouching(root, rel, parent) ?? commitFacts(root, parent) ?? newest };
    }
  }
  return null;
}

/** Whether a path of a location exists in its working tree now, or only in its history. */
export function pathPresence(root: ProjectRoot, rel: string): 'now' | 'history' | null {
  if (existsSync(join(root.path, ...rel.split('/')))) return 'now';
  return root.git && rel && lastTouching(root.path, rel, '--all') ? 'history' : null;
}

/** The git roots of the scope a commit can be in: the one named, or all of them, the main repository first. */
function gitRoots(project: Project, repo: string): ProjectRoot[] | string {
  const all = projectRoots(project).filter((r) => r.git);
  if (!repo) return all;
  const named = all.find((r) => r.id === repo) ?? all.find((r) => samePath(r.path, repo));
  return named ? [named] : `${repo} is not a git repository of this project’s scope. Use one of: ${all.map((r) => `${r.id} (${r.path})`).join(', ') || 'none — the scope has no git repository'}.`;
}

// ───────────────────────── sessions ─────────────────────────

const sessionCache = new Map<string, { size: number; mtimeMs: number; parsed: ParsedSession }>();
/** A Claude Code or Codex log, parsed once per version of the file; null when it cannot be read. */
export function parsedSession(host: string, file: string): ParsedSession | null {
  if ((host !== 'claude' && host !== 'codex') || !file) return null;
  let st;
  try { st = statSync(file); } catch { return null; }
  const key = `${host}:${pathKey(file)}`;
  const hit = sessionCache.get(key);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.parsed;
  try {
    const parsed = host === 'codex' ? parseCodexSession(file) : parseClaudeSession(file);
    sessionCache.set(key, { size: st.size, mtimeMs: st.mtimeMs, parsed });
    return parsed;
  } catch {
    return null;
  }
}

/** A header of the transcript a session source holds (sources/sessions/read.ts `renderMessage`). */
const HEADER = /^\[(\d+)\] (?:OWNER|AGENT|SUBAGENT TASK|SUBAGENT|HOST)\b[^\n]*$/gm;
/** The message of a session transcript that holds the text at `offset`: its position, and the minute its header shows. */
function messageAtOffset(transcript: string, offset: number): { index: number; minute: string | null } | null {
  let found: RegExpMatchArray | null = null;
  for (const m of transcript.matchAll(HEADER)) {
    if (m.index! > offset) break;
    found = m;
  }
  if (!found) return null;
  const clock = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\s*$/.exec(found[0]);
  return { index: Number(found[1]), minute: clock ? `${clock[1]}T${clock[2]}Z` : null };
}

// ───────────────────────── when a source happened ─────────────────────────

/** A cited line, where the source's excerpt has it. */
interface CitedLine { readonly text: string; readonly start: number }

/** Marks that open what follows (brackets, opening quotes, emphasis), and marks that close what went before. */
const OPENS = /[\p{Ps}\p{Pi}*_`~"'“‘「『《〈]/u;
const CLOSES = /[\p{Pe}\p{Pf}*_`~"'”’」』》〉.。!！?？…]/u;
/**
 * The words the caller cited, as the original has them, with the marks that enclose or end them (the full stop after
 * a sentence, the `**` around a number, the brackets around a clause) — never a word more, and never the mark that opens
 * the next clause: text with no spaces between words (Chinese) would otherwise run on.
 */
function asCited(raw: string, words: string): CitedLine | null {
  const found = findWords(words, raw);
  if (!found) return null;
  const t = raw.normalize('NFC');
  let start = found.start;
  let end = found.start + found.text.length;
  while (start > 0 && OPENS.test(t[start - 1]!)) start--;
  while (end < t.length && CLOSES.test(t[end]!)) end++;
  return { text: t.slice(start, end), start };
}

/** The single line of a cited stretch that git can search the history for (a pickaxe works on text, not on lines). */
function searchable(line: string): string {
  const lines = line.split(/\r?\n/).map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
  return lines.sort((a, b) => b.trim().length - a.trim().length)[0] ?? '';
}

/**
 * When the material of a source happened (§2.11): a session message's time, a commit's author time, the commit of the
 * version of a document — the commit a cited line first appeared in when one is cited — or the file's time when no
 * commit is behind it; undated, with when it was first read, when the source gives no time.
 */
export function sourceOccurred(ctx: EvidenceContext, source: Source, line: CitedLine | null = null): Occurred {
  const a = source.anchor;
  const seen = undatedAt(source.version.readAt, source.id);
  switch (a.kind) {
    case 'session': {
      if (line && a.host !== 'pi') {
        const message = messageAtOffset(source.excerpt.normalize('NFC'), line.start);
        if (message) {
          const exact = parsedSession(a.host, a.file)?.messages.find((m) => m.index === message.index)?.at ?? null;
          const at = exact ?? message.minute;
          const time = at ? dated(at, 'Session', source.id) : null;
          if (time) return time;
        }
      }
      return (a.at ? dated(a.at, 'Session', source.id) : null) ?? seen;
    }
    case 'commit': {
      const at = a.at ?? commitFacts(a.repo, a.commit)?.at ?? null;
      return (at ? dated(at, 'Commit', a.commit) : null) ?? seen;
    }
    case 'revision': {
      const found = line ? firstWithText(a.repo, a.path, searchable(line.text), a.commit) : null;
      const made = found ?? lastTouching(a.repo, a.path, a.commit) ?? commitFacts(a.repo, a.commit);
      return (made ? dated(made.at, 'Commit', made.hash) : null) ?? seen;
    }
    case 'file': {
      const place = resolvePath(ctx.project, { path: a.path });
      if (typeof place !== 'string' && place.root.git && place.rel && source.version.commit) {
        const read = source.version.commit;
        const upTo = /^[0-9a-f]{40}$/.test(read) ? read : gitResolveCommit(place.root.path, read);
        if (upTo) {
          const found = line ? firstWithText(place.root.path, place.rel, searchable(line.text), upTo) : null;
          const made = found ?? lastTouching(place.root.path, place.rel, upTo);
          const time = made ? dated(made.at, 'Commit', made.hash) : null;
          if (time) return time;
        }
      }
      // CM (E151; CK): a file read while it had changes not yet committed records no commit, and its time used to be the
      // file's own — the day it was last saved — so a decision of mid-September read as "started" on the day of the run,
      // after what ended it, and four pk_write_generation calls were refused. The words themselves are in the history: the
      // commit the cited line first appeared in, or, with no line cited, the one the section's own heading did.
      if (typeof place !== 'string' && place.root.git && place.rel && !source.version.commit) {
        const head = gitResolveCommit(place.root.path, 'HEAD');
        const words = line ? searchable(line.text) : a.headingPath.length ? searchable(source.excerpt.split(/\r?\n/).find((l) => l.trim()) ?? '') : '';
        const found = head && words ? firstWithText(place.root.path, place.rel, words, head) : null;
        const time = found ? dated(found.at, 'Commit', found.hash) : null;
        if (time) return time;
      }
      return fileTime(a.path, source.id) ?? seen;
    }
    case 'command': return dated(a.ranAt, 'First observed', source.id) ?? seen;
    case 'status': return dated(a.at, 'First observed', source.id) ?? seen;
  }
}

function fileTime(abs: string, anchor: string | null): Occurred | null {
  try {
    const st = statSync(abs);
    return st.isFile() ? { at: st.mtime.toISOString(), basis: 'File time', anchor } : null;
  } catch {
    return null;
  }
}

// ───────────────────────── objects of the assets ─────────────────────────

interface FoundObject {
  readonly id: string;
  readonly label: string;
  /** Its own time, when it carries one the program gave it (a breakpoint's, a send-back's, a patch's). */
  readonly occurred?: Occurred | null;
  /** Otherwise: the sources it rests on, whose times the program reads. */
  readonly sourceIds?: readonly string[];
  /** When the program first recorded it, for an object nothing dates. */
  readonly firstSeen?: string | null;
}

const latestNoteTitle = (versions: readonly { title: string }[]): string => versions[versions.length - 1]?.title ?? '';

/**
 * An object of the assets by its id — or by the number the Keeper gave it (a patch's `SP-n`, a Keeper number `K-n`) —
 * with its name and what dates it; null when it names nothing.
 */
export function findObject(store: ProjectStore, rawId: string): FoundObject | null {
  const id = rawId.trim();
  if (!id) return null;
  const merged = resolveMergedId(store, id);
  const thread = store.threads.get(merged);
  if (thread) {
    const facts = thread.factRecordIds.flatMap((f) => store.facts.get(f)?.aboutSourceIds ?? []);
    return { id: thread.id, label: thread.ids.length && !thread.title.includes(thread.ids[0]!) ? `${thread.ids[0]} ${thread.title}` : thread.title, sourceIds: [...facts, ...thread.executionFacts.flatMap((s) => s.sourceIds), ...thread.qcFacts.flatMap((s) => s.sourceIds)], firstSeen: thread.asOf };
  }
  const ref = store.reference.get(id);
  if (ref) return { id, label: ref.name, sourceIds: ref.sourceIds, firstSeen: ref.asOf };
  const node = store.nodes.get(id);
  if (node) return { id, label: node.label, sourceIds: node.sourceIds, firstSeen: node.createdAt || node.updatedAt };
  const area = store.areas.get(id);
  if (area) return { id, label: `Area understanding: ${store.reference.get(area.referenceId)?.name ?? area.referenceId}`, sourceIds: store.reference.get(area.referenceId)?.sourceIds ?? [], firstSeen: area.asOf };
  const fact = store.facts.get(id);
  if (fact) return { id, label: fact.title, sourceIds: fact.aboutSourceIds, firstSeen: fact.asOf };
  const relation = store.relations.get(id);
  if (relation) {
    const name = (x: string) => store.reference.get(x)?.name ?? store.threads.get(x)?.title ?? store.nodes.get(x)?.label ?? x;
    return { id, label: `${relation.type}: ${name(relation.from)} → ${name(relation.to)}`, sourceIds: relation.evidence.sourceIds, firstSeen: relation.updatedAt };
  }
  const change = store.changes.get(id);
  if (change) return { id, label: change.title, sourceIds: change.sourceIds, firstSeen: change.updatedAt };
  const mark = store.marks.get(id);
  if (mark) return { id, label: `${mark.kind}: ${mark.clue}`, sourceIds: mark.clueSourceIds, firstSeen: mark.since };
  const note = store.notes.get(id);
  if (note) return { id, label: latestNoteTitle(note.versions), sourceIds: note.versions.flatMap((v) => v.body.facts.flatMap((f) => f.sourceIds)), firstSeen: note.versions[0]?.at ?? note.updatedAt };
  const rule = store.rules.get(id);
  if (rule) return { id, label: rule.summary, sourceIds: rule.sourceIds, firstSeen: rule.asOf };
  const breakpoint = store.breakpoints.get(id);
  if (breakpoint) return { id, label: `${breakpoint.kind}: ${breakpoint.why}`, occurred: breakpoint.since };
  const sendBack = store.sendbacks.get(id);
  if (sendBack) return { id, label: `Send-back to ${sendBack.to}: ${sendBack.what}`, occurred: sendBack.occurred };
  const patch = store.patches.get(id) ?? store.patches.find((p) => p.number === id);
  if (patch) return { id: patch.id, label: `${patch.number} ${patch.title}`, occurred: patch.occurred };
  const generation = store.generations.get(id);
  if (generation) return { id, label: generation.name, occurred: generation.ended };
  const territory = store.territories.get(id);
  if (territory) return { id, label: territory.name, firstSeen: territory.updatedAt };
  const layer = store.layers.get(id);
  if (layer) return { id, label: `${layer.path} (${layer.layer})`, firstSeen: layer.updatedAt };
  const doc = store.roundDocs.get(id);
  if (doc) return { id, label: doc.title, firstSeen: doc.at };
  const link = store.links.get(id);
  if (link) return { id, label: `${link.stepKind}: ${store.threads.get(link.workId)?.title ?? link.workId}`, firstSeen: link.at };
  const draft = store.drafts.get(id);
  if (draft) return { id, label: `Session draft: ${draft.session.host} session ${draft.session.sessionId.slice(0, 8)}`, occurred: draft.session.startedAt ? dated(draft.session.startedAt, 'Session', draft.id) : null, firstSeen: draft.at };
  const number = store.numbers.get(id) ?? store.numbers.find((n) => n.number === id || n.projectNumber === id);
  if (number) {
    const of = number.objectId !== id ? findObject(store, number.objectId) : null;
    return of ?? { id: number.id, label: number.number, firstSeen: number.at };
  }
  return null;
}

// ───────────────────────── resolving one piece of evidence ─────────────────────────

/**
 * The evidence a call names, checked and labelled by the program, with when it happened; or why it cannot be, as the
 * caller is told it (`label` says which argument it is, e.g. `evidence[2]`).
 */
export function resolveEvidence(ctx: EvidenceContext, raw: unknown, label = 'evidence'): EvidenceRef | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return `${label} is not evidence: give { kind, id }, kind one of ${EVIDENCE_KINDS.join(' | ')}, and the line when it is one line${typeof raw === 'string' ? `. “${snippet(raw, 60)}” written out is not evidence — a date, a name or a summary is read by the program from what the evidence names` : ''}.`;
  }
  const input = raw as Record<string, unknown>;
  const set = PROGRAM_READS.filter((k) => input[k] !== undefined);
  if (set.length) {
    return `${label} gives ${set.join(' and ')}, which the program reads from what the evidence names (the model writes no date and no label of evidence). Give only kind, id, the line when it is one line, and repo for a file or a commit in another repository.`;
  }
  const kind = str(input.kind);
  if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) return `${label}.kind must be one of ${EVIDENCE_KINDS.join(', ')}${kind ? `; “${kind}” is not one` : ''}.`;
  const id = str(input.id).trim();
  if (!id) return `${label}.id is empty: name the ${kind === 'ledger' ? 'ledger entry' : kind === 'file' ? 'repository-relative path' : kind === 'commit' ? 'commit hash' : kind}.`;
  if (input.line !== undefined && typeof input.line !== 'string') return `${label}.line must be the text of the line, as the original has it.`;
  const line = str(input.line).trim() ? str(input.line) : null;
  const repo = str(input.repo).trim();
  switch (kind as EvidenceKind) {
    case 'ledger': return ledgerEvidence(ctx, id, line, label);
    case 'source': return sourceEvidence(ctx, id, line, label);
    case 'commit': return commitEvidence(ctx, id, line, repo, label);
    case 'file': return fileEvidence(ctx, id, line, repo, label);
    case 'object': return objectEvidence(ctx, id, line, label);
  }
}

/** Several pieces of evidence; the first that cannot be resolved refuses them all. */
export function resolveEvidenceList(ctx: EvidenceContext, raw: unknown, label = 'evidence'): EvidenceRef[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return `${label} must be a list of evidence: [{ kind, id, line? }].`;
  const out: EvidenceRef[] = [];
  for (const [i, item] of raw.entries()) {
    const ref = resolveEvidence(ctx, item, `${label}[${i}]`);
    if (typeof ref === 'string') return ref;
    if (!out.some((r) => evidenceKey(r) === evidenceKey(ref))) out.push(ref);
  }
  return out;
}

/** When what the evidence names happened (§2.11), read by the program; or why the evidence cannot be resolved. */
export function occurredOf(ctx: EvidenceContext, raw: unknown, label = 'evidence'): Occurred | string {
  const ref = resolveEvidence(ctx, raw, label);
  return typeof ref === 'string' ? ref : ref.occurred ?? undatedAt(null, ref.id);
}

/**
 * The same piece of evidence twice is one: kind, id and line — and the repository, for one outside the first (a key of
 * the first repository's evidence is what it always was, so ids built from it stay the same).
 */
export const evidenceKey = (r: EvidenceRef): string => `${r.kind}\x1f${r.id}\x1f${r.line ?? ''}${r.repo ? `\x1f${pathKey(r.repo)}` : ''}`;

function lineRefusal(line: string, where: string, hint: string | null): string {
  return `The line “${snippet(line)}” is not in ${where}, so nothing was written. ${HOW_A_LINE_IS_READ}${hint ? ` (${hint}.)` : ''}`;
}

function ledgerEvidence(ctx: EvidenceContext, id: string, line: string | null, label: string): EvidenceRef | string {
  if (!ctx.ledger) return `${label} names the ledger entry ${id}, and the ledger is not available in this build, so it cannot be checked. Cite what the entry is about instead — the source, the commit, or the file and its line — and the program reads its time from there.`;
  const entry = ctx.ledger.resolve(id);
  if (!entry) return `${label}: ${id} is not an entry of the ledger.`;
  let cited: string | null = null;
  if (line) {
    if (!entry.text) return `${label}: the ledger entry ${id} (${entry.label}) holds no text to find a line in; leave line out, or cite the source the line stands in.`;
    const found = asCited(entry.text, line);
    if (!found) return `${label}: ${lineRefusal(line, `the ledger entry ${id} (${entry.label})`, null)}`;
    cited = found.text;
  }
  return { kind: 'ledger', id, label: entry.label, line: cited, occurred: entry.occurred };
}

function sourceEvidence(ctx: EvidenceContext, id: string, line: string | null, label: string): EvidenceRef | string {
  const source = ctx.store.sources.get(id);
  if (!source) return `${label}: ${id} is not a source of this project. pk_list_sources lists them; a file can also be cited by its path (kind file) and a commit by its hash (kind commit).`;
  let cited: CitedLine | null = null;
  if (line) {
    const found = asCited(source.excerpt, line);
    if (!found) {
      const hint = checkVerbatim(ctx.store, line, [id]).missing[0]?.hint ?? null;
      return `${label}: ${lineRefusal(line, `${id} (${anchorLabel(source.anchor)})`, hint)}`;
    }
    cited = found;
  }
  return { kind: 'source', id, label: anchorLabel(source.anchor), line: cited?.text ?? null, occurred: sourceOccurred(ctx, source, cited) };
}

function commitEvidence(ctx: EvidenceContext, id: string, line: string | null, repo: string, label: string): EvidenceRef | string {
  const hash = id.toLowerCase();
  if (!/^[0-9a-f]{4,40}$/.test(hash)) return `${label}: “${id}” is not a commit hash. Name a commit by its hash, full or short: a branch, a tag or HEAD moves, and evidence has to keep pointing at the same commit.`;
  const roots = gitRoots(ctx.project, repo);
  if (typeof roots === 'string') return `${label}: ${roots}`;
  if (roots.length === 0) return `${label}: this project’s scope has no git repository, so ${id} cannot name a commit.`;
  const hits = new Map<string, string>();
  for (const r of roots) {
    const full = gitResolveCommit(r.path, hash);
    if (full && !hits.has(full)) hits.set(full, r.path);
  }
  if (hits.size === 0) return `${label}: ${id} names no commit in ${roots.map((r) => r.path).join(', ')}. pk_history_log lists the commits that touched a path.`;
  if (hits.size > 1) return `${label}: ${id} is short for more than one commit (${[...hits.keys()].map((h) => h.slice(0, 12)).join(', ')}). Give more of the hash, or repo.`;
  const [full, root] = [...hits.entries()][0]!;
  const facts = commitFacts(root, full);
  if (!facts) return `${label}: git could not read commit ${full.slice(0, 12)} in ${root}.`;
  let cited: string | null = null;
  if (line) {
    const message = commitMessage(root, full) ?? facts.subject;
    const found = asCited(message, line);
    if (!found) return `${label}: ${lineRefusal(line, `the message of commit ${full.slice(0, 7)}`, null)}`;
    cited = found.text;
  }
  // The label names another repository too: several views print the label alone.
  const other = otherRepository(ctx.project, root);
  return {
    kind: 'commit', id: full, label: `${full.slice(0, 7)} ${facts.subject}${other ? ` (in ${other})` : ''}`, line: cited,
    occurred: dated(facts.at, 'Commit', full) ?? undatedAt(null, full), ...(other ? { repo: other } : {}),
  };
}

function fileEvidence(ctx: EvidenceContext, id: string, line: string | null, repo: string, label: string): EvidenceRef | string {
  const place = resolvePath(ctx.project, { path: id, repo });
  if (typeof place === 'string') return `${label}: ${place}`;
  const { root, rel } = place;
  if (!rel) return `${label}: give the path of a file inside ${root.path}, relative to it.`;
  const abs = join(root.path, ...rel.split('/'));
  // A path is repository-relative: in another repository than the first, the evidence says which (and so does its label,
  // since several views print the label alone).
  const other = otherRepository(ctx.project, root.path);
  const elsewhere = other ? ` (in ${other})` : '';
  const where = other ? { repo: other } : {};
  let st: Stats | null = null;
  try { st = statSync(abs); } catch { st = null; }
  if (st) {
    if (st.isDirectory()) {
      if (line) return `${label}: ${rel} is a directory; a line is cited from a file.`;
      const made = root.git ? lastTouching(root.path, rel, 'HEAD') : null;
      return { kind: 'file', id: rel, label: `${rel}/${elsewhere}`, line: null, occurred: (made ? dated(made.at, 'Commit', made.hash) : null) ?? undatedAt(null, rel), ...where };
    }
    let cited: string | null = null;
    if (line) {
      if (st.size > MAX_REVISION_BYTES) return `${label}: ${rel} is ${st.size} bytes, more than the ${MAX_REVISION_BYTES} a line is looked for in; cite the source of the section instead.`;
      const text = readFileSync(abs, 'utf8');
      if (text.slice(0, 8000).includes('\0')) return `${label}: ${rel} is not a text file, so no line can be cited from it.`;
      const found = asCited(text, line);
      if (!found) return `${label}: ${lineRefusal(line, `${rel} as it is now${elsewhere}`, 'a line that only an earlier version has is cited from that version: read it with pk_history_read and cite the source it gives')}`;
      cited = found.text;
    }
    return { kind: 'file', id: rel, label: `${rel}${elsewhere}`, line: cited, occurred: currentFileOccurred(root, rel, abs, cited), ...where };
  }
  if (!root.git) return `${label}: ${rel} does not exist in ${root.path}.`;
  const last = lastVersionInHistory(root.path, rel);
  if (!last) return `${label}: ${rel} is not in ${root.path} now, and no commit in its history ever touched that path.`;
  let cited: string | null = null;
  let made = last.made;
  if (line) {
    const entry = gitTreeEntry(root.path, last.treeish, rel);
    if (!entry || entry.type !== 'blob') return `${label}: ${rel} was a directory; a line is cited from a file.`;
    const r = gitRead(root.path, ['show', `${last.treeish}:${rel}`], { timeoutMs: 20_000 });
    if (!r.ok || r.out.slice(0, 8000).includes('\0')) return `${label}: the last version of ${rel} could not be read as text.`;
    const found = asCited(r.out, line);
    if (!found) return `${label}: ${lineRefusal(line, `${rel} as its last version had it (${last.treeish.slice(0, 7)})`, 'an earlier version is read with pk_history_read and cited by the source it gives')}`;
    cited = found.text;
    made = firstWithText(root.path, rel, searchable(cited), last.treeish) ?? made;
  }
  return {
    kind: 'file', id: rel, label: `${rel} @ ${last.treeish.slice(0, 7)} (version history)${elsewhere}`, line: cited,
    occurred: dated(made.at, 'Commit', made.hash) ?? undatedAt(null, rel), ...where,
  };
}

/**
 * When the file as it is now happened: the commit a cited line first appeared in, or — the file being what HEAD has — the
 * last commit that touched it; a file or line not committed has only its file time.
 */
function currentFileOccurred(root: ProjectRoot, rel: string, abs: string, line: string | null): Occurred {
  if (root.git) {
    const found = line ? firstWithText(root.path, rel, searchable(line), 'HEAD') : null;
    if (found) return dated(found.at, 'Commit', found.hash) ?? undatedAt(null, rel);
    if (!line) {
      const head = gitTreeEntry(root.path, 'HEAD', rel);
      const working = head ? gitRead(root.path, ['hash-object', `--path=${rel}`, '--', abs], { timeoutMs: 8000 }).out.trim() : '';
      if (head && working === head.id) {
        const made = lastTouching(root.path, rel, 'HEAD');
        const time = made ? dated(made.at, 'Commit', made.hash) : null;
        if (time) return time;
      }
    }
  }
  return fileTime(abs, rel) ?? undatedAt(null, rel);
}

function objectEvidence(ctx: EvidenceContext, id: string, line: string | null, label: string): EvidenceRef | string {
  if (ctx.store.sources.has(id)) return `${label}: ${id} is a source: cite it with kind "source" — its label and time are read from the source.`;
  const found = findObject(ctx.store, id);
  if (!found) return `${label}: ${id} is not an object of this project’s assets (a graph node, reference item, work item, note, mark, rule, breakpoint, send-back, semantic patch, code territory, generation …).`;
  if (line) return `${label}: a line quotes original material, and ${found.id} (${snippet(found.label, 60)}) is the Keeper’s own record. Cite the source, file, commit or ledger entry the line stands in.`;
  const occurred = found.occurred
    ?? earliestOccurred((found.sourceIds ?? []).flatMap((s) => { const src = ctx.store.sources.get(s); return src ? [sourceOccurred(ctx, src)] : []; }))
    ?? undatedAt(found.firstSeen ?? null, found.id);
  return { kind: 'object', id: found.id, label: found.label, line: null, occurred };
}
