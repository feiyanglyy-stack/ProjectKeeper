/**
 * `GET /api/folders` (folders-api.ts): the folders of one directory, for the folder chooser. Every tree here is made in
 * a temporary directory, with invented names (an allotment: plots, a shed, a seed store).
 *
 *   - what is listed: folders only, by name, a link when it leads to a directory; hidden ones only when asked;
 *   - the marks: a repository (`.git` as a directory), a worktree (`.git` as a file), a folder the page already holds;
 *   - what cannot be listed says why and still gives the way up: no such folder, a file, a folder that refuses reading;
 *   - what must not hang or grow: thousands of entries, a link that leads back up, links in a ring, a drive that does
 *     not answer;
 *   - a path in another spelling is answered in the file system's own;
 *   - over HTTP it stands behind the same check as every route.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join, parse, sep } from 'node:path';
import { tmpdir } from '../util/tmp.test-helpers.ts';

const scratch = mkdtempSync(join(tmpdir(), 'pk-folders-'));
process.env.PI_CODING_AGENT_DIR = join(scratch, 'pi-agent');
after(() => { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const { listFolders, registerFolderRoutes, SHOWN } = await import('./folders-api.ts');
const { HttpApp, HttpError } = await import('./http.ts');
const { App } = await import('./app.ts');
const { registerRoutes } = await import('./api.ts');

const WIN = process.platform === 'win32';
const ENV = { GIT_AUTHOR_NAME: 'Allotment Dev', GIT_AUTHOR_EMAIL: 'dev@allotment.invalid', GIT_COMMITTER_NAME: 'Allotment Dev', GIT_COMMITTER_EMAIL: 'dev@allotment.invalid' };
const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV }, windowsHide: true }).trim();

/** A fresh directory under the scratch, with the folders and files named (a name ending in `/` is a folder). */
function tree(name: string, entries: string[] = []): string {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  for (const e of entries) {
    if (e.endsWith('/')) mkdirSync(join(dir, e), { recursive: true });
    else { mkdirSync(dirname(join(dir, e)), { recursive: true }); writeFileSync(join(dir, e), 'x\n'); }
  }
  return dir;
}
/** A link to a directory that needs no special right: a junction on Windows. */
const linkDir = (target: string, path: string): void => symlinkSync(target, path, WIN ? 'junction' : 'dir');
const names = (l: { folders: { name: string }[] }): string[] => l.folders.map((f) => f.name);

test('an empty folder: nothing listed, nothing wrong, and the way up', async () => {
  const dir = tree('fallow');
  const l = await listFolders({ path: dir });
  assert.deepEqual([l.path, l.name, l.parent, l.sep, l.error], [dir, parse(dir).base, scratch, sep, null]);
  assert.deepEqual([l.folders, l.more, l.hidden, l.repository, l.added], [[], 0, 0, false, false]);
});

test('folders only, by name, numbers in their order and case set aside', async () => {
  const dir = tree('allotment', ['plot-10/', 'plot-2/', 'Shed/', 'seed store/', 'plot-1/rows/', 'notes.md', 'plan.txt', 'shed.log']);
  const l = await listFolders({ path: dir });
  assert.deepEqual(names(l), ['plot-1', 'plot-2', 'plot-10', 'seed store', 'Shed']);
  assert.deepEqual(l.folders[0], { name: 'plot-1', path: join(dir, 'plot-1'), repository: false, hidden: false, link: false, added: false });
  assert.equal(l.more, 0);
});

test('a folder with a great many entries: the first ones in name order, and how many more', { timeout: 120_000 }, async () => {
  const count = SHOWN + 140;
  const dir = tree('nursery', [...Array.from({ length: count }, (_, i) => `tray-${String(i + 1).padStart(4, '0')}/`), ...Array.from({ length: 300 }, (_, i) => `label-${i}.txt`)]);
  const started = Date.now();
  const l = await listFolders({ path: dir });
  const took = Date.now() - started;
  assert.equal(l.folders.length, SHOWN);
  assert.equal(l.more, 140);
  assert.equal(l.folders[0]!.name, 'tray-0001');
  assert.equal(l.folders[SHOWN - 1]!.name, `tray-${String(SHOWN).padStart(4, '0')}`);
  assert.ok(took < 5000, `listed in ${took} ms`);
  const few = await listFolders({ path: dir }, { shown: 12 });
  assert.deepEqual([few.folders.length, few.more], [12, count - 12]);
});

test('a repository is marked, and so is a worktree, whose .git is a file', async () => {
  const dir = tree('orchard-work', ['orchard/README.md', 'cuttings/list.md', 'almost/.gitignore']);
  const repo = join(dir, 'orchard');
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'user.name', ENV.GIT_AUTHOR_NAME);
  git(repo, 'config', 'user.email', ENV.GIT_AUTHOR_EMAIL);
  git(repo, 'add', '--', 'README.md');
  git(repo, 'commit', '-qm', 'Orchard: the README');
  git(repo, 'worktree', 'add', '-q', join(dir, 'orchard-grafting'), '-b', 'grafting');
  const l = await listFolders({ path: dir });
  assert.deepEqual(l.folders.map((f) => [f.name, f.repository]), [['almost', false], ['cuttings', false], ['orchard', true], ['orchard-grafting', true]]);
  assert.equal(l.repository, false, 'the folder that holds them is not one');
  assert.equal((await listFolders({ path: repo })).repository, true, 'inside the repository, the place itself is marked');
  assert.equal((await listFolders({ path: join(dir, 'orchard-grafting') })).repository, true, 'and inside the worktree');
  assert.deepEqual(names(await listFolders({ path: repo })), [], '.git itself is hidden');
  assert.deepEqual(names(await listFolders({ path: repo, hidden: true })), ['.git']);
});

test('hidden folders are left out until asked for, and counted', async () => {
  const dir = tree('shed', ['.cache/', '.tools/bench/', 'bench/', 'cellar/', '.notes']);
  if (WIN) execFileSync('attrib', ['+h', join(dir, 'cellar')], { windowsHide: true });
  const plain = await listFolders({ path: dir });
  assert.deepEqual(names(plain), WIN ? ['bench'] : ['bench', 'cellar']);
  assert.equal(plain.hidden, WIN ? 3 : 2);
  const all = await listFolders({ path: dir, hidden: true });
  assert.deepEqual(all.folders.map((f) => [f.name, f.hidden]), [['.cache', true], ['.tools', true], ['bench', false], ['cellar', WIN]]);
  assert.equal(all.hidden, plain.hidden);
});

test('a path that does not exist, and a file, say so and still give the way up', async () => {
  const dir = tree('plots', ['plot-1/', 'plan.txt']);
  const none = await listFolders({ path: join(dir, 'plot-9', 'rows') });
  assert.deepEqual([none.path, none.parent, none.error, none.folders], [join(dir, 'plot-9', 'rows'), join(dir, 'plot-9'), 'There is no such folder.', []]);
  const file = await listFolders({ path: join(dir, 'plan.txt') });
  assert.deepEqual([file.path, file.parent, file.error], [join(dir, 'plan.txt'), dir, 'This is a file, not a folder.']);
  assert.ok(none.starts.length >= 2 && file.starts.length >= 2, 'the quick starts are still given');
});

test('a folder that refuses reading is listed where it lies, and says so when entered', async (t) => {
  const dir = tree('gate', ['locked/inside/', 'open/']);
  const locked = join(dir, 'locked');
  // Everyone is refused reading (S-1-1-0); the owner keeps the right to undo it.
  const lock = (): void => { if (WIN) execFileSync('icacls', [locked, '/deny', '*S-1-1-0:(RX)'], { windowsHide: true, stdio: 'ignore' }); else chmodSync(locked, 0o000); };
  const unlock = (): void => { if (WIN) execFileSync('icacls', [locked, '/remove:d', '*S-1-1-0'], { windowsHide: true, stdio: 'ignore' }); else chmodSync(locked, 0o755); };
  try { lock(); } catch { t.skip('this system would not take reading away from a folder'); return; }
  try {
    const refused = await listFolders({ path: locked });
    if (refused.error === null) { t.skip('this user reads a folder whatever its permissions say'); return; }
    assert.equal(refused.error, 'This folder cannot be read: access to it is denied.');
    assert.deepEqual([refused.path, refused.parent, refused.folders], [locked, dir, []]);
    const around = await listFolders({ path: dir });
    assert.deepEqual(around.folders.map((f) => [f.name, f.repository]), [['locked', false], ['open', false]], 'the folder around it lists it like any other');
    assert.equal(around.error, null);
  } finally { unlock(); }
});

test('whatever the system says when a folder cannot be read, the chooser gets a sentence and the way up', async () => {
  const dir = tree('gatehouse', ['yard/']);
  const failing = (code: string) => (): Promise<never> => Promise.reject(Object.assign(new Error(`${code}: scandir`), { code }));
  for (const [code, said] of [
    ['EACCES', 'This folder cannot be read: access to it is denied.'],
    ['EPERM', 'This folder cannot be read: access to it is denied.'],
    ['ELOOP', 'This folder cannot be read: it is a link that leads back to itself.'],
    ['EIO', 'This folder cannot be read (EIO).'],
    ['ENOENT', 'There is no such folder.'],   // removed between the look and the read
  ] as const) {
    const l = await listFolders({ path: join(dir, 'yard') }, { readEntries: failing(code) });
    assert.deepEqual([l.error, l.path, l.parent, l.folders, l.more], [said, join(dir, 'yard'), dir, [], 0], code);
    assert.ok(!(l.error ?? '').includes('scandir'), 'the system’s own wording is not passed on');
  }
});

test('a link that leads back up shows where it leads, and no path grows by going round', async () => {
  const dir = tree('maze', ['hedge/turn/']);
  linkDir(dir, join(dir, 'hedge', 'turn', 'back-to-start'));
  const turn = await listFolders({ path: join(dir, 'hedge', 'turn') });
  assert.deepEqual(turn.folders.map((f) => [f.name, f.link]), [['back-to-start', true]]);
  let at = turn.folders[0]!.path;
  for (let round = 0; round < 6; round++) {
    const here = await listFolders({ path: at });
    assert.equal(here.path, dir, `round ${round}: entering the link is being at the start`);
    assert.deepEqual(names(here), ['hedge']);
    at = join(here.folders[0]!.path, 'turn', 'back-to-start');
  }
  // Typed the long way round, it is the same place.
  const long = join(dir, 'hedge', 'turn', 'back-to-start', 'hedge', 'turn', 'back-to-start', 'hedge');
  assert.equal((await listFolders({ path: long })).path, join(dir, 'hedge'));
});

test('links in a ring, and a link that leads nowhere, are not folders; the listing does not wait on them', async () => {
  const dir = tree('ring', ['real/']);
  linkDir(join(dir, 'ring-b'), join(dir, 'ring-a'));
  linkDir(join(dir, 'ring-a'), join(dir, 'ring-b'));
  linkDir(join(dir, 'gone'), join(dir, 'to-nowhere'));
  linkDir(join(dir, 'real'), join(dir, 'to-real'));
  const started = Date.now();
  const l = await listFolders({ path: dir });
  assert.deepEqual(l.folders.map((f) => [f.name, f.link]), [['real', false], ['to-real', true]]);
  assert.equal(l.more, 0);
  assert.ok(Date.now() - started < 3000);
  const into = await listFolders({ path: join(dir, 'ring-a') });
  assert.match(into.error ?? '', /^(There is no such folder\.|This folder cannot be read)/, 'entered by its path, the ring says it cannot be read');
  assert.equal(into.parent, dir);
  // With no time to follow links, they are counted and not shown; what is a directory by itself still is.
  const hurried = await listFolders({ path: dir }, { marksMs: 0 });
  assert.deepEqual([names(hurried), hurried.more], [['real'], 4]);
});

test('a path in another spelling is answered in the file system’s own', async () => {
  const dir = tree('Greenhouse', ['Bench/pots/']);
  linkDir(join(dir, 'Bench'), join(dir, 'side-door'));
  const want = join(dir, 'Bench', 'pots');
  const spellings = [
    want + sep,
    join(dir, 'Bench', 'pots', '..', 'pots'),
    join(dir, 'side-door', 'pots'),
    `${dir}${sep}Bench${sep}${sep}pots`,
    ...(WIN ? [want.toUpperCase(), want.toLowerCase(), want.replaceAll('\\', '/')] : []),
  ];
  for (const s of spellings) {
    const l = await listFolders({ path: s });
    assert.equal(l.error, null, s);
    assert.equal(l.path, want, s);
    assert.equal(l.parent, join(dir, 'Bench'), s);
  }
});

test('only a whole path is taken; ~ is the home directory', async () => {
  const home = tree('home', ['projects/orchard/']);
  for (const path of ['orchard', `..${sep}orchard`, `.${sep}`, ...(WIN ? ['\\\\?\\C:\\', '\\\\.\\pipe', '\\orchard', 'C:orchard'] : [])]) {
    await assert.rejects(listFolders({ path }, { home }), (e: unknown) => e instanceof HttpError && e.status === 400 && /whole path/.test(e.message), path);
  }
  assert.equal((await listFolders({}, { home })).path, home, 'no path: the home directory');
  assert.equal((await listFolders({ path: '   ' }, { home })).path, home);
  assert.equal((await listFolders({ path: '~' }, { home })).path, home);
  assert.equal((await listFolders({ path: '~/projects' }, { home })).path, join(home, 'projects'));
  assert.deepEqual(names(await listFolders({ path: `~${sep}projects` }, { home })), ['orchard']);
  assert.equal((await listFolders({ path: join(home, '~') }, { home })).error, 'There is no such folder.', 'a ~ further in is a name');
});

test('the quick starts: the home directory, then the drives on Windows and / elsewhere', async () => {
  const home = tree('home');
  const l = await listFolders({ path: home }, { home });
  assert.deepEqual(l.starts[0], { label: 'Home', path: home, kind: 'home' });
  if (WIN) {
    const drives = l.starts.slice(1);
    assert.ok(drives.length >= 1 && drives.every((d) => d.kind === 'drive' && /^[A-Z]:\\$/.test(d.path) && d.label === d.path.slice(0, 2)), JSON.stringify(drives));
    assert.ok(drives.some((d) => d.path === parse(home).root.toUpperCase()), 'the drive this directory is on is among them');
    assert.deepEqual(drives.map((d) => d.path), [...new Set(drives.map((d) => d.path))].sort(), 'each once, in order');
    const top = await listFolders({ path: drives.find((d) => d.path === parse(home).root.toUpperCase())!.path.slice(0, 2) });
    assert.deepEqual([top.path.toUpperCase(), top.parent, top.error], [parse(home).root.toUpperCase(), null, null], 'a drive letter alone is the top of the drive, and nothing is above it');
  } else {
    assert.deepEqual(l.starts.slice(1), [{ label: '/', path: '/', kind: 'root' }]);
    const top = await listFolders({ path: '/' });
    assert.deepEqual([top.path, top.parent, top.error], ['/', null, null]);
  }
});

test('folders the page already holds are marked, however their paths were typed', async () => {
  const dir = tree('holdings', ['orchard/', 'orchard-grafting/', 'meadow/']);
  const typed = [join(dir, 'orchard') + sep, WIN ? join(dir, 'ORCHARD-grafting').replaceAll('\\', '/') : join(dir, 'orchard-grafting', '.'), 'meadow', ''];
  const l = await listFolders({ path: dir, added: typed });
  assert.deepEqual(l.folders.map((f) => [f.name, f.added]), [['meadow', false], ['orchard', true], ['orchard-grafting', true]]);
  assert.equal(l.added, false);
  assert.equal((await listFolders({ path: join(dir, 'orchard'), added: typed })).added, true, 'the place itself, when it is one of them');
});

test('a drive that does not answer is not waited for, and is asked nothing more until it does', async () => {
  const dir = tree('far-field', ['plot-1/']);
  let release: (v: { name: string; directory: boolean; link: boolean }[]) => void = () => {};
  let reads = 0;
  const readEntries = (): Promise<{ name: string; directory: boolean; link: boolean }[]> => { reads++; return new Promise((r) => { release = r; }); };
  const started = Date.now();
  const slow = await listFolders({ path: dir }, { answerMs: 150, readEntries });
  assert.ok(Date.now() - started < 2000, 'answered at the limit, not when the drive does');
  assert.match(slow.error ?? '', / did not answer within \d+ seconds?\. It may be a network drive that is not connected\.$/);
  assert.deepEqual([slow.path, slow.parent, slow.folders], [dir, dirname(dir), []]);
  assert.ok(slow.starts.length >= 2, 'the quick starts are given all the same: another drive can be gone to');
  // Asked again while the first read is still out: answered at once, and the drive is not read a second time.
  const again = await listFolders({ path: dirname(dir) }, { answerMs: 150, readEntries });
  assert.match(again.error ?? '', / has not answered yet\. /);
  assert.equal(reads, 1);
  // The drive answers at last, and is listed as before.
  release([]);
  await new Promise((r) => setTimeout(r, 20));
  const back = await listFolders({ path: dir });
  assert.deepEqual([back.error, names(back)], [null, ['plot-1']]);
});

// ───────────────────────── over HTTP ─────────────────────────

interface Answer { status: number; type: string; text: string }
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('over HTTP: the listing as the page asks for it, and a path that is not whole is a 400', async () => {
  const dir = tree('by-wire', ['orchard/', '.cache/', 'meadow/']);
  const http = new HttpApp();
  registerFolderRoutes(http);
  const server = await http.listen(0);
  try {
    const q = (o: Record<string, string | string[]>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) p.append(k, x); return `/api/folders?${p}`; };
    const a = await get(server.port, q({ path: dir, added: [join(dir, 'meadow'), join(dir, 'elsewhere')] }));
    assert.equal(a.status, 200);
    assert.match(a.type, /^application\/json/);
    const l = JSON.parse(a.text) as Awaited<ReturnType<typeof listFolders>>;
    assert.deepEqual([l.path, l.sep, l.error, l.hidden], [dir, sep, null, 1]);
    assert.deepEqual(l.folders.map((f) => [f.name, f.added]), [['meadow', true], ['orchard', false]]);
    const hidden = JSON.parse((await get(server.port, q({ path: dir, hidden: '1' }))).text) as typeof l;
    assert.deepEqual(names(hidden), ['.cache', 'meadow', 'orchard']);
    const bad = await get(server.port, q({ path: 'orchard' }));
    assert.equal(bad.status, 400);
    assert.match((JSON.parse(bad.text) as { error: string }).error, /whole path/);
    const home = JSON.parse((await get(server.port, '/api/folders')).text) as typeof l;
    assert.equal(home.path, home.starts[0]!.path, 'no path: the home directory');
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${q({ path: dir })}`, { method });
      assert.equal(res.status, 404, `${method}: the route only reads`);
    }
  } finally { await server.close(); }
});

test('over HTTP: the folders of this machine are not read out to another name, another origin or another site’s page', async () => {
  const dir = tree('private-garden', ['asparagus-bed/']);
  const home = mkdtempSync(join(scratch, 'home-'));
  const app = new App(home, { organizing: false });
  const http = new HttpApp();
  registerRoutes(http, app, '', '');
  const server = await http.listen(0);
  try {
    const path = `/api/folders?path=${encodeURIComponent(dir)}`;
    const port = server.port;
    const refused: [string, Record<string, string>][] = [
      ['a page whose own name resolves to 127.0.0.1', { Host: `attacker.example:${port}` }],
      ['the same, saying where it is from', { Host: `attacker.example:${port}`, Origin: `http://attacker.example:${port}` }],
      ['another site’s script', { Origin: 'http://attacker.example', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }],
      ['another origin with no fetch metadata', { Origin: 'http://attacker.example' }],
      ['another local program’s page', { Origin: `http://localhost:${port + 1}`, 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }],
      ['a script tag on another site', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' }],
      ['a link on another site that names the route', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }],
      ['a frame on another site', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' }],
      ['a sandboxed frame', { Origin: 'null' }],
    ];
    for (const [who, headers] of refused) {
      const a = await get(port, path, headers);
      assert.equal(a.status, 403, who);
      assert.ok(!a.text.includes('asparagus') && !a.text.includes('private-garden'), `${who}: no folder name in the answer`);
      const homeless = await get(port, '/api/folders', headers);
      assert.equal(homeless.status, 403, `${who}: nor the home directory`);
    }
    const own = await get(port, path, { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' });
    assert.equal(own.status, 200, 'the workbench’s own page is answered');
    assert.deepEqual((JSON.parse(own.text) as { folders: { name: string }[] }).folders.map((f) => f.name), ['asparagus-bed']);
    assert.equal(Object.keys((await fetch(`http://127.0.0.1:${port}${path}`)).headers).filter((h) => h.startsWith('access-control-')).length, 0);
  } finally { app.stopAll(); await server.close(); }
});
