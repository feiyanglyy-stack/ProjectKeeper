/**
 * The coverage by the clerk method (Spec §1.11, §3.2, §3.8; CKC-07 AC-1, AC-10, AC-11, AC-18; CKC-13 AC-8; QC AY B1, B8):
 *   - what was read after the latest round started waits for the next round, with the watcher's unsettled changes, and
 *     shows as pending; what the rules settle and the Keeper's own commit of its project folder never wait;
 *   - the daily gate opens on that same list, so a change that came in while a round ran is the next round's;
 *   - every material has its organizing level: settled by a rule, not organized (pending), read in full (a job read it),
 *     conclusions only (a drafted session), sampled (a series whose samples were read), indexed — counted by kind.
 * The project is invented ("Wren", a bird-count log) and lives in a temporary directory; git is only read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from '../../util/tmp.test-helpers.ts';
import { join } from 'node:path';
import type { ClerkRound } from '../../model/k-types.ts';
import type { KeeperJob, ProjectRule } from '../../model/types.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-pi-agent-'));
const { App } = await import('../../server/app.ts');
const { incrementalIntake } = await import('../../intake/intake.ts');
const { applyMaterialRules } = await import('../../intake/material-rules.ts');
const { makeSessionSource } = await import('../../sources/anchor.ts');
const { clerkLevels, clerkPending, takenInAt } = await import('./clerk-coverage.ts');
const { listMaterials } = await import('./materials.ts');
const historyNotOrganized = (store: Parameters<typeof clerkLevels>[0], project: Parameters<typeof clerkLevels>[1], keys: ReadonlySet<string>) => clerkLevels(store, project, keys).historyNotOrganized;

const ENV = { GIT_AUTHOR_NAME: 'Wren Dev', GIT_AUTHOR_EMAIL: 'dev@wren.invalid', GIT_COMMITTER_NAME: 'Wren Dev', GIT_COMMITTER_EMAIL: 'dev@wren.invalid' };
const dir = mkdtempSync(join(tmpdir(), 'pk-wren-'));
const git = (args: string[], env: Record<string, string> = {}) => execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel: string, text: string) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
write('README.md', '# Wren\n\nCounts birds.\n');
write('docs/PLAN.md', '# Plan\n\n## W-1 Count by hand\n');
write('docs/DECISIONS.md', '# Decisions\n\n**D1 · Count at dawn.**\n');
write('supplier/notes.md', '# Supplier notes\n\nTheir binoculars.\n');
for (let n = 1; n <= 7; n++) write(`reports/count-${n}.md`, `# Count ${n}\n\n${n * 10} birds.\n`);
// The series' order by time: count-1 the oldest, count-7 the newest (the samples of `sampledGroups`).
for (let n = 1; n <= 7; n++) { const t = new Date(Date.UTC(2026, 8, n, 6)); utimesSync(join(dir, `reports/count-${n}.md`), t, t); }
git(['init', '-q', '-b', 'main']);
git(['add', '-A']);
git(['commit', '-q', '-m', 'Start counting'], { GIT_AUTHOR_DATE: '2026-09-01T06:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T06:00:00Z' });

test('pending: what came after the latest round started, and what the watcher holds; never what the rules settle or the Keeper’s own commit (CKC-07 AC-1, AC-10, AC-18)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const app = new App(home, { organizing: false });
  const project = app.addProject('Wren', [dir]);
  await app.intakeProject(project.id);
  app.stopAll();
  const store = app.store(project.id);
  const P = () => app.project(project.id);
  assert.equal(takenInAt(store), '', 'no round yet');
  assert.ok(clerkPending(store, P()).pending.length >= 10, 'before the first round everything is waiting for it');

  // The takeover's first round takes in everything read so far.
  const roundAt = new Date().toISOString();
  store.clerkRounds.put({ id: 'crd_1', projectId: project.id, kind: 'First usable', number: 1, startedAt: roundAt, endedAt: null, status: 'Running', rootJobId: 'job_root', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: roundAt } as ClerkRound);
  assert.deepEqual(clerkPending(store, P()).pending, [], 'the round took in what was there when it started');

  // After it started: the plan changes, the owner commits it, and the Keeper commits its project folder (made now: intake
  // reads the commits since the coverage's As of).
  await new Promise((r) => setTimeout(r, 1100));
  write('docs/PLAN.md', '# Plan\n\n## W-1 Count by hand\n\n## W-2 Count by ear\n');
  git(['add', 'docs']);
  git(['commit', '-q', '-m', 'W-2 planned']);
  write('projectkeeper/README.md', '# ProjectKeeper records for Wren\n\nThis folder is maintained by ProjectKeeper.\n');
  git(['add', 'projectkeeper']);
  git(['commit', '-q', '-m', 'ProjectKeeper: update README.md', '--author=ProjectKeeper <keeper@projectkeeper.invalid>', '--', 'projectkeeper']);
  // The Keeper's folder is excluded from the material, as the project folder's grant makes it (project-folder-api.ts).
  app.updateProject({ ...P(), scope: [...P().scope, { id: 'si-pk', path: join(dir, 'projectkeeper'), category: 'Directory', relation: 'Excluded', reason: 'ProjectKeeper’s project folder', reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'unknown', missing: null, addedBy: 'owner' }] });
  incrementalIntake(store, P(), [
    { kind: 'file', ref: join(dir, 'docs', 'PLAN.md'), label: 'docs/PLAN.md', since: new Date().toISOString(), lastEventAt: Date.now(), scopeItemId: P().scope[0]!.id },
    { kind: 'commit', ref: `${dir}@head`, label: 'head', since: new Date().toISOString(), lastEventAt: Date.now(), scopeItemId: P().scope.find((i) => i.category === 'Repository')!.id },
  ]);
  const watcher = [{ kind: 'file' as const, ref: join(dir, 'README.md'), label: 'README.md', since: new Date().toISOString() }];
  const { pending } = clerkPending(store, P(), watcher);
  const labels = pending.map((p) => p.label);
  assert.ok(labels.includes('docs/PLAN.md'), `the changed plan waits: ${labels.join(', ')}`);
  assert.ok(pending.some((p) => p.kind === 'commit' && /W-2 planned/.test(p.label)), `the owner’s commit waits: ${labels.join(', ')}`);
  assert.ok(store.sources.find((s) => s.anchor.kind === 'commit' && /^author: ProjectKeeper$/m.test(s.excerpt)), 'the Keeper’s commit was read like any other');
  assert.ok(!pending.some((p) => /ProjectKeeper: update/.test(p.label)), 'the Keeper’s own commit of its folder never waits');
  assert.ok(labels.includes('README.md'), 'what the watcher saw and has not settled is listed too');
  assert.equal(pending.filter((p) => p.label === 'docs/PLAN.md').length, 1, 'a file is listed once, however many sections it has');

  // A rule that settles the supplier's notes: they never wait, even when they change.
  store.rules.put({ id: 'rule_supplier', projectId: project.id, group: 'Material rules', category: 'Reference only', summary: 'supplier/ is for reference only.', excerpt: null, sourceIds: [], appliesTo: ['supplier/'], basis: 'Inferred', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: null, asOf: roundAt, updatedAt: roundAt } as ProjectRule);
  applyMaterialRules(store, P());
  write('supplier/notes.md', '# Supplier notes\n\nTheir binoculars, and their tripods.\n');
  incrementalIntake(store, P(), [{ kind: 'file', ref: join(dir, 'supplier', 'notes.md'), label: 'supplier/notes.md', since: new Date().toISOString(), lastEventAt: Date.now(), scopeItemId: P().scope[0]!.id }]);
  applyMaterialRules(store, P());
  assert.ok(!clerkPending(store, P()).pending.some((p) => p.label.startsWith('supplier/')), 'what a rule settles does not wait');
});

test('levels: settled, not organized, read in full, conclusions only, sampled, indexed — counted by kind (CKC-13 AC-8, Spec §1.11)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const app = new App(home, { organizing: false });
  const project = app.addProject('Wren', [dir]);
  await app.intakeProject(project.id);
  app.stopAll();
  const store = app.store(project.id);
  const P = app.project(project.id);
  const at = new Date().toISOString();
  store.rules.put({ id: 'rule_supplier', projectId: project.id, group: 'Material rules', category: 'Reference only', summary: 'supplier/ is for reference only.', excerpt: null, sourceIds: [], appliesTo: ['supplier/'], basis: 'Inferred', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: null, asOf: at, updatedAt: at } as ProjectRule);
  applyMaterialRules(store, P);
  // A session the owner spoke in, with its draft.
  store.sources.put(makeSessionSource({ projectId: project.id, host: 'claude', sessionId: 'aaaa1111-2222-4333-8444-555555555555', file: join(home, 's.jsonl'), cwd: dir, messageStart: 0, messageEnd: 4, at, excerpt: 'owner: count at dawn', title: 'claude session aaaa1111', scopeItemId: P.scope[0]!.id }));
  store.drafts.put({ id: 'draft_1', projectId: project.id, session: { host: 'claude', sessionId: 'aaaa1111-2222-4333-8444-555555555555', file: join(home, 's.jsonl'), startedAt: at, endedAt: at }, ownerLines: [], agentSummary: [], jobId: null, at });
  store.clerkRounds.put({ id: 'crd_1', projectId: project.id, kind: 'Deepen', number: 2, startedAt: new Date(Date.now() + 1000).toISOString(), endedAt: null, status: 'Running', rootJobId: 'job_root', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: at } as ClerkRound);
  const job = (id: string, kind: KeeperJob['kind'], step: KeeperJob['step'], steps: { tool: string; target: string; isError?: boolean }[]): KeeperJob => ({ id, projectId: project.id, kind, initiator: 'auto', scope: { kind: 'clerk-step', ids: ['crd_1'], label: id }, status: 'Done', queuedAt: at, startedAt: at, endedAt: at, savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: steps.map((s) => ({ at, summary: '', isError: false, ...s })), error: null, requestBasis: null, parentJobId: null, resultText: null, priority: 1, task: null, step } as unknown as KeeperJob);
  // A sweep read the series' oldest and newest and the README; a failed read counts for nothing; an investigation read the commits.
  store.jobs.put(job('job_dig', 'Organizing', { roundId: 'crd_1', kind: 'dig', path: 'The owner’s meaning' }, [
    { tool: 'read', target: 'reports/count-1.md' }, { tool: 'read', target: join(dir, 'reports', 'count-7.md') }, { tool: 'pk_read_source', target: store.sources.find((s) => s.anchor.kind === 'file' && s.anchor.path === join(dir, 'README.md'))!.id },
    { tool: 'read', target: 'docs/DECISIONS.md', isError: true },
  ]));
  store.jobs.put(job('job_inv', 'Investigation', null, [{ tool: 'pk_ledger_commits', target: '' }]));

  const { keys } = clerkPending(store, P);
  assert.equal(keys.size, 0, 'nothing waits: the round started after everything was read');
  const { levels, sampled, levelOf } = clerkLevels(store, P, keys);
  const of = (level: string) => levels.find((l) => l.level === level)!;
  const levelFor = (rel: string) => levelOf.get(`file:${join(dir, ...rel.split('/'))}`);
  assert.equal(of('Settled by rule').materials, 1, 'the supplier’s notes: the rule judges them');
  assert.equal(levelFor('reports/count-1.md'), 'Read in full');
  assert.equal(levelFor('reports/count-7.md'), 'Read in full', 'an absolute path read counts the same');
  assert.equal(levelFor('README.md'), 'Read in full', 'a source read counts for its file');
  assert.equal(levelFor('docs/DECISIONS.md'), 'Indexed', 'a failed read does not');
  for (let n = 2; n <= 6; n++) assert.equal(levelFor(`reports/count-${n}.md`), 'Sampled', `count-${n} follows the series whose samples were read`);
  assert.equal(sampled.length, 1);
  assert.equal(sampled[0]!.members, 7);
  assert.equal(of('Conclusions only').byKind.session, 1, 'the drafted session: the owner’s words and the agents’ claims');
  assert.equal(of('Read in full').byKind.commit, 1, 'the commits an investigation read through the ledger');
  assert.equal(of('Read in full').byKind.file, 3);
  assert.equal(of('Sampled').materials, 5);
  const total = levels.reduce((n, l) => n + l.materials, 0);
  assert.ok(total >= 14, `every material has a level: ${total}`);
  assert.deepEqual(levels.map((l) => l.level), ['Read in full', 'Conclusions only', 'Sampled', 'Settled by rule', 'Indexed', 'Not organized', 'Skipped: too large'], 'the fixed words of §1.11, in their order (D105 added the last)');

  // What history is not organized is counted from the levels of the history tier, whatever the depth.
  const history = listMaterials(store, P).filter((m) => m.tier === 'history');
  assert.equal(historyNotOrganized(store, P, keys), history.filter((m) => ['Indexed', 'Sampled', 'Not organized'].includes(levelOf.get(m.key)!)).length);

  // A change after the round started: its material is not organized until a round takes it.
  write('docs/DECISIONS.md', '# Decisions\n\n**D1 · Count at dawn.**\n\n**D2 · And at dusk.**\n');
  await new Promise((r) => setTimeout(r, 1100));
  incrementalIntake(store, P, [{ kind: 'file', ref: join(dir, 'docs', 'DECISIONS.md'), label: 'docs/DECISIONS.md', since: new Date().toISOString(), lastEventAt: Date.now(), scopeItemId: P.scope[0]!.id }]);
  const later = clerkPending(store, P);
  const after = clerkLevels(store, P, later.keys);
  assert.equal(after.levelOf.get(`file:${join(dir, 'docs', 'DECISIONS.md')}`), 'Not organized', 'pending: not organized');
});

test('levels by what was actually read: shell reads count, ranges that cover a file count, a part read is counted beside the levels (CKC-13 AC-8)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const app = new App(home, { organizing: false });
  const project = app.addProject('Wren', [dir]);
  await app.intakeProject(project.id);
  app.stopAll();
  const store = app.store(project.id);
  const P = app.project(project.id);
  const at = new Date().toISOString();
  store.clerkRounds.put({ id: 'crd_1', projectId: project.id, kind: 'Deepen', number: 2, startedAt: new Date(Date.now() + 1000).toISOString(), endedAt: null, status: 'Running', rootJobId: 'job_root', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: at } as ClerkRound);
  const file = (rel: string) => join(dir, ...rel.split('/'));
  type Step = { tool: string; target: string; isError?: boolean; reads?: KeeperJob['steps'][number]['reads'] };
  const job = (id: string, steps: Step[]): KeeperJob => ({ id, projectId: project.id, kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['crd_1'], label: id }, status: 'Done', queuedAt: at, startedAt: at, endedAt: at, savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: steps.map((s) => ({ at, summary: '', isError: false, ...s })), error: null, requestBasis: null, parentJobId: null, resultText: null, priority: 1, task: null, step: { roundId: 'crd_1', kind: 'dig', path: 'The document chain and decisions' } } as unknown as KeeperJob);
  const levelFor = (levelOf: ReadonlyMap<string, string>, rel: string) => levelOf.get(`file:${file(rel)}`);
  const before = clerkLevels(store, P, clerkPending(store, P).keys);
  store.jobs.put(job('job_dig', [
    { tool: 'bash', target: 'cat docs/PLAN.md', reads: [{ path: file('docs/PLAN.md') }] },
    { tool: 'bash', target: 'head -2 README.md', reads: [{ path: file('README.md'), from: 1, to: 2, lines: 3 }] },
    { tool: 'read', target: 'docs/DECISIONS.md', reads: [{ path: file('docs/DECISIONS.md'), from: 1, to: 2, lines: 3 }] },
    { tool: 'bash', target: 'sed -n 3,$p docs/DECISIONS.md', reads: [{ path: file('docs/DECISIONS.md'), from: 3, lines: 3 }] },
    { tool: 'bash', target: 'grep -rn birds reports', reads: [] },
    { tool: 'read', target: 'reports/count-4.md', reads: [] },
    { tool: 'read', target: 'reports/count-3.md' },
    { tool: 'bash', target: 'cat supplier/notes.md', isError: true, reads: [{ path: file('supplier/notes.md'), part: true }] },
  ]));
  const { levels, levelOf, readInPart, historyNotOrganized: hno } = clerkLevels(store, P, clerkPending(store, P).keys);
  assert.equal(levelFor(levelOf, 'docs/PLAN.md'), 'Read in full', 'a file the shell showed whole');
  assert.equal(levelFor(levelOf, 'docs/DECISIONS.md'), 'Read in full', 'two ranges that together cover it, by the file tool and the shell');
  assert.equal(levelFor(levelOf, 'README.md'), 'Indexed', 'two of its three lines: read in part, which is no level of its own');
  assert.equal(levelFor(levelOf, 'reports/count-4.md'), 'Indexed', 'a step that recorded it read nothing is not counted by its target');
  assert.equal(levelFor(levelOf, 'reports/count-3.md'), 'Read in full', 'a step recorded before reads were kept counts by its target, as it did');
  assert.equal(levelFor(levelOf, 'supplier/notes.md'), 'Indexed', 'what the recorder kept of a failed shell call is what the agent saw: a part');
  assert.equal(readInPart.materials, 2, 'README and the supplier’s notes, counted beside the levels');
  assert.deepEqual(readInPart.byKind, { file: 2 });
  assert.deepEqual(readInPart.byLevel, { Indexed: 2 });
  assert.deepEqual(levels.map((l) => l.level), ['Read in full', 'Conclusions only', 'Sampled', 'Settled by rule', 'Indexed', 'Not organized', 'Skipped: too large'], 'no level was added for a part read: the vocabulary is §1.11’s');
  // The history not organized is counted from the levels: a history material read in full leaves it.
  const history = listMaterials(store, P).filter((m) => m.tier === 'history');
  const readNow = history.filter((m) => levelOf.get(m.key) === 'Read in full' && before.levelOf.get(m.key) !== 'Read in full').length;
  assert.equal(hno, before.historyNotOrganized - readNow, `${readNow} history material(s) read in full leave the count`);
  assert.ok(hno > 0, 'history no job read is still not organized, whatever the depth');
});
