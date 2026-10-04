/**
 * Absence claims carry what was read, and a lane's Unsure stays unsure (CN, E152; Spec §2.12 没有痕迹，要读过才算, §3.3 抽查).
 *
 * The spot-check of the CM run found 3 wrong out of 29, all three absence or list claims written at the synthesis, none
 * a fill error. Two notes stated as fact what a lane had marked Unsure: after the owner's D1 question 「底稿里未见后续回答」
 * — the lane had not read the sessions after 09-30, and the fix shipped that evening. One cited a source that does not
 * hold what it was cited for.
 *
 * - **An absence claim** is a note, or a six-things judgement of "dropped along the way" (3) or "let pass" (5), that says
 *   something has no follow-up, was let pass, or was taken up by nobody (`ABSENCE_WORDS`: the kinds the spot-check checks
 *   in full). It carries `looked`: where it was looked for, and up to when — the idea of `pk_record_looked` for
 *   breakpoint candidates. The writers refuse the claim without it (tools.ts `pk_write_note`, clerk-tools.ts `pk_tag_six`).
 * - **A look that does not reach the present says so in the claim's text.** The present is the ledger's: its newest
 *   session message when sessions were read (`sessionsUpTo`), its newest commit otherwise (`upTo`). A claim whose look
 *   stops earlier is stamped `As far as read — …` on the line everyone reads, so it reads "as far as … read", never a
 *   bare "no follow-up" (`stampAsFarAs`).
 * - **The lanes' Unsure items** are listed for the synthesis job (D103: in its task) and for the spot-check
 *   (`laneUnsure`, `unsureBlock`): each is read to settle it, or written as unsure; never restated as fact.
 *
 * The program reads and compares; whether something was handled is the model's judgement.
 */
import { Ledger } from '../../ledger/index.ts';
import type { AbsenceLooked, ClerkRound, RoundDoc } from '../../model/k-types.ts';

export type { AbsenceLooked } from '../../model/k-types.ts';
import type { ProjectStore } from '../../store/project-store.ts';

// ───────────────────────── which text is an absence claim ─────────────────────────

/**
 * Words that say something has no follow-up, was let pass, or was taken up by nobody. Narrower than the claim words the
 * program lists later mentions for (process/claim-check.ts `CLAIM_WORDS`): "still open" and "open items" state what a
 * report says, not that nothing came after.
 */
export const ABSENCE_WORDS = new RegExp([
  '[无没未][^。，,；;\\n]{0,4}(?:处置|处理|跟进|下文|后续|修复?|接手?|回应|回答|答复|落实)',
  '无人|没人|没有人|放过去|放过了|被放过|不了了之|石沉大海',
  '\\blet pass\\b|\\bnobody\\b|\\bno one\\b|\\bnot (?:handled|fixed|addressed|followed up|re-?checked|picked up|taken up|answered)\\b|\\bunhandled\\b|\\bunanswered\\b',
  '\\b(?:no|without) (?:follow-?up|disposition|handling|successor|answer|reply|later (?:ticket|commit|record|answer))\\b|\\bnever (?:handled|fixed|followed up|picked up|addressed|answered|taken up)\\b',
  '\\bdropped along the way\\b',
].join('|'), 'i');

/** The lines of a text that claim an absence. */
export function absenceClaims(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && ABSENCE_WORDS.test(l));
}

/** The six things whose judgement is an absence claim: dropped along the way (3), let pass (5). */
export const ABSENCE_THINGS: readonly number[] = [3, 5];

// ───────────────────────── what was read ─────────────────────────

/** The newest session message and the newest commit the ledger holds (ISO times), or null where it holds none. */
export interface LedgerPresent {
  readonly sessions: string | null;
  readonly commits: string | null;
}

export function ledgerPresent(ledger: Ledger | null): LedgerPresent {
  if (!ledger) return { sessions: null, commits: null };
  const one = (sql: string): string | null => { try { return ((ledger.db.prepare(sql).get() as { t: string | null } | undefined)?.t) ?? null; } catch { return null; } };
  return {
    sessions: one('SELECT max(coalesce(ended_at, started_at)) AS t FROM sessions WHERE missing = 0 AND messages > 0'),
    commits: one('SELECT max(committer_at) AS t FROM commits'),
  };
}

/** The ledger's present for a store; nothing when the project has no ledger yet. */
export function presentOf(store: ProjectStore): LedgerPresent {
  let ledger: Ledger | null = null;
  try { ledger = Ledger.openDir(store.dir); } catch { ledger = null; }
  try { return ledgerPresent(ledger); } finally { ledger?.close(); }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** A date or a date-time as milliseconds; a date alone reaches to the end of that day. Null when it is neither. */
function reachMs(value: string): number | null {
  const v = value.trim();
  const ms = Date.parse(DATE_ONLY.test(v) ? `${v}T23:59:59.999Z` : v);
  return Number.isNaN(ms) ? null : ms;
}
/** How much later the ledger's newest entry may be and the look still reaches it: the minute the reading took. */
const REACH_SLACK_MS = 5 * 60_000;
const short = (iso: string): string => (DATE_ONLY.test(iso.trim()) ? iso.trim() : new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + 'Z');

/** What lies beyond a look, in words, or null when it reaches the ledger's present. */
export function behindOf(looked: Pick<AbsenceLooked, 'upTo' | 'sessionsUpTo'>, present: LedgerPresent): string | null {
  const parts: string[] = [];
  const check = (read: string | null | undefined, newest: string | null, what: string) => {
    if (!read || !newest) return;
    const a = reachMs(read), b = reachMs(newest);
    if (a === null || b === null || a + REACH_SLACK_MS >= b) return;
    parts.push(`${what} to ${short(read)}; the ledger has ${what} to ${short(newest)}`);
  };
  check(looked.sessionsUpTo, present.sessions, 'sessions');
  check(looked.upTo, present.commits, 'commits');
  return parts.length ? parts.join(' · ') : null;
}

/** `where` names sessions (a session id, the word) although no `sessionsUpTo` says how far they were read. */
const NAMES_SESSIONS = /\bsessions?\b|会话|底稿|\bdrafts?\b|\btranscripts?\b/i;

/**
 * `looked` as a call gives it — `{ where, upTo, sessionsUpTo? }` — checked; a string says what is wrong with it.
 */
export function parseLooked(raw: unknown): { where: string[]; upTo: string; sessionsUpTo: string | null } | string {
  const p = (raw ?? {}) as Record<string, unknown>;
  const where = [...new Set((Array.isArray(p.where) ? p.where : []).filter((w): w is string => typeof w === 'string').map((w) => w.trim()).filter(Boolean))];
  if (!where.length) return 'looked.where: each place you read for what came after (a file with its section or lines, a ledger query, a commit range, a session), so the spot-check can read it again.';
  const upTo = typeof p.upTo === 'string' ? p.upTo.trim() : '';
  if (!upTo || reachMs(upTo) === null) return 'looked.upTo: up to when your reading reaches — the date or time (2026-09-30, or 2026-09-30T19:53Z) of the newest commit, document version or report you read; a file read as it stands now reaches today.';
  const sessionsUpTo = typeof p.sessionsUpTo === 'string' && p.sessionsUpTo.trim() ? p.sessionsUpTo.trim() : null;
  if (sessionsUpTo && reachMs(sessionsUpTo) === null) return 'looked.sessionsUpTo: the time of the last session message you read (2026-09-30T19:53Z).';
  if (!sessionsUpTo && where.some((w) => NAMES_SESSIONS.test(w))) return 'looked.where names sessions: give looked.sessionsUpTo, the time of the last session message you read, so the claim says how far the sessions were read.';
  return { where, upTo, sessionsUpTo };
}

/** `looked` as it is kept: what the call gave, who looked and when, and what the ledger holds beyond it. */
export function lookedRecord(given: { where: string[]; upTo: string; sessionsUpTo: string | null }, present: LedgerPresent, by: { readonly roundId: string | null; readonly jobId: string | null; readonly at: string }): AbsenceLooked {
  return { where: given.where, upTo: given.upTo, ...(given.sessionsUpTo ? { sessionsUpTo: given.sessionsUpTo } : {}), roundId: by.roundId, jobId: by.jobId, at: by.at, behind: behindOf(given, present) };
}

/** The refusal of a writer given an absence claim with no `looked`. */
export function absenceRefusal(what: string, claims: readonly string[]): string {
  const quoted = claims.slice(0, 2).map((c) => `“${c.length > 120 ? `${c.slice(0, 119)}…` : c}”`).join(', ');
  return `${what} says something has no follow-up, was let pass or was taken up by nobody${quoted ? ` (${quoted})` : ''}. Such a claim carries what was read: give looked: { where: [each place you read for what came after], upTo: the date or time your reading reaches, sessionsUpTo: the time of the last session message you read, when sessions were read }. A lane’s Unsure you did not settle by reading is written as unsure, not as a finding. Nothing was written.`;
}

// ───────────────────────── as far as read ─────────────────────────

/** The words a claim opens with when its look does not reach the ledger's present. */
export const AS_FAR_AS = 'As far as read';
const STAMP = /^\[As far as read — [^\]]*\]\s*/;

/**
 * The claim's line with what its look leaves unread written in front — `[As far as read — sessions to …; the ledger has
 * sessions to …] …` — or without it when the look reaches the present (an earlier stamp is taken off).
 */
export function stampAsFarAs(text: string, looked: Pick<AbsenceLooked, 'behind'> | null | undefined): string {
  const bare = text.replace(STAMP, '');
  return looked?.behind ? `[${AS_FAR_AS} — ${looked.behind}] ${bare}` : bare;
}

/** `looked` in one line, for the spot-check's list and a tool's answer. */
export function lookedLine(l: AbsenceLooked): string {
  return `looked in ${l.where.join('; ')} · up to ${short(l.upTo)}${l.sessionsUpTo ? ` · sessions to ${short(l.sessionsUpTo)}` : ''}${l.behind ? ` · does not reach the present (${l.behind})` : ''}`;
}

/**
 * The absence claims this round wrote, each with what was read, for the spot-check (the list `pk_record_looked` gives it
 * for breakpoint candidates): it reads past where each look stopped.
 */
export function absenceLookedBlock(store: ProjectStore, round: Pick<ClerkRound, 'id'>): string {
  const lines: string[] = [];
  for (const n of store.notes.filter((x) => x.looked?.roundId === round.id && x.status === 'Current')) lines.push(`- note ${n.id} “${n.versions[n.versions.length - 1]?.title ?? ''}”: ${lookedLine(n.looked!)}`);
  for (const m of store.marks.filter((x) => x.looked?.roundId === round.id && !x.closed)) lines.push(`- mark ${m.id} (${m.kind} on ${m.targetId}): ${lookedLine(m.looked!)}`);
  for (const s of store.sendbacks.filter((x) => x.looked?.roundId === round.id)) lines.push(`- send-back ${s.id} (to ${s.to}): ${lookedLine(s.looked!)}`);
  const head = `=== Absence claims this round wrote, with what was read (${lines.length}): read past where each look stopped — the later sessions, commits and tickets — before you call one Right`;
  return lines.length ? [head, ...lines].join('\n') : `${head}\nNone carries a look: a "no follow-up", "let pass" or "nobody took it up" in a document of this round has to be checked from the start.`;
}

// ───────────────────────── the lanes' Unsure ─────────────────────────

export interface UnsureItem {
  /** The lane whose report says it, and the report. */
  readonly lane: string;
  readonly reportId: string;
  /** The line of the report it starts on. */
  readonly line: number;
  readonly text: string;
}

const UNSURE_WORD = /unsure|不确定|拿不准|没把握/i;
const HEADING = /^(#{1,6})\s+(.*)$/;
/** Another part of a report named in the same heading or label: where the Unsure part ends. */
const OTHER_PART = /looked for|not found|not read|proposed|找过|没找到|没读|未读|提议/i;
/** A bold label at the start of a line or bullet: `**Unsure**：…`, `- **Looked for, not found**: …`. */
const LABEL = /^\s*(?:[-*+]\s+)?\*\*\s*([^*]{1,60}?)\s*\*\*\s*[:：]?\s*(.*)$/;
const ENUM = /[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/;
const NOTHING = /^(?:无|没有|none|nothing|n\/a|—|-)[。.\s]*$/i;
const tidy = (s: string): string => s.replace(/^\s*(?:[-*+]|\d{1,2}[.)、])\s+/, '').replace(/\s+/g, ' ').trim();

/** One run of an Unsure part into its items: by its circled numbers when it counts them, else as it stands. */
function itemsOf(text: string): string[] {
  const t = tidy(text);
  if (!t || NOTHING.test(t)) return [];
  // Counted ①②③: one item each. A lone circled number is a pointer to a section of the report, not a count.
  if (!(t.includes('①') && t.includes('②'))) return [t];
  return t.split(/(?=[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])/).map((x) => x.trim().replace(/[；;。]\s*$/, '')).filter((x) => ENUM.test(x.slice(0, 1)));
}

/**
 * The Unsure items of a lane report (the skills' Report format ends with **Unsure**): what stands under a heading that
 * says Unsure — the whole section when the heading names nothing else, the part labelled Unsure when it names other
 * parts too (`## Unsure / Looked for, not found`) — and a bold `**Unsure**` label anywhere, with what follows it up to
 * the next label, bullet of the same list, blank line or heading. A list counted ①②③ is one item each.
 */
export function unsureIn(markdown: string): { line: number; text: string }[] {
  const lines = markdown.split(/\r?\n/);
  const out: { line: number; text: string }[] = [];
  const seen = new Set<number>();
  const push = (line: number, text: string) => { for (const t of itemsOf(text)) out.push({ line, text: t }); };
  /** A labelled part: from its label's line to the next label, heading or blank line. */
  const labelled = (i: number, rest: string): number => {
    const parts = [rest];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (!l.trim() || HEADING.test(l) || LABEL.test(l)) break;
      parts.push(l);
    }
    for (let k = i; k < j; k++) seen.add(k);
    // Bullets under the label are items of their own; a run of plain lines is one.
    const bullets = parts.slice(1).filter((l) => /^\s*(?:[-*+]|\d{1,2}[.)、])\s+/.test(l));
    if (bullets.length && bullets.length === parts.length - 1) { if (parts[0]!.trim()) push(i + 1, parts[0]!); bullets.forEach((b, k) => push(i + 2 + k, b)); } else push(i + 1, parts.join(' '));
    return j;
  };
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i]!);
    if (h && UNSURE_WORD.test(h[2]!)) {
      const level = h[1]!.length;
      let end = i + 1;
      while (end < lines.length && !(HEADING.test(lines[end]!) && HEADING.exec(lines[end]!)![1]!.length <= level)) end++;
      const mixed = OTHER_PART.test(h[2]!);
      for (let j = i + 1; j < end; j++) {
        const l = lines[j]!;
        if (seen.has(j) || !l.trim()) continue;
        const label = LABEL.exec(l);
        if (label) { if (UNSURE_WORD.test(label[1]!)) j = labelled(j, label[2]!) - 1; else { seen.add(j); if (mixed) { let k = j + 1; while (k < end && lines[k]!.trim() && !LABEL.test(lines[k]!) && !HEADING.test(lines[k]!)) seen.add(k++); j = k - 1; } } continue; }
        if (mixed) continue;   // a mixed section's unlabelled lines belong to no part the program can tell
        seen.add(j);
        // A bullet with its continuation lines is one item.
        const parts = [l];
        while (j + 1 < end && lines[j + 1]!.trim() && !/^\s*(?:[-*+]|\d{1,2}[.)、])\s+/.test(lines[j + 1]!) && !LABEL.test(lines[j + 1]!) && !HEADING.test(lines[j + 1]!)) { j++; seen.add(j); parts.push(lines[j]!); }
        push(j - parts.length + 2, parts.join(' '));
      }
      i = end - 1;
      continue;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (seen.has(i)) continue;
    const label = LABEL.exec(lines[i]!);
    if (label && UNSURE_WORD.test(label[1]!)) i = labelled(i, label[2]!) - 1;
  }
  return out.sort((a, b) => a.line - b.line);
}

/** The Unsure items of this round's lane reports, by lane, in the order written. */
export function laneUnsure(store: ProjectStore, round: Pick<ClerkRound, 'id'>): UnsureItem[] {
  const reports: RoundDoc[] = store.roundDocs.filter((d) => d.roundId === round.id && d.kind === 'Report').sort((a, b) => a.at.localeCompare(b.at));
  return reports.flatMap((d) => unsureIn(d.markdown).map((u) => ({ lane: d.path ?? d.title, reportId: d.id, line: u.line, text: u.text })));
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The block the synthesis job gets in its task (D103), and the spot-check with its targets. */
export function unsureBlock(store: ProjectStore, round: Pick<ClerkRound, 'id'>, opts: { readonly forStep?: 'synthesis' | 'spot-check' } = {}): string {
  const items = laneUnsure(store, round);
  const head = `=== What the lanes marked Unsure (${items.length}): each is unsure until someone reads what settles it`;
  if (!items.length) return `${head}\nNo lane report of this round has an Unsure item.`;
  const rule = opts.forStep === 'spot-check'
    ? 'A note, a send-back or the Result that states one of these as fact, without naming what was read to settle it, is Wrong as written: correct it to unsure, or settle it by reading.'
    : 'Before you write one of these into a note, a send-back or the Result: read what settles it, and say what you read (looked) — or write it as unsure, with what was not read. Never restate it as a fact.';
  return [head, rule, ...items.map((u) => `- ${u.lane} (${u.reportId}:${u.line}): ${clip(u.text, 320)}`)].join('\n');
}
