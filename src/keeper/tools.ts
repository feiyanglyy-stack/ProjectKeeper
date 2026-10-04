/**
 * pk_* tools: how the Keeper reads and writes ProjectKeeper assets from inside a pi session.
 * Every write records its basis (source ids) and the job it happened in (Spec §3.10 留痕).
 * These tools never touch project files.
 */
import type { ProcessExpectation } from '../model/vocab.ts';
import type { ClerkStage, StepTiming } from '../model/k-types.ts';
import type { LaneRunner } from './organize/lane-tools.ts';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type {
  AreaUnderstanding, Attribution, ChangeItem, ChangeRecord, ClaimedBy, ClosedItem, EntryMark, FactRecord, FollowUpRound, GraphNode, GraphRelation, ItemRef, JobInputs, LackedItem, Note, NoteBody, ObjectJudgement, OrganizingPlan, OrganizingPlanContent, ProjectRule, ReferenceItem, Source, Statement, WorkSegment, WorkThread, KeeperJob } from '../model/types.ts';
import {
  ACCEPTANCE, ASSESSMENT, BASIS, CARRY_OUT, CHANGE_EFFECT, CHANGE_MATERIAL, IDENTITY, ITEM_CLOSE, MARK_KIND, MATERIAL_RULE, NODE_CATEGORY, PROCESS_EXPECTATION,
  NOTE_ASK, OWNER_WORDS, PROGRESS, PROPAGATION, REFERENCE_CATEGORY, RELATION_TYPE, RULE_GROUP, STATEMENT_TYPE, USED_AS, VALIDITY,
  WORK_SEGMENT_KIND, isOneOf, type MaterialRule,
} from '../model/vocab.ts';
import { newId, stableId } from '../model/ids.ts';
import { normalizeMaterialTime } from '../model/time.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { cameFromFor } from './note-origin.ts';
import { laneNamesOf, noteFormRefusal, ownerTextRefusal } from './owner-text.ts';
import {
  MARK_ABOUT, NOT_A_CHANGE_ADVICE, NOT_JUDGED_MESSAGE, duplicateNote, isDecision, itemsForObject,
  itemsOf, judgeObject, lastJudgement, markRefusal, notAChange, notJudgedReason, objectExists, openRound, requestForHolder, roundNumberOf,
  roundResultOf, sameItem, settleNotJudged, startRound, undonePairs, type MarkAbout,
} from './adjustment.ts';
import { mergeOf, mergeRefusal, mergeWorkItems, resolveMergedId } from './merge.ts';
import { findReferences, formedFrom } from './references.ts';
import { replacementCircle, ruleUseRefusal } from './rules.ts';
import { historyTools, relationEndpointHistoryRefusal, ruleHistoryRefusal, usedAsHistoryRefusal, workItemHistoryRefusal } from './history-tools.ts';
import { ownerUtteranceTools } from './utterance-tools.ts';
import { anchorLabel, redactCredentials } from '../sources/anchor.ts';
import type { Project } from '../model/types.ts';
import { clerkFollowUpRecordOf, isTakeoverWork, judgesFollowUp, roundKindOf, takeoverRoundOf } from './roles.ts';
import { scopeTools } from './scope-tools.ts';
import { worktreeOrigin } from '../scope/worktree.ts';
import { checkVerbatim, inferredExcerptWarning, ownerConfirmationRefusal, ownerWordsRefusal, referenceQuoteRefusal, ruleExcerptRefusal, sameWords } from './verbatim.ts';
import { incompleteCall } from './step-timing.ts';
import { isNumberShaped, numberOnlyRefusal, otherObjectOf, undefinedNumbers, withNumbering } from './numbers-check.ts';
import { isNumberOnly } from './organize/entries.ts';
import { NAME_SEP, placeAgain, reachOf } from './organize/placing.ts';
import { Ledger } from '../ledger/index.ts';
import { NO_PLAN } from '../../ui/placement.js';
import { workbenchPlacement } from './organize/workbench-placement.ts';
import { inferenceContext, noAreaWhyRefusal, noPlanWhyRefusal, noteOverride, planLayerPresent, programTargetsOf, type InferenceContext } from './organize/placement-inference.ts';
import { AS_FAR_AS, absenceClaims, absenceRefusal, lookedLine, lookedRecord, parseLooked, presentOf, stampAsFarAs } from './organize/absence.ts';
import { plansOf } from '../process/placement.ts';
import { successorOf } from './organize/generation-check.ts';
import { earlierWork } from './organize/carried-on.ts';
import { ownerWordsContextRefusal } from './organize/owner-lines.ts';

/** Why a takeover job gets no Follow up round (Spec §5.5, §3.7). */
const TAKEOVER_NO_ROUND = 'This job is part of taking the project over, and propagation is judged in the Follow up rounds after the takeover, so it opens no Follow up round and joins none. During the takeover, record what the material shows on the objects themselves — progress, results, validity, marks — and run the replacement check along the timeline with pk_check_decisions.';
const TAKEOVER_UNDERWAY = (stage: string) => `The project is still being taken over (stage: ${stage}), and propagation is judged in the Follow up rounds that start once the takeover is done, so no round is opened now. Record what you found on the object itself — progress, results, validity, a mark with its clue — and it is judged in the first Follow up round.`;
const NOT_THE_ROUNDS_MAIN_JOB = 'A Follow up round’s judgements are written by that round’s cross-check and its one result is counted when the round closes (before the clerk method, by the round’s own main job), so this job neither opens a round nor judges or writes a result in the one that is open. Record what the owner said or what you found on the object itself — the work item, the reference item, a mark with its clue — citing the source, and the next Follow up round judges it; the owner can start that round now with Follow up.';
const UNKNOWN_ROUND_JOB = (id: string) => `Keeper job ${id || '(missing id)'} is not registered in this project, so it cannot open or join a Follow up round or write a propagation judgement.`;

/**
 * The context the tools read at call time. A conversation session keeps one tool set across
 * turns, so the runtime updates the per-job fields (jobId, onSaved …) on this object each turn.
 */
export interface ToolContext {
  readonly store: ProjectStore;
  readonly project: Project;
  jobId: string;
  jobKind: string;
  readonly model: string | null;
  /** Called by pk_investigate; provided by the runtime (nested focused session). */
  investigate?: (question: string, hints: string[]) => Promise<{ conclusion: string; sourceIds: string[]; jobId: string }>;
  onSaved?: (collection: string, id: string, label: string) => void;
  /** Materials this job organizes: a fact record about one of them gets a stable id per material and covers all its sources. */
  materials?: readonly { readonly key: string; readonly sourceIds: readonly string[] }[];
  /** The judgement record of a product re-look: notes, assessments and investigations attach to it. */
  judgementId?: string | null;
  /** The Follow up round this job belongs to (§5.5). Absent: the first judgement of the job opens one. */
  roundId?: string | null;
  /** In a conversation: the source id of the owner's current message, and how to turn the turn into a delegated request (§1.14). */
  ownerSourceId?: string | null;
  beginRequest?: (input: { label: string; quote: string; scope: string; authorizationId: string | null }) => string;
  /** Investigation results are kept with the job so the conversation can show them structured. */
  onInvestigationResult?: (result: unknown) => void;
  requestRelook?: (scope: { kind: 'project' | 'area' | 'thread'; id: string | null }, reason: string) => void;
  /** The step of a clerk-method round this job is (Spec §3.3); null for any other job. */
  readonly step?: KeeperJob['step'] | null;
  /** D99: the job's time so far, from its step timer (§3.10): `pk_stage` records each stage's share of it. */
  timingSnapshot?: () => StepTiming | null;
  /** D99: the runtime's way to run the main job's lanes (lane-tools.ts `pk_send_lanes`). */
  lanes?: LaneRunner;
  /** D99: what the planner does as the main agent enters a stage (stage-tools.ts `pk_stage`): recompute the breakpoint
   *  candidates, and the program's lists for that stage. */
  stageEntered?: (roundId: string, stage: ClerkStage) => Promise<{ readonly note: string | null }> | { readonly note: string | null };
}

const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const now = () => new Date().toISOString();

function ok(value: unknown) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  return { content: [{ type: 'text' as const, text: body.length > 120_000 ? `${body.slice(0, 120_000)}\n…(truncated)` : body }], details: {} };
}
function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }], details: {}, isError: true };
}

// ───────────────────────── create or update: an update gives only what it changes ─────────────────────────
//
// Every writer that creates or updates an item takes an update as a call naming an item that exists — its id, or the
// project's own number or key the writer matches on — and changes only what the call gives: what it leaves out keeps
// its value. The fields only a new item needs are optional in the schema, and the writer asks for them itself when the
// call creates (test-D-1: ten updates that gave only what they changed were refused for the title and progress the
// schema required, and the job ended).

/** Left out of the call. An update keeps its value; a new item needs what its writer names. */
export const absent = (v: unknown): boolean => v === undefined || v === null;
/** Given with a value: present and, for text, not blank (a writer's text fields left empty keep their value). */
export const has = (v: unknown): boolean => !absent(v) && !(typeof v === 'string' && v.trim() === '');
const listed = (items: readonly string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * The refusal of a call that would create an item but leaves out what a new one needs: why it creates one, exactly what
 * is missing, and how to update the one meant instead. Nothing is written. It is thrown (step-timing.ts `incompleteCall`),
 * so the timer and the refusal guard read it as the refusal of a call that never ran, as they read pi's refusal of the
 * same call when the schema still required those fields.
 */
export function createNeeds(item: string, why: string, missing: readonly string[], toUpdate: string): Error {
  return incompleteCall(`${why}, so this call would create ${item}, and a new one needs ${listed(missing)}, which the call leaves out. Nothing was written. ${toUpdate} An update gives only what it changes: what it leaves out keeps its value.`);
}

function keeperAttribution(ctx: ToolContext, identity: Attribution['identity'] = 'Interpretation'): Attribution {
  return { author: { kind: 'agent', name: 'Keeper', window: null, host: 'pi', model: ctx.model }, holder: null, identity };
}

function statements(ctx: ToolContext, raw: unknown, label: string): Statement[] | string {
  const out: Statement[] = [];
  for (const [i, s] of arr<Record<string, unknown>>(raw).entries()) {
    if (!isOneOf(STATEMENT_TYPE, s.type)) return `${label}[${i}].type must be one of ${STATEMENT_TYPE.join(', ')}`;
    const sourceIds = arr<string>(s.sourceIds).filter((id) => typeof id === 'string');
    const missing = sourceIds.filter((id) => !ctx.store.sources.has(id));
    if (missing.length) return `${label}[${i}] cites unknown source ids: ${missing.join(', ')}`;
    if (s.type === 'Observed' && sourceIds.length === 0) return `${label}[${i}] is Observed but cites no source`;
    // §1.15 Untrusted: what comes from a source the project marks untrusted stays a claim and never supports Observed.
    const untrusted = text(s.untrustedRuleId).trim();
    if (untrusted && s.type !== 'Claimed') {
      return `${label}[${i}] names an Untrusted rule but is ${s.type}: a statement from a source the project marks untrusted stays Claimed and never supports Observed. Write it as Claimed, with who claimed it and when.`;
    }
    if (untrusted) {
      const refusal = ruleUseRefusal(ctx.store, untrusted, 'Untrusted claim');
      if (refusal) return `${label}[${i}].untrustedRuleId must name an Untrusted rule in force: ${refusal}`;
    }
    // §2.4, D63: a claim says whose it is and when — which report, role or agent, on which day.
    let claimedBy: ClaimedBy | null = null;
    if (s.type === 'Claimed') {
      const who = text(s.claimedBy).trim();
      const when = text(s.claimedAt).trim();
      if (!who || !when) {
        return `${label}[${i}] is Claimed but does not say who claimed it and when (which report, role or agent, on which day; an agent’s report is its claim, never a fact). Add claimedBy — for example "Worker agent, batch 3 receipt" — and claimedAt — the date or time the material gives, for example 2026-09-17.`;
      }
      const at = normalizeMaterialTime(when);
      if (!at) return `${label}[${i}].claimedAt must be the date or time the claim was made, as the material gives it: a date (2026-09-17), which stays a date, or an ISO time. “${when}” is neither.`;
      claimedBy = { who, at, untrustedRuleId: untrusted || null };
    }
    out.push({ id: newId('st'), type: s.type, text: text(s.text), sourceIds, ...(claimedBy ? { claimedBy } : {}) });
  }
  return out;
}

const redact = (s: string): string => redactCredentials(s).text;
const PLAN_ID = 'organizing-plan';

/**
 * Why an object may not become `Removed`, or null (Spec §2.1, §2.6; D61; CKC-02 AC-5). `Removed` is for what was built
 * before its material was deleted from the project's current version, and the deletion is what shows it: a source
 * that is `No longer available`. A move changes no validity; a move into a place the project keeps for recovery is
 * judged by the project's rule for it (`byRuleId`, checked by the caller).
 */
function removedRefusal(store: ProjectStore, sourceIds: readonly string[], byRuleId: string): string | null {
  if (byRuleId) return null;
  const sources = [...new Set(sourceIds)].map((id) => store.sources.get(id)).filter((s): s is Source => s !== undefined);
  if (sources.some((s) => s.availability === 'No longer available')) return null;
  if (sources.length > 0 && sources.every((s) => s.availability === 'Moved')) {
    return `Its sources were moved, not deleted: a move does not change validity. The source shows Moved with its new place. When the project says the place it moved to is kept for recovery only, judge it by that rule (validityByRuleId, a Recovery only rule).`;
  }
  return `Removed is for an object whose material was deleted from the project’s current version, and none of the sources it rests on is No longer available${sources.length ? '' : ' — it rests on no source at all'}. While its material is still there, it is not removed; when you doubt it still applies, say so with Suspected stale.`;
}

/**
 * Why `Decided without owner` may not hang on this object, or null (Spec §1.9, §1.11; CKC-05 AC-15). It marks a rule or
 * decision in force that a role set in the owner's place: a product reference item or one of the project's rules,
 * `Current`, and not the owner's own.
 */
function decidedWithoutOwnerRefusal(store: ProjectStore, id: string): string | null {
  const ref = store.reference.get(id);
  const rule = store.rules.get(id);
  if (!ref && !rule) return `Decided without owner hangs on the rule or decision a role set in the owner’s place — a product reference item or one of the project’s rules; ${id} is neither.`;
  if (ref && (ref.attribution.identity === 'Decision' || ref.attribution.author.kind === 'owner' || ref.category === OWNER_WORDS)) {
    return `${id} (“${ref.name}”) is the owner’s own decision (the owner said or approved it), so it was not decided without the owner. The mark is for a rule a role set in the owner’s place.`;
  }
  if (rule?.ownerConfirmation) return `${id} (“${rule.summary}”) is a rule the owner confirmed (${rule.ownerConfirmation.sourceId}), so it is not decided without the owner.`;
  const validity = ref?.validity ?? rule!.validity;
  if (validity !== 'Current') {
    return `Decided without owner is for a rule that is in force now (it is Current and applies); ${id} is ${validity}. A rule that no longer applies needs no owner decision; one that was replaced may have a successor in force to check.`;
  }
  return null;
}

function inputsOf(ctx: ToolContext, raw: unknown, location: string): JobInputs {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    jobId: ctx.jobId, sourceIds: arr<string>(r.sourceIds), factRecordIds: arr<string>(r.factRecordIds), threadIds: arr<string>(r.threadIds),
    areaIds: arr<string>(r.areaIds), referenceIds: arr<string>(r.referenceIds), noteIds: arr<string>(r.noteIds), location,
  };
}

const StrArr = Type.Array(Type.String());
const StatementSchema = Type.Object({
  type: Type.String({ description: 'Observed | Claimed | Inferred | Open' }), text: Type.String(), sourceIds: Type.Array(Type.String(), { description: 'source ids this statement rests on' }),
  claimedBy: Type.Optional(Type.String({ description: 'Claimed only (required): whose claim it is — the report, role or agent, e.g. "Worker agent, batch 3 receipt"' })),
  claimedAt: Type.Optional(Type.String({ description: 'Claimed only (required): when it was claimed, as the material gives it — a date (2026-09-17) stays a date; an ISO time when the material gives the clock' })),
  untrustedRuleId: Type.Optional(Type.String({ description: 'Claimed only: the project’s Untrusted rule that covers this source, when one does' })),
});
const InputsSchema = Type.Optional(Type.Object({ sourceIds: Type.Optional(StrArr), factRecordIds: Type.Optional(StrArr), threadIds: Type.Optional(StrArr), areaIds: Type.Optional(StrArr), referenceIds: Type.Optional(StrArr), noteIds: Type.Optional(StrArr) }, { description: 'what this job actually received as input (for the record)' }));

/** Where a reference item hangs in the graph: the first Area, Goal or Product reached through `refines` (itself included). */
function placement(store: ProjectStore, id: string, depth = 0, seen = new Set<string>()): 'Area' | 'Goal' | 'Product' | null {
  const item = store.reference.get(id);
  if (!item || depth > 8 || seen.has(id)) return null;
  seen.add(id);
  if (item.category === 'Area' || item.category === 'Goal' || item.category === 'Product') return item.category;
  for (const up of item.refines) { const p = placement(store, up, depth + 1, seen); if (p) return p; }
  return null;
}
/** Soft feedback the Keeper sees in the tool result: an item that hangs from nothing shows up as Unplaced (§1.5, §6.3). */
function referenceWarning(store: ProjectStore, item: ReferenceItem): string | null {
  const hasAreas = store.reference.find((r) => r.category === 'Area' && r.validity === 'Current') !== undefined;
  const hasGoals = store.reference.find((r) => r.category === 'Goal' && r.validity === 'Current') !== undefined;
  const hasProduct = store.reference.find((r) => r.category === 'Product' && r.validity === 'Current') !== undefined;
  // The owner's words are the top layer (§1.3): the other layers refine them, and they refine nothing.
  if (item.category === 'Product' || item.category === OWNER_WORDS) return null;
  if (item.category === 'Goal') return hasProduct && !item.refines.some((r) => store.reference.get(r)?.category === 'Product') ? 'This Goal does not refine the Product item; add refines: [the Product id].' : null;
  if (item.category === 'Area') return hasGoals && !item.refines.some((r) => store.reference.get(r)?.category === 'Goal') ? 'This Area refines no Goal; add refines: [the Goal ids whose effect this area delivers].' : null;
  if (placement(store, item.id)) return null;
  if (item.wholeProductWhy?.trim()) return null;
  if (!hasAreas && !hasGoals && !hasProduct) return null;
  return `Not placed: this ${item.category} refines nothing that leads to an Area, Goal or Product, so it shows as Unplaced. Add refines: the Area(s) it belongs to (documents usually name their Module or feature), or the Product together with wholeProductWhy when it covers the whole product (on the Product with no reason it still counts as not placed). Refining only another document does not place it unless that document is placed.`;
}

/**
 * Soft feedback for a relation whose endpoints are not the ones the vocabulary defines (round 1, 2026-09-17: a QC
 * report was recorded as one work item verifying another, and work items served a contract without serving an area).
 * The relation is still written: the material may be unusual. The Keeper sees what the definition expects.
 */
function relationWarning(store: ProjectStore, type: string, fromId: string, toId: string): string | null {
  const catOf = (id: string): string =>
    store.reference.get(id)?.category ?? (store.threads.has(id) ? 'Work item' : store.sources.has(id) ? 'source' : store.facts.has(id) ? 'fact record' : store.changes.has(id) ? 'Change' : store.areas.has(id) ? 'area understanding' : 'other');
  const from = catOf(fromId), to = catOf(toId);
  if (type === 'verifies' && !['source', 'Test', 'Review'].includes(from)) {
    return `verifies runs from a Test or a Review (or the source id of the report or test itself) to what it checks; this one starts at a ${from}. When a piece of work checked another, write the check as a Review or Test item and relate that.`;
  }
  if (from === 'Work item' && to === 'Work item' && ['implements', 'serves'].includes(type)) {
    return `A work item that carries out another work item is an execution batch, and an execution batch is not a work item of its own: write it with pk_write_thread carriesOut, which records what it did as the progress of the work items it carries out, and keep the batch’s plan as a Plan reference item.`;
  }
  if (type === 'implements' && !['source', 'Result'].includes(from)) {
    return `implements runs from a Result (or the source id of the code) to the Work item or Requirement it realises; this one starts at a ${from}.`;
  }
  if (type === 'carries out' && from !== 'Work item') {
    return `carries out runs from the piece of work that carries a decision out (a Work item) to the decision; this one starts at a ${from}. pk_record_carry_out records the carry-out together with these relations.`;
  }
  if (type === 'serves' && from === 'Work item' && !['Area', 'Goal'].includes(to)) {
    const placed = store.relations.find((r) => r.type === 'serves' && r.from === fromId && ['Area', 'Goal'].includes(catOf(r.to))) !== undefined;
    if (!placed) return `A work item serves first the Area (or Goal) whose effect it delivers — that is what places it in the List and the graph — and then the ${to} it fulfils. This work item serves no Area yet; add that relation too.`;
  }
  return null;
}

/**
 * Which assets a change touches, worked out from the material it was read in (Product architect, 2026-09-17, after
 * D43): the code knows which sources the change cites and which items were formed from those sources, so it fills
 * `affects` when the model left it empty. 34 of this project's 129 change records had none, and a change that names
 * nothing can neither be followed up nor put a star on anything.
 */
export function affectsFromSources(store: ProjectStore, sourceIds: readonly string[]): string[] {
  const formed = formedFrom(store, sourceIds);
  return [...new Set([...formed.referenceIds, ...formed.threadIds])];
}

/**
 * The piece of work a change record covers (§1.8, D56), read from the call, or the reason it cannot be read, or
 * null when the caller named none (a record written before pieces of work were recorded).
 */
function workSegmentOf(p: Record<string, unknown>): WorkSegment | string | null {
  const kind = text(p.workKind);
  const label = text(p.workLabel);
  const sessionId = text(p.workSessionId);
  if (!kind && !label && !sessionId) return null;
  if (!isOneOf(WORK_SEGMENT_KIND, kind)) return `workKind must be one of ${WORK_SEGMENT_KIND.join(', ')}: a piece of work is one session, one execution, or — when the changes have no session — the stretch of time they were grouped into`;
  // §1.8: the precision the material gives is kept — a stretch of history the material dates by day stays a date.
  const startedAt = normalizeMaterialTime(text(p.workStartedAt));
  const endedAt = normalizeMaterialTime(text(p.workEndedAt));
  if (!startedAt) return 'workStartedAt must be the time this piece of work began: an ISO time, or the date when the material gives only the day';
  if (!endedAt) return 'workEndedAt must be the time this piece of work ended, or its last pause when it was still running: an ISO time, or the date when the material gives only the day';
  if (kind === 'Session' && !sessionId && !label) return 'a Session piece of work names its session: give workSessionId, or workLabel when only the host and time are known';
  return {
    kind, label: label || sessionId || `${kind} ${startedAt}`, sessionId: sessionId || null,
    startedAt, endedAt,
    openEnded: p.workOpenEnded === true,
  };
}

/**
 * Why this mount may not be written on a new note, or null (owner 2026-09-22: four notes were written with the
 * project id inside a project mount's ids, and the panel showed a dead "On <id>" link). `project` hangs on the
 * whole project and takes no ids; the other kinds take ids of what is in the assets — the same lookup the panel
 * uses to name a mount (`mountView` in server/graph-view.ts).
 */
export function noteMountRefusal(store: ProjectStore, kind: string, ids: readonly string[]): string | null {
  if (kind === 'project') {
    return ids.length === 0 ? null : `A note on the whole project (mountKind project) hangs on the project itself and takes no mount ids — these do not belong here: ${ids.join(', ')}. Leave mountIds empty; to hang the note on an object, use mountKind node or relation with that object's id.`;
  }
  if (kind === 'relation') {
    const missing = ids.filter((id) => !store.relations.has(id));
    return missing.length === 0 ? null : `mountKind relation takes relation ids; these are not relations in the assets: ${missing.join(', ')}. Name each mounted relation by its relation id.`;
  }
  const missing = ids.filter((id) => !store.nodes.has(id) && !store.reference.has(id) && !store.threads.has(id));
  if (missing.length === 0) return null;
  // A code territory is not on the graph, so a note hung on it alone would hang on nothing the workbench can show.
  const territories = missing.filter((id) => store.territories.has(id));
  if (territories.length) {
    return `mountKind ${kind} takes graph objects (graph nodes, reference items, work items), and ${territories.join(', ')} ${territories.length === 1 ? 'is a code territory' : 'are code territories'}, which the graph does not draw. Hang the note on the area the territory serves (or the work that built it), and name the anomaly it is about in codeAnomalies: the anomaly in Code opens the note.${missing.length > territories.length ? ` These name nothing in the assets: ${missing.filter((id) => !territories.includes(id)).join(', ')}.` : ''}`;
  }
  return `mountKind ${kind} takes the ids of objects in the assets (graph nodes, reference items, work items); these name nothing in the assets: ${missing.join(', ')}.`;
}

/**
 * The code-territory anomalies a note names (`codeAnomalies` of pk_write_note), resolved to the territory and the index of
 * each, or why one cannot be: an unknown territory, or an index the territory does not have. A territory with a single
 * anomaly may be named without the index.
 */
export function noteAnomalyTargets(store: ProjectStore, given: readonly Record<string, unknown>[]): { territoryId: string; index: number }[] | string {
  const out: { territoryId: string; index: number }[] = [];
  for (const [i, a] of given.entries()) {
    const territoryId = text(a.territoryId).trim();
    const t = store.territories.get(territoryId);
    if (!t) return `codeAnomalies[${i}].territoryId: ${territoryId || '(empty)'} is not a code territory of the assets.`;
    if (t.anomalies.length === 0) return `codeAnomalies[${i}]: ${t.name} has no anomaly for the note to be about.`;
    const index = typeof a.index === 'number' ? a.index : t.anomalies.length === 1 ? 0 : NaN;
    if (!Number.isInteger(index) || index < 0 || index >= t.anomalies.length) return `codeAnomalies[${i}].index: which of ${t.name}’s ${t.anomalies.length} anomalies the note is about, counted from 0.`;
    if (!out.some((o) => o.territoryId === territoryId && o.index === index)) out.push({ territoryId, index });
  }
  return out;
}

/**
 * Why this note may not be written, or null (Spec §5.5, §4.1; CKC-11 AC-17, CKC-08 AC-21). A round writes notes
 * for exactly two things — something the owner must decide, one question per note, and a situation worth the
 * owner's knowing, one matter per note — and never one note per object that is behind: the object's own state
 * already says what it has not followed, and 5 mount points on the 2026-09-18 assets carried the same note twice.
 */
export function noteRefusalFor(store: ProjectStore, n: {
  id: string; mountIds: readonly string[]; changeIds: readonly string[]; ask: string;
  title: string; preview: string; whyItMatters: string; whatWouldSettleIt: string;
}): string | null {
  const duplicate = duplicateNote(store, n.mountIds, n.changeIds, n.title, n.id);
  if (duplicate) {
    const v = duplicate.versions[duplicate.versions.length - 1];
    return `There is already a current note on this mount about the same matter: ${duplicate.id} — “${v?.title ?? ''}”. Update that one (pk_write_note with id: "${duplicate.id}" and a reason) instead of writing a second.`;
  }
  // The title and the first sentence (the preview) say the same thing (§4.2): a question in both is one question.
  const asked = (t: string) => t.split('?').length - 1;
  const questions = (asked(n.preview) || asked(n.title)) + asked(n.whatWouldSettleIt);
  if (n.ask === 'For your decision' && questions > 1) {
    return `One question per note: this one asks ${questions}. Write the one question the owner has to decide here, and a separate note for each of the others.`;
  }
  // A note that only repeats a propagation state makes a reminder and adds nothing the state does not already say.
  const latest = new Map<string, ObjectJudgement>();
  for (const j of store.propagation.all()) {
    const before = latest.get(j.nodeId);
    if (!before || roundNumberOf(j.roundId) > roundNumberOf(before.roundId)) latest.set(j.nodeId, j);
  }
  const behind = n.mountIds.some((id) => latest.get(id)?.state === 'Still on old understanding');
  if (behind && n.ask !== 'For your decision' && !n.whyItMatters.trim() && !n.whatWouldSettleIt.trim()) {
    return `That object's judgement already records what it has not followed, so a note only repeats it and makes a reminder (no note per object that is behind). Write a note here only for something the owner must decide (ask "For your decision", one question), or for a situation worth the owner's knowing — then say in whyItMatters what makes it worth knowing. What needs no owner decision goes to the holder as a modification request (pk_write_modification_request).`;
  }
  return null;
}

const IDENT_RE = /\b([A-Z]{1,6}(?:-[A-Z]{1,4})?-?\d{1,4}(?:\.\d{1,3})*)\b/;
/**
 * An id that is a whole project number (CJ: aligned with numbering.ts, whose index tables and prompt ids number work with two
 * capitals — `AS`, `AY`): letters and digits, a prefix and digits, or two capital letters. Two capitals count only as an
 * id given whole; in a name they are too often a word (`UI polish`), so a name still needs digits.
 */
const WHOLE_ID_RE = /^([A-Z]{1,6}(?:-[A-Z]{1,4})?-?\d{1,4}(?:\.\d{1,3})*|[A-Z]{2})$/;
/**
 * CZ: an id written like one of the project's numbers (`E14`, `CKC-09`, `AP`; `V3` too — a side log's own numbering). A
 * writer given such an id that is no record's own id looks it up as a number: it is never stored as a record id.
 */
export const isWrittenNumber = (s: string): boolean => WHOLE_ID_RE.test(s.trim().toUpperCase());
/** The identifier a reference item answers to: its first id, else the identifier its name starts with (D36, CKC-13, CK-M2, PA-10, R-07; AS, AY as ids). */
export function primaryIdentifier(ids: readonly string[], name: string): string | null {
  // A version (v2.1) names a version of several documents, never one item.
  const isVersion = (t: string) => /^V\d/.test(t);
  for (const i of ids) {
    const whole = WHOLE_ID_RE.exec(i.trim().toUpperCase());
    if (whole && !isVersion(whole[1]!)) return whole[1]!;
    const m = IDENT_RE.exec(i.toUpperCase());
    if (m && !isVersion(m[1]!)) return m[1]!;
  }
  const head = name.slice(0, 24).toUpperCase();
  const m = IDENT_RE.exec(head);
  return m && !isVersion(m[1]!) && head.indexOf(m[1]!) <= 3 ? m[1]! : null;
}

/**
 * The reference item a written id names (CQ, D104): its store id; else the one live item whose ids carry it (a Plan's `K`
 * or `P1`, an Area's `CK-M2`) or whose name opens with it; else the one Plan or Area whose name's leading token is it. So
 * every writer that places by `serves` or `refines` finds a Plan by the id its document gives it, as `pk_place_range` does.
 */
/**
 * The id a plan document gives a Plan when it is no number the numbering families know (CQ, D104): the leading token of
 * its heading, before the first separator — a letter or a word, with a trailing number at most (`K`, `M1`, `Sprint 3`) —
 * when a separator follows it (a plan named by one word alone keeps its name as its name). Null otherwise.
 */
export function planIdOf(name: string): string | null {
  const squashed = name.replace(/\s+/g, ' ').trim();
  const lead = (squashed.split(NAME_SEP)[0] ?? '').trim();
  if (!lead || lead === squashed || lead.length > 16) return null;
  return /^[\p{L}\p{N}][\p{L}\p{N}.-]{0,11}(?:\s?\p{N}{1,3})?$/u.test(lead) && !/^\d+$/.test(lead) ? lead : null;
}

export function referenceByWrittenId(store: ProjectStore, value: string): ReferenceItem | null {
  const v = value.trim();
  if (!v) return null;
  const direct = store.reference.get(v);
  if (direct) return direct;
  const up = v.toUpperCase();
  const live = store.reference.filter((r) => r.validity !== 'Replaced' && r.validity !== 'Removed');
  const byIds = live.filter((r) => r.ids.some((i) => i.trim().toUpperCase() === up) || primaryIdentifier(r.ids, r.name) === up);
  if (byIds.length === 1) return byIds[0]!;
  if (byIds.length > 1) { const places = byIds.filter((r) => r.category === 'Plan' || r.category === 'Area'); return places.length === 1 ? places[0]! : null; }
  const lead = live.filter((r) => (r.category === 'Plan' || r.category === 'Area') && (r.name.split(NAME_SEP)[0] ?? '').trim().toUpperCase() === up);
  return lead.length === 1 ? lead[0]! : null;
}

/**
 * When a decision was itself made, as the assets record it, and which field says so — or null when nothing dates
 * it. §2.1 files a decision read out of history under the time its own material gives, and §1.8 keeps that time on
 * the change item, so the item that recorded the decision is the field that dates the decision. The session its
 * material comes from is the next best. `asOf` is deliberately not used: it is when the Keeper wrote the item
 * down, so on a takeover every decision of a decision record carries the same afternoon and ordering by it would
 * be ordering by the Keeper's reading order, not by the project's timeline.
 */
export function decisionTime(store: ProjectStore, item: ReferenceItem): { at: string; field: string } | null {
  const dated: { at: string; field: string }[] = [];
  for (const change of store.changes.all()) {
    for (const i of itemsOf(change)) {
      if (i.atSource !== 'material' || !i.affects.includes(item.id) || Number.isNaN(Date.parse(i.at))) continue;
      dated.push({ at: i.at, field: `the change item that recorded it (${change.id}, at ${i.at})` });
    }
  }
  for (const id of item.sourceIds) {
    const anchor = store.sources.get(id)?.anchor;
    if (anchor?.kind !== 'session' || !anchor.at || Number.isNaN(Date.parse(anchor.at))) continue;
    dated.push({ at: anchor.at, field: `the session its material comes from (${id}, at ${anchor.at})` });
  }
  // The earliest is when the decision appeared; a later item on the same decision is a change to it, not its date.
  return dated.sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
}

/**
 * Why this decision is not one the replacement check may write over: §5.5 checks a new decision against the
 * decisions in force, and each other validity needs something else done first (§2.1).
 */
export function notCurrentRefusal(old: ReferenceItem): string {
  const advice = old.validity === 'Proposed'
    ? 'A proposal was never in force, so nothing was written, done or verified to it and nothing can supersede it. If it was adopted, record that first (the basis is the owner’s approval or the project’s own record of adoption) and check again; if it was not, leave it out of this check.'
    : old.validity === 'Replaced'
      ? `It is already Replaced${old.replacedBy ? `, by ${old.replacedBy}` : ''} and so a point-in-time record. Run the check against whichever decision is in force on this matter now; if it was replaced wrongly, the owner corrects that first.`
      : old.validity === 'Abandoned'
        ? 'That direction was abandoned, so there is nothing of it left in force to supersede. Run the check against whichever decision is in force on this matter now.'
        : `Only a Current decision is in force, and this one is ${old.validity}. Judge its validity first, then check what supersedes it.`;
  return `${old.id} (${old.name}) is ${old.validity}, and the replacement check goes over the decisions in force. ${advice}`;
}

/** The time one item of a change record carries, or the record's own when the caller named no item (§1.8). */
export function itemTime(change: ChangeRecord, itemId: string): string {
  return (itemId ? itemsOf(change).find((i) => i.id === itemId)?.at : undefined) ?? change.at;
}
/** The last thing a change record did: what makes it "a later change" for anything before it. */
export function lastItemTime(change: ChangeRecord): string {
  return itemsOf(change).reduce((latest, i) => (i.at > latest ? i.at : latest), change.at);
}

/** How many compact rows, and how many whole records, one pk_read_assets listing gives (CM: no listing hits the 120K cap). */
export const READ_PAGE = 200;
export const READ_FULL_PAGE = 40;
const clipped = (s: unknown, n: number): string => { const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''; return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * One asset as a compact row (CM, E151; CK fix 5): its id, its name, its category, what it refines or serves, its
 * validity — what the main agent needs to find and place an item; the full record comes with ids, or with full: true.
 * The gated run's asset dumps took 71K and 106K characters of the main agent's context, and 22 results were cut at the
 * 120K-character cap.
 */
export function compactRow(kind: string, x: Record<string, unknown>): Record<string, unknown> {
  const pick = (keys: readonly string[]) => Object.fromEntries(keys.filter((k) => x[k] !== undefined && x[k] !== null && !(Array.isArray(x[k]) && (x[k] as unknown[]).length === 0)).map((k) => [k, x[k]]));
  const ref = (r: Record<string, unknown>) => ({ ...pick(['id', 'category']), name: clipped(r.name, 120), ...pick(['ids', 'validity', 'refines', 'replacedBy', 'foundation']), ...(r.wholeProductWhy ? { wholeProductWhy: clipped(r.wholeProductWhy, 120) } : {}) });
  switch (kind) {
    case 'reference': return ref(x);
    case 'area': { const u = x.understanding as Record<string, unknown> | null; return { ...ref(x), ...(u ? { understanding: u.id, effectNow: clipped(u.effectNow, 160) } : {}) }; }
    case 'thread': return { id: x.id, title: clipped(x.title, 120), ...pick(['ids', 'progress', 'validity', 'replacedBy']), serves: ((x.serves ?? []) as { referenceId: string }[]).map((s) => s.referenceId), ...(x.wholePlanWhy ? { wholePlanWhy: clipped(x.wholePlanWhy, 120) } : {}) };
    case 'areaUnderstanding': return { id: x.id, referenceId: x.referenceId, effectNow: clipped(x.effectNow, 160) };
    case 'relation': return pick(['id', 'type', 'from', 'to', 'basis']);
    case 'link': return { ...pick(['id', 'workId', 'stepKind', 'confirmed']), evidence: clipped((x.evidence as { label?: string } | null)?.label ?? x.ledgerRef, 100), ...(x.check ? { check: (x.check as { passed: boolean }).passed ? 'passed' : 'failed' } : {}) };
    case 'roundDoc': return { ...pick(['id', 'roundId', 'kind', 'path']), title: clipped(x.title, 120), chars: typeof x.markdown === 'string' ? x.markdown.length : 0 };
    case 'note': { const v = ((x.versions ?? []) as { title?: string; ask?: string }[]).at(-1); return { ...pick(['id', 'status']), title: clipped(v?.title, 120), ask: v?.ask ?? null }; }
    case 'breakpoint': return { ...pick(['id', 'kind', 'targetId', 'basis', 'lit']), why: clipped(x.why, 120), ...(x.out ? { out: true } : {}), ...(x.looked ? { looked: true } : {}) };
    case 'draft': return { id: x.id, session: x.session ? `${(x.session as { host?: string }).host} ${String((x.session as { sessionId?: string }).sessionId ?? '').slice(0, 8)}` : null, ownerLines: ((x.ownerLines ?? []) as unknown[]).length };
    case 'clerkRound': return pick(['id', 'kind', 'number', 'status', 'stage', 'startedAt', 'endedAt']);
    case 'generation': return { ...pick(['id', 'name']), workIds: ((x.workIds ?? []) as unknown[]).length, planRefs: ((x.planRefs ?? []) as unknown[]).length };
    default: {
      const name = x.name ?? x.title ?? x.label ?? x.summary ?? x.number ?? x.path ?? x.kind;
      return { id: x.id, ...(name !== undefined ? { name: clipped(name, 120) } : {}), ...pick(['category', 'kind', 'status', 'validity']) };
    }
  }
}

export function keeperTools(ctx: ToolContext): ToolDefinition[] {
  const { store, project } = ctx;
  const trace = (summary: string, basisSourceIds: readonly string[] = []) => ({ jobId: ctx.jobId, basisSourceIds, summary });
  const saved = (collection: string, id: string, label: string) => ctx.onSaved?.(collection, id, label);
  const writtenFacts = new Set<string>();

  const tools: ToolDefinition[] = [
    defineTool({
      name: 'pk_project_overview', label: 'Project overview',
      description: 'Where this project stands in the assets, compact: scope, the counts of each kind of asset, the Product, Goals, Areas and Plans by id and name, the rules in force in one line each, the current notes by title, the organizing plan counted, and coverage. Use it to position yourself before reading material; read any kind in full with pk_read_assets.',
      parameters: Type.Object({}),
      execute: async () => {
        const cur = <T extends { validity?: string }>(xs: readonly T[]) => xs.filter((x) => x.validity === undefined || x.validity === 'Current');
        const byCategory: Record<string, number> = {};
        for (const r of cur(store.reference.all())) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
        const byProgress: Record<string, number> = {};
        for (const t of cur(store.threads.all())) byProgress[t.progress] = (byProgress[t.progress] ?? 0) + 1;
        const named = (cat: string) => cur(store.reference.filter((r) => r.category === cat)).map((r) => ({ id: r.id, name: clipped(r.name, 120), ...(r.foundation ? { foundation: true } : {}) }));
        const plan = store.plans.get(PLAN_ID);
        return ok({
          project: { id: project.id, name: project.name, root: project.locations[0], language: project.language, roles: project.roles },
          scope: project.scope.map((i) => ({ id: i.id, category: i.category, relation: i.relation, path: i.path })),
          counts: { reference: byCategory, workItems: byProgress, relations: store.relations.size, notes: store.notes.filter((n) => n.status === 'Current').length, sources: store.sources.size },
          product: named('Product'), goals: named('Goal'), areas: named('Area'), plans: named('Plan'),
          rules: store.rules.filter((r) => r.validity === 'Current').map((r) => ({ id: r.id, group: r.group, summary: clipped(r.summary, 140) })),
          notes: store.notes.filter((n) => n.status === 'Current').map((n) => { const v = n.versions[n.versions.length - 1]!; return { id: n.id, title: clipped(v.title, 140), ask: v.ask }; }),
          organizingPlan: plan ? { id: PLAN_ID, byRule: plan.byRule.length, readClosely: plan.readClosely.length, focus: plan.focus.length, corrections: plan.corrections.length } : null,
          coverage: store.coverage.scopes.map((x) => ({ id: x.id, coverage: x.coverage, pending: x.pending.length, asOf: x.asOf })),
          more: 'pk_read_assets kind reference (category …), thread, area, relation … lists any kind compact; with ids, or full: true, in full.',
        });
      },
    }),
    defineTool({
      name: 'pk_list_sources', label: 'List sources',
      description: 'List sources (files by section, session segments, commits) with their ids. Filter by query text, path substring, session host, kind, or Used as. Returns compact rows, no excerpts.',
      parameters: Type.Object({ query: Type.Optional(Type.String()), path: Type.Optional(Type.String()), kind: Type.Optional(Type.String({ description: 'file | session | commit | status | revision (an old version read from version history)' })), host: Type.Optional(Type.String({ description: 'claude | codex' })), usedAs: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
      execute: async (_id, p) => {
        // Paths are compared with one separator: a file's stored path has the platform's (backslashes on Windows), and a
        // step asks with the repo-relative form it reads everywhere else (`product/PRD.md`).
        const slashed = (v: string) => v.replace(/\\/g, '/').toLowerCase();
        const q = slashed(text(p.query));
        const at = p.path ? slashed(text(p.path)) : '';
        const rows = store.sources.all().filter((s) => (!p.kind || s.anchor.kind === p.kind) && (!at || (s.anchor.kind === 'file' && slashed(s.anchor.path).includes(at))) && (!p.host || (s.anchor.kind === 'session' && s.anchor.host === p.host)) && (!p.usedAs || s.usedAs === p.usedAs) && (!q || s.title.toLowerCase().includes(q) || slashed(anchorLabel(s.anchor)).includes(q) || s.excerpt.toLowerCase().includes(q)))
          .sort((a, b) => anchorLabel(a.anchor).localeCompare(anchorLabel(b.anchor)))
          .slice(0, Math.min(400, Number(p.limit) || 200))
          .map((s) => { const origin = worktreeOrigin(project.scope, s); return { id: s.id, title: s.title, at: anchorLabel(s.anchor), usedAs: s.usedAs ?? 'Not yet judged', ids: s.ids, chars: s.excerpt.length, availability: s.availability, ...(origin ? { inProgress: origin.label } : {}) }; });
        return ok(rows);
      },
    }),
    defineTool({
      name: 'pk_read_source', label: 'Read source',
      description: 'Read one source: its anchor, version and exact excerpt as read.',
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, p) => { const s = store.sources.get(p.id); const origin = s ? worktreeOrigin(project.scope, s) : null; return s ? ok({ id: s.id, title: s.title, at: anchorLabel(s.anchor), anchor: s.anchor, version: s.version, usedAs: s.usedAs, availability: s.availability, ids: s.ids, ...(origin ? { inProgress: origin } : {}), excerpt: s.excerpt }) : fail(`unknown source ${p.id}`); },
    }),
    defineTool({
      name: 'pk_read_assets', label: 'Read assets',
      description: `Read existing assets by kind (fact, thread, area, areaUnderstanding, reference, note, relation, node, change, mark, rule, plan, merge; and the positions of the clerk method: breakpoint, sendback, patch, number, draft, territory, generation, layer, roundDoc, link, clerkRound). With ids: those, in full. Without ids: every one of the kind as compact rows (id, name, category, what it refines or serves, validity), ${READ_PAGE} at a time (offset pages; next says where the following page starts) — full: true gives them in full instead, ${READ_FULL_PAGE} at a time. category narrows reference (and area) to one category. kind area is the product's Areas (the Area reference items) each with its understanding; areaUnderstanding is the understanding records alone. The id of a work item merged into another reads the one kept. To find which assets cite or touch an id, use pk_find_references.`,
      parameters: Type.Object({
        kind: Type.String(), ids: Type.Optional(StrArr),
        full: Type.Optional(Type.Boolean({ description: 'without ids: the whole records instead of compact rows' })),
        category: Type.Optional(Type.String({ description: 'kind reference: only this category (Decision, Requirement, Area …)' })),
        offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()),
      }),
      execute: async (_id, p) => {
        const kinds = {
          fact: store.facts, thread: store.threads, areaUnderstanding: store.areas, reference: store.reference, note: store.notes, relation: store.relations, node: store.nodes, change: store.changes, mark: store.marks, rule: store.rules, plan: store.plans, merge: store.merges,
          breakpoint: store.breakpoints, sendback: store.sendbacks, patch: store.patches, number: store.numbers, draft: store.drafts, territory: store.territories, generation: store.generations, layer: store.layers, roundDoc: store.roundDocs, link: store.links, clerkRound: store.clerkRounds,
        } as Record<string, { all(): unknown[]; get(id: string): unknown }>;
        const kind = text(p.kind);
        // CM (C13): `area` was the area understanding and read as an empty list when an ADR lane looked for the Areas; it
        // is the Areas themselves now, each with its understanding.
        const areaRows = () => store.reference.filter((r) => r.category === 'Area').map((r) => {
          const u = store.areas.find((x) => x.referenceId === r.id);
          return { ...r, understanding: u ? { id: u.id, effectNow: u.effectNow, gaps: u.gaps, contributions: u.contributions.length } : null };
        });
        const coll = kind === 'area' ? { all: areaRows, get: (id: string) => areaRows().find((r) => r.id === id) } : kinds[kind];
        if (!coll) return fail(`kind must be area | areaUnderstanding | ${Object.keys(kinds).filter((k) => k !== 'areaUnderstanding').join(' | ')}`);
        const ids = arr<string>(p.ids);
        // §1.4 (CKC-06 AC-28): a merged work item's id reaches the one kept, and says it did.
        const read = (id: string) => {
          const hit = coll.get(id);
          if (hit) return hit;
          const kept = kind === 'thread' || kind === 'node' ? resolveMergedId(store, id) : id;
          const found = kept !== id ? coll.get(kept) : undefined;
          return found ? { ...(found as object), mergedFrom: id } : { id, missing: true };
        };
        if (ids.length) return ok(ids.map(read));
        const category = text(p.category).trim();
        let all = coll.all() as Record<string, unknown>[];
        if (category) all = all.filter((x) => x.category === category);
        const full = p.full === true;
        const page = full ? READ_FULL_PAGE : READ_PAGE;
        const offset = Math.max(0, Math.trunc(Number(p.offset) || 0));
        const limit = Math.max(1, Math.min(page * 4, Math.trunc(Number(p.limit) || page)));
        const rows = all.slice(offset, offset + limit).map((x) => (full ? x : compactRow(kind, x)));
        const more = offset + rows.length < all.length;
        return ok({ kind, ...(category ? { category } : {}), count: all.length, offset, rows, ...(more ? { next: offset + rows.length } : {}) });
      },
    }),
    defineTool({
      name: 'pk_set_used_as', label: 'Set Used as',
      description: `Record how a source is used (${USED_AS.join(', ')}). Reference only: material the project says is for reference only, and the documents third-party material brings — citable, never a requirement, boundary or plan. History only: old versions and deleted files from version history, and what the project keeps for recovery only — it forms no current node and enters no context. When a project rule settles it, name the rule in byRuleId.`,
      parameters: Type.Object({ sourceId: Type.String(), usedAs: Type.String(), byRuleId: Type.Optional(Type.String({ description: 'the project rule this follows, when one does: a Reference only rule for Reference only, a Recovery only rule for History only' })) }),
      execute: async (_id, p) => {
        const s = store.sources.get(p.sourceId);
        if (!s) return fail(`unknown source ${p.sourceId}`);
        if (!isOneOf(USED_AS, p.usedAs)) return fail(`usedAs must be one of ${USED_AS.join(', ')}`);
        const fromHistory = usedAsHistoryRefusal(s, p.usedAs);
        if (fromHistory) return fail(fromHistory);
        const byRuleId = text(p.byRuleId).trim();
        if (byRuleId) {
          const refusal = ruleUseRefusal(store, byRuleId, p.usedAs === 'Reference only' ? 'Reference only' : p.usedAs === 'History only' ? 'History only' : 'Used as');
          if (refusal) return fail(refusal);
        }
        // A judgement of this one source: no longer the location's (§1.1), so a change of classification leaves it be.
        store.sources.put({ ...s, usedAs: p.usedAs, usedAsBy: 'keeper', usedAsByRuleId: byRuleId || null, usedAsByScopeItemId: null }, trace(`Used as ${p.usedAs}${byRuleId ? ` by rule ${byRuleId}` : ''}`, [s.id, ...(byRuleId ? store.rules.get(byRuleId)!.sourceIds : [])]));
        return ok({ id: s.id, usedAs: p.usedAs, ...(byRuleId ? { byRuleId } : {}) });
      },
    }),
    defineTool({
      name: 'pk_write_fact_record', label: 'Write fact record',
      description: 'Create or update a fact record formed from ONE material or session segment (plus project positioning). Statements carry a type and source ids; decisions carry who made them; open questions stay open. Pass id to update, or write again about the same material: an update gives only what it changes, and what it leaves out keeps its value (a list you give — statements, executionFacts, decisions, changes, openQuestions — replaces that list). A new fact record needs title, aboutSourceIds and statements.',
      parameters: Type.Object({
        id: Type.Optional(Type.String()),
        title: Type.Optional(Type.String({ description: 'a new fact record needs it; an update keeps it when left out' })),
        aboutSourceIds: Type.Optional(Type.Array(Type.String(), { description: 'the material it is about; a new fact record needs it, and it finds the record already written about that material' })),
        statements: Type.Optional(Type.Array(StatementSchema, { description: 'a new fact record needs them (an empty list when there are none); an update keeps them when left out' })), executionFacts: Type.Optional(Type.Array(StatementSchema)),
        decisions: Type.Optional(Type.Array(Type.Object({ text: Type.String(), byOwner: Type.Boolean({ description: 'true when the owner said or approved it' }), byName: Type.Optional(Type.String({ description: 'role or agent name when not the owner' })), sourceIds: StrArr, documented: Type.Boolean({ description: 'is it written in the project’s own decision record?' }) }))),
        changes: Type.Optional(Type.Array(Type.Object({ text: Type.String(), sourceIds: StrArr }))),
        openQuestions: Type.Optional(StrArr), usedAs: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'sourceId → Used as' })),
        language: Type.Optional(Type.String()), inputs: InputsSchema,
      }),
      execute: async (_id, p) => {
        const aboutGiven = !absent(p.aboutSourceIds);
        let about = arr<string>(p.aboutSourceIds).filter((id) => store.sources.has(id));
        if (aboutGiven && about.length === 0) return fail('aboutSourceIds must name at least one existing source');
        const st = absent(p.statements) ? null : statements(ctx, p.statements, 'statements'); if (typeof st === 'string') return fail(st);
        const ex = absent(p.executionFacts) ? null : statements(ctx, p.executionFacts, 'executionFacts'); if (typeof ex === 'string') return fail(ex);
        const title = text(p.title);
        let id = text(p.id);
        if (!id && ctx.materials?.length && about.length) {
          const hit = ctx.materials.filter((m) => m.sourceIds.some((s) => about.includes(s)));
          if (hit.length === 1) {
            const m = hit[0]!;
            about = [...new Set([...about, ...m.sourceIds])];
            id = stableId('fact', project.id, m.key);
            // A second record this job writes about the same material, under another title, is a record of its own.
            if (title && writtenFacts.has(id) && store.facts.get(id)?.title !== title) id = stableId('fact', project.id, m.key, title);
          } else if (hit.length > 1) {
            id = stableId('fact', project.id, ...hit.map((m) => m.key).sort());
          }
        }
        if (!id && about.length) id = stableId('fact', ...about);
        const previous = id ? store.facts.get(id) : undefined;
        if (!previous) {
          const missing = [...(absent(p.title) ? ['title'] : []), ...(aboutGiven ? [] : ['aboutSourceIds']), ...(st ? [] : ['statements'])];
          if (missing.length) throw createNeeds('a fact record', id ? `${id} is no fact record of the assets` : 'This call names no fact record (no id, and no aboutSourceIds to find one by)', missing, 'To update a fact record, give its id, or the aboutSourceIds of the material it is about.');
        }
        if (!aboutGiven) about = [...previous!.aboutSourceIds];
        writtenFacts.add(id);
        // A claim's check against the code (pk_record_code_check) stays beside the claim when the record is written
        // again with the same claim; a claim no longer there takes its check with it (Spec §2.4). Statements left out
        // keep every statement, check included.
        const squashed = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        const checks = st ? (previous?.statements ?? []).flatMap((c) => {
          const claimed = c.check ? previous!.statements.find((x) => x.id === c.check!.of) : undefined;
          const kept = claimed ? st.find((x) => x.type === 'Claimed' && squashed(x.text) === squashed(claimed.text)) : undefined;
          return kept && c.check ? [{ ...c, check: { ...c.check, of: kept.id } }] : [];
        }) : [];
        const record: FactRecord = {
          id, projectId: project.id, title: title || previous?.title || '', aboutSourceIds: about, statements: st ? [...st, ...checks] : [...previous!.statements],
          decisions: absent(p.decisions) ? [...(previous?.decisions ?? [])] : arr<Record<string, unknown>>(p.decisions).map((d) => ({ text: text(d.text), documented: d.documented === true, sourceIds: arr<string>(d.sourceIds), by: d.byOwner === true ? { author: { kind: 'owner', name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' } : { author: { kind: 'agent', name: text(d.byName, null as unknown as string) || null, window: null, host: null, model: null }, holder: null, identity: 'Proposal' } })),
          changes: absent(p.changes) ? [...(previous?.changes ?? [])] : arr<Record<string, unknown>>(p.changes).map((c) => ({ text: text(c.text), sourceIds: arr<string>(c.sourceIds), changeRecordId: null })),
          openQuestions: absent(p.openQuestions) ? [...(previous?.openQuestions ?? [])] : arr<string>(p.openQuestions),
          executionFacts: ex ?? [...(previous?.executionFacts ?? [])], language: text(p.language) || previous?.language || project.language,
          inputs: p.inputs !== undefined ? inputsOf(ctx, p.inputs, `${project.name}`) : previous?.inputs ?? inputsOf(ctx, { sourceIds: about }, `${project.name}`),
          // `Update pending` is the program's (update-pending.ts): writing the record does not take in what it waits for.
          asOf: now(), updatedAt: now(), pendingSourceIds: previous?.pendingSourceIds ?? [],
        };
        store.facts.put(record, trace(previous ? `Fact record updated: ${record.title}` : `Fact record formed: ${record.title}`, about));
        for (const [sid, ua] of Object.entries((p.usedAs ?? {}) as Record<string, string>)) {
          const s = store.sources.get(sid);
          if (s && isOneOf(USED_AS, ua) && !usedAsHistoryRefusal(s, ua)) store.sources.put({ ...s, usedAs: ua, usedAsBy: 'keeper', usedAsByRuleId: ua === s.usedAs ? s.usedAsByRuleId ?? null : null, usedAsByScopeItemId: ua === s.usedAs ? s.usedAsByScopeItemId ?? null : null }, trace(`Used as ${ua}`, [sid]));
        }
        saved('facts', id, `Fact record: ${record.title}`);
        return ok({ id, statements: st ? st.length : record.statements.length, ...(previous ? { updated: true } : {}) });
      },
    }),
    defineTool({
      name: 'pk_write_thread', label: 'Write work thread',
      description: 'Create or update a work item (work thread): one unit of work the project names (a task contract, a task, an issue, a TODO line), with what it does, what changed, actual results, what is unresolved, its fact records, and what it serves (first the Area(s) or Goal whose effect it contributes to — that places it, and the first Area written is its main module: the module of the contract it implements, else the one its dispatch ticket or prompt names, else the first listed; then the contract or requirement it fulfils; work that serves its whole plan — all of the plan’s modules — and no single one serves the Plan item and says why in wholePlanWhy). A call with the id of an existing work item, or the project id it carries (T-09, #18 …) as id or in ids, updates it and gives only what it changes: title, progress and the other fields you leave out or empty keep their value, and factRecordIds, serves, dependsOn and facts are added to what is there — serves after what it already has, in the order written, so the first Area stays first (replaceServes: true replaces the serves list, in the order given; replaceDependsOn: true replaces the dependsOn list — give the dependencies that stand, or none to clear it — so a dependency written wrongly can be taken out). A new work item needs title and progress.',
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: 'the work item to update: its id, or the project id it carries (T-09)' })),
        title: Type.Optional(Type.String({ description: 'a new work item needs it; an update keeps it when left out' })),
        ids: Type.Optional(StrArr), doing: Type.Optional(Type.String()), changed: Type.Optional(Type.String()), results: Type.Optional(Type.String()), unresolved: Type.Optional(Type.String()), replaceServes: Type.Optional(Type.Boolean()),
        replaceDependsOn: Type.Optional(Type.Boolean({ description: 'true: dependsOn in this call is the whole list — what it leaves out is taken away (empty or left out clears it)' })),
        doneMeans: Type.Optional(Type.String({ description: 'The completion conditions the material states: what must be true for the work itself to be finished. Not the conditions only the owner can judge — those go in acceptanceMeans. Empty when nothing states any' })),
        acceptanceMeans: Type.Optional(Type.String({ description: 'What the material says only the owner can judge (an owner review, sign-off or acceptance list). Recording this never lowers progress' })),
        acceptance: Type.Optional(Type.String({ description: 'Accepted | Not yet accepted — only from the owner’s own statement or an acceptance the project records. Leave empty when the project has no acceptance step' })),
        factRecordIds: Type.Optional(StrArr), serves: Type.Optional(Type.Array(Type.Object({ referenceId: Type.String(), claim: Type.String(), basis: Type.String({ description: 'Explicit | Inferred' }) }))),
        dependsOn: Type.Optional(Type.Array(Type.Object({ threadId: Type.String(), claim: Type.String(), basis: Type.String() }))),
        executionFacts: Type.Optional(Type.Array(StatementSchema)), qcFacts: Type.Optional(Type.Array(StatementSchema)),
        progress: Type.Optional(Type.String({ description: 'Planned | In progress | Done | On hold — a new work item needs it; an update keeps it when left out' })), validity: Type.Optional(Type.String({ description: 'Current | Proposed | Deferred | Replaced | Abandoned | Removed (its material was deleted from the project’s current version)' })),
        replacedBy: Type.Optional(Type.String({ description: 'what replaced it or carried it on: the id of a work item or reference item, or the project’s own number of one (T-04, D32). An earlier generation’s item says where it went this way: the current contract that took its work over, or the decision that ended it' })),
        identity: Type.Optional(Type.String({ description: 'Artifact | Proposal | Report' })), authorName: Type.Optional(Type.String()), holderRole: Type.Optional(Type.String()), inputs: InputsSchema,
        carriesOut: Type.Optional(Type.Array(Type.String(), { description: 'when this unit is an execution batch, round or sprint that carries out work items the plan already names: their ids. No work item is created; what you describe is recorded as those work items’ progress' })),
        validityByRuleId: Type.Optional(Type.String({ description: 'the project rule its validity follows, when one does (e.g. an Obsolete rule that withdraws it)' })),
        progressByRuleId: Type.Optional(Type.String({ description: 'the project rule its progress is read by: the authoritative index or field (an Authoritative rule)' })),
        implements: Type.Optional(Type.Array(Type.String(), { description: 'the contract(s) this ticket implements: the contract’s work item or Requirement, by id or by its number (T-22). Recorded as an implements relation from this work item, so the contract’s progress can be held against its tickets' })),
        progressWhy: Type.Optional(Type.String({ description: 'why its progress is what it is when the material seems to say otherwise — a contract still Planned although tickets implementing it are Done' })),
        wholePlanWhy: Type.Optional(Type.String({ description: 'work that serves its whole plan — all of the plan’s modules — and no single one (a milestone QC across every contract of the plan, a reading of the whole graph): why, in one short sentence. It serves the Plan item and no Area; it then stands in the plan’s cross-cutting cell with this reason and is not counted as work in no module. An empty string takes the reason away' })),
        noPlanWhy: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'the records lead nowhere for this work — no plan or dispatch table lists it, no prompt metadata, no contract, no decision it carries out or cites leads to a plan, no arrangement current or archived names it — and why, naming the records you read. The program refuses it when the records do lead to a plan, and says where. With it the work item is written as "no plan — why" and is not counted as work in no plan. null (or an empty string) clears it, only together with a placement (serves with the Plan item in the same call)' })),
        noAreaWhy: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'the records name no module for this work — no contract, no Module column, no dispatch or prompt field — and why, naming the records you read. The program refuses it when the records do name a module, and says which. null (or an empty string) clears it, only together with a placement' })),
      }),
      execute: async (_id, p) => {
        // Progress left out (or empty) keeps the work item's; a new work item needs it.
        const progressGiven = has(p.progress);
        if (progressGiven && !isOneOf(PROGRESS, p.progress)) return fail(`progress must be one of ${PROGRESS.join(', ')}`);
        // §1.4 / D39: an execution batch is not a work item of its own. On the 2026-09-18 assets B0–B9 were listed
        // beside the contracts they executed, the middle column held the same work twice, and 8 Layer drift marks
        // came out of the duplication. What the batch did is the progress of the work items it carried out.
        const carries = [...new Set(arr<string>(p.carriesOut).map((id) => resolveMergedId(store, id)))].filter((id) => store.threads.has(id));
        if (arr<string>(p.carriesOut).length > 0) {
          if (carries.length === 0) return fail(`carriesOut names no existing work item: ${arr<string>(p.carriesOut).join(', ')}. Give the ids of the work items this batch carries out; those are what its progress is recorded on.`);
          const batchFacts = statements(ctx, p.executionFacts ?? [], 'executionFacts');
          if (typeof batchFacts === 'string') return fail(batchFacts);
          // §2.4 (D63): what a batch says it did is its claim, with who and when. It used to be kept as an Observed
          // statement with no source at all, which a reader could not tell from a fact.
          const told = text(p.results) || text(p.changed) || text(p.doing);
          if (told && batchFacts.length === 0) {
            return fail(`What “${text(p.title)}” says it did is its claim: put it in executionFacts as Claimed statements, each with the source it is written in, claimedBy (for example "Worker agent, batch 3 receipt") and claimedAt (the date the material gives) — or as Observed only where a source shows it. A batch that only moves progress needs no statement: give progress alone.`);
          }
          // A batch records the progress of what it carries out, or what it did; one that gives neither records nothing.
          if (!progressGiven && batchFacts.length === 0) {
            throw incompleteCall(`an execution batch that carries out ${carries.map((c) => store.threads.get(c)?.ids[0] ?? c).join(', ')} records their progress (progress) or what it did (executionFacts), and this call gives neither. Nothing was written. Give the progress the batch brought them to, or its statements; the work items keep what the call leaves out.`);
          }
          // Each statement says which batch it came from.
          const batch = text(p.title).trim();
          const tagged = batchFacts.map((s) => (!batch || s.text.includes(batch) ? s : { ...s, text: `${batch}: ${s.text}` }));
          for (const threadId of carries) {
            const t = store.threads.get(threadId)!;
            const merged = [...t.executionFacts];
            for (const s of tagged) if (!merged.some((x) => x.text === s.text)) merged.push(s);
            store.threads.put({ ...t, executionFacts: merged, results: text(p.results) && !t.results.includes(text(p.results)) ? [t.results, text(p.results)].filter(Boolean).join(' ') : t.results, progress: progressGiven ? p.progress as WorkThread['progress'] : t.progress, updatedAt: now() }, trace(`Progress from execution batch${batch ? ` “${batch}”` : ''}`, [...new Set(batchFacts.flatMap((s) => s.sourceIds))]));
            saved('threads', threadId, `Work thread: ${t.title}`);
          }
          return ok({ recordedOn: carries, created: false, note: `An execution batch is not a work item of its own: ${batch ? `“${batch}”` : 'the batch'} was recorded as the progress of the ${carries.length} work item${carries.length === 1 ? '' : 's'} it carries out. The batch’s own plan, round or sprint belongs in a Plan reference item.` });
        }
        if (text(p.acceptance) && !isOneOf(ACCEPTANCE, p.acceptance)) return fail(`acceptance must be ${ACCEPTANCE.join(' or ')}, or empty when the project has no acceptance step`);
        const validityGiven = has(p.validity);
        if (validityGiven && !isOneOf(VALIDITY, p.validity)) return fail(`validity must be one of ${VALIDITY.join(', ')}`);
        const facts = arr<string>(p.factRecordIds).filter((id) => store.facts.has(id));
        const ex = statements(ctx, p.executionFacts ?? [], 'executionFacts'); if (typeof ex === 'string') return fail(ex);
        const qc = statements(ctx, p.qcFacts ?? [], 'qcFacts'); if (typeof qc === 'string') return fail(qc);
        // CQ (D104): a Plan or Area may be named by the id its document gives it (`K`, `P1`, `M1`) as well as by its store id.
        const serves = arr<Record<string, unknown>>(p.serves).map((s) => ({ referenceId: referenceByWrittenId(store, text(s.referenceId))?.id ?? text(s.referenceId), claim: text(s.claim), basis: (isOneOf(BASIS, s.basis) ? s.basis : 'Inferred') as 'Explicit' | 'Inferred' }));
        const unknownRef = serves.filter((s) => !store.reference.has(s.referenceId));
        if (unknownRef.length) return fail(`serves cites unknown reference ids: ${unknownRef.map((s) => s.referenceId).join(', ')} (a Plan or Area is named by its id, or by the project id its document gives it, such as P1 or M2)`);
        // CJ: the contracts it implements — a contract's work item (by id or number), or its Requirement.
        const contracts: { id: string; label: string }[] = [];
        for (const raw of arr<string>(p.implements).map((x) => text(x).trim()).filter(Boolean)) {
          const up = raw.toUpperCase();
          const t = store.threads.get(resolveMergedId(store, raw)) ?? store.threads.find((x) => x.ids.some((i) => i.toUpperCase() === up));
          const r = t ? undefined : store.reference.get(raw) ?? store.reference.find((x) => x.category === 'Requirement' && x.ids.some((i) => i.toUpperCase() === up));
          if (!t && !r) return fail(`implements: ${raw} is neither a work item nor a Requirement of the assets, by id or by number. Give the contract this ticket implements (its work item, or its number such as T-22). Nothing was written.`);
          contracts.push(t ? { id: t.id, label: t.ids[0] && !t.title.includes(t.ids[0]) ? `${t.ids[0]} ${t.title}` : t.title } : { id: r!.id, label: r!.name });
        }
        // One work item per unit the project names: a call with the same project id updates it (several jobs write the plan's
        // work items at once during takeover), and an update adds to what is there instead of wiping it.
        const ids = arr<string>(p.ids).map((x) => text(x).trim()).filter(Boolean);
        /** The work item that carries this project id (CKC-09), as its ids or the identifier its title starts with. */
        const carrying = (n: string) => store.threads.find((t) => t.ids.some((x) => x.toUpperCase() === n.toUpperCase()) || primaryIdentifier(t.ids, t.title) === n.toUpperCase());
        // §1.4 (CKC-06 AC-28): the id of a work item merged into another reaches the one kept, so a job that still
        // remembers it updates that one instead of bringing the duplicate back.
        let givenId = text(p.id) ? resolveMergedId(store, text(p.id).trim()) : '';
        // Redirected by a merge (not by a project number naming the work item that carries it): the kept item keeps its title.
        const redirected = givenId !== '' && givenId !== text(p.id).trim() && mergeOf(store, text(p.id).trim()) !== null;
        // CJ: a project number given as id (`AP`) that no work item has or carries is that work item's number, kept in its
        // ids — the process engine ties work by its ids (units.ts). It used to become the item's internal id with its ids
        // left empty, and 50 of 63 finished tickets showed no delivery. A work item that got such an id before is given
        // the number in its ids when it is next written.
        if (givenId && isWrittenNumber(givenId)) {
          const upper = givenId.toUpperCase();
          if (!store.threads.has(givenId) && !carrying(givenId)) {
            if (!ids.some((x) => x.toUpperCase() === upper)) ids.unshift(givenId);
            givenId = '';
          } else if (store.threads.get(givenId)?.ids.length === 0 && !ids.some((x) => x.toUpperCase() === upper)) {
            ids.unshift(givenId);
          }
        }
        // CJ: ids are the project's own numbers — ones the ledger finds defined — and never another object's: a decision's
        // (D99, D100, E145), a module's; and a title that opens with another object's number does not give the work item
        // that number (BV–CB took D99, CE–CG took D100, and showed the ADR commits as their delivery).
        const titleGiven = text(p.title).trim();
        const needsLedger = ids.length > 0 || (titleGiven !== '' && (isNumberOnly(titleGiven) || primaryIdentifier([], titleGiven) !== null));
        const checked = !needsLedger ? { refusal: null as string | null, titleNumberIsOther: false } : withNumbering(store, (ledger) => {
          const known = new Set((store.threads.get(givenId)?.ids ?? []).map((x) => x.toUpperCase()));
          const fresh = ids.filter((x) => !known.has(x.toUpperCase()));
          const others = fresh.map((x) => ({ x, of: otherObjectOf(store, ledger, x) })).filter((o) => o.of);
          if (others.length) return { refusal: `${others.map((o) => `${o.x} is the number of ${o.of}`).join('; ')}, not of this work item. A work item’s ids are its own number (the ticket’s, the task’s: AB, T-22); what it carries out goes in with pk_record_carry_out, and what it serves in serves. Nothing was written.` };
          const unknown = undefinedNumbers(ledger, fresh);
          if (unknown.length) return { refusal: `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a number the project defines — no heading, bold entry, table row, prompt id, file or branch name, or commit subject defines ${unknown.length === 1 ? 'it' : 'them'} (the ledger reads all of these). A work item’s ids are the project’s own numbers, as written; leave out a label of your own. Nothing was written.` };
          const title = text(p.title).trim();
          const fromTitle = ids.length ? null : primaryIdentifier([], title);
          const titleNumberIsOther = fromTitle ? otherObjectOf(store, ledger, fromTitle) !== null : false;
          const named = title ? numberOnlyRefusal(store, ledger, title, [], 'The title') : null;
          return { refusal: named, titleNumberIsOther };
        }, { refusal: null as string | null, titleNumberIsOther: false });
        if (checked.refusal) return fail(checked.refusal);
        const primary = checked.titleNumberIsOther && !ids.length ? null : primaryIdentifier(ids, text(p.title));
        // An id that is no work item's own but the project id one carries names that work item: writing it as a new one
        // would give one unit of work two work items (§1.4).
        const numbered = givenId && !store.threads.has(givenId) ? carrying(givenId) : undefined;
        const match = givenId || !primary ? undefined : carrying(primary);
        const id = numbered?.id || givenId || match?.id || resolveMergedId(store, ids.length ? stableId('thread', project.id, ...ids) : newId('thread'));
        const previous = store.threads.get(id);
        if (contracts.some((c) => c.id === id)) return fail('implements names this work item itself: a ticket implements a contract other than itself. Nothing was written.');
        if (!previous) {
          const missing = [...(absent(p.title) ? ['title'] : []), ...(progressGiven ? [] : ['progress'])];
          if (missing.length) {
            const why = givenId ? `No work item has the id ${text(p.id)} or carries it as its project id`
              : primary || ids.length ? `No work item carries ${primary ?? ids.join(', ')}`
                : 'This call names no existing work item (no id, and no project id in ids or at the start of the title)';
            throw createNeeds('a work item', why, missing, 'To update an existing work item, give its id — or the project id it carries, such as T-09 — as id.');
          }
        }
        const validity = validityGiven ? p.validity as WorkThread['validity'] : (previous?.validity ?? 'Current');
        const progress = progressGiven ? p.progress as WorkThread['progress'] : previous!.progress;
        // CM (E151): what replaced it is named by id or by the project's own number; a name that stands for nothing is
        // refused, so a destination is never a dead end (on the gated run the main agent believed the field did not exist).
        let replacedBy: string | null = null;
        if (has(p.replacedBy)) {
          const written = text(p.replacedBy).trim();
          const successor = successorOf(store, written);
          if (successor?.id === id) return fail('replacedBy names this work item itself. Nothing was written.');
          if (!successor && !isNumberShaped(written.toUpperCase())) return fail(`replacedBy: ${written} is no work item or reference item of the assets, by id or by number. Give the id, or the project’s own number (T-04, D32) of what replaced it. Nothing was written.`);
          replacedBy = successor?.id ?? written;
        }
        // §1.4, §2.6: one unit of work has one work item. A number another work item already carries is that unit.
        const clash = ids.filter((n) => !/^v\d/i.test(n)).map((n) => ({ n, t: store.threads.find((t) => t.id !== id && t.ids.some((x) => x.toUpperCase() === n.toUpperCase())) })).find((c) => c.t);
        if (clash?.t) {
          return fail(`${clash.n} is already the number of work item ${clash.t.id} (“${clash.t.title}”). One unit of work has one work item: to update that one, write with id: "${clash.t.id}"; an execution batch or report that carries it out goes in with carriesOut: ["${clash.t.id}"]; if the two turn out to be the same work, merge them at the end of the round with pk_merge_work_items.`);
        }
        // §1.15: a validity or progress read by one of the project's rules names it, and the rule has to say so.
        const validityByRuleId = text(p.validityByRuleId).trim();
        if (validityByRuleId) {
          const refusal = ruleUseRefusal(store, validityByRuleId, validity === 'Removed' ? 'Removed' : 'Validity');
          if (refusal) return fail(refusal);
          if (store.rules.get(validityByRuleId)!.category === 'Obsolete' && validity !== 'Replaced' && validity !== 'Abandoned') {
            return fail(`An Obsolete rule makes what it withdraws Replaced or Abandoned (Replaced points to the new way the rule names), never ${validity}.`);
          }
        }
        const progressByRuleId = text(p.progressByRuleId).trim();
        if (progressByRuleId) {
          const refusal = ruleUseRefusal(store, progressByRuleId, 'Progress');
          if (refusal) return fail(refusal);
        }
        // Removed is judged when a call sets it; an update that leaves validity out keeps what was judged then.
        if (validityGiven && validity === 'Removed') {
          const refusal = removedRefusal(store, [...new Set([...(previous?.factRecordIds ?? []), ...facts])].flatMap((f) => store.facts.get(f)?.aboutSourceIds ?? []), validityByRuleId);
          if (refusal) return fail(refusal);
        }
        // §1.2, §2.6 (D61; CKC-02 AC-23): a work item is a current node, and what exists only in history forms none.
        const restsOn = [
          ...[...new Set([...(previous?.factRecordIds ?? []), ...facts])].flatMap((f) => store.facts.get(f)?.aboutSourceIds ?? []),
          ...[...(previous?.executionFacts ?? []), ...(previous?.qcFacts ?? []), ...ex, ...qc].flatMap((s) => s.sourceIds),
        ];
        const fromHistory = workItemHistoryRefusal(store, restsOn, validity);
        if (fromHistory) return fail(fromHistory);
        const identity = isOneOf(IDENTITY, p.identity) ? p.identity : (previous?.attribution.identity ?? 'Artifact');
        const keep = (v: unknown, old: string | undefined) => text(v) || old || '';
        const mergeBy = <T,>(old: readonly T[], add: readonly T[], key: (x: T) => string): T[] => { const m = new Map(old.map((x) => [key(x), x])); for (const x of add) m.set(key(x), x); return [...m.values()]; };
        const wholePlanWhy = absent(p.wholePlanWhy) ? previous?.wholePlanWhy ?? null : redact(text(p.wholePlanWhy)).trim() || null;
        // CQ (D104): the reasons that leave work unplaced on purpose, kept until a call gives another, or clears it (null or '').
        const noPlanWhy = p.noPlanWhy === undefined ? previous?.noPlanWhy ?? null : redact(text(p.noPlanWhy)).trim() || null;
        const noAreaWhy = p.noAreaWhy === undefined ? previous?.noAreaWhy ?? null : redact(text(p.noAreaWhy)).trim() || null;
        const deps = arr<Record<string, unknown>>(p.dependsOn).map((d) => ({ threadId: resolveMergedId(store, text(d.threadId)), claim: text(d.claim), basis: (isOneOf(BASIS, d.basis) ? d.basis : 'Inferred') as 'Explicit' | 'Inferred' })).filter((d) => d.threadId !== id);
        const thread: WorkThread = {
          id, projectId: project.id, title: (redirected ? previous?.title : undefined) || text(p.title) || previous?.title || '', ids: [...new Set([...(previous?.ids ?? []), ...ids, ...(primary && !ids.length && !previous?.ids.length ? [primary] : [])])],
          doing: keep(p.doing, previous?.doing), changed: keep(p.changed, previous?.changed), results: keep(p.results, previous?.results), unresolved: keep(p.unresolved, previous?.unresolved),
          doneMeans: text(p.doneMeans) || previous?.doneMeans || '',
          acceptanceMeans: text(p.acceptanceMeans) || previous?.acceptanceMeans || '',
          acceptance: isOneOf(ACCEPTANCE, p.acceptance) ? p.acceptance : (previous?.acceptance ?? ''),
          executionFacts: mergeBy(previous?.executionFacts ?? [], ex, (x) => x.text), qcFacts: mergeBy(previous?.qcFacts ?? [], qc, (x) => x.text),
          factRecordIds: [...new Set([...(previous?.factRecordIds ?? []), ...facts])],
          serves: p.replaceServes === true || !previous ? serves : mergeBy(previous.serves, serves, (x) => x.referenceId),
          // CZ: dependencies are added to what is there; replaceDependsOn gives the list whole (a wrong one can be taken out).
          dependsOn: p.replaceDependsOn === true || !previous ? deps : mergeBy(previous.dependsOn, deps, (x) => x.threadId),
          progress, validity, replacedBy: replacedBy ?? previous?.replacedBy ?? null,
          attribution: p.authorName || p.holderRole || !previous ? { author: { kind: p.authorName ? 'role' : 'unknown', name: text(p.authorName) || null, window: null, host: null, model: null }, holder: p.holderRole ? { role: p.holderRole, window: null } : null, identity } : { ...previous.attribution, identity },
          // What the job received is recorded when the call gives it; an update that gives none keeps the record's.
          inputs: p.inputs !== undefined ? inputsOf(ctx, p.inputs, project.name) : previous?.inputs ?? inputsOf(ctx, { factRecordIds: facts }, project.name),
          asOf: now(), updatedAt: now(),
          // `Update pending` is the program's, worked out from what waits for the next round (update-pending.ts): an
          // update leaves it as it is, since a change it waits for is not taken in by writing the work item.
          pendingSourceIds: previous?.pendingSourceIds ?? [], ...(previous?.waitsFor ? { waitsFor: previous.waitsFor } : {}),
          // The rule stays named while the value it decided stays; a value changed without one no longer rests on it.
          validityByRuleId: validityByRuleId || (previous && previous.validity === validity ? previous.validityByRuleId ?? null : null),
          progressByRuleId: progressByRuleId || (previous && previous.progress === progress ? previous.progressByRuleId ?? null : null),
          // The status its document writes, as the fill-in tools copied it (D99): the document's, so a judgement keeps it.
          ...(previous?.writtenStatus ? { writtenStatus: previous.writtenStatus } : {}),
          // Why the progress stands as it does, while it does (CJ): a new progress without a reason drops the old one.
          ...(text(p.progressWhy).trim() ? { progressWhy: text(p.progressWhy).trim() } : previous?.progressWhy && previous.progress === progress ? { progressWhy: previous.progressWhy } : {}),
          // CN (E152): why it serves its whole plan and no single module; kept until a call gives another, or an empty one.
          ...(wholePlanWhy ? { wholePlanWhy } : {}),
          // CQ (D104): the recorded reasons the records lead nowhere, checked below against the program's inference.
          ...(noPlanWhy ? { noPlanWhy } : {}),
          ...(noAreaWhy ? { noAreaWhy } : {}),
        };
        // CN: whole-plan work is in a plan (it serves the Plan item, or an earlier generation lists it); with none there is
        // no plan to serve the whole of. An Area it serves places it there, and the reason then says nothing.
        let wholeNote: string | null = null;
        if (has(p.wholePlanWhy)) {
          const inPlan = plansOf(store, thread).length > 0 || earlierWork(store).has(id);
          if (!inPlan) return fail('wholePlanWhy says the work serves its whole plan, and this work item is in no plan: give serves with the Plan item it belongs to in the same call (the plan or dispatch table that lists it, its prompt’s increment or milestone). Nothing was written.');
          const areas = reachOf(store).ofThread(thread).areas.map((a) => store.reference.get(a)?.name ?? a);
          if (areas.length) wholeNote = `It also serves ${areas.join(', ')}, so it stands in ${areas.length === 1 ? 'that module' : 'those modules'}; wholePlanWhy places work that serves no single module. To place it on the whole plan, give serves without an Area and replaceServes: true.`;
        }
        // CQ (D104): a reason for "no plan" / "no module" is a record the program can refuse (placement-inference.ts): refused
        // when the work is placed already or the records lead to a plan or a module (the refusal names the chain); accepted
        // when the chain is empty, and always when the project has no plan layer or no Areas. Clearing it needs a placement.
        const inGeneration = earlierWork(store).has(id);   // CZ: not an item carried on under the same number
        const plansNow = plansOf(store, thread);
        const inPlanNow = plansNow.length > 0 || inGeneration;
        const planShort = (planId: string): string => { const r = store.reference.get(planId); return r ? r.ids[0] ?? r.name.split(NAME_SEP)[0]?.trim() ?? r.name : planId; };
        const areasNow = reachOf(store).ofThread(thread).areas;
        const withInference = <T,>(fn: (ctx: InferenceContext) => T): T => { let l: Ledger | null = null; try { l = Ledger.openDir(store.dir); } catch { l = null; } try { return fn(inferenceContext(store, l)); } finally { l?.close(); } };
        if (p.noPlanWhy !== undefined) {
          // DB: "in a plan" is the workbench's — a band of a current plan, or an earlier generation's (ui/placement.js). A
          // plan with no band (not current: Proposed, Deferred, Replaced, Abandoned; or held by an earlier generation while
          // this item was carried on) places nothing, so a reason may stand beside it. An item the workbench does not draw
          // (deferred, abandoned) is judged as before, by the plans it names.
          const bench = workbenchPlacement(store, { thread });
          const at = bench.place.get(id);
          const inBandNow = at ? at.zone === 'gen' || (at.band !== undefined && at.band !== NO_PLAN) : inPlanNow;
          if (noPlanWhy) {
            if (inBandNow) return fail(`noPlanWhy says no record places this work item in a plan, and it is in ${at?.plan ? planShort(at.plan) : at?.gen ? 'an earlier generation' : plansNow.map((r) => planShort(r.id)).join(', ') || 'an earlier generation'}: a reason is written only for work in no plan. Nothing was written.`);
            const drawn = new Set(bench.plans.map((x) => x.id));
            const refusal = withInference((ctx) => noPlanWhyRefusal(ctx, thread, drawn));
            if (refusal) return fail(refusal);
          } else if (previous?.noPlanWhy && !inBandNow) return fail('noPlanWhy is cleared only together with a placement: give serves with the Plan item it belongs to in the same call, or leave the reason. Nothing was written.');
        }
        if (p.noAreaWhy !== undefined) {
          if (noAreaWhy) {
            if (areasNow.length) return fail(`noAreaWhy says no record names a module for this work item, and it serves ${areasNow.map((a) => store.reference.get(a)?.name.split(NAME_SEP)[0]?.trim() ?? a).join(', ')}: a reason is written only for work in no module. Nothing was written.`);
            const refusal = withInference((ctx) => noAreaWhyRefusal(ctx, thread));
            if (refusal) return fail(refusal);
          } else if (previous?.noAreaWhy && !areasNow.length && !thread.wholePlanWhy) return fail('noAreaWhy is cleared only together with a placement: give serves with the Area in the same call, or leave the reason. Nothing was written.');
        }
        // Un-placing: a replaceServes that takes the work out of every plan needs a reason the program accepts.
        if (p.replaceServes === true && previous && !inPlanNow && plansOf(store, previous).length > 0 && !thread.noPlanWhy && planLayerPresent(store)) {
          return fail(`replaceServes leaves this work item in no plan (it served ${plansOf(store, previous).map((r) => r.ids[0] ?? r.name.split(NAME_SEP)[0]?.trim() ?? r.name).join(', ')}): give the Plan item it belongs to in serves, or write noPlanWhy with the records you read (the program refuses it when the records lead somewhere). Nothing was written.`);
        }
        // What this write does with the program's Inferred placements of this item: kept as written, made its own, or replaced.
        const replacedInferred = previous && programTargetsOf(store, 'thread', id).length
          ? noteOverride(store, 'thread', id, { targets: thread.serves.map((s) => s.referenceId), kept: (target) => { const now = thread.serves.find((s) => s.referenceId === target); if (!now) return 'gone'; const was = previous.serves.find((s) => s.referenceId === target); return now.basis !== was?.basis || now.claim !== was?.claim ? 'rewritten' : 'as written'; } }, { jobId: ctx.jobId, roundId: ctx.step?.roundId ?? null })
          : [];
        const basis = facts.flatMap((f) => store.facts.get(f)?.aboutSourceIds ?? []);
        store.threads.put(thread, trace(`${previous ? `Work thread updated: ${thread.title}` : `Work thread formed: ${thread.title}`}${replacedInferred.length ? ` (replaced the program's Inferred placement on ${replacedInferred.join('; ')})` : ''}`, basis));
        saved('threads', id, `Work thread: ${thread.title}`);
        // CJ: the contract a ticket implements, as a relation from the ticket.
        for (const c of contracts) {
          const relId = stableId('rel', 'implements', id, c.id);
          const before = store.relations.get(relId);
          store.relations.put({
            id: relId, projectId: project.id, type: 'implements', from: id, to: c.id, claim: before?.claim ?? `${thread.ids[0] ?? thread.title} implements ${c.label}`, basis: before?.basis ?? 'Explicit',
            evidence: before?.evidence ?? { sourceIds: [], factRecordIds: thread.factRecordIds, factsSoFar: '' },
            assessment: before?.assessment ?? 'Not assessed', assessedAt: before?.assessedAt ?? null, assessedInJobId: before?.assessedInJobId ?? null, updatedAt: now(),
          }, trace(`Relation implements: ${thread.title} → ${c.label}`));
          saved('relations', relId, 'Relation implements');
        }
        const placed = thread.serves.some((x) => { const r = store.reference.get(x.referenceId); return r && (r.category === 'Goal' || r.category === 'Product' || placement(store, r.id) !== null); });
        const effect = thread.serves.some((x) => { const c = store.reference.get(x.referenceId)?.category; return c === 'Area' || c === 'Goal'; });
        const warning = wholeNote ?? (thread.wholePlanWhy ? null
          : !placed ? 'Not placed: serves names nothing that leads to an Area, Goal or Product, so this work item shows as Unplaced. Add serves: the Area(s) whose effect this work contributes to.'
          : !effect && store.reference.find((r) => r.category === 'Area') ? 'serves names no Area or Goal directly; add the Area(s) whose effect this work contributes to as the first serves entry (the contract or document it fulfils stays as a second entry). Work that serves its whole plan and no single module says why in wholePlanWhy.' : null);
        return ok({ id, updated: Boolean(previous), ...(warning ? { warning } : {}), ...(replacedInferred.length ? { replacedInferred, note: 'This write replaced a placement the program had inferred; the round record keeps both.' } : {}) });
      },
    }),
    defineTool({
      name: 'pk_write_area', label: 'Write area understanding',
      description: 'Create or update the understanding of one product area (an Area reference item): the effect reached now, remaining gaps, and which work threads contribute with what claim. Pass id, or the Area’s referenceId, to update: an update gives only what it changes, and what it leaves out keeps its value (contributions, when given, replace the list). A new area understanding needs referenceId, effectNow, gaps and contributions.',
      parameters: Type.Object({
        id: Type.Optional(Type.String()),
        referenceId: Type.Optional(Type.String({ description: 'the Area reference item; a new area understanding needs it, and it finds the one already written for that Area' })),
        effectNow: Type.Optional(Type.String()), gaps: Type.Optional(Type.String()),
        contributions: Type.Optional(Type.Array(Type.Object({ threadId: Type.String(), claim: Type.String(), basis: Type.String() }))), inputs: InputsSchema,
      }),
      execute: async (_id, p) => {
        const named = text(p.id) ? store.areas.get(text(p.id)) : undefined;
        const referenceId = text(p.referenceId) || named?.referenceId || '';
        const ref = referenceId ? store.reference.get(referenceId) : undefined;
        if (text(p.referenceId) && (!ref || ref.category !== 'Area')) return fail(`referenceId must be an existing Area reference item`);
        const id = text(p.id) || (referenceId ? stableId('area', project.id, referenceId) : '');
        const previous = id ? store.areas.get(id) : undefined;
        if (!previous) {
          const missing = [...(referenceId ? [] : ['referenceId']), ...(['effectNow', 'gaps', 'contributions'] as const).filter((f) => absent(p[f]))];
          if (missing.length) throw createNeeds('an area understanding', id ? `${id} is no area understanding of the assets` : 'This call names no area understanding (no id, and no referenceId to find one by)', missing, 'To update an area understanding, give its id, or the referenceId of its Area.');
        }
        const contributions = absent(p.contributions) ? [...previous!.contributions] : arr<Record<string, unknown>>(p.contributions).map((c) => ({ threadId: resolveMergedId(store, text(c.threadId)), claim: text(c.claim), basis: (isOneOf(BASIS, c.basis) ? c.basis : 'Inferred') as 'Explicit' | 'Inferred' })).filter((c) => store.threads.has(c.threadId));
        const area: AreaUnderstanding = {
          id, projectId: project.id, referenceId, effectNow: text(p.effectNow) || previous?.effectNow || '', gaps: text(p.gaps) || previous?.gaps || '', contributions,
          inputs: p.inputs !== undefined ? inputsOf(ctx, p.inputs, project.name) : previous?.inputs ?? inputsOf(ctx, { threadIds: contributions.map((c) => c.threadId) }, project.name),
          // `Update pending` is the program's (update-pending.ts): writing the understanding does not take in what it waits for.
          asOf: now(), updatedAt: now(), pendingSourceIds: previous?.pendingSourceIds ?? [], ...(previous?.waitsFor ? { waitsFor: previous.waitsFor } : {}),
        };
        const label = ref?.name ?? referenceId;
        store.areas.put(area, trace(`Area understanding: ${label}`, ref?.sourceIds ?? []));
        saved('areas', id, `Area understanding: ${label}`);
        return ok(previous ? { id, updated: true } : { id });
      },
    }),
    defineTool({
      name: 'pk_write_reference', label: 'Write product reference item',
      description: 'Create or update a product reference item (Owner’s words, Product, Goal, Area, Requirement, Design, Decision, Plan, Boundary): the project’s own name/number, its text, the owner’s own words when it records an owner statement, basis (Explicit/Inferred), validity, identity, sources, what it refines (this places it: Goal → Product, Area → Goal, everything else → its Area(s), or the Product when it covers the whole product; a product description also refines the owner’s words it details), what replaced it. An Owner’s words item is the top layer: one thing the owner said or explicitly confirmed, with the owner’s words copied in quote and the session or decision record they were said in as its source — an agent’s restatement is not one. Material that is History only or Reference only forms no item. An item with the same project id (T-09, D36, P2 …) and category is updated, not duplicated. Pass id (or the project id, with the category when several items carry it) to update: an update gives only what it changes, and what it leaves out keeps its value (sourceIds and refines, when given, replace their lists; a new validity drops a replacedBy it does not give again). A new item needs category, name, text, basis, validity, identity and sourceIds. A new Area — and one newly marked foundation — places again, in the same call, everything that names it in the project’s own writing: its requirement group, the Spec chapter tagged with it, the contracts whose Module column writes it (its short form counts), the tickets implementing them, the decisions whose entry names those; the result lists them (placedAgain).',
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: 'the item to update: its id, or the project’s number it carries (D36, T-14) — a number is looked up and updates the item that carries it; it is never stored as an id' })),
        category: Type.Optional(Type.String({ description: 'a new item needs it; with the project id it finds the item to update' })),
        name: Type.Optional(Type.String()), ids: Type.Optional(StrArr), text: Type.Optional(Type.String()), quote: Type.Optional(Type.String({ description: 'the owner’s own words, copied exactly as they stand in the sources cited — …… where you leave words out' })),
        answers: Type.Optional(Type.String({ description: 'an Owner’s words quote too short to stand alone (“ok”, “yes, start the run”, 「可以」): the message it answers, copied from the session or the record cited — …… where you leave words out' })),
        basis: Type.Optional(Type.String({ description: 'Explicit | Inferred' })), validity: Type.Optional(Type.String({ description: 'Current | Proposed | Deferred | Replaced | Abandoned | Removed (its material was deleted from the project’s current version)' })), identity: Type.Optional(Type.String({ description: 'Decision | Artifact | Proposal | Report | Interpretation' })), authorKind: Type.Optional(Type.String({ description: 'owner | role | agent | unknown' })), authorName: Type.Optional(Type.String()),
        sourceIds: Type.Optional(StrArr), refines: Type.Optional(StrArr), replacedBy: Type.Optional(Type.String()), progress: Type.Optional(Type.String()), inputs: InputsSchema,
        validityByRuleId: Type.Optional(Type.String({ description: 'the project rule its validity follows, when one does: an Obsolete rule that withdraws it (then validity Replaced or Abandoned, basis Explicit), a Recovery only rule for Removed' })),
        holderRole: Type.Optional(Type.String({ description: 'the role that keeps this item, when the project divides its work among roles; an update that names none keeps it' })),
        foundation: Type.Optional(Type.Boolean({ description: 'an Area only: true when it is a cross-cutting foundation the project’s own documents treat as a peer of its modules — a row of the module or scope table, a requirement-group heading, a Spec chapter tagged with it, a value of a contract’s Module column. It is a column under the project’s own name, placed after the modules. Conventions that own no work are not an Area: they stay in the cross-cutting ring' })),
        wholeProductWhy: Type.Optional(Type.String({ description: 'a decision, boundary, requirement or design that concerns the whole product and no single area or plan: why — one sentence the cross-cutting ring shows with it. Without it, an item that refines only the Product counts as not placed. A foundation Area is an Area, not the whole product; a trial arrangement or a model choice belongs to the plan it shapes' })),
      }),
      execute: async (_id, p) => {
        const categoryGiven = text(p.category).trim();
        if (categoryGiven && !isOneOf(REFERENCE_CATEGORY, categoryGiven)) return fail(`category must be one of ${REFERENCE_CATEGORY.join(', ')}`);
        if (has(p.basis) && !isOneOf(BASIS, p.basis)) return fail(`basis must be Explicit or Inferred`);
        if (has(p.validity) && !isOneOf(VALIDITY, p.validity)) return fail(`validity must be one of ${VALIDITY.join(', ')}`);
        if (has(p.identity) && !isOneOf(IDENTITY, p.identity)) return fail(`identity must be one of ${IDENTITY.join(', ')}`);
        // One item per project identifier and category: a new call whose ids or leading identifier match an existing item of
        // the same category updates that item (on 2026-09-17 D36–D38 were each written three times under varying names).
        // An update that leaves the category out finds the one item carrying the identifier.
        const idsGiven = arr<string>(p.ids);
        // CZ: a number is written once. An id that is no item's own id is looked up as the project's number — it updates
        // the item that carries it, and is kept as the number of a new one; it never becomes a record id. (On the flash
        // run a lane wrote `id: "E14"` to rename the Decision the fill had written, and E14 stood twice.)
        const written = text(p.id).trim();
        const asNumber = written !== '' && !store.reference.has(written) && isWrittenNumber(written) ? written.toUpperCase() : null;
        const givenId = asNumber ? '' : written;
        const ids = asNumber && !idsGiven.some((x) => x.trim().toUpperCase() === asNumber) ? [written, ...idsGiven] : idsGiven;
        const primary = asNumber ?? primaryIdentifier(ids, text(p.name));
        const carrying = !givenId && primary ? store.reference.filter((r) => r.ids.some((x) => x.toUpperCase() === primary) || primaryIdentifier(r.ids, r.name) === primary) : [];
        if (!categoryGiven && carrying.length > 1) {
          return fail(`${carrying.length} product reference items carry ${primary}: ${carrying.map((r) => `${r.id} (${r.category} “${r.name}”)`).join(', ')}. Give the category of the one to update, or its id.`);
        }
        const match = categoryGiven ? carrying.find((r) => r.category === categoryGiven) : carrying[0];
        const id = givenId || match?.id || (categoryGiven ? stableId('ref', project.id, categoryGiven, ...(ids.length ? ids : [text(p.name)])) : '');
        const previous = id ? store.reference.get(id) : undefined;
        if (!previous) {
          const missing = (['category', 'name', 'text', 'basis', 'validity', 'identity', 'sourceIds'] as const).filter((f) => (f === 'category' ? !categoryGiven : absent(p[f])));
          if (missing.length) {
            const why = givenId ? `${givenId} is no product reference item of the assets` : primary ? `No product reference item${categoryGiven ? ` of category ${categoryGiven}` : ''} carries ${primary}` : 'This call names no existing product reference item (no id, and no project id in ids or at the start of the name)';
            throw createNeeds('a product reference item', why, missing, 'To update an existing item, give its id, or the project id it carries (ids) with its category.');
          }
        }
        // What the call gives, over what the item has.
        const category = (categoryGiven || previous!.category) as ReferenceItem['category'];
        const basis = (has(p.basis) ? p.basis : previous!.basis) as ReferenceItem['basis'];
        const validity = (has(p.validity) ? p.validity : previous!.validity) as ReferenceItem['validity'];
        const identity = (has(p.identity) ? p.identity : previous!.attribution.identity) as ReferenceItem['attribution']['identity'];
        const validityChanged = previous !== undefined && validity !== previous.validity;
        const sourceIds = absent(p.sourceIds) ? [...previous!.sourceIds] : arr<string>(p.sourceIds).filter((s) => store.sources.has(s));
        const cited = sourceIds.map((s) => store.sources.get(s)).filter((s): s is Source => s !== undefined);
        const quote = text(p.quote) || previous?.quote || '';
        // Who said it follows the call; a call that changes the identity and names no author takes the author a new item
        // with that identity would get (a Decision is the owner's).
        const identityChanged = previous !== undefined && identity !== previous.attribution.identity;
        const authorKind = (['owner', 'role', 'agent', 'unknown'] as const).find((k) => k === p.authorKind)
          ?? (previous && !identityChanged ? previous.attribution.author.kind : (identity === 'Decision' ? 'owner' : 'unknown'));
        const sameAuthor = previous !== undefined && authorKind === previous.attribution.author.kind && !has(p.authorName);
        // §1.3 (D63): the owner's words are what the owner said, copied, with where they said it. An agent's restatement,
        // summary or "the owner means …" is not one unless the owner confirmed it.
        if (category === OWNER_WORDS) {
          if (!quote.trim()) return fail(`An Owner's words item carries the owner’s own words (quote), copied from where they were said: each item opens to what the owner actually said. Put your one-line reading in text and the owner’s words in quote.`);
          if (sourceIds.length === 0) return fail(`An Owner's words item names where the owner said it: the source of the session message, or of the decision record that copies the owner’s words. None of the given ids is a source in the assets.`);
          if ((has(p.authorKind) && p.authorKind !== 'owner') || authorKind !== 'owner' || identity !== 'Decision') {
            return fail(`Owner's words are the owner’s own statements (author owner, identity Decision). An agent’s restatement or summary of what the owner wants is not one unless the owner confirmed it: record it as the product description it is, and let it refine the owner’s words it restates.`);
          }
        }
        if (sourceIds.length === 0 && basis === 'Explicit') return fail('an Explicit item must cite at least one existing source');
        if (identity === 'Decision' && authorKind !== 'owner') return fail('only the owner’s statements have identity Decision');
        // §1.2, §2.6 (D61; CKC-02 AC-23, AC-25): what exists only in history forms no current node, and reference-only
        // material — including the documents third-party material brings — never becomes a requirement, boundary or
        // plan. Either can be cited next to the project's own material; an item resting on nothing else is refused.
        if (validity !== 'Removed' && cited.length > 0 && cited.every((s) => s.usedAs === 'History only' || s.usedAs === 'Reference only')) {
          const history = cited.every((s) => s.usedAs === 'History only');
          const reference = cited.every((s) => s.usedAs === 'Reference only');
          return fail(history
            ? `Every source this item cites is History only: old versions, deleted files and what the project keeps for recovery exist only in history and form no current node. Use them to mark what current material has outdated, to cross-check current documents, or to trace history — and if something was dropped that should not have been, say so in a note for the owner.`
            : reference
              ? `Every source this item cites is Reference only: material the project keeps for reference, and the documents third-party material brings with it, can be cited but never become a requirement, boundary, design or plan of the project. What the project itself does with that material is a fact about the project, in its own sources.`
              : `Every source this item cites is History only or Reference only, and neither forms a current product reference item. Cite the project’s own current material it rests on.`);
        }
        // §1.15: a validity one of the project's rules decides names the rule, and the rule has to say so.
        const validityByRuleId = text(p.validityByRuleId).trim();
        if (validityByRuleId) {
          const refusal = ruleUseRefusal(store, validityByRuleId, validity === 'Removed' ? 'Removed' : 'Validity');
          if (refusal) return fail(refusal);
          if (store.rules.get(validityByRuleId)!.category === 'Obsolete') {
            if (validity !== 'Replaced' && validity !== 'Abandoned') return fail(`An Obsolete rule makes what it withdraws Replaced or Abandoned (Replaced points to the new way the rule names), never ${validity}.`);
            if (basis !== 'Explicit') return fail(`What the project’s own Obsolete rule withdraws is judged Explicit, with the rule as its basis — the project wrote it down; nothing about it is your inference.`);
          }
        }
        // Removed is judged when a call sets it; an update that leaves validity out keeps what was judged then.
        if (has(p.validity) && validity === 'Removed') {
          const refusal = removedRefusal(store, sourceIds, validityByRuleId);
          if (refusal) return fail(refusal);
        }
        // §1.3 (D63, E80, E86): an owner quote stands, part by part and in order, in the message or record cited,
        // whatever product-reference category carries it, or nothing is written.
        // A quote the item already carries, on the sources it already cites, is not checked again: its source may have
        // changed since, and the item must still be markable Replaced.
        const quoteKept = previous && sameWords(previous.quote, quote) && previous.sourceIds.every((s) => sourceIds.includes(s));
        if (quote.trim() && !quoteKept) {
          const check = checkVerbatim(store, quote, sourceIds);
          if (check.missing.length) return fail(category === OWNER_WORDS ? ownerWordsRefusal(check) : referenceQuoteRefusal(check));
        }
        // DA (Spec §3.11): an Owner's words quote too short to stand alone comes with the message it answers.
        const answers = text(p.answers).trim() || (previous && quoteKept ? previous.answers ?? '' : '');
        if (category === OWNER_WORDS && quote.trim() && !(quoteKept && !text(p.answers).trim())) {
          const refusal = ownerWordsContextRefusal(store, { quote, answers, sourceIds });
          if (refusal) return fail(refusal);
        }
        const name = text(p.name) || previous?.name || '';
        if (p.foundation === true && category !== 'Area') return fail('foundation marks an Area: a cross-cutting foundation the project’s documents treat as a peer of its modules. Nothing was written.');
        const wholeWhy = absent(p.wholeProductWhy) ? previous?.wholeProductWhy ?? null : redact(text(p.wholeProductWhy)).trim() || null;
        if (has(p.wholeProductWhy) && (category === 'Area' || category === 'Product' || category === 'Goal' || category === 'Plan' || category === OWNER_WORDS)) return fail(`wholeProductWhy says why a decision, boundary, requirement or design concerns the whole product; a ${category} is not placed that way. Nothing was written.`);
        // CJ (CKC-23 AC-21): an item is named as its document names it — `D1 · 做成通用产品…`, not `D1`.
        if (isNumberOnly(text(p.name))) {
          const named = withNumbering(store, (ledger) => numberOnlyRefusal(store, ledger, text(p.name).trim(), sourceIds, 'The name'), null);
          if (named) return fail(named);
        }
        // CZ: a number given as id finds the item; the item's ids change only where the call gives ids itself.
        const itemIds = previous && asNumber ? idsGiven : ids;
        const item: ReferenceItem = {
          // CQ (D104): a Plan's id is what its document names it — a number, or the leading token of its heading (`K`, `Sprint 3`).
          id, projectId: project.id, category, name, ids: itemIds.length ? itemIds : previous?.ids.length ? previous.ids : primary ? [primary] : category === 'Plan' && planIdOf(name) ? [planIdOf(name)!] : [], text: text(p.text) || previous?.text || '', quote: quote || null, basis, validity,
          ...(category === OWNER_WORDS && answers ? { answers: redact(answers) } : {}),
          progress: isOneOf(PROGRESS, p.progress) ? p.progress : previous?.progress ?? null,
          attribution: {
            author: sameAuthor ? previous!.attribution.author : { kind: authorKind, name: text(p.authorName) || (previous && authorKind === previous.attribution.author.kind ? previous.attribution.author.name : null), window: null, host: null, model: null },
            holder: text(p.holderRole).trim() ? { role: text(p.holderRole).trim(), window: null } : previous?.attribution.holder ?? null, identity,
          },
          // CQ (D104): a Plan or Area may be named by the id its document gives it (`K`, `P1`) as well as by its store id.
          sourceIds, refines: absent(p.refines) ? [...(previous?.refines ?? [])] : arr<string>(p.refines).map((r) => referenceByWrittenId(store, text(r))?.id ?? text(r)).filter((r) => store.reference.has(r)),
          // What replaced it stays while the item stays Replaced; a call that changes the validity gives it anew or drops it.
          replacedBy: text(p.replacedBy) || (previous && !validityChanged ? previous.replacedBy : null),
          // Which parts of a decision a later one already took over is the replacement check's finding (§5.5), not
          // anything re-reading the material can see, so re-reading the decision record must not wipe it. The same
          // holds for whether the decision was carried out (§2.2).
          supersededParts: previous?.supersededParts,
          ...(previous?.carryOut ? { carryOut: previous.carryOut } : {}),
          validityByRuleId: validityByRuleId || (previous && !validityChanged ? previous.validityByRuleId ?? null : null),
          ...(previous?.writtenStatus ? { writtenStatus: previous.writtenStatus } : {}),
          ...(category === 'Area' && (typeof p.foundation === 'boolean' ? p.foundation : previous?.foundation) ? { foundation: true } : {}),
          ...(wholeWhy ? { wholeProductWhy: wholeWhy } : {}),
          inputs: p.inputs !== undefined ? inputsOf(ctx, p.inputs, project.name) : previous?.inputs ?? null, asOf: now(), updatedAt: now(),
          // `Update pending` is the program's (update-pending.ts): writing the item does not take in what it waits for.
          ...(previous?.pendingSourceIds?.length ? { pendingSourceIds: previous.pendingSourceIds } : {}), ...(previous?.waitsFor ? { waitsFor: previous.waitsFor } : {}),
        };
        // CQ (D104): what this write does with the program's Inferred placements of this item — a refines list given whole
        // that keeps the target makes it the Keeper's own (confirmed); one that drops it replaces it (moved).
        const replacedInferred = previous && !absent(p.refines) && programTargetsOf(store, 'reference', id).length
          ? noteOverride(store, 'reference', id, { targets: item.refines, kept: (target) => (item.refines.includes(target) ? 'rewritten' : 'gone') }, { jobId: ctx.jobId, roundId: ctx.step?.roundId ?? null })
          : [];
        store.reference.put(item, trace(`${previous ? `Reference item updated: ${name}` : `Reference item: ${name}`}${replacedInferred.length ? ` (replaced the program's Inferred placement on ${replacedInferred.join('; ')})` : ''}`, [...sourceIds, ...(validityByRuleId ? store.rules.get(validityByRuleId)!.sourceIds : [])]));
        saved('reference', id, `Reference: ${category} ${name}`);
        // D101 (CM): once an Area exists, everything that names it in the project's own writing is placed again in this
        // pass — a new Area, one renamed, one newly marked as the cross-cutting foundation.
        let placedAgain: { count: number; items: string[] } | null = null;
        if (category === 'Area' && validity === 'Current' && (!previous || previous.name !== name || (item.foundation === true && previous.foundation !== true))) {
          const moved = placeAgain(store, item, (summary) => trace(summary, sourceIds));
          for (const m of moved) saved(m.kind === 'thread' ? 'threads' : 'reference', m.id, `Placed on ${name}`);
          if (moved.length) placedAgain = { count: moved.length, items: moved.slice(0, 40).map((m) => `${m.name.slice(0, 70)} — ${m.how}`) };
        }
        const warning = referenceWarning(store, item);
        return ok({ id, merged: Boolean(match), ...(warning ? { warning } : {}), ...(placedAgain ? { placedAgain } : {}), ...(replacedInferred.length ? { replacedInferred, note: 'This write replaced a placement the program had inferred; the round record keeps both.' } : {}) });
      },
    }),
    defineTool({
      name: 'pk_relate', label: 'Write relation',
      description: 'Create or update a graph relation between two assets (reference item, thread, fact record, change, source): type, the claim the material makes, basis, evidence (source ids, fact record ids, how far the facts go). A relation is its type, fromId and toId: writing the same three again updates it, and what the call leaves out keeps its value. A new relation needs claim and basis. Assessment stays Not assessed until a product re-look judges it. withdraw: true takes a relation back — one you wrote, or one the fill wrote from a table cell that the document does not state (a “depends on” read out of a qualified clause) — with why; the relation is removed and the withdrawal is kept in the record.',
      parameters: Type.Object({
        type: Type.String(), fromId: Type.String(), toId: Type.String(),
        withdraw: Type.Optional(Type.Boolean({ description: 'true: take this relation back (type, fromId, toId name it); needs why' })),
        why: Type.Optional(Type.String({ description: 'withdraw: why the relation does not hold — what the document actually says' })),
        claim: Type.Optional(Type.String({ description: 'the claim the material makes; a new relation needs it, an update keeps it when left out' })),
        basis: Type.Optional(Type.String({ description: 'Explicit | Inferred — a new relation needs it' })),
        evidenceSourceIds: Type.Optional(StrArr), evidenceFactRecordIds: Type.Optional(StrArr), factsSoFar: Type.Optional(Type.String()),
      }),
      execute: async (_id, raw) => {
        // A work item merged into another is reached through the one kept (§1.4).
        const p = { ...raw, fromId: resolveMergedId(store, raw.fromId), toId: resolveMergedId(store, raw.toId) };
        if (!isOneOf(RELATION_TYPE, p.type)) return fail(`type must be one of ${RELATION_TYPE.join(', ')}`);
        if (has(p.basis) && !isOneOf(BASIS, p.basis)) return fail('basis must be Explicit or Inferred');
        // CZ: a relation written wrongly can be taken back — by the job that wrote it, or the one correcting a fill.
        if (p.withdraw === true) {
          const why = text(p.why).trim();
          const standing = store.relations.get(stableId('rel', p.type, p.fromId, p.toId));
          if (!standing) return fail(`There is no ${p.type} relation from ${p.fromId} to ${p.toId} to withdraw. Nothing changed.`);
          if (!why) return fail('why: why this relation does not hold — what the document actually says. Nothing changed.');
          if (p.type === 'carries out') return fail('A carries out relation is written with the decision’s carry-out record: correct it with pk_record_carry_out, which keeps the two together. Nothing changed.');
          const id = standing.id;
          store.relations.remove(id, trace(`Relation ${p.type} withdrawn: ${p.fromId} → ${p.toId} (“${standing.claim.slice(0, 120)}”) — ${why}`, standing.evidence.sourceIds));
          saved('relations', id, `Relation ${p.type} withdrawn`);
          return ok({ id, withdrawn: true });
        }
        const exists = (id: string) => store.reference.has(id) || store.threads.has(id) || store.facts.has(id) || store.changes.has(id) || store.sources.has(id) || store.areas.has(id) || store.nodes.has(id);
        if (!exists(p.fromId) || !exists(p.toId)) return fail('fromId and toId must be existing asset ids');
        const historyEnd = relationEndpointHistoryRefusal(store, p.fromId, p.toId);
        if (historyEnd) return fail(historyEnd);
        if (p.type === 'carries out' && !isDecision(store, p.toId)) {
          return fail(`carries out ends at a decision that asks for something to be done; ${p.toId} is ${store.reference.get(p.toId) ? `a ${store.reference.get(p.toId)!.category}` : 'not a decision'}. To say a decision was carried out, use pk_record_carry_out, which writes these relations with it.`);
        }
        const id = stableId('rel', p.type, p.fromId, p.toId);
        const previous = store.relations.get(id);
        if (!previous) {
          const missing = (['claim', 'basis'] as const).filter((f) => absent(p[f]));
          if (missing.length) throw createNeeds('a relation', `There is no ${p.type} relation from ${p.fromId} to ${p.toId} yet`, missing, `To update a relation, give the type, fromId and toId it has.`);
        }
        const relation: GraphRelation = {
          id, projectId: project.id, type: p.type, from: p.fromId, to: p.toId, claim: text(p.claim) || previous?.claim || '', basis: (has(p.basis) ? p.basis : previous!.basis) as GraphRelation['basis'],
          evidence: {
            sourceIds: absent(p.evidenceSourceIds) ? [...(previous?.evidence.sourceIds ?? [])] : arr<string>(p.evidenceSourceIds),
            factRecordIds: absent(p.evidenceFactRecordIds) ? [...(previous?.evidence.factRecordIds ?? [])] : arr<string>(p.evidenceFactRecordIds),
            factsSoFar: absent(p.factsSoFar) ? previous?.evidence.factsSoFar ?? '' : text(p.factsSoFar),
          },
          assessment: previous?.assessment ?? 'Not assessed', assessedAt: previous?.assessedAt ?? null, assessedInJobId: previous?.assessedInJobId ?? null, updatedAt: now(),
        };
        const warning = relationWarning(store, p.type, p.fromId, p.toId);
        store.relations.put(relation, trace(`Relation ${p.type}: ${p.fromId} → ${p.toId}`, relation.evidence.sourceIds));
        saved('relations', id, `Relation ${p.type}`);
        return ok(warning ? { id, warning } : { id });
      },
    }),
    defineTool({
      name: 'pk_write_change', label: 'Write change record',
      description: 'Record one piece of work and its net changes. A piece of work is one session or one execution, together with the files it changed and the commits it made; it gets one record, however many files it touched. The record lists that work’s items: one per net change, each with its own material category, effect (Added, Approved, Replaced, Deferred, Abandoned, Completed, Corrected), before/after, basis and affects — the objects that item directly changed, which is its subject. Restating, re-reading, checking a dependency, re-reading after a compaction, recalling from memory, changing something and changing it back, and wording, formatting or version-number changes are not changes and are refused. Calling this twice for the same piece of work — the same id, or the same piece of work — adds to the one record: an update gives only what it changes, and what it leaves out keeps its value (sourceIds are added to the record’s; the piece of work’s fields left out stay as they are; a call with no item changes only the record’s own fields). A new record needs sourceIds and its items.',
      parameters: Type.Object({
        id: Type.Optional(Type.String()),
        workKind: Type.Optional(Type.String({ description: 'Session | Execution | Time range — how this piece of work was cut out. Time range when the changes have no session' })),
        workLabel: Type.Optional(Type.String({ description: 'which session or execution, or how the time range was cut' })),
        workSessionId: Type.Optional(Type.String()),
        workStartedAt: Type.Optional(Type.String({ description: 'ISO time this piece of work began, or its date when the material gives only the day' })),
        workEndedAt: Type.Optional(Type.String({ description: 'ISO time it ended, or its last pause when it was still running at the start of this round; its date when the material gives only the day' })),
        workOpenEnded: Type.Optional(Type.Boolean({ description: 'true when the work was still going: what came after belongs to the next round’s record' })),
        sourceIds: Type.Optional(Type.Array(Type.String(), { description: 'the files this piece of work changed, its commits and its session segments; a new record needs them, and an update adds them to the record’s' })),
        items: Type.Optional(Type.Array(Type.Object({
          at: Type.String({ description: 'the time from the material, at its precision: a date (2026-09-17) stays a date; an ISO time when the material gives the clock' }), atFromMaterial: Type.Optional(Type.Boolean()),
          material: Type.String(), effect: Type.String(), title: Type.String(), summary: Type.String(),
          before: Type.Optional(Type.String()), after: Type.Optional(Type.String()), sourceIds: Type.Optional(StrArr),
          byOwner: Type.Optional(Type.Boolean()), byName: Type.Optional(Type.String()),
          why: Type.Optional(Type.String({ description: 'why it was changed, in the material’s own terms (the owner asked, a trial showed the old shape failed, a contract required it); leave out when the material gives no reason' })),
          affects: Type.Optional(Type.Array(Type.String(), { description: 'the objects this item directly changed — its subject' })),
        }), { description: 'this piece of work’s net changes, one entry each' })),
        at: Type.Optional(Type.String()), atFromMaterial: Type.Optional(Type.Boolean()), material: Type.Optional(Type.String()), effect: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()), summary: Type.Optional(Type.String()), before: Type.Optional(Type.String()), after: Type.Optional(Type.String()),
        byOwner: Type.Optional(Type.Boolean()), byName: Type.Optional(Type.String()), affects: Type.Optional(StrArr),
        segmentName: Type.Optional(Type.String()), segmentSourceId: Type.Optional(Type.String()),
      }),
      execute: async (_id, p) => {
        const sourcesGiven = !absent(p.sourceIds);
        const callSources = arr<string>(p.sourceIds).filter((s) => store.sources.has(s));
        if (sourcesGiven && callSources.length === 0) return fail('a change record needs at least one existing source: the files this piece of work changed, its commits, and the session segments it happened in');
        // One record per piece of work: its identity, not the item's, decides where the items land. A call naming the
        // record by id gives only what changes of its piece of work; the fields it leaves out stay as recorded.
        const named = text(p.id) ? store.changes.get(text(p.id)) : undefined;
        const recorded: Record<string, unknown> = named?.work ? { workKind: named.work.kind, workLabel: named.work.label, workSessionId: named.work.sessionId ?? '', workStartedAt: named.work.startedAt, workEndedAt: named.work.endedAt, workOpenEnded: named.work.openEnded } : {};
        const workFields = ['workKind', 'workLabel', 'workSessionId', 'workStartedAt', 'workEndedAt', 'workOpenEnded'] as const;
        const work = workSegmentOf({ ...recorded, ...Object.fromEntries(workFields.filter((f) => !absent(p[f])).map((f) => [f, p[f]])) });
        if (typeof work === 'string') return fail(work);
        // Work that takes the project over belongs to no Follow up round, so no round's start cuts its pieces of work.
        const round = isTakeoverWork(store, ctx.jobId) ? null : openRound(store);
        if (work && round && work.endedAt > round.startedAt) {
          return fail(`A piece of work never spans two Follow up rounds. This one is recorded as running until ${work.endedAt}, after round ${round.number} began at ${round.startedAt}. Organize it only up to its last pause before ${round.startedAt}, give that time as workEndedAt with workOpenEnded: true, and leave the rest for the next round.`);
        }
        // Each entry the caller gave, or the flat fields read as this work's single item; an update may give none.
        const raw = arr<Record<string, unknown>>(p.items);
        const flat = (['at', 'atFromMaterial', 'material', 'effect', 'title', 'summary', 'before', 'after', 'byOwner', 'byName', 'affects'] as const).some((f) => !absent(p[f]));
        const given = raw.length ? raw : flat ? [{ at: p.at, atFromMaterial: p.atFromMaterial, material: p.material, effect: p.effect, title: p.title, summary: p.summary, before: p.before, after: p.after, sourceIds: callSources, why: undefined, byOwner: p.byOwner, byName: p.byName, affects: p.affects }] : [];
        const recordId = text(p.id) || (work
          ? stableId('chg', project.id, work.kind, work.sessionId || work.label, work.startedAt)
          : stableId('chg', project.id, text(given[0]?.effect), text(given[0]?.title), ...callSources));
        const previous = store.changes.get(recordId);
        if (!previous) {
          const missing = [...(sourcesGiven ? [] : ['sourceIds']), ...(given.length ? [] : ['items'])];
          if (missing.length) {
            const why = text(p.id) ? `${text(p.id)} is no change record of the assets` : work ? `No change record covers the piece of work “${work.label}” (${work.kind}, from ${work.startedAt})` : 'This call names no existing change record (no id, and no piece of work to find one by)';
            throw createNeeds('a change record', why, missing, 'To add to the record of a piece of work, give its id, or the piece of work (workKind, workLabel or workSessionId, workStartedAt) as it was recorded; items are the work’s net changes, or one item’s material, effect, title and summary given flat.');
          }
        }
        // What the items rest on when they name nothing of their own: the call's sources, or the record's.
        const sourceIds = callSources.length ? callSources : [...(previous?.sourceIds ?? [])];
        if (given.length === 0) {
          // An update with no item changes the record's own fields — its piece of work, its segment, its sources.
          const record: ChangeRecord = {
            ...previous!, title: work ? work.label || previous!.title : previous!.title,
            sourceIds: [...new Set([...previous!.sourceIds, ...callSources])], work: work ?? previous!.work ?? null,
            segment: p.segmentName && p.segmentSourceId ? { name: p.segmentName, sourceId: p.segmentSourceId } : previous!.segment ?? null, updatedAt: now(),
          };
          store.changes.put(record, trace(`Change record updated${record.work ? ` (${record.work.kind}: ${record.work.label})` : ''}`, record.sourceIds));
          saved('changes', recordId, `Change record: ${record.title}`);
          return ok({ id: recordId, items: itemsOf(record).length, affects: record.affects, updated: true });
        }
        const built: ChangeItem[] = [];
        const notedAffects: number[] = [];
        for (const [i, r] of given.entries()) {
          if (!isOneOf(CHANGE_MATERIAL, r.material)) return fail(`items[${i}].material must be one of ${CHANGE_MATERIAL.join(', ')}`);
          if (!isOneOf(CHANGE_EFFECT, r.effect)) return fail(`items[${i}].effect must be one of ${CHANGE_EFFECT.join(', ')}`);
          // §1.8 (CKC-02 AC-27): the time keeps the precision the material gives — a date stays a date, never a midnight.
          const at = normalizeMaterialTime(text(r.at) || work?.startedAt || '');
          if (!at) return fail(`items[${i}].at must be the time the material gives: a date (2026-09-17), which stays a date, or an ISO time when the material gives the clock`);
          const itemSources = arr<string>(r.sourceIds).filter((s) => store.sources.has(s));
          const named = [...new Set(arr<string>(r.affects).map((a) => resolveMergedId(store, a)))].filter((a) => objectExists(store, a));
          const derived = named.length === 0 ? affectsFromSources(store, itemSources.length ? itemSources : sourceIds) : [];
          if (derived.length) notedAffects.push(i);
          built.push({
            id: stableId('item', recordId, r.effect, text(r.title)), at,
            atSource: r.atFromMaterial === false ? 'observed' : 'material', material: r.material, effect: r.effect,
            title: text(r.title), summary: text(r.summary), before: text(r.before) || null, after: text(r.after) || null,
            sourceIds: itemSources.length ? itemSources : sourceIds, why: text(r.why) || null,
            by: r.byOwner === true
              ? { author: { kind: 'owner', name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' }
              : { author: { kind: r.byName ? 'role' : 'unknown', name: text(r.byName) || null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' },
            affects: named.length ? named : derived,
          });
        }
        // §1.8: what is recorded is the net change. Two items of this work that undo each other cancel; an item
        // that is only a restatement, a wording change or a version bump is refused with what it would duplicate.
        const refusals: string[] = [];
        const undone = new Set(undonePairs(built).flat());
        for (const i of undone) refusals.push(`item ${i + 1} (“${built[i]!.title}”) — Changed and changed back: ${NOT_A_CHANGE_ADVICE['Changed and changed back']}`);
        const kept = built.filter((item, i) => {
          if (undone.has(i)) return false;
          const why = notAChange(store, item, recordId);
          if (!why) return true;
          refusals.push(`item ${i + 1} (“${item.title}”) — ${why}: ${NOT_A_CHANGE_ADVICE[why]}`);
          return false;
        });
        if (kept.length === 0) {
          const nothing = `A piece of work with no net change gets no change record. Nothing here is a change: ${refusals.join('; ')}. The facts still belong in the fact record of the material.`;
          return previous ? fail(nothing) : fail(nothing);
        }
        const items = previous?.items?.length
          ? [...previous.items.filter((old) => !kept.some((k) => k.id === old.id)), ...kept].sort((a, b) => a.at.localeCompare(b.at))
          : kept.sort((a, b) => a.at.localeCompare(b.at));
        const head = items[0]!;
        const affects = [...new Set(items.flatMap((i) => i.affects))];
        const record: ChangeRecord = {
          id: recordId, projectId: project.id, at: head.at, atSource: head.atSource, material: head.material,
          effect: head.effect, title: work ? work.label || head.title : head.title,
          summary: items.length > 1 ? items.map((i) => `${i.effect}: ${i.title}`).join('; ') : head.summary,
          before: head.before, after: head.after,
          sourceIds: [...new Set([...(previous?.sourceIds ?? []), ...sourceIds, ...items.flatMap((i) => i.sourceIds)])],
          by: head.by, affects,
          // A subject is not downstream of its own item, so nothing starts here: the downstream is found from the
          // relations by rule, and objects §2.10 never judges are listed apart instead.
          propagation: previous?.propagation ?? [],
          notJudged: previous?.notJudged ?? [],
          work: work ?? previous?.work ?? null, items,
          segment: p.segmentName && p.segmentSourceId ? { name: p.segmentName, sourceId: p.segmentSourceId } : previous?.segment ?? null,
          createdInJobId: previous?.createdInJobId ?? ctx.jobId, updatedAt: now(),
        };
        store.changes.put(record, trace(`Change record${work ? ` (${work.kind}: ${work.label})` : ''}: ${items.length} item${items.length === 1 ? '' : 's'}`, record.sourceIds));
        saved('changes', recordId, `Change record: ${record.title}`);
        const warnings = [...refusals];
        // A change nobody can trace to an asset cannot be followed up, and the workbench cannot star what it touched.
        if (affects.length === 0) warnings.push('No item names an object it changed, and nothing could be worked out from the material cited: name in each item’s affects the ids of the objects it touched (the replaced item and the one replacing it, the work item whose work changed, the area or requirement it constrains). Leave it empty only when the changed object is not an asset yet.');
        else if (notedAffects.length) warnings.push(`Item(s) ${notedAffects.map((i) => i + 1).join(', ')} named no affected object, so it was taken from what the cited material formed. Name them yourself when the item changed something else.`);
        return ok(warnings.length ? { id: recordId, items: items.length, affects, warnings } : { id: recordId, items: items.length, affects });
      },
    }),
    defineTool({
      name: 'pk_write_mark', label: 'Write entry mark',
      description: 'Attach a mark to an asset: Suspected stale, Undocumented decision, Layer drift, Scope question, Disposal (a leftover of an Abandoned direction: a document, code area, branch, worktree, config or process), Decided without owner (a rule or decision in force that a role set in the owner’s place — say who set it and when in decidedBy and decidedAt; it hangs on the product reference item or project rule itself, which stays Current and is not the owner’s Decision). Every mark says what differs (clue) and names the material it was checked against (clueSourceIds): a mark with neither is never shown to an agent, so it is refused. A mark never hangs on another mark or on a note, and a point-in-time record does not get Suspected stale or Layer drift because of something that happened later — that belongs on the current object still using the old content. The same kind on the same target is the same mark: writing it again updates it, and what the call leaves out keeps its value. A new mark needs clue and clueSourceIds.',
      parameters: Type.Object({
        kind: Type.String(), targetId: Type.String(),
        clue: Type.Optional(Type.String({ description: 'what differs, in one sentence; a new mark needs it' })),
        clueSourceIds: Type.Optional(Type.Array(Type.String(), { description: 'the material it was checked against; a new mark needs it' })),
        about: Type.Optional(Type.String({ description: `${MARK_ABOUT.join(' | ')} — only for a mark on a point-in-time record: "At its own time" means you doubt the record was true when it was written` })),
        decidedBy: Type.Optional(Type.String({ description: 'Decided without owner only: the role or agent that set it' })),
        decidedAt: Type.Optional(Type.String({ description: 'Decided without owner only: when it was set, as the material gives it (a date stays a date)' })),
      }),
      execute: async (_id, raw) => {
        const p = { ...raw, targetId: resolveMergedId(store, raw.targetId) };
        if (!isOneOf(MARK_KIND, p.kind)) return fail(`kind must be one of ${MARK_KIND.join(', ')}`);
        const id = stableId('mark', p.kind, p.targetId);
        const previous = store.marks.get(id);
        if (!previous) {
          const missing = (['clue', 'clueSourceIds'] as const).filter((f) => absent(p[f]));
          if (missing.length) throw createNeeds('a mark', `${p.targetId} has no ${p.kind} mark yet`, missing, 'To update a mark, give the kind and targetId it has.');
        }
        const clueSourceIds = absent(p.clueSourceIds) ? [...previous!.clueSourceIds] : arr<string>(p.clueSourceIds);
        const clue = text(p.clue) || previous?.clue || '';
        // What a mark was checked against has to be material an agent can read: a pack cites it and prints the mark as
        // checked (Spec §7.1; CKC-12 AC-32). An id that is not a source dropped out of the citation, and the mark still read
        // as checked (QC AH #14).
        const unknownClues = clueSourceIds.filter((id) => !store.sources.has(id));
        if (unknownClues.length) return fail(`clueSourceIds names what is not a source of this project: ${unknownClues.join(', ')}. Name the material the mark was checked against by its source id (src_…; pk_list_sources finds them), so the pack can cite it and an agent can read it.`);
        const about = isOneOf(MARK_ABOUT, p.about) ? (p.about as MarkAbout) : null;
        if (text(p.about) && !about) return fail(`about must be one of ${MARK_ABOUT.join(', ')}`);
        if (p.kind === 'Disposal') {
          if (clueSourceIds.length === 0) return fail('Disposal needs the source of the Abandoned direction it is left over from');
          if (!store.reference.find((r) => r.validity === 'Abandoned') && !store.threads.find((t) => t.validity === 'Abandoned')) return fail('Disposal is only allowed when an Abandoned direction with a source exists; record the abandonment first');
        }
        // §1.9 (D63): what a role set in the owner's place and is in force now, with who set it and when.
        let decidedBy: { who: string; at: string } | null = null;
        if (p.kind === 'Decided without owner') {
          const targetRefusal = decidedWithoutOwnerRefusal(store, p.targetId);
          if (targetRefusal) return fail(targetRefusal);
          const who = text(p.decidedBy).trim() || previous?.decidedBy?.who || '';
          const when = text(p.decidedAt).trim() || previous?.decidedBy?.at || '';
          if (!who || !when) return fail('Decided without owner says who set it and when: add decidedBy — the role or agent that set it — and decidedAt — when, as the material gives it (a date stays a date). The context lists it under Pending owner decisions with exactly that.');
          const at = normalizeMaterialTime(when);
          if (!at) return fail(`decidedAt must be when it was set, as the material gives it: a date (2026-09-17) or an ISO time. “${when}” is neither.`);
          decidedBy = { who, at };
        }
        const refusal = markRefusal(store, p.kind, p.targetId, clue, clueSourceIds, about);
        if (refusal) return fail(refusal);
        // Written again, the doubt is open again; what else the mark carries — which of the six things it is — stays.
        const mark: EntryMark = { ...previous, id, projectId: project.id, kind: p.kind, targetId: p.targetId, clueSourceIds, clue, since: previous?.since ?? now(), noteId: previous?.noteId ?? null, closed: null, ...(decidedBy ? { decidedBy } : {}) };
        store.marks.put(mark, trace(`Mark ${p.kind} on ${p.targetId}`, clueSourceIds));
        saved('marks', id, `Mark: ${p.kind}`);
        return ok(previous ? { id, updated: true, note: 'The mark that was already there had its clue updated; the same doubt does not become a second mark.' } : { id });
      },
    }),
    defineTool({
      name: 'pk_write_note', label: 'Write Keeper note',
      description: 'Write or update a note (interpretation, never a decision): mount (project — the whole project, mountIds empty | node | path — ids of objects in the assets | relation — relation ids), title, short preview, body sections (only those with content), what the owner is asked to do (For your decision | Worth discussing | For information), and the judgement record id from pk_record_judgement. Updating (the id of an existing note) creates a new version; give the reason. A note that says something has no follow-up, was let pass or was taken up by nobody carries what was read (looked: where, and up to when). An update keeps the note’s mount and gives only what changes: what the new version leaves out is taken from the version before. A new note needs mountKind, mountIds, title, preview and ask. A note from a change follow-up names the change or changes it is about in changeIds. A note about a code territory’s anomaly (residual code, code nobody claims, docs that disagree with the code) hangs on the area the territory serves or the work that built it, and names the anomaly in codeAnomalies — { territoryId, index } — so the anomaly in Code opens the note.',
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: 'the note to update' })),
        mountKind: Type.Optional(Type.String({ description: 'project | node | path | relation — a new note needs it; an update keeps its mount' })),
        mountIds: Type.Optional(Type.Array(Type.String(), { description: 'a new note needs them (empty for the whole project); an update keeps its mount' })),
        title: Type.Optional(Type.String()), preview: Type.Optional(Type.String()), ask: Type.Optional(Type.String({ description: `${NOTE_ASK.join(' | ')} — a new note needs it` })),
        currentView: Type.Optional(Type.String()), whyItMatters: Type.Optional(Type.String()), facts: Type.Optional(Type.Array(Type.Object({ text: Type.String(), sourceIds: StrArr, inferred: Type.Boolean() }))),
        otherExplanations: Type.Optional(Type.String()), keepAdjust: Type.Optional(Type.String()), whatWouldSettleIt: Type.Optional(Type.String()), judgementRecordId: Type.Optional(Type.String()), reason: Type.String(), language: Type.Optional(Type.String()),
        options: Type.Optional(Type.Array(Type.Object({
          option: Type.String({ description: 'the choice, in a few plain words' }),
          then: Type.String({ description: 'what follows from choosing it: what is changed and where' }),
        }), { description: 'a For your decision note: the owner’s options, at least two, one per choice — leaving it alone is one too. Its preview opens with the question.' })),
        changeIds: Type.Optional(StrArr),
        looked: Type.Optional(Type.Object({
          where: Type.Array(Type.String(), { description: 'each place you read for what came after, as the spot-check can open it again: a file with its section or lines, a ledger query, a commit range, a session' }),
          upTo: Type.String({ description: 'up to when your reading reaches: the date or time (2026-09-30, 2026-09-30T19:53Z) of the newest commit, document version or report you read' }),
          sessionsUpTo: Type.Optional(Type.String({ description: 'when sessions were read: the time of the last session message you read' })),
        }, { description: 'a note that says something has no follow-up, was let pass or was taken up by nobody carries what was read: where you looked for what came after, and up to when. In a round such a note is refused without it. When the look stops before the ledger’s newest session or commit, the note opens with “As far as read — …”' })),
        codeAnomalies: Type.Optional(Type.Array(Type.Object({
          territoryId: Type.String({ description: 'the code territory' }),
          index: Type.Optional(Type.Number({ description: 'which of its anomalies, counted from 0 (may be left out when it has one)' })),
        }), { description: 'the code-territory anomalies this note is about: each one opens the note from Code' })),
      }),
      execute: async (_id, p) => {
        const previous = text(p.id) ? store.notes.get(text(p.id)) : undefined;
        if (!previous) {
          const missing = (['mountKind', 'mountIds', 'title', 'preview', 'ask'] as const).filter((f) => absent(p[f]));
          if (missing.length) throw createNeeds('a note', text(p.id) ? `${text(p.id)} is no note of the assets` : 'This call names no note to update (no id)', missing, 'To update a note, give its id: the new version takes what it leaves out from the version before, and the note keeps its mount.');
        }
        // What the new version leaves out is the version before's.
        const last = previous?.versions[previous.versions.length - 1];
        const ask = has(p.ask) ? text(p.ask) : last?.ask ?? '';
        if (!isOneOf(NOTE_ASK, ask)) return fail(`ask must be one of ${NOTE_ASK.join(', ')}`);
        if (!previous && !['project', 'node', 'relation', 'path'].includes(text(p.mountKind))) return fail('mountKind must be project | node | relation | path');
        const judgementRecordId = text(p.judgementRecordId) || ctx.judgementId || last?.judgementRecordId || '';
        if (!store.judgements.has(judgementRecordId)) return fail('judgementRecordId must be an existing judgement record (call pk_record_judgement first)');
        const anomalies = noteAnomalyTargets(store, arr<Record<string, unknown>>(p.codeAnomalies));
        if (typeof anomalies === 'string') return fail(`${anomalies} Nothing was written.`);
        // An update keeps the mount it had; a new note's mount must name what is in the assets (owner 2026-09-22).
        // A work item merged into another is reached through the one kept (§1.4).
        const mountIds = previous ? [...previous.mount.ids] : [...new Set(arr<string>(p.mountIds).map((id) => resolveMergedId(store, id)))];
        if (!previous) {
          const mountRefusal = noteMountRefusal(store, text(p.mountKind), mountIds);
          if (mountRefusal) return fail(mountRefusal);
        }
        const kept = (v: unknown, before: string | null | undefined): string | null => text(v) || before || null;
        const title = text(p.title) || last?.title || '';
        const preview = text(p.preview) || last?.preview || '';
        const body: NoteBody = {
          currentView: kept(p.currentView, last?.body.currentView), whyItMatters: kept(p.whyItMatters, last?.body.whyItMatters),
          facts: absent(p.facts) ? [...(last?.body.facts ?? [])] : arr<Record<string, unknown>>(p.facts).map((f) => ({ text: text(f.text), sourceIds: arr<string>(f.sourceIds), inferred: f.inferred === true })),
          otherExplanations: kept(p.otherExplanations, last?.body.otherExplanations), keepAdjust: kept(p.keepAdjust, last?.body.keepAdjust), whatWouldSettleIt: kept(p.whatWouldSettleIt, last?.body.whatWouldSettleIt),
          // Options belong to a note the owner is asked to decide (§4.2): another note carries none.
          ...(ask === 'For your decision' ? { options: absent(p.options) ? [...(last?.body.options ?? [])] : arr<Record<string, unknown>>(p.options).map((o) => ({ option: text(o.option).trim(), then: text(o.then).trim() })) } : {}),
        };
        const noteRefusal = noteRefusalFor(store, {
          id: text(p.id), mountIds, changeIds: arr<string>(p.changeIds), ask, title,
          preview, whyItMatters: body.whyItMatters ?? '', whatWouldSettleIt: body.whatWouldSettleIt ?? '',
        });
        if (noteRefusal) return fail(noteRefusal);
        // The form the owner reads it in (D105; CKC-08 AC-26, AC-27): no internal identifiers anywhere in it, and a
        // For your decision note opens with the question and gives the options. Checked here, so it costs one retry
        // and no attention up front; the whole version is checked, also what it takes from the version before.
        const formRefusal = noteFormRefusal({
          ask, title, preview, options: body.options ?? [],
          body: { currentView: body.currentView, whyItMatters: body.whyItMatters, ...Object.fromEntries(body.facts.map((f, i) => [`facts[${i}]`, f.text])), otherExplanations: body.otherExplanations, keepAdjust: body.keepAdjust, whatWouldSettleIt: body.whatWouldSettleIt },
        }, laneNamesOf(store), previous ? `Write the version again (pk_write_note with id "${previous.id}") with every part named above given anew` : 'Write it again');
        if (formRefusal) return fail(formRefusal);
        // CN (E152; Spec §2.12): a note that says something has no follow-up, was let pass or was taken up by nobody
        // carries what was read — where, and up to when. In a round the claim is refused without it; a look that stops
        // before the ledger's newest session or commit is said on the line everyone reads.
        let looked = previous?.looked ?? null;
        if (!absent(p.looked)) {
          const given = parseLooked(p.looked);
          if (typeof given === 'string') return fail(`${given} Nothing was written.`);
          looked = lookedRecord(given, presentOf(store), { roundId: ctx.step?.roundId ?? null, jobId: ctx.jobId, at: now() });
        }
        const claims = absenceClaims([title, preview, body.currentView ?? '', body.whyItMatters ?? '', ...body.facts.map((f) => f.text)].join('\n'));
        if (ctx.step?.roundId && claims.length && !looked) return fail(absenceRefusal(`The note “${title}”`, claims));
        const said = stampAsFarAs(preview, claims.length || !absent(p.looked) ? looked : null);
        const id = text(p.id) || newId('note');
        const version = { version: (previous?.versions.length ?? 0) + 1, at: now(), title, preview: said, body, ask: ask as Note['versions'][number]['ask'], judgementRecordId: judgementRecordId, reason: p.reason };
        const note: Note = previous
          ? { ...previous, versions: [...previous.versions, version], status: 'Current', ...(looked ? { looked } : {}), updatedAt: now() }
          : { ...(looked ? { looked } : {}), id, projectId: project.id, mount: { kind: text(p.mountKind) as Note['mount']['kind'], ids: mountIds }, status: 'Current', ownerResponse: null, versions: [version], discussion: [], followUps: [], author: { agent: 'pi', model: ctx.model }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, cameFrom: cameFromFor(store, ctx.jobId ? store.jobs.get(ctx.jobId) : undefined, mountIds, { given: arr<string>(p.changeIds) }), language: text(p.language, project.language), updatedAt: now() };
        store.notes.put(note, trace(previous ? `Note v${version.version}: ${title}` : `Note: ${title}`, body.facts.flatMap((f) => f.sourceIds)));
        const j = store.judgements.get(judgementRecordId)!;
        store.judgements.put({ ...j, outcome: { ...j.outcome, noteIds: [...new Set([...j.outcome.noteIds, id])] } });
        // The anomalies it is about carry the note, so Code jumps from each to it (§6.17; QC AY B6: noteIds were never written).
        for (const territoryId of [...new Set(anomalies.map((a) => a.territoryId))]) {
          const t = store.territories.get(territoryId)!;
          const indexes = new Set(anomalies.filter((a) => a.territoryId === territoryId).map((a) => a.index));
          if ([...indexes].every((i) => t.anomalies[i]!.noteIds.includes(id))) continue;
          store.territories.put({ ...t, anomalies: t.anomalies.map((a, i) => (indexes.has(i) && !a.noteIds.includes(id) ? { ...a, noteIds: [...a.noteIds, id] } : a)), updatedAt: now() }, trace(`Note “${title}” on ${t.name}: ${[...indexes].map((i) => t.anomalies[i]!.kind).join(', ')}`));
          saved('territories', t.id, `Note on ${t.name}`);
        }
        saved('notes', id, `Note: ${title}`);
        return ok({
          id, version: version.version, ...(anomalies.length ? { codeAnomalies: anomalies.length } : {}),
          ...(looked && (claims.length || !absent(p.looked)) ? { looked: lookedLine(looked) } : {}),
          ...(looked?.behind && said.startsWith(`[${AS_FAR_AS}`) ? { asFarAs: `Your look does not reach the present of the ledger (${looked.behind}), so the note opens with “${AS_FAR_AS} — …”. Word the claim as “as far as … read”, not as a bare “no follow-up”; read the rest and give looked again to take the opening off.` } : {}),
        });
      },
    }),
    defineTool({
      name: 'pk_record_judgement', label: 'Record judgement inputs',
      description: 'Record what this product re-look received as input (reference items, threads, areas, relations, key evidence sources, conflicting sources, previous notes, investigation conclusions) and what was deliberately excluded. Call it once before writing notes or assessments; returns the judgement record id.',
      parameters: Type.Object({ scopeKind: Type.String(), scopeIds: StrArr, scopeLabel: Type.String(), referenceIds: StrArr, threadIds: StrArr, areaIds: StrArr, relationIds: StrArr, keyEvidenceSourceIds: StrArr, conflictingSourceIds: StrArr, previousNoteIds: StrArr, investigations: Type.Optional(Type.Array(Type.Object({ jobId: Type.String(), conclusion: Type.String(), sourceIds: StrArr }))), excluded: StrArr, reconsideredOnly: Type.Optional(Type.Boolean()) }),
      execute: async (_id, p) => {
        const id = newId('jdg');
        store.judgements.put({ id, projectId: project.id, jobId: ctx.jobId, at: now(), scope: { kind: p.scopeKind, ids: arr<string>(p.scopeIds), label: p.scopeLabel }, inputs: { referenceIds: arr(p.referenceIds), threadIds: arr(p.threadIds), areaIds: arr(p.areaIds), relationIds: arr(p.relationIds), keyEvidenceSourceIds: arr(p.keyEvidenceSourceIds), conflictingSourceIds: arr(p.conflictingSourceIds), previousNoteIds: arr(p.previousNoteIds), investigations: arr<Record<string, unknown>>(p.investigations).map((i) => ({ jobId: text(i.jobId), conclusion: text(i.conclusion), sourceIds: arr<string>(i.sourceIds) })) }, excluded: arr(p.excluded), outcome: { noteIds: [], assessments: [], reconsideredOnly: p.reconsideredOnly === true } }, trace(`Judgement inputs recorded for ${p.scopeLabel}`));
        saved('judgements', id, `Judgement record: ${p.scopeLabel}`);
        return ok({ id });
      },
    }),
    defineTool({
      name: 'pk_assess_relation', label: 'Assess relation',
      description: 'Set the Keeper assessment of a relation after a product re-look: Holds, Questioned (needs a note explaining why) or Not assessed. Requires the judgement record id.',
      parameters: Type.Object({ relationId: Type.String(), assessment: Type.String(), judgementRecordId: Type.Optional(Type.String({ description: 'defaults to this re-look’s judgement record' })) }),
      execute: async (_id, p) => {
        const r = store.relations.get(p.relationId);
        if (!r) return fail(`unknown relation ${p.relationId}`);
        if (!isOneOf(ASSESSMENT, p.assessment)) return fail(`assessment must be one of ${ASSESSMENT.join(', ')}`);
        const j = store.judgements.get(p.judgementRecordId || ctx.judgementId || '');
        if (!j) return fail('judgementRecordId must exist');
        store.relations.put({ ...r, assessment: p.assessment, assessedAt: now(), assessedInJobId: ctx.jobId, updatedAt: now() }, trace(`Assessed ${p.assessment}: ${r.type} ${r.from} → ${r.to}`, r.evidence.sourceIds));
        store.judgements.put({ ...j, outcome: { ...j.outcome, assessments: [...j.outcome.assessments.filter((a) => a.relationId !== r.id), { relationId: r.id, assessment: p.assessment }] } });
        return ok({ id: r.id, assessment: p.assessment });
      },
    }),
  ];

  tools.push(defineTool({
    name: 'pk_begin_request', label: 'Take up the owner’s request',
    description: 'Call this when, in the conversation, the owner explicitly asks you to change project content or to do a specific piece of work (a review, a revision, a hand-over). It records the delegation with the owner’s own words as its basis and switches this work to "Your request"; from then on you may act within that scope without asking per step. Do not call it for questions, opinions or suggestions.',
    parameters: Type.Object({ scope: Type.String({ description: 'what the request covers, in your words' }), quote: Type.String({ description: 'the owner’s words that make the request, or the authorization’s words' }), authorizationId: Type.Optional(Type.String({ description: 'a standing authorization id when acting under one instead of a request in this conversation' })) }),
    execute: async (_id, p) => {
      if (!ctx.beginRequest) return fail('This job cannot take a request.');
      const authorizationId = text(p.authorizationId) || null;
      if (authorizationId) {
        const a = store.authorizations.get(authorizationId);
        if (!a || a.revokedAt) return fail('That standing authorization does not exist or was revoked.');
      }
      const label = text(p.scope).slice(0, 120);
      const outcome = ctx.beginRequest({ label, quote: text(p.quote), scope: text(p.scope), authorizationId });
      if (outcome.startsWith('ERROR:')) return fail(outcome.slice(6).trim());
      return ok({ ok: true, scope: label, note: outcome });
    },
  }));

  tools.push(defineTool({
    name: 'pk_record_authorization', label: 'Record a standing authorization',
    description: 'When the owner gives a standing authorization in the conversation (for example "when a document reference is stale, fix it directly"), record it: the scope in your words, the owner’s words, and the message as its source. It is listed in Project scope and the owner can revoke it. Later, act under it only within its scope, through pk_begin_request with its id, and say which authorization you relied on.',
    parameters: Type.Object({ scope: Type.String(), quote: Type.String() }),
    execute: async (_id, p) => {
      if (!ctx.ownerSourceId) return fail('Only the owner’s message in the conversation can give an authorization.');
      const id = newId('auth');
      store.authorizations.put({ id, projectId: project.id, scope: text(p.scope), sourceId: ctx.ownerSourceId, quote: text(p.quote), at: now(), revokedAt: null }, trace(`Standing authorization: ${text(p.scope).slice(0, 100)}`, [ctx.ownerSourceId]));
      saved('authorizations', id, `Authorization: ${text(p.scope).slice(0, 60)}`);
      return ok({ id, scope: text(p.scope) });
    },
  }));

  tools.push(defineTool({
    name: 'pk_write_investigation_result', label: 'Record an investigation result',
    description: 'Record the result of an investigation into what needs adjusting: what to adjust, why, and the affected items with sources. When the matter already has a decision: the description now in force, the materials still using the old wording, the references to update. When the direction is undecided: discussable options (each with effects, the work and results that would change, cost, what can be reused); options are proposals, never decisions.',
    parameters: Type.Object({
      noteId: Type.Optional(Type.String()), decided: Type.Boolean(), adjust: Type.String(), why: Type.String(),
      affected: Type.Array(Type.Object({ id: Type.String({ description: 'asset id (reference item, thread, relation, source)' }), reason: Type.String(), sourceIds: StrArr })),
      currentDescription: Type.Optional(Type.String()), oldWording: Type.Optional(Type.Array(Type.Object({ sourceId: Type.String(), wording: Type.String() }))), referencesToUpdate: Type.Optional(StrArr),
      options: Type.Optional(Type.Array(Type.Object({ title: Type.String(), effects: Type.String(), workToChange: Type.String(), cost: Type.String(), reusable: Type.String() }))),
    }),
    execute: async (_id, p) => {
      const result = { decided: p.decided === true, adjust: text(p.adjust), why: text(p.why), affected: arr<Record<string, unknown>>(p.affected).map((a) => ({ id: text(a.id), reason: text(a.reason), sourceIds: arr<string>(a.sourceIds) })), currentDescription: text(p.currentDescription) || null, oldWording: arr<Record<string, unknown>>(p.oldWording).map((o) => ({ sourceId: text(o.sourceId), wording: text(o.wording) })), referencesToUpdate: arr<string>(p.referencesToUpdate), options: arr<Record<string, unknown>>(p.options).map((o) => ({ title: text(o.title), effects: text(o.effects), workToChange: text(o.workToChange), cost: text(o.cost), reusable: text(o.reusable) })), at: now(), jobId: ctx.jobId };
      ctx.onInvestigationResult?.(result);
      const noteId = text(p.noteId);
      if (noteId && store.notes.has(noteId)) {
        const n = store.notes.get(noteId)!;
        store.notes.put({ ...n, followUps: [...n.followUps, { kind: 'investigation', jobId: ctx.jobId, at: now(), summary: result.adjust.slice(0, 240) }], updatedAt: now() }, trace(`Investigation on note: ${result.adjust.slice(0, 100)}`, result.affected.flatMap((a) => a.sourceIds)));
      }
      saved('investigations', ctx.jobId, `Investigation: ${result.adjust.slice(0, 60)}`);
      return ok({ recorded: true, affected: result.affected.length });
    },
  }));

  tools.push(defineTool({
    name: 'pk_write_modification_request', label: 'Prepare a modification request for a role holder',
    description: 'In a project with roles, a change to the product meaning of an artifact belongs to its holder. Prepare the request: what to change, why, the basis (source ids), the affected items; it reaches the holder in their next context (Notes for you). A Follow up round’s main job gives one holder one request per round, however many of their objects are behind: a second call in the same round adds a line to the one request. A request written anywhere else — in the owner’s conversation, for instance — is a request of its own and belongs to no round. This does not write into the project; that needs the owner’s request or a standing authorization.',
    parameters: Type.Object({ holderRole: Type.String(), what: Type.String(), why: Type.String(), basisSourceIds: StrArr, impact: StrArr, noteId: Type.Optional(Type.String()), changeIds: Type.Optional(StrArr) }),
    execute: async (_id, p) => {
      const noteId = text(p.noteId) || null;
      const holder = text(p.holderRole);
      const impact = arr<string>(p.impact);
      // A round's requests are part of its one result, and the result is its main job's (§5.4, §5.5; CKC-11 AC-25): only
      // a Follow up round's main job files a request under the round and adds to the round's request to that holder. A
      // request written while taking the project over (D59 rule 1), or by any other job the store knows — the owner's
      // conversation, an answer, a re-look — is a request of its own, under no round, and reaches the holder the same
      // way. Filing it under whichever round was open made the owner's own delegation part of that round's result.
      const job = store.jobs.get(ctx.jobId);
      const clerkRecordId = clerkFollowUpRecordOf(store, job);
      const round = isTakeoverWork(store, ctx.jobId) || (job && !judgesFollowUp(store, job)) ? null : (clerkRecordId ? store.rounds.get(clerkRecordId) ?? null : openRound(store));
      const existing = requestForHolder(store, holder, round?.id ?? null);
      const lines = [
        ...(existing?.lines ?? []),
        ...(impact.length ? impact : ['']).map((nodeId) => ({ nodeId, what: text(p.what), changeIds: arr<string>(p.changeIds) })),
      ];
      const id = existing?.id ?? newId('req');
      store.requests.put({
        id, projectId: project.id, holder,
        what: existing ? `${existing.what}\n- ${text(p.what)}` : text(p.what),
        why: existing && existing.why !== text(p.why) ? `${existing.why}\n- ${text(p.why)}` : text(p.why),
        basisSourceIds: [...new Set([...(existing?.basisSourceIds ?? []), ...arr<string>(p.basisSourceIds)])],
        impact: [...new Set([...(existing?.impact ?? []), ...impact])],
        noteId: noteId ?? existing?.noteId ?? null, at: existing?.at ?? now(), handled: null,
        roundId: round?.id ?? null, lines,
      }, trace(`Modification request to ${holder}: ${text(p.what).slice(0, 100)}`, arr<string>(p.basisSourceIds)));
      if (noteId && store.notes.has(noteId)) {
        const n = store.notes.get(noteId)!;
        store.notes.put({ ...n, delegatedTo: { holder, requestId: id, handledAt: null }, followUps: [...n.followUps, { kind: 'request', jobId: ctx.jobId, at: now(), summary: `Request to ${holder}: ${text(p.what).slice(0, 200)}` }], updatedAt: now() });
      }
      saved('requests', id, `Request to ${holder}`);
      return ok(existing
        ? { id, merged: true, lines: lines.length, note: `${holder} already has this round’s request; this was added to it as one more line, so the holder gets one list, not many.` }
        : { id, lines: lines.length });
    },
  }));

  tools.push(defineTool({
    name: 'pk_check_decisions', label: 'Check what a new decision replaces',
    description: 'A decision is not judged for propagation; what it needs is the replacement check. In the round a new decision appears — and for the historical decisions read during a takeover — go down the timeline of decisions and say, for each current decision it touches: which part it supersedes (supersedes; part: which part, stated: true when the new decision says so, false when it only gives different content for the same matter, whole: true only when nothing of the old decision is left in force), or that you cannot tell whether it supersedes it (unclear, with the clue). A part being superseded is recorded on the old decision and in a replaces relation, and the old decision stays Current for the rest of it; a whole replacement makes it Replaced pointing at the new decision. What is unclear gets Suspected stale and keeps its validity. Only current decisions are checked, and only against decisions older than the new one. Objects still working to a superseded decision are judged as usual.',
    parameters: Type.Object({
      newDecisionId: Type.String(),
      supersedes: Type.Optional(Type.Array(Type.Object({
        decisionId: Type.String(), part: Type.String({ description: 'which part of the old decision this one replaces' }),
        stated: Type.Boolean({ description: 'does the new decision say so itself?' }),
        whole: Type.Optional(Type.Boolean({ description: 'true only when the new decision leaves nothing of the old one in force; otherwise the rest of the old decision stays Current and only the named part is recorded as superseded' })),
      }))),
      unclear: Type.Optional(Type.Array(Type.Object({ decisionId: Type.String(), clue: Type.String(), clueSourceIds: StrArr }))),
    }),
    execute: async (_id, p) => {
      const fresh = store.reference.get(text(p.newDecisionId));
      if (!fresh) return fail(`unknown decision ${text(p.newDecisionId)}`);
      if (!isDecision(store, fresh.id)) return fail(`${fresh.id} is a ${fresh.category}, not a decision; the replacement check runs over the timeline of decisions`);
      // The mirror of the gate on the old decision below: what is not in force supersedes nothing either. A
      // proposal is a candidate, and letting a candidate replace current decisions would put the assets ahead of
      // the project — objects would be judged behind against content nobody has adopted.
      if (fresh.validity !== 'Current') {
        const advice = fresh.validity === 'Proposed'
          ? 'A proposal is a candidate, not a decision in force: record its adoption first (the basis is the owner’s approval or the project’s own record of adoption), then check what it supersedes.'
          : `Only a Current decision supersedes another. Run the check from the decision in force on this matter, not from a ${fresh.validity} one.`;
        return fail(`${fresh.id} (${fresh.name}) is ${fresh.validity}, so nothing follows it yet and it supersedes nothing. ${advice}`);
      }
      // §5.5 gives the two outcomes as alternatives — what is superseded is marked, what cannot be told gets
      // Suspected stale — so the same decision in both lists is a call that contradicts itself, and it is refused
      // before anything is written rather than half-applied.
      const unclearIds = arr<Record<string, unknown>>(p.unclear).map((u) => text(u.decisionId));
      const inBoth = [...new Set(arr<Record<string, unknown>>(p.supersedes).map((s) => text(s.decisionId)).filter((id) => id && unclearIds.includes(id)))];
      if (inBoth.length) {
        return fail(`${inBoth.join(', ')} ${inBoth.length === 1 ? 'is' : 'are'} listed both as superseded and as unclear, and one decision is one or the other: what the new decision takes over is marked and points at it, what you cannot tell about keeps its validity and carries the clue. Decide which this is — name the part in supersedes, or move it to unclear alone — and call again.`);
      }
      const replaced: string[] = [];
      const partlySuperseded: string[] = [];
      const suspected: string[] = [];
      const problems: string[] = [];
      const undated: string[] = [];
      const freshTime = decisionTime(store, fresh);
      for (const s of arr<Record<string, unknown>>(p.supersedes)) {
        const old = store.reference.get(text(s.decisionId));
        if (!old || !isDecision(store, old.id)) { problems.push(`${text(s.decisionId)} is not a decision in the assets`); continue; }
        if (old.id === fresh.id) { problems.push('a decision does not replace itself'); continue; }
        if (!text(s.part)) { problems.push(`${old.id}: say which part of it the new decision replaces`); continue; }
        // §5.5 checks the new decision against the decisions that are in force. A proposal never was one, and a
        // decision already replaced or abandoned is a point-in-time record (§2.10): writing over either would
        // invent a supersession of something nobody was following.
        if (old.validity !== 'Current') { problems.push(notCurrentRefusal(old)); continue; }
        // And the new decision has to be the later one: without this the tool wrote the timeline backwards,
        // marking a decision superseded by one that came before it and pointing `replacedBy` the wrong way.
        const oldTime = decisionTime(store, old);
        if (oldTime && freshTime && oldTime.at > freshTime.at) {
          problems.push(`${old.id} (${old.name}) is not older than ${fresh.name}: the assets date it ${oldTime.at}, from ${oldTime.field}, and date ${fresh.id} ${freshTime.at}, from ${freshTime.field}. A decision is superseded only by a later one (the check goes down the timeline of decisions), so run this check from ${old.id} over ${fresh.id} instead — or, if the dates are wrong, correct the change record that files each decision under the time its own material gives.`);
          continue;
        }
        if (!oldTime || !freshTime) {
          undated.push(`Nothing in the assets dates ${!oldTime ? old.id : fresh.id}, so which of ${old.id} and ${fresh.id} came first could not be checked. Record the piece of work that made it (pk_write_change, with the time its material gives) to make the timeline checkable.`);
        }
        // The basis is the program's to set: Explicit when the new decision names what it replaces, Inferred when
        // it only gives different content for the same matter. The owner can correct it.
        const basis = s.stated === true ? 'Explicit' as const : 'Inferred' as const;
        const part = text(s.part);
        const whole = s.whole === true;
        if (whole) {
          store.reference.put({ ...old, validity: 'Replaced', replacedBy: fresh.id, updatedAt: now() }, trace(`Replaced by ${fresh.name}: ${part}`, fresh.sourceIds));
          replaced.push(old.id);
        } else {
          // §5.5: the superseded part is marked and the rest stays as it was. Flipping the whole decision to
          // `Replaced` for one part of it took the other parts out of `Current` too, so work that still had to
          // follow them was left following a decision the assets said no longer applied.
          const already = (old.supersededParts ?? []).filter((x) => !(x.byId === fresh.id && x.part === part));
          store.reference.put({ ...old, supersededParts: [...already, { part, byId: fresh.id, basis, at: now() }], updatedAt: now() }, trace(`Part superseded by ${fresh.name}: ${part}`, fresh.sourceIds));
          partlySuperseded.push(old.id);
        }
        const relId = stableId('rel', 'replaces', fresh.id, old.id);
        store.relations.put({
          id: relId, projectId: project.id, type: 'replaces', from: fresh.id, to: old.id,
          claim: whole ? `${fresh.name} replaces ${old.name} as a whole: ${part}` : `${fresh.name} supersedes part of ${old.name}: ${part}; the rest of ${old.name} stays in force`, basis,
          evidence: { sourceIds: fresh.sourceIds, factRecordIds: [], factsSoFar: '' },
          assessment: store.relations.get(relId)?.assessment ?? 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: now(),
        }, trace(`replaces: ${fresh.id} → ${old.id}`, fresh.sourceIds));
        saved('reference', old.id, whole ? `Replaced: ${old.name}` : `Part superseded: ${old.name}`);
      }
      for (const u of arr<Record<string, unknown>>(p.unclear)) {
        const old = store.reference.get(text(u.decisionId));
        if (!old || !isDecision(store, old.id)) { problems.push(`${text(u.decisionId)} is not a decision in the assets`); continue; }
        if (old.validity !== 'Current') { problems.push(notCurrentRefusal(old)); continue; }
        const clueSourceIds = arr<string>(u.clueSourceIds).length ? arr<string>(u.clueSourceIds) : fresh.sourceIds;
        const refusal = markRefusal(store, 'Suspected stale', old.id, text(u.clue), clueSourceIds, 'At its own time');
        if (refusal) { problems.push(`${old.id}: ${refusal}`); continue; }
        const markId = stableId('mark', 'Suspected stale', old.id);
        const previous = store.marks.get(markId);
        store.marks.put({ id: markId, projectId: project.id, kind: 'Suspected stale', targetId: old.id, clueSourceIds, clue: text(u.clue), since: previous?.since ?? now(), noteId: previous?.noteId ?? null, closed: null }, trace(`Suspected stale on ${old.id}: may be superseded by ${fresh.name}`, clueSourceIds));
        saved('marks', markId, 'Mark: Suspected stale');
        suspected.push(old.id);
      }
      // A call every entry of which was refused wrote nothing, and an `ok` with an empty list reads as a check
      // that found nothing to do; the caller has to see that the check did not happen.
      if (problems.length && replaced.length + partlySuperseded.length + suspected.length === 0) return fail(problems.join(' '));
      return ok({ newDecisionId: fresh.id, replaced, partlySuperseded, suspected, problems, undated });
    },
  }));

  tools.push(defineTool({
    name: 'pk_write_round_result', label: 'Write this round’s one result',
    description: 'One Follow up round produces one result. Write its account in your own words: which objects are behind and what they lack, which upstreams are stale, which dependencies were not taken into account, which decisions the new ones replaced. Every number in the result is counted from the assets by the program — do not write totals of your own. Objects with a holder are reached through pk_write_modification_request, and only what the owner must decide or is worth their knowing becomes a note.',
    parameters: Type.Object({ summary: Type.String({ description: 'the round’s account, without totals' }), unassigned: Type.Optional(Type.Array(Type.String(), { description: 'objects behind for which no holder could be identified' })) }),
    execute: async (_id, p) => {
      const round = roundOf();
      if (typeof round === 'string') return fail(round);
      // The round's result is read by the owner: no internal identifiers in it (§6.13, D105; CKC-08 AC-27).
      const unreadable = ownerTextRefusal('The round’s result', { summary: text(p.summary) }, laneNamesOf(store));
      if (unreadable) return fail(unreadable);
      const result = roundResultOf(store, round.id, text(p.summary), now());
      store.rounds.put({ ...round, endedAt: now(), result }, trace(`Follow up round ${round.number}: ${result.counts.objectsJudged} objects judged`));
      saved('rounds', round.id, `Follow up round ${round.number}`);
      return ok({ round: round.id, ...result.counts });
    },
  }));

  tools.push(defineTool({
    name: 'pk_mark_request_handled', label: 'Mark a modification request handled',
    description: 'Later material shows the holder handled a modification request: record it with the evidence sources.',
    parameters: Type.Object({ requestId: Type.String(), evidenceSourceIds: StrArr }),
    execute: async (_id, p) => {
      const r = store.requests.get(p.requestId);
      if (!r) return fail(`unknown request ${p.requestId}`);
      store.requests.put({ ...r, handled: { at: now(), evidenceSourceIds: arr<string>(p.evidenceSourceIds) } }, trace(`Request handled by ${r.holder}`, arr<string>(p.evidenceSourceIds)));
      if (r.noteId && store.notes.has(r.noteId)) { const n = store.notes.get(r.noteId)!; if (n.delegatedTo?.requestId === r.id) store.notes.put({ ...n, delegatedTo: { ...n.delegatedTo, handledAt: now() }, updatedAt: now() }); }
      return ok({ id: r.id, handled: true });
    },
  }));

  /**
   * The round this job writes into; the first judgement of a job opens one when none is open (§5.5). Work that takes
   * the project over never opens or joins a Follow up round: propagation is judged in the Follow up after the
   * takeover (D59 rule 1). An unregistered job is refused too; it cannot acquire a round merely by presenting an id.
   * Nor does any other registered job that is not a Follow up round's main job — the owner's conversation, an answer,
   * a re-look, a subagent: a round's judgements and its one result are its main job's (§3.3, §5.5; CKC-11 AC-25), and
   * roles.ts keeps these tools from such a job in the first place. The reason comes back as a string the caller refuses.
   */
  const roundOf = (): FollowUpRound | string => {
    if (isTakeoverWork(store, ctx.jobId)) return TAKEOVER_NO_ROUND;
    const job = store.jobs.get(ctx.jobId);
    if (!job) return UNKNOWN_ROUND_JOB(ctx.jobId);
    // By the clerk method a Follow up round opened its record when it began, and its cross-check judges into that one.
    const clerkRecordId = clerkFollowUpRecordOf(store, job);
    const clerkRecord = clerkRecordId ? store.rounds.get(clerkRecordId) : undefined;
    if (clerkRecord) return clerkRecord;
    if (roundKindOf(job) !== 'follow-up') return NOT_THE_ROUNDS_MAIN_JOB;
    const named = text(ctx.roundId) ? store.rounds.get(text(ctx.roundId)) : undefined;
    const open = named ?? openRound(store);
    if (open) return open;
    // Nor does anything else open one while the project is still being taken over (§5.5): a conversation that judged
    // an object during the takeover used to open a Follow up round the takeover then ran beside (C1's hand-back item 3).
    const stage = store.coverage.takeover?.stage;
    if (stage && stage !== 'Daily') return TAKEOVER_UNDERWAY(stage);
    return startRound(store, project.id, ctx.jobId);
  };
  /** Why this object is not judged at all, as the caller is told it. */
  const notJudgedRefusal = (nodeId: string): string | null => {
    if (!objectExists(store, nodeId)) return `unknown object ${nodeId}; use the ids the pk_write_* tools returned`;
    const reason = notJudgedReason(store, nodeId);
    return reason ? `${nodeId} is not judged: ${NOT_JUDGED_MESSAGE[reason]}` : null;
  };
  const itemRefs = (raw: unknown): ItemRef[] => arr<Record<string, unknown>>(raw).map((r) => ({ changeId: text(r.changeId), itemId: text(r.itemId) }));

  tools.push(defineTool({
    name: 'pk_judge_object', label: 'Judge one downstream object',
    description: 'One object, one state, one round. Judge the object against every item of every change that reached it, together with the items on it that have no conclusion yet, and give one state: Updated (it follows the new content, give the source), Still on old understanding (it is still written, done or verified against what at least one item replaced — name which items it followed and which it lacks, and what each lacks), Reusable as is (the items do not touch it, or it holds either way, give the reason), Not yet checked (say what is missing). Point-in-time records and decisions are never judged. An item ends only when the object follows it, a later change supersedes it, or the owner or holder says it need not be handled — say which in closed, always with the reason, and with the superseding change id or with who said so and where they said it. Every item you name must be one of the items that reached this object.',
    parameters: Type.Object({
      nodeId: Type.String(), state: Type.String(), sourceOrReason: Type.String({ description: 'the source that shows it, or the reason' }),
      followed: Type.Optional(Type.Array(Type.Object({ changeId: Type.String(), itemId: Type.Optional(Type.String()) }), { description: 'the items the object has followed' })),
      lacks: Type.Optional(Type.Array(Type.Object({ changeId: Type.String(), itemId: Type.Optional(Type.String()), what: Type.String({ description: 'what the object still has to follow' }) }), { description: 'the items it still lacks' })),
      closed: Type.Optional(Type.Array(Type.Object({
        changeId: Type.String(), itemId: Type.Optional(Type.String()), close: Type.String({ description: ITEM_CLOSE.join(' | ') }),
        reason: Type.String({ description: 'what ends this item, in one clause' }),
        supersededByChangeId: Type.Optional(Type.String({ description: 'Superseded by a later change: the id of the change record whose later content took this item’s place' })),
        saidBy: Type.Optional(Type.String({ description: 'No action needed: "owner", or the role of the holder who said it need not be handled' })),
        saidInSourceId: Type.Optional(Type.String({ description: 'No action needed: the source id of the message or material where they said it' })),
      }))),
    }),
    execute: async (_id, raw) => {
      // A work item merged into another is judged as the one kept (§1.4).
      const p = { ...raw, nodeId: resolveMergedId(store, raw.nodeId) };
      const refusal = notJudgedRefusal(p.nodeId);
      if (refusal) return fail(refusal);
      if (!isOneOf(PROPAGATION, p.state)) return fail(`state must be one of ${PROPAGATION.join(', ')}`);
      const lacks: LackedItem[] = arr<Record<string, unknown>>(p.lacks).map((r) => ({ changeId: text(r.changeId), itemId: text(r.itemId), what: text(r.what) }));
      if (p.state === 'Still on old understanding' && lacks.length === 0) {
        return fail('"Still on old understanding" that names nothing is never shown to an agent and cannot be checked. List in lacks the items the object has not followed, each with what it still has to follow, and in followed the ones it has.');
      }
      const empty = lacks.filter((l) => l.what.trim().length === 0);
      if (empty.length) return fail(`lacks[${lacks.indexOf(empty[0]!)}].what is empty: say what the object still has to follow, in one clause, so the agent reading it can check the same thing.`);
      if (!text(p.sourceOrReason)) return fail('sourceOrReason is required: the source that shows the object followed, or the reason it holds either way.');
      // §2.10 ends an item in exactly three ways, and each of the last two rests on something outside this
      // judgement: a later change, or the owner or holder saying it need not be handled. Written as prose alone
      // nobody could check either, and a model that mistook one of them closed the item for good.
      const closedIn: ClosedItem[] = [];
      for (const [i, r] of arr<Record<string, unknown>>(p.closed).entries()) {
        const close = r.close;
        if (!isOneOf(ITEM_CLOSE, close)) return fail(`closed[${i}].close must be one of ${ITEM_CLOSE.join(', ')}`);
        const reason = text(r.reason).trim();
        if (!reason) return fail(`closed[${i}].reason is empty: say in one clause what ends this item (an item stays with the object until the object follows it, a later change supersedes it, or the owner or holder says it need not be handled). A close nobody can check is never shown to an agent.`);
        const entry: ClosedItem = { changeId: text(r.changeId), itemId: text(r.itemId), close, reason };
        if (close === 'Superseded by a later change') {
          const byId = text(r.supersededByChangeId);
          if (!byId) return fail(`closed[${i}] ends an item because a later change superseded it, but does not say which change that is. Add supersededByChangeId: the id pk_write_change returned for the later piece of work.`);
          const by = store.changes.get(byId);
          if (!by) return fail(`closed[${i}].supersededByChangeId names no change record in the assets: ${byId}. Give the id of the record that holds the later content, so the next reader can look it up.`);
          const superseded = store.changes.get(entry.changeId);
          const wasAt = superseded ? itemTime(superseded, entry.itemId) : '';
          if (wasAt && !(lastItemTime(by) > wasAt)) {
            return fail(`closed[${i}] says ${byId} superseded this item, but ${byId}’s last item is at ${lastItemTime(by)} and the item it would supersede is at ${wasAt}: what did not come after it cannot supersede it. Name the change that really came later, or end the item another way — the object followed it, or the owner or holder says it need not be handled.`);
          }
          closedIn.push({ ...entry, supersededByChangeId: byId });
          continue;
        }
        if (close === 'No action needed') {
          const who = text(r.saidBy).trim();
          if (!who) return fail(`closed[${i}] ends an item because nobody has to handle it, but does not say who said so (only the owner or the object’s holder can). Add saidBy: "owner", or the holder’s role.`);
          const sourceId = text(r.saidInSourceId).trim();
          if (!store.sources.has(sourceId)) return fail(`closed[${i}] says ${who} decided this item need not be handled, but ${sourceId ? `saidInSourceId names no source in the assets: ${sourceId}` : 'names no material that shows it'}. Add saidInSourceId: the source id of the owner’s message, the holder’s reply, or the later material that says so — that an item need not be handled is read from the owner’s response or from the material, and a close that cannot be checked is never shown to an agent.`);
          const owner = who.toLowerCase() === 'owner';
          closedIn.push({ ...entry, saidBy: { who: owner ? 'owner' : 'holder', role: owner ? null : who, sourceId } });
          continue;
        }
        closedIn.push(entry);
      }
      const round = roundOf();
      if (typeof round === 'string') return fail(round);
      const { covers, carried } = itemsForObject(store, p.nodeId, round.id);
      // §2.10, §5.5: an item that has a conclusion is not judged again, even after the object changed; what the
      // object still lacks is judged again only once it has moved or something new has reached it. When nothing is
      // open, the state from the last round simply stands.
      if (covers.length === 0) {
        const previous = lastJudgement(store, p.nodeId, round.id);
        return ok({
          nodeId: p.nodeId, round: round.id, covers: 0, wrote: false,
          note: previous
            ? `Nothing is open on ${p.nodeId}: what reached it has a conclusion from an earlier round, so round ${previous.roundId}’s judgement stands: ${previous.state}${carried.length ? `, still lacking ${carried.length} item${carried.length === 1 ? '' : 's'}, which ${carried.length === 1 ? 'is' : 'are'} judged again once the object moves or something new reaches it` : ''}. A concluded item is not judged again.`
            : `No change has reached ${p.nodeId}, so there is nothing to judge.`,
        });
      }
      // What this round judges for this object: the items that reached it, and what the previous round left open
      // (§5.5). These are the only refs the judgement keeps, so a ref outside them is one that would be dropped
      // inside — and an item reference the program drops silently is a state nobody can check (§7.1).
      const reached: ItemRef[] = [...covers, ...carried.filter((l) => store.changes.has(l.changeId)).map((l) => ({ changeId: l.changeId, itemId: l.itemId }))];
      // An empty itemId means the whole record (§1.8: a record written before items existed is one item), so it
      // reaches the object whenever any item of that record did.
      const reaches = (r: ItemRef) => (r.itemId ? reached.some((c) => sameItem(c, r)) : reached.some((c) => c.changeId === r.changeId));
      const itemsHere = (changeId: string) => reached.filter((c) => c.changeId === changeId).map((c) => c.itemId || '(the whole record)');
      const named = [...itemRefs(p.followed), ...lacks, ...closedIn];
      // A real change id with an item id that never came near this object used to pass — the check asked only
      // whether the change existed — and was then dropped, leaving `Still on old understanding` with nothing in
      // `lacks`. It is refused here, with the item ids that did reach the object, so the caller can name one.
      const offItem = named.find((r) => !reaches(r) && reached.some((c) => c.changeId === r.changeId));
      if (offItem) {
        return fail(`${offItem.changeId} reached ${p.nodeId}, but “${offItem.itemId}” is not one of its items that did. The items of that record to judge here are: ${itemsHere(offItem.changeId).join(', ')}. Name one of those, or leave itemId out to mean the whole record (a judgement says which records and which of their items it covers).`);
      }
      const unknown = named.filter((r) => !reaches(r));
      if (unknown.length && unknown.length === named.length) return fail(`none of the changes named reached ${p.nodeId}: ${[...new Set(unknown.map((u) => u.changeId))].join(', ')}. The items to judge are listed with the object in the task.`);
      // `Still on old understanding` whose every lacked item is dropped would be exactly the state §7.1 refuses
      // above, reached the long way round: an object recorded as behind with nothing anyone can check it against.
      if (p.state === 'Still on old understanding' && !lacks.some(reaches)) {
        return fail(`None of the ${lacks.length} item${lacks.length === 1 ? '' : 's'} in lacks reached ${p.nodeId} this round, so "Still on old understanding" would be recorded with nothing to check it against. The items to judge here are: ${[...new Set(reached.map((c) => `${c.changeId}${c.itemId ? ` / ${c.itemId}` : ''}`))].join(', ')}. Name the ones the object has not followed, or give the state it is really in.`);
      }
      const judgement = judgeObject(store, project.id, round.id, {
        nodeId: p.nodeId, state: p.state, sourceOrReason: text(p.sourceOrReason),
        followed: itemRefs(p.followed), lacks, closed: closedIn,
        jobId: ctx.jobId,
      });
      saved('propagation', judgement.id, `${judgement.state}: ${p.nodeId}`);
      return ok({ nodeId: p.nodeId, round: round.id, state: judgement.state, covers: judgement.covers.length, followed: judgement.followed.length, lacks: judgement.lacks.length, ignored: unknown.length ? unknown.map((u) => u.changeId) : undefined });
    },
  }));

  tools.push(defineTool({
    name: 'pk_set_propagation', label: 'Set propagation state',
    description: 'How one downstream object stands against one change record. It joins the object’s one judgement for this round; prefer pk_judge_object, which takes the whole object at once.',
    parameters: Type.Object({ changeId: Type.String(), nodeId: Type.String(), state: Type.String(), sourceOrReason: Type.String() }),
    execute: async (_id, raw) => {
      const p = { ...raw, nodeId: resolveMergedId(store, raw.nodeId) };
      const c = store.changes.get(p.changeId);
      if (!c) return fail(`unknown change ${p.changeId}`);
      if (!isOneOf(PROPAGATION, p.state)) return fail(`state must be one of ${PROPAGATION.join(', ')}`);
      const refusal = notJudgedRefusal(p.nodeId);
      if (refusal) return fail(refusal);
      const result = applyPerChange(p.nodeId, [{ change: c, state: p.state, sourceOrReason: text(p.sourceOrReason) }]);
      return typeof result === 'string' ? fail(result) : ok({ changeId: c.id, nodeId: p.nodeId, state: result.state, round: result.roundId });
    },
  }));

  /** Several per-change judgements of one object, folded into the object's one state for this round. */
  const applyPerChange = (nodeId: string, judged: readonly { change: ChangeRecord; state: string; sourceOrReason: string }[]) => {
    const behind = judged.filter((j) => j.state === 'Still on old understanding');
    const unbacked = behind.find((j) => !j.sourceOrReason.trim());
    if (unbacked) return `"Still on old understanding" on ${unbacked.change.id} says neither what the object lacks nor what it was checked against, so it would never be shown to an agent. Say what the object still has to follow.`;
    const round = roundOf();
    if (typeof round === 'string') return round;
    const followed: ItemRef[] = [];
    const lacks: LackedItem[] = [];
    for (const j of judged) {
      // Only the items that actually reached this object, the same rule the round's own pack names them by. Taking
      // every item of the record handed the object items that never came near it, and `judgeObject` then dropped
      // them as unknown — leaving `Still on old understanding` with nothing named, which nobody can check (§7.1).
      const entry = j.change.propagation.find((p) => p.nodeId === nodeId);
      const reached = entry?.itemIds ? itemsOf(j.change).filter((i) => entry.itemIds!.includes(i.id)) : itemsOf(j.change);
      for (const item of reached) {
        const ref = { changeId: j.change.id, itemId: item.id };
        if (j.state === 'Still on old understanding') lacks.push({ ...ref, what: j.sourceOrReason });
        else if (j.state !== 'Not yet checked') followed.push(ref);
      }
    }
    const state = behind.length ? 'Still on old understanding' : judged.every((j) => j.state === 'Not yet checked') ? 'Not yet checked' : judged.find((j) => j.state === 'Reusable as is') && !judged.some((j) => j.state === 'Updated') ? 'Reusable as is' : 'Updated';
    const judgement = judgeObject(store, project.id, round.id, { nodeId, state, sourceOrReason: judged.map((j) => j.sourceOrReason).filter(Boolean).join(' · '), followed, lacks, jobId: ctx.jobId });
    saved('propagation', judgement.id, `${judgement.state}: ${nodeId}`);
    return { state: judgement.state, roundId: round.id };
  };

  // One object judged against several changes at once (change follow-up is organized by object): one call per object.
  tools.push(defineTool({
    name: 'pk_set_propagations', label: 'Set propagation states of one object',
    description: 'For one downstream object, how it stands against each of several change records. The judgements are folded into the object’s one state for this round: Updated, Still on old understanding (say what it lacks), Reusable as is, or Not yet checked. pk_judge_object does the same and lets you name the individual items.',
    parameters: Type.Object({ nodeId: Type.String(), judgements: Type.Array(Type.Object({ changeId: Type.String(), state: Type.String(), sourceOrReason: Type.String() })) }),
    execute: async (_id, raw) => {
      const p = { ...raw, nodeId: resolveMergedId(store, raw.nodeId) };
      const refusal = notJudgedRefusal(p.nodeId);
      if (refusal) return fail(refusal);
      const judged: { change: ChangeRecord; state: string; sourceOrReason: string }[] = [];
      const problems: string[] = [];
      for (const j of arr<{ changeId: string; state: string; sourceOrReason: string }>(p.judgements)) {
        const c = store.changes.get(j.changeId);
        if (!c) { problems.push(`unknown change ${j.changeId}`); continue; }
        if (!isOneOf(PROPAGATION, j.state)) { problems.push(`${j.changeId}: state must be one of ${PROPAGATION.join(', ')}`); continue; }
        judged.push({ change: c, state: j.state, sourceOrReason: text(j.sourceOrReason) });
      }
      if (judged.length === 0) return fail(problems.join('; ') || 'no judgements given');
      const result = applyPerChange(p.nodeId, judged);
      return typeof result === 'string' ? fail(result) : ok({ nodeId: p.nodeId, round: result.roundId, state: result.state, recorded: judged.length, problems });
    },
  }));

  tools.push(defineTool({
    name: 'pk_request_relook', label: 'Ask for a product re-look',
    description: 'After an adjustment (yours, or one the owner says was done elsewhere), ask for a product re-look of the affected scope (project, an Area reference id, or a thread id). The re-look decides whether notes are Resolved; changing files alone never does.',
    parameters: Type.Object({ scopeKind: Type.String({ description: 'project | area | thread' }), id: Type.Optional(Type.String()), reason: Type.String() }),
    execute: async (_id, p) => {
      if (!ctx.requestRelook) return fail('Re-looks cannot be requested from this job.');
      const kind = p.scopeKind === 'area' || p.scopeKind === 'thread' ? p.scopeKind : 'project';
      ctx.requestRelook({ kind, id: kind === 'project' ? null : text(p.id) || null }, text(p.reason));
      return ok({ requested: true, scope: kind });
    },
  }));

  tools.push(defineTool({
    name: 'pk_close_note', label: 'Close a note',
    description: 'Mark a note Resolved (a later re-look confirmed, with evidence, that the situation no longer exists) or Withdrawn (the judgement itself was wrong). Give the reason; the note stays in history.',
    parameters: Type.Object({ id: Type.String(), status: Type.String({ description: 'Resolved | Withdrawn' }), reason: Type.String() }),
    execute: async (_id, p) => {
      const n = store.notes.get(p.id);
      if (!n) return fail(`unknown note ${p.id}`);
      if (p.status !== 'Resolved' && p.status !== 'Withdrawn') return fail('status must be Resolved or Withdrawn');
      store.notes.put({ ...n, status: p.status, resolvedReason: p.status === 'Resolved' ? p.reason : n.resolvedReason, withdrawnReason: p.status === 'Withdrawn' ? p.reason : n.withdrawnReason, updatedAt: now() }, trace(`Note ${p.status}: ${p.reason.slice(0, 120)}`));
      saved('notes', n.id, `Note ${p.status}`);
      return ok({ id: n.id, status: p.status });
    },
  }));

  // ───────────────────────── the project's rules (Spec §1.15; D62, D64; CKC-21) ─────────────────────────

  tools.push(defineTool({
    name: 'pk_write_rule', label: 'Write one of the project’s rules',
    description: `Record a rule the project set for itself — you find it, dig it out and follow it; you never set it. Groups: How work is organized (single or several agents; whether the owner wants independent QC, how many rounds, by whom; roles and role cards; who decides what; who hosts the work now and who did before, since when), Working rules (how tasks are numbered and the next number; pushing and merging; where credentials live — the place only, never a value; where deliverables go; how the owner accepts work; any other working rule the project has), Material rules (with a category: ${MATERIAL_RULE.join(', ')}). Each rule has your one-sentence summary, the project’s own words (excerpt — required when basis is Explicit), its sources (for a rule inferred from practice, basis Inferred, the records you inferred it from), what it applies to, and its validity. When the project’s way of working comes from a system the owner summarized (for example a role system), name it in ownerSystem and note where actual practice differs in differsInPractice, both sides with sources. When a rule changed, write the new one with replaces: [old rule ids] — the old ones become Replaced and point to it. With id, what you leave out keeps its value. In the owner’s conversation, ownerConfirmed records the owner confirming an inferred rule: it becomes Explicit with the owner’s message as a source. A rule is not an area, a work item or a graph node.`,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: 'an existing rule to update' })),
      group: Type.Optional(Type.String({ description: RULE_GROUP.join(' | ') })),
      category: Type.Optional(Type.String({ description: `Material rules only: ${MATERIAL_RULE.join(' | ')}` })),
      summary: Type.Optional(Type.String({ description: 'your one sentence' })),
      excerpt: Type.Optional(Type.String({ description: 'the project’s own words, copied exactly as they stand in the sources cited — …… where you leave words out; required when basis is Explicit' })),
      sourceIds: Type.Optional(StrArr),
      appliesTo: Type.Optional(Type.Array(Type.String(), { description: 'the directories, branches, files, fields, roles or work it covers; "the whole project" when it covers everything' })),
      basis: Type.Optional(Type.String({ description: 'Explicit (the project writes it down) | Inferred (drawn from what the project does)' })),
      validity: Type.Optional(Type.String({ description: 'Current by default; Replaced (with replacedBy) when a newer rule took its place' })),
      replacedBy: Type.Optional(Type.String()),
      replaces: Type.Optional(Type.Array(Type.String(), { description: 'older rules this one replaces; they become Replaced and point here' })),
      ownerSystem: Type.Optional(Type.String({ description: 'the way of working the owner summarized that this rule belongs to, when it does' })),
      differsInPractice: Type.Optional(Type.Array(Type.Object({ text: Type.String(), sourceIds: StrArr }), { description: 'where the project’s actual practice differs from this rule, with sources' })),
      expects: Type.Optional(Type.Array(Type.String(), { description: `How work is organized: the steps this rule says the project expects of a piece of work — ${PROCESS_EXPECTATION.join(' | ')}. The breakpoints read them: a missing step is lit only where the project expects it. Name only what the rule says; leave out what it does not.` })),
      ownerConfirmed: Type.Optional(Type.Object({ quote: Type.String({ description: 'the owner’s words confirming it' }) })),
    }),
    execute: async (_id, p) => {
      const previous = text(p.id) ? store.rules.get(text(p.id)) : undefined;
      if (text(p.id) && !previous) return fail(`unknown rule ${text(p.id)}; leave id out to record a new one`);
      const group = text(p.group) || previous?.group || '';
      if (!isOneOf(RULE_GROUP, group)) return fail(`group must be one of ${RULE_GROUP.join(', ')}`);
      const categoryGiven = p.category !== undefined ? text(p.category).trim() : (previous?.category ?? '');
      let category: MaterialRule | null = null;
      if (group === 'Material rules') {
        if (!isOneOf(MATERIAL_RULE, categoryGiven)) return fail(`A material rule needs its category, one of ${MATERIAL_RULE.join(', ')}. Other is for a rule about the project’s material that none of the six names.`);
        category = categoryGiven;
      } else if (categoryGiven) {
        return fail(`category is for material rules only; ${group} has none. If this rule is about the project’s material — what is obsolete, reference only, for recovery only, authoritative, untrusted or declared open — write it under Material rules.`);
      }
      const summary = redact(p.summary !== undefined ? text(p.summary) : previous?.summary ?? '').trim();
      if (!summary) return fail('A rule needs your one-sentence summary (summary).');
      const excerpt = redact(p.excerpt !== undefined ? text(p.excerpt) : previous?.excerpt ?? '').trim() || null;
      // One rule per group, category and the project's own words: writing the same rule again updates it, and keeps
      // what it already had (the owner's confirmation above all) unless the call says otherwise.
      const id = previous?.id ?? stableId('rule', project.id, group, category ?? '', excerpt ?? summary);
      const prior = previous ?? store.rules.get(id);
      const basisGiven = text(p.basis) || prior?.basis || '';
      if (!isOneOf(BASIS, basisGiven)) return fail('basis must be Explicit (the project writes it down) or Inferred (you drew it from what the project does)');
      let basis: 'Explicit' | 'Inferred' = basisGiven;
      // §3.9: the owner's confirmation is their own words in their conversation, nowhere else; once given it stays,
      // and so does the Explicit it made of the rule.
      let ownerConfirmation = prior?.ownerConfirmation ?? null;
      if (p.ownerConfirmed !== undefined) {
        if (!ctx.ownerSourceId) return fail('Only the owner’s message in the conversation can confirm a rule. Until the owner confirms it, an inferred rule stays Inferred and is shown as an inference everywhere.');
        const quote = redact(text(p.ownerConfirmed.quote)).trim();
        if (!quote) return fail('ownerConfirmed.quote: the owner’s words that confirm the rule.');
        const confirmation = checkVerbatim(store, quote, [ctx.ownerSourceId]);
        if (confirmation.missing.length) return fail(ownerConfirmationRefusal(confirmation));
        ownerConfirmation = { sourceId: ctx.ownerSourceId, quote, at: now() };
      }
      if (ownerConfirmation) basis = 'Explicit';
      const sourceIds = [...new Set([
        ...(p.sourceIds !== undefined ? arr<string>(p.sourceIds) : [...(prior?.sourceIds ?? [])]),
        ...(ownerConfirmation ? [ownerConfirmation.sourceId] : []),
      ])].filter((s) => store.sources.has(s));
      if (sourceIds.length === 0) return fail('A rule needs its source: the existing source id(s) where the project writes it down, or — for a rule you inferred from practice — the records you inferred it from. None of the given ids is a source in the assets.');
      if (basis === 'Explicit' && !excerpt && !ownerConfirmation) {
        return fail('An Explicit rule quotes the project’s own words (your one-sentence summary, plus the project’s own text): add excerpt, copied from the source. A rule you drew from what the project does is basis Inferred and names the records it rests on instead.');
      }
      const appliesTo = (p.appliesTo !== undefined ? arr<string>(p.appliesTo) : [...(prior?.appliesTo ?? [])]).map((a) => redact(text(a)).trim()).filter(Boolean);
      if (appliesTo.length === 0) return fail('Say what the rule applies to (appliesTo): the directories, branches, files, fields, roles or work it covers — "the whole project" when it covers everything.');
      const validity = text(p.validity) || prior?.validity || 'Current';
      if (!isOneOf(VALIDITY, validity)) return fail(`validity must be one of ${VALIDITY.join(', ')}`);
      const fromHistory = ruleHistoryRefusal(store, sourceIds, validity);
      if (fromHistory) return fail(fromHistory);
      const replacedBy = p.replacedBy !== undefined ? text(p.replacedBy).trim() || null : prior?.replacedBy ?? null;
      if (validity === 'Replaced' && (!replacedBy || !store.rules.has(replacedBy))) {
        return fail(`A Replaced rule points to the rule that replaced it (replacedBy: an existing rule id)${replacedBy ? `; ${replacedBy} is not one` : ''}. A changed rule is not left beside the new one.`);
      }
      if (replacedBy === id) return fail('A rule does not replace itself.');
      if (replacedBy && replacementCircle(store, id, replacedBy)) return fail(`${id} cannot be replaced by ${replacedBy}: ${replacedBy} is already, through replacedBy, replaced by ${id}, so this would make a circle.`);
      const replaces = [...new Set(arr<string>(p.replaces).map((r) => text(r).trim()).filter(Boolean))];
      if (replaces.includes(id)) return fail('A rule does not replace itself: name the older rule(s) in replaces.');
      const unknownOld = replaces.filter((r) => !store.rules.has(r));
      if (unknownOld.length) return fail(`replaces names no rule in the assets: ${unknownOld.join(', ')}`);
      if (replaces.length && validity !== 'Current') return fail(`Only a rule in force replaces others (the new one is Current, the old ones Replaced); this one is ${validity}.`);
      const circling = replaces.find((r) => replacementCircle(store, r, id) || (replacedBy !== null && replacementCircle(store, r, replacedBy)));
      if (circling) return fail(`${id} cannot replace ${circling}: that would make a circle of replacements.`);
      const differsInPractice = p.differsInPractice !== undefined
        ? arr<Record<string, unknown>>(p.differsInPractice).map((d) => ({ text: redact(text(d.text)).trim(), sourceIds: arr<string>(d.sourceIds).filter((s) => store.sources.has(s)) })).filter((d) => d.text)
        : [...(prior?.differsInPractice ?? [])];
      // §1.15 (E80): a rule Explicit because the project wrote it quotes the project's own words, part by part, in the
      // sources cited, or it is not written. A rule inferred from practice, or Explicit because the owner confirmed it
      // (§3.9: the confirmation is never refused for it), is written and told when its excerpt is not the project's
      // words. An Explicit rule's excerpt, on the sources it already cites, is not checked again (its source may have changed).
      const kept = prior?.basis === 'Explicit' && sameWords(prior.excerpt, excerpt) && prior.sourceIds.every((s) => sourceIds.includes(s));
      const verbatim = excerpt && !kept ? checkVerbatim(store, excerpt, sourceIds) : null;
      if (verbatim?.missing.length && basis === 'Explicit' && !ownerConfirmation) return fail(ruleExcerptRefusal(verbatim));
      const expectsIn = p.expects !== undefined ? arr<string>(p.expects).map((e) => text(e).trim()) : null;
      const badExpect = expectsIn?.find((e) => !isOneOf(PROCESS_EXPECTATION, e));
      if (badExpect) return fail(`expects: ${badExpect} is not one of ${PROCESS_EXPECTATION.join(', ')}`);
      if (expectsIn?.length && group !== 'How work is organized') return fail('expects belongs to a rule of How work is organized: it says which steps the project expects of its work.');
      const expects = expectsIn ? [...new Set(expectsIn)] as ProcessExpectation[] : [...(prior?.expects ?? [])];
      const rule: ProjectRule = {
        id, projectId: project.id, group, category, summary, excerpt, sourceIds, appliesTo, basis, validity, replacedBy, ...(expects.length ? { expects } : {}),
        ownerSystem: p.ownerSystem !== undefined ? text(p.ownerSystem).trim() || null : prior?.ownerSystem ?? null,
        differsInPractice, ownerConfirmation, jobId: ctx.jobId, asOf: now(), updatedAt: now(),
      };
      store.rules.put(rule, trace(`${prior ? 'Rule updated' : 'Rule'} (${group}${category ? ` · ${category}` : ''}): ${summary.slice(0, 100)}`, sourceIds));
      for (const old of replaces) store.rules.put({ ...store.rules.get(old)!, validity: 'Replaced', replacedBy: id, updatedAt: now() }, trace(`Rule replaced by ${id}: ${summary.slice(0, 80)}`, sourceIds));
      saved('rules', id, `Rule: ${summary.slice(0, 60)}`);
      const warning = verbatim?.missing.length ? inferredExcerptWarning(verbatim) : null;
      return ok({ id, updated: Boolean(prior), ...(replaces.length ? { replaced: replaces } : {}), ...(warning ? { warning } : {}) });
    },
  }));

  tools.push(defineTool({
    name: 'pk_write_organizing_plan', label: 'Write the organizing plan and focus',
    description: 'The orientation step’s plan for the organizing that follows: which material the project’s rules settle directly (byRule: what, its targets — directories, files or branches as the project names them — the id of the rule, and the treatment, e.g. Reference only or History only), what needs close reading (readClosely: what, targets, why), where the focus is (focus: what, why, sources — for example where documents part from the owner’s words, work still in progress, status that rests on reports), and in what order. The owner sees it in Project scope and can correct it; every deepening round follows it; the depth question counts by it (what the rules settle is not counted as close reading). A later call replaces the fields it gives and keeps the others. In the owner’s conversation, ownerCorrection records the owner correcting it: their words are kept, with what the plan said before.',
    parameters: Type.Object({
      byRule: Type.Optional(Type.Array(Type.Object({ what: Type.String(), targets: StrArr, ruleId: Type.String(), treatment: Type.String({ description: 'what the rule makes of it, e.g. Reference only, History only, Replaced' }) }))),
      readClosely: Type.Optional(Type.Array(Type.Object({ what: Type.String(), targets: Type.Optional(StrArr), why: Type.Optional(Type.String()) }))),
      focus: Type.Optional(Type.Array(Type.Object({ what: Type.String(), why: Type.Optional(Type.String()), sourceIds: Type.Optional(StrArr) }))),
      order: Type.Optional(Type.Array(Type.String(), { description: 'what is organized first, next, …' })),
      ownerCorrection: Type.Optional(Type.Object({ quote: Type.String({ description: 'the owner’s words' }), changed: Type.String({ description: 'what the correction changed, in your words' }) })),
    }),
    execute: async (_id, p) => {
      const previous = store.plans.get(PLAN_ID);
      const byRule: OrganizingPlanContent['byRule'][number][] = [];
      if (p.byRule !== undefined) {
        for (const [i, e] of arr<Record<string, unknown>>(p.byRule).entries()) {
          const what = text(e.what).trim();
          const targets = arr<string>(e.targets).map((t) => text(t).trim()).filter(Boolean);
          const ruleId = text(e.ruleId).trim();
          const treatment = text(e.treatment).trim();
          if (!what) return fail(`byRule[${i}] says which material it settles (what).`);
          if (targets.length === 0) return fail(`byRule[${i}] names no targets: the directories, files or branches the rule settles, as the project names them — the depth question counts by them.`);
          if (!store.rules.has(ruleId)) return fail(`byRule[${i}].ruleId names no rule in the assets: ${ruleId || '(empty)'}. What the rules settle is settled by a recorded rule: write it first with pk_write_rule.`);
          const refusal = ruleUseRefusal(store, ruleId, 'Validity');
          if (refusal) return fail(`byRule[${i}]: ${refusal}`);
          if (!treatment) return fail(`byRule[${i}] says what the rule makes of it (treatment), e.g. Reference only or History only.`);
          byRule.push({ what, targets, ruleId, treatment });
        }
      }
      const readClosely = arr<Record<string, unknown>>(p.readClosely).map((e) => ({ what: text(e.what).trim(), targets: arr<string>(e.targets).map((t) => text(t).trim()).filter(Boolean), why: text(e.why).trim() }));
      if (readClosely.some((e) => !e.what)) return fail('Each readClosely entry says what is read closely (what).');
      const focus = arr<Record<string, unknown>>(p.focus).map((e) => ({ what: text(e.what).trim(), why: text(e.why).trim(), sourceIds: arr<string>(e.sourceIds).filter((s) => store.sources.has(s)) }));
      if (focus.some((e) => !e.what)) return fail('Each focus entry says where the focus is (what).');
      const order = arr<string>(p.order).map((o) => text(o).trim()).filter(Boolean);
      const content: OrganizingPlanContent = {
        byRule: p.byRule !== undefined ? byRule : previous?.byRule ?? [],
        readClosely: p.readClosely !== undefined ? readClosely : previous?.readClosely ?? [],
        focus: p.focus !== undefined ? focus : previous?.focus ?? [],
        order: p.order !== undefined ? order : previous?.order ?? [],
      };
      if (!previous && !content.byRule.length && !content.readClosely.length && !content.focus.length) return fail('The plan says at least what the rules settle, what is read closely, or where the focus is.');
      let correction: OrganizingPlan['corrections'][number] | null = null;
      if (p.ownerCorrection !== undefined) {
        if (!ctx.ownerSourceId) return fail('Only the owner’s message in the conversation can correct the plan. Rewriting it from a job is an ordinary update; the owner’s corrections stay on record either way.');
        const quote = text(p.ownerCorrection.quote).trim();
        const changed = text(p.ownerCorrection.changed).trim();
        if (!quote || !changed) return fail('ownerCorrection needs the owner’s words (quote) and what they changed (changed).');
        // The owner's first word on it may come before any step wrote a plan: the correction starts it, and what it replaced is nothing.
        correction = { at: now(), sourceId: ctx.ownerSourceId, quote, changed, previous: { byRule: previous?.byRule ?? [], readClosely: previous?.readClosely ?? [], focus: previous?.focus ?? [], order: previous?.order ?? [] } };
      }
      const plan: OrganizingPlan = {
        id: PLAN_ID, projectId: project.id, ...content,
        corrections: [...(previous?.corrections ?? []), ...(correction ? [correction] : [])],
        jobId: ctx.jobId, asOf: now(), updatedAt: now(),
      };
      store.plans.put(plan, trace(correction ? `Organizing plan corrected by the owner: ${correction.changed.slice(0, 100)}` : 'Organizing plan and focus', [...(correction ? [correction.sourceId] : []), ...content.byRule.flatMap((e) => store.rules.get(e.ruleId)?.sourceIds ?? []), ...content.focus.flatMap((f) => f.sourceIds)]));
      saved('plans', PLAN_ID, 'Organizing plan and focus');
      return ok({ id: PLAN_ID, byRule: plan.byRule.length, readClosely: plan.readClosely.length, focus: plan.focus.length, order: plan.order.length, corrections: plan.corrections.length });
    },
  }));

  // ───────────────────────── merging duplicates (Spec §1.4; CKC-06 AC-28) ─────────────────────────

  tools.push(defineTool({
    name: 'pk_merge_work_items', label: 'Merge duplicate work items',
    description: 'At the end of a round, merge work items that turned out to be one unit of work — the same number in the project’s index, the same task under two names. keepId stays; each of mergeIds leaves the work items: its numbers, fact records, facts, what it serves and depends on, and every relation, mark, note, change entry and judgement that named it move to the one kept, and its id still reaches the one kept. This is not a replacement: nothing becomes Replaced. Say why they are one (reason) and what shows it (sourceIds). Before creating a work item, check with pk_find_references (the number) whether it already exists.',
    parameters: Type.Object({ keepId: Type.String(), mergeIds: StrArr, reason: Type.String(), sourceIds: Type.Optional(StrArr) }),
    execute: async (_id, p) => {
      const mergeIds = [...new Set(arr<string>(p.mergeIds).map((m) => text(m).trim()).filter(Boolean))];
      const refusal = mergeRefusal(store, text(p.keepId).trim(), mergeIds, text(p.reason));
      if (refusal) return fail(refusal);
      const outcome = mergeWorkItems(store, {
        projectId: project.id, keepId: text(p.keepId).trim(), mergeIds, reason: text(p.reason).trim(),
        sourceIds: arr<string>(p.sourceIds).filter((s) => store.sources.has(s)), jobId: ctx.jobId,
        // The round the job belongs to: a takeover round is its own record and never a Follow up round (D59 rule 1).
        roundId: takeoverRoundOf(store, ctx.jobId) ?? (text(ctx.roundId) || openRound(store)?.id || null),
      });
      saved('threads', outcome.keptId, `Work thread: ${store.threads.get(outcome.keptId)?.title ?? outcome.keptId}`);
      for (const m of outcome.merged) saved('merges', m, `Merged ${m} into ${outcome.keptId}`);
      return ok(outcome);
    },
  }));

  // ───────────────────────── a decision's carry-out (Spec §2.2; CKC-02 AC-26) ─────────────────────────

  tools.push(defineTool({
    name: 'pk_record_carry_out', label: 'Record whether a decision was carried out',
    description: `For a decision that asks for something to be done (“this endpoint must become asynchronous”, “the old configuration goes with the next release”), record whether it was carried out: ${CARRY_OUT.join(', ')} — Partly carried out says what is still left (remaining). Name the work items that carry it out (workIds): each is linked to the decision by a carries out relation. Give what shows it (evidenceSourceIds); when it concerns what the code does, read the code first. A decision carried out stays Current and is no longer read as a to-do. A decision whose agreed time or condition has passed without it being carried out also gets Layer drift (pk_write_mark). A later call updates the carry-out and gives only what changes: status, remaining, workIds and evidenceSourceIds it leaves out stay as they were; workIds, when given, is the whole list — work no longer named no longer carries it out. The first record of a decision’s carry-out needs status.`,
    parameters: Type.Object({
      decisionId: Type.String(), status: Type.Optional(Type.String({ description: `${CARRY_OUT.join(' | ')} — the first record needs it; a later call keeps it when left out` })), remaining: Type.Optional(Type.String({ description: 'Partly carried out: what is still left' })),
      workIds: Type.Optional(Type.Array(Type.String(), { description: 'the work items that carry it out: the whole list; left out, the ones recorded stay' })), evidenceSourceIds: Type.Optional(StrArr),
      basis: Type.Optional(Type.String({ description: 'Explicit when the material says this work carries the decision out; Inferred (default) when you conclude it' })),
      claim: Type.Optional(Type.String({ description: 'how the work carries it out, for the relation' })),
    }),
    execute: async (_id, p) => {
      const decision = store.reference.get(text(p.decisionId));
      if (!decision) return fail(`unknown decision ${text(p.decisionId)}`);
      if (!isDecision(store, decision.id)) return fail(`${decision.id} (${decision.name}) is a ${decision.category}, not a decision: whether something was carried out is recorded on a decision that asks for it to be done. The progress of a requirement’s work is the progress of its work items.`);
      if (decision.validity !== 'Current') return fail(`${decision.id} (${decision.name}) is ${decision.validity}: a carry-out is recorded on a decision in force.`);
      // A later call gives what changed; what it leaves out stays as the carry-out recorded it.
      const before = decision.carryOut ?? null;
      if (!before && !has(p.status)) throw createNeeds('the carry-out of this decision', `${decision.id} (${decision.name}) has no carry-out recorded yet`, ['status'], 'Give its status; a later call updates the carry-out recorded.');
      const status = has(p.status) ? text(p.status) : before!.status;
      if (!isOneOf(CARRY_OUT, status)) return fail(`status must be one of ${CARRY_OUT.join(', ')}`);
      const remaining = text(p.remaining).trim() || (status === before?.status ? before?.remaining ?? '' : '');
      if (status === 'Partly carried out' && !remaining) return fail('Partly carried out says what is still left (remaining), so the next agent sees what is done and what is not.');
      const workIds = absent(p.workIds) ? [...(before?.workIds ?? [])] : [...new Set(arr<string>(p.workIds).map((w) => resolveMergedId(store, text(w).trim())).filter(Boolean))];
      const unknownWork = workIds.filter((w) => !store.threads.has(w));
      if (unknownWork.length) return fail(`workIds names no work item in the assets: ${unknownWork.join(', ')}`);
      if (status !== 'Not carried out yet' && workIds.length === 0) return fail(`${status} names the work that carries it out (workIds): the work items whose results do what the decision asks. Each is linked to the decision by carries out.`);
      const evidence = absent(p.evidenceSourceIds) ? [...(before?.evidenceSourceIds ?? [])] : arr<string>(p.evidenceSourceIds).filter((s) => store.sources.has(s));
      const at = now();
      for (const workId of workIds) {
        const relId = stableId('rel', 'carries out', workId, decision.id);
        const prev = store.relations.get(relId);
        // A relation already there keeps its claim and basis unless the call gives them.
        const basis = (isOneOf(BASIS, p.basis) ? p.basis : prev?.basis ?? 'Inferred') as 'Explicit' | 'Inferred';
        store.relations.put({
          id: relId, projectId: project.id, type: 'carries out', from: workId, to: decision.id,
          claim: text(p.claim) || prev?.claim || `${store.threads.get(workId)!.title} carries out ${decision.name}`, basis,
          evidence: { sourceIds: evidence, factRecordIds: [], factsSoFar: `${status}${status === 'Partly carried out' && remaining ? `; still left: ${remaining}` : ''}` },
          assessment: prev?.assessment ?? 'Not assessed', assessedAt: prev?.assessedAt ?? null, assessedInJobId: prev?.assessedInJobId ?? null, updatedAt: at,
        }, trace(`carries out: ${workId} → ${decision.id}`, evidence));
      }
      // The work items the carry-out now names are the whole list: work no longer named no longer carries it out.
      for (const dropped of (before?.workIds ?? []).filter((w) => !workIds.includes(w))) {
        store.relations.remove(stableId('rel', 'carries out', dropped, decision.id), trace(`carries out withdrawn: ${dropped} → ${decision.id}`, evidence));
      }
      store.reference.put({ ...decision, carryOut: { status: status as NonNullable<ReferenceItem['carryOut']>['status'], remaining: status === 'Partly carried out' ? remaining : null, workIds, evidenceSourceIds: evidence, at, jobId: ctx.jobId }, updatedAt: at }, trace(`Carry-out of ${decision.name}: ${status}`, evidence));
      saved('reference', decision.id, `Carry-out: ${decision.name}`);
      return ok({ decisionId: decision.id, status, workIds });
    },
  }));

  // ───────────────────────── looking up one's own assets (Spec §3.1; CKC-03 AC-22) ─────────────────────────

  tools.push(defineTool({
    name: 'pk_find_references', label: 'Find what refers to an id',
    description: 'Look up your own assets by id: give a source id or any record id — fact record, reference item, work item, area, relation, change, mark, note, rule — or a number the project uses (a task number), and get short rows (kind, id, name, category, via) of every fact record, reference item, work item, relation, change record, mark, note and rule that cites it or touches it. Read any row in full by its id with pk_read_source or pk_read_assets. This answers from the assets alone: your own records are never looked for in the file system.',
    parameters: Type.Object({ id: Type.String(), limit: Type.Optional(Type.Number({ description: 'most rows to return (default 300)' })) }),
    execute: async (_id, p) => {
      const found = findReferences(store, text(p.id).trim());
      const limit = Math.max(1, Math.min(1000, Number(p.limit) || 300));
      return ok(found.rows.length > limit ? { ...found, rows: found.rows.slice(0, limit), more: found.rows.length - limit } : found);
    },
  }));

  tools.push(...scopeTools(ctx));   // §1.1 the Keeper's word on the project scope (CKC-04 AC-13, AC-16, AC-17)
  tools.push(...historyTools(ctx), ...ownerUtteranceTools(ctx));

  if (ctx.investigate) {
    tools.push(defineTool({
      name: 'pk_investigate', label: 'Delegate a focused investigation',
      description: 'Run a focused investigation in a separate Keeper session: it reads deep material (files, code, history, command output) and returns a conclusion with source ids. Use it when you need details without pulling a long history into this context.',
      parameters: Type.Object({ question: Type.String(), hints: Type.Optional(StrArr) }),
      execute: async (_id, p) => {
        try {
          const result = await ctx.investigate!(p.question, arr<string>(p.hints));
          if (ctx.judgementId) {
            const j = store.judgements.get(ctx.judgementId);
            if (j) store.judgements.put({ ...j, inputs: { ...j.inputs, investigations: [...j.inputs.investigations, { jobId: result.jobId, conclusion: result.conclusion.slice(0, 2000), sourceIds: result.sourceIds }] } });
          }
          return ok(result);
        } catch (e) { return fail((e as Error).message); }
      },
    }));
  }
  return tools;
}

export const NODE_CATEGORIES = NODE_CATEGORY;
export type { GraphNode };
