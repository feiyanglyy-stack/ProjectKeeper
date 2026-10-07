// The folder chooser (ui/folder-chooser.js; owner 2026-10-06: 「add这个locations帮我换成可以有对话框自己选一下」): what the
// panel writes into the field it stands under, what it asks the server, what it says, and what each key does. The
// drawing itself is looked at in a real browser (scripts/ui-folder-chooser-check.mjs). The interface is plain ES
// modules, loaded at run time; the paths here are invented and written as each system writes them, because the page
// never takes a path apart: it only passes on what the server gave it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-explicit-any */
const C: any = await import(new URL('../../ui/folder-chooser.js', import.meta.url).href);

test('a chosen folder becomes a new last line of the field, and what was typed stays as typed', () => {
  assert.equal(C.withLocation('', 'D:\\orchard'), 'D:\\orchard');
  assert.equal(C.withLocation('   \n', '/home/kit/orchard'), '/home/kit/orchard');
  assert.equal(C.withLocation('D:\\orchard', 'D:\\orchard-grafting'), 'D:\\orchard\nD:\\orchard-grafting');
  assert.equal(C.withLocation('D:\\orchard\n', 'D:\\orchard-grafting'), 'D:\\orchard\nD:\\orchard-grafting', 'no empty line is left between');
  assert.equal(C.withLocation('  d:/Orchard  \r\n\r\nE:\\meadow\r\n', 'F:\\plots'), '  d:/Orchard  \r\n\r\nE:\\meadow\nF:\\plots', 'a typed line is not rewritten');
  assert.equal(C.withLocation('D:\\orchard\nD:\\meadow', 'D:\\orchard'), 'D:\\orchard\nD:\\meadow', 'the same path is not added twice');
  assert.equal(C.withLocation('  D:\\orchard  ', 'D:\\orchard'), '  D:\\orchard  ');
  assert.deepEqual(C.locationLines(' D:\\orchard \r\n\n  \n/srv/meadow\n'), ['D:\\orchard', '/srv/meadow']);
  assert.deepEqual(C.locationLines(''), []);
  assert.deepEqual(C.locationLines(undefined), []);
});

test('what is asked of the server: the folder, hidden ones when wanted, and the paths the field holds', () => {
  assert.equal(C.foldersUrl(), '/api/folders', 'no path: the server starts at the home directory');
  assert.equal(C.foldersUrl({ path: '' }), '/api/folders');
  const u = new URL(C.foldersUrl({ path: 'D:\\my projects\\orchard & co', hidden: true, added: ['D:\\orchard', '/srv/a b', 'C:\\50%#?=x'] }), 'http://127.0.0.1');
  assert.equal(u.pathname, '/api/folders');
  assert.equal(u.searchParams.get('path'), 'D:\\my projects\\orchard & co');
  assert.equal(u.searchParams.get('hidden'), '1');
  assert.deepEqual(u.searchParams.getAll('added'), ['D:\\orchard', '/srv/a b', 'C:\\50%#?=x'], 'every character of a path arrives as it was');
  assert.equal(new URL(C.foldersUrl({ path: '/srv' }), 'http://127.0.0.1').searchParams.has('hidden'), false);
  const many = new URL(C.foldersUrl({ path: '/srv', added: Array.from({ length: 80 }, (_, i) => `/srv/plot-${i}`) }), 'http://127.0.0.1');
  assert.equal(many.searchParams.getAll('added').length, 50, 'a long field does not make a request too long to send');
});

test('the marks beside a folder: a repository, a link, already added', () => {
  const plain = { name: 'docs', repository: false, link: false, added: false };
  assert.deepEqual(C.folderMarks(plain), []);
  assert.deepEqual(C.folderMarks({ ...plain, repository: true }).map((m: any) => [m.text, m.tone]), [['git', 'blue']]);
  assert.deepEqual(C.folderMarks({ ...plain, repository: true, link: true, added: true }).map((m: any) => m.text), ['git', 'link', 'added']);
  assert.deepEqual(C.folderMarks({ ...plain, added: true }, 'in scope').map((m: any) => [m.text, m.tone, m.title]), [['in scope', 'green', 'Already in scope']]);
  for (const m of C.folderMarks({ ...plain, repository: true, link: true, added: true })) assert.ok(m.title.length > 0, 'each mark says what it means on hover');
});

test('what the list says when folders are left out, when there are none, and when it cannot be read', () => {
  const l = { folders: [], more: 0, hidden: 0, error: null };
  assert.equal(C.moreLine(l), '');
  assert.equal(C.moreLine(null), '');
  assert.equal(C.moreLine({ ...l, more: 1 }), '1 more folder is not shown. Type a path above to go to one.');
  assert.equal(C.moreLine({ ...l, more: 1840 }), '1,840 more folders are not shown. Type a path above to go to one.');
  assert.equal(C.emptyLine(l, false), 'No folders here.');
  assert.equal(C.emptyLine({ ...l, hidden: 3 }, false), 'No folders here, apart from 3 hidden.');
  assert.equal(C.emptyLine({ ...l, hidden: 3 }, true), 'No folders here.');
  assert.equal(C.emptyLine({ ...l, hidden: 3, error: 'This folder cannot be read: access to it is denied.' }, false), 'This folder cannot be read: access to it is denied.');
  assert.equal(C.hiddenLabel(l), 'Show hidden');
  assert.equal(C.hiddenLabel({ ...l, hidden: 12 }), 'Show hidden (12)');
  assert.equal(C.hiddenLabel(null), 'Show hidden');
});

test('the keys: Escape closes the panel, Alt+Up and Backspace go up, the arrows walk the list', () => {
  const k = (key: string, mods: Record<string, boolean> = {}) => ({ key, altKey: false, ctrlKey: false, metaKey: false, ...mods });
  for (const where of ['row', 'path', 'other']) {
    assert.equal(C.chooserKey(k('Escape'), where), 'close', `Escape from ${where}`);
    assert.equal(C.chooserKey(k('ArrowUp', { altKey: true }), where), 'up', `Alt+Up from ${where}`);
    assert.equal(C.chooserKey(k('Enter'), where), null, `Enter from ${where} is the control’s own`);
    assert.equal(C.chooserKey(k('a'), where), null);
    assert.equal(C.chooserKey(k('Tab'), where), null, 'Tab walks the controls as everywhere');
  }
  assert.equal(C.chooserKey(k('Backspace'), 'row'), 'up');
  assert.equal(C.chooserKey(k('Backspace'), 'other'), 'up');
  assert.equal(C.chooserKey(k('Backspace'), 'path'), null, 'in the path line Backspace deletes a character');
  assert.equal(C.chooserKey(k('ArrowDown'), 'row'), 'next');
  assert.equal(C.chooserKey(k('ArrowUp'), 'row'), 'previous');
  assert.equal(C.chooserKey(k('ArrowDown'), 'path'), 'next', 'from the path line, down enters the list');
  assert.equal(C.chooserKey(k('ArrowUp'), 'path'), null);
  assert.equal(C.chooserKey(k('ArrowDown'), 'other'), null);
  assert.equal(C.chooserKey(k('Home'), 'row'), 'first');
  assert.equal(C.chooserKey(k('End'), 'row'), 'last');
  assert.equal(C.chooserKey(k('Home'), 'path'), null, 'Home and End move the caret in the path line');
  assert.equal(C.chooserKey(k('End'), 'path'), null);
  // A key held with Ctrl or ⌘ is the browser's or the system's.
  assert.equal(C.chooserKey(k('Backspace', { ctrlKey: true }), 'row'), null);
  assert.equal(C.chooserKey(k('ArrowUp', { metaKey: true }), 'row'), null);
  assert.equal(C.chooserKey(k('ArrowDown', { altKey: true }), 'row'), null);
  assert.equal(C.chooserKey(k('ArrowLeft', { altKey: true }), 'row'), null, 'Alt+Left stays the browser’s Back');
});
