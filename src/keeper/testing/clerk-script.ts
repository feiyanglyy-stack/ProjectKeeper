/**
 * A scripted clerk for the fake provider (fake-provider.ts): it plays a round of the clerk method the way D99 and D103 run
 * it — the main agent through its stages in one session, its lanes each in a session of their own, then the synthesis in
 * a session of its own after the main agent's handover, then the independent spot-check — so a test can drive the planner,
 * the runtime and pi end to end without a model. What the main agent, each lane and the synthesis write is the test's
 * (`ClerkScript`); the moves between stages are the script's:
 *   First usable   orientation (briefs) → skeleton (the test's extras, then the lanes in one call) → reconcile → handover
 *   Deepen         orientation (briefs) → dig (the lanes in one call) → coverage (check, account for every listed group)
 *                  → cross-check → handover (again, with why, when a Full deepening refuses it for candidates with no result)
 *   Follow up      orientation → cross-check (skipping the rest, with why) → handover
 * The handover is `pk_stage({ to: "synthesis", handover })`: the main agent's session ends there. The synthesis job then
 * makes the test's writes for the stage `synthesis` and writes the round's Result.
 * The main agent reads its progress off its own session: a stage entered is a `pk_stage` call that did not fail, a
 * brief is a `pk_write_round_doc` that did not fail. A continued session (a restart, a run again) goes on from there.
 */
import type { LaneKind, RoundKind } from '../../model/k-types.ts';
import { callResults, taskText, type Planner, type ToolCall } from '../fake-provider.ts';
import { slotsUnheld } from '../organize/slots.ts';

type Msg = Parameters<Planner>[1][number];

/** One lane the main agent sends, with its brief. */
export interface ScriptedLane {
  readonly name: string;
  readonly kind: LaneKind;
  readonly slots: readonly string[];
  readonly brief: string;
}

/** What the test decides: the lanes of each round, and what the main agent, the lanes and the spot-check write. */
export interface ClerkScript {
  /** The lanes the main agent sends in a round of this kind (in the skeleton of a first usable round, in a dig). */
  lanes(round: RoundKind): readonly ScriptedLane[];
  /**
   * In a dig, the lanes the main agent sends first (by name); it then tries to leave the dig — the gate of the four kinds
   * of question refuses it when one has no lane (E148 D-g) — and sends the rest. By default it sends them all at once.
   */
  firstBatch?(round: RoundKind): readonly string[];
  /** A lane's writes, in its first turn, before its Report. */
  laneWork?(name: string, task: string): readonly ToolCall[];
  /**
   * The main agent's writes in a stage, once, before it moves on (e.g. `pk_fill_from_table` in the skeleton); for the
   * stage `synthesis`, the synthesis job's writes, once, before it writes the round's Result (D103).
   */
  stageWork?(round: RoundKind, stage: string, task: string, messages: readonly Msg[]): readonly ToolCall[];
  /** The main agent's handover to the synthesis; by default a plain one with its three parts. */
  handover?(round: RoundKind): { readonly settled: string; readonly open: string; readonly first: string };
  /** The spot-check's writes; by default it records one sample item Right, and confirms nothing. */
  spotCheck?(task: string): readonly ToolCall[];
}

/** A refused call, or one a restart or a stop cut short (pi fills its result in with "No result provided"). */
const ERROR = /^(?:ERROR|No result provided)/;
/** A tool's calls in this session that did not fail. */
export const succeeded = (messages: readonly Msg[], tool: string) => callResults(messages as Msg[], tool).filter((c) => !ERROR.test(c.result));
const idOf = (result: string): string | null => /"id": "([^"]+)"/.exec(result)?.[1] ?? null;

export const MAIN_TASK = /^Task: the main agent of this round/m;
const LANE_TASK = /^Task: a lane of this round — (.+?) \((slot|plan|topic|follow-up)\)/m;
export const SYNTHESIS_TASK = /^Task: the synthesis of this round/m;
const SPOT_TASK = /^Task: the independent spot-check/m;
export const laneNameOf = (task: string): string | null => LANE_TASK.exec(task)?.[1] ?? null;
export const roundKindOf = (task: string): RoundKind | null => (/This is (?:takeover|Follow up) round \d+ \((First usable|Deepen|Follow up)\)/.exec(task)?.[1] as RoundKind | undefined) ?? null;
/** Which job a task is: the main agent, a lane (by name), the synthesis, the spot-check, the session drafts, or none of them. */
export function jobOf(task: string): { readonly kind: 'main' | 'lane' | 'synthesis' | 'spot-check' | 'session-drafts' | null; readonly lane: string | null } {
  if (MAIN_TASK.test(task)) return { kind: 'main', lane: null };
  if (SYNTHESIS_TASK.test(task)) return { kind: 'synthesis', lane: null };
  const lane = laneNameOf(task);
  if (lane) return { kind: 'lane', lane };
  if (SPOT_TASK.test(task)) return { kind: 'spot-check', lane: null };
  if (/^Task: session drafts/m.test(task)) return { kind: 'session-drafts', lane: null };
  return { kind: null, lane: null };
}

const stage = (to: string, why?: string): ToolCall => ({ name: 'pk_stage', args: { to, ...(why ? { why } : {}) } });
/** A plain handover with its three parts (D103), for a script that gives none of its own. */
export const HANDOVER = { settled: 'The lanes are joined into one trunk; every placement the records give is written.', open: 'Nothing is left open that a record settles.', first: 'The lane reports, then the work items.' } as const;
/** The handover call: the main agent's last. */
const handOver = (script: ClerkScript, round: RoundKind, why?: string): ToolCall => ({ name: 'pk_stage', args: { to: 'synthesis', ...(why ? { why } : {}), handover: script.handover?.(round) ?? HANDOVER } });
const brief = (l: ScriptedLane): ToolCall => ({ name: 'pk_write_round_doc', args: { kind: 'Brief', path: l.name, title: l.name, markdown: l.brief } });

/** The main agent's next calls, from what its session shows it has done. */
function mainTurn(script: ClerkScript, task: string, messages: readonly Msg[]): ToolCall[] | string {
  const round = roundKindOf(task);
  if (!round) return 'The main agent cannot tell which round this is.';
  const entered = succeeded(messages, 'pk_stage').map((c) => String(c.args.to));
  const at = entered[entered.length - 1] ?? 'orientation';
  const lanes = script.lanes(round);
  const briefs = succeeded(messages, 'pk_write_round_doc').filter((c) => c.args.kind === 'Brief').map((c) => ({ path: String(c.args.path), id: idOf(c.result) }));
  const sent = succeeded(messages, 'pk_send_lanes').length > 0;
  // The test's writes for this stage, once each: a call is made when no call of that tool with the same arguments was.
  const made = (c: ToolCall): boolean => callResults(messages as Msg[], c.name).some((r) => JSON.stringify(r.args) === JSON.stringify(c.args));
  const extras = (s: string): ToolCall[] => [...(script.stageWork?.(round, s, task, messages) ?? [])].filter((c) => !made(c));
  const doneExtras = (s: string): boolean => extras(s).length === 0;
  const sentNames = new Set(succeeded(messages, 'pk_send_lanes').flatMap((c) => ((c.args.lanes as { name: string }[] | undefined) ?? []).map((l) => l.name)));
  // DB: a first usable round's skeleton accounts for every slot of the workbench — held by a lane, or one line on why not.
  const empty = round === 'First usable' ? slotsUnheld(lanes.flatMap((l) => l.slots), []).map((u) => ({ slot: u.slot, why: `The project has nothing for it: no document of it states ${u.holds.split(':')[0]}.` })) : [];
  const send = (which: readonly ScriptedLane[] = lanes): ToolCall => ({ name: 'pk_send_lanes', args: { lanes: which.map((l) => ({ name: l.name, kind: l.kind, briefDocId: briefs.find((b) => b.path === l.name)?.id ?? '', slots: [...l.slots] })), ...(empty.length ? { empty } : {}) } });
  // D103: the main agent's session ends with its handover; the synthesis is a job of its own (`synthesisTurn`).
  const handedOver = (): string => `The ${round} round is handed over to the synthesis.`;
  if (round === 'Follow up') {
    if (at === 'orientation') return doneExtras('orientation') ? [stage('cross-check', 'Nothing in the document chain changed and nothing needs digging')] : extras('orientation');
    if (at === 'cross-check') return doneExtras('cross-check') ? [handOver(script, round)] : extras('cross-check');
    return handedOver();
  }
  if (at === 'orientation') {
    if (!doneExtras('orientation')) return extras('orientation');
    const missing = lanes.filter((l) => !briefs.some((b) => b.path === l.name));
    return [...missing.map(brief), stage(round === 'First usable' ? 'skeleton' : 'dig', lanes.length ? undefined : 'Nothing to dig this round')];
  }
  if (round === 'First usable') {
    if (at === 'skeleton') {
      if (!doneExtras('skeleton')) return extras('skeleton');
      if (lanes.length && !sent) return [send()];
      return [stage('reconcile')];
    }
    if (at === 'reconcile') return doneExtras('reconcile') ? [handOver(script, round)] : extras('reconcile');
    return handedOver();
  }
  // Deepen.
  if (at === 'dig') {
    if (!lanes.length) return [stage('coverage')];
    const first = script.firstBatch?.(round);
    if (!sent) return [send(first ? lanes.filter((l) => first.includes(l.name)) : lanes)];
    const rest = lanes.filter((l) => !sentNames.has(l.name));
    if (!rest.length) return [stage('coverage')];
    // Some lanes are still unsent: try to leave the dig first, and send the rest once the gate refuses it.
    const refused = callResults(messages as Msg[], 'pk_stage').some((c) => c.args.to === 'coverage' && ERROR.test(c.result));
    return refused ? [send(rest)] : [stage('coverage')];
  }
  if (at === 'coverage') {
    // The check once the lanes are back; every group it lists accounted for, in one turn; then on to the cross-check.
    const checks = succeeded(messages, 'pk_coverage_check');
    if (!checks.length) return [{ name: 'pk_coverage_check', args: {} }];
    const accounted = callResults(messages as Msg[], 'pk_account_material');
    const listed = JSON.parse(checks[checks.length - 1]!.result) as { untouched: { group: string; read: 'none' | 'part' }[]; settled: boolean };
    if (!listed.settled && !accounted.length) {
      return listed.untouched.map((g) => ({ name: 'pk_account_material', args: { group: g.group, outcome: g.read === 'part' ? 'part' : 'not needed', why: g.read === 'part' ? 'The part read answers this round’s questions' : 'Nothing this round asks rests on it' } }));
    }
    const tried = callResults(messages as Msg[], 'pk_stage').filter((c) => c.args.to === 'cross-check').length;
    return tried < 3 ? [stage('cross-check')] : 'The coverage stays open: the cross-check was refused.';
  }
  if (at === 'cross-check') return doneExtras('cross-check') ? [toSynthesis(script, round, messages)] : extras('cross-check');
  return handedOver();
}

/**
 * The handover to the synthesis; when a Full deepening refused it for candidates with no result (CD), again with why — the
 * way a main agent leaves candidates it could not settle to the next round.
 */
function toSynthesis(script: ClerkScript, round: RoundKind, messages: readonly Msg[]): ToolCall {
  const refused = callResults(messages as Msg[], 'pk_stage').some((c) => c.args.to === 'synthesis' && /no result yet/.test(c.result));
  return handOver(script, round, refused ? 'The candidates still without a result are left to the next round: no lane of this round covered them.' : undefined);
}

/**
 * The synthesis (D103), in its own session: the test's writes for the stage `synthesis`, once each, then the round's
 * Result, then its summary. It reads its progress off its own session, so a continued one goes on from there.
 */
function synthesisTurn(script: ClerkScript, task: string, messages: readonly Msg[]): ToolCall[] | string {
  const round = roundKindOf(task);
  if (!round) return 'The synthesis cannot tell which round this is.';
  const made = (c: ToolCall): boolean => callResults(messages as Msg[], c.name).some((r) => JSON.stringify(r.args) === JSON.stringify(c.args));
  const extras = [...(script.stageWork?.(round, 'synthesis', task, messages) ?? [])].filter((c) => !made(c));
  if (extras.length) return extras;
  if (!succeeded(messages, 'pk_write_round_doc').some((c) => c.args.kind === 'Result')) return [{ name: 'pk_write_round_doc', args: { kind: 'Result', title: 'Result of the round', markdown: `# Result\n\nThe ${round} round is on the workbench.` } }];
  return `The ${round} round is done.`;
}

/** A lane: its writes and its Report in one turn, then its summary. */
function laneTurn(script: ClerkScript, name: string, task: string, messages: readonly Msg[], afterTool: boolean): ToolCall[] | string {
  if (afterTool || succeeded(messages, 'pk_write_round_doc').some((c) => c.args.kind === 'Report')) return `The ${name} lane wrote its slots and its report.`;
  return [...(script.laneWork?.(name, task) ?? []), { name: 'pk_write_round_doc', args: { kind: 'Report', title: `Report: ${name}`, markdown: `# Report: ${name}\n\n## Present now\n- What the ${name} lane found, cited.\n` } }];
}

/**
 * The spot-check: what the test says, or — the round's final re-check (D103) — every target it is given to check in full
 * (the notes, what the synthesis wrote, the Result) and one sample item, each recorded Right; then its document.
 */
function spotTurn(script: ClerkScript, task: string, messages: readonly Msg[]): ToolCall[] | string {
  if (succeeded(messages, 'pk_write_round_doc').some((c) => c.args.kind === 'Spot check')) return 'The spot-check is recorded.';
  if (callResults(messages as Msg[], 'pk_record_spot_check').length === 0) {
    const own = script.spotCheck?.(task);
    if (own) return [...own];
    const TARGET = /^- (\w+) ([a-z]+_[0-9a-z_-]{4,}):/gm;
    const sampleAt = task.indexOf('=== The sample');
    const fullAt = task.indexOf('=== Checked in full');
    const full = fullAt < 0 ? [] : [...task.slice(fullAt, sampleAt < 0 ? undefined : sampleAt).matchAll(TARGET)];
    const sample = sampleAt < 0 ? [] : [...task.slice(sampleAt).matchAll(TARGET)].slice(0, 1);
    const targets = [...full, ...sample].map((m) => ({ collection: m[1]!, id: m[2]! }));
    return [{ name: 'pk_record_spot_check', args: { checked: (targets.length ? targets : [{ collection: 'threads', id: 'thread_none' }]).map((target) => ({ target, kind: target.collection === 'notes' ? 'note' : target.collection === 'roundDocs' ? 'the Result’s claims' : 'progress', verdict: 'Right' })) } }];
  }
  return [{ name: 'pk_write_round_doc', args: { kind: 'Spot check', title: 'Spot check', markdown: '# Spot check\n\nChecked what the block lists.' } }];
}

/**
 * The fake provider's planner for a scripted clerk. `route` may take a request first (return a value to answer it), for
 * a test's own jobs.
 */
export function clerkPlanner(script: ClerkScript, route?: (task: string, messages: readonly Msg[], afterTool: boolean) => ToolCall[] | string | undefined): Planner {
  return (prompt, messages, afterTool = false) => {
    const task = taskText(messages) || prompt;
    const own = route?.(task, messages, afterTool);
    if (own !== undefined) return own;
    const job = jobOf(task);
    if (job.kind === 'main') return mainTurn(script, task, messages);
    if (job.kind === 'lane') return laneTurn(script, job.lane!, task, messages, afterTool);
    if (job.kind === 'synthesis') return synthesisTurn(script, task, messages);
    if (job.kind === 'spot-check') return spotTurn(script, task, messages);
    return afterTool ? '' : 'Nothing to do (scripted clerk).';
  };
}
