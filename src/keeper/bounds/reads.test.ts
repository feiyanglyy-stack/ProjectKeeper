/**
 * What a step read (Spec §1.11 `Read in full`; CKC-13 AC-8): the recorder that works it out from a call and its result.
 *   - a shell command: each file it shows, whole or by lines, followed down its pipeline and through `cd`; searching,
 *     listing and counting read nothing; a version from the history and a commit through git;
 *   - the file tool: from its offset to where pi's own notice says it stopped;
 *   - the ledger's document read and one-commit read;
 *   - a refused call read nothing, a command that ran and exited non-zero showed its output.
 * The project is invented ("Heron", a tide log) and lives in a temporary directory; nothing is run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StepRead } from '../../model/types.ts';
import { coversAll, fileToolReads, ledgerCommitReads, ledgerDocReads, lineCount, mergeRanges, shellReads, stepReads } from './reads.ts';

const root = mkdtempSync(join(tmpdir(), 'pk-heron-'));
const write = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const lines = (n: number, word = 'tide') => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`).join('\n') + '\n';
write('docs/DECISIONS.md', lines(120, 'decision'));
write('docs/PLAN.md', lines(40, 'plan'));
write('notes/short.md', lines(5, 'note'));
write('src/tides.ts', lines(300, 'export const t'));
write('app/README.md', lines(12, 'app'));
mkdirSync(join(root, 'app', '.git'), { recursive: true });
const at = (rel: string) => join(root, ...rel.split('/'));
const sh = (command: string, output = '') => shellReads('bash', command, root, output);
const one = (reads: StepRead[], rel: string) => reads.filter((r) => r.path === at(rel) && !r.rev);

test('a shell command shows a file whole, or some of its lines, and says which (CKC-13 AC-8)', () => {
  assert.deepEqual(sh('cat docs/PLAN.md'), [{ path: at('docs/PLAN.md') }], 'cat: the whole file');
  assert.deepEqual(sh('cat -n docs/PLAN.md docs/DECISIONS.md'), [{ path: at('docs/PLAN.md') }, { path: at('docs/DECISIONS.md') }], 'every file it is given; a flag is no file');
  assert.deepEqual(sh('head -n 20 docs/DECISIONS.md'), [{ path: at('docs/DECISIONS.md'), from: 1, to: 20, lines: 120 }]);
  assert.deepEqual(sh('head -20 docs/DECISIONS.md'), [{ path: at('docs/DECISIONS.md'), from: 1, to: 20, lines: 120 }], 'head -N');
  assert.deepEqual(sh('head docs/DECISIONS.md'), [{ path: at('docs/DECISIONS.md'), from: 1, to: 10, lines: 120 }], 'head shows ten lines by default');
  assert.deepEqual(sh('head -60 notes/short.md'), [{ path: at('notes/short.md') }], 'more lines than the file has: all of it');
  assert.deepEqual(sh("sed -n '30,45p' docs/DECISIONS.md"), [{ path: at('docs/DECISIONS.md'), from: 30, to: 45, lines: 120 }]);
  assert.deepEqual(sh("sed -n '1,$p' docs/DECISIONS.md"), [{ path: at('docs/DECISIONS.md') }], 'sed -n 1,$p: the whole file');
  assert.deepEqual(sh("sed -n '1,10p;100,$p' docs/DECISIONS.md"), [{ path: at('docs/DECISIONS.md'), from: 1, to: 10, lines: 120 }, { path: at('docs/DECISIONS.md'), from: 100, lines: 120 }], 'two ranges, one to the end');
  assert.deepEqual(sh("sed -n '/^## /,/^## /p' docs/DECISIONS.md"), [{ path: at('docs/DECISIONS.md'), part: true }], 'a pattern range: some lines, not by number');
  assert.deepEqual(sh("awk 'NR>=50 && NR<=60' docs/DECISIONS.md"), [{ path: at('docs/DECISIONS.md'), from: 50, to: 60, lines: 120 }]);
  assert.deepEqual(sh('tail -n 20 docs/DECISIONS.md'), [{ path: at('docs/DECISIONS.md'), from: 101, to: 120, lines: 120 }], 'the last lines, placed by the file’s length');
  assert.deepEqual(sh('tail -n +100 docs/DECISIONS.md'), [{ path: at('docs/DECISIONS.md'), from: 100, lines: 120 }]);
  assert.deepEqual(sh('tail -c 400 docs/DECISIONS.md'), [{ path: at('docs/DECISIONS.md'), part: true }], 'bytes: a part');
  assert.deepEqual(sh('cut -c1-20 docs/PLAN.md'), [{ path: at('docs/PLAN.md'), part: true }]);
});

test('down a pipeline: what comes after cuts what came before; searching, listing and counting read nothing', () => {
  assert.deepEqual(sh('cat docs/DECISIONS.md | head -30'), [{ path: at('docs/DECISIONS.md'), from: 1, to: 30, lines: 120 }]);
  assert.deepEqual(sh("sed -n '40,90p' docs/DECISIONS.md | head -5"), [{ path: at('docs/DECISIONS.md'), from: 40, to: 44, lines: 120 }], 'a range, then its first five lines');
  assert.deepEqual(sh('cat docs/DECISIONS.md 2>&1 | head -30'), [{ path: at('docs/DECISIONS.md'), from: 1, to: 30, lines: 120 }], '2>&1 only joins the streams');
  assert.deepEqual(sh('cat docs/PLAN.md | sort | uniq'), [{ path: at('docs/PLAN.md') }], 'reordered, still every line');
  assert.deepEqual(sh('cat docs/PLAN.md docs/DECISIONS.md | head -50'), [{ path: at('docs/PLAN.md'), part: true }, { path: at('docs/DECISIONS.md'), part: true }], 'two files in one stream, then cut: which lines of which is not known');
  assert.deepEqual(sh('grep -n decision docs/DECISIONS.md'), [], 'grep searches a file; it does not read it');
  assert.deepEqual(sh('cat docs/DECISIONS.md | grep -c 1'), [], 'a read piped into a search shows only what the search found');
  assert.deepEqual(sh('rg decision docs && wc -l docs/*.md && ls docs && find . -name "*.md"'), []);
  assert.deepEqual(sh('head -5 < docs/PLAN.md'), [{ path: at('docs/PLAN.md'), from: 1, to: 5, lines: 40 }], 'a file on standard input');
  assert.deepEqual(sh('wc -l < docs/PLAN.md'), []);
  assert.deepEqual(sh('cat docs/PLAN.md > /tmp/copy.md'), [], 'output sent to a file does not reach the agent');
  assert.deepEqual(sh('cat docs/PLAN.md | tee /tmp/copy.md'), [{ path: at('docs/PLAN.md') }], 'tee passes it through');
  assert.deepEqual(sh('cat docs/PLAN.md | python3 -c "import sys; print(len(sys.stdin.read()))"'), [], 'a program’s output is not the file');
  assert.deepEqual(sh("python3 - <<'EOF'\nprint(open('docs/PLAN.md').read())\nEOF"), [], 'what a program opens is not recorded as read');
  assert.deepEqual(sh('cat docs/missing.md main..topic 42'), [], 'words that name no file name nothing');
  assert.deepEqual(sh("sed -i 's/a/b/' docs/PLAN.md"), [], 'sed -i writes; it shows nothing');
});

test('the directory a command runs in follows cd, as the boundary follows it; a subshell keeps its own', () => {
  assert.deepEqual(sh('cd docs && cat PLAN.md'), [{ path: at('docs/PLAN.md') }]);
  assert.deepEqual(sh('cd docs; head -3 ../notes/short.md'), [{ path: at('notes/short.md'), from: 1, to: 3, lines: 5 }]);
  assert.deepEqual(sh('(cd docs && cat PLAN.md) && cat notes/short.md'), [{ path: at('docs/PLAN.md') }, { path: at('notes/short.md') }]);
  assert.deepEqual(sh(`cd "${root.replace(/\\/g, '/')}/docs" && cat PLAN.md`), [{ path: at('docs/PLAN.md') }], 'an absolute cd');
  assert.deepEqual(sh('cd - && cat PLAN.md'), [], 'after cd - the directory is lost; a relative path names nothing');
  assert.deepEqual(sh("bash -c 'cat docs/PLAN.md'"), [{ path: at('docs/PLAN.md') }], 'bash -c: its code is read the same way');
  assert.deepEqual(sh('for f in a b; do cat notes/short.md; done'), [{ path: at('notes/short.md') }], 'inside a loop');
  assert.deepEqual(sh('cat docs/*.md').map((r) => r.path).sort(), [at('docs/DECISIONS.md'), at('docs/PLAN.md')].sort(), 'a glob: what it matches');
});

test('git: a version from the history, a commit, a blame', () => {
  const reads = sh('cd app && git show 1a2b3c4d:README.md | head -5 && git show 9f8e7d6c5b --stat && git log --oneline -5');
  assert.deepEqual(reads, [{ path: at('app/README.md'), rev: '1a2b3c4d', from: 1, to: 5 }, { rev: '9f8e7d6c5b' }], 'the version (its path from the repository’s root) and the commit; a log reads neither');
  assert.deepEqual(sh('git show abcdef1 | grep x'), [], 'a commit piped into a search: not read');
  assert.deepEqual(sh('git blame -L 5,9 docs/PLAN.md'), [{ path: at('docs/PLAN.md'), from: 5, to: 9, lines: 40 }]);
  assert.deepEqual(sh('git -C app show HEAD~1:./README.md'), [{ path: at('app/README.md'), rev: 'HEAD~1' }], '-C moves git; ./ is from there');
});

test('output the shell cut to its tail showed only a part of what was read', () => {
  const cut = '…\n\n[Showing lines 1801-2000 of 2000. Full output: C:\\Temp\\pi-bash-0123456789abcdef.log]';
  assert.deepEqual(sh('cat docs/DECISIONS.md', cut), [{ path: at('docs/DECISIONS.md'), part: true }]);
});

test('ranges read in several calls cover a file when together they run from its first line to its end', () => {
  assert.deepEqual(mergeRanges([[30, 60], [1, 29], [61, null]]), [[1, null]]);
  assert.equal(coversAll([[1, 60], [61, 120]], 120), true);
  assert.equal(coversAll([[1, 60], [62, 120]], 120), false, 'a line missed');
  assert.equal(coversAll([[1, 60], [55, null]], null), true, 'one runs to the end');
  assert.equal(coversAll([[2, null]], null), false, 'the first line missed');
  assert.equal(lineCount(at('docs/PLAN.md')), 40);
  write('notes/no-newline.md', 'a\nb\nc');
  assert.equal(lineCount(at('notes/no-newline.md')), 3, 'a last line without a newline counts');
});

test('the file tool: from its offset to where pi’s notice says it stopped, or to the end', () => {
  const read = (args: Record<string, unknown>, text: string) => fileToolReads(args, text, root);
  assert.deepEqual(read({ path: 'docs/PLAN.md' }, 'plan 1\n…\nplan 40\n'), [{ path: at('docs/PLAN.md') }], 'no notice: all of it');
  assert.deepEqual(read({ path: at('docs/DECISIONS.md') }, '…\n\n[Showing lines 1-80 of 121 (50.0KB limit). Use offset=81 to continue.]'), [{ path: at('docs/DECISIONS.md'), from: 1, to: 80, lines: 120 }], 'pi cut it at its size limit');
  assert.deepEqual(read({ path: 'docs/DECISIONS.md', offset: 1, limit: 30 }, '…\n\n[90 more lines in file. Use offset=31 to continue.]'), [{ path: at('docs/DECISIONS.md'), from: 1, to: 30, lines: 120 }]);
  assert.deepEqual(read({ path: 'docs/DECISIONS.md', offset: 100, limit: 50 }, '…decision 120\n'), [{ path: at('docs/DECISIONS.md'), from: 100, lines: 120 }], 'from its offset to the end');
  assert.deepEqual(read({ path: 'docs/DECISIONS.md', offset: 1, limit: 500 }, '…decision 120\n'), [{ path: at('docs/DECISIONS.md') }], 'a limit past the end: all of it');
  assert.deepEqual(read({ path: 'docs/DECISIONS.md' }, '[Line 1 is 80KB, exceeds 50.0KB limit. Use bash: sed -n \'1p\' x | head -c 51200]'), [], 'nothing shown');
});

test('the ledger’s document read: the current version is the file, another is the history; a commit by its full hash', () => {
  const repoRoot = (id: string) => (id === 'si_app' ? at('app') : null);
  const current = JSON.stringify({ id: 'doc:README.md@abc1234567', repo: 'si_app', path: 'README.md', commit: 'abc1234567ff', current: true, lines: 12, fromLine: 1, toLine: 12, text: '…' }, null, 1);
  assert.deepEqual(ledgerDocReads(current, repoRoot), [{ path: at('app/README.md') }]);
  const old = JSON.stringify({ id: 'doc:README.md@0011223344', repo: 'si_app', path: 'README.md', commit: '0011223344aa', lines: 90, fromLine: 1, toLine: 40, nextFromLine: 41, text: '…' }, null, 1);
  assert.deepEqual(ledgerDocReads(old, repoRoot), [{ path: at('app/README.md'), rev: '0011223344aa', from: 1, to: 40, lines: 90 }], 'a version from the history, its first forty lines');
  assert.deepEqual(ledgerDocReads('ERROR: No such version in the ledger', repoRoot), []);
  assert.deepEqual(ledgerCommitReads({ hash: 'f0d266b' }, '{\n "id": "commit:f0d266b3a1b4",\n "hash": "f0d266b3a1b4e0fbf41df30921b7d03702e6fca7"\n}'), [{ rev: 'f0d266b3a1b4e0fbf41df30921b7d03702e6fca7' }]);
});

test('a refused call read nothing; a command that ran and exited non-zero showed its output; other tools are not recorded', () => {
  const ctx = { cwd: root };
  assert.deepEqual(stepReads('bash', { command: 'cat docs/PLAN.md' }, 'Refused: this command reads through a command substitution…', true, ctx), []);
  assert.deepEqual(stepReads('bash', { command: 'head -3 docs/PLAN.md && grep -c zzz docs/PLAN.md' }, 'plan 1\nplan 2\nplan 3\n0\n\nCommand exited with code 1', true, ctx), [{ path: at('docs/PLAN.md'), from: 1, to: 3, lines: 40 }]);
  assert.deepEqual(stepReads('read', { path: 'docs/nothing.md' }, 'ENOENT', true, ctx), []);
  assert.equal(stepReads('grep', { pattern: 'x' }, '', false, ctx), null, 'grep is not a read');
  assert.equal(stepReads('pk_read_source', { id: 'src_1' }, '{}', false, ctx), null, 'counted by its target, as before');
  assert.deepEqual(one(stepReads('bash', { command: 'cat docs/PLAN.md' }, 'plan 1', false, ctx)!, 'docs/PLAN.md'), [{ path: at('docs/PLAN.md') }]);
});
