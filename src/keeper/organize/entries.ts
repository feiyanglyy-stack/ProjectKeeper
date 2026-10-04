/**
 * The entries of a decision record, a plan, a task index or an execution arrangement, as the program counts them (CJ;
 * CKC-23 AC-21: every heading of a decision record becomes a `Decision`, named as the document names it). The ledger's
 * numbering (numbering.ts) already knows every number a document defines at an entry position — a heading, a bold entry
 * line (`**D1 · …**`), a table's first column; this module says which of those are the document's own entries and what
 * each entry is called there.
 *
 * - A heading that defines a number is an entry.
 * - A bold line or a table row that defines a number is an entry, except when it stands in the section of a numbered
 *   heading of another family: `**P1 · …**` under `### E73`, or the `| S3 |` rows under `### P1 · …`, are points of that
 *   entry, not entries of the document. (A bold line of the same family is the same numbering: `**E50 补充 · …**` under
 *   `### E50` is E50's supplement.)
 * - A number defined more than once in the document is one entry: the first definition names it, and the others —
 *   `**D100 补（2026-09-30）**`, `**D100 补二**` — are folded into it (its supplements), carried by its item.
 * - An entry's name is its number and its title as written: the heading's words, the bold words (and, when the bold holds
 *   only the number, the words right after it), a table row's first cell with words.
 */
import { definitionsInText, familyOf, type Definition } from '../../ledger/numbering.ts';

export interface EntryDef {
  readonly num: string;
  readonly position: Definition['position'];
  readonly line: number;
}

/** A Markdown heading of a text, outside code fences, with its 1-based line. */
export interface HeadingLine { readonly level: number; readonly line: number }

export function headingLines(lines: readonly string[]): HeadingLine[] {
  const out: HeadingLine[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (fence) return;
    const m = /^\s{0,3}(#{1,6})\s+/.exec(l);
    if (m) out.push({ level: m[1]!.length, line: i + 1 });
  });
  return out;
}

const familyName = (num: string): string => familyOf(num)?.family ?? num;

/**
 * The definitions that are the document's own entries (see the module comment): headings always; a bold line or table row
 * unless the nearest heading above it defines a number of another family. `lines` is the document as it stands; without
 * it (the file is not on disk), every definition counts.
 */
export function entryDefinitions<T extends EntryDef>(defs: readonly T[], lines: readonly string[] | null): T[] {
  if (!lines) return [...defs];
  const headings = headingLines(lines);
  const numberedHeading = new Map<number, string>();
  for (const d of defs) if (d.position === 'heading') numberedHeading.set(d.line, familyName(d.num));
  return defs.filter((d) => {
    if (d.position === 'heading') return true;
    if (d.position !== 'bold entry' && d.position !== 'table first column') return true;
    let above: HeadingLine | null = null;
    for (const h of headings) { if (h.line >= d.line) break; above = h; }
    if (!above) return true;
    const family = numberedHeading.get(above.line);
    return family === undefined || family === familyName(d.num);
  });
}

/** One entry of a document: its number, the line that defines it, its name as written, and the lines folded into it. */
export interface Entry {
  readonly num: string;
  readonly position: Definition['position'];
  readonly line: number;
  /** The number and its title as written (`D1 · 做成通用产品…`), or the number alone when the line has no words. */
  readonly name: string;
  /** Whether the defining line gives a title besides the number. */
  readonly titled: boolean;
  /** Later definitions of the same number in the document (its supplements), by line. */
  readonly folded: readonly number[];
  /** Each supplement's lines: from its definition to where its text ends. */
  readonly foldedRanges: readonly { readonly line: number; readonly endLine: number }[];
  /** The last line of its text: up to the next entry of another number, or a heading at or above its own level. */
  readonly endLine: number;
}

const plain = (s: string): string => s
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/\*\*|__|`/g, '')
  .replace(/\\\|/g, '|')
  .replace(/\s+/g, ' ')
  .trim();
/** Words in a string (letters or digits of any script), after the number and the punctuation are taken away. */
const hasWords = (s: string): boolean => /[\p{L}]/u.test(s);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DATE_CELL = /^\s*\d{4}-\d{2}-\d{2}(?:[ T][\d:]+)?\s*$/;

/** What the defining line calls the entry: its number and its title as written; the title is '' when the line has none. */
export function entryTitle(lineText: string, num: string, position: Definition['position']): { name: string; title: string } {
  const numRe = new RegExp(`^[\\s\\[(（]*${escapeRe(num)}(?![A-Za-z0-9_])[\\])）]*\\s*[·:：.、—–-]*\\s*`);
  const clean = (s: string) => plain(s).replace(numRe, '').replace(/^[\s·:：、—–-]+/, '').replace(/[\s:：]+$/, '').trim();
  let title = '';
  if (position === 'heading') {
    title = clean(lineText.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').replace(/^(?:\d+(?:\.\d+)*[.、]?\s+|第[^\s]{1,4}[轮节章部分]\s*[·:：]?\s*)/, ''));
  } else if (position === 'bold entry') {
    const body = lineText.replace(/^\s{0,3}(?:[-*+]\s+|\d{1,3}[.)]\s+)?/, '');
    const m = /^\*\*(.+?)\*\*(.*)$/.exec(body);
    const bold = m ? clean(m[1]!) : clean(body);
    // A bold that holds the number only (`**P5**（…）`): its title is the words right after it, to the end of the clause.
    title = bold || (m ? clean(m[2]!).split(/[。；;]/)[0]!.trim() : '');
  } else if (position === 'table first column') {
    const cells = lineText.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((c) => plain(c));
    const rest = cells.slice(1).find((c) => hasWords(c) && !DATE_CELL.test(c)) ?? '';
    title = clean(cells[0] ?? '') || rest;
  } else {
    title = clean(lineText);
  }
  title = title.replace(/\s+/g, ' ').trim();
  if (!hasWords(title)) return { name: num, title: '' };
  return { name: `${num} · ${title}`, title };
}

/**
 * A document's entries (see the module comment), read from its text by the ledger's own rules (`definitionsInText`):
 * one per number, in order. `families`, when given, keeps the entries of those families only (`D<n>`, `two letters`).
 */
export function entriesOf(text: string, opts: { readonly positions?: readonly Definition['position'][]; readonly families?: readonly string[] } = {}): Entry[] {
  const lines = text.split(/\r?\n/);
  const all = definitionsInText(text).filter((d) => d.position === 'heading' || d.position === 'bold entry' || d.position === 'table first column');
  const own = entryDefinitions(all.map((d) => ({ ...d, line: d.line ?? 0 })), lines)
    .filter((d) => !opts.positions || opts.positions.includes(d.position))
    .filter((d) => !opts.families || opts.families.includes(d.family) || opts.families.includes(d.num.replace(/\d+$/, '')));
  const headings = headingLines(lines);
  const levelAt = new Map(headings.map((h) => [h.line, h.level]));
  const byNum = new Map<string, (typeof own)[number][]>();
  for (const d of own) byNum.set(d.num, [...(byNum.get(d.num) ?? []), d]);
  const sorted = [...own].sort((a, b) => a.line - b.line);
  /** Where the text that starts at a definition ends: before the next definition of another number, or a heading at or above its own level. */
  const endOf = (d: (typeof own)[number]): number => {
    const nextEntry = sorted.find((x) => x.line > d.line && x.num !== d.num);
    const ownLevel = levelAt.get(d.line) ?? 7;
    const nextHeading = headings.find((h) => h.line > d.line && h.level <= ownLevel && !byNum.get(d.num)!.some((x) => x.line === h.line));
    return Math.max(d.line, Math.min(nextEntry ? nextEntry.line - 1 : lines.length, nextHeading ? nextHeading.line - 1 : lines.length));
  };
  const firsts = [...byNum.values()].map((ds) => ds[0]!).sort((a, b) => a.line - b.line);
  return firsts.map((d) => {
    const { name, title } = entryTitle(lines[d.line - 1] ?? '', d.num, d.position);
    // A later definition of the same number, wherever it stands, is this entry's supplement.
    const folded = byNum.get(d.num)!.slice(1).map((x) => ({ line: x.line, endLine: endOf(x) }));
    return { num: d.num, position: d.position, line: d.line, name, titled: title !== '', folded: folded.map((f) => f.line), foldedRanges: folded, endLine: endOf(d) };
  });
}

/** The name is the number alone (`D1`, `[E50]`, `AP:`), with no title. */
export function isNumberOnly(name: string): boolean {
  const n = plain(name).replace(/^[\s[(（]+|[\s\])）.:：·、—–-]+$/g, '');
  return n !== '' && familyOf(n.toUpperCase()) !== null && n === n.toUpperCase() && !/\s/.test(n);
}
