/**
 * A round runs through (Spec §3.10; owner D97; BJ; D99): live against the fake provider, through App and pi, with a
 * provider in front of it that refuses, withholds, rate-limits or answers "quota" for the requests a test picks. The
 * main agent and its lanes are a scripted clerk (testing/clerk-script.ts). No real model, no network.
 *
 * - The main agent's job that fails is run again by the program in its own session, told which stage it stopped at, and
 *   the round finishes; one that keeps failing is listed after RUN_AGAIN_LIMIT runs again — on the round, in the
 *   coverage's failure list, in the root job's result — and the round goes on and closes `Done`. The owner's Retry runs it
 *   again.
 * - The lanes run at the same time, on every key: one a key rate-limits goes on in its own session on another. A lane
 *   that keeps failing comes back to the main agent Listed; the coverage check lists what no lane read, the main agent
 *   accounts for it, and the cross-check starts.
 * - A program step (the ledger) runs again by itself, and from Retry once it is listed.
 * - The owner's Stop reaches the whole tree and waits for the owner; a pause stops the tree to go on, and resuming does.
 * - After a restart the round under way goes on: the main agent and its lanes in their own sessions, uncounted, and a
 *   main agent left waiting for quota is queued again.
 * - The synthesis (D103) is a job of its own after the main agent's handover: one that fails runs again in its own
 *   session, told what is left; a rate limit, a pause and a restart each resume its own session, and what it wrote
 *   before is not written twice. The spot-check that fails runs again in its own session too.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The scratch lives in the system's temp directory, not the worktree (as ay-live-takeover.test.ts).
const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-run-through-'));
process.env.PI_CODING_AGENT_DIR = join(scratch, 'pi-agent');
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
// pi retries a 429 itself; here every limit reaches the runtime at once (as lanes-keys.test.ts).
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
after(() => { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const { App } = await import('../../server/app.ts');
const { startFakeProvider, callResults, taskText, FAKE_MODEL } = await import('../fake-provider.ts');
const { clerkPlanner, jobOf, laneNameOf } = await import('../testing/clerk-script.ts');
const { registerRoutes } = await import('../../server/api.ts');
const { ProjectStore } = await import('../../store/project-store.ts');
const { RUN_AGAIN_LIMIT, runsOf, stepEnding, stepFailureText, withEarlierRuns } = await import('./clerk.ts');
import type { KeeperJob } from '../../model/types.ts';
import type { ClerkRound, RoundKind } from '../../model/k-types.ts';
import type { ScriptedLane } from '../testing/clerk-script.ts';

type AppT = InstanceType<typeof App>;
type Msg = { role: string; content: unknown };

// ───────────────────────── the fixture project ─────────────────────────

const ENV = { GIT_AUTHOR_NAME: 'Orchard Dev', GIT_AUTHOR_EMAIL: 'dev@orchard.invalid', GIT_COMMITTER_NAME: 'Orchard Dev', GIT_COMMITTER_EMAIL: 'dev@orchard.invalid' };
const projectDir = mkdtempSync(join(scratch, 'project-'));
const git = (args: string[], date: string) => execFileSync('git', ['--no-optional-locks', '-C', projectDir, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel: string, text: string) => { mkdirSync(join(projectDir, rel, '..'), { recursive: true }); writeFileSync(join(projectDir, rel), text); };
git(['init', '-q', '-b', 'main'], '2026-09-01T09:00:00+00:00');
write('README.md', '# Orchard\n\nPicks apples.\n');
write('docs/PRODUCT.md', '# Orchard product\n\n## What it is\n\nA basket.\n');
write('docs/plan.md', '# Plan\n\n## T-1 Hand picking\n\nPick by hand.\n');
write('src/main.ts', 'import { pick } from "./util";\nexport const main = () => pick();\n');
write('src/util.ts', 'export const pick = () => 1;\n');
git(['add', '-A'], '2026-09-01T09:00:00+00:00');
git(['commit', '-q', '-m', 'Start the orchard'], '2026-09-01T09:00:00+00:00');

// ───────────────────────── the scripted clerk ─────────────────────────

/** The first usable round's two lanes, and a deepening's lane for each kind of question (E148 D-g). */
const SCRIPT_FIRST: readonly ScriptedLane[] = [
  { name: 'Goals', kind: 'slot', slots: ['reference:Goal'], brief: '# Brief: Goals\n\nThe goals the README and docs/PRODUCT.md state.' },
  { name: 'Work', kind: 'slot', slots: ['threads'], brief: '# Brief: Work\n\nThe work items docs/plan.md names.' },
];
const SCRIPT_DEEPEN: readonly ScriptedLane[] = [
  { name: "The owner's meaning", kind: 'topic', slots: [], brief: "# Brief\n\nThe owner's meaning: read README.md." },
  { name: 'The document chain and decisions', kind: 'topic', slots: [], brief: '# Brief\n\nThe document chain and decisions: read docs/PRODUCT.md and docs/plan.md.' },
  { name: "Each work item's process and checks", kind: 'plan', slots: [], brief: "# Brief\n\nEach work item's process and checks: read docs/plan.md." },
  { name: 'The code as it stands', kind: 'topic', slots: ['territories'], brief: '# Brief\n\nThe code as it stands: read src/main.ts and src/util.ts.' },
];
const planner = clerkPlanner({
  lanes: (round: RoundKind) => (round === 'First usable' ? SCRIPT_FIRST : round === 'Deepen' ? SCRIPT_DEEPEN : []),
  laneWork: (name) => {
    if (name === 'Goals') return [{ name: 'pk_write_reference', args: { category: 'Goal', name: 'Fresh apples', text: 'Apples picked and delivered fresh.', basis: 'Inferred', validity: 'Current', identity: 'Interpretation', sourceIds: [] } }];
    if (name === 'Work') return [{ name: 'pk_write_thread', args: { title: 'Hand picking', ids: ['T-1'], doing: 'Pick by hand', serves: [], progress: 'Planned' } }];
    const path = /read (\S+?\.md)/.exec(SCRIPT_DEEPEN.find((l) => l.name === name)?.brief ?? '')?.[1];
    return path ? [{ name: 'read', args: { path } }] : [];
  },
  stageWork: (_round, stage) => (stage === 'synthesis' ? [{ name: 'pk_write_note', args: { mountKind: 'project', mountIds: [], title: 'Where Orchard stands', preview: 'A basket, picked by hand.', ask: 'For information', currentView: 'Hand picking is the only work.', reason: 'synthesis of the round' } }] : []),
});

/** A tool's calls that did not fail, in a request's messages. */
const succeededCalls = (messages: readonly Msg[], tool: string) => callResults(messages as never, tool).filter((c) => !/^(?:ERROR|No result provided)/.test(c.result));
const textOf = (m: Msg): string => (typeof m.content === 'string' ? m.content : ((m.content as { text?: string }[] | null) ?? []).map((p) => p.text ?? '').join('\n'));
/** Whether a continued session was told why its last run ended (the refusal). */
const toldWhy = (messages: readonly Msg[]) => messages.some((m) => m.role === 'user' && textOf(m).includes('Why your last run ended:') && textOf(m).includes(REFUSAL));
/** Whether the main agent's lanes have come back in this session. */
const sentLanes = (messages: readonly Msg[]) => succeededCalls(messages, 'pk_send_lanes').length > 0;

// ───────────────────────── a provider in front of the fake ─────────────────────────

type Answer = 'pass' | 'refuse' | 'quota' | 'withhold' | 'limit' | 'slow';
const REFUSAL = 'The provider refuses this request (test)';

/**
 * Passes each request on to the fake, or answers it as `decide` says: a 400 refusal (the job fails), a 429 quota error
 * (the job waits for quota), a 429 rate limit (the key rests and the job goes on on another), nothing at all (the job
 * runs until it is stopped), or the fake's answer after a while (`slow`, so lanes overlap). It serves two keys: `fake`
 * at `/v1` and `fake-b` at `/b/v1`. Every request is kept with its job, its task and what was sent.
 */
async function frontProvider(decide: (job: string | null, task: string, messages: readonly Msg[], provider: string) => Answer) {
  const fake = await startFakeProvider(planner);
  const sockets = new Set<Socket>();
  const requests: { job: string | null; task: string; sent: string; messages: Msg[]; provider: string; answer: Answer }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body) as { messages: Msg[] };
      const task = taskText(json.messages as never);
      const job = jobOf(task).kind;
      const provider = (req.url ?? '').startsWith('/b/') ? 'fake-b' : 'fake';
      const answer = decide(job, task, json.messages, provider);
      requests.push({ job, task, sent: JSON.stringify(json.messages), messages: json.messages, provider, answer });
      if (answer === 'withhold') return;
      if (answer === 'refuse' || answer === 'quota' || answer === 'limit') {
        res.writeHead(answer === 'refuse' ? 400 : 429, { 'content-type': 'application/json', 'x-should-retry': 'false' });
        const error = answer === 'refuse' ? { message: REFUSAL, type: 'invalid_request_error' }
          : answer === 'quota' ? { message: 'insufficient_quota: You exceeded your current quota', type: 'insufficient_quota' }
            : { code: '1302', message: '您的账户已达到速率限制，请您控制请求频率' };
        res.end(JSON.stringify({ error }));
        return;
      }
      const pass = () => void fetch(`${fake.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then(async (r) => {
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'text/event-stream' });
        res.end(await r.text());
      }, () => res.destroy());
      if (answer === 'slow') setTimeout(pass, 800).unref(); else pass();
    });
  });
  server.on('connection', (s: Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { url, requests, close() { for (const s of sockets) s.destroy(); server.close(); fake.close(); } };
}

// ───────────────────────── helpers ─────────────────────────

async function until(check: () => boolean, ms = 120_000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * An App on `home` with the provider at `url`. `fresh`: add the fixture project and read it; else the home has it (a
 * restart). `setup` runs before anything can plan a round (intake plans one as soon as it has read the project). `keys`:
 * 2 registers the front provider's second key as a backup.
 */
async function startApp(home: string, url: string, options: { readonly fresh?: boolean; readonly setup?: (app: AppT) => void; readonly keys?: 1 | 2 } = {}): Promise<{ app: AppT; projectId: string }> {
  const app = new App(home);
  options.setup?.(app);
  let projectId: string;
  if (options.fresh !== false) {
    const project = app.addProject('Orchard', [projectDir]);
    await app.intakeProject(project.id);
    app.markTakeoverStarted(project.id, 'First picture only');   // the owner's Start (D105): adding a project starts nothing
    app.stopAll();
    projectId = project.id;
  } else {
    projectId = app.workspace.list()[0]!.id;
  }
  await app.initKeeper();
  app.keeper.models.registerProvider('fake', { name: 'Fake', baseUrl: url, apiKey: 'k', api: 'openai-completions', models: [FAKE_MODEL] });
  if (options.keys === 2) {
    app.keeper.models.registerProvider('fake-b', { name: 'Fake B', baseUrl: url.replace(/\/v1$/, '/b/v1'), apiKey: 'k', api: 'openai-completions', models: [FAKE_MODEL] });
    app.keeper.setModel({ provider: 'fake', id: FAKE_MODEL.id, thinking: null }, [{ provider: 'fake-b', id: FAKE_MODEL.id, thinking: null }]);
    await app.keeper.providerState();
  } else {
    app.keeper.setModel({ provider: 'fake', id: FAKE_MODEL.id, thinking: null });
  }
  // The provider is registered after the runtime started, unlike a real one, which pi has from the start: a step queued
  // before it (intake plans the first round at once) may have been looked at while there was no key. Setting the lanes
  // looks at the queue again.
  app.keeper.setLanesPerKey(app.keeper.lanesPerKey);
  return { app, projectId };
}

async function stopApp(app: AppT): Promise<void> {
  app.stopAll();
  // Let the last replans settle and their writes land before the scratch directory is removed.
  await new Promise((r) => setTimeout(r, 400));
  await app.flushAll();
}

function route(app: AppT, method: string, path: string) {
  const handlers = new Map<string, (ctx: unknown) => unknown>();
  registerRoutes({ route: (m: string, p: string, h: (ctx: unknown) => unknown) => handlers.set(`${m} ${p}`, h), static: () => undefined } as never, app, '', '');
  const handler = handlers.get(`${method} ${path}`);
  assert.ok(handler, `${method} ${path}`);
  return (params: Record<string, string>) => handler({ params, query: new URLSearchParams(), body: null }) as { ok: boolean };
}

const closedRound = (app: AppT, projectId: string, kind: ClerkRound['kind']) => app.store(projectId).clerkRounds.find((r) => r.kind === kind && r.status !== 'Running');
const stepJobs = (app: AppT, projectId: string, roundId: string, step: string) => app.store(projectId).jobs.filter((j) => j.step?.roundId === roundId && j.step.kind === step);
const describeJobs = (app: AppT, projectId: string, roundId: string) => app.store(projectId).jobs.filter((j) => j.step?.roundId === roundId).map((j) => `${j.scope.label}=${j.status}:${j.error ?? ''}`).join('; ');
const projectFailed = (app: AppT, projectId: string) => app.store(projectId).coverage.scopes.find((s) => s.id === 'project')?.failed ?? [];

// ───────────────────────── the rule ─────────────────────────

test('the rule: a failed job runs again twice, a restart does not count, the owner’s Stop holds, the time limit lists, the owner’s run again starts the count afresh', () => {
  const home = mkdtempSync(join(scratch, 'rule-'));
  const store = ProjectStore.open('p1', home);
  const at = '2026-09-28T16:00:00.000Z';
  store.clerkRounds.put({ id: 'crd_1', projectId: 'p1', kind: 'First usable', number: 1, startedAt: at, endedAt: null, status: 'Running', rootJobId: 'job_root', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: at });
  const job = (over: Partial<KeeperJob>): KeeperJob => ({
    id: 'job_s', projectId: 'p1', kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['crd_1'], label: 'Skeleton' }, status: 'Failed', queuedAt: at, startedAt: at, endedAt: at,
    savedResults: [{ collection: 'threads', id: 'thread_1', label: 'Hand picking' }], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null,
    steps: [], error: 'Ended after the model sent a call to pk_write_thread that was refused the same way 8 times in a row', requestBasis: null, parentJobId: 'job_root', resultText: null, priority: 1,
    task: { prompt: 'Task: skeleton', extra: { kind: 'clerk-step', roundId: 'crd_1' } }, step: { roundId: 'crd_1', kind: 'skeleton', path: null }, ...over,
  });
  const run = (again: 'program' | 'owner', counted: boolean) => ({ endedAt: at, status: 'Failed' as const, reason: 'x', usage: null, again, at, counted });
  const withRuns = (runs: unknown[], over: Partial<KeeperJob> = {}) => job({ task: { prompt: 'Task: skeleton', extra: { kind: 'clerk-step', roundId: 'crd_1', runs } }, ...over });

  assert.equal(RUN_AGAIN_LIMIT, 2, 'the program runs a job again twice: three runs in all');
  assert.equal(stepEnding(store, job({ status: 'Done' })).kind, 'done');
  assert.equal(stepEnding(store, job({ status: 'Running' })).kind, 'active');
  assert.equal(stepEnding(store, job({ status: 'Waiting for quota' })).kind, 'active', 'waiting for quota is not a failure');
  assert.deepEqual(stepEnding(store, job({})), { kind: 'again', reason: job({}).error, counted: true }, 'a first failure runs again');
  assert.equal(stepEnding(store, withRuns([run('program', true)])).kind, 'again', 'a second one too');
  assert.deepEqual(stepEnding(store, withRuns([run('program', true), run('program', true)])), { kind: 'listed', reason: job({}).error, runs: 3 }, 'the third failure is listed');
  assert.equal(stepEnding(store, withRuns([run('program', true), run('program', false), run('program', true)])).kind, 'listed', 'a run a restart cut short is not counted, but the others are');
  assert.equal(stepEnding(store, withRuns([run('program', true), run('program', true), run('owner', false)])).kind, 'again', 'the owner’s Retry starts the count afresh');
  assert.deepEqual(stepEnding(store, job({ status: 'Stopped', error: 'ProjectKeeper restarted while this work was running' })), { kind: 'again', reason: 'ProjectKeeper restarted while this work was running', counted: false }, 'a restart’s stop goes on, uncounted');
  assert.equal(stepEnding(store, job({ status: 'Stopped', error: null })).kind, 'owner', 'the owner’s Stop holds the round');
  assert.equal(stepEnding(store, job({ status: 'Stopped', error: 'Stopped at its time limit' })).kind, 'listed', 'the time limit lists it at once');
  assert.equal(stepEnding(store, job({ agent: 'program', task: { prompt: '', extra: { kind: 'clerk-step', roundId: 'crd_1' } }, step: { roundId: 'crd_1', kind: 'ledger', path: null } })).kind, 'again', 'the ledger runs again: the program’s own step');
  // What the coverage's failure list says of each.
  assert.equal(stepFailureText(store, job({})), `Skeleton: failed — ${job({}).error}. The program runs it again`);
  assert.equal(stepFailureText(store, job({}), true), `Skeleton: failed — ${job({}).error}. The program runs it again once organizing resumes`, 'while organizing is paused it waits');
  assert.equal(stepFailureText(store, withRuns([run('program', true), run('program', true)])), `Skeleton: failed 3 times — ${job({}).error}. Listed: the round went on without it; Retry runs it again`);
  assert.equal(stepFailureText(store, job({ status: 'Stopped', error: null })), 'Skeleton: stopped by you — the round waits until you Continue it');
  assert.equal(stepFailureText(store, job({ status: 'Stopped', error: 'Stopped at its time limit' })), 'Skeleton: was stopped — Stopped at its time limit. Listed: the round went on without it; Continue runs it again');

  store.clerkRounds.put({ ...store.clerkRounds.get('crd_1')!, status: 'Done', endedAt: at });
  assert.equal(stepEnding(store, job({})).kind, 'listed', 'once the round has closed nothing of it runs again by itself');
  assert.equal(stepEnding(store, job({ status: 'Stopped', error: null })).kind, 'listed');

  const prompt = withEarlierRuns('Task: skeleton\n\nDo it.', job({}), [{ ...run('program', true), reason: 'the refusal' }]);
  assert.match(prompt, /^Task: skeleton\n\nDo it\.\n\n=== This job ran before and did not finish — this is run 2\n1\. 2026-09-28 16:00 UTC — failed: the refusal\n/);
  assert.match(prompt, /What its earlier runs saved stays where it was saved \(1\):\n- threads thread_1: Hand picking/);
  const again = withEarlierRuns(prompt, job({}), [{ ...run('program', true), reason: 'the refusal' }, { ...run('program', true), reason: 'the second' }]);
  assert.equal(again.split('=== This job ran before').length, 2, 'the block is written afresh, never stacked');
  assert.match(again, /this is run 3\n1\. .*the refusal\n2\. .*the second/);
  assert.equal(runsOf(job({})).length, 0);
});

// ───────────────────────── the main agent ─────────────────────────

test('a main agent whose session fails once runs again in its own session, told where it stopped, and the round finishes', { timeout: 300_000 }, async () => {
  let refused = 0;
  // Its first request after its lanes came back is refused: it stops in its skeleton stage.
  const front = await frontProvider((job, _task, messages) => (job === 'main' && sentLanes(messages) && refused++ === 0 ? 'refuse' : 'pass'));
  const { app, projectId } = await startApp(mkdtempSync(join(scratch, 'home-once-')), front.url);
  try {
    const store = app.store(projectId);
    await app.organizing.replan(projectId);
    await until(() => closedRound(app, projectId, 'First usable') !== undefined, 180_000, 'the first usable round');
    const round = closedRound(app, projectId, 'First usable')!;
    assert.equal(round.status, 'Done', describeJobs(app, projectId, round.id));
    assert.deepEqual(round.failures ?? [], [], 'nothing is listed: the main agent finished on its second run');

    const [main, ...others] = stepJobs(app, projectId, round.id, 'main');
    assert.equal(others.length, 0, 'the same job ran again, not a new one');
    assert.equal(main!.status, 'Done', main!.error ?? '');
    const runs = runsOf(main!);
    assert.deepEqual(runs.map((r) => [r.status, r.again, r.counted]), [['Failed', 'program', true]]);
    assert.match(runs[0]!.reason, new RegExp(REFUSAL.replace(/[()]/g, '\\$&')), 'with why it ended');
    // It went on in its own session, told which stage it had stopped at, and sent no lane twice.
    const continued = front.requests.filter((r) => r.job === 'main' && /You stopped in the skeleton stage of this First usable round/.test(r.sent));
    assert.ok(continued.length >= 1, 'the continued session was told where it stopped');
    assert.match(continued[0]!.sent, /This work ended before its task was done, and the program runs it again/);
    assert.ok(toldWhy(continued[0]!.messages), 'and why its last run ended');
    assert.deepEqual(stepJobs(app, projectId, round.id, 'lane').map((j) => j.step!.path).sort(), ['Goals', 'Work'], 'no lane sent twice');
    assert.deepEqual(store.clerkRounds.get(round.id)!.stageLog!.map((e) => e.stage), ['orientation', 'skeleton', 'reconcile']);
    assert.ok(store.clerkRounds.get(round.id)!.handover, 'it handed the round over to the synthesis');
    assert.equal(stepJobs(app, projectId, round.id, 'synthesis')[0]!.status, 'Done', 'and the synthesis ran after it');
    assert.ok(store.threads.find((t) => t.title === 'Hand picking'), 'the Work lane did its work');
    assert.equal(projectFailed(app, projectId).filter((f) => store.jobs.has(f.ref)).length, 0, 'nothing is in the coverage’s failure list');
  } finally { front.close(); await stopApp(app); }
});

test('a main agent that keeps failing is listed, the round goes on with what was saved and closes Done with it listed; Retry runs it again', { timeout: 300_000 }, async () => {
  let refuse = true;
  const front = await frontProvider((job) => (job === 'main' && refuse ? 'refuse' : 'pass'));
  const { app, projectId } = await startApp(mkdtempSync(join(scratch, 'home-keeps-')), front.url);
  try {
    const store = app.store(projectId);
    await app.organizing.replan(projectId);
    await until(() => closedRound(app, projectId, 'First usable') !== undefined, 180_000, 'the first usable round');
    const round = closedRound(app, projectId, 'First usable')!;
    assert.equal(round.status, 'Done', `the round ran through: ${describeJobs(app, projectId, round.id)}`);

    const main = stepJobs(app, projectId, round.id, 'main');
    assert.equal(main.length, 1, 'one job, run three times');
    assert.equal(main[0]!.status, 'Failed');
    assert.deepEqual(runsOf(main[0]!).map((r) => [r.again, r.counted]), [['program', true], ['program', true]], `run again twice by the program: ${JSON.stringify(runsOf(main[0]!))}`);
    assert.equal(front.requests.filter((r) => r.job === 'main').length, RUN_AGAIN_LIMIT + 1, 'three runs, then no more');

    // On the round, in its root job's result, in the coverage.
    assert.equal(round.failures?.length, 1, JSON.stringify(round.failures));
    const f = round.failures![0]!;
    assert.deepEqual([f.jobId, f.step, f.status, f.runs], [main[0]!.id, 'main', 'Failed', 3]);
    assert.ok(f.reason.includes(REFUSAL), f.reason);
    assert.match(store.jobs.get(round.rootJobId)!.resultText ?? '', /1 job did not finish and is listed: Main agent \(failed 3 times: /);
    assert.equal(store.jobs.get(round.rootJobId)!.status, 'Done');
    assert.ok(store.traceByJob(round.rootJobId, 500).some((e) => /Main agent failed 3 times .* — listed; the round goes on without it/.test(e.summary)), 'the trace says when it was listed');
    await until(() => projectFailed(app, projectId).some((x) => x.ref === main[0]!.id), 30_000, 'the coverage’s failure list');
    assert.match(projectFailed(app, projectId).find((x) => x.ref === main[0]!.id)!.reason, /^Main agent: failed 3 times — .*\. Listed: First usable round 1 closed without it; Retry runs it again$/);
    // The round went on with what was saved: the process ran. A round that ran through is one later rounds build on.
    assert.ok(stepJobs(app, projectId, round.id, 'process').every((j) => j.status === 'Done'), 'the process ran');
    await until(() => store.coverage.takeover?.stage === 'Daily', 30_000, 'the takeover done at First picture only');

    // The owner's Retry runs it again, in its own session; once it ends it leaves the failure list.
    refuse = false;
    assert.equal(route(app, 'POST', '/api/projects/:id/keeper/jobs/:jobId/retry')({ id: projectId, jobId: main[0]!.id }).ok, true);
    await until(() => store.jobs.get(main[0]!.id)!.status === 'Done', 60_000, 'the retried main agent');
    assert.deepEqual(runsOf(store.jobs.get(main[0]!.id)!).map((r) => r.again), ['program', 'program', 'owner']);
    assert.ok(front.requests.some((r) => r.job === 'main' && toldWhy(r.messages)), 'the fourth run, in its own session, was told why the last one ended');
    await app.organizing.replan(projectId);
    await until(() => !projectFailed(app, projectId).some((x) => x.ref === main[0]!.id), 30_000, 'the failure leaving the list');
    assert.equal(store.clerkRounds.get(round.id)!.failures?.length, 1, 'the round keeps what did not finish when it closed');
  } finally { front.close(); await stopApp(app); }
});

// ───────────────────────── the lanes ─────────────────────────

test('a lane that keeps failing comes back Listed; the coverage check lists what no lane read, the main agent accounts for it, and the cross-check starts', { timeout: 600_000 }, async () => {
  const front = await frontProvider((job, task) => (job === 'lane' && laneNameOf(task) === 'The code as it stands' ? 'refuse' : 'pass'));
  const { app, projectId } = await startApp(mkdtempSync(join(scratch, 'home-lane-')), front.url);
  try {
    const store = app.store(projectId);
    await app.organizing.replan(projectId);
    await until(() => closedRound(app, projectId, 'First usable') !== undefined, 180_000, 'the first usable round');
    app.startTakeover(projectId, 'Full');
    await app.organizing.replan(projectId);
    await until(() => closedRound(app, projectId, 'Deepen') !== undefined, 300_000, 'the deepening');
    const deepen = closedRound(app, projectId, 'Deepen')!;
    assert.equal(deepen.status, 'Done', describeJobs(app, projectId, deepen.id));

    const code = stepJobs(app, projectId, deepen.id, 'lane').find((j) => j.step!.path === 'The code as it stands')!;
    assert.equal(code.status, 'Failed');
    assert.deepEqual(runsOf(code).map((r) => [r.again, r.counted]), [['program', true], ['program', true]], 'the main agent’s pk_send_lanes ran it again twice');
    assert.equal(front.requests.filter((r) => r.job === 'lane' && laneNameOf(r.task) === 'The code as it stands').length, RUN_AGAIN_LIMIT + 1);
    // The main agent was told: Listed, with why; the others Done.
    const back = front.requests.filter((r) => r.job === 'main' && /\(Deepen\)/.test(r.task)).map((r) => r.messages).find((m) => succeededCalls(m, 'pk_send_lanes').length);
    const outcome = JSON.parse(succeededCalls(back!, 'pk_send_lanes')[0]!.result) as { name: string; status: string; summary: string }[];
    assert.deepEqual(outcome.map((o) => [o.name, o.status]), SCRIPT_DEEPEN.map((l) => [l.name, l.name === 'The code as it stands' ? 'Listed' : 'Done']));
    assert.match(outcome.find((o) => o.status === 'Listed')!.summary, /^Failed 3 times and is listed as not finished: /);
    assert.deepEqual((deepen.failures ?? []).map((x) => [x.step, x.label, x.runs]), [['lane', 'Lane: The code as it stands', 3]], 'the round lists the lane that did not finish');

    // The coverage check listed what no lane read — the code the failed lane was sent for among it — the main agent
    // accounted for every group, and the cross-check started once it was settled.
    const coverage = store.clerkRounds.get(deepen.id)!.coverage!;
    assert.equal(coverage.settled, true);
    assert.ok(coverage.accounted.some((a) => a.group?.startsWith('code files')), `the code no lane read is accounted for: ${JSON.stringify(coverage.accounted.map((a) => a.group))}`);
    assert.deepEqual(store.clerkRounds.get(deepen.id)!.stageLog!.map((e) => e.stage), ['orientation', 'dig', 'coverage', 'cross-check']);
    // The synthesis is told what did not finish earlier in the round (the lane), in its own task.
    assert.match((stepJobs(app, projectId, deepen.id, 'synthesis')[0]!.task as { prompt: string }).prompt, /=== What did not finish earlier in this round\n- Lane: The code as it stands/);
    await until(() => store.coverage.state === 'Takeover complete', 30_000, 'the takeover complete');
  } finally { front.close(); await stopApp(app); }
});

test('the lanes run at the same time across two keys; one a key rate-limits goes on in its own session on the other, and the main agent gets its real report', { timeout: 300_000 }, async () => {
  let limited: string | null = null;
  const front = await frontProvider((job, task, _messages, provider) => {
    if (job !== 'lane') return 'pass';
    if (laneNameOf(task) === 'Goals' && limited === null) { limited = provider; return 'limit'; }
    return 'slow';
  });
  const { app, projectId } = await startApp(mkdtempSync(join(scratch, 'home-keys-')), front.url, { keys: 2 });
  try {
    const store = app.store(projectId);
    await app.organizing.replan(projectId);
    await until(() => closedRound(app, projectId, 'First usable') !== undefined, 180_000, 'the first usable round');
    const round = closedRound(app, projectId, 'First usable')!;
    assert.equal(round.status, 'Done', describeJobs(app, projectId, round.id));
    const lanes = stepJobs(app, projectId, round.id, 'lane');
    assert.deepEqual(lanes.map((j) => [j.step!.path, j.status]).sort(), [['Goals', 'Done'], ['Work', 'Done']]);
    const [a, b] = lanes;
    assert.ok(a!.startedAt! < b!.endedAt! && b!.startedAt! < a!.endedAt!, `the two lanes ran at the same time: ${lanes.map((j) => `${j.startedAt}–${j.endedAt}`).join(', ')}`);
    const goals = lanes.find((j) => j.step!.path === 'Goals')!;
    assert.ok(limited && goals.model?.provider !== limited, `Goals went on on the other key than ${limited}: ${goals.model?.provider}`);
    const last = front.requests.filter((r) => r.job === 'lane' && laneNameOf(r.task) === 'Goals').at(-1)!;
    assert.match(last.sent, /The model provider interrupted this work/, 'in its own session');
    // The main agent was given each lane's real summary, not a wait for quota.
    const back = front.requests.filter((r) => r.job === 'main').map((r) => r.messages).find((m) => succeededCalls(m, 'pk_send_lanes').length)!;
    const outcome = JSON.parse(succeededCalls(back, 'pk_send_lanes')[0]!.result) as { name: string; status: string; summary: string }[];
    assert.deepEqual(outcome.map((o) => [o.name, o.status, o.summary]), [['Goals', 'Done', 'The Goals lane wrote its slots and its report.'], ['Work', 'Done', 'The Work lane wrote its slots and its report.']]);
    assert.ok(store.reference.find((r) => r.category === 'Goal' && r.name === 'Fresh apples'), 'the limited lane’s write landed');
  } finally { front.close(); await stopApp(app); }
});

// ───────────────────────── the synthesis (D103) ─────────────────────────

/** Whether the synthesis has written its note in this session: the request after it is the one a test interrupts. */
const wroteNote = (messages: readonly Msg[]) => succeededCalls(messages, 'pk_write_note').length > 0;
const NOTE = 'Where Orchard stands';
const notesOf = (app: AppT, projectId: string) => app.store(projectId).notes.filter((n) => n.versions[0]!.title === NOTE);
/** The round's synthesis: one job, done, its note written once and the round's Result its own. */
function assertSynthesized(app: AppT, projectId: string, roundId: string): KeeperJob {
  const store = app.store(projectId);
  const jobs = stepJobs(app, projectId, roundId, 'synthesis');
  assert.equal(jobs.length, 1, 'one synthesis job: the same job went on, not a new one');
  assert.equal(jobs[0]!.status, 'Done', jobs[0]!.error ?? '');
  assert.deepEqual(notesOf(app, projectId).map((n) => n.versions.length), [1], 'its note was written once');
  assert.equal(store.roundDocs.find((d) => d.roundId === roundId && d.kind === 'Result')?.jobId, jobs[0]!.id, 'and the round has its Result');
  return jobs[0]!;
}

test('a synthesis whose session fails once runs again in its own session, told what is left, and the round finishes', { timeout: 300_000 }, async () => {
  let refused = 0;
  // Its request after its note is refused: it stops with the note written and no Result.
  const front = await frontProvider((job, _task, messages) => (job === 'synthesis' && wroteNote(messages) && refused++ === 0 ? 'refuse' : 'pass'));
  const { app, projectId } = await startApp(mkdtempSync(join(scratch, 'home-synth-once-')), front.url);
  try {
    await app.organizing.replan(projectId);
    await until(() => closedRound(app, projectId, 'First usable') !== undefined, 180_000, 'the first usable round');
    const round = closedRound(app, projectId, 'First usable')!;
    assert.equal(round.status, 'Done', describeJobs(app, projectId, round.id));
    assert.deepEqual(round.failures ?? [], [], 'nothing is listed: the synthesis finished on its second run');
    const synthesis = assertSynthesized(app, projectId, round.id);
    assert.deepEqual(runsOf(synthesis).map((r) => [r.status, r.again, r.counted]), [['Failed', 'program', true]]);
    const main = stepJobs(app, projectId, round.id, 'main');
    assert.deepEqual(main.map((j) => [j.status, runsOf(j).length]), [['Done', 0]], 'the main agent, done at its handover, is not run again');
    assert.notEqual(synthesis.sessionFile, main[0]!.sessionFile, 'the synthesis has a session of its own');
    const continued = front.requests.filter((r) => r.job === 'synthesis' && /You are the synthesis of this First usable round, and it has no Result yet/.test(r.sent));
    assert.ok(continued.length >= 1, 'the continued session was told what is left');
    assert.match(continued[0]!.sent, /This work ended before its task was done, and the program runs it again/);
    assert.ok(toldWhy(continued[0]!.messages), 'and why its last run ended');
    assert.ok(wroteNote(continued[0]!.messages), 'it is its own session: the note it wrote is in it');
  } finally { front.close(); await stopApp(app); }
});

test('a synthesis that ends without the round’s Result did not finish: it runs again in its own session (合成才算完)', { timeout: 300_000 }, async () => {
  // A synthesis that stops after its note, saying it is done: no Result, so the program runs it again.
  let stopped = 0;
  const lazy = clerkPlanner({
    lanes: (round: RoundKind) => (round === 'First usable' ? SCRIPT_FIRST : []),
    laneWork: (name) => (name === 'Work' ? [{ name: 'pk_write_thread', args: { title: 'Hand picking', ids: ['T-1'], doing: 'Pick by hand', serves: [], progress: 'Planned' } }] : []),
    stageWork: (_round, stage) => (stage === 'synthesis' ? [{ name: 'pk_write_note', args: { mountKind: 'project', mountIds: [], title: NOTE, preview: 'A basket, picked by hand.', ask: 'For information', currentView: 'Hand picking is the only work.', reason: 'synthesis of the round' } }] : []),
  }, (task, messages) => (jobOf(task).kind === 'synthesis' && wroteNote(messages as never) && !/it has no Result yet/.test(JSON.stringify(messages)) && stopped++ >= 0 ? 'That is the synthesis.' : undefined));
  const fake = await startFakeProvider(lazy);
  const { app, projectId } = await startApp(mkdtempSync(join(scratch, 'home-synth-noresult-')), fake.url);
  try {
    await app.organizing.replan(projectId);
    await until(() => closedRound(app, projectId, 'First usable') !== undefined, 180_000, 'the first usable round');
    const round = closedRound(app, projectId, 'First usable')!;
    assert.equal(round.status, 'Done', describeJobs(app, projectId, round.id));
    const synthesis = assertSynthesized(app, projectId, round.id);
    assert.ok(stopped >= 1, 'it did end once without a Result');
    assert.deepEqual(runsOf(synthesis).map((r) => [r.status, r.again, r.counted, r.reason]), [['Failed', 'program', true, 'The synthesis\' session ended without writing the round\'s Result']]);
  } finally { fake.close(); await stopApp(app); }
});

test('a synthesis a key rate-limits goes on in its own session on the other key', { timeout: 300_000 }, async () => {
  let limited: string | null = null;
  const front = await frontProvider((job, _task, messages, provider) => {
    if (job === 'synthesis' && wroteNote(messages) && limited === null) { limited = provider; return 'limit'; }
    return 'pass';
  });
  const { app, projectId } = await startApp(mkdtempSync(join(scratch, 'home-synth-limit-')), front.url, { keys: 2 });
  try {
    await app.organizing.replan(projectId);
    await until(() => closedRound(app, projectId, 'First usable') !== undefined, 180_000, 'the first usable round');
    const round = closedRound(app, projectId, 'First usable')!;
    assert.equal(round.status, 'Done', describeJobs(app, projectId, round.id));
    assert.deepEqual(round.failures ?? [], []);
    const synthesis = assertSynthesized(app, projectId, round.id);
    assert.deepEqual(runsOf(synthesis), [], 'a rate limit is not a failure');
    assert.ok(limited && synthesis.model?.provider !== limited, `it went on on the other key than ${limited}: ${synthesis.model?.provider}`);
    const last = front.requests.filter((r) => r.job === 'synthesis').at(-1)!;
    assert.match(last.sent, /The model provider interrupted this work/, 'in its own session');
    assert.ok(wroteNote(last.messages), 'which holds the note it wrote before the limit');
  } finally { front.close(); await stopApp(app); }
});

test('pausing organizing while the synthesis runs stops it to go on in its session; resuming continues it and the round finishes', { timeout: 300_000 }, async () => {
  let withhold = true;
  const front = await frontProvider((job, _task, messages) => (job === 'synthesis' && wroteNote(messages) && withhold ? 'withhold' : 'pass'));
  const { app, projectId } = await startApp(mkdtempSync(join(scratch, 'home-synth-pause-')), front.url);
  try {
    const store = app.store(projectId);
    await app.organizing.replan(projectId);
    const synth = () => store.jobs.find((j) => j.step?.kind === 'synthesis');
    await until(() => synth()?.status === 'Running' && notesOf(app, projectId).length === 1, 120_000, 'the synthesis running, its note written');
    app.pauseOrganizing(projectId, true);
    await until(() => synth()!.status === 'Paused', 30_000, 'the pause reaching the synthesis');
    assert.equal(synth()!.resume?.why, 'pause', 'it is marked to go on');
    withhold = false;
    app.pauseOrganizing(projectId, false);
    await until(() => closedRound(app, projectId, 'First usable') !== undefined, 60_000, 'the round after resuming');
    const round = closedRound(app, projectId, 'First usable')!;
    assert.equal(round.status, 'Done', describeJobs(app, projectId, round.id));
    assert.deepEqual(round.failures ?? [], []);
    assertSynthesized(app, projectId, round.id);
    assert.ok(front.requests.some((r) => r.job === 'synthesis' && /The owner paused organizing/.test(r.sent) && wroteNote(r.messages)), 'it went on in its own session');
  } finally { front.close(); await stopApp(app); }
});

test('after a restart while the synthesis runs, it goes on in its own session, uncounted, and the main agent is not run again', { timeout: 300_000 }, async () => {
  const before = await frontProvider((job, _task, messages) => (job === 'synthesis' && wroteNote(messages) ? 'withhold' : 'pass'));
  const home = mkdtempSync(join(scratch, 'home-synth-cut-'));
  const first = await startApp(home, before.url);
  const front = await frontProvider(() => 'pass');
  let second: { app: AppT; projectId: string } | null = null;
  try {
    const store = first.app.store(first.projectId);
    await first.app.organizing.replan(first.projectId);
    await until(() => store.jobs.find((j) => j.step?.kind === 'synthesis' && j.status === 'Running') !== undefined && notesOf(first.app, first.projectId).length === 1, 120_000, 'the synthesis running, its note written');
    const synthId = store.jobs.find((j) => j.step?.kind === 'synthesis')!.id;
    const roundId = store.jobs.get(synthId)!.step!.roundId;

    second = await startApp(await restartOn(first.app, home), front.url, { fresh: false });
    const s = second.app.store(second.projectId);
    await until(() => s.clerkRounds.get(roundId)?.status !== 'Running', 180_000, 'the round after the restart');
    const round = s.clerkRounds.get(roundId)!;
    assert.equal(round.status, 'Done', describeJobs(second.app, second.projectId, roundId));
    assert.deepEqual(round.failures ?? [], []);
    const synthesis = assertSynthesized(second.app, second.projectId, roundId);
    assert.equal(synthesis.id, synthId, 'the synthesis the restart cut short ran again, as the same job');
    assert.deepEqual(runsOf(synthesis).map((r) => [r.status, r.again, r.counted]), [['Stopped', 'program', false]], 'a restart does not count as a failure');
    assert.ok(front.requests.some((r) => r.job === 'synthesis' && /ProjectKeeper restarted while this work was running/.test(r.sent) && wroteNote(r.messages)), 'it went on in its own session');
    assert.equal(front.requests.filter((r) => r.job === 'main').length, 0, 'the main agent, done at its handover, was not run again');
  } finally {
    const firstStore = first.app.store(first.projectId);
    for (const j of firstStore.jobs.filter((x) => x.status === 'Running' && x.agent === 'pi')) first.app.keeper.stopJob(first.projectId, j.id);
    await until(() => !firstStore.jobs.find((x) => x.status === 'Running' && x.agent === 'pi'), 30_000, 'the first run’s job to let go').catch(() => undefined);
    before.close(); front.close();
    await stopApp(first.app);
    if (second) await stopApp(second.app);
  }
});

test('a spot-check whose session fails once runs again in its own session, told what is recorded, and counts each check once', { timeout: 600_000 }, async () => {
  let refused = 0;
  // Its request after its record is refused: it stops with its checks recorded and no Spot check document.
  const front = await frontProvider((job, _task, messages) => (job === 'spot-check' && succeededCalls(messages, 'pk_record_spot_check').length > 0 && refused++ === 0 ? 'refuse' : 'pass'));
  const { app, projectId } = await startApp(mkdtempSync(join(scratch, 'home-spot-once-')), front.url);
  try {
    const store = app.store(projectId);
    await app.organizing.replan(projectId);
    await until(() => closedRound(app, projectId, 'First usable') !== undefined, 180_000, 'the first usable round');
    app.startTakeover(projectId, 'Full');
    await app.organizing.replan(projectId);
    await until(() => closedRound(app, projectId, 'Deepen') !== undefined, 300_000, 'the deepening');
    const deepen = closedRound(app, projectId, 'Deepen')!;
    assert.equal(deepen.status, 'Done', describeJobs(app, projectId, deepen.id));
    assert.deepEqual(deepen.failures ?? [], []);
    const spot = stepJobs(app, projectId, deepen.id, 'spot-check');
    assert.deepEqual(spot.map((j) => [j.status, runsOf(j).map((r) => [r.status, r.again, r.counted])]), [['Done', [['Failed', 'program', true]]]], 'the same job ran again');
    const continued = front.requests.filter((r) => r.job === 'spot-check' && /You are the spot-check of this Deepen round\. \d+ checks? (?:is|are) recorded so far/.test(r.sent));
    assert.ok(continued.length >= 1, 'its continued session was told what is recorded');
    assert.ok(succeededCalls(continued[0]!.messages, 'pk_record_spot_check').length > 0, 'it is its own session: its record is in it');
    assert.ok(store.roundDocs.find((d) => d.roundId === deepen.id && d.kind === 'Spot check'), 'and it wrote its document');
    // The synthesis' note of the first round stands, was given to the deepening's synthesis, and is checked in full: once.
    const counts = store.clerkRounds.get(deepen.id)!.spotCheck!;
    assert.equal(counts.targets!.length, counts.sampled, 'each judgement counted once');
    assert.ok(counts.synthesis && counts.synthesis.checked === counts.synthesis.outputs && counts.synthesis.outputs >= 2, `what the synthesis wrote and every current note, checked in full: ${JSON.stringify(counts.synthesis)}`);
  } finally { front.close(); await stopApp(app); }
});

// ───────────────────────── a program step ─────────────────────────

test('a failed ledger step runs again by itself; one that keeps failing is listed, the round goes on, and Retry runs it again', { timeout: 300_000 }, async () => {
  const front = await frontProvider(() => 'pass');
  let failing = true;
  let calls = 0;
  let real: InstanceType<typeof App>['ledger']['runner'] | null = null;
  const { app, projectId } = await startApp(mkdtempSync(join(scratch, 'home-ledger-')), front.url, {
    setup: (a) => { real = a.ledger.runner; a.organizing.setLedgerRunner({ run: async (p, x) => { calls++; if (failing) throw new Error('git log failed (test)'); return real!.run(p, x); } }); },
  });
  try {
    const store = app.store(projectId);
    await app.organizing.replan(projectId);
    await until(() => closedRound(app, projectId, 'First usable') !== undefined, 180_000, 'the first usable round');
    const round = closedRound(app, projectId, 'First usable')!;
    assert.equal(round.status, 'Done', describeJobs(app, projectId, round.id));
    const ledger = stepJobs(app, projectId, round.id, 'ledger');
    assert.equal(ledger.length, 1, 'one ledger job, run again by the program');
    assert.equal(ledger[0]!.status, 'Failed');
    assert.equal(calls, RUN_AGAIN_LIMIT + 1, 'the program ran the ledger three times');
    assert.deepEqual((round.failures ?? []).map((x) => [x.step, x.runs, x.reason]), [['ledger', 3, 'git log failed (test)']]);
    assert.equal(round.ledger, null, 'the ledger was not brought up to date');
    assert.ok(stepJobs(app, projectId, round.id, 'main').every((j) => j.status === 'Done'), 'the round went on without it');
    assert.match(projectFailed(app, projectId).find((x) => x.ref === ledger[0]!.id)?.reason ?? '', /^Ledger: bring it up to date: failed 3 times — git log failed \(test\)\. Listed: First usable round 1 closed without it; Retry runs it again$/);
    // The main agent was told what did not finish.
    assert.ok(front.requests.find((r) => r.job === 'main')?.task.includes('=== What did not finish earlier in this round'), 'the main agent is told the ledger did not finish');

    // Retry from the Keeper view: the clerk runs the ledger again (the runtime does not run a program's job, a274600).
    failing = false;
    assert.equal(app.keeper.restartJob(projectId, ledger[0]!.id), false, 'the runtime still refuses it');
    assert.equal(route(app, 'POST', '/api/projects/:id/keeper/jobs/:jobId/retry')({ id: projectId, jobId: ledger[0]!.id }).ok, true);
    await until(() => store.jobs.get(ledger[0]!.id)!.status === 'Done', 60_000, 'the retried ledger');
    assert.equal(calls, RUN_AGAIN_LIMIT + 2);
    assert.deepEqual(runsOf(store.jobs.get(ledger[0]!.id)!).map((r) => r.again), ['program', 'program', 'owner']);
    assert.ok(store.clerkRounds.get(round.id)!.ledger, 'the ledger is up to date and the round says how long it took');
    await app.organizing.replan(projectId);
    assert.ok(!projectFailed(app, projectId).some((x) => x.ref === ledger[0]!.id), 'it left the failure list');

    // Once, then fine: the next round's ledger fails once and runs again by itself.
    let once = true;
    app.organizing.setLedgerRunner({ run: async (p, x) => { if (once) { once = false; throw new Error('database is locked (test)'); } return real!.run(p, x); } });
    app.followUp(projectId);
    await until(() => closedRound(app, projectId, 'Follow up') !== undefined, 180_000, 'the Follow up round');
    const followUp = closedRound(app, projectId, 'Follow up')!;
    const next = stepJobs(app, projectId, followUp.id, 'ledger');
    assert.deepEqual([next.length, next[0]!.status, runsOf(next[0]!).map((r) => r.reason)], [1, 'Done', ['database is locked (test)']]);
    assert.deepEqual(followUp.failures ?? [], []);
    assert.ok(followUp.ledger, 'the ledger was brought up to date on its second run');
  } finally { front.close(); await stopApp(app); }
});

// ───────────────────────── the owner's Stop, a pause ─────────────────────────

test('the owner’s Stop reaches the tree: the main agent and its lanes stop, nothing runs again, the round waits; Continue goes on and the round finishes', { timeout: 300_000 }, async () => {
  let withhold = true;
  const front = await frontProvider((job, task) => (job === 'lane' && laneNameOf(task) === 'Work' && withhold ? 'withhold' : 'pass'));
  const { app, projectId } = await startApp(mkdtempSync(join(scratch, 'home-stop-')), front.url);
  try {
    const store = app.store(projectId);
    await app.organizing.replan(projectId);
    const work = () => store.jobs.find((j) => j.step?.kind === 'lane' && j.step.path === 'Work');
    await until(() => work()?.status === 'Running', 120_000, 'the Work lane running');
    const main = store.jobs.find((j) => j.step?.kind === 'main')!;
    assert.equal(app.keeper.stopJob(projectId, main.id), true);
    await until(() => store.jobs.get(main.id)!.status === 'Stopped' && work()!.status === 'Stopped', 30_000, 'the stop reaching the lane').catch((e) => { throw new Error(`${e.message}: ${describeJobs(app, projectId, main.step!.roundId)}`); });
    assert.equal(work()!.resume ?? null, null, 'the owner’s Stop is not a pause: the lane is not marked to go on by itself');
    withhold = false;
    for (let i = 0; i < 3; i++) { await app.organizing.replan(projectId); await new Promise((r) => setTimeout(r, 200)); }
    const round = store.clerkRounds.find((r) => r.kind === 'First usable')!;
    assert.equal(round.status, 'Running', 'the round waits');
    assert.equal(store.jobs.get(main.id)!.status, 'Stopped', 'the program does not run it again');
    assert.equal(work()!.status, 'Stopped', 'nor its lane');
    assert.equal(runsOf(store.jobs.get(main.id)!).length, 0);
    assert.equal(stepJobs(app, projectId, round.id, 'process').length, 0, 'nothing after it starts');
    assert.match(projectFailed(app, projectId).find((x) => x.ref === main.id)?.reason ?? '', /^Main agent: stopped by you — the round waits until you Continue it$/);

    // The owner continues the lanes, then the main agent: it sends the same call again, finds its lanes done, and goes on.
    const cont = route(app, 'POST', '/api/projects/:id/keeper/jobs/:jobId/continue');
    const stopped = stepJobs(app, projectId, round.id, 'lane').filter((j) => j.status === 'Stopped');
    assert.ok(stopped.some((j) => j.id === work()!.id), 'the Work lane is among the lanes the Stop reached');
    for (const j of stopped) assert.equal(cont({ id: projectId, jobId: j.id }).ok, true);
    await until(() => stepJobs(app, projectId, round.id, 'lane').every((j) => j.status === 'Done'), 60_000, 'the continued lanes');
    assert.equal(cont({ id: projectId, jobId: main.id }).ok, true);
    await until(() => closedRound(app, projectId, 'First usable') !== undefined, 180_000, 'the round after Continue');
    const closed = closedRound(app, projectId, 'First usable')!;
    assert.equal(closed.status, 'Done', describeJobs(app, projectId, closed.id));
    assert.deepEqual(closed.failures ?? [], []);
    assert.equal(store.jobs.get(main.id)!.status, 'Done');
    assert.deepEqual(runsOf(store.jobs.get(main.id)!).map((r) => [r.status, r.again, r.counted]), [['Stopped', 'owner', false]]);
    assert.deepEqual(stepJobs(app, projectId, closed.id, 'lane').map((j) => j.step!.path).sort(), ['Goals', 'Work'], 'no lane sent twice');
  } finally { front.close(); await stopApp(app); }
});

test('pausing organizing stops the main agent and its lanes to go on in their sessions; resuming continues them and the round finishes', { timeout: 300_000 }, async () => {
  let withhold = true;
  const front = await frontProvider((job, task) => (job === 'lane' && laneNameOf(task) === 'Work' && withhold ? 'withhold' : 'pass'));
  const { app, projectId } = await startApp(mkdtempSync(join(scratch, 'home-pause-')), front.url);
  try {
    const store = app.store(projectId);
    await app.organizing.replan(projectId);
    const work = () => store.jobs.find((j) => j.step?.kind === 'lane' && j.step.path === 'Work');
    await until(() => work()?.status === 'Running', 120_000, 'the Work lane running');
    const main = store.jobs.find((j) => j.step?.kind === 'main')!;
    app.pauseOrganizing(projectId, true);
    await until(() => store.jobs.get(main.id)!.status === 'Paused' && work()!.status === 'Paused', 30_000, 'the pause reaching the tree');
    for (const j of [store.jobs.get(main.id)!, work()!]) assert.equal(j.resume?.why, 'pause', `${j.scope.label} is marked to go on`);
    withhold = false;
    app.pauseOrganizing(projectId, false);
    await until(() => closedRound(app, projectId, 'First usable') !== undefined, 60_000, 'the round after resuming').catch((e) => { throw new Error(`${e.message}: ${describeJobs(app, projectId, main.step!.roundId)} · ${JSON.stringify(store.jobs.all().map((j) => [j.scope.label, j.status, j.resume]))}`); });
    const closed = closedRound(app, projectId, 'First usable')!;
    assert.equal(closed.status, 'Done', describeJobs(app, projectId, closed.id));
    assert.deepEqual(closed.failures ?? [], []);
    assert.deepEqual(stepJobs(app, projectId, closed.id, 'lane').map((j) => j.step!.path).sort(), ['Goals', 'Work'], 'no lane sent twice');
    // The lane goes on in its own session; paused before its session had anything in it, it starts afresh.
    const work2 = front.requests.filter((r) => r.job === 'lane' && laneNameOf(r.task) === 'Work' && r.answer === 'pass');
    assert.ok(work2.length >= 1, 'the lane ran again once organizing resumed');
    assert.ok(front.requests.some((r) => r.job === 'main' && /The owner paused organizing/.test(r.sent)), 'and so did the main agent');
  } finally { front.close(); await stopApp(app); }
});

// ───────────────────────── restarts ─────────────────────────

/** ProjectKeeper as it stood on disk: the home copied once its writes landed, for a new App to start on. */
async function restartOn(app: AppT, from: string): Promise<string> {
  await app.flushAll();
  app.stopAll();
  const to = mkdtempSync(join(scratch, 'home-restarted-'));
  cpSync(from, to, { recursive: true });
  return to;
}

test('after a restart while the lanes run, the main agent and its lanes go on in their sessions, uncounted, no lane is sent twice, and the root job runs again', { timeout: 300_000 }, async () => {
  const before = await frontProvider((job, task) => (job === 'lane' && laneNameOf(task) === 'Work' ? 'withhold' : 'pass'));
  const home = mkdtempSync(join(scratch, 'home-cut-'));
  const first = await startApp(home, before.url);
  const front = await frontProvider(() => 'pass');
  let second: { app: AppT; projectId: string } | null = null;
  try {
    const store = first.app.store(first.projectId);
    await first.app.organizing.replan(first.projectId);
    await until(() => store.jobs.find((j) => j.step?.kind === 'lane' && j.step.path === 'Work' && j.status === 'Running') !== undefined, 120_000, 'the Work lane running');
    const mainId = store.jobs.find((j) => j.step?.kind === 'main')!.id;
    const workId = store.jobs.find((j) => j.step?.kind === 'lane' && j.step.path === 'Work')!.id;
    const roundId = store.jobs.get(mainId)!.step!.roundId;

    second = await startApp(await restartOn(first.app, home), front.url, { fresh: false });
    const s = second.app.store(second.projectId);
    await until(() => s.clerkRounds.get(roundId)?.status !== 'Running', 180_000, 'the round after the restart');
    const round = s.clerkRounds.get(roundId)!;
    assert.equal(round.status, 'Done', describeJobs(second.app, second.projectId, roundId));
    assert.deepEqual(round.failures ?? [], []);
    const main = s.jobs.get(mainId)!;
    assert.equal(main.status, 'Done', 'the main agent the restart cut short ran again, as the same job');
    assert.deepEqual(runsOf(main).map((r) => [r.status, r.again, r.counted]), [['Stopped', 'program', false]], 'a restart does not count as a failure');
    assert.match(runsOf(main)[0]!.reason, /ProjectKeeper restarted while this work was running/);
    assert.ok(front.requests.some((r) => r.job === 'main' && /ProjectKeeper restarted while this work was running/.test(r.sent) && /You stopped in the skeleton stage/.test(r.sent)), 'it went on in its own session, told where it stopped');
    assert.equal(s.jobs.get(workId)!.status, 'Done');
    // The restart may have come before the lane's session was open: then it starts afresh when the main agent sends it again.
    assert.ok(front.requests.some((r) => r.job === 'lane' && laneNameOf(r.task) === 'Work' && r.answer === 'pass'), 'the lane ran again after the restart');
    assert.deepEqual(stepJobs(second.app, second.projectId, roundId, 'lane').map((j) => j.step!.path).sort(), ['Goals', 'Work'], 'no lane sent twice');
    assert.ok(s.traceByJob(round.rootJobId, 500).some((e) => /goes on after ProjectKeeper restarted/.test(e.summary)), 'the round’s root job ran again');
    assert.equal(s.jobs.get(round.rootJobId)!.status, 'Done');
  } finally {
    // The first ProjectKeeper still waits on its withheld request: stopped, it lets go of it (in its own home).
    const firstStore = first.app.store(first.projectId);
    for (const j of firstStore.jobs.filter((x) => x.status === 'Running' && x.agent === 'pi')) first.app.keeper.stopJob(first.projectId, j.id);
    await until(() => !firstStore.jobs.find((x) => x.status === 'Running' && x.agent === 'pi'), 30_000, 'the first run’s job to let go').catch(() => undefined);
    before.close(); front.close();
    await stopApp(first.app);
    if (second) await stopApp(second.app);
  }
});

test('after a restart a main agent left waiting for quota is queued again, and the round finishes', { timeout: 300_000 }, async () => {
  const before = await frontProvider((job) => (job === 'main' ? 'quota' : 'pass'));
  const home = mkdtempSync(join(scratch, 'home-quota-'));
  const first = await startApp(home, before.url);
  const front = await frontProvider(() => 'pass');
  let second: { app: AppT; projectId: string } | null = null;
  try {
    const store = first.app.store(first.projectId);
    await first.app.organizing.replan(first.projectId);
    await until(() => store.jobs.find((j) => j.step?.kind === 'main' && j.status === 'Waiting for quota') !== undefined, 120_000, 'the main agent waiting for quota');
    const mainId = store.jobs.find((j) => j.step?.kind === 'main')!.id;
    const roundId = store.jobs.get(mainId)!.step!.roundId;

    second = await startApp(await restartOn(first.app, home), front.url, { fresh: false });
    const s = second.app.store(second.projectId);
    await until(() => s.clerkRounds.get(roundId)?.status !== 'Running', 180_000, 'the round after the restart');
    const round = s.clerkRounds.get(roundId)!;
    assert.equal(round.status, 'Done', describeJobs(second.app, second.projectId, roundId));
    assert.equal(s.jobs.get(mainId)!.status, 'Done', 'the main agent waiting for quota ran once ProjectKeeper started again');
    assert.deepEqual(runsOf(s.jobs.get(mainId)!), [], 'waiting for quota is not a failure');
  } finally {
    before.close(); front.close();
    await stopApp(first.app);
    if (second) await stopApp(second.app);
  }
});
