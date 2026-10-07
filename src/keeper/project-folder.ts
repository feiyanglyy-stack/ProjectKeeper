/**
 * The one owner-authorized folder in a project (Spec §1.14, §1.17; CKC-26 AC-7–AC-11).
 * The Markdown below is also exported for the workbench, so it need not maintain a second rendition.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SemanticPatch, EvidenceRef, Occurred } from '../model/k-types.ts';
import type { Authorization, Project, ReferenceItem, Source } from '../model/types.ts';
import { newId } from '../model/ids.ts';
import { anchorLabel } from '../sources/anchor.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { git, gitToplevel, LONG_PATHS, type GitResult } from '../util/git.ts';
import { canonicalPath, gitPathLimit } from '../util/paths.ts';

const FILES = ['README.md', 'semantic-patches.md', 'keeper-numbers.md', 'owner-decisions.md'] as const;
/** The Keeper's commits name it as their author (D89: the Keeper commits the folder itself), so the ledger and `git log`
 *  tell them from the owner's work; the committer stays the repository's own identity and no configuration is written.
 *  Where git knows no identity at all (a machine with no `user.name` and `user.email`), the Keeper is the committer too,
 *  for that one commit, so the commit does not fail. */
const KEEPER_NAME = 'ProjectKeeper';
const KEEPER_EMAIL = 'keeper@projectkeeper.invalid';
export const KEEPER_AUTHOR = `${KEEPER_NAME} <${KEEPER_EMAIL}>`;
const now = (): string => new Date().toISOString();
const sortBy = <T>(items: readonly T[], key: (item: T) => string): T[] =>
  [...items].sort((a, b) => key(a).localeCompare(key(b), 'en'));
const inline = (value: string): string => value.replace(/\s+/g, ' ').trim();
const block = (value: string): string => value.trim().replace(/\r\n?/g, '\n') || 'Not recorded';

function statIfPresent(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolve a folder, never a project root, hidden folder, git metadata path or path outside the project's first root. */
export function projectFolderPath(project: Project, requested = 'projectkeeper'): string {
  const location = project.locations[0];
  if (!location) throw new Error('The project has no root location');
  // The root in the file system's own spelling (short names expanded, links resolved): the one git reports the
  // repository in, so the folder is found inside it when the commit is made.
  const root = canonicalPath(location);
  if (!lstatSync(root).isDirectory()) throw new Error('The project root is not a directory');
  if (!requested.trim() || requested.includes('\0') || /^[A-Za-z]:[^\\/]/.test(requested) || requested.split(/[\\/]/).some((part) => part === '..' || part === '.')) throw new Error('Invalid project folder path');
  // Spelled as it will stay: Windows drops a trailing dot or space from a name, so such a name would write somewhere
  // other than the path shown and granted (QC AW-2). The owner gives the path relative to the root (the grant checks);
  // the authorization keeps it resolved, and every write checks that resolved path again here.
  if (requested.split(/[\\/]/).some((part) => /[. ]$/.test(part))) throw new Error('Invalid project folder path: a name ending in a dot or a space is not kept as written');
  const folder = resolve(root, requested);
  if (!inside(root, folder)) throw new Error('The project folder must be inside the project root');
  const parts = relative(root, folder).split(sep);
  if (parts.some((part) => part.startsWith('.'))) throw new Error('The project folder must not be hidden or inside .git');
  let cursor = root;
  for (const part of parts) {
    const parent = cursor;
    cursor = join(cursor, part);
    const stat = statIfPresent(cursor);
    if (!stat) continue;
    // An existing name is used exactly as it is on disk: another case or an 8.3 short alias would name the same folder
    // under a spelling the grant never showed (QC AW-2).
    if (!readdirSync(parent).includes(part)) throw new Error(`Invalid project folder path: ${part} names an existing folder spelled differently on disk`);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe project folder component: ${cursor}`);
    if (!inside(root, realpathSync(cursor))) throw new Error(`Project folder escapes through a link: ${cursor}`);
  }
  const entries = statIfPresent(folder) ? readdirSync(folder) : [];
  if (entries.length) {
    const readme = join(folder, 'README.md');
    const readmeStat = statIfPresent(readme);
    if (!readmeStat?.isFile() || readmeStat.isSymbolicLink() || !readFileSync(readme, 'utf8').includes('This folder is maintained by ProjectKeeper')) {
      throw new Error('The chosen folder already contains project files and is not a ProjectKeeper folder');
    }
    if (entries.some((entry) => !(FILES as readonly string[]).includes(entry))) throw new Error('The ProjectKeeper folder contains files outside its managed set');
  }
  return folder;
}

export interface ProjectFolderAuthorizationInput {
  readonly path?: string;
  readonly commits?: boolean;
  readonly quote: string;
  readonly sourceId?: string;
}

/** The route supplies an explicit owner statement; no model or project material can create this authorization. */
export function grantProjectFolderAuthorization(store: ProjectStore, project: Project, input: ProjectFolderAuthorizationInput): Authorization {
  if (store.projectId !== project.id) throw new Error('The project and asset store do not match');
  if (!input.quote.trim()) throw new Error('The owner authorization quote is required');
  // The owner names the folder relative to the project root (QC AW-2): an absolute path, even one inside the project,
  // is refused rather than silently taken as the same folder.
  if (input.path !== undefined && isAbsolute(input.path)) throw new Error('Invalid project folder path: give it relative to the project root');
  if (store.authorizations.find((a) => a.projectFolder != null && !a.revokedAt)) throw new Error('An active Project folder authorization already exists; revoke it before changing the folder');
  if (input.sourceId) {
    const source = store.sources.get(input.sourceId);
    if (!source || source.anchor.kind !== 'session' || source.said?.by === 'agent') throw new Error(`Invalid owner source: ${input.sourceId}`);
  }
  const path = projectFolderPath(project, input.path);
  const commits = input.commits ?? true;
  const authorization: Authorization = {
    id: newId('auth'), projectId: project.id,
    scope: `ProjectKeeper may maintain ${path} and ${commits ? 'make path-limited commits for that folder' : 'leave its changes uncommitted'}; it will not push or edit other project files.`,
    sourceId: input.sourceId ?? '', quote: input.quote.trim(), at: now(), revokedAt: null,
    projectFolder: { path, commits, lastWrite: null },
  };
  store.authorizations.put(authorization, { jobId: null, basisSourceIds: input.sourceId ? [input.sourceId] : [], summary: 'Owner authorized the ProjectKeeper project folder' });
  return authorization;
}

function occurrence(when: Occurred): string {
  const main = when.undated ? `Undated; first observed ${when.at}` : when.at;
  // Spec §2.11: a second time the material gives is kept beside the first ("另记"), not judged a conflict.
  const other = when.other ? `; also recorded ${when.other.at} (${when.other.basis}${when.other.anchor ? `, ${when.other.anchor}` : ''})` : '';
  return `${main} (${when.basis}${when.anchor ? `, ${when.anchor}` : ''}${other})`;
}

function evidence(ref: EvidenceRef | null): string {
  if (!ref) return 'Not recorded';
  const line = ref.line ? `; original: ${inline(ref.line)}` : '';
  return `${ref.label} [${ref.kind}: ${ref.id}]${line}`;
}

function patchEntry(patch: SemanticPatch): string {
  return [
    `## ${inline(patch.number)} · ${inline(patch.title)}`,
    '',
    `- **Workbench object:** \`${patch.id}\``,
    `- **Status:** ${patch.status}${patch.partial ? ' · partial (the remainder stays current)' : ''}`,
    `- **Occurred:** ${occurrence(patch.occurred)}`,
    `- **Invalidated part:** ${block(patch.invalidated)}`,
    `- **Replacement:** ${block(patch.replacedBy)}`,
    `- **Affected objects:** ${patch.affects.length ? sortBy(patch.affects, (id) => id).map((id) => `\`${id}\``).join(', ') : 'None identified'}`,
    `- **Affected in words:** ${block(patch.affectsText)}`,
    `- **Must no longer pass as current:** ${block(patch.mustNotPassAsCurrent)}`,
    `- **Old source:** ${evidence(patch.oldAnchor)}`,
    `- **New source:** ${evidence(patch.newAnchor)}`,
    `- **Replacing decision or commit:** ${evidence(patch.decision)}`,
    `- **Explicit replacement record:** ${evidence(patch.candidate)}`,
    '',
  ].join('\n');
}

function ownerSource(s: Source): boolean {
  return s.anchor.kind === 'session' && s.said?.by !== 'agent';
}

function ownerDecisions(store: ProjectStore): { item: ReferenceItem; sessions: Source[]; documents: Source[] }[] {
  return store.reference.all().filter((item) => item.projectId === store.projectId && item.category === 'Decision').flatMap((item) => {
    const sources = item.sourceIds.map((id) => store.sources.get(id)).filter((s): s is Source => s !== undefined);
    const sessions = sources.filter(ownerSource);
    if (!sessions.length || (item.attribution.author.kind !== 'owner' && !sessions.some((s) => s.said?.by === 'owner'))) return [];
    const documents = sources.filter((s) => s.anchor.kind === 'file' || s.anchor.kind === 'revision');
    return [{ item, sessions, documents }];
  });
}

function numberProvenance(store: ProjectStore, objectId: string): string {
  const reference = store.reference.get(objectId);
  const thread = store.threads.get(objectId);
  const patch = store.patches.get(objectId);
  if (patch) return `${evidence(patch.candidate)}; numbered object \`${patch.id}\``;
  const ids = reference?.sourceIds ?? thread?.inputs?.sourceIds ?? [];
  const sources = ids.map((id) => store.sources.get(id)).filter((source): source is Source => source !== undefined);
  return sources.length
    ? sortBy(sources, (source) => source.id).map((source) => `${anchorLabel(source.anchor)} [source: ${source.id}]`).join('; ')
    : `Workbench object \`${objectId}\`; the number record has no separate source anchor`;
}

/** Stable filenames and bytes for both the on-disk folder and its workbench rendering. */
export function renderProjectFolder(store: ProjectStore, project: Project): Readonly<Record<(typeof FILES)[number], string>> {
  const patches = sortBy(store.patches.filter((p) => p.projectId === project.id && p.status !== 'Rejected'), (p) => `${p.occurred.at}\0${p.number}\0${p.id}`);
  const numbers = sortBy(store.numbers.filter((n) => n.projectId === project.id && !(n.objectKind === 'patch' && store.patches.get(n.objectId)?.status === 'Rejected')), (n) => `${n.at}\0${n.number}\0${n.id}`);
  const decisions = sortBy(ownerDecisions(store), ({ item, sessions }) => `${sessions.map((s) => s.anchor.kind === 'session' ? s.anchor.at ?? '' : '').sort()[0] ?? ''}\0${item.id}`);
  const patchText = patches.map(patchEntry).join('\n');
  const numberText = numbers.map((n) => [
    `## ${inline(n.projectNumber ?? n.number)} · ${inline(n.objectKind)}`,
    '',
    `- **Workbench number object:** \`${n.id}\``,
    `- **Object:** \`${n.objectId}\` (${n.objectKind})`,
    `- **Keeper number:** \`${n.number}\`${n.projectNumber ? ' (alias)' : ' (current)'}`,
    `- **Project number:** ${n.projectNumber ? `\`${n.projectNumber}\`` : 'Not assigned'}`,
    `- **Occurred:** ${n.at}`,
    `- **Source:** ${numberProvenance(store, n.objectId)}`,
    '',
  ].join('\n')).join('\n');
  const decisionText = decisions.map(({ item, sessions, documents }) => {
    const first = sortBy(sessions, (s) => `${s.anchor.kind === 'session' ? s.anchor.at ?? '\uffff' : '\uffff'}\0${s.id}`)[0]!;
    const occurred = first.anchor.kind === 'session' ? first.anchor.at ?? 'Undated in session' : 'Undated in session';
    const quote = item.quote ?? (first.said?.by === 'owner' ? first.excerpt.slice(first.said.wordsFrom) : null);
    return [
      `## ${inline(item.name || item.id)}`,
      '',
      `- **Workbench object:** \`${item.id}\``,
      `- **Validity:** ${item.validity}`,
      `- **Occurred:** ${occurred}`,
      `- **Owner's words:** ${quote ? block(quote) : 'Original quote unavailable in this record'}`,
      `- **Decision as recorded:** ${block(item.text)}`,
      `- **Session source:** ${sortBy(sessions, (s) => s.id).map((s) => `${anchorLabel(s.anchor)} [source: ${s.id}]`).join('; ')}`,
      `- **Also documented at:** ${documents.length ? sortBy(documents, (s) => s.id).map((s) => `${anchorLabel(s.anchor)} [source: ${s.id}]`).join('; ') : 'Not yet in a project document'}`,
      '',
    ].join('\n');
  }).join('\n');
  return {
    'README.md': `# ProjectKeeper records for ${inline(project.name)}\n\nThis folder is maintained by ProjectKeeper with the project owner's standing authorization. It contains the same identified records shown in the ProjectKeeper workbench; use the object IDs below to open the same entries there. Project documents outside this folder remain owned by the project.\n\n- [Semantic patches](semantic-patches.md): explicit changes to the meaning of project documents.\n- [Keeper numbers](keeper-numbers.md): IDs assigned where the project had none; project IDs take precedence.\n- [Owner decisions from sessions](owner-decisions.md): owner decisions first recorded in conversation, with links to later project documentation when available.\n`,
    'semantic-patches.md': `# Semantic patches\n\n${patchText || 'No non-rejected semantic patches are recorded.\n'}`,
    'keeper-numbers.md': `# Keeper numbers\n\n${numberText || 'No Keeper numbers are recorded.\n'}`,
    'owner-decisions.md': `# Owner decisions from sessions\n\n${decisionText || 'No owner decisions with a session source are recorded.\n'}`,
  };
}

export interface ProjectFolderSyncResult {
  readonly status: 'not-authorized' | 'unchanged' | 'written';
  readonly path: string | null;
  readonly changedFiles: readonly string[];
  readonly commit: string | null;
  readonly reason: string | null;
}

/** Unlike util/git.ts, these two operations must take git's index lock and write a commit. */
/**
 * The project's own git hooks never run for the Keeper's commits (QC AW-2): a pre-commit or commit-msg hook can change
 * files outside the folder, and a post-commit hook can push, which would break "only this folder, never pushed" (D89).
 * `--no-verify` is not enough (prepare-commit-msg and post-commit still run), so each write points `core.hooksPath` at
 * an empty directory of its own, for that one command; the repository's configuration is never written.
 */
let noHooksDir: string | null = null;
const noHooks = (): string => (noHooksDir ??= mkdtempSync(join(tmpdir(), 'pk-no-hooks-')));

function gitWrite(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): GitResult {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const out = execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${noHooks()}`, ...LONG_PATHS, '-C', cwd, ...args], {
        encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '1', GIT_TERMINAL_PROMPT: '0', ...env },
        timeout: 20_000, maxBuffer: 16_000_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, out, err: '' };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      const result = { ok: false, out: e.stdout ?? '', err: (e.stderr || e.message || String(error)).trim() };
      if (!/index\.lock/i.test(result.err) || attempt === 3) return result;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (attempt + 1));
    }
  }
  return { ok: false, out: '', err: 'Git write retry exhausted' };
}

/** The committer of the Keeper's commit: the repository's own identity when git has one (nothing is passed), the Keeper otherwise. */
function committerEnv(repo: string): NodeJS.ProcessEnv {
  return git(repo, ['var', 'GIT_COMMITTER_IDENT']).ok ? {} : { GIT_COMMITTER_NAME: KEEPER_NAME, GIT_COMMITTER_EMAIL: KEEPER_EMAIL };
}

function recordIssue(store: ProjectStore, authorizationId: string, message: string): void {
  store.trace({ collection: 'authorizations', id: authorizationId, op: 'put', jobId: null, summary: `Project folder sync: ${message}` });
}

/** Write only the four managed files, then optionally make a commit whose pathspec is only this folder. */
export function syncProjectFolder(store: ProjectStore, project: Project): ProjectFolderSyncResult {
  const authorization = sortBy(store.authorizations.filter((a) => a.projectFolder != null && !a.revokedAt), (a) => a.at).at(-1);
  if (!authorization?.projectFolder) return { status: 'not-authorized', path: null, changedFiles: [], commit: null, reason: null };
  const folder = projectFolderPath(project, authorization.projectFolder.path);
  const rendered = renderProjectFolder(store, project);
  const root = canonicalPath(project.locations[0]!);
  if (!inside(root, folder)) throw new Error('Project folder escaped the project root');
  mkdirSync(folder, { recursive: true });
  if (!inside(root, realpathSync(folder))) throw new Error('Project folder escaped through a link');
  const changedFiles: string[] = [];
  for (const name of FILES) {
    const target = join(folder, name);
    const stat = statIfPresent(target);
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error(`Unsafe project folder file: ${target}`);
    if (stat && readFileSync(target, 'utf8') === rendered[name]) continue;
    writeFileSync(target, rendered[name], 'utf8');
    changedFiles.push(name);
  }

  let commit: string | null = null;
  let reason: string | null = null;
  if (authorization.projectFolder.commits) {
    const repo = gitToplevel(root);
    // A repository git cannot open because its path is too long is not "no repository": the reason says which it is.
    const tooLong = repo ? null : gitPathLimit(root);
    if (tooLong) reason = `The project folder's files were written without a commit. ${tooLong}`;
    else if (!repo || !inside(repo, folder)) reason = 'The project folder is not in a git repository; files were written without a commit.';
    else {
      const pathspec = relative(repo, folder).split(sep).join('/');
      const status = git(repo, ['status', '--porcelain', '--untracked-files=all', '--', pathspec]);
      if (!status.ok) reason = `Could not inspect git status: ${status.err}`;
      else if (!status.out.trim() && changedFiles.length) reason = 'Git did not see the written files; the folder may be ignored.';
      else if (status.out.trim()) {
        const added = gitWrite(repo, ['add', '--', pathspec]);
        if (!added.ok) reason = `Git add failed: ${added.err}`;
        else {
          const staged = git(repo, ['diff', '--cached', '--name-only', '--', pathspec]);
          if (!staged.ok) reason = `Could not inspect staged folder changes: ${staged.err}`;
          else if (staged.out.trim()) {
            const summary = changedFiles.length ? changedFiles.join(', ') : staged.out.trim().split(/\r?\n/).map((path) => basename(path)).join(', ');
            const committed = gitWrite(repo, ['commit', `--author=${KEEPER_AUTHOR}`, '-m', `ProjectKeeper: update ${summary}`, '--', pathspec], committerEnv(repo));
            if (!committed.ok) reason = `Git commit failed: ${committed.err}`;
            else {
              const head = git(repo, ['rev-parse', 'HEAD']);
              commit = head.ok ? head.out.trim() : null;
              if (!commit) reason = `Commit succeeded but its hash could not be read: ${head.err}`;
            }
          }
        }
      }
    }
  }
  if (reason) recordIssue(store, authorization.id, reason);
  if (changedFiles.length || commit) {
    const at = changedFiles.length ? now() : authorization.projectFolder.lastWrite?.at ?? now();
    store.authorizations.put({ ...authorization, projectFolder: { ...authorization.projectFolder, lastWrite: { at, commit } } }, {
      jobId: null, summary: `ProjectKeeper project folder ${changedFiles.length ? 'written' : 'committed'}${commit ? ` at ${commit}` : ''}`,
    });
    for (const patch of store.patches.filter((p) => p.projectId === project.id && p.status !== 'Rejected')) {
      if (patch.writtenToFolder?.path === folder && patch.writtenToFolder.commit === commit && !changedFiles.length) continue;
      store.patches.put({ ...patch, writtenToFolder: { path: folder, commit, at } });
    }
  }
  for (const patch of store.patches.filter((p) => p.projectId === project.id && p.status === 'Rejected' && p.writtenToFolder?.path === folder)) {
    store.patches.put({ ...patch, writtenToFolder: null });
  }
  return {
    status: changedFiles.length || commit ? 'written' : 'unchanged', path: folder, changedFiles, commit,
    reason,
  };
}
