/**
 * The organizing plan steers the clerk method (Spec §3.7; D62, the owner: 「之后的整理照它执行」; D97, package BL). The
 * owner sees the plan in Project scope and corrects it in conversation, and a correction changes what the organizing does:
 *   - the main agent's prompt — and every lane's — carries the plan as it stands, with the owner's corrections in their
 *     words; how orientation writes its lanes' briefs by it is its skill's to say;
 *   - a deepening's coverage check plans what the plan says to read closely and holds it until a lane read it in full,
 *     under Focused too (D99: the lanes are the main agent's, and the coverage check is the program's);
 *   - a correction made while a round runs applies to what is not settled yet: the coverage check reads the plan as it
 *     stands, and a lane sent after it carries it.
 * No model runs here: the planner is driven with a stand-in for the Keeper that records what would be queued, and the
 * coverage check is called as the main agent calls it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectStore as Store } from '../../store/project-store.ts';
import type { Ledger as LedgerT } from '../../ledger/index.ts';

// Nothing here may look at the real home: the ledger reads sessions from a home of our own.
const fakeHome = mkdtempSync(join(tmpdir(), 'pk-plan-home-'));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
const { rebuildLedgerInPlace, ledgerPath } = await import('../../ledger/rebuild.ts');
const { Ledger } = await import('../../ledger/index.ts');
const { ProjectStore } = await import('../../store/project-store.ts');
const { makeFileSource } = await import('../../sources/anchor.ts');
const { ClerkPlanner } = await import('./clerk.ts');
const { lanePrompt, roundBlockOf } = await import('./round-blocks.ts');
const { readCloselyOf } = await import('./reading.ts');
const { deepeningPlanned, focusedCovers } = await import('./takeover-clerk.ts');
const { coverageGroups, coverageOf, coverageTools } = await import('./coverage-tools.ts');
const { stageTools } = await import('./stage-tools.ts');
type Project = import('../../model/types.ts').Project;
type KeeperJob = import('../../model/types.ts').KeeperJob;
type OrganizingPlan = import('../../model/types.ts').OrganizingPlan;
type ProjectRule = import('../../model/types.ts').ProjectRule;
type ClerkRound = import('../../model/k-types.ts').ClerkRound;
type RoundLane = import('../../model/k-types.ts').RoundLane;
type RoundStepKind = import('../../model/k-types.ts').RoundStepKind;
type App = import('../../server/app.ts').App;

// ───────────────────────── a small project with history, a side branch and an archive its rules settle ─────────────────────────

const ENV = { GIT_AUTHOR_NAME: 'Orchard Dev', GIT_AUTHOR_EMAIL: 'dev@orchard.invalid', GIT_COMMITTER_NAME: 'Orchard Dev', GIT_COMMITTER_EMAIL: 'dev@orchard.invalid' };
const repo = mkdtempSync(join(tmpdir(), 'pk-plan-repo-'));
const git = (args: string[], date = '2026-09-01T10:00:00+00:00') => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel: string, text: string) => { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), text); };
git(['init', '-q', '-b', 'main']);
write('README.md', '# Orchard\n\nPicks apples.\n');
write('docs/plan.md', '# Plan\n\nPick by hand.\n');
write('docs/notes.md', '# Notes\n\nThe ladder is old.\n');
write('docs/archive/old-plan.md', '# Old plan\n\nPick by robot.\n');
write('src/app.ts', 'export const picker = 1;\n');
write('src/util.ts', 'export const ladder = (n: number) => n + 1;\n');
git(['add', '-A']); git(['commit', '-q', '-m', 'Start the orchard'], '2026-09-01T10:00:00+00:00');
write('docs/plan.md', '# Plan\n\nPick by hand, twice a week.\n');
git(['add', '-A']); git(['commit', '-q', '-m', 'Plan twice a week'], '2026-09-02T10:00:00+00:00');
// A side branch that never reached the trunk.
git(['checkout', '-q', '-b', 'feature/robot']);
write('src/robot.ts', 'export const robot = true;\n');
git(['add', '-A']); git(['commit', '-q', '-m', 'Try a robot picker'], '2026-09-03T10:00:00+00:00');
git(['checkout', '-q', 'main']);
const robotCommit = git(['rev-parse', 'feature/robot']).trim();

const P = {
  id: 'orchard', name: 'Orchard', locations: [repo], language: 'en', organizingPaused: false, createdAt: '2026-09-01T00:00:00Z', lastOpenedAt: null, lastScopedAt: null,
  scopeQuestions: [], keeperFiles: [], roles: [], takeoverDepth: 'Full',
  scope: [{ id: 'si', path: repo, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' }],
} as unknown as Project;
const focusedProject = { ...P, takeoverDepth: 'Focused' } as Project;
const L: LedgerT = (() => { const file = ledgerPath(P.id, join(fakeHome, '.projectkeeper')); rebuildLedgerInPlace(file, P, {}); return Ledger.openPath(file)!; })();

const AT = '2026-09-28T10:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString();
const abs = (rel: string) => join(repo, ...rel.split('/'));
const codeKey = (rel: string) => `si:${rel}`;

/** A store of its own; `ledger`: with the project's ledger in its folder, where the coverage tools open it. */
function newStore(ledger = false): Store {
  const dir = mkdtempSync(join(tmpdir(), 'pk-plan-store-'));
  if (ledger) rebuildLedgerInPlace(ledgerPath(P.id, dir), P, {});
  const store = ProjectStore.open(P.id, dir);
  store.rules.put({ id: 'rule_archive', projectId: P.id, group: 'Material rules', category: 'Recovery only', summary: 'docs/archive/ is kept for recovery only.', excerpt: null, sourceIds: [], appliesTo: ['docs/archive/'], basis: 'Inferred', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: null, asOf: AT, updatedAt: AT } as ProjectRule);
  return store;
}
const planOf = (over: Partial<OrganizingPlan>): OrganizingPlan => ({ id: 'organizing-plan', projectId: P.id, byRule: [], readClosely: [], focus: [], order: [], corrections: [], jobId: null, asOf: AT, updatedAt: AT, ...over });
const correction = (quote: string, changed: string, when: string) => ({ at: when, sourceId: 'src_owner_msg', quote, changed, previous: { byRule: [], readClosely: [], focus: [], order: [] } });
const roundOf = (id: string, kind: ClerkRound['kind'], number: number, status: ClerkRound['status'], startedAt: string): ClerkRound => ({
  id, projectId: P.id, kind, number, startedAt, endedAt: status === 'Done' ? startedAt : null, status, rootJobId: `job_root_${id}`, questionsDocId: null, paths: [], outputs: [], groundwork: [],
  unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: startedAt,
});
const brief = (store: Store, roundId: string, path: string, markdown: string, when: string) => store.roundDocs.put({ id: `rdoc_${roundId}_${path.length}_${when.slice(-8, -5)}`, projectId: P.id, roundId, jobId: 'job_orientation', kind: 'Brief', path, title: `Brief: ${path}`, markdown, at: when });

/** The first usable round, done, with orientation's two briefs (the depth question counts the other two kinds by the ledger's totals). */
function firstPicture(store: Store): void {
  store.clerkRounds.put(roundOf('crd_first', 'First usable', 1, 'Done', at(-600)));
  brief(store, 'crd_first', 'The document chain and decisions: plans', '# Brief\n\n3. Read `docs/plan.md` in every version.', at(-590));
  brief(store, 'crd_first', 'The code as it stands', "# Brief\n\n3. Read the code, followed through the ledger's references.", at(-589));
}

// ───────────────────────── the planner, with a stand-in for the Keeper ─────────────────────────

let jobs = 0;
function harness(store: Store, ledger: LedgerT | null) {
  const queued: { label: string; prompt: string; job: KeeperJob }[] = [];
  const app = {
    ledger: { ledger: () => ledger },
    keeper: {
      enqueue(projectId: string, req: { kind: KeeperJob['kind']; initiator: KeeperJob['initiator']; scope: KeeperJob['scope']; prompt: string; step?: KeeperJob['step']; parentJobId?: string | null; priority?: number; task?: unknown; materials?: unknown }): KeeperJob {
        const job = {
          id: `job_q${++jobs}`, projectId, kind: req.kind, initiator: req.initiator, scope: req.scope, status: 'Queued', queuedAt: AT, startedAt: null, endedAt: null, savedResults: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null,
          parentJobId: req.parentJobId ?? null, resultText: null, step: req.step ?? null, priority: req.priority ?? 1, task: { prompt: req.prompt, extra: req.task ?? null, materials: req.materials ?? [] },
        } as unknown as KeeperJob;
        store.jobs.put(job);
        queued.push({ label: req.scope.label, prompt: req.prompt, job });
        return job;
      },
    },
  };
  const planner = new ClerkPlanner(app as unknown as App) as unknown as {
    startStep(store: Store, project: Project, round: ClerkRound, step: RoundStepKind): Promise<string>;
  };
  return { queued, planner };
}

/** A queued job ended, having read these files whole. */
const finish = (store: Store, job: KeeperJob, files: readonly string[] = []) =>
  store.jobs.put({ ...store.jobs.get(job.id)!, status: 'Done', startedAt: AT, endedAt: AT, steps: files.map((f) => ({ at: AT, tool: 'read', target: f, summary: '', isError: false, reads: [{ path: f }] })) } as KeeperJob);

// ───────────────────────── orientation's prompt carries the plan ─────────────────────────

test('the main agent’s prompt carries the organizing plan as it stands, with the owner’s corrections in their own words (Spec §3.7, D62; D99)', async () => {
  const store = newStore();
  const quote = '先把 src/util.ts 仔细读一遍，它最可疑；供应商的文档最后再说。';
  store.plans.put(planOf({
    byRule: [{ what: 'the archive', targets: ['docs/archive/'], ruleId: 'rule_archive', treatment: 'History only' }],
    readClosely: [{ what: 'the ladder helper', targets: ['src/util.ts'], why: 'the owner finds it suspect' }],
    focus: [{ what: 'work still in progress', why: 'status rests on reports', sourceIds: ['src_status'] }],
    order: ['src/util.ts', 'the vendor documents'],
    corrections: [correction(quote, 'src/util.ts is read closely and first; the vendor documents last', at(-90))],
    updatedAt: at(-90),
  }));
  const first = roundOf('crd_1', 'First usable', 1, 'Running', at(-60));
  store.clerkRounds.put(first);
  const { queued, planner } = harness(store, null);
  await planner.startStep(store, P, first, 'main');
  const prompt = queued[0]!.prompt;
  assert.match(prompt, /^Task: the main agent of this round/);
  assert.ok(prompt.includes('=== The organizing plan (the owner: 「之后的整理照它执行」'), 'the plan comes as a block of its own, with the owner’s direction');
  assert.ok(prompt.includes(`「${quote}」`), 'the owner’s correction in their own words, verbatim');
  assert.ok(prompt.includes('what it changed: src/util.ts is read closely and first; the vendor documents last'));
  assert.ok(prompt.includes('- the ladder helper (src/util.ts) — the owner finds it suspect'), 'what is read closely, with its targets');
  assert.ok(prompt.includes('- the archive (docs/archive/) → History only, by rule_archive: docs/archive/ is kept for recovery only.'), 'what the rules settle, with the rule');
  assert.ok(prompt.includes('- work still in progress — status rests on reports (sources: src_status)'));
  assert.ok(prompt.includes('1. src/util.ts\n2. the vendor documents'), 'the order, in order');
  // (The orientation skill speaks of "a correction the owner made since the last round began"; the block's mark is its own.)
  assert.ok(!prompt.includes(', since the last round began (source'), 'a first round marks no correction as newer than the last round');
  // How orientation follows the plan (the question list, the briefs, the order) is its skill's to say (W3).

  // A Follow up: a correction made since the last round began is marked, and orientation takes it up this round.
  const later = '还有 docs/notes.md 也要仔细读。';
  store.clerkRounds.put({ ...first, status: 'Done', endedAt: at(-20) });
  store.plans.put(planOf({ ...store.plans.get('organizing-plan')!, readClosely: [...store.plans.get('organizing-plan')!.readClosely, { what: 'the notes', targets: ['docs/notes.md'], why: '' }], corrections: [...store.plans.get('organizing-plan')!.corrections, correction(later, 'docs/notes.md is read closely too', at(-10))], updatedAt: at(-10) }));
  const followUp = roundOf('crd_2', 'Follow up', 2, 'Running', at(-5));
  store.clerkRounds.put(followUp);
  await planner.startStep(store, P, followUp, 'main');
  const next = queued[1]!.prompt;
  assert.ok(next.includes(`(source src_owner_msg): 「${quote}」`) && !next.includes(`since the last round began (source src_owner_msg): 「${quote}」`), 'the older correction is not marked');
  assert.ok(next.includes(`, since the last round began (source src_owner_msg): 「${later}」`), 'the newer one is');

  // Every lane the main agent sends while the plan stands carries it too (round-blocks.ts).
  const lane = lanePrompt({ name: 'Docs', kind: 'slot', slots: ['threads'], brief: 'Read the notes.', briefDocId: 'rdoc_x', roundBlock: roundBlockOf(store, P, followUp), rules: '' });
  assert.ok(lane.includes(`「${later}」`), 'a lane of the round carries the plan too');
});

// ───────────────────────── the coverage check holds what the plan says to read closely (D99) ─────────────────────────

/**
 * A deepening in its coverage stage, with its lanes: each lane a job of the round that read these files whole, its brief
 * naming what it answers. The coverage check and `pk_stage` are called as the main agent calls them.
 */
function deepeningWith(project: Project, plan: OrganizingPlan, lanes: { name: string; brief: string; read: string[] }[]) {
  const store = newStore(true);
  firstPicture(store);
  store.plans.put(plan);
  const deep: ClerkRound = { ...roundOf('crd_deep', 'Deepen', 2, 'Running', at(-100)), stage: 'coverage', stageLog: [{ stage: 'coverage', startedAt: at(-50), endedAt: null, timing: null }], lanes: [] };
  store.clerkRounds.put(deep);
  store.jobs.put({ id: 'job_main', projectId: P.id, status: 'Running', step: { roundId: deep.id, kind: 'main', path: null }, steps: [], parentJobId: deep.rootJobId, queuedAt: AT } as unknown as KeeperJob);
  const sent: RoundLane[] = lanes.map((l, i) => {
    const doc = brief(store, deep.id, l.name, l.brief, at(-90 + i));
    const job = { id: `job_lane_${i}`, projectId: P.id, status: 'Queued', step: { roundId: deep.id, kind: 'lane', path: l.name, lane: { kind: 'topic', slots: [] } }, parentJobId: 'job_main', queuedAt: at(-80 + i), steps: [] } as unknown as KeeperJob;
    store.jobs.put(job);
    finish(store, job, l.read.map(abs));
    return { name: l.name, kind: 'topic', briefDocId: doc.id, slots: [], jobId: job.id, stage: 'dig', sentAt: at(-80 + i), reportDocId: null };
  });
  store.clerkRounds.put({ ...deep, lanes: sent });
  const ctx = { store, project, jobId: 'job_main', jobKind: 'Organizing', model: null, step: { roundId: deep.id, kind: 'main', path: null } } as never;
  const call = async (tools: readonly { name: string; execute?: unknown }[], name: string, args: Record<string, unknown>) => {
    const run = tools.find((t) => t.name === name)!.execute as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    const r = await run('call', args);
    const text = r.content.map((c) => c.text).join('\n');
    return { error: r.isError === true, text, json: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } })() };
  };
  const coverage = coverageTools(ctx);
  // The gate reads the ledger of this test (a store's own folder has none).
  const stages = stageTools(ctx, { coverageSettled: (s, r, o) => coverageOf(s, r, L, o?.project ?? project).settled, stageSkill: (x) => `SKILL ${x}` });
  const state = () => coverageOf(store, store.clerkRounds.get(deep.id)!, L, project);
  return { store, deep, state, check: (args: Record<string, unknown> = {}) => call(coverage, 'pk_coverage_check', args), stage: (to: string, why?: string) => call(stages, 'pk_stage', { to, ...(why ? { why } : {}), ...(to === 'synthesis' ? { handover: { settled: 'The lanes are cross-checked.', open: 'Nothing a record settles.', first: 'The reports.' } } : {}) }) };
}

test('under Focused, a target the owner’s correction adds to Read closely is planned by the coverage check and held until a lane read it in full (Spec §3.7, D62; D99)', async () => {
  const quote = '把 src/util.ts 仔细读一遍，它最可疑。';
  const { store, deep, state, check } = deepeningWith(focusedProject, planOf({
    readClosely: [{ what: 'the ladder helper', targets: ['src/util.ts'], why: 'the owner finds it suspect' }],
    corrections: [correction(quote, 'src/util.ts is read closely', at(-200))], updatedAt: at(-200),
  }), [{ name: 'The document chain and decisions: plans', brief: '# Brief\n\nThe document chain and decisions: read `docs/plan.md`.', read: ['docs/plan.md'] }]);
  const s = state();
  assert.deepEqual([...s.items.keys()].sort(), ['doc:docs/plan.md', 'file:src/util.ts'], 'what the lane’s brief names, and what the plan says to read closely — whatever the depth');
  assert.equal(s.read.get('doc:docs/plan.md'), 'whole', 'the lane read its brief’s document whole, by the program’s record');
  const r = await check();
  assert.equal(r.error, false, r.text);
  const groups = r.json.untouched as { group: string; keys: string[] }[];
  assert.deepEqual(groups.map((g) => [g.group, g.keys]), [['code files:src', ['file:src/util.ts']]], 'what no lane read is listed, by category and directory');
  assert.equal(r.json.settled, false);
  assert.deepEqual(store.clerkRounds.get(deep.id)!.coverage!.untouched!.map((g) => g.group), ['code files:src'], 'and recorded on the round for the Keeper view (Spec §6.9)');
  assert.ok(focusedCovers(store).some((c) => c.category === 'entries the organizing plan says to read closely, read in full' && c.count === 1), 'what Focused covers says so');
  // A follow-up lane reads it whole: the program's record settles it.
  const job = { id: 'job_follow', projectId: P.id, status: 'Queued', step: { roundId: deep.id, kind: 'lane', path: 'Follow up: src/util.ts', lane: { kind: 'follow-up', slots: [] } }, parentJobId: 'job_main', queuedAt: at(-10), steps: [] } as unknown as KeeperJob;
  store.jobs.put(job);
  finish(store, job, [abs('src/util.ts')]);
  const followBrief = brief(store, deep.id, 'Follow up: src/util.ts', 'Read src/util.ts in full.', at(-11));
  const now = store.clerkRounds.get(deep.id)!;
  store.clerkRounds.put({ ...now, lanes: [...now.lanes!, { name: 'Follow up: src/util.ts', kind: 'follow-up', briefDocId: followBrief.id, slots: [], jobId: job.id, stage: 'coverage', sentAt: at(-10), reportDocId: null }] });
  const after = await check();
  assert.equal(after.json.settled, true, after.text);
  assert.deepEqual(after.json.untouched, []);
});

test('under Focused with nothing to read closely, the coverage check lists only what the lanes’ briefs name, and it does not hold the cross-check; under Full it does (Spec §3.3, §3.7; CKC-23 AC-20)', async () => {
  const lanes = [
    { name: 'The document chain and decisions: plans', brief: '# Brief\n\nRead `docs/plan.md` and `docs/notes.md`.', read: ['docs/plan.md'] },
    { name: 'The code as it stands: the app', brief: '# Brief\n\nRead src/app.ts.', read: [] },
  ];
  const plan = planOf({ focus: [{ what: 'work still in progress', why: '', sourceIds: [] }], updatedAt: at(-200) });
  const focused = deepeningWith(focusedProject, plan, lanes);
  assert.deepEqual([...focused.state().items.keys()].sort(), ['doc:docs/notes.md', 'doc:docs/plan.md', 'file:src/app.ts'], 'nothing beyond what the briefs name');
  assert.deepEqual(coverageGroups(focused.state()).map((g) => g.keys), [['doc:docs/notes.md'], ['file:src/app.ts']]);
  const into = await focused.stage('cross-check');
  assert.equal(into.error, false, `a Focused deepening's lanes answer their briefs at the Focused depth: ${into.text}`);

  const full = deepeningWith({ ...P, takeoverDepth: 'Full' } as Project, plan, lanes);
  const held = await full.stage('cross-check');
  assert.equal(held.error, true);
  assert.match(held.text, /A Full deepening enters the cross-check once every planned material is read, read in part with why, or accounted for/);
  assert.equal(full.store.clerkRounds.get(full.deep.id)!.stage, 'coverage', 'nothing changed');
});

test('a correction made while the round runs applies to what is not settled yet: the coverage check holds what it adds, a lane sent after carries it; once the cross-check has begun it is the next round’s (Spec §3.7; D62, D97)', async () => {
  const { store, deep, check, stage } = deepeningWith(P, planOf({ readClosely: [{ what: 'the ladder helper', targets: ['src/util.ts'], why: '' }], updatedAt: at(-200) }), [
    { name: 'The code as it stands', brief: '# Brief\n\nThe code as it stands: read src/util.ts.', read: ['src/util.ts'] },
  ]);
  assert.equal((await check()).json.settled, true, 'what the plan said to read closely was read');
  // The owner corrects the plan while the round runs: two more targets.
  const quote = 'docs/notes.md 和 src/app.ts 也仔细读，先读 src/app.ts。';
  store.plans.put(planOf({
    ...store.plans.get('organizing-plan')!,
    readClosely: [...store.plans.get('organizing-plan')!.readClosely, { what: 'the notes', targets: ['docs/notes.md'], why: '' }, { what: 'the picker', targets: ['src/app.ts'], why: '' }],
    order: ['src/app.ts', 'docs/notes.md'],
    corrections: [correction(quote, 'docs/notes.md and src/app.ts are read closely, src/app.ts first', at(-5))], updatedAt: at(-5),
  }));
  const r = await check();
  assert.equal(r.json.settled, false);
  assert.deepEqual((r.json.untouched as { keys: string[] }[]).flatMap((g) => g.keys).sort(), ['doc:docs/notes.md', 'file:src/app.ts'], 'what the correction adds is held, as the plan stands now');
  // A lane the main agent sends for it carries the correction in the owner's words (round-blocks.ts).
  const lane = lanePrompt({ name: 'Follow up: the notes and the picker', kind: 'follow-up', slots: [], brief: 'Read docs/notes.md and src/app.ts.', briefDocId: 'rdoc_f', roundBlock: roundBlockOf(store, P, store.clerkRounds.get(deep.id)!), rules: '' });
  assert.ok(lane.includes(`「${quote}」`), 'a lane sent after the correction carries it');
  assert.match((await stage('cross-check')).text, /coverage check still lists material no lane touched/, 'the Full gate holds until it is read or accounted for');
  const account = coverageTools({ store, project: P, jobId: 'job_main', jobKind: 'Organizing', model: null, step: { roundId: deep.id, kind: 'main', path: null } } as never).find((t) => t.name === 'pk_account_material')!;
  const done = await (account.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[] }>)('call', { keys: ['doc:docs/notes.md', 'file:src/app.ts'], outcome: 'not needed', why: 'The notes and the picker say nothing this round asks' });
  assert.match(done.content[0]!.text, /"settled": true/);
  assert.equal((await stage('cross-check')).error, false);
  // After that the plan as it changes is the next round's: the gate is behind the round, and nothing holds the handover to the synthesis.
  store.plans.put(planOf({ ...store.plans.get('organizing-plan')!, readClosely: [...store.plans.get('organizing-plan')!.readClosely, { what: 'the plan', targets: ['docs/plan.md'], why: '' }], updatedAt: at(-1) }));
  assert.equal((await stage('synthesis')).error, false, 'the cross-check has begun: a later correction is the next round’s');
});

// ───────────────────────── Full keeps reading everything planned, and what the plan says to read closely besides ─────────────────────────

test('under Full, what the plan says to read closely is planned with everything else; what the rules settle stays out unless a target points into it (Spec §3.7, §1.15)', () => {
  const store = newStore();
  firstPicture(store);
  const without = deepeningPlanned(L, store);
  const docPath = (p: ReturnType<typeof deepeningPlanned>) => p.paths.find((x) => x.path === 'The document chain and decisions: plans')!;
  assert.equal(docPath(without).materials, 1, 'the brief names docs/plan.md: one document, however many versions (Spec §3.3, D99)');

  store.plans.put(planOf({ readClosely: [{ what: 'the docs', targets: ['docs/'], why: '' }] }));
  const withDocs = deepeningPlanned(L, store);
  assert.equal(docPath(withDocs).materials, 2, 'docs/notes.md is added; docs/archive/ is settled by its rule and the target does not point into it');
  assert.ok(docPath(withDocs).reads.some((r) => r.category === 'materials the organizing plan says to read closely' && r.count === 1), 'said among what the path reads');
  assert.equal(withDocs.materials, without.materials + 1, 'Full reads one material more');

  store.plans.put(planOf({ readClosely: [{ what: 'the old plan', targets: ['docs/archive/old-plan.md'], why: '' }] }));
  const withArchive = deepeningPlanned(L, store);
  assert.equal(docPath(withArchive).materials, 2, 'a target that points into what the rules settle is read closely all the same');

  // What a Full deepening's coverage check plans holds what its lanes' briefs name, and the plan's target (D99).
  const deep: ClerkRound = { ...roundOf('crd_full', 'Deepen', 2, 'Running', AT), lanes: [] };
  const plans = brief(store, deep.id, 'The document chain and decisions: plans', '# Brief\n\n3. Read `docs/plan.md` in every version.', at(1));
  const code = brief(store, deep.id, 'The code as it stands', "# Brief\n\n3. Read the code, followed through the ledger's references.", at(2));
  const lane = (name: string, doc: { id: string }, i: number): RoundLane => ({ name, kind: 'topic', briefDocId: doc.id, slots: [], jobId: `job_none_${i}`, stage: 'dig', sentAt: AT, reportDocId: null });
  store.clerkRounds.put({ ...deep, lanes: [lane('The document chain and decisions: plans', plans, 1), lane('The code as it stands', code, 2)] });
  const keys = [...coverageOf(store, store.clerkRounds.get(deep.id)!, L, P).items.keys()].sort();
  assert.ok(keys.includes('doc:docs/archive/old-plan.md'), 'the target is planned, though it points into what the rules settle');
  assert.ok(keys.includes('doc:docs/plan.md'), 'and what the brief named still is: the document, once however many versions');
  assert.ok(keys.includes('file:src/app.ts') && keys.includes('file:src/util.ts'), 'the code, named only by its kind of question, is planned whole');
  assert.ok(!keys.includes('doc:docs/archive/old-plan.md@'), 'no version of a document is an item of its own');
});

test('the plan’s targets resolve through the ledger: a directory, a file, a commit, a side branch; what the ledger has nothing for is said, not dropped silently', () => {
  const store = newStore();
  const closely = readCloselyOf(L, store, planOf({ readClosely: [
    { what: 'the robot try', targets: ['feature/robot'], why: '' },
    { what: 'the code', targets: ['src/'], why: '' },
    { what: 'a vendor folder the ledger never saw', targets: ['vendor/sdk/'], why: '' },
    { what: 'what `docs/notes.md` says', targets: [], why: '' },
  ] }));
  assert.deepEqual(closely.commits, [robotCommit], 'a side branch: the commit it holds that the trunk does not');
  assert.deepEqual(closely.codeFiles.map((f) => f.key).sort(), [codeKey('src/app.ts'), codeKey('src/util.ts')]);
  assert.ok(closely.versions.some((v) => v.path === 'docs/notes.md'), 'an entry without targets, by the paths its words name');
  assert.deepEqual(closely.unresolved, ['vendor/sdk/']);
  assert.equal(closely.what.get(`commit:${robotCommit}`), 'the robot try', 'each material keeps what it is read closely for');
});
