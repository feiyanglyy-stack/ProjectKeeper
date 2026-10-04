/**
 * What a propagation entry shows is what the rounds will do with it (batch D2; independent review AK, P4; Spec §2.10,
 * §5.5; CKC-11 AC-12, AC-18, AC-26).
 *
 * When organized material changed, `markPending` used to reset every entry of the work items built on it to
 * `Not yet checked` and refresh its time. Nothing judged it after that: an item with a conclusion is not judged again
 * (§2.10), and the refreshed time made the entry read as answered. The change's detail showed an object nobody would
 * ever judge. The Spec ties the reset to the object being modified, not to its material changing: a changed material
 * marks the work item `Update pending` (§1.11), and once organizing brings the work item up to date, the next round
 * judges what it still lacks, while what already has a conclusion keeps it.
 *
 * The same refreshed time hid an item that reached an already-judged object later: the seeding merged it into the
 * entry, and the entry read as answered, so the new item was never asked about.
 *
 * The fixtures are an invented project, "Kestrel", a field-notes app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangeItem, ChangeRecord, GraphRelation, Project, ReferenceItem, WorkThread } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-pi-agent-'));
const { App } = await import('../../server/app.ts');
const { ProjectStore: Store } = await import('../../store/project-store.ts');
const { judgeObject, startRound } = await import('../adjustment.ts');
const { keeperTools } = await import('../tools.ts');
const { deriveGraph } = await import('./graph.ts');
const { pendingByArea, pendingCount } = await import('./follow-up.ts');

const T0 = '2024-03-01T00:00:00.000Z';        // the work item and the change
const ROUND1 = '2024-03-02T00:00:00.000Z';    // the first round starts
const JUDGED = '2024-03-02T01:00:00.000Z';    // and judges the work item
const ENDED = '2024-03-02T02:00:00.000Z';     // and ends
const attribution = { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' } as const;
const item = (id: string): ChangeItem => ({ id, at: T0, atSource: null, material: 'Decision', effect: 'Replaced', title: `R-2 ${id}`, summary: 'R-2 now syncs on Wi-Fi only', before: 'any network', after: 'Wi-Fi only', sourceIds: [], by: null, why: null, affects: ['ref_sync'] } as unknown as ChangeItem);

const batched = (store: ProjectStore) => new Set(pendingByArea(store).flatMap((b) => b.entries.map((e) => e.nodeId)));
/** Entries shown as `Not yet checked` that no round would take: what the change's detail must never show. */
const nobodyJudges = (store: ProjectStore) => {
  const taken = batched(store);
  return store.changes.all().flatMap((c) => c.propagation.filter((p) => p.state === 'Not yet checked' && !taken.has(p.nodeId)).map((p) => `${c.id}>${p.nodeId}`));
};

/** A project whose status file a work item was built from, a requirement that changed, and the first round's judgement. */
async function judgedOnce(state: 'Updated' | 'Still on old understanding') {
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'pk-kestrel-'));
  writeFileSync(join(dir, 'STATUS.md'), '# Status\n\n- W-4 sync queue: in progress\n');
  const app = new App(home, { organizing: false });
  const project = app.addProject('Kestrel', [dir]);
  await app.intakeProject(project.id);
  app.stopAll();
  const store = app.store(project.id);
  const status = store.sources.find((s) => s.anchor.kind === 'file' && s.anchor.path.endsWith('STATUS.md'))!;
  assert.ok(status, 'the status file was read');
  const inputs = { jobId: 'j', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' };
  store.reference.put({ id: 'ref_sync', projectId: project.id, category: 'Requirement', name: 'R-2 offline sync', ids: ['R-2'], text: 'Notes sync when the phone is back online.', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution, sourceIds: [status.id], refines: [], replacedBy: null, inputs: null, asOf: T0, updatedAt: T0 } as unknown as ReferenceItem);
  store.facts.put({ id: 'fact_status', projectId: project.id, title: 'Facts from STATUS.md', aboutSourceIds: [status.id], statements: [], decisions: [], changes: [], openQuestions: [], executionFacts: [], language: 'en', inputs, asOf: T0, updatedAt: T0, pendingSourceIds: [] });
  store.threads.put({ id: 'thread_sync', projectId: project.id, title: 'W-4 sync queue', ids: ['W-4'], doing: 'A queue that replays edits made offline.', changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: ['fact_status'], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution, inputs, asOf: T0, updatedAt: T0, pendingSourceIds: [], doneMeans: '', acceptanceMeans: '', acceptance: '' } as unknown as WorkThread);
  store.changes.put({
    id: 'chg_sync', projectId: project.id, at: T0, atSource: 'material', material: 'Decision', effect: 'Replaced', title: 'R-2 syncs on Wi-Fi only', summary: '', before: null, after: null, sourceIds: [status.id], by: null,
    affects: ['ref_sync'], items: [item('i1')], propagation: [{ nodeId: 'thread_sync', state: 'Not yet checked', sourceOrReason: '', updatedAt: T0, itemIds: ['i1'] }], notJudged: [], segment: null, createdInJobId: null, updatedAt: T0,
  } as unknown as ChangeRecord);
  const round = startRound(store, project.id, 'job_round_1', ROUND1);
  judgeObject(store, project.id, round.id, state === 'Updated'
    ? { nodeId: 'thread_sync', state, sourceOrReason: 'the queue already waits for Wi-Fi', followed: [{ changeId: 'chg_sync', itemId: 'i1' }] }
    : { nodeId: 'thread_sync', state, sourceOrReason: 'the queue replays on any network', lacks: [{ changeId: 'chg_sync', itemId: 'i1', what: 'still replays on any network, not Wi-Fi only' }] }, JUDGED);
  store.rounds.put({ ...store.rounds.get(round.id)!, endedAt: ENDED });
  const materialChanged = () => app.organizing.markPending(project.id, [{ kind: 'file', ref: status.anchor.kind === 'file' ? status.anchor.path : '', label: 'STATUS.md', since: new Date().toISOString(), lastEventAt: Date.now(), scopeItemId: app.project(project.id).scope[0]!.id }]);
  // Organizing brings the work item up to date from the changed material, with the tool a round's main job uses.
  const workItemUpdated = async () => {
    const tool = keeperTools({ store, project: app.project(project.id), jobId: 'job_round_2', jobKind: 'Organizing', model: null }).find((t) => t.name === 'pk_write_thread')!;
    const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    const r = await run('call', { id: 'thread_sync', title: 'W-4 sync queue', progress: 'In progress', doing: 'A queue that replays offline edits once the phone is on Wi-Fi.', factRecordIds: ['fact_status'] });
    assert.notEqual(r.isError, true, r.content.map((c) => c.text).join('\n'));
  };
  const entry = () => store.changes.get('chg_sync')!.propagation.find((p) => p.nodeId === 'thread_sync')!;
  return { app, store, project, status, materialChanged, workItemUpdated, entry };
}

test('a work item that still lacked an item: its material changes, it is brought up to date, and the next round judges it — no Not yet checked left for nobody', async () => {
  const f = await judgedOnce('Still on old understanding');
  try {
    f.materialChanged();
    assert.ok(f.store.threads.get('thread_sync')!.pendingSourceIds.includes(f.status.id), 'the work item shows Update pending for the changed material');
    assert.equal(f.entry().state, 'Still on old understanding', 'the judgement stands until the work item itself is modified');
    assert.deepEqual(nobodyJudges(f.store), [], 'nothing is shown as Not yet checked that no round would take');
    assert.ok(!batched(f.store).has('thread_sync'), 'while only its material changed, the work item waits for organizing to bring it up to date');

    await f.workItemUpdated();
    startRound(f.store, f.project.id, 'job_round_2');
    assert.ok(batched(f.store).has('thread_sync'), 'the next round judges what the modified work item still lacked');
    assert.deepEqual(nobodyJudges(f.store), []);
  } finally { f.app.stopAll(); }
});

test('a work item whose item has a conclusion keeps it: its material changes, it is brought up to date, and nothing shows it as not judged (Spec §2.10)', async () => {
  const f = await judgedOnce('Updated');
  try {
    f.materialChanged();
    assert.ok(f.store.threads.get('thread_sync')!.pendingSourceIds.includes(f.status.id), 'the work item shows Update pending for the changed material');
    assert.equal(f.entry().state, 'Updated', 'the conclusion is not reset because the material changed');
    assert.deepEqual(nobodyJudges(f.store), [], 'nothing is shown as Not yet checked that no round would take');

    await f.workItemUpdated();
    startRound(f.store, f.project.id, 'job_round_2');
    assert.ok(!batched(f.store).has('thread_sync'), 'a concluded item is not judged again because the object was modified');
    assert.equal(f.entry().state, 'Updated', 'the entry carries the conclusion');
    assert.equal(pendingCount(f.store).entries, 0, 'and nothing counts it as pending');
    assert.deepEqual(nobodyJudges(f.store), []);
  } finally { f.app.stopAll(); }
});

test('an item that reaches an already-judged object later is asked about in the next round', () => {
  const store = Store.open('p1', mkdtempSync(join(tmpdir(), 'pk-kestrel-merge-')));
  const project = { id: 'p1', name: 'Kestrel', language: 'en', locations: ['D:\\kestrel'], scope: [], roles: [] } as unknown as Project;
  store.reference.put({ id: 'ref_sync', projectId: 'p1', category: 'Requirement', name: 'R-2 offline sync', ids: [], text: 'R-2', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: T0, updatedAt: T0 } as unknown as ReferenceItem);
  store.threads.put({ id: 'thread_sync', projectId: 'p1', title: 'W-4 sync queue', ids: [], doing: 'W-4', changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution, inputs: { jobId: 'j', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: T0, updatedAt: T0, pendingSourceIds: [] } as unknown as WorkThread);
  store.relations.put({ id: 'rel_w4_r2', projectId: 'p1', type: 'depends on', from: 'thread_sync', to: 'ref_sync', claim: '', basis: 'Explicit', evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: T0 } as GraphRelation);
  store.changes.put({ id: 'chg_sync', projectId: 'p1', at: T0, effect: 'Replaced', title: 'R-2 reworked', summary: '', before: null, after: null, sourceIds: [], affects: ['ref_sync'], propagation: [], items: [item('i1')], updatedAt: T0 } as unknown as ChangeRecord);
  deriveGraph(store, project);
  const round = startRound(store, 'p1', 'job_round_1', ROUND1);
  judgeObject(store, 'p1', round.id, { nodeId: 'thread_sync', state: 'Updated', sourceOrReason: 'follows R-2', followed: [{ changeId: 'chg_sync', itemId: 'i1' }] }, JUDGED);
  store.rounds.put({ ...store.rounds.get(round.id)!, endedAt: ENDED });
  assert.ok(!batched(store).has('thread_sync'), 'judged, and nothing new has reached it');

  // The same piece of work turns out to have a second net change on the same requirement; the seeding merges the
  // item that reached the work item into its entry.
  const change = store.changes.get('chg_sync')!;
  store.changes.put({ ...change, items: [...(change.items ?? []), item('i2')] });
  deriveGraph(store, project);
  assert.deepEqual(store.changes.get('chg_sync')!.propagation.find((p) => p.nodeId === 'thread_sync')!.itemIds, ['i1', 'i2'], 'the new item reached the work item');
  assert.ok(batched(store).has('thread_sync'), 'the next round asks about the item that arrived after the judgement');
});

/**
 * What an entry shows while an item in it waits for its first judgement (batch D4; Spec §2.10, §5.5). The seeding
 * merged a later item into an entry that already had a conclusion and kept that conclusion, so until the next round
 * judged the item the change's detail and the counts showed the old conclusion as if it covered the new item too.
 */
function judgedThenReached(judged: { state: 'Updated' | 'Still on old understanding'; sourceOrReason: string; followed?: { changeId: string; itemId: string }[]; lacks?: { changeId: string; itemId: string; what: string }[] }) {
  const store = Store.open('p1', mkdtempSync(join(tmpdir(), 'pk-kestrel-reached-')));
  const project = { id: 'p1', name: 'Kestrel', language: 'en', locations: ['D:\\kestrel'], scope: [], roles: [] } as unknown as Project;
  store.reference.put({ id: 'ref_sync', projectId: 'p1', category: 'Requirement', name: 'R-2 offline sync', ids: [], text: 'R-2', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: T0, updatedAt: T0 } as unknown as ReferenceItem);
  store.threads.put({ id: 'thread_sync', projectId: 'p1', title: 'W-4 sync queue', ids: [], doing: 'W-4', changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution, inputs: { jobId: 'j', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: T0, updatedAt: T0, pendingSourceIds: [] } as unknown as WorkThread);
  store.relations.put({ id: 'rel_w4_r2', projectId: 'p1', type: 'depends on', from: 'thread_sync', to: 'ref_sync', claim: '', basis: 'Explicit', evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: T0 } as GraphRelation);
  store.changes.put({ id: 'chg_sync', projectId: 'p1', at: T0, effect: 'Replaced', title: 'R-2 reworked', summary: '', before: null, after: null, sourceIds: [], affects: ['ref_sync'], propagation: [], items: [item('i1')], updatedAt: T0 } as unknown as ChangeRecord);
  deriveGraph(store, project);
  const round = startRound(store, 'p1', 'job_round_1', ROUND1);
  judgeObject(store, 'p1', round.id, { nodeId: 'thread_sync', ...judged }, JUDGED);
  store.rounds.put({ ...store.rounds.get(round.id)!, endedAt: ENDED });
  const entry = () => store.changes.get('chg_sync')!.propagation.find((p) => p.nodeId === 'thread_sync')!;
  const reached = () => {
    const change = store.changes.get('chg_sync')!;
    store.changes.put({ ...change, items: [...(change.items ?? []), item('i2')] });
    deriveGraph(store, project);
  };
  return { store, project, entry, reached };
}

test('an entry that a new item reaches after its judgement shows as not yet checked, is counted as waiting, and the next round takes it', () => {
  const f = judgedThenReached({ state: 'Updated', sourceOrReason: 'W-4 already replays on Wi-Fi only', followed: [{ changeId: 'chg_sync', itemId: 'i1' }] });
  deriveGraph(f.store, f.project);
  assert.equal(f.entry().state, 'Updated', 'derived again with nothing new, the conclusion stands');
  assert.equal(pendingCount(f.store).entries, 0);

  f.reached();
  assert.deepEqual(f.entry().itemIds, ['i1', 'i2'], 'the second item reached the work item');
  assert.equal(f.entry().state, 'Not yet checked', 'the conclusion about the first item is not shown as covering the second');
  assert.equal(f.entry().sourceOrReason, '', 'nor is the reason given for that conclusion');
  assert.equal(pendingCount(f.store).entries, 1, 'the count of what waits for a judgement includes it');
  assert.deepEqual(nobodyJudges(f.store), [], 'and a round will take it');
  deriveGraph(f.store, f.project);
  assert.equal(f.entry().state, 'Not yet checked', 'deriving again changes nothing');

  const round2 = startRound(f.store, 'p1', 'job_round_2');
  assert.ok(batched(f.store).has('thread_sync'), 'the next round’s batch has it');
  judgeObject(f.store, 'p1', round2.id, { nodeId: 'thread_sync', state: 'Updated', sourceOrReason: 'the second change is followed too', followed: [{ changeId: 'chg_sync', itemId: 'i2' }] });
  assert.equal(f.entry().state, 'Updated', 'once judged, the entry shows that round’s conclusion');
  assert.equal(f.entry().roundId, round2.id);
  assert.equal(pendingCount(f.store).entries, 0);
});

test('an object still behind that a new item reaches keeps what it lacks, and the next round judges both together', () => {
  const f = judgedThenReached({ state: 'Still on old understanding', sourceOrReason: 'W-4 replays on any network', lacks: [{ changeId: 'chg_sync', itemId: 'i1', what: 'still replays on any network, not Wi-Fi only' }] });
  f.reached();
  assert.equal(f.entry().state, 'Not yet checked', 'the entry waits for the round that judges the new item');
  assert.deepEqual(f.store.propagation.get('round_0001:thread_sync')!.lacks.map((l) => l.itemId), ['i1'], 'what the object lacked stays in its judgement');

  const round2 = startRound(f.store, 'p1', 'job_round_2');
  assert.ok(batched(f.store).has('thread_sync'), 'the next round’s batch has it');
  const judged = judgeObject(f.store, 'p1', round2.id, { nodeId: 'thread_sync', state: 'Updated', sourceOrReason: 'the second change is followed', followed: [{ changeId: 'chg_sync', itemId: 'i2' }] });
  assert.deepEqual(judged.lacks.map((l) => l.itemId), ['i1'], 'the lack it already had is judged with the new item, not dropped');
  assert.equal(f.entry().state, 'Still on old understanding', 'and the entry shows it again');
});
