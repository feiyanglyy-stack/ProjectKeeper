// How the project graph sits in its window (Spec §6.3 "布局"; CKC-09 AC-39, D68): on opening the whole picture is in the
// visible area; the graph never chooses a view so small that the words on the objects stop being readable; once that
// floor is reached the picture is panned instead. The floor is for the views the graph chooses. The owner may go below
// it — by wheel or pinch, down to a hard limit, or with `Show all anyway` — to see the shape of a large project at a
// glance (WorkflowKeeper does the same: a floor for opening, a lower limit for the owner's own zoom). The graph's
// viewport and its readability self-check both ask this module, so they cannot disagree about what "fits". No DOM here:
// it is tested with `node --test` (src/ui/graph-fit.test.ts).

/**
 * The smallest size body text has in the interface: `small` in styles.css, 11px — the size of every secondary line the
 * owner is expected to read (sub-headings, hints, counts beside a name). The 10.5px of the legend and of the line under
 * a strip item, and the 10px inside chips, label things rather than say them. A name on an object is never smaller than
 * this on screen. A test reads styles.css, so the two cannot drift apart unnoticed.
 */
export const MIN_TEXT_PX = 11;
/** The smallest size any text has in the interface (the counts in chips). The small print on an object — its kind, its
 *  progress, its counts — is never smaller than this on screen. */
export const MIN_LABEL_PX = 10;

/**
 * Sizes of the words drawn on objects, in px at 100%. They are large against the object they sit on, and the objects
 * sit close together, so that a whole project fits a window while its words can still be read: the lever for fitting
 * more is the ratio of these sizes to the sizes in graph.js, never a lower floor.
 * `name`: every object's name. `product`: the product's name. `kind`: the line of kind, validity and progress, and the
 * other small print (`No established link`, a folder's lines, a group's label). `count`: numbers in chips and corner
 * marks. `total`: the number on an Observed reality folder.
 */
export const TEXT = Object.freeze({ name: 14, product: 15, kind: 13, count: 13, total: 20 });

/**
 * The zoom no view of the graph's own choosing goes below: opening, fitting again while the view is still the graph's
 * (the window or the graph's container changed size, the scale changed), `Fit`, what a change touched brought into view.
 * A name is then exactly MIN_TEXT_PX on screen (and the small print 13 × 11/14 = 10.2px, above MIN_LABEL_PX). It is not
 * a limit on the owner: their own wheel and pinch go below it (hardMinZoom), and so does `Show all anyway` (wholeView).
 */
export const ZOOM_FLOOR = MIN_TEXT_PX / TEXT.name;
/** How far the owner's own wheel and pinch go when the picture needs no more than that (WorkflowKeeper's number for the
 *  same thing). Far below the floor: at 0.3 a name is 4px, the project is read as a shape, not as words. */
export const ZOOM_HARD_MIN = 0.3;
/** A fitted picture is not magnified past the size it was drawn for (WorkflowKeeper's rule): a project of five objects
 *  does not fill the window with 30px letters. The owner can still zoom in by hand. */
export const FIT_CEILING = 1;
/** Air around a fitted picture, px on screen. */
export const FIT_PAD = 10;
/** After a change of size, this much of the picture (px on screen, each way) stays in the window at least. */
export const KEEP_PX = 120;

/**
 * The box around objects given by centre and size ({ x, y, w, h }), including what stands out of an object: `top` (its
 * corner marks) and `right` (its link count), in the same units. Null when there is nothing.
 */
export function pictureBox(nodes) {
  if (!nodes.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const n of nodes) {
    x1 = Math.min(x1, n.x - n.w / 2); x2 = Math.max(x2, n.x + n.w / 2 + (n.right ?? 0));
    y1 = Math.min(y1, n.y - n.h / 2 - (n.top ?? 0)); y2 = Math.max(y2, n.y + n.h / 2);
  }
  return { x1, y1, x2, y2 };
}

/**
 * The view that shows a picture in a window. `box`: { x1, y1, x2, y2 } in the picture's own units; `viewport`: { w, h }
 * in px. Returns the zoom and the pan (px, of the picture's origin from the window's top left corner), and:
 * `fits` — the whole picture is inside the window at this zoom; `fitZoom` — the zoom that would show all of it, however
 * small; `across`, `down` — how many windows the picture takes at the returned zoom.
 * The zoom is `fitZoom` held between the floor and the ceiling. An axis that fits is centred; one that does not starts at
 * the picture's left or top edge, where the top levels and the first column are, and the rest is reached by panning.
 * `padTop`: px kept clear at the top instead of `pad` — the graph's buttons float over its top right corner (CKC-09
 * AC-37), and a view the graph chooses does not put objects under them. The picture is fitted to, and centred in, what
 * is left below it. Everything that works out a view takes the same option (wholeView, hardMinZoom, openingView).
 */
export function fitView(box, viewport, { floor = ZOOM_FLOOR, ceiling = FIT_CEILING, pad = FIT_PAD, padTop = pad } = {}) {
  const bw = Math.max(1, box.x2 - box.x1), bh = Math.max(1, box.y2 - box.y1);
  const availW = Math.max(1, viewport.w - 2 * pad), availH = Math.max(1, viewport.h - pad - padTop);
  const fitZoom = Math.min(availW / bw, availH / bh);
  const zoom = Math.min(ceiling, Math.max(floor, fitZoom));
  const slack = 0.5;   // half a pixel of rounding is not "does not fit"
  const fitsX = bw * zoom <= availW + slack, fitsY = bh * zoom <= availH + slack;
  const pan = {
    x: (fitsX ? (viewport.w - bw * zoom) / 2 : pad) - box.x1 * zoom,
    y: (fitsY ? padTop + (availH - bh * zoom) / 2 : padTop) - box.y1 * zoom,
  };
  return { zoom, pan, fits: fitsX && fitsY, fitsX, fitsY, fitZoom, across: (bw * zoom) / availW, down: (bh * zoom) / availH };
}

/**
 * The whole picture in the window, whatever that does to the size of its words: `Show all anyway`, the owner's explicit
 * choice. fitView without the floor — still centred, still not magnified. It is never below hardMinZoom of the same
 * picture and window, so the graph library, which refuses a view below its minimum zoom, accepts it.
 */
export function wholeView(box, viewport, opts = {}) {
  return fitView(box, viewport, { ...opts, floor: 0 });
}

/**
 * How far the owner's own wheel and pinch go: ZOOM_HARD_MIN, or less when the whole picture needs less — never higher
 * than the zoom that shows all of it, so the whole of a large project can always be reached by hand. The constant when
 * there is no picture, or no window yet.
 */
export function hardMinZoom(box, viewport, { hardMin = ZOOM_HARD_MIN, pad = FIT_PAD, padTop = pad } = {}) {
  if (!box || !(viewport.w >= 2) || !(viewport.h >= 2)) return hardMin;
  const whole = wholeView(box, viewport, { pad, padTop }).fitZoom;
  return Number.isFinite(whole) && whole > 0 ? Math.min(hardMin, whole) : hardMin;
}

/**
 * The view a picture opens on: fitView of the box around `nodes`; null when there are none. One thing more when the
 * picture is too big both ways. What is centred over the whole picture — the product, the owner's words — then stands
 * far to the right of the columns the window starts on, and the window would open on empty rows above the first goals
 * and areas. Those rows are skipped: the view starts at the topmost object that stands (by half its width or more) over
 * the part of the picture the window shows across. Nothing is hidden; the rows above are one drag away.
 */
export function openingView(nodes, viewport, opts = {}) {
  const box = pictureBox(nodes);
  if (!box) return null;
  const v = fitView(box, viewport, opts);
  if (v.fitsX || v.fitsY) return v;
  const pad = opts.pad ?? FIT_PAD;
  const right = box.x1 + Math.max(1, viewport.w - 2 * pad) / v.zoom;
  const tops = nodes.filter((n) => Math.min(n.x + n.w / 2, right) - Math.max(n.x - n.w / 2, box.x1) >= n.w / 2).map((n) => n.y - n.h / 2 - (n.top ?? 0));
  if (tops.length) v.pan.y = (opts.padTop ?? pad) - Math.min(...tops) * v.zoom;
  return v;
}

/**
 * The owner's own view after the window changed size: their zoom and pan are kept. Only when that would leave less than
 * `keep` px of the picture in the window is the pan moved, by just enough to bring that much back.
 */
export function keepInView(box, viewport, zoom, pan, keep = KEEP_PX) {
  const axis = (lo, hi, size, p) => {
    const a = lo * zoom + p, b = hi * zoom + p;
    const need = Math.min(keep, b - a, size);
    if (b < need) return p + (need - b);
    if (a > size - need) return p - (a - (size - need));
    return p;
  };
  const x = axis(box.x1, box.x2, viewport.w, pan.x), y = axis(box.y1, box.y2, viewport.h, pan.y);
  return x === pan.x && y === pan.y ? pan : { x, y };
}

/** Whether a box of the picture is wholly inside the window under a view. */
export function inView(box, viewport, zoom, pan, margin = 0) {
  return box.x1 * zoom + pan.x >= margin && box.y1 * zoom + pan.y >= margin && box.x2 * zoom + pan.x <= viewport.w - margin && box.y2 * zoom + pan.y <= viewport.h - margin;
}

/** The pan that brings a box into the window by the shortest move, `margin` px from the edge; a box larger than the
 *  window shows its top left. The zoom is not touched. */
export function panToShow(box, viewport, zoom, pan, margin = 24) {
  const axis = (lo, hi, size, p) => {
    const a = lo * zoom + p, b = hi * zoom + p;
    if (a < margin || b - a > size - 2 * margin) return p + (margin - a);
    if (b > size - margin) return p - (b - (size - margin));
    return p;
  };
  return { x: axis(box.x1, box.x2, viewport.w, pan.x), y: axis(box.y1, box.y2, viewport.h, pan.y) };
}
