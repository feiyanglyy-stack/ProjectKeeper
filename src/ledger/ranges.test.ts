/**
 * CM (E151; CK fix 14): number ranges as projects write them are expanded where what later names a number is looked up —
 * the gated run's spot-check wrote 「AC-31 无人接」 although `3431e93` is titled 「(CKC-03 AC-25-AC-31)」.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandRanges, familyPrefix, rangeCovers, rangeMembers, rangesIn } from './ranges.ts';
import { claimItems } from '../process/claim-check.ts';

test('the ranges a text writes: hyphen, en dash, tilde, 到; the second end with or without the letters', () => {
  assert.deepEqual(rangeMembers('(CKC-03 AC-25-AC-31)'), ['AC-25', 'AC-26', 'AC-27', 'AC-28', 'AC-29', 'AC-30', 'AC-31']);
  assert.deepEqual(rangeMembers('E95～E101 收下'), ['E95', 'E96', 'E97', 'E98', 'E99', 'E100', 'E101']);
  assert.deepEqual(rangeMembers('CKC-22～27'), ['CKC-22', 'CKC-23', 'CKC-24', 'CKC-25', 'CKC-26', 'CKC-27']);
  assert.deepEqual(rangeMembers('D13–D18 解决'), ['D13', 'D14', 'D15', 'D16', 'D17', 'D18']);
  assert.deepEqual(rangeMembers('R-35 到 R-39'), ['R-35', 'R-36', 'R-37', 'R-38', 'R-39']);
  assert.deepEqual(rangeMembers('CKC-01～CKC-05'), ['CKC-01', 'CKC-02', 'CKC-03', 'CKC-04', 'CKC-05'], 'the width as written');
  assert.deepEqual(rangeMembers('2026-09-30, D5-D3, AC-1-CKC-4, D1-D900'), [], 'no date, no backward span, no two families, no span too wide');
  assert.equal(rangeCovers('(CKC-03 AC-25-AC-31)', 'AC-31'), true);
  assert.equal(rangeCovers('(CKC-03 AC-25-AC-31)', 'AC-32'), false);
  assert.equal(rangesIn('see AC-25-AC-31 and E1～E3')[1]!.prefix, 'E');
  assert.equal(expandRanges('QC AY B3～B5 无人处理'), 'QC AY B3, B4, B5 无人处理');
  assert.deepEqual(['AC-31', 'E101', 'CK-M2', 'AA'].map(familyPrefix), ['AC-', 'E', 'CK-M', null]);
});

test('a claim that names a range names each of its members', () => {
  const items = claimItems([{ from: 'doc', text: 'CKC-03 AC-29～AC-31 无人接' }], new Set(['CKC-03']), () => true);
  assert.deepEqual(items.map((i) => i.label), ['CKC-03 AC-29', 'CKC-03 AC-30', 'CKC-03 AC-31']);
});
