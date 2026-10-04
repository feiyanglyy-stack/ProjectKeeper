/**
 * The collections Spec v2.8 adds — the project's rules (§1.15), the organizing plan and focus (§3.7, D62), and the
 * merge records (§1.4, E64/E65) — are read and written like every other collection, and a home written before they
 * existed still opens with everything it had.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from './project-store.ts';

const AT = '2026-09-17T00:00:00.000Z';

test('a home written before the new collections opens with what it had, and the new ones start empty', () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-old-home-'));
  const dir = join(home, 'projects', 'p1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'threads.json'), JSON.stringify([{ id: 'thread_old', projectId: 'p1', title: 'W-1 · an old work item', ids: ['W-1'], progress: 'Done', validity: 'Current' }]));
  writeFileSync(join(dir, 'reference.json'), JSON.stringify([{ id: 'ref_old', projectId: 'p1', category: 'Decision', name: 'D1', validity: 'Current' }]));
  const store = ProjectStore.open('p1', home);
  assert.equal(store.threads.get('thread_old')?.title, 'W-1 · an old work item');
  assert.equal(store.reference.size, 1);
  assert.equal(store.rules.size, 0);
  assert.equal(store.plans.size, 0);
  assert.equal(store.merges.size, 0);
  assert.equal(existsSync(join(dir, 'rules.json')), false, 'opening writes nothing it was not asked to');
});

test('rules, the organizing plan and merge records are saved and read back like the other collections', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-new-home-'));
  const store = ProjectStore.open('p1', home);
  store.rules.put({
    id: 'rule_1', projectId: 'p1', group: 'Material rules', category: 'Reference only',
    summary: 'The bundled chart library’s documents are reference only.', excerpt: 'vendor/ is third-party code; its docs do not define our requirements.',
    sourceIds: ['src_agents'], appliesTo: ['vendor/'], basis: 'Explicit', validity: 'Current', replacedBy: null,
    ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: 'job_1', asOf: AT, updatedAt: AT,
  }, { jobId: 'job_1', summary: 'test' });
  store.plans.put({
    id: 'organizing-plan', projectId: 'p1',
    byRule: [{ what: 'the vendored library', targets: ['vendor/'], ruleId: 'rule_1', treatment: 'Reference only' }],
    readClosely: [{ what: 'the task index', targets: ['docs/TASKS.md'], why: 'progress is read from it' }],
    focus: [{ what: 'work still in progress', why: 'the next agent picks it up', sourceIds: [] }],
    order: ['task index first'], corrections: [], jobId: 'job_1', asOf: AT, updatedAt: AT,
  });
  store.merges.put({
    id: 'merge_1', projectId: 'p1', kind: 'thread', mergedId: 'thread_b', keptId: 'thread_a', reason: 'both are TASK-4',
    sourceIds: [], merged: { id: 'thread_b' } as never, at: AT, jobId: 'job_1', roundId: null,
  });
  await store.flush();
  const dir = join(home, 'projects', 'p1');
  for (const file of ['rules.json', 'plans.json', 'merges.json']) assert.equal(existsSync(join(dir, file)), true, `${file} is on disk`);
  const again = ProjectStore.open('p1', home);
  assert.equal(again.rules.get('rule_1')?.category, 'Reference only');
  assert.deepEqual(again.rules.get('rule_1')?.appliesTo, ['vendor/']);
  assert.equal(again.plans.get('organizing-plan')?.byRule[0]?.ruleId, 'rule_1');
  assert.equal(again.merges.get('merge_1')?.keptId, 'thread_a');
});
