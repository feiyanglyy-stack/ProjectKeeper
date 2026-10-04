// The details popover (Spec §6.4; CKC-09 AC-34, AC-36): one floating window beside the object that was picked. It takes
// no column and moves nothing else. This module is only its mechanics — where it stands (popover-place.js), following
// its object while the graph pans, a list scrolls or the main view changes width, keyboard and focus, closing, and
// updating in place without a redraw when nothing changed. What is shown inside it comes from the caller.
import { placePopover } from './popover-place.js';

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * @param {{ bounds: () => {left:number,top:number,right:number,bottom:number}, sheet: () => boolean,
 *   normalize?: (html: string) => string, keepsOpen?: (target: Element) => boolean, onClose?: (why: string) => void,
 *   avoid?: () => Array<{left:number,top:number,right:number,bottom:number}> }} o
 *   `bounds` is the main view's visible area; `sheet` says the window is narrow, where the popover is an overlay along
 *   the bottom instead; `normalize` strips what changes without meaning (relative clocks) before two renderings are
 *   compared; `keepsOpen` names the places where a press does not count as "elsewhere" (the Keeper, used beside it);
 *   `avoid` names rectangles it keeps off when it can (the pill at the bottom right).
 */
export function createPopover({ bounds, sheet, normalize = (s) => s, keepsOpen = () => false, onClose = () => {}, avoid = () => [] }) {
  const content = document.createElement('div');
  content.className = 'popover-content';
  const el = document.createElement('section');
  el.className = 'popover';
  el.id = 'popover';
  el.hidden = true;
  el.tabIndex = -1;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Details');
  el.append(content);
  const scrim = document.createElement('div');
  scrim.className = 'popover-scrim';
  scrim.hidden = true;
  document.body.append(scrim, el);

  /** @type {null | { key: string, anchor: () => (object|null), opener: () => (Element|null), render: Function, sig: string|null, side: string|null, lastAnchor: object|null }} */
  let current = null;
  let pending = 0;
  let frame = 0;
  let natural = null;                       // its size with no limit applied, measured when the content changes
  let dismissed = { key: '', at: 0 };

  const focusables = () => [...el.querySelectorAll(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);
  const scroller = () => content.querySelector('.popover-body');

  function place({ measure = false } = {}) {
    if (!current || el.hidden) return;
    if (sheet()) {
      // Narrow window: an overlay along the bottom (Spec §6.15); the stylesheet places it.
      el.classList.add('sheet');
      scrim.hidden = false;
      for (const p of ['left', 'top', 'width', 'maxHeight']) el.style[p] = '';
      el.dataset.side = 'sheet';
      natural = null;
      return;
    }
    el.classList.remove('sheet');
    scrim.hidden = true;
    const area = bounds();
    const found = current.anchor();
    if (found) current.lastAnchor = found;
    // No object to stand beside (it is not on screen in any form): the top left of the main view.
    const anchor = current.lastAnchor ?? { left: area.left + 16, top: area.top + 16, right: area.left + 16, bottom: area.top + 16 };
    let scrollTop = null;
    if (measure || !natural) {
      // Lifting the height limit to measure would throw away how far its body is scrolled, so that is put back.
      scrollTop = scroller()?.scrollTop ?? 0;
      el.style.maxHeight = '';
      el.style.width = '';
      natural = { width: el.offsetWidth, height: el.offsetHeight };
    }
    const p = placePopover({ anchor, size: natural, bounds: area, keepSide: current.side, avoid: avoid() });
    current.side = p.side;
    el.style.left = `${p.left}px`;
    el.style.top = `${p.top}px`;
    el.style.width = p.width < natural.width ? `${p.width}px` : '';
    el.style.maxHeight = p.height < natural.height ? `${p.height}px` : '';
    el.dataset.side = p.side;
    if (scrollTop !== null && scroller()) scroller().scrollTop = scrollTop;
  }
  /** Follow the object: at most once a frame, however many pan, scroll and resize events arrive. */
  function reposition(opts) {
    if (!current) return;
    if (opts?.measure) natural = null;
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; place(); });
  }

  async function draw({ force = false, focus = false } = {}) {
    const mine = current;
    if (!mine) return;
    const token = ++pending;
    const mount = document.createElement('div');
    try { await mine.render(mount, api); }
    catch (e) { const box = document.createElement('div'); box.className = 'popover-body faint'; box.textContent = e.message; mount.replaceChildren(box); }
    if (token !== pending || current !== mine) return;
    const sig = normalize(mount.innerHTML);
    if (!force && sig === mine.sig) { reposition(); return; }   // nothing changed: nothing is redrawn
    mine.sig = sig;
    const hadFocus = el.contains(document.activeElement);
    const index = hadFocus ? focusables().indexOf(document.activeElement) : -1;
    const scrollTop = scroller()?.scrollTop ?? 0;
    content.replaceChildren(...mount.childNodes);
    el.hidden = false;
    place({ measure: true });
    if (scroller()) scroller().scrollTop = scrollTop;
    if (focus) el.focus({ preventScroll: true });
    else if (hadFocus) (focusables()[index] ?? el).focus({ preventScroll: true });
  }

  function close(why = 'close') {
    if (!current) return;
    const was = current;
    current = null;
    pending++;
    const hadFocus = el.contains(document.activeElement);
    el.hidden = true;
    scrim.hidden = true;
    content.replaceChildren();
    natural = null;
    // Focus goes back to where it was before the popover opened — unless the owner has already put it somewhere else
    // (a press on another control). A press on something that takes no focus leaves it on the page body; that is
    // settled a moment later, once the browser has finished with the press.
    const opener = () => { const to = was.opener(); return to?.isConnected ? to : null; };
    if (why === 'escape' || why === 'button') opener()?.focus({ preventScroll: true });
    else if (hadFocus) setTimeout(() => { if (!current && (document.activeElement === document.body || !document.activeElement)) opener()?.focus({ preventScroll: true }); }, 0);
    onClose(why);
  }

  const api = {
    el,
    isOpen: () => Boolean(current),
    key: () => current?.key ?? null,
    /**
     * Open beside an object, or move to another one. `anchor()` returns the object's rectangle now (null when it is
     * not on screen); `opener()` the element focus returns to; `render(mount, popover)` fills the content.
     * Picking the object whose popover the same press has just closed leaves it closed: that press put it away.
     */
    open({ key, anchor, opener, render, label = 'Details' }) {
      if (dismissed.key === key && performance.now() - dismissed.at < 700) { dismissed = { key: '', at: 0 }; return false; }
      const same = current?.key === key;
      current = { key, anchor, opener: opener ?? (() => null), render, sig: null, side: same ? current.side : null, lastAnchor: null };
      el.setAttribute('aria-label', label);
      if (!same) { el.hidden = true; content.replaceChildren(); natural = null; }
      void draw({ force: true, focus: true });
      return true;
    },
    /** Another page in the same popover (an object's note, and back): same place, same opener. */
    show({ key, render, label }) {
      if (!current) return;
      current = { ...current, key, render, sig: null };
      if (label) el.setAttribute('aria-label', label);
      void draw({ force: true, focus: true });
    },
    /** The assets changed: the content is fetched again and swapped only if it differs; the popover stays where it is. */
    refresh: (opts) => draw(opts),
    /** A new anchor for the same popover (the view was rebuilt around it, or it was sent to the graph). */
    reanchor(anchor) { if (current) { current.anchor = anchor; current.lastAnchor = null; current.side = null; reposition(); } },
    reposition,
    close,
    focus: () => el.focus({ preventScroll: true }),
  };

  // Escape closes it and hands focus back; Tab moves through its items and stays inside it. One Escape closes one
  // thing: a dialog on top of the popover takes it first, and the floating Keeper window does not also get it.
  document.addEventListener('keydown', (e) => {
    if (!current) return;
    if (e.key === 'Escape') {
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      e.stopPropagation();
      close('escape');
      return;
    }
    if (e.key !== 'Tab' || !el.contains(document.activeElement)) return;
    const items = focusables();
    if (!items.length) { e.preventDefault(); return; }
    const at = items.indexOf(document.activeElement);
    if (e.shiftKey && at <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
    else if (!e.shiftKey && at === items.length - 1) { e.preventDefault(); items[0].focus(); }
  }, true);

  // A press elsewhere closes it. The Keeper is not elsewhere (it is used beside the popover), nor is a dialog opened
  // from it, nor the graph's canvas, which says for itself what a tap means (another object, the background, a pan).
  document.addEventListener('pointerdown', (e) => {
    if (!current || !(e.target instanceof Element)) return;
    if (el.contains(e.target) || e.target.closest('dialog, #toast') || keepsOpen(e.target)) return;
    dismissed = { key: current.key, at: performance.now() };
    close('outside');
  }, true);
  scrim.addEventListener('click', () => close('outside'));

  // It follows its object: a scroll anywhere (the List, the rail, the bottom strip) and any change of the window.
  document.addEventListener('scroll', (e) => { if (current && !el.contains(e.target)) reposition(); }, true);
  addEventListener('resize', () => reposition({ measure: true }));
  // A fold opened inside it changes its height: measure again and check it still fits. (`toggle` does not bubble.)
  el.addEventListener('toggle', () => reposition({ measure: true }), true);

  return api;
}
