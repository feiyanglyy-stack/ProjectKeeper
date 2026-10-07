/**
 * `Open in pi` off Windows (open-in-pi.ts): what Terminal is given to run on macOS, where pi's command is found, and
 * that a system with no terminal to open says so with the command to run instead of saying it opened.
 *
 * Terminal itself is never started here: that needs a Mac with a person at it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { findPi, openInPiOffWindows, openInPiScript, piCommandLine, shellWord } from './open-in-pi.ts';

test('a word for the shell keeps a space, a dollar sign and a quote as they are', () => {
  assert.equal(shellWord('/Users/sam/app'), "'/Users/sam/app'");
  assert.equal(shellWord('/Users/sam/My Projects/$app'), "'/Users/sam/My Projects/$app'");
  assert.equal(shellWord("/Users/sam/sam's app"), "'/Users/sam/sam'\\''s app'");
});

test('the script Terminal runs goes to the project and becomes pi, resuming the session when one is given', () => {
  assert.equal(openInPiScript('/Users/sam/My Projects/orchard', null), "#!/bin/sh\ncd '/Users/sam/My Projects/orchard' || exit 1\nexec pi\n");
  assert.equal(
    openInPiScript("/Users/sam/sam's app", '/Users/sam/.pi/agent/sessions/a b.jsonl', '/opt/projectkeeper/node_modules/.bin/pi'),
    "#!/bin/sh\ncd '/Users/sam/sam'\\''s app' || exit 1\nexec '/opt/projectkeeper/node_modules/.bin/pi' --session '/Users/sam/.pi/agent/sessions/a b.jsonl'\n",
  );
  assert.equal(piCommandLine('/Users/sam/orchard', '/Users/sam/.pi/agent/sessions/s.jsonl'), "cd '/Users/sam/orchard' && pi --session '/Users/sam/.pi/agent/sessions/s.jsonl'");
});

test('pi’s command is the one on the PATH, else the one installed with ProjectKeeper, else none', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'pk-find-pi-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const onPath = join(base, 'bin');
  const empty = join(base, 'empty');
  const installed = join(base, 'install', 'pi');
  for (const dir of [onPath, empty, join(base, 'install')]) mkdirSync(dir);
  for (const file of [join(onPath, 'pi'), installed]) { writeFileSync(file, '#!/bin/sh\n'); chmodSync(file, 0o755); }
  assert.equal(findPi([empty, onPath].join(delimiter), join(base, 'nothing')), 'pi', 'found on the PATH: called by its name');
  assert.equal(findPi(empty, installed), installed, 'not on the PATH: the installed one, by its path');
  assert.equal(findPi(empty, join(base, 'nothing')), null);
  assert.equal(findPi('', join(base, 'nothing')), null);
});

test('where no terminal can be opened, nothing is started and the answer is the command to run', () => {
  const said = openInPiOffWindows('/home/sam/orchard', '/home/sam/.pi/agent/sessions/s.jsonl', 'linux').message;
  assert.match(said, /not available on this system/);
  assert.match(said, /cd '\/home\/sam\/orchard' && pi --session '\/home\/sam\/\.pi\/agent\/sessions\/s\.jsonl'/);
  assert.doesNotMatch(said, /^Opened/, 'it does not say it opened anything');
});
