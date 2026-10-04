/**
 * Confirm on a note (owner 2026-09-22): a conversation on a note gets the note whole — body, mount,
 * origin, judgement record and the rules it lists — while the panel's brief stays short; `Confirm`
 * sends the owner's fixed statement with the note as context, and the note is Decided only when the
 * message's source was used to record a confirmation or a decision (§4.4, §3.9).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-pi-agent-'));
const { App } = await import('../server/app.ts');
const { startFakeProvider, FAKE_MODEL, defaultPlanner } = await import('./fake-provider.ts');
const { deriveGraph } = await import('./organize/graph.ts');
const { overview } = await import('../server/graph-view.ts');
const { HttpApp } = await import('../server/http.ts');
const { registerRoutes } = await import('../server/api.ts');
const { DEPTH_NOTE_ID } = await import('./organize/takeover.ts');
const { keeperTools } = await import('./tools.ts');

type Planner = Parameters<typeof startFakeProvider>[0];

async function setup(planner: Planner = defaultPlanner) {
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-proj-'));
  writeFileSync(join(projectDir, 'README.md'), '# Demo\n\nA demo.\n');
  const app = new App(home, { organizing: false });
  const project = app.addProject('Demo', [projectDir]);
  await app.intakeProject(project.id);
  app.stopAll();
  await app.initKeeper();
  const fake = await startFakeProvider(planner);
  app.keeper.models.registerProvider('fake', { name: 'Fake', baseUrl: fake.url, apiKey: 'k', api: 'openai-completions', models: [FAKE_MODEL] });
  app.keeper.setModel({ provider: 'fake', id: FAKE_MODEL.id, thinking: null });
  const store = app.store(project.id);
  const now = new Date().toISOString();
  const file = store.sources.find((s) => s.anchor.kind === 'file')!;
  store.reference.put({ id: 'ref_a', projectId: project.id, category: 'Area', name: 'Docs', ids: [], text: 'Documentation.', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: { author: { kind: 'owner', name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' }, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: now, updatedAt: now });
  store.threads.put({ id: 'thread_t', projectId: project.id, title: 'Write docs', ids: ['T-1'], doing: 'Writing the docs.', changed: '', results: 'A README.', unresolved: 'Nothing.', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [{ referenceId: 'ref_a', claim: 'documents', basis: 'Explicit' }], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, inputs: { jobId: 'x', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: now, updatedAt: now, pendingSourceIds: [] });
  store.changes.put({ id: 'chg_1', projectId: project.id, at: now, atSource: 'material', material: 'Decision', effect: 'Replaced', title: 'DEC-2', summary: 'Search replaces the tag browser.', before: 'Tag browser', after: 'Search', sourceIds: [file.id], by: { author: { kind: 'owner', name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' }, affects: ['ref_a'], propagation: [], segment: null, createdInJobId: null, updatedAt: now });
  store.judgements.put({ id: 'jdg_full', projectId: project.id, jobId: 'x', at: now, scope: { kind: 'thread', ids: ['thread_t'], label: 'Docs work' }, inputs: { referenceIds: ['ref_a'], threadIds: ['thread_t'], areaIds: [], relationIds: [], keyEvidenceSourceIds: [file.id], conflictingSourceIds: [], previousNoteIds: [], investigations: [{ jobId: 'job_inv', conclusion: 'Nothing newer was found.', sourceIds: [] }] }, excluded: [], outcome: { noteIds: ['note_full'], assessments: [], reconsideredOnly: false } });
  store.notes.put({
    id: 'note_full', projectId: project.id, mount: { kind: 'node', ids: ['thread_t'] }, status: 'Current', ownerResponse: null,
    versions: [{ version: 2, at: now, title: 'Docs are thin', preview: 'One README.', ask: 'Worth discussing', judgementRecordId: 'jdg_full', reason: 'test', body: { currentView: 'Only a README exists.', whyItMatters: 'New agents read the README first.', facts: [{ text: 'The README has one section.', sourceIds: [file.id], inferred: false }, { text: 'No contributor guide exists.', sourceIds: [], inferred: true }], otherExplanations: 'The docs may live elsewhere.', keepAdjust: 'Keep the README, add a guide.', whatWouldSettleIt: 'A second document appearing.' } }],
    discussion: [{ role: 'owner', text: 'Is this still right?', at: now, sourceId: file.id }, { role: 'keeper', text: 'Yes, as of this round.', at: now, sourceId: null }],
    followUps: [], author: { agent: 'pi', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null,
    cameFrom: { kind: 'Change follow-up', jobKind: 'Follow up round', jobId: 'job_x', changeIds: ['chg_1'] }, language: 'en', updatedAt: now,
  });
  store.rules.put({ id: 'rule_1', projectId: project.id, group: 'Working rules', category: null, summary: 'Commits land on main directly', excerpt: null, sourceIds: [file.id], appliesTo: ['the whole project'], basis: 'Inferred', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: 'x', asOf: now, updatedAt: now });
  store.judgements.put({ id: 'jdg_rules', projectId: project.id, jobId: 'x', at: now, scope: { kind: 'rules', ids: ['rule_1'], label: 'Rules inferred in round 1' }, inputs: { referenceIds: [], threadIds: [], areaIds: [], relationIds: [], keyEvidenceSourceIds: [file.id], conflictingSourceIds: [], previousNoteIds: [], investigations: [] }, excluded: [], outcome: { noteIds: ['note_rules'], assessments: [], reconsideredOnly: false } });
  store.notes.put({ id: 'note_rules', projectId: project.id, mount: { kind: 'project', ids: [] }, status: 'Current', ownerResponse: null, versions: [{ version: 1, at: now, title: 'Do the inferred rules hold?', preview: 'One rule was inferred.', ask: 'For your decision', judgementRecordId: 'jdg_rules', reason: 'test', body: { currentView: 'Inferred in round 1: rule_1.', whyItMatters: 'An agent follows the project’s rules.', facts: [{ text: 'Commits land on main directly — for an agent this means: no feature branches (rule rule_1; applies to the whole project; inferred from the records cited)', sourceIds: [file.id], inferred: true }], otherExplanations: null, keepAdjust: null, whatWouldSettleIt: 'Your word in the conversation.' } }], discussion: [], followUps: [], author: { agent: 'pi', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, language: 'en', updatedAt: now });
  deriveGraph(store, project);
  return { app, project, fake, store, file };
}

async function startApi(app: InstanceType<typeof App>) {
  const http = new HttpApp();
  registerRoutes(http, app, '', '');
  const server = await http.listen(0);
  return { baseUrl: `http://127.0.0.1:${server.port}`, close: server.close };
}

const postConfirm = (baseUrl: string, projectId: string, noteId: string) =>
  fetch(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}/notes/${encodeURIComponent(noteId)}/confirm`, { method: 'POST' });

const allPrompts = (fake: Awaited<ReturnType<typeof setup>>['fake']) =>
  fake.requests.map((r) => r.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')).join('\n---\n');

test('a conversation on a note gets the note whole; the panel brief stays short', async () => {
  const { app, project, fake, store } = await setup();
  const api = await startApi(app);
  try {
    const context = { kind: 'note', id: 'note_full', label: 'Docs are thin' };
    const response = await fetch(`${api.baseUrl}/api/projects/${encodeURIComponent(project.id)}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Is this note still right?', context, conversationId: null }),
    });
    assert.equal(response.status, 200);
    const t = await response.json() as { conversationId: string; jobId: string; mode: 'turn' | 'steer'; status: string };
    const job = await app.keeper.waitFor(project.id, t.jobId);
    assert.equal(job.status, 'Done', job.error ?? '');
    const prompt = allPrompts(fake);
    assert.ok(prompt, 'the fake provider recorded the turn');
    for (const expected of ['Docs are thin', 'Only a README exists.', 'New agents read the README first.', 'The README has one section.', 'No contributor guide exists.', 'inferred', 'The docs may live elsewhere.', 'Keep the README, add a guide.', 'A second document appearing.', 'Write docs', 'thread_t', 'Change follow-up', 'job_x', 'DEC-2', 'jdg_full', 'ref_a', 'Nothing newer was found.', 'Is this still right?']) {
      assert.ok(prompt.includes(expected), `the prompt carries the note whole: ${expected}`);
    }
    const panelResponse = await fetch(`${api.baseUrl}/api/projects/${encodeURIComponent(project.id)}/chat?conversation=new&context=${encodeURIComponent(JSON.stringify(context))}`);
    assert.equal(panelResponse.status, 200);
    const panel = await panelResponse.json() as { existing: { text: string } | null };
    assert.ok(panel.existing?.text.includes('Only a README exists.'), 'the panel brief keeps the current view');
    assert.ok(!panel.existing?.text.includes('New agents read the README first.'), 'the panel brief stays short: no why-it-matters');
    assert.ok(!panel.existing?.text.includes('The docs may live elsewhere.'), 'no other explanations in the panel brief');
  } finally { await api.close(); fake.close(); app.stopAll(); }
});

test('confirm on a rules note confirms each inferred rule; the note is Decided and leaves attention', async () => {
  const seen: string[] = [];
  const planner: Planner = (prompt, messages, afterTool) => {
    if (/I confirm this note:/.test(prompt)) {
      seen.push(prompt);
      const quote = /"""\n([\s\S]*?)\n"""/.exec(prompt)?.[1] ?? '';
      return [{ name: 'pk_write_rule', args: { id: 'rule_1', ownerConfirmed: { quote } } }];
    }
    return defaultPlanner(prompt, messages, afterTool);
  };
  const { app, project, fake, store } = await setup(planner);
  const api = await startApi(app);
  try {
    assert.ok(overview(store, project, null, null).needsYou.some((i) => i.id === 'note_rules'), 'the note waits for the owner first');
    const response = await postConfirm(api.baseUrl, project.id, 'note_rules');
    assert.equal(response.status, 200);
    const c = await response.json() as { conversationId: string; jobId: string; mode: 'turn' | 'steer'; status: string };
    assert.equal(c.mode, 'turn');
    assert.ok(c.conversationId && c.jobId && c.status, 'the answer has the shape of a sent message');
    const job = await app.keeper.waitFor(project.id, c.jobId);
    assert.equal(job.status, 'Done', job.error ?? '');
    await new Promise((r) => setTimeout(r, 50));
    const ownerMessage = store.sources.find((s) => s.anchor.kind === 'session' && s.excerpt.includes('I confirm this note:'));
    assert.ok(ownerMessage, 'the fixed statement is recorded as an owner message');
    assert.equal(ownerMessage!.said?.by, 'owner');
    assert.ok(seen[0]?.includes('Commits land on main directly'), 'the prompt carries each rule the note lists');
    assert.ok(seen[0]?.includes('not confirmed'), 'and says the rule is not confirmed yet');
    const rule = store.rules.get('rule_1')!;
    assert.equal(rule.basis, 'Explicit', 'the confirmed rule becomes Explicit');
    assert.equal(rule.ownerConfirmation?.sourceId, ownerMessage!.id, 'with the owner’s message as its source');
    assert.equal(store.notes.get('note_rules')!.ownerResponse, 'Decided');
    assert.ok(!overview(store, project, null, null).needsYou.some((i) => i.id === 'note_rules'), 'Decided leaves Notes (attention)');
    const discussion = store.notes.get('note_rules')!.discussion;
    assert.ok(discussion.some((d) => d.role === 'owner' && d.text.includes('I confirm this note:')), 'the confirmation joins the discussion');
  } finally { await api.close(); fake.close(); app.stopAll(); }
});

test('confirm records nothing when the Keeper does not: the note is Discussed', async () => {
  const { app, project, fake, store } = await setup();
  const api = await startApi(app);
  try {
    const response = await postConfirm(api.baseUrl, project.id, 'note_rules');
    assert.equal(response.status, 200);
    const c = await response.json() as { jobId: string };
    const job = await app.keeper.waitFor(project.id, c.jobId);
    assert.equal(job.status, 'Done', job.error ?? '');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(store.notes.get('note_rules')!.ownerResponse, 'Discussed');
    assert.equal(store.rules.get('rule_1')!.basis, 'Inferred', 'nothing was confirmed');
  } finally { await api.close(); fake.close(); app.stopAll(); }
});

test('the confirm endpoint returns 404 for an unknown note and 409 for the three conflicts', async () => {
  const { app, project, fake, store } = await setup();
  const api = await startApi(app);
  try {
    const refused = async (noteId: string, status: number, reason: RegExp) => {
      const response = await postConfirm(api.baseUrl, project.id, noteId);
      assert.equal(response.status, status);
      const body = await response.json() as { error?: string };
      assert.match(body.error ?? '', reason);
    };
    await refused('note_nope', 404, /^Unknown note$/);

    store.notes.put({ ...store.notes.get('note_full')!, status: 'Resolved' });
    await refused('note_full', 409, /Resolved/);

    store.notes.put({ ...store.notes.get('note_rules')!, ownerResponse: 'Decided' });
    await refused('note_rules', 409, /Decided/);

    const depth = store.notes.get('note_full')!;
    store.notes.put({ ...depth, id: DEPTH_NOTE_ID, status: 'Current', ownerResponse: null });
    await refused(DEPTH_NOTE_ID, 409, /depth/i);
  } finally { await api.close(); fake.close(); app.stopAll(); }
});

test('confirm while the latest session is answering opens a new session instead of steering', async () => {
  const { app, project, fake, store } = await setup();
  const api = await startApi(app);
  try {
    const t1 = app.conversation.send(project.id, { text: 'What is this project?', context: null, conversationId: null });
    await app.keeper.waitFor(project.id, t1.jobId);
    fake.mode.value = 'hang';
    const t2 = app.conversation.send(project.id, { text: 'Take your time', context: null, conversationId: t1.conversationId });
    for (let i = 0; i < 100 && store.jobs.get(t2.jobId)?.status !== 'Running'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(store.jobs.get(t2.jobId)?.status, 'Running');
    const response = await postConfirm(api.baseUrl, project.id, 'note_rules');
    assert.equal(response.status, 200);
    const c = await response.json() as { conversationId: string; jobId: string; mode: 'turn' | 'steer'; status: string };
    assert.equal(c.mode, 'turn', 'a confirm is never a mid-course steer');
    assert.notEqual(c.conversationId, t1.conversationId, 'a busy session gets a new one');
    app.keeper.stopJob(project.id, t2.jobId);
    await app.keeper.waitFor(project.id, t2.jobId);
    fake.mode.value = 'normal';
    const job = await app.keeper.waitFor(project.id, c.jobId);
    assert.equal(job.status, 'Done', job.error ?? '');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(store.notes.get('note_rules')!.ownerResponse, 'Discussed');
    assert.equal(app.conversation.sessions(project.id).length, 2, 'the busy session and the confirm’s own');
  } finally { await api.close(); fake.close(); app.stopAll(); }
});

test('pk_write_note refuses a mount that names nothing in the assets, and accepts the legal ones', async () => {
  const { app, project, fake, store } = await setup();
  try {
    const tools = keeperTools({ store, project, jobId: 'job_1', jobKind: 'Organizing', model: null });
    const writeNote = tools.find((t) => t.name === 'pk_write_note')!;
    const call = async (args: Record<string, unknown>) => {
      const run = writeNote.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
      const result = await run('call', args);
      return { text: result.content.map((c) => c.text).join('\n'), error: result.isError === true };
    };
    const base = { title: 'A note', preview: 'p', ask: 'For information', judgementRecordId: 'jdg_full', reason: 'test' };

    const projectIds = await call({ ...base, mountKind: 'project', mountIds: [project.id] });
    assert.equal(projectIds.error, true, 'a project mount carrying ids is refused');
    assert.match(projectIds.text, /no mount ids|takes no ids|hangs on the project/);

    const nodeBad = await call({ ...base, mountKind: 'node', mountIds: ['thread_gone'] });
    assert.equal(nodeBad.error, true);
    assert.ok(nodeBad.text.includes('thread_gone'), 'the refusal lists the ids that are not in the assets');

    const pathBad = await call({ ...base, mountKind: 'path', mountIds: ['ref_gone'] });
    assert.equal(pathBad.error, true);
    assert.ok(pathBad.text.includes('ref_gone'));

    const relationBad = await call({ ...base, mountKind: 'relation', mountIds: ['thread_t'] });
    assert.equal(relationBad.error, true);
    assert.match(relationBad.text, /relation/);

    const okProject = await call({ ...base, mountKind: 'project', mountIds: [] });
    assert.equal(okProject.error, false, okProject.text);
    const okNode = await call({ ...base, title: 'Another note', mountKind: 'node', mountIds: ['thread_t'] });
    assert.equal(okNode.error, false, okNode.text);
    const okNodeRef = await call({ ...base, title: 'A third note', mountKind: 'node', mountIds: ['ref_a'] });
    assert.equal(okNodeRef.error, false, okNodeRef.text);
    const okPath = await call({ ...base, title: 'A fourth note', mountKind: 'path', mountIds: ['thread_t'] });
    assert.equal(okPath.error, false, okPath.text);
    const relationId = store.relations.all()[0]!.id;
    const okRelation = await call({ ...base, title: 'A fifth note', mountKind: 'relation', mountIds: [relationId] });
    assert.equal(okRelation.error, false, okRelation.text);

    const noteId = (JSON.parse(okNode.text) as { id: string }).id;
    const update = await call({ ...base, id: noteId, title: 'Another note', mountKind: 'node', mountIds: ['thread_gone'], reason: 'update keeps the mount' });
    assert.equal(update.error, false, update.text);
    assert.deepEqual(store.notes.get(noteId)!.mount, { kind: 'node', ids: ['thread_t'] }, 'an update keeps the mount it had');
  } finally { fake.close(); app.stopAll(); }
});
