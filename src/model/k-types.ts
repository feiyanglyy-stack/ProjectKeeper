/**
 * Increment K assets (Spec v3.0 §1.16–§1.19, §2.11–§2.13, §3.3, §3.11): what the clerk method places on the workbench
 * and the markers that hang on objects. The ledger itself — the program-built facts — lives in `src/ledger`; the records
 * here are either judgements written on a fixed workbench position, or program-computed markers kept so the owner's
 * responses and their history stay with them.
 *
 * Every record carries when its subject happened (`Occurred`, taken from the source by the program, never written by the
 * model; §2.11) apart from when the Keeper wrote it (`updatedAt`, the old `As of`).
 */
import type { Basis, TakeoverDepth } from './vocab.ts';

// ───────────────────────── §2.11 when it happened ─────────────────────────

export type OccurredBasis = 'Commit' | 'Session' | 'Written in text' | 'File time' | 'First observed';

export interface Occurred {
  /** ISO date or date-time at the precision the source gives: a date stays a date (§1.8). */
  readonly at: string;
  readonly basis: OccurredBasis;
  /** The ledger entry or source that gives the time. */
  readonly anchor: string | null;
  /** When two times disagree (the text says one day, the commit another) both are kept and shown (§2.11). */
  readonly other?: { readonly at: string; readonly basis: OccurredBasis; readonly anchor: string | null } | null;
  /** No time in the source: shown as `Undated · first seen <at>` and sorted by first observation (§2.11). */
  readonly undated?: boolean;
}

/**
 * CN (E152; Spec §2.12 没有痕迹，要读过才算): what an absence claim rests on — where it was looked for and up to when. A
 * note, a mark or a send-back that says something has no follow-up, was let pass or was taken up by nobody carries it,
 * as a breakpoint candidate carries where a lane looked (keeper/organize/absence.ts).
 */
export interface AbsenceLooked {
  /** Each place read, as the spot-check can open it again: a file with its section or lines, a ledger query, a commit range, a session. */
  readonly where: readonly string[];
  /** Up to when the reading reaches: the date or time of the newest commit, document version or report read. */
  readonly upTo: string;
  /** When sessions were read: the time of the last session message read. */
  readonly sessionsUpTo?: string | null;
  readonly roundId: string | null;
  readonly jobId: string | null;
  readonly at: string;
  /** Null when the look reached the ledger's present as it was written; else what lay beyond it, in words. */
  readonly behind: string | null;
}

/** One piece of evidence as the workbench names it: a ledger entry, a source, a commit, a file or another object. */
export interface EvidenceRef {
  readonly kind: 'ledger' | 'source' | 'commit' | 'file' | 'object';
  /** Ledger entry id, source id, full commit hash, repository-relative path, or object id. */
  readonly id: string;
  readonly label: string;
  /** The original line, verbatim, when the evidence is one line (a verdict, a rule, a heading). */
  readonly line?: string | null;
  readonly occurred?: Occurred | null;
  /** The repository it is in, when the project has more than one (a file's path is repository-relative). */
  readonly repo?: string | null;
}

/** §2.13: the six things the owner judges. 1 stale · 2 drift · 3 dropped along the way · 4 grown by itself · 5 let pass · 6 looks residual. */
export type SixThing = 1 | 2 | 3 | 4 | 5 | 6;

/** The owner's `No action needed` on a breakpoint or a send-back (§1.18, §2.12): it stops lighting up; the response stays. */
export interface NoActionNeeded {
  readonly text: 'No action needed';
  readonly reason: string;
  readonly at: string;
  readonly sourceId: string | null;
}

// ───────────────────────── §2.12 the process of a piece of work ─────────────────────────

export type StepKind =
  | 'Planned' | 'Dispatched' | 'Delivered' | 'QC' | 'Review' | 'Walkthrough' | 'Fix' | 'Merged' | 'Accepted'
  | 'Handed in' | 'Handed to';

/**
 * A link between a work item and a ledger entry that the program could not make from ids alone, judged by a step of the
 * round (§1.4: the model adds the associations the program cannot see) and confirmed by the cross-check (§3.3 step 4).
 */
export interface ProcessLink {
  readonly id: string;
  readonly projectId: string;
  readonly workId: string;
  readonly ledgerRef: string;
  /** The ledger entry as the evidence it is: label, the original line, its time. */
  readonly evidence?: EvidenceRef | null;
  readonly stepKind: StepKind;
  readonly why: string;
  readonly basis: 'Inferred';
  readonly confirmed: boolean;
  /**
   * The program's check of the link's evidence when it was written (CM): the fact resolves, a commit is in the ledger and
   * touches what the link claims, a cited line stands in its source. A link that passed is "lane-checked" and counts like a
   * confirmed one, the distinction kept visible; one that failed is suspect until the cross-check confirms or rejects it.
   * Absent on links written before the check.
   */
  readonly check?: LinkCheck | null;
  readonly roundId: string | null;
  readonly jobId: string | null;
  readonly at: string;
}

/** The program's check of a link's evidence (CM): passed or not, why, and when. */
export interface LinkCheck {
  readonly passed: boolean;
  readonly why: string;
  readonly at: string;
}

/** How far a link stands (CM): confirmed by the cross-check, lane-checked by the program, suspect, or not checked yet. */
export type LinkStanding = 'confirmed' | 'lane-checked' | 'suspect' | 'unconfirmed';
export const linkStanding = (l: Pick<ProcessLink, 'confirmed' | 'check'>): LinkStanding =>
  l.confirmed ? 'confirmed' : l.check?.passed === true ? 'lane-checked' : l.check?.passed === false ? 'suspect' : 'unconfirmed';
/** A link that counts for the process and the breakpoints: confirmed, or lane-checked (CM). */
export const linkHolds = (l: Pick<ProcessLink, 'confirmed' | 'check'>): boolean => l.confirmed || l.check?.passed === true;

export type BreakpointKind =
  | 'Not planned' | 'Not started' | 'Not merged' | 'No trace of done' | 'Not checked' | 'Findings open'
  | 'Passed with open items' | 'Fix not re-checked' | 'No plan' | 'Downstream behind' | 'Not carried out';

/**
 * §2.12 a next step that should be there and has no trace. An observation hanging on an object, not a ticket: later
 * evidence puts it out by itself; the owner's `No action needed` stops it lighting up. Whether the next step is due
 * follows the project's own rules (§1.15): ProjectKeeper adds no steps to a project.
 */
export interface Breakpoint {
  readonly id: string;
  readonly projectId: string;
  readonly kind: BreakpointKind;
  readonly targetId: string;
  /** One sentence: which step has no trace. */
  readonly why: string;
  readonly evidence: readonly EvidenceRef[];
  /** `Explicit` when the ledger's ids alone show it; `Inferred` when it rests on a judged link (§2.12). */
  readonly basis: Basis;
  /** When the missing step became due. */
  readonly since: Occurred;
  readonly lit: boolean;
  /** Put out: by later evidence the program found, by the owner, or by a step of a round that refuted it with evidence. */
  readonly out: { readonly at: string; readonly by: 'evidence' | 'owner' | 'model'; readonly evidence: readonly EvidenceRef[];
    /** The confirmation that refuted this family, including a refutation inherited by another downstream object. */
    readonly decision?: { readonly breakpointId: string; readonly at: string; readonly roundId: string | null };
  } | null;
  /** A Downstream behind family is identified by the exact ledger line, its reading, and the old side. */
  readonly familyBasis?: { readonly lineId: string; readonly syntax: string; readonly replaced: string };
  /** Past model refutations survive even if another basis temporarily lights the same target. */
  readonly familyRefutations?: readonly { readonly basis: NonNullable<Breakpoint['familyBasis']>;
    readonly decision: { readonly breakpointId: string; readonly at: string; readonly roundId: string | null };
    readonly evidence: readonly EvidenceRef[] }[];
  readonly ownerResponse: NoActionNeeded | null;
  /**
   * A lane looked for the missing step and did not find it (D99; Spec §2.12: 没有痕迹，要读过才算): where it looked.
   * Kept while the candidate still holds on the same evidence; absent or null until a lane has looked.
   */
  readonly looked?: { readonly roundId: string; readonly jobId: string | null; readonly where: readonly string[]; readonly at: string } | null;
  /** The independent check (the round's spot-check) confirmed it after a lane had looked: only then is it lit (D99). */
  readonly checked?: { readonly roundId: string; readonly jobId: string | null; readonly at: string } | null;
  readonly confirmedInRoundId: string | null;
  readonly sixThing: SixThing | null;
  readonly sendBackId: string | null;
  readonly roundId: string | null;
  readonly updatedAt: string;
}

// ───────────────────────── §1.18 send-backs ─────────────────────────

export type SendBackStage = 'Suggested' | 'Returned' | 'Closed';

/**
 * §1.18 a relation, not a ticket: a gap, a failure or a problem nobody handled goes back to Work; drift and staleness go
 * back to Plan. `Returned` and `Closed` are recognised from the ledger at the next Follow up, never set by hand.
 */
export interface SendBack {
  readonly id: string;
  readonly projectId: string;
  readonly to: 'Work' | 'Plan';
  readonly stage: SendBackStage;
  readonly targetId: string;
  /** Where the problem is. */
  readonly what: string;
  /** Where it should go back to: reopen or new work; a plan or document change. */
  readonly suggestion: string;
  readonly evidence: readonly EvidenceRef[];
  readonly from: { readonly kind: 'breakpoint' | 'verdict' | 'owner-judgement' | 'code-anomaly'; readonly id: string };
  readonly returned: { readonly by: EvidenceRef; readonly at: string; readonly basis: Basis } | null;
  readonly closed: { readonly by: EvidenceRef; readonly at: string } | null;
  readonly ownerResponse: NoActionNeeded | null;
  readonly sixThing: SixThing | null;
  /** CN: what was read before it was judged dropped along the way or let pass (keeper/organize/absence.ts). */
  readonly looked?: AbsenceLooked | null;
  /** When the problem it answers happened. */
  readonly occurred: Occurred;
  readonly roundId: string | null;
  readonly updatedAt: string;
}

// ───────────────────────── §1.17 the project folder: semantic patches, Keeper numbers ─────────────────────────

/**
 * §1.17 what a docs change of meaning withdrew and what took its place. Recognised from the ledger's explicit
 * supersessions (§1.16), numbered by the Keeper; the patch cites the decision and does not repeat its reasons.
 */
export interface SemanticPatch {
  readonly id: string;
  readonly projectId: string;
  /** The Keeper's number (the project's own number wins when the project numbers these). */
  readonly number: string;
  readonly title: string;
  /** Which part of the old state no longer holds. */
  readonly invalidated: string;
  /** What replaces it. */
  readonly replacedBy: string;
  /** Who is affected: object ids (documents, plans, work items, code territories) … */
  readonly affects: readonly string[];
  /** … and in words. */
  readonly affectsText: string;
  /** What must never again pass as current. */
  readonly mustNotPassAsCurrent: string;
  readonly oldAnchor: EvidenceRef;
  readonly newAnchor: EvidenceRef | null;
  /** The decision or commit that replaced it. */
  readonly decision: EvidenceRef | null;
  /** The ledger's explicit-supersession entry it came from. */
  readonly candidate: EvidenceRef;
  /** Only part of the old state is withdrawn; the rest stays current (CKC-26 AC-2). */
  readonly partial: boolean;
  readonly occurred: Occurred;
  /** The skeleton drafts it, the cross-check confirms or rejects it (§3.3). */
  readonly status: 'Draft' | 'Confirmed' | 'Rejected';
  readonly writtenToFolder: { readonly path: string; readonly commit: string | null; readonly at: string } | null;
  readonly roundId: string | null;
  readonly jobId: string | null;
  readonly updatedAt: string;
}

/** §1.17 a number the Keeper gave to something the project did not number (D72). */
export interface KeeperNumber {
  readonly id: string;
  readonly projectId: string;
  readonly number: string;
  readonly objectId: string;
  readonly objectKind: 'work' | 'decision' | 'patch' | 'other';
  /** Once the project numbers it itself, the project's number wins and the Keeper's stays as an alias. */
  readonly projectNumber: string | null;
  readonly at: string;
}

// ───────────────────────── §3.11 session drafts ─────────────────────────

export type OwnerLineKind = 'Chat' | 'Decision' | 'Confirmation';

/**
 * §3.11, D88: one per session. The owner's words verbatim, each marked chat or decision (a confirmation is a decision);
 * the agents' intents and reports summarised as claims. The ground the owner's words, the lineage, the deep sweeps and
 * the Keeper's recall stand on; not necessarily on the workbench, openable when a session is drilled into.
 */
export interface SessionDraft {
  readonly id: string;
  readonly projectId: string;
  readonly session: { readonly host: string; readonly sessionId: string; readonly file: string; readonly startedAt: string; readonly endedAt: string };
  readonly ownerLines: readonly {
    /** The ledger's message id. */
    readonly ref: string;
    readonly at: string;
    /** Verbatim. */
    readonly text: string;
    /** Null until judged. */
    readonly kind: OwnerLineKind | null;
    /** For a short confirmation: the agent message it answers (verbatim excerpt), taken by the program. */
    readonly answers: string | null;
    /** What the owner confirmed, in the Keeper's words: "the owner confirmed X's proposal to …" (§3.11). */
    readonly confirms: string | null;
  }[];
  /** Agents' intents and reports, as claims: who, when, what they said they did or meant to do. */
  readonly agentSummary: readonly { readonly at: string; readonly who: string; readonly summary: string }[];
  /** The job that wrote this version of the draft. */
  readonly jobId: string | null;
  readonly at: string;
  /**
   * Every job that wrote the draft, oldest first, and the round it was a step of: a session drafted in one round and
   * drafted again in a later one is listed under both rounds' session-drafts step (CKC-23 AC-18). Absent on drafts
   * written before it was kept; `jobId` then names the one writer known.
   */
  readonly writtenBy?: readonly { readonly jobId: string | null; readonly roundId: string | null; readonly at: string }[];
}

// ───────────────────────── §1.19 code territories ─────────────────────────

/**
 * §1.19 (D85), whether the current plan still uses a territory's code:
 * - `In current plan`: current code references it, and current work or requirements point at it — a work item of the
 *   current generation changed it, or the area it serves has current requirements, designs, decisions, plans or work;
 * - `In use, not in current plan`: current code references it, and nothing current in the plan points at it (QC AY: the
 *   first value used to be given on the references alone, which promised more than was checked);
 * - `Previous generation only`: only code that is almost all an earlier generation's still references it;
 * - `Unreferenced`: nothing reaches it from an entry point or current work;
 * - `Not known`: the territory holds no file in a language the ledger resolves dependencies for (§1.16), so nothing is
 *   claimed about its use either way.
 * The values are computed when the `Code` view is assembled and never stored.
 */
export type CurrentUse = 'In current plan' | 'In use, not in current plan' | 'Previous generation only' | 'Unreferenced' | 'Not known';
export type TerritoryAnomalyKind = 'Unreferenced' | 'Looks residual, is live' | 'Built without a claiming work item' | 'Docs disagree';

/**
 * §1.19 the judged half of a code territory: its name, what it is for, the area it serves, the anomalies. The numbers —
 * size, dependencies, who built it, which generation, tests, last change, current use — come from the ledger when the
 * `Code` view is assembled, so they are always the current version's.
 */
export interface CodeTerritory {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly summary: string;
  readonly repo: string;
  /** Repository-relative directories or files that make it up. */
  readonly paths: readonly string[];
  readonly kind: 'area' | 'shared' | 'non-product';
  /** The area (reference id) it mainly serves; null for shared and non-product code. */
  readonly areaId: string | null;
  /** Other areas it also serves: shown as "also serves N", expanded on hover (D74, D54). */
  readonly alsoServes: readonly string[];
  readonly anomalies: readonly {
    readonly kind: TerritoryAnomalyKind;
    readonly text: string;
    readonly evidence: readonly EvidenceRef[];
    readonly basis: Basis;
    readonly sendBackId: string | null;
    readonly noteIds: readonly string[];
    /** The one of the six things it is material for (§2.13; `Looks residual` is 6). */
    readonly sixThing?: SixThing | null;
  }[];
  readonly roundId: string | null;
  readonly jobId: string | null;
  readonly updatedAt: string;
}

// ───────────────────────── §2.12 generations of the plan ─────────────────────────

/**
 * §2.12, D85: an earlier generation of plans, cut only where the material says a version, restart, cleanup or decision
 * ended it (D25). Shown rolled up before the current plan; unrolled it reads like the current generation.
 */
export interface Generation {
  readonly id: string;
  readonly projectId: string;
  /** The material's own name for it, e.g. "Module v0.2–v0.3". */
  readonly name: string;
  readonly started: Occurred | null;
  readonly ended: Occurred;
  /** The decision, cleanup or restart that ended it. */
  readonly endedBy: EvidenceRef;
  /** Its plan documents; deleted ones are read from the commit before their deletion (D82). */
  readonly planRefs: readonly EvidenceRef[];
  /** The work items planned in it. */
  readonly workIds: readonly string[];
  readonly roundId: string | null;
  readonly updatedAt: string;
}

// ───────────────────────── §3.3 orientation: which file is which layer ─────────────────────────

export type LayerKind =
  | 'Product' | 'PRD' | 'Spec' | 'Plan' | 'Task index' | 'Task contract' | 'Decision record' | 'Execution arrangement'
  | 'QC and receipts' | 'Readme' | 'Instructions' | 'Other';

export interface LayerEntry {
  readonly id: string;
  readonly projectId: string;
  readonly repo: string | null;
  readonly path: string;
  readonly layer: LayerKind;
  readonly note: string | null;
  readonly current: boolean;
  readonly roundId: string | null;
  readonly updatedAt: string;
}

// ───────────────────────── §3.3, §3.10 a round of the clerk method ─────────────────────────

/**
 * The jobs of one round (§3.3). D99: a round is the ledger and the session drafts (the program's groundwork), then `main`
 * — one model job, one pi session, through the stages (`ClerkStage`) — whose `lane` jobs it sends; D103: then `synthesis`,
 * the round's product look-back in a pi session of its own, which the main agent hands over to after its last check; then
 * the independent `spot-check` and the program's `process`. The earlier kinds (`orientation`, `skeleton`, `dig`,
 * `cross-check`) are the rounds before D99, kept so their records read.
 */
export type RoundStepKind = 'ledger' | 'session-drafts' | 'orientation' | 'skeleton' | 'dig' | 'cross-check' | 'process' | 'synthesis' | 'spot-check' | 'main' | 'lane';

/**
 * The stages the main agent goes through in one session (D99; Spec §3.3): each has a skill. D103: `synthesis` is no
 * stage of the main agent's any more — it is what the main agent hands over to (`pk_stage({ to: "synthesis" })`), a job
 * of its own; the word stays for the rounds recorded before, whose stage log ends with it.
 */
export type ClerkStage = 'orientation' | 'skeleton' | 'reconcile' | 'dig' | 'coverage' | 'cross-check' | 'synthesis';

/** What a lane answers (D99): a group of slots (first usable), a plan or stage, a topic, or what the coverage check left. */
export type LaneKind = 'slot' | 'plan' | 'topic' | 'follow-up';

/**
 * A slot a lane may write (D99; Spec §3.3 "工作台是一道填空题"): a kind of position, not an item. `reference:<category>`
 * is the reference items of one category (Goal, Area, Requirement, Design, Decision, Plan, …); the others are the work
 * items with their numbers, the process links, the code territories, the draft semantic patches, the generations, and
 * the relations between items. Every lane may also write its own Report and record where it looked.
 */
export type SlotKind = `reference:${string}` | 'threads' | 'links' | 'territories' | 'patches' | 'generations' | 'relations';

/** DB: a workbench slot the main agent gave to no lane, with its reason (keeper/organize/slots.ts `SKELETON_SLOTS`). */
export interface EmptySlot {
  readonly slot: SlotKind;
  readonly why: string;
  readonly at: string;
}

/** One stage of the main agent's session, as the round records it (§3.10: the time of each). */
export interface StageEntry {
  readonly stage: ClerkStage;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** The main job's time spent in this stage; null while it runs. */
  readonly timing: StepTiming | null;
  /** Why the main agent skipped the stages before this one, or left a kind of question without a lane (`pk_stage` why). */
  readonly why?: string | null;
}

/** A lane the main agent sent (D99): its question in its brief, the slots it writes, its job. */
export interface RoundLane {
  readonly name: string;
  readonly kind: LaneKind;
  /** The lane's brief, a `Brief` round document the main agent wrote before sending it. */
  readonly briefDocId: string;
  readonly slots: readonly SlotKind[];
  readonly jobId: string;
  /** The stage the main agent was in when it sent the lane. */
  readonly stage: ClerkStage;
  readonly sentAt: string;
  /** Its `Report` round document, once written. */
  readonly reportDocId: string | null;
}

/** The main agent's account of a material, or a group of materials, no lane touched (D99 coverage check). */
export interface MaterialAccount {
  /** Material keys (as the coverage check lists them), or one group (a category, or a category and a directory). */
  readonly keys?: readonly string[];
  readonly group?: string | null;
  readonly outcome: 'not needed' | 'part';
  readonly why: string;
  readonly by: 'main' | 'program';
  readonly at: string;
  /** DA: what the material held that nothing carries when it was accounted for by its key, in the program's words; absent when it held nothing. */
  readonly holds?: string | null;
}

/** DA: one kind of thing a listed group holds that nothing on the workbench carries: how many, and a few of them. */
export interface HoldCount {
  readonly count: number;
  readonly examples: readonly string[];
}

/**
 * DA: what a group the coverage check lists holds that nothing carries (keeper/organize/coverage-tools.ts `holdsOf`):
 * stated verdict lines of its documents that no link or fact of a work item cites; numbers its documents define as
 * entries that no item carries and no account names; the owner's lines not looked at yet that its documents quote or
 * its sessions hold. A group that holds any of these is not accounted for as a group.
 */
export interface GroupHolds {
  readonly verdictLines?: HoldCount;
  readonly numbers?: HoldCount;
  readonly ownerQuotes?: HoldCount;
  /** The materials of the group that hold any of these, by key. */
  readonly materials: readonly string[];
}

/** A group of materials the coverage check found no lane touched (D99; the shape `pk_coverage_check` lists them in). */
export interface CoverageGroup {
  readonly group: string;
  readonly category: string;
  readonly dir: string | null;
  readonly count: number;
  readonly bytes: number;
  /** The first material keys of the group (up to 20). */
  readonly keys: readonly string[];
  /** DA: what it holds that nothing carries; absent when it holds nothing, and on checks recorded before DA. */
  readonly holds?: GroupHolds;
}

/** A round's coverage check (D99; Spec §3.3 每份材料都有交代): what it found untouched, and what is accounted for. */
export interface RoundCoverage {
  readonly at: string;
  readonly accounted: readonly MaterialAccount[];
  /** Every listed material is read, accounted for, or in a follow-up lane that has ended. */
  readonly settled: boolean;
  /**
   * What the last check (`at`) listed as touched by no lane, as `pk_coverage_check` returned it: the Keeper view shows it
   * (Spec §6.9: 覆盖检查列出的材料与主 agent 的交代点得开). Absent when the check did not record its listing.
   */
  readonly untouched?: readonly CoverageGroup[] | null;
}
export type RoundKind = 'First usable' | 'Deepen' | 'Follow up';

/** Where the time of one step or path went (§3.10): the four parts D81 asks for, plus what cannot be told apart. */
export interface StepTiming {
  readonly wallMs: number;
  readonly generationMs: number;
  readonly toolMs: number;
  readonly queueMs: number;
  readonly parseRetryMs: number;
  readonly otherMs: number;
}

export type RoundDocKind = 'History map' | 'Questions' | 'Brief' | 'Report' | 'Adoption' | 'Handover' | 'Spot check' | 'Layers' | 'Result';

/**
 * A document a round leaves behind (§3.3 "留痕点得开"): the history map and question list from orientation, each deep
 * sweep's brief and full report, the cross-check's adoption record, the main agent's handover to the synthesis (D103),
 * the spot check. Full text, never shortened.
 */
export interface RoundDoc {
  readonly id: string;
  readonly projectId: string;
  readonly roundId: string;
  readonly jobId: string | null;
  readonly kind: RoundDocKind;
  /** The deep sweep's name, for briefs and reports. */
  readonly path: string | null;
  readonly title: string;
  readonly markdown: string;
  readonly at: string;
  /**
   * A report written by one reading assignment of the sweep (§3.3, §3.7): the assignment's id in the round's reading
   * record. The sweep's reports are then one per assignment, together the path's report.
   */
  readonly assignment?: string | null;
  /**
   * What the assignment says it could not read in full, each material on its list by its key, whether it read part of it
   * or none, and why — the program holds this against what the assignment's recorded reads show.
   */
  readonly unread?: readonly { readonly material: string; readonly read: 'part' | 'none'; readonly why: string }[];
}

// ───────────────────────── §3.3, §3.7 a deepening's reading assignments ─────────────────────────

/** The units a Full deepening plans (§3.7: 按问题清单算), and the one a path counted by the ledger's totals adds: sessions. */
export type ReadingCategory = 'document versions' | 'code files' | 'commits' | 'sessions';

/**
 * One material a path of a Full deepening plans to read (§3.7), as the program placed it when the sweeps started: what it
 * is, what it is kept with, how much there is to read, how it is read, and where it is — what the program holds the
 * assignment's recorded reads against.
 */
export interface ReadingMaterial {
  /** `doc:<path>@<commit>` (a document version), `<repo>:<path>` (a code file), `commit:<hash>`, `session:<id>` (the ledger's ids). */
  readonly key: string;
  readonly category: ReadingCategory;
  readonly label: string;
  /** What it stays with in an assignment: a document's versions, a directory's files, a merge's commits, a session. */
  readonly group: string;
  /** About how much text there is to read, in bytes: what the assignments are sized by. */
  readonly bytes: number;
  /** How it is read, in the words its assignment gives the step. */
  readonly how: string;
  /** A document version or a code file: the file, absolute. */
  readonly file?: string | null;
  /** A document version: the commit it is at. */
  readonly rev?: string | null;
  /** A document version that stands for the file as it is now: reading the file reads it. */
  readonly current?: boolean;
  readonly lines?: number | null;
  /**
   * An older version of a document read through what it changed: the version after it (its key), and this version's own
   * lines that differ from that one (1-based, inclusive). The rest of its text is that version's.
   */
  readonly next?: string | null;
  readonly diff?: readonly (readonly [number, number])[] | null;
  /** A session: its ledger id and how many messages the ledger holds of it. */
  readonly session?: string | null;
  readonly messages?: number | null;
}

/** One reading assignment: a deep-sweep job with its own list of the path's materials (§3.3 step 3, §3.7). */
export interface ReadingAssignment {
  readonly id: string;
  /** Its number within the path, from 1. */
  readonly n: number;
  readonly jobId: string | null;
  readonly keys: readonly string[];
  /**
   * A material too large for one assignment is read in parts: the lines (a session's: message positions) this assignment
   * reads of it, by its key. The material counts as read whole once its parts together are.
   */
  readonly ranges?: Readonly<Record<string, readonly [number, number]>>;
  /** The path's earlier assignments whose unread material it takes up; empty for a first assignment. */
  readonly followUpOf: readonly number[];
  readonly bytes: number;
  readonly at: string;
  /** When the program held what it read against its list, once it ended; null until then. */
  readonly handledAt?: string | null;
}

/** A planned material the round records as read in part, or not read, with why and who said it. */
export interface ReadingAccount {
  readonly key: string;
  readonly outcome: 'part' | 'none';
  readonly why: string;
  readonly by: 'assignment' | 'program';
  readonly at: string;
}

/** One path of the deepening: its planned materials, its assignments, and what is accounted for. */
export interface RoundReadingPath {
  readonly path: string;
  /** How the plan counted the path (what its brief names, or the ledger's totals for its kind of question). */
  readonly basis: string;
  readonly materials: readonly ReadingMaterial[];
  readonly assignments: readonly ReadingAssignment[];
  readonly accounted: readonly ReadingAccount[];
  /** Every planned material is read whole, or recorded read in part or not read with why, and no assignment runs. */
  readonly complete: boolean;
}

/**
 * A Full deepening's reading (Spec §3.3, §3.7; the owner's approval of 2026-09-28: 「好的，需要的。」): each path's planned
 * material split into reading assignments on the lanes; the round's cross-check starts only once every planned material
 * is accounted for.
 */
export interface RoundReading {
  readonly at: string;
  /** What an assignment is sized to, and why. */
  readonly budget: { readonly bytes: number; readonly basis: string };
  readonly paths: readonly RoundReadingPath[];
}

export interface SpotCheck {
  readonly sampled: number;
  readonly wrong: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly corrected: number;
  /** What was checked, so a check repeated in another session is not counted twice. */
  readonly targets?: readonly { readonly collection: string; readonly id: string; readonly kind: string; readonly wrong: boolean; readonly corrected: boolean; readonly wrongKind?: SpotWrongKind | null }[];
  /**
   * D103: the synthesis' outputs — every note it wrote or changed, every six-things judgement it made, the round's
   * Result — are checked in full, not sampled, and counted apart from the sample: how many there are, how many of them
   * the spot-check recorded, and how many it found wrong. Absent on a round with no synthesis job.
   */
  readonly synthesis?: { readonly outputs: number; readonly checked: number; readonly wrong: number };
  /** CM: of the wrong ones, how many were wrong only because of when the state was read (a candidate recomputed later, a link confirmed after) and how many in substance. */
  readonly wrongByKind?: { readonly timing: number; readonly substance: number };
  /**
   * CS (D104): the placement readings, counted apart — the reasons that left an item unplaced (`noPlanWhy`, `noAreaWhy`,
   * `wholeProductWhy`), whichever round wrote them, that this spot-check was given, how many of them it recorded and how
   * many it found wrong; and of the program's Inferred placements nobody had reviewed, how many it sampled and found wrong.
   */
  readonly placement?: SpotCheckPlacement;
  /**
   * CS: each reason this spot-check recorded, with the reason's words as it checked them and the outcome. A reason found
   * right and unchanged since is not a target of a later round's spot-check; one that changed, or one found wrong and
   * still standing, is a target again (process/breakpoint-candidates.ts `uncheckedReasons`).
   */
  readonly reasonChecks?: readonly ReasonCheck[];
}

/** CS: the spot-check's count of the placement readings (Spec §3.3; CKC-23 AC-9). */
export interface SpotCheckPlacement {
  readonly reasons: number;
  readonly reasonsChecked: number;
  readonly reasonsWrong: number;
  readonly programPlacementsSampled: number;
  readonly programPlacementsWrong: number;
}

/** CS: one reason that leaves an item unplaced — which item, which reason, and its words. */
export interface ReasonTarget {
  readonly collection: 'threads' | 'reference';
  readonly id: string;
  readonly field: 'noPlanWhy' | 'noAreaWhy' | 'wholeProductWhy';
  readonly reason: string;
}

/** CS: a reason a spot-check recorded: its words as checked, and the outcome. */
export interface ReasonCheck extends ReasonTarget {
  readonly wrong: boolean;
  readonly at: string;
}

/**
 * CS: what a round's spot-check was given of the placement readings, fixed as it started, so its own corrections (a
 * reason cleared with a placement, a program placement moved) take nothing away from what it is counted against.
 */
export interface PlacementCheckPlan {
  readonly at: string;
  readonly reasons: readonly ReasonTarget[];
  /** The program's unreviewed placements in the sample, each by the item and the Area or Plan it was placed on. */
  readonly placements: readonly { readonly kind: InferredPlacement['kind']; readonly id: string; readonly targetId: string }[];
}

/** CM: a wrong the spot-check found is a state-timing wrong (right when written, overtaken by a later write or recompute) or a wrong of substance. */
export type SpotWrongKind = 'timing' | 'substance';

/**
 * One round of the clerk method (§3.3, §3.10): the takeover's first usable round, a deepening round, or a Follow up. Its
 * steps are jobs under `rootJobId`; what it produced is counted by the program from what its steps wrote (CKC-23 AC-6).
 * A Follow up round also has the Follow up round record the propagation judgements hang on (`followUpRoundId`).
 */
export interface ClerkRound {
  readonly id: string;
  readonly projectId: string;
  readonly kind: RoundKind;
  readonly number: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly status: 'Running' | 'Done' | 'Stopped' | 'Failed';
  readonly rootJobId: string;
  /** Orientation's question list for the deepening (a `RoundDoc`), and the deep sweeps it set. */
  readonly questionsDocId: string | null;
  readonly paths: readonly string[];
  readonly outputs: readonly { readonly position: string; readonly count: number }[];
  readonly groundwork: readonly { readonly kind: string; readonly count: number }[];
  readonly unplaced: { readonly count: number; readonly reasons: readonly string[] };
  readonly spotCheck: SpotCheck | null;
  readonly ledger: { readonly ms: number; readonly commitsAdded: number } | null;
  readonly followUpRoundId: string | null;
  /** A deepening: the depth it ran at, recorded when it started (D105: the page says what ran, not what was pressed last). */
  readonly depth?: TakeoverDepth | null;
  /** A Follow up: what started it — the owner's `Follow up`, a scheduled time, or the `Continuous` schedule (§3.8; the `Daily` page says which). */
  readonly startedBy?: 'owner' | 'schedule' | 'continuous' | null;
  /** What the round's end did with the project's `projectkeeper/` folder, or why it could not (CKC-26 AC-8); null when not authorized. */
  readonly folder?: string | null;
  /**
   * The sweeps the program added to a takeover's deepening for the kinds of question orientation set no sweep for, each
   * with why (CKC-23 AC-4: at least the four kinds of Spec §3.3); their briefs are round documents of this round.
   */
  readonly sweepsAdded?: readonly { readonly path: string; readonly why: string }[];
  /** A Follow up round: the state of its news positions when it started, to tell what it made new (§3.8); dropped when it closes. */
  readonly baseline?: RoundBaseline | null;
  /** A Full deepening: its sweeps' reading assignments and what is accounted for (§3.3, §3.7); absent on other rounds. */
  readonly reading?: RoundReading | null;
  /** D99: the stage the main agent is in, and the stages it went through; absent on rounds before D99. */
  readonly stage?: ClerkStage | null;
  readonly stageLog?: readonly StageEntry[];
  /**
   * D103: the main agent handed the round over to the synthesis after its last stage — when, and its `Handover` round
   * document (what it settled, what it left open and why, what the synthesis should look at first). Its stage log ends
   * there; the synthesis is a job of its own. Absent until then, and on rounds before D103.
   */
  readonly handover?: { readonly at: string; readonly docId: string; /** Why it handed over with a gate left open (`pk_stage` why). */ readonly why?: string | null } | null;
  /**
   * D103 (CKC-08 AC-25): what a deepening or a Follow up did with the notes that were current when it began — how many
   * there were, how many its synthesis confirmed as still holding, updated or withdrew, and how many got no result —
   * counted by the program as the round closes (keeper/organize/standing-notes.ts). Absent on a first usable round.
   */
  readonly standingNotes?: { readonly standing: number; readonly confirmed: number; readonly updated: number; readonly withdrawn: number; readonly open: number } | null;
  /** D99: the lanes the main agent sent, in the order sent. */
  readonly lanes?: readonly RoundLane[];
  /**
   * DB: the workbench slots no lane of a first usable round's skeleton held, each with the main agent's one line on why
   * the project has nothing for it (`pk_send_lanes` `empty`; keeper/organize/slots.ts). The next spot-check is shown
   * them. Absent when every slot was held by a lane.
   */
  readonly emptySlots?: readonly EmptySlot[];
  /** D99: the coverage check of a deepening; null until the main agent enters it. */
  readonly coverage?: RoundCoverage | null;
  /**
   * What did not finish (Spec §3.10: 多次失败后停下，列入失败清单并写明原因，不静默跳过): each job of a step that still failed
   * after the program ran it again, or that its time limit stopped. The round went on without it, and it closes `Done`
   * with these listed; absent or empty when every step finished.
   */
  readonly failures?: readonly RoundFailure[];
  /**
   * CJ: the numbers of a current decision record, plan, task index or execution arrangement the main agent accounted for
   * by number, with why, instead of making them items (`pk_account_entries`); absent when it accounted for none.
   */
  readonly entryAccounts?: readonly EntryAccount[];
  /** CM: the candidate generations the main agent accepted or rejected (pk_generation_candidate), so a rejected one is not listed again. */
  readonly generationVerdicts?: readonly GenerationVerdict[];
  /**
   * DA: the owner's lines judged in this round to need nothing — for their moment only — each by its line reference,
   * with why (`pk_judge_owner_lines`). A line judged once is not listed again in a later round while its words stand; the
   * round's spot-check samples them.
   */
  readonly ownerLineJudgements?: readonly OwnerLineJudgement[];
  /**
   * CQ (D104): the placements the program wrote itself in this round, basis Inferred, each with the chain of records it
   * followed (keeper/organize/placement-inference.ts), and what the main agent or a lane did with it since. CS: one with
   * no result stays listed in every later round (`pk_round_state` `inferredPlacements` covers every round's) until a
   * write confirms or moves it — the result lands here, on the record of the round that placed it; the spot-check samples
   * the ones with no result.
   */
  readonly inferredPlacements?: readonly InferredPlacement[];
  /** CS: what this round's spot-check was given of the placement readings, fixed as it started; absent before, and on a round with no spot-check. */
  readonly placementCheck?: PlacementCheckPlan | null;
  readonly updatedAt: string;
}

/** CQ (D104): one placement the program wrote from the records, and its fate. */
export interface InferredPlacement {
  /** The item placed: a work item (`thread`) or a decision or boundary (`reference`). */
  readonly kind: 'thread' | 'reference';
  readonly id: string;
  readonly name: string;
  /** The Area or Plan it was placed on, by id, and by its short name. */
  readonly targetId: string;
  readonly target: string;
  readonly targetCategory: 'Area' | 'Plan';
  /** The chain of records the program followed, in one sentence; the `serves` claim carries the same words. */
  readonly chain: string;
  readonly at: string;
  /** The stage the program placed it in: entering reconcile, entering the cross-check, or at the handover. */
  readonly stage: string;
  readonly jobId: string | null;
  /**
   * What became of it since: a model's write kept it as its own, or the spot-check checked it and found it right
   * (`confirmed`); a write replaced or removed it (`moved`, with where to). Absent while nobody touched it: it stands as
   * placed and stays listed. CS: `roundId` is the round the result was written in (a later one than the round that
   * placed it, when it carried over), `by` who gave it — a model's write, the spot-check's record, or the program finding
   * the placement no longer on the item.
   */
  readonly result?: { readonly kind: 'confirmed' | 'moved'; readonly at: string; readonly to?: string; readonly roundId?: string | null; readonly by?: 'write' | 'spot-check' | 'program' } | null;
}

/** CM: the main agent's verdict on a candidate generation the program listed. */
export interface GenerationVerdict {
  readonly key: string;
  readonly accepted: boolean;
  readonly why: string;
  readonly generationId: string | null;
  readonly at: string;
}

/** DA: an owner's line judged to need nothing (Spec §1.3, §3.11): the third outcome of a line, beside cited and not looked at yet. */
export interface OwnerLineJudgement {
  /** The session draft the line is in, and the line's ref there. */
  readonly draftId: string;
  readonly ref: string;
  /** How the line's words began when it was judged (folded): a line whose words changed since is looked at again. */
  readonly head: string;
  readonly why: string;
  readonly by: 'main' | 'lane';
  /** The lane's name, when a lane judged it. */
  readonly lane?: string | null;
  readonly jobId: string;
  readonly at: string;
}

/** Numbers of one document the main agent accounted for, each by its number (CJ; E150: an account in bulk is not one). */
export interface EntryAccount {
  /** The document, repository-relative, as the gate names it. */
  readonly path: string;
  readonly numbers: readonly string[];
  readonly why: string;
  readonly at: string;
}

/** A job of a round's step that did not finish, as the round lists it (`ClerkRound.failures`). */
export interface RoundFailure {
  readonly jobId: string;
  readonly step: RoundStepKind;
  /** The job's label (a sweep's name and assignment, a drafts batch). */
  readonly label: string;
  readonly status: 'Failed' | 'Stopped';
  /** Why its last run ended. */
  readonly reason: string;
  /** How many times it ran: the first run and every run again. */
  readonly runs: number;
  /** When it was listed. */
  readonly at: string;
}

/**
 * Where the five kinds of Follow up news stood when a round started (Spec §3.8, §5.5; CKC-07 AC-27, CKC-24 AC-15): the
 * breakpoints lit, each send-back's stage, each six-thing tag, the semantic patches confirmed, each note's version count.
 * What the round's jobs wrote is compared with it when the round closes.
 */
export interface RoundBaseline {
  readonly litBreakpoints: readonly string[];
  readonly sendbackStages: Readonly<Record<string, SendBackStage>>;
  /** `<kind>:<id>` (a territory anomaly: `anomaly:<territory>:<kind>:<text>`) → the thing it was, for what was live. */
  readonly sixThings: Readonly<Record<string, SixThing>>;
  readonly confirmedPatches: readonly string[];
  readonly noteVersions: Readonly<Record<string, number>>;
}

/** One new thing of a Follow up round, where it is (§3.8: "各带位置"). */
export interface RoundNewsItem {
  /** The breakpoint, send-back, patch or note; for a six-thing item, the object tagged. */
  readonly id: string;
  /** What it is, in one line: "Findings open on T-1 Hand picking". */
  readonly label: string;
  /** Where on the workbench it is: the view and the object, e.g. "Process view · T-1 Hand picking". */
  readonly position: string;
  /** The object it hangs on, to locate it (graph node, work item, reference item, territory); null when none. */
  readonly objectId: string | null;
  /** What changed for it this round: "new · Suggested", "Suggested → Returned", "5 let pass", "v2". */
  readonly detail: string | null;
}

/**
 * What a Follow up round made new (§3.8, D79; CKC-07 AC-27, CKC-24 AC-15), counted by the program from what the round's
 * jobs wrote, compared with where things stood when it started. `nothingNew`: the five are empty and no object was left
 * behind — the top bar says the last round found nothing new.
 */
export interface RoundNews {
  readonly breakpoints: readonly RoundNewsItem[];
  readonly sendbacks: readonly RoundNewsItem[];
  readonly sixThings: readonly RoundNewsItem[];
  readonly patches: readonly RoundNewsItem[];
  readonly notes: readonly RoundNewsItem[];
  readonly nothingNew: boolean;
  /** One line a person reads: "2 breakpoints newly lit · 1 new send-back" or "Nothing new". */
  readonly statement: string;
  /** False when the round started before the baseline was kept: the send-backs moved, the six things and the patches of such a round are not counted. */
  readonly complete: boolean;
}
