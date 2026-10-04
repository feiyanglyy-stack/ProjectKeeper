/**
 * What a round judges again on an object (Spec v2.8 §2.10, §5.5; CKC-11 AC-12): the items that reached it this round
 * and the items on it that have no conclusion yet. An item that already has a conclusion — the object followed it, a
 * later change superseded it, the owner or holder said it need not be handled — is not judged again because the
 * object was modified, and never by walking the object's whole history.
 *
 * Before this, touching an object put every item that had ever reached it back in front of the next round (the
 * re-judging grew with the project's history), and an item settled two rounds ago came back as soon as the object
 * had been judged once more in between, because only the latest judgement's items counted as settled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { itemsForObject, judgeObject, startRound } from './adjustment.ts';
import { deriveGraph } from './organize/graph.ts';
import { objectPending, pendingByArea } from './organize/follow-up.ts';
import type { ChangeItem, ChangeRecord, GraphRelation, Project, ReferenceItem, WorkThread } from '../model/types.ts';

const T1 = '2026-09-18T00:00:00.000Z';
const T2 = '2026-09-19T00:00:00.000Z';
const T3 = '2026-09-20T00:00:00.000Z';
const T4 = '2026-09-21T00:00:00.000Z';

const project = { id: 'p1', name: 'P', language: 'en', locations: ['D:\\p'], scope: [], roles: [] } as unknown as Project;
const attribution = { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' } as const;

function store(): ProjectStore {
  const s = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-rejudge-')));
  s.reference.put({ id: 'ref_a', projectId: 'p1', category: 'Requirement', name: 'R-1', ids: [], text: 'R-1', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: T1, updatedAt: T1 } as unknown as ReferenceItem);
  touch(s, T1);
  s.relations.put({ id: 'rel_w_a', projectId: 'p1', type: 'depends on', from: 'thread_w', to: 'ref_a', claim: '', basis: 'Explicit', evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: T1 } as GraphRelation);
  return s;
}
/** The work item downstream of R-1, as last written at `at`. */
function touch(s: ProjectStore, at: string) {
  s.threads.put({ id: 'thread_w', projectId: 'p1', title: 'W-1', ids: [], doing: `written ${at}`, changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution, inputs: { jobId: 'j', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: at, updatedAt: at } as unknown as WorkThread);
}
const item = (id: string, at: string): ChangeItem => ({ id, at, atSource: 'material', material: 'Decision', effect: 'Replaced', title: id, summary: `${id} happened`, before: `before ${id}`, after: `after ${id}`, sourceIds: [], by: null, why: null, affects: ['ref_a'] } as unknown as ChangeItem);
function change(s: ProjectStore, id: string, items: ChangeItem[], at: string) {
  s.changes.put({ id, projectId: 'p1', at, effect: 'Replaced', title: id, summary: '', before: null, after: null, sourceIds: [], affects: ['ref_a'], propagation: [], items, updatedAt: at } as unknown as ChangeRecord);
  deriveGraph(s, project);
}
const closeRound = (s: ProjectStore, id: string, at: string) => s.rounds.put({ ...s.rounds.get(id)!, endedAt: at });
const coversOf = (s: ProjectStore, roundId: string) => itemsForObject(s, 'thread_w', roundId).covers.map((c) => `${c.changeId}/${c.itemId}`).sort();

test('an object that followed everything that reached it is not judged again because it was edited', () => {
  const s = store();
  change(s, 'chg_1', [item('i_1', T1)], T1);
  const one = startRound(s, 'p1', null, T1);
  judgeObject(s, 'p1', one.id, { nodeId: 'thread_w', state: 'Updated', sourceOrReason: 'it cites the new R-1' }, T1);
  closeRound(s, one.id, T1);

  touch(s, T2);   // the holder edits the work item; nothing new reached it
  const two = startRound(s, 'p1', null, T2);
  assert.deepEqual(coversOf(s, two.id), [], 'the one item it had already concluded on is not asked again');
  assert.equal(objectPending(s, 'thread_w'), false, 'so the object is not pending');
  assert.deepEqual(pendingByArea(s).flatMap((b) => b.objects.map((o) => o.nodeId)), [], 'and no round is handed it');
});

test('after an edit, only what the object still lacked comes back; what it followed does not', () => {
  const s = store();
  change(s, 'chg_1', [item('i_1', T1), item('i_2', T1)], T1);
  const one = startRound(s, 'p1', null, T1);
  judgeObject(s, 'p1', one.id, {
    nodeId: 'thread_w', state: 'Still on old understanding', sourceOrReason: 'it follows i_1, not i_2',
    followed: [{ changeId: 'chg_1', itemId: 'i_1' }], lacks: [{ changeId: 'chg_1', itemId: 'i_2', what: 'still the old i_2' }],
  }, T1);
  closeRound(s, one.id, T1);

  touch(s, T2);
  const two = startRound(s, 'p1', null, T2);
  assert.deepEqual(coversOf(s, two.id), ['chg_1/i_2'], 'the lacked item is judged again because the object moved; the followed one is not');
  assert.equal(objectPending(s, 'thread_w'), true);
  // A round that names the concluded item anyway cannot re-open it.
  const j = judgeObject(s, 'p1', two.id, {
    nodeId: 'thread_w', state: 'Updated', sourceOrReason: 'read again',
    followed: [{ changeId: 'chg_1', itemId: 'i_2' }], lacks: [{ changeId: 'chg_1', itemId: 'i_1', what: 'i_1 again' }],
  }, T2);
  assert.deepEqual(j.lacks, [], 'the item concluded in round 1 stays concluded; only i_2 was judged, and it is followed now');
  assert.deepEqual(j.covers.map((c) => c.itemId), ['i_2'], 'and the judgement covers only the item that was open');
  assert.equal(j.state, 'Updated');
});

test('an item settled two rounds ago does not come back when a third change arrives', () => {
  const s = store();
  change(s, 'chg_1', [item('i_1', T1)], T1);
  const one = startRound(s, 'p1', null, T1);
  judgeObject(s, 'p1', one.id, { nodeId: 'thread_w', state: 'Updated', sourceOrReason: 'follows i_1', followed: [{ changeId: 'chg_1', itemId: 'i_1' }] }, T1);
  closeRound(s, one.id, T1);

  change(s, 'chg_2', [item('i_2', T2)], T2);
  const two = startRound(s, 'p1', null, T2);
  assert.deepEqual(coversOf(s, two.id), ['chg_2/i_2'], 'round 2 judges only what arrived since');
  judgeObject(s, 'p1', two.id, { nodeId: 'thread_w', state: 'Updated', sourceOrReason: 'follows i_2', followed: [{ changeId: 'chg_2', itemId: 'i_2' }] }, T2);
  closeRound(s, two.id, T2);

  change(s, 'chg_3', [item('i_3', T3)], T3);
  const three = startRound(s, 'p1', null, T3);
  assert.deepEqual(coversOf(s, three.id), ['chg_3/i_3'], 'round 3 does not reach back to what round 1 settled');

  // And the object being edited as well changes nothing about what is already concluded.
  touch(s, T4);
  assert.deepEqual(coversOf(s, three.id), ['chg_3/i_3']);
});

// This one held before the fix as well: it is the guard that the fix did not go too far the other way — an item
// still lacked is not concluded, so it has to travel with whatever arrives next.
test('what arrived and what is still lacked are judged together; the rest of the history stays settled', () => {
  const s = store();
  change(s, 'chg_1', [item('i_1', T1), item('i_2', T1)], T1);
  const one = startRound(s, 'p1', null, T1);
  judgeObject(s, 'p1', one.id, {
    nodeId: 'thread_w', state: 'Still on old understanding', sourceOrReason: 'i_2 missing',
    followed: [{ changeId: 'chg_1', itemId: 'i_1' }], lacks: [{ changeId: 'chg_1', itemId: 'i_2', what: 'still the old i_2' }],
  }, T1);
  closeRound(s, one.id, T1);

  change(s, 'chg_2', [item('i_3', T2)], T2);
  const two = startRound(s, 'p1', null, T2);
  const { covers, carried } = itemsForObject(s, 'thread_w', two.id);
  assert.deepEqual(covers.map((c) => c.itemId), ['i_3'], 'the new item is what triggers the round');
  assert.deepEqual(carried.map((c) => c.itemId), ['i_2'], 'the lacked item comes with it');
  const j = judgeObject(s, 'p1', two.id, { nodeId: 'thread_w', state: 'Updated', sourceOrReason: 'follows i_3', followed: [{ changeId: 'chg_2', itemId: 'i_3' }] }, T2);
  assert.deepEqual(j.covers.map((c) => c.itemId).sort(), ['i_2', 'i_3'], 'the judgement covers the new item and the open one, not i_1');
  assert.deepEqual(j.lacks.map((l) => l.itemId), ['i_2'], 'and i_2 is still lacked until something ends it');
});
