// The workbench's panels (Spec §6.1, D100; CKC-09 AC-43, AC-44): what the shell remembers and decides, apart from the
// DOM, so the rules are tested with `node --test` (src/ui/shell-state.test.ts). app.js applies them to the page.

/**
 * Whether the left rail is folded to its strip. A choice of this browser, like the theme (Spec §6.1, §6.16): it lives in
 * `localStorage`, never in the project's assets. Storage can be missing or throw (a private window, blocked site data);
 * the choice then holds on this page only, and the page works the same.
 */
export const RAIL_KEY = 'pk.rail.folded';

export function railMemory(storage = globalThis.localStorage) {
  let here = null;   // the choice on this page, when the browser keeps none
  return {
    folded() {
      try {
        const v = storage?.getItem(RAIL_KEY);
        if (v === '1' || v === '0') return v === '1';
      } catch { /* no storage: the choice made on this page */ }
      return here ?? false;
    },
    setFolded(folded) {
      here = Boolean(folded);
      try { storage?.setItem(RAIL_KEY, here ? '1' : '0'); } catch { /* remembered on this page only */ }
      return here;
    },
  };
}

/**
 * What one Escape does in the workbench, when nothing on top of it has taken it (a dialog, the popover and the control
 * row's panels take theirs first, in the capture phase): close the reading sheet over the drawer, else restore the
 * maximised main panel. A key pressed inside the Keeper conversation (its window closes itself on Escape; in the docked
 * panel the owner is typing) does not restore the layout under it.
 */
export function escapeAction({ dialogOpen = false, sheetOpen = false, maximised = false, inKeeper = false } = {}) {
  if (dialogOpen) return null;
  if (sheetOpen) return 'close-sheet';
  if (maximised && !inKeeper) return 'restore';
  return null;
}
