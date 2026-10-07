/**
 * The workspace: which projects the owner added, plus settings that are not project assets
 * (port, chosen model). Lives at `~/.projectkeeper/workspace.json`.
 */
import type { RoundStepKind } from '../model/k-types.ts';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Project, ScopeItem, ScopeQuestion } from '../model/types.ts';
import { slug } from '../model/ids.ts';
import { canonicalPath, expandHome } from '../util/paths.ts';
import { writeJsonAtomic } from './json-file.ts';
import { ensureHome, projectKeeperHome, workspaceFile } from './paths.ts';

export interface ModelChoice {
  readonly provider: string;
  readonly id: string;
  readonly thinking: string | null;
}
/** Another key. It runs under a provider id of its own, so it has its own lanes and its own quota window; the key itself
 *  stays in the named environment variable and is read there when a request is sent. A key for a provider pi already
 *  knows names it in `like`; a key for a provider pi does not know (owner 2026-09-22: Xiaomi MiMo) brings its own
 *  endpoint, API and models instead. */
export interface ExtraKey {
  readonly provider: string;    // the id this key runs under, e.g. `zai-coding-cn-team`
  readonly like?: string;       // the provider whose endpoint and models it uses, e.g. `zai-coding-cn`
  readonly apiKeyEnv: string;   // the environment variable that holds the key
  readonly name?: string;
  readonly baseUrl?: string;    // with `api` and `models`: a provider of its own, e.g. `https://api.xiaomimimo.com/v1`
  readonly api?: string;        // pi's API family for it, e.g. `openai-completions`
  readonly models?: readonly ExtraKeyModel[];
}
/** One model of a provider an extra key brings itself; the fields are the ones pi's providers declare. */
export interface ExtraKeyModel {
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly input?: readonly ('text' | 'image')[];
  readonly cost?: { readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number };
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  readonly compat?: Readonly<Record<string, unknown>>;   // e.g. { thinkingFormat: 'deepseek', maxTokensField: 'max_tokens' }
}
export interface WorkspaceSettings {
  readonly port: number;
  readonly model: ModelChoice | null;
  readonly modelBackups: readonly ModelChoice[];   // used in order when the active provider reports its quota exhausted; the switch is visible, never silent
  readonly keeperAgent: 'pi';
  readonly organizingLanesPerKey?: number;         // automatic organizing jobs per key at once (the chosen model and each backup are keys); trial setting 2026-09-17
  readonly extraKeys?: readonly ExtraKey[];         // more keys for known providers (owner 2026-09-18: a third Zhipu Coding Plan key); name them in model or modelBackups to use them
  /** Automatic jobs at once on one key, set for that key (§6.10 每把 key 同时跑几路, D105); a key not listed runs `organizingLanesPerKey`. */
  readonly keyLanes?: Readonly<Record<string, number>>;
  readonly watchProjects?: boolean;                 // false for a controlled trial: the home works through what it holds and takes in no new changes, so runs started from one snapshot see the same input (owner 2026-09-18)
  // From the follow-up experiment's arm B (owner 2026-09-18); its other settings went once every round was one main job (D59).
  readonly routes?: Readonly<Record<string, string>>;   // job route or kind → model id on the same key's provider, e.g. { "frame": "glm-5.3", "relook": "glm-5.3" }
  /**
   * The model and thinking level of each step of a clerk-method round (Spec §3.3, CKC-03 AC-29, CKC-23 AC-11), on the
   * provider of the key a lane runs on. A step left out runs on the key's own model and thinking level. The baseline of
   * increment K runs every step on glm-5.3 at the highest thinking (D87, D90).
   */
  readonly steps?: Readonly<Partial<Record<RoundStepKind, { readonly model?: string; readonly thinking?: string }>>>;
}
interface WorkspaceFile {
  readonly version: 1;
  readonly projects: Project[];
  readonly settings: WorkspaceSettings;
  readonly lastProjectId: string | null;
}

const DEFAULT_SETTINGS: WorkspaceSettings = { port: 4870, model: null, modelBackups: [], keeperAgent: 'pi' };

/** The settings file is there and cannot be read as a workspace. The message names the file and says what to do. */
export class WorkspaceFileError extends Error {
  readonly file: string;
  constructor(file: string, what: string) {
    super(`Cannot read the settings file ${file}: ${what}. Correct it and start again, or move the file away to start with an empty workspace (the projects' assets under projects/ stay where they are). Nothing was changed.`);
    this.name = 'WorkspaceFileError';
    this.file = file;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read the settings file. Every key it lacks takes its default — `projects` an empty list, `settings` the defaults,
 * a project's lists empty — so a file written by hand or by an earlier version loads. What cannot be given a default
 * (text that is not JSON, a project without an id or without locations) is said, with the file's name, and the file is
 * left as it is: starting with an empty workspace instead would write that over the owner's projects on the next save.
 */
function readWorkspaceFile(file: string): WorkspaceFile {
  if (!existsSync(file)) return { version: 1, projects: [], settings: DEFAULT_SETTINGS, lastProjectId: null };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (error) { throw new WorkspaceFileError(file, `it is not valid JSON (${(error as Error).message})`); }
  if (!isRecord(raw)) throw new WorkspaceFileError(file, 'it does not hold a JSON object ({ "projects": […], "settings": {…} })');
  if (raw.projects !== undefined && !Array.isArray(raw.projects)) throw new WorkspaceFileError(file, '"projects" is not a list');
  if (raw.settings !== undefined && raw.settings !== null && !isRecord(raw.settings)) throw new WorkspaceFileError(file, '"settings" is not an object');
  const projects = ((raw.projects as unknown[] | undefined) ?? []).map((entry, index): Project => {
    const where = `project ${index + 1} of "projects"`;
    if (!isRecord(entry)) throw new WorkspaceFileError(file, `${where} is not an object`);
    if (typeof entry.id !== 'string' || !entry.id.trim()) throw new WorkspaceFileError(file, `${where} has no "id"`);
    if (!Array.isArray(entry.locations) || entry.locations.length === 0 || entry.locations.some((l) => typeof l !== 'string' || !l.trim())) {
      throw new WorkspaceFileError(file, `${where} (${entry.id}) has no "locations": a list with at least one directory`);
    }
    const list = (key: string): unknown[] => (Array.isArray(entry[key]) ? entry[key] as unknown[] : []);
    return {
      ...(entry as unknown as Project),
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : entry.id,
      // One spelling of each location, the file system's own: the one a project is added in (see `add`).
      locations: (entry.locations as string[]).map((l) => canonicalPath(l)),
      scope: list('scope') as ScopeItem[], scopeQuestions: list('scopeQuestions') as ScopeQuestion[],
      keeperFiles: list('keeperFiles') as Project['keeperFiles'], roles: list('roles') as string[],
      language: typeof entry.language === 'string' && entry.language ? entry.language : 'en',
      organizingPaused: entry.organizingPaused === true,
      createdAt: typeof entry.createdAt === 'string' && entry.createdAt ? entry.createdAt : statSync(file).mtime.toISOString(),
      lastOpenedAt: typeof entry.lastOpenedAt === 'string' ? entry.lastOpenedAt : null,
      lastScopedAt: typeof entry.lastScopedAt === 'string' ? entry.lastScopedAt : null,
    };
  });
  const settings = { ...DEFAULT_SETTINGS, ...((raw.settings as Partial<WorkspaceSettings> | null | undefined) ?? {}) };
  const lastProjectId = typeof raw.lastProjectId === 'string' && projects.some((p) => p.id === raw.lastProjectId) ? raw.lastProjectId : null;
  return { version: 1, projects, settings, lastProjectId };
}

export class Workspace extends EventEmitter {
  readonly home: string;
  private data: WorkspaceFile;

  private constructor(home: string, data: WorkspaceFile) {
    super();
    this.home = home;
    this.data = data;
  }

  /**
   * Open the workspace of a home. A settings file that is not there yet is an empty workspace. One that is there is
   * read as it is and never replaced because of what it holds: a key it lacks (a file written by hand, or by an earlier
   * version) takes its default, and a file that cannot be read as a workspace stops here with a message naming it.
   */
  static open(home = projectKeeperHome()): Workspace {
    const at = canonicalPath(home);
    return new Workspace(at, readWorkspaceFile(workspaceFile(at)));
  }

  get settings(): WorkspaceSettings { return this.data.settings; }
  get lastProjectId(): string | null { return this.data.lastProjectId; }

  list(): readonly Project[] { return this.data.projects; }

  get(id: string): Project | undefined { return this.data.projects.find((p) => p.id === id); }

  /** Project id: name slug plus a hash of the first location, stable across renames of the store. */
  static idFor(name: string, firstLocation: string): string {
    const hash = createHash('sha1').update(canonicalPath(firstLocation).toLowerCase()).digest('hex').slice(0, 6);
    return `${slug(name)}-${hash}`;
  }

  /**
   * Add a project. Its locations are kept in the file system's own spelling (`canonicalPath`), whichever way they were
   * given — a short (8.3) name, a junction, a `subst` drive, another case: that is the spelling git reports the
   * repository and its worktrees in, and every later comparison is made on it. A location typed with `~` is under
   * the home directory.
   */
  add(name: string, locations: readonly string[]): Project {
    const cleaned = [...new Set(locations.map((l) => canonicalPath(expandHome(l))))];
    if (cleaned.length === 0) throw new Error('A project needs at least one location');
    const id = Workspace.idFor(name, cleaned[0]!);
    if (this.get(id)) throw new Error(`Project already exists: ${id}`);
    const now = new Date().toISOString();
    const project: Project = {
      id, name: name.trim(), locations: cleaned, scope: [], scopeQuestions: [], keeperFiles: [], roles: [],
      language: 'en', organizingPaused: false, createdAt: now, lastOpenedAt: null, lastScopedAt: null,
    };
    this.data = { ...this.data, projects: [...this.data.projects, project], lastProjectId: id };
    this.save();
    this.emit('change', { kind: 'projects' });
    return project;
  }

  update(project: Project): Project {
    const index = this.data.projects.findIndex((p) => p.id === project.id);
    if (index < 0) throw new Error(`Unknown project: ${project.id}`);
    const projects = [...this.data.projects];
    projects[index] = project;
    this.data = { ...this.data, projects };
    this.save();
    this.emit('change', { kind: 'project', id: project.id });
    return project;
  }

  remove(id: string): void {
    this.data = { ...this.data, projects: this.data.projects.filter((p) => p.id !== id),
      lastProjectId: this.data.lastProjectId === id ? null : this.data.lastProjectId };
    this.save();
    this.emit('change', { kind: 'projects' });
  }

  setLastProject(id: string | null): void {
    if (this.data.lastProjectId === id) return;
    this.data = { ...this.data, lastProjectId: id };
    this.save();
  }

  setSettings(patch: Partial<WorkspaceSettings>): WorkspaceSettings {
    this.data = { ...this.data, settings: { ...this.data.settings, ...patch } };
    this.save();
    this.emit('change', { kind: 'settings' });
    return this.data.settings;
  }

  private save(): void {
    ensureHome(this.home);
    writeJsonAtomic(workspaceFile(this.home), this.data);
  }
}
