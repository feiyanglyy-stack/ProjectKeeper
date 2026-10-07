/**
 * A narrow undo journal for Keeper's shell. The command parser supplies the starting directory, every explicit path
 * it could resolve, and the places the command says it writes (command.ts `planShellCommand`). We inspect only the
 * corresponding project roots: Git repositories by porcelain status, ordinary directories by size and mtime. This is a
 * guardrail for ordinary commands, not an OS sandbox for detached writers.
 *
 * What it undoes depends on whether anyone else writes in the project while a command runs (BQ):
 *  - A controlled trial (a home that does not watch its projects): nobody else does, so every change to the working
 *    tree that Git status or the directory scan shows is undone.
 *  - A live project (the home watches its projects): the owner and agents write at the same time, so only what the
 *    command itself names as its writes is undone — its redirection and output targets and the operands of the
 *    commands that write theirs. Anything else that changed while it ran is not its doing: it is left as it is and
 *    reported (`left`).
 * Git's own state — the index, HEAD, refs, anything in a .git directory or file — is never backed up for restore and
 * never restored, on either: other people's git operations and the Keeper's own folder commits change it legitimately.
 * So what a commit made while the command ran is never undone either; it is reported. Changes are judged by content:
 * a path Git status showed before the command is compared with what was saved of it then, any other path with what HEAD
 * held then. The guard's git calls take no lock and never write the index.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, type Stats } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Project } from '../../model/types.ts';
import { LONG_PATHS } from '../../util/git.ts';
import { canonicalKey } from './paths.ts';

/** How a shell step's result starts when something changed in the project while its command ran, not by it (BQ). */
export const LEFT_NOTE = 'Changed while this command ran, not by it';

export interface ShellGuardOptions {
  /** Others write in the project while a command runs (a live project): only `writes` are undone. Default: nobody does. */
  readonly othersWrite?: boolean;
  /** The places the command says it writes (planShellCommand `writePaths`), as canonical keys; a directory covers what is under it. */
  readonly writes?: readonly string[];
}

type Kind = 'file' | 'directory' | 'symlink' | 'other';
type Entry = {
  path: string;
  kind: Kind;
  mode: number;
  size: number;
  mtimeMs: number;
  mtime: Date;
  atime: Date;
  backup?: string;
  digest?: string;
  target?: string;
};
/** A path as a commit holds it: its mode and object (a blob, a link's target, a submodule's commit). */
type TreeEntry = { mode: string; object: string };
type GitScope = {
  root: string;
  pathspec: string | null;
  checkPaths: Set<string>;
  before: Map<string, string>;
  /** Each path status showed before the command, as it was then: saved in full where the guard may restore it. */
  dirty: Map<string, Entry | null>;
  /** HEAD when the command started (null before the first commit): what the working tree held at every other path. */
  head: string | null;
};
type PlainScope = { root: string; before: Map<string, Entry>; excluded: readonly string[] };

const WIN = process.platform === 'win32';
const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const depth = (path: string): number => path.split(/[\\/]/).length;
/** A path in Git's own directory or file (`.git`), the project's or a nested repository's: never restored. */
const gitInternal = (path: string): boolean => path.split(/[\\/]/).includes('.git');

async function statIfPresent(path: string) {
  try { return await lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
}
const kindOf = (st: Stats): Kind => st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other';
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function git(cwd: string, args: string[], input?: Buffer, allowOne = false): Promise<{ code: number; output: Buffer; error: string }> {
  return new Promise((ok, fail) => {
    const env = { ...process.env };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
    const child = spawn('git', ['--no-optional-locks', ...LONG_PATHS, '-C', cwd, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (part: Buffer) => out.push(part));
    child.stderr.on('data', (part: Buffer) => err.push(part));
    child.on('error', fail);
    child.on('close', (code) => {
      const error = Buffer.concat(err).toString('utf8');
      if (code !== 0 && !(allowOne && code === 1)) fail(new Error(`git ${args[0]} failed in ${cwd}: ${error.trim()}`));
      else ok({ code: code ?? -1, output: Buffer.concat(out), error });
    });
    child.stdin.end(input);
  });
}
async function nearestDirectory(path: string): Promise<string> {
  let at = path;
  for (;;) {
    const st = await statIfPresent(at);
    if (st?.isDirectory()) return at;
    const parent = dirname(at);
    if (parent === at) throw new Error(`Cannot locate a directory for shell path ${path}`);
    at = parent;
  }
}
async function gitRoot(path: string): Promise<string | null> {
  const dir = await nearestDirectory(path);
  const result = await git(dir, ['rev-parse', '--show-toplevel'], undefined, true).catch((error: Error) => {
    if (/not a git repository/i.test(error.message)) return null;
    throw error;
  });
  if (!result) return null;
  if (result.code === 1 || result.code === 128) return null;
  return canonicalKey(result.output.toString('utf8').trim(), dir);
}
/** The commit HEAD names (null before the first commit). Read only: no lock, nothing written. */
async function headOf(root: string): Promise<string | null> {
  const result = await git(root, ['rev-parse', '--verify', '-q', 'HEAD'], undefined, true);
  return result.code === 0 ? result.output.toString('utf8').trim() || null : null;
}
function parseStatus(output: Buffer): Map<string, string> {
  const parts = output.toString('utf8').split('\0');
  const status = new Map<string, string>();
  for (let i = 0; i < parts.length && parts[i]; i += 1) {
    const row = parts[i]!;
    if (row.length < 4 || row[2] !== ' ') throw new Error('Cannot parse Git porcelain status; refusing shell command');
    const code = row.slice(0, 2);
    status.set(row.slice(3), code);
    if (/[RC]/.test(code)) {
      const source = parts[++i];
      if (!source) throw new Error('Cannot parse Git rename status; refusing shell command');
      status.set(source, `source:${code}`);
    }
  }
  return status;
}
async function status(scope: Pick<GitScope, 'root' | 'pathspec'>): Promise<Map<string, string>> {
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all'];
  if (scope.pathspec) args.push('--', scope.pathspec);
  return parseStatus((await git(scope.root, args)).output);
}
/** Split paths for command lines Windows accepts (about 32,000 characters). */
function chunks(paths: readonly string[], limit = 20_000): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const path of paths) {
    if (current.length && length + path.length + 12 > limit) { out.push(current); current = []; length = 0; }
    current.push(path);
    length += path.length + 12;
  }
  if (current.length) out.push(current);
  return out;
}
/** What `head` held at each of these repository paths (null where it held nothing), read from Git's objects. */
async function treeEntries(root: string, head: string | null, paths: readonly string[]): Promise<Map<string, TreeEntry | null>> {
  const found = new Map<string, TreeEntry | null>(paths.map((path) => [path, null]));
  if (!head) return found;
  for (const part of chunks(paths)) {
    const out = (await git(root, ['ls-tree', '-z', head, '--', ...part.map((path) => `:(literal)${path}`)])).output.toString('utf8');
    for (const row of out.split('\0')) {
      const m = /^(\d{6}) \w+ ([0-9a-f]+)\t([\s\S]*)$/.exec(row);
      if (m && found.has(m[3]!)) found.set(m[3]!, { mode: m[1]!, object: m[2]! });
    }
  }
  return found;
}
/** The blob Git would make of each of these files as they are now (its clean filters applied); nothing is written. A
 *  file that cannot be hashed (it went away meanwhile) is left out, and so counts as changed. */
async function worktreeBlobs(root: string, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const batch = paths.filter((path) => !/[\r\n]/.test(path));
  const one = async (path: string) => {
    try {
      const content = await readFile(resolve(root, path));
      out.set(path, (await git(root, ['hash-object', '--stdin', `--path=${path}`], content)).output.toString('utf8').trim());
    } catch { /* gone or unreadable: counts as changed */ }
  };
  if (batch.length) {
    try {
      const hashes = (await git(root, ['hash-object', '--stdin-paths'], Buffer.from(`${batch.join('\n')}\n`))).output.toString('utf8').trim().split(/\r?\n/);
      if (hashes.length !== batch.length) throw new Error('hash-object answered a different number of paths');
      batch.forEach((path, i) => out.set(path, hashes[i]!));
    } catch { for (const path of batch) await one(path); }
  }
  for (const path of paths.filter((item) => /[\r\n]/.test(item))) await one(path);
  return out;
}
/** Of these repository paths, those that are regular files now and were files or links in `head`: the ones to hash. */
async function filesToHash(root: string, paths: readonly string[], was: ReadonlyMap<string, TreeEntry | null>): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    const entry = was.get(path);
    if (!entry || entry.mode === '160000') continue;
    if ((await statIfPresent(resolve(root, path)))?.isFile()) out.push(path);
  }
  return out;
}
/** The paths a change of HEAD while the command ran changed (a commit, a reset, a switch), within the scope. */
async function movedPaths(scope: GitScope, from: string | null, to: string | null): Promise<string[]> {
  if (from === to || !to) return [];
  const spec = scope.pathspec ? ['--', scope.pathspec] : [];
  const out = from
    ? await git(scope.root, ['diff', '--name-only', '-z', '--no-renames', from, to, ...spec])
    : await git(scope.root, ['ls-tree', '-r', '--name-only', '-z', to, ...spec]);
  return out.output.toString('utf8').split('\0').filter(Boolean);
}
/** What a path is now; with `backup`, a copy to restore it from (and its digest), otherwise only what tells a change. */
async function capture(path: string, backup: string | null, digest: boolean): Promise<Entry | null> {
  const st = await statIfPresent(path);
  if (!st) return null;
  const kind = kindOf(st);
  if (kind === 'other' && backup) throw new Error(`Unsupported filesystem entry in shell guard: ${path}`);
  const entry: Entry = { path, kind, mode: st.mode, size: st.size, mtimeMs: st.mtimeMs, mtime: st.mtime, atime: st.atime };
  if (kind === 'symlink') entry.target = await readlink(path);
  if (kind === 'file' && backup) {
    await mkdir(dirname(backup), { recursive: true });
    await copyFile(path, backup, constants.COPYFILE_FICLONE);
    entry.backup = backup;
    if (digest) entry.digest = await hashFile(backup);
  }
  return entry;
}
async function same(entry: Entry | null, hash: boolean): Promise<boolean> {
  if (!entry) return false;
  const now = await statIfPresent(entry.path);
  if (!now) return false;
  const kind = kindOf(now);
  if (kind !== entry.kind || now.mode !== entry.mode || now.size !== entry.size || now.mtimeMs !== entry.mtimeMs) return false;
  if (kind === 'symlink') return (await readlink(entry.path)) === entry.target;
  return !hash || kind !== 'file' || (await hashFile(entry.path)) === entry.digest;
}
/** The path holds what `entry` recorded, by content rather than timestamps: how a restore is verified. */
async function holds(entry: Entry | null, path: string): Promise<boolean> {
  const now = await statIfPresent(path);
  if (!entry || !now) return !entry && !now;
  if (kindOf(now) !== entry.kind) return false;
  if (entry.kind === 'symlink') return (await readlink(path)) === entry.target;
  return entry.kind !== 'file' || entry.digest === undefined || (await hashFile(path)) === entry.digest;
}
/** Whether a path holds now what `was` says a commit held there (null: nothing), as Git compares a file with its blob. */
async function holdsTree(root: string, path: string, was: TreeEntry | null, blob: string | undefined): Promise<boolean> {
  const now = await statIfPresent(resolve(root, path));
  if (!was || !now) return !was && !now;
  if (was.mode === '160000') return false;                   // a submodule status shows is taken as changed
  if (now.isSymbolicLink()) return was.mode === '120000' && (await readlink(resolve(root, path))) === (await git(root, ['cat-file', 'blob', was.object])).output.toString('utf8');
  if (!now.isFile()) return false;
  if (!WIN && was.mode !== '120000' && ((now.mode & 0o111) !== 0) !== (was.mode === '100755')) return false;
  return blob === was.object;
}
async function restoreEntry(path: string, entry: Entry | null): Promise<void> {
  if (!entry) { await rm(path, { recursive: true, force: true }); return; }
  if (entry.kind === 'file' && !entry.backup) throw new Error(`No copy was kept to restore ${path}`);
  await rm(path, { recursive: true, force: true });
  await mkdir(dirname(path), { recursive: true });
  if (entry.kind === 'directory') await mkdir(path, { recursive: true });
  else if (entry.kind === 'symlink') await symlink(entry.target!, path);
  else await copyFile(entry.backup!, path);
  if (entry.kind !== 'symlink') {
    await chmod(path, entry.mode);
    await utimes(path, entry.atime, entry.mtime);
  }
}
/** Put back what a commit held at a path, as a checkout writes it (its smudge filters applied), or remove what it did not hold. */
async function restoreTree(root: string, path: string, was: TreeEntry | null): Promise<void> {
  const absolute = resolve(root, path);
  if (!was) { await rm(absolute, { recursive: true, force: true }); return; }
  if (was.mode === '160000') throw new Error(`A Git submodule changed and cannot be restored safely: ${absolute}`);
  const link = was.mode === '120000';
  const content = (await git(root, link ? ['cat-file', 'blob', was.object] : ['cat-file', '--filters', `--path=${path}`, was.object])).output;
  await rm(absolute, { recursive: true, force: true });
  await mkdir(dirname(absolute), { recursive: true });
  if (link && !WIN) { await symlink(content.toString('utf8'), absolute); return; }
  await writeFile(absolute, content);
  if (!WIN) await chmod(absolute, was.mode === '100755' ? 0o755 : 0o644);
}
/** A directory that holds a repository of its own (`.git` inside): Git's, never removed. */
async function nestedRepository(path: string): Promise<boolean> {
  return (await statIfPresent(path))?.isDirectory() === true && (await statIfPresent(join(path, '.git'))) !== null;
}
async function scanPlain(root: string, backupDir: string | null, excluded: readonly string[], keep?: (path: string) => boolean): Promise<Map<string, Entry>> {
  const found = new Map<string, Entry>();
  const queue = [root];
  while (queue.length) {
    const path = queue.pop()!;
    if (excluded.some((item) => within(path, item)) || path.split(sep).includes('.git')) continue;
    const st = await statIfPresent(path);
    if (!st) continue;
    const kind = kindOf(st);
    // A socket or a named pipe (a server's socket in `tmp/`, an editor's) is noted as being there and nothing more: it
    // holds no content to save, and its times move with use. Refusing the directory for holding one stopped every
    // command in such a project.
    const entry: Entry = { path, kind, mode: st.mode, size: st.size, mtimeMs: st.mtimeMs, mtime: st.mtime, atime: st.atime };
    if (entry.kind === 'symlink') entry.target = await readlink(path);
    if (entry.kind === 'file' && backupDir && (!keep || keep(path))) {
      const backup = join(backupDir, relative(root, path) || '_root');
      await mkdir(dirname(backup), { recursive: true });
      await copyFile(path, backup, constants.COPYFILE_FICLONE);
      entry.backup = backup;
    }
    found.set(path, entry);
    if (entry.kind === 'directory') for (const child of await readdir(path)) queue.push(join(path, child));
  }
  return found;
}

/** Project locations and separately scoped repositories/worktrees. Nested roots stay separate so
 * an explicit path into an inner worktree selects that repository rather than its parent. */
export function shellProjectRoots(project: Pick<Project, 'locations' | 'scope'>): string[] {
  const candidates = [
    ...project.locations,
    ...project.scope.filter((item) => !item.missing && item.relation !== 'Excluded'
      && (item.category === 'Repository' || item.category === 'Worktree' || item.category === 'Directory'))
      .map((item) => item.path),
  ].map((path) => canonicalKey(path, path));
  return [...new Set(candidates)];
}

// Several pi calls and jobs can share a worktree. Serialize their shell checks within this process.
let previousShell: Promise<void> = Promise.resolve();
export async function withShellWriteLock<T>(run: () => Promise<T>): Promise<T> {
  const before = previousShell;
  let release!: () => void;
  previousShell = new Promise<void>((done) => { release = done; });
  await before;
  try { return await run(); } finally { release(); }
}

export class ShellProjectSnapshot {
  private readonly gitScopes: GitScope[] = [];
  private readonly plainScopes: PlainScope[] = [];
  private readonly backupDir: string;
  private readonly othersWrite: boolean;
  private readonly writes: readonly string[];
  private leftPaths: string[] = [];
  private constructor(backupDir: string, options: ShellGuardOptions) {
    this.backupDir = backupDir;
    this.othersWrite = options.othersWrite === true;
    this.writes = options.writes ?? [];
  }

  /** Whether the guard may undo a change here: on a controlled trial anything but Git's own; on a live project only
   *  what the command names as its writes. `path` lies under a canonical root, so folding its case gives its key. */
  private restorable(path: string): boolean {
    if (gitInternal(path)) return false;
    if (!this.othersWrite) return true;
    const key = WIN ? path.toLowerCase() : path;
    return this.writes.some((write) => within(key, write));
  }

  static async take(roots: readonly string[], guardHome: string, locations: readonly string[] = roots, excludedRoots: readonly string[] = [], options: ShellGuardOptions = {}): Promise<ShellProjectSnapshot> {
    const projectRoots = roots.map((path) => canonicalKey(path, path));
    const excluded = excludedRoots.map((path) => canonicalKey(path, path));
    const backupKey = canonicalKey(guardHome, guardHome);
    if (projectRoots.some((root) => within(backupKey, root))) throw new Error('Shell guard backup directory is inside the project; refusing command');
    await mkdir(guardHome, { recursive: true });
    const backupDir = await mkdtemp(join(guardHome, 'shell-'));
    const snapshot = new ShellProjectSnapshot(backupDir, options);
    try {
      const candidates = new Map<string, { scope: string; target: string; path: string }>();
      for (const path of locations) {
        const key = canonicalKey(path, path);
        const containing = projectRoots.filter((root) => within(key, root)).sort((a, b) => b.length - a.length);
        const scope = containing[0];
        if (!scope || excluded.some((item) => within(key, item))) continue;
        const target = await nearestDirectory(key);
        candidates.set(key, { scope, target, path: key });
      }
      const gitByKey = new Map<string, GitScope>();
      const plainRoots: string[] = [];
      for (const { scope, target, path } of candidates.values()) {
        const repo = await gitRoot(target);
        if (!repo || (!within(scope, repo) && !within(repo, scope))) { plainRoots.push(target); continue; }
        const pathspec = projectRoots.some((root) => within(repo, root)) ? null : relative(repo, scope).replaceAll('\\', '/');
        const key = `${repo}\0${pathspec ?? ''}`;
        let gitScope = gitByKey.get(key);
        if (!gitScope) {
          gitScope = { root: repo, pathspec, checkPaths: new Set(), before: new Map(), dirty: new Map(), head: null };
          gitByKey.set(key, gitScope);
          snapshot.gitScopes.push(gitScope);
        }
        gitScope.checkPaths.add(relative(repo, path).replaceAll('\\', '/') || '.');
      }
      // Any explicit path into an ignored tree is rejected before the shell starts. The initial
      // working directory itself is checked too; ordinary reads of tracked paths remain cheap.
      for (const scope of snapshot.gitScopes) {
        const paths = [...scope.checkPaths];
        if (paths.length) {
          const result = await git(scope.root, ['check-ignore', '-z', '--stdin'], Buffer.from(paths.join('\0') + '\0'), true);
          if (result.output.length) throw new Error(`Refused: shell path is Git-ignored (${result.output.toString('utf8').split('\0').filter(Boolean).join(', ')}); it cannot be checked by Git status.`);
        }
        [scope.before, scope.head] = await Promise.all([status(scope), headOf(scope.root)]);
        const label = String(snapshot.gitScopes.indexOf(scope));
        for (const path of scope.before.keys()) {
          const absolute = resolve(scope.root, path);
          if (!within(absolute, scope.root)) throw new Error('Git status returned a path outside the repository');
          // Saved in full only where the guard may restore it; elsewhere what tells a change is enough (a live project).
          const restorable = snapshot.restorable(absolute);
          const prior = await capture(absolute, restorable ? join(backupDir, 'git', label, path) : null, restorable);
          if (restorable && prior?.kind === 'directory') throw new Error(`Refused: a dirty Git directory cannot be restored safely: ${absolute}`);
          scope.dirty.set(path, prior);
        }
      }
      const narrowed = plainRoots.filter((root, i) => !plainRoots.some((other, j) => i !== j && within(root, other) && (root !== other || j < i)));
      for (const [i, root] of narrowed.entries()) {
        snapshot.plainScopes.push({ root, before: await scanPlain(root, join(backupDir, 'plain', String(i)), excluded, (path) => snapshot.restorable(path)), excluded });
      }
      return snapshot;
    } catch (error) {
      await rm(backupDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Undo what the guard may undo of the changes seen by the selected Git statuses and plain-directory scans; returns
   *  the paths restored. What changed but was not the command's doing is in `left` afterwards. */
  async restore(): Promise<string[]> {
    const changed: string[] = [];
    const left: string[] = [];
    try {
      for (const scope of this.gitScopes) await this.restoreGit(scope, changed, left);
      for (const scope of this.plainScopes) await this.restorePlain(scope, changed, left);
      await rm(this.backupDir, { recursive: true, force: true });
      this.leftPaths = [...new Set(left)];
      return changed;
    } catch (error) {
      throw new Error(`Shell project check could not restore the project. Recovery copy: ${this.backupDir}. ${String(error)}`, { cause: error });
    }
  }

  /** After `restore()`: the paths that changed while the command ran and were left as they are — on a live project what
   *  it did not name as its writes, on either what a commit or other change of HEAD made. */
  get left(): readonly string[] { return this.leftPaths; }

  private async restoreGit(scope: GitScope, changed: string[], left: string[]): Promise<void> {
    const [after, head] = await Promise.all([status(scope), headOf(scope.root)]);
    // Every path status shows before or after. One it showed before is compared with what was saved of it then; any
    // other was clean then, so the working tree held what HEAD held — an index or HEAD moved by someone else's git
    // command changes its status, not its content, and is no change to undo.
    const shown = [...new Set([...scope.before.keys(), ...after.keys()])].filter((path) => !gitInternal(path));
    const fresh = shown.filter((path) => !scope.before.has(path));
    const was = await treeEntries(scope.root, scope.head, fresh);
    const blobs = await worktreeBlobs(scope.root, await filesToHash(scope.root, fresh, was));
    const restored: string[] = [];
    for (const path of shown) {
      const absolute = resolve(scope.root, path);
      const original = scope.dirty.get(path) ?? null;
      const unchanged = scope.before.has(path)
        ? original ? await same(original, original.digest !== undefined) : !(await statIfPresent(absolute))
        : await holdsTree(scope.root, path, was.get(path) ?? null, blobs.get(path));
      if (unchanged) continue;
      if (!this.restorable(absolute) || await nestedRepository(absolute)) { left.push(absolute); continue; }
      if (scope.before.has(path)) {
        if ((await statIfPresent(absolute))?.isDirectory()) {
          const stage = await git(scope.root, ['ls-files', '--stage', '--', path]);
          if (stage.output.toString('utf8').startsWith('160000 ')) throw new Error(`A Git submodule changed and cannot be restored safely: ${absolute}`);
        }
        await restoreEntry(absolute, original);
      } else await restoreTree(scope.root, path, was.get(path) ?? null);
      restored.push(path);
      changed.push(absolute);
    }
    if (restored.length) {
      const again = await worktreeBlobs(scope.root, await filesToHash(scope.root, restored.filter((path) => !scope.before.has(path)), was));
      for (const path of restored) {
        const back = scope.before.has(path)
          ? await holds(scope.dirty.get(path) ?? null, resolve(scope.root, path))
          : await holdsTree(scope.root, path, was.get(path) ?? null, again.get(path));
        if (!back) throw new Error(`The working tree still differs after restoring ${resolve(scope.root, path)}`);
      }
    }
    // HEAD moved while the command ran (a commit, a reset): that is Git's, never undone. What it changed that status no
    // longer shows is reported with the rest.
    if (head !== scope.head) {
      const seen = new Set(shown);
      for (const path of await movedPaths(scope, scope.head, head)) if (!seen.has(path) && !gitInternal(path)) left.push(resolve(scope.root, path));
    }
  }

  private async restorePlain(scope: PlainScope, changed: string[], left: string[]): Promise<void> {
    const after = await scanPlain(scope.root, null, scope.excluded);
    for (const path of [...after.keys()].filter((path) => !scope.before.has(path)).sort((a, b) => depth(b) - depth(a))) {
      if (!this.restorable(path)) { left.push(path); continue; }
      await rm(path, { recursive: true, force: true });
      changed.push(path);
    }
    for (const entry of [...scope.before.values()].sort((a, b) => depth(a.path) - depth(b.path))) {
      if (entry.kind === 'directory') {
        const now = await statIfPresent(entry.path);
        if (now?.isDirectory()) {
          if (now.mode === entry.mode) continue;
          if (this.restorable(entry.path)) { await chmod(entry.path, entry.mode); changed.push(entry.path); } else left.push(entry.path);
          continue;
        }
      }
      if (entry.kind === 'other') {
        // Still a socket or a pipe: unchanged, whatever its times say. Gone or become something else: that cannot be
        // put back, so it is reported and left.
        const now = await statIfPresent(entry.path);
        if (!now || kindOf(now) !== 'other') left.push(entry.path);
        continue;
      }
      if (await same(entry, false)) continue;
      if (!this.restorable(entry.path)) { left.push(entry.path); continue; }
      await restoreEntry(entry.path, entry);
      changed.push(entry.path);
    }
    // A child insertion changes parent directory mtime. Restore directory timestamps last, where the guard may restore.
    for (const entry of [...scope.before.values()].filter((item) => item.kind === 'directory' && this.restorable(item.path)).sort((a, b) => depth(b.path) - depth(a.path))) {
      const now = await statIfPresent(entry.path);
      if (now && now.mtimeMs !== entry.mtimeMs) await utimes(entry.path, entry.atime, entry.mtime);
    }
  }

  get recoveryPath(): string { return resolve(this.backupDir); }
}
