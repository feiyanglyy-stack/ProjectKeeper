/**
 * The clerk method's rounds end to end against the test double, as D99 and D103 run them (Spec v3.0 §3.3, §3.7; CKC-23
 * AC-1, AC-5, AC-6, AC-8, AC-10, AC-11; CKC-13 AC-19, AC-20; CKC-03 AC-19, AC-28):
 *   - the first usable round runs ledger → session drafts → main → synthesis → process: the main agent is one job in one
 *     session through its stages, and the lanes it sends are jobs of their own under it, each in a session of its own;
 *   - the main agent's session ends with its handover; the synthesis is a job of its own in a fresh session, given the
 *     handover and the round's documents by reference, and writes the notes and the round's Result (D103);
 *   - a deepening's synthesis is given the note the first round left and gives it a result; its spot-check checks it;
 *   - the main job is offered every stage's writers and each lane only its slots' writers, with every read and pi's
 *     built-ins;
 *   - the round closes with what it produced counted by workbench position, each stage and every job with its time;
 *   - after it the depth is the owner's to choose (one note), and with `Full` a deepening's main agent answers the four
 *     kinds of question with lanes, and its cross-check is given the code anomaly candidates; a Follow up's main agent
 *     judges in the round's own record.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slotsUnheld } from './slots.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-pi-agent-'));
const { App } = await import('../../server/app.ts');
const { startFakeProvider, callResults, taskText, FAKE_MODEL } = await import('../fake-provider.ts');
const { isTakeoverWork } = await import('../roles.ts');
const { grantProjectFolder } = await import('../../server/project-folder-api.ts');
const { DEEPENING_PATHS } = await import('./clerk-prompts.ts');

/** The object a Follow up round's main agent judges, and what the judgement tool answered. */
let judgeTarget: string | null = null;
let judged: string | null = null;

type Call = { name: string; args: Record<string, unknown> };
const idOf = (result: string): string | null => /"id": "([^"]+)"/.exec(result)?.[1] ?? null;
const laneOf = (text: string): string | null => /^Task: a lane of this round — (.+?) \(/m.exec(text)?.[1] ?? null;
const roundKindOf = (text: string): string | null => /This is (?:takeover|Follow up) round \d+ \(([A-Za-z ]+)\)/.exec(text)?.[1] ?? null;
const brief = (path: string, text: string): Call => ({ name: 'pk_write_round_doc', args: { kind: 'Brief', path, title: path, markdown: text } });
const result = (text: string): Call => ({ name: 'pk_write_round_doc', args: { kind: 'Result', title: 'Result of the round', markdown: text } });
/** The main agent's handover to the synthesis (D103): its last call. */
const HANDOVER = { settled: 'The Goals and Work lanes are joined: one goal, one area, one work item.', open: 'Nothing is left open.', first: 'The Work lane’s report: the one work item.' };
const handOver = (why?: string): Call => ({ name: 'pk_stage', args: { to: 'synthesis', ...(why ? { why } : {}), handover: HANDOVER } });

/** The main agent: each stage in turn, by what it has done so far in its session. */
function mainAgent(task: string, messages: Parameters<typeof callResults>[0]): Call[] | string {
  const stages = callResults(messages, 'pk_stage').filter((c) => !/^ERROR/.test(c.result)).map((c) => String(c.args.to));
  const sent = callResults(messages, 'pk_send_lanes');
  const briefs = () => callResults(messages, 'pk_write_round_doc').filter((c) => c.args.kind === 'Brief').map((c) => ({ path: String(c.args.path), id: idOf(c.result) }));
  const kind = roundKindOf(task);
  if (kind === 'First usable') {
    if (!stages.length) return [brief('Goals', 'The goals and areas.'), brief('Work', 'The work items.'), { name: 'pk_stage', args: { to: 'skeleton' } }];
    // DB: the slots no lane holds are given with one line each on why the project has nothing for them.
    if (!sent.length) return [{ name: 'pk_send_lanes', args: { lanes: briefs().map((b) => ({ name: b.path, kind: 'slot', briefDocId: b.id, slots: b.path === 'Goals' ? ['reference:Goal', 'reference:Area'] : ['threads'] })), empty: slotsUnheld(['reference:Goal', 'reference:Area', 'threads'], []).map((u) => ({ slot: u.slot, why: 'Demo has one document and nothing of this kind.' })) } }];
    if (!stages.includes('reconcile')) return [{ name: 'pk_stage', args: { to: 'reconcile' } }];
    if (!stages.includes('synthesis')) return [handOver()];
    return 'Handed over to the synthesis.';
  }
  if (kind === 'Deepen') {
    if (!stages.length) return [...DEEPENING_PATHS.map((k) => brief(k, `${k}: answer it for Demo.`)), { name: 'pk_stage', args: { to: 'dig' } }];
    if (!sent.length) return [{ name: 'pk_send_lanes', args: { lanes: briefs().map((b) => ({ name: b.path, kind: 'topic', briefDocId: b.id, slots: [] })) } }];
    if (!stages.includes('coverage')) return [{ name: 'pk_stage', args: { to: 'coverage' } }];
    // The coverage check (Spec §3.3 每份材料都有交代): the fake lanes read nothing, so the main agent accounts for every
    // group the check lists before a Full deepening may enter the cross-check.
    const checks = callResults(messages, 'pk_coverage_check');
    if (!checks.length) return [{ name: 'pk_coverage_check', args: {} }];
    if (!callResults(messages, 'pk_account_material').length) {
      const listed = (JSON.parse(checks[checks.length - 1]!.result) as { untouched: { group: string }[] }).untouched;
      if (listed.length) return listed.map((g) => ({ name: 'pk_account_material', args: { group: g.group, outcome: 'not needed', why: 'A demo of two files: the lanes answered their questions from the workbench' } }));
    }
    if (!stages.includes('cross-check')) return [{ name: 'pk_stage', args: { to: 'cross-check' } }];
    if (!stages.includes('synthesis')) return [handOver()];
    return 'Handed over to the synthesis.';
  }
  // Follow up: nothing to build or dig; the cross-check judges into the round's own record.
  if (!stages.length) return [{ name: 'pk_stage', args: { to: 'cross-check', why: 'Nothing changed since the takeover: no skeleton to build, nothing to dig' } }];
  const judgedCalls = callResults(messages, 'pk_judge_object');
  if (judgeTarget && !judgedCalls.length) return [{ name: 'pk_judge_object', args: { nodeId: judgeTarget, state: 'Reusable as is', sourceOrReason: 'Nothing since the takeover touches it' } }];
  if (judgedCalls.length) judged = judgedCalls[0]!.result;
  if (!stages.includes('synthesis')) return [handOver()];
  return 'Handed over to the synthesis.';
}

/**
 * The synthesis (D103), in its own session: the first usable round's note and Result; the deepening confirms the note the
 * first round left as still holding, then its Result; the Follow up writes its Result and leaves that note without a result.
 */
function synthesisAgent(task: string, messages: Parameters<typeof callResults>[0]): Call[] | string {
  const done = callResults(messages, 'pk_write_round_doc').some((c) => c.args.kind === 'Result' && !/^ERROR/.test(c.result));
  if (done) return 'The round is synthesized.';
  const kind = roundKindOf(task);
  if (kind === 'First usable') return [{ name: 'pk_write_note', args: { mountKind: 'project', mountIds: [], title: 'Where Demo stands', preview: 'Docs exist; nothing verified.', ask: 'For information', currentView: 'The only work documents the demo.', reason: 'synthesis of the round' } }, result('Goals, areas and the one work item are on the workbench.')];
  if (kind === 'Deepen') {
    const standing = /^- (note_[\w-]+) · “Where Demo stands”/m.exec(task)?.[1];
    return [...(standing ? [{ name: 'pk_confirm_note', args: { id: standing, read: ['docs/plan.md: T-1 is still the only work item', 'the Work lane’s report'] } }] : []), result('The four kinds of question are answered.')];
  }
  return [result('Nothing new since the takeover.')];
}

/** A lane: its slots, then its Report, in one turn. */
function lane(name: string): Call[] {
  const report: Call = { name: 'pk_write_round_doc', args: { kind: 'Report', title: `Report: ${name}`, markdown: `What the ${name} lane found.` } };
  if (name === 'Goals') {
    return [
      { name: 'pk_write_reference', args: { category: 'Goal', name: 'Demo goal', text: 'Keep the demo understandable.', basis: 'Inferred', validity: 'Current', identity: 'Interpretation', sourceIds: [] } },
      { name: 'pk_write_reference', args: { category: 'Area', name: 'Docs', ids: ['M1'], text: 'Documentation of the demo.', basis: 'Inferred', validity: 'Current', identity: 'Interpretation', sourceIds: [] } },
      report,
    ];
  }
  if (name === 'Work') return [{ name: 'pk_write_thread', args: { title: 'Demo work', ids: ['T-1'], doing: 'Write the plan', progress: 'Planned' } }, report];
  return [report];
}

const planner: Parameters<typeof startFakeProvider>[0] = (prompt, messages, afterTool) => {
  // The job's own task, also when its session is continued (the continuation is the latest user message).
  const task = taskText(messages) || prompt;
  if (/^Task: the main agent of this round/m.test(task)) return mainAgent(task, messages);
  if (/^Task: the synthesis of this round/m.test(task)) return synthesisAgent(task, messages);
  const name = laneOf(task);
  if (name) return afterTool ? `The ${name} lane wrote its slots and its report.` : lane(name);
  return '';
};

async function until(check: () => boolean, ms = 60_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('a round of the clerk method runs its main agent through its stages and its lanes each in a session of its own, then the synthesis in a session of its own after the handover, and is counted when it closes', { timeout: 240_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-proj-'));
  mkdirSync(join(projectDir, 'docs'));
  writeFileSync(join(projectDir, 'README.md'), '# Demo\n\nA demo project.\n');
  writeFileSync(join(projectDir, 'docs', 'plan.md'), '# Plan\n\n## T-1 Step 1\n\nDo the first thing.\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', projectDir, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'Start the demo');
  const app = new App(home);
  const fake = await startFakeProvider(planner);
  try {
    const project = app.addProject('Demo', [projectDir]);
    await app.intakeProject(project.id);
    app.markTakeoverStarted(project.id, 'First picture only');   // the owner's Start (D105): adding a project starts nothing
    app.stopAll();
    await app.initKeeper();
    app.keeper.models.registerProvider('fake', { name: 'Fake', baseUrl: fake.url, apiKey: 'k', api: 'openai-completions', models: [FAKE_MODEL] });
    app.keeper.setModel({ provider: 'fake', id: FAKE_MODEL.id, thinking: null });
    const store = app.store(project.id);
    // The owner grants the project folder (CKC-26 AC-7, D89).
    grantProjectFolder(app, project.id, { quote: 'Keep a projectkeeper folder in the project and commit only that folder; never push.' });

    await app.organizing.replan(project.id);
    await until(() => store.clerkRounds.find((r) => r.kind === 'First usable' && r.status !== 'Running') !== undefined);

    const round = store.clerkRounds.find((r) => r.kind === 'First usable')!;
    assert.equal(round.status, 'Done', `the first usable round is done: ${store.jobs.all().map((j) => `${j.scope.label}=${j.status}:${j.error ?? ''}`).join('; ')}`);
    const jobs = store.jobs.filter((j) => j.step?.roundId === round.id).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    const steps = jobs.filter((j) => j.step!.kind !== 'lane');
    assert.deepEqual(steps.map((j) => j.step!.kind), ['ledger', 'session-drafts', 'main', 'synthesis', 'process'], 'the steps run in the order of the method');
    assert.ok(steps.every((j) => j.parentJobId === round.rootJobId), 'every step sits under the round in the Keeper view (CKC-23 AC-1)');
    const main = steps.find((j) => j.step!.kind === 'main')!;
    assert.equal(main.status, 'Done', main.error ?? '');
    const lanes = jobs.filter((j) => j.step!.kind === 'lane');
    assert.deepEqual(lanes.map((j) => j.step!.path).sort(), ['Goals', 'Work'], 'the lanes the main agent sent');
    assert.ok(lanes.every((j) => j.parentJobId === main.id && j.status === 'Done'), 'each lane sits under the main agent');
    const synthesis = steps.find((j) => j.step!.kind === 'synthesis')!;
    assert.equal(synthesis.status, 'Done', synthesis.error ?? '');
    assert.equal(synthesis.agent, 'pi', 'the synthesis is a model job of its own');
    const modelJobs = [main, ...lanes, synthesis];
    assert.ok(modelJobs.every((j) => j.sessionFile), 'each has its session');
    assert.equal(new Set(modelJobs.map((j) => j.sessionFile)).size, modelJobs.length, 'the main agent, each lane and the synthesis run in a session of their own (§3.3, CKC-03 AC-28; D103)');
    assert.ok(synthesis.usage.input > 0 && synthesis.timing, 'the synthesis has its own usage and timing');
    assert.ok(jobs.every((j) => j.timing && j.timing.wallMs >= 0), 'every job carries its timing (CKC-23 AC-10)');
    assert.equal(steps.find((j) => j.step!.kind === 'session-drafts')!.agent, 'program', 'with no owner’s words to draft, the step is recorded as having nothing to do');

    // The stages, each with its time (CKC-23 AC-1, AC-10).
    const closed = store.clerkRounds.get(round.id)!;
    assert.equal(closed.stage, 'reconcile', 'the main agent\'s last stage');
    assert.deepEqual(closed.stageLog!.map((e) => e.stage), ['orientation', 'skeleton', 'reconcile'], 'its stage log ends at its last stage (D103)');
    assert.ok(closed.stageLog!.every((e) => e.endedAt && e.timing), 'every stage ended with its time');
    // The handover (D103): a round document of the main job's, with its three parts; the main job ended before the synthesis began.
    const handover = store.roundDocs.get(closed.handover!.docId)!;
    assert.equal(handover.kind, 'Handover');
    assert.equal(handover.jobId, main.id);
    for (const part of [HANDOVER.settled, HANDOVER.open, HANDOVER.first]) assert.ok(handover.markdown.includes(part));
    assert.ok(main.endedAt! <= synthesis.startedAt!, 'the synthesis starts once the main agent\'s session has ended');
    assert.equal(store.roundDocs.find((d) => d.roundId === round.id && d.kind === 'Result')!.jobId, synthesis.id, 'the synthesis wrote the round\'s Result');
    assert.equal(store.traceByJob(main.id, 10_000).filter((e) => e.collection === 'notes').length, 0, 'the main agent wrote no note');
    assert.deepEqual(closed.lanes!.map((l) => [l.name, l.stage, Boolean(l.reportDocId)]), [['Goals', 'skeleton', true], ['Work', 'skeleton', true]]);

    // Tools (§3.3, CKC-23 AC-5; E148 D-a): the built-ins and every read everywhere; the main agent every stage's writers,
    // each lane only its slots'.
    const offered = new Map<string, Set<string>>();
    for (const r of fake.requests) {
      const first = r.messages.find((m) => m.role === 'user');
      const text = !first ? '' : typeof first.content === 'string' ? first.content : ((first.content as { text?: string }[] | null) ?? []).map((part) => part.text ?? '').join(String.fromCharCode(10));
      const who = /^Task: the main agent/m.test(text) ? 'main' : /^Task: the synthesis of this round/m.test(text) ? 'synthesis' : laneOf(text);
      if (who && !offered.has(who)) offered.set(who, new Set(r.tools));
    }
    for (const who of ['main', 'Goals', 'Work', 'synthesis']) {
      const tools = offered.get(who)!;
      assert.ok(tools, `${who} was run`);
      for (const builtin of ['read', 'grep', 'find', 'ls', 'bash']) assert.ok(tools.has(builtin), `${who} has ${builtin}`);
      assert.ok(tools.has('pk_read_assets') && tools.has('pk_read_source'), `${who} can read the assets and the sources`);
    }
    for (const t of ['pk_stage', 'pk_round_state', 'pk_send_lanes', 'pk_write_layers', 'pk_write_reference', 'pk_tag_six']) assert.ok(offered.get('main')!.has(t), `the main agent is offered ${t}`);
    // D103: the notes are the synthesis'; the main agent is not offered them, and the synthesis moves through no stage.
    for (const t of ['pk_write_note', 'pk_close_note', 'pk_confirm_note', 'pk_ask_owner_about_rules']) assert.ok(!offered.get('main')!.has(t), `the main agent is not offered ${t}`);
    for (const t of ['pk_write_note', 'pk_close_note', 'pk_confirm_note', 'pk_tag_six', 'pk_suggest_sendback', 'pk_write_area', 'pk_write_mark', 'pk_write_round_doc', 'pk_round_state', 'pk_investigate']) assert.ok(offered.get('synthesis')!.has(t), `the synthesis is offered ${t}`);
    for (const t of ['pk_stage', 'pk_send_lanes', 'pk_write_reference', 'pk_write_thread', 'pk_link_process', 'pk_confirm', 'pk_write_layers']) assert.ok(!offered.get('synthesis')!.has(t), `the synthesis is not offered ${t}`);
    assert.ok(offered.get('Goals')!.has('pk_write_reference') && !offered.get('Goals')!.has('pk_write_thread'), 'the Goals lane writes reference items, not work items');
    assert.ok(offered.get('Work')!.has('pk_write_thread') && !offered.get('Work')!.has('pk_write_reference'), 'the Work lane writes work items');
    assert.ok(!offered.get('Work')!.has('pk_send_lanes') && !offered.get('Work')!.has('pk_stage'), 'a lane sends no lanes and has no stages');

    // What the round produced, counted by workbench position (CKC-23 AC-6).
    assert.ok(closed.outputs.some((o) => /Product intent/.test(o.position) && o.count === 2), `the goal and the area are counted: ${JSON.stringify(closed.outputs)}`);
    assert.ok(closed.outputs.some((o) => /Work items/.test(o.position) && o.count === 1));
    assert.ok(closed.outputs.some((o) => /Notes/.test(o.position)));
    assert.equal(closed.unplaced.count, 0, `nothing the round wrote served nothing: ${closed.unplaced.reasons.join('; ')}`);
    assert.equal(store.jobs.get(round.rootJobId)!.status, 'Done');

    // Step 0: the program brings the ledger up to date before any judging (§1.16; CKC-22 AC-16).
    const ledgerJob = steps.find((j) => j.step!.kind === 'ledger')!;
    assert.equal(ledgerJob.status, 'Done', ledgerJob.error ?? '');
    assert.ok(closed.ledger && closed.ledger.commitsAdded >= 1, `the ledger took in the project's commits: ${JSON.stringify(closed.ledger)}`);
    // The process step (§2.12) ran the engine, not the placeholder that says it is missing.
    const processJob = steps.find((j) => j.step!.kind === 'process')!;
    assert.equal(processJob.status, 'Done', processJob.error ?? '');
    assert.doesNotMatch(processJob.resultText ?? '', /not available in this build/, `the process engine ran: ${processJob.resultText}`);

    // The project folder (CKC-26 AC-8, D89): committed alone and under the Keeper's name, and never read back as material.
    const gitOut = (...args: string[]) => execFileSync('git', ['-C', projectDir, ...args], { encoding: 'utf8' });
    const last = gitOut('log', '-1', '--format=%an|%s', '--name-only').trim().split(/\r?\n/).filter(Boolean);
    assert.match(last[0]!, /^ProjectKeeper\|ProjectKeeper: /, 'the Keeper commits the folder itself');
    assert.ok(last.slice(1).length > 0 && last.slice(1).every((f) => f.startsWith('projectkeeper/')), `only the folder is in the commit: ${last.join(' ')}`);
    assert.equal(gitOut('status', '--porcelain').trim(), '', 'nothing else in the project changed');
    assert.ok(app.project(project.id).scope.some((i) => i.relation === 'Excluded' && /[\\/]projectkeeper$/.test(i.path)), 'the folder is listed as the Keeper’s own, not the project’s material');
    assert.match(store.jobs.get(round.rootJobId)!.resultText ?? '', /project folder|unplaced$/, 'the round says what it did with the folder, if anything');

    // The synthesis is the product re-look, in a session of its own, recorded (CKC-23 AC-8; D103).
    assert.equal(store.judgements.find((j) => j.jobId === main.id), undefined, 'the main agent has no judgement record');
    const jdg = store.judgements.find((j) => j.jobId === synthesis.id)!;
    assert.ok(jdg && jdg.excluded.length > 0, 'the synthesis says what it was not given');
    assert.ok(jdg.excluded.some((x) => /main agent’s and the lanes’ own sessions/.test(x)), 'among it, the sessions of the round\'s own jobs');
    const note = store.notes.find((n) => n.versions.some((v) => v.judgementRecordId === jdg.id))!;
    assert.ok(note, 'its note is based on that record');
    // `Based on` lists what it received: the lanes' reports and the main agent's handover among it.
    const reports = store.roundDocs.filter((d) => d.roundId === round.id && d.kind === 'Report').map((d) => d.id);
    assert.deepEqual([...(jdg.inputs.roundDocIds ?? [])].sort(), [...reports, handover.id].sort());
    // What the synthesis job was given: the handover in full, the round's documents by id — never the reports' text.
    const synthTask = (synthesis.task as { prompt: string }).prompt;
    assert.match(synthTask, /^Task: the synthesis of this round — its product look-back, in a session of your own\. You were not there for the round/);
    assert.match(synthTask, /# Synthesis: the round's product look-back/, 'its skill heads its task');
    assert.ok(synthTask.includes(`=== The main agent's handover (${handover.id}; written as it left the reconcile stage)`) && synthTask.includes(HANDOVER.first));
    for (const id of reports) assert.ok(synthTask.includes(`report ${id} (`), `the report ${id} by reference`);
    assert.ok(!synthTask.includes('What the Goals lane found.'), 'no report is pasted');
    assert.match(synthTask, /=== What is still open \(the program's counts as you start/);
    assert.match(synthTask, /=== What this round wrote on the workbench so far/);
    assert.match(synthTask, /Breakpoint candidates \(\d+\) — leads, not findings/);
    assert.doesNotMatch(synthTask, /=== Notes still current from earlier rounds/, 'a first usable round has no earlier round');
    assert.equal(closed.standingNotes ?? null, null);

    // The depth was chosen before the start (D105): `First picture only` is done with the first usable round, and no note asks.
    await until(() => store.coverage.takeover?.stage === 'Daily');
    assert.equal(store.coverage.state, 'Takeover complete');
    assert.ok(!store.notes.has('note_takeover-depth'), 'no note asks for the depth (CKC-13 AC-38)');
    assert.equal(store.clerkRounds.size, 1, 'First picture only deepens nothing');

    // CS: a reason that leaves an item unplaced, written before the deepening (the first usable round has no spot-check).
    const anyItem = store.reference.all()[0]!;
    const productItem = store.reference.find((r) => r.category === 'Product');
    store.reference.put({ ...anyItem, id: 'ref_cs_whole', category: 'Decision', name: 'The demo is shown to nobody yet', ids: [], refines: productItem ? [productItem.id] : [], wholeProductWhy: 'It holds for every part of the demo.' });

    // Full, chosen afterwards, goes on from what is done (CKC-13 AC-23): the deepening's main agent answers the four kinds of question with a lane each (CKC-23 AC-4, E148 D-g).
    app.startTakeover(project.id, 'Full');
    await app.organizing.replan(project.id);
    await until(() => store.clerkRounds.find((r) => r.kind === 'Deepen' && r.status !== 'Running') !== undefined);
    const deepen = store.clerkRounds.find((r) => r.kind === 'Deepen')!;
    assert.equal(deepen.status, 'Done');
    const deepSteps = store.jobs.filter((j) => j.step?.roundId === deepen.id && j.step.kind !== 'lane').sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)).map((j) => j.step!.kind);
    assert.deepEqual(deepSteps, ['ledger', 'session-drafts', 'main', 'synthesis', 'spot-check', 'process']);
    assert.deepEqual(store.clerkRounds.get(deepen.id)!.stageLog!.map((e) => e.stage), ['orientation', 'dig', 'coverage', 'cross-check']);
    // E153: the note the first round left is given to the deepening's synthesis, which gives it a result; the round counts
    // it, and its spot-check checks it in full — with what the synthesis wrote and the Result.
    const deepJob = (kind: string) => store.jobs.find((j) => j.step?.roundId === deepen.id && j.step.kind === kind)!;
    const deepSynth = (deepJob('synthesis').task as { prompt: string }).prompt;
    assert.match(deepSynth, /=== Notes still current from earlier rounds \(1\): give each one result/);
    assert.ok(deepSynth.includes(`- ${note.id} · “Where Demo stands” · For information`), 'the standing note with its id, title and ask');
    assert.match(deepSynth, /claims: Docs exist; nothing verified\./);
    const held = store.judgements.find((j) => j.jobId === deepJob('synthesis').id)!.outcome.stillHolds ?? [];
    assert.deepEqual(held.map((x) => [x.noteId, x.read.length]), [[note.id, 2]], 'still holds, with what was read, in the judgement record');
    assert.equal(store.notes.get(note.id)!.versions.length, 1, 'and no new version of the note');
    assert.deepEqual(store.clerkRounds.get(deepen.id)!.standingNotes, { standing: 1, confirmed: 1, updated: 0, withdrawn: 0, open: 0 });
    const spotTask = (deepJob('spot-check').task as { prompt: string }).prompt;
    assert.match(spotTask, /=== Checked in full, not sampled \(\d+\)/);
    assert.ok(spotTask.includes(`- notes ${note.id}: note “Where Demo stands” (For information) — standing from an earlier round, confirmed as still holding this round`), 'the standing note is a target of the spot-check');
    assert.ok(spotTask.includes(`- roundDocs ${store.roundDocs.find((d) => d.roundId === deepen.id && d.kind === 'Result')!.id}: the round's Result`), 'and so is the Result');
    // CS: the reason written before this round is checked in full too, and fixed on the round as the spot-check starts.
    assert.ok(spotTask.includes('- reference ref_cs_whole: Decision The demo is shown to nobody yet written on the whole product — “It holds for every part of the demo.”'), 'the earlier reason is a target of the spot-check');
    assert.match(spotTask, /every reason that leaves an item unplaced and that no spot-check has checked yet, whichever round wrote it \(\d+ in all, 1 of them such reasons\)/);
    const checkedRound = store.clerkRounds.get(deepen.id)!;
    assert.deepEqual(checkedRound.placementCheck?.reasons, [{ collection: 'reference', id: 'ref_cs_whole', field: 'wholeProductWhy', reason: 'It holds for every part of the demo.' }]);
    assert.deepEqual(store.clerkRounds.get(deepen.id)!.lanes!.map((l) => l.name), [...DEEPENING_PATHS]);
    assert.equal(store.clerkRounds.get(deepen.id)!.sweepsAdded ?? undefined, undefined, 'the program composes no sweeps any more');
    // The cross-check is given the program's code anomaly candidates to judge as it enters it (§2.13 row 6; CKC-25 AC-4).
    const crossCheck = fake.requests.flatMap((r) => callResults(r.messages, 'pk_stage')).find((c) => c.args.to === 'cross-check' && /Code anomaly candidates/.test(c.result));
    assert.ok(crossCheck, 'the cross-check is given the code anomaly candidates');
    assert.match(crossCheck.result, /The lanes' reports/, 'and the lanes\' reports');
    await until(() => store.coverage.state === 'Takeover complete');
    assert.equal(store.coverage.takeover?.stage, 'Daily');

    // Taking the project over is no Follow up round, and opens none (§5.5, D59 rule 1).
    assert.ok(isTakeoverWork(store, main.id), 'a takeover round’s main agent is takeover work');
    assert.ok(isTakeoverWork(store, lanes[0]!.id), 'and so is its lane');
    assert.equal(store.rounds.size, 0, 'the takeover opened no Follow up record');

    // Follow up (§3.8, §5.5): the round opens its record when it begins, its main agent judges into that record in its
    // cross-check, and the record's one result is counted from the assets when the round closes.
    judgeTarget = store.threads.all()[0]!.id;
    app.followUp(project.id);
    await until(() => store.clerkRounds.find((r) => r.kind === 'Follow up' && r.status !== 'Running') !== undefined);
    const followUp = store.clerkRounds.find((r) => r.kind === 'Follow up')!;
    assert.equal(followUp.status, 'Done', `the Follow up round is done: ${store.jobs.filter((j) => j.step?.roundId === followUp.id).map((j) => `${j.scope.label}=${j.status}:${j.error ?? ''}`).join('; ')}`);
    const followSteps = store.jobs.filter((j) => j.step?.roundId === followUp.id).map((j) => j.step!.kind);
    for (const s of ['ledger', 'main', 'synthesis', 'spot-check', 'process'] as const) assert.ok(followSteps.includes(s), `the Follow up round ran ${s}`);
    assert.deepEqual(store.clerkRounds.get(followUp.id)!.stageLog!.map((e) => e.stage), ['orientation', 'cross-check'], 'it skipped what it said why for');
    // Its synthesis gave the standing note no result: the round says so (E153).
    assert.deepEqual(store.clerkRounds.get(followUp.id)!.standingNotes, { standing: 1, confirmed: 0, updated: 0, withdrawn: 0, open: 1 });
    assert.ok(!isTakeoverWork(store, store.jobs.find((j) => j.step?.roundId === followUp.id && j.step.kind === 'main')!.id), 'a Follow up job is not takeover work');
    const record = store.rounds.get(followUp.followUpRoundId!)!;
    assert.ok(record, 'the round opened its Follow up record');
    assert.equal(record.mainJobId, followUp.rootJobId);
    assert.ok(judged && judged.includes(record.id), `the cross-check judged in the round's own record, not refused: ${judged}`);
    assert.ok(record.endedAt && record.result, 'the record closes with the round');
    assert.equal(record.result!.counts.objectsJudged, 0, 'nothing reached the object, so nothing was written; the count is the program’s');
  } finally {
    fake.close();
    app.stopAll();
  }
});
