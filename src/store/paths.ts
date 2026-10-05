import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonicalPath } from '../util/paths.ts';

/** ProjectKeeper's own home, in the file system's own spelling. Tests point `PROJECTKEEPER_HOME` at a temporary directory. */
export function projectKeeperHome(): string {
  const override = process.env.PROJECTKEEPER_HOME;
  return canonicalPath(override && override.trim() ? override : join(homedir(), '.projectkeeper'));
}

export function workspaceFile(home = projectKeeperHome()): string {
  return join(home, 'workspace.json');
}

export function projectDir(projectId: string, home = projectKeeperHome()): string {
  return join(home, 'projects', projectId);
}
