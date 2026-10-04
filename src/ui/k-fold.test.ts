// The fold rule of the process view and what a folded work says (CKC-24 AC-11, AC-12; D75; E152, E153): every work
// starts folded, in the List and on the Graph alike, with the count of its steps and of what is open on it; what the
// owner opens or folds is one choice for both; a folded block of the List says what is still open inside it. And a
// work item's copy in another module is a pale ghost of the solid card (E152, E153). An invented project ("Heron", a
// birdwatching log).
// The interface is plain ES modules without types, so they are loaded at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ui = (name: string) => new URL(`../../ui/${name}`, import.meta.url);
const F: any = await import(ui('k-fold.js').href);
const graph: any = await import(ui('graph.js').href);

const step = (id: string, kind: string) => ({ id, kind, did: kind, result: '', who: null, evidence: [], basis: 'Explicit', history: false, sendBackId: null });
const work = (steps: number, extra: any = {}) => ({
  steps: Array.from({ length: steps }, (_, i) => step(`s${i}`, ['Planned', 'Dispatched', 'Delivered', 'QC', 'Fix', 'Merged'][i % 6]!)),
  four: { execution: 'Merged', progress: 'Done', check: { verdict: 'Pass', by: 'Independent QC' }, open: { findings: 0, sendBacks: 0, breakpoints: 0 } },
  stepOf: null, breakpointIds: [], sendBackIds: [], ...extra,
});
/** Ring counts (done, five steps), Nest map (in progress, a send-back and two findings open), a one-step item, a QC folded under Ring counts, a plan. */
function heron() {
  return {
    works: {
      ring: work(5),
      nest: work(7, { four: { execution: 'In progress', progress: 'In progress', check: 'Not checked', open: { findings: 2, sendBacks: 1, breakpoints: 0 } } }),
      tide: work(1, { four: { execution: 'Not started', progress: 'Planned', check: null, open: { findings: 0, sendBacks: 0, breakpoints: 0 } } }),
      ringQc: work(2, { stepOf: 'ring', four: { execution: 'Merged', progress: 'Done', check: null, open: { findings: 1, sendBacks: 0, breakpoints: 1 } } }),
      season: work(0, { four: { execution: null, progress: 'In progress', check: null, open: { findings: 0, sendBacks: 0, breakpoints: 0 } } }),
    },
    plans: { season: { batches: [{ label: '1', workIds: ['ring'] }, { label: '2', workIds: ['nest'] }, { label: '3', workIds: ['tide'] }] } },
  };
}

test('every work starts folded, in the List and on the Graph alike — work in progress too (E152, E153; D75)', () => {
  const proc = heron();
  const fold = F.createFold(() => proc);
  for (const id of ['ring', 'nest', 'season']) assert.equal(fold.has(id), false, `${id} is folded`);
  assert.equal(fold.expandable('nest'), true);
  assert.equal(fold.expandable('season'), true, 'a plan with an execution shape opens to its batches');
  assert.equal(fold.expandable('tide'), false, 'one step is one line: nothing to open');
  assert.equal(fold.expandable('ringQc'), false, 'a check folded under its work is no unit of its own');
  assert.equal(fold.any(), true);
  assert.equal(fold.anyOpen(), false);
  assert.equal(fold.allExpanded(), false);
  // Nothing to read yet: nothing is open, and Expand all has nothing to act on.
  const empty = F.createFold(() => null);
  assert.equal(empty.has('ring'), false);
  assert.equal(empty.any(), false);
  empty.setAll(true);
  assert.equal(empty.allExpanded(), false);
});

test('a click opens that item, the same choice on both surfaces; Expand all opens all; Fold all folds every one again', () => {
  const proc = heron();
  const fold = F.createFold(() => proc);
  fold.toggle('ring');
  assert.equal(fold.has('ring'), true, 'a click opens that work’s process — its branch on the Graph, its Process · Outcome in the List');
  assert.equal(fold.has('nest'), false, 'and no other work');
  assert.equal(fold.anyOpen(), true);
  fold.toggle('ring');
  assert.equal(fold.has('ring'), false);
  // A row of the List tells its own state when it toggles.
  fold.set('nest', true);
  assert.equal(fold.has('nest'), true);
  fold.set('nest', false);
  assert.equal(fold.has('nest'), false);
  fold.setAll(true);
  assert.equal(fold.allExpanded(), true);
  for (const id of ['ring', 'nest', 'season']) assert.equal(fold.has(id), true);
  fold.setAll(false);
  for (const id of ['ring', 'nest', 'season']) assert.equal(fold.has(id), false, 'folded again: every work, work in progress too');
  assert.equal(fold.anyOpen(), false);
  // The fold is the page's: another project's view starts folded.
  fold.toggle('ring');
  fold.reset();
  assert.equal(fold.has('ring'), false);
});

test('a folded work says how many steps it holds and whether anything is open; what is open is counted for its top edge', () => {
  const proc = heron();
  assert.equal(F.foldLine(proc, 'ring'), '5 steps · all closed · Pass · Merged');
  assert.equal(F.foldLine(proc, 'nest'), '7 steps · ⚠ 3 open · Not checked');
  assert.equal(F.foldLine(proc, 'season'), '3 batches · all closed');
  assert.equal(F.foldLine(proc, 'tide'), 'Planned · Not started', 'a work with nothing to open keeps its four things');
  assert.equal(F.foldLine(proc, 'ringQc'), null);
  assert.equal(F.foldLine(proc, 'nobody'), null);
  assert.deepEqual(F.openMark(proc, 'nest'), { count: 3, text: '1 send-back open · 2 findings still open' });
  assert.deepEqual(F.openMark(proc, 'ring'), { count: 2, text: '1 breakpoint lit · 1 finding still open' }, 'what a check folded under it has open counts on the work');
  assert.equal(F.openMark(proc, 'tide'), null);
  assert.equal(F.openMark(proc, 'ringQc'), null);
});

test('a folded block of the List says what is still open inside it: over its work rows and on the objects it holds (D75; E153)', () => {
  const proc: any = heron();
  proc.sendBacks = [
    { id: 'sb1', targetId: 'reqNests', stage: 'Returned', lit: true },
    { id: 'sb2', targetId: 'reqNests', stage: 'Closed', lit: false },
    { id: 'sb3', targetId: 'nest', stage: 'Suggested', lit: true },   // on a work: counted through the work, not again
    { id: 'sb4', targetId: 'tide', stage: 'Suggested', lit: true },   // a work the block does not draw
  ];
  proc.breakpoints = [{ id: 'bp1', targetId: 'areaMaps', lit: true }, { id: 'bp2', targetId: 'areaMaps', lit: false }, { id: 'bp3', targetId: 'decOld', lit: true }];
  assert.deepEqual(F.openInside(proc, { works: ['ring', 'nest'], objects: ['areaMaps', 'reqNests'] }), { count: 7, text: '2 send-backs open · 2 breakpoints lit · 3 findings still open' },
    'ring with the check under it (1 breakpoint, 1 finding), nest (1 send-back, 2 findings), the requirement’s open send-back, the area’s lit breakpoint');
  assert.deepEqual(F.openInside(proc, { works: ['ring'], objects: [] }), F.openMark(proc, 'ring'), 'one work: what its own count says');
  assert.deepEqual(F.openInside(proc, { works: ['nest', 'nest'], objects: ['nest', 'ringQc', 'tide'] }), { count: 3, text: '1 send-back open · 2 findings still open' },
    'an id named twice counts once; a work is counted only where it is drawn as a row');
  assert.deepEqual(F.openInside(proc, { works: ['ring'], objects: ['ringQc'] }), F.openMark(proc, 'ring'), 'a check folded under a drawn work is counted with that work, once');
  assert.equal(F.openInside(proc, { works: ['tide', 'season'], objects: ['reqQuiet'] }), null, 'nothing open inside: nothing is said');
  assert.equal(F.openInside(null, { works: ['ring'] }), null);
  assert.equal(F.openInside(proc), null);
});

test('the count of what is open is drawn on the work item, and only when something is open', () => {
  const n = { id: 'nest', category: 'Work item', label: 'HB-2 · Nest map', validity: 'Current', progress: 'In progress', noteCount: 0 };
  const pic = (o: any) => decodeURIComponent(graph.objectImage(n, 228, 60, o).uri);
  const withOpen = pic({ procLine: '7 steps · ⚠ 3 open', open: { count: 3, text: '1 send-back open · 2 findings still open' } });
  assert.match(withOpen, /data-open="3"/);
  assert.match(withOpen, new RegExp(`>${graph.OPEN_SIGN} 3<`));
  assert.match(withOpen, />7 steps · ⚠ 3 open</, 'the compact summary is the second line');
  assert.doesNotMatch(pic({ procLine: '5 steps · all closed' }), /data-open=/);
});

test('a copy is a pale ghost of the solid card: its fill kept, its words, material and frame faded; readable when pointed at or selected; still dashed', () => {
  const style: any[] = graph.graphStyle(graph.currentPalette());
  const last = (selector: string, key: string) => style.filter((x) => x.selector === selector && key in x.style).pop()?.style[key];
  // At rest: the card's own fill, a little let through — never the whole card faded, which reads dark on a dark ground (E153).
  assert.equal(last('node.copy', 'opacity'), 1);
  assert.equal(last('node.copy', 'background-opacity'), graph.COPY_GHOST.fill);
  assert.ok(graph.COPY_GHOST.fill >= 0.85 && graph.COPY_GHOST.fill < 1, 'the fill stays the card’s own, nearly whole');
  assert.deepEqual(last('node.copy', 'background-image-opacity'), [graph.COPY_GHOST.words, graph.COPY_GHOST.material], 'its words and its material fade');
  assert.equal(graph.COPY_GHOST.words, graph.COPY_OPACITY.rest);
  assert.ok(graph.COPY_OPACITY.rest <= 0.55, 'clearly weaker than the solid one (1)');
  assert.ok(last('node.copy', 'border-opacity') <= 0.65, 'and its frame');
  assert.equal(last('node.copy', 'border-style'), 'dashed');
  // Selected or pointed at, it comes forward: the fill and the frame whole, the words readable.
  for (const [selector, words] of [['node.copy.copy-sel', graph.COPY_OPACITY.selected], ['node.copy.copy-hover', graph.COPY_OPACITY.hover]] as const) {
    assert.equal(last(selector, 'background-opacity'), 1);
    assert.equal(last(selector, 'border-opacity'), 1);
    assert.ok(words >= 0.85);
    assert.deepEqual(last(selector, 'background-image-opacity'), [words, 1]);
  }
  assert.deepEqual(last('node.copy.hit', 'background-image-opacity'), [1, 1]);
  assert.ok(last('node.copy.faded', 'opacity') < 0.2, 'a focus elsewhere fades it with the rest');
  // The copy's own strength comes after the scales' (`near`), so being near a focus changes nothing on a copy.
  const at = (selector: string) => style.findIndex((x) => x.selector === selector && 'opacity' in x.style);
  assert.ok(at('node.copy') > at('node.near'));
  assert.equal(style.filter((x) => x.selector === 'node' && 'opacity' in x.style).length, 0, 'the solid one keeps full strength');
  // The List's copy row has no fill to keep: its words and dashed frame fade as the card's do.
  const css = readFileSync(new URL('../../ui/k-process.css', import.meta.url), 'utf8');
  const rule = /\.wrow\.shared-copy\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /border:1px dashed/);
  assert.equal(Number(/opacity:([\d.]+)/.exec(rule)?.[1]), graph.COPY_OPACITY.rest, 'as faded as the card’s words');
  assert.match(css, /\.wrow\.shared-copy:hover[^{]*\{opacity:\.9/);
});
