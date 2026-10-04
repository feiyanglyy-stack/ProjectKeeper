/**
 * What a claim that something was not handled is checked against (Spec v3.0 §2.13 rows 3 and 5 — dropped along the way,
 * let pass; CKC-27): for the items a "let pass" or "dropped" candidate names from a report or QC — a QC's item with its
 * task number ("AY B13"), a task number, an id the ledger defines in one document only — every later commit that names
 * it, with the merges that brought the commit in, and every later line of a document that names it. The model reads
 * them before it writes that nothing handled the item: an item a later commit names is reported with that commit, as
 * handled or partly handled, never as unhandled.
 *
 * Found in test-C-1: a sweep wrote that "AY B13 … at least six low-severity items" had no handling at all; the
 * cross-check adopted it, the synthesis wrote it as a note, and the spot-check confirmed it. Two of the six had been
 * handled before the trial started, by commits whose messages name the item — `c96d40e` "… (QC AY B3, B13)" and
 * `85a2476`/`d377df0` "… (QC AY B4 B6 B7 B11 B13)" — and the ledger indexes both.
 *
 * Where a candidate is: a line or a section of a step's text that says something was not handled, let pass, dropped, or
 * has no follow-up (the claim words below), and the program's own breakpoints that are material for "let pass" or
 * "dropped along the way". The program finds the ids; whether the item was handled is the model's judgement.
 */
import type { Ledger } from '../ledger/index.ts';
import { isReportLike } from '../ledger/lines.ts';
import type { Breakpoint } from '../model/k-types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { Facts, type CommitFact, type NumFact } from './facts.ts';
import { clip } from './text.ts';
import { buildUnits, type UnitIndex } from './units.ts';
import { taskNumbers } from './unnumbered.ts';
import { expandRanges } from '../ledger/ranges.ts';

// ───────────────────────── where a candidate is ─────────────────────────

/** Words that say something was not handled, let pass, dropped, or has no follow-up. */
export const CLAIM_WORDS = new RegExp([
  '[无没未][^。，,；;\\n]{0,4}(?:处置|处理|跟进|下文|后续|修复?|接手?|回应|落实)',
  '无人|没人|没有人|无任何|放过|放过去|丢了|丢失|漏掉|漏了|半路|中途丢|被放下|搁置|悬着|烂尾|不了了之',
  '\\blet pass\\b|\\bnobody\\b|\\bno one\\b|\\bnot (?:handled|fixed|addressed|followed up|re-?checked|picked up)\\b|\\bunhandled\\b',
  '\\b(?:no|without) (?:follow-?up|disposition|handling|fix|action|trace|successor|record of)\\b|\\bnever (?:handled|fixed|followed|picked up|addressed)\\b',
  '\\bdropped\\b|\\bleft open\\b|\\bstill open\\b|\\bopen items?\\b|\\bfindings? open\\b',
].join('|'), 'i');

export interface ClaimText {
  /** Where it is, as the step can open it: a round document's id, a note's id, a breakpoint's id. */
  readonly from: string;
  readonly text: string;
  /** Every line of it is a candidate (a program breakpoint of "let pass" or "dropped"), not only those with the words. */
  readonly whole?: boolean;
}

/**
 * The lines of a text that make a claim: those with the claim words, a heading among them (`(c)-2 · AY 的 B13 低危项：
 * 部分无逐项处置记录`). Not every line under such a heading: a sweep's "no follow-up" section cites its evidence around the
 * claim — decisions, commits, other tasks — and those are not what it says was let pass (test-C-1's reports named some
 * four hundred numbers under such headings).
 */
export function claimLines(text: string, whole = false): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && (whole || CLAIM_WORDS.test(l)));
}

// ───────────────────────── the items a claim names ─────────────────────────

/** An item a candidate names: a QC's item with its task number, a task number, or an id one document defines. */
export interface ClaimItem {
  /** As the step reads it: "AY B13", "AW", "E127". */
  readonly label: string;
  /** The task whose report or QC it is an item of; null for a task number alone or an id on its own. */
  readonly task: string | null;
  /** The item's own number (the task number itself, for a task). */
  readonly num: string;
  /** Where the candidates that name it are. */
  readonly from: readonly string[];
}

const ID = String.raw`[A-Z]{1,6}-[A-Z]?\d{1,4}[a-z]?|[A-Z]\d{1,4}[a-z]?|[A-Z]{2,3}`;
const TOKEN = new RegExp(String.raw`(?<![A-Za-z0-9_/.#-])(${ID})(?![A-Za-z0-9_-])`, 'g');
/** A number's family, as far as telling a task's items from other tasks goes: `XX` for two capitals, else its letters (`CKC-`, `AC-`, `B`). */
const familyOf = (id: string): string => (/^[A-Z]{2,3}$/.test(id) ? 'XX' : /^[A-Z]{2}-\d+[a-z]?$/.test(id) ? 'XX-n' : /^[A-Z]+-?/.exec(id)?.[0] ?? id);
/** What may stand between a task number and the items of its report: `AY B13`, `AY 的 B13`, `AY's B3, B13`, `QC AY：B4、B6`. */
const JOIN = /^\s*(?:(?:的|之|'s|’s|·|:|：|#|-|—|\/)\s*)?$/;
const LIST = /^\s*(?:,|，|、|;|；|\/|&|\+|和|与|及|and|or|或)?\s*$/;

/**
 * The items the claim lines name (see `ClaimItem`): `known` says whether the ledger has a number at all (a task's items
 * are read with it); `alone` whether a number not beside a task names one thing by itself (one document defines it).
 */
export function claimItems(texts: readonly ClaimText[], tasks: ReadonlySet<string>, known: (num: string) => boolean, alone: (num: string) => boolean = known): ClaimItem[] {
  const items = new Map<string, { label: string; task: string | null; num: string; from: Set<string> }>();
  const add = (task: string | null, num: string, from: string) => {
    const label = task ? `${task} ${num}` : num;
    const e = items.get(label) ?? { label, task, num, from: new Set<string>() };
    e.from.add(from);
    items.set(label, e);
  };
  for (const t of texts) {
    // CM: a range in a claim (`AC-25～AC-31 无人接`) names each of its members.
    for (const line of claimLines(t.text, t.whole).map((l) => expandRanges(l, CLAIM_RANGE))) {
      const tokens = [...line.matchAll(TOKEN)].map((m) => ({ id: m[1]!, start: m.index!, end: m.index! + m[1]!.length }))
        .filter((x) => tasks.has(x.id) || (!/^[A-Z]{2,3}$/.test(x.id) && known(x.id)));
      const paired = new Set<number>();
      for (let i = 0; i < tokens.length; i++) {
        const task = tokens[i]!;
        if (!tasks.has(task.id) || paired.has(i)) continue;
        // The items that follow a task number in a list are that task's (`QC AY B3, B13`), as long as they are numbers of
        // another family: `AA、AB、AC` are three tasks, and B3 after AY is AY's item even where B3 also names a batch.
        let prev = task;
        for (let j = i + 1; j < tokens.length; j++) {
          const next = tokens[j]!;
          const between = line.slice(prev.end, next.start);
          if (!(prev === task ? JOIN.test(between) || LIST.test(between) : LIST.test(between)) || familyOf(next.id) === familyOf(task.id)) break;
          add(task.id, next.id, t.from);
          paired.add(i); paired.add(j);
          prev = next;
        }
      }
      tokens.forEach((x, i) => { if (!paired.has(i) && (tasks.has(x.id) || alone(x.id))) add(null, x.id, t.from); });
    }
  }
  // A number a task's item already stands for — as the task or as the item — is not listed again on its own.
  const inPairs = new Set([...items.values()].filter((e) => e.task).flatMap((e) => [e.task!, e.num]));
  return [...items.values()].filter((e) => e.task || !inPairs.has(e.num)).map((e) => ({ label: e.label, task: e.task, num: e.num, from: [...e.from] }));
}

// ───────────────────────── what later names them ─────────────────────────

export interface LaterCommit {
  readonly commit: CommitFact;
  /** The lines of its message that name the item (after the subject). */
  readonly lines: readonly { readonly line: number; readonly text: string }[];
  /** The branch and merge that integrated it, and the trunk's merge that brought it in. */
  readonly merged: { readonly branch: string | null; readonly merge: CommitFact } | null;
  readonly trunk: CommitFact | null;
}

export interface LaterDocLine {
  readonly id: string;
  readonly path: string;
  readonly line: number | null;
  readonly text: string;
  readonly at: string;
  readonly current: boolean;
}

export interface ItemCheck {
  readonly item: ClaimItem;
  /** Where the item is first stated: the report's line that defines it, else its first appearance. */
  readonly first: NumFact | null;
  readonly commits: readonly LaterCommit[];
  readonly docs: readonly LaterDocLine[];
}

/** For each item, what later names it (see the module comment); `isReport` says which documents are reports. */
export function checkItems(facts: Facts, index: UnitIndex, items: readonly ClaimItem[], isReport: (path: string) => boolean = () => false): ItemCheck[] {
  // CM (E151): a commit or a line that writes a range names each of its members (`3431e93` 「(CKC-03 AC-25-AC-31)」).
  const nums = facts.numsWithRanges(items.flatMap((i) => (i.task ? [i.task, i.num] : [i.num])));
  const integrations = index.integrations;
  return items.map((item) => {
    const own = nums.get(item.num) ?? [];
    const of = item.task ? nums.get(item.task) ?? [] : [];
    const sameCommit = new Set(of.filter((r) => r.kind === 'commit').map((r) => r.commit));
    const sameLine = new Set(of.filter((r) => r.kind === 'doc' || r.kind === 'loose').map((r) => `${r.path}\x1f${r.line}`));
    // For a task's item: the rows that name the task too (the same commit message, the same line of a document).
    const rows = item.task ? own.filter((r) => (r.kind === 'commit' ? sameCommit.has(r.commit) : sameLine.has(`${r.path}\x1f${r.line}`))) : own;
    const defs = rows.filter((r) => r.place === 'definition').sort((a, b) => a.ms - b.ms);
    // A task's item is first stated where the task's own document defines it: one whose path carries the task's number
    // (`runs/AY-1/result.md`, `contracts/CKC-11-….md`), else a report that names the task, else any document that does
    // (B3 is also a batch of the first execution plan; AY's B3 is the line of AY's report).
    const taskDocs = new Set(of.filter((r) => r.kind === 'doc' || r.kind === 'loose').map((r) => r.path));
    const docDefs = own.filter((r) => r.place === 'definition' && (r.kind === 'doc' || r.kind === 'loose')).sort((a, b) => a.ms - b.ms);
    const carries = item.task ? new RegExp(`(?:^|[\\\\/_.-])${item.task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[-_.\\\\/]|$)`) : null;
    const rank = (r: NumFact) => (carries && r.path && carries.test(r.path) ? 0 : r.path && isReport(r.path) && taskDocs.has(r.path) ? 1 : taskDocs.has(r.path) ? 2 : 3);
    const definedIn = item.task ? docDefs.filter((r) => rank(r) < 3).sort((a, b) => rank(a) - rank(b) || a.ms - b.ms) : defs;
    const first = definedIn[0] ?? defs[0] ?? [...rows].sort((a, b) => a.ms - b.ms)[0] ?? null;
    const since = first?.ms ?? 0;
    const home = first?.path ?? null;
    const commits = new Map<string, { commit: CommitFact; lines: { line: number; text: string }[] }>();
    const docs: LaterDocLine[] = [];
    for (const r of rows) {
      if (r === first) continue;
      if (r.kind === 'commit' && r.commit) {
        const c = facts.commits.get(r.commit);
        if (!c || c.ms < since) continue;
        const e = commits.get(c.hash) ?? { commit: c, lines: [] };
        if ((r.line ?? 1) > 1 && !e.lines.some((l) => l.line === r.line)) e.lines.push({ line: r.line!, text: r.context });
        commits.set(c.hash, e);
      } else if ((r.kind === 'doc' || r.kind === 'loose') && r.path && r.path !== home && r.ms >= since) {
        docs.push({ id: r.id, path: r.path, line: r.line, text: r.context, at: r.occurred.at, current: r.current });
      }
    }
    const later = [...commits.values()].sort((a, b) => a.commit.ms - b.commit.ms).map((e) => {
      const m = integrations.innermost.get(e.commit.hash);
      const trunk = integrations.trunkMergeOf(e.commit.hash);
      return { commit: e.commit, lines: e.lines.sort((a, b) => a.line - b.line), merged: m ? { branch: m.source, merge: m.merge } : null, trunk: trunk && trunk.hash !== e.commit.hash && trunk.hash !== m?.merge.hash ? trunk : null };
    });
    return { item, first, commits: later, docs: docs.sort((a, b) => a.at.localeCompare(b.at) || a.path.localeCompare(b.path)) };
  });
}

// ───────────────────────── the block a step is given ─────────────────────────

/** The widest range a claim line is read as a list of items; a wider one names a whole set (its ends are still read). */
const CLAIM_RANGE = 8;
/** How many later commits, and how many later documents, the block shows per item; the counts are always whole. */
const MAX_COMMITS = 8;
const MAX_DOCS = 6;

const short = (h: string): string => h.slice(0, 7);
const when = (at: string): string => at.replace('T', ' ').slice(0, 16);

/**
 * The candidates the program itself computed: the breakpoints material for "let pass" or "dropped along the way", lit or
 * still a breakpoint candidate (D99: a candidate is exactly a "nothing handled it" to check against the later commits
 * before anyone writes it).
 */
export function breakpointClaims(store: ProjectStore): ClaimText[] {
  const LET_PASS_OR_DROPPED: readonly Breakpoint['kind'][] = ['Findings open', 'Passed with open items', 'Fix not re-checked', 'Not planned'];
  return store.breakpoints.filter((b) => !b.out && !b.ownerResponse && LET_PASS_OR_DROPPED.includes(b.kind)).map((b) => {
    const t = store.threads.get(b.targetId);
    return { from: b.id, whole: true, text: [`${b.kind}${b.lit ? '' : ' (candidate)'} on ${t ? `${t.ids.join(' ')} ${t.title}` : b.targetId}: ${b.why}`, ...b.evidence.map((e) => e.line ?? e.label)].join('\n') };
  });
}

export interface ClaimCheckOptions {
  /** What the step is told the candidates are ("this round's sweep reports", "what this round wrote"). */
  readonly what: string;
  /** The ledger's facts and the units, when the caller already read them for another block of the same step. */
  readonly analysis?: (() => { readonly facts: Facts; readonly index: UnitIndex } | null) | null;
}

/**
 * The block: for each item the candidates name, where it was first stated and what later names it. An item nothing later
 * names says so — the model still checks the code before it writes that nothing handled it.
 */
export function claimCheckBlock(store: ProjectStore, ledger: Ledger | null, texts: readonly ClaimText[], opts: ClaimCheckOptions): string {
  const head = `=== Before you write that something was not handled: what later names the items (the program's list from the ledger, for the "let pass" and "dropped" candidates in ${opts.what})`;
  if (!ledger) return `${head}\nThe ledger is not available, so nothing was listed: ask the ledger's numbers yourself (pk_ledger_numbers, pk_ledger_commits num) before any such claim.`;
  const withClaims = texts.filter((t) => claimLines(t.text, t.whole).length > 0);
  if (!withClaims.length) return `${head}\nNo candidate there says that something was not handled, let pass or dropped.`;
  let facts: Facts;
  let index: UnitIndex;
  try {
    const shared = opts.analysis?.() ?? null;
    facts = shared?.facts ?? new Facts(ledger);
    index = shared?.index ?? buildUnits(store, facts);
  } catch (e) { return `${head}\nThe ledger could not be read for it: ${(e as Error).message}`; }
  const tasks = taskNumbers(store, facts, index);
  const known = (num: string) => (facts.numsWithRanges([num]).get(num)?.length ?? 0) > 0;
  // On its own, away from a task number, an id names a report's or QC's item when one document alone defines it and
  // that document is a report (its path or its title says so) or a receipt. A decision or a requirement cited around a
  // claim is its evidence, not what it says was let pass.
  const reportPaths = new Set(facts.arrangements.filter((a) => a.kind === 'receipt').map((a) => a.path));
  const isReport = (path: string) => {
    if (reportPaths.has(path)) return true;
    const versions = facts.docsByPath.get(path) ?? [];
    const last = versions[versions.length - 1];
    return isReportLike(path, last ? facts.textOf(last.id) ?? '' : '');
  };
  const finding = (num: string) => {
    const rows = facts.numsOf([num]).get(num) ?? [];
    const homes = [...new Set(rows.filter((r) => r.place === 'definition' && (r.kind === 'doc' || r.kind === 'loose') && r.path).map((r) => r.path!))];
    return homes.length === 1 && isReport(homes[0]!);
  };
  const items = claimItems(withClaims, tasks, known, finding);
  if (!items.length) return `${head}\nThe candidates (${withClaims.map((t) => t.from).join(', ')}) name no task number, QC item or finding the ledger knows: check each claim against the ledger's numbers and words yourself.`;
  const checks = checkItems(facts, index, items, isReport);
  const lines: string[] = [head, `Candidates read: ${withClaims.map((t) => t.from).join(', ')}. Items they name: ${items.length}.`];
  for (const c of checks) {
    const later = c.commits.length + c.docs.length;
    lines.push(`- ${c.item.label}${c.item.task ? ` (an item of ${c.item.task}'s report or QC)` : ''} — named in ${c.item.from.join(', ')}`);
    if (c.first) lines.push(`  first stated: ${c.first.path ? `${c.first.path}${c.first.line ? `:${c.first.line}` : ''}` : `commit ${short(c.first.commit ?? '')}`} (${when(c.first.occurred.at)}; ${c.first.id}): “${clip(c.first.context, 400)}”`);
    if (!later) { lines.push('  nothing later names it: no commit message, no later line of a document.'); continue; }
    if (c.commits.length) {
      // CM: the first few say it was taken up, and by what; the rest are one query away (the block is read, not pasted whole).
      lines.push(`  later commits naming it (${c.commits.length}${c.commits.length > MAX_COMMITS ? `; the first ${MAX_COMMITS}, the rest with pk_ledger_commits num ${c.item.num}` : ''}):`);
      for (const x of c.commits.slice(0, MAX_COMMITS)) {
        const merged = x.merged ? ` — ${x.merged.branch ? `branch ${x.merged.branch}, ` : ''}merged ${short(x.merged.merge.hash)} ${when(x.merged.merge.occurred.at)}${x.trunk ? `, into the trunk with ${short(x.trunk.hash)}` : ''}` : x.commit.fpTrunk ? ' — on the trunk' : x.commit.onTrunk ? '' : ' — not on the trunk';
        lines.push(`  · ${short(x.commit.hash)} ${when(x.commit.occurred.at)} “${clip(x.commit.subject, 160)}”${merged}`);
        for (const l of x.lines) lines.push(`    line ${l.line}: “${clip(l.text, 200)}”`);
      }
    }
    if (c.docs.length) {
      const byPath = new Map<string, LaterDocLine[]>();
      for (const d of c.docs) byPath.set(d.path, [...(byPath.get(d.path) ?? []), d]);
      if (c.item.task) {
        // A task's item: one line per document, the first later line naming it and how many more that document has.
        lines.push(`  later lines of documents naming it (${c.docs.length} in ${byPath.size} document${byPath.size === 1 ? '' : 's'}; the first in each${byPath.size > MAX_DOCS ? `, ${MAX_DOCS} documents shown — pk_ledger_numbers num ${c.item.num} for all` : ''}):`);
        for (const [path, ds] of [...byPath].slice(0, MAX_DOCS)) {
          const d = ds[0]!;
          lines.push(`  · ${path}${d.line ? `:${d.line}` : ''} (${when(d.at)}${d.current ? '' : ', no longer in the current version'}; ${d.id})${ds.length > 1 ? ` +${ds.length - 1} more line${ds.length === 2 ? '' : 's'}` : ''}: “${clip(d.text, 200)}”`);
        }
      } else {
        // A number on its own is cited all over the project's documents: how often, and where to read them.
        const current = new Set(c.docs.filter((d) => d.current).map((d) => d.path)).size;
        lines.push(`  later documents naming it: ${c.docs.length} lines in ${byPath.size} document${byPath.size === 1 ? '' : 's'}, ${current} of them in the current version (pk_ledger_numbers num ${c.item.num} for the lines)`);
      }
    }
  }
  return lines.join('\n');
}
