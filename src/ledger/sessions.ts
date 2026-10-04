/**
 * Sessions (Spec §1.16 row 8, §3.11; CKC-22 AC-9): every session's host and start and end; every message's speaker —
 * decided by the session's structure (`isOwnerMessage` of sources/sessions/read.ts: what the owner typed, never a tool
 * result, an injected block or a subagent's task), never guessed — and time; the owner's every message verbatim, and with
 * it, verbatim, the agent message it answered (the nearest earlier agent message with text in the same session: the owner's
 * "可以" has to be read against what it said yes to). Credential values are redacted.
 *
 * What cannot be read is listed as it is: a log that fails to parse keeps its reason; a log read before and gone now stays
 * with everything read from it, marked missing — the ledger is then the only copy of the owner's words in it (D71).
 *
 * Incremental: a log is read again only when its size or modification time changed.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { getState, hex12, putText, redact, setState, tx, deleteText } from './schema.ts';
import { locateSessionsForHomes, type LocatedSession } from '../sources/sessions/locate.ts';
import { isOwnerMessage, parseSession, type ParsedSession, type SessionMessage } from '../sources/sessions/read.ts';

export interface SessionScanInput {
  /** Working directories whose sessions belong to the project. */
  readonly cwds: readonly string[];
  /** Which native home to read for a host and directory (a copy's frozen store); the machine's home when not listed. */
  readonly homes?: readonly { readonly host: 'claude' | 'codex'; readonly cwd: string; readonly home: string }[];
}

function homeFor(input: SessionScanInput): (host: 'claude' | 'codex', cwd: string) => string {
  return (host, cwd) => input.homes?.find((h) => h.host === host && h.cwd.toLowerCase() === cwd.toLowerCase())?.home ?? homedir();
}

export interface SessionScanStats {
  readonly located: number;
  readonly read: number;
  readonly sessions: number;
  readonly messages: number;
  readonly ownerMessages: number;
  readonly unreadable: number;
  readonly missing: number;
}

export const sessionKey = (host: string, sessionId: string, file: string): string => `session:${hex12(host, sessionId, file.toLowerCase())}`;
export const messageKey = (session: string, idx: number): string => `msg:${hex12(session, idx)}`;

export type Speaker = 'owner' | 'agent' | 'subagent' | 'host';
export function speakerOf(m: SessionMessage): Speaker {
  if (isOwnerMessage(m)) return 'owner';
  if (m.sidechain) return 'subagent';
  if (m.role === 'user') return 'host';
  return 'agent';
}

/** For each owner message, the position of the agent message it answers: the nearest earlier agent message with text. */
export function answeredBy(messages: readonly SessionMessage[]): Map<number, number> {
  const out = new Map<number, number>();
  let last: number | null = null;
  for (const m of messages) {
    if (isOwnerMessage(m)) { if (last !== null) out.set(m.index, last); continue; }
    if (m.role === 'assistant' && !m.sidechain && m.text.trim()) last = m.index;
  }
  return out;
}

function ingest(db: DatabaseSync, located: LocatedSession, parsed: ParsedSession, now: string): { messages: number; owner: number } {
  const key = sessionKey(located.host, parsed.sessionId, located.file);
  const owner = parsed.messages.filter(isOwnerMessage).length;
  db.prepare(`INSERT INTO sessions (key, host, session_id, file, cwd, started_at, ended_at, messages, owner_messages, headless, subagent, bytes, mtime_ms, broken_lines, missing, unreadable, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
    ON CONFLICT(key) DO UPDATE SET cwd = excluded.cwd, started_at = excluded.started_at, ended_at = excluded.ended_at, messages = excluded.messages,
      owner_messages = excluded.owner_messages, headless = excluded.headless, subagent = excluded.subagent, bytes = excluded.bytes,
      mtime_ms = excluded.mtime_ms, broken_lines = excluded.broken_lines, missing = 0, unreadable = NULL`)
    .run(key, located.host, parsed.sessionId, located.file, parsed.cwd, parsed.startedAt, parsed.endedAt, parsed.messages.length, owner,
      parsed.headless ? 1 : 0, located.isSubagent ? 1 : 0, located.bytes, Math.round(located.mtimeMs), parsed.brokenLines, now);
  // The log only grows; a message already recorded keeps its row (and its id), a changed one is rewritten.
  const answers = answeredBy(parsed.messages);
  const kept = new Set<number>([...answers.values()]);
  const old = new Map((db.prepare('SELECT idx, key, text, at FROM session_messages WHERE session = ?').all(key) as { idx: number; key: string; text: string | null; at: string | null }[]).map((r) => [r.idx, r]));
  const ins = db.prepare(`INSERT OR REPLACE INTO session_messages (key, session, idx, role, speaker, at, text, chars, tools, answers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const present = new Set<number>();
  for (const m of parsed.messages) {
    present.add(m.index);
    const speaker = speakerOf(m);
    const keep = speaker === 'owner' || kept.has(m.index);
    const text = keep ? redact(m.text) : null;
    const mk = messageKey(key, m.index);
    const before = old.get(m.index);
    if (before && before.text === text && before.at === m.at) continue;
    ins.run(mk, key, m.index, m.role, speaker, m.at, text, [...m.text].length, m.tools.length ? JSON.stringify(m.tools.slice(0, 40).map((t) => redact(t).slice(0, 200))) : null,
      speaker === 'owner' ? answers.get(m.index) ?? null : null);
    if (speaker === 'owner') putText(db, mk, 'owner', null, m.text);
    else if (keep) putText(db, mk, 'agent', null, m.text);
    else if (before?.text) deleteText(db, mk);
  }
  // Messages the log no longer has (a rewritten log) are left as they were read.
  return { messages: parsed.messages.length, owner };
}

export function scanSessions(db: DatabaseSync, input: SessionScanInput, now: string): SessionScanStats {
  const located = input.cwds.length ? locateSessionsForHomes(input.cwds, homeFor(input)) : [];
  let read = 0;
  let unreadable = 0;
  for (const l of located) {
    let size = l.bytes;
    let mtime = l.mtimeMs;
    try { const st = statSync(l.file); size = st.size; mtime = st.mtimeMs; } catch { continue; }
    const stateKey = `session:${l.file.toLowerCase()}`;
    if (getState(db, stateKey) === `${size}:${Math.round(mtime)}`) continue;
    let parsed: ParsedSession;
    try {
      parsed = parseSession(l);
    } catch (error) {
      unreadable += 1;
      const key = sessionKey(l.host, l.sessionId, l.file);
      db.prepare(`INSERT INTO sessions (key, host, session_id, file, cwd, bytes, mtime_ms, unreadable, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET unreadable = excluded.unreadable, bytes = excluded.bytes, mtime_ms = excluded.mtime_ms`)
        .run(key, l.host, l.sessionId, l.file, l.cwd, size, Math.round(mtime), (error as Error).message.slice(0, 300), now);
      continue;
    }
    tx(db, () => {
      ingest(db, l, parsed, now);
      setState(db, stateKey, `${size}:${Math.round(mtime)}`);
    });
    read += 1;
  }
  // A log read before and gone now: kept with everything read from it, marked missing (§3.11).
  const seen = new Set(located.map((l) => l.file.toLowerCase()));
  tx(db, () => {
    for (const s of db.prepare('SELECT key, file, missing FROM sessions').all() as { key: string; file: string; missing: number }[]) {
      const gone = !seen.has(s.file.toLowerCase()) && !existsSync(s.file);
      if (gone !== (s.missing === 1)) db.prepare('UPDATE sessions SET missing = ? WHERE key = ?').run(gone ? 1 : 0, s.key);
    }
  });
  const t = db.prepare('SELECT count(*) c, ifnull(sum(messages), 0) m, ifnull(sum(owner_messages), 0) o, ifnull(sum(missing), 0) x, ifnull(sum(unreadable IS NOT NULL), 0) u FROM sessions').get() as { c: number; m: number; o: number; x: number; u: number };
  return { located: located.length, read, sessions: t.c, messages: t.m, ownerMessages: t.o, unreadable: t.u, missing: t.x };
}
