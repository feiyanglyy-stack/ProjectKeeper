/**
 * Long paths on Windows.
 *
 * Git for Windows stops at any path of 260 characters or more unless it is told `core.longpaths`, and that counts
 * its own files: `<repository>\.git\objects\…` is that long once the repository's own path passes about 200
 * characters. ProjectKeeper's git calls outside the ledger did not tell it. So in a project at a deep path the status
 * was not read, no commit was taken in, the Keeper's own folder was written without a commit ("Could not inspect git
 * status: … Filename too long"), and every shell command of the Keeper failed in the guard that runs before it; and
 * in any project, a file deep inside read as deleted or could not be hashed. Every git call is given the setting now.
 *
 * What no setting helps is said in a sentence, with the limit and what to do: a repository whose own path is longer
 * than 246 characters, which git answers with "not a git repository" — it used to pass for a directory without version
 * control — and a directory longer than 251, where no Keeper job can run (util/paths.ts `gitPathLimit`,
 * `keeperPathLimit`; both measured).
 *
 * The limits are Windows': elsewhere these tests have nothing to show and say so. The project is invented ("Kestrel",
 * a bird-count sheet); it is built at a short path and moved to a directory of the length wanted.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from '../util/tmp.test-helpers.ts';
import { GIT_ROOT_MAX, KEEPER_CWD_MAX, gitPathLimit, keeperPathLimit } from '../util/paths.ts';

const WIN = process.platform === 'win32';

// ───────────────────────── isolation from the machine ─────────────────────────

const base = mkdtempSync(join(tmpdir(), 'pk-long-'));
const machine = join(base, 'machine');
mkdirSync(join(machine, 'pi-agent'), { recursive: true });
writeFileSync(join(machine, 'gitconfig'), '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(machine, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  HOME: machine, USERPROFILE: machine, PI_CODING_AGENT_DIR: join(machine, 'pi-agent'),
});
for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[name];
after(() => { try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* the system clears its temporary directory */ } });

const { App } = await import('../server/app.ts');
const { discoverScope } = await import('../scope/discover.ts');
const { gitRead, gitStatus, gitToplevel } = await import('../util/git.ts');
const { grantProjectFolderAuthorization, syncProjectFolder } = await import('../keeper/project-folder.ts');

// ───────────────────────── the project ─────────────────────────

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Kestrel Dev', '-c', 'user.email=dev@kestrel.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const put = (root: string, rel: string, text: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

/** A directory path of exactly `length` characters under the temporary directory (not made). */
function pathOfLength(length: number, tag: string): string {
  let dir = join(base, tag);
  while (dir.length + 41 < length) dir = join(dir, 'd'.repeat(40));
  const rest = length - dir.length - 1;
  assert.ok(rest > 0, `the temporary directory leaves room for a path of ${length} characters`);
  return join(dir, 'k'.repeat(rest));
}

/** A document deep inside the project: with any root its path is far past 260 characters. */
const DEEP_DIR = `docs/${Array.from({ length: 5 }, () => 'n'.repeat(50)).join('/')}`;

/** Kestrel: a repository with one commit, at `root` (built at a short path first: git cannot work at every length). */
function kestrel(root: string, deepFile = false): string {
  const built = join(base, `built-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(built);
  git(built, 'init', '-q', '-b', 'main');
  put(built, 'README.md', '# Kestrel\n\nA sheet for counting birds from a hide.\n');
  put(built, 'docs/plan.md', '# Plan\n\n- K-1 count by species\n');
  if (deepFile) put(built, `${DEEP_DIR}/dusk.md`, '# Dusk\n\n- K-2 count at dusk too\n');
  git(built, 'add', '-A');
  git(built, 'commit', '-q', '-m', 'K-1: first version');
  mkdirSync(dirname(root), { recursive: true });
  renameSync(built, root);
  return root;
}

const windowsOnly = (title: string, body: () => Promise<void> | void): void => {
  test(title, async (t) => {
    if (!WIN) { t.diagnostic('not on this system: the limits are Windows’'); return; }
    await body();
  });
};

// ───────────────────────── what the setting fixes ─────────────────────────

windowsOnly('a repository at a deep path (over 200 characters, under git’s limit) is read like any other: status, commits, and the Keeper’s folder committed', async () => {
  const root = kestrel(pathOfLength(225, 'deep-root'));
  assert.equal(root.length, 225);
  assert.equal(gitToplevel(root), root);
  const status = gitStatus(root);
  assert.ok(status, 'the status is read');
  assert.deepEqual([status.branch, status.dirty], ['main', []]);
  assert.match(status.head ?? '', /^[0-9a-f]{40}$/);

  const app = new App(join(base, 'home-deep-root'), { organizing: false });
  try {
    app.workspace.setSettings({ watchProjects: false });
    const added = app.addProject('Kestrel', [root]);
    await app.intakeProject(added.id);
    const project = app.project(added.id);
    const store = app.store(added.id);
    assert.equal(project.scope.find((i) => i.path === root)?.category, 'Repository');
    assert.ok(store.sources.find((s) => s.anchor.kind === 'commit' && /K-1: first version/.test(s.title)), 'the commit is taken in');
    assert.ok(store.sources.find((s) => s.anchor.kind === 'status'), 'and the repository’s status');
    grantProjectFolderAuthorization(store, project, { quote: 'Write and commit the folder.' });
    const synced = syncProjectFolder(store, project);
    assert.equal(synced.reason, null);
    assert.match(synced.commit ?? '', /^[0-9a-f]{40}$/, 'the Keeper’s folder is committed');
  } finally {
    app.stopAll();
    await app.flushAll();
  }
});

windowsOnly('a file deep inside a project (its path past 260 characters) is seen by git: listed when new, hashed as it stands', () => {
  const root = kestrel(join(base, 'deep-file'), true);
  assert.ok(join(root, DEEP_DIR, 'dusk.md').length > 300);
  assert.deepEqual(gitStatus(root)?.dirty, [], 'the tracked file is there, not deleted');
  put(root, `${DEEP_DIR}/dawn.md`, '# Dawn\n\n- K-3 count at dawn\n');
  assert.deepEqual(gitStatus(root)?.dirty, [`?? ${DEEP_DIR}/dawn.md`], 'a new file beside it is listed');
  const hashed = gitRead(root, ['hash-object', `--path=${DEEP_DIR}/dusk.md`, '--', join(root, DEEP_DIR, 'dusk.md')]);
  assert.equal(hashed.ok, true, hashed.err);
  assert.equal(hashed.out.trim(), git(root, 'rev-parse', `HEAD:${DEEP_DIR}/dusk.md`), 'the working file hashes to what was committed');
});

// ───────────────────────── what nothing fixes, said as it is ─────────────────────────

test('the limits are said in a sentence with the number and what to do; under them, and on other systems, nothing is said', () => {
  const repo = kestrel(pathOfLength(GIT_ROOT_MAX + 4, 'limit-repo'));
  const plain = pathOfLength(GIT_ROOT_MAX + 4, 'limit-plain');
  mkdirSync(plain, { recursive: true });
  const fits = kestrel(pathOfLength(GIT_ROOT_MAX, 'limit-fits'));
  assert.equal(gitPathLimit(fits), null, `a repository at ${GIT_ROOT_MAX} characters is within the limit`);
  assert.equal(gitPathLimit(plain), null, 'a directory that holds no repository is not git’s business');
  assert.equal(keeperPathLimit(pathOfLength(KEEPER_CWD_MAX, 'limit-keeper')), null);
  if (!WIN) {
    assert.equal(gitPathLimit(repo), null);
    assert.equal(keeperPathLimit(pathOfLength(KEEPER_CWD_MAX + 20, 'limit-keeper-over')), null);
    return;
  }
  assert.equal(gitPathLimit(repo), `This directory holds a git repository, but its path is ${GIT_ROOT_MAX + 4} characters long, and git on Windows cannot open a repository whose path is longer than ${GIT_ROOT_MAX} characters: its history, worktrees and ignore rules are not read. Move the project to a shorter path.`);
  assert.equal(keeperPathLimit(pathOfLength(KEEPER_CWD_MAX + 1, 'limit-keeper-over')), `The Keeper cannot work in this project's directory: its path is ${KEEPER_CWD_MAX + 1} characters long, and on Windows the Keeper can only work in a directory whose path is at most ${KEEPER_CWD_MAX} characters. Move the project to a shorter path.`);
});

windowsOnly('a repository at git’s limit is still read; one past it is not taken for a directory without version control: Project scope and the Keeper’s folder say why', () => {
  const fits = kestrel(pathOfLength(GIT_ROOT_MAX, 'scope-fits'));
  const within = discoverScope({ id: 'p-fits', name: 'Kestrel', locations: [fits] }, { home: machine, projectKeeperHome: join(base, 'home-scope') });
  assert.equal(within.items.find((i) => i.path === fits)?.category, 'Repository', 'at the limit git opens it');
  assert.deepEqual(within.missingSourceKinds, []);

  const root = kestrel(pathOfLength(GIT_ROOT_MAX + 4, 'scope-over'));
  const found = discoverScope({ id: 'p-over', name: 'Kestrel', locations: [root] }, { home: machine, projectKeeperHome: join(base, 'home-scope') });
  const item = found.items.find((i) => i.path === root)!;
  // Should a later git open a repository this deep, it is read as one and nothing needs saying.
  if (gitToplevel(root) !== null) { assert.equal(item.category, 'Repository'); return; }
  const sentence = gitPathLimit(root)!;
  assert.deepEqual([item.category, item.versionControl], ['Directory', 'none'], 'it is read as its files');
  assert.equal(item.reason, `Owner-given location; read as its files only. ${sentence}`);
  assert.deepEqual(found.missingSourceKinds, [{ kind: 'Git history', reason: `${sentence} (${root})` }], 'and the history is listed as a kind of source that could not be read');

  const app = new App(join(base, 'home-over'), { organizing: false });
  try {
    app.workspace.setSettings({ watchProjects: false });
    const added = app.addProject('Kestrel', [root]);
    const project = app.scopeProject(added.id);
    const store = app.store(added.id);
    assert.deepEqual(store.coverage.missingSourceKinds.map((m) => m.kind), ['Git history'], 'the workbench’s coverage carries it');
    grantProjectFolderAuthorization(store, project, { quote: 'Write and commit the folder.' });
    const synced = syncProjectFolder(store, project);
    assert.equal(synced.commit, null);
    assert.equal(synced.reason, `The project folder's files were written without a commit. ${sentence}`);
  } finally {
    app.stopAll();
  }
});
