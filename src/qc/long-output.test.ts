/** Independent CKC-03 AC-30 checks through App, pi, and loopback fake providers. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

// The home, project and pi session directories all stay inside this worktree.
const workspace = realpathSync(process.cwd());
const scratch = mkdtempSync(join(workspace, '.qc-ax-'));
process.env.PI_CODING_AGENT_DIR = join(scratch, 'pi-agent');
// So does the user's home as pi reads it (`HOME`, then the system's): pi puts the skills under `~/.agents/skills` into
// every session's system message, and what a session holds decides whether pi can recover from a cut-off reply.
process.env.HOME = join(scratch, 'user');
mkdirSync(process.env.HOME, { recursive: true });
// pi retries a reply cut off at the output limit only after compacting, and compacts only when the session holds more
// than `compaction.keepRecentTokens` (20,000 by default). These short sessions hold about 17,000 by pi's estimate, so
// with the default the two recovery tests below passed only on a machine whose owner has some 3,000 tokens of skills
// of their own in `~/.agents/skills`, and failed on a clean one. The limit is set here instead, in pi's own settings
// file, low enough that the Keeper's prompt alone passes it: recovery runs wherever the test does.
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 1000 } }));
after(async () => {
  // waitFor resolves on Keeper's done event, just before the runtime's final flush/dispose.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const inside = relative(workspace, realpathSync(scratch));
  assert.ok(inside && inside !== '..' && !inside.startsWith(`..${sep}`));
  rmSync(scratch, { recursive: true, force: true });
});

const { App } = await import('../server/app.ts');
const { startFakeProvider, FAKE_MODEL } = await import('../keeper/fake-provider.ts');
const { registerRoutes } = await import('../server/api.ts');
const { StepTimer, REPEATED_REFUSAL_LIMIT } = await import('../keeper/step-timing.ts');

async function appFixture() {
  const home = mkdtempSync(join(scratch, 'home-'));
  const projectDir = mkdtempSync(join(scratch, 'project-'));
  mkdirSync(join(projectDir, 'docs'));
  writeFileSync(join(projectDir, 'README.md'), '# QC project\n');
  const app = new App(home, { organizing: false });
  app.workspace.setSettings({ watchProjects: false });
  const project = app.addProject('QC project', [projectDir]);
  await app.intakeProject(project.id);
  await app.initKeeper();
  const register = (url: string) => {
    app.keeper.models.registerProvider('fake', { name: 'Local QC fake', baseUrl: url, apiKey: 'fake', api: 'openai-completions', models: [FAKE_MODEL] });
    app.keeper.setModel({ provider: 'fake', id: FAKE_MODEL.id, thinking: null });
  };
  const enqueue = (label: string, step: 'orientation' | null = null) => app.keeper.enqueue(project.id, {
    kind: 'Answering', initiator: 'owner', scope: { kind: 'question', ids: [], label }, prompt: label,
    ...(step ? { step: { roundId: 'crd_qc', kind: step, path: null } } : {}),
  });
  return { home, app, project, register, enqueue, store: app.store(project.id) };
}

function activityRoute(app: InstanceType<typeof App>, projectId: string) {
  const handlers = new Map<string, (ctx: unknown) => unknown>();
  registerRoutes({ route: (method: string, path: string, handler: (ctx: unknown) => unknown) => handlers.set(`${method} ${path}`, handler), static: () => undefined } as never, app, '', '');
  return async (path: string, jobId?: string) => {
    const handler = handlers.get(`GET ${path}`);
    assert.ok(handler, path);
    return await handler({ params: { id: projectId, jobId }, query: new URLSearchParams(), body: null }) as Record<string, any>;
  };
}

function persisted<T>(home: string, projectId: string, collection: string): T[] {
  return JSON.parse(readFileSync(join(home, 'projects', projectId, `${collection}.json`), 'utf8')) as T[];
}

test('100 KB and 500 KB fragmented JSON reaches pk_write_round_doc intact and persists', { timeout: 120_000 }, async (t) => {
  const f = await appFixture();
  try {
    for (const [size, chunkSize] of [[100_000, 17], [100_000, 1_024], [500_000, 4_096], [500_000, 16_384]] as const) {
      const head = `# ${size}/${chunkSize}\n`;
      const tail = `\nEND-${size}-${chunkSize}`;
      const markdown = head + 'x'.repeat(size - head.length - tail.length) + tail;
      const fake = await startFakeProvider((_prompt, _messages, afterTool) => afterTool ? 'Document written.' : [{ name: 'pk_write_round_doc', args: { kind: 'Questions', title: `QC ${size}/${chunkSize}`, markdown } }], { toolArgumentChunkSize: chunkSize });
      try {
        f.register(fake.url);
        const job = f.enqueue(`long-doc-${size}-${chunkSize}`, 'orientation');
        const done = await f.app.keeper.waitFor(f.project.id, job.id);
        const doc = f.store.roundDocs.find((d) => d.jobId === job.id);
        assert.equal(done.status, 'Done', `${size}/${chunkSize}: ${done.error ?? JSON.stringify(done.steps)}`);
        const offered = fake.requests[0]?.tools ?? [];
        for (const name of ['pk_write_round_doc', 'read', 'bash', 'grep', 'find', 'ls']) assert.ok(offered.includes(name), `${name} offered in ${size}/${chunkSize}`);
        assert.equal(done.model?.id, FAKE_MODEL.id);
        assert.ok(doc, `tool executed for ${size}/${chunkSize}`);
        assert.equal(doc.markdown, markdown, `exact content for ${size}/${chunkSize}`);
        assert.ok(done.steps.some((s) => s.tool === 'pk_write_round_doc' && !s.isError));
        await f.store.flush();
        const disk = persisted<{ id: string; markdown: string }>(f.home, f.project.id, 'roundDocs').find((d) => d.id === doc.id);
        assert.equal(disk?.markdown, markdown, `disk content for ${size}/${chunkSize}`);
        t.diagnostic(JSON.stringify({ size, chunkSize, status: done.status, markdownLength: doc.markdown.length, requests: fake.requests.length }));
      } finally { fake.close(); }
    }
  } finally { f.app.stopAll(); }
});

test('a 200 KB final Markdown answer is retained in resultText and jobs.json', { timeout: 60_000 }, async (t) => {
  const f = await appFixture();
  const answer = `# Long answer\n${'a'.repeat(200_000)}\nEND-ANSWER`;
  const fake = await startFakeProvider(() => answer);
  try {
    f.register(fake.url);
    const job = f.enqueue('long-final-answer');
    const done = await f.app.keeper.waitFor(f.project.id, job.id);
    assert.equal(done.status, 'Done', done.error ?? '');
    assert.equal(done.resultText, answer);
    await f.store.flush();
    assert.equal(persisted<{ id: string; resultText: string }>(f.home, f.project.id, 'jobs').find((j) => j.id === job.id)?.resultText, answer);
    t.diagnostic(JSON.stringify({ status: done.status, resultLength: done.resultText?.length }));
  } finally { fake.close(); f.app.stopAll(); }
});

function lengthProvider(includeUsage = true, completeRecovery = false): Promise<{ url: string; requests: () => number; bodies: () => Record<string, any>[]; close(): void }> {
  let requests = 0;
  const bodies: Record<string, any>[] = [];
  const server = createServer((req, res: ServerResponse) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (part: string) => { body += part; });
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      requests += 1;
      const isLength = !completeRecovery || requests === 1;
      const reply = requests === 2 ? '# Recovery summary\nThe user asked for an answer.' : '# Complete answer\nOK';
      const chunk = (delta: object, finish: string | null) => ({ id: 'qc-length', object: 'chat.completion.chunk', created: 1, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish && includeUsage ? { usage: { prompt_tokens: 100, completion_tokens: FAKE_MODEL.maxTokens, total_tokens: FAKE_MODEL.maxTokens + 100 } } : {}) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const value of [chunk({ role: 'assistant', content: isLength ? '# Partial answer\nCUT' : reply }, null), chunk({}, isLength ? 'length' : 'stop')]) res.write(`data: ${JSON.stringify(value)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, requests: () => requests, bodies: () => bodies, close: () => server.close() })));
}

test('last assistant reply at length is Failed with step and reason in Keeper activity', { timeout: 60_000 }, async (t) => {
  const f = await appFixture();
  const fake = await lengthProvider(); // startFakeProvider always sends finish_reason=stop.
  try {
    f.register(fake.url);
    const job = f.enqueue('orientation: long final answer', 'orientation');
    const done = await f.app.keeper.waitFor(f.project.id, job.id);
    const route = activityRoute(f.app, f.project.id);
    const activity = await route('/api/projects/:id/activity');
    const row = activity.jobs.find((j: { id: string }) => j.id === job.id);
    const detail = await route('/api/projects/:id/activity/:jobId', job.id);
    const sessionStops = done.sessionFile ? readFileSync(done.sessionFile, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
      const value = JSON.parse(line) as { message?: { role?: string; stopReason?: string; content?: { text?: string }[] } };
      return value.message?.role === 'assistant' ? [{ stopReason: value.message.stopReason, contentLength: value.message.content?.[0]?.text?.length }] : [];
    }) : [];
    t.diagnostic(JSON.stringify({ status: done.status, error: done.error, sessionStops, activityStatus: row?.status, resultLength: done.resultText?.length }));
    assert.equal(done.status, 'Failed');
    assert.equal(row?.status, 'Failed');
    assert.match(row?.error ?? '', /last reply.*cut off.*output limit/i);
    assert.equal(row?.scope.label, 'orientation: long final answer');
    assert.equal(detail.error, row.error);
    assert.equal(done.resultText, '# Partial answer\nCUT');
    t.diagnostic(JSON.stringify({ status: row.status, label: row.scope.label, error: row.error, retainedResultLength: done.resultText?.length }));
  } finally { fake.close(); f.app.stopAll(); }
});

test('length with missing usage stays Failed through pi recovery, with step, reason and the cut text in activity', { timeout: 60_000 }, async (t) => {
  const f = await appFixture();
  const fake = await lengthProvider(false);
  try {
    f.register(fake.url);
    const job = f.enqueue('orientation: provider omitted usage', 'orientation');
    const done = await f.app.keeper.waitFor(f.project.id, job.id);
    const stops = done.sessionFile ? readFileSync(done.sessionFile, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
      const value = JSON.parse(line) as { message?: { role?: string; stopReason?: string } };
      return value.message?.role === 'assistant' ? [value.message.stopReason] : [];
    }) : [];
    // 0.87.1 makes one summary request; because this fake returns length there too, recovery cannot finish.
    assert.ok(stops.includes('length'), `session stop reasons: ${JSON.stringify(stops)}`);
    assert.equal(fake.requests(), 2);
    assert.match(JSON.stringify(fake.bodies()[1]?.messages?.[0]?.content), /context summarization assistant/);
    assert.equal(done.status, 'Failed', 'a length stop with no complete reply after it is a failure');
    assert.match(done.error ?? '', /last reply.*cut off.*output limit/i);
    assert.equal(done.resultText, '# Partial answer\nCUT', 'what was written before the cut is kept');
    const route = activityRoute(f.app, f.project.id);
    const row = (await route('/api/projects/:id/activity')).jobs.find((j: { id: string }) => j.id === job.id);
    const detail = await route('/api/projects/:id/activity/:jobId', job.id);
    assert.equal(row?.status, 'Failed');
    assert.equal(row?.scope.label, 'orientation: provider omitted usage');
    assert.equal(row?.error, done.error);
    assert.equal(detail.error, done.error);
    t.diagnostic(JSON.stringify({ status: done.status, error: done.error, resultText: done.resultText, sessionStops: stops, requests: fake.requests(), activityStatus: row.status }));
  } finally { fake.close(); f.app.stopAll(); }
});

test('0.87.1 recovery omits a cut-off reply from the next provider request', { timeout: 60_000 }, async (t) => {
  const f = await appFixture();
  const fake = await lengthProvider(false, true);
  try {
    f.register(fake.url);
    const job = f.enqueue('orientation: recover a cut reply', 'orientation');
    const done = await f.app.keeper.waitFor(f.project.id, job.id);
    const bodies = fake.bodies();
    assert.equal(done.status, 'Done', done.error ?? '');
    assert.equal(done.resultText, '# Complete answer\nOK');
    assert.equal(bodies.length, 3, 'first answer, compaction summary, recovered answer');
    assert.match(JSON.stringify(bodies[1]?.messages?.[0]?.content), /context summarization assistant/);
    assert.ok(!JSON.stringify(bodies[2]?.messages).includes('# Partial answer'), 'the recovered model request cannot see the cut reply');
    const entries = readFileSync(done.sessionFile!, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
    const cut = entries.find((entry) => entry.type === 'message' && entry.message?.stopReason === 'length');
    assert.ok(cut, 'the raw transcript keeps the cut reply for review');
    assert.ok(entries.some((entry) => entry.type === 'context_edit' && entry.targetId === cut.id && entry.replacement === null), 'a context edit removes it from provider history');
    t.diagnostic(JSON.stringify({ status: done.status, requests: bodies.length, cutReplyRecorded: true, contextEditRecorded: true, cutReplyInRetry: false }));
  } finally { fake.close(); f.app.stopAll(); }
});

test('incomplete JSON for pk_write_round_doc is refused, not run; the model is told to resend and does, in full', { timeout: 60_000 }, async (t) => {
  const f = await appFixture();
  const intended = 'abc' + 'Z'.repeat(100);
  const complete = JSON.stringify({ kind: 'Questions', title: 'Incomplete', markdown: intended });
  const rawArguments = complete.slice(0, -90);
  const fake = await startFakeProvider((_prompt, messages, afterTool) => {
    if (!afterTool) return [{ name: 'pk_write_round_doc', args: {}, rawArguments }];
    if (messages.filter((m) => m.role === 'tool').length > 1) return 'Done.';
    // Make the re-send long enough to survive millisecond timestamp rounding.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    return [{ name: 'pk_write_round_doc', args: {}, rawArguments: complete }];
  }, { toolArgumentChunkSize: 19 });
  try {
    f.register(fake.url);
    const job = f.enqueue('incomplete-json', 'orientation');
    const done = await f.app.keeper.waitFor(f.project.id, job.id);
    const docs = f.store.roundDocs.filter((d) => d.jobId === job.id);
    assert.equal(docs.length, 1, 'the cut-off call wrote nothing; only the complete one did');
    assert.equal(docs[0]!.markdown, intended, 'nothing shortened');
    const refusal = String(fake.requests[1]?.messages.find((m) => m.role === 'tool')?.content ?? '');
    assert.match(refusal, /^Tool call "pk_write_round_doc" was not executed: its arguments did not arrive as complete JSON.*send the call again with the complete arguments/, 'the model is told what happened and to resend');
    const detail = await activityRoute(f.app, f.project.id)('/api/projects/:id/activity/:jobId', job.id);
    const steps = (detail.steps as { tool: string; isError: boolean; summary: string; target: string }[]).filter((s) => s.tool === 'pk_write_round_doc');
    assert.deepEqual(steps.map((s) => s.isError), [true, false]);
    assert.match(steps[0]!.summary, /was not executed: its arguments did not arrive as complete JSON/, 'the step shows what happened');
    assert.equal(steps[0]!.target, 'Incomplete', 'and which call it was');
    assert.equal(done.status, 'Done');
    assert.equal(fake.requests.length, 3);
    assert.ok((done.timing?.parseRetryMs ?? 0) >= 25, `the re-send is timed as parse/retry: ${JSON.stringify(done.timing)}`);
    t.diagnostic(JSON.stringify({ status: done.status, intendedLength: intended.length, savedLength: docs[0]!.markdown.length, requests: fake.requests.length, refusedStep: steps[0]!.summary, timing: done.timing }));
  } finally { fake.close(); f.app.stopAll(); }
});

test('schema refusal is returned to pi; model reissue works and is timed as parse/retry', { timeout: 60_000 }, async (t) => {
  const f = await appFixture();
  const fake = await startFakeProvider((_prompt, messages, afterTool) => {
    if (!afterTool) return [{ name: 'pk_write_round_doc', args: { kind: 'Questions', title: 'Missing markdown' } }];
    if (messages.filter((m) => m.role === 'tool').length === 1) {
      // Make the next provider response long enough to survive millisecond timestamp rounding.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      return [{ name: 'pk_write_round_doc', args: { kind: 'Questions', title: 'Reissued', markdown: '# Complete' } }];
    }
    return 'Done.';
  }, { toolArgumentChunkSize: 23 });
  try {
    f.register(fake.url);
    const job = f.enqueue('validation-reissue', 'orientation');
    const done = await f.app.keeper.waitFor(f.project.id, job.id);
    assert.equal(done.status, 'Done', done.error ?? '');
    assert.equal(f.store.roundDocs.find((d) => d.jobId === job.id)?.markdown, '# Complete');
    assert.equal(fake.requests.length, 3);
    assert.equal(done.steps.filter((s) => s.tool === 'pk_write_round_doc' && s.isError).length, 1);
    assert.ok((done.timing?.parseRetryMs ?? 0) >= 25, `timing: ${JSON.stringify(done.timing)}`);
    t.diagnostic(JSON.stringify({ status: done.status, requests: fake.requests.length, steps: done.steps.map((s) => ({ isError: s.isError, summary: s.summary })), timing: done.timing }));
  } finally { fake.close(); f.app.stopAll(); }
});

/** A model that re-sends the same refused call on every turn. Unlike the fake provider (six turns), it has no safety
 *  valve of its own until `giveUpAfter` requests, so whatever ends the job sooner is the Keeper's. */
function refusingProvider(giveUpAfter = 20): Promise<{ url: string; requests: () => number; close(): void }> {
  let requests = 0;
  const server = createServer((req, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      requests += 1;
      const chunk = (delta: object, finish: string | null) => ({ id: 'qc-refuse', object: 'chat.completion.chunk', created: 1, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 80, completion_tokens: 8, total_tokens: 88 } } : {}) });
      const call = { index: 0, id: `call_${requests}`, type: 'function', function: { name: 'pk_write_round_doc', arguments: JSON.stringify({ kind: 'Questions', title: 'Still missing markdown' }) } };
      const chunks = requests > giveUpAfter ? [chunk({ role: 'assistant', content: 'Gave up.' }, null), chunk({}, 'stop')] : [chunk({ role: 'assistant', tool_calls: [call] }, null), chunk({}, 'tool_calls')];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const value of chunks) res.write(`data: ${JSON.stringify(value)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, requests: () => requests, close: () => server.close() })));
}

test('the same refused call re-sent again and again ends the job Failed at the limit, with tool, error and count', { timeout: 60_000 }, async (t) => {
  const f = await appFixture();
  const fake = await refusingProvider();
  try {
    f.register(fake.url);
    const job = f.enqueue('repeated-validation-refusals', 'orientation');
    const done = await f.app.keeper.waitFor(f.project.id, job.id);
    assert.equal(done.status, 'Failed');
    assert.equal(done.steps.filter((s) => s.isError).length, REPEATED_REFUSAL_LIMIT);
    assert.equal(fake.requests(), REPEATED_REFUSAL_LIMIT, 'the model is not asked again after the limit');
    assert.equal(f.store.roundDocs.filter((d) => d.jobId === job.id).length, 0);
    assert.match(done.error ?? '', new RegExp(`the same call to pk_write_round_doc in ${REPEATED_REFUSAL_LIMIT} turns in a row, refused the same way each time`));
    // The schema no longer requires markdown (an update gives only what it changes); the writer refuses a new document
    // without it, in words the guard reads as a refusal.
    assert.match(done.error ?? '', /Invalid arguments: This round has no Questions document yet, so this call would create a Questions document, and a new one needs markdown/);
    assert.doesNotMatch(done.error ?? '', /Received arguments/, 'the error, not the arguments pi echoes after it');
    const row = (await activityRoute(f.app, f.project.id)('/api/projects/:id/activity')).jobs.find((j: { id: string }) => j.id === job.id);
    assert.equal(row?.status, 'Failed');
    assert.equal(row?.error, done.error);
    t.diagnostic(JSON.stringify({ status: done.status, requests: fake.requests(), refusedSteps: done.steps.filter((s) => s.isError).length, savedDocs: 0, error: done.error }));
  } finally { fake.close(); f.app.stopAll(); }
});

test('StepTimer counts the turn after a refusal as parse/retry only when it sends a tool call again', () => {
  const answered = new StepTimer();
  answered.assistantEnded({ timestamp: 0, stopReason: 'toolUse' }, 100);
  answered.toolStarted(100);
  answered.toolEnded(110, true, 'Validation failed for tool "pk_write_round_doc": markdown: must have required properties markdown');
  answered.assistantEnded({ timestamp: 110, stopReason: 'stop' }, 1110);
  const a = answered.finish(0, 0, 1110);
  assert.equal(a.parseRetryMs, 0, 'a final answer after a refusal re-sends nothing: generation');
  assert.equal(a.generationMs, 1100);
  const resent = new StepTimer();
  resent.assistantEnded({ timestamp: 0, stopReason: 'toolUse' }, 100);
  resent.toolStarted(100);
  resent.toolEnded(110, true, 'Validation failed for tool "pk_write_round_doc": markdown: must have required properties markdown');
  resent.assistantEnded({ timestamp: 110, stopReason: 'toolUse', content: [{ type: 'toolCall' }] }, 1110);
  const r = resent.finish(0, 0, 1110);
  assert.equal(r.parseRetryMs, 1000, 'a turn that sends the call again is the re-send');
  assert.equal(r.generationMs, 100);
});
