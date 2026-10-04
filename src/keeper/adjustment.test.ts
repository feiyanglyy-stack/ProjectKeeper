/**
 * Adjustment and propagation (CKC-11): a standing authorization recorded from the owner's
 * words, work under it as "Your request", revocation; propagation entries derived for downstream
 * work, and a changed material marking that work Update pending; a re-look follows a delegated adjustment.
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

const planner: Parameters<typeof startFakeProvider>[0] = (prompt, messages, afterTool) => {
  const text = /"""\n([\s\S]*?)\n"""/.exec(prompt)?.[1] ?? '';
  if (/^AUTH:/.test(text)) return [{ name: 'pk_record_authorization', args: { scope: 'fix stale document references directly', quote: text } }];
  if (/^USE-AUTH:/.test(text)) {
    const all = messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    const auth = /auth_[a-z0-9]+/.exec(all)?.[0];
    return [{ name: 'pk_begin_request', args: { scope: 'update a stale reference', quote: 'standing authorization', authorizationId: auth } }];
  }
  return defaultPlanner(prompt, messages, afterTool);
};

test('authorization, propagation and the re-look after a delegated adjustment', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-proj-'));
  writeFileSync(join(projectDir, 'PLAN.md'), '# Plan\n\n- T-3 Tag browser\n');
  const app = new App(home, { organizing: false });
  const fake = await startFakeProvider(planner);
  try {
    const project = app.addProject('Demo', [projectDir]);
    await app.intakeProject(project.id);
    app.stopAll();
    await app.initKeeper();
    app.keeper.models.registerProvider('fake', { name: 'Fake', baseUrl: fake.url, apiKey: 'k', api: 'openai-completions', models: [FAKE_MODEL] });
    app.keeper.setModel({ provider: 'fake', id: FAKE_MODEL.id, thinking: null });
    const store = app.store(project.id);
    const now = new Date().toISOString();
    const plan = store.sources.find((s) => s.anchor.kind === 'file')!;
    const owner = { author: { kind: 'owner' as const, name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' as const };
    const inputs = { jobId: 'x', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' };
    store.reference.put({ id: 'ref_search', projectId: project.id, category: 'Area', name: 'Search', ids: [], text: 'Search.', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: owner, sourceIds: [plan.id], refines: [], replacedBy: null, inputs: null, asOf: now, updatedAt: now });
    store.facts.put({ id: 'fact_plan', projectId: project.id, title: 'Facts from PLAN.md', aboutSourceIds: [plan.id], statements: [], decisions: [], changes: [], openQuestions: [], executionFacts: [], language: 'en', inputs, asOf: now, updatedAt: now, pendingSourceIds: [] });
    store.threads.put({ id: 'thread_t3', projectId: project.id, title: 'Tag browser', ids: ['T-3'], doing: 'Tag browsing', changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: ['fact_plan'], serves: [{ referenceId: 'ref_search', claim: 'finds notes', basis: 'Inferred' }], dependsOn: [], progress: 'On hold', validity: 'Current', replacedBy: null, attribution: owner, inputs, asOf: now, updatedAt: now, pendingSourceIds: [] });
    store.changes.put({ id: 'chg_dec2', projectId: project.id, at: now, atSource: 'material', material: 'Decision', effect: 'Replaced', title: 'DEC-2', summary: 'Search replaces the tag browser.', before: 'Tag browser', after: 'Search', sourceIds: [plan.id], by: owner, affects: ['ref_search'], propagation: [], segment: null, createdInJobId: null, updatedAt: now });
    store.judgements.put({ id: 'jdg_0', projectId: project.id, jobId: 'x', at: now, scope: { kind: 'project', ids: [], label: 'p' }, inputs: { referenceIds: [], threadIds: [], areaIds: [], relationIds: [], keyEvidenceSourceIds: [], conflictingSourceIds: [], previousNoteIds: [], investigations: [] }, excluded: [], outcome: { noteIds: ['note_tb'], assessments: [], reconsideredOnly: false } });
    store.notes.put({ id: 'note_tb', projectId: project.id, mount: { kind: 'node', ids: ['thread_t3'] }, status: 'Current', ownerResponse: null, versions: [{ version: 1, at: now, title: 'PLAN.md still lists the tag browser', preview: 'DEC-2 replaced it.', body: { currentView: 'The plan is on the old understanding.', whyItMatters: null, facts: [], otherExplanations: null, keepAdjust: null, whatWouldSettleIt: null }, ask: 'For your decision', judgementRecordId: 'jdg_0', reason: 'test' }], discussion: [], followUps: [], author: { agent: 'pi', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, language: 'en', updatedAt: now });

    // Propagation entries are derived for downstream work (thread serves the affected area).
    deriveGraph(store, project);
    let change = store.changes.get('chg_dec2')!;
    assert.ok(change.propagation.some((p) => p.nodeId === 'thread_t3' && p.state === 'Not yet checked'), 'downstream thread gets a propagation entry');
    store.changes.put({ ...change, propagation: change.propagation.map((p) => ({ ...p, state: 'Updated' as const, sourceOrReason: 'judged' })) });
    app.organizing.markPending(project.id, [{ kind: 'file', ref: plan.anchor.kind === 'file' ? plan.anchor.path : '', label: 'PLAN.md', since: now, lastEventAt: Date.now(), scopeItemId: app.project(project.id).scope[0]!.id }]);
    change = store.changes.get('chg_dec2')!;
    // Spec §2.10 resets a judgement when the object itself is modified; a changed material marks the work item Update
    // pending (§1.11) and the judgement stands until organizing brings the work item up to date (batch D2, AK P4).
    assert.ok(change.propagation.some((p) => p.nodeId === 'thread_t3' && p.state === 'Updated'), 'a material change leaves the judgement standing');
    assert.ok(store.threads.get('thread_t3')!.pendingSourceIds.includes(plan.id), 'and marks the work item Update pending');

    // Standing authorization from the owner's words; work under it is "Your request" with the authorization as basis.
    const a1 = app.conversation.send(project.id, { text: 'AUTH: when a document reference is stale, fix it directly', context: null, conversationId: null });
    const j1 = await app.keeper.waitFor(project.id, a1.jobId);
    assert.equal(j1.status, 'Done', j1.error ?? '');
    const auth = store.authorizations.all()[0];
    assert.ok(auth && !auth.revokedAt, 'authorization recorded');
    assert.ok(store.sources.has(auth!.sourceId), 'its source is the owner message');
    const a2 = app.conversation.send(project.id, { text: 'USE-AUTH: go ahead', context: null, conversationId: a1.conversationId });
    const j2 = await app.keeper.waitFor(project.id, a2.jobId);
    assert.equal(j2.kind, 'Your request', `${j2.status} ${j2.resultText} ${JSON.stringify(j2.steps)}`);
    assert.equal(j2.requestBasis?.kind, 'authorization');
    assert.equal(j2.requestBasis?.ref, auth!.id);
    for (let i = 0; i < 50 && !store.jobs.find((j) => j.kind === 'Product re-look'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(store.jobs.find((j) => j.kind === 'Product re-look'), 'a re-look follows the delegated adjustment');
    app.revokeAuthorization(project.id, auth!.id);
    assert.ok(store.authorizations.get(auth!.id)!.revokedAt, 'revoked');
  } finally { fake.close(); app.stopAll(); }
});
