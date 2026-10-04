/**
 * 编号 (Spec §1.16 row 4; CKC-22 AC-5): the project's numbering rules, recognised from the places a project defines its
 * numbers, and every place each number shows up.
 *
 * How a rule is recognised — the basis is written into `num_rules.basis` for each rule:
 * - A number is *defined* where a project introduces it: at the start of a Markdown heading (`### F-1【严重】`), at the
 *   start of a line in bold (`**D83 · …**`, `- **R-52**`), in the first column of a table (`| AC-1 |`, `| AA | kimi |`), as
 *   a prompt's front-matter `id`, as the prefix of a file or directory name (`CKC-22-ledger-and-time.md`, `AP-kimi-…md`,
 *   `runs/AA-1/`, `2026-07-22_T5-…md`), as the prefix of a branch-name segment (`wip/AB-byok`), or at the start of a
 *   commit subject (`AB: rewire …`, `B0 foundation: …`).
 * - A family is a rule when at least `MIN_DEFINED` different numbers of it are defined. Families: one capital letter and
 *   digits (`D83`, `E102`, `T5`), capitals, a hyphen and digits (`CKC-22`, `R-52`, `PA-16`, `AC-25`), and two capital
 *   letters (`AA`…`AZ`, `BA`…; task or prompt numbers).
 * - Two capital letters are only ever read in the defining positions above (never in prose), and only in capitals, so an
 *   ordinary word never becomes a number; once a two-letter number is defined, its mentions are found in prose too, and
 *   those of numbers that are also ordinary words (`AI`, `AM`, `AS` …) are marked `candidate`.
 * - A few families are not project numbers whatever their count: version labels (`V2`; version replacement is read as
 *   a supersession), HTML heading levels, and standard names (`SHA-256`, `UTF-8`, `ISO-8601` …).
 * - CZ: one of those families is a numbering all the same in a document that defines a series of it at heading positions
 *   — `SERIES_MIN` or more different numbers, consecutive or nearly (`### V1 · …`, `### V2 · …`, `### V4 · …`: a side
 *   decision log numbered V). The headings of that document are definitions; everywhere else — another document, prose,
 *   a file or branch name, a commit subject — the family stays what it was (a version label), and its mentions are not
 *   looked for.
 */

export const MIN_DEFINED = 3;

/**
 * The version of how definitions are read from a document's lines. A ledger built under another version reads the lines of
 * its documents again at its next rebuild (text-scan.ts), so a rule added here reaches documents already recorded.
 * 2 (CZ): a series of a not-a-number family at one document's headings.
 */
export const NUMBERING_VERSION = '2';

export type Position = 'heading' | 'bold entry' | 'table first column' | 'front matter' | 'file name' | 'branch name' | 'commit subject';

export interface NumToken { readonly num: string; readonly family: string; readonly shape: 'letter-digits' | 'prefix-hyphen' | 'two-letters' }

/** Families that are never a project's numbering (see the module comment). */
const NOT_NUMBERS = new Set(['V<n>', 'H<n>', 'SHA-<n>', 'UTF-<n>', 'ISO-<n>', 'RFC-<n>', 'CVE-<n>', 'TLS-<n>', 'HTTP-<n>', 'X-<n>', 'U-<n>', 'GPT-<n>', 'COVID-<n>', 'ES-<n>']);

/** Two capital letters that are also ordinary words or abbreviations: their prose mentions are only candidates. */
const COMMON_PAIRS = new Set(['AI', 'AM', 'AN', 'AS', 'AT', 'BE', 'BY', 'DO', 'GO', 'HE', 'IF', 'IN', 'IS', 'IT', 'ME', 'MY', 'NO', 'OF', 'OH', 'OK', 'ON', 'OR', 'SO', 'TO', 'UP', 'US', 'WE', 'UI', 'UX', 'QC', 'PR', 'ID', 'OS', 'CI', 'CD', 'DB', 'JS', 'TS', 'VS', 'VM', 'IO', 'PM', 'TV', 'OP', 'IP', 'EN', 'ZH', 'CN', 'PS', 'CC', 'RE', 'HR', 'QA', 'PC', 'KB', 'MB', 'GB', 'TB', 'MS', 'NS', 'OR', 'EO', 'PA']);
export const isCommonPair = (num: string): boolean => COMMON_PAIRS.has(num);

/** A number's family: its letters and hyphen with `<n>` for the digits (`D<n>`, `CKC-<n>`, `CK-M<n>`), or two letters. */
export function familyOf(num: string): NumToken | null {
  let m = /^([A-Z])(\d{1,4})$/.exec(num);
  if (m) return { num, family: `${m[1]}<n>`, shape: 'letter-digits' };
  m = /^([A-Z]{1,6}-[A-Z]?)(\d{1,4})$/.exec(num);
  if (m) return { num, family: `${m[1]}<n>`, shape: 'prefix-hyphen' };
  if (/^[A-Z]{2}$/.test(num)) return { num, family: 'two letters', shape: 'two-letters' };
  return null;
}

const notNumber = (t: NumToken | null): boolean => t === null || NOT_NUMBERS.has(t.family);

/** How many different numbers of a not-a-number family one document defines at heading positions before they count there. */
export const SERIES_MIN = 3;

/** A series: `SERIES_MIN` or more different numbers, consecutive or nearly — they span at most twice their count. */
export function isSeries(nums: readonly string[]): boolean {
  const values = [...new Set(nums.map((n) => Number(/(\d+)$/.exec(n)?.[1] ?? NaN)).filter((v) => Number.isFinite(v)))];
  if (values.length < SERIES_MIN) return false;
  return Math.max(...values) - Math.min(...values) + 1 <= values.length * 2;
}

/** A family that is a numbering only inside the one document that defines a series of it (see the module comment). */
export const isSeriesOnlyFamily = (family: string): boolean => NOT_NUMBERS.has(family);

/** One id at the start of a defining position: letter+digits, prefix-hyphen-digits, or (where allowed) two letters. */
const ID_AT_START = String.raw`(?:[A-Z]{1,6}-[A-Z]?\d{1,4}|[A-Z]\d{1,4}|[A-Z]{2})(?![A-Za-z0-9_]|\.\d)`;
export const HEADING_DEF = new RegExp(String.raw`^\s{0,3}#{1,6}\s+(?:\d+(?:\.\d+)*[.、]?\s+|第[^\s]{1,4}[轮节章部分]\s*[·:：]?\s*)?[*_\x60\[]*(` + ID_AT_START + ')');
export const BOLD_DEF = new RegExp(String.raw`^\s{0,3}(?:[-*+]\s+|\d{1,3}[.)]\s+)?\*\*\s*\[?(` + ID_AT_START + ')');
export const TABLE_DEF = new RegExp(String.raw`^\s*\|\s*[*_\x60\[]*(` + ID_AT_START + String.raw`)[*_\x60\]]*(?:\([^)|]*\))?[*_\x60]*\s*\|`);
const ID = String.raw`[A-Z]{1,6}-[A-Z]?\d{1,4}|[A-Z]\d{1,4}|[A-Z]{2}`;
const FRONT_ID = new RegExp(String.raw`^\s*id\s*:\s*["']?(` + ID + String.raw`)["']?\s*$`);
const NAME_DEF = new RegExp(String.raw`^(?:\d{4}-\d{2}-\d{2}[_-])?(` + ID + String.raw`)(?=[-_. ]|$)`);
const SUBJECT_DEF = new RegExp(String.raw`^\s*\[?(` + ID + String.raw`)\]?(?:\s*[+&,]\s*(?:` + ID + String.raw`))*\s*(?:[:：·—-]\s|\s)`);

export interface Definition { readonly num: string; readonly family: string; readonly position: Position; readonly line: number | null; readonly context: string }

const clip = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Two letters defined in names or a table count only where at least `MIN_DEFINED` different ones stand together — one
 * table's first column, one directory's entries, one repository's branches or subjects — which is what an index or a
 * numbered folder looks like; a lone `| UI | Compose |` row or a `QC-notes.md` is not a numbering.
 */
export function keepTwoLetterGroups<T extends { readonly num: string }>(defs: readonly T[], groupOf: (d: T) => string): T[] {
  const groups = new Map<string, Set<string>>();
  for (const d of defs) {
    if (familyOf(d.num)?.shape !== 'two-letters') continue;
    const g = groupOf(d);
    const s = groups.get(g) ?? new Set<string>();
    s.add(d.num);
    groups.set(g, s);
  }
  return defs.filter((d) => familyOf(d.num)?.shape !== 'two-letters' || (groups.get(groupOf(d))?.size ?? 0) >= MIN_DEFINED);
}

/** Numbers a document defines (headings, bold entry lines, first table columns, the front-matter id). */
export function definitionsInText(text: string): Definition[] {
  const found: (Definition & { table: number })[] = [];
  /** Headings that open with a number of a not-a-number family: definitions only when the document holds a series of it. */
  const held: Definition[] = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let table = -1;
  const front = lines[0] !== undefined && /^---\s*$/.test(lines[0]);
  const out = { push: (d: Definition) => found.push({ ...d, table: d.position === 'table first column' ? table : -1 }) };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; continue; }
    if (inFence) continue;
    // A table: consecutive `|` lines; a header row (the next line is a |---| separator) starts a new one.
    if (/^\s*\|/.test(l)) { if (table < 0 || !/^\s*\|/.test(lines[i - 1] ?? '') || /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) table = i; } else table = -1;
    if (front && i > 0 && i < 40) {
      const f = FRONT_ID.exec(l);
      if (f) { const t = familyOf(f[1]!); if (!notNumber(t)) out.push({ num: f[1]!, family: t!.family, position: 'front matter', line: i + 1, context: clip(l.trim()) }); continue; }
    }
    const tries: [RegExp, Position][] = [[HEADING_DEF, 'heading'], [BOLD_DEF, 'bold entry'], [TABLE_DEF, 'table first column']];
    for (const [re, position] of tries) {
      const m = re.exec(l);
      if (!m) continue;
      const t = familyOf(m[1]!);
      if (t !== null && NOT_NUMBERS.has(t.family) && position === 'heading') held.push({ num: m[1]!, family: t.family, position, line: i + 1, context: clip(l.trim()) });
      // Two letters count in a table's first column (an index) only; a heading or bold line starting with two capitals is prose.
      if (notNumber(t) || (t!.shape === 'two-letters' && position !== 'table first column')) break;
      if (position === 'table first column' && isSeparatorOrHeaderContext(lines, i)) break;
      out.push({ num: m[1]!, family: t!.family, position, line: i + 1, context: clip(l.trim()) });
      break;
    }
  }
  // The front matter's id names the document itself; two letters in a table count where the table is an index of them.
  const tables = keepTwoLetterGroups(found.filter((d) => d.position === 'table first column'), (d) => `table:${d.table}`);
  const kept: Definition[] = found.filter((d) => d.position !== 'table first column' || tables.includes(d)).map(({ table: _t, ...d }) => d);
  // CZ: a series of a not-a-number family at this document's headings is this document's numbering.
  const families = new Map<string, Definition[]>();
  for (const d of held) families.set(d.family, [...(families.get(d.family) ?? []), d]);
  const series = [...families.values()].filter((ds) => isSeries(ds.map((d) => d.num))).flat();
  return series.length ? [...kept, ...series].sort((a, b) => (a.line ?? 0) - (b.line ?? 0)) : kept;
}

/** A table's header row is not an entry (the row followed by the |---| separator). */
function isSeparatorOrHeaderContext(lines: readonly string[], i: number): boolean {
  const next = lines[i + 1];
  return next !== undefined && /^\s*\|[\s:|-]+\|\s*$/.test(next);
}

/**
 * Numbers a path defines: the prefix of any segment (file or directory), two letters in capitals only. A segment like
 * `AA-1` (a run directory) reads both ways — the number `AA-1` and the two letters `AA` — and the rules decide which
 * family is the project's (a run number rarely repeats three times; a prompt number does).
 */
export function definitionsInPath(path: string): Definition[] {
  const out: Definition[] = [];
  for (const seg of path.split('/')) {
    const m = NAME_DEF.exec(seg);
    if (!m) continue;
    const t = familyOf(m[1]!);
    if (!notNumber(t)) out.push({ num: m[1]!, family: t!.family, position: 'file name', line: null, context: path });
    const pair = /^([A-Z]{2})-\d{1,4}$/.exec(m[1]!);
    if (pair) out.push({ num: pair[1]!, family: 'two letters', position: 'file name', line: null, context: path });
  }
  return out;
}

/** Numbers a branch name defines: a segment's prefix, in capitals (`wip/AB-byok`); letters+digits in any case (`t5-…`). */
export function definitionsInBranch(name: string): Definition[] {
  const out: Definition[] = [];
  for (const seg of name.split('/')) {
    const m = new RegExp(`^(${ID})(?=[-_.]|$)`).exec(seg);
    if (!m) continue;
    const t = familyOf(m[1]!);
    if (notNumber(t)) continue;
    out.push({ num: m[1]!, family: t!.family, position: 'branch name', line: null, context: name });
  }
  return out;
}

/** Numbers a commit subject defines at its start (`AB: …`, `B1+B2: …`, `[AK] …`). */
export function definitionsInSubject(subject: string): Definition[] {
  const m = SUBJECT_DEF.exec(subject);
  if (!m) return [];
  const head = m[0];
  const out: Definition[] = [];
  for (const id of head.matchAll(new RegExp(ID, 'g'))) {
    const t = familyOf(id[0]);
    if (notNumber(t)) continue;
    out.push({ num: id[0], family: t!.family, position: 'commit subject', line: 1, context: clip(subject) });
  }
  return out;
}

// ───────────────────────── recognised rules, and the mentions they give ─────────────────────────

export interface Rule {
  readonly family: string;
  readonly shape: NumToken['shape'];
  /** Two letters: the numbers defined (only these are looked for in prose). */
  readonly defined: ReadonlySet<string>;
}

export interface Mention { readonly num: string; readonly family: string; readonly line: number; readonly context: string; readonly confidence: 'stated' | 'candidate' }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Build the matcher for the recognised rules; null when there are none. */
export function mentionMatcher(all: readonly Rule[]): ((text: string) => Mention[]) | null {
  // CZ: a family that counts only in the document holding its series is not looked for anywhere else.
  const rules = all.filter((r) => !isSeriesOnlyFamily(r.family));
  const letters = rules.filter((r) => r.shape === 'letter-digits').map((r) => r.family.slice(0, 1));
  const prefixes = rules.filter((r) => r.shape === 'prefix-hyphen').map((r) => r.family.replace(/<n>$/, ''));
  const pairs = rules.filter((r) => r.shape === 'two-letters').flatMap((r) => [...r.defined]);
  const alts: string[] = [];
  if (prefixes.length) alts.push(`(?:${prefixes.map(escapeRe).sort((a, b) => b.length - a.length).join('|')})\\d{1,4}`);
  if (letters.length) alts.push(`[${[...new Set(letters)].join('')}]\\d{1,4}`);
  if (pairs.length) alts.push(`(?:${[...new Set(pairs)].sort().join('|')})`);
  if (alts.length === 0) return null;
  const re = new RegExp(`(?<![A-Za-z0-9_\\-./])(${alts.join('|')})(?![A-Za-z0-9_]|\\.\\d)`, 'g');
  return (text: string) => {
    const out: Mention[] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.length > 4000) continue;
      const seen = new Set<string>();
      for (const m of l.matchAll(re)) {
        const num = m[1]!;
        if (seen.has(num)) continue;
        seen.add(num);
        const t = familyOf(num);
        if (!t) continue;
        const confidence = t.shape === 'two-letters' && isCommonPair(num) ? 'candidate' : 'stated';
        out.push({ num, family: t.family, line: i + 1, context: clip(l.trim()), confidence });
      }
    }
    return out;
  };
}

/** Mentions in names (a path, a branch, a worktree) of the recognised numbers; build once, use for every name. */
export function nameMatcher(rules: readonly Rule[]): (name: string) => string[] {
  const match = mentionMatcher(rules);
  return (name: string) => mentionsInNameWith(name, rules, match);
}

/** Mentions in a name (a path, a branch, a worktree): segment prefixes in any case for recognised numbers. */
export function mentionsInName(name: string, rules: readonly Rule[]): string[] {
  return mentionsInNameWith(name, rules, mentionMatcher(rules));
}

function mentionsInNameWith(name: string, rules: readonly Rule[], match: ((text: string) => Mention[]) | null): string[] {
  const out = new Set<string>();
  if (match) for (const m of match(name.replace(/\//g, ' / '))) if (m.confidence === 'stated') out.add(m.num);
  // `am-ui`, `t18-t23-backend`: lowercase segment prefixes of recognised numbers.
  for (const seg of name.split(/[\\/]/)) {
    for (const part of seg.split(/[-_.]/)) {
      const up = part.toUpperCase();
      const t = familyOf(up);
      if (!t) continue;
      if (isSeriesOnlyFamily(t.family) || !rules.some((r) => r.family === t.family && (t.shape !== 'two-letters' || r.defined.has(up)))) continue;
      if (t.shape === 'two-letters' && part !== seg.split(/[-_.]/)[0]) continue;   // two letters: only a segment's prefix
      out.add(up);
    }
  }
  return [...out];
}
