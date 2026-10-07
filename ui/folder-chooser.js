// The folder chooser: where a location is typed (Add project's `Locations`, a scope item's `Path`), `Browse…` opens this
// panel inside the dialog and the owner walks to the folder instead of typing its path (owner 2026-10-06:
// 「add这个locations帮我换成可以有对话框自己选一下」). The field it stands under stays as it was: typing and pasting a path
// work as before, and what is chosen here is written into that field as text.
//
// It is the program's own panel, not the system's dialog and not the browser's directory picker: a page cannot learn a
// folder's whole path from the browser, and a dialog opened by a local server comes up behind the browser. The folders
// come from `GET /api/folders` (src/server/folders-api.ts), which answers the workbench's own pages only.
//
// Nothing here knows the system it runs on: the separator, the quick starts (the home directory; the drives on Windows,
// `/` elsewhere) and every path are the server's. The first half of this file is what the panel says and decides, with
// no DOM in it (src/ui/folder-chooser.test.ts); the second half draws it with the page's own `h` and `api`.

/** The locations typed in a field, one a line: trimmed, empty lines dropped. */
export const locationLines = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** `text` with `path` as a new last line; unchanged when a line already says exactly that. What was typed is kept as typed. */
export function withLocation(text, path) {
  const now = String(text ?? '');
  if (locationLines(now).includes(path)) return now;
  const kept = now.replace(/\s+$/, '');
  return kept ? `${kept}\n${path}` : path;
}

/** The request for one directory. `added` are the paths the field already holds (at most 50 are sent). */
export function foldersUrl({ path = '', hidden = false, added = [] } = {}) {
  const q = new URLSearchParams();
  if (path) q.set('path', path);
  if (hidden) q.set('hidden', '1');
  for (const a of added.slice(0, 50)) q.append('added', a);
  const s = q.toString();
  return s ? `/api/folders?${s}` : '/api/folders';
}

/** The marks beside a folder's name: `{ text, tone, title }`, in the order shown. */
export function folderMarks(folder, addedWord = 'added') {
  const marks = [];
  if (folder.repository) marks.push({ text: 'git', tone: 'blue', title: 'A git repository or a worktree of one' });
  if (folder.link) marks.push({ text: 'link', tone: '', title: 'A link: it opens the folder it leads to' });
  if (folder.added) marks.push({ text: addedWord, tone: 'green', title: `Already ${addedWord}` });
  return marks;
}

/** The line under the list: how many folders are not shown, and how to reach one. Empty when all are shown. */
export function moreLine(listing) {
  if (!listing || !listing.more) return '';
  return `${listing.more.toLocaleString('en')} more ${listing.more === 1 ? 'folder is' : 'folders are'} not shown. Type a path above to go to one.`;
}

/** What the list says when it has no row. */
export function emptyLine(listing, showHidden) {
  if (listing.error) return listing.error;
  if (listing.hidden > 0 && !showHidden) return `No folders here, apart from ${listing.hidden} hidden.`;
  return 'No folders here.';
}

/** The label of the hidden-folders switch. */
export const hiddenLabel = (listing) => (listing && listing.hidden > 0 ? `Show hidden (${listing.hidden})` : 'Show hidden');

/**
 * What a key does in the panel, or null when it is left to the browser.
 *   Escape                  → 'close'   (the panel, never the dialog it is in)
 *   Alt+ArrowUp             → 'up'      (anywhere in the panel)
 *   Backspace               → 'up'      (not while typing: in the path line it deletes a character)
 *   ArrowDown / ArrowUp     → 'next' / 'previous' row (from the path line, ArrowDown enters the list)
 *   Home / End              → 'first' / 'last' row (in the list)
 * Enter needs no entry: on a row it is the button's own click (go in); in the path line it goes to the typed path.
 * @param {{ key: string, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean }} e
 * @param {'row' | 'path' | 'other'} where what has the focus
 */
export function chooserKey(e, where) {
  if (e.ctrlKey || e.metaKey) return null;
  if (e.key === 'Escape') return 'close';
  if (e.key === 'ArrowUp' && e.altKey) return 'up';
  if (e.altKey) return null;
  if (e.key === 'Backspace') return where === 'path' ? null : 'up';
  if (e.key === 'ArrowDown') return where === 'other' ? null : 'next';
  if (e.key === 'ArrowUp') return where === 'row' ? 'previous' : null;
  if (where === 'row' && e.key === 'Home') return 'first';
  if (where === 'row' && e.key === 'End') return 'last';
  return null;
}

// ───────────────────────── the panel ─────────────────────────

const FOLDER_ICON = "<svg viewBox='0 0 20 20' width='15' height='15' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linejoin='round' aria-hidden='true'><path d='M2.5 5.5a1 1 0 0 1 1-1h4l1.6 1.8h7.4a1 1 0 0 1 1 1v7.7a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z'/></svg>";

/** Where the last chooser was left, so the next one opens there: this page only, never stored. */
let lastPlace = '';

/**
 * @param {{
 *   h: Function, api: (path: string) => Promise<any>,
 *   added: () => string[],          the paths the field holds now
 *   onAdd: (path: string) => void,  write the chosen folder into the field
 *   start?: () => string,           where to open; empty: where the last chooser was left, else the home directory
 *   addLabel?: string,              the button that takes the folder shown ('Add this folder')
 *   addedWord?: string,             the mark of a folder the field already holds ('added')
 *   single?: boolean,               one folder is wanted: choosing it closes the panel
 *   chooseAdded?: boolean,          a folder the field's owner already holds can be chosen again (it is only marked)
 * }} o
 * @returns {{ button: HTMLElement, panel: HTMLElement, open: () => Promise<void>, close: () => void, isOpen: () => boolean }}
 */
export function createFolderChooser(o) {
  const { h, api } = o;
  const addLabel = o.addLabel ?? 'Add this folder';
  const addedWord = o.addedWord ?? 'added';
  let listing = null;       // the last answer shown
  let showHidden = false;
  let asked = 0;            // the newest request; an older answer that arrives late is dropped
  let host = null;          // the dialog the panel is in, while it listens there
  let byKeys = false;       // the last thing done in the panel was a key, not the mouse: the folder in focus is shown as such

  const path = h('input', { class: 'input mono fc-path', 'aria-label': 'Folder path', autocomplete: 'off', spellcheck: 'false', title: 'The folder shown. Type or paste a path and press Enter to go there.' });
  const up = h('button', { class: 'btn small fc-up', type: 'button', title: 'Up one level (Alt+↑, or Backspace in the list)', onClick: () => goUp() }, '↑ Up');
  const go = h('button', { class: 'btn small', type: 'button', title: 'Go to the path typed', onClick: () => load(path.value, { focus: 'list' }) }, 'Go');
  const starts = h('div', { class: 'fc-starts' });
  const hiddenBox = h('input', { type: 'checkbox', onChange: () => { showHidden = hiddenBox.checked; void load(listing?.path ?? path.value, { focus: 'keep' }); } });
  const hiddenText = h('span', {}, 'Show hidden');
  const list = h('div', { class: 'fc-list', role: 'group', 'aria-label': 'Folders' });
  const more = h('small', { class: 'fc-more faint', 'aria-live': 'polite' });
  const here = h('span', { class: 'fc-here muted' });
  const add = h('button', { class: 'btn', type: 'button', onClick: () => choose() }, addLabel);
  const done = h('button', { class: 'btn', type: 'button', title: 'Close the folder list (Esc)', onClick: () => close() }, o.single ? 'Cancel' : 'Done');
  const panel = h('div', { class: 'fc', hidden: true },
    h('div', { class: 'fc-bar' }, up, path, go),
    h('div', { class: 'fc-bar fc-sub' }, starts, h('label', { class: 'fc-hidden' }, hiddenBox, hiddenText)),
    list, more,
    h('div', { class: 'fc-foot' }, here, add, done));
  const button = h('button', { class: 'btn small fc-browse', type: 'button', 'aria-expanded': 'false', title: 'Choose the folder from a list instead of typing its path', onClick: () => (isOpen() ? close() : void open()) }, 'Browse…');

  panel.addEventListener('pointerdown', () => { byKeys = false; }, true);
  const rows = () => [...list.querySelectorAll('.fc-row')];
  const isOpen = () => !panel.hidden;

  function say(text) {
    list.replaceChildren(h('div', { class: 'fc-empty muted' }, text));
  }

  function draw(focus) {
    const l = listing;
    path.value = l.path;
    up.disabled = l.parent === null;
    starts.replaceChildren(...l.starts.map((s) => h('button', { class: 'btn small', type: 'button', title: s.path, onClick: () => load(s.path, { focus: 'list' }) }, s.label)));
    hiddenText.textContent = hiddenLabel(l);
    if (l.folders.length === 0) say(emptyLine(l, showHidden));
    else {
      list.replaceChildren(...l.folders.map((f) => h('button', { class: `fc-row${f.hidden ? ' dim' : ''}`, type: 'button', dataset: { path: f.path }, title: f.path, onClick: () => load(f.path, { focus: 'list' }) },
        h('span', { class: 'fc-icon', html: FOLDER_ICON }),
        h('span', { class: 'fc-name' }, f.name),
        ...folderMarks(f, addedWord).map((m) => h('span', { class: `tag ${m.tone}`.trim(), title: m.title }, m.text)))));
    }
    list.scrollTop = 0;
    more.textContent = moreLine(l);
    const marks = folderMarks({ repository: l.repository, link: false, added: l.added }, addedWord);
    here.replaceChildren(h('span', { class: 'fc-here-name', title: l.path }, l.name), ...marks.map((m) => h('span', { class: `tag ${m.tone}`.trim(), title: m.title }, m.text)));
    const taken = l.added && !o.chooseAdded;
    add.disabled = Boolean(l.error) || taken;
    add.title = l.error ? 'This folder cannot be chosen' : taken ? `This folder is already ${addedWord}` : l.path;
    if (focus === 'keep') return;
    // Coming up, the folder that was left is the one in focus; going in, the first; with no row, the way on.
    const from = typeof focus === 'object' && focus ? rows().find((r) => r.dataset.path === focus.from) : null;
    const target = from ?? rows()[0] ?? (add.disabled ? (up.disabled ? path : up) : add);
    // A key held with Alt does not make the browser draw the focus by itself, so it is asked to.
    target.focus({ preventScroll: true, focusVisible: byKeys });
    target.scrollIntoView?.({ block: 'nearest' });
  }

  async function load(to, { focus = 'list' } = {}) {
    const mine = ++asked;
    const slow = setTimeout(() => { if (mine === asked) say('Reading…'); }, 250);
    try {
      const answer = await api(foldersUrl({ path: String(to ?? '').trim(), hidden: showHidden, added: o.added() }));
      if (mine !== asked) return;
      listing = answer;
      lastPlace = answer.error ? lastPlace : answer.path;
      draw(focus);
    } catch (e) {
      if (mine !== asked) return;
      // Not a whole path, or the workbench did not answer: said where the list is; the path line keeps what was typed.
      say(e.message);
      more.textContent = '';
    } finally { clearTimeout(slow); }
  }

  function goUp() {
    if (!listing || listing.parent === null) return;
    void load(listing.parent, { focus: { from: listing.path } });
  }

  function choose() {
    if (!listing || listing.error || (listing.added && !o.chooseAdded)) return;
    o.onAdd(listing.path);
    if (o.single) { close(); return; }
    // Still open: a project often has more than one location. The folder now shows as added, here and in the list above it.
    void load(listing.path, { focus: 'keep' });
    done.focus({ preventScroll: true });
  }

  function onKey(e) {
    if (!panel.isConnected) { detach(); return; }   // the dialog went on to other content with the panel open
    if (!isOpen() || e.isComposing) return;   // a key that belongs to an input method composing a name is not the panel's
    byKeys = true;
    const inPanel = panel.contains(e.target);
    const where = e.target === path ? 'path' : inPanel && e.target.classList?.contains('fc-row') ? 'row' : 'other';
    // Escape closes the panel wherever the focus is in the dialog; every other key is the panel's only inside it.
    if (e.key === 'Enter' && where === 'path') { e.preventDefault(); void load(path.value, { focus: 'list' }); return; }
    const action = chooserKey(e, where);
    if (!action || (action !== 'close' && !inPanel)) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === 'close') { close(); return; }
    if (action === 'up') { goUp(); return; }
    const all = rows();
    if (all.length === 0) return;
    const at = all.indexOf(e.target);
    const next = action === 'first' ? 0 : action === 'last' ? all.length - 1 : action === 'next' ? Math.min(all.length - 1, at + 1) : Math.max(0, at - 1);
    all[next].focus({ preventScroll: true, focusVisible: true });
    all[next].scrollIntoView({ block: 'nearest' });
  }
  /** The dialog's own answer to Escape (it would close): the panel closes instead. */
  function onCancel(e) {
    if (!panel.isConnected) { detach(); return; }
    if (!isOpen()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  }
  function detach() {
    host?.removeEventListener('keydown', onKey, true);
    host?.removeEventListener('cancel', onCancel, true);
    host?.removeEventListener('close', detach);
    host = null;
  }

  async function open() {
    if (isOpen()) return;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('active');
    host = panel.closest('dialog') ?? panel.ownerDocument;
    host.addEventListener('keydown', onKey, true);
    host.addEventListener('cancel', onCancel, true);
    host.addEventListener('close', detach);   // the dialog closed with the panel open: nothing of it stays behind
    say('Reading…');
    listing = null;
    const first = o.start?.() || lastPlace || '';
    await load(first, { focus: 'list' });
    // What the field holds may be no whole path (a name half typed): the panel then opens at the home directory.
    if (listing === null && first && isOpen()) await load('', { focus: 'list' });
  }

  function close() {
    if (!isOpen()) return;
    asked++;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.classList.remove('active');
    detach();
    if (button.isConnected) button.focus({ preventScroll: true });
  }

  return { button, panel, open, close, isOpen };
}
