/**
 * `GET /api/folders` — the folders of one directory, for the workbench's folder chooser (`ui/folder-chooser.js`): where a
 * location is typed (Add project, a scope item's path), `Browse…` lets the owner walk to it instead.
 *
 *   ?path=<a whole path>     the directory to list; none is the home directory. `~` is the home directory too.
 *   ?hidden=1                hidden folders as well (off by default: a leading dot; on Windows the hidden attribute too)
 *   ?added=<path>            repeated: paths the page already holds, so the folders among them can be marked
 *
 * It reads and changes nothing, and it lists folders only, never files. It does tell whoever may call it the folder
 * names of the whole machine, so it stands behind the same check as every route (http.ts `refusal`): the workbench's own
 * pages and programs on this machine, nobody else.
 *
 * What it must not do is hang or grow:
 *  - A directory with a great many entries is read in one call, and at most `SHOWN` folders are sent back, in name
 *    order, with the number left out. Only those sent are looked into (one `lstat` each, for `.git`), within a budget.
 *  - It never walks down. A link (a junction on Windows) is followed once, to see that it leads to a directory, and a
 *    path that is entered is put in the file system's own spelling (util/paths.ts `canonicalPath`), so a link that
 *    points back up shows the place it leads to and no path grows by going round.
 *  - A drive that does not answer (a network drive whose server is gone) is not waited for: the drives are listed by
 *    asking Windows for their letters, which touches none of them, and everything that does touch a drive runs under a
 *    time limit. While a drive has not answered, nothing more is asked of it, so the few threads Node reads files on
 *    are not all left waiting.
 */
import { execFile } from 'node:child_process';
import { lstat, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, sep } from 'node:path';
import { HttpApp, HttpError } from './http.ts';
import { canonicalPath, normalizePath, pathKey } from '../util/paths.ts';

const WIN = process.platform === 'win32';

/** How many folders one answer carries; the rest are counted. */
export const SHOWN = 500;
/** How long a directory may take to answer before the chooser is told it has not. */
const ANSWER_MS = 4000;
/** How long looking for `.git` in the folders shown, and following the links among the entries, may take together. */
const MARKS_MS = 600;

export interface FolderEntry {
  readonly name: string;
  readonly path: string;
  /** It holds a `.git` entry: a directory (a repository) or a file (a worktree, a submodule). */
  readonly repository: boolean;
  readonly hidden: boolean;
  /** A link or a junction that leads to a directory. */
  readonly link: boolean;
  /** Among the paths the page says it already holds. */
  readonly added: boolean;
}

export interface FolderStart { readonly label: string; readonly path: string; readonly kind: 'home' | 'drive' | 'root' }

export interface FolderListing {
  /** The directory, in the file system's own spelling; as it was asked for when it could not be read. */
  readonly path: string;
  readonly name: string;
  /** One level up; null at the top (a drive, `/`, a network share). */
  readonly parent: string | null;
  /** The separator of this system's paths: the page builds none itself. */
  readonly sep: string;
  readonly repository: boolean;
  readonly added: boolean;
  readonly folders: FolderEntry[];
  /** Folders left out of `folders` because there are more than `SHOWN`, links that were not followed in time among them. */
  readonly more: number;
  /** Hidden folders here, shown or not. */
  readonly hidden: number;
  /** Why the directory is not listed; the chooser says it in the list's place. */
  readonly error: string | null;
  readonly starts: FolderStart[];
}

export interface FolderRequest { readonly path?: string | null; readonly hidden?: boolean; readonly added?: readonly string[] }
/** For tests: a smaller cap, a shorter wait, another home, a read that never answers. */
export interface FolderOptions {
  readonly shown?: number;
  readonly answerMs?: number;
  readonly marksMs?: number;
  readonly home?: string;
  readonly readEntries?: typeof readEntries;
}

// ───────────────────────── where to start ─────────────────────────

const WHOLE_PATH = WIN ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/?.])/ : /^\//;

/** A path that says where it is in full, or null: `~` is the home directory, `D:` is the drive's top. */
function wholePath(text: string, home: string): string | null {
  let path = text.trim();
  if (path === '~' || /^~[\\/]/.test(path)) path = path === '~' ? home : join(home, path.slice(2));
  if (WIN && /^[A-Za-z]:$/.test(path)) path += sep;
  return WHOLE_PATH.test(path) ? normalizePath(path) : null;
}

let drivesKnown: string[] | null = null;         // the last answer
let drivesAskedAt = 0;
let drivesAsking: Promise<string[]> | null = null;

/**
 * The drive letters Windows knows, as `C:\`. Asked of Windows itself (`GetLogicalDrives`, through the PowerShell every
 * Windows has), which names them without opening any: trying each letter in turn would wait on every drive that is
 * not there. That shell takes a moment to start, so the answer is kept: a listing gets the last one at once, and it is
 * asked again in the background when it is older than a few seconds (a drive plugged in shows on the listing after).
 * Only the first listing of all waits for it, and not long; without an answer, the drives this process stands on.
 */
function windowsDrives(home: string): Promise<string[]> {
  const standing = [...new Set([parse(home).root, `${process.env.SystemDrive ?? 'C:'}\\`].map((d) => d.toUpperCase()))].filter((d) => /^[A-Z]:\\$/.test(d)).sort();
  if (drivesAsking === null && Date.now() - drivesAskedAt > 15_000) {
    drivesAskedAt = Date.now();
    const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    drivesAsking = new Promise<string[]>((resolvePromise) => {
      execFile(shell, ['-NoProfile', '-NonInteractive', '-Command', '[System.IO.Directory]::GetLogicalDrives()'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        const found = error ? [] : [...new Set((String(stdout).match(/[A-Za-z]:\\/g) ?? []).map((d) => d.toUpperCase()))].sort();
        if (found.length) drivesKnown = found; else drivesAskedAt = 0;   // no answer: asked again with the next listing
        drivesAsking = null;
        resolvePromise(drivesKnown ?? standing);
      });
    });
  }
  if (drivesKnown) return Promise.resolve(drivesKnown);
  return Promise.race([drivesAsking ?? Promise.resolve(standing), new Promise<string[]>((r) => { setTimeout(() => r(standing), 1200).unref?.(); })]);
}

async function quickStarts(home: string): Promise<FolderStart[]> {
  const first: FolderStart = { label: 'Home', path: home, kind: 'home' };
  if (!WIN) return [first, { label: '/', path: '/', kind: 'root' }];
  return [first, ...(await windowsDrives(home)).map((d): FolderStart => ({ label: d.slice(0, 2), path: d, kind: 'drive' }))];
}

// ───────────────────────── reading one directory ─────────────────────────

interface Entry { readonly name: string; readonly directory: boolean; readonly link: boolean }

/** Every directory and link of `dir`, by name; files are dropped here. One call, whatever the number of entries. */
async function readEntries(dir: string): Promise<Entry[]> {
  const all = await readdir(dir, { withFileTypes: true });
  return all.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => ({ name: e.name, directory: e.isDirectory(), link: e.isSymbolicLink() }));
}

/**
 * The names in `dir` that carry Windows' hidden attribute, lower-cased. Node does not report the attribute, so the
 * system's own `dir` is asked, once per listing and for a short time only; it is given no path to read wrongly (it runs
 * in the directory), and what it prints is read as UTF-16. No answer means no folder is taken for hidden.
 */
function windowsHidden(dir: string): Promise<Set<string>> {
  if (!WIN || dir.startsWith('\\\\')) return Promise.resolve(new Set());   // cmd does not run in a network path
  return new Promise((resolvePromise) => {
    execFile(process.env.ComSpec ?? 'cmd.exe', ['/d', '/u', '/c', 'dir', '/b', '/a:dh'], { cwd: dir, encoding: 'buffer', timeout: 1500, windowsHide: true }, (_error, stdout) => {
      const text = Buffer.isBuffer(stdout) ? stdout.toString('utf16le') : '';
      resolvePromise(new Set(text.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean)));
    });
  });
}

/** Run `work` on each item, a few at a time, until `until` (a clock time) has passed; what was not reached stays undefined. */
async function eachUntil<T, R>(items: readonly T[], until: number, work: (item: T) => Promise<R>): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  const lane = async (): Promise<void> => {
    for (let i = next++; i < items.length && Date.now() < until; i = next++) out[i] = await work(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(24, items.length) }, lane));
  return out;
}

const hasGit = (dir: string): Promise<boolean> => lstat(join(dir, '.git')).then(() => true, () => false);
const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const parentOf = (path: string): string | null => { const up = dirname(path); return up === path ? null : up; };
const nameOf = (path: string): string => basename(path) || path;

function whyNot(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code ?? '';
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'There is no such folder.';
  if (code === 'EACCES' || code === 'EPERM') return 'This folder cannot be read: access to it is denied.';
  if (code === 'ELOOP') return 'This folder cannot be read: it is a link that leads back to itself.';
  return `This folder cannot be read${code ? ` (${code})` : ''}.`;
}

/** Drives (by their root, as a comparison key) that were asked something and have not answered within the limit. */
const notAnswering = new Set<string>();
const SLOW = Symbol('slow');

/** `work`, or `SLOW` after `ms`. A drive that was too slow is remembered until its answer does come, however late. */
function within<T>(root: string, ms: number, work: Promise<T>): Promise<T | typeof SLOW> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { notAnswering.add(root); resolvePromise(SLOW); }, ms);
    work.then((v) => { clearTimeout(timer); notAnswering.delete(root); resolvePromise(v); }, (e) => { clearTimeout(timer); notAnswering.delete(root); reject(e); });
  });
}

export async function listFolders(request: FolderRequest, options: FolderOptions = {}): Promise<FolderListing> {
  const home = normalizePath(options.home ?? homedir());
  const asked = wholePath(request.path?.trim() ? request.path : home, home);
  if (asked === null) throw new HttpError(400, WIN ? 'Give the whole path of a folder, with its drive: D:\\projects' : 'Give the whole path of a folder, from /');
  const starts = await quickStarts(home);
  const addedKeys = new Set((request.added ?? []).slice(0, 200).map((a) => wholePath(a, home)).filter((a): a is string => a !== null).map(pathKey));
  const empty = (path: string, error: string): FolderListing => ({ path, name: nameOf(path), parent: parentOf(path), sep, repository: false, added: addedKeys.has(pathKey(path)), folders: [], more: 0, hidden: 0, error, starts });

  const root = pathKey(parse(asked).root);
  const rootName = parse(asked).root;
  if (notAnswering.has(root)) return empty(asked, `${rootName} has not answered yet. It may be a network drive that is not connected.`);
  const answerMs = options.answerMs ?? ANSWER_MS;
  const listing = await within(root, answerMs, read(asked, request, options, addedKeys, empty));
  if (listing === SLOW) return empty(asked, `${rootName} did not answer within ${Math.round(answerMs / 1000)} seconds. It may be a network drive that is not connected.`);
  return { ...listing, starts };
}

async function read(asked: string, request: FolderRequest, options: FolderOptions, addedKeys: ReadonlySet<string>, empty: (path: string, error: string) => FolderListing): Promise<FolderListing> {
  // Asked first, and not by a call that would hold the whole process: only a directory that answers is spelled out.
  try {
    if (!(await stat(asked)).isDirectory()) return empty(asked, 'This is a file, not a folder.');
  } catch (e) { return empty(asked, whyNot(e)); }
  const path = canonicalPath(asked);
  let entries: Entry[];
  let hiddenNames: Set<string>;
  try { [entries, hiddenNames] = await Promise.all([(options.readEntries ?? readEntries)(path), windowsHidden(path)]); } catch (e) { return empty(path, whyNot(e)); }

  const until = Date.now() + (options.marksMs ?? MARKS_MS);
  // A link is listed when it leads to a directory. One that leads nowhere, to a file, or round in a circle is not.
  const links = entries.filter((e) => e.link);
  const led = await eachUntil(links, until, (e) => stat(join(path, e.name)).then((s) => s.isDirectory(), () => false));
  const unfollowed = led.filter((v) => v === undefined).length;
  const leads = new Map(links.map((e, i) => [e.name, led[i]]));
  const all = entries.filter((e) => e.directory || leads.get(e.name) === true)
    .map((e) => ({ name: e.name, link: e.link, hidden: e.name.startsWith('.') || hiddenNames.has(e.name.toLowerCase()) }))
    .sort((a, b) => byName.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const wanted = request.hidden ? all : all.filter((e) => !e.hidden);
  const shown = wanted.slice(0, options.shown ?? SHOWN);
  const marks = await eachUntil(shown, until, (e) => hasGit(join(path, e.name)));
  const folders = shown.map((e, i): FolderEntry => {
    const full = join(path, e.name);
    return { name: e.name, path: full, repository: marks[i] === true, hidden: e.hidden, link: e.link, added: addedKeys.has(pathKey(full)) };
  });
  return {
    path, name: nameOf(path), parent: parentOf(path), sep, repository: await hasGit(path), added: addedKeys.has(pathKey(path)),
    folders, more: wanted.length - shown.length + unfollowed, hidden: all.filter((e) => e.hidden).length, error: null, starts: [],
  };
}

export function registerFolderRoutes(http: HttpApp): void {
  http.route('GET', '/api/folders', ({ query }) => listFolders({ path: query.get('path'), hidden: query.get('hidden') === '1', added: query.getAll('added') }));
}
