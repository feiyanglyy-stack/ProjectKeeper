/**
 * Intake's pending list (QC of increment K; CKC-07 AC-1, AC-10): intake computed what waits by fact records — every source
 * no fact record was about — and the clerk method's rounds write none, so until the organizing service's next pass the
 * coverage listed nearly every source as pending. Now there is one list: intake records what it owns (what it could not
 * take in, with the reason) and leaves what waits to the organizing service, whose coverage the App writes right after
 * every intake and which carries intake's failures over; `recomputeCoverage` lists what waits the organizing service's way.
 *
 * The project is invented ("Plover", a shorebird log) and lives in the temp directory; git is only read.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClerkRound } from '../model/k-types.ts';
import type { PendingMaterial, Project, ScopeItem } from '../model/types.ts';
import type { ProjectStore } from '../store/project-store.ts';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-intake-cov-'));
process.env.USERPROFILE = scratch;
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(scratch, 'pi-'));
const { App } = await import('../server/app.ts');
const { ProjectStore: Store } = await import('../store/project-store.ts');
const { fullIntake, incrementalIntake, latestFailures, recomputeCoverage } = await import('./intake.ts');
const { clerkPending } = await import('../keeper/organize/clerk-coverage.ts');

const apps: InstanceType<typeof App>[] = [];
after(async () => {
  for (const a of apps) { a.stopAll(); await a.flushAll(); }
  // Best effort: under a parallel run Windows can still hold a file of a just-stopped app (EPERM); the scratch is in the
  // system temp directory, so leaving it is harmless, and a cleanup failure is not this test's result.
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left in the temp directory */ }
});

const ENV = { GIT_AUTHOR_NAME: 'Plover Dev', GIT_AUTHOR_EMAIL: 'dev@plover.invalid', GIT_COMMITTER_NAME: 'Plover Dev', GIT_COMMITTER_EMAIL: 'dev@plover.invalid', GIT_AUTHOR_DATE: '2026-09-01T06:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T06:00:00Z' };
function plover(): string {
  const dir = mkdtempSync(join(scratch, 'plover-'));
  const write = (rel: string, text: string) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
  write('README.md', '# Plover\n\nLogs shorebirds.\n');
  write('docs/PLAN.md', '# Plan\n\n## P-1 Log by hand\n');
  write('src/log.ts', 'export const log = 1;\n');
  // Too large to read: intake says so, with the reason (CKC-07 AC-10).
  write('docs/archive-dump.md', `# Dump\n\n${'x'.repeat(2_100_000)}\n`);
  const git = (args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Start']);
  return dir;
}
const projectScope = (store: ProjectStore) => store.coverage.scopes.find((s) => s.id === 'project')!;
const round = (id: string, at: string): ClerkRound => ({ id, projectId: 'p', kind: 'First usable', number: 1, startedAt: at, endedAt: at, status: 'Done', rootJobId: `job_${id}`, questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: at });

test('intake records what it could not take in, and leaves what waits as it was', async () => {
  const dir = plover();
  const store = Store.open('p-alone', mkdtempSync(join(scratch, 'home-')));
  const item = { id: 'si', path: dir, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as unknown as ScopeItem;
  const project = { id: 'p-alone', name: 'Plover', locations: [dir], scope: [item], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: '2026-09-01T00:00:00Z' } as unknown as Project;
  const listed: PendingMaterial[] = [{ kind: 'file', ref: join(dir, 'docs', 'PLAN.md'), label: 'docs/PLAN.md', since: '2026-09-01T00:00:00.000Z' }];
  store.setCoverage({ ...store.coverage, scopes: [{ id: 'project', kind: 'project', label: 'Plover', coverage: 'Changes pending', asOf: null, commit: null, pending: listed, organizing: [], failed: [], lastRelookAt: null }] });
  await fullIntake(store, project);
  assert.ok(store.sources.size >= 4, 'intake read the project');
  assert.deepEqual(projectScope(store).pending, listed, 'the list is the organizing service’s, not intake’s: intake did not write one of its own');
  // A file over the size limit is recorded as skipped, with its size and the limit — not as a failure (D105).
  const skipped = () => projectScope(store).skipped ?? [];
  assert.ok(skipped().some((f) => f.ref.endsWith('archive-dump.md') && f.limit === 2_000_000 && (f.bytes ?? 0) > 2_000_000), `what it could not read is recorded with its size and the limit: ${JSON.stringify(skipped())}`);
  assert.deepEqual(projectScope(store).failed, [], 'and it is no failure');
  assert.ok(projectScope(store).asOf, 'and when it read, the point the next intake reads new commits from');
  writeFileSync(join(dir, 'docs', 'PLAN.md'), '# Plan\n\n## P-1 Log by hand\n\n## P-2 Log by ear\n');
  incrementalIntake(store, project, [{ kind: 'file', ref: join(dir, 'docs', 'PLAN.md'), label: 'docs/PLAN.md', since: new Date().toISOString(), lastEventAt: Date.now(), scopeItemId: 'si' }]);
  assert.deepEqual(projectScope(store).pending, listed, 'incremental intake leaves it too');
  assert.ok(skipped().some((f) => f.ref.endsWith('archive-dump.md')), 'and keeps what it had recorded');
  // The same file skipped again is one entry, the latest (owner 2026-09-30: "2 failed" was one file recorded twice).
  const first = skipped().find((f) => f.ref.endsWith('archive-dump.md'))!;
  await new Promise((r) => setTimeout(r, 5));
  writeFileSync(join(dir, 'docs', 'archive-dump.md'), `# Dump\n\n${'y'.repeat(2_100_000)}\n`);
  incrementalIntake(store, project, [{ kind: 'file', ref: join(dir, 'docs', 'archive-dump.md'), label: 'docs/archive-dump.md', since: new Date().toISOString(), lastEventAt: Date.now(), scopeItemId: 'si' }]);
  const dump = skipped().filter((f) => f.ref.endsWith('archive-dump.md'));
  assert.equal(dump.length, 1, `one entry per file: ${JSON.stringify(skipped())}`);
  assert.ok(dump[0]!.at > first.at, 'the latest is kept');
});

test('latestFailures keeps one entry per ref, the latest, in the order the kept ones came', () => {
  const f = (ref: string, at: string) => ({ ref, reason: 'larger than 2000000 bytes', at });
  assert.deepEqual(latestFailures([f('a', '2026-09-30T17:33:26Z'), f('b', '2026-09-30T17:35:00Z'), f('a', '2026-09-30T17:40:12Z')]), [f('b', '2026-09-30T17:35:00Z'), f('a', '2026-09-30T17:40:12Z')]);
  assert.deepEqual(latestFailures([f('a', '2026-09-30T17:40:12Z'), f('a', '2026-09-30T17:33:26Z')]), [f('a', '2026-09-30T17:40:12Z')], 'an older one listed later does not replace the latest');
  assert.deepEqual(latestFailures([]), []);
});

test('through the App, what waits after intake is the organizing service’s list, failures carried over — not every source', async () => {
  const dir = plover();
  const app = new App(mkdtempSync(join(scratch, 'home-')), { organizing: false });
  apps.push(app);
  app.workspace.setSettings({ watchProjects: false });
  const added = app.addProject('Plover', [dir]);
  app.markTakeoverStarted(added.id, 'First picture only');   // the owner's Start (D105): adding a project starts nothing
  await app.intakeProject(added.id);
  const store = app.store(added.id);
  const P = () => app.project(added.id);
  const refs = () => projectScope(store).pending.map((p) => p.ref);
  assert.deepEqual(refs(), clerkPending(store, P()).pending.map((p) => p.ref), 'before the first round: exactly what the organizing service lists');
  assert.ok((projectScope(store).skipped ?? []).some((f) => f.ref.endsWith('archive-dump.md') && f.limit === 2_000_000), 'what intake skipped as too large is kept, with the limit');
  assert.deepEqual(projectScope(store).failed, [], 'not among the failures (D105)');
  assert.equal(store.coverage.takeover?.stage, 'First usable', 'the coverage is the organizing service’s, takeover included');

  // The first round takes everything in. A rescan reads the project again: nothing waits, although no fact record exists.
  await new Promise((r) => setTimeout(r, 20));
  store.clerkRounds.put({ ...round('crd_1', new Date().toISOString()), projectId: added.id });
  await app.intakeProject(added.id);
  assert.equal(store.facts.size, 0, 'the clerk method writes no fact records');
  assert.deepEqual(refs(), [], `nothing read since the round started waits; intake used to list every source here: ${refs().join(', ')}`);
  assert.equal(projectScope(store).coverage, 'Up to date');
  assert.ok((projectScope(store).skipped ?? []).some((f) => f.ref.endsWith('archive-dump.md')), 'what was skipped stays listed');

  // A change read after the round started: intake alone leaves the list; the App's refresh lists it, and only it.
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(dir, 'docs', 'PLAN.md'), '# Plan\n\n## P-1 Log by hand\n\n## P-2 Log by ear\n');
  incrementalIntake(store, P(), [{ kind: 'file', ref: join(dir, 'docs', 'PLAN.md'), label: 'docs/PLAN.md', since: new Date().toISOString(), lastEventAt: Date.now(), scopeItemId: P().scope[0]!.id }]);
  assert.deepEqual(refs(), [], 'intake did not write a list of its own');
  app.refreshCoverage(added.id);
  assert.deepEqual(projectScope(store).pending.map((p) => p.label), ['docs/PLAN.md'], 'the organizing service lists the changed plan, and nothing else');

  // recomputeCoverage, for a caller without the App, lists what waits the same way, with the watcher's changes it is given.
  const watcher: PendingMaterial[] = [{ kind: 'file', ref: join(dir, 'README.md'), label: 'README.md', since: new Date().toISOString() }];
  assert.deepEqual(recomputeCoverage(store, P(), { watcher }).scopes.find((s) => s.id === 'project')!.pending, clerkPending(store, P(), watcher).pending);
});
