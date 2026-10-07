/**
 * What the write guard does with a change the command check did not stop (shell-write-guard.ts; BQ). These are the
 * facts as they stand, each kind of change made between the guard's snapshot and its restore, in a repository of its
 * own with a remote beside it:
 *
 *  - On a controlled trial (a home that does not watch its projects) a change to the working tree is undone: a file
 *    edited, deleted or created.
 *  - On a live project — the default — only what the command check named as the command's writes is undone. A change
 *    it did not name is left as it is and reported as changed "while this command ran, not by it". So there the check
 *    is the only thing between a write command and the project, which is why a command hidden behind a wrapper has to
 *    be found by it (wrapped.test.ts).
 *  - Git's own state is never undone, on either: a commit, a reset, a new branch or tag, a stash, the index, the
 *    repository's configuration, a hook, a push. Of these only a commit or a reset that moved files is reported (the
 *    files, as left); the others are not noticed at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShellProjectSnapshot } from './shell-write-guard.ts';
import { canonicalKey } from './paths.ts';

interface Fixture { readonly base: string; readonly repo: string; readonly remote: string; git(...args: string[]): string }

function fixture(t: { after(fn: () => void): void }): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'pk-guard-facts-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 3 }));
  const repo = join(base, 'repo');
  const remote = join(base, 'remote.git');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const git = (...args: string[]): string => {
    const run = spawnSync('git', ['-c', 'user.name=Heron Dev', '-c', 'user.email=dev@heron.invalid', '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout.trim();
  };
  assert.equal(spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { windowsHide: true }).status, 0);
  git('init', '-q', '-b', 'main');
  git('config', '--local', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'src', 'a.txt'), 'first a\n');
  writeFileSync(join(repo, 'src', 'b.txt'), 'b\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
  writeFileSync(join(repo, 'src', 'a.txt'), 'second a\n');
  git('commit', '-qam', 'second');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main');
  return { base, repo, remote, git };
}

/** Everything a command could have changed, read back. */
function stateOf(f: Fixture): Record<string, string> {
  const file = (rel: string) => (existsSync(join(f.repo, rel)) ? readFileSync(join(f.repo, rel), 'utf8').trim() : '(none)');
  const refs = f.git('for-each-ref', '--format=%(refname)').split(/\r?\n/);
  const under = (prefix: string) => refs.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length)).join(',');
  return {
    'src/a.txt': file('src/a.txt'), 'src/b.txt': file('src/b.txt'), 'new.txt': file('new.txt'),
    head: f.git('log', '-1', '--format=%s'), branch: file('.git/HEAD'), staged: f.git('diff', '--cached', '--name-only'),
    branches: under('refs/heads/'), tags: under('refs/tags/'), stashes: refs.includes('refs/stash') ? 'one' : 'none',
    setting: /heron/.test(file('.git/config')) ? 'set' : '(unset)', hook: file('.git/hooks/pre-commit'),
    remote: spawnSync('git', ['--git-dir', f.remote, 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8', windowsHide: true }).stdout.trim(),
  };
}

interface Fact {
  readonly change: string;
  readonly make: (f: Fixture) => void;
  /** What of the state is still as the command left it after the guard, on a controlled trial and on a live project. */
  readonly stays: { readonly trial: readonly string[]; readonly live: readonly string[] };
  /** The files the guard reports as left, on each. */
  readonly left: { readonly trial: readonly string[]; readonly live: readonly string[] };
}
const FACTS: readonly Fact[] = [
  { change: 'a tracked file edited', make: (f) => writeFileSync(join(f.repo, 'src', 'a.txt'), 'edited\n'), stays: { trial: [], live: ['src/a.txt'] }, left: { trial: [], live: ['src/a.txt'] } },
  { change: 'a tracked file deleted', make: (f) => unlinkSync(join(f.repo, 'src', 'b.txt')), stays: { trial: [], live: ['src/b.txt'] }, left: { trial: [], live: ['src/b.txt'] } },
  { change: 'a new file', make: (f) => writeFileSync(join(f.repo, 'new.txt'), 'new\n'), stays: { trial: [], live: ['new.txt'] }, left: { trial: [], live: ['new.txt'] } },
  { change: 'an edit staged (git add)', make: (f) => { writeFileSync(join(f.repo, 'src', 'a.txt'), 'edited\n'); f.git('add', '-A'); }, stays: { trial: ['staged'], live: ['src/a.txt', 'staged'] }, left: { trial: [], live: ['src/a.txt'] } },
  { change: 'an edit committed (git commit)', make: (f) => { writeFileSync(join(f.repo, 'src', 'a.txt'), 'edited\n'); f.git('commit', '-qam', 'by the command'); }, stays: { trial: ['src/a.txt', 'head'], live: ['src/a.txt', 'head'] }, left: { trial: ['src/a.txt'], live: ['src/a.txt'] } },
  { change: 'an empty commit', make: (f) => { f.git('commit', '-q', '--allow-empty', '-m', 'empty'); }, stays: { trial: ['head'], live: ['head'] }, left: { trial: [], live: [] } },
  { change: 'git reset --hard HEAD~1', make: (f) => { f.git('reset', '-q', '--hard', 'HEAD~1'); }, stays: { trial: ['src/a.txt', 'head'], live: ['src/a.txt', 'head'] }, left: { trial: ['src/a.txt'], live: ['src/a.txt'] } },
  { change: 'git checkout -b', make: (f) => { f.git('checkout', '-q', '-b', 'side'); }, stays: { trial: ['branch', 'branches'], live: ['branch', 'branches'] }, left: { trial: [], live: [] } },
  { change: 'a branch and a tag', make: (f) => { f.git('branch', 'side'); f.git('tag', 'v1'); }, stays: { trial: ['branches', 'tags'], live: ['branches', 'tags'] }, left: { trial: [], live: [] } },
  { change: 'git stash, after an edit', make: (f) => { writeFileSync(join(f.repo, 'src', 'a.txt'), 'edited\n'); f.git('stash', '-q'); }, stays: { trial: ['stashes'], live: ['stashes'] }, left: { trial: [], live: [] } },
  { change: 'the repository’s configuration', make: (f) => { f.git('config', '--local', 'heron.setting', 'on'); }, stays: { trial: ['setting'], live: ['setting'] }, left: { trial: [], live: [] } },
  { change: 'a hook written into .git/hooks', make: (f) => { mkdirSync(join(f.repo, '.git', 'hooks'), { recursive: true }); writeFileSync(join(f.repo, '.git', 'hooks', 'pre-commit'), 'exit 0\n'); }, stays: { trial: ['hook'], live: ['hook'] }, left: { trial: [], live: [] } },
  { change: 'a commit pushed', make: (f) => { f.git('commit', '-q', '--allow-empty', '-m', 'pushed'); f.git('push', '-q', 'origin', 'main'); }, stays: { trial: ['head', 'remote'], live: ['head', 'remote'] }, left: { trial: [], live: [] } },
];

for (const mode of ['trial', 'live'] as const) {
  test(`${mode === 'trial' ? 'a controlled trial' : 'a live project, the command having named no write'}: what the guard undoes of each kind of change, what it leaves and reports, and what it does not notice`, async (t) => {
    for (const fact of FACTS) {
      const f = fixture(t);
      const before = stateOf(f);
      const snapshot = await ShellProjectSnapshot.take([f.repo], join(f.base, 'pk-home', 'shell-guards'), [f.repo], [], mode === 'live' ? { othersWrite: true, writes: [] } : {});
      fact.make(f);
      const made = stateOf(f);
      await snapshot.restore();
      const after = stateOf(f);
      const changed = Object.keys(before).filter((k) => made[k] !== before[k]);
      assert.ok(changed.length > 0, `${fact.change}: the fixture changes something`);
      // Still as the command left it …
      for (const k of fact.stays[mode]) assert.equal(after[k], made[k], `${fact.change}: ${k} is not undone`);
      // … and everything else it changed is back as it was.
      for (const k of changed.filter((x) => !fact.stays[mode].includes(x))) assert.equal(after[k], before[k], `${fact.change}: ${k} is undone`);
      assert.deepEqual(snapshot.left.map((p) => p.slice(canonicalKey(f.repo, f.repo).length + 1).replaceAll('\\', '/')).sort(), [...fact.left[mode]].sort(), `${fact.change}: what is reported as left`);
    }
  });
}

test('a live project: the same changes are undone when the command check named them as the command’s writes', async (t) => {
  for (const fact of FACTS.slice(0, 3)) {
    const f = fixture(t);
    const before = stateOf(f);
    const writes = ['src/a.txt', 'src/b.txt', 'new.txt'].map((rel) => canonicalKey(join(f.repo, rel), f.repo));
    const snapshot = await ShellProjectSnapshot.take([f.repo], join(f.base, 'pk-home', 'shell-guards'), [f.repo], [], { othersWrite: true, writes });
    fact.make(f);
    await snapshot.restore();
    assert.deepEqual(stateOf(f), before, fact.change);
    assert.deepEqual(snapshot.left, [], fact.change);
  }
});
