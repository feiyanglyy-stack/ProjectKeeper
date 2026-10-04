/**
 * The route in use (Spec §6.10 每一步用哪个模型、备用与并行、什么时候生效, §3.10; D105; CKC-03 AC-29, AC-35): lanes on
 * another model than the main agent, on the key that carries it; the backup order when a key runs out; each key's jobs at
 * once; a change applies to the jobs that start after it; a removed key's work moves on, or waits saying why.
 *
 * The keys are the owner's own keys for providers pi does not know, whose endpoint is a local test double that answers by
 * the key it is sent. No real key, no network, no quota.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-pi-agent-'));
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
const { App } = await import('../server/app.ts');
const { usageByRound, modelProviderView } = await import('../server/keys-api.ts');
const order: any = await import(new URL('../../ui/key-order.js', import.meta.url).href);   // eslint-disable-line @typescript-eslint/no-explicit-any

interface Double {
  url: string;
  /** Requests by key value and model. */
  sent: { key: string; model: string }[];
  /** While set, answers wait for it. */
  gate: Promise<void> | null;
  inFlight: Map<string, number>;
  maxInFlight: Map<string, number>;
  /** Keys answered with a quota window (Zhipu 1308). */
  outOfQuota: Set<string>;
  close(): void;
}
function double(): Promise<Double> {
  const d: Double = { url: '', sent: [], gate: null, inFlight: new Map(), maxInFlight: new Map(), outOfQuota: new Set(), close: () => undefined };
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', async () => {
      const key = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      let model = '';
      try { model = (JSON.parse(Buffer.concat(parts).toString('utf8')) as { model?: string }).model ?? ''; } catch { /* none */ }
      d.sent.push({ key, model });
      if (d.outOfQuota.has(key)) {
        res.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' });
        res.end(JSON.stringify({ error: { code: '1308', message: 'Usage limit reached for 5 hour. Your limit will reset at 2099-01-01 00:00:00' } }));
        return;
      }
      d.inFlight.set(key, (d.inFlight.get(key) ?? 0) + 1);
      d.maxInFlight.set(key, Math.max(d.maxInFlight.get(key) ?? 0, d.inFlight.get(key)!));
      if (d.gate) await d.gate;
      d.inFlight.set(key, d.inFlight.get(key)! - 1);
      const chunk = (delta: object, finish: string | null) => ({ id: 'c', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'Done.' }, null))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    d.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    d.close = () => server.close();
    resolve(d);
  }));
}
const gate = (d: Double): (() => void) => { let open!: () => void; d.gate = new Promise((r) => { open = r; }); return () => { d.gate = null; open(); }; };

type AppT = InstanceType<typeof App>;
function family(app: AppT, id: string, url: string, models: readonly string[]): void {
  app.keeper.models.registerProvider(id, { name: id, baseUrl: url, api: 'openai-completions', models: models.map((m) => ({ id: m, name: m, api: 'openai-completions' as const, baseUrl: url, reasoning: true, input: ['text' as const], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 })) });
}
async function until(check: () => boolean, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 25))) if (Date.now() > end) throw new Error('timed out');
}
function withoutEnvKeys(): () => void {
  const saved = Object.entries(process.env).filter(([k]) => /_API_KEY$|_TOKEN$/.test(k));
  for (const [k] of saved) delete process.env[k];
  return () => { for (const [k, v] of saved) process.env[k] = v; };
}

/** An app with two GLM-like keys (`kestrel`) and one DeepSeek-like key (`merlin`), all the owner's own. */
async function setup(): Promise<{ app: AppT; d: Double; projectId: string; restore: () => void }> {
  const restore = withoutEnvKeys();
  const d = await double();
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-proj-'));
  writeFileSync(join(projectDir, 'README.md'), '# Demo\n\nA project for the route test.\n');
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')), { organizing: false });
  const project = app.addProject('Demo', [projectDir]);
  await app.intakeProject(project.id);
  app.stopAll();
  await app.initKeeper();
  family(app, 'kestrel', d.url, ['kestrel-pro', 'kestrel-flash']);
  family(app, 'merlin', d.url, ['merlin-flash']);
  await app.keeper.addKey('kestrel', 'K one', 'pk-test-k1-a8f0');
  await app.keeper.addKey('kestrel', 'K two', 'pk-test-k2-b7e1');
  await app.keeper.addKey('merlin', 'M one', 'pk-test-m1-c6d2');
  app.keeper.setLanesPerKey(1);
  return { app, d, projectId: project.id, restore };
}
const job = (app: AppT, projectId: string, kind: 'lane' | 'main' | 'spot-check' | null, label: string) => app.keeper.enqueue(projectId, {
  kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label }, prompt: 'Organize.',
  ...(kind ? { step: { roundId: 'crd_route_test', kind, path: null } } : {}),
});

test('lanes run on another model than the main agent, on the key that carries it; the main agent’s work is shared by the keys that carry its model', async () => {
  const { app, d, projectId, restore } = await setup();
  try {
    app.keeper.setRoute(projectId, { model: { provider: 'kestrel~1', id: 'kestrel-pro', thinking: null }, backups: [{ provider: 'kestrel~2', id: 'kestrel-pro', thinking: null }], steps: { lane: { provider: 'merlin', model: 'merlin-flash', thinking: 'low' } } });
    const store = app.store(projectId);
    const lane = job(app, projectId, 'lane', 'a lane');
    const main = job(app, projectId, 'main', 'the main agent');
    const spot = job(app, projectId, 'spot-check', 'the spot-check');
    await until(() => [lane, main, spot].every((j) => store.jobs.get(j.id)?.status === 'Done'));
    assert.deepEqual(store.jobs.get(lane.id)!.model, { provider: 'merlin~1', id: 'merlin-flash', thinking: 'low' }, 'the lane on its own model, on the key that carries it');
    assert.equal(store.jobs.get(main.id)!.model?.id, 'kestrel-pro');
    assert.ok(['kestrel~1', 'kestrel~2'].includes(store.jobs.get(main.id)!.model!.provider));
    assert.equal(store.jobs.get(spot.id)!.model?.id, 'kestrel-pro', 'a step not set follows the main model');
    assert.ok(!d.sent.some((s) => s.key === 'pk-test-m1-c6d2' && s.model !== 'merlin-flash'), 'nothing else was sent to the lane key');
  } finally { app.stopAll(); d.close(); restore(); }
});

test('when a key runs out of quota its work goes to the next key of the owner’s order; a lane whose model no usable key carries stands in on the main model', async () => {
  const { app, d, projectId, restore } = await setup();
  try {
    // The owner's order: K two after K one.
    app.keeper.setRoute(projectId, { model: { provider: 'kestrel~1', id: 'kestrel-pro', thinking: null }, backups: [{ provider: 'kestrel~2', id: 'kestrel-pro', thinking: null }], steps: { lane: { provider: 'merlin', model: 'merlin-flash' } } });
    const store = app.store(projectId);
    d.outOfQuota.add('pk-test-k1-a8f0');
    const first = job(app, projectId, 'main', 'after K one ran out');
    await until(() => store.jobs.get(first.id)?.status === 'Done');
    assert.equal(store.jobs.get(first.id)!.model?.provider, 'kestrel~2', 'the next key of the order took it');
    const switches = (await app.keeper.providerState(projectId)).switches;
    assert.ok(switches.some((s) => s.from === 'kestrel~1'), 'the switch is recorded');
    // The lane key runs out too: the lane stands in on a key of the order, on the main model.
    d.outOfQuota.add('pk-test-m1-c6d2');
    const lane = job(app, projectId, 'lane', 'a lane while M one is out');
    await until(() => store.jobs.get(lane.id)?.status === 'Done');
    assert.deepEqual([store.jobs.get(lane.id)!.model?.provider, store.jobs.get(lane.id)!.model?.id], ['kestrel~2', 'kestrel-pro']);
  } finally { app.stopAll(); d.close(); restore(); }
});

test('a step set to a model on one key runs on that key; when it is out, on the other key with the same model, as a recorded switch; it stands in only when no key carries the model', async () => {
  const { app, d, projectId, restore } = await setup();
  try {
    // Both GLM-like keys carry kestrel-flash; K one is first in the order. The lanes are set to kestrel-flash on K two.
    app.keeper.setRoute(projectId, { model: { provider: 'kestrel~1', id: 'kestrel-pro', thinking: null }, backups: [{ provider: 'kestrel~2', id: 'kestrel-pro', thinking: null }, { provider: 'merlin~1', id: 'merlin-flash', thinking: null }], steps: { lane: { provider: 'kestrel~2', model: 'kestrel-flash', thinking: 'low' } } });
    const store = app.store(projectId);
    const checked = d.sent.length;   // each key was asked once as it was saved
    const first = job(app, projectId, 'lane', 'a lane on K two');
    await until(() => store.jobs.get(first.id)?.status === 'Done');
    assert.deepEqual(store.jobs.get(first.id)!.model, { provider: 'kestrel~2', id: 'kestrel-flash', thinking: 'low' }, 'on the key it is set to, not the first key of the order with the model');
    assert.ok(!d.sent.slice(checked).some((s) => s.key === 'pk-test-k1-a8f0'), 'nothing went to K one');

    // K two runs out of quota: the lane goes on to K one, on the same model, and the switch is in the log.
    d.outOfQuota.add('pk-test-k2-b7e1');
    const second = job(app, projectId, 'lane', 'a lane while K two is out');
    await until(() => store.jobs.get(second.id)?.status === 'Done');
    assert.deepEqual(store.jobs.get(second.id)!.model, { provider: 'kestrel~1', id: 'kestrel-flash', thinking: 'low' }, 'the same model on the other key that carries it');
    const switches = (await app.keeper.providerState(projectId)).switches;
    assert.ok(switches.some((s) => s.from === 'kestrel~2/kestrel-flash' && s.to === 'kestrel~1/kestrel-flash' && /lane step/.test(s.reason) && s.until), `the switch is recorded: ${JSON.stringify(switches)}`);
    // A second lane while K two is still out: no second record of the same switch.
    const third = job(app, projectId, 'lane', 'another lane while K two is out');
    await until(() => store.jobs.get(third.id)?.status === 'Done');
    assert.equal(store.jobs.get(third.id)!.model?.provider, 'kestrel~1');
    assert.equal((await app.keeper.providerState(projectId)).switches.filter((s) => s.from === 'kestrel~2/kestrel-flash').length, 1, 'recorded once');

    // K one runs out too: no usable key carries kestrel-flash, so the lane stands in on the next key of the order, on its model.
    d.outOfQuota.add('pk-test-k1-a8f0');
    const fourth = job(app, projectId, 'lane', 'a lane with no key for its model');
    await until(() => store.jobs.get(fourth.id)?.status === 'Done');
    assert.deepEqual([store.jobs.get(fourth.id)!.model?.provider, store.jobs.get(fourth.id)!.model?.id], ['merlin~1', 'merlin-flash']);
  } finally { app.stopAll(); d.close(); restore(); }
});

test('a step set to a provider’s model ("· 2 keys") is shared by that provider’s keys and by no other', async () => {
  const { app, d, projectId, restore } = await setup();
  try {
    family(app, 'osprey', d.url, ['kestrel-flash']);
    await app.keeper.addKey('osprey', 'O one', 'pk-test-o1-d5c3');
    // osprey also carries kestrel-flash and comes first in the order; the spot-check is set to kestrel-flash on the kestrel keys.
    app.keeper.setRoute(projectId, { model: { provider: 'osprey~1', id: 'kestrel-flash', thinking: null }, backups: [{ provider: 'kestrel~1', id: 'kestrel-pro', thinking: null }, { provider: 'kestrel~2', id: 'kestrel-pro', thinking: null }], steps: { 'spot-check': { provider: 'kestrel', model: 'kestrel-flash' } } });
    const store = app.store(projectId);
    const checked = d.sent.length;   // each key was asked once as it was saved
    const release = gate(d);
    const jobs = [1, 2].map((n) => job(app, projectId, 'spot-check', `spot-check ${n}`));
    await until(() => (d.inFlight.get('pk-test-k1-a8f0') ?? 0) === 1 && (d.inFlight.get('pk-test-k2-b7e1') ?? 0) === 1);
    release();
    await until(() => jobs.every((j) => store.jobs.get(j.id)?.status === 'Done'));
    assert.deepEqual(jobs.map((j) => store.jobs.get(j.id)!.model?.provider).sort(), ['kestrel~1', 'kestrel~2']);
    assert.ok(!d.sent.slice(checked).some((s) => s.key === 'pk-test-o1-d5c3'), 'the first key of the order has the model but is not the one chosen');
  } finally { app.stopAll(); d.close(); restore(); }
});

test('the key order’s first row is the main key: moved down, the next key is the main key and work runs there; the main row and the order are one setting', async () => {
  const { app, d, projectId, restore } = await setup();
  try {
    app.keeper.setRoute(projectId, { model: { provider: 'kestrel~1', id: 'kestrel-pro', thinking: 'high' }, backups: [{ provider: 'kestrel~2', id: 'kestrel-pro', thinking: 'high' }, { provider: 'merlin~1', id: 'merlin-flash', thinking: null }] });
    const rows = async () => order.orderRows((await modelProviderView(app, projectId)).route).map((r: { provider: string; id: string; thinking: string | null }) => ({ provider: r.provider, id: r.id, thinking: r.thinking }));
    assert.deepEqual((await rows()).map((r: { provider: string }) => r.provider), ['kestrel~1', 'kestrel~2', 'merlin~1']);
    // Row 1 moved down, as the page sends it.
    app.keeper.setRoute(projectId, order.orderBody(order.moveRow(await rows(), 0, 1), 'high'));
    const view = await modelProviderView(app, projectId);
    assert.deepEqual([view.route.main?.provider, view.route.main?.id, view.route.main?.thinking], ['kestrel~2', 'kestrel-pro', 'high'], 'the main row above shows the new main key');
    assert.deepEqual(view.route.backups.map((b) => b.provider), ['kestrel~1', 'merlin~1']);
    // The owner's work and the steps that follow the main model run on the new main key first.
    assert.equal((await app.keeper.providerState(projectId)).model?.provider, 'kestrel~2');
    const store = app.store(projectId);
    const checked = d.sent.length;
    app.keeper.setKeyLanes('kestrel~2', 1);
    const one = job(app, projectId, 'main', 'after the move');
    await until(() => store.jobs.get(one.id)?.status === 'Done');
    assert.ok(d.sent.slice(checked).some((s) => s.key === 'pk-test-k2-b7e1'), 'K two was asked');
    // The main key's model changed in the order's first row …
    const rowsNow = await rows();
    app.keeper.setRoute(projectId, order.orderBody(rowsNow.map((x: object, j: number) => (j === 0 ? { ...x, id: 'kestrel-flash' } : x)), 'high'));
    assert.equal((await modelProviderView(app, projectId)).route.main?.id, 'kestrel-flash', '… shows in the main row');
    // … and the main row's `Use` with M one shows in the order's first row; K two leaves the order's top.
    app.keeper.setRoute(projectId, { model: { provider: 'merlin~1', id: 'merlin-flash', thinking: 'high' } });
    assert.deepEqual((await rows()).map((r: { provider: string }) => r.provider), ['merlin~1', 'kestrel~1']);
  } finally { app.stopAll(); d.close(); restore(); }
});

test('every row of the key order chooses its key: an unused key takes the row, a key of another row changes places, and the key of row 1 chosen below makes the other the main key', async () => {
  const { app, d, projectId, restore } = await setup();
  try {
    family(app, 'osprey', d.url, ['osprey-1']);
    await app.keeper.addKey('osprey', 'O one', 'pk-test-o1-d5c3');
    app.keeper.setRoute(projectId, { model: { provider: 'kestrel~1', id: 'kestrel-pro', thinking: 'high' }, backups: [{ provider: 'kestrel~2', id: 'kestrel-flash', thinking: 'high' }, { provider: 'merlin~1', id: 'merlin-flash', thinking: 'low' }] });
    const view = () => modelProviderView(app, projectId);
    const rows = async () => order.orderRows((await view()).route).map((r: { provider: string; id: string; thinking: string | null }) => ({ provider: r.provider, id: r.id, thinking: r.thinking }));
    const shown = async () => (await rows()).map((r: { provider: string; id: string }) => `${r.provider}/${r.id}`);
    const key = async (id: string) => (await view()).keys.find((k) => k.id === id)!;
    const choose = async (row: number, id: string) => app.keeper.setRoute(projectId, order.orderBody(order.chooseKey(await rows(), row, await key(id), (await view()).route.main?.id), 'high'));
    // Row 2 to a key outside the order: it takes the row on its own model; K two leaves the order.
    await choose(1, 'osprey~1');
    assert.deepEqual(await shown(), ['kestrel~1/kestrel-pro', 'osprey~1/osprey-1', 'merlin~1/merlin-flash']);
    // Row 2 to the key of row 3: they change places, each on its model.
    await choose(1, 'merlin~1');
    assert.deepEqual(await shown(), ['kestrel~1/kestrel-pro', 'merlin~1/merlin-flash', 'osprey~1/osprey-1']);
    assert.equal((await view()).route.main?.provider, 'kestrel~1', 'the main key is as it was');
    // Row 2 to the key of row 1: M one is the main key, and the main row above shows it; K one is in row 2.
    await choose(1, 'kestrel~1');
    const after = await view();
    assert.deepEqual([after.route.main?.provider, after.route.main?.id, after.route.main?.thinking], ['merlin~1', 'merlin-flash', 'high']);
    assert.deepEqual(after.route.backups.map((b) => `${b.provider}/${b.id}`), ['kestrel~1/kestrel-pro', 'osprey~1/osprey-1']);
    assert.equal((await app.keeper.providerState(projectId)).model?.provider, 'merlin~1', 'work runs on the new main key');
  } finally { app.stopAll(); d.close(); restore(); }
});

test('each key runs at most its own number of jobs at once, and the total is their sum', async () => {
  const { app, d, projectId, restore } = await setup();
  try {
    app.keeper.setRoute(projectId, { model: { provider: 'kestrel~1', id: 'kestrel-pro', thinking: null }, backups: [{ provider: 'kestrel~2', id: 'kestrel-pro', thinking: null }] });
    app.keeper.setKeyLanes('kestrel~1', 2);
    const state = app.keeper.laneState(projectId);
    assert.deepEqual(state.keys.map((k) => [k.provider, k.lanes]), [['kestrel~1', 2], ['kestrel~2', 1]], 'the keys of this route, each with its own number');
    assert.equal(state.total, 3, 'together, three at once');
    const release = gate(d);
    const store = app.store(projectId);
    const jobs = [1, 2, 3, 4, 5].map((n) => job(app, projectId, null, `job ${n}`));
    await until(() => (d.inFlight.get('pk-test-k1-a8f0') ?? 0) === 2 && (d.inFlight.get('pk-test-k2-b7e1') ?? 0) === 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(jobs.filter((j) => store.jobs.get(j.id)?.status === 'Running').length, 3, 'three run, two wait');
    release();
    await until(() => jobs.every((j) => store.jobs.get(j.id)?.status === 'Done'));
    assert.equal(d.maxInFlight.get('pk-test-k1-a8f0'), 2, 'never more than its number on K one');
    assert.equal(d.maxInFlight.get('pk-test-k2-b7e1'), 1, 'nor on K two');
  } finally { app.stopAll(); d.close(); restore(); }
});

test('a change of route applies to the jobs that start after it; a running job is not interrupted', async () => {
  const { app, d, projectId, restore } = await setup();
  try {
    app.keeper.setRoute(projectId, { model: { provider: 'kestrel~1', id: 'kestrel-pro', thinking: null }, backups: [] });
    const store = app.store(projectId);
    const release = gate(d);
    const running = job(app, projectId, 'main', 'running when the route changes');
    await until(() => store.jobs.get(running.id)?.status === 'Running' && (d.inFlight.get('pk-test-k1-a8f0') ?? 0) === 1);
    app.keeper.setRoute(projectId, { model: { provider: 'kestrel~1', id: 'kestrel-flash', thinking: null } });
    release();
    await until(() => store.jobs.get(running.id)?.status === 'Done');
    assert.equal(store.jobs.get(running.id)!.model?.id, 'kestrel-pro', 'it ran to its end on the model it started on');
    const after = job(app, projectId, 'main', 'started after the change');
    await until(() => store.jobs.get(after.id)?.status === 'Done');
    assert.equal(store.jobs.get(after.id)!.model?.id, 'kestrel-flash');
  } finally { app.stopAll(); d.close(); restore(); }
});

test('removing a key that carries work moves the work on to the next key, in its own session; with no key left it waits and says why', async () => {
  const { app, d, projectId, restore } = await setup();
  try {
    app.keeper.setRoute(projectId, { model: { provider: 'kestrel~1', id: 'kestrel-pro', thinking: null }, backups: [{ provider: 'kestrel~2', id: 'kestrel-pro', thinking: null }] });
    app.keeper.setKeyLanes('kestrel~2', 1);
    const store = app.store(projectId);
    let release = gate(d);
    const moved = job(app, projectId, 'main', 'moves on');
    await until(() => store.jobs.get(moved.id)?.status === 'Running' && store.jobs.get(moved.id)?.model?.provider === 'kestrel~1' && (d.inFlight.get('pk-test-k1-a8f0') ?? 0) === 1);
    const r = await app.keeper.removeKey('kestrel~1');
    assert.equal(r.rerouted, 1);
    release();
    await until(() => store.jobs.get(moved.id)?.status === 'Done');
    assert.equal(store.jobs.get(moved.id)!.model?.provider, 'kestrel~2', 'the next key finished it');
    assert.ok(store.traceByJob(moved.id).some((t) => /continues its own session/.test(t.summary)), 'in its own session');

    // The last key of the route goes too: the work waits, saying why.
    release = gate(d);
    const stuck = job(app, projectId, 'main', 'nowhere to go');
    await until(() => store.jobs.get(stuck.id)?.status === 'Running' && store.jobs.get(stuck.id)?.model?.provider === 'kestrel~2');
    await app.keeper.removeKey('kestrel~2');
    release();
    await until(() => store.jobs.get(stuck.id)?.status !== 'Running');
    const waiting = store.jobs.get(stuck.id)!;
    assert.equal(waiting.status, 'Waiting for quota');
    assert.match(waiting.error ?? '', /The key K two was removed while this work ran on it, and no other usable key is left/);
  } finally { app.stopAll(); d.close(); restore(); }
});

test('Usage per round per model: one row per round, its time and cost, split by model with the steps, keys, time, tokens and cost of each; a model without a price says so', () => {
  const round = (id: string, number: number, startedAt: string, endedAt: string) => ({ id, number, kind: number === 1 ? 'First usable' : 'Deepen', status: 'Done', startedAt, endedAt, rootJobId: `${id}-root` });
  const rounds = [round('r1', 1, '2026-10-02T10:00:00Z', '2026-10-02T11:00:00Z'), round('r2', 2, '2026-10-02T12:00:00Z', '2026-10-02T14:00:00Z')];
  let n = 0;
  const j = (roundId: string, kind: string, provider: string, model: string, ms: number, cost: number | null, parentJobId: string | null = null) => ({
    id: `job${++n}`, step: kind === 'subagent' ? null : { roundId, kind, path: null }, parentJobId, agent: 'pi', model: { provider, id: model, thinking: 'max' },
    usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost }, timing: { wallMs: ms, generationMs: ms, toolMs: 0, queueMs: 0, parseRetryMs: 0, otherMs: 0 }, startedAt: '2026-10-02T10:00:00Z', endedAt: '2026-10-02T10:10:00Z',
  });
  const jobs = [
    j('r1', 'session-drafts', 'zai-coding-cn-team', 'glm-5.3', 600_000, 1),
    j('r1', 'main', 'zai-coding-cn', 'glm-5.3', 3_600_000, 8),
    j('r2', 'main', 'zai-coding-cn', 'glm-5.3', 1_800_000, 4),
    j('r2', 'lane', 'zai-coding-cn-team', 'glm-5.3', 900_000, 2),
    j('r2', 'lane', 'zai-coding-cn', 'glm-5.3', 900_000, 2),
    j('r2', 'spot-check', 'deepseek', 'deepseek-flash', 300_000, 0.5),
    { ...j('r2', 'lane', 'zai', 'glm-5.3-highspeed', 120_000, 0), id: 'unpriced' },
    { id: 'prog', step: { roundId: 'r2', kind: 'ledger', path: null }, parentJobId: null, agent: 'program', model: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, timing: null, startedAt: null, endedAt: null },
  ];
  const kids = [{ ...j('', 'subagent', 'zai-coding-cn', 'glm-5.3', 60_000, 0.25, jobs[2]!.id) }];
  const store = { clerkRounds: { all: () => rounds }, jobs: { all: () => [...jobs, ...kids] } };
  const names: Record<string, string> = { 'zai-coding-cn': 'Zhipu', 'zai-coding-cn-team': 'Zhipu team', zai: 'Z.ai', deepseek: 'DeepSeek' };
  const out = usageByRound(store as never, {
    keyName: (id) => names[id] ?? id,
    familyOf: (id) => (id === 'zai-coding-cn-team' ? 'zai-coding-cn' : id),
    priced: (_p, m) => m !== 'glm-5.3-highspeed',
  }, Date.parse('2026-10-02T15:00:00Z'));
  assert.deepEqual(out.map((r) => r.number), [2, 1], 'newest first');
  const [r2, r1] = out;
  assert.equal(r1!.wallMs, 3_600_000);
  assert.deepEqual(r1!.byModel.map((m) => [m.model, m.keys, m.steps, m.timeMs, m.cost]), [['zai-coding-cn/glm-5.3', ['Zhipu', 'Zhipu team'], [{ kind: 'session-drafts', count: 1 }, { kind: 'main', count: 1 }], 4_200_000, 9]], 'the same model on two keys is one row naming both keys');
  assert.equal(r1!.cost, 9);
  const glm = r2!.byModel.find((m) => m.model === 'zai-coding-cn/glm-5.3')!;
  assert.deepEqual(glm.steps, [{ kind: 'main', count: 1 }, { kind: 'lane', count: 2 }, { kind: 'subagent', count: 1 }]);
  assert.equal(glm.input, 4000);
  assert.equal(glm.cost, 8.25);
  const ds = r2!.byModel.find((m) => m.model === 'deepseek/deepseek-flash')!;
  assert.deepEqual([ds.steps, ds.timeMs, ds.cost, ds.priced], [[{ kind: 'spot-check', count: 1 }], 300_000, 0.5, true]);
  const unpriced = r2!.byModel.find((m) => m.model === 'zai/glm-5.3-highspeed')!;
  assert.deepEqual([unpriced.priced, unpriced.cost, unpriced.input, unpriced.output], [false, null, 1000, 100], 'no price reported: the tokens are given');
  assert.equal(r2!.cost, 8.75, 'the round’s cost is what was priced');
  assert.ok(!r2!.byModel.some((m) => m.model.includes('null')), 'the program’s own steps are not a model');
});
