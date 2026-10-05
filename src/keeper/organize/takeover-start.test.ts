/**
 * The takeover starts when the owner says so, and can be cleared (Spec §3.7, §3.8, §6.10; D105; CKC-13 AC-19, AC-20,
 * AC-23, AC-38, AC-40, AC-41; CKC-04 AC-10; CKC-07 AC-17, AC-28～AC-30):
 *   - adding a project starts nothing: no boundary, nothing read, no round, nothing waiting;
 *   - `Start` with each depth runs the first usable round and then the chosen depth without asking again;
 *   - from the start the depths cannot be pressed; once done, only a deeper one can, and it goes on from what is done;
 *   - the depth shown is the depth that ran — read from the rounds, not from the last button pressed;
 *   - `Clear` takes the word DELETE, stops what runs, removes the organized assets and nothing else;
 *   - the schedule starts a round at its time when something changed, one round for the times missed, never two at once;
 *   - a home from before D105 opens on `Daily`, at the depth that ran, its rhythm mapped to a schedule.
 * The project is invented ("Tern", a tide-table printer for a harbour office) and lives in a temporary directory; its
 * git repository is only read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from '../../util/tmp.test-helpers.ts';
import { join } from 'node:path';
import type { ClerkRound } from '../../model/k-types.ts';
import type { KeeperJob, Note } from '../../model/types.ts';
import type { TakeoverDepth } from '../../model/vocab.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-pi-agent-'));
const { App } = await import('../../server/app.ts');
const { ClerkPlanner } = await import('./clerk.ts');
const { writeClerkCoverage } = await import('./service.ts');
const { takeoverState, startRefusal } = await import('./takeover-state.ts');
const { localTime } = await import('./schedule.ts');
const { keeperPageView, clearPreview, notOrganizedPackage } = await import('../../server/keeper-page.ts');
const { internalRefs } = await import('../owner-text.ts');
const { registerRoutes } = await import('../../server/api.ts');
const { startFakeProvider, FAKE_MODEL } = await import('../fake-provider.ts');
type AppT = InstanceType<typeof App>;

const ENV = { GIT_AUTHOR_NAME: 'Tern Dev', GIT_AUTHOR_EMAIL: 'dev@tern.invalid', GIT_COMMITTER_NAME: 'Tern Dev', GIT_COMMITTER_EMAIL: 'dev@tern.invalid' };
/** A small project on disk: a README, a plan, a decision log, and a `projectkeeper/` folder the Keeper wrote earlier. */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pk-tern-'));
  const write = (rel: string, text: string) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
  write('README.md', '# Tern\n\nPrints tide tables for the harbour office.\n');
  write('docs/PLAN.md', '# Plan\n\n## T-1 Read the gauge feed\n\n## T-2 Print the weekly table\n');
  write('docs/DECISIONS.md', '# Decisions\n\n**D1 · Tables are printed on Mondays.**\n');
  write('projectkeeper/README.md', '# ProjectKeeper\n\nWritten by the Keeper under the owner’s authorization.\n');
  const git = (args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']); git(['add', '-A']); git(['commit', '-q', '-m', 'Start Tern']);
  return dir;
}
/** Every file of the project with its content, and its git state: what a clear must leave exactly as it was. */
function projectState(dir: string): string {
  const files: string[] = [];
  const walk = (rel: string) => { for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) { if (e.name === '.git') continue; const p = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(p); else files.push(`${p}\n${readFileSync(join(dir, p), 'utf8')}`); } };
  walk('');
  const git = (args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8' });
  return [...files.sort(), git(['rev-parse', 'HEAD']), git(['status', '--porcelain'])].join('\n---\n');
}

const iso = (ms: number) => new Date(ms).toISOString();
let seq = 0;
/** A round as the planner would have left it, with the record of the program's own work it hangs under. */
function plantRound(app: AppT, projectId: string, over: Partial<ClerkRound> & { label?: string }): ClerkRound {
  const store = app.store(projectId);
  const { label, ...rest } = over;
  const id = rest.id ?? `crd_t${++seq}`;
  const kind = rest.kind ?? 'First usable';
  const number = rest.number ?? store.clerkRounds.size + 1;
  const startedAt = rest.startedAt ?? iso(Date.now() - 60_000);
  const root: KeeperJob = { id: `job_root_${id}`, projectId, kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-round', ids: [id], label: label ?? (kind === 'Deepen' ? `Takeover round ${number}: deepening (${rest.depth ?? 'Full'})` : kind === 'First usable' ? `Takeover round ${number}: the first usable picture` : `Follow up round ${number}`) }, status: 'Done', queuedAt: startedAt, startedAt, endedAt: rest.endedAt ?? startedAt, savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'program', model: null, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: null, resultText: null, priority: 1, task: { prompt: '', stream: false, timeoutMs: null, extra: { kind: 'clerk-round', roundId: id, roundKind: kind } }, step: null } as KeeperJob;
  store.jobs.put(root);
  return store.clerkRounds.put({ id, projectId, kind, number, startedAt, endedAt: startedAt, status: 'Done', rootJobId: root.id, questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: startedAt, ...rest });
}
/** A model job of a round's step, with what it cost. */
function plantStep(app: AppT, projectId: string, roundId: string, kind: string, cost: number, over: Partial<KeeperJob> = {}): KeeperJob {
  const at = iso(Date.now() - 30_000);
  return app.store(projectId).jobs.put({ id: `job_s${++seq}`, projectId, kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: [roundId], label: kind }, status: 'Done', queuedAt: at, startedAt: at, endedAt: at, savedResults: [], usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost }, agent: 'pi', model: { provider: 'tide', id: 'gauge-1', thinking: 'high' }, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: null, resultText: null, priority: 1, task: { prompt: '', stream: false, timeoutMs: null, extra: null }, step: { roundId, kind, path: null }, ...over } as KeeperJob);
}
function routes(app: AppT) {
  const handlers = new Map<string, (ctx: unknown) => unknown>();
  registerRoutes({ route: (m: string, p: string, h: (ctx: unknown) => unknown) => handlers.set(`${m} ${p}`, h), static: () => undefined } as never, app, '', '');
  return (method: string, path: string, params: Record<string, string>, body: unknown = null, query = '') => {
    const handler = handlers.get(`${method} ${path}`);
    assert.ok(handler, `${method} ${path}`);
    return handler({ params, query: new URLSearchParams(query), body });
  };
}
const refused = async (run: () => unknown, status: number, message: RegExp) => {
  await assert.rejects(async () => { await run(); }, (e: Error & { status?: number }) => { assert.equal(e.status, status, e.message); assert.match(e.message, message); return true; });
};

// ───────────────────────── adding a project starts nothing ─────────────────────────

test('adding a project starts nothing: no boundary, nothing read, no round, nothing waiting — it is Not organized yet (CKC-04 AC-10, CKC-13 AC-20)', async () => {
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')));
  const dir = makeProject();
  const project = app.addProject('Tern', [dir]);
  const store = app.store(project.id);
  await new Promise((r) => setImmediate(r));   // what used to start by itself started on the next tick
  await app.organizing.replan(project.id);
  assert.deepEqual([app.project(project.id).scope.length, app.project(project.id).lastScopedAt], [0, null], 'no boundary is drawn');
  assert.equal(store.sources.size, 0, 'nothing is read');
  assert.equal(store.clerkRounds.size, 0, 'no round');
  assert.equal(store.jobs.size, 0, 'no Keeper work, so no usage');
  assert.equal(app.pendingChanges(project.id).length, 0, 'the project is not watched');
  assert.equal(store.coverage.state, 'Not organized yet');
  assert.equal(store.coverage.takeover?.stage, 'Not started');
  assert.equal(store.coverage.takeover?.depth, 'Depth not chosen');
  assert.deepEqual(store.coverage.scopes.find((s) => s.id === 'project')?.pending ?? [], [], 'no change counts as waiting');
  const state = takeoverState(store, app.project(project.id));
  assert.equal(state.phase, 'Not started');
  assert.deepEqual(state.options.map((o) => [o.depth, o.selectable]), [['Full', true], ['Focused', true], ['First picture only', true]], 'every depth can be chosen');
  // The page: Takeover, not taken over; Daily says to finish the takeover first; Follow up is refused.
  const page = await keeperPageView(app, project.id);
  assert.deepEqual([page.state, page.page, page.takeover.phase, page.daily.available], ['Not taken over', 'takeover', 'Not started', false]);
  assert.match(page.daily.why ?? '', /Choose a depth and press Start/);
  const call = routes(app);
  await refused(() => call('POST', '/api/projects/:id/keeper/follow-up', { id: project.id }), 409, /Start the takeover on the Takeover page first/);
  await refused(() => call('POST', '/api/projects/:id/scope/rescan', { id: project.id }), 409, /Nothing is read before that/);
  // An execution agent asking for the context is told the project is not organized; it does not get an empty pack.
  const pack = await call('GET', '/api/projects/:id/context', { id: project.id }) as { markdown: string };
  assert.match(pack.markdown, /^# Tern: not organized yet/);
  assert.match(pack.markdown, /this is not an empty pack/);
  app.stopAll();
});

// ───────────────────────── Start, with each depth ─────────────────────────

for (const depth of ['First picture only', 'Focused', 'Full'] as const satisfies readonly TakeoverDepth[]) {
  test(`Start with ${depth}: the first usable round, then ${depth === 'First picture only' ? 'nothing more — the takeover is done' : `the ${depth} deepening without asking again`} (CKC-13 AC-23, AC-38)`, async () => {
    const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')), { organizing: false });
    const project = app.addProject('Tern', [makeProject()]);
    const store = app.store(project.id);
    const planner = new ClerkPlanner(app);
    const P = () => app.project(project.id);
    assert.equal(planner.nextRoundKind(store, P()), null, 'before Start nothing is due');

    app.startTakeover(project.id, depth);
    assert.ok(P().lastScopedAt, 'Start draws the boundary');
    assert.ok(P().scope.length > 0);
    assert.deepEqual([P().takeoverDepth, Boolean(P().takeoverStartedAt)], [depth, true]);
    assert.equal(planner.nextRoundKind(store, P()), 'First usable', 'the takeover begins with the first usable round');
    let state = takeoverState(store, P());
    assert.deepEqual([state.phase, state.chosen, state.ran], ['Under way', depth, null]);
    assert.ok(state.options.every((o) => !o.selectable), 'from the start, no depth can be pressed');

    plantRound(app, project.id, { kind: 'First usable' });
    state = takeoverState(store, P());
    if (depth === 'First picture only') {
      assert.deepEqual([state.phase, state.ran], ['Done', 'First picture only']);
      assert.equal(planner.nextRoundKind(store, P()), null, 'no deepening, and no round until the schedule or the owner asks');
    } else {
      assert.deepEqual([state.phase, state.ran], ['Under way', 'First picture only'], 'the first picture is there; the chosen depth is not reached yet');
      assert.equal(planner.nextRoundKind(store, P()), 'Deepen', 'it goes on to the chosen depth by itself');
      const deepen = planner.startRound(store, P(), 'Deepen');
      assert.equal(deepen.depth, depth, 'the deepening keeps the depth it runs at');
      assert.equal(store.jobs.get(deepen.rootJobId)!.scope.label, `Takeover round 2: deepening (${depth})`);
      assert.equal(planner.nextRoundKind(store, P()), null, 'one deepening, not two');
      store.clerkRounds.put({ ...deepen, status: 'Done', endedAt: iso(Date.now()) });
      state = takeoverState(store, P());
      assert.deepEqual([state.phase, state.ran, state.completedAt !== null], ['Done', depth, true]);
      assert.equal(planner.nextRoundKind(store, P()), null);
    }
    assert.ok(!store.notes.has('note_takeover-depth'), 'no note asks for the depth');
    writeClerkCoverage(app, project.id);
    assert.deepEqual([store.coverage.state, store.coverage.takeover?.stage, store.coverage.takeover?.depth], ['Takeover complete', 'Daily', depth]);
    app.stopAll();
  });
}

// ───────────────────────── what can be chosen once it has started ─────────────────────────

test('from the start no depth can be pressed; once done only a deeper one can, and it goes on from what is done (CKC-13 AC-19, AC-23)', async () => {
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')), { organizing: false });
  const project = app.addProject('Tern', [makeProject()]);
  const store = app.store(project.id);
  const planner = new ClerkPlanner(app);
  const P = () => app.project(project.id);
  const state = () => takeoverState(store, P());

  // Before the start: a depth has to be chosen, and a key has to be usable.
  assert.match(startRefusal(state(), null, true) ?? '', /Choose a depth/);
  assert.match(startRefusal(state(), 'Deepest', true) ?? '', /Choose a depth/);
  assert.match(startRefusal(state(), 'Focused', false) ?? '', /No usable key/);
  assert.equal(startRefusal(state(), 'Focused', true), null);
  assert.throws(() => app.startTakeover(project.id, 'Focused', false), /No usable key/);
  assert.equal(state().phase, 'Not started', 'a refused Start changes nothing');

  app.startTakeover(project.id, 'Focused');
  // Under way: every depth is refused, and the record does not move.
  for (const d of ['Full', 'Focused', 'First picture only'] as const) assert.throws(() => app.startTakeover(project.id, d), /The takeover is under way at Focused/);
  assert.equal(P().takeoverDepth, 'Focused');

  plantRound(app, project.id, { kind: 'First usable' });
  const focused = planner.startRound(store, P(), 'Deepen');
  store.clerkRounds.put({ ...focused, status: 'Done', endedAt: iso(Date.now()) });
  assert.deepEqual(state().options.map((o) => [o.depth, o.selectable, o.ran]), [['Full', true, false], ['Focused', false, true], ['First picture only', false, false]]);
  assert.throws(() => app.startTakeover(project.id, 'Focused'), /Focused has run. To run it again from the beginning, Clear first/);
  assert.throws(() => app.startTakeover(project.id, 'First picture only'), /Focused has run, which goes deeper than First picture only. To go shallower, Clear first/);
  assert.deepEqual([P().takeoverDepth, state().phase], ['Focused', 'Done'], 'the refused presses changed nothing: the page still says Focused, done');

  // Deeper: Full goes on from what is done — one more deepening, at Full; the rounds that ran stay.
  const before = store.clerkRounds.size;
  app.startTakeover(project.id, 'Full');
  assert.deepEqual([state().phase, state().chosen, state().ran], ['Under way', 'Full', 'Focused']);
  assert.equal(planner.nextRoundKind(store, P()), 'Deepen');
  const full = planner.startRound(store, P(), 'Deepen');
  assert.equal(full.depth, 'Full');
  assert.equal(store.clerkRounds.size, before + 1, 'what was done is not done again');
  store.clerkRounds.put({ ...full, status: 'Done', endedAt: iso(Date.now()) });
  assert.deepEqual([state().phase, state().ran], ['Done', 'Full']);
  assert.ok(state().options.every((o) => !o.selectable), 'nothing is deeper than Full');
  app.stopAll();
});

test('the depth shown is the depth that ran, read from the rounds — not the last button pressed (the 2026-10-02 case)', async () => {
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')), { organizing: false });
  const project = app.addProject('Tern', [makeProject()]);
  const store = app.store(project.id);
  // A home from before D105: the rounds ran at Full (the deepening's own record says so), then the owner pressed
  // Focused, which ran nothing and overwrote the field.
  plantRound(app, project.id, { kind: 'First usable' });
  plantRound(app, project.id, { kind: 'Deepen', label: 'Takeover round 2: deepening (Full)' });
  app.updateProject({ ...app.project(project.id), takeoverDepth: 'Focused', takeoverDepthChosenAt: iso(Date.now()) });
  const state = takeoverState(store, app.project(project.id));
  assert.deepEqual([state.phase, state.ran, state.chosen], ['Done', 'Full', 'Full']);
  writeClerkCoverage(app, project.id);
  assert.equal(store.coverage.takeover?.depth, 'Full', 'the coverage says Full');
  // The briefing's words are what the takeover wrote, without what the owner-text check finds (Spec §6.13; owner-text.ts).
  store.reference.put({ id: 'ref_tern_product', projectId: project.id, category: 'Product', name: 'Tern', ids: [], text: 'Tern prints the weekly tide table (mark_7236fe3d8503083c) for the harbour office.', quote: null, basis: 'Explicit', validity: 'Current', progress: null, sourceIds: [], refines: [], replacedBy: null } as never);
  const page = await keeperPageView(app, project.id);
  assert.equal(page.takeover.briefing?.project.text, 'Tern prints the weekly tide table for the harbour office.');
  assert.deepEqual(internalRefs({ text: JSON.stringify(page.takeover.briefing) }), [], 'no internal identifier in the briefing');
  assert.deepEqual([page.takeover.ran, page.takeover.briefing?.read.depth], ['Full', 'Full']);
  assert.deepEqual(page.takeover.options.map((o) => [o.depth, o.selectable, o.ran]), [['Full', false, true], ['Focused', false, false], ['First picture only', false, false]]);
  // A deepening whose depth cannot be read at all counts as the shallower of the two it could have been.
  const other = app.addProject('Skua', [makeProject()]);
  plantRound(app, other.id, { kind: 'First usable' });
  plantRound(app, other.id, { kind: 'Deepen', label: 'Takeover round 2' });
  assert.equal(takeoverState(app.store(other.id), app.project(other.id)).ran, 'Focused', 'so a deeper choice is never refused on a guess');
  app.stopAll();
});

// ───────────────────────── Clear ─────────────────────────

test('Clear takes the word DELETE; then the organized assets are gone, and the project, its settings and its files are as they were (CKC-13 AC-40, AC-41)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const app = new App(home, { organizing: false });
  const dir = makeProject();
  const project = app.addProject('Tern', [dir]);
  const store = app.store(project.id);
  const P = () => app.project(project.id);
  await refused(() => app.clearProject(project.id, 'DELETE'), 409, /has not been organized: there is nothing to clear/);

  app.markTakeoverStarted(project.id, 'First picture only');
  await app.intakeProject(project.id);
  app.stopAll();
  // What a takeover leaves: a round with what it cost, a note the owner answered, a work item, the owner's own scope
  // item, a saved schedule, the Project folder authorization, the kept versions and the trace.
  const round = plantRound(app, project.id, { kind: 'First usable' });
  plantStep(app, project.id, round.id, 'main', 1.25);
  plantStep(app, project.id, round.id, 'synthesis', 0.75);
  const at = iso(Date.now());
  store.notes.put({ id: 'note_tides', projectId: project.id, mount: { kind: 'project', ids: [] }, status: 'Current', ownerResponse: 'Decided', versions: [{ version: 1, at, title: 'Print on Mondays or on the spring tide?', preview: 'Two rules disagree.', body: { currentView: '', whyItMatters: '', facts: [], otherExplanations: null, keepAdjust: '', whatWouldSettleIt: '' }, ask: 'For your decision', judgementRecordId: 'jdg_x', reason: '' }], discussion: [{ role: 'owner', text: 'Mondays. The spring-tide rule is gone.', at, sourceId: null }], followUps: [], author: { agent: 'pi', model: 'gauge-1' }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, language: 'en', updatedAt: at } as Note, { jobId: null, summary: 'A note of the takeover' });
  store.authorizations.put({ id: 'auth_folder', projectId: project.id, scope: 'ProjectKeeper may maintain the projectkeeper folder', sourceId: '', quote: 'Keep the folder; commit only it.', at, revokedAt: null, projectFolder: { path: join(dir, 'projectkeeper'), commits: true, lastWrite: null } });
  app.addScopeItem(project.id, { path: join(dir, 'docs'), category: 'Directory', relation: 'Main project', reason: 'The owner pointed at the docs' });
  app.setSchedule(project.id, { frequency: 'On selected days', time: '07:30', days: [1], savedAt: at });
  app.saveVersion(project.id, 'Opened');
  writeClerkCoverage(app, project.id);
  await app.flushAll();
  assert.ok(store.sources.size > 0 && existsSync(join(store.dir, 'trace.jsonl')) && existsSync(join(store.dir, 'versions')), 'the assets are on disk');
  const filesBefore = projectState(dir);

  // The dialog's figures: what goes, each with how many; what the owner said only to the Keeper; what stays.
  const preview = clearPreview(app, project.id);
  const removed = new Map(preview.removed.map((r) => [r.what, r]));
  assert.equal(removed.get('Sources read (anchors and excerpts)')!.count, store.sources.size);
  assert.equal(removed.get('Notes')!.count, 1);
  assert.match(removed.get('Notes')!.note ?? '', /1 version, 1 discussion entry, 1 of your responses/);
  assert.equal(removed.get('Rounds, with their briefs, reports and adoption records')!.count, 1);
  assert.equal(removed.get('Standing authorizations')!.count, 1);
  assert.equal(preview.ownerOnly, 2, 'the owner’s reply on the note and the response: said to the Keeper, in no project document');
  const kept = new Map(preview.kept.map((k) => [k.what, k.detail]));
  assert.match(kept.get('The ProjectKeeper folder inside the project')!, /projectkeeper stays where it is, with README\.md/);
  assert.match(kept.get('What was spent so far')!, /\$2\.00/);
  assert.match(kept.get('The project in the workspace')!, /Its name \(Tern\).*the 1 scope item\(s\) you added yourself/);

  // Without the word, nothing changes.
  const counts = () => [store.sources.size, store.notes.size, store.clerkRounds.size, store.jobs.size, store.authorizations.size, P().scope.length];
  const beforeCounts = counts();
  for (const word of ['delete', 'DELETE ', '', undefined, 'yes']) await refused(() => app.clearProject(project.id, word), 400, /Type DELETE to confirm\. Nothing was changed/);
  assert.deepEqual(counts(), beforeCounts, 'a wrong word or a cancel changes nothing');
  assert.equal(projectState(dir), filesBefore);

  const result = await app.clearProject(project.id, 'DELETE');
  assert.deepEqual(result.leftBehind, [], 'every file of the assets was removed');
  // The assets are gone, in memory and on disk.
  assert.deepEqual([store.sources.size, store.notes.size, store.clerkRounds.size, store.jobs.size, store.authorizations.size, store.threads.size, store.nodes.size, store.roundDocs.size], [0, 0, 0, 0, 0, 0, 0, 0]);
  const left = readdirSync(store.dir);
  assert.ok(!left.includes('versions') && !left.includes('ledger.sqlite') && !left.some((f) => /^(sources|notes|jobs|clerkRounds)\.json$/.test(f)), `only what the cleared project writes anew is there: ${left.join(', ')}`);
  // The project is as it was before the takeover.
  assert.equal(store.coverage.state, 'Not organized yet');
  const state = takeoverState(store, P());
  assert.equal(state.phase, 'Not started');
  assert.ok(state.options.every((o) => o.selectable), 'every depth can be chosen again');
  assert.deepEqual([P().takeoverDepth ?? null, P().takeoverStartedAt ?? null, P().lastScopedAt, P().scopeQuestions.length], [null, null, null, 0]);
  // What stays: the project's entry, the owner's own scope item, the schedule, and what was spent, as one total.
  assert.deepEqual([P().name, P().locations], ['Tern', [dir]].map((x) => x) as unknown as [string, string[]]);
  assert.deepEqual(P().scope.map((i) => [i.addedBy, i.reason]), [['owner', 'The owner pointed at the docs']]);
  assert.deepEqual([P().schedule?.frequency, P().schedule?.time, P().schedule?.days], ['On selected days', '07:30', [1]]);
  assert.deepEqual([P().usageBeforeClear?.usage.cost, P().usageBeforeClear?.usage.input, P().usageBeforeClear?.times], [2, 2000, 1]);
  // The project's own files, its git state and the folder inside it are exactly as before.
  assert.equal(projectState(dir), filesBefore, 'nothing in the project was touched');
  assert.ok(existsSync(join(dir, 'projectkeeper', 'README.md')));
  // Nothing runs until Start; an agent asking for context is told the project is not organized.
  const planner = new ClerkPlanner(app);
  assert.equal(planner.nextRoundKind(store, P()), null);
  assert.match(notOrganizedPackage(P(), { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null, taskVersion: null }, 'Idle').markdown, /not organized yet/);
  const page = await keeperPageView(app, project.id);
  assert.deepEqual([page.state, page.page, page.daily.available], ['Not taken over', 'takeover', false]);
  // Cleared a second time after another takeover, the spending adds up.
  app.markTakeoverStarted(project.id, 'First picture only');
  const again = plantRound(app, project.id, { kind: 'First usable' });
  plantStep(app, project.id, again.id, 'main', 0.5);
  await app.clearProject(project.id, 'DELETE');
  assert.deepEqual([P().usageBeforeClear?.usage.cost, P().usageBeforeClear?.times], [2.5, 2]);
  // A reopened home finds the project as it was left: not organized.
  await app.flushAll();
  const reopened = new App(home, { organizing: false });
  assert.equal(takeoverState(reopened.store(project.id), reopened.project(project.id)).phase, 'Not started');
  assert.equal(reopened.store(project.id).sources.size, 0);
  reopened.stopAll();
});

test('Clear stops a round that is running first, waits for it, and leaves nothing of it behind', { timeout: 120_000 }, async () => {
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')));
  const dir = makeProject();
  const fake = await startFakeProvider();
  fake.mode.value = 'hang';   // the model never answers: the round's first model step stays running
  try {
    const project = app.addProject('Tern', [dir]);
    await app.initKeeper();
    app.keeper.models.registerProvider('fake', { name: 'Fake', baseUrl: fake.url, apiKey: 'k', api: 'openai-completions', models: [FAKE_MODEL] });
    app.keeper.setModel({ provider: 'fake', id: FAKE_MODEL.id, thinking: null });
    const store = app.store(project.id);
    const before = projectState(dir);
    app.startTakeover(project.id, 'First picture only');
    const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 600 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); assert.ok(ok(), what); };
    await until(() => store.jobs.find((j) => j.agent !== 'program' && j.status === 'Running') !== undefined, 'a model step of the first usable round running');
    assert.equal(store.clerkRounds.find((r) => r.status === 'Running')?.kind, 'First usable');

    const result = await app.clearProject(project.id, 'DELETE');
    assert.ok(result.stopped >= 2, `the round and its running step were stopped (${result.stopped})`);
    await new Promise((r) => setTimeout(r, 500));   // anything that still wrote would have by now
    assert.deepEqual([store.jobs.size, store.clerkRounds.size, store.sources.size], [0, 0, 0], 'nothing of the stopped round came back');
    assert.equal(takeoverState(store, app.project(project.id)).phase, 'Not started');
    assert.equal(store.coverage.state, 'Not organized yet');
    await app.organizing.replan(project.id);
    assert.equal(store.clerkRounds.size, 0, 'and no round starts by itself afterwards');
    assert.equal(app.pendingChanges(project.id).length, 0, 'the project is no longer watched');
    assert.equal(projectState(dir), before, 'the project’s files are as they were');
  } finally { fake.close(); app.stopAll(); }
});

// ───────────────────────── the schedule ─────────────────────────

test('the schedule: a round at its time when something changed; none when nothing did; one for the times missed; never two at once (CKC-07 AC-29, AC-30)', async () => {
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')), { organizing: false });
  const dir = makeProject();
  const project = app.addProject('Tern', [dir]);
  const store = app.store(project.id);
  const planner = new ClerkPlanner(app);
  const P = () => app.project(project.id);
  app.markTakeoverStarted(project.id, 'First picture only');
  await app.intakeProject(project.id);
  app.stopAll();
  // The takeover finished a moment ago; its round took in everything read so far.
  const doneAt = Date.now();
  plantRound(app, project.id, { kind: 'First usable', startedAt: iso(doneAt), endedAt: iso(doneAt) });
  assert.equal(takeoverState(store, P()).phase, 'Done');
  const day = 24 * 60 * 60_000;
  const time = localTime(new Date(doneAt));
  assert.deepEqual([(await keeperPageView(app, project.id, doneAt)).daily.schedule.frequency, (await keeperPageView(app, project.id, doneAt)).daily.schedule.time], ['Every day', time], 'never changed: every day at the time the takeover finished');

  // The same day: no scheduled time has come.
  planner.clock = () => doneAt + 60 * 60_000;
  assert.equal(planner.nextRoundKind(store, P()), null);
  assert.equal(P().scheduleHandled ?? null, null);

  // The next day's time comes and nothing changed: no round, and the page can say so.
  planner.clock = () => doneAt + day + 5 * 60_000;
  assert.equal(planner.nextRoundKind(store, P()), null, 'nothing changed: no round');
  assert.equal(P().scheduleHandled?.outcome, 'nothing changed');
  const firstSlot = P().scheduleHandled!.slot;
  assert.equal(planner.nextRoundKind(store, P()), null);
  assert.equal(P().scheduleHandled!.slot, firstSlot, 'the same time is dealt with once');

  // Something changes (a file read after the last round started), and three more scheduled times pass with
  // ProjectKeeper not running: one round makes up for them.
  writeFileSync(join(dir, 'docs', 'PLAN.md'), '# Plan\n\n## T-1 Read the gauge feed\n\n## T-2 Print the weekly table\n\n## T-3 Post it on the quay\n');
  await app.intakeProject(project.id);
  app.stopAll();
  planner.clock = () => doneAt + 4 * day + 5 * 60_000;
  assert.equal(planner.nextRoundKind(store, P()), 'Follow up', 'the time came and something changed');
  assert.equal(P().scheduleHandled?.outcome, 'round');
  assert.ok(Date.parse(P().scheduleHandled!.slot) > Date.parse(firstSlot) + 2 * day, 'the latest missed time stands for all of them');
  const round = planner.startRound(store, P(), 'Follow up');
  assert.equal(round.startedBy, 'schedule', 'the round says what started it');
  assert.equal(P().scheduleHandled?.roundId, round.id);
  assert.equal(planner.nextRoundKind(store, P()), null, 'the missed times are made up for once, not once each');

  // The next time comes while that round still runs: no second round, and what changed waits for the next one.
  planner.clock = () => doneAt + 5 * day + 5 * 60_000;
  await planner.plan(project.id);
  assert.equal(store.clerkRounds.filter((r) => r.status === 'Running').length, 1, 'never two rounds at once');
  assert.equal(P().scheduleHandled?.outcome, 'a round was running');
  store.clerkRounds.put({ ...store.clerkRounds.get(round.id)!, status: 'Done', endedAt: iso(Date.now()) });
  assert.equal(planner.nextRoundKind(store, P()), null, 'the time that passed during the round starts none afterwards');

  // Follow up starts a round now, whatever the schedule says, and it is the owner's.
  app.updateProject({ ...P(), followUpAt: iso(Date.now() + 1000) });
  assert.equal(planner.nextRoundKind(store, P()), 'Follow up');
  assert.equal(planner.startRound(store, P(), 'Follow up').startedBy, 'owner');
  app.stopAll();
});

test('each frequency at the planner: Off starts nothing by itself, Continuous starts when something waits, a saved time counts from the save', async () => {
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-home-')), { organizing: false });
  const dir = makeProject();
  const project = app.addProject('Tern', [dir]);
  const store = app.store(project.id);
  const planner = new ClerkPlanner(app);
  const P = () => app.project(project.id);
  app.markTakeoverStarted(project.id, 'First picture only');
  const doneAt = Date.now() - 1000;
  plantRound(app, project.id, { kind: 'First usable', startedAt: iso(doneAt), endedAt: iso(doneAt) });
  await app.intakeProject(project.id);   // read after the round started: it waits for the next round
  app.stopAll();
  const day = 24 * 60 * 60_000;
  const call = routes(app);
  const save = (body: unknown) => call('POST', '/api/projects/:id/keeper/schedule', { id: project.id }, body) as Promise<{ daily: { schedule: { frequency: string }; nextAt: string | null; scheduleText: string } }>;

  planner.clock = () => Date.now() + 30 * day;
  assert.equal((await save({ frequency: 'Off' })).daily.nextAt, null, 'Off has no next time');
  assert.equal(planner.nextRoundKind(store, P()), null, 'Off: nothing starts by itself, however long it waits');

  await save({ frequency: 'Continuous' });
  assert.equal(planner.nextRoundKind(store, P()), 'Follow up', 'Continuous: a round as soon as something waits');

  // A time of day, saved now: the next time is said, and times before the save are not made up for.
  const now = new Date();
  const saved = await save({ frequency: 'Every day', time: localTime(new Date(now.getTime() - 60 * 60_000)) });
  assert.ok(saved.daily.nextAt && Date.parse(saved.daily.nextAt) > now.getTime(), 'the page says when the next one is');
  planner.clock = () => Date.now();
  assert.equal(planner.nextRoundKind(store, P()), null, 'the time an hour before the save is not due');
  planner.clock = () => Date.now() + day;
  assert.equal(planner.nextRoundKind(store, P()), 'Follow up', 'the first time after the save is');

  const weekday = (new Date().getDay() + 3) % 7;
  const selected = await save({ frequency: 'On selected days', time: '06:00', days: [weekday] });
  assert.equal(new Date(selected.daily.nextAt!).getDay(), weekday, 'On selected days: the next time falls on a chosen day');
  const everyN = await save({ frequency: 'Every N days', time: '23:59', everyDays: 4 });
  assert.match(everyN.daily.scheduleText, /^Every 4 days at 23:59$/);
  await refused(() => save({ frequency: 'Every day', time: 'noon' }), 400, /time of day/);
  assert.equal(P().schedule?.frequency, 'Every N days', 'a schedule that was refused is not saved');
  app.stopAll();
});

// ───────────────────────── a home from before the two pages ─────────────────────────

test('a home organized before D105 opens on Daily, its takeover done at the depth that ran, its rhythm mapped to a schedule', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const app = new App(home, { organizing: false });
  const project = app.addProject('Tern', [makeProject()]);
  const store = app.store(project.id);
  const P = () => app.project(project.id);
  // As the old flow left it: scoped and read at once, two rounds (the deepening at Full), a depth note still standing,
  // the `Daily` rhythm, and the depth field overwritten by a later press.
  await app.intakeProject(project.id);
  app.stopAll();
  const t0 = Date.now() - 3 * 60 * 60_000;
  plantRound(app, project.id, { kind: 'First usable', startedAt: iso(t0), endedAt: iso(t0 + 60 * 60_000) });
  const deepenEnd = t0 + 2 * 60 * 60_000;
  plantRound(app, project.id, { kind: 'Deepen', label: 'Takeover round 2: deepening (Full)', startedAt: iso(t0 + 61 * 60_000), endedAt: iso(deepenEnd) });
  const at = iso(t0 + 60 * 60_000);
  store.notes.put({ id: 'note_takeover-depth', projectId: project.id, mount: { kind: 'project', ids: [] }, status: 'Current', ownerResponse: 'Decided', versions: [{ version: 1, at, title: 'How deep should the takeover of Tern go?', preview: '', body: { currentView: '', whyItMatters: '', facts: [], otherExplanations: null, keepAdjust: '', whatWouldSettleIt: '' }, ask: 'For your decision', judgementRecordId: 'jdg_x', reason: '' }], discussion: [], followUps: [], author: { agent: 'ProjectKeeper', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, language: 'en', updatedAt: at } as Note);
  app.updateProject({ ...P(), takeoverDepth: 'First picture only', organizeRhythm: 'Daily', lastRoundAt: iso(deepenEnd) });

  app.migrateTakeovers();
  assert.deepEqual([P().takeoverDepth, P().takeoverStartedAt], ['Full', iso(t0)], 'the depth that ran, and the start of its first round');
  assert.deepEqual([P().schedule?.frequency, P().schedule?.time, P().schedule?.savedAt], ['Every day', localTime(new Date(deepenEnd)), null], 'Daily → every day at the time its last round ended');
  assert.equal(store.notes.get('note_takeover-depth')!.status, 'Withdrawn', 'no note asks for the depth any more');
  writeClerkCoverage(app, project.id);
  const page = await keeperPageView(app, project.id);
  assert.deepEqual([page.state, page.page, page.takeover.phase, page.takeover.ran, page.daily.available], ['Daily', 'daily', 'Done', 'Full', true]);
  assert.ok(page.takeover.options.every((o) => !o.selectable), 'Full ran: every depth is disabled');
  assert.ok(page.takeover.briefing, 'the briefing is on the Takeover page');
  assert.deepEqual(page.takeover.rounds.map((r) => [r.kind, r.depth]), [['First usable', 'First picture only'], ['Deepen', 'Full']]);
  assert.ok(page.daily.nextAt, 'the next scheduled time is said');
  // Running it again changes nothing.
  const snapshot = JSON.stringify(P());
  app.migrateTakeovers();
  assert.equal(JSON.stringify(P()), snapshot);

  // `Continuous` stays; a project never started is left alone.
  const cont = app.addProject('Skua', [makeProject()]);
  plantRound(app, cont.id, { kind: 'First usable' });
  app.updateProject({ ...app.project(cont.id), organizeRhythm: 'Continuous' });
  const fresh = app.addProject('Gannet', [makeProject()]);
  app.migrateTakeovers();
  assert.equal(app.project(cont.id).schedule?.frequency, 'Continuous');
  assert.equal(app.project(cont.id).takeoverDepth, 'First picture only', 'the old depth question with no answer behaved as First picture only');
  assert.deepEqual([app.project(fresh.id).schedule ?? null, app.project(fresh.id).takeoverStartedAt ?? null], [null, null]);
  app.stopAll();
});
