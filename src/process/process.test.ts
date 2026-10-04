/**
 * The process engine (Spec v3.0 §2.12, §1.18, §2.13 rows 1–5; CKC-24 AC-1…AC-3, AC-6…AC-8, AC-10, AC-12; CKC-27 AC-6,
 * AC-11) over "Harbor", an invented project with an orchestrator's `subagent/` folder (fixture.test-helpers.ts):
 *
 * - a work item's process in the order it happened: delivered without a receipt, sent back by the host, fixed, merged,
 *   checked independently (fail, findings counted), fixed again — every step with what reality gave;
 * - the four things: execution, progress, the latest check and who made it (a self-report is never a check), what is open;
 * - a plan's execution shape: batches in the order they ran, which ran in parallel, their merge commits, and the sentence
 *   saying where the actual order differs from the plan;
 * - all eleven breakpoint kinds, each on the object §2.12 names, only where the project's rules expect the step; put out
 *   by later evidence; the owner's `No action needed` kept and never lit again; a model's refutation and confirmation kept;
 * - send-backs recorded from failed checks and reviews, and moved on `Suggested → Returned → Closed` by what came later.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Breakpoint, SendBack } from '../model/k-types.ts';
import type { LedgerService } from '../ledger/adapters.ts';
import { respondToBreakpoint, processView } from '../server/k-views.ts';
import { buildHarbor, commit, stage2, rule, thread, write, source, reference, type Harbor } from './fixture.test-helpers.ts';
import { advanceSendBacks, analyze, computeBreakpoints, plan, processBlock, processEngines, processRunner, runProcess, stepOf, work } from './index.ts';
import { breakpointId, computeFindings, isCandidate, reconcile } from './breakpoints.ts';
import { spotCheckTargets, unlightUnchecked } from './breakpoint-candidates.ts';
import { linkPutOutDeliveries } from './delivery-links.ts';
import { lineageView } from '../ledger/views.ts';
import { breakpointBrief } from '../context/k-briefs.ts';

const h: Harbor = buildHarbor();
/** The breakpoint record of a kind on an object: since D99 a candidate until a lane looked and the spot-check lit it. */
const lit = (kind: Breakpoint['kind'], target: string): Breakpoint | undefined => h.store.breakpoints.get(breakpointId('harbor', kind, target));
const candidateKinds = () => h.store.breakpoints.filter(isCandidate).map((b) => `${b.kind} · ${b.targetId}`).sort();
const stateOf = (b: Breakpoint | undefined): string => (!b ? 'none' : b.lit ? 'Lit' : b.out ? `Out (${b.out.by})` : 'Candidate');
/** What the round's spot-check leaves on a candidate it lit (pk_confirm; breakpoint-candidates.ts). */
const litByCheck = (b: Breakpoint, roundId = 'crd_1'): Breakpoint => ({
  ...b, lit: true, looked: { roundId, jobId: 'job_lane', where: ['subagent/execution-plan.md §5'], at: '2026-09-29T00:00:00Z' },
  checked: { roundId, jobId: 'job_spot', at: '2026-09-29T01:00:00Z' }, confirmedInRoundId: roundId, roundId,
});

// ───────────────────────── the process of one piece of work ─────────────────────────

test('a work item’s process: delivered without a receipt, sent back by the host, fixed, merged, QC fail with its findings counted, fixed again — in the order it happened', () => {
  const w = work(h.store, h.project, h.ledger, 'thr_AB')!;
  assert.deepEqual(w.steps.map((s) => s.kind), ['Dispatched', 'Delivered', 'Review', 'Fix', 'Merged', 'QC', 'Fix'], 'every step the project has, and no other');
  assert.deepEqual(w.steps.map((s) => s.unit), ['AB', 'AB', 'AB', 'AC', 'AB', 'AD', 'AE'], 'each step names the task that made it: AC for the fix, AD for the QC');
  const [dispatched, delivered, review, fixAC, merged, qc, fixAE] = w.steps;
  assert.match(dispatched!.result, /to kimi/);
  assert.match(delivered!.result, /2 commits .* on wip\/AB-parser/, 'the commits on its branch, including one whose subject has no number');
  assert.match(delivered!.result, /merged /, 'whether it was merged');
  assert.match(delivered!.result, /no receipt: AB-report\.md, which the prompt names, was never committed/);
  assert.match(delivered!.result, /the host's evidence AB-evidence-host\.md: AB left no receipt; this is rebuilt from the diff/, 'the host\'s evidence quoted as it says it');
  assert.equal(review!.verdict, 'needs-repair', 'the status word as the arrangement wrote it');
  assert.match(review!.who ?? '', /root \(Claude\)/);
  assert.match(fixAC!.did, /AC fix \(fixes AB\)/);
  assert.match(fixAC!.result, /tests 3\/3/, 'the test count its receipt states');
  assert.match(merged!.did, /AB merged into the trunk together with AC/);
  assert.equal(merged!.result.slice(0, 13), `merge ${h.c.abMerge!.slice(0, 7)}`);
  assert.equal(qc!.verdict, 'fail', 'the verdict exactly as the report wrote it');
  assert.match(qc!.result, /3 findings \(1 严重 \/ 1 轻微 \/ 1 提示\)/, 'the findings counted by severity');
  assert.ok(qc!.evidence.some((e) => e.line === '**结论：`fail`**'), 'the report\'s own line is the evidence');
  assert.match(fixAE!.did, /AE fix/);
  for (let i = 1; i < w.steps.length; i++) assert.ok(w.steps[i - 1]!.occurred.at <= w.steps[i]!.occurred.at, 'sorted by when it happened');
  assert.ok(w.steps.every((s) => s.basis === 'Explicit' && !s.history), 'all tied by the project\'s numbers, nothing in history');
  assert.equal(w.four.execution, 'Merged');
  assert.deepEqual(w.four.check && typeof w.four.check === 'object' ? [w.four.check.verdict, w.four.check.by] : null, ['fail', 'Independent QC']);
});

test('a check of its own report is self-reported, never an independent check (CKC-27 AC-11); a project that asks for no check shows none missing (AC-8)', () => {
  const ag = work(h.store, h.project, h.ledger, 'thr_AG')!;
  assert.deepEqual(ag.steps.map((s) => s.kind), ['Dispatched', 'Walkthrough']);
  const check = ag.four.check;
  assert.ok(check && typeof check === 'object' && check.by === 'Self-reported', 'AG\'s own walkthrough report is its own account');
  assert.equal(ag.steps[1]!.basis, 'Inferred', 'a pass read from section headings rests on what the ledger lists only as candidates');
  const ai = work(h.store, h.project, h.ledger, 'thr_AI')!;
  assert.equal(ai.four.check, null, 'no rule asks for a check of AI: no `Not checked`');
  const aj = work(h.store, h.project, h.ledger, 'thr_AJ')!;
  assert.equal(aj.four.check, 'Not checked', 'a rule asks for an independent check of AJ and there is none');
  assert.equal(aj.four.execution, 'Merged', 'committed straight to the trunk');
});

test('a branch merged twice as the work went on is one landing; a “fail” heading in a delivery’s own receipt is its account, not a failed check', () => {
  const ar = work(h.store, h.project, h.ledger, 'thr_AR')!;
  const merged = ar.steps.filter((s) => s.kind === 'Merged');
  assert.equal(merged.length, 1);
  assert.match(merged[0]!.did, /\(2 merges\)/);
  assert.equal(merged[0]!.occurred.at.slice(0, 10), '2026-08-22', 'when the work finally landed');
  const ah = work(h.store, h.project, h.ledger, 'thr_AH')!;
  assert.equal(ah.four.check, null, 'no check: the heading tells the state before the change');
  assert.ok(ah.steps.every((s) => s.kind !== 'QC' && s.kind !== 'Review' && s.kind !== 'Walkthrough'));
});

test('a plan’s execution shape: the batches in the order they ran, the parallel, the merge commit of each, and where it differs from the plan (CKC-24 AC-2)', () => {
  const shape = plan(h.store, h.project, h.ledger, 'ref_plan')!;
  assert.equal(shape.plannedOrder, '1 → (2 ∥ 3) → 4');
  assert.equal(shape.actualOrder, '1 (AO not started) → 4 → 2 (2a ∥ 2b) → 3');
  assert.equal(shape.differs, 'Execution differs from the plan: batch 4 ran before batches 2 and 3; batch 2 ran as two halves in parallel (2a, 2b); batches 2 and 3, planned in parallel, ran one after another.');
  assert.deepEqual(shape.batches.map((b) => b.label), ['Batch 1 · Scanner', 'Batch 4 · Cleanup', 'Batch 2 · Map', 'Batch 3 · Alerts']);
  const b2 = shape.batches[2]!;
  assert.deepEqual(b2.workIds, ['thr_AR', 'thr_AS']);
  assert.equal(b2.parallel, true);
  assert.equal(b2.mergeCommit, `${h.c.arMerge1!.slice(0, 7)}, ${h.c.arMerge!.slice(0, 7)}, ${h.c.asMerge!.slice(0, 7)}`, 'each half with its merge commits (AR merged twice)');
  assert.equal(shape.batches[0]!.mergeCommit, h.c.an1!.slice(0, 7), 'work committed straight to the trunk: its commit stands in for a merge');
  assert.deepEqual(shape.dependsOn, [{ from: 'thr_AQ', to: 'thr_AN' }], 'the arrangement\'s own `upstream`');
  assert.equal(plan(h.store, h.project, h.ledger, 'thr_AB'), null, 'only a Plan has a shape');
  const ao = work(h.store, h.project, h.ledger, 'thr_AO')!;
  assert.deepEqual(ao.steps.map((s) => [s.kind, s.unit, s.did]), [['Planned', 'AO', 'Planned in Harbor plan in batches as batch 1']], 'queued, never dispatched: only its place in the plan');
});

// ───────────────────────── breakpoints ─────────────────────────

test('all eleven breakpoint kinds, each on the object §2.12 names, with its basis, evidence and six thing — computed as candidates, none lit (D99)', () => {
  const r = computeBreakpoints(h.store, h.project, h.ledger, 'crd_1');
  assert.deepEqual(candidateKinds(), [
    'Downstream behind · ref_storage', 'Findings open · thr_AB', 'Fix not re-checked · thr_AB', 'Fix not re-checked · thr_AK', 'No plan · thr_AP', 'No trace of done · thr_AI',
    'Not carried out · ref_d3', 'Not checked · thr_AJ', 'Not merged · thr_AH', 'Not planned · ref_owner_offline', 'Not started · thr_AO', 'Passed with open items · thr_AG',
  ]);
  assert.deepEqual([r.lit, r.newlyLit, r.candidates], [0, 0, 12], 'the program never lights: every one waits for a lane to look and the spot-check to check');
  assert.equal(h.store.breakpoints.filter((b) => b.lit).length, 0);
  const fo = lit('Findings open', 'thr_AB')!;
  assert.equal(fo.basis, 'Explicit');
  assert.equal(fo.sixThing, 5);
  assert.match(fo.why, /1 finding of AD \(F-3\)/, 'F-1 and F-2 the report\'s root comment sent on; F-3 nobody mentioned again');
  assert.ok(fo.evidence.some((e) => e.line === '### F-3【提示】the log is noisy'), 'the report\'s own line');
  const pwoi = lit('Passed with open items', 'thr_AG')!;
  assert.equal(pwoi.basis, 'Inferred', 'the pass rests on section-heading verdicts');
  assert.ok(pwoi.evidence.some((e) => e.line === '1. `TileCache` 离线时不刷新。'), 'the open item\'s line');
  assert.ok(!pwoi.evidence.some((e) => e.line?.includes('模拟器剪贴板')), 'an item the report itself disposes of (产品未改) is not open');
  assert.ok(pwoi.evidence.some((e) => e.line === '缺口照实记下，不单开一轮。'), 'the report\'s own deferral');
  assert.equal(lit('Not merged', 'thr_AH')!.basis, 'Explicit');
  assert.equal(lit('Not merged', 'thr_AH')!.sixThing, null);
  assert.equal(lit('Downstream behind', 'ref_storage')!.basis, 'Inferred', 'whether the citation depends on the old meaning is a judgement');
  assert.equal(lit('Downstream behind', 'ref_storage')!.familyBasis?.replaced, 'D1', 'the old side is recorded with the candidate');
  assert.equal(lit('Downstream behind', 'ref_storage')!.sixThing, 1);
  assert.ok(lit('Downstream behind', 'ref_storage')!.evidence.some((e) => e.line === 'The tracks follow D1: one CSV file per day.'));
  assert.equal(lit('Not carried out', 'ref_d3')!.basis, 'Inferred');
  assert.equal(lit('Not carried out', 'ref_d3')!.sixThing, 2);
  assert.equal(lit('Not planned', 'ref_owner_offline')!.sixThing, 3);
  assert.equal(lit('No plan', 'thr_AP')!.sixThing, 4);
  assert.equal(lit('Fix not re-checked', 'thr_AK')!.sixThing, 5);
  assert.match(lit('Not checked', 'thr_AJ')!.why, /independent check of AJ/);
  assert.equal(lit('Not checked', 'thr_AB'), undefined, 'AB was checked by AD');
  assert.equal(lit('No plan', 'thr_AJ'), undefined, 'the rule asking for a written plan names AP, not AJ ("ap" inside "map" is not AP)');
  assert.ok(h.store.breakpoints.all().every((b) => b.id === breakpointId('harbor', b.kind, b.targetId)), 'ids stable per kind and object');
  assert.ok(h.store.breakpoints.all().every((b) => b.since.at && !b.since.undated), 'since: when the missing step became due, from the source');
});

test('a shared decisions file contributes replacement lines only to the anchored entry', () => {
  const x = buildHarbor();
  x.store.sources.put(source(x, 'src_d1', 'docs/DECISIONS.md', ['Decisions'], 3, 3));
  x.store.sources.put(source(x, 'src_d3', 'docs/DECISIONS.md', ['Decisions'], 7, 7));
  x.store.reference.put(reference('ref_d1', 'Decision', 'CSV tracks', ['src_d1'], { ids: ['D1'] }));
  x.store.reference.put({ ...x.store.reference.get('ref_d3')!, sourceIds: ['src_d3'] });
  const replaced = (id: string) => lineageView(x.ledger, x.store, id)!.steps.filter((s) => s.kind === 'Replaced' || s.kind === 'Replaces');
  assert.equal(replaced('ref_d1').length, 1, 'the D1 line describes D1 being replaced');
  assert.equal(replaced('ref_d3').length, 0, 'D3 shares the file but not D1’s line');
});

test('Downstream behind uses the parsed old side, never the other number on the line', () => {
  const x = buildHarbor();
  const a = analyze(x.store, x.project, x.ledger);
  const original = a.facts.supersessions.find((s) => s.replaced === 'D1')!;
  a.facts.supersessions.splice(0, a.facts.supersessions.length, { ...original, text: 'D1 is superseded by D2', replaced: 'D2', replacement: 'D1' });
  const behind = () => computeFindings(a).filter((f) => 'lit' in f && f.lit.kind === 'Downstream behind' && f.lit.targetId === 'ref_storage');
  assert.equal(behind().length, 0, 'the current spec cites D1, which is not the parsed old side');
  a.facts.supersessions.splice(0, 1, { ...original, replaced: 'D1', replacement: 'D2' });
  assert.equal(behind().length, 1);
});

test('one refuted supersession family stays out across rounds and a changed line is a candidate again', () => {
  const x = buildHarbor();
  const at = { at: '2026-09-10T00:00:00Z', basis: 'Commit' as const, anchor: 'commit:a' };
  const familyBasis = { lineId: 'sup:original', syntax: 'passive', replaced: 'D1' };
  const candidate = (targetId: string, basis = familyBasis) => ({ lit: { kind: 'Downstream behind' as const, targetId, why: 'D1 is still cited', evidence: [{ id: basis.lineId, kind: 'ledger' as const, label: 'old line', line: null, occurred: at }], basis: 'Inferred' as const, since: at, familyBasis: basis } });
  const findings = [candidate('ref_storage'), candidate('ref_d3')];
  reconcile(x.store, x.project.id, findings, 'round1', null);
  const firstId = breakpointId(x.project.id, 'Downstream behind', 'ref_storage');
  const first = x.store.breakpoints.get(firstId)!;
  x.store.breakpoints.put({ ...first, lit: false, out: { at: '2026-09-11T00:00:00Z', by: 'model', evidence: [], decision: { breakpointId: firstId, at: '2026-09-11T00:00:00Z', roundId: 'round1' } } });
  reconcile(x.store, x.project.id, findings, 'round2', null);
  const sibling = x.store.breakpoints.get(breakpointId(x.project.id, 'Downstream behind', 'ref_d3'))!;
  assert.equal(stateOf(sibling), 'Out (model)');
  assert.deepEqual(sibling.out?.decision, { breakpointId: firstId, at: '2026-09-11T00:00:00Z', roundId: 'round1' });
  assert.equal(reconcile(x.store, x.project.id, findings, 'round3', null).written, 0, 'the inherited decision persists');
  const changed = { ...familyBasis, lineId: 'sup:edited' };
  reconcile(x.store, x.project.id, [...findings, candidate('ref_storage', changed)], 'round4', null);
  assert.equal(stateOf(x.store.breakpoints.get(firstId)), 'Candidate', 'an independent new basis makes this object a candidate again');
  assert.equal(stateOf(x.store.breakpoints.get(sibling.id)), 'Out (model)', 'the sibling still has only the refuted basis');
  reconcile(x.store, x.project.id, [candidate('ref_storage', changed), candidate('ref_d3', changed)], 'round5', null);
  assert.equal(stateOf(x.store.breakpoints.get(firstId)), 'Candidate');
  assert.equal(stateOf(x.store.breakpoints.get(sibling.id)), 'Candidate');
  reconcile(x.store, x.project.id, findings, 'round6', null);
  assert.equal(stateOf(x.store.breakpoints.get(firstId)), 'Out (model)', 'restoring the exact judged line restores the family judgement');
  assert.equal(stateOf(x.store.breakpoints.get(sibling.id)), 'Out (model)');
});

test('the same computation again changes nothing: a candidate keeps where a lane looked, and one the spot-check lit stays lit with its check', () => {
  const looked = { roundId: 'crd_1', jobId: 'job_lane', where: ['subagent/execution-plan.md §5', 'ledger: commits naming AO'], at: '2026-09-29T00:00:00Z' };
  h.store.breakpoints.put({ ...lit('Not started', 'thr_AO')!, looked });
  h.store.breakpoints.put(litByCheck(lit('Not carried out', 'ref_d3')!));
  const again = computeBreakpoints(h.store, h.project, h.ledger, 'crd_2');
  assert.equal(again.written, 0, 'nothing is rewritten when nothing changed');
  assert.deepEqual(lit('Not started', 'thr_AO')!.looked, looked, 'the lane\'s look stays while the candidate holds on the same evidence');
  const d3 = lit('Not carried out', 'ref_d3')!;
  assert.deepEqual([stateOf(d3), d3.confirmedInRoundId, d3.checked?.jobId], ['Lit', 'crd_1', 'job_spot'], 'the check that lit it stays');
  assert.deepEqual([again.lit, again.candidates], [1, 11]);
});

test('a candidate whose evidence changed loses the look: a lane looks again on what the program computes now', () => {
  const x = buildHarbor();
  const at = { at: '2026-09-10T00:00:00Z', basis: 'Commit' as const, anchor: 'commit:a' };
  const found = (evidenceId: string) => ({ lit: { kind: 'No trace of done' as const, targetId: 'thr_AI', why: 'AI is reported done', evidence: [{ id: evidenceId, kind: 'ledger' as const, label: 'line', line: null, occurred: at }], basis: 'Inferred' as const, since: at } });
  reconcile(x.store, x.project.id, [found('num:one')], 'r1', null);
  const id = breakpointId(x.project.id, 'No trace of done', 'thr_AI');
  x.store.breakpoints.put({ ...x.store.breakpoints.get(id)!, looked: { roundId: 'r1', jobId: 'job_lane', where: ['docs/summary.md'], at: at.at } });
  reconcile(x.store, x.project.id, [found('num:one')], 'r2', null);
  assert.ok(x.store.breakpoints.get(id)!.looked, 'same evidence: kept');
  reconcile(x.store, x.project.id, [found('num:two')], 'r3', null);
  assert.deepEqual([stateOf(x.store.breakpoints.get(id)), x.store.breakpoints.get(id)!.looked], ['Candidate', null], 'other evidence: looked for again');
  x.ledger.close();
});

test('a project that asks for none of the steps computes none of the breakpoints that need one (D72, CKC-24 AC-8)', () => {
  const bare = buildHarbor();
  for (const r of bare.store.rules.all()) bare.store.rules.remove(r.id);
  computeBreakpoints(bare.store, bare.project, bare.ledger, null);
  const kinds = new Set(bare.store.breakpoints.filter(isCandidate).map((b) => b.kind));
  for (const k of ['Not checked', 'Fix not re-checked', 'Not planned', 'No plan'] as const) assert.ok(!kinds.has(k), `${k} needs the project to expect its step`);
  for (const k of ['Not merged', 'No trace of done', 'Findings open', 'Passed with open items', 'Not started', 'Downstream behind', 'Not carried out'] as const) assert.ok(kinds.has(k), `${k} applies always`);
  // A rule applying to all work (no appliesTo) makes every delivered piece of work subject to it.
  bare.store.rules.put(rule('rule_all', ['Independent check'], []));
  computeBreakpoints(bare.store, bare.project, bare.ledger, null);
  assert.ok(bare.store.breakpoints.find((b) => isCandidate(b) && b.kind === 'Not checked' && b.targetId === 'thr_AK') === undefined, 'AK was checked by AL');
  assert.ok(bare.store.breakpoints.find((b) => isCandidate(b) && b.kind === 'Not checked' && b.targetId === 'thr_AH'), 'AH was never checked');
  bare.ledger.close();
});

// ───────────────────────── send-backs ─────────────────────────

test('send-backs from the project’s failed checks and host reviews: recorded once, Returned by the task that caught them, Closed on the evidence (CKC-24 AC-10)', () => {
  const r = advanceSendBacks(h.store, h.project, h.ledger, 'crd_1');
  assert.equal(r.created, 3, 'the host’s review of AB, AD’s fail, AL’s fail — not AH’s own “fail” heading, not AX’s review still in progress');
  const all = h.store.sendbacks.all();
  const review = all.find((s) => s.what.includes('reviewed AB'))!;
  assert.equal(review.stage, 'Closed');
  assert.match(review.returned!.by.label, /AC-grok-fix-ab\.md/, 'returned by the fix task that names AB');
  assert.match(review.closed!.by.label, new RegExp(h.c.abMerge!.slice(0, 7)), 'closed by the merge of the fix (a host review needs no re-check)');
  const adFail = all.find((s) => s.what.includes('AD\'s independent QC'))!;
  assert.equal(adFail.stage, 'Returned', 'AB\'s rules ask for a re-check after a fix, and none came after AE');
  assert.match(adFail.returned!.by.label, /AE-grok-fix-ad\.md/);
  assert.equal(adFail.from.kind, 'verdict');
  assert.ok(adFail.evidence.some((e) => e.line === '**结论：`fail`**'));
  const again = advanceSendBacks(h.store, h.project, h.ledger, 'crd_2');
  assert.equal(again.created + again.written, 0, 'recorded once; nothing moves without new evidence');
  // The process view now draws the send-backs as arrows back from the steps they came from.
  const w = work(h.store, h.project, h.ledger, 'thr_AB')!;
  assert.equal(w.steps.find((s) => s.kind === 'Review')!.sendBackId, review.id);
  assert.equal(w.steps.find((s) => s.kind === 'QC')!.sendBackId, adFail.id);
  assert.equal(w.four.open.sendBacks, 1, 'the open one lights on the work');
});

test('a review that has not concluded (`incomplete（审核进行中）`) is a check still in progress, not a failure: it starts no send-back', () => {
  const ap = work(h.store, h.project, h.ledger, 'thr_AP')!;
  const review = ap.steps.find((s) => s.kind === 'Review')!;
  assert.match(review.did, /^AX independent review of AP/);
  assert.equal(review.verdict, 'incomplete（审核进行中）', 'the verdict with the words it was written in');
  assert.match(review.result, /check in progress, no verdict yet/);
  assert.equal(review.sendBackId, null, 'no arrow back');
  const check = ap.four.check;
  assert.deepEqual(check && typeof check === 'object' ? [check.verdict, check.by] : null, ['incomplete（审核进行中） · in progress', 'Independent QC']);
  assert.ok(!h.store.sendbacks.all().some((s) => s.targetId === 'thr_AP' || s.what.includes('AX')), 'nothing was sent back to AP');
  assert.equal(h.store.breakpoints.filter((b) => !b.out && b.targetId === 'thr_AP' && b.kind !== 'No plan').length, 0, 'and nothing about it is even a candidate');
});

test('a suggested send-back moves on by itself: a later task carrying its id returns it; later evidence closes it; the owner’s answer stays', () => {
  const now = '2026-08-26T00:00:00Z';
  const base = { projectId: 'harbor', to: 'Work' as const, stage: 'Suggested' as const, returned: null, closed: null, ownerResponse: null, sixThing: null, roundId: null, updatedAt: now, suggestion: 'x' };
  const ah: SendBack = { ...base, id: 'sb_testah', targetId: 'thr_AH', what: 'AH never merged', evidence: [], from: { kind: 'breakpoint', id: lit('Not merged', 'thr_AH')!.id }, occurred: { at: '2026-08-12T12:00:00Z', basis: 'Commit', anchor: null } };
  const aj: SendBack = { ...base, id: 'sb_testaj', targetId: 'thr_AJ', what: 'AJ was never checked', evidence: [], from: { kind: 'breakpoint', id: lit('Not checked', 'thr_AJ')!.id }, occurred: { at: '2026-08-14T12:00:00Z', basis: 'Commit', anchor: null } };
  const ai: SendBack = { ...base, id: 'sb_testai', targetId: 'thr_AI', what: 'AI done without a trace', evidence: [], from: { kind: 'breakpoint', id: lit('No trace of done', 'thr_AI')!.id }, occurred: { at: '2026-08-13T09:00:00Z', basis: 'Commit', anchor: null }, ownerResponse: { text: 'No action needed', reason: 'copy only', at: now, sourceId: null } };
  for (const s of [ah, aj, ai]) h.store.sendbacks.put(s);
  advanceSendBacks(h.store, h.project, h.ledger, 'crd_2');
  assert.equal(h.store.sendbacks.get('sb_testah')!.stage, 'Suggested', 'nothing picked it up yet');
  // The owner answers a breakpoint; then later material arrives and the next round runs.
  respondToBreakpoint(h.store, lit('No trace of done', 'thr_AI')!.id, 'The copy lives in the app store listing');
  stage2(h);
  runProcess(h.store, h.project, h.ledger, 'crd_3');
  const ahNow = h.store.sendbacks.get('sb_testah')!;
  assert.equal(ahNow.stage, 'Closed', 'its breakpoint went out on the merge');
  assert.match(ahNow.closed!.by.label, /Merge AH/);
  const ajNow = h.store.sendbacks.get('sb_testaj')!;
  assert.equal(ajNow.stage, 'Returned', 'the check task carries the send-back\'s own id');
  assert.match(ajNow.returned!.by.label, /AW-kimi-qc-aj\.md/);
  assert.equal(h.store.sendbacks.get('sb_testai')!.ownerResponse!.reason, 'copy only', 'the owner\'s answer stays');
  const alFail = h.store.sendbacks.find((s) => s.what.includes('AL\'s independent QC'))!;
  assert.equal(alFail.stage, 'Closed', 'AK\'s re-check after the fix passed');
  assert.match(alFail.closed!.by.line ?? '', /pass/);
});

test('later evidence puts breakpoints out with that evidence; the owner’s No action needed is kept and never lit again; a model’s refutation holds', () => {
  // (stage 2 ran in the test above)
  const out = (kind: Breakpoint['kind'], target: string) => { const b = lit(kind, target)!; assert.equal(b.lit, false, `${kind} on ${target} is out`); return b.out!; };
  assert.match(out('Not merged', 'thr_AH').evidence[0]!.label, /Merge AH/);
  assert.match(out('Passed with open items', 'thr_AG').evidence[0]!.label, /Fix TileCache offline refresh/);
  assert.match(out('Not started', 'thr_AO').evidence[0]!.label, /AO-grok-scanner-ui\.md/);
  assert.match(out('Fix not re-checked', 'thr_AK').evidence[0]!.line ?? '', /pass/);
  assert.ok(out('Findings open', 'thr_AB').evidence.some((e) => e.line?.includes('F-3')), 'F-3 was handed to AV');
  const answered = lit('No trace of done', 'thr_AI')!;
  assert.equal(answered.lit, false);
  assert.equal(answered.ownerResponse!.reason, 'The copy lives in the app store listing');
  assert.equal(answered.out!.by, 'owner');
  // Put out by evidence, and the ledger shows it again: a candidate again (a breakpoint is an observation, not a ticket).
  const ds = lit('Downstream behind', 'ref_storage')!;
  assert.equal(stateOf(ds), 'Candidate');
  h.store.breakpoints.put({ ...ds, lit: false, out: { at: '2026-09-10T00:00:00Z', by: 'evidence', evidence: [] }, confirmedInRoundId: null });
  computeBreakpoints(h.store, h.project, h.ledger, 'crd_4');
  assert.equal(stateOf(lit('Downstream behind', 'ref_storage')), 'Candidate', 'out by evidence keeps its treatment: a candidate again when the step is still missing');
  // A model step refutes it (pk_confirm, confirmed: false: out by 'model', with its evidence): the next computation leaves it out.
  const refutation = { kind: 'file' as const, id: 'docs/SPEC.md', label: 'docs/SPEC.md:5', line: 'The tracks follow D1: one CSV file per day.', occurred: null };
  h.store.breakpoints.put({ ...lit('Downstream behind', 'ref_storage')!, lit: false, out: { at: '2026-09-10T00:00:00Z', by: 'model', evidence: [refutation] }, confirmedInRoundId: null });
  const r = computeBreakpoints(h.store, h.project, h.ledger, 'crd_5');
  const refuted = lit('Downstream behind', 'ref_storage')!;
  assert.equal(refuted.lit, false, 'not lit again on the facts the model already judged');
  assert.deepEqual([refuted.out!.by, refuted.out!.evidence], ['model', [refutation]], 'the refutation stays as the step wrote it');
  assert.ok(r.keptOut >= 2, 'the owner\'s answer and the refutation are both kept out');
  // A Follow up keeps what the spot-check lit, while it still holds (lit in crd_1; crd_2 … crd_5 computed since).
  assert.deepEqual([stateOf(lit('Not carried out', 'ref_d3')), lit('Not carried out', 'ref_d3')!.confirmedInRoundId], ['Lit', 'crd_1'], 'a lit breakpoint and its check survive later rounds while it holds');
});

test('found → delivery link → out: a lane that finds the delivery links it, and the candidate goes out on it', () => {
  const x = buildHarbor();
  computeBreakpoints(x.store, x.project, x.ledger, 'crd_1');
  const id = breakpointId('harbor', 'No trace of done', 'thr_AI');
  assert.equal(stateOf(x.store.breakpoints.get(id)), 'Candidate', 'AI is reported done and nothing of its own is in the ledger');
  // The lane read the execution plan and found AI's delivery: a commit the plan names (pk_link_process, confirmed in the cross-check).
  const fact = { kind: 'commit' as const, id: x.c.aj1, label: `${x.c.aj1.slice(0, 7)} the map view`, line: null, occurred: null };
  x.store.links.put({ id: 'link_ai', projectId: 'harbor', workId: 'thr_AI', ledgerRef: `commit:${x.c.aj1}`, evidence: fact, stepKind: 'Delivered', why: 'the execution plan names it as AI\'s delivery', basis: 'Inferred', confirmed: true, roundId: 'crd_1', jobId: 'job_lane', at: '2026-09-29T00:00:00Z' });
  computeBreakpoints(x.store, x.project, x.ledger, 'crd_1');
  const out = x.store.breakpoints.get(id)!;
  assert.equal(stateOf(out), 'Out (evidence)', 'never lit: the delivery link puts the candidate out');
  assert.equal(out.out!.evidence[0]!.id, x.c.aj1);
  x.ledger.close();
});

test('the start-up fix: a breakpoint lit without the independent check becomes a candidate again, once; the owner\'s answer and a checked one stay', () => {
  const x = buildHarbor();
  computeBreakpoints(x.store, x.project, x.ledger, 'crd_1');
  const [a, b, c] = ['Not merged', 'Not checked', 'Not started'].map((k) => x.store.breakpoints.find((bp) => bp.kind === k)!);
  x.store.breakpoints.put({ ...a!, lit: true, confirmedInRoundId: 'crd_0' }); // lit by the program before D99
  x.store.breakpoints.put(litByCheck(b!));
  x.store.breakpoints.put({ ...c!, lit: true, out: { at: '2026-09-20T00:00:00Z', by: 'owner', evidence: [] }, ownerResponse: { text: 'No action needed', reason: 'queued on purpose', at: '2026-09-20T00:00:00Z', sourceId: null } });
  assert.equal(unlightUnchecked(x.store), 1);
  const back = x.store.breakpoints.get(a!.id)!;
  assert.deepEqual([stateOf(back), back.confirmedInRoundId], ['Candidate', null], 'still recorded, a candidate for the lanes');
  assert.equal(stateOf(x.store.breakpoints.get(b!.id)), 'Lit', 'the spot-check checked it');
  assert.equal(x.store.breakpoints.get(c!.id)!.ownerResponse!.reason, 'queued on purpose', 'the owner\'s answer is left as it is');
  assert.equal(unlightUnchecked(x.store), 0, 'once');
  x.ledger.close();
});

test('the spot-check checks every looked candidate, whatever round looked, and a weighted sample of what the round wrote', () => {
  const x = buildHarbor();
  computeBreakpoints(x.store, x.project, x.ledger, 'crd_1');
  const [a, b] = ['Not merged', 'Not checked'].map((k) => x.store.breakpoints.find((bp) => bp.kind === k)!);
  x.store.breakpoints.put({ ...a!, looked: { roundId: 'crd_0', jobId: 'job_old', where: ['docs/summary.md'], at: '2026-09-28T00:00:00Z' } });
  x.store.jobs.put({ id: 'job_lane', projectId: 'harbor', kind: 'Organizing', status: 'Done', queuedAt: '2026-09-29T00:00:00Z', step: { roundId: 'crd_2', kind: 'lane', path: 'plan-k' } } as never);
  x.store.breakpoints.put({ ...b!, looked: { roundId: 'crd_2', jobId: 'job_lane', where: ['subagent/AW-kimi-qc-aj.md'], at: '2026-09-29T00:00:00Z' } }, { jobId: 'job_lane', summary: 'Looked for Not checked on thr_AJ, not found' });
  x.store.threads.put({ ...x.store.threads.get('thr_AJ')!, updatedAt: '2026-09-29T00:00:00Z' }, { jobId: 'job_lane', summary: 'AJ: the code is wired in src/map.ts' });
  const t = spotCheckTargets(x.store, { id: 'crd_2' });
  assert.deepEqual(t.candidates.map((c) => c.id).sort(), [a!.id, b!.id].sort(), 'every looked candidate; the others wait for a lane');
  assert.match(t.candidates.find((c) => c.id === b!.id)!.summary, /looked in subagent\/AW-kimi-qc-aj\.md/);
  assert.deepEqual(t.sample.map((s) => `${s.collection} ${s.id} ${s.weight}`), ['threads thr_AJ 5'], 'the rest by weight; the looked candidate is not sampled twice');
  x.ledger.close();
});

// ───────────────────────── the runner, the engines, the synthesis block ─────────────────────────

test('the round’s program step writes under its own job, and says what it did', async () => {
  const x = buildHarbor();
  x.store.jobs.put({ id: 'job_process', projectId: 'harbor', kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['crd_9'], label: 'Process and breakpoints' }, status: 'Running', queuedAt: '2026-09-26T00:00:00Z', startedAt: null, endedAt: null, savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, agent: 'program', model: null, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: null, resultText: null, priority: 1, task: null, step: { roundId: 'crd_9', kind: 'process', path: null } } as never);
  const service = { ledger: (id: string) => (id === 'harbor' ? x.ledger : null) } as unknown as LedgerService;
  const { note } = await processRunner(service).run(x.store, x.project, 'crd_9');
  assert.match(note, /13 work items, \d+ steps from the ledger/);
  assert.match(note, /breakpoints lit 0, candidates 12 \(Not planned 1, Not started 1, Not merged 1/);
  assert.match(note, /send-backs: 3 recorded from failed checks and reviews/);
  await x.store.flush();
  const traced = x.store.traceByJob('job_process', 1000);
  assert.ok(traced.some((e) => e.collection === 'breakpoints') && traced.some((e) => e.collection === 'sendbacks'), 'the round counts what its process step wrote');
  const none = await processRunner({ ledger: () => null } as unknown as LedgerService).run(x.store, x.project, 'crd_9');
  assert.match(none.note, /no ledger/);
  x.ledger.close();
});

test('the process view’s engines: every work item’s steps and four things from one computation; a plan’s shape', () => {
  const x = buildHarbor();
  runProcess(x.store, x.project, x.ledger, null);
  const engines = processEngines({ ledger: () => x.ledger } as unknown as LedgerService);
  const started = Date.now();
  const view = processView(x.store, x.project, { process: engines });
  assert.ok(Date.now() - started < 5000);
  const ab = view.works.thr_AB!;
  assert.equal(ab.steps.length, 7);
  assert.equal(ab.four.open.breakpoints, 0, 'Findings open and Fix not re-checked on AB are candidates: not open, not red');
  assert.equal(ab.four.open.findings, 1);
  assert.match(ab.folded, /7 steps · 2 send-backs · open items/);
  assert.equal(view.plans.ref_plan!.actualOrder, '1 (AO not started) → 4 → 2 (2a ∥ 2b) → 3');
  assert.deepEqual([view.counts.breakpointsLit, view.counts.breakpointCandidates], [0, 12], 'only lit ones count as found');
  const candidate = view.breakpoints.find((b) => b.kind === 'Not merged')!;
  assert.equal(candidate.state, 'Candidate');
  assert.match(breakpointBrief(candidate, 'AH'), /Status: Candidate \(a lead, not a finding/, 'the agent entry does not read it as a finding');
  // The spot-check lights one; the same engines see it at once, and then the owner answers.
  const ah = breakpointId('harbor', 'Not merged', 'thr_AH');
  x.store.breakpoints.put(litByCheck(x.store.breakpoints.get(ah)!));
  assert.equal(engines.work(x.store, x.project, 'thr_AH')!.four.open.breakpoints, 1);
  assert.equal(processView(x.store, x.project, { process: engines }).counts.breakpointsLit, 1);
  respondToBreakpoint(x.store, ah, 'An experiment after all');
  assert.equal(engines.work(x.store, x.project, 'thr_AH')!.four.open.breakpoints, 0);
  x.ledger.close();
});

test('a fix or a check folds under the work it is a step of, however many fixes and checks lie between (stepOf)', () => {
  const x = buildHarbor();
  write(x.root, 'subagent/AY-kimi-qc-milestone.md', '---\nid: "AY"\nexecutor: "kimi"\nkind: "independent QC"\n---\n\n# AY — 独立 QC：AH 与 AJ\n');
  commit(x.root, 'subagent: dispatch AY', '2026-08-26T09:00:00+00:00');
  x.rebuild();
  for (const [n, title] of [['AC', 'Fix AB'], ['AD', 'QC of AB'], ['AE', 'Fix what AD found'], ['AL', 'QC of AK'], ['AM', 'Fix what AL found'], ['AX', 'Review of AP'], ['AY', 'Milestone QC']] as const) x.store.threads.put(thread(n, title));
  const engines = processEngines({ ledger: () => x.ledger } as unknown as LedgerService);
  const of = (id: string) => engines.stepOf!(x.store, x.project, id);
  assert.deepEqual(['thr_AC', 'thr_AD', 'thr_AE'].map(of), ['thr_AB', 'thr_AB', 'thr_AB'], 'AE fixes what AD found in AB: it folds under AB');
  assert.deepEqual(['thr_AL', 'thr_AM'].map(of), ['thr_AK', 'thr_AK']);
  assert.equal(of('thr_AX'), 'thr_AP');
  assert.equal(of('thr_AB'), null, 'a piece of work of its own');
  assert.equal(of('thr_AY'), null, 'a check of two separate pieces of work belongs to neither alone');
  assert.equal(stepOf(x.store, x.project, x.ledger, 'thr_AE'), 'thr_AB');
  const view = processView(x.store, x.project, { process: engines });
  assert.deepEqual([view.works.thr_AD!.stepOf, view.works.thr_AB!.stepOf], ['thr_AB', null], 'the view folds AD under AB');
  x.ledger.close();
});

test('a number given to two tasks is two units: each work item shows its own task (reused numbers)', () => {
  const x = buildHarbor();
  const fm = (id: string, title: string, fields: Record<string, string>) => `---\nid: "${id}"\n${Object.entries(fields).map(([k, v]) => `${k}: "${v}"`).join('\n')}\n---\n\n# ${id} — ${title}\n`;
  // BA: two prompt files, one after the other, each with its commit and its report.
  write(x.root, 'subagent/BA-kimi-importer.md', fm('BA', 'importer', { executor: 'kimi', status: 'running', report: 'D:\\\\harbor\\\\subagent\\\\reports\\\\BA-report.md' }));
  commit(x.root, 'subagent: dispatch BA', '2026-08-26T09:00:00+00:00');
  write(x.root, 'src/importer.ts', 'export const importer = 1;\n');
  commit(x.root, 'BA: importer', '2026-08-26T12:00:00+00:00');
  write(x.root, 'subagent/reports/BA-report.md', 'status: submitted\n\n## 做了什么\n\nThe importer.\n');
  commit(x.root, 'subagent: BA report', '2026-08-26T13:00:00+00:00');
  write(x.root, 'subagent/BA-grok-exporter-v2.md', fm('BA', 'exporter v2', { executor: 'grok', status: 'running' }));
  commit(x.root, 'subagent: dispatch BA again (exporter v2)', '2026-08-29T09:00:00+00:00');
  write(x.root, 'src/exporter2.ts', 'export const exporter2 = 1;\n');
  commit(x.root, 'BA: exporter v2', '2026-08-29T12:00:00+00:00');
  write(x.root, 'subagent/reports/BA-grok-exporter-v2-report.md', 'status: submitted\n\n## 做了什么\n\nExporter v2.\n');
  commit(x.root, 'subagent: BA exporter v2 report', '2026-08-29T13:00:00+00:00');
  // AZ, as ContextKeeper's AJ: one prompt (a review, created 08-31), its report, and an earlier task's report under the
  // same number, all committed at once; the earlier report is dated by what it writes (派出 2026-08-20).
  write(x.root, 'subagent/reports/AZ-report.md', '# AZ · 甲 · 19 题（测代价）· 统计摘要\n\n派出 2026-08-20T16:57:59Z，收回 17:10Z。\n\n| 项 | 值 |\n| --- | --- |\n| 往返轮数 | 17 |\n');
  write(x.root, 'subagent/AZ-sol-read-boundary.md', fm('AZ', '独立审核：读边界', { executor: 'sol', status: 'incomplete', kind: 'independent review', created_at: '2026-08-31' }));
  write(x.root, 'subagent/reports/AZ-sol-read-boundary-report.md', '# AZ — 读边界独立审核报告\n\n## 结论\n\n**incomplete（审核进行中）**\n');
  commit(x.root, 'Put the subagent folder under version control', '2026-09-02T09:00:00+00:00');
  x.rebuild();
  x.store.sources.put({ ...x.store.sources.get('src_plan')!, id: 'src_ba_old', title: 'subagent/BA-kimi-importer.md', anchor: { kind: 'file', path: join(x.root, 'subagent', 'BA-kimi-importer.md'), headingPath: [], lineStart: 1, lineEnd: 8 } });
  x.store.threads.put({ ...thread('BA', 'Importer'), id: 'thr_BA_old', inputs: { jobId: '', sourceIds: ['src_ba_old'], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' } });
  x.store.threads.put(thread('BA', 'Exporter v2'));
  x.store.threads.put(thread('AZ', 'Read-boundary review'));
  const a = analyze(x.store, x.project, x.ledger);
  const paths = (k: string) => [...new Set([...a.index.units.get(k)!.prompts, ...a.index.units.get(k)!.receipts].map((r) => r.path))];
  assert.deepEqual(paths('BA#1'), ['subagent/BA-kimi-importer.md', 'subagent/reports/BA-report.md'], 'the first task: its prompt and the report it names');
  assert.deepEqual(paths('BA'), ['subagent/BA-grok-exporter-v2.md', 'subagent/reports/BA-grok-exporter-v2-report.md'], 'the latest keeps the number: its prompt, and the report its name continues');
  assert.deepEqual([a.index.units.get('BA#1')!.commits.map((c) => c.subject), a.index.units.get('BA')!.commits.map((c) => c.subject)], [['BA: importer'], ['BA: exporter v2']], 'commits by when they were made');
  const old = work(x.store, x.project, x.ledger, 'thr_BA_old')!;
  const now = work(x.store, x.project, x.ledger, 'thr_BA')!;
  assert.deepEqual(old.steps.map((s) => `${s.kind} ${s.unit}`), ['Dispatched BA#1', 'Delivered BA#1'], 'the work item whose sources cite the first prompt is the first task');
  assert.match(old.steps[1]!.result, /BA-report\.md/);
  assert.deepEqual(now.steps.map((s) => `${s.kind} ${s.unit}`), ['Dispatched BA', 'Delivered BA']);
  assert.match(now.steps[1]!.result, /BA-grok-exporter-v2-report\.md/);
  assert.ok(!now.steps.some((s) => s.evidence.some((e) => e.label.includes('BA-report.md'))), 'nothing of the first task in the latest one\'s process');
  assert.deepEqual(paths('AZ'), ['subagent/AZ-sol-read-boundary.md', 'subagent/reports/AZ-sol-read-boundary-report.md']);
  assert.deepEqual(paths('AZ#1'), ['subagent/reports/AZ-report.md'], 'written about 08-20, before the review was created on 08-31: an earlier task with the number');
  const az = work(x.store, x.project, x.ledger, 'thr_AZ')!;
  assert.ok(!az.steps.some((s) => s.evidence.some((e) => e.label.includes('AZ-report.md'))), 'the review\'s process has none of the exam\'s report');
  x.ledger.close();
});

test('the synthesis’ block: the breakpoints lit by kind and object, with ids and the lines; the candidates apart, as leads; the send-backs open', () => {
  const block = processBlock(h.store);
  assert.match(block, /^=== Process and breakpoints/);
  assert.match(block, /Breakpoints lit \(1\) — a lane looked and the spot-check confirmed:\nNot carried out \(1\) — six thing 2:\n- bp_[0-9a-f]+ on Decision 旧的 CSV 导出在 2026-08-20 之前删掉 \(ref_d3\) · Inferred \(refute with pk_confirm if it does not hold\) · checked 2026-09-29/);
  const [litPart, leadPart] = block.split(/\nBreakpoint candidates \(/);
  assert.ok(leadPart, 'the candidates have a section of their own');
  assert.match(leadPart!, /^\d+\) — leads, not findings/);
  assert.match(leadPart!, /Not checked \(1\):\n- bp_[0-9a-f]+ on AJ .* · (not looked for yet|looked in .*)/);
  assert.ok(!litPart!.includes('Not checked ('), 'a candidate is never among the lit');
  assert.match(block, /Send-backs open \(\d+\):\n- sb_/);
  assert.ok(!block.includes('Not merged ('), 'what is out is not in it');
});

test('a work item whose number the ledger never saw has no steps, and the program claims nothing about it', () => {
  const x = buildHarbor();
  x.store.threads.put({ ...x.store.threads.get('thr_AJ')!, id: 'thr_ZZ', ids: ['ZX-9'], title: 'Imported from a list outside version control' });
  const w = work(x.store, x.project, x.ledger, 'thr_ZZ')!;
  assert.deepEqual(w.steps, []);
  assert.equal(w.four.execution, null, 'said to be done, and nothing ties its execution to it yet: not shown, never `Not started`');
  x.store.threads.put({ ...x.store.threads.get('thr_ZZ')!, progress: 'Planned' });
  assert.equal(work(x.store, x.project, x.ledger, 'thr_ZZ')!.four.execution, 'Not started', 'planned work with nothing of its own has not started');
  x.store.threads.put({ ...x.store.threads.get('thr_ZZ')!, progress: 'Done' });
  computeBreakpoints(x.store, x.project, x.ledger, null);
  assert.equal(x.store.breakpoints.filter((b) => b.targetId === 'thr_ZZ' && !b.out).length, 0, 'no `No trace of done` for a number with no trace to look for: the round\'s links tie such work');
  x.ledger.close();
});

test('a breakpoint about delivery a round put out with commits as evidence ties them to the work: its execution reads them (§1.4)', () => {
  const x = buildHarbor();
  x.store.threads.put({ ...x.store.threads.get('thr_AJ')!, id: 'thr_ZZ', ids: ['ZX-9'], title: 'Imported from a list outside version control' });
  const commitRef = { kind: 'commit' as const, id: x.c.aj1, label: `${x.c.aj1.slice(0, 7)} the map view`, line: null, occurred: null };
  const report = { kind: 'file' as const, id: 'docs/summary.md', label: 'docs/summary.md', line: null, occurred: null };
  const bp = {
    id: 'bp_zz', projectId: x.project.id, kind: 'No trace of done', targetId: 'thr_ZZ', basis: 'Inferred', lit: false, since: null, why: 'reported done', evidence: [],
    out: { at: '2026-09-29T01:44:00Z', by: 'model', evidence: [report, commitRef], decision: { breakpointId: 'bp_zz', at: '2026-09-29T01:44:00Z', roundId: 'crd_2' } },
    ownerResponse: null, confirmedInRoundId: null, sendBackId: null, sixThing: null, roundId: 'crd_2', updatedAt: '2026-09-29T01:44:00Z',
  } as unknown as Breakpoint;
  x.store.breakpoints.put(bp);
  assert.equal(linkPutOutDeliveries(x.store), 1, 'the commit it cites, not the report');
  const link = x.store.links.all().find((l) => l.workId === 'thr_ZZ')!;
  assert.deepEqual([link.stepKind, link.confirmed, link.ledgerRef], ['Delivered', true, `commit:${x.c.aj1}`]);
  assert.equal(work(x.store, x.project, x.ledger, 'thr_ZZ')!.four.execution, 'Merged', 'the linked commit is on the trunk');
  assert.equal(linkPutOutDeliveries(x.store), 0, 'once');
  x.ledger.close();
});

test('the analysis of a project of a few hundred work items takes seconds, not minutes', () => {
  const x = buildHarbor();
  for (let i = 0; i < 300; i++) x.store.threads.put({ ...x.store.threads.get('thr_AJ')!, id: `thr_bulk_${i}`, ids: [`T${i}`], title: `Bulk ${i}` });
  const started = Date.now();
  const a = analyze(x.store, x.project, x.ledger);
  for (const t of x.store.threads.all()) a.process(t.id);
  runProcess(x.store, x.project, x.ledger, null);
  const ms = Date.now() - started;
  assert.ok(ms < 20_000, `took ${ms} ms`);
  x.ledger.close();
});

test.after(() => { h.ledger.close(); });
