/**
 * Keeper runtime against a fake OpenAI-compatible provider: a job runs in a real pi session,
 * calls a pk_* tool, ends Done with its text; quota errors wait; Stop aborts; pause holds
 * automatic work. pi's own state goes to a temporary agent directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-pi-agent-'));
const { App } = await import('../server/app.ts');

type Mode = 'answer' | 'quota' | 'hang' | 'delegate' | 'delegate-hang' | 'delegate-two' | 'delegate-quota';
/**
 * `delegate-two`: the parent asks two questions in one turn, so pi runs both `pk_investigate` calls at once. The
 * subagent answering "Question A" or "Question B" can be held until the test releases it, to set the order in which
 * the two finish.
 */
interface Two { hold: ReadonlySet<'A' | 'B'>; release: Map<'A' | 'B', () => void> }
interface Fake { url: string; requests: Record<string, unknown>[]; mode: Mode; two: Two; close(): void }

function fakeProvider(): Promise<Fake> {
  const fake: Fake = { url: '', requests: [], mode: 'answer', two: { hold: new Set(), release: new Map() }, close: () => undefined };
  const sse = (res: ServerResponse, chunks: unknown[]) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  };
  const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) => ({
    id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model: 'fake-1',
    choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
      fake.requests.push(json);
      if (fake.mode === 'quota') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'insufficient_quota: You exceeded your current quota', type: 'insufficient_quota' } }));
        return;
      }
      if (fake.mode === 'hang') { req.on('close', () => res.destroy()); return; }
      const toolResult = json.messages.find((m) => m.role === 'tool');
      if (fake.mode === 'delegate-two') {
        const all = JSON.stringify(json.messages);
        const usage = { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 };
        // Another piece of work queued while the parent waits: it answers plainly.
        if (all.includes('Job C')) { sse(res, [chunk({ role: 'assistant', content: 'Job C done.' }, null), chunk({}, 'stop', usage)]); return; }
        if (all.includes('Investigate this question for the parent job')) {
          const which: 'A' | 'B' = all.includes('Question A') ? 'A' : 'B';
          // Released once: a test releases in its body and again in `finally`, in case the body never got there.
          let answered = false;
          const answer = () => { if (answered) return; answered = true; sse(res, [chunk({ role: 'assistant', content: `Answer ${which}. Sources: none` }, null), chunk({}, 'stop', usage)]); };
          if (fake.two.hold.has(which)) fake.two.release.set(which, answer); else answer();
          return;
        }
        if (!toolResult) {
          sse(res, [
            chunk({ role: 'assistant', tool_calls: [
              { index: 0, id: 'call_a', type: 'function', function: { name: 'pk_investigate', arguments: JSON.stringify({ question: 'Question A: what does the plan say?' }) } },
              { index: 1, id: 'call_b', type: 'function', function: { name: 'pk_investigate', arguments: JSON.stringify({ question: 'Question B: what does the status say?' }) } },
            ] }, null),
            chunk({}, 'tool_calls', { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }),
          ]);
          return;
        }
        sse(res, [chunk({ role: 'assistant', content: 'Both answers are in.' }, null), chunk({}, 'stop', { prompt_tokens: 200, completion_tokens: 16, total_tokens: 216 })]);
        return;
      }
      if (fake.mode === 'delegate' || fake.mode === 'delegate-hang' || fake.mode === 'delegate-quota') {
        // The subagent's own session is recognised by the prompt the runtime writes for it; it answers plainly so the
        // fake does not delegate for ever.
        const isSubagent = JSON.stringify(json.messages).includes('Investigate this question for the parent job');
        if (isSubagent) {
          if (fake.mode === 'delegate-hang') { req.on('close', () => res.destroy()); return; }
          if (fake.mode === 'delegate-quota') {
            res.writeHead(429, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'insufficient_quota: You exceeded your current quota', type: 'insufficient_quota' } }));
            return;
          }
          sse(res, [chunk({ role: 'assistant', content: 'The plan names one step. Sources: none' }, null), chunk({}, 'stop', { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 })]);
          return;
        }
        if (!toolResult) {
          sse(res, [
            chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_i', type: 'function', function: { name: 'pk_investigate', arguments: JSON.stringify({ question: 'What does the plan say?' }) } }] }, null),
            chunk({}, 'tool_calls', { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }),
          ]);
          return;
        }
        sse(res, [chunk({ role: 'assistant', content: `Delegated, and the subagent said: ${String(toolResult.content).slice(0, 80)}` }, null), chunk({}, 'stop', { prompt_tokens: 200, completion_tokens: 16, total_tokens: 216 })]);
        return;
      }
      if (!toolResult) {
        sse(res, [
          chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'pk_project_overview', arguments: '{}' } }] }, null),
          chunk({}, 'tool_calls', { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 }),
        ]);
      } else {
        const overview = JSON.parse(String(toolResult.content)) as { scope: unknown[]; coverage: unknown[] };
        const text = `Overview read: ${overview.scope.length} scope items, ${overview.coverage.length} coverage scopes.`;
        sse(res, [chunk({ role: 'assistant', content: text }, null), chunk({}, 'stop', { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 })]);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      fake.url = `http://127.0.0.1:${address.port}/v1`;
      fake.close = () => server.close();
      resolve(fake);
    });
  });
}

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-proj-'));
  mkdirSync(join(projectDir, 'docs'));
  writeFileSync(join(projectDir, 'README.md'), '# Demo project\n\nA project for the Keeper runtime test.\n');
  writeFileSync(join(projectDir, 'docs', 'plan.md'), '# Plan\n\n## Step 1\n\nDo the first thing.\n');
  const app = new App(home, { organizing: false });
  const project = app.addProject('Demo', [projectDir]);
  await app.intakeProject(project.id);
  app.stopAll();
  await app.initKeeper();
  const fake = await fakeProvider();
  app.keeper.models.registerProvider('fake', {
    name: 'Fake', baseUrl: fake.url, apiKey: 'fake-key', api: 'openai-completions',
    models: [{ id: 'fake-1', name: 'Fake 1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }],
  });
  app.keeper.setModel({ provider: 'fake', id: 'fake-1', thinking: null });
  return { app, project, fake };
}

test('a job runs in a pi session, uses a pk tool and ends Done', async () => {
  const { app, project, fake } = await setup();
  try {
    const state = await app.keeper.providerState();
    assert.equal(state.connected, true, state.reason ?? '');
    const job = app.keeper.enqueue(project.id, { kind: 'Answering', initiator: 'owner', scope: { kind: 'question', ids: [], label: 'What is here?' }, prompt: 'Look at the overview and tell me what is here.' });
    const done = await app.keeper.waitFor(project.id, job.id);
    assert.equal(done.status, 'Done', done.error ?? '');
    assert.match(done.resultText ?? '', /Overview read: \d+ scope items/);
    assert.ok(done.steps.some((s) => s.tool === 'pk_project_overview'), 'the pk tool call is recorded as a step');
    assert.ok(done.usage.input >= 300, `usage recorded: ${JSON.stringify(done.usage)}`);
    assert.ok(done.sessionFile && existsSync(done.sessionFile), 'the pi session file exists');
    assert.ok(done.sessionFile!.startsWith(process.env.PI_CODING_AGENT_DIR!), 'session saved under the pi agent dir');
    const first = fake.requests[0] as { tools?: { function: { name: string } }[]; messages: { role: string; content: string }[] };
    const toolNames = (first.tools ?? []).map((t) => t.function.name);
    for (const name of ['pk_project_overview', 'pk_write_fact_record', 'pk_write_thread', 'pk_relate', 'read', 'bash']) assert.ok(toolNames.includes(name), `${name} offered to the model (had: ${toolNames.join(', ')})`);
    const userText = first.messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : (m.content as unknown as { type: string; text?: string }[]).map((p) => p.text ?? '').join('\n'))).join('\n');
    assert.match(userText, /You are the Keeper of the project "Demo"/);
    assert.match(userText, /do NOT modify, move or delete project files/);
    assert.equal((await app.keeper.status(project.id)).status, 'Idle');
  } finally { fake.close(); app.stopAll(); }
});

test('a quota error leaves the job Waiting for quota', async () => {
  const { app, project, fake } = await setup();
  try {
    fake.mode = 'quota';
    const job = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'x' }, prompt: 'Organize.' });
    const done = await app.keeper.waitFor(project.id, job.id);
    assert.equal(done.status, 'Waiting for quota', done.error ?? '');
    assert.match(done.error ?? '', /quota/i);
    assert.equal((await app.keeper.status(project.id)).status, 'Waiting for quota');
  } finally { fake.close(); app.stopAll(); }
});

test('Stop aborts a running job; pause holds automatic work', async () => {
  const { app, project, fake } = await setup();
  try {
    fake.mode = 'hang';
    const job = app.keeper.enqueue(project.id, { kind: 'Answering', initiator: 'owner', scope: { kind: 'question', ids: [], label: 'slow' }, prompt: 'Take your time.' });
    for (let i = 0; i < 100 && app.store(project.id).jobs.get(job.id)?.status !== 'Running'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.store(project.id).jobs.get(job.id)?.status, 'Running');
    assert.equal((await app.keeper.status(project.id)).status, 'Working', 'answering a question is Working; only delegated work is Working on your request (§6.9)');
    assert.equal(app.keeper.stopJob(project.id, job.id), true);
    const stopped = await app.keeper.waitFor(project.id, job.id);
    assert.equal(stopped.status, 'Stopped');

    app.pauseOrganizing(project.id, true);
    const auto = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'held' }, prompt: 'Organize.' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(app.store(project.id).jobs.get(auto.id)?.status, 'Paused');
    assert.equal((await app.keeper.status(project.id)).status, 'Organizing paused');
    assert.equal(app.keeper.stopJob(project.id, auto.id), true);
    assert.equal(app.store(project.id).jobs.get(auto.id)?.status, 'Stopped');
  } finally { fake.close(); app.stopAll(); }
});

/**
 * D59 design 1: the subagent a job delegates to belongs to that job. It runs in the same lane kind (so a pause holds
 * it and it does not compete with the owner's own chat), the job waiting for it does not hold a lane idle, and a Stop
 * reaches the whole tree.
 */
test('a subagent belongs to the work that sent it, and does not need a lane of its own', { timeout: 120_000 }, async () => {
  const { app, project, fake } = await setup();
  try {
    app.keeper.setLanesPerKey(1);   // one lane: if the waiting parent kept holding it, its subagent could never start
    fake.mode = 'delegate';
    const parent = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'a round' }, prompt: 'Organize, and delegate what you cannot read yourself.' });
    const done = await app.keeper.waitFor(project.id, parent.id);
    assert.equal(done.status, 'Done', done.error ?? '');
    assert.match(done.resultText ?? '', /the subagent said/);
    const child = app.store(project.id).jobs.filter((j) => j.parentJobId === parent.id)[0];
    assert.ok(child, 'the investigation is recorded as a job of its own, under its parent');
    assert.equal(child.initiator, 'auto', 'a subagent of automatic work is automatic work, so pausing holds it too');
    assert.equal(child.kind, 'Investigation');
    assert.equal(child.status, 'Done');
    assert.ok(child.usage.input > 0, 'the subagent keeps its own usage, so the two can be shown apart and added up');
  } finally { fake.close(); app.stopAll(); }
});

test('a subagent that ends waiting for quota is said to be waiting, never read as an empty answer (QC AH #10)', { timeout: 60_000 }, async () => {
  const { app, project, fake } = await setup();
  const store = app.store(project.id);
  try {
    fake.mode = 'delegate-quota';
    const parent = app.keeper.enqueue(project.id, { kind: 'Answering', initiator: 'owner', scope: { kind: 'question', ids: [], label: 'the owner asks' }, prompt: 'Answer the owner, and delegate what you cannot read yourself.' });
    await until(() => store.jobs.get(parent.id)?.status === 'Done', 30_000, 'the owner’s job finishes');
    const child = store.jobs.find((j) => j.parentJobId === parent.id)!;
    assert.equal(child.status, 'Waiting for quota');
    assert.match(store.jobs.get(parent.id)!.resultText ?? '', /the subagent said: \{\s*"conclusion": "This investigation is waiting for quota/, 'the job that sent it is told, not handed an empty answer');
  } finally { for (const j of store.jobs.all()) if (j.status === 'Running' || j.status === 'Waiting for quota') app.keeper.stopJob(project.id, j.id); fake.close(); app.stopAll(); }
});

test('Stop on a job reaches the subagent it is waiting for', { timeout: 120_000 }, async () => {
  const { app, project, fake } = await setup();
  try {
    fake.mode = 'delegate-hang';
    const parent = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'a round' }, prompt: 'Organize, and delegate what you cannot read yourself.' });
    const store = app.store(project.id);
    const childOf = () => store.jobs.filter((j) => j.parentJobId === parent.id)[0];
    for (let i = 0; i < 200 && childOf()?.status !== 'Running'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(childOf()?.status, 'Running', 'the subagent is running');
    assert.equal(app.keeper.stopJob(project.id, parent.id), true);
    const stopped = await app.keeper.waitFor(project.id, parent.id);
    assert.equal(stopped.status, 'Stopped');
    assert.equal(childOf()?.status, 'Stopped', 'nothing is left running in the background after the owner stops the work');
  } finally { fake.close(); app.stopAll(); }
});

async function until(check: () => boolean, ms: number, what: string): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (check()) return true; await new Promise((r) => setTimeout(r, 50)); }
  assert.fail(`not reached within ${ms} ms: ${what}`);
}

/**
 * A main job sends subagents in parallel (pi runs the tool calls of one turn at once, D59 rule 1). The parent's lane
 * stays out of the key's count until the last of them has answered. With a yes/no flag, the first subagent to answer
 * put the parent back in the count while it was still waiting for the second — holding a lane doing nothing, and on
 * a small key keeping other work from starting.
 */
test('a job waiting on two subagents stays out of the lane count until both have answered', { timeout: 60_000 }, async () => {
  const { app, project, fake } = await setup();
  const store = app.store(project.id);
  try {
    app.keeper.setLanesPerKey(2);
    fake.mode = 'delegate-two';
    fake.two = { hold: new Set(['B']), release: new Map() };
    const parent = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'a round' }, prompt: 'Organize, and delegate what you cannot read yourself.' });
    const child = (q: string) => store.jobs.find((j) => j.parentJobId === parent.id && j.scope.label.startsWith(q));
    await until(() => child('Question A')?.status === 'Done' && child('Question B')?.status === 'Running', 20_000, 'A answered while B is still out');
    // One subagent is still out: the parent is still waiting, so only B counts against the key's two lanes.
    const other = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'other work' }, prompt: 'Job C: organize this.' });
    await until(() => store.jobs.get(other.id)?.status === 'Done', 15_000, 'other work runs while the parent waits for B');
    assert.equal(store.jobs.get(parent.id)?.status, 'Running', 'the parent was still waiting for B the whole time');
    fake.two.release.get('B')?.();
    const done = await app.keeper.waitFor(project.id, parent.id);
    assert.equal(done.status, 'Done', done.error ?? '');
  } finally { fake.two.release.get('B')?.(); fake.close(); app.stopAll(); }
});

/**
 * Work the owner started (a question, a request, a re-look they asked for) may send a subagent too. The subagent is
 * the owner's work as well, and the owner's lane is held by the parent that is waiting for it: it has to run
 * somewhere else, or the parent waits on itself for ever.
 */
test('a subagent of the owner’s own work runs, and the owner’s job finishes', { timeout: 60_000 }, async () => {
  const { app, project, fake } = await setup();
  const store = app.store(project.id);
  let parentId = '';
  try {
    fake.mode = 'delegate';
    const parent = app.keeper.enqueue(project.id, { kind: 'Answering', initiator: 'owner', scope: { kind: 'question', ids: [], label: 'the owner asks' }, prompt: 'Answer the owner, and delegate what you cannot read yourself.' });
    parentId = parent.id;
    await until(() => store.jobs.get(parent.id)?.status === 'Done', 20_000, 'the owner’s job finishes');
    const child = store.jobs.find((j) => j.parentJobId === parent.id)!;
    assert.ok(child, 'the subagent is recorded under the owner’s job');
    assert.equal(child.initiator, 'owner', 'it is the owner’s work, not background organizing');
    assert.equal(child.status, 'Done');
    assert.match(store.jobs.get(parent.id)!.resultText ?? '', /the subagent said/);
  } finally { if (parentId && store.jobs.get(parentId)?.status === 'Running') app.keeper.stopJob(project.id, parentId); fake.close(); app.stopAll(); }
});

/**
 * Parallel tool calls end in any order. A step's result used to be filed on the last step with the same tool name,
 * so when the second of two parallel investigations answered first, the first one's answer then overwrote it and
 * the first step was left with none.
 */
test('each step keeps its own result when parallel calls end out of order', { timeout: 60_000 }, async () => {
  const { app, project, fake } = await setup();
  const store = app.store(project.id);
  try {
    fake.mode = 'delegate-two';
    fake.two = { hold: new Set(['A']), release: new Map() };
    const parent = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'a round' }, prompt: 'Organize, and delegate what you cannot read yourself.' });
    const child = (q: string) => store.jobs.find((j) => j.parentJobId === parent.id && j.scope.label.startsWith(q));
    // B answers first; A is released only once B's whole step has ended.
    await until(() => child('Question B')?.status === 'Done' && store.jobs.get(parent.id)!.steps.some((s) => s.summary.includes('Answer B')), 20_000, 'B answered first');
    fake.two.release.get('A')?.();
    const done = await app.keeper.waitFor(project.id, parent.id);
    assert.equal(done.status, 'Done', done.error ?? '');
    const steps = done.steps.filter((s) => s.tool === 'pk_investigate');
    assert.equal(steps.length, 2);
    assert.match(steps[0]!.summary, /Answer A/, `the first call keeps the first answer: ${JSON.stringify(steps)}`);
    assert.match(steps[1]!.summary, /Answer B/, 'and the second keeps its own');
  } finally { fake.two.release.get('A')?.(); fake.close(); app.stopAll(); }
});
