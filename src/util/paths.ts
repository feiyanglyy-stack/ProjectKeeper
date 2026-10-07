import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';

const WIN = process.platform === 'win32';

/** Absolute, normalised, without a trailing separator. Display form keeps the original case. */
export function normalizePath(path: string): string {
  const abs = normalize(isAbsolute(path) ? path : resolve(path));
  const root = parse(abs).root;
  let out = abs;
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
}

/**
 * The one spelling of a path, as the file system itself gives it: absolute, with links and junctions resolved and, on
 * Windows, 8.3 short names expanded (`C:\Users\RUNNER~1` → `C:\Users\runneradmin`), a `subst` drive followed and
 * every name in the case it has on disk. git reports paths this way (`rev-parse --show-toplevel`, `worktree list`),
 * so a path that enters ProjectKeeper — a project's location, the home, a directory a configuration file names — is
 * put in this spelling before it is kept or compared; two spellings of one directory compared as text are two
 * directories, and a repository then looks like it is not one. What does not exist yet keeps its missing tail on top
 * of the real spelling of the part that exists. A mapped network drive keeps its drive letter (its real spelling is
 * a `\\server\share` path, which not every program can work in).
 */
export function canonicalPath(path: string): string {
  const abs = normalizePath(path);
  const tail: string[] = [];
  for (let head = abs; ;) {
    let real: string | null = null;
    try { real = realpathSync.native(head); } catch {
      // Some volumes (a RAM disk, some network file systems) do not answer the native call; the links are still resolved.
      try { real = realpathSync(head); } catch { real = null; }
    }
    if (real !== null) {
      if (WIN && real.startsWith('\\\\') && !abs.startsWith('\\\\')) return abs;
      return normalizePath(tail.length ? join(real, ...tail.reverse()) : real);
    }
    const parent = dirname(head);
    if (parent === head) return abs;   // nothing of it exists, not even its root
    tail.push(basename(head));
    head = parent;
  }
}

/** Comparison key: case-folded on Windows. Never shown to the user. */
export function pathKey(path: string): string {
  const normalised = normalizePath(path);
  return WIN ? normalised.toLowerCase() : normalised;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** A path that says where it is in full, drive included on Windows; any other would be completed from wherever this process runs. */
const FULL_PATH = WIN ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/ : /^\//;

/**
 * Comparison key of the directory a path names: `pathKey` of its `canonicalPath`, so two spellings of one directory
 * give one key. For a path somebody else wrote down — the working directory in an agent's session log — which is in
 * whatever spelling that program ran under. A directory that no longer exists has no real spelling to ask for: its
 * missing part is compared as text, on top of the real spelling of the part that exists. So a session recorded through
 * a junction or a `subst` drive that is gone since is not recognised.
 */
export function directoryKey(path: string): string {
  return pathKey(FULL_PATH.test(path) ? canonicalPath(path) : path);
}

/** Two paths name one directory: the same text, or two spellings of it by the file system's own judgement. */
export function sameDirectory(a: string, b: string): boolean {
  return samePath(a, b) || directoryKey(a) === directoryKey(b);
}

/** `path` is `root` or lives under it. */
export function isWithin(root: string, path: string): boolean {
  const r = pathKey(root);
  const p = pathKey(path);
  return p === r || p.startsWith(r + sep);
}

export function relativeDisplay(root: string, path: string): string {
  const rel = relative(normalizePath(root), normalizePath(path));
  return rel.split(sep).join('/');
}

export function expandHome(path: string): string {
  return path.startsWith('~') ? resolve(homedir(), path.slice(1).replace(/^[\\/]/, '')) : path;
}

/**
 * Claude Code stores a project's sessions under `~/.claude/projects/<encoded cwd>/`, where
 * every character outside `[A-Za-z0-9-]` becomes `-`. Observed on Windows:
 * `D:\orchard` → `D--orchard`, `D:\my_app` → `D--my-app`,
 * `D:\orchard\.worktrees\w9` → `D--orchard--worktrees-w9`.
 */
export function claudeProjectDirName(cwd: string): string {
  return normalizePath(cwd).replace(/[^A-Za-z0-9-]/g, '-');
}

// ───────────────────────── Windows: how long a project's own path can be ─────────────────────────
//
// Files deep inside a project are no trouble: Node opens them at any length, and every git call is given
// `core.longpaths` (util/git.ts `LONG_PATHS`). The length of the project's own path is another matter, and no setting
// helps there, neither git's nor Windows' own for long paths. Both limits were measured (Git for Windows 2.53, pi
// 0.87.1, Windows 11 with long paths enabled).

/**
 * The longest path of a repository Git for Windows can open. Before it reads any setting it looks for
 * `<repository>\.git\objects`, which has to stay under 260 characters: one character more and it answers "not a git
 * repository"; from 259 on it cannot enter the directory at all.
 */
export const GIT_ROOT_MAX = 246;

/**
 * The longest path of a directory the Keeper can work in. pi keeps a job's session in a folder named after the working
 * directory, with two dashes before and after, and a folder's name is at most 255 characters. A few characters
 * further, at 259, Windows starts no process in the directory, so no shell command could run there either.
 */
export const KEEPER_CWD_MAX = 251;

/** What to say of a repository at `dir` that git cannot open because its path is too long; null when that is not the case. */
export function gitPathLimit(dir: string): string | null {
  const path = normalizePath(dir);
  if (!WIN || path.length <= GIT_ROOT_MAX || !existsSync(join(path, '.git'))) return null;
  return `This directory holds a git repository, but its path is ${path.length} characters long, and git on Windows cannot open a repository whose path is longer than ${GIT_ROOT_MAX} characters: its history, worktrees and ignore rules are not read. Move the project to a shorter path.`;
}

/** What to say of a directory the Keeper cannot work in because its path is too long; null when it can. */
export function keeperPathLimit(dir: string): string | null {
  const path = normalizePath(dir);
  if (!WIN || path.length <= KEEPER_CWD_MAX) return null;
  return `The Keeper cannot work in this project's directory: its path is ${path.length} characters long, and on Windows the Keeper can only work in a directory whose path is at most ${KEEPER_CWD_MAX} characters. Move the project to a shorter path.`;
}
