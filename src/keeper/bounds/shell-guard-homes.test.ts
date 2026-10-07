/**
 * The shell write guard on the two kinds of home (BQ). A live project — a home that watches its projects — is where the
 * owner and agents write while a Keeper command runs: afterwards only what the command itself names as its writes is
 * undone, and anything else that changed stays as it is and is named at the start of the step's result. A controlled
 * trial — a home with watchProjects false — has nobody else writing: every change to the working tree is undone, as
 * before. On either, Git's own state (the index, HEAD, refs) is never restored.
 *
 * The evidence (2026-09-28, the resident Keeper on the live project): at 20:29:59Z a read-only step
 * (`git log … && git status --short`) was reported as having changed `.git\index`, which was then restored; at about
 * 20:46Z the orchestrator's commit 09c46d6 was undone in the working tree and the index while deepening lanes ran
 * commands, so its next commit f644796 carried the stale files. On the guard before BQ these tests fail for that
 * reason: the index is restored, and the other writer's edit with it.
 *
 * Each test builds its own git repository in a temp directory and drives the real boundary and pi's bash tool; the
 * command waits on a file in its scratch directory so the other writer acts while it runs. No model, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBashToolDefinition, type DefaultResourceLoader, type SettingsManager, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Project } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { createReadBoundary, shortPath } from './boundary.ts';
import { planShellCommand } from './command.ts';
import { canonicalKey, makeBoundary } from './paths.ts';
import { LEFT_NOTE, ShellProjectSnapshot } from './shell-write-guard.ts';

type Result = Awaited<ReturnType<ToolDefinition['execute']>>;

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}
const commit = (repo: string, message: string) => git(repo, '-c', 'user.name=Another writer', '-c', 'user.email=writer@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
const status = (repo: string) => git(repo, 'status', '--porcelain=v1', '--untracked-files=all');
const indexOf = (repo: string) => readFileSync(join(repo, '.git', 'index'));
const textOf = (result: Result) => result.content.find((part) => part.type === 'text')?.text ?? '';

function repository(t: { after(fn: () => void): void }) {
  const base = mkdtempSync(join(tmpdir(), 'pk-bq-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'projectkeeper'), { recursive: true });
  writeFileSync(join(repo, 'tracked.txt'), 'original');
  writeFileSync(join(repo, 'other.txt'), 'other original');
  writeFileSync(join(repo, 'projectkeeper', 'note.md'), 'keeper original');
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  commit(repo, 'fixture');
  return { base, repo };
}

/** A repository, and the Keeper's shell on it as a home that watches its projects (`live`) or not (a controlled trial). */
function home(t: { after(fn: () => void): void }, live: boolean) {
  const { base, repo } = repository(t);
  const project = { id: 'bq', name: 'BQ', locations: [repo], scope: [] } as unknown as Project;
  const store = { dir: join(base, 'pk-home', 'projects', 'bq'), sources: { all: () => [] } } as unknown as ProjectStore;
  mkdirSync(store.dir, { recursive: true });
  const settingsManager = { getDefaultTools: () => ['bash'], getShellCommandPrefix: () => undefined, getShellPath: () => undefined } as unknown as SettingsManager;
  const boundary = createReadBoundary({
    project, store, agentDir: join(base, 'agent'), settingsManager, resolveLoader: () => null as DefaultResourceLoader | null,
    jobId: 'bq-job', home: join(base, 'host-home'), projectKeeperHome: join(base, 'pk-home'), watchesProjects: () => live,
  });
  const bash = boundary.tools.find((tool) => tool.name === 'bash')!;
  const run = (command: string) => bash.execute('call', { command } as never, undefined, undefined, undefined as never);
  return { base, repo, boundary, run };
}

/**
 * Run `command` in the Keeper's shell, and `others` while it runs: the command first marks that it started (the guard
 * has taken its snapshot by then), then waits until `others` has finished writing.
 */
async function whileRunning(fx: ReturnType<typeof home>, command: string, others: () => void): Promise<{ value: Result } | { error: unknown }> {
  const started = join(fx.boundary.scratchDir, 'started');
  const settled = fx.run(`printf started > "$TMPDIR/started" && until [ -f "$TMPDIR/go" ]; do sleep 0.1; done && ${command}`)
    .then((value) => ({ value }), (error: unknown) => ({ error }));
  let over = false;
  void settled.then(() => { over = true; });
  try {
    for (let i = 0; i < 400 && !existsSync(started) && !over; i += 1) await new Promise((done) => setTimeout(done, 50));
    assert.ok(existsSync(started), `the command started (${over ? JSON.stringify(await settled, (_k, v) => v instanceof Error ? v.message : v) : 'timed out'})`);
    others();
  } finally {
    writeFileSync(join(fx.boundary.scratchDir, 'go'), 'go');
  }
  return settled;
}

test('live project: another writer edits a tracked file and commits while a read-only command runs; the edit and the commit stay, the index is not restored, the step names the file', { timeout: 60_000 }, async (t) => {
  const fx = home(t, true);
  let index = Buffer.alloc(0);
  let head = '';
  const outcome = await whileRunning(fx, 'cat tracked.txt && git log --oneline -1', () => {
    writeFileSync(join(fx.repo, 'tracked.txt'), 'edited by another writer');
    git(fx.repo, 'add', 'tracked.txt');
    commit(fx.repo, 'another writer');
    index = indexOf(fx.repo);
    head = git(fx.repo, 'rev-parse', 'HEAD').trim();
  });
  assert.ok('value' in outcome, `nothing was undone: ${'error' in outcome ? String(outcome.error) : ''}`);
  assert.equal(readFileSync(join(fx.repo, 'tracked.txt'), 'utf8'), 'edited by another writer', 'the edit is intact');
  assert.equal(git(fx.repo, 'rev-parse', 'HEAD').trim(), head, 'the commit is intact');
  assert.deepEqual(indexOf(fx.repo), index, '.git/index is not restored');
  assert.equal(status(fx.repo), '', 'git status is clean');
  const text = textOf(outcome.value);
  assert.ok(text.startsWith(`${LEFT_NOTE}; left as it is: `), `the step's result starts with the note: ${text.slice(0, 200)}`);
  assert.match(text.split('\n')[0]!, /tracked\.txt/, 'and names the file the other writer changed');
  assert.match(text, /edited by another writer/, 'the command\'s own output follows');
});

test('live project: another writer\'s uncommitted edit made while a command runs is left and named, not undone', { timeout: 60_000 }, async (t) => {
  const fx = home(t, true);
  const outcome = await whileRunning(fx, 'git status --short', () => {
    writeFileSync(join(fx.repo, 'other.txt'), 'edited by another writer');
    writeFileSync(join(fx.repo, 'new-by-another.txt'), 'created by another writer');
  });
  assert.ok('value' in outcome, `nothing was undone: ${'error' in outcome ? String(outcome.error) : ''}`);
  assert.equal(readFileSync(join(fx.repo, 'other.txt'), 'utf8'), 'edited by another writer');
  assert.equal(readFileSync(join(fx.repo, 'new-by-another.txt'), 'utf8'), 'created by another writer');
  const note = textOf(outcome.value).split('\n')[0]!;
  assert.match(note, new RegExp(`^${LEFT_NOTE}`));
  assert.match(note, /other\.txt/);
  assert.match(note, /new-by-another\.txt/);
});

test('live project: a misjudged write to the command\'s own redirect target is still undone; another writer\'s change stays', { timeout: 60_000 }, async (t) => {
  const { base, repo } = repository(t);
  const scratch = join(base, 'scratch');
  mkdirSync(scratch, { recursive: true });
  const command = 'printf bad > out.txt && printf bad > tracked.txt';
  // The misjudgment: the parser is not told the project is a place the shell may not write, so it lets both redirects
  // through. It still names them as the command's writes, and the guard undoes those.
  const plan = planShellCommand('bash', command, repo, makeBoundary({ roots: [{ path: repo, label: 'the project' }], files: [] }), [], scratch);
  assert.equal(plan.decision.ok, true, 'the refusal misjudged these writes');
  for (const name of ['out.txt', 'tracked.txt']) assert.ok(plan.writePaths.includes(canonicalKey(join(repo, name), repo)), `${name} is named as a write`);
  const snapshot = await ShellProjectSnapshot.take([repo], join(base, 'pk-home', 'shell-guards'), plan.locations, [], { othersWrite: true, writes: plan.writePaths });
  await createBashToolDefinition(repo).execute('misjudged', { command } as never, undefined, undefined, undefined as never);
  assert.equal(readFileSync(join(repo, 'out.txt'), 'utf8'), 'bad', 'the command wrote its redirect target');
  writeFileSync(join(repo, 'other.txt'), 'edited by another writer');   // meanwhile, someone else
  const restored = await snapshot.restore();
  assert.equal(existsSync(join(repo, 'out.txt')), false, 'the new redirect target is removed');
  assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'original', 'the overwritten one is put back');
  assert.equal(readFileSync(join(repo, 'other.txt'), 'utf8'), 'edited by another writer', 'the other writer\'s change stays');
  assert.deepEqual(restored.map((path) => path.split(/[\\/]/).pop()).sort(), ['out.txt', 'tracked.txt']);
  assert.deepEqual(snapshot.left.map((path) => path.split(/[\\/]/).pop()), ['other.txt']);
  assert.equal(status(repo), ' M other.txt\n');
});

test('live project: an output option the refusal lets through (sort -o) is undone through the boundary; another writer\'s change stays', { timeout: 60_000 }, async (t) => {
  const fx = home(t, true);
  const outcome = await whileRunning(fx, 'sort -o sorted.txt tracked.txt', () => {
    writeFileSync(join(fx.repo, 'other.txt'), 'edited by another writer');
  });
  assert.ok('error' in outcome, 'the step reports what it undid');
  const message = String(outcome.error);
  assert.match(message, /the changes were restored: [^.]*sorted\.txt/);
  assert.match(message, new RegExp(`${LEFT_NOTE}; left as it is: [^.]*other\\.txt`));
  assert.equal(existsSync(join(fx.repo, 'sorted.txt')), false, 'the output file is removed');
  assert.equal(readFileSync(join(fx.repo, 'other.txt'), 'utf8'), 'edited by another writer', 'the other writer\'s change stays');
});

test('controlled trial: a change to the working tree during a command is undone as before; .git/index is not restored', { timeout: 60_000 }, async (t) => {
  const fx = home(t, false);
  let index = Buffer.alloc(0);
  const outcome = await whileRunning(fx, 'cat tracked.txt', () => {
    writeFileSync(join(fx.repo, 'tracked.txt'), 'changed during the command');
    git(fx.repo, 'add', 'tracked.txt');
    index = indexOf(fx.repo);
  });
  assert.ok('error' in outcome, 'the step reports what it undid');
  assert.match(String(outcome.error), /the changes were restored: [^.]*tracked\.txt/);
  assert.equal(readFileSync(join(fx.repo, 'tracked.txt'), 'utf8'), 'original', 'the working tree change is undone');
  assert.deepEqual(indexOf(fx.repo), index, '.git/index is not restored');
  assert.equal(git(fx.repo, 'diff', '--cached', '--name-only').trim(), 'tracked.txt', 'what was staged stays staged');
});

test('controlled trial: a commit made while a command runs (the Keeper\'s own folder commit) is never undone, and is named', { timeout: 60_000 }, async (t) => {
  const fx = home(t, false);
  let head = '';
  const outcome = await whileRunning(fx, 'cat tracked.txt', () => {
    writeFileSync(join(fx.repo, 'projectkeeper', 'note.md'), 'keeper folder update');
    git(fx.repo, 'add', '--', 'projectkeeper');
    commit(fx.repo, 'ProjectKeeper: update note.md');
    head = git(fx.repo, 'rev-parse', 'HEAD').trim();
  });
  assert.ok('value' in outcome, `nothing was undone: ${'error' in outcome ? String(outcome.error) : ''}`);
  assert.equal(readFileSync(join(fx.repo, 'projectkeeper', 'note.md'), 'utf8'), 'keeper folder update');
  assert.equal(git(fx.repo, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(status(fx.repo), '');
  assert.match(textOf(outcome.value).split('\n')[0]!, new RegExp(`^${LEFT_NOTE}; left as it is: .*note\\.md`));
});

test('the 20:29:59Z step: a command whose own git status finds a file’s time changed does not rewrite the index, and restores and reports nothing, on either home', { timeout: 60_000 }, async (t) => {
  for (const live of [true, false]) {
    const fx = home(t, live);
    // A file whose time no longer matches the index made git status refresh the index and write it back; in the Keeper's
    // shell git is told not to (boundary.ts `shellEnv`), so the repository's state is as the command found it.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(fx.repo, 'tracked.txt'), later, later);
    const before = indexOf(fx.repo);
    const result = await fx.run('git log --format=\'%h %ad %s\' --date=format:\'%m-%d %H:%M\' -12 && echo "=== status ===" && git status --short | head -5');
    assert.deepEqual(indexOf(fx.repo), before, 'the command\'s git status left the index as it was');
    assert.doesNotMatch(textOf(result), new RegExp(LEFT_NOTE), `${live ? 'live' : 'controlled'}: nothing is reported`);
    assert.equal(readFileSync(join(fx.repo, 'tracked.txt'), 'utf8'), 'original');
  }
});

test('a path in the guard\'s messages is given from its project root on, so a step\'s record names the file however deep the project sits', () => {
  const root = join(tmpdir(), 'a-project-kept-in-a-folder-with-a-long-name', 'under-several-more-folders', 'each-with-a-long-name-of-its-own', 'so-that-the-root-alone-is-longer-than-a-step-record');
  const other = join(tmpdir(), 'second-root');
  const file = join(root, 'docs', 'note.md');
  assert.ok(`${LEFT_NOTE}; left as it is: ${file}`.length > 160, 'given whole, the file\'s name falls past what a step record keeps');
  assert.equal(shortPath(file, [root]), 'docs/note.md');
  assert.equal(shortPath(root, [root]), '.');
  assert.equal(shortPath(file, [root, other]), 'so-that-the-root-alone-is-longer-than-a-step-record/docs/note.md', 'with several roots, the root is named too');
  assert.equal(shortPath(join(other, 'a.txt'), [root, other]), 'second-root/a.txt');
  assert.equal(shortPath(`${root}-sibling`, [root]), `${root}-sibling`, 'a path that only starts like a root is not inside it');
  assert.equal(shortPath(join(tmpdir(), 'elsewhere.txt'), [root]), join(tmpdir(), 'elsewhere.txt'), 'outside every root: whole');
});
