/**
 * Where the details popover goes (Spec §6.4; CKC-09 AC-34, AC-36): beside the object it belongs to, on a side that
 * does not cover it, on the other side near an edge, and always wholly inside the main view's visible area — which
 * is narrower while the Keeper conversation is docked on the right. The calculation is pure, so it is checked here
 * without a browser; the browser check (scripts/ui-s1-check.mjs) measures the same thing on the real page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placePopover, standBeside } from '../../ui/popover-place.js';
import type { Rect } from '../../ui/popover-place.js';

const MAIN: Rect = { left: 230, top: 52, right: 1280, bottom: 800 };          // the main view at 1280×800, rail on the left
const DOCKED: Rect = { left: 230, top: 52, right: 860, bottom: 800 };         // the same with a 420px Keeper panel docked
const SIZE = { width: 380, height: 420 };
const box = (left: number, top: number, width = 170, height = 46): Rect => ({ left, top, right: left + width, bottom: top + height });
const rectOf = (p: { left: number; top: number; width: number; height: number }): Rect => ({ left: p.left, top: p.top, right: p.left + p.width, bottom: p.top + p.height });
const inside = (a: Rect, b: Rect) => a.left >= b.left && a.top >= b.top && a.right <= b.right && a.bottom <= b.bottom;
const intersects = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test('beside the object: to its right, top edges level, a gap between them', () => {
  const anchor = box(500, 300);
  const p = placePopover({ anchor, size: SIZE, bounds: MAIN });
  assert.equal(p.side, 'right');
  assert.equal(p.left, anchor.right + 8);
  assert.equal(p.top, anchor.top);
  assert.equal(p.covers, false);
  assert.ok(inside(rectOf(p), MAIN));
});

test('near the right edge it goes to the other side of the object', () => {
  const anchor = box(1090, 300);
  const p = placePopover({ anchor, size: SIZE, bounds: MAIN });
  assert.equal(p.side, 'left');
  assert.equal(p.left + p.width, anchor.left - 8);
  assert.ok(inside(rectOf(p), MAIN));
  assert.ok(!intersects(rectOf(p), anchor));
});

test('near the left, top and bottom edges it stays wholly inside and off the object', () => {
  for (const anchor of [box(232, 300), box(600, 54), box(600, 752), box(232, 54), box(1108, 752)]) {
    const p = placePopover({ anchor, size: SIZE, bounds: MAIN });
    assert.ok(inside(rectOf(p), MAIN), `inside for anchor at ${anchor.left},${anchor.top}: ${JSON.stringify(p)}`);
    assert.ok(!intersects(rectOf(p), anchor), `off the object for anchor at ${anchor.left},${anchor.top}`);
    assert.equal(p.covers, false);
  }
});

test('an edge margin is kept: the popover never touches the border of the area', () => {
  const p = placePopover({ anchor: box(600, 760), size: SIZE, bounds: MAIN, margin: 8 });
  assert.ok(p.top + p.height <= MAIN.bottom - 8);
  const q = placePopover({ anchor: box(600, 52), size: SIZE, bounds: MAIN, margin: 8 });
  assert.ok(q.top >= MAIN.top + 8);
});

test('an object as wide as the area (a List row): below it, or above when there is no room below', () => {
  const row = box(240, 200, 1030, 40);
  const below = placePopover({ anchor: row, size: SIZE, bounds: MAIN });
  assert.equal(below.side, 'bottom');
  assert.equal(below.top, row.bottom + 8);
  const low = box(240, 600, 1030, 40);
  const above = placePopover({ anchor: low, size: SIZE, bounds: MAIN });
  assert.equal(above.side, 'top');
  assert.equal(above.top + above.height, low.top - 8);
  for (const p of [below, above]) assert.ok(inside(rectOf(p), MAIN));
});

test('with the Keeper docked the area is narrower, and the popover stays out from under the panel', () => {
  const anchor = box(640, 300);                       // would go right at full width
  assert.equal(placePopover({ anchor, size: SIZE, bounds: MAIN }).side, 'right');
  const p = placePopover({ anchor, size: SIZE, bounds: DOCKED });
  assert.equal(p.side, 'left');
  assert.ok(inside(rectOf(p), DOCKED));
  assert.ok(p.left + p.width <= DOCKED.right - 8);
});

test('an object partly or wholly outside the area (scrolled away, under the panel) still gets a popover inside it', () => {
  for (const anchor of [box(800, 300), box(900, 300), box(100, 900), box(-400, -200)]) {
    const p = placePopover({ anchor, size: SIZE, bounds: DOCKED });
    assert.ok(inside(rectOf(p), DOCKED), JSON.stringify({ anchor, p }));
  }
});

test('a popover larger than the area is cut to it, so its body scrolls instead of leaving the area', () => {
  const small: Rect = { left: 0, top: 52, right: 360, bottom: 400 };
  const p = placePopover({ anchor: box(20, 100, 100, 30), size: { width: 380, height: 900 }, bounds: small, margin: 8 });
  assert.equal(p.width, 360 - 16);
  assert.equal(p.height, 400 - 52 - 16);
  assert.ok(inside(rectOf(p), small));
});

test('when no side is free it covers as little of the object as it can, and says so', () => {
  const anchor: Rect = { left: 240, top: 60, right: 1270, bottom: 700 };      // the object fills the area
  const p = placePopover({ anchor, size: SIZE, bounds: MAIN });
  assert.ok(inside(rectOf(p), MAIN));
  assert.equal(p.covers, true);
  assert.equal(p.side, 'bottom', 'the most room is below it');
});

test('it keeps the side it is on while that side still fits, so an update in place does not make it jump', () => {
  const anchor = box(650, 300);
  assert.equal(placePopover({ anchor, size: SIZE, bounds: MAIN }).side, 'right');
  const kept = placePopover({ anchor, size: SIZE, bounds: MAIN, keepSide: 'left' });
  assert.equal(kept.side, 'left');
  const forced = placePopover({ anchor: box(300, 300), size: SIZE, bounds: MAIN, keepSide: 'left' });
  assert.equal(forced.side, 'right', 'a side that no longer fits is not kept');
});

test('everywhere in the area, at full width and with the Keeper docked: wholly inside, and off the object whenever a side is free', () => {
  for (const bounds of [MAIN, DOCKED]) {
    for (let x = bounds.left - 60; x <= bounds.right; x += 35) {
      for (let y = bounds.top - 30; y <= bounds.bottom; y += 31) {
        const anchor = box(x, y);
        const p = placePopover({ anchor, size: SIZE, bounds });
        assert.ok(inside(rectOf(p), bounds), `inside: ${JSON.stringify({ anchor, p })}`);
        if (!p.covers) assert.ok(!intersects(rectOf(p), anchor), `off the object: ${JSON.stringify({ anchor, p })}`);
      }
    }
  }
});

// ── What it stands beside, asked again at every placement ───────────────────
// ── Rectangles to keep off (the pill at the bottom right; CKC-09 AC-1, batch S3) ─────────────────────────────
const PILL: Rect = { left: 1072, top: 748, right: 1262, bottom: 792 };        // `↻ Follow up | Pi` at 1280×800

test('an object low on the page: the popover stays beside it and moves up off the pill', () => {
  const anchor = box(600, 730);
  const plain = placePopover({ anchor, size: SIZE, bounds: MAIN });
  assert.ok(intersects(rectOf(plain), PILL), 'without the option it lies on the pill — what S1 left for this batch');
  const p = placePopover({ anchor, size: SIZE, bounds: MAIN, avoid: [PILL] });
  assert.equal(p.side, plain.side, 'the same side of the object');
  assert.equal(p.left, plain.left);
  assert.equal(p.top, PILL.top - 8 - SIZE.height, 'moved up by just enough, the usual gap away from the pill');
  assert.ok(!intersects(rectOf(p), PILL) && !intersects(rectOf(p), anchor) && inside(rectOf(p), MAIN));
  assert.equal(p.overlaps, false);
});

test('a popover over a wide object moves sideways off the pill', () => {
  const row: Rect = { left: 238, top: 300, right: 1272, bottom: 330 };      // as wide as the main view: below it
  const size = { width: 380, height: 440 };
  const anchorAtRight: Rect = { ...row, left: 900 };
  const plain = placePopover({ anchor: anchorAtRight, size, bounds: MAIN, prefer: ['bottom', 'top', 'right', 'left'] });
  assert.equal(plain.side, 'bottom');
  assert.ok(intersects(rectOf(plain), PILL));
  const p = placePopover({ anchor: anchorAtRight, size, bounds: MAIN, prefer: ['bottom', 'top', 'right', 'left'], avoid: [PILL] });
  assert.equal(p.side, 'bottom');
  assert.equal(p.left + p.width, PILL.left - 8, 'to the left of the pill, the usual gap away');
  assert.ok(!intersects(rectOf(p), PILL) && inside(rectOf(p), MAIN));
});

test('a side that cannot get off the pill gives way to one that is clear', () => {
  // Too tall to move up off the pill on the right; on the left of the object there is room and no pill.
  const tall = { width: 380, height: 700 };
  const anchor = box(700, 400);
  const p = placePopover({ anchor, size: tall, bounds: MAIN, avoid: [PILL] });
  assert.equal(p.side, 'left');
  assert.ok(!intersects(rectOf(p), PILL) && !intersects(rectOf(p), anchor) && inside(rectOf(p), MAIN));
  assert.equal(p.overlaps, false);
});

test('when the pill cannot be avoided the popover still lies wholly inside the area and off its object, and says so', () => {
  const tall = { width: 380, height: 700 };
  const anchor = box(520, 400);                                              // no room on its left, and none above or below
  const p = placePopover({ anchor, size: tall, bounds: MAIN, avoid: [PILL] });
  assert.equal(p.side, 'right');
  assert.ok(inside(rectOf(p), MAIN) && !intersects(rectOf(p), anchor));
  assert.ok(intersects(rectOf(p), PILL));
  assert.equal(p.overlaps, true);
});

test('keeping off the pill never costs the rules that came first: everywhere in the area, wholly inside and off the object', () => {
  for (const bounds of [MAIN, DOCKED]) {
    const pill: Rect = { left: bounds.right - 208, top: 748, right: bounds.right - 18, bottom: 792 };
    let onPill = 0, placed = 0;
    for (let x = bounds.left - 60; x <= bounds.right + 20; x += 35) {
      for (let y = bounds.top - 40; y <= bounds.bottom + 20; y += 28) {
        const anchor = box(x, y);
        const plain = placePopover({ anchor, size: SIZE, bounds });
        const p = placePopover({ anchor, size: SIZE, bounds, avoid: [pill] });
        placed++;
        assert.ok(inside(rectOf(p), bounds), `inside at ${x},${y}`);
        if (!plain.covers) assert.equal(p.covers, false, `a free side is still used at ${x},${y}`);
        if (intersects(rectOf(p), pill)) onPill++;
      }
    }
    assert.equal(onPill, 0, `a popover of the usual size never has to lie on the pill (${placed} places tried, area ${bounds.right - bounds.left}px wide)`);
  }
});

test('without rectangles to keep off, the placement is what it was', () => {
  for (const anchor of [box(500, 300), box(1200, 700), box(240, 60), box(600, 730)]) {
    const { overlaps, ...p } = placePopover({ anchor, size: SIZE, bounds: MAIN, avoid: [] });
    const { overlaps: _, ...plain } = placePopover({ anchor, size: SIZE, bounds: MAIN });
    assert.deepEqual(p, plain);
    assert.equal(overlaps, false);
  }
});

test('it stands beside the first thing that is on screen, in the order given', () => {
  const row = box(300, 600);
  const anchor = standBeside([() => null, () => row, () => box(900, 100)]);
  assert.deepEqual(anchor(), row);
});

test('it moves up the order when the object itself comes on screen', () => {
  let onGraph: Rect | null = null;
  const row = box(300, 600);
  const anchor = standBeside([() => onGraph, () => row]);
  assert.deepEqual(anchor(), row);
  onGraph = box(700, 200);
  assert.deepEqual(anchor(), onGraph);
});

test('it never moves down the order: when what it stood beside goes away it answers null, and the popover stays', () => {
  let row: Rect | null = box(300, 600);
  const mountedOn = box(900, 100);
  const anchor = standBeside([() => null, () => row, () => mountedOn]);
  assert.deepEqual(anchor(), row);
  row = null;                                       // the answered note left the list it was picked from
  assert.equal(anchor(), null, 'not the lesser thing: that would make the popover jump under the pointer');
  row = box(300, 640);                              // the list was rebuilt and the row is back, a little lower
  assert.deepEqual(anchor(), row);
});

test('with nothing on screen at all it answers null, and takes whatever comes first later', () => {
  let outside: Rect | null = null;
  const anchor = standBeside([() => null, () => outside]);
  assert.equal(anchor(), null);
  outside = box(100, 300);
  assert.deepEqual(anchor(), outside);
});
