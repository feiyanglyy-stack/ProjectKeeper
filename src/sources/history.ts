/**
 * Old content from version history (Spec §1.2 `History only`, §3.1; CKC-03 AC-24; subagent/DECISIONS.md E64, E65).
 *
 * The Keeper can list the history of a path, read a file as it was at any commit — a deleted file, an old version of a
 * plan, an old file of a worktree branch already merged — and list the documents main's history deleted. What it reads
 * becomes a source whose `Used as` is `History only`, anchored at repository, commit and path. Deletion means "no
 * longer needed" (D61), so that source has three uses only: marking what current material has outdated, cross-checking
 * current documents, and producing the history when it is traced. It forms no current node, enters no context, and is
 * never material waiting to be organized (the checks live with the writes and the coverage; `isHistoryOnly` is their
 * one test).
 *
 * Only read-only git runs here, against the repositories in the project's scope.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { Project, ScopeItem, Source } from '../model/types.ts';
import { fingerprint } from '../model/ids.ts';
import type { ProjectStore } from '../store/project-store.ts';
import {
  gitCommitMeta, gitDeletedPaths, gitHashWorkingFile, gitPathHistory, gitResolveCommit, gitShow, gitTrackedPaths,
  gitTreeEntry, gitUncommittedDeletions, isSafeRef, type CommitMeta,
} from '../util/git.ts';
import { isWithin, normalizePath, samePath } from '../util/paths.ts';
import { extractIds, redactCredentials, revisionSourceId } from './anchor.ts';

/** Material that exists only in history: read from version history, or judged `History only` (a recovery-only place). */
export function isHistoryOnly(source: Source): boolean {
  return source.anchor.kind === 'revision' || source.usedAs === 'History only';
}

/** Same bound as a project file read into sources (sources/files.ts). */
export const MAX_REVISION_BYTES = 2_000_000;

/** Documents: what the intent material of a project is written in (design, plan, decision, review). */
const DOC_RE = /\.(md|markdown|mdx|txt|text|rst|adoc|asciidoc|org|textile|wiki|html?)$/i;
export const isDocumentPath = (path: string): boolean => DOC_RE.test(path);

export interface HistoryTarget {
  readonly item: ScopeItem;
  /** Where git runs: the scope item's own checkout. */
  readonly root: string;
  /** The repository whose history it is: a worktree of the main repository shares the main repository's. */
  readonly repo: string;
  /** Relative to the root, forward slashes; '' for the root itself. */
  readonly rel: string;
}

const repoItems = (project: Project): ScopeItem[] =>
  project.scope.filter((i) => (i.category === 'Repository' || i.category === 'Worktree') && i.relation !== 'Excluded' && !i.missing);

/**
 * Which repository and path a call means: `repo` names a scope item by id or path; an absolute path picks the
 * repository that holds it; otherwise the main repository. A path that leaves the repository is refused.
 */
export function resolveTarget(project: Project, input: { readonly path?: string; readonly repo?: string }): HistoryTarget | string {
  const repos = repoItems(project);
  if (repos.length === 0) return 'This project has no repository in its scope, so there is no version history to read.';
  const raw = (input.path ?? '').trim();
  let item: ScopeItem | undefined;
  const repoArg = (input.repo ?? '').trim();
  if (repoArg) {
    item = repos.find((i) => i.id === repoArg) ?? repos.find((i) => samePath(i.path, repoArg));
    if (!item) return `${repoArg} is not a repository or worktree in this project’s scope. Use one of: ${repos.map((i) => `${i.id} (${i.path})`).join(', ')}.`;
  } else if (raw && isAbsolute(raw)) {
    item = repos.filter((i) => isWithin(i.path, raw)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!item) return `${raw} is not inside a repository of this project’s scope.`;
  } else {
    item = repos.find((i) => i.relation === 'Main project' && i.category === 'Repository') ?? repos.find((i) => i.category === 'Repository') ?? repos[0]!;
  }
  const root = item.path;
  let rel = raw;
  if (raw && isAbsolute(raw)) {
    if (!isWithin(root, raw)) return `${raw} is not inside ${root}.`;
    rel = relative(normalizePath(root), normalizePath(raw));
  }
  rel = rel.split('\\').join('/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (rel === '.') rel = '';
  if (rel.split('/').some((seg) => seg === '..') || /^[A-Za-z]:/.test(rel) || rel.startsWith('/')) return `${raw} leaves the repository; give a path inside ${root}.`;
  const repo = item.category === 'Worktree' && item.relation === 'Worktree of main repo' && item.worktreeOf ? item.worktreeOf : root;
  return { item, root, repo, rel };
}

export type Change = 'Added' | 'Modified' | 'Deleted' | 'Renamed' | 'Copied' | 'Type changed';
const CHANGE: Record<string, Change> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' };

export interface HistoryRow {
  readonly commit: string;
  readonly at: string;
  readonly author: string;
  readonly subject: string;
  readonly change: Change;
  readonly path: string;
  readonly from?: string;
  readonly to?: string;
  /** The commit whose tree holds this version: the commit itself, or for a deletion the last commit that had it. */
  readonly readAt: string | null;
}

/**
 * Every commit that touched a path (for a directory: anything under it), newest first, a page at a time: `limit` commits
 * (default 100) after the first `offset`. Paging reaches the whole history (D77: no recent-N cap).
 */
export function pathHistory(project: Project, input: { readonly path: string; readonly repo?: string; readonly limit?: number; readonly offset?: number }): { target: HistoryTarget; rows: HistoryRow[]; more: boolean; offset: number; next: number | null } | string {
  const target = resolveTarget(project, input);
  if (typeof target === 'string') return target;
  if (!target.rel) return 'Give a path inside the repository (a file or a directory).';
  const limit = Math.max(1, Math.floor(Number(input.limit) || 100));
  const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
  const commits = gitPathHistory(target.root, target.rel, limit + 1, 'HEAD', offset);
  if (!commits) return `git could not read the history of ${target.rel} in ${target.root}.`;
  const rows: HistoryRow[] = [];
  for (const c of commits.slice(0, limit)) {
    for (const ch of c.changes) {
      const renamedAway = (ch.status === 'R' || ch.status === 'C') && ch.from !== null && (ch.from === target.rel || ch.from.startsWith(`${target.rel}/`)) && !(ch.path === target.rel || ch.path.startsWith(`${target.rel}/`));
      rows.push({
        commit: c.hash, at: c.at, author: c.author, subject: c.subject, change: CHANGE[ch.status]!,
        path: renamedAway ? ch.from! : ch.path,
        ...(ch.status === 'R' || ch.status === 'C' ? (renamedAway ? { to: ch.path } : { from: ch.from! }) : {}),
        readAt: ch.status === 'D' || renamedAway ? (c.parents[0] ?? null) : c.hash,
      });
    }
  }
  const more = commits.length > limit;
  return { target, rows, more, offset, next: more ? offset + limit : null };
}

export type RevisionRead =
  | { readonly kind: 'history'; readonly source: Source; readonly target: HistoryTarget; readonly meta: CommitMeta | null; readonly text: string; readonly nowAtPath: 'Changed since' | 'Not at this path now' }
  | { readonly kind: 'current'; readonly target: HistoryTarget; readonly commit: string; readonly file: string; readonly sourceIds: readonly string[] };

/**
 * A file as it was at a commit. When it is exactly what the project has at that path now, it is current material and
 * nothing is recorded as history; otherwise it becomes (or refreshes) the `History only` source of that repository,
 * commit and path. The refusals say what to do instead: a deleted file is read at the last commit that had it.
 */
export function readRevision(store: ProjectStore, project: Project, input: { readonly path: string; readonly commit: string; readonly repo?: string }): RevisionRead | string {
  const target = resolveTarget(project, input);
  if (typeof target === 'string') return target;
  if (!target.rel) return 'Give the path of a file inside the repository.';
  const ref = (input.commit ?? '').trim();
  if (!isSafeRef(ref)) return `“${ref}” is not a commit: give a commit hash, a branch or tag name, or HEAD (optionally with ~n or ^); anything shaped like an option is refused, because history is read with read-only commands only.`;
  const commit = gitResolveCommit(target.root, ref);
  if (!commit) return `${ref} names no commit in ${target.root}. pk_history_log lists the commits that touched ${target.rel}.`;
  const entry = gitTreeEntry(target.root, commit, target.rel);
  if (!entry) {
    const touched = gitPathHistory(target.root, target.rel, 1, commit)?.[0];
    const gone = touched?.changes.some((c) => c.status === 'D' || (c.status === 'R' && c.from === target.rel));
    if (touched && gone && touched.parents[0]) {
      return `${target.rel} is not in ${commit.slice(0, 10)}: it was deleted (or moved away) in ${touched.hash.slice(0, 10)} (“${touched.subject}”), and its last version is at ${touched.parents[0].slice(0, 10)}. Read it there: commit "${touched.parents[0]}".`;
    }
    if (touched) return `${target.rel} is not a file in ${commit.slice(0, 10)}; the last commit up to it that touched the path is ${touched.hash.slice(0, 10)} (“${touched.subject}”). pk_history_log lists its versions.`;
    return `${target.rel} is not in ${commit.slice(0, 10)}, and no commit up to it ever touched that path.`;
  }
  if (entry.type !== 'blob') return `${target.rel} is a ${entry.type === 'tree' ? 'directory' : 'submodule'} at ${commit.slice(0, 10)}; read one file at a time (pk_history_log lists what changed under a directory).`;
  if (entry.size !== null && entry.size > MAX_REVISION_BYTES) return `${target.rel} is ${entry.size} bytes at ${commit.slice(0, 10)}, larger than the ${MAX_REVISION_BYTES} bytes a source holds.`;
  const file = join(target.root, ...target.rel.split('/'));
  if (existsSync(file) && gitHashWorkingFile(target.root, file, target.rel) === entry.id) {
    const sourceIds = store.sources.filter((s) => s.anchor.kind === 'file' && samePath(s.anchor.path, file) && s.availability === null).map((s) => s.id);
    return { kind: 'current', target, commit, file, sourceIds };
  }
  const text = gitShow(target.root, commit, target.rel);
  if (text === null) return `git could not read ${target.rel} at ${commit.slice(0, 10)}.`;
  if (text.slice(0, 8000).includes('\0')) return `${target.rel} at ${commit.slice(0, 10)} is not a text file.`;
  const meta = gitCommitMeta(target.root, commit);
  const red = redactCredentials(text);
  const id = revisionSourceId(target.repo, commit, target.rel);
  const previous = store.sources.get(id);
  const name = target.rel.split('/').pop()!;
  const source: Source = {
    id, projectId: project.id, title: `${name} @ ${commit.slice(0, 8)}${meta ? ` · ${meta.at.slice(0, 10)}` : ''}`,
    anchor: { kind: 'revision', repo: target.repo, commit, path: target.rel }, ids: extractIds(text),
    version: { fingerprint: fingerprint(text), readAt: previous?.version.readAt ?? new Date().toISOString(), commit }, excerpt: red.text,
    usedAs: 'History only', usedAsBy: 'keeper', usedAsByRuleId: null, availability: null, movedTo: null,
    scopeItemId: target.item.id, hasCredential: red.found, bytes: Buffer.byteLength(text),
  };
  return { kind: 'history', source, target, meta, text: red.text, nowAtPath: existsSync(file) ? 'Changed since' : 'Not at this path now' };
}

export interface DeletedDocument {
  readonly path: string;
  readonly deletedIn: { readonly commit: string; readonly at: string; readonly author: string; readonly subject: string } | 'uncommitted';
  readonly lastPresentIn: string | null;
}
export interface DeletedDirectory {
  readonly dir: string;
  readonly count: number;
  readonly lastDeletedAt: string | null;
  readonly files: readonly DeletedDocument[];
}

/**
 * What main's history deleted and the current version does not have again, grouped by directory, each with the commit
 * that deleted it and the last commit it appears in. Documents only unless `all`; a rename is not a deletion; a
 * deletion in the working tree not committed yet is listed as such.
 */
export function deletedDocuments(project: Project, input: { readonly repo?: string; readonly dir?: string; readonly all?: boolean }): { target: HistoryTarget; head: string | null; directories: DeletedDirectory[]; total: number } | string {
  const target = resolveTarget(project, { repo: input.repo, path: input.dir });
  if (typeof target === 'string') return target;
  const head = gitResolveCommit(target.root, 'HEAD');
  if (!head) return `${target.root} has no commit yet.`;
  const deleted = gitDeletedPaths(target.root, 'HEAD', target.rel || null);
  if (!deleted) return `git could not read the deletions in ${target.root}.`;
  const present = gitTrackedPaths(target.root, 'HEAD', target.rel || null) ?? new Set<string>();
  const docs: DeletedDocument[] = [];
  const keep = (path: string) => (input.all === true || isDocumentPath(path)) && !present.has(path) && !existsSync(join(target.root, ...path.split('/')));
  for (const d of deleted) {
    if (!keep(d.path)) continue;
    docs.push({ path: d.path, deletedIn: { commit: d.deletedIn.hash, at: d.deletedIn.at, author: d.deletedIn.author, subject: d.deletedIn.subject }, lastPresentIn: d.deletedIn.parents[0] ?? null });
  }
  const listed = new Set(docs.map((d) => d.path));
  for (const path of gitUncommittedDeletions(target.root)) {
    if (listed.has(path) || !(input.all === true || isDocumentPath(path))) continue;
    if (target.rel && !(path === target.rel || path.startsWith(`${target.rel}/`))) continue;
    docs.push({ path, deletedIn: 'uncommitted', lastPresentIn: head });
  }
  const byDir = new Map<string, DeletedDocument[]>();
  for (const d of docs) {
    const dir = d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/')) : '.';
    const list = byDir.get(dir) ?? [];
    list.push(d);
    byDir.set(dir, list);
  }
  const atOf = (d: DeletedDocument) => (d.deletedIn === 'uncommitted' ? '9999' : d.deletedIn.at);
  const directories = [...byDir].map(([dir, files]) => {
    const sorted = [...files].sort((a, b) => atOf(b).localeCompare(atOf(a)) || a.path.localeCompare(b.path));
    const dated = sorted.map((f) => (f.deletedIn === 'uncommitted' ? null : f.deletedIn.at)).filter((x): x is string => x !== null);
    return { dir, count: files.length, lastDeletedAt: dated[0] ?? null, files: sorted };
  }).sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir));
  return { target, head, directories, total: docs.length };
}
