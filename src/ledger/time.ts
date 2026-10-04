/**
 * 发生的时间 (Spec §2.11; CKC-22 AC-10, AC-15): every ledger entry carries when the thing it records happened, with the
 * basis the program read it from — never a model-written date. The shape is the workbench's own (`model/k-types.ts`
 * `Occurred`), so an entry can be handed to the views and the evidence resolver as it is.
 *
 * Precision is kept as the source gives it: a date-only value stays a date (`2026-09-26`); a clock time is stored as its
 * instant in UTC (model/time.ts). When the text writes its own date beside the commit time, both are kept (`other`), so
 * a reader sees where they disagree. When nothing gives a time, the entry is `First observed` at the moment the program
 * first saw it, marked `undated`.
 *
 * Dates written in a text (`Written in text`) are read by one rule, used everywhere a line needs one (`dateContext`):
 *   1. a date written on the line itself — `2026-09-26`, `2026/9/26`, `2026年9月26日`; `09-26` and `9月26日` only when an
 *      earlier full date of the same text gives the year (and `09-26` only zero-padded, so `5-6` is never a date);
 *   2. else the stated date of the entry the line belongs to: the first `日期：…` / `date: …` / `时间：…` line of the entry
 *      (an entry begins at a Markdown heading or at a line that opens in bold, e.g. `**D83 · …**`);
 *   3. else a date written on the entry's own first line (`**D77 补（2026-09-26）**`, `### 2026-09-17 round two`);
 *   4. else the document's stated date: a `date` / `created` / `日期` field in the front matter or in the first 20 lines
 *      (a "last updated" line is not the date of what the document says, so it never counts);
 *   5. else none.
 */
import type { Occurred, OccurredBasis } from '../model/k-types.ts';
import { normalizeMaterialTime } from '../model/time.ts';

export type { Occurred, OccurredBasis };

/** The time to store: a date stays a date, a clock time becomes its UTC instant; null when it is not a time. */
export function materialTime(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return normalizeMaterialTime(raw);
}

/** Milliseconds for ordering and range filters; a date-only value orders at its UTC midnight (never displayed). */
export const msOf = (at: string | null | undefined): number | null => {
  if (!at) return null;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T00:00:00Z` : at);
  return Number.isNaN(ms) ? null : ms;
};

/** A range bound given by a caller: a date means the start of that day (since) or its end (until), in UTC. */
export function boundMs(value: string | null | undefined, end: boolean): number | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return Date.parse(`${v}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** Date-only prefix, for grouping by day. */
export const dayOf = (at: string | null | undefined): string | null => (at ? at.slice(0, 10) : null);

/**
 * A dated occurrence, with the other time the source gives kept beside it (§2.11: a date the text writes is recorded as
 * well — "正文写明日期的，另记"). Only an other time that is the very same value is left out. An other time on the same
 * day used to be dropped, which lost a text's own date whenever it named the commit's day, and compared a local date
 * with the UTC day of an instant, so a commit made just after midnight east of UTC hid a real one-day disagreement
 * (QC AY, CKC-22 AC-10). Whether the two disagree is for the reader, who sees both.
 */
export function occurred(at: string, basis: OccurredBasis, anchor: string | null, other?: { at: string; basis: OccurredBasis; anchor: string | null } | null): Occurred {
  const keepOther = other && other.at !== at ? other : null;
  return { at, basis, anchor, ...(keepOther ? { other: keepOther } : {}) };
}

/** Nothing gives a time: `Undated · first seen <at>`. */
export function undated(firstSeen: string, anchor: string | null): Occurred {
  return { at: firstSeen, basis: 'First observed', anchor, undated: true };
}

// ───────────────────────── dates written in a text ─────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');
function realDate(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const FULL = /(?<![\d.])((?:19|20)\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?![\d])/g;
const CN_FULL = /((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g;
const SHORT = /(?<![\d:./-])(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?![\d:])/g;
const CN_SHORT = /(?<![\d年])(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g;

/** The full dates written on one line, in order; with `year`, also the month-day forms. */
export function datesOnLine(line: string, year: number | null): { at: string; raw: string; index: number }[] {
  const out: { at: string; raw: string; index: number }[] = [];
  for (const m of line.matchAll(FULL)) { const at = realDate(Number(m[1]), Number(m[2]), Number(m[3])); if (at) out.push({ at, raw: m[0], index: m.index! }); }
  for (const m of line.matchAll(CN_FULL)) { const at = realDate(Number(m[1]), Number(m[2]), Number(m[3])); if (at) out.push({ at, raw: m[0], index: m.index! }); }
  if (year !== null) {
    const taken = (i: number) => out.some((o) => i >= o.index && i < o.index + o.raw.length);
    for (const m of line.matchAll(SHORT)) { if (taken(m.index!)) continue; const at = realDate(year, Number(m[1]), Number(m[2])); if (at) out.push({ at, raw: m[0], index: m.index! }); }
    for (const m of line.matchAll(CN_SHORT)) { if (taken(m.index!)) continue; const at = realDate(year, Number(m[1]), Number(m[2])); if (at) out.push({ at, raw: m[0], index: m.index! }); }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Every full date written anywhere in a text (for the import-style root rule: does the content predate the commit?). */
export function fullDatesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(FULL)) { const at = realDate(Number(m[1]), Number(m[2]), Number(m[3])); if (at) out.push(at); }
  for (const m of text.matchAll(CN_FULL)) { const at = realDate(Number(m[1]), Number(m[2]), Number(m[3])); if (at) out.push(at); }
  return out;
}

/**
 * A stated date: a `日期：` / `date:` field at the start of a line or after a separator (`编写：…。日期：2026-09-26。`).
 * "最后更新：…" / "updated: …" never counts: the separator before the word keeps `更新日期` out.
 */
const STATED = /(?:^|[\s。；;，,（(|*>])(?:日期|发生时间|时间|date|Date|DATE)\**\s*[:：]/;
const DOC_STATED = /(?:^|[\s。；;，,（(|*>])(?:日期|创建于|创建|date|Date|DATE|created(?:_at)?|Created)\**\s*[:：]/;
const ENTRY_START = (l: string): boolean => /^\s{0,3}#{1,6}\s/.test(l) || /^\s{0,3}\*\*\S/.test(l);

export interface WrittenAt {
  readonly at: string;
  /** 1-based line the date was read from. */
  readonly line: number;
  readonly how: 'line' | 'entry' | 'entry-head' | 'document';
}

export interface DateContext {
  /** The written date governing a 1-based line, by the rule above, or null. */
  at(line: number): WrittenAt | null;
  /** The document's own stated date (rule 4), or null. */
  readonly document: WrittenAt | null;
}

/** Read a text's written dates once; `at(line)` then answers in constant time. */
export function dateContext(text: string): DateContext {
  const lines = text.split(/\r?\n/);
  const n = lines.length;
  const lineDate: (WrittenAt | null)[] = new Array(n).fill(null);
  const stated: (string | null)[] = new Array(n).fill(null);
  let year: number | null = null;
  let inFence = false;
  let frontMatter = n > 0 && /^---\s*$/.test(lines[0]!);
  // The document's own date is stated in its front matter or its preamble (before the first entry below the title).
  let preamble = true;
  let document: WrittenAt | null = null;
  for (let i = 0; i < n; i++) {
    const l = lines[i]!;
    if (frontMatter && i > 0 && /^---\s*$/.test(l)) frontMatter = false;
    if (!frontMatter && ENTRY_START(l) && !/^\s{0,3}#\s/.test(l)) preamble = false;
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    const found = datesOnLine(l, year);
    if (found[0]) {
      lineDate[i] = { at: found[0].at, line: i + 1, how: 'line' };
      const full = found.find((f) => /^\d{4}/.test(f.raw));
      if (full) year = Number(full.at.slice(0, 4));
      const s = inFence ? null : STATED.exec(l);
      if (s) stated[i] = (found.find((f) => f.index >= s.index) ?? found[0]).at;
      if (!document && ((preamble && i < 20) || (frontMatter && i < 60)) && DOC_STATED.test(l)) {
        const m = DOC_STATED.exec(l)!;
        // The date the field names: the first one after the field word.
        const after = found.find((f) => f.index >= m.index) ?? found[0];
        document = { at: after.at, line: i + 1, how: 'document' };
      }
    }
  }
  // Entry blocks: the entry each line belongs to, its stated date and its head's date.
  const entryOf: number[] = new Array(n).fill(-1);
  const entryStated = new Map<number, WrittenAt>();
  let current = -1;
  inFence = false;
  for (let i = 0; i < n; i++) {
    const l = lines[i]!;
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    if (!inFence && ENTRY_START(l)) current = i;
    entryOf[i] = current;
    if (current >= 0 && stated[i] && !entryStated.has(current)) entryStated.set(current, { at: stated[i]!, line: i + 1, how: 'entry' });
  }
  return {
    document,
    at(line: number): WrittenAt | null {
      const i = Math.min(Math.max(0, Math.floor(line) - 1), n - 1);
      if (i < 0) return document;
      if (lineDate[i]) return lineDate[i];
      const e = entryOf[i]!;
      if (e >= 0) {
        const s = entryStated.get(e);
        if (s) return s;
        if (lineDate[e]) return { ...lineDate[e]!, how: 'entry-head' };
      }
      return document;
    },
  };
}
