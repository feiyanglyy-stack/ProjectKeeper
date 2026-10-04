/**
 * What an object's details say of how it follows the changes that reached it (graph-view.ts `propagationOf`; Spec §2.10,
 * §5.5, §6.4; QC AH #6): what it still lacks, item by item, each with the change it comes from — read the way the context
 * pack reads it, from the object's latest judgement — with its state, the round that judged it, the records that state
 * covers and the records that wait for the next Follow up. An invented project ("Tern", a tide-table app) in a store of
 * its own; nothing is served.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import type { ChangeItem, ChangeRecord, FollowUpRound, GraphNode, ObjectJudgement, Project, PropagationEntry, ReferenceItem, RoundResult, WorkThread } from '../model/types.ts';
import type { ClerkRound } from '../model/k-types.ts';
import { nodeDetail, propagationOf } from './graph-view.ts';

const P = 'tern';
const AT = '2026-09-20T10:00:00.000Z';
const JUDGED = '2026-09-21T10:00:00.000Z';
const LATER = '2026-09-22T10:00:00.000Z';
const project = { id: P, name: 'Tern', scopeQuestions: [], organizeRhythm: 'Daily' } as unknown as Project;
const store = () => ProjectStore.open(P, mkdtempSync(join(tmpdir(), 'pk-prop-view-')));
const attribution = { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' };

const thread = (s: ProjectStore, id: string, extra: Partial<WorkThread> = {}) =>
  s.threads.put({ id, projectId: P, title: id, ids: [], doing: id, changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution, inputs: { jobId: 'j', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: AT, updatedAt: AT, ...extra } as WorkThread);
const reference = (s: ProjectStore, id: string, category: string) =>
  s.reference.put({ id, projectId: P, category, name: id, ids: [], text: id, quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT } as unknown as ReferenceItem);
const item = (id: string, title: string, effect: string, at: string, affects: string[] = ['ref_tables']): ChangeItem =>
  ({ id, at, atSource: 'material', material: 'Decision', effect, title, summary: title, before: null, after: null, sourceIds: [], by: attribution, why: null, affects } as unknown as ChangeItem);
/** A piece of work with its items; `work: null` is a record written before pieces of work, which reads as one item. */
const change = (s: ProjectStore, id: string, title: string, at: string, items: ChangeItem[] | null, propagation: PropagationEntry[] = [], work: string | null = 'claude session s-7') =>
  s.changes.put({
    id, projectId: P, at, atSource: 'material', material: 'Decision', effect: items ? items[0]!.effect : 'Deferred', title, summary: title, before: null, after: null, sourceIds: [], by: attribution,
    affects: ['ref_tables'], propagation, segment: null, createdInJobId: null, updatedAt: at,
    ...(work ? { work: { kind: 'Session', label: work, sessionId: 's-7', startedAt: at, endedAt: at, openEnded: false } } : {}), ...(items ? { items } : {}),
  } as unknown as ChangeRecord);
const judge = (s: ProjectStore, nodeId: string, roundId: string, over: Partial<ObjectJudgement>) =>
  s.propagation.put({ id: `${roundId}:${nodeId}`, projectId: P, nodeId, roundId, state: 'Updated', sourceOrReason: '', covers: [], followed: [], lacks: [], closed: [], objectUpdatedAt: AT, jobId: null, at: JUDGED, ...over } as ObjectJudgement);
const counts = { objectsJudged: 3, byState: {}, behind: 0, itemsLacked: 0, notJudged: 0, requests: 0, notes: 0, decisionsReplaced: 0, decisionsSuspected: 0 };
const result = (at: string, over: Partial<RoundResult> = {}): RoundResult => ({ at, summary: 'the round', counts, behind: [], byHolder: [], noteIds: [], unassigned: [], ...over });
const record = (s: ProjectStore, id: string, number: number, endedAt: string | null, over: Partial<FollowUpRound> = {}) =>
  s.rounds.put({ id, projectId: P, number, startedAt: endedAt ?? LATER, endedAt, mainJobId: null, result: endedAt ? result(endedAt) : null, seenAt: null, ...over } as FollowUpRound);
const clerk = (s: ProjectStore, id: string, number: number, followUpRoundId: string) =>
  s.clerkRounds.put({ id, projectId: P, kind: 'Follow up', number, startedAt: AT, endedAt: AT, status: 'Done', rootJobId: `job_${id}`, questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId, updatedAt: AT } as ClerkRound);

// ───────────────────────── what an object still lacks (§2.10, §5.5, §6.4; QC AH #6) ─────────────────────────

test('an object’s details list what it still lacks, item by item, each with the change it comes from; its latest round decides, by number', () => {
  const s = store();
  thread(s, 'thr_tables');
  change(s, 'chg_dec', 'DEC-4: tides come from the harbour feed', AT, [item('item_a', 'Tide tables read from the feed', 'Replaced', AT), item('item_b', 'Feed cached for a day', 'Added', AT)]);
  change(s, 'chg_units', 'Metres everywhere', AT, [item('item_c', 'Heights in metres', 'Corrected', AT)]);
  change(s, 'chg_v1', 'v1 almanac withdrawn', AT, null, [], null);
  // Round 9999 still found the almanac lacking; round 10000 — later by number, earlier as a string — judged again what
  // reached the object with what it still lacked, and left one item. Only its judgement is the object's state now.
  judge(s, 'thr_tables', 'round_9999', { state: 'Still on old understanding', covers: [{ changeId: 'chg_v1', itemId: '' }], lacks: [{ changeId: 'chg_v1', itemId: '', what: 'still reads the almanac' }] });
  judge(s, 'thr_tables', 'round_10000', {
    state: 'Still on old understanding', sourceOrReason: 'the tables still load the bundled file',
    covers: [{ changeId: 'chg_dec', itemId: 'item_a' }, { changeId: 'chg_dec', itemId: 'item_b' }, { changeId: 'chg_units', itemId: 'item_c' }, { changeId: 'chg_v1', itemId: '' }],
    followed: [{ changeId: 'chg_dec', itemId: 'item_b' }, { changeId: 'chg_units', itemId: 'item_c' }],
    closed: [{ changeId: 'chg_v1', itemId: '', close: 'No action needed', reason: 'the owner dropped it' }],
    lacks: [{ changeId: 'chg_dec', itemId: 'item_a', what: 'load the tables from the harbour feed' }],
  } as Partial<ObjectJudgement>);
  record(s, 'round_10000', 10000, LATER);
  clerk(s, 'crd_12', 12, 'round_10000');
  const pv = propagationOf(s, 'thr_tables')!;
  assert.equal(pv.state, 'Still on old understanding');
  assert.deepEqual(pv.round, { id: 'round_10000', name: 'Follow up round 12', ended: true }, 'named as the workbench names the round: its clerk round’s number');
  assert.deepEqual([pv.at, pv.reason, pv.movedSince], [JUDGED, 'the tables still load the bundled file', false]);
  assert.deepEqual(pv.lacks, [{
    changeId: 'chg_dec', itemId: 'item_a', what: 'load the tables from the harbour feed',
    change: { id: 'chg_dec', title: 'DEC-4: tides come from the harbour feed', work: 'claude session s-7', effect: 'Replaced', at: AT },
    item: { title: 'Tide tables read from the feed', effect: 'Replaced', at: AT },
  }], 'the almanac round 9999 found lacking is no longer lacked: round 10000 closed it');
  assert.deepEqual(pv.covers.map((c) => [c.change.id, c.items, c.state]), [['chg_dec', 2, 'Still on old understanding'], ['chg_units', 1, 'Updated'], ['chg_v1', 1, 'Updated']],
    'each record it covers, with how many items, and where the object stands on it — as the record’s own entry says');
  assert.deepEqual(pv.waiting, []);
});

test('an object that changed after it was judged says the next Follow up judges it again; a round still running has no result to open yet', () => {
  const s = store();
  thread(s, 'thr_tables', { updatedAt: LATER });
  change(s, 'chg_dec', 'DEC-4', AT, [item('item_a', 'Tide tables read from the feed', 'Replaced', AT)]);
  judge(s, 'thr_tables', 'round_0003', { state: 'Still on old understanding', objectUpdatedAt: AT, covers: [{ changeId: 'chg_dec', itemId: 'item_a' }], lacks: [{ changeId: 'chg_dec', itemId: 'item_a', what: 'load the feed' }] });
  record(s, 'round_0003', 3, null);
  const pv = propagationOf(s, 'thr_tables')!;
  assert.equal(pv.movedSince, true, 'the work item was modified after its judgement');
  assert.equal(pv.lacks.length, 1, 'what it lacked stays on it until a round judges it again (§2.10)');
  assert.deepEqual(pv.round, { id: 'round_0003', name: 'Follow up round 3', ended: false }, 'a record with no clerk round keeps its own number');
});

test('what reached the object after its judgement waits for the next Follow up; what the judgement covered does not', () => {
  const s = store();
  thread(s, 'thr_tables');
  // An entry the round's judgement wrote, an entry reset when a new item arrived (graph.ts seedPropagation), and a
  // record that reached it after the round: only what the judgement did not cover waits.
  change(s, 'chg_dec', 'DEC-4', AT, [item('item_a', 'a', 'Replaced', AT)], [{ nodeId: 'thr_tables', state: 'Updated', sourceOrReason: 'follows the feed', updatedAt: JUDGED, roundId: 'round_0004', itemIds: ['item_a'] }]);
  change(s, 'chg_units', 'Metres', AT, [item('item_c', 'c', 'Corrected', AT), item('item_d', 'd', 'Corrected', LATER)], [{ nodeId: 'thr_tables', state: 'Not yet checked', sourceOrReason: '', updatedAt: LATER, itemIds: ['item_c', 'item_d'] }]);
  change(s, 'chg_moon', 'Moon phases shown', LATER, [item('item_m', 'm', 'Added', LATER)], [{ nodeId: 'thr_tables', state: 'Not yet checked', sourceOrReason: '', updatedAt: LATER, itemIds: ['item_m'] }]);
  change(s, 'chg_font', 'Font', AT, [item('item_f', 'f', 'Corrected', AT)], [{ nodeId: 'thr_tables', state: 'Not yet checked', sourceOrReason: '', updatedAt: JUDGED, itemIds: ['item_f'] }]);
  judge(s, 'thr_tables', 'round_0004', { state: 'Updated', covers: [{ changeId: 'chg_dec', itemId: 'item_a' }, { changeId: 'chg_units', itemId: 'item_c' }, { changeId: 'chg_font', itemId: 'item_f' }], followed: [{ changeId: 'chg_dec', itemId: 'item_a' }, { changeId: 'chg_units', itemId: 'item_c' }] });
  const pv = propagationOf(s, 'thr_tables')!;
  assert.equal(pv.state, 'Updated');
  assert.deepEqual(pv.lacks, []);
  assert.deepEqual(pv.waiting.map((c) => c.id), ['chg_units', 'chg_moon'], 'a new item of a record it had followed, and a record new since; not the one the judgement covered');
});

test('an object no round has judged shows what the per-change entries say: a record it has not followed is what it lacks', () => {
  const s = store();
  for (const id of ['thr_spike', 'thr_new', 'thr_settled']) thread(s, id);
  change(s, 'chg_v1', 'Sync moved out of v1', AT, null, [
    { nodeId: 'thr_spike', state: 'Still on old understanding', sourceOrReason: 'the spike still describes v1 scope', updatedAt: AT },
    { nodeId: 'thr_settled', state: 'Updated', sourceOrReason: 'rewritten', updatedAt: AT },
  ], null);
  change(s, 'chg_moon', 'Moon phases shown', LATER, [item('item_m', 'm', 'Added', LATER)], [
    { nodeId: 'thr_new', state: 'Not yet checked', sourceOrReason: '', updatedAt: LATER, itemIds: ['item_m'] },
    { nodeId: 'thr_settled', state: 'Reusable as is', sourceOrReason: 'moon phases do not touch it', updatedAt: LATER, itemIds: ['item_m'] },
  ]);
  const spike = propagationOf(s, 'thr_spike')!;
  assert.deepEqual([spike.state, spike.round, spike.at], ['Still on old understanding', null, AT]);
  assert.deepEqual(spike.lacks.map((l) => [l.changeId, l.itemId, l.what, l.item, l.change?.title]), [['chg_v1', '', 'the spike still describes v1 scope', null, 'Sync moved out of v1']], 'the whole record, in the entry’s words');
  assert.deepEqual(spike.covers.map((c) => [c.change.id, c.items, c.state, c.reason]), [['chg_v1', 1, 'Still on old understanding', 'the spike still describes v1 scope']]);
  const fresh = propagationOf(s, 'thr_new')!;
  assert.deepEqual([fresh.state, fresh.at, fresh.lacks, fresh.covers, fresh.waiting.map((c) => c.id)], ['Not yet checked', null, [], [], ['chg_moon']], 'reached, not judged: it waits for the next Follow up');
  const settled = propagationOf(s, 'thr_settled')!;
  assert.deepEqual([settled.state, settled.lacks.length, settled.waiting.length], ['Reusable as is', 0, 0], 'the latest entry’s state');
});

test('what is never judged has no propagation in its details, and neither has an object nothing reached; a lacked item whose record is gone still shows', () => {
  const s = store();
  reference(s, 'ref_dec', 'Decision');
  thread(s, 'thr_done', { progress: 'Done' });
  thread(s, 'thr_quiet');
  thread(s, 'thr_tables');
  change(s, 'chg_dec', 'DEC-4', AT, [item('item_a', 'a', 'Replaced', AT)], [{ nodeId: 'ref_dec', state: 'Not yet checked', sourceOrReason: '', updatedAt: AT }]);
  judge(s, 'thr_done', 'round_0001', { state: 'Still on old understanding', lacks: [{ changeId: 'chg_dec', itemId: 'item_a', what: 'x' }] });
  judge(s, 'thr_tables', 'round_0001', { state: 'Still on old understanding', lacks: [{ changeId: 'chg_gone', itemId: 'item_z', what: 'follow the old unit change' }] });
  assert.equal(propagationOf(s, 'ref_dec'), null, 'a decision is checked for what replaced it instead (§5.5)');
  assert.equal(propagationOf(s, 'thr_done'), null, 'a Done work item records how things stood; an earlier judgement of it is not its state now (§2.10)');
  assert.equal(propagationOf(s, 'thr_quiet'), null);
  assert.deepEqual(propagationOf(s, 'thr_tables')!.lacks, [{ changeId: 'chg_gone', itemId: 'item_z', what: 'follow the old unit change', change: null, item: null }]);
});

test('the object details carry it', () => {
  const s = store();
  thread(s, 'thr_tables');
  s.nodes.put({ id: 'thr_tables', projectId: P, category: 'Work item', label: 'T-4 Tide tables', refKind: 'thread', refId: 'thr_tables', validity: 'Current', progress: 'In progress', basis: 'Explicit', attribution: null, sourceIds: [], areaId: null, parentWorkId: null, replacedBy: null, updatedAt: AT } as unknown as GraphNode);
  change(s, 'chg_dec', 'DEC-4', AT, [item('item_a', 'a', 'Replaced', AT)]);
  judge(s, 'thr_tables', 'round_0002', { state: 'Still on old understanding', covers: [{ changeId: 'chg_dec', itemId: 'item_a' }], lacks: [{ changeId: 'chg_dec', itemId: 'item_a', what: 'load the feed' }] });
  const d = nodeDetail(s, project, 'thr_tables')!;
  assert.deepEqual(d.propagation, propagationOf(s, 'thr_tables'));
  assert.equal(d.propagation?.lacks[0]?.what, 'load the feed');
});
