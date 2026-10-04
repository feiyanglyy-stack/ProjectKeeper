/**
 * Conversation (§6.8): turns of one session share the pi session; a message during an answer
 * is a mid-course adjustment; an explicit request becomes "Your request" with the owner's
 * message as basis; a conversation on a note joins its discussion; existing understanding is
 * read from the assets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-pi-agent-'));
const { App } = await import('../server/app.ts');
const { startFakeProvider, FAKE_MODEL } = await import('./fake-provider.ts');

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-proj-'));
  writeFileSync(join(projectDir, 'README.md'), '# Demo\n\nA demo.\n');
  const app = new App(home, { organizing: false });
  const project = app.addProject('Demo', [projectDir]);
  await app.intakeProject(project.id);
  app.stopAll();
  await app.initKeeper();
  const fake = await startFakeProvider();
  app.keeper.models.registerProvider('fake', { name: 'Fake', baseUrl: fake.url, apiKey: 'k', api: 'openai-completions', models: [FAKE_MODEL] });
  app.keeper.setModel({ provider: 'fake', id: FAKE_MODEL.id, thinking: null });
  const store = app.store(project.id);
  const now = new Date().toISOString();
  store.reference.put({ id: 'ref_a', projectId: project.id, category: 'Area', name: 'Docs', ids: [], text: 'Documentation.', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: { author: { kind: 'owner', name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' }, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: now, updatedAt: now });
  store.threads.put({ id: 'thread_t', projectId: project.id, title: 'Write docs', ids: ['T-1'], doing: 'Writing the docs.', changed: '', results: 'A README.', unresolved: 'Nothing.', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [{ referenceId: 'ref_a', claim: 'documents', basis: 'Explicit' }], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, inputs: { jobId: 'x', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: now, updatedAt: now, pendingSourceIds: [] });
  store.judgements.put({ id: 'jdg_x', projectId: project.id, jobId: 'x', at: now, scope: { kind: 'project', ids: [], label: 'p' }, inputs: { referenceIds: [], threadIds: [], areaIds: [], relationIds: [], keyEvidenceSourceIds: [], conflictingSourceIds: [], previousNoteIds: [], investigations: [] }, excluded: [], outcome: { noteIds: ['note_x'], assessments: [], reconsideredOnly: false } });
  store.notes.put({ id: 'note_x', projectId: project.id, mount: { kind: 'node', ids: ['thread_t'] }, status: 'Current', ownerResponse: null, versions: [{ version: 1, at: now, title: 'Docs are thin', preview: 'One README.', body: { currentView: 'Only a README exists.', whyItMatters: null, facts: [], otherExplanations: null, keepAdjust: null, whatWouldSettleIt: null }, ask: 'Worth discussing', judgementRecordId: 'jdg_x', reason: 'test' }], discussion: [], followUps: [], author: { agent: 'pi', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, language: 'en', updatedAt: now });
  const { deriveGraph } = await import('./organize/graph.ts');
  deriveGraph(store, project);
  return { app, project, fake, store };
}

test('turns share a session, a mid-course message steers, a request becomes Your request, notes gather the discussion', async () => {
  const { app, project, fake, store } = await setup();
  try {
    assert.match(app.conversation.existing(project.id, { kind: 'node', id: 'thread_t', label: 'Write docs' })?.text ?? '', /Writing the docs/, 'existing understanding read from the assets');
    // A note written earlier comes with when it was written, for the line above it (§6.8 `Written earlier · <time>`, D105).
    const earlier = app.conversation.existing(project.id, { kind: 'note', id: 'note_x', label: 'Docs are thin' })!;
    assert.equal(earlier.text, 'Docs are thin\nOne README.\nOnly a README exists.');
    assert.equal(earlier.at, store.notes.get('note_x')!.versions[0]!.at);
    assert.equal(app.conversation.existing(project.id, { kind: 'node', id: 'thread_t', label: 'Write docs' })?.at, undefined, 'an object’s summary is put together now: it has no one time of writing');
    const t1 =app.conversation.send(project.id, { text: 'What is this project?', context: null, conversationId: null });
    assert.equal(t1.mode, 'turn');
    const j1 = await app.keeper.waitFor(project.id, t1.jobId);
    assert.equal(j1.status, 'Done', j1.error ?? '');
    assert.match(j1.resultText ?? '', /Answer #1/);
    assert.match(j1.resultText ?? '', /src_[0-9a-f]{16}/, 'the owner message is a cited source');
    assert.ok(store.sources.find((s) => s.anchor.kind === 'session' && s.anchor.host === 'pi' && s.excerpt.includes('What is this project?')), 'owner message stored as a source');

    const t2 = app.conversation.send(project.id, { text: 'And what is unresolved?', context: { kind: 'node', id: 'thread_t', label: 'Write docs' }, conversationId: t1.conversationId });
    assert.equal(t2.conversationId, t1.conversationId);
    const j2 = await app.keeper.waitFor(project.id, t2.jobId);
    assert.equal(j2.status, 'Done', j2.error ?? '');
    assert.match(j2.resultText ?? '', /Answer #2/, 'the second turn sees the first turn in the same session');
    assert.equal(j2.sessionFile, j1.sessionFile, 'same pi session file');
    const sessions = app.conversation.sessions(project.id);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.turns, 2);
    assert.equal(app.conversation.turns(project.id, t1.conversationId).length, 2);

    // Mid-course adjustment while answering.
    fake.mode.value = 'hang';
    const t3 = app.conversation.send(project.id, { text: 'Take your time', context: null, conversationId: t1.conversationId });
    for (let i = 0; i < 100 && store.jobs.get(t3.jobId)?.status !== 'Running'; i++) await new Promise((r) => setTimeout(r, 50));
    const mid = app.conversation.send(project.id, { text: 'Actually, shorter please', context: null, conversationId: t1.conversationId });
    assert.equal(mid.mode, 'steer');
    assert.equal(mid.jobId, t3.jobId, JSON.stringify(store.jobs.all().map((j) => [j.id, j.status, j.kind, j.scope.label, j.queuedAt])));
    assert.equal((store.jobs.get(t3.jobId)!.task as { extra: { followUps: unknown[] } }).extra.followUps.length, 1);
    app.keeper.stopJob(project.id, t3.jobId);
    const j3 = await app.keeper.waitFor(project.id, t3.jobId);
    assert.equal(j3.status, 'Stopped');
    fake.mode.value = 'normal';

    // Explicit request → Your request with the owner's message as basis.
    const t4 = app.conversation.send(project.id, { text: 'DELEGATE: fix the README title', context: null, conversationId: t1.conversationId });
    const j4 = await app.keeper.waitFor(project.id, t4.jobId);
    assert.equal(j4.status, 'Done', j4.error ?? '');
    assert.equal(j4.kind, 'Your request');
    assert.equal(j4.requestBasis?.kind, 'delegation');
    assert.ok(store.sources.has(j4.requestBasis!.ref), 'basis is the owner message source');
    assert.match(j4.resultText ?? '', /Done as you asked/);

    // A conversation on a note joins its discussion.
    const t5 = app.conversation.send(project.id, { text: 'Is this note still right?', context: { kind: 'note', id: 'note_x', label: 'Docs are thin' }, conversationId: null });
    const j5 = await app.keeper.waitFor(project.id, t5.jobId);
    assert.equal(j5.status, 'Done', j5.error ?? '');
    await new Promise((r) => setTimeout(r, 50));
    const note = store.notes.get('note_x')!;
    assert.equal(note.discussion.length, 2);
    assert.equal(note.discussion[0]!.role, 'owner');
    assert.equal(note.discussion[1]!.role, 'keeper');
    assert.equal(note.ownerResponse, 'Discussed');
    assert.equal(app.conversation.sessions(project.id).length, 2, 'a second session exists');
  } finally { fake.close(); app.stopAll(); }
});

test('a message stored from the conversation records who wrote it and where the words begin, so the heading never decides whose words they are', async () => {
  const { app, project, fake, store } = await setup();
  try {
    const t1 = app.conversation.send(project.id, { text: 'Keep the README to one page.', context: null, conversationId: null });
    const q1 = app.conversation.send(project.id, { text: 'Which file should I read first?', context: null, conversationId: null, asker: 'agent' });
    const stored = (words: string) => store.sources.find((s) => s.anchor.kind === 'session' && s.anchor.host === 'pi' && s.excerpt.includes(words))!;
    const owner = stored('Keep the README to one page.');
    assert.equal(owner.said?.by, 'owner', 'the owner’s message is recorded as the owner’s');
    assert.equal(owner.excerpt.slice(owner.said!.wordsFrom), 'Keep the README to one page.', 'and the words start where the record says');
    const agent = stored('Which file should I read first?');
    assert.equal(agent.said?.by, 'agent', 'an execution agent’s query is recorded as the agent’s');
    assert.equal(agent.excerpt.slice(agent.said!.wordsFrom), 'Which file should I read first?');
    for (const j of [t1.jobId, q1.jobId]) await app.keeper.waitFor(project.id, j);
  } finally { fake.close(); app.stopAll(); }
});
