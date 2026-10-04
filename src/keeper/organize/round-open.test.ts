/**
 * What a round leaves open, and the gates on it (CD; Spec §2.12, §3.3; CKC-23 AC-21, AC-22), from the first D99
 * deepening of ContextKeeper, where 55 candidates stayed with no result, 44 work items had no plan, 192 decisions were
 * placed on no module and the earlier generations had no items:
 *   - `pk_round_state` lists, under `open`, the candidates with no result (with the briefs that name each), the work items
 *     in no plan and in no module, the decisions placed on nothing or only on the Product, and the generations with no
 *     items;
 *   - `pk_stage` into the synthesis of a `Full` deepening refuses while a candidate has no result, unless the main agent
 *     says why; a Focused deepening and the other kinds of round are not held;
 *   - entering the synthesis, every round is told what is still unplaced, and nothing is refused on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../../store/project-store.ts';
import type { Project, ReferenceItem, WorkThread } from '../../model/types.ts';
import type { Breakpoint, ClerkRound, ClerkStage, EvidenceRef, Generation, RoundDoc, RoundKind } from '../../model/k-types.ts';
import type { ToolContext } from '../tools.ts';
import { stageTools } from './stage-tools.ts';
import { roundOpen, unplacedNote } from './round-open.ts';

const P = 'p1';
const AT = '2026-09-30T10:00:00.000Z';
const LATER = '2026-09-30T11:00:00.000Z';
const project = { id: P, name: 'Kiln', language: 'en', locations: [tmpdir()], scope: [], scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false, createdAt: AT, lastOpenedAt: null, lastScopedAt: null, takeoverDepth: 'Full' } as unknown as Project;
const ev: EvidenceRef = { kind: 'object', id: 'x', label: 'x' };
const occurred = { at: '2026-09-29', basis: 'Commit' as const, anchor: null };

const ref = (id: string, category: ReferenceItem['category'], name: string, refines: string[] = [], ids: string[] = []): ReferenceItem => ({
  id, projectId: P, category, name, ids, text: name, quote: null, basis: 'Explicit', validity: 'Current', progress: null,
  attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' },
  sourceIds: [], refines, replacedBy: null, updatedAt: AT,
} as unknown as ReferenceItem);
const thread = (id: string, num: string, title: string, serves: string[] = [], validity = 'Current'): WorkThread => ({
  id, projectId: P, title, ids: [num], doing: '', changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [],
  serves: serves.map((referenceId) => ({ referenceId, claim: 'the dispatch table lists it', basis: 'Explicit' })), dependsOn: [], progress: 'Done', validity, replacedBy: null,
  attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, inputs: null, asOf: AT, updatedAt: AT, pendingSourceIds: [],
} as unknown as WorkThread);
const bp = (id: string, targetId: string, patch: Partial<Breakpoint> = {}): Breakpoint => ({
  id, projectId: P, kind: 'No trace of done', targetId, why: 'Reported done; no commit carries its number', evidence: [ev], basis: 'Inferred', since: occurred,
  lit: false, out: null, ownerResponse: null, looked: null, checked: null, confirmedInRoundId: null, sixThing: null, sendBackId: null, roundId: null, updatedAt: AT, ...patch,
});
const gen = (id: string, name: string, workIds: string[]): Generation => ({ id, projectId: P, name, started: null, ended: occurred as unknown as Generation['ended'], endedBy: ev, planRefs: [ev], workIds, roundId: null, updatedAt: AT });
const brief = (id: string, path: string, markdown: string): RoundDoc => ({ id, projectId: P, roundId: 'round_1', jobId: 'job_main', kind: 'Brief', path, title: `Brief: ${path}`, markdown, at: AT });

function round(kind: RoundKind, stage: ClerkStage): ClerkRound {
  return {
    id: 'round_1', projectId: P, kind, number: 2, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root',
    questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT,
    stage, stageLog: [{ stage: 'dig', startedAt: AT, endedAt: AT, timing: null }, { stage, startedAt: AT, endedAt: null, timing: null }],
    lanes: [
      { name: 'plan K', kind: 'plan', slots: ['threads', 'links'], briefDocId: 'rdoc_k', jobId: 'job_k', stage: 'dig', sentAt: AT, reportDocId: null },
      { name: 'decisions', kind: 'topic', slots: ['reference:Decision'], briefDocId: 'rdoc_d', jobId: 'job_d', stage: 'dig', sentAt: AT, reportDocId: null },
    ],
  } as ClerkRound;
}

/** A workbench as the first D99 deepening left it, in small: open candidates, dispatch tickets with no plan, decisions on nothing. */
function workbench(kind: RoundKind = 'Deepen', stage: ClerkStage = 'cross-check', depth: 'Full' | 'Focused' = 'Full') {
  const store = ProjectStore.open(P, mkdtempSync(join(tmpdir(), 'pk-round-open-')));
  for (const r of [
    ref('ref_product', 'Product', 'Kiln'), ref('ref_goal', 'Goal', 'Fired pots', ['ref_product']),
    ref('ref_area', 'Area', 'Kiln module', ['ref_goal'], ['CK-M2']), ref('ref_plan', 'Plan', 'Increment K', ['ref_product'], ['K']),
    ref('ref_req', 'Requirement', 'CKC-23 the clerk method', ['ref_area'], ['CKC-23']),
    ref('ref_d_placed', 'Decision', 'D99 skills per stage', ['ref_req'], ['D99']),
    ref('ref_e_placed', 'Decision', 'E148 how K ran', ['ref_plan'], ['E148']),
    ref('ref_d_product', 'Decision', 'D92 living documents', ['ref_product'], ['D92']),
    ref('ref_e_nothing', 'Decision', 'E140 unnumbered fixes fold in', [], ['E140']),
    ref('ref_d_nothing', 'Decision', 'D96 the workbench as a map', [], ['D96']),
  ]) store.reference.put(r);
  store.threads.put(thread('thr_placed', 'CKC-23', 'The clerk method', ['ref_area', 'ref_plan']));
  store.threads.put(thread('thr_ticket', 'BN', 'Nested repositories stay out', []));
  store.threads.put(thread('thr_area_only', 'BM', 'Code references', ['ref_area']));
  store.threads.put(thread('thr_old', 'B3', 'An earlier batch', ['ref_area']));
  store.threads.put(thread('thr_merged', 'BN2', 'A duplicate', [], 'Replaced'));
  // A decision placed through a relation written directly (pk_relate) is placed too.
  store.relations.put({ id: 'rel_1', projectId: P, type: 'refines', from: 'ref_d_nothing', to: 'ref_area', claim: 'D96 changes the module', basis: 'Explicit', evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: AT });
  store.generations.put(gen('gen_v1', 'Module v0.1–v0.3', ['thr_old']));
  // The earlier batch has its destination: the current contract depends on it (CM: every item of a generation has one).
  store.threads.put({ ...store.threads.get('thr_placed')!, dependsOn: [{ threadId: 'thr_old', claim: 'built on the earlier batch', basis: 'Explicit' }] });
  store.generations.put(gen('gen_v2', 'Document chain v2.0–v3.x', []));
  store.breakpoints.put(bp('bp_ticket', 'thr_ticket'));
  store.breakpoints.put(bp('bp_area', 'thr_area_only'));
  store.breakpoints.put(bp('bp_looked', 'thr_placed', { looked: { roundId: 'round_1', jobId: 'job_k', where: ['subagent/execution-plan-k.md §3'], at: AT } }));
  store.breakpoints.put(bp('bp_out', 'thr_placed', { out: { at: AT, by: 'evidence', evidence: [ev] } }));
  store.breakpoints.put(bp('bp_lit', 'thr_placed', { lit: true, looked: { roundId: 'round_1', jobId: 'job_k', where: ['x'], at: AT }, checked: { roundId: 'round_1', jobId: 'job_spot', at: AT } }));
  store.roundDocs.put(brief('rdoc_k', 'plan K', '# Brief\n\nCandidates you own: bp_ticket (No trace of done on BN), bp_looked.'));
  store.roundDocs.put(brief('rdoc_d', 'decisions', '# Brief\n\nThe decision record.'));
  store.clerkRounds.put(round(kind, stage));
  const ctx: ToolContext = {
    store, project: { ...project, takeoverDepth: depth } as Project, jobId: 'job_main', jobKind: 'Organizing', model: null, step: { roundId: 'round_1', kind: 'main', path: null },
    stageEntered: () => ({ note: null }),
  } as unknown as ToolContext;
  const tools = stageTools(ctx, { coverageSettled: () => true, stageSkill: (s) => `SKILL ${s}` });
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name)!;
    const r = await (tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)('call', args);
    const text = r.content.map((c) => c.text).join('\n');
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* prose */ }
    return { text, error: r.isError === true, json };
  };
  return { store, call };
}

const ids = (list: { items: readonly { id: string }[] }) => list.items.map((i) => i.id).sort();

test('what is open: candidates with no result and the briefs that name them, work items in no plan or module, decisions on nothing or only the Product, generations with no items', () => {
  const { store } = workbench();
  const open = roundOpen(store, store.clerkRounds.get('round_1')!);
  // Looked for, put out and lit are results; the rest have none. A brief names bp_ticket; none names bp_area.
  assert.deepEqual(ids(open.candidates), ['bp_area', 'bp_ticket']);
  assert.deepEqual(open.candidates.items.map((c) => [c.id, c.briefs]), [['bp_area', []], ['bp_ticket', ['plan K']]]);
  assert.match(open.candidates.items.find((c) => c.id === 'bp_ticket')!.target, /^BN Nested repositories stay out \(thr_ticket\)$/);
  // A ticket serving nothing is in no plan and no module; one serving only its Area is in no plan; a work item an earlier
  // generation lists is in that generation's plan; a replaced one is not counted.
  assert.deepEqual(ids(open.workItems.noPlan), ['thr_area_only', 'thr_ticket']);
  assert.deepEqual(ids(open.workItems.noModule), ['thr_ticket']);
  // D99 reaches its module through its contract, E148 its plan, D96 its module through a relation written directly; D92
  // refines only the Product; E140 refines nothing.
  assert.deepEqual(ids(open.decisions.onNothing), ['ref_e_nothing']);
  assert.deepEqual(ids(open.decisions.productOnly), ['ref_d_product']);
  assert.deepEqual(ids(open.generations.withoutItems), ['gen_v2']);
  const note = unplacedNote(open)!;
  assert.match(note, /2 work items in no plan; 1 work item in no module; 1 decision placed on nothing; 1 decision placed only on the Product; 1 earlier generation with no planned item recorded/);
});

test('pk_round_state counts what is open, and counts the candidates with no result', async () => {
  const { call } = workbench();
  const state = await call('pk_round_state', {});
  assert.equal(state.error, false, state.text);
  const open = state.json.open as Record<string, number>;
  assert.ok(Object.values(open).every((n) => typeof n === 'number'), 'counts only (CM): a list comes in full when asked for by its key');
  assert.deepEqual([open.candidates, open.noPlan, open.noModule, open.onNothing, open.productOnly, open.generationsWithoutItems], [2, 2, 1, 1, 1, 1]);
  assert.equal((state.json.breakpoints as { withoutResult: number }).withoutResult, 2);
  assert.equal(state.json.changed, undefined, 'the first call has nothing to compare with');
});

test('pk_round_state gives one list in full by its key, paged, and what changed since the last call (CM)', async () => {
  const { store, call } = workbench();
  const listed = await call('pk_round_state', { list: 'noPlan' });
  assert.equal(listed.error, false, listed.text);
  assert.deepEqual([listed.json.list, listed.json.count, (listed.json.items as { id: string }[]).map((i) => i.id).sort()], ['noPlan', 2, ['thr_area_only', 'thr_ticket']]);
  const page = await call('pk_round_state', { list: 'noPlan', limit: 1 });
  assert.deepEqual([(page.json.items as unknown[]).length, page.json.next], [1, 1]);
  assert.match((await call('pk_round_state', { list: 'nothing' })).text, /nothing is not a list of pk_round_state; the keys are candidates, noPlan/);
  await call('pk_round_state', {});
  assert.equal((await call('pk_round_state', {})).json.changed, 'nothing since your last call');
  // The ticket finds its plan: the next call says the noPlan list lost it, and nothing else.
  store.threads.put({ ...store.threads.get('thr_ticket')!, validity: 'Replaced' });
  const after = await call('pk_round_state', {});
  const changed = after.json.changed as Record<string, { before: number; now: number; gone?: string[] }>;
  assert.deepEqual([changed.noPlan!.before, changed.noPlan!.now], [2, 1]);
  assert.match(changed.noPlan!.gone!.join(), /BN Nested repositories stay out/);
});

test('a write that answers a candidate is its result before the program puts it out: the link of the step it misses, a carry-out, a downstream item superseded', async () => {
  const { store, call } = workbench('Deepen', 'coverage');
  const link = (id: string, workId: string, stepKind: string, roundId: string | null, confirmed = false) => store.links.put({ id, projectId: P, workId, ledgerRef: 'commit:abc', stepKind: stepKind as never, why: 'the dispatch table names its merge', basis: 'Inferred', confirmed, roundId, jobId: 'job_k', at: LATER });
  // A check is not the delivery a No trace of done misses; an unconfirmed link of an earlier round is no result now.
  link('link_qc', 'thr_ticket', 'QC', 'round_1');
  link('link_old', 'thr_area_only', 'Delivered', 'round_0');
  assert.deepEqual(ids(roundOpen(store, store.clerkRounds.get('round_1')!).candidates), ['bp_area', 'bp_ticket']);
  // The plan lane links BN's delivery in this round: that is its result, until the cross-check confirms it and the next
  // recompute puts the candidate out.
  link('link_bn', 'thr_ticket', 'Delivered', 'round_1');
  assert.deepEqual(ids(roundOpen(store, store.clerkRounds.get('round_1')!).candidates), ['bp_area']);
  const state = await call('pk_round_state', {});
  assert.deepEqual([(state.json.breakpoints as { answered: number }).answered, (state.json.breakpoints as { withoutResult: number }).withoutResult], [1, 1]);
  // A decision recorded as carried out answers its Not carried out; a downstream item marked Replaced its Downstream behind.
  store.breakpoints.put(bp('bp_carry', 'ref_e_nothing', { kind: 'Not carried out' }));
  store.breakpoints.put(bp('bp_down', 'ref_d_product', { kind: 'Downstream behind' }));
  assert.deepEqual(ids(roundOpen(store, store.clerkRounds.get('round_1')!).candidates), ['bp_area', 'bp_carry', 'bp_down']);
  store.reference.put({ ...store.reference.get('ref_e_nothing')!, carryOut: { status: 'Carried out' } } as unknown as ReferenceItem);
  store.reference.put({ ...store.reference.get('ref_d_product')!, validity: 'Replaced', replacedBy: 'ref_d_placed' });
  assert.deepEqual(ids(roundOpen(store, store.clerkRounds.get('round_1')!).candidates), ['bp_area']);
});

/** The main agent's handover to the synthesis (D103): required once the gates pass. */
const HANDOVER = { settled: 'What the lanes brought back is joined and placed.', open: 'What no record places stays unplaced.', first: 'The lane reports.' };

test('a Full deepening hands over to the synthesis only once every candidate has a result, or with why; the unplaced counts come back as a note and refuse nothing', async () => {
  const { store, call } = workbench();
  const refused = await call('pk_stage', { to: 'synthesis' });
  assert.equal(refused.error, true);
  assert.match(refused.text, /2 candidates have no result yet: bp_area \(No trace of done\), bp_ticket \(No trace of done\)/);
  assert.match(refused.text, /pk_record_looked/);
  assert.equal(store.clerkRounds.get('round_1')!.stage, 'cross-check', 'nothing changed');

  // The cross-check puts one out on its evidence; a lane had looked for the other: every candidate has a result.
  store.breakpoints.put(bp('bp_area', 'thr_area_only', { out: { at: LATER, by: 'model', evidence: [ev] } }));
  store.breakpoints.put(bp('bp_ticket', 'thr_ticket', { looked: { roundId: 'round_1', jobId: 'job_k', where: ['subagent/INDEX.md', 'the trunk: no commit names BN'], at: LATER } }));
  // The gates pass; the handover is still required, and the refusal says what stays unplaced, for the handover to say why.
  const bare = await call('pk_stage', { to: 'synthesis' });
  assert.ok(bare.error && /The gates are passed\. Handing over to the synthesis needs your handover/.test(bare.text), bare.text);
  assert.match(bare.text, /=== Unplaced on the workbench\n2 work items in no plan[\s\S]*say in your handover \(open\) which stay unplaced and why/);
  assert.equal(store.clerkRounds.get('round_1')!.handover ?? null, null, 'nothing changed');
  const moved = await call('pk_stage', { to: 'synthesis', handover: HANDOVER });
  assert.equal(moved.error, false, moved.text);
  assert.equal(moved.json.handedOver, true);
  assert.equal(store.clerkRounds.get('round_1')!.stage, 'cross-check', 'the main agent\'s stage stays its last one');
  // What is still unplaced comes back with the handover, counted; the round was handed over all the same.
  assert.match(String(moved.json.note), /=== Unplaced on the workbench\n2 work items in no plan; 1 work item in no module; 1 decision placed on nothing; 1 decision placed only on the Product; 1 earlier generation with no planned item recorded/);
});

test('with why, a Full deepening hands over with candidates left, and the why is kept on the handover', async () => {
  const { store, call } = workbench();
  const why = 'bp_area and bp_ticket: the dispatch records are in D:\\sealed, put away; the next Follow up takes them up';
  const moved = await call('pk_stage', { to: 'synthesis', why, handover: HANDOVER });
  assert.equal(moved.error, false, moved.text);
  const round = store.clerkRounds.get('round_1')!;
  assert.equal(round.handover!.why, why);
  assert.ok(store.roundDocs.get(round.handover!.docId)!.markdown.includes(why), 'and the synthesis reads it in the handover');
});

test('a Focused deepening, a Follow up and a First usable round are not held by open candidates, and are told what is unplaced', async () => {
  for (const [kind, stage, depth] of [['Deepen', 'cross-check', 'Focused'], ['Follow up', 'cross-check', 'Full'], ['First usable', 'reconcile', 'Full']] as const) {
    const { call } = workbench(kind, stage, depth);
    const moved = await call('pk_stage', { to: 'synthesis', handover: HANDOVER });
    assert.equal(moved.error, false, `${kind} ${depth}: ${moved.text}`);
    assert.match(String(moved.json.note), /Unplaced on the workbench/, `${kind}: the note`);
  }
});

test('nothing unplaced, no note', async () => {
  const store = ProjectStore.open(P, mkdtempSync(join(tmpdir(), 'pk-round-open-empty-')));
  const open = roundOpen(store, round('Deepen', 'cross-check'));
  assert.equal(unplacedNote(open), null);
  assert.deepEqual([open.candidates.count, open.workItems.noPlan.count, open.decisions.onNothing.count], [0, 0, 0]);
});
