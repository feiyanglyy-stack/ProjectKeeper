/**
 * The Keeper's position-writing tools for the clerk method (Spec v3.0 §3.3): each step of a round writes its judgements
 * on fixed positions of the workbench — orientation the layer map and the generations, the skeleton the semantic-patch
 * drafts, the Keeper numbers and the process links, the deep sweeps their reports, the cross-check what it confirms and
 * the code territories, synthesis the send-backs and the six things, the spot check what it found; the session drafts
 * are the ground the steps stand on (§3.11).
 *
 * The one rule that shapes every tool: the model never writes a date, a count, a label of evidence or a quoted line the
 * program cannot check. It names references — evidence as `{ kind, id, line? }` (evidence.ts), object ids, message
 * positions — and the program resolves them: it checks they are there, reads their labels and when they happened,
 * assigns numbers, and takes the owner's words out of the session itself.
 *
 * Which step may write which position is the table of §3.3 ("跨对象的记录由哪一步写"); a tool called from another step,
 * or from a job that is no step of a round, refuses and says whose position it is. The spot check may also correct, with
 * these same writers, what it found wrong ("核错的就地改正").
 */
import { join } from 'node:path';
import { laneNamesOf, noteFormRefusal, ownerTextRefusal } from './owner-text.ts';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Ledger } from '../ledger/index.ts';
import type {
  BreakpointKind, ClerkRound, CodeTerritory, EvidenceRef, Generation, KeeperNumber, LayerEntry, LayerKind, LinkCheck, Occurred, OwnerLineKind,
  LaneKind, ProcessLink, RoundDoc, RoundDocKind, RoundStepKind, SemanticPatch, SlotKind, SendBack, SessionDraft, SixThing, SpotCheck, SpotWrongKind, StepKind,
  TerritoryAnomalyKind,
} from '../model/k-types.ts';
import type { WorkThread } from '../model/types.ts';
import { fingerprint, newId, stableId } from '../model/ids.ts';
import { BASIS, SESSION_HOST, isOneOf } from '../model/vocab.ts';
import { Collection } from '../store/project-store.ts';
import { redactCredentials } from '../sources/anchor.ts';
import { isOwnerMessage } from '../sources/sessions/read.ts';
import { ownerUtterances } from '../sources/sessions/utterances.ts';
import { gitTreeEntry } from '../util/git.ts';
import { pathKey, placeUnder } from '../util/paths.ts';
import { isDecision } from './adjustment.ts';
import {
  earliestOccurred, evidenceKey, findObject, parsedSession, pathPresence, resolveEvidence, resolveEvidenceList, resolvePath,
  compareOccurred, type EvidenceContext, type LedgerHook, type ProjectRoot,
} from './evidence.ts';
import { resolveMergedId } from './merge.ts';
import { cliCommandFor } from './sendback-text.ts';
import { absent, createNeeds, has, primaryIdentifier, type ToolContext } from './tools.ts';
import { isNumberShaped } from './numbers-check.ts';
import { definitionsInPath } from '../ledger/numbering.ts';
import { incompleteCall } from './step-timing.ts';
import { sameWords } from './verbatim.ts';
import { CLERK_WRITER_STEPS, DOCS_BY_STEP } from './clerk-steps.ts';
import { deliveryLinksFrom } from '../process/delivery-links.ts';
import { fillTools } from './organize/fill-tools.ts';
import { lightCandidate, lightingRefusal } from '../process/breakpoint-candidates.ts';
import { lookedTools } from './organize/looked-tools.ts';
import { ABSENCE_THINGS, absenceRefusal, lookedLine, lookedRecord, parseLooked, presentOf, stampAsFarAs, type AbsenceLooked } from './organize/absence.ts';
import { checkLink } from './link-check.ts';
import { roundDocRefusal, stepKindAs, writeRefusal } from './organize/stage-gate.ts';
import { isProgramNote, looksAtStandingNotes, standingCounts, standingNotes } from './organize/standing-notes.ts';
import { fullCheckTargets, placementCheckNow, placementCounts } from '../process/breakpoint-candidates.ts';
import { confirmBySpotCheck } from './organize/placement-inference.ts';

/** The tools read the step they write for, and the ledger when the build has one, at call time. */
export interface ClerkToolContext extends ToolContext {
  /**
   * Which step of which round this job is (Spec §3.3); null for a job that is no step of a round. A deep sweep read by
   * reading assignments names its assignment: its report is that assignment's (§3.7).
   */
  step: { readonly roundId: string; readonly kind: RoundStepKind; readonly path: string | null; readonly assignment?: string | null; readonly lane?: { readonly kind: LaneKind; readonly slots: readonly SlotKind[] } | null } | null;
  /** The ledger (§1.16), when this build has one: ledger entries are resolved through it. */
  ledger?: LedgerHook | null;
}

// ───────────────────────── the fixed words, checked against the types ─────────────────────────

const LAYER_KINDS = ['Product', 'PRD', 'Spec', 'Plan', 'Task index', 'Task contract', 'Decision record', 'Execution arrangement', 'QC and receipts', 'Readme', 'Instructions', 'Other'] as const satisfies readonly LayerKind[];
const STEP_KINDS = ['Planned', 'Dispatched', 'Delivered', 'QC', 'Review', 'Walkthrough', 'Fix', 'Merged', 'Accepted', 'Handed in', 'Handed to'] as const satisfies readonly StepKind[];
const ROUND_DOC_KINDS = ['History map', 'Questions', 'Brief', 'Report', 'Adoption', 'Handover', 'Spot check', 'Layers', 'Result'] as const satisfies readonly RoundDocKind[];
const ANOMALY_KINDS = ['Unreferenced', 'Looks residual, is live', 'Built without a claiming work item', 'Docs disagree'] as const satisfies readonly TerritoryAnomalyKind[];
const LINE_KINDS = ['Chat', 'Decision', 'Confirmation'] as const satisfies readonly OwnerLineKind[];
const TERRITORY_KINDS = ['area', 'shared', 'non-product'] as const satisfies readonly CodeTerritory['kind'][];
const SENDBACK_FROM = ['breakpoint', 'verdict', 'owner-judgement', 'code-anomaly'] as const satisfies readonly SendBack['from']['kind'][];
const PATCH_STATUS = ['Draft', 'Confirmed', 'Rejected'] as const satisfies readonly SemanticPatch['status'][];
const NUMBER_KINDS = ['work', 'decision', 'patch', 'other'] as const satisfies readonly KeeperNumber['objectKind'][];
type Complete<All, Listed> = [Exclude<All, Listed>] extends [never] ? true : false;
type Must<T extends true> = T;
/** A word the types add and a list here lacks stops the build here, not in a refusal the model cannot get past. */
export type ClerkVocabularyComplete = [
  Must<Complete<LayerKind, (typeof LAYER_KINDS)[number]>>, Must<Complete<StepKind, (typeof STEP_KINDS)[number]>>,
  Must<Complete<RoundDocKind, (typeof ROUND_DOC_KINDS)[number]>>, Must<Complete<TerritoryAnomalyKind, (typeof ANOMALY_KINDS)[number]>>,
  Must<Complete<OwnerLineKind, (typeof LINE_KINDS)[number]>>, Must<Complete<CodeTerritory['kind'], (typeof TERRITORY_KINDS)[number]>>,
  Must<Complete<SendBack['from']['kind'], (typeof SENDBACK_FROM)[number]>>, Must<Complete<SemanticPatch['status'], (typeof PATCH_STATUS)[number]>>,
  Must<Complete<KeeperNumber['objectKind'], (typeof NUMBER_KINDS)[number]>>,
];

const STEP_NAME: Record<RoundStepKind, string> = {
  main: 'the main agent (one session through the round’s stages)',
  lane: 'a lane the main agent sent',
  ledger: 'the ledger step (step 0, the program’s own)',
  process: 'the process step (the program’s own: each work item’s steps and breakpoints)',
  'session-drafts': 'the session drafts',
  orientation: 'orientation (step 1)',
  skeleton: 'the skeleton (step 2)',
  dig: 'a deep sweep (step 3)',
  'cross-check': 'the cross-check (step 4)',
  synthesis: 'the synthesis (the round’s product look-back, in a session of its own after the main agent)',
  'spot-check': 'the spot check (step 6)',
};

/** The round documents each step leaves behind (§3.3 "留痕点得开"); the layer map is the program's rendering of the layers. */

/** §2.13 the six things, by number. */
const SIX: Record<SixThing, string> = { 1: 'stale', 2: 'drift', 3: 'dropped along the way', 4: 'grown by itself', 5: 'let pass', 6: 'looks residual' };
/** §2.12's table: the breakpoints that are material for one of the six things, and which. */
const BREAKPOINT_THING: Partial<Record<BreakpointKind, SixThing>> = {
  'Not planned': 3, 'No plan': 4, 'Findings open': 5, 'Passed with open items': 5, 'Fix not re-checked': 5, 'Downstream behind': 1, 'Not carried out': 2,
};
/** §2.13's table: the marks that are the position of one of the six things. */
const MARK_THING: Readonly<Record<string, SixThing>> = { 'Suspected stale': 1, 'Layer drift': 2 };
/**
 * §2.13's table, row 6: the code anomalies that are the material of "looks residual" — code nothing references, and code
 * whose name looks residual but that is live (the judgement of the same question, answered the other way).
 */
const ANOMALY_THING: Partial<Record<TerritoryAnomalyKind, SixThing>> = { Unreferenced: 6, 'Looks residual, is live': 6 };

/** One judgement the spot check checked, as the round keeps it. */
type SpotCheckTarget = NonNullable<SpotCheck['targets']>[number];

/**
 * The anomalies that judge code by its references (§1.19, §2.13 row 6): nothing references it; its name looks residual
 * but it is referenced. Where the ledger reads a language's references only file by file, or not at all, such a judgement
 * cannot rest on computed references alone and is `Inferred` whatever basis is given (CKC-25 AC-5; QC AY B13).
 */
const BY_REFERENCES: ReadonlySet<TerritoryAnomalyKind> = new Set<TerritoryAnomalyKind>(['Unreferenced', 'Looks residual, is live']);
/** Languages that are not code: markup, data and prose reference nothing a residual judgement rests on. */

/**
 * Whether the ledger reads the references of a territory's code completely enough for a residual judgement to be
 * Explicit (§1.16, §1.19; CKC-25 AC-5): every code file under its paths has a reader — the TypeScript compiler, or the
 * general code engine for every other language (D98 补) — and none is a file no counted reference reaches that another
 * file names. Measured from the ledger (`Ledger.referenceReach`), not a fixed table per language; `gaps` says why not.
 */
function referenceLevel(storeDir: string, root: ProjectRoot, paths: readonly string[]): { readonly complete: boolean; readonly gaps: readonly string[] } {
  const ledger = Ledger.openDir(storeDir);
  if (!ledger) return { complete: false, gaps: ['the ledger is not built yet'] };
  try { return ledger.referenceReach(root.id, paths); } finally { ledger.close(); }
}

// ───────────────────────── small helpers ─────────────────────────

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const now = () => new Date().toISOString();
const redact = (s: string): string => redactCredentials(s).text;
const clean = (v: unknown): string => redact(text(v)).trim();
const either = (list: readonly string[]): string => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`);
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }], details: {} };
}
function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }], details: {}, isError: true };
}

/** Why fields the program writes may not come in a call, or null. */
function programFields(p: Record<string, unknown>, fields: readonly string[], why: string): string | null {
  const set = fields.filter((f) => p[f] !== undefined);
  if (set.length === 0) return null;
  return `${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} not yours to write: ${why} Leave ${set.length === 1 ? 'it' : 'them'} out; nothing was written.`;
}

/** The next number of a sequence the program keeps (`SP-3` after `SP-2`). */
function nextNumber(prefix: string, taken: readonly (string | null | undefined)[]): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  const top = taken.reduce((max, n) => { const m = re.exec(n ?? ''); return m ? Math.max(max, Number(m[1])) : max; }, 0);
  return `${prefix}-${top + 1}`;
}

const sourceIdsOf = (refs: readonly (EvidenceRef | null | undefined)[]): string[] =>
  [...new Set(refs.flatMap((r) => (r && r.kind === 'source' ? [r.id] : [])))];

const EVIDENCE_HELP = 'Evidence is named, never written out: { kind, id, line? } — kind ledger (a ledger entry id), source (a source id), commit (a commit hash, full or short), file (a path relative to the repository root that exists now or in its history), or object (an id of the assets); repo for a file or a commit in another repository of the scope; line when the evidence is one line (a verdict, a rule, a heading), copied as the original has it — the program checks it is there. The program reads the label and when it happened: never give a date or a label.';
function EvidenceSchema(description: string) {
  return Type.Object({
    kind: Type.String({ description: 'ledger | source | commit | file | object' }),
    id: Type.String({ description: 'ledger entry id, source id, commit hash, repository-relative path, or object id' }),
    line: Type.Optional(Type.String({ description: 'one line of it, copied as the original has it; the program checks it is there' })),
    repo: Type.Optional(Type.String({ description: 'a file or commit in another repository of the scope: its scope item id or path' })),
  }, { description });
}

// ───────────────────────── the session as the program reads it (§3.11) ─────────────────────────

interface HeardLine {
  /** The message's position in the session (its [n] in the transcript), as text. */
  readonly ref: string;
  readonly at: string;
  readonly text: string;
  /** The agent message just before it, verbatim: what a short "yes" answers. */
  readonly before: string | null;
}
interface HeardSession {
  readonly file: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly lines: readonly HeardLine[];
  /** Every message's time by its position, for agent summaries that point at one. */
  readonly times: ReadonlyMap<number, string | null>;
  readonly readFrom: 'session log' | 'transcripts in the assets' | 'Keeper conversation';
  readonly sourceIds: readonly string[];
}

/** A header of the transcript a session source holds (sources/sessions/read.ts `renderMessage`). */
const HEADER_LINE = /^\[(\d+)\] (OWNER|SUBAGENT TASK|SUBAGENT|HOST|AGENT)(?: \([^)\n]*\))?(?: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}))?[ \t]*$/gm;

// ───────────────────────── the tools ─────────────────────────

export function clerkTools(ctx: ClerkToolContext): ToolDefinition[] {
  const { store, project } = ctx;
  const ev: EvidenceContext = ctx;
  const trace = (summary: string, basisSourceIds: readonly string[] = []) => ({ jobId: ctx.jobId, basisSourceIds, summary });
  const saved = (collection: string, id: string, label: string) => ctx.onSaved?.(collection, id, label);

  /** Why this job may not write this position, or null (§3.3). */
  const gate = (tool: string, allowed: readonly RoundStepKind[], what: string): string | null => {
    const step = ctx.step;
    if (!step) return `${tool} writes ${what}, a position of a round of the clerk method, and this job is no step of a round, so nothing was written.`;
    // D99: the main job writes by the stage its round is in, a lane by its slots (stage-gate.ts; E148 D-a).
    if (step.kind === 'main' || step.kind === 'lane') return writeRefusal(store, step, tool);
    if (!allowed.includes(step.kind)) return `${tool} writes ${what}, which ${either(allowed.map((k) => STEP_NAME[k]))} writes; this job is ${STEP_NAME[step.kind]}, so nothing was written.`;
    return null;
  };
  const roundId = (): string | null => ctx.step?.roundId ?? null;
  const occurredOrSeen = (ref: EvidenceRef): Occurred => ref.occurred ?? { at: now(), basis: 'First observed', anchor: ref.id, undated: true };

  const tools: ToolDefinition[] = [];

  // ───────────────────────── 1 · orientation: which file is which layer ─────────────────────────

  tools.push(defineTool({
    name: 'pk_write_layers', label: 'Map the documents to their layers',
    description: `Orientation: which document is which layer of the project’s chain — ${LAYER_KINDS.join(', ')} — and whether it is the one the project works to now. The map shows in Project scope and the skeleton builds the chain from it. One entry per document (a directory when the project keeps a layer as one, e.g. a folder of task contracts); mapping a path again updates it and gives only what changes (layer, current and note left out stay as mapped). A new entry needs layer and current. The path must exist in the repository now or in its history: a deleted or superseded plan is mapped with current: false. Map the documents the chain is made of, not every file; code is mapped as code territories in the cross-check. note: one line on what makes it that layer, when the name does not say.`,
    parameters: Type.Object({
      entries: Type.Array(Type.Object({
        path: Type.String({ description: 'relative to the repository root' }),
        repo: Type.Optional(Type.String({ description: 'another repository or directory of the scope: its scope item id or path' })),
        layer: Type.Optional(Type.String({ description: `${LAYER_KINDS.join(' | ')} — a new entry needs it` })),
        note: Type.Optional(Type.String()),
        current: Type.Optional(Type.Boolean({ description: 'true: the version the project works to now; false: an earlier or superseded document of that layer — a new entry needs it' })),
      })),
    }),
    execute: async (_id, p) => {
      const refusal = gate('pk_write_layers', CLERK_WRITER_STEPS.pk_write_layers, 'the layer map');
      if (refusal) return fail(refusal);
      const entries = arr<Record<string, unknown>>(p.entries);
      if (entries.length === 0) return fail('entries is empty: give each document of the chain with its layer.');
      const written: Record<string, unknown>[] = [];
      const refused: string[] = [];
      // Entries that would map a new path but leave out what a new entry needs: when nothing else is written, the call
      // is refused as incomplete, as pi refused it while the schema required layer and current.
      let incomplete = 0;
      for (const [i, e] of entries.entries()) {
        if (has(e.layer) && !isOneOf(LAYER_KINDS, text(e.layer))) { refused.push(`entries[${i}] (${text(e.path)}): layer must be one of ${LAYER_KINDS.join(', ')}`); continue; }
        if (!absent(e.current) && typeof e.current !== 'boolean') { refused.push(`entries[${i}] (${text(e.path)}): say whether it is the current one (current: true or false)`); continue; }
        const place = resolvePath(project, { path: text(e.path), repo: text(e.repo) });
        if (typeof place === 'string') { refused.push(`entries[${i}]: ${place}`); continue; }
        if (!place.rel) { refused.push(`entries[${i}]: give a path inside ${place.root.path}`); continue; }
        const presence = pathPresence(place.root, place.rel);
        if (!presence) { refused.push(`entries[${i}]: ${place.rel} is not in ${place.root.path} now, and no commit in its history touched that path`); continue; }
        const id = stableId('layer', project.id, pathKey(`${place.root.path}/${place.rel}`));
        const previous = store.layers.get(id);
        const missing = previous ? [] : [...(has(e.layer) ? [] : ['layer']), ...(typeof e.current === 'boolean' ? [] : ['current'])];
        if (missing.length) {
          incomplete += 1;
          refused.push(`entries[${i}] (${place.rel}): not mapped yet, so this entry would map it, and a new entry needs ${missing.join(' and ')}, which it leaves out; to update an entry, give the path it has`);
          continue;
        }
        const layer = (has(e.layer) ? text(e.layer) : previous!.layer) as LayerEntry['layer'];
        const current = typeof e.current === 'boolean' ? e.current : previous!.current;
        const entry: LayerEntry = { id, projectId: project.id, repo: place.root.path, path: place.rel, layer, note: clean(e.note) || previous?.note || null, current, roundId: roundId(), updatedAt: now() };
        store.layers.put(entry, trace(`Layer: ${place.rel} is ${layer}${current ? '' : ' (not current)'}${presence === 'history' ? ', only in history' : ''}`));
        saved('layers', id, `Layer: ${place.rel} · ${layer}`);
        written.push({ id, path: place.rel, layer, current, ...(presence === 'history' ? { onlyInHistory: true } : {}), ...(previous ? { updated: true } : {}) });
      }
      if (written.length === 0 && incomplete > 0) throw incompleteCall(`${refused.join('\n')}\nNothing was written. An update of an entry gives only what changes: what it leaves out keeps its value.`);
      if (written.length === 0) return fail(`Nothing was written:\n${refused.join('\n')}`);
      return ok({ written: written.length, entries: written, ...(refused.length ? { refused } : {}) });
    },
  }));

  // ───────────────────────── 2 · orientation / skeleton: generations of the plan ─────────────────────────

  tools.push(defineTool({
    name: 'pk_write_generation', label: 'Record an earlier generation of plans',
    description: 'Orientation or skeleton: an earlier generation of the project’s plans, shown rolled up before the current plan and read like the current one when unrolled — so the owner can see which code and work came from plans that were later replaced. Cut a generation only where the material itself names one: a version that replaced the plans, a restart, a cleanup, a decision that ended it. Never infer a generation from reading the history, and never draw date ranges of your own. ended is the evidence of what ended it — the decision’s line, the cleanup commit, the ledger entry; its date is read from there. started, when the material says what began it. planRefs are its plan documents (a deleted one is cited as a file that exists in history, or by the History only source pk_history_read gives); workIds the work items planned in it. A generation with the same name (or its id) is updated: an update gives only what it changes, and what it leaves out keeps its value. A new generation needs name, ended and planRefs. ' + EVIDENCE_HELP,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: 'an existing generation to update' })),
      name: Type.Optional(Type.String({ description: 'the material’s own name for it, e.g. "Roadmap v1"; a new generation needs it, and it finds the one already recorded under that name' })),
      ended: Type.Optional(EvidenceSchema('what ended it, where the material says so; a new generation needs it')),
      started: Type.Optional(EvidenceSchema('what began it, where the material says so')),
      planRefs: Type.Optional(Type.Array(EvidenceSchema('one of its plan documents'), { description: 'its plan documents; a new generation needs them' })),
      workIds: Type.Optional(Type.Array(Type.String(), { description: 'the work items planned in it' })),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const refusal = gate('pk_write_generation', CLERK_WRITER_STEPS.pk_write_generation, 'a generation of the plans');
      if (refusal) return fail(refusal);
      const fields = programFields(p, ['endedBy', 'occurred', 'updatedAt'], 'what ended a generation is the evidence given as ended, and its date is read from that evidence.');
      if (fields) return fail(fields);
      const given = text(p.id).trim();
      const named = given ? store.generations.get(given) : undefined;
      if (given && !named) return fail(`${given} is not a generation of this project; leave id out to record a new one.`);
      // The one to update: the id given, or the generation recorded under the same name.
      const previous = named ?? (clean(p.name) ? store.generations.get(stableId('gen', project.id, squash(clean(p.name)))) : undefined);
      if (ctx.step?.kind === 'spot-check' && !previous) return fail('The spot check corrects the generations it checked: give the id of the one to correct.');
      if (!previous) {
        const missing = [...(clean(p.name) ? [] : ['name']), ...(absent(p.ended) ? ['ended'] : []), ...(absent(p.planRefs) ? ['planRefs'] : [])];
        if (missing.length) throw createNeeds('a generation', clean(p.name) ? `No generation is recorded as “${clean(p.name)}”` : 'This call names no recorded generation (no id, and no name to find one by)', missing, 'To update a generation, give its id, or its name as recorded.');
      }
      const name = clean(p.name) || previous?.name || '';
      const endedBy = absent(p.ended) ? previous!.endedBy : resolveEvidence(ev, p.ended, 'ended');
      if (typeof endedBy === 'string') return fail(endedBy);
      // started left out keeps what began it; given as null, the generation has no recorded start.
      const startedBy = p.started === undefined || p.started === null ? null : resolveEvidence(ev, p.started, 'started');
      if (typeof startedBy === 'string') return fail(startedBy);
      const ended = absent(p.ended) ? previous!.ended : occurredOrSeen(endedBy);
      const started = p.started === undefined ? previous?.started ?? null : startedBy ? occurredOrSeen(startedBy) : null;
      if (started && !started.undated && !ended.undated && compareOccurred(started, ended) > 0) {
        return fail(`started (${startedBy?.label ?? 'as recorded'}, ${started.at}) comes after ended (${endedBy.label}, ${ended.at}): a generation ends after it begins. Check which evidence began it and which ended it.`);
      }
      const planRefs = absent(p.planRefs) ? [...previous!.planRefs] : resolveEvidenceList(ev, p.planRefs, 'planRefs');
      if (typeof planRefs === 'string') return fail(planRefs);
      const workIds = absent(p.workIds) ? [...(previous?.workIds ?? [])] : [...new Set(arr<string>(p.workIds).map((w) => resolveMergedId(store, text(w).trim())).filter(Boolean))];
      const unknown = workIds.filter((w) => !store.threads.has(w));
      if (unknown.length) return fail(`workIds names no work item of the assets: ${unknown.join(', ')}.`);
      const id = previous?.id ?? stableId('gen', project.id, squash(name));
      const before = store.generations.get(id);
      const generation: Generation = { id, projectId: project.id, name, started, ended, endedBy, planRefs, workIds, roundId: roundId(), updatedAt: now() };
      store.generations.put(generation, trace(`Generation “${name}”: ended ${ended.at} (${endedBy.label})`, sourceIdsOf([endedBy, startedBy, ...planRefs])));
      saved('generations', id, `Generation: ${name}`);
      return ok({ id, name, ended, started, endedBy: endedBy.label, planRefs: planRefs.length, workIds: workIds.length, updated: Boolean(before) });
    },
  }));

  // ───────────────────────── 3 · every step: what the round leaves behind ─────────────────────────

  tools.push(defineTool({
    name: 'pk_write_round_doc', label: 'Write a document of this round',
    description: 'What a round leaves behind, in full, openable under the round in the Keeper view: orientation writes the Questions of this round, the History map, and one Brief per deep sweep (path: the sweep’s name; its six parts: shared background and what not to report, hard rules, what to read, the three verdicts, clues to watch, how to report); a deep sweep writes its own Report (complete and densely cited, never a short result) — with a reading assignment, the report of that assignment, and in unread what on its list it could not read in full (the material’s key, part or none, and why); the cross-check writes the Adoption record (which conclusions it adopted, which not, and why); the synthesis writes the round’s Result; the spot check writes its Spot check, and corrects a Result whose claims it found wrong by writing it again. The main agent’s Handover is written by pk_stage as it hands over, not here. Give the full text — it is kept as written, never shortened. Writing the same kind (and sweep, and assignment) again in this round replaces it and gives only what changes: a title, text or unread list left out stays as written. A new document needs title and markdown. Counts and dates the program keeps are not written here as facts of your own.',
    parameters: Type.Object({
      kind: Type.String({ description: 'Questions | History map | Brief | Report | Adoption | Result | Spot check' }),
      path: Type.Optional(Type.String({ description: 'the deep sweep’s name: for a Brief and a Report only' })),
      title: Type.Optional(Type.String({ description: 'what this document is, in a few words; a new document needs it' })),
      markdown: Type.Optional(Type.String({ description: 'the full text; a new document needs it' })),
      unread: Type.Optional(Type.Array(Type.Object({
        material: Type.String({ description: 'the material’s key, as your assignment lists it in brackets' }),
        read: Type.String({ description: 'part (you read some of it) | none' }),
        why: Type.String({ description: 'why it could not be read in full' }),
      }), { description: 'a Report of a reading assignment: what on its list you could not read in full' })),
    }),
    execute: async (_id, p) => {
      const step = ctx.step;
      if (!step) return fail('pk_write_round_doc writes a document of a round of the clerk method, and this job is no step of a round, so nothing was written.');
      const kind = text(p.kind);
      if (!isOneOf(ROUND_DOC_KINDS, kind)) return fail(`kind must be one of ${ROUND_DOC_KINDS.filter((k) => k !== 'Layers' && k !== 'Handover').join(', ')}.`);
      if (kind === 'Layers') return fail('The layer map is written entry by entry with pk_write_layers; its document is the program’s rendering of those entries.');
      // D103: the handover is the main agent's, written by pk_stage as it hands the round over.
      if (kind === 'Handover' && step.kind !== 'main') return fail('The Handover is the main agent’s, written as it hands the round over to the synthesis (pk_stage to synthesis with handover); read it with pk_read_assets kind roundDoc. Nothing was written.');
      const allowed = DOCS_BY_STEP[step.kind] ?? [];
      const byStage = step.kind === 'main' || step.kind === 'lane' ? roundDocRefusal(store, step, kind) : null;
      if (byStage) return fail(byStage);
      if (step.kind !== 'main' && step.kind !== 'lane' && !allowed.includes(kind)) {
        const owner = (Object.entries(DOCS_BY_STEP) as [RoundStepKind, readonly RoundDocKind[]][]).filter(([, kinds]) => kinds.includes(kind)).map(([k]) => STEP_NAME[k]);
        return fail(`${STEP_NAME[step.kind]} writes ${allowed.length ? either([...allowed]) : 'no round document'}; a ${kind} is written by ${either(owner)}. Nothing was written.`);
      }
      let path = clean(p.path) || null;
      if (kind === 'Report') {
        if (!step.path) return fail('This deep sweep has no name, so there is no sweep to file a report under.');
        if (path && path !== step.path) return fail(`A deep sweep writes its own report: this one is “${step.path}”, and “${path}” is another sweep’s. Nothing was written.`);
        path = step.path;
      } else if (kind === 'Brief') {
        if (!path) return fail('A Brief is the task of one deep sweep: give the sweep’s name in path.');
      } else if (path) {
        return fail(`path names a deep sweep and belongs on a Brief or a Report; a ${kind} is one for the whole round — leave path out.`);
      }
      // A reading assignment's report is that assignment's, beside the sweep's other assignments' (§3.7), and says what
      // on its list it could not read in full; the program holds that against what its recorded reads show.
      const assignment = kind === 'Report' ? step.assignment ?? null : null;
      const id = assignment ? stableId('rdoc', step.roundId, kind, path ?? '', assignment) : stableId('rdoc', step.roundId, kind, path ?? '');
      const previous = store.roundDocs.get(id);
      // The spot-check corrects the Result the synthesis wrote; it writes none of its own (D103).
      if (step.kind === 'spot-check' && kind === 'Result' && !previous) return fail('The spot check corrects the round’s Result where a claim in it is wrong; this round has no Result to correct, and the spot check writes none of its own. Nothing was written.');
      if (!previous) {
        const missing = [...(absent(p.title) ? ['title'] : []), ...(absent(p.markdown) ? ['markdown'] : [])];
        if (missing.length) throw createNeeds(`a ${kind} document`, `This round has no ${kind} document${path ? ` for “${path}”` : ''}${assignment ? ` of assignment ${assignment}` : ''} yet`, missing, `To replace the one written, write the same kind${kind === 'Brief' ? ' and path' : ''} again in this round.`);
      }
      const title = clean(p.title) || previous?.title || '';
      if (!title) return fail('title: what this document is, in a few words.');
      const markdown = absent(p.markdown) ? previous!.markdown : redact(text(p.markdown));
      if (!markdown.trim()) return fail('markdown is empty: give the document’s full text.');
      // The round's Result is read by the owner (§6.13, D105; CKC-08 AC-27): no store ids, no lane named as a lane, no
      // section of a lane's report or brief. The round's other documents are the agents' own and keep theirs.
      if (kind === 'Result') {
        const unreadable = ownerTextRefusal('The round’s Result', { title, markdown }, laneNamesOf(store));
        if (unreadable) return fail(unreadable);
      }
      const unread: { material: string; read: 'part' | 'none'; why: string }[] = Array.isArray(p.unread) ? [] : [...(previous?.unread ?? [])];
      if (Array.isArray(p.unread) && p.unread.length) {
        if (!assignment) return fail('unread belongs to the report of a reading assignment: this job has no assignment, so nothing was written.');
        const listed = new Set((ctx.materials ?? []).map((m) => m.key));
        for (const u of p.unread as { material?: unknown; read?: unknown; why?: unknown }[]) {
          const material = clean(text(u.material)).replace(/^\[|\]$/g, '');
          const read = clean(text(u.read)).toLowerCase();
          const why = clean(text(u.why));
          if (!listed.has(material)) return fail(`unread: “${material}” is not on this assignment's list; name a material by the key your list gives it in brackets. Nothing was written.`);
          if (read !== 'part' && read !== 'none') return fail(`unread: read is part or none (for ${material}). Nothing was written.`);
          if (!why) return fail(`unread: say why ${material} could not be read in full. Nothing was written.`);
          unread.push({ material, read, why });
        }
      }
      // A Result the spot-check corrects stays the synthesis' document: the correction is in the trace, under the spot-check's job.
      const writer = step.kind === 'spot-check' && kind === 'Result' ? previous?.jobId ?? ctx.jobId : ctx.jobId;
      const doc: RoundDoc = { id, projectId: project.id, roundId: step.roundId, jobId: writer, kind, path, title, markdown, at: now(), ...(assignment ? { assignment } : {}), ...(unread.length ? { unread } : {}) };
      const chars = [...markdown].length;
      store.roundDocs.put(doc, trace(`${previous ? 'Replaced' : 'Wrote'} ${kind}${path ? ` · ${path}` : ''}: ${title} (${chars} characters, ${fingerprint(markdown).slice(0, 23)})`));
      const round = store.clerkRounds.get(step.roundId);
      if (round && kind === 'Questions' && round.questionsDocId !== id) {
        store.clerkRounds.put({ ...round, questionsDocId: id, updatedAt: now() }, trace(`Round ${round.number}: its questions are ${id}`));
      }
      if (round && kind === 'Brief' && path && !round.paths.includes(path)) {
        store.clerkRounds.put({ ...round, paths: [...round.paths, path], updatedAt: now() }, trace(`Round ${round.number}: deep sweep “${path}”`));
      }
      saved('roundDocs', id, `${kind}${path ? ` · ${path}` : ''}: ${title}`);
      // E153: the Result of a deepening or a Follow up reports what became of the notes standing from earlier rounds; the
      // program's count comes back with the write, and says when some still have no result.
      const standing = round && kind === 'Result' && step.kind === 'synthesis' ? standingCounts(store, round) : null;
      return ok({
        id, kind, path, chars, replaced: Boolean(previous), ...(assignment ? { assignment, unread: unread.length } : {}),
        ...(standing?.standing ? { standingNotes: standing, ...(standing.open ? { note: `${standing.open} of the ${standing.standing} notes standing from earlier rounds have no result yet (pk_round_state { list: "standingNotes" }): confirm, update or withdraw each, then give the three counts in the Result as the program counts them.` } : {}) } : {}),
      });
    },
  }));

  // ───────────────────────── 4 · skeleton / cross-check: semantic patches ─────────────────────────

  /** Ids the patch's `affects` may name: the documents, plans, work items and code territories of the assets. */
  const affectedRefusal = (ids: readonly string[]): string | null => {
    const known = (id: string) => store.nodes.has(id) || store.reference.has(id) || store.threads.has(id) || store.areas.has(id)
      || store.territories.has(id) || store.layers.has(id) || store.generations.has(id) || store.sources.has(id);
    const unknown = ids.filter((id) => !known(id));
    return unknown.length ? `affects names what is not in the assets: ${unknown.join(', ')}. Give the ids of the documents (reference items, layer entries or sources), plans, work items and code territories it affects; say the rest in affectsText.` : null;
  };

  tools.push(defineTool({
    name: 'pk_write_patch', label: 'Draft or confirm a semantic patch',
    description: 'A semantic patch: what a change of meaning in the docs withdrew and what took its place. It comes only from an explicit supersession written in the material — superseded by, replaced by, deprecated, 取代, 作废, V1 → V2, a row of the project’s own list of corrected rules — never from a paragraph whose meaning you think drifted (for that, a Suspected stale mark). The skeleton drafts it; the cross-check confirms or rejects it (status) or corrects it; the spot check corrects one it found wrong. Answer four things: which part of the old state no longer holds (invalidated), what replaces it (replacedBy — say so when nothing does), who is affected (affects: ids of documents, plans, work items, code territories; affectsText in words), what must never again pass as current (mustNotPassAsCurrent). Cite the decision, do not repeat its reasons. candidate is the explicit supersession it comes from: a ledger entry, or while this build has no ledger the file (or source, or commit) and the line that says it. oldAnchor is where the old state is written, newAnchor where the new one is. partial: true when only part of the old state is withdrawn. The program gives the number (SP-n) and reads when it happened from the candidate; the same candidate and old anchor are the same patch. ' + EVIDENCE_HELP,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: 'the patch to edit or confirm: its id or its number (SP-n)' })),
      title: Type.Optional(Type.String()),
      invalidated: Type.Optional(Type.String({ description: 'which part of the old state no longer holds' })),
      replacedBy: Type.Optional(Type.String({ description: 'what replaces it; say so when nothing does' })),
      affects: Type.Optional(Type.Array(Type.String(), { description: 'ids of the documents, plans, work items and code territories affected' })),
      affectsText: Type.Optional(Type.String({ description: 'who is affected, in words' })),
      mustNotPassAsCurrent: Type.Optional(Type.String({ description: 'what must never again pass as current' })),
      candidate: Type.Optional(EvidenceSchema('the explicit supersession it comes from')),
      oldAnchor: Type.Optional(EvidenceSchema('where the old state is written')),
      newAnchor: Type.Optional(EvidenceSchema('where the new state is written, when it is')),
      decision: Type.Optional(EvidenceSchema('the decision or commit that replaced it')),
      partial: Type.Optional(Type.Boolean({ description: 'true when only part of the old state is withdrawn and the rest stays current' })),
      status: Type.Optional(Type.String({ description: 'cross-check and spot check: Confirmed | Rejected (a patch the skeleton writes is a Draft)' })),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const refusal = gate('pk_write_patch', CLERK_WRITER_STEPS.pk_write_patch, 'a semantic patch');
      if (refusal) return fail(refusal);
      const asStep = stepKindAs(store, ctx.step);
      // A lane drafts, as the skeleton did (D99).
      const step = asStep === 'lane' ? 'skeleton' : asStep;
      const fields = programFields(p, ['number', 'occurred', 'writtenToFolder', 'updatedAt'], 'the program numbers a patch, reads when it happened from its candidate, and records its writing to the project folder.');
      if (fields) return fail(fields);
      const status = p.status === undefined ? null : text(p.status);
      if (status !== null && !isOneOf(PATCH_STATUS, status)) return fail(`status must be one of ${PATCH_STATUS.join(', ')}.`);
      if (step === 'skeleton' && status !== null && status !== 'Draft') return fail('The skeleton drafts a patch; whether it holds is the cross-check’s to say. Leave status out.');
      const given = text(p.id).trim();
      const named = given ? store.patches.get(given) ?? store.patches.find((x) => x.number === given) : undefined;
      if (given && !named) return fail(`${given} is not a semantic patch of this project; leave id out to draft a new one.`);
      if (step === 'spot-check' && !named) return fail('The spot check corrects the patches it checked: give the id of the one to correct.');
      const resolveOptional = (value: unknown, label: string, kept: EvidenceRef | null): EvidenceRef | null | string =>
        value === undefined ? kept : value === null ? null : resolveEvidence(ev, value, label);
      const candidate = resolveOptional(p.candidate, 'candidate', named?.candidate ?? null);
      if (typeof candidate === 'string') return fail(candidate);
      if (!candidate) return fail('candidate: the explicit supersession this patch comes from — a ledger entry, or while this build has no ledger the file (or source, or commit) and the line that says it. A patch no written supersession backs is not one: a paragraph whose meaning may have changed gets Suspected stale instead.');
      if (p.candidate !== undefined) {
        if (candidate.kind === 'object') return fail('candidate is an explicit supersession in the material (a ledger entry, or a file, source or commit and its line); an object of the assets is the Keeper’s record, not the material.');
        if (ctx.ledger && candidate.kind !== 'ledger') return fail('This build has the ledger: the candidate is its explicit-supersession entry (kind ledger), which the ledger found in the material.');
        if (candidate.kind !== 'ledger' && !candidate.line) return fail(`candidate names ${candidate.label} but not the line that says the supersession: give the line, copied as it stands, so the program can check it is there.`);
      }
      const oldAnchor = resolveOptional(p.oldAnchor, 'oldAnchor', named?.oldAnchor ?? null);
      if (typeof oldAnchor === 'string') return fail(oldAnchor);
      if (!oldAnchor) return fail('oldAnchor: where the old state is written (the file and line, the source, the version in history).');
      const newAnchor = resolveOptional(p.newAnchor, 'newAnchor', named?.newAnchor ?? null);
      if (typeof newAnchor === 'string') return fail(newAnchor);
      const decision = resolveOptional(p.decision, 'decision', named?.decision ?? null);
      if (typeof decision === 'string') return fail(decision);
      const id = named?.id ?? stableId('patch', project.id, evidenceKey(candidate), evidenceKey(oldAnchor));
      const existing = named ?? store.patches.get(id);
      const words = {
        title: clean(p.title) || existing?.title || '',
        invalidated: clean(p.invalidated) || existing?.invalidated || '',
        replacedBy: clean(p.replacedBy) || existing?.replacedBy || '',
        affectsText: clean(p.affectsText) || existing?.affectsText || '',
        mustNotPassAsCurrent: clean(p.mustNotPassAsCurrent) || existing?.mustNotPassAsCurrent || '',
      };
      const missing = Object.entries(words).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) return fail(`A semantic patch answers four things and has a title; missing: ${missing.join(', ')}. invalidated: which part of the old state no longer holds; replacedBy: what replaces it; affectsText (and affects): who is affected; mustNotPassAsCurrent: what must never again pass as current.`);
      const affects = p.affects === undefined ? [...(existing?.affects ?? [])] : [...new Set(arr<string>(p.affects).map((a) => resolveMergedId(store, text(a).trim())).filter(Boolean))];
      const affectsProblem = affectedRefusal(affects);
      if (affectsProblem) return fail(affectsProblem);
      const partial = typeof p.partial === 'boolean' ? p.partial : existing?.partial ?? false;
      const content = { ...words, affects, partial, candidate: evidenceKey(candidate), oldAnchor: evidenceKey(oldAnchor), newAnchor: newAnchor ? evidenceKey(newAnchor) : null, decision: decision ? evidenceKey(decision) : null };
      const before = existing ? { title: existing.title, invalidated: existing.invalidated, replacedBy: existing.replacedBy, affectsText: existing.affectsText, mustNotPassAsCurrent: existing.mustNotPassAsCurrent, affects: existing.affects, partial: existing.partial, candidate: evidenceKey(existing.candidate), oldAnchor: evidenceKey(existing.oldAnchor), newAnchor: existing.newAnchor ? evidenceKey(existing.newAnchor) : null, decision: existing.decision ? evidenceKey(existing.decision) : null } : null;
      const changed = !before || JSON.stringify(before) !== JSON.stringify(content);
      // The skeleton's writing is a draft; a draft it only repeats keeps what the cross-check said of it. The cross-check's
      // own new patch is one it checked; an edit keeps its status unless the call gives one.
      const nextStatus: SemanticPatch['status'] = step === 'skeleton'
        ? (existing && !changed ? existing.status : 'Draft')
        : (status as SemanticPatch['status'] | null) ?? existing?.status ?? (step === 'cross-check' ? 'Confirmed' : 'Draft');
      const number = existing?.number ?? nextNumber('SP', store.patches.all().map((x) => x.number));
      const patch: SemanticPatch = {
        id, projectId: project.id, number, ...words, affects, oldAnchor, newAnchor, decision, candidate, partial,
        occurred: occurredOrSeen(candidate), status: nextStatus, writtenToFolder: existing?.writtenToFolder ?? null,
        roundId: existing?.roundId ?? roundId(), jobId: existing?.jobId ?? ctx.jobId, updatedAt: now(),
      };
      store.patches.put(patch, trace(`${existing ? 'Semantic patch updated' : 'Semantic patch drafted'} ${number} (${nextStatus}): ${words.title}`, sourceIdsOf([candidate, oldAnchor, newAnchor, decision])));
      saved('patches', id, `${number} ${words.title}`);
      return ok({ id, number, status: nextStatus, occurred: patch.occurred, partial, created: !existing, ...(existing && !changed && step === 'skeleton' ? { note: 'Nothing in it changed, so it keeps its status.' } : {}) });
    },
  }));

  // ───────────────────────── 5 · skeleton: Keeper numbers ─────────────────────────

  /** Whether a number is written somewhere in the project's material the assets hold (as the program reads numbers). */
  const numberInMaterial = (number: string): boolean => {
    const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const token = new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_])`, 'u');
    return store.sources.find((s) => s.ids.some((x) => x.toUpperCase() === number.toUpperCase()) || token.test(s.excerpt)) !== undefined;
  };

  tools.push(defineTool({
    name: 'pk_number', label: 'Give a Keeper number',
    description: 'Skeleton: a number for a unit of work, a decision or another object the project did not number, so it can be named the same way everywhere — the workbench shows it as the Keeper’s. Give objectId and objectKind (work, decision, patch or other); the program gives the next K-n. An object the project already numbers keeps the project’s number: it is returned and nothing is recorded. When the project later numbers something the Keeper had numbered, record it with objectId and projectNumber: the project’s number wins and the Keeper’s stays as an alias. Never make up a number, and never write one in place of the program’s.',
    parameters: Type.Object({
      objectId: Type.String(),
      objectKind: Type.Optional(Type.String({ description: 'work | decision | patch | other — to number an object the project did not number' })),
      projectNumber: Type.Optional(Type.String({ description: 'the number the project itself gave it later, as its material writes it' })),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const refusal = gate('pk_number', CLERK_WRITER_STEPS.pk_number, 'a Keeper number');
      if (refusal) return fail(refusal);
      const fields = programFields(p, ['number'], 'the program gives the next Keeper number.');
      if (fields) return fail(fields);
      const rawId = text(p.objectId).trim();
      const kindGiven = text(p.objectKind).trim();
      const projectNumber = text(p.projectNumber).trim();
      if (!kindGiven && !projectNumber) return fail('Give objectKind to number an object the project did not number, or projectNumber to record the number the project gave it later.');
      if (kindGiven && !isOneOf(NUMBER_KINDS, kindGiven)) return fail(`objectKind must be one of ${NUMBER_KINDS.join(', ')}.`);
      const id = resolveMergedId(store, rawId);
      const thread = store.threads.get(id);
      const patch = store.patches.get(id) ?? store.patches.find((x) => x.number === rawId);
      const ref = store.reference.get(store.nodes.get(id)?.refId ?? id);
      const found = findObject(store, id);
      if (!found || store.sources.has(id)) return fail(`${rawId} is not an object of this project’s assets that can carry a number.`);
      const actual: KeeperNumber['objectKind'] = thread ? 'work' : patch ? 'patch' : ref && isDecision(store, ref.id) ? 'decision' : 'other';
      if (kindGiven && kindGiven !== actual) return fail(`${rawId} (${found.label}) is ${actual === 'work' ? 'a work item' : actual === 'decision' ? 'a decision' : actual === 'patch' ? 'a semantic patch' : 'neither a work item, a decision nor a patch'}: its objectKind is ${actual}.`);
      const objectId = patch?.id ?? found.id;
      // The project's own number: its first id, or the identifier its name starts with (as the writers read it).
      const numbered = thread ? { ids: thread.ids, name: thread.title } : ref ? { ids: ref.ids, name: ref.name } : null;
      const own = numbered ? primaryIdentifier(numbered.ids, numbered.name) ?? numbered.ids[0] ?? null : null;
      const existing = store.numbers.find((n) => n.objectId === objectId);
      if (projectNumber) {
        if (!existing) return fail(`${rawId} has no Keeper number to keep as an alias${own ? `; the project numbers it ${own}` : ''}. A number the project gave from the start belongs in the object’s own ids (pk_write_thread or pk_write_reference ids).`);
        if (existing.projectNumber === projectNumber) return ok({ objectId, number: projectNumber, alias: existing.number, recorded: false });
        if (!numberInMaterial(projectNumber)) return fail(`${projectNumber} is written nowhere in the project’s material the assets hold, so it cannot be recorded as the project’s number. A project number is the project’s own: it is recorded once the material that gives it has been read.`);
        const clash = store.threads.find((t) => t.id !== objectId && t.ids.some((x) => x.toUpperCase() === projectNumber.toUpperCase()))
          ?? store.reference.find((r) => r.id !== objectId && r.ids.some((x) => x.toUpperCase() === projectNumber.toUpperCase()));
        const clashNumber = store.numbers.find((n) => n.objectId !== objectId && n.projectNumber === projectNumber);
        if (clash || clashNumber) return fail(`${projectNumber} is already the number of ${clash ? `${clash.id} (${'title' in clash ? clash.title : clash.name})` : clashNumber!.objectId}: one number names one thing.`);
        store.numbers.put({ ...existing, projectNumber }, trace(`The project numbers ${found.label} ${projectNumber}; ${existing.number} stays as an alias`));
        saved('numbers', existing.id, `${projectNumber} (was ${existing.number})`);
        return ok({ objectId, number: projectNumber, alias: existing.number, recorded: true });
      }
      if (patch) return ok({ objectId, number: patch.number, byKeeper: true, recorded: false, note: 'A semantic patch is numbered by the program when it is written.' });
      if (own) return ok({ objectId, number: own, byKeeper: false, recorded: false, note: 'The project numbers it: its own number stands.' });
      if (existing) return ok({ objectId, number: existing.projectNumber ?? existing.number, byKeeper: !existing.projectNumber, ...(existing.projectNumber ? { alias: existing.number } : {}), recorded: false });
      const number = nextNumber('K', store.numbers.all().map((n) => n.number));
      const record: KeeperNumber = { id: stableId('knum', project.id, objectId), projectId: project.id, number, objectId, objectKind: actual, projectNumber: null, at: now() };
      store.numbers.put(record, trace(`Keeper number ${number}: ${found.label}`));
      saved('numbers', record.id, `${number}: ${found.label}`);
      return ok({ objectId, number, byKeeper: true, recorded: true });
    },
  }));

  // ───────────────────────── 6 · skeleton / cross-check: process links ─────────────────────────

  /** The repository-relative file a fact is about (a file, a source's file, a ledger entry's document), or null (a commit). */
  const factPlace = (fact: EvidenceRef): { repo: string | null; path: string } | null => {
    if (fact.kind === 'file') return { repo: fact.repo ? pathKey(fact.repo) : null, path: fact.id.replace(/\\/g, '/') };
    if (fact.kind === 'source') {
      const src = store.sources.get(fact.id);
      if (!src || src.anchor.kind !== 'file') return null;
      return placeUnder(project.scope.map((i) => i.path), src.anchor.path);
    }
    if (fact.kind === 'ledger') {
      const ledger = Ledger.openDir(store.dir);
      try {
        const at = ledger?.pathOfEntry(fact.id) ?? null;
        if (!at) return null;
        const repo = ledger?.repos().find((r) => r.id === at.repo)?.path ?? null;
        return { repo: repo ? pathKey(repo) : null, path: at.path };
      } finally { ledger?.close(); }
    }
    return null;
  };
  const samePlace = (a: { repo: string | null; path: string } | null, b: { repo: string | null; path: string }): boolean =>
    a !== null && a.path.toLowerCase() === b.path.toLowerCase() && (a.repo === null || b.repo === null || a.repo === b.repo);
  /** A work item's own numbers: its ids, and an internal id that is a project number (written before CJ). */
  const ownNumbers = (t: WorkThread): Set<string> => new Set([...t.ids, ...(isNumberShaped(t.id.toUpperCase()) ? [t.id] : [])].map((x) => x.trim().toUpperCase()));
  /** Why a check's link to this file is refused, or null (CJ). */
  const checkLinkRefusal = (work: WorkThread, path: string, stepKind: string): string | null => {
    const ledger = Ledger.openDir(store.dir);
    try {
      const kinds = ledger?.arrangementKinds(path) ?? [];
      const owners = new Set([...kinds.map((k) => k.ident ?? ''), ...definitionsInPath(path).map((d) => d.num)].filter(Boolean).map((x) => x.toUpperCase()));
      const mine = ownNumbers(work);
      const self = [...owners].filter((o) => mine.has(o));
      if (self.length) {
        return `${path} is ${self.join(', ')}’s own ${kinds.some((k) => k.kind === 'prompt') ? 'prompt' : 'material'}, and a work item is never the ${stepKind} of itself: link the ${stepKind} on the work item ${self[0]} checked — the contract or ticket its report gives a verdict for. Nothing was written.`;
      }
      if (kinds.some((k) => k.kind === 'prompt') && !kinds.some((k) => k.kind === 'receipt')) {
        const idents = [...new Set(kinds.map((k) => k.ident).filter((x): x is string => Boolean(x)))];
        const reports = idents.length && ledger ? (ledger.db.prepare(`SELECT DISTINCT path FROM plans WHERE kind = 'receipt' AND ident IN (${idents.map(() => '?').join(',')}) ORDER BY path`).all(...idents) as { path: string }[]).map((r) => r.path) : [];
        return `${path} is the dispatch prompt${idents.length ? ` of ${idents.join(', ')}` : ''}: it asks for the check and gives no verdict. A ${stepKind} link cites the verdict file — the report${reports.length ? ` (${reports.slice(0, 4).join(', ')})` : ', the run’s result or last message'} — with the line that states the verdict. Nothing was written.`;
      }
      return null;
    } finally { ledger?.close(); }
  };

  tools.push(defineTool({
    name: 'pk_link_process', label: 'Link a fact to a step of a work item',
    description: `Skeleton or cross-check: tie a fact the program could not tie by ids — a commit, a merge, a verdict, a dispatch, a receipt — to the work item whose step it is, so the process view shows it as that step (${STEP_KINDS.join(', ')}). The program already ties what carries the work item’s number; link only what it could not, and say in one sentence why it belongs (why). ledgerRef is the fact: a ledger entry, or while this build has no ledger the commit, source or file (and line). A link is Inferred. The program checks it as it is written: a commit in the ledger whose message names the work item's number (ranges count) or that changed its files, a cited line that names its number, a file that is its own — then the link is lane-checked and counts like a confirmed one; otherwise it is suspect, and the cross-check rejects it or confirms it after reading the original (confirm: true). The same work item, fact and step is the same link: linking it again updates it, and a why left out stays as written. A new link needs why. ` + EVIDENCE_HELP,
    parameters: Type.Object({
      workId: Type.String(),
      ledgerRef: EvidenceSchema('the fact that is the step'),
      stepKind: Type.String({ description: STEP_KINDS.join(' | ') }),
      why: Type.Optional(Type.String({ description: 'why this fact is this step of this work item, in one sentence; a new link needs it' })),
      confirm: Type.Optional(Type.Boolean({ description: 'cross-check only: true once you checked the link against the original' })),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const refusal = gate('pk_link_process', CLERK_WRITER_STEPS.pk_link_process, 'a link between a fact and a step of a work item');
      if (refusal) return fail(refusal);
      const fields = programFields(p, ['confirmed', 'basis', 'at'], 'a link the program could not make from ids is Inferred, and it is confirmed with confirm in the cross-check.');
      if (fields) return fail(fields);
      const workId = resolveMergedId(store, text(p.workId).trim());
      const work = store.threads.get(workId);
      if (!work) return fail(`${text(p.workId) || '(empty)'} is not a work item of the assets.`);
      const stepKind = text(p.stepKind);
      if (!isOneOf(STEP_KINDS, stepKind)) return fail(`stepKind must be one of ${STEP_KINDS.join(', ')}.`);
      const fact = resolveEvidence(ev, p.ledgerRef, 'ledgerRef');
      if (typeof fact === 'string') return fail(fact);
      if (fact.kind === 'object') return fail('ledgerRef is a fact of the ledger (or, while this build has none, a commit, source or file); an object of the assets is a judgement, not a step of the work.');
      // A ledger entry is named by its id; before the ledger, what stands in for one says its kind (`commit:<hash>`). The
      // resolved evidence is kept beside it — label, the original line, when it happened, the repository — so the link
      // shows what it ties without resolving it again.
      const ledgerRef = fact.kind === 'ledger' ? fact.id : `${fact.kind}:${fact.id}`;
      // CJ: a check's link cites the verdict — the report — never the dispatch prompt; a work item is never the check of
      // itself; and one work item has one link per step and file (D99 had 18 duplicate QC links; D100 cited prompts and
      // linked three tickets to themselves).
      const place = factPlace(fact);
      if (place && (stepKind === 'QC' || stepKind === 'Review' || stepKind === 'Walkthrough')) {
        const refusal = checkLinkRefusal(work, place.path, stepKind);
        if (refusal) return fail(refusal);
      }
      const sameFile = place ? store.links.find((l) => l.workId === workId && l.stepKind === stepKind && l.evidence != null && samePlace(factPlace(l.evidence), place)) : undefined;
      const id = sameFile?.id ?? stableId('link', project.id, workId, ledgerRef, stepKind, fact.line ?? '', ...(fact.repo ? [pathKey(fact.repo)] : []));
      const previous = store.links.get(id);
      if (!previous && absent(p.why)) throw createNeeds('a link', `${work.title} has no ${stepKind} link to ${fact.label} yet`, ['why'], 'To update a link — to confirm it in the cross-check — give the work item, fact and step it has.');
      const why = clean(p.why) || previous?.why || '';
      if (!why) return fail('why: in one sentence, why this fact is this step of this work item.');
      const inCrossCheck = stepKindAs(store, ctx.step) === 'cross-check';
      const confirmed = (p.confirm === true && inCrossCheck) || (previous?.confirmed ?? false);
      // CM (E151): the program checks the evidence as the link is written; a link that passes is lane-checked.
      const ledger = Ledger.openDir(store.dir);
      let check: LinkCheck;
      try { check = checkLink(store, work, fact, why, ledger); } finally { ledger?.close(); }
      const link: ProcessLink = { id, projectId: project.id, workId, ledgerRef, evidence: fact, stepKind, why, basis: 'Inferred', confirmed, check, roundId: previous?.roundId ?? roundId(), jobId: ctx.jobId, at: now() };
      store.links.put(link, trace(`Link ${stepKind}: ${fact.label} → ${work.title}${confirmed ? ' (confirmed)' : check.passed ? ' (lane-checked)' : ' (suspect)'}`, sourceIdsOf([fact])));
      saved('links', id, `${stepKind}: ${work.title}`);
      return ok({
        id, workId, ledgerRef, stepKind, confirmed, evidence: fact.label, occurred: fact.occurred,
        check: check.passed ? `lane-checked: ${check.why}` : `suspect: ${check.why}`,
        ...(!check.passed && !confirmed ? { note: 'The program could not check this link against its evidence: cite the commit or the line that names the work item, or the cross-check rejects it (or confirms it after reading the original).' } : {}),
        ...(p.confirm === true && !inCrossCheck ? { note: 'Recorded unconfirmed: a link is confirmed in the cross-check.' } : {}),
      });
    },
  }));

  // ───────────────────────── 7 · cross-check: confirm or refute ─────────────────────────

  tools.push(defineTool({
    name: 'pk_confirm', label: 'Confirm or refute a link, breakpoint or patch',
    description: 'Cross-check (check first, then adopt), and the spot check correcting what it found wrong: say whether a judged link, a breakpoint or a semantic patch holds, after checking it against the original, the ledger and the code. why says what you checked it against. A link that does not hold is removed; a breakpoint that does not hold goes out (it stays on record, no longer lit) — one the ledger’s ids show (basis Explicit) goes out only on evidence that the missing step did happen. A breakpoint the program computed is a candidate: only the round’s spot-check lights it (confirmed: true), after a lane looked for the missing step and did not find it (pk_record_looked), and never in a First usable round. A patch becomes Confirmed or Rejected. Never confirm what you did not check. ' + EVIDENCE_HELP,
    parameters: Type.Object({
      kind: Type.String({ description: 'link | breakpoint | patch' }),
      id: Type.String({ description: 'its id (a patch also by its number, SP-n)' }),
      ids: Type.Optional(Type.Array(Type.String(), { description: 'kind link only: more links checked the same way, confirmed or rejected with this one (the program checks every link as it is written; the cross-check rejects the suspect ones, or confirms them after reading the original)' })),
      confirmed: Type.Boolean({ description: 'true: it holds; false: it does not' }),
      why: Type.String({ description: 'what you checked it against, in one or two sentences' }),
      evidence: Type.Optional(Type.Array(EvidenceSchema('what shows it'), { description: 'what shows it; required to put out a breakpoint of basis Explicit' })),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const refusal = gate('pk_confirm', CLERK_WRITER_STEPS.pk_confirm, 'a confirmation');
      if (refusal) return fail(refusal);
      const kind = text(p.kind);
      if (!['link', 'breakpoint', 'patch'].includes(kind)) return fail('kind must be link, breakpoint or patch.');
      if (typeof p.confirmed !== 'boolean') return fail('confirmed: true when it holds, false when it does not.');
      const why = clean(p.why);
      if (!why) return fail('why: what you checked it against.');
      const evidence = resolveEvidenceList(ev, p.evidence, 'evidence');
      if (typeof evidence === 'string') return fail(evidence);
      const id = text(p.id).trim();
      const verb = p.confirmed ? 'Confirmed' : 'Refuted';
      if (kind === 'link') {
        const all = [...new Set([id, ...(Array.isArray(p.ids) ? (p.ids as unknown[]).map((x) => text(x).trim()) : [])].filter(Boolean))];
        const unknown = all.filter((x) => !store.links.get(x));
        if (unknown.length) return fail(`${unknown.join(', ') || '(empty)'} ${unknown.length === 1 ? 'is' : 'are'} not ${unknown.length === 1 ? 'a process link' : 'process links'} of the assets. Nothing was written.`);
        for (const lid of all) {
          const link = store.links.get(lid)!;
          if (!p.confirmed) {
            // A link that does not hold is no association at all: left in place unconfirmed, it would read as one waiting.
            store.links.remove(lid, trace(`Link refuted (${link.stepKind}: ${link.ledgerRef} → ${link.workId}): ${why}`, sourceIdsOf(evidence)));
            saved('links', lid, `Refuted: ${link.stepKind}`);
            continue;
          }
          store.links.put({ ...link, confirmed: true }, trace(`Link confirmed (${link.stepKind}: ${link.ledgerRef} → ${link.workId}): ${why}`, sourceIdsOf(evidence)));
          saved('links', lid, `Confirmed: ${link.stepKind}`);
        }
        if (all.length === 1) return ok(p.confirmed ? { kind, id, confirmed: true } : { kind, id, confirmed: false, removed: true });
        return ok({ kind, ids: all, confirmed: p.confirmed, ...(p.confirmed ? {} : { removed: all.length }) });
      }
      if (kind === 'breakpoint') {
        const bp = store.breakpoints.get(id);
        if (!bp) return fail(`${id || '(empty)'} is not a breakpoint of the assets.`);
        if (p.confirmed) {
          if (bp.out) return fail(`${id} is already out (${bp.out.by}, ${bp.out.at}): there is nothing lit to confirm.`);
          // D99: only the round's spot-check lights, a candidate a lane looked for, outside First usable (breakpoint-candidates.ts).
          const unlit = lightingRefusal(store, bp, ctx.step);
          if (unlit) return fail(unlit);
          const lit = lightCandidate(store, bp, { roundId: roundId()!, jobId: ctx.jobId, at: now() }, trace(`Breakpoint ${bp.kind} on ${bp.targetId} lit by the spot-check: ${why}`, sourceIdsOf(evidence)));
          saved('breakpoints', id, `Lit: ${bp.kind}`);
          return ok({ kind, id, confirmed: true, lit: true, checked: lit.checked });
        }
        if (bp.basis === 'Explicit' && evidence.length === 0) {
          return fail(`${id} (${bp.kind}) is shown by the ledger’s ids (basis Explicit), so it goes out only on evidence: cite what shows the missing step did happen (evidence), or leave it lit. Nothing was written.`);
        }
        // Refuted by this step, with its evidence: the program does not light it again on the same evidence (§2.12).
        const decidedAt = now();
        const decision = { breakpointId: bp.id, at: decidedAt, roundId: roundId() };
        const refutations = bp.familyBasis ? [...(bp.familyRefutations ?? []).filter((r) => r.basis.lineId !== bp.familyBasis!.lineId || r.basis.syntax !== bp.familyBasis!.syntax || r.basis.replaced !== bp.familyBasis!.replaced),
          { basis: bp.familyBasis, decision, evidence }] : bp.familyRefutations;
        store.breakpoints.put({ ...bp, lit: false, out: { at: decidedAt, by: 'model', evidence, decision }, familyRefutations: refutations, confirmedInRoundId: null, updatedAt: decidedAt }, trace(`Breakpoint ${bp.kind} on ${bp.targetId} put out: ${why}`, sourceIdsOf(evidence)));
        saved('breakpoints', id, `Out: ${bp.kind}`);
        // The commits it cites as the delivery tie to the work, so its execution reads them (§1.4).
        const linked = deliveryLinksFrom(store, bp, evidence, why, { roundId: roundId(), jobId: ctx.jobId, at: decidedAt });
        return ok({ kind, id, confirmed: false, lit: false, ...(linked ? { deliveryLinks: linked } : {}) });
      }
      const patch = store.patches.get(id) ?? store.patches.find((x) => x.number === id);
      if (!patch) return fail(`${id || '(empty)'} is not a semantic patch of the assets.`);
      const status: SemanticPatch['status'] = p.confirmed ? 'Confirmed' : 'Rejected';
      store.patches.put({ ...patch, status, updatedAt: now() }, trace(`${verb} semantic patch ${patch.number}: ${why}`, sourceIdsOf(evidence)));
      saved('patches', patch.id, `${patch.number} ${status}`);
      return ok({ kind, id: patch.id, number: patch.number, status });
    },
  }));

  // ───────────────────────── 8 · synthesis: send-backs ─────────────────────────

  tools.push(defineTool({
    name: 'pk_suggest_sendback', label: 'Suggest a send-back',
    description: 'Synthesis, and the cross-check for a code anomaly with a clear action: suggest sending a problem back — to Work when a piece of work’s result has a gap or failed, QC failed, or a finding nobody handled; to Plan when a document or plan drifted or went stale. It is a relation, not a ticket: ProjectKeeper assigns no work, it makes the problem visible and easy to hand over (Copy for agent). Give where the problem is (what), where it should go back to (suggestion: reopen or new work; a plan or document change), the evidence — numbers, commits, files and lines, the report’s own line — and where it came from (from: the breakpoint, the verdict, the owner’s-judgement position, or the code anomaly with its index). A choice the owner has to make (whether to ratify a requirement that grew by itself) is a For your decision note, not a send-back. The stage starts at Suggested; Returned and Closed are recognised from the ledger at the next Follow up and are never set by you, and when it happened is read from the evidence. An open send-back on the same target with the same what (or from the same breakpoint or verdict) is updated, not duplicated: an update gives only what changes — to and suggestion left out stay, evidence given is added, and it keeps where it came from. A new send-back needs to, suggestion, evidence and from. ' + EVIDENCE_HELP,
    parameters: Type.Object({
      to: Type.Optional(Type.String({ description: 'Work | Plan — a new send-back needs it' })),
      targetId: Type.String({ description: 'the object it hangs on: the work item, the plan or document, the code territory' }),
      what: Type.String({ description: 'where the problem is, in one or two sentences' }),
      suggestion: Type.Optional(Type.String({ description: 'where it should go back to: reopen the work or open new work; change the plan or the document — a new send-back needs it' })),
      evidence: Type.Optional(Type.Array(EvidenceSchema('what shows the problem'), { description: 'what shows it; a new send-back needs it, an update adds to it' })),
      from: Type.Optional(Type.Object({
        kind: Type.String({ description: 'breakpoint | verdict | owner-judgement | code-anomaly' }),
        id: Type.String({ description: 'the breakpoint; the verdict’s ledger entry or report source; the note or mark; the code territory' }),
        index: Type.Optional(Type.Number({ description: 'code-anomaly: which anomaly of the territory, counted from 0' })),
      }, { description: 'where it came from; a new send-back needs it' })),
      sixThing: Type.Optional(Type.Number({ description: '1–6: which of the six things the owner judges it is material for' })),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const fromGiven = !absent(p.from);
      const from = (p.from ?? {}) as Record<string, unknown>;
      const fromKind = text(from.kind);
      const fromId = text(from.id).trim();
      const refusal = gate('pk_suggest_sendback', CLERK_WRITER_STEPS.pk_suggest_sendback, 'a send-back');
      if (refusal) return fail(refusal);
      const fields = programFields(p, ['stage', 'occurred', 'returned', 'closed', 'ownerResponse', 'updatedAt', 'at'], 'a send-back is suggested, and Returned and Closed are recognised from the ledger at the next Follow up, never set; when it happened is read from its evidence.');
      if (fields) return fail(fields);
      const target = findObject(store, text(p.targetId));
      if (!target || store.sources.has(text(p.targetId).trim())) return fail(`${text(p.targetId) || '(empty)'} is not an object of the assets for a send-back to hang on: give the work item, the plan or document, or the code territory.`);
      const what = clean(p.what);
      if (!what) return fail('what: where the problem is.');
      // One open send-back per problem: the same source (a failed verdict the program already sent back, a breakpoint), or
      // the same target and wording. A territory's anomalies share the territory as their source, so they match by wording.
      const sameSource = (s: SendBack) => fromGiven && fromKind !== 'code-anomaly' && s.from.kind === fromKind && s.from.id === fromId;
      const existing = store.sendbacks.find((s) => s.stage !== 'Closed' && (sameSource(s) || (s.targetId === target.id && sameWords(s.what, what))));
      if (!existing) {
        const missing = [...(absent(p.to) ? ['to'] : []), ...(absent(p.suggestion) ? ['suggestion'] : []), ...(absent(p.evidence) ? ['evidence'] : []), ...(fromGiven ? [] : ['from'])];
        if (missing.length) throw createNeeds('a send-back', `No open send-back on ${target.id} says “${what}”${fromGiven ? `, nor comes from ${fromKind} ${fromId}` : ''}`, missing, 'To update an open send-back, give the targetId and the what it has.');
      }
      // An update keeps where the send-back came from.
      const originKind = fromGiven ? fromKind : existing!.from.kind;
      if (stepKindAs(store, ctx.step) === 'cross-check' && originKind !== 'code-anomaly') return fail('In the cross-check a send-back is suggested only for a code anomaly with a clear action; the other send-backs are suggested in synthesis. Nothing was written.');
      const to = has(p.to) ? text(p.to) : existing?.to ?? '';
      if (to !== 'Work' && to !== 'Plan') return fail('to must be Work (a gap, a failure, a finding nobody handled) or Plan (a document or plan that drifted or went stale).');
      const suggestion = clean(p.suggestion) || existing?.suggestion || '';
      if (!suggestion) return fail('suggestion: where it should go back to — reopen the work or open new work; change the plan or the document.');
      const evidence = resolveEvidenceList(ev, p.evidence, 'evidence');
      if (typeof evidence === 'string') return fail(evidence);
      if (!existing && evidence.length === 0) return fail('evidence is empty: a send-back carries what shows the problem — the numbers, commits, files and lines, the report’s own line.');
      let anomalyIndex: number | null = null;
      if (fromGiven) {
        if (!isOneOf(SENDBACK_FROM, fromKind)) return fail(`from.kind must be one of ${SENDBACK_FROM.join(', ')}.`);
        if (fromKind === 'breakpoint' && !store.breakpoints.has(fromId)) return fail(`from.id ${fromId || '(empty)'} is not a breakpoint of the assets.`);
        if (fromKind === 'verdict' && !store.sources.has(fromId) && !ctx.ledger?.resolve(fromId)) return fail(`from.id ${fromId || '(empty)'} is neither a ledger entry nor a source: a verdict is named by the ledger entry that holds it, or the source of the report.`);
        if (fromKind === 'owner-judgement' && !findObject(store, fromId)) return fail(`from.id ${fromId || '(empty)'} is not in the assets: name the note, mark or object that holds the judgement.`);
        if (fromKind === 'code-anomaly') {
          const territory = store.territories.get(fromId);
          if (!territory) return fail(`from.id ${fromId || '(empty)'} is not a code territory of the assets.`);
          if (territory.anomalies.length === 0) return fail(`${territory.name} has no anomaly for a send-back to come from.`);
          const index = typeof from.index === 'number' ? from.index : territory.anomalies.length === 1 ? 0 : NaN;
          if (!Number.isInteger(index) || index < 0 || index >= territory.anomalies.length) return fail(`from.index: which of ${territory.name}’s ${territory.anomalies.length} anomalies it comes from, counted from 0.`);
          anomalyIndex = index;
        }
      }
      const sixThing = p.sixThing === undefined ? null : Number(p.sixThing);
      if (sixThing !== null && !(Number.isInteger(sixThing) && sixThing >= 1 && sixThing <= 6)) return fail('sixThing must be a whole number from 1 to 6.');
      const merged = existing ? [...existing.evidence, ...evidence.filter((e) => !existing.evidence.some((x) => evidenceKey(x) === evidenceKey(e)))] : evidence;
      const occurred = earliestOccurred(merged.map((e) => e.occurred)) ?? { at: now(), basis: 'First observed' as const, anchor: null, undated: true };
      const record: SendBack = existing
        ? { ...existing, to, what, suggestion, evidence: merged, sixThing: (sixThing as SixThing | null) ?? existing.sixThing, occurred, roundId: existing.roundId ?? roundId(), updatedAt: now() }
        : {
          id: newId('sb'), projectId: project.id, to, stage: 'Suggested', targetId: target.id, what, suggestion, evidence,
          from: { kind: fromKind as SendBack['from']['kind'], id: fromId }, returned: null, closed: null, ownerResponse: null, sixThing: sixThing as SixThing | null,
          occurred, roundId: roundId(), updatedAt: now(),
        };
      store.sendbacks.put(record, trace(`${existing ? 'Send-back updated' : 'Send-back suggested'} to ${to}: ${what}`, sourceIdsOf(merged)));
      if (fromGiven && fromKind === 'breakpoint') {
        const bp = store.breakpoints.get(fromId)!;
        if (bp.sendBackId !== record.id) store.breakpoints.put({ ...bp, sendBackId: record.id, updatedAt: now() }, trace(`Breakpoint ${bp.kind}: send-back ${record.id}`));
      }
      if (anomalyIndex !== null) {
        const territory = store.territories.get(fromId)!;
        const anomalies = territory.anomalies.map((a, i) => (i === anomalyIndex ? { ...a, sendBackId: record.id } : a));
        store.territories.put({ ...territory, anomalies, updatedAt: now() }, trace(`Code anomaly of ${territory.name}: send-back ${record.id}`));
      }
      saved('sendbacks', record.id, `Send-back to ${to}: ${what}`);
      return ok({ id: record.id, stage: record.stage, occurred, evidence: merged.length, updated: Boolean(existing), cli: cliCommandFor(project.id, record.id) });
    },
  }));

  // ───────────────────────── 9 · cross-check / synthesis: the six things ─────────────────────────

  tools.push(defineTool({
    name: 'pk_tag_six', label: 'Say which of the six things it is',
    description: 'Cross-check or synthesis: say which of the six things the owner judges a mark, note, breakpoint, send-back or code territory anomaly is material for, so the owner can filter by it — 1 stale, 2 drift, 3 dropped along the way, 4 grown by itself, 5 let pass, 6 looks residual. Some kinds have a fixed one, and that one is taken: Not planned → 3, No plan → 4, Findings open → 5, Downstream behind → 1, Not carried out → 2, Suspected stale → 1, Layer drift → 2, and the code anomalies Unreferenced and Looks residual, is live → 6 (those two carry it from the moment they are written). Tag what really is material for one of them, not everything. Thing 3 or 5 on a mark, a note or a send-back says nothing took it up afterwards: give looked — where you read for what came after, and up to when — unless the target already carries it.',
    parameters: Type.Object({
      target: Type.Object({
        kind: Type.String({ description: 'mark | note | breakpoint | sendback | territory-anomaly' }),
        id: Type.String({ description: 'its id; for a territory anomaly, the code territory’s id' }),
        index: Type.Optional(Type.Number({ description: 'territory-anomaly: which of the territory’s anomalies, counted from 0 (may be left out when it has one)' })),
      }),
      thing: Type.Number({ description: '1 stale · 2 drift · 3 dropped along the way · 4 grown by itself · 5 let pass · 6 looks residual' }),
      looked: Type.Optional(Type.Object({
        where: Type.Array(Type.String(), { description: 'each place you read for what came after, as the spot-check can open it again: a file with its section or lines, a ledger query, a commit range, a session' }),
        upTo: Type.String({ description: 'up to when your reading reaches: the date or time (2026-09-30, 2026-09-30T19:53Z) of the newest commit, document version or report you read' }),
        sessionsUpTo: Type.Optional(Type.String({ description: 'when sessions were read: the time of the last session message you read' })),
      }, { description: 'thing 3 (dropped along the way) or 5 (let pass) on a mark, a note or a send-back says nothing took it up afterwards: where you looked for what came after, and up to when. Refused without it unless the target already carries it (a note written with looked)' })),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const refusal = gate('pk_tag_six', CLERK_WRITER_STEPS.pk_tag_six, 'which of the six things something is');
      if (refusal) return fail(refusal);
      const target = (p.target ?? {}) as Record<string, unknown>;
      const kind = text(target.kind);
      const id = text(target.id).trim();
      const thing = Number(p.thing);
      if (!(Number.isInteger(thing) && thing >= 1 && thing <= 6)) return fail('thing must be a whole number from 1 to 6: 1 stale, 2 drift, 3 dropped along the way, 4 grown by itself, 5 let pass, 6 looks residual.');
      const six = thing as SixThing;
      // CN (E152; Spec §2.12): dropped along the way and let pass say nothing took it up afterwards — an absence claim,
      // which carries what was read. A breakpoint has its own way (a lane's pk_record_looked, the spot-check's light).
      let given: AbsenceLooked | null = null;
      if (!absent(p.looked)) {
        const parsed = parseLooked(p.looked);
        if (typeof parsed === 'string') return fail(`${parsed} Nothing was written.`);
        given = lookedRecord(parsed, presentOf(store), { roundId: roundId(), jobId: ctx.jobId, at: now() });
      }
      const absence = ABSENCE_THINGS.includes(six);
      const lookedFor = (had: AbsenceLooked | null | undefined, what: string): AbsenceLooked | string | null => {
        const l = given ?? had ?? null;
        return absence && !l ? absenceRefusal(`Tagging ${what} as ${SIX[six]}`, []) : l;
      };
      const mismatch = (fixed: SixThing | undefined, what: string) => (fixed !== undefined && fixed !== six ? `${what} is thing ${fixed} (${SIX[fixed]}) by the fixed table of kinds, not ${six} (${SIX[six]}).` : null);
      const done = (collection: string, label: string, extra: Record<string, unknown> = {}) => {
        saved(collection, id, `Six things: ${SIX[six]}`);
        return ok({ kind, id, ...extra, thing: six, is: SIX[six], on: label });
      };
      switch (kind) {
        case 'mark': {
          const mark = store.marks.get(id);
          if (!mark) return fail(`${id || '(empty)'} is not a mark of the assets.`);
          const wrong = mismatch(MARK_THING[mark.kind], `A ${mark.kind} mark`);
          if (wrong) return fail(wrong);
          const looked = lookedFor(mark.looked, `the ${mark.kind} mark`);
          if (typeof looked === 'string') return fail(looked);
          store.marks.put({ ...mark, sixThing: six, ...(looked ? { looked, clue: absence ? stampAsFarAs(mark.clue, looked) : mark.clue } : {}) }, trace(`Six things: mark ${mark.kind} on ${mark.targetId} is ${SIX[six]}`, mark.clueSourceIds));
          return done('marks', mark.kind, looked && absence ? { looked: lookedLine(looked) } : {});
        }
        case 'note': {
          const note = store.notes.get(id);
          if (!note) return fail(`${id || '(empty)'} is not a note of the assets.`);
          const looked = lookedFor(note.looked, 'this note');
          if (typeof looked === 'string') return fail(looked);
          // The look is the note's; when it stops before the present, the note's current line says so.
          const versions = looked && absence ? note.versions.map((v, i) => (i === note.versions.length - 1 ? { ...v, preview: stampAsFarAs(v.preview, looked) } : v)) : note.versions;
          store.notes.put({ ...note, versions, sixThing: six, ...(looked ? { looked } : {}), updatedAt: now() }, trace(`Six things: note “${note.versions[note.versions.length - 1]?.title ?? id}” is ${SIX[six]}`));
          return done('notes', note.versions[note.versions.length - 1]?.title ?? id, looked && absence ? { looked: lookedLine(looked) } : {});
        }
        case 'breakpoint': {
          const bp = store.breakpoints.get(id);
          if (!bp) return fail(`${id || '(empty)'} is not a breakpoint of the assets.`);
          const wrong = mismatch(BREAKPOINT_THING[bp.kind], `A ${bp.kind} breakpoint`);
          if (wrong) return fail(wrong);
          store.breakpoints.put({ ...bp, sixThing: six, updatedAt: now() }, trace(`Six things: breakpoint ${bp.kind} on ${bp.targetId} is ${SIX[six]}`));
          return done('breakpoints', bp.kind);
        }
        case 'sendback': {
          const sb = store.sendbacks.get(id);
          if (!sb) return fail(`${id || '(empty)'} is not a send-back of the assets.`);
          const looked = lookedFor(sb.looked, 'this send-back');
          if (typeof looked === 'string') return fail(looked);
          store.sendbacks.put({ ...sb, sixThing: six, ...(looked ? { looked, what: absence ? stampAsFarAs(sb.what, looked) : sb.what } : {}), updatedAt: now() }, trace(`Six things: send-back “${sb.what}” is ${SIX[six]}`));
          return done('sendbacks', sb.what, looked && absence ? { looked: lookedLine(looked) } : {});
        }
        case 'territory-anomaly': {
          const territory = store.territories.get(id);
          if (!territory) return fail(`${id || '(empty)'} is not a code territory of the assets: a territory anomaly is named by its territory’s id and its index.`);
          if (territory.anomalies.length === 0) return fail(`${territory.name} has no anomaly to tag.`);
          const index = typeof target.index === 'number' ? target.index : territory.anomalies.length === 1 ? 0 : NaN;
          if (!Number.isInteger(index) || index < 0 || index >= territory.anomalies.length) return fail(`target.index: which of ${territory.name}’s ${territory.anomalies.length} anomalies, counted from 0.`);
          const anomaly = territory.anomalies[index]!;
          const wrong = mismatch(ANOMALY_THING[anomaly.kind], `A code anomaly “${anomaly.kind}”`);
          if (wrong) return fail(wrong);
          const anomalies = territory.anomalies.map((a, i) => (i === index ? { ...a, sixThing: six } : a));
          store.territories.put({ ...territory, anomalies, updatedAt: now() }, trace(`Six things: ${territory.name}’s anomaly “${anomaly.kind}” is ${SIX[six]}`, sourceIdsOf(anomaly.evidence)));
          return done('territories', `${territory.name}: ${anomaly.kind}`, { index });
        }
        default:
          return fail('target.kind must be mark, note, breakpoint, sendback or territory-anomaly.');
      }
    },
  }));

  // ───────────────────────── 9b · synthesis: a note from an earlier round still holds (E153) ─────────────────────────

  tools.push(defineTool({
    name: 'pk_confirm_note', label: 'A standing note still holds',
    description: 'Synthesis of a deepening or a Follow up: a note still current from an earlier round gets one result this round — it still holds (this tool), it is updated (pk_write_note with its id), or it is withdrawn (pk_close_note, with why). Confirm a note only after checking what it claims against what this round found: give in read each thing you read that shows it still holds, as the spot-check can open it again — a lane report with its section, a file with its lines, a ledger query, a commit. The note gets no new version: your judgement record says it was looked at again and still holds, with what you read, and the spot-check checks it like the notes this round wrote.',
    parameters: Type.Object({
      id: Type.String({ description: 'the note' }),
      read: Type.Array(Type.String(), { description: 'what you read that shows it still holds, each as it can be opened again' }),
    }),
    execute: async (_id, p) => {
      const refusal = gate('pk_confirm_note', CLERK_WRITER_STEPS.pk_confirm_note, 'that a note standing from an earlier round still holds');
      if (refusal) return fail(refusal);
      const round = store.clerkRounds.get(ctx.step!.roundId);
      if (!round) return fail(`Round ${ctx.step!.roundId} is not registered, so there is no round to confirm the note in.`);
      const note = store.notes.get(text(p.id).trim());
      if (!note) return fail(`${text(p.id) || '(empty)'} is not a note of the assets.`);
      if (!looksAtStandingNotes(round)) return fail('A first usable round has no earlier round whose notes still stand: there is nothing to confirm. Nothing was recorded.');
      const standing = standingNotes(store, round).find((s) => s.note.id === note.id);
      if (!standing) return fail(note.status !== 'Current' ? `That note is ${note.status}, not current: there is nothing to confirm. Nothing was recorded.` : isProgramNote(note) ? 'That note is the program’s own question to the owner, not a judgement of a round: it gets no result. Nothing was recorded.' : 'That note was written in this round: it is not standing from an earlier one, and the spot-check checks it as written. Nothing was recorded.');
      if (standing.result === 'withdrawn') return fail(`That note is ${note.status}, not current: its result this round is withdrawn. Nothing was recorded.`);
      if (standing.result === 'updated') return fail('That note got a new version in this round: its result is updated, and the new version says what holds. Nothing was recorded.');
      // A note the owner cannot read is not confirmed as it stands (D105; CKC-08 AC-26, AC-27): one that carries internal
      // identifiers, or asks for a decision without the question first and the options, is written again as a new version.
      const latest = note.versions[note.versions.length - 1]!;
      const unreadable = noteFormRefusal({
        ask: latest.ask, title: latest.title, preview: latest.preview, options: latest.body.options ?? [],
        body: { currentView: latest.body.currentView, whyItMatters: latest.body.whyItMatters, ...Object.fromEntries(latest.body.facts.map((f, i) => [`facts[${i}]`, f.text])), otherExplanations: latest.body.otherExplanations, keepAdjust: latest.body.keepAdjust, whatWouldSettleIt: latest.body.whatWouldSettleIt },
      }, laneNamesOf(store), `What it says may still hold, but it is not confirmed in this form: give it its result by updating it (pk_write_note with id "${note.id}"), with every part named above written anew`);
      if (unreadable) return fail(unreadable.replace('Nothing was written.', 'Nothing was recorded.'));
      const read = arr<unknown>(p.read).map((r) => clean(r)).filter(Boolean);
      if (!read.length) return fail('read is empty: a note is confirmed as still holding with what you read that shows it (a lane report and its section, a file and its lines, a ledger query, a commit). Nothing was recorded.');
      const title = note.versions[note.versions.length - 1]?.title ?? note.id;
      // Recorded in the synthesis' judgement record, with what was read; the note gets no new version (CKC-08 AC-25).
      const judgement = (ctx.judgementId ? store.judgements.get(ctx.judgementId) : undefined) ?? store.judgements.find((j) => j.jobId === ctx.jobId);
      if (!judgement) return fail('This job has no judgement record to record the confirmation in (pk_record_judgement first). Nothing was recorded.');
      const stillHolds = [...(judgement.outcome.stillHolds ?? []).filter((h) => h.noteId !== note.id), { noteId: note.id, read, at: now() }];
      store.judgements.put({ ...judgement, outcome: { ...judgement.outcome, stillHolds } }, trace(`Note “${title}” (${note.id}) still holds (round ${round.number}): read ${read.slice(0, 3).join('; ').slice(0, 200)}`));
      saved('judgements', judgement.id, `Note still holds: ${title}`);
      return ok({ id: note.id, result: 'confirmed', read: read.length, standingNotes: standingCounts(store, round) });
    },
  }));

  // ───────────────────────── 10 · cross-check: code territories ─────────────────────────

  tools.push(defineTool({
    name: 'pk_write_territory', label: 'Write a code territory',
    description: 'Cross-check: the judged half of a code territory — the current code cut by product area, so the owner can see what the docs became. Give its name and one sentence on what it is for, the repository, the directories or files that make it up (as they are in the current tree), its kind (area: it serves one product area, areaId; shared: a base several areas use, alsoServes; non-product: third-party, generated, tooling), and the anomalies — only what is not right: Unreferenced, Looks residual but is live, Built without a claiming work item, Docs disagree — each with the ledger entry or source that shows it and its basis. An Unreferenced or Looks-residual anomaly in code whose references the ledger reads only file by file (Dart, Python) or not at all is Inferred whatever basis you give: the program sets it. The numbers — size, dependencies, who built it, tests, last change, generation, current use — are the program’s from the ledger: do not write them. Judge residual code by its references, never by its name; code used through registration, routing or reflection is not residual. A territory with the same repository and name (or its id) is updated: an update gives only what it changes, and what it leaves out keeps its value (paths, alsoServes and anomalies, when given, replace their lists). A new territory needs name, summary, repo, paths and kind. ' + EVIDENCE_HELP,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: 'an existing territory to update' })),
      name: Type.Optional(Type.String({ description: 'a new territory needs it; with the repository it finds the one already written' })),
      summary: Type.Optional(Type.String({ description: 'one sentence: what it is for' })),
      repo: Type.Optional(Type.String({ description: 'the repository: its scope item id or path' })),
      paths: Type.Optional(Type.Array(Type.String(), { description: 'the directories or files that make it up, relative to the repository root' })),
      kind: Type.Optional(Type.String({ description: 'area | shared | non-product' })),
      areaId: Type.Optional(Type.String({ description: 'area: the Area reference item it mainly serves' })),
      alsoServes: Type.Optional(Type.Array(Type.String(), { description: 'other Area reference items it also serves' })),
      anomalies: Type.Optional(Type.Array(Type.Object({
        kind: Type.String({ description: ANOMALY_KINDS.join(' | ') }),
        text: Type.String({ description: 'what is not right, in one or two sentences' }),
        evidence: Type.Array(EvidenceSchema('what shows it')),
        basis: Type.String({ description: 'Explicit | Inferred' }),
      }))),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const refusal = gate('pk_write_territory', CLERK_WRITER_STEPS.pk_write_territory, 'a code territory');
      if (refusal) return fail(refusal);
      const given = text(p.id).trim();
      const named = given ? store.territories.get(given) : undefined;
      if (given && !named) return fail(`${given} is not a code territory of this project; leave id out to write a new one.`);
      const place = resolvePath(project, { path: '', repo: text(p.repo) || named?.repo || '' });
      if (typeof place === 'string') return fail(`repo: ${place}`);
      const root: ProjectRoot = place.root;
      // The one to update: the id given, or the territory with the same repository and name.
      const previous = named ?? (clean(p.name) ? store.territories.get(stableId('terr', project.id, pathKey(root.path), squash(clean(p.name)))) : undefined);
      if (ctx.step!.kind === 'spot-check' && !previous) return fail('The spot check corrects the territories it checked: give the id of the one to correct.');
      if (!previous) {
        const lacking = (['name', 'summary', 'repo', 'paths', 'kind'] as const).filter((f) => absent(p[f]));
        if (lacking.length) throw createNeeds('a code territory', clean(p.name) ? `${root.path} has no territory named “${clean(p.name)}”` : 'This call names no code territory (no id, and no name to find one by)', lacking, 'To update a territory, give its id, or its repo and name as written.');
      }
      const name = clean(p.name) || previous?.name || '';
      const summary = clean(p.summary) || previous?.summary || '';
      if (!name || !summary) return fail('A territory has a name and one sentence on what it is for (summary).');
      const kind = has(p.kind) ? text(p.kind) : previous!.kind;
      if (!isOneOf(TERRITORY_KINDS, kind)) return fail(`kind must be one of ${TERRITORY_KINDS.join(', ')}.`);
      const kindChanged = previous !== undefined && kind !== previous.kind;
      const paths: string[] = absent(p.paths) ? [...previous!.paths] : [];
      const missing: string[] = [];
      for (const raw of absent(p.paths) ? [] : arr<string>(p.paths)) {
        const at = resolvePath(project, { path: text(raw), repo: root.id });
        if (typeof at === 'string') { missing.push(`${text(raw)} (${at})`); continue; }
        if (!at.rel) { missing.push(`${text(raw)} (the whole repository is not a territory)`); continue; }
        const inTree = (root.git && gitTreeEntry(root.path, 'HEAD', at.rel) !== null) || pathPresence(root, at.rel) === 'now';
        if (!inTree) { missing.push(at.rel); continue; }
        if (!paths.includes(at.rel)) paths.push(at.rel);
      }
      if (missing.length) return fail(`A territory is made of the current code, and these are not in ${root.path}’s current tree: ${missing.join(', ')}. Nothing was written.`);
      if (paths.length === 0) return fail('paths is empty: give the directories or files that make it up.');
      const isArea = (id: string) => store.reference.get(id)?.category === 'Area';
      // The area it serves stays with it while its kind stays; a territory that changes kind names its area anew.
      const areaId = text(p.areaId).trim() || (previous && !kindChanged ? previous.areaId : null);
      if (kind === 'area' && (!areaId || !isArea(areaId))) return fail(`An area territory names the Area it mainly serves: areaId must be an Area reference item${areaId ? `; ${areaId} is not one` : ''}.`);
      if (kind !== 'area' && areaId) return fail(`A ${kind} territory serves no single area: leave areaId out${kind === 'shared' ? ' and name the areas it serves in alsoServes' : ''}.`);
      const alsoServes = [...new Set((absent(p.alsoServes) ? [...(previous?.alsoServes ?? [])] : arr<string>(p.alsoServes)).map((a) => text(a).trim()).filter((a) => a && a !== areaId))];
      const notAreas = alsoServes.filter((a) => !isArea(a));
      if (notAreas.length) return fail(`alsoServes names what is not an Area reference item: ${notAreas.join(', ')}.`);
      const id = previous?.id ?? stableId('terr', project.id, pathKey(root.path), squash(name));
      const anomalies: CodeTerritory['anomalies'][number][] = absent(p.anomalies) ? [...(previous?.anomalies ?? [])] : [];
      // Read once, only when an anomaly judges by references: how far the ledger reads this code's references.
      let reach: ReturnType<typeof referenceLevel> | null = null;
      const inferredBy: string[] = [];
      for (const [i, a] of arr<Record<string, unknown>>(p.anomalies).entries()) {
        const anomalyKind = text(a.kind);
        if (!isOneOf(ANOMALY_KINDS, anomalyKind)) return fail(`anomalies[${i}].kind must be one of ${ANOMALY_KINDS.join(', ')}.`);
        const said = clean(a.text);
        if (!said) return fail(`anomalies[${i}].text: what is not right.`);
        const given = text(a.basis);
        if (!isOneOf(BASIS, given)) return fail(`anomalies[${i}].basis must be Explicit or Inferred.`);
        // The program, not the model, says when a residual judgement cannot be Explicit (CKC-25 AC-5).
        let basis: typeof given = given;
        if (BY_REFERENCES.has(anomalyKind) && given === 'Explicit') {
          reach ??= referenceLevel(ctx.store.dir, root, paths);
          if (!reach.complete) {
            basis = 'Inferred';
            inferredBy.push(`anomalies[${i}] (${anomalyKind}) is Inferred: ${reach.gaps.join('; ')}`);
          }
        }
        const evidence = resolveEvidenceList(ev, a.evidence, `anomalies[${i}].evidence`);
        if (typeof evidence === 'string') return fail(evidence);
        if (evidence.length === 0) return fail(`anomalies[${i}] cites no evidence: every anomaly names the ledger entry or source that shows it.`);
        // What the owner or a later step hung on the same anomaly stays with it; which of the six things it is, too — and
        // a kind §2.13's table fixes carries its thing from the start.
        const before = previous?.anomalies.find((x) => x.kind === anomalyKind && sameWords(x.text, said));
        anomalies.push({
          kind: anomalyKind, text: said, evidence, basis, sendBackId: before?.sendBackId ?? null, noteIds: before?.noteIds ?? [],
          sixThing: ANOMALY_THING[anomalyKind] ?? before?.sixThing ?? null,
        });
      }
      const territory: CodeTerritory = {
        id, projectId: project.id, name, summary, repo: root.path, paths, kind, areaId, alsoServes, anomalies,
        roundId: previous?.roundId ?? roundId(), jobId: ctx.jobId, updatedAt: now(),
      };
      const shared = store.territories.filter((t) => t.id !== id && pathKey(t.repo) === pathKey(root.path) && t.paths.some((x) => paths.includes(x)));
      store.territories.put(territory, trace(`${previous ? 'Code territory updated' : 'Code territory'}: ${name} (${paths.length} path${paths.length === 1 ? '' : 's'}, ${anomalies.length} anomal${anomalies.length === 1 ? 'y' : 'ies'})`, sourceIdsOf(anomalies.flatMap((a) => a.evidence))));
      saved('territories', id, `Code territory: ${name}`);
      return ok({
        id, paths: paths.length, anomalies: anomalies.length, updated: Boolean(previous),
        ...(inferredBy.length ? { basisSetByProgram: inferredBy } : {}),
        ...(shared.length ? { warning: `Some of these paths are also in ${shared.map((t) => `${t.id} (${t.name})`).join(', ')}: a directory or file belongs to one territory; the others are counted twice until one lets go of it.` } : {}),
      });
    },
  }));

  // ───────────────────────── 11 · spot check ─────────────────────────

  tools.push(defineTool({
    name: 'pk_record_spot_check', label: 'Record what the spot check found',
    description: 'Spot check: record the judgements of this round you checked again against the original, the ledger and the code — above all what asserts the state of the code, a supersession, decided or not, nobody handled it, residual — each as Right or Wrong, with the kind of judgement it is, and for a wrong one whether it is wrong in substance or only by timing (wrongKind: the state it describes was right when written and a later write or recompute overtook it). Correct a wrong one first, with the writer of that position (the patch, the territory, the confirmation, the work item …), then record it with what you corrected: the program counts it corrected only when this job wrote to it. The round’s result shows how many were checked, how many were wrong and in which kinds; the program counts them from these records — do not write the counts yourself. A judgement counts once in the round, whichever session records it: once found wrong it stays counted wrong, once corrected it stays corrected, and a later record gives its kind.',
    parameters: Type.Object({
      checked: Type.Array(Type.Object({
        target: Type.Object({
          collection: Type.String({ description: 'the assets collection it is in: patches, breakpoints, sendbacks, territories, links, generations, layers, threads, reference, notes, marks, facts …' }),
          id: Type.String(),
        }),
        kind: Type.String({ description: 'the kind of judgement, e.g. code state, supersession, decided or not, nobody handled it, residual' }),
        verdict: Type.String({ description: 'Right | Wrong' }),
        wrongKind: Type.Optional(Type.String({ description: 'Wrong only: timing — it was right when written and a later write or recompute overtook it (a candidate still listed after its link was confirmed) — or substance — the judgement itself is wrong (the default)' })),
        correction: Type.Optional(Type.String({ description: 'Wrong only: what you corrected, once you have corrected it' })),
      })),
    }),
    execute: async (_id, p) => {
      const refusal = gate('pk_record_spot_check', CLERK_WRITER_STEPS.pk_record_spot_check, 'what the spot check found');
      if (refusal) return fail(refusal);
      const round = store.clerkRounds.get(ctx.step!.roundId);
      if (!round) return fail(`Round ${ctx.step!.roundId} is not registered, so there is no round result to count the spot check in.`);
      const entries = arr<Record<string, unknown>>(p.checked);
      if (entries.length === 0) return fail('checked is empty: give each judgement you checked.');
      const written = new Set(store.traceByJob(ctx.jobId, 1_000_000).map((t) => `${t.collection}\x1f${t.id}`));
      const problems: string[] = [];
      const accepted: SpotCheckTarget[] = [];
      for (const [i, e] of entries.entries()) {
        const target = (e.target ?? {}) as Record<string, unknown>;
        const collection = text(target.collection).trim();
        const holder = (store as unknown as Record<string, unknown>)[collection];
        if (!(holder instanceof Collection) || ['jobs', 'contexts', 'judgements', 'clerkRounds'].includes(collection)) { problems.push(`checked[${i}].target.collection: ${collection || '(empty)'} is not a collection of judgements in the assets`); continue; }
        const rawId = text(target.id).trim();
        const id = collection === 'threads' ? resolveMergedId(store, rawId) : rawId;
        const touchedHere = written.has(`${collection}\x1f${id}`);
        if (!holder.has(id) && !touchedHere) { problems.push(`checked[${i}]: ${rawId || '(empty)'} is not in ${collection}`); continue; }
        const kind = clean(e.kind);
        if (!kind) { problems.push(`checked[${i}].kind: what kind of judgement it is`); continue; }
        const verdict = text(e.verdict);
        if (verdict !== 'Right' && verdict !== 'Wrong') { problems.push(`checked[${i}].verdict must be Right or Wrong`); continue; }
        const correction = clean(e.correction);
        if (correction && verdict === 'Right') { problems.push(`checked[${i}]: a judgement that is right needs no correction`); continue; }
        // CM: a state-timing wrong is told apart from a wrong of substance (two of the gated run's three errors were timing).
        const wrongKindGiven = text(e.wrongKind).trim().toLowerCase();
        if (wrongKindGiven && wrongKindGiven !== 'timing' && wrongKindGiven !== 'substance') { problems.push(`checked[${i}].wrongKind must be timing or substance`); continue; }
        if (wrongKindGiven && verdict === 'Right') { problems.push(`checked[${i}]: wrongKind says how a wrong judgement is wrong; this one is Right`); continue; }
        const wrongKind: SpotWrongKind | null = verdict === 'Wrong' ? (wrongKindGiven === 'timing' ? 'timing' : 'substance') : null;
        if (correction && !touchedHere) { problems.push(`checked[${i}]: nothing in this job wrote to ${collection} ${id}, so it is not corrected yet — correct it with the writer of that position, then record it`); continue; }
        accepted.push({ collection, id, kind, wrong: verdict === 'Wrong', corrected: verdict === 'Wrong' && Boolean(correction), ...(wrongKind ? { wrongKind } : {}) });
      }
      if (problems.length) return fail(`Nothing was recorded:\n${problems.join('\n')}`);
      // The round's record of what was checked, one entry per collection and id, whichever session records it. What was
      // found wrong stays found wrong and a correction stays made: a judgement checked again after it was corrected is
      // right, and the round still made the error. Every count is taken from these entries.
      const merged = new Map<string, SpotCheckTarget>((round.spotCheck?.targets ?? []).map((t) => [`${t.collection}\x1f${t.id}`, t]));
      for (const a of accepted) {
        const key = `${a.collection}\x1f${a.id}`;
        const before = merged.get(key);
        merged.set(key, {
          collection: a.collection, id: a.id,
          kind: a.wrong || !before?.wrong ? a.kind : before.kind,
          wrong: a.wrong || (before?.wrong ?? false),
          corrected: a.corrected || (before?.corrected ?? false),
          // A wrong of substance stays one; a timing wrong stays timing until a later record finds substance.
          ...(a.wrong ? { wrongKind: before?.wrongKind === 'substance' ? 'substance' as const : a.wrongKind ?? 'substance' } : before?.wrongKind ? { wrongKind: before.wrongKind } : {}),
        });
      }
      const targets = [...merged.values()];
      const byKind: Record<string, number> = {};
      for (const t of targets) if (t.wrong) byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
      const wrongByKind = { timing: targets.filter((t) => t.wrong && t.wrongKind === 'timing').length, substance: targets.filter((t) => t.wrong && t.wrongKind !== 'timing').length };
      // D103 (E153): the synthesis' outputs and the notes are checked in full, and counted apart from the sample.
      const full = new Set(fullCheckTargets(store, round).map((t) => `${t.collection}\x1f${t.id}`));
      const inFull = targets.filter((t) => full.has(`${t.collection}\x1f${t.id}`));
      const synthesis = { outputs: full.size, checked: inFull.length, wrong: inFull.filter((t) => t.wrong).length };
      // CS (D104): the placement readings, counted apart, against what this spot-check was given as it started (fixed on
      // the round then; for a round whose step did not fix it, as the store stands at the first record). Each reason
      // recorded is kept with its words and its outcome, so a later round's spot-check is not given it again while it is
      // unchanged; a program placement found right has its result, on the record of the round that placed it.
      const plan = round.placementCheck ?? placementCheckNow(store, now());
      const readings = placementCounts(plan, targets, now(), round.spotCheck?.reasonChecks ?? []);
      const hasReadings = plan.reasons.length > 0 || plan.placements.length > 0;
      confirmBySpotCheck(store, readings.right, { jobId: ctx.jobId, roundId: round.id });
      const counts = { sampled: targets.length, wrong: targets.filter((t) => t.wrong).length, byKind, corrected: targets.filter((t) => t.corrected).length, wrongByKind, ...(full.size ? { synthesis } : {}), ...(hasReadings ? { placement: readings.placement } : {}) };
      const spotCheck: SpotCheck = { ...counts, targets, ...(readings.checks.length ? { reasonChecks: readings.checks } : {}) };
      // The round as it stands now: a program placement of this same round may just have got its result above.
      const updated: ClerkRound = { ...(store.clerkRounds.get(round.id) ?? round), spotCheck, ...(hasReadings ? { placementCheck: plan } : {}), updatedAt: now() };
      store.clerkRounds.put(updated, trace(`Spot check of round ${round.number}: ${accepted.length} recorded (${accepted.filter((a) => a.wrong).length} wrong) — ${counts.sampled} checked, ${counts.wrong} wrong, ${counts.corrected} corrected`));
      saved('clerkRounds', round.id, `Spot check: ${counts.sampled} checked, ${counts.wrong} wrong`);
      const left = full.size - inFull.length;
      const reasonsLeft = readings.placement.reasons - readings.placement.reasonsChecked;
      const notes = [
        ...(left > 0 ? [`${left} of the ${full.size} targets checked in full (the notes, the synthesis' outputs, the Result) are not recorded yet: check and record each.`] : []),
        ...(reasonsLeft > 0 ? [`${reasonsLeft} of the ${readings.placement.reasons} reasons that leave an item unplaced (noPlanWhy, noAreaWhy, wholeProductWhy) are not recorded yet: check and record each.`] : []),
      ];
      return ok({ roundId: round.id, recorded: accepted.length, spotCheck: counts, ...(notes.length ? { note: notes.join(' ') } : {}) });
    },
  }));

  // ───────────────────────── 12 · session drafts (§3.11) ─────────────────────────

  /** The owner's lines of one session and the times of its messages, as the program reads them. */
  const hearSession = (host: string, sessionId: string): HeardSession | string => {
    const sources = store.sources.filter((s) => s.anchor.kind === 'session' && s.anchor.host === host && s.anchor.sessionId === sessionId)
      .sort((a, b) => (a.anchor.kind === 'session' && b.anchor.kind === 'session' ? a.anchor.messageStart - b.anchor.messageStart : 0));
    if (sources.length === 0) return `No ${host} session ${sessionId} is among this project’s sources. pk_list_sources with kind "session" lists them.`;
    const first = sources[0]!.anchor;
    if (first.kind !== 'session') return `${sessionId} is not a session.`;
    const sourceIds = sources.map((s) => s.id);
    const at = (s: string | null | undefined) => s ?? '';
    if (host === 'pi') {
      const found = ownerUtterances(store, { sessionSourceId: sources[0]!.id });
      if (typeof found === 'string') return found;
      const times = new Map<number, string | null>();
      for (const s of sources) if (s.anchor.kind === 'session') times.set(s.anchor.messageStart, s.anchor.at);
      const lines = found.utterances.map((u) => {
        const a = store.sources.get(u.sourceId)?.anchor;
        return { ref: String(a?.kind === 'session' ? a.messageStart : u.order), at: at(u.at), text: u.text, before: null };
      });
      const stamps = [...times.values()].filter((t): t is string => Boolean(t)).sort();
      return { file: first.file, startedAt: stamps[0] ?? '', endedAt: stamps[stamps.length - 1] ?? '', lines, times, readFrom: 'Keeper conversation', sourceIds };
    }
    const parsed = parsedSession(host, first.file);
    if (parsed) {
      const times = new Map<number, string | null>(parsed.messages.map((m) => [m.index, m.at]));
      const lines: HeardLine[] = [];
      let agent: string | null = null;
      for (const m of parsed.messages) {
        if (isOwnerMessage(m)) {
          lines.push({ ref: String(m.index), at: at(m.at), text: redact(m.text), before: agent === null ? null : redact(agent) });
          agent = null;
        } else if (m.role === 'assistant' && !m.sidechain && m.text.trim()) {
          agent = m.text;
        }
      }
      return { file: first.file, startedAt: at(parsed.startedAt), endedAt: at(parsed.endedAt), lines, times, readFrom: 'session log', sourceIds };
    }
    // The log is gone or unreadable (D71): the transcripts the assets keep hold the owner's messages whole, and the
    // agent's trimmed; their times are the minutes the headers show.
    const times = new Map<number, string | null>();
    const lines: HeardLine[] = [];
    let agent: string | null = null;
    for (const s of sources) {
      const transcript = s.excerpt.normalize('NFC');
      const heads = [...transcript.matchAll(HEADER_LINE)];
      for (const [k, h] of heads.entries()) {
        const index = Number(h[1]);
        const minute = h[3] ? `${h[3].replace(' ', 'T')}Z` : null;
        times.set(index, minute ? new Date(minute).toISOString() : null);
        const body = transcript.slice(h.index! + h[0].length, k + 1 < heads.length ? heads[k + 1]!.index! : transcript.length).replace(/^\r?\n/, '').replace(/\s+$/, '');
        if (h[2] === 'OWNER') { lines.push({ ref: String(index), at: times.get(index) ?? '', text: body, before: agent }); agent = null; }
        else if (h[2] === 'AGENT' && body.trim()) agent = body.replace(/\n {2}tools: [^\n]*$/, '').trim() || agent;
      }
    }
    const stamps = [...times.values()].filter((t): t is string => Boolean(t)).sort();
    return { file: first.file, startedAt: stamps[0] ?? at(first.at), endedAt: stamps[stamps.length - 1] ?? at(first.at), lines, times, readFrom: 'transcripts in the assets', sourceIds };
  };

  tools.push(defineTool({
    name: 'pk_write_session_draft', label: 'Write the draft of a session',
    description: 'Session drafts: one draft per session — the ground the owner’s words, the lineage, the deep sweeps and the Keeper’s recall stand on. The program takes the owner’s words out of the session itself, verbatim, with their times, and for each line the agent message just before it; you only classify the owner’s lines by their ref (the [n] the transcript shows, or a ledger message id) as Chat or Decision — a Confirmation is a decision, the owner saying yes to what the agent proposed, and confirms says in your words what was confirmed (“the owner confirmed X’s proposal to …”), never the rest of the proposal as the owner’s. Lines you do not classify stay unjudged; on a later call they keep the kind they had. agentSummary: the agents’ intents and reports as claims — who, and what they said they did or meant to do — each optionally pointing at the agent message it is about (at: its [n]; the program reads its time). Given, it replaces the summary the draft had; left out of a later call, the draft keeps it. A new draft needs lines and agentSummary (either may be an empty list). Never retype the owner’s words, never give a time: the program reads both.',
    parameters: Type.Object({
      session: Type.Object({ host: Type.String({ description: 'claude | codex | pi' }), sessionId: Type.String() }),
      lines: Type.Optional(Type.Array(Type.Object({
        ref: Type.String({ description: 'the owner’s message: its [n] in the session transcript, or its ledger message id' }),
        kind: Type.String({ description: 'Chat | Decision | Confirmation' }),
        confirms: Type.Optional(Type.String({ description: 'Confirmation only (required): what the owner confirmed, in your words' })),
      }), { description: 'your classification of the owner’s lines; a new draft needs it (an empty list when you classify none yet)' })),
      agentSummary: Type.Optional(Type.Array(Type.Object({
        at: Type.Optional(Type.String({ description: 'the agent message it is about: its [n] in the transcript; leave out for the session as a whole' })),
        who: Type.String({ description: 'which agent, e.g. "Claude Code (opus)", "Codex worker"' }),
        summary: Type.String({ description: 'what it said it did or meant to do — a claim' }),
      }), { description: 'the agents’ intents and reports; a new draft needs it, a later call that leaves it out keeps the draft’s' })),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const refusal = gate('pk_write_session_draft', CLERK_WRITER_STEPS.pk_write_session_draft, 'a session draft');
      if (refusal) return fail(refusal);
      const session = (p.session ?? {}) as Record<string, unknown>;
      const host = text(session.host).trim();
      const sessionId = text(session.sessionId).trim();
      if (!isOneOf(SESSION_HOST, host)) return fail(`session.host must be one of ${SESSION_HOST.join(', ')}.`);
      if (!sessionId) return fail('session.sessionId: which session.');
      const drafted = store.drafts.get(stableId('draft', project.id, host, sessionId));
      if (!drafted) {
        const missing = (['lines', 'agentSummary'] as const).filter((f) => absent(p[f]));
        if (missing.length) throw createNeeds('a session draft', `${host} session ${sessionId} has no draft yet`, missing, 'A later call about the same session updates its draft.');
      }
      const heard = hearSession(host, sessionId);
      if (typeof heard === 'string') return fail(heard);
      const byRef = new Map(heard.lines.map((l) => [l.ref, l]));
      /** What the model classified, by the line's position in the session (a line only the ledger has: its ledger id). */
      const classified = new Map<string, { kind: OwnerLineKind; confirms: string | null }>();
      /** Lines cited by their ledger message id: that id is their ref (a draft's refs are the ledger's message ids). */
      const ledgerRefs = new Map<string, string>();
      const fromLedger: HeardLine[] = [];
      const problems: string[] = [];
      for (const [i, l] of arr<Record<string, unknown>>(p.lines).entries()) {
        const own = programFields(l, ['text', 'at', 'answers', 'time', 'quote'], 'the owner’s words, their time and the message they answer are taken from the session by the program.');
        if (own) { problems.push(`lines[${i}]: ${own}`); continue; }
        const kind = text(l.kind);
        if (!isOneOf(LINE_KINDS, kind)) { problems.push(`lines[${i}].kind must be one of ${LINE_KINDS.join(', ')}`); continue; }
        const confirms = clean(l.confirms);
        if (kind === 'Confirmation' && !confirms) { problems.push(`lines[${i}] is a Confirmation: say in confirms what the owner confirmed, in your words`); continue; }
        if (kind !== 'Confirmation' && confirms) { problems.push(`lines[${i}] is ${kind}: confirms belongs to a Confirmation only`); continue; }
        const rawRef = text(l.ref).trim();
        const position = /^\[?(\d+)\]?$/.exec(rawRef)?.[1];
        let key: string | null = position !== undefined && byRef.has(String(Number(position))) ? String(Number(position)) : null;
        if (key === null && rawRef && ctx.ledger) {
          // A ledger message id: its words are the ledger's; the session read here supplies the message it answers.
          const entry = ctx.ledger.resolve(rawRef);
          if (entry?.text) {
            const same = heard.lines.find((h) => sameWords(h.text, entry.text) && (ledgerRefs.get(h.ref) ?? rawRef) === rawRef);
            if (same) {
              ledgerRefs.set(same.ref, rawRef);
              key = same.ref;
            } else {
              if (!fromLedger.some((f) => f.ref === rawRef)) fromLedger.push({ ref: rawRef, at: entry.occurred.at, text: redact(entry.text), before: null });
              key = rawRef;
            }
          }
        }
        if (key === null) {
          const refs = heard.lines.map((h) => h.ref);
          problems.push(`lines[${i}].ref ${rawRef || '(empty)'} is not one of the owner’s messages in this session${refs.length ? ` (their positions: ${refs.slice(0, 40).join(', ')}${refs.length > 40 ? ' …' : ''})` : ' — the program found no owner message in it'}`);
          continue;
        }
        const before = classified.get(key);
        if (before && (before.kind !== kind || before.confirms !== (confirms || null))) { problems.push(`lines[${i}] classifies message ${rawRef} again, differently`); continue; }
        classified.set(key, { kind, confirms: confirms || null });
      }
      const summaries: SessionDraft['agentSummary'][number][] = [];
      for (const [i, s] of arr<Record<string, unknown>>(p.agentSummary).entries()) {
        const who = clean(s.who);
        const summary = clean(s.summary);
        if (!who || !summary) { problems.push(`agentSummary[${i}]: who and summary`); continue; }
        const atRef = text(s.at).trim();
        let at = heard.startedAt;
        if (atRef) {
          const position = /^\[?(\d+)\]?$/.exec(atRef)?.[1];
          if (position === undefined || !heard.times.has(Number(position))) {
            problems.push(`agentSummary[${i}].at: “${atRef}” is not a message of this session — at names the message by its [n] in the transcript, and the program reads its time; a time is never written`);
            continue;
          }
          at = heard.times.get(Number(position)) ?? heard.startedAt;
        }
        summaries.push({ at, who, summary });
      }
      if (problems.length) return fail(`Nothing was written:\n${problems.join('\n')}`);
      const id = stableId('draft', project.id, host, sessionId);
      const previous = store.drafts.get(id);
      // What an earlier draft said of a line stays with it: found by its ref, else by its words at the same time, else by
      // its words when no other line of the earlier draft has them.
      const kept = previous?.ownerLines ?? [];
      const keptFor = (ref: string, h: HeardLine) => kept.find((k) => k.ref === ref || k.ref === h.ref)
        ?? kept.find((k) => k.at === h.at && sameWords(k.text, h.text))
        ?? (() => { const same = kept.filter((k) => sameWords(k.text, h.text)); return same.length === 1 ? same[0] : undefined; })();
      const ownerLines: SessionDraft['ownerLines'][number][] = [...heard.lines, ...fromLedger].map((h) => {
        const mine = classified.get(h.ref);
        const had = keptFor(ledgerRefs.get(h.ref) ?? h.ref, h);
        // A line once known by its ledger message id keeps that id.
        const ref = ledgerRefs.get(h.ref) ?? (had && !byRef.has(had.ref) ? had.ref : h.ref);
        const kind = mine?.kind ?? had?.kind ?? null;
        return {
          ref, at: h.at, text: h.text, kind,
          answers: kind === 'Confirmation' ? h.before : null,
          confirms: kind === 'Confirmation' ? mine?.confirms ?? had?.confirms ?? null : null,
        };
      });
      // Every job that wrote the draft is kept with its round, so each round's session-drafts step lists the drafts it
      // wrote even after a later round drafted the session again (CKC-23 AC-18). A job writing it again moves to the end.
      const at = now();
      const earlier = previous ? (previous.writtenBy?.length ? previous.writtenBy : [{ jobId: previous.jobId, roundId: null, at: previous.at }]) : [];
      // A summary left out of a later call is the one the draft had.
      const agentSummary = absent(p.agentSummary) && previous ? [...previous.agentSummary] : summaries;
      const draft: SessionDraft = {
        id, projectId: project.id, session: { host, sessionId, file: heard.file, startedAt: heard.startedAt, endedAt: heard.endedAt },
        ownerLines, agentSummary, jobId: ctx.jobId, at,
        writtenBy: [...earlier.filter((w) => w.jobId !== ctx.jobId), { jobId: ctx.jobId, roundId: ctx.step?.roundId ?? null, at }],
      };
      const judged = ownerLines.filter((l) => l.kind !== null).length;
      store.drafts.put(draft, trace(`Session draft ${host} ${sessionId.slice(0, 8)}: ${ownerLines.length} owner lines (${judged} classified), ${agentSummary.length} agent summaries — from the ${heard.readFrom}`, heard.sourceIds));
      saved('drafts', id, `Session draft: ${host} ${sessionId.slice(0, 8)}`);
      return ok({ id, ownerLines: ownerLines.length, classified: judged, unclassified: ownerLines.length - judged, agentSummary: agentSummary.length, readFrom: heard.readFrom, updated: Boolean(previous) });
    },
  }));

  tools.push(...fillTools(ctx));   // D99: the table and heading fill-in tools (organize/fill-tools.ts)
  // D99: where a lane looked for a breakpoint's missing step (organize/looked-tools.ts).
  tools.push(...lookedTools(ctx));

  return tools;
}
