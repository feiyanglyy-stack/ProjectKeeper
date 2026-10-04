/**
 * The ledger's facts the process engine reads (Spec v3.0 §1.16, §2.12), loaded once per computation in a few batched
 * reads, with the indexes the engine needs: every commit with its parents and the merge that brought it into the trunk,
 * the branches each side commit lies on, the execution arrangements (§1.16 row 6), the verdicts, findings and test counts
 * (row 5), the numbers of the units of work (row 4), the document versions (row 2) and the explicit supersessions
 * (row 3).
 *
 * Everything here is a fact of the ledger; nothing is judged. The engine never re-reads git: what the ledger records is
 * read from its tables (read-only, the way `ledger/views.ts` reads code files), and an entry is cited by its ledger id,
 * resolved through `Ledger.resolve` for the label and the time the workbench shows (§2.11).
 *
 * Why direct table reads and not the paged queries: the `Ledger` class has no query for a commit's parent hashes or for
 * the branch rows, and its paged queries cap a page at 500 rows, so a project-wide pass would need hundreds of calls
 * (reported as a query gap).
 */
import { realpathSync } from 'node:fs';
import type { Ledger } from '../ledger/index.ts';
import { isWithin, normalizePath } from '../util/paths.ts';
import { materialTime, msOf } from '../ledger/time.ts';
import type { EvidenceRef, Occurred, OccurredBasis } from '../model/k-types.ts';
import { familyPrefix, rangesIn } from '../ledger/ranges.ts';

// ───────────────────────── row shapes ─────────────────────────

export interface CommitFact {
  readonly repo: string;
  readonly hash: string;
  /** The ledger entry id: `commit:<12>`. */
  readonly id: string;
  readonly short: string;
  readonly parents: readonly string[];
  readonly ms: number;
  readonly occurred: Occurred;
  readonly author: string;
  readonly subject: string;
  readonly body: string;
  readonly merge: boolean;
  readonly onTrunk: boolean;
  /** On the trunk's first-parent line: a direct trunk commit or the merge that brought a branch in. */
  readonly fpTrunk: boolean;
}

export interface BranchFact {
  readonly repo: string;
  readonly name: string;
  readonly namespace: string;
  readonly tip: string;
  readonly merged: boolean | null;
  readonly ahead: number | null;
}

export interface ArrangementFact {
  readonly id: string;
  readonly repo: string | null;
  readonly path: string;
  readonly commit: string | null;
  readonly kind: 'index' | 'prompt' | 'plan' | 'status' | 'receipt' | string;
  readonly ident: string | null;
  readonly parsed: boolean;
  readonly current: boolean;
  readonly ms: number;
  readonly occurred: Occurred;
  readonly data: ArrangementData;
}

/** The parsed fields the ledger keeps for an arrangement version (ledger/arrangements.ts `ArrangementData`). */
export interface ArrangementData {
  readonly title?: string;
  readonly fields?: Readonly<Record<string, string>>;
  readonly status?: string | null;
  readonly agent?: string | null;
  readonly model?: string | null;
  readonly worktree?: string | null;
  readonly baseline?: string | null;
  readonly accepted?: string | null;
  readonly rows?: readonly { readonly id: string; readonly cells: Readonly<Record<string, string>>; readonly line: number }[];
  readonly batches?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly parallel?: readonly string[];
  readonly json?: Readonly<Record<string, unknown>>;
}

export interface VerdictFact {
  readonly id: string;
  readonly repo: string | null;
  readonly path: string;
  readonly kind: 'verdict' | 'count' | 'finding' | string;
  /** Normalised verdict (pass, fail …), a count ("14/14"), or a finding's number ("F-1"). */
  readonly verdict: string | null;
  readonly confidence: 'stated' | 'candidate' | string;
  readonly text: string;
  readonly line: number | null;
  readonly firstCommit: string | null;
  readonly ms: number;
  readonly occurred: Occurred;
  readonly current: boolean;
}

export interface NumFact {
  readonly id: string;
  readonly num: string;
  readonly kind: 'doc' | 'commit' | 'branch' | 'worktree' | 'file-name' | 'loose' | string;
  readonly place: 'definition' | 'mention' | string;
  readonly repo: string | null;
  readonly path: string | null;
  readonly commit: string | null;
  readonly line: number | null;
  readonly context: string;
  readonly confidence: string;
  readonly ms: number;
  readonly occurred: Occurred;
  readonly current: boolean;
}

const NUM_COLUMNS = 'key, num, kind, place, repo, path, commit_hash, line, context, confidence, first_ms, occurred_at, occurred_basis, occurred_anchor, other_at, other_basis, undated, current';

/** A row of the ledger's `nums` table as a fact. */
function numFactOf(r: Record<string, unknown>): NumFact {
  const occurred = rowOccurred(r);
  return {
    id: String(r.key), num: String(r.num), kind: String(r.kind), place: String(r.place), repo: str(r.repo), path: str(r.path), commit: str(r.commit_hash),
    line: (r.line ?? null) as number | null, context: String(r.context ?? ''), confidence: String(r.confidence),
    ms: r.first_ms === null || r.first_ms === undefined ? msOf(occurred.at) ?? 0 : Number(r.first_ms), occurred, current: Number(r.current) === 1,
  };
}

export interface DocVersionFact {
  readonly id: string;
  readonly repo: string;
  readonly path: string;
  readonly commit: string;
  readonly ms: number;
  readonly change: string;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly current: boolean;
  readonly onTrunk: boolean;
}

export interface SupersessionFact {
  readonly id: string;
  readonly repo: string | null;
  readonly source: string;
  readonly path: string | null;
  readonly pattern: string;
  readonly target: string | null;
  readonly replaced: string | null;
  readonly replacement: string | null;
  readonly syntax: string | null;
  readonly text: string;
  readonly obsoleteList: boolean;
  readonly line: number | null;
  readonly firstCommit: string | null;
  readonly ms: number;
  readonly occurred: Occurred;
  readonly current: boolean;
}

// ───────────────────────── helpers ─────────────────────────

const json = <T>(s: unknown, fallback: T): T => { try { return typeof s === 'string' && s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };
const str = (v: unknown): string | null => (typeof v === 'string' ? v : v === null || v === undefined ? null : String(v));

/** When a row happened, the way the ledger's queries give it (`Ledger.rowOccurred`). */
export function rowOccurred(r: Record<string, unknown>): Occurred {
  const at = String(r.occurred_at ?? '');
  return {
    at, basis: String(r.occurred_basis ?? 'First observed') as OccurredBasis, anchor: str(r.occurred_anchor),
    ...(r.other_at ? { other: { at: String(r.other_at), basis: String(r.other_basis ?? 'Commit') as OccurredBasis, anchor: null } } : {}),
    ...(r.undated ? { undated: true } : {}),
  };
}

/** A commit's time: the author time, with the committer time beside it when it differs (`Ledger.commitOccurred`). */
export function commitOccurred(hash: string, authorAt: string, committerAt: string | null): Occurred {
  const a = materialTime(authorAt) ?? authorAt;
  const c = committerAt ? materialTime(committerAt) ?? committerAt : null;
  return { at: a, basis: 'Commit', anchor: `commit:${hash.slice(0, 12)}`, ...(c && c !== a ? { other: { at: c, basis: 'Commit', anchor: 'committer time' } } : {}) };
}

export const msOfOccurred = (o: Occurred | null | undefined): number => (o ? msOf(o.at) ?? 0 : 0);

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

// ───────────────────────── the facts ─────────────────────────

export class Facts {
  readonly ledger: Ledger;
  readonly commits = new Map<string, CommitFact>();            // by full hash
  readonly commitsByRepo = new Map<string, CommitFact[]>();    // oldest first
  /** The trunk commit on the first-parent line that brought a commit into the trunk (itself for a direct trunk commit). */
  readonly introducedBy = new Map<string, string>();
  /** Side commits (not on the trunk's first-parent line) of each branch, and the branches each side commit is on. */
  readonly branchCommits = new Map<string, Set<string>>();     // branch name → hashes
  readonly branchesOf = new Map<string, string[]>();           // hash → branch names
  readonly branches: BranchFact[] = [];
  readonly trunkTip = new Map<string, string | null>();        // repo → trunk tip
  readonly arrangements: ArrangementFact[] = [];
  readonly arrangementsByIdent = new Map<string, ArrangementFact[]>();
  readonly arrangementsByPath = new Map<string, ArrangementFact[]>();
  readonly verdicts: VerdictFact[] = [];
  readonly verdictsByPath = new Map<string, VerdictFact[]>();
  readonly docs: DocVersionFact[] = [];
  readonly docsByPath = new Map<string, DocVersionFact[]>();
  readonly supersessions: SupersessionFact[] = [];
  /** The latest commit time in the ledger: "now" as far as the project's material goes. */
  readonly latestMs: number;
  private readonly numsCache = new Map<string, NumFact[]>();
  private readonly rangeCache = new Map<string, { row: NumFact; members: Set<string> }[]>();
  private readonly entryCache = new Map<string, { label: string; occurred: Occurred; text?: string } | null>();
  private readonly filesCache = new Map<string, { path: string; status: string }[]>();

  constructor(ledger: Ledger) {
    this.ledger = ledger;
    const db = ledger.db;
    for (const r of ledger.repos()) this.trunkTip.set(r.id, r.trunkTip);
    // Commits, oldest first per repository.
    const rows = db.prepare('SELECT repo, hash, parents, author_at, author_ms, committer_at, author, subject, body, merge, on_trunk, first_parent_trunk FROM commits ORDER BY author_ms, hash').all() as Record<string, unknown>[];
    let latest = 0;
    for (const r of rows) {
      const hash = String(r.hash);
      const c: CommitFact = {
        repo: String(r.repo), hash, id: `commit:${hash.slice(0, 12)}`, short: hash.slice(0, 7), parents: String(r.parents).split(' ').filter(Boolean),
        ms: Number(r.author_ms), occurred: commitOccurred(hash, String(r.author_at), str(r.committer_at)), author: String(r.author ?? ''),
        subject: String(r.subject ?? ''), body: String(r.body ?? ''), merge: Number(r.merge) === 1, onTrunk: Number(r.on_trunk) === 1, fpTrunk: Number(r.first_parent_trunk) === 1,
      };
      this.commits.set(hash, c);
      const list = this.commitsByRepo.get(c.repo) ?? [];
      list.push(c);
      this.commitsByRepo.set(c.repo, list);
      if (c.ms > latest) latest = c.ms;
    }
    this.latestMs = latest;
    this.computeIntroducedBy();
    for (const b of db.prepare('SELECT repo, name, namespace, tip, merged, ahead FROM branches ORDER BY name').all() as Record<string, unknown>[]) {
      this.branches.push({ repo: String(b.repo), name: String(b.name), namespace: String(b.namespace), tip: String(b.tip), merged: b.merged === null ? null : Number(b.merged) === 1, ahead: b.ahead === null ? null : Number(b.ahead) });
    }
    this.computeBranchCommits();
    for (const r of db.prepare('SELECT key, repo, path, commit_hash, kind, ident, parsed, data, current, occurred_at, occurred_ms, occurred_basis, occurred_anchor, other_at, other_basis, undated FROM plans').all() as Record<string, unknown>[]) {
      const occurred = rowOccurred(r);
      const a: ArrangementFact = {
        id: String(r.key), repo: str(r.repo), path: String(r.path), commit: str(r.commit_hash), kind: String(r.kind), ident: str(r.ident),
        parsed: Number(r.parsed) === 1, current: Number(r.current) === 1, ms: r.occurred_ms === null || r.occurred_ms === undefined ? msOf(occurred.at) ?? 0 : Number(r.occurred_ms),
        occurred, data: json<ArrangementData>(r.data, {}),
      };
      this.arrangements.push(a);
      if (a.ident) this.arrangementsByIdent.set(a.ident, [...(this.arrangementsByIdent.get(a.ident) ?? []), a]);
      this.arrangementsByPath.set(a.path, [...(this.arrangementsByPath.get(a.path) ?? []), a]);
    }
    const byTime = (x: { ms: number; path?: string }, y: { ms: number; path?: string }) => x.ms - y.ms || (x.path ?? '').localeCompare(y.path ?? '');
    this.arrangements.sort(byTime);
    for (const list of this.arrangementsByIdent.values()) list.sort(byTime);
    for (const list of this.arrangementsByPath.values()) list.sort(byTime);
    for (const r of db.prepare('SELECT key, repo, path, kind, verdict, confidence, text, first_commit, first_line, current_line, first_ms, occurred_at, occurred_basis, occurred_anchor, other_at, other_basis, undated, current FROM verdicts').all() as Record<string, unknown>[]) {
      const occurred = rowOccurred(r);
      const v: VerdictFact = {
        id: String(r.key), repo: str(r.repo), path: String(r.path), kind: String(r.kind), verdict: str(r.verdict), confidence: String(r.confidence), text: String(r.text ?? ''),
        line: (r.current_line ?? r.first_line ?? null) as number | null, firstCommit: str(r.first_commit),
        ms: r.first_ms === null || r.first_ms === undefined ? msOf(occurred.at) ?? 0 : Number(r.first_ms), occurred, current: Number(r.current) === 1,
      };
      this.verdicts.push(v);
      this.verdictsByPath.set(v.path, [...(this.verdictsByPath.get(v.path) ?? []), v]);
    }
    for (const list of this.verdictsByPath.values()) list.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.ms - b.ms);
    for (const r of db.prepare(`SELECT d.key, d.repo, d.path, d.commit_hash, d.at_ms, d.change, d.added, d.removed, d.changed, c.on_trunk,
        (SELECT count(*) FROM code_files f WHERE f.repo = d.repo AND f.path = d.path AND f.blob = d.blob) cur
      FROM docs d LEFT JOIN commits c ON c.repo = d.repo AND c.hash = d.commit_hash ORDER BY d.at_ms, d.commit_hash`).all() as Record<string, unknown>[]) {
      const d: DocVersionFact = {
        id: String(r.key), repo: String(r.repo), path: String(r.path), commit: String(r.commit_hash), ms: Number(r.at_ms), change: String(r.change),
        added: json<string[]>(r.added, []), changed: json<string[]>(r.changed, []), removed: json<string[]>(r.removed, []), current: Number(r.cur) > 0, onTrunk: Number(r.on_trunk) === 1,
      };
      this.docs.push(d);
      this.docsByPath.set(d.path, [...(this.docsByPath.get(d.path) ?? []), d]);
    }
    for (const r of db.prepare('SELECT * FROM supersedes ORDER BY first_ms IS NULL, first_ms, path, first_line').all() as Record<string, unknown>[]) {
      const occurred = rowOccurred(r);
      this.supersessions.push({
        id: String(r.key), repo: str(r.repo), source: String(r.source), path: str(r.path), pattern: String(r.pattern), target: str(r.target),
        replaced: str(r.replaced), replacement: str(r.replacement), syntax: str(r.syntax), text: String(r.text ?? ''),
        obsoleteList: Number(r.obsolete_list) === 1, line: (r.current_line ?? r.first_line ?? null) as number | null, firstCommit: str(r.first_commit),
        ms: r.first_ms === null || r.first_ms === undefined ? msOf(occurred.at) ?? 0 : Number(r.first_ms), occurred, current: Number(r.current) === 1,
      });
    }
  }

  /**
   * For every trunk commit, the commit of the trunk's first-parent line that brought it in: walking that line from its
   * oldest commit, a merge brings in every commit its other parents reach that no earlier commit of the line reached.
   */
  private computeIntroducedBy(): void {
    for (const tip of this.trunkTip.values()) {
      if (!tip || !this.commits.has(tip)) continue;
      const line: string[] = [];
      for (let h: string | undefined = tip; h && this.commits.has(h); h = this.commits.get(h)!.parents[0]) {
        line.push(h);
        if (line.length > 1_000_000) break;
      }
      line.reverse();
      const seen = new Set<string>();
      for (const fp of line) {
        seen.add(fp);
        this.introducedBy.set(fp, fp);
        const stack = [...(this.commits.get(fp)?.parents.slice(1) ?? [])];
        while (stack.length) {
          const h = stack.pop()!;
          if (seen.has(h) || !this.commits.has(h)) continue;
          seen.add(h);
          this.introducedBy.set(h, fp);
          stack.push(...this.commits.get(h)!.parents);
        }
      }
    }
  }

  /** Each branch's own commits: from its tip back to where it meets the trunk's first-parent line. */
  private computeBranchCommits(): void {
    const tips = new Map<string, BranchFact>();
    for (const b of this.branches) {
      const plain = b.namespace === 'remotes' ? b.name.replace(/^[^/]+\//, '') : b.name;
      if (plain === 'HEAD') continue;
      const tip = this.commits.get(b.tip);
      if (!tip || tip.fpTrunk) continue;          // the trunk itself, or a branch whose tip is on the trunk's line
      if (!tips.has(`${b.repo}\x1f${plain}`)) tips.set(`${b.repo}\x1f${plain}`, { ...b, name: plain });
    }
    for (const b of tips.values()) {
      const own = new Set<string>();
      const stack = [b.tip];
      while (stack.length) {
        const h = stack.pop()!;
        const c = this.commits.get(h);
        if (!c || own.has(h) || c.fpTrunk) continue;
        own.add(h);
        stack.push(...c.parents);
        if (own.size > 20_000) break;
      }
      this.branchCommits.set(b.name, own);
      for (const h of own) this.branchesOf.set(h, [...(this.branchesOf.get(h) ?? []), b.name]);
    }
  }

  /** Every place the given numbers appear (documents, commit messages, branch, worktree and file names), batched. */
  numsOf(numbers: Iterable<string>): Map<string, NumFact[]> {
    const list = [...numbers];
    const want = [...new Set(list)].filter((n) => !this.numsCache.has(n));
    for (const part of chunks(want, 300)) {
      for (const n of part) this.numsCache.set(n, []);
      const rows = this.ledger.db.prepare(`SELECT ${NUM_COLUMNS} FROM nums WHERE num IN (${part.map(() => '?').join(',')})`).all(...part) as Record<string, unknown>[];
      for (const r of rows) {
        const f = numFactOf(r);
        this.numsCache.get(f.num)!.push(f);
      }
    }
    const out = new Map<string, NumFact[]>();
    for (const n of list) out.set(n, this.numsCache.get(n) ?? []);
    return out;
  }

  /**
   * `numsOf`, and also every place a range names the number (CM, E151; ledger/ranges.ts): the place where the range's
   * first number stands — a commit message, a line of a document — counts as naming each of its members, under the
   * same ledger entry. `3431e93` 「(CKC-03 AC-25-AC-31)」 names AC-26 … AC-31 too. For the lookups of what later names an
   * item; the ledger's own index is unchanged.
   */
  numsWithRanges(numbers: Iterable<string>): Map<string, NumFact[]> {
    const list = [...numbers];
    const base = this.numsOf(list);
    const out = new Map(base);
    const placeKey = (r: NumFact) => `${r.kind}\x1f${r.commit ?? ''}\x1f${r.path ?? ''}\x1f${r.line ?? ''}`;
    for (const n of new Set(list)) {
      const prefix = familyPrefix(n);
      if (!prefix) continue;
      const have = new Set((base.get(n) ?? []).map(placeKey));
      const extra: NumFact[] = [];
      for (const x of this.rangeRowsOf(prefix)) {
        if (!x.members.has(n) || have.has(placeKey(x.row))) continue;
        have.add(placeKey(x.row));
        extra.push({ ...x.row, num: n, place: 'mention' });
      }
      if (extra.length) out.set(n, [...(base.get(n) ?? []), ...extra]);
    }
    return out;
  }

  /** The rows of a family whose context writes a range of it, with the members each names (cached per family). */
  private rangeRowsOf(prefix: string): { row: NumFact; members: Set<string> }[] {
    const hit = this.rangeCache.get(prefix);
    if (hit) return hit;
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.ledger.db.prepare(`SELECT ${NUM_COLUMNS} FROM nums WHERE num LIKE ? ESCAPE '\\'`).all(like) as Record<string, unknown>[];
    const out: { row: NumFact; members: Set<string> }[] = [];
    for (const r of rows) {
      const f = numFactOf(r);
      if (familyPrefix(f.num) !== prefix) continue;
      const members = rangesIn(f.context).filter((x) => x.prefix === prefix && x.members.includes(f.num)).flatMap((x) => x.members);
      if (members.length) out.push({ row: f, members: new Set(members) });
    }
    this.rangeCache.set(prefix, out);
    return out;
  }

  /** The files a commit changed (against its first parent). */
  filesOf(c: CommitFact): { path: string; status: string }[] {
    const key = `${c.repo}\x1f${c.hash}`;
    if (!this.filesCache.has(key)) {
      this.filesCache.set(key, this.ledger.db.prepare('SELECT path, status FROM commit_files WHERE repo = ? AND hash = ? ORDER BY path').all(c.repo, c.hash) as { path: string; status: string }[]);
    }
    return this.filesCache.get(key)!;
  }

  /** The ledger's own label, time and text of an entry (cached). */
  entry(id: string): { label: string; occurred: Occurred; text?: string } | null {
    if (!this.entryCache.has(id)) {
      const e = this.ledger.resolve(id);
      this.entryCache.set(id, e ? { label: e.label, occurred: e.occurred, ...(e.text !== undefined ? { text: e.text } : {}) } : null);
    }
    return this.entryCache.get(id)!;
  }

  /** Evidence as the workbench names it: a ledger entry with its label, time and (for one line) the original line. */
  ref(id: string, line: string | null = null, fallback?: { label: string; occurred: Occurred }): EvidenceRef {
    const e = this.entry(id);
    return { kind: 'ledger', id, label: e?.label ?? fallback?.label ?? id, line: line ?? null, occurred: e?.occurred ?? fallback?.occurred ?? null };
  }

  /** The commit a (short) hash names, when the ledger has exactly one. */
  commitByPrefix(prefix: string): CommitFact | null {
    const p = prefix.trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(p)) return null;
    const exact = this.commits.get(p);
    if (exact) return exact;
    let hit: CommitFact | null = null;
    for (const c of this.commits.values()) {
      if (!c.hash.startsWith(p)) continue;
      if (hit && hit.hash !== c.hash) return null;
      hit = c;
    }
    return hit;
  }

  /**
   * An absolute path as the ledger names it: its repository and the path inside it (forward slashes). A path written with
   * a different spelling of the same directory (a Windows short name, a junction) is compared by its real path.
   */
  relPathOf(absPath: string): { readonly repo: string; readonly path: string } | null {
    const repos = this.ledger.repos();
    const within = (root: string, p: string) => repos.length && isWithin(root, p);
    const pick = (p: string, rootOf: (r: { path: string }) => string) => {
      const r = repos.filter((x) => within(rootOf(x), p)).sort((x, y) => rootOf(y).length - rootOf(x).length)[0];
      return r ? { repo: r.id, path: normalizePath(p).slice(normalizePath(rootOf(r)).length + 1).split(/[\\/]/).join('/') } : null;
    };
    return pick(absPath, (r) => r.path) ?? pick(this.real(absPath), (r) => this.real(r.path));
  }

  private readonly realCache = new Map<string, string>();
  private real(p: string): string {
    if (!this.realCache.has(p)) {
      let out = p;
      try { out = realpathSync.native(p); } catch {
        // A path that no longer exists: resolve its nearest existing parent and keep the rest.
        const parts = normalizePath(p).split(/[\\/]/);
        for (let i = parts.length - 1; i > 0; i--) {
          try { out = [realpathSync.native(parts.slice(0, i).join('/')), ...parts.slice(i)].join('/'); break; } catch { /* go up */ }
        }
      }
      this.realCache.set(p, out);
    }
    return this.realCache.get(p)!;
  }

  /** Whether the ledger ever saw a document at this path (any version, any repository). */
  hasDocument(path: string): boolean {
    const p = path.replace(/\\/g, '/');
    if (this.docsByPath.has(p)) return true;
    for (const k of this.docsByPath.keys()) if (p.endsWith(`/${k}`) || k.endsWith(`/${p}`)) return true;
    return false;
  }

  /** The text of an entry (a document version, an arrangement version), as the ledger keeps it. */
  textOf(id: string): string | null {
    return this.entry(id)?.text ?? null;
  }
}
