/**
 * What the prompts that remain beside the clerk method tell the Keeper (Spec §2.4, §3.4; CKC-08 AC-22–AC-24; batch A
 * item 4): the product re-look starts from the owner's words, and an answer to an execution agent records what the
 * agent says as its claim. The tools refuse a bad write; nothing but these words tells the Keeper the method in the
 * first place. The prompts of the material rounds this file also checked went with those rounds (CKC-06, replaced by
 * the clerk method, whose prompts are in clerk-prompts.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relookPrompt } from '../relook/prompts.ts';
import { turnPrompt } from '../jobs/answering.ts';
import type { Project } from '../../model/types.ts';

const positioning = 'Project: Harbour (root D:\\harbour)';

const has = (prompt: string, words: readonly (string | RegExp)[], name: string, what: string) => {
  for (const w of words) assert.ok(typeof w === 'string' ? prompt.includes(w) : w.test(prompt), `${name} is told ${what}: missing ${String(w)}`);
};

test('the re-look starts from the owner’s words, measures drift against them, asks about rules set without the owner and cites reports as reported (Spec §3.4; CKC-08 AC-22–AC-24)', () => {
  const p = relookPrompt(positioning, 'Whole project', 'jdg_1', '(inputs)', true, false);
  has(p, [/starting from the owner’s words/, /measured against the owner’s words/, /agrees with the PRD is not/], 'the re-look', 'the upward comparison');
  has(p, ['Decided without owner', 'For your decision', /one note per matter/], 'the re-look', 'what to do with a rule set without the owner');
  has(p, [/who reported it and when/, /the code does/, /not whether anyone was honest/], 'the re-look', 'how a note cites a report');
});

test('an execution agent’s statement is recorded as its claim, with who and when (Spec §2.4; batch A item 4)', () => {
  const p = turnPrompt({ project: { name: 'Harbour' } as unknown as Project, text: 'the pack is wrong', ownerSourceId: 'src_q', context: null, contextSummary: null, first: true, asker: 'agent' });
  has(p, ['claimedBy', 'claimedAt'], 'the answer to an agent', 'that the agent’s claim says who and when');
});
