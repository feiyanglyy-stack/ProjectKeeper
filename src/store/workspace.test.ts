/**
 * The settings file (`<home>/workspace.json`) as the owner may have left it.
 *
 * Found in use (2026-10-05): a settings file without its `projects` key stopped the server at start with
 * `TypeError: this.workspace.list is not a function or its return value is not iterable`. A file written by hand, or by
 * an earlier version, must load: every key it lacks takes its default. A file that cannot be read as a workspace must
 * say so, naming the file — and must stay as it is, not be set aside for an empty one that the next save writes over
 * the owner's projects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from '../util/tmp.test-helpers.ts';
import { Workspace, WorkspaceFileError } from './workspace.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-workspace-pi-'));
const { App, ownerScopeItems } = await import('../server/app.ts');

/** A home whose settings file holds `content` (text as is, or a value written as JSON). */
function homeWith(content: unknown): { home: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), 'pk-workspace-'));
  const file = join(home, 'workspace.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 1));
  return { home, file };
}
const projectDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'pk-workspace-wren-')); writeFileSync(join(dir, 'README.md'), '# Wren\n'); return dir; };

test('no settings file is an empty workspace with the default settings', () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-workspace-'));
  const w = Workspace.open(home);
  assert.deepEqual([...w.list()], []);
  assert.deepEqual([w.settings.port, w.settings.model, w.settings.modelBackups, w.settings.keeperAgent, w.lastProjectId], [4870, null, [], 'pi', null]);
  assert.deepEqual(readdirSync(home), [], 'opening writes nothing');
});

test('a settings file without `projects` loads: the list is empty, the settings it has are kept, and a project can be added', () => {
  const { home, file } = homeWith({ version: 1, settings: { port: 5123 }, lastProjectId: null });
  const w = Workspace.open(home);
  assert.deepEqual([...w.list()], [], 'the list can be walked');
  assert.equal(w.get('nothing'), undefined);
  assert.equal(w.settings.port, 5123, 'what the file says is kept');
  assert.deepEqual([w.settings.model, w.settings.modelBackups, w.settings.keeperAgent], [null, [], 'pi'], 'what it does not say takes the default');
  const dir = projectDir();
  const added = w.add('Wren', [dir]);
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { projects: { id: string; locations: string[] }[]; settings: { port: number } };
  assert.deepEqual(saved.projects.map((p) => [p.id, p.locations]), [[added.id, [dir]]]);
  assert.equal(saved.settings.port, 5123);
});

test('every other key a settings file lacks takes its default', () => {
  for (const content of [{}, { projects: [] }, { settings: null }, { projects: [], settings: {}, lastProjectId: 'gone-000000' }]) {
    const w = Workspace.open(homeWith(content).home);
    assert.deepEqual([...w.list()], [], JSON.stringify(content));
    assert.deepEqual([w.settings.port, w.settings.keeperAgent, w.lastProjectId], [4870, 'pi', null], JSON.stringify(content));
  }
  // A file a text editor saved with a byte-order mark is still that file.
  assert.equal(Workspace.open(homeWith(`﻿${JSON.stringify({ settings: { port: 5200 } })}`).home).settings.port, 5200);
});

test('a project written by hand with only its id and its locations loads with its other fields at their defaults', () => {
  const dir = projectDir();
  const { home, file } = homeWith({ projects: [{ id: 'wren-0a1b2c', locations: [dir] }], lastProjectId: 'wren-0a1b2c' });
  const before = readFileSync(file, 'utf8');
  const w = Workspace.open(home);
  const p = w.get('wren-0a1b2c')!;
  assert.deepEqual([p.name, p.locations, p.scope, p.scopeQuestions, p.keeperFiles, p.roles, p.language, p.organizingPaused, p.lastOpenedAt, p.lastScopedAt],
    ['wren-0a1b2c', [dir], [], [], [], [], 'en', false, null, null]);
  assert.match(p.createdAt, /^\d{4}-\d\d-\d\dT/, 'a time it was there by');
  assert.equal(w.lastProjectId, 'wren-0a1b2c');
  assert.equal(readFileSync(file, 'utf8'), before, 'reading it does not rewrite it');
});

test('a location an earlier version kept in another spelling is read under its real name, and its own scope item is not taken for one the owner added', () => {
  const dir = projectDir();
  const link = `${dir}-link`;
  symlinkSync(dir, link, 'junction');   // the same directory, spelled another way
  const item = (path: string, addedBy: 'owner' | 'keeper') => ({ id: `scope_${addedBy}`, path, category: 'Directory', relation: 'Main project', reason: '', reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'none', missing: null, addedBy });
  const extra = join(tmpdir(), 'pk-workspace-notes-elsewhere');
  const { home } = homeWith({ version: 1, projects: [{ id: 'wren-0a1b2c', name: 'Wren', locations: [link], scope: [item(link, 'owner'), { ...item(extra, 'owner'), id: 'scope_extra' }], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: '2026-09-01T00:00:00.000Z', lastOpenedAt: null, lastScopedAt: null }], settings: {}, lastProjectId: null });
  const p = Workspace.open(home).get('wren-0a1b2c')!;
  assert.deepEqual(p.locations, [dir], 'the location goes by its real name');
  assert.deepEqual(ownerScopeItems(p).map((i) => i.id), ['scope_extra'], 'the location’s own item is the location, whichever way it was spelled; what the owner added besides stays theirs');
});

test('the workbench starts on a settings file without `projects`', async () => {
  const { home } = homeWith({ version: 1, settings: { port: 5123 } });
  const app = new App(home, { organizing: false });
  try {
    await app.initKeeper();   // where it stopped: the Keeper walks the projects as it starts
    assert.deepEqual([...app.workspace.list()], []);
    assert.equal(app.workspace.settings.port, 5123);
  } finally { app.stopAll(); await app.flushAll(); }
});

test('a settings file that is not a workspace says so, names the file, and is left as it is', () => {
  const dir = projectDir();
  const cases: [content: unknown, says: RegExp][] = [
    ['{ "projects": [ }', /it is not valid JSON/],
    ['', /it is not valid JSON/],
    [[], /does not hold a JSON object/],
    ['"workspace"', /does not hold a JSON object/],
    [{ projects: {} }, /"projects" is not a list/],
    [{ settings: [] }, /"settings" is not an object/],
    [{ projects: ['wren'] }, /project 1 of "projects" is not an object/],
    [{ projects: [{ id: 'wren-0a1b2c', locations: [dir] }, { name: 'Lark', locations: [dir] }] }, /project 2 of "projects" has no "id"/],
    [{ projects: [{ id: 'wren-0a1b2c' }] }, /project 1 of "projects" \(wren-0a1b2c\) has no "locations"/],
    [{ projects: [{ id: 'wren-0a1b2c', locations: [] }] }, /has no "locations"/],
  ];
  for (const [content, says] of cases) {
    const { home, file } = homeWith(content);
    const before = readFileSync(file, 'utf8');
    assert.throws(() => Workspace.open(home), (error: unknown) => {
      assert.ok(error instanceof WorkspaceFileError, String(error));
      assert.equal(error.file, file);
      assert.ok(error.message.includes(file), `the message names the file: ${error.message}`);
      assert.match(error.message, says);
      assert.match(error.message, /Nothing was changed/);
      return true;
    }, JSON.stringify(content));
    assert.equal(readFileSync(file, 'utf8'), before, 'the file is as it was');
    assert.deepEqual(readdirSync(home), ['workspace.json'], 'and nothing was put beside it');
  }
});

test('`pk` on a settings file that cannot be read stops with that message alone, not a stack', () => {
  const { home, file } = homeWith('{ "projects": [ }');
  const cli = resolve(import.meta.dirname, '../cli.ts');
  const run = spawnSync(process.execPath, [cli, 'projects', '--home', home], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  const lines = run.stderr.split(/\r?\n/).filter((l) => l.trim() && !/ExperimentalWarning|--trace-warnings/.test(l));
  assert.equal(lines.length, 1, run.stderr);
  assert.ok(lines[0]!.startsWith(`Cannot read the settings file ${file}: it is not valid JSON`), lines[0]);
  // And a file without `projects` lists nothing, quietly.
  const empty = homeWith({ settings: {} });
  mkdirSync(join(empty.home, 'projects'), { recursive: true });
  const ok = spawnSync(process.execPath, [cli, 'projects', '--home', empty.home], { encoding: 'utf8', windowsHide: true });
  assert.deepEqual([ok.status, ok.stdout], [0, '']);
});
