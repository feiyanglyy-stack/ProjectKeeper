/**
 * The coverage check (D99; Spec §3.3 每份材料都有交代; CKC-23 AC-20): after the lanes, the program holds what they read
 * against the plan — what the organizing plan says to read closely, what the lane briefs name, and a whole category where
 * a brief names only a kind — and lists what no lane touched, grouped by category and top directory; the main agent
 * accounts for a group in one call, or sends a follow-up lane, whose reads (or its end) settle its items. A document is
 * one material: its older versions are never listed. What the project's rules settle is never listed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Nothing here may look at the real home: the ledger reads sessions from a home of our own.
const fakeHome = mkdtempSync(join(tmpdir(), 'pk-coverage-home-'));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
const { rebuildLedgerInPlace, ledgerPath } = await import('../../ledger/rebuild.ts');
const { Ledger } = await import('../../ledger/index.ts');
const { ProjectStore } = await import('../../store/project-store.ts');
const { coverageTools, coverageOf, coverageGroups } = await import('./coverage-tools.ts');
const { coverageSettled } = await import('./coverage-gate.ts');
type Project = import('../../model/types.ts').Project;
type KeeperJob = import('../../model/types.ts').KeeperJob;
type ProjectRule = import('../../model/types.ts').ProjectRule;
type ClerkRound = import('../../model/k-types.ts').ClerkRound;
type RoundLane = import('../../model/k-types.ts').RoundLane;
type ToolContext = import('../tools.ts').ToolContext;
type StepRead = NonNullable<KeeperJob['steps'][number]['reads']>[number];

// ───────────────────────── a small project: documents with versions, a deleted one, code, commits, an attic its rules settle ─────────────────────────

const ENV = { GIT_AUTHOR_NAME: 'Orchard Dev', GIT_AUTHOR_EMAIL: 'dev@orchard.invalid', GIT_COMMITTER_NAME: 'Orchard Dev', GIT_COMMITTER_EMAIL: 'dev@orchard.invalid' };
const repo = mkdtempSync(join(tmpdir(), 'pk-coverage-repo-'));
const git = (args: string[], date = '2026-09-01T10:00:00+00:00') => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel: string, text: string) => { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), text); };
git(['init', '-q', '-b', 'main']);
write('README.md', '# Orchard\n\nPicks apples.\n');
write('docs/plan.md', '# Plan\n\nPick by hand.\n');
write('docs/notes.md', '# Notes\n\nThe ladder is old.\nBuy a new one.\n');
write('docs/old/design.md', '# Design\n\nA robot arm.\n');
write('attic/old-plan.md', '# Old plan\n\nPick by robot.\n');
write('src/app.ts', 'export const picker = 1;\n');
write('src/util.ts', 'export const ladder = (n: number) => n + 1;\n');
git(['add', '-A']); git(['commit', '-q', '-m', 'Start the orchard'], '2026-09-01T10:00:00+00:00');
write('docs/plan.md', '# Plan\n\nPick by hand, twice a week.\n');
write('attic/old-plan.md', '# Old plan\n\nPick by robot, abandoned.\n');
git(['add', '-A']); git(['commit', '-q', '-m', 'Plan twice a week'], '2026-09-02T10:00:00+00:00');
rmSync(join(repo, 'docs', 'old'), { recursive: true });
write('docs/plan.md', '# Plan\n\nPick by hand, twice a week, in the morning.\n');
git(['add', '-A']); git(['commit', '-q', '-m', 'Drop the robot design; mornings'], '2026-09-03T10:00:00+00:00');
const [c1, c2, c3] = git(['rev-list', '--reverse', 'HEAD']).trim().split('\n') as [string, string, string];

const home = join(fakeHome, '.projectkeeper');
const P = {
  id: 'orchard', name: 'Orchard', locations: [repo], language: 'en', organizingPaused: false, createdAt: '2026-09-01T00:00:00Z', lastOpenedAt: null, lastScopedAt: null,
  scopeQuestions: [], keeperFiles: [], roles: [], takeoverDepth: 'Full',
  scope: [{ id: 'si', path: repo, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' }],
} as unknown as Project;
rebuildLedgerInPlace(ledgerPath(P.id, home), P, {});
const L = Ledger.openPath(ledgerPath(P.id, home))!;
// The store sits beside the ledger, as in a home: the tools open the ledger from the store's folder.
const store = ProjectStore.open(P.id, home);
store.rules.put({ id: 'rule_attic', projectId: P.id, group: 'Material rules', category: 'Recovery only', summary: 'attic/ is kept for recovery only.', excerpt: null, sourceIds: [], appliesTo: ['attic/'], basis: 'Inferred', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: null, asOf: '2026-09-02', updatedAt: '2026-09-02' } as ProjectRule);
// The organizing plan says to read the code closely.
store.plans.put({ id: 'organizing-plan', projectId: P.id, byRule: [], readClosely: [{ what: 'the code', targets: ['src/'], why: 'it is small' }], focus: [], order: [], corrections: [], jobId: null, asOf: '2026-09-04', updatedAt: '2026-09-04' });

const AT = '2026-09-05T10:00:00.000Z';
const abs = (rel: string) => join(repo, ...rel.split('/'));
const job = (id: string, kind: 'main' | 'lane', path: string | null, reads: StepRead[][], status: KeeperJob['status'] = 'Done', parentJobId: string | null = null): KeeperJob => ({
  id, projectId: P.id, kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['crd_deep'], label: path ?? 'Main' }, status, queuedAt: AT, startedAt: AT, endedAt: status === 'Done' ? AT : null,
  savedResults: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, agent: 'pi', model: null, sessionFile: null, sessionId: null,
  steps: reads.map((r) => ({ at: AT, tool: 'read', target: '', summary: '', isError: false, reads: r })), error: null, requestBasis: null, parentJobId, resultText: null, priority: 1, task: null,
  step: { roundId: 'crd_deep', kind, path },
} as unknown as KeeperJob);
const brief = (id: string, lane: string, markdown: string) => store.roundDocs.put({ id, projectId: P.id, roundId: 'crd_deep', jobId: 'job_main', kind: 'Brief', path: lane, title: `Brief: ${lane}`, markdown, at: AT });
const lane = (name: string, kind: RoundLane['kind'], briefDocId: string, jobId: string): RoundLane => ({ name, kind, briefDocId, slots: [], jobId, stage: 'dig', sentAt: AT, reportDocId: null });

const DOCS = 'The document chain and decisions: plans';
const PROCESS = "Each work item's process and checks";
brief('rdoc_docs', DOCS, '# Brief\n\n3. Read `docs/` in full — and not `attic/`, which is kept for recovery only.');
brief('rdoc_process', PROCESS, '# Brief\n\n3. Read what each piece of work went through, from the ledger.');
store.jobs.put(job('job_main', 'main', null, [[{ path: abs('src/app.ts') }]], 'Running'));
// The documents lane: docs/plan.md whole as it stands, one line of docs/notes.md's four, and an old version of the
// deleted design (not its last one).
store.jobs.put(job('job_docs', 'lane', DOCS, [[{ path: abs('docs/plan.md') }], [{ path: abs('docs/notes.md'), from: 1, to: 1, lines: 4 }]], 'Done', 'job_main'));
// The process lane read the first commit; an investigation it sent read the second.
store.jobs.put(job('job_process', 'lane', PROCESS, [[{ rev: c1 }]], 'Done', 'job_main'));
store.jobs.put({ ...job('job_inv', 'lane', null, [[{ rev: c2 }]], 'Done', 'job_process'), kind: 'Investigation', step: null } as KeeperJob);
const round: ClerkRound = {
  id: 'crd_deep', projectId: P.id, kind: 'Deepen', number: 2, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root', questionsDocId: null, paths: [], outputs: [], groundwork: [],
  unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT,
  stage: 'coverage', stageLog: [], lanes: [lane(DOCS, 'plan', 'rdoc_docs', 'job_docs'), lane(PROCESS, 'topic', 'rdoc_process', 'job_process')], coverage: null,
};
store.clerkRounds.put(round);

const ctx = (jobId: string, kind: 'main' | 'lane'): ToolContext => ({ store, project: P, jobId, jobKind: 'Organizing', model: null, step: { roundId: 'crd_deep', kind, path: null } });
const call = async (c: ToolContext, name: string, args: Record<string, unknown>) => {
  const tool = coverageTools(c).find((t) => t.name === name)!;
  const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  const result = await run('call', args);
  const text = result.content.map((x) => x.text).join('\n');
  return { text, error: result.isError === true, json: result.isError ? null : JSON.parse(text) };
};
const main = ctx('job_main', 'main');
const now = () => store.clerkRounds.get('crd_deep')!;

test('the check lists what no lane read in full, grouped by category and top directory; old versions and what the rules settle are never items (D99, CKC-23 AC-20)', async () => {
  const state = coverageOf(store, now(), L, P);
  const planned = [...state.items.keys()].sort();
  assert.deepEqual(planned, [
    `commit:${c1}`, `commit:${c2}`, `commit:${c3}`,
    'doc:docs/notes.md', 'doc:docs/old/design.md', 'doc:docs/plan.md',
    'file:src/app.ts', 'file:src/util.ts',
  ].sort(), 'the plan: the code the organizing plan names, the documents the brief names, every commit for the lane named for the process that names nothing countable');
  assert.ok(planned.every((k) => !k.includes('@')), 'a document is one material: docs/plan.md, three versions, is one item');
  assert.ok(!planned.some((k) => k.includes('attic/')), 'attic/ is settled by its rule, though the brief names it');
  assert.ok(!planned.includes('doc:README.md'), 'nothing names the README');

  const r = await call(main, 'pk_coverage_check', {});
  assert.equal(r.error, false, r.text);
  const groups = r.json.untouched as { group: string; count: number; keys: string[]; read: string; dir: string; category: string }[];
  assert.deepEqual(groups.map((g) => [g.group, g.keys]), [
    ['documents:docs', ['doc:docs/old/design.md']],
    ['documents:docs (read in part)', ['doc:docs/notes.md']],
    ['code files:src', ['file:src/util.ts']],
    ['commits:.', [`commit:${c3}`]],
  ], 'docs/plan.md, src/app.ts (the main agent read it), the first commit and the second (an investigation a lane sent read it) are read; the rest is listed');
  assert.equal(groups.find((g) => g.group === 'documents:docs')!.read, 'none');
  assert.equal(r.json.settled, false);
  assert.deepEqual(r.json.totals, { planned: 8, readWhole: 4, accounted: 0, listed: 4 });
  assert.equal(now().coverage?.settled, false, 'the round records the check');
  assert.equal(coverageSettled(store, now(), { project: P, ledger: L }), false, 'the gate into the cross-check stays shut');
});

test('the main agent accounts for a group in one call; read in part needs a part read; only the main agent, in the coverage stage (D99)', async () => {
  // Outcome part for what no lane read at all is refused.
  const wrong = await call(main, 'pk_account_material', { group: 'documents:docs', outcome: 'part', why: 'enough' });
  assert.equal(wrong.error, true);
  assert.match(wrong.text, /no lane read any of doc:docs\/old\/design\.md/);
  // A lane does not account; nor does the main agent outside the coverage stage.
  assert.equal((await call(ctx('job_docs', 'lane'), 'pk_account_material', { group: 'code files', outcome: 'not needed', why: 'x' })).error, true);
  store.clerkRounds.put({ ...now(), stage: 'cross-check' });
  const late = await call(main, 'pk_account_material', { group: 'code files', outcome: 'not needed', why: 'x' });
  assert.match(late.text, /written in the coverage stage/);
  store.clerkRounds.put({ ...now(), stage: 'coverage' });

  const code = await call(main, 'pk_account_material', { group: 'code files:src', outcome: 'not needed', why: 'src/util.ts is a one-line helper the picker does not call' });
  assert.deepEqual(code.json, { accounted: 1, settled: false, left: 3 });
  const notes = await call(main, 'pk_account_material', { keys: ['doc:docs/notes.md'], outcome: 'part', why: 'its first line names the ladder; the rest is a shopping list' });
  assert.equal(notes.json.accounted, 1);
  const accounts = now().coverage!.accounted;
  assert.deepEqual(accounts.map((a) => [a.keys, a.group, a.outcome, a.by]), [
    [['file:src/util.ts'], 'code files:src', 'not needed', 'main'],
    [['doc:docs/notes.md'], null, 'part', 'main'],
  ], 'each account keeps the keys it settled, the group it named and the main agent’s words');
  const check = await call(main, 'pk_coverage_check', {});
  assert.deepEqual(check.json.untouched.map((g: { group: string }) => g.group), ['documents:docs', 'commits:.']);
  assert.equal(check.json.accounted.length, 2);
});

test('a follow-up lane’s reads settle what it read; what it did not read is listed again when it ends, for the main agent to account for (Spec §3.3, D99)', async () => {
  brief('rdoc_follow', 'Follow up: what no lane touched', `# Brief\n\nRead \`docs/old/design.md\` (deleted: its last version) and the commit ${c3.slice(0, 10)}.`);
  store.jobs.put(job('job_follow', 'lane', 'Follow up: what no lane touched', [[{ rev: c3 }]], 'Running', 'job_main'));
  store.clerkRounds.put({ ...now(), lanes: [...now().lanes!, lane('Follow up: what no lane touched', 'follow-up', 'rdoc_follow', 'job_follow')] });
  let state = coverageOf(store, now(), L, P);
  assert.deepEqual(coverageGroups(state).map((g) => g.group), ['documents:docs'], 'the commit it read is settled by its read, while it runs');
  assert.equal(state.settled, false, 'the deleted design is not read yet');
  // The lane ends without reading the design: its end settles nothing; the design is listed again.
  store.jobs.put({ ...store.jobs.get('job_follow')!, status: 'Done', endedAt: AT });
  state = coverageOf(store, now(), L, P);
  assert.equal(state.settled, false, 'a follow-up lane that has ended does not by itself settle what it was sent for');
  assert.deepEqual(coverageGroups(state).map((g) => [g.group, g.keys]), [['documents:docs', ['doc:docs/old/design.md']]], 'what it did not read is listed again');
  assert.equal(coverageSettled(store, now(), { project: P, ledger: L }), false, 'the gate stays shut');
  // The main agent accounts for it.
  const design = await call(main, 'pk_account_material', { keys: ['doc:docs/old/design.md'], outcome: 'not needed', why: 'the robot arm was dropped in the third commit, which the follow-up lane read; the design itself answers no question of this round' });
  assert.deepEqual(design.json, { accounted: 1, settled: true, left: 0 });
  state = coverageOf(store, now(), L, P);
  assert.equal(state.settled, true);
  assert.equal(coverageSettled(store, now(), { project: P, ledger: L }), true);
  assert.equal(coverageSettled(store, now()), true, 'the gate opens the ledger from the store’s folder when not given one');
  const check = await call(main, 'pk_coverage_check', {});
  assert.deepEqual([check.json.untouched, check.json.settled], [[], true]);
  assert.equal(now().coverage!.settled, true);
});

test('a deleted document is read by its last version; an older version of a document read alone is not the document read (D99)', () => {
  const [last] = L.versionsByKey(L.named({ paths: ['docs/old/design.md'], commits: [] }).versions.map((v) => v.key));
  assert.ok(last);
  // A round of its own, whose one lane read the deleted design at its last version, and docs/plan.md only as it was first.
  store.jobs.put({ ...job('job_iso', 'lane', DOCS, [[{ path: abs('docs/old/design.md'), rev: last.commit }], [{ path: abs('docs/plan.md'), rev: c1 }]]), step: { roundId: 'crd_iso', kind: 'lane', path: DOCS } } as KeeperJob);
  const iso = { ...round, id: 'crd_iso', lanes: [lane(DOCS, 'plan', 'rdoc_docs', 'job_iso')], coverage: null } as ClerkRound;
  const state = coverageOf(store, iso, L, P);
  assert.equal(state.read.get('doc:docs/old/design.md'), 'whole', 'its last version, read whole from the history');
  assert.equal(state.read.get('doc:docs/plan.md'), 'none', 'its first version is history: the document is read as it stands');
  assert.ok(coverageGroups(state).some((g) => g.keys.includes('doc:docs/plan.md')), 'so it is listed');
  store.jobs.remove('job_iso');
});
