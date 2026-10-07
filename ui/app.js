// ProjectKeeper workbench. Plain ES module, no build step. Fixed interface text is English
// and identical across projects (Spec §6.13); Keeper-written content comes from the assets.
import { views, hideDrawer, stripSheetOpen } from './views.js';
import { railMemory, escapeAction } from './shell-state.js';
import { openGlossary } from './glossary.js';
import { createPopover } from './popover.js';
import { createFlyout } from './flyout.js';
import { standBeside } from './popover-place.js';
import { createFolderChooser, locationLines, withLocation } from './folder-chooser.js';
import { initTheme, themePicker } from './theme.js';
import { updateCounts } from './k-process.js';
import { failuresOf, reasonText, shortRef, skippedOf, skippedText } from './failures.js';

// The system the page is shown on (the workbench is served to its own machine): for the examples and key names that differ.
const PLATFORM = navigator.userAgentData?.platform ?? navigator.platform ?? '';
const MAC = /mac|iphone|ipad/i.test(PLATFORM);
const WINDOWS = /win/i.test(PLATFORM);

const $ = (sel, root = document) => root.querySelector(sel);
export const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
};
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
// DOM append() turns null into the text "null"; this one skips empty children.
export const append = (el, ...nodes) => { for (const n of nodes.flat(Infinity)) if (n !== null && n !== undefined && n !== false) el.append(n); return el; };
export const fmtTime = (iso) => { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { hour12: false }); };
export const fmtRel = (iso) => { if (!iso) return '—'; const ms = Date.now() - new Date(iso).getTime(); const m = Math.round(ms / 60000); if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`; const hrs = Math.round(m / 60); if (hrs < 48) return `${hrs} h ago`; return `${Math.round(hrs / 24)} d ago`; };
// Relative clocks change every minute; comparing outerHTML with them made the strip and pill swap for no asset change.
export const visHtml = (s) => String(s ?? '').replace(/\bjust now\b|\b\d+ min ago\b|\b\d+ h ago\b|\b\d+ d ago\b/g, '#rel#');

export async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data;
}

export function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2800);
}

/**
 * The one dialog. Opened from inside itself (a source or a fact record from the full details, one object's details
 * from another's) the new content goes on top and the one underneath is kept as it was — its scroll position, its
 * open folds, its listeners — so `Back` and Escape return to it instead of dropping the owner out of what they were
 * reading; `Close` closes the lot. Focus returns to where it was before the first one opened.
 */
const dialogUnder = [];   // the layers under the one showing, oldest first
let dialogTop = null;     // { onClose, opener }
export function openDialog(title, bodyNodes, { onClose } = {}) {
  const dialog = $('#dialog');
  const stacked = dialog.open && dialogTop !== null;
  if (stacked) {
    dialogUnder.push({ ...dialogTop, nodes: [...dialog.childNodes], className: dialog.className, scrollTop: dialog.querySelector('.dialog-body')?.scrollTop ?? 0, focus: document.activeElement, rerender: dialog._rerender ?? null, details: dialog._details ?? null });
    dialog.replaceChildren();   // detached, not destroyed: they go back as they are
  } else {
    dialogUnder.length = 0;
    clear(dialog);
  }
  dialog.className = '';
  dialog._rerender = null;
  dialog._details = null;
  dialogTop = { onClose, opener: stacked ? dialogUnder[0].opener : document.activeElement };
  dialog.append(
    h('div', { class: 'dialog-head' },
      stacked ? h('button', { class: 'btn small', title: 'Back to what was open before', onClick: closeDialogLayer }, '‹ Back') : null,
      h('h2', { id: 'dialog-title' }, title),
      h('button', { class: 'btn small', onClick: () => dialog.close() }, 'Close')),
    h('div', { class: 'dialog-body' }, ...bodyNodes),
  );
  dialog.onclose = () => {
    const opener = dialogTop?.opener ?? null;
    dialogTop?.onClose?.();
    while (dialogUnder.length) dialogUnder.pop().onClose?.();
    dialogTop = null;
    dialog._rerender = null;
    dialog._details = null;
    if (opener?.isConnected && opener.focus) opener.focus();
    else if (popover.isOpen()) popover.focus();
  };
  dialog.oncancel = (e) => { if (dialogUnder.length) { e.preventDefault(); closeDialogLayer(); } };
  dialog.onclick = (e) => { if (e.target === dialog) closeDialogLayer(); };
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('.dialog-body').scrollTop = 0;
  return dialog;
}
/** Close what is showing: back to the layer under it, or, when it is the only one, close the dialog. */
export function closeDialogLayer() {
  const dialog = $('#dialog');
  if (!dialogUnder.length) { if (dialog.open) dialog.close(); return; }
  dialogTop?.onClose?.();
  const under = dialogUnder.pop();
  dialog.replaceChildren(...under.nodes);
  dialog.className = under.className;
  dialog._rerender = under.rerender;
  dialog._details = under.details;
  dialogTop = { onClose: under.onClose, opener: under.opener };
  const body = dialog.querySelector('.dialog-body');
  if (body) body.scrollTop = under.scrollTop;
  if (under.focus?.isConnected) under.focus.focus({ preventScroll: true });
  void dialog._details?.refresh();
}

const VIEWS = [
  ['graph', 'Project graph'], ['notes', 'Notes log'], ['changes', 'Change log'],
  ['context', 'Agent context'], ['scope', 'Project scope'], ['keeper', 'Keeper'],
];
/** Each view's icon, what the folded rail keeps (Spec §6.1: 只留视图的图标). Strokes in the current colour. */
const VIEW_ICON = {
  graph: "<circle cx='5' cy='6' r='2.2'/><circle cx='15' cy='5' r='2.2'/><circle cx='10' cy='15' r='2.2'/><path d='M7 6.5l6-1M6.2 8l2.8 5M13.9 7l-2.8 6'/>",
  notes: "<rect x='4' y='3' width='12' height='14' rx='2'/><path d='M7 7.5h6M7 10.5h6M7 13.5h3.5'/>",
  changes: "<circle cx='10' cy='10' r='6.5'/><path d='M10 6.5V10l2.5 2'/>",
  context: "<path d='M3.5 6.5L10 3l6.5 3.5v7L10 17l-6.5-3.5z'/><path d='M3.5 6.5L10 10l6.5-3.5M10 10v7'/>",
  scope: "<circle cx='10' cy='10' r='6.5'/><circle cx='10' cy='10' r='3'/><path d='M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3'/>",
  keeper: "<rect x='4' y='7' width='12' height='9' rx='2.5'/><path d='M10 4v3M7.8 11h.01M12.2 11h.01M8 13.8h4'/>",
};
// Parsed as markup, so the icon is an SVG element (document.createElement('svg') would make an unknown HTML one).
const viewIcon = (id) => h('span', { class: 'nav-icon', 'aria-hidden': 'true', html: `<svg viewBox='0 0 20 20'>${VIEW_ICON[id] ?? ''}</svg>` });

export const state = {
  workspace: null, projectId: null, project: null, view: 'graph', selection: null, // {kind, id}
  keeperOpen: false, keeperContext: null, conversationId: null, filters: {}, scale: 'Overview', lastVisit: null, counts: {},
};

function parseHash() {
  const m = /^#\/p\/([^/]+)(?:\/([a-z]+))?(?:\/(.*))?$/.exec(location.hash);
  if (!m) return { projectId: null, view: 'graph', rest: '' };
  return { projectId: decodeURIComponent(m[1]), view: m[2] || 'graph', rest: m[3] || '' };
}
export function navigate(projectId, view, rest = '') {
  location.hash = `#/p/${encodeURIComponent(projectId)}/${view}${rest ? '/' + rest : ''}`;
}
/**
 * Pick an object (or, with null, nothing). Every way of pointing at one comes through here: the graph, the List, the
 * outline, search, the bottom strip, a link. The view marks it without rebuilding itself, and its details open in the
 * popover beside it (Spec §6.4). `origin: 'graph'` is a tap on the graph itself: the graph stays where it is, and a
 * second tap on the same object puts the popover away. `popover: false` only marks the selection.
 */
export function select(selection, opts = {}) {
  state.selection = selection;
  const crumb = $('#focus-crumb');
  if (crumb) { crumb.textContent = focusLabel(); crumb.title = focusLabel(); }
  views[state.view]?.onSelect?.(selection, state, opts);
  markOutline();
  if (!selection) { popover.close('deselect'); return; }
  if (opts.popover === false) return;
  if (opts.origin === 'graph' && popover.key() === selectionKey(selection)) { popover.close('toggle'); return; }
  showDetails(selection, opts);
}
const selectionKey = (s) => `${s.kind}:${s.id}`;

// ── details popover ───────────────────────────────────────────────────────
const NARROW = matchMedia('(max-width: 700px)');
const rectOf = (el) => { const r = el.getBoundingClientRect(); return r.width || r.height ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null; };
/** The main view's visible area: what the docked Keeper leaves of it (Spec §6.4), inside the window. */
function mainArea() {
  const main = $('#main');
  const r = main ? main.getBoundingClientRect() : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const area = { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(innerWidth, r.right), bottom: Math.min(innerHeight, r.bottom) };
  const keeper = document.getElementById('keeper');
  if (keeper?.classList.contains('open') && keeper.classList.contains('docked')) area.right = Math.min(area.right, keeper.getBoundingClientRect().left);
  return area;
}
/** The pill at the bottom right, as a rectangle floating surfaces keep off when they can (Spec §6.1). */
function pillRects() {
  const r = document.querySelector('#keeper-dock .dock-pill')?.getBoundingClientRect();
  return r && (r.width || r.height) ? [{ left: r.left, top: r.top, right: r.right, bottom: r.bottom }] : [];
}
export const popover = createPopover({
  bounds: mainArea,
  sheet: () => NARROW.matches,
  normalize: visHtml,
  // The Keeper is used beside the popover, so a press in it, on its pill or on `Ask Keeper` is not "elsewhere"; the
  // graph's canvas says for itself what a tap means (another object, the background, or the start of a pan).
  keepsOpen: (target) => Boolean(target.closest('#keeper, #keeper-dock, [data-keeps-popover], #cy')),
  avoid: pillRects,
  // Closing the popover takes the graph's mark away with it (a blank click and another selection do too).
  onClose: () => { views.graph.clearMarks?.(); },
});
/** The panels of a view's control row — `Filter`, the readability mark — float inside the same area (Spec §6.3). */
export const flyout = createFlyout({ bounds: mainArea, avoid: pillRects });

/**
 * The object as it is shown in the main view, when it is: a List cell, a note's row or card. `place` narrows it to one
 * list (see `placeIn`): the same note can have a row in two columns of the bottom strip.
 */
function shownInMain(selection, place = null) {
  const main = $('#main');
  if (!main || !selection) return null;
  const id = CSS.escape(selection.id);
  const found = selection.kind === 'note' ? main.querySelectorAll(`[data-note="${id}"]`) : main.querySelectorAll(`button[data-node="${id}"], [data-node="${id}"]`);
  return [...found].find((el) => el.getClientRects().length > 0 && (place === null || placeIn(el) === place)) ?? null;
}
/** Which list of the main view an element is in, told by where that list is: a rebuilt list is made of new elements. */
function placeIn(el) {
  const list = el.closest('section, table');
  const among = list?.parentElement;
  return among ? `${among.classList[0] ?? among.tagName} ${list.tagName} ${[...among.children].indexOf(list)}` : '';
}
/**
 * What the popover stands beside, asked again every time it is placed: the object on the graph when it is drawn
 * there; else the thing that was pressed, when that is in the main view (a List cell, a row of the bottom strip, a
 * card, a link); else the object wherever the main view shows it; else, on the graph, what the object hangs on (the
 * ends of a relation that is not drawn, the objects a note is mounted on — `hints`, filled in once its details are
 * read); else the thing pressed outside the main view (an outline row, a link in the conversation). Nothing on screen
 * at all: null, and the popover takes the main view's corner.
 *
 * When what it stood beside goes away (an answered note leaves Notes (attention), a filter hides the node), the answer
 * is null as well and the popover stays where it is: it moves up this list when the owner brings the object itself on
 * screen, never down it to something lesser because the assets changed, and never across to the object's row in
 * another list.
 */
function anchorFor(selection, trigger, hints, { toGraph = false } = {}) {
  const inMain = (el) => Boolean(el?.isConnected && $('#main')?.contains(el));
  const onGraph = () => views.graph.anchorRect?.(selection) ?? null;
  let place = null;
  const inView = () => {
    const shown = inMain(trigger) ? trigger : shownInMain(selection, place);
    if (!shown) return null;
    place = placeIn(shown);
    return rectOf(shown);
  };
  const hangsOn = () => views.graph.hintRect?.(hints) ?? null;
  const outside = () => (trigger?.isConnected && !trigger.closest('dialog') ? rectOf(trigger) : null);
  // `Show on graph` names the objects to stand beside: they come before the row the note was picked from.
  return standBeside(toGraph ? [onGraph, hangsOn, inView, outside] : [onGraph, inView, hangsOn, outside]);
}
/** Where focus returns: the element itself, or — a rebuilt list replaced it — the one standing for the same object. */
function openerFor(trigger) {
  if (!trigger) return () => null;
  const host = trigger.closest('[id]')?.id ?? null;
  const attr = trigger.dataset?.node ? ['node', trigger.dataset.node] : trigger.dataset?.note ? ['note', trigger.dataset.note] : null;
  return () => (trigger.isConnected ? trigger : host && attr ? document.getElementById(host)?.querySelector(`[data-${attr[0]}="${CSS.escape(attr[1])}"]`) ?? null : null);
}
function showDetails(selection, { trigger, anchorIds } = {}) {
  const active = document.activeElement;
  const from = trigger !== undefined ? trigger : active && active !== document.body && !popover.el.contains(active) ? active : null;
  const hints = [...(anchorIds ?? [])];
  popover.open({
    key: selectionKey(selection), label: `Details: ${selection.label ?? selection.id}`,
    anchor: anchorFor(selection, from, hints, { toGraph: hints.length > 0 }), opener: openerFor(from),
    render: (mount, p) => views.details.popover(mount, selection, p, { hints }),
  });
}
/** The view under the popover was rebuilt, or the assets changed: same popover, same place, content only if it differs. */
export function refreshDetails() {
  void popover.refresh();
  void $('#dialog')?._details?.refresh();
}

async function loadWorkspace() {
  state.workspace = await api('/api/workspace');
}

async function loadProject(id) {
  state.project = await api(`/api/projects/${encodeURIComponent(id)}`);
  state.counts = state.project.counts || {};
}

export async function refreshProject() {
  if (!state.projectId) return;
  await loadProject(state.projectId);
  patchCoveragePill();
  patchNavCounts();
  void updateCounts();
  await renderBody();
  renderOutline();
}

// ── chrome ────────────────────────────────────────────────────────────────
/**
 * The workbench is a set of floating panels with gaps between them, all made from one card (Spec §6.1, §6.16; D100;
 * CKC-09 AC-45): the top bar; the left rail, which folds to a strip of view icons (AC-43); the main panel, where Graph,
 * List and Code switch, whose header carries the view's one row of controls and the button that makes it fill the
 * window (AC-44); the drawer under it, one line until it is pulled up (AC-38, views.js); and the Keeper conversation,
 * docked on the right as a panel of its own (§6.8). The pill at the bottom right stands beside the drawer.
 */
function renderChrome() {
  const app = $('#app');
  clear(app);
  const ws = state.workspace;
  const projects = ws?.projects ?? [];
  const p = state.project;
  const rail = h('aside', { class: 'rail panel', id: 'rail', 'aria-label': 'Project and views' },
    h('div', { class: 'rail-head' },
      h('span', { class: 'rail-section rail-full' }, 'Workspace'),
      h('button', { class: 'rail-fold', id: 'rail-fold', 'data-keeps-popover': true, onClick: () => setRailFolded(!railFolded()) })),
    h('div', { class: 'project-picker rail-full' },
      h('select', { class: 'input', 'aria-label': 'Project', onChange: (e) => { if (e.target.value) navigate(e.target.value, state.view); } },
        h('option', { value: '' }, projects.length ? 'Choose a project' : 'No projects yet'),
        ...projects.map((x) => h('option', { value: x.id, selected: x.id === state.projectId }, x.name))),
      h('button', { class: 'btn small', title: 'Add project', onClick: addProjectDialog }, '+')),
    // The views first, under the project (owner 2026-09-30: from Project scope there was no way back to the graph in
    // sight — the views sat under the long Project structure). They keep their icons when the rail is folded; the name
    // is then in the hover (and read out). The structure below scrolls by itself, so the views stay at the top.
    p ? h('div', { class: 'rail-section rail-full' }, 'Views') : null,
    p ? h('nav', { class: 'views', 'aria-label': 'Views' }, ...VIEWS.map(([id, label]) => h('button', { class: `nav-item${state.view === id ? ' active' : ''}`, 'data-view': id, title: label, 'aria-label': label, onClick: () => navigate(p.id, id) }, viewIcon(id), h('span', { class: 'nav-label' }, label), countFor(id) !== null ? h('span', { class: 'count' }, countFor(id)) : null))) : null,
    p ? h('div', { class: 'rail-section outline-head rail-full' }, h('span', {}, 'Project structure'),
      h('span', { class: 'outline-modes' },
        h('button', { class: outlineMode() === 'all' ? 'active' : '', title: 'Everything in the project, finished or not', onClick: () => setOutlineMode('all') }, 'All'),
        h('button', { class: outlineMode() === 'todo' ? 'active' : '', title: 'Only the work that is still open', onClick: () => setOutlineMode('todo') }, 'To do'))) : null,
    p ? h('div', { class: 'outline rail-full', id: 'outline' }) : null,
    h('div', { class: 'rail-foot' }, p ? keeperEntry() : null),
  );
  const topbar = h('div', { class: 'topbar panel' },
    h('div', { class: 'topbar-main' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true', html: "<svg viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='var(--pk-raised,#23211d)'/><path d='M23 8H12l-5 8 5 8h11M14 8v16M7 16h16' fill='none' stroke='currentColor' stroke-width='2'/></svg>" }), h('span', { class: 'brand-name' }, 'ProjectKeeper')),
      h('div', { class: 'crumb' }, p ? [h('strong', { title: p.name }, p.name), h('span', { class: 'sep' }, '·'), h('span', { id: 'focus-crumb', title: focusLabel() }, focusLabel())] : h('strong', {}, 'No project open'))),
    h('div', { class: 'top-actions' },
      p ? coveragePill() : null,
      p ? failedButton() : null,
      // The breakpoints still lit and send-backs still open, beside the coverage (Spec §6.2, §2.12; CKC-24 AC-7).
      // k-process fills it once the process view has answered; nothing shows while that endpoint is not built.
      p ? h('span', { id: 'k-bp-count' }) : null,
      p ? h('button', { class: 'btn small', title: 'What the categories, relations and status words mean, and how the Keeper obtains them', onClick: () => openGlossary() }, 'Vocabulary') : null,
      p ? h('button', { class: 'btn small', 'data-keeps-popover': true, title: 'Open the conversation with the Keeper on the right, about what is selected', onClick: () => toggleKeeper(true) }, 'Ask Keeper') : null,
      // The theme, beside the search (WorkflowKeeper keeps its picker in the top bar): a choice of this browser (Spec §6.16).
      themePicker(),
      p ? h('button', { class: 'search-trigger', onClick: openSearch }, h('span', {}, 'Search'), h('kbd', {}, MAC ? '⌘K' : 'Ctrl K')) : null),
  );
  // The main panel: its header carries the view's own row of controls (or the view's name) and the button that makes
  // it fill the window; below, the view alone — an object's details open in the popover beside it (Spec §6.1).
  const maxBtn = h('button', { class: 'panel-max', id: 'panel-max', 'data-keeps-popover': true, onClick: () => setMaximised(!maximised()) });
  const mainPanel = h('section', { class: 'main-panel panel', id: 'main-panel', 'aria-label': 'Main view' },
    h('div', { class: 'panel-head' },
      p ? h('div', { class: 'top-view-tools', id: 'top-view-tools', hidden: true }) : null,
      h('span', { class: 'panel-title', id: 'panel-title' }, p ? viewLabel(state.view) : ''),
      maxBtn),
    h('div', { class: 'body', id: 'body' }, h('main', { id: 'main' })));
  // The drawer: views.js fills it under the Project graph, and it keeps the band beside the pill everywhere else.
  const drawer = h('section', { class: 'drawer panel empty', id: 'drawer', 'aria-label': 'Notes and recent changes' });
  const mobileNav = p ? h('div', { class: 'mobile-nav' }, ...VIEWS.map(([id, label]) => h('button', { class: state.view === id ? 'active' : '', 'data-view': id, onClick: () => navigate(p.id, id) }, label))) : null;
  append(app, topbar, mobileNav, rail, mainPanel, drawer);
  if (p) app.append(keeperDock());
  applyRailFold();
  applyMaximised();
  popover.close('rebuild');
  watchLayout(topbar, mainPanel.querySelector('main'));
  syncPillWidth();
  renderBody();
  renderOutline();
  renderKeeper();
  void updateCounts();
}
const viewLabel = (id) => VIEWS.find(([v]) => v === id)?.[1] ?? '';

/**
 * The view's own row of controls, in the main panel's header (Spec §6.1 "每个视图自己的控件在它顶上一行"; D68): the
 * Graph/List/Code controls there, and the view's name when a view has none.
 */
export function setTopTools(tools = null) {
  const mount = $('#top-view-tools');
  const title = $('#panel-title');
  if (title) { title.textContent = viewLabel(state.view); title.hidden = Boolean(tools); }
  if (!mount) return;
  clear(mount);
  if (tools) mount.append(tools);
  mount.hidden = !tools;
}

/**
 * Sizes the stylesheet cannot know: where the top bar ends (the docked Keeper starts under it), and how wide the pill is
 * (the drawer stops short of it). The popover follows the main view when its size changes.
 */
let layoutWatch = null;
function watchLayout(topbar, main) {
  layoutWatch?.disconnect();
  if (!('ResizeObserver' in window)) return;
  layoutWatch = new ResizeObserver(() => {
    document.documentElement.style.setProperty('--pk-top', `${Math.round(topbar.getBoundingClientRect().bottom)}px`);
    popover.reposition({ measure: true });
    flyout.reposition?.();
  });
  layoutWatch.observe(topbar);
  layoutWatch.observe(main);
}
function syncPillWidth() {
  const pill = document.querySelector('#keeper-dock .dock-pill');
  if (pill?.offsetWidth) document.documentElement.style.setProperty('--pk-pill-w', `${Math.ceil(pill.offsetWidth)}px`);
}

// ── the rail folds, the main panel fills the window (Spec §6.1; D100; CKC-09 AC-43, AC-44) ──────────────────
/** Folded or not is this browser's (shell-state.js): remembered like the theme, never in the project's assets. */
const railPref = railMemory((() => { try { return window.localStorage; } catch { return null; } })());
const railFolded = () => railPref.folded();
function setRailFolded(folded) {
  railPref.setFolded(folded);
  applyRailFold();
  popover.reposition({ measure: true });
}
function applyRailFold() {
  const folded = railFolded();
  document.body.classList.toggle('rail-folded', folded);
  const btn = $('#rail-fold');
  if (!btn) return;
  btn.textContent = folded ? '»' : '«';
  btn.title = folded ? 'Unfold the left rail' : 'Fold the left rail to a strip of view icons';
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-expanded', String(!folded));
  btn.setAttribute('aria-controls', 'rail');
}

/**
 * The main panel fills the window, and the same button — or Escape — puts it back. The top bar, the rail and the drawer
 * step aside; the view's controls, the popover, the ❓ marks and the pill stay, and the Keeper still docks on the right
 * with the panel giving way (Spec §6.1, U73). The view is the same element throughout, so the selection, what is open
 * and where it is scrolled stay as they were. Not remembered: a reload opens the whole workbench.
 */
let isMaximised = false;
const maximised = () => isMaximised;
export function setMaximised(on) {
  isMaximised = Boolean(on);
  applyMaximised();
  popover.reposition({ measure: true });
  flyout.reposition?.();
}
function applyMaximised() {
  document.body.classList.toggle('maximised', isMaximised);
  const btn = $('#panel-max');
  if (!btn) return;
  // The expand mark of the Claude desktop app the owner pointed at: four corners out, or in to restore.
  btn.innerHTML = isMaximised
    ? "<svg viewBox='0 0 20 20' aria-hidden='true'><path d='M8 3v5H3M12 3v5h5M8 17v-5H3M12 17v-5h5'/></svg>"
    : "<svg viewBox='0 0 20 20' aria-hidden='true'><path d='M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5'/></svg>";
  btn.title = isMaximised ? 'Restore the workbench (Esc)' : 'Fill the window with this panel';
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-pressed', String(isMaximised));
}

function countFor(view) {
  const c = state.counts || {};
  if (view === 'notes') return c.notes ?? null;
  if (view === 'changes') return c.changes ?? null;
  if (view === 'scope') return c.sources ?? null;
  return null;
}

function focusLabel() {
  const s = state.selection;
  if (!s) return 'Whole project';
  return s.label || `${s.kind} ${s.id}`;
}

/** A project not organized yet — just added, or cleared — has no counts to show (Spec §6.14; D105): the pill says so and opens the Takeover page. */
const notOrganized = () => state.project?.coverage?.state === 'Not organized yet';
function notOrganizedPill() {
  return h('button', { class: 'coverage-pill', title: 'Nothing runs until you choose a depth and press Start · opens the Takeover page', onClick: () => navigate(state.projectId, 'keeper', 'takeover') }, h('span', { class: 'tag amber' }, 'Not organized yet'));
}

function coveragePill() {
  if (notOrganized()) return notOrganizedPill();
  const cov = state.project?.coverage;
  const scope = cov?.scopes?.find((s) => s.id === 'project') || cov?.scopes?.[0];
  const pending = (cov?.scopes ?? []).reduce((n, s) => n + s.pending.length, 0);
  const organizing = (cov?.scopes ?? []).reduce((n, s) => n + s.organizing.length, 0);
  const fu = state.counts?.followUp?.objects ?? state.counts?.followUp?.entries ?? 0;
  const fuEntries = state.counts?.followUp?.entries ?? 0;
  const parts = [
    h('span', {}, 'As of ', h('b', {}, scope?.asOf ? fmtRel(scope.asOf) : '—')),
    h('span', {}, h('b', {}, organizing), ' organizing'),
    h('span', {}, h('b', {}, pending), ' pending'),
    fu ?h('span', { title: `Change follow-up: ${fu} object${fu === 1 ? '' : 's'} not yet judged against ${fuEntries} change entr${fuEntries === 1 ? 'y' : 'ies'} (one per change that reached it)` }, h('b', {}, fu), ' to follow up') : null,
    h('span', { class: `tag ${scope?.coverage === 'Up to date' ? 'green' : 'amber'}` }, scope?.coverage ?? 'Changes pending'),
  ];
  // A Follow up round that found nothing new says so here and nowhere else (Spec §3.8, §6.2; CKC-07 AC-27, CKC-24
  // AC-15); one that found something has its item in `Notes (attention)`. The sentence is a line of its own under the
  // counts, so the pill grows a line rather than pushing the top bar's buttons onto another row.
  const last = cov?.lastFollowUp?.nothingNew ? cov.lastFollowUp : null;
  return h('button', { class: `coverage-pill${last ? ' with-last' : ''}`, title: 'Coverage · opens Project scope', onClick: () => navigate(state.projectId, 'scope', 'coverage') },
    last ? [h('span', { class: 'cov-parts' }, ...parts), h('span', { class: 'cov-last-round', title: `Follow up round ${last.round} ended ${fmtTime(last.endedAt)}` }, last.statement)] : parts);
}

/**
 * What intake could not take in, beside the coverage pill (CKC-07 AC-10): the count of distinct files, which opens their
 * list with the reasons (owner 2026-09-30: "2 failed" opened nothing, and it was one file recorded twice). A button of
 * its own, not a part of the pill, so pressing it does not go to Project scope. It counts what went wrong and stayed
 * undone; a file too large to read is skipped, not failed — not counted here and not red (D105), listed in Project scope
 * (`skippedBlock`).
 */
function failedButton() {
  const list = failuresOf(state.project?.coverage);
  return h('button', { class: 'tag red cov-failed', id: 'cov-failed', hidden: list.length === 0, title: 'What could not be taken in, and why', onClick: openFailed }, `${list.length} failed`);
}

function openFailed() {
  const list = failuresOf(state.project?.coverage);
  const locations = state.project?.locations ?? [];
  const body = h('div', { class: 'stack failed-list' },
    h('p', { class: 'muted' }, list.length
      ? `Intake did not take ${list.length === 1 ? 'this file' : `these ${list.length} files`} in, so the Keeper has not read ${list.length === 1 ? 'it' : 'them'}. Each is tried again when it changes; the latest attempt is shown.`
      : 'Everything in scope was taken in.'),
    ...list.map((f) => h('div', { class: 'failed-item' },
      h('div', { class: 'row wrap' }, h('b', { class: 'mono' }, shortRef(f.ref, locations)), h('small', { class: 'faint', title: fmtTime(f.at) }, fmtRel(f.at))),
      h('div', {}, reasonText(f.reason)),
      h('div', { class: 'faint mono' }, f.ref, f.scope && list.some((x) => x.scope !== f.scope) ? ` · ${f.scope}` : ''))),
    h('div', { class: 'row wrap' }, h('button', { class: 'btn small', title: 'Coverage and what waits, in Project scope', onClick: () => { $('#dialog')?.close(); navigate(state.projectId, 'scope', 'coverage'); } }, 'Coverage in Project scope')));
  openDialog(`Could not be taken in (${list.length})`, [body]);
}

/**
 * `Skipped: too large` in Project scope's coverage (Spec §6.7, D105; CKC-04 AC-18): each file over the size intake reads
 * of one file, with its path, its size and the limit — apart from the failures, in no colour of an error. The owner can
 * leave one out of the scope from its row. Mounted after the scope view has drawn its coverage section.
 */
function skippedBlock() {
  const scope = state.project?.scope ?? [];
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const leftOut = scope.filter((i) => i.relation === 'Excluded').map((i) => norm(i.path));
  const list = skippedOf(state.project?.coverage).filter((f) => !leftOut.some((root) => norm(f.ref) === root || norm(f.ref).startsWith(`${root}/`)));
  if (list.length === 0) return null;
  const locations = state.project?.locations ?? [];
  const exclude = async (f) => {
    try {
      await api(`/api/projects/${state.projectId}/scope/items`, { method: 'POST', body: { path: f.ref, category: 'Directory', relation: 'Excluded', reason: `Too large to read (${skippedText(f)}); left out by the owner` } });
      toast('Left out of the scope');
      await refreshProject();
    } catch (e) { toast(e.message); }
  };
  return h('div', { class: 'stack skipped-list', id: 'cov-skipped' },
    h('h4', {}, `Skipped: too large (${list.length})`),
    h('div', { class: 'faint' }, `${list.length === 1 ? 'This file is' : 'These files are'} over the size intake reads of one file, so ${list.length === 1 ? 'its text is' : 'their text is'} not read. That is not a failure and nothing waits on it: the ledger still records the path, the size and the versions.`),
    ...list.map((f) => h('div', { class: 'row wrap skipped-item' },
      h('span', { class: 'mono', title: f.ref }, shortRef(f.ref, locations)),
      h('small', {}, skippedText(f)),
      h('small', { class: 'faint', title: fmtTime(f.at) }, fmtRel(f.at)),
      h('button', { class: 'btn small', title: 'Leave this file out of the scope: it is no longer listed here', onClick: () => exclude(f) }, 'Exclude from scope'))));
}

function mountSkipped(main) {
  const host = main.querySelector('#coverage .content');
  const block = host ? skippedBlock() : null;
  if (!block) return;
  const table = host.querySelector(':scope > table');
  if (table) table.after(block); else host.prepend(block);
}

function patchCoveragePill() {
  if (!state.project) return;
  const failed = $('#cov-failed');
  const nextFailed = failedButton();
  if (failed && visHtml(failed.outerHTML) !== visHtml(nextFailed.outerHTML)) failed.replaceWith(nextFailed);
  const pill = $('.coverage-pill');
  const next = coveragePill();
  if (!pill) { $('.top-actions')?.prepend(next); if (!failed) next.after(nextFailed); return; }
  if (visHtml(pill.outerHTML) === visHtml(next.outerHTML)) {
    const asOf = pill.querySelector(':scope > span:first-child b');
    const nextAsOf = next.querySelector(':scope > span:first-child b');
    if (asOf && nextAsOf) asOf.textContent = nextAsOf.textContent;
    return;
  }
  pill.replaceWith(next);
}

function patchNavCounts() {
  document.querySelectorAll('nav.views .nav-item').forEach((btn) => {
    const id = btn.dataset.view;
    if (!id) return;
    const n = countFor(id);
    let span = btn.querySelector('.count');
    if (n === null) { span?.remove(); return; }
    if (!span) btn.append(h('span', { class: 'count' }, n));
    else span.textContent = n;
  });
}

function patchNavActive() {
  document.querySelectorAll('nav.views .nav-item, .mobile-nav button').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === state.view));
  const title = $('#panel-title');
  if (title) title.textContent = viewLabel(state.view);
}

async function patchProjectPicker() {
  await loadWorkspace();
  const sel = $('.project-picker select');
  if (!sel) { if ($('#app')) renderChrome(); return; }
  const projects = state.workspace?.projects ?? [];
  const nextIds = projects.map((x) => x.id);
  if (state.projectId && !nextIds.includes(state.projectId)) { renderChrome(); return; }
  const current = [...sel.options].map((o) => `${o.value}\0${o.textContent}`).join('|');
  const next = ['\0' + (projects.length ? 'Choose a project' : 'No projects yet'), ...projects.map((x) => `${x.id}\0${x.name}`)].join('|');
  if (current === next && sel.value === (state.projectId ?? '')) return;
  const val = state.projectId ?? '';
  clear(sel);
  sel.append(h('option', { value: '' }, projects.length ? 'Choose a project' : 'No projects yet'),
    ...projects.map((x) => h('option', { value: x.id, selected: x.id === val }, x.name)));
  sel.value = val;
}

/**
 * What the rail lists: everything the project has, or only the work that is still open. The rail used to show the
 * open work alone, which made a finished area look empty beside the List (owner 2026-09-17: make it obvious which
 * of the two you are looking at). The choice is a per-viewer convenience, so it lives in this browser.
 */
const OUTLINE_KEY = 'pk.outline.mode';
// When this browser has no storage, the choice still applies on this page.
let outlineMemory = null;
function outlineMode() {
  try {
    const v = localStorage.getItem(OUTLINE_KEY);
    if (v === 'all' || v === 'todo') return v;
  } catch { /* no storage: the in-memory choice below */ }
  return outlineMemory === 'all' || outlineMemory === 'todo' ? outlineMemory : 'todo';
}
function setOutlineMode(mode) {
  outlineMemory = mode;
  try { localStorage.setItem(OUTLINE_KEY, mode); } catch { /* remembered on this page only */ }
  const modes = document.querySelector('.outline-modes');
  if (modes) for (const b of modes.querySelectorAll('button')) b.classList.toggle('active', (mode === 'all' && b.textContent === 'All') || (mode === 'todo' && b.textContent === 'To do'));
  renderOutline();
}

export let activity = { status: 'Not connected', reason: '', jobs: [] };
export async function refreshActivity() {
  if (!state.projectId) return;
  try { activity = await api(`/api/projects/${encodeURIComponent(state.projectId)}/activity`); } catch { /* keep old */ }
  if (!state.project) return;
  paintDock();
  views.conversation.sync?.();
  const entry = $('#keeper-entry');
  const nextEntry = keeperEntry();
  if (entry && entry.outerHTML !== nextEntry.outerHTML) entry.replaceWith(nextEntry);
}

/**
 * The Keeper's status at the foot of the rail: what it is doing, in its own words, where the owner has been reading
 * it (owner, 2026-09-17: "左边原来的 pi 的状态栏恢复一下"). It lists the jobs running now, as it always did; the
 * rail keeps it to a few lines so a burst of parallel work cannot push the rest of the rail off screen.
 */
function keeperEntry() {
  const st = activity.status;
  const color = st === 'Working' || st === 'Working on your request' ? 'amber' : st === 'Idle' ? 'green' : st === 'Not connected' || st === 'Unavailable' ? 'red' : 'blue';
  const running = activity.jobs.filter((j) => j.status === 'Running');
  const all = running.map((j) => `${j.kind}: ${j.scope.label}`);
  return h('button', { class: 'keeper-entry', id: 'keeper-entry', title: all.join('\n') || st, onClick: () => openActivity() },
    h('span', { class: 'pi-mark' }, 'π'),
    h('span', { class: 'kw' }, h('b', {}, h('span', { class: `dot ${color}` }), ' ', st), h('small', {}, all.length ? all.join(' · ') : activity.reason || 'Keeper activity')));
}

/**
 * The Keeper's dock, bottom right (owner, 2026-09-17, pointing at WorkflowKeeper's): `Follow up` asks for a round of
 * organizing now, and `Pi` opens the conversation on the right or puts it away (D67; Spec §6.9). The dot on the robot
 * says whether it is working. The pill moves left with the main view while the conversation is docked, and every
 * view keeps the corner under it clear, so it never lies on text (Spec §6.1).
 */
function keeperDock() {
  const st = activity.status;
  const color = st === 'Working' || st === 'Working on your request' ? 'amber' : st === 'Idle' ? 'green' : st === 'Not connected' || st === 'Unavailable' ? 'red' : 'blue';
  const running = activity.jobs.filter((j) => j.status === 'Running');
  const all = running.map((j) => `${j.kind}: ${j.scope.label}`);
  const busy = running.length > 0;
  // Follow up is daily organizing: until the takeover is done it is not available, and says what to do first (Spec §6.9).
  const understanding = state.project?.coverage?.state;
  const takeoverFirst = understanding === 'Not organized yet' ? 'Start the takeover on the Takeover page first' : understanding !== 'Takeover complete' ? 'The takeover is still under way: Follow up is available once it is done' : null;
  return h('div', { class: 'keeper-dock', id: 'keeper-dock' },
    h('div', { class: 'dock-pill' },
      h('button', {
        class: 'dock-follow', disabled: busy || Boolean(takeoverFirst),
        title: takeoverFirst ?? (busy ? `The Keeper is already working: ${all.join('; ')}` : 'Organize what changed since the last round, now'),
        onClick: followUp,
      }, h('span', {}, '↻'), ' Follow up'),
      h('span', { class: 'dock-sep' }),
      // The robot opens the conversation: asking the Keeper something is what the owner comes to the bottom right for.
      // What it is doing now is the rail's job, and the dot here only says whether it is busy.
      h('button', { class: `dock-robot${state.keeperOpen ? ' on' : ''}`, 'aria-pressed': String(Boolean(state.keeperOpen)), 'aria-label': 'Conversation with the Keeper',
        title: state.keeperOpen ? 'Put the conversation with the Keeper away' : busy ? `Talk to the Keeper (working: ${all.join('; ')})` : 'Talk to the Keeper', onClick: () => toggleKeeper() },
        h('svg', { viewBox: '0 0 24 24', html: "<rect x='4' y='8' width='16' height='11' rx='3'/><path d='M12 4v4M8.5 13h.01M15.5 13h.01M9 16.5h6M2.5 12v3M21.5 12v3'/>" }),
        h('span', {}, 'Pi'), h('span', { class: `dot ${color}` }))));
}

/** Redraw the pill when what it says changed; a button of it that had focus keeps it. */
function paintDock() {
  const dock = $('#keeper-dock');
  if (!dock) return;
  const next = keeperDock();
  if (dock.outerHTML === next.outerHTML) return;
  const focused = dock.contains(document.activeElement) ? document.activeElement.className.split(' ')[0] : null;
  dock.replaceWith(next);
  syncPillWidth();
  if (focused) next.querySelector(`.${focused}`)?.focus({ preventScroll: true });
}

async function followUp() {
  if (!state.projectId) return;
  try {
    const r = await api(`/api/projects/${encodeURIComponent(state.projectId)}/keeper/follow-up`, { method: 'POST' });
    toast(r?.queued ? `Follow up: organizing ${r.queued} material${r.queued === 1 ? '' : 's'}` : 'Follow up: nothing has changed since the last round');
    await refreshActivity();
  } catch (e) { toast(`Follow up: ${e.message}`); }
}

async function renderOutline() {
  const el = $('#outline');
  if (!el || !state.projectId) return;
  try {
    const graph = await api(`/api/projects/${encodeURIComponent(state.projectId)}/graph`);
    const areas = graph.nodes.filter((n) => n.category === 'Area' && n.validity === 'Current');
    const mode = outlineMode();
    const rows = [];
    if (areas.length === 0) rows.push(h('div', { class: 'empty' }, 'No areas established yet'));
    for (const area of areas) {
      // The rail lists the work that is still open, so an area whose work is finished looks empty next to the List,
      // which shows every work item. The count says both, so the difference is visible (owner asked, 2026-09-17).
      const all = graph.nodes.filter((n) => n.category === 'Work item' && n.areaId === area.refId && n.validity === 'Current');
      const open = all.filter((n) => n.progress !== 'Done');
      const works = mode === 'all' ? all : open;
      const count = all.length === 0 ? '' : mode === 'all' ? String(all.length) : `${open.length}/${all.length}`;
      // Buttons, so the outline is a keyboard way to every object the graph draws on a canvas (CKC-09 AC-34). A name
      // that does not fit takes a second line, and the hover has it whole, the area's with its count under it (D68).
      rows.push(h('button', { class: `ol-area${state.selection?.id === area.id ? ' sel' : ''}`, 'data-node': area.id, title: all.length ? `${area.label}\n${open.length} of ${all.length} work items are still open` : area.label, onClick: () => select({ kind: 'node', id: area.id, label: area.label, category: 'Area' }, { reveal: true }) }, h('span', {}, area.label), h('small', {}, count)));
      for (const w of works.slice(0, mode === 'all' ? 30 : 12)) rows.push(h('button', { class: `ol-work${state.selection?.id === w.id ? ' sel' : ''}`, 'data-node': w.id, title: w.label, onClick: () => select({ kind: 'node', id: w.id, label: w.label, category: 'Work item' }, { reveal: true }) }, h('span', {}, w.label)));
    }
    // Rebuilt on every asset event, this list blinked the whole rail while the Keeper worked: only replace it when
    // what it shows has changed (owner, 2026-09-17).
    const next = h('div', {}, ...rows);
    if (el.innerHTML === next.innerHTML) return;
    clear(el).append(...rows);
  } catch (e) { clear(el).append(h('div', { class: 'empty' }, e.message)); }
}

/** The outline follows the selection (Spec §6.1) without being rebuilt: the row that was pressed keeps the focus. */
function markOutline() {
  document.querySelectorAll('#outline [data-node]').forEach((row) => row.classList.toggle('sel', row.dataset.node === state.selection?.id));
}

// ── body ────────────────────────────────────────────────────────────────
export async function renderBody() {
  const main = $('#main');
  const body = $('#body');
  if (!main) return;
  flyout.close();   // the control row it belonged to is rebuilt with the view
  setTopTools(null);
  clear(main);
  main.className = state.view === 'graph' ? 'graph-main' : '';
  body.classList.toggle('graph-body', state.view === 'graph' && Boolean(state.projectId));
  // The drawer belongs to the Project graph (Graph, List and Code fill it again); elsewhere it only keeps the band
  // beside the pill, so no view runs under it (Spec §6.1).
  if (state.view !== 'graph' || !state.projectId) hideDrawer();
  if (!state.projectId) {
    main.append(h('div', { class: 'empty' }, h('h2', {}, 'Add a project to begin'), h('p', {}, 'ProjectKeeper reads a project as it is: directories, repositories, worktrees and the agent sessions that worked in them. Nothing in the project is changed.'), h('button', { class: 'btn primary', onClick: addProjectDialog }, 'Add project')));
    return;
  }
  const view = views[state.view] || views.graph;
  try {
    await view.render(main, state);
    if (state.view === 'scope') mountSkipped(main);
  } catch (e) {
    main.append(h('div', { class: 'empty' }, h('h2', {}, 'This view could not load'), h('p', {}, e.message)));
  }
  const crumb = $('#focus-crumb');
  if (crumb) { crumb.textContent = focusLabel(); crumb.title = focusLabel(); }
  markOutline();
  // Arriving with an object to show (a search result, a link, `Show on graph`): its popover opens beside it here.
  // Otherwise a popover that is up stays up over the rebuilt view, beside the same object.
  const arriving = state.pendingPopover;
  state.pendingPopover = null;
  if (arriving && state.selection) showDetails(state.selection, { trigger: null, anchorIds: arriving.anchorIds });
  else refreshDetails();
}

// ── Keeper conversation: docked on the right, or popped out (Spec §6.8; CKC-10 AC-19, AC-20) ──────────────
/**
 * Opening the conversation — from `Pi`, `Ask Keeper`, a popover, a note — docks it on the right, from under the top
 * bar to the bottom, and the main view gives it its width, so nothing is covered (WorkflowKeeper's D81). `Pi` toggles;
 * the other entries open. A context given, or else the selected object, comes with it.
 */
export function toggleKeeper(open, context) {
  const next = open ?? !state.keeperOpen;
  if (context !== undefined) state.keeperContext = context;
  else if (next && state.selection) state.keeperContext = state.selection;
  state.keeperOpen = next;
  renderKeeper({ focus: next });
}

/**
 * One panel, two forms, and it is never rebuilt when it changes form: docked on the right, or — `Pop out` — the
 * window of 2026-09-18, which drops in from the top, is dragged by its header, resized from its corner, remembers
 * where it was put and returns to the middle on a double-click of its header; `Dock` puts it back. It is the same
 * element either way, so the conversation, a half-typed message and the scroll position stay; it lives outside the
 * page shell, so neither a change of view nor a rebuilt shell touches it. Closed and opened again, it is docked.
 */
const KEEPER_POS = 'pk.keeper.pos';       // the window: { left, top, width?, height? }
const KEEPER_WIDTH = 'pk.keeper.width';   // the docked panel's width
const remembered = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
const remember = (key, value) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* a convenience only */ } };
const isFloating = (panel) => panel.classList.contains('floating');

function keeperPanel() {
  let panel = document.getElementById('keeper');
  if (panel) return panel;
  const resizer = h('div', { class: 'keeper-resizer', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Width of the conversation', tabindex: 0, title: 'Drag to make the conversation wider or narrower (or use the arrow keys)' });
  panel = h('section', { class: 'keeper-panel docked', id: 'keeper', tabindex: -1, 'aria-label': 'Conversation with the Keeper' }, resizer, h('div', { class: 'keeper-inner' }));
  document.body.append(panel);

  // The window is dragged by its header; two presses on the header in quick succession put it back in the middle.
  // (Not a `dblclick` listener: the drag captures the pointer, so a double-click is delivered to the panel and never
  // says it was on the header — the double-click of 2026-09-18 did nothing for that reason.)
  let drag = null;
  let lastPress = null;
  panel.addEventListener('pointerdown', (e) => {
    if (!isFloating(panel) || !e.target.closest('.keeper-head') || e.target.closest('button, input, select, textarea, a')) return;
    const second = lastPress && e.timeStamp - lastPress.at < 450 && Math.hypot(e.clientX - lastPress.x, e.clientY - lastPress.y) < 8;
    lastPress = second ? null : { at: e.timeStamp, x: e.clientX, y: e.clientY };
    if (second) {
      e.preventDefault();
      placeKeeper(panel, null);
      remember(KEEPER_POS, { width: panel.offsetWidth, height: panel.offsetHeight });   // its size is kept, its place forgotten
      return;
    }
    const r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
    panel.setPointerCapture(e.pointerId);
    panel.classList.add('dragging');
    e.preventDefault();
  });
  panel.addEventListener('pointermove', (e) => { if (drag && e.pointerId === drag.id) { drag.moved = true; placeKeeper(panel, { left: e.clientX - drag.dx, top: e.clientY - drag.dy }); } });
  const stop = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    panel.classList.remove('dragging');
    if (moved) rememberWindow(panel);   // a press that did not move it is not a new place to remember
  };
  panel.addEventListener('pointerup', stop);
  panel.addEventListener('pointercancel', stop);
  // Escape puts the window away. The docked panel is part of the workbench and stays.
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isFloating(panel)) toggleKeeper(false); });
  panel.addEventListener('animationend', () => panel.classList.remove('dropping'));
  addEventListener('resize', () => { if (panel.classList.contains('open') && isFloating(panel)) placeKeeper(panel, { left: panel.offsetLeft, top: panel.offsetTop }); });

  // The docked panel is made wider or narrower from its left edge; the main view follows (CKC-10 AC-19).
  const setWidth = (w) => { panel.style.width = `${Math.round(w)}px`; };
  let sizing = null;
  resizer.addEventListener('pointerdown', (e) => { sizing = e.pointerId; resizer.setPointerCapture(e.pointerId); panel.classList.add('sizing'); e.preventDefault(); });
  resizer.addEventListener('pointermove', (e) => { if (sizing === e.pointerId) setWidth(innerWidth - e.clientX); });
  const sized = (e) => { if (sizing !== e.pointerId) return; sizing = null; panel.classList.remove('sizing'); remember(KEEPER_WIDTH, panel.offsetWidth); };
  resizer.addEventListener('pointerup', sized);
  resizer.addEventListener('pointercancel', sized);
  resizer.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0;
    if (!step) return;
    e.preventDefault();
    setWidth(panel.offsetWidth + step);
    remember(KEEPER_WIDTH, panel.offsetWidth);
  });
  // The width it really has — the stylesheet keeps it between a minimum and what the main view can spare — is what
  // the main view and the pill give way by (WorkflowKeeper's `--pi-w`).
  if ('ResizeObserver' in window) new ResizeObserver(() => { syncKeeperLayout(); if (panel.classList.contains('open') && isFloating(panel) && !panel.classList.contains('dropping')) rememberWindow(panel); }).observe(panel);
  return panel;
}
function rememberWindow(panel) {
  if (!panel.offsetWidth) return;
  remember(KEEPER_POS, { left: panel.offsetLeft, top: panel.offsetTop, width: panel.offsetWidth, height: panel.offsetHeight });
}
/** Put the window at a spot (kept inside the screen, header always reachable), or, with null, in the middle near the top. */
function placeKeeper(win, at) {
  const w = win.offsetWidth || Math.min(560, innerWidth - 32);
  const hgt = win.offsetHeight || Math.min(innerHeight * 0.72, 680);
  const left = at ? at.left : (innerWidth - w) / 2;
  const top = at ? at.top : Math.max(56, innerHeight * 0.08);
  win.style.left = `${Math.round(Math.min(Math.max(8, left), innerWidth - Math.min(w, 120)))}px`;
  win.style.top = `${Math.round(Math.min(Math.max(8, top), innerHeight - 48))}px`;
  win.style.setProperty('--pk-fall', `${Math.round(Math.min(Math.max(8, top), innerHeight - 48) + hgt + 40)}px`);
}
/** The main view and the pill give way by the docked panel's real width; with it popped out or closed, by nothing. */
function syncKeeperLayout() {
  const panel = document.getElementById('keeper');
  const docked = Boolean(panel && state.keeperOpen && panel.classList.contains('open') && !isFloating(panel));
  if (docked) document.documentElement.style.setProperty('--pk-keeper-w', `${Math.round(panel.getBoundingClientRect().width)}px`);
  if (document.body.classList.contains('keeper-docked') !== docked) document.body.classList.toggle('keeper-docked', docked);
  popover.reposition({ measure: true });
}
/** Give the one panel its form. Its content is not touched. */
function setKeeperForm(panel, form, { drop = false } = {}) {
  const floating = form === 'floating';
  if (isFloating(panel) && !floating) rememberWindow(panel);
  panel.classList.toggle('floating', floating);
  panel.classList.toggle('docked', !floating);
  panel.classList.remove('dropping', 'dragging', 'sizing');
  panel.setAttribute('role', floating ? 'dialog' : 'complementary');
  for (const p of ['left', 'top', 'width', 'height']) panel.style[p] = '';
  if (floating) {
    const saved = remembered(KEEPER_POS);
    if (saved?.width && saved?.height) { panel.style.width = `${saved.width}px`; panel.style.height = `${saved.height}px`; }
    placeKeeper(panel, saved && Number.isFinite(saved.left) ? saved : null);
    if (drop) { void panel.offsetWidth; panel.classList.add('dropping'); }   // it falls in from the top (a fade with reduced motion)
  } else {
    const width = remembered(KEEPER_WIDTH);
    if (Number.isFinite(width)) panel.style.width = `${width}px`;
  }
}
/** `Pop out` and `Dock`: the same conversation in its other form, with what was typed and where it was scrolled. */
export function setKeeperMode(mode) {
  const panel = document.getElementById('keeper');
  if (!panel || !state.keeperOpen || (mode === 'floating') === isFloating(panel)) return;
  const restore = views.conversation.holdScroll();
  setKeeperForm(panel, mode, { drop: mode === 'floating' });
  syncKeeperLayout();
  views.conversation.sync();
  restore();
}
export const keeperMode = () => (document.getElementById('keeper')?.classList.contains('floating') ? 'floating' : 'docked');

function renderKeeper({ focus = false } = {}) {
  const existing = document.getElementById('keeper');
  if (!state.projectId) { existing?.classList.remove('open'); syncKeeperLayout(); return; }
  if (!state.keeperOpen) {
    if (existing?.classList.contains('open')) { existing.classList.remove('open'); setKeeperForm(existing, 'docked'); }   // opened again, it is docked
    syncKeeperLayout();
    paintDock();
    return;
  }
  const panel = keeperPanel();
  const wasOpen = panel.classList.contains('open');
  if (!wasOpen) { setKeeperForm(panel, 'docked'); panel.classList.add('open'); }
  // Mounted once; after that only what changed is updated — the state and context in its head, and the conversation
  // itself when the project, the session or the context is another one. A change of view changes none of them.
  views.conversation.render(panel.querySelector('.keeper-inner'), state);
  syncKeeperLayout();
  paintDock();
  if (focus && !wasOpen) views.conversation.focus();
}

export function openActivity() {
  views.activity.open(state);
}

// ── dialogs ──────────────────────────────────────────────────────────────
function addProjectDialog() {
  const name = h('input', { class: 'input', placeholder: 'Project name' });
  // The example is a path of the system the page runs on; `~` is the home directory on every one.
  const loc = h('textarea', { class: 'input', placeholder: WINDOWS ? 'One location per line, e.g. D:\\myproject\nD:\\myproject-worktrees\\feature' : 'One location per line, e.g. ~/code/myproject\n~/code/myproject-worktrees/feature' });
  const err = h('small', { class: 'faint' });
  const submit = async () => {
    const locations = loc.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!name.value.trim() || locations.length === 0) { err.textContent = 'A name and at least one location are needed.'; return; }
    try {
      const project = await api('/api/projects', { method: 'POST', body: { name: name.value, locations } });
      $('#dialog').close();
      await loadWorkspace();
      // The project opens on its Takeover page; nothing runs until the owner chooses a depth and presses Start (D105).
      navigate(project.id, 'keeper', 'takeover');
      toast('Project added — choose a depth and press Start');
    } catch (e) { err.textContent = e.message; }
  };
  // `Browse…` walks to a folder instead of typing its path; what is chosen becomes a line of the field, which stays
  // a field: typed and pasted paths are taken as before (folder-chooser.js).
  const chooser = createFolderChooser({
    h, api, added: () => locationLines(loc.value), start: () => locationLines(loc.value).pop() ?? '',
    onAdd: (path) => { loc.value = withLocation(loc.value, path); err.textContent = ''; },
  });
  openDialog('Add project', [
    h('p', { class: 'muted' }, 'Give the project a name and at least one location. Adding it starts nothing: on its Takeover page you choose the key, the model and a depth, and press Start. The Keeper then works out what belongs to it (repositories, worktrees, copies, session logs) and asks only when an ambiguity would change the result.'),
    h('div', { class: 'field' }, h('label', {}, 'Name'), name),
    h('div', { class: 'field' }, h('div', { class: 'row spread' }, h('label', {}, 'Locations'), chooser.button), loc, chooser.panel),
    err,
    h('div', { class: 'dialog-foot' }, h('button', { class: 'btn primary', onClick: submit }, 'Add project')),
  ]);
  name.focus();
}

async function openSearch() {
  const input = h('input', { class: 'input', placeholder: 'Search nodes, sources, changes and notes…' });
  const results = h('div', { class: 'search-results' });
  let timer = null;
  const run = async () => {
    const q = input.value.trim();
    clear(results);
    if (!q) return;
    try {
      const r = await api(`/api/projects/${encodeURIComponent(state.projectId)}/search?q=${encodeURIComponent(q)}`);
      if (r.results.length === 0) { results.append(h('div', { class: 'faint', style: { padding: '8px' } }, 'No matches')); return; }
      for (const x of r.results) {
        results.append(h('button', { class: 'search-result', onClick: () => { $('#dialog').close(); views.search.go(x, state); } }, h('span', { class: 'tag' }, x.type), h('span', {}, x.label), h('small', {}, x.detail || '')));
      }
    } catch (e) { results.append(h('div', { class: 'faint' }, e.message)); }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 150); });
  openDialog('Search', [input, results]);
  input.focus();
}

// ── events ────────────────────────────────────────────────────────────────
const PAGE_ASSETS = {
  notes: ['notes'], changes: ['changes'], scope: ['coverage', 'sources', 'authorizations', 'rules', 'plans', 'marks'],
  keeper: ['jobs', 'authorizations', 'requests'], context: ['nodes', 'threads', 'notes', 'contexts'],
};

async function flushAssets(cols) {
  const only = (names) => cols.size > 0 && [...cols].every((c) => names.includes(c));
  // The Keeper view follows the Keeper's work — the Takeover page fills in as it goes — updated in place (views.keeper.onAssets).
  const keeperPage = () => { if (state.view === 'keeper') void views.keeper.onAssets?.(); };
  if (only(['jobs'])) {
    await refreshActivity();
    views.activity.onEvent?.();
    keeperPage();
    return;
  }
  await loadProject(state.projectId).catch(() => {});
  patchCoveragePill();
  patchNavCounts();
  paintDock();
  if (only(['coverage']) || only(['coverage', 'jobs'])) {
    if (cols.has('jobs')) { await refreshActivity(); views.activity.onEvent?.(); }
    if (state.view === 'scope') await renderBody();
    keeperPage();
    return;
  }
  const view = views[state.view];
  // The popover and the full details stay where they are; their content is fetched again and swapped only if it
  // differs (CKC-09 AC-34: updated in place, and no redraw when nothing changed).
  void updateCounts({ refresh: true });
  if (view?.onAssets) {
    await view.onAssets();
    refreshDetails();
  } else {
    const needed = PAGE_ASSETS[state.view];
    const hit = !needed || [...cols].some((c) => c === '*' || needed.includes(c));
    if (hit) await renderBody();
    else refreshDetails();
  }
  renderOutline();
}

function connectEvents() {
  const es = new EventSource('/api/events');
  let pending = null;
  let pendingCols = new Set();
  es.addEventListener('app', (e) => {
    const event = JSON.parse(e.data);
    if (event.type === 'workspace') { void patchProjectPicker(); return; }
    if (event.projectId && event.projectId !== state.projectId) return;
    if (event.type === 'keeper' || event.type === 'chat') { views.conversation.onEvent?.(event, state); refreshActivity(); if (event.type === 'keeper') views.activity.onEvent?.(event, state); return; }
    pendingCols.add(event.type === 'project' ? 'coverage' : (event.collection || '*'));
    clearTimeout(pending);
    // A busy Keeper writes assets in bursts; redrawing 120 ms after each one made the page twitch. One redraw a
    // second still feels live and coalesces a burst into a single update (owner, 2026-09-17). jobs and coverage
    // alone do not rebuild the graph or details (owner, 2026-09-18).
    pending = setTimeout(() => {
      const cols = pendingCols;
      pendingCols = new Set();
      pending = null;
      void flushAssets(cols);
    }, 1000);
  });
}

async function route() {
  let { projectId, view, rest } = parseHash();
  const changedProject = projectId !== state.projectId;
  const prevView = state.view;
  const prevRest = state.routeRest || '';
  // Older links keep working: Sources now lives inside Project scope (D34); Connections is the Keeper view (D35).
  if (view === 'sources') { view = 'scope'; rest = rest || 'sources'; }
  if (view === 'connections') view = 'keeper';
  const nextView = VIEWS.some(([id]) => id === view) ? view : 'graph';
  if (!changedProject && nextView === prevView && (rest || '') === prevRest && state.projectId === projectId) return;
  state.view = nextView;
  state.routeRest = rest;
  if (changedProject || nextView !== prevView) views.graph.closeSheet?.();
  if (changedProject) {
    state.selection = null;
    state.projectId = projectId;
    state.project = null;
    // The conversation and its context belong to the project that was open; the panel itself stays as it is.
    state.conversationId = null;
    state.keeperContext = null;
    state.pendingPopover = null;
    if (projectId) {
      try {
        await loadProject(projectId);
        const opened = await api(`/api/projects/${encodeURIComponent(projectId)}/opened`, { method: 'POST' });
        state.lastVisit = opened?.previous ?? null;
        await refreshActivity();
        // A project not organized yet opens on the Takeover page of the Keeper view (Spec §6.1, §6.14; D105).
        if (notOrganized() && state.view !== 'keeper') {
          state.view = 'keeper';
          state.routeRest = 'takeover';
          history.replaceState(null, '', `#/p/${encodeURIComponent(projectId)}/keeper/takeover`);
        }
      } catch (e) { toast(e.message); state.projectId = null; }
    }
    renderChrome();
    return;
  }
  patchNavActive();
  // What the popover stood beside is gone with the view; one that travels with the owner (`Show on graph`, a search
  // result) opens again beside the object where they arrive.
  if (nextView !== prevView && !state.pendingPopover) popover.close('navigate');
  await renderBody();
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && state.projectId) { e.preventDefault(); openSearch(); }
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  // One Escape closes one thing (the dialog, the popover and the control row's panels have taken theirs already):
  // the reading sheet over the drawer, else the maximised panel goes back into the workbench (shell-state.js).
  const inKeeper = e.target instanceof Element && Boolean(e.target.closest('#keeper'));
  const act = escapeAction({ dialogOpen: $('#dialog').open, sheetOpen: stripSheetOpen(), maximised: maximised(), inKeeper });
  if (act === 'close-sheet' && views.graph.closeSheet?.({ focus: true })) e.preventDefault();
  else if (act === 'restore') { e.preventDefault(); setMaximised(false); $('#panel-max')?.focus({ preventScroll: true }); }
});
window.addEventListener('hashchange', route);
// The theme changed: the graph repaints its pictures in the new colours, in place. Nothing else on the page is touched
// — the stylesheets did the rest — and nothing is fetched again (Spec §6.16; CKC-09 AC-40).
document.addEventListener('pk:theme', () => { views.graph.repaint?.(); });
// The theme's sheets are in before anything is drawn, so the graph reads its colours once and paints once.
await initTheme();
await loadWorkspace();
if (!location.hash && state.workspace.lastProjectId) navigate(state.workspace.lastProjectId, 'graph');
await route();
// A workspace with no project yet: route() has nothing to change to, so the shell — with `Add a project to begin` — is
// drawn here (Spec §6.14). It used to stay blank until some workspace event came.
if (!$('#app').firstChild) renderChrome();
connectEvents();
