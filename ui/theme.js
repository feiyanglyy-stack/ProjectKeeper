// Themes on the page (Spec §6.16; CKC-09 AC-40): the two <link>s in index.html — the frozen board.css of a theme and
// ProjectKeeper's own layer for it — take their hrefs from the choice kept in this browser. Changing the theme swaps the
// two hrefs and nothing else: no data is fetched again, nothing is rebuilt; the graph alone repaints its pictures in the
// new colours once the sheets have loaded (graph.js repaint, through the `pk:theme` event). A theme whose files do not
// load falls back to the factory look for this session. The choices themselves are pure (theme-pick.js).
import { FACTORY, THEME_KEY, resolveTheme, themeHrefs, themeOptions, themeName } from './theme-pick.js';
import { h, toast } from './app.js';

let manifest = null;
let current = FACTORY;
let latest = 0;   // the last request; a slower earlier one is not allowed to finish after it

/** The theme in force: a manifest id, or the factory look (''). */
export const currentTheme = () => current;
export const themeList = () => themeOptions(manifest);

/** Read the manifest and open the remembered theme (or the default); resolves once its sheets are in. */
export async function initTheme() {
  try { manifest = await (await fetch('/themes/manifest.json')).json(); } catch { manifest = null; }
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* nothing remembered here */ }
  await applyTheme(resolveTheme(saved, manifest), { remember: false, announce: false });
}

/**
 * Put a theme on the page. `remember` keeps it in this browser (a personal preference, never a project asset). When a
 * sheet fails to load the factory look is shown instead and the owner is told; the remembered choice is left as it
 * is, so a theme that is back next time comes back by itself.
 */
export async function applyTheme(id, { remember = true, announce = true } = {}) {
  const board = document.getElementById('theme-board'), pk = document.getElementById('theme-pk');
  if (!board || !pk) return;
  const mine = ++latest;
  if (remember) { try { localStorage.setItem(THEME_KEY, id); } catch { /* a convenience only */ } }
  const hrefs = themeHrefs(id);
  const ok = await Promise.all([swap(board, hrefs.board), swap(pk, hrefs.pk)]).then((r) => r.every(Boolean));
  if (mine !== latest) return;   // superseded
  if (ok || id === FACTORY) current = id;
  else {
    current = FACTORY;
    await Promise.all([swap(board, ''), swap(pk, '')]);
    if (mine !== latest) return;
    toast(`Theme ${themeName(id, manifest)} could not be loaded; showing the factory look`);
  }
  syncPickers();
  document.dispatchEvent(new CustomEvent('pk:theme', { detail: { id: current, announce } }));
}

/** Set a <link>'s href and wait for the sheet: true once it is in, false when it could not be loaded. */
function swap(link, href) {
  if ((link.getAttribute('href') ?? '') === href) return Promise.resolve(true);
  if (!href) { link.setAttribute('href', ''); return Promise.resolve(true); }
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); link.removeEventListener('load', onLoad); link.removeEventListener('error', onError); resolve(ok); };
    const onLoad = () => finish(true);
    const onError = () => finish(false);
    // A sheet that has not answered in this long is treated as missing: the factory look is always ready.
    const timer = setTimeout(() => finish(false), 8000);
    link.addEventListener('load', onLoad);
    link.addEventListener('error', onError);
    link.setAttribute('href', href);
  });
}

/** The picker in the top bar: the factory look and the four themes by name; a change applies at once. */
export function themePicker() {
  const select = h('select', { class: 'theme-select', 'aria-label': 'Theme', title: 'Theme: how the workbench looks. Kept in this browser.', onChange: (e) => { void applyTheme(e.target.value); } },
    ...themeOptions(manifest).map((o) => h('option', { value: o.id, selected: o.id === current }, o.name)));
  return h('label', { class: 'theme-pick' }, h('span', {}, 'Theme'), select);
}
function syncPickers() {
  document.querySelectorAll('.theme-pick select').forEach((s) => { if (s.value !== current) s.value = current; });
}
