/**
 * Who can read the key file (own-keys.ts, store/paths.ts `ensureHome`).
 *
 * The saved keys are plain text in `<home>/keys.json`. On macOS and Linux a file a program writes is readable by every
 * account of the machine unless the program says otherwise, and so is a directory it makes; on Windows the profile's
 * own access rules cover the home. So off Windows the key file is written for its owner alone (0600), a home the
 * program makes is its owner's alone (0700), and a key file found open to others is closed as it is read. A home that
 * was already there keeps the access its owner gave it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnKeyStore, keysFile } from './own-keys.ts';
import { ProjectStore } from '../store/project-store.ts';
import { Workspace } from '../store/workspace.ts';

const POSIX = process.platform !== 'win32';
const VALUE = 'pk-test-key-file-41c7e2a9d05b';
const mode = (path: string): number => statSync(path).mode & 0o777;

test('the key file is its owner’s alone, and so is a home the program makes', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'pk-keys-file-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  // A home that is not there yet, made by the first thing written into it — here a key.
  const fresh = join(base, 'made-by-the-program', 'home');
  const keys = new OwnKeyStore(fresh);
  keys.add('kestrel', null, VALUE);
  assert.ok(readFileSync(keysFile(fresh), 'utf8').includes(VALUE), 'the key is saved');
  accessSync(keysFile(fresh), constants.R_OK | constants.W_OK);
  if (POSIX) {
    assert.equal(mode(keysFile(fresh)), 0o600, 'the key file: its owner reads and writes it, nobody else');
    assert.equal(mode(fresh), 0o700, 'the home the program made: its owner’s alone');
  }
  // Replacing a key writes the file anew; it stays closed.
  keys.replace('kestrel~1', `${VALUE}-second`);
  if (POSIX) assert.equal(mode(keysFile(fresh)), 0o600);
  assert.equal(new OwnKeyStore(fresh).get('kestrel~1')?.value, `${VALUE}-second`, 'and is read back after a restart');

  // The other first writers make the home the same way: the list of projects, a project's own store.
  const byWorkspace = join(base, 'by-workspace');
  Workspace.open(byWorkspace).setSettings({ watchProjects: false });
  const byStore = join(base, 'by-store');
  ProjectStore.open('p1', byStore);
  for (const home of [byWorkspace, byStore]) {
    assert.ok(existsSync(home));
    if (POSIX) assert.equal(mode(home), 0o700, `${home} was made for its owner alone`);
  }
});

test('a home that was already there keeps its access; a key file found open to others is closed as it is read', (t) => {
  if (!POSIX) { t.skip('Windows keeps who may read a file in the profile’s access rules, not in a mode'); return; }
  const base = mkdtempSync(join(tmpdir(), 'pk-keys-file-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const shared = join(base, 'home-the-owner-made');
  mkdirSync(shared);
  chmodSync(shared, 0o755);
  writeFileSync(keysFile(shared), JSON.stringify({ version: 1, keys: [{ id: 'kestrel~1', provider: 'kestrel', name: 'kestrel key', value: VALUE, addedAt: '2026-10-01T00:00:00.000Z', replacedAt: null }] }));
  chmodSync(keysFile(shared), 0o644);
  const keys = new OwnKeyStore(shared);
  assert.equal(keys.get('kestrel~1')?.value, VALUE, 'the keys are read as they were');
  assert.equal(mode(keysFile(shared)), 0o600, 'and the file is closed to other accounts');
  keys.add('heron', null, `${VALUE}-heron`);
  assert.equal(mode(keysFile(shared)), 0o600);
  assert.equal(mode(shared), 0o755, 'the home itself is left as its owner made it');
});
