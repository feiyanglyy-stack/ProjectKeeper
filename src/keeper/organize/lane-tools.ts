/**
 * The main agent's lanes (D99; E148 D-c; build plan §2 "各路", §6): `pk_send_lanes` sends several lanes in one call — GLM
 * makes about one and a half calls a turn, so lanes sent one call at a time would run one after another — and waits
 * until every one has ended; `pk_lanes` lists the round's lanes.
 *
 * Each lane is a job of its own under the main job (`step.kind` `lane`, `path` its name, `lane` its kind and slots), in a
 * session of its own, sent through the runtime's `delegate`: it runs on whichever key has a free slot while the main job
 * waits parked, so several lanes run at once across all keys. Its prompt is its lane's skill, its brief (a `Brief` round
 * document the main agent wrote first), the round and the project's rules.
 *
 * Sending is idempotent by lane name within the round: a lane already sent is not sent twice. Sent again, a lane that is
 * Done returns its summary and report; one queued or running is waited for; one a restart or the provider interrupted
 * goes on in its own session; one that failed runs again up to `RUN_AGAIN_LIMIT` times, then comes back `Listed`. So the
 * main agent can send the same call again after a restart, or after its turn was cut short, without doubling any lane.
 * The planner never runs a lane again itself: the main job owns its lanes.
 *
 * DB: when a first usable round's skeleton lanes are sent, a slot of the workbench that no lane holds is listed back
 * before anything is sent (slots.ts): the main agent gives it to a lane, or says in one line why the project has nothing
 * for it (`empty`), which is kept on the round and shown to the next spot-check. Nothing more is refused.
 */
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ClerkRound, EmptySlot, LaneKind, RoundDoc, RoundLane, SlotKind } from '../../model/k-types.ts';
import { SKELETON_SLOTS, skeletonSlot, slotKey, slotsUnheld } from './slots.ts';
import type { KeeperJob } from '../../model/types.ts';
import type { ToolContext } from '../tools.ts';
import { RUN_AGAIN_LIMIT, runsOf, withEarlierRuns, type StepRun } from './clerk.ts';
import { laneBlocksOf, lanePrompt, roundBlockOf, rulesBlockOf } from './round-blocks.ts';
import { Ledger } from '../../ledger/index.ts';
import { stageOfRound } from './stage-gate.ts';

/** How the runtime runs a lane of the main job (runtime.ts `delegate`); each promise settles when the lane has ended —
 *  Done, Failed, or Stopped with nothing to go on with — never on `Waiting for quota`, which moves it to another key. */
export interface LaneRunner {
  /** Queue a new lane under the main job. */
  send(request: LaneJobRequest): { readonly job: KeeperJob; readonly ended: Promise<KeeperJob> };
  /** Queue an ended lane again: it continues its own session when it has one to go on with (`resume`), else runs afresh. */
  again(jobId: string): Promise<KeeperJob>;
  /** Wait for a lane already queued or running. */
  wait(jobId: string): Promise<KeeperJob>;
}

export interface LaneJobRequest {
  readonly scope: { readonly kind: string; readonly ids: readonly string[]; readonly label: string };
  readonly prompt: string;
  readonly step: NonNullable<KeeperJob['step']>;
  readonly task: unknown;
  readonly timeoutMs: number;
}

/** A lane's time limit (E148 D-j): eight hours, the same as a step's before D99. */
export const LANE_TIMEOUT_MS = 8 * 60 * 60_000;
/** How much of a lane's final message comes back to the main agent: its summary; the full report is its Report document. */
export const LANE_SUMMARY_CHARS = 2_000;

export const LANE_KINDS: readonly LaneKind[] = ['slot', 'plan', 'topic', 'follow-up'];
const SLOT_WORDS = ['threads', 'links', 'territories', 'patches', 'generations', 'relations'] as const;
export const isSlotKind = (s: string): s is SlotKind => (SLOT_WORDS as readonly string[]).includes(s) || /^reference:\S/.test(s);

export type LaneStatus = 'Done' | 'Listed' | 'Stopped';
export interface LaneOutcome { readonly name: string; readonly status: LaneStatus; readonly summary: string; readonly reportDocId: string | null; readonly jobId: string }

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
/** The runtime's words for a job a restart of ProjectKeeper cut short (runtime.ts `init`). */
const RESTARTED = /restarted while this work was running/i;
const now = () => new Date().toISOString();
function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }], details: {} };
}
function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }], details: {}, isError: true };
}

/** The lane's final message, trimmed, as its summary for the main agent. */
export function laneSummary(job: KeeperJob): string {
  const t = (job.resultText ?? '').trim();
  if (!t) return '';
  return t.length > LANE_SUMMARY_CHARS ? `${t.slice(0, LANE_SUMMARY_CHARS)}… (the rest is in its Report)` : t;
}

/** The lane's Report round document: the latest `Report` of the round under the lane's name. */
export function laneReport(store: ToolContext['store'], roundId: string, name: string): RoundDoc | null {
  return store.roundDocs.filter((d) => d.roundId === roundId && d.kind === 'Report' && d.path === name).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

/** Runs of a lane the main agent's `pk_send_lanes` ran again since the owner last did, as the planner counts a step's. */
const countedRuns = (job: KeeperJob): number => { const runs = runsOf(job); return runs.slice(runs.map((r) => r.again).lastIndexOf('owner') + 1).filter((r) => r.counted).length; };

/** A lane's status as the round's lanes list shows it. */
function laneStatusOf(job: KeeperJob | undefined): string {
  if (!job) return 'Unknown';
  if (job.status === 'Failed' && countedRuns(job) >= RUN_AGAIN_LIMIT) return 'Listed';
  return job.status;
}

/** The round's lanes with their jobs' status and report, for `pk_lanes` and `pk_round_state`. */
export function lanesOf(store: ToolContext['store'], round: ClerkRound): { name: string; kind: LaneKind; slots: readonly SlotKind[]; status: string; reportDocId: string | null; briefDocId: string; jobId: string; stage: string }[] {
  return (round.lanes ?? []).map((l) => ({
    name: l.name, kind: l.kind, slots: l.slots, status: laneStatusOf(store.jobs.get(l.jobId)), reportDocId: laneReport(store, round.id, l.name)?.id ?? l.reportDocId, briefDocId: l.briefDocId, jobId: l.jobId, stage: l.stage,
  }));
}

export function laneTools(ctx: ToolContext): ToolDefinition[] {
  const { store, project } = ctx;
  const trace = (summary: string) => ({ jobId: ctx.jobId, basisSourceIds: [] as string[], summary });

  /** The main job's round, or why this job may not send lanes. */
  const mainRound = (tool: string): ClerkRound | string => {
    const step = ctx.step;
    if (!step || step.kind !== 'main') return `${tool} is the main agent's: only the main job of a round sends and lists lanes.`;
    const round = store.clerkRounds.get(step.roundId);
    if (!round) return `The round ${step.roundId} is not in the assets.`;
    return round;
  };

  /** Record a lane on the round (or its report once written), keeping the lanes others recorded meanwhile. */
  const putLane = (roundId: string, lane: RoundLane, summary: string) => {
    const current = store.clerkRounds.get(roundId)!;
    const lanes = [...(current.lanes ?? []).filter((l) => l.name !== lane.name), lane];
    const order = new Map((current.lanes ?? []).map((l, i) => [l.name, i]));
    lanes.sort((a, b) => (order.get(a.name) ?? Infinity) - (order.get(b.name) ?? Infinity));
    store.clerkRounds.put({ ...current, lanes, updatedAt: now() }, trace(summary));
  };

  /** A failed lane, run again: its earlier runs with it, as the planner runs a step's job again (clerk.ts `runAgain`). */
  const runAgain = async (job: KeeperJob): Promise<KeeperJob> => {
    const at = now();
    const run: StepRun = { endedAt: job.endedAt ?? at, status: job.status === 'Stopped' ? 'Stopped' : 'Failed', reason: job.error?.trim() || 'Failed with no reason recorded', usage: job.usage, again: 'program', at, counted: true };
    const runs = [...runsOf(job), run];
    const task = (job.task ?? {}) as { prompt?: string; extra?: Record<string, unknown> | null };
    store.jobs.put({ ...job, task: { ...task, prompt: withEarlierRuns(task.prompt ?? '', job, runs), extra: { ...(task.extra ?? {}), runs } } }, { jobId: job.id, summary: `${job.scope.label}: run again by the main agent's pk_send_lanes (run ${runs.length + 1}); its last run failed: ${run.reason.slice(0, 200)}` });
    return ctx.lanes!.again(job.id);
  };

  /** Wait until a lane has ended, running it again while it fails and may run again; then what the main agent gets back. */
  const settle = async (roundId: string, name: string, first: Promise<KeeperJob>): Promise<LaneOutcome> => {
    let job = await first;
    while (job.status === 'Failed' && countedRuns(job) < RUN_AGAIN_LIMIT) job = await runAgain(job);
    const report = laneReport(store, roundId, name);
    const round = store.clerkRounds.get(roundId);
    const recorded = round?.lanes?.find((l) => l.name === name);
    if (recorded && report && recorded.reportDocId !== report.id) putLane(roundId, { ...recorded, reportDocId: report.id }, `Lane ${name}: its report is ${report.id}`);
    const status: LaneStatus = job.status === 'Done' ? 'Done' : job.status === 'Failed' ? 'Listed' : 'Stopped';
    const summary = status === 'Done' ? laneSummary(job)
      : status === 'Listed' ? `Failed ${runsOf(job).length + 1} times and is listed as not finished: ${job.error ?? 'no reason recorded'}.${laneSummary(job) ? ` What it had written: ${laneSummary(job)}` : ''}`
        : `Stopped${job.error ? ` (${job.error})` : ' by the owner'} before it finished.${laneSummary(job) ? ` What it had written: ${laneSummary(job)}` : ''}`;
    return { name, status, summary, reportDocId: report?.id ?? null, jobId: job.id };
  };

  const tools: ToolDefinition[] = [];

  tools.push(defineTool({
    name: 'pk_send_lanes', label: 'Send lanes',
    description: 'Send the lanes of this stage, all in one call: each lane is a subagent in a session of its own that answers its brief and writes the slots you give it, and they run at the same time. Write each lane\'s brief first as a Brief round document (pk_write_round_doc kind Brief, path = the lane\'s name) and give its id here; the brief is not repeated in this call. kind: slot (a group of workbench slots, first usable), plan (one plan or stage: is it done, where is the evidence, what is open), topic (a theme orientation found), follow-up (what the coverage check left). slots: what the lane may write — reference:<category> (e.g. reference:Goal, reference:Requirement, reference:Design; reference:Owner\'s words gets the owner’s lines in full with its brief), threads (work items and their numbers), links (process links to deliveries), territories (code territories), patches (draft semantic patches), generations (earlier generations — threads comes with it, for their items and each item’s destination), relations; every lane also writes its own Report and pk_record_looked. The call waits until every lane has ended and returns each one\'s status (Done, Listed after failing three times, or Stopped), its summary and its Report id: read a report in full with pk_read_assets kind roundDoc. A lane is known by its name in this round: sending a name again never sends it twice — a finished lane returns its result, a running one is waited for, an interrupted one goes on. So after an interruption, send the same call again. A first usable round’s skeleton fills every slot of the workbench: a slot no lane of the call holds is listed back before anything is sent — give it to a lane, or say in empty why the project has nothing for it (one line each, kept on the round and shown to the spot-check).',
    parameters: Type.Object({
      lanes: Type.Array(Type.Object({
        name: Type.String({ description: 'the lane\'s name, unique in this round; its Brief\'s path' }),
        kind: Type.String({ description: 'slot | plan | topic | follow-up' }),
        briefDocId: Type.String({ description: 'the id of the lane\'s Brief round document of this round' }),
        slots: Type.Array(Type.String(), { description: 'reference:<category> | threads | links | territories | patches | generations | relations' }),
      }), { description: 'every lane of this stage, in one call' }),
      empty: Type.Optional(Type.Array(Type.Object({
        slot: Type.String({ description: 'the slot no lane holds, e.g. reference:Boundary' }),
        why: Type.String({ description: 'one line: why this project has nothing for it (what you read that shows it), or that you fill it yourself in reconcile and from what' }),
      }), { description: 'first usable skeleton only: the slots you give to no lane, each with why' })),
    }),
    execute: async (_id, p, signal) => {
      const round = mainRound('pk_send_lanes');
      if (typeof round === 'string') return fail(round);
      if (round.status !== 'Running') return fail(`Round ${round.number} is ${round.status}: no lane is sent for it.`);
      if (!ctx.lanes) return fail('This build cannot run lanes (no runtime to send them): do the lanes\' work yourself, one after another, and say so in the round\'s Result.');
      const given = Array.isArray(p.lanes) ? p.lanes as Record<string, unknown>[] : [];
      if (!given.length) return fail('lanes is empty: give every lane of this stage, each with name, kind, briefDocId and slots.');
      const problems: string[] = [];
      const names = new Set<string>();
      const wanted: { name: string; kind: LaneKind; brief: RoundDoc; slots: SlotKind[] }[] = [];
      for (const [i, l] of given.entries()) {
        const name = text(l.name);
        const kind = text(l.kind) as LaneKind;
        const briefId = text(l.briefDocId);
        const slots = Array.isArray(l.slots) ? (l.slots as unknown[]).map((s) => text(s).replace(/[’‘`]/g, "'")) : [];
        const at = `lanes[${i}]${name ? ` (${name})` : ''}`;
        if (!name) { problems.push(`${at}: give the lane a name`); continue; }
        if (names.has(name)) { problems.push(`${at}: the name ${name} is given twice in this call; each lane has its own name`); continue; }
        names.add(name);
        if (!LANE_KINDS.includes(kind)) problems.push(`${at}: kind must be one of ${LANE_KINDS.join(', ')}`);
        const brief = store.roundDocs.get(briefId);
        if (!brief || brief.roundId !== round.id || brief.kind !== 'Brief') problems.push(`${at}: briefDocId ${briefId || '(none)'} is not a Brief of this round; write the brief first with pk_write_round_doc kind Brief, path ${name}, and give the id it returns`);
        const bad = slots.filter((s) => !isSlotKind(s));
        if (bad.length) problems.push(`${at}: ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not a slot; slots are reference:<category>, threads, links, territories, patches, generations, relations`);
        // CM (E151): a lane that records generations records their items and each item's destination too — work items.
        // On the gated run the lane had `generations` without `threads` and could write neither.
        const given = slots.includes('generations') && !slots.includes('threads') ? [...slots, 'threads'] : slots;
        if (brief && !bad.length && LANE_KINDS.includes(kind)) wanted.push({ name, kind, brief, slots: given as SlotKind[] });
      }
      // DB: the reasons given for slots left to no lane, each a slot of the skeleton with a line of why.
      const emptyGiven: { slot: SlotKind; why: string }[] = [];
      for (const [i, e] of (Array.isArray((p as Record<string, unknown>).empty) ? (p as Record<string, unknown>).empty as Record<string, unknown>[] : []).entries()) {
        const known = skeletonSlot(text(e.slot));
        const why = text(e.why).replace(/\s+/g, ' ');
        if (!known) problems.push(`empty[${i}]: ${text(e.slot) || '(none)'} is not a slot the skeleton fills; they are ${SKELETON_SLOTS.map((s) => s.slot).join(', ')}`);
        else if (!why) problems.push(`empty[${i}] (${known.slot}): say in one line why the project has nothing for it`);
        else emptyGiven.push({ slot: known.slot, why });
      }
      if (problems.length) return fail(`No lane was sent:\n${problems.join('\n')}`);

      const notes = new Map<string, string>();
      const pending: Promise<LaneOutcome>[] = [];
      const stage = stageOfRound(store.clerkRounds.get(round.id) ?? round);
      // DB: a first usable round's skeleton — every slot of the workbench is held by a lane, or has its one-line reason.
      // Checked when the call sends a lane not sent before; sending the same call again after an interruption waits as ever.
      if (round.kind === 'First usable' && stage === 'skeleton') {
        const current = store.clerkRounds.get(round.id) ?? round;
        const sent = current.lanes ?? [];
        const held = [...sent.flatMap((l) => l.slots), ...wanted.flatMap((w) => w.slots)];
        const heldKeys = new Set(held.map(slotKey));
        const at = now();
        const reasons: EmptySlot[] = [
          ...(current.emptySlots ?? []).filter((e) => !heldKeys.has(slotKey(e.slot)) && !emptyGiven.some((g) => slotKey(g.slot) === slotKey(e.slot))),
          ...emptyGiven.filter((g) => !heldKeys.has(slotKey(g.slot))).map((g) => ({ slot: g.slot, why: g.why, at })),
        ];
        const unheld = slotsUnheld(held, reasons);
        if (unheld.length && wanted.some((w) => !sent.some((l) => l.name === w.name))) {
          return fail(`No lane was sent yet. The skeleton fills every slot of the workbench, and ${unheld.length === 1 ? 'this slot is' : `these ${unheld.length} slots are`} held by no lane of this call:\n${unheld.map((u) => `- ${u.slot} — ${u.holds}`).join('\n')}\nFor each: where the project has such material, add the slot to the lane that reads it (and name the material in that lane’s brief); where it has none, say so in this call — empty: [{ slot, why }], one line each on why the project has nothing for it. The reasons are kept on the round and shown to the spot-check; nothing more is asked. Then send the call again with the same lanes.`);
        }
        const before = current.emptySlots ?? [];
        if (reasons.length !== before.length || reasons.some((r, i) => r.slot !== before[i]?.slot || r.why !== before[i]?.why)) {
          store.clerkRounds.put({ ...current, emptySlots: reasons, updatedAt: at }, trace(`Round ${round.number}: ${reasons.length} slot${reasons.length === 1 ? '' : 's'} held by no lane, with why: ${reasons.map((r) => `${r.slot} — ${r.why}`).join('; ').slice(0, 600)}`));
        }
        for (const g of emptyGiven.filter((x) => heldKeys.has(slotKey(x.slot)))) {
          const holder = [...sent, ...wanted].find((l) => l.slots.some((s) => slotKey(s) === slotKey(g.slot)));
          if (holder) notes.set(holder.name, `${g.slot} is held by this lane, so its reason in empty was not recorded.`);
        }
      }
      for (const w of wanted) {
        const current = store.clerkRounds.get(round.id) ?? round;
        const sent = current.lanes?.find((l) => l.name === w.name);
        const job = sent ? store.jobs.get(sent.jobId) : undefined;
        if (sent && job) {
          if (sent.briefDocId !== w.brief.id || sent.kind !== w.kind || JSON.stringify(sent.slots) !== JSON.stringify(w.slots)) notes.set(w.name, `${w.name} was sent already with brief ${sent.briefDocId}, kind ${sent.kind} and slots ${sent.slots.join(', ') || 'none'}: a lane is known by its name, so it was not sent again. To send another lane, give it a name of its own.`);
          // A lane a restart cut short goes on — in its own session when it had one open, else afresh from its task (a
          // restart before its session was open left nothing to continue); one the owner stopped stays stopped.
          const restarted = job.status === 'Stopped' && RESTARTED.test(job.error ?? '');
          if (job.status === 'Done' || job.status === 'Failed' || (job.status === 'Stopped' && !job.resume && !restarted)) pending.push(settle(round.id, w.name, Promise.resolve(job)));
          else if (job.status === 'Stopped') pending.push(settle(round.id, w.name, ctx.lanes.again(job.id)));
          else pending.push(settle(round.id, w.name, ctx.lanes.wait(job.id)));
          continue;
        }
        const roundBlock = roundBlockOf(store, project, current);
        // CM: the lane that writes the owner's words gets the owner's lines in full (the main agent, their count).
        const previous = current.kind === 'Follow up' ? store.clerkRounds.filter((r) => r.id !== current.id && r.status === 'Done').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] : undefined;
        let ledger: Ledger | null = null;
        try { ledger = Ledger.openDir(store.dir); } catch { ledger = null; }
        let blocks: string[];
        try { blocks = laneBlocksOf(store, w.slots, ledger, previous?.startedAt ?? null); } finally { ledger?.close(); }
        const prompt = lanePrompt({ name: w.name, kind: w.kind, slots: w.slots, brief: w.brief.markdown, briefDocId: w.brief.id, roundBlock, rules: rulesBlockOf(store), blocks });
        const { job: queued, ended } = ctx.lanes.send({
          scope: { kind: 'clerk-step', ids: [round.id], label: `Lane: ${w.name}` },
          prompt,
          step: { roundId: round.id, kind: 'lane', path: w.name, lane: { kind: w.kind, slots: w.slots } },
          task: { kind: 'clerk-step', roundId: round.id, route: 'lane', lane: w.name },
          timeoutMs: LANE_TIMEOUT_MS,
        });
        // Recorded before waiting, so a restart while the lanes run finds each lane by its name and never sends it twice.
        putLane(round.id, { name: w.name, kind: w.kind, briefDocId: w.brief.id, slots: w.slots, jobId: queued.id, stage, sentAt: now(), reportDocId: null }, `Round ${round.number}: lane ${w.name} sent (${w.kind}; ${w.slots.join(', ') || 'no slots'})`);
        pending.push(settle(round.id, w.name, ended));
      }
      // The main agent's own turn ending (the owner's Stop, a pause) does not wait for the lanes: they go on, or stop, by themselves.
      const aborted = new Promise<null>((resolve) => { if (signal?.aborted) resolve(null); else signal?.addEventListener('abort', () => resolve(null), { once: true }); });
      const outcomes = await Promise.race([Promise.all(pending), aborted]);
      if (!outcomes) return fail('The main agent\'s turn was stopped while its lanes ran; they go on or stop by themselves. Send the same call again to wait for them.');
      // The contract's answer (§6): one entry per lane; a lane sent before under other terms says so in its note.
      return ok(outcomes.map((o) => ({ ...o, ...(notes.has(o.name) ? { note: notes.get(o.name) } : {}) })));
    },
  }));

  tools.push(defineTool({
    name: 'pk_lanes', label: 'List this round\'s lanes',
    description: 'The lanes of this round: each one\'s name, kind, slots, brief, status and Report id, in the order sent.',
    parameters: Type.Object({}),
    execute: async () => {
      const round = mainRound('pk_lanes');
      if (typeof round === 'string') return fail(round);
      return ok({ round: { id: round.id, kind: round.kind, number: round.number }, lanes: lanesOf(store, round) });
    },
  }));

  return tools;
}
