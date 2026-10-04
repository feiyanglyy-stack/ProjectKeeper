/**
 * The owner's own words, taken out of the project's sessions by rule (Spec §3.3 "原话整理", §1.3; CKC-05 AC-13): what
 * the owner typed in Claude Code and Codex sessions, and what they said in the Keeper conversation. The rule is the
 * session parser's (read.ts `isOwnerMessage`): tool results, blocks the host or system injected, command wrappers and
 * their output, compaction summaries, subagent branches and the environment and instruction files Codex injects are
 * never the owner's. Nothing is taken out of a message: text pasted into it (another agent's report, a log) stays, and
 * where it is recognisable it is marked, so the framing round decides what the owner meant, not this code.
 *
 * Every utterance names the session source it can be cited by — the segment its message is in — and its words are in
 * that source's excerpt. Parsing is cached per log file and re-done only when the file changed.
 */
import { statSync } from 'node:fs';
import type { Source } from '../../model/types.ts';
import type { SessionHost } from '../../model/vocab.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { redactCredentials } from '../anchor.ts';
import { isOwnerMessage, parseClaudeSession, parseCodexSession } from './read.ts';

export interface PastedBlock {
  /** Character offsets into the utterance's text: `text.slice(start, end)` is the block. */
  readonly start: number;
  readonly end: number;
  /** What makes it recognisable as pasted: a code block, quoted text, a Markdown document, a table, a paste placeholder. */
  readonly clue: string;
}

export interface OwnerUtterance {
  readonly sourceId: string;
  readonly host: SessionHost;
  readonly at: string | null;
  readonly text: string;
  readonly chars: number;
  readonly pasted: readonly PastedBlock[];
  /** From a non-interactive run (`codex exec`, an SDK run of Claude Code): usually a program's or an agent's prompt. */
  readonly headless: boolean;
  /** Which session it belongs to, for the session filter: host and native log, or the Keeper conversation. */
  readonly session: string;
  readonly order: number;
}

interface Parsed { readonly size: number; readonly mtimeMs: number; readonly headless: boolean; readonly sessionId: string; readonly messages: readonly { index: number; at: string | null; text: string }[] }
const cache = new Map<string, Parsed>();

/** The owner's messages of one native log (parsed once per version of the file), or null when it cannot be read. */
function ownerMessagesOf(host: 'claude' | 'codex', file: string): Parsed | null {
  let st;
  try { st = statSync(file); } catch { return null; }
  const key = `${host}:${file}`;
  const hit = cache.get(key);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
  try {
    const parsed = host === 'codex' ? parseCodexSession(file) : parseClaudeSession(file);
    const entry: Parsed = {
      size: st.size, mtimeMs: st.mtimeMs, headless: parsed.headless === true, sessionId: parsed.sessionId,
      messages: parsed.messages.filter(isOwnerMessage).map((m) => ({ index: m.index, at: m.at, text: m.text })),
    };
    cache.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

const chars = (s: string): number => [...s].length;

/**
 * Blocks of an owner's message that are recognisably pasted: fenced code, quoted lines, a Markdown document (from a
 * heading to the last structured line after it), a table, the placeholder a host leaves for a paste it did not keep.
 * The owner's own lines around a block stay outside it; where a boundary is doubtful the block is left smaller.
 */
export function pastedBlocks(text: string): PastedBlock[] {
  const lines = text.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const l of lines) { starts.push(offset); offset += l.length + 1; }
  const plain = lines.map((l) => l.replace(/\r$/, ''));
  const endOf = (i: number) => starts[i]! + plain[i]!.length;
  const found: { from: number; to: number; clue: string }[] = [];
  const fenced = new Set<number>();
  for (let i = 0; i < plain.length; i++) {
    const open = /^\s*(`{3,}|~{3,})/.exec(plain[i]!);
    if (!open) continue;
    const mark = open[1]!.charAt(0);
    let j = i + 1;
    while (j < plain.length && !(/^\s*(`{3,}|~{3,})\s*$/.test(plain[j]!) && plain[j]!.trim().charAt(0) === mark)) j++;
    const to = Math.min(j, plain.length - 1);
    for (let k = i; k <= to; k++) fenced.add(k);
    found.push({ from: i, to, clue: 'code block' });
    i = to;
  }
  const heading = (l: string) => /^#{1,6}\s+\S/.test(l);
  const table = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const list = (l: string) => /^\s*([-*+]|\d{1,3}[.)])\s+\S/.test(l);
  const quote = (l: string) => /^\s*>/.test(l);
  const structured = (i: number) => fenced.has(i) || heading(plain[i]!) || table(plain[i]!) || list(plain[i]!) || quote(plain[i]!);
  // Quoted lines and tables on their own.
  for (const [test, clue, least] of [[quote, 'quoted text', 1], [table, 'table', 2]] as const) {
    for (let i = 0; i < plain.length; i++) {
      if (fenced.has(i) || !test(plain[i]!)) continue;
      let j = i;
      while (j + 1 < plain.length && !fenced.has(j + 1) && test(plain[j + 1]!)) j++;
      if (j - i + 1 >= least) found.push({ from: i, to: j, clue });
      i = j;
    }
  }
  // A Markdown document: from its first heading to the last structured line after it, with at least one more.
  const first = plain.findIndex((l, i) => !fenced.has(i) && heading(l));
  if (first >= 0) {
    let last = first;
    let count = 0;
    for (let i = first; i < plain.length; i++) if (structured(i)) { last = i; count++; }
    if (count >= 2) found.push({ from: first, to: last, clue: 'Markdown document' });
  }
  const blocks: { from: number; to: number; clue: string }[] = [];
  for (const b of found.sort((a, b) => a.from - b.from || b.to - a.to)) {
    const outer = blocks[blocks.length - 1];
    if (outer && b.from <= outer.to) { if (b.to > outer.to) outer.to = b.to; continue; }
    blocks.push({ ...b });
  }
  const out: PastedBlock[] = blocks.map((b) => ({ start: starts[b.from]!, end: endOf(b.to), clue: b.clue }));
  // A host that kept only a placeholder for a paste: the placeholder is marked; the pasted text is not in the log.
  for (const m of text.matchAll(/\[Pasted text #\d+(?: \+\d+ lines)?\]/g)) {
    const start = m.index!;
    if (!out.some((b) => start >= b.start && start < b.end)) out.push({ start, end: start + m[0].length, clue: 'paste placeholder (the pasted text is not in the log)' });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The owner's words in one Keeper conversation message, or null when the message is not the owner's (an execution
 * agent's query is not). Who wrote it and where the words begin are what the source records (`said`), so the heading
 * the message is shown under can change without the owner's words dropping out. A message stored before that was
 * recorded is read from its heading: "[owner <time>]", a line break, and then what was said.
 */
function ownersWords(s: Source): string | null {
  if (s.said) return s.said.by === 'owner' ? s.excerpt.slice(s.said.wordsFrom) : null;
  const m = /^\[owner [^\]\n]*\]\n([\s\S]*)$/.exec(s.excerpt);
  return m ? m[1]! : null;
}

export interface UtteranceQuery {
  readonly since?: string | null;
  /** Any source of the session, or the session's native id: the utterances of that whole session. */
  readonly sessionSourceId?: string | null;
}
export interface UtteranceSet {
  readonly utterances: readonly OwnerUtterance[];
  /** Owner messages in the logs whose segment is not read into the assets yet (they cannot be cited until it is). */
  readonly notYetRead: number;
}

/**
 * Every owner utterance of the project's sessions, oldest first. `since` keeps those at or after an ISO time or a date
 * (from its start in UTC); `sessionSourceId` keeps one session.
 */
export function ownerUtterances(store: ProjectStore, query: UtteranceQuery = {}): UtteranceSet | string {
  const sessions = store.sources.filter((s) => s.anchor.kind === 'session');
  const byFile = new Map<string, { host: 'claude' | 'codex'; file: string; ranges: { from: number; to: number; id: string }[] }>();
  const pi: Source[] = [];
  for (const s of sessions) {
    const a = s.anchor;
    if (a.kind !== 'session') continue;
    if (a.host === 'pi') { pi.push(s); continue; }
    const key = `${a.host}:${a.file}`;
    const entry = byFile.get(key) ?? { host: a.host, file: a.file, ranges: [] };
    entry.ranges.push({ from: a.messageStart, to: a.messageEnd, id: s.id });
    byFile.set(key, entry);
  }

  let wanted: string | null = null;
  const filter = (query.sessionSourceId ?? '').trim();
  if (filter) {
    const src = store.sources.get(filter);
    if (src && src.anchor.kind === 'session') wanted = src.anchor.host === 'pi' ? `pi:${src.anchor.sessionId}` : `${src.anchor.host}:${src.anchor.file}`;
    else {
      const bySessionId = sessions.find((s) => s.anchor.kind === 'session' && s.anchor.sessionId === filter);
      if (!bySessionId || bySessionId.anchor.kind !== 'session') return `${filter} is neither a session source of this project nor the id of one of its sessions. pk_list_sources with kind "session" lists them.`;
      wanted = bySessionId.anchor.host === 'pi' ? `pi:${bySessionId.anchor.sessionId}` : `${bySessionId.anchor.host}:${bySessionId.anchor.file}`;
    }
  }
  let since: string | null = null;
  const rawSince = (query.since ?? '').trim();
  if (rawSince) {
    const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(rawSince) ? `${rawSince}T00:00:00Z` : rawSince);
    if (Number.isNaN(ms)) return `since must be an ISO time or a date (2026-09-17); “${rawSince}” is neither.`;
    since = new Date(ms).toISOString();
  }

  const out: OwnerUtterance[] = [];
  let notYetRead = 0;
  let order = 0;
  const seen = new Set<string>();
  const add = (u: Omit<OwnerUtterance, 'chars' | 'pasted' | 'order'>) => {
    // A resumed or copied session repeats earlier messages with their own times: the same words at the same moment are one.
    const key = u.at ? `${u.host}|${u.at}|${u.text}` : null;
    if (key) { if (seen.has(key)) return; seen.add(key); }
    out.push({ ...u, chars: chars(u.text), pasted: pastedBlocks(u.text), order: order++ });
  };
  for (const entry of [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file))) {
    const session = `${entry.host}:${entry.file}`;
    if (wanted && wanted !== session) continue;
    const parsed = ownerMessagesOf(entry.host, entry.file);
    if (!parsed) continue;
    const ranges = [...entry.ranges].sort((a, b) => a.from - b.from);
    for (const m of parsed.messages) {
      const range = ranges.find((r) => m.index >= r.from && m.index <= r.to);
      if (!range) { notYetRead++; continue; }
      add({ sourceId: range.id, host: entry.host, at: m.at, text: redactCredentials(m.text).text, headless: parsed.headless, session });
    }
  }
  for (const s of pi.sort((a, b) => a.id.localeCompare(b.id))) {
    const a = s.anchor;
    if (a.kind !== 'session') continue;
    const session = `pi:${a.sessionId}`;
    if (wanted && wanted !== session) continue;
    const words = ownersWords(s);
    if (words === null || !words.trim()) continue;
    add({ sourceId: s.id, host: 'pi', at: a.at, text: words, headless: false, session });
  }
  const kept = out.filter((u) => !since || (u.at !== null && u.at >= since));
  kept.sort((a, b) => (a.at ?? '￿').localeCompare(b.at ?? '￿') || a.order - b.order);
  return { utterances: kept, notYetRead };
}
