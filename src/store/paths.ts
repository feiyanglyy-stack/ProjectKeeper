import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonicalPath } from '../util/paths.ts';

/** ProjectKeeper's own home, in the file system's own spelling. Tests point `PROJECTKEEPER_HOME` at a temporary directory. */
export function projectKeeperHome(): string {
  const override = process.env.PROJECTKEEPER_HOME;
  return canonicalPath(override && override.trim() ? override : join(homedir(), '.projectkeeper'));
}

/**
 * The home, made if it is not there — for its owner alone (0700) on macOS and Linux, where a new directory is otherwise
 * open to every account of the machine: it holds the saved keys and what was read of the projects. A home that exists
 * is left as it is; its owner may have placed it and shared it on purpose. On Windows the profile's own access rules
 * cover it and the mode is not used.
 */
export function ensureHome(home: string): void {
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
}

export function workspaceFile(home = projectKeeperHome()): string {
  return join(home, 'workspace.json');
}

export function projectDir(projectId: string, home = projectKeeperHome()): string {
  return join(home, 'projects', projectId);
}
