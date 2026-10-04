/**
 * The units of work the ledger shows (Spec v3.0 §2.12 "按项目的编号"; §1.16 row 4 编号, row 6 执行安排): each number the
 * project gives a piece of work, with what the ledger ties to it by that number —
 *
 * - its arrangement versions: the prompt or task file (front matter: executor, status, worktree, the fields that name
 *   other work), the receipts and reports named after it, the run status files;
 * - its commits: a commit whose subject opens with the number (`AB: …`), else a side commit on a branch named after it
 *   (`wip/AK-…`), else a side commit brought in by a merge that names it where a merge names what it merges (`Merge AI: …`,
 *   `Merge branch 'k-ledger' (AP: …)`) — the innermost such merge, for a branch merged into an integration branch
 *   (integration.ts); the merges that brought them in. A trunk commit that only mentions a number (`subagent: dispatch
 *   AK`), or a merge that mentions one elsewhere in its subject (`…, QC AW/AX/AY fixes)`), is not the unit's delivery;
 * - what it is by its own words: a fix (`修复 AB`, `fix`, `repair`), a check (`QC`, `review`, `走查`, a report with a
 *   verdict and no code of its own), or work;
 * - which units it fixes or checks: named in its title, in a front-matter field that says so (`upstream`, `verifies`,
 *   `reviewed_commit` …), or named by the other unit (`resolved_by`, `milestone_qc`).
 *
 * A number the project gave to more than one task (ContextKeeper's AJ: an exam, then a review) is one unit per task —
 * the latest keeps the number, an earlier one is `AJ#1` — told apart by the prompt files, what names which report, and
 * when each was written (`tasksOfNumber`); a work item carrying the number is the task its sources cite.
 *
 * A related task that names the work's number is how a step joins a work item's process (the orchestrator's matching
 * rule): a fix prompt that names the task it repairs, a QC that names what it checks. Only these relations chain; a
 * dependency (`依赖 AK`, `blocks`) does not make one task a step of another.
 */
import type { WorkThread } from '../model/types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import type { ArrangementFact, CommitFact, Facts, NumFact } from './facts.ts';
import { integrationsOf, type Integrations } from './integration.ts';
import { definitionsInSubject } from '../ledger/numbering.ts';
import { isNumberShaped, otherObjectOf } from '../keeper/numbers-check.ts';
import { earlierGenerationOf } from '../keeper/organize/carried-on.ts';
import { fullDatesIn, materialTime, msOf } from '../ledger/time.ts';

export type UnitNature = 'work' | 'fix' | 'check';
export type CheckKind = 'QC' | 'Review' | 'Walkthrough';

export interface Relation {
  /** The unit this one fixes or checks. */
  readonly num: string;
  readonly as: 'fix' | 'check';
  /** Where the relation is written: the title, a field (`upstream: "AB"`), the reviewed commit, or the other unit's field. */
  readonly via: { readonly entryId: string; readonly line: string };
}

export interface Unit {
  readonly num: string;
  /** Prompt / task-file versions, oldest first. */
  readonly prompts: readonly ArrangementFact[];
  /** Receipts and reports named after it (its own account of what it did, or a check's report), oldest first. */
  readonly receipts: readonly ArrangementFact[];
  /** Evidence the host collected about it (`AB-evidence-grok.md`): not its own account, and not an independent check. */
  readonly evidence: readonly ArrangementFact[];
  /** Run status files (a headless run: agent, model, worktree, base commit). */
  readonly runs: readonly ArrangementFact[];
  readonly title: string | null;
  readonly fields: Readonly<Record<string, string>>;
  readonly nature: UnitNature;
  readonly checkKind: CheckKind | null;
  /** Delivery commits (not merges), oldest first. */
  readonly commits: readonly CommitFact[];
  /** The merges into the trunk that brought its commits in (or merge commits named after it), oldest first. */
  readonly merges: readonly CommitFact[];
  readonly branches: readonly string[];
  readonly relations: readonly Relation[];
  /** The executor the arrangement names, and the model when it says. */
  readonly executor: string | null;
}

// ───────────────────────── words ─────────────────────────

/** Fix words in a title or a `kind` field. `修` alone only right before a number (`修 AF`), since it is part of many words. */
export const FIX_WORDS = /修复|修补|修正|返工|修掉|修好|修\s*(?=[A-Z]{1,6}(?:-?\d)?\b)|\b(?:fix|fixes|fixing|repair|repairs|repairing|rework|hotfix|remediate|remediation)\b/i;
/** Check words: QC, review, audit, walkthrough, independent verification. */
export const CHECK_WORDS = /\bQC\b|\breview\b|\baudit\b|walk-?through|走查|审阅|审核|复核|评审|核查|独立.{0,8}(?:QC|复核|审|核|验)/i;
const WALK_WORDS = /walk-?through|走查|真机|模拟器/i;
const REVIEW_WORDS = /\breview\b|\baudit\b|审阅|审核|评审/i;

/** Front-matter fields that say which unit this one fixes or checks. */
const FORWARD_FIELDS = /^(upstream|fixes|fix_of|repairs|repair_of|resolves|reworks|verifies|verified|reviews|reviewed|reviewed_work|reviewed_task|checks|checked|qc_of|audits|target|targets|for|parent|follows)$/i;
/** Front-matter fields of the *other* unit that name this one as its fixer or checker. */
const REVERSE_FIX_FIELDS = /^(resolved_by|fixed_by|repaired_by|reworked_by|fix|fixed_in)$/i;
const REVERSE_CHECK_FIELDS = /^(milestone_qc|qc|qc_by|reviewed_by|checked_by|verified_by|audited_by|independent_qc)$/i;
/** Fields naming the commit or revision a check reviewed. */
const COMMIT_FIELDS = /^(reviewed_commit|reviewed_revision|reviewed_rev|verifies|verified_commit|checked_commit|qc_commit|commit_under_review)$/i;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Status words of an arrangement, by what they say about the dispatch (§2.12 `Dispatched`). */
export const RUNNING_STATUS = /^(?:running|in[ _-]?progress|dispatched|started|active|执行中|进行中|正在)/i;
export const PLANNED_STATUS = /^(?:ready|queued|planned|todo|to[ _-]?do|pending|blocked|draft|not[ _-]?dispatched|waiting|待|排队|未派发)/i;
export const DONE_STATUS = /^(?:complete|completed|done|delivered|submitted|finished|merged|accepted|closed|完成|已完成|已合入|已交付)/i;
/** A host review that sent the delivery back (§1.18: the result has gaps). `…-qc-failed` records a check's verdict, not a review. */
export const REPAIR_STATUS = /^(?:needs?[ _-]?(?:repair|fix|fixes|rework)|rework|rejected|returned|sent[ _-]?back|返工|打回|需修复|待修复|需要修复)/i;

// ───────────────────────── building the units ─────────────────────────

export interface UnitIndex {
  readonly units: ReadonlyMap<string, Unit>;
  /** Units by their thread: the thread's numbers that are units. */
  readonly threadNums: ReadonlyMap<string, readonly string[]>;
  /** The thread a number belongs to. */
  readonly threadOf: ReadonlyMap<string, string>;
  /** Where every unit number shows up (§1.16 row 4). */
  readonly nums: ReadonlyMap<string, readonly NumFact[]>;
  /** Unit numbers named in each document path or commit (for "does this text name the unit"). */
  readonly namedIn: ReadonlyMap<string, ReadonlySet<string>>;
  /** Which units each commit is attributed to. */
  readonly commitUnits: ReadonlyMap<string, readonly string[]>;
  /** The merges that brought each commit in, innermost first (integration.ts). */
  readonly integrations: Integrations;
}

const MERGE_ID = '[A-Z]{1,6}-[A-Z]?\\d{1,4}|[A-Z]\\d{1,4}|[A-Z]{2}';
const MERGE_SUBJECT = new RegExp(`^Merge\\s+(?:branch\\s+'[^']*'\\s*\\()?((?:${MERGE_ID})(?:\\s*[+&,]\\s*(?:${MERGE_ID}))*)\\s*[:：)]`);
const MERGE_OPENS = new RegExp(`^Merge\\s+((?:${MERGE_ID})(?:\\s*[+&,]\\s*(?:${MERGE_ID}))*)(?![A-Za-z0-9_-])`);
const MERGE_PAREN = new RegExp(`\\(((?:${MERGE_ID})(?:\\s*[+&,]\\s*(?:${MERGE_ID}))*)\\s*[:：]`);

/**
 * The numbers a merge's subject names as what it merges, in the places a merge says so: right after `Merge`
 * (`Merge AB+AD: …`, `Merge T-2 conveyor`), or opening its parenthesis (`Merge branch 'k-ledger' (AP: …)`). Numbers the
 * subject mentions anywhere else are not what it merged. Any shape of number: the caller keeps the ones it knows.
 */
export function mergeNamesIn(subject: string): string[] {
  const m = MERGE_SUBJECT.exec(subject) ?? MERGE_OPENS.exec(subject) ?? MERGE_PAREN.exec(subject);
  return m ? m[1]!.split(/\s*[+&,]\s*/) : [];
}

/**
 * The numbers of a work item: the project's own, from its record (CJ) — its ids, and an internal id that is a project
 * number (`AP`: before CJ, `pk_write_thread({ id: "AP" })` made the number the item's id and left its ids empty) — less
 * another object's number (`isOther`): a decision's (`D99`, `D100`) is not the ticket's, and tying work by it showed the
 * decision record's commits as the ticket's delivery.
 */
export function ownNumbers(t: WorkThread, isOther: (num: string) => boolean = () => false): string[] {
  const own = [...t.ids, ...(isNumberShaped(t.id) ? [t.id] : [])].map((x) => x.trim()).filter(Boolean);
  return [...new Set(own)].filter((n) => !isOther(n));
}

export function buildUnits(store: ProjectStore, facts: Facts): UnitIndex {
  const threads = store.threads.all();
  const otherCache = new Map<string, boolean>();
  const isOther = (n: string): boolean => {
    const key = n.toUpperCase();
    if (!otherCache.has(key)) otherCache.set(key, otherObjectOf(store, facts.ledger, key) !== null);
    return otherCache.get(key)!;
  };
  const threadNumbers = (t: WorkThread) => ownNumbers(t, isOther);
  const threadOf = new Map<string, string>();
  const threadNums = new Map<string, string[]>();
  for (const t of threads) {
    const nums = threadNumbers(t);
    threadNums.set(t.id, nums);
    for (const n of nums) if (!threadOf.has(n)) threadOf.set(n, t.id);
  }
  // The unit numbers: every number a work item carries, and every number an arrangement file is about.
  const known = new Set<string>([...threadOf.keys()]);
  for (const a of facts.arrangements) if (a.ident && (a.kind === 'prompt' || a.kind === 'receipt' || a.kind === 'status')) known.add(a.ident);
  const nums = facts.numsOf(known);
  const namedIn = new Map<string, Set<string>>();
  const note = (key: string, num: string) => { const s = namedIn.get(key) ?? new Set<string>(); s.add(num); namedIn.set(key, s); };
  const branchUnits = new Map<string, Set<string>>();
  const subjectDefs = new Map<string, Set<string>>();
  const subjectNames = new Map<string, Set<string>>();
  for (const [num, rows] of nums) {
    for (const r of rows) {
      if (r.kind === 'doc' || r.kind === 'loose') { if (r.path) note(`path:${r.path}`, num); }
      else if (r.kind === 'commit' && r.commit) {
        note(`commit:${r.commit}`, num);
        if (r.line === 1) {
          if (r.place === 'definition') subjectDefs.set(r.commit, new Set([...(subjectDefs.get(r.commit) ?? []), num]));
          if (r.confidence === 'stated' || r.place === 'definition') subjectNames.set(r.commit, new Set([...(subjectNames.get(r.commit) ?? []), num]));
        }
      } else if (r.kind === 'branch') {
        const name = r.path ?? r.context;
        const plain = name.replace(/^(?:origin|upstream|remotes\/[^/]+)\//, '');
        branchUnits.set(plain, new Set([...(branchUnits.get(plain) ?? []), num]));
      }
    }
  }
  // A subject that opens with a unit's number defines it (`AN: scanner`), and a merge's subject names what it brings in
  // (`Merge AB+AD: …`, `Merge branch 'k-ledger' (AP: …)`, `Merge T-2 conveyor`), read here for every known unit: the
  // ledger leaves out two capitals that are also ordinary words (AN, AT, AS …), which in these positions are the number.
  // A number a merge's subject only mentions elsewhere is not what it merges: `Merge k-clerk: increment K (…, QC AW/AX/AY
  // fixes)` brought in increment K, not three QC tasks (test-C-1, where it had made every commit of increment K AW's).
  const mergeNames = new Map<string, Set<string>>();
  for (const c of facts.commits.values()) {
    const defs = definitionsInSubject(c.subject).map((d) => d.num).filter((n) => known.has(n));
    if (defs.length) subjectDefs.set(c.hash, new Set([...(subjectDefs.get(c.hash) ?? []), ...defs]));
    if (!c.merge) continue;
    const named = mergeNamesIn(c.subject).filter((n) => known.has(n));
    if (named.length) mergeNames.set(c.hash, new Set(named));
  }
  const integrations = integrationsOf(facts);
  // Commits → units (see the module comment for the order of the rules).
  const commitUnits = new Map<string, string[]>();
  const byUnit = new Map<string, CommitFact[]>();
  const mergesOf = new Map<string, Map<string, CommitFact>>();
  const addMerge = (num: string, m: CommitFact) => { const x = mergesOf.get(num) ?? new Map<string, CommitFact>(); x.set(m.hash, m); mergesOf.set(num, x); };
  for (const c of facts.commits.values()) {
    if (c.merge) {
      for (const n of mergeNames.get(c.hash) ?? []) if (known.has(n) && c.fpTrunk) addMerge(n, c);
      continue;
    }
    let units = [...(subjectDefs.get(c.hash) ?? [])].filter((n) => known.has(n));
    if (units.length === 0 && !c.fpTrunk) {
      const fromBranches = new Set<string>();
      const onBranches = (facts.branchesOf.get(c.hash) ?? []).filter((b) => [...(branchUnits.get(b) ?? [])].some((n) => known.has(n)));
      const smallest = Math.min(...onBranches.map((b) => facts.branchCommits.get(b)?.size ?? Infinity));
      for (const b of onBranches.filter((x) => (facts.branchCommits.get(x)?.size ?? Infinity) === smallest)) for (const n of branchUnits.get(b) ?? []) if (known.has(n)) fromBranches.add(n);
      units = [...fromBranches];
      // The merges that brought it in, innermost first: the first that names a unit in its merge position (a branch
      // merged into an integration branch is named by its own merge, `Merge branch 'k-ledger' (AP: …)`, not by the
      // trunk's merge of the integration branch).
      for (const m of units.length === 0 ? integrations.chainOf(c.hash) : []) {
        const named = [...(mergeNames.get(m.merge.hash) ?? [])].filter((n) => known.has(n));
        if (named.length) { units = named; break; }
      }
    }
    if (units.length === 0) continue;
    commitUnits.set(c.hash, units);
    for (const n of units) {
      byUnit.set(n, [...(byUnit.get(n) ?? []), c]);
      const m = facts.introducedBy.get(c.hash);
      const mc = m ? facts.commits.get(m) : undefined;
      if (mc && mc.merge && m !== c.hash) addMerge(n, mc);
    }
  }
  // Runs name the prompt they ran and the report they wrote (`runs/AJ-1/status.json`: prompt …, report …).
  const runPairs = facts.arrangements.filter((a) => a.kind === 'status' && a.data.json)
    .map((a) => ({ prompt: pathKeyOf(a.data.json!.prompt), report: pathKeyOf(a.data.json!.report) }))
    .filter((x): x is { prompt: string; report: string } => x.prompt !== null && x.report !== null);
  const units = new Map<string, Unit>();
  /** The numbers the project gave to more than one task, with those tasks, oldest first. */
  const tasksOf = new Map<string, readonly Task[]>();
  for (const num of known) {
    // A number the ledger never saw anywhere (no arrangement, no commit, no line of any document or message) is no unit
    // the program can say anything about: its work item's process is left to the round's judged links.
    const own = facts.arrangementsByIdent.get(num) ?? [];
    if (own.length === 0 && !byUnit.has(num) && !mergesOf.has(num) && (nums.get(num)?.length ?? 0) === 0) continue;
    const tasks = tasksOfNumber(facts, num, own, (byUnit.get(num) ?? []).sort((a, b) => a.ms - b.ms), [...(mergesOf.get(num)?.values() ?? [])].sort((a, b) => a.ms - b.ms), runPairs);
    for (const task of tasks) units.set(task.key, unitOf(facts, task, branchUnits, num));
    if (tasks.length < 2) continue;
    tasksOf.set(num, tasks);
    // A commit of an earlier task with the number is that task's.
    for (const task of tasks) for (const c of task.commits) commitUnits.set(c.hash, (commitUnits.get(c.hash) ?? []).map((n) => (n === num ? task.key : n)));
  }
  // A work item carrying a number given to several tasks is the task its sources cite, else the one of its generation,
  // else the latest.
  if (tasksOf.size) {
    for (const t of threads) threadNums.set(t.id, threadNumbers(t).map((n) => { const tasks = tasksOf.get(n); return tasks ? taskOfThread(store, facts, t, tasks) : n; }));
    threadOf.clear();
    for (const t of threads) for (const n of threadNums.get(t.id)!) if (!threadOf.has(n)) threadOf.set(n, t.id);
  }
  /** A number named in a text written at `ms`: the task that had the number then. */
  const taskAt = (num: string, ms: number): string => {
    const tasks = tasksOf.get(num);
    if (!tasks) return num;
    return (tasks.filter((k) => k.start <= ms).pop() ?? tasks[0]!).key;
  };
  // Relations: only a fix or a check chains (a dependency does not).
  const unitNames = [...new Set([...units.keys()].map(baseNumber))].sort((a, b) => b.length - a.length);
  const nameRe = unitNames.length ? new RegExp(`(?<![A-Za-z0-9_])(${unitNames.map(escapeRe).join('|')})(?![A-Za-z0-9_]|-\\d|\\.\\d)`, 'g') : null;
  const namedAt = (text: string, ms: number): string[] => (nameRe ? [...new Set([...text.matchAll(nameRe)].map((m) => taskAt(m[1]!, ms)))] : []);
  const unitsOfCommit = (hash: string): string[] => {
    const c = facts.commitByPrefix(hash);
    if (!c) return [];
    const direct = commitUnits.get(c.hash);
    if (direct?.length) return [...direct];
    const subject = [...((c.merge ? mergeNames : subjectNames).get(c.hash) ?? [])].map((n) => taskAt(n, c.ms)).filter((u) => units.has(u));
    if (c.merge) {
      // What the merge brought in: its own integration's commits (a merge nested under the trunk's one included).
      const own = integrations.merges.find((m) => m.merge.hash === c.hash);
      const brought = new Set<string>();
      for (const [h, us] of commitUnits) if (own ? own.brought.has(h) : facts.introducedBy.get(h) === c.hash) for (const u of us) brought.add(u);
      for (const u of subject) brought.add(u);
      if (brought.size) return [...brought];
    }
    return subject;
  };
  const rel = new Map<string, Map<string, Relation>>();
  const addRel = (from: string, r: Relation) => {
    if (from === r.num || !units.has(r.num)) return;
    const m = rel.get(from) ?? new Map<string, Relation>();
    if (!m.has(r.num)) m.set(r.num, r);
    rel.set(from, m);
  };
  for (const u of units.values()) {
    const as: 'fix' | 'check' | null = u.nature === 'fix' ? 'fix' : u.nature === 'check' ? 'check' : null;
    const latest = u.prompts[u.prompts.length - 1] ?? u.receipts[u.receipts.length - 1];
    if (as && latest) {
      if (u.title) for (const n of namedAt(u.title, latest.ms)) addRel(u.num, { num: n, as, via: { entryId: latest.id, line: u.title } });
      for (const [k, v] of Object.entries(u.fields)) {
        if (FORWARD_FIELDS.test(k)) for (const n of namedAt(v, latest.ms)) addRel(u.num, { num: n, as, via: { entryId: latest.id, line: `${k}: ${v}` } });
        if (COMMIT_FIELDS.test(k)) {
          for (const h of v.match(/\b[0-9a-f]{7,40}\b/g) ?? []) for (const n of unitsOfCommit(h)) addRel(u.num, { num: n, as, via: { entryId: latest.id, line: `${k}: ${v}` } });
        }
      }
    }
    // The other direction: this unit's fields name its fixer or checker.
    const mine = u.prompts[u.prompts.length - 1];
    if (!mine) continue;
    for (const [k, v] of Object.entries(u.fields)) {
      const fixBy = REVERSE_FIX_FIELDS.test(k);
      const checkBy = REVERSE_CHECK_FIELDS.test(k);
      if (!fixBy && !checkBy) continue;
      for (const n of namedAt(v, mine.ms)) {
        const other = units.get(n);
        if (!other || other.num === u.num) continue;
        const kind: 'fix' | 'check' = other.nature === 'check' ? 'check' : other.nature === 'fix' ? 'fix' : checkBy ? 'check' : 'fix';
        addRel(n, { num: u.num, as: kind, via: { entryId: mine.id, line: `${k}: ${v}` } });
      }
    }
  }
  for (const [num, m] of rel) {
    const u = units.get(num)!;
    units.set(num, { ...u, relations: [...m.values()] });
  }
  return { units, threadNums, threadOf, nums, namedIn, commitUnits, integrations };
}

// ───────────────────────── one number, several tasks ─────────────────────────

/**
 * One task a number was given to. A project sometimes gives a number again: ContextKeeper's AJ was first an exam (甲 ·
 * 19 题, its report `reports/AJ-report.md`, dispatched 2026-09-20 from outside the repository) and then the Keeper's
 * read-boundary review (`AJ-sol-b2-read-boundary.md`, created 2026-09-21).
 */
interface Task {
  /** The number for the latest task, `NUM#k` for an earlier one (k counts the number's tasks from the oldest). */
  readonly key: string;
  /** When it was given out: its prompt's first version or `created_at`; for a task known only by its receipts, their date. */
  readonly start: number;
  readonly prompts: ArrangementFact[];
  readonly receipts: ArrangementFact[];
  readonly runs: ArrangementFact[];
  readonly commits: CommitFact[];
  readonly merges: CommitFact[];
}

/** The number a unit key stands for: `AJ#1` → `AJ`. */
export const baseNumber = (key: string): string => key.replace(/#\d+$/, '');

/** A path as a run file or a front-matter field writes it (`D:\\pk\\subagent\\reports\\AJ-report.md`), for comparing ends. */
function pathKeyOf(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().replace(/[\\/]+/g, '/').toLowerCase() : null;
}
/** Whether a written path (absolute, or relative to somewhere) is this repository path. */
const names = (written: string | null, rel: string): boolean => {
  if (written === null) return false;
  const r = rel.toLowerCase();
  return written === r || written.endsWith(`/${r}`) || r.endsWith(`/${written}`);
};
const stemOf = (path: string): string => (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '').toLowerCase();
const dayOfMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The tasks a number was given to, oldest first. Each prompt file of the number is a task of its own. A receipt goes to
 * the task whose prompt or run names it (`report: …`, a run's `report`), else whose prompt file its name continues
 * (`AJ-sol-b2-read-boundary-report.md` ↔ `AJ-sol-b2-read-boundary.md`), else by when it was written: one dated before
 * the number's first prompt was given out — every date written in it earlier, or, with none written, its first version
 * earlier — belongs to an earlier task the repository has no prompt for. Runs go by the prompt they name, commits and
 * merges by when they happened. A number with one task is one unit, as it always was.
 */
function tasksOfNumber(facts: Facts, num: string, own: readonly ArrangementFact[], commits: readonly CommitFact[], merges: readonly CommitFact[], runPairs: readonly { prompt: string; report: string }[]): Task[] {
  const prompts = own.filter((a) => a.kind === 'prompt' || (a.kind === 'plan' && a.data.fields?.id === num));
  const receipts = own.filter((a) => a.kind === 'receipt');
  const runs = own.filter((a) => a.kind === 'status');
  const byPath = new Map<string, ArrangementFact[]>();
  for (const p of prompts) byPath.set(p.path, [...(byPath.get(p.path) ?? []), p]);
  const created = (a: ArrangementFact) => msOf(materialTime(a.data.fields?.created_at ?? a.data.fields?.created ?? null)) ?? Infinity;
  const given = [...byPath].map(([path, versions]) => ({ path, versions, start: Math.min(...versions.map((v) => Math.min(v.ms, created(v)))) })).sort((a, b) => a.start - b.start);
  const all = (): Task[] => [{ key: num, start: given[0]?.start ?? 0, prompts: [...prompts], receipts: [...receipts], runs: [...runs], commits: [...commits], merges: [...merges] }];
  if (given.length === 0) return all();
  const out = given.map((g) => ({ path: g.path, start: g.start, prompts: g.versions, receipts: [] as ArrangementFact[], runs: [] as ArrangementFact[], commits: [] as CommitFact[], merges: [] as CommitFact[] }));
  const earlier: ArrangementFact[] = [];
  let earlierAt = Infinity;
  const at = (ms: number) => out.filter((t) => t.start <= ms).pop() ?? out[0]!;
  const byReceipt = new Map<string, ArrangementFact[]>();
  for (const r of receipts) byReceipt.set(r.path, [...(byReceipt.get(r.path) ?? []), r]);
  for (const [path, versions] of byReceipt) {
    const named = out.find((t) => t.prompts.some((v) => names(pathKeyOf(v.data.fields?.report ?? v.data.fields?.receipt), path)) || runPairs.some((x) => names(x.prompt, t.path) && names(x.report, path)));
    const stem = stemOf(path);
    const continued = out.filter((t) => { const s = stemOf(t.path); return stem.startsWith(`${s}-`) || stem.startsWith(`${s}_`); }).sort((x, y) => stemOf(y.path).length - stemOf(x.path).length)[0];
    let task = named ?? continued;
    if (!task) {
      const first = versions[0]!;
      const days = fullDatesIn(facts.textOf(first.id) ?? '').sort();
      const day = days[days.length - 1] ?? null;
      if (day ? day < dayOfMs(out[0]!.start) : first.ms < out[0]!.start) {
        earlier.push(...versions);
        earlierAt = Math.min(earlierAt, day ? msOf(day)! : first.ms);
        continue;
      }
      task = day ? out.filter((t) => dayOfMs(t.start) <= day).pop() ?? out[0]! : at(first.ms);
    }
    task.receipts.push(...versions);
  }
  for (const r of runs) {
    const prompt = pathKeyOf(r.data.json?.prompt);
    (out.find((t) => names(prompt, t.path)) ?? at(r.ms)).runs.push(r);
  }
  for (const c of commits) at(c.ms).commits.push(c);
  for (const m of merges) {
    const brought = out.find((t) => t.commits.some((c) => facts.introducedBy.get(c.hash) === m.hash));
    (brought ?? at(m.ms)).merges.push(m);
  }
  if (out.length === 1 && earlier.length === 0) return all();
  const byTime = (x: ArrangementFact, y: ArrangementFact) => x.ms - y.ms || x.path.localeCompare(y.path);
  const tasks = [
    ...(earlier.length ? [{ start: earlierAt, prompts: [], receipts: earlier, runs: [], commits: [], merges: [] }] : []),
    ...out,
  ];
  return tasks.map((t, i) => ({ ...t, receipts: [...t.receipts].sort(byTime), runs: [...t.runs].sort(byTime), key: i === tasks.length - 1 ? num : `${num}#${i + 1}` }));
}

/** A unit from one task: its arrangements, commits and merges, and what it is by its own words. */
function unitOf(facts: Facts, task: Task, branchUnits: ReadonlyMap<string, ReadonlySet<string>>, num: string): Unit {
  const { prompts, runs, commits } = task;
  const receipts = task.receipts.filter((a) => !isHostEvidence(a.path));
  const evidence = task.receipts.filter((a) => isHostEvidence(a.path));
  const latest = prompts[prompts.length - 1];
  const title = latest?.data.title ?? receipts[receipts.length - 1]?.data.title ?? null;
  const fields = latest?.data.fields ?? {};
  const codeCommits = commits.filter((c) => facts.filesOf(c).some((f) => !isArrangementPath(f.path)));
  const words = `${title ?? ''} ${fields.kind ?? ''} ${fields.type ?? ''}`;
  const nature: UnitNature = natureOf(fields.kind ?? fields.type ?? '', title ?? '') ?? (codeCommits.length === 0 && receipts.some((r) => hasVerdict(facts, r.path)) ? 'check' : 'work');
  const checkKind: CheckKind | null = nature !== 'check' ? null : WALK_WORDS.test(words) ? 'Walkthrough' : REVIEW_WORDS.test(words) ? 'Review' : 'QC';
  // Its branches, the one named after it first, then the one it was made on (the smallest that holds its commits).
  const namedAfter = (b: string) => Number((branchUnits.get(b) ?? new Set()).has(num));
  const branches = [...new Set(commits.flatMap((c) => facts.branchesOf.get(c.hash) ?? []))]
    .sort((x, y) => namedAfter(y) - namedAfter(x) || (facts.branchCommits.get(x)?.size ?? 0) - (facts.branchCommits.get(y)?.size ?? 0) || x.localeCompare(y));
  return {
    num: task.key, prompts, receipts, evidence, runs, title, fields, nature, checkKind, commits, branches, merges: task.merges,
    relations: [], executor: fields.executor ?? fields.agent ?? fields.worker ?? latest?.data.agent ?? runs[runs.length - 1]?.data.agent ?? null,
  };
}

/**
 * Which of a number's tasks a work item is: the one whose files or commits its sources cite most; else the one given out
 * within its generation; else the latest.
 */
function taskOfThread(store: ProjectStore, facts: Facts, t: WorkThread, tasks: readonly Task[]): string {
  const paths = new Set<string>();
  const hashes = new Set<string>();
  const sourceIds = new Set([
    ...(t.inputs?.sourceIds ?? []), ...t.pendingSourceIds, ...t.factRecordIds.flatMap((f) => store.facts.get(f)?.aboutSourceIds ?? []),
    ...[...t.executionFacts, ...t.qcFacts].flatMap((s) => s.sourceIds),
  ]);
  for (const sid of sourceIds) {
    const an = store.sources.get(sid)?.anchor;
    if (an?.kind === 'file') { const at = facts.relPathOf(an.path); if (at) paths.add(at.path); }
    if (an?.kind === 'revision') paths.add(an.path);
    if (an?.kind === 'commit' || an?.kind === 'revision') { const c = facts.commitByPrefix(an.commit); if (c) hashes.add(c.hash); }
  }
  const cited = (k: Task) => new Set([...k.prompts, ...k.receipts, ...k.runs].map((a) => a.path).filter((p) => paths.has(p))).size + k.commits.filter((c) => hashes.has(c.hash)).length;
  const best = tasks.map((k) => ({ k, n: cited(k) })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n || y.k.start - x.k.start)[0];
  if (best) return best.k.key;
  const g = earlierGenerationOf(store, t.id);   // CZ: work carried on under the same number is not tied to its generation's time
  if (g) {
    const from = msOf(g.started?.at) ?? -Infinity;
    const to = msOf(g.ended.at) ?? Infinity;
    const inside = tasks.filter((k) => k.start >= from && k.start <= to);
    if (inside.length) return inside[inside.length - 1]!.key;
  }
  return tasks[tasks.length - 1]!.key;
}

/**
 * What a unit is by its own words: a `kind` field decides; else, in the title, whichever comes first of the fix words and
 * the check words (`独立里程碑 QC：AK（BYOK 缺陷修复）` is a check of a fix; `修 AG 走查查出来的问题` is a fix).
 */
export function natureOf(kind: string, title: string): UnitNature | null {
  for (const text of [kind, title]) {
    if (!text) continue;
    const f = FIX_WORDS.exec(text);
    const c = CHECK_WORDS.exec(text);
    if (f && (!c || f.index <= c.index)) return 'fix';
    if (c) return 'check';
  }
  return null;
}

/** A receipt that is the host's evidence about a unit, not the unit's own account (`AB-evidence-grok.md`, `…-证据.md`). */
export function isHostEvidence(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return /(?:^|[-_.])(?:evidence|证据)(?:[-_.]|$)/i.test(base);
}

/** Whether a report states a verdict (a stated one, or verdicts in its headings). */
function hasVerdict(facts: Facts, path: string): boolean {
  return (facts.verdictsByPath.get(path) ?? []).some((v) => v.kind === 'verdict' && (v.confidence === 'stated' || /^#{1,6}\s/.test(v.text)));
}

/** Files that are the project's execution arrangements (prompts, receipts, the index, run files), not its product. */
export function isArrangementPath(path: string): boolean {
  return /(?:^|\/)subagents?\//i.test(path) || /(?:^|\/)execution-plan[^/]*\.md$/i.test(path);
}

/**
 * The work item a work item is a step of (§2.12): when every task of it fixes or checks another (it has relations), the
 * work its fixes and checks lead up to — AD, AF, AK and AO all lead to AB, through AF and AK where they fix or check
 * a check or a fix. The nearest work items reached, going up one relation at a time; exactly one, or null: a work item
 * with a task of its own is a piece of work of its own, and one that fixes or checks several separate pieces of work
 * (a milestone QC over AB and AC) belongs to none of them alone.
 */
export function stepOfThread(index: UnitIndex, threadId: string): string | null {
  const own = (index.threadNums.get(threadId) ?? []).map((n) => index.units.get(n)).filter((u): u is Unit => u !== undefined);
  if (own.length === 0 || own.some((u) => u.relations.length === 0)) return null;
  const seen = new Set(own.map((u) => u.num));
  const roots = new Set<string>();
  let level = own.flatMap((u) => u.relations.map((r) => r.num));
  while (level.length && roots.size === 0) {
    const next: string[] = [];
    for (const n of level) {
      if (seen.has(n)) continue;
      seen.add(n);
      const u = index.units.get(n);
      if (!u) continue;
      if (u.relations.length) { next.push(...u.relations.map((r) => r.num)); continue; }
      const t = index.threadOf.get(n);
      if (t && t !== threadId) roots.add(t);
    }
    level = next;
  }
  return roots.size === 1 ? [...roots][0]! : null;
}

/**
 * The units whose process a work item shows (§2.12): its own numbers, and, following the fix and check relations, every
 * unit that fixes or checks one of them — an AB → AD → AF → AK → AO chain. Oldest relation first.
 */
export function chainOf(index: UnitIndex, own: readonly string[]): string[] {
  const inChain = new Set(own.filter((n) => index.units.has(n)));
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of index.units.values()) {
      if (inChain.has(u.num)) continue;
      if (u.relations.some((r) => inChain.has(r.num))) { inChain.add(u.num); grew = true; }
    }
  }
  return [...inChain];
}
