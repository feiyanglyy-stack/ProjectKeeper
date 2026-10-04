/**
 * Merged work without a task number (the owner's rule of 2026-09-28; test-C-1): the program lists the branches merged and
 * the direct commits no task number claims, with their commits, merges, sizes, what they name and whose files they
 * changed, and says which a process link already ties to a work item.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Facts } from './facts.ts';
import { fileKind, unnumberedWork, unnumberedWorkBlock } from './unnumbered.ts';
import { buildKiln } from './increment.test-helpers.ts';
import { thread } from './fixture.test-helpers.ts';

const k = buildKiln();

test('what a changed file is: code, tests, configuration, documents, execution records', () => {
  assert.equal(fileKind('src/ledger.ts'), 'code');
  assert.equal(fileKind('src/tools.test.ts'), 'test');
  assert.equal(fileKind('package.json'), 'config');
  assert.equal(fileKind('README.md'), 'doc');
  assert.equal(fileKind('design/mockups/list.html'), 'doc', 'a mockup is a design document');
  assert.equal(fileKind('subagent/runs/AY-1/result.md'), 'record');
  assert.equal(fileKind('.claude/settings.local.json'), 'record', 'an agent’s own settings are not the product');
});

test('the pieces of merged work no task number claims: the tools branch, the QC fix package and the integration branch’s own fix — not the ledger branch', () => {
  const pieces = unnumberedWork(k.store, new Facts(k.ledger));
  const byBranch = new Map(pieces.filter((p) => p.branch).map((p) => [p.branch!, p]));
  assert.ok(!byBranch.has('k-ledger'), 'k-ledger’s merge names AP');
  const tools = byBranch.get('k-tools');
  assert.ok(tools, `k-tools is listed: ${pieces.map((p) => p.branch ?? 'direct').join(', ')}`);
  assert.deepEqual(tools.commits.map((c) => c.hash), [k.c.tools1]);
  assert.deepEqual(tools.merges.map((m) => m.merge.hash), [k.c.toolsMerge]);
  assert.deepEqual(tools.trunkMerges.map((m) => m.hash), [k.c.trunkMerge], 'it reached the trunk with the integration branch');
  assert.deepEqual([tools.size.files, tools.size.byKind.code?.files, tools.size.byKind.test?.files], [2, 1, 1], 'its size, code and tests apart');
  assert.equal(tools.work, true);
  const fix = byBranch.get('k-ayfix-a')!;
  assert.deepEqual(fix.commits.map((c) => c.hash), [k.c.fixA1, k.c.fixA2]);
  assert.deepEqual(fix.names.map((x) => x.num).sort(), ['AY', 'B12', 'B13'], 'what its messages name');
  assert.deepEqual(fix.workNamed.map((w) => w.workId), ['thr_AY'], 'the work item those numbers are');
  assert.deepEqual(fix.workByFiles.map((w) => [w.workId, w.files]), [['thr_AP', 1]], 'AP’s own commits changed src/ledger.ts too: the work whose files it served');
  const own = byBranch.get('k-int')!;
  assert.deepEqual(own.commits.map((c) => c.hash), [k.c.intFix], 'the integration branch’s own commit, not what its merges brought');
  assert.deepEqual(own.merges.map((m) => m.merge.hash), [k.c.trunkMerge]);
});

test('the block lists each piece with what the step judges it from; a process link moves it to the tied, and says whether the work’s results name it', () => {
  const block = unnumberedWorkBlock(k.store, k.project, k.ledger);
  assert.match(block, /^=== Work merged without a task number/);
  assert.match(block, /\d+\. branch k-tools · kiln\n {3}merged: [0-9a-f]{7} 2026-09-04 12:00 “Merge branch 'k-tools' \(the clerk method's position writers\)”\n {3}reached the trunk with: [0-9a-f]{7} 2026-09-09 09:00 “Merge k-int: increment K/);
  assert.match(block, /size: 2 files, \+3 −0 \(code 1 file, \+1 −0 · tests 1 file, \+2 −0\)/);
  assert.match(block, /numbers its messages name: AY ×3, B12, B13\n {3}work items among them: AY Independent QC of increment K \(thr_AY\)/, 'its two commits and its merge name AY');
  assert.match(block, /- [0-9a-f]{7} 2026-09-07 09:00 Arrangements say how many rows they left out \(QC AY B13\)/);
  assert.match(block, /numbered work whose own commits changed the same files: AP The ledger \(thr_AP\) 1 file/);
  assert.doesNotMatch(block, /branch k-ledger/);

  // The round folds the fix package into AP as a Fix step.
  k.store.links.put({ id: 'link_fold', projectId: 'kiln', workId: 'thr_AP', ledgerRef: `commit:${k.c.fixAMerge.slice(0, 12)}`, stepKind: 'Fix', why: 'folded', basis: 'Inferred', confirmed: false, roundId: null, jobId: null, at: '2026-09-10T00:00:00Z' });
  const tied = unnumberedWorkBlock(k.store, k.project, k.ledger);
  assert.match(tied, /Already tied to a work item \(1\):\n- branch k-ayfix-a · kiln → AP The ledger \(thr_AP\) as Fix — its results do not name it yet/);
  assert.doesNotMatch(tied, /\d+\. branch k-ayfix-a/, 'no longer listed in full');
  k.store.threads.put({ ...thread('AP', 'The ledger'), projectId: 'kiln', results: 'Folded in: k-ayfix-a (the row cap now says how many rows it left out).' });
  assert.match(unnumberedWorkBlock(k.store, k.project, k.ledger), /- branch k-ayfix-a · kiln → AP The ledger \(thr_AP\) as Fix$/m, 'once its results name it, the owner’s rule is met');

  // A link on the trunk's merge of the whole integration branch ties nothing in particular.
  k.store.links.put({ id: 'link_trunk', projectId: 'kiln', workId: 'thr_AY', ledgerRef: `commit:${k.c.trunkMerge.slice(0, 12)}`, stepKind: 'Merged', why: 'landing', basis: 'Inferred', confirmed: false, roundId: null, jobId: null, at: '2026-09-10T00:00:00Z' });
  assert.match(unnumberedWorkBlock(k.store, k.project, k.ledger), /\d+\. branch k-int · kiln/, 'the integration branch’s own fix is still listed');

  // A Follow up: what was merged before the last round is one line each.
  const followUp = unnumberedWorkBlock(k.store, k.project, k.ledger, { since: '2026-09-08T00:00:00Z' });
  assert.match(followUp, /Merged before the last round and still tied to no work item \(\d+; [^)]*\):\n(?:- .*\n)*- branch k-tools · kiln · 1 commit/);
});

test('with no ledger, the block says so and lists nothing', () => {
  assert.match(unnumberedWorkBlock(k.store, k.project, null), /The ledger is not available, so no merged work was listed\./);
});
