/**
 * Fixed vocabularies from the Spec (product/SPEC.md §1–§2, §6.9, §7.7; v2.8 additions marked where they are).
 *
 * These strings are the interface's fixed parts: identical across projects, English, and
 * used verbatim as labels. Keeper-written content never replaces them. Keep every list in
 * sync with the Spec section named beside it; the Spec is the authority, not this file.
 */

/**
 * §1.2 `Used as`. `null` in the data means the interface shows `Not yet judged`.
 * v2.8: `Reference only` — material the project says is for reference only, and the documents third-party material
 * brings with it; it can be cited, never a requirement, boundary or plan (§1.1, §1.15). `History only` — what exists
 * only in history: old versions and deleted files in version history, and the branches and directories the project
 * keeps for recovery only; it forms no current node and enters no context (D61).
 */
export const USED_AS = [
  'Purpose', 'Decision', 'Requirement', 'Design', 'Plan', 'Task', 'Status', 'Code', 'Test', 'QC',
  'Session', 'Run result', 'Reference only', 'History only', 'Other',
] as const;
export type UsedAs = (typeof USED_AS)[number];
export const NOT_YET_JUDGED = 'Not yet judged';

/** §1.2 source availability. Availability and validity are different things. */
export const AVAILABILITY = ['Changed since read', 'Moved', 'No longer available'] as const;
export type Availability = (typeof AVAILABILITY)[number];

/**
 * §1.5 generic node categories. A project without a category simply has no such nodes. v2.8 (D63): `Owner's words`,
 * the top layer of the product reference — what the owner said or explicitly confirmed, each with the words and
 * where they were said.
 */
export const OWNER_WORDS = "Owner's words";
export const NODE_CATEGORY = [
  "Owner's words", 'Product', 'Goal', 'Area', 'Requirement', 'Design', 'Decision', 'Plan', 'Work item', 'Session', 'Run',
  'Review', 'Test', 'Result', 'Change',
] as const;
export type NodeCategory = (typeof NODE_CATEGORY)[number];

/** §1.6 relation types; meaning is the same in every project. v2.8: `carries out` — a piece of work carries out a
 *  decision that asks for something to be done (§2.2). */
export const RELATION_TYPE = [
  'serves', 'refines', 'implements', 'verifies', 'depends on', 'produced', 'replaces',
  'contradicts', 'affects', 'carries out',
] as const;
export type RelationType = (typeof RELATION_TYPE)[number];

/** §2.3 basis. `Explicit` is not labelled by default; `Inferred` is shown. */
export const BASIS = ['Explicit', 'Inferred'] as const;
export type Basis = (typeof BASIS)[number];

/** §2.5 Keeper assessment of a relation. Only a re-look or an owner correction changes it. */
export const ASSESSMENT = ['Holds', 'Questioned', 'Not assessed'] as const;
export type Assessment = (typeof ASSESSMENT)[number];

/**
 * §2.1 validity. `Unjudged` has no interface label: it is the state right after reading,
 * before the Keeper judged the material; it stays out of the graph's default view.
 * v2.8 (D61): `Removed` — an object built before its material was deleted from the project's current version. The
 * deletion itself says "no longer needed"; it is not `Abandoned`, which carries a disposal.
 */
export const VALIDITY = ['Current', 'Proposed', 'Unjudged', 'Deferred', 'Replaced', 'Abandoned', 'Removed'] as const;
export type Validity = (typeof VALIDITY)[number];

/** §2.2 progress. Code existing is not `Done`. */
export const PROGRESS = ['Planned', 'In progress', 'Done', 'On hold'] as const;
export type Progress = (typeof PROGRESS)[number];

/**
 * §2.2 (v2.8) whether a decision that asks for something to be done was carried out. `Partly carried out` always says
 * what is still left. The work that carries it out is linked by `carries out`; a decision carried out stays `Current`
 * and is not read as a to-do.
 */
export const CARRY_OUT = ['Carried out', 'Partly carried out', 'Not carried out yet'] as const;
export type CarryOut = (typeof CARRY_OUT)[number];

/**
 * §2.2 acceptance (owner D41). Progress, acceptance and independent checking are three different facts. `Done` says
 * the promised result exists and the material says so; whether the owner accepted it is this, and whether anyone
 * checked it is the assessment on a `verifies` relation. Only the owner's own statement or an acceptance the project
 * records can set `Accepted`. A project with no acceptance step leaves this empty and the workbench does not show it.
 */
export const ACCEPTANCE = ['Accepted', 'Not yet accepted'] as const;
export type Acceptance = (typeof ACCEPTANCE)[number] | '';

/** §2.4 statement types inside a fact record. */
export const STATEMENT_TYPE = ['Observed', 'Claimed', 'Inferred', 'Open'] as const;
export type StatementType = (typeof STATEMENT_TYPE)[number];

/** §1.9 identity of a piece of material or Keeper output. */
export const IDENTITY = ['Decision', 'Artifact', 'Proposal', 'Report', 'Interpretation'] as const;
export type Identity = (typeof IDENTITY)[number];

/** §1.7 what the owner is asked to do about a note. */
export const NOTE_ASK = ['For your decision', 'Worth discussing', 'For information'] as const;
export type NoteAsk = (typeof NOTE_ASK)[number];

/** §2.7 note status and owner response, recorded separately. */
export const NOTE_STATUS = ['Current', 'Resolved', 'Withdrawn'] as const;
/**
 * Spec §4.1 (D47 supplement; D56 item 5 added the last two): how a note came about. `Organizing` is a note written
 * while a material was being organized, `Takeover` one written while taking the project over — two notes on the
 * 4873 home had neither and were left blank.
 */
export const NOTE_ORIGIN = ['Product re-look', 'Change follow-up', 'Investigation', 'Owner question', 'Organizing', 'Takeover'] as const;
export type NoteOrigin = (typeof NOTE_ORIGIN)[number];
export type NoteStatus = (typeof NOTE_STATUS)[number];
export const OWNER_RESPONSE = ['Discussed', 'Decided', 'Delegated', 'No action needed'] as const;
export type OwnerResponse = (typeof OWNER_RESPONSE)[number];

/**
 * §1.8 how one piece of work was cut out of the stream (D56). A change record covers one piece of work: a session
 * or an execution, together with the files it changed and the commits it made. Changes with no session are grouped
 * by time.
 */
export const WORK_SEGMENT_KIND = ['Session', 'Execution', 'Time range'] as const;
export type WorkSegmentKind = (typeof WORK_SEGMENT_KIND)[number];

/**
 * §1.8 what is not a change. The same matter comes up again and again in ordinary work — it is designed once,
 * executed once, asked about midway, checked, reviewed, looked up again by the next task, re-read after a
 * compaction, recalled from memory — and none of those is a new change. What is recorded is the net change.
 */
export const NOT_A_CHANGE = [
  'Restating', 'Re-reading', 'Checking a dependency', 'Re-reading after compaction', 'Recalling from memory',
  'Changed and changed back', 'Wording, formatting or version number only',
] as const;
export type NotAChange = (typeof NOT_A_CHANGE)[number];

/** §1.8 change record material category and effect; one record's items each carry their own pair. */
export const CHANGE_MATERIAL = [
  'Decision', 'Owner statement', 'Product direction', 'Plan update', 'Status report',
  'Development note', 'Code change', 'Test result', 'Review', 'Iteration boundary', 'Other',
] as const;
export type ChangeMaterial = (typeof CHANGE_MATERIAL)[number];
/** `Removed` (D61) is the item that records an object becoming `Removed` because its material was deleted (§2.1: each
 *  validity change is an item of a change record); §1.8's list has no word for it yet. */
export const CHANGE_EFFECT = [
  'Added', 'Approved', 'Replaced', 'Deferred', 'Abandoned', 'Completed', 'Corrected', 'Removed',
] as const;
export type ChangeEffect = (typeof CHANGE_EFFECT)[number];

/** §2.10 propagation state. One object gets one of these per round, for every item that reached it (D56). */
export const PROPAGATION = ['Updated', 'Still on old understanding', 'Reusable as is', 'Not yet checked'] as const;
export type Propagation = (typeof PROPAGATION)[number];

/**
 * §2.10 objects that are never judged, and why. A point-in-time record says how things stood then, so a later
 * change cannot leave it behind; a decision is checked for what replaced it (§5.5) instead. Both are listed in the
 * change's detail and neither counts towards what is pending.
 */
export const NOT_JUDGED_REASON = ['Point-in-time record', 'Decision'] as const;
export type NotJudgedReason = (typeof NOT_JUDGED_REASON)[number];

/** §2.10 the three ways an item on an object ends; until one of them happens the item stays with the object. */
export const ITEM_CLOSE = ['Followed', 'Superseded by a later change', 'No action needed'] as const;
export type ItemClose = (typeof ITEM_CLOSE)[number];

/** §1.11 coverage label of an active scope. */
export const COVERAGE_LABEL = ['Up to date', 'Organizing', 'Changes pending', 'Organizing paused'] as const;
export type CoverageLabel = (typeof COVERAGE_LABEL)[number];

/**
 * §1.11 entry marks and how they close. Marks are facts for judgement, not validities. v2.8 (D63): `Decided without
 * owner` — a rule or decision a role set in the owner's place that is in force now (§1.9).
 */
export const MARK_KIND = ['Suspected stale', 'Undocumented decision', 'Layer drift', 'Scope question', 'Disposal', 'Decided without owner'] as const;
export type MarkKind = (typeof MARK_KIND)[number];
export const MARK_CLOSE = ['Resolved', 'Fixed', 'Became a change', 'Dismissed', 'No longer relevant'] as const;
export type MarkClose = (typeof MARK_CLOSE)[number];

/** §1.12 work kind of a context package; §7.2 says unrecognised defaults to `Implement`. */
export const WORK_KIND = ['Implement', 'Review', 'Plan', 'Discuss product', 'Investigate'] as const;
export type WorkKind = (typeof WORK_KIND)[number];
export const CONTEXT_PURPOSE = ['Start', 'Work', 'Handover'] as const;
export type ContextPurpose = (typeof CONTEXT_PURPOSE)[number];
export const INCOMING_AGENT = 'Incoming agent';

/** §1.13 Keeper work kinds; §6.9 job status and overall Keeper status. */
export const JOB_KIND = ['Organizing', 'Product re-look', 'Investigation', 'Answering', 'Your request', 'Context'] as const;
export type JobKind = (typeof JOB_KIND)[number];
export const JOB_STATUS = ['Running', 'Queued', 'Paused', 'Stopped', 'Waiting for quota', 'Failed', 'Done'] as const;
export type JobStatus = (typeof JOB_STATUS)[number];
export const KEEPER_STATUS = [
  'Working', 'Working on your request', 'Idle', 'Organizing paused', 'Waiting for quota',
  'Unavailable', 'Not connected',
] as const;
export type KeeperStatus = (typeof KEEPER_STATUS)[number];

/**
 * §1.1 scope item category and relation. v2.8: `Third-party material` (SDKs, libraries and templates distributed with
 * the project, with their own documents) and `Generated` (build output, caches, exports) are listed apart: what the
 * project uses, not its own intent.
 */
export const SCOPE_CATEGORY = ['Directory', 'Repository', 'Worktree', 'Session source'] as const;
export type ScopeCategory = (typeof SCOPE_CATEGORY)[number];
export const SCOPE_RELATION = [
  'Main project', 'Worktree of main repo', 'Copy of another project', 'Nested repository',
  'Experiment', 'Third-party material', 'Generated', 'Excluded', 'Session source',
] as const;
export type ScopeRelation = (typeof SCOPE_RELATION)[number];

/** §3.7 understanding state shown in Project scope. */
export const UNDERSTANDING_STATE = ['Not organized yet', 'Initial model', 'Takeover complete'] as const;
export type UnderstandingState = (typeof UNDERSTANDING_STATE)[number];

/** §1.11 takeover depth (D36, D105), chosen on the `Takeover` page before `Start`. `null` in the data: the project has not been started. */
export const TAKEOVER_DEPTH = ['Full', 'Focused', 'First picture only'] as const;
export type TakeoverDepth = (typeof TAKEOVER_DEPTH)[number];
export const DEPTH_NOT_CHOSEN = 'Depth not chosen';

/**
 * §1.11 organizing level of one material, counted by category in the coverage. `Settled by rule` (batch C2, pending the
 * Product architect's word for it): material the project's own rules settle directly — the organizing plan names it, or
 * a rule decided how its sources are used — so it is not read closely, not counted in the depth question's close reading
 * (§3.7) and never listed as failed. `Skipped: too large` (D105): a file over the size intake reads of one file — its text
 * is not read, so it has no sources; the ledger records it. Not pending and not a failure.
 */
export const SKIPPED_TOO_LARGE = 'Skipped: too large';
export const ORGANIZING_LEVEL = ['Read in full', 'Conclusions only', 'Sampled', 'Settled by rule', 'Indexed', 'Not organized', SKIPPED_TOO_LARGE] as const;
export type OrganizingLevel = (typeof ORGANIZING_LEVEL)[number];

/** §7.7 delivery state of a mid-work update to an active session. */
export const DELIVERY = ['Delivered', 'Pending next read', 'Not supported by host'] as const;
export type Delivery = (typeof DELIVERY)[number];

/**
 * §6.3 graph scales and fixed group names. The scales are `Overview`, `Work` and `Compare` (D45); the `Change` view went
 * with D48: whether downstream followed a change is the Keeper's report in Follow up, not a scale.
 */
export const GRAPH_SCALE = ['Overview', 'Work', 'Compare'] as const;
export type GraphScale = (typeof GRAPH_SCALE)[number];
export const GROUP_EXISTING_FOUNDATION = 'Existing foundation';
export const GROUP_UNPLACED = 'Unplaced';
export const NO_ESTABLISHED_LINK = 'No established link';
export const UPDATE_PENDING = 'Update pending';

/** §1.3 product-reference categories (Goal/Area/Requirement/Design/Decision plus the applicable boundary). `Plan` is
 *  written here too: §1.5 draws plans and milestones as their own node category, and plan documents are read by the
 *  same jobs that read the other intent material (2026-09-17: without it the Keeper filed plans as Design). */
export const REFERENCE_CATEGORY = ["Owner's words", 'Product', 'Goal', 'Area', 'Requirement', 'Design', 'Decision', 'Plan', 'Boundary'] as const;
export type ReferenceCategory = (typeof REFERENCE_CATEGORY)[number];

/**
 * §1.15 (v2.8, D62, D64) the project's own rules, in the three groups Project scope and the start context show them
 * in (§6.7, §7.3; CKC-21). The first two are how the project works; the third is what it says about its material.
 */
export const RULE_GROUP = ['How work is organized', 'Working rules', 'Material rules'] as const;
export type RuleGroup = (typeof RULE_GROUP)[number];
/**
 * §1.15 the kinds of material rule the Keeper looks for at least. `Other` keeps the list open: a project may write
 * down a rule about its material that none of the six names.
 */
export const MATERIAL_RULE = ['Obsolete', 'Reference only', 'Recovery only', 'Authoritative', 'Untrusted', 'Declared open', 'Other'] as const;
/**
 * §2.12: which steps the project's own way of working expects of a piece of work, as a rule of `How work is organized`
 * says. A breakpoint for a missing step is lit only where the project expects the step (a project without independent
 * QC has no `Not checked`, D72): the program reads these, the rule's words stay the rule's.
 */
export const PROCESS_EXPECTATION = ['Written plan', 'Written dispatch', 'Independent check', 'Re-check after fix', 'Owner acceptance'] as const;
export type ProcessExpectation = (typeof PROCESS_EXPECTATION)[number];
export type MaterialRule = (typeof MATERIAL_RULE)[number];

/** Session hosts read in P1 (PLAN PA-2), plus pi for the Keeper's own sessions. */
export const SESSION_HOST = ['claude', 'codex', 'pi'] as const;
export type SessionHost = (typeof SESSION_HOST)[number];

export function isOneOf<T extends readonly string[]>(list: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}
