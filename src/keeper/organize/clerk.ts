/**
 * The clerk method's rounds (Spec v3.0 §3.3, §3.7, §3.8; CKC-23, CKC-13 v3.1, CKC-07 v3.0), as D99 runs them.
 *
 * A round — the takeover's first usable round, the deepening at the depth the owner chose, each Follow up — is the
 * program's groundwork, then one main agent, then the synthesis in a session of its own (D103), then the independent
 * spot-check and the program's process:
 *
 *   First usable   ledger → session drafts → main → synthesis → process
 *   Deepen         ledger → session drafts → main → synthesis → spot-check → process
 *   Follow up      ledger → session drafts → main → synthesis → spot-check → process
 *
 * The main agent is one model job in one pi session through the round's stages (`ClerkRound.stage`, clerk-steps.ts
 * `ROUND_STAGES`): it moves on with `pk_stage`, which records each stage and returns its skill, and it sends its lanes —
 * subagents that answer a question each and write their slots — several in one `pk_send_lanes` call (lane-tools.ts). Each
 * stage has a skill (skills.ts); the program keeps the order, the four kinds of question, the coverage gate and the
 * breakpoint candidates (stage-tools.ts). The main job is done once it has handed the round over (`ClerkRound.handover`):
 * its last stage — the reconciling, or the cross-check — ends with `pk_stage({ to: "synthesis", handover })`. A session
 * that ends before is run again in its own session, told which stage it stopped at.
 *
 * The synthesis (D103; the owner: 「可以，合成另开会话，做吧」) is the round's product look-back, one model job in a fresh pi
 * session, the way the spot-check is: it was not there for the round, so it is given the round's documents by reference —
 * the question list, the lanes' briefs and reports, the adoption record — the main agent's handover, the lanes' Unsure
 * items, what is still open as counts, the candidates' state, what the six things are judged from, what the round wrote
 * by position, and (a deepening, a Follow up) the notes still current from earlier rounds, each of which gets a result
 * (`startSynthesis`). It reads the reports first and then writes the notes, the six things, the send-backs, area
 * understanding and the round's Result. It is done once the round has its Result; a session that ends before is run again
 * in its own session. On the CM run the main agent entered the synthesis at 341–399K tokens and wrote, within three
 * minutes and from memory, the two notes the spot-check had to correct.
 *
 * The planner is a pull like the one before it: after every job it looks at the round under way and starts the next step
 * whose predecessors are done.
 *
 * Every job is given the organizing plan as it stands when it is queued (Spec §3.7; D62, the owner: 「之后的整理照它执行」),
 * so the owner's correction in conversation applies to whatever is not yet queued (D97).
 *
 * What a round produced is counted by the program when it closes (CKC-23 AC-6): the writes of its jobs by workbench
 * position, what served as groundwork, and what served nothing.
 *
 * A round runs through (Spec §3.10; owner D97): a step's job that ends without finishing is run again by the program, and
 * one that still does not finish is listed — on the round and in the coverage, with why — and the round goes on with what
 * was saved (`stepEnding`, `RUN_AGAIN_LIMIT`). Only the owner's Stop holds a round, until the owner continues it. The
 * main agent's lanes are the main agent's to run again (`pk_send_lanes`), not the planner's.
 */
import type { App } from '../../server/app.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import type { ClerkRound, ClerkStage, KeeperNumber, RoundDoc, RoundFailure, RoundKind, RoundStepKind } from '../../model/k-types.ts';
import type { JudgementRecord, KeeperJob, Project, Usage } from '../../model/types.ts';
import { newId } from '../../model/ids.ts';
import { organizingHeld } from '../held.ts';
import { countRound, roundResultOf, startRound as openFollowUpRecord } from '../adjustment.ts';
import { syncProjectFolder } from '../project-folder.ts';
import { scheduleDueFor, scheduleInForce } from './schedule-state.ts';
import { takeoverState } from './takeover-state.ts';
import { codeAnomalyCandidates, type CodeAnomalyCandidate } from '../../codemap/facts.ts';
import { computeBreakpoints, processBlock } from '../../process/index.ts';
import { Facts } from '../../process/facts.ts';
import { buildUnits, type UnitIndex } from '../../process/units.ts';
import { breakpointClaims, claimCheckBlock, type ClaimText } from '../../process/claim-check.ts';
import { SPOT_CHECK_SAMPLE, placementLine, spotCheckBlock, spotCheckTargets } from '../../process/breakpoint-candidates.ts';
import { settleProgramPlacements } from './placement-inference.ts';
import { unnumberedWorkBlock } from '../../process/unnumbered.ts';
import { ownerUtterances } from '../../sources/sessions/utterances.ts';
import { positioningBlock } from './positioning.ts';
import { clerkStepPrompt } from './clerk-prompts.ts';
import { judgedLinesBlock, ownerLinesCountBlock } from './owner-lines.ts';
import { emptySlotsBlock } from './slots.ts';
import { generationCandidatesBlock } from './generation-check.ts';
import { clerkPending } from './clerk-coverage.ts';
import { roundBaseline, roundNews } from './round-news.ts';
import { HANDOVER_TO, ROUND_STAGES } from '../clerk-steps.ts';
import { roundBlockOf, rulesBlockOf } from './round-blocks.ts';
import { spotCheckSkill, stageSkill, synthesisSkill } from './skills.ts';
import { absenceLookedBlock, unsureBlock } from './absence.ts';
import { handedOver, lastStageOf, stageOfRound } from './stage-gate.ts';
import { endStage, handoverDoc, recomputesCandidates, skippableStages } from './stage-tools.ts';
import { lanesOf } from './lane-tools.ts';
import { candidatesAnswered, OPEN_KEYS, openCounts, roundOpen, unplacedNote } from './round-open.ts';
import { looksAtStandingNotes, standingCounts, standingNotesBlock } from './standing-notes.ts';

export const ACTIVE_STATUSES: readonly string[] = ['Queued', 'Running', 'Waiting for quota', 'Paused'];

// ───────────────────────── a step that did not finish (Spec §3.10) ─────────────────────────

/**
 * How many times the program runs a step's job again by itself (Spec §3.10: 瞬时失败自动重试；多次失败后停下，列入覆盖情况的
 * 失败清单并写明原因，不静默跳过): twice, so a job runs at most three times before it is listed and the round goes on
 * without it. The same job runs again, with what it saved kept and why its last run ended at the end of its task.
 * - A run that a restart of ProjectKeeper cut short goes on and does not count (§3.10: 被中断的单项工作按 Continue 的规则继续).
 * - The owner's Retry or Continue starts the count again.
 * - The owner's Stop is the owner's choice: the round waits until the owner continues the job.
 * - A job its time limit stopped is not run again by itself: the limit is there for a step that never ends, and another run
 *   would give it the same hours again. It is listed at once; the owner can Continue it.
 */
export const RUN_AGAIN_LIMIT = 2;

/** One earlier run of a round step's job that ended without finishing, kept on the job (`task.extra.runs`). */
export interface StepRun {
  readonly endedAt: string;
  readonly status: 'Failed' | 'Stopped';
  readonly reason: string;
  /** What it had spent: the job's usage when that run ended. runtime.ts `run` counts a run from zero, except a run that
   *  goes on from an interrupted one — a restart, the provider's limits — which adds to it (D99). */
  readonly usage: Usage | null;
  /** Who ran it again, and when. */
  readonly again: 'program' | 'owner';
  readonly at: string;
  /** Whether it counts toward RUN_AGAIN_LIMIT: a run a restart cut short does not, nor one the owner ran again. */
  readonly counted: boolean;
}

/**
 * How a step's job stands for its round: finished, still going, stopped by the owner (the round waits), to be run again
 * now, or listed as not finished (the round goes on without it).
 */
export type StepEnding =
  | { readonly kind: 'done' | 'active' | 'owner' }
  | { readonly kind: 'again'; readonly reason: string; readonly counted: boolean }
  | { readonly kind: 'listed'; readonly reason: string; readonly runs: number };

/** The runtime's words for a job a restart cut short (runtime.ts `init`) and one its time limit stopped (`run`). */
const RESTARTED = /restarted while this work was running/i;
const TIME_LIMIT = /time limit/i;

type JobExtra = { readonly runs?: readonly StepRun[]; readonly program?: string } & Record<string, unknown>;
const extraOfJob = (job: KeeperJob): JobExtra => ((job.task as { extra?: JobExtra | null } | null)?.extra ?? {});

/** The earlier runs of a step's job that ended without finishing, oldest first. */
export const runsOf = (job: KeeperJob): readonly StepRun[] => extraOfJob(job).runs ?? [];

/** A job that stands for the program's own part of a step — starting it, or holding its reading against the plan — when that part threw. */
export const isProgramPart = (job: KeeperJob): boolean => job.agent === 'program' && extraOfJob(job).program === 'part';

const reasonOf = (job: KeeperJob): string => job.error?.trim() || `${job.status === 'Stopped' ? 'Stopped' : 'Failed'} with no reason recorded`;

/**
 * The program's part of a step can run again when it can do so without doubling what is there: the step has not started
 * (no job of it but such parts).
 */
function partCanRunAgain(store: ProjectStore, job: KeeperJob): boolean {
  if (!job.step) return false;
  const { roundId, kind } = job.step;
  return !store.jobs.find((j) => j.step?.roundId === roundId && j.step.kind === kind && !isProgramPart(j));
}

/**
 * How a round step's job stands (`StepEnding`), by the rule of `RUN_AGAIN_LIMIT`. Once its round has closed, nothing of
 * it runs again by itself: what did not finish is listed, and runs again only when the owner asks.
 */
export function stepEnding(store: ProjectStore, job: KeeperJob): StepEnding {
  if (job.status === 'Done') return { kind: 'done' };
  if (ACTIVE_STATUSES.includes(job.status)) return { kind: 'active' };
  const runs = runsOf(job);
  const reason = reasonOf(job);
  const listed: StepEnding = { kind: 'listed', reason, runs: runs.length + 1 };
  const round = job.step ? store.clerkRounds.get(job.step.roundId) : undefined;
  if (round && round.status !== 'Running') return listed;
  if (job.status === 'Stopped') {
    if (RESTARTED.test(reason)) return { kind: 'again', reason, counted: false };
    if (TIME_LIMIT.test(reason)) return listed;
    return { kind: 'owner' };
  }
  if (job.status !== 'Failed') return { kind: 'owner' };
  if (isProgramPart(job) && !partCanRunAgain(store, job)) return { kind: 'listed', reason: `${reason} (the step had started in part, so it is not started again)`, runs: runs.length + 1 };
  // A job the program did itself runs again only if it is the ledger, the process or the program's part of a step.
  if (job.agent === 'program' && !isProgramPart(job) && job.step?.kind !== 'ledger' && job.step?.kind !== 'process') return listed;
  // What the program ran again since the owner last did: the owner's Retry or Continue starts the count again.
  const since = runs.slice(runs.map((r) => r.again).lastIndexOf('owner') + 1).filter((r) => r.counted).length;
  return since < RUN_AGAIN_LIMIT ? { kind: 'again', reason, counted: true } : listed;
}

/** The main agent's work in a round is done once it has handed the round over to the synthesis (D103). */
export function mainFinished(_store: ProjectStore, round: ClerkRound): boolean {
  return handedOver(round);
}

/** The synthesis' work in a round is done once the round has its Result (D103: 合成才算完). */
export function synthesisFinished(store: ProjectStore, round: Pick<ClerkRound, 'id'>): boolean {
  return store.roundDocs.find((d) => d.roundId === round.id && d.kind === 'Result') !== undefined;
}

/** "failed 3 times", "was stopped at its time limit": how a listed job ended, in words. */
function endedText(status: 'Failed' | 'Stopped', runs: number): string {
  return status === 'Stopped' ? 'was stopped' : runs > 1 ? `failed ${runs} times` : 'failed';
}

/**
 * What the coverage's failure list says of a round step's job that did not finish (Spec §3.10, §1.11): which job, how it
 * ended and why, and where it stands — run again by the program (once organizing resumes, when it is paused: `held`),
 * waiting for the owner, or listed with the round going on (or closed) without it.
 */
export function stepFailureText(store: ProjectStore, job: KeeperJob, held = false): string {
  const round = job.step ? store.clerkRounds.get(job.step.roundId) : undefined;
  const e = stepEnding(store, job);
  const runs = runsOf(job).length + 1;
  const again = job.status === 'Stopped' ? 'Continue' : 'Retry';
  if (e.kind === 'owner') return `${job.scope.label}: stopped by you — the round waits until you Continue it`;
  if (e.kind === 'again') {
    const when = held ? ' once organizing resumes' : '';
    return e.counted
      ? `${job.scope.label}: ${endedText('Failed', runs)} — ${e.reason}. ${job.step?.kind === 'lane' ? 'The main agent runs it again when it sends its lanes again' : `The program runs it again${when}`}`
      : `${job.scope.label}: cut short when ProjectKeeper restarted — it goes on${when}`;
  }
  if (e.kind !== 'listed') return `${job.scope.label}: ${job.status}`;
  const where = round && round.status !== 'Running' ? `${round.kind} round ${round.number} closed without it` : 'the round went on without it';
  return `${job.scope.label}: ${endedText(job.status === 'Stopped' ? 'Stopped' : 'Failed', e.runs)} — ${e.reason}. Listed: ${where}; ${again} runs it again`;
}

/** A listed job as the round lists it. */
function failureOf(job: KeeperJob, reason: string, runs: number, at: string): RoundFailure {
  return { jobId: job.id, step: job.step!.kind, label: job.scope.label, status: job.status === 'Stopped' ? 'Stopped' : 'Failed', reason, runs, at };
}

const CONTINUING = '\n\n=== This job ran before and did not finish';

/**
 * A job's task with its earlier runs at the end, for the model that runs it again: when and how each ended and why, what
 * the job saved (it stays where it was saved), and to go on from there. Written afresh on every run again.
 */
export function withEarlierRuns(prompt: string, job: KeeperJob, runs: readonly StepRun[]): string {
  const base = prompt.split(CONTINUING)[0] ?? prompt;
  const ended = runs.map((r, i) => `${i + 1}. ${r.endedAt.slice(0, 16).replace('T', ' ')} UTC — ${r.status === 'Stopped' ? 'stopped' : 'failed'}: ${r.reason}${r.again === 'owner' ? ' (the owner ran it again)' : ''}`);
  const saved = job.savedResults.map((s) => `- ${s.collection} ${s.id}: ${s.label.replace(/\s+/g, ' ').slice(0, 160)}`);
  return [
    `${base}${CONTINUING} — this is run ${runs.length + 1}`,
    ...ended,
    saved.length ? `What its earlier runs saved stays where it was saved (${saved.length}):\n${saved.join('\n')}` : 'Its earlier runs saved nothing that is kept.',
    'Go on from there: read back what you need, do not write again what is saved, and do what is left of the task. When the reason above is something the job did — a call the tools refused, a reply cut off at the output limit — do it differently this time.',
  ].join('\n');
}

/** What did not finish earlier in the round, for a step that starts after it (the round goes on with what was saved). */
function failuresBlock(failures: readonly RoundFailure[]): string {
  return [
    '=== What did not finish earlier in this round',
    ...failures.map((f) => `- ${f.label} (${f.jobId}): ${endedText(f.status, f.runs)} — ${f.reason}`),
    'What those jobs saved is on the workbench; what they did not do is missing. Work from what is there, and where a gap leaves your work without its ground, say so in what you write rather than assume it was done.',
  ].join('\n');
}

/**
 * The steps of each kind of round, in order (§3.3, §3.7, §3.8; D99, D103). `ledger` and `process` are the program's; `main`
 * is the main agent through its stages, whose lanes it sends itself; `synthesis` is the round's product look-back in a
 * session of its own, after the main agent's handover; `spot-check` is the independent check of a deepening and a Follow
 * up — the round's final re-check, after the synthesis (a first usable round lights nothing and gets none, CKC-23 AC-22:
 * the notes it wrote are given a result by the next round's synthesis and checked by that round's spot-check).
 */
export const ROUND_STEPS: Readonly<Record<RoundKind, readonly RoundStepKind[]>> = {
  'First usable': ['ledger', 'session-drafts', 'main', 'synthesis', 'process'],
  Deepen: ['ledger', 'session-drafts', 'main', 'synthesis', 'spot-check', 'process'],
  'Follow up': ['ledger', 'session-drafts', 'main', 'synthesis', 'spot-check', 'process'],
};

/**
 * The lists the program computes for a job to judge from, besides the round's own blocks (Spec §3.3: the model judges,
 * the program supplies what it judges from; D76). Found missing in test-C-1, and the owner's rule of 2026-09-28:
 * - `owner-lines`: the owner's Decision and Confirmation lines no rule or Owner's words item cites yet — for the jobs
 *   that write rules and Owner's words;
 * - `claims`: for the items a "let pass" or "dropped" claim names, the later commits, merges and reports that name them —
 *   for the jobs that adopt, write or check such claims;
 * - `unnumbered`: the work merged without a task number — for the jobs that build work items.
 * - `unsure` (CN, E152): what this round's lane reports marked Unsure — for the synthesis, which writes the notes, and
 *   the spot-check, which checks them: an Unsure is read to settle it or written as unsure, never restated as fact.
 * The main agent (D99) is given its first stage's lists in its prompt and each later stage's as it enters it
 * (`stageBlocksOf`, `stageEntered`); the synthesis (D103) and the spot-check are given theirs in their prompts.
 */
export type MethodBlock = 'owner-lines' | 'claims' | 'unnumbered' | 'unsure';

/**
 * The lists the main agent is given with each stage (D99; the skills say they "come as a block given with this stage"):
 * orientation the owner's lines (in the main job's prompt, its first stage); the reconciling the owner's lines and the
 * unnumbered work; the cross-check the owner's lines and the claims, and in a Follow up the unnumbered work too.
 * `pk_stage` returns them as the stage is entered (`stageEntered`). The handover gives the main agent none (D103): the
 * claims and the lanes' Unsure items go to the synthesis job, in its prompt (`methodBlocksOf`).
 */
export function stageBlocksOf(stage: ClerkStage, round: RoundKind): MethodBlock[] {
  switch (stage) {
    case 'orientation': return ['owner-lines'];
    case 'reconcile': return ['owner-lines', 'unnumbered'];
    case 'cross-check': return round === 'Follow up' ? ['owner-lines', 'claims', 'unnumbered'] : ['owner-lines', 'claims'];
    default: return [];
  }
}
/** The lists a job the planner starts is given in its prompt: the main agent its first stage's; the synthesis and the spot-check the claims and the lanes' Unsure items. */
export function methodBlocksOf(step: RoundStepKind, round: RoundKind): MethodBlock[] {
  switch (step) {
    case 'main': return stageBlocksOf('orientation', round);
    case 'synthesis': return ['claims', 'unsure'];
    case 'spot-check': return ['claims', 'unsure'];
    default: return [];
  }
}

const STEP_LABEL: Readonly<Record<RoundStepKind, string>> = {
  ledger: 'Ledger', 'session-drafts': 'Session drafts', orientation: 'Orientation', skeleton: 'Skeleton', dig: 'Deep sweep',
  'cross-check': 'Cross-check', process: 'Process and breakpoints', synthesis: 'Synthesis', 'spot-check': 'Spot-check',
  main: 'Main agent', lane: 'Lane',
};

/**
 * No job has a time limit that would cut it short in this round (owner D90: 「这一轮不管时间和token」); the limit only
 * guards against a job that never ends. A job stopped by it is listed as not finished and the round goes on without it
 * (`stepEnding`); the owner can Continue it. The main agent goes through every stage in one session and waits for its
 * lanes, so its limit is about a day; a lane's, the synthesis' and every other step's is eight hours (E148 D-j).
 */
const STEP_TIMEOUT_MS = 8 * 60 * 60_000;
const MAIN_TIMEOUT_MS = 24 * 60 * 60_000;

/** Owner text per session-draft job, so one job never drowns in a long history of sessions. */
const DRAFT_CHARS_PER_JOB = 60_000;
const DRAFT_SESSIONS_PER_JOB = 8;

/**
 * The program step (§1.16, CKC-22 AC-16): bring the ledger up to date. The ledger is built by `src/ledger`; until a build
 * carries it, the runner is absent and the step records that the ledger was not available.
 */
export interface LedgerRunner {
  /** `keeperNumbers`: the numbers the Keeper gave, for the ledger to record with the project's own (CKC-22 AC-5). */
  run(project: Project, extra?: { readonly keeperNumbers?: readonly KeeperNumber[] }): Promise<{ readonly commitsAdded: number; readonly note?: string }>;
}

/**
 * The program step after the trunk is built or cross-checked and before the synthesis (§2.12, §3.7): each work item's
 * steps from the ledger and the links the round confirmed, the breakpoints lit and put out, the send-backs moved on. It
 * runs every round, so what the program computes is recomputed each time; the synthesis reads what it left.
 */
export interface ProcessRunner {
  run(store: ProjectStore, project: Project, roundId: string): Promise<{ readonly note: string }>;
}

type StepStart = 'started' | 'skipped' | 'wait';

export class ClerkPlanner {
  private readonly app: App;
  private ledger: LedgerRunner | null;
  private process: ProcessRunner | null = null;
  private readonly ledgerRunning = new Set<string>();
  private readonly processRunning = new Set<string>();

  constructor(app: App, ledger: LedgerRunner | null = null) {
    this.app = app;
    this.ledger = ledger;
    // D99: the main agent's `pk_stage` reaches the planner as it enters a stage (runtime hook).
    if (app?.keeper?.hooks) app.keeper.hooks.stageEntered = (projectId, roundId, stage) => this.stageEntered(projectId, roundId, stage);
  }

  setLedgerRunner(runner: LedgerRunner | null): void { this.ledger = runner; }
  setProcessRunner(runner: ProcessRunner | null): void { this.process = runner; }

  /** The clock the schedule is read against; a test sets it. */
  clock: () => number = () => Date.now();

  /**
   * One planning pass for a project: advance the round under way, or start the next round when one is due. Nothing is
   * planned for a project the owner has not started (D105), while its material is still being read in after `Start`,
   * or while it is being cleared.
   */
  async plan(projectId: string): Promise<void> {
    if (this.app.isClearing?.(projectId)) return;
    const store = this.app.store(projectId);
    const project = this.app.project(projectId);
    const running = this.runningRound(store);
    if (running) {
      // A scheduled time that comes while a round runs starts no second round; what changed meanwhile is the next round's (§3.8).
      this.scheduledTime(store, project, true);
      await this.advance(store, this.app.project(projectId), running);
      return;
    }
    if (organizingHeld(project)) return;
    if (store.clerkRounds.size === 0 && this.app.intakeBusy?.(projectId)) return;
    const next = this.nextRoundKind(store, project);
    if (!next) return;
    const round = this.startRound(store, this.app.project(projectId), next);
    await this.advance(store, this.app.project(projectId), round);
  }

  runningRound(store: ProjectStore): ClerkRound | null {
    return store.clerkRounds.filter((r) => r.status === 'Running').sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0] ?? null;
  }

  /**
   * The next round due (§3.7, §3.8; D105). Nothing is due on a project the owner has not started: adding a project
   * starts no round. From `Start` the first usable round comes first, then — without asking again — the deepening to the
   * depth chosen before the start (`Full` or `Focused`; `First picture only` deepens nothing). A depth deeper than the
   * one that ran, chosen afterwards, is a further deepening that goes on from what is done. Follow up rounds come once
   * the takeover is done, on the owner's schedule or when the owner presses Follow up. A round the owner stopped, or one
   * that failed, is not started again by itself: the owner continues or retries its step.
   */
  nextRoundKind(store: ProjectStore, project: Project): RoundKind | null {
    const state = takeoverState(store, project);
    if (state.phase === 'Not started') return null;
    const last = (kind: RoundKind) => state.rounds.filter((r) => r.kind === kind).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const first = last('First usable');
    if (!first) return 'First usable';
    if (first.status !== 'Done') return null;
    if (state.phase === 'Under way') {
      const deepen = last('Deepen');
      // A deepening that did not close waits for the owner; one that closed short of the chosen depth is followed by a deeper one.
      return deepen && deepen.status !== 'Done' ? null : 'Deepen';
    }
    return this.followUpDue(store, project) ? 'Follow up' : null;
  }

  /**
   * A Follow up is due when the owner pressed Follow up since the last round (nothing new is needed then); on a
   * `Continuous` schedule, when something waits; and otherwise when a scheduled time has come that was not dealt with
   * (`scheduledTime`) and something waits for a round — what the coverage shows as pending (clerk-coverage.ts): material
   * read since the latest round started, so what came in while a round ran is the next round's (CKC-07 AC-24), and the
   * Keeper's own commit of its project folder opens no round. A scheduled time with nothing to organize starts no round
   * and is recorded as such, so the `Daily` page can say so (§3.8; CKC-07 AC-30).
   */
  private followUpDue(store: ProjectStore, project: Project): boolean {
    const lastEnd = store.clerkRounds.all().reduce((at, r) => ((r.endedAt ?? '') > at ? r.endedAt ?? '' : at), '');
    if ((project.followUpAt ?? '') > lastEnd) return true;
    if (scheduleInForce(project, takeoverState(store, project).completedAt).frequency === 'Continuous') return clerkPending(store, project).pending.length > 0;
    return this.scheduledTime(store, project, false);
  }

  /** What starts the Follow up round that is due now: the owner's press since the last round, else the schedule. */
  private followUpStartedBy(store: ProjectStore, project: Project): 'owner' | 'schedule' | 'continuous' {
    const lastEnd = store.clerkRounds.all().reduce((at, r) => ((r.endedAt ?? '') > at ? r.endedAt ?? '' : at), '');
    if ((project.followUpAt ?? '') > lastEnd) return 'owner';
    return scheduleInForce(project, takeoverState(store, project).completedAt).frequency === 'Continuous' ? 'continuous' : 'schedule';
  }

  /**
   * Deal with a scheduled time that has come (§3.8 到了时间): returns whether a round is to start for it. With a round
   * already running none starts and what changed is left to the next round; with nothing changed none starts either.
   * Either way the time is recorded as dealt with on the project, so times missed while ProjectKeeper was not running
   * are made up for once — the latest one stands for all of them — and no time is acted on twice.
   */
  private scheduledTime(store: ProjectStore, project: Project, roundRunning: boolean): boolean {
    const state = takeoverState(store, project);
    if (state.phase !== 'Done') return false;
    const due = scheduleDueFor(store, project, state.completedAt, this.clock());
    if (!due) return false;
    const changed = roundRunning ? false : clerkPending(store, project).pending.length > 0;
    const outcome = roundRunning ? 'a round was running' as const : changed ? 'round' as const : 'nothing changed' as const;
    this.app.updateProject({ ...this.app.project(project.id), scheduleHandled: { slot: due.slot.toISOString(), at: new Date(this.clock()).toISOString(), outcome, roundId: null } });
    return changed;
  }

  // ───────────────────────── rounds ─────────────────────────

  startRound(store: ProjectStore, project: Project, kind: RoundKind): ClerkRound {
    const number = store.clerkRounds.size + 1;
    const id = newId('crd');
    // A deepening runs at the depth the takeover runs to, and keeps it on its own record: what ran is read from there.
    const depth = kind === 'Deepen' ? takeoverState(store, project).chosen ?? project.takeoverDepth ?? 'Full' : null;
    const label = kind === 'First usable' ? `Takeover round ${number}: the first usable picture` : kind === 'Deepen' ? `Takeover round ${number}: deepening (${depth})` : `Follow up round ${number}`;
    const root = this.app.keeper.recordProgramJob(project.id, { kind: 'Organizing', scope: { kind: 'clerk-round', ids: [id], label }, step: null, parentJobId: null, task: { kind: 'clerk-round', roundId: id, roundKind: kind } });
    const now = new Date().toISOString();
    // A Follow up round keeps its judgements in the record it opens now (§5.5): what became a point-in-time record or
    // a decision since the entries were made is settled first, and its cross-check judges into this record.
    const followUpRoundId = kind === 'Follow up' ? openFollowUpRecord(store, project.id, root.id, now).id : null;
    const round: ClerkRound = {
      id, projectId: project.id, kind, number, startedAt: now, endedAt: null, status: 'Running', rootJobId: root.id,
      questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null,
      followUpRoundId, updatedAt: now,
      ...(depth ? { depth } : {}),
      ...(kind === 'Follow up' ? { startedBy: this.followUpStartedBy(store, project) } : {}),
      // Where the Follow up news stands at the start, to tell what this round made new when it closes (§3.8, D79).
      ...(kind === 'Follow up' ? { baseline: roundBaseline(store) } : {}),
    };
    store.clerkRounds.put(round, { jobId: root.id, summary: `${label} started` });
    // The scheduled time this round was started for names the round, so the `Daily` page opens it from there.
    const handled = this.app.project(project.id).scheduleHandled;
    if (kind === 'Follow up' && handled && handled.outcome === 'round' && !handled.roundId) this.app.updateProject({ ...this.app.project(project.id), scheduleHandled: { ...handled, roundId: id } });
    return round;
  }

  /**
   * Start the first step of the round whose predecessors are done; close the round when every step is done.
   *
   * A step's job that ended without finishing does not hold the round (Spec §3.10; `stepEnding`): the program runs it
   * again, and once it has done so `RUN_AGAIN_LIMIT` times the job is listed — on the round and in the coverage, with why
   * — and the round goes on with what was saved. Only the owner's Stop holds the round, until the owner continues the job.
   */
  async advance(store: ProjectStore, project: Project, round: ClerkRound): Promise<void> {
    this.resumeRoot(store, round);
    this.settleMain(store, round);
    this.settleSynthesis(store, round);
    this.syncFailures(store, round);
    for (const step of ROUND_STEPS[round.kind]) {
      const jobs = store.jobs.filter((j) => j.step?.roundId === round.id && j.step.kind === step);
      if (jobs.length === 0) {
        if (organizingHeld(project) && step !== 'ledger') return;
        const r = await this.startStepRecorded(store, project, round, step);
        if (r === 'skipped') continue;
        return;
      }
      const endings = jobs.map((job) => ({ job, ending: stepEnding(store, job) }));
      // What ended without finishing runs again now — while organizing is held it waits, as a step's start does.
      const again = endings.filter((e) => e.ending.kind === 'again');
      if (again.length) {
        if (organizingHeld(project) && step !== 'ledger') return;
        for (const e of again) await this.runAgain(store, project, round, e.job, 'program').finished;
        return;
      }
      // Still running, or stopped by the owner: the round waits. What is listed does not hold it. The main agent's lanes
      // hold it while they run: they belong to the main agent, which runs them again itself (lane-tools.ts).
      if (endings.some((e) => e.ending.kind === 'active' || e.ending.kind === 'owner')) return;
      if (step === 'main' && store.jobs.find((j) => j.step?.roundId === round.id && j.step.kind === 'lane' && ACTIVE_STATUSES.includes(j.status)) !== undefined) return;
    }
    this.closeRound(store, project, round);
  }

  /**
   * The main job is done only once it has handed the round over to the synthesis (D103). A session that ended `Done`
   * before that did not finish its work: it is recorded as not finished, with where it stopped, so it runs again — in
   * its own session — or is listed like any job that did not finish.
   */
  private settleMain(store: ProjectStore, round: ClerkRound): void {
    const current = store.clerkRounds.get(round.id) ?? round;
    for (const job of store.jobs.filter((j) => j.step?.roundId === round.id && j.step.kind === 'main' && j.status === 'Done')) {
      if (mainFinished(store, current)) continue;
      const missing = `in the ${stageOfRound(current)} stage, before its handover to the synthesis`;
      store.jobs.put({ ...job, status: 'Failed', error: `The main agent's session ended ${missing}` }, { jobId: job.id, summary: `${job.scope.label}: its session ended ${missing}; the main agent's work is not done` });
    }
    // Its work is done at the handover. A session that failed after it — the reply that follows the handover refused by
    // the provider, or cut short by a restart — has nothing left to do: it is not run again, and the synthesis starts.
    // The owner's Stop stays the owner's.
    if (!mainFinished(store, current)) return;
    for (const job of store.jobs.filter((j) => j.step?.roundId === round.id && j.step.kind === 'main' && (j.status === 'Failed' || (j.status === 'Stopped' && RESTARTED.test(j.error ?? ''))))) {
      const why = reasonOf(job);
      store.jobs.put({ ...job, status: 'Done', error: null, resume: null, endedAt: job.endedAt ?? new Date().toISOString() }, { jobId: job.id, summary: `${job.scope.label}: its session ended after its handover (${why.slice(0, 200)}); its work was done at the handover` });
    }
  }

  /**
   * The synthesis job is done only once the round has its Result (D103: 合成才算完). A session that ended `Done` without
   * one did not finish: it is recorded as not finished, so it runs again — in its own session — or is listed.
   */
  private settleSynthesis(store: ProjectStore, round: ClerkRound): void {
    if (synthesisFinished(store, round)) return;
    for (const job of store.jobs.filter((j) => j.step?.roundId === round.id && j.step.kind === 'synthesis' && j.status === 'Done' && j.agent !== 'program')) {
      const missing = 'without writing the round\'s Result';
      store.jobs.put({ ...job, status: 'Failed', error: `The synthesis' session ended ${missing}` }, { jobId: job.id, summary: `${job.scope.label}: its session ended ${missing}; the round's synthesis is not done` });
    }
  }

  /** After a restart the round's root job reads Stopped (runtime.ts `init`); the round goes on, so its root is Running again. */
  private resumeRoot(store: ProjectStore, round: ClerkRound): void {
    const root = store.jobs.get(round.rootJobId);
    if (!root || root.status !== 'Stopped' || !RESTARTED.test(root.error ?? '')) return;
    store.jobs.put({ ...root, status: 'Running', endedAt: null, error: null }, { jobId: root.id, summary: `${root.scope.label}: goes on after ProjectKeeper restarted` });
  }

  /** The round's list of what did not finish (`ClerkRound.failures`), kept as its steps' jobs end and run again. */
  private syncFailures(store: ProjectStore, round: ClerkRound): RoundFailure[] {
    const current = store.clerkRounds.get(round.id) ?? round;
    const before = new Map((current.failures ?? []).map((f) => [f.jobId, f]));
    const now = new Date().toISOString();
    const failures = store.jobs.filter((j) => j.step?.roundId === round.id).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)).flatMap((job) => {
      const e = stepEnding(store, job);
      return e.kind === 'listed' ? [failureOf(job, e.reason, e.runs, before.get(job.id)?.at ?? now)] : [];
    });
    if (JSON.stringify(failures) === JSON.stringify(current.failures ?? [])) return failures;
    const added = failures.filter((f) => !before.has(f.jobId));
    const summary = added.length
      ? `Round ${round.number}: ${added.map((f) => `${f.label} ${endedText(f.status, f.runs)} (${f.reason.slice(0, 160)})`).join('; ')} — listed; the round goes on without ${added.length === 1 ? 'it' : 'them'}`
      : `Round ${round.number}: ${failures.length} job${failures.length === 1 ? '' : 's'} listed as not finished`;
    store.clerkRounds.put({ ...current, failures, updatedAt: now }, { jobId: round.rootJobId, summary });
    return failures;
  }

  /**
   * Run a step's job again (`stepEnding`): the same job, what it saved kept. A model's job goes back on the queue with its
   * earlier runs — when and why each ended, what it saved — at the end of its task (runtime.ts `restartJob`); a job the
   * program did itself (the ledger, the process, the program's part of a step) the program runs again here, since the
   * runtime runs only a model's jobs. `ok` says whether it runs; `finished` settles when a program's run has ended.
   */
  private runAgain(store: ProjectStore, project: Project, round: ClerkRound, job: KeeperJob, by: 'program' | 'owner'): { readonly ok: boolean; readonly finished: Promise<void> } {
    const no = { ok: false, finished: Promise.resolve() };
    if (job.status !== 'Failed' && job.status !== 'Stopped') return no;
    const ending = stepEnding(store, job);
    if (job.agent === 'program' && !this.programCanRunAgain(store, job)) return no;
    const now = new Date().toISOString();
    const run: StepRun = {
      endedAt: job.endedAt ?? now, status: job.status, reason: reasonOf(job), usage: job.agent === 'program' ? null : job.usage, again: by, at: now,
      counted: by === 'program' && ending.kind === 'again' && ending.counted,
    };
    const runs = [...runsOf(job), run];
    const task = (job.task ?? {}) as { prompt?: string; extra?: Record<string, unknown> | null };
    const extra = { ...(task.extra ?? {}), runs };
    const summary = `${job.scope.label}: run again by ${by === 'owner' ? 'the owner' : 'the program'} (run ${runs.length + 1}); its last run ${job.status === 'Stopped' ? 'was stopped' : 'failed'}: ${run.reason.slice(0, 200)}`;
    if (job.agent === 'program') {
      const running: KeeperJob = { ...job, status: 'Running', startedAt: now, endedAt: null, error: null, task: { ...task, extra } };
      store.jobs.put(running, { jobId: job.id, summary });
      return { ok: true, finished: this.runProgram(store, project, round, running) };
    }
    // The main agent goes on in its own session (D99, the BU continuation), told which stage it stopped at and why its
    // last run ended — its task, where the earlier runs are listed, is not sent again in its session; when its session
    // cannot be opened it starts afresh from its task and its earlier runs, and finds its place with pk_round_state.
    // The synthesis job and the spot-check go on in their own sessions the same way (D103), told what is left of their work.
    const kind = job.step?.kind;
    const where = kind === 'main' ? this.stoppedAt(store, round) : kind === 'synthesis' ? this.synthesisStoppedAt(store, round) : kind === 'spot-check' ? this.spotCheckStoppedAt(store, round) : null;
    const resume = where !== null && job.sessionFile
      ? { why: job.resume?.why ?? ('again' as const), since: job.resume?.since ?? job.endedAt ?? now, note: `${where}\nWhy your last run ended: ${run.reason}${run.status === 'Failed' ? ' — when that is something you did (a call the tools refused, a reply cut off at the output limit), do it differently this time.' : ''}` }
      : job.resume ?? null;
    store.jobs.put({ ...job, resume, task: { ...task, prompt: withEarlierRuns(task.prompt ?? '', job, runs), extra } }, { jobId: job.id, summary });
    return { ok: this.app.keeper.restartJob(project.id, job.id), finished: Promise.resolve() };
  }

  /** Where the main agent stopped, for the message its continued session gets (D99). */
  private stoppedAt(store: ProjectStore, round: ClerkRound): string {
    const current = store.clerkRounds.get(round.id) ?? round;
    const stage = stageOfRound(current);
    const order = ROUND_STAGES[current.kind];
    const lanes = lanesOf(store, current);
    const open = lanes.filter((l) => l.status !== 'Done');
    return [
      `You stopped in the ${stage} stage of this ${current.kind} round (its stages: ${order.join(' → ')}, then the handover to the synthesis).`,
      lanes.length ? `Your lanes: ${lanes.length} sent, ${lanes.length - open.length} done${open.length ? `; not done: ${open.map((l) => `${l.name} (${l.status})`).join(', ')} — send the same pk_send_lanes call again to wait for them or let them go on` : ''}.` : '',
      'Call pk_round_state to see where the round stands, then go on from there: your work is done once you have handed the round over to the synthesis (pk_stage to synthesis, with your handover).',
    ].filter(Boolean).join(' ');
  }

  /** What is left of the synthesis' work, for the message its continued session gets (D103). */
  private synthesisStoppedAt(store: ProjectStore, round: ClerkRound): string {
    const current = store.clerkRounds.get(round.id) ?? round;
    const standing = standingCounts(store, current);
    return [
      `You are the synthesis of this ${current.kind} round, and it has no Result yet.`,
      standing.open ? `${standing.open} of the ${standing.standing} notes standing from earlier rounds have no result yet (pk_round_state { list: "standingNotes" }).` : '',
      'Read back what you wrote (pk_read_assets kind note), do not write it again, and do what is left: the round is done once its Result is written (pk_write_round_doc kind Result).',
    ].filter(Boolean).join(' ');
  }

  /** What is left of the spot-check's work, for the message its continued session gets (D103). */
  private spotCheckStoppedAt(store: ProjectStore, round: ClerkRound): string {
    const current = store.clerkRounds.get(round.id) ?? round;
    const recorded = current.spotCheck?.sampled ?? 0;
    const written = store.roundDocs.find((d) => d.roundId === round.id && d.kind === 'Spot check') !== undefined;
    return [
      `You are the spot-check of this ${current.kind} round. ${recorded} check${recorded === 1 ? ' is' : 's are'} recorded so far${current.spotCheck?.synthesis ? ` (${current.spotCheck.synthesis.checked} of the ${current.spotCheck.synthesis.outputs} checked in full)` : ''}${current.spotCheck?.placement ? `; ${placementLine(current.spotCheck.placement)}` : ''}; a judgement counts once, whichever run records it.`,
      `Go on with what is left of your targets, and ${written ? 'update' : 'write'} the round's Spot check document (pk_write_round_doc kind Spot check).`,
    ].join(' ');
  }

  /** Whether the program can run a job it did itself again: the ledger and the process step, and the program's part of a step that can run again. */
  private programCanRunAgain(store: ProjectStore, job: KeeperJob): boolean {
    const step = job.step;
    if (!step) return false;
    if (isProgramPart(job)) return partCanRunAgain(store, job);
    if (step.kind === 'ledger') return !this.ledgerRunning.has(step.roundId);
    if (step.kind === 'process') return Boolean(this.process) && !this.processRunning.has(step.roundId);
    return false;
  }

  /** The program's own run of a job it did itself, again: the job is Running already and ends with the run. */
  private async runProgram(store: ProjectStore, project: Project, round: ClerkRound, job: KeeperJob): Promise<void> {
    if (isProgramPart(job)) await this.runPart(store, project, round, job);
    else if (job.step?.kind === 'ledger') await this.runLedger(store, project, round, job);
    else await this.runProcess(store, project, round, job);
  }

  /**
   * The owner's Retry or Continue on a job of a round's step (Spec §3.10: 失败的工作可以重试): it runs again as the program
   * would run it, and the program's count of runs again starts afresh. A job the program did itself runs here; a model's
   * job goes back on the runtime's queue. The round, if it is still under way, waits for it.
   */
  ownerRunAgain(store: ProjectStore, project: Project, job: KeeperJob): boolean {
    const round = job.step ? store.clerkRounds.get(job.step.roundId) : undefined;
    if (!round || (job.status !== 'Failed' && job.status !== 'Stopped')) return job.agent === 'program' ? false : this.app.keeper.restartJob(project.id, job.id);
    const r = this.runAgain(store, project, round, job, 'owner');
    r.finished.catch((e: unknown) => console.warn(`[organize ${project.id}] ${job.scope.label}: ${(e as Error).message}`));
    return r.ok;
  }

  /** Start a step; when the program's own part of it throws, that is a job of the step and runs again like any other. */
  private async startStepRecorded(store: ProjectStore, project: Project, round: ClerkRound, step: RoundStepKind): Promise<StepStart> {
    try {
      return await this.startStep(store, project, round, step);
    } catch (e) {
      this.recordPart(store, project, round, step, `The program could not start this step: ${(e as Error).message}`);
      return 'started';
    }
  }

  /** The program's part of a step failed: a job of the step, ended Failed with why, so it shows, runs again and is listed like any. */
  private recordPart(store: ProjectStore, project: Project, round: ClerkRound, step: RoundStepKind, error: string): void {
    const job = this.app.keeper.recordProgramJob(project.id, { kind: 'Organizing', scope: { kind: 'clerk-step', ids: [round.id], label: `${STEP_LABEL[step]}: the program's part` }, step: { roundId: round.id, kind: step, path: null }, parentJobId: round.rootJobId, task: { kind: 'clerk-step', roundId: round.id, program: 'part' } });
    this.app.keeper.endProgramJob(project.id, job.id, 'Failed', { error });
  }

  /** The program's part of a step, run again: start the step. */
  private async runPart(store: ProjectStore, project: Project, round: ClerkRound, job: KeeperJob): Promise<void> {
    const step = job.step!.kind;
    const current = store.clerkRounds.get(round.id) ?? round;
    try {
      const r = await this.startStep(store, project, current, step);
      this.app.keeper.endProgramJob(project.id, job.id, 'Done', { resultText: r === 'skipped' ? 'The step had nothing to do' : 'The step started' });
    } catch (e) {
      this.app.keeper.endProgramJob(project.id, job.id, 'Failed', { error: `The program could not start this step: ${(e as Error).message}` });
    }
  }

  private async startStep(store: ProjectStore, project: Project, round: ClerkRound, step: RoundStepKind): Promise<StepStart> {
    switch (step) {
      case 'ledger': return this.runLedger(store, project, round);
      case 'session-drafts': return this.startDrafts(store, project, round);
      case 'main': return this.startMain(store, project, round);
      case 'synthesis': return this.startSynthesis(store, project, round);
      case 'process': return this.runProcess(store, project, round);
      case 'spot-check': return this.startSpotCheck(store, project, round);
      // The main agent sends its lanes itself (pk_send_lanes); the stages before D99 are the main agent's now.
      case 'lane': throw new Error('A lane is sent by the main agent (pk_send_lanes), not by the planner');
      case 'orientation': case 'skeleton': case 'dig': case 'cross-check':
        throw new Error(`The ${step} step is now a stage of the main agent's session, not a step of its own`);
    }
  }

  /**
   * §2.12: the program recomputes each work item's process and its breakpoints, and moves the send-backs on. `again`: the
   * step's job, run again (`runAgain`), already Running.
   */
  private async runProcess(store: ProjectStore, project: Project, round: ClerkRound, again: KeeperJob | null = null): Promise<StepStart> {
    if (!this.process) return this.skip(store, project, round, 'process', 'The process engine is not available in this build; no breakpoint was computed');
    if (this.processRunning.has(round.id)) return 'wait';
    this.processRunning.add(round.id);
    const job = again ?? this.app.keeper.recordProgramJob(project.id, { kind: 'Organizing', scope: { kind: 'clerk-step', ids: [round.id], label: STEP_LABEL.process }, step: { roundId: round.id, kind: 'process', path: null }, parentJobId: round.rootJobId, task: { kind: 'clerk-step', roundId: round.id } });
    const started = Date.now();
    try {
      const result = await this.process.run(store, project, round.id);
      const ms = Date.now() - started;
      this.app.keeper.endProgramJob(project.id, job.id, 'Done', { resultText: result.note, timing: { wallMs: ms, generationMs: 0, toolMs: ms, queueMs: 0, parseRetryMs: 0, otherMs: 0 } });
    } catch (e) {
      this.app.keeper.endProgramJob(project.id, job.id, 'Failed', { error: (e as Error).message });
    } finally {
      this.processRunning.delete(round.id);
    }
    return 'started';
  }

  /**
   * Step 0 (§1.16, CKC-22 AC-16): the ledger is brought up to date by the program, before any judging. `again`: the step's
   * job, run again (`runAgain`), already Running.
   */
  private async runLedger(store: ProjectStore, project: Project, round: ClerkRound, again: KeeperJob | null = null): Promise<StepStart> {
    if (this.ledgerRunning.has(round.id)) return 'wait';
    this.ledgerRunning.add(round.id);
    const job = again ?? this.app.keeper.recordProgramJob(project.id, { kind: 'Organizing', scope: { kind: 'clerk-step', ids: [round.id], label: `${STEP_LABEL.ledger}: bring it up to date` }, step: { roundId: round.id, kind: 'ledger', path: null }, parentJobId: round.rootJobId, task: { kind: 'clerk-step', roundId: round.id } });
    const started = Date.now();
    try {
      const result = this.ledger ? await this.ledger.run(project, { keeperNumbers: store.numbers.all() }) : { commitsAdded: 0, note: 'The ledger is not available in this build; the steps judge from the sources and git directly.' };
      const ms = Date.now() - started;
      store.clerkRounds.put({ ...(store.clerkRounds.get(round.id) ?? round), ledger: { ms, commitsAdded: result.commitsAdded }, updatedAt: new Date().toISOString() });
      this.app.keeper.endProgramJob(project.id, job.id, 'Done', { resultText: result.note ?? `${result.commitsAdded} commits added in ${Math.round(ms / 1000)} s`, timing: { wallMs: ms, generationMs: 0, toolMs: ms, queueMs: 0, parseRetryMs: 0, otherMs: 0 } });
    } catch (e) {
      this.app.keeper.endProgramJob(project.id, job.id, 'Failed', { error: (e as Error).message });
    } finally {
      this.ledgerRunning.delete(round.id);
    }
    // The pull continues with the next step at once.
    setImmediate(() => void this.app.organizing.replan(project.id));
    return 'started';
  }

  /** §3.11, D88: one draft per session that has the owner's words and no draft yet (or new words since). */
  private startDrafts(store: ProjectStore, project: Project, round: ClerkRound): StepStart {
    const set = ownerUtterances(store);
    if (typeof set === 'string') return this.skip(store, project, round, 'session-drafts', set);
    const drafted = new Map(store.drafts.all().map((d) => [d.session.file || d.session.sessionId, d.at]));
    const bySession = new Map<string, { chars: number; last: string }>();
    for (const u of set.utterances) {
      if (u.headless) continue;   // a scripted run's prompts are a program's or an agent's words, not the owner's
      const cur = bySession.get(u.session) ?? { chars: 0, last: '' };
      bySession.set(u.session, { chars: cur.chars + u.chars, last: (u.at ?? '') > cur.last ? u.at ?? '' : cur.last });
    }
    const todo = [...bySession].filter(([session, s]) => {
      const file = session.slice(session.indexOf(':') + 1);
      const at = drafted.get(file) ?? drafted.get(session);
      return at === undefined || s.last > at;
    });
    if (todo.length === 0) return this.skip(store, project, round, 'session-drafts', 'No session has owner’s words without a draft');
    const batches: { sessions: string[]; chars: number }[] = [];
    for (const [session, s] of todo.sort((a, b) => a[1].last.localeCompare(b[1].last))) {
      const cur = batches[batches.length - 1];
      if (!cur || cur.chars + s.chars > DRAFT_CHARS_PER_JOB || cur.sessions.length >= DRAFT_SESSIONS_PER_JOB) batches.push({ sessions: [session], chars: s.chars });
      else { cur.sessions.push(session); cur.chars += s.chars; }
    }
    batches.forEach((b, i) => {
      const block = `=== Sessions for this job (${b.sessions.length}; about ${b.chars} characters of the owner's words)\n${b.sessions.map((s) => `- ${s}`).join('\n')}`;
      this.enqueueStep(store, project, round, 'session-drafts', `batch ${i + 1} of ${batches.length}`, [block]);
    });
    return 'started';
  }

  /**
   * The main agent (D99): one job, one pi session through the round's stages, from its first stage's skill. It is given
   * the round and the organizing plan, the project's positioning and rules, the lists the program computes for its start
   * (`methodBlocksOf('main')`), and what did not finish earlier in the round. Its work ends with its handover to the
   * synthesis (D103), which has the round's judgement record.
   */
  private startMain(store: ProjectStore, project: Project, round: ClerkRound): StepStart {
    const now = new Date().toISOString();
    const order = ROUND_STAGES[round.kind];
    const first = order[0]!;
    const current = store.clerkRounds.get(round.id) ?? round;
    store.clerkRounds.put({ ...current, stage: first, stageLog: [{ stage: first, startedAt: now, endedAt: null, timing: null }], lanes: current.lanes ?? [], updatedAt: now }, { jobId: round.rootJobId, summary: `Round ${round.number}: the main agent starts in ${first}` });
    const chain = round.kind === 'Follow up'
      ? [`=== The document chain\n${this.documentChainChanged(store, round) ? 'A document of the chain has a new version since the last round: build the skeleton for it.' : `No document of the chain changed since the last round: you may skip ${skippableStages('Follow up').filter((s) => s === 'skeleton' || s === 'reconcile').join(' and ')} (pk_stage with why).`}`]
      : [];
    const failures = (store.clerkRounds.get(round.id) ?? round).failures ?? [];
    const prompt = [
      `Task: the main agent of this round — one session through its stages: ${order.join(' → ')}. You start in ${first}. Move to the next stage with pk_stage when a stage is done: it returns that stage's skill. Send the lanes of a stage all in one pk_send_lanes call. Call pk_round_state whenever you need to find your place. Your work is done once you have handed the round over to the synthesis: when your last stage (${lastStageOf(round.kind)}) is done, call pk_stage({ to: "${HANDOVER_TO}", handover: { settled, open, first } }). The synthesis — the notes, the six things, the round's Result — runs after you in a session of its own and reads the lane reports and your handover; you write none of it.`,
      stageSkill(first),
      roundBlockOf(store, project, round),
      ...chain,
      positioningBlock(store, project),
      ...this.methodBlocks(store, project, round, 'main'),
      // CM (E151): the candidate generations, for orientation to accept or reject (generation-check.ts).
      ...this.candidatesBlock(store, project),
      `=== The project's rules in force\n${rulesBlockOf(store) || 'None recorded yet.'}`,
      ...(failures.length ? [failuresBlock(failures)] : []),
    ].join('\n\n');
    this.app.keeper.enqueue(project.id, {
      kind: 'Organizing', initiator: 'auto', priority: 1, timeoutMs: MAIN_TIMEOUT_MS,
      scope: { kind: 'clerk-step', ids: [round.id], label: STEP_LABEL.main },
      prompt, parentJobId: round.rootJobId, step: { roundId: round.id, kind: 'main', path: null },
      judgementId: null, task: { kind: 'clerk-step', roundId: round.id, route: 'main' },
    });
    return 'started';
  }

  /** The candidate generations the program lists for orientation (generation-check.ts); nothing when it cannot. */
  private candidatesBlock(store: ProjectStore, project: Project): string[] {
    try { return [generationCandidatesBlock(store, this.app.ledger.ledger(project.id))]; } catch { return []; }
  }

  /**
   * What the synthesis is given, as it stands when it starts (§3.4; CKC-23 AC-8 `Based on`): the product reference and
   * the assets, the notes current from earlier, and the round's documents it reads — the lanes' reports, the adoption
   * record and the main agent's handover.
   */
  private synthesisInputs(store: ProjectStore, round: ClerkRound): JudgementRecord['inputs'] {
    return {
      referenceIds: store.reference.filter((r) => r.validity === 'Current').map((r) => r.id),
      threadIds: store.threads.filter((t) => t.validity === 'Current').map((t) => t.id),
      areaIds: store.reference.filter((r) => r.category === 'Area' && r.validity === 'Current').map((r) => r.id),
      relationIds: [], keyEvidenceSourceIds: [], conflictingSourceIds: [],
      previousNoteIds: store.notes.filter((n) => n.status === 'Current').map((n) => n.id),
      investigations: [],
      roundDocIds: store.roundDocs.filter((d) => d.roundId === round.id && ['Report', 'Adoption', 'Handover'].includes(d.kind)).sort((a, b) => a.at.localeCompare(b.at)).map((d) => d.id),
    };
  }

  /**
   * The main agent entered a stage (`pk_stage`, D99): the breakpoint candidates are recomputed where the stage needs them
   * (`recomputesCandidates`), and the stage is given what the program computes for it — the cross-check the lanes'
   * reports, the code anomaly candidates and the claims to check. Handing over to the synthesis (D103) recomputes the
   * candidates and gives the main agent nothing more: the whole picture, the process and the claims go to the synthesis
   * job, in its prompt (`startSynthesis`).
   */
  async stageEntered(projectId: string, roundId: string, stage: ClerkStage): Promise<{ readonly note: string | null }> {
    const store = this.app.store(projectId);
    const project = this.app.project(projectId);
    const round = store.clerkRounds.get(roundId);
    if (!round) return { note: null };
    const notes: string[] = [];
    if (recomputesCandidates(round.kind, stage)) {
      const ledger = this.app.ledger.ledger(project.id);
      if (!ledger) notes.push('=== Breakpoint candidates\nThe ledger is not available, so the candidates were not recomputed.');
      else {
        try {
          // Recorded as the main job's: what the candidates are as it enters the stage (W6).
          const mainJob = store.jobs.filter((j) => j.step?.roundId === round.id && j.step.kind === 'main').sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0];
          computeBreakpoints(store, project, ledger, round.id, mainJob?.id ?? null);
          const open = store.breakpoints.filter((b) => !b.out);
          notes.push(`=== Breakpoint candidates\nRecomputed as you ${stage === HANDOVER_TO ? 'handed over to the synthesis' : `entered ${stage}`}: ${open.filter((b) => !b.lit).length} candidates, ${open.filter((b) => b.looked).length} looked for, ${open.filter((b) => b.lit).length} lit.`);
        } catch (e) {
          notes.push(`=== Breakpoint candidates\nThe program could not recompute them (${(e as Error).message}); judge from the ledger.`);
        }
      }
    }
    try {
      const blocks = (as: RoundStepKind) => this.methodBlocks(store, project, round, as, stageBlocksOf(stage, round.kind));
      if (stage === 'reconcile') {
        notes.push(...blocks('skeleton'));
      } else if (stage === 'cross-check') {
        notes.push(this.reportsBlock(store, round), this.codeCandidatesBlock(store, project), ...blocks('cross-check'));
      }
    } catch (e) {
      notes.push(`=== The program's lists for ${stage}\nThe program could not compute them (${(e as Error).message}).`);
    }
    return { note: notes.length ? notes.join('\n\n') : null };
  }

  /**
   * The synthesis (D103; Spec §3.3 合成另开会话, §3.4): the round's product look-back, one job in a fresh pi session after the
   * main agent's handover. It was not there for the round, so its prompt is its skill and what it reads from — given by
   * reference and as counts (CM's rules: a list comes on request, nothing is pasted whole):
   * - the round, the organizing plan and the project;
   * - the main agent's handover, in full (it is short and written for this reader), or that there is none;
   * - the round's documents by id and size: the question list, each lane's brief and report, the adoption record;
   * - the lanes' Unsure items and the claims of "not handled" with what came after (`methodBlocksOf('synthesis')`);
   * - what is still open, counted, and what stays unplaced;
   * - the process: the breakpoints lit, the candidates counted, the send-backs open — what the six things are judged from;
   * - what the round wrote on the workbench, by position, and in a Follow up what it made new;
   * - in a deepening and a Follow up, the notes still current from earlier rounds, each to get a result (standing-notes.ts);
   * - the top of the picture by name, the rest as counts.
   * Its judgement record is opened now with these as its inputs (`Based on`, CKC-23 AC-8). A round whose main agent did
   * not hand over (it was listed as not finished) still gets its synthesis, told so. It is done once the round has its
   * Result (`settleSynthesis`).
   */
  private startSynthesis(store: ProjectStore, project: Project, round: ClerkRound): StepStart {
    const current = store.clerkRounds.get(round.id) ?? round;
    // A round recorded before D103 whose main agent wrote the Result in its own synthesis stage has nothing left to synthesize.
    if (!current.handover && current.stage === 'synthesis' && synthesisFinished(store, current)) {
      return this.skip(store, project, round, 'synthesis', 'The main agent wrote this round’s Result in its own session, before the synthesis had a session of its own');
    }
    // The main agent's handover recomputed the candidates; a round with no handover gets them recomputed here.
    if (!current.handover) {
      try {
        const ledger = this.app.ledger.ledger(project.id);
        if (ledger) computeBreakpoints(store, project, ledger, round.id, store.jobs.filter((j) => j.step?.roundId === round.id && j.step.kind === 'main').sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0]?.id ?? null);
      } catch (e) { console.warn(`[organize ${project.id}] the candidates were not recomputed before the synthesis: ${(e as Error).message}`); }
    }
    const now = new Date().toISOString();
    const judgement: JudgementRecord = {
      id: newId('jdg'), projectId: project.id, jobId: '', at: now,
      scope: { kind: 'project', ids: [], label: `Synthesis of ${round.kind === 'Follow up' ? 'Follow up' : 'takeover'} round ${round.number}` },
      inputs: this.synthesisInputs(store, current),
      excluded: [
        'The sessions of the project’s own implementation and QC work: the synthesis gets what the round wrote on the workbench and in its lanes’ reports',
        'The main agent’s and the lanes’ own sessions: the synthesis runs in a session of its own and reads what they wrote down — the reports, the adoption record, the handover',
      ],
      outcome: { noteIds: [], assessments: [], reconsideredOnly: false },
    };
    store.judgements.put(judgement, { jobId: null, summary: `Synthesis inputs recorded: round ${round.number}` });
    const failures = current.failures ?? [];
    const prompt = this.synthesisPrompt(store, project, current, failures);
    const job = this.app.keeper.enqueue(project.id, {
      kind: 'Organizing', initiator: 'auto', priority: 1, timeoutMs: STEP_TIMEOUT_MS,
      scope: { kind: 'clerk-step', ids: [round.id], label: STEP_LABEL.synthesis },
      prompt, parentJobId: round.rootJobId, step: { roundId: round.id, kind: 'synthesis', path: null },
      judgementId: judgement.id, task: { kind: 'clerk-step', roundId: round.id, route: 'synthesis' },
    });
    store.judgements.put({ ...judgement, jobId: job.id });
    return 'started';
  }

  /** The synthesis job's task as it stands now (`startSynthesis`); also what a replay of a recorded round builds. */
  synthesisPrompt(store: ProjectStore, project: Project, round: ClerkRound, failures: readonly RoundFailure[] = round.failures ?? []): string {
    const standing = standingNotesBlock(store, round);
    return [
      `Task: the synthesis of this round — its product look-back, in a session of your own. You were not there for the round: the main agent and its lanes did their work in their sessions and wrote it down. Read first — the main agent's handover below, then every lane report in full — and only then write: the notes, the six things, the send-backs, area understanding${standing ? ', a result for each note still current from earlier rounds' : ''}, and the round's Result (pk_write_round_doc kind Result). The round is done once its Result is written.`,
      synthesisSkill(),
      roundBlockOf(store, project, round),
      `=== The project\n${positioningBlock(store, project)}`,
      this.handoverBlock(store, round),
      this.roundDocsBlock(store, round),
      ...this.methodBlocks(store, project, round, 'synthesis'),
      this.openBlock(store, round),
      processBlock(store, { candidates: 'count', answered: candidatesAnswered(store, round.id).length }),
      this.writtenBlock(store, round),
      ...(round.kind === 'Follow up' ? [this.newsBlock(store, round)] : []),
      ...(standing ? [standing] : []),
      this.compositionBlock(store, round, { documents: false }),
      `=== The project's rules in force\n${rulesBlockOf(store) || 'None recorded yet.'}`,
      ...(failures.length ? [failuresBlock(failures)] : []),
    ].join('\n\n');
  }

  /** The main agent's handover for the synthesis, in full; or that it did not hand over, and where it stopped. */
  private handoverBlock(store: ProjectStore, round: ClerkRound): string {
    const doc = handoverDoc(store, round);
    if (doc && round.handover) return `=== The main agent's handover (${doc.id}; written as it left the ${stageOfRound(round)} stage)\n${doc.markdown}`;
    return `=== The main agent's handover\nThere is none: the main agent's session ended in the ${stageOfRound(round)} stage without handing over. What it and its lanes wrote is on the workbench and in the round's documents; what it did not do is missing. Read the reports${store.roundDocs.find((d) => d.roundId === round.id && d.kind === 'Adoption') ? ' and the adoption record' : ''}, judge from what is there, and say in the Result that the round had no handover and what that leaves unchecked.`;
  }

  /**
   * The round's documents for the synthesis, by id and size (read in full with pk_read_assets kind roundDoc): the question
   * list and the history map, each lane with its brief and its report, the adoption record. Nothing of them is pasted.
   */
  private roundDocsBlock(store: ProjectStore, round: ClerkRound): string {
    const docs = store.roundDocs.filter((d) => d.roundId === round.id);
    const ref = (d: RoundDoc | undefined) => (d ? `${d.id} (${d.markdown.length} characters)` : 'none');
    const one = (kind: string) => docs.filter((d) => d.kind === kind).sort((a, b) => b.at.localeCompare(a.at))[0];
    const lanes = lanesOf(store, round);
    const reports = docs.filter((d) => d.kind === 'Report');
    const out = [`=== This round's documents (read each in full with pk_read_assets kind roundDoc, by its id)`];
    out.push(`The round's questions: ${ref(one('Questions'))}`);
    if (one('History map')) out.push(`History map: ${ref(one('History map'))}`);
    out.push(`Adoption record (what the cross-check adopted, what not, and why): ${ref(one('Adoption'))}`);
    out.push(`Lanes (${lanes.length})${lanes.length ? ' — read every report before you write:' : ': none ran in this round.'}`);
    for (const l of lanes) {
      const report = reports.find((d) => d.id === l.reportDocId) ?? reports.find((d) => d.path === l.name);
      out.push(`- ${l.name} (${l.kind}; ${l.slots.join(', ') || 'no slots'}; sent in ${l.stage}) · ${l.status} · brief ${ref(store.roundDocs.get(l.briefDocId))} · report ${ref(report)}`);
    }
    const rest = reports.filter((d) => !lanes.some((l) => l.reportDocId === d.id || l.name === d.path));
    if (rest.length) out.push('Other reports of this round:', ...rest.map((d) => `- ${d.path ?? d.title} · ${ref(d)}`));
    return out.join('\n');
  }

  /** What is still open as the synthesis starts, counted by list (one list in full on request), and what stays unplaced. */
  private openBlock(store: ProjectStore, round: ClerkRound): string {
    const head = '=== What is still open (the program\'s counts as you start; pk_round_state({}) counts them again, pk_round_state({ list: "<key>" }) gives one list in full)';
    try {
      const open = roundOpen(store, round, { limit: Infinity, suggest: false });
      const counts = Object.entries(openCounts(open)).filter(([, n]) => n > 0);
      const lines = counts.map(([k, n]) => `- ${k}: ${n} — ${OPEN_KEYS[k]!.what.split(/[;:(]/)[0]!.trim()}`);
      const unplaced = unplacedNote(open);
      return [head, ...(lines.length ? lines : ['Nothing is open.']), ...(unplaced ? [unplaced.replace(/^=== Unplaced on the workbench\n/, 'Unplaced on the workbench: ')] : [])].join('\n');
    } catch (e) {
      return `${head}\nThe program could not count them (${(e as Error).message}); pk_round_state({}) counts them.`;
    }
  }

  /**
   * What this round's jobs wrote on the workbench so far, counted by position (the program's count from their writes):
   * what changed this round, for the Result's "what is new" and for where to look. The records themselves are read with
   * pk_read_assets.
   */
  private writtenBlock(store: ProjectStore, round: ClerkRound): string {
    const written = new Map<string, Set<string>>();
    for (const job of store.jobs.filter((j) => j.step?.roundId === round.id)) for (const e of store.traceByJob(job.id, 100_000)) {
      if (e.op !== 'put') continue;
      if (!written.has(e.collection)) written.set(e.collection, new Set());
      written.get(e.collection)!.add(e.id);
    }
    const rows = [...written].flatMap(([collection, ids]) => { const where = POSITION_OF[collection]; return where?.kind === 'position' ? [{ label: where.label, collection, n: ids.size }] : []; }).sort((a, b) => b.n - a.n);
    const head = '=== What this round wrote on the workbench so far (the program\'s count of its jobs\' writes, by position; read the records with pk_read_assets)';
    return [head, ...(rows.length ? rows.map((r) => `- ${r.label}: ${r.n} (${r.collection})`) : ['Nothing yet.'])].join('\n');
  }

  /**
   * §3.3 抽查 (D99, D103; CKC-23 AC-9, AC-22): the round's independent spot-check, in a session of its own after the
   * synthesis — the round's final re-check. It checks every breakpoint candidate a lane looked for and did not find — only
   * it lights one (breakpoint-candidates.ts) — every "missing" conclusion the round wrote (the claims block), in full
   * what the synthesis wrote and every note current at the end of the round (`fullCheckTargets`), and a sample of the
   * rest of the round's judgements, weighted to what goes wrong most (`spotCheckTargets`). It runs whenever there is a
   * looked candidate or a judgement to check; a round that wrote nothing and looked at nothing has nothing to check. Its
   * prompt is its skill, then the round, the project, the targets, the claims and the rules.
   */
  private startSpotCheck(store: ProjectStore, project: Project, round: ClerkRound): StepStart {
    // CM (E151): the candidates as they stand after everything the main agent wrote — recomputed before the spot-check
    // reads them, so a link confirmed late in the cross-check has put its candidate out (CK fix 9).
    let ledgerForTargets: Parameters<typeof spotCheckTargets>[3] = null;
    try {
      const ledger = this.app.ledger.ledger(project.id);
      ledgerForTargets = ledger ?? null;
      if (ledger) computeBreakpoints(store, project, ledger, round.id, store.jobs.filter((j) => j.step?.roundId === round.id && j.step.kind === 'main').sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0]?.id ?? null);
    } catch (e) { console.warn(`[organize ${project.id}] the candidates were not recomputed before the spot-check: ${(e as Error).message}`); }
    // CS: a program placement of any round that a write took off its item has its result before the sample is drawn.
    try { settleProgramPlacements(store, { jobId: round.rootJobId, roundId: round.id }); } catch (e) { console.warn(`[organize ${project.id}] the program placements were not settled before the spot-check: ${(e as Error).message}`); }
    // CQ (D104): the ledger lets the targets name the records the program's trace followed for each reason that left an item unplaced.
    const targets = spotCheckTargets(store, round, SPOT_CHECK_SAMPLE, ledgerForTargets);
    if (targets.candidates.length === 0 && targets.sample.length === 0 && targets.full.length === 0) return this.skip(store, project, round, 'spot-check', 'This round wrote no judgement to check, no note is current, no reason for leaving an item unplaced stands unchecked, and no lane looked for a breakpoint candidate');
    // CS: what this spot-check is given of the placement readings is fixed on the round as it starts — the reasons checked
    // in full, the program placements in its sample — so its own corrections take nothing away from what it is counted
    // against (pk_record_spot_check). A spot-check started again keeps what the first start fixed.
    const asStarted = store.clerkRounds.get(round.id) ?? round;
    if (!asStarted.placementCheck && (targets.reasons.length || targets.placements.length)) {
      const at = new Date().toISOString();
      store.clerkRounds.put({ ...asStarted, placementCheck: { at, reasons: targets.reasons, placements: targets.placements }, updatedAt: at }, { jobId: round.rootJobId, basisSourceIds: [], summary: `Round ${round.number}: the spot-check is given ${targets.reasons.length} reason${targets.reasons.length === 1 ? '' : 's'} for leaving an item unplaced, and ${targets.placements.length} of the program's ${targets.placementsUnreviewed} unreviewed placement${targets.placementsUnreviewed === 1 ? '' : 's'}` });
    }
    const failures = (store.clerkRounds.get(round.id) ?? round).failures ?? [];
    const prompt = [
      `Task: the independent spot-check of this round, its final re-check — every breakpoint candidate a lane looked for and did not find (${targets.candidates.length}); every "missing" conclusion the round wrote; in full, what the synthesis wrote and every note current now, with the claims of the round's Result, and every reason that leaves an item unplaced and that no spot-check has checked yet, whichever round wrote it (${targets.full.length} in all, ${targets.reasons.length} of them such reasons); and a sample of ${targets.sample.length} of the ${targets.written} other judgements — what the round wrote, and the program's placements nobody has reviewed yet (${targets.placements.length} of ${targets.placementsUnreviewed} in the sample). Record every check (pk_record_spot_check) and write the round's Spot check document (pk_write_round_doc kind Spot check).`,
      spotCheckSkill(),
      roundBlockOf(store, project, round),
      `=== The project\n${positioningBlock(store, project)}`,
      spotCheckBlock(store, targets),
      absenceLookedBlock(store, round),
      // DA: the owner's lines this round judged to need nothing — a sample for the spot-check.
      ...[judgedLinesBlock(store, round, ledgerForTargets)].filter((b): b is string => b !== null),
      // DB: the slots the skeleton left to no lane, with the main agent's reasons, while they still hold nothing.
      ...[emptySlotsBlock(store, round)].filter((b): b is string => b !== null),
      ...this.methodBlocks(store, project, round, 'spot-check'),
      `=== The project's rules in force\n${rulesBlockOf(store) || 'None recorded yet.'}`,
      ...(failures.length ? [failuresBlock(failures)] : []),
    ].join('\n\n');
    this.app.keeper.enqueue(project.id, {
      kind: 'Organizing', initiator: 'auto', priority: 1, timeoutMs: STEP_TIMEOUT_MS,
      scope: { kind: 'clerk-step', ids: [round.id], label: STEP_LABEL['spot-check'] },
      prompt, parentJobId: round.rootJobId, step: { roundId: round.id, kind: 'spot-check', path: null },
      judgementId: null, task: { kind: 'clerk-step', roundId: round.id, route: 'spot-check' },
    });
    return 'started';
  }

  // ───────────────────────── what the program lists for a step to judge (methodBlocksOf) ─────────────────────────

  /**
   * The step's program-computed lists (methodBlocksOf), each computed now, when the step starts, so it holds what the
   * earlier steps of the round wrote. A Follow up lists what came since the last round in full, and the older rest in one
   * line each. The ledger's facts are read once for the lists that need them; a list that cannot be computed says so and
   * does not stop the step.
   */
  private methodBlocks(store: ProjectStore, project: Project, round: ClerkRound, step: RoundStepKind, kinds: readonly MethodBlock[] = methodBlocksOf(step, round.kind)): string[] {
    if (!kinds.length) return [];
    const ledger = this.app.ledger.ledger(project.id);
    const previous = store.clerkRounds.filter((r) => r.id !== round.id && r.status === 'Done').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const since = round.kind === 'Follow up' ? previous?.startedAt ?? null : null;
    let shared: { facts: Facts; index: UnitIndex } | null = null;
    const analysis = () => {
      if (!shared && ledger) { const facts = new Facts(ledger); shared = { facts, index: buildUnits(store, facts) }; }
      return shared;
    };
    return kinds.map((kind) => {
      try {
        switch (kind) {
          // CM (E151): the main agent gets a count and the lines naming generations; the full list goes to the Owner's words lane.
          case 'owner-lines': return ownerLinesCountBlock(store, ledger, { naming: step === 'main' });
          case 'claims': { const c = this.claimTexts(store, round, step); return claimCheckBlock(store, ledger, c.texts, { what: c.what, analysis }); }
          case 'unnumbered': return unnumberedWorkBlock(store, project, ledger, { since, analysis });
          case 'unsure': return unsureBlock(store, round, { forStep: step === 'spot-check' ? 'spot-check' : 'synthesis' });
        }
      } catch (e) {
        return `=== ${kind}: the program could not compute this list (${(e as Error).message}); check what it would have given against the ledger yourself.`;
      }
    });
  }

  /**
   * Where the "let pass" and "dropped" candidates are for a stage or step: the cross-check adopts from the lanes' reports; the
   * synthesis writes from the reports, the adoption record and the program's own breakpoints of those kinds; the
   * spot-check checks what this round wrote — its notes, send-backs and documents.
   */
  private claimTexts(store: ProjectStore, round: ClerkRound, step: RoundStepKind): { texts: ClaimText[]; what: string } {
    const docText = (d: RoundDoc): ClaimText => ({ from: `${d.id} (${d.kind}${d.path ? ` · ${d.path}` : ''})`, text: d.markdown });
    const docs = (kinds: readonly string[]) => store.roundDocs.filter((d) => d.roundId === round.id && kinds.includes(d.kind)).sort((a, b) => a.at.localeCompare(b.at)).map(docText);
    if (step === 'cross-check') return { texts: docs(['Report']), what: "this round's lane reports" };
    if (step === 'synthesis') return { texts: [...docs(['Report', 'Adoption']), ...breakpointClaims(store)], what: "this round's lane reports and adoption record, and the program's lit breakpoints of let pass and dropped along the way" };
    // The spot-check: what this round's steps wrote.
    const jobIds = store.jobs.filter((j) => j.step?.roundId === round.id && j.step.kind !== 'spot-check').map((j) => j.id);
    const written = new Map<string, Set<string>>();
    for (const jobId of jobIds) for (const e of store.traceByJob(jobId, 5_000)) {
      if (e.op !== 'put' || (e.collection !== 'notes' && e.collection !== 'sendbacks')) continue;
      written.set(e.collection, new Set([...(written.get(e.collection) ?? []), e.id]));
    }
    const notes = [...(written.get('notes') ?? [])].flatMap((id) => {
      const n = store.notes.get(id);
      const v = n?.versions[n.versions.length - 1];
      return v ? [{ from: `${id} (note “${v.title}”)`, text: [v.title, v.preview, v.body.currentView ?? '', ...v.body.facts.map((f) => f.text), v.body.keepAdjust ?? '', v.body.whatWouldSettleIt ?? ''].filter(Boolean).join('\n') }] : [];
    });
    const sendbacks = [...(written.get('sendbacks') ?? [])].flatMap((id) => {
      const s = store.sendbacks.get(id);
      return s ? [{ from: `${id} (send-back to ${s.to})`, text: `${s.what}\n${s.suggestion}` }] : [];
    });
    return { texts: [...notes, ...sendbacks, ...docs(['Adoption', 'Result'])], what: "what this round wrote: its notes, send-backs, adoption record and result" };
  }

  /** A step whose prompt the program writes itself: the session drafts (clerk-prompts.ts). */
  private enqueueStep(store: ProjectStore, project: Project, round: ClerkRound, step: RoundStepKind, detail: string | null, blocks: readonly string[]): KeeperJob {
    // The round goes on without what did not finish (Spec §3.10): a step that starts after it is told what is missing.
    const failures = (store.clerkRounds.get(round.id) ?? round).failures ?? [];
    const prompt = clerkStepPrompt({ step, round: round.kind, positioning: positioningBlock(store, project), rules: rulesBlockOf(store), blocks: failures.length ? [...blocks, failuresBlock(failures)] : blocks });
    return this.app.keeper.enqueue(project.id, {
      kind: 'Organizing', initiator: 'auto', priority: 1, timeoutMs: STEP_TIMEOUT_MS,
      scope: { kind: 'clerk-step', ids: [round.id], label: `${STEP_LABEL[step]}${detail ? `: ${detail}` : ''}` },
      prompt, parentJobId: round.rootJobId, step: { roundId: round.id, kind: step, path: null },
      judgementId: null, task: { kind: 'clerk-step', roundId: round.id, route: step },
    });
  }

  private skip(store: ProjectStore, project: Project, round: ClerkRound, step: RoundStepKind, why: string): StepStart {
    const job = this.app.keeper.recordProgramJob(project.id, { kind: 'Organizing', scope: { kind: 'clerk-step', ids: [round.id], label: `${STEP_LABEL[step]}: nothing to do` }, step: { roundId: round.id, kind: step, path: null }, parentJobId: round.rootJobId, task: { kind: 'clerk-step', roundId: round.id } });
    this.app.keeper.endProgramJob(project.id, job.id, 'Done', { resultText: why, timing: { wallMs: 0, generationMs: 0, toolMs: 0, queueMs: 0, parseRetryMs: 0, otherMs: 0 } });
    return 'skipped';
  }

  // ───────────────────────── what the main agent is given as it enters a stage ─────────────────────────

  /**
   * The lanes' reports for the cross-check (§3.3; D99): each lane with its kind, its slots, how it ended and its Report.
   * The cross-check judges across the lanes from these; it never has to read their material again, though it can open
   * any original to check a claim.
   */
  private reportsBlock(store: ProjectStore, round: ClerkRound): string {
    const reports = store.roundDocs.filter((d) => d.roundId === round.id && d.kind === 'Report');
    const lanes = lanesOf(store, store.clerkRounds.get(round.id) ?? round);
    if (reports.length === 0 && lanes.length === 0) return '=== The lanes\' reports\nNo lane ran in this round.';
    const line = (d: RoundDoc) => `${d.id} · ${d.markdown.length} characters`;
    const out = ['=== The lanes\' reports (read each in full with pk_read_assets kind roundDoc)'];
    for (const l of lanes) {
      const doc = reports.find((d) => d.path === l.name);
      out.push(`- ${l.name} (${l.kind}; ${l.slots.join(', ') || 'no slots'}) · ${l.status} · ${doc ? line(doc) : 'no report'}`);
    }
    const rest = reports.filter((d) => !lanes.some((l) => l.name === d.path));
    if (rest.length) out.push('Other reports of this round:', ...rest.map((d) => `- ${d.path ?? d.title} · ${line(d)}`));
    return out.join('\n');
  }

  /**
   * The program's code anomaly candidates (§2.13 row 6; CKC-25 AC-4, AC-5), counted by kind and by territory, for the
   * cross-check to judge before it writes a territory's anomalies: the program lists, the model decides. A file nothing
   * imports can still be used through registration, routing, reflection or a manual entry point. CM (E151; CK fix 10): the
   * list itself — 53K characters on the gated run, waved off in one sentence — is fetched when it is acted on
   * (`pk_round_state { list: "codeAnomalies" }`), not pasted into the stage's notes.
   */
  private codeCandidatesBlock(store: ProjectStore, project: Project): string {
    const head = '=== Code anomaly candidates (the program\'s count from the ledger; pk_round_state { list: "codeAnomalies" } lists them, to judge each before writing it as an anomaly with pk_write_territory)';
    const ledger = this.app.ledger.ledger(project.id);
    if (!ledger) return `${head}\nThe ledger is not available, so no candidate was listed.`;
    const all = codeAnomalyCandidates(ledger, store, project);
    if (!all.length) return `${head}\nNone: every current source file is referenced, no referenced file has a residual-looking name, and every integrated commit is claimed by a work item.`;
    const byKind = new Map<string, CodeAnomalyCandidate[]>();
    for (const c of all) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c]);
    const where = (cs: readonly CodeAnomalyCandidate[]) => {
      const n = new Map<string, number>();
      for (const c of cs) { const t = c.territoryId ?? c.path?.split('/').slice(0, 2).join('/') ?? 'elsewhere'; n.set(t, (n.get(t) ?? 0) + 1); }
      const top = [...n].sort((x, y) => y[1] - x[1]);
      return `${top.slice(0, 6).map(([t, k]) => `${t} ${k}`).join(', ')}${top.length > 6 ? `, and ${top.length - 6} more places` : ''}`;
    };
    return [head, `${all.length} candidates: ${[...byKind].map(([kind, cs]) => `${kind} ${cs.length} (${where(cs)})`).join('; ')}.`].join('\n');
  }

  /** The synthesis' context (§3.4): the product reference from the owner's words down and what this round wrote, as ids to read. */
  private compositionBlock(store: ProjectStore, round: ClerkRound, opts: { readonly documents?: boolean } = {}): string {
    const cur = <T extends { validity?: string }>(xs: readonly T[]) => xs.filter((x) => x.validity === undefined || x.validity === 'Current');
    const ref = (cat: string) => cur(store.reference.filter((r) => r.category === cat)).map((r) => `${r.id} ${r.name}`);
    const docs = store.roundDocs.filter((d) => d.roundId === round.id).map((d) => `${d.id} · ${d.kind}${d.path ? ` · ${d.path}` : ''}`);
    // Every row, not the first so many: the synthesis is the product re-look and reads the whole picture (§3.4). The
    // breakpoints and send-backs come in the process engine's own block, with their evidence.
    const section = (title: string, rows: readonly string[]) => `${title} (${rows.length})${rows.length ? `\n${rows.map((r) => `- ${r}`).join('\n')}` : ''}`;
    // CM (E151): the top of the picture by name — the Product, the Goals, the Areas, the Plans, this round's documents —
    // and the long lists as counts with where to list them (pk_read_assets gives compact rows): the synthesis reads what
    // it weighs, and a list of every work item and owner's line pasted here was read by nobody.
    const threads = cur(store.threads.all());
    const byProgress = new Map<string, number>();
    for (const t of threads) byProgress.set(t.progress, (byProgress.get(t.progress) ?? 0) + 1);
    const count = (title: string, n: number, where: string, extra = '') => `${title} (${n})${extra ? `: ${extra}` : ''} — ${where}`;
    return [
      '=== What you are given (read any of them in full with pk_read_assets)',
      count("Owner's words", ref("Owner's words").length, `pk_read_assets kind reference, category "Owner's words"`),
      section('Product', ref('Product')),
      section('Goals', ref('Goal')),
      section('Areas', ref('Area')),
      section('Plans', ref('Plan')),
      count('Work items', threads.length, 'pk_read_assets kind thread', [...byProgress].map(([k, n]) => `${n} ${k}`).join(', ')),
      ...(opts.documents === false ? [] : [section("This round's documents", docs)]),
      count('Area understanding', store.areas.size, 'pk_read_assets kind area'),
      count('Semantic patches', store.patches.filter((x) => x.status !== 'Rejected').length, 'pk_read_assets kind patch'),
      count('Code territories', store.territories.size, 'pk_read_assets kind territory', `${store.territories.filter((t) => t.anomalies.length > 0).length} with anomalies`),
      section('Current notes (earlier views, not evidence)', store.notes.filter((n) => n.status === 'Current').map((n) => `${n.id} ${n.versions[n.versions.length - 1]?.title ?? ''}`)),
    ].join('\n\n');
  }

  /**
   * A Follow up synthesis is told what the round has made new so far, as the program counts it (round-news.ts), so the
   * Result it writes and the round's news in `Notes (attention)` name the same things (CKC-07 AC-27).
   */
  private newsBlock(store: ProjectStore, round: ClerkRound): string {
    const news = roundNews(store, store.clerkRounds.get(round.id) ?? round);
    const section = (title: string, items: readonly { label: string; position: string; detail: string | null }[]) =>
      `${title} (${items.length})${items.length ? `\n${items.map((i) => `- ${i.label} — ${i.position}${i.detail ? ` (${i.detail})` : ''}`).join('\n')}` : ''}`;
    return [
      "=== What this round has made new so far (the program's count; your notes, send-backs and six-thing tags join it)",
      section('Breakpoints newly lit', news.breakpoints),
      section('Send-backs new or moved', news.sendbacks),
      section('Newly among the six things', news.sixThings),
      section('Semantic patches confirmed', news.patches),
      section('Notes written or updated', news.notes),
    ].join('\n');
  }

  /** Whether any document of a document-chain layer got a new version since the last round (a Follow up's skeleton, §3.8). */
  private documentChainChanged(store: ProjectStore, round: ClerkRound): boolean {
    const previous = store.clerkRounds.filter((r) => r.id !== round.id && r.status === 'Done').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (!previous) return true;
    const chain = new Set(['Product', 'PRD', 'Spec', 'Plan', 'Task index', 'Task contract', 'Decision record']);
    const paths = store.layers.filter((l) => chain.has(l.layer)).map((l) => l.path.split('\\').join('/'));
    if (paths.length === 0) return true;
    return store.sources.find((s) => s.anchor.kind === 'file' && s.version.readAt > previous.startedAt && paths.some((p) => s.anchor.kind === 'file' && s.anchor.path.split('\\').join('/').endsWith(p))) !== undefined;
  }

  // ───────────────────────── closing a round ─────────────────────────

  /**
   * CKC-23 AC-6, AC-10: what the round produced, counted from its steps' writes by workbench position; the groundwork;
   * what served nothing; the wall clock and the longest path.
   *
   * A round the planner closes ran through: its status is `Done`, and what did not finish is listed with it — on the
   * round (`failures`), in its root job's result, in a Follow up's record, and in the coverage's failure list until a run
   * again finishes it (Spec §3.10: 不静默跳过). Later rounds build on it as on any round that ran.
   */
  closeRound(store: ProjectStore, project: Project, round: ClerkRound): void {
    const steps = store.jobs.filter((j) => j.step?.roundId === round.id);
    const written = new Map<string, Set<string>>();
    // The steps' writes, and the program's own under the round (the briefs it composed for a deepening, CKC-23 AC-4).
    for (const jobId of [...steps.map((j) => j.id), round.rootJobId]) for (const e of store.traceByJob(jobId, 100_000)) {
      if (e.op !== 'put') continue;
      if (!written.has(e.collection)) written.set(e.collection, new Set());
      written.get(e.collection)!.add(e.id);
    }
    const outputs: { position: string; count: number }[] = [];
    const groundwork: { kind: string; count: number }[] = [];
    const unplacedReasons: string[] = [];
    let unplaced = 0;
    for (const [collection, ids] of written) {
      const where = POSITION_OF[collection];
      if (where?.kind === 'position') outputs.push({ position: where.label, count: ids.size });
      else if (where?.kind === 'groundwork') groundwork.push({ kind: where.label, count: ids.size });
      else if (where?.kind === 'bookkeeping') continue;
      else { unplaced += ids.size; unplacedReasons.push(`${ids.size} ${collection} record(s): no workbench position or later step reads this collection`); }
    }
    const now = new Date().toISOString();
    const current = store.clerkRounds.get(round.id) ?? round;
    const status: ClerkRound['status'] = 'Done';
    // What did not finish: the jobs listed while the round ran, as they stand now (a job the owner ran again since and
    // that finished is not among them).
    const listedAt = new Map((current.failures ?? []).map((f) => [f.jobId, f.at]));
    const failures = steps.filter((j) => j.status === 'Failed' || j.status === 'Stopped').sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)).map((j) => {
      const e = stepEnding(store, j);
      return failureOf(j, e.kind === 'listed' ? e.reason : reasonOf(j), e.kind === 'listed' ? e.runs : runsOf(j).length + 1, listedAt.get(j.id) ?? now);
    });
    const unfinished = failures.length ? `${failures.length} job${failures.length === 1 ? '' : 's'} did not finish and ${failures.length === 1 ? 'is' : 'are'} listed: ${failures.map((f) => `${f.label} (${endedText(f.status, f.runs)}: ${f.reason.slice(0, 200)})`).join('; ')}` : null;
    // The project folder follows the assets the round wrote; what happened to it is kept on the round (QC AW-2).
    const folder = this.syncFolder(store, project);
    // The main agent's last stage ended with its handover (D103); one still open — the main agent never handed over —
    // ends with its job: its time is the job's less the stages before it (D99).
    const mainJob = steps.filter((j) => j.step?.kind === 'main').sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0];
    const stageLog = current.stageLog?.some((e) => e.endedAt === null) ? endStage(current.stageLog, mainJob?.endedAt ?? now, mainJob?.timing ?? null) : current.stageLog;
    // What became of the notes standing from earlier rounds, counted as the round closes (D103; a deepening, a Follow up).
    const standing = looksAtStandingNotes(current) ? standingCounts(store, current) : null;
    store.clerkRounds.put({ ...current, ...(stageLog ? { stageLog } : {}), ...(standing ? { standingNotes: standing } : {}), endedAt: now, status, outputs: outputs.sort((a, b) => b.count - a.count), groundwork, unplaced: { count: unplaced, reasons: unplacedReasons }, folder, failures, updatedAt: now }, { jobId: round.rootJobId, summary: `${round.kind} round ${round.number} ${status}${failures.length ? ` with ${failures.length} job${failures.length === 1 ? '' : 's'} listed as not finished` : ''}` });
    this.closeFollowUpRecord(store, current, status, now, unfinished);
    this.app.keeper.endProgramJob(project.id, round.rootJobId, 'Done', { resultText: `${outputs.reduce((n, o) => n + o.count, 0)} writes on workbench positions, ${groundwork.reduce((n, g) => n + g.count, 0)} groundwork records, ${unplaced} unplaced${folder ? `; ${folder}` : ''}${unfinished ? `; ${unfinished}` : ''}` });
    if (round.kind !== 'First usable') this.app.setProjectRound(project.id, now);
  }

  /**
   * The project's projectkeeper/ folder follows the assets once a round has written them (CKC-26 AC-8, D89): only with
   * the owner's standing authorization, only that folder, never pushed. What stops it is said on the round and does not
   * fail it; the next round writes again.
   */
  private syncFolder(store: ProjectStore, project: Project): string | null {
    try {
      const r = syncProjectFolder(store, project);
      if (r.status === 'not-authorized') return null;
      if (r.reason) return `project folder: ${r.reason}`;
      return r.status === 'written' ? `project folder: wrote ${r.changedFiles.join(', ') || 'nothing new'}${r.commit ? `, commit ${r.commit.slice(0, 12)}` : ''}` : null;
    } catch (error) {
      return `project folder not written: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * A Follow up round's one result (§5.5), closed with the round: the account is the synthesis's Result document and
   * every number is counted from the assets (D43). A round that ended without one says so, and what it did judge is
   * still counted, so the next Follow up opens a record of its own. What the round made new — or that it found nothing
   * new — is counted with it (round-news.ts; CKC-07 AC-27, CKC-24 AC-15), and the baseline it was counted against goes.
   * What did not finish in the round (`unfinished`) is said at the end of the account.
   */
  private closeFollowUpRecord(store: ProjectStore, round: ClerkRound, status: ClerkRound['status'], at: string, unfinished: string | null = null): void {
    const record = round.followUpRoundId ? store.rounds.get(round.followUpRoundId) : undefined;
    if (!record || record.endedAt !== null) return;
    const doc = store.roundDocs.filter((d) => d.roundId === round.id && d.kind === 'Result').sort((a, b) => b.at.localeCompare(a.at))[0];
    const account = doc?.markdown.trim() || `Follow up round ${round.number} ended ${status === 'Done' ? 'without a Result document' : `as ${status}`}; what it judged is counted here.`;
    const summary = unfinished ? `${account}\n\nIn this round ${unfinished}.` : account;
    const behind = countRound(store, record.id).counts.behind;
    const news = roundNews(store, store.clerkRounds.get(round.id) ?? round, behind, at);
    store.rounds.put({ ...record, endedAt: at, result: roundResultOf(store, record.id, summary, at, news) }, { jobId: round.rootJobId, summary: `Follow up record ${record.number} closed with round ${round.number}: ${news.statement}` });
    const closed = store.clerkRounds.get(round.id);
    if (closed?.baseline) store.clerkRounds.put({ ...closed, baseline: null, updatedAt: at });
  }
}

/**
 * Which collection serves which workbench position, or which later step or recall (Spec §3.3 table; D81 as corrected).
 * A collection a round writes that is in neither list is counted as serving nothing, with the reason (CKC-23 AC-6).
 */
export const POSITION_OF: Readonly<Record<string, { readonly kind: 'position' | 'groundwork' | 'bookkeeping'; readonly label: string }>> = {
  reference: { kind: 'position', label: 'Product intent (graph, List, popovers)' },
  threads: { kind: 'position', label: 'Work items (process view)' },
  areas: { kind: 'position', label: 'Area understanding (List Product intent)' },
  relations: { kind: 'position', label: 'Relations (graph)' },
  marks: { kind: 'position', label: 'Marks on objects' },
  notes: { kind: 'position', label: 'Notes (attention, log, popovers)' },
  changes: { kind: 'position', label: 'Change log' },
  rules: { kind: 'position', label: 'How this project works (Project scope)' },
  layers: { kind: 'position', label: 'Layers (Project scope)' },
  generations: { kind: 'position', label: 'Earlier generations (process view bands)' },
  patches: { kind: 'position', label: 'Semantic patches (Change log, strike-throughs, project folder)' },
  numbers: { kind: 'position', label: 'Keeper numbers (process view)' },
  links: { kind: 'position', label: 'Process steps (Work and Reality)' },
  breakpoints: { kind: 'position', label: 'Breakpoints (objects, top bar)' },
  sendbacks: { kind: 'position', label: 'Send-backs (Reality, Copy for agent)' },
  territories: { kind: 'position', label: 'Code territories (Code view)' },
  merges: { kind: 'position', label: 'Merged duplicates' },
  scopeJudgements: { kind: 'position', label: 'Project scope classification' },
  propagation: { kind: 'position', label: 'Downstream judgements (Follow up)' },
  requests: { kind: 'position', label: 'Requests to role holders' },
  drafts: { kind: 'groundwork', label: 'Session drafts' },
  roundDocs: { kind: 'groundwork', label: 'Round documents (history map, questions, briefs, reports, adoption, result, spot check)' },
  sources: { kind: 'bookkeeping', label: 'How a source is used' },
  judgements: { kind: 'bookkeeping', label: 'Judgement records (Based on)' },
  jobs: { kind: 'bookkeeping', label: 'Keeper jobs' },
  clerkRounds: { kind: 'bookkeeping', label: 'Rounds' },
  rounds: { kind: 'bookkeeping', label: 'Follow up rounds' },
  authorizations: { kind: 'bookkeeping', label: 'Authorizations' },
  contexts: { kind: 'bookkeeping', label: 'Context packages' },
};
