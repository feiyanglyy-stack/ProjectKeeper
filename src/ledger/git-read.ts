/**
 * The ledger's git reads (CKC-22; Spec §1.16). Everything here only reads, and runs as
 * `git -C <dir> --no-optional-locks …` with the owner's display settings switched off, so observing a repository never
 * changes it (Spec §1.1) and a local git setting (colour, no rename detection, a pager) cannot change what is read. No
 * network: no fetch, pull or remote query — only what the repository already has.
 */
import { execFileSync } from 'node:child_process';
import { normalizePath } from '../util/paths.ts';

export interface GitOut { readonly ok: boolean; readonly out: string; readonly err: string }

function env(): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!['GIT_PAGER', 'PAGER', 'GIT_EXTERNAL_DIFF', 'GIT_OPTIONAL_LOCKS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key.toUpperCase())) copy[key] = value;
  }
  copy.GIT_OPTIONAL_LOCKS = '0';
  copy.GIT_TERMINAL_PROMPT = '0';
  return copy;
}

/** Settings that decide what git prints; fixed so the owner's configuration cannot change what the ledger reads. */
const FIXED = [
  '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'color.ui=false', '-c', 'log.showRoot=true',
  '-c', 'diff.renames=true', '-c', 'diff.noprefix=false', '-c', 'log.decorate=false', '-c', 'log.showSignature=false',
  // Long ref names (refs/codex/turn-diffs/…) exceed Windows' path limit when stored as loose refs.
  '-c', 'core.longpaths=true',
  '--no-optional-locks',
];

export function ledgerGit(dir: string, args: readonly string[], opts: { timeoutMs?: number; maxBuffer?: number; input?: string } = {}): GitOut {
  try {
    const out = execFileSync('git', [...FIXED, '-C', dir, ...args], {
      encoding: 'utf8', env: env(), timeout: opts.timeoutMs ?? 180_000, maxBuffer: opts.maxBuffer ?? 512_000_000, windowsHide: true,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(opts.input === undefined ? {} : { input: opts.input }),
    });
    return { ok: true, out, err: '' };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: typeof e.stdout === 'string' ? e.stdout : '', err: (e.stderr || e.message || String(error)).trim() };
  }
}

export const isHash = (h: string): boolean => /^[0-9a-f]{40}$/.test(h);

export type RefNamespace = 'heads' | 'tags' | 'remotes' | 'stash' | 'other';
export interface RefInfo {
  readonly refname: string;
  readonly namespace: RefNamespace;
  /** The commit the ref ultimately names (an annotated tag peeled); for a ref to a tree or a blob, that object. */
  readonly tip: string;
  readonly type: 'commit' | 'tree' | 'blob' | 'tag' | 'unknown';
}

export function namespaceOf(refname: string): RefNamespace {
  if (refname.startsWith('refs/heads/')) return 'heads';
  if (refname.startsWith('refs/tags/')) return 'tags';
  if (refname.startsWith('refs/remotes/')) return 'remotes';
  if (refname === 'refs/stash') return 'stash';
  return 'other';   // e.g. refs/codex/turn-diffs/…
}

/**
 * Every ref, tags peeled; a symbolic remote HEAD (`refs/remotes/origin/HEAD`) is left out. A ref that names something
 * other than a commit (refs/codex/turn-diffs/… name trees) is kept with its object type: it is part of what the
 * repository records, and has no history to walk.
 */
export function listRefs(dir: string): RefInfo[] {
  const r = ledgerGit(dir, ['for-each-ref', '--format=%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)%00%(symref)']);
  if (!r.ok) return [];
  const out: RefInfo[] = [];
  for (const line of r.out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [refname, type, object, peeledType, peeled, symref] = line.split('\0');
    if (!refname || symref) continue;
    const commit = type === 'commit' ? object : peeledType === 'commit' ? peeled : '';
    if (commit && isHash(commit)) out.push({ refname, namespace: namespaceOf(refname), tip: commit, type: 'commit' });
    else if (object && isHash(object)) out.push({ refname, namespace: namespaceOf(refname), tip: object, type: (peeledType || type || 'unknown') as RefInfo['type'] });
  }
  return out;
}

/** The commits reachable from `tips` and from none of `exclude` (full hashes), in one read. */
export function revList(dir: string, tips: readonly string[], exclude: readonly string[] = []): string[] | null {
  if (tips.length === 0) return [];
  const r = ledgerGit(dir, ['rev-list', '--stdin'], { input: [...tips, ...exclude.map((h) => `^${h}`)].join('\n') + '\n' });
  return r.ok ? r.out.split(/\s+/).filter(isHash) : null;
}

/** The commits on the first-parent line of a tip. */
export function firstParentLine(dir: string, tip: string): string[] {
  const r = ledgerGit(dir, ['rev-list', '--first-parent', tip]);
  return r.ok ? r.out.split(/\s+/).filter(isHash) : [];
}

/** Whether `ancestor` is reachable from `descendant`; null when git cannot tell (a missing object). */
export function isAncestor(dir: string, ancestor: string, descendant: string): boolean | null {
  if (ancestor === descendant) return true;
  const r = ledgerGit(dir, ['merge-base', '--is-ancestor', ancestor, descendant], { timeoutMs: 30_000 });
  if (r.ok) return true;
  return /^\s*$/.test(r.err) ? false : null;
}

export interface CommitFileChange {
  readonly status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  readonly path: string;
  /** Rename or copy source. */
  readonly from: string | null;
  readonly oldBlob: string | null;
  readonly newBlob: string | null;
  /** Null for a binary file. */
  readonly added: number | null;
  readonly deleted: number | null;
}
export interface CommitDetail {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly authorAt: string;
  readonly committerAt: string;
  readonly author: string;
  readonly subject: string;
  readonly body: string;
  readonly files: readonly CommitFileChange[];
}

const ZERO = /^0{40}$/;
const DETAIL_FORMAT = '--format=%x1e%H%x1f%P%x1f%aI%x1f%cI%x1f%an%x1f%s%x1f%b%x04';

/**
 * Parse `git log -z --raw --numstat` output. With -z every field ends in NUL: a raw entry is `:modes blobs STATUS` and
 * then its path (two paths for a rename or a copy); a numstat entry is `added\tdeleted\tpath`, or `added\tdeleted\t`
 * followed by the two paths of a rename. A commit's header is the format above, from \x1e to \x04.
 */
export function parseLogZ(out: string): CommitDetail[] {
  const tokens = out.split('\0');
  const commits: CommitDetail[] = [];
  let head: { hash: string; parents: string[]; authorAt: string; committerAt: string; author: string; subject: string; body: string } | null = null;
  let files = new Map<string, { status: CommitFileChange['status']; path: string; from: string | null; oldBlob: string | null; newBlob: string | null; added: number | null; deleted: number | null }>();
  const flush = () => {
    if (head) commits.push({ ...head, files: [...files.values()] });
    head = null;
    files = new Map();
  };
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i]!;
    const start = t.indexOf('\x1e');
    if (start >= 0) {
      flush();
      t = t.slice(start + 1);
      const end = t.lastIndexOf('\x04');
      const fields = (end >= 0 ? t.slice(0, end) : t).split('\x1f');
      const hash = fields[0] ?? '';
      if (!isHash(hash)) continue;
      head = {
        hash, parents: (fields[1] ?? '').split(' ').filter(isHash), authorAt: fields[2] ?? '', committerAt: fields[3] ?? '',
        author: fields[4] ?? '', subject: fields[5] ?? '', body: (fields.slice(6).join('\x1f')).replace(/\s+$/, ''),
      };
      continue;
    }
    if (!head) continue;
    t = t.replace(/^\n+/, '');
    if (!t) continue;
    const raw = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([AMDRCTUX])(\d*)$/.exec(t);
    if (raw) {
      const status = raw[5] as CommitFileChange['status'];
      const two = status === 'R' || status === 'C';
      const first = tokens[i + 1] ?? '';
      const second = two ? tokens[i + 2] ?? '' : null;
      i += two ? 2 : 1;
      if (!'AMDRCT'.includes(status)) continue;
      const path = two ? second! : first;
      files.set(path, {
        status, path, from: two ? first : null,
        oldBlob: ZERO.test(raw[3]!) ? null : raw[3]!, newBlob: ZERO.test(raw[4]!) ? null : raw[4]!,
        added: null, deleted: null,
      });
      continue;
    }
    const num = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(t);
    if (num) {
      let path = num[3]!;
      if (path === '') { path = tokens[i + 2] ?? ''; i += 2; }
      const entry = files.get(path);
      if (entry) {
        entry.added = num[1] === '-' ? null : Number(num[1]);
        entry.deleted = num[2] === '-' ? null : Number(num[2]);
      }
    }
  }
  flush();
  return commits;
}

/**
 * The details of the given commits in one pass per 2,000: metadata, the whole message, and every file changed against
 * the first parent — status, rename or copy source, old and new content ids, line counts (rename-aware). A merge's
 * changes are what it brought into the line it was merged onto; a root commit's are everything it added.
 */
export function logDetails(dir: string, hashes: readonly string[]): { details: CommitDetail[]; failed: number } {
  const out: CommitDetail[] = [];
  let failed = 0;
  for (let i = 0; i < hashes.length; i += 2000) {
    const chunk = hashes.slice(i, i + 2000);
    const r = ledgerGit(dir, ['log', '--no-walk', '--stdin', '--diff-merges=first-parent', '-M', '--raw', '--no-abbrev', '--numstat', '--no-textconv', '--no-ext-diff', '-z', DETAIL_FORMAT], { input: chunk.join('\n') + '\n' });
    if (!r.ok) { failed += chunk.length; continue; }
    out.push(...parseLogZ(r.out));
  }
  return { details: out, failed };
}

/** Contents of blobs by id, one `git cat-file --batch` per 500; a missing object maps to null. */
export function catBlobs(dir: string, blobs: readonly string[]): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  const wanted = [...new Set(blobs)];
  for (let i = 0; i < wanted.length; i += 500) {
    const chunk = wanted.slice(i, i + 500);
    let buf: Buffer;
    try {
      buf = execFileSync('git', [...FIXED, '-C', dir, 'cat-file', '--batch'], {
        input: chunk.join('\n') + '\n', env: env(), timeout: 300_000, maxBuffer: 1_500_000_000, windowsHide: true,
      });
    } catch {
      for (const q of chunk) out.set(q, null);
      continue;
    }
    let pos = 0;
    let q = 0;
    while (pos < buf.length && q < chunk.length) {
      const eol = buf.indexOf(10, pos);
      if (eol < 0) break;
      const header = buf.subarray(pos, eol).toString('latin1');
      pos = eol + 1;
      const query = chunk[q]!;
      q += 1;
      const m = /^[0-9a-f]{40} (\S+) (\d+)$/.exec(header);
      if (!m) { out.set(query, null); continue; }   // "<id> missing"
      const size = Number(m[2]);
      out.set(query, m[1] === 'blob' ? buf.subarray(pos, pos + size) : null);
      pos += size + 1;
    }
    while (q < chunk.length) { out.set(chunk[q]!, null); q += 1; }
  }
  return out;
}

/** Whether content looks like text: no NUL in its first 8,000 bytes. */
export const isText = (buf: Buffer): boolean => !buf.subarray(0, Math.min(buf.length, 8000)).includes(0);

export interface TreeFile { readonly path: string; readonly size: number | null; readonly blob: string; readonly submodule: boolean }
/** The files of a commit's tree, with content ids and sizes (a submodule has no size). */
export function treeFiles(dir: string, ref: string): TreeFile[] {
  const r = ledgerGit(dir, ['ls-tree', '-r', '-l', '-z', ref]);
  if (!r.ok) return [];
  const out: TreeFile[] = [];
  for (const entry of r.out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, blob, size] = entry.slice(0, tab).trim().split(/\s+/);
    const path = entry.slice(tab + 1);
    if (mode === '160000' || type === 'commit') { out.push({ path, size: null, blob: blob ?? '', submodule: true }); continue; }
    if (type !== 'blob') continue;
    out.push({ path, size: size && /^\d+$/.test(size) ? Number(size) : null, blob: blob ?? '', submodule: false });
  }
  return out;
}

/** The repository's default branch (the trunk): origin's HEAD when set, else main, else master, else the checked-out branch. */
export function defaultBranch(dir: string, refs: readonly RefInfo[]): string | null {
  const origin = ledgerGit(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { timeoutMs: 15_000 });
  if (origin.ok && origin.out.trim()) {
    const name = origin.out.trim().replace(/^[^/]+\//, '');
    if (name && refs.some((r) => r.refname === `refs/heads/${name}`)) return name;
  }
  for (const name of ['main', 'master', 'trunk', 'develop']) if (refs.some((r) => r.refname === `refs/heads/${name}`)) return name;
  const current = ledgerGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 15_000 });
  return current.ok && current.out.trim() ? current.out.trim() : null;
}

export function headOf(dir: string): { hash: string | null; branch: string | null } {
  const h = ledgerGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { timeoutMs: 15_000 }).out.trim();
  const b = ledgerGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 15_000 }).out.trim();
  return { hash: isHash(h) ? h : null, branch: b || null };
}

export interface WorktreeEntry {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly prunable: boolean;
}
/** `git worktree list --porcelain`, the main checkout first. */
export function worktreeList(dir: string): WorktreeEntry[] {
  const r = ledgerGit(dir, ['worktree', 'list', '--porcelain', '-z'], { timeoutMs: 30_000 });
  if (!r.ok) return [];
  const out: WorktreeEntry[] = [];
  let cur: { path?: string; head?: string; branch?: string; detached?: boolean; bare?: boolean; prunable?: boolean } = {};
  const flush = () => {
    if (cur.path) out.push({ path: normalizePath(cur.path), head: cur.head ?? null, branch: cur.branch?.replace(/^refs\/heads\//, '') ?? null, detached: cur.detached === true, bare: cur.bare === true, prunable: cur.prunable === true });
    cur = {};
  };
  for (const field of r.out.split('\0')) {
    if (field.startsWith('worktree ')) { flush(); cur.path = field.slice(9); }
    else if (field.startsWith('HEAD ')) cur.head = field.slice(5);
    else if (field.startsWith('branch ')) cur.branch = field.slice(7);
    else if (field === 'detached') cur.detached = true;
    else if (field === 'bare') cur.bare = true;
    else if (field.startsWith('prunable')) cur.prunable = true;
    else if (field === '') flush();
  }
  flush();
  return out;
}

/** Uncommitted changes of a checkout (porcelain lines); null when git cannot read it. Takes no lock (GIT_OPTIONAL_LOCKS=0). */
export function uncommitted(dir: string): string[] | null {
  const r = ledgerGit(dir, ['status', '--porcelain', '--untracked-files=normal'], { timeoutMs: 60_000 });
  return r.ok ? r.out.split(/\r?\n/).filter((l) => l.trim()) : null;
}
