// Project graph renderer on cytoscape (Spec §6.3). It draws the assets the API returns; visibility rules, scales,
// focus, filters and groups live here. Fixed text is English.
import { TEXT, MIN_TEXT_PX, ZOOM_FLOOR, ZOOM_HARD_MIN, fitView, openingView, wholeView, hardMinZoom, keepInView, inView, panToShow, pictureBox } from './graph-fit.js';
import { FACTORY_PALETTE, readPalette, tint, MARK_COLOURS } from './graph-palette.js';
import { materialOf, materialSvg, materialRoom } from './graph-material.js';
import { placementOf, cellKey, NO_PLAN, INTENT_KINDS, destinationLine, destinationText, isCopyIn, sharedMark, areaWorkLine, MAIN_BY, FOUNDATION_LABEL, WHOLE_LABEL, WHOLE_PLAN_LABEL } from './placement.js';
export { placementOf, objectAttentionNotes } from './placement.js';

// ── What an object looks like (D40, D53) ─────────────────────────────────
// Which List column (Spec §6.3) each category belongs to. Shape and colour both follow the column (D53): Product
// intent is a document, Work & plan a long hexagon, Observed reality a folder at the foot of each column (an oval when
// drawn one by one). Plan and Work item share the hexagon, so they are the one pair told apart by colour alone.
export const CATEGORY_COLUMN = {
  "Owner's words": 'Product intent', 'Product': 'Product intent', 'Goal': 'Product intent', 'Area': 'Product intent', 'Decision': 'Product intent', 'Requirement': 'Product intent', 'Design': 'Product intent',
  'Plan': 'Work & plan', 'Work item': 'Work & plan',
  'Result': 'Observed reality', 'Review': 'Observed reality', 'Test': 'Observed reality', 'Session': 'Observed reality', 'Run': 'Observed reality', 'Change': 'Change',
};
// The colours come from the theme in force (Spec §6.16): a palette read from the `--pk-graph-*` tokens, the factory
// values behind them — the workbench's own blue, purple, green and a peach that is neither its warning red nor its amber,
// checked with scripts/palette-check.py (CIEDE2000; protanopia and deuteranopia simulated after
// Machado 2009): Plan / Work item 30.4 normal, 25.2 and 21.1 simulated; the four within 3.2 L* of each other, so no kind
// jumps out (Spec §6.3). Each theme gives its own four (ui/themes/TOKENS.md) and is checked the same way.
let palette = FACTORY_PALETTE;
export const currentPalette = () => palette;
/** Read the palette off the page again: after the theme's stylesheets have loaded (theme.js), before repainting. */
export function refreshPalette() {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return palette;
  const cs = getComputedStyle(document.documentElement);
  palette = readPalette((name) => cs.getPropertyValue(name));
  materials.clear();
  return palette;
}
export const COLUMN_COLOR = Object.freeze({ get intent() { return palette.intent; }, get plan() { return palette.plan; }, get work() { return palette.work; }, get reality() { return palette.reality; } });
export const colourKey = (category) => category === 'Plan' ? 'plan' : category === 'Work item' ? 'work' : CATEGORY_COLUMN[category] === 'Observed reality' ? 'reality' : 'intent';
export const CATEGORY_COLOR = Object.freeze(Object.defineProperties({}, Object.fromEntries(Object.keys(CATEGORY_COLUMN).map((c) => [c, { get: () => COLUMN_COLOR[colourKey(c)], enumerable: true }]))));
// Where work happened (sessions, runs) and the change records themselves are not drawn: sources list the former, and a
// star on the affected objects shows the latter (owner 2026-09-17).
export const NOT_DRAWN = new Set(['Session', 'Run', 'Change']);
export const OBSERVED = ['Result', 'Review', 'Test'];
// The owner's words (D63): one group on top of the graph with its count, folded until opened; the server says which
// nodes are in it (`group`), the graph only lays it out (Spec §6.3).
export const OWNER_WORDS = "Owner's words";
const WORDS_GROUP_ID = 'group:owners-words';
// A node the server put in the group, or an element drawn for one (its category) or for the group itself.
const isWordsItem = (d) => d.group === OWNER_WORDS || d.category === OWNER_WORDS;
const HIDDEN_VALIDITY = new Set(['Replaced', 'Deferred', 'Abandoned']);
const REFERENCE_DETAIL = new Set(['Requirement', 'Design', 'Decision']);
const FOLDABLE = new Set(['Session', 'Run', 'Result', 'Review', 'Test']);
const isWork = (category) => category === 'Work item' || category === 'Plan';
/** A name that repeats its own identifier ("CKC-01 CKC-01 · …") shows it once. */
export const cleanName = (label) => { const s = String(label ?? ''); const m = /^(\S+)\s+\1(\s|$)/.exec(s); return m ? s.slice(m[1].length + 1) : s; };

// Corner marks (D53): one table gives the glyph, its colour and what the legend and the tooltip say, so the picture and
// its legend never say two things (the WorkflowKeeper rule). They sit on the object's corner and never repaint it. The
// colour is read from the palette in force each time it is asked for, so the marks keep their identity across themes
// (the legend and the List count by them) and the page colours them by class `mark-<key>` (styles.css).
const mark = (key, glyph, legend, desc) => ({ key, glyph, legend, desc, get color() { return MARK_COLOURS[key](palette); } });
export const MARKS = {
  star: mark('star', '★', 'new or changed', 'new or changed since your last visit, or in the last days — the star buttons above choose which'),
  flag: mark('flag', '⚑', 'flagged', 'a flag on the object: layer drift, suspected stale, scope question …; open it to see which'),
  // A note on the object (D100: ❓ on the object in Graph and List). Highlighted while the note still needs you (it is
  // in `Notes (attention)`, Spec §2.7), quiet otherwise; on a folded group, a stacked cell or a rolled band it stays lit
  // with its count.
  note: mark('note', '❓', 'note', 'a note hangs on it; open the object to read it'),
  ask: mark('ask', '❓', 'note that needs you', 'a note on it still needs you: it asks for your decision or is worth discussing, and you have not answered it'),
  pending: mark('pending', '⟳', 'Update pending', 'material behind it changed and the Keeper has not taken the change in yet'),
};

/**
 * Which nodes get a star (owner 2026-09-17): what is new or changed. `visit` marks what appeared or changed since the
 * owner's previous visit; `days` marks the last one to three days, choosing the longest window that still singles
 * things out (a very active project gets one day).
 */
export function starredIds(nodes, mode, lastVisit, now = Date.now()) {
  const drawn = nodes.filter((n) => !NOT_DRAWN.has(n.category) && n.validity !== 'Unjudged');
  const touched = (n) => [n.changedAt || '', n.createdAt || ''].sort().pop();
  const since = (iso) => new Set(drawn.filter((n) => touched(n) && touched(n) > iso).map((n) => n.id));
  if (mode === 'visit') {
    if (!lastVisit) return { ids: new Set(), note: 'Stars appear from your next visit: they mark what is new since the last time you opened this project.' };
    const ids = since(lastVisit);
    return { ids, note: ids.size ? `★ new or changed since your last visit (${new Date(lastVisit).toLocaleString(undefined, { hour12: false })})` : 'Nothing new since your last visit.' };
  }
  const limit = Math.max(5, Math.round(drawn.length * 0.2));
  for (const days of [3, 2, 1]) {
    const ids = since(new Date(now - days * 86_400_000).toISOString());
    if (ids.size <= limit || days === 1) {
      if (days === 1 && ids.size > drawn.length * 0.6) return { ids: new Set(), note: 'Almost everything changed within the last day, so no stars are shown.' };
      return { ids, note: ids.size ? `★ new or changed in the last ${days === 1 ? 'day' : `${days} days`}` : `Nothing new in the last ${days} days.` };
    }
  }
  return { ids: new Set(), note: '' };
}

/**
 * What each column's Observed reality holds (D55; CKC-09 AC-15, AC-30), counted once for the graph's folders and the
 * List's cells, so the two cannot disagree. A column is an area, or `null` for Project-wide; it holds the results,
 * reviews and tests of its visible work. Results linked to no work sit in Project-wide as `unplaced`. Results of hidden
 * work (replaced or deferred) appear only with `Show replaced & deferred`, like the work itself.
 */
export function observedCells(data, showReplaced = false, model = null) {
  // The column of a work is its place on the story map (ui/placement.js): the Graph's folders and the List's blocks
  // read the same model. A bare list of nodes (no relations) is placed by the nodes' own `areaId`.
  const payload = Array.isArray(data) ? { nodes: data, relations: [] } : data;
  const nodes = payload.nodes;
  const M = model ?? placementOf(payload, { showReplaced });
  const vis = (n) => !HIDDEN_VALIDITY.has(n.validity) || showReplaced || n.recentChange;
  const areaIds = new Set(M.areas.map((a) => a.id));
  const works = new Map(nodes.filter((n) => isWork(n.category)).map((n) => [n.id, n]));
  const empty = () => ({ items: [], total: 0, Result: 0, Review: 0, Test: 0, flagged: 0, noted: 0, pending: 0, unplaced: 0 });
  const cells = new Map([...M.areas.map((a) => [a.id, empty()]), [null, empty()]]);
  const columnOf = (work) => { const a = M.place.get(work.id)?.area ?? work.areaId; return areaIds.has(a) ? a : null; };
  for (const n of nodes) {
    if (!OBSERVED.includes(n.category)) continue;
    const work = n.parentId ? works.get(n.parentId) : undefined;
    if (work && !vis(work)) continue;
    const cell = cells.get(work ? columnOf(work) : null);
    cell.items.push(n); cell.total++; cell[n.category]++;
    if (!work) cell.unplaced++;
    if (n.marks?.length) cell.flagged++;
    if (n.noteCount) cell.noted++;
    if (n.updatePending) cell.pending++;
  }
  return cells;
}
const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
/** The one-line count of a cell, the same words on the folder and in the List. */
export function cellSummary(cell) {
  return [cell.Result && plural(cell.Result, 'result'), cell.Review && plural(cell.Review, 'review'), cell.Test && plural(cell.Test, 'test')].filter(Boolean).join(' · ');
}

// ── Text inside objects ──────────────────────────────────────────────────
const FONT = "'Segoe UI Variable Text','Segoe UI','Microsoft YaHei',sans-serif";
const measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
function measure(text, size, weight = 400) {
  if (!measureCtx) return String(text).length * size * 0.6;
  measureCtx.font = `${weight} ${size}px ${FONT}`;
  return measureCtx.measureText(text).width;
}
// Chinese, Japanese and Korean text breaks between any two characters, so it fills the line it starts on instead of
// leaving "CKC-01 ·" alone on the first line.
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/;
function wrapLines(text, size, weight, maxWidth) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate, size, weight) <= maxWidth) { line = candidate; continue; }
      if (CJK.test(word) || measure(word, size, weight) > maxWidth) {
        if (line) line += ' ';
        for (const ch of word) { if (line.trim() && measure(line + ch, size, weight) > maxWidth) { lines.push(line.trimEnd()); line = ch; } else line += ch; }
        continue;
      }
      if (line) lines.push(line);
      line = word;
    }
    lines.push(line);
  }
  return lines;
}
/** At most `max` lines; the last one ends in an ellipsis when the name goes on. The full name is in the tooltip. */
function clampLines(text, size, weight, maxWidth, max) {
  const lines = wrapLines(text, size, weight, maxWidth);
  if (lines.length <= max) return lines;
  let last = lines[max - 1];
  while (last.length && measure(`${last}…`, size, weight) > maxWidth) last = last.slice(0, -1);
  return [...lines.slice(0, max - 1), `${last}…`];
}
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// `fit`: the width the words are set to when they are a little too long for their line (see kindLine).
function svgText(x, y, str, o = {}) {
  return `<text x="${x}" y="${y}" font-family="${xml(FONT)}" font-size="${o.size ?? TEXT.name}" font-weight="${o.weight ?? 400}" fill="${o.fill ?? palette.nodeText}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.spacing ? ` letter-spacing="${o.spacing}"` : ''}${o.fit ? ` textLength="${o.fit.toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : ''}${o.strike ? ' text-decoration="line-through"' : ''}${o.print ? ' data-print="small"' : ''}>${xml(str)}</text>`;
}
// The picture drawn over an object: its words, its corner marks and its link count. It is larger than the object by
// this much above (the marks sit on the top edge) and to the right (the link count), and drawn at twice the size so it
// stays sharp when zoomed in. A theme's material (a lip, a shadow) needs room below and to the left as well (`room`);
// the picture then says how far it reaches (`ox`, `oy`) and cytoscape places it by that. Room is never part of the
// object's bounds: fitting and the self-check see the object, its marks and its link count, as before.
const OVER = { top: 12, right: 38 };
function picture(w, h, body, room = { left: 0, bottom: 0 }) {
  const W = w + OVER.right + room.left, H = h + OVER.top + room.bottom;
  return { uri: `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" viewBox="${-room.left} ${-OVER.top} ${W} ${H}">${body}</svg>`)}`, w: W, h: H, ox: -room.left, oy: -OVER.top };
}
/** A theme's material under an object's shape, drawn once per shape, size and colour until the theme changes. */
const materials = new Map();
function materialPicture(kind, w, h, colour) {
  const m = materialOf(palette);
  if (!m) return null;
  const key = `${kind}|${w}|${h}|${colour}`;
  if (!materials.has(key)) materials.set(key, picture(w, h, materialSvg(kind, w, h, m, colour), materialRoom(m)));
  return materials.get(key);
}
// A corner mark stands on the object's top edge, 11px above it (OVER.top, and the gaps of the layout, leave that room)
// and 9px into it: the line of kind and progress starts below that, so a mark never covers a word.
const MARK_R = 10, MARK_STEP = 23;
function badge(x, y, mark) {
  // A quiet ❓ (a note that does not need you now) stays on the object but steps back; the one that needs you is lit.
  const lit = mark.key === 'ask';
  return `<g${mark.key === 'note' ? ' opacity="0.55"' : ''}><circle cx="${x}" cy="${y}" r="${MARK_R}" fill="${tint(mark.color, lit ? 0.75 : 0.3, palette.chipBg)}" stroke="${mark.color}" stroke-width="${lit ? 2 : 1.2}"/>${svgText(x, y + 4.5, mark.glyph, { size: TEXT.count, weight: 700, fill: lit ? palette.nodeBg : mark.color, anchor: 'middle' })}</g>`;
}
/** A mark with its count on a folded group, a stacked cell or a rolled band: it stays lit while folded (D100). */
function countBadge(xRight, y, mark, count) {
  const label = `${mark.glyph} ${count}`, w = measure(label, TEXT.count, 700) + 14;
  const lit = mark.key === 'ask';
  return { w, svg: `<g${mark.key === 'note' ? ' opacity="0.6"' : ''}><rect x="${xRight - w}" y="${y - 10}" width="${w}" height="20" rx="10" fill="${tint(mark.color, lit ? 0.75 : 0.3, palette.chipBg)}" stroke="${mark.color}" stroke-width="${lit ? 2 : 1.2}"/>${svgText(xRight - w / 2, y + 4.5, label, { size: TEXT.count, weight: 700, fill: lit ? palette.nodeBg : mark.color, anchor: 'middle' })}</g>` };
}
/** The count marks of what a fold holds: ❓ that need you, quiet ❓, flags. */
function foldMarks(m) {
  return [m?.attention ? [MARKS.ask, m.attention] : null, m?.quiet ? [MARKS.note, m.quiet] : null, m?.flagged ? [MARKS.flag, m.flagged] : null].filter(Boolean);
}
function badgesRight(w, marks) {
  let svg = '', xr = w - 8;
  for (const [mk, k] of foldMarks(marks)) { const b = countBadge(xr, -1, mk, k); svg += b.svg; xr -= b.w + 4; }
  return svg;
}
function linkChip(w, h, links) {
  if (!links) return '';
  const cx = w + 5, cy = h / 2, label = `↗${links}`, lw = measure(label, TEXT.count, 600) + 8;
  return `<rect x="${cx - 2}" y="${cy - 10}" width="${lw}" height="20" rx="10" fill="${palette.chipBg}" stroke="${palette.chipBorder}"/>${svgText(cx - 2 + lw / 2, cy + 4.5, label, { size: TEXT.count, weight: 600, fill: palette.nodeMuted, anchor: 'middle' })}`;
}
/** The word `Inferred` on an object's top edge, from `x` (Spec §2.3: the Keeper's inference, not the material's). */
export const INFERRED_WORD = 'Inferred';
function inferredChip(x) {
  const w = measure(INFERRED_WORD, TEXT.count, 600) + 12;
  return `<g><rect x="${x}" y="-10" width="${w}" height="18" rx="4" fill="${palette.chipBg}" stroke="${palette.edgeOther}" stroke-width="1"/>${svgText(x + w / 2, 3.5, INFERRED_WORD, { size: TEXT.count, weight: 600, fill: palette.nodeMuted, anchor: 'middle' })}</g>`;
}
/**
 * The count of what is open on a work item — open send-backs, lit breakpoints, findings still open — on its top edge,
 * left of the corner marks, whether its steps are folded or drawn (D75; owner 2026-10-01, E152). In the warning colour,
 * with the sign, so the colour is not the only carrier. `xRight`: where the pill ends.
 */
export const OPEN_SIGN = '⚠';
function openBadge(xRight, count) {
  const label = `${OPEN_SIGN} ${count}`, w = measure(label, TEXT.count, 700) + 14;
  return `<g data-open="${count}"><rect x="${xRight - w}" y="-11" width="${w}" height="20" rx="10" fill="${tint(palette.danger, 0.3, palette.chipBg)}" stroke="${palette.danger}" stroke-width="1.6"/>${svgText(xRight - w / 2, 3.5, label, { size: TEXT.count, weight: 700, fill: palette.danger, anchor: 'middle' })}</g>`;
}
export function marksOf(n, starred) {
  const out = [];
  if (starred) out.push(MARKS.star);
  if (n.marks?.length) out.push(MARKS.flag);
  if (n.noteAttention || n.noteCount) out.push(n.noteAttention ? MARKS.ask : MARKS.note);
  if (n.updatePending) out.push(MARKS.pending);
  return out;
}
// Where the words sit in an object, px from its top at 100%: the line of kind and progress, the name's first line and
// the step to its second. The sizes of the words are TEXT (graph-fit.js); the sizes of the objects (SIZE) follow from these.
const LINE = { kind: 19, name: 37, step: 17, productName: 38, productStep: 18 };
/**
 * Kind and validity on the left, progress on the right, on one line (Spec §6.3). When the two are too long for the line
 * they are set narrower — by a tenth at most, the letters keep their height — and past that the kind gives way with an
 * ellipsis. Progress is never cut; the tooltip has kind and validity in full.
 */
function kindLine(pad, y, w, kind, progress, color) {
  const size = TEXT.kind, room = w - pad * 2 - (progress ? 8 : 0);
  const pw = progress ? measure(progress, size) : 0;
  let kw = measure(kind, size, 600);
  const squeeze = Math.min(1, Math.max(0.9, room / (kw + pw)));
  if ((kw + pw) * squeeze > room + 0.5) { kind = clampLines(kind, size, 600, room / squeeze - pw, 1)[0]; kw = measure(kind, size, 600); }
  // The kind is written in the object's own colour, or — a theme that keeps colour to the edges — in its text colour.
  const parts = [svgText(pad, y, kind, { size, weight: 600, fill: palette.nodeKind ?? color, fit: squeeze < 1 ? kw * squeeze : 0 })];
  if (progress) parts.push(svgText(w - pad, y, progress, { size, fill: palette.nodeMuted, anchor: 'end', fit: squeeze < 1 ? pw * squeeze : 0 }));
  return parts;
}
/** The picture over an object (exported for its test). */
export function objectImage(n, w, h, o) {
  const key = colourKey(n.category);
  const color = COLUMN_COLOR[key];
  const pointed = key === 'plan' || key === 'work' || key === 'reality';
  const small = FOLDABLE.has(n.category);
  // The sides of a hexagon and of an oval lean in towards the top and bottom edge, so the words on them start further in:
  // far enough that a second line of name, or `No established link`, clears the slanted edge.
  const pad = small ? 24 : pointed ? 22 : 12;
  const parts = [];
  const validity = ['Replaced', 'Deferred', 'Abandoned', 'Proposed'].includes(n.validity) ? ` · ${n.validity.toUpperCase()}` : '';
  const kind = n.category === 'Area' ? `AREA · ${areaWorkLine(o.areaWork)}` : n.category.toUpperCase();
  const progress = isWork(n.category) && n.progress ? `${n.progress}${n.progress === 'Done' && n.acceptance ? ` · ${n.acceptance === 'Accepted' ? 'accepted' : 'not accepted'}` : ''}` : '';
  parts.push(...kindLine(pad, LINE.kind, w, kind + validity, progress, color));
  const big = n.category === 'Product';
  const bold = big || n.category === 'Goal' || n.category === 'Area' || n.category === OWNER_WORDS;
  const size = big ? TEXT.product : TEXT.name, weight = bold ? 600 : 400;
  const first = big ? LINE.productName : LINE.name, step = big ? LINE.productStep : LINE.step;
  const struck = n.validity === 'Replaced' || n.validity === 'Abandoned';
  // A folded work with a process carries its four things on the second line (CKC-24); the name then takes one line.
  const procLine = o.procLine && !n.noEstablishedLink ? o.procLine : null;
  const lines = clampLines(cleanName(n.label), size, weight, w - pad * 2, small || n.noEstablishedLink || procLine ? 1 : 2);
  lines.forEach((t, i) => parts.push(svgText(pad, first + i * step, t, { size, weight, strike: struck, fill: struck || n.validity === 'Deferred' ? palette.nodeMuted : palette.nodeText })));
  if (procLine) parts.push(svgText(pad, first + step, clampLines(procLine, TEXT.count, 400, w - pad * 2, 1)[0], { size: TEXT.count, fill: palette.nodeMuted, print: true }));
  if (n.noEstablishedLink) parts.push(svgText(pad, first + step, 'No established link', { size: TEXT.kind, fill: palette.danger }));
  const marks = marksOf(n, o.starred);
  const x0 = w - (pointed ? 33 : 16);
  marks.forEach((m, i) => parts.push(badge(x0 - i * MARK_STEP, -1, m)));
  if (o.open?.count) parts.push(openBadge(x0 - marks.length * MARK_STEP + MARK_R, o.open.count));
  // An inferred object says so in words on its top edge, left of the corner marks (Spec §2.3): the frame stays solid,
  // because a dashed frame is a work item's copy in another module it serves (owner, 2026-09-30).
  if (n.basis === 'Inferred') parts.push(inferredChip(pointed ? 20 : 10));
  if (o.links) {
    const cx = w + 5, cy = h / 2, label = `↗${o.links}`, lw = measure(label, TEXT.count, 600) + 8;
    parts.push(`<rect x="${cx - 2}" y="${cy - 10}" width="${lw}" height="20" rx="10" fill="${palette.chipBg}" stroke="${palette.chipBorder}"/>`, svgText(cx - 2 + lw / 2, cy + 4.5, label, { size: TEXT.count, weight: 600, fill: palette.nodeMuted, anchor: 'middle' }));
  }
  return picture(w, h, parts.join(''));
}
/** The shape an object is drawn in, for the material under it (graph-material.js): the same as its cytoscape shape. */
const shapeOf = (category) => { const k = colourKey(category); return k === 'intent' ? 'doc' : k === 'reality' ? 'ellipse' : 'hex'; };

/**
 * The picture of a process node (CKC-24, mockup graph-process-v0): two or three short lines — the step's kind and who
 * did it, then what reality gave — drawn with the same machinery as every other object. `d.tones` names each line's
 * tone: kind · muted · faint · danger · ok · accent. Returns the image fields the base node style reads.
 */
export function processImage(d) {
  const toneColor = (t) => t === 'danger' ? palette.danger : t === 'ok' ? palette.diffAdded : t === 'accent' ? palette.questioned : t === 'kind' ? (palette.nodeKind ?? palette.work) : t === 'faint' ? palette.nodeFaint : palette.nodeMuted;
  const w = d.w ?? PROC_SIZE.step[0], h = d.h ?? PROC_SIZE.step[1];
  const pad = 14;
  const parts = [];
  String(d.rawLabel ?? '').split('\n').slice(0, 3).forEach((text, i) => {
    const size = i === 0 ? TEXT.kind : TEXT.count;
    parts.push(svgText(pad, 19 + i * 15, clampLines(text, size, i === 0 ? 600 : 400, w - pad * 2, 1)[0], { size, weight: i === 0 ? 600 : 400, fill: toneColor(d.tones?.[i] ?? 'muted') }));
  });
  const pic = picture(w, h, parts.join(''));
  return { imgs: [pic.uri], imgWs: [pic.w], imgHs: [pic.h], imgOxs: [pic.ox], imgOys: [pic.oy] };
}

/**
 * The process layer (CKC-24): k-process.js registers it; the graph asks it for the folded line of a work, the branches
 * to draw, the works to alert, and whether a node passes the process filters. Without it (no data), nothing changes.
 */
let procLayer = null;
export function setProcessLayer(layer) { procLayer = layer; }
// A folded group is a small stack of cards with its count (D53): never a dashed box, which means a copy. An open
// group that stays on the picture (the owner's words) is one card: the heading of what is drawn beneath it.
function groupImage(label, count, w, h, open = false, marks = null, links = 0) {
  const chip = open ? `${count}` : `+${count}`, cw = measure(chip, TEXT.count, 600) + 12;
  const text = clampLines(label, TEXT.kind, 400, w - cw - 28, 1)[0];
  // A group and a folder are drawn entirely by their picture, so the material goes in the same picture, under the card.
  const m = materialOf(palette);
  return picture(w, h, (open ? '' : `<rect x="5.5" y="-3.5" width="${w - 11}" height="${h - 1}" rx="6" fill="${palette.groupBack}" stroke="${palette.groupBackBorder}"/>`)
    + (m ? materialSvg('card', w, h, { ...m, bg: palette.groupBg }, palette.groupBorder) : '')
    + `<rect x="0.6" y="0.6" width="${w - 1.2}" height="${h - 1.2}" rx="6" fill="${m ? 'none' : palette.groupBg}" stroke="${palette.groupBorder}" stroke-width="1.2"/>`
    + `<rect x="10" y="${h / 2 - 10}" width="${cw}" height="20" rx="10" fill="${palette.groupChip}"/>` + svgText(10 + cw / 2, h / 2 + 4.5, chip, { size: TEXT.count, weight: 600, anchor: 'middle' })
    + svgText(17 + cw, h / 2 + 4.5, text, { size: TEXT.kind, fill: palette.nodeMuted }) + badgesRight(w, marks) + linkChip(w, h, links), materialRoom(m));
}
/**
 * A card drawn by its picture, a few lines on it: an earlier generation's rolled band (its name and where its work
 * went), the head of `Not in a plan`, the head of the cross-cutting column. `lines`: [text, tone] with tone kind ·
 * text · muted · faint; `marks` as foldMarks, lit on the card's top edge.
 */
function cardImage(lines, w, h, { border = palette.groupBorder, marks = null } = {}) {
  const m = materialOf(palette);
  const tone = (t) => t === 'kind' ? (palette.nodeKind ?? border) : t === 'muted' ? palette.nodeMuted : t === 'faint' ? palette.nodeFaint : palette.nodeText;
  return picture(w, h, (m ? materialSvg('card', w, h, { ...m, bg: palette.groupBg }, border) : '')
    + `<rect x="0.6" y="0.6" width="${w - 1.2}" height="${h - 1.2}" rx="7" fill="${m ? 'none' : palette.groupBg}" stroke="${border}" stroke-width="1.4"/>`
    + lines.map(([t, tn], i) => { const size = i === 0 ? TEXT.kind : TEXT.count, weight = i === 0 ? 600 : 400; return svgText(12, 19 + i * 16, clampLines(t, size, weight, w - 24 - (i === 0 ? 90 : 0), 1)[0], { size, weight, fill: tone(tn) }); }).join('')
    + badgesRight(w, marks), materialRoom(m));
}
/** Nothing to draw: a band's background carries no words (its head does). */
const EMPTY_PIC = { uri: `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')}` };
/** The words on a band's or the ring's background, a small picture at its top left. */
function titlePicture(text, colour) {
  const w = Math.ceil(measure(text, TEXT.kind, 600)) + 6, h = 18;
  return { uri: `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w * 2}" height="${h * 2}" viewBox="0 0 ${w} ${h}">${svgText(2, 13, text, { size: TEXT.kind, weight: 600, fill: colour })}</svg>`)}`, w, h };
}
// One Observed reality folder per column (D55): what the List's cell in the same row holds, with the same numbers.
function folderImage(cell, w, h) {
  const c = COLUMN_COLOR.reality, tw = 78, th = 8;
  const path = `M1,${th + 4} V4 Q1,1 4,1 H${tw - 10} L${tw},${th} H${w - 4} Q${w - 1},${th} ${w - 1},${th + 4} V${h - 4} Q${w - 1},${h - 1} ${w - 4},${h - 1} H4 Q1,${h - 1} 1,${h - 4} Z`;
  // Three lines under the tab: the heading with the total, what the total is made of, and what hangs on it. An empty
  // folder has nothing for the third line, so its one sentence may run on to it; a long summary ends in an ellipsis
  // (the tooltip and the List's cell have it in full).
  const m = materialOf(palette);
  const parts = [m ? materialSvg('folder', w, h, m, c) : '', `<path d="${path}" fill="${m ? 'none' : palette.nodeBg}" stroke="${c}" stroke-width="1.5"/>`,
    svgText(12, 28, 'OBSERVED REALITY', { size: TEXT.kind, weight: 600, fill: palette.nodeKind ?? c }),
    svgText(w - 12, 31, String(cell.total), { size: TEXT.total, weight: 700, anchor: 'end', fill: cell.total ? palette.nodeText : palette.nodeFaint }),
    ...(cell.total ? clampLines(cellSummary(cell), TEXT.kind, 400, w - 24, 1) : clampLines('No result or verification recorded yet', TEXT.kind, 400, w - 24, 2)).map((t, i) => svgText(12, 47 + i * 17, t, { size: TEXT.kind, fill: cell.total ? palette.nodeText : palette.nodeFaint }))];
  let fx = 12;
  if (cell.unplaced) { const s = `${cell.unplaced} not linked to any work`; parts.push(svgText(fx, 64, s, { size: TEXT.kind, fill: palette.nodeMuted })); fx += measure(s, TEXT.kind) + 10; }
  for (const [mark, k] of [[MARKS.flag, cell.flagged], [MARKS.note, cell.noted], [MARKS.pending, cell.pending]]) {
    if (!k) continue;
    const s = `${mark.glyph} ${k}`;
    parts.push(svgText(fx, 64, s, { size: TEXT.count, weight: 600, fill: mark.color }));
    fx += measure(s, TEXT.count, 600) + 10;
  }
  return picture(w, h, parts.join(''), materialRoom(m));
}

// ── Where objects go ─────────────────────────────────────────────────────
// Every column equally wide and every object of a level equally big (D53): the name no longer sets the size.
//
// How much of a project fits a window at a readable zoom is decided here (CKC-09 AC-39): the zoom floor is fixed by the
// size of the words (graph-fit.js), so the lever is how big an object and the gaps are against its words. An object is
// just big enough for its line of kind and progress and two lines of name at those sizes (LINE, kindLine), what stands
// in a column is as wide as the column, and a gap is only what has to go through it:
//   colGap     a link count beside an object (D54), and the dotted line of an inferred own area up the column's left;
//   rowGap     between the top levels: the bus of the structure lines (`bus` below the upper object) and, under it, the
//              corner marks of the lower one, which stand 11px above it;
//   vGap       between objects in a column: the corner marks of the lower one;
//   bodyGap    under an area, folderGap above the row of folders, wordsGap more under the owner's words than vGap.
// At the floor a column takes (228 + 28) × 11/14 = 201px of the window and a row of work (60 + 12) × 11/14 = 57px. With
// the sizes before (11.5px names on 206 × 54, columns 244 apart) names reached 11px at zoom 0.96: 233px and 63px.
export const SIZE = { Product: [320, 62], heading: [228, 60], item: [228, 60], result: [200, 50], group: [228, 36], folder: [228, 72], genhead: [0, 44] };
/** Process nodes of increment K (CKC-24): a step of a work's branch, and an open send-back the branch points back from. */
export const PROC_SIZE = { step: [204, 54], suggest: [196, 48] };
// ringPad, ringTitle: the room inside the cross-cutting ring around what it holds, and its line of words on top;
// bandPad: the room inside a band above and below its cells; bandGap: between two bands.
export const LAYOUT = { colW: 228, colGap: 28, edge: 20, top: 16, rowGap: 24, bus: 12, bodyGap: 20, vGap: 12, folderGap: 20, wordsGap: 8, foot: 24, ringPad: 14, ringTitle: 24, bandPad: 14, bandGap: 10 };
const COL_W = LAYOUT.colW, COL_GAP = LAYOUT.colGap, EDGE = LAYOUT.edge, V_GAP = LAYOUT.vGap;
const PROGRESS_ORDER = { 'In progress': 0, 'Planned': 1, 'On hold': 2, 'Done': 3 };
const byName = (a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true });
/** How many work items a cell shows before the rest stack as `+n more` (Spec §6.3 "一格放不下时叠起来"). */
export const CELL_SHOWN = 3;
function sizeOf(d) {
  if (d.kind === 'folder') return SIZE.folder;
  if (d.kind === 'group') return SIZE.group;
  if (d.kind === 'genhead' || d.kind === 'band' || d.kind === 'ring') return [d.w, d.h];
  if (d.kind === 'bandhead' || d.kind === 'colhead') return SIZE.item;
  if (d.kind === 'proc-step' || d.kind === 'proc-suggest') return [d.w ?? PROC_SIZE.step[0], d.h ?? PROC_SIZE.step[1]];
  if (d.category === 'Product') return SIZE.Product;
  // Spec §6.3: the owner's words, goals and areas are one level and one size.
  if (d.category === 'Goal' || d.category === 'Area' || d.category === OWNER_WORDS) return SIZE.heading;
  if (FOLDABLE.has(d.category)) return SIZE.result;
  return SIZE.item;
}
/** The width of the story map for so many areas: the band heads, one column per area, the cross-cutting column. */
export const storyWidth = (areaCount) => EDGE * 2 + (areaCount + 2) * COL_W + (areaCount + 1) * COL_GAP;

/**
 * The story map (D100; Spec §6.3 "默认可见"): from the top, the owner's words, the product and the goals; the areas as
 * columns, each with its requirements, designs and decisions folded at its top; the cross-cutting ring under that row;
 * then the bands — the earlier generations rolled, each current plan, `Not in a plan` — each work in its (area × plan)
 * cell; the Observed reality folders below every band. Left of the columns is the column of the bands' heads (the plan
 * itself, its execution decisions); right of them the cross-cutting column (no one area).
 *
 * Each item says where it goes by `slot` (the render puts it there from ui/placement.js): { zone, col, band, bi, after,
 * indent }. zone: words · product · goal · area · colhead · intent · ring · genhead · head · cell · folder. An item
 * with `after` stands right under that item in the same place (a result under its work, a process step under its work).
 * An item without a slot (a test's made-up project) is placed by its category and `areaId`, its work in `Not in a plan`.
 * Returns each item's box (top-left, size, column: -1 for what spans the columns), the columns, the bands and the ring
 * as boxes, and the size of the whole; null when there are no areas to build columns from.
 */
export function storyLayout(items) {
  const areas = items.filter((d) => d.category === 'Area' && !d.kind);
  if (areas.length === 0) return null;
  // The columns keep the order the areas come in (the render gives them in the model's order, by name).
  const keys = [...areas.map((a) => a.id), null];
  const A = areas.length;
  const headX = EDGE;
  const colX = keys.map((_, i) => EDGE + (i + 1) * (COL_W + COL_GAP));
  const width = storyWidth(A);
  const colOfArea = (id) => { const i = keys.indexOf(id ?? null); return i >= 0 ? i : A; };
  const slotOf = (d) => {
    if (d.slot) return d.slot;
    if (d.kind === 'folder') return { zone: 'folder', col: colOfArea(d.folder) };
    if (d.category === 'Product') return { zone: 'product' };
    if (d.category === 'Goal') return { zone: 'goal' };
    if (d.category === 'Area') return { zone: 'area', col: colOfArea(d.id) };
    if (isWordsItem(d)) return { zone: 'words' };
    return { zone: 'cell', band: NO_PLAN, bi: 0, col: d.kind === 'group' ? A : colOfArea(d.areaId) };
  };
  const box = new Map();
  const put = (d, x, top, col) => { const [w, h] = sizeOf(d); box.set(d.id, { x, y: top, w, h, col }); return h; };
  const byZone = new Map();
  for (const d of items) { const s = slotOf(d); if (!byZone.has(s.zone)) byZone.set(s.zone, []); byZone.get(s.zone).push({ d, s }); }
  const zone = (z) => byZone.get(z) ?? [];
  /** A place's items in order: each followed by the items that stand right under it (by `after`, in `seq` order). */
  const ordered = (list) => {
    const main = list.filter((x) => !x.s.after || !list.some((y) => y.d.id === x.s.after));
    const out = [];
    const follow = (id) => list.filter((x) => x.s.after === id).sort((a, b) => (a.d.seq ?? 0) - (b.d.seq ?? 0));
    const add = (x) => { out.push(x); for (const f of follow(x.d.id)) add(f); };
    for (const x of main) add(x);
    return out;
  };
  /** Stacks a place's items from `top` in the column at `x`; returns the bottom of the last. */
  const stack = (list, x, top, col) => {
    let y = top, bottom = top - V_GAP;
    for (const { d, s } of ordered(list)) { const h = put(d, x + (s.indent ?? 0), y, col); bottom = y + h; y = bottom + V_GAP; }
    return bottom;
  };
  const spanX0 = colX[0], spanX1 = colX[A] + COL_W;

  // The owner's words above everything (Spec §6.3, D63): their card, and when open the words in rows, one per column.
  let y = LAYOUT.top;
  let band = -1;
  const wordsHead = zone('words').filter((x) => x.d.kind === 'group');
  const words = zone('words').filter((x) => x.d.kind !== 'group');
  if (wordsHead.length || words.length) {
    for (const { d } of wordsHead) y += put(d, (spanX0 + spanX1) / 2 - sizeOf(d)[0] / 2, y, -1) + V_GAP;
    band = Math.ceil(words.length / keys.length);
    words.forEach(({ d }, i) => put(d, colX[i % keys.length], y + Math.floor(i / keys.length) * (SIZE.heading[1] + V_GAP), -1));
    y += band * (SIZE.heading[1] + V_GAP) + LAYOUT.wordsGap;
  }
  const rows = { product: y };
  for (const { d } of zone('product')) put(d, (spanX0 + spanX1) / 2 - sizeOf(d)[0] / 2, y, -1);
  rows.goal = zone('product').length ? y + SIZE.Product[1] + LAYOUT.rowGap : y;
  const goals = zone('goal');
  goals.forEach(({ d }, i) => put(d, spanX0 + (spanX1 - spanX0) * ((i + 0.5) / goals.length) - sizeOf(d)[0] / 2, rows.goal, -1));
  rows.area = goals.length ? rows.goal + SIZE.heading[1] + LAYOUT.rowGap : rows.goal;
  for (const { d, s } of [...zone('area'), ...zone('colhead')]) put(d, colX[s.col ?? colOfArea(d.id)], rows.area, s.col ?? colOfArea(d.id));
  rows.body = rows.area + SIZE.heading[1] + LAYOUT.bodyGap;

  // Each column's requirements, designs and decisions, folded at its top.
  let bottom = rows.body - LAYOUT.bodyGap;
  for (let c = 0; c <= A; c++) bottom = Math.max(bottom, stack(zone('intent').filter((x) => x.s.col === c), colX[c], rows.body, c));

  // The cross-cutting ring: under the requirement row, above every band; its items across the columns, row by row.
  let ring = null;
  const inRing = ordered(zone('ring'));
  if (inRing.length) {
    const top = bottom + LAYOUT.rowGap;
    let rowTop = top + LAYOUT.ringTitle, rowH = 0, i = 0;
    for (const { d } of inRing) {
      if (i === keys.length) { rowTop += rowH + V_GAP; rowH = 0; i = 0; }
      rowH = Math.max(rowH, put(d, colX[i], rowTop, i));
      i++;
    }
    const ringBottom = rowTop + rowH + LAYOUT.ringPad;
    ring = { x: spanX0 - LAYOUT.ringPad, y: top, w: spanX1 - spanX0 + 2 * LAYOUT.ringPad, h: ringBottom - top };
    bottom = ringBottom;
  }
  rows.bands = bottom + LAYOUT.rowGap;

  // The bands, in their order: the earlier generations, the current plans, `Not in a plan`.
  const bandItems = new Map();
  for (const z of ['genhead', 'head', 'cell']) for (const x of zone(z)) { const k = x.s.band; if (!bandItems.has(k)) bandItems.set(k, { bi: x.s.bi ?? 0, list: [] }); bandItems.get(k).list.push(x); }
  const bands = [];
  y = rows.bands;
  for (const [key, { bi, list }] of [...bandItems].sort((a, b) => a[1].bi - b[1].bi)) {
    const top = y;
    let inner = top + LAYOUT.bandPad;
    for (const { d } of list.filter((x) => x.s.zone === 'genhead')) inner += put(d, headX, inner, -1) + V_GAP;
    let low = inner - V_GAP;
    low = Math.max(low, stack(list.filter((x) => x.s.zone === 'head'), headX, inner, -1));
    for (let c = 0; c <= A; c++) low = Math.max(low, stack(list.filter((x) => x.s.zone === 'cell' && x.s.col === c), colX[c], inner, c));
    const h = low + LAYOUT.bandPad - top;
    bands.push({ key, kind: list[0]?.s.kind ?? null, x: EDGE / 2, y: top, w: width - EDGE, h });
    y = top + h + LAYOUT.bandGap;
  }
  const folderY = (bands.length ? y - LAYOUT.bandGap : rows.bands - LAYOUT.rowGap) + LAYOUT.folderGap;
  for (const { d, s } of zone('folder')) put(d, colX[s.col], folderY, s.col);
  return { box, keys, colX, headX, width, rows, band, ring, bands, folderY, height: folderY + SIZE.folder[1] + LAYOUT.foot };
}


// ── Readability self-check (D46; CKC-09 AC-26, AC-27) ────────────────────
/**
 * Reads the picture as it is drawn and reports what a machine can judge: objects on top of each other, lines running
 * behind objects they do not connect, a picture that cannot be read at any size that fits the window, and many lines
 * bunched into one object. It never changes what is drawn; the owner is told where it is hard to read and offered a
 * way to look at it (focus a path, another scale, a part of the picture at a readable size).
 *
 * `nodes`: { id, label, x, y, w, h } (centre and size; `top` and `right` when something stands out of the object: its
 * corner marks, its link count); `edges`: { id, source, target, points? } where `points` is the line as drawn (a
 * polyline from source to target); without it the straight line between the centres is used.
 * `viewport`: { w, h } in pixels.
 */
// The zoom no view of the graph's own choosing goes below (graph-fit.js): a name is then as small as the interface's
// smallest body text, and no smaller. "Too big to read at once" is judged against it, by the sum the viewport itself
// uses — on the view the graph would open on, whatever view the owner has chosen since (they may zoom out further).
export const READABLE_ZOOM = ZOOM_FLOOR;
export function readabilityReport(nodes, edges, viewport, fitOpts = {}) {
  const shrink = 2;   // boxes that only touch are not "on top of each other"
  const box = new Map(nodes.map((n) => [n.id, { ...n, x1: n.x - n.w / 2 + shrink, x2: n.x + n.w / 2 - shrink, y1: n.y - n.h / 2 + shrink, y2: n.y + n.h / 2 - shrink }]));
  const boxes = [...box.values()].sort((a, b) => a.x1 - b.x1);
  const issues = [];

  // Objects on top of each other: sweep along x, compare only boxes whose x ranges meet.
  const overlapping = new Set();
  const pairs = [];
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length && boxes[j].x1 < a.x2; j++) {
      const b = boxes[j];
      if (b.y1 < a.y2 && a.y1 < b.y2) { overlapping.add(a.id); overlapping.add(b.id); pairs.push([a.id, b.id]); }
    }
  }
  if (pairs.length) issues.push({ kind: 'overlap', count: overlapping.size, ids: [...overlapping], pairs, text: `${overlapping.size} objects sit on top of each other in ${pairs.length} place${pairs.length === 1 ? '' : 's'}` });

  // Lines behind objects they do not connect: every segment of the line as drawn, against every other box.
  const crosses = (x1, y1, x2, y2, b) => {
    let t0 = 0, t1 = 1;
    const dx = x2 - x1, dy = y2 - y1;
    for (const [pp, q] of [[-dx, x1 - b.x1], [dx, b.x2 - x1], [-dy, y1 - b.y1], [dy, b.y2 - y1]]) {
      if (pp === 0) { if (q < 0) return false; continue; }
      const r = q / pp;
      if (pp < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return t0 <= t1;
  };
  const behind = [];
  for (const e of edges) {
    const a = box.get(e.source), b = box.get(e.target);
    if (!a || !b || a === b) continue;
    const pts = e.points?.length >= 2 ? e.points : [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
    const hit = new Set();
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i], q = pts[i + 1];
      const minX = Math.min(p.x, q.x), maxX = Math.max(p.x, q.x), minY = Math.min(p.y, q.y), maxY = Math.max(p.y, q.y);
      for (const o of boxes) {
        if (o.x1 > maxX) break;
        if (o.id === e.source || o.id === e.target || o.x2 < minX || o.y2 < minY || o.y1 > maxY) continue;
        if (crosses(p.x, p.y, q.x, q.y, o)) hit.add(o.id);
      }
    }
    if (hit.size) behind.push({ edge: e.id, source: e.source, target: e.target, hidden: [...hit] });
  }
  if (behind.length) {
    behind.sort((x, y) => y.hidden.length - x.hidden.length);
    issues.push({ kind: 'behind', count: behind.length, ids: [...new Set(behind.flatMap((x) => [x.source, x.target]))], worst: behind.slice(0, 8), text: `${behind.length} line${behind.length === 1 ? '' : 's'} of ${edges.length} run behind objects they do not connect` });
  }

  // Too big to read at once: fitted to the window its names would be smaller than the smallest body text, so it is
  // shown at the zoom floor instead and the rest is reached by dragging. Said exactly when the view the graph opens on
  // does not hold the whole picture (fitView is what the viewport uses), so the two cannot disagree; nothing is drawn
  // smaller or left out to make this go away (D46).
  if (nodes.length) {
    const v = fitView(pictureBox(nodes), viewport, fitOpts);   // the same room kept clear as the viewport keeps
    if (!v.fits) issues.push({ kind: 'size', count: boxes.length, ids: [], fitZoom: v.fitZoom, floor: v.zoom, across: v.across, down: v.down, text: `Fitted to the window, names would be ${(TEXT.name * v.fitZoom).toFixed(1)}px, under the ${MIN_TEXT_PX}px of the smallest text here; kept readable, the picture is ${v.across.toFixed(1)} × ${v.down.toFixed(1)} windows, so it opens on its top left and the rest is reached by dragging` });
  }

  // Lines bunched into one object.
  const degree = new Map();
  for (const e of edges) for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const hubs = [...degree].filter(([id, d]) => d >= 20 && box.has(id)).sort((a, b) => b[1] - a[1]);
  if (hubs.length) issues.push({ kind: 'bundle', count: hubs.length, ids: hubs.map(([id]) => id), hubs: hubs.map(([id, d]) => ({ id, degree: d })), text: `${hubs.length} object${hubs.length === 1 ? '' : 's'} with 20 or more lines meeting on them` });

  return { issues, nodes: boxes.length, edges: edges.length };
}

// ── The graph ────────────────────────────────────────────────────────────
let registered = false;
function ensureRegistered() {
  if (registered) return;
  if (typeof cytoscape === 'undefined') throw new Error('cytoscape is not loaded');
  if (typeof cytoscapeDagre !== 'undefined') cytoscape.use(cytoscapeDagre);
  registered = true;
}
const DOC_POLYGON = '-1 -1 0.72 -1 1 -0.62 1 1 -1 1';   // a document with a folded top-right corner (-1..1)
const HEX_POLYGON = '-0.8 -1 0.8 -1 1 0 0.8 1 -0.8 1 -1 0';   // a long hexagon whose points stay the same size

/**
 * A relation's part in the picture (D54). `own`: work serving the area whose column it stands in — the column says it,
 * so no line, except a dotted one when the Keeper inferred it. `structure`: goal → product, area → goal, and project-wide
 * plans → product — right-angled lines along shared buses. `other`: everything else — a count beside each end, drawn on
 * hover, on selection, or all at once with the switch.
 */
function relationPart(r, from, to, M) {
  if (!from || !to) return 'other';
  if (from.category === 'Goal' && to.category === 'Product') return 'structure';
  if (from.category === 'Area' && to.category === 'Goal') return 'structure';
  const pf = M?.place.get(from.id), areaOf = (p) => p?.area ?? (p?.zone === 'intent' ? p.area : null);
  // The story map says it where the object stands (D54, D100): work in its area's column serves that area, work in its
  // plan's band belongs to that plan, a decision or requirement at a column's top refines that area, an execution
  // decision in a plan's band refines that plan, and everything stands under the product.
  if (to.category === 'Area' && (r.type === 'serves' || r.type === 'refines') && areaOf(pf) === to.id) return 'own';
  // A work item serving several areas stands in each of them, dashed outside its own (owner, 2026-09-30): the copy in
  // that column says it, so no line either.
  if (to.category === 'Area' && r.type === 'serves' && pf?.areas?.includes(to.id)) return 'implied';
  if (to.category === 'Plan' && (r.type === 'serves' || r.type === 'refines') && pf?.band === to.id) return 'implied';
  if ((to.category === 'Product' || to.category === 'Goal') && r.type === 'refines') return 'implied';
  if (from.category === 'Plan' && (to.category === 'Product' || to.category === 'Goal')) return 'implied';
  // A work serving a requirement at the top of its own column: the column says it too.
  if (r.type === 'serves' && isWork(from.category) && pf?.area && M?.place.get(to.id)?.zone === 'intent' && (pf.areas ?? [pf.area]).includes(M.place.get(to.id).area)) return 'implied';
  return 'other';
}

/**
 * The stylesheet, from a palette (graph-palette.js): the same rules for every theme, the colours from the theme in
 * force. An object carries up to two pictures: its words, marks and link count over everything (containment `over`),
 * and — when the theme lends material — the card's material under cytoscape's own border (`inside`), so the coloured
 * edge and the selection ring stay on top of it.
 */
/** How strong a work item's copy is drawn against the solid one (1): at rest, selected, pointed at. */
export const COPY_OPACITY = Object.freeze({ rest: 0.5, selected: 0.9, hover: 0.95 });
/**
 * A copy at rest is a pale ghost of the solid card (owner, 2026-10-01, E153: 「他是暗的，不是淡色一点，背景的透明度高一点呢」):
 * the card keeps its own fill, a little let through, and its words, material and frame fade. Fading the whole card —
 * fill and all, as it was — let the dark ground through a light card, and it read dark grey on the dark themes. On a
 * theme whose cards are dark the two look the same.
 */
export const COPY_GHOST = Object.freeze({ fill: 0.9, words: COPY_OPACITY.rest, material: 0.5, frame: 0.6 });
export function graphStyle(p) {
  return [
    { selector: 'node', style: {
      'shape': 'round-rectangle', 'background-color': p.nodeBg, 'border-width': 1.5, 'border-color': 'data(color)', 'label': '', 'width': 'data(w)', 'height': 'data(h)',
      'background-image': 'data(imgs)', 'background-width': 'data(imgWs)', 'background-height': 'data(imgHs)', 'background-position-x': ['0%', '0%'], 'background-position-y': ['0%', '0%'], 'background-offset-x': 'data(imgOxs)', 'background-offset-y': 'data(imgOys)',
      'background-clip': ['none', 'none'], 'background-image-containment': ['over', 'inside'], 'bounds-expansion': OVER.right, 'background-image-smoothing': ['yes', 'yes'], 'background-image-opacity': [1, 1],
    } },
    { selector: 'node.col-intent', style: { 'shape': 'polygon', 'shape-polygon-points': DOC_POLYGON } },
    { selector: 'node.col-work', style: { 'shape': 'polygon', 'shape-polygon-points': HEX_POLYGON } },
    { selector: 'node.col-reality', style: { 'shape': 'ellipse' } },
    { selector: 'node[category = "Product"]', style: { 'border-width': 2.2 } },
    // A group and a folder are drawn entirely by their picture (stacked cards, a folder); the node is only the place to click.
    { selector: 'node.group, node.folder, node.card', style: { 'background-opacity': 0, 'border-width': 0 } },
    // The story map's bands and its cross-cutting ring (D100): backgrounds under everything, never in the way of a click.
    // The ring is the one drawing that rings a group of objects (Spec §6.3), a solid line with round corners; a band is
    // a soft strip across the columns. Neither is dashed: a dashed frame means a work item's copy.
    { selector: 'node.band, node.ring', style: {
      'shape': 'round-rectangle', 'events': 'no', 'z-compound-depth': 'bottom', 'z-index': 0, 'border-width': 1, 'background-opacity': 0.07, 'border-opacity': 0.5,
      'background-image': 'data(imgs)', 'background-width': 'data(imgWs)', 'background-height': 'data(imgHs)', 'background-position-x': 0, 'background-position-y': 0,
      'background-offset-x': 36, 'background-offset-y': 5, 'background-image-containment': 'inside', 'background-clip': 'node', 'bounds-expansion': 0,
    } },
    { selector: 'node.band', style: { 'background-color': p.groupBorder, 'border-color': p.groupBorder, 'corner-radius': 10 } },
    { selector: 'node.band.plan', style: { 'background-color': p.plan, 'border-color': p.plan } },
    { selector: 'node.band.none', style: { 'background-opacity': 0.03 } },
    { selector: 'node.ring', style: { 'background-color': p.intent, 'border-color': p.intent, 'border-width': 1.6, 'border-opacity': 0.8, 'corner-radius': 34 } },
    // A dashed frame is a work item's copy in another module it serves, its main one solid elsewhere (owner, 2026-09-30;
    // Spec §2.3, §6.3), and nothing else. An inferred object is solid with the word `Inferred` on it (objectImage); an
    // inferred relation is a dotted line (below).
    // The whole copy is fainter than the solid one — words, material and frame (owner, 2026-10-01, E152: 「实现框和虚线框好像
    // 看不出区别…要么整个变成透明一点的卡，只是边缘虚线区别不太大」): the dashes alone did not tell them apart at the zoom the
    // picture opens on. How faint is set further down, after the scales' own (COPY_GHOST, COPY_OPACITY).
    { selector: 'node.copy', style: { 'border-style': 'dashed', 'border-width': 1.6 } },
    { selector: 'node.copy-sel', style: { 'border-color': p.selection, 'border-width': 2.5 } },
    { selector: 'node.replaced', style: { 'border-color': p.replaced } },
    { selector: 'node.faded', style: { 'opacity': 0.18 } },
    // Selection and flash are white, so a selected node never looks like one of the kinds (owner 2026-09-17).
    { selector: 'node:selected', style: { 'border-color': p.selection, 'border-width': 2.5, 'outline-color': p.selection, 'outline-width': 4, 'outline-opacity': 0.22, 'z-index': 10 } },
    // The mark `Show on graph` and `Show affected` leave on an object. The focus colour, not a kind colour, and drawn
    // outside the shape so it stays obvious at the zoom floor on every theme — a thin translucent outline was not.
    { selector: 'node.hit', style: {
      'underlay-color': p.focus, 'underlay-padding': 16, 'underlay-opacity': 0.92,
      'outline-color': p.focus, 'outline-width': 8, 'outline-opacity': 1, 'outline-offset': 3,
      'border-color': p.focus, 'border-width': 3.5, 'z-index': 45,
    } },
    // In the Work scale the focused node is the one the owner is reading from; everything on its path stays lit and
    // everything else fades. The focus is a ring, not a bigger node, so its neighbours stay where they are.
    { selector: 'node.near', style: { 'opacity': 0.78 } },
    // A copy is a pale ghost wherever it would otherwise be drawn at full strength, near a focus too; pointed at, or
    // selected (its work item is), it comes forward enough to read, and stays dashed. Faded by a focus it fades with
    // the rest.
    { selector: 'node.copy', style: { 'opacity': 1, 'background-opacity': COPY_GHOST.fill, 'background-image-opacity': [COPY_GHOST.words, COPY_GHOST.material], 'border-opacity': COPY_GHOST.frame } },
    { selector: 'node.copy.faded', style: { 'opacity': 0.12 } },
    { selector: 'node.copy.copy-sel', style: { 'background-opacity': 1, 'background-image-opacity': [COPY_OPACITY.selected, 1], 'border-opacity': 1 } },
    { selector: 'node.copy.copy-hover', style: { 'background-opacity': 1, 'background-image-opacity': [COPY_OPACITY.hover, 1], 'border-opacity': 1 } },
    { selector: 'node.copy.hit', style: { 'background-opacity': 1, 'background-image-opacity': [1, 1], 'border-opacity': 1 } },
    // Compare: what appeared, what changed, what is gone. Colour carries it; nothing changes size (D45, D46).
    { selector: 'node.diff-added', style: { 'border-color': p.diffAdded, 'border-width': 3 } },
    { selector: 'node.diff-changed', style: { 'border-color': p.diffChanged, 'border-width': 3 } },
    { selector: 'node.diff-removed', style: { 'border-color': p.diffRemoved, 'border-width': 3, 'opacity': 0.5 } },
    { selector: 'node.focus', style: { 'opacity': 1, 'border-color': p.selection, 'border-width': 3, 'outline-color': p.focus, 'outline-width': 7, 'outline-opacity': 0.75, 'outline-offset': 2, 'z-index': 30 } },
    // Lines: the style says the basis only (solid Explicit, dotted Inferred); the type is written on a line when it
    // is picked out, never told by colour (D53).
    { selector: 'edge', style: {
      'width': 1.1, 'line-color': p.edge, 'target-arrow-color': p.edge, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.7, 'curve-style': 'bezier', 'opacity': 0.85,
      'label': 'data(mark)', 'font-size': TEXT.kind, 'font-family': FONT, 'color': p.nodeText, 'text-opacity': 1, 'text-background-color': p.labelBg, 'text-background-opacity': 1, 'text-background-padding': 2, 'text-background-shape': 'roundrectangle',
      'text-border-color': p.chipBorder, 'text-border-width': 1, 'text-border-opacity': 1, 'text-rotation': 'none', 'min-zoomed-font-size': 5,
    } },
    { selector: 'edge[mark = ""]', style: { 'text-background-opacity': 0, 'text-border-opacity': 0 } },
    // A relation with a note that still needs the owner carries a lit ❓ on its line (D100); the others a quiet one.
    { selector: 'edge.noted', style: { 'text-opacity': 0.6 } },
    { selector: 'edge.own, edge.implied', style: { 'display': 'none' } },
    { selector: 'edge.other', style: { 'display': 'none', 'line-color': p.edgeOther, 'target-arrow-color': p.edgeOther } },
    { selector: 'edge.own.inferred, edge.other.all-links', style: { 'display': 'element' } },
    { selector: 'edge.inferred', style: { 'line-style': 'dotted', 'line-color': p.edgeOther, 'target-arrow-color': p.edgeOther } },
    { selector: 'edge.questioned', style: { 'display': 'element', 'width': 2, 'line-color': p.questioned, 'target-arrow-color': p.questioned, 'opacity': 1, 'label': 'data(elabel)', 'color': p.questioned, 'text-border-color': p.questioned, 'text-background-opacity': 1, 'text-border-opacity': 1 } },
    { selector: 'edge.ask', style: { 'display': 'element', 'text-opacity': 1, 'text-border-color': p.markAsk, 'text-border-width': 2, 'text-background-color': tint(p.markAsk, 0.75, p.chipBg) } },
    { selector: 'edge.related', style: { 'display': 'element', 'opacity': 1, 'line-color': p.edgeRelated, 'target-arrow-color': p.edgeRelated, 'z-index': 9 } },
    { selector: 'edge.lit', style: { 'display': 'element', 'opacity': 1, 'width': 1.6, 'line-color': p.edgeLit, 'target-arrow-color': p.edgeLit, 'label': 'data(elabel)', 'text-background-opacity': 1, 'text-border-opacity': 1, 'z-index': 20 } },
    { selector: 'edge.lit.questioned', style: { 'line-color': p.questioned, 'target-arrow-color': p.questioned } },
    { selector: 'edge.faded', style: { 'opacity': 0.08 } },
    { selector: 'edge:selected', style: { 'display': 'element', 'line-color': p.edgeSelected, 'target-arrow-color': p.edgeSelected, 'width': 2.5, 'label': 'data(elabel)', 'text-background-opacity': 1, 'text-border-opacity': 1, 'opacity': 1 } },
    // A relation's mark: the line itself, thick and in the focus colour, including a line the picture otherwise hides.
    { selector: 'edge.hit', style: {
      'display': 'element', 'width': 6, 'opacity': 1, 'z-index': 45,
      'line-color': p.focus, 'target-arrow-color': p.focus,
      'underlay-color': p.focus, 'underlay-padding': 8, 'underlay-opacity': 0.9,
    } },
    // ── The process view (CKC-24; mockup graph-process-v0): steps are smaller hexagons; a send-back still open is an
    // ellipse; the arrow of a send-back going back is dashed red, a hand-off curved blue, a pointer to another area's
    // work dotted. The labels say the stage, so the colour is never the only carrier. ──
    { selector: 'node.proc-step', style: { 'shape': 'polygon', 'shape-polygon-points': HEX_POLYGON, 'border-color': p.work } },
    // Solid, like every object but a work item's copy (Spec §6.3: a dashed frame is only that); the ellipse and the red say it.
    { selector: 'node.proc-suggest', style: { 'shape': 'ellipse', 'border-color': p.danger, 'border-width': 2 } },
    { selector: 'node.proc-suggest.returned', style: { 'border-color': p.questioned } },
    { selector: 'node.proc-alert', style: { 'border-color': p.danger, 'border-width': 2.5 } },
    { selector: 'edge.proc-ret', style: { 'line-style': 'dashed', 'line-color': p.danger, 'target-arrow-color': p.danger, 'color': p.danger, 'label': 'data(elabel)', 'z-index': 6 } },
    { selector: 'edge.proc-sug', style: { 'line-style': 'dashed', 'line-color': p.danger, 'target-arrow-color': p.danger, 'color': p.danger, 'label': 'data(elabel)', 'z-index': 6 } },
    { selector: 'edge.proc-sug.plan', style: { 'line-color': p.questioned, 'target-arrow-color': p.questioned, 'color': p.questioned } },
    { selector: 'edge.proc-hand', style: { 'line-style': 'dashed', 'line-color': p.intent, 'target-arrow-color': p.intent, 'color': p.intent, 'label': 'data(elabel)', 'curve-style': 'unbundled-bezier', 'control-point-distances': [-140], 'control-point-weights': [0.5], 'z-index': 6 } },
    { selector: 'edge.proc-ptr', style: { 'line-style': 'dotted', 'line-color': p.edgeOther, 'target-arrow-color': p.edgeOther, 'label': 'data(elabel)', 'curve-style': 'unbundled-bezier', 'control-point-distances': [120], 'control-point-weights': [0.5] } },
    { selector: 'edge.proc-chain', style: { 'label': 'data(elabel)' } },
  ];
}

export function createGraph(container, handlers) {
  ensureRegistered();
  refreshPalette();
  const cy = cytoscape({
    container,
    wheelSensitivity: 1,
    // How far the owner's own wheel and pinch go; lowered when the whole picture needs less (setZoomLimit), so the whole
    // of a large project can always be reached by hand. It is not the floor: that one (ZOOM_FLOOR) is for the views the
    // graph chooses, and the graph holds itself to it (fitReadable, showAffected).
    minZoom: ZOOM_HARD_MIN,
    style: graphStyle(palette),
  });

  const view = {
    data: null, scale: 'Overview', showReplaced: false, links: 'counts', expandedGroups: new Set(), expandedWork: new Set(),
    filters: { category: '', validity: '', progress: '', acceptance: '', assessment: '', withNotes: false, recent: false, bpKind: '', sbStage: '', sixThing: '' }, focusId: null, selectionId: null, compare: null,
    starMode: 'visit', lastVisit: null, starred: new Set(), starNote: '',
  };
  let lastKey = '';
  let firstLayout = true;
  let lastEmph = '';
  const emphasisKey = () => `${view.scale}|${view.selectionId ?? ''}|${view.focusId ?? ''}|${view.compare?.side ?? ''}|${view.compare?.index ?? ''}|${(view.compare?.items ?? []).map((i) => `${i.id}:${i.kind}`).join(',')}`;
  let hoverId = null;
  // The copy a work item was selected from: its popover stands beside that copy (rectOf) until something else is picked.
  let anchorAt = null;
  let layoutInfo = null;
  // Marks left by `Show on graph` and `Show affected`. They stay until the owner picks something else, clicks the
  // blank graph, or closes the popover (`clearMarks`) — not a flash.
  let pinned = [];

  // ── The view (CKC-09 AC-39; Spec §6.3 "布局") ─────────────────────────────
  // `auto`: the view is the one the graph chose — the whole picture, or its top left at the zoom floor. It stays the
  // graph's through every change of size (the window, or a panel docking beside the graph) and is worked out again each
  // time, until the owner zooms or drags themselves, or asks for the whole picture (`Show all anyway`). From then on a
  // change of size leaves their view alone, whatever its zoom — the owner may be below the floor, to see the shape of a
  // large project — and only keeps the picture from being left out of sight. `Fit` gives the view back to the graph.
  let auto = true;
  let chosen = null;            // the view the graph last chose, to tell the owner's move from a wheel turn that changed nothing
  let seen = { w: 0, h: 0 };    // the window's size the view was last settled for
  let readTimer = 0;
  // Read off the container itself: cytoscape keeps its own copy of the size until it looks again, which may be later.
  const windowSize = () => ({ w: container.clientWidth, h: container.clientHeight });
  /** The objects as they stand, by centre and size, with what stands out of them; the viewport and the self-check both read this. */
  // The bands and the ring are backgrounds: what is fitted and what the self-check judges are the objects on them.
  const pictureNodes = () => cy.nodes().filter((n) => !n.hasClass('band') && !n.hasClass('ring')).map((n) => { const p = n.position(); return { id: n.id(), label: n.data('rawLabel'), areaId: n.data('areaId') ?? null, x: p.x, y: p.y, w: n.data('w') ?? n.width(), h: n.data('h') ?? n.height(), top: n.data('overTop') ?? 0, right: n.data('overRight') ?? 0 }; });
  const boxOf = (el) => { const p = el.position(), w = el.data('w') ?? el.width(), h = el.data('h') ?? el.height(); return { x1: p.x - w / 2, y1: p.y - h / 2 - (el.data('overTop') ?? 0), x2: p.x + w / 2 + (el.data('overRight') ?? 0), y2: p.y + h / 2 }; };
  /** How far the owner's own wheel and pinch go, for the picture and the window as they are now (graph-fit.js
   *  hardMinZoom). Never above the zoom the owner is at: when the picture gets smaller while they are zoomed far out,
   *  the limit waits for them to zoom in, so that setting it moves nothing under them. */
  /** Room the page keeps clear at the top of the graph's window (its buttons float over the top right corner, CKC-09
   *  AC-37): every view worked out here, and the self-check that judges them, take it off the same way (graph-fit.js). */
  const fitOpts = () => { const top = handlers.fitPadTop?.() ?? 0; return top > 0 ? { padTop: top } : {}; };
  const setZoomLimit = () => { cy.minZoom(Math.min(hardMinZoom(pictureBox(pictureNodes()), windowSize(), fitOpts()), cy.zoom())); };
  // cytoscape says `scrollzoom` for every turn of the wheel, also for one the hard limit swallowed, so the view is compared.
  cy.on('scrollzoom pinchzoom dragpan', () => {
    const pan = cy.pan();
    if (!chosen || Math.abs(cy.zoom() - chosen.zoom) > 1e-6 || Math.abs(pan.x - chosen.pan.x) > 0.5 || Math.abs(pan.y - chosen.pan.y) > 0.5) auto = false;
  });
  /** The owner's view, or one made for them (an object brought into view, what a change touched): no longer the graph's. */
  const ownView = () => { auto = false; chosen = null; };
  /**
   * After the graph's window changed size. Its container is watched, not only the browser window: a panel docking
   * beside the graph changes the container and nothing else. A selected object that was in sight stays in sight.
   */
  function onResize() {
    const now = windowSize();
    if (Math.abs(now.w - seen.w) < 2 && Math.abs(now.h - seen.h) < 2) return;
    const before = seen, zoom = cy.zoom(), pan = { ...cy.pan() };
    seen = now;
    cy.resize();   // cytoscape reads its container again; the `resize` it then says comes back here and finds nothing new
    if (now.w < 2 || now.h < 2 || !cy.nodes().length) return;
    setZoomLimit();
    if (auto) fitReadable();
    else { const kept = keepInView(pictureBox(pictureNodes()), now, zoom, pan); if (kept !== pan) cy.pan(kept); }
    const sel = view.selectionId ? cy.getElementById(view.selectionId) : null;
    if (sel?.length && sel.isNode() && before.w >= 2 && inView(boxOf(sel), before, zoom, pan) && !inView(boxOf(sel), windowSize(), cy.zoom(), cy.pan())) {
      cy.pan(panToShow(boxOf(sel), windowSize(), cy.zoom(), cy.pan()));
      if (auto) chosen = { zoom: cy.zoom(), pan: { ...cy.pan() } };
    }
    // Whether the picture is too big to read at once depends on the window; said again once the size has settled.
    clearTimeout(readTimer);
    readTimer = setTimeout(() => { if (!cy.destroyed()) checkReadability(); }, 150);
  }
  const resizeWatch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
  resizeWatch?.observe(container);
  cy.on('resize', onResize);

  // The full name and what the marks mean are in the tooltip (Spec §6.3: names are two lines at most on the object).
  const tip = document.createElement('div');
  tip.className = 'graph-tip';
  tip.hidden = true;
  document.body.append(tip);
  const showTip = (e, html) => { tip.innerHTML = html; tip.hidden = false; moveTip(e); };
  const moveTip = (e) => { const o = e.originalEvent; if (!o) return; const W = tip.offsetWidth, H = tip.offsetHeight; tip.style.left = `${Math.min(o.clientX + 14, innerWidth - W - 8)}px`; tip.style.top = `${Math.min(o.clientY + 14, innerHeight - H - 8)}px`; };
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  function tipFor(el) {
    const d = el.data();
    if (d.kind === 'folder') {
      const where = d.folder ? cleanName(view.data?.nodes.find((n) => n.id === d.folder)?.label ?? '') : 'Cross-cutting';
      return `<div class="muted">Observed reality · ${esc(where)}</div><div>${d.total ? `${d.total} — ${esc(d.summary)}` : 'No result or verification recorded yet'}</div><div class="faint">Click to open the same place in List</div>`;
    }
    if (d.kind === 'group' || d.kind === 'genhead') {
      const noted = d.marks ? [d.marks.attention ? `<div class="muted">❓ ${d.marks.attention} ${d.marks.attention === 1 ? 'note needs' : 'notes need'} you inside</div>` : '', d.marks.quiet ? `<div class="faint">❓ ${d.marks.quiet} other ${d.marks.quiet === 1 ? 'note' : 'notes'} inside</div>` : ''].join('') : '';
      return `<div>${esc(d.tip ?? d.rawLabel)}${d.count != null ? ` (${d.count})` : ''}</div>${noted}${d.why ? `<div class="faint">${esc(d.why)}</div>` : ''}${d.fold ? `<div class="faint">${d.open ? 'Click to fold it again' : 'Click to open it'}</div>` : ''}`;
    }
    if (d.kind === 'colhead' || d.kind === 'bandhead') return `<div>${esc(d.tip ?? d.rawLabel)}</div>`;
    const n = view.data?.nodes.find((x) => x.id === (d.copyOf ?? el.id()));
    if (!n) return '';
    const bits = [`<div class="muted">${esc(n.category)}${n.progress && isWork(n.category) ? ` · ${esc(n.progress)}` : ''}${n.validity && n.validity !== 'Current' ? ` · ${esc(n.validity)}` : ''}${n.basis === 'Inferred' ? ' · Inferred' : ''}</div>`, `<div>${esc(cleanName(n.label))}</div>`];
    for (const m of marksOf(n, view.starred.has(n.id))) bits.push(`<div class="muted"><span style="color:${m.color}">${m.glyph}</span> ${esc(m === MARKS.flag ? n.marks.map((x) => x.kind).join(', ') : m.legend)}</div>`);
    if (n.category === 'Area' && n.foundation) bits.push(`<div class="muted">${FOUNDATION_LABEL}: the base the modules share, not a module users face</div>`);
    // The second line in full (it is cut to one line on the object), what is open, and that a click opens its steps.
    if (d.line2 && !d.copyOf) bits.push(`<div class="muted">${esc(d.line2)}</div>`);
    if (d.openText) bits.push(`<div class="muted"><span style="color:${palette.danger}">${OPEN_SIGN}</span> ${esc(d.openText)}</div>`);
    if (d.steps) bits.push(`<div class="faint">${d.steps === 'open' ? 'Click to fold its steps' : 'Click to open its steps'}</div>`);
    if (d.where) bits.push(`<div class="faint">${esc(d.where)}</div>`);
    const links = d.links ?? 0;
    if (links && view.links === 'counts') bits.push(`<div class="faint">↗${links}: ${plural(links, 'more relation')} out of its place — drawn while you point at it or select it</div>`);
    return bits.join('');
  }

  cy.on('tap', 'node', (e) => {
    const n = e.target;
    tip.hidden = true;   // what opens beside the object says more than the tip, and the tip would lie on it
    if (n.data('kind') === 'folder') { handlers.onFolder?.(n.data('folder') ?? null); return; }
    // A folded group, a stacked cell, the ring's groups, a rolled generation: opened from their card, and folded again
    // from the same card, open or not (owner, 2026-09-30: what opens has to fold again where it opened).
    if (n.data('fold')) { toggleGroup(n.data('fold')); return; }
    if (n.data('kind') === 'colhead' || n.data('kind') === 'bandhead') return;
    // A send-back ellipse opens the send-back itself; a step stands for its work's details (CKC-24).
    if (n.data('kind') === 'proc-suggest') { handlers.onProcNode?.(n.data('sbId'), n.id()); return; }
    if (n.data('kind') === 'proc-step') { const w = n.data('procOf'); const node = view.data?.nodes.find((x) => x.id === w); handlers.onSelect?.({ kind: 'node', id: w, label: node?.label ?? w, category: node?.category }); return; }
    // A dashed copy selects the work item it stands for (owner, 2026-09-30): the same popover and floating window,
    // standing beside the copy that was clicked.
    if (n.data('copyOf')) { anchorAt = { id: n.data('copyOf'), el: n.id() }; handlers.onSelect?.({ kind: 'node', id: n.data('copyOf'), label: n.data('rawLabel'), category: n.data('category') }); return; }
    anchorAt = null;
    // A tap on a work with a process grows or folds its branch (mockup graph-process-v0); the details open as usual.
    if (procLayer?.expandable?.(n.id())) { procLayer.toggle(n.id()); render(); }
    handlers.onSelect?.({ kind: 'node', id: n.id(), label: n.data('rawLabel'), category: n.data('category') });
  });
  cy.on('tap', 'edge', (e) => {
    const r = e.target;
    if (r.data('part') === 'proc') { if (r.data('sbId')) handlers.onProcNode?.(r.data('sbId'), r.id()); return; }
    if (r.data('synthetic')) return;   // the ring's lines to the columns stand for relations inside the fold
    handlers.onSelect?.({ kind: 'relation', id: r.id(), label: `${r.data('type')}: ${r.data('fromLabel')} → ${r.data('toLabel')}`, at: e.position ? { x: e.position.x, y: e.position.y } : null });
  });
  cy.on('tap', (e) => { if (e.target === cy) handlers.onSelect?.(null); });
  cy.on('dbltap', 'node', (e) => { const n = e.target; if (n.data('fold') || n.data('kind')) return; toggleExpand(n.data('copyOf') ?? n.id()); });
  // Pointing at a copy draws the work item's relations from its own element.
  cy.on('mouseover', 'node', (e) => { hoverId = e.target.data('copyOf') ?? e.target.id(); if (e.target.hasClass('copy')) e.target.addClass('copy-hover'); showTip(e, tipFor(e.target)); lightLinks(); });
  cy.on('mousemove', 'node', (e) => moveTip(e));
  cy.on('mouseout', 'node', (e) => { hoverId = null; tip.hidden = true; e.target.removeClass('copy-hover'); lightLinks(); });
  cy.on('viewport', () => { tip.hidden = true; });
  // Whatever stands beside an object on the page (its details popover) follows it: a pan, a zoom, a new layout.
  const moved = () => handlers.onViewport?.();
  cy.on('viewport resize', moved);
  cy.on('position', 'node', moved);
  // The canvas follows its container as the Keeper conversation is docked, resized and put away (Spec §6.8): `onResize`
  // above watches the container and tells cytoscape, whose `resize` then comes here too.

  function toggleGroup(name) { if (view.expandedGroups.has(name)) view.expandedGroups.delete(name); else view.expandedGroups.add(name); render(); }
  function toggleExpand(id) {
    const node = view.data?.nodes.find((n) => n.id === id);
    if (!node) return;
    // An area opens and folds its requirements, designs and decisions (the card at its column's top does the same).
    if (node.category === 'Area') { const k = `intent:${id}`; if (view.expandedGroups.has(k)) view.expandedGroups.delete(k); else view.expandedGroups.add(k); }
    else { if (view.expandedWork.has(id)) view.expandedWork.delete(id); else view.expandedWork.add(id); }
    render();
  }


  function upstreamOf(id, rel, acc, depth = 0) {
    if (depth > 8 || acc.has(id)) return acc;
    acc.add(id);
    for (const r of rel.filter((x) => x.from === id && (x.type === 'serves' || x.type === 'refines' || x.type === 'implements'))) upstreamOf(r.to, rel, acc, depth + 1);
    return acc;
  }
  function downstreamOf(id, rel, acc, depth = 0) {
    if (depth > 6 || acc.has(id)) return acc;
    acc.add(id);
    for (const r of rel.filter((x) => x.to === id && x.type !== 'affects')) downstreamOf(r.from, rel, acc, depth + 1);
    for (const r of rel.filter((x) => x.from === id && (x.type === 'depends on' || x.type === 'produced' || x.type === 'affects'))) downstreamOf(r.to, rel, acc, depth + 1);
    return acc;
  }

  /**
   * What the story map draws, and where (D100; Spec §6.3 "默认可见"): every object in its place from the placement model
   * (ui/placement.js), or folded into the card of its place — an area's requirements, designs and decisions at the
   * column's top, the ring's groups, a plan's execution decisions, a cell's `Existing foundation` and the rest of a full
   * cell, the cells of what is not placed yet, a rolled earlier generation. What is selected, in focus or matched by a
   * filter is drawn in its place even when its fold is closed. Returns the entries in drawing order (objects and the
   * cards of the folds), which card holds each folded object, and the drawn objects.
   */
  function visibleSet(M) {
    const d = view.data;
    const byId = new Map(d.nodes.map((n) => [n.id, n]));
    const f = view.filters;
    const filterActive = f.category || f.validity || f.progress || f.acceptance || f.assessment || f.withNotes || f.recent || f.attention || f.bpKind || f.sbStage || f.sixThing;
    const matches = (n) => {
      if (f.category && n.category !== f.category) return false;
      if (f.validity && n.validity !== f.validity) return false;
      if (f.progress && n.progress !== f.progress) return false;
      if (f.acceptance && n.acceptance !== f.acceptance) return false;
      if (f.withNotes && !n.noteCount) return false;
      if (f.recent && !view.starred.has(n.id)) return false;
      if (f.attention && !(f.attentionIds ?? []).includes(n.id)) return false;   // CF: the drawer's ❓ count (views.js setAttentionFilter)
      if (f.assessment) { const has = d.relations.some((r) => (r.from === n.id || r.to === n.id) && r.assessment === f.assessment); if (!has) return false; }
      // The process filters (CKC-24 AC-16): a breakpoint kind, a send-back's stage, one of the six things.
      if ((f.bpKind || f.sbStage || f.sixThing) && !(procLayer?.match?.(n, f) ?? true)) return false;
      return true;
    };
    const forced = (n) => n.id === view.selectionId || n.id === view.focusId || Boolean(filterActive && matches(n));
    const drawable = (n) => Boolean(n) && n.validity !== 'Unjudged' && !NOT_DRAWN.has(n.category);
    const shown = new Set(), entries = [], cardOf = new Map();
    const A = M.areas.length;
    // A work item serving several areas is drawn in each (owner, 2026-09-30): its own element in its own cell, and in
    // every other area's cell a dashed copy with an element of its own that stands for it (`copy:<area>:<id>`). A copy
    // is filtered, compared, folded and marked as the work item it stands for.
    const copyOf = new Map();
    const real = (id) => copyOf.get(id) ?? id;
    const copyIn = (area, id) => { const c = `copy:${area}:${id}`; copyOf.set(c, id); return c; };
    const node = (id, slot) => { if (shown.has(id) || !drawable(byId.get(real(id)))) return; shown.add(id); entries.push(copyOf.has(id) ? { id, slot, copyOf: copyOf.get(id) } : { id, slot }); };
    const notesIn = (ids) => {
      const m = { attention: 0, quiet: 0, flagged: 0 };
      for (const id of ids) { const n = byId.get(real(id)); if (!n) continue; m.attention += n.noteAttention ?? 0; m.quiet += Math.max(0, (n.noteCount ?? 0) - (n.noteAttention ?? 0)); if (n.marks?.length) m.flagged++; }
      return m;
    };
    /** A fold: its card (with the count of what it holds and the ❓ inside, lit while folded) and, open, its objects. */
    const fold = (key, ids, slot, label, extra = {}) => {
      const list = ids.filter((id) => drawable(byId.get(real(id))));
      if (!list.length) return;
      const open = view.expandedGroups.has(key);
      const inside = open ? [] : list.filter((id) => !forced(byId.get(real(id))));
      const cardId = extra.id ?? `card:${key}`;
      if (open || inside.length) entries.push({ card: true, id: cardId, key, label, count: open ? list.length : inside.length, open, slot, marks: notesIn(inside), inside, ids: list, ...extra });
      for (const id of inside) cardOf.set(id, cardId);
      for (const id of list) if (!inside.includes(id)) node(id, slot);
    };
    const kinds = (ids) => { const c = {}; for (const id of ids) { const k = byId.get(id)?.category; if (k) c[k] = (c[k] ?? 0) + 1; } return c; };
    const LONG = { Requirement: ['requirement', 'requirements'], Design: ['design', 'designs'], Decision: ['decision', 'decisions'] };
    const SHORT = { Requirement: 'req', Design: 'design', Decision: 'dec' };
    // On a card the counts by kind in short (the card is one line); in its tooltip in full.
    const kindsLabel = (ids) => { const c = kinds(ids); return INTENT_KINDS.filter((k) => c[k]).map((k) => `${c[k]} ${LONG[k][c[k] === 1 ? 0 : 1]}`).join(' · ') || 'nothing'; };
    const kindsShort = (ids) => { const c = kinds(ids); return INTENT_KINDS.filter((k) => c[k]).map((k) => `${SHORT[k]} ${c[k]}`).join(' · ') || '—'; };

    // The owner's words on top, folded with their count (D63).
    const words = d.nodes.filter((n) => isWordsItem(n) && drawable(n) && M.place.get(n.id)?.zone === 'words').sort(byName).map((n) => n.id);
    fold(OWNER_WORDS, words, { zone: 'words' }, OWNER_WORDS, { id: WORDS_GROUP_ID, group: OWNER_WORDS });
    for (const n of d.nodes) { const z = M.place.get(n.id)?.zone; if (z === 'product' || z === 'goal') node(n.id, { zone: z }); }
    M.areas.forEach((a, col) => node(a.id, { zone: 'area', col }));
    entries.push({ special: 'colhead', id: 'colhead:cross', slot: { zone: 'colhead', col: A } });
    // Each column's requirements, designs and decisions, folded at its top.
    M.areas.forEach((a, col) => { const ids = M.intent.get(a.id) ?? []; fold(`intent:${a.id}`, ids, { zone: 'intent', col }, kindsShort(ids), { tip: `${cleanName(a.label)}: its requirements, designs and decisions — ${kindsLabel(ids)}` }); });
    // The cross-cutting ring: several areas; the whole product, with the Keeper's written reason (CM); only on the
    // product; on nothing yet (the last two are not placed, §1.4).
    const ringSlot = { zone: 'ring' };
    fold('ring:multi', M.ring.multi, ringSlot, `several areas · ${kindsShort(M.ring.multi)}`, { tip: `Reaching several areas — ${kindsLabel(M.ring.multi)}; each is drawn to the columns it reaches`, why: 'Placed: each reaches more than one area, drawn to every column it reaches' });
    fold('ring:whole', M.ring.whole, ringSlot, `whole product · ${kindsShort(M.ring.whole)}`, { tip: `${WHOLE_LABEL} — ${kindsLabel(M.ring.whole)}; each concerns the whole product rather than one area or plan`, why: 'Placed: the Keeper wrote why each concerns the whole product; the reason is on each item' });
    fold('ring:product', M.ring.product, ringSlot, `product only · ${kindsShort(M.ring.product)}`, { tip: `Only on the product — ${kindsLabel(M.ring.product)}; not yet placed on an area or a plan`, why: 'Not placed yet: on the product alone, which says nothing about where it acts', unplaced: true });
    fold('ring:none', M.ring.none, ringSlot, `not placed yet · ${kindsShort(M.ring.none)}`, { tip: `On nothing yet — ${kindsLabel(M.ring.none)}; not placed on an area, a plan or the product`, why: 'Not placed yet: the Keeper has not tied it to anything it acts on', unplaced: true });

    // The bands, top to bottom.
    const cellsOf = (bandKey, bi, kind) => {
      for (let col = 0; col <= A; col++) {
        const area = col < A ? M.areas[col].id : null;
        const key = cellKey(bandKey, area);
        const ids = (M.cells.get(key) ?? []).filter((id) => drawable(byId.get(id))).map((id) => (isCopyIn(M, id, area) ? copyIn(area, id) : id));
        if (!ids.length) continue;
        ids.sort((a, b) => { const x = byId.get(real(a)), y = byId.get(real(b)); return (PROGRESS_ORDER[x.progress] ?? 4) - (PROGRESS_ORDER[y.progress] ?? 4) || byName(x, y); });
        const slot = { zone: 'cell', band: bandKey, bi, col, kind };
        // What is not placed yet is counted in the place it would take (Spec §1.4, §6.3): one card per cell. In a plan's
        // cross-cutting cell, work for the whole plan is placed (CN, E152): drawn as in any cell, the card after it.
        const loose = kind === 'none' || !area ? ids.filter((id) => area || !M.place.get(id)?.whole) : [];
        const placed = ids.filter((id) => !loose.includes(id));
        const foundation = placed.filter((id) => byId.get(real(id)).group === 'Existing foundation');
        const rest = placed.filter((id) => !foundation.includes(id));
        for (const id of rest.slice(0, CELL_SHOWN)) node(id, slot);
        if (rest.length > CELL_SHOWN) fold(`more:${key}`, rest.slice(CELL_SHOWN), slot, 'more work here', { tip: 'More work in this cell' });
        if (area) fold(`found:${key}`, foundation, slot, 'Existing foundation', { tip: 'Existing foundation: done, still in force, not in the current focus' });
        else fold(`found:${key}`, foundation, slot, `${WHOLE_PLAN_LABEL.toLowerCase()} · done`, { tip: 'Done work for the whole plan — all of its modules, no single one; each says why on its second line', why: 'Placed: the Keeper wrote why each serves its whole plan; the reason is on each item' });
        if (loose.length) {
          const what = kind === 'none' ? (area ? 'not in a plan yet' : 'no plan, no area yet') : kind === 'gen' ? 'in no current area' : 'no area yet';
          fold(`cell:${key}`, loose, slot, what, { tip: `${loose.length} work item${loose.length === 1 ? '' : 's'} ${what}`, why: kind === 'gen' ? 'Its area is not one of the current areas' : 'Not placed yet: no record read so far says where it belongs', unplaced: kind !== 'gen' });
        }
      }
    };
    M.bands.forEach((b, bi) => {
      if (b.kind === 'gen') {
        const g = b.gen;
        const key = `gen:${g.id}`;
        const open = view.expandedGroups.has(key);
        const head = { zone: 'head', band: g.id, bi, kind: 'gen' };
        // Each item once, however many areas it stands in (its copies open with the band).
        const all = [...new Set([...g.planIds, ...g.execIds, ...[...M.cells].filter(([k]) => k.startsWith(`${g.id}|`)).flatMap(([, ids]) => ids)])].filter((id) => drawable(byId.get(id)));
        const inside = open ? [] : all.filter((id) => !forced(byId.get(id)));
        for (const id of inside) cardOf.set(id, `genhead:${g.id}`);
        // A generation the organizing recorded nothing in says `Not organized` and has nothing to open (owner, 2026-09-30).
        entries.push({ special: 'genhead', id: `genhead:${g.id}`, fold: all.length ? key : null, open: open && all.length > 0, gen: g, slot: { zone: 'genhead', band: g.id, bi, kind: 'gen' }, marks: notesIn(inside), count: all.length });
        if (open) {
          for (const id of g.planIds) node(id, head);
          fold(`exec:${g.id}`, g.execIds, head, `execution decisions · ${g.execIds.length}`, { tip: 'This generation’s execution decisions' });
          cellsOf(g.id, bi, 'gen');
        } else {
          for (const id of all) if (!inside.includes(id)) { const p = M.place.get(id); node(id, p?.zone === 'gen' ? { zone: 'cell', band: g.id, bi, col: p.area ? M.areas.findIndex((a) => a.id === p.area) : A, kind: 'gen' } : head); }
        }
      } else if (b.kind === 'plan') {
        const head = { zone: 'head', band: b.key, bi, kind: 'plan' };
        node(b.key, head);
        const ex = M.exec.get(b.key) ?? [];
        fold(`exec:${b.key}`, ex, head, `execution decisions · ${ex.length}`, { tip: `The decisions that record how ${cleanName(b.plan.label)} was carried out` });
        cellsOf(b.key, bi, 'plan');
      } else {
        entries.push({ special: 'bandhead', id: 'bandhead:none', slot: { zone: 'head', band: NO_PLAN, bi, kind: 'none' } });
        cellsOf(NO_PLAN, bi, 'none');
      }
    });
    // A work's results, reviews and tests stand under it when it is opened (or in focus, or one of them is selected).
    for (const n of d.nodes) {
      if (!FOLDABLE.has(n.category) || !n.parentId || !shown.has(n.parentId)) continue;
      if (!view.expandedWork.has(n.parentId) && n.id !== view.selectionId && view.focusId !== n.parentId) continue;
      const at = entries.find((e) => e.id === n.parentId);
      node(n.id, { ...at.slot, after: n.parentId, indent: 10 });
    }

    const keepAlways = (id) => { const c = byId.get(id)?.category; return c === 'Area' || c === 'Plan'; };
    // A copy goes or stays with the work item it stands for.
    const drop = (keep) => { for (const id of [...shown]) if (!keep.has(real(id)) && !keepAlways(real(id))) shown.delete(id); };
    const cmp = view.scale === 'Compare' ? view.compare : null;
    if (cmp && cmp.side === 'Delta' && (cmp.items?.length ?? 0) > 0 && !cmp.all) {
      const diff = new Set(cmp.items.map((i) => i.id));
      const keep = new Set(diff);
      for (const id of diff) { const n = byId.get(id); if (n?.areaId) keep.add(n.areaId); if (n?.parentId) keep.add(n.parentId); }
      drop(keep);
    }
    if (filterActive) {
      const keep = new Set();
      for (const id of shown) { const n = byId.get(real(id)); if (n && matches(n)) upstreamOf(real(id), d.relations, keep); }
      if (view.selectionId) keep.add(view.selectionId);
      drop(keep);
    }
    // Results of works no longer drawn go with them.
    for (const id of [...shown]) { const n = byId.get(id); if (n && FOLDABLE.has(n.category) && n.parentId && !shown.has(n.parentId) && id !== view.selectionId) shown.delete(id); }
    // Under a filter a fold holds only what the filter leaves out (what matches is drawn in its place), so its card goes
    // too: the picture shows what matched, in its places, and the bands and columns it stands in.
    const cards = (e) => e.card && (!filterActive || (e.open && e.ids.some((id) => shown.has(id))));
    if (filterActive) for (const [id, card] of [...cardOf]) if (!entries.some((e) => e.id === card && e.special)) cardOf.delete(id);
    return { entries: entries.filter((e) => cards(e) || e.special || shown.has(e.id)), shown, cardOf, byId, copyOf };
  }

  function nodeClasses(n) {
    const key = colourKey(n.category);
    const cls = [key === 'intent' ? 'col-intent' : key === 'reality' ? 'col-reality' : 'col-work'];
    if (n.basis === 'Inferred') cls.push('inferred');
    if (n.validity === 'Replaced' || n.validity === 'Abandoned') cls.push('replaced');
    return cls.join(' ');
  }
  function edgeClasses(r, part) {
    const cls = [part];
    if (part === 'other' && view.links === 'lines') cls.push('all-links');
    if (r.basis === 'Inferred') cls.push('inferred');
    if (r.assessment === 'Questioned') cls.push('questioned');
    if (r.noteCount) cls.push('noted');
    if (r.noteAttention) cls.push('ask');
    return cls.join(' ');
  }

  function computeStars() {
    const r = starredIds(view.data.nodes, view.starMode, view.lastVisit);
    view.starred = r.ids;
    view.starNote = r.note;
    handlers.onStars?.(r);
  }

  /**
   * Where an object stands, in words, for its tooltip: its plan (or generation) and its area; for a work item serving
   * several areas, where its main one is and why (the owner's rule), and where its copies are. `at`: the area of the
   * copy the tooltip is for.
   */
  function whereOf(M, id, at = null) {
    const p = M.place.get(id);
    // On the whole product (CM; Spec §1.4 "写明为什么"): the Keeper's written reason.
    if (p?.zone === 'ring' && p.ring === 'whole') return `${WHOLE_LABEL}: ${p.why}`;
    if (!p || (p.zone !== 'cell' && p.zone !== 'gen')) return '';
    const name = (x) => cleanName(M.byId.get(x)?.label ?? x);
    const band = p.gen ? `earlier generation ${M.generations.find((g) => g.id === p.gen)?.name ?? ''}` : p.band === NO_PLAN ? 'not in a plan yet' : name(p.band);
    const also = M.also.get(id);
    const plans = also?.plans?.length ? ` · also listed in ${also.plans.map(name).join(', ')}` : '';
    const mark = sharedMark(M, id, at ?? p.area);
    // For the whole plan (CN; Spec §1.4 "写明为什么"): the Keeper's written reason.
    if (p.whole) return `${WHOLE_PLAN_LABEL} — in ${band}, for all of its modules and no single one: ${p.whole}${plans}`;
    if (!mark) return `In ${band} × ${p.area ? name(p.area) : 'no area yet'}${plans}`;
    const why = MAIN_BY[mark.by] ? ` (${MAIN_BY[mark.by]})` : '';
    if (mark.copy) return `Also serves ${name(at)}: a copy. Its main one is in ${band} × ${name(mark.main)}${why}; select it there for its relations${plans}`;
    return `In ${band} × ${name(p.area)} — its main one${why}; also serves ${mark.others.map(name).join(', ')}, drawn there dashed${plans}`;
  }

  function render(opts = {}) {
    const d = view.data;
    if (!d) return;
    computeStars();
    const M = placementOf(d, { showReplaced: view.showReplaced });
    const { entries, shown, cardOf, byId, copyOf } = visibleSet(M);
    const A = M.areas.length;
    const W = storyWidth(A);
    // Which relations are drawn how, and the link count beside each object (D54).
    const rels = d.relations.filter((r) => shown.has(r.from) && shown.has(r.to));
    const part = new Map(rels.map((r) => [r.id, relationPart(r, byId.get(r.from), byId.get(r.to), M)]));
    const links = new Map();
    for (const r of rels) if (part.get(r.id) === 'other') for (const id of [r.from, r.to]) links.set(id, (links.get(id) ?? 0) + 1);
    // The ring's folded group of objects reaching several areas: one line from its card to each area it reaches, with
    // how many reach it — the relations themselves are inside the fold (D54, D100: "跨模块 … 到它落到的各列画关系线").
    const synthetic = [];
    for (const e of entries) {
      if (!e.card || e.key !== 'ring:multi' || e.open) continue;
      const per = new Map();
      for (const id of e.inside) for (const a of M.place.get(id)?.areas ?? []) per.set(a, (per.get(a) ?? 0) + 1);
      for (const [a, k] of per) if (shown.has(a)) {
        synthetic.push({ data: { id: `ringlink:${a}`, source: e.id, target: a, type: 'refines', part: 'other', synthetic: true, elabel: `${k} reach${k === 1 ? 'es' : ''} ${cleanName(byId.get(a)?.label ?? '')}`, mark: '', fromLabel: e.label, toLabel: byId.get(a)?.label }, classes: `other agg${view.links === 'lines' ? ' all-links' : ''}` });
        for (const id of [e.id, a]) links.set(id, (links.get(id) ?? 0) + 1);
      }
    }
    const cells = observedCells(d, view.showReplaced, M);
    const elements = [];
    const slotById = new Map(entries.map((e) => [e.id, e.slot]));
    // The process layer (CKC-24): nothing when the endpoint is not built yet, so the picture is exactly as before.
    // `cards` says which card holds each folded object this pass, so a lit item on a folded-away object hangs on its card.
    const procBits = procLayer?.elements?.({ view, shown, byId, cards: cardOf }) ?? null;
    const procAlerts = procLayer?.alertIds?.({ shown, byId, cards: cardOf }) ?? null;
    // The pictures of an object: its words over everything; a theme's material, when there is one, under the border.
    const withImage = (data, over, material = null) => {
      const pics = material ? [over, material] : [over];
      return { ...data, imgs: pics.map((q) => q.uri), imgWs: pics.map((q) => q.w), imgHs: pics.map((q) => q.h), imgOxs: pics.map((q) => q.ox), imgOys: pics.map((q) => q.oy) };
    };
    const fmtDay = (o) => (o?.at ? String(o.at).slice(0, 10) : '');
    for (const e of entries) {
      if (e.card) {
        const [w, h] = SIZE.group;
        const words = e.key === OWNER_WORDS;
        const label = e.open ? `${e.label} · click to fold` : e.label;
        const chip = links.get(e.id) ?? 0;
        elements.push({ data: withImage({ id: e.id, rawLabel: e.label, tip: e.tip ?? e.label, why: e.why ?? null, kind: 'group', category: 'group', fold: e.key, group: words ? OWNER_WORDS : null, open: e.open, count: e.count, marks: e.marks, slot: e.slot, areaId: null, color: palette.groupBorder, w, h, overTop: foldMarks(e.marks).length ? OVER.top : 0, overRight: chip ? OVER.right : 0 }, groupImage(label, e.count, w, h, e.open, e.open ? null : e.marks, view.links === 'counts' ? chip : 0)), classes: 'group' });
        continue;
      }
      if (e.special === 'genhead') {
        const g = e.gen, w = W - 2 * EDGE, h = SIZE.genhead[1];
        const caret = e.fold ? `${e.open ? '▾' : '▸'} ` : '';
        const lines = [[`${caret}EARLIER GENERATION · ${g.name}`, 'kind'], [`${destinationLine(g.destinations)}${g.ended ? ` · ended ${fmtDay(g.ended)}` : ''}${g.endedBy?.label ? ` by ${g.endedBy.label}` : ''}`, 'muted']];
        const tip = `Earlier generation · ${g.name}: ${g.organized ? destinationLine(g.destinations) : `${destinationLine(g.destinations)} — the organizing has not recorded its items or where each went`}${g.endedBy?.line ? ` — ended by ${g.endedBy.line}` : ''}`;
        elements.push({ data: withImage({ id: e.id, rawLabel: g.name, tip, kind: 'genhead', category: 'genhead', fold: e.fold, open: e.open, count: e.fold ? e.count : null, marks: e.marks, slot: e.slot, areaId: null, color: palette.groupBorder, w, h, overTop: foldMarks(e.marks).length ? OVER.top : 0 }, cardImage(lines, w, h, { marks: e.open ? null : e.marks })), classes: 'card' });
        continue;
      }
      if (e.special === 'bandhead') {
        const [w, h] = SIZE.item, u = M.unplaced;
        const lines = [['NOT IN A PLAN', 'kind'], [`${u.workNoPlan} work item${u.workNoPlan === 1 ? '' : 's'} not placed yet`, 'muted'], [u.workNeither ? `${u.workNeither} with no area either` : 'counted by area below', 'faint']];
        elements.push({ data: withImage({ id: e.id, rawLabel: 'Not in a plan', tip: `Not in a plan: ${u.workNoPlan} work items no record read so far places in a plan, counted in the column of their area`, kind: 'bandhead', category: 'bandhead', slot: e.slot, areaId: null, color: palette.groupBorder, w, h }, cardImage(lines, w, h)), classes: 'card' });
        continue;
      }
      if (e.special === 'colhead') {
        const [w, h] = SIZE.heading;
        const lines = [['CROSS-CUTTING', 'kind'], ['no one area — not one-to-one', 'muted'], ['with the columns', 'muted']];
        elements.push({ data: withImage({ id: e.id, rawLabel: 'Cross-cutting', tip: 'Cross-cutting: what serves no one area, or is not placed on an area yet. It does not map one-to-one to the columns.', kind: 'colhead', category: 'colhead', slot: e.slot, areaId: null, color: palette.intent, w, h }, cardImage(lines, w, h, { border: palette.intent })), classes: 'card' });
        continue;
      }
      const n = byId.get(e.copyOf ?? e.id);
      const [w, h] = sizeOf(n);
      // A copy carries no link count: its relations are drawn from the work item's own element (owner, 2026-09-30).
      const chip = view.links === 'counts' && !e.copyOf ? links.get(n.id) ?? 0 : 0;
      // A copy says where its main one is; a work of an earlier generation where it went (Spec §2.12, D100); any other
      // folded work its four things.
      const copyArea = e.copyOf ? (e.slot.col < A ? M.areas[e.slot.col].id : null) : null;
      const shared = e.copyOf ? sharedMark(M, n.id, copyArea) : null;
      const dest = M.destinationOf.get(n.id);
      // A cross-cutting foundation's column head keeps the project's name and says what it is on its second line (D101).
      // Work for its whole plan says so on its second line; the reason is in its tooltip (CN).
      const whole = M.place.get(n.id)?.whole ?? null;
      const procLine = shared ? shared.text : dest ? destinationText(dest) : n.category === 'Area' && n.foundation ? FOUNDATION_LABEL : whole ? `${WHOLE_PLAN_LABEL} · ${whole}` : procLayer?.foldLineOf?.(n.id) ?? null;
      // What is open on a work stays on it, folded or not (D75): a count on its top edge. A copy leaves it to the main one.
      const openMark = e.copyOf ? null : procLayer?.openMarkOf?.(n.id) ?? null;
      const img = objectImage(n, w, h, { starred: view.starred.has(n.id), areaWork: M.areaWork.get(n.id), links: chip, procLine, open: openMark });
      // What stands out of the object — corner marks above it, a link count to its right — so fitting the picture takes it in.
      const over = { overTop: marksOf(n, view.starred.has(n.id)).length || n.basis === 'Inferred' || openMark ? OVER.top : 0, overRight: chip ? OVER.right : 0 };
      const colour = COLUMN_COLOR[colourKey(n.category)];
      let cls = nodeClasses(n);
      if (procAlerts?.has(n.id)) cls += ' proc-alert';
      if (e.copyOf) cls += ' copy';
      const where = e.copyOf ? whereOf(M, n.id, copyArea) : whereOf(M, n.id);
      elements.push({ data: withImage({ id: e.id, rawLabel: n.label, category: n.category, areaId: e.copyOf ? copyArea : M.place.get(n.id)?.area ?? n.areaId ?? null, parentId: n.parentId ?? null, progress: n.progress ?? null, color: colour, links: e.copyOf ? 0 : links.get(n.id) ?? 0, where, slot: e.slot, w, h, ...(e.copyOf ? { copyOf: n.id } : {}), ...(procLine ? { line2: procLine } : {}), ...(openMark ? { openText: openMark.text } : {}), ...(!e.copyOf && procLayer?.expandable?.(n.id) ? { steps: procLayer.isOpen?.(n.id) ? 'open' : 'folded' } : {}), ...over }, img, materialPicture(shapeOf(n.category), w, h, colour)), classes: cls });
    }
    if (view.scale !== 'Compare') {
      for (const [key, cell] of cells) {
        if (key !== null && !shown.has(key)) continue;
        const [w, h] = SIZE.folder;
        const col = key === null ? A : M.areas.findIndex((a) => a.id === key);
        elements.push({ data: withImage({ id: `folder:${key ?? 'project-wide'}`, kind: 'folder', category: 'folder', folder: key, areaId: key, total: cell.total, summary: cellSummary(cell), rawLabel: 'Observed reality', slot: { zone: 'folder', col }, color: COLUMN_COLOR.reality, w, h }, folderImage(cell, w, h)), classes: 'folder' });
      }
    }
    // The branches of the process view: step nodes and send-back arrows of the works that are open (CKC-24). A step
    // stands under its work, in the work's own place; so does a send-back on a card, under the card.
    const procNodes = [], procEdges = [];
    if (procBits) for (const el of procBits.elements) {
      if (el.data.source) { procEdges.push(el); continue; }
      const at = slotById.get(el.data.procOf);
      if (!at) continue;
      procNodes.push({ ...el, data: { ...el.data, slot: { ...at, after: el.data.procOf, indent: el.data.kind === 'proc-suggest' ? 16 : 8 } } });
    }
    elements.push(...procNodes);
    const L = storyLayout(elements.map((x) => x.data));
    // The bands and the ring, as the layout measured them: backgrounds under what they hold.
    if (L) {
      for (const b of L.bands) elements.push({ data: { id: `band:${b.key}`, kind: 'band', category: 'band', rawLabel: '', w: b.w, h: b.h, imgs: [EMPTY_PIC.uri], imgWs: [1], imgHs: [1], imgOxs: [0], imgOys: [0] }, classes: `band ${b.key === NO_PLAN ? 'none' : M.bandOrder.has(b.key) && M.bands[M.bandOrder.get(b.key)].kind === 'plan' ? 'plan' : 'gen'}` });
      if (L.ring) { const t = titlePicture('CROSS-CUTTING · across the areas, not one-to-one with the columns above', palette.intent); elements.push({ data: { id: 'ring:cross', kind: 'ring', category: 'ring', rawLabel: '', w: L.ring.w, h: L.ring.h, imgs: [t.uri], imgWs: [t.w], imgHs: [t.h], imgOxs: [0], imgOys: [0] }, classes: 'ring' }); }
    }
    const nodeIds = new Set(elements.map((x) => x.data.id));
    for (const r of rels) {
      const p = part.get(r.id);
      const assessment = r.assessment || 'Not assessed';
      elements.push({ data: { id: r.id, source: r.from, target: r.to, type: r.type, part: p, elabel: `${r.type} · ${assessment}${r.noteCount ? ' ❓' : ''}`, mark: r.noteCount ? '❓' : '', fromLabel: byId.get(r.from)?.label, toLabel: byId.get(r.to)?.label, claim: r.claim }, classes: edgeClasses(r, p) });
    }
    elements.push(...synthetic);
    for (const el of procEdges) if (nodeIds.has(el.data.source) && nodeIds.has(el.data.target)) elements.push(el);
    const key = elements.map((e) => e.data.id).sort().join('|');
    const zoom = cy.zoom(); const pan = { ...cy.pan() };
    // The graph is updated by difference, not rebuilt. Removing every element and adding it back on each poll made
    // the whole picture blink while the Keeper was working (owner, 2026-09-17: "网页还是在一闪一闪的"), because every
    // node's picture was drawn again even when nothing about it had changed.
    const desired = new Map(elements.map((e) => [e.data.id, e]));
    const signature = (e) => `${JSON.stringify(e.data)}|${e.classes ?? ''}`;
    let dataChanged = false;
    cy.batch(() => {
      const gone = cy.elements().filter((el) => !desired.has(el.id()));
      if (gone.length > 0) { gone.remove(); dataChanged = true; }
      const added = [];
      for (const [id, e] of desired) {
        const el = cy.getElementById(id);
        const sig = signature(e);
        if (el.empty()) { added.push(e); continue; }
        if (el.scratch('_sig') === sig) continue;
        dataChanged = true;
        el.data(e.data);
        el.classes(e.classes ?? '');
        el.scratch('_sig', sig);
      }
      // A drag that starts on an object moves the picture, like a drag on the background (cytoscape: `pannable`). At the
      // zoom floor a large project is mostly objects, and dragging is how the rest of it is reached (CKC-09 AC-39);
      // places are worked out, not arranged by hand (Spec §6.3), so an object is not something to drag about.
      if (added.length > 0) { dataChanged = true; cy.add(added).forEach((el) => el.scratch('_sig', signature(desired.get(el.id())))).panify(); }
    });
    const emphKey = emphasisKey();
    if (!dataChanged && key === lastKey && !opts.refit && !opts.relayout) {
      if (emphKey !== lastEmph) { applyEmphasis(); lastEmph = emphKey; }
      return;
    }
    // Places are worked out from the model every time (Spec §6.3 "布局"): the same data gives the same picture, so an
    // update that changes nothing about an object's place leaves it where it was.
    if (L) {
      cy.batch(() => cy.nodes().forEach((n) => {
        const id = n.id();
        if (id.startsWith('band:')) { const b = L.bands.find((x) => `band:${x.key}` === id); if (b) n.position({ x: b.x + b.w / 2, y: b.y + b.h / 2 }); return; }
        if (id === 'ring:cross') { n.position({ x: L.ring.x + L.ring.w / 2, y: L.ring.y + L.ring.h / 2 }); return; }
        const b = L.box.get(id);
        if (b) n.position({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
      }));
      layoutInfo = L;
    } else if (key !== lastKey) {
      const layout = cy.layout({ name: 'dagre', rankDir: 'BT', nodeSep: 28, rankSep: 56, edgeSep: 12, padding: 30, animate: false, fit: false, ranker: 'network-simplex', edgeWeight: (e) => (e.data('type') === 'serves' || e.data('type') === 'refines' ? 3 : 1) });
      layout.run();
      layoutInfo = null;
    }
    if (firstLayout) fitReadable();
    else { cy.zoom(zoom); cy.pan(pan); }   // a re-layout never moves the owner's viewport under them
    lastKey = key;
    firstLayout = false;
    setZoomLimit();   // the picture may have grown or shrunk
    routeEdges();
    if (opts.refit && cy.nodes().length) fitReadable();
    applyEmphasis();
    lastEmph = emphKey;
    checkReadability();
    handlers.onLegend?.(legendItems());
  }


  /**
   * Right-angled routes (D54): structure lines leave upwards to a shared bus and rise into their target; a project-wide
   * plan's line to the product runs up the right-hand margin, above the goals; an inferred own-area line runs up the
   * gap on the column's left to its area. Cytoscape draws them as segments through these points.
   */
  function routeEdges() {
    const L = layoutInfo;
    const ROUTE = 'curve-style edge-distances segment-weights segment-distances segment-radius';
    cy.batch(() => cy.edges().forEach((e) => {
      const p = e.data('part');
      const s = e.source().position(), t = e.target().position(), th = e.target().data('h');
      let pts = null;
      if (L && p === 'structure') {
        const bus = t.y + th / 2 + LAYOUT.bus;
        if (e.source().data('category') === 'Plan') {
          // A project-wide plan's line runs up the right-hand margin, so it never crosses the goals row (D54).
          const x = L.width - 10;
          pts = e.target().data('category') === 'Product' ? [{ x, y: s.y }, { x, y: t.y }] : [{ x, y: s.y }, { x, y: bus }, { x: t.x, y: bus }];
        } else pts = [{ x: s.x, y: bus }, { x: t.x, y: bus }];
      } else if (L && p === 'own') {
        const ci = L.keys.indexOf(e.target().id());
        if (ci >= 0) { const x = L.colX[ci] - 7; pts = [{ x, y: s.y }, { x, y: t.y + th / 4 }]; }
      }
      const key = pts ? pts.map((q) => `${Math.round(q.x)},${Math.round(q.y)}`).join(' ') : '';
      if (e.scratch('_route') === key) return;
      e.scratch('_route', key);
      if (!pts) { e.removeStyle(ROUTE); return; }
      // cytoscape places segment points by weight along the line between the two centres and by distance across it.
      const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const weights = pts.map((q) => (((q.x - s.x) * ux + (q.y - s.y) * uy) / len).toFixed(4)).join(' ');
      const distances = pts.map((q) => ((q.x - s.x) * -uy + (q.y - s.y) * ux).toFixed(2)).join(' ');
      e.style({ 'curve-style': 'round-segments', 'edge-distances': 'node-position', 'segment-weights': weights, 'segment-distances': distances, 'segment-radius': 6 });
    }));
  }

  function checkReadability() {
    if (!handlers.onReadability) return;
    const nodes = pictureNodes();
    // Only lines that are drawn right now, along the path they are drawn on (D46: the check reads the picture as shown).
    const edges = cy.edges().filter((e) => e.visible()).map((e) => {
      const pts = [e.sourceEndpoint(), ...(e.segmentPoints() ?? e.controlPoints() ?? []), e.targetEndpoint()].filter(Boolean).map((q) => ({ x: q.x, y: q.y }));
      return { id: e.id(), source: e.data('source'), target: e.data('target'), points: pts };
    });
    // Judged for the window the viewport is fitted to; a window with no size yet is judged once it has one (onResize).
    const size = windowSize();
    if (size.w < 2 || size.h < 2) return;
    handlers.onReadability(readabilityReport(nodes, edges, size, fitOpts()));
  }

  /** The legend lists only what the picture shows right now, with counts (D53). */
  function legendItems() {
    const nodes = cy.nodes();
    const count = (sel) => nodes.filter(sel).length;
    const items = [];
    const intent = count((n) => colourKey(n.data('category')) === 'intent' && !n.data('kind') && CATEGORY_COLUMN[n.data('category')]);
    const plans = count((n) => n.data('category') === 'Plan');
    const works = count((n) => n.data('category') === 'Work item' && !n.hasClass('copy'));   // each once; its copies below
    const results = count((n) => FOLDABLE.has(n.data('category')));
    const folderTotal = nodes.filter((n) => n.data('kind') === 'folder').reduce((s, n) => s + (n.data('total') ?? 0), 0);
    if (intent) items.push({ icon: 'doc', color: COLUMN_COLOR.intent, label: 'Product intent', count: intent, desc: 'the owner\'s words, product, goals, areas, requirements, designs, decisions; the kind is written on each' });
    if (plans) items.push({ icon: 'hex', color: COLUMN_COLOR.plan, label: 'Plan', count: plans, desc: 'plans and milestones' });
    if (works) items.push({ icon: 'hex', color: COLUMN_COLOR.work, label: 'Work item', count: works, desc: 'tasks, contracts, issues and other work' });
    if (folderTotal || nodes.some((n) => n.data('kind') === 'folder')) items.push({ icon: 'folder', color: COLUMN_COLOR.reality, label: 'Observed reality', count: folderTotal, desc: 'results, reviews and tests of each column\'s work; click a folder to open the same cell in List' });
    if (results) items.push({ icon: 'ellipse', color: COLUMN_COLOR.reality, label: 'Result, review or test', count: results, desc: 'drawn one by one when a work item is opened' });
    items.push({ sep: true });
    const drawn = cy.edges().filter((e) => e.visible());
    const structure = drawn.filter((e) => e.data('part') === 'structure').length;
    if (structure) items.push({ icon: 'line', label: 'structure', count: structure, desc: 'goal → product, area → goal, project-wide plan → product; work stands in its area\'s column instead of one line each' });
    const others = cy.edges().filter((e) => e.data('part') === 'other').length;
    if (others) items.push(view.links === 'counts' ? { icon: 'count', label: 'other links', count: others, desc: 'between areas, or between work items: a count beside each end; point at or select an object to draw its links, or switch to draw them all' } : { icon: 'line', label: 'other links', count: others, desc: 'between areas, or between work items' });
    const inferredLines = drawn.filter((e) => e.hasClass('inferred')).length, inferredObjects = count((n) => n.hasClass('inferred'));
    if (inferredLines) items.push({ icon: 'dotted', label: 'Inferred relation', count: inferredLines, desc: 'the Keeper\'s own inference, not stated in the material: a dotted line; a work item placed in its area by inference is tied to it by a dotted line' });
    if (inferredObjects) items.push({ icon: 'inferred', label: 'Inferred object', count: inferredObjects, desc: 'the Keeper\'s own inference, not stated in the material: the word Inferred on the object\'s top edge; its frame stays solid' });
    // A work item serving several modules stands in each (owner, 2026-09-30): solid in its main one, dashed in the others.
    const copies = count((n) => n.hasClass('copy'));
    if (copies) items.push({ icon: 'dashed', color: COLUMN_COLOR.work, label: 'also serves this module', count: copies, desc: 'a pale card with a dashed frame: the work item also serves this module and its main one (solid, full strength) is in another — the module of the contract it implements, else the one its ticket or prompt names; it says where on its second line, and its relations are drawn from the main one' });
    const steps = count((n) => n.data('kind') === 'proc-step');
    if (steps) items.push({ icon: 'hex', color: COLUMN_COLOR.work, label: 'Process step', count: steps, desc: 'one step of a work’s process, grown by clicking the work; every work starts folded, with the count of its steps and of what is open on it' });
    const sug = count((n) => n.data('kind') === 'proc-suggest');
    if (sug) items.push({ icon: 'ellipse', color: palette.danger, label: 'Send-back still open', count: sug, desc: 'a send-back not yet closed — Suggested or Returned — pointing back to work or plan; click it for the text and Copy for agent' });
    const procEdges = drawn.filter((e) => e.data('part') === 'proc').length;
    if (procEdges) items.push({ icon: 'line', label: 'process', count: procEdges, desc: 'the chain of a work’s steps; a dashed red line is a send-back going back, a dotted one points at another area’s work' });
    const questioned = drawn.filter((e) => e.hasClass('questioned')).length;
    if (questioned) items.push({ icon: 'questioned', label: 'Questioned', count: questioned, desc: 'the Keeper questions this relation; always drawn' });
    const groups = count((n) => (n.data('kind') === 'group' || n.data('kind') === 'genhead') && n.data('fold') && !n.data('open'));
    if (groups) items.push({ icon: 'stack', label: 'folded', count: groups, desc: 'a group, a full cell or an earlier generation, shown as a stack with its count; click to open it' });
    // The story map's own drawings (D100): the plans' bands and the cross-cutting ring.
    const bands = count((n) => n.hasClass('band'));
    if (bands) items.push({ icon: 'band', color: COLUMN_COLOR.plan, label: 'band', count: bands, desc: 'a plan across the columns, its head on the left; above them the earlier generations, below them what is in no plan yet' });
    if (count((n) => n.hasClass('ring'))) items.push({ icon: 'ring', color: COLUMN_COLOR.intent, label: 'cross-cutting', count: 0, desc: 'what reaches several areas or none: it does not map one-to-one to the columns above; the rightmost column holds each band’s work with no area' });
    const byMark = new Map();
    for (const n of view.data.nodes) {
      if (!cy.getElementById(n.id).length) continue;
      for (const m of marksOf(n, view.starred.has(n.id))) byMark.set(m, (byMark.get(m) ?? 0) + 1);
    }
    if (byMark.size) items.push({ sep: true });
    for (const m of [MARKS.star, MARKS.flag, MARKS.ask, MARKS.note, MARKS.pending]) if (byMark.get(m)) items.push({ icon: 'mark', mark: m, label: m.legend, count: byMark.get(m), desc: m.desc });
    return items;
  }

  // Draw an object's relations while it is pointed at or selected (D54), with their type and assessment on the line.
  function lightLinks() {
    cy.batch(() => {
      cy.edges('.lit').removeClass('lit');
      for (const id of [view.selectionId, hoverId]) {
        if (!id) continue;
        const el = cy.getElementById(id);
        if (el.length && el.isNode()) el.connectedEdges().addClass('lit');
      }
    });
  }

  // The whole picture in the window, never so small that its names stop being readable and never magnified. When it
  // does not fit at the floor it starts at its top left — the top levels over the first column — and the owner drags
  // to the rest (graph-fit.js fitView). This is the graph's own view: it is worked out again when the window changes.
  function fitReadable() {
    auto = true;
    chosen = null;
    const size = windowSize();
    const v = size.w < 2 || size.h < 2 ? null : openingView(pictureNodes(), size, fitOpts());
    if (!v) return;   // nothing to show, or no window yet: fitted when there is one (onResize)
    cy.stop();
    cy.viewport({ zoom: v.zoom, pan: v.pan });
    chosen = { zoom: cy.zoom(), pan: { ...cy.pan() } };
    seen = size;
  }

  /** A work item's dashed copies in the other areas it serves. */
  const copiesOf = (id) => cy.nodes('.copy').filter((n) => n.data('copyOf') === id);
  function applyEmphasis() {
    cy.elements().removeClass('faded related hit focus near diff-added diff-removed diff-changed copy-sel');
    for (const id of pinned) { const el = cy.getElementById(id); if (el.length) el.addClass('hit'); copiesOf(id).addClass('hit'); }
    const sel = view.selectionId ? cy.getElementById(view.selectionId) : null;
    if (sel && sel.length) {
      if (!sel.selected()) { cy.elements().unselect(); sel.select(); }
    } else if (cy.$(':selected').length) {
      cy.elements().unselect();
    }
    // Selecting a copy selects the work item; its copies say so too.
    if (view.selectionId) copiesOf(view.selectionId).addClass('copy-sel');
    lightLinks();
    const cmp2 = view.scale === 'Compare' ? view.compare : null;
    if (cmp2 && (cmp2.items?.length ?? 0) > 0) {
      const here = cmp2.items[cmp2.index ?? 0];
      const byKind = new Map(cmp2.items.map((i) => [i.id, i.kind]));
      cy.nodes().not('.band, .ring').forEach((n) => {
        const kind = byKind.get(n.data('copyOf') ?? n.id());
        if (!kind) { n.addClass('near'); return; }
        n.addClass(kind === 'Added' ? 'diff-added' : kind === 'Removed' ? 'diff-removed' : 'diff-changed');
      });
      if (here) cy.getElementById(here.id).addClass('focus');
      return;
    }
    if (view.scale === 'Work' && view.focusId) {
      const rel = view.data.relations;
      const keep = new Set([...upstreamOf(view.focusId, rel, new Set()), ...downstreamOf(view.focusId, rel, new Set())]);
      // The steps of a kept work's open branch are part of what the owner is reading (CKC-24).
      cy.nodes().forEach((n) => { const p = n.data('procOf'); if (p && keep.has(p)) keep.add(n.id()); });
      cy.nodes().not('.band, .ring').forEach((n) => { const id = n.data('copyOf') ?? n.id(); if (!keep.has(id)) n.addClass('faded'); else if (id !== view.focusId) n.addClass('near'); });
      cy.getElementById(view.focusId).addClass('focus');
      cy.edges().forEach((e) => { if (!keep.has(e.source().id()) || !keep.has(e.target().id())) e.addClass('faded'); else e.addClass('related'); });
    }
  }

  /**
   * Open the folds that hide a node, from its place on the story map: the owner's words, its column's requirements,
   * designs and decisions, the ring's group, its plan's execution decisions, its cell's stacks, its rolled generation;
   * a result's work item (and that work's folds).
   */
  function unfold(id, M = placementOf(view.data, { showReplaced: view.showReplaced }), depth = 0) {
    const n = view.data?.nodes.find((x) => x.id === id);
    if (!n || depth > 2) return;
    const p = M.place.get(id);
    const open = (k) => view.expandedGroups.add(k);
    if (p?.gen) open(`gen:${p.gen}`);
    switch (p?.zone) {
      case 'words': open(OWNER_WORDS); break;
      case 'intent': open(`intent:${p.area}`); break;
      case 'ring': open(`ring:${p.ring}`); break;
      case 'exec': open(`exec:${p.band}`); if (M.generations.some((g) => g.id === p.band)) open(`gen:${p.band}`); break;
      case 'gen-plan': open(`gen:${p.band}`); break;
      case 'cell': case 'gen': { const k = cellKey(p.band, p.area); if (!p.whole) open(`cell:${k}`); open(`more:${k}`); open(`found:${k}`); break; }
      default: break;
    }
    if (n.parentId && FOLDABLE.has(n.category)) { view.expandedWork.add(n.parentId); unfold(n.parentId, M, depth + 1); }
  }

  return {
    cy,
    view,
    update(data) { view.data = data; render(); },
    setStars(mode, lastVisit) { view.starMode = mode; view.lastVisit = lastVisit; render(); },
    setSelection(id) { if (anchorAt?.id !== id) anchorAt = null; view.selectionId = id; if (id && view.data && !cy.getElementById(id).length) render(); else { applyEmphasis(); lastEmph = emphasisKey(); } },
    /**
     * What `Compare` is showing: the differing objects, which side (`Before`, `Delta`, `After`) and which difference
     * the owner is standing on. `Delta` draws only what differs, plus what it hangs from, so the difference is not
     * lost among everything that stayed the same (D45). Passing null leaves compare mode.
     */
    setCompare(compare) { view.compare = compare; render(); },
    setScale(scale, opts = {}) {
      const changed = view.scale !== scale;
      view.scale = scale;
      // Focus and change emphasis belong to their scale; leaving it returns the whole graph (nothing stays faded).
      view.focusId = scale === 'Work' ? (opts.focusId ?? view.selectionId) : null;
      render({ refit: changed && !opts.keepView, relayout: changed });
    },
    setFilters(filters) { Object.assign(view.filters, filters); render({ relayout: true }); },
    setShowReplaced(on) { view.showReplaced = on; render({ relayout: true }); },
    /** D54: `counts` shows how many other links each object has; `lines` draws them all. */
    setLinks(mode) { view.links = mode === 'lines' ? 'lines' : 'counts'; render(); },
    expand(id, direction) {
      const rel = view.data.relations;
      const ids = direction === 'up' ? upstreamOf(id, rel, new Set()) : downstreamOf(id, rel, new Set());
      const M = placementOf(view.data, { showReplaced: view.showReplaced });
      for (const x of ids) { const n = view.data.nodes.find((y) => y.id === x); if (!n) continue; unfold(x, M); if (n.category === 'Work item') view.expandedWork.add(n.id); if (n.category === 'Area') view.expandedGroups.add(`intent:${n.id}`); if (n.parentId) view.expandedWork.add(n.parentId); }
      render();
    },
    reveal(id) {
      if (!view.data?.nodes.some((x) => x.id === id)) return;
      unfold(id);
      render();
      const el = cy.getElementById(id);
      if (!el.length) return;
      // Bring the object to the middle and flash it, so a click in the outline is visible in the graph. The zoom is
      // left alone: it is the graph's own, which is never below the floor, or the one the owner chose — zoomed far out
      // to see the whole, the flash shows them where in the whole the object is. An object already in sight is only
      // flashed: clicking what is on screen does not move the picture under the owner.
      cy.stop();
      if (!inView(boxOf(el), windowSize(), cy.zoom(), cy.pan(), 8)) { cy.center(el); ownView(); }
      el.addClass('hit');
      const flashed = el.id();
      setTimeout(() => { if (!pinned.includes(flashed)) cy.getElementById(flashed).removeClass('hit'); }, 1500);
    },
    highlight(ids) {
      pinned = [...ids];
      cy.elements().removeClass('hit');
      for (const id of pinned) { cy.getElementById(id).addClass('hit'); copiesOf(id).addClass('hit'); }
    },
    /** Drop the marks. The outline's flash is not one of them. */
    clearMarks() { pinned = []; cy.elements().removeClass('hit'); },
    /**
     * Bring objects into view and mark them, without dimming anything else (D48). Folds that hide an object open
     * first, then the view moves under the same zoom rule as before (not below the floor, not magnified past 1.2),
     * then the mark is applied. A relation marks its line and both ends. The mark stays until `clearMarks`.
     * Returns how many of `ids` could be drawn.
     */
    showAffected(ids) {
      const rels = view.data?.relations ?? [];
      const nodeIds = [];
      for (const id of ids) {
        const rel = rels.find((r) => r.id === id);
        if (rel) nodeIds.push(rel.from, rel.to);
        else nodeIds.push(id);
      }
      for (const id of nodeIds) unfold(id);
      render();
      const els = cy.collection();
      let found = 0;
      for (const id of ids) {
        const rel = rels.find((r) => r.id === id);
        if (rel) {
          const edge = cy.getElementById(rel.id);
          const a = cy.getElementById(rel.from);
          const b = cy.getElementById(rel.to);
          if (!edge.length && !a.length && !b.length) continue;
          found++;
          if (edge.length) els.merge(edge);
          if (a.length) els.merge(a);
          if (b.length) els.merge(b);
        } else {
          const el = cy.getElementById(id);
          if (!el.length) continue;
          found++;
          els.merge(el);
        }
      }
      pinned = [];
      cy.elements().removeClass('hit');
      if (els.empty()) return 0;
      cy.stop();
      cy.fit(els, 90);
      // A view the graph chooses: not below the floor (when they are too far apart for that, the middle of them, and
      // the rest is a drag away), and not blown up either.
      const z = Math.min(1.2, Math.max(ZOOM_FLOOR, cy.zoom()));
      if (z !== cy.zoom()) { cy.zoom(z); cy.center(els); }
      ownView();
      pinned = els.toArray().map((el) => el.id());
      els.addClass('hit');
      return found;
    },
    /** The whole picture, as far as its names stay readable; gives the view back to the graph (it follows the window again). */
    fit() { fitReadable(); },
    /** A control outside the graph changed what it draws (the process view's `Expand all`, CKC-24): draw again. */
    refresh() { render(); },
    /**
     * The theme changed (Spec §6.16): the palette is read off the page again, the stylesheet takes its colours, and every
     * object's picture is drawn again in them. Nothing is laid out again and the viewport is not touched — the objects
     * keep their ids, so the render finds the same picture and only swaps the data that differs.
     */
    repaint() {
      refreshPalette();
      cy.style().fromJson(graphStyle(palette)).update();
      render();
    },
    /**
     * `Show all anyway`: the whole picture in the window whatever that does to the size of its words — the owner's
     * explicit choice, the one way to see the shape of a large project at a glance. The view is then theirs: a change of
     * size does not bring the readable fit back, `Fit` does.
     */
    fitAll() {
      const box = pictureBox(pictureNodes()), size = windowSize();
      if (!box || size.w < 2 || size.h < 2) return;
      setZoomLimit();   // cytoscape refuses a view below its minimum zoom; the whole view is never below this limit
      const v = wholeView(box, size, fitOpts());
      cy.stop();
      cy.viewport({ zoom: v.zoom, pan: v.pan });
      ownView();
    },
    labelOf(id) { const el = cy.getElementById(id); return el.length ? (el.data('rawLabel') ?? id) : id; },
    /**
     * Where an object is on the page right now, in viewport coordinates: a node's body (not the marks that hang over
     * its corner), or for a line the spot that was tapped (`at`, in the graph's own coordinates) or its middle. Cut to
     * the visible canvas — an object panned out of it gives the nearest point of the canvas's edge — and null when the
     * object is not drawn at all.
     */
    rectOf(id, at = null) {
      // A work item picked from one of its copies: beside that copy, while it is drawn.
      const via = anchorAt?.id === id ? cy.getElementById(anchorAt.el) : null;
      const el = via?.length && via.style('display') !== 'none' ? via : cy.getElementById(id);
      if (!el.length || el.style('display') === 'none') return null;
      const box = container.getBoundingClientRect();
      let r;
      if (el.isEdge()) {
        const m = at ?? el.midpoint();
        if (!m) return null;
        const x = m.x * cy.zoom() + cy.pan().x, y = m.y * cy.zoom() + cy.pan().y;
        r = { left: x - 6, top: y - 6, right: x + 6, bottom: y + 6 };
      } else {
        const p = el.renderedPosition(), w = el.renderedWidth(), hgt = el.renderedHeight();
        r = { left: p.x - w / 2, top: p.y - hgt / 2, right: p.x + w / 2, bottom: p.y + hgt / 2 };
      }
      const cut = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
      return { left: box.left + cut(r.left, 0, box.width), top: box.top + cut(r.top, 0, box.height), right: box.left + cut(r.right, 0, box.width), bottom: box.top + cut(r.bottom, 0, box.height) };
    },
    destroy() { resizeWatch?.disconnect(); clearTimeout(readTimer); tip.remove(); cy.destroy(); },
  };
}
