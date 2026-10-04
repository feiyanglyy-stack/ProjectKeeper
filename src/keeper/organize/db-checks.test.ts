/**
 * DB, after the DeepSeek run of 2026-10-04 — what its main agent's briefs got wrong, as program checks:
 *   1. one definition of "unplaced": the program's counts are the workbench's own (`ui/placement.js`), so a Requirement on
 *      nothing or on the Product with no reason is counted, and a work item whose only plan has no band is in no plan,
 *      with that plan named (the run: the program said 0, the workbench showed 2 + 8);
 *   2. a slot no lane holds is listed back when a first usable round's lanes are sent, and is given to a lane or gets one
 *      line of why (the run: no lane held the Boundary slot, and the workbench held no boundary).
 * The readiness words (a brief's 「statusMap：ready→Planned」) are tested with the fill tools (fill-tools.test.ts).
 *
 * Two invented projects: **Orchard**, with the layers a planned project has (areas, plans, requirements, designs,
 * decisions, a boundary), and **Aviary**, shaped like a project with no contracts, a batch table and two-letter tickets
 * — where nothing new is asked beyond one line for a slot the project has nothing for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../../store/project-store.ts';
import type { KeeperJob, Project, ScopeItem } from '../../model/types.ts';
import type { ClerkRound, ClerkStage, RoundDoc, RoundKind } from '../../model/k-types.ts';
import { readFileSources } from '../../sources/files.ts';
import { clerkTools, type ClerkToolContext } from '../clerk-tools.ts';
import { keeperTools, type ToolContext } from '../tools.ts';
import { graphView } from '../../server/graph-view.ts';
import { standingReasons } from '../../process/breakpoint-candidates.ts';
import { deriveGraph } from './graph.ts';
import { laneTools, type LaneJobRequest, type LaneRunner } from './lane-tools.ts';
import { OPEN_KEYS, openCounts, roundOpen, unplacedNote } from './round-open.ts';
import { SKELETON_SLOTS, emptySlotsBlock, slotsUnheld } from './slots.ts';
import { stageTools } from './stage-tools.ts';
import { workbenchUnplaced } from './workbench-placement.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
const UI: any = await import(new URL('../../../ui/placement.js', import.meta.url).href);

const AT = '2026-10-04T08:00:00.000Z';

type Call = (name: string, args: Record<string, unknown>) => Promise<{ text: string; error: boolean; json: Record<string, unknown> }>;
function caller(tools: readonly { name: string; execute?: unknown }[]): Call {
  return async (name, args) => {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `no tool ${name}`);
    const run = tool.execute as (id: string, p: unknown, signal?: AbortSignal) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    let r: { content: { text: string }[]; isError?: boolean };
    try { r = await run('call', args); } catch (e) { return { text: (e as Error).message, error: true, json: {} }; }
    const text = r.content.map((c) => c.text).join('\n');
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* prose */ }
    return { text, error: r.isError === true, json };
  };
}

const round = (kind: RoundKind, stage: ClerkStage, patch: Partial<ClerkRound> = {}): ClerkRound => ({
  id: 'round_1', projectId: 'p1', kind, number: 1, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root',
  questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT,
  stage, stageLog: [{ stage, startedAt: AT, endedAt: null, timing: null }], lanes: [], ...patch,
});
const brief = (name: string): RoundDoc => ({ id: `rdoc_${name}`, projectId: 'p1', roundId: 'round_1', jobId: 'job_main', kind: 'Brief', path: name, title: `Brief: ${name}`, markdown: `Answer ${name}.`, at: AT });
const job = (id: string, patch: Partial<KeeperJob> = {}): KeeperJob => ({
  id, projectId: 'p1', kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['round_1'], label: id }, status: 'Queued', queuedAt: AT, startedAt: null, endedAt: null,
  savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null,
  requestBasis: null, parentJobId: 'job_main', resultText: null, priority: 0, task: { prompt: 'Task: a lane', extra: null }, step: null, ...patch,
} as KeeperJob);

/** A project with its documents on disk, scanned into sources; the main agent of a round, with a runtime double for its lanes. */
function workbench(name: string, docs: Record<string, string>, kind: RoundKind = 'First usable', stage: ClerkStage = 'skeleton') {
  const root = join(mkdtempSync(join(tmpdir(), 'pk-db-')), name.toLowerCase());
  for (const [rel, body] of Object.entries(docs)) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), body); }
  const scope: ScopeItem = { id: 'scope_main', path: root, category: 'Repository', relation: 'Main project', reason: 'Owner-given location', reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'none', missing: null, addedBy: 'owner' };
  const project = { id: 'p1', name, language: 'en', locations: [root], scope: [scope], scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false, createdAt: AT, lastOpenedAt: null, lastScopedAt: null, takeoverDepth: 'Full' } as unknown as Project;
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-db-store-')));
  for (const rel of Object.keys(docs)) {
    const path = join(root, rel);
    const st = statSync(path);
    for (const s of readFileSources('p1', { path, scopeItemId: 'scope_main', bytes: st.size, mtimeMs: st.mtimeMs }).sources) store.sources.put(s);
  }
  store.clerkRounds.put(round(kind, stage));
  const sent: string[] = [];
  let n = 0;
  const finish = (id: string): KeeperJob => { const j = { ...store.jobs.get(id)!, status: 'Done' as const, endedAt: AT, resultText: 'Done.' }; store.jobs.put(j); return j; };
  const runner: LaneRunner = {
    send(request: LaneJobRequest) {
      const j = job(`job_lane_${++n}`, { step: request.step, scope: { ...request.scope }, task: { prompt: request.prompt, extra: request.task } } as Partial<KeeperJob>);
      store.jobs.put(j);
      sent.push(String(request.step.path));
      return { job: j, ended: Promise.resolve().then(() => finish(j.id)) };
    },
    async again(jobId) { return finish(jobId); },
    async wait(jobId) { return finish(jobId); },
  };
  const ctx: ClerkToolContext = { store, project, jobId: 'job_main', jobKind: 'Organizing', model: null, step: { roundId: 'round_1', kind: 'main', path: null }, lanes: runner } as ClerkToolContext;
  const tools = [...keeperTools(ctx), ...clerkTools(ctx), ...laneTools(ctx as ToolContext), ...stageTools(ctx as ToolContext, { coverageSettled: () => true, stageSkill: (s) => `SKILL ${s}` })];
  const call = caller(tools);
  const must = async (tool: string, args: Record<string, unknown>) => { const r = await call(tool, args); assert.equal(r.error, false, `${tool} ${JSON.stringify(args).slice(0, 160)} → ${r.text}`); return r.json; };
  const open = () => roundOpen(store, store.clerkRounds.get('round_1')!, { limit: Infinity });
  /** A source of the project's documents, for the items written by hand. */
  const src = store.sources.all()[0]!.id;
  return { store, project, call, must, open, sent, root, src };
}

// ───────────────────────── 1 · one definition of "unplaced" ─────────────────────────

/** Orchard: two areas, a current plan and a deferred one, and requirements, a design, a decision and a boundary placed in every way. */
async function orchard() {
  const h = workbench('Orchard', { 'docs/PRD.md': '# Orchard PRD\n\nApples, picked and sorted.\n' }, 'First usable', 'reconcile');
  const ref = async (category: string, name: string, extra: Record<string, unknown> = {}) => String((await h.must('pk_write_reference', { category, name, text: name, basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [h.src], ...extra })).id);
  const product = await ref('Product', 'Orchard');
  const goal = await ref('Goal', 'G1 · Every apple reaches a crate', { refines: [product] });
  const picking = await ref('Area', 'OR-M1 · Picking', { refines: [goal] });
  const sorting = await ref('Area', 'OR-M2 · Sorting', { refines: [goal] });
  const season = await ref('Plan', 'S1 · This season', { ids: ['S1'] });
  const next = await ref('Plan', 'S2 · Next season', { ids: ['S2'], validity: 'Deferred' });
  const placed = await ref('Requirement', 'R-1 · A picker sees which trees are ripe', { ids: ['R-1'], refines: [picking] });
  const nowhere = await ref('Requirement', 'R-2 · The app works in the rain', { ids: ['R-2'] });
  const onProduct = await ref('Requirement', 'R-3 · One sign-in for every screen', { ids: ['R-3'], refines: [product] });
  const whole = await ref('Requirement', 'R-4 · Nothing is lost when the phone dies', { ids: ['R-4'], refines: [product], wholeProductWhy: 'It holds for every screen of the product, not for one module.' });
  const design = await ref('Design', 'Spec §3 · The ripeness map', {});
  const decision = await ref('Decision', 'D1 · Crates are counted, not weighed', { ids: ['D1'], refines: [product] });
  const boundary = await ref('Boundary', 'No selling: Orchard does not take orders', {});
  const work = async (id: string, title: string, serves: string[]) => String((await h.must('pk_write_thread', { title, ids: [id], progress: 'Planned', serves: serves.map((referenceId) => ({ referenceId, claim: 'the plan table lists it', basis: 'Explicit' })) })).id);
  const w1 = await work('OC-01', 'The ripeness map', [season, picking]);
  const w2 = await work('OC-02', 'Sorting by size', [next, sorting]);
  const w3 = await work('OC-03', 'A spare ladder', []);
  return { ...h, ids: { product, goal, picking, sorting, season, next, placed, nowhere, onProduct, whole, design, decision, boundary, w1, w2, w3 } };
}

test('the program counts what the workbench does not place: a requirement or a design on nothing or on the Product with no reason, and work whose only plan has no band, with that plan named', async () => {
  const h = await orchard();
  const open = h.open();
  // Requirements and designs are counted like decisions and boundaries.
  assert.deepEqual(open.requirements.unplaced.items.map((i) => [i.name, i.on]), [['R-2 · The app works in the rain', 'nothing'], ['R-3 · One sign-in for every screen', 'the Product only']]);
  assert.deepEqual(open.designs.unplaced.items.map((i) => [i.name, i.on]), [['Spec §3 · The ripeness map', 'nothing']]);
  assert.deepEqual(open.decisions.onNothing.items.map((i) => i.name), ['Boundary No selling: Orchard does not take orders']);
  assert.deepEqual(open.decisions.productOnly.items.map((i) => i.name), ['D1 · Crates are counted, not weighed']);
  // A plan the workbench draws no band for holds no work: its work is in no plan, and the plan is named.
  assert.deepEqual(open.workItems.noPlan.items.map((i) => [i.name, i.notCurrent ?? null]), [['OC-02 Sorting by size', ['S2 · Next season (Deferred)']], ['OC-03 A spare ladder', null]]);
  assert.deepEqual(open.workItems.noModule.items.map((i) => i.name), ['OC-03 A spare ladder']);
  const counts = openCounts(open);
  assert.deepEqual([counts.noPlan, counts.noModule, counts.requirementsUnplaced, counts.designsUnplaced, counts.onNothing, counts.productOnly], [2, 1, 2, 1, 1, 1]);
  assert.ok(OPEN_KEYS.requirementsUnplaced && /refine the Product and write wholeProductWhy/.test(OPEN_KEYS.requirementsUnplaced.what));

  // The same numbers the workbench draws from the graph view it is given.
  deriveGraph(h.store, h.project);
  const drawn = UI.placementOf(graphView(h.store, h.project));
  assert.deepEqual(drawn.unplaced, { workNoPlan: 2, workNoArea: 1, workWholePlan: 0, workWrittenNoPlan: 0, workWrittenNoArea: 0, workNeither: 1, intentProductOnly: { Requirement: 1, Decision: 1 }, intentNowhere: { Requirement: 1, Design: 1, Decision: 1 }, intent: 5 });
  assert.equal(counts.noPlan, drawn.unplaced.workNoPlan);
  assert.equal(counts.noModule, drawn.unplaced.workNoArea);
  assert.equal(counts.requirementsUnplaced! + counts.designsUnplaced! + counts.onNothing! + counts.productOnly!, drawn.unplaced.intent);
  assert.deepEqual(workbenchUnplaced(h.store).lists, UI.unplacedOf(drawn), 'the program reads the lists the workbench’s counts are the sizes of');
  assert.deepEqual(drawn.place.get(h.ids.w2).plansNotDrawn, [h.ids.next]);

  // The handover is told, like the other unplaced kinds; nothing is refused.
  const note = unplacedNote(open)!;
  assert.match(note, /2 work items in no plan \(1 of them serves only a plan the workbench draws no band for: S2 · Next season \(Deferred\)\)/);
  assert.match(note, /2 requirements placed on nothing or only on the Product with no reason/);
  assert.match(note, /1 design placed on nothing or only on the Product with no reason/);
  assert.match(note, /a decision, requirement or design that really concerns the whole product refines the Product and is written with its reason/);
  const handed = await h.call('pk_stage', { to: 'synthesis', handover: { settled: 'The lanes are joined.', open: 'Two requirements and a design are not placed yet.', first: 'The plan lane’s report.' } });
  assert.equal(handed.error, false, handed.text);
  assert.match(String(handed.json.note), /2 requirements placed on nothing or only on the Product with no reason/);
});

test('each is settled by a placement or by a recorded reason the program checks: wholeProductWhy on the Product, noPlanWhy beside a plan that has no band', async () => {
  const h = await orchard();
  // A requirement: its area, or the Product with its reason.
  await h.must('pk_write_reference', { id: h.ids.nowhere, refines: [h.ids.picking] });
  await h.must('pk_write_reference', { id: h.ids.onProduct, wholeProductWhy: 'Sign-in is one for the whole product.' });
  await h.must('pk_write_reference', { id: h.ids.design, refines: [h.ids.picking] });
  // A reason on a requirement that hangs on nothing places nothing: it still counts, as it does on the workbench.
  const loose = String((await h.must('pk_write_reference', { category: 'Requirement', name: 'R-5 · Works offline', text: 'Works offline', basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [h.src], wholeProductWhy: 'For the whole product.' })).id);
  assert.deepEqual(h.open().requirements.unplaced.items.map((i) => [i.id, i.on]), [[loose, 'nothing']]);
  await h.must('pk_write_reference', { id: loose, refines: [h.ids.product] });
  assert.equal(h.open().requirements.unplaced.count, 0);
  assert.equal(h.open().designs.unplaced.count, 0);

  // Work in a current plan takes no reason; work whose only plan has no band may stand by one, and the reason is checked.
  const inBand = await h.call('pk_write_thread', { id: h.ids.w1, noPlanWhy: 'No record places it.' });
  assert.equal(inBand.error, true);
  assert.match(inBand.text, /noPlanWhy says no record places this work item in a plan, and it is in S1/);
  await h.must('pk_write_thread', { id: h.ids.w2, noPlanWhy: 'Its only plan, S2, is deferred: the season plan table marks it as not started this year.' });
  const open = h.open();
  assert.deepEqual(open.workItems.noPlan.items.map((i) => i.name), ['OC-03 A spare ladder']);
  assert.deepEqual(open.workItems.noPlanWritten.items.map((i) => [i.name, i.why]), [['OC-02 Sorting by size', 'Its only plan, S2, is deferred: the season plan table marks it as not started this year.']]);
  assert.deepEqual(standingReasons(h.store).filter((r) => r.field === 'noPlanWhy').map((r) => r.id), [h.ids.w2], 'the spot-check is given that reason like any other');
  // Once the plan is in force, the work is in it, and the reason says nothing any more.
  await h.must('pk_write_reference', { id: h.ids.next, validity: 'Current' });
  assert.deepEqual(h.open().workItems.noPlanWritten.items, []);
  assert.deepEqual(standingReasons(h.store).filter((r) => r.field === 'noPlanWhy'), []);
  assert.deepEqual(h.open().workItems.noPlan.items.map((i) => i.name), ['OC-03 A spare ladder']);
});

test('the DeepSeek run’s shape: a draft plan an earlier generation holds has no band, so the work carried on under the same number that serves only it is in no plan, with the plan named', () => {
  const n = (id: string, category: string, extra: Record<string, unknown> = {}) => ({ id, category, label: id, validity: 'Current', areaId: null, ...extra });
  const serves = (from: string, to: string) => ({ type: 'serves', from, to });
  const data = {
    nodes: [
      n('m1', 'Area'), n('p1', 'Plan'), n('p4', 'Plan', { label: 'P4 · Pluggable (draft)', validity: 'Proposed' }),
      n('c1', 'Work item', { areaId: 'm1' }), n('c19', 'Work item', { areaId: 'm1', validity: 'Proposed' }), n('old', 'Work item', { areaId: 'm1' }),
    ],
    relations: [serves('c1', 'p1'), serves('c1', 'm1'), serves('c19', 'p4'), serves('c19', 'm1'), serves('old', 'p4'), serves('old', 'm1')],
    // The second generation lists the contracts; c1 and c19 went on under the same number, `old` did not.
    generations: [{ id: 'gen2', name: 'Chain v2', ended: { at: '2026-09-16' }, workIds: ['c1', 'c19', 'old'], carriedIds: ['c1', 'c19'], planIds: ['p4'] }],
  };
  const M = UI.placementOf(data);
  assert.deepEqual(M.plans.map((p: { id: string }) => p.id), ['p1'], 'the draft plan is the generation’s: no band of its own');
  assert.deepEqual([M.place.get('c1').band, M.place.get('old').zone], ['p1', 'gen']);
  assert.deepEqual([M.place.get('c19').band, M.place.get('c19').plansNotDrawn], [UI.NO_PLAN, ['p4']]);
  assert.deepEqual(UI.unplacedOf(M).workNoPlan, ['c19']);
  assert.equal(M.unplaced.workNoPlan, 1);
});

// ───────────────────────── 2 · a slot no lane holds ─────────────────────────

const L = (name: string, slots: string[]) => ({ name, kind: 'slot', briefDocId: `rdoc_${name}`, slots });
const DOCS = { 'docs/PRD.md': '# PRD\n\n## Goals\n\nOne.\n\n## Not included\n\nNo selling.\n' };

test('a first usable round’s lanes are sent once every slot is held by a lane or has its one line of why; the reasons are kept on the round and shown to the spot-check', async () => {
  const h = workbench('Orchard', DOCS);
  for (const n of ['product', 'docs', 'plan', 'records', 'code']) h.store.roundDocs.put(brief(n));
  // The DeepSeek run's lanes: every slot but Boundary.
  const lanes = [
    L('product', ['reference:Owner’s words', 'reference:Product', 'reference:Goal', 'reference:Area']), L('docs', ['reference:Requirement', 'reference:Design', 'reference:Decision']),
    L('plan', ['reference:Plan', 'threads', 'generations', 'relations']), L('records', ['threads', 'links']), L('code', ['territories']),
  ];
  const first = await h.call('pk_send_lanes', { lanes });
  assert.equal(first.error, true);
  assert.match(first.text, /^ERROR: No lane was sent yet\. The skeleton fills every slot of the workbench, and this slot is held by no lane of this call:\n- reference:Boundary — what the product does not include: non-goals, out of scope, limits it states\n/);
  assert.match(first.text, /add the slot to the lane that reads it[\s\S]*empty: \[\{ slot, why \}\], one line each[\s\S]*nothing more is asked/);
  assert.deepEqual(h.sent, [], 'nothing was sent');
  assert.deepEqual(h.store.clerkRounds.get('round_1')!.lanes, []);

  // Given to the lane that reads the section: sent, and nothing is recorded.
  const given = await h.call('pk_send_lanes', { lanes: lanes.map((l) => (l.name === 'docs' ? { ...l, slots: [...l.slots, 'reference:Boundary'] } : l)) });
  assert.equal(given.error, false, given.text);
  assert.deepEqual(h.sent, ['product', 'docs', 'plan', 'records', 'code']);
  assert.equal(h.store.clerkRounds.get('round_1')!.emptySlots, undefined);
  assert.equal(emptySlotsBlock(h.store, { id: 'round_2' }), null);
});

test('a slot the project has nothing for is said so in one line; an unknown slot or an empty reason sends nothing; a reason for a held slot is not recorded; other rounds are not asked', async () => {
  const h = workbench('Orchard', DOCS);
  for (const n of ['product', 'work', 'more']) h.store.roundDocs.put(brief(n));
  const lanes = [L('product', ['reference:Owner’s words', 'reference:Product', 'reference:Area']), L('work', ['reference:Plan', 'threads', 'links'])];
  const unheld = slotsUnheld(lanes.flatMap((l) => l.slots), []).map((u) => u.slot);
  assert.deepEqual(unheld, ['reference:Goal', 'reference:Requirement', 'reference:Design', 'reference:Decision', 'reference:Boundary', 'territories', 'generations']);
  const refused = await h.call('pk_send_lanes', { lanes });
  assert.match(refused.text, /these 7 slots are held by no lane of this call/);
  for (const slot of unheld) assert.ok(refused.text.includes(`- ${slot} — `), slot);

  const why = (slot: string) => `The project has no ${slot.replace('reference:', '').toLowerCase()} material: one PRD page and a ticket list.`;
  const bad = await h.call('pk_send_lanes', { lanes, empty: [{ slot: 'reference:Roadmap', why: 'none' }, { slot: 'reference:Goal', why: '  ' }] });
  assert.equal(bad.error, true);
  assert.match(bad.text, /empty\[0\]: reference:Roadmap is not a slot the skeleton fills/);
  assert.match(bad.text, /empty\[1\] \(reference:Goal\): say in one line why the project has nothing for it/);
  // Some reasons, not all: the rest is listed back, and nothing is sent or recorded yet.
  const part = await h.call('pk_send_lanes', { lanes, empty: unheld.slice(0, 5).map((slot) => ({ slot, why: why(slot) })) });
  assert.match(part.text, /these 2 slots are held by no lane of this call:\n- territories — the code as it stands, by area\n- generations — /);
  assert.deepEqual(h.sent, []);

  // Every slot accounted for — and a reason for a slot a lane holds is set aside, with a note.
  const ok = await h.call('pk_send_lanes', { lanes, empty: [...unheld.map((slot) => ({ slot, why: why(slot) })), { slot: 'threads', why: 'No work.' }] });
  assert.equal(ok.error, false, ok.text);
  assert.deepEqual(h.sent, ['product', 'work']);
  assert.match(String((ok.json as unknown as { name: string; note?: string }[]).find((l) => l.name === 'work')!.note), /threads is held by this lane, so its reason in empty was not recorded/);
  const kept = h.store.clerkRounds.get('round_1')!.emptySlots!;
  assert.deepEqual(kept.map((e) => [e.slot, e.why]), unheld.map((slot) => [slot, why(slot)]));
  // The same call again — after a restart — waits for its lanes and asks nothing; a later lane that takes a slot takes its reason away.
  const again = await h.call('pk_send_lanes', { lanes });
  assert.equal(again.error, false, again.text);
  const more = await h.call('pk_send_lanes', { lanes: [L('more', ['reference:Goal'])] });
  assert.equal(more.error, false, more.text);
  assert.deepEqual(h.store.clerkRounds.get('round_1')!.emptySlots!.map((e) => e.slot), unheld.filter((s) => s !== 'reference:Goal'));

  // The main agent can list them; the next spot-check is shown the ones that still hold nothing, until a spot-check has seen them.
  const listed = await h.call('pk_round_state', { list: 'emptySlots' });
  assert.deepEqual((listed.json.items as { slot: string; holdsNow: boolean; round: string }[]).map((i) => [i.slot, i.holdsNow, i.round])[0], ['reference:Requirement', false, 'First usable round 1']);
  await h.must('pk_write_reference', { category: 'Decision', name: 'D1 · Crates are counted', text: 'Crates are counted.', basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [h.src] });
  const block = emptySlotsBlock(h.store, { id: 'round_2' })!;
  assert.match(block, /^=== Slots no lane held \(5; the main agent’s reasons, which the program does not check\)/);
  assert.match(block, /- reference:Boundary \(what the product does not include: non-goals, out of scope, limits it states\) · First usable round 1: “The project has no boundary material: one PRD page and a ticket list\.”/);
  assert.doesNotMatch(block, /reference:Decision/, 'a slot that holds something now is not a standing reason');
  h.store.jobs.put(job('job_spot', { queuedAt: '2026-10-05T00:00:00.000Z', step: { roundId: 'round_2', kind: 'spot-check', path: null } } as Partial<KeeperJob>));
  assert.match(String(emptySlotsBlock(h.store, { id: 'round_2' })), /Slots no lane held/, 'the spot-check of the round it is shown to still has it when started again');
  assert.equal(emptySlotsBlock(h.store, { id: 'round_3' }), null, 'and the round after it is not shown them again');

  // A deepening's lanes, and a Follow up's, are sent by question: no slot is asked for.
  for (const [kind, stage] of [['Deepen', 'dig'], ['Follow up', 'skeleton']] as const) {
    const d = workbench('Orchard', DOCS, kind, stage);
    d.store.roundDocs.put(brief('one'));
    const sent = await d.call('pk_send_lanes', { lanes: [{ ...L('one', ['threads']), kind: kind === 'Deepen' ? 'plan' : 'slot' }] });
    assert.equal(sent.error, false, `${kind}: ${sent.text}`);
  }
  assert.equal(SKELETON_SLOTS.length, 13, 'the nine reference categories, work items, links, territories, generations');
});

// ───────────────────────── 3 · a project without the layers ─────────────────────────

const AVIARY = {
  'docs/PRODUCT.md': ['# Aviary', '', 'A phone app that keeps a list of the birds a walker sees.', '', '## Modules', '', '### Sightings', '', 'One row per bird seen.', '', '### Maps', '', 'Where each was seen.', ''].join('\n'),
  'docs/DESIGN.md': ['# Design notes', '', '## 9 批次', '', '| 批次 | 内容 | 状态 |', '| --- | --- | --- |', '| 批次 1 | 记录底座 | 完成 |', '| 批次 2 | 地图 | 进行中 |', '| 批次 3 | 分享 | 未开始 |', ''].join('\n'),
  'subagent/INDEX.md': ['# Index', '', '| ID | Title | Batch | Status |', '| --- | --- | --- | --- |', '| AA | The sightings table | 批次 1 | done |', '| AB | Offline save | 批次 1 | done |', '| AC | Map tiles | 批次 2 | running |', '| AD | Share a list | 批次 3 | queued |', ''].join('\n'),
};

test('a project with no contracts, a batch table and two-letter tickets: nothing new is asked beyond one line for each slot it has nothing for', async () => {
  const h = workbench('Aviary', AVIARY);
  await h.must('pk_write_reference', { category: 'Product', name: 'Aviary', text: 'A list of the birds a walker sees.', basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [h.src] });
  // The batch table and the ticket index state progress in their own words: the mappings are taken, nothing is refused,
  // and no row is handed back to judge.
  const batches = await h.must('pk_fill_from_table', { path: 'docs/DESIGN.md', table: { heading: '批次' }, into: 'reference', category: 'Plan', columns: { title: '内容', id: '批次', status: '状态' }, statusMap: { 完成: 'Done', 进行中: 'In progress', 未开始: 'Planned' } });
  assert.deepEqual([batches.written, 'refused' in batches, 'progressToJudge' in batches], [3, false, false]);
  const tickets = await h.must('pk_fill_from_table', { path: 'subagent/INDEX.md', into: 'threads', columns: { title: 'Title', id: 'ID', plan: 'Batch', status: 'Status' }, statusMap: { done: 'Done', running: 'In progress', queued: 'Planned' } });
  assert.deepEqual([tickets.written, 'refused' in tickets, 'progressToJudge' in tickets, 'unlinked' in tickets], [4, false, false, false]);
  assert.deepEqual(h.store.threads.all().map((t) => [t.ids[0], t.progress]).sort(), [['AA', 'Done'], ['AB', 'Done'], ['AC', 'In progress'], ['AD', 'Planned']]);

  // Its lanes hold what it has; the slots it has nothing for cost one line each, and that is all.
  for (const n of ['product', 'tickets', 'code']) h.store.roundDocs.put(brief(n));
  const lanes = [L('product', ['reference:Owner’s words', 'reference:Product', 'reference:Area']), L('tickets', ['reference:Plan', 'threads', 'links']), L('code', ['territories'])];
  const listed = await h.call('pk_send_lanes', { lanes });
  assert.match(listed.text, /these 6 slots are held by no lane of this call/);
  const empty = [
    { slot: 'reference:Goal', why: 'No document states goals: PRODUCT.md is one paragraph and a module list.' },
    { slot: 'reference:Requirement', why: 'There is no requirements document and no contract; the tickets are the only statement of what is built.' },
    { slot: 'reference:Design', why: 'DESIGN.md holds only the batch table.' },
    { slot: 'reference:Decision', why: 'The project keeps no decision record.' },
    { slot: 'reference:Boundary', why: 'No document says what the product leaves out.' },
    { slot: 'generations', why: 'Nothing is archived or superseded: one plan table, never replaced.' },
  ];
  const sent = await h.call('pk_send_lanes', { lanes, empty });
  assert.equal(sent.error, false, sent.text);
  assert.deepEqual(h.sent, ['product', 'tickets', 'code']);
  assert.equal(h.store.clerkRounds.get('round_1')!.emptySlots!.length, 6);

  // The counts DB added stay at zero on a project without those layers, and every ticket stands in its batch's band.
  const open = h.open();
  const counts = openCounts(open);
  assert.deepEqual([counts.requirementsUnplaced, counts.designsUnplaced, counts.onNothing, counts.productOnly, counts.noPlan], [0, 0, 0, 0, 0]);
  assert.equal(open.workItems.noPlan.items.some((i) => i.notCurrent), false);
  assert.equal(open.tickets.noContract.notApplicable !== undefined, true, 'no contract layer: no ticket is missing its contract');
  const note = unplacedNote(open) ?? '';
  assert.doesNotMatch(note, /requirement|design|draws no band/);
});
