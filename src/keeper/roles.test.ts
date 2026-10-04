/**
 * Which pk_* tools a job outside a round's steps is offered (Spec §3.3): a subagent reads and writes only what concerns
 * its own material; other work — the owner's conversation, an answer, a request, a re-look — gets every tool except those
 * only a round's step has a round for. A step of a round gets its step's tools (clerk.test.ts, `stepToolsFor`). The D59
 * gating by a round's main job and its round kind is gone with the method it belonged to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReplacedRound, isRoundMain, jobRole, roundKindOf, stepToolsFor, toolsFor } from './roles.ts';

const named = (...names: string[]) => names.map((name) => ({ name }));
const all = named(
  'read', 'bash', 'pk_project_overview', 'pk_read_assets', 'pk_find_references', 'pk_write_fact_record', 'pk_set_used_as', 'pk_investigate', 'pk_record_code_check',
  'pk_write_thread', 'pk_write_reference', 'pk_relate', 'pk_write_change', 'pk_write_mark', 'pk_write_note', 'pk_write_area', 'pk_check_decisions',
  'pk_write_rule', 'pk_write_organizing_plan', 'pk_merge_work_items', 'pk_record_carry_out', 'pk_ledger_commits', 'pk_ask_owner_about_rules',
  'pk_judge_object', 'pk_set_propagation', 'pk_set_propagations', 'pk_write_round_result', 'pk_round_pending', 'pk_request_relook',
);
const ROUND_ONLY = ['pk_judge_object', 'pk_set_propagation', 'pk_set_propagations', 'pk_round_pending', 'pk_write_round_result', 'pk_ask_owner_about_rules'];

test('a subagent reads and writes its material’s fact records, and nothing that spans objects', () => {
  const sub = toolsFor(all, 'subagent').map((t) => t.name);
  for (const n of ['read', 'bash', 'pk_read_assets', 'pk_find_references', 'pk_write_fact_record', 'pk_set_used_as', 'pk_record_code_check', 'pk_ledger_commits']) assert.ok(sub.includes(n), `a subagent has ${n}`);
  for (const n of ['pk_write_thread', 'pk_write_reference', 'pk_relate', 'pk_write_change', 'pk_write_mark', 'pk_write_note', 'pk_write_area', 'pk_check_decisions',
    'pk_write_rule', 'pk_write_organizing_plan', 'pk_merge_work_items', 'pk_record_carry_out', 'pk_investigate', ...ROUND_ONLY]) {
    assert.ok(!sub.includes(n), `a subagent is not offered ${n}`);
  }
});

test('other work gets every tool but what only a round’s step has a round for (Spec §3.3, §5.5; CKC-11 AC-25)', () => {
  const other = toolsFor(all, 'other').map((t) => t.name);
  for (const n of ['read', 'bash', 'pk_write_thread', 'pk_write_mark', 'pk_write_rule', 'pk_write_organizing_plan', 'pk_merge_work_items', 'pk_record_carry_out', 'pk_request_relook', 'pk_investigate', 'pk_ledger_commits']) {
    assert.ok(other.includes(n), `other work keeps ${n}: what a correction or a request needs`);
  }
  for (const n of ROUND_ONLY) assert.ok(!other.includes(n), `work outside a round is not offered ${n}`);
});

test('what only a round’s step has a round for goes to that step: the judgements to a Follow up cross-check, the rules note to the synthesis', () => {
  const tools = named('read', ...ROUND_ONLY, 'pk_write_note');
  const names = (step: string, round: 'First usable' | 'Deepen' | 'Follow up') => stepToolsFor(tools, step, round).map((t) => t.name);
  for (const n of ['pk_judge_object', 'pk_set_propagation', 'pk_set_propagations', 'pk_round_pending']) {
    assert.ok(names('cross-check', 'Follow up').includes(n), `a Follow up cross-check judges: ${n}`);
    assert.ok(!names('cross-check', 'Deepen').includes(n), `a deepening's cross-check does not: ${n}`);
  }
  assert.ok(names('synthesis', 'Follow up').includes('pk_ask_owner_about_rules'));
  for (const round of ['First usable', 'Follow up'] as const) {
    const plan = stepToolsFor(named('pk_write_organizing_plan'), 'orientation', round).map((t) => t.name);
    assert.deepEqual(plan, ['pk_write_organizing_plan'], `${round}: orientation writes the organizing plan (Spec §3.3; D62)`);
  }
  assert.deepEqual(stepToolsFor(named('pk_write_organizing_plan'), 'skeleton', 'First usable'), [], 'the other steps read it; orientation writes it');
  for (const step of ['orientation', 'skeleton', 'dig', 'cross-check', 'synthesis', 'spot-check']) {
    assert.ok(!names(step, 'Follow up').includes('pk_write_round_result'), `${step}: the program counts a round's one result when it closes`);
  }
});

test('who a job is follows from its parent; a D59 round is recognised as replaced and runs as nothing special', () => {
  const job = (extra: Record<string, unknown> | null, parentJobId: string | null = null, step: unknown = null) => ({ task: { extra }, parentJobId, step }) as never;
  assert.equal(jobRole(job({ kind: 'materials' }, 'job_main')), 'subagent');
  assert.equal(jobRole(job({ kind: 'relook' })), 'other');
  assert.equal(jobRole(job({ kind: 'takeover', round: 'frame' })), 'other', 'no main job any more');
  // Still recognised, for the two readers outside roles.ts that ask (see roundKindOf's note).
  assert.equal(roundKindOf(job({ kind: 'takeover', round: 'deepen' })), 'deepen');
  assert.equal(roundKindOf(job({ kind: 'round' })), 'follow-up');
  assert.equal(isRoundMain(job({ kind: 'clerk-round', roundId: 'crd_1' })), false, 'a clerk round is not a D59 main job');
  for (const kind of ['takeover', 'round', 'materials']) assert.equal(isReplacedRound(job({ kind })), true, kind);
  assert.equal(isReplacedRound(job({ kind: 'clerk-step', roundId: 'crd_1' }, 'root', { roundId: 'crd_1', kind: 'orientation', path: null })), false);
  assert.equal(isReplacedRound(job(null)), false);
});
