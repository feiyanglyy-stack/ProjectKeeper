import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { files, version } from '../../patches/pi-ai-0.87.1.ts';
import { applyPiStreamingPatch, originalSource } from '../../scripts/apply-pi-streaming-patch.ts';
import { parseStreamingJson } from '@earendil-works/pi-ai/utils/json-parse';

test('every installed pi-ai copy, including Keeper ModelRuntime dependency, is patched', async () => {
  const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, { version?: string }> };
  const locations = Object.keys(lock.packages).filter((p) => /(?:^|\/)node_modules\/@earendil-works\/pi-ai$/.test(p));
  assert.ok(locations.includes('node_modules/@earendil-works/pi-ai'));
  assert.ok(locations.includes('node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai'));
  for (const location of locations) {
    const installed = JSON.parse(await readFile(new URL(`../../${location}/package.json`, import.meta.url), 'utf8')) as { version: string };
    assert.equal(installed.version, version);
    for (const patch of files) {
      const current = await readFile(new URL(`../../${location}/${patch.path}`, import.meta.url), 'utf8');
      assert.notEqual(current, originalSource(current, patch), `${location}/${patch.path} is still upstream source`);
      for (const [, applied] of patch.replacements) assert.equal(current.split(applied).length, 2, `${location}/${patch.path} is not patched exactly once`);
    }
  }
});

test('patch covers every installed copy, repeats safely, and fails before writing on drift or upgrade', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ao-patch-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const locations = ['node_modules/@earendil-works/pi-ai', 'node_modules/synthetic-parent/node_modules/@earendil-works/pi-ai'];
  const originals = await Promise.all(files.map(async (p) => originalSource(await readFile(new URL('../../node_modules/@earendil-works/pi-ai/' + p.path, import.meta.url), 'utf8'), p)));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: Object.fromEntries(locations.map((p) => [p, { version }])) }));
  for (const location of locations) {
    const dir = join(root, location);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ version }));
    for (const [i, patch] of files.entries()) {
      await mkdir(dirname(join(dir, patch.path)), { recursive: true });
      await writeFile(join(dir, patch.path), originals[i]!);
    }
  }
  const first = join(root, locations[0]!, files[0]!.path);
  const last = join(root, locations[1]!, files.at(-1)!.path);
  await writeFile(last, originals.at(-1)! + '// unexpected drift\n');
  await assert.rejects(applyPiStreamingPatch(root), /differs from supported/);
  assert.equal(await readFile(first, 'utf8'), originals[0]);
  await writeFile(last, originals.at(-1)!);
  const pkg = join(root, locations[1]!, 'package.json');
  await writeFile(pkg, JSON.stringify({ version: '0.87.0' }));
  await assert.rejects(applyPiStreamingPatch(root), /review the patch before upgrading/);
  assert.equal(await readFile(first, 'utf8'), originals[0]);
  await writeFile(pkg, JSON.stringify({ version }));
  assert.deepEqual(await applyPiStreamingPatch(root), { copies: 2, changedFiles: 2 * files.length });
  assert.deepEqual(await applyPiStreamingPatch(root), { copies: 2, changedFiles: 0 });
  for (const location of locations) for (const [i, patch] of files.entries()) {
    const applied = await readFile(join(root, location, patch.path), 'utf8');
    assert.equal(originalSource(applied, patch), originals[i]);
    // Delta calls are throttled; every native provider's final parse accepts only complete JSON (AX). Pi Messages
    // receives finalized arguments from its upstream and has no final parse of its own.
    if (patch.path.includes('/api/')) assert.ok(applied.includes('parseStreamingJsonDelta('));
    if (patch.path.includes('/api/') && !patch.path.endsWith('pi-messages.js')) {
      assert.ok(applied.includes('finalizeStreamingToolArguments('), `${patch.path} finalizes through AX`);
      assert.ok(!/arguments = parseStreamingJson\(/.test(applied), `${patch.path} has no final parse left that salvages`);
    }
  }
});

test('an installation an earlier generation of the patch (AO) patched is brought up to date in place', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ax-patch-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const location = 'node_modules/@earendil-works/pi-ai';
  const originals = await Promise.all(files.map(async (p) => originalSource(await readFile(new URL('../../node_modules/@earendil-works/pi-ai/' + p.path, import.meta.url), 'utf8'), p)));
  // AO's replacements are the ones before the first AX one in each file; validation.js had none.
  const isAX = ([, to]: [string, string]) => /finalizeStreamingToolArguments|incompleteToolArgumentsError/.test(to);
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: { [location]: { version } } }));
  await mkdir(join(root, location), { recursive: true });
  await writeFile(join(root, location, 'package.json'), JSON.stringify({ version }));
  let aoPatched = 0;
  for (const [i, patch] of files.entries()) {
    const ao = patch.replacements.slice(0, patch.replacements.findIndex(isAX) === -1 ? undefined : patch.replacements.findIndex(isAX));
    const text = ao.reduce((s, [from, to]) => s.replace(from, () => to), originals[i]!);
    if (ao.length) aoPatched++;
    // Every prefix of the replacements, not just AO's, is recognised as this file.
    for (let n = 0; n <= patch.replacements.length; n++) {
      assert.equal(originalSource(patch.replacements.slice(0, n).reduce((s, [from, to]) => s.replace(from, () => to), originals[i]!), patch), originals[i]);
    }
    await mkdir(dirname(join(root, location, patch.path)), { recursive: true });
    await writeFile(join(root, location, patch.path), text);
  }
  assert.equal(aoPatched, files.length - 1, 'AO patched every file but validation.js');
  // pi-messages.js has no AX replacement: AO left it as it should be.
  assert.deepEqual(await applyPiStreamingPatch(root), { copies: 1, changedFiles: files.length - 1 });
  assert.deepEqual(await applyPiStreamingPatch(root), { copies: 1, changedFiles: 0 });
  for (const [i, patch] of files.entries()) {
    const applied = await readFile(join(root, location, patch.path), 'utf8');
    assert.equal(applied, patch.replacements.reduce((s, [from, to]) => s.replace(from, () => to), originals[i]!), `${patch.path} is fully patched`);
  }
});

test('partial snapshots have linear aggregate parse size and isolate concurrent calls', async () => {
  const url = new URL('../../node_modules/@earendil-works/pi-ai/dist/utils/json-parse.js', import.meta.url);
  const { parseStreamingJsonDelta } = await import(url.href) as { parseStreamingJsonDelta: (s: string, b: { arguments: unknown }) => unknown };
  const input = JSON.stringify({ note: 'x'.repeat(200000), tail: true });
  const block: { arguments: unknown } = { arguments: {} };
  const other = { arguments: {} };
  let parsedBytes = 0;
  for (let n = 20; n <= input.length; n += 20) {
    const previous = block.arguments;
    block.arguments = parseStreamingJsonDelta(input.slice(0, n), block);
    if (block.arguments !== previous) {
      parsedBytes += n;
      assert.deepEqual(block.arguments, parseStreamingJson(input.slice(0, n)));
    }
    if (n === 2000) assert.deepEqual(parseStreamingJsonDelta('{"other":true}', other), { other: true });
  }
  assert.ok(parsedBytes < input.length * 2, `reparsed ${parsedBytes} for ${input.length} characters`);
  assert.deepEqual(parseStreamingJsonDelta('{"reset":true}', block), { reset: true });
});

test('with no lockfile (ProjectKeeper installed as a package) the copies are the one pi-coding-agent loads and the one ProjectKeeper itself would load', async (t) => {
  // The package sits in someone's node_modules: its dependencies beside it or nested under pi-coding-agent, no package-lock.json of its own.
  const top = await mkdtemp(join(tmpdir(), 'patch-no-lock-'));
  t.after(() => rm(top, { recursive: true, force: true }));
  const root = join(top, 'node_modules', 'projectkeeper');
  const nested = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules', '@earendil-works', 'pi-ai');
  const hoisted = join(top, 'node_modules', '@earendil-works', 'pi-ai');
  const originals = await Promise.all(files.map(async (p) => originalSource(await readFile(new URL('../../node_modules/@earendil-works/pi-ai/' + p.path, import.meta.url), 'utf8'), p)));
  const install = async (dir: string, v = version) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ version: v }));
    for (const [i, patch] of files.entries()) {
      await mkdir(dirname(join(dir, patch.path)), { recursive: true });
      await writeFile(join(dir, patch.path), originals[i]!);
    }
  };
  await mkdir(root, { recursive: true });
  await assert.rejects(applyPiStreamingPatch(root), /pi-ai is not installed where/);
  const agent = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, 'package.json'), '{}');
  await install(nested);
  assert.deepEqual(await applyPiStreamingPatch(root), { copies: 1, changedFiles: files.length });
  assert.deepEqual(await applyPiStreamingPatch(root), { copies: 1, changedFiles: 0 });
  // A second copy beside the package, where ProjectKeeper's own imports resolve: patched too.
  await install(hoisted);
  assert.deepEqual(await applyPiStreamingPatch(root), { copies: 2, changedFiles: files.length });
  // Another version is refused before anything is written, as with a lockfile.
  await install(hoisted, '0.87.0');
  await assert.rejects(applyPiStreamingPatch(root), /review the patch before upgrading/);
  assert.equal(await readFile(join(hoisted, files[0]!.path), 'utf8'), originals[0]);
});
