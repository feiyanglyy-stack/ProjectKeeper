// Which theme opens and which two files that means (Spec §6.16; CKC-09 AC-40): the choice kept in this browser, the
// manifest's default, the factory look as the fallback. No DOM here; ui/theme.js swaps the two <link> hrefs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-explicit-any */
const pick: any = await import(new URL('../../ui/theme-pick.js', import.meta.url).href);

const manifest = { default: 'i1', themes: [{ id: 'a1', name: 'Walnut Workshop' }, { id: 'b1', name: 'Peacock & Brass' }, { id: 'd2', name: 'Warm Clay' }, { id: 'i1', name: 'Task Console' }] };

test('nothing remembered opens the manifest default; a remembered theme opens itself; the factory look is a choice of its own', () => {
  assert.equal(pick.resolveTheme(null, manifest), 'i1');
  assert.equal(pick.resolveTheme(undefined, manifest), 'i1');
  assert.equal(pick.resolveTheme('d2', manifest), 'd2');
  assert.equal(pick.resolveTheme(pick.FACTORY, manifest), pick.FACTORY, 'the factory look, once chosen, stays chosen');
});

test('a remembered id the manifest no longer has falls back to the default, and no manifest at all means the factory look', () => {
  assert.equal(pick.resolveTheme('zz', manifest), 'i1');
  assert.equal(pick.resolveTheme('i1', null), pick.FACTORY);
  assert.equal(pick.resolveTheme(null, { default: 'nope', themes: manifest.themes }), pick.FACTORY, 'a default that is not listed is not used');
});

test('a theme is two files under its folder; the factory look is no file at all', () => {
  assert.deepEqual(pick.themeHrefs('i1'), { board: '/themes/i1/board.css', pk: '/themes/i1/pk.css' });
  assert.deepEqual(pick.themeHrefs(pick.FACTORY), { board: '', pk: '' });
  assert.deepEqual(pick.themeHrefs('../x'), { board: '', pk: '' }, 'an id that is not a folder name is the factory look');
});

test('the picker lists the factory look first, then the manifest in its order with its names', () => {
  assert.deepEqual(pick.themeOptions(manifest), [{ id: '', name: 'Factory' }, { id: 'a1', name: 'Walnut Workshop' }, { id: 'b1', name: 'Peacock & Brass' }, { id: 'd2', name: 'Warm Clay' }, { id: 'i1', name: 'Task Console' }]);
  assert.deepEqual(pick.themeOptions(null), [{ id: '', name: 'Factory' }]);
});

test('the name of a theme, for the toast that says one could not be loaded', () => {
  assert.equal(pick.themeName('d2', manifest), 'Warm Clay');
  assert.equal(pick.themeName('', manifest), 'Factory');
  assert.equal(pick.themeName('zz', manifest), 'zz');
});
