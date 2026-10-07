/**
 * What the follow-up experiment's arm B (owner 2026-09-18) left in use, each checked on its own: objects that are never
 * judged leave what is pending (D56 widened arm B's closed-record gate into that); and material under a directory the
 * owner excluded is not organized even when it was read before the exclusion. Arm B's other settings — batches per
 * round, the strong route and its review, the closed-record gate, the once-per-round upper layers — were no longer read
 * once every round became one main job (D59), and went with their functions (batch C2, C1's hand-back item 4); the
 * version-2 round prompt went with the material rounds (CKC-06, replaced by the clerk method).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../../store/project-store.ts';
import { pendingByArea, pendingCount } from './follow-up.ts';
import { settleNotJudged } from '../adjustment.ts';
import { listMaterials } from './materials.ts';
import type { ChangeRecord, Project, ReferenceItem, Source, WorkThread } from '../../model/types.ts';

const at = '2026-09-18T00:00:00.000Z';
function store(): ProjectStore {
  const s = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-armb-')));
  const thread = (id: string, progress: string, validity = 'Current') => s.threads.put({ id, title: id, doing: '', results: '', progress, validity, factRecordIds: [], updatedAt: at } as unknown as WorkThread);
  thread('thread_done', 'Done');
  thread('thread_hold', 'On hold', 'Deferred');
  thread('thread_open', 'In progress');
  s.reference.put({ id: 'ref_replaced', category: 'Decision', name: 'old decision', validity: 'Replaced', text: '', ids: [], sourceIds: [], refines: [], updatedAt: at } as unknown as ReferenceItem);
  s.reference.put({ id: 'ref_current', category: 'Requirement', name: 'contract', validity: 'Current', text: '', ids: [], sourceIds: [], refines: [], updatedAt: at } as unknown as ReferenceItem);
  s.changes.put({
    id: 'chg_1', projectId: 'p1', at, effect: 'Replaced', title: 'a change', summary: '', before: null, after: null, sourceIds: [], affects: [],
    propagation: ['thread_done', 'thread_hold', 'thread_open', 'ref_replaced', 'ref_current'].map((nodeId) => ({ nodeId, state: 'Not yet checked', sourceOrReason: '', updatedAt: at })),
  } as unknown as ChangeRecord);
  return s;
}
const stateOf = (s: ProjectStore, nodeId: string) => s.changes.get('chg_1')!.propagation.find((p) => p.nodeId === nodeId);

test('objects that are never judged leave what is pending; items on hold and current items are left to judge', () => {
  const s = store();
  // D56 widened the gate: a point-in-time record is not settled with a state, it leaves `propagation` for the
  // record's own `notJudged` list, where the change's detail shows it and nothing counts it as pending.
  assert.equal(settleNotJudged(s, at), 2);
  assert.equal(stateOf(s, 'thread_done'), undefined, 'a Done work item is not judged at all');
  assert.equal(stateOf(s, 'ref_replaced'), undefined, 'nor is a Replaced decision');
  assert.deepEqual(
    (s.changes.get('chg_1')!.notJudged ?? []).map((e) => `${e.nodeId}:${e.reason}`).sort(),
    ['ref_replaced:Point-in-time record', 'thread_done:Point-in-time record'],
    'both are listed apart in the change’s detail, with the reason',
  );
  for (const id of ['thread_hold', 'thread_open', 'ref_current']) assert.equal(stateOf(s, id)!.state, 'Not yet checked', `${id} still to judge`);
  assert.equal(settleNotJudged(s, at), 0, 'settling twice changes nothing');
  const batched = pendingByArea(s).flatMap((b) => b.entries.map((e) => e.nodeId)).sort();
  assert.deepEqual(batched, ['ref_current', 'thread_hold', 'thread_open'], 'only open objects go to a model');
  assert.equal(pendingCount(s).notJudged, 2, 'the two are counted as not judged, not as pending');
});

test('material under an excluded directory is not organized, even when it was read before the exclusion', () => {
  const s = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-armb-')));
  const source = (id: string, path: string) => s.sources.put({ id, anchor: { kind: 'file', path }, title: path, excerpt: 'text', availability: 'Available', scopeItemId: 'scope_main', version: { readAt: at } } as unknown as Source);
  // A rooted path of the system the test runs on (`D:\proj\docs\plan.md` on Windows): what lies under a directory is
  // told by the system's own separator.
  const root = process.platform === 'win32' ? 'D:\\proj' : '/proj';
  const at_ = (...parts: string[]) => join(root, ...parts);
  source('src_doc', at_('docs', 'plan.md'));
  source('src_run', at_('subagent', 'runs', 'AE', 'start.md'));
  source('src_runs_sibling', at_('subagent', 'runs-notes.md'));
  const project = { id: 'p1', name: 'P', locations: [root], createdAt: at, scope: [
    { id: 'scope_main', path: root, relation: 'Main project', category: 'Directory' },
    { id: 'scope_runs', path: at_('subagent', 'runs'), relation: 'Excluded', category: 'Directory' },
  ] } as unknown as Project;
  const keys = listMaterials(s, project).map((m) => m.key).sort();
  assert.deepEqual(keys, [`file:${at_('docs', 'plan.md')}`, `file:${at_('subagent', 'runs-notes.md')}`], 'the excluded directory is out; a sibling whose name only starts the same is not');
});
