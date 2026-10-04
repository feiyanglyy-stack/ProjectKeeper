/** Independent, local-only QC of the Project folder boundary at eaeea92. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { ClerkRound } from '../model/k-types.ts';
import type { Project } from '../model/types.ts';
import { ClerkPlanner } from '../keeper/organize/clerk.ts';
import { grantProjectFolderAuthorization, projectFolderPath, syncProjectFolder } from '../keeper/project-folder.ts';
import { grantProjectFolder } from '../server/project-folder-api.ts';
import { App } from '../server/app.ts';
import { roundsView } from '../server/k-views.ts';
import { scanFiles } from '../sources/files.ts';
import { ProjectStore } from '../store/project-store.ts';

const WORKTREE = resolve(import.meta.dirname, '../..');

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function fixture(repository = true) {
  const temporary = mkdtempSync(join(WORKTREE, '.aw-qc-folder-'));
  const root = join(temporary, 'project');
  mkdirSync(root);
  if (repository) {
    git(root, 'init', '-q');
    git(root, 'config', '--local', 'core.autocrlf', 'false');
    git(root, 'config', '--local', 'user.name', 'Original Committer');
    git(root, 'config', '--local', 'user.email', 'original@example.test');
    writeFileSync(join(root, 'project.md'), 'baseline\n');
    git(root, 'add', '--', 'project.md');
    git(root, 'commit', '-qm', 'baseline');
  }
  const project = { id: 'qc-project', name: 'QC', locations: [root], scope: [] } as unknown as Project;
  const store = ProjectStore.open(project.id, join(temporary, 'assets'));
  const cleanup = () => {
    const rel = relative(WORKTREE, resolve(temporary));
    assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
    rmSync(temporary, { recursive: true, force: true });
  };
  return { temporary, root, project, store, cleanup };
}

test('no authorization means no project write; dot traversal and outside absolute paths are rejected', () => {
  const h = fixture();
  try {
    assert.equal(syncProjectFolder(h.store, h.project).status, 'not-authorized');
    assert.equal(existsSync(join(h.root, 'projectkeeper')), false);
    for (const path of ['../outside', 'projectkeeper/../outside', h.temporary]) {
      assert.throws(() => projectFolderPath(h.project, path), /folder|path/i, path);
    }
    assert.equal(h.store.authorizations.size, 0);
    assert.equal(git(h.root, 'status', '--porcelain'), '');
  } finally { h.cleanup(); }
});

test('an absolute path inside the project must be rejected before granting', () => {
  const h = fixture(false);
  try {
    assert.throws(() => grantProjectFolderAuthorization(h.store, h.project, {
      path: join(h.root, 'projectkeeper'), quote: 'Write the folder', commits: false,
    }), /folder|path/i);
    assert.equal(h.store.authorizations.size, 0);
    assert.equal(existsSync(join(h.root, 'projectkeeper')), false);
  } finally { h.cleanup(); }
});

test('symbolic-link and junction directory components are rejected', (t) => {
  const h = fixture(false);
  try {
    const target = join(h.temporary, 'outside');
    mkdirSync(target);
    for (const [name, kind] of [['link', 'dir'], ['junction', 'junction']] as const) {
      try { symlinkSync(target, join(h.root, name), kind); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.diagnostic(`${kind} creation unavailable: EPERM`); continue; }
        throw error;
      }
      assert.throws(() => projectFolderPath(h.project, `${name}/projectkeeper`), /Unsafe|link/i);
      assert.equal(existsSync(join(target, 'projectkeeper')), false);
    }
  } finally { h.cleanup(); }
});

test('a managed-file symlink cannot redirect a write outside the folder', (t) => {
  const h = fixture(false);
  try {
    const folder = join(h.root, 'projectkeeper');
    mkdirSync(folder);
    writeFileSync(join(folder, 'README.md'), 'This folder is maintained by ProjectKeeper\n');
    const outside = join(h.temporary, 'outside.md');
    writeFileSync(outside, 'outside unchanged\n');
    try { symlinkSync(outside, join(folder, 'semantic-patches.md'), 'file'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('file symlink creation unavailable: EPERM'); return; }
      throw error;
    }
    grantProjectFolderAuthorization(h.store, h.project, { quote: 'Write folder', commits: false });
    assert.throws(() => syncProjectFolder(h.store, h.project), /Unsafe project folder file/);
    assert.equal(readFileSync(outside, 'utf8'), 'outside unchanged\n');
  } finally { h.cleanup(); }
});

test('a junction substituted after authorization is rejected before any write', (t) => {
  const h = fixture(false);
  try {
    grantProjectFolderAuthorization(h.store, h.project, { quote: 'Write folder', commits: false });
    const outside = join(h.temporary, 'outside');
    mkdirSync(outside);
    try { symlinkSync(outside, join(h.root, 'projectkeeper'), 'junction'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('junction creation unavailable: EPERM'); return; }
      throw error;
    }
    assert.throws(() => syncProjectFolder(h.store, h.project), /Unsafe project folder component/);
    assert.equal(existsSync(join(outside, 'README.md')), false);
  } finally { h.cleanup(); }
});

test('a differently cased spelling of an existing folder must be rejected', () => {
  const h = fixture(false);
  try {
    mkdirSync(join(h.root, 'projectkeeper'));
    assert.equal(realpathSync(join(h.root, 'PROJECTKEEPER')).toLowerCase(), realpathSync(join(h.root, 'projectkeeper')).toLowerCase());
    assert.throws(() => projectFolderPath(h.project, 'PROJECTKEEPER'), /folder|path/i);
  } finally { h.cleanup(); }
});

test('trailing dot and space components must be rejected', async (t) => {
  const h = fixture(false);
  try {
    for (const path of ['projectkeeper.', 'projectkeeper ', 'child./projectkeeper', 'child /projectkeeper']) {
      await t.test(path, () => assert.throws(() => projectFolderPath(h.project, path), /folder|path/i, path));
    }
  } finally { h.cleanup(); }
});

test('8.3 short aliases, when the filesystem permits creating one, must be rejected', (t) => {
  if (process.platform !== 'win32') { t.skip('Windows-only filesystem alias'); return; }
  const h = fixture(false);
  try {
    const long = join(h.root, 'projectkeeper-long-name');
    mkdirSync(long);
    let result = '';
    try { result = execFileSync('fsutil', ['file', 'setshortname', long, 'CKFOLD~1'], { encoding: 'utf8', windowsHide: true }); }
    catch (error) { t.skip(`8.3 alias unavailable on this volume: ${String((error as { stderr?: string }).stderr ?? error).trim()}`); return; }
    const short = join(h.root, 'CKFOLD~1');
    if (!existsSync(short) || realpathSync(short).toLowerCase() !== realpathSync(long).toLowerCase()) {
      t.skip(`8.3 alias not exposed by filesystem: ${result.trim()}`);
      return;
    }
    assert.throws(() => projectFolderPath(h.project, 'CKFOLD~1'), /folder|path/i);
  } finally { h.cleanup(); }
});

test('commit is path limited; unrelated staged and unstaged changes stay put; identity and config stay put; no direct push', () => {
  const h = fixture();
  try {
    const remote = join(h.temporary, 'remote.git');
    git(h.root, 'init', '--bare', '-q', remote);
    git(h.root, 'remote', 'add', 'origin', remote);
    const configBefore = readFileSync(join(h.root, '.git', 'config'), 'utf8');
    writeFileSync(join(h.root, 'workspace.md'), 'tracked baseline\n');
    git(h.root, 'add', '--', 'workspace.md');
    git(h.root, 'commit', '-qm', 'track unrelated workspace file');
    writeFileSync(join(h.root, 'project.md'), 'staged outside\n');
    git(h.root, 'add', '--', 'project.md');
    writeFileSync(join(h.root, 'workspace.md'), 'unstaged outside\n');
    writeFileSync(join(h.root, 'untracked.md'), 'unstaged outside\n');
    grantProjectFolderAuthorization(h.store, h.project, { quote: 'Write and commit folder' });
    const result = syncProjectFolder(h.store, h.project);
    assert.equal(result.reason, null);
    assert.match(result.commit ?? '', /^[0-9a-f]{40}$/);
    const committed = git(h.root, 'show', '--pretty=format:', '--name-only', 'HEAD').split(/\r?\n/).filter(Boolean);
    assert.equal(committed.length, 4);
    assert.ok(committed.every((path) => path.startsWith('projectkeeper/')));
    assert.equal(git(h.root, 'diff', '--cached', '--name-only'), 'project.md');
    assert.equal(git(h.root, 'diff', '--name-only'), 'workspace.md');
    assert.equal(readFileSync(join(h.root, 'project.md'), 'utf8'), 'staged outside\n');
    assert.equal(readFileSync(join(h.root, 'workspace.md'), 'utf8'), 'unstaged outside\n');
    assert.equal(readFileSync(join(h.root, 'untracked.md'), 'utf8'), 'unstaged outside\n');
    assert.equal(git(h.root, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s'),
      'ProjectKeeper <keeper@projectkeeper.invalid>|Original Committer <original@example.test>|ProjectKeeper: update README.md, semantic-patches.md, keeper-numbers.md, owner-decisions.md');
    assert.equal(readFileSync(join(h.root, '.git', 'config'), 'utf8'), configBefore);
    assert.equal(git(remote, 'for-each-ref', '--format=%(refname)'), '');
  } finally { h.cleanup(); }
});

test('index.lock is retained; retry after its owner removes it commits pending files', () => {
  const h = fixture();
  try {
    grantProjectFolderAuthorization(h.store, h.project, { quote: 'Write and commit folder' });
    const before = git(h.root, 'rev-parse', 'HEAD');
    const lock = join(h.root, '.git', 'index.lock');
    writeFileSync(lock, 'held by another process');
    const blocked = syncProjectFolder(h.store, h.project);
    assert.match(blocked.reason ?? '', /index\.lock/);
    assert.equal(existsSync(lock), true);
    assert.equal(git(h.root, 'rev-parse', 'HEAD'), before);
    rmSync(lock);
    const resumed = syncProjectFolder(h.store, h.project);
    assert.match(resumed.commit ?? '', /^[0-9a-f]{40}$/);
    assert.deepEqual(resumed.changedFiles, []);
  } finally { h.cleanup(); }
});

test('the project’s pre-commit and commit-msg hooks do not run for the Keeper’s commit, and nothing outside the folder changes', () => {
  const h = fixture();
  try {
    const hooks = join(h.root, '.git', 'hooks');
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nprintf "pre\\n" >> hook.log\nprintf "pre changed\\n" >> project.md\n');
    writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\nprintf "msg\\n" >> hook.log\nprintf "msg changed\\n" >> project.md\n');
    grantProjectFolderAuthorization(h.store, h.project, { quote: 'Write and commit folder' });
    const result = syncProjectFolder(h.store, h.project);
    assert.match(result.commit ?? '', /^[0-9a-f]{40}$/);
    assert.equal(existsSync(join(h.root, 'hook.log')), false, 'no hook ran');
    assert.equal(readFileSync(join(h.root, 'project.md'), 'utf8'), 'baseline\n', 'nothing outside the folder changed');
    assert.ok(git(h.root, 'show', '--pretty=format:', '--name-only', 'HEAD').split(/\r?\n/).filter(Boolean).every((p) => p.startsWith('projectkeeper/')));
  } finally { h.cleanup(); }
});

test('a failing pre-commit or commit-msg hook of the project does not stop the Keeper’s commit, since the project’s hooks do not run for it', () => {
  for (const hook of ['pre-commit', 'commit-msg']) {
    const h = fixture();
    try {
      writeFileSync(join(h.root, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook}-denied >&2\nexit 41\n`);
      grantProjectFolderAuthorization(h.store, h.project, { quote: 'Write and commit folder' });
      const before = git(h.root, 'rev-parse', 'HEAD');
      const result = syncProjectFolder(h.store, h.project);
      assert.equal(result.status, 'written');
      assert.match(result.commit ?? '', /^[0-9a-f]{40}$/, `${hook} did not run`);
      assert.equal(result.reason, null);
      assert.notEqual(git(h.root, 'rev-parse', 'HEAD'), before);
      assert.equal(existsSync(join(h.root, 'projectkeeper', 'README.md')), true);
    } finally { h.cleanup(); }
  }
});

test('a post-commit hook of the project does not run for the Keeper’s commit, so nothing is pushed', () => {
  const h = fixture();
  try {
    const remote = join(h.temporary, 'remote.git');
    git(h.root, 'init', '--bare', '-q', remote);
    git(h.root, 'remote', 'add', 'origin', remote);
    writeFileSync(join(h.root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\ngit push -q origin HEAD:refs/heads/hook-pushed\n');
    grantProjectFolderAuthorization(h.store, h.project, { quote: 'Write and commit folder' });
    const result = syncProjectFolder(h.store, h.project);
    assert.match(result.commit ?? '', /^[0-9a-f]{40}$/);
    assert.throws(() => git(remote, 'rev-parse', '--verify', '-q', 'refs/heads/hook-pushed'), 'the remote has no pushed branch');
  } finally { h.cleanup(); }
});

test('Git --no-verify still runs prepare-commit-msg and post-commit hooks', () => {
  const h = fixture();
  try {
    const hooks = join(h.root, '.git', 'hooks');
    for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit']) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\nprintf "${hook}\\n" >> hook.log\n`);
    }
    mkdirSync(join(h.root, 'projectkeeper'));
    writeFileSync(join(h.root, 'projectkeeper', 'probe.md'), 'probe\n');
    git(h.root, 'add', '--', 'projectkeeper');
    git(h.root, 'commit', '--no-verify', '-qm', 'probe', '--', 'projectkeeper');
    assert.equal(readFileSync(join(h.root, 'hook.log'), 'utf8'), 'prepare-commit-msg\npost-commit\n');
  } finally { h.cleanup(); }
});

test('a root-folder commit leaves an ignored independent nested repository untouched', () => {
  const h = fixture();
  try {
    writeFileSync(join(h.root, '.gitignore'), 'app/\n');
    git(h.root, 'add', '--', '.gitignore');
    git(h.root, 'commit', '-qm', 'ignore nested app');
    const nested = join(h.root, 'app');
    mkdirSync(nested);
    git(nested, 'init', '-q');
    git(nested, 'config', '--local', 'core.autocrlf', 'false');
    git(nested, 'config', '--local', 'user.name', 'Nested Committer');
    git(nested, 'config', '--local', 'user.email', 'nested@example.test');
    writeFileSync(join(nested, 'inner.md'), 'nested baseline\n');
    git(nested, 'add', '--', 'inner.md');
    git(nested, 'commit', '-qm', 'nested baseline');
    const nestedHead = git(nested, 'rev-parse', 'HEAD');
    grantProjectFolderAuthorization(h.store, h.project, { quote: 'Write and commit root folder' });
    const result = syncProjectFolder(h.store, h.project);
    assert.match(result.commit ?? '', /^[0-9a-f]{40}$/);
    assert.equal(git(nested, 'rev-parse', 'HEAD'), nestedHead);
    assert.equal(git(nested, 'status', '--porcelain'), '');
    assert.equal(readFileSync(join(nested, 'inner.md'), 'utf8'), 'nested baseline\n');
  } finally { h.cleanup(); }
});

test('a folder write error keeps the round Done and must appear on the round view', () => {
  const h = fixture();
  try {
    grantProjectFolderAuthorization(h.store, h.project, { path: 'blocked', quote: 'Write blocked folder' });
    writeFileSync(join(h.root, 'blocked'), 'a file is here\n');
    const round: ClerkRound = {
      id: 'round-qc', projectId: h.project.id, kind: 'First usable', number: 1,
      startedAt: '2026-09-26T10:00:00Z', endedAt: null, status: 'Running', rootJobId: 'root-job',
      questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] },
      spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: '',
    };
    h.store.clerkRounds.put(round);
    const ended = { status: '', resultText: '' };
    const fakeApp = { keeper: { endProgramJob: (_projectId: string, _jobId: string, status: string, data: { resultText: string }) => { ended.status = status; ended.resultText = data.resultText; } } } as unknown as App;
    new ClerkPlanner(fakeApp).closeRound(h.store, h.project, round);
    assert.equal(h.store.clerkRounds.get(round.id)?.status, 'Done');
    assert.equal(ended.status, 'Done');
    assert.match(ended.resultText, /project folder not written.*Unsafe project folder component/);
    assert.match(JSON.stringify(roundsView(h.store)[0]), /project folder not written.*Unsafe project folder component/);
  } finally { h.cleanup(); }
});

test('revocation stops writing and retains the existing files', () => {
  const h = fixture(false);
  try {
    const a = grantProjectFolderAuthorization(h.store, h.project, { quote: 'Write folder', commits: false });
    syncProjectFolder(h.store, h.project);
    const file = join(h.root, 'projectkeeper', 'README.md');
    const before = readFileSync(file, 'utf8');
    h.store.authorizations.put({ ...a, revokedAt: '2026-09-26T12:00:00Z' });
    assert.equal(syncProjectFolder(h.store, h.project).status, 'not-authorized');
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally { h.cleanup(); }
});

test('a successful grant excludes the folder on initial scope and after rescope', () => {
  const h = fixture();
  const app = new App(join(h.temporary, 'app-home'), { organizing: false });
  try {
    const project = app.workspace.add('QC app', [h.root]);
    app.scopeProject(project.id);
    grantProjectFolder(app, project.id, { quote: 'Write folder', commits: false });
    for (const phase of ['initial', 'rescope']) {
      if (phase === 'rescope') app.scopeProject(project.id);
      const current = app.project(project.id);
      assert.equal(current.scope.find((i) => i.path.toLowerCase() === join(h.root, 'projectkeeper').toLowerCase())?.relation, 'Excluded');
      assert.equal(scanFiles(project.id, current.scope).files.some((f) => relative(h.root, f.path).toLowerCase().startsWith(`projectkeeper${sep}`)), false);
    }
  } finally { app.stopAll(); h.cleanup(); }
});

test('a failed grant must not leave a later sync readable as project material', () => {
  const h = fixture();
  const app = new App(join(h.temporary, 'app-home'), { organizing: false });
  try {
    const project = app.workspace.add('QC app', [h.root]);
    app.scopeProject(project.id);
    const folder = join(h.root, 'projectkeeper');
    mkdirSync(folder);
    writeFileSync(join(folder, 'README.md'), 'This folder is maintained by ProjectKeeper\n');
    mkdirSync(join(folder, 'semantic-patches.md'));
    assert.throws(() => grantProjectFolder(app, project.id, { quote: 'Write folder', commits: false }), /Unsafe project folder file/);
    rmSync(join(folder, 'semantic-patches.md'), { recursive: true });
    const written = syncProjectFolder(app.store(project.id), app.project(project.id));
    assert.equal(written.status, 'written');
    app.scopeProject(project.id);
    const current = app.project(project.id);
    assert.equal(scanFiles(project.id, current.scope).files.some((f) => relative(h.root, f.path).toLowerCase().startsWith(`projectkeeper${sep}`)), false);
    assert.equal(current.scope.find((i) => i.path.toLowerCase() === folder.toLowerCase())?.relation, 'Excluded');
  } finally { app.stopAll(); h.cleanup(); }
});
