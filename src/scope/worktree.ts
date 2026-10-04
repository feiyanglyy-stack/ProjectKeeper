/**
 * A worktree registered under a repository, measured against that repository's trunk from git's own records (Spec
 * §1.1; CKC-04 AC-15, AC-16; owner 2026-09-21, subagent/DECISIONS.md E60), in the owner's order:
 *
 * 1. is its branch completely merged into the trunk (no commit the trunk does not have);
 * 2. files the same as the trunk are skipped;
 * 3. older versions — files that differ only because the trunk moved on — are left to the version history;
 * 4. only uncommitted changes and what the trunk does not have are taken.
 *
 * Whether it is merged, and whether a file is the same, are counted from the records, never judged by reading files.
 * The trunk is the branch checked out in the repository's main directory (its commit when detached): what the main
 * project is read as. Read-only throughout; `hash-object` runs without `-w`.
 */
import { existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ScopeItem, Source, WorktreeSummary, WorktreeTaken } from '../model/types.ts';
import { git } from '../util/git.ts';
import { skippedSegment } from './skip.ts';

const LONG = 60_000;

export function trunkOf(repo: string): { ref: string; commit: string } | null {
  const commit = git(repo, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).out.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) return null;
  const branch = git(repo, ['symbolic-ref', '-q', '--short', 'HEAD']);
  return { ref: branch.ok && branch.out.trim() ? branch.out.trim() : commit.slice(0, 12), commit };
}

const zsplit = (out: string) => out.split('\0').filter(Boolean);

/** `git diff --name-status -z` between two commits: path → status letter. */
function changedBetween(cwd: string, from: string, to: string): Map<string, string> | null {
  const r = git(cwd, ['diff', '--name-status', '--no-renames', '-z', from, to], LONG);
  if (!r.ok) return null;
  const parts = zsplit(r.out);
  const out = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length; i += 2) out.set(parts[i + 1]!, parts[i]!.charAt(0));
  return out;
}

/** Uncommitted changes (staged, unstaged, untracked; not ignored): path → untracked or not. */
function uncommitted(cwd: string): Map<string, { untracked: boolean }> | null {
  const r = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], LONG);
  if (!r.ok) return null;
  const out = new Map<string, { untracked: boolean }>();
  for (const rec of zsplit(r.out)) {
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    if (xy === '!!') continue;
    out.set(rec.slice(3), { untracked: xy === '??' });
  }
  return out;
}

function batches<T>(items: readonly T[], size = 150): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The trunk's blob at each of these paths, where it has one. */
function trunkBlobs(cwd: string, trunk: string, paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const batch of batches(paths)) {
    const tree = git(cwd, ['--literal-pathspecs', 'ls-tree', '-r', '-z', trunk, '--', ...batch], LONG);
    for (const rec of zsplit(tree.out)) {
      const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/s.exec(rec);
      if (m) out.set(m[2]!, m[1]!);
    }
  }
  return out;
}

/** Of these files (present in the worktree), the ones whose content is the trunk's at the same path. */
function sameContent(cwd: string, inTrunk: ReadonlyMap<string, string>, paths: readonly string[]): Set<string> {
  const same = new Set<string>();
  for (const batch of batches(paths.filter((p) => inTrunk.has(p)))) {
    const hashed = git(cwd, ['hash-object', '--', ...batch], LONG);
    if (!hashed.ok) continue;
    const shas = hashed.out.split(/\r?\n/).filter(Boolean);
    batch.forEach((p, i) => { if (shas[i] === inTrunk.get(p)) same.add(p); });
  }
  return same;
}

const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };

function failed(error: string, trunk: WorktreeSummary['trunk'], branch: string | null = null, head: string | null = null): WorktreeSummary {
  return { trunk, branch, head, merged: null, uniqueCommits: 0, files: 0, sameAsTrunk: 0, olderVersions: 0, taken: [], error };
}

/**
 * Measure `worktree` against the trunk of `repo`. Files under directories the skip list never reads (build output,
 * dependencies) are left out of every count, as they are left out of the main project.
 */
export function measureWorktree(
  worktree: string, repo: string, trunk: { ref: string; commit: string } | null = trunkOf(repo),
  known: { readonly head: string | null; readonly branch: string | null } | null = null,
): WorktreeSummary {
  if (!existsSync(worktree)) return failed('the worktree is not on disk', trunk);
  if (!trunk) return failed(`the trunk of ${repo} could not be read`, trunk);
  // `git worktree list` already says where each worktree's HEAD is and on which branch.
  const head = known?.head ?? git(worktree, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).out.trim();
  const branchR = known ? null : git(worktree, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const branch = known ? known.branch : branchR!.ok && branchR!.out.trim() ? branchR!.out.trim() : null;
  if (!/^[0-9a-f]{40}$/.test(head)) return failed('its HEAD could not be read', trunk, branch);
  const atTrunk = head === trunk.commit;
  const count = atTrunk ? { ok: true, out: '0', err: '' } : git(worktree, ['rev-list', '--count', `${trunk.commit}..${head}`], LONG);
  if (!count.ok) return failed(`git could not compare it with ${trunk.ref}: ${count.err.split('\n')[0]}`, trunk, branch, head);
  const uniqueCommits = Number(count.out.trim()) || 0;
  const merged = uniqueCommits === 0;
  // What its branch changed since it left the trunk: nothing when merged.
  const base = merged ? head : git(worktree, ['merge-base', head, trunk.commit], LONG).out.trim();
  const onBranch = merged ? new Map<string, string>() : /^[0-9a-f]{40}$/.test(base) ? changedBetween(worktree, base, head) : null;
  const vsTrunk = atTrunk ? new Map<string, string>() : changedBetween(worktree, trunk.commit, head);
  const dirty = uncommitted(worktree);
  const trackedR = git(worktree, ['ls-files', '-z'], LONG);
  if (!onBranch || !vsTrunk || !dirty || !trackedR.ok) return failed(`git could not list its changes against ${trunk.ref}`, trunk, branch, head);

  const counted = (p: string) => skippedSegment(p) === null;
  const tracked = zsplit(trackedR.out).filter(counted);
  const trackedSet = new Set(tracked);
  const untracked = [...dirty].filter(([p, s]) => s.untracked && !trackedSet.has(p)).map(([p]) => p).filter(counted);
  const candidates = [...new Set([...onBranch.keys(), ...dirty.keys()])].filter(counted).sort();
  const present = new Set(candidates.filter((p) => isFile(join(worktree, p))));
  const inTrunk = trunkBlobs(worktree, trunk.commit, candidates);
  const same = sameContent(worktree, inTrunk, [...present]);

  const taken: WorktreeTaken[] = [];
  for (const p of candidates) {
    // The same as the trunk: the same content, or gone from both.
    if (present.has(p) ? same.has(p) : !inTrunk.has(p)) continue;
    taken.push({ path: p, kind: dirty.has(p) ? 'Uncommitted change' : 'Changed on branch', ...(present.has(p) ? {} : { deleted: true }) });
  }
  const takenFiles = new Set(taken.filter((t) => !t.deleted).map((t) => t.path));
  const onDisk = [...tracked.filter((p) => isFile(join(worktree, p))), ...untracked];
  let sameCount = 0;
  let older = 0;
  for (const p of onDisk) {
    if (takenFiles.has(p)) continue;
    if (same.has(p) || !vsTrunk.has(p)) sameCount += 1;
    else older += 1;   // committed, not changed on its branch, yet not the trunk's: the trunk moved on (or dropped it)
  }
  return { trunk, branch, head, merged, uniqueCommits, files: onDisk.length, sameAsTrunk: sameCount, olderVersions: older, taken, error: null };
}

export interface WorktreeOrigin {
  readonly worktree: string;
  readonly branch: string | null;
  readonly merged: boolean | null;
  readonly kind: string;
  readonly label: string;
}

/**
 * Whose a source is when it came from a worktree (CKC-04 AC-16): which worktree, which branch, and that it is work in
 * progress, not the trunk's current state — so the round's main job can put it with the work it belongs to. Null for
 * anything else.
 */
export function worktreeOrigin(scope: readonly ScopeItem[], source: Source): WorktreeOrigin | null {
  const item = scope.find((i) => i.id === source.scopeItemId);
  if (!item || item.category !== 'Worktree' || !item.worktree) return null;
  const w = item.worktree;
  const trunk = w.trunk?.ref ?? 'the trunk';
  const branch = w.branch ?? 'detached';
  const a = source.anchor;
  const kind = a.kind === 'commit' ? 'Commit the trunk does not have'
    : a.kind === 'file' ? w.taken.find((t) => t.path === relative(item.path, a.path).split('\\').join('/'))?.kind ?? 'Uncommitted change'
      : 'Worktree status';
  const label = w.merged === false
    ? `In progress in worktree ${item.path} (branch ${branch}): ${kind.toLowerCase()}; not the trunk (${trunk}), not its current state`
    : `${kind} in worktree ${item.path} (branch ${branch}, merged into ${trunk}): not the trunk's current state; whether it is current work is a judgement to make`;
  return { worktree: item.path, branch: w.branch, merged: w.merged, kind, label };
}

/** The listing's sentence for a measured worktree (Spec §6.7: merged or not, how many skipped, what was taken). */
export function worktreeSentence(w: WorktreeSummary): string {
  if (w.error) return `could not be measured against the trunk: ${w.error}; nothing taken from it`;
  const trunk = w.trunk!.ref;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const state = w.merged ? `merged into ${trunk}` : `not merged into ${trunk}: ${plural(w.uniqueCommits, 'commit')} ${trunk} does not have (work in progress, not ${trunk}'s current state)`;
  const skipped = `${plural(w.files, 'file')}: ${w.sameAsTrunk} the same as ${trunk}, skipped${w.olderVersions ? `; ${w.olderVersions} older ${w.olderVersions === 1 ? 'version' : 'versions'} ${trunk} has moved past, left to the version history` : ''}`;
  if (w.taken.length === 0) return `${state} · ${skipped} · nothing taken`;
  const shown = w.taken.slice(0, 12).map((t) => `${t.path} (${t.deleted ? `${t.kind.toLowerCase()}, removed` : t.kind.toLowerCase()})`).join(', ');
  return `${state} · ${skipped} · took ${w.taken.length}: ${shown}${w.taken.length > 12 ? `, and ${w.taken.length - 12} more` : ''}`;
}
