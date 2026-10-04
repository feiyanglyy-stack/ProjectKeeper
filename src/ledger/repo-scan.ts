/**
 * Version history (Spec §1.16 row 1; CKC-22 AC-1, AC-2): every commit on every ref — heads, tags, remotes, the stash and
 * any other namespace (`refs/codex/turn-diffs/…`) — with no cap. Per commit: hash, parents, author and committer
 * time (both kept; they differ after a rebase or a cherry-pick), author, subject and body, and the files it changed against
 * its first parent with status, rename source, content ids and line counts. Also: which ref namespaces reach each commit,
 * the trunk and each commit's place on it, every branch (local and remote-tracking) and whether its tip is in the trunk,
 * and the worktrees with their uncommitted changes.
 *
 * Incremental (AC-2): only commits reachable from a ref that moved, and from none of the tips already recorded, are read;
 * what is recorded stays recorded (a force-pushed or deleted ref keeps its commits, which were real history when read).
 */
import type { DatabaseSync } from 'node:sqlite';
import { commitKey, putText, redact, tx } from './schema.ts';
import { materialTime, msOf } from './time.ts';
import {
  defaultBranch, firstParentLine, headOf, isAncestor, isHash, ledgerGit, listRefs, logDetails, revList, uncommitted, worktreeList,
  type RefInfo, type RefNamespace,
} from './git-read.ts';

export interface RepoHandle {
  /** Scope item id. */
  readonly id: string;
  /** The repository's own checkout; a worktree folds into its main repository. */
  readonly path: string;
}

export interface RepoScanStats {
  readonly repo: string;
  readonly refs: number;
  readonly refsByNamespace: Readonly<Record<string, number>>;
  readonly commits: number;
  readonly commitsAdded: number;
  readonly unreadCommits: number;
  readonly merges: number;
  readonly trunk: string | null;
  readonly trunkCommits: number;
  readonly trunkMerges: number;
  readonly branches: number;
  readonly branchesMerged: number;
  readonly worktrees: number;
  readonly head: string | null;
}

/** The time a commit gives, kept as git wrote it (the author's own offset, so the local day stays readable), and its milliseconds. */
function commitTime(raw: string): { at: string; ms: number } {
  return { at: raw, ms: msOf(materialTime(raw) ?? raw) ?? 0 };
}

/** Scan one repository's refs, commits, branches, merges and worktrees into the ledger. */
export function scanRepo(db: DatabaseSync, repo: RepoHandle, now: string): RepoScanStats {
  // Every ref is recorded; only refs to commits have a history to walk.
  const allRefs = listRefs(repo.path);
  const refs = allRefs.filter((r) => r.type === 'commit');
  const head = headOf(repo.path);
  const previous = new Map((db.prepare('SELECT refname, tip, present FROM refs WHERE repo = ?').all(repo.id) as { refname: string; tip: string; present: number }[])
    .map((r) => [r.refname, r]));
  const known = new Set((db.prepare('SELECT hash FROM commits WHERE repo = ?').all(repo.id) as { hash: string }[]).map((r) => r.hash));

  // What is new: reachable from a moved ref (or a detached HEAD), and from none of the tips already recorded.
  const recordedTips = [...new Set([...previous.values()].filter((r) => isHash(r.tip) && known.has(r.tip)).map((r) => r.tip))];
  const moved = refs.filter((r) => previous.get(r.refname)?.tip !== r.tip || !known.has(r.tip)).map((r) => r.tip);
  if (head.hash && !known.has(head.hash)) moved.push(head.hash);
  const fresh = moved.length ? (revList(repo.path, [...new Set(moved)], recordedTips) ?? []) : [];
  const toRead = fresh.filter((h) => !known.has(h));
  const { details, failed } = logDetails(repo.path, toRead);

  const insCommit = db.prepare(`INSERT OR IGNORE INTO commits
    (key, repo, hash, parents, author_at, author_ms, committer_at, committer_ms, author, subject, body, merge, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insFile = db.prepare(`INSERT OR REPLACE INTO commit_files (repo, hash, status, path, old_path, old_blob, new_blob, added, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let added = 0;
  tx(db, () => {
    for (const d of details) {
      const a = commitTime(d.authorAt);
      const c = commitTime(d.committerAt || d.authorAt);
      // A credential in a commit message never enters the ledger (Spec §3.1): the message is kept redacted.
      const w = insCommit.run(commitKey(d.hash), repo.id, d.hash, d.parents.join(' '), a.at, a.ms, c.at, c.ms, d.author, redact(d.subject), redact(d.body), d.parents.length >= 2 ? 1 : 0, now);
      if (w.changes === 0) continue;
      added += 1;
      for (const f of d.files) insFile.run(repo.id, d.hash, f.status, f.path, f.from, f.oldBlob, f.newBlob, f.added, f.deleted);
      putText(db, `commit:${repo.id}:${d.hash}`, 'commit', repo.id, `${d.subject}\n\n${d.body}`.trim());
    }
  });

  const refsChanged = added > 0 || allRefs.length !== [...previous.values()].filter((r) => r.present === 1).length || allRefs.some((r) => previous.get(r.refname)?.tip !== r.tip || previous.get(r.refname)?.present !== 1);
  tx(db, () => {
    const upRef = db.prepare('INSERT OR REPLACE INTO refs (repo, refname, namespace, type, tip, present, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const seen = new Set(allRefs.map((r) => r.refname));
    for (const [name, old] of previous) if (!seen.has(name) && old.present === 1) upRef.run(repo.id, name, namespaceLabel(name), 'commit', old.tip, 0, now);
    for (const r of allRefs) if (previous.get(r.refname)?.tip !== r.tip || previous.get(r.refname)?.present !== 1) upRef.run(repo.id, r.refname, r.namespace, r.type, r.tip, 1, now);
  });

  // Trunk and the namespaces each commit is reachable from: recomputed when any ref moved.
  const trunk = defaultBranch(repo.path, refs);
  const trunkTip = trunk ? refs.find((r) => r.refname === `refs/heads/${trunk}`)?.tip ?? null : head.hash;
  const trunkList = trunkTip ? revList(repo.path, [trunkTip]) : null;
  const trunkSet = new Set(trunkList ?? []);
  /** Whether the trunk reaches a commit; null when there is no trunk or git could not list it. */
  const inTrunk = (h: string | null): boolean | null => (h && trunkList ? trunkSet.has(h) : null);
  const stored = db.prepare('SELECT trunk_tip FROM repos WHERE id = ?').get(repo.id) as { trunk_tip: string | null } | undefined;
  if (refsChanged || stored?.trunk_tip !== trunkTip) {
    const firstParent = new Set(trunkTip ? firstParentLine(repo.path, trunkTip) : []);
    const byNs = new Map<RefNamespace, string[]>();
    for (const r of refs) byNs.set(r.namespace, [...(byNs.get(r.namespace) ?? []), r.tip]);
    const reach = new Map<string, string[]>();
    for (const [ns, tips] of byNs) {
      for (const h of revList(repo.path, [...new Set(tips)]) ?? []) reach.set(h, [...(reach.get(h) ?? []), ns]);
    }
    if (head.hash && !head.branch) for (const h of revList(repo.path, [head.hash]) ?? []) if (!reach.has(h)) reach.set(h, ['HEAD']);
    const order: readonly string[] = ['heads', 'remotes', 'tags', 'stash', 'other', 'HEAD'];
    const up = db.prepare('UPDATE commits SET on_trunk = ?, first_parent_trunk = ?, reach = ? WHERE repo = ? AND hash = ?');
    const all = db.prepare('SELECT hash, on_trunk, first_parent_trunk, reach FROM commits WHERE repo = ?').all(repo.id) as { hash: string; on_trunk: number; first_parent_trunk: number; reach: string }[];
    tx(db, () => {
      for (const c of all) {
        const t = trunkSet.has(c.hash) ? 1 : 0;
        const f = firstParent.has(c.hash) ? 1 : 0;
        const r = (reach.get(c.hash) ?? []).sort((a, b) => order.indexOf(a) - order.indexOf(b)).join(',');
        if (t !== c.on_trunk || f !== c.first_parent_trunk || r !== c.reach) up.run(t, f, r, repo.id, c.hash);
      }
    });
  }

  // Branches: local and remote-tracking; merged when the trunk reaches the tip.
  const branchRefs = refs.filter((r) => r.namespace === 'heads' || r.namespace === 'remotes');
  const tipAt = db.prepare('SELECT author_at FROM commits WHERE repo = ? AND hash = ?');
  const oldBranches = new Map((db.prepare('SELECT name, tip, merged, ahead FROM branches WHERE repo = ?').all(repo.id) as { name: string; tip: string; merged: number | null; ahead: number | null }[]).map((b) => [b.name, b]));
  let merged = 0;
  tx(db, () => {
    db.prepare('DELETE FROM branches WHERE repo = ?').run(repo.id);
    const ins = db.prepare('INSERT INTO branches (repo, name, namespace, tip, tip_at, merged, ahead, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const b of branchRefs) {
      const name = b.refname.replace(/^refs\/(heads|remotes)\//, '');
      const old = oldBranches.get(name);
      let isMerged: boolean | null = inTrunk(b.tip);
      let ahead: number | null = isMerged ? 0 : null;
      if (trunkTip && isMerged === false) {
        if (old && old.tip === b.tip && stored?.trunk_tip === trunkTip) ahead = old.ahead;
        else {
          const r = ledgerGit(repo.path, ['rev-list', '--count', b.tip, `^${trunkTip}`], { timeoutMs: 60_000 });
          ahead = r.ok ? Number(r.out.trim()) : null;
          if (!r.ok) isMerged = null;
        }
      }
      if (isMerged) merged += 1;
      ins.run(repo.id, name, b.namespace, b.tip, (tipAt.get(repo.id, b.tip) as { author_at: string } | undefined)?.author_at ?? null,
        isMerged === null ? null : isMerged ? 1 : 0, ahead, now);
    }
  });

  // Worktrees, with their uncommitted changes and whether the trunk already has their HEAD.
  const wts = worktreeList(repo.path).filter((w) => !w.bare);
  tx(db, () => {
    db.prepare('DELETE FROM worktrees WHERE repo = ?').run(repo.id);
    const ins = db.prepare('INSERT OR REPLACE INTO worktrees (repo, path, branch, head, merged, detached, uncommitted, uncommitted_list, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const w of wts) {
      const dirty = w.prunable ? null : uncommitted(w.path);
      const wtMerged = inTrunk(w.head) ?? (w.head && trunkTip ? isAncestor(repo.path, w.head, trunkTip) : null);
      ins.run(repo.id, w.path, w.branch, w.head, wtMerged === null ? null : wtMerged ? 1 : 0, w.detached ? 1 : 0,
        // Redacted like everything else the ledger keeps (QC AY): a file name or a status line never carries a credential out.
        dirty ? dirty.length : 0, JSON.stringify(dirty === null ? ['(the worktree cannot be read: its directory is gone or git cannot open it)'] : dirty.slice(0, 500).map((line) => redact(line))), now);
    }
  });

  const totals = db.prepare('SELECT count(*) c, sum(merge) m, sum(on_trunk) t, sum(on_trunk * merge) tm, min(author_at) first FROM commits WHERE repo = ?').get(repo.id) as { c: number; m: number | null; t: number | null; tm: number | null; first: string | null };
  db.prepare(`INSERT INTO repos (id, path, trunk, trunk_tip, head, head_branch, version_from) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET path = excluded.path, trunk = excluded.trunk, trunk_tip = excluded.trunk_tip, head = excluded.head,
    head_branch = excluded.head_branch, version_from = excluded.version_from`)
    .run(repo.id, repo.path, trunk, trunkTip, head.hash, head.branch, totals.first);

  const byNamespace: Record<string, number> = {};
  for (const r of allRefs) byNamespace[r.namespace] = (byNamespace[r.namespace] ?? 0) + 1;
  return {
    repo: repo.id, refs: allRefs.length, refsByNamespace: byNamespace, commits: totals.c, commitsAdded: added, unreadCommits: failed,
    merges: totals.m ?? 0, trunk, trunkCommits: totals.t ?? 0, trunkMerges: totals.tm ?? 0,
    branches: branchRefs.length, branchesMerged: merged, worktrees: wts.length, head: head.hash,
  };
}

const namespaceLabel = (refname: string): RefInfo['namespace'] =>
  refname.startsWith('refs/heads/') ? 'heads' : refname.startsWith('refs/tags/') ? 'tags' : refname.startsWith('refs/remotes/') ? 'remotes' : refname === 'refs/stash' ? 'stash' : 'other';
