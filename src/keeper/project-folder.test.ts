import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { SemanticPatch, KeeperNumber } from '../model/k-types.ts';
import type { Project, ReferenceItem, Source } from '../model/types.ts';
import { ProjectStore } from '../store/project-store.ts';
import { grantProjectFolderAuthorization, renderProjectFolder, syncProjectFolder } from './project-folder.ts';
import { registerProjectFolderRoutes } from '../server/project-folder-api.ts';
import type { App } from '../server/app.ts';
import type { Handler, HttpApp, RouteContext } from '../server/http.ts';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: process.env, windowsHide: true }).trim();
}

const TEST_ROOT = resolve(import.meta.dirname, '../..');

function fixture(repo = true) {
  const temporary = mkdtempSync(join(TEST_ROOT, '.pk-project-folder-test-'));
  const root = join(temporary, 'project');
  mkdirSync(root);
  if (repo) {
    git(root, 'init', '-q');
    writeFileSync(join(root, 'project.md'), 'project baseline\n');
    git(root, 'add', '--', 'project.md');
    git(root, 'commit', '-qm', 'baseline');
  }
  const project = { id: 'p1', name: 'Example', locations: [root] } as unknown as Project;
  const store = ProjectStore.open(project.id, join(temporary, 'home'));
  const cleanup = () => {
    const rel = relative(TEST_ROOT, resolve(temporary));
    assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep), 'only remove our temporary directory');
    rmSync(temporary, { recursive: true, force: true });
  };
  return { temporary, root, project, store, cleanup };
}

function assets(store: ProjectStore): void {
  const at = '2026-09-25T12:00:00Z';
  const session = {
    id: 'src_session', projectId: store.projectId,
    anchor: { kind: 'session', host: 'codex', sessionId: 'session-123', file: 'session.jsonl', cwd: null, messageStart: 3, messageEnd: 3, at },
    said: { by: 'owner', wordsFrom: 0 }, excerpt: 'Use the new rule.',
  } as unknown as Source;
  const document = {
    id: 'src_doc', projectId: store.projectId,
    anchor: { kind: 'file', path: 'docs/DECISIONS.md', headingPath: ['D4'], lineStart: 12, lineEnd: 14 },
  } as unknown as Source;
  store.sources.put(session);
  store.sources.put(document);
  store.reference.put({
    id: 'ref_decision', projectId: store.projectId, category: 'Decision', name: 'D4', text: 'Use the new rule.', quote: 'Use the new rule.',
    attribution: { author: { kind: 'owner', name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' },
    sourceIds: [session.id, document.id], validity: 'Current',
  } as unknown as ReferenceItem);
  store.numbers.put({ id: 'num_1', projectId: store.projectId, number: 'CK-1', objectId: 'ref_decision', objectKind: 'decision', projectNumber: 'D4', at } as KeeperNumber);
  store.numbers.put({ id: 'num_patch', projectId: store.projectId, number: 'CK-P1', objectId: 'patch_1', objectKind: 'patch', projectNumber: null, at } as KeeperNumber);
  const old = { kind: 'source', id: 'src_old', label: 'old.md:10' } as const;
  store.patches.put({
    id: 'patch_1', projectId: store.projectId, number: 'CK-P1', title: 'Rule changed', invalidated: 'The old rule', replacedBy: 'The new rule',
    affects: ['ref_decision'], affectsText: 'The decision and its plan', mustNotPassAsCurrent: 'The old rule',
    oldAnchor: old, newAnchor: { kind: 'source', id: 'src_doc', label: 'docs/DECISIONS.md:12' }, decision: { kind: 'object', id: 'ref_decision', label: 'D4' },
    candidate: old, partial: true, occurred: { at, basis: 'Session', anchor: session.id }, status: 'Confirmed', writtenToFolder: null,
  } as unknown as SemanticPatch);
}

test('authorization writes real Markdown and commits only the folder while preserving other staged work', () => {
  const old = Object.fromEntries(['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'PK Test', GIT_AUTHOR_EMAIL: 'pk@example.test', GIT_COMMITTER_NAME: 'PK Test', GIT_COMMITTER_EMAIL: 'pk@example.test' });
  const h = fixture();
  try {
    assets(h.store);
    assert.equal(syncProjectFolder(h.store, h.project).status, 'not-authorized');
    assert.equal(existsSync(join(h.root, 'projectkeeper')), false);

    writeFileSync(join(h.root, 'project.md'), 'staged project change\n');
    git(h.root, 'add', '--', 'project.md');
    const authorization = grantProjectFolderAuthorization(h.store, h.project, { quote: 'Keep the ProjectKeeper folder in this project.' });
    assert.equal(authorization.projectFolder?.commits, true);
    const first = syncProjectFolder(h.store, h.project);
    assert.equal(first.status, 'written');
    assert.equal(first.changedFiles.length, 4);
    assert.match(first.commit ?? '', /^[0-9a-f]{40}$/);
    assert.equal(first.reason, null);
    const folder = join(h.root, 'projectkeeper');
    const paths = git(h.root, 'show', '--pretty=format:', '--name-only', 'HEAD').split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(paths, ['projectkeeper/README.md', 'projectkeeper/keeper-numbers.md', 'projectkeeper/owner-decisions.md', 'projectkeeper/semantic-patches.md']);
    assert.equal(git(h.root, 'diff', '--cached', '--name-only'), 'project.md', 'unrelated staged change remains staged');
    assert.equal(git(h.root, 'remote'), '', 'a repository with no remote still commits; sync never pushes');
    assert.match(readFileSync(join(folder, 'semantic-patches.md'), 'utf8'), /partial \(the remainder stays current\)/);
    assert.match(readFileSync(join(folder, 'semantic-patches.md'), 'utf8'), /patch_1/);
    assert.match(readFileSync(join(folder, 'keeper-numbers.md'), 'utf8'), /D4.*alias/s);
    assert.match(readFileSync(join(folder, 'keeper-numbers.md'), 'utf8'), /src_session/);
    assert.match(readFileSync(join(folder, 'owner-decisions.md'), 'utf8'), /docs\/DECISIONS\.md.*L12/);
    assert.equal(h.store.authorizations.get(authorization.id)?.projectFolder?.lastWrite?.commit, first.commit);
    assert.equal(h.store.patches.get('patch_1')?.writtenToFolder?.commit, first.commit);
    assert.equal(renderProjectFolder(h.store, h.project)['semantic-patches.md'], readFileSync(join(folder, 'semantic-patches.md'), 'utf8'));

    const beforeMtime = statSync(join(folder, 'semantic-patches.md')).mtimeMs;
    const second = syncProjectFolder(h.store, h.project);
    assert.equal(second.status, 'unchanged');
    assert.deepEqual(second.changedFiles, []);
    assert.equal(git(h.root, 'rev-parse', 'HEAD'), first.commit, 'unchanged content creates no commit');
    assert.equal(statSync(join(folder, 'semantic-patches.md')).mtimeMs, beforeMtime, 'unchanged file is not rewritten');

    h.store.patches.put({ ...h.store.patches.get('patch_1')!, status: 'Rejected' });
    const rejected = syncProjectFolder(h.store, h.project);
    assert.equal(rejected.changedFiles.includes('semantic-patches.md'), true);
    assert.doesNotMatch(readFileSync(join(folder, 'semantic-patches.md'), 'utf8'), /patch_1/);
    assert.doesNotMatch(readFileSync(join(folder, 'keeper-numbers.md'), 'utf8'), /num_patch/);
    assert.equal(h.store.patches.get('patch_1')?.writtenToFolder, null);

    h.store.authorizations.put({ ...h.store.authorizations.get(authorization.id)!, revokedAt: '2026-09-26T00:00:00Z' });
    const frozen = readFileSync(join(folder, 'owner-decisions.md'), 'utf8');
    h.store.reference.put({ ...h.store.reference.get('ref_decision')!, text: 'Changed after revocation' });
    assert.equal(syncProjectFolder(h.store, h.project).status, 'not-authorized');
    assert.equal(readFileSync(join(folder, 'owner-decisions.md'), 'utf8'), frozen, 'revocation leaves existing files untouched');

    const noCommit = grantProjectFolderAuthorization(h.store, h.project, { quote: 'Keep writing, without committing.', commits: false });
    const lastHead = git(h.root, 'rev-parse', 'HEAD');
    const written = syncProjectFolder(h.store, h.project);
    assert.equal(written.status, 'written');
    assert.equal(written.commit, null);
    assert.equal(git(h.root, 'rev-parse', 'HEAD'), lastHead);
    assert.match(git(h.root, 'status', '--porcelain', '--', 'projectkeeper'), /owner-decisions\.md/);
    assert.equal(h.store.authorizations.get(noCommit.id)?.projectFolder?.lastWrite?.commit, null);
  } finally {
    h.cleanup();
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('an index.lock is retained and a later sync commits the pending folder change', () => {
  const old = Object.fromEntries(['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'PK Test', GIT_AUTHOR_EMAIL: 'pk@example.test', GIT_COMMITTER_NAME: 'PK Test', GIT_COMMITTER_EMAIL: 'pk@example.test' });
  const h = fixture();
  try {
    const baseline = git(h.root, 'rev-parse', 'HEAD');
    grantProjectFolderAuthorization(h.store, h.project, { quote: 'Keep a folder.' });
    const lock = git(h.root, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock');
    writeFileSync(lock, 'held by another git process');
    const blocked = syncProjectFolder(h.store, h.project);
    assert.equal(blocked.status, 'written');
    assert.match(blocked.reason ?? '', /index\.lock/);
    assert.equal(existsSync(lock), true, 'the Keeper does not delete another process’s lock');
    assert.equal(git(h.root, 'rev-parse', 'HEAD'), baseline);
    unlinkSync(lock);
    const resumed = syncProjectFolder(h.store, h.project);
    assert.equal(resumed.status, 'written');
    assert.deepEqual(resumed.changedFiles, []);
    assert.match(resumed.commit ?? '', /^[0-9a-f]{40}$/);
    assert.notEqual(resumed.commit, baseline);
  } finally {
    h.cleanup();
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('path traversal is rejected before authorization and no-git projects only write', () => {
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  // The fixture lives inside this worktree, so stop git's upward search at its boundary for this no-repository case.
  process.env.GIT_CEILING_DIRECTORIES = TEST_ROOT;
  const h = fixture(false);
  try {
    assert.throws(() => grantProjectFolderAuthorization(h.store, h.project, { quote: 'Yes', path: '../outside' }), /project folder/i);
    assert.throws(() => grantProjectFolderAuthorization(h.store, h.project, { quote: 'Yes', path: 'projectkeeper/../outside' }), /Invalid project folder/);
    mkdirSync(join(h.root, 'docs'));
    writeFileSync(join(h.root, 'docs', 'README.md'), '# Project documentation\n');
    assert.throws(() => grantProjectFolderAuthorization(h.store, h.project, { quote: 'Yes', path: 'docs' }), /already contains project files/);
    assert.equal(readFileSync(join(h.root, 'docs', 'README.md'), 'utf8'), '# Project documentation\n');
    assert.equal(h.store.authorizations.size, 0);
    assert.equal(existsSync(join(h.temporary, 'outside')), false);
    const authorization = grantProjectFolderAuthorization(h.store, h.project, { quote: 'Keep a folder.' });
    const result = syncProjectFolder(h.store, h.project);
    assert.equal(result.status, 'written');
    assert.equal(result.commit, null);
    assert.match(result.reason ?? '', /not in a git repository/);
    assert.equal(h.store.authorizations.get(authorization.id)?.projectFolder?.lastWrite?.commit, null);
  } finally {
    h.cleanup();
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  }
});

test('on a machine where git knows no identity, the Keeper is the committer of its own commit, and no configuration is written', () => {
  // No global or system configuration and no identity in the environment: `git commit` alone would stop at "Please tell me who you are".
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'EMAIL'];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'PK Test', GIT_AUTHOR_EMAIL: 'pk@example.test', GIT_COMMITTER_NAME: 'PK Test', GIT_COMMITTER_EMAIL: 'pk@example.test' });
  const h = fixture();   // the baseline commit is the project's own, made with an identity
  try {
    const empty = join(h.temporary, 'empty.gitconfig');
    writeFileSync(empty, '[user]\n\tuseConfigOnly = true\n');   // and never guess one from the machine's user and host names
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1' });
    assert.throws(() => git(h.root, 'var', 'GIT_COMMITTER_IDENT'), 'git knows no identity here');
    const configBefore = readFileSync(join(h.root, '.git', 'config'), 'utf8');
    grantProjectFolderAuthorization(h.store, h.project, { quote: 'Write and commit the folder.' });
    const result = syncProjectFolder(h.store, h.project);
    assert.equal(result.reason, null);
    assert.match(result.commit ?? '', /^[0-9a-f]{40}$/);
    assert.equal(git(h.root, 'log', '-1', '--format=%an <%ae>|%cn <%ce>'), 'ProjectKeeper <keeper@projectkeeper.invalid>|ProjectKeeper <keeper@projectkeeper.invalid>');
    assert.equal(readFileSync(join(h.root, '.git', 'config'), 'utf8'), configBefore, 'the repository\'s configuration is as it was');
  } finally {
    h.cleanup();
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('the registered API validates and records the explicit owner grant without network access', async () => {
  const h = fixture(false);
  try {
    let route: Handler | undefined;
    const http = { route(method: string, path: string, handler: Handler) {
      assert.equal(method, 'POST');
      assert.equal(path, '/api/projects/:id/authorizations/project-folder');
      route = handler;
    } } as HttpApp;
    const excluded: { path: string; relation: string }[] = [];
    const app = { project: () => h.project, store: () => h.store, addScopeItem: (_id: string, item: { path: string; relation: string }) => { excluded.push(item); } } as unknown as App;
    registerProjectFolderRoutes(http, app);
    assert.ok(route);
    const context = (body: unknown) => ({ params: { id: h.project.id }, body } as unknown as RouteContext);
    await assert.rejects(async () => route!(context({ quote: 'Yes', path: '../outside' })), /project folder/i);
    assert.equal(h.store.authorizations.size, 0);
    const response = await route(context({ quote: 'Yes', commits: false })) as { authorization: { projectFolder: { path: string; commits: boolean } }; sync: { status: string } };
    assert.equal(response.authorization.projectFolder.path, join(h.root, 'projectkeeper'));
    assert.equal(response.authorization.projectFolder.commits, false);
    assert.equal(response.sync.status, 'written');
    assert.deepEqual(excluded.map((i) => [i.path, i.relation]), [[join(h.root, 'projectkeeper'), 'Excluded']], 'the folder is kept out of the project’s material');
  } finally { h.cleanup(); }
});
