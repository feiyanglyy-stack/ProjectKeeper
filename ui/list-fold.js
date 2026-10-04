// The List's blocks that open and close (Spec §6.3 `List`; E153): the top plate, each earlier generation's row, each
// module's block, the foundation's and the cross-cutting ring's. Every one is folded to its head until the owner opens
// it (owner, 2026-10-01: 「这个我改过ui的地方，可以点击放开收上去，这样就是想看哪个module就可以点着看了，否则太长了」), so
// the whole List is about one screen and reads as the project's contents.
//
// What the owner opened is a choice of this browser, like the rail and the theme (shell-state.js): it lives in
// `localStorage`, per project, never in the project's assets, and holds across a refresh of the view's data and a
// reload of the page. Storage can be missing or throw (a private window, blocked site data); the choice then holds on
// this page only. A work row's own fold — its `Process` · `Outcome` — is the process view's one rule (k-fold.js).
//
// No DOM here, so the rule is tested with `node --test` (src/ui/list-fold.test.ts). views.js draws the blocks from it.

export const LIST_FOLD_KEY = 'pk.list.open';

/** The keys of the List's blocks. A module's and the foundation's block go by their area; the ring's has no area. */
export const PLATE_KEY = 'plate';
export const CROSS_KEY = 'block:cross';
export const blockKey = (areaId) => `block:${areaId}`;
export const generationKey = (generationId) => `gen:${generationId}`;

/** `storage`: the browser's `localStorage` when left out; null for none (the choice then holds on the page). */
export function createListFold(storage) {
  const store = () => (storage === undefined ? globalThis.localStorage : storage);   // read inside try: it can throw
  let here = null;   // project id → the keys open in it; read from the browser once, kept on the page when there is none
  const read = () => {
    if (here) return here;
    here = new Map();
    try {
      const kept = JSON.parse(store()?.getItem(LIST_FOLD_KEY) ?? '{}');
      if (kept && typeof kept === 'object' && !Array.isArray(kept)) {
        for (const [pid, keys] of Object.entries(kept)) if (Array.isArray(keys)) here.set(pid, new Set(keys.filter((k) => typeof k === 'string')));
      }
    } catch { /* nothing kept, or not ours: every block folded */ }
    return here;
  };
  const write = () => {
    const kept = {};
    for (const [pid, keys] of read()) if (keys.size) kept[pid] = [...keys];
    try { store()?.setItem(LIST_FOLD_KEY, JSON.stringify(kept)); } catch { /* remembered on this page only */ }
  };
  const openIn = (pid) => read().get(pid) ?? new Set();
  const set = (pid, key, open) => {
    const keys = read().get(pid) ?? new Set();
    open = Boolean(open);
    if (open === keys.has(key)) return open;
    if (open) keys.add(key); else keys.delete(key);
    read().set(pid, keys);
    write();
    return open;
  };
  return {
    /** Whether a block is open: only when the owner opened it. */
    isOpen: (pid, key) => openIn(pid).has(key),
    set,
    toggle: (pid, key) => set(pid, key, !openIn(pid).has(key)),
    /**
     * `Expand all` opens every block the List draws now (`keys`); `Fold all` folds every block of the project, the
     * ones no longer drawn with them, so nothing stale is kept.
     */
    setAll(pid, keys, open) {
      read().set(pid, open ? new Set([...openIn(pid), ...keys]) : new Set());
      write();
    },
    allOpen: (pid, keys) => keys.length > 0 && keys.every((k) => openIn(pid).has(k)),
    anyOpen: (pid, keys) => keys.some((k) => openIn(pid).has(k)),
  };
}
