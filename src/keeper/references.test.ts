/**
 * The Keeper looks up its own assets by id (Spec §3.1; CKC-03 AC-22; subagent/DECISIONS.md E63): which fact records,
 * reference items, work items, relations, change records, marks and notes cite or touch a source or a record. It
 * gets short rows — name, id, category — and reads any of them in full by id with the existing tools. Two jobs went
 * looking for exactly this on the file system and walked into another ProjectKeeper home; the answer has to come
 * from the project's own assets.
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
import type { ChangeRecord, EntryMark, FactRecord, GraphRelation, Note, Project, ReferenceItem, Source, WorkThread } from '../model/types.ts';

const AT = '2026-09-17T00:00:00.000Z';

function harness() {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-refs-')));
  const project = { id: 'p1', name: 'Ledger', language: 'en', locations: ['D:\\ledger'], scope: [], roles: [] } as unknown as Project;
  const ctx: ToolContext = { store, project, jobId: 'job_1', jobKind: 'Organizing', model: null };
  const tools = keeperTools(ctx);
  return {
    store,
    async find(id: string) {
      const tool = tools.find((t) => t.name === 'pk_find_references');
      assert.ok(tool, 'no tool pk_find_references');
      const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
      const result = await run('call', { id });
      const text = result.content.map((c) => c.text).join('\n');
      assert.notEqual(result.isError, true, text);
      return { text, json: JSON.parse(text) as { id: string; is: { kind: string; name: string; category: string } | null; rows: { kind: string; id: string; name: string; category: string; via: string }[]; note?: string } };
    },
  };
}

const inputs = { jobId: 'j', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' };
const LONG = 'The task index lists every task with its number and status. '.repeat(20);

function ledger() {
  const h = harness();
  const { store } = h;
  const put = (id: string, path: string, ids: string[] = []) => store.sources.put({ id, projectId: 'p1', title: path.split('\\').pop()!, anchor: { kind: 'file', path, headingPath: ['Tasks'], lineStart: 1, lineEnd: 30 }, ids, version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt: LONG, usedAs: 'Plan', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: 'scope', hasCredential: false, bytes: LONG.length } as Source);
  put('src_tasks', 'D:\\ledger\\docs\\TASKS.md', ['L-4']);
  put('src_other', 'D:\\ledger\\docs\\OTHER.md');
  store.facts.put({ id: 'fact_tasks', projectId: 'p1', title: 'Facts from the task index', aboutSourceIds: ['src_tasks'], statements: [{ id: 'st_1', type: 'Observed', text: LONG, sourceIds: ['src_tasks'] }], decisions: [], changes: [], openQuestions: [], executionFacts: [], language: 'en', inputs, asOf: AT, updatedAt: AT, pendingSourceIds: [] } as FactRecord);
  const ref = (id: string, category: string, name: string, sourceIds: string[]) => store.reference.put({ id, projectId: 'p1', category, name, ids: [], text: LONG, quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, sourceIds, refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT } as ReferenceItem);
  ref('ref_req', 'Requirement', 'R-2 · export invoices to CSV', ['src_tasks']);
  ref('ref_area', 'Area', 'A1 · Exports', ['src_other']);
  const work = (id: string, title: string, ids: string[], factRecordIds: string[], serves: string[]) => store.threads.put({ id, projectId: 'p1', title, ids, doing: LONG, changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds, serves: serves.map((referenceId) => ({ referenceId, claim: '', basis: 'Explicit' as const })), dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, inputs, asOf: AT, updatedAt: AT, pendingSourceIds: [] } as WorkThread);
  work('thread_a', 'L-4 · export invoices', ['L-4'], ['fact_tasks'], ['ref_area']);
  work('thread_x', 'L-8 · archive old invoices', ['L-8'], [], []);
  work('thread_y', 'L-9 · export reminders', ['L-9'], [], []);
  const rel = (id: string, type: string, from: string, to: string, sourceIds: string[]) => store.relations.put({ id, projectId: 'p1', type, from, to, claim: LONG, basis: 'Explicit', evidence: { sourceIds, factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: AT } as GraphRelation);
  rel('rel_serves', 'serves', 'thread_a', 'ref_area', ['src_tasks']);
  rel('rel_unrelated', 'depends on', 'thread_x', 'thread_y', ['src_other']);
  store.changes.put({ id: 'chg_1', projectId: 'p1', at: AT, atSource: 'material', material: 'Plan update', effect: 'Added', title: 'R-2 added to the task index', summary: LONG, before: null, after: null, sourceIds: ['src_tasks'], by: { author: { kind: 'owner', name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' }, affects: ['ref_req'], propagation: [], segment: null, createdInJobId: null, updatedAt: AT } as ChangeRecord);
  store.marks.put({ id: 'mark_req', projectId: 'p1', kind: 'Suspected stale', targetId: 'ref_req', clueSourceIds: ['src_tasks'], clue: 'the index row and the requirement disagree on the format', since: AT, noteId: null, closed: null } as EntryMark);
  const note = (id: string, mount: Note['mount'], title: string, factSources: string[]) => store.notes.put({ id, projectId: 'p1', mount, status: 'Current', ownerResponse: null, versions: [{ version: 1, at: AT, title, preview: LONG, body: { currentView: LONG, whyItMatters: null, facts: factSources.map((s) => ({ text: 'from the index', sourceIds: [s], inferred: false })), otherExplanations: null, keepAdjust: null, whatWouldSettleIt: null }, ask: 'For information', judgementRecordId: 'jdg_1', reason: 'first' }], discussion: [], followUps: [], author: { agent: 'pi', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, language: 'en', updatedAt: AT } as Note);
  note('note_index', { kind: 'project', ids: [] }, 'The task index is the only list of tasks', ['src_tasks']);
  note('note_work', { kind: 'node', ids: ['thread_a'] }, 'L-4 has no owner review', []);
  return h;
}

const rowFor = <T extends { id: string }>(rows: readonly T[], id: string) => rows.find((r) => r.id === id);

test('asked for a source id, the Keeper gets every record of its own that cites or rests on it, as short rows (CKC-03 AC-22)', async () => {
  const h = ledger();
  const { json, text } = await h.find('src_tasks');
  assert.equal(json.is?.kind, 'source');
  for (const [id, kind] of [
    ['fact_tasks', 'fact record'], ['ref_req', 'reference item'], ['thread_a', 'work item'], ['rel_serves', 'relation'],
    ['chg_1', 'change record'], ['mark_req', 'mark'], ['note_index', 'note'],
  ] as const) {
    const row = rowFor(json.rows, id);
    assert.ok(row, `${id} cites or rests on the source`);
    assert.equal(row.kind, kind);
    assert.ok(row.name.length > 0 && row.category.length > 0, `${id} comes with its name and category`);
  }
  assert.equal(rowFor(json.rows, 'ref_area'), undefined, 'an item that cites another source is not listed');
  assert.equal(rowFor(json.rows, 'rel_unrelated'), undefined, 'nor a relation resting on another source');
  // Short rows: the full text is read by id, never carried here.
  assert.equal(text.includes(LONG.slice(0, 120)), false, 'no row carries the full text');
  for (const row of json.rows) assert.deepEqual(Object.keys(row).sort(), ['category', 'id', 'kind', 'name', 'via']);
});

test('asked for a record id, the Keeper gets the relations, changes, marks and notes that touch it', async () => {
  const h = ledger();
  const work = await h.find('thread_a');
  assert.equal(work.json.is?.kind, 'work item');
  assert.equal(rowFor(work.json.rows, 'rel_serves')?.category, 'serves', 'the relations starting or ending at it');
  assert.ok(rowFor(work.json.rows, 'note_work'), 'the notes mounted on it');
  assert.equal(rowFor(work.json.rows, 'rel_unrelated'), undefined);

  const requirement = await h.find('ref_req');
  assert.ok(rowFor(requirement.json.rows, 'chg_1'), 'the change records whose items changed it');
  assert.ok(rowFor(requirement.json.rows, 'mark_req'), 'the marks on it');

  const area = await h.find('ref_area');
  assert.ok(rowFor(area.json.rows, 'thread_a'), 'the work items serving it');
  assert.ok(rowFor(area.json.rows, 'rel_serves'));
});

test('an id the assets do not hold is answered from the assets alone; a project number finds what carries it', async () => {
  const h = ledger();
  const nowhere = await h.find('src_0000000000000000');
  assert.equal(nowhere.json.is, null);
  assert.deepEqual(nowhere.json.rows, []);
  assert.match(nowhere.json.note ?? '', /not an id of this project’s assets/);

  const byNumber = await h.find('L-4');
  assert.ok(rowFor(byNumber.json.rows, 'thread_a'), 'the work item with that number, so a second one is not created');
  assert.ok(rowFor(byNumber.json.rows, 'src_tasks'), 'and the sources that carry it');
  assert.equal(rowFor(byNumber.json.rows, 'thread_x'), undefined);
});
