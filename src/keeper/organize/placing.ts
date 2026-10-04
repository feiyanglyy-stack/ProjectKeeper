/**
 * Placement the program can read off the project's own writing (CM, E151; CL's findings; D101; Spec §1.4 落位):
 *
 * - **An Area by its written name.** A contract's Module column writes 「贯穿」 and the Area is named 「贯穿 · Keeper runtime
 *   与项目资产」: the short form names it (`areaNames`, `areaByWrittenName`). On the gated run the value never matched the
 *   Area's full name, and CKC-03 and CKC-20 sat in CK-M5.
 * - **What names an Area is placed on it.** Its requirement group (the heading it stands under), the Spec chapter tagged
 *   with it, the contracts whose row writes it, the tickets implementing those contracts, the decisions whose own entry
 *   names those (`itemsNaming`). When an Area is created — a foundation column is often created mid-round — everything
 *   that names it is placed again in the same pass (`placeAgain`), and `pk_round_state` lists what names an Area but sits
 *   elsewhere (`misplaced`).
 * - **Where a decision placed only on the product traces to.** Its own entry (a contract, a Spec section, a module, an
 *   R-item, a plan id, an Area's name) and the current documents that cite its number — the PRD group or Spec chapter
 *   citing it maps to its Area, the contract to its Module (`tracePlacement`). D28 and D71 name nothing themselves; the
 *   documents cite them.
 *
 * Nothing here judges: a placement the documents write is copied, a trace is a suggestion with what it rests on.
 *
 * CQ (D104): the numbers a trace follows are the project's own — the ledger's recognised numbering families, the numbers
 * the ledger finds defined, and the ids the workbench's items carry (`AB`, `#18`, `K`) — never a fixed shape of one
 * project (`numberMatcher`). The rows of an execution arrangement the layer map marks not current still count as the
 * task index of their time (`lineIndex.dated` spares a table row); its decision entries stay dated.
 */
import type { Ledger } from '../../ledger/index.ts';
import { definitionsInPath, definitionsInText, familyOf, mentionMatcher, type Rule } from '../../ledger/numbering.ts';
import { rangesIn } from '../../ledger/ranges.ts';
import type { GraphRelation, ReferenceItem, Source, WorkThread } from '../../model/types.ts';
import type { ProjectStore, TraceInfo } from '../../store/project-store.ts';
import { primaryIdentifier } from '../tools.ts';
import { citedAfter, laterThan, writtenBy, type Chronology } from './placement-time.ts';

const GONE = new Set(['Replaced', 'Removed', 'Abandoned']);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const slash = (p: string) => p.replace(/\\/g, '/');

// ───────────────────────── an Area by its written name ─────────────────────────

/** What separates an Area's short name from the rest of its name (`贯穿 · Keeper runtime`, `CK-M1：看懂项目全貌`). */
export const NAME_SEP = /\s*[·•:：—–|]\s*|\s+-\s+/;

/**
 * The names an Area answers to: its full name, its ids, and its short form — what stands before the first separator of
 * its name — when that is at least two characters. Longest first.
 */
export function areaNames(area: Pick<ReferenceItem, 'name' | 'ids'>): string[] {
  const full = squash(area.name);
  const short = squash(full.split(NAME_SEP)[0] ?? '');
  const out = [full, ...area.ids.map((i) => i.trim()), ...(short.length >= 2 && short !== full ? [short] : [])].filter((n) => n.length >= 2);
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/** Whether a text names the Area as a tag or a heading: one of its names standing alone between separators or brackets. */
export function namesAreaIn(text: string, names: readonly string[]): boolean {
  const t = squash(text);
  if (!t) return false;
  return names.some((n) => new RegExp(`(?:^|[\\s（(\\[【「《·•:：、，,;；/|—–-])${esc(n)}(?:$|[\\s）)\\]】」》·•:：、，,;；/|—–-])`, 'i').test(t));
}

/**
 * Whether a name carries the Area as a tag: a bracket at its end, or anywhere, that holds only Area names
 * (`Spec §8 · Keeper runtime（贯穿）`, `整理与判断（CK-M2、CK-M3）`). A name that merely mentions an Area in a sentence is not tagged.
 */
export function taggedWith(name: string, names: readonly string[]): boolean {
  const lower = names.map((n) => n.toLowerCase());
  for (const m of name.matchAll(/[（(\[【]([^（()）\[\]【】]{1,60})[)）\]】]/g)) {
    const parts = m[1]!.split(/[,，、;；/]+/).map((x) => squash(x).toLowerCase()).filter(Boolean);
    if (parts.length && parts.length <= 6 && parts.some((x) => lower.includes(x)) && parts.every((x) => x.length <= 40)) return true;
  }
  return false;
}

/**
 * The Area a written value names (a Module column's cell, a dispatch ticket's field): by id or project id, by its whole
 * name, or by its short form (D101: 「合同 Module 一栏写它的简称也算写明」). Null when none or several answer.
 */
export function areaByWrittenName(areas: readonly ReferenceItem[], value: string): ReferenceItem | null {
  const v = squash(value);
  if (!v) return null;
  const exact = areas.filter((a) => a.id === v || a.ids.some((i) => i.toUpperCase() === v.toUpperCase()) || squash(a.name).toLowerCase() === v.toLowerCase());
  if (exact.length === 1) return exact[0]!;
  const short = areas.filter((a) => areaNames(a).some((n) => n.toLowerCase() === v.toLowerCase()));
  return short.length === 1 ? short[0]! : null;
}

// ───────────────────────── where an item leads ─────────────────────────

export interface Reach {
  /** The Areas and Plans a reference item reaches through what it refines (itself included), by id. */
  readonly ofReference: (id: string) => { readonly areas: string[]; readonly plans: string[]; readonly product: boolean };
  /** The Areas and Plans a work item reaches through what it serves, implements or refines; its main Area first. */
  readonly ofThread: (t: WorkThread) => { readonly areas: string[]; readonly plans: string[] };
}

/** How the workbench's relations lead to Areas and Plans, read once. */
export function reachOf(store: ProjectStore, relations: readonly GraphRelation[] = store.relations.all()): Reach {
  const refinesOf = new Map<string, string[]>();
  for (const r of relations) if (r.type === 'refines') refinesOf.set(r.from, [...(refinesOf.get(r.from) ?? []), r.to]);
  const cache = new Map<string, { areas: string[]; plans: string[]; product: boolean }>();
  const ofReference = (id: string) => {
    const hit = cache.get(id);
    if (hit) return hit;
    const areas: string[] = [];
    const plans: string[] = [];
    let product = false;
    const seen = new Set<string>();
    const walk = (at: string, depth: number) => {
      if (seen.has(at) || depth > 10) return;
      seen.add(at);
      const item = store.reference.get(at);
      if (!item) return;
      if (item.category === 'Area') { if (!areas.includes(at)) areas.push(at); return; }
      if (item.category === 'Plan') { if (!plans.includes(at)) plans.push(at); return; }
      if (item.category === 'Product' || item.category === 'Goal') product = true;
      for (const up of [...item.refines, ...(refinesOf.get(at) ?? [])]) walk(up, depth + 1);
    };
    walk(id, 0);
    const out = { areas, plans, product };
    cache.set(id, out);
    return out;
  };
  const upOf = new Map<string, string[]>();
  for (const r of relations) if (r.type === 'serves' || r.type === 'implements' || r.type === 'refines') upOf.set(r.from, [...(upOf.get(r.from) ?? []), r.to]);
  const ofThread = (t: WorkThread) => {
    const areas: string[] = [];
    const plans: string[] = [];
    for (const id of [...t.serves.map((s) => s.referenceId), ...(upOf.get(t.id) ?? [])]) {
      const r = ofReference(id);
      for (const a of r.areas) if (!areas.includes(a)) areas.push(a);
      for (const p of r.plans) if (!plans.includes(p)) plans.push(p);
    }
    return { areas, plans };
  };
  return { ofReference, ofThread };
}

// ───────────────────────── what names an Area ─────────────────────────

export interface Naming {
  readonly id: string;
  readonly kind: 'reference' | 'thread';
  readonly category: string;
  readonly name: string;
  /** How it names the Area, in words the main agent can check: the heading, the cell, the contract it implements. */
  readonly how: string;
  /** Whether it reaches the Area already, and whether the Area is (or would be) its main one — the first it serves. */
  readonly placed: boolean;
  readonly main: boolean;
}

const threadName = (t: WorkThread): string => (t.ids[0] && !t.title.includes(t.ids[0]) ? `${t.ids[0]} ${t.title}` : t.title);
const refName = (r: ReferenceItem): string => (r.ids[0] && !r.name.startsWith(r.ids[0]) ? `${r.ids[0]} ${r.name}` : r.name);

/** The cells of a table row as the fill-in tools keep them in an item's text (`Header: value · Header: value`). */
function rowCells(text: string): { header: string; value: string }[] {
  return text.split(/\s+·\s+/).flatMap((seg) => { const m = /^([^:：]{1,40})[:：]\s*(.+)$/.exec(seg.trim()); return m ? [{ header: m[1]!.trim(), value: m[2]!.trim() }] : []; });
}

/** The Areas a row's cells name, in the order written (a cell may list several: `CK-M1、CK-M4`). */
function areasOfRow(text: string, areas: readonly ReferenceItem[]): ReferenceItem[] {
  const out: ReferenceItem[] = [];
  for (const cell of rowCells(text)) {
    for (const part of [cell.value, ...cell.value.split(/[,，、;；/]+/)].map(squash)) {
      const a = areaByWrittenName(areas, part);
      if (a && !out.includes(a)) out.push(a);
    }
  }
  return out;
}

/** The file anchors of an item's sources. */
function fileAnchors(store: ProjectStore, sourceIds: readonly string[]): Extract<Source['anchor'], { kind: 'file' }>[] {
  return sourceIds.flatMap((s) => { const a = store.sources.get(s)?.anchor; return a?.kind === 'file' ? [a] : []; });
}

/**
 * Every item that names the Area in the project's own writing (see the module comment), with whether it sits on it
 * already. Decisions come last: they are placed by what their own entry names, once those are known to name the Area.
 */
export function itemsNaming(store: ProjectStore, area: ReferenceItem, opts: { readonly reach?: Reach; readonly entries?: Map<string, string[]>; readonly index?: TraceIndex } = {}): Naming[] {
  const names = areaNames(area);
  const areas = store.reference.filter((r) => r.category === 'Area' && !GONE.has(r.validity));
  const relations = store.relations.all();
  const reach = opts.reach ?? reachOf(store, relations);
  const out = new Map<string, Naming>();
  const named = new Set<string>();   // reference ids and thread ids that name the Area
  const mainOf = new Map<string, boolean>();

  // 1 · requirements and designs: the group heading they stand under, a tag in their name, the Area their row writes.
  for (const r of store.reference.filter((x) => (x.category === 'Requirement' || x.category === 'Design') && !GONE.has(x.validity))) {
    let how: string | null = null;
    let main = true;
    const heading = fileAnchors(store, r.sourceIds).flatMap((a) => a.headingPath).find((h) => namesAreaIn(h, names));
    const cells = areasOfRow(r.text, areas);
    if (cells.includes(area)) { how = `its row writes ${rowCells(r.text).find((c) => [c.value, ...c.value.split(/[,，、;；/]+/)].some((p) => areaByWrittenName(areas, squash(p)) === area))?.header ?? 'the area'}: ${area.name.split(NAME_SEP)[0]}`; main = cells[0] === area; }
    else if (taggedWith(r.name, names)) how = `its name is tagged with ${names[names.length - 1]}`;
    else if (heading) how = `it stands under the heading “${squash(heading)}”`;
    if (!how) continue;
    named.add(r.id);
    mainOf.set(r.id, main);
    out.set(r.id, { id: r.id, kind: 'reference', category: r.category, name: refName(r), how, placed: reach.ofReference(r.id).areas.includes(area.id), main });
  }

  // 2 · contracts: the work item of the same row (it serves the row's reference item, or carries its number).
  const threads = store.threads.filter((t) => !GONE.has(t.validity));
  for (const t of threads) {
    const row = [...t.serves.map((s) => s.referenceId), ...store.reference.filter((r) => r.category === 'Requirement' && r.ids.some((i) => t.ids.some((x) => x.toUpperCase() === i.toUpperCase()))).map((r) => r.id)].find((id) => named.has(id) && areasOfRow(store.reference.get(id)?.text ?? '', areas).includes(area));
    if (!row) continue;
    const main = mainOf.get(row) ?? true;
    named.add(t.id);
    mainOf.set(t.id, main);
    const at = reach.ofThread(t).areas;
    out.set(t.id, { id: t.id, kind: 'thread', category: 'Work item', name: threadName(t), how: out.get(row)!.how.replace(/^its row/, 'its contract row'), placed: at.includes(area.id) && (!main || at[0] === area.id), main });
  }

  // 3 · tickets: they implement a contract that names the Area. Main when every contract they implement does.
  const contractOf = (to: string): string => {
    if (store.threads.has(to)) return to;
    const r = store.reference.get(to);
    const n = (r?.ids ?? []).map((i) => i.toUpperCase());
    return n.length ? store.threads.find((x) => x.ids.some((i) => n.includes(i.toUpperCase())))?.id ?? to : to;
  };
  const implementsOf = new Map<string, string[]>();
  for (const r of relations) if (r.type === 'implements' && store.threads.has(r.from)) implementsOf.set(r.from, [...(implementsOf.get(r.from) ?? []), contractOf(r.to)]);
  for (const t of threads) {
    if (named.has(t.id)) continue;
    const contracts = implementsOf.get(t.id) ?? [];
    const hit = contracts.filter((c) => named.has(c) && mainOf.get(c) !== false);
    if (!hit.length) continue;
    const main = hit.length === contracts.length;
    const at = reach.ofThread(t).areas;
    const label = hit.map((c) => store.threads.get(c)?.ids[0] ?? store.reference.get(c)?.ids[0] ?? c).join(', ');
    out.set(t.id, { id: t.id, kind: 'thread', category: 'Work item', name: threadName(t), how: `it implements ${label}`, placed: at.includes(area.id) && (!main || at[0] === area.id), main });
  }

  // 4 · decisions and boundaries: their own entry names only items of this Area (a contract, a Spec section, an R-item).
  const naming = new Set([...named, ...[...out.keys()]]);
  const trace = opts.index ?? traceIndex(store, reach);
  for (const d of store.reference.filter((x) => (x.category === 'Decision' || x.category === 'Boundary') && !GONE.has(x.validity))) {
    // What an entry names does not depend on the Area asked about: read once when several Areas are asked in a row.
    let own = opts.entries?.get(d.id);
    if (!own) { own = entryNames(store, d, trace); opts.entries?.set(d.id, own); }
    if (!own.length) continue;
    const targets = own.flatMap((n) => trace.resolve(n));
    if (!targets.length) continue;
    const onArea = targets.filter((id) => naming.has(id) || id === area.id);
    if (!onArea.length) continue;
    // Its entry names other Areas' items too: it reaches several areas, which is the model's to weigh (the trace suggests).
    const elsewhere = targets.filter((id) => !onArea.includes(id)).some((id) => (store.threads.has(id) ? reach.ofThread(store.threads.get(id)!).areas : reach.ofReference(id).areas).some((a) => a !== area.id));
    if (elsewhere) continue;
    const r = reach.ofReference(d.id);
    out.set(d.id, { id: d.id, kind: 'reference', category: d.category, name: refName(d), how: `its entry names ${own.filter((n) => trace.resolve(n).some((id) => onArea.includes(id))).join(', ')}`, placed: r.areas.includes(area.id), main: true });
  }
  return [...out.values()];
}

/**
 * Place again what names the Area and does not sit on it (D101: 「这一列是在途中才建的，建好后把点名它的再落一遍」): a
 * requirement, a design or a decision refines it too; a contract or a ticket serves it, first when it is its main Area. What
 * an item already refines or serves stays — a contract in two modules stays in both, the Area written first leading.
 * Decisions already placed on an Area or a Plan are left where the Keeper judged them.
 */
export function placeAgain(store: ProjectStore, area: ReferenceItem, trace: (summary: string) => TraceInfo): Naming[] {
  const reach = reachOf(store);
  const moved: Naming[] = [];
  const at = new Date().toISOString();
  for (const n of itemsNaming(store, area, { reach })) {
    if (n.placed) continue;
    if (n.kind === 'reference') {
      const r = store.reference.get(n.id);
      if (!r || r.refines.includes(area.id)) continue;
      if ((r.category === 'Decision' || r.category === 'Boundary') && (reach.ofReference(r.id).areas.length || reach.ofReference(r.id).plans.length)) continue;
      store.reference.put({ ...r, refines: [...r.refines, area.id], updatedAt: at }, trace(`${refName(r)} placed on ${area.name}: ${n.how}`));
    } else {
      const t = store.threads.get(n.id);
      if (!t) continue;
      const rest = t.serves.filter((s) => s.referenceId !== area.id);
      // CQ (D104): a placement the program writes is Inferred; the main agent or a lane confirms or moves it.
      const mine = t.serves.find((s) => s.referenceId === area.id) ?? { referenceId: area.id, claim: n.how, basis: 'Inferred' as const };
      const firstArea = rest.findIndex((s) => store.reference.get(s.referenceId)?.category === 'Area');
      // Main: before every other Area it serves. Otherwise after the Areas it already serves, before its plans.
      const lastArea = rest.reduce((k, s, i) => (store.reference.get(s.referenceId)?.category === 'Area' ? i : k), -1);
      const serves = n.main ? [...rest.slice(0, Math.max(0, firstArea)), mine, ...rest.slice(Math.max(0, firstArea))] : [...rest.slice(0, lastArea + 1), mine, ...rest.slice(lastArea + 1)];
      store.threads.put({ ...t, serves: firstArea < 0 && n.main ? [mine, ...rest] : serves, updatedAt: at }, trace(`${threadName(t)} placed on ${area.name}${n.main ? ' (its main area)' : ''}: ${n.how}`));
    }
    moved.push(n);
  }
  return moved;
}

/** Across every Area: what names it in the project's own writing and sits elsewhere (`pk_round_state` open `misplaced`). */
export function misplacedItems(store: ProjectStore): (Naming & { readonly area: string; readonly sits: string })[] {
  const reach = reachOf(store);
  const nameOf = (id: string) => store.reference.get(id)?.name.split(NAME_SEP)[0] ?? id;
  const out: (Naming & { area: string; sits: string })[] = [];
  const entries = new Map<string, string[]>();
  const index = traceIndex(store, reach);
  for (const area of store.reference.filter((r) => r.category === 'Area' && !GONE.has(r.validity))) {
    for (const n of itemsNaming(store, area, { reach, entries, index })) {
      if (n.placed) continue;
      const r = n.kind === 'thread' ? reach.ofThread(store.threads.get(n.id)!) : reach.ofReference(n.id);
      if (n.kind === 'reference' && (n.category === 'Decision' || n.category === 'Boundary') && (r.areas.length || r.plans.length)) continue;
      out.push({ ...n, area: area.name, sits: r.areas.length ? r.areas.map(nameOf).join(', ') : 'product' in r && r.product ? 'the product only' : 'no area' });
    }
  }
  return out;
}

// ───────────────────────── where a decision traces to ─────────────────────────

/** A section reference in an entry (`Spec §8.1`, `SPEC.md §3`, `§2.4`): the document's word, when written, and the section number. */
const SECTION_RE = /(?:\b([A-Za-z][A-Za-z0-9_-]{1,15})(?:\.md)?\s*)?§\s*(\d+(?:\.\d+)*)/g;
/** The generic shapes of a project number: the fallback where no ledger says which families the project has. */
const GENERIC_NUM_RE = /(?<![A-Za-z0-9_#-])(?:[A-Z]{1,6}-[A-Z]?\d{1,4}|[A-Z]\d{1,4}|#\d{1,5})(?![A-Za-z0-9_])/g;

/** The project's own numbers in a text, as `numberMatcher` reads them: upper case, each once. */
export type NumberMatcher = (text: string) => string[];

/**
 * CQ (D104): the project's own numbers, read off the ledger and the workbench, never a fixed shape of one project:
 * - the ledger's recognised numbering families (`num_rules`: letter-digits, prefix-hyphen, and the two-letter ids it found
 *   defined — an index's `AB`, a prompt's `AP`), through `mentionMatcher`;
 * - a token of a generic shape the ledger finds defined somewhere (a family too small to be a rule);
 * - the ids the workbench's items carry (`#18`, `CK-M2`, a plan's `M1`), as whole tokens, when two characters or more
 *   (a one-letter plan id is read by the plan words of `traceIndex`).
 * Without a ledger the generic shapes stand in for the families.
 */
export function numberMatcher(store: ProjectStore, ledger: Ledger | null): NumberMatcher {
  let rules: Rule[] = [];
  if (ledger) {
    try {
      const rows = ledger.db.prepare('SELECT rule, shape FROM num_rules').all() as { rule: string; shape: Rule['shape'] }[];
      const pairs = rows.some((r) => r.shape === 'two-letters') ? (ledger.db.prepare("SELECT DISTINCT num FROM nums WHERE rule = 'two letters' AND place = 'definition'").all() as { num: string }[]).map((r) => r.num) : [];
      rules = rows.map((r) => ({ family: r.rule, shape: r.shape, defined: new Set(r.shape === 'two-letters' ? pairs : []) }));
    } catch { rules = []; }
  }
  const viaRules = rules.length ? mentionMatcher(rules) : null;
  const ids = new Set<string>();
  for (const t of store.threads.all()) for (const i of t.ids) if (i.trim().length >= 2 && i.trim().length <= 24) ids.add(i.trim());
  for (const r of store.reference.all()) if (r.category !== "Owner's words") for (const i of r.ids) if (i.trim().length >= 2 && i.trim().length <= 24) ids.add(i.trim());
  const idRe = ids.size ? new RegExp(`(?<![\\p{L}\\p{N}_#-])(?:${[...ids].sort((a, b) => b.length - a.length).map(esc).join('|')})(?![\\p{L}\\p{N}_])`, 'gu') : null;
  const defined = new Map<string, boolean>();
  const isDefined = (tokens: string[]): Set<string> => {
    const ask = tokens.filter((t) => !defined.has(t));
    if (ask.length && ledger) { try { const found = ledger.definedNumbers(ask); for (const t of ask) defined.set(t, found.has(t)); } catch { for (const t of ask) defined.set(t, false); } }
    return new Set(tokens.filter((t) => defined.get(t) === true));
  };
  return (text: string): string[] => {
    const out = new Set<string>();
    if (viaRules) for (const m of viaRules(text)) if (m.confidence === 'stated') out.add(m.num.toUpperCase());
    if (idRe) for (const m of text.matchAll(idRe)) out.add(m[0].toUpperCase());
    const generic = [...new Set([...text.matchAll(GENERIC_NUM_RE)].map((m) => m[0].toUpperCase()))].filter((n) => !out.has(n) && !/^V\d/.test(n));
    if (generic.length) {
      if (!ledger) for (const n of generic) out.add(n);
      else for (const n of isDefined(generic.filter((g) => familyOf(g) !== null))) out.add(n);
    }
    return [...out];
  };
}

export interface TraceIndex {
  /** The Plans' ids, the Areas' names, the project's numbers and the section references, as a matcher over an entry's text. */
  readonly named: (text: string) => string[];
  /** The items a written name stands for: the contract's work item and requirement, the section's design, the Area, the Plan. */
  readonly resolve: (name: string) => string[];
  /** The project's numbers in a text (`numberMatcher`). */
  readonly numbers: NumberMatcher;
}

/** The words a plan's one-token id follows when an entry means the plan by it (`增量 K`, `plan K`): a bilingual word list, not one project's shape. */
const PLAN_WORDS = '增量|计划|阶段|批次|里程碑|迭代|increment|plan|phase|batch|milestone|sprint|iteration|stage';

/** The project's own names a trace can lead through (plan ids like K and P1–P4, Area names, its numbers; CM, CL's findings §3; CQ). */
export function traceIndex(store: ProjectStore, _reach?: Reach, opts: { readonly ledger?: Ledger | null; readonly numbers?: NumberMatcher } = {}): TraceIndex {
  const live = store.reference.filter((r) => !GONE.has(r.validity));
  const plans = live.filter((r) => r.category === 'Plan');
  const areas = live.filter((r) => r.category === 'Area');
  const planNames = new Map<string, string>();
  for (const p of plans) for (const n of [...p.ids, primaryIdentifier(p.ids, p.name) ?? '', squash(p.name.split(NAME_SEP)[0] ?? '')]) if (n && n.length <= 16) planNames.set(n.toUpperCase(), p.id);
  const areaName = new Map<string, string>();
  for (const a of areas) for (const n of areaNames(a)) areaName.set(n.toLowerCase(), a.id);
  // A plan's short id (K, P1) counts where the entry writes it as one: after a plan word, or with digits.
  const planRe = planNames.size ? new RegExp(`(?:(?:${PLAN_WORDS})\\s*)(${[...planNames.keys()].map(esc).join('|')})(?![\\p{L}\\p{N}_-])|(?<![\\p{L}\\p{N}_-])(${[...planNames.keys()].filter((k) => /\d/.test(k)).map(esc).join('|') || '\\b\\B'})(?![\\p{L}\\p{N}_-])`, 'giu') : null;
  const numbers = opts.numbers ?? numberMatcher(store, opts.ledger ?? null);
  const named = (text: string): string[] => {
    const out = new Set<string>();
    for (const n of numbers(text)) out.add(n);
    for (const m of text.matchAll(SECTION_RE)) out.add(`${m[1] ? `${m[1].toUpperCase()} ` : ''}§${m[2]}`);
    if (planRe) for (const m of text.matchAll(planRe)) out.add((m[1] ?? m[2])!.toUpperCase());
    for (const [n] of areaName) if (namesAreaIn(text, [n])) out.add(areas.find((a) => a.id === areaName.get(n))!.name.split(NAME_SEP)[0]!.trim());
    return [...out];
  };
  const resolve = (name: string): string[] => {
    const up = name.toUpperCase();
    const plan = planNames.get(up);
    if (plan) return [plan];
    const area = areaName.get(name.toLowerCase());
    if (area) return [area];
    const section = /^(?:([A-Z0-9_-]+) )?§(\d+(?:\.\d+)*)$/.exec(up);
    if (section) {
      // The design of that section: by its name (`Spec §8 · …`, `§8.1 …`), else of its chapter; the document's word, when
      // written, keeps to the designs read from a file of that name.
      const word = section[1]?.toLowerCase() ?? null;
      const designs = live.filter((r) => r.category === 'Design');
      const by = (num: string) => designs.filter((d) => new RegExp(`§\\s*${esc(num)}(?![\\d.]*\\d)`).test(d.name) || fileAnchors(store, d.sourceIds).some((a) => a.headingPath.some((h) => new RegExp(`^${esc(num)}(?:\\s|[.·、:：])`).test(h.trim()))));
      const narrow = (ds: ReferenceItem[]) => { if (!word || ds.length <= 1) return ds; const of = ds.filter((d) => fileAnchors(store, d.sourceIds).some((a) => slash(a.path).toLowerCase().includes(word))); return of.length ? of : ds; };
      const exact = narrow(by(section[2]!));
      return (exact.length ? exact : narrow(by(section[2]!.split('.')[0]!))).map((d) => d.id);
    }
    const refs = live.filter((r) => r.category !== 'Decision' && r.category !== 'Boundary' && r.ids.some((i) => i.toUpperCase() === up)).map((r) => r.id);
    const threads = store.threads.filter((t) => !GONE.has(t.validity) && t.ids.some((i) => i.toUpperCase() === up)).map((t) => t.id);
    return [...threads, ...refs];
  };
  return { named, resolve, numbers };
}

/**
 * The names in an item's own entry of its source that trace it: the lines from the line that defines its number to the
 * next entry of another number, in the section its source holds (a source often holds a whole section of many entries);
 * without a number, or when the source does not hold its definition, the item's own text.
 */
export function entryNames(store: ProjectStore, item: ReferenceItem, index: TraceIndex = traceIndex(store)): string[] {
  const num = item.ids[0]?.toUpperCase() ?? null;
  const texts: string[] = [];
  for (const sid of item.sourceIds) {
    const src = store.sources.get(sid);
    if (!src) continue;
    const lines = src.excerpt.split(/\r?\n/);
    const defs = definitionsInText(src.excerpt).filter((d) => d.line !== null);
    const own = num ? defs.filter((d) => d.num === num) : [];
    if (!own.length) continue;
    for (const o of own) {
      const next = defs.find((d) => d.line! > o.line! && d.num !== num);
      texts.push(lines.slice(o.line! - 1, next ? next.line! - 1 : lines.length).join('\n'));
    }
  }
  if (!texts.length) texts.push(item.text);
  const found = new Set<string>();
  for (const t of texts) for (const n of index.named(t)) if (n.toUpperCase() !== num) found.add(n);
  return [...found];
}

export interface Trace {
  /** What its own entry names. */
  readonly names: readonly string[];
  /** The current documents that cite its number, each as `path:line → the item there (its areas)`; up to `CITED_SHOWN`. */
  readonly cited: readonly string[];
  readonly citations: number;
  /** The Areas and Plans the names and the citing items lead to, most cited first, each with how often. */
  readonly suggest: readonly string[];
  /** CQ: the same tally by id — the Area or Plan, and how many names and citations lead to it — most led to first. */
  readonly leads: readonly { readonly id: string; readonly count: number }[];
}

const CITED_SHOWN = 6;

/**
 * Where a decision or boundary traces to (see the module comment): forward through its own entry, and back through the
 * current documents that cite its number — a line of the PRD or the Spec maps to the requirement or design it stands in
 * and that item's Area; a line of a contract to the contract's Module. Dated records (decision logs, reports, archives)
 * are not citations in force.
 */
export function tracePlacement(store: ProjectStore, ledger: Ledger | null, item: ReferenceItem, shared: { readonly reach?: Reach; readonly index?: TraceIndex; readonly lines?: LineIndex; readonly time?: Chronology; readonly dropped?: string[] } = {}): Trace {
  const reach = shared.reach ?? reachOf(store);
  const index = shared.index ?? traceIndex(store, reach);
  const time = shared.time ?? null;
  const drop = (note: string) => { if (shared.dropped && !shared.dropped.includes(note)) shared.dropped.push(note); };
  const label = item.ids[0] ?? squash(item.name).slice(0, 30);
  // CR: a name its entry writes counts only when what it names existed at the entry's date.
  const own = time?.own(item.id) ?? null;
  const ownEntry = own ? entryTextOf(store, item) : '';
  const existed = (n: string, id: string): boolean => {
    const first = own ? time!.first(id) : null;
    if (!citedAfter(first, own, ownEntry, n)) return true;
    drop(`${label}'s entry names ${n}, first written ${first}, after ${label}'s entry of ${own}`);
    return false;
  };
  const names = entryNames(store, item, index);
  const tally = new Map<string, number>();
  const bump = (ids: readonly string[]) => { for (const id of new Set(ids)) tally.set(id, (tally.get(id) ?? 0) + 1); };
  const placesOf = (id: string): string[] => {
    const t = store.threads.get(id);
    if (t) { const r = reach.ofThread(t); return [...r.areas.slice(0, 1), ...(r.areas.length ? [] : r.plans.slice(0, 1))]; }
    const r = store.reference.get(id);
    if (!r) return [];
    if (r.category === 'Area' || r.category === 'Plan') return [id];
    const x = reach.ofReference(id);
    return x.areas.length ? x.areas : x.plans;
  };
  for (const n of names) bump(index.resolve(n).filter((id) => existed(n, id)).flatMap(placesOf));
  const cited: string[] = [];
  let citations = 0;
  const num = item.ids[0]?.toUpperCase();
  if (ledger && num) {
    const lines = shared.lines ?? lineIndex(store);
    let rows: { path: string; line: number; context: string; occurred_at: string; occurred_basis: string; other_at: string | null }[] = [];
    try { rows = ledger.db.prepare("SELECT path, line, context, occurred_at, occurred_basis, other_at FROM nums WHERE num = ? AND kind = 'doc' AND current = 1 AND place != 'definition' AND path IS NOT NULL AND line IS NOT NULL ORDER BY path, line").all(num) as typeof rows; } catch { rows = []; }
    // CR: a line citing it counts only when it existed when that line was written.
    const first = time?.first(item.id) ?? null;
    for (const row of rows) {
      if (lines.dated(row.path, row.context)) continue;
      // The line as it stands was written by its document's latest version (else the ledger's row says by when).
      const written = time?.line(row.path, row.line) ?? writtenBy(row);
      if (first && written && laterThan(first, written)) { drop(`${row.path}:${row.line} names ${label}, first written ${first}, after that line of ${written}`); continue; }
      const at = lines.itemsAt(row.path, row.line).filter((id) => id !== item.id);
      // A section's source often holds a whole table: the row that cites it is the item whose own number stands on the line.
      const onLine = at.filter((id) => { const n = store.threads.get(id)?.ids[0] ?? store.reference.get(id)?.ids[0]; return n ? new RegExp(`(?<![A-Za-z0-9_-])${esc(n)}(?![A-Za-z0-9_])`).test(row.context) : false; });
      const here = onLine.length ? onLine : at;
      const places = [...new Set(here.flatMap(placesOf))];
      // A line that leads to three places or more (a table of everything, a principles section) says nothing about where.
      if (!places.length || places.length > 2) continue;
      citations += 1;
      bump(places);
      if (cited.length < CITED_SHOWN) cited.push(`${row.path}:${row.line} → ${here.slice(0, 2).map((id) => store.threads.get(id)?.ids[0] ?? store.reference.get(id)?.ids[0] ?? squash(store.reference.get(id)?.name ?? id).slice(0, 30)).join(', ')} (${places.map((p) => store.reference.get(p)?.name.split(NAME_SEP)[0]?.trim() ?? p).join(', ')})`);
    }
  }
  const sorted = [...tally].sort((a, b) => b[1] - a[1]);
  const suggest = sorted.map(([id, n]) => `${store.reference.get(id)?.name.split(NAME_SEP)[0]?.trim() ?? id}${store.reference.get(id)?.category === 'Plan' ? ' (plan)' : ''} ×${n}`);
  return { names, cited, citations, suggest, leads: sorted.map(([id, count]) => ({ id, count })) };
}

export interface LineIndex {
  /** The items standing at a line of a current document: a contract file's own contract, else the items whose narrowest source holds the line. */
  readonly itemsAt: (path: string, line: number) => string[];
  /**
   * A dated record: a decision log, a report or receipt, an archive (what the layer map says, or by name). CQ (D104): a
   * table row of an execution arrangement the layer map marks not current is not dated — the rows are the task index of
   * their time and still place the work they list; give the line (`context`) to have it read that way. Its decision
   * entries, and everything else in it, stay dated.
   */
  readonly dated: (path: string, context?: string) => boolean;
}

/** Which items stand where in the project's documents, read once from the sources (paths as the ledger writes them). */
export function lineIndex(store: ProjectStore): LineIndex {
  const roots = [...new Set(store.sources.all().flatMap((s) => (s.anchor.kind === 'file' ? [s.anchor.path] : [])))];
  const layers = store.layers.all().map((l) => ({ path: slash(l.path).replace(/\/+$/, ''), repo: slash(l.repo ?? '').replace(/\/+$/, ''), layer: l.layer, current: l.current }));
  const layerOf = (rel: string) => layers.filter((l) => rel === l.path || rel.startsWith(`${l.path}/`)).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
  const dated = (rel: string, context?: string) => {
    const l = layerOf(rel);
    if (!l) return /(^|\/)(DECISIONS?|ADR|decision[-_ ]?log)[^/]*\.md$/i.test(rel) || /(^|\/)archive(\/|$)/i.test(rel);
    if (l.layer === 'Decision record' || l.layer === 'QC and receipts') return true;
    if (l.current) return false;
    return !(l.layer === 'Execution arrangement' && context !== undefined && /^\s*\|/.test(context));
  };
  // The sources of each file, keyed by the end of its path (the ledger's paths are repository-relative).
  const byFile = new Map<string, { id: string; from: number; to: number }[]>();
  for (const s of store.sources.all()) {
    if (s.anchor.kind !== 'file' || s.availability === 'No longer available') continue;
    const key = slash(s.anchor.path).toLowerCase();
    byFile.set(key, [...(byFile.get(key) ?? []), { id: s.id, from: s.anchor.lineStart, to: s.anchor.lineEnd }]);
  }
  const fileOf = new Map<string, string | null>();
  const sourcesOf = (rel: string) => {
    if (!fileOf.has(rel)) fileOf.set(rel, [...byFile.keys()].find((k) => k.endsWith(`/${rel.toLowerCase()}`)) ?? null);
    const key = fileOf.get(rel);
    return key ? byFile.get(key)! : [];
  };
  const bySource = new Map<string, string[]>();
  for (const r of store.reference.all()) if (!GONE.has(r.validity) && r.category !== "Owner's words") for (const sid of r.sourceIds) bySource.set(sid, [...(bySource.get(sid) ?? []), r.id]);
  void roots;
  const itemsAt = (rel: string, line: number): string[] => {
    // A contract's own file: the contract it defines.
    const nums = definitionsInPath(rel).map((d) => d.num.toUpperCase());
    if (nums.length) {
      const threads = store.threads.filter((t) => !GONE.has(t.validity) && t.ids.some((i) => nums.includes(i.toUpperCase()))).map((t) => t.id);
      if (threads.length) return threads;
    }
    const holding = sourcesOf(rel).filter((s) => s.from <= line && line <= s.to).sort((a, b) => (a.to - a.from) - (b.to - b.from));
    for (const s of holding) {
      const items = bySource.get(s.id) ?? [];
      if (items.length) return items;
    }
    return [];
  };
  return { itemsAt, dated };
}

// ───────────────────────── work for its whole plan; a plan through decisions (CN, E152) ─────────────────────────

/**
 * Two things the program reads off the project's own writing for a work item that is not placed (CN; E152, from the CM
 * run, where four work items stayed "unplaced"):
 *
 * - **Work for its whole plan.** A milestone QC "（CKC-01～CKC-12）" and an isolated reading of the whole graph are in a
 *   plan and belong to no single module. When a range the ticket writes — in its title or what it does, in its own
 *   prompt, or the contracts it implements — spans `WHOLE_PLAN_MODULES` modules or more, the program suggests recording
 *   it as serving its whole plan (`pk_write_thread` `wholePlanWhy`).
 * - **A plan through decisions.** Two audits "交付已按 D57 归档" had no plan, though the decision they carry out is one
 *   plan's trial arrangement. For a work item in no plan the program follows the decisions it carries out, cites, or is
 *   cited by to the plan they lead to (`planThroughDecisions`).
 *
 * Both are suggestions with what they rest on; nothing is placed by them.
 */
export const WHOLE_PLAN_MODULES = 3;

/** What a work item says of itself: its title and what it does. */
const ownWords = (t: WorkThread): string => [t.title, t.doing].filter(Boolean).join('\n');

/**
 * The lines of a ticket's own writing in the ledger: every line of the document that is its own (the file's name and
 * its front matter, heading or bold entry both define the number: a prompt `AC-….md` with `id: "AC"`), and the row that
 * defines it in a shared index. Each line as the ledger keeps it (its context), current versions only.
 */
function ticketLines(ledger: Ledger | null, nums: readonly string[]): { own: string[]; rows: string[] } {
  const own: string[] = [];
  const rows: string[] = [];
  if (!ledger) return { own, rows };
  for (const num of nums) {
    let defs: { repo: string | null; path: string | null; context: string }[] = [];
    try { defs = ledger.db.prepare("SELECT repo, path, context FROM nums WHERE num = ? AND place = 'definition' AND kind = 'doc' AND current = 1 AND path IS NOT NULL").all(num) as typeof defs; } catch { defs = []; }
    for (const d of defs) {
      const base = d.path!.split('/').pop() ?? '';
      if (definitionsInPath(base).some((x) => x.num.toUpperCase() === num.toUpperCase())) {
        let lines: { context: string }[] = [];
        try { lines = ledger.db.prepare("SELECT DISTINCT line, context FROM nums WHERE repo IS ? AND path = ? AND kind = 'doc' AND current = 1 ORDER BY line").all(d.repo, d.path) as typeof lines; } catch { lines = []; }
        for (const l of lines) if (!own.includes(l.context)) own.push(l.context);
      } else if (!rows.includes(d.context)) rows.push(d.context);
    }
  }
  return { own, rows };
}

export interface WholePlanSuggestion {
  /** The range as written (`CKC-01～CKC-12`), or the contracts it implements. */
  readonly range: string;
  /** Where the range stands: the work item's own words, its ticket's own document, or its `implements` relations. */
  readonly from: 'its title' | 'its ticket' | 'the contracts it implements';
  /** The modules the range's items sit in, by short name, in the order met. */
  readonly modules: readonly string[];
}

/**
 * Whether a work item's own writing spans `WHOLE_PLAN_MODULES` modules or more (see above); null when it does not.
 * A module is the main Area of each item the range names (a contract's, a requirement's).
 */
export function wholePlanSuggestion(store: ProjectStore, ledger: Ledger | null, t: WorkThread, shared: { readonly reach?: Reach; readonly index?: TraceIndex } = {}): WholePlanSuggestion | null {
  const reach = shared.reach ?? reachOf(store);
  const index = shared.index ?? traceIndex(store, reach);
  const short = (id: string) => store.reference.get(id)?.name.split(NAME_SEP)[0]?.trim() ?? id;
  const moduleOf = (id: string): string | null => {
    const thread = store.threads.get(id);
    if (thread) return thread.id === t.id ? null : reach.ofThread(thread).areas[0] ?? null;
    const r = store.reference.get(id);
    if (!r) return null;
    return r.category === 'Area' ? r.id : reach.ofReference(id).areas[0] ?? null;
  };
  const modulesOf = (ids: readonly string[]): string[] => [...new Set(ids.map(moduleOf).filter((a): a is string => a !== null))];
  const spans = (text: string, from: WholePlanSuggestion['from']): WholePlanSuggestion | null => {
    for (const r of rangesIn(text)) {
      const modules = modulesOf(r.members.flatMap((n) => index.resolve(n)));
      if (modules.length >= WHOLE_PLAN_MODULES) return { range: r.written, from, modules: modules.map(short) };
    }
    return null;
  };
  const own = spans(ownWords(t), 'its title');
  if (own) return own;
  const lines = ticketLines(ledger, t.ids);
  for (const line of [...lines.rows, ...lines.own]) { const hit = spans(line, 'its ticket'); if (hit) return hit; }
  const contracts = store.relations.filter((r) => r.type === 'implements' && r.from === t.id).map((r) => r.to);
  const modules = modulesOf(contracts);
  if (modules.length >= WHOLE_PLAN_MODULES) {
    return { range: contracts.map((c) => store.threads.get(c)?.ids[0] ?? store.reference.get(c)?.ids[0] ?? c).join(', '), from: 'the contracts it implements', modules: modules.map(short) };
  }
  return null;
}

export interface PlanSuggestion {
  readonly planId: string;
  /** The plan by its short name (`P1`). */
  readonly plan: string;
  /** The decisions that lead to it, each with how the work item meets it: `D57 (cites)`, `E40 (cited by)`. */
  readonly through: readonly string[];
  readonly weight: number;
}

/** How much each way of meeting a decision counts: what the work item carries out, what it cites, what cites it. */
const THROUGH_WEIGHT = { 'carries out': 3, cites: 2, 'cited by': 1 } as const;
type Through = keyof typeof THROUGH_WEIGHT;

/** The lines of an item's own entry in its sources (as `entryNames` cuts them); its own text when no source holds them. */
export function entryTextOf(store: ProjectStore, item: ReferenceItem): string {
  const num = item.ids[0]?.toUpperCase() ?? null;
  const texts: string[] = [];
  for (const sid of item.sourceIds) {
    const src = store.sources.get(sid);
    if (!src) continue;
    const lines = src.excerpt.split(/\r?\n/);
    const defs = definitionsInText(src.excerpt).filter((d) => d.line !== null);
    const own = num ? defs.filter((d) => d.num === num) : [];
    for (const o of own) {
      const next = defs.find((d) => d.line! > o.line! && d.num !== num);
      texts.push(lines.slice(o.line! - 1, next ? next.line! - 1 : lines.length).join('\n'));
    }
  }
  return texts.length ? texts.join('\n') : item.text;
}

/**
 * The plans the decisions a work item meets lead to, heaviest first (see above). A decision leads to the plan it sits on
 * (it refines the Plan, or what it refines does); else to the plans of what its own entry names (a contract, a
 * requirement); else to the plans of the decisions its entry cites, one step further (D57 「按 D56 的新口径」, D56's entry
 * names the contracts of one plan). Decisions are met three ways: the work item carries one out (a relation it wrote),
 * cites one (in its title, what it does, or its row in the index), or is cited by one (a decision's entry names its
 * number; the ledger's lines, read where a decision stands).
 */
export function planThroughDecisions(store: ProjectStore, ledger: Ledger | null, t: WorkThread, shared: { readonly reach?: Reach; readonly index?: TraceIndex; readonly lines?: LineIndex; readonly time?: Chronology; readonly dropped?: string[] } = {}): PlanSuggestion[] {
  const reach = shared.reach ?? reachOf(store);
  const index = shared.index ?? traceIndex(store, reach, { ledger });
  // CR: with the project's chronology, a citation counts only when what it names existed at the citing record's date, and
  // an execution decision leads to no plan first written after it.
  const time = shared.time ?? null;
  const drop = (note: string) => { if (shared.dropped && !shared.dropped.includes(note)) shared.dropped.push(note); };
  const tName = t.ids[0] ?? squash(t.title).slice(0, 30);
  const after = (cited: string | null, citing: string | null): boolean => !!cited && !!citing && laterThan(cited, citing);
  // CQ (D104): the numbers met are the project's own (`numberMatcher`), not a fixed shape.
  const numbersOf = index.numbers;
  const isDecision = (r: ReferenceItem | undefined): r is ReferenceItem => !!r && (r.category === 'Decision' || r.category === 'Boundary') && !GONE.has(r.validity);
  const decisions = store.reference.filter((r) => isDecision(r));
  const byNumber = new Map<string, ReferenceItem>();
  for (const d of decisions) for (const i of d.ids) if (!byNumber.has(i.toUpperCase())) byNumber.set(i.toUpperCase(), d);
  const own = new Set(t.ids.map((i) => i.toUpperCase()));
  const entries = new Map<string, string>();
  const entryOf = (d: ReferenceItem): string => { let e = entries.get(d.id); if (e === undefined) { e = entryTextOf(store, d); entries.set(d.id, e); } return e; };

  // The decisions it meets, and how (the strongest way wins).
  const met = new Map<string, Through>();
  const meet = (id: string, how: Through) => { const was = met.get(id); if (!was || THROUGH_WEIGHT[how] > THROUGH_WEIGHT[was]) met.set(id, how); };
  for (const id of [...t.serves.map((s) => s.referenceId), ...store.relations.filter((r) => r.from === t.id && (r.type === 'carries out' || r.type === 'serves' || r.type === 'implements' || r.type === 'refines' || r.type === 'depends on')).map((r) => r.to)]) {
    if (isDecision(store.reference.get(id))) meet(id, 'carries out');
  }
  const ticket = ticketLines(ledger, t.ids);
  const records = time?.current(t.id) ?? null;
  for (const n of numbersOf([ownWords(t), t.results, ...ticket.rows].join('\n'))) {
    const d = byNumber.get(n);
    if (!d) continue;
    const first = time?.first(d.id) ?? null;
    if (after(first, records)) { drop(`${tName} names ${n}, first written ${first}, after its records of ${records}`); continue; }
    meet(d.id, 'cites');
  }
  // A decision that names this work item before it was first written does not cite it: the token is something else.
  const tFirst = time?.first(t.id) ?? null;
  const citedBy = (d: ReferenceItem): boolean => {
    const own = tFirst ? time!.own(d.id) : null;
    if (!citedAfter(tFirst, own, entryOf(d), tName)) return true;
    drop(`${d.ids[0] ?? squash(d.name).slice(0, 30)}'s entry names ${tName}, first written ${tFirst}, after that entry of ${own}`);
    return false;
  };
  if (own.size) {
    const naming = new RegExp(`(?<![A-Za-z0-9_-])(?:${[...own].map(esc).join('|')})(?![A-Za-z0-9_])`);
    let viaLedger = false;
    if (ledger) {
      const lines = shared.lines ?? lineIndex(store);
      for (const num of own) {
        let rows: { path: string; line: number }[] = [];
        try { rows = ledger.db.prepare("SELECT path, line FROM nums WHERE num = ? AND kind = 'doc' AND current = 1 AND place != 'definition' AND path IS NOT NULL AND line IS NOT NULL").all(num) as typeof rows; } catch { rows = []; }
        // A source often holds a section of many entries: of the decisions standing there, the one whose own entry names the number.
        for (const row of rows) for (const id of lines.itemsAt(row.path, row.line)) { const d = store.reference.get(id); if (isDecision(d) && naming.test(entryOf(d))) { viaLedger = true; if (citedBy(d)) meet(id, 'cited by'); } }
      }
    }
    // Without the ledger's lines (or when they place none): a decision whose own entry names the number.
    if (!viaLedger) for (const d of decisions) if (naming.test(entryOf(d)) && citedBy(d)) meet(d.id, 'cited by');
  }

  // Where each decision leads.
  const plansOfItem = (id: string): string[] => {
    const thread = store.threads.get(id);
    if (thread) return thread.id === t.id ? [] : reach.ofThread(thread).plans;
    const r = store.reference.get(id);
    if (!r) return [];
    return r.category === 'Plan' ? [r.id] : reach.ofReference(id).plans;
  };
  const leads = (d: ReferenceItem, depth: number, seen: Set<string>): string[] => {
    if (seen.has(d.id)) return [];
    seen.add(d.id);
    const label = d.ids[0] ?? squash(d.name).slice(0, 30);
    const own = time?.own(d.id) ?? null;
    const existed = (n: string, id: string): boolean => {
      const first = own ? time!.first(id) : null;
      if (!citedAfter(first, own, entryOf(d), n)) return true;
      drop(`${label}'s entry names ${n}, first written ${first}, after ${label}'s entry of ${own}`);
      return false;
    };
    // An execution decision executed a plan that existed at its date.
    const execution = time?.executionEntry(d) ?? false;
    const inTime = (plans: readonly string[], how: string): string[] => plans.filter((p) => {
      const first = execution && own ? time!.first(p) : null;
      if (!after(first, own)) return true;
      drop(`${label} leads to ${store.reference.get(p)?.name.split(NAME_SEP)[0]?.trim() ?? p} ${how}; that plan was first written ${first}, after ${label}'s entry of ${own}`);
      return false;
    });
    const direct = reach.ofReference(d.id).plans;
    if (direct.length) return inTime(direct, 'by where it is placed');
    const entry = entryOf(d);
    const tally = new Map<string, number>();
    for (const n of entryNames(store, d, index)) for (const p of new Set(index.resolve(n).filter((id) => existed(n, id)).flatMap(plansOfItem))) tally.set(p, (tally.get(p) ?? 0) + 1);
    if (tally.size) { const top = inTime([...tally].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 1), 'through what its entry names'); if (top.length) return top; }
    if (depth >= 2) return [];
    for (const n of numbersOf(entry)) {
      const next = byNumber.get(n);
      if (!next || next.id === d.id || !existed(n, next.id)) continue;
      const via = inTime(leads(next, depth + 1, seen), `through ${n}`);
      if (via.length) return via;
    }
    return [];
  };

  const out = new Map<string, { weight: number; through: string[] }>();
  for (const [id, how] of met) {
    const d = store.reference.get(id)!;
    for (const p of leads(d, 0, new Set())) {
      const at = out.get(p) ?? { weight: 0, through: [] };
      at.weight += THROUGH_WEIGHT[how];
      at.through.push(`${d.ids[0] ?? squash(d.name).slice(0, 30)} (${how})`);
      out.set(p, at);
    }
  }
  const rank = (s: string) => (s.endsWith('(carries out)') ? 0 : s.endsWith('(cites)') ? 1 : 2);
  return [...out].map(([planId, v]) => ({ planId, plan: store.reference.get(planId)?.name.split(NAME_SEP)[0]?.trim() ?? planId, through: v.through.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true })), weight: v.weight }))
    .sort((a, b) => b.weight - a.weight || a.plan.localeCompare(b.plan, undefined, { numeric: true }));
}
