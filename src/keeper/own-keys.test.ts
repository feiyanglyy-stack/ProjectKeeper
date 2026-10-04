/**
 * The owner's own keys (Spec §6.10 "key、模型与路由", §3.1; D105; CKC-03 AC-33, AC-34, AC-36): saved in ProjectKeeper's
 * home and nowhere else, shown only masked, replaced, removed; checked on save and on `Check` with one request of one
 * output token; keys configured outside the product listed with where they come from and usable the same way; `Start`
 * off without a usable key.
 *
 * Every provider here is a local test double that answers by the key it is sent: no real key, no network, no quota.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-pi-agent-'));
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
const { App } = await import('../server/app.ts');
const { HttpApp } = await import('../server/http.ts');
const { registerRoutes } = await import('./../server/api.ts');
const { QUOTA_REPORTERS, isRefusal } = await import('./key-check.ts');
const { KEY_MASK } = await import('./own-keys.ts');
const { takeoverKey } = await import('../server/keeper-page.ts');
const { modelProviderView } = await import('../server/keys-api.ts');

/** Fake key values. Long and distinctive, so a grep finds any copy of them. */
const GOOD = 'pk-test-GOOD-7f3a9c2e5b1d4086a1f2';
const GOOD2 = 'pk-test-GOOD-second-0c8e1b7d2a94';
const BAD = 'pk-test-BAD-key-e19d77c3b0a2f6';
const QUOTA = 'pk-test-QUOTA-key-55aa31d0e8c4';
const LIMIT = 'pk-test-LIMIT-key-9b2f6e0d7c11';

interface Double { url: string; requests: { auth: string; path: string; body: string }[]; close(): void }
/** An OpenAI-compatible provider that answers by the key: a good key gets an answer; a bad one a 401 that quotes it (as
 *  some providers do); a key at its quota a Zhipu 1308 with the reset time; a limited one a 1302. It also reports a balance. */
function double(): Promise<Double> {
  const d: Double = { url: '', requests: [], close: () => undefined };
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      const auth = String(req.headers.authorization ?? '');
      d.requests.push({ auth, path: req.url ?? '', body: Buffer.concat(parts).toString('utf8') });
      if ((req.url ?? '').endsWith('/user/balance')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.50' }] }));
        return;
      }
      const err = (status: number, body: object) => { res.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false' }); res.end(JSON.stringify(body)); };
      if (auth.includes('BAD')) return err(401, { error: { message: `Incorrect API key provided: ${auth.replace(/^Bearer /, '')}`, type: 'invalid_request_error' } });
      if (auth.includes('QUOTA')) return err(429, { error: { code: '1308', message: 'Usage limit reached for 5 hour. Your limit will reset at 2026-10-03 17:08:09' } });
      if (auth.includes('LIMIT')) return err(429, { error: { code: '1302', message: 'Rate limit reached for requests' } });
      const chunk = (delta: object, finish: string | null) => ({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'OK' }, null))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    d.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    d.close = () => server.close();
    resolve(d);
  }));
}

type AppT = InstanceType<typeof App>;
/** A provider pi does not know, with the double as its endpoint and no key of its own: keys are added for it. */
function family(app: AppT, id: string, url: string, models: readonly { id: string; input: number; output: number }[] = [{ id: `${id}-flash`, input: 0.1, output: 0.4 }, { id: `${id}-pro`, input: 1, output: 4 }]): void {
  app.keeper.models.registerProvider(id, { name: `${id[0]!.toUpperCase()}${id.slice(1)}`, baseUrl: url, api: 'openai-completions', models: models.map((m) => ({ id: m.id, name: m.id, api: 'openai-completions' as const, baseUrl: url, reasoning: false, input: ['text' as const], cost: { input: m.input, output: m.output, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 })) });
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error('timed out');
}

/** Every file under a directory, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, name);
    try { if (statSync(path).isFile()) out.push(path); } catch { /* gone */ }
  }
  return out;
}
const holding = (files: readonly string[], value: string): string[] => files.filter((f) => readFileSync(f).includes(Buffer.from(value, 'utf8')));

/** The known providers' key variables are taken out of this process for a test and put back after (they are never read). */
function withoutEnvKeys(): () => void {
  const saved = Object.entries(process.env).filter(([k]) => /_API_KEY$|_TOKEN$/.test(k));
  for (const [k] of saved) delete process.env[k];
  return () => { for (const [k, v] of saved) process.env[k] = v; };
}

test('a key is saved on this machine, shown only masked, checked on save, replaced and removed; it is there after a restart', async () => {
  const restore = withoutEnvKeys();
  const d = await double();
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  let app = new App(home, { organizing: false });
  try {
    await app.initKeeper();
    family(app, 'kestrel', d.url);
    const { key, check } = await app.keeper.addKey('kestrel', 'My Kestrel', GOOD);
    assert.equal(key.id, 'kestrel~1');
    assert.equal(key.mask, KEY_MASK, 'the mask shows not one character of the key');
    assert.ok(!JSON.stringify(key).includes(GOOD) && !JSON.stringify(key).includes(GOOD.slice(-4)), 'nothing of the value comes back');
    assert.equal(check.status, 'Usable', `checked on save: ${check.reason}`);
    assert.match(check.how, /one request of one output token to kestrel-flash/, 'the check asks the cheapest priced model for one token');
    const sent = d.requests.filter((r) => r.auth === `Bearer ${GOOD}`);
    assert.equal(sent.length, 1, 'one request');
    assert.equal(JSON.parse(sent[0]!.body).max_tokens ?? JSON.parse(sent[0]!.body).max_completion_tokens, 1, 'of one output token');

    const second = await app.keeper.addKey('kestrel', '', GOOD2);
    assert.equal(second.key.id, 'kestrel~2', 'several keys of one provider');
    let view = await app.keeper.keysView();
    const mine = view.filter((k) => k.from === 'ProjectKeeper');
    assert.deepEqual(mine.map((k) => [k.id, k.name, k.provider, k.mask]), [['kestrel~1', 'My Kestrel', 'kestrel', KEY_MASK], ['kestrel~2', 'kestrel key 2', 'kestrel', KEY_MASK]]);
    assert.ok(!JSON.stringify(view).includes(GOOD) && !JSON.stringify(view).includes(GOOD2), 'the keys view carries no value');
    assert.equal(JSON.parse(readFileSync(join(home, 'keys.json'), 'utf8')).keys[0].value, GOOD, 'kept in ProjectKeeper’s own settings');
    assert.ok(!existsSync(join(home, 'workspace.json')) || !readFileSync(join(home, 'workspace.json'), 'utf8').includes(GOOD), 'not in workspace.json');

    // Replace: the same key under its id, with the new value, checked again.
    const replaced = await app.keeper.replaceKey('kestrel~2', BAD, 'Spare');
    assert.equal(replaced.key.name, 'Spare');
    assert.equal(replaced.check?.status, 'Refused', 'checked again on replace');
    assert.ok(!replaced.check!.reason!.includes(BAD), `the provider quoted the key; it is taken out: ${replaced.check!.reason}`);
    assert.ok(replaced.check!.reason!.includes(KEY_MASK));
    await app.keeper.replaceKey('kestrel~2', GOOD2, null);

    // A restart: the keys are there and usable without being entered again.
    app.stopAll(); await app.flushAll();
    app = new App(home, { organizing: false });
    await app.initKeeper();
    family(app, 'kestrel', d.url);
    view = await app.keeper.keysView();
    assert.deepEqual(view.filter((k) => k.from === 'ProjectKeeper').map((k) => [k.id, k.state.status]), [['kestrel~1', 'Usable'], ['kestrel~2', 'Usable']], 'after a restart');
    assert.ok((await app.keeper.models.getAvailable('kestrel~1')).length > 0);

    // Remove: gone from the machine.
    const removed = await app.keeper.removeKey('kestrel~2');
    assert.equal(removed.removed?.id, 'kestrel~2');
    assert.ok(!readFileSync(join(home, 'keys.json'), 'utf8').includes(GOOD2), 'removed from the file');
    assert.equal((await app.keeper.models.getAvailable('kestrel~2')).length, 0, 'and from pi');
    assert.deepEqual((await app.keeper.keysView()).filter((k) => k.from === 'ProjectKeeper').map((k) => k.id), ['kestrel~1']);
  } finally { app.stopAll(); d.close(); restore(); }
});

test('a key’s state comes from one cheap request: usable, refused with the provider’s reason, out of quota with when it comes back, rate-limited; quota where the provider reports it', async () => {
  const restore = withoutEnvKeys();
  const d = await double();
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')), { organizing: false });
  try {
    await app.initKeeper();
    family(app, 'zai-double', d.url);
    family(app, 'merlin', d.url);
    const states: Record<string, Awaited<ReturnType<typeof app.keeper.checkKeyNow>>> = {};
    for (const [name, value] of [['good', GOOD], ['bad', BAD], ['quota', QUOTA], ['limit', LIMIT]] as const) states[name] = (await app.keeper.addKey('zai-double', name, value)).check;
    assert.equal(states.good!.status, 'Usable');
    assert.equal(states.bad!.status, 'Refused');
    assert.match(states.bad!.reason!, /Incorrect API key provided/, 'the provider’s own words');
    assert.ok(!states.bad!.reason!.includes(BAD), 'without the key it quoted');
    assert.equal(states.quota!.status, 'Out of quota');
    assert.equal(states.quota!.until, '2026-10-03T09:08:09.000Z', 'with the time it comes back (a Zhipu-family reset time read as Beijing time)');
    assert.equal(states.limit!.status, 'Rate-limited');
    for (const s of Object.values(states)) assert.equal(s.quotaReported, false, 'this provider does not report quota');
    const view = await app.keeper.keysView();
    assert.equal(view.find((k) => k.name === 'quota')!.state.status, 'Out of quota');
    assert.equal(view.find((k) => k.name === 'good')!.state.quotaReported, false);

    // A provider that reports what is left: the check reads it beside the request.
    QUOTA_REPORTERS.merlin = async (baseUrl, apiKey, signal) => {
      const r = await fetch(`${new URL(baseUrl).origin}/user/balance`, { headers: { authorization: `Bearer ${apiKey}` }, signal });
      const b = await r.json() as { balance_infos: { currency: string; total_balance: string }[] };
      return { text: `Balance ${b.balance_infos[0]!.total_balance} ${b.balance_infos[0]!.currency}`, available: true };
    };
    const reported = (await app.keeper.addKey('merlin', 'reports', GOOD)).check;
    assert.equal(reported.status, 'Usable');
    assert.equal(reported.quotaReported, true);
    assert.equal(reported.quota, 'Balance 12.50 CNY');

    // Running jobs and the key's jobs at once are shown with it.
    app.keeper.setKeyLanes('zai-double~1', 2);
    const good = (await app.keeper.keysView()).find((k) => k.id === 'zai-double~1')!;
    assert.equal(good.lanes, 2);
    assert.equal(good.ownLanes, true);
    assert.equal(good.running, 0);
  } finally { delete QUOTA_REPORTERS.merlin; app.stopAll(); d.close(); restore(); }
});

test('the refusals of the key itself are told from limits', () => {
  assert.ok(isRefusal('401 Unauthorized'));
  assert.ok(isRefusal('{"error":{"code":"1002","message":"Authorization Token非法，请确认Authorization Token正确传递。"}}'));
  assert.ok(isRefusal('Authentication Fails, Your api key: ****abcd is invalid'));
  assert.ok(!isRefusal('429: {"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-10-03 17:08:09"}'));
  assert.ok(!isRefusal('429 Too Many Requests'));
});

test('keys configured outside ProjectKeeper are listed with where they come from, with no value, and usable the same way', async () => {
  const restore = withoutEnvKeys();
  process.env.DEEPSEEK_API_KEY = 'pk-test-env-deepseek-3d1f0a';
  process.env.PK_TEST_TEAM_KEY = 'pk-test-env-team-77b2c9';
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')), { organizing: false });
  try {
    app.workspace.setSettings({ extraKeys: [{ provider: 'zai-coding-cn-team', like: 'zai-coding-cn', apiKeyEnv: 'PK_TEST_TEAM_KEY', name: 'Zhipu Coding Plan (team key)' }] });
    await app.initKeeper();
    const project = app.addProject('Demo', [mkdtempSync(join(tmpdir(), 'pk-proj-'))]);
    const view = await app.keeper.keysView();
    const ds = view.find((k) => k.id === 'deepseek');
    assert.ok(ds, 'the environment key is listed');
    assert.equal(ds.from, 'Environment');
    assert.equal(ds.fromDetail, 'Environment variable DEEPSEEK_API_KEY');
    assert.equal(ds.mask, null, 'no mask: it is not kept here');
    assert.equal(ds.removable, false);
    assert.equal(ds.state.status, 'Usable', 'usable without being entered again');
    assert.match(ds.state.reason ?? '', /Not checked in this run/);
    assert.ok(ds.models.some((m) => m.id === 'deepseek-flash'));
    const team = view.find((k) => k.id === 'zai-coding-cn-team')!;
    assert.equal(team.from, 'Settings');
    assert.match(team.fromDetail, /Environment variable PK_TEST_TEAM_KEY/);
    assert.equal(team.provider, 'zai-coding-cn');
    assert.ok(!JSON.stringify(view).includes('pk-test-env-'), 'no value in the view');
    // Used the same way: a project's route can run on it, and the takeover names it.
    app.keeper.setRoute(project.id, { model: { provider: 'deepseek', id: 'deepseek-flash', thinking: 'high' }, backups: [{ provider: 'zai-coding-cn-team', id: 'glm-5.3-flash', thinking: 'high' }] });
    const key = await takeoverKey(app, project.id);
    assert.deepEqual([key.usable, key.model, key.keyName], [true, 'deepseek/deepseek-flash', ds.name]);
    assert.deepEqual(app.keeper.laneState(project.id).keys.map((k) => k.provider), ['deepseek', 'zai-coding-cn-team']);
  } finally { app.stopAll(); delete process.env.DEEPSEEK_API_KEY; delete process.env.PK_TEST_TEAM_KEY; restore(); }
});

test('without a usable key Start cannot be pressed and the page says to add one; with one it names the key and the model', async () => {
  const restore = withoutEnvKeys();
  const d = await double();
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')), { organizing: false });
  const http = new HttpApp();
  registerRoutes(http, app, '', '');
  try {
    await app.initKeeper();
    family(app, 'kestrel', d.url);
    const projectDir = mkdtempSync(join(tmpdir(), 'pk-proj-'));
    writeFileSync(join(projectDir, 'README.md'), '# Demo\n');
    const project = app.addProject('Demo', [projectDir]);
    const server = await http.listen(0);
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json() as Record<string, unknown> };
    };
    try {
      let page = await call('GET', `/api/projects/${project.id}/keeper-page`);
      const key = (page.body.takeover as { key: { usable: boolean; reason: string } }).key;
      assert.equal(key.usable, false);
      assert.match(key.reason, /No usable key: add one in Model provider/);
      const refused = await call('POST', `/api/projects/${project.id}/takeover/start`, { depth: 'First picture only' });
      assert.equal(refused.status, 409, 'Start is refused');
      assert.match(String(refused.body.error), /No usable key/);

      // A refused key is not a usable one either.
      await call('POST', '/api/keys', { provider: 'kestrel', name: 'wrong', key: BAD });
      page = await call('GET', `/api/projects/${project.id}/keeper-page`);
      assert.equal((page.body.takeover as { key: { usable: boolean } }).key.usable, false, 'a refused key does not open Start');

      const added = await call('POST', '/api/keys', { provider: 'kestrel', name: 'Kestrel main', key: GOOD });
      assert.equal(added.status, 200);
      assert.equal((added.body.check as { status: string }).status, 'Usable');
      await call('POST', `/api/projects/${project.id}/route`, { model: { provider: 'kestrel~2', id: 'kestrel-pro', thinking: 'high' } });
      page = await call('GET', `/api/projects/${project.id}/keeper-page`);
      assert.deepEqual((page.body.takeover as { key: unknown }).key, { usable: true, model: 'kestrel~2/kestrel-pro', keyName: 'Kestrel main', thinking: 'high', reason: null });
      const mp = await call('GET', `/api/projects/${project.id}/model-provider`);
      assert.ok(!JSON.stringify(mp.body).includes(GOOD) && !JSON.stringify(mp.body).includes(BAD), 'the page’s view carries no value');
      assert.equal((mp.body.route as { own: boolean }).own, true);
    } finally { await server.close(); }
  } finally { app.stopAll(); d.close(); restore(); }
});

test('a key’s value is written nowhere but keys.json: not the project, its ProjectKeeper folder, trace, jobs, session records, exports, context packs or the log', async () => {
  const restore = withoutEnvKeys();
  const d = await double();
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-proj-'));
  writeFileSync(join(projectDir, 'README.md'), '# Demo\n\nA project for the key grep test.\n');
  const app = new App(home, { organizing: false });
  const http = new HttpApp();
  registerRoutes(http, app, '', '');
  // Everything the process prints while the key is in use is kept and searched too.
  const printed: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ['log', 'warn', 'error', 'info'] as const) console[k] = (...a: unknown[]) => { printed.push(a.map(String).join(' ')); };
  const bodies: string[] = [];
  try {
    const project = app.addProject('Demo', [projectDir]);
    await app.intakeProject(project.id);
    app.stopAll();
    await app.initKeeper();
    family(app, 'kestrel', d.url);
    const server = await http.listen(0);
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      bodies.push(text);
      return JSON.parse(text) as Record<string, unknown>;
    };
    try {
      await call('POST', '/api/keys', { provider: 'kestrel', name: 'good', key: GOOD });
      await call('POST', '/api/keys', { provider: 'kestrel', name: 'bad', key: BAD });
      await call('POST', `/api/projects/${project.id}/route`, { model: { provider: 'kestrel~1', id: 'kestrel-flash', thinking: null } });
      const store = app.store(project.id);
      const ok = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'grep' }, prompt: 'Organize the readme.' });
      const owner = app.keeper.enqueue(project.id, { kind: 'Answering', initiator: 'owner', scope: { kind: 'project', ids: [], label: 'a question' }, prompt: 'What is this project?' });
      await until(() => store.jobs.get(ok.id)?.status === 'Done' && store.jobs.get(owner.id)?.status === 'Done');
      // A job on the refused key fails, and the provider's answer — which quotes the key — is written without it.
      await call('POST', `/api/projects/${project.id}/route`, { model: { provider: 'kestrel~2', id: 'kestrel-flash', thinking: null } });
      const failing = app.keeper.enqueue(project.id, { kind: 'Answering', initiator: 'owner', scope: { kind: 'project', ids: [], label: 'on the refused key' }, prompt: 'Again.' });
      await until(() => ['Failed', 'Waiting for quota', 'Done'].includes(store.jobs.get(failing.id)?.status ?? ''));
      assert.ok(d.requests.some((r) => r.auth === `Bearer ${BAD}`), 'the refused key was sent');
      assert.ok(!(store.jobs.get(failing.id)?.error ?? '').includes(BAD), `the error is written without it: ${store.jobs.get(failing.id)?.error}`);
      for (const id of ['kestrel~1', 'kestrel~2']) await call('POST', `/api/keys/${encodeURIComponent(id)}/check`);
      for (const path of ['keeper-page', 'connections', 'model-provider', 'usage-rounds', 'activity', 'usage', 'context?purpose=Start']) await call('GET', `/api/projects/${project.id}/${path}`);
      await call('POST', '/api/keys/kestrel~1', { name: 'renamed' });
      await store.flush();
      await app.flushAll();
    } finally { await server.close(); }

    // keys.json holds both; nothing else anywhere does.
    assert.ok(readFileSync(join(home, 'keys.json'), 'utf8').includes(GOOD));
    const files = [...filesUnder(home).filter((f) => !f.endsWith('keys.json')), ...filesUnder(projectDir), ...filesUnder(process.env.PI_CODING_AGENT_DIR!)];
    assert.ok(files.some((f) => f.includes('trace.jsonl')) && files.some((f) => f.endsWith('jobs.json')) && files.some((f) => f.endsWith('.jsonl') && f.includes('sessions')), 'the trace, the jobs and the session records are among what is searched');
    for (const value of [GOOD, BAD]) {
      assert.deepEqual(holding(files, value), [], `no file holds ${value === GOOD ? 'the good' : 'the refused'} key`);
      assert.ok(!bodies.some((b) => b.includes(value)), 'no answer of the server carries it');
      assert.ok(!printed.some((p) => p.includes(value)), 'nothing printed carries it');
    }
  } finally { Object.assign(console, orig); app.stopAll(); d.close(); restore(); }
});

/** The machine's settings as a resident home has them: the team key (an extra key, like zai-coding-cn) first, the two
 *  other glm keys behind it, and the steps set by model alone, as they were set before routes had keys. Fake values. */
const TEAM_SETTINGS = {
  extraKeys: [{ provider: 'zai-coding-cn-team', like: 'zai-coding-cn', apiKeyEnv: 'ZAI_CODING_CN_TEAM_API_KEY', name: 'Zhipu Coding Plan (team key)' }],
  steps: { 'session-drafts': { model: 'glm-5.3', thinking: 'max' }, main: { model: 'glm-5.3', thinking: 'max' }, lane: { model: 'glm-5.3', thinking: 'max' }, 'spot-check': { model: 'glm-5.3', thinking: 'max' } },
};
function withTeamEnv(): () => void {
  const restore = withoutEnvKeys();
  process.env.ZAI_API_KEY = 'pk-test-env-zai-41c0';
  process.env.ZAI_CODING_CN_API_KEY = 'pk-test-env-cn-8d2e';
  process.env.ZAI_CODING_CN_TEAM_API_KEY = 'pk-test-env-team-5a7f';
  return () => { delete process.env.ZAI_API_KEY; delete process.env.ZAI_CODING_CN_API_KEY; delete process.env.ZAI_CODING_CN_TEAM_API_KEY; restore(); };
}
type MPV = Awaited<ReturnType<typeof modelProviderView>>;
const offeredValues = (mp: MPV) => mp.offered.map((o) => `${o.provider}|${o.model}`);

test('the machine’s main model on an extra key is that key on the page; a step set by model alone sits on it, and each step says whom it follows', async () => {
  const restore = withTeamEnv();
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')), { organizing: false });
  try {
    app.workspace.setSettings({ ...TEAM_SETTINGS, model: { provider: 'zai-coding-cn-team', id: 'glm-5.3', thinking: 'max' }, modelBackups: [{ provider: 'zai-coding-cn', id: 'glm-5.3', thinking: 'max' }, { provider: 'zai', id: 'glm-5.3', thinking: 'max' }] });
    await app.initKeeper();
    const project = app.addProject('Demo', [mkdtempSync(join(tmpdir(), 'pk-proj-'))]);
    const mp = await modelProviderView(app, project.id);
    assert.equal(mp.route.own, false, 'no route saved: the machine’s');
    assert.deepEqual([mp.route.main?.provider, mp.route.main?.id, mp.route.main?.thinking, mp.route.main?.keyName, mp.route.main?.usable, mp.route.main?.chosen], ['zai-coding-cn-team', 'glm-5.3', 'max', 'Zhipu Coding Plan (team key)', true, true], 'the main row shows the team key and its model');
    assert.ok(mp.keys.some((k) => k.id === mp.route.main!.provider), 'and that key is one of the keys listed, so the select has it');
    const step = (kind: string) => mp.route.steps.find((s) => s.kind === kind)!;
    for (const kind of ['session-drafts', 'main', 'lane', 'spot-check']) {
      const s = step(kind);
      assert.equal(s.followsWhom, 'main model', `${kind}: without its own model it follows the main model`);
      assert.equal(s.followsModel, 'glm-5.3');
      assert.equal(s.place, 'zai-coding-cn|glm-5.3', `${kind}: its glm-5.3 is the one the main key (like zai-coding-cn) carries`);
      assert.ok(offeredValues(mp).includes(s.place!), `${kind}: and it is offered — not “no usable key carries it”`);
    }
    assert.deepEqual([step('synthesis').followsWhom, step('synthesis').followsModel, step('synthesis').place], ['main', 'glm-5.3', null], 'the synthesis follows the main agent');
    assert.deepEqual(mp.route.backups.map((b) => b.provider), ['zai-coding-cn', 'zai']);
  } finally { app.stopAll(); restore(); }
});

test('with no main model set anywhere, the page shows the key and model the project runs on now, and a step can be set from there', async () => {
  const restore = withTeamEnv();
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')), { organizing: false });
  try {
    app.workspace.setSettings({ ...TEAM_SETTINGS, modelBackups: [{ provider: 'zai-coding-cn-team', id: 'glm-5.3', thinking: 'max' }, { provider: 'zai-coding-cn', id: 'glm-5.3', thinking: 'max' }] });
    await app.initKeeper();
    const project = app.addProject('Demo', [mkdtempSync(join(tmpdir(), 'pk-proj-'))]);
    const key = await takeoverKey(app, project.id);
    assert.deepEqual([key.usable, key.model, key.keyName, key.thinking], [true, 'zai-coding-cn-team/glm-5.3', 'Zhipu Coding Plan (team key)', 'max'], 'the takeover runs on the first key of the order');
    const mp = await modelProviderView(app, project.id);
    assert.deepEqual([mp.route.main?.provider, mp.route.main?.id, mp.route.main?.thinking, mp.route.main?.chosen], ['zai-coding-cn-team', 'glm-5.3', 'max', false], 'the main row shows that key and model, not “Choose a key”');
    assert.deepEqual(mp.route.backups.map((b) => b.provider), ['zai-coding-cn'], 'the key in use is not listed again as its own backup');
    const lane = mp.route.steps.find((s) => s.kind === 'lane')!;
    assert.deepEqual([lane.followsWhom, lane.followsModel, lane.place], ['main model', 'glm-5.3', 'zai-coding-cn|glm-5.3']);
    // A step changed before any main model was chosen: the project goes on from the key and model it runs on.
    const route = app.keeper.setRoute(project.id, { steps: { lane: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', thinking: 'high' } } });
    assert.deepEqual([route.own, route.main?.provider, route.main?.id, route.steps.lane?.model], [true, 'zai-coding-cn-team', 'glm-5.3', 'glm-5.3-flash']);
  } finally { app.stopAll(); restore(); }
});
