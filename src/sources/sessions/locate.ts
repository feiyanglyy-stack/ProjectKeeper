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
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import type { SessionHost } from '../../model/vocab.ts';
import { claudeProjectDirName, normalizePath, pathKey } from '../../util/paths.ts';

export interface LocatedSession {
  readonly host: SessionHost;
  readonly file: string;
  readonly cwd: string | null;
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

/** Claude Code sessions for the given working directories (exact directory match). */
export function locateClaudeSessions(cwds: readonly string[], home = homedir()): LocatedSession[] {
  const root = claudeProjectsRoot(home);
  if (!existsSync(root)) return [];
  const wanted = new Map<string, string>();
  for (const cwd of cwds) wanted.set(claudeProjectDirName(cwd).toLowerCase(), normalizePath(cwd));
  const out: LocatedSession[] = [];
  for (const dir of readdirSync(root)) {
    const cwd = wanted.get(dir.toLowerCase());
    if (!cwd) continue;
    const full = join(root, dir);
    let entries: string[] = [];
    try { entries = readdirSync(full); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(full, name);
      let st;
      try { st = statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      const info = peek(file);
      out.push({
        host: 'claude', file, cwd: info.cwd ?? cwd, sessionId: name.slice(0, -'.jsonl'.length),
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

/** Codex sessions (every home) whose recorded cwd is one of the given directories. */
export function locateCodexSessions(cwds: readonly string[], home = homedir()): LocatedSession[] {
  const wanted = new Set(cwds.map((c) => pathKey(c)));
  const out: LocatedSession[] = [];
  for (const root of codexSessionRoots(home)) {
    const files: string[] = [];
    walkJsonl(root, 0, files);
    for (const file of files) {
      const info = readCodexSessionHeader(file);
      if (!info || !wanted.has(pathKey(info.cwd))) continue;
      let st;
      try { st = statSync(file); } catch { continue; }
      const stem = file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '');
      out.push({
        host: 'codex', file, cwd: normalizePath(info.cwd),
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
