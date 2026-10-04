/**
 * The one skip list (Spec §1.1; CKC-04 AC-13, AC-17): which directories are never walked as project material, which
 * names are build output, caches or installed dependencies, which directories projects keep vendored code in, which
 * files are documents, and what a scope item's relation means for what is read from it. Scope discovery, the file
 * scan and the watcher read all of it from here; the organizing code should too (takeover.ts and materials.ts still
 * keep their own path patterns and move here when their owner next touches them).
 *
 * A name here is a candidate, not a verdict: discovery lists what it finds with the reason, the Keeper judges it
 * (`pk_classify_scope`) and the owner can correct it. The project's own ignore rules are in ./ignore.ts; git decides
 * those, not this list.
 */
import { extname } from 'node:path';
import type { ScopeItem } from '../model/types.ts';
import type { UsedAs } from '../model/vocab.ts';
import { isWithin } from '../util/paths.ts';

/** Version-control internals, and the usual home of worktrees (each registered worktree is measured on its own). */
export const NEVER_WALKED: ReadonlySet<string> = new Set(['.git', '.hg', '.svn', '.worktrees']);

/** Usual names of what a build or a tool writes, with the kind shown as the reason. Compared without regard to case. */
const GENERATED: Readonly<Record<string, string>> = {
  build: 'build output', dist: 'build output', out: 'build output', target: 'build output', deriveddata: 'build output',
  cmakefiles: 'build output', '.eggs': 'build output',
  '.gradle': 'build cache', '.next': 'build cache', '.nuxt': 'build cache', '.svelte-kit': 'build cache',
  '.angular': 'build cache', '.turbo': 'build cache', '.parcel-cache': 'build cache', '.cache': 'cache', '__pycache__': 'cache',
  '.pytest_cache': 'cache', '.mypy_cache': 'cache', '.ruff_cache': 'cache', '.tox': 'cache', coverage: 'test coverage output',
  '.nyc_output': 'test coverage output', '.playwright-cli': 'tool output',
};
/** Where package managers install other people's code. Not distributed with the project; nothing in it is read. */
const DEPENDENCIES: ReadonlySet<string> = new Set(['node_modules', 'bower_components', 'jspm_packages', '.venv', 'venv', 'site-packages']);
/** Usual names of directories a project keeps vendored third-party code in; their documents are read as Reference only. */
const VENDORED: ReadonlySet<string> = new Set(['third_party', 'third-party', 'thirdparty', 'vendor', 'vendors', 'external', 'externals', 'extern']);

/** Third-party material of these kinds is not read at all: installed dependencies, and links to places outside the project. */
export const NOT_READ_KINDS: ReadonlySet<string> = new Set(['installed dependencies', 'linked in']);

export interface NameClass {
  readonly relation: 'Generated' | 'Third-party material';
  readonly kind: string;
  readonly evidence: string;
}

/** What a directory's name alone suggests, or null. */
export function classifyName(name: string): NameClass | null {
  const n = name.toLowerCase();
  if (GENERATED[n]) return { relation: 'Generated', kind: GENERATED[n]!, evidence: `${name}/ is a usual name for ${GENERATED[n]}` };
  if (DEPENDENCIES.has(n)) return { relation: 'Third-party material', kind: 'installed dependencies', evidence: `${name}/ is where a package manager installs dependencies` };
  if (VENDORED.has(n)) return { relation: 'Third-party material', kind: 'vendored code', evidence: `${name}/ is a usual name for vendored third-party code` };
  return null;
}

/** A walk that has no scope item telling it otherwise does not enter these: version control, build output, dependencies, vendored code. */
export function isSkippedName(name: string): boolean {
  return NEVER_WALKED.has(name.toLowerCase()) || classifyName(name) !== null;
}

/** A directory of vendored code holds libraries worth telling apart (each with its own upstream and license). */
export function isVendoredName(name: string): boolean {
  return VENDORED.has(name.toLowerCase());
}

/**
 * Whether an item takes in what the project's ignore rules leave out: the owner chose to include it (an answer to the
 * scope question, a correction, or a location added by hand inside the project), or the Keeper judged it the project's
 * material. The project's own locations are not such a choice: the rules apply inside them.
 */
export function overridesIgnoreRules(scope: readonly ScopeItem[], item: ScopeItem): boolean {
  if (item.relation === 'Excluded') return false;
  if (item.ignoredBy != null || (item.classification != null && item.classification.by !== 'program')) return true;
  return item.addedBy === 'owner' && scope.some((o) => o !== item && o.category !== 'Session source' && o.path.length < item.path.length && isWithin(o.path, item.path));
}

/** The first segment of a relative path that a walk would not enter, or null. */
export function skippedSegment(relPath: string): string | null {
  for (const seg of relPath.split(/[\\/]/)) if (seg && isSkippedName(seg)) return seg;
  return null;
}

const DOC_EXT: ReadonlySet<string> = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc', '.asciidoc', '.org']);
const DOC_NAMES: ReadonlySet<string> = new Set(['readme', 'license', 'licence', 'copying', 'notice', 'changelog', 'authors', 'contributing']);
/** A license file at the top of a directory: the directory brings its own terms. */
export const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|rst))?$/i;

/** Text a person wrote — notes, plans, READMEs, licenses — as opposed to code, data or binaries. */
export function isDocumentPath(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? '';
  if (DOC_EXT.has(extname(base).toLowerCase())) return true;
  return DOC_NAMES.has(base.toLowerCase().replace(/\.[^.]*$/, '')) && !/\.(js|ts|json|py|sh|html|css)$/i.test(base);
}

/**
 * What is read from a scope item (Spec §1.1):
 * - `read`: everything a walk does not skip;
 * - `documents`: third-party material — only its documents, as `Reference only`;
 * - `changes`: a worktree registered under a repository in scope — only what it adds to the trunk (E60);
 * - `history`: a location the project keeps for recovery only — read so it can be cited, never current material
 *   (its `Used as` follows the project's rule). The rule changes how what is read counts, not what is read (D1): what
 *   the ignore rules leave out, or a judgement about the location (the Keeper's, the owner's, the program's reading of
 *   it as build output or someone else's code) left out, stays unread; the program's own guess from a folder's name
 *   that it holds deleted material (trash/ and the like) gives way to the project's rule, which says what it holds;
 * - `none`: generated output, what the ignore rules leave out, what the owner excluded.
 */
export type Treatment = 'read' | 'documents' | 'changes' | 'history' | 'none';

const recoveryOnly = (item: ScopeItem) => (item.coveredBy ?? []).some((c) => c.category === 'Recovery only');
/** Left out by the project's ignore rules or by a judgement about the location, not by a Recovery only rule or a folder's name. */
const leftOutByDecision = (item: ScopeItem) => item.ignoredBy != null || item.classification != null;
const registeredWorktree = (item: ScopeItem) => item.category === 'Worktree' && (item.relation === 'Worktree of main repo' || item.worktree != null);

export function treatmentOf(item: ScopeItem): Treatment {
  if (item.category === 'Session source' || item.missing) return 'none';
  if (item.relation === 'Excluded') return item.addedBy === 'keeper' && recoveryOnly(item) && !leftOutByDecision(item) ? 'history' : 'none';
  if (item.relation === 'Generated') return 'none';
  if (item.relation === 'Third-party material') return NOT_READ_KINDS.has(item.classification?.kind ?? '') ? 'none' : 'documents';
  if (registeredWorktree(item)) return 'changes';
  return 'read';
}

/** Items that stand for a location on disk (not session sources), deepest first. */
const locational = (scope: readonly ScopeItem[]) => scope.filter((i) => i.category !== 'Session source').sort((a, b) => b.path.length - a.path.length);

/** The deepest scope item whose location holds `path`. */
export function innermostItem(scope: readonly ScopeItem[], path: string): ScopeItem | undefined {
  return locational(scope).find((i) => isWithin(i.path, path));
}

/**
 * Whether a scope item is read at all, given the items above it: under a location that is left out, nothing is read,
 * except what the owner added by hand and the worktrees registered under the repository (each measured on its own).
 */
export function isReadRoot(scope: readonly ScopeItem[], item: ScopeItem): boolean {
  if (treatmentOf(item) === 'none') return false;
  if (item.addedBy === 'owner' || registeredWorktree(item)) return true;
  return !locational(scope).some((o) => o !== item && o.path.length < item.path.length && isWithin(o.path, item.path) && treatmentOf(o) === 'none');
}

/** How a file is read given the scope: which item it belongs to and the `Used as` its location sets, if any. */
export function readingOf(scope: readonly ScopeItem[], path: string): { item: ScopeItem | undefined; treatment: Treatment; usedAs: { value: UsedAs; by: 'keeper' | 'owner'; scopeItemId: string } | null } {
  const item = innermostItem(scope, path);
  if (!item) return { item, treatment: 'read', usedAs: null };
  const treatment = treatmentOf(item);
  const usedAs = treatment === 'documents' && isDocumentPath(path)
    ? { value: 'Reference only' as const, by: item.classification?.by === 'owner' ? 'owner' as const : 'keeper' as const, scopeItemId: item.id }
    : null;
  return { item, treatment, usedAs };
}

/** Commits of this item are taken as sources: the project's repositories and the worktrees that add something to the trunk. */
export function readsCommits(item: ScopeItem): boolean {
  if (item.category !== 'Repository' && item.category !== 'Worktree') return false;
  const t = treatmentOf(item);
  if (t !== 'read' && t !== 'changes') return false;
  const w = item.worktree;
  // A merged worktree with nothing uncommitted contributes nothing: not its commits, not its status (E60).
  return !(t === 'changes' && w && w.merged === true && w.uniqueCommits === 0 && w.taken.length === 0);
}

/** What is read from where, in one comparable line: a change in it means the scan has to run again. */
export function scanSignature(scope: readonly ScopeItem[]): string {
  return scope.filter((i) => i.category !== 'Session source').map((i) => `${i.path.toLowerCase()}=${treatmentOf(i)}`).sort().join('\n');
}
