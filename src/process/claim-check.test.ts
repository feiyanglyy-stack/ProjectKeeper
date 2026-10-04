/**
 * What a claim that something was not handled is checked against (test-C-1: "AY B13 … at least six low-severity items …
 * no handling at all", while commits naming "QC AY B13" had handled two of them): the items a "let pass" or "dropped"
 * candidate names, and every later commit (with its merges) and later document line that names them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Breakpoint } from '../model/k-types.ts';
import { breakpointClaims, claimCheckBlock, claimItems, claimLines } from './claim-check.ts';
import { buildKiln } from './increment.test-helpers.ts';

const k = buildKiln();
const short = (h: string) => h.slice(0, 7);

test('the lines of a text that claim something was not handled, let pass or dropped', () => {
  const text = [
    '## Present now',
    '- docs/PLAN.md:3 names the conveyor.',
    '### (c)-2 · AY 的 B13 低危项：部分无逐项处置记录',
    'E124 与 E127 点名修掉了一批（c96d40e、17bcebd）。',
    'AY 自己把 B13 归为「记下即可」，E127 之后无人再翻。',
    '- F-3 was let pass: no follow-up after the QC.',
  ].join('\n');
  assert.deepEqual(claimLines(text), [
    '### (c)-2 · AY 的 B13 低危项：部分无逐项处置记录',
    'AY 自己把 B13 归为「记下即可」，E127 之后无人再翻。',
    '- F-3 was let pass: no follow-up after the QC.',
  ], 'the claim lines, not the evidence cited around them');
  assert.deepEqual(claimLines('one\ntwo', true), ['one', 'two'], 'a program candidate is a claim as a whole');
});

test('the items a claim names: a task’s items with the task, task numbers, and ids one report defines', () => {
  const tasks = new Set(['AY', 'AA', 'AB', 'CKC-07', 'B3']);
  const known = (n: string) => ['B3', 'B13', 'AC-10', 'E127', 'F-3'].includes(n);
  const alone = (n: string) => n === 'F-3';
  const items = claimItems([
    { from: 'r1', text: '### AY 的 B13 低危项：无任何处置' },
    { from: 'r2', text: '- 提交 c96d40e「QC AY B3, B13」之后没人再修' },
    { from: 'r3', text: 'AA、AB 都没修；CKC-07 AC-10 从不亮，无人接' },
    { from: 'r4', text: 'E127 记下的缺口无人接；F-3 no follow-up' },
  ], tasks, known, alone);
  const labels = items.map((i) => i.label).sort();
  assert.deepEqual(labels, ['AA', 'AB', 'AY B13', 'AY B3', 'CKC-07 AC-10', 'F-3'], `B3 after AY is AY’s item though B3 also names a batch; AA and AB are two tasks; E127 on its own is evidence, not a report’s item: ${labels.join(', ')}`);
  assert.deepEqual([...items.find((i) => i.label === 'AY B13')!.from].sort(), ['r1', 'r2']);
});

test('the block: for AY B13, the report line that states it and every later commit that names it, with its branch and merges', () => {
  const claim = { from: 'rdoc_sweep (Report)', text: '### (c)-2 · AY 的 B13 低危项：行数截断与语言级 basis 无任何处置' };
  const block = claimCheckBlock(k.store, k.ledger, [claim], { what: 'this round’s sweep reports' });
  assert.match(block, /^=== Before you write that something was not handled/);
  assert.match(block, /- AY B13 \(an item of AY's report or QC\) — named in rdoc_sweep \(Report\)/);
  assert.match(block, /first stated: subagent\/runs\/AY-1\/result\.md:\d+ \(2026-09-06 09:00; num:[0-9a-f]+\): “\*\*B13 · 其余低危项\*\*/);
  assert.match(block, new RegExp(`later commits naming it \\(1\\):\\n  · ${short(k.c.fixA1)} 2026-09-07 09:00 “Arrangements say how many rows they left out \\(QC AY B13\\)” — branch k-ayfix-a, merged ${short(k.c.fixAMerge)} 2026-09-08 09:00, into the trunk with ${short(k.c.trunkMerge)}`));
  assert.doesNotMatch(block, new RegExp(short(k.c.fixA2)), 'the commit for B12 does not name B13');
});

test('an item nothing later names says so; a text with no such claim gives no list', () => {
  const block = claimCheckBlock(k.store, k.ledger, [{ from: 'note_x', text: 'AY 的 B11 无人处理' }], { what: 'what this round wrote' });
  assert.match(block, /- AY B11 \(an item of AY's report or QC\)[^\n]*\n  first stated: subagent\/runs\/AY-1\/result\.md:\d+[^\n]*\n  nothing later names it: no commit message, no later line of a document\./);
  assert.match(claimCheckBlock(k.store, k.ledger, [{ from: 'r', text: 'Everything was merged and checked.' }], { what: 'x' }), /No candidate there says that something was not handled, let pass or dropped\./);
  assert.match(claimCheckBlock(k.store, null, [{ from: 'r', text: 'AY B13 无人处理' }], { what: 'x' }), /The ledger is not available/);
});

test('the program’s own let-pass and dropped breakpoints are candidates as a whole', () => {
  const bp = { id: 'bp_1', projectId: 'kiln', kind: 'Findings open', targetId: 'thr_AY', why: 'AY’s B13 has no later trace', evidence: [{ kind: 'ledger', id: 'num:x', label: 'subagent/runs/AY-1/result.md:7', line: '**B13 · 其余低危项**' }], basis: 'Explicit', since: { at: '2026-09-06', basis: 'Commit', anchor: null }, lit: true, out: null, ownerResponse: null, confirmedInRoundId: null, sixThing: 5, sendBackId: null, roundId: null, updatedAt: '' } as Breakpoint;
  k.store.breakpoints.put(bp);
  k.store.breakpoints.put({ ...bp, id: 'bp_2', kind: 'Downstream behind' });
  // D99: the program's own computation is a candidate until a lane looked and the spot-check lit it; it is just as much
  // a "nothing handled it" to check against the later commits. What is out is no claim any more.
  k.store.breakpoints.put({ ...bp, id: 'bp_3', kind: 'Passed with open items', lit: false });
  k.store.breakpoints.put({ ...bp, id: 'bp_4', kind: 'Fix not re-checked', lit: false, out: { at: '2026-09-07', by: 'evidence', evidence: [] } });
  const claims = breakpointClaims(k.store);
  assert.deepEqual(claims.map((c) => c.from), ['bp_1', 'bp_3'], 'only the kinds that are let pass or dropped along the way, lit or candidate');
  assert.match(claims[0]!.text, /^Findings open on AY Independent QC of increment K: AY’s B13 has no later trace/);
  assert.match(claims[1]!.text, /^Passed with open items \(candidate\) on AY/);
});
