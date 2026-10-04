// A floating panel that belongs to one button of a view's control row: the `Filter` expansion and the panel behind the
// readability mark (Spec §6.3 "控件放在哪", "可读性自检 · 在哪里说"; CKC-09 AC-37). It floats — nothing under it is pushed
// down — and it lies wholly inside the main view's visible area, which is narrower while the Keeper is docked: where it
// goes is worked out by the same rule as the details popover (popover-place.js), under its button when there is room.
// Esc or a press elsewhere closes it and focus goes back to the button; Tab walks its items and stays inside it. One
// panel is open at a time. What is shown inside comes from the caller.
import { placePopover } from './popover-place.js';

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * @param {{ bounds: () => {left:number,top:number,right:number,bottom:number}, avoid?: () => Array<{left:number,top:number,right:number,bottom:number}> }} o
 *   `bounds` is the main view's visible area; `avoid` names rectangles not to lie on when that can be helped (the pill).
 */
export function createFlyout({ bounds, avoid = () => [] }) {
  const el = document.createElement('section');
  el.className = 'flyout';
  el.hidden = true;
  el.tabIndex = -1;
  el.setAttribute('role', 'dialog');
  document.body.append(el);

  /** @type {null | { button: HTMLElement, render: (api: object) => Array<Node|null>, className: string }} */
  let current = null;
  let frame = 0;
  let watch = null;
  const focusables = () => [...el.querySelectorAll(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);

  function place() {
    if (!current) return;
    if (!current.button.isConnected) { close(); return; }   // the row it belonged to was rebuilt
    const scrollTop = el.scrollTop;
    el.style.maxHeight = '';
    el.style.width = '';
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const r = current.button.getBoundingClientRect();
    const p = placePopover({ anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, size, bounds: bounds(), gap: 6, prefer: ['bottom', 'top', 'right', 'left'], avoid: avoid() });
    el.style.left = `${p.left}px`;
    el.style.top = `${p.top}px`;
    el.style.width = p.width < size.width ? `${p.width}px` : '';
    el.style.maxHeight = p.height < size.height ? `${p.height}px` : '';
    el.dataset.side = p.side;
    el.scrollTop = scrollTop;
  }
  function reposition() {
    if (!current || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; place(); });
  }
  function draw({ focus = false } = {}) {
    if (!current) return;
    const at = el.contains(document.activeElement) ? focusables().indexOf(document.activeElement) : -1;
    const nodes = current.render(api).flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);
    el.replaceChildren(...nodes);
    el.hidden = false;
    place();
    if (focus) (focusables()[0] ?? el).focus({ preventScroll: true });
    else if (at >= 0) (focusables()[at] ?? el).focus({ preventScroll: true });
  }
  function close({ focus = false } = {}) {
    if (!current) return;
    const was = current;
    current = null;
    watch?.disconnect();
    watch = null;
    el.hidden = true;
    el.replaceChildren();
    was.button.setAttribute('aria-expanded', 'false');
    if (focus && was.button.isConnected) was.button.focus({ preventScroll: true });
  }

  const api = {
    el,
    isOpen: (button) => Boolean(current) && (button === undefined || current.button === button),
    /** Open the panel of a button; pressed again while it is open, the button puts it away. */
    toggle({ button, label, render, className = '' }) {
      if (current?.button === button) { close({ focus: true }); return false; }
      close();
      current = { button, render, className };
      el.className = `flyout ${className}`.trim();
      el.setAttribute('aria-label', label);
      button.setAttribute('aria-expanded', 'true');
      // The main view changes width when the Keeper docks or is resized: the panel follows it.
      const main = document.getElementById('main');
      if (main && 'ResizeObserver' in window) { watch = new ResizeObserver(() => reposition()); watch.observe(main); }
      draw({ focus: true });
      return true;
    },
    /** What the panel shows changed (a filter was set, the check ran again): drawn again in place, focus where it was. */
    refresh(button) { if (current && (button === undefined || current.button === button)) draw(); },
    close,
    reposition,
  };

  // One Escape closes one thing: a dialog on top takes it first; otherwise this panel, and nothing else hears it.
  document.addEventListener('keydown', (e) => {
    if (!current) return;
    if (e.key === 'Escape') {
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      e.stopPropagation();
      close({ focus: true });
      return;
    }
    if (e.key !== 'Tab' || !el.contains(document.activeElement)) return;
    const items = focusables();
    if (!items.length) { e.preventDefault(); return; }
    const at = items.indexOf(document.activeElement);
    if (e.shiftKey && at <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
    else if (!e.shiftKey && at === items.length - 1) { e.preventDefault(); items[0].focus(); }
  }, true);
  // A press elsewhere closes it. A press on its own button is that button's business (it toggles).
  document.addEventListener('pointerdown', (e) => {
    if (!current || !(e.target instanceof Element)) return;
    if (el.contains(e.target) || current.button.contains(e.target) || e.target.closest('dialog, #toast')) return;
    close();
  }, true);
  addEventListener('resize', () => reposition());

  return api;
}
