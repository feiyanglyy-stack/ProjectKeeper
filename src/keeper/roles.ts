/**
 * Which pk_* tools a Keeper job is offered (Spec §3.3).
 *
 * A step of a clerk-method round gets its step's tools: pi's built-ins, every read, every ledger query, and the writes
 * its step owns (`stepToolsFor`; "跨对象的记录由哪一步写"), so one matter is written once, by the step that owns it. Any
 * other job is either a subagent — an investigation another job sent — which reads, and writes only what concerns its own
 * material, or other work — the owner's conversation, an answer, a request, a re-look — which is offered every tool except
 * those only a round's step has a round for (`toolsFor`).
 *
 * This is kept by the tools a job is given, not by asking the model: a subagent is never offered a tool that writes across
 * objects. When several kinds of independent job wrote the work items at once, the same work came out several times,
 * because nothing held the round (Spec §3.3, D62 background).
 *
 * The D59 method — a round claimed by one main job, whose role and round kind gated its tools — was replaced by the clerk
 * method (Spec v3.0 §3.3); its gating is gone. `roundKindOf` still recognises such a job for the two readers outside this
 * file that ask (see there).
 */
import type { KeeperJob } from '../model/types.ts';
import type { ClerkRound, RoundStepKind } from '../model/k-types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { clerkWritersOf, LANE_ALWAYS, MAIN_ALWAYS, SLOT_WRITERS, STAGE_WRITERS, SYNTHESIS_ALWAYS, SYNTHESIS_WRITERS } from './clerk-steps.ts';
import { gatedTool, MAIN_FOLLOW_UP_WRITES, stageOfRound } from './organize/stage-gate.ts';

/** The kinds of round of the D59 method: the takeover's first round, a deepening round, a Follow up. */
export type RoundKind = 'frame' | 'deepen' | 'follow-up';
export type JobRole = 'subagent' | 'other';

interface RoundExtra { readonly kind?: string; readonly round?: string; readonly roundId?: string }
const extraOf = (job: Pick<KeeperJob, 'task'> | null | undefined): RoundExtra | null => ((job?.task as { extra?: RoundExtra } | null)?.extra ?? null);

/** The rounds of the D59 method, by the kind their jobs carry (`task.extra.kind`). */
export const REPLACED_ROUND_KINDS: ReadonlySet<string> = new Set(['takeover', 'round', 'materials']);
/** A job of a D59 round: the clerk method replaced them, and their prompts name tools that no longer exist. */
export const isReplacedRound = (job: Pick<KeeperJob, 'task' | 'step'>): boolean => !job.step && REPLACED_ROUND_KINDS.has(extraOf(job)?.kind ?? '');

/**
 * The kind of D59 round a job is the main job of, or null. No code creates such a job any more: the clerk method replaced
 * them, a waiting one is stopped when the Keeper starts, and a stopped or failed one is not continued (runtime.ts
 * `stopReplacedRounds`, `restartJob`). What still asks, every path of it dead in the running program:
 * - organize/service.ts `relookAfterRequest` (a re-look waits while such a round runs) and round-tools.ts
 *   `pk_ask_owner_about_rules` (a D59 main job's rules note), through `isRoundMain`;
 * - tools.ts `roundOf` (a D59 Follow up main job judging and writing `pk_write_round_result`), and this file's
 *   `judgesFollowUp` and `takeoverRoundOf`. The judgement tests still judge through such a job (adjustment-rules,
 *   propagation-rules, round-owner, takeover-judgement, tools-validation, replaced-rounds, frame-subagent, method-tools),
 *   so these stay until those tests judge through a clerk round's cross-check.
 */
export function roundKindOf(job: Pick<KeeperJob, 'task' | 'parentJobId'> | null | undefined): RoundKind | null {
  if (!job || job.parentJobId) return null;
  const x = extraOf(job);
  if (x?.kind === 'round') return 'follow-up';
  if (x?.kind === 'takeover') return x.round === 'deepen' ? 'deepen' : 'frame';
  return null;
}

export const isRoundMain = (job: Pick<KeeperJob, 'task' | 'parentJobId'> | null | undefined): boolean => roundKindOf(job) !== null;

/**
 * The clerk-method round a job belongs to (Spec v3.0 §3.3): a step's own round, or the round whose root job this is.
 * Null for work outside the clerk method.
 */
export function clerkRoundOfJob(store: ProjectStore, job: Pick<KeeperJob, 'task' | 'step'> | null | undefined): ClerkRound | null {
  const x = extraOf(job);
  const id = job?.step?.roundId ?? (x?.kind === 'clerk-round' || x?.kind === 'clerk-step' ? x.roundId : undefined);
  return id ? store.clerkRounds.get(id) ?? null : null;
}

/**
 * The Follow up round record (`store.rounds`) a job judges in by the clerk method (Spec v3.0 §3.3, §5.5): a Follow up
 * round opens its record when it begins, and its cross-check records each piece of work's net change and judges each
 * object the changes reached, once, into that record. The round's one result is counted when the round closes. Null
 * for every other step and for work outside the clerk method.
 */
export function clerkFollowUpRecordOf(store: ProjectStore, job: Pick<KeeperJob, 'task' | 'step'> | null | undefined): string | null {
  const round = clerkRoundOfJob(store, job);
  // D99: the main job judges in its cross-check stage (its effective stage).
  const crossCheck = job?.step?.kind === 'cross-check' || (job?.step?.kind === 'main' && !!round && stageOfRound(round) === 'cross-check');
  return round?.kind === 'Follow up' && crossCheck ? round.followUpRoundId : null;
}

/**
 * Whether a job judges in a Follow up round: the round's cross-check (§5.5). A D59 Follow up main job still counts here,
 * for tools.ts's round and request paths — no such job runs any more; the tests that judge through one are listed in
 * `roundKindOf`'s note.
 */
export function judgesFollowUp(store: ProjectStore, job: Pick<KeeperJob, 'task' | 'parentJobId' | 'step'> | null | undefined): boolean {
  return roundKindOf(job) === 'follow-up' || clerkFollowUpRecordOf(store, job) !== null;
}

/** A job with a parent is a subagent of the work that sent it, whatever it was sent to do. A step of a round has its
 *  round's root as parent, and gets its step's tools instead (`stepToolsFor`). */
export function jobRole(job: Pick<KeeperJob, 'task' | 'parentJobId'>): JobRole {
  return job.parentJobId ? 'subagent' : 'other';
}

/**
 * Whether a job is part of taking the project over: a step of the first usable round or of a deepening, or anything under
 * one. Such a job never opens or joins a Follow up round (§5.5: propagation is judged in the Follow up after the takeover).
 */
export function isTakeoverWork(store: ProjectStore, jobId: string | null | undefined): boolean {
  return takeoverRoundOf(store, jobId) !== null;
}

/**
 * The takeover round a job belongs to — the clerk round of the first usable picture or of a deepening (or, before the
 * clerk method, a takeover round's main job) — or null for work outside the takeover. What such work writes names this
 * round, never a Follow up round.
 */
export function takeoverRoundOf(store: ProjectStore, jobId: string | null | undefined): string | null {
  let job = jobId ? store.jobs.get(jobId) : undefined;
  for (let depth = 0; job && depth < 8; depth++) {
    const clerk = clerkRoundOfJob(store, job);
    if (clerk) return clerk.kind === 'Follow up' ? null : clerk.id;
    if (job.scope.kind === 'takeover' || extraOf(job)?.kind === 'takeover') return job.id;
    job = job.parentJobId ? store.jobs.get(job.parentJobId) : undefined;
  }
  return null;
}

/**
 * What a subagent may use: reading the assets and the sources, recording how a source is used, and the fact records
 * of its own material. An allowlist on purpose: a tool added later that writes across objects is kept from subagents
 * until someone decides otherwise. A subagent sends no subagents of its own: subagents do not wait on one another
 * (§3.3), and what else needs reading is for the job that sent it to hand out.
 */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  'pk_project_overview', 'pk_list_sources', 'pk_read_source', 'pk_read_assets', 'pk_find_references', 'pk_set_used_as', 'pk_write_fact_record',
  // Version history is read like any material; what it records is a History only source of that reading alone.
  'pk_history_log', 'pk_history_read', 'pk_history_deleted',
  // A claim is checked against the code by the subagent that read the report, and the check is recorded next to the
  // claim in that report's fact record (Spec §2.4; CKC-06 AC-23).
  'pk_record_code_check',
]);
/**
 * What only a Follow up round's cross-check does (§2.10, §3.3, §5.5; CKC-11 AC-25): one state per object per round, and
 * what its own changes reached. The owner's conversation, an answer, a request or a re-look has no round of its own: a
 * judgement from one of them used to open a round, judge in it and close it with a result beside the round. An owner's
 * correction is recorded on the object itself and judged by the next Follow up round; the owner who wants that now
 * presses Follow up (§3.8). `pk_write_round_result` is offered to no job at all: the clerk method counts the round's one
 * result when the round closes (organize/clerk.ts); the tool stays for the tests that judge through a D59 main job.
 */
export const FOLLOW_UP_TOOLS: ReadonlySet<string> = new Set(['pk_judge_object', 'pk_set_propagation', 'pk_set_propagations', 'pk_round_pending', 'pk_write_round_result']);
/** Putting the rules the round inferred to the owner in the round's one note (§3.9): only a round's synthesis has a
 *  round to write that note for. */
export const ROUND_SYNTHESIS_TOOLS: ReadonlySet<string> = new Set(['pk_ask_owner_about_rules']);

/**
 * The tools a job that is not a step of a round is offered. pi's own tools (read, grep, bash …) are not pk_* tools and
 * pass through (§3.1). A subagent reads, and writes only its own material's fact records; other work gets every pk_* tool
 * except those only a round's step has a round for.
 */
export function toolsFor<T extends { readonly name: string }>(tools: readonly T[], role: JobRole): T[] {
  return tools.filter((t) => {
    if (!t.name.startsWith('pk_')) return true;
    // The ledger's tools only read (§1.16): a subagent asks them as any step does (CKC-03 AC-26).
    if (role === 'subagent') return SUBAGENT_TOOLS.has(t.name) || t.name.startsWith('pk_ledger_');
    return !FOLLOW_UP_TOOLS.has(t.name) && !ROUND_SYNTHESIS_TOOLS.has(t.name);
  }).map((t) => (t.name === OWNER_WORDS_TOOL ? countedOwnerWords(t) : t));
}

// ───────────────────────── how much of the owner's words a job read (Spec §3.7; D37; CKC-13 AC-25) ─────────────────────────

const OWNER_WORDS_TOOL = 'pk_owner_utterances';

type ToolResult = { content?: { type: string; text?: string }[] } & Record<string, unknown>;

/**
 * pk_owner_utterances with how much it read leading its answer: "Read 50 of the owner’s 60 messages (9000 of 11000
 * characters)". The first round's owner's-words step is evidence for D37 — how long it took and how much the owner
 * said — and the job's steps are where the runtime keeps each call, so the count is put where the step keeps it. The
 * answer itself follows unchanged.
 */
function countedOwnerWords<T extends { readonly name: string }>(tool: T): T {
  const run = (tool as unknown as { execute?: (...args: unknown[]) => Promise<ToolResult> }).execute;
  if (typeof run !== 'function') return tool;
  return {
    ...tool,
    execute: async (...args: unknown[]) => {
      const result = await run.apply(tool, args);
      const first = result?.content?.[0];
      if (!first || typeof first.text !== 'string') return result;
      let page: { utterances?: { chars?: number; text?: string }[]; total?: number; totalChars?: number };
      try { page = JSON.parse(first.text) as typeof page; } catch { return result; }
      if (!Array.isArray(page.utterances)) return result;
      const chars = page.utterances.reduce((n, u) => n + (typeof u.chars === 'number' ? u.chars : (u.text ?? '').length), 0);
      const line = `Read ${page.utterances.length} of the owner’s ${page.total ?? page.utterances.length} messages (${chars} of ${page.totalChars ?? chars} characters)`;
      return { ...result, content: [{ ...first, text: `${line} ${first.text}` }, ...(result.content ?? []).slice(1)] };
    },
  } as T;
}

// ───────────────────────── the clerk method: what each step may write (Spec v3.0 §3.3) ─────────────────────────

/**
 * Reading is open to every step (CKC-23 AC-5): every pk_* read tool and every ledger tool (`pk_ledger_*`), besides pi's
 * built-ins, which are never filtered here. What a step may write follows §3.3 "跨对象的记录由哪一步写": orientation the
 * layers, rules, generations and the round's questions and briefs; the skeleton the trunk, numbers and patch drafts; a
 * deep sweep only its report; the cross-check the positions it has checked; the synthesis the notes, send-backs, the
 * six things, area understanding and the round's Result (D103: in a job of its own, after the main agent's handover);
 * the spot-check its corrections and its record. So one matter is written once, by the step that owns it.
 */
const PK_READ_TOOLS: ReadonlySet<string> = new Set([
  'pk_project_overview', 'pk_list_sources', 'pk_read_source', 'pk_read_assets', 'pk_find_references', 'pk_owner_utterances',
  'pk_history_log', 'pk_history_read', 'pk_history_deleted', 'pk_scope_items',
]);
const TRUNK_WRITES = ['pk_write_reference', 'pk_write_thread', 'pk_write_area', 'pk_relate', 'pk_write_mark', 'pk_merge_work_items', 'pk_record_carry_out', 'pk_check_decisions', 'pk_set_used_as'];
const FOLLOW_UP_WRITES = ['pk_write_change', 'pk_judge_object', 'pk_set_propagation', 'pk_set_propagations', 'pk_write_modification_request', 'pk_mark_request_handled', 'pk_round_pending'];
/** The writers from before the clerk method, by step; the clerk method's own writers come from their one table. */
const EARLIER_WRITES: Readonly<Record<RoundStepKind, readonly string[]>> = {
  ledger: [],
  // D99 (W1+W2): the main agent is offered every stage's writers, gated by its stage; a lane by its slots.
  main: [],
  lane: [],
  'session-drafts': [],
  orientation: ['pk_write_rule', 'pk_classify_scope', 'pk_set_used_as', 'pk_write_organizing_plan'],
  skeleton: TRUNK_WRITES,
  dig: [],
  'cross-check': [...TRUNK_WRITES, 'pk_write_rule'],
  process: [],
  // The round's result is its Result document; a Follow up's counted result is closed with the round (clerk.ts).
  // D103: the synthesis is a job of its own again; what it is offered is one table (`SYNTHESIS_WRITERS`), with where the
  // round stands (`SYNTHESIS_ALWAYS`).
  synthesis: [...SYNTHESIS_WRITERS, ...SYNTHESIS_ALWAYS],
  'spot-check': [...TRUNK_WRITES, 'pk_write_note'],
};
export const STEP_WRITES: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  (Object.entries(EARLIER_WRITES) as [RoundStepKind, readonly string[]][]).map(([step, earlier]) => [step, new Set([...earlier, ...clerkWritersOf(step)])]),
);

/**
 * What the main job (D99) and a lane write, offered whole to their one session (E148 D-a): the main job every stage's
 * writers, and in a Follow up round the round's judgements; a lane its slots' writers and its Report.
 */
// D103: the main agent is no longer offered what only the synthesis writes — `STAGE_WRITERS.synthesis` is empty.
function d99Writes(step: string, round: 'First usable' | 'Deepen' | 'Follow up', slots: readonly string[]): Set<string> {
  if (step === 'main') return new Set([...MAIN_ALWAYS, ...Object.values(STAGE_WRITERS).flat(), ...(round === 'Follow up' ? MAIN_FOLLOW_UP_WRITES : [])]);
  const base = (s: string) => (s.startsWith('reference:') ? 'reference' : s.split(':')[0]!);
  return new Set([...LANE_ALWAYS, ...slots.flatMap((s) => SLOT_WRITERS[base(s) as keyof typeof SLOT_WRITERS] ?? [])]);
}

/**
 * The tools a step of a clerk-method round is offered: pi's built-ins, every read, and the writes its step owns. The main
 * job and a lane (D99) are offered what they write in any stage or slot; `gate` then refuses at call time what the job's
 * effective stage does not allow (stage-gate.ts `writeRefusal`), so each writer still writes only where it belongs.
 */
export function stepToolsFor<T extends { readonly name: string }>(tools: readonly T[], step: string, round: 'First usable' | 'Deepen' | 'Follow up',
  lane: { readonly slots: readonly string[] } | null = null, gate: ((tool: string, args: Record<string, unknown> | null) => string | null) | null = null): T[] {
  const d99 = step === 'main' || step === 'lane';
  const writes = d99 ? d99Writes(step, round, lane?.slots ?? []) : STEP_WRITES[step] ?? new Set<string>();
  const followUp = round === 'Follow up' && step === 'cross-check';
  return tools.filter((t) => {
    if (!t.name.startsWith('pk_')) return true;
    if (t.name.startsWith('pk_ledger_') || PK_READ_TOOLS.has(t.name)) return true;
    return writes.has(t.name) || (followUp && FOLLOW_UP_WRITES.includes(t.name));
  }).map((t) => {
    const counted = t.name === OWNER_WORDS_TOOL ? countedOwnerWords(t) : t;
    const reads = !t.name.startsWith('pk_') || t.name.startsWith('pk_ledger_') || PK_READ_TOOLS.has(t.name);
    return d99 && gate && !reads ? gatedTool(counted as T & { execute?: (...args: never[]) => unknown }, gate) : counted;
  });
}
