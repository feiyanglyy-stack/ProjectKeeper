/**
 * One directory, several spellings.
 *
 * The first public CI run (2026-10-05) failed 40 tests on Windows for one reason: the runner's temporary directory is
 * `C:\Users\RUNNER~1\AppData\Local\Temp`, a short (8.3) name, while git reports the same directory by its long name,
 * and ProjectKeeper compared the two as text. A project given by the short name was then not a repository to it: no
 * worktrees, no ignore rules, no history, no commit of its own folder — and `npm run demo`, which builds its project
 * under the temporary directory, failed the same way for any user whose name is longer than eight characters.
 *
 * ProjectKeeper now keeps every location in the file system's own spelling (util/paths.ts `canonicalPath`). These
 * tests hand it the other spellings on purpose, each naming a directory that was built under its real name:
 *
 * - through a directory junction (a link, on other systems);
 * - in another case, drive letter included (Windows);
 * - by a real 8.3 short name, where one can be set (`fsutil file setshortname`, which needs an elevated shell: a
 *   GitHub runner has one);
 * - as the environment spells the temporary directory, where that is not the file system's spelling.
 *
 * The project is invented ("Kestrel", a bird-count sheet).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir as systemTmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalPath } from '../util/paths.ts';

const WIN = process.platform === 'win32';

// ───────────────────────── isolation from the machine ─────────────────────────

/** Everything this file makes, under the temporary directory as the environment spells it. */
const givenRoot = mkdtempSync(join(systemTmpdir(), 'pk-spelling-'));
const realRoot = canonicalPath(givenRoot);
const machine = join(realRoot, 'machine');
mkdirSync(join(machine, 'pi-agent'), { recursive: true });
writeFileSync(join(machine, 'gitconfig'), '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(machine, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  HOME: machine, USERPROFILE: machine, PI_CODING_AGENT_DIR: join(machine, 'pi-agent'),
});
for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[name];
after(() => { try { rmSync(givenRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* a watcher may still hold a handle; the system clears its temporary directory */ } });

const { App } = await import('../server/app.ts');
const { Workspace } = await import('../store/workspace.ts');
const { discoverScope } = await import('../scope/discover.ts');
const { grantProjectFolderAuthorization, syncProjectFolder } = await import('../keeper/project-folder.ts');
const { seedUiFixture } = await import('../../scripts/seed-ui-fixture.ts');

// ───────────────────────── the spellings ─────────────────────────

interface Spelling {
  readonly name: string;
  /** A directory made under its real name, and the same directory spelled the other way. */
  readonly make: () => { real: string; given: string } | null;
}

const fresh = (label: string): string => { const dir = join(realRoot, label); mkdirSync(dir, { recursive: true }); return dir; };
let made = 0;
const SPELLINGS: Spelling[] = [
  {
    name: 'through a junction',
    make: () => {
      const real = fresh(`junction-${made += 1}`);
      const given = `${real}-link`;
      symlinkSync(real, given, 'junction');
      return { real, given };
    },
  },
  {
    name: 'in another case',
    make: () => {
      if (!WIN) return null;   // names differing in case are different names there
      const real = fresh(`Case-${made += 1}`);
      const flipped = real.toUpperCase();
      return { real, given: (/^[A-Z]:/.test(real) ? real[0]!.toLowerCase() : real[0]!.toUpperCase()) + flipped.slice(1) };
    },
  },
  {
    name: 'by an 8.3 short name',
    make: () => {
      if (!WIN) return null;
      const real = fresh(`short-name-of-a-directory-${made += 1}`);
      const short = `PK${Math.random().toString(16).slice(2, 6).toUpperCase()}~1`;
      try { execFileSync('fsutil', ['file', 'setshortname', real, short], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return null; }
      const given = join(dirname(real), short);
      return existsSync(given) ? { real, given } : null;
    },
  },
  {
    name: 'as the environment spells the temporary directory',
    make: () => {
      if (givenRoot === realRoot) return null;   // the environment already spells it the file system's way
      const real = fresh(`environment-${made += 1}`);
      return { real, given: join(givenRoot, basename(real)) };
    },
  },
];

/** Run a check once for every spelling this machine can make; say which it could not. */
function forEachSpelling(title: string, body: (dirs: { real: string; given: string }) => Promise<void> | void): void {
  test(title, async (t) => {
    let ran = 0;
    for (const spelling of SPELLINGS) {
      const dirs = spelling.make();
      if (!dirs) { t.diagnostic(`not on this machine: ${spelling.name}`); continue; }
      assert.notEqual(dirs.given, dirs.real, `${spelling.name}: another spelling`);
      await t.test(spelling.name, () => body(dirs));
      ran += 1;
    }
    assert.ok(ran >= 1, 'at least the junction can be made everywhere');
  });
}

// ───────────────────────── the project ─────────────────────────

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Kestrel Dev', '-c', 'user.email=dev@kestrel.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const put = (root: string, rel: string, text: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

/** Kestrel under `base`, built by its real name: a repository, one ignored notes directory, one worktree with a commit of its own. */
function kestrel(base: string): { repo: string; worktree: string } {
  const repo = join(base, 'kestrel');
  const worktree = join(base, 'kestrel-tally');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(repo, '.gitignore', 'notes/\n');
  put(repo, 'README.md', '# Kestrel\n\nA sheet for counting birds from a hide.\n');
  put(repo, 'docs/plan.md', '# Plan\n\n- K-1 count by species\n');
  put(repo, 'notes/idea.md', '# Idea\n\nCount at dusk too.\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Kestrel: first version');
  git(repo, 'worktree', 'add', '-q', '-b', 'tally', worktree);
  put(worktree, 'docs/tally.md', '# Tally\n\nOne row per species.\n');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', 'K-1: the tally sheet');
  return { repo, worktree };
}

// ───────────────────────── the spelling itself ─────────────────────────

forEachSpelling('canonicalPath gives the file system’s own spelling of a directory, and of what does not exist yet under it', ({ real, given }) => {
  assert.equal(canonicalPath(given), real);
  assert.equal(canonicalPath(real), real, 'the real spelling stays');
  assert.equal(canonicalPath(join(given, 'not', 'there.md')), join(real, 'not', 'there.md'), 'a missing tail is kept on the real spelling of what exists');
  assert.equal(canonicalPath(`${given}${WIN ? '\\' : '/'}`), real, 'a trailing separator is dropped');
});

// ───────────────────────── discovery: the repository, its worktree, its ignore rules ─────────────────────────

forEachSpelling('a project given by another spelling is the repository git says it is: its worktree is measured and its ignore rules are read', ({ real, given }) => {
  const k = kestrel(real);
  const found = discoverScope({ id: 'p1', name: 'Kestrel', locations: [join(given, 'kestrel')] }, { home: machine, projectKeeperHome: join(machine, 'pk-home') });
  const main = found.items.find((i) => i.path === k.repo);
  assert.equal(main?.category, 'Repository', `the location is a repository, under its real name: ${JSON.stringify(found.items.map((i) => [i.category, i.path]))}`);
  const wt = found.items.find((i) => i.category === 'Worktree');
  assert.equal(wt?.path, k.worktree, 'the registered worktree is listed');
  assert.equal(wt?.worktreeOf, k.repo);
  assert.equal(wt?.worktree?.error ?? null, null);
  assert.deepEqual([wt?.worktree?.merged, wt?.worktree?.uniqueCommits, wt?.worktree?.branch], [false, 1, 'tally'], 'and measured against the trunk');
  const notes = found.items.find((i) => i.path === join(k.repo, 'notes'));
  assert.equal(notes?.relation, 'Excluded', 'the ignored directory is listed');
  assert.deepEqual([notes?.ignoredBy?.file, notes?.ignoredBy?.pattern, notes?.ignoredBy?.documents], ['.gitignore', 'notes/', 1], 'with the rule that leaves it out');
  assert.ok(found.questions.some((q) => /notes is left out by the project's ignore rules/.test(q.question)), 'and the owner is asked about its document');
});

// ───────────────────────── adding a project, reading it, watching it, writing its folder ─────────────────────────

forEachSpelling('a project added by another spelling is kept under its real name; it is read, watched, and its folder committed there', async ({ real, given }) => {
  const k = kestrel(real);
  // The home is given the other way too.
  mkdirSync(join(real, 'home'));
  const app = new App(join(given, 'home'), { organizing: false });
  try {
    assert.equal(app.home, join(real, 'home'), 'the home is kept under its real name');
    app.workspace.setSettings({ watchProjects: false });
    const added = app.addProject('Kestrel', [join(given, 'kestrel')]);
    assert.deepEqual(added.locations, [k.repo], 'the location is kept under its real name');
    assert.throws(() => app.addProject('Kestrel', [k.repo]), /already exists/, 'the same directory by its real name is the same project');
    assert.deepEqual(Workspace.open(join(given, 'home')).get(added.id)?.locations, [k.repo], 'and that is what the settings file holds');

    // Read: every file source lies under the real name, the worktree's commit is taken, the ignored note is not.
    await app.intakeProject(added.id);
    const project = app.project(added.id);
    const store = app.store(added.id);
    assert.equal(project.scope.find((i) => i.category === 'Repository')?.path, k.repo);
    const files = store.sources.filter((s) => s.anchor.kind === 'file').map((s) => (s.anchor.kind === 'file' ? s.anchor.path : ''));
    assert.ok(files.includes(join(k.repo, 'docs', 'plan.md')), `the plan is read: ${files.join(', ')}`);
    assert.ok(files.every((f) => f.startsWith(real)), 'every file is named by the real spelling');
    assert.ok(!files.some((f) => f.includes('idea.md')), 'what the ignore rules leave out is not read');
    assert.ok(store.sources.find((s) => s.anchor.kind === 'commit' && /K-1: the tally sheet/.test(s.title)), 'the commit only the worktree has is taken');
    assert.ok(store.sources.find((s) => s.anchor.kind === 'commit' && /Kestrel: first version/.test(s.title)), 'and the trunk’s history');

    // Watched: a change written through the other spelling is reported once, under the real name; an ignored one is not.
    const watcher = app.startWatching(added.id);
    await new Promise((r) => setTimeout(r, 300));
    put(join(given, 'kestrel'), 'docs/dusk.md', '# Dusk\n\nCount at dusk.\n');
    put(join(given, 'kestrel'), 'notes/later.md', '# Later\n');
    const seen = () => watcher.list().map((c) => c.ref);
    const want = join(k.repo, 'docs', 'dusk.md');
    for (let i = 0; i < 50 && !seen().includes(want); i += 1) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(seen().includes(want), `the new document is reported under the real name: ${seen().join(', ')}`);
    assert.ok(!seen().some((f) => f.includes('later.md')), 'the ignored note is not reported');
    watcher.stop();

    // The Keeper's own folder: found inside the repository, so it is committed (the runner wrote it without a commit).
    grantProjectFolderAuthorization(store, project, { quote: 'Write and commit the folder.' });
    const synced = syncProjectFolder(store, project);
    assert.equal(synced.reason, null);
    assert.equal(synced.path, join(k.repo, 'projectkeeper'));
    assert.match(synced.commit ?? '', /^[0-9a-f]{40}$/, 'the folder is committed');
    assert.equal(git(k.repo, 'log', '-1', '--format=%an|%s').split('|')[0], 'ProjectKeeper');
  } finally {
    app.stopAll();
    await app.flushAll();
  }
});

// ───────────────────────── the demo ─────────────────────────

forEachSpelling('the demo project is seeded in a directory given by another spelling', async ({ real, given }) => {
  const seeded = await seedUiFixture(join(given, 'home'), { projectDir: join(given, 'papertrail'), name: 'Papertrail' });
  const project = Workspace.open(join(given, 'home')).get(seeded.projectId);
  assert.deepEqual(project?.locations, [join(real, 'papertrail')]);
  const worktrees = (project?.scope ?? []).filter((i) => i.category === 'Worktree');
  assert.deepEqual(worktrees.map((i) => i.path).sort(), [join(real, 'papertrail-wt'), join(real, 'papertrail-wt2')], 'both registered worktrees are found');
  assert.deepEqual(worktrees.map((i) => i.worktree?.merged).sort(), [false, true], 'and measured: one merged, one not');
  assert.ok(seeded.counts.nodes! > 20, `the graph is planted: ${seeded.counts.nodes} objects`);
});

const freePort = (): Promise<number> => new Promise((done, fail) => {
  const probe = createServer();
  probe.once('error', fail);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); });
});

forEachSpelling('`npm run demo -- --dir <another spelling>` builds the project and serves it', async ({ real, given }) => {
  const port = await freePort();
  const script = resolve(import.meta.dirname, '../../scripts/demo.ts');
  const child = spawn(process.execPath, [script, '--port', String(port), '--dir', join(given, 'demo')], { cwd: resolve(import.meta.dirname, '../..'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  try {
    const opened = await Promise.race([
      (async () => { for (let i = 0; i < 600 && !out.includes('The demo is open at'); i += 1) await new Promise((r) => setTimeout(r, 100)); return out.includes('The demo is open at'); })(),
      exited.then(() => false),
    ]);
    assert.ok(opened, `the demo opened:\n${out}`);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);
    const workspace = await (await fetch(`http://127.0.0.1:${port}/api/workspace`)).json() as { projects: { name: string; locations: string[] }[] };
    assert.deepEqual(workspace.projects.map((p) => [p.name, p.locations]), [['Papertrail', [join(real, 'demo', 'papertrail')]]]);
    assert.ok(existsSync(join(real, 'demo', '.projectkeeper-demo')), 'built in the directory that was named');
    assert.match(readFileSync(join(real, 'demo', 'home', 'workspace.json'), 'utf8'), /Papertrail/);
  } finally {
    child.kill();
    await exited;
  }
});
