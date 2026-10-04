// The List's blocks that open and close (Spec §6.3 `List`; E153): the top plate, each earlier generation's row, each
// module's block, the foundation's and the ring's start folded; what the owner opened is this browser's, per project,
// and survives storage that is missing or throws; `Expand all` opens every block the List draws and `Fold all` folds
// them all. And the styles that make a folded row one line and a folded block its head card. Pure, so checked here
// without a browser; the blocks themselves were looked at on the real page (CO's screenshots). An invented project
// ("Heron", a birdwatching log).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* eslint-disable @typescript-eslint/no-explicit-any */
const L: any = await import(new URL('../../ui/list-fold.js', import.meta.url).href);

/** A storage like the browser's, as far as the List uses it. */
const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, String(v)); }, map: m };
};
const HERON = [L.PLATE_KEY, L.generationKey('gen-notebook'), L.blockKey('maps'), L.blockKey('counts'), L.CROSS_KEY];

test('every block of the List starts folded: the plate, a generation, a module, the ring', () => {
  const fold = L.createListFold(memoryStorage());
  for (const key of HERON) assert.equal(fold.isOpen('heron', key), false, `${key} is folded`);
  assert.equal(fold.anyOpen('heron', HERON), false);
  assert.equal(fold.allOpen('heron', HERON), false);
  assert.equal(fold.allOpen('heron', []), false, 'no block drawn: nothing is "all open"');
  assert.deepEqual([L.PLATE_KEY, L.CROSS_KEY, L.blockKey('maps'), L.generationKey('g1')], ['plate', 'block:cross', 'block:maps', 'gen:g1'], 'a block goes by its area, a generation by its id');
});

test('what the owner opened is kept in this browser under its own key, per project, and read back after a reload', () => {
  const storage = memoryStorage();
  const fold = L.createListFold(storage);
  assert.equal(fold.toggle('heron', L.blockKey('maps')), true, 'a press on a folded head opens it');
  fold.set('heron', L.PLATE_KEY, true);
  assert.equal(fold.isOpen('heron', L.blockKey('maps')), true);
  assert.equal(fold.isOpen('heron', L.blockKey('counts')), false, 'and no other block');
  assert.equal(fold.isOpen('kestrel', L.blockKey('maps')), false, 'another project keeps its own');
  assert.equal(L.LIST_FOLD_KEY, 'pk.list.open', 'a key of the page, not of any project’s assets');
  assert.deepEqual(JSON.parse(storage.map.get(L.LIST_FOLD_KEY)!), { heron: ['block:maps', 'plate'] });
  // A reload, or a refresh of the view's data: a new page reads the same choice.
  const again = L.createListFold(storage);
  assert.equal(again.isOpen('heron', L.blockKey('maps')), true);
  assert.equal(again.isOpen('heron', L.PLATE_KEY), true);
  assert.equal(again.toggle('heron', L.blockKey('maps')), false, 'a press on an open head folds it');
  assert.equal(L.createListFold(storage).isOpen('heron', L.blockKey('maps')), false);
  // Setting a block to the state it is in writes nothing new.
  const before = storage.map.get(L.LIST_FOLD_KEY);
  again.set('heron', L.PLATE_KEY, true);
  assert.equal(storage.map.get(L.LIST_FOLD_KEY), before);
});

test('Expand all opens every block the List draws; Fold all folds every one, the ones no longer drawn too', () => {
  const storage = memoryStorage();
  const fold = L.createListFold(storage);
  fold.set('heron', L.blockKey('gone'), true);   // a module the project no longer has
  fold.set('kestrel', L.PLATE_KEY, true);
  fold.setAll('heron', HERON, true);
  assert.equal(fold.allOpen('heron', HERON), true);
  for (const key of HERON) assert.equal(fold.isOpen('heron', key), true);
  fold.setAll('heron', HERON, false);
  assert.equal(fold.anyOpen('heron', [...HERON, L.blockKey('gone')]), false, 'nothing stale is kept');
  assert.equal(fold.isOpen('kestrel', L.PLATE_KEY), true, 'another project is left alone');
  assert.deepEqual(JSON.parse(storage.map.get(L.LIST_FOLD_KEY)!), { kestrel: ['plate'] });
});

test('without storage, with storage that throws, or with something else under the key, the choice holds on the page and nothing breaks', () => {
  const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  const notOurs = [memoryStorage(), memoryStorage(), memoryStorage()];
  notOurs[0]!.setItem(L.LIST_FOLD_KEY, 'not json');
  notOurs[1]!.setItem(L.LIST_FOLD_KEY, '["block:maps"]');
  notOurs[2]!.setItem(L.LIST_FOLD_KEY, '{"heron":"block:maps","kestrel":[1,"plate"]}');
  for (const storage of [null, throwing, ...notOurs]) {
    const fold = L.createListFold(storage);
    assert.equal(fold.isOpen('heron', L.blockKey('maps')), false, 'every block folded');
    assert.doesNotThrow(() => fold.set('heron', L.blockKey('maps'), true));
    assert.equal(fold.isOpen('heron', L.blockKey('maps')), true, 'remembered on this page');
    assert.doesNotThrow(() => fold.setAll('heron', HERON, false));
    assert.equal(fold.isOpen('heron', L.blockKey('maps')), false);
  }
  assert.equal(L.createListFold(notOurs[2]).isOpen('kestrel', L.PLATE_KEY), true, 'what is ours in it is read; the rest is passed over');
});

test('the List’s styles: a folded row is one line on each side, a folded block is its head card, the plate one line (E153)', () => {
  const css = readFileSync(new URL('../../ui/k-process.css', import.meta.url), 'utf8');
  const rule = (selector: string) => { const i = css.indexOf(`\n${selector}{`); assert.ok(i >= 0, `${selector} has a rule`); return css.slice(i + selector.length + 2, css.indexOf('}', i)); };
  // One line on each side: nothing wraps, the two halves share the row and may shrink below their words.
  assert.match(rule('.wrow .wr-left,.wrow .wr-right'), /white-space:nowrap/);
  assert.match(rule('.wrow .wr-left,.wrow .wr-right'), /line-height:20px/);
  assert.match(rule('.wrow .row2'), /grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
  assert.equal(rule('.wrow'), 'padding:6px 0', 'a line of 20px and 6px above and below: about 33px a row with its separator');
  // The sentence is cut to the line; the steps note gives way before the name; tags and marks are never cut.
  assert.match(rule('.wrow .wr-right>.say'), /overflow:hidden;text-overflow:ellipsis/);
  assert.match(rule('.wrow .wr-left>.wr-steps,.wrow .wr-left>.wr-why'), /flex:0 1000 auto;min-width:0;overflow:hidden;text-overflow:ellipsis/);
  assert.match(rule('.wrow .wr-name .text-btn'), /overflow:hidden;text-overflow:ellipsis;white-space:nowrap/);
  assert.match(rule('.wrow .wr-left>*,.wrow .wr-right>*'), /flex:none/);
  // Opened, the sentence is whole.
  assert.match(rule('details.wrow[open]>summary .wr-right'), /white-space:normal/);
  // No blank line between rows beyond the separator.
  assert.match(rule('.ab-body>.wrow'), /margin-top:0/);
  assert.doesNotMatch(css, /\.wrow \.sumline/, 'no second line under a row');
  // A folded block is its head card alone; its body is not drawn; the head says it can be pressed.
  assert.match(rule('.ab-body[hidden],.plate-body[hidden]'), /display:none/);
  assert.match(rule('.ablock[data-open="false"]'), /padding:0/);
  assert.match(rule('.ablock[data-open="false"]>.ab-head.lane>.intent-basis'), /display:none/);
  assert.match(rule('.ablock[data-open="false"]>.ab-head.lane>.lane-sub'), /white-space:nowrap/);
  assert.match(rule('[data-fold-head]'), /cursor:pointer/);
  assert.match(css, /\[data-fold-head\]:focus-visible\{outline:/, 'the focused head shows it');
  // The ring keeps its ring folded.
  assert.match(rule('.ablock.cross[data-open="false"]'), /border:1\.5px solid/);
  // The plate folded: one line, without its inlay and rivets, with the product's name and what it holds.
  assert.match(rule('.list-plate[data-open="false"]::before,.list-plate[data-open="false"]>.rivet'), /display:none/);
  assert.match(rule('.plate-head>.plate-brief,.plate-head>.plate-holds'), /display:none/, 'open, the title line stands alone');
  assert.match(rule('.list-plate[data-open="false"]>.plate-head>.plate-brief'), /display:block;[^}]*text-overflow:ellipsis;white-space:nowrap/);
});
