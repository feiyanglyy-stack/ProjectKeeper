/**
 * A location that lies in a place the project's own ignore rules leave out (Spec §1.1, D105; CKC-04 AC-17, CKC-07
 * AC-10): the usual case is a worker's worktree under an ignored directory (`.worktrees/K-cq` in a repository whose
 * `.gitignore` says `.worktrees/`). Its working files are not pending material — a change in them is not listed, starts
 * no round and is in no Follow up — while its branch and commits still reach the ledger from version control, and its
 * commits the trunk does not have still wait like any commit.
 *
 * The scan and the watcher already ask a location's own repository about each file (./ignore.ts); what they did not ask
 * is whether the location itself sits where a repository around it ignores. That is asked here, of git, for every
 * repository in scope that holds the location, nested ones included — outward until a repository of its own is reached:
 * a nested repository belongs by its own history (§1.1), so the rules of the one around it stop at it, and a nested
 * repository the outer one ignores (`/app/`) is still read. Not left out: what the owner took in, what the Keeper judged
 * the project's material (`overridesIgnoreRules`), and a place kept for recovery only (read as history, D82).
 *
 * Read-only: `git check-ignore` through `git()`.
 */
import type { ScopeItem } from '../model/types.ts';
import { isWithin, pathKey, relativeDisplay } from '../util/paths.ts';
import { ignoreRules, type IgnoreRule } from './ignore.ts';
import { overridesIgnoreRules, treatmentOf } from './skip.ts';

export interface IgnoredPlace {
  /** The rule that leaves the location out. */
  readonly rule: IgnoreRule;
  /** The scope item whose repository the rule belongs to. */
  readonly by: ScopeItem;
}

/** What git said about a location, kept a short while: the watcher asks for every file event, the coverage at every pass. */
const asked = new Map<string, { at: number; rule: IgnoreRule | null }>();
const KEEP_MS = 20_000;

/** Forget what git said (a test that changes an ignore file within the keep time). */
export function forgetIgnoredPlaces(): void { asked.clear(); }

function ruleFor(root: string, rel: string, now: number): IgnoreRule | null {
  const key = `${pathKey(root)}\n${rel}`;
  const had = asked.get(key);
  if (had && now - had.at < KEEP_MS) return had.rule;
  const rule = ignoreRules(root, [rel]).get(rel) ?? null;
  asked.set(key, { at: now, rule });
  return rule;
}

const locational = (scope: readonly ScopeItem[]) => scope.filter((i) => i.category !== 'Session source');

/** Its own choice to take in what the rules leave out, or a place read as history: the rules around it do not apply. */
const standsApart = (scope: readonly ScopeItem[], item: ScopeItem) => overridesIgnoreRules(scope, item) || treatmentOf(item) === 'history';

/**
 * The ignore rule of a repository in scope that leaves this item's own location out, or null. A repository of its own is
 * never left out this way; the walk outward stops at the first repository, and at an item the owner took in.
 */
export function ignoredPlaceOf(scope: readonly ScopeItem[], item: ScopeItem, now = Date.now()): IgnoredPlace | null {
  if (item.category === 'Session source' || item.category === 'Repository' || standsApart(scope, item)) return null;
  const around = locational(scope)
    .filter((o) => o !== item && !o.missing && o.path.length < item.path.length && isWithin(o.path, item.path))
    .sort((a, b) => b.path.length - a.path.length);
  for (const o of around) {
    if (standsApart(scope, o)) return null;
    if (o.versionControl !== 'none') {
      const rule = ruleFor(o.path, relativeDisplay(o.path, item.path), now);
      if (rule) return { rule, by: o };
    }
    if (o.category === 'Repository') return null;
  }
  return null;
}

/**
 * For many paths at once (the coverage's list of what waits): the ignored place a file lies in, or null. Each scope item
 * is asked about once.
 */
export function ignoredPlaceLookup(scope: readonly ScopeItem[]): (path: string) => IgnoredPlace | null {
  const deepestFirst = locational(scope).sort((a, b) => b.path.length - a.path.length);
  // Only an item that is no repository of its own, inside another location, can lie in an ignored place.
  const candidates = deepestFirst.filter((i) => i.category !== 'Repository' && deepestFirst.some((o) => o !== i && o.path.length < i.path.length && isWithin(o.path, i.path)));
  if (candidates.length === 0) return () => null;
  const byItem = new Map<string, IgnoredPlace | null>();
  const now = Date.now();
  return (path: string) => {
    const item = deepestFirst.find((i) => isWithin(i.path, path));
    if (!item || !candidates.includes(item)) return null;
    let place = byItem.get(item.id);
    if (place === undefined) { place = ignoredPlaceOf(scope, item, now); byItem.set(item.id, place); }
    return place;
  };
}

/** `.gitignore line 2: .worktrees/` — the rule as the scope list names it. */
export function ruleText(rule: IgnoreRule): string {
  return `${rule.file} line ${rule.line}: ${rule.pattern}`;
}
