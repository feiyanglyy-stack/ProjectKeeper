/**
 * What the workbench says about the machine's git as it starts (util/git-check.ts): nothing when git is there and new
 * enough, how to get it when it is missing — the state of a new Mac — and the version needed when it is too old.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitNotice, gitVersionOutput } from './git-check.ts';

test('a git that is there and new enough is not mentioned, however it writes its version', () => {
  for (const said of ['git version 2.53.0.windows.2', 'git version 2.39.5 (Apple Git-154)', 'git version 2.31.0', 'git version 3.0.1']) {
    for (const platform of ['win32', 'darwin', 'linux'] as const) assert.equal(gitNotice(said, platform), null, `${said} on ${platform}`);
  }
});

test('a missing git is said, with what is lost without it and how to get it on this system', () => {
  const mac = gitNotice(null, 'darwin')!;
  assert.match(mac, /^git was not found\./);
  assert.match(mac, /read as a folder of files/);
  assert.match(mac, /xcode-select --install/);
  assert.match(gitNotice(null, 'win32')!, /Git for Windows/);
  // The stand-in a Mac has before the command line tools are installed prints a note and no version.
  assert.match(gitNotice('xcode-select: note: No developer tools were found, requesting install.', 'darwin')!, /^git was not found\./);
});

test('a git too old for the reads is said with the version needed', () => {
  const said = gitNotice('git version 2.24.3 (Apple Git-128)', 'darwin')!;
  assert.match(said, /git is 2\.24; ProjectKeeper needs 2\.31 or later/);
  assert.match(said, /xcode-select --install/);
});

test('this machine’s git is found and new enough for the tests that follow', () => {
  assert.equal(gitNotice(gitVersionOutput()), null);
});
