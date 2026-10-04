/**
 * What the program reads off single lines of the material (Spec §1.16 rows 3 and 5; CKC-22 AC-4, AC-6). The ledger
 * records the two sides a line explicitly names, never a semantic judgement that the change really holds; "this report's
 * line says fail", with the line. Pure functions over a text; the scan in text-scan.ts follows each line through the
 * versions of its document.
 */
import { splitMarkdown } from '../sources/files.ts';

const clip = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n)}…` : s);
/** A named target without the closing brackets and marks of the sentence around it: `(superseded by D83)` → `D83`. */
export function balanced(s: string): string {
  let t = s.replace(/[\s*_`]+$/, '');
  const count = (c: string) => [...t].filter((x) => x === c).length;
  while (t.endsWith(')') && count(')') > count('(')) t = t.slice(0, -1).replace(/[\s*_`]+$/, '');
  while (t.endsWith('）') && count('）') > count('（')) t = t.slice(0, -1).replace(/[\s*_`]+$/, '');
  return t.replace(/[.。]$/, '');
}

// ───────────────────────── 明写的取代 ─────────────────────────

interface Phrase { readonly re: RegExp; readonly label: string; readonly target?: number }

/**
 * A section is the project's own obsolete list when its own heading says so (`5. 已纠正的旧规则`, `Deprecated APIs`,
 * `Fix round 2 (superseded)`), or its opening lines do (`以下规则……已作废`). A heading that opens with a finding's number
 * (`T9_R4-CX-01 — P2 — … 已作废的后台任务 …`, `F-1 …`) describes a finding about something obsolete, not a list of them.
 */
const OBSOLETE_HEADING = /作废|废弃|已纠正|纠正的旧|旧规则|不再使用|已取消|取消的|已撤回|退役|superseded|deprecated|obsolete|retired|withdrawn|no longer/i;
const FINDING_HEADING = /^\s*(?:[A-Z0-9]+[_-])*[A-Z]{1,6}-?\d{1,4}\b\s*(?:[—–:：|·-]|\s)/;
const OBSOLETE_LEAD = /(以下|下列|这些|below|following)[^。.\n]{0,40}(已作废|作废|废弃|不再使用|不再适用|已取消|已撤回|无效|superseded|deprecated|obsolete|no longer)/i;

export interface SupersessionLine {
  readonly line: number;
  readonly text: string;
  readonly pattern: string;
  readonly target: string | null;
  /** The old and new sides read from this line; neither is guessed from other numbers on the line. */
  readonly replaced: string | null;
  readonly replacement: string | null;
  readonly syntax: string;
  /** A row of the project's own obsolete list (a table row or a list item of such a section; never its header). */
  readonly obsoleteList: boolean;
  readonly listHeading: string | null;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;

const GENERIC_SIDE = /^(?:什么|哪些|谁|某(?:项|条|些|个|种)?|任何|以下|下列|这些|其(?:他|余)|这(?:些|个|一条)|那(?:些|个)|后来的决定|取代|内容|规则|做法|的|了|先|something|anything|someone|somebody|which|what|who|whatever|the following|the above)(?:\b|[的里中项条个种：: ]|$)/i;
const GENERIC_CHINESE = /^(?:什么|哪些|谁|某|任何|以下|下列|这些|后来的决定|取代|内容|规则|做法|的|了|先)/;
const ENTRY_NUMBER = /(?:^|\*\*\s*|#{1,6}\s+)([A-Z]{1,6}-?[A-Z]?\d{1,4})\s*(?:[·:：|—-]|\*\*)/;
const NUMBER_START = /^([A-Z]{1,6}-?[A-Z]?\d{1,4})(?=$|[、,，]|\s*(?:[·:：—-]|里|中的|和|与|及|&))/;

function side(raw: string): string | null {
  const s = balanced(raw.trim().replace(/^\*+|\*+$/g, '').replace(/^~~|~~$/g, '').replace(/^[「“'"`]+|[」”'"`]+$/g, '').trim())
    .replace(/\s*(?:\(.*?\))?\s*(?:；|;|。|\.)$/, '').trim();
  return s && s.length <= 160 && !GENERIC_SIDE.test(s) && !GENERIC_CHINESE.test(s) && !/[→⟶➜➔]/.test(s) ? s : null;
}

/** Only numbers at the start of the old side, including an explicit enumeration, denote superseded entries. */
export function replacedNumbers(old: string | null): string[] {
  if (!old) return [];
  const out: string[] = [];
  let rest = old.replace(/^[\s*_`~「“"'(（\[]+/, '');
  for (;;) {
    const m = NUMBER_START.exec(rest);
    if (!m) break;
    out.push(m[1]!);
    rest = rest.slice(m[0].length);
    const sep = /^\s*[、,，和与及&]\s*/.exec(rest);
    if (!sep) break;
    rest = rest.slice(sep[0].length);
  }
  return out;
}

interface Reading { pattern: string; replaced: string | null; replacement: string | null; syntax: string }
const sentence = (s: string): string => s.split(/[。.!?！？；;]/).at(-1)!.trim();
const clause = (s: string): string => s.split(/[，,。!？；;：:|]/).at(-1)!.trim();
const NAMED_SIDE = /^(?:[A-Z]{1,6}-?[A-Z]?\d{1,4}|[vV]\d+(?:\.\d+)+|本条|本项|此条|此项|新[^，。；;|]{1,45}|新版[^，。；;|]{1,45}|现行[^，。；;|]{1,45}|the new [^,;|]{1,45})$/i;

function readRelation(t: string, entry: string | null, firstLine: boolean): Reading | null {
  const plain = t.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/, '').replace(/^\*\*/, '').replace(/\*\*$/,'').trim();
  let m: RegExpExecArray | null;
  // A struck old side, a version transition, or a comparison row is an explicit arrow.
  if ((m = /~~([^~]{1,120})~~\s*(?:→|->|=>|⟶|➜|➔)\s*(.{1,120})/.exec(plain))) {
    const replaced = side(m[1]!); const replacement = side(m[2]!);
    return replaced && replacement ? { pattern: 'struck replacement', replaced, replacement, syntax: 'struck-arrow' } : null;
  }
  if ((m = /\b[vV](\d+(?:\.\d+)*)\s*(?:→|->|=>|⟶|➜|➔|升级为|升级到|升到|改为|换成)\s*[vV]?(\d+(?:\.\d+)*)\b/.exec(plain))) {
    return { pattern: 'version replacement', replaced: `v${m[1]}`, replacement: `v${m[2]}`, syntax: 'version-arrow' };
  }
  // English passive and active forms state both sides. The subject is the current sentence, not the whole line.
  if ((m = /\b(?:is|are|was|were|has been|have been)?\s*(superseded|replaced|obsoleted)\s+by\s+(.+)$/i.exec(plain))) {
    const prefix = sentence(plain.slice(0, m.index)).replace(/\b(?:is|are|was|were|has been|have been)\s*$/i, '').trim();
    const replaced = firstLine && entry ? entry : side(prefix);
    const replacement = side(m[2]!);
    return replaced && replacement ? { pattern: `${m[1]!.toLowerCase()} by`, replaced, replacement, syntax: 'passive' } : null;
  }
  if ((m = /\b(supersedes|replaces|obsoletes)\s+(.+)$/i.exec(plain))) {
    const replacement = side(sentence(plain.slice(0, m.index))) ?? (firstLine ? entry : null);
    const replaced = side(m[2]!);
    return replaced && replacement ? { pattern: m[1]!.toLowerCase(), replaced, replacement, syntax: 'active' } : null;
  }
  if ((m = /被\s*([^，。；;,|]{1,50}?)\s*(?:所)?取代/.exec(plain))) {
    const prefix = clause(plain.slice(0, m.index)).replace(/\s*已$/, '').trim();
    const afterEntry = firstLine && entry ? prefix.replace(new RegExp(`^${entry}\\s*[·:：—-]\\s*`), '') : prefix;
    const version = /(?:^|、)\s*([vV]\d+(?:\.\d+)+)$/.exec(afterEntry)?.[1];
    const replaced = firstLine && entry && afterEntry !== prefix && (!afterEntry || afterEntry === '已' || !/^[A-Z]{1,6}-?[A-Z]?\d/.test(afterEntry))
      ? entry : side(version ?? afterEntry);
    const replacement = side(m[1]!);
    if (/例如|比如|e\.g\./i.test(prefix) || /取代|哪些|什么|是否|有没有|哪次|写明/.test(m[1]!)) return null;
    return replaced && replacement ? { pattern: '被…取代', replaced, replacement, syntax: 'passive' } : null;
  }
  if (!/^\|/.test(t) && (m = /取代\s*(?:了|掉)?\s*([^，。；;,|]{1,100})/.exec(plain))) {
    const before = plain.slice(0, m.index);
    if (/被[^，。；;,|]{0,50}$/.test(before)) return null;
    const prefix = clause(before).replace(/^.*?[·—]\s*(?=本条|本项|此条|此项)/, '').trim();
    const replacement = /^(?:本条|本项|此条|此项)$/.test(prefix) ? entry : NAMED_SIDE.test(prefix) ? side(prefix) : null;
    const replaced = side(m[1]!);
    return replaced && replacement ? { pattern: '取代', replaced, replacement, syntax: 'active' } : null;
  }
  // A status belongs to the named entry only when the entry itself says so, not when its body describes a rule.
  if ((m = /\b(?:deprecated|obsolete|retired|withdrawn|no longer (?:used|in use|applies|valid|in force))\b|(?:已)?(?:作废|废弃|撤回|退役|不再使用|不再适用|不再有效)/i.exec(plain))) {
    if (/撤回/.test(m[0]) && /^\s*\S/.test(plain.slice(m.index + m[0].length))) return null;
    const prefix = sentence(plain.slice(0, m.index)).replace(/\s*(?:is|are|was|were|has been|have been|已)\s*$/i, '').trim();
    const selfStatus = firstLine && !!entry && new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[·:：—-]\\s*$`).test(prefix);
    const replaced = selfStatus ? entry : side(prefix);
    if (replaced && (selfStatus || /^[A-Z]{1,6}-?[A-Z]?\d{1,4}\s/.test(replaced) || replacedNumbers(replaced).length > 0 || /^(?:旧|原|此前|the |an? )/i.test(replaced)))
      return { pattern: m[0]!, replaced, replacement: null, syntax: selfStatus ? 'entry-status' : 'status' };
  }
  return null;
}

/** For each 1-based line, the obsolete list it lies in (its section's own heading or opening lines say so, or an enclosing section's do). */
function obsoleteLists(text: string, lineCount: number): (string | null)[] {
  const byLine: (string | null)[] = new Array(lineCount + 2).fill(null);
  const listOfPath = new Map<string, string>();
  for (const s of splitMarkdown(text)) {
    const key = s.headingPath.join(' › ');
    const own = s.headingPath[s.headingPath.length - 1] ?? '';
    const lead = s.text.split(/\r?\n/).slice(s.headingPath.length ? 1 : 0).filter((l) => l.trim() && !TABLE_ROW.test(l)).slice(0, 3).join(' ');
    let list: string | null = (own && OBSOLETE_HEADING.test(own) && !FINDING_HEADING.test(own)) || OBSOLETE_LEAD.test(lead) ? key || '(before the first heading)' : null;
    // A subsection of an obsolete section is part of it (a section ends at the next heading of any level).
    for (let k = s.headingPath.length - 1; list === null && k >= 1; k--) list = listOfPath.get(s.headingPath.slice(0, k).join(' › ')) ?? null;
    if (list === null) continue;
    listOfPath.set(key, list);
    for (let ln = s.lineStart; ln <= s.lineEnd && ln <= lineCount; ln++) byLine[ln] = list;
  }
  return byLine;
}

export function supersessionLines(text: string): SupersessionLine[] {
  const lines = text.split(/\r?\n/);
  const lists = obsoleteLists(text, lines.length);
  const listOf = (ln: number) => lists[ln] ?? null;
  const out: SupersessionLine[] = [];
  let inFence = false;
  let entry: string | null = null;
  let tableHeads: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    const t = raw.trim();
    if (!t || t.length > 1500) continue;
    const ln = i + 1;
    const isRow = TABLE_ROW.test(raw) && !TABLE_SEP.test(raw);
    const isHeaderRow = isRow && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!);
    if (isHeaderRow) { tableHeads = raw.split('|').slice(1, -1).map((c) => c.trim()); continue; }
    const ownEntry = ENTRY_NUMBER.exec(raw)?.[1] ?? null;
    if (ownEntry) entry = ownEntry;
    else if (/^\s*#{1,3}\s+/.test(raw)) entry = null;
    const isItem = /^\s{0,1}(?:[-*+]|\d{1,3}[.)])\s+\S/.test(raw);
    const list = !inFence && (isRow || isItem) && !isHeaderRow ? listOf(ln) : null;
    if (list) {
      const cells = isRow ? raw.split('|').slice(1, -1).map((c) => c.trim()) : [];
      const replaced = side(isRow ? cells[0] ?? '' : t.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, ''));
      if (!replaced) continue;
      const newColumn = tableHeads.findIndex((h) => /现在|现行|改为|新(?:说法|读法|规则)|读作|current|new|now/i.test(h));
      const replacement = newColumn > 0 ? side(cells[newColumn] ?? '') : null;
      out.push({ line: ln, text: clip(t), pattern: 'obsolete-list', target: isRow ? replaced : null, replaced, replacement, syntax: 'obsolete-list-row', obsoleteList: true, listHeading: list });
      continue;
    }
    // A code block is an example, a command or a quoted configuration: a phrase inside it is not the document saying
    // something is replaced (QC AY, CKC-22 AC-4). The verdicts skip fences the same way.
    if (inFence) continue;
    if (isRow && tableHeads.length) {
      const oldColumn = tableHeads.findIndex((h) => /旧(?:说法|读法|规则|版本|方案|内容)|原(?:说法|规则|方案)|old|before/i.test(h));
      const newColumn = tableHeads.findIndex((h) => /读作|现在|现行|新(?:说法|读法|规则|版本|方案|内容)|current|new|after/i.test(h));
      if (oldColumn >= 0 && newColumn >= 0 && oldColumn !== newColumn) {
        const cells = raw.split('|').slice(1, -1).map((c) => c.trim());
        const replaced = side(cells[oldColumn] ?? '');
        const replacement = side(cells[newColumn] ?? '');
        if (replaced && replacement) {
          out.push({ line: ln, text: clip(t), pattern: 'comparison row', target: replacement, replaced, replacement, syntax: 'comparison-row', obsoleteList: false, listHeading: null });
          continue;
        }
      }
    }
    const r = readRelation(t, entry, ownEntry !== null);
    if (r) out.push({ line: ln, text: clip(t), pattern: r.pattern, target: r.syntax === 'version-arrow' ? `${r.replaced} → ${r.replacement}` : r.replacement, replaced: r.replaced, replacement: r.replacement, syntax: r.syntax, obsoleteList: false, listHeading: null });
  }
  return out;
}

/** Supersession words in a file or directory name. */
/** Supersession words in a file or directory name — only words that say it; `archive` or `old` say where, not that. */
export const NAME_PHRASES: readonly Phrase[] = [
  { re: /superseded[-_ ]by[-_ ]([A-Za-z0-9._-]+)/i, label: 'superseded-by name', target: 1 },
  { re: /(?:^|[-_. ])(deprecated|obsolete|superseded|retired|withdrawn)(?:[-_. ]|$)/i, label: 'obsolete name' },
  { re: /作废|废弃|退役|已取代/, label: '作废 name' },
];

/** The first segment of a path whose name says superseded / obsolete, with the path up to it (a directory covers what it holds). */
export function supersessionInPath(path: string): { at: string; pattern: string; target: string | null } | null {
  const segs = path.split('/');
  for (let i = 0; i < segs.length; i++) {
    for (const p of NAME_PHRASES) {
      const m = p.re.exec(segs[i]!);
      if (!m) continue;
      return { at: segs.slice(0, i + 1).join('/') + (i < segs.length - 1 ? '/' : ''), pattern: p.label, target: p.target !== undefined ? m[p.target] ?? null : null };
    }
  }
  return null;
}

// ───────────────────────── 判定 ─────────────────────────

/** A report, review, QC, walkthrough or receipt: by where it is, by its name, or by its title. */
export function isReportLike(path: string, text: string): boolean {
  const p = path.toLowerCase();
  if (/(^|\/)(reports?|qc|reviews?|walkthroughs?|receipts?|audits?|回执|报告|走查|审阅|验收|复核)(\/)/.test(p)) return true;
  const base = p.split('/').pop() ?? '';
  if (/(report|review|walkthrough|receipt|audit|qc-result|回执|报告|走查|审阅|验收|复核)/.test(base)) return true;
  const title = /^\s*#\s+(.+)$/m.exec(text.slice(0, 3000))?.[1] ?? '';
  return /\b(QC|review|report|walkthrough|audit|verdict)\b|审阅|走查|验收报告|复核报告|回执|检查报告|测试报告|QC 报告/i.test(title);
}

const VERDICT_WORDS: readonly (readonly [RegExp, string])[] = [
  [/\bneeds?[\s-]+(?:repair|fix(?:es|ing)?|rework)\b|需修复|待修复|需要修复/i, 'needs-repair'],
  [/\bconditional(?:ly)?\s+pass(?:ed)?\b|有条件通过/i, 'conditional-pass'],
  [/\bincomplete\b|未完成|不完整/i, 'incomplete'],
  [/\bpartial(?:ly)?(?:\s+(?:done|pass(?:ed)?))?\b|部分做到|部分通过|部分成立/i, 'partial'],
  [/\b(?:fail(?:ed|s|ure)?|rejected|not\s+accepted)\b|不通过|未通过|没通过|不成立|未做到|没做到|不合格|打回/i, 'fail'],
  [/\b(?:pass(?:ed|es)?|approved|accepted|lgtm)\b|(?<![不未没非])(?:通过|成立|做到|合格)/i, 'pass'],
  [/\bblocked\b|阻塞/i, 'blocked'],
];
/** A verdict field: the verdict must follow it at once (markup and a mark such as ✅ aside), `结论：**✅ 通过**（…）`. */
const VERDICT_FIELD = /(?:^|[\s*>|(（【#])(?:结论|总体结论|总结论|最终结论|判定|裁决|评定|QC\s*结论|里程碑结论|verdict|Verdict|VERDICT|overall|Overall|result|Result|结果)\s*\**\s*[:：]\s*[*_`「“"'【\[(（]*\s*(?:[✅❌⚠️✔✖✗✘]\s*)?/u;
const VERDICT_CONTEXT = /判定|结论|裁决|验收|QC|审阅|走查|复核|评审|结果|verdict|result|review|status|状态|scenario|场景|AC-\d/i;

/** The verdict a stretch of text states, normalised; null when it names none. */
export function verdictWord(text: string): string | null {
  for (const [re, v] of VERDICT_WORDS) if (re.test(text)) return v;
  return null;
}

/** A line that lists the verdicts to choose from (`pass / fail / incomplete`) is a template, not a verdict. */
function isTemplate(t: string): boolean {
  const found = new Set<string>();
  for (const [re, v] of VERDICT_WORDS) if (re.test(t)) found.add(v);
  // The choices are separated by a slash, 、 or "or"; a table's pipes separate cells, not choices.
  return found.size >= 2 && /[/、]|\bor\b|或/.test(t.replace(/^\s*\||\|\s*$/g, ''));
}

export interface VerdictLine {
  readonly line: number;
  readonly kind: 'verdict' | 'count' | 'finding';
  readonly verdict: string | null;
  readonly confidence: 'stated' | 'candidate';
  readonly text: string;
}

const COUNT_PAIR = /(?<![\d.])(\d{1,6})\s*\/\s*(\d{1,6})(?![\d.])/;
const COUNT_CONTEXT = /\b(?:pass(?:ed|ing)?|fail(?:ed|ing|ures?)?|tests?|specs?|cases?|suites?|assertions?)\b|通过|失败|测试|用例/i;
const COUNT_WORDS = /(?<![A-Za-z0-9_.])(\d{1,6})\s+(?:tests?\s+)?(passed|passing|pass|failed|failing|fail|failures|skipped|todo)\b|(?:ℹ|#)\s*(tests|pass|fail|skipped|todo)\s+(\d{1,6})\b|(?<![A-Za-z0-9_.])(\d{1,6})\s*(?:个|条|项)\s*(?:测试|用例)?\s*(通过|失败)|(?<![A-Za-z0-9_.])(\d{1,6})\s*(?:个)?\s*(?:测试|用例)\s*(?:全部)?(通过|失败)/i;
/** A finding introduced by its number at the start of a heading, a bold line or a list item: `### F-1【严重】…`, `- **D-3** …`. */
const FINDING = /^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d{1,3}[.)]\s+)?\**\s*\[?([A-Z]{1,3}-\d{1,3})\]?\**\s*(?:[【(（\[:：·—-]|\s)/;

/** Verdicts, test counts and numbered findings stated in a report (only report-like documents are read for these). */
export function verdictLines(text: string, frontMatter = true): VerdictLine[] {
  const lines = text.split(/\r?\n/);
  const out: VerdictLine[] = [];
  let inFence = false;
  const front = frontMatter && lines[0] !== undefined && /^---\s*$/.test(lines[0]);
  // A section headed as the verdict (`## 结论`, `## Verdict`): its first line opening with a verdict states it.
  let verdictSection = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    const t = raw.trim();
    if (!t || t.length > 1200) continue;
    const ln = i + 1;
    if (!inFence && /^\s{0,3}#{1,6}\s+(?:\d+(?:\.\d+)*[.、]?\s*)?(?:总体结论|最终结论|结论|判定|裁决|QC\s*结论|verdict|result|conclusion|结果)\s*[:：]?\s*$/i.test(raw)) { verdictSection = true; continue; }
    if (verdictSection && !/^\s{0,3}#/.test(raw)) {
      verdictSection = false;
      const opening = verdictWord(t.replace(/^[\s*_`>「“"'【\[(（✅❌⚠️✔✖✗✘-]+/u, '').slice(0, 14));
      if (opening && !isTemplate(t)) { out.push({ line: ln, kind: 'verdict', verdict: opening, confidence: 'stated', text: clip(t) }); continue; }
    }
    if (front && i > 0 && i < 40) {
      const f = /^\s*(?:verdict|result|qc_result|status)\s*:\s*["']?([^"'#]+?)["']?\s*$/i.exec(raw);
      if (f) { const v = verdictWord(f[1]!); if (v) { out.push({ line: ln, kind: 'verdict', verdict: v, confidence: 'stated', text: clip(t) }); continue; } }
    }
    const finding = inFence ? null : FINDING.exec(raw);
    if (finding && !/^\s*\|/.test(raw)) out.push({ line: ln, kind: 'finding', verdict: finding[1]!, confidence: /^\s{0,3}(#|\*\*|[-*+]\s+\*\*)/.test(raw) ? 'stated' : 'candidate', text: clip(t) });
    const pair = COUNT_PAIR.exec(t);
    const words = COUNT_WORDS.exec(t);
    if ((pair && COUNT_CONTEXT.test(t)) || words) {
      const value = pair && COUNT_CONTEXT.test(t) ? `${pair[1]}/${pair[2]}` : words ? (words[1] !== undefined ? `${words[1]} ${words[2]!.toLowerCase()}` : words[3] !== undefined ? `${words[4]} ${words[3]!.toLowerCase()}` : words[5] !== undefined ? `${words[5]} ${words[6]}` : `${words[7]} ${words[8]}`) : null;
      out.push({ line: ln, kind: 'count', verdict: value, confidence: 'stated', text: clip(t) });
    }
    if (inFence) continue;
    const v = verdictWord(t);
    if (!v || isTemplate(t)) continue;
    const field = VERDICT_FIELD.exec(t);
    if (field) {
      // The verdict the field names: the word right after it; a verdict word further on (「待复审通过后」) is only a candidate.
      const rest = t.slice(field.index + field[0].length);
      const atOnce = verdictWord(rest.slice(0, 14));
      out.push({ line: ln, kind: 'verdict', verdict: atOnce ?? verdictWord(rest) ?? v, confidence: atOnce ? 'stated' : 'candidate', text: clip(t) });
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s/.test(raw);
    const row = TABLE_ROW.test(raw) && !TABLE_SEP.test(raw);
    if (heading || row || VERDICT_CONTEXT.test(t)) out.push({ line: ln, kind: 'verdict', verdict: v, confidence: 'candidate', text: clip(t) });
  }
  return out;
}
