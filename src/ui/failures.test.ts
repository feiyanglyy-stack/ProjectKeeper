// What intake could not take in, as the top bar counts it and its list shows it (CKC-07 AC-10; owner 2026-09-30: "2
// failed" was one archive page recorded twice, and nothing opened when it was pressed). A file too large to read is not
// a failure (D105; owner 2026-10-02: 「超过 2 MB 的上限 这个不要红色的」): skipped, listed in Project scope, counted
// nowhere in the top bar. Pure, so checked without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-explicit-any */
const F: any = await import(new URL('../../ui/failures.js', import.meta.url).href);

const REF = 'D:\\orchard\\subagent\\archive\\real-project-graph-20260917.html';

test('the same ref counts once, the latest kept, across scopes; newest first — and a file too large to read is not among the failures', () => {
  const coverage = { scopes: [
    { id: 'project', label: 'ContextKeeper', failed: [
      { ref: REF, reason: 'larger than 2000000 bytes', at: '2026-09-30T17:33:26.418Z' },
      { ref: 'D:\\orchard\\a.md', reason: 'unreadable', at: '2026-09-30T17:35:00.000Z' },
      { ref: 'D:\\orchard\\a.md', reason: 'unreadable: EPERM', at: '2026-09-30T17:41:00.000Z' },
      { ref: REF, reason: 'larger than 2000000 bytes', at: '2026-09-30T17:40:12.298Z' },
    ] },
    { id: 'other', label: 'Other', failed: [{ ref: REF, reason: 'larger than 2000000 bytes', at: '2026-09-30T17:20:00.000Z' }, { ref: 'D:\\orchard\\b.jsonl', reason: 'session unreadable: bad line', at: '2026-09-30T17:10:00.000Z' }] },
  ] };
  const list = F.failuresOf(coverage);
  assert.deepEqual(list.map((f: any) => [f.ref, f.reason, f.scope]), [['D:\\orchard\\a.md', 'unreadable: EPERM', 'ContextKeeper'], ['D:\\orchard\\b.jsonl', 'session unreadable: bad line', 'Other']], 'what really failed, one entry per file, the latest, newest first');
  assert.deepEqual(F.failuresOf(null), []);
  assert.deepEqual(F.failuresOf({ scopes: [{ id: 'project', failed: [] }] }), []);
  // The home of 2026-10-02: its one "failed" was the archive page over the limit. The top bar counts none.
  assert.deepEqual(F.failuresOf({ scopes: [{ id: 'project', label: 'ContextKeeper', failed: [{ ref: REF, reason: 'larger than 2000000 bytes', at: '2026-10-02T20:16:53.475Z' }] }] }), [], 'nothing failed: the count is 0 and the red button stays hidden');
});

test('a file too large to read is skipped: one entry per file with its size and the limit, also from a home that still lists it as failed', () => {
  // A home written before D105 holds it among its failures: read as skipped all the same, size not recorded.
  const old = { scopes: [{ id: 'project', label: 'ContextKeeper', failed: [
    { ref: REF, reason: 'larger than 2000000 bytes', at: '2026-09-30T17:33:26.418Z' },
    { ref: REF, reason: 'larger than 2000000 bytes', at: '2026-10-02T20:16:53.475Z' },
    { ref: 'D:\\orchard\\a.md', reason: 'unreadable', at: '2026-09-30T17:35:00.000Z' },
  ] }] };
  assert.deepEqual(F.skippedOf(old), [{ ref: REF, bytes: null, limit: 2_000_000, at: '2026-10-02T20:16:53.475Z', scope: 'ContextKeeper' }]);
  assert.equal(F.skippedText(F.skippedOf(old)[0]), 'size not recorded · the most intake reads of one file is 2 MB (2,000,000 bytes)');
  // As the server records it now: apart from the failures, with the size.
  const now = { scopes: [{ id: 'project', label: 'ContextKeeper', failed: [], skipped: [
    { ref: REF, bytes: 2_412_345, limit: 2_000_000, at: '2026-10-02T21:00:00.000Z' },
    { ref: 'D:\\orchard\\dump.json', bytes: 9_000_000, limit: 2_000_000, at: '2026-10-02T21:05:00.000Z' },
  ] }] };
  assert.deepEqual(F.skippedOf(now).map((s: any) => [s.ref, s.bytes]), [['D:\\orchard\\dump.json', 9_000_000], [REF, 2_412_345]], 'newest first');
  assert.equal(F.skippedText(F.skippedOf(now)[1]), '2.4 MB (2,412,345 bytes) · the most intake reads of one file is 2 MB (2,000,000 bytes)');
  assert.deepEqual(F.failuresOf(now), []);
  // Both at once (a home between two passes): the later entry of a file stands.
  const both = { scopes: [{ id: 'project', label: 'P', failed: [{ ref: REF, reason: 'larger than 2000000 bytes', at: '2026-10-02T20:16:53.475Z' }], skipped: [{ ref: REF, bytes: 2_412_345, limit: 2_000_000, at: '2026-10-02T21:00:00.000Z' }] }] };
  assert.deepEqual(F.skippedOf(both).map((s: any) => [s.ref, s.bytes]), [[REF, 2_412_345]]);
  assert.deepEqual(F.skippedOf(null), []);
  assert.equal(F.sizeText(2_000_000), '2 MB (2,000,000 bytes)');
  assert.equal(F.sizeText(null), 'size not recorded');
});

test('the reason reads in words, and the path under the project location it lies in', () => {
  assert.equal(F.reasonText('larger than 2000000 bytes'), 'larger than 2 MB (2,000,000 bytes), the most intake reads of one file');
  assert.equal(F.reasonText('could not decode'), 'could not decode');
  assert.equal(F.shortRef(REF, ['D:\\orchard']), 'subagent/archive/real-project-graph-20260917.html');
  assert.equal(F.shortRef(REF, ['D:\\orchard-other']), REF, 'a location that is only a prefix of the name does not count');
  assert.equal(F.shortRef(REF, []), REF);
});
