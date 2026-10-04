/**
 * The main agent's stages (D99; build plan §2 "主会话", §6): `pk_stage` moves the round to its next stage and returns
 * that stage's skill; `pk_round_state` says where the round stands, so the main agent finds its place again after its
 * session was continued or compacted.
 *
 * The program keeps the order and the few gates the method has; the judging stays the main agent's:
 * - only forward along `ROUND_STAGES`; a stage may be skipped only where the method allows it, with why (a Follow up
 *   whose document chain did not change skips the skeleton and the reconciling; a round with nothing to dig skips the
 *   dig and the coverage check);
 * - leaving a deepening's dig, each of the four kinds of question has a lane whose brief answers it, or the main agent
 *   says why not (E148 D-g; replaces the briefs the program used to compose);
 * - a `Full` deepening enters the cross-check only once its coverage is settled (`coverageSettled`, W5), and the
 *   synthesis only once every breakpoint candidate has a result — linked or put out, or looked for with where
 *   (`pk_record_looked`) — or the main agent says why not; handing over to the synthesis, every round is told what is
 *   still unplaced (work items in no plan or module, decisions placed on nothing — DB: counted by the workbench's own
 *   placement, requirements and designs with them), which refuses nothing (round-open.ts);
 * - (CJ, E150) what the program can count does not rest on the model's promise: a First usable round leaves `reconcile`,
 *   and a deepening enters `cross-check`, only once every number the current decision records, plans, task indexes and
 *   execution arrangements define at an entry position is carried by an item or accounted for by its number
 *   (entry-gate.ts); a deepening enters `synthesis` only once the cross-check confirmed or rejected every link of the
 *   round, or the main agent says why not;
 * - (CM, E151) the program carries the lists and the checks: `pk_round_state` returns counts and what changed since the
 *   last call, one list in full by its key; a deepening's synthesis waits on the suspect links only (a link whose evidence
 *   passed the program's check when written is lane-checked), and — at `Full` depth — on every item of an earlier
 *   generation having a destination;
 * - entering the stages where the process matters, the breakpoint candidates are recomputed (the planner's hook).
 * Each stage is recorded on the round with its start, its end and the main job's time in it (§3.10).
 *
 * D103 (E153; the owner: 「可以，合成另开会话，做吧」): the main agent's session ends after its last check. Its stages are
 * orientation → skeleton → reconcile in a first usable round and orientation → dig → coverage → cross-check in a deepening
 * (`ROUND_STAGES`); `pk_stage({ to: "synthesis" })` is the handover. It runs every gate it ran when the synthesis was a stage
 * — candidates, suspect links, generation destinations, the unplaced note, the candidate recompute — and then, instead of
 * returning the synthesis' skill, it takes the main agent's handover (what it settled, what it left open and why, what the
 * synthesis should look at first), writes it as the round's `Handover` document, ends the stage log at the last stage and
 * closes the main agent's work: the planner starts the synthesis as a job of its own, in a fresh pi session, which reads
 * the lane reports and the handover (clerk.ts `startSynthesis`). On the CM run the main agent entered the synthesis at
 * 341–399K tokens and wrote the two notes the spot-check had to correct within three minutes, from memory of the stages
 * before, not from the reports.
 */
import { laneUnsure } from './absence.ts';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ClerkRound, ClerkStage, RoundDoc, RoundKind, StageEntry, StepTiming } from '../../model/k-types.ts';
import type { Project } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import type { ToolContext } from '../tools.ts';
import { HANDOVER_TO, ROUND_STAGES } from '../clerk-steps.ts';
import { stableId } from '../../model/ids.ts';
import { redactCredentials } from '../../sources/anchor.ts';
import { DEEPENING_PATHS, sweepKindsOf, type SweepKind } from './clerk-prompts.ts';
import { coverageSettled as settledCoverage } from './coverage-gate.ts';
import { lanesOf } from './lane-tools.ts';
import { emptySlotsOf } from './slots.ts';
import { stageSkill as skillOf } from './skills.ts';
import { handedOver, stageOfRound } from './stage-gate.ts';
import { standingCounts } from './standing-notes.ts';
import { candidatesAnswered, candidatesWithoutResult, OPEN_KEYS, openCounts, roundOpen, suspectLinks, unplacedNote, type RoundOpen } from './round-open.ts';
import { placeByProgram, placedNote, settleProgramPlacements } from './placement-inference.ts';
import { checkUncheckedLinks } from '../link-check.ts';
import { attachAcceptedItems, itemsWithoutDestination } from './generation-check.ts';
import { Ledger } from '../../ledger/index.ts';
import { codeAnomalyCandidates } from '../../codemap/facts.ts';
import { uncitedOwnerLines } from './owner-lines.ts';
import { entryGapsNow, entryGateRefusal } from './entry-gate.ts';

const STAGES: readonly ClerkStage[] = ['orientation', 'skeleton', 'reconcile', 'dig', 'coverage', 'cross-check', 'synthesis'];

/** A round's stages as `pk_stage` moves through them: the main agent's, then the handover to the synthesis (D103). */
export function stageOrder(kind: RoundKind): readonly ClerkStage[] {
  return [...ROUND_STAGES[kind], HANDOVER_TO];
}

/** The three parts of the main agent's handover to the synthesis (D103), as `pk_stage` takes them and the document heads them. */
export const HANDOVER_PARTS = [
  { key: 'settled', head: 'What I settled', what: 'what you settled in your last stage (the reconciling, or the cross-check): the judgements across lanes you made and where you wrote them' },
  { key: 'open', head: 'What I left open, and why', what: 'what you left open and why: what stays unplaced, unconfirmed, without a result or without a destination, and a lane’s Unsure you did not settle' },
  { key: 'first', head: 'Look at first', what: 'what the synthesis should look at first: the reports, positions or questions that matter most for this round’s answers' },
] as const;

/** The main agent's handover as given to `pk_stage`: each part's text, or which parts are missing. */
export function handoverOf(raw: unknown): { readonly markdown: string } | { readonly missing: readonly string[] } {
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const parts = HANDOVER_PARTS.map((p) => ({ ...p, text: typeof given[p.key] === 'string' ? redactCredentials(given[p.key] as string).text.trim() : '' }));
  const missing = parts.filter((p) => !p.text).map((p) => p.key);
  if (missing.length) return { missing };
  return { markdown: parts.map((p) => `## ${p.head}\n\n${p.text}`).join('\n\n') };
}

/** The id of a round's Handover document: one per round, replaced when the handover is given again. */
export const handoverDocId = (roundId: string): string => stableId('rdoc', roundId, 'Handover', '');

/** A round's Handover document, if the main agent handed over (D103). */
export function handoverDoc(store: ProjectStore, round: Pick<ClerkRound, 'id' | 'handover'>): RoundDoc | null {
  return store.roundDocs.get(round.handover?.docId ?? handoverDocId(round.id)) ?? null;
}

/** How many items one page of a list gives by default (CM). */
export const LIST_PAGE = 100;
/** How many names of what was added or went each changed list shows. */
const CHANGED_NAMES = 12;

const withLedger = <T>(store: ProjectStore, fallback: T, f: (l: Ledger) => T): T => {
  let l: Ledger | null = null;
  try { l = Ledger.openDir(store.dir); } catch { l = null; }
  if (!l) return fallback;
  try { return f(l); } finally { l.close(); }
};

/**
 * The round's own lists `pk_round_state` gives by key besides the open ones (CM): what the program lists that the main
 * agent does not act on item by item comes as a count where it would have been pasted, and in full here (the gated run's
 * 53K code-anomaly list in the cross-check's notes was waved off in one sentence).
 */
export const EXTRA_KEYS: readonly { readonly key: string; readonly what: string; readonly items: (store: ProjectStore, round: ClerkRound, project: Project) => readonly unknown[] }[] = [
  { key: 'lanes', what: 'the round’s lanes with their slots, brief and report', items: (store, round) => lanesOf(store, round).map(({ jobId: _j, ...l }) => l) },
  { key: 'emptySlots', what: 'the workbench slots a first usable round’s skeleton gave to no lane, each with the recorded reason, its round, and whether the workbench holds anything there now', items: (store) => emptySlotsOf(store).map(({ at: _at, ...e }) => e) },
  { key: 'documents', what: 'the round’s documents', items: (store, round) => store.roundDocs.filter((d) => d.roundId === round.id).map((d) => ({ id: d.id, kind: d.kind, path: d.path, title: d.title, chars: d.markdown.length })) },
  { key: 'unsure', what: 'what this round’s lane reports marked Unsure: each is read to settle it, or written as unsure — never restated as fact', items: (store, round) => laneUnsure(store, round).map((u) => ({ lane: u.lane, report: `${u.reportId}:${u.line}`, text: u.text })) },
  { key: 'coverage', what: 'the coverage check: what no lane touched, and what was accounted for', items: (_s, round) => [...(round.coverage?.untouched ?? []).map((u) => ({ untouched: u })), ...(round.coverage?.accounted ?? [])] },
  { key: 'ownerLines', what: 'the owner’s lines not looked at yet: cited by nothing and not judged to need nothing (the Owner’s words lane has them verbatim)', items: (store) => withLedger(store, [] as unknown[], (l) => uncitedOwnerLines(store, l).lines.map((x) => ({ id: `${x.draftId}:${x.ref}`, at: x.at, kind: x.kind, draft: x.draftId, ref: x.ref, cite: x.sourceIds, text: x.text.replace(/\s+/g, ' ').slice(0, 300) }))) },
  { key: 'ownerLinesJudged', what: 'the owner’s lines judged to need nothing, each with why (pk_judge_owner_lines)', items: (store) => withLedger(store, [] as unknown[], (l) => uncitedOwnerLines(store, l).judged.map((x) => ({ id: `${x.draftId}:${x.ref}`, at: x.at, kind: x.kind, why: x.why, by: x.by === 'lane' ? x.lane ?? 'a lane' : 'main', text: x.text.replace(/\s+/g, ' ').slice(0, 300) }))) },
  { key: 'codeAnomalies', what: 'the program’s code anomaly candidates, to judge before writing an anomaly with pk_write_territory', items: (store, _r, project) => withLedger(store, [] as unknown[], (l) => codeAnomalyCandidates(l, store, project).map((c) => ({ kind: c.kind, territory: c.territoryId, path: c.path, commit: c.commit?.slice(0, 12) ?? null, detail: c.detail, evidence: c.evidence.map((e) => e.id) }))) },
];

/** The stages a round may skip, with why (§6): a Follow up the skeleton and the reconciling when its document chain did not change, and a round with nothing to dig the dig and the coverage check. */
export function skippableStages(kind: RoundKind): readonly ClerkStage[] {
  return kind === 'Follow up' ? ['skeleton', 'reconcile', 'dig', 'coverage'] : kind === 'Deepen' ? ['dig', 'coverage'] : [];
}

/**
 * Entering these stages the breakpoint candidates are recomputed (§6): a first usable round's synthesis; a deepening's and
 * a Follow up's dig, cross-check and synthesis. The synthesis is the end of the cross-check (CM, E151): on the gated run
 * K-2's and K-3's links were confirmed at 23:15 and the candidates only recomputed at 23:45, after the spot-check had
 * read them as still open — two of its three "errors" were this timing. D103: `synthesis` here is the handover to the
 * synthesis (`pk_stage({ to: "synthesis" })`), the main agent's last call; the synthesis job reads them recomputed.
 */
export function recomputesCandidates(kind: RoundKind, stage: ClerkStage): boolean {
  return kind === 'First usable' ? stage === 'synthesis' : stage === 'dig' || stage === 'cross-check' || stage === 'synthesis';
}

/** How many of a brief's first lines may name the kind of question it answers (the skills ask for it there). */
const BRIEF_HEAD_LINES = 5;
const plain = (s: string): string => s.toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, ' ');

/**
 * The four kinds of question (Spec §3.3) no lane of the round's dig answers. A lane answers the kinds its brief names in
 * its title or first lines, as the skills ask the main agent to write them (`DEEPENING_PATHS`, word for word); failing
 * that, the kinds its name or its brief's name begins with (`sweepKindsOf`).
 */
export function kindsUnanswered(store: ProjectStore, round: ClerkRound): SweepKind[] {
  const answered = new Set<SweepKind>();
  for (const lane of (round.lanes ?? []).filter((l) => l.stage === 'dig' || l.stage === 'coverage')) {
    const brief = store.roundDocs.get(lane.briefDocId);
    const head = plain([brief?.title ?? '', ...(brief?.markdown ?? '').split(/\r?\n/).filter((l) => l.trim()).slice(0, BRIEF_HEAD_LINES)].join('\n'));
    const named = DEEPENING_PATHS.filter((k) => head.includes(plain(k)));
    for (const k of named.length ? named : [lane.name, brief?.path ?? '', brief?.title ?? ''].flatMap((n) => sweepKindsOf(n))) answered.add(k);
  }
  return DEEPENING_PATHS.filter((k) => !answered.has(k));
}

const zero: StepTiming = { wallMs: 0, generationMs: 0, toolMs: 0, queueMs: 0, parseRetryMs: 0, otherMs: 0 };
const sub = (a: StepTiming, b: StepTiming): StepTiming => ({
  wallMs: Math.max(0, a.wallMs - b.wallMs), generationMs: Math.max(0, a.generationMs - b.generationMs), toolMs: Math.max(0, a.toolMs - b.toolMs),
  queueMs: Math.max(0, a.queueMs - b.queueMs), parseRetryMs: Math.max(0, a.parseRetryMs - b.parseRetryMs), otherMs: Math.max(0, a.otherMs - b.otherMs),
});
const add = (a: StepTiming, b: StepTiming): StepTiming => ({
  wallMs: a.wallMs + b.wallMs, generationMs: a.generationMs + b.generationMs, toolMs: a.toolMs + b.toolMs, queueMs: a.queueMs + b.queueMs, parseRetryMs: a.parseRetryMs + b.parseRetryMs, otherMs: a.otherMs + b.otherMs,
});

/**
 * The stage log with the running stage ended now: its time is the main job's time so far less what the stages before it
 * took (they follow one another from the job's start).
 */
export function endStage(log: readonly StageEntry[], at: string, snapshot: StepTiming | null): StageEntry[] {
  const open = log.findIndex((e) => e.endedAt === null);
  if (open < 0) return [...log];
  const before = log.slice(0, open).reduce((t, e) => (e.timing ? add(t, e.timing) : t), zero);
  return log.map((e, i) => (i === open ? { ...e, endedAt: at, timing: snapshot ? sub(snapshot, before) : null } : e));
}

export interface StageDeps {
  readonly coverageSettled: (store: ProjectStore, round: ClerkRound, opts?: { readonly project?: Project | null }) => boolean;
  readonly stageSkill: (stage: ClerkStage) => string;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const now = () => new Date().toISOString();
/** The unplaced note's words for the Result, which the main agent's copy turns to its handover (round-open.ts `unplacedNote`). */
const UNPLACED_IN_RESULT = 'say in the Result which stay unplaced and why';
function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }], details: {} };
}
function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }], details: {}, isError: true };
}

export function stageTools(ctx: ToolContext, deps: StageDeps = { coverageSettled: settledCoverage, stageSkill: skillOf }): ToolDefinition[] {
  const { store, project } = ctx;
  const trace = (summary: string) => ({ jobId: ctx.jobId, basisSourceIds: [] as string[], summary });

  /**
   * CQ (D104): the program places what the records lead to — basis Inferred, the chain in each claim, recorded on the round
   * (placement-inference.ts) — as the main agent enters reconcile and the cross-check, and at its handover. Its note tells
   * the main agent what was placed and how to check it; a failure of the program's own run is said, not hidden.
   */
  const placeNow = (roundId: string, stage: string): string | null => {
    let l: Ledger | null = null;
    try { l = Ledger.openDir(store.dir); } catch { l = null; }
    try { return placedNote(placeByProgram(store, l, { id: roundId }, ctx.jobId, stage), stage); } catch (e) { return `=== Placed by the program\nThe program could not run its placement (${(e as Error).message}); place from the records yourself.`; } finally { l?.close(); }
  };

  const mainRound = (tool: string): ClerkRound | string => {
    const step = ctx.step;
    if (!step || step.kind !== 'main') return `${tool} is the main agent's: only the main job of a round moves through its stages.`;
    const round = store.clerkRounds.get(step.roundId);
    if (!round) return `The round ${step.roundId} is not in the assets.`;
    return round;
  };

  /** The round `pk_round_state` reads: the main job's, or the synthesis job's (D103: it finds where the round stands from the counts and lists). */
  const stateRound = (): ClerkRound | string => {
    const step = ctx.step;
    if (!step || (step.kind !== 'main' && step.kind !== 'synthesis')) return "pk_round_state is the main agent's and the synthesis': only those jobs of a round read where it stands.";
    const round = store.clerkRounds.get(step.roundId);
    if (!round) return `The round ${step.roundId} is not in the assets.`;
    return round;
  };

  const tools: ToolDefinition[] = [];

  tools.push(defineTool({
    name: 'pk_stage', label: 'Move to the next stage',
    description: `Move this round to its next stage when the one you are in is done, and get that stage's skill: what to do in it. The stages go forward only, in the order of the round's kind — First usable: ${ROUND_STAGES['First usable'].join(' → ')}; Deepen: ${ROUND_STAGES.Deepen.join(' → ')}; Follow up: ${ROUND_STAGES['Follow up'].join(' → ')}. Your last stage ends with the handover: pk_stage({ to: "synthesis", handover: { settled, open, first } }) hands the round over to the synthesis, which runs in a session of its own and reads the lane reports and your handover; your work is done then, and your session writes nothing more. A Follow up whose document chain did not change may skip skeleton and reconcile, and a round with nothing to dig may skip dig and coverage: say why. Leaving a deepening's dig, each of the four kinds of question (${DEEPENING_PATHS.join('; ')}) has a lane whose brief answers it, or you say why not. A First usable round leaves reconcile, and a deepening enters cross-check, only once every number the current decision records, plans, task indexes and execution arrangements define at an entry position is carried by an item (its ids, or the start of its name) or accounted for by its number (pk_account_entries); the refusal lists what is missing, by file. A Full deepening enters cross-check only once its coverage is settled, and hands over to the synthesis only once every breakpoint candidate has a result — linked or put out, or looked for with where (pk_record_looked) — or you say why not; a deepening hands over only once every suspect link — one whose evidence failed the program's check when it was written — is confirmed or rejected (pk_confirm), or you say why not (a lane-checked link needs nothing more), and (Full) once each item of an earlier generation has its destination, or you say why not; the handover also notes what is still unplaced as the workbench places it (work items in no plan or module, decisions, requirements and designs placed on nothing or only on the Product with no reason), without refusing: say in your handover which stay unplaced and why. Asking for the stage you are in gives its skill again. What each stage lets you write follows from it: a writer outside its stage refuses and says which stage writes it.`,
    parameters: Type.Object({
      to: Type.String({ description: STAGES.join(' | ') }),
      why: Type.Optional(Type.String({ description: 'why a stage is skipped, why a kind of question has no lane, or (a deepening handing over to the synthesis) why breakpoint candidates are left with no result, suspect links unsettled, or generation items without a destination' })),
      handover: Type.Optional(Type.Object({
        settled: Type.Optional(Type.String({ description: HANDOVER_PARTS[0].what })),
        open: Type.Optional(Type.String({ description: HANDOVER_PARTS[1].what })),
        first: Type.Optional(Type.String({ description: HANDOVER_PARTS[2].what })),
      }, { description: 'to synthesis only: your handover to the synthesis, short — it reads the lane reports itself. All three parts are needed' })),
    }),
    execute: async (_id, p) => {
      const round = mainRound('pk_stage');
      if (typeof round === 'string') return fail(round);
      if (round.status !== 'Running') return fail(`Round ${round.number} is ${round.status}: its stages are over.`);
      const to = text(p.to) as ClerkStage;
      const why = text(p.why);
      const order = stageOrder(round.kind);
      const where = { kind: round.kind, number: round.number };
      // D103: once handed over, the main agent's work is done; asking again says so and changes nothing.
      if (handedOver(round)) {
        if (to === HANDOVER_TO) return ok({ handedOver: true, round: where, note: 'You handed this round over to the synthesis already; your work is done. End with a short summary of what you handed over.' });
        return fail('This round was handed over to the synthesis, which runs in a session of its own: its stages are over for the main agent. End with a short summary of what you handed over.');
      }
      if (!order.includes(to)) return fail(`${to || '(none)'} is not a stage of a ${round.kind} round; its stages are ${ROUND_STAGES[round.kind].join(' → ')}, then the handover to the synthesis (to: "synthesis").`);
      const from = stageOfRound(round);
      const i = order.indexOf(from);
      const j = order.indexOf(to);
      if (j === i) return ok({ stage: to, skill: deps.stageSkill(to), round: where, note: `You are in the ${to} stage already; this is its skill again.` });
      if (j < i) return fail(`The stages go forward only: this round is in ${from}, and ${to} came before it. Do what is left in ${from}, then move on (next: ${order[i + 1] ?? 'none'}).`);
      const skipped = order.slice(i + 1, j);
      if (skipped.length) {
        const allowed = skippableStages(round.kind);
        const not = skipped.filter((s) => !allowed.includes(s));
        if (not.length) return fail(`A ${round.kind} round does not skip ${not.join(' and ')}: ${order[i + 1] === HANDOVER_TO ? 'what comes next is the handover to the synthesis' : `the next stage is ${order[i + 1]}`}. Nothing changed.`);
        if (!why) return fail(`Moving to ${to} skips ${skipped.join(' and ')}: say why in why (the document chain did not change since the last round; there is nothing to dig). Nothing changed.`);
      }
      if (round.kind === 'Deepen' && from === 'dig') {
        const missing = kindsUnanswered(store, round);
        if (missing.length && !why) return fail(`A deepening answers the four kinds of question, and no lane of this dig answers ${missing.map((k) => `“${k}”`).join(', ')} (a lane answers a kind when its name or its brief's names it). Send a lane for each with pk_send_lanes, or say in why why this round needs none. Nothing changed.`);
      }
      // CJ (E150): leaving the first usable round's reconcile, every counted entry is on the workbench or accounted for.
      if (round.kind === 'First usable' && from === 'reconcile') {
        const refusal = entryGateRefusal(entryGapsNow(store), 'leave reconcile');
        if (refusal) return fail(refusal);
      }
      if (to === 'cross-check' && round.kind === 'Deepen' && (project.takeoverDepth ?? 'Full') === 'Full' && !deps.coverageSettled(store, round, { project })) {
        return fail('A Full deepening enters the cross-check once every planned material is read, read in part with why, or accounted for: the coverage check still lists material no lane touched. Account for it (pk_account_material) or send a follow-up lane, then move on. Nothing changed.');
      }
      if (to === 'cross-check' && round.kind === 'Deepen') {
        const refusal = entryGateRefusal(entryGapsNow(store), 'enter the cross-check');
        if (refusal) return fail(refusal);
      }
      if (to === 'synthesis' && round.kind === 'Deepen' && (project.takeoverDepth ?? 'Full') === 'Full') {
        const open = candidatesWithoutResult(store, round.id);
        if (open.length && !why) {
          const shown = open.slice(0, 12).map((b) => `${b.id} (${b.kind})`).join(', ');
          return fail(`A Full deepening gives every breakpoint candidate a result before the synthesis: the lane that owns it links the missing step it found (pk_link_process, which puts the candidate out), or records where it looked and did not find it (pk_record_looked); in the cross-check you put out one the evidence answers (pk_confirm kind breakpoint, confirmed false). ${open.length} candidate${open.length === 1 ? ' has' : 's have'} no result yet: ${shown}${open.length > 12 ? `, and ${open.length - 12} more` : ''} (pk_round_state lists them, with the briefs that name each). Put out those the evidence answers, or say in why why they are left with no result this round and what takes them up (lanes are sent from the dig and the coverage stage, which this round has left). Nothing changed.`);
        }
      }
      // CJ, CM: the program checked every link's evidence as it was written (link-check.ts); a lane-checked link counts like
      // a confirmed one. The synthesis waits only on the suspect links — their evidence failed the check — until the
      // cross-check rejects each or confirms it after reading the original, or says why. (On the gated run the gate
      // counted every unconfirmed link, and 82 were confirmed in 26 seconds without a file opened.)
      if (to === 'synthesis' && round.kind === 'Deepen') {
        checkUncheckedLinks(store, ctx.jobId);
        const links = suspectLinks(store);
        if (links.length && !why) {
          const shown = links.slice(0, 12).map((l) => `${l.id} (${l.stepKind} → ${l.workId}: ${l.check?.why ?? 'not checked'})`).join(', ');
          return fail(`A deepening's cross-check settles every suspect link before the synthesis: the program checked each link's evidence as it was written, and these failed — reject each (pk_confirm kind link, confirmed false, which removes it; several at once with ids), or confirm it after reading the original (confirmed true). ${links.length} suspect link${links.length === 1 ? '' : 's'}: ${shown}${links.length > 12 ? `, and ${links.length - 12} more` : ''} (pk_round_state { list: "links" }). Settle them, or say in why why they stay this round. Nothing changed.`);
        }
      }
      // CM (E151): each item of a recognised generation has a destination before the synthesis — the cross-check's duty,
      // counted by the program (the gated run wrote 「去向已记全」 with twenty CKT items that had none).
      if (to === 'synthesis' && round.kind === 'Deepen' && (project.takeoverDepth ?? 'Full') === 'Full') {
        withLedger(store, 0, (l) => attachAcceptedItems(store, l, ctx.jobId));
        const left = itemsWithoutDestination(store);
        if (left.length && !why) {
          const shown = left.slice(0, 12).map((x) => x.number || x.id).join(', ');
          return fail(`A deepening records where each item of an earlier generation went before the synthesis: what replaced it (pk_write_thread replacedBy — an id or the project's number, T-04), a current item that depends on or carries it (pk_relate, dependsOn), or that it was abandoned (validity Abandoned). ${left.length} item${left.length === 1 ? ' has' : 's have'} no destination: ${shown}${left.length > 12 ? `, and ${left.length - 12} more` : ''} (pk_round_state { list: "withoutDestination" }). Record them, or say in why why they stay without one this round. Nothing changed.`);
        }
      }
      // D103: the handover. Every gate above has passed; the main agent says what it settled, what it left open and why,
      // and what the synthesis should look at first — told what is still unplaced, so its handover can say which stay so
      // and why. Then its stage log ends, and the round is the synthesis job's.
      if (to === HANDOVER_TO) {
        // CQ (D104): the program places what the records lead to before the unplaced note is counted.
        const placedNow = placeNow(round.id, 'the handover');
        const unplaced = unplacedNote(roundOpen(store, store.clerkRounds.get(round.id) ?? round));
        const given = handoverOf((p as Record<string, unknown>).handover);
        if ('missing' in given) {
          return fail([
            `The gates are passed. Handing over to the synthesis needs your handover: the synthesis runs in a session of its own and was not there for this round — it reads the lane reports itself, and your handover tells it where you stand. Call pk_stage again with handover: { ${HANDOVER_PARTS.map((x) => x.key).join(', ')} }${why ? ', and the same why' : ''} — ${HANDOVER_PARTS.map((x) => `${x.key}: ${x.what}`).join('; ')}. Keep it short. Missing: ${given.missing.join(', ')}. Nothing changed.`,
            ...(unplaced ? [unplaced.replace(UNPLACED_IN_RESULT, 'say in your handover (open) which stay unplaced and why')] : []),
          ].join('\n\n'));
        }
        const at = now();
        const current = store.clerkRounds.get(round.id) ?? round;
        const docId = handoverDocId(round.id);
        const title = `Handover to the synthesis: ${round.kind} round ${round.number}`;
        const markdown = [`# ${title}`, `From the main agent, as it left the ${from} stage.`, ...(why ? [`Why it handed over with a gate left open: ${why}`] : []), given.markdown].join('\n\n');
        const replaced = store.roundDocs.has(docId);
        store.roundDocs.put({ id: docId, projectId: project.id, roundId: round.id, jobId: ctx.jobId, kind: 'Handover', path: null, title, markdown, at } satisfies RoundDoc,
          trace(`${replaced ? 'Replaced' : 'Wrote'} Handover: ${title} (${[...markdown].length} characters)`));
        ctx.onSaved?.('roundDocs', docId, `Handover: ${title}`);
        const started = current.stageLog?.length ? [...current.stageLog] : [{ stage: from, startedAt: current.startedAt, endedAt: null, timing: null } satisfies StageEntry];
        const stageLog = endStage(started, at, ctx.timingSnapshot?.() ?? null);
        store.clerkRounds.put({ ...current, stage: from, stageLog, handover: { at, docId, ...(why ? { why } : {}) }, updatedAt: at }, trace(`Round ${round.number}: the main agent hands over to the synthesis from ${from}${skipped.length ? `, skipping ${skipped.join(' and ')}` : ''}${why ? ` (${why})` : ''}`));
        // The candidate recompute the synthesis stage had as it was entered (CM): the synthesis and the spot-check read them current.
        const entered = await ctx.stageEntered?.(round.id, HANDOVER_TO);
        const notes = [
          ...(skipped.length ? [`Skipped ${skipped.join(' and ')}: ${why}`] : []),
          ...(entered?.note ? [entered.note] : []),
          ...(placedNow ? [placedNow] : []),
          ...(unplaced ? [unplaced.replace(UNPLACED_IN_RESULT, 'the synthesis says in the Result which stay unplaced and why')] : []),
        ];
        return ok({ handedOver: true, round: where, handover: docId, note: ['The round is handed over: the synthesis runs next, in a session of its own, and reads the lane reports and your handover. Your work in this round is done and your session writes nothing more. End now with a short summary of what you handed over.', ...notes].join('\n\n') });
      }
      const at = now();
      const current = store.clerkRounds.get(round.id) ?? round;
      const started = current.stageLog?.length ? [...current.stageLog] : [{ stage: from, startedAt: current.startedAt, endedAt: null, timing: null } satisfies StageEntry];
      const stageLog = [...endStage(started, at, ctx.timingSnapshot?.() ?? null), { stage: to, startedAt: at, endedAt: null, timing: null, ...(why ? { why } : {}) } satisfies StageEntry];
      store.clerkRounds.put({ ...current, stage: to, stageLog, updatedAt: at }, trace(`Round ${round.number}: the main agent moves from ${from} to ${to}${skipped.length ? `, skipping ${skipped.join(' and ')}` : ''}${why ? ` (${why})` : ''}`));
      // CQ (D104): entering reconcile and the cross-check, the program places what the records lead to, basis Inferred.
      const placedNow = to === 'reconcile' || to === 'cross-check' ? placeNow(round.id, to) : null;
      const entered = await ctx.stageEntered?.(round.id, to);
      const notes = [
        ...(skipped.length ? [`Skipped ${skipped.join(' and ')}: ${why}`] : []),
        ...(placedNow ? [placedNow] : []),
        ...(entered?.note ? [entered.note] : []),
      ];
      return ok({ stage: to, skill: deps.stageSkill(to), round: where, ...(notes.length ? { note: notes.join('\n\n') } : {}) });
    },
  }));

  /** What the last pk_round_state call of this session saw, by key: the ids of each list (CM: what changed since). */
  let seen: Map<string, Map<string, string>> | null = null;

  tools.push(defineTool({
    name: 'pk_round_state', label: 'Where this round stands',
    description: `Where this round stands: the main agent's stage and the stages it went through (and whether it handed over to the synthesis), its lanes with their status and reports, its coverage counted, its breakpoints counted, its documents counted, and open — how many items each list of what is still open holds — with what changed in each since your last call. One list comes in full only when you ask for it by its key: { list: "entries" } (offset and limit page a long one). The keys: ${[...Object.entries(OPEN_KEYS).map(([k, v]) => `${k} (${v.what})`), ...EXTRA_KEYS.map((k) => `${k.key} (${k.what})`)].join('; ')}. Call it to find your place again after your session was continued or compacted, and before you leave a stage, to check nothing it owns is left open; ask for a list when you act on it.`,
    parameters: Type.Object({
      list: Type.Optional(Type.String({ description: 'one list in full, by its key (see the description)' })),
      offset: Type.Optional(Type.Number({ description: 'with list: where to start (default 0)' })),
      limit: Type.Optional(Type.Number({ description: `with list: how many items (default ${LIST_PAGE})` })),
    }),
    execute: async (_id, p) => {
      const round = stateRound();
      if (typeof round === 'string') return fail(round);
      const key = text((p as Record<string, unknown>).list);
      if (key) {
        const all = fullList(round, key);
        if (all === null) return fail(`${key} is not a list of pk_round_state; the keys are ${[...Object.keys(OPEN_KEYS), ...EXTRA_KEYS.map((k) => k.key)].join(', ')}.`);
        const offset = Math.max(0, Math.trunc(Number((p as Record<string, unknown>).offset) || 0));
        const limit = Math.max(1, Math.min(LIST_PAGE * 5, Math.trunc(Number((p as Record<string, unknown>).limit) || LIST_PAGE)));
        const items = all.items.slice(offset, offset + limit);
        return ok({ list: key, count: all.count, offset, items, ...(offset + items.length < all.items.length ? { next: offset + items.length } : {}) });
      }
      // The program's own upkeep before it counts — a link not checked yet, an accepted generation's items — is done
      // under the main job, whose stages it serves. The synthesis job only reads: what its job wrote is what the
      // spot-check checks in full, and the program's upkeep is not among it (D103).
      if (ctx.step?.kind === 'main') {
        checkUncheckedLinks(store, ctx.jobId);
        withLedger(store, 0, (l) => attachAcceptedItems(store, l, ctx.jobId));
        // CS: a program placement of any round that a write took off its item has its result recorded before the count.
        settleProgramPlacements(store, { jobId: ctx.jobId, roundId: round.id });
      }
      const bps = store.breakpoints.all().filter((b) => !b.out);
      const open = roundOpen(store, round, { limit: Infinity, suggest: false });
      const counts = openCounts(open);
      const now = idsByKey(open);
      const changed: Record<string, { before: number; now: number; added?: string[]; gone?: string[] }> = {};
      if (seen) {
        for (const [k, ids] of now) {
          const was = seen.get(k) ?? new Map<string, string>();
          const added = [...ids].filter(([id]) => !was.has(id)).map(([, name]) => name);
          const gone = [...was].filter(([id]) => !ids.has(id)).map(([, name]) => name);
          if (added.length || gone.length) changed[k] = { before: was.size, now: ids.size, ...(added.length ? { added: added.slice(0, CHANGED_NAMES) } : {}), ...(gone.length ? { gone: gone.slice(0, CHANGED_NAMES) } : {}) };
        }
      }
      const first = seen === null;
      seen = now;
      const docs: Record<string, number> = {};
      for (const d of store.roundDocs.filter((x) => x.roundId === round.id)) docs[d.kind] = (docs[d.kind] ?? 0) + 1;
      const coverage = round.coverage ?? null;
      const standing = standingCounts(store, round);
      const zeros = Object.fromEntries([['noPlan', open.workItems.noPlan.notApplicable], ['noModule', open.workItems.noModule.notApplicable], ['noContract', open.tickets.noContract.notApplicable]].filter(([, v]) => v)) as Record<string, string>;
      const notApplicable = Object.keys(zeros).length ? zeros : null;
      return ok({
        round: { id: round.id, kind: round.kind, number: round.number, depth: round.kind === 'Deepen' ? project.takeoverDepth ?? 'Full' : null },
        stage: stageOfRound(round),
        // D103: after the main agent's last stage comes the handover to the synthesis; once handed over, nothing.
        next: handedOver(round) ? null : stageOrder(round.kind)[stageOrder(round.kind).indexOf(stageOfRound(round)) + 1] ?? null,
        ...(handedOver(round) ? { handedOver: { at: round.handover?.at ?? null, handover: round.handover?.docId ?? null, to: 'the synthesis, in a session of its own' } } : {}),
        ...(standing.standing ? { standingNotes: standing } : {}),
        stageLog: (round.stageLog ?? []).map((e) => ({ stage: e.stage, startedAt: e.startedAt, endedAt: e.endedAt, ...(e.why ? { why: e.why } : {}) })),
        lanes: lanesOf(store, round).map((l) => ({ name: l.name, kind: l.kind, status: l.status, reportDocId: l.reportDocId })),
        coverage: coverage ? { at: coverage.at, settled: coverage.settled, untouched: coverage.untouched?.length ?? 0, accounted: coverage.accounted?.length ?? 0 } : null,
        breakpoints: { candidates: bps.filter((b) => !b.lit).length, looked: bps.filter((b) => b.looked).length, lit: bps.filter((b) => b.lit).length, answered: candidatesAnswered(store, round.id).length, withoutResult: open.candidates.count },
        documents: docs,
        open: counts,
        // CS: the program's placements of every round, counted — placed in all, confirmed, moved, still unreviewed (the list).
        ...(open.programPlacements.placed ? { programPlacements: open.programPlacements } : {}),
        // CQ (D104): the defined zeros — a layer the project lacks is said in a sentence, not counted as a list of items.
        ...(notApplicable ? { notApplicable } : {}),
        ...(first ? {} : { changed: Object.keys(changed).length ? changed : 'nothing since your last call' }),
        lists: 'pk_round_state { list: "<key>" } gives one list in full; open gives every key with its count.',
      });
    },
  }));

  /** Every open list's ids with a name, by key: what the next call compares with. */
  const idsByKey = (open: RoundOpen): Map<string, Map<string, string>> => {
    const out = new Map<string, Map<string, string>>();
    for (const [k, v] of Object.entries(OPEN_KEYS)) {
      const m = new Map<string, string>();
      for (const item of v.of(open).items as Record<string, unknown>[]) {
        const id = String(item.id ?? item.path ?? JSON.stringify(item));
        m.set(id, String(item.name ?? item.target ?? item.path ?? id).slice(0, 80));
      }
      out.set(k, m);
    }
    return out;
  };

  /** One list in full by its key: an open list, or one of the round's own (lanes, documents, coverage, owner lines, code anomalies). */
  const fullList = (round: ClerkRound, key: string): { count: number; items: readonly unknown[] } | null => {
    const openKey = OPEN_KEYS[key];
    if (openKey) {
      const v = openKey.of(roundOpen(store, round, { limit: Infinity }));
      return { count: v.count, items: v.items };
    }
    const extra = EXTRA_KEYS.find((k) => k.key === key);
    if (!extra) return null;
    const items = extra.items(store, round, project);
    return { count: items.length, items };
  };

  return tools;
}
