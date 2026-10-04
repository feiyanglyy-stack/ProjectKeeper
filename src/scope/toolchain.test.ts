/**
 * Toolchain discovery from the project's own configuration (Spec §6.7; CKC-03 AC-23). A location a
 * config file states, that exists and lies outside the project, is reported with the config item as
 * its reason; a macro, a relative path, or a location inside the project is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { discoverToolchain } from './toolchain.ts';
import { pathKey } from '../util/paths.ts';

/** A value the way a real local.properties escapes it (backslashes doubled, colons escaped). */
const prop = (p: string) => p.replaceAll('\\', '\\\\').replace(/:/g, '\\:');

/** A stand-in home and ProjectKeeper home inside the temp tree, so no test compares against the real ones. */
function fakeHomes(base: string) {
  const home = join(base, 'fake-home');
  const projectKeeperHome = join(base, 'fake-pk-home');
  mkdirSync(home, { recursive: true });
  mkdirSync(projectKeeperHome, { recursive: true });
  return { home, projectKeeperHome };
}

test('a JetBrains library root pointing at an external SDK is discovered with its config as the reason', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-tc-'));
  const project = join(base, 'project');
  const sdk = join(base, 'sdk-home');
  mkdirSync(join(project, '.idea', 'libraries'), { recursive: true });
  mkdirSync(sdk, { recursive: true });
  const url = `file://${sdk.replaceAll('\\', '/')}`;
  writeFileSync(join(project, '.idea', 'libraries', 'SDK.xml'), `<component><library><CLASSES><root url="${url}" /></CLASSES></library></component>`);

  const found = discoverToolchain([project], fakeHomes(base));
  assert.equal(found.length, 1, 'the external SDK is found');
  assert.equal(pathKey(found[0]!.path), pathKey(sdk));
  assert.equal(found[0]!.used, true, 'a narrow SDK directory is used');
  assert.match(found[0]!.reason, /SDK\.xml declares/);
  assert.match(found[0]!.configPath, /SDK\.xml$/);
});

test('a local.properties sdk.dir is discovered; a macro and a path inside the project are not', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-tc-'));
  const project = join(base, 'project');
  const sdk = join(base, 'android-sdk');
  mkdirSync(join(project, 'internal'), { recursive: true });
  mkdirSync(sdk, { recursive: true });
  // Windows paths are escaped the Java-properties way in a real local.properties.
  const escaped = sdk.replaceAll('\\', '\\\\').replace(/:/g, '\\:');
  writeFileSync(join(project, 'local.properties'), [
    `sdk.dir=${escaped}`,
    `macro.dir=$PROJECT_DIR$/tools`,
    `internal.dir=${join(project, 'internal').replaceAll('\\', '\\\\').replace(/:/g, '\\:')}`,
    'sdk.version=3.0.0',   // a version pin, not a path
  ].join('\n'));

  const found = discoverToolchain([project], fakeHomes(base));
  const paths = found.map((f) => pathKey(f.path));
  assert.ok(paths.includes(pathKey(sdk)), 'the external SDK directory is found');
  assert.ok(!paths.includes(pathKey(join(project, 'internal'))), 'a path inside the project is not reported as toolchain');
  assert.equal(found.length, 1, 'the macro and the version pin are ignored');
});

/**
 * A config entry naming something broad must not become an allowed root: a filesystem root, the home directory or
 * an ancestor of it, the ProjectKeeper home or anything that contains it or lies inside it, or a directory that
 * contains the project. It stays listed with a flag and a reason, so the owner can see and correct it (Spec §6.7).
 * The "home" and the ProjectKeeper home are directories created in a temp tree and passed in; nothing real is used.
 */
test('a config entry naming a broad directory is kept but not used, with the reason; a narrow SDK is still used', () => {
  const t = mkdtempSync(join(tmpdir(), 'pk-tc-broad-'));
  const home = join(t, 'home');
  const pkHome = join(t, 'pk-home');
  const otherAssets = join(pkHome, 'projects', 'other-project');
  const work = join(t, 'work');
  const project = join(work, 'project');
  const sdk = join(t, 'sdk');
  for (const d of [home, otherAssets, project, sdk]) mkdirSync(d, { recursive: true });
  const fsRoot = parse(t).root;
  writeFileSync(join(project, 'local.properties'), [
    `narrow.dir=${prop(sdk)}`,
    `homeish.dir=${prop(home)}`,
    `parent.dir=${prop(work)}`,          // contains the project
    `tree.dir=${prop(t)}`,               // contains the home directory
    `drive.dir=${prop(fsRoot)}`,         // the temp dir's filesystem root
    `assets.dir=${prop(pkHome)}`,
    `other.dir=${prop(otherAssets)}`,    // another project's ProjectKeeper assets
  ].join('\n'));

  const found = discoverToolchain([project], { home, projectKeeperHome: pkHome });
  const entry = (p: string) => found.find((f) => pathKey(f.path) === pathKey(p));

  assert.ok(entry(sdk), 'the narrow SDK directory is listed');
  assert.notEqual(entry(sdk)!.used, false, 'the narrow SDK directory is used as a read root');

  const refused: [string, RegExp][] = [
    [home, /^not used: too broad \(the whole home directory\)/],
    [work, /^not used: too broad \(it contains the project directory\)/],
    [t, /^not used: too broad \(it contains the home directory\)/],
    [fsRoot, /^not used: too broad \(a filesystem root\)/],
    [pkHome, /^not used: too broad \(the whole ProjectKeeper home\)/],
    [otherAssets, /^not used: inside the ProjectKeeper home/],
  ];
  for (const [path, reason] of refused) {
    const e = entry(path);
    assert.ok(e, `${path} stays listed so the owner can correct it`);
    assert.equal(e!.used, false, `${path} is not used as a read root`);
    assert.match(e!.notUsedReason ?? '', reason, path);
  }
});

test('nothing is returned when there is no config, and a non-existent declared path is skipped', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-tc-'));
  const project = join(base, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'local.properties'), `sdk.dir=${join(base, 'does-not-exist').replaceAll('\\', '\\\\').replace(/:/g, '\\:')}`);
  assert.deepEqual(discoverToolchain([project], fakeHomes(base)), [], 'a declared path that is not on disk is not added');
});
