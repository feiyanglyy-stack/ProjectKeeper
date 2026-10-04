import { homedir } from 'node:os';
import { join } from 'node:path';

/** ProjectKeeper's own home. Tests point `PROJECTKEEPER_HOME` at a temporary directory. */
export function projectKeeperHome(): string {
  const override = process.env.PROJECTKEEPER_HOME;
  return override && override.trim() ? override : join(homedir(), '.projectkeeper');
}

export function workspaceFile(home = projectKeeperHome()): string {
  return join(home, 'workspace.json');
}

export function projectDir(projectId: string, home = projectKeeperHome()): string {
  return join(home, 'projects', projectId);
}
