/**
 * The project's material rules applied to the sources they cover (Spec §1.15 "怎样施行"; CKC-04 AC-14, CKC-02 AC-23):
 * what a `Recovery only` rule covers — directories, files or branches — is `History only` (§1.2), what a `Reference
 * only` rule covers is `Reference only`, and the source names the rule (`usedAsByRuleId`). Rules are usually written by
 * the framing round after intake, so this runs after every intake and whenever the scope is decided again (a rule or a
 * scope classification written or changed), after the scope decision.
 *
 * Which rule: rules in force, of either basis. The project's written rule (`Explicit`) prevails over one the Keeper
 * inferred (`Inferred`) wherever both cover a source; the Keeper's inference fills in only where the project's rules say
 * nothing (§1.15), and the rule the source names says it is inferred. Two rules of different kinds covering a source
 * equally are a conflict between the project's rules, which the program does not settle (§1.15: both stay). `Other`
 * rules say in words what they do, so they are left to the Keeper.
 *
 * What it does with a `Used as` someone already gave — the most conservative reading of the Spec, as the instructions
 * for this work asked:
 * - the owner's own judgement stands: of the source (`usedAsBy: 'owner'`), and of its location — a location the owner
 *   classified is what the owner said, so a `Recovery only` rule does not take it out of the current material;
 * - the Keeper's own judgement *by a rule* (it named one) stands: the program does not argue with it;
 * - what the scope set by the location's classification (§1.1: third-party documents are `Reference only`, marked by
 *   `usedAsByScopeItemId`) stays when the rule says the same; where the rule says otherwise, the project's rule prevails
 *   over the Keeper's classification, and the scope's mark goes so the scope does not take it back;
 * - the Keeper's own inference gives way to the project's rule (§1.15); the trace keeps what it was;
 * - what the program itself set by a rule that no longer covers the source (replaced, withdrawn, narrowed) goes back to
 *   what its location sets, else `Not yet judged`, so the source is judged again.
 *
 * A source the program judged carries `usedAsBy: null` with `usedAsByRuleId` set; the Keeper's own carry `keeper`.
 */
import type { Project, ProjectRule, Source } from '../model/types.ts';
import type { UsedAs } from '../model/vocab.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { innermostItem, readingOf } from '../scope/skip.ts';
import { gitBranch } from '../util/git.ts';
import { sep } from 'node:path';
import { isWithin, relativeDisplay } from '../util/paths.ts';

const TREATMENT: Partial<Record<string, UsedAs>> = { 'Recovery only': 'History only', 'Reference only': 'Reference only' };

interface Entry { readonly kind: 'path' | 'branch' | 'absolute'; readonly value: string; readonly glob: RegExp | null }

/**
 * What a rule applies to, entry by entry. `locations`: the project's own, by which an absolute path of a system whose
 * paths start at `/` is told from a path written from the project's root with a leading slash — `/Users/sam/orchard/attic`
 * lies in the project, `/attic` does not. (A Windows path says it is absolute by its drive.)
 */
function entriesOf(rule: ProjectRule, locations: readonly string[]): Entry[] {
  const out: Entry[] = [];
  for (const raw of rule.appliesTo) {
    let v = raw.trim().replace(/^[`'"“”‘’]+|[`'"“”‘’]+$/g, '').trim();
    if (!v) continue;
    const branch = /^(?:(?:branch(?:es)?|分支)\s*[:：]?\s*|refs\/heads\/)(.+)$/i.exec(v);
    if (branch) { const name = branch[1]!.trim().replace(/^[`'"“”‘’]+|[`'"“”‘’]+$/g, '').toLowerCase(); out.push({ kind: 'branch', value: name, glob: globOf(name) }); continue; }
    if (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\') || (sep === '/' && v.startsWith('/') && !/[*?]/.test(v) && locations.some((l) => isWithin(l, v)))) { out.push({ kind: 'absolute', value: v, glob: null }); continue; }
    v = v.split('\\').join('/').replace(/^\.\/+/, '').replace(/\/(\*\*?)?$/, '').replace(/\/+$/, '').toLowerCase();
    if (!v || v === '.' || v === '*' || v === '**') continue;
    out.push({ kind: 'path', value: v, glob: globOf(v) });
  }
  return out;
}

function globOf(v: string): RegExp | null {
  if (!/[*?]/.test(v)) return null;
  const re = v.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`);
}

/** How specifically an entry covers a source: a branch covers the whole checkout (it wins); a longer path is more specific. */
function coverage(e: Entry, paths: readonly string[], abs: string, branch: string | null): number | null {
  if (e.kind === 'branch') return branch && (branch === e.value || e.glob?.test(branch)) ? Number.MAX_SAFE_INTEGER : null;
  if (e.kind === 'absolute') return isWithin(e.value, abs) ? e.value.length : null;
  for (const p of paths) {
    if (p === e.value || p.startsWith(`${e.value}/`)) return e.value.length;
    if (e.glob) {
      const segs = p.split('/');
      for (let i = 1; i <= segs.length; i++) if (e.glob.test(segs.slice(0, i).join('/'))) return e.value.length;
    }
  }
  // A bare name may be a branch (the project names its branches as it names its folders).
  if (branch && !e.value.includes('/') && branch === e.value) return Number.MAX_SAFE_INTEGER;
  return null;
}

type Covering = { readonly rule: ProjectRule; readonly usedAs: UsedAs };

/** The most specific of these rules covering the source; null when none does or two kinds cover it equally. */
function mostSpecific(rules: readonly ProjectRule[], locations: readonly string[], paths: readonly string[], abs: string, branch: string | null): { found: Covering | null; covered: boolean } {
  let best: (Covering & { score: number }) | null = null;
  let tied = false;
  for (const rule of rules) {
    const usedAs = TREATMENT[rule.category ?? '']!;
    for (const e of entriesOf(rule, locations)) {
      const score = coverage(e, paths, abs, branch);
      if (score === null) continue;
      if (!best || score > best.score) { best = { rule, usedAs, score }; tied = false; }
      else if (score === best.score && usedAs !== best.usedAs) tied = true;
    }
  }
  return { found: best && !tied ? { rule: best.rule, usedAs: best.usedAs } : null, covered: best !== null };
}

/**
 * The rule that covers this source and what it makes of it, or null: no rule, or rules of different kinds covering it
 * equally. The project's written rules are asked first; the Keeper's inferred rules only where no written rule covers
 * the source at all — a conflict between written rules is not settled by an inference.
 */
function coveringRule(rules: readonly ProjectRule[], s: Source, project: Project, branchOf: (scopeItemId: string) => string | null): Covering | null {
  if (s.anchor.kind !== 'file') return null;
  const abs = s.anchor.path;
  const roots = [...project.locations, ...project.scope.filter((i) => i.id === s.scopeItemId).map((i) => i.path)].filter((r) => isWithin(r, abs));
  const paths = [...new Set(roots.map((r) => relativeDisplay(r, abs).toLowerCase()))];
  const branch = branchOf(s.scopeItemId);
  const written = mostSpecific(rules.filter((r) => r.basis === 'Explicit'), project.locations, paths, abs, branch);
  if (written.covered) return written.found;
  return mostSpecific(rules.filter((r) => r.basis !== 'Explicit'), project.locations, paths, abs, branch).found;
}

/** The owner classified the source's location as something other than left out: a `Recovery only` rule does not take it out. */
function ownerKeepsLocation(project: Project, path: string): boolean {
  const item = innermostItem(project.scope, path);
  return item?.classification?.by === 'owner' && item.relation !== 'Excluded';
}

/** Apply the material rules in force to every file source; returns how many sources changed. */
export function applyMaterialRules(store: ProjectStore, project: Project): number {
  const rules = store.rules.filter((r) => r.group === 'Material rules' && r.validity === 'Current' && TREATMENT[r.category ?? ''] !== undefined);
  const branches = new Map<string, string | null>();
  const byBranch = rules.some((r) => entriesOf(r, project.locations).some((e) => e.kind === 'branch' || (e.kind === 'path' && !e.value.includes('/'))));
  const branchOf = (scopeItemId: string): string | null => {
    if (!byBranch) return null;
    if (!branches.has(scopeItemId)) {
      const item = project.scope.find((i) => i.id === scopeItemId);
      branches.set(scopeItemId, item && (item.category === 'Repository' || item.category === 'Worktree') && !item.missing ? gitBranch(item.path)?.toLowerCase() ?? null : null);
    }
    return branches.get(scopeItemId) ?? null;
  };
  let changed = 0;
  for (const s of store.sources.all()) {
    if (s.anchor.kind !== 'file') continue;
    const path = s.anchor.path;
    const found = coveringRule(rules, s, project, branchOf);
    const by = found && !(found.usedAs === 'History only' && ownerKeepsLocation(project, path)) ? found : null;
    const scopeMark = s.usedAsByScopeItemId ?? null;
    if (by) {
      if (s.usedAsBy === 'owner') continue;                                    // the owner judged this source, or classified its location
      if (scopeMark && s.usedAs === by.usedAs) continue;                         // its location makes it the same already: that mark stays
      if (!scopeMark && s.usedAsBy === 'keeper' && s.usedAsByRuleId) continue;  // the Keeper judged it by a rule it named
      if (s.usedAs === by.usedAs && s.usedAsByRuleId === by.rule.id && s.usedAsBy === null && !scopeMark) continue;
      const was = s.usedAs && s.usedAs !== by.usedAs
        ? `; it was ${s.usedAs}${scopeMark ? ' by its location’s classification' : s.usedAsBy === 'keeper' ? ' by the Keeper’s own judgement' : ''}`
        : '';
      store.sources.put({ ...s, usedAs: by.usedAs, usedAsBy: null, usedAsByRuleId: by.rule.id, usedAsByScopeItemId: null }, {
        jobId: null, basisSourceIds: [s.id, ...by.rule.sourceIds],
        summary: `Used as ${by.usedAs} by rule ${by.rule.id} (${by.rule.category}, ${by.rule.basis}: ${by.rule.summary.slice(0, 80)})${was}`,
      });
      changed++;
    } else if (s.usedAsBy === null && s.usedAsByRuleId && !scopeMark) {
      // What its location sets comes back (third-party documents are Reference only, §1.1); otherwise it is judged again.
      const located = readingOf(project.scope, path).usedAs;
      store.sources.put({ ...s, usedAs: located?.value ?? null, usedAsBy: located?.by ?? null, usedAsByRuleId: null, usedAsByScopeItemId: located?.scopeItemId ?? null }, {
        jobId: null, basisSourceIds: [s.id],
        summary: `${located ? `Used as ${located.value} by its location again` : 'Not yet judged again'}: rule ${s.usedAsByRuleId}, by which it was ${s.usedAs}, no longer covers it (replaced, withdrawn or narrowed, or the owner kept the location)`,
      });
      changed++;
    }
  }
  return changed;
}
