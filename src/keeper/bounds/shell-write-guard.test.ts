import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Project } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { createReadBoundary } from './boundary.ts';
import { ShellProjectSnapshot, shellProjectRoots } from './shell-write-guard.ts';
import { planShellCommand } from './command.ts';
import { makeBoundary } from './paths.ts';

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}

function gitFixture(t: { after(fn: () => void): void }) {
  const base = mkdtempSync(join(tmpdir(), 'pk-shell-git-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const guard = join(base, 'pk-home', 'shell-guards');
  mkdirSync(join(repo, 'projectkeeper'), { recursive: true });
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'tracked.txt'), 'clean original');
  writeFileSync(join(repo, 'delete-me.txt'), 'keep this');
  writeFileSync(join(repo, 'projectkeeper', 'note.md'), 'keeper original');
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return { base, repo, guard };
}

function fixture(t: { after(fn: () => void): void }, withExcluded = false) {
  const base = mkdtempSync(join(tmpdir(), 'pk-shell-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const projectRoot = join(base, 'project');
  const worktree = join(base, 'worktree');
  const storeDir = join(base, 'pk-home', 'projects', 'p1');
  for (const dir of [join(projectRoot, 'src'), join(projectRoot, 'projectkeeper'), ...(withExcluded ? [join(projectRoot, '_fixtures')] : []), worktree, storeDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(projectRoot, 'src', 'a.txt'), 'original');
  writeFileSync(join(projectRoot, 'projectkeeper', 'note.md'), 'keeper original');
  writeFileSync(join(worktree, 'branch.txt'), 'branch original');
  const project = {
    id: 'p1', name: 'Demo', locations: [projectRoot],
    scope: [
      { path: worktree, category: 'Worktree', relation: 'Worktree of main repo', missing: false },
      ...(withExcluded ? [{ path: join(projectRoot, '_fixtures'), category: 'Directory', relation: 'Excluded', missing: false }] : []),
    ],
  } as unknown as Project;
  const store = { dir: storeDir, sources: { all: () => [] } } as unknown as ProjectStore;
  const settingsManager = {
    getDefaultTools: () => ['bash', 'read'], getShellCommandPrefix: () => undefined, getShellPath: () => undefined,
  } as unknown as SettingsManager;
  const boundary = createReadBoundary({ project, store, agentDir: join(base, 'agent'), settingsManager,
    resolveLoader: () => null as DefaultResourceLoader | null, jobId: 'job-1', home: join(base, 'host-home'), projectKeeperHome: join(base, 'pk-home') });
  const bash = boundary.tools.find((tool) => tool.name === 'bash')!;
  const run = (command: string) => bash.execute('call', { command } as never, undefined, undefined, undefined as never);
  return { base, projectRoot, worktree, storeDir, project, boundary, run };
}

test('shell rejects project redirection, including projectkeeper/, before a file is created', async (t) => {
  const { projectRoot, run } = fixture(t);
  await assert.rejects(run('printf bad > src_list.txt'), /shell cannot write project files/);
  assert.equal(existsSync(join(projectRoot, 'src_list.txt')), false);
  await assert.rejects(run('printf bad > projectkeeper/note.md'), /shell cannot write project files/);
  assert.equal(readFileSync(join(projectRoot, 'projectkeeper', 'note.md'), 'utf8'), 'keeper original');
});

test('shell permits TMPDIR output and rejects project writes hidden in an interpreter', async (t) => {
  const { projectRoot, boundary, run } = fixture(t);
  const result = await run('printf scratch > "$TMPDIR/out.txt" && cat "$TMPDIR/out.txt"');
  assert.match(result.content.find((item) => item.type === 'text')?.text ?? '', /scratch/);
  assert.equal(readFileSync(join(boundary.scratchDir, 'out.txt'), 'utf8'), 'scratch');
  await assert.rejects(run('node -e "require(\'fs\').writeFileSync(\'src/a.txt\',\'changed\')"'), /changes were restored/);
  assert.equal(readFileSync(join(projectRoot, 'src', 'a.txt'), 'utf8'), 'original');
  await assert.rejects(run('node -e "require(\'fs\').writeFileSync(\'src/new.txt\',\'new\')"'), /changes were restored/);
  assert.equal(existsSync(join(projectRoot, 'src', 'new.txt')), false);
  await assert.rejects(run('node -e "require(\'fs\').writeFileSync(\'projectkeeper/note.md\',\'changed\')"'), /changes were restored/);
  assert.equal(readFileSync(join(projectRoot, 'projectkeeper', 'note.md'), 'utf8'), 'keeper original');
  await assert.rejects(run('node -e "require(\'fs\').renameSync(\'src/a.txt\',\'src/moved.txt\')"'), /changes were restored/);
  assert.equal(readFileSync(join(projectRoot, 'src', 'a.txt'), 'utf8'), 'original');
  assert.equal(existsSync(join(projectRoot, 'src', 'moved.txt')), false);
  await assert.rejects(run('node -e "require(\'fs\').unlinkSync(\'src/a.txt\');process.exit(2)"'), /changes were restored/);
  assert.equal(readFileSync(join(projectRoot, 'src', 'a.txt'), 'utf8'), 'original');
});

test('the 160-character jobs.json command prefix of a recorded run cannot create src_list.txt', async (t) => {
  const { projectRoot, run } = fixture(t);
  // jobs.json stores only the first 160 characters of the real command. Keep that observed prefix verbatim,
  // changing only the bench cwd to this isolated test project; the incomplete substitution is rejected before spawn.
  const observed = 'cd /c/bench/run-C-1/contextkeeper/app && git ls-files src > src_list.txt && git blame --line-porcelain main -- $(head -30 src';
  const forward = projectRoot.replaceAll('\\', '/');
  const localBash = /^[A-Za-z]:\//.test(forward) ? `/${forward[0]!.toLowerCase()}${forward.slice(2)}` : forward;
  const local = observed.replace('/c/bench/run-C-1/contextkeeper/app', localBash);
  await assert.rejects(run(local), /shell cannot write project files/);
  assert.equal(existsSync(join(projectRoot, 'src_list.txt')), false);
});

test('snapshot restores new, deleted, moved, and changed files in every scoped worktree', async (t) => {
  const { base, projectRoot, worktree, project } = fixture(t);
  const snapshot = await ShellProjectSnapshot.take(shellProjectRoots(project), join(base, 'pk-home', 'shell-guards'));
  writeFileSync(join(projectRoot, 'new.txt'), 'new');
  rmSync(join(projectRoot, 'src', 'a.txt'));
  writeFileSync(join(projectRoot, 'projectkeeper', 'note.md'), 'wrong');
  writeFileSync(join(worktree, 'branch.txt'), 'wrong branch');
  writeFileSync(join(worktree, 'untracked.txt'), 'wrong');
  const changed = await snapshot.restore();
  assert.ok(changed.some((path) => path.endsWith('new.txt')));
  assert.equal(existsSync(join(projectRoot, 'new.txt')), false);
  assert.equal(existsSync(join(worktree, 'untracked.txt')), false);
  assert.equal(readFileSync(join(projectRoot, 'src', 'a.txt'), 'utf8'), 'original');
  assert.equal(readFileSync(join(projectRoot, 'projectkeeper', 'note.md'), 'utf8'), 'keeper original');
  assert.equal(readFileSync(join(worktree, 'branch.txt'), 'utf8'), 'branch original');
});

test('only the latest pi bash full-output path becomes readable; other temp files stay outside', async (t) => {
  const { boundary, projectRoot, run } = fixture(t);
  const result = await run('node -e "process.stdout.write(Array(30000).fill(\'LINE\').join(\'\\n\'))"');
  const path = (result.details as { fullOutputPath?: string } | undefined)?.fullOutputPath;
  assert.ok(path, 'pi saved a truncated bash output file');
  assert.equal(boundary.boundary.decide(path, projectRoot).ok, true);
  const read = boundary.tools.find((tool) => tool.name === 'read')!;
  const readResult = await read.execute('read-output', { path } as never, undefined, undefined, undefined as never);
  assert.match(readResult.content.find((item) => item.type === 'text')?.text ?? '', /LINE/);
  assert.equal(boundary.boundary.decide(join(tmpdir(), 'unrelated-temporary-file.txt'), projectRoot).ok, false);
  await assert.rejects(read.execute('read-other', { path: join(tmpdir(), 'unrelated-temporary-file.txt') } as never, undefined, undefined, undefined as never), /read boundary/);
  await run('echo next');
  assert.equal(boundary.boundary.decide(path, projectRoot).ok, false, 'a later bash call replaces the one-file allowance');
});

test('a resumed live session gives the next job a separate readable scratch directory', async (t) => {
  const { boundary, projectRoot, run } = fixture(t);
  const first = boundary.scratchDir;
  await run('printf first > "$TMPDIR/result.txt"');
  assert.equal(boundary.boundary.decide(join(first, 'result.txt'), projectRoot).ok, true);
  boundary.setJobId('job-2');
  const second = boundary.scratchDir;
  assert.notEqual(second, first);
  assert.equal(boundary.boundary.decide(join(first, 'result.txt'), projectRoot).ok, false);
  await run('printf second > "$TMPDIR/result.txt"');
  assert.equal(readFileSync(join(second, 'result.txt'), 'utf8'), 'second');
  assert.equal(readFileSync(join(first, 'result.txt'), 'utf8'), 'first');
});

test('Git journal restores clean tracked, pre-dirty tracked, pre-existing untracked, and new files', async (t) => {
  const { repo, guard } = gitFixture(t);
  writeFileSync(join(repo, 'tracked.txt'), 'my prior edit');
  writeFileSync(join(repo, 'already.txt'), 'my untracked file');
  const before = git(repo, 'status', '--porcelain=v1', '--untracked-files=all');
  const snapshot = await ShellProjectSnapshot.take([repo], guard, [repo]);
  writeFileSync(join(repo, 'tracked.txt'), 'shell edit');
  writeFileSync(join(repo, 'already.txt'), 'shell changed untracked');
  writeFileSync(join(repo, 'new.txt'), 'new');
  writeFileSync(join(repo, 'projectkeeper', 'note.md'), 'unauthorized');
  renameSync(join(repo, 'delete-me.txt'), join(repo, 'moved.txt'));
  const changed = await snapshot.restore();
  assert.ok(changed.some((path) => path.endsWith('new.txt')));
  assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'my prior edit');
  assert.equal(readFileSync(join(repo, 'already.txt'), 'utf8'), 'my untracked file');
  assert.equal(readFileSync(join(repo, 'projectkeeper', 'note.md'), 'utf8'), 'keeper original');
  assert.equal(readFileSync(join(repo, 'delete-me.txt'), 'utf8'), 'keep this');
  assert.equal(existsSync(join(repo, 'moved.txt')), false);
  assert.equal(existsSync(join(repo, 'new.txt')), false);
  assert.equal(git(repo, 'status', '--porcelain=v1', '--untracked-files=all'), before);
});

test('Git journal preserves staged content and never restores an index changed during the command (BQ rule 1)', async (t) => {
  const { repo, guard } = gitFixture(t);
  writeFileSync(join(repo, 'tracked.txt'), 'staged original');
  git(repo, 'add', 'tracked.txt');
  const snapshot = await ShellProjectSnapshot.take([repo], guard, [repo]);
  writeFileSync(join(repo, 'tracked.txt'), 'shell edited staged file');
  writeFileSync(join(repo, 'added.txt'), 'shell added file');
  git(repo, 'add', 'added.txt'); // An opaque child could mutate the index even though direct git add is refused.
  const index = readFileSync(join(repo, '.git', 'index'));
  const changed = await snapshot.restore();
  // The working tree is put back (a controlled trial undoes every change there) ...
  assert.ok(changed.some((path) => path.endsWith('tracked.txt')) && changed.some((path) => path.endsWith('added.txt')));
  assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'staged original');
  assert.equal(existsSync(join(repo, 'added.txt')), false);
  // ... but Git's own index is never restored: what was staged stays staged, byte for byte.
  assert.ok(changed.every((path) => !path.split(/[\\/]/).includes('.git')), 'nothing in .git is reported restored');
  assert.deepEqual(readFileSync(join(repo, '.git', 'index')), index, 'the index is as the command left it');
  assert.equal(git(repo, 'status', '--porcelain=v1', '--untracked-files=all'), 'AD added.txt\nM  tracked.txt\n');
});

test('journal selects the touched worktree instead of snapshotting every scoped repository', async (t) => {
  const { base, repo, guard } = gitFixture(t);
  const worktree = join(base, 'worktree');
  git(repo, 'worktree', 'add', '-qb', 'test-worktree', worktree);
  const snapshot = await ShellProjectSnapshot.take([repo, worktree], guard, [worktree]);
  writeFileSync(join(worktree, 'tracked.txt'), 'worktree edit');
  writeFileSync(join(repo, 'tracked.txt'), 'separate edit');
  const changed = await snapshot.restore();
  assert.ok(changed.some((path) => path.endsWith('tracked.txt')));
  assert.equal(readFileSync(join(worktree, 'tracked.txt'), 'utf8'), 'clean original');
  assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'separate edit');
});

test('explicit Git-ignored and Excluded paths are refused before spawn', async (t) => {
  const { base, repo, guard } = gitFixture(t);
  const excluded = join(repo, 'DELETE');
  mkdirSync(excluded);
  const boundary = makeBoundary({ roots: [{ path: repo, label: 'project' }], files: [] });
  const ignored = planShellCommand('bash', 'node -e "require(\'fs\').writeFileSync(\'node_modules/out\',\'x\')"', repo, boundary, [repo], join(base, 'scratch'), [excluded]);
  assert.equal(ignored.decision.ok, true);
  await assert.rejects(ShellProjectSnapshot.take([repo], guard, ignored.locations, [excluded]), /Git-ignored/);
  const hidden = planShellCommand('bash', 'node -e "require(\'fs\').writeFileSync(\'DELETE/out\',\'x\')"', repo, boundary, [repo], join(base, 'scratch'), [excluded]);
  assert.equal(hidden.decision.ok, false);
  assert.match(hidden.decision.reason ?? '', /Excluded/);
  const project = { id: 'git-project', name: 'Git demo', locations: [repo], scope: [] } as unknown as Project;
  const store = { dir: join(base, 'pk-home', 'projects', 'git-project'), sources: { all: () => [] } } as unknown as ProjectStore;
  const settingsManager = { getDefaultTools: () => ['bash'], getShellCommandPrefix: () => undefined, getShellPath: () => undefined } as unknown as SettingsManager;
  const guarded = createReadBoundary({ project, store, agentDir: join(base, 'agent'), settingsManager,
    resolveLoader: () => null as DefaultResourceLoader | null, jobId: 'git-job', home: join(base, 'host-home'), projectKeeperHome: join(base, 'pk-home') });
  const bash = guarded.tools.find((tool) => tool.name === 'bash')!;
  await assert.rejects(bash.execute('ignored-write', { command: 'node -e "require(\'fs\').writeFileSync(\'node_modules/out\',\'x\')"' } as never, undefined, undefined, undefined as never), /Git-ignored/);
  assert.equal(existsSync(join(repo, 'node_modules', 'out')), false);
});

test('ordinary directory journal uses metadata and skips its Excluded subtree', async (t) => {
  const { base } = fixture(t);
  const root = join(base, 'plain');
  const excluded = join(root, '_fixtures');
  mkdirSync(excluded, { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'old');
  writeFileSync(join(excluded, 'fixture.txt'), 'original');
  const snapshot = await ShellProjectSnapshot.take([root], join(base, 'pk-home', 'guard'), [root], [excluded]);
  writeFileSync(join(root, 'a.txt'), 'longer changed');
  writeFileSync(join(root, 'new.txt'), 'new');
  writeFileSync(join(excluded, 'fixture.txt'), 'left outside journal');
  const changed = await snapshot.restore();
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'old');
  assert.equal(existsSync(join(root, 'new.txt')), false);
  assert.equal(readFileSync(join(excluded, 'fixture.txt'), 'utf8'), 'left outside journal');
  assert.ok(changed.every((path) => !path.includes('_fixtures')));
});

test('an Excluded subtree is outside file-tool reads and shell preflight', async (t) => {
  const { projectRoot, boundary, run } = fixture(t, true);
  const excludedFile = join(projectRoot, '_fixtures', 'sample.txt');
  writeFileSync(excludedFile, 'not material');
  assert.equal(boundary.boundary.decide(excludedFile, projectRoot).ok, false);
  const read = boundary.tools.find((tool) => tool.name === 'read')!;
  await assert.rejects(read.execute('excluded-read', { path: excludedFile } as never, undefined, undefined, undefined as never), /Excluded/);
  await assert.rejects(run('cat _fixtures/sample.txt'), /Excluded/);
});
