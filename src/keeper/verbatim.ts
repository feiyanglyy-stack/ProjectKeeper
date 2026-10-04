/**
 * Words recorded as someone's own are the words of the sources they cite (Spec §1.3, §1.15; E80, E86): an owner
 * quote on any product-reference item, an owner's confirmation of a rule, and the project's own wording (`excerpt`)
 * of an Explicit rule. Each item has to open to what was actually said or written, and an agent that searches for
 * those words has to find them.
 *
 * How a quote is checked:
 * - It is cut into parts at every ellipsis (…, ……, ...): what the quote leaves out is marked there. Every part has to
 *   stand in the text of the sources cited — several sources cited, any of them — in the same order as the quote.
 *   Sections of one file that follow each other are one text, so a part may run across a place where ProjectKeeper cut
 *   a long section.
 * - Both sides are read the same way first. Case, spacing and line breaks, punctuation and quotation marks (Chinese or
 *   English), and the marks of Markdown — emphasis, code, headings, quotes, table bars, list bullets and numbers, link
 *   targets, escapes — make no difference; a doubled backslash counts as one (a JSON escape that leaked into the text).
 *   The slash, the backslash and %, & and @ stay: in paths, values and names they are part of the words.
 * - A word added, changed, or left out without an ellipsis makes a part that is not there.
 *
 * A part that is not there comes back with what helps to put it right: the section of the same document that holds
 * it, or where it parts from the source. That search looks only in the other sections of the files and sessions cited,
 * and only when a part is missing; a session of 200 segments (2.4 million characters) takes about 0.2 s, a part that is
 * there about a millisecond.
 *
 * The owner's messages are whole in their session sources (read.ts shows the owner's words in full and never cuts a
 * message across segments; the Keeper conversation keeps each message whole), so the sources are what the owner's words
 * are checked against — the same text pk_owner_utterances gives.
 */
import type { Source } from '../model/types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { anchorLabel } from '../sources/anchor.ts';
import { pathKey } from '../util/paths.ts';

/** Where a quote leaves words out. */
const ELLIPSIS = /(?:…|⋯|\.{3,})+/u;

/** What makes no difference between a quote and its source (see above), less what is part of the words. */
const NO_DIFFERENCE = /[\s\p{Cc}\p{Cf}\p{P}`~|>+⋯]/u;
const PART_OF_WORDS: ReadonlySet<string> = new Set(['/', '\\', '%', '&', '@']);
const noDifference = (c: string): boolean => NO_DIFFERENCE.test(c) && !PART_OF_WORDS.has(c);

/**
 * Every text is read two ways, and a quote matches when it matches either: as written, and as it reads once rendered.
 * As it reads leaves out what opens a list item at the start of a line — a number (1. 1) 1、 (1) （一） 一、) or a task
 * box, with any quote mark or bullet before it — and where a link points, so a quote that joins list items, or gives a
 * link as the words it shows, matches the text as it reads; one that keeps the numbers or the link matches it as
 * written. (Bullets and quote marks make no difference either way.)
 */
const LIST_MARKER = /^[ \t]*(?:>[ \t]*)*(?:[-*+•·][ \t]+)?(?:\d{1,3}(?:[.)][ \t]+|、[ \t]*)|[(（][\d一二三四五六七八九十]{1,3}[)）][ \t]*|[一二三四五六七八九十]{1,3}、[ \t]*)?(?:\[[ xX]\][ \t]+)?/gmu;
const LINK_TARGET = /\]\([^)\n]*\)/gu;

interface Folded {
  /** What is compared: the words, without what makes no difference, in lower case. */
  readonly text: string;
  /** Where each character of `text` stands in `original`. */
  readonly at: readonly number[];
  /** The text as read (in composed form), which `at` points into. */
  readonly original: string;
}

/** Full-width forms, ligatures and the like as their plain letters, in lower case. */
function plainForm(cp: string): string {
  const code = cp.codePointAt(0)!;
  if (code < 0x80) return code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : cp;
  if (code >= 0x4e00 && code <= 0x9fff) return cp;
  return cp.normalize('NFKC').toLowerCase();
}

function fold(raw: string, asRead: boolean): Folded {
  const original = raw.normalize('NFC');
  // What reading the text as it reads leaves out, as [start, end) spans in order.
  const skipped: [number, number][] = [];
  if (asRead) {
    for (const re of [LIST_MARKER, LINK_TARGET]) for (const m of original.matchAll(re)) if (m[0].length > 0) skipped.push([m.index!, m.index! + m[0].length]);
    skipped.sort((a, b) => a[0] - b[0]);
  }
  const chars: string[] = [];
  const from: number[] = [];
  let next = 0;
  let i = 0;
  for (const cp of original) {
    while (next < skipped.length && skipped[next]![1] <= i) next++;
    if (!(next < skipped.length && skipped[next]![0] <= i)) for (const c of plainForm(cp)) { chars.push(c); from.push(i); }
    i += cp.length;
  }
  const text: string[] = [];
  const at: number[] = [];
  for (let k = 0; k < chars.length; k++) {
    const c = chars[k]!;
    if (c === '\\') {
      // A run of backslashes counts as one (a doubled one is a JSON escape). Before a mark that makes no difference
      // (\* \_ \| \.), a space, a line break or the end, it is a Markdown escape or line break and is left out too.
      const first = k;
      while (chars[k + 1] === '\\') k++;
      const after = chars[k + 1];
      if (after === undefined || noDifference(after)) continue;
      text.push('\\');
      at.push(from[first]!);
      continue;
    }
    if (noDifference(c)) continue;
    text.push(c);
    at.push(from[k]!);
  }
  return { text: text.join(''), at, original };
}

/** Whether two quotes are the same words, read the way the check reads them. */
export function sameWords(a: string | null | undefined, b: string | null | undefined): boolean {
  return fold(a ?? '', false).text === fold(b ?? '', false).text;
}

/** The parts of a quote: what stands between its ellipses. A part that is only punctuation or spacing is no part. */
export function quoteParts(quote: string): string[] {
  return quote.split(ELLIPSIS).map((p) => p.trim()).filter((p) => fold(p, false).text.length > 0);
}

/** A text to look in: one cited source, or cited sections of one file that follow each other. */
interface Text {
  readonly ids: readonly string[];
  readonly label: string;
  readonly raw: string;
  asWritten?: Folded;
  asRead?: Folded;
}
const read = (t: Text, asRead: boolean): Folded =>
  asRead ? (t.asRead ??= fold(t.raw, true)) : (t.asWritten ??= fold(t.raw, false));

interface Hit { readonly text: Text; readonly asRead: boolean; readonly index: number; readonly length: number }
interface Occurrence { readonly textIndex: number; readonly originalStart: number; readonly originalEnd: number }

/** Where these words stand in the texts, as written or as they read, or null. */
function locate(words: string, texts: readonly Text[]): Hit | null {
  for (const asRead of [false, true]) {
    const needle = fold(words, asRead).text;
    if (!needle) continue;
    for (const t of texts) {
      const index = read(t, asRead).text.indexOf(needle);
      if (index >= 0) return { text: t, asRead, index, length: needle.length };
    }
  }
  return null;
}

/**
 * Every place these words occur, in original-text offsets. A source-id list is a set of citations, not an ordering of
 * different documents, so ordering is enforced within each text. Sections of one file that follow each other have
 * already been joined into one text by `textsOf`.
 */
function occurrences(words: string, texts: readonly Text[]): Occurrence[] {
  const found = new Map<string, Occurrence>();
  for (const asRead of [false, true]) {
    const needle = fold(words, asRead).text;
    if (!needle) continue;
    for (let textIndex = 0; textIndex < texts.length; textIndex++) {
      const t = texts[textIndex]!;
      const haystack = read(t, asRead);
      for (let from = 0;;) {
        const index = haystack.text.indexOf(needle, from);
        if (index < 0) break;
        const originalStart = haystack.at[index]!;
        const originalEnd = haystack.at[index + needle.length - 1]! + 1;
        found.set(`${textIndex}:${originalStart}:${originalEnd}`, { textIndex, originalStart, originalEnd });
        from = index + 1;
      }
    }
  }
  return [...found.values()].sort((a, b) => a.textIndex - b.textIndex || a.originalStart - b.originalStart || a.originalEnd - b.originalEnd);
}

/**
 * Advance every possible in-order placement of the quote so far. Only the earliest usable occurrence in one text is
 * needed for a state: a later one leaves less room. Dominated states are removed for the same reason, keeping repeated
 * phrases in long messages from multiplying the search.
 */
function advanceOrder(words: string, texts: readonly Text[], states: readonly (readonly number[])[]): number[][] {
  const hits = occurrences(words, texts);
  const next = new Map<string, number[]>();
  for (const state of states) {
    for (let textIndex = 0; textIndex < texts.length; textIndex++) {
      const hit = hits.find((h) => h.textIndex === textIndex && h.originalStart >= (state[textIndex] ?? 0));
      if (!hit) continue;
      const advanced = [...state];
      advanced[textIndex] = hit.originalEnd;
      next.set(advanced.join(','), advanced);
    }
  }
  const values = [...next.values()];
  return values.filter((candidate, i) => !values.some((other, j) => j !== i
    && other.every((cursor, k) => cursor <= candidate[k]!)
    && other.some((cursor, k) => cursor < candidate[k]!)));
}

const lineRange = (s: Source): [number, number] => (s.anchor.kind === 'file' ? [s.anchor.lineStart, s.anchor.lineEnd] : [0, 0]);

/** The cited sources as texts: sections of one file that follow each other are joined into one. */
function textsOf(sources: readonly Source[]): Text[] {
  const out: Text[] = [];
  const files = new Map<string, Source[]>();
  for (const s of sources) {
    if (s.anchor.kind !== 'file') { out.push({ ids: [s.id], label: anchorLabel(s.anchor), raw: s.excerpt }); continue; }
    const key = pathKey(s.anchor.path);
    files.set(key, [...(files.get(key) ?? []), s]);
  }
  for (const sections of files.values()) {
    let run: Source[] = [];
    const flush = () => {
      if (run.length) out.push({ ids: run.map((s) => s.id), label: run.map((s) => anchorLabel(s.anchor)).join(' + '), raw: run.map((s) => s.excerpt).join('\n') });
      run = [];
    };
    for (const s of [...sections].sort((a, b) => lineRange(a)[0] - lineRange(b)[0])) {
      const last = run[run.length - 1];
      if (last && lineRange(s)[0] > lineRange(last)[1] + 1) flush();
      run.push(s);
    }
    flush();
  }
  return out;
}

/** The document a source is part of — a file, a session — for finding the section a quote was really taken from. */
function documentOf(s: Source): string | null {
  if (s.anchor.kind === 'file') return `file:${pathKey(s.anchor.path)}`;
  if (s.anchor.kind === 'session') return `session:${s.anchor.host}:${s.anchor.sessionId}`;
  return null;
}

/** The other sources of the documents cited: another section of the same file, another segment of the same session. */
function otherSectionsOf(store: ProjectStore, cited: readonly Source[]): Text[] {
  const documents = new Set(cited.map(documentOf).filter((d): d is string => d !== null));
  const ids = new Set(cited.map((s) => s.id));
  if (documents.size === 0) return [];
  return store.sources.filter((s) => !ids.has(s.id) && documents.has(documentOf(s) ?? ''))
    .map((s) => ({ ids: [s.id], label: anchorLabel(s.anchor), raw: s.excerpt }));
}

/** Text shown in a refusal: on one line, and not too long. */
function snippet(s: string, max: number, fromEnd = false): string {
  const cps = [...s.replace(/\s+/g, ' ').trim()];
  if (cps.length <= max) return cps.join('');
  return fromEnd ? `…${cps.slice(cps.length - max).join('')}` : `${cps.slice(0, max).join('')}…`;
}

/**
 * Where a part that is not in the texts parts from them: how far its start matches and what the source has there, or —
 * when only its end matches — what the source has before that end.
 */
function whereItParts(part: string, texts: readonly Text[]): string {
  const cps = [...part];
  const size = fold(part, false).text.length;
  // A match is only shown when it is a good share of the part: a few common letters say nothing about where it was taken from.
  const enough = (hit: Hit | null): hit is Hit => hit !== null && hit.length >= Math.max(4, Math.ceil(size * 0.4));
  // The longest start of the part that is in the texts.
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (locate(cps.slice(0, mid).join(''), texts)) lo = mid; else hi = mid - 1;
  }
  const head = lo > 0 ? locate(cps.slice(0, lo).join(''), texts) : null;
  if (enough(head)) {
    const f = read(head.text, head.asRead);
    const end = head.index + head.length;
    const sourceGoesOn = end < f.at.length ? snippet(f.original.slice(f.at[end]!), 40) : '';
    const quoteGoesOn = snippet(cps.slice(lo).join(''), 40);
    return sourceGoesOn
      ? `it follows ${head.text.ids.join(' + ')} as far as «${snippet(cps.slice(0, lo).join(''), 30, true)}»; there the source goes on «${sourceGoesOn}», the quote «${quoteGoesOn}»`
      : `it follows ${head.text.ids.join(' + ')} as far as «${snippet(cps.slice(0, lo).join(''), 30, true)}», where the source ends; the quote goes on «${quoteGoesOn}»`;
  }
  // The longest end of the part that is in the texts.
  lo = 0;
  hi = cps.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (locate(cps.slice(mid).join(''), texts)) hi = mid; else lo = mid + 1;
  }
  const tail = lo < cps.length ? locate(cps.slice(lo).join(''), texts) : null;
  if (enough(tail)) {
    const f = read(tail.text, tail.asRead);
    const start = f.at[tail.index]!;
    const sourceBefore = snippet(f.original.slice(0, start), 40, true);
    return `only its end «${snippet(cps.slice(lo).join(''), 30)}» follows ${tail.text.ids.join(' + ')}; before it the source has «${sourceBefore}», the quote «${snippet(cps.slice(0, lo).join(''), 40, true)}»`;
  }
  return 'these words are not in the sources cited';
}

/**
 * Where these words stand in one text, read the way a quote is checked (case, spacing, punctuation, quotation marks and
 * Markdown marks make no difference), or null. It gives the words as the text itself has them — so what is stored as a
 * cited line is the source's, never the caller's rendering — and where they start in the text as read (`raw` in NFC).
 * One stretch of words: an ellipsis is not read as leaving words out here.
 */
export function findWords(words: string, raw: string): { readonly text: string; readonly start: number } | null {
  const hit = locate(words, [{ ids: [], label: '', raw }]);
  if (!hit) return null;
  const f = read(hit.text, hit.asRead);
  const start = f.at[hit.index]!;
  // `at` holds where each compared character's code point starts: the words end after the whole last code point.
  const last = f.at[hit.index + hit.length - 1]!;
  const end = last + String.fromCodePoint(f.original.codePointAt(last)!).length;
  return { text: f.original.slice(start, end), start };
}

export interface MissingPart {
  /** The part as the quote has it: absent from the cited sources, or present only before an earlier quote part. */
  readonly part: string;
  /** What helps to put it right: the section that holds it, or where it parts from the source. */
  readonly hint: string;
}
export interface VerbatimCheck {
  readonly parts: number;
  readonly missing: readonly MissingPart[];
}

/** Which parts of a quote are absent from the sources cited or cannot follow the preceding parts there. */
export function checkVerbatim(store: ProjectStore, quote: string, sourceIds: readonly string[]): VerbatimCheck {
  const cited = [...new Set(sourceIds)].map((id) => store.sources.get(id)).filter((s): s is Source => s !== undefined);
  const parts = quoteParts(quote);
  if (parts.length === 0) return { parts: 0, missing: [{ part: quote.trim(), hint: 'it holds no words' }] };
  const texts = textsOf(cited);
  const missing: MissingPart[] = [];
  let others: Text[] | null = null;
  let states: number[][] = [Array.from({ length: texts.length }, () => 0)];
  for (const part of parts) {
    const ordered = advanceOrder(part, texts, states);
    if (ordered.length) { states = ordered; continue; }
    const outOfOrder = locate(part, texts);
    if (outOfOrder) {
      missing.push({ part, hint: 'these words are in the sources cited, but only before the previous quoted part; keep the ellipsis-separated parts in the order the sources say them' });
      continue;
    }
    others ??= otherSectionsOf(store, cited);
    const elsewhere = locate(part, others);
    missing.push({
      part,
      hint: elsewhere ? `these words are in ${elsewhere.text.ids[0]} (${elsewhere.text.label}), which is not cited: cite that one` : whereItParts(part, texts),
    });
  }
  return { parts: parts.length, missing };
}

// ───────────────────────── what the tools say ─────────────────────────

const HOW_CHECKED = 'The quote is read in parts — an ellipsis (…… or ...) separates them — and every part must stand in the sources cited in the same order; case, spacing, punctuation, quotation marks and Markdown marks make no difference.';

const notThere = (check: VerbatimCheck): string =>
  (check.parts <= 1 ? 'It is not there:' : `${check.missing.length} of its ${check.parts} parts ${check.missing.length === 1 ? 'does' : 'do'} not stand there in that order:`);

/** A part as a refusal names it: whole unless it is very long. */
function named(part: string): string {
  const cps = [...part.replace(/\s+/g, ' ')];
  return cps.length <= 160 ? cps.join('') : `${cps.slice(0, 100).join('')} … ${cps.slice(-40).join('')}`;
}
const listed = (check: VerbatimCheck): string => check.missing.map((m) => `- “${named(m.part)}” — ${m.hint}`).join('\n');

/** Why an Owner's words item is refused, and how to put it right (Spec §1.3). */
export function ownerWordsRefusal(check: VerbatimCheck): string {
  return [
    `The quote is not the owner’s words as the sources cited hold them, so nothing was written (an Owner's words item opens to what the owner actually said). ${HOW_CHECKED} ${notThere(check)}`,
    listed(check),
    `Copy the owner’s words as they are, adding and changing nothing — pk_owner_utterances gives each message whole — mark each place you leave words out with ……, and cite the message or the decision record each part was said in. What the owner did not say in these words is not an Owner's words item: record your reading as the product description it is, refining the owner’s words it restates.`,
  ].join('\n');
}

/** Why an owner quote carried on another product-reference category is refused (Spec §1.3). */
export function referenceQuoteRefusal(check: VerbatimCheck): string {
  return [
    `The quote is not the owner’s words as the sources cited hold them, so the reference item was not written. ${HOW_CHECKED} ${notThere(check)}`,
    listed(check),
    'Copy the owner’s words as they are, adding and changing nothing, mark each place you leave words out with ……, and cite the message or decision record each part was said in. Put an agent’s reading in the item text, not in quote.',
  ].join('\n');
}

/** Why a rule's owner confirmation is refused (Spec §1.15, §3.9). */
export function ownerConfirmationRefusal(check: VerbatimCheck): string {
  return [
    `The confirmation quote is not the owner’s words as the current conversation message holds them, so the rule was not confirmed. ${HOW_CHECKED} ${notThere(check)}`,
    listed(check),
    'Copy the confirming words from the current owner message as they are, adding and changing nothing, with …… at each omission.',
  ].join('\n');
}

/** Why an Explicit rule is refused, and how to put it right (Spec §1.15, §3.9). */
export function ruleExcerptRefusal(check: VerbatimCheck): string {
  return [
    `The excerpt is not the project’s own words as the sources cited hold them, so the rule was not written (an Explicit rule gives the project’s own text). ${HOW_CHECKED.replace('The quote', 'The excerpt')} ${notThere(check)}`,
    listed(check),
    `Copy the project’s words as they are, adding and changing nothing, mark each place you leave words out with ……, and cite the section each part is written in. If the project never wrote this rule in its own words, the rule is basis Inferred: write it without excerpt, with your reading in summary and the records you drew it from as its sources — the rules you infer are put to the owner, in one note per round.`,
  ].join('\n');
}

/**
 * What a rule not resting on the project's own wording — inferred from practice, or confirmed by the owner — is told
 * when its excerpt is not the project's words: it is written, as before.
 */
export function inferredExcerptWarning(check: VerbatimCheck): string {
  const parts = check.missing.map((m) => `“${named(m.part)}” (${m.hint})`).join('; ');
  return `The excerpt is shown as the project’s own words, but ${check.parts <= 1 ? 'it is' : `${check.missing.length} of its ${check.parts} parts ${check.missing.length === 1 ? 'is' : 'are'}`} not in the sources cited: ${parts}. Copy the project’s words as they are, with …… where you leave words out, or leave excerpt out: a rule inferred from practice or confirmed by the owner needs none.`;
}
