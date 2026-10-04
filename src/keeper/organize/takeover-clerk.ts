/**
 * The takeover by the clerk method (Spec v3.0 §3.7): the first usable round's own figures, what a deepening reads path
 * by path — counted from the ledger, by material category, with what the organizing plan says to read closely (D62) —
 * the three depth options with an estimate on a stated basis, the depth question's note, and the deepening's progress
 * path by path with what each path actually read against its plan (CKC-13 AC-8). Every number comes from the ledger, the
 * jobs or the assets; no model writes one.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ClerkRound, ReadingCategory, ReadingMaterial, RoundDoc, StageEntry } from '../../model/k-types.ts';
import type { DeepeningActual, DeepeningPlan, DeepeningReads, DepthOption, KeeperJob, OwnerWordsStep, Project, TraceEntry } from '../../model/types.ts';
import { OWNER_WORDS } from '../../model/vocab.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { readJsonLines } from '../../store/json-file.ts';
import type { Ledger } from '../../ledger/index.ts';
import { ownerUtterances } from '../../sources/sessions/utterances.ts';
import { isWithin, pathKey } from '../../util/paths.ts';
import { DEEPENING_PATHS, sweepKindsOf, type SweepKind } from './clerk-prompts.ts';
import { roundDepth } from './takeover-state.ts';
import { extentOf, tallyReads, type ReadTally } from './clerk-coverage.ts';
import { currentDocuments, oneVersionPerDocument } from './coverage-tools.ts';
import {
  closelyPath, KIND_CATEGORY, namedInBrief, ORGANIZING_PLAN_ID, pathJobs, pathReadingOf, readCloselyNow, readsOf as materialReads, sameCommit, settlingDirs, underAny,
  type MaterialRead, type PathSlot, type ReadClosely,
} from './reading.ts';

/** §3.7 stage 4: the four paths a deepening digs, each over the whole history (the four kinds of question, clerk-prompts.ts). */
export { DEEPENING_PATHS };
/** The ledger's file languages that are documents: counted with the document chain, not as code. */
const DOCUMENT_LANGUAGES = new Set(['markdown', 'text']);

const minutesOf = (from: string | null | undefined, to: string | null | undefined): number | null =>
  from && to ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000)) : null;

/**
 * What a round's jobs read, from the calls the runtime recorded on each job (`JobStep.reads`; a step recorded before
 * reads were kept counts by its target): files read whole and in part — by the file tool, the shell or the ledger's
 * document tools — sources, ledger queries.
 */
function readsOf(jobs: readonly KeeperJob[], project: Project): { whole: number; part: number; sources: number; ledgerQueries: number } {
  const tally = tallyReads(jobs, project);
  let whole = 0, part = 0;
  for (const f of tally.files.values()) { const e = extentOf(f); if (e === 'whole') whole += 1; else if (e === 'part') part += 1; }
  let ledgerQueries = 0;
  for (const j of jobs) for (const s of j.steps) if (!s.isError && s.tool.startsWith('pk_ledger_')) ledgerQueries++;
  return { whole, part, sources: tally.sources.size, ledgerQueries };
}

/** The first usable round's own figures: its time, its cost, what it read, and its owner's-words step (D37). */
export function firstUsableFigures(store: ProjectStore, round: ClerkRound | undefined, ledger: Ledger | null, project?: Project): {
  minutes: number | null; cost: number | null; byKind: Record<string, number>; itemsRead: number; ownerWords: OwnerWordsStep | null;
} {
  if (!round) return { minutes: null, cost: null, byKind: {}, itemsRead: 0, ownerWords: null };
  const jobs = store.jobs.filter((j) => j.step?.roundId === round.id);
  const model = jobs.filter((j) => j.agent !== 'program');
  const costs = model.map((j) => j.usage.cost);
  const cost = costs.length && costs.every((c) => c != null) ? costs.reduce((n, c) => n + c!, 0) : null;
  const reads = readsOf(model, project ?? { locations: [] } as unknown as Project);
  const draftJobs = model.filter((j) => j.step!.kind === 'session-drafts');
  const draftJobIds = new Set(draftJobs.map((j) => j.id));
  const drafts = store.drafts.filter((d) => d.jobId !== null && draftJobIds.has(d.jobId));
  const lines = drafts.flatMap((d) => d.ownerLines);
  const byKind: Record<string, number> = {};
  if (reads.whole) byKind['files read in full'] = reads.whole;
  if (reads.part) byKind['files read in part'] = reads.part;
  if (reads.sources) byKind['sources read'] = reads.sources;
  if (reads.ledgerQueries) byKind['ledger queries'] = reads.ledgerQueries;
  if (lines.length) byKind["owner's lines drafted"] = lines.length;
  let ownerWords: OwnerWordsStep | null = null;
  if (draftJobs.length) {
    const startedAt = draftJobs.map((j) => j.startedAt ?? j.queuedAt).sort()[0]!;
    const endedAt = draftJobs.map((j) => j.endedAt ?? j.startedAt ?? j.queuedAt).sort().pop()!;
    const { total, totalChars } = ownerMessagesTotal(store, ledger);
    ownerWords = {
      startedAt, endedAt, minutes: minutesOf(startedAt, endedAt) ?? 0, calls: draftJobs.length,
      utterances: lines.length, chars: lines.reduce((n, l) => n + l.text.length, 0), total, totalChars,
      items: ownerWordsItemsOf(store, round, jobs),
    };
  }
  return { minutes: minutesOf(round.startedAt, round.endedAt), cost, byKind, itemsRead: reads.whole + reads.part + reads.sources + lines.length, ownerWords };
}

/**
 * How many messages the owner wrote in the project's sessions, and their characters — the "of Y" of the owner's-words
 * step (D37). The ledger's count when it has read the sessions; else the program's own reading of the same session
 * logs, the one the drafts step takes the owner's words from (`ownerUtterances`), without the Keeper conversation, which
 * the ledger does not hold either. It used to be 0 whenever the ledger was not there, which read "12 of 0" (QC AY).
 */
function ownerMessagesTotal(store: ProjectStore, ledger: Ledger | null): { total: number; totalChars: number } {
  const all = ledger ? ledger.ownerWords({ limit: 1 }) : null;
  if (all && typeof all !== 'string' && all.total > 0) return { total: all.total, totalChars: all.totalChars };
  const set = ownerUtterances(store);
  if (typeof set === 'string') return { total: 0, totalChars: 0 };
  const own = set.utterances.filter((u) => !u.headless && u.host !== 'pi');
  return { total: own.length, totalChars: own.reduce((n, u) => n + u.text.length, 0) };
}

/** The Owner's words items a round's jobs wrote, from the store's trace, read again only when the trace grew. */
const ownerItemsSeen = new Map<string, { size: number; n: number }>();

/**
 * How many `Owner's words` items the round wrote (the skeleton writes them from the drafts' decisions and
 * confirmations, §3.3): what the owner's-words step's "wrote N Owner's words items" says. It used to count the session
 * drafts instead, which are the step's ground, not its items (QC AY).
 */
function ownerWordsItemsOf(store: ProjectStore, round: ClerkRound, jobs: readonly KeeperJob[]): number {
  const file = join(store.dir, 'trace.jsonl');
  let size = 0;
  try { size = statSync(file).size; } catch { return 0; }
  const key = `${store.dir}\0${round.id}`;
  const seen = ownerItemsSeen.get(key);
  if (seen && seen.size === size) return seen.n;
  const jobIds = new Set([round.rootJobId, ...jobs.map((j) => j.id)]);
  const ids = new Set<string>();
  for (const e of readJsonLines<TraceEntry>(file)) if (e.op === 'put' && e.collection === 'reference' && e.jobId && jobIds.has(e.jobId)) ids.add(e.id);
  const n = [...ids].filter((id) => store.reference.get(id)?.category === OWNER_WORDS).length;
  ownerItemsSeen.set(key, { size, n });
  return n;
}

/**
 * The project's documents as they are now, one material each (Spec §3.3: 一份文档的各个旧版本不单列; §3.7: 材料按文件、提交、
 * 会话算), and those the project's own material rules settle (§1.15: obsolete, reference only, recovery only): they are
 * judged by the rule, not read closely, so the depth question counts them apart.
 */
function documentTotals(ledger: Ledger, store: ProjectStore): { documents: number; settled: number } {
  const settling = settlingDirs(store);
  const docs = currentDocuments(ledger);
  const settled = docs.filter((d) => underAny(settling, d.row.path)).length;
  return { documents: docs.length - settled, settled };
}

/** One path of a deepening with what it reads, by material category; `materials`: how many of them are read closely. */
type PathReads = DeepeningPlan['paths'][number] & { readonly materials: number };

/** §3.7: what each of the four kinds of question reads across the whole history, counted from the ledger's totals. */
function kindTotals(ledger: Ledger, store: ProjectStore): Record<(typeof DEEPENING_PATHS)[number], PathReads> {
  const cov = ledger.coverage();
  const docs = documentTotals(ledger, store);
  const sum = (f: (r: (typeof cov.repos)[number]) => number) => cov.repos.reduce((n, r) => n + f(r), 0);
  const deleted = ledger.deletedDocs({ limit: 1 });
  const deletedCount = typeof deleted === 'string' ? 0 : deleted.total;
  const code = cov.languages.filter((l) => !DOCUMENT_LANGUAGES.has(l.language));
  const codeFiles = code.reduce((n, l) => n + l.files, 0);
  const codeLines = code.reduce((n, l) => n + l.lines, 0);
  const keep = (reads: { category: string; count: number }[]) => reads.filter((r) => r.count > 0);
  const basis = "the ledger's totals for this kind of question";
  // What is read closely, kind by kind — together the materials a Full deepening reads: the documents as they are now
  // (a document is one material; its older versions are looked up by question) less what the rules settle, commits on
  // every ref, sessions, code files.
  return {
    [DEEPENING_PATHS[0]]: { path: DEEPENING_PATHS[0], basis, materials: cov.sessions.sessions, reads: keep([
      { category: 'sessions', count: cov.sessions.sessions },
      { category: "owner's messages", count: cov.sessions.ownerMessages },
      { category: 'deleted documents', count: deletedCount },
      { category: 'commits off the trunk', count: sum((r) => r.commits - r.trunkCommits) },
    ]) },
    [DEEPENING_PATHS[1]]: { path: DEEPENING_PATHS[1], basis, materials: docs.documents, reads: keep([
      { category: 'documents', count: docs.documents },
      { category: "documents settled by the project's rules (judged by the rule, not read closely)", count: docs.settled },
      { category: 'written supersessions', count: sum((r) => r.supersessions) },
    ]) },
    [DEEPENING_PATHS[2]]: { path: DEEPENING_PATHS[2], basis, materials: sum((r) => r.commits), reads: keep([
      { category: 'execution arrangements (versions)', count: sum((r) => r.arrangements.versions) },
      { category: 'verdicts in reports', count: sum((r) => r.verdicts) },
      { category: 'trunk commits', count: sum((r) => r.trunkCommits) },
      { category: 'merges', count: sum((r) => r.merges) },
    ]) },
    [DEEPENING_PATHS[3]]: { path: DEEPENING_PATHS[3], basis, materials: codeFiles, reads: keep([
      { category: `code files (${codeLines} lines)`, count: codeFiles },
    ]) },
  } as Record<(typeof DEEPENING_PATHS)[number], PathReads>;
}

/** The paths and commits a brief names (reading.ts, where the organizing plan's entries are read the same way). */
export { namedInBrief };

/** The sessions a brief names (`namedInBrief`): their logs under an absolute path it names, or their native id's start. */
function sessionsNamed(ledger: Ledger, n: ReturnType<typeof namedInBrief>): string[] {
  try { return ledger.namedSessions(n.absolute, n.commits); } catch { return []; }
}

/** The kinds of question the briefs cover, by their names (`sweepKindsOf`), and the kinds none of them does. */
function coveredKinds(briefs: readonly Pick<RoundDoc, 'path' | 'title'>[]): { covered: Set<SweepKind>; missing: SweepKind[] } {
  const covered = new Set<SweepKind>();
  for (const b of briefs) for (const k of sweepKindsOf(b.path ?? b.title)) covered.add(k);
  return { covered, missing: DEEPENING_PATHS.filter((k) => !covered.has(k)) };
}

/** The briefs a deepening is counted by: the latest finished first usable round's. */
function deepeningBriefs(store: ProjectStore) {
  const first = store.clerkRounds.filter((r) => r.kind === 'First usable' && r.status === 'Done').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return first ? store.roundDocs.filter((d) => d.roundId === first.id && d.kind === 'Brief').sort((a, b) => a.at.localeCompare(b.at)) : [];
}

/**
 * §3.7: what a Full deepening reads, path by path, by material category — "按问题清单算" (QC AY). Each sweep orientation
 * set is counted by what its brief names: the documents at or under the paths it names, each once however many versions
 * it has (D99; less what the rules settle, said apart), the source files there, the commits it names. A brief that names nothing the ledger can
 * count is counted by the ledger's totals for its kind of question; a kind no brief covers is counted by its totals too,
 * since the deepening answers each of the four kinds with a lane (CKC-23 AC-4; `pk_stage` holds the dig to it). With no
 * brief yet, the four kinds by the ledger's totals.
 *
 * `materials`, what Full reads closely, counts each material once: what several briefs name, once; and a category a
 * kind is counted whole for (all current documents, all commits, all sessions, all code files) as its ledger total,
 * which holds whatever the briefs named of it.
 */
export function deepeningPlanPaths(ledger: Ledger | null, store: ProjectStore, plan: DeepeningPlanned = deepeningPlanned(ledger, store)): { paths: PathReads[]; materials: number } {
  return { paths: plan.paths, materials: plan.materials };
}

/** What a brief names that its path reads closely: documents, one version each (less what the rules settle), code files, commits, sessions. */
interface Named {
  readonly versions: readonly { readonly key: string; readonly path: string }[];
  readonly codeFiles: readonly { readonly key: string; readonly lines: number }[];
  readonly commits: readonly string[];
  /** The sessions it names (their logs under a path it names, or their native id): the ledger's session ids. */
  readonly sessions?: readonly string[];
}
/** One path of the plan: counted from what its brief names (`named`), or from the ledger's totals for its kinds of question. */
type PlannedPath = PathReads & {
  readonly named: Named | null;
  readonly kinds: readonly SweepKind[];
  /**
   * What the organizing plan says to read closely that goes on this path (§3.7, D62; reading.ts `closelyPath`): `all` of
   * it — what a Focused deepening plans here — and `added`, what of it the path did not plan already, which Full reads too.
   */
  readonly closely?: { readonly all: Named; readonly added: Named } | null;
};
type NamedSets = { readonly versions: ReadonlySet<string>; readonly codeFiles: ReadonlySet<string>; readonly commits: ReadonlySet<string>; readonly sessions?: ReadonlySet<string> };
export interface DeepeningPlanned {
  readonly paths: PlannedPath[];
  readonly materials: number;
  readonly totals: Record<SweepKind, PathReads> | null;
  /** The kinds counted whole, by the ledger's totals: their category is planned whole. */
  readonly wholeKinds: ReadonlySet<SweepKind>;
  /** What the briefs named, and what the organizing plan adds to read closely, each once. */
  readonly named: NamedSets;
  /**
   * What the organizing plan says to read closely (reading.ts `readCloselyOf`): each material's entry in the plan's words,
   * the targets the ledger has nothing for, and what it adds to the paths — for a kind counted whole, what its rules settle.
   */
  readonly closely: Pick<ReadClosely, 'what' | 'unresolved'> & { readonly added: NamedSets };
}

const NO_NAMED: NamedSets = { versions: new Set(), codeFiles: new Set(), commits: new Set(), sessions: new Set() };
const namedSize = (n: Named | null | undefined): number => (n ? n.versions.length + n.codeFiles.length + n.commits.length + (n.sessions?.length ?? 0) : 0);

/** Two lists of what a path reads, as one, each material once. */
function mergeNamed(a: Named | null, b: Named | null | undefined): Named | null {
  if (!namedSize(b)) return a;
  if (!a) return b!;
  const once = <T>(xs: readonly T[], key: (x: T) => string): T[] => [...new Map(xs.map((x) => [key(x), x] as const)).values()];
  return {
    versions: once([...a.versions, ...b!.versions], (v) => v.key), codeFiles: once([...a.codeFiles, ...b!.codeFiles], (f) => f.key),
    commits: [...new Set([...a.commits, ...b!.commits])], sessions: [...new Set([...(a.sessions ?? []), ...(b!.sessions ?? [])])],
  };
}

/**
 * What the organizing plan says to read closely, put on the plan's paths (Spec §3.7, D62; reading.ts `closelyPath`): the
 * path that plans it already — its brief names it, or it plans the whole category (what the rules settle is outside
 * that) — else the first path of its kind of question. What of it a path did not plan already is added to what it reads:
 * its count, and a row of its own among its reads.
 */
function withReadClosely(paths: readonly PlannedPath[], closely: ReadClosely, settling: readonly string[]): PlannedPath[] {
  if (!closely.what.size) return [...paths];
  const keysOf = (n: Named | null) => new Set(n ? [...n.versions.map((v) => v.key), ...n.codeFiles.map((f) => f.key), ...n.commits.map((c) => `commit:${c}`), ...(n.sessions ?? [])] : []);
  const slots: PathSlot[] = paths.map((p) => ({ kinds: p.kinds.length ? p.kinds : sweepKindsOf(p.path), named: keysOf(p.named), whole: new Set(p.kinds.map((k) => KIND_CATEGORY[k])) }));
  type Lists = { versions: { key: string; path: string }[]; codeFiles: { key: string; lines: number }[]; commits: string[]; sessions: string[] };
  const lists = (): Lists => ({ versions: [], codeFiles: [], commits: [], sessions: [] });
  const all = paths.map(lists);
  const added = paths.map(lists);
  const put = (key: string, category: ReadingCategory, settled: boolean, into: (l: Lists) => void) => {
    const i = closelyPath(slots, { key, category, settled });
    if (i < 0) return;
    into(all[i]!);
    if (!slots[i]!.named.has(key) && (settled || !slots[i]!.whole.has(category))) into(added[i]!);
  };
  for (const v of closely.versions) put(v.key, 'document versions', underAny(settling, v.path), (l) => l.versions.push(v));
  for (const f of closely.codeFiles) put(f.key, 'code files', false, (l) => l.codeFiles.push(f));
  for (const c of closely.commits) put(`commit:${c}`, 'commits', false, (l) => l.commits.push(c));
  for (const s of closely.sessions) put(s, 'sessions', false, (l) => l.sessions.push(s));
  return paths.map((p, i) => {
    if (!namedSize(all[i]!)) return p;
    const n = namedSize(added[i]!);
    return { ...p, closely: { all: all[i]!, added: added[i]! }, materials: p.materials + n, reads: n ? [...p.reads, { category: 'materials the organizing plan says to read closely', count: n }] : p.reads };
  });
}

/** What the organizing plan adds to the paths, each once, by category. */
function addedByPlan(paths: readonly PlannedPath[]): NamedSets {
  const of = (pick: (n: Named) => readonly string[]) => new Set(paths.flatMap((p) => (p.closely ? pick(p.closely.added) : [])));
  return { versions: of((n) => n.versions.map((v) => v.key)), codeFiles: of((n) => n.codeFiles.map((f) => f.key)), commits: of((n) => n.commits), sessions: of((n) => n.sessions ?? []) };
}

/** `deepeningPlanPaths`, keeping what each path names so what was read can be held against it. */
/**
 * The plan a deepening is counted and held against, computed once per coverage pass and handed to what needs it: counting
 * it reads the ledger's totals, which is the slow part (about half a second on a project the size of ContextKeeper).
 */
export function deepeningPlanned(ledger: Ledger | null, store: ProjectStore): DeepeningPlanned {
  if (!ledger) return { paths: [], materials: 0, totals: null, wholeKinds: new Set(), named: NO_NAMED, closely: { what: new Map(), unresolved: [], added: NO_NAMED } };
  const totals = kindTotals(ledger, store);
  const briefs = deepeningBriefs(store);
  const settling = settlingDirs(store);
  // What the organizing plan says to read closely goes on the paths too (§3.7, D62): Full reads it with the rest. A
  // document is one material, however many of its versions a target reaches (§3.3).
  const closelyAll = readCloselyNow(ledger, store);
  const closely: ReadClosely = { ...closelyAll, versions: oneVersionPerDocument(ledger, closelyAll.versions) };
  const closelyOf = (paths: readonly PlannedPath[]) => ({ what: closely.what, unresolved: closely.unresolved, added: addedByPlan(paths) });
  if (briefs.length === 0) {
    const paths = withReadClosely(DEEPENING_PATHS.map((k) => ({ ...totals[k], named: null, kinds: [k] })), closely, settling);
    const added = addedByPlan(paths);
    return { paths, materials: paths.reduce((n, p) => n + p.materials, 0), totals, wholeKinds: new Set(DEEPENING_PATHS), named: added, closely: closelyOf(paths) };
  }
  const versions = new Set<string>(), files = new Set<string>(), commits = new Set<string>(), sessions = new Set<string>();
  const paths: PlannedPath[] = [];
  const counted = new Set<SweepKind>();
  for (const b of briefs) {
    const name = b.path ?? b.title;
    const inBrief = namedInBrief(b.markdown);
    const named = ledger.named(inBrief);
    const namedSessions = sessionsNamed(ledger, inBrief);
    // A document is one material, however many of its versions the brief's paths reach (§3.3).
    const documents = oneVersionPerDocument(ledger, named.versions);
    const close = documents.filter((v) => !underAny(settling, v.path));
    const settled = documents.length - close.length;
    const lines = named.codeFiles.reduce((n, f) => n + f.lines, 0);
    const reads = [
      { category: 'documents', count: close.length },
      { category: "documents settled by the project's rules (judged by the rule, not read closely)", count: settled },
      { category: `code files (${lines} lines)`, count: named.codeFiles.length },
      { category: 'commits named', count: named.commits.length },
      { category: 'sessions named', count: namedSessions.length },
    ].filter((r) => r.count > 0);
    if (reads.length) {
      for (const v of close) versions.add(v.key);
      for (const f of named.codeFiles) files.add(f.key);
      for (const c of named.commits) commits.add(c);
      for (const s of namedSessions) sessions.add(s);
      paths.push({ path: name, reads, basis: 'counted from what its brief names', materials: close.length + named.codeFiles.length + named.commits.length + namedSessions.length, named: { versions: close, codeFiles: named.codeFiles, commits: named.commits, sessions: namedSessions }, kinds: [] });
      continue;
    }
    // Named in words only: the ledger's totals for the kind its name says, once per kind.
    const kinds = sweepKindsOf(name).filter((k) => !counted.has(k));
    for (const k of kinds) counted.add(k);
    const fromTotals = kinds.map((k) => totals[k]);
    const materials = fromTotals.reduce((n, p) => n + p.materials, 0);
    paths.push({ path: name, reads: fromTotals.flatMap((p) => p.reads), basis: fromTotals.length ? "the ledger's totals for its kind of question: its brief names nothing the ledger can count" : 'its brief names nothing the ledger can count', materials, named: null, kinds });
  }
  for (const k of coveredKinds(briefs).missing) {
    if (counted.has(k)) continue;
    counted.add(k);
    const t = totals[k];
    paths.push({ ...t, path: `${k}${ADDED_SWEEP}`, basis: `${t.basis}: no brief covers it yet, and the deepening sends a lane for each kind of question`, named: null, kinds: [k] });
  }
  const placed = withReadClosely(paths, closely, settling);
  const added = addedByPlan(placed);
  // Each kind counted whole stands for its whole category; what the briefs named of that category is inside it, and what
  // the organizing plan adds to it is what the rules settle, outside it.
  const whole = (k: SweepKind, named: ReadonlySet<string>, add: ReadonlySet<string>) => (counted.has(k) ? totals[k].materials + add.size : new Set([...named, ...add]).size);
  const materials = whole(DEEPENING_PATHS[0], sessions, added.sessions!) + whole(DEEPENING_PATHS[1], versions, added.versions) + whole(DEEPENING_PATHS[2], commits, added.commits) + whole(DEEPENING_PATHS[3], files, added.codeFiles);
  const union = (a: ReadonlySet<string>, b: ReadonlySet<string>) => new Set([...a, ...b]);
  return {
    paths: placed, materials, totals, wholeKinds: counted, closely: closelyOf(placed),
    named: { versions: union(versions, added.versions), codeFiles: union(files, added.codeFiles), commits: union(commits, added.commits), sessions: union(sessions, added.sessions!) },
  };
}

/** How the plan names a path for a kind of question no brief covers yet: the deepening's lane for it goes by the kind's name. */
export const ADDED_SWEEP = ' (no brief covers it yet)';

/** §3.7: what a Full deepening reads, path by path, by material category (`deepeningPlanPaths`). */
export function deepeningReads(ledger: Ledger | null, store: ProjectStore, plan?: DeepeningPlanned): DeepeningPlan['paths'] {
  return deepeningPlanPaths(ledger, store, plan).paths.map(({ path, reads, basis }) => ({ path, reads, ...(basis ? { basis } : {}) }));
}

/**
 * §3.7: what `Focused` covers — current objects' lineage, open work, the breakpoint candidates the program computed and
 * the anomalies — and what the organizing plan says to read closely, which Focused reads in full too (D62, D97). The
 * candidates count whether or not one is lit: after the first usable round none is (D99), and the deepening is where a
 * lane looks for their missing steps.
 */
export function focusedCovers(store: ProjectStore): DeepeningPlan['focused'] {
  const open = (p: string) => !/^(done|completed|accepted|closed)/i.test(p);
  return [
    { category: 'current product objects', count: store.reference.filter((r) => r.validity === 'Current').length },
    { category: 'open work items', count: store.threads.filter((t) => t.validity === 'Current' && open(String(t.progress))).length },
    { category: 'breakpoint candidates', count: store.breakpoints.filter((b) => !b.out && !b.ownerResponse).length },
    { category: 'code anomalies', count: store.territories.all().reduce((n, t) => n + t.anomalies.length, 0) },
    { category: 'entries the organizing plan says to read closely, read in full', count: store.plans.get(ORGANIZING_PLAN_ID)?.readClosely.length ?? 0 },
  ].filter((c) => c.count > 0);
}

/** Minutes a job ran (queued time left out). */
const jobMinutes = (j: KeeperJob): number => (j.startedAt && j.endedAt ? Math.max(0, (Date.parse(j.endedAt) - Date.parse(j.startedAt)) / 60_000) : 0);
const costOf = (jobs: readonly KeeperJob[]): number | null => { const c = jobs.map((j) => j.usage.cost); return c.length && c.every((x) => x != null) ? c.reduce((n, x) => n + x!, 0) : null; };
/**
 * A model job's own minutes: a lane's, or any step's, from its start to its end; the main agent's (D99) its generation
 * time when the runtime measured it, since it waits parked while its lanes read and their minutes are counted as theirs.
 */
const ownMinutes = (j: KeeperJob): number => (j.step?.kind === 'main' && j.timing ? j.timing.generationMs / 60_000 : jobMinutes(j));

/**
 * What reading one planned material takes on this project, measured from its own jobs (§3.7: the estimate on a stated
 * basis): the first usable round's model jobs — the main agent and its lanes (D99), or the steps of a round from before
 * it — their own minutes and cost over the items they read. Null before it has anything to go on.
 */
function measuredRate(store: ProjectStore, first: ReturnType<typeof firstUsableFigures>, firstRound: ClerkRound | undefined): { minutes: number; cost: number | null; from: string } | null {
  if (!firstRound || first.itemsRead <= 0) return null;
  const model = store.jobs.filter((j) => j.step?.roundId === firstRound.id && j.agent !== 'program' && j.status === 'Done');
  const minutes = model.reduce((n, j) => n + ownMinutes(j), 0);
  if (minutes <= 0) return null;
  const cost = costOf(everyJob(store, model).filter((j) => j.agent !== 'program'));
  return { minutes: minutes / first.itemsRead, cost: cost == null ? null : cost / first.itemsRead, from: `the first usable round's ${model.length} model job${model.length === 1 ? '' : 's'}: ${Math.round(minutes)} job minutes${cost == null ? '' : ` and $${cost.toFixed(2)}`} for ${first.itemsRead} items read` };
}

/** The time the main agent spent in some of its stages (its stage log), and that share of its cost. */
function stagesOf(store: ProjectStore, round: ClerkRound, stages: readonly string[]): { minutes: number; cost: number | null } | null {
  const log: readonly StageEntry[] = round.stageLog ?? [];
  const entries = log.filter((e) => stages.includes(e.stage) && e.timing);
  if (!entries.length) return null;
  const wall = entries.reduce((n, e) => n + e.timing!.wallMs, 0);
  const main = store.jobs.filter((j) => j.step?.roundId === round.id && j.step.kind === 'main').sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0];
  const mainWall = log.reduce((n, e) => n + (e.timing?.wallMs ?? 0), 0);
  const cost = main && main.usage.cost != null && mainWall > 0 ? main.usage.cost * (wall / mainWall) : null;
  return { minutes: wall / 60_000, cost };
}

/**
 * What follows the lanes, as measured (D99, D103): a deepening's own — its main agent's cross-check stage, then its
 * synthesis, spot-check and process — once one ran; else the first usable round's reconcile stage and its synthesis and
 * process, which read the workbench and write it the same way. A stage's cost is the main job's in the share of its time.
 * The synthesis is a job of its own since D103; on a round recorded before, it is a stage of the main agent's log.
 */
function afterLanes(store: ProjectStore, firstRound: ClerkRound | undefined): { minutes: number; cost: number | null; from: string } | null {
  const pick = (round: ClerkRound, stages: readonly string[], jobKinds: readonly string[], from: string) => {
    const main = stagesOf(store, round, stages);
    const jobs = store.jobs.filter((j) => j.step?.roundId === round.id && jobKinds.includes(j.step.kind) && j.status === 'Done');
    if (!main && !jobs.length) return null;
    const jobCost = costOf(everyJob(store, jobs).filter((j) => j.agent !== 'program'));
    const minutes = (main?.minutes ?? 0) + jobs.reduce((n, j) => n + jobMinutes(j), 0);
    const cost = main && main.cost == null ? null : (main?.cost ?? 0) + (jobCost ?? 0);
    return { minutes, cost, from };
  };
  const deepen = store.clerkRounds.filter((r) => r.kind === 'Deepen' && r.status === 'Done' && Boolean(r.stageLog?.length)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (deepen) { const r = pick(deepen, ['cross-check', 'synthesis'], ['synthesis', 'spot-check', 'process'], `round ${deepen.number}'s cross-check and synthesis, spot-check and process`); if (r) return r; }
  return firstRound ? pick(firstRound, ['reconcile', 'synthesis'], ['synthesis', 'process'], "the first usable round's reconcile and synthesis and its process") : null;
}

/**
 * The three options with this project's figures (§3.7). What Full reads closely is counted by the round's question list
 * (`deepeningPlanPaths`): what each sweep's brief names, each material once however many briefs name it, and the ledger's
 * totals for a kind of question no brief names anything countable for, or no brief covers (QC AY: the amounts used to
 * be the ledger's totals whatever the briefs said). With no brief yet: the documents as they are now (less what the rules
 * settle), commits on every ref, sessions and code files. Material is counted by file, commit and session: a document is
 * one material, its older versions are looked up by question (Spec §3.3, §3.7; D99).
 *
 * The estimate is per material, on a stated basis (`measuredRate`): every lane reads its own planned materials (a
 * material two lanes plan is read by each, for its own questions), so the job time is the lanes' readings times the
 * measured minutes per material, spread over the lanes that run at once; what follows the lanes is added as measured
 * (`afterLanes`). Focused is taken as halfway, since how much history the current objects involve is only known once it
 * runs. Once a deepening has run, the Keeper view shows its real figures beside the estimate.
 */
export function clerkDepthOptions(first: ReturnType<typeof firstUsableFigures>, ledger: Ledger | null, store: ProjectStore, lanes: number, planned?: DeepeningPlanned, project?: Project): { options: DepthOption[]; basis: string; perMaterial: { minutes: number; cost: number | null; from: string } | null } {
  const plan = deepeningPlanPaths(ledger, store, planned);
  const full = plan.materials;
  const readings = plan.paths.reduce((n, p) => n + p.materials, 0);
  const byBriefs = plan.paths.some((p) => p.basis === 'counted from what its brief names');
  const firstRound = store.clerkRounds.filter((r) => r.kind === 'First usable').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const rate = first.minutes == null ? null : measuredRate(store, first, firstRound);
  const after = rate ? afterLanes(store, firstRound) : null;
  const parallel = Math.max(1, lanes);
  const jobMinutesFull = rate ? readings * rate.minutes : 0;
  const fullMinutes = rate ? Math.round(jobMinutesFull / parallel + (after?.minutes ?? 0)) : 0;
  const fullCost = rate && rate.cost != null ? Math.round((readings * rate.cost + (after?.cost ?? 0)) * 100) / 100 : null;
  const focusedMinutes = rate ? Math.round((fullMinutes + (after?.minutes ?? 0)) / 2) : 0;
  const focusedCost = fullCost == null ? null : Math.round(((fullCost + (after?.cost ?? 0)) / 2) * 100) / 100;
  const option = (depth: DepthOption['depth'], toOrganize: number, minutes: number, cost: number | null): DepthOption => ({ depth, levels: [], toOrganize, chars: 0, minutes, cost, lanes: parallel });
  const counted = byBriefs
    ? `by the round's question list: what each brief names, counted in the ledger, and the ledger's totals where a brief names nothing it can count or no brief covers a kind of question`
    : 'documents as they are now, one material each, less what the rules settle; commits on every ref; sessions; code files';
  const per = (r: { minutes: number; cost: number | null }) => `${r.minutes.toFixed(2)} job min${r.cost == null ? '' : ` and $${r.cost.toFixed(3)}`} a material`;
  const basis = first.minutes == null
    ? 'no estimate yet: the first usable round has not finished'
    : !rate
      ? 'no estimate yet: no step of this project has read anything to measure from'
      : `per material, measured on this project: ${per(rate)} (${rate.from}); Full reads ${full} materials (${counted}) — ${readings} readings across its ${plan.paths.length} path${plan.paths.length === 1 ? '' : 's'}, since a material two paths plan is read by each — by lanes running ${parallel} at a time: about ${Math.round(jobMinutesFull)} job minutes spread over them${after ? `, then ${Math.round(after.minutes)} min${after.cost == null ? '' : ` and $${after.cost.toFixed(2)}`} for what follows the lanes (as long as ${after.from})` : ''}; follow-up lanes for what the coverage check finds no lane touched are not in it; Focused is taken as halfway, since how much history the current objects involve is only known once it runs`;
  return {
    options: [option('Full', full, fullMinutes, fullCost), option('Focused', 0, focusedMinutes, focusedCost), option('First picture only', 0, 0, 0)],
    basis, perMaterial: rate,
  };
}

// ───────────────────────── the deepening as it ran, against its plan (CKC-13 AC-8) ─────────────────────────

/**
 * The categories what a deepening read is counted in: the plan's units, and what the plan has no unit for. The category
 * a kind of question counted by the ledger's totals plans whole is `KIND_CATEGORY` (reading.ts), what `kindTotals` counts
 * as its materials.
 */
type Category = 'document versions' | 'code files' | 'commits' | 'sessions' | 'other files';
const CATEGORIES: readonly Category[] = ['document versions', 'code files', 'commits', 'sessions', 'other files'];
const DOCUMENT_FILE = /\.(md|markdown|txt)$/i;
type Extent = 'whole' | 'part' | null;
const best = (xs: readonly Extent[]): Extent => (xs.includes('whole') ? 'whole' : xs.includes('part') ? 'part' : null);

/**
 * Where the plan's items are on disk, and which version of each document stands for the file as it is now: the ledger's
 * current one, or — when the file was edited after its last version — the latest (reading the file reads that one and
 * the edit after it). Every other version is the history: read only by reading it (`pk_ledger_doc_read`, `git show`).
 */
interface Placed {
  readonly versions: ReadonlyMap<string, { readonly file: string; readonly current: boolean; readonly commit: string }>;
  readonly codeFiles: ReadonlyMap<string, string>;
  readonly category: (fileKey: string) => Category | null;
  /** Every session the ledger holds: its id → its log's path key (a session read through the ledger is counted as its log). */
  readonly sessions: ReadonlyMap<string, string>;
}
function placePlan(ledger: Ledger, plan: DeepeningPlanned, store: ProjectStore, project: Project): Placed {
  const repos = ledger.repos();
  // A repository's root — or a scope item's outside version control: the ledger keeps its files by the item's id.
  const rootOf = new Map<string, string>([...project.scope.map((i) => [i.id, i.path] as const), ...repos.map((r) => [r.id, r.path] as const)]);
  const at = (repo: string, rel: string): string | null => { const root = rootOf.get(repo); return root ? join(root, ...rel.split('/')) : null; };
  // The ledger's own rows for the planned versions: the codemap and process engines read its tables the same way.
  let docRow: ((key: string) => { repo: string; path: string; commit_hash: string; at_ms: number; cur: number } | undefined) | null = null;
  try {
    const stmt = ledger.db.prepare('SELECT repo, path, commit_hash, at_ms, (SELECT count(*) FROM code_files f WHERE f.repo = d.repo AND f.path = d.path AND f.blob = d.blob) cur FROM docs d WHERE key = ? LIMIT 1');
    docRow = (key) => stmt.get(key) as never;
  } catch { docRow = null; }
  const found: { key: string; abs: string; commit: string; at: number; cur: boolean }[] = [];
  // What each path plans: what its brief names, and what the organizing plan adds to read closely.
  const plannedOf = (p: PlannedPath) => mergeNamed(p.named, p.closely?.added);
  for (const key of new Set(plan.paths.flatMap((p) => (plannedOf(p)?.versions ?? []).map((v) => v.key)))) {
    const r = docRow?.(key);
    const abs = r ? at(r.repo, r.path) : (() => { const p = ledger.entryPlace(key); return p && 'file' in p ? p.file : null; })();
    if (abs) found.push({ key, abs, commit: r?.commit_hash ?? key.replace(/^.*@/, ''), at: Number(r?.at_ms ?? 0), cur: r ? Number(r.cur) > 0 : true });
  }
  const byFile = new Map<string, typeof found>();
  for (const f of found) { const k = pathKey(f.abs); byFile.set(k, [...(byFile.get(k) ?? []), f]); }
  const versions = new Map<string, { file: string; current: boolean; commit: string }>();
  for (const [file, list] of byFile) {
    const standing = list.find((v) => v.cur) ?? (existsFile(list[0]!.abs) ? [...list].sort((a, b) => b.at - a.at)[0] : undefined);
    for (const v of list) versions.set(v.key, { file, current: v === standing, commit: v.commit });
  }
  const codeFiles = new Map<string, string>();
  const rootIds = [...rootOf.keys()].sort((a, b) => b.length - a.length);
  for (const key of new Set(plan.paths.flatMap((p) => (plannedOf(p)?.codeFiles ?? []).map((f) => f.key)))) {
    const repo = rootIds.find((id) => key.startsWith(`${id}:`));
    const abs = repo ? at(repo, key.slice(repo.length + 1)) : null;
    if (abs) codeFiles.set(key, pathKey(abs));
  }
  // What a file read beyond the plan is: a session log, a document, a code file as the ledger counts one, or another file
  // of the project (a fixture, a generated file, a worktree's copy); what lies outside the project is not counted.
  const sessions = new Map<string, string>();
  try { for (const s of ledger.sessionLogs()) sessions.set(s.key, pathKey(s.file)); } catch { /* a ledger without sessions */ }
  const sessionLogs = new Set([...store.sources.all().flatMap((s) => (s.anchor.kind === 'session' ? [pathKey(s.anchor.file)] : [])), ...sessions.values()]);
  const inProject = [...project.locations, ...project.scope.filter((i) => i.relation !== 'Excluded' && i.category !== 'Session source').map((i) => i.path)];
  const excluded = project.scope.filter((i) => i.relation === 'Excluded').map((i) => i.path);
  let code: ((repo: string, rel: string) => boolean) | null = null;
  try {
    const stmt = ledger.db.prepare("SELECT 1 x FROM code_files WHERE repo = ? AND path = ? AND generated = 0 AND classification IS NULL AND (lang IS NULL OR lang NOT IN ('markdown', 'text')) LIMIT 1");
    code = (repo, rel) => stmt.get(repo, rel) !== undefined;
  } catch { code = null; }
  const roots = repos.map((r) => ({ id: r.id, key: pathKey(r.path) })).sort((a, b) => b.key.length - a.key.length);
  const categories = new Map<string, Category | null>();
  const category = (key: string): Category | null => {
    if (categories.has(key)) return categories.get(key)!;
    let c: Category | null;
    if (sessionLogs.has(key)) c = 'sessions';
    else if (!inProject.some((l) => isWithin(l, key)) || excluded.some((l) => isWithin(l, key))) c = null;
    else if (DOCUMENT_FILE.test(key)) c = 'document versions';
    else {
      const repo = roots.find((r) => key.startsWith(`${r.key}\\`) || key.startsWith(`${r.key}/`));
      const rel = repo ? key.slice(repo.key.length + 1).split(/[\\/]/).join('/') : null;
      c = repo && rel && code?.(repo.id, rel) ? 'code files' : 'other files';
    }
    categories.set(key, c);
    return c;
  };
  return { versions, codeFiles, category, sessions };
}
const existsFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };

/**
 * What a tally read, category by category, as items: a document version (the file as it stands, or a version from the
 * history at its commit), a code file, a commit, a session log (read whole, or only some of it — a part of the log, or a
 * segment of it by its source), another file of the project.
 */
function readItems(tally: ReadTally, placed: Placed, store: ProjectStore): Map<Category, Map<string, 'whole' | 'part'>> {
  const out = new Map<Category, Map<string, 'whole' | 'part'>>(CATEGORIES.map((c) => [c, new Map()]));
  const put = (c: Category, id: string, e: Extent) => { if (!e) return; const m = out.get(c)!; if (m.get(id) !== 'whole') m.set(id, e); };
  for (const [key, f] of tally.files) { const c = placed.category(key); if (c) put(c, key, extentOf(f)); }
  for (const [key, list] of tally.versions) for (const v of list) put('document versions', `${key}@${v.rev}`, extentOf(v.reads));
  for (const c of tally.commits) put('commits', c, 'whole');
  for (const id of tally.sources) {
    const s = store.sources.get(id);
    if (s?.anchor.kind === 'session') put('sessions', pathKey(s.anchor.file), 'part');
  }
  // A session read through the ledger (`pk_ledger_sessions`): its log, whole when every message was shown.
  for (const [key, f] of tally.sessions) { const log = placed.sessions.get(key); if (log) put('sessions', log, extentOf(f)); }
  return out;
}

/** One category's figures as they are counted up. */
interface Tally { planned: number | null; whole: number; part: number; beyond: { whole: number; part: number } }

/**
 * One step's (or the round's) reads against a plan (`DeepeningReads`): the items it names, by name; the categories it
 * plans whole, by count; what was read of neither is beyond it. `named` null and no `wholeCategories`: a step no path plans.
 */
function figures(tally: ReadTally, placed: Placed, store: ProjectStore, named: Named | null, wholeCategories: ReadonlyMap<Category, number>, planned: number | null): DeepeningReads {
  const items = readItems(tally, placed, store);
  const rows = new Map<Category, Tally>();
  const rowOf = (c: Category): Tally => { let r = rows.get(c); if (!r) { r = { planned: null, whole: 0, part: 0, beyond: { whole: 0, part: 0 } }; rows.set(c, r); } return r; };
  const plan = (c: Category, n: number): Tally => { const r = rowOf(c); r.planned = (r.planned ?? 0) + n; return r; };
  const count = (r: Tally, e: Extent) => { if (e === 'whole') r.whole += 1; else if (e === 'part') r.part += 1; };
  const counted = new Map<Category, Set<string>>(CATEGORIES.map((c) => [c, new Set()]));
  // A file as it stands may fall in any of these, by its name and the ledger (a document that is not Markdown).
  const FILE_CATEGORIES = ['document versions', 'code files', 'other files'] as const;
  const fileRead = (key: string): Extent => best(FILE_CATEGORIES.map((c) => items.get(c)!.get(key) ?? null));
  const fileCounted = (key: string) => { for (const c of FILE_CATEGORIES) counted.get(c)!.add(key); };
  if (named) {
    // Each planned version: the file as it stands when that version stands for it, and any read of that very version
    // from the history.
    const versions = plan('document versions', named.versions.length);
    for (const v of named.versions) {
      const p = placed.versions.get(v.key);
      if (!p) continue;
      const fromHistory = [...items.get('document versions')!].filter(([id]) => id.startsWith(`${p.file}@`) && sameCommit(id.slice(p.file.length + 1), p.commit));
      count(versions, best([p.current ? fileRead(p.file) : null, ...fromHistory.map(([, e]) => e)]));
      if (p.current) fileCounted(p.file);
      for (const [id] of fromHistory) counted.get('document versions')!.add(id);
    }
    const code = plan('code files', named.codeFiles.length);
    for (const f of named.codeFiles) {
      const key = placed.codeFiles.get(f.key);
      if (!key) continue;
      count(code, fileRead(key));
      fileCounted(key);
    }
    const commits = plan('commits', named.commits.length);
    for (const h of named.commits) {
      const hit = [...items.get('commits')!.keys()].filter((c) => sameCommit(c, h));
      count(commits, hit.length ? 'whole' : null);
      for (const c of hit) counted.get('commits')!.add(c);
    }
    // Each session the brief names: its log read (whole, or some of it) by any means, the ledger's included.
    const sessions = plan('sessions', named.sessions?.length ?? 0);
    for (const s of named.sessions ?? []) {
      const log = placed.sessions.get(s);
      if (!log) continue;
      count(sessions, items.get('sessions')!.get(log) ?? null);
      counted.get('sessions')!.add(log);
    }
  }
  // A category planned whole (a path counted by the ledger's totals): whatever of it was read, up to what it plans.
  for (const [c, n] of wholeCategories) {
    const r = plan(c, n);
    const rest = [...items.get(c)!].filter(([id]) => !counted.get(c)!.has(id)).sort((a, b) => Number(b[1] === 'whole') - Number(a[1] === 'whole'));
    for (const [id, e] of rest) {
      if ((r.planned ?? 0) - r.whole - r.part <= 0) break;
      count(r, e);
      counted.get(c)!.add(id);
    }
  }
  // Beyond the plan: what was read and is none of the above.
  for (const c of CATEGORIES) {
    for (const [id, e] of items.get(c)!) {
      if (counted.get(c)!.has(id)) continue;
      const r = rowOf(c);
      if (e === 'whole') r.beyond.whole += 1; else r.beyond.part += 1;
    }
  }
  const byCategory = CATEGORIES.flatMap((c) => {
    const r = rows.get(c);
    if (!r || (!r.planned && !r.whole && !r.part && !r.beyond.whole && !r.beyond.part)) return [];
    return [{ category: c, planned: r.planned, whole: r.whole, part: r.part, left: r.planned === null ? null : Math.max(0, r.planned - r.whole - r.part), beyond: { ...r.beyond } }];
  });
  const sum = (f: (r: (typeof byCategory)[number]) => number) => byCategory.reduce((n, r) => n + f(r), 0);
  const whole = sum((r) => r.whole), part = sum((r) => r.part);
  return {
    planned, whole, part, left: planned === null ? null : Math.max(0, planned - whole - part),
    beyond: { whole: sum((r) => r.beyond.whole), part: sum((r) => r.beyond.part) }, byCategory,
  };
}

/** A job and the investigations it sent, and theirs: what a step read includes what it sent others to read. */
function withDescendants(store: ProjectStore, job: KeeperJob): KeeperJob[] {
  const out = [job];
  for (let i = 0; i < out.length; i++) out.push(...store.jobs.filter((j) => j.parentJobId === out[i]!.id && !out.includes(j)));
  return out;
}
const everyJob = (store: ProjectStore, jobs: readonly KeeperJob[]): KeeperJob[] => [...new Map(jobs.flatMap((j) => withDescendants(store, j)).map((j) => [j.id, j])).values()];

/**
 * A path's (or the round's) reads against the materials its reading planned (`DeepeningReads`), counted as the reading
 * counts them (reading.ts `readsOf`: an older version of a document read through what it changed): planned, read whole,
 * read in part, not read; and what was read that is none of them, beyond the plan.
 */
function readingFigures(tally: ReadTally, placed: Placed | null, store: ProjectStore, materials: readonly ReadingMaterial[], states: ReadonlyMap<string, MaterialRead>): DeepeningReads {
  const rows = new Map<Category, Tally>();
  const rowOf = (c: Category): Tally => { let r = rows.get(c); if (!r) { r = { planned: null, whole: 0, part: 0, beyond: { whole: 0, part: 0 } }; rows.set(c, r); } return r; };
  const items = placed ? readItems(tally, placed, store) : new Map<Category, Map<string, 'whole' | 'part'>>(CATEGORIES.map((c) => [c, new Map()]));
  const matched = new Map<Category, Set<string>>(CATEGORIES.map((c) => [c, new Set()]));
  const FILE_CATEGORIES = ['document versions', 'code files', 'other files'] as const;
  for (const m of materials) {
    const r = rowOf(m.category);
    r.planned = (r.planned ?? 0) + 1;
    const s = states.get(m.key)?.outcome;
    if (s === 'whole') r.whole += 1; else if (s === 'part') r.part += 1;
    // Which of the reads this material accounts for, so what is left over is beyond the plan.
    if ((m.category === 'code files' || m.current) && m.file) for (const c of FILE_CATEGORIES) matched.get(c)!.add(pathKey(m.file));
    if (m.category === 'document versions' && m.file && m.rev) {
      const fk = pathKey(m.file);
      for (const id of items.get('document versions')!.keys()) if (id.startsWith(`${fk}@`) && sameCommit(id.slice(fk.length + 1), m.rev)) matched.get('document versions')!.add(id);
    }
    if (m.category === 'commits' && m.rev) for (const id of items.get('commits')!.keys()) if (sameCommit(id, m.rev)) matched.get('commits')!.add(id);
    if (m.category === 'sessions' && m.session) { const log = placed?.sessions.get(m.session); if (log) matched.get('sessions')!.add(log); }
  }
  for (const c of CATEGORIES) for (const [id, e] of items.get(c)!) {
    if (matched.get(c)!.has(id)) continue;
    const r = rowOf(c);
    if (e === 'whole') r.beyond.whole += 1; else r.beyond.part += 1;
  }
  const byCategory = CATEGORIES.flatMap((c) => {
    const r = rows.get(c);
    if (!r || (!r.planned && !r.whole && !r.part && !r.beyond.whole && !r.beyond.part)) return [];
    return [{ category: c, planned: r.planned, whole: r.whole, part: r.part, left: r.planned === null ? null : Math.max(0, r.planned - r.whole - r.part), beyond: { ...r.beyond } }];
  });
  const sum = (f: (r: (typeof byCategory)[number]) => number) => byCategory.reduce((n, r) => n + f(r), 0);
  const whole = sum((r) => r.whole), part = sum((r) => r.part);
  return { planned: materials.length, whole, part, left: Math.max(0, materials.length - whole - part), beyond: { whole: sum((r) => r.beyond.whole), part: sum((r) => r.beyond.part) }, byCategory };
}

/**
 * A deepening read by reading assignments (reading.ts), as it runs: one row per path — its assignments together, their
 * status and time, what the path read against its planned materials, and what it recorded as read in part or not read,
 * with why — then the steps after the sweeps; and the round against every material its paths planned, each once.
 */
function readingAsRun(store: ProjectStore, project: Project, round: ClerkRound, jobs: readonly KeeperJob[], placed: Placed | null): { progress: DeepeningPlan['progress']; actual: DeepeningActual } {
  const reading = round.reading!;
  const paths = new Set(reading.paths.map((p) => p.path));
  const ACTIVE = ['Queued', 'Running', 'Waiting for quota', 'Paused'];
  const rows = reading.paths.map((p) => {
    const list = pathJobs(store, round.id, p.path);
    const tally = tallyReads(everyJob(store, list), project);
    const states = materialReads(p.materials, tally);
    const bad = list.find((j) => j.status === 'Failed' || j.status === 'Stopped');
    const status = p.complete ? 'Done' : list.some((j) => j.status === 'Running') ? 'Running' : bad ? bad.status : list.some((j) => ACTIVE.includes(j.status)) ? 'Queued' : 'Running';
    const started = list.map((j) => j.startedAt).filter((x): x is string => Boolean(x)).sort()[0] ?? null;
    const ended = p.complete ? list.map((j) => j.endedAt ?? '').sort().pop() || null : null;
    return { path: p.path, status, minutes: minutesOf(started, ended), reads: readingFigures(tally, placed, store, p.materials, states), reading: pathReadingOf(store, project, round, p, states) };
  });
  const others = jobs.filter((j) => !(j.step?.kind === 'dig' && paths.has(j.step.path ?? j.scope.label))).map((j) => ({
    path: j.step!.kind === 'dig' ? (j.step!.path ?? j.scope.label) : j.scope.label, status: j.status, minutes: minutesOf(j.startedAt, j.endedAt),
    reads: readingFigures(tallyReads(withDescendants(store, j), project), placed, store, [], new Map()),
  })).map((r) => ({ ...r, reads: { ...r.reads, planned: null, left: null, byCategory: r.reads.byCategory.map((c) => ({ ...c, planned: null, left: null })) } }));
  // The round together: every material a path planned, once, against everything the round's jobs read.
  const union = [...new Map(reading.paths.flatMap((p) => p.materials).map((m) => [m.key, m])).values()];
  const all = everyJob(store, jobs);
  const tally = tallyReads(all, project);
  const total = readingFigures(tally, placed, store, union, materialReads(union, tally));
  const costs = all.filter((j) => j.agent !== 'program').map((j) => j.usage.cost);
  return {
    progress: [...rows, ...others],
    actual: {
      ...total, depth: roundDepth(round, store.jobs.get(round.rootJobId)) ?? project.takeoverDepth ?? 'Full', roundId: round.id, status: round.status,
      minutes: minutesOf(round.startedAt, round.endedAt), cost: costs.length && costs.every((c) => c != null) ? Math.round(costs.reduce((n, c) => n + c!, 0) * 100) / 100 : null,
    },
  };
}

/**
 * The deepening under way or done (§3.7; CKC-13 AC-8): each step's status and time and, once it has read, what it read
 * against its path's plan — counted from the steps' recorded reads, in the plan's units (a document version, a code file,
 * a commit; a session for a path counted by the ledger's totals) — and the whole round against the whole plan, with its
 * time and cost. The plan is the one the depth question counted (`deepeningPlanPaths`); a sweep the program added is
 * matched by its kind. A deepening read by reading assignments is counted path by path against what its reading planned
 * when its sweeps started (`readingAsRun`). Without the ledger or the project, only the status and time.
 */
export function deepeningAsRun(ledger: Ledger | null, store: ProjectStore, project: Project | null, planned?: DeepeningPlanned): { progress: DeepeningPlan['progress']; actual: DeepeningActual | null } {
  const round = store.clerkRounds.filter((r) => r.kind === 'Deepen').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!round) return { progress: [], actual: null };
  const jobs = store.jobs.filter((j) => j.step?.roundId === round.id && j.agent !== 'program').sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  const pathOf = (j: KeeperJob) => (j.step!.kind === 'dig' || j.step!.kind === 'lane' ? (j.step!.path ?? j.scope.label) : j.scope.label);
  const plan = ledger && project ? planned ?? deepeningPlanned(ledger, store) : null;
  const placed = ledger && project && plan ? placePlan(ledger, plan, store, project) : null;
  if (round.reading && project) return readingAsRun(store, project, round, jobs, placed);
  const wholeOf = (kinds: readonly SweepKind[]) => new Map(kinds.map((k) => [KIND_CATEGORY[k], plan!.totals![k].materials] as const));
  const progress = jobs.map((j) => {
    const base = { path: pathOf(j), status: j.status, minutes: minutesOf(j.startedAt, j.endedAt) };
    if (!plan || !placed || !project) return base;
    const tally = tallyReads(withDescendants(store, j), project);
    const pathPlan = (j.step!.kind === 'dig' || j.step!.kind === 'lane') ? plan.paths.find((p) => p.path === base.path || p.path === `${base.path}${ADDED_SWEEP}`) ?? null : null;
    // What its brief names, or its kinds' whole categories, and what the organizing plan adds to read closely.
    const reads = pathPlan
      ? figures(tally, placed, store, mergeNamed(pathPlan.named, pathPlan.closely?.added), pathPlan.named ? new Map() : wholeOf(pathPlan.kinds), pathPlan.materials)
      : figures(tally, placed, store, null, new Map(), null);
    return { ...base, reads };
  });
  if (!plan || !placed || !project || !plan.totals) return { progress, actual: null };
  // The round together: every step's reads against the plan's union — what the briefs name, each once, and the
  // categories a kind counted whole plans in full (`deepeningPlanPaths`' `materials`).
  const union: Named = {
    versions: [...plan.named.versions].map((key) => ({ key, path: '' })),
    codeFiles: [...plan.named.codeFiles].map((key) => ({ key, lines: 0 })),
    commits: [...plan.named.commits],
    sessions: [...(plan.named.sessions ?? [])],
  };
  const wholeKinds = [...plan.wholeKinds];
  // A category planned whole holds what the briefs named of it; what the organizing plan adds to it lies outside it.
  const added = plan.closely.added;
  const namedPart: Named = {
    versions: plan.wholeKinds.has(DEEPENING_PATHS[1]) ? [...added.versions].map((key) => ({ key, path: '' })) : union.versions,
    codeFiles: plan.wholeKinds.has(DEEPENING_PATHS[3]) ? [...added.codeFiles].map((key) => ({ key, lines: 0 })) : union.codeFiles,
    commits: plan.wholeKinds.has(DEEPENING_PATHS[2]) ? [...added.commits] : union.commits,
    sessions: plan.wholeKinds.has(DEEPENING_PATHS[0]) ? [...(added.sessions ?? [])] : union.sessions,
  };
  const all = [...new Map(jobs.flatMap((j) => withDescendants(store, j)).map((j) => [j.id, j])).values()];
  const total = figures(tallyReads(all, project), placed, store, namedPart, wholeOf(wholeKinds), plan.materials);
  // Its cost: every step's, with the investigations each sent (they are that step's work).
  const costs = all.filter((j) => j.agent !== 'program').map((j) => j.usage.cost);
  return {
    progress,
    actual: {
      ...total, depth: roundDepth(round, store.jobs.get(round.rootJobId)) ?? project.takeoverDepth ?? 'Full', roundId: round.id, status: round.status,
      minutes: minutesOf(round.startedAt, round.endedAt), cost: costs.length && costs.every((c) => c != null) ? Math.round(costs.reduce((n, c) => n + c!, 0) * 100) / 100 : null,
    },
  };
}
