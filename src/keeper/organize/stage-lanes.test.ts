/**
 * The main agent's stages, what it and its lanes may write, and sending lanes (D99; build plan §2, §6; E148 D-a, D-c, D-g):
 *   - `pk_stage` goes forward only, skips only what the method allows and says why, keeps the four kinds of question and
 *     a `Full` deepening's coverage gate, records each stage with its time, and returns the stage's skill;
 *   - the main job is refused a writer outside its stage, a lane a writer outside its slots (reference items by category);
 *   - `pk_send_lanes` checks every lane before sending any, and is idempotent by name: a lane is never sent twice, a
 *     running one is waited for, an interrupted one goes on, a failed one runs again and after three failures is Listed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../../store/project-store.ts';
import type { KeeperJob, Project } from '../../model/types.ts';
import type { ClerkRound, ClerkStage, RoundDoc, RoundKind, StepTiming } from '../../model/k-types.ts';
import type { ToolContext } from '../tools.ts';
import { stageTools, type StageDeps } from './stage-tools.ts';
import { laneTools, type LaneJobRequest, type LaneRunner } from './lane-tools.ts';
import { SKELETON_SLOTS } from './slots.ts';
import { roundDocRefusal, writeRefusal } from './stage-gate.ts';
import { stepToolsFor } from '../roles.ts';
import { clerkTools } from '../clerk-tools.ts';

const AT = '2026-09-29T00:00:00.000Z';
const project = { id: 'p1', name: 'Kiln', language: 'en', locations: [tmpdir()], scope: [], scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false, createdAt: AT, lastOpenedAt: null, lastScopedAt: null, takeoverDepth: 'Full' } as unknown as Project;

function round(kind: RoundKind, stage: ClerkStage | null = null): ClerkRound {
  return {
    id: 'round_1', projectId: 'p1', kind, number: 1, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root',
    questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT,
    stage, stageLog: stage ? [{ stage, startedAt: AT, endedAt: null, timing: null }] : [], lanes: [],
  };
}
const brief = (id: string, path: string, roundId = 'round_1'): RoundDoc => ({ id, projectId: 'p1', roundId, jobId: 'job_main', kind: 'Brief', path, title: `Brief: ${path}`, markdown: `Answer ${path}.`, at: AT });
const job = (id: string, patch: Partial<KeeperJob> = {}): KeeperJob => ({
  id, projectId: 'p1', kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['round_1'], label: id }, status: 'Queued', queuedAt: AT, startedAt: null, endedAt: null,
  savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null,
  requestBasis: null, parentJobId: 'job_main', resultText: null, priority: 0, task: { prompt: 'Task: a lane', extra: null }, step: null, ...patch,
});

type Call = (name: string, args: Record<string, unknown>) => Promise<{ text: string; error: boolean; json: Record<string, unknown> }>;
function caller(tools: readonly { name: string; execute?: unknown }[]): Call {
  return async (name, args) => {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `no tool ${name}`);
    const run = tool.execute as (id: string, p: unknown, signal?: AbortSignal) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    let r: { content: { text: string }[]; isError?: boolean };
    try { r = await run('call', args); } catch (e) { return { text: (e as Error).message, error: true, json: {} }; }
    const text = r.content.map((c) => c.text).join('\n');
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* prose */ }
    return { text, error: r.isError === true, json };
  };
}

function setup(kind: RoundKind, stage: ClerkStage | null, deps: Partial<StageDeps> = {}, extra: Partial<ToolContext> = {}) {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-stage-store-')));
  store.clerkRounds.put(round(kind, stage));
  let t = 0;
  const entered: string[] = [];
  const ctx: ToolContext = {
    store, project, jobId: 'job_main', jobKind: 'Organizing', model: null, step: { roundId: 'round_1', kind: 'main', path: null },
    timingSnapshot: (): StepTiming => { t += 1000; return { wallMs: t, generationMs: t / 2, toolMs: t / 4, queueMs: 0, parseRetryMs: 0, otherMs: t / 4 }; },
    stageEntered: (_r, s) => { entered.push(s); return { note: `entered ${s}` }; },
    ...extra,
  };
  const tools = stageTools(ctx, { coverageSettled: () => true, stageSkill: (s) => `SKILL ${s}`, ...deps });
  return { store, ctx, call: caller(tools), entered };
}

const HANDOVER = { settled: 'The lanes are joined into one trunk.', open: 'Two work items stay in no plan: no record places them.', first: 'The plan lane\'s report.' };

test('the stages go forward only, one by one, and each returns its skill; the round records each stage and its time; the last one ends with the handover to the synthesis (D103)', async () => {
  const { store, call, entered } = setup('First usable', 'orientation');
  assert.match((await call('pk_stage', { to: 'reconcile' })).text, /does not skip skeleton/, 'a first usable round skips nothing');
  assert.match((await call('pk_stage', { to: 'dig' })).text, /not a stage of a First usable round/);
  const r = await call('pk_stage', { to: 'skeleton' });
  assert.equal(r.error, false, r.text);
  assert.deepEqual({ stage: r.json.stage, skill: r.json.skill, round: r.json.round }, { stage: 'skeleton', skill: 'SKILL skeleton', round: { kind: 'First usable', number: 1 } });
  assert.match((await call('pk_stage', { to: 'orientation' })).text, /forward only/, 'no going back');
  const again = await call('pk_stage', { to: 'skeleton' });
  assert.equal(again.json.skill, 'SKILL skeleton', 'the stage it is in gives its skill again');
  await call('pk_stage', { to: 'reconcile' });
  assert.equal((await call('pk_round_state', {})).json.next, 'synthesis', 'after its last stage comes the handover');
  // The handover is required: its three parts, or the call is refused and nothing changes.
  const bare = await call('pk_stage', { to: 'synthesis' });
  assert.ok(bare.error && /needs your handover: the synthesis runs in a session of its own/.test(bare.text) && /Missing: settled, open, first/.test(bare.text), bare.text);
  const partial = await call('pk_stage', { to: 'synthesis', handover: { settled: 'x', open: '  ' } });
  assert.ok(partial.error && /Missing: open, first/.test(partial.text), partial.text);
  assert.equal(store.clerkRounds.get('round_1')!.handover ?? null, null, 'nothing changed');
  assert.equal(store.roundDocs.all().filter((d) => d.kind === 'Handover').length, 0);
  assert.deepEqual(entered, ['skeleton', 'reconcile'], 'the candidates are not recomputed for a refused handover');
  const synth = await call('pk_stage', { to: 'synthesis', handover: HANDOVER });
  assert.equal(synth.error, false, synth.text);
  assert.equal(synth.json.handedOver, true);
  assert.equal(synth.json.skill, undefined, 'the main agent is not given the synthesis\' skill: the synthesis runs in a session of its own');
  assert.match(String(synth.json.note), /entered synthesis/, 'what the planner gives as the round is handed over comes back with it');
  assert.match(String(synth.json.note), /Your work in this round is done and your session writes nothing more/);
  assert.deepEqual(entered, ['skeleton', 'reconcile', 'synthesis']);
  const rd = store.clerkRounds.get('round_1')!;
  assert.equal(rd.stage, 'reconcile', 'the main agent\'s stage stays its last one');
  assert.deepEqual(rd.stageLog!.map((e) => [e.stage, e.endedAt !== null]), [['orientation', true], ['skeleton', true], ['reconcile', true]], 'its stage log ends at its last stage');
  assert.deepEqual(rd.stageLog!.map((e) => e.timing?.wallMs ?? null), [1000, 1000, 1000], 'each stage its own share of the job\'s time');
  // The handover is a round document of its own, with its three parts, written by the main job.
  const doc = store.roundDocs.get(rd.handover!.docId)!;
  assert.equal(doc.kind, 'Handover');
  assert.equal(doc.jobId, 'job_main');
  for (const part of ['## What I settled', HANDOVER.settled, '## What I left open, and why', HANDOVER.open, '## Look at first', HANDOVER.first]) assert.ok(doc.markdown.includes(part), part);
  const state = await call('pk_round_state', {});
  assert.equal(state.json.stage, 'reconcile');
  assert.equal(state.json.next, null);
  assert.equal((state.json.handedOver as { handover: string }).handover, doc.id);
  // Handed over: the stages are over for the main agent, and asking again changes nothing.
  const again2 = await call('pk_stage', { to: 'synthesis', handover: HANDOVER });
  assert.equal(again2.json.handedOver, true);
  assert.match((await call('pk_stage', { to: 'reconcile' })).text, /handed over to the synthesis/);
  assert.equal(store.roundDocs.all().filter((d) => d.kind === 'Handover').length, 1);
});

test('a Follow up skips the skeleton and the dig only with why; a deepening leaves its dig only with a lane for each kind of question, or why', async () => {
  const f = setup('Follow up', 'orientation');
  assert.match((await f.call('pk_stage', { to: 'dig' })).text, /skips skeleton and reconcile: say why/);
  const skipped = await f.call('pk_stage', { to: 'dig', why: 'No document of the chain changed' });
  assert.equal(skipped.error, false, skipped.text);
  assert.equal(f.store.clerkRounds.get('round_1')!.stageLog!.at(-1)!.why, 'No document of the chain changed');

  const d = setup('Deepen', 'dig');
  d.store.roundDocs.put(brief('rdoc_1', "The owner's meaning"));
  d.store.roundDocs.put(brief('rdoc_2', 'The document chain and decisions'));
  const lane = (name: string, briefDocId: string) => ({ name, kind: 'topic' as const, briefDocId, slots: [], jobId: `job_${name}`, stage: 'dig' as const, sentAt: AT, reportDocId: null });
  d.store.clerkRounds.put({ ...d.store.clerkRounds.get('round_1')!, lanes: [lane("The owner's meaning", 'rdoc_1'), lane('The document chain and decisions', 'rdoc_2')] });
  const refused = await d.call('pk_stage', { to: 'coverage' });
  assert.match(refused.text, /no lane of this dig answers “Each work item's process and checks”, “The code as it stands”/);
  d.store.roundDocs.put(brief('rdoc_3', "Each work item's process and checks"));
  d.store.roundDocs.put(brief('rdoc_4', 'The code as it stands'));
  d.store.clerkRounds.put({ ...d.store.clerkRounds.get('round_1')!, lanes: [...d.store.clerkRounds.get('round_1')!.lanes!, lane('plan K', 'rdoc_3'), lane('code', 'rdoc_4')] });
  assert.equal((await d.call('pk_stage', { to: 'coverage' })).error, false, 'a lane answers a kind by its brief\'s name too');

  // A brief names the kind it answers in its first lines, as the skills ask, whatever the lane is called.
  const h = setup('Deepen', 'dig');
  const named = (id: string, first: string): RoundDoc => ({ ...brief(id, id), title: `Lane ${id}`, markdown: `Kind: ${first}\n\nRead plan ${id}.` });
  ["The owner's meaning", 'The document chain and decisions', "Each work item's process and checks", 'The code as it stands'].forEach((k, i) => h.store.roundDocs.put(named(`b${i}`, k)));
  h.store.clerkRounds.put({ ...h.store.clerkRounds.get('round_1')!, lanes: [0, 1, 2, 3].map((i) => lane(`lane ${i}`, `b${i}`)) });
  assert.equal((await h.call('pk_stage', { to: 'coverage' })).error, false, 'the kinds its briefs name in their first lines');

  const w = setup('Deepen', 'dig');
  assert.equal((await w.call('pk_stage', { to: 'coverage', why: 'The project has no code yet' })).error, false, 'or the main agent says why');
});

test('a Full deepening enters the cross-check only once its coverage is settled', async () => {
  let settled = false;
  const { call, store } = setup('Deepen', 'coverage', { coverageSettled: () => settled });
  assert.match((await call('pk_stage', { to: 'cross-check' })).text, /coverage check still lists material/);
  assert.equal(store.clerkRounds.get('round_1')!.stage, 'coverage', 'nothing changed');
  settled = true;
  assert.equal((await call('pk_stage', { to: 'cross-check' })).error, false);
  // A Focused deepening is not held by it.
  const focused = setup('Deepen', 'coverage', { coverageSettled: () => false }, { project: { ...project, takeoverDepth: 'Focused' } as Project });
  assert.equal((await focused.call('pk_stage', { to: 'cross-check' })).error, false);
});

test('only the main job moves through stages and sends lanes', async () => {
  const { call } = setup('First usable', 'orientation', {}, { step: { roundId: 'round_1', kind: 'lane', path: 'x', lane: { kind: 'slot', slots: [] } } });
  assert.match((await call('pk_stage', { to: 'skeleton' })).text, /only the main job/);
});

test('the gate: the main job writes what its stage lists, a lane what its slots list — reference items by category', async () => {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-gate-store-')));
  store.clerkRounds.put(round('First usable', 'orientation'));
  const main = { roundId: 'round_1', kind: 'main' as const, path: null };
  assert.match(writeRefusal(store, main, 'pk_write_reference', { category: 'Goal' }) ?? '', /written in the reconcile or cross-check stage.*this round is in the orientation stage/);
  assert.equal(writeRefusal(store, main, 'pk_write_layers'), null, 'orientation writes the layers');
  assert.equal(writeRefusal(store, main, 'pk_stage'), null, 'moving on is always allowed');
  assert.match(writeRefusal(store, main, 'pk_record_looked') ?? '', /not the main agent's to write in any stage/);
  store.clerkRounds.put(round('First usable', 'reconcile'));
  assert.equal(writeRefusal(store, main, 'pk_write_reference', { category: 'Goal' }), null, 'the reconcile stage writes the trunk');
  assert.match(roundDocRefusal(store, main, 'Result') ?? '', /In the reconcile stage the main agent writes no round document; a Result is written by the synthesis, in a session of its own/);
  assert.match(roundDocRefusal(store, main, 'Handover') ?? '', /The handover is written as you hand the round over: pk_stage\(\{ to: "synthesis", handover/);
  // D103: once handed over, the main agent's session writes nothing more — whatever its last stage listed.
  store.clerkRounds.put({ ...round('First usable', 'reconcile'), handover: { at: AT, docId: 'rdoc_h' } });
  assert.match(writeRefusal(store, main, 'pk_write_reference', { category: 'Goal' }) ?? '', /handed this round over to the synthesis.*writes nothing more/);
  assert.match(roundDocRefusal(store, main, 'Brief') ?? '', /handed this round over to the synthesis/);
  assert.equal(writeRefusal(store, main, 'pk_round_state'), null, 'it can still see where the round stands');
  store.clerkRounds.put(round('First usable', 'reconcile'));

  const lane = { roundId: 'round_1', kind: 'lane' as const, path: 'Goals', lane: { kind: 'slot' as const, slots: ['reference:Goal', 'threads'] as const } };
  assert.equal(writeRefusal(store, lane, 'pk_write_reference', { category: 'Goal' }), null);
  assert.match(writeRefusal(store, lane, 'pk_write_reference', { category: 'Area' }) ?? '', /reference:Area; this lane \(Goals\) writes reference:Goal/);
  assert.equal(writeRefusal(store, lane, 'pk_write_thread', {}), null);
  assert.match(writeRefusal(store, lane, 'pk_link_process', {}) ?? '', /writes the slot links; this lane \(Goals\) writes reference:Goal, threads/);
  assert.equal(writeRefusal(store, lane, 'pk_write_round_doc'), null, 'every lane writes its Report');
  assert.equal(writeRefusal(store, lane, 'pk_fill_from_table', { into: 'threads' }), null);
  assert.match(writeRefusal(store, lane, 'pk_fill_from_table', { into: 'reference', category: 'Decision' }) ?? '', /reference:Decision/);
  assert.match(roundDocRefusal(store, lane, 'Brief') ?? '', /A lane writes its own Report/);

  // Offered whole, refused at call time (E148 D-a): the session's tools are the union, each writer gated.
  const ran: string[] = [];
  const fake = (name: string) => ({ name, execute: async () => { ran.push(name); return { content: [{ type: 'text', text: 'ran' }], details: {} }; } });
  const all = ['pk_read_assets', 'pk_write_reference', 'pk_write_layers', 'pk_stage', 'pk_send_lanes', 'pk_write_note', 'pk_link_process', 'pk_record_looked', 'pk_write_round_doc', 'pk_round_state', 'pk_tag_six', 'pk_write_area', 'pk_confirm_note', 'pk_close_note'].map(fake);
  const gate = (s: typeof main | typeof lane) => (tool: string, args: Record<string, unknown> | null) => writeRefusal(store, s, tool, args);
  const mainTools = stepToolsFor(all, 'main', 'First usable', null, gate(main));
  // D103: the main agent is not offered what only the synthesis writes — the notes, the note results.
  assert.deepEqual(mainTools.map((t) => t.name).sort(), ['pk_link_process', 'pk_read_assets', 'pk_round_state', 'pk_send_lanes', 'pk_stage', 'pk_tag_six', 'pk_write_area', 'pk_write_layers', 'pk_write_reference', 'pk_write_round_doc'].sort(), 'every stage\'s writers, and every read');
  const call = caller(mainTools);
  store.clerkRounds.put(round('First usable', 'orientation'));
  const refused = await call('pk_tag_six', { thing: 1 });
  assert.ok(refused.error && /cross-check stage/.test(refused.text), refused.text);
  // The synthesis job is offered the synthesis' writers and where the round stands, ungated by a stage: no pk_stage, no lanes.
  const synthTools = stepToolsFor(all, 'synthesis', 'First usable', null, null);
  assert.deepEqual(synthTools.map((t) => t.name).sort(), ['pk_close_note', 'pk_confirm_note', 'pk_read_assets', 'pk_round_state', 'pk_tag_six', 'pk_write_area', 'pk_write_note', 'pk_write_round_doc'].sort());
  assert.equal((await call('pk_write_layers', {})).text, 'ran');
  assert.equal((await call('pk_read_assets', {})).text, 'ran', 'reading is never gated');
  const laneTools_ = stepToolsFor(all, 'lane', 'First usable', lane.lane, gate(lane));
  assert.deepEqual(laneTools_.map((t) => t.name).sort(), ['pk_read_assets', 'pk_record_looked', 'pk_write_reference', 'pk_write_round_doc']);
  const lcall = caller(laneTools_);
  assert.ok((await lcall('pk_write_reference', { category: 'Area' })).error);
  assert.equal((await lcall('pk_write_reference', { category: 'Goal' })).text, 'ran');
  assert.deepEqual(ran, ['pk_write_layers', 'pk_read_assets', 'pk_write_reference']);

  // The clerk method's own writers decide by the same effective stage (clerk-tools.ts gate and round-document check).
  const clerk = (step: Parameters<typeof clerkTools>[0]['step']) => caller(clerkTools({ store, project, jobId: 'job_x', jobKind: 'Organizing', model: null, step }));
  store.clerkRounds.put(round('First usable', 'orientation'));
  const asMain = clerk(main);
  assert.match((await asMain('pk_write_round_doc', { kind: 'Result', title: 'r', markdown: 'r' })).text, /In the orientation stage the main agent writes Questions, Brief or History map/);
  assert.equal((await asMain('pk_write_round_doc', { kind: 'Brief', path: 'Goals', title: 'Brief', markdown: 'Answer.' })).error, false);
  assert.match((await asMain('pk_number', { workId: 'x' })).text, /pk_number is written in the reconcile stage of the main agent's session/);
  assert.match((await asMain('pk_record_spot_check', {})).text, /pk_record_spot_check is not the main agent's to write in any stage, so nothing was written\./);
  const asLane = clerk(lane);
  const report = await asLane('pk_write_round_doc', { kind: 'Report', title: 'Goals', markdown: 'Found three goals.' });
  assert.equal(report.error, false, report.text);
  assert.equal(store.roundDocs.get(String(report.json.id))!.path, 'Goals', 'a lane\'s report is filed under its name');
  assert.match((await asLane('pk_write_round_doc', { kind: 'Adoption', title: 'a', markdown: 'a' })).text, /A lane writes its own Report/);
});

// ───────────────────────── pk_send_lanes ─────────────────────────

/** A runtime double: each lane's job goes into the store, and the test says how each run ends. */
function lanesHarness() {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-lanes-store-')));
  // DB: these tests are about how lanes are sent; the slots no lane holds have their reasons on the round already (the
  // slot rule has its own tests, slots.test.ts).
  store.clerkRounds.put({ ...round('First usable', 'skeleton'), emptySlots: SKELETON_SLOTS.map((s) => ({ slot: s.slot, why: 'The fixture has no such material.', at: AT })) });
  for (const n of ['A', 'B', 'C', 'D', 'E']) store.roundDocs.put(brief(`rdoc_${n}`, n));
  store.roundDocs.put(brief('rdoc_other', 'X', 'round_0'));
  const log: string[] = [];
  /** How the next run of each lane ends. */
  const plan = new Map<string, (KeeperJob['status'])[]>();
  let n = 0;
  const finish = (id: string): KeeperJob => {
    const j = store.jobs.get(id)!;
    const name = j.step!.path!;
    const status = plan.get(name)?.shift() ?? 'Done';
    const ended = { ...j, status, endedAt: AT, resultText: status === 'Done' ? `  Summary of ${name}.  ` : null, error: status === 'Failed' ? `${name} broke` : null, resume: null };
    store.jobs.put(ended);
    if (status === 'Done') store.roundDocs.put({ id: `rdoc_report_${name}`, projectId: 'p1', roundId: 'round_1', jobId: id, kind: 'Report', path: name, title: `Report ${name}`, markdown: `Full report of ${name}`, at: AT });
    return ended;
  };
  const runner: LaneRunner = {
    send(request: LaneJobRequest) {
      const j = job(`job_lane_${++n}`, { step: request.step, scope: { ...request.scope }, task: { prompt: request.prompt, extra: request.task } });
      store.jobs.put(j);
      log.push(`send ${request.step.path}`);
      return { job: j, ended: Promise.resolve().then(() => finish(j.id)) };
    },
    async again(jobId) { log.push(`again ${store.jobs.get(jobId)!.step!.path}`); return finish(jobId); },
    async wait(jobId) { log.push(`wait ${store.jobs.get(jobId)!.step!.path}`); return finish(jobId); },
  };
  const ctx: ToolContext = { store, project, jobId: 'job_main', jobKind: 'Organizing', model: null, step: { roundId: 'round_1', kind: 'main', path: null }, lanes: runner };
  return { store, log, plan, call: caller(laneTools(ctx)) };
}
const L = (name: string, slots: string[] = ['threads']) => ({ name, kind: 'slot', briefDocId: `rdoc_${name}`, slots });

test('pk_send_lanes checks every lane first and sends none when one is wrong', async () => {
  const h = lanesHarness();
  const r = await h.call('pk_send_lanes', { lanes: [L('A'), { ...L('B'), briefDocId: 'rdoc_other' }, L('A'), { ...L('C'), slots: ['everything'] }, { ...L('D'), kind: 'sweep' }] });
  assert.equal(r.error, true);
  assert.match(r.text, /lanes\[1\] \(B\): briefDocId rdoc_other is not a Brief of this round/);
  assert.match(r.text, /lanes\[2\] \(A\): the name A is given twice/);
  assert.match(r.text, /lanes\[3\] \(C\): everything is not a slot/);
  assert.match(r.text, /lanes\[4\] \(D\): kind must be one of slot, plan, topic, follow-up/);
  assert.deepEqual(h.log, [], 'nothing was sent');
  assert.deepEqual(h.store.clerkRounds.get('round_1')!.lanes, []);
});

test('pk_send_lanes is idempotent by lane name: sent once, waited for, continued, run again, and Listed after three failures', async () => {
  const h = lanesHarness();
  h.plan.set('C', ['Failed', 'Failed', 'Failed']);
  h.plan.set('B', ['Failed', 'Done']);
  const first = await h.call('pk_send_lanes', { lanes: [L('A', ['reference:Goal', 'threads']), L('B'), L('C')] });
  assert.equal(first.error, false, first.text);
  const out = first.json as unknown as { name: string; status: string; summary: string; reportDocId: string | null; jobId: string }[];
  assert.deepEqual(out.map((l) => [l.name, l.status]), [['A', 'Done'], ['B', 'Done'], ['C', 'Listed']]);
  assert.equal(out[0]!.summary, 'Summary of A.', 'the lane\'s final message, trimmed');
  assert.equal(out[0]!.reportDocId, 'rdoc_report_A');
  assert.match(out[2]!.summary, /Failed 3 times and is listed as not finished: C broke/);
  assert.deepEqual(h.log, ['send A', 'send B', 'send C', 'again B', 'again C', 'again C'], 'a failed lane runs again twice at most');
  const lanes = h.store.clerkRounds.get('round_1')!.lanes!;
  assert.deepEqual(lanes.map((l) => [l.name, l.stage, l.reportDocId]), [['A', 'skeleton', 'rdoc_report_A'], ['B', 'skeleton', 'rdoc_report_B'], ['C', 'skeleton', null]]);
  assert.deepEqual(lanes[0]!.slots, ['reference:Goal', 'threads']);
  assert.equal(h.store.jobs.get(lanes[2]!.jobId)!.task && (h.store.jobs.get(lanes[2]!.jobId)!.task as { extra: { runs: unknown[] } }).extra.runs.length, 2, 'its runs are kept on the job, as the planner keeps a step\'s');

  // Sent again — after a restart, or a turn cut short: nothing is sent twice.
  h.log.length = 0;
  const jobs = h.store.jobs.all().length;
  const d = h.store.jobs.get(lanes[1]!.jobId)!;
  h.store.jobs.put({ ...d, status: 'Stopped', resume: { why: 'restart', since: AT } });   // B was cut short by a restart
  const again = await h.call('pk_send_lanes', { lanes: [L('A'), L('B'), L('C'), L('D')] });
  assert.equal(again.error, false, again.text);
  assert.deepEqual((again.json as unknown as { name: string; status: string }[]).map((l) => [l.name, l.status]), [['A', 'Done'], ['B', 'Done'], ['C', 'Listed'], ['D', 'Done']]);
  assert.deepEqual(h.log, ['again B', 'send D'], 'A done, C listed: returned as they are; B goes on; only D is new');
  assert.equal(h.store.jobs.all().length, jobs + 1);

  // A lane still queued or running is waited for, not sent again.
  h.log.length = 0;
  const e = await h.call('pk_send_lanes', { lanes: [L('E')] });
  assert.equal(e.error, false);
  const eJob = (h.store.clerkRounds.get('round_1')!.lanes!).find((l) => l.name === 'E')!.jobId;
  h.store.jobs.put({ ...h.store.jobs.get(eJob)!, status: 'Running', endedAt: null });
  h.log.length = 0;
  const waited = await h.call('pk_send_lanes', { lanes: [{ ...L('E'), slots: ['links'] }] });
  assert.deepEqual(h.log, ['wait E']);
  assert.match(String((waited.json as unknown as { note?: string }[])[0]!.note), /E was sent already with brief rdoc_E, kind slot and slots threads: a lane is known by its name/);

  const listed = await h.call('pk_lanes', {});
  assert.deepEqual((listed.json.lanes as { name: string; status: string }[]).map((l) => [l.name, l.status]), [['A', 'Done'], ['B', 'Done'], ['C', 'Listed'], ['D', 'Done'], ['E', 'Done']]);
});

test('a lane given generations gets threads with it, and the lane that writes the owner’s words gets the owner’s lines in full (CM)', async () => {
  const h = lanesHarness();
  h.store.drafts.put({
    id: 'draft_s1', projectId: 'p1', session: { host: 'claude', sessionId: 's1', file: 's1.jsonl', startedAt: AT, endedAt: AT },
    ownerLines: [{ ref: '3', at: AT, text: '更早还有两代：Module v0.1–v0.3 与文档链 v1.0', kind: 'Chat', answers: null, confirms: null }],
    agentSummaries: [], roundId: 'round_1', jobId: 'job_draft', at: AT,
  } as never);
  const sent = await h.call('pk_send_lanes', { lanes: [L('A', ['generations']), L('B', ['reference:Owner’s words']), L('C', ['reference:Decision'])] });
  assert.equal(sent.error, false, sent.text);
  const lanes = h.store.clerkRounds.get('round_1')!.lanes!;
  assert.deepEqual(lanes.map((l) => [l.name, l.slots]), [['A', ['generations', 'threads']], ['B', ["reference:Owner's words"]], ['C', ['reference:Decision']]], 'generations brings threads; a typographic apostrophe is the same slot');
  const promptOf = (name: string) => String((h.store.jobs.get(lanes.find((l) => l.name === name)!.jobId)!.task as { prompt: string }).prompt);
  assert.match(promptOf('B'), /=== The owner's lines no position cites yet[\s\S]*更早还有两代：Module v0\.1–v0\.3/, 'the owner’s words lane has the lines verbatim, the Chat one too');
  assert.doesNotMatch(promptOf('C'), /The owner's lines no position cites yet/, 'no other lane carries the list');
  assert.match(promptOf('A'), /generations, threads/);
});
