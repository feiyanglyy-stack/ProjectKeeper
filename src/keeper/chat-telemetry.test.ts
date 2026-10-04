import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-pi-agent-'));
const { App } = await import('../server/app.ts');
const { registerRoutes } = await import('../server/api.ts');
const { startFakeProvider, FAKE_MODEL } = await import('./fake-provider.ts');
const { SessionManager } = await import('@earendil-works/pi-coding-agent');

const OTHER_MODEL = { ...FAKE_MODEL, id: 'fake-2', name: 'Fake provider 2', contextWindow: 64_000 };

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-proj-'));
  writeFileSync(join(projectDir, 'README.md'), '# Demo\n');
  const app = new App(home, { organizing: false });
  const project = app.addProject('Demo', [projectDir]);
  await app.intakeProject(project.id);
  app.stopAll();
  await app.initKeeper();
  const fake = await startFakeProvider();
  app.keeper.models.registerProvider('fake', {
    name: 'Fake', baseUrl: fake.url, apiKey: 'k', api: 'openai-completions', models: [FAKE_MODEL, OTHER_MODEL],
  });
  app.keeper.setModel({ provider: 'fake', id: FAKE_MODEL.id, thinking: null });
  return { app, project, fake };
}

function getChat(app: InstanceType<typeof App>, projectId: string, query = ''): Promise<Record<string, any>> {
  const handlers = new Map<string, (ctx: any) => unknown>();
  const http = { route: (method: string, path: string, handler: (ctx: any) => unknown) => handlers.set(`${method} ${path}`, handler), static: () => undefined };
  registerRoutes(http as never, app, '', '');
  return Promise.resolve(handlers.get('GET /api/projects/:id/chat')!({ params: { id: projectId }, query: new URLSearchParams(query), body: null }) as Record<string, any>);
}

test('a new conversation reports the configured model/window but no invented usage or model request', async () => {
  const { app, project, fake } = await setup();
  try {
    app.keeper.setModel({ provider: 'fake', id: OTHER_MODEL.id, thinking: null });
    const chat = await getChat(app, project.id, 'conversation=new');
    assert.deepEqual(chat.telemetry, {
      model: { provider: 'fake', id: 'fake-2', name: 'Fake provider 2' },
      context: { usedTokens: null, limitTokens: 64_000, percent: null, estimated: false, source: 'unavailable' },
    });
    assert.equal(fake.requests.length, 0, 'reading telemetry sends no request to the model');
  } finally { fake.close(); app.stopAll(); }
});

test('live and saved conversation telemetry use the session branch, not cumulative job usage or a later global model', async () => {
  const { app, project, fake } = await setup();
  try {
    const sent = app.conversation.send(project.id, { text: 'What is this?', context: null, conversationId: null });
    const done = await app.keeper.waitFor(project.id, sent.jobId);
    assert.equal(done.status, 'Done', done.error ?? '');
    app.store(project.id).jobs.put({ ...done, usage: { input: 900_000, output: 80_000, cacheRead: 10_000, cacheWrite: 0, cost: 99 } });
    app.keeper.setModel({ provider: 'fake', id: OTHER_MODEL.id, thinking: null });

    const live = app.conversation.telemetry(project.id, sent.conversationId);
    assert.deepEqual(live.model, { provider: 'fake', id: FAKE_MODEL.id, name: FAKE_MODEL.name }, 'the live session model wins over the new global setting');
    assert.equal(live.context.source, 'live');
    assert.equal(live.context.usedTokens, 88, 'the current request usage is not the job cumulative total');
    assert.equal(live.context.limitTokens, FAKE_MODEL.contextWindow);
    assert.equal(live.context.estimated, false);

    const key = `conversation:${project.id}:${sent.conversationId}`;
    const internals = app.keeper as unknown as { live: Map<string, { session: { dispose(): void } }> };
    internals.live.get(key)?.session.dispose();
    internals.live.delete(key);
    const saved = app.conversation.telemetry(project.id, sent.conversationId);
    assert.deepEqual(saved.model, { provider: 'fake', id: FAKE_MODEL.id, name: FAKE_MODEL.name }, 'the saved branch keeps its actual model');
    assert.equal(saved.context.source, 'saved');
    assert.equal(saved.context.usedTokens, 88);
    assert.equal(saved.context.limitTokens, FAKE_MODEL.contextWindow);
    assert.equal(saved.context.estimated, false);

    const api = await getChat(app, project.id, `conversation=${encodeURIComponent(sent.conversationId)}`);
    assert.deepEqual(api.telemetry, saved, 'GET /chat exposes the same read-only telemetry');
  } finally { fake.close(); app.stopAll(); }
});

test('a saved branch immediately after compaction keeps usage unknown until another valid response', async () => {
  const { app, project, fake } = await setup();
  try {
    const sent = app.conversation.send(project.id, { text: 'Summarize this.', context: null, conversationId: null });
    const done = await app.keeper.waitFor(project.id, sent.jobId);
    assert.ok(done.sessionFile);
    const key = `conversation:${project.id}:${sent.conversationId}`;
    const internals = app.keeper as unknown as { live: Map<string, { session: { dispose(): void } }> };
    internals.live.get(key)?.session.dispose();
    internals.live.delete(key);

    const manager = SessionManager.open(done.sessionFile!);
    const firstMessage = manager.getBranch().find((entry) => entry.type === 'message')!;
    const compactLeaf = manager.appendCompaction('Saved summary', firstMessage.id, 88);
    const current = app.store(project.id).jobs.get(done.id)!;
    const task = current.task as { extra?: Record<string, unknown> };
    app.store(project.id).jobs.put({ ...current, task: { ...(current.task as object), extra: { ...(task.extra ?? {}), leafId: compactLeaf } } });

    const telemetry = app.conversation.telemetry(project.id, sent.conversationId);
    assert.equal(telemetry.context.source, 'saved');
    assert.deepEqual(telemetry.context, { usedTokens: null, limitTokens: FAKE_MODEL.contextWindow, percent: null, estimated: false, source: 'saved' });
  } finally { fake.close(); app.stopAll(); }
});

test('saved telemetry ignores usage entries and omitted assistant replies', async () => {
  const { app, project, fake } = await setup();
  try {
    const sent = app.conversation.send(project.id, { text: 'One reply.', context: null, conversationId: null });
    const done = await app.keeper.waitFor(project.id, sent.jobId);
    assert.ok(done.sessionFile);
    const key = `conversation:${project.id}:${sent.conversationId}`;
    const internals = app.keeper as unknown as { live: Map<string, { session: { dispose(): void } }> };
    internals.live.get(key)?.session.dispose();
    internals.live.delete(key);

    const manager = SessionManager.open(done.sessionFile!);
    const assistant = manager.getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'assistant');
    assert.ok(assistant && assistant.type === 'message' && assistant.message.role === 'assistant');
    manager.appendUsage('cache_warm', 'fake', FAKE_MODEL.id, assistant.message.usage);
    const setLeaf = () => {
      const current = app.store(project.id).jobs.get(done.id)!;
      const task = current.task as { extra?: Record<string, unknown> };
      app.store(project.id).jobs.put({ ...current, task: { ...(current.task as object), extra: { ...(task.extra ?? {}), leafId: manager.getLeafId() } } });
    };
    setLeaf();
    assert.equal(app.conversation.telemetry(project.id, sent.conversationId).context.usedTokens, 88, 'a usage entry is billing, not context');

    manager.appendContextEdit(assistant.id, null);
    setLeaf();
    const edited = app.conversation.telemetry(project.id, sent.conversationId);
    assert.equal(edited.context.source, 'saved');
    assert.equal(edited.context.usedTokens, null, 'the only usage-backed reply is absent from provider context');
  } finally { fake.close(); app.stopAll(); }
});

test('saved telemetry never creates or rewrites missing, empty, or legacy session files', async () => {
  const { app, project, fake } = await setup();
  try {
    const savedModel = { provider: 'fake', id: FAKE_MODEL.id };
    const missing = join(app.home, 'missing-session.jsonl');
    const missingTelemetry = app.keeper.chatTelemetry('conversation:missing', { sessionFile: missing, model: savedModel });
    assert.equal(missingTelemetry.context.source, 'unavailable');
    assert.equal(existsSync(missing), false, 'a missing saved session stays missing');

    const empty = join(app.home, 'empty-session.jsonl');
    writeFileSync(empty, '');
    const emptyBefore = readFileSync(empty);
    const emptyTelemetry = app.keeper.chatTelemetry('conversation:empty', { sessionFile: empty, model: savedModel });
    assert.equal(emptyTelemetry.context.source, 'unavailable');
    assert.deepEqual(readFileSync(empty), emptyBefore, 'an empty saved session is not initialized as a side effect');

    const sent = app.conversation.send(project.id, { text: 'One saved response.', context: null, conversationId: null });
    const done = await app.keeper.waitFor(project.id, sent.jobId);
    const key = `conversation:${project.id}:${sent.conversationId}`;
    const internals = app.keeper as unknown as { live: Map<string, { session: { dispose(): void } }> };
    internals.live.get(key)?.session.dispose();
    internals.live.delete(key);
    const lines = readFileSync(done.sessionFile!, 'utf8').trimEnd().split('\n');
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    lines[0] = JSON.stringify({ ...header, version: 2 });
    writeFileSync(done.sessionFile!, `${lines.join('\n')}\n`);
    const legacyBefore = readFileSync(done.sessionFile!);
    const legacy = app.conversation.telemetry(project.id, sent.conversationId);
    assert.equal(legacy.context.source, 'saved', 'a legacy session can be migrated in memory');
    assert.equal(legacy.context.usedTokens, 88);
    assert.deepEqual(readFileSync(done.sessionFile!), legacyBefore, 'the legacy file bytes are untouched');
  } finally { fake.close(); app.stopAll(); }
});
