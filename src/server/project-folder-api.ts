/**
 * Owner-facing grant for the Project folder standing authorization (CKC-26 AC-7–AC-10), and its state as the Keeper page
 * shows it. The owner gives it on that page (`Authorize…`) and withdraws it there (`Withdraw`, the revoke route of
 * every standing authorization).
 */
import { existsSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { canonicalPath } from '../util/paths.ts';
import type { App } from './app.ts';
import { HttpApp, HttpError, requireString } from './http.ts';
import { grantProjectFolderAuthorization, projectFolderPath, syncProjectFolder, type ProjectFolderAuthorizationInput } from '../keeper/project-folder.ts';

export function registerProjectFolderRoutes(http: HttpApp, app: App): void {
  http.route('POST', '/api/projects/:id/authorizations/project-folder', ({ params, body }) => {
    const project = app.project(params.id!);
    const input = (body ?? {}) as Record<string, unknown>;
    const quote = requireString(input.quote, 'quote');
    if (input.path !== undefined && (typeof input.path !== 'string' || !input.path.trim())) throw new HttpError(400, 'path must be a nonempty string');
    if (input.commits !== undefined && typeof input.commits !== 'boolean') throw new HttpError(400, 'commits must be a boolean');
    if (input.sourceId !== undefined && (typeof input.sourceId !== 'string' || !input.sourceId.trim())) throw new HttpError(400, 'sourceId must be a nonempty string');
    const path = input.path as string | undefined;
    const sourceId = input.sourceId as string | undefined;
    try {
      return grantProjectFolder(app, project.id, { path, commits: input.commits as boolean | undefined, quote, sourceId });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('An active Project folder')) throw new HttpError(409, message);
      if (/Invalid project folder|must be inside|must not be hidden|Unsafe project folder|escapes through|chosen folder already contains|folder contains files outside|Invalid owner source/.test(message)) throw new HttpError(400, message);
      throw error;
    }
  });
}

/**
 * The owner's grant of the project folder (Spec §1.14; CKC-26 AC-7, AC-8): record it, write the folder, and keep the
 * folder out of what is read as the project's material. It is ProjectKeeper's output, written from the assets, so the
 * Keeper never reads its own folder back as a project document; the scope item says so, and the owner can see it.
 */
export function grantProjectFolder(app: App, projectId: string, input: ProjectFolderAuthorizationInput) {
  const project = app.project(projectId);
  const store = app.store(project.id);
  projectFolderPath(project, input.path);
  const authorization = grantProjectFolderAuthorization(store, project, input);
  // Excluded before anything is written (QC AW-2): a first write that fails part way must not leave the folder to be read
  // back as project material once a later write succeeds.
  excludeProjectFolder(app, project.id, authorization.projectFolder!.path, authorization.id);
  const sync = syncProjectFolder(store, project);
  return { authorization: store.authorizations.get(authorization.id), sync };
}

/** What the authorization allows, in one sentence: fixed interface text, shown beside the control on the Keeper page. */
export const PROJECT_FOLDER_ALLOWS = 'With this authorization the Keeper maintains one folder of its own inside the project — projectkeeper/, unless you name another — and makes commits that contain only that folder; it never pushes, and it changes no other file of the project.';

/** The folder a grant uses when the owner names no other, relative to the project root. */
export const PROJECT_FOLDER_USUAL = 'projectkeeper';

/** The project-folder authorization as the Keeper page shows it: what it allows, whether it stands, and what it did. */
export interface ProjectFolderState {
  readonly allows: string;
  readonly granted: boolean;
  /** The authorization in force; `Withdraw` revokes this one. */
  readonly authorizationId: string | null;
  /** The folder in force; without a grant, the folder of the last grant that was withdrawn, if any. */
  readonly path: string | null;
  /** The folder name a new grant starts from, relative to the project root: the last grant's folder, else `projectkeeper`. */
  readonly usual: string;
  readonly commits: boolean;
  readonly grantedAt: string | null;
  readonly lastWrite: { readonly at: string; readonly commit: string | null } | null;
  /** When the last grant was withdrawn; null while one stands or when none was ever given. */
  readonly withdrawnAt: string | null;
  /** Whether `path` is in the project now: a withdrawal leaves the folder where it is. */
  readonly exists: boolean;
}

export function projectFolderState(app: App, projectId: string): ProjectFolderState {
  const all = app.store(projectId).authorizations.filter((a) => a.projectFolder != null).sort((a, b) => a.at.localeCompare(b.at));
  const active = all.filter((a) => !a.revokedAt).at(-1) ?? null;
  const last = active ?? all.at(-1) ?? null;
  const path = last?.projectFolder?.path ?? null;
  return {
    allows: PROJECT_FOLDER_ALLOWS, granted: active !== null, authorizationId: active?.id ?? null, path, usual: relativeToRoot(app.project(projectId).locations[0], path) ?? PROJECT_FOLDER_USUAL,
    commits: last?.projectFolder?.commits ?? true, grantedAt: active?.at ?? null, lastWrite: last?.projectFolder?.lastWrite ?? null,
    withdrawnAt: active ? null : last?.revokedAt ?? null, exists: path !== null && existsSync(path),
  };
}

/** A folder inside the project as the owner names it: relative to the project's root, with forward slashes. */
function relativeToRoot(location: string | undefined, path: string | null): string | null {
  if (!location || !path) return null;
  try {
    const rel = relative(canonicalPath(location), path);
    return rel && !isAbsolute(rel) && rel.split(sep)[0] !== '..' ? rel.split(sep).join('/') : null;
  } catch { return null; }
}

/** The project folder as a scope item: Excluded, with the authorization it belongs to as its reason. */
export function excludeProjectFolder(app: App, projectId: string, path: string, authorizationId: string): void {
  app.addScopeItem(projectId, {
    path, category: 'Directory', relation: 'Excluded',
    reason: `ProjectKeeper's project folder (${authorizationId}): written from the assets under the owner's authorization, not read as the project's material`,
  });
}
