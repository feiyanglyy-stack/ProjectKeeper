/**
 * Which job of a round is given which of the program's lists, and what the method tells it to do with them (Spec §3.3;
 * test-C-1; the owner's rule of 2026-09-28). Since D99 the method is the skills' (skills.ts), which restate the rules the
 * step prompts carried before, in their new wording:
 *   - the owner's lines no position cites → orientation (rules), reconcile (Owner's words), the cross-check (both);
 *   - what later names the items of a "not handled" claim → the cross-check, the synthesis, the spot-check, and every lane
 *     before it reports one;
 *   - the work merged without a task number → reconcile, and a Follow up's cross-check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoundKind } from '../../model/k-types.ts';
import { methodBlocksOf, ROUND_STEPS, stageBlocksOf } from './clerk.ts';
import { ROUND_STAGES } from '../clerk-steps.ts';
import { laneSkill, spotCheckSkill, stageSkill, synthesisSkill } from './skills.ts';

test('each job is given the lists it judges from: the main agent its stage’s as it enters it, the synthesis and the spot-check the claims', () => {
  // D99: the main agent is given its first stage's lists in its prompt, and each later stage's as it enters it
  // (clerk.ts `stageBlocksOf`, returned by pk_stage); the spot-check gets the claims. D103: the synthesis is a job of its
  // own and gets the claims and the lanes' Unsure items in its prompt; the main agent's stages end before it.
  const table = Object.fromEntries((Object.keys(ROUND_STEPS) as RoundKind[]).map((round) => [round, Object.fromEntries(ROUND_STEPS[round].map((s) => [s, methodBlocksOf(s, round)]).filter(([, b]) => (b as string[]).length))]));
  assert.deepEqual(table, {
    'First usable': { main: ['owner-lines'], synthesis: ['claims', 'unsure'] },
    Deepen: { main: ['owner-lines'], synthesis: ['claims', 'unsure'], 'spot-check': ['claims', 'unsure'] },
    'Follow up': { main: ['owner-lines'], synthesis: ['claims', 'unsure'], 'spot-check': ['claims', 'unsure'] },
  });
  const stages = (round: RoundKind) => Object.fromEntries(ROUND_STAGES[round].map((s) => [s, stageBlocksOf(s, round)]).filter(([, b]) => (b as string[]).length));
  // CN (E152): the synthesis and the spot-check also get what the lanes marked Unsure.
  assert.deepEqual(stages('First usable'), { orientation: ['owner-lines'], reconcile: ['owner-lines', 'unnumbered'] });
  assert.deepEqual(stages('Deepen'), { orientation: ['owner-lines'], 'cross-check': ['owner-lines', 'claims'] });
  assert.deepEqual(stages('Follow up'), { orientation: ['owner-lines'], reconcile: ['owner-lines', 'unnumbered'], 'cross-check': ['owner-lines', 'claims', 'unnumbered'] });
  assert.deepEqual(stageBlocksOf('synthesis', 'Deepen'), [], 'the handover gives the main agent no list: they go to the synthesis job');
});

test('the owner’s lines: the lane with the Owner’s words slot judges them — one about the product an Owner’s words item, one about how work runs reported for a rule (CM)', () => {
  // The list left the main agent's context (96K characters, pasted four times on the gated run): the lane that holds
  // `reference:Owner's words` gets it with its brief, and the main agent writes the rules that lane reports.
  for (const kind of ['slot', 'topic'] as const) {
    const lane = laneSkill(kind);
    assert.match(lane, /A line about what the product is becomes an Owner's words item/, `${kind}: the lane writes the Owner’s words`);
    assert.match(lane, /\*\*Lines that set a working rule\*\*/, `${kind}: and reports the lines that set a rule`);
    assert.match(lane, /Other people's words are not the owner's/, 'an agent’s words the owner quoted or pasted are not the owner’s');
  }
  for (const stage of ['orientation', 'reconcile', 'cross-check'] as const) {
    assert.match(stageSkill(stage), /Write as rules the lines the Owner's words lane reported under "Lines that set a working rule": `pk_write_rule`, basis Explicit, the owner's own words as the excerpt, the session segment as the source\./, `${stage} writes the rules from that report`);
  }
});

test('a claim that something was not handled is checked against what later names its items', () => {
  const handled = /An item a later commit names is (?:reported with that commit, as )?handled or partly handled/;
  assert.match(stageSkill('cross-check'), handled);
  assert.match(stageSkill('cross-check'), /Never report it as unhandled/);
  assert.match(synthesisSkill(), handled);
  assert.match(spotCheckSkill(), /An item a later commit names is \*\*Wrong as written\*\*, whether or not it is in the sample/);
  for (const kind of ['plan', 'topic', 'follow-up'] as const) {
    assert.match(laneSkill(kind), /ask the ledger for the later commits and reports that name it \(`pk_ledger_numbers` num, `pk_ledger_commits` num\)/, `a ${kind} lane checks before it reports no follow-up`);
  }
  assert.match(stageSkill('orientation'), /Before writing \(c\) for an item a report or QC named[^\n]*ask the ledger for the later commits and reports that name it/, 'and the uniform verdict orientation writes into every brief says so');
  assert.match(stageSkill('dig'), /Before writing \(c\), the lane checks the later commits and reports that name the item/, 'as does a brief the dig writes');
});

test('work merged without a task number: the owner’s rule, and what the parent of a folded fix is', () => {
  const reconcile = stageSkill('reconcile');
  assert.match(reconcile, /It needs a work item of its own\*\* when it changes the system's behaviour, a contract or the architecture, or is clearly worth tracking later/);
  assert.match(reconcile, /It may fold into its parent\*\* when it is a pure repair, a test-stability fix, or a supporting fix that an existing task needed to finish/);
  assert.match(reconcile, /List it in the parent's results[^\n]*A fix folded in without being listed there does not meet the rule/);
  assert.match(reconcile, /The parent is the work whose contract or files the piece served/);
  assert.match(reconcile, /A fix of a QC's findings serves the work the QC checked, not the QC\./, 'test-C-1 tied k-longout to the QC AX as its Fix');
  assert.match(reconcile, /is judged commit by commit/, 'k-clerk’s own commits were core work, repairs and test fixes at once');
  assert.match(stageSkill('cross-check'), /Work merged without a task number\.\*\* Apply the owner's rule to each piece the program lists/, 'a Follow up’s cross-check, whose skeleton may not run');
});
