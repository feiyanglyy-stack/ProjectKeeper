// The Project graph's control row (Spec §6.1 "顶上的控件只占一行", §6.3 "控件放在哪" and "可读性自检 · 在哪里说"; CKC-09
// AC-37): what the `Filter` button says, which filters count as in force, and the number on the readability mark. The
// sums are pure, so they are checked here without a browser; scripts/ui-s3-check.mjs measures the row on the real page.
// The interface is plain ES modules without types, so they are loaded at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-explicit-any */
const tools: any = await import(new URL('../../ui/graph-tools.js', import.meta.url).href);

const NONE = { category: '', validity: '', progress: '', acceptance: '', assessment: '', withNotes: false, recent: false, attention: false };

// ── Filter ───────────────────────────────────────────────────────────────
test('with nothing chosen no filter is in force and the button says Filter', () => {
  assert.deepEqual(tools.activeFilters(NONE), []);
  assert.equal(tools.filterLabel(0), 'Filter');
  assert.deepEqual(tools.activeFilters(undefined), [], 'a view that has no filter state yet');
});

test('each of the five choices and the three ticks counts once, and the button carries the number (AC-37)', () => {
  const f = { ...NONE, category: 'Work item', progress: 'Done' };
  assert.deepEqual(tools.activeFilters(f).map((x: any) => x.key), ['category', 'progress']);
  assert.equal(tools.filterLabel(tools.activeFilters(f).length), 'Filter · 2');
  const all = { category: 'Goal', validity: 'Current', progress: 'Planned', acceptance: 'Accepted', assessment: 'Holds', withNotes: true, recent: true, attention: true };
  assert.equal(tools.activeFilters(all).length, 8);
  assert.deepEqual(tools.activeFilters(all).map((x: any) => `${x.label}: ${x.value}`), ['Category: Goal', 'Validity: Current', 'Progress: Planned', 'Acceptance: Accepted', 'Assessment: Holds', 'With notes: on', '★ only: on', '❓ Waiting on you: on']);
});

test('the ❓ count of the drawer is a filter like the ticks: counted on the button, put out of force by Clear, its ids left for the page (Spec §6.2, D100)', () => {
  const f = { ...NONE, attention: true, attentionIds: ['n1', 'n2'] };
  assert.deepEqual(tools.activeFilters(f).map((x: any) => x.key), ['attention']);
  assert.equal(tools.filterLabel(tools.activeFilters(f).length), 'Filter · 1');
  tools.clearFilters(f);
  assert.equal(f.attention, false);
  assert.deepEqual(f.attentionIds, ['n1', 'n2'], 'the objects come from the overview, kept for the next press');
});

test('what only changes how the picture is drawn is not a filter: replaced & deferred, the period the stars mark, how links are drawn', () => {
  // These add to the picture or change a mark; none of them can take an object off it, so none is counted.
  const f = { ...NONE, showReplaced: true, starMode: 'days', links: 'lines' };
  assert.deepEqual(tools.activeFilters(f), []);
});

test('clearing gives back a filter state with nothing in force, and leaves what is not a filter alone', () => {
  const f = { category: 'Goal', validity: '', progress: 'Done', acceptance: '', assessment: 'Questioned', withNotes: true, recent: true, attention: true, showReplaced: true };
  const cleared = tools.clearFilters(f);
  assert.equal(cleared, f, 'the same object: the graph holds a reference to it');
  assert.deepEqual(tools.activeFilters(f), []);
  assert.equal(f.showReplaced, true);
  assert.deepEqual({ ...f, showReplaced: undefined }, { ...NONE, showReplaced: undefined });
});

// ── The readability mark ─────────────────────────────────────────────────
const overlap = { kind: 'overlap', count: 5, pairs: [['a', 'b'], ['b', 'c'], ['d', 'e']], text: '5 objects sit on top of each other in 3 places' };
const behind = { kind: 'behind', count: 4, worst: [], text: '4 lines of 90 run behind objects they do not connect' };
const size = { kind: 'size', count: 119, text: 'Fitted to the window, names would be 7.2px' };
const bundle = { kind: 'bundle', count: 2, hubs: [{ id: 'x', degree: 25 }, { id: 'y', degree: 21 }], text: '2 objects with 20 or more lines meeting on them' };

test('a readable picture: the mark says 0, quietly, and its hover says nothing is hard to read', () => {
  const m = tools.readabilityMark({ issues: [], nodes: 12, edges: 9 });
  assert.equal(m.count, 0);
  assert.equal(m.text, '◐ 0');
  assert.match(m.title, /nothing .* hard to read/i);
  assert.deepEqual(m.kinds, []);
  assert.equal(tools.readabilityMark(null).count, 0, 'before the first check has run');
});

test('the number is the places that are hard to read, added up over the kinds of problem (AC-37)', () => {
  // A place is: a pair of objects on top of each other, a line behind an object, an object where lines bunch, and the
  // picture itself when it cannot be read at once. Not the number of objects in the picture (`size.count` is 119).
  assert.equal(tools.readabilityMark({ issues: [size] }).count, 1);
  assert.equal(tools.readabilityMark({ issues: [overlap] }).count, 3);
  const m = tools.readabilityMark({ issues: [overlap, behind, size, bundle] });
  assert.equal(m.count, 3 + 4 + 1 + 2);
  assert.equal(m.text, '◐ 10');
  assert.deepEqual(m.kinds.map((k: any) => [k.label, k.places]), [['On top of each other', 3], ['Lines behind objects', 4], ['Too big to read at once', 1], ['Bunched lines', 2]]);
});

test('the hover names every kind of problem found, with its places, and says nothing was hidden', () => {
  const m = tools.readabilityMark({ issues: [behind, size] });
  assert.match(m.title, /Hard to read in 5 places/);
  assert.match(m.title, /Lines behind objects 4/);
  assert.match(m.title, /Too big to read at once/);
  assert.doesNotMatch(m.title, /On top of each other|Bunched lines/);
  assert.match(m.title, /nothing is hidden/i);
  assert.match(tools.readabilityMark({ issues: [size] }).title, /Hard to read in 1 place\b/);
});
