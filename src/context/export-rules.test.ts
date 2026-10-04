/**
 * The export rules of D59 (Spec §7.1, §7.3, §7.4, §7.10; CKC-12 AC-3, AC-18, AC-21, AC-31–AC-33):
 * the start pack follows the graph and says what it holds, every explanation goes in whole, normal states are not
 * written, an anomaly is written only where it can be checked and on the row it belongs to, a work pack carries only
 * the project-wide entries that bear on it, and every option says how its pack differs from the default one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { assembleContext, contextOptions } from './assemble.ts';
import { judgeObject, startRound } from '../keeper/adjustment.ts';
import type { AreaUnderstanding, ChangeRecord, ContextRequest, EntryMark, GraphRelation, Note, Project, ReferenceItem, Source, WorkThread } from '../model/types.ts';

const at = '2026-09-18T00:00:00.000Z';
const project = { id: 'p1', name: 'Demo', roles: ['Worker'], scope: [], language: 'en', organizingPaused: false } as unknown as Project;
/** A plan explanation long enough that any cut would show: the old export cut reference text at 200 characters. */
const LONG_PLAN = `P1 delivers the first usable picture. ${'It is written out at length here so that a cut would be visible. '.repeat(8)}The milestone is done when the owner has read one pack end to end.`;

const ref = (id: string, category: string, name: string, over: Partial<ReferenceItem> = {}) =>
  ({ id, projectId: 'p1', category, name, ids: [], text: `${name} text`, quote: null, basis: 'Explicit', validity: 'Current', progress: null, sourceIds: ['src_doc'], refines: [], replacedBy: null, asOf: at, updatedAt: at, ...over }) as unknown as ReferenceItem;
const thread = (id: string, title: string, serves: string[], progress: string, over: Partial<WorkThread> = {}) =>
  ({ id, projectId: 'p1', title, ids: [], progress, validity: 'Current', doing: `DOING-${id}`, results: '', unresolved: '', changed: '', serves: serves.map((s) => ({ referenceId: s, claim: '', basis: 'Explicit' })), dependsOn: [], factRecordIds: [], pendingSourceIds: [], attribution: { holder: null, author: { kind: 'unknown', name: null } }, acceptance: null, executionFacts: [], qcFacts: [], asOf: at, updatedAt: at, ...over }) as unknown as WorkThread;

function demoStore(): ProjectStore {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-rules-')));
  store.sources.put({ id: 'src_doc', title: 'PLAN.md §1', anchor: { kind: 'file', path: 'D:\\demo\\PLAN.md', headingPath: ['§1'], lineStart: 1, lineEnd: 9 }, excerpt: 'x', version: { readAt: at, fingerprint: 'sha256:0' }, hasCredential: false } as unknown as Source);
  store.reference.put(ref('ref_product', 'Product', 'Demo, a workbench for whoever takes a project over'));
  store.reference.put(ref('ref_goal', 'Goal', 'G1 · Understand the project', { ids: ['G1'] }));
  store.reference.put(ref('ref_a', 'Area', 'A1 · First area', { ids: ['A1'], refines: ['ref_goal'] }));
  store.reference.put(ref('ref_b', 'Area', 'A2 · Second area', { ids: ['A2'], refines: ['ref_goal'] }));
  store.reference.put(ref('ref_plan1', 'Plan', 'P1 · First increment', { ids: ['P1'], text: LONG_PLAN, refines: ['ref_goal'] }));
  store.reference.put(ref('ref_plan2', 'Plan', 'P2 · Second increment', { ids: ['P2'], refines: ['ref_goal'] }));
  store.reference.put(ref('ref_ms', 'Plan', 'P1-M2 · Second milestone', { ids: ['P1-M2'], refines: ['ref_plan1'] }));
  store.threads.put(thread('thread_a', 'W-1 · Work in A1', ['ref_a', 'ref_plan1'], 'In progress', { ids: ['W-1'] }));
  store.threads.put(thread('thread_done', 'W-0 · Finished work', ['ref_a'], 'Done', { ids: ['W-0'] }));
  store.threads.put(thread('thread_b', 'W-2 · Work in A2', ['ref_b', 'ref_plan2'], 'Planned', { ids: ['W-2'], dependsOn: [{ threadId: 'thread_a', claim: 'needs the first increment', basis: 'Explicit' }] }));
  store.areas.put({ id: 'area_a', projectId: 'p1', referenceId: 'ref_a', effectNow: 'One pack is produced end to end.', gaps: 'Nothing checks it against the original yet.', contributions: [], asOf: at, updatedAt: at, pendingSourceIds: [] } as unknown as AreaUnderstanding);
  store.areas.put({ id: 'area_b', projectId: 'p1', referenceId: 'ref_b', effectNow: 'Nothing runs here yet.', gaps: 'The whole area is still to be built.', contributions: [], asOf: at, updatedAt: at, pendingSourceIds: [] } as unknown as AreaUnderstanding);
  store.relations.put({ id: 'rel_ok', projectId: 'p1', type: 'implements', from: 'src_doc', to: 'thread_a', claim: 'the plan names this work', basis: 'Explicit', evidence: { sourceIds: ['src_doc'], factRecordIds: [], factsSoFar: 'implemented' }, assessment: 'Holds', assessedAt: at, assessedInJobId: null, updatedAt: at } as GraphRelation);
  // A change that two objects have not followed: one of them is a `Done` work item, which is a point-in-time record.
  store.changes.put({
    id: 'chg_1', projectId: 'p1', at, atSource: 'material', material: 'Decision', effect: 'Replaced', title: 'D59 · normal states are not exported',
    summary: 'Only checked anomalies go into a pack; the normal states stay in the assets.', before: 'every state was written out', after: 'only checked anomalies',
    sourceIds: ['src_doc'], by: { author: { kind: 'owner', name: null }, holder: null, identity: 'Decision' }, affects: ['ref_a'],
    propagation: [
      { nodeId: 'thread_a', state: 'Still on old understanding', sourceOrReason: 'W-1 still writes out every state', updatedAt: at },
      { nodeId: 'thread_b', state: 'Still on old understanding', sourceOrReason: 'W-2 still asks for the old state list', updatedAt: at },
      { nodeId: 'thread_done', state: 'Still on old understanding', sourceOrReason: 'finished before the decision', updatedAt: at },
      { nodeId: 'ref_b', state: 'Updated', sourceOrReason: 'rewritten', updatedAt: at },
      { nodeId: 'ref_a', state: 'Reusable as is', sourceOrReason: '', updatedAt: at },
    ], segment: null, createdInJobId: null, updatedAt: at,
  } as unknown as ChangeRecord);
  const note = (id: string, title: string, mount: { kind: string; ids: string[] }, preview: string) =>
    ({ id, projectId: 'p1', mount, status: 'Current', ownerResponse: null, versions: [{ version: 1, at, title, preview, body: { facts: [] }, ask: 'For information', judgementRecordId: null, reason: 'first' }], discussion: [], followUps: [], author: { agent: 'pi', model: null }, language: 'en', updatedAt: at }) as unknown as Note;
  store.notes.put(note('note_wide', 'A note about the whole project', { kind: 'project', ids: [] }, 'It names nothing in particular.'));
  store.notes.put(note('note_here', 'A note that names W-1', { kind: 'project', ids: [] }, 'W-1 needs a benchmark before it can be called done.'));
  store.setCoverage({ ...store.coverage, scopes: [{ id: 'project', kind: 'project', label: 'Demo', coverage: 'Up to date', asOf: at, commit: null, pending: [], organizing: [], failed: [], lastRelookAt: null }] } as never);
  return store;
}

const startPack = (store: ProjectStore, over: Partial<ContextRequest> = {}) =>
  assembleContext(store, project, { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null, ...over } as ContextRequest, 'Idle').markdown;

test('the start pack tells the project’s story: purpose, plans in order, and every area’s understanding', () => {
  const md = startPack(demoStore());
  // `Purpose` says what the product is and who it is for, from the product overview as well as the goals.
  assert.match(md, /## Purpose\n- \*\*Demo, a workbench for whoever takes a project over\*\* · `ref_product`/);
  assert.match(md, /## Purpose[\s\S]*G1 · Understand the project/);
  // `Plan` walks the plans and milestones in the project's own order, with its milestones under it.
  const plan = md.slice(md.indexOf('## Plan'), md.indexOf('\n## ', md.indexOf('## Plan') + 5));
  assert.match(plan, /- \*\*P1 · First increment\*\* \(P1\) · `ref_plan1` · In progress · work: In progress 1/);
  assert.match(plan, /In progress here: W-1 · Work in A1 \(`thread_a`\)\./);
  assert.match(plan, /\n {2}- \*\*P1-M2 · Second milestone\*\* \(P1-M2\) · `ref_ms`/, 'a milestone sits under the plan it refines');
  assert.match(plan, /- \*\*P2 · Second increment\*\* \(P2\) · `ref_plan2` · Planned[\s\S]*Waits on: W-1 · Work in A1 \(`thread_a`, In progress\)\./, 'a later plan says what it waits on');
  assert.ok(plan.includes(LONG_PLAN.slice(0, 200)) && plan.includes('The milestone is done when the owner has read one pack end to end.'), 'a plan explanation goes in whole, not cut (AC-31)');
  assert.ok(plan.indexOf('P1 ·') < plan.indexOf('P2 ·'), 'plans are in the project’s own order');
  // Every area carries its area understanding, and an area whose work is not listed says how to reach it.
  assert.match(md, /- \*\*A1 · First area\*\*[^\n]*\n {2}Now: One pack is produced end to end\.\n {2}Still missing: Nothing checks it against the original yet\./);
  assert.match(md, /- \*\*A2 · Second area\*\*[^\n]*\n {2}Now: Nothing runs here yet\.\n {2}Still missing: The whole area is still to be built\.\n {2}Its work is not listed here; `pk get ref_b` gives this area's context with every work item in it\./);
  // Changes say what changed and why, whole, with their before and after.
  assert.match(md, /## Changes since last session[\s\S]*\*\*D59 · normal states are not exported\*\* \(`chg_1`\)[\s\S]*Only checked anomalies go into a pack[\s\S]*Before: every state was written out → after: only checked anomalies/);
});

test('normal states are not written, and an anomaly is written where it can be checked', () => {
  const store = demoStore();
  const md = startPack(store);
  for (const normal of ['Up to date', 'Updated', 'Reusable as is', 'Holds', 'Not assessed']) {
    assert.doesNotMatch(md, new RegExp(normal), `${normal} is a normal state and stays in the assets`);
  }
  // An object on the map carries what it has not followed on its own row, with what it lacks and its source.
  assert.match(md, /`thread_a` · In progress — Still on old understanding: has not followed “D59 · normal states are not exported” \(`chg_1`\) — W-1 still writes out every state \[\d\]/);
  // One that is not on the map is indexed in `Freshness`, the same way and never twice.
  const fresh = md.slice(md.indexOf('## Freshness'));
  assert.match(fresh, /- Still on old understanding: W-2 · Work in A2 \(`thread_b`\) has not followed “D59[^”]*” \(`chg_1`\) — W-2 still asks for the old state list \[\d\]/);
  assert.doesNotMatch(fresh, /thread_a/, 'what is on a map row is not repeated here');
  // A `Done` work item is a point-in-time record: it never appears as not having followed a later change (AC-32).
  assert.doesNotMatch(md, /thread_done — |finished before the decision/, 'a point-in-time record is not shown as behind');
  // However many changes an object is behind, its row says so once and then names them all: a work item behind
  // twenty change records used to repeat the whole opening twenty times.
  store.changes.put({ ...store.changes.get('chg_1')!, id: 'chg_2', title: 'A second decision it has not followed', propagation: [{ nodeId: 'thread_a', state: 'Still on old understanding', sourceOrReason: 'W-1 has not read it', updatedAt: at }] });
  const behind = startPack(store);
  assert.equal(behind.split('Still on old understanding: has not followed').length - 1, 1, 'one opening for the object, not one per change');
  assert.match(behind, /`thread_a` · In progress — Still on old understanding: has not followed “D59[^”]*” \(`chg_1`\) — W-1 still writes out every state \[\d\]; “A second decision it has not followed” \(`chg_2`\) — W-1 has not read it/);
  // A mark with nothing to check it against is not written; one with a clue and a source is.
  store.marks.put({ id: 'mark_bare', projectId: 'p1', kind: 'Suspected stale', targetId: 'thread_b', clueSourceIds: [], clue: '', since: at, noteId: null, closed: null } as EntryMark);
  store.marks.put({ id: 'mark_note', projectId: 'p1', kind: 'Suspected stale', targetId: 'note_here', clueSourceIds: ['src_doc'], clue: 'hangs on a note', since: at, noteId: null, closed: null } as EntryMark);
  store.marks.put({ id: 'mark_good', projectId: 'p1', kind: 'Layer drift', targetId: 'thread_b', clueSourceIds: ['src_doc'], clue: 'PLAN.md §1 and the contract disagree on the scope', since: at, noteId: null, closed: null } as EntryMark);
  const again = startPack(store);
  assert.match(again, /- Layer drift \(`mark_good`\) on W-2 · Work in A2 \(`thread_b`\): PLAN\.md §1 and the contract disagree on the scope \[\d\]/, 'a mark off the map is indexed with what differs and what it was checked against');
  assert.doesNotMatch(again, /mark_bare/, 'a mark that says neither what differs nor what it was checked against stays in the assets');
  assert.doesNotMatch(again, /mark_note|hangs on a note/, 'a mark never hangs on a note');
  assert.match(again, /- Entry marks: 1 of 3 open marks are written into this pack/, 'the map’s opening counts what is here and what is not');
});

test('a work pack carries only the project-wide entries that bear on that work', () => {
  const store = demoStore();
  const work = assembleContext(store, project, { scope: { kind: 'work', ids: ['thread_a'] }, purpose: 'Work', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null } as ContextRequest, 'Idle').markdown;
  assert.match(work, /## Notes for you[\s\S]*A note that names W-1/, 'a project-wide note that names this work is here');
  assert.doesNotMatch(work, /A note about the whole project/, 'a project-wide note that does not bear on this work stays in the start pack (AC-33)');
  const start = startPack(store);
  assert.match(start, /A note about the whole project/, 'the start pack has both');
  assert.match(start, /## Notes for you[\s\S]*\(`note_wide` · For information\)/, 'a note carries the id its full text is fetched with');
});

test('every kind and recipient says how its pack differs from the default one', () => {
  const o = contextOptions(demoStore(), project);
  const kind = (name: string) => o.kindDifferences.find((x) => x.name === name)!.difference;
  assert.equal(kind('Implement'), 'the default pack');
  // A kind that changes nothing on this project says so, instead of leaving the agent to fetch and compare.
  assert.match(kind('Investigate'), /start pack: the same pack as the default/);
  // One that changes something names the sections and the size.
  assert.match(kind('Plan'), /start pack: [^·]*`Relevant work` differs/);
  assert.match(kind('Plan'), /work pack \(measured on W-1 · Work in A1\): [^\n]*drops `Code entry and recent changes`/);
  assert.match(kind('Review'), /characters (more|less) in all/);
  assert.equal(o.recipientDifferences.find((x) => x.name === 'Incoming agent')!.difference, 'the default pack');
  assert.match(o.recipientDifferences.find((x) => x.name === 'Worker')!.difference, /`Current direction` differs/);
});

/**
 * D56: one record per piece of work, its net changes under it, each saying what changed and why. A point-in-time
 * record the work touched is named and judged nowhere.
 */
test('a piece of work is one entry with its changes under it', () => {
  const store = demoStore();
  const at = '2026-09-16T09:00:00.000Z';
  store.changes.put({
    id: 'chg_work', projectId: 'p1', at, atSource: 'material', material: 'Decision', effect: 'Replaced',
    title: 'The 9/18 session', summary: 'Two things changed.', before: null, after: null,
    sourceIds: ['src_doc'], by: { author: { kind: 'owner', name: null }, holder: null, identity: 'Decision' }, affects: ['ref_a'],
    work: { kind: 'Session', label: 'Owner session, 18 Sep afternoon', sessionId: null, startedAt: at, endedAt: at, openEnded: false },
    items: [
      { id: 'item_1', at, atSource: 'material', material: 'Decision', effect: 'Replaced', title: 'Normal states are not exported', summary: 'Only checked anomalies go into a pack.', before: 'every state was written out', after: 'only checked anomalies', sourceIds: ['src_doc'], by: { author: { kind: 'owner', name: null }, holder: null, identity: 'Decision' }, why: 'the owner could not find the real problems in the noise', affects: ['ref_a'] },
      { id: 'item_2', at, atSource: 'material', material: 'Plan update', effect: 'Deferred', title: 'The second area waits', summary: 'A2 is put off until the first pack is checked.', before: 'A2 planned for this round', after: 'A2 deferred', sourceIds: ['src_doc'], by: { author: { kind: 'owner', name: null }, holder: null, identity: 'Decision' }, why: null, affects: ['ref_b'] },
    ],
    notJudged: [{ nodeId: 'thread_done', reason: 'Point-in-time record', at }],
    propagation: [], segment: null, createdInJobId: null, updatedAt: at,
  } as unknown as ChangeRecord);
  const md = startPack(store);
  const section = md.split('## Changes since last session')[1]!.split('\n## ')[0]!;
  assert.match(section, /- 2026-09-16 · Session: \*\*Owner session, 18 Sep afternoon\*\* \(`chg_work`\) · 2 changes/, 'the piece of work is the entry');
  assert.match(section, /\n {2}- Replaced · Decision · \*\*Normal states are not exported\*\*/, 'each net change is one item under it');
  assert.match(section, /\n {4}Why: the owner could not find the real problems in the noise/, 'an item says why, in the material’s own terms');
  assert.match(section, /\n {2}- Deferred · Plan update · \*\*The second area waits\*\*/);
  assert.doesNotMatch(section, /\n {4}Why: *\n/, 'an item with no stated reason says nothing rather than inventing one');
  assert.match(section, /Recorded at the time, not judged: W-0 · Finished work \(`thread_done`\)/, 'a point-in-time record is named, not chased');
});

/**
 * D56: the round's judgement says which items of which piece of work an object still lacks, so the pack names the
 * item, not just the record it belongs to.
 */
test('what an object lacks is named item by item', () => {
  const store = demoStore();
  const at = '2026-09-16T09:30:00.000Z';
  store.changes.put({
    id: 'chg_two', projectId: 'p1', at, atSource: 'material', material: 'Decision', effect: 'Replaced',
    title: 'The 9/16 session', summary: 'Two things changed.', before: null, after: null,
    sourceIds: ['src_doc'], by: { author: { kind: 'owner', name: null }, holder: null, identity: 'Decision' }, affects: ['ref_a'],
    work: { kind: 'Session', label: 'Owner session, 16 Sep', sessionId: null, startedAt: at, endedAt: at, openEnded: false },
    items: [
      { id: 'item_a', at, atSource: 'material', material: 'Decision', effect: 'Replaced', title: 'The state list goes', summary: 'Out it goes.', before: 'states listed', after: 'no states', sourceIds: ['src_doc'], by: { author: { kind: 'owner', name: null }, holder: null, identity: 'Decision' }, why: null, affects: ['ref_a'] },
      { id: 'item_b', at, atSource: 'material', material: 'Plan update', effect: 'Deferred', title: 'A2 waits', summary: 'Later.', before: null, after: null, sourceIds: ['src_doc'], by: { author: { kind: 'owner', name: null }, holder: null, identity: 'Decision' }, why: null, affects: ['ref_b'] },
    ],
    propagation: [], notJudged: [], segment: null, createdInJobId: null, updatedAt: at,
  } as unknown as ChangeRecord);
  store.rounds.put({ id: 'round_0001', projectId: 'p1', number: 1, startedAt: at, endedAt: at, mainJobId: null, result: null } as never);
  store.propagation.put({
    id: 'round_0001:thread_a', projectId: 'p1', nodeId: 'thread_a', roundId: 'round_0001', state: 'Still on old understanding',
    sourceOrReason: 'W-1 still writes the old shape', covers: [{ changeId: 'chg_two', itemId: 'item_a' }], followed: [],
    lacks: [{ changeId: 'chg_two', itemId: 'item_a', what: 'W-1 still writes out every state' }], closed: [],
    objectUpdatedAt: at, at, jobId: null,
  } as never);
  const md = startPack(store);
  assert.match(md, /has not followed “Owner session, 16 Sep · The state list goes” \(`chg_two`\) — W-1 still writes out every state/, 'the item is named, inside the piece of work it belongs to');
  assert.doesNotMatch(md, /has not followed “A2 waits”/, 'only what it lacks, not every item of the work');
});

/**
 * What an object lacks now is what its latest judgement says (D56; Spec §2.10, §7.1; CKC-12 AC-3): each round judges
 * what reached the object together with what it still lacked, so the latest judgement carries every lack still open.
 * Reading every round's `Still on old understanding` kept an object that had followed since on the map as behind, and
 * repeated what an earlier round said beside what the latest one says.
 */
test('the pack reads each object’s latest judgement: one that has followed since is not behind, one still behind shows what the latest round says', () => {
  const store = demoStore();
  const ROUND1 = '2026-09-18T01:00:00.000Z';
  const ROUND2 = '2026-09-19T01:00:00.000Z';
  const by = { author: { kind: 'owner', name: null }, holder: null, identity: 'Decision' };
  // Only this piece of work reaches W-1 and W-2, so what the pack says about them comes from the rounds' judgements.
  const old = store.changes.get('chg_1')!;
  store.changes.put({ ...old, propagation: old.propagation.filter((p) => p.nodeId !== 'thread_a' && p.nodeId !== 'thread_b') });
  store.changes.put({
    id: 'chg_rounds', projectId: 'p1', at, atSource: 'material', material: 'Decision', effect: 'Replaced',
    title: 'The 9/18 session', summary: 'Two things changed.', before: null, after: null, sourceIds: ['src_doc'], by, affects: ['ref_a'],
    work: { kind: 'Session', label: 'Owner session, 18 Sep', sessionId: null, startedAt: at, endedAt: at, openEnded: false },
    items: [
      { id: 'item_states', at, atSource: 'material', material: 'Decision', effect: 'Replaced', title: 'The state list goes', summary: 'Only anomalies are written.', before: 'every state', after: 'anomalies only', sourceIds: ['src_doc'], by, why: null, affects: ['ref_a'] },
      { id: 'item_defer', at, atSource: 'material', material: 'Plan update', effect: 'Deferred', title: 'A2 waits', summary: 'A2 moves to the next round.', before: 'A2 now', after: 'A2 later', sourceIds: ['src_doc'], by, why: null, affects: ['ref_b'] },
    ],
    propagation: [
      { nodeId: 'thread_a', state: 'Not yet checked', sourceOrReason: '', updatedAt: at, itemIds: ['item_states', 'item_defer'] },
      { nodeId: 'thread_b', state: 'Not yet checked', sourceOrReason: '', updatedAt: at, itemIds: ['item_states', 'item_defer'] },
    ],
    notJudged: [], segment: null, createdInJobId: null, updatedAt: at,
  } as unknown as ChangeRecord);

  // Round 1: both are behind.
  const round1 = startRound(store, 'p1', 'job_round_1', ROUND1);
  judgeObject(store, 'p1', round1.id, { nodeId: 'thread_a', state: 'Still on old understanding', sourceOrReason: 'W-1 writes every state', lacks: [{ changeId: 'chg_rounds', itemId: 'item_states', what: 'W-1 still writes out every state' }] }, ROUND1);
  judgeObject(store, 'p1', round1.id, { nodeId: 'thread_b', state: 'Still on old understanding', sourceOrReason: 'W-2 follows neither', lacks: [
    { changeId: 'chg_rounds', itemId: 'item_states', what: 'W-2 still asks for the old state list' },
    { changeId: 'chg_rounds', itemId: 'item_defer', what: 'W-2 still plans A2 for this round' },
  ] }, ROUND1);
  store.rounds.put({ ...store.rounds.get(round1.id)!, endedAt: ROUND1 });
  // Round 2: W-1 has followed; W-2 has followed the deferral and still lacks the state list, which the round now words differently.
  const round2 = startRound(store, 'p1', 'job_round_2', ROUND2);
  judgeObject(store, 'p1', round2.id, { nodeId: 'thread_a', state: 'Updated', sourceOrReason: 'W-1 now writes only the anomalies', followed: [{ changeId: 'chg_rounds', itemId: 'item_states' }] }, ROUND2);
  judgeObject(store, 'p1', round2.id, { nodeId: 'thread_b', state: 'Still on old understanding', sourceOrReason: 'W-2 moved A2 out', followed: [{ changeId: 'chg_rounds', itemId: 'item_defer' }], lacks: [{ changeId: 'chg_rounds', itemId: 'item_states', what: 'W-2 still lists every state in its acceptance' }] }, ROUND2);
  store.rounds.put({ ...store.rounds.get(round2.id)!, endedAt: ROUND2 });

  const md = startPack(store);
  assert.doesNotMatch(md, /`thread_a` · In progress[^\n]*Still on old understanding/, 'W-1 followed in the latest round, so its row does not say it is behind');
  assert.doesNotMatch(md, /W-1 still writes out every state/, 'nor is the lack an earlier round recorded carried anywhere');
  const fresh = md.slice(md.indexOf('## Freshness'));
  assert.match(fresh, /- Still on old understanding: W-2 · Work in A2 \(`thread_b`\) has not followed “Owner session, 18 Sep · The state list goes” \(`chg_rounds`\) — W-2 still lists every state in its acceptance/, 'W-2 lacks what the latest round says it lacks');
  assert.doesNotMatch(md, /W-2 still asks for the old state list|W-2 still plans A2/, 'what an earlier round said, and what W-2 has followed since, are not repeated');
  assert.equal(md.split('Still on old understanding').length - 1, 1, 'one object is behind, and it is named once');
});
