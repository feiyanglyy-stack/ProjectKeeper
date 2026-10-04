/**
 * Merging duplicate work items (Spec §1.4; CKC-06 AC-28; subagent/DECISIONS.md E64, E65). The main job merges what
 * turned out to be one unit of work at the end of its round: the merged one points to the one kept, its sources,
 * facts and relations move over, it no longer shows on its own anywhere, and its id still reaches the one kept. It is
 * not written as `Replaced`: that is the history of something superseded, and using it here would blur that signal.
 *
 * The fixtures are an invented project, "Ledger", a small invoicing tool; the harness is the local one of
 * tools-validation.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { keeperTools, type ToolContext } from './tools.ts';
import { deriveGraph } from './organize/graph.ts';
import { graphView } from '../server/graph-view.ts';
import { assembleContext } from '../context/assemble.ts';
import type { AreaUnderstanding, ChangeRecord, ContextRequest, EntryMark, FactRecord, GraphRelation, Note, ObjectJudgement, Project, ReferenceItem, Source, WorkThread } from '../model/types.ts';

const AT = '2026-09-17T00:00:00.000Z';

function harness() {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-merge-')));
  const project = { id: 'p1', name: 'Ledger', language: 'en', locations: ['D:\\ledger'], scope: [], roles: [] } as unknown as Project;
  const ctx: ToolContext = { store, project, jobId: 'job_main', jobKind: 'Organizing', model: null };
  const tools = keeperTools(ctx);
  return {
    store, project,
    async call(name: string, args: Record<string, unknown>) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `no tool ${name}`);
      const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
      const result = await run('call', args);
      const text = result.content.map((c) => c.text).join('\n');
      let json: unknown = {};
      try { json = JSON.parse(text); } catch { /* a refusal is prose */ }
      return { text, error: result.isError === true, json: json as Record<string, unknown> & unknown[] };
    },
  };
}

const source = (store: ProjectStore, id: string, path: string, usedAs = 'Design') =>
  store.sources.put({ id, projectId: 'p1', title: path.split('\\').pop()!, anchor: { kind: 'file', path, headingPath: [], lineStart: 1, lineEnd: 9 }, ids: [], version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt: 'x', usedAs, usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: 'scope', hasCredential: false, bytes: 10 } as Source);
const reference = (store: ProjectStore, id: string, category: string, name: string, extra: Partial<ReferenceItem> = {}) =>
  store.reference.put({ id, projectId: 'p1', category, name, ids: [], text: name, quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: { author: { kind: 'owner', name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' }, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT, ...extra } as ReferenceItem);
const inputs = { jobId: 'j', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' };
const thread = (store: ProjectStore, id: string, title: string, extra: Partial<WorkThread> = {}) =>
  store.threads.put({ id, projectId: 'p1', title, ids: [], doing: title, changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, inputs, asOf: AT, updatedAt: AT, pendingSourceIds: [], ...extra } as WorkThread);
const fact = (store: ProjectStore, id: string, about: string) =>
  store.facts.put({ id, projectId: 'p1', title: `Facts from ${about}`, aboutSourceIds: [about], statements: [], decisions: [], changes: [], openQuestions: [], executionFacts: [], language: 'en', inputs, asOf: AT, updatedAt: AT, pendingSourceIds: [] } as FactRecord);
const relation = (store: ProjectStore, id: string, type: string, from: string, to: string) =>
  store.relations.put({ id, projectId: 'p1', type, from, to, claim: `${from} ${type} ${to}`, basis: 'Explicit', evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' }, assessment: 'Holds', assessedAt: AT, assessedInJobId: null, updatedAt: AT } as GraphRelation);

/** L-4 written twice: once from the task index, once from a batch report that never named its number. */
function duplicated() {
  const h = harness();
  const { store } = h;
  source(store, 'src_tasks', 'D:\\ledger\\docs\\TASKS.md', 'Plan');
  source(store, 'src_report', 'D:\\ledger\\reports\\batch-2.md', 'Status');
  source(store, 'src_code', 'D:\\ledger\\src\\export.ts', 'Code');
  reference(store, 'ref_area', 'Area', 'A1 · Exports');
  reference(store, 'ref_dec', 'Decision', 'D5 · the old CSV export goes with the next release', {
    carryOut: { status: 'Partly carried out', remaining: 'the settings page', workIds: ['thread_b'], evidenceSourceIds: ['src_code'], at: AT, jobId: 'j' },
  });
  fact(store, 'fact_a', 'src_tasks');
  fact(store, 'fact_b', 'src_report');
  thread(store, 'thread_a', 'L-4 · export invoices', { ids: ['L-4'], factRecordIds: ['fact_a'], serves: [{ referenceId: 'ref_area', claim: 'exports are part of A1', basis: 'Explicit' }] });
  thread(store, 'thread_b', 'Invoice export (batch 2 notes)', {
    ids: ['BATCH2-EXPORT'], factRecordIds: ['fact_b'], results: 'exports run nightly',
    serves: [{ referenceId: 'ref_area', claim: 'batch 2 built the export', basis: 'Inferred' }],
    executionFacts: [{ id: 'st_1', type: 'Observed', text: 'The nightly export job ran on 2026-09-16.', sourceIds: ['src_report'] }],
  });
  thread(store, 'thread_next', 'L-9 · export reminders', { ids: ['L-9'], dependsOn: [{ threadId: 'thread_b', claim: 'needs the export', basis: 'Explicit' }] });
  relation(store, 'rel_code', 'implements', 'src_code', 'thread_b');
  store.areas.put({ id: 'area_1', projectId: 'p1', referenceId: 'ref_area', effectNow: 'Invoices export nightly.', gaps: 'No reminders yet.', contributions: [{ threadId: 'thread_b', claim: 'the export', basis: 'Inferred' }], inputs, asOf: AT, updatedAt: AT, pendingSourceIds: [] } as AreaUnderstanding);
  store.notes.put({ id: 'note_b', projectId: 'p1', mount: { kind: 'node', ids: ['thread_b'] }, status: 'Current', ownerResponse: null, versions: [{ version: 1, at: AT, title: 'The export has no owner review yet', preview: 'Nobody reviewed the export.', body: { currentView: null, whyItMatters: null, facts: [], otherExplanations: null, keepAdjust: null, whatWouldSettleIt: null }, ask: 'For information', judgementRecordId: 'jdg_1', reason: 'first' }], discussion: [], followUps: [], author: { agent: 'pi', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, language: 'en', updatedAt: AT } as Note);
  store.marks.put({ id: 'mark_b', projectId: 'p1', kind: 'Suspected stale', targetId: 'thread_b', clueSourceIds: ['src_report'], clue: 'the report says done, the task index says in progress', since: AT, noteId: null, closed: null } as EntryMark);
  store.changes.put({
    id: 'chg_1', projectId: 'p1', at: AT, atSource: 'material', material: 'Status report', effect: 'Completed', title: 'Batch 2 finished the export', summary: 'the export runs nightly',
    before: null, after: null, sourceIds: ['src_report'], by: { author: { kind: 'role', name: 'Worker', window: null, host: null, model: null }, holder: null, identity: 'Report' },
    affects: ['thread_b'], propagation: [{ nodeId: 'thread_next', state: 'Not yet checked', sourceOrReason: '', updatedAt: AT }], segment: null, createdInJobId: null, updatedAt: AT,
    items: [{ id: 'item_1', at: AT, atSource: 'material', material: 'Status report', effect: 'Completed', title: 'export finished', summary: 'runs nightly', before: null, after: null, sourceIds: ['src_report'], by: { author: { kind: 'role', name: 'Worker', window: null, host: null, model: null }, holder: null, identity: 'Report' }, why: null, affects: ['thread_b'] }],
  } as ChangeRecord);
  store.changes.put({
    id: 'chg_2', projectId: 'p1', at: AT, atSource: 'material', material: 'Decision', effect: 'Replaced', title: 'A1 now includes reminders', summary: 'reminders join the export area',
    before: 'exports only', after: 'exports and reminders', sourceIds: ['src_tasks'], by: { author: { kind: 'owner', name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' },
    affects: ['ref_area'], propagation: [{ nodeId: 'thread_b', state: 'Still on old understanding', sourceOrReason: 'the batch 2 export ignores reminders', updatedAt: AT, roundId: 'round_0001', itemIds: [''] }], segment: null, createdInJobId: null, updatedAt: AT,
  } as ChangeRecord);
  store.propagation.put({ id: 'round_0001:thread_b', projectId: 'p1', nodeId: 'thread_b', roundId: 'round_0001', state: 'Still on old understanding', sourceOrReason: 'the batch 2 export ignores reminders', covers: [{ changeId: 'chg_2', itemId: '' }], followed: [], lacks: [{ changeId: 'chg_2', itemId: '', what: 'reminders join the export area' }], closed: [], objectUpdatedAt: AT, jobId: 'j', at: AT } as ObjectJudgement);
  deriveGraph(store, h.project);
  return h;
}

const MERGE = { keepId: 'thread_a', mergeIds: ['thread_b'], reason: 'The batch 2 notes describe L-4, the task index’s export task; they are one unit of work.', sourceIds: ['src_tasks', 'src_report'] };

test('a work item is never merged into itself or in a circle, and a merge says why (CKC-06 AC-28)', async () => {
  const h = duplicated();
  const itself = await h.call('pk_merge_work_items', { ...MERGE, mergeIds: ['thread_a'] });
  assert.equal(itself.error, true, itself.text);
  assert.match(itself.text, /into itself/);
  const unknown = await h.call('pk_merge_work_items', { ...MERGE, mergeIds: ['thread_nowhere'] });
  assert.equal(unknown.error, true, unknown.text);
  assert.match(unknown.text, /is not a work item in the assets/);
  const noReason = await h.call('pk_merge_work_items', { ...MERGE, reason: '  ' });
  assert.equal(noReason.error, true, noReason.text);
  assert.match(noReason.text, /Say why/);
  assert.ok(h.store.threads.has('thread_b'), 'nothing was merged');
  assert.equal(h.store.merges.size, 0);

  const merged = await h.call('pk_merge_work_items', MERGE);
  assert.equal(merged.error, false, merged.text);
  const circle = await h.call('pk_merge_work_items', { ...MERGE, keepId: 'thread_b', mergeIds: ['thread_a'] });
  assert.equal(circle.error, true, circle.text);
  assert.match(circle.text, /circle/);
  const again = await h.call('pk_merge_work_items', MERGE);
  assert.equal(again.error, true, again.text);
  assert.match(again.text, /already merged into/);
  assert.ok(h.store.threads.has('thread_a'), 'the refused calls left the kept work item where it was');
  assert.equal(h.store.merges.size, 1);
});

test('the merged work item points to the one kept, which takes over its sources, facts and relations; neither is Replaced (CKC-06 AC-28)', async () => {
  const h = duplicated();
  const r = await h.call('pk_merge_work_items', MERGE);
  assert.equal(r.error, false, r.text);
  const { store } = h;

  assert.equal(store.threads.has('thread_b'), false, 'the merged one is no longer a work item of its own');
  const record = store.merges.all()[0]!;
  assert.equal(record.mergedId, 'thread_b');
  assert.equal(record.keptId, 'thread_a');
  assert.equal(record.reason, MERGE.reason);
  assert.equal(record.merged.title, 'Invoice export (batch 2 notes)', 'what was merged is kept in the record');

  const kept = store.threads.get('thread_a')!;
  assert.deepEqual([...kept.factRecordIds].sort(), ['fact_a', 'fact_b']);
  assert.deepEqual([...kept.ids].sort(), ['BATCH2-EXPORT', 'L-4']);
  assert.ok(kept.executionFacts.some((s) => s.text.includes('nightly export job')), 'its execution facts moved over');
  assert.equal(kept.serves.filter((s) => s.referenceId === 'ref_area').length, 1, 'one serves entry per upstream');
  assert.equal(kept.validity, 'Current');
  assert.equal(kept.replacedBy, null);
  assert.equal(store.threads.all().some((t) => t.validity === 'Replaced'), false, 'a merge is not a replacement');
  assert.equal(store.relations.all().some((x) => x.type === 'replaces'), false);

  assert.ok(store.relations.find((x) => x.type === 'implements' && x.from === 'src_code' && x.to === 'thread_a'), 'the code relation now reaches the kept work item');
  assert.equal(store.relations.find((x) => x.type === 'implements' && x.to === 'thread_a')!.assessment, 'Holds', 'with its assessment');
  assert.equal(store.relations.all().some((x) => x.from === 'thread_b' || x.to === 'thread_b'), false, 'no relation is left on the merged id');
  assert.equal(store.threads.get('thread_next')!.dependsOn[0]!.threadId, 'thread_a');
  assert.equal(store.areas.get('area_1')!.contributions[0]!.threadId, 'thread_a');
  assert.deepEqual(store.notes.get('note_b')!.mount.ids, ['thread_a']);
  assert.ok(store.marks.all().some((m) => m.targetId === 'thread_a' && m.kind === 'Suspected stale'), 'the open doubt moved with it');
  assert.equal(store.marks.all().some((m) => m.targetId === 'thread_b'), false);
  const change = store.changes.get('chg_1')!;
  assert.deepEqual(change.affects, ['thread_a']);
  assert.deepEqual(change.items![0]!.affects, ['thread_a']);
  const reached = store.changes.get('chg_2')!.propagation;
  assert.equal(reached.some((p) => p.nodeId === 'thread_b'), false, 'no change entry is left on the merged id');
  assert.equal(reached.filter((p) => p.nodeId === 'thread_a').length, 1, 'the kept one has one entry per change');
  assert.equal(reached.find((p) => p.nodeId === 'thread_a')?.state, 'Still on old understanding', 'what the merged one had not followed, the kept one has not either');
  assert.equal(store.propagation.all().some((j) => j.nodeId === 'thread_b'), false);
  assert.equal(store.propagation.get('round_0001:thread_a')?.lacks.length, 1);
  assert.deepEqual(store.reference.get('ref_dec')!.carryOut?.workIds, ['thread_a']);
  assert.equal(store.nodes.has('thread_b'), false);
});

test('the merged id still reaches the kept work item, which alone shows in the graph, the list and a pack (CKC-06 AC-28)', async () => {
  const h = duplicated();
  const r = await h.call('pk_merge_work_items', MERGE);
  assert.equal(r.error, false, r.text);

  const read = await h.call('pk_read_assets', { kind: 'thread', ids: ['thread_b'] });
  assert.equal(read.error, false, read.text);
  const got = (read.json as unknown as Record<string, unknown>[])[0]!;
  assert.equal(got.id, 'thread_a', 'the merged id reads the kept work item');
  assert.equal(got.mergedFrom, 'thread_b');

  // A later write that still uses the merged id lands on the kept work item instead of bringing the duplicate back.
  const write = await h.call('pk_write_thread', { id: 'thread_b', title: 'Invoice export (batch 2 notes)', progress: 'Done', results: 'exports verified by the owner' });
  assert.equal(write.error, false, write.text);
  assert.equal(write.json.id, 'thread_a');
  assert.equal(h.store.threads.has('thread_b'), false);
  assert.equal(h.store.threads.get('thread_a')!.progress, 'Done');

  deriveGraph(h.store, h.project);
  assert.equal(h.store.nodes.has('thread_b'), false);
  assert.ok(h.store.nodes.has('thread_a'));
  assert.equal(graphView(h.store, h.project).nodes.some((n) => n.id === 'thread_b'), false, 'the graph and the list show it once');
  const pack = assembleContext(h.store, h.project, { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null } as ContextRequest, 'Idle').markdown;
  assert.equal(pack.includes('thread_b'), false, 'no pack names the merged id');
  assert.ok(pack.includes('thread_a'));
});
