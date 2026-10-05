/**
 * The project-folder authorization from the workbench (Spec §1.14, §6.10): the Keeper page's view says what it allows
 * and whether it stands; `Authorize…` posts the grant with the words the page recorded for the owner, and the folder is
 * written and committed at once; `Withdraw` revokes it and leaves the folder where it is, still out of the project's
 * material; it can be given again. Over HTTP, as the page calls it. The project is invented ("Skua") and lives in a
 * temporary directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from '../util/tmp.test-helpers.ts';
import { join } from 'node:path';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-pi-agent-'));
const { App } = await import('./app.ts');
const { HttpApp } = await import('./http.ts');
const { registerRoutes } = await import('./api.ts');
const { PROJECT_FOLDER_ALLOWS } = await import('./project-folder-api.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const UI: any = await import(new URL('../../ui/project-folder.js', import.meta.url).href);

const ENV = { GIT_AUTHOR_NAME: 'Skua Dev', GIT_AUTHOR_EMAIL: 'dev@skua.invalid', GIT_COMMITTER_NAME: 'Skua Dev', GIT_COMMITTER_EMAIL: 'dev@skua.invalid' };
const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV }, windowsHide: true }).trim();

async function workbench() {
  const home = mkdtempSync(join(tmpdir(), 'pk-folder-page-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'pk-folder-page-skua-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'user.name', ENV.GIT_AUTHOR_NAME);
  git(dir, 'config', 'user.email', ENV.GIT_AUTHOR_EMAIL);
  writeFileSync(join(dir, 'README.md'), '# Skua\n\nCounts seabirds from the cliff camera.\n');
  git(dir, 'add', '--', 'README.md');
  git(dir, 'commit', '-qm', 'Skua: the README');
  const app = new App(home, { organizing: false });
  const project = app.addProject('Skua', [dir]);
  const http = new HttpApp();
  registerRoutes(http, app, '', '');
  const server = await http.listen(0);
  const base = `http://127.0.0.1:${server.port}/api/projects/${project.id}`;
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  const state = async () => (await call('GET', '/keeper-page')).json.projectFolder;
  const close = async () => { app.stopAll(); await server.close(); };
  return { app, project, dir, call, state, close };
}

test('the Keeper page says what the authorization allows and that it is not granted; nothing is written', async () => {
  const w = await workbench();
  try {
    const pf = await w.state();
    assert.equal(pf.allows, PROJECT_FOLDER_ALLOWS);
    assert.match(pf.allows, /projectkeeper\/.*commits that contain only that folder.*never pushes/, 'one sentence: the folder, the commits, no push');
    assert.equal(pf.allows.split('. ').length, 1, 'one sentence');
    assert.deepEqual([pf.granted, pf.authorizationId, pf.path, pf.usual, pf.grantedAt, pf.lastWrite, pf.withdrawnAt, pf.exists], [false, null, null, 'projectkeeper', null, null, null, false]);
    assert.equal(existsSync(join(w.dir, 'projectkeeper')), false);
    const said = UI.folderStatus(pf);
    assert.deepEqual([said.tag, said.action, said.lines], ['not granted', 'grant', ['Not granted: the Keeper writes nothing into the project.']]);
  } finally { await w.close(); }
});

test('Authorize writes and commits the folder at once; Withdraw stops it and leaves the folder; it can be given again', async () => {
  const w = await workbench();
  try {
    const before = git(w.dir, 'rev-parse', 'HEAD');
    const quote = UI.grantWords({ folder: 'projectkeeper', commits: true });
    const granted = await w.call('POST', '/authorizations/project-folder', { path: 'projectkeeper', commits: true, quote });
    assert.equal(granted.status, 200);
    assert.equal(granted.json.authorization.quote, 'Authorized on the Keeper page: the Keeper may maintain projectkeeper/ in this project and commit that folder alone; it never pushes.', 'the words the page recorded for the owner');
    assert.match(UI.grantOutcome(granted.json.sync), /^Authorized: wrote 4 files, commit [0-9a-f]{7}$/);

    // The folder is there with its four files, in one commit of that folder alone, by the Keeper, on top of the project's.
    const folder = join(w.dir, 'projectkeeper');
    assert.deepEqual(readdirSync(folder).sort(), ['README.md', 'keeper-numbers.md', 'owner-decisions.md', 'semantic-patches.md']);
    assert.equal(git(w.dir, 'rev-parse', 'HEAD~1'), before);
    assert.equal(git(w.dir, 'log', '-1', '--format=%an'), 'ProjectKeeper');
    assert.ok(git(w.dir, 'show', '--pretty=format:', '--name-only', 'HEAD').split(/\r?\n/).filter(Boolean).every((p) => p.startsWith('projectkeeper/')));
    assert.equal(git(w.dir, 'status', '--porcelain'), '', 'nothing else in the project changed');

    let pf = await w.state();
    assert.deepEqual([pf.granted, pf.path, pf.commits, pf.exists, pf.withdrawnAt], [true, folder, true, true, null]);
    assert.equal(pf.authorizationId, granted.json.authorization.id);
    assert.equal(pf.lastWrite.commit, git(w.dir, 'rev-parse', 'HEAD'));
    const said = UI.folderStatus(pf, { time: () => 'T', rel: () => 'R' });
    assert.deepEqual([said.tag, said.tone, said.action], ['granted', 'green', 'withdraw']);
    assert.deepEqual(said.lines, [`Folder: ${folder}`, 'The Keeper commits it itself: each commit contains only this folder and is never pushed.', `Granted T · last written R in commit ${pf.lastWrite.commit.slice(0, 7)}`]);
    assert.ok(w.app.project(w.project.id).scope.some((i) => i.path.toLowerCase() === folder.toLowerCase() && i.relation === 'Excluded'), 'the folder is not read as the project’s material');

    // A second grant while one stands is refused: withdraw first.
    const again = await w.call('POST', '/authorizations/project-folder', { path: 'projectkeeper', quote });
    assert.equal(again.status, 409);

    // Withdraw: the revoke route of every standing authorization, with the id the page was given.
    const withdrawn = await w.call('POST', `/authorizations/${encodeURIComponent(pf.authorizationId)}/revoke`);
    assert.equal(withdrawn.status, 200);
    pf = await w.state();
    assert.deepEqual([pf.granted, pf.authorizationId, pf.path, pf.exists, pf.usual], [false, null, folder, true, 'projectkeeper']);
    assert.ok(pf.withdrawnAt);
    assert.deepEqual(UI.folderStatus(pf, { time: () => 'T' }).lines, ['Not granted: the Keeper writes nothing into the project.', `Withdrawn T. ${folder} is still in the project, with its commits; it is yours to keep or delete.`]);
    assert.ok(existsSync(join(folder, 'README.md')), 'the folder stays where it is');
    assert.ok(w.app.project(w.project.id).scope.some((i) => i.path.toLowerCase() === folder.toLowerCase() && i.relation === 'Excluded'), 'and stays out of the project’s material');
    const head = git(w.dir, 'rev-parse', 'HEAD');

    // Given again, write-only this time: the same folder is taken up, and nothing is committed.
    const second = await w.call('POST', '/authorizations/project-folder', { path: pf.usual, commits: false, quote: UI.grantWords({ folder: pf.usual, commits: false }) });
    assert.equal(second.status, 200);
    assert.match(second.json.authorization.quote, /write it without committing/);
    pf = await w.state();
    assert.deepEqual([pf.granted, pf.commits, pf.path, pf.withdrawnAt], [true, false, folder, null]);
    assert.equal(git(w.dir, 'rev-parse', 'HEAD'), head, 'no new commit');
    assert.equal(UI.folderStatus(pf).lines[1], 'Write-only: the Keeper commits nothing; what it writes appears as uncommitted changes.');
  } finally { await w.close(); }
});

test('a folder the owner names is the one written, and the one a later grant starts from; a bad name is refused with the reason', async () => {
  const w = await workbench();
  try {
    for (const path of ['../outside', '.hidden', 'README.md/x']) {
      const r = await w.call('POST', '/authorizations/project-folder', { path, quote: UI.grantWords({ folder: path, commits: true }) });
      assert.equal(r.status, 400, path);
      assert.ok(r.json.error, 'the page shows why');
    }
    assert.equal((await w.state()).granted, false);
    const r = await w.call('POST', '/authorizations/project-folder', { path: 'docs/keeper', commits: true, quote: UI.grantWords({ folder: 'docs/keeper/', commits: true }) });
    assert.equal(r.status, 200);
    assert.match(r.json.authorization.quote, /maintain docs\/keeper\/ in this project/);
    let pf = await w.state();
    assert.equal(pf.path, join(w.dir, 'docs', 'keeper'));
    assert.ok(existsSync(join(w.dir, 'docs', 'keeper', 'README.md')));
    assert.equal(existsSync(join(w.dir, 'projectkeeper')), false);
    await w.call('POST', `/authorizations/${encodeURIComponent(pf.authorizationId)}/revoke`);
    pf = await w.state();
    assert.deepEqual([pf.granted, pf.usual], [false, 'docs/keeper']);
  } finally { await w.close(); }
});

test('what the page says after a grant that wrote nothing new, or could not commit', () => {
  assert.equal(UI.grantOutcome({ status: 'unchanged', changedFiles: [], commit: null, reason: null }), 'Authorized: the folder was already up to date');
  assert.equal(UI.grantOutcome({ status: 'written', changedFiles: ['README.md'], commit: null, reason: 'The project folder is not in a git repository; files were written without a commit.' }),
    'Authorized: wrote 1 file. The project folder is not in a git repository; files were written without a commit.');
  assert.equal(UI.folderStatus({ granted: true, path: 'P', commits: true, grantedAt: 'G', lastWrite: null }).lines[2], 'Granted G · not written yet');
  assert.equal(UI.folderStatus({ granted: true, path: 'P', commits: false, grantedAt: 'G', lastWrite: { at: 'W', commit: null } }).lines[2], 'Granted G · last written W, not committed');
  assert.deepEqual(UI.folderStatus({ granted: false, path: 'P', withdrawnAt: 'W', exists: false }).lines, ['Not granted: the Keeper writes nothing into the project.', 'Withdrawn W.']);
});
