// The graph's colours come from the theme (Spec §6.3, §6.16; CKC-09 AC-41): a palette read from CSS variables with the
// factory values as fallbacks, and the material a theme lends the nodes drawn into their SVG pictures. Both are pure,
// so they are checked here; scripts/ui-theme-check.mjs measures the result in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-explicit-any */
const pal: any = await import(new URL('../../ui/graph-palette.js', import.meta.url).href);
const mat: any = await import(new URL('../../ui/graph-material.js', import.meta.url).href);

const none = () => '';
const vars = (map: Record<string, string>) => (name: string) => map[name] ?? '';

// ── Colours ──────────────────────────────────────────────────────────────
test('parseColor reads hex (3, 4, 6, 8 digits) and rgb()/rgba() in both syntaxes; none and transparent are nothing; anything else is not a colour', () => {
  assert.deepEqual(pal.parseColor('#abc'), { r: 170, g: 187, b: 204, a: 1 });
  assert.deepEqual(pal.parseColor(' #AABBCC '), { r: 170, g: 187, b: 204, a: 1 });
  assert.deepEqual(pal.parseColor('#aabbcc80'), { r: 170, g: 187, b: 204, a: 128 / 255 });
  assert.deepEqual(pal.parseColor('#abc8'), { r: 170, g: 187, b: 204, a: 136 / 255 });
  assert.deepEqual(pal.parseColor('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(pal.parseColor('rgba(212,226,244,.12)'), { r: 212, g: 226, b: 244, a: 0.12 });
  assert.deepEqual(pal.parseColor('rgb(1 2 3 / 50%)'), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.equal(pal.parseColor('none'), null);
  assert.equal(pal.parseColor(' transparent'), null);
  assert.equal(pal.parseColor('var(--x)'), undefined);
  assert.equal(pal.parseColor('blah'), undefined);
  assert.equal(pal.parseColor(''), undefined);
});

test('cssColor writes an opaque colour as hex and a translucent one as rgba', () => {
  assert.equal(pal.cssColor({ r: 170, g: 187, b: 204, a: 1 }), '#aabbcc');
  assert.equal(pal.cssColor({ r: 212, g: 226, b: 244, a: 0.12 }), 'rgba(212,226,244,0.12)');
});

test('with no token set the palette is the factory palette, every entry', () => {
  assert.deepEqual(pal.readPalette(none), pal.FACTORY_PALETTE);
  assert.equal(pal.FACTORY_PALETTE.plan, '#c4b0dc', 'the Plan colour D53 accepted');
  assert.equal(pal.FACTORY_PALETTE.nodeKind, null, 'the kind on an object is written in the object\'s colour');
  assert.equal(pal.FACTORY_PALETTE.nodeLip, null, 'the factory draws no material');
});

test('a graph token is read, trimmed; the general token stands in for it; a value that is not a colour leaves the factory value', () => {
  assert.equal(pal.readPalette(vars({ '--pk-graph-plan': '  #c9a3e8 ' })).plan, '#c9a3e8');
  assert.equal(pal.readPalette(vars({ '--pk-purple': '#c9a3e8' })).plan, '#c9a3e8', 'the theme\'s purple, when it gave no Plan colour');
  assert.equal(pal.readPalette(vars({ '--pk-graph-plan': '#123456', '--pk-purple': '#c9a3e8' })).plan, '#123456', 'the graph token comes first');
  assert.equal(pal.readPalette(vars({ '--pk-graph-plan': 'nonsense' })).plan, '#c4b0dc');
  assert.equal(pal.readPalette(vars({ '--pk-graph-node-text': 'none' })).nodeText, '#e7e7df', 'a colour that must exist is never turned off');
  assert.equal(pal.readPalette(vars({ '--pk-graph-node-lip': '#080706' })).nodeLip, '#080706');
  assert.equal(pal.readPalette(vars({ '--pk-graph-node-lip': 'none' })).nodeLip, null, 'material parts can be turned off');
  assert.equal(pal.readPalette(vars({ '--pk-graph-node-shadow': 'rgba(0,0,0,.42)' })).nodeShadow, 'rgba(0,0,0,0.42)');
  assert.equal(pal.readPalette(vars({ '--pk-graph-node-kind': '#cdc2b0' })).nodeKind, '#cdc2b0');
});

test('every palette entry names the CSS variables it reads, the graph\'s own first (the contract in ui/themes/TOKENS.md)', () => {
  for (const key of Object.keys(pal.FACTORY_PALETTE)) {
    const chain = pal.PALETTE_VARS[key];
    assert.ok(Array.isArray(chain) && chain.length > 0, `${key} reads a variable`);
    assert.ok(chain[0].startsWith('--pk-graph-'), `${key} reads a graph token first: ${chain[0]}`);
    for (const v of chain) assert.match(v, /^--pk-/);
  }
});

test('tint moves a colour part of the way from the node\'s surface, as the factory badges are drawn', () => {
  assert.equal(pal.tint('#e3b76f', 0.3, '#1c1c1a'), '#584b34');
  assert.equal(pal.tint('#ffffff', 1, '#000000'), '#ffffff');
  assert.equal(pal.tint('#ffffff', 0, '#1c1c1a'), '#1c1c1a');
});

test('the marks keep their identity and read their colour from the palette in force', () => {
  assert.deepEqual(Object.keys(pal.MARK_COLOURS), ['star', 'flag', 'note', 'ask', 'pending']);
  assert.equal(pal.MARK_COLOURS.flag(pal.FACTORY_PALETTE), '#e3b76f');
  assert.equal(pal.MARK_COLOURS.pending(pal.readPalette(vars({ '--pk-graph-mark-pending': '#7ac1e8' }))), '#7ac1e8');
});

// ── Material ─────────────────────────────────────────────────────────────
test('the shapes are the graph\'s own (D53): the document, the long hexagon, the oval, the round card, the folder; sized to the object', () => {
  assert.equal(mat.shapePath('hex', 228, 60), 'M22.8,0 L205.2,0 L228,30 L205.2,60 L22.8,60 L0,30 Z');
  assert.equal(mat.shapePath('doc', 100, 50), 'M0,0 L86,0 L100,9.5 L100,50 L0,50 Z');
  assert.match(mat.shapePath('ellipse', 200, 50), /^M0,25 A100,25 0 1,0 200,25 A100,25 0 1,0 0,25 Z$/);
  assert.match(mat.shapePath('card', 228, 36), /^M6,0/);
  assert.match(mat.shapePath('folder', 228, 72), /^M1,12 V4/);
  assert.doesNotMatch(mat.shapePath('hex', 228, 60), /NaN|undefined/);
});

test('no material when the theme lends none: the factory picture stays as it was', () => {
  assert.equal(mat.materialOf(pal.FACTORY_PALETTE), null);
  assert.equal(mat.materialSvg('hex', 228, 60, null, '#c4b0dc'), '');
  assert.deepEqual(mat.materialRoom(null), { left: 0, bottom: 0 });
});

test('the material is drawn from the theme\'s parts only: a lip and a soft shadow under the shape, the fill, a hairline brush, a band in the object\'s colour, a chamfer and a shade', () => {
  const p = pal.readPalette(vars({ '--pk-graph-node-bg': '#1a1815', '--pk-graph-node-lip': '#080706', '--pk-graph-node-shadow': 'rgba(0,0,0,.42)', '--pk-graph-node-chamfer': 'rgba(212,226,244,.12)', '--pk-graph-node-shade': 'rgba(0,0,0,.58)', '--pk-graph-node-brush': 'rgba(255,240,214,.013)' }));
  const m = mat.materialOf(p);
  assert.deepEqual(m, { bg: '#1a1815', lip: '#080706', shadow: 'rgba(0,0,0,0.42)', chamfer: 'rgba(212,226,244,0.12)', shade: 'rgba(0,0,0,0.58)', brush: 'rgba(255,240,214,0.013)' });
  const svg = mat.materialSvg('hex', 228, 60, m, '#c9a3e8');
  assert.match(svg, /<clipPath id="ckm-clip"><path d="M22.8,0/);
  assert.match(svg, /feDropShadow[^>]*flood-color="rgba\(0,0,0,0.42\)"/);
  assert.match(svg, /<path d="M22.8,0[^"]*" fill="#080706" transform="translate\(0,3\)"/, 'the hard lip: the shape again, 3px lower');
  assert.match(svg, /<path d="M22.8,0[^"]*" fill="#1a1815"\/>/, 'the body');
  assert.match(svg, /<pattern id="ckm-brush"[^>]*>.*fill="rgba\(255,240,214,0.013\)"/, 'the brushed lines');
  assert.match(svg, /<rect x="0" y="0" width="228" height="3" fill="#c9a3e8" clip-path="url\(#ckm-clip\)"\/>/, 'the band in the object\'s colour along the top edge');
  assert.match(svg, /<rect x="0" y="3" width="228" height="2" fill="rgba\(212,226,244,0.12\)" clip-path/, 'the chamfer under the band');
  assert.match(svg, /<rect x="0" y="57" width="228" height="3" fill="rgba\(0,0,0,0.58\)" clip-path/, 'the shade along the bottom edge');
  assert.doesNotMatch(svg, /NaN|undefined/);
  // Room the picture needs beyond the object: the soft shadow and the lip fall below and beside it.
  assert.deepEqual(mat.materialRoom(m), { left: 12, bottom: 24 });
  // Parts a theme turned off are simply not drawn.
  const bare = mat.materialSvg('doc', 100, 50, { ...m, lip: null, shadow: null, brush: null }, '#9fbdd5');
  assert.doesNotMatch(bare, /feDropShadow|translate\(0,3\)|ckm-brush/);
  assert.match(bare, /fill="#1a1815"/);
  assert.deepEqual(mat.materialRoom({ ...m, lip: null, shadow: null }), { left: 0, bottom: 0 });
});
