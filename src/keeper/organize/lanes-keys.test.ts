/**
 * The main agent's lanes on several keys (D99; E148 D-c; build plan §2 "各路"), against local key doubles in the style of
 * keys.test.ts: the main job sends its lanes in one `pk_send_lanes` call and waits parked while they run on the free slots
 * of every key; a lane a key refuses with a rate limit goes on in its own session on another key and the main job gets its
 * real report; a lane that fails three times comes back Listed; after a restart the main job goes on in its session and
 * sends the same call again, and no lane is sent twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKELETON_SLOTS } from './slots.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-pi-agent-'));
// pi retries a 429 itself; here every limit should reach the runtime at once.
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
const { App } = await import('../../server/app.ts');

type Msg = { role: string; content: unknown; tool_call_id?: string };
type Body = { messages?: Msg[] };
type Answer =
  | { readonly text: string; readonly delayMs?: number }
  | { readonly tool: string; readonly args: Record<string, unknown> }
  | { readonly status: number; readonly error: Record<string, unknown>; readonly delayMs?: number };

const contentOf = (m: Msg): string => (typeof m.content === 'string' ? m.content : ((m.content as { text?: string }[] | null) ?? []).map((p) => p.text ?? '').join('\n'));
const firstUser = (b: Body): string => contentOf(b.messages?.find((m) => m.role === 'user') ?? { role: 'user', content: '' });
const lastMsg = (b: Body): Msg | undefined => b.messages?.[b.messages.length - 1];
const laneOf = (b: Body): string | null => /Task: a lane of this round — (\S+) \(/.exec(firstUser(b))?.[1] ?? null;
const sent = (b: Body): string => JSON.stringify(b.messages ?? []);

interface Key { readonly id: string; url: string; bodies: Body[]; close(): void }
/** One key double: every request is answered by `answer`, which sees the key and the request. */
function key(id: string, answer: (k: Key, b: Body) => Answer): Promise<Key> {
  const k: Key = { id, url: '', bodies: [], close: () => undefined };
  const chunk = (delta: object, finish: string | null) => ({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      let body: Body = {};
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8')) as Body; } catch { /* keep empty */ }
      k.bodies.push(body);
      const a = answer(k, body);
      const reply = () => {
        if (res.destroyed) return;
        if ('status' in a) {
          res.writeHead(a.status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
          res.end(JSON.stringify({ error: a.error }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if ('tool' in a) {
          res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${k.bodies.length}`, type: 'function', function: { name: a.tool, arguments: JSON.stringify(a.args) } }] }, null))}\n\n`);
          res.write(`data: ${JSON.stringify({ ...chunk({}, 'tool_calls'), usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: a.text }, null))}\n\n`);
          res.write(`data: ${JSON.stringify({ ...chunk({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
        }
        res.end('data: [DONE]\n\n');
      };
      const delay = 'delayMs' in a ? a.delayMs ?? 0 : 0;
      if (delay) setTimeout(reply, delay).unref(); else reply();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    k.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    k.close = () => { server.closeAllConnections?.(); server.close(); };
    resolve(k);
  }));
}

async function until(check: () => boolean, ms = 30_000): Promise<void> {
  for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error('timed out');
}

type AppT = InstanceType<typeof App>;
function useKeys(app: AppT, keys: readonly Key[], lanesPerKey: number): void {
  for (const k of keys) {
    app.keeper.models.registerProvider(k.id, { name: k.id, baseUrl: k.url, apiKey: 'test-key', api: 'openai-completions', models: [{ id: 'm', name: 'M', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }] });
  }
  app.keeper.setModel({ provider: keys[0]!.id, id: 'm', thinking: null }, keys.slice(1).map((k) => ({ provider: k.id, id: 'm', thinking: null })));
  app.keeper.setLanesPerKey(lanesPerKey);
}

/** A project with a round in its skeleton stage and a Brief per lane, as the main agent leaves them before sending. */
async function roundWithBriefs(names: readonly string[], home = mkdtempSync(join(tmpdir(), 'pk-home-'))) {
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-proj-'));
  writeFileSync(join(projectDir, 'README.md'), '# Demo\n\nA project for the lanes test.\n');
  const app = new App(home, { organizing: false });
  const project = app.addProject('Demo', [projectDir]);
  await app.intakeProject(project.id);
  app.stopAll();
  await app.initKeeper();
  const store = app.store(project.id);
  const root = app.keeper.recordProgramJob(project.id, { kind: 'Organizing', scope: { kind: 'clerk-round', ids: ['crd_t'], label: 'Takeover round 1' }, step: null, parentJobId: null, task: { kind: 'clerk-round', roundId: 'crd_t' } });
  const at = new Date().toISOString();
  store.clerkRounds.put({
    id: 'crd_t', projectId: project.id, kind: 'First usable', number: 1, startedAt: at, endedAt: null, status: 'Running', rootJobId: root.id,
    questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: at,
    stage: 'skeleton', stageLog: [{ stage: 'orientation', startedAt: at, endedAt: at, timing: null }, { stage: 'skeleton', startedAt: at, endedAt: null, timing: null }], lanes: [],
    // DB: these tests are about lanes and keys; the slots no lane holds have their reasons on the round already.
    emptySlots: SKELETON_SLOTS.map((s) => ({ slot: s.slot, why: 'The fixture has no such material.', at })),
  });
  for (const n of names) store.roundDocs.put({ id: `rdoc_${n}`, projectId: project.id, roundId: 'crd_t', jobId: null, kind: 'Brief', path: n, title: `Brief ${n}`, markdown: `Answer the question of ${n}.`, at });
  const lanes = names.map((n) => ({ name: n, kind: 'slot', briefDocId: `rdoc_${n}`, slots: ['threads'] }));
  const main = () => app.keeper.enqueue(project.id, {
    kind: 'Organizing', initiator: 'auto', priority: 1, scope: { kind: 'clerk-step', ids: ['crd_t'], label: 'Main agent' },
    prompt: 'Task: the main agent of this round — send the lanes of the skeleton.', parentJobId: root.id,
    step: { roundId: 'crd_t', kind: 'main', path: null }, task: { kind: 'clerk-step', roundId: 'crd_t', route: 'main' },
  });
  return { app, project, store, lanes, main, home };
}

/** The main job's side: send the lanes, then end with what it got back. */
const mainAnswer = (lanes: readonly unknown[]) => (b: Body): Answer => (lastMsg(b)?.role === 'tool' ? { text: 'The lanes are back.' } : { tool: 'pk_send_lanes', args: { lanes } });

test('five lanes sent in one call run at once across three keys of two slots; one a key refuses goes on on another key, and the main job gets its real report', { timeout: 120_000 }, async () => {
  const names = ['L1', 'L2', 'L3', 'L4', 'L5'];
  const r = await roundWithBriefs(names);
  let running = 0;
  let most = 0;
  let refusedBy: string | null = null;
  const answer = (k: Key, b: Body): Answer => {
    const lane = laneOf(b);
    if (!lane) return mainAnswer(r.lanes)(b);
    // Every lane request is under way until it is answered: the refused one for 400 ms, the others for 1.5 s.
    const refuse = lane === 'L3' && refusedBy === null;
    const ms = refuse ? 400 : 1_500;
    running++; most = Math.max(most, running);
    setTimeout(() => { running--; }, ms).unref();
    // L3's first request is refused with a rate limit once every lane is under way.
    if (refuse) { refusedBy = k.id; return { status: 429, error: { code: '1302', message: '您的账户已达到速率限制，请您控制请求频率' }, delayMs: ms }; }
    return { text: `Report of ${lane}: wrote its slots.`, delayMs: ms };
  };
  const keys = await Promise.all(['zai-a', 'zai-b', 'zai-c'].map((id) => key(id, answer)));
  try {
    useKeys(r.app, keys, 2);
    await r.app.keeper.providerState();
    const main = r.main();
    await until(() => r.store.jobs.get(main.id)?.status === 'Done', 60_000);
    const lanes = r.store.jobs.filter((j) => j.parentJobId === main.id);
    assert.deepEqual(lanes.map((j) => j.step?.path).sort(), names, 'one job per lane, none twice');
    assert.ok(lanes.every((j) => j.step?.kind === 'lane' && j.status === 'Done'), lanes.map((j) => `${j.step?.path}=${j.status}:${j.error ?? ''}`).join('; '));
    assert.ok(most >= 5, `five lanes ran at the same time: at most ${most}`);
    const inFlight = keys.flatMap((k) => k.bodies).filter((b) => laneOf(b)).length;
    assert.ok(inFlight >= 6, `every lane was sent, and L3 twice: ${inFlight}`);
    const l3 = lanes.find((j) => j.step?.path === 'L3')!;
    assert.ok(refusedBy && l3.model?.provider !== refusedBy, `L3 went on on another key than ${refusedBy}: ${l3.model?.provider}`);
    const l3Second = keys.flatMap((k) => k.bodies).filter((b) => laneOf(b) === 'L3').at(-1)!;
    assert.match(sent(l3Second), /The model provider interrupted this work/, 'in its own session');
    assert.equal(l3.resultText, 'Report of L3: wrote its slots.');
    // The main job was given every lane's real summary.
    const back = keys.flatMap((k) => k.bodies).find((b) => /the main agent/.test(firstUser(b)) && lastMsg(b)?.role === 'tool')!;
    const result = contentOf(lastMsg(back)!);
    for (const n of names) assert.ok(result.includes(`Report of ${n}: wrote its slots.`), `the main job has ${n}'s report: ${result.slice(0, 400)}`);
    assert.doesNotMatch(result, /Waiting for quota/, 'a lane the provider interrupted is not returned as unanswered');
    const recorded = r.store.clerkRounds.get('crd_t')!.lanes!;
    assert.deepEqual(recorded.map((l) => l.name), names);
    assert.ok(recorded.every((l) => l.stage === 'skeleton'));
  } finally { for (const k of keys) k.close(); r.app.stopAll(); }
});

test('a lane that fails three times comes back Listed, and the main job goes on with the others', { timeout: 120_000 }, async () => {
  const r = await roundWithBriefs(['good', 'bad']);
  const answer = (_k: Key, b: Body): Answer => {
    const lane = laneOf(b);
    if (!lane) return mainAnswer(r.lanes)(b);
    if (lane === 'bad') return { status: 400, error: { message: 'invalid request: the lane cannot be answered', type: 'invalid_request_error' } };
    return { text: 'Report of good.' };
  };
  const keys = await Promise.all(['zai-a', 'zai-b'].map((id) => key(id, answer)));
  try {
    useKeys(r.app, keys, 2);
    await r.app.keeper.providerState();
    const main = r.main();
    await until(() => r.store.jobs.get(main.id)?.status === 'Done', 60_000);
    const bad = r.store.jobs.find((j) => j.parentJobId === main.id && j.step?.path === 'bad')!;
    assert.equal(bad.status, 'Failed');
    assert.equal(keys.flatMap((k) => k.bodies).filter((b) => laneOf(b) === 'bad').length, 3, 'run three times');
    const back = keys.flatMap((k) => k.bodies).find((b) => /the main agent/.test(firstUser(b)) && lastMsg(b)?.role === 'tool')!;
    const result = JSON.parse(contentOf(lastMsg(back)!)) as { name: string; status: string; summary: string }[];
    assert.deepEqual(result.map((l) => [l.name, l.status]), [['good', 'Done'], ['bad', 'Listed']]);
    assert.match(result[1]!.summary, /Failed 3 times/);
  } finally { for (const k of keys) k.close(); r.app.stopAll(); }
});

test('a restart while lanes run: the main job goes on in its session, sends the same call again, and no lane is sent twice', { timeout: 120_000 }, async () => {
  const first = await roundWithBriefs(['quick', 'slow']);
  let hold = true;
  const answer = (_k: Key, b: Body): Answer => {
    const lane = laneOf(b);
    if (!lane) return mainAnswer(first.lanes)(b);
    if (lane === 'slow' && hold) return { text: 'never sent', delayMs: 600_000 };
    return { text: `Report of ${lane}.` };
  };
  const keys = await Promise.all(['zai-a', 'zai-b'].map((id) => key(id, answer)));
  let second: AppT | null = null;
  try {
    useKeys(first.app, keys, 2);
    await first.app.keeper.providerState();
    const main = first.main();
    const store1 = first.store;
    await until(() => store1.jobs.find((j) => j.step?.path === 'quick')?.status === 'Done' && store1.jobs.find((j) => j.step?.path === 'slow')?.status === 'Running');
    // ProjectKeeper stops while the main job waits for the slow lane: on disk both read as a restart leaves them.
    assert.ok(first.app.keeper.stopJob(first.project.id, main.id));
    await until(() => store1.jobs.get(main.id)?.status === 'Stopped' && store1.jobs.find((j) => j.step?.path === 'slow')?.status === 'Stopped');
    assert.equal(store1.jobs.find((j) => j.step?.path === 'slow')!.resume ?? null, null, 'the Stop on the main job reached its lane (E148 D-i)');
    for (const id of [main.id, store1.jobs.find((j) => j.step?.path === 'slow')!.id]) {
      store1.jobs.put({ ...store1.jobs.get(id)!, status: 'Running', endedAt: null, error: null });
    }
    first.app.stopAll();
    await first.app.flushAll();

    second = new App(first.home, { organizing: false });
    await second.initKeeper();
    const store = second.store(first.project.id);
    const slow = store.jobs.find((j) => j.step?.path === 'slow')!;
    assert.equal(store.jobs.get(main.id)!.resume?.why, 'restart');
    assert.equal(slow.resume?.why, 'restart', 'the lane is marked to go on in its session');
    useKeys(second, keys, 2);
    await second.keeper.providerState();
    hold = false;
    const quickRequests = keys.flatMap((k) => k.bodies).filter((b) => laneOf(b) === 'quick').length;
    assert.ok(second.keeper.restartJob(first.project.id, main.id), 'the planner runs the main job again');
    await until(() => store.jobs.get(main.id)?.status === 'Done', 60_000);
    const lanes = store.jobs.filter((j) => j.parentJobId === main.id);
    assert.deepEqual(lanes.map((j) => j.step?.path).sort(), ['quick', 'slow'], 'no lane was sent twice');
    assert.equal(keys.flatMap((k) => k.bodies).filter((b) => laneOf(b) === 'quick').length, quickRequests, 'the finished lane did not run again');
    const slowLast = keys.flatMap((k) => k.bodies).filter((b) => laneOf(b) === 'slow').at(-1)!;
    assert.match(sent(slowLast), /ProjectKeeper restarted while this work was running/, 'the slow lane went on in its own session');
    const mainBodies = keys.flatMap((k) => k.bodies).filter((b) => /the main agent/.test(firstUser(b)));
    assert.ok(mainBodies.some((b) => /ProjectKeeper restarted while this work was running/.test(sent(b))), 'and so did the main job');
    const back = mainBodies.filter((b) => lastMsg(b)?.role === 'tool').at(-1)!;
    const result = JSON.parse(contentOf(lastMsg(back)!)) as { name: string; status: string; summary: string }[];
    assert.deepEqual(result.map((l) => [l.name, l.status, l.summary]), [['quick', 'Done', 'Report of quick.'], ['slow', 'Done', 'Report of slow.']]);
  } finally { for (const k of keys) k.close(); first.app.stopAll(); second?.stopAll(); }
});

test('pausing stops the main job and its lanes to go on in their sessions; resuming continues them', { timeout: 120_000 }, async () => {
  const r = await roundWithBriefs(['one', 'two']);
  let hold = true;
  const answer = (_k: Key, b: Body): Answer => {
    const lane = laneOf(b);
    if (!lane) return mainAnswer(r.lanes)(b);
    return hold ? { text: 'never sent', delayMs: 600_000 } : { text: `Report of ${lane}.` };
  };
  const keys = await Promise.all(['zai-a', 'zai-b'].map((id) => key(id, answer)));
  try {
    useKeys(r.app, keys, 2);
    await r.app.keeper.providerState();
    const main = r.main();
    const lanes = () => r.store.jobs.filter((j) => j.parentJobId === main.id);
    await until(() => lanes().length === 2 && lanes().every((j) => j.status === 'Running'));
    r.app.pauseOrganizing(r.project.id, true);
    await until(() => r.store.jobs.get(main.id)?.status === 'Paused' && lanes().every((j) => j.status === 'Paused'));
    for (const j of [r.store.jobs.get(main.id)!, ...lanes()]) assert.equal(j.resume?.why, 'pause', `${j.scope.label} is marked to go on`);
    hold = false;
    r.app.pauseOrganizing(r.project.id, false);
    await until(() => r.store.jobs.get(main.id)?.status === 'Done', 60_000);
    assert.equal(lanes().length, 2, 'no lane sent twice');
    assert.ok(lanes().every((j) => j.status === 'Done'));
    const bodies = keys.flatMap((k) => k.bodies);
    assert.ok(bodies.filter((b) => laneOf(b) === 'one').at(-1) && /The owner paused organizing/.test(sent(bodies.filter((b) => laneOf(b) === 'one').at(-1)!)), 'the lane went on in its own session');
    const back = bodies.filter((b) => /the main agent/.test(firstUser(b)) && lastMsg(b)?.role === 'tool').at(-1)!;
    const result = JSON.parse(contentOf(lastMsg(back)!)) as { name: string; status: string }[];
    assert.deepEqual(result.map((l) => [l.name, l.status]), [['one', 'Done'], ['two', 'Done']]);
  } finally { for (const k of keys) k.close(); r.app.stopAll(); }
});
