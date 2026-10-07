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
 * An agent that works in the project through one of those spellings has its sessions recorded under it (Claude Code
 * names the folder of its logs after it; both hosts write it into the log), and asks `pk` from it. Those sessions are
 * the project's all the same.
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
import { canonicalPath, claudeProjectDirName, samePath } from '../util/paths.ts';
import type { ScopeItem } from '../model/types.ts';

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
const { incrementalIntake } = await import('../intake/intake.ts');
const { resolveProject } = await import('../context/ask.ts');
const { openLedgerForWrite } = await import('../ledger/schema.ts');
const { scanSessions } = await import('../ledger/sessions.ts');
const { sessionInputOf } = await import('../ledger/rebuild.ts');

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

// ───────────────────────── the sessions agents recorded under the other spelling ─────────────────────────

const LOG_LINES = (records: readonly unknown[]): string => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
/** A Claude Code log as the host keeps it for an agent that ran in `cwd`, spelled as its shell spelled it: the folder is named after that spelling. */
function claudeSession(cwd: string, sessionId: string, words: string): string {
  const dir = join(machine, '.claude', 'projects', claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const common = { sessionId, cwd, isSidechain: false, userType: 'external', entrypoint: 'cli', version: '2.1.0' };
  writeFileSync(join(dir, `${sessionId}.jsonl`), LOG_LINES([
    { ...common, uuid: `${sessionId}-0`, type: 'user', timestamp: '2026-09-10T01:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: words } },
    { ...common, uuid: `${sessionId}-1`, type: 'assistant', timestamp: '2026-09-10T01:01:00.000Z', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Noted.' }] } },
  ]));
  return join(dir, `${sessionId}.jsonl`);
}
/** The same for Codex: one store for every directory, the directory in the log's first record. */
function codexSession(cwd: string, sessionId: string, words: string): string {
  const day = join(machine, '.codex', 'sessions', '2026', '09', '22');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-09-22T10-00-00-${sessionId}.jsonl`), LOG_LINES([
    { timestamp: '2026-09-22T10:00:00.000Z', type: 'session_meta', payload: { id: sessionId, cwd, originator: 'codex-test', source: 'cli', thread_source: 'user' } },
    { timestamp: '2026-09-22T10:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: words }] } },
    { timestamp: '2026-09-22T10:02:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Noted.' }] } },
  ]));
  return join(day, `rollout-2026-09-22T10-00-00-${sessionId}.jsonl`);
}

forEachSpelling('the sessions agents recorded while they worked through another spelling are the project’s: listed, read, watched, each with the spelling its log records', async ({ real, given }) => {
  const k = kestrel(real);
  const n = made;
  // Where the agents ran, as their shells spelled it: the repository, its worktree, and another project beside them.
  const at = join(given, 'kestrel');
  const atWorktree = join(given, 'kestrel-tally');
  mkdirSync(join(real, 'heron'));
  claudeSession(at, `claude-main-${n}`, 'Count swifts and swallows apart.');
  codexSession(at, `codex-main-${n}`, 'Keep the dusk count on a sheet of its own.');
  claudeSession(atWorktree, `claude-tally-${n}`, 'One row per species in the tally.');
  claudeSession(join(given, 'heron'), `claude-heron-${n}`, 'Tide tables first.');
  codexSession(join(given, 'heron'), `codex-heron-${n}`, 'Tide tables first.');
  mkdirSync(join(real, 'home'));
  const app = new App(join(real, 'home'), { organizing: false });
  try {
    app.workspace.setSettings({ watchProjects: false });
    const added = app.addProject('Kestrel', [at]);
    await app.intakeProject(added.id);
    const project = app.project(added.id);
    const store = app.store(added.id);

    // Project scope: a session source for each host and directory, under the directory's real name; where the logs
    // spell the directory otherwise (more than in case), the item says so.
    const items = project.scope.filter((i) => i.category === 'Session source');
    assert.deepEqual(items.map((i) => `${i.sessionHost} ${i.sessionCwd}`).sort(), [`claude ${k.repo}`, `claude ${k.worktree}`, `codex ${k.repo}`], items.map((i) => i.reason).join('\n'));
    const itemFor = (host: string, dir: string): ScopeItem => items.find((i) => i.sessionHost === host && i.sessionCwd === dir)!;
    for (const [item, recorded] of [[itemFor('claude', k.repo), at], [itemFor('codex', k.repo), at], [itemFor('claude', k.worktree), atWorktree]] as const) {
      assert.match(item.reason, /: 1 found/);
      assert.equal(item.reason.includes(`, 1 recorded under another spelling of it (${recorded})`), !samePath(recorded, item.sessionCwd!), item.reason);
    }

    // Read: each session is filed under its own directory's item, and keeps the directory as its log records it.
    const sessions = store.sources.filter((s) => s.anchor.kind === 'session');
    const of = (id: string) => sessions.filter((s) => s.anchor.kind === 'session' && s.anchor.sessionId === id);
    for (const [id, host, recorded, dir] of [[`claude-main-${n}`, 'claude', at, k.repo], [`codex-main-${n}`, 'codex', at, k.repo], [`claude-tally-${n}`, 'claude', atWorktree, k.worktree]] as const) {
      assert.ok(of(id).length > 0, `${id} is read`);
      assert.deepEqual([...new Set(of(id).map((s) => s.scopeItemId))], [itemFor(host, dir).id], `${id} is filed under its directory's item`);
      assert.deepEqual([...new Set(of(id).map((s) => (s.anchor.kind === 'session' ? s.anchor.cwd : null)))], [recorded], `${id} keeps the spelling its log records`);
    }
    assert.deepEqual(sessions.filter((s) => s.anchor.kind === 'session' && s.anchor.sessionId.includes('heron')), [], 'the sessions of the project beside it are not this project’s');

    // The ledger reads the same sessions, each with the directory as recorded.
    const db = openLedgerForWrite(join(store.dir, 'ledger-of-sessions.sqlite'));
    try {
      scanSessions(db, sessionInputOf(project), '2026-09-23T00:00:00.000Z');
      const rows = db.prepare('SELECT session_id, cwd FROM sessions ORDER BY session_id').all() as { session_id: string; cwd: string }[];
      assert.deepEqual(rows.map((r) => [r.session_id, r.cwd]), [[`claude-main-${n}`, at], [`claude-tally-${n}`, atWorktree], [`codex-main-${n}`, at]]);
    } finally { db.close(); }

    // Watched: a log written later under that spelling is reported, for its directory's item.
    const watcher = app.startWatching(added.id);
    await new Promise((r) => setTimeout(r, 300));
    const laterClaude = claudeSession(at, `claude-later-${n}`, 'And the owls?');
    const laterCodex = codexSession(at, `codex-later-${n}`, 'And the owls?');
    const pending = (file: string) => watcher.list().find((c) => samePath(c.ref, file));
    for (let i = 0; i < 50 && !(pending(laterClaude) && pending(laterCodex)); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.equal(pending(laterClaude)?.scopeItemId, itemFor('claude', k.repo).id, 'a new Claude Code log in the folder named after that spelling');
    assert.equal(pending(laterCodex)?.scopeItemId, itemFor('codex', k.repo).id, 'a new Codex log whose header records that spelling');
    watcher.stop();
    incrementalIntake(store, project, [pending(laterClaude)!, pending(laterCodex)!]);
    for (const [id, host] of [[`claude-later-${n}`, 'claude'], [`codex-later-${n}`, 'codex']] as const) {
      const read = store.sources.filter((s) => s.anchor.kind === 'session' && s.anchor.sessionId === id);
      assert.deepEqual([...new Set(read.map((s) => s.scopeItemId))], [itemFor(host, k.repo).id], `${id} is read when it is reported, under its directory's item`);
    }

    // An agent working there asks from there: `pk` gives its working directory as its shell spells it.
    assert.equal(resolveProject(app.workspace.list(), at)?.id, added.id);
    assert.equal(resolveProject(app.workspace.list(), join(atWorktree, 'docs'))?.id, added.id);
    assert.equal(resolveProject(app.workspace.list(), join(given, 'heron')), null, 'the project beside it is not this one');

    // What the owner decided about a session source while it went by that spelling still holds for the directory.
    const decided: ScopeItem = { ...itemFor('claude', k.repo), id: 'scope_recorded_before', sessionCwd: at, relation: 'Excluded', addedBy: 'owner', reason: `Excluded by the owner (was: Claude Code sessions whose working directory is ${at}: 1 found)` };
    const again = discoverScope({ id: added.id, name: 'Kestrel', locations: [at] }, { home: machine, projectKeeperHome: app.home, ownerItems: [decided] });
    const claudeMain = again.items.filter((i) => i.sessionHost === 'claude' && i.sessionCwd && samePath(canonicalPath(i.sessionCwd), k.repo));
    assert.deepEqual(claudeMain.map((i) => [i.sessionCwd, i.relation]), [[k.repo, 'Excluded']], 'one item for the directory, as the owner left it');
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
