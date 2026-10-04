/**
 * The shell read boundary and the programs and patterns of awk, sed and the grep family (Spec §3.1; CKC-03 AC-23; D1).
 * The first operand of these commands is a program or a pattern — unless an option gives it (`-e`, `-f` …) — and
 * text like `/^## Heading/{f=1} f` or `/api/` is not a path: it is not checked as one. The files they read are: every
 * file operand, and the program or pattern file an option names (`awk -f`, `sed -f`, `grep -f`), attached or not.
 *
 * Seen on a trial (2026-09-21): an awk command whose program was a regular expression matching two spellings of a
 * heading, run on a file inside the project, was refused as "Out of the project's read boundary: /## …/{f=1} f".
 *
 * The headings and paths are invented. Each test was run on the code before this change first and failed there for the
 * reason it names; the refusals that already held there are kept as they were.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBashCommand, checkPowerShellCommand } from './command.ts';
import { makeBoundary } from './paths.ts';

const base = mkdtempSync(join(tmpdir(), 'pk-program-text-'));
const project = join(base, 'project');
const outside = join(base, 'outside');
mkdirSync(join(project, 'docs'), { recursive: true });
mkdirSync(join(project, 'src'), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(project, 'docs', 'plan.md'), '# Plan\n\n## Tile cache\n\nKeep tiles on disk.\n');
writeFileSync(join(project, 'src', 'prog.awk'), '{ print }\n');
writeFileSync(join(outside, 'secret.txt'), 'x');
writeFileSync(join(outside, 'prog.awk'), '{ print }\n');
writeFileSync(join(outside, 'patterns.txt'), 'x\n');
/** The outside directory as a bash user writes it (/c/… on Windows). */
const toBash = (p: string) => { const fwd = p.replaceAll('\\', '/'); return /^[A-Za-z]:\//.test(fwd) ? `/${fwd[0]!.toLowerCase()}${fwd.slice(2)}` : fwd; };
const out = toBash(outside);
const boundary = makeBoundary({ roots: [{ path: project, label: 'the project directory' }], files: [] });

const ok = (command: string) => {
  const d = checkBashCommand(command, project, boundary);
  assert.equal(d.ok, true, `expected allowed: ${command} — got ${d.reason ?? ''}`);
};
const denied = (command: string, reason: RegExp = /read boundary/) => {
  const d = checkBashCommand(command, project, boundary);
  assert.equal(d.ok, false, `expected refused: ${command}`);
  assert.match(d.reason ?? '', reason, command);
};

test('an awk program that begins with a regular expression is not a path: the file it reads in the project is allowed (D1)', () => {
  ok(`awk '/## Tile cache|## Cache of tiles/{f=1} f' docs/plan.md`);
  ok(`awk '/^## Tile cache/,/^## /' docs/plan.md`);
  ok(`awk -F / '{ print $2 }' docs/plan.md`);                  // a field separator is not a path either
  ok(`awk -v 'mark=/tiles/' '/^## / { print mark }' docs/plan.md`);
  ok(`awk -f src/prog.awk docs/plan.md`);
  denied(`awk '/## Tile cache/{f=1} f' ${out}/secret.txt`);    // the file it reads is checked as before
});

test('a sed script and a grep pattern are not paths; the files they read are (D1)', () => {
  ok(`sed -n '/^## Tile cache/,/^## /p' docs/plan.md`);
  ok(`sed -e '/^$/d' -e 's/tiles/maps/' docs/plan.md`);
  ok(`grep -e '/api/tiles' -e '/api/maps' -rn src`);
  ok(`grep -C 3 '/api/tiles' src`);
  ok(`grep -n -- '/api/' docs/plan.md`);
  denied(`sed -n '/x/p' ${out}/secret.txt`);
  denied(`grep -e '/api/' -rn ${out}`);
});

test('with the program or pattern given by an option, every operand is a file and is checked; so is the program or pattern file (D1)', () => {
  denied(`awk -f src/prog.awk ${out}/secret.txt`);
  denied(`sed -e 's/a/b/' ${out}/secret.txt`);
  denied(`awk -f ${out}/prog.awk docs/plan.md`);
  denied(`awk -f${out}/prog.awk docs/plan.md`);               // attached to the option
  denied(`sed -nf ${out}/prog.awk docs/plan.md`);             // at the end of a cluster of options
  denied(`grep -f ${out}/patterns.txt src`);
  denied(`grep --file=${out}/patterns.txt src`);
  ok(`grep -f docs/plan.md src`);
});

test('an option that takes no value does not hide the file after it, and a command substitution in a pattern stays refused (D1)', () => {
  denied(`grep -I tiles ${out}/secret.txt`);                   // -I (skip binary files) takes no value
  denied(`rg --files ${out}`);                                  // --files lists files: no operand is a pattern
  denied(`grep "$(cat ${out}/secret.txt)" src`, /cannot be checked before it runs|command substitution/);
  denied(`awk "$(cat ${out}/prog.awk)" docs/plan.md`, /cannot be checked before it runs|command substitution/);
  ok(`grep -I tiles docs/plan.md`);
  ok(`rg --files src`);
  ok(`awk '{ print }' - docs/plan.md`);                         // - is standard input
});

test('the same holds for the powershell tool (D1)', () => {
  assert.equal(checkPowerShellCommand(`awk '/## Tile cache/{f=1} f' docs/plan.md`, project, boundary).ok, true);
  assert.equal(checkPowerShellCommand(`awk '/## Tile cache/{f=1} f' ${outside.replaceAll('\\', '/')}/secret.txt`, project, boundary).ok, false);
});
