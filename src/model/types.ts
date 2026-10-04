/**
 * Project assets (Spec §1 "共同对象", §8.5). Everything here belongs to ProjectKeeper, lives
 * outside the project directory, and can be read without a running Keeper.
 *
 * All views, the conversation and every delivery read these same records; nothing assembles
 * a second understanding at delivery time.
 */

import type {
  Acceptance, Assessment, Availability, Basis, CarryOut, ChangeEffect, ChangeMaterial, ContextPurpose, CoverageLabel,
  Delivery, Identity, ItemClose, JobKind, JobStatus, MarkClose, MarkKind, MaterialRule, NodeCategory, NoteAsk, NoteOrigin,
  NoteStatus, NotJudgedReason, OrganizingLevel, OwnerResponse, Progress, Propagation, ReferenceCategory,
  RelationType, RuleGroup, ScopeCategory, ScopeRelation, SessionHost, StatementType, TakeoverDepth, UnderstandingState,
  UsedAs, Validity, WorkKind, WorkSegmentKind, ProcessExpectation,
} from './vocab.ts';
import type { AbsenceLooked, RoundNews, RoundStepKind, SixThing, StepTiming, LaneKind, SlotKind } from './k-types.ts';

// ───────────────────────── §1.2 sources and anchors ─────────────────────────

export interface FileAnchor {
  readonly kind: 'file';
  readonly path: string;            // absolute
  readonly headingPath: readonly string[];
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly tableRow?: number;
}
export interface SessionAnchor {
  readonly kind: 'session';
  readonly host: SessionHost;
  readonly sessionId: string;
  readonly file: string;            // native log file
  readonly cwd: string | null;
  /** Message position inside the native log; the range covers one segment. */
  readonly messageStart: number;
  readonly messageEnd: number;
  readonly at: string | null;       // ISO time of the first message in the range
}
export interface CommitAnchor {
  readonly kind: 'commit';
  readonly repo: string;
  readonly commit: string;
  /** When the commit was made, as git records it (author date, ISO 8601 with its offset). Absent on commit sources
   *  written before intake recorded it. */
  readonly at?: string;
}
export interface CommandAnchor {
  readonly kind: 'command';
  readonly command: string;
  readonly cwd: string;
  readonly ranAt: string;
}
export interface StatusAnchor {
  readonly kind: 'status';
  readonly description: string;     // e.g. "git status of D:\x at 2026-…"
  readonly at: string;
}
/** A file as it was at a commit, read from version history: always `History only` (§1.2, D61). */
export interface RevisionAnchor {
  readonly kind: 'revision';
  readonly repo: string;            // the repository whose history holds it (a worktree's is its main repository)
  readonly commit: string;          // full hash
  readonly path: string;            // relative to the repository root, forward slashes
}
export type SourceAnchor = FileAnchor | SessionAnchor | CommitAnchor | CommandAnchor | StatusAnchor | RevisionAnchor;

export interface Source {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly anchor: SourceAnchor;
  /** Material's own numbering found at the anchor (DEC-020, TASK-7.2, #18 …). */
  readonly ids: readonly string[];
  readonly version: { readonly fingerprint: string; readonly readAt: string; readonly commit: string | null };
  /** Exact text at the anchor as it was when read. Credential values are redacted (§3.1). */
  readonly excerpt: string;
  readonly usedAs: UsedAs | null;   // null → `Not yet judged`
  readonly usedAsBy: 'keeper' | 'owner' | null;
  /** The project rule this `Used as` follows (§1.15: `Reference only`, `Recovery only` → `History only`); absent or
   *  null when the Keeper judged it without one. */
  readonly usedAsByRuleId?: string | null;
  /** The scope item whose classification set this `Used as` (§1.1: the documents third-party material brings are
   *  `Reference only`); absent or null otherwise. It goes when the classification does. */
  readonly usedAsByScopeItemId?: string | null;
  readonly availability: Availability | null;
  readonly movedTo: string | null;
  /** Scope item this source belongs to (main project, a copy, a worktree …). */
  readonly scopeItemId: string;
  readonly hasCredential: boolean;
  readonly bytes: number;
  /**
   * A message ProjectKeeper stores itself — one message of the Keeper conversation (§1.2, §6.8): who wrote it, the owner
   * or an execution agent asking, and where their words begin in the excerpt, after the heading it is shown under. When
   * it was said is the anchor's `at`. Written when the message is stored, so the heading's wording never decides whose
   * words these are. Absent on material read from elsewhere, and on conversation messages stored before it was recorded,
   * which are read from their heading.
   */
  readonly said?: { readonly by: 'owner' | 'agent'; readonly wordsFrom: number };
}

// ───────────────────────── §1.9 attribution ─────────────────────────

export interface Author {
  readonly kind: 'owner' | 'role' | 'agent' | 'unknown';
  readonly name: string | null;     // role name, agent name, or null
  readonly window: string | null;
  readonly host: string | null;     // claude / codex / pi …
  readonly model: string | null;
}
export interface Attribution {
  readonly author: Author;
  readonly holder: { readonly role: string; readonly window: string | null } | null;
  readonly identity: Identity;
}

// ───────────────────────── §1.4 layered work facts ─────────────────────────

/**
 * Who made a claim and when (§2.4, D63): which report, role or agent, on which day. An agent's report is a summary of
 * what it says it did, so it is recorded as its claim, never as a fact.
 */
export interface ClaimedBy {
  readonly who: string;                           // the report, role or agent that makes the claim
  readonly at: string;                            // when it was claimed, at the precision the material gives (a date stays a date, §1.8)
  /** The project's `Untrusted` rule that covers this source, when one does (§1.15); the claim stays `Claimed`. */
  readonly untrustedRuleId: string | null;
}
/**
 * What reading the code found about one claim (§2.4, D63): which claim, in which order it was checked, whether the code
 * agrees, and where it was read. It sits on the `Observed` statement of what the code shows, next to the claim, so how
 * many claims were checked, in which order and how many did not hold can be counted from the assets.
 */
export interface CodeCheck {
  readonly of: string;                            // the id of the `Claimed` statement it checks, in the same fact record
  readonly tier: string;                          // the order it was checked in: the owner's words and red lines, a Done or verified status, the rest
  readonly result: string;                        // Consistent | Inconsistent | Partly consistent
  readonly anchor: { readonly repo: string | null; readonly commit: string | null; readonly file: string; readonly lines: string };
}
export interface Statement {
  readonly id: string;
  readonly type: StatementType;
  readonly text: string;
  readonly sourceIds: readonly string[];
  /** Every `Claimed` statement written since v2.8 carries it; older ones do not. */
  readonly claimedBy?: ClaimedBy;
  /** On an `Observed` statement of what the code shows: the claim it checks and what the check found (§2.4). */
  readonly check?: CodeCheck;
}
export interface RecordedDecision {
  readonly text: string;
  readonly by: Attribution;
  readonly sourceIds: readonly string[];
  /** Set when the decision is recorded in the project's own decision record. */
  readonly documented: boolean;
}
export interface RecordedChange {
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly changeRecordId: string | null;
}
/** What one cognitive job actually received (§3.3 "每次整理只拿这项工作需要的输入"). */
export interface JobInputs {
  readonly jobId: string;
  readonly sourceIds: readonly string[];
  readonly factRecordIds: readonly string[];
  readonly threadIds: readonly string[];
  readonly areaIds: readonly string[];
  readonly referenceIds: readonly string[];
  readonly noteIds: readonly string[];
  readonly location: string;        // project positioning text given to the job
}

export interface FactRecord {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** The single material or session segment this record was formed from. */
  readonly aboutSourceIds: readonly string[];
  readonly statements: readonly Statement[];
  readonly decisions: readonly RecordedDecision[];
  readonly changes: readonly RecordedChange[];
  readonly openQuestions: readonly string[];
  /** Execution and QC facts kept with the record (§1.4). */
  readonly executionFacts: readonly Statement[];
  readonly language: string;
  readonly inputs: JobInputs;
  readonly asOf: string;
  readonly updatedAt: string;
  readonly pendingSourceIds: readonly string[];   // new material not yet merged (§1.4)
}

export interface ServesClaim {
  readonly referenceId: string;
  readonly claim: string;
  readonly basis: Basis;
}

/**
 * How a change the next round will take in reaches an entry (§1.11 `Update pending`), by the links the clerk method's
 * assets hold (keeper/organize/update-pending.ts): the change names the entry's number; the entry cites a part of the
 * material that changed; the change is in code a work item changed (its code territory); a step, breakpoint or send-back
 * of the work's process rests on the material; a change recorded earlier from the same material reached it; for an area,
 * a work item that contributes to it waits.
 */
export type PendingLink = 'Number' | 'Cited source' | 'Code territory' | 'Process' | 'Recorded change' | 'Contributing work';

/**
 * One change an entry waits for (§1.11 `Update pending`; §7.1, §7.6: the mark names the changes it waits for): the entry of
 * the coverage's pending list it is (the same ref and label), the parts of it that reach the entry — source ids, to read
 * now — and how it reaches it. Written by the program from the pending list, never by a model, and gone once a round has
 * taken the change in.
 */
export interface PendingWait {
  readonly ref: string;
  readonly kind: PendingMaterial['kind'];
  readonly label: string;
  readonly since: string;
  readonly sourceIds: readonly string[];
  readonly reasons: readonly { readonly link: PendingLink; readonly detail: string }[];
}
export interface WorkThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly ids: readonly string[];                // contract / task ids the project uses
  readonly doing: string;
  readonly changed: string;
  readonly results: string;
  readonly unresolved: string;
  readonly doneMeans?: string;                    // the completion conditions the material states (§7.3 `Done means`); owner review belongs in acceptanceMeans
  readonly acceptanceMeans?: string;              // what the material says only the owner can judge (D41); never lowers progress
  readonly acceptance?: Acceptance;               // §2.2 owner acceptance, separate from progress and from any check
  readonly executionFacts: readonly Statement[];
  readonly qcFacts: readonly Statement[];
  readonly factRecordIds: readonly string[];
  readonly serves: readonly ServesClaim[];
  readonly dependsOn: readonly { readonly threadId: string; readonly claim: string; readonly basis: Basis }[];
  readonly progress: Progress;
  readonly validity: Validity;
  readonly replacedBy: string | null;
  readonly attribution: Attribution;
  readonly inputs: JobInputs;
  readonly asOf: string;
  readonly updatedAt: string;
  /** `Update pending` (§1.11): the sources of the changes it waits for; empty when it waits for none. */
  readonly pendingSourceIds: readonly string[];
  /** The changes it waits for, each with how it reaches this work item; absent when it waits for none. */
  readonly waitsFor?: readonly PendingWait[];
  /** The project rule this work item's validity follows (§1.15, e.g. an `Obsolete` rule), when one does. */
  readonly validityByRuleId?: string | null;
  /** The project rule its progress is read by — the authoritative index or field (§1.15 `Authoritative`, §2.2). */
  readonly progressByRuleId?: string | null;
  /** The status its document writes for it, kept as written (D99; CKC-23 AC-21): not its progress, which is judged. */
  readonly writtenStatus?: WrittenStatus | null;
  /** Why its progress stands as it does when the material seems to say otherwise (CJ): a contract still Planned although tickets implementing it are Done. */
  readonly progressWhy?: string | null;
  /**
   * CN (E152; Spec §1.4 落位): the work serves its whole plan — all of the plan's modules — and no single one (a milestone
   * QC across every contract, a reading of the whole graph): why, in the Keeper's words. It then stands in its plan's
   * cross-cutting cell with this reason and is not counted as work in no module. It needs a plan, and counts only while
   * the work item serves no Area.
   */
  readonly wholePlanWhy?: string | null;
  /**
   * CQ (D104; Spec §1.4 落位): the records lead nowhere for this work — no plan or dispatch table lists it, no prompt
   * metadata, no contract, no decision it carries out or cites leads to a plan, no arrangement current or archived names
   * it — and why, naming the records read. A record the program can refuse: it is refused where the records do lead to a
   * plan (placement-inference.ts), and accepted when the chain is empty or the project has no plan layer. With it the
   * work item is written as "no plan — why" and is not counted as work in no plan.
   */
  readonly noPlanWhy?: string | null;
  /** CQ (D104): the same for the module — the records name no Area for this work, and why. */
  readonly noAreaWhy?: string | null;
}

/**
 * A status a document writes in a table row (D99 "工作台是一道填空题"), copied by the fill-in tools: "ready" stays "ready";
 * progress is the judgement's (§2.2) and is set from a written status only through the model's own mapping.
 */
export interface WrittenStatus {
  readonly text: string;
  /** The file source that holds the row, and the row's line. */
  readonly sourceId: string;
  readonly line: number;
}

export interface AreaUnderstanding {
  readonly id: string;
  readonly projectId: string;
  readonly referenceId: string;                   // the `Area` reference item
  readonly effectNow: string;
  readonly gaps: string;
  readonly contributions: readonly { readonly threadId: string; readonly claim: string; readonly basis: Basis }[];
  readonly inputs: JobInputs;
  readonly asOf: string;
  readonly updatedAt: string;
  /** `Update pending` (§1.11): the sources of the changes it waits for — its area's own, and its work items'. */
  readonly pendingSourceIds: readonly string[];
  /** The changes it waits for, each with how it reaches this area; absent when it waits for none. */
  readonly waitsFor?: readonly PendingWait[];
}

// ───────────────────────── §1.3 product reference ─────────────────────────

/**
 * One part of a decision that a later decision superseded (§5.5: 被取代的部分标 `Replaced`，指向新决定，其余不变).
 * A decision only part of which was superseded stays `Current`, because the rest is still in force and objects
 * still have to follow it; what the later decision took over is recorded here and on the `replaces` relation's
 * claim. `validity: 'Replaced'` with `replacedBy` is the other case: the whole decision went.
 */
export interface SupersededPart {
  readonly part: string;                          // which part of this decision the later one took over
  readonly byId: string;                          // the decision that superseded it
  readonly basis: Basis;                          // Explicit when the new decision says so, Inferred when it only gives different content (§5.5)
  readonly at: string;
}

/**
 * Whether a decision that asks for something to be done was carried out (§2.2, v2.8). The work that carries it out is
 * linked by `carries out`; `Partly carried out` says what is left. A decision carried out stays `Current`.
 */
export interface DecisionCarryOut {
  readonly status: CarryOut;
  readonly remaining: string | null;              // what is still left; set for `Partly carried out`
  readonly workIds: readonly string[];            // the work items that carry it out
  readonly evidenceSourceIds: readonly string[];  // what shows it (code, commits, reports)
  readonly at: string;
  readonly jobId: string | null;
}

export interface ReferenceItem {
  readonly id: string;
  readonly projectId: string;
  readonly category: ReferenceCategory;
  readonly name: string;                          // the project's own name/number
  readonly ids: readonly string[];
  readonly text: string;
  /** Owner's own words when the item records an owner statement. */
  readonly quote: string | null;
  /**
   * DA (Spec §3.11: 「owner 说“可以”时，要看它答的是什么」): for an Owner's words quote too short to stand alone, the message
   * it answers, copied from where it was said. Absent on a quote that stands alone.
   */
  readonly answers?: string | null;
  readonly basis: Basis;
  readonly validity: Validity;
  readonly progress: Progress | null;
  readonly attribution: Attribution;
  readonly sourceIds: readonly string[];
  readonly refines: readonly string[];            // upstream reference ids
  readonly replacedBy: string | null;
  /** Parts of this decision a later decision superseded while the rest stays in force (§5.5). Absent on items
   *  nothing has superseded, and on items written before the replacement check recorded parts. */
  readonly supersededParts?: readonly SupersededPart[];
  /** Whether a decision that asks for something was carried out (§2.2); absent until it is recorded. */
  readonly carryOut?: DecisionCarryOut | null;
  /** The project rule this item's validity follows (§1.15, e.g. an `Obsolete` rule), when one does. */
  readonly validityByRuleId?: string | null;
  readonly inputs: JobInputs | null;
  readonly asOf: string;
  readonly updatedAt: string;
  /** `Update pending` (§1.11): the sources of the changes it waits for; absent or empty when it waits for none. */
  readonly pendingSourceIds?: readonly string[];
  /** The changes it waits for, each with how it reaches this item; absent when it waits for none. */
  readonly waitsFor?: readonly PendingWait[];
  /** The status its document writes for it, kept as written (D99; CKC-23 AC-21); absent when none is written. */
  readonly writtenStatus?: WrittenStatus | null;
  /**
   * An Area only (D101; Spec §1.4): a cross-cutting foundation the project's own documents treat as a peer of its modules
   * (a row of the module or scope table, a requirement-group heading, a Spec chapter tagged with it, a value of a
   * contract's Module column). It is a column of its own under the project's name, placed after every module.
   */
  readonly foundation?: boolean;
  /**
   * A decision, boundary, requirement or design placed on the whole product (CM; Spec §1.4 落位): why it concerns the whole
   * product rather than an area or a plan, as written by the Keeper. The cross-cutting ring shows it; without it, an item on
   * the product alone counts as not placed.
   */
  readonly wholeProductWhy?: string | null;
}

// ───────────────────────── §1.5 / §1.6 graph ─────────────────────────

export type NodeRefKind = 'reference' | 'thread' | 'fact' | 'source' | 'change' | 'session' | 'result';

export interface GraphNode {
  readonly id: string;
  readonly projectId: string;
  readonly category: NodeCategory;
  readonly label: string;
  readonly refKind: NodeRefKind;
  readonly refId: string;
  readonly validity: Validity;
  readonly progress: Progress | null;
  readonly acceptance?: Acceptance;               // work items only; '' when the project has no acceptance step
  readonly basis: Basis;
  readonly attribution: Attribution | null;
  readonly sourceIds: readonly string[];
  readonly areaId: string | null;                 // owning area reference id when placed
  readonly parentWorkId: string | null;           // sessions/runs/reviews fold under their work
  readonly replacedBy: string | null;
  /** When the node first appeared ('' when it predates this record); stars on the graph mark new nodes (owner 2026-09-17). */
  readonly createdAt?: string;
  readonly updatedAt: string;
}

export interface Evidence {
  readonly sourceIds: readonly string[];
  readonly factRecordIds: readonly string[];
  readonly factsSoFar: string;                    // e.g. "implemented, not yet verified"
}
export interface GraphRelation {
  readonly id: string;
  readonly projectId: string;
  readonly type: RelationType;
  readonly from: string;
  readonly to: string;
  readonly claim: string;
  readonly basis: Basis;
  readonly evidence: Evidence;
  readonly assessment: Assessment;
  readonly assessedAt: string | null;
  readonly assessedInJobId: string | null;
  readonly updatedAt: string;
}

// ───────────────────────── §1.7 notes ─────────────────────────

export interface NoteFact {
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly inferred: boolean;
  /** The note that puts a round's inferred rules to the owner (§1.15, §3.9): the rule this fact is about — a link, so its sentence carries no id (D105). */
  readonly ruleId?: string;
}
/** One choice a `For your decision` note puts to the owner (§4.2, D105): what is chosen, and what follows from choosing it. */
export interface NoteOption {
  readonly option: string;
  readonly then: string;
}
export interface NoteBody {
  /**
   * A `For your decision` note's options, one per choice, at least two (§4.2, D105; CKC-08 AC-26): they come after the
   * first sentence (the preview: the question) and the background. Absent on other notes, and on notes written before D105.
   */
  readonly options?: readonly NoteOption[];
  readonly currentView: string | null;
  readonly whyItMatters: string | null;
  readonly facts: readonly NoteFact[];
  readonly otherExplanations: string | null;
  readonly keepAdjust: string | null;
  readonly whatWouldSettleIt: string | null;
}
export interface NoteVersion {
  readonly version: number;
  readonly at: string;
  readonly title: string;
  readonly preview: string;
  readonly body: NoteBody;
  readonly ask: NoteAsk;
  readonly judgementRecordId: string;             // `Based on`
  readonly reason: string;                        // why this version exists
}
export interface NoteMount {
  readonly kind: 'project' | 'node' | 'relation' | 'path';
  readonly ids: readonly string[];
}
export interface DiscussionEntry {
  readonly role: 'owner' | 'keeper';
  readonly text: string;
  readonly at: string;
  readonly sourceId: string | null;
}
export interface FollowUp {
  readonly kind: 'investigation' | 'adjustment' | 'relook' | 'request';
  readonly jobId: string | null;
  readonly at: string;
  readonly summary: string;
}
export interface NoteCameFrom {
  /** One of the four; null when the work that wrote it is none of them (e.g. organizing a material). */
  readonly kind: NoteOrigin | null;
  /** The writing job's own kind, kept so the four can be refined later without re-deriving. */
  readonly jobKind: string | null;
  readonly jobId: string | null;
  /** For a change follow-up: the change or changes the note is about. */
  readonly changeIds: readonly string[];
}

export interface Note {
  readonly id: string;
  readonly projectId: string;
  readonly mount: NoteMount;
  readonly status: NoteStatus;
  readonly ownerResponse: OwnerResponse | null;
  readonly versions: readonly NoteVersion[];      // last = current
  readonly discussion: readonly DiscussionEntry[];
  readonly followUps: readonly FollowUp[];
  readonly author: { readonly agent: string; readonly model: string | null };
  readonly resolvedReason: string | null;
  readonly withdrawnReason: string | null;
  readonly delegatedTo: { readonly holder: string; readonly requestId: string; readonly handledAt: string | null } | null;
  /** How the note came about (Spec §4.1); absent on notes written before it was recorded, until they are backfilled. */
  readonly cameFrom?: NoteCameFrom | null;
  /** Which of the six things the owner judges this note is about (§2.13), e.g. `Dropped along the way?` (3), `Ratify?` (4). */
  readonly sixThing?: SixThing | null;
  /**
   * CN (E152; Spec §2.12): what an absence claim in this note rests on — where it was looked for and up to when. A note
   * that says something has no follow-up, was let pass or was taken up by nobody carries it (keeper/organize/absence.ts).
   */
  readonly looked?: AbsenceLooked | null;
  readonly language: string;
  readonly updatedAt: string;
}

// ───────────────────────── §1.8 change records ─────────────────────────

/**
 * The piece of work one change record covers (§1.8, D56): one session or one execution, together with the files it
 * changed and the commits it made. A piece of work never spans two Follow up rounds — a session still running when
 * a round starts is organized only up to its last pause, and the rest becomes another piece of work next round.
 */
export interface WorkSegment {
  readonly kind: WorkSegmentKind;
  readonly label: string;                         // which session or execution, or how the time range was cut
  readonly sessionId: string | null;
  readonly startedAt: string;
  readonly endedAt: string;                       // the last pause when the work had not finished
  /** True when the work was still going at `endedAt`: what came after belongs to the next round's record. */
  readonly openEnded: boolean;
}

/**
 * One net change inside a piece of work (§1.8). A piece of work that fixed 7 problems has 7 items; each carries its
 * own category, effect, before and after, basis, and the objects it directly changed.
 */
export interface ChangeItem {
  readonly id: string;
  readonly at: string;
  readonly atSource: 'material' | 'observed';
  readonly material: ChangeMaterial;
  readonly effect: ChangeEffect;
  readonly title: string;
  readonly summary: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly sourceIds: readonly string[];          // basis: which file, commit or session segment of this work
  readonly by: Attribution;
  /** Why this change was made, in the material's own terms — the owner asked for it, a trial showed the old shape
   *  failed, a contract required it. `Changes since last session` says what changed *and why* (D59 design 2), and
   *  only the material this work came from knows the why; a later reader cannot recover it. Empty when the material
   *  gives no reason: that is a fact about the material, not a gap to fill in. */
  readonly why: string | null;
  /** The objects this item directly changed — its subject. Downstream is found from here (§5.5); the subject
   *  itself is not downstream of its own item. */
  readonly affects: readonly string[];
}

/** §2.10 an object listed in the change's detail but never judged, with the reason it is not. */
export interface NotJudgedEntry {
  readonly nodeId: string;
  readonly reason: NotJudgedReason;
  readonly at: string;
}

/**
 * One item of one record, as an object's judgement refers to it. `itemId` is empty for a record written before
 * items existed, which counts as one item covering the whole record.
 */
export interface ItemRef {
  readonly changeId: string;
  readonly itemId: string;
}
export interface LackedItem extends ItemRef {
  readonly what: string;                          // what the object still has to follow
}
/** Who said an item need not be handled, and where they said it (§2.10: only the owner or the object's holder can,
 *  and it is read from the owner's response or from later material). */
export interface ItemCloseAuthority {
  readonly who: 'owner' | 'holder';
  readonly role: string | null;                   // the holder's role; null when the owner said it
  readonly sourceId: string;                      // the material that carries what they said
}
/** An item that has ended: the object followed it, a later change superseded it, or nobody has to handle it.
 *  The last two carry what makes them checkable; both fields are absent on entries written before that was
 *  recorded, which is why they are optional here and required by the tool that writes new ones. */
export interface ClosedItem extends ItemRef {
  readonly close: ItemClose;
  readonly reason: string;
  /** `Superseded by a later change`: the change record whose later content took this item's place. */
  readonly supersededByChangeId?: string;
  /** `No action needed`: who said so, and the material that shows it. */
  readonly saidBy?: ItemCloseAuthority;
}

export interface PropagationEntry {
  readonly nodeId: string;
  readonly state: Propagation;
  readonly sourceOrReason: string;
  readonly updatedAt: string;
  /** The round whose one judgement of this object produced the entry, and which items of this record it covered. */
  readonly roundId?: string;
  readonly itemIds?: readonly string[];
}
export interface ChangeRecord {
  readonly id: string;
  readonly projectId: string;
  readonly at: string;
  readonly atSource: 'material' | 'observed';
  readonly material: ChangeMaterial;
  readonly effect: ChangeEffect;
  readonly title: string;
  readonly summary: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly sourceIds: readonly string[];
  readonly by: Attribution;
  readonly affects: readonly string[];            // node ids: the union of the items' subjects
  readonly propagation: readonly PropagationEntry[];
  readonly segment: { readonly name: string; readonly sourceId: string } | null;
  readonly createdInJobId: string | null;
  readonly updatedAt: string;
  /** The piece of work this record covers (D56); absent on records written before it was recorded. */
  readonly work?: WorkSegment | null;
  /** This piece of work's net changes. Absent on a record written before items existed: the record's own
   *  material, effect, before and after are then read as its single item. */
  readonly items?: readonly ChangeItem[];
  /** Objects the record reached that are never judged (§2.10): listed here, not in `propagation`. */
  readonly notJudged?: readonly NotJudgedEntry[];
}

/**
 * One object's judgement for one round (§2.10, §5.5; D56). Every item that reached the object this round, plus the
 * items on it with no conclusion yet, are judged together and get one state — not one state per change and object.
 * On the 2026-09-18 assets the pairwise form gave 233 objects 5,237 judgements, and the real findings were buried.
 */
export interface ObjectJudgement {
  readonly id: string;                            // `${roundId}:${nodeId}`
  readonly projectId: string;
  readonly nodeId: string;
  readonly roundId: string;
  readonly state: Propagation;
  readonly sourceOrReason: string;
  /** Which records and which of their items this state covers. */
  readonly covers: readonly ItemRef[];
  readonly followed: readonly ItemRef[];
  /** What the object still lacks; each stays until it is followed, superseded, or declared not to need handling. */
  readonly lacks: readonly LackedItem[];
  readonly closed: readonly ClosedItem[];
  /** The object's own `updatedAt` when it was judged: the judgement re-opens as soon as the object changes. */
  readonly objectUpdatedAt: string;
  readonly jobId: string | null;
  readonly at: string;
}

/**
 * One round of Follow up (§3.8, §5.5): one main job, one result. Every count in the result is taken from the assets
 * by the program (D43); the model writes only the sentences.
 */
export interface RoundCounts {
  readonly objectsJudged: number;
  readonly byState: Readonly<Record<string, number>>;
  readonly behind: number;
  readonly itemsLacked: number;
  readonly notJudged: number;
  readonly requests: number;
  readonly notes: number;
  readonly decisionsReplaced: number;
  readonly decisionsSuspected: number;
  /**
   * What the round made new, counted from its news (§3.8; CKC-07 AC-27, CKC-24 AC-15): breakpoints newly lit, send-backs
   * new and moved, what newly became one of the six things, semantic patches confirmed, notes written or updated.
   * Absent on a result closed before rounds counted them.
   */
  readonly news?: { readonly breakpoints: number; readonly sendbacksNew: number; readonly sendbacksMoved: number; readonly sixThings: number; readonly patches: number; readonly notes: number };
}
export interface RoundResult {
  readonly at: string;
  readonly summary: string;                       // the round's own account, written by the main job
  readonly counts: RoundCounts;                   // counted by the program, never by the model
  readonly behind: readonly { readonly nodeId: string; readonly holder: string | null; readonly lacks: number }[];
  readonly byHolder: readonly { readonly holder: string; readonly requestId: string; readonly nodeIds: readonly string[] }[];
  readonly noteIds: readonly string[];
  readonly unassigned: readonly string[];         // objects behind with no holder the Keeper could identify
  /** What the round made new, each with its position, or that it found nothing new (§3.8, D79). Absent on older results. */
  readonly news?: RoundNews | null;
}
export interface FollowUpRound {
  readonly id: string;
  readonly projectId: string;
  readonly number: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly mainJobId: string | null;
  readonly result: RoundResult | null;
  /** When the owner opened this round's result. `Notes (attention)` carries one item per round and it leaves once
   *  they have looked (D56 item 3). */
  readonly seenAt?: string | null;
}

// ───────────────────────── §1.11 marks and coverage ─────────────────────────

export interface EntryMark {
  readonly id: string;
  readonly projectId: string;
  readonly kind: MarkKind;
  readonly targetId: string;                      // node, reference, thread or source id
  readonly clueSourceIds: readonly string[];
  readonly clue: string;
  readonly since: string;
  readonly noteId: string | null;
  readonly closed: { readonly result: MarkClose; readonly at: string; readonly reason: string } | null;
  /** `Decided without owner`: who set the rule in the owner's place and when (§1.9, §2.6). */
  readonly decidedBy?: { readonly who: string; readonly at: string } | null;
  /** Which of the six things the owner judges this mark is material for (§2.13), when it is one; for `Filter`. */
  readonly sixThing?: SixThing | null;
  /** CN: what was read before it was judged dropped along the way or let pass (keeper/organize/absence.ts). */
  readonly looked?: AbsenceLooked | null;
}

export interface PendingMaterial {
  readonly kind: 'file' | 'session' | 'commit' | 'worktree' | 'task' | 'qc' | 'other';
  readonly ref: string;                           // path, session file, commit …
  readonly label: string;
  readonly since: string;
}
/**
 * A file over the size intake reads of one file (§1.11 `Skipped: too large`, D105): its text is not read; the ledger
 * still records its path, size and versions. Not a failure and not pending.
 */
export interface SkippedMaterial {
  readonly ref: string;
  /** Its size when it was skipped; null for an entry an older home recorded as a failure, whose file is gone since. */
  readonly bytes: number | null;
  /** The most intake reads of one file, in bytes. */
  readonly limit: number;
  readonly at: string;
}
export interface CoverageScope {
  readonly id: string;                            // 'project' or area/thread id
  readonly kind: 'project' | 'area' | 'thread';
  readonly label: string;
  readonly coverage: CoverageLabel;
  readonly asOf: string | null;
  readonly commit: string | null;
  readonly pending: readonly PendingMaterial[];
  readonly organizing: readonly PendingMaterial[];
  /** What went wrong while organizing and stayed undone after the retries (§3.10). A file too large to read is not here (D105). */
  readonly failed: readonly { readonly ref: string; readonly reason: string; readonly at: string }[];
  /** `Skipped: too large` (§1.11, §6.7): listed in Project scope, not counted in the top bar. Absent in a home written before D105. */
  readonly skipped?: readonly SkippedMaterial[];
  readonly lastRelookAt: string | null;
}
/** §1.11 materials of one organizing level, counted by material kind. */
export interface LevelCount {
  readonly level: OrganizingLevel;
  readonly byKind: Readonly<Record<string, number>>;
  readonly materials: number;
  readonly chars: number;
}
/** §3.7 one takeover depth option with this project's actual figures (CKC-13 AC-19). */
export interface DepthOption {
  readonly depth: TakeoverDepth;
  readonly levels: readonly LevelCount[];
  readonly toOrganize: number;                    // materials the Keeper would read, in full or for conclusions
  readonly chars: number;
  readonly minutes: number;                       // at the current parallel setting
  readonly cost: number | null;
  readonly lanes: number;
}
/**
 * §3.7 the owner's-words step of the first round, as evidence (D37): when the Keeper started reading the owner's own
 * messages and when it wrote the last of the `Owner's words` items, how many messages and characters it read of how
 * many there are, and how many items it wrote. Counted from the job's steps and trace, never by the model.
 */
export interface OwnerWordsStep {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly minutes: number;
  readonly calls: number;
  readonly utterances: number;
  readonly chars: number;
  readonly total: number;
  readonly totalChars: number;
  readonly items: number;
}
/**
 * §3.7 by the clerk method: what a Full deepening reads path by path — counted from the ledger, by material category —
 * what Focused covers, the stated basis of the estimates, and the deepening's progress path by path once it runs.
 */
export interface DeepeningPlan {
  /**
   * Each path with what it reads by category, counted by the question list (§3.7: 按问题清单算); `basis` says how a path
   * was counted — what its brief names, or the ledger's totals for its kind of question.
   */
  readonly paths: readonly { readonly path: string; readonly reads: readonly { readonly category: string; readonly count: number }[]; readonly basis?: string }[];
  readonly focused: readonly { readonly category: string; readonly count: number }[];
  readonly basis: string;
  /**
   * Each step of the deepening under way or done: its status, its time, and — once it has read — what it read against its
   * path's plan. A path read by reading assignments is one row with `reading`, however many assignments it took.
   */
  readonly progress: readonly { readonly path: string; readonly status: string; readonly minutes: number | null; readonly reads?: DeepeningReads; readonly reading?: PathReading }[];
  /** The deepening as it ran, beside the estimate (CKC-13 AC-8): what the whole round read against the plan, its time and cost. */
  readonly actual?: DeepeningActual | null;
  /** How a deepening read by assignments is counted and how its assignments are sized, in words; absent before one ran. */
  readonly readingBasis?: string | null;
}
/**
 * One path of a Full deepening read by reading assignments (Spec §3.3, §3.7; the owner's approval of 2026-09-28): what it
 * planned, what was read of it, what the round recorded as read in part or not read — each with why — what is still open,
 * and its assignments. Counted by the program from the assignments' recorded reads (`JobStep.reads`); never by a model.
 */
export interface PathReading {
  readonly planned: number;
  /** Read whole. */
  readonly whole: number;
  /** Read in part, recorded with why. */
  readonly part: number;
  /** Recorded as not read, with why. */
  readonly notRead: number;
  /** Not accounted for yet: an assignment (a first one or a follow-up) still has it. */
  readonly open: number;
  readonly assignments: {
    readonly total: number; readonly done: number; readonly running: number; readonly queued: number; readonly failed: number;
    /** Of `total`, the follow-ups: assignments that took up what earlier ones left unread. */
    readonly followUps: number;
  };
  /** Each planned material recorded as read in part or not read, with why and who said it. */
  readonly accounted: readonly { readonly key: string; readonly label: string; readonly outcome: 'part' | 'none'; readonly why: string; readonly by: 'assignment' | 'program' }[];
}
/**
 * What a deepening step read against what its path planned (§3.7; CKC-13 AC-8), in the plan's units: a document version,
 * a code file, a commit — and a session, for a path counted by the ledger's totals. Counted from what the step's jobs read
 * (`JobStep.reads`), never written by a model.
 */
export interface DeepeningReads {
  /** What the path planned to read closely (as `paths` counts it); null for a step no path plans (cross-check, synthesis, spot-check). */
  readonly planned: number | null;
  /** Of what was planned: read whole, read only in part; and `left`, planned and not read at all (null with no plan). */
  readonly whole: number;
  readonly part: number;
  readonly left: number | null;
  /** What was read that the plan does not name — for a step with no plan, everything it read. */
  readonly beyond: { readonly whole: number; readonly part: number };
  /** The same by category (document versions, code files, commits, sessions); a category with nothing planned or read is left out. */
  readonly byCategory: readonly ({ readonly category: string } & Omit<DeepeningReads, 'byCategory'>)[];
}
/** The deepening round as it ran: what it read against the plan (every step of it together), its time and its cost. */
export interface DeepeningActual extends DeepeningReads {
  readonly depth: TakeoverDepth;
  readonly roundId: string;
  readonly status: string;
  readonly minutes: number | null;
  readonly cost: number | null;
}
/**
 * The materials a job read only in part (CKC-13 AC-8), counted beside the levels: §1.11 has no level for a part read, so
 * such a material stays at the level it has otherwise — mostly `Indexed` — and `byLevel` says which.
 */
export interface PartReads {
  readonly materials: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly chars: number;
  readonly byLevel: Readonly<Record<string, number>>;
}
/** §3.7 takeover progress: depth, stage, the first usable slice as evidence (D37), levels, remaining work, the three options. */
export interface TakeoverStatus {
  readonly depth: TakeoverDepth | 'Depth not chosen';
  /** `Not started`: the owner has not pressed `Start` (D105). The depth is chosen before the start, so no stage asks for it. */
  readonly stage: 'Not started' | 'First usable' | 'Deepening' | 'Daily';
  readonly firstUsable: { readonly startedAt: string; readonly completedAt: string | null; readonly minutes: number | null; readonly byKind: Readonly<Record<string, number>>; readonly chars?: number; readonly share?: number | null; readonly ownerWords?: OwnerWordsStep | null };
  readonly levels: readonly LevelCount[];         // every material of the project, by level
  /** Beside the levels: the materials a job read only in part (they stay at their level). Absent on coverage written before it was counted. */
  readonly readInPart?: PartReads;
  readonly sampled: readonly { readonly rule: string; readonly samples: readonly string[]; readonly members: number }[];
  readonly remaining: { readonly materials: number; readonly minutes: number; readonly cost: number | null } | null;   // under the chosen depth
  readonly options: readonly DepthOption[];
  /**
   * `perMaterial`: the time and cost of reading one planned material, measured from this project's own jobs — a finished
   * deepening's reading assignments, else the first usable round's steps — and what they were measured from.
   */
  readonly rates: { readonly basis: string; readonly msPerChar: number; readonly costPerChar: number | null; readonly perMaterial?: { readonly minutes: number; readonly cost: number | null; readonly from: string } | null };
  /**
   * The history-tier materials (older than the takeover and outside the first usable slice) whose level is `Indexed`,
   * `Sampled` or `Not organized` — counted from the levels, whatever the depth (CKC-13 AC-10: what is left is listed).
   */
  readonly historyNotOrganized: number;
  readonly noteId: string | null;
  /** By the clerk method: the deepening's paths, what they read, and their progress (§3.7). */
  readonly deepening?: DeepeningPlan | null;
}
export interface Coverage {
  readonly projectId: string;
  readonly state: UnderstandingState;
  readonly scopes: readonly CoverageScope[];
  readonly missingSourceKinds: readonly { readonly kind: string; readonly reason: string }[];
  readonly processedByKind: Readonly<Record<string, number>>;
  readonly pendingByKind: Readonly<Record<string, number>>;
  readonly takeover?: TakeoverStatus | null;
  /**
   * The last Follow up round that closed, for the top bar (§6.2): when it ended and whether it found anything new — "the
   * last round found nothing new" is said here and nowhere else when it did not (CKC-07 AC-27, CKC-24 AC-15).
   */
  readonly lastFollowUp?: { readonly recordId: string; readonly round: number; readonly endedAt: string; readonly nothingNew: boolean; readonly statement: string } | null;
  readonly updatedAt: string;
}

// ───────────────────────── §1.13 Keeper work and judgement records ─────────────────────────

export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number | null;                   // null when the runtime reports none
}
/**
 * What one step read (Spec §1.11 `Read in full`; CKC-13 AC-8), worked out from the call and its result as the step ended
 * (keeper/bounds/reads.ts): a file — whole, or some of its lines — a version of a document from the history, or a commit.
 * Searching (grep and the like), listing and counting are not reading and are not here. A step recorded before this was
 * kept has none; the coverage then counts its `target` as before.
 */
export interface StepRead {
  /** The file, absolute. Absent: a commit was read (`rev`). */
  readonly path?: string;
  /** With `path`: the commit whose version of the file was read (the history, not the current file). Alone: the commit read. */
  readonly rev?: string;
  /** The lines shown, 1-based and inclusive. Neither given: the whole file; `to` not given: to its end. */
  readonly from?: number;
  readonly to?: number;
  /** How many lines the file had when read, given with a range: whether the ranges read together cover it. */
  readonly lines?: number;
  /** Only a part whose lines are not known was shown: the last lines, what a pattern picked, a diff, output cut short. */
  readonly part?: boolean;
  /**
   * A session read through the ledger (`pk_ledger_sessions` with a session): its ledger id. `from`, `to` and `lines` are
   * then message positions (1-based: the ledger's message index plus one) and the session's message count.
   */
  readonly session?: string;
}
export interface JobStep {
  readonly at: string;
  readonly tool: string;
  readonly target: string;
  readonly summary: string;
  readonly isError: boolean;
  /** What the step read (`StepRead`); absent on steps recorded before it was kept, and on steps that read nothing. */
  readonly reads?: readonly StepRead[];
}
export interface KeeperJob {
  readonly id: string;
  readonly projectId: string;
  readonly kind: JobKind;
  readonly initiator: 'auto' | 'owner';
  readonly scope: { readonly kind: string; readonly ids: readonly string[]; readonly label: string };
  readonly status: JobStatus;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly savedResults: readonly { readonly collection: string; readonly id: string; readonly label: string }[];
  readonly usage: Usage;
  readonly agent: string;                         // 'pi'
  readonly model: { readonly provider: string; readonly id: string; readonly thinking: string | null } | null;
  readonly sessionFile: string | null;
  readonly sessionId: string | null;
  readonly steps: readonly JobStep[];
  readonly error: string | null;
  readonly requestBasis: { readonly kind: 'delegation' | 'authorization'; readonly ref: string; readonly label: string } | null;
  readonly parentJobId: string | null;
  readonly resultText: string | null;
  readonly priority: number;                      // §3.2 order: 0 owner, 1 in-progress work, 2 re-look, 3 backlog
  readonly task: unknown;                         // job-kind specific parameters, replayed on Continue/Retry
  /** How many reads or shell commands the read boundary refused during this job (CKC-03 AC-23); each is also a step. */
  readonly boundaryDenials?: number;
  /**
   * The step of a clerk-method round this job is (Spec §3.3): which round, which step, and for a deep sweep its name — and,
   * when the sweep is read by reading assignments (§3.7), which assignment of the round's reading record this job is.
   */
  readonly step?: { readonly roundId: string; readonly kind: RoundStepKind; readonly path: string | null; readonly assignment?: string | null;
    /** D99: a lane's kind and the slots it writes; `path` is then the lane's name. */
    readonly lane?: { readonly kind: LaneKind; readonly slots: readonly SlotKind[] } | null } | null;
  /** Where this job's time went (§3.10, D81), filled in when it ends. */
  readonly timing?: StepTiming | null;
  /**
   * The job's next run goes on in its own pi session (`sessionFile`) instead of starting over (Spec §3.10, D99): set when
   * a run is interrupted — the model provider refused it (a rate limit, an exhausted quota) or ProjectKeeper restarted
   * while it ran — and cleared when a run starts. `since` is when the interrupted run stopped.
   * D99: `pause` — the owner paused organizing and the running tree was stopped to go on when it resumes (E148 D-i);
   * `again` — the program runs the job again in its own session (a round's main job that ended before its handover, or
   * its synthesis job that ended before the round's Result; D103).
   * `note`: what the continued session is told besides, e.g. the stage the main agent stopped at.
   */
  readonly resume?: { readonly why: 'provider' | 'restart' | 'pause' | 'again'; readonly since: string; readonly note?: string | null } | null;
}

export interface JudgementRecord {
  readonly id: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly at: string;
  readonly scope: { readonly kind: string; readonly ids: readonly string[]; readonly label: string };
  readonly inputs: {
    readonly referenceIds: readonly string[];
    readonly threadIds: readonly string[];
    readonly areaIds: readonly string[];
    readonly relationIds: readonly string[];
    readonly keyEvidenceSourceIds: readonly string[];
    readonly conflictingSourceIds: readonly string[];
    readonly previousNoteIds: readonly string[];
    readonly investigations: readonly { readonly jobId: string; readonly conclusion: string; readonly sourceIds: readonly string[] }[];
    /**
     * D103: the round documents a round's synthesis was given — the lanes' reports, the adoption record and the main
     * agent's handover (CKC-23 AC-8: `Based on` lists what it received). Absent on records written before, and on a
     * re-look outside a round.
     */
    readonly roundDocIds?: readonly string[];
  };
  /** What was deliberately not given (e.g. "implementation session history as a whole"). */
  readonly excluded: readonly string[];
  readonly outcome: {
    readonly noteIds: readonly string[];
    readonly assessments: readonly { readonly relationId: string; readonly assessment: Assessment }[];
    readonly reconsideredOnly: boolean;
    /**
     * D103 (CKC-08 AC-25): the notes standing from earlier rounds this synthesis looked at again and found still to hold,
     * each with what it read that shows it. No new version of the note is written for it (keeper/organize/standing-notes.ts).
     */
    readonly stillHolds?: readonly { readonly noteId: string; readonly read: readonly string[]; readonly at: string }[];
  };
  /** Thread id → `progress/validity` at judgement time; a later difference is a substantial change (§3.4). */
  readonly snapshot?: Readonly<Record<string, string>>;
}

// ───────────────────────── §1.15 the project's rules ─────────────────────────

/**
 * One rule the project set for itself (§1.15, D62, D64): about its material (`Material rules`, with a category) or
 * about how it works (`How work is organized`, `Working rules`). The Keeper finds, digs out, records and follows them;
 * it does not set them. Rules are not areas, work items or graph nodes (R-50).
 */
export interface ProjectRule {
  readonly id: string;
  readonly projectId: string;
  readonly group: RuleGroup;
  readonly category: MaterialRule | null;         // Material rules only
  readonly summary: string;                       // the Keeper's one sentence
  readonly excerpt: string | null;                // the project's own words; always there when the basis is Explicit
  readonly sourceIds: readonly string[];          // where it is written; for an inferred rule, the records it was inferred from
  readonly appliesTo: readonly string[];          // directories, branches, files, fields, roles or work
  readonly basis: Basis;
  readonly validity: Validity;                    // a changed rule: the new one Current, the old one Replaced pointing to it
  readonly replacedBy: string | null;
  /** The owner-summarized way of working this rule belongs to (for example a role system), when it does. */
  readonly ownerSystem: string | null;
  /** Where the project's actual practice differs from it, each side with its sources; neither side is rewritten. */
  readonly differsInPractice: readonly { readonly text: string; readonly sourceIds: readonly string[] }[];
  /** §2.12: the steps this rule says the project expects of its work (`How work is organized`), read by the breakpoints. */
  readonly expects?: readonly ProcessExpectation[];
  /** The owner confirmed it: their words and the message they said them in (§3.9). */
  readonly ownerConfirmation: { readonly sourceId: string; readonly quote: string; readonly at: string } | null;
  readonly jobId: string | null;
  readonly asOf: string;
  readonly updatedAt: string;
}

/**
 * The plan and focus of the organizing that follows the framing round (§3.7, D62): what the rules settle directly,
 * what is read closely, where the focus is and in what order. The owner sees it in Project scope and corrects it in
 * conversation; each correction is kept with their words and with what the plan said before.
 */
export interface OrganizingPlanContent {
  readonly byRule: readonly { readonly what: string; readonly targets: readonly string[]; readonly ruleId: string; readonly treatment: string }[];
  readonly readClosely: readonly { readonly what: string; readonly targets: readonly string[]; readonly why: string }[];
  readonly focus: readonly { readonly what: string; readonly why: string; readonly sourceIds: readonly string[] }[];
  readonly order: readonly string[];
}
export interface OrganizingPlanCorrection {
  readonly at: string;
  readonly sourceId: string;                      // the owner's message
  readonly quote: string;                         // the owner's words
  readonly changed: string;                       // what the correction changed, in the Keeper's words
  readonly previous: OrganizingPlanContent;       // what the plan said before it
}
export interface OrganizingPlan extends OrganizingPlanContent {
  readonly id: string;
  readonly projectId: string;
  readonly corrections: readonly OrganizingPlanCorrection[];
  readonly jobId: string | null;
  readonly asOf: string;
  readonly updatedAt: string;
}

// ───────────────────────── §1.4 merged duplicates ─────────────────────────

/**
 * A work item merged into the one kept (§1.4; CKC-06 AC-28; E64, E65). The merged one leaves the work items, its
 * sources, facts and relations move over, and its id resolves to the one kept. Not `Replaced`: that is the history of
 * something superseded, and a merge is the same unit of work written twice.
 */
export interface MergeRecord {
  readonly id: string;
  readonly projectId: string;
  readonly kind: 'thread';
  readonly mergedId: string;
  readonly keptId: string;
  readonly reason: string;                        // why they are one unit of work
  readonly sourceIds: readonly string[];          // what shows it
  readonly merged: WorkThread;                    // the merged work item as it was
  readonly at: string;
  readonly jobId: string | null;
  readonly roundId: string | null;
}

// ───────────────────────── §1.14 delegation and standing authorization ─────────────────────────

export interface Authorization {
  readonly id: string;
  readonly projectId: string;
  readonly scope: string;
  readonly sourceId: string;
  readonly quote: string;
  readonly at: string;
  readonly revokedAt: string | null;
  readonly projectFolder?: { path: string; commits: boolean; lastWrite: { at: string; commit: string | null } | null } | null;
}

// ───────────────────────── §5.4 modification requests to role holders ─────────────────────────

export interface ModificationRequest {
  readonly id: string;
  readonly projectId: string;
  readonly holder: string;                        // role name
  readonly what: string;
  readonly why: string;
  readonly basisSourceIds: readonly string[];
  readonly impact: readonly string[];             // node ids
  readonly noteId: string | null;
  readonly at: string;
  readonly handled: { readonly at: string; readonly evidenceSourceIds: readonly string[] } | null;
  /** The Follow up round this request belongs to (§5.4, D56): one holder gets one request per round, however many
   *  objects of theirs are behind. Absent on requests written outside a round. */
  readonly roundId?: string | null;
  /** The items this request asks the holder to follow, one line per object. */
  readonly lines?: readonly { readonly nodeId: string; readonly what: string; readonly changeIds: readonly string[] }[];
}

// ───────────────────────── §1.12 context packages ─────────────────────────

export interface ContextRequest {
  readonly scope: { readonly kind: 'project' | 'area' | 'work' | 'path' | 'question'; readonly ids: readonly string[] };
  readonly purpose: ContextPurpose;
  readonly kind: WorkKind;
  readonly recipient: string;                     // `Incoming agent` or a recognised role
  readonly lastSessionAt: string | null;
  readonly taskVersion?: string | null;           // the version the agent's task description cites (§7.3 `Version check`)
}
export interface ContextPackage {
  readonly id: string;
  readonly projectId: string;
  readonly request: ContextRequest;
  readonly asOf: string;
  readonly commit: string | null;
  readonly keeperStatus: string;
  readonly markdown: string;
  readonly citedSourceIds: readonly string[];
  readonly generatedAt: string;
  readonly deliveries: readonly { readonly sessionRef: string; readonly state: Delivery; readonly at: string }[];
}

// ───────────────────────── §1.1 project and scope ─────────────────────────

export interface ScopeItem {
  readonly id: string;
  readonly path: string;
  readonly category: ScopeCategory;
  readonly relation: ScopeRelation;
  readonly reason: string;
  readonly reasonSourceIds: readonly string[];
  readonly sessionHost: SessionHost | null;
  readonly readOnly: boolean;
  readonly copyOf: string | null;
  readonly worktreeOf: string | null;
  readonly versionControl: 'git' | 'none' | 'unknown';
  readonly missing: { readonly reason: string } | null;
  readonly addedBy: 'keeper' | 'owner';
  /** §1.1 (E60): a worktree measured against the trunk from git's records — merged or not, what was skipped, what was taken. */
  readonly worktree?: WorktreeSummary | null;
  /** §1.1: the project's ignore rule that leaves this out, and what it holds. */
  readonly ignoredBy?: IgnoreRuleRef | null;
  /** §1.1: third-party material or generated output — offered by the program, judged by the Keeper, corrected by the owner. */
  readonly classification?: ScopeClassification | null;
  /** §1.15 (CKC-04 AC-1, AC-14): the project's material rules that cover this location, with their words and sources. */
  readonly coveredBy?: readonly ScopeRuleCover[] | null;
  /** §1.1: a `Session source` item's working directory — the one whose sessions it reads; intake files each session
   *  under the item of its own directory by comparing this path. Absent on other items, and on session items recorded
   *  before it was. */
  readonly sessionCwd?: string;
  /** Base directory holding `.claude/projects` and `.codex/sessions` for this session source. A copy may use a frozen store instead of the host home. */
  readonly sessionStoreRoot?: string;
}
/** One file a worktree contributes (§1.1, E60): an uncommitted change, or content its branch has and the trunk does not. */
export interface WorktreeTaken {
  readonly path: string;                          // relative to the worktree, forward slashes
  readonly kind: 'Uncommitted change' | 'Changed on branch';
  readonly deleted?: boolean;                     // the change removes the file: nothing to read, still part of the work
}
export interface WorktreeSummary {
  readonly trunk: { readonly ref: string; readonly commit: string } | null;
  readonly branch: string | null;
  readonly head: string | null;
  readonly merged: boolean | null;                // every commit of its branch is in the trunk; null when git could not tell
  readonly uniqueCommits: number;                 // commits the trunk does not have
  readonly files: number;                         // files in the worktree: tracked ones, and untracked ones not ignored
  readonly sameAsTrunk: number;                   // skipped: the same as the trunk
  readonly olderVersions: number;                 // skipped: different only because the trunk moved on; the version history keeps them
  readonly taken: readonly WorktreeTaken[];       // taken: uncommitted changes and what the trunk does not have
  readonly error: string | null;
}
export interface IgnoreRuleRef {
  readonly file: string;                          // the ignore file as git names it: `.gitignore`, `docs/.gitignore`, `.git/info/exclude` …
  readonly line: number;
  readonly pattern: string;
  readonly files: number;                         // files it leaves out here
  readonly documents: number;                     // of them, documents: text a person wrote (notes, plans …)
  readonly documentNames: readonly string[];      // the first few, for the owner
  /** Files ignored one by one rather than as a whole directory: which, relative to the project root. */
  readonly paths?: readonly string[];
}
export interface ScopeClassification {
  readonly by: 'program' | 'keeper' | 'owner';
  readonly basis: Basis;
  readonly kind: string | null;                   // build output, cache, installed dependencies, vendored code, upstream repository, license, linked in …
  readonly evidence: readonly string[];           // what shows it when no source does: a directory name, a marker file, a remote, a link target
  readonly sourceIds: readonly string[];
  readonly ruleId: string | null;
  readonly jobId: string | null;
  readonly at: string | null;
}
export interface ScopeRuleCover {
  readonly ruleId: string;
  readonly category: MaterialRule | null;
  readonly summary: string;
  readonly excerpt: string | null;
  readonly sourceIds: readonly string[];
  readonly basis: Basis;
  readonly target: string;                        // the rule's own words for the location (its appliesTo entry)
}
/**
 * §1.1 the Keeper's classification of a location, or the owner's correction of it (CKC-04 AC-13, AC-17). The latest per
 * path stands; the owner's word stands over the Keeper's. A question the Keeper could not settle goes to the owner as a
 * scope question (§3.9).
 */
export interface ScopeJudgement {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;                          // absolute
  readonly relation: ScopeRelation;
  readonly reason: string;
  readonly sourceIds: readonly string[];
  readonly evidence: readonly string[];
  readonly basis: Basis;
  readonly ruleId: string | null;
  readonly by: 'keeper' | 'owner';
  readonly ownerQuote: string | null;
  readonly question: { readonly id: string; readonly question: string; readonly whyItMatters: string; readonly clues: readonly string[]; readonly options: readonly string[] } | null;
  readonly previous: { readonly relation: ScopeRelation; readonly reason: string; readonly by: 'keeper' | 'owner'; readonly at: string } | null;
  readonly jobId: string | null;
  readonly at: string;
}
export interface ScopeQuestion {
  readonly id: string;
  readonly question: string;
  readonly whyItMatters: string;
  readonly clues: readonly string[];
  readonly options: readonly string[];
  readonly answer: { readonly text: string; readonly at: string; readonly sourceId: string | null } | null;
}
/** §6.7 a toolchain location the project's config points at, with the config item it came from as its reason. */
export interface ToolchainLocation {
  readonly path: string;
  readonly reason: string;
  readonly configPath: string;
  /** false: listed for the owner but not a read root, because it is too broad (§3.1); absent in older records. */
  readonly used?: boolean;
  /** Why it is not used, e.g. "not used: too broad (the whole home directory)". */
  readonly notUsedReason?: string | null;
}
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly locations: readonly string[];          // what the owner gave
  readonly scope: readonly ScopeItem[];
  readonly scopeQuestions: readonly ScopeQuestion[];
  readonly keeperFiles: readonly { readonly path: string; readonly kind: string }[];
  /** §6.7 toolchain locations the project's own config points at (an SDK, a compiler); the Keeper may read them (§3.1). */
  readonly toolchain?: readonly ToolchainLocation[];
  readonly roles: readonly string[];              // recognised roles (empty when no role system)
  readonly language: string;
  readonly organizingPaused: boolean;
  /**
   * §3.7 the takeover depth the owner chose on the `Takeover` page before pressing `Start` (D105): the depth the takeover
   * runs to. Null or absent on a project that has not been started. The depth that actually ran is read from the rounds
   * (takeover-state.ts), never from this field alone.
   */
  readonly takeoverDepth?: TakeoverDepth | null;
  readonly takeoverDepthChosenAt?: string | null;
  /** §3.7 (D105): when the owner pressed `Start`. Absent on a project not started; a home from before D105 has rounds instead. */
  readonly takeoverStartedAt?: string | null;
  /**
   * The rhythm from before D105 (`Daily`: a day after the last round ended; `Continuous`). Read only to map an existing
   * home to `schedule` (schedule.ts `scheduleOf`); nothing writes it any more.
   */
  readonly organizeRhythm?: 'Daily' | 'Continuous';
  /** §3.8 (D105): the schedule of daily organizing the owner saved on the `Daily` page. Absent until saved: the default applies. */
  readonly schedule?: OrganizeSchedule | null;
  /** §3.8: the last scheduled time that was dealt with — a round started for it, or it was passed over, with why. */
  readonly scheduleHandled?: ScheduleHandled | null;
  /** §3.7 清空: what the project had spent before it was last cleared; the total stays in `Usage`, named as from before. */
  readonly usageBeforeClear?: { readonly usage: Usage; readonly clearedAt: string; readonly times: number } | null;
  /**
   * §6.10 (D105; CKC-03 AC-29, AC-35): the key and models this project runs on, chosen in `Keeper` → `Model provider`.
   * Absent until the owner saves one: the machine's settings apply (keeper/route.ts `routeOf`). It names keys by the
   * provider id they run under, never a key's value.
   */
  readonly route?: ProjectRoute | null;
  readonly lastRoundAt?: string | null;            // when the last round of daily upkeep ran out of work (rounds queue in waves, so it is stamped at the end)
  readonly followUpAt?: string | null;             // the owner asked for a round now (the dock's Follow up)
  readonly createdAt: string;                     // when the takeover started: material older than this is history unless the first picture needs it
  readonly lastOpenedAt: string | null;
  readonly lastScopedAt: string | null;
}

/** A model on a key: the provider id the key runs under, the model, how hard it thinks. */
export interface RouteModel { readonly provider: string; readonly id: string; readonly thinking: string | null }
/** One step's own model and thinking (§6.10); `provider` names whose model it is. */
export interface StepRoute { readonly provider?: string; readonly model?: string; readonly thinking?: string }
/** A project's route (§6.10; keeper/route.ts): its main model, each step's own setting, the backup order of keys. */
export interface ProjectRoute {
  readonly model: RouteModel;
  readonly backups: readonly RouteModel[];
  readonly steps: Readonly<Partial<Record<string, StepRoute>>>;
  readonly savedAt: string;
}

/** §3.8 how often a round of daily organizing starts by itself, and at what local time (D105). */
export type ScheduleFrequency = 'Off' | 'Every day' | 'On selected days' | 'Every N days' | 'Continuous';
export interface OrganizeSchedule {
  readonly frequency: ScheduleFrequency;
  /** Local time of day, `HH:MM`; unused by `Off` and `Continuous`. */
  readonly time: string;
  /** `On selected days`: days of the week, 0 = Sunday … 6 = Saturday. */
  readonly days?: readonly number[];
  /** `Every N days`: N, counted from `anchor`. */
  readonly everyDays?: number;
  /** `Every N days`: the local date (`YYYY-MM-DD`) the count starts from. */
  readonly anchor?: string;
  /** When the owner saved it; null on the default and on a schedule mapped from the old rhythm. */
  readonly savedAt: string | null;
}
export interface ScheduleHandled {
  /** The scheduled time dealt with (ISO). */
  readonly slot: string;
  readonly at: string;
  readonly outcome: 'round' | 'nothing changed' | 'a round was running';
  readonly roundId?: string | null;
}

export interface TraceEntry {
  readonly at: string;
  readonly jobId: string | null;
  readonly collection: string;
  readonly id: string;
  readonly op: 'put' | 'remove';
  readonly basisSourceIds: readonly string[];
  readonly summary: string;
}
