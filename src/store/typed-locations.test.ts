/**
 * A location as its owner types it into the workbench (util/paths.ts `expandHome`; store/workspace.ts `add`;
 * server/app.ts `addScopeItem`).
 *
 * A Mac's owner writes `~/code/kestrel`. A shell turns `~` into the home directory before a program sees it; the Add
 * project field is no shell, and the location was taken for a directory named `~` under wherever ProjectKeeper had
 * been started — "does not exist". `~` and `~/…` are now the home directory, on every system.
 *
 * The home is a temporary directory here: the machine's own is not read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from '../util/tmp.test-helpers.ts';

const fakeHome = mkdtempSync(join(tmpdir(), 'pk-typed-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-typed-pi-'));
mkdirSync(join(fakeHome, 'code', 'kestrel', 'docs'), { recursive: true });
writeFileSync(join(fakeHome, 'code', 'kestrel', 'README.md'), '# Kestrel\n');

const { expandHome, pathKey } = await import('../util/paths.ts');
const { Workspace } = await import('./workspace.ts');
const { App } = await import('../server/app.ts');
const { discoverScope } = await import('../scope/discover.ts');
const { stableId } = await import('../model/ids.ts');
type ScopeQuestion = import('../model/types.ts').ScopeQuestion;

test('~ and ~/… are the home directory; another account’s home and a ~ elsewhere in a path are left as they are', () => {
  assert.equal(expandHome('~'), fakeHome);
  assert.equal(expandHome('~/code/kestrel'), join(fakeHome, 'code', 'kestrel'));
  assert.equal(expandHome('~someone/code'), '~someone/code', 'another account’s home is not this one’s');
  assert.equal(expandHome('code/~/kestrel'), 'code/~/kestrel');
  assert.equal(expandHome(join(fakeHome, 'code')), join(fakeHome, 'code'), 'a whole path stays as it is');
  if (process.platform === 'win32') assert.equal(expandHome('~\\code\\kestrel'), join(fakeHome, 'code', 'kestrel'), 'with the separator Windows writes');
});

test('a project added with ~/… lies under the home directory, and so does a location added to its scope', () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-typed-'));
  const project = Workspace.open(home).add('Kestrel', ['~/code/kestrel']);
  assert.deepEqual(project.locations, [join(fakeHome, 'code', 'kestrel')], 'kept as the directory it names, in the file system’s spelling');

  const app = new App(home, { organizing: false });
  try {
    const withDocs = app.addScopeItem(project.id, { path: '~/code/kestrel/docs', category: 'Directory', relation: 'Main project', reason: 'the owner added it' });
    const added = withDocs.scope.find((i) => i.reason === 'the owner added it');
    assert.equal(added?.path, join(fakeHome, 'code', 'kestrel', 'docs'));
    assert.equal(added?.missing, null, 'and is found there');
  } finally { app.stopAll(); }
});

test('the source of a copy, answered with ~/…, is the directory under the home', () => {
  const copy = join(fakeHome, 'code', 'kestrel');
  mkdirSync(join(fakeHome, 'code', 'kestrel-original'), { recursive: true });
  const answered = { id: stableId('scopeq', 'copy-source', pathKey(copy)), question: 'Which project is this a copy of?', answer: { text: '~/code/kestrel-original', at: '2026-10-01T00:00:00.000Z', sourceId: null } } as unknown as ScopeQuestion;
  const found = discoverScope({ id: 'p-copy', name: 'Kestrel', locations: [copy] }, { home: fakeHome, existingQuestions: [answered] });
  const item = found.items.find((i) => i.path === copy);
  assert.equal(item?.relation, 'Copy of another project', item?.reason);
  assert.equal(item?.copyOf, join(fakeHome, 'code', 'kestrel-original'));
});
