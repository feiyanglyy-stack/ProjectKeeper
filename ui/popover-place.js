// Where the details popover goes (Spec §6.4). No DOM here: rectangles in, a position out, so the rule can be tested
// without a browser (src/ui/popover-place.test.ts). All rectangles are { left, top, right, bottom } in one coordinate
// space (the viewport, in practice).
//
// The rule: beside the object, on the first side that leaves the object uncovered — to its right, else to its left,
// else below, else above — and always wholly inside `bounds`, the main view's visible area, which is narrower while
// the Keeper conversation is docked. A popover that is already up keeps its side while that side still fits, so an
// update in place does not make it jump. When no side is free (the object fills the area) it takes the side where it
// covers the least of the object and reports `covers`.
//
// `avoid` names rectangles to keep off when that can be helped — the pill at the bottom right (CKC-09 AC-1). On the side
// it stands, the popover slides along the object (up or down beside it, left or right above or below it) by just enough
// to clear them; a side where no slide clears them gives way to a side that is clear. The rules above come first: when
// nothing is clear it still lies wholly inside the area and off its object, on the rectangle, and reports `overlaps`.

const SIDES = ['right', 'left', 'bottom', 'top'];
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/**
 * @param {{ anchor: {left:number,top:number,right:number,bottom:number}, size: {width:number,height:number},
 *   bounds: {left:number,top:number,right:number,bottom:number}, gap?: number, margin?: number,
 *   prefer?: readonly string[], keepSide?: string|null, avoid?: ReadonlyArray<{left:number,top:number,right:number,bottom:number}> }} o
 * @returns {{ left:number, top:number, width:number, height:number, side:string, covers:boolean, overlaps:boolean }}
 */
export function placePopover({ anchor, size, bounds, gap = 8, margin = 8, prefer = SIDES, keepSide = null, avoid = [] }) {
  const area = { left: bounds.left + margin, top: bounds.top + margin, right: bounds.right - margin, bottom: bounds.bottom - margin };
  if (area.right < area.left) area.right = area.left = (bounds.left + bounds.right) / 2;
  if (area.bottom < area.top) area.bottom = area.top = (bounds.top + bounds.bottom) / 2;
  // Larger than the area: cut to it, and the popover's own body scrolls.
  const width = Math.min(size.width, area.right - area.left);
  const height = Math.min(size.height, area.bottom - area.top);
  // The part of the object that is in the area; an object that is wholly outside (scrolled away, under the panel)
  // counts as the nearest point of the area's edge.
  const a = {
    left: clamp(anchor.left, bounds.left, bounds.right), right: clamp(anchor.right, bounds.left, bounds.right),
    top: clamp(anchor.top, bounds.top, bounds.bottom), bottom: clamp(anchor.bottom, bounds.top, bounds.bottom),
  };
  const candidate = (side) => {
    const free = side === 'right' ? area.right - (a.right + gap) : side === 'left' ? (a.left - gap) - area.left
      : side === 'bottom' ? area.bottom - (a.bottom + gap) : (a.top - gap) - area.top;
    const wants = side === 'right' ? { left: a.right + gap, top: a.top } : side === 'left' ? { left: a.left - gap - width, top: a.top }
      : side === 'bottom' ? { left: a.left, top: a.bottom + gap } : { left: a.left, top: a.top - gap - height };
    let left = clamp(wants.left, area.left, area.right - width);
    let top = clamp(wants.top, area.top, area.bottom - height);
    const fits = free >= (side === 'right' || side === 'left' ? width : height);
    // Off the rectangles to keep off: slide along the object, by the least that clears every one of them.
    const at = (l, t) => ({ left: l, top: t, right: l + width, bottom: t + height });
    const onOne = (l, t) => obstacles.some((o) => overlap(at(l, t), o) > 0);
    let blocked = onOne(left, top);
    if (blocked) {
      const upDown = side === 'right' || side === 'left';
      const slides = obstacles.flatMap((o) => (upDown ? [o.top - gap - height, o.bottom + gap] : [o.left - gap - width, o.right + gap]))
        .filter((v) => (upDown ? v >= area.top && v <= area.bottom - height && !onOne(left, v) : v >= area.left && v <= area.right - width && !onOne(v, top)))
        .sort((x, y) => Math.abs(x - (upDown ? top : left)) - Math.abs(y - (upDown ? top : left)));
      if (slides.length) { if (upDown) top = slides[0]; else left = slides[0]; blocked = false; }
    }
    return { side, left, top, fits, free, blocked, covered: overlap(at(left, top), a) };
  };
  const obstacles = (avoid ?? []).filter((o) => o && o.right > o.left && o.bottom > o.top);
  const order = [...new Set([...(keepSide ? [keepSide] : []), ...prefer, ...SIDES])].filter((s) => SIDES.includes(s));
  const all = order.map(candidate);
  const chosen = all.find((c) => c.fits && !c.blocked) ?? all.find((c) => c.fits)
    ?? all.slice().sort((x, y) => x.covered - y.covered || Number(x.blocked) - Number(y.blocked) || y.free - x.free)[0];
  return { left: Math.round(chosen.left), top: Math.round(chosen.top), width: Math.round(width), height: Math.round(height), side: chosen.side, covers: !chosen.fits && chosen.covered > 0, overlaps: chosen.blocked };
}

/**
 * What the popover stands beside, asked again every time it is placed. `ways` are tried in order (the object itself
 * first, lesser stand-ins after it); each answers a rectangle, or null when its thing is not on screen. The answer
 * moves up the order when something better comes on screen, and never down it: when what the popover stood beside
 * goes away — an answered note leaves the list it was picked from — the answer is null, the caller keeps the last
 * place, and the popover does not jump under the owner's pointer to some other thing.
 * @param {Array<() => (Rect | null | undefined)>} ways
 * @returns {() => (Rect | null)}
 */
export function standBeside(ways) {
  let stoodAt = ways.length;
  return () => {
    for (let i = 0; i < ways.length; i++) {
      const rect = ways[i]();
      if (!rect) continue;
      if (i > stoodAt) return null;
      stoodAt = i;
      return rect;
    }
    return null;
  };
}
