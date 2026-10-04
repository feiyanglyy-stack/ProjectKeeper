/**
 * What the process engine reads off a report's own words (Spec v3.0 §2.12, §2.13 row 5): the verdict exactly as the
 * report wrote it, the items a passing report leaves for later, the tokens that let a later text be recognised as
 * following one up, and the report's own disposition of an item. Pure functions over text; the ledger already recorded
 * the lines (verdicts, findings, counts), these only read their words.
 */
import { splitMarkdown } from '../sources/files.ts';

// ───────────────────────── the verdict as written ─────────────────────────

const VERDICT_TOKEN = /needs?[\s-]+(?:repair|fix(?:es|ing)?|rework)|conditional(?:ly)?\s+pass(?:ed)?|有条件通过|incomplete|未完成|不完整|partial(?:ly)?(?:\s+(?:done|pass(?:ed)?))?|部分做到|部分通过|部分成立|fail(?:ed|s|ure)?|rejected|not\s+accepted|不通过|未通过|没通过|不成立|未做到|没做到|不合格|打回|pass(?:ed|es)?|approved|accepted|lgtm|(?<![不未没非])(?:通过|成立|做到|合格)|blocked|阻塞|需修复|待修复|需要修复/i;

/** The verdict word as the line wrote it (`fail`, `Pass`, `通过`, `Needs repair`), or null. */
export function verdictAsWritten(line: string): string | null {
  const field = /(?:结论|总体结论|总结论|最终结论|判定|裁决|评定|verdict|result|结果|status)\s*\**\s*[:：]\s*[*_`「“"'【\[(（\s]*(?:[✅❌⚠️✔✖✗✘]\s*)?/iu.exec(line);
  const from = field ? line.slice(field.index + field[0].length) : line;
  const m = VERDICT_TOKEN.exec(from) ?? VERDICT_TOKEN.exec(line);
  return m ? m[0].trim() : null;
}

/**
 * A normalised verdict that says the check found the work failing: `fail` (fail, 不通过, 未通过, rejected, 打回 …),
 * `needs-repair` (needs repair, 需修复 …) and `partial` (部分做到, 部分通过: the result has gaps). Only a check's failing
 * verdict starts a send-back (§1.18: 结果有缺口、失败，QC 判 fail → 送回 Work).
 */
export const FAILING = new Set(['fail', 'needs-repair', 'partial']);
/**
 * A normalised verdict that says the check has not concluded: a review that did not finish (`incomplete（审核进行中）`) or
 * could not go on (`blocked`). It is a check still in progress, not a failure: it starts no send-back and fixes nothing.
 */
export const IN_PROGRESS = new Set(['incomplete', 'blocked']);

/** The verdict word with the gloss the report wrote right after it (`incomplete（审核进行中）`), when there is one. */
export function withGloss(line: string, word: string): string {
  const at = line.toLowerCase().indexOf(word.toLowerCase());
  if (at < 0) return word;
  const m = /^[\s*_`」”"']*([（(][^）)\r\n]{1,40}[）)])/.exec(line.slice(at + word.length));
  return m ? `${word}${m[1]}` : word;
}

// ───────────────────────── items left for later ─────────────────────────

/** A section of a report that lists what it leaves open: gaps, leftovers, unresolved concerns, deferred items. */
const OPEN_HEADING = /缺口|遗留|未完成|未解决|未处理|待办|后续|暂缓|延后|以后再|之后再|留给|不在本轮|本轮不做|顾虑|\bopen (?:items?|issues?|questions?|points?)\b|known (?:issues?|gaps?)|\bgaps?\b|follow[- ]?ups?|\bdeferred\b|\bremaining\b|\btodo\b|to[- ]do|not done|left open|unresolved/i;
/** A line that says something is left for later. */
export const DEFER_WORDS = /之后再|以后再|后续再|下一(?:批|轮|版|阶段|个里程碑)|留给|留到|暂不|暂缓|延后|记下|不单开|不另开|不开新|先不|\bdefer(?:red)?\b|\blater\b|follow[- ]?up|next (?:round|batch|iteration|milestone)|\btodo\b|not (?:now|in this round)/i;
/** The report's own words that dispose of an item: not a product problem, accepted, the account's or the environment's. */
export const DISPOSE_WORDS = /不是产品|非产品|不属于产品|产品未改|不是新(?:限制|规则|要求)|原有的|不算|不处理|不修|无需|不需要|可接受|接受|已接受|账号侧|环境问题|操作恢复|误贴|不是缺陷|not a (?:product |real )?(?:bug|defect|issue|problem)|won'?t fix|wontfix|by design|as designed|\baccepted\b|\bacceptable\b|no action (?:needed|required)/i;
const NONE = /^(?:无|没有|暂无|none|n\/a|nothing)[。.！!]?$/i;

export interface OpenItem {
  /** 1-based line in the report's current version. */
  readonly line: number;
  readonly text: string;
  readonly section: string;
}

/** List items of the report's open-item sections (§2.12 `Passed with open items`: "之后再说"的条目). */
export function openItemsOf(text: string): OpenItem[] {
  const out: OpenItem[] = [];
  for (const s of splitMarkdown(text)) {
    const own = s.headingPath[s.headingPath.length - 1] ?? '';
    if (!own || !OPEN_HEADING.test(own)) continue;
    const lines = s.text.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i]!;
      const m = /^\s{0,3}(?:[-*+]|\d{1,3}[.)、])\s+(.+)$/.exec(raw);
      if (!m) continue;
      const body = m[1]!.trim();
      if (!body || NONE.test(body.replace(/[*_`]/g, ''))) continue;
      out.push({ line: s.lineStart + i, text: raw.trim(), section: own });
    }
  }
  return out;
}

/** Lines outside the open-item sections that defer something (a disposition in a root comment: 「记下，批次 5 处理」). */
export function deferLinesOf(text: string): OpenItem[] {
  const out: OpenItem[] = [];
  let inFence = false;
  const sections = splitMarkdown(text);
  const sectionAt = (ln: number) => sections.find((s) => ln >= s.lineStart && ln <= s.lineEnd);
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; return; }
    if (inFence || /^\s{0,3}#/.test(raw) || !raw.trim()) return;
    if (!DEFER_WORDS.test(raw)) return;
    const s = sectionAt(i + 1);
    const heading = s?.headingPath[s.headingPath.length - 1] ?? '';
    if (heading && OPEN_HEADING.test(heading)) return;
    out.push({ line: i + 1, text: raw.trim(), section: heading });
  });
  return out;
}

// ───────────────────────── tokens that recognise a follow-up ─────────────────────────

const STOP = new Set(['owner', 'root', 'agent', 'worker', 'model', 'system', 'commit', 'report', 'test', 'tests', 'debug', 'release', 'build', 'main', 'branch', 'Graph', 'README', 'TODO']);

/**
 * The words of a line distinctive enough to find it again in a later text: code in backticks, quoted phrases, file
 * names, identifiers with capitals or underscores, long numbers, and the project's finding numbers.
 */
export function tokensOf(line: string): string[] {
  const out = new Set<string>();
  for (const m of line.matchAll(/`([^`\n]{3,80})`/g)) out.add(m[1]!.trim().replace(/:\d+(?:-\d+)?$/, ''));
  for (const m of line.matchAll(/[「“"『]([^」”"』\n]{3,40})[」”"』]/g)) out.add(m[1]!.trim());
  for (const m of line.matchAll(/\b[\w-]+\.(?:dart|ts|tsx|js|py|md|json|yaml|yml|kt|swift|java|go|rs|sql)\b/g)) out.add(m[0]);
  for (const m of line.matchAll(/\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z]+_[A-Za-z0-9_]+|[A-Z][a-z]{3,}[A-Za-z0-9]*|[A-Z]{2,}[a-z][A-Za-z]*)\b/g)) if (m[0].length >= 5 && !STOP.has(m[0])) out.add(m[0]);
  for (const m of line.matchAll(/(?<![\d.])\d{4,6}(?![\d.])/g)) if (!/^(?:19|20)\d\d$/.test(m[0])) out.add(m[0]);
  for (const m of line.matchAll(/(?<![A-Za-z0-9_-])[A-Z]{1,3}-\d{1,3}(?![A-Za-z0-9_]|-\d)/g)) out.add(m[0]);
  return [...out].filter((t) => t.length >= 3).slice(0, 8);
}

/** Whether a number stands on its own in a text (not `F-6` inside `F-6-3`, not `AB` inside `ABC`). */
export function standsAlone(text: string, num: string): boolean {
  const re = new RegExp(`(?<![A-Za-z0-9_])${num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_]|-\\d|\\.\\d)`);
  return re.test(text);
}

/** One line of a text (1-based), or null. */
export function lineOf(text: string | null | undefined, line: number | null | undefined): string | null {
  if (!text || !line) return null;
  return text.split(/\r?\n/)[line - 1]?.trim() ?? null;
}

/**
 * The receipt's own account of what was done — recorded as a claim (§2.4): the first line of its summary section
 * (`## 做了什么`, `## 结论`, `## Summary`), else its status line (`status: submitted`), else its title.
 */
export function claimLineOf(text: string | null): string | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s{0,3}#{1,6}\s+(?:\d+[.、]\s*)?(?:做了什么|完成了什么|结论|总结|总体结论|交付|summary|what (?:was )?done|result|outcome)\s*[:：]?\s*$/i.test(l));
  if (at >= 0) {
    const first = lines.slice(at + 1).map((l) => l.trim()).find((l) => l && !/^#/.test(l) && !/^[|>-]{3}/.test(l));
    if (first) return first;
  }
  const status = lines.slice(0, 12).map((l) => l.trim()).find((l) => /^status\s*[:：]\s*\S/i.test(l));
  if (status) return status;
  const title = lines.find((l) => /^#\s/.test(l));
  return title ? title.replace(/^#\s+/, '').trim() : null;
}

/** The host's evidence about a unit: its first line that names the unit (what the evidence is, and why it exists). */
export function evidenceLineOf(text: string | null, num: string): string | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/).slice(0, 15).map((l) => l.trim()).filter((l) => l && !/^---$/.test(l) && !/^[A-Za-z_]+\s*:\s/.test(l));
  return lines.find((l) => standsAlone(l, num) && !/^#/.test(l)) ?? null;
}

/** What the host wrote in the report's `Root comment` (or disposition) section: its first line. */
export function rootCommentLineOf(text: string | null): string | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s{0,3}#{1,6}\s+(?:root comment|root disposition|处置|root 的处置|disposition)/i.test(l));
  if (at < 0) return null;
  return lines.slice(at + 1).map((l) => l.trim()).find((l) => l && !/^#/.test(l)) ?? null;
}

/** The clauses of a line (a root comment packs several dispositions into one line, one per clause). */
export const clausesOf = (line: string): string[] => line.split(/[；;。]/).map((x) => x.trim()).filter(Boolean);

/** An item's own words that dispose of it (narrower than a later line's: an item describing a mis-paste is still a gap). */
export const SELF_DISPOSE_WORDS = /产品未改|不是产品|非产品|不属于产品|not a (?:product |real )?(?:bug|defect|issue|problem)|by design|as designed|无需处理|不需要处理/i;

/** A test count as a report writes it next to its test words (`14/14 通过`, `134 passed`), not any pair of numbers. */
export function isTestCount(text: string, value: string | null): boolean {
  if (!value) return false;
  if (/\d\s+(?:passed|failed|passing|failing|pass|fail|通过|失败)$/i.test(value)) return true;
  const flat = text.replace(/\s+/g, '');
  const v = value.replace(/\s+/g, '');
  const at = flat.indexOf(v);
  if (at < 0) return false;
  const around = flat.slice(Math.max(0, at - 8), at) + flat.slice(at + v.length, at + v.length + 10);
  return /测试|用例|通过|失败|绿|passed|failed|passing|failing|tests?|specs?|cases?|pass|fail/i.test(around);
}

/** A severity label at the head of a finding (`【严重 · …】`, `P1`, `major`), or null. */
export function severityOf(line: string): string | null {
  const m = /【\s*(严重|中等|轻微|提示|阻塞|P[0-3])/.exec(line) ?? /\b(P[0-3]|critical|blocker|major|minor|nit)\b/i.exec(line);
  return m ? m[1]! : null;
}

/** Clip a line for a step's result; the full line stays in the evidence. */
export const clip = (s: string, n = 140): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
