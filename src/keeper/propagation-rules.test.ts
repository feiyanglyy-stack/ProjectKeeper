/**
 * The counter-examples an independent review (AI, 2026-09-20) found in the propagation and replacement rules, each
 * kept as a test so the same hole cannot reopen. Every one of these failed before the fix, and the comment on each
 * says what went wrong and which rule it broke (Spec §2.10, §5.5; D56).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { stableId } from '../model/ids.ts';
import {
  countRound, downstreamOfChange, downstreamOfItem, itemsForObject, judgeObject, lastJudgement,
  notJudgedReason, roundIdOf, startRound,
} from './adjustment.ts';
import { deriveGraph } from './organize/graph.ts';
import { objectPending, pendingByArea, pendingForRound } from './organize/follow-up.ts';
import { cameFromFor, originOfJob } from './note-origin.ts';
import type {
  ChangeItem, ChangeRecord, GraphNode, GraphRelation, KeeperJob, ObjectJudgement, Project, ReferenceItem, Source, WorkThread,
} from '../model/types.ts';

const AT = '2026-09-18T00:00:00.000Z';
const LATER = '2026-09-19T00:00:00.000Z';
const LATEST = '2026-09-20T00:00:00.000Z';

const project = { id: 'p1', name: 'P', language: 'en', locations: ['D:\\p'], scope: [], roles: [] } as unknown as Project;
const store = () => ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-prop-')));

const attribution = { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' };

const reference = (s: ProjectStore, id: string, category: string, extra: Partial<ReferenceItem> = {}) =>
  s.reference.put({ id, projectId: 'p1', category, name: id, ids: [], text: id, quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT, ...extra } as ReferenceItem);

const thread = (s: ProjectStore, id: string, extra: Partial<WorkThread> = {}) =>
  s.threads.put({ id, projectId: 'p1', title: id, ids: [], doing: id, changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution, inputs: { jobId: 'j', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: AT, updatedAt: AT, ...extra } as WorkThread);

const relate = (s: ProjectStore, type: string, from: string, to: string) =>
  s.relations.put({ id: `rel_${type}_${from}_${to}`, projectId: 'p1', type, from, to, claim: '', basis: 'Explicit', evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: AT } as GraphRelation);

const item = (id: string, affects: string[]): ChangeItem =>
  ({ id, at: AT, atSource: null, material: 'Decision', effect: 'Replaced', title: id, summary: `${id} happened`, before: 'old', after: 'new', sourceIds: [], by: null, why: null, affects } as unknown as ChangeItem);

const change = (s: ProjectStore, id: string, items: ChangeItem[], at = AT) =>
  s.changes.put({
    id, projectId: 'p1', at, effect: 'Replaced', title: id, summary: '', before: null, after: null, sourceIds: [],
    affects: [...new Set(items.flatMap((i) => i.affects))], propagation: [], items, updatedAt: at,
  } as unknown as ChangeRecord);

// ───────────────────────── the walk ─────────────────────────

test('downstream is two hops, not three', () => {
  // `a <- b <- c <- d`: b and c are within two hops of a, d is three away. Stopping the walk at `left < 0`
  // crossed one edge more than §5.5 allows, so d was judged against a change it is three steps from.
  const s = store();
  reference(s, 'ref_a', 'Requirement');
  for (const id of ['thread_b', 'thread_c', 'thread_d']) thread(s, id);
  relate(s, 'depends on', 'thread_b', 'ref_a');
  relate(s, 'depends on', 'thread_c', 'thread_b');
  relate(s, 'depends on', 'thread_d', 'thread_c');
  assert.deepEqual(downstreamOfItem(s, item('i1', ['ref_a'])).sort(), ['thread_b', 'thread_c']);
});

// ───────────────────────── who is judged ─────────────────────────

test('a file kept as code is judged as usual; a run result is not', () => {
  // §2.10 judges documents, plans, unfinished work, code areas and tests as usual. The graph has no `Code`
  // category, so a maintained code file becomes a `Result` node (§1.5); reading the node's category before the
  // material's use classed every code area as a point-in-time record and took it out of propagation for good.
  const s = store();
  const src = (id: string, usedAs: string) => s.sources.put({ id, projectId: 'p1', title: id, anchor: { kind: 'file', path: `D:\\p\\${id}.ts`, headingPath: [], lineStart: 1, lineEnd: 2 }, ids: [], version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt: 'x', usedAs, usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: 'scope', hasCredential: false, bytes: 10 } as unknown as Source);
  const node = (id: string) => s.nodes.put({ id, projectId: 'p1', category: 'Result', label: id, refKind: 'source', refId: id, validity: 'Current', progress: null, basis: 'Explicit', attribution: null, sourceIds: [id], areaId: null, parentWorkId: null, replacedBy: null, createdAt: AT, updatedAt: AT } as unknown as GraphNode);
  src('src_code', 'Code');
  src('src_run', 'Run result');
  node('src_code');
  node('src_run');
  assert.equal(notJudgedReason(s, 'src_code'), null, 'a maintained code area is judged');
  assert.equal(notJudgedReason(s, 'src_run'), 'Point-in-time record', 'a run result is not');
});

// ───────────────────────── seeding ─────────────────────────

test('a change seeds downstream along a relation the Keeper wrote directly', () => {
  // The blocking one. Seeding used to run in the middle of the derivation, before the relations the Keeper wrote
  // itself were merged back in, so an `implements` relation it had written never carried a change downstream:
  // the real current object working to the old understanding never appeared as `Not yet checked`, in any round.
  const s = store();
  reference(s, 'ref_spec', 'Requirement');
  thread(s, 'thread_impl');
  relate(s, 'implements', 'thread_impl', 'ref_spec');   // written by the Keeper, not derivable from any field
  change(s, 'chg_1', [item('i1', ['ref_spec'])]);
  deriveGraph(s, project);
  const entry = s.changes.get('chg_1')!.propagation.find((p) => p.nodeId === 'thread_impl');
  assert.ok(entry, 'the work that implements the requirement is seeded');
  assert.equal(entry!.state, 'Not yet checked');
});

test('an object is asked only about the items that reached it', () => {
  // One piece of work, two unrelated items. Seeding recorded only which objects a record reached, not which item
  // reached them, so each object was handed the whole record and judged against items that never touched it.
  const s = store();
  reference(s, 'ref_x', 'Requirement');
  reference(s, 'ref_y', 'Requirement');
  thread(s, 'thread_p');
  thread(s, 'thread_q');
  relate(s, 'depends on', 'thread_p', 'ref_x');
  relate(s, 'depends on', 'thread_q', 'ref_y');
  change(s, 'chg_1', [item('i_x', ['ref_x']), item('i_y', ['ref_y'])]);
  deriveGraph(s, project);
  const entryOf = (id: string) => s.changes.get('chg_1')!.propagation.find((p) => p.nodeId === id)!;
  assert.deepEqual([...entryOf('thread_p').itemIds ?? []], ['i_x'], 'the work under X gets the X item');
  assert.deepEqual([...entryOf('thread_q').itemIds ?? []], ['i_y'], 'and not the unrelated Y item');
  const round = startRound(s, 'p1');
  assert.deepEqual(itemsForObject(s, 'thread_p', round.id).covers.map((c) => c.itemId), ['i_x']);
});

test('the walk that reaches an object also reaches it through several items', () => {
  // The other half of the same rule: when two items of one record really do both reach an object, it is asked
  // about both.
  const s = store();
  reference(s, 'ref_x', 'Requirement');
  thread(s, 'thread_p');
  relate(s, 'depends on', 'thread_p', 'ref_x');
  change(s, 'chg_1', [item('i_1', ['ref_x']), item('i_2', ['ref_x'])]);
  const { judged } = downstreamOfChange(s, s.changes.get('chg_1')!);
  assert.deepEqual(judged.find((j) => j.nodeId === 'thread_p')!.itemIds, ['i_1', 'i_2']);
});

// ───────────────────────── one judgement per object per round ─────────────────────────

/** An object already judged once, with `what` still lacked, so the next round has something to carry. */
function behindAfterRoundOne(s: ProjectStore) {
  reference(s, 'ref_a', 'Requirement');
  thread(s, 'thread_w');
  relate(s, 'depends on', 'thread_w', 'ref_a');
  change(s, 'chg_a', [item('i_a', ['ref_a'])]);
  deriveGraph(s, project);
  const one = startRound(s, 'p1');
  judgeObject(s, 'p1', one.id, {
    nodeId: 'thread_w', state: 'Still on old understanding', sourceOrReason: 'still written to the old wording',
    lacks: [{ changeId: 'chg_a', itemId: 'i_a', what: 'it still says the old wording' }],
  });
  s.rounds.put({ ...s.rounds.get(one.id)!, endedAt: LATER });
  return one;
}

test('an item still lacked is carried into the next round, not dropped when a new change arrives', () => {
  // The second blocking one. §5.5 ends an item in exactly three ways — the object followed it, a later change
  // superseded it, or the owner or holder said it need not be handled. Taking only `covers` here was a fourth:
  // the round after a new change reached the same object wrote a judgement with no trace of the old item.
  const s = store();
  behindAfterRoundOne(s);
  // A second, unrelated change reaches the same object, and the round concludes the object follows it.
  change(s, 'chg_b', [item('i_b', ['ref_a'])], LATER);
  deriveGraph(s, project);
  const two = startRound(s, 'p1');
  const j = judgeObject(s, 'p1', two.id, {
    nodeId: 'thread_w', state: 'Updated', sourceOrReason: 'it follows the new one',
    followed: [{ changeId: 'chg_b', itemId: 'i_b' }],
  });
  assert.deepEqual(j.lacks.map((l) => l.itemId), ['i_a'], 'what it still lacked is still lacked');
  assert.equal(j.state, 'Still on old understanding', 'and the object is still behind, whatever the call said');
  assert.deepEqual(j.followed.map((f) => f.itemId), ['i_b']);
});

test('a carried item ends when the round says it is followed', () => {
  // The same carry, concluded: naming the carried item closes it, and the object is no longer behind. Without
  // this the carry above would be a trap — an item nothing can ever end. This one held before the fix too, for
  // the wrong reason: the item had already vanished, so of course nothing lacked it. It is kept as the guard
  // that the carry did not go too far the other way.
  const s = store();
  behindAfterRoundOne(s);
  change(s, 'chg_b', [item('i_b', ['ref_a'])], LATER);
  deriveGraph(s, project);
  const two = startRound(s, 'p1');
  const j = judgeObject(s, 'p1', two.id, {
    nodeId: 'thread_w', state: 'Updated', sourceOrReason: 'rewritten to both',
    followed: [{ changeId: 'chg_a', itemId: 'i_a' }, { changeId: 'chg_b', itemId: 'i_b' }],
  });
  assert.deepEqual(j.lacks, []);
  assert.equal(j.state, 'Updated');
});

test('the round the prompt is built for shows what the object still lacks', () => {
  // A carried item the model is never shown is one it can never conclude on, so the carry would freeze the
  // object behind for good.
  const s = store();
  behindAfterRoundOne(s);
  change(s, 'chg_b', [item('i_b', ['ref_a'])], LATER);
  deriveGraph(s, project);
  startRound(s, 'p1');
  const carried = itemsForObject(s, 'thread_w', roundIdOf(2)).carried;
  assert.deepEqual(carried.map((c) => c.itemId), ['i_a']);
  assert.match(carried[0]!.what, /old wording/);
});

test('a second look in the same round can take back what the first one said the object lacks', () => {
  // A union kept the earlier conclusion, so a re-check that found the object had followed the item after all
  // left it behind anyway: an independent review could add a finding but never correct one.
  const s = store();
  reference(s, 'ref_a', 'Requirement');
  thread(s, 'thread_w');
  relate(s, 'depends on', 'thread_w', 'ref_a');
  change(s, 'chg_a', [item('i_a', ['ref_a'])]);
  deriveGraph(s, project);
  const one = startRound(s, 'p1');
  judgeObject(s, 'p1', one.id, {
    nodeId: 'thread_w', state: 'Still on old understanding', sourceOrReason: 'looks stale',
    lacks: [{ changeId: 'chg_a', itemId: 'i_a', what: 'it still says the old wording' }],
  });
  const second = judgeObject(s, 'p1', one.id, {
    nodeId: 'thread_w', state: 'Updated', sourceOrReason: 'read again: it was rewritten in the same session',
    followed: [{ changeId: 'chg_a', itemId: 'i_a' }],
  });
  assert.deepEqual(second.lacks, [], 'the correction takes the item out of what it lacks');
  assert.equal(second.state, 'Updated');
  assert.deepEqual(second.followed.map((f) => f.itemId), ['i_a']);
});

test('an object that changed after its judgement is handed out again for what it still lacks, not for what it concluded', () => {
  // Spec §2.10 (CKC-11 AC-12): after an object changes, the next round judges the items that arrived since and the
  // items without a conclusion; an item it already concluded is not judged again. Before, any change to the object
  // re-opened everything that had ever reached it.
  const s = store();
  reference(s, 'ref_a', 'Requirement');
  reference(s, 'ref_b', 'Requirement');
  thread(s, 'thread_w');
  thread(s, 'thread_v');
  relate(s, 'depends on', 'thread_w', 'ref_a');
  relate(s, 'depends on', 'thread_v', 'ref_b');
  change(s, 'chg_a', [item('i_a', ['ref_a'])]);
  change(s, 'chg_b', [item('i_b', ['ref_b'])]);
  deriveGraph(s, project);
  const one = startRound(s, 'p1', null, AT);
  judgeObject(s, 'p1', one.id, { nodeId: 'thread_w', state: 'Updated', sourceOrReason: 'it follows it' }, AT);
  judgeObject(s, 'p1', one.id, { nodeId: 'thread_v', state: 'Still on old understanding', sourceOrReason: 'it does not follow it yet', lacks: [{ changeId: 'chg_b', itemId: 'i_b', what: 'the new shape' }] }, AT);
  s.rounds.put({ ...s.rounds.get(one.id)!, endedAt: LATER });
  assert.deepEqual(pendingByArea(s).flatMap((b) => b.entries.map((e) => e.nodeId)), [], 'nothing pending while they sit still');

  thread(s, 'thread_w', { updatedAt: LATEST, results: 'rewritten by its holder' });
  thread(s, 'thread_v', { updatedAt: LATEST, results: 'rewritten by its holder' });
  startRound(s, 'p1', null, LATEST);
  assert.equal(objectPending(s, 'thread_w'), false, 'what it concluded stands after it changes');
  assert.equal(objectPending(s, 'thread_v'), true, 'what it lacked is judged again once it moves');
  assert.deepEqual(pendingByArea(s).flatMap((b) => b.entries.map((e) => e.nodeId)), ['thread_v'], 'and a batch carries only that one');
});

test('round ids are ordered by number, not as text', () => {
  // `roundIdOf` pads to four digits, so from `round_10000` on the dictionary order stops matching the numeric
  // one: `round_9999 < round_10000` is false and the carry took the wrong round's judgement.
  const s = store();
  thread(s, 'thread_w');
  const judgement = (roundId: string, sourceOrReason: string): ObjectJudgement =>
    ({ id: `${roundId}:thread_w`, projectId: 'p1', nodeId: 'thread_w', roundId, state: 'Updated', sourceOrReason, covers: [], followed: [], lacks: [], closed: [], objectUpdatedAt: AT, jobId: null, at: AT });
  s.propagation.put(judgement(roundIdOf(9999), 'the older one'));
  s.propagation.put(judgement(roundIdOf(10000), 'the newer one'));
  assert.equal(roundIdOf(10000), 'round_10000');
  // As text, `round_9999 < round_10000` is false, so round 10,000 could not see what round 9,999 concluded and
  // judged the object from nothing.
  assert.equal(lastJudgement(s, 'thread_w', roundIdOf(10000))!.sourceOrReason, 'the older one');
  assert.equal(lastJudgement(s, 'thread_w', roundIdOf(10001))!.sourceOrReason, 'the newer one');
});

// ───────────────────────── the round's numbers ─────────────────────────

test("a round's not-judged count is this round's, not the project's history", () => {
  // The count was taken from every record of every round, so a round that added no not-judged object still
  // reported the historical total as its own.
  const s = store();
  reference(s, 'ref_a', 'Requirement');
  thread(s, 'thread_done', { progress: 'Done' });
  relate(s, 'depends on', 'thread_done', 'ref_a');
  change(s, 'chg_a', [item('i_a', ['ref_a'])]);
  deriveGraph(s, project);   // the Done work item is listed as not judged
  const listed = s.changes.get('chg_a')!;
  assert.equal((listed.notJudged ?? []).length, 1, 'it was recorded once');
  // It was recorded in an earlier round, so this round did not add it.
  s.changes.put({ ...listed, notJudged: (listed.notJudged ?? []).map((e) => ({ ...e, at: AT })) });

  const round = startRound(s, 'p1', null, LATEST);
  assert.equal(countRound(s, round.id).counts.notJudged, 0, 'this round added none of its own');
});

test("an entry's record of which items reached the object never shrinks", () => {
  // `covers` leaves out what an earlier round settled, so a round judging only a newly arrived item would have
  // rewritten the entry down to that one item — erasing the older one, which the next round after the object
  // moved would then never ask about again.
  const s = store();
  reference(s, 'ref_a', 'Requirement');
  thread(s, 'thread_w');
  relate(s, 'depends on', 'thread_w', 'ref_a');
  change(s, 'chg_a', [item('i_1', ['ref_a'])]);
  deriveGraph(s, project);
  const one = startRound(s, 'p1', null, AT);
  judgeObject(s, 'p1', one.id, { nodeId: 'thread_w', state: 'Updated', sourceOrReason: 'it follows i_1', followed: [{ changeId: 'chg_a', itemId: 'i_1' }] }, AT);
  s.rounds.put({ ...s.rounds.get(one.id)!, endedAt: AT });

  // The same piece of work gains a second item, which reaches the object while the first is already settled.
  const grown = s.changes.get('chg_a')!;
  s.changes.put({ ...grown, items: [...grown.items!, item('i_2', ['ref_a'])] });
  deriveGraph(s, project);
  const two = startRound(s, 'p1', null, LATER);
  judgeObject(s, 'p1', two.id, { nodeId: 'thread_w', state: 'Updated', sourceOrReason: 'it follows i_2 too', followed: [{ changeId: 'chg_a', itemId: 'i_2' }] }, LATER);

  const entry = s.changes.get('chg_a')!.propagation.find((p) => p.nodeId === 'thread_w')!;
  assert.deepEqual([...entry.itemIds ?? []].sort(), ['i_1', 'i_2'], 'both items are still recorded as having reached it');
});

test('what a round is given to judge names the items that reached each object, and what it still lacks', () => {
  // What the round is told breaks without a sound: the tools would still be correct and the model would simply never
  // be told, so the round would judge whole records again and could never conclude on a carried item.
  const s = store();
  behindAfterRoundOne(s);
  reference(s, 'ref_other', 'Requirement');
  thread(s, 'thread_other');
  relate(s, 'depends on', 'thread_other', 'ref_other');
  // A second piece of work with two items, reaching two different objects.
  change(s, 'chg_b', [item('i_b', ['ref_a']), item('i_other', ['ref_other'])], LATER);
  deriveGraph(s, project);
  startRound(s, 'p1', null, LATEST);

  // The listing the round gets from pk_round_pending.
  const listed = pendingForRound(s).text;
  assert.match(listed, /thread_w[\s\S]*?judge against: chg_b items i_b/, 'the object is given only the item that reached it');
  assert.doesNotMatch(listed, /judge against: chg_b items i_b, i_other/, 'not the unrelated item of the same piece of work');
  assert.match(listed, /still lacking from an earlier round: chg_a item i_a — it still says the old wording/);
});

// ───────────────────────── what the derivation must not overwrite ─────────────────────────

test('deriving the graph does not overwrite what the replacement check settled', () => {
  // The replacement check decides which part of a decision a later one supersedes, and whether the new decision
  // said so itself (`Explicit`) or only gave different content for the same matter (`Inferred`). Neither can be
  // rebuilt from any field, and the derivation used to restate the relation over both on the first derivation
  // after any round that ran the check: `Inferred` became `Explicit`, so the owner lost the mark saying the basis
  // was the program's reading, and the superseded part disappeared from the claim.
  const s = store();
  reference(s, 'ref_old', 'Decision', { validity: 'Replaced', replacedBy: 'ref_new' });
  reference(s, 'ref_new', 'Decision');
  // The id has to be the one the derivation would compute, or the two are different relations and the test
  // guards nothing: `stableId` hashes its parts, so a hand-written id never collides with a derived one.
  s.relations.put({
    id: stableId('rel', 'replaces', 'ref_new', 'ref_old'), projectId: 'p1', type: 'replaces', from: 'ref_new', to: 'ref_old',
    claim: 'ref_new replaces ref_old: only the cadence clause', basis: 'Inferred',
    evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' },
    assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: AT,
  } as GraphRelation);

  deriveGraph(s, project);

  const after = s.relations.all().find((r) => r.type === 'replaces' && r.to === 'ref_old')!;
  assert.equal(after.basis, 'Inferred', 'the program’s reading stays marked as a reading the owner can correct');
  assert.match(after.claim, /only the cadence clause/, 'and which part it supersedes is still there');
});

test("a note a Follow up round writes comes from the follow-up, not from organizing or a re-look", () => {
  // D59 gave the round one main job with scope `round`, and the origin table was not told, so every note a round wrote
  // was filed as `Organizing` and the round's own result counted none of them — a number the owner reads as "this round
  // raised nothing". The clerk method has the same shape: its notes are written by the synthesis (a `Product re-look`
  // job) and the spot-check (an `Organizing` job), so the round decides the origin, not the job's kind.
  const s = store();
  s.clerkRounds.put({ id: 'crd_1', projectId: 'p1', kind: 'Follow up', number: 1, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'root', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT });
  const step = (kind: string, stepKind: string) => ({ id: `job_${stepKind}`, kind, scope: { kind: 'clerk-step', ids: ['crd_1'], label: stepKind }, task: { extra: { kind: 'clerk-step', roundId: 'crd_1' } }, step: { roundId: 'crd_1', kind: stepKind, path: null }, parentJobId: 'root' }) as unknown as KeeperJob;
  assert.equal(cameFromFor(s, step('Product re-look', 'synthesis'), []).kind, 'Change follow-up');
  assert.equal(cameFromFor(s, step('Organizing', 'spot-check'), []).kind, 'Change follow-up');
  assert.equal(originOfJob({ kind: 'Organizing', scope: { kind: 'conversation', ids: [], label: 'm' } } as unknown as KeeperJob), 'Organizing', 'outside a round the kind decides');
});
