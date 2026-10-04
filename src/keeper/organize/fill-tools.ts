/**
 * The workbench as a fill-in-the-blank (D99; Spec §3.3 "工作台是一道填空题"; CKC-23 AC-21): what a document writes
 * outright becomes a slot, named as the document names it and cited to its line. The model says which table or which
 * headings, and what each column is; the program copies — one call per table instead of one writer call per row (on the
 * resident run, 100 of the skeleton's 126 nodes were rows and headings the model wrote out one by one).
 *
 * - `pk_fill_from_table`: each row of one table becomes a work item and/or a reference item; the columns the model names
 *   give its title, its project id, what it hangs under (`parent`), its plan, what it depends on, and its written status.
 * - `pk_fill_from_headings`: each heading of one level (under one heading, when named) becomes a reference item — an ADR's
 *   decisions, a PRD's goals, a design's modules.
 *
 * Both write through the writers the model uses (`pk_write_reference`, `pk_write_thread`, `pk_relate` in tools.ts): the
 * same validation, the same ids, the same one-item-per-project-id matching. Names are verbatim, basis `Explicit`, and each
 * item cites the file's section source that holds its line (the source `pk_list_sources` lists by path). A written status
 * stays a written status (`writtenStatus`); progress is set only through the model's `statusMap` — "ready" is not a
 * progress (§2.2). Running the same table again updates what it wrote. What the tools cannot judge — which document is
 * which layer, what a column means — is the model's.
 *
 * DB: whether a status word is progress or readiness is no longer left to the caller for the words the program knows
 * (readiness.ts): a `statusMap` entry from a word for the readiness or approval of the document itself — ready, draft,
 * approved, accepted, final and their Chinese counterparts — is refused, naming the rule, while the rest of the call goes
 * through; the rows that write such a word come back counted (`progressToJudge`), their progress left for the lane to
 * judge from the execution records. On the DeepSeek run a brief's 「statusMap：ready→Planned」 was taken as given.
 */
import { areaNames } from './placing.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { markdownTables, type MarkdownTable } from '../../ledger/arrangements.ts';
import type { ClerkStage, SlotKind } from '../../model/k-types.ts';
import type { KeeperJob, ReferenceItem, Source, WorkThread, WrittenStatus } from '../../model/types.ts';
import { stableId } from '../../model/ids.ts';
import { OWNER_WORDS, PROGRESS, REFERENCE_CATEGORY, isOneOf } from '../../model/vocab.ts';
import { redactCredentials } from '../../sources/anchor.ts';
import { pathKey } from '../../util/paths.ts';
import { SLOT_WRITERS, STAGE_WRITERS } from '../clerk-steps.ts';
import type { ClerkToolContext } from '../clerk-tools.ts';
import { resolvePath } from '../evidence.ts';
import { resolveMergedId } from '../merge.ts';
import { keeperTools, primaryIdentifier } from '../tools.ts';
import { otherObjectOf, withNumbering } from '../numbers-check.ts';
import { entriesOf } from './entries.ts';
import { definitionsInText, isSeriesOnlyFamily } from '../../ledger/numbering.ts';
import { READINESS_EXAMPLES, READINESS_RULE, READINESS_SENTENCE, readinessWord } from './readiness.ts';

type FillTool = 'pk_fill_from_table' | 'pk_fill_from_headings' | 'pk_fill_from_bold';

/** What one call returns (W0 contract §6), plus what could not be tied (`unlinked`) and why nothing was (`note`). */
interface FillResult {
  written: number;
  updated: number;
  items: { id: string; title: string; line: number; referenceId?: string }[];
  skipped: { line: number; why: string }[];
  unlinked?: { line: number; column: string; value: string; why: string }[];
  /** CZ: dependencies this tool wrote from the same column before and took back, because the cell does not state them outright. */
  removed?: { line: number; column: string; value: string; why: string }[];
  warnings?: string[];
  /** DB: the statusMap entries not taken — a readiness word mapped to a progress — each with the rule. */
  refused?: { statusMap: string; why: string }[];
  /** DB: the work-item rows whose status writes readiness, not progress: how many, which words, their lines, and what to do. */
  progressToJudge?: { rows: number; statuses: Record<string, number>; lines: number[]; note: string };
  note?: string;
  tables?: { line: number; under: string | null; columns: readonly string[]; rows: number }[];
}

// ───────────────────────── small helpers ─────────────────────────

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const redact = (s: string): string => redactCredentials(s).text;
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
const either = (list: readonly string[]): string => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`);

/** A cell or heading as the reader sees it: link text for links, no bold or code markers; the words themselves untouched. */
export function plainCell(cell: string): string {
  return cell
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\\\|/g, '|')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An empty cell: nothing, or only dashes and punctuation ("—", "-", "/"). */
const blank = (s: string): boolean => !/[\p{L}\p{N}]/u.test(s);
/** Whether a title already opens with the number (`CKC-22 账本…`, `[AP] …`), so the number is not written before it again. */
const opensWith = (title: string, number: string): boolean => {
  const n = number.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[\\s[(（]*${n}(?![\\p{L}\\p{N}_])`, 'iu').test(title);
};

function ok(value: FillResult) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }], details: {} };
}
function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }], details: {}, isError: true };
}

interface Heading { readonly level: number; readonly text: string; readonly line: number }

/** The Markdown headings of a text, outside code fences, with their 1-based lines. */
function headingsOf(lines: readonly string[]): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (fence) return;
    const m = /^(#{1,6})\s+(.*)$/.exec(l);
    if (m) out.push({ level: m[1]!.length, text: plainCell(m[2]!.replace(/\s+#+\s*$/, '')), line: i + 1 });
  });
  return out;
}
/** The last line of a heading's scope: before the next heading of its level or higher, or the end of the text. */
function scopeEnd(headings: readonly Heading[], h: Heading, lineCount: number): number {
  const next = headings.find((x) => x.line > h.line && x.level <= h.level);
  return next ? next.line - 1 : lineCount;
}
/** The heading a line stands under, or null. */
function headingAbove(headings: readonly Heading[], line: number): Heading | null {
  let found: Heading | null = null;
  for (const h of headings) { if (h.line >= line) break; found = h; }
  return found;
}

/** Identifier ranges a cell writes ("CKC-02～CKC-05"), expanded; the other identifiers as written. */
function identifiersIn(s: string): string[] {
  const out: string[] = [];
  const range = /([A-Za-z]{1,6}-?)(\d{1,4})\s*[～~–—]\s*(?:\1)?(\d{1,4})/g;
  let rest = s;
  for (const m of s.matchAll(range)) {
    const from = Number(m[2]), to = Number(m[3]);
    if (to >= from && to - from <= 200) for (let n = from; n <= to; n++) out.push(`${m[1]}${String(n).padStart(m[2]!.length, '0')}`);
    rest = rest.replace(m[0], ' ');
  }
  for (const m of rest.matchAll(/\b([A-Za-z]{1,6}(?:-[A-Za-z]{1,4})?-?\d{1,4}(?:\.\d{1,3})*)\b/g)) out.push(m[1]!);
  return out;
}

const IDENTIFIER = String.raw`[A-Za-z]{1,6}(?:-[A-Za-z]{1,4})?-?\d{1,4}(?:\.\d{1,3})*`;
/** A part of a clause that is an identifier and nothing else: one (`CKC-02`, `AP`), or a range (`CKC-07～CKC-09`). */
const ONLY_IDENTIFIERS = new RegExp(`^(?:(?:${IDENTIFIER})(?:\\s*[～~–—]\\s*(?:${IDENTIFIER}|\\d{1,4}))?|[A-Z]{2})$`);
/** A clause that says there is no dependency. */
const NO_DEPENDENCY = /^(?:无|没有|none|n\/a|na|nil)$/i;

// ───────────────────────── the tools ─────────────────────────

export function fillTools(ctx: ClerkToolContext): ToolDefinition[] {
  const { store, project } = ctx;
  const trace = (summary: string, basisSourceIds: readonly string[] = []) => ({ jobId: ctx.jobId, basisSourceIds, summary });

  // The model's own writers, called as the model calls them: one way to write an item.
  let writers: ToolDefinition[] | null = null;
  const write = async (name: 'pk_write_reference' | 'pk_write_thread' | 'pk_relate', params: Record<string, unknown>): Promise<{ id: string; warning?: string } | { error: string }> => {
    writers ??= keeperTools(ctx);
    const tool = writers.find((t) => t.name === name)!;
    const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    try {
      const result = await run('fill', params);
      const body = result.content.map((c) => c.text).join('\n');
      if (result.isError) return { error: body.replace(/^ERROR:\s*/, '') };
      const json = JSON.parse(body) as { id: string; warning?: string };
      return json;
    } catch (e) {
      return { error: (e as Error).message };
    }
  };

  /** Why this job may not fill these slots, or null (D99: the main agent in skeleton and reconcile; a lane in its slots). */
  const gate = (tool: FillTool, writes: { threads: boolean; category: string | null }): string | null => {
    const step = ctx.step;
    if (!step) return `${tool} fills the workbench’s slots in a round of the clerk method, and this job is no step of a round, so nothing was written.`;
    if (step.kind === 'main') {
      const stage: ClerkStage | null = store.clerkRounds.get(step.roundId)?.stage ?? null;
      const stages = (Object.keys(STAGE_WRITERS) as ClerkStage[]).filter((s) => STAGE_WRITERS[s].includes(tool));
      if (!stage) return `${tool} is the main agent’s in the ${either(stages)} stage, and this round has entered no stage yet (pk_stage), so nothing was written.`;
      if (!STAGE_WRITERS[stage].includes(tool)) return `${tool} is the main agent’s in the ${either(stages)} stage; this round is in ${stage}, so nothing was written.`;
      return null;
    }
    if (step.kind === 'lane') {
      // The job's step as the runtime gives it (KeeperJob['step']): a lane carries its slots (W0).
      const slots: readonly SlotKind[] = (step as NonNullable<KeeperJob['step']>).lane?.slots ?? [];
      const writersOf = (slot: string): readonly string[] => (SLOT_WRITERS as Readonly<Record<string, readonly string[]>>)[slot.startsWith('reference:') ? 'reference' : slot] ?? [];
      if (!slots.some((s) => writersOf(s).includes(tool))) return `${tool} fills ${tool === 'pk_fill_from_headings' ? 'reference items' : 'work items or reference items'}, and this lane writes ${slots.length ? slots.join(', ') : 'no slot'}, so nothing was written.`;
      if (writes.threads && !slots.includes('threads')) return `Work items are the threads slot, and this lane writes ${slots.join(', ')}, so nothing was written. Fill reference items only (into: "reference"), or leave the work items to the lane that has them.`;
      if (writes.category && !slots.some((s) => s.toLowerCase() === `reference:${writes.category}`.toLowerCase())) {
        return `${writes.category} items are the reference:${writes.category} slot, and this lane writes ${slots.join(', ')}, so nothing was written.${writes.threads ? ' Leave category out to fill only the work items.' : ''}`;
      }
      return null;
    }
    return `${tool} belongs to a round run by one main agent with its lanes — the main agent in skeleton and reconcile, a lane in its reference and threads slots — and this job is the ${step.kind} step of the earlier method, where each step was a job of its own, so nothing was written.`;
  };

  /** The document, read now from the project, with its path relative to its repository. */
  const readDocument = (path: string): { rel: string; abs: string; rootId: string; lines: string[] } | string => {
    const place = resolvePath(project, { path });
    if (typeof place === 'string') return place;
    if (!place.rel) return `give the path of a file inside ${place.root.path}.`;
    const abs = join(place.root.path, place.rel);
    let body: string;
    try { body = readFileSync(abs, 'utf8'); } catch { return `${place.rel} is not a file in ${place.root.path} now: the fill-in tools copy what a current document writes. An earlier version is read with pk_history_read and written with the writers.`; }
    return { rel: place.rel, abs, rootId: place.root.id, lines: body.split(/\r?\n/) };
  };

  /** The file's section source that holds this line as it is written now, or why none does. */
  const sourcesOf = (doc: { abs: string; rootId: string }) => {
    const key = pathKey(doc.abs);
    const all = store.sources.filter((s) => s.anchor.kind === 'file' && pathKey(s.anchor.path) === key && s.availability !== 'No longer available');
    return (line: number, written: string): Source | string => {
      if (all.length === 0) return 'no source of this project is this file yet (it is read into the sources when the project is scanned), so the row has nothing to cite';
      const holding = all.filter((s) => s.anchor.kind === 'file' && s.anchor.lineStart <= line && line <= s.anchor.lineEnd)
        .sort((a, b) => (a.scopeItemId === doc.rootId ? 0 : 1) - (b.scopeItemId === doc.rootId ? 0 : 1)
          || (a.anchor.kind === 'file' && b.anchor.kind === 'file' ? (a.anchor.lineEnd - a.anchor.lineStart) - (b.anchor.lineEnd - b.anchor.lineStart) : 0));
      const words = redact(written).trim();
      const hit = holding.find((s) => s.excerpt.includes(words));
      if (hit) return hit;
      return holding.length
        ? `the file changed since its sources were read: the source that holds line ${line} does not have it as written now, so the row is not cited to a line it does not hold (the next scan reads the file again)`
        : `no source of this file holds line ${line} (the file changed since its sources were read; the next scan reads it again)`;
    };
  };

  /** A reference item this call would update: the one of the category carrying the identifier, or its stable id. */
  const existingReference = (category: string, identifier: string | null, fallbackId: string): ReferenceItem | undefined =>
    identifier
      ? store.reference.find((r) => r.category === category && (r.ids.some((x) => x.toUpperCase() === identifier) || primaryIdentifier(r.ids, r.name) === identifier))
      : store.reference.get(fallbackId);
  /** A work item this call would update: the one carrying the identifier, or its stable id. */
  const existingThread = (identifier: string | null, fallbackId: string): WorkThread | undefined =>
    identifier
      ? store.threads.find((t) => t.ids.some((x) => x.toUpperCase() === identifier) || primaryIdentifier(t.ids, t.title) === identifier)
      : store.threads.get(resolveMergedId(store, fallbackId));

  /** Keep the written status on the item: the document's words, not its progress (AC-21). */
  const keepStatus = (kind: 'threads' | 'reference', id: string, status: WrittenStatus | null) => {
    const item = kind === 'threads' ? store.threads.get(id) : store.reference.get(id);
    if (!item) return;
    const before = item.writtenStatus ?? null;
    if (JSON.stringify(before) === JSON.stringify(status)) return;
    const summary = status ? `Written status “${status.text}” (line ${status.line})` : 'No written status any more';
    if (kind === 'threads') store.threads.put({ ...(item as WorkThread), writtenStatus: status }, trace(summary, status ? [status.sourceId] : []));
    else store.reference.put({ ...(item as ReferenceItem), writtenStatus: status }, trace(summary, status ? [status.sourceId] : []));
  };

  /** The one item a cell names among the candidates: by id, project id, name, or as a whole word of one name. */
  const named = <T extends { id: string }>(candidates: readonly T[], value: string, ids: (c: T) => readonly string[], name: (c: T) => string): T | string => {
    const v = value.trim();
    const upper = v.toUpperCase();
    const byId = candidates.find((c) => c.id === v);
    if (byId) return byId;
    const byNumber = candidates.filter((c) => ids(c).some((x) => x.toUpperCase() === upper) || primaryIdentifier(ids(c), name(c)) === upper);
    if (byNumber.length === 1) return byNumber[0]!;
    const byName = candidates.filter((c) => squash(plainCell(name(c))) === squash(v));
    if (byName.length === 1) return byName[0]!;
    if (byNumber.length > 1 || byName.length > 1) return `several items carry “${v}”: ${[...byNumber, ...byName].slice(0, 5).map((c) => `${c.id} (${name(c)})`).join(', ')}`;
    // D101 (CM): an Area's short form names it — a Module column's 「贯穿」 is the Area 「贯穿 · Keeper runtime 与项目资产」.
    const byShort = candidates.filter((c) => (c as { category?: string }).category === 'Area' && areaNames({ name: name(c), ids: ids(c) }).some((n) => n.toLowerCase() === v.toLowerCase()));
    if (byShort.length === 1) return byShort[0]!;
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Case as written: a one-letter increment ("A") is not the article of another name.
    const word = new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_])`, 'u');
    const byWord = candidates.filter((c) => word.test(plainCell(name(c))));
    if (byWord.length === 1) return byWord[0]!;
    return byWord.length > 1 ? `“${v}” is a word of several names: ${byWord.slice(0, 5).map((c) => `${c.id} (${name(c)})`).join(', ')}` : `nothing in the assets is named “${v}”`;
  };
  /** Every item a cell names: the whole cell, or else each part of a list ("CK-M2、CK-M3"), or else each identifier in it. */
  const namedAll = <T extends { id: string }>(candidates: readonly T[], cell: string, ids: (c: T) => readonly string[], name: (c: T) => string): { found: T[]; missing: { value: string; why: string }[] } => {
    const whole = named(candidates, cell, ids, name);
    if (typeof whole !== 'string') return { found: [whole], missing: [] };
    const found: T[] = [];
    const missing: { value: string; why: string }[] = [];
    for (const part of cell.split(/[,，、;；/]+/).map((p) => p.trim()).filter((p) => !blank(p))) {
      const hit = named(candidates, part, ids, name);
      if (typeof hit !== 'string') { found.push(hit); continue; }
      const numbers = identifiersIn(part);
      const hits = numbers.map((n) => named(candidates, n, ids, name));
      const good = hits.filter((h): h is T => typeof h !== 'string');
      if (good.length) found.push(...good);
      const bad = numbers.filter((_, i) => typeof hits[i] === 'string');
      if (!numbers.length) missing.push({ value: part, why: hit });
      else for (const n of bad) missing.push({ value: n, why: hits[numbers.indexOf(n)] as string });
    }
    return { found: [...new Map(found.map((f) => [f.id, f])).values()], missing };
  };

  /**
   * CZ: what a "depends on" cell states outright. A cell is read clause by clause (`；`, `;`, `。`); a clause that holds
   * nothing but identifiers — a list, a range, the names of items — gives its dependencies; a clause that says more
   * (`AC 级：CKC-08、CKC-09`, `经 CKC-04 验收`, `P1 评审`) is not linked at all and comes back with the cell's text, for the
   * lane to judge what it states. (On the flash run every identifier of such a clause became a dependency.)
   */
  const dependenciesIn = <T extends { id: string }>(candidates: readonly T[], cell: string, ids: (c: T) => readonly string[], name: (c: T) => string): { found: T[]; missing: { value: string; why: string }[] } => {
    const whole = named(candidates, cell, ids, name);
    if (typeof whole !== 'string') return { found: [whole], missing: [] };
    const found: T[] = [];
    const missing: { value: string; why: string }[] = [];
    for (const clause of cell.split(/[;；。]+/).map((c) => c.trim()).filter((c) => !blank(c))) {
      if (NO_DEPENDENCY.test(clause)) continue;
      const parts = clause.split(/[,，、/]+|\s+(?:and|和|及|与)\s+|\s*[&+]\s*/).map((x) => x.trim()).filter((x) => !blank(x));
      const read = parts.map((part) => {
        const hit = named(candidates, part, ids, name);
        if (typeof hit !== 'string') return { items: [hit], unknown: [] as { value: string; why: string }[] };
        if (!ONLY_IDENTIFIERS.test(part)) return null;
        const numbers = identifiersIn(part).length ? identifiersIn(part) : [part];
        const hits = numbers.map((n) => named(candidates, n, ids, name));
        return { items: hits.filter((h): h is T => typeof h !== 'string'), unknown: numbers.flatMap((n, i) => (typeof hits[i] === 'string' ? [{ value: n, why: hits[i] as string }] : [])) };
      });
      if (read.some((r) => r === null)) {
        missing.push({ value: clause, why: `this clause says more than identifiers, so nothing in it was linked: read what it states and write the dependencies that follow yourself (pk_write_thread dependsOn; pk_relate for reference items). The cell: “${cell}”` });
        continue;
      }
      for (const r of read) { found.push(...r!.items); missing.push(...r!.unknown); }
    }
    return { found: [...new Map(found.map((f) => [f.id, f])).values()], missing };
  };

  /** Whose number this is when it is another object's (a decision's, a module's), or null (numbers-check.ts). */
  const otherNumber = (n: string): string | null => withNumbering(store, (ledger) => otherObjectOf(store, ledger, n), null);

  const referenceIds = (r: ReferenceItem) => r.ids;
  const referenceName = (r: ReferenceItem) => r.name;

  const tools: ToolDefinition[] = [];

  // ───────────────────────── a table: one item per row ─────────────────────────

  tools.push(defineTool({
    name: 'pk_fill_from_table', label: 'Fill slots from a table',
    description: 'Fill the workbench from one Markdown table: each row becomes a work item (into "threads"), a reference item of category (into "reference"), or both (into "threads" with a category — a plan’s contract table gives each contract as a Requirement and a Work item). You say which table — the line of any of its rows, or a heading it stands under — and which column is what; the program copies: the title verbatim (a reference item is named “number · title” when the id column gives its number, as a heading is; a work item keeps the title and carries the number in its ids), the project id, basis Explicit, the file’s section source of the row, and the row’s line. columns name the table’s own headers: title (required), id, parent (the Area, Goal or other reference item it hangs under — a name or a project id, several separated by commas or 、), plan (the Plan item a work item belongs to), dependsOn (the work items it depends on; ranges like T-02～T-05 are read; only a clause that holds nothing but identifiers is linked — a clause that says more, like “T-08, its interface only” or “once T-04 is accepted”, comes back in unlinked with the cell’s text for you to judge, and a dependency this tool wrote from such a clause before is taken back and listed in removed), status (kept as the written status). Progress is yours to judge: a status becomes progress only through statusMap, and only where the word states progress, e.g. { "done": "Done" }. ' + READINESS_SENTENCE + ': a statusMap entry from such a word is refused (it comes back in refused; the rest of the call goes through), whoever asked for it, and the rows that write one come back counted in progressToJudge — judge each one’s progress from the execution records (the tickets that implement it, their deliveries and checks) and write it with pk_write_thread. A new work item starts Planned until you judge it. Running the same table again updates the items it wrote. Rows that cannot be written come back in skipped, with why; a parent, plan or dependency no item answers to comes back in unlinked. A file with no such table writes nothing and lists its tables.',
    parameters: Type.Object({
      path: Type.String({ description: 'the document, relative to the repository root' }),
      table: Type.Object({
        line: Type.Optional(Type.Number({ description: 'a line of the table (its header or any row), or the heading line it stands under' })),
        heading: Type.Optional(Type.String({ description: 'words of the heading the table stands under, e.g. "Task index"' })),
      }, { description: 'which table; leave both out when the file has one table' }),
      into: Type.String({ description: 'threads | reference' }),
      category: Type.Optional(Type.String({ description: `the reference category of each row: ${REFERENCE_CATEGORY.filter((c) => c !== OWNER_WORDS).join(', ')} — needed with into "reference"; with into "threads", each row is also this reference item and its work item serves it` })),
      columns: Type.Object({
        title: Type.String({ description: 'the column that names each row' }),
        id: Type.Optional(Type.String({ description: 'the column with the project’s own id (T-22, #18 …)' })),
        parent: Type.Optional(Type.String({ description: 'the column naming what it hangs under (an Area, a Goal …)' })),
        plan: Type.Optional(Type.String({ description: 'the column naming the Plan item (an increment, a phase) a work item belongs to' })),
        dependsOn: Type.Optional(Type.String({ description: 'the column listing what it depends on' })),
        status: Type.Optional(Type.String({ description: 'the column with the status the document writes' })),
      }, { description: 'each field: a header of the table, as written' }),
      statusMap: Type.Optional(Type.Record(Type.String(), Type.String(), { description: `written status → progress (${PROGRESS.join(', ')}), for the statuses that state progress; never from a readiness word (${READINESS_EXAMPLES})` })),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const into = text(p.into);
      if (into !== 'threads' && into !== 'reference') return fail('into is "threads" (work items) or "reference" (reference items of category).');
      const category = text(p.category).trim() || null;
      if (category !== null && !isOneOf(REFERENCE_CATEGORY, category)) return fail(`category must be one of ${REFERENCE_CATEGORY.join(', ')}.`);
      if (category === OWNER_WORDS) return fail('Owner’s words carry the owner’s own quote from where they were said: write them with pk_write_reference, one by one.');
      if (into === 'reference' && !category) return fail('into "reference" needs category: which reference item each row is.');
      const refusal = gate('pk_fill_from_table', { threads: into === 'threads', category });
      if (refusal) return fail(refusal);
      const columns = (p.columns ?? {}) as Record<string, unknown>;
      if (into === 'reference' && text(columns.plan)) return fail('plan places a work item under its Plan item; a reference item hangs under what parent names. Leave plan out, or fill into "threads".');
      const statusMap = new Map<string, WorkThread['progress']>();
      // DB: a readiness word maps to no progress, whoever asked for the mapping (readiness.ts). The entry is not taken; the
      // call goes on, and the rows that write the word keep it as their written status.
      const refused: NonNullable<FillResult['refused']> = [];
      for (const [k, v] of Object.entries((p.statusMap ?? {}) as Record<string, unknown>)) {
        if (!isOneOf(PROGRESS, v)) return fail(`statusMap: “${k}” maps to “${text(v)}”, and progress is one of ${PROGRESS.join(', ')}.`);
        if (readinessWord(plainCell(k))) { refused.push({ statusMap: `“${k}” → ${v}`, why: `Not taken: ${READINESS_RULE}. The rows that write it are listed in progressToJudge.` }); continue; }
        statusMap.set(squash(plainCell(k)), v);
      }
      const doc = readDocument(text(p.path));
      if (typeof doc === 'string') return fail(doc);
      const headings = headingsOf(doc.lines);
      const all = markdownTables(doc.lines.join('\n'));
      const listing = () => all.map((t) => ({ line: t.line, under: headingAbove(headings, t.line)?.text ?? null, columns: t.header, rows: t.rows.length }));
      const nothing = (note: string): FillResult => ({ written: 0, updated: 0, items: [], skipped: [], note, ...(all.length ? { tables: listing() } : {}) });
      if (all.length === 0) return ok(nothing(`${doc.rel} has no table.`));

      // Which table: the one holding the line, or the first under it; the first under the heading; the only one.
      const where = (p.table ?? {}) as Record<string, unknown>;
      const line = typeof where.line === 'number' ? Math.trunc(where.line) : null;
      const heading = text(where.heading).trim();
      const last = (t: MarkdownTable) => t.rows[t.rows.length - 1]?.line ?? t.line + 1;
      let table: MarkdownTable | undefined;
      if (line !== null) {
        table = all.find((t) => t.line <= line && line <= last(t));
        if (!table) {
          const next = headings.find((h) => h.line > line);
          table = all.find((t) => t.line >= line && (!next || t.line < next.line));
        }
        if (!table) return ok(nothing(`No table of ${doc.rel} is at line ${line} or right under it.`));
      } else if (heading) {
        const wanted = squash(plainCell(heading));
        for (const h of headings.filter((x) => squash(x.text).includes(wanted))) {
          const end = scopeEnd(headings, h, doc.lines.length);
          table = all.find((t) => t.line > h.line && t.line <= end);
          if (table) break;
        }
        if (!table) return ok(nothing(`No table of ${doc.rel} stands under a heading with “${heading}”.`));
      } else if (all.length === 1) {
        table = all[0];
      } else {
        return ok(nothing(`${doc.rel} has ${all.length} tables: say which with table.line or table.heading.`));
      }
      const t = table!;

      // Which column is what: the model's naming of the table's own headers.
      const header = t.header.map((h) => squash(plainCell(h)));
      const col: Partial<Record<'title' | 'id' | 'parent' | 'plan' | 'dependsOn' | 'status', number>> = {};
      for (const field of ['title', 'id', 'parent', 'plan', 'dependsOn', 'status'] as const) {
        const given = text(columns[field]).trim();
        if (!given) continue;
        const k = header.indexOf(squash(plainCell(given)));
        if (k < 0) return fail(`columns.${field}: “${given}” is not a column of the table at line ${t.line} of ${doc.rel}; its columns are ${t.header.map((h) => `“${h}”`).join(', ')}.`);
        col[field] = k;
      }
      if (col.title === undefined) return fail('columns.title: the column that names each row.');
      const cell = (row: MarkdownTable['rows'][number], field: keyof typeof col): string => (col[field] === undefined ? '' : plainCell(row.cells[col[field]!] ?? ''));

      const sourceAt = sourcesOf(doc);
      const result: FillResult = { written: 0, updated: 0, items: [], skipped: [] };
      const unlinked: NonNullable<FillResult['unlinked']> = [];
      const removed: NonNullable<FillResult['removed']> = [];
      const warnings = new Set<string>();
      const seen = new Map<string, number>();
      const readiness: { line: number; word: string }[] = [];
      const done: { line: number; title: string; source: Source; threadId: string | null; referenceId: string | null; row: MarkdownTable['rows'][number]; warning: string | null }[] = [];

      // Pass 1: every row's item(s), named and cited as the document writes them.
      for (const row of t.rows) {
        const title = redact(cell(row, 'title'));
        if (blank(title)) { result.skipped.push({ line: row.line, why: `the ${t.header[col.title]} column is empty` }); continue; }
        const source = sourceAt(row.line, doc.lines[row.line - 1] ?? '');
        if (typeof source === 'string') { result.skipped.push({ line: row.line, why: source }); continue; }
        const idCell = cell(row, 'id');
        // The project's own id (CKC-22, #18, and two capitals like AS in an index — CJ); a bare row number (1, 2 …) numbers
        // the row, not the work, and is not one.
        // CQ (D104): a Plan's id is whatever its table's first column writes — a batch label (`批次 1`, `M1`, `Sprint 3`) as well
        // as a number — so every writer that names a Plan by that id finds it. Other categories keep to the numbering shapes.
        const planLabel = category === 'Plan' && idCell && /^[\p{L}\p{N}][\p{L}\p{N}.-]{0,11}(?:\s?\p{N}{1,3})?$/u.test(idCell.trim()) && !/^\d+$/.test(idCell.trim()) ? idCell.trim() : '';
        const numbered = idCell && (primaryIdentifier([idCell], '') || /^#\d+$/.test(idCell)) ? idCell : planLabel;
        const titled = numbered ? null : primaryIdentifier([], title);
        // CJ: a title that opens with another object's number (D99 W1+W2 …) does not give the row that number.
        const identifier = numbered ? primaryIdentifier([numbered], '') ?? numbered.toUpperCase() : titled && !otherNumber(titled) ? titled : null;
        const key = identifier ?? `${pathKey(doc.rel)}\u0000${blank(idCell) ? squash(title) : squash(idCell)}`;
        if (seen.has(key)) { result.skipped.push({ line: row.line, why: `row ${seen.get(key)} already wrote ${identifier ?? `“${title}”`}: one item per id` }); continue; }
        seen.set(key, row.line);
        const statusText = cell(row, 'status');
        const progress = statusText ? statusMap.get(squash(statusText)) ?? null : null;
        const status: WrittenStatus | null = col.status === undefined ? null : blank(statusText) ? null : { text: statusText, sourceId: source.id, line: row.line };
        const rowText = t.header.map((h, k) => [h, plainCell(row.cells[k] ?? '')] as const).filter(([, v]) => !blank(v)).map(([h, v]) => `${h}: ${v}`).join(' · ');
        const ids = identifier ? [numbered || identifier] : [];
        // CZ: a row's reference item is named "number · title", as a heading's is — the number its id column writes, then
        // the title. (Named by the title alone, a lane "fixed" a Decision's name by writing its number as an id, and the
        // number stood twice.) A work item keeps the title as written: it carries the number in its ids, and every view
        // and block writes that number before its title.
        const name = numbered && !opensWith(title, numbered) ? `${numbered.trim()} · ${title}` : title;
        let existed = false;
        let warning: string | null = null;

        let referenceId: string | null = null;
        if (category) {
          const fallback = stableId('ref', project.id, category, pathKey(doc.rel), key);
          const previous = existingReference(category, identifier, fallback);
          existed ||= Boolean(previous);
          const params: Record<string, unknown> = previous
            ? { id: previous.id, name, text: redact(rowText), sourceIds: [...new Set([...previous.sourceIds, source.id])], ...(into === 'reference' && progress ? { progress } : {}) }
            : {
              ...(identifier ? {} : { id: fallback }), category, name, ids, text: redact(rowText),
              basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [source.id], ...(into === 'reference' && progress ? { progress } : {}),
            };
          const w = await write('pk_write_reference', params);
          if ('error' in w) { result.skipped.push({ line: row.line, why: w.error }); continue; }
          referenceId = w.id;
          warning = w.warning ?? null;
          keepStatus('reference', w.id, status);
        }

        let threadId: string | null = null;
        if (into === 'threads') {
          const fallback = stableId('thread', project.id, pathKey(doc.rel), key);
          const previous = existingThread(identifier, fallback);
          existed ||= Boolean(previous);
          // CZ: the row's source is kept on the work item as what it was written from (inputs.sourceIds), so a generation
          // can tell the items written from its own documents (generation-check.ts `originOf`).
          const from = { ...(previous?.inputs ?? {}), sourceIds: [...new Set([...(previous?.inputs?.sourceIds ?? []), source.id])] };
          const params: Record<string, unknown> = previous
            ? { id: previous.id, title, inputs: from, ...(progress ? { progress } : {}) }
            : { ...(identifier ? {} : { id: fallback }), title, ids, progress: progress ?? 'Planned', inputs: from };
          const w = await write('pk_write_thread', params);
          if ('error' in w) { result.skipped.push({ line: row.line, why: w.error }); continue; }
          threadId = w.id;
          warning = w.warning ?? null;
          keepStatus('threads', w.id, status);
        }
        if (existed) result.updated += 1; else result.written += 1;
        const word = threadId && !progress && statusText ? readinessWord(statusText) : null;
        if (word) readiness.push({ line: row.line, word });
        result.items.push({ id: (threadId ?? referenceId)!, title: threadId ? title : name, line: row.line, ...(threadId && referenceId ? { referenceId } : {}) });
        done.push({ line: row.line, title: threadId ? title : name, source, threadId, referenceId, row, warning });
      }

      // Pass 2: what each row hangs under, belongs to and depends on — rows of this table included.
      const claimAt = (column: 'parent' | 'plan' | 'dependsOn', value: string, line: number) => `${doc.rel}, line ${line}: ${t.header[col[column]!]} “${value}”`;
      for (const r of done) {
        let warning = r.warning;
        const references = store.reference.all();
        const parentCell = cell(r.row, 'parent');
        const parents = blank(parentCell) ? { found: [], missing: [] } : namedAll(references.filter((x) => x.id !== r.referenceId), parentCell, referenceIds, referenceName);
        for (const m of parents.missing) unlinked.push({ line: r.line, column: 'parent', value: m.value, why: m.why });
        const planCell = cell(r.row, 'plan');
        const plans = blank(planCell) ? { found: [], missing: [] } : namedAll(references.filter((x) => x.category === 'Plan'), planCell, referenceIds, referenceName);
        for (const m of plans.missing) unlinked.push({ line: r.line, column: 'plan', value: m.value, why: `${m.why} among the Plan items` });
        const depCell = cell(r.row, 'dependsOn');

        if (r.referenceId && parents.found.length) {
          const item = store.reference.get(r.referenceId)!;
          const refines = [...new Set([...item.refines, ...parents.found.map((x) => x.id)])];
          if (refines.length !== item.refines.length) {
            const w = await write('pk_write_reference', { id: r.referenceId, refines });
            if ('error' in w) unlinked.push({ line: r.line, column: 'parent', value: parentCell, why: w.error });
            else if (!r.threadId) warning = w.warning ?? null;
          }
        }
        // CZ: a dependency this tool wrote from this column before (its claim says so) that the cell does not state
        // outright is taken back; what a lane or the main agent wrote with a claim of its own stays.
        const fromThisColumn = (claim: string): boolean => col.dependsOn !== undefined && claim.startsWith(`${doc.rel}, line `) && claim.includes(`: ${t.header[col.dependsOn]} “`);
        const NOT_STATED = 'the fill wrote it from this cell before; the cell does not state it outright (it stands in a clause that says more than identifiers)';
        if (r.referenceId && !r.threadId && col.dependsOn !== undefined) {
          const deps = blank(depCell) ? { found: [], missing: [] } : dependenciesIn(store.reference.all().filter((x) => x.id !== r.referenceId), depCell, referenceIds, referenceName);
          for (const m of deps.missing) unlinked.push({ line: r.line, column: 'dependsOn', value: m.value, why: m.why });
          for (const d of deps.found) {
            const w = await write('pk_relate', { type: 'depends on', fromId: r.referenceId, toId: d.id, claim: claimAt('dependsOn', depCell, r.line), basis: 'Explicit', evidenceSourceIds: [r.source.id] });
            if ('error' in w) unlinked.push({ line: r.line, column: 'dependsOn', value: d.id, why: w.error });
          }
          for (const old of store.relations.filter((x) => x.type === 'depends on' && x.from === r.referenceId && fromThisColumn(x.claim) && !deps.found.some((d) => d.id === x.to))) {
            const w = await write('pk_relate', { type: 'depends on', fromId: old.from, toId: old.to, withdraw: true, why: NOT_STATED });
            if (!('error' in w)) removed.push({ line: r.line, column: 'dependsOn', value: store.reference.get(old.to)?.ids[0] ?? old.to, why: NOT_STATED });
          }
        }
        if (r.threadId) {
          const serves = [
            ...parents.found.map((x) => ({ referenceId: x.id, claim: claimAt('parent', parentCell, r.line), basis: 'Explicit' })),
            ...(r.referenceId ? [{ referenceId: r.referenceId, claim: `${doc.rel}: the same row (line ${r.line})`, basis: 'Explicit' }] : []),
            ...plans.found.map((x) => ({ referenceId: x.id, claim: claimAt('plan', planCell, r.line), basis: 'Explicit' })),
          ];
          const threads = store.threads.all().filter((x) => x.id !== r.threadId);
          const deps = blank(depCell) ? { found: [], missing: [] } : dependenciesIn(threads, depCell, (x) => x.ids, (x) => x.title);
          for (const m of deps.missing) unlinked.push({ line: r.line, column: 'dependsOn', value: m.value, why: m.why });
          const dependsOn = deps.found.map((x) => ({ threadId: x.id, claim: claimAt('dependsOn', depCell, r.line), basis: 'Explicit' }));
          const standing = store.threads.get(r.threadId)?.dependsOn ?? [];
          const stale = standing.filter((d) => fromThisColumn(d.claim) && !deps.found.some((x) => x.id === d.threadId));
          if (serves.length || dependsOn.length || stale.length) {
            const whole = stale.length ? [...standing.filter((d) => !stale.includes(d) && !deps.found.some((x) => x.id === d.threadId)), ...dependsOn] : dependsOn;
            const w = await write('pk_write_thread', { id: r.threadId, ...(serves.length ? { serves } : {}), ...(stale.length ? { dependsOn: whole, replaceDependsOn: true } : dependsOn.length ? { dependsOn } : {}) });
            if ('error' in w) unlinked.push({ line: r.line, column: 'serves', value: [parentCell, planCell, depCell].filter((v) => !blank(v)).join(' / '), why: w.error });
            else {
              warning = w.warning ?? null;
              for (const d of stale) removed.push({ line: r.line, column: 'dependsOn', value: store.threads.get(d.threadId)?.ids[0] ?? d.threadId, why: NOT_STATED });
            }
          }
        }
        if (warning) warnings.add(warning);
      }
      if (unlinked.length) result.unlinked = unlinked;
      if (removed.length) result.removed = removed;
      if (warnings.size) result.warnings = [...warnings];
      // DB: the rows whose status is readiness, counted — the program set no progress for them (a new one stands at the
      // starting Planned, an existing one as it was), and says so where a mapping would have hidden it.
      let progressToJudge: FillResult['progressToJudge'];
      if (readiness.length) {
        const statuses: Record<string, number> = {};
        for (const r of readiness) statuses[r.word] = (statuses[r.word] ?? 0) + 1;
        progressToJudge = {
          rows: readiness.length, statuses, lines: readiness.map((r) => r.line),
          note: `These rows write the readiness of their document, not how far the work is: the program set no progress for them (a new work item stands at the starting Planned, which is not a judgement). Judge each one’s progress from the execution records — the tickets or deliveries that implement it, their merges and checks — and write it with pk_write_thread (progress, with progressWhy where the records seem to say otherwise). Where the project has no execution records for a row, it stays Planned.`,
        };
      }
      // What was refused comes first, so it is read before the counts.
      return ok({ ...(refused.length ? { refused } : {}), ...result, ...(progressToJudge ? { progressToJudge } : {}) });
    },
  }));

  // ───────────────────────── headings: one item per heading ─────────────────────────

  tools.push(defineTool({
    name: 'pk_fill_from_headings', label: 'Fill slots from headings',
    description: 'Fill the workbench from the headings of one document: each heading of level (under the heading whose words are under, when given) becomes a reference item of category — each entry of a decision record a Decision, each goal of a PRD a Goal, each module an Area. The program copies the heading verbatim as its name (its project id, D12 or T-22, read from its start), its section as its text, basis Explicit, and the file’s section source of the heading with its line. Validity starts Current and progress stays unset: what replaced what, and what is done, are yours to judge. Running it again updates the items it wrote. Headings that cannot be written come back in skipped, with why; a file with no such heading writes nothing.',
    parameters: Type.Object({
      path: Type.String({ description: 'the document, relative to the repository root' }),
      level: Type.Number({ description: 'the heading level, 1–6 (### is 3)' }),
      category: Type.String({ description: REFERENCE_CATEGORY.filter((c) => c !== OWNER_WORDS).join(' | ') }),
      under: Type.Optional(Type.String({ description: 'words of the heading they stand under, e.g. "Goals"' })),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const category = text(p.category).trim();
      if (!isOneOf(REFERENCE_CATEGORY, category)) return fail(`category must be one of ${REFERENCE_CATEGORY.join(', ')}.`);
      if (category === OWNER_WORDS) return fail('Owner’s words carry the owner’s own quote from where they were said: write them with pk_write_reference, one by one.');
      const level = typeof p.level === 'number' ? Math.trunc(p.level) : NaN;
      if (!(level >= 1 && level <= 6)) return fail('level is a heading level from 1 to 6 (### is 3).');
      const refusal = gate('pk_fill_from_headings', { threads: false, category });
      if (refusal) return fail(refusal);
      const doc = readDocument(text(p.path));
      if (typeof doc === 'string') return fail(doc);
      const headings = headingsOf(doc.lines);
      const under = text(p.under).trim();
      let scopes: { from: number; to: number }[] = [{ from: 0, to: doc.lines.length }];
      if (under) {
        const wanted = squash(plainCell(under));
        scopes = headings.filter((h) => squash(h.text).includes(wanted)).map((h) => ({ from: h.line, to: scopeEnd(headings, h, doc.lines.length) }));
        if (!scopes.length) return ok({ written: 0, updated: 0, items: [], skipped: [], note: `No heading of ${doc.rel} has “${under}”.` });
      }
      const picked = headings.filter((h) => h.level === level && scopes.some((s) => h.line > s.from && h.line <= s.to));
      if (!picked.length) return ok({ written: 0, updated: 0, items: [], skipped: [], note: `${doc.rel} has no level-${level} heading${under ? ` under “${under}”` : ''}.` });

      const sourceAt = sourcesOf(doc);
      const result: FillResult = { written: 0, updated: 0, items: [], skipped: [] };
      const warnings = new Set<string>();
      const seen = new Map<string, number>();
      // CZ: a number of a family that counts only in the document holding its series (a side decision log's V1, V2 …;
      // numbering.ts) is the heading's number here, though it is never read off a name elsewhere.
      const series = new Map(definitionsInText(doc.lines.join('\n')).filter((d) => d.position === 'heading' && isSeriesOnlyFamily(d.family)).map((d) => [d.line ?? 0, d.num]));
      for (const h of picked) {
        const name = redact(h.text);
        if (blank(name)) { result.skipped.push({ line: h.line, why: 'the heading has no words' }); continue; }
        const source = sourceAt(h.line, doc.lines[h.line - 1] ?? '');
        if (typeof source === 'string') { result.skipped.push({ line: h.line, why: source }); continue; }
        const identifier = primaryIdentifier([], name) ?? series.get(h.line) ?? null;
        const key = identifier ?? `${pathKey(doc.rel)}\u0000${squash(name)}`;
        if (seen.has(key)) { result.skipped.push({ line: h.line, why: `the heading at line ${seen.get(key)} already wrote ${identifier ?? `“${name}”`}: one item per id` }); continue; }
        seen.set(key, h.line);
        // Its text: the section under the heading, up to the next heading of any level.
        const next = headings.find((x) => x.line > h.line);
        const body = doc.lines.slice(h.line, next ? next.line - 1 : doc.lines.length).join('\n').trim();
        const sectionText = redact(body.length > 1200 ? `${body.slice(0, 1200)}…` : body) || name;
        const fallback = stableId('ref', project.id, category, pathKey(doc.rel), key);
        const previous = existingReference(category, identifier, fallback);
        const params: Record<string, unknown> = previous
          ? { id: previous.id, name, text: sectionText, sourceIds: [...new Set([...previous.sourceIds, source.id])] }
          : { ...(identifier ? {} : { id: fallback }), category, name, ids: identifier ? [identifier] : [], text: sectionText, basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [source.id] };
        const w = await write('pk_write_reference', params);
        if ('error' in w) { result.skipped.push({ line: h.line, why: w.error }); continue; }
        if (w.warning) warnings.add(w.warning);
        if (previous) result.updated += 1; else result.written += 1;
        result.items.push({ id: w.id, title: name, line: h.line });
      }
      if (warnings.size) result.warnings = [...warnings];
      return ok(result);
    },
  }));

  // ───────────────────────── bold entry lines: one item per number ─────────────────────────

  tools.push(defineTool({
    name: 'pk_fill_from_bold', label: 'Fill slots from bold entries',
    description: 'Fill the workbench from the bold entry lines of one document, the way pk_fill_from_headings fills from headings: each line that opens with a number in bold — `**D1 · …**`, `- **R-52** …`, the entries of a decision record kept as paragraphs — becomes a reference item of category, one per number, the whole log in one call. The program reads the lines by the ledger’s own rule for a bold entry, and copies: the name is the number and its title as written (the bold words, or the words right after a bold that holds only the number), the text is the entry up to the next entry, with its supplements (`**D12 addendum (…)**`, a later bold line of the same number) folded in, basis Explicit, and the file’s section source of its line. Bold lines that are points of a numbered heading of another family (`**P1 …**` under `### M3`) are not entries of the document and are left out. family keeps one family (`D`, `R-`); under keeps the lines under a heading. Validity starts Current and progress stays unset: what replaced what is yours to judge. Running it again updates what it wrote. Lines that cannot be written come back in skipped, with why.',
    parameters: Type.Object({
      path: Type.String({ description: 'the document, relative to the repository root' }),
      category: Type.String({ description: REFERENCE_CATEGORY.filter((c) => c !== OWNER_WORDS).join(' | ') }),
      family: Type.Optional(Type.String({ description: 'only the numbers of one family: its letters, e.g. "D" or "R-"' })),
      under: Type.Optional(Type.String({ description: 'words of the heading they stand under' })),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const category = text(p.category).trim();
      if (!isOneOf(REFERENCE_CATEGORY, category)) return fail(`category must be one of ${REFERENCE_CATEGORY.join(', ')}.`);
      if (category === OWNER_WORDS) return fail('Owner’s words carry the owner’s own quote from where they were said: write them with pk_write_reference, one by one.');
      const refusal = gate('pk_fill_from_bold', { threads: false, category });
      if (refusal) return fail(refusal);
      const doc = readDocument(text(p.path));
      if (typeof doc === 'string') return fail(doc);
      const family = text(p.family).trim().toUpperCase();
      const letters = (num: string) => num.replace(/\d+$/, '');
      const all = entriesOf(doc.lines.join('\n'), { positions: ['bold entry'] })
        .filter((e) => !family || letters(e.num) === family || letters(e.num) === `${family}-` || letters(e.num) === family.replace(/-$/, ''));
      const headings = headingsOf(doc.lines);
      const under = text(p.under).trim();
      let picked = all;
      if (under) {
        const wanted = squash(plainCell(under));
        const scopes = headings.filter((h) => squash(h.text).includes(wanted)).map((h) => ({ from: h.line, to: scopeEnd(headings, h, doc.lines.length) }));
        if (!scopes.length) return ok({ written: 0, updated: 0, items: [], skipped: [], note: `No heading of ${doc.rel} has “${under}”.` });
        picked = all.filter((e) => scopes.some((s) => e.line > s.from && e.line <= s.to));
      }
      if (!picked.length) return ok({ written: 0, updated: 0, items: [], skipped: [], note: `${doc.rel} has no bold entry line${family ? ` of ${family}` : ''}${under ? ` under “${under}”` : ''}.` });
      const sourceAt = sourcesOf(doc);
      const result: FillResult = { written: 0, updated: 0, items: [], skipped: [] };
      const warnings = new Set<string>();
      const folded: { line: number; into: string }[] = [];
      for (const e of picked) {
        const name = redact(e.name);
        const source = sourceAt(e.line, doc.lines[e.line - 1] ?? '');
        if (typeof source === 'string') { result.skipped.push({ line: e.line, why: source }); continue; }
        const own = doc.lines.slice(e.line - 1, e.endLine).join('\n').trim();
        const more = e.foldedRanges.map((f) => doc.lines.slice(f.line - 1, f.endLine).join('\n').trim());
        const body = [own, ...more].filter(Boolean).join('\n\n');
        const entryText = redact(body.length > 2400 ? `${body.slice(0, 2400)}…` : body) || name;
        for (const f of e.foldedRanges) folded.push({ line: f.line, into: e.num });
        // The supplements' sources are cited too, when the file's sources hold them.
        const extra = e.foldedRanges.map((f) => sourceAt(f.line, doc.lines[f.line - 1] ?? '')).filter((x): x is Source => typeof x !== 'string').map((x) => x.id);
        const fallback = stableId('ref', project.id, category, pathKey(doc.rel), e.num);
        const previous = existingReference(category, e.num, fallback);
        const sourceIds = [...new Set([...(previous?.sourceIds ?? []), source.id, ...extra])];
        const params: Record<string, unknown> = previous
          ? { id: previous.id, name, text: entryText, sourceIds }
          : { category, name, ids: [e.num], text: entryText, basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds };
        const w = await write('pk_write_reference', params);
        if ('error' in w) { result.skipped.push({ line: e.line, why: w.error }); continue; }
        if (w.warning) warnings.add(w.warning);
        if (previous) result.updated += 1; else result.written += 1;
        result.items.push({ id: w.id, title: name, line: e.line });
      }
      if (warnings.size) result.warnings = [...warnings];
      return ok({ ...result, ...(folded.length ? { folded } : {}) });
    },
  }));

  return tools;
}
