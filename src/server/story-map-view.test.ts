/**
 * What the story map needs from the graph payload (graph-view.ts; D100; Spec §2.7, §2.12, §6.2, §6.3; CKC-09 AC-2, AC-9):
 * a note on an object counts on that object — a note on a path on the path's top object only — and says whether it
 * still needs the owner (it is in `Notes (attention)`), so the ❓ on the object is lit or quiet; a note on the whole
 * project is marked on no object; the earlier generations come with their work items and plans for the rolled bands.
 * An invented project ("Wren", a recipe box) in a store of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Generation } from '../model/k-types.ts';
import type { GraphNode, GraphRelation, Note, Project } from '../model/types.ts';
import { ProjectStore } from '../store/project-store.ts';
import { graphView, inAttention } from './graph-view.ts';

const P = 'wren';
const AT = '2026-09-20T10:00:00.000Z';
const node = (id: string, category: GraphNode['category']): GraphNode => ({ id, projectId: P, category, label: id, refKind: 'reference', refId: id, validity: 'Current', progress: category === 'Work item' ? 'Done' : null, basis: 'Explicit', attribution: null, sourceIds: [], areaId: null, parentWorkId: null, replacedBy: null, updatedAt: AT } as GraphNode);
const rel = (id: string, from: string, to: string): GraphRelation => ({ id, projectId: P, type: 'serves', from, to, claim: '', basis: 'Explicit', evidence: { sourceIds: [], factRecordIds: [], reachedTo: null }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: AT } as unknown as GraphRelation);
const note = (id: string, mount: Note['mount'], ask: string, ownerResponse: string | null = null): Note => ({
  id, projectId: P, mount, status: 'Current', ownerResponse,
  versions: [{ version: 1, at: AT, title: id, preview: '', body: { currentView: '', whyItMatters: null, facts: [], otherExplanations: null, keepAdjust: null, whatWouldSettleIt: null }, ask, judgementRecordId: 'jdg', reason: '' }],
  discussion: [], followUps: [], author: { agent: 'pi', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, cameFrom: null, language: 'en', updatedAt: AT,
} as unknown as Note);

test('a note is marked on its object, lit while it still needs the owner; a note on a path on the path’s top object; one on the project on none', () => {
  const store = ProjectStore.open(P, mkdtempSync(join(tmpdir(), 'pk-story-view-')));
  for (const [id, c] of [['area', 'Area'], ['req', 'Requirement'], ['work', 'Work item']] as const) store.nodes.put(node(id, c));
  store.relations.put(rel('rel_w_r', 'work', 'req'));
  store.notes.put(note('n_decide', { kind: 'node', ids: ['work'] }, 'For your decision'));
  store.notes.put(note('n_info', { kind: 'node', ids: ['work'] }, 'For information'));
  store.notes.put(note('n_answered', { kind: 'node', ids: ['req'] }, 'For your decision', 'Decided'));
  store.notes.put(note('n_discussed', { kind: 'relation', ids: ['rel_w_r'] }, 'Worth discussing'));
  store.notes.put(note('n_path', { kind: 'path', ids: ['work', 'req', 'area'] }, 'Worth discussing'));
  store.notes.put(note('n_project', { kind: 'project', ids: [P] }, 'For your decision'));
  const g = graphView(store, { id: P } as Project);
  const at = (id: string) => g.nodes.find((n) => n.id === id)!;
  assert.deepEqual([at('work').noteCount, at('work').noteAttention], [2, 1], 'one asks for a decision, one only informs');
  assert.deepEqual([at('req').noteCount, at('req').noteAttention], [1, 0], 'answered: it stays on the object, quiet');
  assert.deepEqual([at('area').noteCount, at('area').noteAttention], [1, 1], 'the path’s note is on its top object, the area, and nowhere else on the path');
  const r = g.relations.find((x) => x.id === 'rel_w_r')!;
  assert.deepEqual([r.noteCount, r.noteAttention], [1, 1]);
  assert.ok(g.nodes.every((n) => n.id !== P), 'the project-wide note is on no object: it is in the drawer');
  assert.equal(inAttention(store.notes.get('n_answered')!), false);
  assert.equal(inAttention(store.notes.get('n_path')!), true);
});

test('the graph payload carries the earlier generations with their work and plans, oldest first (Spec §2.12)', () => {
  const store = ProjectStore.open(P, mkdtempSync(join(tmpdir(), 'pk-story-view-')));
  store.nodes.put(node('old', 'Work item'));
  const gen = (id: string, ended: string, workIds: string[]): Generation => ({ id, projectId: P, name: `Generation ${id}`, started: null, ended: { at: ended, basis: 'Commit', anchor: null }, endedBy: { kind: 'file', id: 'DECISIONS.md', label: 'DECISIONS.md', line: '**D9 · restart**' }, planRefs: [], workIds, roundId: null, updatedAt: AT });
  store.generations.put(gen('g2', '2026-08-01', []));
  store.generations.put(gen('g1', '2026-06-01', ['old']));
  const g = graphView(store, { id: P } as Project);
  assert.deepEqual(g.generations.map((x) => [x.id, x.workIds, x.planIds, x.endedBy.line]), [['g1', ['old'], [], '**D9 · restart**'], ['g2', [], [], '**D9 · restart**']]);
});

test('a work item carries its `serves` in the order the Keeper wrote them, whatever order the relations were stored in (owner, 2026-09-30)', async () => {
  const store = ProjectStore.open(P, mkdtempSync(join(tmpdir(), 'pk-story-view-')));
  for (const [id, c] of [['aFirst', 'Area'], ['aSecond', 'Area'], ['plan', 'Plan']] as const) store.nodes.put(node(id, c));
  store.nodes.put({ ...node('work', 'Work item'), refKind: 'thread', refId: 'work', areaId: 'aFirst' } as GraphNode);
  store.threads.put({ id: 'work', projectId: P, title: 'work', ids: [], serves: [{ referenceId: 'aFirst', claim: 'the ticket names it', basis: 'Explicit' }, { referenceId: 'plan', claim: '', basis: 'Explicit' }, { referenceId: 'aSecond', claim: 'also', basis: 'Explicit' }], dependsOn: [], factRecordIds: [], pendingSourceIds: [] } as never);
  // The relation to the second area was stored first (written earlier by another writer).
  store.relations.put(rel('r2', 'work', 'aSecond'));
  store.relations.put(rel('r1', 'work', 'aFirst'));
  store.relations.put(rel('r3', 'work', 'plan'));
  const g = graphView(store, { id: P } as Project);
  const work = g.nodes.find((n) => n.id === 'work')!;
  assert.deepEqual(work.servesOrder, ['aFirst', 'plan', 'aSecond']);
  assert.equal(g.nodes.find((n) => n.id === 'aFirst')!.servesOrder, undefined, 'only a work item carries it');
  // The story map reads that order: solid in the first Area written (no contract), dashed in the other.
  const placement: { placementOf(d: unknown): { place: Map<string, { area: string; areas: string[]; by: string }> } } = await import(new URL('../../ui/placement.js', import.meta.url).href);
  const p = placement.placementOf(g).place.get('work')!;
  assert.deepEqual([p.area, p.areas, p.by], ['aFirst', ['aFirst', 'aSecond'], 'named']);
});
