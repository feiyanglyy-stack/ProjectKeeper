/**
 * What the graph payload carries for the foundation column and the whole-product ring (CM; D101; Spec §1.4, §6.3;
 * CKC-09 AC-2): an Area that is a cross-cutting foundation says so (`foundation: true`), and a requirement, design or
 * decision placed on the whole product carries the Keeper's written reason (`wholeProductWhy`); neither key is there
 * when it is not set. An invented project ("Finch", a seed library) in a store of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphNode, Project, ReferenceItem, WorkThread } from '../model/types.ts';
import { ProjectStore } from '../store/project-store.ts';
import { graphView } from './graph-view.ts';

const P = 'finch';
const AT = '2026-09-30T10:00:00.000Z';
const node = (id: string, category: GraphNode['category']): GraphNode => ({ id, projectId: P, category, label: id, refKind: 'reference', refId: id, validity: 'Current', progress: null, basis: 'Explicit', attribution: null, sourceIds: [], areaId: null, parentWorkId: null, replacedBy: null, updatedAt: AT } as GraphNode);
const ref = (id: string, category: string, extra: Partial<ReferenceItem> = {}): ReferenceItem => ({ id, projectId: P, category, name: id, ids: [], text: '', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: null, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT, ...extra } as unknown as ReferenceItem);

test('a foundation area and a whole-product decision carry their keys; other objects carry neither', () => {
  const store = ProjectStore.open(P, mkdtempSync(join(tmpdir(), 'pk-graph-cm-')));
  const items: [string, GraphNode['category'], Partial<ReferenceItem>][] = [
    ['base', 'Area', { foundation: true }],
    ['mod', 'Area', {}],
    ['dWhole', 'Decision', { wholeProductWhy: 'How every document is written, for every module alike' }],
    ['dBlank', 'Decision', { wholeProductWhy: '   ' }],
    ['reqFlag', 'Requirement', { foundation: true }],
  ];
  for (const [id, c, extra] of items) { store.nodes.put(node(id, c)); store.reference.put(ref(id, c, extra)); }
  const g = graphView(store, { id: P } as Project);
  const at = (id: string) => g.nodes.find((n) => n.id === id)! as { foundation?: true; wholeProductWhy?: string };
  assert.equal(at('base').foundation, true);
  assert.ok(!('foundation' in at('mod')), 'a module carries no key');
  assert.ok(!('foundation' in at('reqFlag')), 'only an Area is a foundation');
  assert.equal(at('dWhole').wholeProductWhy, 'How every document is written, for every module alike');
  assert.ok(!('wholeProductWhy' in at('dBlank')), 'an empty reason is no reason');
  assert.ok(!('wholeProductWhy' in at('base')));
});

test('a work item recorded as serving its whole plan carries the Keeper’s reason; other work carries no key (CN, E152)', () => {
  const store = ProjectStore.open(P, mkdtempSync(join(tmpdir(), 'pk-graph-cn-')));
  const thread = (id: string, extra: Partial<WorkThread> = {}): WorkThread => ({ id, projectId: P, title: id, ids: [], doing: '', changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'Done', validity: 'Current', replacedBy: null, attribution: null, inputs: null, asOf: AT, updatedAt: AT, pendingSourceIds: [], ...extra } as unknown as WorkThread);
  const why = 'The milestone check judges every contract of the plan; it belongs to no single module';
  for (const [id, extra] of [['qc', { wholePlanWhy: why }], ['blank', { wholePlanWhy: '  ' }], ['plain', {}]] as [string, Partial<WorkThread>][]) {
    store.nodes.put({ ...node(id, 'Work item'), refKind: 'thread' } as GraphNode);
    store.threads.put(thread(id, extra));
  }
  const g = graphView(store, { id: P } as Project);
  const at = (id: string) => g.nodes.find((n) => n.id === id)! as { wholePlanWhy?: string };
  assert.equal(at('qc').wholePlanWhy, why);
  assert.ok(!('wholePlanWhy' in at('blank')), 'an empty reason is no reason');
  assert.ok(!('wholePlanWhy' in at('plain')));
});
