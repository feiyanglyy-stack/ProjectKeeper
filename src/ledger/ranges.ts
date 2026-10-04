/**
 * Number ranges as projects write them (CM, E151; CK fix 14): `AC-25-AC-31`, `AC-25–AC-31`, `E95～E101`, `CKC-22～27`,
 * `D13–D18`, `R-35 到 R-39`. The ledger indexes a number where it stands alone, so the members inside a range — and the
 * last one, when a hyphen joins it to the first (`AC-25-AC-31`) — were found nowhere: the gated run's spot-check wrote
 * that nobody took up CKC-03 AC-31 although `3431e93` is titled 「(CKC-03 AC-25-AC-31)」.
 *
 * A range is two numbers of one family (the same letters, the second may leave them out) joined by a dash, a tilde, 至 or
 * 到, the second larger than the first and at most `MAX_RANGE` apart. Lookups that read what later names a number expand
 * them (`expandRanges`, `rangeMembers`); the ledger's own index is left as it is.
 */

/** The widest range read as one: a span wider than this is two numbers, not a list. */
export const MAX_RANGE = 300;

const RANGE = /(?<![A-Za-z0-9_])([A-Z]{1,6}-?[A-Z]?)(\d{1,4})\s*(?:-|–|—|～|~|〜|至|到|\.\.)\s*(?:([A-Z]{1,6}-?[A-Z]?)(?=\d))?(\d{1,4})(?![A-Za-z0-9_])/g;

export interface NumberRange {
  /** Where it stands in the text, and as written. */
  readonly index: number;
  readonly written: string;
  /** The family's letters (`AC-`, `E`, `CKC-`) and every member, both ends included, as the project writes them. */
  readonly prefix: string;
  readonly members: readonly string[];
}

/** The ranges a text writes, each with its members. */
export function rangesIn(text: string): NumberRange[] {
  const out: NumberRange[] = [];
  for (const m of text.matchAll(RANGE)) {
    const prefix = m[1]!;
    if (m[3] !== undefined && m[3] !== prefix) continue;
    const from = Number(m[2]);
    const to = Number(m[4]);
    if (!(to > from) || to - from > MAX_RANGE) continue;
    // Keep the width the project writes (`AC-05` stays two digits).
    const width = m[2]!.startsWith('0') ? m[2]!.length : 0;
    const members: string[] = [];
    for (let n = from; n <= to; n++) members.push(`${prefix}${width ? String(n).padStart(width, '0') : String(n)}`);
    out.push({ index: m.index!, written: m[0], prefix, members });
  }
  return out;
}

/** Every number the ranges of a text name, the ends included. */
export function rangeMembers(text: string): string[] {
  return [...new Set(rangesIn(text).flatMap((r) => r.members))];
}

/** Whether a range in the text names this number. */
export function rangeCovers(text: string, num: string): boolean {
  return rangesIn(text).some((r) => r.members.includes(num));
}

/**
 * The text with each range written out as a list (`AC-25, AC-26, …, AC-31`), for readers that tokenize numbers one by one.
 * A range wider than `maxMembers` stays as written: `CKC-01～CKC-27` in a sentence names the whole set, not 27 items.
 */
export function expandRanges(text: string, maxMembers = MAX_RANGE + 1): string {
  const ranges = rangesIn(text).filter((r) => r.members.length <= maxMembers);
  if (!ranges.length) return text;
  let out = '';
  let at = 0;
  for (const r of ranges) {
    out += text.slice(at, r.index) + r.members.join(', ');
    at = r.index + r.written.length;
  }
  return out + text.slice(at);
}

/** The letters of a number's family, as a range writes them (`AC-` of AC-31, `E` of E101), or null for two capitals alone. */
export function familyPrefix(num: string): string | null {
  const m = /^([A-Z]{1,6}-?[A-Z]?)(\d{1,4})$/.exec(num);
  return m ? m[1]! : null;
}
