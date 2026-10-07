/**
 * The read boundary and shell write guard as pi sees them (Spec §3.1, §8.1; CKC-03 AC-23;
 * CKC-26 AC-8; DECISIONS E69). The
 * Keeper keeps every built-in tool — read, write, edit, shell, grep, find, ls — with nothing
 * removed. The boundary governs *where a read can reach*, not *which tools exist*:
 *
 *  - read / grep / find / ls, and edit (which returns file content in its diff), are gated by an
 *    inline extension's `tool_call` handler: a path outside the allowed roots is refused before the
 *    tool runs, and the refusal is recorded as a step in the Keeper view (like AC-16). read / edit /
 *    grep / ls are ALSO re-provided through pi's own definition with boundary-enforcing Operations
 *    (`guardedFileTool`): a second layer that checks the path pi has already resolved, independent of
 *    the gate's argument parsing and of the resolver copy in paths.ts. (find's fd backend does not
 *    hand its Operations the resolved path, so find stays gated only.)
 *  - shell (bash / powershell) is parsed before it runs, then the reachable Git repositories or
 *    ordinary directories are journaled and restored on a detected write (command.ts and
 *    shell-write-guard.ts): on a live project (a home that watches its projects) only what the
 *    command names as its writes, the rest left and noted on the step; on a controlled trial every
 *    change; Git's own state never (BQ). Its spawn hook
 *    also strips credential variables (PA-10) and sets a private job scratch directory.
 *  - the file tools retain their existing policy; this module's write guard applies to shell calls.
 *
 * Allowed roots: the project's own scope items, this project's ProjectKeeper assets, the toolchain
 * its config points at, the global skills / extensions / prompt templates pi loaded (but not their
 * login or credential files), and — file by file — the session logs that belong to this project.
 * A root that does not come from the project itself (a toolchain location, a skill's folder) is not
 * used when it is too broad — a filesystem root, the home directory or anything containing it, the
 * ProjectKeeper home or anything containing it or inside it, or anything containing the project —
 * and is returned as refused instead, so it can be shown and corrected (paths.ts `broadRootReason`).
 */
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync } from 'node:fs';
import { access as fsAccess, readFile as fsReadFile, readdir as fsReaddir, stat as fsStat, writeFile as fsWriteFile } from 'node:fs/promises';
import {
  createBashToolDefinition, createPowerShellToolDefinition,
  createReadToolDefinition, createEditToolDefinition, createGrepToolDefinition, createLsToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  type DefaultResourceLoader, type InlineExtension, type SettingsManager, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Project } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { toolchainRoots } from '../../scope/toolchain.ts';
import { broadRootReason, canonicalKey, makeBoundary, type AllowedRoot, type BreadthContext, type Boundary } from './paths.ts';
import { planShellCommand } from './command.ts';
import { LEFT_NOTE, ShellProjectSnapshot, shellProjectRoots, withShellWriteLock } from './shell-write-guard.ts';

/** Environment-variable names whose value is a secret and must not reach a tool subprocess (PA-10). */
export function isCredentialEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper === 'PWD' || upper === 'PATH' || upper === 'OLDPWD') return false;   // working-directory vars, not secrets
  return /(?:^|_)(?:KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|CREDENTIALS|AUTH)(?:$|_)/.test(upper)
    || /(?:ACCESS|PRIVATE|SECRET)[_-]?KEY/.test(upper)
    || upper.endsWith('_KEY') || upper.endsWith('_TOKEN') || upper.endsWith('_SECRET');
}

/**
 * Git takes settings from the environment as one group: `GIT_CONFIG_COUNT`, then a name and a value for each setting
 * (`GIT_CONFIG_KEY_0`, `GIT_CONFIG_VALUE_0`, …). The group is read whole or not at all — with the count left and a
 * name gone, every git command stops with "missing config key" — and the secret, when there is one, is in a value,
 * whose variable name says nothing. So the group is filtered by what each setting is, not by the variables' names.
 */
const GIT_CONFIG_GROUP = /^GIT_CONFIG_(?:COUNT|(?:KEY|VALUE)_\d+)$/;
/**
 * The sections of git's configuration that pass to a tool subprocess: who commits, which directories git trusts, and
 * how a repository on this machine is read and shown. A secret sits where git reaches a remote (an `http.….extraheader`,
 * a `credential.*` helper, a `url.….insteadOf` with a token in it), and none of these sections does that. A setting
 * passes because its section is listed, never because it does not look like a secret.
 */
const LOCAL_GIT_SECTIONS = new Set(['user', 'author', 'committer', 'safe', 'core', 'init', 'i18n', 'color', 'diff', 'log', 'status', 'advice', 'gc', 'feature', 'index', 'pack']);
/** The `core` settings that are commands for reaching, or signing in to, a remote. */
const REMOTE_CORE_SETTINGS = new Set(['askpass', 'sshcommand', 'gitproxy']);

/** Whether a git setting named `key` (`section.name` or `section.subsection.name`) passes to a tool subprocess. */
export function isLocalGitSetting(key: string): boolean {
  const first = key.indexOf('.');
  if (first <= 0) return false;
  const section = key.slice(0, first).toLowerCase();
  const name = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return LOCAL_GIT_SECTIONS.has(section) && !(section === 'core' && REMOTE_CORE_SETTINGS.has(name));
}

/**
 * Remove credential-named variables from an environment map (used by the shell spawn hook). Git's settings group is
 * rebuilt from the settings that pass, numbered from 0 again in their order, so git reads the rest as before.
 * `GIT_CONFIG_PARAMETERS`, where git hands the `-c` settings of one command to its children, is not passed on.
 */
export function stripCredentialEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const group = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) {
    const upper = k.toUpperCase();
    if (GIT_CONFIG_GROUP.test(upper)) { if (v !== undefined) group.set(upper, v); continue; }
    if (upper === 'GIT_CONFIG_PARAMETERS') continue;
    if (!isCredentialEnvName(k)) out[k] = v;
  }
  // Git reads the settings 0 … count-1 and stops at the first one that lacks its name or its value; so does this.
  const count = /^\d+$/.test(group.get('GIT_CONFIG_COUNT') ?? '') ? Number(group.get('GIT_CONFIG_COUNT')) : 0;
  let kept = 0;
  for (let i = 0; i < count; i += 1) {
    const key = group.get(`GIT_CONFIG_KEY_${i}`);
    const value = group.get(`GIT_CONFIG_VALUE_${i}`);
    if (key === undefined || value === undefined) break;
    if (!isLocalGitSetting(key)) continue;
    out[`GIT_CONFIG_KEY_${kept}`] = key;
    out[`GIT_CONFIG_VALUE_${kept}`] = value;
    kept += 1;
  }
  if (kept > 0) out.GIT_CONFIG_COUNT = String(kept);
  return out;
}

/**
 * Variables that are no secret themselves but lead to a login stored on this machine, so they do not reach the shell:
 *  - the programs git, ssh and sudo call to be given a password (`GIT_ASKPASS`, `SSH_ASKPASS` with `SSH_ASKPASS_REQUIRE`,
 *    `SUDO_ASKPASS`). An editor's terminal sets the first two to a helper of its own that answers from the editor's
 *    sign-in, over the channel the `VSCODE_GIT_*` variables name (VS Code and the editors built on it, on every system);
 *  - git's trace switches (`GIT_TRACE*`, `GIT_CURL_VERBOSE`) and the credential manager's (`GCM_TRACE*`), which print
 *    what is sent to a remote: with `GIT_TRACE_REDACT=0`, the authorization header as it is.
 */
const LOGIN_ROUTE_ENV = /^(?:GIT_ASKPASS|SSH_ASKPASS|SSH_ASKPASS_REQUIRE|SUDO_ASKPASS|VSCODE_GIT_\w*|GIT_TRACE\w*|GIT_CURL_VERBOSE|GCM_TRACE\w*)$/;

/**
 * The environment a shell command runs in: without the credentials and without the routes to a stored login, and with
 * three git settings of its own after the ones that were given, where they hold whatever any configuration says:
 *  - `credential.helper` empty, which makes git forget every helper configured before it; with nobody to ask
 *    (`GIT_TERMINAL_PROMPT=0`, no askpass program) git in the shell has no login to use or to print, and says so at
 *    once. command.ts refuses `git credential` when it is typed; this holds for git reached any other way;
 *  - `core.longpaths`, the last. The program's own git calls are given it on the command line (util/git.ts
 *    `LONG_PATHS`); git typed into the shell needs it as much — in a repository at a deep path, or with files deep
 *    inside it, `git status` and `git log` stop with "Filename too long" otherwise.
 * And git is kept from writing the index to refresh it, which changes the repository's state and takes its lock from
 * whoever is working in it: `GIT_OPTIONAL_LOCKS=0` for `git status`, as the program's own git calls have it, and the
 * setting `diff.autoRefreshIndex=false` for `git diff`, which does not ask about optional locks.
 */
export function shellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(stripCredentialEnv(env))) if (!LOGIN_ROUTE_ENV.test(k.toUpperCase()) && !['GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS'].includes(k.toUpperCase())) out[k] = v;
  const count = Number(out.GIT_CONFIG_COUNT ?? 0);
  return {
    ...out, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_COUNT: String(count + 3),
    [`GIT_CONFIG_KEY_${count}`]: 'credential.helper', [`GIT_CONFIG_VALUE_${count}`]: '',
    [`GIT_CONFIG_KEY_${count + 1}`]: 'diff.autoRefreshIndex', [`GIT_CONFIG_VALUE_${count + 1}`]: 'false',
    [`GIT_CONFIG_KEY_${count + 2}`]: 'core.longpaths', [`GIT_CONFIG_VALUE_${count + 2}`]: 'true',
  };
}

/** A credential store must never be read even when it sits inside an allowed root (CKC-03 AC-3, §3.1). */
function credentialFileDeny(agentDirKey: string): (canonical: string) => string | null {
  const PRIVATE_KEY = /^(\.netrc|_netrc|id_(rsa|dsa|ecdsa|ed25519))$|\.(pem|ppk|pfx|p12)$/i;
  const CREDENTIAL_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg']);
  return (canonical) => {
    const base = basename(canonical);
    // pi's own login/model store under the agent dir stays out of bounds, though its skills and extensions are read.
    if ((base === 'auth.json' || base === 'models.json') && canonical.startsWith(agentDirKey)) {
      return `Refused: ${base} is a login/credential store and is never read (only that a credential is present is noted).`;
    }
    if (PRIVATE_KEY.test(base)) return `Refused: ${base} is a credential store and is never read.`;
    if (canonical.split(/[\\/]/).some((s) => CREDENTIAL_SEGMENTS.has(s))) return 'Refused: a credential store (.ssh / .aws / .gnupg) is never read.';
    return null;
  };
}

export interface ReadBoundaryDeps {
  readonly project: Project;
  readonly store: ProjectStore;
  readonly agentDir: string;
  readonly settingsManager: SettingsManager;
  /** The resource loader, resolved lazily: it is created with this boundary's extension, so it does
   *  not exist yet when the boundary is built, and its resources are read only on the first tool call. */
  readonly resolveLoader: () => DefaultResourceLoader | null;
  /** Called once per refused read/command, so a job can record how many boundary refusals it hit. */
  readonly onDeny?: () => void;
  /** The user's home directory (default: the real one); tests pass a temp directory. */
  readonly home?: string;
  /** The ProjectKeeper home in use (default: the directory above `store.dir`'s `projects/`). */
  readonly projectKeeperHome?: string;
  /** The active job; a live pi session can serve a later job, which gets a different scratch directory. */
  readonly jobId?: string;
  /**
   * Whether this home watches its projects (settings.watchProjects), asked at each shell command. A home that does is a
   * live project: the owner and agents write there while a command runs, so the shell guard undoes only what the command
   * names as its writes and leaves the rest. Not given: a controlled trial, where nobody else writes (BQ).
   */
  readonly watchesProjects?: () => boolean;
}

/** A candidate root that was not used because it is too broad, kept so it can be shown and corrected. */
export interface RefusedRoot {
  readonly path: string;
  readonly from: 'toolchain' | 'skill';
  readonly reason: string;
}

/**
 * Gather the allowed roots and allowed individual files from the project, its assets, toolchain and loaded resources.
 * Roots that do not come from the project itself — the toolchain and the folders of the skills pi loaded — are checked
 * for breadth first; a refused one is returned in `refused` instead of becoming a root.
 */
export function allowedRoots(deps: ReadBoundaryDeps): { roots: AllowedRoot[]; files: string[]; refused: RefusedRoot[] } {
  const { project, store } = deps;
  const loader = deps.resolveLoader();
  const roots: AllowedRoot[] = [];
  const files: string[] = [];
  const refused: RefusedRoot[] = [];
  const breadth: BreadthContext = {
    home: deps.home ?? homedir(),
    projectKeeperHome: deps.projectKeeperHome ?? dirname(dirname(store.dir)),   // store.dir === <home>/projects/<projectId>
    projectLocations: project.locations,
  };

  // Project scope: every item except the ones outside the project and the whole session directory.
  for (const item of project.scope) {
    if (item.relation === 'Excluded' || item.category === 'Session source' || item.missing) continue;
    roots.push({ path: item.path, label: `${item.relation} (${item.category})` });
  }
  // Also the project's own given locations, in case scope discovery has not run yet.
  for (const loc of project.locations) roots.push({ path: loc, label: 'the project directory' });
  // This project's own ProjectKeeper assets (store.dir === <home>/projects/<projectId>).
  roots.push({ path: store.dir, label: "this project's ProjectKeeper assets" });
  // The toolchain the project's own config points at (§6.7). Re-checked here, whatever the stored flag says.
  for (const t of toolchainRoots(project, { home: breadth.home, projectKeeperHome: breadth.projectKeeperHome })) {
    const reason = broadRootReason(t.path, breadth) ?? (t.used === false ? (t.notUsedReason ?? 'not used') : null);
    if (reason) refused.push({ path: t.path, from: 'toolchain', reason });
    else roots.push({ path: t.path, label: 'toolchain the build config points at' });
  }

  // Global resources pi loaded (skills, extensions, prompt templates, context files) — not their credential files.
  try {
    if (loader) {
      for (const s of loader.getSkills().skills as { filePath?: string; baseDir?: string }[]) {
        if (!s.filePath) continue;
        const dir = s.baseDir ?? dirname(s.filePath);       // pi resolves a skill's relative references against this folder
        const reason = broadRootReason(dir, breadth);
        if (reason) { refused.push({ path: dir, from: 'skill', reason }); files.push(s.filePath); }   // the skill file itself stays readable
        else roots.push({ path: dir, label: 'a skill pi loaded' });
      }
      const ext = loader.getExtensions();
      for (const e of ext.extensions as { path: string; resolvedPath?: string }[]) files.push(e.resolvedPath ?? e.path);
      for (const p of loader.getPrompts().prompts as { filePath?: string }[]) if (p.filePath) files.push(p.filePath);
      for (const f of loader.getAgentsFiles().agentsFiles as { path: string }[]) files.push(f.path);
      const sys = loader.getSystemPromptSource();
      if (sys?.path) files.push(sys.path);
      for (const a of loader.getAppendSystemPromptSources() as { path: string }[]) files.push(a.path);
    }
  } catch { /* resources not loaded: the project scope and assets still bound the reads */ }

  // Session logs that belong to this project — file by file, never the whole session directory (§3.1).
  for (const src of store.sources.all()) if (src.anchor.kind === 'session') files.push(src.anchor.file);

  return { roots, files, refused };
}

export interface ReadBoundary {
  /** Inline extension that gates read/grep/find/ls/edit and bash/powershell before they run. */
  readonly extension: InlineExtension;
  /** Re-provided built-in tools: bash/powershell (credential-stripped) and read/edit/grep/ls (boundary-enforced). */
  readonly tools: ToolDefinition[];
  /** The boundary, exposed for tests and reporting (built lazily on first use). */
  readonly boundary: Boundary;
  readonly scratchDir: string;
  setJobId(jobId: string, project?: Project, onDeny?: () => void): void;
}

/** The file tools whose Operations receive the path pi has already resolved, so the boundary can be enforced there. */
export const GUARDABLE_FILE_TOOLS = ['read', 'edit', 'grep', 'ls'] as const;
export type GuardableFileTool = (typeof GUARDABLE_FILE_TOOLS)[number];

/**
 * A file tool re-provided through pi's own `create*ToolDefinition`, with Operations that check the boundary on the
 * path pi has already resolved and then delegate to pi's default local behaviour (CKC-03 AC-23). This is a second
 * layer under the gate: it does not depend on the gate's argument parsing, nor on the resolver copy in paths.ts —
 * it sees exactly the absolute path the tool is about to open. `find` is not here: its default backend (fd) never
 * hands its Operations the resolved search path, so `find` stays gated only. Nothing about the tool but its file
 * access changes, so the offered tool and its schema are pi's (AC-4).
 */
export function guardedFileTool(name: GuardableFileTool, cwd: string, boundary: Boundary, onDeny?: () => void): ToolDefinition {
  const guard = (absolutePath: string): void => {
    const d = boundary.decide(absolutePath, absolutePath);   // pi has already resolved it; cwd is irrelevant for an absolute path
    if (!d.ok) { onDeny?.(); throw new Error(d.reason ?? `Out of the project's read boundary: ${absolutePath}`); }
  };
  switch (name) {
    case 'read':
      return createReadToolDefinition(cwd, { operations: {
        readFile: (p) => { guard(p); return fsReadFile(p); },
        access: (p) => { guard(p); return fsAccess(p, constants.R_OK); },
        detectImageMimeType: detectSupportedImageMimeTypeFromFile,
      } }) as unknown as ToolDefinition;
    case 'edit':
      return createEditToolDefinition(cwd, { operations: {
        readFile: (p) => { guard(p); return fsReadFile(p); },
        writeFile: (p, content) => { guard(p); return fsWriteFile(p, content, 'utf-8'); },
        access: (p) => { guard(p); return fsAccess(p, constants.R_OK | constants.W_OK); },
      } }) as unknown as ToolDefinition;
    case 'grep':
      return createGrepToolDefinition(cwd, { operations: {
        isDirectory: async (p) => { guard(p); return (await fsStat(p)).isDirectory(); },
        readFile: (p) => { guard(p); return fsReadFile(p, 'utf-8'); },
      } }) as unknown as ToolDefinition;
    case 'ls':
      return createLsToolDefinition(cwd, { operations: {
        exists: (p) => { guard(p); return fsAccess(p, constants.F_OK).then(() => true, () => false); },
        stat: (p) => { guard(p); return fsStat(p); },
        readdir: (p) => { guard(p); return fsReaddir(p); },
      } }) as unknown as ToolDefinition;
  }
}

interface PiExtensionApi {
  on(event: 'tool_call', handler: (event: ToolCallLike) => { block?: boolean; reason?: string } | undefined): void;
}
interface ToolCallLike {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

/** Tools whose path argument is a read (edit is included: its diff returns file content — Spec §3.1). */
const PATH_ARG_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'edit']);

/**
 * A path as a message names it: from its project root on when it is inside one of `roots` (canonical keys, like the
 * paths) — with the root's own name in front when the project has several — and whole otherwise. A step's record keeps
 * only the start of a result, so a path given from the drive on names the directories above the project and loses the
 * file where the project sits deep.
 */
export function shortPath(path: string, roots: readonly string[]): string {
  const root = roots.filter((r) => path === r || path.startsWith(r.endsWith(sep) ? r : r + sep)).sort((a, b) => b.length - a.length)[0];
  if (root === undefined) return path;
  const rel = path.slice(root.length).split(sep).filter(Boolean).join('/') || '.';
  return roots.length > 1 ? `${basename(root)}/${rel}` : rel;
}
/** Up to eight paths, then how many more. */
const listPaths = (paths: readonly string[], roots: readonly string[]): string => `${paths.slice(0, 8).map((p) => shortPath(p, roots)).join(', ')}${paths.length > 8 ? ` (+${paths.length - 8} more)` : ''}`;

type ToolResult = Awaited<ReturnType<ToolDefinition['execute']>>;
/** A shell result with `note` put first in its text: the step's record keeps the start of the result (BQ). */
function noteFirst(result: ToolResult, note: string): ToolResult {
  const content = [...(result.content ?? [])];
  const at = content.findIndex((part) => part.type === 'text');
  if (at < 0) content.unshift({ type: 'text', text: note });
  else { const part = content[at] as { type: 'text'; text: string }; content[at] = { ...part, text: `${note}\n\n${part.text}` }; }
  return { ...result, content };
}

export function createReadBoundary(deps: ReadBoundaryDeps): ReadBoundary {
  const cwd = deps.project.locations[0]!;
  const agentDirKey = canonicalKey(deps.agentDir, deps.agentDir);
  let activeProject = deps.project;
  let projectRoots = shellProjectRoots(activeProject);
  let excludedRoots = activeProject.scope.filter((item) => item.relation === 'Excluded' && !item.missing).map((item) => item.path);
  const keeperHome = dirname(dirname(deps.store.dir));
  const guardHome = join(keeperHome, 'shell-guards');
  const projectScratchKey = createHash('sha256').update(deps.project.id).digest('hex').slice(0, 24);
  const scratchFor = (jobId: string) => join(keeperHome, 'scratch', projectScratchKey, createHash('sha256').update(jobId).digest('hex').slice(0, 24));
  const ensureScratchOutsideProject = (path: string) => {
    const key = canonicalKey(path, path);
    if (projectRoots.some((root) => key === root || key.startsWith(root.endsWith(sep) ? root : root + sep))) {
      throw new Error('Keeper scratch directory is inside the project; refusing to run shell tools');
    }
  };
  let currentJobId = deps.jobId ?? randomUUID();
  let scratchDir = scratchFor(currentJobId);
  ensureScratchOutsideProject(scratchDir);
  mkdirSync(scratchDir, { recursive: true });
  let onDeny = deps.onDeny;
  let spawningScratch: string | null = null;
  const outputPaths = new Map<string, string>();
  let boundary: Boundary | null = null;
  const denyCredentialFile = credentialFileDeny(agentDirKey);
  const get = (): Boundary => {
    if (!boundary) {
      const { roots, files } = allowedRoots({ ...deps, project: activeProject });
      const excludedKeys = excludedRoots.map((path) => canonicalKey(path, path));
      boundary = makeBoundary({
        roots: [...roots, { path: scratchDir, label: "this job's scratch directory" }], files,
        denyFile: (key) => excludedKeys.some((root) => key === root || key.startsWith(root.endsWith(sep) ? root : root + sep))
          ? 'Refused: this Excluded project location is outside Keeper\'s read boundary.' : denyCredentialFile(key),
      });
    }
    return boundary;
  };

  const rememberPiOutput = (shell: 'bash' | 'powershell', path: unknown, jobId: string): void => {
    if (typeof path !== 'string') return;
    if (!new RegExp(`^pi-${shell}-[0-9a-f]{16}\\.log$`).test(basename(path))) return;
    if (canonicalKey(dirname(path), dirname(path)) !== canonicalKey(tmpdir(), tmpdir())) return;
    try { if (lstatSync(path).isFile()) outputPaths.set(jobId, path); } catch { /* no completed output file */ }
  };
  const bounded: Boundary = {
    decide: (path, from) => {
      const latestOutputPath = outputPaths.get(currentJobId);
      if (latestOutputPath && canonicalKey(path, from) === canonicalKey(latestOutputPath, latestOutputPath)) {
        try { if (lstatSync(latestOutputPath).isFile()) return { ok: true, reason: null }; } catch { /* fall through */ }
      }
      return get().decide(path, from);
    },
    describe: () => get().describe(),
  };

  const factory = (pi: PiExtensionApi) => {
    pi.on('tool_call', (event) => {
      const b = bounded;
      if (PATH_ARG_TOOLS.has(event.toolName)) {
        const path = typeof event.input.path === 'string' ? event.input.path : null;
        if (!path) return undefined;                          // grep/find/ls default to the cwd, which is in bounds
        const d = b.decide(path, cwd);
        if (!d.ok) { onDeny?.(); return { block: true, reason: d.reason ?? 'out of the read boundary' }; }
        return undefined;
      }
      if (event.toolName === 'bash' || event.toolName === 'powershell') {
        const command = typeof event.input.command === 'string' ? event.input.command : '';
        if (!command) return undefined;
        const d = planShellCommand(event.toolName, command, cwd, b, projectRoots, scratchDir, excludedRoots).decision;
        if (!d.ok) { onDeny?.(); return { block: true, reason: d.reason ?? 'out of the read boundary' }; }
        return undefined;
      }
      return undefined;
    });
  };

  // Re-provide the built-in tools pi already has active: bash/powershell with a spawn hook and scoped journal,
  // and read/edit/grep/ls with boundary-enforcing Operations. Only tools in pi's default-active set are
  // re-provided, and each keeps pi's own definition, so the offered tool set and schema are unchanged (CKC-03 AC-4).
  const activeBuiltins = new Set(deps.settingsManager.getDefaultTools() ?? ['read', 'bash', 'edit', 'write']);
  const spawnHook = (ctx: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({
    ...ctx, env: { ...shellEnv(ctx.env), TMPDIR: spawningScratch ?? scratchDir, TEMP: spawningScratch ?? scratchDir, TMP: spawningScratch ?? scratchDir },
  });
  const protectShell = (shell: 'bash' | 'powershell', base: ToolDefinition): ToolDefinition => ({
    ...base,
    description: `${base.description} Write temporary files under $TMPDIR (also available as $TEMP and $TMP), a private directory for this job inside Keeper's home. Shell commands cannot write project files, including projectkeeper/. Use pk_* tools for that folder.`,
    promptGuidelines: [...(base.promptGuidelines ?? []), 'Write temporary files under $TMPDIR; $TEMP and $TMP point to the same private job directory. Shell cannot write project files, including projectkeeper/.'],
    executionMode: 'sequential',
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return withShellWriteLock(async () => {
        const callJobId = currentJobId;
        const callScratch = scratchDir;
        const callRoots = projectRoots;
        const callExcluded = excludedRoots;
        const denyForCall = onDeny;
        const othersWrite = deps.watchesProjects?.() ?? false;
        const command = (params as { command?: string }).command ?? '';
        const plan = planShellCommand(shell, command, ctx?.cwd || cwd, bounded, callRoots, callScratch, callExcluded);
        if (!plan.decision.ok) { denyForCall?.(); throw new Error(plan.decision.reason ?? 'Shell command refused'); }
        outputPaths.delete(callJobId);
        let snapshot: ShellProjectSnapshot;
        try { snapshot = await ShellProjectSnapshot.take(callRoots, guardHome, plan.locations, callExcluded, { othersWrite, writes: plan.writePaths }); }
        catch (error) { if (/^Error: Refused:/.test(String(error))) denyForCall?.(); throw error; }
        let result: Awaited<ReturnType<ToolDefinition['execute']>> | undefined;
        let shellError: unknown;
        try {
          spawningScratch = callScratch;
          result = await base.execute(toolCallId, params, signal, (update) => {
            rememberPiOutput(shell, (update.details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath, callJobId);
            onUpdate?.(update);
          }, ctx);
          rememberPiOutput(shell, (result.details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath, callJobId);
        } catch (error) { shellError = error; }
        finally { spawningScratch = null; }
        let changed: string[];
        try { changed = await snapshot.restore(); }
        catch (error) {
          throw new Error(`Shell project check could not restore the project. Recovery copy: ${snapshot.recoveryPath}. ${String(error)}`, { cause: error });
        }
        // What changed while the command ran, not by it, stays as it is; the step says so first, where its record shows it.
        const left = snapshot.left.length ? `${LEFT_NOTE}; left as it is: ${listPaths(snapshot.left, callRoots)}.` : '';
        if (changed.length) {
          outputPaths.delete(callJobId);
          denyForCall?.();
          throw new Error(`Shell changed project files; the changes were restored: ${listPaths(changed, callRoots)}.${left ? ` ${left}` : ''} Write temporary files under ${callScratch} (TMPDIR/TEMP/TMP). Use pk_* tools for projectkeeper/.`);
        }
        if (shellError) {
          if (!left) throw shellError;
          throw new Error(`${left}\n\n${shellError instanceof Error ? shellError.message : String(shellError)}`, { cause: shellError });
        }
        return left ? noteFirst(result!, left) : result!;
      });
    },
  });
  const tools: ToolDefinition[] = [];
  if (activeBuiltins.has('bash')) {
    tools.push(protectShell('bash', createBashToolDefinition(cwd, {
      commandPrefix: deps.settingsManager.getShellCommandPrefix(),
      shellPath: deps.settingsManager.getShellPath(),
      spawnHook,
    }) as unknown as ToolDefinition));
  }
  if (activeBuiltins.has('powershell') && process.platform === 'win32') {
    tools.push(protectShell('powershell', createPowerShellToolDefinition(cwd, { spawnHook }) as unknown as ToolDefinition));
  }
  for (const name of GUARDABLE_FILE_TOOLS) {
    if (activeBuiltins.has(name)) tools.push(guardedFileTool(name, cwd, bounded, () => onDeny?.()));
  }

  return {
    extension: { name: 'projectkeeper-read-boundary', factory } as unknown as InlineExtension,
    tools, boundary: bounded,
    get scratchDir() { return scratchDir; },
    setJobId(jobId: string, project?: Project, deny?: () => void) {
      if (project) { activeProject = project; projectRoots = shellProjectRoots(project); excludedRoots = project.scope.filter((item) => item.relation === 'Excluded' && !item.missing).map((item) => item.path); }
      currentJobId = jobId;
      if (deny) onDeny = deny;
      scratchDir = scratchFor(jobId);
      ensureScratchOutsideProject(scratchDir);
      mkdirSync(scratchDir, { recursive: true });
      outputPaths.delete(jobId);
      boundary = null;
    },
  };
}
