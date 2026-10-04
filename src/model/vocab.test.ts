/**
 * The fixed vocabularies Spec v2.8 adds (§1.2, §1.5, §1.6, §1.11, §1.15, §2.1, §2.2). They are the interface's fixed
 * words, the same in every project, so each list is compared whole: a missing word and a stray one fail alike.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vocab from './vocab.ts';

test('Used as, validity, node category, relation type and mark kind carry the v2.8 words', () => {
  assert.deepEqual([...vocab.USED_AS], [
    'Purpose', 'Decision', 'Requirement', 'Design', 'Plan', 'Task', 'Status', 'Code', 'Test', 'QC', 'Session',
    'Run result', 'Reference only', 'History only', 'Other',
  ]);
  assert.ok((vocab.VALIDITY as readonly string[]).includes('Removed'), 'validity Removed (§2.1, D61)');
  assert.equal(vocab.NODE_CATEGORY[0], "Owner's words", 'the owner’s words are the top layer (§1.5, D63)');
  assert.equal(vocab.REFERENCE_CATEGORY[0], "Owner's words", 'and a product reference category (§1.3)');
  assert.ok((vocab.RELATION_TYPE as readonly string[]).includes('carries out'), 'relation carries out (§1.6)');
  assert.ok((vocab.MARK_KIND as readonly string[]).includes('Decided without owner'), 'mark Decided without owner (§1.11)');
});

test('a decision’s carry-out and the project’s rules have their own fixed words', () => {
  const v = vocab as unknown as Record<string, readonly string[] | undefined>;
  assert.deepEqual([...(v.CARRY_OUT ?? [])], ['Carried out', 'Partly carried out', 'Not carried out yet'], '§2.2');
  assert.deepEqual([...(v.RULE_GROUP ?? [])], ['How work is organized', 'Working rules', 'Material rules'], '§6.7, §7.3; CKC-21');
  assert.deepEqual([...(v.MATERIAL_RULE ?? [])], ['Obsolete', 'Reference only', 'Recovery only', 'Authoritative', 'Untrusted', 'Declared open', 'Other'], '§1.15');
});

test('the graph’s scales are Overview, Work and Compare, as the workbench offers them; the Change view went with D48 (§6.3)', () => {
  assert.deepEqual([...vocab.GRAPH_SCALE], ['Overview', 'Work', 'Compare']);
});
