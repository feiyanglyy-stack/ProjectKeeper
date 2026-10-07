/**
 * The project's own ignore rules, as git itself judges them (Spec §1.1; CKC-04 AC-17): what git leaves out
 * (`git ls-files --others --ignored --exclude-standard --directory`) and the rule that does it — which ignore file,
 * which line, which pattern (`git check-ignore -v`). A directory without version control has no ignore rules; a
 * `.gitignore` there is just a file.
 *
 * Read-only: every call goes through `git()` (no optional locks, so not even the index's timestamps are refreshed).
 */
import { git } from '../util/git.ts';
import { nameForm } from '../util/paths.ts';

export interface IgnoreRule {
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
}
export interface IgnoredEntry {
  /** Relative to the root the listing ran in, forward slashes, no trailing slash. */
  readonly rel: string;
  readonly dir: boolean;
  readonly rule: IgnoreRule | null;
}

const LONG = 60_000;

/** Paths git leaves out under `root`, whole directories collapsed; null when `root` is not in a git work tree. */
function listIgnored(root: string): string[] | null {
  const r = git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], LONG);
  if (!r.ok) return null;
  return r.out.split('\0').filter(Boolean);
}

/** `"a\tb"` → a<TAB>b: git quotes a path with control characters, quotes or backslashes even with quotePath off. */
function unquote(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"'))) return path;
  const body = path.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
    const n = body[i + 1] ?? '';
    if (/[0-7]/.test(n)) { bytes.push(parseInt(body.slice(i + 1, i + 4), 8)); i += 3; continue; }
    bytes.push(({ t: 9, n: 10, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[n] ?? n.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The rule that leaves each path out, from `git check-ignore -v`. Paths are passed in batches to stay within the command line. */
export function ignoreRules(root: string, paths: readonly string[]): Map<string, IgnoreRule> {
  const out = new Map<string, IgnoreRule>();
  let batch: string[] = [];
  let size = 0;
  const flush = () => {
    if (batch.length === 0) return;
    const r = git(root, ['-c', 'core.quotePath=false', 'check-ignore', '-v', '--', ...batch], LONG);
    for (const line of r.out.split(/\r?\n/)) {
      const m = /^(.+?):(\d+):(.*)\t(.+)$/.exec(line);
      if (!m || m[3]!.startsWith('!')) continue;   // a negated pattern keeps the path in
      out.set(unquote(m[4]!).replace(/\/$/, ''), { file: m[1]!, line: Number(m[2]), pattern: m[3]! });
    }
    batch = [];
    size = 0;
  };
  for (const p of paths) {
    batch.push(p);
    size += p.length + 3;
    if (batch.length >= 200 || size > 6000) flush();
  }
  flush();
  return out;
}

/**
 * What the ignore rules leave out under `root`, each with its rule; null without version control. A directory git lists
 * because every file in it is ignored (no pattern names the directory itself) takes the rule of its files.
 */
export function ignoredEntries(root: string): IgnoredEntry[] | null {
  const listed = listIgnored(root);
  if (listed === null) return null;
  const dirs = listed.filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1));
  const inDir = (f: string) => dirs.some((d) => f.startsWith(`${d}/`));
  const files = listed.filter((p) => !p.endsWith('/'));
  const scattered = files.filter((f) => !inDir(f));
  const rules = ignoreRules(root, [...dirs.map((d) => `${d}/`), ...scattered]);
  const missing = dirs.filter((d) => !rules.has(d));
  const byFile = missing.length ? ignoreRules(root, files.filter((f) => missing.some((d) => f.startsWith(`${d}/`)))) : new Map<string, IgnoreRule>();
  return [
    ...dirs.map((d) => ({ rel: d, dir: true, rule: rules.get(d) ?? [...byFile].find(([f]) => f.startsWith(`${d}/`))?.[1] ?? null })),
    ...scattered.map((f) => ({ rel: f, dir: false, rule: rules.get(f) ?? null })),
  ];
}

/**
 * A predicate for a walk under `root`: is this relative path (forward slashes) left out by the ignore rules? Null
 * without version control.
 */
export function ignoredPredicate(root: string): ((rel: string) => boolean) | null {
  const listed = listIgnored(root);
  if (listed === null) return null;
  return predicateOf(listed.filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1)), listed.filter((p) => !p.endsWith('/')));
}

/** The same predicate from entries already listed. */
export function predicateFrom(entries: readonly IgnoredEntry[]): (rel: string) => boolean {
  return predicateOf(entries.filter((e) => e.dir).map((e) => e.rel), entries.filter((e) => !e.dir).map((e) => e.rel));
}

function predicateOf(dirList: readonly string[], fileList: readonly string[]): (rel: string) => boolean {
  // Both sides in the form names are kept in: what git lists and what a walk asks about are compared, nothing more.
  const dirs = new Set(dirList.map((d) => nameForm(d)));
  const files = new Set(fileList.map((f) => nameForm(f)));
  return (rel: string) => {
    const p = nameForm(rel).split('\\').join('/');
    if (files.has(p) || dirs.has(p)) return true;
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i += 1) if (dirs.has(segs.slice(0, i).join('/'))) return true;
    return false;
  };
}

/** One path, asked of git directly (the watcher's check for a file it has not seen). */
export function isIgnored(root: string, rel: string): boolean {
  const r = git(root, ['check-ignore', '-q', '--', rel.split('\\').join('/')]);
  return r.ok;
}
