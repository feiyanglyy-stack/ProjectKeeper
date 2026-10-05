/**
 * Read-only git access. Every call disables optional locks and pagers, so observing a
 * repository never changes its state (Spec §1.1: the Keeper's own work does not change
 * version-control state).
 */
import { execFile, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { canonicalPath } from './paths.ts';

export interface GitResult {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

function env(): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!['GIT_PAGER', 'PAGER', 'GIT_EXTERNAL_DIFF', 'GIT_OPTIONAL_LOCKS'].includes(key.toUpperCase())) copy[key] = value;
  }
  copy.GIT_OPTIONAL_LOCKS = '0';
  return copy;
}

export function git(cwd: string, args: readonly string[], timeoutMs = 8000, maxBuffer = 16_000_000): GitResult {
  try {
    const out = execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
      encoding: 'utf8', env: env(), timeout: timeoutMs, maxBuffer, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out, err: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: e.stdout ?? '', err: (e.stderr || e.message || String(error)).trim() };
  }
}

// The paths git reports are put in the file system's own spelling (canonicalPath), the one every location is kept in:
// git usually prints that spelling already, but not for a repository reached through a mapped drive, and a worktree
// is listed as it was spelled when it was registered.

export function gitToplevel(dir: string): string | null {
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  return r.ok && r.out.trim() ? canonicalPath(resolve(r.out.trim())) : null;
}

export function gitCommonDir(dir: string): string | null {
  const r = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return r.ok && r.out.trim() ? canonicalPath(r.out.trim()) : null;
}

export function gitDir(dir: string): string | null {
  const r = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
  return r.ok && r.out.trim() ? canonicalPath(r.out.trim()) : null;
}

export interface WorktreeInfo {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
}

export function gitWorktrees(dir: string): WorktreeInfo[] {
  const r = git(dir, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  const out: WorktreeInfo[] = [];
  let current: { path?: string; head?: string; branch?: string; detached?: boolean; bare?: boolean } = {};
  const flush = () => {
    if (current.path) {
      out.push({
        path: canonicalPath(current.path), head: current.head ?? null, branch: current.branch ?? null,
        detached: current.detached === true, bare: current.bare === true,
      });
    }
    current = {};
  };
  for (const line of r.out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { flush(); current.path = line.slice(9); }
    else if (line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') current.detached = true;
    else if (line === 'bare') current.bare = true;
    else if (line === '') flush();
  }
  flush();
  return out;
}

export function gitHead(dir: string): string | null {
  const r = git(dir, ['rev-parse', 'HEAD']);
  return r.ok && /^[0-9a-f]{40}/.test(r.out.trim()) ? r.out.trim() : null;
}

export function gitBranch(dir: string): string | null {
  const r = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok && r.out.trim() && r.out.trim() !== 'HEAD' ? r.out.trim() : null;
}

/** First commit(s) of the history; two repositories sharing one are a copy or a fork of each other. */
export function gitRootCommits(dir: string): string[] {
  const r = git(dir, ['rev-list', '--max-parents=0', 'HEAD']);
  return r.ok ? r.out.split(/\s+/).filter((h) => /^[0-9a-f]{40}$/.test(h)).sort() : [];
}

export function gitRemotes(dir: string): string[] {
  const r = git(dir, ['remote', '-v']);
  return r.ok ? r.out.split(/\r?\n/).filter((l) => l.trim()) : [];
}

export interface GitStatus {
  readonly branch: string | null;
  readonly head: string | null;
  readonly dirty: readonly string[];
}

/** The same read-only git call without blocking the event loop (used where the workbench must keep answering). */
export function gitAsync(cwd: string, args: readonly string[], timeoutMs = 8000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
      encoding: 'utf8', env: env(), timeout: timeoutMs, maxBuffer: 16_000_000, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, out: String(stdout ?? ''), err: String(stderr || error.message) });
      else resolve({ ok: true, out: String(stdout), err: '' });
    });
  });
}

export async function gitStatusAsync(dir: string): Promise<GitStatus | null> {
  const [status, head, branch] = await Promise.all([
    gitAsync(dir, ['status', '--porcelain', '--untracked-files=normal']),
    gitAsync(dir, ['rev-parse', 'HEAD']),
    gitAsync(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  if (!status.ok) return null;
  const h = head.out.trim();
  const b = branch.out.trim();
  return { branch: branch.ok && b && b !== 'HEAD' ? b : null, head: head.ok && /^[0-9a-f]{40}/.test(h) ? h : null, dirty: status.out.split(/\r?\n/).filter((l) => l.trim()) };
}

export function gitStatus(dir: string): GitStatus | null {
  const r = git(dir, ['status', '--porcelain', '--untracked-files=normal']);
  if (!r.ok) return null;
  return { branch: gitBranch(dir), head: gitHead(dir), dirty: r.out.split(/\r?\n/).filter((l) => l.trim()) };
}

export interface CommitInfo {
  readonly hash: string;
  readonly at: string;
  readonly author: string;
  readonly subject: string;
  readonly files: readonly string[];
}

/**
 * The commits reachable from HEAD — all of them unless `limit` asks for fewer (D77: the history is read in full, no
 * recent-N cap), since `since` when given; `notFrom` excludes what another ref already reaches (a worktree's commits
 * beyond its main repository).
 */
export function gitRecentCommits(dir: string, since: string | null, limit: number | null = null, notFrom: string | null = null): CommitInfo[] {
  const args = ['log', ...(limit !== null ? [`-n${Math.max(1, Math.floor(limit))}`] : []), '--date=iso-strict', '--name-only', '--format=%x1e%H%x1f%aI%x1f%an%x1f%s'];
  if (since) args.push(`--since=${since}`);
  if (notFrom) args.push('HEAD', `^${notFrom}`);
  // A whole history takes longer and prints more than the recent part did.
  const r = git(dir, args, limit === null ? 180_000 : 20000, limit === null ? 512_000_000 : 16_000_000);
  if (!r.ok) return [];
  const out: CommitInfo[] = [];
  for (const block of r.out.split('\x1e')) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const [header, ...rest] = trimmed.split(/\r?\n/);
    const [hash, at, author, subject] = (header ?? '').split('\x1f');
    if (!hash) continue;
    out.push({ hash, at: at ?? '', author: author ?? '', subject: subject ?? '', files: rest.map((l) => l.trim()).filter(Boolean) });
  }
  return out;
}

/** Content of a path at a commit; null when it does not exist there. */
export function gitShow(dir: string, commit: string, path: string): string | null {
  const r = git(dir, ['show', `${commit}:${path.split('\\').join('/')}`], 20000);
  return r.ok ? r.out : null;
}

// ───────────────────────── reading version history (Spec §1.2 `History only`, §3.1; CKC-03 AC-24) ─────────────────────────
//
// Everything below is a read: log, show, ls-tree, cat-file, rev-parse, diff --name-only and hash-object without -w. Paths
// come raw (core.quotePath=false), so names in any script read as they are. A user-given ref only ever reaches
// rev-parse, after `--end-of-options`; every later call uses the full hash it resolved to.

/** The same read-only call with room for a long history: a larger buffer and time limit, raw path names. */
export function gitRead(cwd: string, args: readonly string[], options: { readonly timeoutMs?: number; readonly maxBuffer?: number } = {}): GitResult {
  try {
    const out = execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', cwd, ...args], {
      encoding: 'utf8', env: env(), timeout: options.timeoutMs ?? 30_000, maxBuffer: options.maxBuffer ?? 64_000_000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out, err: '' };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: e.stdout ?? '', err: (e.stderr || e.message || String(error)).trim() };
  }
}

/** A ref the history tools accept — a hash, a branch or tag, HEAD, with `~`, `^` or `@{…}` after it — and never an option. */
export function isSafeRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 200 && !ref.startsWith('-') && !ref.includes('..') && /^[A-Za-z0-9._/@{}~^+-]+$/.test(ref);
}

/** The full hash of the commit a ref names, or null when it names none. */
export function gitResolveCommit(dir: string, ref: string): string | null {
  if (!isSafeRef(ref)) return null;
  const r = gitRead(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { timeoutMs: 8000 });
  const hash = r.out.trim();
  return r.ok && /^[0-9a-f]{40}$/.test(hash) ? hash : null;
}

export interface CommitMeta {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly at: string;
  readonly author: string;
  readonly subject: string;
}
const META_FORMAT = '--format=%x1e%H%x1f%P%x1f%aI%x1f%an%x1f%s';
function metaOf(header: string): CommitMeta | null {
  const [hash, parents, at, author, subject] = header.split('\x1f');
  if (!hash || !/^[0-9a-f]{40}$/.test(hash)) return null;
  return { hash, parents: (parents ?? '').split(' ').filter(Boolean), at: at ?? '', author: author ?? '', subject: subject ?? '' };
}

/** Author, time, subject and parents of one commit. */
export function gitCommitMeta(dir: string, hash: string): CommitMeta | null {
  const r = gitRead(dir, ['log', '-1', META_FORMAT, hash, '--'], { timeoutMs: 8000 });
  return r.ok ? metaOf(r.out.replace(/^\x1e/, '').trim()) : null;
}

/** A path git printed in C quotes (only control characters, quotes and backslashes are quoted once quotePath is off). */
function unquote(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"'))) return path;
  const body = path.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
    const n = body[++i] ?? '';
    if (/[0-7]/.test(n)) { const oct = body.slice(i, i + 3); bytes.push(parseInt(oct, 8)); i += 2; continue; }
    bytes.push(({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

export interface PathChange {
  /** A added, M modified, D deleted, R renamed, C copied, T type changed. */
  readonly status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  readonly path: string;
  /** The other side of a rename or copy: where it came from (`path` is where it went). */
  readonly from: string | null;
}
export interface PathCommit extends CommitMeta {
  /** The changes of this commit that touch the path (a file's own line, or every file under a directory). */
  readonly changes: readonly PathChange[];
}

const under = (path: string, target: string): boolean => path === target || path.startsWith(`${target}/`);

/**
 * Every commit reachable from `ref` that touched a path, newest first — including the one that deleted it, and a rename
 * away from it with where it went. `--full-diff` lets rename detection see both sides of a move out of the path. A page
 * of `limit` commits after the first `skip`; paging reaches the whole history.
 */
export function gitPathHistory(dir: string, relPath: string, limit = 100, ref = 'HEAD', skip = 0): PathCommit[] | null {
  const target = relPath.replace(/\/+$/, '');
  const r = gitRead(dir, ['log', '-M', '--full-diff', '--name-status', META_FORMAT, `-n${Math.max(1, limit)}`, ...(skip > 0 ? [`--skip=${Math.floor(skip)}`] : []), ref, '--', target], { timeoutMs: 120_000, maxBuffer: 256_000_000 });
  if (!r.ok) return null;
  const out: PathCommit[] = [];
  for (const block of r.out.split('\x1e')) {
    const lines = block.split(/\r?\n/);
    const meta = metaOf(lines[0] ?? '');
    if (!meta) continue;
    const changes: PathChange[] = [];
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const [code, a, b] = line.split('\t');
      const status = (code ?? '').charAt(0) as PathChange['status'];
      if (!'AMDRCT'.includes(status) || !a) continue;
      const first = unquote(a);
      const second = b !== undefined ? unquote(b) : null;
      if ((status === 'R' || status === 'C') && second !== null) {
        if (under(first, target) || under(second, target)) changes.push({ status, path: second, from: first });
      } else if (under(first, target)) changes.push({ status, path: first, from: null });
    }
    if (changes.length) out.push({ ...meta, changes });
  }
  return out;
}

export interface TreeEntry {
  readonly type: 'blob' | 'tree' | 'commit';
  readonly id: string;
  readonly size: number | null;
}
/** What a path is at a commit — a file (blob), a directory (tree) or a submodule — or null when it is not there. */
export function gitTreeEntry(dir: string, commit: string, relPath: string): TreeEntry | null {
  const r = gitRead(dir, ['ls-tree', '-l', '-z', commit, '--', relPath.replace(/\/+$/, '')], { timeoutMs: 8000 });
  if (!r.ok) return null;
  const wanted = relPath.replace(/\/+$/, '');
  for (const entry of r.out.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0 || entry.slice(tab + 1) !== wanted) continue;
    const [, type, id, size] = entry.slice(0, tab).trim().split(/\s+/);
    if (type !== 'blob' && type !== 'tree' && type !== 'commit') return null;
    return { type, id: id ?? '', size: size && /^\d+$/.test(size) ? Number(size) : null };
  }
  return null;
}

/** The blob id a working-tree file would have if it were added now (filters applied, nothing written). */
export function gitHashWorkingFile(dir: string, absPath: string, relPath: string): string | null {
  const r = gitRead(dir, ['hash-object', `--path=${relPath}`, '--', absPath], { timeoutMs: 8000 });
  const id = r.out.trim();
  return r.ok && /^[0-9a-f]{40}$/.test(id) ? id : null;
}

/** Every file path in a commit's tree, optionally under a path. */
export function gitTrackedPaths(dir: string, ref = 'HEAD', relPath: string | null = null): Set<string> | null {
  const r = gitRead(dir, ['ls-tree', '-r', '--name-only', '-z', ref, ...(relPath ? ['--', relPath] : [])]);
  return r.ok ? new Set(r.out.split('\0').filter(Boolean)) : null;
}

export interface DeletedPath {
  readonly path: string;
  /** The commit that deleted it last — the newest deletion when it was deleted, added back and deleted again. */
  readonly deletedIn: CommitMeta;
}
/** Files deleted in the history reachable from `ref`, newest deletion first; a rename is not a deletion. */
export function gitDeletedPaths(dir: string, ref = 'HEAD', relPath: string | null = null): DeletedPath[] | null {
  const r = gitRead(dir, ['log', '-M', '--diff-filter=D', '--name-only', META_FORMAT, ref, ...(relPath ? ['--', relPath] : [])], { timeoutMs: 120_000, maxBuffer: 256_000_000 });
  if (!r.ok) return null;
  const seen = new Set<string>();
  const out: DeletedPath[] = [];
  for (const block of r.out.split('\x1e')) {
    const lines = block.split(/\r?\n/);
    const meta = metaOf(lines[0] ?? '');
    if (!meta) continue;
    for (const line of lines.slice(1)) {
      const path = unquote(line.trim());
      if (!path || seen.has(path)) continue;
      seen.add(path);
      out.push({ path, deletedIn: meta });
    }
  }
  return out;
}

/** Files HEAD has that the working tree no longer has: deletions not committed yet. */
export function gitUncommittedDeletions(dir: string): string[] {
  const r = gitRead(dir, ['diff', '--name-only', '-z', '--diff-filter=D', 'HEAD', '--'], { timeoutMs: 20_000 });
  return r.ok ? r.out.split('\0').filter(Boolean) : [];
}

export type PathFate =
  | { readonly kind: 'deleted'; readonly commit: CommitMeta }
  | { readonly kind: 'moved'; readonly to: string; readonly commit: CommitMeta };
/**
 * What became of paths HEAD no longer has: the commit that deleted each, or the one that moved it away and where to.
 * Null for a path HEAD still has (a change in the working tree, not committed yet) or whose last commit says neither.
 * A few calls per hundred paths, however many there are: a deleted directory is one question, not one per file.
 */
export function gitPathFates(dir: string, relPaths: readonly string[]): Map<string, PathFate | null> {
  const out = new Map<string, PathFate | null>();
  const wanted = [...new Set(relPaths)];
  for (let i = 0; i < wanted.length; i += 100) {
    const chunk = wanted.slice(i, i + 100);
    for (const p of chunk) out.set(p, null);
    const present = gitRead(dir, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...chunk]);
    const inHead = new Set(present.ok ? present.out.split('\0').filter(Boolean) : chunk);
    const open = new Set(chunk.filter((p) => !inHead.has(p)));
    if (open.size === 0) continue;
    const r = gitRead(dir, ['log', '-M', '--full-diff', '--name-status', META_FORMAT, 'HEAD', '--', ...open], { timeoutMs: 60_000 });
    if (!r.ok) continue;
    // Newest first: the first time a path shows up is what last happened to it.
    for (const block of r.out.split('\x1e')) {
      if (open.size === 0) break;
      const lines = block.split(/\r?\n/);
      const meta = metaOf(lines[0] ?? '');
      if (!meta) continue;
      for (const line of lines.slice(1)) {
        const [code, a, b] = line.split('\t');
        if (!a) continue;
        const status = (code ?? '').charAt(0);
        const first = unquote(a);
        if (!open.has(first)) continue;
        if (status === 'R' && b !== undefined) out.set(first, { kind: 'moved', to: unquote(b), commit: meta });
        else if (status === 'D') out.set(first, { kind: 'deleted', commit: meta });
        else if (status === 'C') continue;   // copied from it: the path itself is still there after this commit
        open.delete(first);
      }
    }
  }
  return out;
}
