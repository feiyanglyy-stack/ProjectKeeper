/**
 * Locate native session logs that belong to a set of working directories.
 *
 * Claude Code: `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl` (the directory name is
 * the encoding of the cwd; sub-agent transcripts live in a same-named subdirectory).
 * Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; the first line (`session_meta`) carries `cwd`. More Codex
 * homes (a second account kept in `~/.codex-2`, say) are named in `PROJECTKEEPER_CODEX_HOMES`.
 *
 * Reading is by peeking at the head of each file; results are cached per file identity so a
 * rescan only touches new or changed files. Nothing here writes anywhere.
 *
 * Both hosts record the working directory in the spelling the agent ran under — through a junction or a link, a
 * `subst` drive, an 8.3 short name, another case — while the directories asked for are in the file system's own
 * (util/paths.ts `canonicalPath`). A log belongs to a directory asked for when the two are one directory by the file
 * system's judgement (`directoryKey`), not only when they are one text. For Claude Code that means looking past the
 * folder named after the directory: the head of one log in each other folder is read once for the directory it
 * records, and nothing else of it is kept.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import type { SessionHost } from '../../model/vocab.ts';
import { claudeProjectDirName, directoryKey, normalizePath, pathKey } from '../../util/paths.ts';

export interface LocatedSession {
  readonly host: SessionHost;
  readonly file: string;
  /** The working directory as the log records it, in the spelling the agent ran under; the directory asked for when a Claude Code log names none. */
  readonly cwd: string | null;
  /** The one of the directories asked for that `cwd` is — the same text, or another spelling of that directory; null when it is none of them. */
  readonly matchedCwd: string | null;
  readonly sessionId: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly isSubagent: boolean;
  readonly home: string;         // which host home it came from
}

const PEEK_BYTES = 8192;
const peekCache = new Map<string, { size: number; mtimeMs: number; cwd: string | null; sessionId: string | null; sub: boolean }>();
export interface CodexSessionHeader {
  readonly cwd: string;
  readonly sessionId: string | null;
  readonly sub: boolean;
}
const codexHeaderCache = new Map<string, { size: number; mtimeMs: number; header: CodexSessionHeader | null }>();

function peek(file: string): { cwd: string | null; sessionId: string | null; sub: boolean } {
  const st = statSync(file);
  const hit = peekCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
  let fd: number | null = null;
  let head = '';
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(PEEK_BYTES);
    const n = readSync(fd, buf, 0, PEEK_BYTES, 0);
    head = buf.subarray(0, n).toString('utf8');
  } catch {
    head = '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
  const cwdMatch = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
  const idMatch = /"session_id"\s*:\s*"([^"]+)"/.exec(head) ?? /"sessionId"\s*:\s*"([^"]+)"/.exec(head);
  let cwd: string | null = null;
  try { cwd = cwdMatch?.[1] ? (JSON.parse(`"${cwdMatch[1]}"`) as string) : null; } catch { cwd = null; }
  const sub = /"thread_source"\s*:\s*"subagent"/.test(head) || /"isSidechain"\s*:\s*true/.test(head);
  const entry = { size: st.size, mtimeMs: st.mtimeMs, cwd, sessionId: idMatch?.[1] ?? null, sub };
  peekCache.set(file, entry);
  return entry;
}

/**
 * Read only a Codex log's first record. Ownership comes from the `session_meta` header; a `cwd` appearing later in an
 * unrelated session's body is never considered. The fixed-size peek also keeps live watching from opening unrelated
 * conversation content merely because some other project changed it.
 */
export function readCodexSessionHeader(file: string): CodexSessionHeader | null {
  let st;
  try { st = statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const hit = codexHeaderCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.header;

  let fd: number | null = null;
  let head = '';
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(PEEK_BYTES);
    const n = readSync(fd, buf, 0, PEEK_BYTES, 0);
    head = buf.subarray(0, n).toString('utf8');
  } catch {
    head = '';
  } finally {
    if (fd !== null) closeSync(fd);
  }

  // Even when a very large session_meta line exceeds PEEK_BYTES, its type, id and cwd are at the front. When the
  // first line is short, cut before the body so a later cwd cannot be mistaken for the header's.
  const end = head.search(/[\r\n]/);
  const first = end >= 0 ? head.slice(0, end) : head;
  let header: CodexSessionHeader | null = null;
  if (/"type"\s*:\s*"session_meta"/.test(first)) {
    const cwdMatch = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(first);
    const idMatch = /"id"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(first)
      ?? /"session_id"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(first);
    let cwd: string | null = null;
    let sessionId: string | null = null;
    try { cwd = cwdMatch?.[1] ? (JSON.parse(`"${cwdMatch[1]}"`) as string) : null; } catch { cwd = null; }
    try { sessionId = idMatch?.[1] ? (JSON.parse(`"${idMatch[1]}"`) as string) : null; } catch { sessionId = null; }
    if (cwd) header = { cwd, sessionId, sub: /"thread_source"\s*:\s*"subagent"/.test(first) };
  }
  codexHeaderCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, header });
  return header;
}

/**
 * For a set of directories asked for: which of them a directory a log records is, or null. The text is compared first
 * (case and slashes as the system allows); a directory spelled otherwise is asked of the file system, once. Most of
 * the directories an agent's history records are gone (worktrees, mostly), and one that is gone is rarely worth
 * asking about: it cannot be another spelling of a directory that is there, and of one that is gone too only under the
 * same last name, which is compared as text either way.
 */
export function cwdMatcher(cwds: readonly string[]): (recorded: string | null) => string | null {
  const byText = new Map<string, string>();
  for (const cwd of cwds) if (!byText.has(pathKey(cwd))) byText.set(pathKey(cwd), normalizePath(cwd));
  let byDirectory: Map<string, string> | null = null;
  const goneNames = new Set<string>();
  const asked = new Map<string, string | null>();
  return (recorded) => {
    if (!recorded) return null;
    const key = pathKey(recorded);
    const text = byText.get(key);
    if (text !== undefined) return text;
    if (asked.has(key)) return asked.get(key)!;
    if (!byDirectory) {
      byDirectory = new Map();
      for (const [cwdKey, cwd] of byText) {
        if (!byDirectory.has(directoryKey(cwd))) byDirectory.set(directoryKey(cwd), cwd);
        if (!existsSync(cwd)) goneNames.add(basename(cwdKey));
      }
    }
    const worthAsking = existsSync(recorded) || goneNames.has(basename(key));
    const hit = worthAsking ? byDirectory.get(directoryKey(recorded)) ?? null : null;
    asked.set(key, hit);
    return hit;
  };
}

export function claudeProjectsRoot(home = homedir()): string {
  return join(home, '.claude', 'projects');
}

/**
 * The Codex homes under a user home: `.codex`, then every directory named in `PROJECTKEEPER_CODEX_HOMES` (separated like
 * `PATH`; a name is taken under the user home, so a frozen copy of a home is read the same way; an absolute path as it is).
 */
export function codexHomes(home = homedir(), extra = process.env.PROJECTKEEPER_CODEX_HOMES ?? ''): string[] {
  const named = extra.split(delimiter).map((d) => d.trim()).filter((d) => d !== '');
  return [...new Set([join(home, '.codex'), ...named.map((d) => resolve(home, d))])];
}

export function codexSessionRoots(home = homedir()): string[] {
  return codexHomes(home).map((d) => join(d, 'sessions')).filter((p) => existsSync(p));
}

/** How many logs of a Claude Code folder are asked which directory the folder is for, before it is passed over. */
const FOLDER_PEEKS = 8;
/** The directory each Claude Code folder is for, once one of its logs has said: a folder is named after it, so it stays. */
const folderCwdCache = new Map<string, string>();

/**
 * The directory a Claude Code folder holds the sessions of, in the spelling its logs record. The folder's name is that
 * directory's, encoded, so a log that records a directory with another name does not speak for the folder.
 */
function folderCwd(folder: string, name: string): string | null {
  const known = folderCwdCache.get(folder);
  if (known !== undefined) return known;
  let entries: string[] = [];
  try { entries = readdirSync(folder); } catch { return null; }
  for (const entry of entries.filter((e) => e.endsWith('.jsonl')).slice(0, FOLDER_PEEKS)) {
    let cwd: string | null = null;
    try { cwd = peek(join(folder, entry)).cwd; } catch { continue; }
    if (cwd && claudeProjectDirName(cwd).toLowerCase() === name.toLowerCase()) { folderCwdCache.set(folder, cwd); return cwd; }
  }
  return null;
}

/**
 * The folders under a home's `.claude/projects` that hold the sessions of the given working directories, each with
 * the directory it is for: the folder named after the directory, and any folder named after another spelling of it.
 */
export function claudeSessionFolders(cwds: readonly string[], home = homedir()): { readonly dir: string; readonly cwd: string }[] {
  const root = claudeProjectsRoot(home);
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  const named = new Map<string, string>();
  for (const cwd of cwds) named.set(claudeProjectDirName(cwd).toLowerCase(), normalizePath(cwd));
  const matched = cwdMatcher(cwds);
  const out: { dir: string; cwd: string }[] = [];
  for (const name of names) {
    const dir = join(root, name);
    const cwd = named.get(name.toLowerCase()) ?? matched(folderCwd(dir, name));
    if (cwd) out.push({ dir, cwd });
  }
  return out;
}

/** Claude Code sessions for the given working directories (the directory itself, under any spelling; not what lies in it). */
export function locateClaudeSessions(cwds: readonly string[], home = homedir()): LocatedSession[] {
  const root = claudeProjectsRoot(home);
  const matched = cwdMatcher(cwds);
  const out: LocatedSession[] = [];
  for (const { dir, cwd } of claudeSessionFolders(cwds, home)) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(dir, name);
      let st;
      try { st = statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      const info = peek(file);
      out.push({
        host: 'claude', file, cwd: info.cwd ?? cwd, matchedCwd: info.cwd ? matched(info.cwd) : cwd, sessionId: name.slice(0, -'.jsonl'.length),
        bytes: st.size, mtimeMs: st.mtimeMs, isSubagent: info.sub, home: root,
      });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function walkJsonl(dir: string, depth: number, into: string[]): void {
  if (depth > 4) return;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkJsonl(full, depth + 1, into);
    else if (name.endsWith('.jsonl')) into.push(full);
  }
}

/** Codex sessions (every home) whose recorded cwd is one of the given directories, under any spelling. */
export function locateCodexSessions(cwds: readonly string[], home = homedir()): LocatedSession[] {
  const matched = cwdMatcher(cwds);
  const out: LocatedSession[] = [];
  for (const root of codexSessionRoots(home)) {
    const files: string[] = [];
    walkJsonl(root, 0, files);
    for (const file of files) {
      const info = readCodexSessionHeader(file);
      const matchedCwd = info ? matched(info.cwd) : null;
      if (!info || !matchedCwd) continue;
      let st;
      try { st = statSync(file); } catch { continue; }
      const stem = file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '');
      out.push({
        host: 'codex', file, cwd: normalizePath(info.cwd), matchedCwd,
        sessionId: info.sessionId ?? stem.replace(/^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-/, ''),
        bytes: st.size, mtimeMs: st.mtimeMs, isSubagent: info.sub, home: root,
      });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export function locateSessions(cwds: readonly string[], home = homedir()): LocatedSession[] {
  return [...locateClaudeSessions(cwds, home), ...locateCodexSessions(cwds, home)];
}

/** Locate each cwd in its selected native home; a frozen copy never falls back to the live host's logs. */
export function locateSessionsForHomes(cwds: readonly string[], homeFor: (host: 'claude' | 'codex', cwd: string) => string): LocatedSession[] {
  const out: LocatedSession[] = [];
  for (const host of ['claude', 'codex'] as const) {
    const groups = new Map<string, { home: string; cwds: string[] }>();
    for (const cwd of cwds) {
      const home = normalizePath(homeFor(host, cwd));
      const key = pathKey(home);
      const group = groups.get(key) ?? { home, cwds: [] };
      group.cwds.push(cwd);
      groups.set(key, group);
    }
    for (const group of groups.values()) out.push(...(host === 'claude'
      ? locateClaudeSessions(group.cwds, group.home)
      : locateCodexSessions(group.cwds, group.home)));
  }
  return out;
}
