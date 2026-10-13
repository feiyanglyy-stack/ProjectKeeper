/**
 * A project opened for table work (`pk import`, `pk sessions`): the home opened with no organizing, the project found by
 * its folder or added and read in, and its ledger brought up to date — nothing the Keeper would start on its own runs.
 * One implementation for every table command, so taking the table in and exporting the session material for it see the
 * project the same way (D107).
 */
import { existsSync } from 'node:fs';
import type { App } from '../server/app.ts';
import type { Project } from '../model/types.ts';
import { projectKeeperHome, workspaceFile } from '../store/paths.ts';
import { canonicalPath, sameDirectory } from '../util/paths.ts';

export interface TableProjectOptions {
  /** The project folder, as the owner gave it. */
  readonly projectDir: string;
  /** The ProjectKeeper home; by default the user's (store/paths.ts). */
  readonly home?: string;
  /** The project's name when it is added. */
  readonly name: string;
}

export interface TableProject {
  readonly app: App;
  /** The project as it stands after intake and the ledger rebuild. */
  readonly project: Project;
  readonly home: string;
  /** The project was not in the home and was added. */
  readonly added: boolean;
  /** What did not go as it should and did not stop the work (the ledger left as it was). */
  readonly warnings: string[];
}

/**
 * Open the project for table work, hand it to `work`, and close the home whatever happens: watchers stopped, the
 * ledger's connections released, every store written. The App is loaded only when this is called, so a command that
 * refuses its input before calling it opens nothing.
 */
export async function withTableProject<T>(options: TableProjectOptions, work: (opened: TableProject) => Promise<T>): Promise<T> {
  const { App } = await import('../server/app.ts');
  const projectDir = canonicalPath(options.projectDir);
  const home = canonicalPath(options.home ?? projectKeeperHome());
  const made = !existsSync(workspaceFile(home));
  const app = new App(home, { organizing: false });
  const warnings: string[] = [];
  try {
    // A home made for the table works through what it holds, as the fixture's does: nothing watches the project.
    if (made) app.workspace.setSettings({ watchProjects: false });
    let project = app.workspace.list().find((x) => x.locations.some((l) => sameDirectory(l, projectDir)));
    const added = !project;
    if (!project) project = app.addProject(options.name, [projectDir]);
    // What intake reads is what the table's sources are matched against, the scope the boundary draws, and the session
    // sources the ledger reads the owner's words from.
    if (added || !project.lastScopedAt) await app.intakeProject(project.id);
    app.stopAll();
    try { app.ledger.rebuildNow(app.project(project.id)); } catch (e) { warnings.push(`The ledger was not brought up to date: ${(e as Error).message}`); }
    return await work({ app, project: app.project(project.id), home, added, warnings });
  } finally {
    app.stopAll();
    await app.flushAll();
  }
}
