/**
 * The rules of D56 and D59 that the program keeps rather than the model (Spec §1.4, §1.8, §1.11, §2.1, §2.10, §5.4,
 * §5.5). Each test drives the pk_* tools the way the Keeper does, because that is where a bad write has to be
 * refused: a rule the model is merely asked to remember is a rule that was forgotten on 2026-09-18.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { keeperTools, noteRefusalFor, type ToolContext } from './tools.ts';
import { downstreamOfChange, downstreamOfItem, itemsOf, notJudgedReason, startRound } from './adjustment.ts';
import { objectPending } from './organize/follow-up.ts';
import type {
  GraphRelation, KeeperJob, ObjectJudgement, Project, ReferenceItem, Source, WorkThread,
} from '../model/types.ts';

const AT = '2026-09-18T00:00:00.000Z';
const LATER = '2026-09-19T00:00:00.000Z';

interface Harness {
  readonly store: ProjectStore;
  readonly ctx: ToolContext;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean; json: Record<string, unknown> }>;
}

function harness(): Harness {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-rules-')));
  const project = { id: 'p1', name: 'P', language: 'en', locations: ['D:\\p'], scope: [], roles: ['Product architect'] } as unknown as Project;
  for (const id of ['job_1', 'job_2', 'job_3']) store.jobs.put({
    id, projectId: 'p1', kind: 'Organizing', initiator: 'auto', scope: { kind: 'round', ids: [], label: id }, status: 'Running', queuedAt: AT, startedAt: AT, endedAt: null,
    savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null,
    requestBasis: null, parentJobId: null, resultText: null, priority: 1, task: { prompt: '', extra: { kind: 'round' } },
  } as unknown as KeeperJob);
  const ctx: ToolContext = { store, project, jobId: 'job_1', jobKind: 'Organizing', model: null };
  const tools = keeperTools(ctx);
  return {
    store, ctx,
    async call(name, args) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `no tool ${name}`);
      const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
      const result = await run('call', args);
      const text = result.content.map((c) => c.text).join('\n');
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a refusal is prose, not JSON */ }
      return { text, error: result.isError === true, json };
    },
  };
}

const source = (store: ProjectStore, id: string, path: string) =>
  store.sources.put({ id, projectId: 'p1', title: path, anchor: { kind: 'file', path, headingPath: [], lineStart: 1, lineEnd: 2 }, ids: [], version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt: 'x', usedAs: 'Design', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: 'scope', hasCredential: false, bytes: 10 } as Source);

const reference = (store: ProjectStore, id: string, category: string, name: string, extra: Partial<ReferenceItem> = {}) =>
  store.reference.put({ id, projectId: 'p1', category, name, ids: [], text: name, quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT, ...extra } as ReferenceItem);

const thread = (store: ProjectStore, id: string, title: string, extra: Partial<WorkThread> = {}) =>
  store.threads.put({ id, projectId: 'p1', title, ids: [], doing: title, changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, inputs: { jobId: 'j', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: AT, updatedAt: AT, ...extra } as WorkThread);

const relate = (store: ProjectStore, type: string, from: string, to: string) =>
  store.relations.put({ id: `rel_${type}_${from}_${to}`, projectId: 'p1', type, from, to, claim: '', basis: 'Explicit', evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: AT } as GraphRelation);

const work = (label: string, started = AT, ended = AT) =>
  ({ workKind: 'Session', workLabel: label, workSessionId: label, workStartedAt: started, workEndedAt: ended });

const item = (title: string, extra: Record<string, unknown> = {}) =>
  ({ at: AT, atFromMaterial: true, material: 'Decision', effect: 'Replaced', title, summary: `${title} happened`, byOwner: true, ...extra });

// ───────────────────────── 1 · one record per piece of work, holding its items ─────────────────────────

test('one piece of work is one record with several items, and a second call adds to it', async () => {
  const h = harness();
  source(h.store, 'src_spec', 'D:\\p\\SPEC.md');
  source(h.store, 'src_prd', 'D:\\p\\PRD.md');
  reference(h.store, 'ref_a', 'Requirement', 'R-1');
  reference(h.store, 'ref_b', 'Requirement', 'R-2');

  const first = await h.call('pk_write_change', {
    ...work('sess-1'), sourceIds: ['src_spec'],
    items: [item('Search replaces the tag browser', { before: 'Tag browser', after: 'Search', affects: ['ref_a'] })],
  });
  assert.equal(first.error, false, first.text);
  const second = await h.call('pk_write_change', {
    ...work('sess-1'), sourceIds: ['src_prd'],
    items: [item('Dates dropped from the plan', { effect: 'Abandoned', before: 'Dated milestones', after: 'Ordered milestones', affects: ['ref_b'] })],
  });
  assert.equal(second.error, false, second.text);

  assert.equal(h.store.changes.all().length, 1, 'the two files of one session are one record, not two');
  const record = h.store.changes.all()[0]!;
  assert.equal(record.id, first.json.id);
  assert.equal(record.items!.length, 2, 'the piece of work has two net changes');
  assert.deepEqual(record.items!.map((i) => i.effect).sort(), ['Abandoned', 'Replaced'], 'each item keeps its own effect');
  assert.deepEqual(record.items!.map((i) => i.affects.join()).sort(), ['ref_a', 'ref_b'], 'each item names the object it changed');
  assert.deepEqual([...record.affects].sort(), ['ref_a', 'ref_b'], 'the record’s subjects are the union of its items’');
  assert.deepEqual([...record.sourceIds].sort(), ['src_prd', 'src_spec'], 'both files are sources of the one record');
  assert.equal(record.work!.kind, 'Session');
  assert.deepEqual(record.propagation, [], 'a subject is not downstream of its own item, so nothing starts pending');
});

test('a note that only repeats a propagation state is judged from each object’s latest round', () => {
  const h = harness();
  thread(h.store, 'thread_down', 'downstream work');
  const judgement = (roundId: string, state: 'Updated' | 'Still on old understanding') => ({
    id: `${roundId}:thread_down`, projectId: 'p1', nodeId: 'thread_down', roundId, state,
    sourceOrReason: state === 'Updated' ? 'the work now follows the change' : 'the work still follows the old wording',
    covers: [], followed: [], lacks: [], closed: [], objectUpdatedAt: AT, jobId: 'job_1', at: AT,
  }) as ObjectJudgement;
  h.store.propagation.put(judgement('round_0001', 'Still on old understanding'));
  h.store.propagation.put(judgement('round_0002', 'Updated'));
  const note = { id: '', mountIds: ['thread_down'], changeIds: [], ask: 'Worth discussing', title: 'Downstream state', preview: 'The work may be behind.', whyItMatters: '', whatWouldSettleIt: '' };

  assert.equal(noteRefusalFor(h.store, note), null, 'an older Still judgement does not make the latest Updated state look behind');
  h.store.propagation.put(judgement('round_0003', 'Still on old understanding'));
  assert.match(noteRefusalFor(h.store, note) ?? '', /already records what it has not followed/, 'the latest Still judgement still prevents a reminder-only note');
});

test('changes with no session are grouped by time, and a historical one keeps its own date', async () => {
  const h = harness();
  source(h.store, 'src_plan', 'D:\\p\\PLAN.md');
  reference(h.store, 'ref_a', 'Plan', 'PLAN');
  const r = await h.call('pk_write_change', {
    workKind: 'Time range', workLabel: 'edits of 2026-09-18, no session', workStartedAt: AT, workEndedAt: AT,
    sourceIds: ['src_plan'], items: [item('P2 deferred', { effect: 'Deferred', before: 'P2 in this round', after: 'P2 next round', affects: ['ref_a'] })],
  });
  assert.equal(r.error, false, r.text);
  const record = h.store.changes.all()[0]!;
  assert.equal(record.work!.kind, 'Time range');
  assert.equal(record.work!.label, 'edits of 2026-09-18, no session');

  // Taking a project over: a deferral read out of an old document belongs to the piece of work of its own time,
  // by date when no session is left of it — not to the round that happens to be reading it.
  const historical = await h.call('pk_write_change', {
    workKind: 'Time range', workLabel: '2026-08-02, from the plan’s own record', workStartedAt: '2026-08-02T00:00:00.000Z', workEndedAt: '2026-08-02T23:59:59.000Z',
    sourceIds: ['src_plan'],
    items: [item('the tag browser was abandoned', { at: '2026-08-02T09:00:00.000Z', effect: 'Abandoned', before: 'Tag browser planned', after: 'dropped', affects: ['ref_a'] })],
  });
  assert.equal(historical.error, false, historical.text);
  assert.equal(h.store.changes.all().length, 2, 'a different stretch of time is a different piece of work');
  const old = h.store.changes.get(historical.json.id as string)!;
  assert.equal(old.items![0]!.at, '2026-08-02T09:00:00.000Z', 'the item keeps the time the material gives');
  assert.equal(old.at, '2026-08-02T09:00:00.000Z');
});

test('what §1.8 says is not a change is refused, and a piece of work with no net change gets no record', async () => {
  const h = harness();
  source(h.store, 'src_a', 'D:\\p\\A.md');
  reference(h.store, 'ref_a', 'Requirement', 'R-1');

  // Wording, formatting or a version number only.
  const wording = await h.call('pk_write_change', {
    ...work('sess-w'), sourceIds: ['src_a'],
    items: [item('Spec version bumped', { effect: 'Corrected', material: 'Plan update', before: 'Spec v2.6', after: 'Spec v2.7', affects: ['ref_a'] })],
  });
  assert.equal(wording.error, true, wording.text);
  assert.match(wording.text, /Wording, formatting or version number only/);
  assert.match(wording.text, /the meaning did not change/);
  assert.equal(h.store.changes.all().length, 0, 'no record is created');

  // Changed and changed back, as two items of the same piece of work that undo each other.
  const undone = await h.call('pk_write_change', {
    ...work('sess-u'), sourceIds: ['src_a'],
    items: [
      item('Search replaces the tag browser', { before: 'Tag browser', after: 'Search', affects: ['ref_a'] }),
      item('Tag browser restored', { before: 'Search', after: 'Tag browser', affects: ['ref_a'] }),
    ],
  });
  assert.equal(undone.error, true, undone.text);
  assert.match(undone.text, /Changed and changed back/);
  assert.equal(h.store.changes.all().length, 0);

  // Meeting the same net change again — restating it, re-reading it, looking it up as a dependency.
  const real = await h.call('pk_write_change', { ...work('sess-1'), sourceIds: ['src_a'], items: [item('Search replaces the tag browser', { before: 'Tag browser', after: 'Search', affects: ['ref_a'] })] });
  assert.equal(real.error, false, real.text);
  const again = await h.call('pk_write_change', { ...work('sess-2'), sourceIds: ['src_a'], items: [item('Search replaces the tag browser', { before: 'Tag browser', after: 'Search', affects: ['ref_a'] })] });
  assert.equal(again.error, true, again.text);
  assert.match(again.text, /Restating/);
  assert.equal(h.store.changes.all().length, 1, 'the second session records nothing: it only met the same change again');
});

test('a piece of work never spans two Follow up rounds', async () => {
  const h = harness();
  source(h.store, 'src_a', 'D:\\p\\A.md');
  reference(h.store, 'ref_a', 'Requirement', 'R-1');
  startRound(h.store, 'p1', 'job_1', AT);
  const r = await h.call('pk_write_change', {
    workKind: 'Session', workLabel: 'sess-live', workSessionId: 'sess-live', workStartedAt: '2026-09-17T00:00:00.000Z', workEndedAt: LATER,
    sourceIds: ['src_a'], items: [item('R-1 replaced', { before: 'old', after: 'new', affects: ['ref_a'] })],
  });
  assert.equal(r.error, true, r.text);
  assert.match(r.text, /never spans two Follow up rounds/);
  assert.match(r.text, /last pause/);
  assert.equal(h.store.changes.all().length, 0);

  const cut = await h.call('pk_write_change', {
    workKind: 'Session', workLabel: 'sess-live', workSessionId: 'sess-live', workStartedAt: '2026-09-17T00:00:00.000Z', workEndedAt: '2026-09-17T12:00:00.000Z', workOpenEnded: true,
    sourceIds: ['src_a'], items: [item('R-1 replaced', { before: 'old', after: 'new', affects: ['ref_a'] })],
  });
  assert.equal(cut.error, false, cut.text);
  assert.equal(h.store.changes.all()[0]!.work!.openEnded, true, 'the rest of the session is left for the next round');
});

// ───────────────────────── 2 · one judgement per object per round ─────────────────────────

/** A change on `ref_a`, with `thread_down` downstream of it and a few objects that are never judged. */
async function judged() {
  const h = harness();
  source(h.store, 'src_a', 'D:\\p\\A.md');
  reference(h.store, 'ref_a', 'Requirement', 'R-1');
  reference(h.store, 'ref_dec', 'Decision', 'D56');
  thread(h.store, 'thread_down', 'downstream work');
  thread(h.store, 'thread_done', 'finished work', { progress: 'Done' });
  relate(h.store, 'serves', 'thread_down', 'ref_a');
  relate(h.store, 'serves', 'thread_done', 'ref_a');
  relate(h.store, 'refines', 'ref_dec', 'ref_a');
  const r = await h.call('pk_write_change', { ...work('sess-1'), sourceIds: ['src_a'], items: [item('R-1 rewritten', { before: 'old R-1', after: 'new R-1', affects: ['ref_a'] })] });
  assert.equal(r.error, false, r.text);
  const change = h.store.changes.all()[0]!;
  // Downstream is found by rule and the pending entries follow from it.
  const down = downstreamOfItem(h.store, change.items![0]!);
  h.store.changes.put({ ...change, propagation: down.map((nodeId) => ({ nodeId, state: 'Not yet checked' as const, sourceOrReason: '', updatedAt: AT })) });
  return { h, changeId: change.id, itemId: change.items![0]!.id, down };
}

test('downstream comes from the item’s subject by rule; the subject itself and the never-judged are left out', async () => {
  const { h, down } = await judged();
  assert.deepEqual(down.sort(), ['thread_down'], 'the work item downstream of the changed requirement');
  assert.equal(down.includes('ref_a'), false, 'an object is not downstream of its own item');
  assert.equal(down.includes('thread_done'), false, 'a Done work item is a point-in-time record');
  assert.equal(down.includes('ref_dec'), false, 'a decision gets the replacement check, not a propagation judgement');
  assert.equal(notJudgedReason(h.store, 'thread_done'), 'Point-in-time record');
  assert.equal(notJudgedReason(h.store, 'ref_dec'), 'Decision');
  assert.equal(notJudgedReason(h.store, 'thread_down'), null);
});

test('a point-in-time record and a decision are refused a judgement, each with what to do instead', async () => {
  const { h, changeId } = await judged();
  const done = await h.call('pk_judge_object', { nodeId: 'thread_done', state: 'Still on old understanding', sourceOrReason: 'it never followed', lacks: [{ changeId, what: 'the new R-1' }] });
  assert.equal(done.error, true, done.text);
  assert.match(done.text, /point-in-time record/);
  assert.match(done.text, /Judge instead the current object/);

  const decision = await h.call('pk_judge_object', { nodeId: 'ref_dec', state: 'Updated', sourceOrReason: 'x' });
  assert.equal(decision.error, true, decision.text);
  assert.match(decision.text, /replacement check/);
  assert.match(decision.text, /pk_check_decisions/);

  // The same refusal holds on the older per-pair tools, so nothing gets in around the back.
  const pair = await h.call('pk_set_propagation', { changeId, nodeId: 'thread_done', state: 'Reusable as is', sourceOrReason: 'closed' });
  assert.equal(pair.error, true, pair.text);
  assert.equal(h.store.propagation.all().length, 0, 'nothing was written');
});

test('one object gets one state per round, however many calls and changes reach it', async () => {
  const { h, changeId, itemId } = await judged();
  // A second piece of work reaches the same object.
  source(h.store, 'src_b', 'D:\\p\\B.md');
  const second = await h.call('pk_write_change', { ...work('sess-2', LATER, LATER), sourceIds: ['src_b'], items: [item('R-1 narrowed', { before: 'new R-1', after: 'narrower R-1', affects: ['ref_a'] })] });
  const secondId = second.json.id as string;
  const secondChange = h.store.changes.get(secondId)!;
  h.store.changes.put({ ...secondChange, propagation: [{ nodeId: 'thread_down', state: 'Not yet checked', sourceOrReason: '', updatedAt: LATER }] });

  const a = await h.call('pk_judge_object', { nodeId: 'thread_down', state: 'Updated', sourceOrReason: 'the work cites the new R-1', followed: [{ changeId, itemId }] });
  assert.equal(a.error, false, a.text);
  const b = await h.call('pk_judge_object', { nodeId: 'thread_down', state: 'Still on old understanding', sourceOrReason: 'it still names the wider R-1', lacks: [{ changeId: secondId, what: 'the narrowed R-1' }] });
  assert.equal(b.error, false, b.text);

  const states = h.store.propagation.all();
  assert.equal(states.length, 1, 'one object, one round, one state — not one per change');
  assert.equal(states[0]!.state, 'Still on old understanding', 'anything it still lacks decides the state');
  assert.equal(states[0]!.followed.length, 1);
  assert.deepEqual(states[0]!.lacks.map((l) => l.what), ['the narrowed R-1'], 'the state says which items it still lacks');
  assert.equal(states[0]!.covers.length, 2, 'and which records and items it covers');
  // The per-record entries follow from it, so the change's own detail agrees with the object's state.
  assert.equal(h.store.changes.get(changeId)!.propagation.find((p) => p.nodeId === 'thread_down')!.state, 'Updated');
  assert.equal(h.store.changes.get(secondId)!.propagation.find((p) => p.nodeId === 'thread_down')!.state, 'Still on old understanding');
});

test('"Still on old understanding" that names nothing is refused: it could never be checked', async () => {
  const { h, changeId } = await judged();
  const bare = await h.call('pk_judge_object', { nodeId: 'thread_down', state: 'Still on old understanding', sourceOrReason: 'it looks behind' });
  assert.equal(bare.error, true, bare.text);
  assert.match(bare.text, /never shown to an agent/);
  assert.match(bare.text, /List in lacks/);

  const empty = await h.call('pk_judge_object', { nodeId: 'thread_down', state: 'Still on old understanding', sourceOrReason: 'behind', lacks: [{ changeId, what: '  ' }] });
  assert.equal(empty.error, true, empty.text);
  assert.match(empty.text, /say what the object still has to follow/);
  assert.equal(h.store.propagation.all().length, 0);
});

test('an item left over from an earlier round waits until the object moves, and ends in one of three ways', async () => {
  const { h, changeId, itemId } = await judged();
  const round1 = startRound(h.store, 'p1', 'job_1', AT);
  h.ctx.roundId = round1.id;
  const behind = await h.call('pk_judge_object', { nodeId: 'thread_down', state: 'Still on old understanding', sourceOrReason: 'it still cites the old R-1', lacks: [{ changeId, itemId, what: 'the new R-1' }] });
  assert.equal(behind.error, false, behind.text);
  h.store.rounds.put({ ...round1, endedAt: AT });

  // Next round: the object has not moved, so the item is not judged again.
  const round2 = startRound(h.store, 'p1', 'job_2', LATER);
  h.ctx.jobId = 'job_2';
  h.ctx.roundId = round2.id;
  assert.equal(itemsOf(h.store.changes.get(changeId)!).length, 1);
  const stillOpen = await h.call('pk_judge_object', { nodeId: 'thread_down', state: 'Updated', sourceOrReason: 'x' });
  assert.equal(stillOpen.error, false, stillOpen.text);
  assert.equal(stillOpen.json.covers, 0, 'nothing to judge again while the object has not changed');
  assert.equal(stillOpen.json.wrote, false, 'and nothing is written: the earlier state stands');
  assert.match(String(stillOpen.json.note), /still lacking 1 item/);
  assert.equal(h.store.propagation.all().length, 1, 'no second judgement of an object nobody touched');
  assert.equal(objectPending(h.store, 'thread_down'), false, 'so it does not enter a batch either');

  // The object is edited: the item comes back and can be settled.
  h.store.threads.put({ ...h.store.threads.get('thread_down')!, results: 'rewritten against the new R-1', updatedAt: '2026-09-20T00:00:00.000Z' });
  const reopened = await h.call('pk_judge_object', { nodeId: 'thread_down', state: 'Updated', sourceOrReason: 'the work now cites the new R-1', followed: [{ changeId, itemId }] });
  assert.equal(reopened.error, false, reopened.text);
  assert.equal(reopened.json.covers, 1, 'the object changed, so the item is judged again');
  const state = h.store.propagation.get(`${round2.id}:thread_down`)!;
  assert.equal(state.state, 'Updated');
  assert.equal(state.lacks.length, 0, 'the item ended because the object followed it');

  // The other two ways an item ends, shown on an item that reached the object later: the item above has its
  // conclusion, and a concluded item is not judged again (§2.10, CKC-11 AC-12), so a close is for what is still open.
  h.store.rounds.put({ ...h.store.rounds.get(round2.id)!, endedAt: '2026-09-20T12:00:00.000Z' });
  const next = await h.call('pk_write_change', { ...work('sess-2'), sourceIds: ['src_a'], items: [item('R-1 narrowed', { before: 'new R-1', after: 'narrower R-1', affects: ['ref_a'] })] });
  assert.equal(next.error, false, next.text);
  const later = h.store.changes.all().find((c) => c.id !== changeId)!;
  const laterItem = later.items![0]!;
  h.store.changes.put({ ...later, propagation: downstreamOfItem(h.store, laterItem).map((nodeId) => ({ nodeId, state: 'Not yet checked' as const, sourceOrReason: '', updatedAt: AT })) });
  const round3 = startRound(h.store, 'p1', 'job_3', '2026-09-21T00:00:00.000Z');
  h.ctx.jobId = 'job_3';
  h.ctx.roundId = round3.id;
  // §2.10 lets the owner or the holder end an item, so who said so and where is part of the close itself.
  const closed = await h.call('pk_judge_object', {
    nodeId: 'thread_down', state: 'Reusable as is', sourceOrReason: 'the owner said it need not be handled',
    closed: [{ changeId: later.id, itemId: laterItem.id, close: 'No action needed', reason: 'the owner said so in the conversation', saidBy: 'owner', saidInSourceId: 'src_a' }],
  });
  assert.equal(closed.error, false, closed.text);
  assert.deepEqual(h.store.propagation.get(`${round3.id}:thread_down`)!.closed.map((c) => c.close), ['No action needed']);
  assert.deepEqual(h.store.propagation.get(`${round3.id}:thread_down`)!.closed[0]!.saidBy, { who: 'owner', role: null, sourceId: 'src_a' }, 'and who said so is recorded, so the close can be checked');
  assert.ok(!h.store.propagation.get(`${round3.id}:thread_down`)!.covers.some((c) => c.changeId === changeId && c.itemId === itemId), 'the item concluded in round 2 is not judged again');
  const bad = await h.call('pk_judge_object', { nodeId: 'thread_down', state: 'Updated', sourceOrReason: 'x', closed: [{ changeId: later.id, itemId: laterItem.id, close: 'Handled somehow', reason: 'y' }] });
  assert.equal(bad.error, true, bad.text);
  assert.match(bad.text, /Followed, Superseded by a later change, No action needed/);
});

test('an object changed in the same piece of work is still judged; being touched is only evidence', async () => {
  const h = harness();
  source(h.store, 'src_a', 'D:\\p\\A.md');
  reference(h.store, 'ref_a', 'Requirement', 'R-1');
  thread(h.store, 'thread_down', 'downstream work');
  relate(h.store, 'serves', 'thread_down', 'ref_a');
  const r = await h.call('pk_write_change', {
    ...work('sess-1'), sourceIds: ['src_a'],
    items: [
      item('R-1 rewritten', { before: 'old R-1', after: 'new R-1', affects: ['ref_a'] }),
      item('the work item re-scoped', { effect: 'Corrected', title: 'work re-scoped', before: 'wide', after: 'narrow', affects: ['thread_down'] }),
    ],
  });
  assert.equal(r.error, false, r.text);
  const items = h.store.changes.all()[0]!.items!;
  const forR1 = items.find((i) => i.affects.includes('ref_a'))!;
  assert.deepEqual(downstreamOfItem(h.store, forR1), ['thread_down'], 'it is downstream of the R-1 item even though the same work touched it');
  const ownItem = items.find((i) => i.affects.includes('thread_down'))!;
  assert.deepEqual(downstreamOfItem(h.store, ownItem), [], 'but it is not downstream of its own item');
});

// ───────────────────────── 3 · one result per round, by object and holder ─────────────────────────

test('a holder gets one request per round, however many of their objects are behind', async () => {
  const h = harness();
  source(h.store, 'src_a', 'D:\\p\\A.md');
  startRound(h.store, 'p1', 'job_1', AT);
  const first = await h.call('pk_write_modification_request', { holderRole: 'Product architect', what: 'update CKC-11 AC-14', why: 'D56 replaced the wording', basisSourceIds: ['src_a'], impact: ['ref_x'] });
  const second = await h.call('pk_write_modification_request', { holderRole: 'Product architect', what: 'update CKC-07 AC-5', why: 'D56 replaced the wording', basisSourceIds: ['src_a'], impact: ['ref_y'] });
  assert.equal(first.error, false, first.text);
  assert.equal(second.error, false, second.text);
  assert.equal(h.store.requests.all().length, 1, 'one holder, one request per round');
  assert.equal(second.json.id, first.json.id);
  const request = h.store.requests.all()[0]!;
  assert.deepEqual(request.lines!.map((l) => l.nodeId), ['ref_x', 'ref_y'], 'each object is one line of the one request');
  assert.deepEqual([...request.impact].sort(), ['ref_x', 'ref_y']);

  // A different holder is a different request; a later round starts a new one.
  await h.call('pk_write_modification_request', { holderRole: 'Main agent', what: 'update product.md', why: 'same', basisSourceIds: ['src_a'], impact: ['ref_z'] });
  assert.equal(h.store.requests.all().length, 2);
});

test('notes are written for a decision or a situation, never once per object that is behind', async () => {
  const { h, changeId } = await judged();
  h.store.judgements.put({ id: 'jdg_1', projectId: 'p1', jobId: 'job_1', at: AT, scope: { kind: 'project', ids: [], label: 'p' }, inputs: { referenceIds: [], threadIds: [], areaIds: [], relationIds: [], keyEvidenceSourceIds: [], conflictingSourceIds: [], previousNoteIds: [], investigations: [] }, excluded: [], outcome: { noteIds: [], assessments: [], reconsideredOnly: false } });
  await h.call('pk_judge_object', { nodeId: 'thread_down', state: 'Still on old understanding', sourceOrReason: 'still cites the old R-1', lacks: [{ changeId, what: 'the new R-1' }] });

  const repeat = await h.call('pk_write_note', { mountKind: 'node', mountIds: ['thread_down'], title: 'downstream work has not followed R-1', preview: 'It still cites the old R-1.', ask: 'For information', judgementRecordId: 'jdg_1', reason: 'follow-up' });
  assert.equal(repeat.error, true, repeat.text);
  assert.match(repeat.text, /no note per object that is behind/);
  assert.match(repeat.text, /modification request/);

  const decision = await h.call('pk_write_note', { mountKind: 'node', mountIds: ['thread_down'], title: 'Should the narrowed R-1 stand?', preview: 'Should the narrowed R-1 stand? The work assumed the wider R-1 throughout.', ask: 'For your decision', options: [{ option: 'Keep the narrowed R-1', then: 'the downstream work is redone against it' }, { option: 'Go back to the wider R-1', then: 'the work stands as it is and R-1 is edited back' }], judgementRecordId: 'jdg_1', reason: 'follow-up' });
  assert.equal(decision.error, false, decision.text);

  const twoQuestions = await h.call('pk_write_note', { mountKind: 'node', mountIds: ['thread_down'], title: 'Two at once?', preview: 'Should R-1 narrow? And should the plan move?', ask: 'For your decision', judgementRecordId: 'jdg_1', reason: 'follow-up' });
  assert.equal(twoQuestions.error, true, twoQuestions.text);
  assert.match(twoQuestions.text, /One question per note/);

  const duplicate = await h.call('pk_write_note', { mountKind: 'node', mountIds: ['thread_down'], title: 'Should the narrowed R-1 stand?', preview: 'again', ask: 'For your decision', judgementRecordId: 'jdg_1', reason: 'follow-up' });
  assert.equal(duplicate.error, true, duplicate.text);
  assert.match(duplicate.text, /already a current note on this mount/);
  assert.match(duplicate.text, /note_/);
  assert.equal(h.store.notes.all().length, 1);
});

test('the round’s one result carries only counts the program took from the assets', async () => {
  const { h, changeId } = await judged();
  const round = startRound(h.store, 'p1', 'job_1', AT);
  h.ctx.roundId = round.id;
  await h.call('pk_judge_object', { nodeId: 'thread_down', state: 'Still on old understanding', sourceOrReason: 'still cites the old R-1', lacks: [{ changeId, what: 'the new R-1' }] });
  await h.call('pk_write_modification_request', { holderRole: 'Product architect', what: 'update the work item', why: 'R-1 moved', basisSourceIds: ['src_a'], impact: ['thread_down'] });

  const tool = keeperTools(h.ctx).find((t) => t.name === 'pk_write_round_result')!;
  assert.deepEqual(Object.keys((tool.parameters as unknown as { properties: Record<string, unknown> }).properties).sort(), ['summary', 'unassigned'], 'the tool takes no numbers at all');

  const written = await h.call('pk_write_round_result', { summary: 'One work item is behind R-1; the architect has the request.' });
  assert.equal(written.error, false, written.text);
  const result = h.store.rounds.get(round.id)!.result!;
  assert.equal(result.counts.objectsJudged, 1);
  assert.equal(result.counts.behind, 1);
  assert.equal(result.counts.itemsLacked, 1);
  assert.equal(result.counts.requests, 1);
  assert.equal(result.counts.notJudged, h.store.changes.all().flatMap((c) => c.notJudged ?? []).length);
  assert.deepEqual(result.byHolder.map((b) => b.holder), ['Product architect']);
  assert.deepEqual(result.behind.map((b) => `${b.nodeId}/${b.holder}`), ['thread_down/Product architect'], 'each object behind is listed with who maintains it');
  assert.deepEqual(result.unassigned, [], 'nothing was left without a holder here');
  assert.equal(h.store.rounds.get(round.id)!.endedAt !== null, true, 'the round is closed by its one result');

  // An object nobody holds stays in the result, so it reaches whoever works on it later.
  thread(h.store, 'thread_orphan', 'work nobody holds');
  const round2 = startRound(h.store, 'p1', 'job_2', LATER);
  h.ctx.jobId = 'job_2';
  h.ctx.roundId = round2.id;
  const change = h.store.changes.get(changeId)!;
  h.store.changes.put({ ...change, propagation: [...change.propagation, { nodeId: 'thread_orphan', state: 'Not yet checked', sourceOrReason: '', updatedAt: LATER }] });
  await h.call('pk_judge_object', { nodeId: 'thread_orphan', state: 'Still on old understanding', sourceOrReason: 'it names the old R-1', lacks: [{ changeId, what: 'the new R-1' }] });
  await h.call('pk_write_round_result', { summary: 'One object is behind and has no holder.' });
  assert.deepEqual(h.store.rounds.get(round2.id)!.result!.unassigned, ['thread_orphan']);
});

// ───────────────────────── 4 · decisions get a replacement check ─────────────────────────

test('a new decision supersedes the old one, or hangs Suspected stale when it cannot be told', async () => {
  const h = harness();
  source(h.store, 'src_dec', 'D:\\p\\DECISIONS.md');
  reference(h.store, 'ref_d48', 'Decision', 'D48', { sourceIds: ['src_dec'] });
  reference(h.store, 'ref_d41', 'Decision', 'D41', { sourceIds: ['src_dec'] });
  reference(h.store, 'ref_d40', 'Decision', 'D40', { sourceIds: ['src_dec'] });
  reference(h.store, 'ref_d33', 'Decision', 'D33', { sourceIds: ['src_dec'] });
  reference(h.store, 'ref_d56', 'Decision', 'D56', { sourceIds: ['src_dec'] });

  const r = await h.call('pk_check_decisions', {
    newDecisionId: 'ref_d56',
    supersedes: [
      { decisionId: 'ref_d48', part: 'the pairwise propagation judgement', stated: true },
      { decisionId: 'ref_d41', part: 'what counts as one change', stated: false },
      { decisionId: 'ref_d40', part: 'the whole of it: nothing of D40 is left in force', stated: true, whole: true },
    ],
    unclear: [{ decisionId: 'ref_d33', clue: 'both speak about the graph’s top level, and neither says which wins', clueSourceIds: ['src_dec'] }],
  });
  assert.equal(r.error, false, r.text);

  // §5.5: 被取代的部分标 Replaced，指向新决定，其余不变 — a part going does not take the rest of the decision
  // with it, so what D56 did not touch in D48 stays in force and the objects following it stay right.
  assert.equal(h.store.reference.get('ref_d48')!.validity, 'Current', 'the rest of a partly superseded decision stays in force');
  assert.equal(h.store.reference.get('ref_d48')!.replacedBy, null, 'and it points at no replacement, because it was not replaced');
  assert.deepEqual(h.store.reference.get('ref_d48')!.supersededParts!.map((s) => `${s.byId}: ${s.part}`), ['ref_d56: the pairwise propagation judgement'], 'what went is recorded on it');
  const stated = h.store.relations.find((x) => x.type === 'replaces' && x.to === 'ref_d48')!;
  assert.equal(stated.basis, 'Explicit', 'the new decision says what it replaces');
  assert.match(stated.claim, /supersedes part of D48: the pairwise propagation judgement/, 'and the relation says which part');
  const inferred = h.store.relations.find((x) => x.type === 'replaces' && x.to === 'ref_d41')!;
  assert.equal(inferred.basis, 'Inferred', 'it only gave different content for the same matter');

  // A decision nothing of which is left is the other case, and it is the one that flips the validity.
  assert.equal(h.store.reference.get('ref_d40')!.validity, 'Replaced');
  assert.equal(h.store.reference.get('ref_d40')!.replacedBy, 'ref_d56');
  assert.deepEqual(r.json.replaced, ['ref_d40']);
  assert.deepEqual(r.json.partlySuperseded, ['ref_d48', 'ref_d41']);

  assert.equal(h.store.reference.get('ref_d33')!.validity, 'Current', 'what cannot be told keeps its validity');
  const mark = h.store.marks.find((m) => m.targetId === 'ref_d33')!;
  assert.equal(mark.kind, 'Suspected stale');
  assert.match(mark.clue, /neither says which wins/);

  const notADecision = await h.call('pk_check_decisions', { newDecisionId: 'ref_missing' });
  assert.equal(notADecision.error, true, notADecision.text);
});

test('an object still working to a superseded decision is judged as usual', async () => {
  const h = harness();
  source(h.store, 'src_dec', 'D:\\p\\DECISIONS.md');
  reference(h.store, 'ref_old', 'Decision', 'D48', { sourceIds: ['src_dec'] });
  reference(h.store, 'ref_new', 'Decision', 'D56', { sourceIds: ['src_dec'] });
  thread(h.store, 'thread_follows', 'work built on D48');
  relate(h.store, 'serves', 'thread_follows', 'ref_old');
  await h.call('pk_check_decisions', { newDecisionId: 'ref_new', supersedes: [{ decisionId: 'ref_old', part: 'all of it', stated: true, whole: true }] });

  assert.equal(notJudgedReason(h.store, 'ref_old'), 'Point-in-time record', 'the superseded decision is not judged');
  assert.equal(notJudgedReason(h.store, 'thread_follows'), null, 'but what still works to it is');

  // The supersession is a change whose subject is the old decision; the work downstream of it is judged as usual.
  const written = await h.call('pk_write_change', {
    ...work('sess-1'), sourceIds: ['src_dec'],
    items: [item('D56 replaces D48', { before: 'pairwise propagation', after: 'one judgement per object', affects: ['ref_old'] })],
  });
  assert.equal(written.error, false, written.text);
  const change = h.store.changes.all()[0]!;
  assert.deepEqual(downstreamOfItem(h.store, change.items![0]!), ['thread_follows'], 'the work written to the old decision is downstream');
  h.store.changes.put({ ...change, propagation: [{ nodeId: 'thread_follows', state: 'Not yet checked', sourceOrReason: '', updatedAt: AT }] });

  const judgement = await h.call('pk_judge_object', {
    nodeId: 'thread_follows', state: 'Still on old understanding', sourceOrReason: 'its results are written to D48',
    lacks: [{ changeId: change.id, what: 'the one-judgement-per-object rule of D56' }],
  });
  assert.equal(judgement.error, false, judgement.text);
  assert.equal(h.store.propagation.all()[0]!.state, 'Still on old understanding');
  assert.equal(h.store.propagation.all().length, 1, 'the decision itself got no judgement, only the work still using it');
});

// ───────────────────────── 5 · where a mark may hang ─────────────────────────

test('a mark hangs on an object that can be checked, never on a judgement or on a record of its own time', async () => {
  const { h } = await judged();
  h.store.judgements.put({ id: 'jdg_1', projectId: 'p1', jobId: 'job_1', at: AT, scope: { kind: 'project', ids: [], label: 'p' }, inputs: { referenceIds: [], threadIds: [], areaIds: [], relationIds: [], keyEvidenceSourceIds: [], conflictingSourceIds: [], previousNoteIds: [], investigations: [] }, excluded: [], outcome: { noteIds: [], assessments: [], reconsideredOnly: false } });
  await h.call('pk_write_note', { mountKind: 'node', mountIds: ['ref_a'], title: 'R-1 is wide', preview: 'x', ask: 'Worth discussing', whyItMatters: 'it drives three plans', judgementRecordId: 'jdg_1', reason: 'first' });
  const noteId = h.store.notes.all()[0]!.id;

  const onNote = await h.call('pk_write_mark', { kind: 'Suspected stale', targetId: noteId, clue: 'the note predates D56', clueSourceIds: ['src_a'] });
  assert.equal(onNote.error, true, onNote.text);
  assert.match(onNote.text, /does not hang on a note/);

  const good = await h.call('pk_write_mark', { kind: 'Suspected stale', targetId: 'ref_a', clue: 'R-1 still describes the tag browser, which Search replaced', clueSourceIds: ['src_a'] });
  assert.equal(good.error, false, good.text);
  const markId = good.json.id as string;
  const onMark = await h.call('pk_write_mark', { kind: 'Layer drift', targetId: markId, clue: 'the mark itself looks out of date', clueSourceIds: ['src_a'] });
  assert.equal(onMark.error, true, onMark.text);
  assert.match(onMark.text, /does not hang on another mark/);
  assert.match(onMark.text, /update the clue of the mark that is already there/);

  // The same doubt again updates the one mark instead of making a second.
  const again = await h.call('pk_write_mark', { kind: 'Suspected stale', targetId: 'ref_a', clue: 'R-1 still describes the tag browser, and PLAN.md now says Search', clueSourceIds: ['src_a'] });
  assert.equal(again.error, false, again.text);
  assert.equal(h.store.marks.all().length, 1);
  assert.match(h.store.marks.all()[0]!.clue, /PLAN\.md now says Search/);

  // A point-in-time record does not get Suspected stale because of a later change.
  const later = await h.call('pk_write_mark', { kind: 'Suspected stale', targetId: 'thread_done', clue: 'R-1 moved after this work finished', clueSourceIds: ['src_a'] });
  assert.equal(later.error, true, later.text);
  assert.match(later.text, /Hang it on the current object that still uses the old content/);
  const drift = await h.call('pk_write_mark', { kind: 'Layer drift', targetId: 'thread_done', clue: 'the plan moved after it', clueSourceIds: ['src_a'] });
  assert.equal(drift.error, true, drift.text);

  // A doubt about whether it was true at its own time is still allowed.
  const ownTime = await h.call('pk_write_mark', { kind: 'Suspected stale', targetId: 'thread_done', clue: 'the material says done, but the test report of the same day fails', clueSourceIds: ['src_a'], about: 'At its own time' });
  assert.equal(ownTime.error, false, ownTime.text);
  assert.equal(h.store.marks.filter((m) => m.targetId === 'thread_done').length, 1);
});

test('a mark that names neither what differs nor what it was checked against is refused', async () => {
  const { h } = await judged();
  const noClue = await h.call('pk_write_mark', { kind: 'Suspected stale', targetId: 'ref_a', clue: '', clueSourceIds: ['src_a'] });
  assert.equal(noClue.error, true, noClue.text);
  assert.match(noClue.text, /cannot be checked does not exist/);
  assert.match(noClue.text, /Add clue/);

  const noSource = await h.call('pk_write_mark', { kind: 'Layer drift', targetId: 'ref_a', clue: 'the plan and the work disagree', clueSourceIds: [] });
  assert.equal(noSource.error, true, noSource.text);
  assert.match(noSource.text, /clueSourceIds/);
  // Checked against something that is not a source: the pack could not cite it, and the mark would still read as checked.
  const notASource = await h.call('pk_write_mark', { kind: 'Layer drift', targetId: 'ref_a', clue: 'the plan and the work disagree', clueSourceIds: ['src_a', 'commit:abc123'] });
  assert.equal(notASource.error, true, notASource.text);
  assert.match(notASource.text, /not a source of this project: commit:abc123/);
  assert.equal(h.store.marks.all().length, 0);
});

// ───────────────────────── 6 · an execution batch is not a work item ─────────────────────────

test('an execution batch is recorded as the progress of the work items it carries out', async () => {
  const h = harness();
  thread(h.store, 'thread_ckc06', 'CKC-06 layered facts');
  thread(h.store, 'thread_ckc07', 'CKC-07 continuous intake');
  source(h.store, 'src_receipt', 'D:\\p\\receipts\\B3.md');
  const before = h.store.threads.all().length;

  // What the batch says it did is its claim, with who and when (Spec §2.4; batch C2 changed this call from results
  // alone, which was kept as an Observed statement without a source).
  const r = await h.call('pk_write_thread', {
    title: 'B3 · rules layer', progress: 'Done', results: 'both contracts implemented and merged',
    carriesOut: ['thread_ckc06', 'thread_ckc07'],
    executionFacts: [{ type: 'Claimed', text: 'Both contracts are implemented and merged.', sourceIds: ['src_receipt'], claimedBy: 'Worker agent, B3 receipt', claimedAt: '2026-09-17' }],
  });
  assert.equal(r.error, false, r.text);
  assert.equal(h.store.threads.all().length, before, 'no work item is created for the batch');
  assert.match(r.text, /not a work item of its own/);
  for (const id of ['thread_ckc06', 'thread_ckc07']) {
    const t = h.store.threads.get(id)!;
    assert.equal(t.progress, 'Done', 'the batch’s progress lands on the work it carried out');
    assert.ok(t.executionFacts.some((f) => f.text.includes('B3 · rules layer') && f.type === 'Claimed'), 'and says which batch it came from, as that batch’s claim');
  }

  const unknown = await h.call('pk_write_thread', { title: 'B4', progress: 'Planned', carriesOut: ['thread_missing'] });
  assert.equal(unknown.error, true, unknown.text);

  // A work item that serves another work item is the same mistake, seen from the relation.
  reference(h.store, 'ref_area', 'Area', 'Rules');
  const rel = await h.call('pk_relate', { type: 'implements', fromId: 'thread_ckc06', toId: 'thread_ckc07', claim: 'B3 implements it', basis: 'Inferred' });
  assert.equal(rel.error, false, rel.text);
  assert.match(String(rel.json.warning ?? ''), /execution batch is not a work item of its own/);
});

/**
 * D56 rule 2, the part that is easy to get backwards: an object another item of the same piece of work changed is
 * still judged when it lies downstream of this item. That the work touched it is evidence, not a conclusion.
 */
test('an object changed by another item of the same work is still judged', async () => {
  const h = harness();
  source(h.store, 'src_spec', 'D:\p\SPEC.md');
  reference(h.store, 'ref_area', 'Area', 'A-1');
  reference(h.store, 'ref_req', 'Requirement', 'R-1', { refines: ['ref_area'] });
  thread(h.store, 'thread_w', 'W-1', { serves: [{ referenceId: 'ref_req', claim: 'serves R-1', basis: 'Explicit' }] });
  relate(h.store, 'refines', 'ref_req', 'ref_area');
  relate(h.store, 'serves', 'thread_w', 'ref_req');

  // One session: the area changed, and R-1 — which refines it — was rewritten in the same session.
  const written = await h.call('pk_write_change', {
    ...work('One session, two changes'), sourceIds: ['src_spec'],
    items: [item('The area changed', { affects: ['ref_area'] }), item('R-1 rewritten', { effect: 'Corrected', affects: ['ref_req'], after: 'the new wording' })],
  });
  assert.equal(written.error, false, written.text);
  const change = h.store.changes.all()[0]!;
  const { judged } = downstreamOfChange(h.store, change);
  const reached = judged.map((j) => j.nodeId);
  assert.ok(reached.includes('ref_req'), 'R-1 is downstream of the area item and is judged, although the same work changed it');
  assert.ok(reached.includes('thread_w'), 'and so is the work item under it');
});
