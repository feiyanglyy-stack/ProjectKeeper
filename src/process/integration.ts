/**
 * How each commit reached the trunk (Spec v3.0 §1.16 row 1; §2.12 `Merged`): the merges that brought it in, innermost
 * first, and the branch each one names.
 *
 * A branch is often merged into an integration branch that is then merged into the trunk (ContextKeeper's k-clerk-tools
 * → k-clerk → main). The ledger's `introducedBy` gives only the last of these, the trunk's merge, for everything under
 * it; the merge a piece of work was integrated by is the innermost one — of the merges that brought a commit in, the one
 * that brought in the fewest commits. A merge of the trunk into a branch (`Merge main into b-scope`, `Merge main (AQ)
 * into k-clerk`) only keeps that branch up to date and integrates nothing: it is left out.
 *
 * The walk stays inside what each trunk merge brought in: a merge nested under it can only bring in commits of that set,
 * so the cost follows the size of the branches, not of the whole history.
 *
 * Everything here is a fact of the ledger's commit graph; nothing is judged.
 */
import type { CommitFact, Facts } from './facts.ts';

export interface Integration {
  /** The merge commit. */
  readonly merge: CommitFact;
  /** The branch it merged, as its subject names it (`Merge branch 'k-longout'`, `Merge k-ayfix-a (…)`), else the branch whose tip is its second parent. */
  readonly source: string | null;
  /** The branch it merged into, when its subject says (`… into k-clerk`). */
  readonly target: string | null;
  /** Every commit it brought into its first parent's line (merges among them), by full hash. */
  readonly brought: ReadonlySet<string>;
}

export interface Integrations {
  /** The integrating merges, oldest first; the merges that only bring the trunk into a branch are not among them. */
  readonly merges: readonly Integration[];
  /** The innermost integrating merge of each commit one brought in. */
  readonly innermost: ReadonlyMap<string, Integration>;
  /** The integrating merges that brought a commit in, innermost first (the trunk's own merge last). */
  chainOf(hash: string): readonly Integration[];
  /** The trunk's own merge (on its first-parent line) that brought a commit in, or the commit itself when it is on that line. */
  trunkMergeOf(hash: string): CommitFact | null;
}

/** The branch names a merge's subject gives: `Merge branch 'x' into y`, `Merge pull request #n from u/x`, `Merge x into y: …`, `Merge x (…)`. */
export function mergeSubjectBranches(subject: string): { source: string | null; target: string | null } {
  const s = subject.trim();
  const quoted = /^Merge (?:remote-tracking )?branch(?:es)? '([^']+)'(?:\s+(?:of\s+\S+\s+)?into\s+'?([^'\s:(]+)'?)?/i.exec(s);
  if (quoted) return { source: quoted[1]!, target: quoted[2] ?? null };
  const pull = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/i.exec(s);
  if (pull) return { source: pull[1]!, target: null };
  // `Merge k-clerk into k-ledger: …`, `Merge k-ayfix-a (…)`, `Merge k-clerk: …`, `Merge main (AQ) into k-clerk`.
  const plain = /^Merge\s+([A-Za-z0-9][\w./-]*)(?=\s*(?:[:：(]|\binto\b|$))(?:\s*\([^)]*\))?(?:\s+into\s+([\w./-]+))?/i.exec(s);
  if (plain && !/^(?:branch|branches|pull|remote-tracking)$/i.test(plain[1]!)) return { source: plain[1]!, target: plain[2] ?? null };
  return { source: null, target: null };
}

const plainBranch = (name: string): string => name.replace(/^(?:refs\/)?(?:heads\/|remotes\/[^/]+\/|origin\/|upstream\/)/, '');

/** Whether a branch name is the trunk of its repository (a merge of it into a branch only keeps that branch up to date). */
function isTrunkName(name: string, trunk: string | null): boolean {
  const n = plainBranch(name).toLowerCase();
  return n === (trunk ?? '').toLowerCase() || n === 'main' || n === 'master' || n === 'trunk' || n === 'head';
}

export function integrationsOf(facts: Facts): Integrations {
  const trunkName = new Map(facts.ledger.repos().map((r) => [r.id, r.trunk]));
  const tipNames = new Map<string, string[]>();
  for (const b of facts.branches) {
    const name = b.namespace === 'remotes' ? b.name.replace(/^[^/]+\//, '') : b.name;
    if (name === 'HEAD') continue;
    tipNames.set(b.tip, [...new Set([...(tipNames.get(b.tip) ?? []), name])]);
  }
  // What each merge of the trunk's first-parent line brought in.
  const members = new Map<string, Set<string>>();
  for (const [h, by] of facts.introducedBy) {
    if (h === by) continue;
    const s = members.get(by) ?? new Set<string>();
    s.add(h);
    members.set(by, s);
  }
  /** Every commit reachable from `from` without leaving `inside`. */
  const walk = (from: readonly string[], inside: ReadonlySet<string>, stop: ReadonlySet<string> | null): Set<string> => {
    const seen = new Set<string>();
    const stack = from.filter((h) => inside.has(h));
    while (stack.length) {
      const h = stack.pop()!;
      if (seen.has(h) || stop?.has(h)) continue;
      seen.add(h);
      for (const p of facts.commits.get(h)?.parents ?? []) if (inside.has(p)) stack.push(p);
    }
    return seen;
  };
  const merges: Integration[] = [];
  const describe = (c: CommitFact, brought: Set<string>): void => {
    if (brought.size === 0) return;
    const named = mergeSubjectBranches(c.subject);
    const byTip = c.parents.slice(1).flatMap((p) => tipNames.get(p) ?? []).filter((n) => !isTrunkName(n, trunkName.get(c.repo) ?? null));
    const source = named.source ?? byTip[0] ?? null;
    if (source && isTrunkName(source, trunkName.get(c.repo) ?? null)) return;
    merges.push({ merge: c, source: source ? plainBranch(source) : null, target: named.target ? plainBranch(named.target) : null, brought });
  };
  for (const [by, set] of members) {
    const top = facts.commits.get(by);
    if (!top || !top.merge) continue;
    describe(top, set);
    for (const h of set) {
      const c = facts.commits.get(h)!;
      if (!c.merge || c.parents.length < 2) continue;
      const base = walk([c.parents[0]!], set, null);
      describe(c, walk(c.parents.slice(1), set, base));
    }
  }
  merges.sort((a, b) => a.merge.ms - b.merge.ms || a.merge.hash.localeCompare(b.merge.hash));
  const chains = new Map<string, Integration[]>();
  for (const m of merges) for (const h of m.brought) chains.set(h, [...(chains.get(h) ?? []), m]);
  const innermost = new Map<string, Integration>();
  for (const [h, list] of chains) {
    list.sort((a, b) => a.brought.size - b.brought.size || a.merge.ms - b.merge.ms);
    innermost.set(h, list[0]!);
  }
  return {
    merges,
    innermost,
    chainOf: (hash) => chains.get(hash) ?? [],
    trunkMergeOf(hash: string): CommitFact | null {
      const c = facts.commits.get(hash);
      if (!c || !c.onTrunk) return null;
      const by = facts.introducedBy.get(hash);
      return by ? facts.commits.get(by) ?? null : null;
    },
  };
}
