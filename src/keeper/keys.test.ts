/**
 * Several keys (owner 2026-09-18: three Zhipu Coding Plan keys in parallel; when one reaches its five-hour limit, move to
 * the next; it comes back later). A key that reports its quota window is left until the time it names and the work
 * moves to the next key; when every key is out, work waits for the first to come back instead of being sent to a key
 * that refuses it. An extra key for a known provider runs as a provider of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-pi-agent-'));
// pi retries a 429 itself; here every limit should reach the runtime at once.
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
const { classifyError, quotaResetFrom, RATE_LIMIT_REST_MS } = await import('./runtime.ts');
const { App } = await import('../server/app.ts');

test('Zhipu limits are told apart by code: rate limits stay on the key, quota windows take it out of use', () => {
  assert.equal(classifyError('429: {"code":"1302","message":"Rate limit reached for requests"}'), 'ratelimit');
  assert.equal(classifyError('429: {"code":"1302","message":"您当前使用该API的并发数过高，请降低并发，或联系客服增加限额"}'), 'ratelimit');
  assert.equal(classifyError('429: {"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-09-18 17:08:09"}'), 'quota');
  assert.equal(classifyError('429: {"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-09-18 17:08:09 重置。"}'), 'quota');
  assert.equal(classifyError('429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-09-24 20:12:39"}'), 'quota');
  assert.equal(classifyError('insufficient_quota: You exceeded your current quota'), 'quota');
  assert.equal(classifyError('429 Too Many Requests'), 'ratelimit');
});

test('the reset time a quota message names is read as Beijing time, in either language', () => {
  assert.equal(quotaResetFrom('Usage limit reached for 5 hour. Your limit will reset at 2026-09-18 17:08:09', 'zai-coding-cn-team'), '2026-09-18T09:08:09.000Z');
  assert.equal(quotaResetFrom('已达到 5 小时的使用上限。您的限额将在 2026-09-18 17:08:09 重置。', 'zai'), '2026-09-18T09:08:09.000Z');
  assert.equal(quotaResetFrom('Rate limit reached for requests', 'zai'), null);
});

test('an extra key for a known provider runs as a provider of its own, with the key read from the variable it names', async () => {
  const open = async (key: string | undefined) => {
    if (key === undefined) delete process.env.PK_TEST_TEAM_KEY; else process.env.PK_TEST_TEAM_KEY = key;
    const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')), { organizing: false });
    app.workspace.setSettings({ extraKeys: [{ provider: 'zai-coding-cn-team', like: 'zai-coding-cn', apiKeyEnv: 'PK_TEST_TEAM_KEY' }] });
    await app.initKeeper();
    return app;
  };
  const withKey = await open('test-value');
  try {
    const like = withKey.keeper.models.getModels('zai-coding-cn');
    const extra = withKey.keeper.models.getModels('zai-coding-cn-team');
    assert.ok(like.length > 0);
    assert.deepEqual(extra.map((m) => m.id), like.map((m) => m.id), 'the same models');
    assert.equal(extra[0]!.baseUrl, like[0]!.baseUrl, 'the same endpoint');
    assert.deepEqual(extra.find((m) => m.id === 'glm-5.3')?.thinkingLevelMap, like.find((m) => m.id === 'glm-5.3')?.thinkingLevelMap, 'the same thinking levels');
    assert.ok((await withKey.keeper.models.getAvailable('zai-coding-cn-team')).length > 0, 'usable with the variable set');
  } finally { withKey.stopAll(); }
  const without = await open(undefined);
  try {
    assert.equal((await without.keeper.models.getAvailable('zai-coding-cn-team')).length, 0, 'not usable without the variable');
  } finally { without.stopAll(); delete process.env.PK_TEST_TEAM_KEY; }
});

test('an extra key for a provider pi does not know brings its own endpoint and models, and runs as a provider of its own', async () => {
  process.env.PK_TEST_OWN_KEY = 'test-value';
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')), { organizing: false });
  app.workspace.setSettings({ extraKeys: [{
    provider: 'kestrel-ai', apiKeyEnv: 'PK_TEST_OWN_KEY', name: 'Kestrel AI', baseUrl: 'https://api.kestrel.example/v1', api: 'openai-completions',
    models: [{ id: 'kestrel-pro', reasoning: true, contextWindow: 1048576, maxTokens: 131072, compat: { thinkingFormat: 'deepseek', supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' } }],
  }] });
  await app.initKeeper();
  try {
    const own = app.keeper.models.getModels('kestrel-ai');
    assert.deepEqual(own.map((m) => m.id), ['kestrel-pro'], 'its own models');
    assert.equal(own[0]!.baseUrl, 'https://api.kestrel.example/v1', 'its own endpoint');
    assert.equal(own[0]!.api, 'openai-completions');
    assert.equal(own[0]!.contextWindow, 1048576);
    assert.equal(own[0]!.reasoning, true);
    assert.equal((own[0]!.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat, 'deepseek', 'how it is asked to think');
    assert.ok((await app.keeper.models.getAvailable('kestrel-ai')).length > 0, 'usable with the variable set');
  } finally { app.stopAll(); delete process.env.PK_TEST_OWN_KEY; }
});

/** Beijing wall-clock time, as Z.ai and Zhipu write it in their limit messages. */
const beijing = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');

interface Key { url: string; requests: number; limitedUntil: number; rateLimits: number; plan: ('tool' | 'ratelimit')[]; bodies: { messages?: unknown[] }[]; close(): void }
/** A Coding Plan key: answers, or while inside its window refuses with code 1308 and the reset time; `rateLimits` times first, a rate limit (1302).
 *  `plan` scripts the next requests in turn: a call to pi's `read` tool for README.md, or a rate limit. Every request's body is kept. */
function key(): Promise<Key> {
  const k: Key = { url: '', requests: 0, limitedUntil: 0, rateLimits: 0, plan: [], bodies: [], close: () => undefined };
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      k.requests++;
      try { k.bodies.push(JSON.parse(Buffer.concat(parts).toString('utf8')) as { messages?: unknown[] }); } catch { k.bodies.push({}); }
      const next = k.plan.shift();
      if (next === 'ratelimit' || (next === undefined && k.rateLimits > 0)) {
        if (next === undefined) k.rateLimits--;
        res.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' });
        res.end(JSON.stringify({ error: { code: '1302', message: '您的账户已达到速率限制，请您控制请求频率' } }));
        return;
      }
      if (Date.now() < k.limitedUntil) {
        res.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' });
        res.end(JSON.stringify({ error: { code: '1308', message: `Usage limit reached for 5 hour. Your limit will reset at ${beijing(k.limitedUntil)}` } }));
        return;
      }
      const chunk = (delta: object, finish: string | null) => ({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (next === 'tool') {
        res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${k.requests}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'README.md' }) } }] }, null))}\n\n`);
        res.write(`data: ${JSON.stringify({ ...chunk({}, 'tool_calls'), usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'Done.' }, null))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    k.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    k.close = () => server.close();
    resolve(k);
  }));
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error('timed out');
}

test('a key at its five-hour limit is left until the time it names, ten minutes at most; work moves to the next key, and waits when none is left', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-proj-'));
  writeFileSync(join(projectDir, 'README.md'), '# Demo\n\nA project for the key test.\n');
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')), { organizing: false });
  const project = app.addProject('Demo', [projectDir]);
  await app.intakeProject(project.id);
  app.stopAll();
  await app.initKeeper();
  const a = await key(), b = await key();
  try {
    for (const [id, k] of [['zai-a', a], ['zai-b', b]] as const) {
      app.keeper.models.registerProvider(id, { name: id, baseUrl: k.url, apiKey: 'test-key', api: 'openai-completions', models: [{ id: 'm', name: 'M', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }] });
    }
    app.keeper.setModel({ provider: 'zai-a', id: 'm', thinking: null }, [{ provider: 'zai-b', id: 'm', thinking: null }]);
    app.keeper.setLanesPerKey(1);
    await app.keeper.providerState();
    const store = app.store(project.id);
    const job = (label: string) => app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label }, prompt: 'Organize.' });

    // Key a is inside its window: the work runs on key b, and key a stays out of use until the time it named, ten minutes
    // at most: the owner may restore a key's quota by hand, so it is tried again then (owner 2026-09-28).
    a.limitedUntil = Date.now() + 60 * 60_000;
    const first = job('first');
    await until(() => store.jobs.get(first.id)?.status === 'Done');
    assert.equal(store.jobs.get(first.id)?.model?.provider, 'zai-b');
    const keyA = app.keeper.laneState().keys.find((k) => k.provider === 'zai-a')!;
    assert.equal(keyA.capacity, 0);
    const restEnd = Date.parse(keyA.exhaustedUntil!);
    assert.ok(restEnd < a.limitedUntil && Math.abs(restEnd - (Date.now() + RATE_LIMIT_REST_MS)) < 15_000, `rests ten minutes, not the hour it named: ${keyA.exhaustedUntil}`);
    const sentToA = a.requests;
    const second = job('second');
    await until(() => store.jobs.get(second.id)?.status === 'Done');
    assert.equal(a.requests, sentToA, 'nothing more is sent to a key inside its window');

    // Key b reaches its limit too: the work waits, nothing is sent to either key, and it runs when key b comes back.
    b.limitedUntil = Date.now() + 3_000;
    const third = job('third');
    await until(() => store.jobs.get(third.id)?.status === 'Waiting for quota');
    const sent = a.requests + b.requests;
    await new Promise((r) => setTimeout(r, 1_200));
    assert.equal(a.requests + b.requests, sent, 'no key is sent work while every key is out');
    await until(() => store.jobs.get(third.id)?.status === 'Done');
    assert.equal(store.jobs.get(third.id)?.model?.provider, 'zai-b');
    const switches = (await app.keeper.providerState()).switches;
    assert.equal(switches.filter((s) => s.from === 'zai-a').length, 1, 'one switch recorded per key and window');

    // Work queued again with the answer that sent it back shows that answer while it waits; the run that starts clears it,
    // so work that then finishes does not show an earlier error.
    store.jobs.put({ ...store.jobs.get(third.id)!, status: 'Queued', error: '429: {"code":"1302","message":"rate limit"}', endedAt: null });
    (app.keeper as unknown as { pump(projectId: string): void }).pump(project.id);
    await until(() => store.jobs.get(third.id)?.status === 'Done');
    assert.equal(store.jobs.get(third.id)?.error ?? null, null, 'finished work carries no error from the run before');
  } finally { a.close(); b.close(); app.stopAll(); }
});

test('a job whose key answers a rate limit runs at once on the next key: it is not left waiting for the rest to end', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-proj-'));
  writeFileSync(join(projectDir, 'README.md'), '# Demo\n\nA project for the rate-limit test.\n');
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')), { organizing: false });
  const project = app.addProject('Demo', [projectDir]);
  await app.intakeProject(project.id);
  app.stopAll();
  await app.initKeeper();
  const a = await key(), b = await key();
  try {
    for (const [id, k] of [['zai-a', a], ['zai-b', b]] as const) {
      app.keeper.models.registerProvider(id, { name: id, baseUrl: k.url, apiKey: 'test-key', api: 'openai-completions', models: [{ id: 'm', name: 'M', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }] });
    }
    app.keeper.setModel({ provider: 'zai-a', id: 'm', thinking: null }, [{ provider: 'zai-b', id: 'm', thinking: null }]);
    app.keeper.setLanesPerKey(1);
    await app.keeper.providerState();
    const store = app.store(project.id);
    a.rateLimits = 1;
    const job = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'limited' }, prompt: 'Organize.' });
    await until(() => store.jobs.get(job.id)?.status === 'Done', 10_000);
    assert.equal(store.jobs.get(job.id)?.model?.provider, 'zai-b', 'the next key took it');
    assert.ok(a.requests >= 1, 'the first key was asked and answered the limit');
    const keyA = app.keeper.laneState().keys.find((k) => k.provider === 'zai-a')!;
    assert.equal(keyA.capacity, 0, 'the limited key rests');
    assert.ok(keyA.rateLimitedAt, 'and says since when');
  } finally { a.close(); b.close(); app.stopAll(); }
});

// ───────────── interrupted work goes on in its own session, on whichever key has room (Spec §3.10, D99) ─────────────

type AppT = InstanceType<typeof App>;
function useKeys(app: AppT, a: Key, b: Key): void {
  for (const [id, k] of [['zai-a', a], ['zai-b', b]] as const) {
    app.keeper.models.registerProvider(id, { name: id, baseUrl: k.url, apiKey: 'test-key', api: 'openai-completions', models: [{ id: 'm', name: 'M', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }] });
  }
  app.keeper.setModel({ provider: 'zai-a', id: 'm', thinking: null }, [{ provider: 'zai-b', id: 'm', thinking: null }]);
  app.keeper.setLanesPerKey(1);
}
async function demoProject(readme: string, home = mkdtempSync(join(tmpdir(), 'pk-home-'))) {
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-proj-'));
  writeFileSync(join(projectDir, 'README.md'), readme);
  const app = new App(home, { organizing: false });
  const project = app.addProject('Demo', [projectDir]);
  await app.intakeProject(project.id);
  app.stopAll();
  await app.initKeeper();
  return { app, project, home };
}
/** The pi session files that hold a job's work: its preamble names the job. */
function sessionFilesOf(jobId: string): string[] {
  const root = join(process.env.PI_CODING_AGENT_DIR!, 'sessions');
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true }) as string[]).map((f) => join(root, f)).filter((f) => f.endsWith('.jsonl') && readFileSync(f, 'utf8').includes(jobId));
}
const sent = (body: { messages?: unknown[] } | undefined) => JSON.stringify(body?.messages ?? []);

test('a job a rate limit interrupts mid-run goes on in its own session on the next key: what it read and reasoned is sent again, nothing starts over', async () => {
  const { app, project } = await demoProject('# Demo\n\nThe readme the job read before the limit.\n');
  const a = await key(), b = await key();
  try {
    useKeys(app, a, b);
    await app.keeper.providerState();
    const store = app.store(project.id);
    a.plan = ['tool', 'ratelimit'];   // the first turn reads the readme; the next request is refused
    const job = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'interrupted' }, prompt: 'Organize the readme.' });
    await until(() => store.jobs.get(job.id)?.status === 'Done', 10_000);
    const done = store.jobs.get(job.id)!;
    assert.equal(a.requests, 2, 'key a answered the first turn and then the limit');
    assert.equal(done.model?.provider, 'zai-b', 'the next key took it');
    assert.equal(b.requests, 1, 'key b finished it in one request');
    const toB = sent(b.bodies[0]);
    assert.ok(toB.includes('Organize the readme.'), 'the task is in the session sent to key b');
    assert.ok(toB.includes('The readme the job read before the limit.'), 'so is what it read on key a');
    assert.ok(toB.includes('The model provider interrupted this work'), 'and the continuation, in place of the task sent again');
    assert.equal((toB.match(/Organize the readme\./g) ?? []).length, 1, 'the task is not sent a second time');
    assert.ok(!toB.includes('速率限制'), 'the refused turn is not sent back to the provider');
    const files = sessionFilesOf(job.id);
    assert.deepEqual(files, [done.sessionFile], 'one session file, the job\'s own');
    assert.ok(readFileSync(done.sessionFile!, 'utf8').includes('"type":"model_change","id"') && /"provider":"zai-b"/.test(readFileSync(done.sessionFile!, 'utf8')), 'the session records the change of key');
    assert.ok(done.steps.some((s) => s.tool === 'read'), 'the step of the first run is kept');
    assert.equal(done.usage.input, 20, 'the usage of both runs, each response counted once');
    assert.equal(done.resume ?? null, null, 'nothing left to go on with');
    assert.ok(store.traceByJob(job.id).some((t) => /continues its own session on zai-b\/m/.test(t.summary)), 'the job\'s history says it went on');
  } finally { a.close(); b.close(); app.stopAll(); }
});

test('a job whose saved session cannot be read starts afresh and says why', async () => {
  const { app, project } = await demoProject('# Demo\n\nA project for the unreadable-session test.\n');
  const a = await key(), b = await key();
  try {
    useKeys(app, a, b);
    await app.keeper.providerState();
    const store = app.store(project.id);
    const job = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'unreadable' }, prompt: 'Organize the readme.' });
    await until(() => store.jobs.get(job.id)?.status === 'Done', 10_000);
    const broken = join(mkdtempSync(join(tmpdir(), 'pk-broken-')), 'session.jsonl');
    writeFileSync(broken, 'not a pi session\n');
    const before = a.requests;
    store.jobs.put({ ...store.jobs.get(job.id)!, status: 'Queued', endedAt: null, sessionFile: broken, resume: { why: 'provider', since: new Date().toISOString() } });
    (app.keeper as unknown as { pump(projectId: string): void }).pump(project.id);
    await until(() => a.requests > before && store.jobs.get(job.id)?.status === 'Done', 10_000);
    const done = store.jobs.get(job.id)!;
    const body = sent(a.bodies.at(-1));
    assert.ok(body.includes('Organize the readme.') && !body.includes('interrupted this work'), 'the task is sent whole, as a fresh start');
    assert.notEqual(done.sessionFile, broken, 'in a new session');
    assert.equal(readFileSync(broken, 'utf8'), 'not a pi session\n', 'the unreadable file is left as it was');
    const why = store.traceByJob(job.id).find((t) => /starts afresh/.test(t.summary));
    assert.ok(why && why.summary.includes('cannot be read'), `the history says why: ${why?.summary}`);
  } finally { a.close(); b.close(); app.stopAll(); }
});

test('a job left running by a restart and queued again goes on in its own session', async () => {
  const first = await demoProject('# Demo\n\nThe readme read before the restart.\n');
  const a = await key(), b = await key();
  let second: AppT | null = null;
  try {
    useKeys(first.app, a, b);
    await first.app.keeper.providerState();
    const store1 = first.app.store(first.project.id);
    a.plan = ['tool'];
    const job = first.app.keeper.enqueue(first.project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'restarted' }, prompt: 'Organize the readme.' });
    await until(() => store1.jobs.get(job.id)?.status === 'Done', 10_000);
    const ran = store1.jobs.get(job.id)!;
    // The process ends while the job runs: on disk it reads Running.
    store1.jobs.put({ ...ran, status: 'Running', endedAt: null, resultText: null });
    await first.app.flushAll();

    second = new App(first.home, { organizing: false });
    await second.initKeeper();
    const store = second.store(first.project.id);
    const stopped = store.jobs.get(job.id)!;
    assert.equal(stopped.status, 'Stopped');
    assert.match(stopped.error ?? '', /restarted while this work was running/);
    assert.equal(stopped.resume?.why, 'restart', 'marked to go on in its session');
    useKeys(second, a, b);
    await second.keeper.providerState();
    const before = a.requests;
    assert.ok(second.keeper.restartJob(first.project.id, job.id), 'queued again, as the round runs it again');
    await until(() => store.jobs.get(job.id)?.status === 'Done', 10_000);
    const done = store.jobs.get(job.id)!;
    assert.equal(a.requests, before + 1);
    const body = sent(a.bodies.at(-1));
    assert.ok(body.includes('The readme read before the restart.'), 'what it read before the restart is sent again');
    assert.ok(body.includes('ProjectKeeper restarted while this work was running'), 'with the continuation');
    assert.equal((body.match(/Organize the readme\./g) ?? []).length, 1, 'the task is not sent a second time');
    assert.equal(done.sessionFile, ran.sessionFile, 'the same session file');
    assert.deepEqual(sessionFilesOf(job.id), [ran.sessionFile]);
    assert.ok(done.steps.some((s) => s.tool === 'read'), 'the steps of the run before are kept');
    assert.equal(done.usage.input, ran.usage.input + 10, 'the usage adds to what the job had spent');
    assert.ok(done.timing && ran.timing && done.timing.generationMs >= ran.timing.generationMs, 'and so does its time');
  } finally { a.close(); b.close(); first.app.stopAll(); second?.stopAll(); }
});
