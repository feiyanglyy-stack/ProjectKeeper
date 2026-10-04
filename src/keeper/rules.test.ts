/**
 * Small pure helpers the views and the context will read the project's rules through (Spec §1.15, §3.7, §6.7, §7.3;
 * CKC-21 AC-9, AC-11): the three groups in their fixed order, the owner's own summarized way of working first,
 * replaced rules apart; and which entry of the organizing plan settles a given material by rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planEntryFor, rulesByGroup } from './rules.ts';
import type { OrganizingPlanContent, ProjectRule } from '../model/types.ts';

const rule = (id: string, over: Partial<ProjectRule>): ProjectRule => ({
  id, projectId: 'p1', group: 'Working rules', category: null, summary: id, excerpt: null, sourceIds: ['src_1'], appliesTo: ['the project'],
  basis: 'Explicit', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null,
  jobId: null, asOf: '', updatedAt: '', ...over,
});

test('rules come in the three fixed groups, the owner’s own way of working first, replaced rules apart, and no empty group (CKC-21 AC-11)', () => {
  const groups = rulesByGroup([
    rule('mined_numbering', { group: 'Working rules', basis: 'Inferred' }),
    rule('material_vendor', { group: 'Material rules', category: 'Reference only' }),
    rule('mined_single', { group: 'How work is organized' }),
    rule('owner_roles', { group: 'How work is organized', ownerSystem: 'the owner’s role system' }),
    rule('old_numbering', { group: 'Working rules', validity: 'Replaced', replacedBy: 'mined_numbering' }),
  ]);
  assert.deepEqual(groups.map((g) => g.group), ['How work is organized', 'Working rules', 'Material rules']);
  assert.deepEqual(groups[0]!.rules.map((r) => r.id), ['owner_roles', 'mined_single'], 'what the owner summarized comes first');
  assert.deepEqual(groups[1]!.rules.map((r) => r.id), ['mined_numbering']);
  assert.deepEqual(groups[1]!.replaced.map((r) => r.id), ['old_numbering'], 'a replaced rule is kept apart, not beside the new one');
  assert.deepEqual(rulesByGroup([rule('only', { group: 'Material rules', category: 'Obsolete' })]).map((g) => g.group), ['Material rules'], 'a group the project has no rule in does not appear');
});

test('the plan entry that settles a material by rule covers its directory or the file itself, and nothing beside it', () => {
  const plan: OrganizingPlanContent = {
    byRule: [
      { what: 'the vendored library', targets: ['vendor/chartlib/'], ruleId: 'rule_vendor', treatment: 'Reference only' },
      { what: 'kept for recovery', targets: ['attic', 'docs/OLD.md'], ruleId: 'rule_attic', treatment: 'History only' },
    ],
    readClosely: [], focus: [], order: [],
  };
  assert.equal(planEntryFor(plan, 'vendor/chartlib/README.md')?.ruleId, 'rule_vendor');
  assert.equal(planEntryFor(plan, 'vendor\\chartlib\\docs\\api.md')?.ruleId, 'rule_vendor', 'either slash');
  assert.equal(planEntryFor(plan, 'attic/export-v1.md')?.ruleId, 'rule_attic');
  assert.equal(planEntryFor(plan, 'docs/OLD.md')?.ruleId, 'rule_attic', 'a file named on its own');
  assert.equal(planEntryFor(plan, 'vendor/chartlib-fork/README.md'), null, 'a sibling that only starts with the same letters is not covered');
  assert.equal(planEntryFor(plan, 'attic-notes.md'), null);
  assert.equal(planEntryFor(plan, 'docs/OLD.md.bak'), null);
});
