// The workbench's panels (Spec §6.1, D100; CKC-09 AC-43, AC-44): the rail's folded state is this browser's and survives
// storage that is missing or throws; one Escape closes one thing, and the maximised panel is the last of them. Pure, so
// checked here without a browser; the panel states themselves were looked at on the real page (CF's screenshots).
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-explicit-any */
const shell: any = await import(new URL('../../ui/shell-state.js', import.meta.url).href);

/** A storage like the browser's, as far as the rail uses it. */
const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, String(v)); }, map: m };
};

test('the rail is unfolded until the owner folds it, and the choice is kept in this browser under its own key (AC-43)', () => {
  const storage = memoryStorage();
  const rail = shell.railMemory(storage);
  assert.equal(rail.folded(), false, 'a first visit shows the whole rail');
  rail.setFolded(true);
  assert.equal(rail.folded(), true);
  assert.equal(storage.map.get(shell.RAIL_KEY), '1');
  // A reload reads it back: a new page, the same browser.
  assert.equal(shell.railMemory(storage).folded(), true);
  rail.setFolded(false);
  assert.equal(shell.railMemory(storage).folded(), false);
  assert.equal(shell.RAIL_KEY, 'pk.rail.folded', 'a key of the page, not of any project');
});

test('without storage, or with storage that throws, the choice still holds on the page and nothing breaks', () => {
  for (const storage of [null, undefined, { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } }]) {
    const rail = shell.railMemory(storage);
    assert.equal(rail.folded(), false);
    assert.doesNotThrow(() => rail.setFolded(true));
    assert.equal(rail.folded(), true, 'remembered on this page');
    rail.setFolded(false);
    assert.equal(rail.folded(), false);
  }
});

test('a value the rail did not write is not read as folded', () => {
  const storage = memoryStorage();
  storage.setItem('pk.rail.folded', 'yes');
  assert.equal(shell.railMemory(storage).folded(), false);
});

test('one Escape closes one thing: the reading sheet over the drawer first, then the maximised panel is restored (AC-44)', () => {
  assert.equal(shell.escapeAction({ sheetOpen: true, maximised: true }), 'close-sheet');
  assert.equal(shell.escapeAction({ maximised: true }), 'restore');
  assert.equal(shell.escapeAction({}), null, 'nothing to close: the key is left alone');
  assert.equal(shell.escapeAction({ dialogOpen: true, sheetOpen: true, maximised: true }), null, 'a dialog on top takes it');
  // Typing in the Keeper conversation (or closing its window) does not restore the layout under it.
  assert.equal(shell.escapeAction({ maximised: true, inKeeper: true }), null);
  assert.equal(shell.escapeAction(), null);
});
