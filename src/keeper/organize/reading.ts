/**
 * What a deepening's material is and what was read of it (Spec §3.3, §3.7), as the coverage check, the depth question and
 * the views of the rounds from before D99 still use it:
 * - the organizing plan's Read closely, resolved through the ledger (`readCloselyOf`, `readCloselyNow`; Spec §3.7, D62):
 *   what the coverage check plans, and what the depth question counts on each path (`closelyPath`);
 * - what a brief names (`namedInBrief`), the directories the project's rules settle (`settlingDirs`);
 * - what a tally of the recorded reads read of each material (`readsOf`): whole, in part, not at all;
 * - a deepening from before D99, read in reading assignments (`RoundReading`): its paths as the Keeper view shows them
 *   (`pathReadingOf`, `readingBasisText`).
 * D99 replaced the reading assignments with the main agent's lanes and the coverage check (coverage-tools.ts): the program
 * no longer places, sizes, packs, queues or chases a deepening's reading, so that machinery is gone (git keeps it).
 */
import { join, relative } from 'node:path';
import type { ClerkRound, ReadingAssignment, ReadingCategory, ReadingMaterial, RoundReading, RoundReadingPath } from '../../model/k-types.ts';
import type { KeeperJob, OrganizingPlan, OrganizingPlanContent, PathReading, Project } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import type { Ledger } from '../../ledger/index.ts';
import { isWithin, pathKey } from '../../util/paths.ts';
import { coversAll, mergeRanges } from '../bounds/reads.ts';
import { tallyReads, type FileReads, type ReadTally } from './clerk-coverage.ts';
import { DEEPENING_PATHS, type SweepKind } from './clerk-prompts.ts';

// ───────────────────────── what a deepening's material is ─────────────────────────

/** The category a kind of question counted by the ledger's totals plans whole (`kindTotals` counts it as its materials). */
export const KIND_CATEGORY: Readonly<Record<SweepKind, ReadingCategory>> = {
  [DEEPENING_PATHS[0]]: 'sessions', [DEEPENING_PATHS[1]]: 'document versions', [DEEPENING_PATHS[2]]: 'commits', [DEEPENING_PATHS[3]]: 'code files',
} as Record<SweepKind, ReadingCategory>;

/** The directories the project's own material rules settle (§1.15: obsolete, reference only, recovery only). */
export function settlingDirs(store: ProjectStore): string[] {
  const settling = new Set(['Obsolete', 'Reference only', 'Recovery only']);
  return [...new Set(store.rules.filter((r) => r.group === 'Material rules' && r.validity === 'Current' && settling.has(r.category ?? ''))
    .flatMap((r) => r.appliesTo).map((a) => a.trim().replace(/\\/g, '/')).filter((a) => /^[\w.-]+(\/[\w.-]+)*\/?$/.test(a) && !/\.\w+$/.test(a)))];
}
export const underAny = (dirs: readonly string[], path: string): boolean => dirs.some((d) => { const x = d.replace(/\/+$/, ''); return path === x || path.startsWith(`${x}/`); });

/** A commit read by a hash that is the planned commit, or a prefix of it long enough to name one. */
export const sameCommit = (read: string, planned: string): boolean => read.length >= 7 && planned.toLowerCase().startsWith(read.toLowerCase());

/**
 * The paths and commits a brief names: `docs/plan/`, `src/app.ts:12`, `a1b2c3d`. Hashes only count when the ledger knows
 * them. `absolute`: the absolute paths it names (`C:\…\sessions`), which can name the sessions' logs — the ledger counts
 * the sessions whose log is there, and a session a hex id names by the start of its native id. The organizing plan's
 * entries are read the same way (`readCloselyOf`, `planRank`).
 */
export function namedInBrief(markdown: string): { paths: string[]; commits: string[]; absolute: string[] } {
  const text = markdown.replace(/https?:\/\/\S+/g, ' ');
  const paths = new Set<string>();
  for (const m of text.matchAll(/(?<![\w./@-])((?:[\w.-]+\/)+[\w.-]*|[\w.-]+\.(?:md|markdown|txt|ts|tsx|js|jsx|mjs|cjs|dart|py|go|rs|java|kt|swift|json|ya?ml|toml|sh))(?![\w/-])/g)) {
    const p = m[1]!.replace(/[.,;:)]+$/, '');
    if (p.length > 1 && !/^\.+\/?$/.test(p)) paths.add(p);
  }
  const commits = new Set<string>();
  for (const m of text.matchAll(/(?<![\w/-])([0-9a-f]{7,40})(?![\w/-])/g)) if (/[a-f]/.test(m[1]!) && /\d/.test(m[1]!)) commits.add(m[1]!);
  const absolute = new Set<string>();
  for (const m of text.matchAll(/(?<![\w])([A-Za-z]:[\\/](?:[\w.$-]+[\\/]?)+)/g)) absolute.add(m[1]!.replace(/[\\/.]+$/, ''));
  return { paths: [...paths], commits: [...commits], absolute: [...absolute] };
}

// ───────────────────────── the organizing plan: what is read closely, and what first (§3.7, D62) ─────────────────────────
//
// The plan orientation's round sets, which the owner sees in Project scope and corrects in conversation (Spec §3.7; D62,
// the owner: 「之后的整理照它执行」). What it says to read closely is planned by the coverage check and counted by the depth
// question, under Focused too.

/** The organizing plan's id: one plan per project (§3.7). */
export const ORGANIZING_PLAN_ID = 'organizing-plan';

/** The kind of question a category of material is read for when no brief names it: the inverse of `KIND_CATEGORY`. */
const CATEGORY_KIND = Object.fromEntries(Object.entries(KIND_CATEGORY).map(([kind, category]) => [category, kind])) as Readonly<Record<ReadingCategory, SweepKind>>;

/** A deepening's materials as the ledger names them: document versions (with their paths), code files (with their lines), commits, sessions. */
export interface NamedMaterials {
  readonly versions: readonly { readonly key: string; readonly path: string }[];
  readonly codeFiles: readonly { readonly key: string; readonly lines: number }[];
  readonly commits: readonly string[];
  readonly sessions: readonly string[];
}

/** What the organizing plan says to read closely, as the ledger has it (`readCloselyOf`). */
export interface ReadClosely extends NamedMaterials {
  /** Each material's entry in the plan, in the plan's words (a commit by `commit:<hash>`): what it is read closely for. */
  readonly what: ReadonlyMap<string, string>;
  /** Targets the ledger has nothing for: the steps still get them, in words, in the plan block of their prompts. */
  readonly unresolved: readonly string[];
}

const NO_MATERIALS: NamedMaterials = { versions: [], codeFiles: [], commits: [], sessions: [] };
const slashed = (p: string): string => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
const isAbsolutePath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
/** A relative path at or under a directory (or the file itself), whatever its slashes and case. */
const atOrUnder = (path: string, dir: string): boolean => {
  const d = slashed(dir).toLowerCase();
  const p = slashed(path).toLowerCase();
  return d.length > 0 && (p === d || p.startsWith(`${d}/`));
};
/** A target as the plan writes it, without the quotes, backticks and trailing punctuation around it. */
const bareTarget = (t: string): string => t.trim().replace(/^[`'"“”‘’「」]+|[`'"“”‘’「」]+$/g, '').replace(/[.,;:)]+$/, '').trim();

/** The folder every repository of the ledger is in — where the plan's relative paths start; null when they share none. */
function commonRoot(repos: readonly { readonly path: string }[]): string | null {
  const split = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  if (!repos.length) return null;
  const first = split(repos[0]!.path);
  let n = first.length;
  for (const r of repos.slice(1)) {
    const parts = split(r.path);
    let i = 0;
    while (i < n && i < parts.length && parts[i]!.toLowerCase() === first[i]!.toLowerCase()) i++;
    n = i;
  }
  // A bare drive, or the filesystem's root, is no project's folder.
  const root = first.slice(0, n);
  return root.length >= 2 && !(root.length === 2 && root[0] === '' && root[1] === '') ? root.join('/') : null;
}

/**
 * The paths a target can be inside the ledger's repositories: as the plan writes it (relative to its repository, the way a
 * single-repository project names its files), and — taken relative to the project's folder, or absolute — as the path in
 * the repository that holds it (a nested `app/` repository's `src/…` for `app/src/…`).
 */
function targetPaths(repos: readonly { readonly path: string }[], root: string | null, target: string): string[] {
  const out = new Set<string>();
  const absolute = isAbsolutePath(target);
  if (!absolute) out.add(slashed(target));
  const abs = absolute ? target : root ? join(root, ...slashed(target).split('/')) : null;
  if (abs) for (const r of repos) if (isWithin(r.path, abs)) { const rel = slashed(relative(r.path, abs)); if (rel) out.add(rel); }
  return [...out].filter(Boolean);
}

/**
 * The commits a branch holds that the trunk did not have — a branch named as the project names it, `feature/x`, or a
 * remote's `origin/feature/x` by what follows its remote: those still only on it, or, merged, those its merge brought in.
 */
function branchCommits(ledger: Ledger, name: string): string[] {
  let rows: { repo: string; name: string; tip: string }[];
  try {
    rows = (ledger.db.prepare('SELECT repo, name, tip FROM branches').all() as { repo: string; name: string; tip: string }[]).filter((b) => b.name === name || b.name.endsWith(`/${name}`));
  } catch { return []; }
  if (!rows.length) return [];
  const all = ledger.commitsByHash(ledger.allCommits());
  const groupOf = new Map(all.map((c) => [c.hash, c.group]));
  const groups = new Set<string>();
  for (const b of rows) {
    const own = `branch:${b.repo}:${b.name}`;
    if (all.some((c) => c.group === own)) groups.add(own);
    else { const g = groupOf.get(b.tip); if (g?.startsWith('merge:')) groups.add(g); }
  }
  return all.filter((c) => groups.has(c.group)).map((c) => c.hash);
}

/** One target through the ledger: a path's document versions and code files, a commit, a branch's commits, the sessions whose log is there or whose id it begins. */
function resolveTarget(ledger: Ledger, repos: readonly { readonly path: string }[], root: string | null, target: string): NamedMaterials {
  const t = bareTarget(target);
  if (!t) return NO_MATERIALS;
  const hash = /^[0-9a-f]{7,40}$/i.test(t);
  const named = ledger.named({ paths: hash ? [] : targetPaths(repos, root, t), commits: hash ? [t] : [] });
  let sessions: string[] = [];
  try { sessions = ledger.namedSessions(isAbsolutePath(t) ? [t] : [], /^[\w-]{8,}$/.test(t) ? [t] : []); } catch { sessions = []; }
  const found = named.versions.length + named.codeFiles.length + named.commits.length + sessions.length > 0;
  return { versions: named.versions, codeFiles: named.codeFiles, commits: found || isAbsolutePath(t) ? named.commits : branchCommits(ledger, t), sessions };
}

/**
 * What the organizing plan says to read closely (Spec §3.7, D62), resolved through the ledger to the materials a deepening
 * plans. Each entry's targets — a directory or file as the project names it, a commit, a branch, a session's log or id; an
 * entry with no targets, by the paths and commits its words name. What the project's rules settle is left out (§1.15:
 * judged by the rule, not read closely) — the directories its material rules settle, and what the plan itself says a rule
 * settles — unless the target itself points into it.
 */
export function readCloselyOf(ledger: Ledger, store: ProjectStore, plan: OrganizingPlanContent | null | undefined = store.plans.get(ORGANIZING_PLAN_ID)): ReadClosely {
  const versions = new Map<string, string>();
  const code = new Map<string, number>();
  const commits = new Set<string>();
  const sessions = new Set<string>();
  const what = new Map<string, string>();
  const unresolved: string[] = [];
  const result = (): ReadClosely => ({ versions: [...versions].map(([key, path]) => ({ key, path })), codeFiles: [...code].map(([key, lines]) => ({ key, lines })), commits: [...commits], sessions: [...sessions], what, unresolved });
  if (!plan?.readClosely.length) return result();
  const repos = ledger.repos();
  const root = commonRoot(repos);
  const repoIds = repos.map((r) => r.id).sort((a, b) => b.length - a.length);
  const settling = [...settlingDirs(store), ...plan.byRule.filter((e) => store.rules.get(e.ruleId)?.validity === 'Current').flatMap((e) => e.targets)];
  for (const entry of plan.readClosely) {
    const inWords = entry.targets.length ? null : namedInBrief(entry.what);
    const targets = inWords ? [...inWords.paths, ...inWords.commits, ...inWords.absolute] : entry.targets;
    // An entry in words alone: the steps have it in the plan block, and orientation names its material in a brief.
    if (!targets.length) { unresolved.push(entry.what); continue; }
    for (const raw of targets) {
      const found = resolveTarget(ledger, repos, root, raw);
      if (!found.versions.length && !found.codeFiles.length && !found.commits.length && !found.sessions.length) { unresolved.push(raw); continue; }
      const own = targetPaths(repos, root, bareTarget(raw));
      const settled = (rel: string) => settling.some((d) => atOrUnder(rel, d) && !own.some((t) => atOrUnder(t, d)));
      const note = (key: string) => { if (!what.has(key)) what.set(key, entry.what); };
      for (const v of found.versions) if (!settled(v.path)) { versions.set(v.key, v.path); note(v.key); }
      for (const f of found.codeFiles) {
        const repo = repoIds.find((id) => f.key.startsWith(`${id}:`));
        if (settled(repo ? f.key.slice(repo.length + 1) : f.key)) continue;
        code.set(f.key, f.lines);
        note(f.key);
      }
      for (const c of found.commits) { commits.add(c); note(`commit:${c}`); }
      for (const s of found.sessions) { sessions.add(s); note(s); }
    }
  }
  return result();
}

/**
 * `readCloselyOf` for the plan as it stands, kept while the ledger connection, the plan and the rules stay the same: the
 * coverage and a deepening's reading ask after every job, and a target the ledger has no path for is looked up among
 * the branches, which reads every commit. A rebuilt ledger is a new connection, so what it adds is found.
 */
const closelySeen = new WeakMap<Ledger, Map<string, ReadClosely>>();
export function readCloselyNow(ledger: Ledger, store: ProjectStore, plan: OrganizingPlan | null | undefined = store.plans.get(ORGANIZING_PLAN_ID)): ReadClosely {
  if (!plan?.readClosely.length) return readCloselyOf(ledger, store, plan);
  const rules = store.rules.all().reduce((at, r) => (r.updatedAt > at ? r.updatedAt : at), '');
  // What resolving reads: the entries and what the rules settle.
  const key = `${store.dir}\0${JSON.stringify([plan.readClosely, plan.byRule])}\0${store.rules.size}\0${rules}`;
  let seen = closelySeen.get(ledger);
  if (!seen) { seen = new Map(); closelySeen.set(ledger, seen); }
  let hit = seen.get(key);
  if (!hit) {
    if (seen.size >= 16) seen.clear();
    hit = readCloselyOf(ledger, store, plan);
    seen.set(key, hit);
  }
  return hit;
}

/** A path as what the plan says to read closely is placed on it (`closelyPath`). */
export interface PathSlot {
  /** Its kinds of question: those it is counted whole for, or those its name begins with. */
  readonly kinds: readonly SweepKind[];
  /** What its brief names, by material key (a commit's `commit:<hash>`). */
  readonly named: ReadonlySet<string>;
  /** The categories it plans whole (a path counted by the ledger's totals for its kinds of question). */
  readonly whole: ReadonlySet<ReadingCategory>;
  /** The groups it plans material of already (a document's versions stay on one path). */
  readonly groups?: ReadonlySet<string>;
}

/**
 * The path a material the plan says to read closely goes on (Spec §3.7: each target in the brief of the right path): the
 * one that plans the rest of its document already; else one that plans it already — its brief names it, or it plans the
 * material's whole category (what the rules settle, `settled`, is outside that); else the first path of its kind of
 * question — a document version the document chain's, a code file the code's, a commit the process and checks', a
 * session the owner's meaning's; else the first path. -1 with no path.
 */
export function closelyPath(slots: readonly PathSlot[], m: { readonly key: string; readonly category: ReadingCategory; readonly group?: string; readonly settled?: boolean }): number {
  if (m.group) { const i = slots.findIndex((s) => s.groups?.has(m.group!)); if (i >= 0) return i; }
  const plans = slots.findIndex((s) => s.named.has(m.key) || (!m.settled && s.whole.has(m.category)));
  if (plans >= 0) return plans;
  const kind = CATEGORY_KIND[m.category];
  const ofKind = slots.findIndex((s) => s.kinds.includes(kind));
  return ofKind >= 0 ? ofKind : slots.length ? 0 : -1;
}

/** How a Focused deepening from before D99 counted its paths (§3.7): only what the organizing plan says to read closely was planned. */
export const FOCUSED_READING = 'Focused: only what the organizing plan says to read closely is planned on this path, to be read in full; the sweep answers the rest of its brief at the Focused depth';
/** A reading planned for a Focused deepening: its paths say so. */
export const isFocusedReading = (reading: RoundReading | null | undefined): boolean => Boolean(reading?.paths.some((p) => p.basis.startsWith(FOCUSED_READING)));

// ───────────────────────── what was read of each material ─────────────────────────

/** How far a material was read: `measure` grows with every line, message or commit more that reached a step. */
export interface MaterialRead {
  readonly outcome: 'whole' | 'part' | 'none';
  readonly measure: number;
  /** A file, a version or a session read in part: what of it was read (lines, or message positions), and of how many. */
  readonly ranges?: readonly [number, number | null][];
  readonly of?: number | null;
}

const NONE: MaterialRead = { outcome: 'none', measure: 0 };
const WHOLE = 1e12;

function mergedReads(list: readonly FileReads[]): FileReads | null {
  if (!list.length) return null;
  return {
    whole: list.some((f) => f.whole), ranges: list.flatMap((f) => f.ranges), lines: list.reduce<number | null>((n, f) => (f.lines === null ? n : Math.max(n ?? 0, f.lines)), null), part: list.some((f) => f.part),
  };
}
const coveredCount = (ranges: readonly (readonly [number, number | null])[], total: number | null): number =>
  mergeRanges(ranges).reduce((n, [a, b]) => n + Math.max(0, (b ?? total ?? a) - a + 1), 0);
const within = (need: readonly (readonly [number, number])[], have: readonly (readonly [number, number | null])[]): boolean => {
  const merged = mergeRanges(have);
  return need.every(([a, b]) => merged.some(([x, y]) => x <= a && (y === null || y >= b)));
};

/**
 * What a tally read of each planned material (the program's count, from the steps' recorded reads). A version older than
 * the next counts as read whole when its own lines were read and the version after it was read whole.
 */
export function readsOf(materials: readonly ReadingMaterial[], tally: ReadTally): Map<string, MaterialRead> {
  const byKey = new Map(materials.map((m) => [m.key, m]));
  const out = new Map<string, MaterialRead>();
  const fileReads = (m: ReadingMaterial) => (m.file ? tally.files.get(pathKey(m.file)) ?? null : null);
  const historyReads = (m: ReadingMaterial) => (m.file && m.rev ? mergedReads((tally.versions.get(pathKey(m.file)) ?? []).filter((v) => sameCommit(v.rev, m.rev!)).map((v) => v.reads)) : null);
  const of = (m: ReadingMaterial): MaterialRead => {
    const had = out.get(m.key);
    if (had) return had;
    out.set(m.key, NONE);   // a cycle of `next` (none is made) reads as nothing
    let r: MaterialRead = NONE;
    if (m.category === 'commits') {
      r = m.rev && [...tally.commits].some((c) => sameCommit(c, m.rev!)) ? { outcome: 'whole', measure: WHOLE } : NONE;
    } else if (m.category === 'sessions') {
      const s = m.session ? tally.sessions.get(m.session) ?? null : null;
      const log = fileReads(m);
      const total = m.messages ?? s?.lines ?? null;
      if (log?.whole || (s && (s.whole || (s.ranges.length > 0 && coversAll(s.ranges, total))))) r = { outcome: 'whole', measure: WHOLE };
      else if (s && (s.ranges.length || s.part)) r = { outcome: 'part', measure: Math.max(1, coveredCount(s.ranges, total)), ranges: mergeRanges(s.ranges), of: total };
      else if (log && (log.ranges.length || log.part)) r = { outcome: 'part', measure: 1 };
    } else {
      const reads = [m.current || m.category === 'code files' ? fileReads(m) : null, m.category === 'document versions' ? historyReads(m) : null].filter((x): x is FileReads => x !== null);
      const all = mergedReads(reads);
      const lines = m.lines ?? all?.lines ?? null;
      const whole = reads.some((f) => f.whole || (f.ranges.length > 0 && coversAll(f.ranges, f.lines ?? m.lines ?? null)));
      const next = m.next ? byKey.get(m.next) : undefined;
      const own = historyReads(m);
      const throughNext = Boolean(m.diff && next && of(next).outcome === 'whole' && (m.diff.length === 0 || (own && (own.whole || within(m.diff, own.ranges)))));
      if (whole || throughNext) r = { outcome: 'whole', measure: WHOLE };
      else if (all && (all.ranges.length || all.part)) r = { outcome: 'part', measure: Math.max(1, coveredCount(all.ranges, lines)), ranges: mergeRanges(all.ranges), of: lines };
    }
    out.set(m.key, r);
    return r;
  };
  for (const m of materials) of(m);
  return out;
}

// ───────────────────────── the jobs whose reads count ─────────────────────────

/** A job and every job it sent, and theirs: what a step read includes what it sent others to read. */
export function withDescendants(store: ProjectStore, jobs: readonly KeeperJob[]): KeeperJob[] {
  const out = [...jobs];
  const seen = new Set(out.map((j) => j.id));
  for (let i = 0; i < out.length; i++) {
    for (const c of store.jobs.filter((j) => j.parentJobId === out[i]!.id)) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
  }
  return out;
}

/** The deep-sweep jobs of a path in a round from before D99 (its assignments, whatever became of them). */
export function pathJobs(store: ProjectStore, roundId: string, path: string): KeeperJob[] {
  return store.jobs.filter((j) => j.step?.roundId === roundId && j.step.kind === 'dig' && (j.step.path ?? j.scope.label) === path);
}

/** A path's basis, when the organizing plan changed while a round from before D99 ran and its reading took it up (`readingBasisText`). */
const PLAN_CHANGED = ' · while the round ran, ';

// ───────────────────────── the path's reading, counted ─────────────────────────

/** A path's reading of a deepening from before D99, as the Keeper view shows it: planned, read whole, recorded in part or not read with why, open, its assignments. */
export function pathReadingOf(store: ProjectStore, project: Project, round: ClerkRound, p: RoundReadingPath, known?: ReadonlyMap<string, MaterialRead>): PathReading {
  const reads = known ?? readsOf(p.materials, tallyReads(withDescendants(store, pathJobs(store, round.id, p.path)), project));
  const accounted = new Map(p.accounted.map((a) => [a.key, a]));
  const labelOf = new Map(p.materials.map((m) => [m.key, m.label]));
  let whole = 0, part = 0, notRead = 0, open = 0;
  for (const m of p.materials) {
    if (reads.get(m.key)?.outcome === 'whole') whole++;
    else if (accounted.get(m.key)?.outcome === 'part') part++;
    else if (accounted.get(m.key)?.outcome === 'none') notRead++;
    else open++;
  }
  const status = (a: ReadingAssignment) => (a.jobId ? store.jobs.get(a.jobId)?.status ?? 'Queued' : 'Queued');
  const count = (pred: (s: string) => boolean) => p.assignments.filter((a) => pred(status(a))).length;
  return {
    planned: p.materials.length, whole, part, notRead, open,
    assignments: {
      total: p.assignments.length, done: count((s) => s === 'Done'), running: count((s) => s === 'Running'), queued: count((s) => s === 'Queued' || s === 'Paused' || s === 'Waiting for quota'),
      failed: count((s) => s === 'Failed' || s === 'Stopped'), followUps: p.assignments.filter((a) => a.followUpOf.length > 0).length,
    },
    accounted: p.accounted.filter((a) => reads.get(a.key)?.outcome !== 'whole').map((a) => ({ key: a.key, label: labelOf.get(a.key) ?? a.key, outcome: a.outcome, why: a.why, by: a.by })),
  };
}

/**
 * The words under the progress table of a deepening from before D99: how its reading was counted, how the assignments were
 * sized, how the organizing plan steered it (§3.7, D62), and what a change of the plan while the round ran added.
 */
export function readingBasisText(reading: RoundReading): string {
  const planned = isFocusedReading(reading)
    ? `Under Focused only what the organizing plan says to read closely is planned — each on its path, split into reading assignments that run at once on the lanes — and each sweep answers the rest of its brief at the Focused depth; ${reading.budget.basis}.`
    : `Each path's planned material is split into reading assignments that run at once on the lanes; ${reading.budget.basis}.`;
  const changed = reading.paths.filter((p) => p.basis.includes(PLAN_CHANGED)).map((p) => `${p.path}: ${p.basis.split(PLAN_CHANGED).slice(1).join('; ')}`);
  return `${planned} A material counts as read whole when a step's recorded reads show all of it — an older version of a document when its own lines (what it changed against the version after it) were read and that version was read whole. What an assignment did not read goes into a follow-up; a follow-up that reads nothing more of its list ends the chase, and what it left is recorded as read in part or not read, with why. The cross-check starts once every planned material is read whole or recorded so. The reading follows the organizing plan as it stands at each pass: what it says to read closely is planned and read in full — on the path that plans the rest of it, else the one whose brief names it, else the first of its kind of question — and its focus, then its order, decide which assignments are queued first; a change of the plan while the round runs applies to what is not queued yet.${changed.length ? ` Taken up while this round ran — ${changed.join(' · ')}.` : ''}`;
}
