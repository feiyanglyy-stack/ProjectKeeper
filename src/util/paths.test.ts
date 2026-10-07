/**
 * Path keys, what is asked of paths through them, and what is made from a path's own characters (util/paths.ts).
 *
 * A key is what two spellings of one file share, so it folds what the system's file system folds: case on Windows; case
 * and the Unicode form on macOS; nothing elsewhere. The rules are checked here for every system by name, whichever one
 * the tests run on, and the running system's own rule is checked against its file system.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { claudeProjectDirName, endsWithPath, foldForSystem, isWithin, nameForm, partUnder, pathKey, placeUnder, relativeDisplay, samePath } from './paths.ts';
import { tmpdir } from './tmp.test-helpers.ts';

const WIN = process.platform === 'win32';
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

test('the name Claude Code gives a project’s session folder is made from the directory’s own characters', () => {
  // Every character outside A–Z, a–z, 0–9 and `-` becomes `-` — the separators, the drive's colon, a dot, an underscore.
  if (WIN) {
    assert.equal(claudeProjectDirName('D:\\orchard'), 'D--orchard');
    assert.equal(claudeProjectDirName('D:\\my_app'), 'D--my-app');
    assert.equal(claudeProjectDirName('D:\\orchard\\.worktrees\\w9'), 'D--orchard--worktrees-w9');
    assert.equal(claudeProjectDirName('D:\\orchard\\'), 'D--orchard', 'a trailing separator is not part of the name');
  } else {
    // A directory of macOS or Linux starts at the root, so its folder's name starts with `-`.
    assert.equal(claudeProjectDirName('/Users/sam/app'), '-Users-sam-app');
    assert.equal(claudeProjectDirName('/Users/sam/my_app'), '-Users-sam-my-app');
    assert.equal(claudeProjectDirName('/Users/sam/app/.worktrees/w9'), '-Users-sam-app--worktrees-w9');
    assert.equal(claudeProjectDirName('/Users/sam/app/'), '-Users-sam-app', 'a trailing separator is not part of the name');
  }
  // The two Unicode forms of one name give two folder names (a decomposed `é` is `e` and an accent: `e-`), which is
  // why a location is kept in the spelling the file system gives it and never composed: the session host named the
  // folder from that spelling.
  const under = (name: string) => claudeProjectDirName(join(WIN ? 'D:\\' : sep, 'work', name)).split('-').slice(-3).join('-');
  assert.equal(under('caf\u00e9'), 'work-caf-');
  assert.equal(under('caf\u00e9'.normalize('NFD')), 'work-cafe-');
});

test('a name is kept in one Unicode form: composed on macOS, where a listing and git give two, and as it was written elsewhere', () => {
  assert.equal(nameForm(DECOMPOSED, 'darwin'), COMPOSED, 'a listing’s decomposed name, as git reports it');
  assert.equal(nameForm(COMPOSED, 'darwin'), COMPOSED);
  assert.equal(nameForm(`docs/${DECOMPOSED}/plan.md`, 'darwin'), `docs/${COMPOSED}/plan.md`, 'every name of a path');
  assert.equal(nameForm('docs/plan.md', 'darwin'), 'docs/plan.md');
  for (const platform of ['win32', 'linux'] as const) assert.equal(nameForm(DECOMPOSED, platform), DECOMPOSED, `on ${platform} a name is the characters it was written with`);
  // On this system: a path made relative to a location is in that form.
  const root = join(tmpdir(), 'pk-paths-forms');
  assert.equal(relativeDisplay(root, join(root, 'docs', DECOMPOSED)), `docs/${nameForm(DECOMPOSED)}`);
});
