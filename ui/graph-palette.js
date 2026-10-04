// The graph's colours, read from the theme (Spec §6.3, §6.16; CKC-09 AC-41). Cytoscape draws on a canvas and the
// objects are SVG pictures, so CSS variables cannot reach them: this reads the `--pk-graph-*` tokens (with the general
// tokens standing in, and the factory values last) into one palette that graph.js and the legend draw from, and a
// theme change asks the graph to read it again and repaint (graph.js repaint). No DOM here — `getVar` is handed in —
// so it is tested with `node --test` (src/ui/graph-palette.test.ts). The token names are the contract in
// ui/themes/TOKENS.md.

/** The factory graph, as it was before any theme: D53's four colours, and no material on the objects. */
export const FACTORY_PALETTE = Object.freeze({
  // The four kinds (Spec §6.3): checked with palette-check.py — Plan / Work item 30.4 normal, 25.2 and 21.1 simulated.
  intent: '#9fbdd5', plan: '#c4b0dc', work: '#a3c5ac', reality: '#e0a98e',
  // Words and surfaces on an object. `nodeKind` null: the kind is written in the object's own colour (the factory way);
  // a theme may give it a text colour instead (i1 does, Spec §6.3 "节点上的字用正文字色").
  nodeBg: '#232320', nodeText: '#e7e7df', nodeKind: null, nodeMuted: '#a5a59b', nodeFaint: '#85857b',
  // The card's material, lent to the objects by a theme (Spec §6.16: nodes borrow the card's material, not its shape).
  // All off in the factory, so the factory picture is drawn exactly as before.
  nodeChamfer: null, nodeShade: null, nodeBrush: null, nodeLip: null, nodeShadow: null,
  // Lines and what is written on them.
  edge: '#6e6e66', edgeOther: '#8c8c84', edgeRelated: '#cfcfc6', edgeLit: '#e7e7df', edgeSelected: '#f0d7a3', questioned: '#e3b76f',
  labelBg: '#10100f', chipBg: '#1c1c1a', chipBorder: '#4a4a43',
  // Selection, focus and Compare: white and the star colour, never one of the kinds (owner 2026-09-17).
  selection: '#ffffff', focus: '#ffd54a', diffAdded: '#7fd08a', diffChanged: '#e3b76f', diffRemoved: '#dca6a0', replaced: '#5a5a50', danger: '#dca6a0',
  // A folded group: a small stack of cards.
  groupBg: '#20201e', groupBorder: '#5a5a50', groupBack: '#1d1d1b', groupBackBorder: '#45453f', groupChip: '#2b2b26',
  // The corner marks (D53).
  markStar: '#f3ead2', markFlag: '#e3b76f', markNote: '#e7e7df', markAsk: '#e3b76f', markPending: '#9fbdd5',
});

/**
 * Which CSS variables each entry reads, first found wins: the graph's own token, then the general token a theme is
 * likelier to have set, so a theme that only filled the general palette gets a coherent graph and refines from there.
 */
export const PALETTE_VARS = Object.freeze({
  intent: ['--pk-graph-intent', '--pk-blue'], plan: ['--pk-graph-plan', '--pk-purple'], work: ['--pk-graph-work', '--pk-green'], reality: ['--pk-graph-reality', '--pk-accent'],
  nodeBg: ['--pk-graph-node-bg', '--pk-card-bg', '--pk-surface'], nodeText: ['--pk-graph-node-text', '--pk-text-strong', '--pk-text'], nodeKind: ['--pk-graph-node-kind'],
  nodeMuted: ['--pk-graph-node-muted', '--pk-text-muted'], nodeFaint: ['--pk-graph-node-faint', '--pk-text-faint'],
  nodeChamfer: ['--pk-graph-node-chamfer'], nodeShade: ['--pk-graph-node-shade'], nodeBrush: ['--pk-graph-node-brush'], nodeLip: ['--pk-graph-node-lip'], nodeShadow: ['--pk-graph-node-shadow'],
  edge: ['--pk-graph-edge', '--pk-line-strong'], edgeOther: ['--pk-graph-edge-other', '--pk-text-faint'], edgeRelated: ['--pk-graph-edge-related', '--pk-text-muted'], edgeLit: ['--pk-graph-edge-lit', '--pk-text-strong', '--pk-text'],
  edgeSelected: ['--pk-graph-edge-selected', '--pk-accent-hi', '--pk-accent'], questioned: ['--pk-graph-questioned', '--pk-accent'],
  labelBg: ['--pk-graph-label-bg', '--pk-ground'], chipBg: ['--pk-graph-chip-bg', '--pk-surface'], chipBorder: ['--pk-graph-chip-border', '--pk-line-strong', '--pk-line'],
  selection: ['--pk-graph-selection'], focus: ['--pk-graph-focus', '--pk-star'], diffAdded: ['--pk-graph-diff-added', '--pk-green'], diffChanged: ['--pk-graph-diff-changed', '--pk-accent'], diffRemoved: ['--pk-graph-diff-removed', '--pk-red'],
  replaced: ['--pk-graph-replaced', '--pk-line-strong'], danger: ['--pk-graph-danger', '--pk-red'],
  groupBg: ['--pk-graph-group-bg', '--pk-raised'], groupBorder: ['--pk-graph-group-border', '--pk-line-strong'], groupBack: ['--pk-graph-group-back', '--pk-surface'], groupBackBorder: ['--pk-graph-group-back-border', '--pk-line'], groupChip: ['--pk-graph-group-chip', '--pk-raised'],
  markStar: ['--pk-graph-mark-star', '--pk-text-strong'], markFlag: ['--pk-graph-mark-flag', '--pk-accent'], markNote: ['--pk-graph-mark-note', '--pk-text'], markAsk: ['--pk-graph-mark-ask', '--pk-accent'], markPending: ['--pk-graph-mark-pending', '--pk-blue'],
});
/** Entries a theme may leave out (null): the material parts, and the kind's own text colour. */
const OPTIONAL = new Set(['nodeKind', 'nodeChamfer', 'nodeShade', 'nodeBrush', 'nodeLip', 'nodeShadow']);

/**
 * A CSS colour as numbers: hex in 3, 4, 6 or 8 digits, rgb()/rgba() with commas or spaces. `none` and `transparent`
 * are null (nothing to draw); anything else — a var() a browser left unresolved, a word — is undefined (not a colour).
 */
export function parseColor(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return undefined;
  if (s === 'none' || s === 'transparent') return null;
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    let hex = m[1];
    if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('');
    const n = (i) => parseInt(hex.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[5] ? Number(m[4]) / 100 : Number(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
  }
  return undefined;
}
/** The colour written back for SVG and cytoscape: hex when opaque, rgba() when not. */
export function cssColor(c) {
  const hex = (v) => Math.round(v).toString(16).padStart(2, '0');
  return c.a >= 1 ? `#${hex(c.r)}${hex(c.g)}${hex(c.b)}` : `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${Math.round(c.a * 1000) / 1000})`;
}

/**
 * The palette in force. `getVar(name)` gives a CSS variable's computed value on the page (or '' when it is not set).
 * Each entry takes the first variable of its chain that holds a colour; `none` turns an optional part off; a value
 * that is not a colour is passed over, so a mistake in a theme leaves the factory value and never an unreadable graph.
 */
export function readPalette(getVar) {
  const out = {};
  for (const [key, factory] of Object.entries(FACTORY_PALETTE)) {
    let value = factory;
    for (const name of PALETTE_VARS[key]) {
      const c = parseColor(getVar(name));
      if (c === undefined) continue;
      if (c === null) { if (OPTIONAL.has(key)) value = null; break; }
      value = cssColor(c);
      break;
    }
    out[key] = value;
  }
  return out;
}

/** A colour moved part of the way (`amount`) from a base colour: the badges' fills, tinted from the node's surface. */
export function tint(hex, amount = 0.3, base = '#1c1c1a') {
  const c = parseColor(hex), b = parseColor(base);
  if (!c || !b) return hex;
  const mix = (x, y) => Math.round(y + (x - y) * amount);
  return cssColor({ r: mix(c.r, b.r), g: mix(c.g, b.g), b: mix(c.b, b.b), a: 1 });
}

/** The colour of each corner mark, from a palette: the marks in graph.js keep their identity and read through these. */
export const MARK_COLOURS = Object.freeze({
  star: (p) => p.markStar, flag: (p) => p.markFlag, note: (p) => p.markNote, ask: (p) => p.markAsk, pending: (p) => p.markPending,
});
