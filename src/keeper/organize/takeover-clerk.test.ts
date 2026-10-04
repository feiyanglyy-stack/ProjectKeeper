/**
 * The takeover by the clerk method (Spec v3.0 §3.7): the depth question counts what a Full deepening reads path by
 * path from the ledger, leaves out what the project's own rules settle and says it apart, estimates on a stated basis
 * from the first usable round's measured time and cost — its main agent and its lanes (D99) — and names every option;
 * the first usable round's figures come from its own jobs and drafts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Nothing here may look at the real home: the ledger reads sessions from a home of our own.
const fakeHome = mkdtempSync(join(tmpdir(), 'pk-takeover-home-'));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
const { rebuildLedgerInPlace, ledgerPath } = await import('../../ledger/rebuild.ts');
const { Ledger } = await import('../../ledger/index.ts');
const { ProjectStore } = await import('../../store/project-store.ts');
const takeover = await import('./takeover-clerk.ts');
const { clerkDepthOptions, deepeningPlanPaths, deepeningReads, firstUsableFigures } = takeover;
const sessions = await import('../../sources/anchor.ts');
type Project = import('../../model/types.ts').Project;
type KeeperJob = import('../../model/types.ts').KeeperJob;
type ProjectRule = import('../../model/types.ts').ProjectRule;

const ENV = { GIT_AUTHOR_NAME: 'Orchard Dev', GIT_AUTHOR_EMAIL: 'dev@orchard.invalid', GIT_COMMITTER_NAME: 'Orchard Dev', GIT_COMMITTER_EMAIL: 'dev@orchard.invalid' };
const repo = mkdtempSync(join(tmpdir(), 'pk-takeover-repo-'));
const git = (args: string[], date = '2026-09-01T10:00:00+00:00') => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel: string, text: string) => { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), text); };
git(['init', '-q', '-b', 'main']);
write('README.md', '# Orchard\n\nPicks apples.\n');
write('docs/plan.md', '# Plan\n\nPick by hand.\n');
write('attic/old-plan.md', '# Old plan\n\nPick by robot.\n');
write('src/app.ts', 'export const picker = 1;\n');
git(['add', '-A']); git(['commit', '-q', '-m', 'Start the orchard'], '2026-09-01T10:00:00+00:00');
write('docs/plan.md', '# Plan\n\nPick by hand, twice a week.\n');
write('attic/old-plan.md', '# Old plan\n\nPick by robot, abandoned.\n');
git(['add', '-A']); git(['commit', '-q', '-m', 'Plan twice a week'], '2026-09-02T10:00:00+00:00');

const home = join(fakeHome, '.projectkeeper');
const P = {
  id: 'orchard', name: 'Orchard', locations: [repo], language: 'en', organizingPaused: false, createdAt: '2026-09-01T00:00:00Z', lastOpenedAt: null, lastScopedAt: null,
  scopeQuestions: [], keeperFiles: [], roles: [],
  scope: [{ id: 'si', path: repo, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' }],
} as unknown as Project;
const file = ledgerPath(P.id, home);
rebuildLedgerInPlace(file, P, {});
const L = Ledger.openPath(file)!;
const store = ProjectStore.open(P.id, mkdtempSync(join(tmpdir(), 'pk-takeover-store-')));
store.rules.put({ id: 'rule_attic', projectId: P.id, group: 'Material rules', category: 'Recovery only', summary: 'attic/ is kept for recovery only.', excerpt: null, sourceIds: [], appliesTo: ['attic/'], basis: 'Inferred', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: null, asOf: '2026-09-02', updatedAt: '2026-09-02' } as ProjectRule);

test('the depth question counts what each path reads from the ledger, and what the project’s rules settle apart (Spec §3.7)', () => {
  const paths = deepeningReads(L, store);
  assert.deepEqual(paths.map((p) => p.path), ["The owner's meaning", 'The document chain and decisions', "Each work item's process and checks", 'The code as it stands'].filter((p) => paths.some((x) => x.path === p)));
  const chain = paths.find((p) => p.path === 'The document chain and decisions')!;
  const count = (category: RegExp) => chain.reads.find((r) => category.test(r.category))?.count ?? 0;
  // A document is one material, however many versions it has (Spec §3.3, §3.7; D99).
  assert.equal(count(/^documents settled/), 1, 'attic/old-plan.md, one document of two versions, is settled by the recovery rule');
  assert.equal(count(/^documents$/), 2, 'README and docs/plan.md, each once however many versions: read closely');
  assert.ok(!chain.reads.some((r) => /version/.test(r.category)), 'no document version is counted as a material of its own');
  const work = paths.find((p) => p.path === "Each work item's process and checks")!;
  assert.equal(work.reads.find((r) => r.category === 'trunk commits')!.count, 2);
});

test('the options are estimated on a stated basis from the first usable round, and the note names every one (Spec §3.7, D36)', () => {
  // A D99 round: the main agent through its stages (each with its time), and a lane it sent.
  const stage = (s: string, from: number, to: number) => ({ stage: s as never, startedAt: `2026-09-03T10:${String(from).padStart(2, '0')}:00Z`, endedAt: `2026-09-03T10:${String(to).padStart(2, '0')}:00Z`, timing: { wallMs: (to - from) * 60_000, generationMs: 0, toolMs: 0, queueMs: 0, parseRetryMs: 0, otherMs: 0 } });
  store.clerkRounds.put({ id: 'crd_1', projectId: P.id, kind: 'First usable', number: 1, startedAt: '2026-09-03T10:00:00Z', endedAt: '2026-09-03T10:20:00Z', status: 'Done', rootJobId: 'job_root', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: '',
    stage: 'synthesis', stageLog: [stage('orientation', 0, 4), stage('skeleton', 4, 10), stage('reconcile', 10, 16), stage('synthesis', 16, 20)] });
  const job = (id: string, kind: string, steps: { tool: string; target: string }[], cost: number, from: string, to: string, generationMs: number | null = null): KeeperJob => ({ id, projectId: P.id, kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['crd_1'], label: kind }, status: 'Done', queuedAt: from, startedAt: from, endedAt: to, savedResults: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: steps.map((s) => ({ at: '', summary: '', isError: false, ...s })), error: null, requestBasis: null, parentJobId: kind === 'lane' ? 'job_o' : 'job_root', resultText: null, priority: 1, task: null, step: { roundId: 'crd_1', kind: kind as never, path: kind === 'lane' ? 'Work' : null }, ...(generationMs === null ? {} : { timing: { wallMs: 20 * 60_000, generationMs, toolMs: 0, queueMs: 0, parseRetryMs: 0, otherMs: 0 } }) } as unknown as KeeperJob);
  // The main agent's own time is its generation (it waits parked while its lane reads): 5 minutes of its 20.
  store.jobs.put(job('job_o', 'main', [{ tool: 'read', target: 'README.md' }, { tool: 'pk_ledger_overview', target: '' }], 0.2, '2026-09-03T10:00:00Z', '2026-09-03T10:20:00Z', 5 * 60_000));
  store.jobs.put(job('job_s', 'lane', [{ tool: 'read', target: 'docs/plan.md' }, { tool: 'read', target: 'README.md' }], 0.2, '2026-09-03T10:04:00Z', '2026-09-03T10:09:00Z'));
  const first = firstUsableFigures(store, store.clerkRounds.get('crd_1'), L);
  assert.equal(first.minutes, 20);
  assert.equal(first.cost, 0.4);
  assert.deepEqual(first.byKind, { 'files read in full': 2, 'ledger queries': 1 }, 'what the round read, from its own recorded calls (steps recorded before reads were kept count by their target, whole)');

  const { options, basis } = clerkDepthOptions(first, L, store, 4);
  const full = options.find((o) => o.depth === 'Full')!;
  assert.equal(full.toOrganize, 2 + 2 + 1, 'documents read closely (each once), commits on every ref, code files');
  // Per material, measured on the project's own jobs (the owner's approval of 2026-09-28): the first usable round's main
  // agent (its 5 minutes of generation) and its lane (5 minutes) took 10 job minutes and $0.40 for the 2 items they read.
  assert.match(basis, /^per material, measured on this project: 5\.00 job min and \$0\.200 a material \(the first usable round's 2 model jobs: 10 job minutes and \$0\.40 for 2 items read\)/);
  assert.match(basis, /5 readings across its 4 paths/);
  assert.match(basis, /then 10 min and \$0\.10 for what follows the lanes \(as long as the first usable round's reconcile and synthesis and its process\)/);
  assert.equal(full.minutes, 16, '5 readings × 5 job min spread over 4 lanes, then the 10 min of the first usable round’s reconcile and synthesis stages');
  assert.equal(full.cost, 1.1, '5 × $0.20, and those stages’ half of the main agent’s $0.20');
  assert.equal(options.find((o) => o.depth === 'First picture only')!.cost, 0);

});

test('the owner’s-words step: the lines the round’s drafts hold, of the owner’s messages in the session logs, and the Owner’s words items the round wrote (D37, QC AY)', () => {
  const { makeSessionSource } = sessions;
  // A Claude Code log with three owner messages; the ledger here read no session, so the program reads the log itself.
  const log = join(mkdtempSync(join(tmpdir(), 'pk-takeover-log-')), 'owner.jsonl');
  const rec = (i: number, type: 'user' | 'assistant', text: string) => JSON.stringify({ type, timestamp: `2026-09-02T0${i}:00:00Z`, sessionId: 'owner-1', cwd: repo, isSidechain: false, userType: 'external', entrypoint: 'cli', message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', model: 'm', content: [{ type: 'text', text }] } });
  writeFileSync(log, [rec(1, 'user', 'Pick by hand.'), rec(2, 'assistant', 'Noted.'), rec(3, 'user', 'Twice a week.'), rec(4, 'assistant', 'Noted.'), rec(5, 'user', 'No robots.')].join('\n'));
  store.sources.put(makeSessionSource({ projectId: P.id, host: 'claude', sessionId: 'owner-1', file: log, cwd: repo, messageStart: 0, messageEnd: 4, at: '2026-09-02T01:00:00Z', excerpt: 'Pick by hand. Twice a week. No robots.', title: 'owner session', scopeItemId: 'si' }));
  const job = (id: string, kind: string, at: string, to: string): KeeperJob => ({ id, projectId: P.id, kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['crd_1'], label: kind }, status: 'Done', queuedAt: at, startedAt: at, endedAt: to, savedResults: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1 }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: 'job_root', resultText: null, priority: 1, task: null, step: { roundId: 'crd_1', kind: kind as never, path: null } } as unknown as KeeperJob);
  store.jobs.put(job('job_d', 'session-drafts', '2026-09-03T10:00:00Z', '2026-09-03T10:03:00Z'));
  store.drafts.put({ id: 'draft_1', projectId: P.id, session: { host: 'claude', sessionId: 'owner-1', file: log, startedAt: '', endedAt: '' }, ownerLines: [
    { ref: 'm0', at: '2026-09-02T01:00:00Z', text: 'Pick by hand.', kind: 'Decision', answers: null, confirms: null },
    { ref: 'm2', at: '2026-09-02T03:00:00Z', text: 'Twice a week.', kind: 'Decision', answers: null, confirms: null },
  ], agentSummary: [], jobId: 'job_d', at: '2026-09-03T10:03:00Z' });
  // The skeleton wrote two Owner's words items (and a goal, which is not one).
  const ref = (id: string, category: string) => ({ id, projectId: P.id, category, name: id, ids: [], text: id, quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: null, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: '', updatedAt: '' }) as never;
  store.reference.put(ref('ow_hand', "Owner's words"), { jobId: 'job_s', summary: 'Owner’s words' });
  store.reference.put(ref('ow_week', "Owner's words"), { jobId: 'job_s', summary: 'Owner’s words' });
  store.reference.put(ref('goal_fresh', 'Goal'), { jobId: 'job_s', summary: 'Goal' });
  store.reference.put(ref('ow_elsewhere', "Owner's words"), { jobId: 'job_other_round', summary: 'written by another round' });
  const ow = firstUsableFigures(store, store.clerkRounds.get('crd_1'), L).ownerWords!;
  assert.deepEqual([ow.calls, ow.minutes, ow.utterances, ow.chars], [1, 3, 2, 'Pick by hand.'.length + 'Twice a week.'.length], 'the draft calls, their span, the lines their drafts hold');
  assert.deepEqual([ow.total, ow.totalChars], [3, 'Pick by hand.Twice a week.No robots.'.length], 'of the owner’s three messages in the log — the ledger read no session, so not “of 0”');
  assert.equal(ow.items, 2, 'the Owner’s words items the round’s skeleton wrote — not the drafts, and not another round’s');
  store.jobs.remove('job_d'); store.drafts.remove('draft_1');
});

test('with the round’s question list, each path is counted by what its brief names, and a kind no brief covers by the ledger’s totals (Spec §3.7 “按问题清单算”, QC AY)', () => {
  const root = git(['rev-list', '--max-parents=0', 'HEAD']).trim();
  const brief = (id: string, path: string, markdown: string) => store.roundDocs.put({ id, projectId: P.id, roundId: 'crd_1', jobId: 'job_o', kind: 'Brief', path, title: `Brief: ${path}`, markdown, at: `2026-09-03T10:0${id.slice(-1)}:00Z` });
  brief('rdoc_1', 'The document chain and decisions: plans', '# Brief\n\n3. Read `docs/plan.md` in every version, and `attic/` (kept for recovery only).');
  brief('rdoc_2', 'The state of the code', `# Brief\n\n3. Read src/ and the commit ${root.slice(0, 7)} that started it.`);
  brief('rdoc_3', 'Old owner decisions', '# Brief\n\n3. Read what the owner decided, wherever it is.');
  const { paths, materials } = deepeningPlanPaths(L, store);
  assert.deepEqual(paths.map((p) => p.path), [
    'The document chain and decisions: plans', 'The state of the code', 'Old owner decisions',
    "The owner's meaning (no brief covers it yet)", "Each work item's process and checks (no brief covers it yet)",
  ], 'the sweeps orientation set, then the kinds none of them covers');
  const reads = (i: number) => Object.fromEntries(paths[i]!.reads.map((r) => [r.category.replace(/ \(.*$/, ''), r.count]));
  assert.deepEqual(reads(0), { documents: 1, "documents settled by the project's rules": 1 }, 'docs/plan.md once, however many versions; attic/old-plan.md settled by its rule');
  assert.deepEqual(reads(1), { 'code files': 1, 'commits named': 1 });
  assert.equal(paths[0]!.basis, 'counted from what its brief names');
  assert.equal(paths[2]!.basis, 'its brief names nothing the ledger can count', 'a brief named in other words, naming nothing countable, is counted for nothing');
  assert.match(paths[4]!.basis ?? '', /^the ledger's totals for this kind of question: no brief covers it yet, and the deepening sends a lane for each kind of question/);
  // Read closely: 1 document (named) + the commits (all 2: the process kind counts them whole, the named one inside) +
  // 1 code file (named) + 0 sessions.
  assert.equal(materials, 4);
  const first = firstUsableFigures(store, store.clerkRounds.get('crd_1'), L);
  const { options, basis } = clerkDepthOptions(first, L, store, 4);
  assert.equal(options.find((o) => o.depth === 'Full')!.toOrganize, 4, 'Full’s amount follows the question list, not the ledger’s totals (5)');
  assert.match(basis, /by the round's question list/);
  assert.match(basis, /Full reads 4 materials .* 5 readings across its 5 paths, since a material two paths plan is read by each — by lanes running 4 at a time/);
  for (const id of ['rdoc_1', 'rdoc_2', 'rdoc_3']) store.roundDocs.remove(id);
});

test('the deepening as it ran: each path’s reads against what its brief planned, whole and in part, what is left, and the round against the whole plan (CKC-13 AC-8)', () => {
  const { deepeningAsRun } = takeover;
  const [first] = git(['rev-list', '--reverse', 'HEAD']).trim().split('\n') as [string];
  const brief = (id: string, path: string, markdown: string) => store.roundDocs.put({ id, projectId: P.id, roundId: 'crd_1', jobId: 'job_o', kind: 'Brief', path, title: `Brief: ${path}`, markdown, at: `2026-09-03T10:0${id.slice(-1)}:00Z` });
  brief('rdoc_4', 'The document chain and decisions: plans', '# Brief\n\n3. Read `docs/plan.md` in every version, and `attic/` (kept for recovery only).');
  brief('rdoc_5', 'The code as it stands: src', `# Brief\n\n3. Read src/ and the commit ${first.slice(0, 7)} that started it.`);
  store.clerkRounds.put({ id: 'crd_deep', projectId: P.id, kind: 'Deepen', number: 2, startedAt: '2026-09-04T10:00:00Z', endedAt: '2026-09-04T10:30:00Z', status: 'Done', rootJobId: 'job_root2', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: '' });
  type Reads = NonNullable<KeeperJob['steps'][number]['reads']>;
  const job = (id: string, kind: string, path: string | null, reads: Reads[], parentJobId: string | null = 'job_root2', cost = 0.5): KeeperJob => ({ id, projectId: P.id, kind: parentJobId === 'job_root2' ? 'Organizing' : 'Investigation', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['crd_deep'], label: kind === 'dig' ? path! : 'Cross-check' }, status: 'Done', queuedAt: `2026-09-04T10:0${id.length % 10}:00Z`, startedAt: '2026-09-04T10:00:00Z', endedAt: '2026-09-04T10:10:00Z', savedResults: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: reads.map((r) => ({ at: '2026-09-04T10:01:00Z', tool: 'bash', target: '', summary: '', isError: false, reads: r })), error: null, requestBasis: null, parentJobId, resultText: null, priority: 1, task: null, step: parentJobId === 'job_root2' ? { roundId: 'crd_deep', kind, path } : null } as unknown as KeeperJob);
  const at = (rel: string) => join(repo, ...rel.split('/'));
  // Plans: the plan as it stands (its current version) and its first version from the history, both whole.
  store.jobs.put(job('job_dig_plans', 'dig', 'The document chain and decisions: plans', [[{ path: at('docs/plan.md') }], [{ path: at('docs/plan.md'), rev: first.slice(0, 12) }]]));
  // Code: two of src/app.ts's lines as they were then, the commit it names; its investigation read the README whole.
  store.jobs.put(job('job_dig_code', 'dig', 'The code as it stands: src', [[{ path: at('src/app.ts'), from: 1, to: 2, lines: 5 }], [{ rev: first.slice(0, 8) }]]));
  store.jobs.put(job('job_inv', 'dig', null, [[{ path: at('README.md') }]], 'job_dig_code'));
  store.jobs.put(job('job_cross', 'cross-check', null, [[{ path: at('docs/plan.md'), from: 1, to: 1, lines: 3 }]]));
  const { progress, actual } = deepeningAsRun(L, store, P);
  const of = (path: string) => progress.find((p) => p.path === path)!.reads!;
  const plans = of('The document chain and decisions: plans');
  assert.deepEqual([plans.planned, plans.whole, plans.part, plans.left], [1, 1, 0, 0], 'docs/plan.md, one material, read whole as it stands; attic/ is settled by its rule, not planned');
  assert.deepEqual(plans.beyond, { whole: 1, part: 0 }, 'its first version, read from the history, is no material of its own: beyond the plan');
  const code = of('The code as it stands: src');
  assert.deepEqual([code.planned, code.whole, code.part, code.left], [2, 1, 1, 0], 'the commit whole, src/app.ts in part');
  assert.deepEqual(code.beyond, { whole: 1, part: 0 }, 'the README its investigation read is beyond its plan');
  assert.deepEqual(code.byCategory.map((c) => [c.category, c.planned, c.whole, c.part, c.left]), [['document versions', 0, 0, 0, 0], ['code files', 1, 0, 1, 0], ['commits', 1, 1, 0, 0]], 'its brief plans no document: the README is beyond it');
  const cross = of('Cross-check');
  assert.deepEqual([cross.planned, cross.left, cross.beyond.part], [null, null, 1], 'a step no path plans: what it read is beyond any plan');
  // The round against the whole plan: 1 document named, 2 commits counted whole (a kind no brief covers), 1 code file.
  assert.equal(actual!.planned, deepeningPlanPaths(L, store).materials);
  assert.deepEqual([actual!.planned, actual!.whole, actual!.part, actual!.left], [4, 2, 1, 1], 'docs/plan.md whole, one commit of two, src/app.ts in part; one commit left');
  assert.deepEqual(actual!.beyond, { whole: 2, part: 0 }, 'the README (no brief names it) and the old version of docs/plan.md (history, no material of its own)');
  assert.deepEqual([actual!.minutes, actual!.cost, actual!.status, actual!.depth], [30, 2, 'Done', 'Full'], 'its time and its cost beside the estimate');
  // The first usable round's own figures count what its steps read, whole and in part, by any means.
  store.jobs.put({ ...job('job_first_reads', 'skeleton', null, [[{ path: at('docs/plan.md') }], [{ path: at('src/app.ts'), from: 1, to: 1, lines: 5 }]]), step: { roundId: 'crd_1', kind: 'skeleton', path: null } } as KeeperJob);
  const firstFigures = firstUsableFigures(store, store.clerkRounds.get('crd_1'), L, P);
  assert.equal(firstFigures.byKind['files read in part'], 1, 'src/app.ts, two lines of five');
  for (const id of ['job_dig_plans', 'job_dig_code', 'job_inv', 'job_cross', 'job_first_reads']) store.jobs.remove(id);
  for (const id of ['rdoc_4', 'rdoc_5']) store.roundDocs.remove(id);
  store.clerkRounds.remove('crd_deep');
});
