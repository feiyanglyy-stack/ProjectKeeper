/**
 * Source code does not reach an execution agent through ProjectKeeper (D65; Spec §7.1, §7.4, §7.10; CKC-12 AC-43).
 * What goes instead is where the code is — repository, commit, file, lines — and the agent opens the current version.
 *
 * A "code source" is a code file: a file the Keeper judged `Code`, or one whose name says it is program text or build
 * and tool configuration. A configuration-format file the Keeper judged to be one of the project's intent or record
 * materials (a plan kept in YAML, a status table in JSON) is that material, not code. Markdown sections, sessions,
 * commits and command results are never code files; a code block a design document or QC report contains is that
 * document's own text (Spec §7.1).
 *
 * The Keeper's own reading of code is not touched by any of this (Spec §7.1): only what is handed to an agent.
 */
import type { FileAnchor, Project, Source } from '../model/types.ts';
import { isWithin, relativeDisplay } from '../util/paths.ts';

const CODE_EXT = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyi', '.rb', '.go', '.rs', '.java', '.kt', '.kts',
  '.swift', '.dart', '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.m', '.mm', '.cs', '.fs', '.vb', '.php',
  '.pl', '.pm', '.lua', '.r', '.scala', '.clj', '.ex', '.exs', '.erl', '.hs', '.ml', '.sql', '.sh', '.bash', '.zsh', '.fish',
  '.ps1', '.psm1', '.bat', '.cmd', '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.gradle', '.groovy', '.cmake',
]);
const CODE_NAMES = new Set(['makefile', 'dockerfile', 'cmakelists.txt', 'gemfile', 'rakefile', 'podfile', 'jenkinsfile', 'build.bazel', 'workspace']);
/** Configuration formats: code, unless the Keeper judged the file to be one of the materials below. */
const CONFIG_EXT = new Set(['.json', '.json5', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.ini', '.cfg', '.conf', '.properties', '.plist', '.lock', '.env', '.html', '.htm']);
const CONFIG_NAMES = new Set(['.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.env.example', '.dockerignore']);
const MATERIAL_USE = new Set(['Purpose', 'Decision', 'Requirement', 'Design', 'Plan', 'Task', 'Status', 'QC', 'Run result', 'Session']);

/** Whether a file at this path, used as this, is a code file. */
export function isCodeFile(path: string, usedAs: string | null | undefined): boolean {
  if (usedAs === 'Code') return true;
  const base = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot) : '';
  if (CODE_EXT.has(ext) || CODE_NAMES.has(base)) return true;
  if (CONFIG_EXT.has(ext) || CONFIG_NAMES.has(base)) return !(usedAs && MATERIAL_USE.has(usedAs));
  return false;
}

export function isCodeSource(s: Pick<Source, 'anchor' | 'usedAs'>): boolean {
  if (s.anchor.kind !== 'file') return false;
  if (s.usedAs === 'Code') return true;
  // A section under a heading is a document's section (the reader splits only Markdown by heading).
  if (s.anchor.headingPath.length > 0) return false;
  return isCodeFile(s.anchor.path, s.usedAs);
}

/**
 * The same test on what an object page receives for a source: its label (`<path>[ › heading] (Lx–Ly)` for a file) and
 * how it is used. Anything that is not a file's label is not a code file.
 */
export function isCodeLabel(label: string, usedAs: string | null | undefined): boolean {
  const m = /^(.*) \(L\d+–L\d+\)$/.exec(label);
  if (!m) return false;
  if (usedAs === 'Code') return true;
  if (m[1]!.includes(' › ')) return false;
  return isCodeFile(m[1]!, usedAs);
}

export interface CodeLocation {
  /** The repository or directory of the project scope the file is in, when it is in one. */
  readonly repo: string | null;
  /** The file, relative to `repo` with forward slashes, or the whole path when it is in no scope item. */
  readonly file: string;
  readonly lines: string;
  /** The commit the file was read at, when the project has version control. */
  readonly commit: string | null;
}

/** Where a file source is: repository, file, lines, and the commit it was read at (Spec §7.1, §7.10). */
export function fileLocation(project: Project, s: Source): CodeLocation {
  const a = s.anchor as FileAnchor;
  const item = project.scope.find((i) => i.id === s.scopeItemId) ?? project.scope.find((i) => i.relation !== 'Excluded' && i.category !== 'Session source' && isWithin(i.path, a.path));
  const inRepo = item !== undefined && isWithin(item.path, a.path);
  return { repo: inRepo ? item.path : null, file: inRepo ? relativeDisplay(item.path, a.path) : a.path, lines: `lines ${a.lineStart}–${a.lineEnd}`, commit: s.version.commit };
}

/** `D:\repo · app/x.ts, lines 3–9, as read at commit abc1234567` */
export function locationText(loc: CodeLocation): string {
  return `${loc.repo ? `${loc.repo} · ` : ''}${loc.file}, ${loc.lines}${loc.commit ? `, as read at commit ${loc.commit.slice(0, 10)}` : ''}`;
}

/** Just the file and lines, for a statement observed in the code: `app/x.ts, lines 3–9`. */
export function shortLocationText(loc: CodeLocation): string {
  return `${loc.file}, ${loc.lines}`;
}

export interface CommitFacts { readonly subject: string; readonly at: string | null; readonly files: readonly string[] }
/**
 * What a commit source records: its message, when, and the files it changed. When it was made is the time its anchor
 * records (sources/gitobs.ts); a commit source written before the anchor carried it gives the `at:` line its excerpt
 * has. The message and the files are read from the source as the commit reader wrote it (message, then an indented
 * `files:` list); what is not there is simply left out.
 */
export function commitFacts(s: Source): CommitFacts {
  const lines = s.excerpt.split('\n');
  const at = s.anchor.kind === 'commit' && s.anchor.at !== undefined ? s.anchor.at : lines.find((l) => l.startsWith('at: '))?.slice(4).trim() ?? null;
  const start = lines.findIndex((l) => l.trim() === 'files:');
  const files = start < 0 ? [] : lines.slice(start + 1).filter((l) => /^\s+\S/.test(l)).map((l) => l.trim());
  return { subject: (lines[0] ?? s.title).trim(), at, files };
}

/** How an agent is told to read a code file itself (D65). */
export const OPEN_CURRENT = 'ProjectKeeper gives where code is, not the code: open the current version in the repository and read it there.';
