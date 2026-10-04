/**
 * The project's own rules (Spec §1.15; D62, D64; CKC-21): the checks that keep an object judged "by a rule" honest,
 * and small pure helpers for the views and the context to read the rules through. Deterministic; no model.
 */
import type { OrganizingPlanContent, ProjectRule } from '../model/types.ts';
import { RULE_GROUP, type MaterialRule, type RuleGroup } from '../model/vocab.ts';
import type { ProjectStore } from '../store/project-store.ts';

/**
 * What an object is judged to be by a rule, and which rule categories say so (§1.15, "怎样施行"). `Other` is "apply as
 * the rule says", so it can stand behind any of them. Uses the Spec does not tie to a category accept any rule.
 */
const RULE_USE = {
  'Reference only': { label: 'Reference only by a rule', needs: ['Reference only', 'Other'] },
  'History only': { label: 'History only by a rule', needs: ['Recovery only', 'Other'] },
  'Removed': { label: 'Removed by a rule', needs: ['Recovery only', 'Other'] },
  'Progress': { label: 'Progress by a rule', needs: ['Authoritative', 'Other'] },
  'Untrusted claim': { label: 'A claim from an untrusted source', needs: ['Untrusted'] },
  'Validity': { label: 'Validity by a rule', needs: null },
  'Used as': { label: 'Used as by a rule', needs: null },
} as const satisfies Record<string, { label: string; needs: readonly MaterialRule[] | null }>;
export type RuleUse = keyof typeof RULE_USE;

/** Why this rule cannot be the basis of that judgement, or null when it can. */
export function ruleUseRefusal(store: ProjectStore, ruleId: string, use: RuleUse): string | null {
  const rule = store.rules.get(ruleId);
  if (!rule) return `${ruleId} names no rule in the assets. Record the project’s rule first (pk_write_rule), then judge by it.`;
  if (rule.validity !== 'Current') {
    return `${ruleId} (“${rule.summary}”) is ${rule.validity}, not in force${rule.replacedBy ? `: ${rule.replacedBy} replaced it` : ''}. Judge by the rule in force (a changed rule is Replaced and points to the new one).`;
  }
  const { label, needs } = RULE_USE[use];
  if (needs && !(rule.category && (needs as readonly string[]).includes(rule.category))) {
    const wanted = needs[0]!;
    return `${label} needs ${/^[AEIOU]/.test(wanted) ? 'an' : 'a'} ${wanted} rule${needs.length > 1 ? ` (or one of category ${needs.slice(1).join(', ')})` : ''}; ${ruleId} (“${rule.summary}”) is ${rule.category ? `a ${rule.category} rule` : `one of ${rule.group}`}.`;
  }
  return null;
}

/**
 * Whether pointing `id` at `replacedBy` would close a circle: following `replacedBy` from the new successor leads back
 * to `id`. A rule is never replaced by itself or, through others, by something it replaced.
 */
export function replacementCircle(store: ProjectStore, id: string, replacedBy: string): boolean {
  let current: string | null = replacedBy;
  const seen = new Set<string>();
  while (current) {
    if (current === id) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = store.rules.get(current)?.replacedBy ?? null;
  }
  return false;
}

export interface RuleGroupView {
  readonly group: RuleGroup;
  /** The rules shown: in force or proposed, the owner's own summarized way of working first. */
  readonly rules: readonly ProjectRule[];
  /** Replaced rules, struck through and pointing to their successors; shown collapsed. */
  readonly replaced: readonly ProjectRule[];
}

/**
 * The rules in the three fixed groups and their order (§6.7, §7.3; CKC-21 AC-9, AC-11). What the owner summarized
 * (`ownerSystem`) comes first in its group; a group the project has no rule in does not appear. Rules given up
 * otherwise (`Abandoned`, `Removed`) are not shown.
 */
export function rulesByGroup(rules: readonly ProjectRule[]): RuleGroupView[] {
  const shown = (r: ProjectRule) => r.validity !== 'Replaced' && r.validity !== 'Abandoned' && r.validity !== 'Removed';
  return RULE_GROUP.map((group) => {
    const mine = rules.filter((r) => r.group === group);
    const inForce = mine.filter(shown);
    return {
      group,
      rules: [...inForce.filter((r) => r.ownerSystem), ...inForce.filter((r) => !r.ownerSystem)],
      replaced: mine.filter((r) => r.validity === 'Replaced'),
    };
  }).filter((g) => g.rules.length > 0 || g.replaced.length > 0);
}

const normalizePath = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();

/**
 * The plan entry that settles this material by rule (§3.7, D62), or null: a target covers its own path and everything
 * under it when it is a directory. Paths are relative to the project, compared without regard to slash direction or
 * case. A target that names a branch or anything else that is not a path covers no file.
 */
export function planEntryFor(plan: OrganizingPlanContent, relPath: string): OrganizingPlanContent['byRule'][number] | null {
  const path = normalizePath(relPath);
  for (const entry of plan.byRule) {
    for (const t of entry.targets) {
      const target = normalizePath(t);
      if (target && (path === target || path.startsWith(`${target}/`))) return entry;
    }
  }
  return null;
}
