// How the project graph sits in its window (CKC-09 AC-39; Spec §6.3 "布局", "同一层级同样大小", "可读性自检"): the zoom
// floor comes from the size of the words, the whole picture is fitted on opening and scrolls once the floor is reached,
// the self-check judges "too big" by the same rule, and the layout keeps a level one size with nothing on top of anything.
// The interface is plain ES modules without types, so they are loaded at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ui = (name: string) => new URL(`../../ui/${name}`, import.meta.url);
const fit: any = await import(ui('graph-fit.js').href);
const graph: any = await import(ui('graph.js').href);

interface Box { x: number; y: number; w: number; h: number; col?: number }
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
/** Where the picture's box lands on screen under a view. */
const onScreen = (box: { x1: number; y1: number; x2: number; y2: number }, v: { zoom: number; pan: { x: number; y: number } }) => ({ left: box.x1 * v.zoom + v.pan.x, top: box.y1 * v.zoom + v.pan.y, right: box.x2 * v.zoom + v.pan.x, bottom: box.y2 * v.zoom + v.pan.y });

// ── The floor ────────────────────────────────────────────────────────────
test('the zoom floor is worked out from the sizes of the words, not written down as a number (AC-39)', () => {
  assert.equal(fit.ZOOM_FLOOR, fit.MIN_TEXT_PX / fit.TEXT.name);
  assert.ok(near(fit.TEXT.name * fit.ZOOM_FLOOR, fit.MIN_TEXT_PX), 'at the floor a name is exactly the smallest body text');
  assert.ok(fit.ZOOM_FLOOR < 1, 'the floor leaves room to fit more than one window of objects');
});

test('the smallest body text is the stylesheet’s `small`; changing one without the other fails here', () => {
  const css = readFileSync(ui('styles.css'), 'utf8');
  const m = /(?:^|[}\s])small\{font-size:([\d.]+)px/.exec(css);
  assert.ok(m, 'styles.css sets the size of `small`');
  assert.equal(fit.MIN_TEXT_PX, Number(m![1]));
});

test('at the floor every word on an object can still be read: names at body size, the small print no smaller than the interface’s smallest text', () => {
  for (const [what, px] of Object.entries(fit.TEXT as Record<string, number>)) {
    const onScreenPx = px * fit.ZOOM_FLOOR;
    assert.ok(onScreenPx >= fit.MIN_LABEL_PX - 1e-9, `${what} is ${onScreenPx.toFixed(2)}px on screen at the floor`);
  }
  for (const what of ['name', 'product']) assert.ok(fit.TEXT[what] * fit.ZOOM_FLOOR >= fit.MIN_TEXT_PX - 1e-9, `${what} is a name`);
});

// ── Fitting ──────────────────────────────────────────────────────────────
test('a picture that fits is shown whole, in the middle, with air around it', () => {
  const box = { x1: 20, y1: 100, x2: 1220, y2: 500 };
  const v = fit.fitView(box, { w: 1050, h: 399 });
  assert.equal(v.fits, true);
  assert.ok(v.zoom >= fit.ZOOM_FLOOR && v.zoom <= 1);
  const s = onScreen(box, v);
  assert.ok(s.left >= fit.FIT_PAD - 1e-6 && s.top >= fit.FIT_PAD - 1e-6 && s.right <= 1050 - fit.FIT_PAD + 1e-6 && s.bottom <= 399 - fit.FIT_PAD + 1e-6, JSON.stringify(s));
  assert.ok(near(s.left, 1050 - s.right, 1e-6) && near(s.top, 399 - s.bottom, 1e-6), 'centred on both axes');
});

test('a small picture is not blown up past the size it was drawn for', () => {
  const v = fit.fitView({ x1: 0, y1: 0, x2: 300, y2: 120 }, { w: 1600, h: 900 });
  assert.equal(v.zoom, 1);
  assert.equal(v.fits, true);
});

test('a picture too big for the window stops at the floor and starts at its top left corner', () => {
  const box = { x1: 24, y1: 22, x2: 3650, y2: 1192 };
  const v = fit.fitView(box, { w: 1050, h: 399 });
  assert.equal(v.zoom, fit.ZOOM_FLOOR);
  assert.equal(v.fits, false);
  const s = onScreen(box, v);
  assert.ok(near(s.left, fit.FIT_PAD) && near(s.top, fit.FIT_PAD), 'the first column and the top row are where the window starts');
  assert.ok(v.across > 2 && v.down > 2, `it says how many windows it takes: ${v.across} × ${v.down}`);
});

test('too wide but not too tall: from the left edge, and in the middle top to bottom', () => {
  const box = { x1: 0, y1: 0, x2: 4000, y2: 200 };
  const v = fit.fitView(box, { w: 1000, h: 600 });
  const s = onScreen(box, v);
  assert.equal(v.zoom, fit.ZOOM_FLOOR);
  assert.ok(near(s.left, fit.FIT_PAD));
  assert.ok(near(s.top, 600 - s.bottom), 'centred on the axis that fits');
  assert.equal(v.fits, false);
});

test('a wide picture does not open on empty rows: it starts at the topmost object over the columns the window shows', () => {
  // The product is centred over fifteen columns, far to the right of a 1050px window; a goal and the areas stand over
  // the first columns.
  const L = graph.storyLayout(project(14, 150));
  const nodes = project(14, 150).map((d) => { const b = L.box.get(d.id); return { id: d.id, x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, h: b.h }; });
  const window = { w: 1050, h: 431 };
  const v = fit.openingView(nodes, window);
  assert.equal(v.zoom, fit.ZOOM_FLOOR);
  assert.equal(v.fits, false);
  const topOf = (id: string) => (L.box.get(id).y) * v.zoom + v.pan.y, leftOf = (id: string) => L.box.get(id).x * v.zoom + v.pan.x;
  assert.ok(near(topOf('g0'), fit.FIT_PAD), `the first goal is the top of the window (${topOf('g0')}), not the empty row of the product`);
  assert.ok(topOf('p') < 0 && leftOf('p') > window.w, 'the product is up and to the right, a drag away');
  assert.ok(near(leftOf('a0'), fit.FIT_PAD), 'the first column is at the left edge');
  // A picture that is only too tall, or that fits, opens as fitView says.
  const small = project(4, 6).map((d) => { const b = graph.storyLayout(project(4, 6)).box.get(d.id); return { x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, h: b.h }; });
  assert.deepEqual(fit.openingView(small, { w: 1370, h: 634 }), fit.fitView(fit.pictureBox(small), { w: 1370, h: 634 }));
  assert.equal(fit.openingView([], window), null);
});

test('the fit follows the window: a panel taking 440px makes the picture smaller, never below the floor', () => {
  const box = { x1: 0, y1: 0, x2: 1000, y2: 300 };
  const wide = fit.fitView(box, { w: 1370, h: 634 }), normal = fit.fitView(box, { w: 1050, h: 399 }), docked = fit.fitView(box, { w: 610, h: 399 });
  assert.ok(wide.zoom >= normal.zoom && normal.zoom > docked.zoom);
  assert.equal(docked.zoom, fit.ZOOM_FLOOR);
  assert.equal(docked.fits, false);
});

test('a window with no size yet gives a usable view instead of NaN', () => {
  const v = fit.fitView({ x1: 0, y1: 0, x2: 500, y2: 500 }, { w: 0, h: 0 });
  for (const n of [v.zoom, v.pan.x, v.pan.y]) assert.ok(Number.isFinite(n));
  assert.ok(v.zoom >= fit.ZOOM_FLOOR);
});

// ── Room kept clear at the top (the graph's buttons float over its top right corner; CKC-09 AC-37) ───────────────
test('with room kept clear at the top, a fitted picture starts under it and is centred in what is left', () => {
  const box = { x1: 20, y1: 100, x2: 1220, y2: 500 }, window = { w: 1050, h: 399 };
  const plain = fit.fitView(box, window), v = fit.fitView(box, window, { padTop: 44 });
  assert.equal(v.fits, true);
  const s = onScreen(box, v);
  assert.ok(s.top >= 44 - 1e-6, `nothing of the picture is under the buttons: top ${s.top}`);
  assert.ok(s.bottom <= window.h - fit.FIT_PAD + 1e-6 && s.left >= fit.FIT_PAD - 1e-6 && s.right <= window.w - fit.FIT_PAD + 1e-6, JSON.stringify(s));
  assert.ok(near(s.top - 44, window.h - fit.FIT_PAD - s.bottom, 1e-6), 'centred between the clear band and the bottom air');
  assert.ok(near(s.left, window.w - s.right, 1e-6), 'and across as before');
  assert.ok(v.zoom <= plain.zoom, 'less room never makes the picture bigger');
  assert.deepEqual(fit.fitView(box, window, { padTop: fit.FIT_PAD }), plain, 'the air it always had is the default');
});

test('a picture too big for the window starts under the clear band, and what fits is judged with the band taken off', () => {
  const big = { x1: 24, y1: 22, x2: 3650, y2: 1192 };
  const v = fit.fitView(big, { w: 1050, h: 399 }, { padTop: 44 });
  assert.equal(v.zoom, fit.ZOOM_FLOOR);
  assert.ok(near(onScreen(big, v).top, 44) && near(onScreen(big, v).left, fit.FIT_PAD));
  // Exactly as tall as the window holds with the usual air: it fits without the band and no longer with it.
  const tall = { x1: 0, y1: 0, x2: 400, y2: (399 - 2 * fit.FIT_PAD) / fit.ZOOM_FLOOR };
  assert.equal(fit.fitView(tall, { w: 1050, h: 399 }).fits, true);
  assert.equal(fit.fitView(tall, { w: 1050, h: 399 }, { padTop: 44 }).fits, false);
});

test('the whole view, the hard limit and the opening view take the same clear band, so they cannot disagree', () => {
  const box = { x1: 24, y1: 22, x2: 3850, y2: 1540 }, window = { w: 1050, h: 431 }, opts = { padTop: 44 };
  const whole = fit.wholeView(box, window, opts);
  const s = onScreen(box, whole);
  assert.ok(whole.fits && s.top >= 44 - 1e-6 && s.bottom <= window.h - fit.FIT_PAD + 1e-6, JSON.stringify(s));
  // cytoscape refuses a view below its minimum zoom: the limit is worked out with the band too.
  const tallBox = { x1: 0, y1: 0, x2: 900, y2: 9000 };
  assert.ok(fit.wholeView(tallBox, window, opts).zoom >= fit.hardMinZoom(tallBox, window, opts));
  assert.ok(fit.hardMinZoom(tallBox, window, opts) < fit.hardMinZoom(tallBox, window), 'a tall picture needs a lower limit once the band is taken off');
  // Opening on a picture too big both ways: the first row it shows stands under the band.
  const nodes = [{ x: 3000, y: 40, w: 300, h: 60 }, { x: 150, y: 300, w: 228, h: 60 }, { x: 5000, y: 4000, w: 228, h: 60 }];
  const opened = fit.openingView(nodes, { w: 1050, h: 399 }, opts);
  assert.ok(near((300 - 30) * opened.zoom + opened.pan.y, 44), 'the topmost object over the first columns starts under the band');
});

test('the box of a picture takes in what stands out of an object: marks above it, a link count to its right', () => {
  const box = fit.pictureBox([{ x: 100, y: 100, w: 200, h: 60 }, { x: 400, y: 300, w: 200, h: 60, top: 12, right: 38 }, { x: 100, y: 40, w: 100, h: 20, top: 12 }]);
  assert.deepEqual(box, { x1: 0, y1: 18, x2: 538, y2: 330 });
  assert.equal(fit.pictureBox([]), null);
});

// ── Below the floor, by the owner's choice ───────────────────────────────
test('the floor is for the views the graph chooses; the owner’s own wheel and pinch go below it, down to a hard limit', () => {
  assert.ok(fit.ZOOM_HARD_MIN < fit.ZOOM_FLOOR, 'the limit of the owner’s own zoom is below the floor of the graph’s own views');
  // A picture that fits the window anyway: the constant.
  assert.equal(fit.hardMinZoom({ x1: 0, y1: 0, x2: 1200, y2: 400 }, { w: 1050, h: 434 }), fit.ZOOM_HARD_MIN);
  // No picture, or a window with no size yet: the constant, never 0 or NaN.
  assert.equal(fit.hardMinZoom(null, { w: 1050, h: 434 }), fit.ZOOM_HARD_MIN);
  assert.equal(fit.hardMinZoom({ x1: 0, y1: 0, x2: 1200, y2: 400 }, { w: 0, h: 0 }), fit.ZOOM_HARD_MIN);
});

test('the hard limit is never higher than the zoom that shows the whole picture, so the whole of a large project can always be reached', () => {
  const box = { x1: 24, y1: 22, x2: 3850, y2: 1540 };
  for (const window of [{ w: 1050, h: 271 }, { w: 1050, h: 431 }, { w: 610, h: 238 }, { w: 1370, h: 634 }]) {
    const limit = fit.hardMinZoom(box, window);
    assert.ok(limit > 0 && limit <= fit.ZOOM_HARD_MIN, `${limit}`);
    const s = onScreen(box, { zoom: limit, pan: fit.wholeView(box, window).pan });
    assert.ok(s.right - s.left <= window.w - 2 * fit.FIT_PAD + 0.5 && s.bottom - s.top <= window.h - 2 * fit.FIT_PAD + 0.5, `at the limit the whole picture fits ${window.w}×${window.h}`);
  }
  assert.ok(fit.hardMinZoom(box, { w: 1050, h: 271 }) < 0.2, 'a short window over fifteen columns needs far less than the constant');
});

test('Show all anyway: the whole picture in the window whatever that does to the size of its words, and never below the hard limit', () => {
  const box = { x1: 24, y1: 22, x2: 3850, y2: 1540 }, window = { w: 1050, h: 431 };
  const readable = fit.fitView(box, window), whole = fit.wholeView(box, window);
  assert.equal(readable.zoom, fit.ZOOM_FLOOR);
  assert.equal(readable.fits, false);
  assert.equal(whole.fits, true);
  assert.ok(whole.zoom < fit.ZOOM_FLOOR, `${whole.zoom}`);
  const s = onScreen(box, whole);
  assert.ok(s.left >= fit.FIT_PAD - 1e-6 && s.top >= fit.FIT_PAD - 1e-6 && s.right <= window.w - fit.FIT_PAD + 1e-6 && s.bottom <= window.h - fit.FIT_PAD + 1e-6, JSON.stringify(s));
  assert.ok(near(s.left, window.w - s.right) || near(s.top, window.h - s.bottom), 'centred');
  // cytoscape refuses a view below its minimum zoom, so the view is never below the limit set from the same picture.
  for (const w of [{ w: 1050, h: 271 }, { w: 610, h: 238 }, window]) assert.ok(fit.wholeView(box, w).zoom >= fit.hardMinZoom(box, w));
  // A picture that fits anyway is shown as Fit shows it: not magnified.
  const small = { x1: 0, y1: 0, x2: 300, y2: 120 };
  assert.deepEqual(fit.wholeView(small, { w: 1600, h: 900 }), fit.fitView(small, { w: 1600, h: 900 }));
});

// ── The owner's own view ─────────────────────────────────────────────────
test('after a change of size the owner’s own view is kept, unless the picture would be out of sight', () => {
  const box = { x1: 0, y1: 0, x2: 2000, y2: 1000 };
  const own = { x: -300, y: -120 };
  assert.deepEqual(fit.keepInView(box, { w: 610, h: 360 }, 1, own), own, 'still looking at the picture: nothing moves');
  // Looking at the far right of the picture in a wide window; the window then loses its right part.
  const lost = fit.keepInView(box, { w: 610, h: 360 }, 1, { x: 900, y: -120 });
  assert.equal(lost.y, -120);
  const left = box.x1 * 1 + lost.x;
  assert.ok(left <= 610 - fit.KEEP_PX + 1e-6, `at least ${fit.KEEP_PX}px of the picture is back in the window (its left edge is at ${left})`);
  // Dragged off the top left.
  const gone = fit.keepInView(box, { w: 610, h: 360 }, 1, { x: -5000, y: -5000 });
  assert.ok(box.x2 + gone.x >= fit.KEEP_PX - 1e-6 && box.y2 + gone.y >= fit.KEEP_PX - 1e-6);
});

test('whether an object is in view, for bringing it there only when it is not', () => {
  const view = { zoom: 0.8, pan: { x: 10, y: 10 } }, window = { w: 1000, h: 400 };
  assert.equal(fit.inView({ x1: 100, y1: 100, x2: 300, y2: 160 }, window, view.zoom, view.pan), true);
  assert.equal(fit.inView({ x1: 1200, y1: 100, x2: 1400, y2: 160 }, window, view.zoom, view.pan), false, 'off the right edge');
  assert.equal(fit.inView({ x1: 1150, y1: 100, x2: 1300, y2: 160 }, window, view.zoom, view.pan), false, 'half in is not in');
});

test('an object out of sight is brought in by the shortest move, and the zoom is not touched', () => {
  const window = { w: 1000, h: 400 }, pan = { x: 0, y: 0 };
  const inSight = { x1: 100, y1: 100, x2: 300, y2: 160 };
  assert.deepEqual(fit.panToShow(inSight, window, 1, pan), pan, 'already in sight: nothing moves');
  const offRight = { x1: 1200, y1: 100, x2: 1400, y2: 160 };
  const moved = fit.panToShow(offRight, window, 1, pan);
  assert.equal(moved.y, 0, 'only the axis that needs it');
  assert.equal(fit.inView(offRight, window, 1, moved), true);
  assert.ok(offRight.x2 + moved.x <= 1000 && offRight.x2 + moved.x >= 1000 - 60, 'just inside the right edge, not across the window');
  const offTopLeft = fit.panToShow({ x1: -500, y1: -300, x2: -300, y2: -240 }, window, 0.8, pan);
  assert.equal(fit.inView({ x1: -500, y1: -300, x2: -300, y2: -240 }, window, 0.8, offTopLeft), true);
});

// ── The self-check says "too big" by the same rule ───────────────────────
const row = (count: number, w = 200, h = 50, gap = 50): (Box & { id: string; label: string })[] => Array.from({ length: count }, (_, i) => ({ id: `n${i}`, label: `Object ${i}`, x: i * (w + gap) + w / 2, y: h / 2, w, h }));

test('a picture whose names would be under the smallest body text when fitted is reported, with how big it is (D46, AC-26)', () => {
  // Six objects in a row: 1450 wide. A 1050px window fits it at about 0.71, where names would be under 11px.
  const report = graph.readabilityReport(row(6), [], { w: 1050, h: 600 });
  const size = report.issues.find((i: any) => i.kind === 'size');
  assert.ok(size, 'fitted, its names would be too small to read, so it is too big to read at once');
  assert.ok(size.fitZoom < 1 && size.across > 1, `${size.fitZoom} ${size.across}`);
  assert.match(size.text, /\d+(\.\d+)?px/);
  assert.match(size.text, /windows?/);
});

test('a picture that fits at a readable size is not reported', () => {
  const report = graph.readabilityReport(row(4), [], { w: 1050, h: 600 });
  assert.equal(report.issues.filter((i: any) => i.kind === 'size').length, 0);
});

test('the self-check and the viewport agree: reported exactly when the fitted view does not fit', () => {
  for (const count of [2, 4, 5, 6, 9, 20]) {
    for (const window of [{ w: 1050, h: 399 }, { w: 610, h: 359 }, { w: 1370, h: 634 }]) {
      const nodes = row(count);
      const reported = graph.readabilityReport(nodes, [], window).issues.some((i: any) => i.kind === 'size');
      assert.equal(reported, !fit.fitView(fit.pictureBox(nodes), window).fits, `${count} objects in ${window.w}×${window.h}`);
    }
  }
});

// ── The layout ───────────────────────────────────────────────────────────
/** A made-up project for the layout: a product, goals, areas, and work spread over the areas and Project-wide. */
function project(areas: number, works: number) {
  const items: any[] = [{ id: 'p', category: 'Product', label: 'The product', areaId: null }];
  for (let g = 0; g < 3; g++) items.push({ id: `g${g}`, category: 'Goal', label: g === 1 ? 'A goal with a name long enough to need its second line on the object and then some more' : `Goal ${g}`, areaId: null });
  for (let a = 0; a < areas; a++) items.push({ id: `a${a}`, category: 'Area', label: a % 2 ? `Area ${a}` : `Area ${a} with a much longer name than its neighbours have`, areaId: null });
  for (let w = 0; w < works; w++) {
    const area = w % (areas + 1) === areas ? null : `a${w % (areas + 1)}`;
    items.push({ id: `w${w}`, category: w % 9 === 0 ? 'Plan' : 'Work item', label: w % 3 ? `WI-${w}` : `WI-${w} · 一个足够长的名字，用来确认大小不随名字变化 and some English after it`, areaId: area, progress: ['Planned', 'In progress', 'Done', 'On hold'][w % 4] });
  }
  for (let a = 0; a < areas; a++) items.push({ id: `folder:a${a}`, kind: 'folder', category: 'folder', folder: `a${a}`, areaId: `a${a}`, label: 'Observed reality' });
  items.push({ id: 'folder:project-wide', kind: 'folder', category: 'folder', folder: null, areaId: null, label: 'Observed reality' });
  items.push({ id: 'group:Existing foundation', kind: 'group', category: 'group', group: 'Existing foundation', areaId: null, label: 'Existing foundation' });
  return items;
}
const levelOf = (d: any) => d.kind === 'folder' ? 'folder' : d.kind === 'group' ? 'group' : d.category === 'Product' ? 'Product' : ['Goal', 'Area', "Owner's words"].includes(d.category) ? 'heading' : 'work';

test('every object of a level is one size, whatever its name is (Spec §6.3)', () => {
  const items = project(14, 150);
  const L = graph.storyLayout(items);
  const sizes = new Map<string, Set<string>>();
  for (const d of items) { const b = L.box.get(d.id); assert.ok(b, `${d.id} is placed`); const k = levelOf(d); if (!sizes.has(k)) sizes.set(k, new Set()); sizes.get(k)!.add(`${b.w}×${b.h}`); }
  for (const [level, set] of sizes) assert.equal(set.size, 1, `${level}: ${[...set].join(', ')}`);
  assert.equal(L.keys.length, 15, 'one column per area and the cross-cutting one');
});

test('nothing is laid out on top of anything else, in a small project and in a large one', () => {
  for (const [areas, works] of [[4, 6], [14, 150]] as const) {
    const items = project(areas, works);
    const L = graph.storyLayout(items);
    const nodes = items.map((d) => { const b = L.box.get(d.id); return { id: d.id, label: d.label, x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, h: b.h }; });
    const overlap = graph.readabilityReport(nodes, [], { w: 1050, h: 399 }).issues.find((i: any) => i.kind === 'overlap');
    assert.equal(overlap, undefined, overlap?.text);
    // Columns leave the room a link count needs beside an object, and rows the room its corner marks need above it.
    // (Which column a box stands in is read from where it stands: the product and the goals span the columns.)
    const cols = new Map<number, Box[]>();
    for (const d of items) {
      if (d.category === 'Product' || d.category === 'Goal') continue;
      const b = L.box.get(d.id) as Box, c = L.colX.findIndex((x: number) => b.x + b.w / 2 >= x && b.x + b.w / 2 <= x + graph.LAYOUT.colW);
      assert.ok(c >= 0, `${d.id} stands in a column`);
      if (!cols.has(c)) cols.set(c, []);
      cols.get(c)!.push(b);
    }
    const right = (c: number) => Math.max(...cols.get(c)!.map((b) => b.x + b.w)), left = (c: number) => Math.min(...cols.get(c)!.map((b) => b.x));
    for (let c = 0; c + 1 < L.keys.length; c++) assert.ok(left(c + 1) - right(c) >= graph.LAYOUT.colGap - 1e-6, `between columns ${c} and ${c + 1}: ${left(c + 1) - right(c)}`);
    for (const list of cols.values()) { const sorted = [...list].sort((a, b) => a.y - b.y); for (let i = 0; i + 1 < sorted.length; i++) assert.ok(sorted[i + 1]!.y - (sorted[i]!.y + sorted[i]!.h) >= graph.LAYOUT.vGap - 1e-6); }
  }
});

test('an object holds its words at their sizes: one line of kind and progress, two lines of name', () => {
  const lines = (namePx: number) => fit.TEXT.kind + 2 * namePx;
  assert.ok(graph.SIZE.item[1] >= lines(fit.TEXT.name) * 1.2, `work and plan: ${graph.SIZE.item[1]}`);
  assert.ok(graph.SIZE.heading[1] >= lines(fit.TEXT.name) * 1.2, `goal, area, owner’s words: ${graph.SIZE.heading[1]}`);
  assert.ok(graph.SIZE.Product[1] >= lines(fit.TEXT.product) * 1.2, `product: ${graph.SIZE.Product[1]}`);
});

test('the gaps hold what runs through them: the bus of the structure lines and the corner marks of the row below', () => {
  const marksStandAbove = 11;   // a corner mark's radius (10) plus the pixel its centre sits above the object's edge
  assert.ok(graph.LAYOUT.rowGap >= graph.LAYOUT.bus + marksStandAbove, `between the top levels: ${graph.LAYOUT.rowGap}`);
  assert.ok(graph.LAYOUT.vGap >= marksStandAbove, `between objects in a column: ${graph.LAYOUT.vGap}`);
  assert.ok(graph.LAYOUT.bodyGap >= marksStandAbove && graph.LAYOUT.folderGap >= marksStandAbove);
  // The rows of the top levels are where the layout says: each under the one above by its height and the gap.
  const L = graph.storyLayout(project(4, 6));
  const top = (id: string) => L.box.get(id).y, bottom = (id: string) => L.box.get(id).y + L.box.get(id).h;
  assert.equal(top('g0') - bottom('p'), graph.LAYOUT.rowGap);
  assert.equal(top('a0') - bottom('g0'), graph.LAYOUT.rowGap);
  // Under the areas the bands begin (D100); a work stands in its band, the band's padding under the band's top.
  assert.ok(L.bands[0].y - bottom('a0') >= graph.LAYOUT.bodyGap, `${L.bands[0].y - bottom('a0')}`);
  assert.equal(top('w0'), L.bands[0].y + graph.LAYOUT.bandPad);
});

test('more of a project fits at a readable size: five columns of a small project fit a 1280px-wide window’s graph area', () => {
  // The demo project's shape: a goal, four areas and Project-wide, a few things in each column. At 1280×800 the graph
  // has about 1050px across. Read at the floor or above, the whole picture has to be inside it.
  const items = project(4, 5).filter((d) => d.category !== 'Product');
  const L = graph.storyLayout(items);
  const nodes = items.map((d) => { const b = L.box.get(d.id); return { x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, h: b.h }; });
  const box = fit.pictureBox(nodes);
  const across = fit.fitView(box, { w: 1050, h: 4000 });
  assert.equal(across.fits, true, `five columns are ${box.x2 - box.x1} wide: ${((box.x2 - box.x1) * fit.ZOOM_FLOOR).toFixed(0)}px at the floor`);
  assert.ok(across.zoom * fit.TEXT.name >= fit.MIN_TEXT_PX);
});
