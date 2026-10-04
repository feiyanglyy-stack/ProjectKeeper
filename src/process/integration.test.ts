/**
 * How a commit reached the trunk (integration.ts), and the task a side commit belongs to (units.ts): the task its own
 * merge names where a merge names what it merges — the innermost merge first, for a branch merged into an integration
 * branch — and not a task the trunk's merge of that integration branch only mentions (test-C-1: `Merge k-clerk:
 * increment K (…, QC AW/AX/AY fixes)` had made nearly every commit of increment K AW's).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Facts } from './facts.ts';
import { buildUnits, mergeNamesIn } from './units.ts';
import { mergeSubjectBranches } from './integration.ts';
import { buildKiln } from './increment.test-helpers.ts';

const k = buildKiln();

test('a merge names what it merged only where a merge says so', () => {
  assert.deepEqual(mergeNamesIn("Merge branch 'k-ledger' (AP: the ledger)"), ['AP']);
  assert.deepEqual(mergeNamesIn('Merge AB+AD: parser'), ['AB', 'AD']);
  assert.deepEqual(mergeNamesIn('Merge T-2 conveyor'), ['T-2']);
  assert.deepEqual(mergeNamesIn('Merge k-int: increment K (ledger, clerk tools, QC AY fixes)'), [], 'a QC mentioned in passing is not what it merged');
  assert.deepEqual(mergeNamesIn('Merge k-ayfix-a (QC AY package A: rows, window)'), []);
  assert.deepEqual(mergeSubjectBranches("Merge branch 'k-tools' (the clerk method's position writers)"), { source: 'k-tools', target: null });
  assert.deepEqual(mergeSubjectBranches('Merge k-clerk into k-ledger: the ledger continues'), { source: 'k-clerk', target: 'k-ledger' });
  assert.deepEqual(mergeSubjectBranches('Merge main (AQ) into k-clerk'), { source: 'main', target: 'k-clerk' });
  assert.deepEqual(mergeSubjectBranches('Merge pull request #12 from dev/feature-x'), { source: 'feature-x', target: null });
});

test('a side commit belongs to the task its own merge names, not to one the trunk merge only mentions', () => {
  const facts = new Facts(k.ledger);
  const index = buildUnits(k.store, facts);
  assert.deepEqual(index.commitUnits.get(k.c.led1), ['AP'], 'k-ledger’s commits are AP’s: its own merge says `(AP: …)`, though the trunk merge names nothing');
  assert.deepEqual(index.commitUnits.get(k.c.led2), ['AP']);
  for (const [name, h] of [['k-tools', k.c.tools1], ['the integration branch’s fix', k.c.intFix], ['QC AY’s package A', k.c.fixA1], ['QC AY’s package A', k.c.fixA2]] as const) {
    assert.equal(index.commitUnits.get(h), undefined, `${name} carries no task: the trunk merge’s “QC AY fixes” does not make it AY’s`);
  }
  assert.ok(!(index.units.get('AY')?.merges ?? []).some((m) => m.hash === k.c.trunkMerge), 'nor is the trunk merge AY’s merge');
  assert.ok((index.units.get('AP')?.merges ?? []).some((m) => m.hash === k.c.trunkMerge), 'AP’s commits reached the trunk with it');
});

test('the merges that brought a commit in, innermost first; a merge of the trunk into a branch integrates nothing', () => {
  const index = buildUnits(k.store, new Facts(k.ledger));
  const { integrations } = index;
  assert.equal(integrations.innermost.get(k.c.tools1)?.merge.hash, k.c.toolsMerge, 'the merge that integrated a commit is the innermost one');
  assert.deepEqual(integrations.chainOf(k.c.tools1).map((m) => m.merge.hash), [k.c.toolsMerge, k.c.trunkMerge], 'then the trunk’s merge of the integration branch');
  assert.equal(integrations.innermost.get(k.c.fixA1)?.source, 'k-ayfix-a');
  assert.equal(integrations.trunkMergeOf(k.c.fixA1)?.hash, k.c.trunkMerge);
  assert.ok(!integrations.merges.some((m) => m.source === 'main'), '`Merge main (AY) into k-int` only kept k-int up to date');
});
