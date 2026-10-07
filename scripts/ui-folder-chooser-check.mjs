// The folder chooser where a location is typed (ui/folder-chooser.js, src/server/folders-api.ts; owner 2026-10-06:
// 「add这个locations帮我换成可以有对话框自己选一下」) — in a real browser. Usage:
//   node scripts/ui-folder-chooser-check.mjs <outDir> [--port 4961] [--tree <dir to build the invented folders in>]
//
// A fresh home on a spare port, with organizing off: nothing runs and no request leaves this machine. An invented tree
// (an allotment: an orchard that is a repository, a worktree of it, a meadow, a nursery of 640 trays) is built in a
// temporary directory, and this process's home directory is pointed into it, so the chooser's `Home` and everything a
// screenshot shows is invented. `Add project` is used as the owner would: `Browse…`, into folders by mouse and by
// keys, `Add this folder` twice, a third location typed by hand, Escape, then the project added; then `Project scope`
// → `Add item` → `Browse…` → `Use this folder`. Screenshots: the chooser open in each theme, and in a narrow window.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './ui-cdp.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const outDir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) ?? join(tmpdir(), 'pk-folder-chooser-shots');
const port = Number(flag('--port', '4961'));
if (port === 4870) throw new Error('4870 is the resident Keeper’s port; choose another');
mkdirSync(outDir, { recursive: true });

// ── the invented tree, and a home directory inside it ──
const treeBase = resolve(flag('--tree', tmpdir()));
mkdirSync(treeBase, { recursive: true });
const tree = mkdtempSync(join(treeBase, 'allotment-'));
const home = join(tree, 'home');
const projects = join(home, 'projects');
for (const d of ['notes', 'photos', 'projects/orchard/docs', 'projects/orchard/src', 'projects/meadow/hay', 'projects/seed-store', 'projects/.cache']) mkdirSync(join(home, d), { recursive: true });
for (let i = 1; i <= 640; i++) mkdirSync(join(projects, 'nursery', `tray-${String(i).padStart(4, '0')}`), { recursive: true });
writeFileSync(join(projects, 'orchard', 'README.md'), '# Orchard\n\nKeeps the grafting calendar.\n');
writeFileSync(join(projects, 'orchard', 'docs', 'plan.md'), '# Plan\n\nGraft in March.\n');
const ENV = { GIT_AUTHOR_NAME: 'Orchard Dev', GIT_AUTHOR_EMAIL: 'dev@orchard.invalid', GIT_COMMITTER_NAME: 'Orchard Dev', GIT_COMMITTER_EMAIL: 'dev@orchard.invalid' };
const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', env: { ...process.env, ...ENV }, windowsHide: true }).trim();
git(join(projects, 'orchard'), 'init', '-q');
git(join(projects, 'orchard'), 'config', 'core.autocrlf', 'false');
git(join(projects, 'orchard'), 'config', 'user.name', ENV.GIT_AUTHOR_NAME);
git(join(projects, 'orchard'), 'config', 'user.email', ENV.GIT_AUTHOR_EMAIL);
git(join(projects, 'orchard'), 'add', '--', '.');
git(join(projects, 'orchard'), 'commit', '-qm', 'Orchard: the README and the plan');
git(join(projects, 'orchard'), 'worktree', 'add', '-q', join(projects, 'orchard-grafting'), '-b', 'grafting');
symlinkSync(join(projects, 'meadow'), join(projects, 'shed-link'), process.platform === 'win32' ? 'junction' : 'dir');
// A home directory has a hidden folder of the system's own, and programs started with this home write into it.
if (process.platform === 'win32') { mkdirSync(join(home, 'AppData')); execFileSync('attrib', ['+h', join(home, 'AppData')], { windowsHide: true }); } else mkdirSync(join(home, '.config'));

// The browser is started first, with the environment as it is: it needs the real home directory to start in.
const b = await launch({ width: 1280, height: 860 });
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-fc-pi-'));
for (const k of Object.keys(process.env)) if (/_API_KEY$|_TOKEN$/.test(k)) delete process.env[k];
const { App } = await import('../src/server/app.ts');
const { HttpApp } = await import('../src/server/http.ts');
const { registerRoutes } = await import('../src/server/api.ts');
const { canonicalPath } = await import('../src/util/paths.ts');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const app = new App(mkdtempSync(join(tmpdir(), 'pk-fc-home-')), { organizing: false });
await app.initKeeper();
const http = new HttpApp();
registerRoutes(http, app, join(appRoot, 'ui'), join(appRoot, 'node_modules'));
http.route('GET', '/api/events', ({ res }) => { http.sse.attach(res); });
app.on('event', (event) => http.sse.broadcast('app', event));
app.servedPort = port;
const server = await http.listen(port);
const base = `http://127.0.0.1:${server.port}`;

const HOME = canonicalPath(home);
const PROJECTS = canonicalPath(projects);
const at = (...parts) => join(PROJECTS, ...parts);

const page = (body) => b.evaluate(`(async () => { const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)]; ${body} })()`);
const settle = async (ms = 250) => { await sleep(ms); await b.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'); };
/** The panel as the page shows it. */
const shown = () => page(`const p = $('#dialog .fc'); if (!p) return null; const a = document.activeElement; return {
  open: !p.hidden, dialog: $('#dialog').open, path: $('.fc-path', p).value, upDisabled: $('.fc-up', p).disabled,
  rows: $$('.fc-row', p).map((r) => ({ name: $('.fc-name', r).textContent, tags: $$('.tag', r).map((t) => t.textContent), dim: r.classList.contains('dim') })),
  empty: $('.fc-empty', p)?.textContent ?? null, more: $('.fc-more', p).textContent, hiddenLabel: $('.fc-hidden span', p).textContent,
  starts: $$('.fc-starts .btn', p).map((s) => s.textContent), here: $('.fc-here-name', p)?.textContent ?? null, hereTags: $$('.fc-here .tag', p).map((t) => t.textContent),
  add: { text: $('.fc-foot .btn', p).textContent, disabled: $('.fc-foot .btn', p).disabled },
  ring: Boolean(a?.matches?.(':focus-visible')),
  focus: a?.classList.contains('fc-row') ? 'row:' + $('.fc-name', a).textContent : a?.classList.contains('fc-path') ? 'path' : a?.classList.contains('fc-browse') ? 'browse' : a?.closest?.('.fc') ? 'panel:' + a.textContent : a?.tagName ?? null,
  expanded: $('#dialog .fc-browse').getAttribute('aria-expanded'),
};`);
const names = (s) => s.rows.map((r) => r.name).join(' ');
const waitPath = async (want, label) => { await b.waitFor(`document.querySelector('#dialog .fc-path')?.value === ${JSON.stringify(want)} && !/Reading/.test(document.querySelector('#dialog .fc-list')?.textContent ?? '')`, { label: label ?? `the panel at ${want}`, timeout: 10000 }); await settle(); return shown(); };
/** A real click on the element, brought into view first: the dialog scrolls. */
const press = async (selector) => { await page(`$(${JSON.stringify(selector)}).scrollIntoView({ block: 'nearest' }); return true;`); await settle(60); return b.clickOn(selector); };
const typePath = async (text) => { await press('#dialog .fc-path'); await page(`$('#dialog .fc-path').select(); return true;`); await b.type(text); await b.key('Enter'); };
const field = (selector) => page(`return $(${JSON.stringify(selector)}).value;`);
const openAddProject = async () => {
  await page(`[...document.querySelectorAll('button')].find((x) => x.textContent === 'Add project' && x.closest('.empty')).click(); return true;`);
  await b.waitFor(`document.querySelector('#dialog')?.open && document.querySelector('#dialog-title')?.textContent === 'Add project'`, { label: 'the Add project dialog' });
  await settle();
};
const setTheme = async (id) => { await page(`try { localStorage.setItem('pk.theme', ${JSON.stringify(id)}); } catch {} return true;`); await b.navigate(`${base}/`); await sleep(300); await b.waitFor(`document.querySelector('.empty .btn.primary') !== null && document.readyState === 'complete'`, { label: `the page under theme ${id || 'factory'}`, timeout: 20000 }); await settle(600); };
// The pointer is put aside first: a row it happens to rest on is drawn as hovered, which reads as chosen.
const shot = async (name) => { await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none', buttons: 0 }); await settle(150); const file = await b.shot(join(outDir, name)); console.log(`     ${file}`); };

try {
  await b.navigate(`${base}/`);
  await b.waitFor(`document.querySelector('.empty .btn.primary') !== null`, { label: 'the empty workbench', timeout: 20000 });
  await settle(600);

  // ── Add project: the field as it was, and Browse… beside it ──
  await openAddProject();
  const before = await page(`const d = $('#dialog'); const f = $('textarea.input', d).closest('.field'); return { label: $('label', f).textContent, browse: $('.fc-browse', f)?.textContent ?? null, panelHidden: $('.fc', f)?.hidden ?? null, textarea: $('textarea', f).placeholder.length > 0, focus: document.activeElement?.placeholder ?? null };`);
  check('Add project: Locations keeps its textarea, with Browse… beside the label and the panel closed', before.label === 'Locations' && before.browse === 'Browse…' && before.panelHidden === true && before.textarea && before.focus === 'Project name', JSON.stringify(before));

  await press('#dialog .fc-browse');
  let s = await waitPath(HOME, 'the panel opened at the home directory');
  check('Browse… opens the panel in the dialog at the home directory: its folders without the hidden one, the quick starts, the first folder in focus', s.open && s.dialog && names(s) === 'notes photos projects' && s.starts[0] === 'Home' && s.starts.length >= 2 && s.focus === 'row:notes' && s.expanded === 'true' && s.here === 'home' && s.hiddenLabel === 'Show hidden (1)', JSON.stringify({ rows: names(s), starts: s.starts, focus: s.focus, here: s.here, hidden: s.hiddenLabel }));
  check(process.platform === 'win32' ? 'the quick starts are Home and the drives' : 'the quick starts are Home and /', process.platform === 'win32' ? s.starts.slice(1).every((x) => /^[A-Z]:$/.test(x)) : s.starts.join() === 'Home,/', s.starts.join(' '));

  // ── by keys: down, down, Enter goes in ──
  await b.key('ArrowDown'); await b.key('ArrowDown');
  s = await shown();
  check('ArrowDown walks the list, and the folder in focus is drawn as such', s.focus === 'row:projects' && s.ring, JSON.stringify({ focus: s.focus, ring: s.ring }));
  await b.key('Enter');
  s = await waitPath(PROJECTS);
  check('Enter goes into the folder in focus: its folders by name, the repository and the worktree marked, the link marked, the hidden one left out and counted', names(s) === 'meadow nursery orchard orchard-grafting seed-store shed-link' && s.rows[2].tags.join() === 'git' && s.rows[3].tags.join() === 'git' && s.rows[5].tags.join() === 'link' && s.rows[0].tags.length === 0 && s.hiddenLabel === 'Show hidden (1)' && s.focus === 'row:meadow', JSON.stringify({ rows: s.rows.map((r) => `${r.name}[${r.tags}]`), hidden: s.hiddenLabel, focus: s.focus }));

  // ── by mouse: into the repository, Add this folder; the panel stays open ──
  await page(`$$('#dialog .fc-row').find((r) => r.textContent.startsWith('orchard') && !r.textContent.includes('grafting')).scrollIntoView({ block: 'nearest' }); return true;`);
  const orchardRow = await page(`const r = $$('#dialog .fc-row').find((x) => $('.fc-name', x).textContent === 'orchard').getBoundingClientRect(); return { x: r.left + 60, y: r.top + r.height / 2 };`);
  await b.click(orchardRow.x, orchardRow.y);
  s = await waitPath(at('orchard'));
  check('a click goes into a folder; where you are is named with its mark', names(s) === 'docs src' && s.here === 'orchard' && s.hereTags.join() === 'git' && s.add.text === 'Add this folder' && !s.add.disabled, JSON.stringify({ rows: names(s), here: s.here, tags: s.hereTags, add: s.add }));
  await page(`$('#dialog .fc-foot .btn').scrollIntoView({ block: 'nearest' }); return true;`);
  await press('#dialog .fc-foot .btn');
  await b.waitFor(`document.querySelector('#dialog textarea').value !== ''`, { label: 'the location written' });
  await settle(400);
  s = await shown();
  check('Add this folder writes its path as a line of Locations and leaves the panel open; the folder now shows as added', (await field('#dialog textarea')) === at('orchard') && s.open && s.add.disabled && s.hereTags.join() === 'git,added', JSON.stringify({ value: await field('#dialog textarea'), open: s.open, add: s.add, tags: s.hereTags, focus: s.focus }));

  // ── Backspace goes up, and the folder left is the one in focus, marked as added ──
  await b.key('Backspace');
  s = await waitPath(PROJECTS);
  check('Backspace goes up one level; the folder that was left is in focus and marked added', s.focus === 'row:orchard' && s.rows[2].tags.join() === 'git,added', JSON.stringify({ focus: s.focus, tags: s.rows[2].tags }));
  await b.key('ArrowDown'); await b.key('Enter');
  s = await waitPath(at('orchard-grafting'));
  await press('#dialog .fc-foot .btn');
  await b.waitFor(`document.querySelector('#dialog textarea').value.split('\\n').length === 2`, { label: 'the second location written' });
  check('a second folder is added the same way: two lines, the worktree after the repository', (await field('#dialog textarea')) === `${at('orchard')}\n${at('orchard-grafting')}`, await field('#dialog textarea'));
  await settle(300);

  // ── Alt+Up goes up from anywhere in the panel, the path line too ──
  await press('#dialog .fc-path');
  await b.key('ArrowUp', 1);
  s = await waitPath(PROJECTS);
  check('Alt+Up goes up from the path line, and the folder that was left is in focus, drawn as such', s.focus === 'row:orchard-grafting' && s.ring && s.rows[3].tags.join() === 'git,added', JSON.stringify({ focus: s.focus, ring: s.ring, tags: s.rows[3].tags }));

  for (const [theme, file] of [['d2', 'chooser-add-project-d2.png'], ['b1', 'chooser-add-project-b1.png'], ['i1', 'chooser-add-project-i1.png'], ['', 'chooser-add-project-factory.png'], ['a1', 'chooser-add-project-a1.png']]) {
    const typed = await field('#dialog textarea');
    await setTheme(theme);
    await openAddProject();
    await page(`const n = $('#dialog input.input'); n.value = 'Orchard'; const t = $('#dialog textarea'); t.value = ${JSON.stringify(typed)}; return true;`);
    await press('#dialog .fc-browse');
    await waitPath(at('orchard-grafting'), 'the panel opens where the last line of the field points');
    await b.key('ArrowUp', 1);
    await waitPath(PROJECTS);
    await settle(400);
    await shot(file);
  }
  s = await shown();
  check('opened again, the panel starts where the last line of the field points', s.open && s.rows[2].tags.join() === 'git,added' && s.rows[3].tags.join() === 'git,added', JSON.stringify(s.rows.map((r) => `${r.name}[${r.tags}]`)));

  // ── a typed path; a folder with a great many entries ──
  await typePath(at('nursery'));
  s = await waitPath(at('nursery'));
  check('a path typed into the path line and Enter goes there; of 640 folders 500 are listed and the rest counted', s.rows.length === 500 && s.rows[0].name === 'tray-0001' && s.more === '140 more folders are not shown. Type a path above to go to one.', JSON.stringify({ rows: s.rows.length, first: s.rows[0]?.name, more: s.more }));
  await shot('chooser-many-folders.png');

  // ── what cannot be listed says so in the list's place, and the panel stays usable ──
  await typePath(at('orchard', 'no-such-plot'));
  s = await waitPath(at('orchard', 'no-such-plot'));
  check('a path that does not exist says so where the list is; Add is off and Up still leads out', s.rows.length === 0 && s.empty === 'There is no such folder.' && s.add.disabled && !s.upDisabled, JSON.stringify({ empty: s.empty, add: s.add, up: s.upDisabled }));
  await press('#dialog .fc-up');
  s = await waitPath(at('orchard'));
  check('Up from there is the folder above', names(s) === 'docs src', names(s));
  await typePath('orchard');
  await b.waitFor(`/whole path/.test(document.querySelector('#dialog .fc-empty')?.textContent ?? '')`, { label: 'a path that is not whole is refused in place' });
  s = await shown();
  check('a path that is not whole is answered where the list is, and what was typed stays to be corrected', /^Give the whole path of a folder/.test(s.empty) && s.path === 'orchard' && s.open, JSON.stringify({ empty: s.empty, path: s.path }));
  await page(`$$('#dialog .fc-starts .btn')[0].click(); return true;`);
  s = await waitPath(HOME);
  check('a quick start leads out of it: Home', names(s) === 'notes photos projects', names(s));

  // ── hidden folders, when asked for ──
  await typePath(PROJECTS);
  await waitPath(PROJECTS);
  await press('#dialog .fc-hidden input');
  await b.waitFor(`[...document.querySelectorAll('#dialog .fc-row')].some((r) => r.textContent.startsWith('.cache'))`, { label: 'the hidden folder listed' });
  s = await shown();
  check('Show hidden lists the hidden folder too, drawn fainter', s.rows[0].name === '.cache' && s.rows[0].dim && s.rows.length === 7 && !s.rows[1].dim, JSON.stringify(s.rows.map((r) => `${r.name}${r.dim ? '(dim)' : ''}`)));
  await press('#dialog .fc-hidden input');
  await b.waitFor(`![...document.querySelectorAll('#dialog .fc-row')].some((r) => r.textContent.startsWith('.cache'))`, { label: 'the hidden folder left out again' });

  // ── a narrow window ──
  await b.setViewport(420, 780);
  await settle(500);
  const narrow = await page(`const p = $('#dialog .fc').getBoundingClientRect(); const d = $('#dialog').getBoundingClientRect(); const over = $$('#dialog .fc *').filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > p.right + 0.5 || r.left < p.left - 0.5); }).map((e) => e.className || e.tagName); return { panel: [Math.round(p.left), Math.round(p.right)], dialog: [Math.round(d.left), Math.round(d.right)], over, sideways: document.documentElement.scrollWidth > innerWidth };`);
  check('in a narrow window the panel stays inside the dialog and nothing sticks out of it', narrow.over.length === 0 && narrow.panel[0] >= narrow.dialog[0] && narrow.panel[1] <= narrow.dialog[1] && !narrow.sideways, JSON.stringify(narrow));
  await page(`$('#dialog .fc').scrollIntoView({ block: 'start' }); return true;`);
  await settle(300);
  await shot('chooser-add-project-narrow.png');
  await b.setViewport(1280, 860);
  await settle(400);

  // ── Escape closes the panel, not the dialog; the field is still a field ──
  await press('#dialog .fc-path');
  await b.key('Escape');
  await settle(300);
  s = await shown();
  check('Escape closes the panel and not the dialog; focus is back on Browse…', !s.open && s.dialog && s.focus === 'browse' && s.expanded === 'false', JSON.stringify({ open: s.open, dialog: s.dialog, focus: s.focus }));
  await press('#dialog textarea');
  await page(`const t = $('#dialog textarea'); t.setSelectionRange(t.value.length, t.value.length); return true;`);
  await b.type(`\n${at('meadow')}`);
  check('a location is still typed by hand: a third line', (await field('#dialog textarea')) === `${at('orchard')}\n${at('orchard-grafting')}\n${at('meadow')}`, await field('#dialog textarea'));
  await press('#dialog .fc-browse');
  s = await waitPath(at('meadow'));
  check('opened again it starts at the typed line, which counts as added', s.hereTags.join() === 'added' && s.add.disabled && names(s) === 'hay', JSON.stringify({ tags: s.hereTags, add: s.add, rows: names(s) }));
  await b.key('Escape');
  await settle(200);
  await b.key('Escape');
  await settle(300);
  check('with the panel closed, Escape closes the dialog as before', (await page(`return $('#dialog').open;`)) === false);

  // ── the project is added with what the field holds ──
  await openAddProject();
  await page(`$('#dialog input.input').focus(); return true;`);
  await b.type('Orchard');
  await press('#dialog .fc-browse');
  await waitPath(at('meadow'), 'the panel opens where the last one was left');
  await typePath(at('orchard'));
  await waitPath(at('orchard'));
  await press('#dialog .fc-foot .btn');
  await b.waitFor(`document.querySelector('#dialog textarea').value !== ''`, { label: 'the location written' });
  await b.key('Backspace');
  await waitPath(PROJECTS);
  await b.key('ArrowDown'); await b.key('Enter');
  await waitPath(at('orchard-grafting'));
  await press('#dialog .fc-foot .btn');
  await b.waitFor(`document.querySelector('#dialog textarea').value.split('\\n').length === 2`, { label: 'the second location written' });
  await page(`[...document.querySelectorAll('#dialog .dialog-foot .btn.primary')].find((x) => x.textContent === 'Add project').click(); return true;`);
  await b.waitFor(`!document.querySelector('#dialog').open && /#\\/p\\/[^/]+\\/keeper/.test(location.hash)`, { label: 'the project added and its Takeover page opened', timeout: 30000 });
  const project = app.workspace.list()[0];
  check('Add project adds the project with the folders chosen', app.workspace.list().length === 1 && project.name === 'Orchard' && project.locations.join('|') === [at('orchard'), at('orchard-grafting')].join('|'), JSON.stringify({ name: project?.name, locations: project?.locations?.map((l) => l.slice(PROJECTS.length + 1)) }));

  // ── Project scope → Add item: the same panel, for one folder ──
  await b.navigate(`${base}/#/p/${encodeURIComponent(project.id)}/scope`);
  await b.waitFor(`[...document.querySelectorAll('.page-head .btn')].some((x) => x.textContent === 'Add item')`, { label: 'the Project scope page', timeout: 30000 });
  await settle(600);
  await page(`[...document.querySelectorAll('.page-head .btn')].find((x) => x.textContent === 'Add item').click(); return true;`);
  await b.waitFor(`document.querySelector('#dialog')?.open && document.querySelector('#dialog-title')?.textContent === 'Add scope item'`, { label: 'the Add scope item dialog' });
  await settle();
  await press('#dialog .fc-browse');
  s = await waitPath(at('orchard'), 'the panel opened at the project’s first location');
  check('Add scope item: Browse… opens at the project’s first location, with Use this folder for the one path wanted', s.open && s.add.text === 'Use this folder' && !s.add.disabled && s.hereTags.join() === 'git' && names(s) === 'docs src' && s.focus === 'row:docs', JSON.stringify({ add: s.add, tags: s.hereTags, rows: names(s), focus: s.focus }));
  await shot('chooser-scope-item.png');
  await b.key('Enter');
  s = await waitPath(at('orchard', 'docs'));
  await press('#dialog .fc-foot .btn');
  await settle(300);
  s = await shown();
  check('Use this folder writes the path into the field and closes the panel; the dialog stays', (await field('#dialog input.input')) === at('orchard', 'docs') && !s.open && s.dialog && s.focus === 'browse', JSON.stringify({ value: await field('#dialog input.input'), open: s.open, dialog: s.dialog, focus: s.focus }));
  await press('#dialog .fc-browse');
  await waitPath(at('orchard', 'docs'));
  await b.key('Escape');
  await settle(300);
  s = await shown();
  check('there too Escape closes the panel and not the dialog', !s.open && s.dialog, JSON.stringify({ open: s.open, dialog: s.dialog }));
  await page(`$('#dialog input[placeholder^="Why it belongs"]').focus(); return true;`);
  await b.type('The plans live here');
  await page(`[...document.querySelectorAll('#dialog .dialog-foot .btn.primary')].find((x) => x.textContent === 'Add').click(); return true;`);
  await b.waitFor(`!document.querySelector('#dialog').open`, { label: 'the scope item added', timeout: 30000 });
  const item = app.project(project.id).scope.find((i) => i.path === at('orchard', 'docs'));
  check('the scope item is added with the folder chosen', Boolean(item) && item.reason === 'The plans live here', JSON.stringify(item ? { category: item.category, relation: item.relation, reason: item.reason } : null));

  // A folder that is in scope by now is marked, and can be chosen again (the item for it is replaced).
  await b.waitFor(`[...document.querySelectorAll('.page-head .btn')].some((x) => x.textContent === 'Add item')`, { label: 'the Project scope page again', timeout: 30000 });
  await settle(600);
  await page(`[...document.querySelectorAll('.page-head .btn')].find((x) => x.textContent === 'Add item').click(); return true;`);
  await b.waitFor(`document.querySelector('#dialog')?.open && document.querySelector('#dialog-title')?.textContent === 'Add scope item'`, { label: 'the Add scope item dialog again' });
  await settle();
  await press('#dialog .fc-browse');
  s = await waitPath(at('orchard'), 'the panel at the project’s first location again');
  const docs = s.rows.find((r) => r.name === 'docs');
  await b.key('Enter');
  const inside = await waitPath(at('orchard', 'docs'));
  check('a folder already in scope is marked so, in the list and where you are, and can still be chosen', docs?.tags.join() === 'in scope' && s.focus === 'row:docs' && inside.hereTags.join() === 'in scope' && !inside.add.disabled, JSON.stringify({ row: docs?.tags, focus: s.focus, here: inside.hereTags, add: inside.add }));
  await b.key('Escape');
  await settle(200);
  await b.key('Escape');
  await settle(300);

  check('no error in the browser console', b.consoleLines.length === 0, b.consoleLines.slice(0, 5).join(' | '));
} catch (e) {
  check('the check ran to its end', false, e.message);
  try { await shot('chooser-where-it-stopped.png'); } catch { /* the browser is gone */ }
} finally {
  await b.close();
  app.stopAll();
  await server.close();
  try { rmSync(tree, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left in the temporary directory */ }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed; screenshots in ${outDir}`);
process.exit(failed.length ? 1 : 0);
