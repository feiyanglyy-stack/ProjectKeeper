/**
 * Path keys, and what is asked of paths through them (util/paths.ts).
 *
 * A key is what two spellings of one file share, so it folds what the system's file system folds: case on Windows; case
 * and the Unicode form on macOS; nothing elsewhere. The rules are checked here for every system by name, whichever one
 * the tests run on, and the running system's own rule is checked against its file system.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { endsWithPath, foldForSystem, isWithin, partUnder, pathKey, placeUnder, relativeDisplay, samePath } from './paths.ts';
import { tmpdir } from './tmp.test-helpers.ts';

/** `é` and a Korean syllable, composed (NFC) and decomposed (NFD): the same name to a Mac, two texts to a program. */
const COMPOSED = 'caf\u00e9-\uac00';
const DECOMPOSED = COMPOSED.normalize('NFD');

test('a key folds what the system’s file system folds: case on Windows, case and Unicode form on macOS, nothing elsewhere', () => {
  assert.notEqual(COMPOSED, DECOMPOSED, 'the two forms are different text');
  assert.equal(foldForSystem('D:\\Orchard\\Docs', 'win32'), 'd:\\orchard\\docs');
  assert.notEqual(foldForSystem(`D:\\${COMPOSED}`, 'win32'), foldForSystem(`D:\\${DECOMPOSED}`, 'win32'), 'Windows keeps the two forms apart, as its file systems do');
  assert.equal(foldForSystem('/Users/Sam/Orchard', 'darwin'), '/users/sam/orchard');
  assert.equal(foldForSystem(`/Users/sam/${DECOMPOSED}/Plan.md`, 'darwin'), foldForSystem(`/users/SAM/${COMPOSED}/plan.md`, 'darwin'), 'macOS: one key for either case and either form');
  assert.equal(foldForSystem('/home/Sam/Orchard', 'linux'), '/home/Sam/Orchard', 'elsewhere a name is its own key');
  assert.notEqual(foldForSystem(`/home/sam/${COMPOSED}`, 'linux'), foldForSystem(`/home/sam/${DECOMPOSED}`, 'linux'));
});

test('on this system, a directory named in another case is the same path where the file system says it is', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'pk-paths-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const real = join(base, 'Orchard', 'Docs');
  mkdirSync(real, { recursive: true });
  const other = join(base, 'ORCHARD', 'docs');
  assert.equal(samePath(real, real), true);
  assert.equal(isWithin(join(base, 'Orchard'), real), true);
  assert.equal(relativeDisplay(join(base, 'Orchard'), real), 'Docs');
  // Asked of the file system: Windows and a Mac's usual volume take the other case for the same directory.
  if (!existsSync(other)) { t.diagnostic('names that differ only in case are different names on this file system'); assert.equal(process.platform === 'win32', false); return; }
  assert.equal(samePath(real, other), true, 'one key for both cases');
  assert.equal(pathKey(real), pathKey(other));
  assert.equal(isWithin(join(base, 'ORCHARD'), real), true, 'under the directory, however its case is written');
  assert.equal(relativeDisplay(join(base, 'ORCHARD'), join(real, 'Plan.md')), 'Docs/Plan.md', 'the part below keeps the spelling it was given in');
});

test('the part of a path below a directory is found name by name through the fold, and keeps its own spelling', () => {
  const mac = (name: string) => foldForSystem(name, 'darwin');
  assert.equal(partUnder('/Users/sam/Orchard', '/users/SAM/orchard/Docs/Plan.md', '/', mac), 'Docs/Plan.md');
  assert.equal(partUnder(`/Users/sam/${COMPOSED}`, `/Users/sam/${DECOMPOSED}/notes.md`, '/', mac), 'notes.md', 'either Unicode form of the directory');
  assert.equal(partUnder('/Users/sam/orchard', '/Users/sam/orchard', '/', mac), '', 'the directory itself');
  assert.equal(partUnder('/Users/sam/orchard', '/Users/sam/orchard-lab/x.md', '/', mac), null, 'a name that only starts the same is another directory');
  assert.equal(partUnder('/Users/sam/orchard', '/Users/sam', '/', mac), null);
  assert.equal(partUnder('/', '/Users/sam', '/', mac), 'Users/sam', 'under the root directory');
  const exact = (name: string) => name;
  assert.equal(partUnder('/home/sam/Orchard', '/home/sam/orchard/x.md', '/', exact), null, 'with no fold, another case is another directory');
});

test('what lies under a directory, and how a path ends, is asked of paths as this system writes them', () => {
  // These were asked as text with `/` put after a key. A key of this system has the system's separator, so on Windows
  // nothing lay under anything and no path ended in a name.
  const repo = join(tmpdir(), 'pk-paths-work', 'Orchard');
  const file = join(repo, 'docs', 'Plan.md');
  assert.deepEqual(placeUnder([join(tmpdir(), 'pk-paths-work'), repo, join(repo, 'docs-old')], file), { repo: pathKey(repo), path: 'docs/Plan.md' }, 'the innermost directory that holds it, and the path below it with /');
  assert.deepEqual(placeUnder([join(tmpdir(), 'pk-paths-elsewhere')], file), { repo: null, path: pathKey(file) }, 'held by none: the file’s own key');
  assert.deepEqual(placeUnder([file], file), { repo: null, path: pathKey(file) }, 'a file is not under itself');

  assert.equal(endsWithPath(repo, 'orchard'), true, 'a repository named by the last part of its path, whatever the case');
  assert.equal(endsWithPath(repo, 'pk-paths-work/Orchard'), true, 'or by its last parts, written with either separator');
  assert.equal(endsWithPath(repo, 'pk-paths-work\\orchard'), true);
  assert.equal(endsWithPath(repo, 'chard'), false, 'a part of a name is not the name');
  assert.equal(endsWithPath(repo, ''), false);
  assert.equal(endsWithPath('orchard', 'work/orchard'), false, 'more names than the path has');
});
