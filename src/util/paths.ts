import { homedir } from 'node:os';
import { isAbsolute, normalize, parse, relative, resolve, sep } from 'node:path';

const WIN = process.platform === 'win32';

/** Absolute, normalised, without a trailing separator. Display form keeps the original case. */
export function normalizePath(path: string): string {
  const abs = normalize(isAbsolute(path) ? path : resolve(path));
  const root = parse(abs).root;
  let out = abs;
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
}

/** Comparison key: case-folded on Windows. Never shown to the user. */
export function pathKey(path: string): string {
  const normalised = normalizePath(path);
  return WIN ? normalised.toLowerCase() : normalised;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
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
