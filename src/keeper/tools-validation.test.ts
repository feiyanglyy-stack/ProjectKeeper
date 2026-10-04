/**
 * What the pk_* tools refuse to write (Spec §2.1, §2.10, §5.5, §7.1). Three rules an independent review found the
 * tools letting through: a decision superseded in part was written as superseded whole and against no timeline, an
 * item reference nobody could check passed validation and was then dropped inside, and an item was closed on a
 * reason no program could verify. Each is a bad write, so each is tested where the write is refused.
 *
 * The harness is the one of adjustment-rules.test.ts, kept local: a test file that imports another test file runs
 * its tests a second time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { keeperTools, type ToolContext } from './tools.ts';
import { downstreamOfItem } from './adjustment.ts';
import type { GraphRelation, KeeperJob, Project, ReferenceItem, Source, WorkThread } from '../model/types.ts';

const AT = '2026-09-18T00:00:00.000Z';
const LATER = '2026-09-19T00:00:00.000Z';

interface Harness {
  readonly store: ProjectStore;
  readonly ctx: ToolContext;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean; json: Record<string, unknown> }>;
}

function harness(): Harness {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-validation-')));
  const project = { id: 'p1', name: 'P', language: 'en', locations: ['D:\\p'], scope: [], roles: ['Product architect'] } as unknown as Project;
  store.jobs.put({
    id: 'job_1', projectId: 'p1', kind: 'Organizing', initiator: 'auto', scope: { kind: 'round', ids: [], label: 'job_1' }, status: 'Running', queuedAt: AT, startedAt: AT, endedAt: null,
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

/** A session segment, which is the one kind of source that carries the time its material happened at. */
const sessionSource = (store: ProjectStore, id: string, at: string) =>
  store.sources.put({ id, projectId: 'p1', title: `session ${id}`, anchor: { kind: 'session', host: 'claude', sessionId: id, file: `D:\\s\\${id}.jsonl`, cwd: null, messageStart: 1, messageEnd: 9, at }, ids: [], version: { fingerprint: 'f', readAt: at, commit: null }, excerpt: 'x', usedAs: 'Session', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: 'scope', hasCredential: false, bytes: 10 } as Source);

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

// ───────────────────────── A · the replacement check writes only what it may ─────────────────────────

test('a decision that is not in force is not superseded: the check says which validity and what to do first', async () => {
  const h = harness();
  source(h.store, 'src_dec', 'D:\\p\\DECISIONS.md');
  reference(h.store, 'ref_draft', 'Decision', 'D50 (draft)', { sourceIds: ['src_dec'], validity: 'Proposed' });
  reference(h.store, 'ref_gone', 'Decision', 'D30', { sourceIds: ['src_dec'], validity: 'Replaced', replacedBy: 'ref_new' });
  reference(h.store, 'ref_new', 'Decision', 'D56', { sourceIds: ['src_dec'] });

  const draft = await h.call('pk_check_decisions', { newDecisionId: 'ref_new', supersedes: [{ decisionId: 'ref_draft', part: 'the layer count', stated: true }] });
  assert.equal(draft.error, true, draft.text);
  assert.match(draft.text, /Proposed/);
  assert.match(draft.text, /never in force/);
  assert.equal(h.store.reference.get('ref_draft')!.validity, 'Proposed', 'a proposal is not turned into a Replaced decision');
  assert.equal(h.store.reference.get('ref_draft')!.replacedBy, null);

  const gone = await h.call('pk_check_decisions', { newDecisionId: 'ref_new', supersedes: [{ decisionId: 'ref_gone', part: 'the same matter again', stated: true }] });
  assert.equal(gone.error, true, gone.text);
  assert.match(gone.text, /already Replaced/);
  assert.equal(h.store.relations.all().length, 0, 'and neither call left a replaces relation behind');

  // The same gate holds on the other list: a mark saying "this may have been superseded" belongs on a decision
  // that is still in force, not on one that has already gone.
  const unclear = await h.call('pk_check_decisions', { newDecisionId: 'ref_new', unclear: [{ decisionId: 'ref_gone', clue: 'both speak about the same matter', clueSourceIds: ['src_dec'] }] });
  assert.equal(unclear.error, true, unclear.text);
  assert.equal(h.store.marks.all().length, 0);

  // And the mirror: a decision nobody has adopted supersedes nothing, however current the decision it names.
  reference(h.store, 'ref_current', 'Decision', 'D41', { sourceIds: ['src_dec'] });
  const fromDraft = await h.call('pk_check_decisions', { newDecisionId: 'ref_draft', supersedes: [{ decisionId: 'ref_current', part: 'the layer count', stated: true }] });
  assert.equal(fromDraft.error, true, fromDraft.text);
  assert.match(fromDraft.text, /A proposal is a candidate/);
  assert.equal(h.store.reference.get('ref_current')!.validity, 'Current');
  assert.equal(h.store.reference.get('ref_current')!.supersededParts, undefined, 'a candidate took no part of a decision in force');
});

test('a decision is superseded only by a later one, and the check names the field it read the times from', async () => {
  const h = harness();
  sessionSource(h.store, 'src_sep18', AT);
  sessionSource(h.store, 'src_sep19', LATER);
  reference(h.store, 'ref_earlier', 'Decision', 'D48', { sourceIds: ['src_sep18'] });
  reference(h.store, 'ref_later', 'Decision', 'D56', { sourceIds: ['src_sep19'] });

  const backwards = await h.call('pk_check_decisions', { newDecisionId: 'ref_earlier', supersedes: [{ decisionId: 'ref_later', part: 'the one-judgement-per-object rule', stated: false }] });
  assert.equal(backwards.error, true, backwards.text);
  assert.match(backwards.text, /not older than/);
  assert.match(backwards.text, /the session its material comes from \(src_sep19/, 'the refusal says which recorded time it compared');
  assert.equal(h.store.reference.get('ref_later')!.validity, 'Current', 'the later decision is left alone');
  assert.equal(h.store.reference.get('ref_later')!.supersededParts, undefined);
  assert.equal(h.store.relations.all().length, 0);

  // The same pair the right way round is the ordinary case and goes through.
  const forwards = await h.call('pk_check_decisions', { newDecisionId: 'ref_later', supersedes: [{ decisionId: 'ref_earlier', part: 'the pairwise judgement', stated: false }] });
  assert.equal(forwards.error, false, forwards.text);
  assert.deepEqual(forwards.json.partlySuperseded, ['ref_earlier']);
});

test('one decision is either superseded or unclear, and a call that says both writes nothing', async () => {
  const h = harness();
  source(h.store, 'src_dec', 'D:\\p\\DECISIONS.md');
  reference(h.store, 'ref_old', 'Decision', 'D48', { sourceIds: ['src_dec'] });
  reference(h.store, 'ref_new', 'Decision', 'D56', { sourceIds: ['src_dec'] });

  const both = await h.call('pk_check_decisions', {
    newDecisionId: 'ref_new',
    supersedes: [{ decisionId: 'ref_old', part: 'the pairwise judgement', stated: true }],
    unclear: [{ decisionId: 'ref_old', clue: 'it may be about something else entirely', clueSourceIds: ['src_dec'] }],
  });
  assert.equal(both.error, true, both.text);
  assert.match(both.text, /both as superseded and as unclear/);
  assert.equal(h.store.reference.get('ref_old')!.supersededParts, undefined, 'nothing was written before the contradiction was found');
  assert.equal(h.store.marks.all().length, 0);
  assert.equal(h.store.relations.all().length, 0);
});

// ───────────────────────── B · an item reference the judgement cannot keep ─────────────────────────

/** One requirement changed by one piece of work, with the work item downstream of it waiting to be judged. */
async function reached() {
  const h = harness();
  source(h.store, 'src_a', 'D:\\p\\A.md');
  reference(h.store, 'ref_a', 'Requirement', 'R-1');
  thread(h.store, 'thread_down', 'downstream work');
  relate(h.store, 'serves', 'thread_down', 'ref_a');
  const r = await h.call('pk_write_change', { ...work('sess-1'), sourceIds: ['src_a'], items: [item('R-1 rewritten', { before: 'old R-1', after: 'new R-1', affects: ['ref_a'] })] });
  assert.equal(r.error, false, r.text);
  const change = h.store.changes.all()[0]!;
  h.store.changes.put({ ...change, propagation: downstreamOfItem(h.store, change.items![0]!).map((nodeId) => ({ nodeId, state: 'Not yet checked' as const, sourceOrReason: '', updatedAt: AT })) });
  return { h, changeId: change.id, itemId: change.items![0]!.id };
}

test('an item id that did not reach the object is refused, with the item ids that did', async () => {
  const { h, changeId, itemId } = await reached();
  const typo = await h.call('pk_judge_object', {
    nodeId: 'thread_down', state: 'Still on old understanding', sourceOrReason: 'it still cites the old R-1',
    lacks: [{ changeId, itemId: `${itemId}x`, what: 'the new R-1' }],
  });
  assert.equal(typo.error, true, typo.text);
  assert.match(typo.text, /is not one of its items that did/);
  assert.ok(typo.text.includes(itemId), 'the refusal lists the item that did reach the object');
  assert.equal(h.store.propagation.all().length, 0, 'and no state was written that nobody could check');

  // Naming the item that did reach it is the ordinary case.
  const good = await h.call('pk_judge_object', {
    nodeId: 'thread_down', state: 'Still on old understanding', sourceOrReason: 'it still cites the old R-1',
    lacks: [{ changeId, itemId, what: 'the new R-1' }],
  });
  assert.equal(good.error, false, good.text);
  assert.equal(h.store.propagation.all()[0]!.lacks.length, 1);
});

test('"Still on old understanding" is refused when nothing it lacks reached the object', async () => {
  const { h, changeId, itemId } = await reached();
  // A second piece of work that never reached this object: it has no propagation entry for it.
  source(h.store, 'src_b', 'D:\\p\\B.md');
  reference(h.store, 'ref_elsewhere', 'Requirement', 'R-9');
  const other = await h.call('pk_write_change', { ...work('sess-2', LATER, LATER), sourceIds: ['src_b'], items: [item('R-9 rewritten', { at: LATER, before: 'old R-9', after: 'new R-9', affects: ['ref_elsewhere'] })] });
  assert.equal(other.error, false, other.text);

  const behind = await h.call('pk_judge_object', {
    nodeId: 'thread_down', state: 'Still on old understanding', sourceOrReason: 'it looks behind',
    followed: [{ changeId, itemId }],
    lacks: [{ changeId: other.json.id as string, what: 'the new R-9' }],
  });
  assert.equal(behind.error, true, behind.text);
  assert.match(behind.text, /None of the 1 item in lacks reached thread_down/);
  assert.match(behind.text, /The items to judge here are/);
  assert.equal(h.store.propagation.all().length, 0, 'nothing behind is recorded with an empty list of what it lacks');
});

// ───────────────────────── C · what ends an item has to be checkable ─────────────────────────

test('an item closed as superseded names the later change, and the change has to be later', async () => {
  const { h, changeId, itemId } = await reached();
  source(h.store, 'src_b', 'D:\\p\\B.md');
  const later = await h.call('pk_write_change', { ...work('sess-2', LATER, LATER), sourceIds: ['src_b'], items: [item('R-1 rewritten again', { at: LATER, before: 'new R-1', after: 'newer R-1', affects: ['ref_a'] })] });
  assert.equal(later.error, false, later.text);
  const laterId = later.json.id as string;

  const unnamed = await h.call('pk_judge_object', {
    nodeId: 'thread_down', state: 'Reusable as is', sourceOrReason: 'a later change took it over',
    closed: [{ changeId, itemId, close: 'Superseded by a later change', reason: 'a later piece of work rewrote it again' }],
  });
  assert.equal(unnamed.error, true, unnamed.text);
  assert.match(unnamed.text, /does not say which change that is/);

  const wrongWay = await h.call('pk_judge_object', {
    nodeId: 'thread_down', state: 'Reusable as is', sourceOrReason: 'a later change took it over',
    closed: [{ changeId: laterId, close: 'Superseded by a later change', reason: 'the earlier work took it over', supersededByChangeId: changeId }],
  });
  assert.equal(wrongWay.error, true, wrongWay.text);
  assert.match(wrongWay.text, /cannot supersede it/);
  assert.equal(h.store.propagation.all().length, 0);

  // Named, and really later: the item ends and the record that took it over is on the entry.
  const change = h.store.changes.get(laterId)!;
  h.store.changes.put({ ...change, propagation: [{ nodeId: 'thread_down', state: 'Not yet checked', sourceOrReason: '', updatedAt: LATER }] });
  const closed = await h.call('pk_judge_object', {
    nodeId: 'thread_down', state: 'Reusable as is', sourceOrReason: 'the later rewrite took it over',
    closed: [{ changeId, itemId, close: 'Superseded by a later change', reason: 'sess-2 rewrote R-1 again', supersededByChangeId: laterId }],
  });
  assert.equal(closed.error, false, closed.text);
  assert.equal(h.store.propagation.all()[0]!.closed[0]!.supersededByChangeId, laterId);
});

test('an item closed as needing no action names who said so and where, or it is refused', async () => {
  const { h, changeId, itemId } = await reached();
  const close = (extra: Record<string, unknown>) => h.call('pk_judge_object', {
    nodeId: 'thread_down', state: 'Reusable as is', sourceOrReason: 'nobody has to handle it',
    closed: [{ changeId, itemId, close: 'No action needed', ...extra }],
  });

  const noReason = await close({ reason: '  ' });
  assert.equal(noReason.error, true, noReason.text);
  assert.match(noReason.text, /reason is empty/);

  const noWho = await close({ reason: 'it need not be handled' });
  assert.equal(noWho.error, true, noWho.text);
  assert.match(noWho.text, /does not say who said so/);

  const noSource = await close({ reason: 'it need not be handled', saidBy: 'Product architect' });
  assert.equal(noSource.error, true, noSource.text);
  assert.match(noSource.text, /names no material that shows it/);

  const unknownSource = await close({ reason: 'it need not be handled', saidBy: 'owner', saidInSourceId: 'src_nowhere' });
  assert.equal(unknownSource.error, true, unknownSource.text);
  assert.match(unknownSource.text, /names no source in the assets/);
  assert.equal(h.store.propagation.all().length, 0, 'none of the four wrote a close nobody could check');

  const good = await close({ reason: 'the holder says the work was dropped', saidBy: 'Product architect', saidInSourceId: 'src_a' });
  assert.equal(good.error, false, good.text);
  assert.deepEqual(h.store.propagation.all()[0]!.closed[0]!.saidBy, { who: 'holder', role: 'Product architect', sourceId: 'src_a' });
});
