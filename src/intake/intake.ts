/**
 * Intake: read the scope's material into sources and keep coverage honest (Spec §1.11,
 * §3.2, §3.7 stages 1–3). Reading is not judging: new sources carry `usedAs: null`
 * (`Not yet judged`) until an organizing job forms fact records from them.
 */
import { existsSync, statSync } from 'node:fs';
import type { Coverage, CoverageScope, PendingMaterial, Project, ScopeItem, Source } from '../model/types.ts';
import { fingerprint } from '../model/ids.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { gitHead } from '../util/git.ts';
import { isWithin, normalizePath, pathKey, samePath } from '../util/paths.ts';
import { readFileSources, scanFiles, scanFilesAsync, type FileEntry } from '../sources/files.ts';
import { readsCommits } from '../scope/skip.ts';
import { ignoredPlaceOf } from '../scope/ignored-place.ts';
import { commitSources, statusSource } from '../sources/gitobs.ts';
import { isHistoryOnly } from '../sources/history.ts';
import { locateSessionsForHomes, type LocatedSession } from '../sources/sessions/locate.ts';
import { sessionStoreRootOf } from '../sources/sessions/scope.ts';
import { sessionSources } from '../sources/sessions/read.ts';
import type { PendingChange } from '../sources/watch.ts';
import { clerkPending } from '../keeper/organize/clerk-coverage.ts';
import { applyMaterialRules } from './material-rules.ts';
import { gitFates, recordDeletions, recordReturns, type DeletedFile } from './removal.ts';
import { excludedLocations, splitTooLarge } from './skipped.ts';

export interface IntakeResult {
  readonly filesRead: number;
  readonly sourcesUpserted: number;
  readonly sourcesChanged: number;
  readonly sourcesGone: number;
  readonly sessionsRead: number;
  readonly segments: number;
  readonly commits: number;
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  readonly durationMs: number;
  /** Objects the program recorded `Removed` because their material was deleted (D61), and ones back because it returned. */
  readonly objectsRemoved?: number;
  readonly objectsBack?: number;
}

/** A source's `Used as` with who set it and by what — kept together, so one judgement's value never carries another's mark. */
const usedAsOf = (s: Source) => ({ usedAs: s.usedAs, usedAsBy: s.usedAsBy, usedAsByRuleId: s.usedAsByRuleId ?? null, usedAsByScopeItemId: s.usedAsByScopeItemId ?? null });

/**
 * Upsert sources, keeping the owner's, the Keeper's, a rule's or the scope's `Used as` and reporting real change, and
 * which sources came back after being gone (the same file at the same place again). A source not judged yet takes what
 * its location sets as it is read now (§1.1: third-party documents are `Reference only`).
 */
function upsert(store: ProjectStore, incoming: readonly Source[], summary: string): { upserted: number; changed: string[]; returned: string[] } {
  const changed: string[] = [];
  const returned: string[] = [];
  const toPut: Source[] = [];
  for (const s of incoming) {
    const existing = store.sources.get(s.id);
    if (existing) {
      if (existing.version.fingerprint === s.version.fingerprint && existing.availability === null) continue;
      if (existing.version.fingerprint !== s.version.fingerprint) changed.push(s.id);
      if (existing.availability === 'No longer available') returned.push(s.id);
      toPut.push({ ...s, ...usedAsOf(existing.usedAs !== null ? existing : s), availability: null, movedTo: null });
    } else {
      toPut.push(s);
    }
  }
  store.sources.putMany(toPut, { jobId: null, summary });
  return { upserted: toPut.length, changed, returned };
}

/**
 * Where a vanished file's content is now, or null when it is nowhere: a move (§1.2 `Moved`), not a deletion. The same
 * whole file elsewhere is a move; so is a file elsewhere that holds at least half of its sections word for word, which
 * is a move with an edit made in the same stretch of work (an archived document given a new header line).
 */
function movedTo(sources: readonly Source[], wholeFile: ReadonlyMap<string, string>, sections: ReadonlyMap<string, readonly string[]>, from: string): string | null {
  for (const s of sources) {
    const twin = wholeFile.get(s.version.fingerprint);
    if (twin && !samePath(twin, from)) return twin;
  }
  const hits = new Map<string, number>();
  for (const s of sources) {
    for (const path of new Set(sections.get(fingerprint(s.excerpt)) ?? [])) if (!samePath(path, from)) hits.set(path, (hits.get(path) ?? 0) + 1);
  }
  const best = [...hits].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best && best[1] * 2 >= sources.length ? best[0] : null;
}

/** The file content the project has now, by whole-file and by section fingerprint, for telling a move from a deletion. */
function contentIndex(current: readonly Source[]): { wholeFile: Map<string, string>; sections: Map<string, string[]> } {
  const wholeFile = new Map<string, string>();
  const sections = new Map<string, string[]>();
  for (const s of current) {
    if (s.anchor.kind !== 'file') continue;
    wholeFile.set(s.version.fingerprint, s.anchor.path);
    const key = fingerprint(s.excerpt);
    const list = sections.get(key) ?? [];
    list.push(s.anchor.path);
    sections.set(key, list);
  }
  return { wholeFile, sections };
}

/**
 * Mark the sources of files that are gone: `Moved` (with where) when their content is elsewhere in the project, or
 * when a commit moved them away — also to a place outside the scope — and `No longer available` otherwise. Returns the
 * files that were deleted, with the commit that deleted them when git knows it, for `recordDeletions`.
 */
function markGone(store: ProjectStore, project: Project, gone: readonly Source[], current: readonly Source[]): { deleted: DeletedFile[]; count: number } {
  const byFile = new Map<string, Source[]>();
  for (const s of gone) {
    if (s.anchor.kind !== 'file') continue;
    const key = pathKey(s.anchor.path);
    const list = byFile.get(key) ?? [];
    list.push(s);
    byFile.set(key, list);
  }
  const { wholeFile, sections } = contentIndex(current);
  const files = [...byFile.values()].map((sources) => {
    const from = (sources[0]!.anchor as { path: string }).path;
    return { sources, from, twin: movedTo(sources, wholeFile, sections, from) };
  });
  const fates = gitFates(project, files.filter((f) => !f.twin).map((f) => f.from));
  const deleted: DeletedFile[] = [];
  let count = 0;
  for (const { sources, from, twin } of files) {
    const fate = fates.get(from);
    const moved = twin ?? fate?.movedTo ?? null;
    for (const s of sources) store.sources.put({ ...s, availability: moved ? 'Moved' : 'No longer available', movedTo: moved }, { jobId: null, summary: moved ? `File moved to ${moved}` : 'File no longer available' });
    count += sources.length;
    if (!moved) deleted.push({ path: from, scopeItemId: sources[0]!.scopeItemId, sourceIds: sources.map((s) => s.id), deletedIn: fate?.fate.kind === 'deleted' ? fate.fate.commit : null });
  }
  return { deleted, count };
}

/**
 * What was taken in by fact records, by kind of material (the coverage's `Processed` line). The clerk method's rounds write
 * none (D88), so for them this stays empty and the coverage's organizing levels say what was read and how (§1.11).
 */
function processedByKindOf(store: ProjectStore): Record<string, number> {
  const used = new Set<string>();
  for (const f of store.facts.all()) for (const id of f.aboutSourceIds) used.add(id);
  const byKind: Record<string, number> = {};
  for (const s of store.sources.all()) {
    if (!used.has(s.id) || s.availability === 'No longer available' || isHistoryOnly(s)) continue;
    const kind = s.anchor.kind === 'file' || s.anchor.kind === 'session' || s.anchor.kind === 'commit' ? s.anchor.kind : 'other';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  return byKind;
}

/**
 * The coverage with what waits for the next round listed the one way the organizing service lists it (Spec §1.11, §3.2;
 * keeper/organize/clerk-coverage.ts `clerkPending`): what was read since the latest round started, less what the project's
 * rules settle, what is history or reference only (§1.2, §1.15; CKC-02 AC-23), what the scope does not read, and the
 * Keeper's own commits of its project folder — with the changes the watcher saw and has not settled (`watcher`), when
 * the caller has them. For a caller without the App; intake itself leaves the list to the App (`recordIntake`).
 */
export function recomputeCoverage(store: ProjectStore, project: Project, extra: { organizing?: readonly PendingMaterial[]; failed?: CoverageScope['failed']; watcher?: readonly PendingMaterial[] } = {}): Coverage {
  const { pending } = clerkPending(store, project, extra.watcher ?? []);
  const pendingByKind: Record<string, number> = {};
  for (const p of pending) pendingByKind[p.kind] = (pendingByKind[p.kind] ?? 0) + 1;
  const previous = store.coverage.scopes.find((s) => s.id === 'project');
  const mainRepo = project.scope.find((i) => i.category === 'Repository' && i.relation !== 'Excluded' && !i.missing);
  const organizing = extra.organizing ?? previous?.organizing ?? [];
  const label: CoverageScope['coverage'] = project.organizingPaused ? 'Organizing paused' : organizing.length > 0 ? 'Organizing' : pending.length > 0 ? 'Changes pending' : 'Up to date';
  // A file too large to read is skipped, not failed (D105): also one an older home still holds among its failures.
  const told = splitTooLarge(latestFailures(extra.failed ?? previous?.failed ?? []), previous?.skipped ?? [], excludedLocations(project));
  const projectScope: CoverageScope = {
    id: 'project', kind: 'project', label: project.name, coverage: label, asOf: previous?.asOf ?? null,
    commit: mainRepo ? gitHead(mainRepo.path) : null, pending, organizing,
    failed: told.failed, skipped: told.skipped, lastRelookAt: previous?.lastRelookAt ?? null,
  };
  const others = store.coverage.scopes.filter((s) => s.id !== 'project');
  return {
    ...store.coverage, scopes: [projectScope, ...others], processedByKind: processedByKindOf(store), pendingByKind,
    state: store.coverage.state, updatedAt: new Date().toISOString(),
  };
}

/**
 * What could not be taken in, one entry per ref: the latest of each (by `at`, the later one on a tie), in the order the
 * kept entries came. Every incremental intake appends what it skipped, so a file that stays too large used to be counted
 * again at every pass (owner 2026-09-30: "2 failed" was one archive page recorded twice).
 */
export function latestFailures(failed: CoverageScope['failed']): CoverageScope['failed'] {
  const byRef = new Map<string, CoverageScope['failed'][number]>();
  for (const f of failed) {
    const before = byRef.get(f.ref);
    if (before && before.at > f.at) continue;
    byRef.delete(f.ref);
    byRef.set(f.ref, f);
  }
  return [...byRef.values()];
}

/**
 * What intake records in the coverage: what it could not take in, with the reason (CKC-07 AC-10) — a file over the size
 * limit apart, as skipped with its size and the limit, not as a failure (D105; ./skipped.ts) — when it read, the
 * point the next intake reads new commits from, the head of the main repository, and what fact records took in. What
 * waits for the next round is not intake's to list: the organizing service's list is the only one, and the App writes it
 * right after every intake (`App.refreshCoverage`, which carries these failures over). Intake used to write a list of its
 * own — every source no fact record was about, which the clerk method's rounds never write — so until the organizing
 * service's next pass the coverage listed nearly every source as pending.
 */
function recordIntake(store: ProjectStore, project: Project, failed: CoverageScope['failed'], summary: string, skippedBefore: NonNullable<CoverageScope['skipped']> = []): void {
  const previous = store.coverage.scopes.find((s) => s.id === 'project');
  const mainRepo = project.scope.find((i) => i.category === 'Repository' && i.relation !== 'Excluded' && !i.missing);
  const base: CoverageScope = previous ?? { id: 'project', kind: 'project', label: project.name, coverage: 'Changes pending', asOf: null, commit: null, pending: [], organizing: [], failed: [], lastRelookAt: null };
  const told = splitTooLarge(latestFailures(failed), skippedBefore, excludedLocations(project));
  const scope: CoverageScope = { ...base, asOf: new Date().toISOString(), commit: mainRepo ? gitHead(mainRepo.path) : null, failed: told.failed.slice(-100), skipped: told.skipped.slice(-100) };
  store.setCoverage({ ...store.coverage, scopes: [scope, ...store.coverage.scopes.filter((s) => s.id !== 'project')], processedByKind: processedByKindOf(store), updatedAt: new Date().toISOString() }, { jobId: null, summary });
}

/**
 * The directory a session item recorded before items named theirs gives in its reason — "… sessions whose working
 * directory is <dir>: 3 found", also inside "Excluded by the owner (was: …)". Read only for such an item.
 */
const REASON_CWD = /sessions whose working directory is (.+?)(?: \(the original of a copy; read-only\))?: \d+ found/;

/**
 * The scope item a session is filed under (§1.1): its host's item for the session's own working directory, the two
 * compared as paths, with the case and slashes the system allows. It used to look for the directory inside each item's
 * reason text, so of `D:\x` and `D:\x-y` a session of the first went to whichever item came first, and a directory the
 * log spelt otherwise matched nothing. A session no item names goes to its host's first item, as before.
 */
function sessionScopeItem(project: Project, host: string, cwd: string | null): string {
  const byHost = project.scope.filter((i) => i.sessionHost === host);
  const directoryOf = (i: ScopeItem) => i.sessionCwd ?? REASON_CWD.exec(i.reason)?.[1] ?? null;
  const match = cwd ? byHost.find((i) => { const dir = directoryOf(i); return dir !== null && samePath(dir, cwd); }) : undefined;
  return (match ?? byHost[0])?.id ?? project.scope[0]?.id ?? '';
}

function scopeCwds(project: Project): string[] {
  const out = new Set<string>();
  for (const i of project.scope) {
    if ((i.category === 'Directory' || i.category === 'Repository' || i.category === 'Worktree') && i.relation !== 'Excluded' && !i.missing) out.add(i.path);
    if (i.copyOf) out.add(i.copyOf);
  }
  return [...out];
}

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Read everything in scope. Files are scanned on a worker thread and the rest yields between items, so the workbench keeps answering during a large intake (CKC-09 AC-1). */
export async function fullIntake(store: ProjectStore, project: Project): Promise<IntakeResult> {
  const started = Date.now();
  const skipped: { path: string; reason: string }[] = [];
  let changed = 0;
  let upserted = 0;
  const returned: string[] = [];

  // Files
  const scan = await scanFilesAsync(project.id, project.scope);
  skipped.push(...scan.skipped);
  for (let i = 0; i < scan.sources.length; i += 400) {
    const files = upsert(store, scan.sources.slice(i, i + 400), 'Read project files');
    upserted += files.upserted;
    changed += files.changed.length;
    returned.push(...files.returned);
    await yieldNow();
  }

  // Sources whose file is gone: moved when the content appears elsewhere, otherwise deleted — and a deletion means the
  // objects resting only on it are no longer needed (D61).
  const vanished = store.sources.filter((s) => s.anchor.kind === 'file' && !s.availability && !existsSync(s.anchor.path));
  const { deleted, count: gone } = markGone(store, project, vanished, scan.sources);

  // Sessions
  const cwds = scopeCwds(project);
  const located = locateSessionsForHomes(cwds, (host, cwd) => sessionStoreRootOf(project.scope, host, cwd));
  let sessionsRead = 0;
  let segments = 0;
  for (const s of located) {
    try {
      const read = sessionSources(project.id, s, sessionScopeItem(project, s.host, s.cwd));
      const r = upsert(store, read.sources, `Read ${s.host} session ${s.sessionId.slice(0, 8)}`);
      upserted += r.upserted;
      changed += r.changed.length;
      segments += read.sources.length;
      sessionsRead += 1;
    } catch (error) {
      skipped.push({ path: s.file, reason: `session unreadable: ${(error as Error).message}` });
    }
    await yieldNow();
  }

  // Git
  let commits = 0;
  // The project's repositories and the worktrees that add something to the trunk; not a vendored library's upstream
  // history, not a merged worktree with nothing uncommitted (Spec §1.1, E60).
  for (const repo of project.scope.filter(readsCommits)) {
    const previous = store.coverage.scopes.find((s) => s.id === 'project')?.asOf ?? null;
    // A worktree contributes only the commits its main repository's HEAD does not already reach.
    const cs = commitSources(project.id, repo, previous, null, repo.category === 'Worktree' && repo.worktreeOf ? gitHead(repo.worktreeOf) : null);
    const r = upsert(store, cs, `Read commits of ${repo.path}`);
    upserted += r.upserted;
    commits += cs.length;
    const st = statusSource(project.id, repo);
    if (st) store.sources.put(st, { jobId: null, summary: `Observed repository status of ${repo.path}` });
    await yieldNow();
  }

  // What the deletions and returns mean for the assets, once the commits that made them are read too (D61).
  const removal = recordDeletions(store, project, deleted);
  const back = recordReturns(store, project, returned);
  // Material in a place a project rule covers is judged by that rule, also material read just now (§1.15).
  applyMaterialRules(store, project);
  recordIntake(store, project, skipped.map((s) => ({ ref: s.path, reason: s.reason, at: new Date().toISOString() })), 'Intake completed');
  return { filesRead: scan.files.length, sourcesUpserted: upserted, sourcesChanged: changed, sourcesGone: gone, sessionsRead, segments, commits, skipped, durationMs: Date.now() - started, objectsRemoved: removal.removed.length, objectsBack: back.restored.length };
}

/** Re-read only what the watcher reported as settled. */
export function incrementalIntake(store: ProjectStore, project: Project, changes: readonly PendingChange[]): IntakeResult {
  const started = Date.now();
  const skipped: { path: string; reason: string }[] = [];
  let upserted = 0;
  let changed = 0;
  let gone = 0;
  let sessionsRead = 0;
  let segments = 0;
  let commits = 0;
  const cwds = scopeCwds(project).map(pathKey);
  const vanishedPaths: string[] = [];
  const returned: string[] = [];
  /** Files this pass read, or found gone: what was recorded about one of them before no longer stands. */
  const settled = new Set<string>();
  for (const c of changes) {
    if (c.kind === 'file') {
      const path = normalizePath(c.ref);
      // A path that is gone — a file, or a whole directory the watcher reported once — is handled after every file of
      // this batch is read, so a file moved within the batch is found at its new place.
      if (!existsSync(path)) { vanishedPaths.push(path); settled.add(pathKey(path)); continue; }
      const owner = project.scope.filter((i) => i.category !== 'Session source' && i.relation !== 'Excluded' && isWithin(i.path, path)).sort((a, b) => b.path.length - a.path.length)[0];
      if (!owner) continue;
      // A location in a place the project's ignore rules leave out: its working files are no change to take in (D105).
      if (ignoredPlaceOf(project.scope, owner)) continue;
      let entry: FileEntry;
      try { const st = statSync(path); entry = { path, scopeItemId: owner.id, bytes: st.size, mtimeMs: st.mtimeMs }; } catch { continue; }
      const read = readFileSources(project.id, entry, null, project.scope);
      if (read.skipped) { if (!/not a text file/.test(read.skipped)) skipped.push({ path, reason: read.skipped }); continue; }
      // Sections that disappeared from the file are no longer available.
      const ids = new Set(read.sources.map((s) => s.id));
      for (const s of store.sources.all()) if (s.anchor.kind === 'file' && samePath(s.anchor.path, path) && !ids.has(s.id) && !s.availability) store.sources.put({ ...s, availability: 'No longer available' }, { jobId: null, summary: 'Section no longer in the file' });
      const r = upsert(store, read.sources, `Re-read ${path}`);
      upserted += r.upserted; changed += r.changed.length;
      returned.push(...r.returned);
      settled.add(pathKey(path));
    } else if (c.kind === 'session') {
      const located = locateSessionsForHomes(scopeCwds(project), (host, cwd) => sessionStoreRootOf(project.scope, host, cwd)).find((s) => samePath(s.file, c.ref));
      if (!located) continue;   // a log for some other directory
      if (located.cwd && !cwds.includes(pathKey(located.cwd))) continue;
      try {
        const read = sessionSources(project.id, located, sessionScopeItem(project, located.host, located.cwd));
        const r = upsert(store, read.sources, `Re-read ${located.host} session ${located.sessionId.slice(0, 8)}`);
        upserted += r.upserted; changed += r.changed.length; segments += read.sources.length; sessionsRead += 1;
      } catch (error) { skipped.push({ path: c.ref, reason: `session unreadable: ${(error as Error).message}` }); }
    } else if (c.kind === 'commit') {
      const repo = project.scope.find((i) => i.id === c.scopeItemId);
      if (!repo) continue;
      const previous = store.coverage.scopes.find((s) => s.id === 'project')?.asOf ?? null;
      const cs = commitSources(project.id, repo, previous, null, repo.category === 'Worktree' && repo.worktreeOf ? gitHead(repo.worktreeOf) : null);
      const r = upsert(store, cs, `Read new commits of ${repo.path}`);
      upserted += r.upserted; commits += cs.length;
      const st = statusSource(project.id, repo);
      if (st) store.sources.put(st, { jobId: null, summary: `Observed repository status of ${repo.path}` });
    }
  }
  let deleted: DeletedFile[] = [];
  if (vanishedPaths.length) {
    const vanished = store.sources.filter((s) => s.anchor.kind === 'file' && !s.availability && vanishedPaths.some((p) => isWithin(p, (s.anchor as { path: string }).path)) && !existsSync(s.anchor.path));
    const vanishedIds = new Set(vanished.map((s) => s.id));
    const current = store.sources.filter((s) => s.anchor.kind === 'file' && !s.availability && !vanishedIds.has(s.id));
    const marked = markGone(store, project, vanished, current);
    deleted = marked.deleted;
    gone += marked.count;
  }
  const removal = recordDeletions(store, project, deleted);
  const back = recordReturns(store, project, returned);
  applyMaterialRules(store, project);
  // What was recorded before stands, except for a file this pass read or found gone: it is no longer failed or skipped.
  const previous = store.coverage.scopes.find((s) => s.id === 'project');
  const stillStands = (ref: string) => !settled.has(pathKey(ref));
  const previousFailed = (previous?.failed ?? []).filter((f) => stillStands(f.ref));
  const previousSkipped = (previous?.skipped ?? []).filter((f) => stillStands(f.ref));
  recordIntake(store, project, [...previousFailed, ...skipped.map((s) => ({ ref: s.path, reason: s.reason, at: new Date().toISOString() }))], 'Incremental intake', previousSkipped);
  return { filesRead: changes.filter((c) => c.kind === 'file').length, sourcesUpserted: upserted, sourcesChanged: changed, sourcesGone: gone, sessionsRead, segments, commits, skipped, durationMs: Date.now() - started, objectsRemoved: removal.removed.length, objectsBack: back.restored.length };
}

export type { LocatedSession };
