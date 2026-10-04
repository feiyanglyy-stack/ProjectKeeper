/**
 * The owner's lines no position stands on yet (Spec v3.0 §3.11, §1.15, §1.3; CKC-21 — how the project works; CKC-23
 * AC-18 — session drafts). A session draft keeps the owner's words verbatim and says which lines decide or confirm
 * something; a line reaches the workbench only when a step writes it — a rule of how this project works, an Owner's words
 * item, a decision. The program lists the owner's lines that nothing cites yet (any label, CM), with the session
 * segment each stands in, so the steps that write those positions judge every one of them.
 *
 * Found in test-C-1: the orchestrator's session draft held the owner's answers of 2026-09-27 verbatim, as a Confirmation —
 * 「让各自commit就可以」 (each role commits its own documents) and 「可以，需要的时候就即时更新」 (update pi when needed) — and
 * neither became a rule, an Owner's words item or anything an incoming agent reads.
 *
 * A line is cited when a rule or a product-reference item carries its words: a part of the rule's excerpt or of the
 * owner's confirmation, or of the item's quote (the parts a quote's ellipses leave between them), stands in the line, or
 * the line stands in it. A short part (「可以」, 「对的」) stands in too many lines to tell them apart: it counts only when the
 * item also cites the session segment the line is in. An item that cites the segment with no words of its own is named
 * beside the line, for the step to judge whether it stands on it.
 *
 * DA (E156; the flash run): a line has three outcomes, not two. On that run the program showed all 246 lines as a debt
 * with no way to settle one except by citing it, and the main agent ordered every owner message recorded — 248 Owner's
 * words items, 「继续」 among them. A line for its moment only is now judged to need nothing, by its line reference with
 * why (`pk_judge_owner_lines`, many lines in one call): it leaves the list, is not given again in a later round while
 * its words stand, and stays on the round's record, where the spot-check samples it. And a quote too short to stand
 * alone (every part of it under `DISTINCT_WORDS`) becomes an Owner's words item only with the message it answers
 * (Spec §3.11: 「owner 说“可以”时，要看它答的是什么」; `ownerWordsContextRefusal`, called from `pk_write_reference`).
 */
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Ledger } from '../../ledger/index.ts';
import type { ClerkRound, OwnerLineJudgement, OwnerLineKind, SessionDraft } from '../../model/k-types.ts';
import type { ProjectRule, ReferenceItem, Source } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import type { ToolContext } from '../tools.ts';
import { checkVerbatim } from '../verbatim.ts';

/** A folded part this long (letters, digits and CJK characters) tells one owner line from another by itself. */
export const DISTINCT_WORDS = 8;

/** Only the words: no spacing, punctuation, quotation marks or Markdown; lower case; full-width forms as plain ones. */
export function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}\p{Cc}\p{Cf}]/gu, '');
}

/** The parts of a quote: what stands between its ellipses and between the separate utterances it strings together (「…」「…」). */
export function wordParts(quote: string): string[] {
  return quote.split(/(?:…|⋯|\.{3,})+|」\s*「|”\s*“|"\s+"/u).map(fold).filter(Boolean);
}

export interface OwnerLineRef {
  readonly draftId: string;
  readonly host: string;
  readonly sessionId: string;
  readonly ref: string;
  readonly at: string;
  /** How the session draft labelled it: a reading, never a filter (CM: a line naming two generations was labelled Chat and dropped). */
  readonly kind: OwnerLineKind;
  readonly text: string;
  readonly confirms: string | null;
  /** The agent message it answers, as the session draft took it from the ledger (a confirmation's); null when the draft has none. */
  readonly answers: string | null;
  /** The session segment(s) it stands in: the sources a rule or an item cites for it. */
  readonly sourceIds: readonly string[];
}

export interface CitingItem {
  readonly id: string;
  readonly kind: 'rule' | 'reference';
  readonly label: string;
  readonly words: readonly string[];
  readonly sourceIds: readonly string[];
}

export interface UncitedLine extends OwnerLineRef {
  /** Items that cite its session segment with no words of their own: they may stand on it. */
  readonly segmentCitedBy: readonly CitingItem[];
}

/** A line judged to need nothing (DA): the judgement, and the round it was made in. */
export interface JudgedLine extends OwnerLineRef {
  readonly why: string;
  readonly by: 'main' | 'lane';
  readonly lane: string | null;
  readonly judgedAt: string;
  readonly roundId: string;
}

export interface OwnerLinesResult {
  /** The lines not looked at yet: cited by nothing, and not judged to need nothing. Newest first. */
  readonly lines: readonly UncitedLine[];
  /** Every owner's line of the session drafts, whatever the draft labelled it, and the drafts they are in. */
  readonly considered: number;
  readonly drafts: number;
  /** Those cited, with what cites them. */
  readonly cited: readonly { readonly line: OwnerLineRef; readonly by: readonly string[] }[];
  /** Those judged to need nothing and cited by nothing (DA), newest first. */
  readonly judged: readonly JudgedLine[];
}

/** A line's reference, as the program's lists name it and `pk_judge_owner_lines` takes it: `<draft id>:<ref>`. */
export const lineKey = (draftId: string, ref: string): string => `${draftId}:${ref}`;

/** How a line's words begin, folded: what a judgement is held against, so a line whose words changed is looked at again. */
const HEAD_WORDS = 80;
const headOf = (text: string): string => fold(text).slice(0, HEAD_WORDS);

/** Whether a quote or a line stands alone: some part of it is long enough to tell one owner's line from another. */
export function standsAlone(words: string): boolean {
  return wordParts(words).some((p) => p.length >= DISTINCT_WORDS);
}

/** The judgements "needs nothing" of every round, by line reference; a later one of the same line replaces an earlier. */
export function lineJudgements(store: ProjectStore): Map<string, OwnerLineJudgement & { readonly roundId: string }> {
  const out = new Map<string, OwnerLineJudgement & { readonly roundId: string }>();
  for (const round of store.clerkRounds.all().sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    for (const j of round.ownerLineJudgements ?? []) out.set(lineKey(j.draftId, j.ref), { ...j, roundId: round.id });
  }
  return out;
}

/** Where a session line stands: its message position, from the line's ref or the ledger's message entry. */
function positionOf(ref: string, ledger: Ledger | null): number | null {
  const n = /^\[?(\d+)\]?$/.exec(ref.trim())?.[1];
  if (n !== undefined) return Number(n);
  if (!ledger || !/^msg:[0-9a-f]+$/i.test(ref.trim())) return null;
  try {
    const row = ledger.db.prepare('SELECT idx FROM session_messages WHERE key = ?').get(ref.trim()) as { idx: number } | undefined;
    return row ? Number(row.idx) : null;
  } catch { return null; }
}

/** The session sources that hold a draft's line: by its message position, else by its words, else by its time. */
export function segmentsOf(sources: readonly Source[], draft: SessionDraft, line: SessionDraft['ownerLines'][number], ledger: Ledger | null): string[] {
  const own = sources.filter((s) => s.anchor.kind === 'session' && s.anchor.host === draft.session.host && s.anchor.sessionId === draft.session.sessionId);
  if (!own.length) return [];
  const at = positionOf(line.ref, ledger);
  if (at !== null) {
    const hit = own.filter((s) => s.anchor.kind === 'session' && s.anchor.messageStart <= at && at <= s.anchor.messageEnd);
    if (hit.length) return hit.map((s) => s.id);
  }
  const words = fold(line.text).slice(0, 60);
  if (words.length >= DISTINCT_WORDS) {
    const hit = own.filter((s) => fold(s.excerpt).includes(words));
    if (hit.length) return hit.map((s) => s.id);
  }
  const byTime = own.filter((s) => s.anchor.kind === 'session' && (s.anchor.at ?? '') <= line.at)
    .sort((a, b) => ((b.anchor.kind === 'session' ? b.anchor.at ?? '' : '').localeCompare(a.anchor.kind === 'session' ? a.anchor.at ?? '' : '')))[0];
  return byTime ? [byTime.id] : [];
}

function itemsOf(store: ProjectStore): CitingItem[] {
  const rules = store.rules.all().map((r: ProjectRule): CitingItem => ({
    id: r.id, kind: 'rule', label: r.summary,
    words: [r.excerpt ?? '', r.ownerConfirmation?.quote ?? ''].filter(Boolean),
    sourceIds: [...r.sourceIds, ...(r.ownerConfirmation ? [r.ownerConfirmation.sourceId] : [])],
  }));
  const refs = store.reference.all().map((r: ReferenceItem): CitingItem => ({
    id: r.id, kind: 'reference', label: `${r.category} ${r.name}`, words: r.quote ? [r.quote] : [], sourceIds: r.sourceIds,
  }));
  return [...rules, ...refs];
}

/** Whether an item carries the line's words (see the module comment). */
export function carries(item: CitingItem, lineWords: string, lineSources: ReadonlySet<string>): boolean {
  const onSegment = item.sourceIds.some((s) => lineSources.has(s));
  for (const w of item.words) {
    const whole = fold(w);
    if (lineWords.length >= DISTINCT_WORDS && whole.includes(lineWords)) return true;
    if (onSegment && whole && (whole === lineWords || lineWords.includes(whole) || whole.includes(lineWords))) return true;
    for (const part of wordParts(w)) {
      if (!lineWords.includes(part)) continue;
      if (part.length >= DISTINCT_WORDS || onSegment) return true;
    }
  }
  return false;
}

/**
 * The owner's lines by their outcome (DA): cited — a rule, an Owner's words item or a decision carries their words —,
 * judged to need nothing, or not looked at yet (`lines`, newest first). Every line the session drafts hold counts,
 * whatever they labelled it (CM, E151: the draft labelled the owner's 「这两代」 message Chat, the program left it out,
 * and orientation folded the two generations into one). The label stays on each line as the draft's reading. A cited
 * line is cited whatever was judged of it; a judgement stands while the line's words do.
 */
export function uncitedOwnerLines(store: ProjectStore, ledger: Ledger | null): OwnerLinesResult {
  const sources = store.sources.filter((s) => s.anchor.kind === 'session');
  const items = itemsOf(store);
  const drafts = store.drafts.all();
  const judgements = lineJudgements(store);
  const out: UncitedLine[] = [];
  const cited: { line: OwnerLineRef; by: string[] }[] = [];
  const judged: JudgedLine[] = [];
  let considered = 0;
  for (const d of drafts) {
    for (const l of d.ownerLines) {
      if (!l.text.trim()) continue;
      considered++;
      const sourceIds = segmentsOf(sources, d, l, ledger);
      const line: OwnerLineRef = { draftId: d.id, host: d.session.host, sessionId: d.session.sessionId, ref: l.ref, at: l.at, kind: l.kind ?? 'Chat', text: l.text, confirms: l.confirms, answers: l.answers ?? null, sourceIds };
      const words = fold(l.text);
      const onIt = new Set(sourceIds);
      const by = items.filter((i) => carries(i, words, onIt)).map((i) => i.id);
      if (by.length) { cited.push({ line, by }); continue; }
      const j = judgements.get(lineKey(d.id, l.ref));
      if (j && j.head === headOf(l.text)) { judged.push({ ...line, why: j.why, by: j.by, lane: j.lane ?? null, judgedAt: j.at, roundId: j.roundId }); continue; }
      out.push({ ...line, segmentCitedBy: items.filter((i) => i.words.length === 0 && i.sourceIds.some((s) => onIt.has(s))) });
    }
  }
  const newestFirst = (a: OwnerLineRef, b: OwnerLineRef) => b.at.localeCompare(a.at) || a.ref.localeCompare(b.ref);
  return { lines: out.sort(newestFirst), considered, drafts: drafts.length, cited, judged: judged.sort(newestFirst) };
}

/** The program's count, in the words every block gives it: "n of N … are cited, m judged to need nothing, k not looked at yet". */
export function ownerLinesTally(r: OwnerLinesResult): string {
  return `${r.cited.length} of the ${r.considered} owner's lines in the ${r.drafts} session drafts are cited, ${r.judged.length} judged to need nothing, ${r.lines.length} not looked at yet`;
}

/** The agent message an owner's line answers: the session draft's, else the ledger's (the message right before it). */
export function answeredBy(line: Pick<OwnerLineRef, 'ref' | 'answers'>, ledger: Ledger | null): string | null {
  if (line.answers?.trim()) return line.answers;
  if (!ledger || !/^msg:[0-9a-f]+$/i.test(line.ref.trim())) return null;
  try { return ledger.message(line.ref.trim())?.answers?.text ?? null; } catch { return null; }
}

// ───────────────────────── the block a step is given ─────────────────────────

const when = (at: string): string => (at ? at.replace('T', ' ').slice(0, 16) : 'time unknown');

const clip = (s: string, n: number): string => { const flat = s.trim().replace(/\s+/g, ' '); return flat.length > n ? `${flat.slice(0, n)}…` : flat; };

function lineHead(l: UncitedLine): string {
  return `${when(l.at)} · ${l.kind} · ${l.host} session ${l.sessionId.slice(0, 8)} · line ${lineKey(l.draftId, l.ref)} · cite ${l.sourceIds.length ? l.sourceIds.join(', ') : 'no session source holds it'}`;
}

/** How much of the message a short line answers the block shows. */
const ANSWERS_SHOWN = 400;

export interface OwnerLinesBlockOptions {
  /** A Follow up: lines said since this time in full; the earlier ones still cited by nothing, one line each. */
  readonly since?: string | null;
}

/**
 * The block for the lane that writes the Owner's words items (a lane given the slot reference:Owner's words, CM): every
 * owner's line not looked at yet (any label), verbatim, with its line reference and the segment to cite. What each
 * becomes — a rule, an Owner's words item, both, or a line judged to need nothing — is the step's judgement; the method
 * says how. A line too short to stand alone comes with the message it answers (DA).
 */
export function ownerLinesBlock(store: ProjectStore, ledger: Ledger | null, opts: OwnerLinesBlockOptions = {}): string {
  const head = "=== The owner's lines no position cites yet (the program's list from the session drafts, whatever label the draft gave a line. A line is settled one of two ways: cited — a rule's excerpt or owner's confirmation, or a product-reference item's quote, carries its words — or judged to need nothing — a line for its moment only: pk_judge_owner_lines { lines: [its line reference, …], why }, many lines in one call; it is not listed again)";
  const r = uncitedOwnerLines(store, ledger);
  if (r.drafts === 0) return `${head}\nNo session draft yet.`;
  if (r.lines.length === 0) return `${head}\nNone left: ${ownerLinesTally(r)}.`;
  const since = opts.since ?? '';
  const recent = since ? r.lines.filter((l) => l.at >= since) : r.lines;
  const earlier = since ? r.lines.filter((l) => l.at < since) : [];
  const lines = [head, `${ownerLinesTally(r)}${since ? `: ${recent.length} said since ${when(since)} (in full), ${earlier.length} earlier` : ''}. Those not looked at yet follow, newest first; the owner's words are verbatim, the label is the draft's reading (not a filter: judge each line yourself), and the session segment named is the source to cite.`];
  for (const l of recent) {
    lines.push(`- ${lineHead(l)}`);
    // Verbatim, each line of the message indented so it stays inside its entry (indentation makes no difference to a quote).
    lines.push(`  the owner's message: 「${l.text.trim().split(/\r?\n/).join('\n    ')}」`);
    if (l.confirms) lines.push(`  what it confirms (the draft's words, not the owner's): ${l.confirms.trim()}`);
    if (!standsAlone(l.text)) {
      const answered = answeredBy(l, ledger);
      lines.push(answered
        ? `  too short to stand alone — it answers (the agent's message before it, as the program has it): 「${clip(answered, ANSWERS_SHOWN)}」 An item that quotes this line gives what it answers (answers).`
        : '  too short to stand alone, and the program has no message it answers: read its segment. An item that quotes this line gives what it answers (answers).');
    }
    if (l.segmentCitedBy.length) lines.push(`  its segment is cited, with no words of its own, by: ${l.segmentCitedBy.map((i) => `${i.id} (${i.label.slice(0, 80)})`).join('; ')} — see whether it stands on this line`);
  }
  if (earlier.length) {
    lines.push(`Said before ${when(since)} and still not looked at (${earlier.length}; pk_read_assets kind draft for any of them in full):`);
    for (const l of earlier) lines.push(`- ${lineHead(l)}: 「${clip(l.text, 160)}」`);
  }
  return lines.join('\n');
}

// ───────────────────────── the main agent's count (CM) ─────────────────────────

/**
 * Words that name versions, generations or a supersession (CM, E151): 「这两代」, 「上一代」, 「v2.0–v3.x」, 「取代」, "generation",
 * "superseded", an archive. A line with them can change how orientation cuts the generations, so the main agent sees it
 * even though the full list goes to a lane.
 */
export const GENERATION_WORDS = /(?:[这两几上前旧新首每各][一二三四五六七八九十两\d]?代(?![码表理替价言谢])|上一?代|第[一二三四五六七八九十\d]+代|generations?\b|版本史|(?<![A-Za-z])v\d+(?:\.\d+)*(?:\.x)?\s*[–—\-～~到至]\s*v?\d+(?:\.\d+)*(?:\.x)?|supersed\w*|取代|作废|归档|archiv(?:e|ed|ing)\b|重写|rewrit\w*)/i;

/** The narrower words that name a generation or a span of versions itself (not merely a supersession): 「这两代」, 「上一代」, "generation", 「v2.0–v3.x」. */
export const GENERATION_NAMED = /(?:[这两几上前旧新首每各][一二三四五六七八九十两\d]?代(?![码表理替价言谢])|上一?代|第[一二三四五六七八九十\d]+代|generations?\b|版本史|(?<![A-Za-z])v\d+(?:\.\d+)*(?:\.x)?\s*[–—\-～~到至]\s*v?\d+(?:\.\d+)*(?:\.x)?)/i;

/** How many of the lines that name generations the main agent's count shows. */
export const NAMING_SHOWN = 12;

/** Up to `max` stretches of a text around the words that name generations, each with some words either side. */
export function generationExcerpts(text: string, max = 3, around = 70): string[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  const re = new RegExp(GENERATION_WORDS.source, 'gi');
  const out: { from: number; to: number }[] = [];
  for (const m of flat.matchAll(re)) {
    const from = Math.max(0, m.index! - around);
    const to = Math.min(flat.length, m.index! + m[0].length + around);
    const last = out[out.length - 1];
    if (last && from <= last.to) { last.to = Math.max(last.to, to); continue; }
    if (out.length >= max) break;
    out.push({ from, to });
  }
  return out.map((x) => `${x.from > 0 ? '…' : ''}${flat.slice(x.from, x.to)}${x.to < flat.length ? '…' : ''}`);
}

/**
 * What the main agent is given of the owner's lines (CM, E151; CK fix 1): a count, and the lines that name versions,
 * generations or a supersession, each as the stretches around those words with where to read it whole. The full list —
 * 96K characters on the gated run, pasted four times into the main session — goes to the lane that writes the `Owner's
 * words` items (a lane given the slot `reference:Owner's words`), with its brief.
 */
export function ownerLinesCountBlock(store: ProjectStore, ledger: Ledger | null, opts: { readonly naming?: boolean } = {}): string {
  const head = "=== The owner's lines no position cites yet (a count; the full list goes to the lane you give the slot reference:Owner's words)";
  const r = uncitedOwnerLines(store, ledger);
  if (r.drafts === 0) return `${head}\nNo session draft yet.`;
  if (r.lines.length === 0) return `${head}\nNone left: ${ownerLinesTally(r)}.`;
  const kinds = r.lines.reduce((m, l) => m.set(l.kind, (m.get(l.kind) ?? 0) + 1), new Map<string, number>());
  const naming = r.lines.filter((l) => GENERATION_WORDS.test(l.text));
  const lines = [head, `${ownerLinesTally(r)} (the drafts labelled those ${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')}). Give their judging to a lane with the slot reference:Owner's words — the program gives that lane the whole list with each line verbatim and the segment to cite; by its own skill a line becomes an item, a working rule it reports for you to write, or — a line for its moment only — is judged to need nothing.`];
  // The lines that name generations are read in orientation, where the generations are cut; later stages get the count.
  if (naming.length && opts.naming === false) lines.push(`${naming.length} of them name versions, generations or a supersession (pk_round_state { list: "ownerLines" } lists every line).`);
  else if (naming.length) {
    // Those that name a generation or a span of versions itself come first; a line that only says something was superseded after.
    const ranked = [...naming].sort((a, b) => Number(GENERATION_NAMED.test(b.text)) - Number(GENERATION_NAMED.test(a.text)) || b.at.localeCompare(a.at));
    lines.push(`${naming.length} of them name versions, generations or a supersession — read them before you cut the generations (pk_read_assets kind draft for a line in full${naming.length > NAMING_SHOWN ? `; ${NAMING_SHOWN} shown, those that name a generation first — pk_round_state { list: "ownerLines" } for all` : ''}):`);
    for (const l of ranked.slice(0, NAMING_SHOWN)) lines.push(`- ${when(l.at)} · ${l.kind} · ${l.draftId}, ${l.ref}: ${generationExcerpts(l.text, 2).map((x) => `「${x}」`).join(' ')}`);
  }
  return lines.join('\n');
}

// ───────────────────────── the third outcome: judged, needs nothing (DA) ─────────────────────────

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }], details: {} });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: `ERROR: ${message}` }], details: {}, isError: true });
const bare = (ref: string): string => ref.trim().replace(/^\[|\]$/g, '');

/** The line a reference names: `<draft id>:<ref>` as the lists give it (a comma or a space between them is read too). */
function lineNamed(drafts: readonly SessionDraft[], input: string): { readonly draft: SessionDraft; readonly line: SessionDraft['ownerLines'][number] } | null {
  const named = input.trim().replace(/^\(|\)$/g, '').replace(/^line\s+/i, '');
  for (const draft of drafts) {
    if (!named.startsWith(draft.id)) continue;
    const ref = bare(named.slice(draft.id.length).replace(/^[\s:,]+/, ''));
    const line = draft.ownerLines.find((l) => bare(l.ref) === ref);
    if (line) return { draft, line };
  }
  return null;
}

/** The slot whose lane judges the owner's lines (round-blocks.ts `OWNER_WORDS_SLOT`), lower case. */
const JUDGING_SLOT = "reference:owner's words";

/**
 * `pk_judge_owner_lines` (DA): the third outcome of an owner's line. Which job is offered it is the stage gate's
 * (clerk-steps.ts: a lane with the slot `reference:Owner's words`, the main agent in reconcile and the cross-check).
 */
export function ownerLineTools(ctx: ToolContext): ToolDefinition[] {
  const { store } = ctx;
  return [defineTool({
    name: 'pk_judge_owner_lines', label: 'Judge owner’s lines as needing nothing',
    description: 'The third outcome of an owner’s line: judged, needs nothing. A line that is for its moment only — a go-ahead, a question answered then, a relay, thanks — forms no item and no rule: record it here by its line reference (<draft id>:<ref>, as the program’s list of the owner’s lines names it), many lines in one call, with why. Such a line leaves the list and is not given again while its words stand; the judgement stays on the round’s record, and the spot-check samples it. A line about what the product is, a decision, a correction or a working rule is not for its moment only: write it or report it. A short answer (“ok”, “right”, 「可以」) is judged by what it answers.',
    parameters: Type.Object({
      lines: Type.Array(Type.String(), { description: 'each line by its reference, <draft id>:<ref>, as the list names it' }),
      why: Type.String({ description: 'why these lines need nothing: what they were, in a few words' }),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const step = ctx.step;
      if (!step || (step.kind !== 'main' && step.kind !== 'lane')) return fail(`pk_judge_owner_lines is a round's: the lane with the slot reference:Owner's words, or the main agent in reconcile or the cross-check. This job is ${step ? `the round's ${step.kind}` : 'no step of a round'}, so nothing was recorded.`);
      if (step.kind === 'lane' && !(step.lane?.slots ?? []).some((s) => s.toLowerCase() === JUDGING_SLOT)) return fail(`pk_judge_owner_lines is the lane's that holds the slot reference:Owner's words; this lane (${step.path ?? ''}) writes ${(step.lane?.slots ?? []).join(', ') || 'none'}, so nothing was recorded. Put the lines in your Report for the main agent.`);
      const round = store.clerkRounds.get(step.roundId);
      if (!round) return fail(`The round ${step.roundId} is not in the assets.`);
      const why = text(p.why);
      if (!why) return fail('why is empty: say why these lines need nothing — what they were. Nothing was recorded.');
      const named = [...new Set((Array.isArray(p.lines) ? p.lines : []).map(text).filter(Boolean))];
      if (!named.length) return fail('lines is empty: name each line by its reference (<draft id>:<ref>), as the list of the owner’s lines gives it. Nothing was recorded.');
      const drafts = store.drafts.all();
      let ledger: Ledger | null = null;
      try { ledger = Ledger.openDir(store.dir); } catch { ledger = null; }
      try {
        const before = uncitedOwnerLines(store, ledger);
        const open = new Set(before.lines.map((l) => lineKey(l.draftId, l.ref)));
        const citedBy = new Map(before.cited.map((c) => [lineKey(c.line.draftId, c.line.ref), c.by]));
        const judgedAlready = new Set(before.judged.map((l) => lineKey(l.draftId, l.ref)));
        const at = new Date().toISOString();
        const fresh: OwnerLineJudgement[] = [];
        const unknown: string[] = [];
        const alreadyCited: string[] = [];
        const alreadyJudged: string[] = [];
        for (const name of named) {
          const hit = lineNamed(drafts, name);
          if (!hit) { unknown.push(name); continue; }
          const key = lineKey(hit.draft.id, hit.line.ref);
          if (citedBy.has(key)) { alreadyCited.push(`${key} (cited by ${citedBy.get(key)!.slice(0, 3).join(', ')})`); continue; }
          if (judgedAlready.has(key)) { alreadyJudged.push(key); continue; }
          if (!open.has(key) || fresh.some((j) => lineKey(j.draftId, j.ref) === key)) continue;
          fresh.push({ draftId: hit.draft.id, ref: hit.line.ref, head: headOf(hit.line.text), why, by: step.kind === 'main' ? 'main' : 'lane', lane: step.kind === 'lane' ? step.path ?? null : null, jobId: ctx.jobId, at });
        }
        if (!fresh.length) {
          return fail(`No line was recorded${unknown.length ? `; not a line of the session drafts: ${unknown.slice(0, 12).join(', ')}${unknown.length > 12 ? ` and ${unknown.length - 12} more` : ''} — name a line as the list does, <draft id>:<ref>` : ''}${alreadyCited.length ? `; cited already, so they need no judgement: ${alreadyCited.slice(0, 12).join('; ')}` : ''}${alreadyJudged.length ? `; judged already: ${alreadyJudged.slice(0, 12).join(', ')}` : ''}.`);
        }
        const current: ClerkRound = store.clerkRounds.get(round.id) ?? round;
        store.clerkRounds.put({ ...current, ownerLineJudgements: [...(current.ownerLineJudgements ?? []), ...fresh], updatedAt: at }, { jobId: ctx.jobId, basisSourceIds: [], summary: `Owner's lines judged to need nothing: ${fresh.length} — ${why}` });
        const after = uncitedOwnerLines(store, ledger);
        return ok({
          judged: fresh.length, cited: after.cited.length, judgedToNeedNothing: after.judged.length, notLookedAtYet: after.lines.length,
          ...(unknown.length ? { unknown } : {}), ...(alreadyCited.length ? { alreadyCited } : {}), ...(alreadyJudged.length ? { alreadyJudged } : {}),
        });
      } finally {
        ledger?.close();
      }
    },
  })];
}

/** How many of the round's judged lines the spot-check is given (all of them stay on the round's record). */
export const JUDGED_SAMPLE = 12;

/**
 * What a round's spot-check is given of the lines judged to need nothing (DA): those judged since the last spot-check
 * of an earlier round began, whichever round judged them — a first usable round, where most lines are judged, has no
 * spot-check of its own. How many, each reason with how many lines it was given for, and a sample — the lines the session
 * draft labelled a decision or a confirmation first, then the longest, where a wrong judgement costs most. Null when
 * none was judged since.
 */
export function judgedLinesBlock(store: ProjectStore, round: Pick<ClerkRound, 'id'>, ledger: Ledger | null): string | null {
  const lastCheck = store.jobs.filter((j) => j.step?.kind === 'spot-check' && j.step.roundId !== round.id).map((j) => j.queuedAt).sort().at(-1) ?? '';
  const judged = uncitedOwnerLines(store, ledger).judged.filter((l) => l.judgedAt > lastCheck);
  if (!judged.length) return null;
  const reasons = new Map<string, number>();
  for (const l of judged) reasons.set(l.why, (reasons.get(l.why) ?? 0) + 1);
  const weight = (l: JudgedLine): number => (l.kind === 'Chat' ? 0 : 1);
  const sample = [...judged].sort((a, b) => weight(b) - weight(a) || fold(b.text).length - fold(a.text).length || b.at.localeCompare(a.at)).slice(0, JUDGED_SAMPLE);
  const lines = [
    `=== The owner's lines judged to need nothing since the last spot-check (${judged.length}; the program's record — a sample of ${sample.length} to check)`,
    'A line for its moment only forms no item. A line about what the product is, a decision, a correction or a working rule should have become one: where a sampled line is such a line, write what it should have been (pk_write_reference for an Owner’s words item, with the segment as its source — a cited line leaves this record) and record the check as Wrong; else Right. Record each with pk_record_spot_check, target { collection: "drafts", id: <its draft id> }, kind "owner’s line judged to need nothing".',
    `The reasons given: ${[...reasons].map(([why, n]) => `“${clip(why, 160)}” (${n})`).join('; ')}.`,
  ];
  for (const l of sample) lines.push(`- ${when(l.at)} · ${l.kind} · line ${lineKey(l.draftId, l.ref)} · cite ${l.sourceIds.join(', ') || 'no session source holds it'} · judged by ${l.by === 'lane' ? `the lane ${l.lane ?? ''}`.trim() : 'the main agent'}: “${clip(l.why, 120)}”\n  the owner's message: 「${clip(l.text, 400)}」`);
  return lines.join('\n');
}

// ───────────────────────── a short quote needs what it answers (DA; Spec §3.11) ─────────────────────────

/**
 * The agent messages the owner's lines a quote stands on answer: the lines of the session drafts that hold every part of
 * the quote and stand in a cited session segment, each with the message before it as the program has it.
 */
function answeredMessages(store: ProjectStore, ledger: Ledger | null, quote: string, sourceIds: readonly string[]): string[] {
  const parts = wordParts(quote);
  if (!parts.length) return [];
  const cited = new Set(sourceIds);
  const sources = store.sources.filter((s) => s.anchor.kind === 'session');
  const out: string[] = [];
  for (const d of store.drafts.all()) {
    for (const l of d.ownerLines) {
      const words = fold(l.text);
      if (!parts.every((part) => words.includes(part))) continue;
      if (!segmentsOf(sources, d, l, ledger).some((id) => cited.has(id))) continue;
      const answered = answeredBy({ ref: l.ref, answers: l.answers ?? null }, ledger);
      if (answered?.trim()) out.push(answered);
    }
  }
  return out;
}

/**
 * Why an Owner's words item is refused for its context, or null (DA; Spec §3.11: 「owner 说“可以”时，要看它答的是什么」).
 * A quote too short to stand alone — every part of it under `DISTINCT_WORDS` — is accepted only with the message it
 * answers (`answers`). What is given as `answers` is copied, not written: it stands in the sources cited, or in the agent
 * message the program has before the owner's line. There is no filter on length beyond that: 「对的」 can be a decision.
 */
export function ownerWordsContextRefusal(store: ProjectStore, input: { readonly quote: string; readonly answers: string; readonly sourceIds: readonly string[] }): string | null {
  const short = !standsAlone(input.quote);
  const answers = input.answers.trim();
  if (!short && !answers) return null;
  let ledger: Ledger | null = null;
  try { ledger = Ledger.openDir(store.dir); } catch { ledger = null; }
  try {
    const answered = answeredMessages(store, ledger, input.quote, input.sourceIds);
    if (!answers) {
      const known = answered[0] ? ` The message before it, as the program has it: 「${clip(answered[0], ANSWERS_SHOWN)}」` : '';
      return `「${clip(input.quote, 60)}」 is too short to stand alone as an Owner's words item (when the owner says “ok” or 「可以」, look at what it answers). Give answers: the message it answers, copied from the session or the record cited (…… where you leave words out).${known} A line that was for its moment only forms no item: judge it with pk_judge_owner_lines instead. Nothing was written.`;
    }
    const parts = wordParts(answers);
    if (parts.length && answered.some((m) => { const words = fold(m); return parts.every((part) => words.includes(part)); })) return null;
    if (checkVerbatim(store, answers, input.sourceIds).missing.length === 0) return null;
    return `answers is the message the owner's words answer, copied from where it was said (…… where you leave words out): what you gave stands neither in the sources cited nor in the agent's message before the owner's line${answered[0] ? `, which the program has as 「${clip(answered[0], ANSWERS_SHOWN)}」` : ''}. Copy it; a summary of yours goes in text. Nothing was written.`;
  } finally {
    ledger?.close();
  }
}
