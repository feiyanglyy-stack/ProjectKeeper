/**
 * What the workbench receives for increment K (Spec v3.0 §6.3 process view, §6.17 `Code`, §6.4 versions and
 * `How it got here`, §6.9 a round's tree, §6.7 Project scope). The server assembles these from the assets and the
 * ledger; the UI only draws them. Every list is already sorted by when things happened (§2.11), oldest first, unless
 * a field says otherwise; the UI never re-sorts by `updatedAt`.
 *
 * Endpoints (JSON):
 *   GET  /api/projects/:id/process                        → ProcessView
 *   GET  /api/projects/:id/objects/:oid/lineage           → LineageView
 *   GET  /api/projects/:id/objects/:oid/versions          → VersionsView
 *   GET  /api/projects/:id/code                           → CodeView
 *   GET  /api/projects/:id/code/territories/:tid          → TerritoryDetailView
 *   GET  /api/projects/:id/k-rounds                       → RoundView[]            (newest first)
 *   GET  /api/projects/:id/k-rounds/:rid/docs/:docId      → RoundDocView
 *   GET  /api/projects/:id/scope-k                        → ScopeKView
 *   GET  /api/projects/:id/patches                        → { patches: PatchView[] }       (oldest first, by when it happened)
 *   GET  /api/projects/:id/patches/:pid                   → PatchView with its `text`       (a patch's details; also by SP-n)
 *   GET  /api/projects/:id/code/file?path=&repo=          → CodeFileTextView                (a file of the current version)
 *   GET  /api/projects/:id/generations/:gid/plans/:n      → GenerationPlanTextView          (an earlier generation's plan document)
 *   GET  /api/projects/:id/drafts[?objectId=]             → { drafts: SessionDraftRef[] }   (server/drafts-api.ts)
 *   GET  /api/projects/:id/drafts/:key                    → SessionDraftView                (key: draft id, session source id, host:session, session id)
 *   POST /api/projects/:id/breakpoints/:bid/response      body { reason }  → BreakpointView   (`No action needed`)
 *   POST /api/projects/:id/sendbacks/:sid/response        body { reason }  → SendBackView     (`No action needed`)
 *
 * Object ids are graph node ids (`/api/projects/:id/graph`), so these views hang on the nodes the graph and the List
 * already draw.
 */
import type {
  BreakpointKind, ClerkStage, CoverageGroup, CurrentUse, EvidenceRef, LaneKind, LayerKind, MaterialAccount, Occurred, RoundDocKind, RoundKind,
  RoundStepKind, SendBackStage, SixThing, SlotKind, StepKind, StepTiming, TerritoryAnomalyKind,
} from './k-types.ts';
import type { Usage } from './types.ts';

// ───────────────────────── shared ─────────────────────────

export interface NumberView {
  readonly value: string;
  /** The project had no number for it and the Keeper gave one (§1.17): the UI says so. */
  readonly byKeeper: boolean;
}

export interface NoActionView { readonly reason: string; readonly at: string }

// ───────────────────────── §6.3 the process view (Graph and List) ─────────────────────────

/** One step of a piece of work (§2.12): what was done on the left, what reality gave on the right. */
export interface ProcessStepView {
  readonly id: string;
  readonly kind: StepKind;
  readonly occurred: Occurred;
  /** Left: what was done, e.g. "AB delivered — no receipt, rebuilt from the diff". */
  readonly did: string;
  /** The project's number of the task that made this step (a fix, a check), when it is a task of its own, e.g. "AD". */
  readonly unit?: string | null;
  /** Right: what reality gave, e.g. "merged 42a86f5 · 12 tests", "Fail · 7 findings". */
  readonly result: string;
  /** The verdict exactly as the report wrote it, for QC / Review / Walkthrough. */
  readonly verdict: string | null;
  /** Agent, window or worktree bound to it, when the arrangement or git says. */
  readonly who: string | null;
  readonly evidence: readonly EvidenceRef[];
  /** `Inferred` when the step was tied to this work by a judged link rather than an id (drawn as such). */
  readonly basis: 'Explicit' | 'Inferred';
  /** This step lies in history (a side branch, a deleted document): shown labelled as history (D82). */
  readonly history: boolean;
  /** The step is a send-back going back to Work or Plan: drawn as an arrow pointing back (§6.3). */
  readonly sendBackId: string | null;
  /** CM: a step from a judged link — confirmed by the cross-check, lane-checked by the program, suspect, or not checked yet. */
  readonly link?: 'confirmed' | 'lane-checked' | 'suspect' | 'unconfirmed';
}

export type ExecutionState = 'Not started' | 'In progress' | 'Merged' | 'Not merged';

/** §2.12 the four things every piece of work shows at a glance. */
export interface FourThingsView {
  /** Null when the ledger does not say (no engine, no ledger yet): execution is never guessed from progress (QC AY B9). */
  readonly execution: ExecutionState | null;
  /** The work item's progress (§2.2 vocabulary). */
  readonly progress: string;
  /** The latest check and who made it; `Not checked` only when the project's rules ask for a check; null when they do not. */
  readonly check: { readonly verdict: string; readonly by: 'Independent QC' | 'Self-reported' | 'Test'; readonly occurred: Occurred } | 'Not checked' | null;
  /** Findings and send-backs still open: they light up even when the work is folded (D75). */
  readonly open: { readonly findings: number; readonly sendBacks: number; readonly breakpoints: number };
}

export interface WorkProcessView {
  /** Graph node id of the work item. */
  readonly workId: string;
  readonly number: NumberView | null;
  readonly steps: readonly ProcessStepView[];
  readonly four: FourThingsView;
  /** One line when folded, e.g. "5 steps · 2 send-backs · all closed". Every work is folded, in the List and on the
   *  Graph, until the owner opens it (E152, E153; ui/k-fold.js). */
  readonly folded: string;
  /** The work item this one is a step of — a fix or a check of another piece of work (§2.12) — folded under it in List
   *  and Graph, as its steps show it; null for a piece of work of its own. */
  readonly stepOf?: string | null;
  /** The generation it was planned in, when it belongs to an earlier one (`GenerationBandView.id`). */
  readonly generationId: string | null;
  /** Replaced, abandoned or deferred: struck through, with what replaced it or why (§2.12). */
  readonly struck: { readonly validity: string; readonly why: string; readonly byId: string | null } | null;
  readonly breakpointIds: readonly string[];
  readonly sendBackIds: readonly string[];
  readonly sixThings: readonly SixThing[];
  /**
   * The code territories this work changed (§6.17 "从过程视图的工作跳到它改过的领地"): the files its trunk commits and
   * merges changed in each territory, counted as `Built by` counts them, so the jump and the jump back give the same
   * numbers. Most files first. Absent when the build has no code map (no ledger, or no territories drawn yet).
   */
  readonly territories?: readonly WorkTerritoryView[];
}

/** One code territory a piece of work changed (CKC-25 AC-7). */
export interface WorkTerritoryView {
  readonly territoryId: string;
  readonly name: string;
  /** Files of the territory its commits changed. */
  readonly files: number;
  /** The commits (12 characters), oldest first. */
  readonly commits: readonly string[];
}

/** §6.3 a plan's execution shape (D72): as the orchestrator wrote it and as git shows it; ProjectKeeper schedules nothing. */
export interface PlanShapeView {
  /** Graph node id of the `Plan`. */
  readonly planId: string;
  /** Execution order as it actually happened, e.g. "1 → 6 → 2 → 3 → 4 → 5 (first half ∥ second half) → 7". */
  readonly actualOrder: string | null;
  readonly plannedOrder: string | null;
  /** Where execution differed from the plan, in one sentence; null when it did not. */
  readonly differs: string | null;
  readonly batches: readonly {
    readonly label: string;
    readonly workIds: readonly string[];
    readonly parallel: boolean;
    readonly running: boolean;
    readonly agent: string | null;
    readonly worktree: string | null;
    readonly mergeCommit: string | null;
    readonly occurred: Occurred | null;
  }[];
  readonly dependsOn: readonly { readonly from: string; readonly to: string }[];
}

/** §6.3 the version of a document-like object that is current, and whether earlier ones can be seen. */
export interface DocCurrentView {
  /** Graph node id of the Product / Requirement / Design / Decision / Plan object. */
  readonly objectId: string;
  /** The project's version label, or the short commit and date. */
  readonly current: string | null;
  readonly versions: number;
  /** Not under version control before some day (CKC-22 AC-15): earlier versions cannot be shown. */
  readonly historyFrom: string | null;
}

/** §2.12, D85 an earlier generation of plans, rolled up before the current plan. */
export interface GenerationBandView {
  readonly id: string;
  readonly name: string;
  readonly started: Occurred | null;
  readonly ended: Occurred;
  /** The decision, cleanup or restart that ended it. */
  readonly endedBy: EvidenceRef;
  readonly planned: number;
  readonly done: number;
  readonly struck: number;
  /** Its work items (graph node ids, carried in `works`), shown when the band is unrolled. */
  readonly workIds: readonly string[];
  /** CZ: of those, the ones carried on under the same number — current work in their current plan, listed here with that destination. */
  readonly carriedIds: readonly string[];
  /**
   * Its plan objects (graph node ids): the `Plan` items read from its plan documents, and the plans its work items were
   * planned in that are no longer current. They are drawn in the band like the current plan, with their shape.
   */
  readonly planIds: readonly string[];
  /** The plans behind `planIds`, named, so the band shows them even when the graph does not draw them (a removed one). */
  readonly plans?: readonly { readonly id: string; readonly name: string; readonly validity: string }[];
  /**
   * Its plan documents as the generation names them (`Generation.planRefs`), in that order; each one's text is read, when
   * the band is unrolled, from the version the ledger has — for a document since deleted, from the commit before its
   * deletion (D82): GET /api/projects/:id/generations/:gid/plans/:n.
   */
  readonly planDocs?: readonly GenerationPlanDocView[];
}

/** One plan document of an earlier generation (§2.12, D82). */
export interface GenerationPlanDocView {
  /** Its position in `Generation.planRefs`: the `:n` of its text's endpoint. */
  readonly index: number;
  readonly label: string;
  readonly path: string | null;
  /** How the generation names it. */
  readonly ref: EvidenceRef;
}

/** An earlier generation's plan document as it stood (§2.12, D82): the text is the ledger's copy, never rewritten. */
export interface GenerationPlanTextView {
  readonly generationId: string;
  readonly index: number;
  readonly label: string;
  readonly repo: string | null;
  readonly path: string | null;
  /** The version read: its commit and when that version happened. */
  readonly version: { readonly commit: string; readonly occurred: Occurred } | null;
  /** Deleted from the current version: the commit that deleted it and when; the text is the version before it. */
  readonly deleted: { readonly commit: string; readonly occurred: Occurred } | null;
  /** Still in the current version. */
  readonly current: boolean;
  /** The text, whole unless `truncated` (the ledger pages a long document; `lines` is its full length). */
  readonly text: string | null;
  readonly lines: number;
  /** The line the text starts at (1 unless a later page was asked for). */
  readonly fromLine: number;
  /** The next page starts here (`?from=`), when the text is a page of a longer document. */
  readonly nextFromLine: number | null;
  readonly truncated: boolean;
  /** Why no text could be read (no ledger, not in its history), when `text` is null. */
  readonly why: string | null;
}

export interface BreakpointView {
  readonly id: string;
  readonly kind: BreakpointKind;
  readonly targetId: string;
  readonly why: string;
  readonly since: Occurred;
  readonly evidence: readonly EvidenceRef[];
  readonly basis: 'Explicit' | 'Inferred';
  /** Lit: a lane looked and the spot-check confirmed it (D99). A finding; only a lit one shows red. */
  readonly lit: boolean;
  /** D99: `Candidate` — computed, waiting for a lane to look and the spot-check to check; a lead, not a finding. */
  readonly state?: 'Lit' | 'Candidate' | 'Out';
  /** D99: where a lane looked for the missing step and did not find it; when the spot-check confirmed it. */
  readonly looked?: { readonly where: readonly string[]; readonly at: string } | null;
  readonly checked?: { readonly at: string } | null;
  readonly ownerResponse: NoActionView | null;
  readonly sixThing: SixThing | null;
  readonly sendBackId: string | null;
}

export interface SendBackView {
  readonly id: string;
  readonly to: 'Work' | 'Plan';
  readonly stage: SendBackStage;
  readonly targetId: string;
  readonly what: string;
  readonly suggestion: string;
  readonly evidence: readonly EvidenceRef[];
  readonly occurred: Occurred;
  readonly returned: { readonly label: string; readonly occurred: Occurred } | null;
  readonly closed: { readonly label: string; readonly occurred: Occurred } | null;
  readonly ownerResponse: NoActionView | null;
  readonly sixThing: SixThing | null;
  /** The text `Copy for agent` puts on the clipboard (§1.18): where, evidence, where to send it back, the CLI command. */
  readonly copyForAgent: string;
  /** The CLI command inside it, e.g. `pk get sb_… --project …` (§7.10). */
  readonly cliCommand: string;
  /** Still lights up (open and not answered `No action needed`). */
  readonly lit: boolean;
  /** Where it came from: a breakpoint, a verdict, an owner's-judgement position, a code territory's anomaly (§1.18). */
  readonly from?: { readonly kind: 'breakpoint' | 'verdict' | 'owner-judgement' | 'code-anomaly'; readonly id: string };
  /** The object it hangs on is a code territory: it is found in `Code`, not on the graph. */
  readonly onTerritory?: boolean;
}

export interface ProcessView {
  readonly projectId: string;
  /** When the assets and the ledger this was assembled from were last updated. */
  readonly asOf: string;
  readonly ledgerAsOf: string | null;
  /** Keyed by the work item's graph node id. A `Plan` with an execution shape has an entry too — its unit in List and
   *  Graph, with no steps of its own and its batches under `plans`. */
  readonly works: Readonly<Record<string, WorkProcessView>>;
  /** Keyed by the plan's graph node id. */
  readonly plans: Readonly<Record<string, PlanShapeView>>;
  /** Keyed by the document-like object's graph node id. */
  readonly docs: Readonly<Record<string, DocCurrentView>>;
  /** Earlier generations, oldest first; empty when the material names none (no bands are invented). */
  readonly generations: readonly GenerationBandView[];
  readonly breakpoints: readonly BreakpointView[];
  readonly sendBacks: readonly SendBackView[];
  /** Which objects carry each of the six things (§2.13), for `Filter`. */
  readonly sixThings: readonly { readonly thing: SixThing; readonly objectIds: readonly string[] }[];
  /** The top bar: breakpoints still lit, by kind; send-backs still open (§6.3, §2.12). */
  readonly counts: { readonly breakpointsLit: number; readonly byKind: Readonly<Partial<Record<BreakpointKind, number>>>; readonly sendBacksOpen: number;
    /** D99: candidates waiting to be read and checked; never counted as lit. */
    readonly breakpointCandidates?: number };
}

// ───────────────────────── §6.4 the popover: versions and `How it got here` ─────────────────────────

export type LineageStepKind =
  | 'First appeared' | 'Changed' | 'Replaced' | 'Replaces' | 'Planned' | 'Work' | 'Commit' | 'Merged' | 'Verdict'
  | 'Send-back' | 'Now';

/** §2.11 one step of an object's dated path to now; the steps are ledger facts, not the model's words. */
export interface LineageStepView {
  readonly kind: LineageStepKind;
  readonly occurred: Occurred;
  readonly title: string;
  readonly evidence: readonly EvidenceRef[];
  /** Lies in history: shown labelled as history, with what replaced it (D82). */
  readonly history: boolean;
  /**
   * Whose step it is: the object's own (its number named, a line that replaces it, a patch or send-back aimed at it) or
   * the document it sits in (the document's versions, commits and patches). A decision's popover shows the document's
   * steps as that document's history, never as the decision's own (owner 2026-09-30). Absent: the object's.
   */
  readonly about?: 'object' | 'document';
}

export interface LineageView {
  readonly objectId: string;
  /** Oldest first. The popover shows the last few and expands to all (CKC-24 AC-14). */
  readonly steps: readonly LineageStepView[];
  /** The document the object sits in (repository-relative), whose steps are marked `about: 'document'`; null when none. */
  readonly document?: string | null;
}

export interface VersionView {
  /** The project's version label, or the short commit. */
  readonly label: string;
  readonly commit: string | null;
  readonly occurred: Occurred;
  readonly sections: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] };
  /** The semantic patch that withdrew (part of) this version, when one did. */
  readonly supersededBy: { readonly patchId: string; readonly number: string; readonly title: string; readonly partial: boolean } | null;
  readonly current: boolean;
  readonly history: boolean;
}

export interface VersionsView {
  readonly objectId: string;
  /** Oldest first. */
  readonly versions: readonly VersionView[];
  /** Not under version control before this day (CKC-22 AC-15): "earlier versions cannot be seen". */
  readonly historyFrom: string | null;
  /** The document these are the versions of (repository-relative): the one the object sits in; null when none. */
  readonly document?: string | null;
}

// ───────────────────────── §6.17 `Code` ─────────────────────────

export interface TerritoryAnomalyView {
  readonly kind: TerritoryAnomalyKind;
  readonly text: string;
  readonly evidence: readonly EvidenceRef[];
  readonly basis: 'Explicit' | 'Inferred';
  readonly sendBackId: string | null;
  readonly noteIds: readonly string[];
  /** The notes behind `noteIds` as the jump names them: title, what they ask, their state (§6.17 "从异常跳到相关的 note"). */
  readonly notes?: readonly { readonly id: string; readonly title: string; readonly ask: string; readonly status: string }[];
}

export interface TerritoryView {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly repo: string;
  readonly paths: readonly string[];
  /** A row per product area, one for the shared base, one for what is not product code (§6.17). */
  readonly row: { readonly kind: 'area'; readonly areaId: string; readonly areaName: string; /** The area's one-line summary, as Product intent writes it. */ readonly areaLine?: string | null } | { readonly kind: 'shared' } | { readonly kind: 'non-product' };
  readonly size: { readonly files: number; readonly lines: number; readonly generatedFiles: number; readonly generatedLines: number };
  readonly dependsOn: readonly string[];
  readonly dependedBy: readonly string[];
  /** How many file-level edges each dependency carries, by territory id ("depends on: chat engine (19)"). */
  readonly dependsOnCounts?: Readonly<Record<string, number>>;
  readonly dependedByCounts?: Readonly<Record<string, number>>;
  /** Other areas it also serves: "also serves N", expanded on hover (D74, D54). */
  readonly alsoServes: readonly { readonly areaId: string; readonly areaName: string }[];
  /** Who built it: work item × files changed, by merge commit (§1.19). */
  readonly builtBy: readonly { readonly workId: string | null; readonly label: string; readonly commits: readonly string[]; readonly files: number }[];
  /** Which generation the current lines come from (D85), largest share first. `generationId` is an earlier generation's
   *  band (`GenerationBandView.id`); null is the current generation, which has no band. */
  readonly generations: readonly { readonly generationId: string | null; readonly name: string; readonly share: number; /** The work items the lines of this generation came from, by lines (§1.19: which generation's which work). */ readonly works?: readonly { readonly workId: string | null; readonly label: string; readonly lines: number }[] }[];
  readonly currentUse: CurrentUse;
  readonly tests: number;
  readonly lastChange: { readonly commit: string; readonly occurred: Occurred; readonly subject: string } | null;
  readonly anomalies: readonly TerritoryAnomalyView[];
  /**
   * Its paths the current version no longer has (deleted or moved since the territory was drawn): its numbers count only
   * what is left, and it is drawn again at the next round's cross-check (CKC-25 AC-10). Absent or empty when all are there.
   */
  readonly gonePaths?: readonly string[];
}

/**
 * How deep the ledger reads one language of the code (§1.16 "看得见", §6.17 "顶上写明…账本的代码结构做到哪一级"; D98 补),
 * from the coverage it measured (Ledger.coverage): read by the TypeScript compiler, to symbols; read by the code engine,
 * to symbols as far as it resolved them — the imports it resolved to a file of the repository and those it left
 * unresolved though they name one; or not read, its files and sizes only. Where a file is not read or a reference was
 * measured unresolved, a residual call on that code is Inferred (CKC-25 AC-5).
 */
export interface CodeLanguageView {
  readonly language: string;
  /** Its files of the current version, generated and third-party ones left out (tests counted), and of them the ones its reader read. */
  readonly files: number;
  readonly read: number;
  /** Who reads its references: the TypeScript compiler, the code engine, or nobody. */
  readonly readBy: 'compiler' | 'engine' | null;
  /** The code engine's imports: resolved to a file of the repository, and left unresolved though they name one. Null unless the engine reads it. */
  readonly imports: { readonly resolved: number; readonly unresolvedNamingRepoFiles: number } | null;
  /** Files no counted reference reaches that another file names by its file name: references its reader left unresolved. */
  readonly namedButUnreferenced: number;
  /** Files the engine could not parse in full. */
  readonly parseErrors: number;
  /** Every file read and nothing measured unresolved: a residual call on it can rest on computed references alone. */
  readonly complete: boolean;
  /** What was measured unresolved or missing, in the ledger's words; empty when nothing was. */
  readonly gaps: readonly string[];
}

export interface CodeView {
  readonly projectId: string;
  readonly version: { readonly repo: string; readonly branch: string | null; readonly commit: string; readonly occurred: Occurred };
  /** How deep the ledger reads each language of the code: every language a reader reads, and every one it knows is code but reads nothing of. */
  readonly levels: readonly CodeLanguageView[];
  readonly generatedAt: string;
  readonly territories: readonly TerritoryView[];
  /** The send-backs its anomalies carry, by id, so `Code` shows them without the process view loaded first (QC AY B6). */
  readonly sendBacks?: Readonly<Record<string, SendBackView>>;
}

/** A file of the current version, opened from `Code` (§6.17 "点文件打开原文阅读"): found by the ledger's `fileRefs`. */
export interface CodeFileTextView {
  readonly repo: string;
  readonly path: string;
  readonly lang: string | null;
  /** The commit whose tree the ledger read it from (the checkout's HEAD when the ledger was built), and when. */
  readonly commit: string | null;
  readonly occurred: Occurred | null;
  readonly lines: number;
  readonly fromLine: number;
  readonly toLine: number;
  /** A long file comes in pages: the next page starts here. */
  readonly nextFromLine: number | null;
  readonly text: string;
  readonly generated: boolean;
}

export interface CodeFileView {
  readonly path: string;
  readonly lines: number;
  readonly generated: boolean;
  readonly importedBy: readonly string[];
  readonly imports: readonly string[];
  readonly lastCommit: { readonly commit: string; readonly occurred: Occurred; readonly subject: string } | null;
  readonly workId: string | null;
  /** The work item's name and number, when it is known; a work id no territory's `builtBy` names still reads. */
  readonly workLabel?: string | null;
}

export interface TerritoryDetailView {
  readonly territoryId: string;
  readonly files: readonly CodeFileView[];
}

// ───────────────────────── §6.9 a round in the Keeper view ─────────────────────────

export interface RoundDocRef { readonly id: string; readonly kind: RoundDocKind; readonly title: string; readonly path: string | null; /** When the document was written. */ readonly at?: string }

export interface RoundStepView {
  readonly jobId: string;
  readonly kind: RoundStepKind;
  readonly label: string;
  /** The deep sweep's name, for `dig`; the lane's name, for `lane` (D99). */
  readonly path: string | null;
  readonly status: string;
  readonly model: { readonly provider: string; readonly id: string; readonly thinking: string | null } | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly timing: StepTiming | null;
  readonly usage: Usage | null;
  readonly docs: readonly RoundDocRef[];
  readonly children: readonly RoundStepView[];
  /** The session drafts this step wrote (the session-drafts step), each openable (CKC-23 AC-18). */
  readonly drafts?: readonly SessionDraftRef[];
}

export interface RoundView {
  readonly id: string;
  readonly kind: RoundKind;
  readonly number: number;
  /** The record of the round itself: stopping it stops the whole tree (§3.10). Absent on a fixture written before it. */
  readonly rootJobId?: string;
  /** A deepening: the depth it ran at. A Follow up: what started it (the owner, the schedule). */
  readonly depth?: string | null;
  readonly startedBy?: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly status: string;
  /** Wall clock of the round and of its longest path: with paths in parallel the round lasts as long as the longest (§3.10). */
  readonly wallMs: number | null;
  readonly longestPathMs: number | null;
  readonly timing: StepTiming | null;
  readonly usage: Usage | null;
  readonly steps: readonly RoundStepView[];
  /** What the round produced, by workbench position (§3.3 table), and what served a later step or recall. */
  readonly outputs: readonly { readonly position: string; readonly count: number }[];
  readonly groundwork: readonly { readonly kind: string; readonly count: number }[];
  /** Outputs that served nothing: should be near zero, each with its reason (CKC-23 AC-6). */
  readonly unplaced: { readonly count: number; readonly reasons: readonly string[] };
  /**
   * D103: `synthesis` — the synthesis' outputs and the notes, checked in full and counted apart from the sample. CS:
   * `placement` — the reasons that left an item unplaced and the program's placements, counted apart too.
   */
  readonly spotCheck: { readonly sampled: number; readonly wrong: number; readonly byKind: Readonly<Record<string, number>>; readonly corrected: number; readonly synthesis?: { readonly outputs: number; readonly checked: number; readonly wrong: number }; readonly placement?: { readonly reasons: number; readonly reasonsChecked: number; readonly reasonsWrong: number; readonly programPlacementsSampled: number; readonly programPlacementsWrong: number } } | null;
  /** D103: what the round did with the notes standing from earlier rounds (a deepening, a Follow up); counted live while it runs. */
  readonly standingNotes?: { readonly standing: number; readonly confirmed: number; readonly updated: number; readonly withdrawn: number; readonly open: number } | null;
  readonly ledger: { readonly ms: number; readonly commitsAdded: number } | null;
  /** What the round's end did with the project folder, or why it could not. */
  readonly folder?: string | null;
  /**
   * The sweeps the program added to a takeover's deepening for kinds of question orientation set no sweep for, each with
   * why and the brief it composed (a document of this round, written by no step's job, so no step lists it; CKC-23 AC-4).
   * Absent when the program added none.
   */
  readonly sweepsAdded?: readonly { readonly path: string; readonly why: string; readonly doc: RoundDocRef | null }[];
  /**
   * D99 (Spec §3.3, §3.10, §6.9): the main agent — the stage it is in and the stages it went through, each with its time.
   * Present exactly on rounds run by the main agent; a round from before D99 has none and reads as its steps.
   */
  readonly main?: RoundMainView;
  /** D99: the lanes the main agent sent, in the order sent, each with its question, slots, status and what it read. */
  readonly lanes?: readonly RoundLaneView[];
  /** D99: the coverage check — what it listed as untouched and each account; null until the main agent enters it. */
  readonly coverage?: RoundCoverageView | null;
  /** D99: the missing steps this round's lanes looked for (breakpoint candidates, §2.12), and those its spot-check confirmed. */
  readonly missing?: { readonly looked: number; readonly checked: number };
}

/**
 * D99: the main agent of a round: its job, the stage it is in, and its stages in order (§3.10 the time of each). D103:
 * `handover` once it handed the round over to the synthesis — when, and its Handover document, which opens from the tree.
 */
export interface RoundMainView {
  readonly jobId: string | null;
  readonly stage: ClerkStage | null;
  readonly handover?: { readonly at: string; readonly doc: RoundDocRef | null } | null;
  readonly stages: readonly { readonly stage: ClerkStage; readonly startedAt: string; readonly endedAt: string | null; readonly timing: StepTiming | null; readonly current: boolean }[];
}

/**
 * D99: a lane as the round tree shows it: what it answers (the first lines of its brief), the slots it writes, the stage it
 * was sent in, its job's status, time and usage (with the jobs it sent), its brief and report, and what it read — counted
 * by the program from its steps' recorded reads, each material once.
 */
export interface RoundLaneView {
  readonly name: string;
  readonly kind: LaneKind;
  readonly slots: readonly SlotKind[];
  readonly stage: ClerkStage | null;
  readonly sentAt: string | null;
  readonly question: string | null;
  readonly jobId: string | null;
  readonly status: string;
  readonly model: { readonly provider: string; readonly id: string; readonly thinking: string | null } | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly timing: StepTiming | null;
  readonly usage: Usage | null;
  readonly brief: RoundDocRef | null;
  readonly report: RoundDocRef | null;
  readonly read: { readonly files: number; readonly versions: number; readonly commits: number; readonly sessions: number };
}

/** D99: the coverage check of a round: when, whether settled, what the last check listed as untouched, and each account. */
export interface RoundCoverageView {
  readonly at: string;
  readonly settled: boolean;
  /** Null when the check did not record its listing. */
  readonly untouched: readonly CoverageGroup[] | null;
  readonly accounted: readonly MaterialAccount[];
}

export interface RoundDocView {
  readonly id: string;
  readonly roundId: string;
  readonly kind: RoundDocKind;
  readonly title: string;
  readonly path: string | null;
  readonly markdown: string;
  readonly at: string;
}

// ───────────────────────── §3.11 session drafts ─────────────────────────

/** A session as a round step or an object lists it, with the draft of it when there is one (CKC-23 AC-18). */
export interface SessionDraftRef {
  /** The draft's id; null when the session has not been drafted yet (it is listed, and says so). */
  readonly id: string | null;
  readonly host: string;
  readonly sessionId: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** The owner's lines, and how many of them are decisions, confirmations, chat, or not yet classified. */
  readonly ownerLines: number;
  readonly decisions: number;
  readonly confirmations: number;
  readonly chat: number;
  readonly unjudged: number;
  readonly agentSummaries: number;
  /** The sources that hold this session (its message ranges), for its original. */
  readonly sourceIds: readonly string[];
  /** When the draft was last written. */
  readonly at: string | null;
}

/**
 * One session's draft (§3.11, D88) as the owner drills into it: the owner's lines verbatim with their kind, what a
 * confirmation answers and what it confirms, and the agents' intents and reports marked as claims.
 */
export interface SessionDraftView {
  readonly id: string;
  readonly session: { readonly host: string; readonly sessionId: string; readonly file: string; readonly startedAt: string | null; readonly endedAt: string | null };
  readonly ownerLines: readonly {
    /** Its position in the session (`[n]`) or its ledger message id. */
    readonly ref: string;
    readonly at: string | null;
    /** Verbatim, as the program took it from the session. */
    readonly text: string;
    /** Null: not classified yet. */
    readonly kind: 'Chat' | 'Decision' | 'Confirmation' | null;
    /** A confirmation: the agent message it answers, verbatim. */
    readonly answers: string | null;
    /** A confirmation: what the owner confirmed, in the Keeper's words. */
    readonly confirms: string | null;
    /** The source holding this message, to open the original. */
    readonly sourceId: string | null;
  }[];
  /** The agents' intents and reports: claims, as the agents made them — who and when (§2.4). */
  readonly agentSummary: readonly { readonly at: string | null; readonly who: string; readonly summary: string; readonly basis: 'Claimed' }[];
  readonly counts: { readonly lines: number; readonly chat: number; readonly decisions: number; readonly confirmations: number; readonly unjudged: number };
  readonly sourceIds: readonly string[];
  /** When the draft was last written, and by which jobs of which rounds. */
  readonly at: string;
  readonly writtenBy: readonly { readonly jobId: string | null; readonly roundId: string | null; readonly roundLabel: string | null; readonly at: string }[];
}

// ───────────────────────── §1.17 semantic patches ─────────────────────────

/** A semantic patch as the workbench shows it: in `Change log`, and as the details a strike-through points at (CKC-26 AC-4). */
export interface PatchView {
  readonly id: string;
  /** SP-n, the Keeper's number (§1.17). */
  readonly number: string;
  readonly title: string;
  readonly status: 'Draft' | 'Confirmed' | 'Rejected';
  readonly partial: boolean;
  /** When the supersession happened, from its candidate (§2.11). */
  readonly occurred: Occurred;
  readonly invalidated: string;
  readonly replacedBy: string;
  readonly affects: readonly { readonly id: string; readonly label: string }[];
  readonly affectsText: string;
  readonly mustNotPassAsCurrent: string;
  readonly oldAnchor: EvidenceRef;
  readonly newAnchor: EvidenceRef | null;
  readonly decision: EvidenceRef | null;
  readonly candidate: EvidenceRef;
  readonly writtenToFolder: { readonly path: string; readonly commit: string | null; readonly at: string } | null;
  /** The details (`GET …/patches/:pid` only): the text `pk get SP-n` prints, the same words (context/k-briefs.ts). */
  readonly text?: string;
}

// ───────────────────────── §6.7 Project scope additions ─────────────────────────

export interface ScopeKView {
  /** The ledger's coverage (§1.16 "看得见"). */
  readonly ledger: {
    readonly repos: readonly { readonly repo: string; readonly commits: number; /** On the trunk alone, when it differs from all refs. */ readonly trunkCommits?: number | null; readonly branches: number; readonly merges: number; readonly from: string | null; readonly to: string | null; readonly historyFrom: string | null }[];
    /**
     * Every language of the project with how far the ledger goes in it. `code`: for a language of the code, how deep the
     * ledger reads it, the same `CodeLanguageView` the `Code` view says (read by the compiler; by the code engine, with the
     * imports it resolved and those it left unresolved; or not read); absent for prose and data, which are no code.
     */
    readonly languages: readonly { readonly language: string; readonly level: 'symbol' | 'file' | 'file tree'; readonly files: number; readonly code?: CodeLanguageView }[];
    readonly sessions: { readonly read: number; readonly hosts: readonly string[]; readonly missing: readonly { readonly host: string; readonly from: string | null; readonly to: string | null; readonly why: string }[] };
    readonly unversionedDocs: number;
    readonly lastRebuild: { readonly at: string; readonly ms: number } | null;
    /**
     * What the ledger holds without reading it, said rather than left out (QC AY): document versions kept without their
     * text (over the size it reads to, or not text) — reports among them, whose verdicts are not read — and files outside
     * version control too large to read. Absent when there is none.
     */
    readonly notRead?: {
      readonly versionsWithoutText: number;
      readonly paths: readonly string[];
      readonly morePaths: number;
      readonly reports: readonly string[];
      readonly unversionedTooLarge: number;
      readonly unversionedPaths: readonly string[];
      readonly effect: string;
      /** The sizes the ledger reads to (bytes): a document version, a file outside version control. Absent from older servers. */
      readonly documentLimitBytes?: number;
      readonly looseLimitBytes?: number;
    } | null;
  } | null;
  /** Which file is which layer (orientation, §3.3). */
  readonly layers: readonly { readonly path: string; readonly layer: LayerKind; readonly note: string | null; readonly current: boolean }[];
  /** Earlier generations, as orientation recognised them (§2.12). */
  readonly generations: readonly { readonly id: string; readonly name: string; readonly ended: Occurred; readonly endedBy: EvidenceRef }[];
  /** The questions the deepening asks, and the sweeps (§3.7). */
  readonly questions: { readonly roundId: string; readonly docId: string; readonly paths: readonly string[] } | null;
  /** The `Project folder` standing authorization and its last write (§1.14, §1.17). */
  readonly projectFolder: { readonly granted: boolean; readonly path: string | null; readonly commits: boolean; readonly lastWrite: { readonly at: string; readonly commit: string | null } | null; readonly authorizationId: string | null } | null;
}
