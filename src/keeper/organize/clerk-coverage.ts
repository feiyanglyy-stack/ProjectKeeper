/**
 * The coverage by the clerk method (Spec v3.0 §1.11, §3.2, §3.8; CKC-07 AC-1, AC-10, AC-11, AC-18; CKC-13 AC-8): what is
 * pending, and every material's organizing level, computed from the rounds, the jobs' recorded calls, the session drafts
 * and the project's rules — never written by a model.
 *
 * Pending. A round takes in the material read up to its start ("这一轮整理的变化记录，截到这一轮开始的时候", §3.8), so
 * whatever was read after the latest round started waits for the next one: a new or changed file, a session that went
 * on, a new commit. With it the changes the watcher saw and has not settled yet (§3.2: "变化一出现就被接住，列为待处理").
 * What the project's rules settle, what is history or reference only, and what the scope does not read never waits
 * (`listMaterials`, `ruleSettlement`), nor does the Keeper's own commit of its project folder: it is the assets written
 * out, not the project's material. The daily gate opens on the same list (clerk.ts), so what shows as pending is what
 * the next round takes. Nor does a file in a place the project's own ignore rules leave out (D105; scope/ignored-place.ts):
 * the working files of a worktree under an ignored directory are not pending, whether intake read them before or the
 * watcher saw them change; its commits the trunk does not have wait like any commit.
 *
 * Levels (§1.11). `Settled by rule`: the project's rules judge it without close reading. `Not organized`: pending. `Read
 * in full`: a job read all of it — a step, a sweep, an investigation or an answer — by whatever means the runtime
 * recorded on the step (`JobStep.reads`, keeper/bounds/reads.ts): the file tool, a shell command (`cat`, `sed -n 1,$p`),
 * the ledger's document tools, or several ranges that together cover it; every source of it read (`pk_read_source`);
 * the commits of a repository once a sweep or an investigation read them through the ledger. A step recorded before
 * reads were kept counts by its target as it did (`read`, a document's text from the ledger). `Conclusions only`: a
 * session with a session draft — the owner's words verbatim, the agents' course as claims (§3.11). `Sampled`: one of a
 * series of like files (same place, same name pattern) whose samples were read in full (`sampledGroups`). `Indexed`: in
 * the ledger and the sources, searchable, read when a question needs it. `Skipped: too large`: a file over the size
 * intake reads of one file — no sources, counted from the coverage's skipped list (D105).
 *
 * Read in part. Some lines of a file — `head`, `sed -n a,bp`, a `read` with an offset or cut short, some of its sources —
 * is not reading it in full, and §1.11 has no level for it: such a material keeps the level it has otherwise (mostly
 * `Indexed`), and the part reads are counted beside the levels (`readInPart`). Searching a file (`grep`) is not reading it.
 *
 * What history is not organized (`historyNotOrganized`): the history-tier materials (§3.7: older than the takeover and
 * outside the first usable slice) whose level is `Indexed`, `Sampled` or `Not organized` — counted, whatever the depth.
 */
import { isAbsolute, join } from 'node:path';
import type { KeeperJob, LevelCount, PartReads, PendingMaterial, Project, Source, StepRead, TakeoverStatus } from '../../model/types.ts';
import { ORGANIZING_LEVEL, SKIPPED_TOO_LARGE, type OrganizingLevel } from '../../model/vocab.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { pathKey } from '../../util/paths.ts';
import { ignoredPlaceLookup } from '../../scope/ignored-place.ts';
import { skippedOf } from '../../intake/skipped.ts';
import { sessionKey } from '../../ledger/sessions.ts';
import { coversAll } from '../bounds/reads.ts';
import { KEEPER_AUTHOR } from '../project-folder.ts';
import { listMaterials, projectRelPath, ruleSettlement, settledAwayMaterials, type Material } from './materials.ts';
import { sampledGroups } from './takeover.ts';
import { isClerkSkillPath } from './skills.ts';

const PLAN_ID = 'organizing-plan';
const KEEPER_NAME = KEEPER_AUTHOR.replace(/\s*<.*$/, '');

/** When the latest round took its material in: its start; '' before the first round. */
export function takenInAt(store: ProjectStore): string {
  return store.clerkRounds.all().reduce((at, r) => (r.startedAt > at ? r.startedAt : at), '');
}

/** The Keeper's own commit of its project folder (project-folder.ts): not the project's material. */
const keeperCommit = (s: Source): boolean => s.anchor.kind === 'commit' && new RegExp(`^author: ${KEEPER_NAME}$`, 'm').test(s.excerpt);

/** One pending entry for a source, the way the coverage lists it: a file once, a session once, each commit. */
function pendingOf(project: Project, s: Source): PendingMaterial | null {
  const a = s.anchor;
  const since = s.version.readAt;
  if (a.kind === 'file') return { kind: 'file', ref: a.path, label: projectRelPath(project, a.path).split('\\').join('/'), since };
  if (a.kind === 'session') return { kind: 'session', ref: a.file, label: `${a.host} session ${a.sessionId.slice(0, 8)}`, since };
  if (a.kind === 'commit') return { kind: 'commit', ref: `${a.repo}@${a.commit}`, label: `${a.commit.slice(0, 8)} ${s.title.slice(9)}`.trim(), since };
  return null;
}

export interface ClerkPending {
  /** What waits for the next round, oldest first. */
  readonly pending: readonly PendingMaterial[];
  /** The material keys (`listMaterials`) that wait: their level is `Not organized`. */
  readonly keys: ReadonlySet<string>;
  /**
   * The sources read since the latest round started behind each entry of `pending` that was read (by its ref): what
   * `Update pending` reads a change from (update-pending.ts). An entry only the watcher has seen has none yet.
   */
  readonly fresh: ReadonlyMap<string, readonly Source[]>;
}

/**
 * What waits for the next round: material read since the latest round started, and — for the coverage — the changes
 * the watcher saw and has not settled (`watcher`). `materials` may be given when the caller has them already.
 */
export function clerkPending(store: ProjectStore, project: Project, watcher: readonly PendingMaterial[] = [], materials?: readonly Material[]): ClerkPending {
  const since = takenInAt(store);
  const fresh = store.sources.filter((s) => s.version.readAt > since && !keeperCommit(s));
  const byRef = new Map<string, PendingMaterial>();
  const sourcesOf = new Map<string, Source[]>();
  const keys = new Set<string>();
  // A file in a place the project's ignore rules leave out is not pending (§1.1, D105).
  const leftOut = ignoredPlaceLookup(project.scope);
  if (fresh.length) {
    const all = materials ?? listMaterials(store, project);
    const plan = store.plans.get(PLAN_ID) ?? null;
    const materialOf = new Map<string, Material>();
    for (const m of all) for (const id of m.sourceIds) materialOf.set(id, m);
    for (const s of fresh) {
      const m = materialOf.get(s.id);
      if (!m || ruleSettlement(store, plan, m)) continue;
      if (s.anchor.kind === 'file' && leftOut(s.anchor.path)) continue;
      const p = pendingOf(project, s);
      if (!p) continue;
      keys.add(m.key);
      const had = byRef.get(p.ref);
      if (!had || p.since < had.since) byRef.set(p.ref, p);
      const list = sourcesOf.get(p.ref) ?? [];
      list.push(s);
      sourcesOf.set(p.ref, list);
    }
  }
  for (const w of watcher) if (!byRef.has(w.ref) && !(w.kind === 'file' && leftOut(w.ref))) byRef.set(w.ref, { kind: w.kind, ref: w.ref, label: w.label, since: w.since });
  return { pending: [...byRef.values()].sort((a, b) => a.since.localeCompare(b.since) || a.label.localeCompare(b.label)), keys, fresh: sourcesOf };
}

/** How much of one file (or of one version of it from the history) the steps read: all of it, ranges of its lines, a part. */
export interface FileReads {
  whole: boolean;
  ranges: [number, number | null][];
  /** Its length in lines, as the reads of a range found it (the largest, if it grew between them). */
  lines: number | null;
  part: boolean;
}

/** What a set of jobs read, from the calls the runtime recorded on their steps (§1.11 `Read in full`, CKC-13 AC-8). */
export interface ReadTally {
  /** Files as they stand, by path key. */
  readonly files: Map<string, FileReads>;
  /** Versions from the history, by the file's path key: each with the commit it was read at. */
  readonly versions: Map<string, { rev: string; reads: FileReads }[]>;
  /** Commits read one by one (`pk_ledger_commit`, `git show <commit>`), lower-case, full or short. */
  readonly commits: Set<string>;
  /** Sources read by id (`pk_read_source`). */
  readonly sources: Set<string>;
  /** A sweep or an investigation read the commits of a repository through the ledger. */
  readonly ledgerCommits: boolean;
  /** Sessions read through the ledger (`pk_ledger_sessions`), by the ledger's session id: the message positions shown. */
  readonly sessions: Map<string, FileReads>;
}

const newFileReads = (): FileReads => ({ whole: false, ranges: [], lines: null, part: false });
function addRead(f: FileReads, r: StepRead): void {
  if (r.part) { f.part = true; return; }
  if (r.from === undefined && r.to === undefined) { f.whole = true; return; }
  f.ranges.push([r.from ?? 1, r.to ?? null]);
  if (r.lines !== undefined) f.lines = Math.max(f.lines ?? 0, r.lines);
}

/** Whole, when a read showed all of it or its ranges together cover it; in part, when any of it was read; else null. */
export function extentOf(f: FileReads | null | undefined): 'whole' | 'part' | null {
  if (!f) return null;
  if (f.whole || (f.ranges.length > 0 && coversAll(f.ranges, f.lines))) return 'whole';
  return f.ranges.length > 0 || f.part ? 'part' : null;
}

/**
 * Tally what `jobs` read. A step with recorded reads (`JobStep.reads`) counts by them — the recorder already left out
 * what a refused or failed call did not show. A step recorded before reads were kept counts by its target, as the
 * coverage counted it then: a successful `read` or ledger document read as the whole file. What an agent read of the
 * install's own clerk skills is its method, not the project's material, and is left out (skills.ts `isClerkSkillPath`).
 */
export function tallyReads(jobs: Iterable<KeeperJob>, project: Project): ReadTally {
  const root = project.locations[0] ?? '';
  const fileKey = (target: string): string | null => {
    const t = target.trim().replace(/^doc:/, '').replace(/@[0-9a-f]{4,40}$/i, '');
    if (!t || /[\n*?]/.test(t)) return null;
    try { return pathKey(isAbsolute(t) ? t : join(root, t)); } catch { return null; }
  };
  const files = new Map<string, FileReads>();
  const versions = new Map<string, { rev: string; reads: FileReads }[]>();
  const commits = new Set<string>();
  const sources = new Set<string>();
  const sessions = new Map<string, FileReads>();
  let ledgerCommits = false;
  const fileOf = (key: string) => { let f = files.get(key); if (!f) { f = newFileReads(); files.set(key, f); } return f; };
  const sweepOrInvestigation = (j: KeeperJob) => j.step?.kind === 'dig' || j.step?.kind === 'lane' || j.kind === 'Investigation';
  for (const j of jobs) {
    for (const s of j.steps) {
      if (s.reads) {
        for (const r of s.reads) {
          if (r.session) { let f = sessions.get(r.session); if (!f) { f = newFileReads(); sessions.set(r.session, f); } addRead(f, r); continue; }
          if (!r.path) { if (r.rev) commits.add(r.rev.toLowerCase()); continue; }
          if (!r.rev && isClerkSkillPath(r.path, root || undefined)) continue;
          let key: string;
          try { key = pathKey(r.path); } catch { continue; }
          if (!r.rev) { addRead(fileOf(key), r); continue; }
          const list = versions.get(key) ?? [];
          let v = list.find((x) => x.rev === r.rev);
          if (!v) { v = { rev: r.rev, reads: newFileReads() }; list.push(v); versions.set(key, list); }
          addRead(v.reads, r);
        }
      } else if (!s.isError && (s.tool === 'read' || s.tool === 'pk_ledger_doc_read') && s.target) {
        const k = fileKey(s.target);
        if (k && !isClerkSkillPath(k)) fileOf(k).whole = true;
      }
      if (s.isError) continue;
      if (s.tool === 'pk_read_source' && s.target) sources.add(s.target.trim());
      else if ((s.tool === 'pk_ledger_commits' || s.tool === 'pk_ledger_commit') && sweepOrInvestigation(j)) ledgerCommits = true;
    }
  }
  return { files, versions, commits, sources, ledgerCommits, sessions };
}

/**
 * How much of a material the tally read (§1.11): a file whole — the file read whole, or every source of it read — or in
 * part; a session segment whole when its log was read whole, every message of its session was read through the ledger
 * (`pk_ledger_sessions`), or the segment itself was read (`pk_read_source`); the commits of a repository when a sweep or an
 * investigation read them through the ledger. A part read of a session is not placed on a segment.
 */
export function materialRead(m: Material, reads: ReadTally): 'whole' | 'part' | null {
  if (m.kind === 'commits') return reads.ledgerCommits ? 'whole' : null;
  const file = extentOf(reads.files.get(pathKey(m.ref)));
  const sources = m.sourceIds.filter((id) => reads.sources.has(id)).length;
  if (m.kind === 'session') {
    const colon = m.group.indexOf(':');
    const ledger = reads.sessions.size && colon > 0 ? extentOf(reads.sessions.get(sessionKey(m.group.slice(0, colon), m.group.slice(colon + 1), m.ref))) : null;
    return file === 'whole' || sources > 0 || ledger === 'whole' ? 'whole' : null;
  }
  if (file === 'whole' || (sources > 0 && sources === m.sourceIds.length)) return 'whole';
  return file === 'part' || sources > 0 ? 'part' : null;
}

const kindLabel = (m: { kind: string }): string => (m.kind === 'commits' ? 'commit' : m.kind);

/** The levels that leave a material's meaning unread: what `historyNotOrganized` counts among the history tier. */
const NOT_ORGANIZED_LEVELS: ReadonlySet<OrganizingLevel> = new Set(['Indexed', 'Sampled', 'Not organized']);

/**
 * Every material's organizing level (§1.11), counted by level and kind, and the sampling rules that apply — the
 * coverage's table during the takeover and after it (CKC-13 AC-8); beside it, the materials read only in part, and how
 * many history-tier materials are still not organized. `pendingKeys`: the materials that wait (`clerkPending`).
 */
export function clerkLevels(store: ProjectStore, project: Project, pendingKeys: ReadonlySet<string>, materials?: readonly Material[]): {
  levels: LevelCount[]; sampled: TakeoverStatus['sampled']; levelOf: ReadonlyMap<string, OrganizingLevel>; readInPart: PartReads; historyNotOrganized: number;
} {
  const all = materials ?? listMaterials(store, project);
  const plan = store.plans.get(PLAN_ID) ?? null;
  const reads = tallyReads(store.jobs.all(), project);
  const drafted = new Set(store.drafts.all().flatMap((d) => [d.session.file, d.session.sessionId].filter(Boolean).map((x) => (x.includes('\\') || x.includes('/') ? pathKey(x) : x))));
  const levelOf = new Map<string, OrganizingLevel>();
  const readOf = new Map<string, 'whole' | 'part'>();
  const open: Material[] = [];
  for (const m of all) {
    const read = materialRead(m, reads);
    if (read) readOf.set(m.key, read);
    let level: OrganizingLevel | null = null;
    if (ruleSettlement(store, plan, m)) level = 'Settled by rule';
    else if (pendingKeys.has(m.key)) level = 'Not organized';
    else if (read === 'whole') level = 'Read in full';
    else if (m.kind === 'session' && (drafted.has(pathKey(m.ref)) || drafted.has(m.group.slice(m.group.indexOf(':') + 1)))) level = 'Conclusions only';
    if (level) levelOf.set(m.key, level); else open.push(m);
  }
  // A series of like files whose samples were read in full: the rest follow them (§1.11 `Sampled`).
  const groups = sampledGroups(store, project, all.filter((m) => m.kind === 'file' && !pendingKeys.has(m.key) && levelOf.get(m.key) !== 'Settled by rule'));
  const usedGroups = groups.filter((g) => g.samples.every((k) => levelOf.get(k) === 'Read in full') && g.members.some((k) => !levelOf.has(k)));
  for (const g of usedGroups) for (const k of g.members) if (!levelOf.has(k)) levelOf.set(k, 'Sampled');
  for (const m of open) if (!levelOf.has(m.key)) levelOf.set(m.key, 'Indexed');
  const counts = new Map<OrganizingLevel, { byKind: Record<string, number>; materials: number; chars: number }>(ORGANIZING_LEVEL.map((l) => [l, { byKind: {}, materials: 0, chars: 0 }]));
  for (const m of all) {
    const c = counts.get(levelOf.get(m.key)!)!;
    c.byKind[kindLabel(m)] = (c.byKind[kindLabel(m)] ?? 0) + 1;
    c.materials += 1;
    c.chars += m.chars;
  }
  // What the rules took out of the listed material altogether is settled by them too (a recovery-only place).
  for (const m of settledAwayMaterials(store, project, new Set(all.map((x) => x.key)))) {
    const c = counts.get('Settled by rule')!;
    c.byKind.file = (c.byKind.file ?? 0) + 1;
    c.materials += 1;
    c.chars += m.chars;
  }
  // A file over the size intake reads of one file has no sources, so it is no material above: counted from what the
  // coverage records as skipped (§1.11 `Skipped: too large`, D105). Not pending, not a failure, nothing read of it.
  const tooLarge = skippedOf(store.coverage.scopes).length;
  if (tooLarge) { const c = counts.get(SKIPPED_TOO_LARGE)!; c.byKind.file = tooLarge; c.materials = tooLarge; }
  // Beside the levels: what a job read only in part, and the level it keeps (§1.11 has none for a part read).
  const readInPart = { materials: 0, byKind: {} as Record<string, number>, chars: 0, byLevel: {} as Record<string, number> };
  let historyNotOrganized = 0;
  for (const m of all) {
    const level = levelOf.get(m.key)!;
    if (m.tier === 'history' && NOT_ORGANIZED_LEVELS.has(level)) historyNotOrganized += 1;
    if (readOf.get(m.key) !== 'part' || level === 'Read in full') continue;
    readInPart.materials += 1;
    readInPart.byKind[kindLabel(m)] = (readInPart.byKind[kindLabel(m)] ?? 0) + 1;
    readInPart.chars += m.chars;
    readInPart.byLevel[level] = (readInPart.byLevel[level] ?? 0) + 1;
  }
  return {
    levels: [...counts].map(([level, c]) => ({ level, ...c })),
    sampled: usedGroups.map((g) => ({ rule: g.rule, samples: g.samples, members: g.members.length })),
    levelOf, readInPart, historyNotOrganized,
  };
}
