/**
 * D105 (CU; CKC-07 AC-10, CKC-04 AC-17, AC-18): the top bar counts what matters.
 *
 * - **Ignored directories are not pending.** The owner's home of 2026-10-02 showed `27 pending`, 23 of them files of a
 *   worker's worktree under `.worktrees/`, a directory the repository's `.gitignore` leaves out. A file in such a place
 *   is not pending and not listed as a change to take in — whether intake had read it before or the watcher sees it
 *   change — and the worktree still reaches the ledger through its branch and commits. A worktree in a place nothing
 *   ignores is read as before (E60).
 * - **Too large is skipped, not failed.** The same home showed `1 failed`, red: an archived export page over the size
 *   intake reads of one file. Such a file is recorded as `Skipped: too large` with its size and the limit, listed in
 *   Project scope, counted nowhere in the top bar. What really failed still counts. A home that recorded the file as a
 *   failure shows it as skipped at the next pass, with no step by the owner.
 *
 * The project is invented ("Sandpiper", a tide log) and lives in the temp directory; git is only read by the product.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClerkRound } from '../model/k-types.ts';
import type { PendingMaterial, ScopeItem } from '../model/types.ts';
import type { ProjectStore } from '../store/project-store.ts';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-cu-'));
process.env.USERPROFILE = scratch;
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(scratch, 'pi-'));
const { App } = await import('../server/app.ts');
const { incrementalIntake, recomputeCoverage } = await import('./intake.ts');
const { splitTooLarge, skippedOf, failuresOf } = await import('./skipped.ts');
const { clerkPending } = await import('../keeper/organize/clerk-coverage.ts');
const { ignoredPlaceOf, ignoredPlaceLookup, forgetIgnoredPlaces } = await import('../scope/ignored-place.ts');
const { scopeListView } = await import('../server/workbench-content.ts');
const { makeFileSource } = await import('../sources/anchor.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const UI: any = await import(new URL('../../ui/failures.js', import.meta.url).href);

const apps: InstanceType<typeof App>[] = [];
after(async () => {
  for (const a of apps) { a.stopAll(); await a.flushAll(); }
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left in the temp directory */ }
});

const ENV = { GIT_AUTHOR_NAME: 'Sandpiper Dev', GIT_AUTHOR_EMAIL: 'dev@sandpiper.invalid', GIT_COMMITTER_NAME: 'Sandpiper Dev', GIT_COMMITTER_EMAIL: 'dev@sandpiper.invalid', GIT_AUTHOR_DATE: '2026-09-01T06:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T06:00:00Z' };
const gitIn = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
const put = (dir: string, rel: string, text: string) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };

/** A repository whose `.gitignore` leaves `.worktrees/` out, with a worker's worktree under it and one beside it that nothing ignores. */
function sandpiper(): { repo: string; hidden: string; open: string } {
  const repo = mkdtempSync(join(scratch, 'sandpiper-'));
  put(repo, '.gitignore', '.worktrees/\n*.log\n');
  put(repo, 'README.md', '# Sandpiper\n\nLogs the tide.\n');
  put(repo, 'docs/PLAN.md', '# Plan\n\n## T-1 Log by hand\n');
  put(repo, 'src/tide.ts', 'export const tide = 1;\n');
  gitIn(repo, ['init', '-q', '-b', 'main']);
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-q', '-m', 'Start']);
  const hidden = join(repo, '.worktrees', 'K-wk');
  gitIn(repo, ['worktree', 'add', '-q', hidden, '-b', 'k-wk']);
  put(hidden, 'src/moon.ts', 'export const moon = 2;\n');
  gitIn(hidden, ['add', '-A']);
  gitIn(hidden, ['commit', '-q', '-m', 'T-2 moon phase']);
  put(hidden, 'docs/PLAN.md', '# Plan\n\n## T-1 Log by hand\n\n## T-2 Moon phase (in progress)\n');   // uncommitted
  const open = join(scratch, `sandpiper-open-${Date.now()}`);
  gitIn(repo, ['worktree', 'add', '-q', open, '-b', 'k-open']);
  put(open, 'docs/NOTES.md', '# Notes\n\nSpring tides.\n');   // uncommitted, in a place nothing ignores
  return { repo, hidden, open };
}
const projectScope = (store: ProjectStore) => store.coverage.scopes.find((s) => s.id === 'project')!;
const round = (id: string, at: string, projectId: string): ClerkRound => ({ id, projectId, kind: 'First usable', number: 1, startedAt: at, endedAt: at, status: 'Done', rootJobId: `job_${id}`, questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: at });
const itemAt = (scope: readonly ScopeItem[], path: string) => scope.find((i) => i.path.toLowerCase() === path.toLowerCase());

test('a file under an ignored directory is not pending and not listed as a change to take in; the worktree there still contributes its commits (D105; CKC-04 AC-17)', async () => {
  const f = sandpiper();
  const app = new App(mkdtempSync(join(scratch, 'home-')), { organizing: false });
  apps.push(app);
  app.workspace.setSettings({ watchProjects: false });
  const added = app.addProject('Sandpiper', [f.repo]);
  app.markTakeoverStarted(added.id, 'First picture only');   // the owner's Start (D105): adding a project starts nothing
  await app.intakeProject(added.id);
  const store = app.store(added.id);
  const P = () => app.project(added.id);
  const hidden = itemAt(P().scope, f.hidden)!;
  const open = itemAt(P().scope, f.open)!;
  assert.equal(hidden?.category, 'Worktree', `the worktree under .worktrees/ is a scope item of its own: ${JSON.stringify(P().scope.map((i) => [i.category, i.path]))}`);
  assert.equal(open?.category, 'Worktree');

  // Git says which rule leaves the place out; a worktree nothing ignores, and the repository itself, are in no such place.
  const place = ignoredPlaceOf(P().scope, hidden);
  assert.deepEqual([place?.rule.file, place?.rule.line, place?.rule.pattern], ['.gitignore', 1, '.worktrees/']);
  assert.equal(ignoredPlaceOf(P().scope, open), null);
  assert.equal(ignoredPlaceOf(P().scope, itemAt(P().scope, f.repo)!), null, 'a repository of its own is never left out this way');

  // The worktree's commit the trunk does not have reached the sources, and waits like any commit.
  const commits = store.sources.filter((s) => s.anchor.kind === 'commit' && /T-2 moon phase/.test(s.excerpt));
  assert.equal(commits.length, 1, 'the worktree under the ignored directory still contributes its commit');
  const pending = () => projectScope(store).pending;
  assert.ok(pending().some((p) => p.kind === 'commit' && /T-2 moon phase/.test(p.label)), `its commit waits: ${pending().map((p) => p.label).join(' | ')}`);
  // Its working files do not: not the uncommitted plan, nothing under .worktrees/. The open worktree's note does (E60).
  assert.deepEqual(pending().filter((p) => p.kind === 'file' && p.ref.toLowerCase().includes('.worktrees')), [], 'no file under the ignored directory is pending');
  assert.ok(pending().some((p) => p.kind === 'file' && p.ref.endsWith('NOTES.md')), 'a worktree nothing ignores is read as before');

  // The first round takes in what was read; the top bar's count is then zero.
  await new Promise((r) => setTimeout(r, 20));
  store.clerkRounds.put(round('crd_1', new Date().toISOString(), added.id));
  app.refreshCoverage(added.id);
  assert.deepEqual(pending(), []);

  // A home that read such files before D105 (the 23 of 2026-10-02): the sources are there, read after the round began.
  await new Promise((r) => setTimeout(r, 20));
  const stale = ['ui/app.js', 'package-lock.json', 'tsconfig.json'].map((rel) => makeFileSource({ projectId: added.id, path: join(f.hidden, rel), headingPath: [], lineStart: 1, lineEnd: 1, excerpt: `// ${rel}`, fileText: `// ${rel}`, scopeItemId: hidden.id, readAt: new Date().toISOString() }));
  store.sources.putMany(stale, { jobId: null, summary: 'as an older intake read them' });
  const beside = makeFileSource({ projectId: added.id, path: join(f.open, 'docs', 'MORE.md'), headingPath: [], lineStart: 1, lineEnd: 1, excerpt: '# More', fileText: '# More', scopeItemId: open.id, readAt: new Date().toISOString() });
  put(f.open, 'docs/MORE.md', '# More\n');
  store.sources.put(beside, { jobId: null, summary: 'read' });
  app.refreshCoverage(added.id);
  assert.deepEqual(pending().map((p) => p.label.split('/').pop()), ['MORE.md'], 'none of the files read under the ignored directory is pending; the one beside it is');

  // The watcher's list is filtered the same way (what it saw and has not settled).
  const watched: PendingMaterial[] = [
    { kind: 'file', ref: join(f.hidden, 'src', 'moon.ts'), label: 'moon.ts', since: new Date().toISOString() },
    { kind: 'file', ref: join(f.repo, 'README.md'), label: 'README.md', since: new Date().toISOString() },
  ];
  assert.deepEqual(clerkPending(store, P(), watched).pending.map((p) => p.label).sort(), ['README.md', projectScope(store).pending[0]!.label].sort());
  assert.deepEqual(recomputeCoverage(store, P(), { watcher: watched }).scopes[0]!.pending.map((p) => p.label).sort(), ['README.md', projectScope(store).pending[0]!.label].sort());
  const lookup = ignoredPlaceLookup(P().scope);
  assert.ok(lookup(join(f.hidden, 'anything.ts')) && !lookup(join(f.repo, 'README.md')) && !lookup(join(f.open, 'docs', 'NOTES.md')));

  // A change there is no change to take in: incremental intake reads nothing of it.
  const before = store.sources.size;
  put(f.hidden, 'src/sun.ts', 'export const sun = 3;\n');
  const taken = incrementalIntake(store, P(), [{ kind: 'file', ref: join(f.hidden, 'src', 'sun.ts'), label: 'sun.ts', since: new Date().toISOString(), lastEventAt: Date.now(), scopeItemId: hidden.id }]);
  assert.equal(taken.sourcesUpserted, 0);
  assert.equal(store.sources.size, before, 'nothing was read from the worktree under the ignored directory');

  // The scope list says it, with counts (§6.7): the working files, how many are uncommitted changes, and that the
  // branch and commits are still read. An ignored directory says the same of its files.
  const row = scopeListView(P()).inScope.find((x) => x.item.id === hidden.id)!;
  assert.match(row.worktree!.sentence, /^Not merged into main: 1 commit main does not have/);
  assert.match(row.worktree!.sentence, /In a directory the project’s ignore rules leave out \(\.gitignore line 1: \.worktrees\/\): its \d+ working files \(1 uncommitted change among them\) are not counted as pending; its branch and commits are read from version control$/);
  assert.doesNotMatch(scopeListView(P()).inScope.find((x) => x.item.id === open.id)!.worktree!.sentence, /not counted as pending/);
});

test('an ignored directory in the scope list says its files are not counted as pending, with the count', () => {
  const item = { id: 'si_ign', path: 'D:\\sandpiper\\cache', category: 'Directory', relation: 'Excluded', reason: 'ignored', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'keeper', ignoredBy: { file: '.gitignore', line: 3, pattern: 'cache/', files: 1434, documents: 0, documentNames: [] } } as unknown as ScopeItem;
  const project = { id: 'p', name: 'Sandpiper', locations: ['D:\\sandpiper'], scope: [item], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: '2026-09-01T00:00:00Z' } as any;
  const view = scopeListView(project).excluded[0]!;
  assert.equal(view.ignored!.sentence, '1434 files left out · not counted as pending');
  assert.equal(view.ignored!.rule, '.gitignore line 3: cache/');
});

test('a file over the size limit is skipped, not failed: listed in Project scope with its size and the limit, counted nowhere in the top bar (D105; CKC-04 AC-18)', async () => {
  const repo = mkdtempSync(join(scratch, 'tern-'));
  put(repo, 'README.md', '# Tern\n\nCounts terns.\n');
  put(repo, 'archive/export-20260917.html', `<html>${'x'.repeat(2_300_000)}</html>\n`);
  gitIn(repo, ['init', '-q', '-b', 'main']);
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-q', '-m', 'Start']);
  const big = join(repo, 'archive', 'export-20260917.html');
  const app = new App(mkdtempSync(join(scratch, 'home-')), { organizing: false });
  apps.push(app);
  app.workspace.setSettings({ watchProjects: false });
  const added = app.addProject('Tern', [repo]);
  app.markTakeoverStarted(added.id, 'First picture only');   // the owner's Start (D105): adding a project starts nothing
  await app.intakeProject(added.id);
  const store = app.store(added.id);
  const scope = () => projectScope(store);

  assert.deepEqual(scope().failed, [], 'not a failure');
  assert.equal(scope().skipped?.length, 1);
  const s = scope().skipped![0]!;
  assert.deepEqual([s.ref.toLowerCase(), s.bytes, s.limit], [big.toLowerCase(), statSync(big).size, 2_000_000], 'recorded with its size and the limit');
  assert.ok(!scope().pending.some((p) => p.ref.toLowerCase() === big.toLowerCase()), 'and it is not pending');
  // The top bar: its failed button counts none of it; Project scope's list has it, and the levels count it (§1.11).
  assert.deepEqual(UI.failuresOf(store.coverage), [], 'the top bar counts 0 failed, and the red button stays hidden');
  assert.deepEqual(UI.skippedOf(store.coverage).map((x: any) => [x.ref.toLowerCase(), x.bytes, x.limit]), [[big.toLowerCase(), statSync(big).size, 2_000_000]]);
  assert.equal(UI.skippedText(UI.skippedOf(store.coverage)[0]), `2.3 MB (${statSync(big).size.toLocaleString('en-US')} bytes) · the most intake reads of one file is 2 MB (2,000,000 bytes)`);
  const level = store.coverage.takeover!.levels.find((l) => l.level === 'Skipped: too large')!;
  assert.deepEqual([level.materials, level.byKind], [1, { file: 1 }]);

  // What really failed still counts, and stays apart: an unreadable file beside it.
  const real = { ref: join(repo, 'locked.md'), reason: 'unreadable: EPERM: operation not permitted', at: new Date().toISOString() };
  store.setCoverage({ ...store.coverage, scopes: [{ ...scope(), failed: [real] }] });
  app.refreshCoverage(added.id);
  assert.deepEqual(scope().failed, [real]);
  assert.equal(scope().skipped?.length, 1);
  assert.deepEqual(UI.failuresOf(store.coverage).map((x: any) => x.reason), ['unreadable: EPERM: operation not permitted'], 'the top bar counts 1 failed: the real one');
  assert.deepEqual(failuresOf(store.coverage.scopes).length, 1);

  // Skipped again at a later pass: still one entry, the latest; read once it is small enough: no entry at all.
  await new Promise((r) => setTimeout(r, 5));
  incrementalIntake(store, app.project(added.id), [{ kind: 'file', ref: big, label: 'export', since: new Date().toISOString(), lastEventAt: Date.now(), scopeItemId: app.project(added.id).scope[0]!.id }]);
  assert.equal(scope().skipped?.length, 1);
  assert.ok(scope().skipped![0]!.at > s.at, 'the latest is kept');
  assert.deepEqual(scope().failed, [real], 'and the real failure it had stays');
  writeFileSync(big, '<html>small now</html>\n');
  incrementalIntake(store, app.project(added.id), [{ kind: 'file', ref: big, label: 'export', since: new Date().toISOString(), lastEventAt: Date.now(), scopeItemId: app.project(added.id).scope[0]!.id }]);
  assert.deepEqual(scope().skipped, [], 'a file that is read is no longer skipped');
  assert.ok(store.sources.filter((x) => x.anchor.kind === 'file' && x.anchor.path.toLowerCase() === big.toLowerCase()).length > 0, 'and its text is read');
});

test('an older home’s failure entry for a file over the limit shows as skipped at the next pass, with no step by the owner; the owner can leave the file out of the scope', async () => {
  const repo = mkdtempSync(join(scratch, 'knot-'));
  put(repo, 'README.md', '# Knot\n');
  put(repo, 'archive/graph.html', `<html>${'y'.repeat(2_100_000)}</html>\n`);
  gitIn(repo, ['init', '-q', '-b', 'main']);
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-q', '-m', 'Start']);
  const big = join(repo, 'archive', 'graph.html');
  const app = new App(mkdtempSync(join(scratch, 'home-')), { organizing: false });
  apps.push(app);
  app.workspace.setSettings({ watchProjects: false });
  const added = app.addProject('Knot', [repo]);
  app.markTakeoverStarted(added.id, 'First picture only');   // the owner's Start (D105): adding a project starts nothing
  await app.intakeProject(added.id);
  const store = app.store(added.id);
  const scope = () => projectScope(store);
  // As the home of 2026-10-02 holds it: a failure, recorded twice over the passes, and no `skipped` at all.
  const old = [{ ref: big, reason: 'larger than 2000000 bytes', at: '2026-10-02T02:45:25.581Z' }, { ref: big, reason: 'larger than 2000000 bytes', at: '2026-10-02T20:16:53.475Z' }];
  const { skipped: _dropped, ...withoutSkipped } = scope();
  store.setCoverage({ ...store.coverage, scopes: [{ ...withoutSkipped, failed: old }] });
  // Before any pass, the interface already reads it as skipped (ui/failures.js); the server's readers agree.
  assert.deepEqual(UI.failuresOf(store.coverage), []);
  assert.equal(UI.skippedOf(store.coverage).length, 1);
  assert.deepEqual(skippedOf(store.coverage.scopes).map((x) => [x.bytes, x.limit, x.at]), [[statSync(big).size, 2_000_000, '2026-10-02T20:16:53.475Z']]);
  // The next pass that writes the coverage moves it over.
  app.refreshCoverage(added.id);
  assert.deepEqual(scope().failed, []);
  assert.deepEqual(scope().skipped, [{ ref: big, bytes: statSync(big).size, limit: 2_000_000, at: '2026-10-02T20:16:53.475Z' }]);

  // An entry whose file is gone keeps its place with no size; a file under a location the owner left out is not listed.
  assert.deepEqual(splitTooLarge([{ ref: join(repo, 'gone.html'), reason: 'larger than 2000000 bytes', at: '2026-10-02T20:16:53.475Z' }]).skipped, [{ ref: join(repo, 'gone.html'), bytes: null, limit: 2_000_000, at: '2026-10-02T20:16:53.475Z' }]);
  app.addScopeItem(added.id, { path: big, category: 'Directory', relation: 'Excluded', reason: 'Too large to read; left out by the owner' });
  app.refreshCoverage(added.id);
  assert.deepEqual(scope().skipped, [], 'left out of the scope: no longer listed');
  forgetIgnoredPlaces();
});
