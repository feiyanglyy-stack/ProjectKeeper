/**
 * Path canonicalisation and the allowed-root matcher for the read boundary (Spec §3.1; CKC-03
 * AC-23). A path is compared to the allowed roots only after junctions and symlinks are resolved,
 * so a link that sits at an allowed path but points outside is caught. Windows case, both
 * separators, `~`, and Git Bash / MSYS `/c/...` spellings are all recognised as the same path.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

const WIN = process.platform === 'win32';

/** Git Bash, MSYS, Cygwin and WSL drive paths → native Windows form: /c/x, /mnt/c/x, /cygdrive/c/x → C:\x. */
export function fromMsys(path: string): string {
  if (!WIN) return path;
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return path;
  const m = /^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(?:\/(.*))?$/.exec(path);
  if (!m) return path;
  return `${m[1]!.toUpperCase()}:\\${(m[2] ?? '').replaceAll('/', '\\')}`;
}

export function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || (WIN && path.startsWith('~\\'))) return resolve(homedir(), path.slice(2));
  return path;
}

/**
 * pi's file tools resolve a `path` argument through `resolvePath(path, cwd, { normalizeUnicodeSpaces: true,
 * stripAtPrefix: true })` before opening it. The boundary must resolve the same way, or a spelling pi accepts but the
 * boundary reads differently (a leading `@`, a unicode space) reads one file at the tool and checks another. This
 * mirrors pi's `utils/paths.ts` exactly: normalise unicode spaces, strip a leading `@`, convert a Git Bash / MSYS
 * drive path, expand `~` and `~/` (not `~user`, which pi leaves literal), then a `file://` URL. Not yet real-path'd.
 */
const UNICODE_SPACES = /[  -   　]/g;
export function toAbsolute(path: string, cwd: string): string {
  let s = path.replace(UNICODE_SPACES, ' ');
  if (s.startsWith('@')) s = s.slice(1);
  s = fromMsys(s);
  s = expandTilde(s);
  if (/^file:\/\//i.test(s)) {
    try { s = fileURLToPath(s); } catch { /* keep as-is */ }
  }
  return isAbsolute(s) ? resolve(s) : resolve(cwd, s);
}

/**
 * Resolve symlinks/junctions on the longest existing ancestor and re-join the missing tail, so a
 * path that does not exist yet (a file about to be written, or a read that will miss) still maps to
 * one canonical location instead of throwing.
 */
export function realExisting(absolute: string): string {
  const real = (p: string) => {
    try { return realpathSync.native(p); } catch { return realpathSync(p); }
  };
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const resolved = real(current);
      return tail.length ? resolve(resolved, tail.reverse().join(sep)) : resolved;
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;                // reached the root; nothing to resolve
      tail.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

/** Comparison key: absolute, real-path'd, case-folded on Windows. Never shown to the user. */
export function canonicalKey(path: string, cwd: string): string {
  const real = realExisting(toAbsolute(path, cwd));
  return WIN ? real.toLowerCase() : real;
}

/** What a candidate root is compared against to decide whether it is too broad to open. */
export interface BreadthContext {
  /** The user's home directory. */
  readonly home: string;
  /** The ProjectKeeper home in use (the directory above `projects/`). */
  readonly projectKeeperHome: string;
  /** The project's own locations. */
  readonly projectLocations: readonly string[];
}

/** `ancestor` strictly contains `descendant` (both canonical keys). */
function containsKey(ancestor: string, descendant: string): boolean {
  return descendant !== ancestor && descendant.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep);
}

/**
 * Why a candidate root that does not come from the project itself (a toolchain location, the folder of a skill pi
 * loaded) is too broad to become an allowed read root, or null when it is narrow enough. Compared on canonical keys, so
 * a junction or symlink that points at a broad directory is judged by what it opens. Refused: a filesystem root; the
 * home directory or anything containing it; the ProjectKeeper home, anything containing it, or anything inside it
 * (other projects' assets); anything containing one of the project's own locations.
 */
export function broadRootReason(path: string, ctx: BreadthContext): string | null {
  const key = canonicalKey(path, path);
  if (dirname(key) === key) return 'not used: too broad (a filesystem root)';
  const home = canonicalKey(ctx.home, ctx.home);
  if (key === home) return 'not used: too broad (the whole home directory)';
  if (containsKey(key, home)) return 'not used: too broad (it contains the home directory)';
  const pk = canonicalKey(ctx.projectKeeperHome, ctx.projectKeeperHome);
  if (key === pk) return 'not used: too broad (the whole ProjectKeeper home)';
  if (containsKey(key, pk)) return 'not used: too broad (it contains the ProjectKeeper home)';
  if (containsKey(pk, key)) return "not used: inside the ProjectKeeper home (other projects' assets)";
  for (const location of ctx.projectLocations) {
    if (containsKey(key, canonicalKey(location, location))) return 'not used: too broad (it contains the project directory)';
  }
  return null;
}

export interface AllowedRoot {
  readonly path: string;
  /** Short label for the refusal message ("the project directory", "the toolchain the build config points at"). */
  readonly label: string;
}

export interface BoundaryDecision {
  readonly ok: boolean;
  readonly reason: string | null;
}

export interface Boundary {
  /** Whether reading `path` (resolved against `cwd`) is inside the boundary. */
  decide(path: string, cwd: string): BoundaryDecision;
  /** One-line description of what is allowed, for refusal messages and reports. */
  describe(): string;
}

export interface BoundaryInput {
  readonly roots: readonly AllowedRoot[];
  /** Individual files that are allowed even though their directory is not a root (session logs, single resources). */
  readonly files: readonly string[];
  /** Given a canonical key, a non-null string means "refuse and say this" (credential stores). */
  readonly denyFile?: (canonical: string) => string | null;
}

const HOW_TO_STAY_IN_BOUNDS =
  'Read only this project: its own scope, its ProjectKeeper assets, the toolchain its config points at, and the session files that belong to it. '
  + 'To find which of your own records cite a source or an id, use pk_find_references / pk_read_assets — do not look in the file system. '
  + 'Do not read other projects, other ProjectKeeper assets (including the one the owner is using), or credential stores.';

export function makeBoundary(input: BoundaryInput): Boundary {
  const rootKeys = input.roots.map((r) => ({ key: canonicalKey(r.path, r.path), label: r.label }));
  const fileKeys = new Set(input.files.map((f) => canonicalKey(f, f)));
  const within = (key: string, root: string) => key === root || key.startsWith(root.endsWith(sep) ? root : root + sep);
  return {
    decide(path, cwd) {
      const key = canonicalKey(path, cwd);
      const denied = input.denyFile?.(key);
      if (denied) return { ok: false, reason: denied };
      if (fileKeys.has(key)) return { ok: true, reason: null };
      if (rootKeys.some((r) => within(key, r.key))) return { ok: true, reason: null };
      return { ok: false, reason: `Out of the project's read boundary: ${path}. ${HOW_TO_STAY_IN_BOUNDS}` };
    },
    describe() {
      return input.roots.map((r) => `${r.label} (${r.path})`).join('; ');
    },
  };
}
