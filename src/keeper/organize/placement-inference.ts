/**
 * Placement by the program (CQ, D104; Spec §1.4 落位: 执行层的派工、批次与没编号的工作单位，落在它们所执行的那个产品层计划里；
 * 归档的执行安排仍是落位的依据；确实没有的记明为什么，程序推得出时拒绝；程序先落、标 Inferred).
 *
 * The six-run read-through (2026-10-01) found every symptom the program only lists comes back: on the D103 run 12 tickets
 * and 61 of the execution log's entries were left unplaced with "their arrangement is archived", while the program's own
 * trace had already led to the plan. So the program places first, basis Inferred, and a reason for "no plan" is a record
 * it can refuse.
 *
 * - **The records lead.** A work item's plan and module are read off the records that place it, each a pointer the
 *   program follows: the row of a plan or dispatch table or of the index that lists it; the batch or row of an
 *   arrangement its own words name; its prompt's front matter (plan, batch, milestone, upstream, module); the contract it
 *   implements and that contract's plan; the decisions it carries out, cites or is cited by and the plan they lead to
 *   (placing.ts `planThroughDecisions`); a link or path in the ticket to a plan document; the directory it sits in when
 *   that is a plan's. **An execution arrangement, current or archived, places the work its rows list in the product-layer
 *   plan that arrangement executed** (`planOf`: what its header says it executes, else the one plan the contracts and
 *   tickets its rows name stand in — an item standing in several plans votes for none, and a table whose rows span
 *   several plans is an index of several and places nothing by itself). An execution decision (an entry of a log) follows
 *   the arrangement it belongs to — the batch, the row, the arrangement document or the log's own plan it names — to that
 *   plan (`inferDecision`).
 * - **One target, or none.** Where the pointers lead to exactly one plan (or one clearly heaviest) the program writes the
 *   placement — `serves` on a work item (its Area first when one is inferred, then the Plan), `refines` on a decision —
 *   basis Inferred, the chain in the claim, and records it on the round (`inferredPlacements`). It never overwrites or
 *   removes a placement a lane or the main agent wrote.
 * - **A program placement stays listed until it has a result** (CS; the owner's U86): unreviewed ones stand as placed and
 *   no gate refuses on them, but the list covers every round's, so a later round's cross-check is shown what an earlier
 *   round left; a result — confirmed, moved — lands on the record of the round that placed it (`noteOverride`,
 *   `settleProgramPlacements`, `confirmBySpotCheck`), and the handover note counts placed, confirmed, moved, unreviewed.
 * - **A reason is a record the program can refuse.** `noPlanWhy` / `noAreaWhy` on a work item are refused when the records
 *   lead to a plan or an area (the refusal names the chain), accepted when the chain is empty, and always accepted when the
 *   project has no plan layer (`planLayerPresent`) or no Areas.
 * - **Time order** (CR): a token a record names counts only when what it names was first written on or before the record's
 *   date, and a work item or an execution decision does not go to a plan first written after it (`placement-time.ts`).
 *   Each dropped token or lead is listed in the pointers tried with its dates; a refusal never names a dropped chain.
 * - **Generality** (D98): nothing here names one project's objects; a missing layer gives a defined zero.
 */
import { join } from 'node:path';
import type { Ledger } from '../../ledger/index.ts';
import { definitionsInPath } from '../../ledger/numbering.ts';
import type { ClerkRound, InferredPlacement } from '../../model/k-types.ts';
import type { ReferenceItem, WorkThread } from '../../model/types.ts';
import type { ProjectStore, TraceInfo } from '../../store/project-store.ts';
import { plansOf } from '../../process/placement.ts';
import { NAME_SEP, areaByWrittenName, entryTextOf, lineIndex, planThroughDecisions, reachOf, traceIndex, tracePlacement, type LineIndex, type Reach, type TraceIndex } from './placing.ts';
import { chronology, citedAfter, laterThan, type Chronology } from './placement-time.ts';
import { earlierWork } from './carried-on.ts';

const GONE = new Set(['Replaced', 'Removed']);
const slash = (p: string) => p.replace(/\\/g, '/');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const upper = (s: string) => s.trim().toUpperCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ───────────────────────── the pointers' weights ─────────────────────────

/** How much a pointer counts: what a record writes outright, over what it leads to through another item. */
const WEIGHT = {
  /** The row, the front matter or the entry writes the plan or module itself. */
  written: 5,
  /** The contract it implements; the arrangement (a plan document) that lists it or whose batch it names. */
  contract: 4,
  /** A link to the arrangement, or an item the record names that is placed. */
  record: 3,
  /** A decision the record names, one step away. */
  decision: 2,
  /** The directory it sits in; a citation. */
  faint: 1,
} as const;

/** Front-matter fields that say which plan, batch or milestone a prompt belongs to; which unit it follows; which module. */
const PLAN_FIELDS = /^(plan|plans|increment|milestone|phase|batch|sprint|iteration|stage|epic|release)$/i;
const UPSTREAM_FIELDS = /^(upstream|parent|follows|for|target|targets|contract|contracts|implements|task|tasks)$/i;
const AREA_FIELDS = /^(module|modules|area|areas|component|components|scope)$/i;
/** The words a batch or stage follows when a text names one by its label (`批次 B`, `batch 3`, `阶段 2`): a bilingual word list. */
const BATCH_WORDS = /(?:批次|批|阶段|第\s*\d+\s*批|batch|stage|phase|sprint|step)\s*([A-Za-z0-9][A-Za-z0-9]{0,3})(?![\p{L}\p{N}_])/giu;

export interface Lead {
  readonly id: string;
  /** The Plan or Area by its short name. */
  readonly name: string;
  readonly category: 'Plan' | 'Area';
  readonly weight: number;
  /** How the records lead there, each step in words the main agent can check (at most three). */
  readonly through: readonly string[];
}

export interface Inference {
  /** The plans the records lead to, heaviest first. */
  readonly plans: readonly Lead[];
  /** The areas the records lead to, heaviest first. */
  readonly areas: readonly Lead[];
  /** The pointers tried and what each gave, for a reason the program accepts and for the spot-check. */
  readonly tried: readonly string[];
}

class Tally {
  private readonly at = new Map<string, { weight: number; through: string[] }>();
  private readonly store: ProjectStore;
  constructor(store: ProjectStore) { this.store = store; }
  add(id: string, weight: number, how: string): void {
    const t = this.at.get(id) ?? { weight: 0, through: [] };
    t.weight += weight;
    if (!t.through.includes(how) && t.through.length < 3) t.through.push(how);
    this.at.set(id, t);
  }
  get size(): number { return this.at.size; }
  leads(): Lead[] {
    return [...this.at].map(([id, t]) => ({ id, name: shortName(this.store, id), category: (this.store.reference.get(id)?.category === 'Area' ? 'Area' : 'Plan') as 'Plan' | 'Area', weight: t.weight, through: t.through }))
      .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }
}

export const shortName = (store: ProjectStore, id: string): string => {
  const r = store.reference.get(id);
  if (r) return squash(r.name.split(NAME_SEP)[0] ?? r.name) || r.name;
  const t = store.threads.get(id);
  return t ? t.ids[0] ?? t.title : id;
};
const threadName = (t: WorkThread): string => (t.ids[0] && !t.title.includes(t.ids[0]) ? `${t.ids[0]} ${t.title}` : t.title);
const refName = (r: ReferenceItem): string => (r.ids[0] && !r.name.startsWith(r.ids[0]) ? `${r.ids[0]} ${r.name}` : r.name);
const listOf = (names: readonly string[], n = 4): string => `${names.slice(0, n).join(', ')}${names.length > n ? ` (+${names.length - n})` : ''}`;

/** The lead the program may act on: the only one, or the one clearly heaviest; null when none or a tie. */
export function pick(leads: readonly Lead[]): Lead | null {
  if (!leads.length) return null;
  if (leads.length === 1 || leads[0]!.weight > leads[1]!.weight) return leads[0]!;
  return null;
}

// ───────────────────────── the project's arrangements, as the ledger read them ─────────────────────────

export interface ArrangementFile {
  /** Repository-relative, with forward slashes. */
  readonly path: string;
  readonly repo: string | null;
  readonly kind: 'index' | 'plan' | 'prompt' | 'status' | 'receipt';
  readonly ident: string | null;
  readonly title: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly rows: readonly { readonly id: string; readonly cells: Readonly<Record<string, string>>; readonly line: number }[];
  readonly batches: readonly string[];
}
type Row = ArrangementFile['rows'][number];

/** Every arrangement file the checkout has now (`plans.current = 1`): archived ones included, each path once. */
export function arrangementFiles(ledger: Ledger | null): ArrangementFile[] {
  if (!ledger) return [];
  let rows: { repo: string | null; path: string; kind: string; ident: string | null; data: string }[] = [];
  try { rows = ledger.db.prepare('SELECT repo, path, kind, ident, data FROM plans WHERE current = 1 ORDER BY repo IS NULL, path').all() as typeof rows; } catch { rows = []; }
  let repos: { id: string; path: string }[] = [];
  try { repos = ledger.repos().map((r) => ({ id: r.id, path: slash(r.path).replace(/\/+$/, '') })); } catch { repos = []; }
  const out = new Map<string, ArrangementFile>();
  for (const r of rows) {
    let path = slash(r.path);
    let repo = r.repo;
    // A file read outside version control is keyed by its absolute path: make it repository-relative when it is in one.
    if (/^(?:[A-Za-z]:)?\//.test(path)) {
      const root = repos.filter((x) => path.toLowerCase().startsWith(`${x.path.toLowerCase()}/`)).sort((a, b) => b.path.length - a.path.length)[0];
      if (root) { path = path.slice(root.path.length + 1); repo ??= root.id; }
    }
    if (out.has(path) && out.get(path)!.repo !== null) continue;
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(r.data) as Record<string, unknown>; } catch { data = {}; }
    const kind = (['index', 'plan', 'prompt', 'status', 'receipt'].includes(r.kind) ? r.kind : 'receipt') as ArrangementFile['kind'];
    out.set(path, {
      path, repo, kind, ident: r.ident, title: typeof data.title === 'string' ? data.title : '',
      fields: (data.fields && typeof data.fields === 'object' ? data.fields : {}) as Record<string, string>,
      rows: Array.isArray(data.rows) ? (data.rows as ArrangementFile['rows']) : [],
      batches: Array.isArray(data.batches) ? (data.batches as string[]) : [],
    });
  }
  return [...out.values()];
}

/** The leading token of a row's id (`B1b`, `A · D56 与非 agent 规则` → `A`, `**F · 先做的小件**` → `F`, `C1／C2` → `C1`), upper case. */
const rowToken = (id: string): string => upper((id.replace(/[*`[\]]/g, '').split(NAME_SEP)[0] ?? '').split(/[\s／/、,]+/)[0] ?? '');

// ───────────────────────── the context one run shares ─────────────────────────

export interface InferenceContext {
  readonly store: ProjectStore;
  readonly ledger: Ledger | null;
  readonly reach: Reach;
  readonly index: TraceIndex;
  readonly lines: LineIndex;
  readonly files: readonly ArrangementFile[];
  readonly areas: readonly ReferenceItem[];
  /** The plan an arrangement executed, by what its header and rows say (cached); empty for an index of several plans' work. */
  readonly planOf: (file: ArrangementFile) => readonly Lead[];
  /** The plans a decision leads to: the plan it sits on, else what its entry names, else the decisions it names (cached). */
  readonly decisionLeads: (d: ReferenceItem) => readonly { readonly id: string; readonly through: string }[];
  /** The Areas and Plans an item of the workbench stands in (a thread by what it serves, a reference item by what it refines). */
  readonly placesOf: (id: string) => { readonly plans: readonly string[]; readonly areas: readonly string[] };
  /** The items a written name stands for: what `traceIndex` resolves, and a decision or boundary by its number. */
  readonly resolve: (name: string) => string[];
  /** The index and plan rows that list a number: the row's own id, or a list-shaped cell naming it. */
  readonly rowsNaming: (nums: readonly string[]) => { readonly file: ArrangementFile; readonly row: Row }[];
  /** The rows of plan arrangements a text names by their batch or row id (`B2`, `批次 B`, `S2a`). */
  readonly rowsNamedIn: (text: string) => { readonly file: ArrangementFile; readonly row: Row; readonly token: string }[];
  /** The prompts of a number: the arrangement files about it. */
  readonly promptsOf: (nums: readonly string[]) => ArrangementFile[];
  /** The arrangement file a written path names, by its end. */
  readonly fileByPath: (written: string) => ArrangementFile | null;
  /** The text of an arrangement file as the ledger holds it now (its prompt body), or null. */
  readonly textOf: (file: ArrangementFile) => string | null;
  /** The Plan items whose own document is this file (repository-relative path), by the Plans' sources. */
  readonly plansInDocument: (rel: string) => ReferenceItem[];
  /** The project's chronology: when items were first written, and the dates of the records that cite them (CR). */
  readonly time: Chronology;
  /**
   * Whether a token a record names counts: what it names was first written on or before the record's date (one day of
   * slack); when not, the note ("its entry names CN, first written 2026-10-01, after this entry of 2026-09-22") goes to
   * `tried`. Unknown dates keep the token.
   */
  readonly existed: (citing: Citing, n: string, id: string, tried: string[]) => boolean;
  /** What a decision's own entry named and the program dropped for time order, as notes (cached with `decisionLeads`). */
  readonly decisionDrops: (d: ReferenceItem) => readonly string[];
}

/**
 * A record that cites: its date, how a citation from it is said (`its entry`), and how the record itself is said (`this
 * entry`); for an entry, its text (a later note in it that names the token cites as of the date that note writes).
 */
export interface Citing { readonly day: string | null; readonly how: string; readonly self: string; readonly text?: string }

const noteOf = (citing: Citing, n: string, first: string): string => `${citing.how} names ${n}, first written ${first}, after ${citing.self} of ${citing.day}`;

export function inferenceContext(store: ProjectStore, ledger: Ledger | null, shared: { readonly reach?: Reach; readonly index?: TraceIndex; readonly lines?: LineIndex; readonly time?: Chronology } = {}): InferenceContext {
  const reach = shared.reach ?? reachOf(store);
  const index = shared.index ?? traceIndex(store, reach, { ledger });
  const lines = shared.lines ?? lineIndex(store);
  const time = shared.time ?? chronology(store, ledger);
  const existed = (citing: Citing, n: string, id: string, tried: string[]): boolean => {
    if (!citing.day) return true;
    const first = time.first(id);
    if (!citedAfter(first, citing.day, citing.text, n)) return true;
    const note = noteOf(citing, n, first!);
    if (!tried.includes(note)) tried.push(note);
    return false;
  };
  const files = arrangementFiles(ledger);
  const areas = store.reference.filter((r) => r.category === 'Area' && !GONE.has(r.validity) && r.validity !== 'Abandoned');
  const isDecision = (r: ReferenceItem | undefined): r is ReferenceItem => !!r && (r.category === 'Decision' || r.category === 'Boundary');
  const decisionByNumber = new Map<string, ReferenceItem>();
  for (const d of store.reference.filter((r) => isDecision(r) && !GONE.has(r.validity))) for (const i of d.ids) if (!decisionByNumber.has(upper(i))) decisionByNumber.set(upper(i), d);
  const resolve = (name: string): string[] => {
    const ids = index.resolve(name);
    const d = decisionByNumber.get(upper(name));
    return d && !ids.includes(d.id) ? [...ids, d.id] : ids;
  };
  const placesOf = (id: string) => {
    const t = store.threads.get(id);
    if (t) return reach.ofThread(t);
    const r = store.reference.get(id);
    if (!r) return { plans: [], areas: [] };
    if (r.category === 'Plan') return { plans: [id], areas: [] };
    if (r.category === 'Area') return { plans: [], areas: [id] };
    const x = reach.ofReference(id);
    return { plans: x.plans, areas: x.areas };
  };
  const kindOf = (id: string): 'Plan' | 'Area' | 'Decision' | 'item' | null => {
    if (store.threads.has(id)) return 'item';
    const r = store.reference.get(id);
    if (!r) return null;
    return r.category === 'Plan' ? 'Plan' : r.category === 'Area' ? 'Area' : isDecision(r) ? 'Decision' : 'item';
  };
  /** The one plan an item stands in; null when none or several (an item in several plans votes for none). */
  const onePlan = (id: string): string | null => { const p = placesOf(id).plans; return p.length === 1 ? p[0]! : null; };

  // A decision leads through at most one other decision (D57 → D56 → the contracts of one plan); the cache keeps only
  // what a decision leads to on its own, so cached chains never stitch into longer ones.
  const decisionCache = new Map<string, { id: string; through: string }[]>();
  const dropCache = new Map<string, string[]>();
  const decisionLeads = (d: ReferenceItem, depth = 0): { id: string; through: string }[] => {
    const hit = depth === 0 ? decisionCache.get(d.id) : undefined;
    if (hit) return hit;
    if (depth > 1) return [];
    const label = d.ids[0] ?? clip(squash(d.name), 30);
    // CR: what its entry names counts only when it existed at the entry's date; an execution decision leads to no plan
    // first written after it.
    const drops: string[] = [];
    const own = time.own(d.id);
    const citing: Citing = { day: own, how: `${label}'s entry`, self: `${label}'s entry`, text: entryTextOf(store, d) };
    const execution = time.executionEntry(d);
    const inTime = (leads: { id: string; through: string }[]): { id: string; through: string }[] => leads.filter((l) => {
      const first = execution && own ? time.first(l.id) : null;
      if (!first || !laterThan(first, own!)) return true;
      const note = `${label} leads to ${shortName(store, l.id)} (${l.through}); ${shortName(store, l.id)} was first written ${first}, after ${label}'s entry of ${own}`;
      if (!drops.includes(note)) drops.push(note);
      return false;
    });
    let out: { id: string; through: string }[] = [];
    const direct = reach.ofReference(d.id).plans;
    if (direct.length) out = inTime(direct.map((p) => ({ id: p, through: `${label} is placed on ${shortName(store, p)}` })));
    else {
      const entry = entryTextOf(store, d);
      const names = index.named(entry).filter((n) => n.toUpperCase() !== (d.ids[0] ?? '').toUpperCase());
      const tally = new Map<string, { n: number; names: string[] }>();
      const vote = (p: string, n: string, w: number) => { const t = tally.get(p) ?? { n: 0, names: [] }; t.n += w; if (!t.names.includes(n)) t.names.push(n); tally.set(p, t); };
      for (const n of names) for (const id of resolve(n)) {
        if (!existed(citing, n, id, drops)) continue;
        const k = kindOf(id);
        if (k === 'Plan') vote(id, n, 2);
        else if (k === 'item') { const p = onePlan(id); if (p) vote(p, n, 1); }
      }
      if (tally.size) {
        const best = [...tally].sort((a, b) => b[1].n - a[1].n);
        const top = best.filter((x) => x[1].n === best[0]![1].n);
        out = inTime(top.map(([p, t]) => ({ id: p, through: t.names.some((n) => resolve(n).includes(p)) ? `${label}'s entry names ${listOf(t.names)}` : `${label}'s entry names ${listOf(t.names)}, which serve ${shortName(store, p)}` })));
      }
      if (!out.length) {
        for (const n of names) {
          const next = decisionByNumber.get(upper(n));
          if (!next || next.id === d.id || !existed(citing, n, next.id, drops)) continue;
          const via = inTime(decisionLeads(next, depth + 1).map((v) => ({ id: v.id, through: `${label}'s entry names ${n}; ${v.through}` })));
          if (depth === 0) for (const x of dropCache.get(next.id) ?? []) if (!drops.includes(x)) drops.push(x);
          if (via.length) { out = via; break; }
        }
      }
    }
    if (depth === 0) { decisionCache.set(d.id, out); dropCache.set(d.id, drops); }
    return out;
  };
  const decisionDrops = (d: ReferenceItem): readonly string[] => { if (!dropCache.has(d.id)) decisionLeads(d); return dropCache.get(d.id) ?? []; };

  const planCache = new Map<string, Lead[]>();
  const planOf = (file: ArrangementFile): Lead[] => {
    const hit = planCache.get(file.path);
    if (hit) return hit;
    // An index of the project's work lists every plan's tickets: it executes no plan of its own, and only a row's own
    // cells (an increment or module column) place the work it lists.
    if (file.kind === 'index') { planCache.set(file.path, []); return []; }
    const tally = new Tally(store);
    const header = [file.title, ...Object.entries(file.fields).filter(([k]) => PLAN_FIELDS.test(k) || UPSTREAM_FIELDS.test(k)).map(([, v]) => v), ...file.batches.slice(0, 20)].join('\n');
    const headerPlans = new Set<string>();
    // CR: what the arrangement names counts only when it existed when the arrangement (its header, its row) was last written.
    const unused: string[] = [];
    const headerCiting: Citing = { day: time.file(file.path), how: 'its header', self: 'the arrangement' };
    for (const n of index.named(header)) {
      for (const id of resolve(n)) {
        if (!existed(headerCiting, n, id, unused)) continue;
        const k = kindOf(id);
        if (k === 'Plan') { tally.add(id, WEIGHT.written, `its header names ${n}`); headerPlans.add(id); }
        else if (k === 'item') { const p = onePlan(id); if (p) tally.add(p, WEIGHT.decision, `its header names ${n}, which serves ${shortName(store, p)}`); }
        // A decision the header names is one step removed from the arrangement's own rows: it counts for half a citation.
        else if (k === 'Decision') for (const lead of decisionLeads(store.reference.get(id)!)) tally.add(lead.id, WEIGHT.faint / 2, `its header names ${n}; ${lead.through}`);
      }
    }
    // Its rows: a cell that writes the plan; the contracts and tickets its rows name, each voting for the one plan it
    // stands in (an item in several plans votes for none).
    const byPlan = new Map<string, Set<string>>();
    let written = 0;
    for (const row of file.rows) {
      const rowCiting: Citing = { day: time.line(file.path, row.line), how: 'its row', self: 'that row' };
      for (const value of Object.values(row.cells)) {
        for (const n of index.named(value)) {
          for (const id of resolve(n)) {
            if (!existed(rowCiting, n, id, unused)) continue;
            const k = kindOf(id);
            if (k === 'Plan') { tally.add(id, WEIGHT.record, `its row ${clip(row.id, 20)} writes ${n}`); written += 1; }
            else if (k === 'item') { const p = onePlan(id); if (p) { const s = byPlan.get(p) ?? new Set(); s.add(n); byPlan.set(p, s); } }
          }
        }
      }
    }
    // What its header writes outright decides; the rows then only add their evidence to that plan.
    if (headerPlans.size) {
      for (const [p, names] of byPlan) if (headerPlans.has(p)) tally.add(p, Math.min(12, names.size), `its rows name ${listOf([...names])}, which serve ${shortName(store, p)}`);
      const out = tally.leads().filter((l) => headerPlans.has(l.id));
      planCache.set(file.path, out);
      return out;
    }
    // Else the one plan its rows' contracts and tickets stand in — clearly (twice the runner-up), or the file is a table
    // of several plans' work and places nothing by itself.
    for (const [p, names] of byPlan) tally.add(p, Math.min(12, names.size) * (written ? 0.5 : 1), `its rows name ${listOf([...names])}, which serve ${shortName(store, p)}`);
    const all = tally.leads().filter((l) => l.category === 'Plan');
    const out = all.length === 1 || (all.length > 1 && all[0]!.weight >= 2 * all[1]!.weight) ? all.slice(0, 1) : [];
    planCache.set(file.path, out);
    return out;
  };

  /** A cell that is a list of numbers (`AB、AC`, `CKC-02（词表）、CKC-04`, `CKC-02～CKC-05`): nothing but numbers, ranges and separators once the parentheticals are gone. */
  const listCell = (cell: string): boolean => {
    const bare = cell.replace(/[（(][^（()）]*[)）]/g, ' ').replace(/\[[^\]]*\]\([^)]*\)/g, ' ').replace(/[*`]/g, '');
    const nums = index.numbers(bare);
    if (!nums.length) return false;
    let rest = bare;
    for (const n of nums) rest = rest.replace(new RegExp(esc(n), 'gi'), ' ');
    return rest.replace(/[\p{P}\p{S}\s\d]/gu, '').length <= 2;
  };
  /** Whether a row lists a number: its id cell is the number, or a list-shaped cell names it (a prose mention does not list). */
  const rowLists = (row: Row, want: ReadonlySet<string>): boolean => {
    if (want.has(rowToken(row.id)) || index.numbers(row.id).some((n) => want.has(n))) return true;
    return Object.values(row.cells).some((c) => listCell(c) && index.numbers(c).some((n) => want.has(n)));
  };
  const rowsNaming = (nums: readonly string[]) => {
    const want = new Set(nums.map(upper));
    const out: { file: ArrangementFile; row: Row }[] = [];
    for (const file of files) {
      if (file.kind !== 'index' && file.kind !== 'plan') continue;
      for (const row of file.rows) if (rowLists(row, want)) out.push({ file, row });
    }
    return out;
  };
  // The batch and row ids of the plan arrangements (`B2`, `B1b`, `S2a`, `A`). A row whose id is a project number (a
  // dispatch table keyed by ticket) is that ticket's own row, not a batch, and is left to the number pointers. A text
  // names a batch by a label with a digit as a whole token (`B2`), or by any label after a batch word (`批次 B`): a bare
  // letter or word (`A`, `UI`) is prose otherwise.
  const rowIds = new Map<string, { file: ArrangementFile; row: Row }[]>();
  for (const file of files) if (file.kind === 'plan') for (const row of file.rows) { const tok = rowToken(row.id); if (tok && /^[A-Z0-9][A-Z0-9.-]{0,7}$/.test(tok) && !/^\d+$/.test(tok) && !resolve(tok).length) rowIds.set(tok, [...(rowIds.get(tok) ?? []), { file, row }]); }
  const longIds = [...rowIds.keys()].filter((k) => k.length >= 2 && /\d/.test(k));
  const longRe = longIds.length ? new RegExp(`(?<![\\p{L}\\p{N}_#-])(?:${longIds.sort((a, b) => b.length - a.length).map(esc).join('|')})(?![\\p{L}\\p{N}_])`, 'giu') : null;
  const rowsNamedIn = (text: string) => {
    const out: { file: ArrangementFile; row: Row; token: string }[] = [];
    const seen = new Set<string>();
    const take = (tok: string) => { for (const hit of rowIds.get(tok) ?? []) { const key = `${hit.file.path}:${hit.row.line}`; if (!seen.has(key)) { seen.add(key); out.push({ ...hit, token: tok }); } } };
    if (longRe) for (const m of text.matchAll(longRe)) take(upper(m[0]));
    for (const m of text.matchAll(BATCH_WORDS)) take(upper(m[1]!));
    return out;
  };
  const promptsOf = (nums: readonly string[]) => {
    const want = new Set(nums.map(upper));
    return files.filter((f) => f.kind === 'prompt' && ((f.ident && want.has(upper(f.ident))) || definitionsInPath(f.path).some((d) => want.has(upper(d.num)))));
  };
  const fileByPath = (written: string): ArrangementFile | null => {
    const p = slash(written).replace(/^\.\//, '').replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
    if (!p) return null;
    return files.find((f) => f.path.toLowerCase() === p) ?? files.find((f) => f.path.toLowerCase().endsWith(`/${p}`)) ?? null;
  };
  const textCache = new Map<string, string | null>();
  let repos: { id: string; path: string }[] | null = null;
  const textOf = (file: ArrangementFile): string | null => {
    if (!ledger) return null;
    if (textCache.has(file.path)) return textCache.get(file.path)!;
    let text: string | null = null;
    try {
      repos ??= ledger.repos().map((r) => ({ id: r.id, path: r.path }));
      const root = repos.find((r) => r.id === file.repo) ?? repos[0];
      if (root) text = ledger.currentText(join(root.path, ...file.path.split('/')));
    } catch { text = null; }
    textCache.set(file.path, text);
    return text;
  };
  const plansInDocument = (rel: string): ReferenceItem[] => {
    const key = slash(rel).toLowerCase();
    return store.reference.filter((r) => r.category === 'Plan' && !GONE.has(r.validity) && r.sourceIds.some((sid) => { const a = store.sources.get(sid)?.anchor; return a?.kind === 'file' && slash(a.path).toLowerCase().endsWith(`/${key}`); }));
  };
  return { store, ledger, reach, index, lines, files, areas, planOf, decisionLeads, placesOf, resolve, rowsNaming, rowsNamedIn, promptsOf, fileByPath, textOf, plansInDocument, time, existed, decisionDrops };
}

// ───────────────────────── following what a record writes ─────────────────────────

/** Markdown links and bare paths to Markdown documents in a text, as written. */
export function pathsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]*)?\)/gi)) out.add(m[1]!);
  for (const m of text.matchAll(/(?<![\w./\\-])((?:[\w.-]+[\\/])+[\w.-]+\.md)(?![\w.])/gi)) out.add(m[1]!);
  return [...out];
}

const ownWords = (t: WorkThread): string => [t.title, t.doing, t.results].filter(Boolean).join('\n');

interface Weights { readonly written: number; readonly item: number; readonly decision: number }

/**
 * What a written value leads to — a plan or an area written outright, a contract or ticket placed, a decision one step
 * away — added to the tallies. A token naming what did not exist yet at the citing record's date is dropped (CR), noted in
 * `tried`.
 */
function follow(ctx: InferenceContext, value: string, how: string, plans: Tally, areas: Tally, w: Weights, citing: Citing, tried: string[]): boolean {
  let found = false;
  for (const n of ctx.index.named(value)) {
    for (const id of ctx.resolve(n)) {
      if (!ctx.existed(citing, n, id, tried)) continue;
      const r = ctx.store.reference.get(id);
      if (r?.category === 'Plan') { plans.add(id, w.written, `${how} ${n}`); found = true; }
      else if (r?.category === 'Area') { areas.add(id, w.written, `${how} ${n}`); found = true; }
      else if (r && (r.category === 'Decision' || r.category === 'Boundary')) {
        for (const lead of ctx.decisionLeads(r)) { plans.add(lead.id, w.decision, `${how} ${n}; ${lead.through}`); found = true; }
        for (const note of ctx.decisionDrops(r)) { const x = `${how} ${n}; ${note}`; if (!tried.includes(x)) tried.push(x); }
        for (const a of ctx.reach.ofReference(r.id).areas) { areas.add(a, w.decision, `${how} ${n}, which is placed on ${shortName(ctx.store, a)}`); found = true; }
      } else if (r || ctx.store.threads.has(id)) {
        const at = ctx.placesOf(id);
        for (const p of at.plans) { plans.add(p, w.item / at.plans.length, `${how} ${n}, which serves ${shortName(ctx.store, p)}`); found = true; }
        for (const a of at.areas) { areas.add(a, w.item / at.areas.length, `${how} ${n}, which serves ${shortName(ctx.store, a)}`); found = true; }
      }
    }
  }
  // A module written by its short form (a Module column's cell, a prompt's `module:`).
  const area = areaByWrittenName(ctx.areas, value);
  if (area) { areas.add(area.id, w.written, `${how} ${squash(value)}`); found = true; }
  return found;
}

/** The batches or rows of plan arrangements a text names, each leading to the plan that arrangement executed (a batch first written after the citing record is dropped, CR). */
function followRows(ctx: InferenceContext, text: string, how: string, plans: Tally, citing: Citing, tried: string[]): boolean {
  let found = false;
  for (const { file, row, token } of ctx.rowsNamedIn(text)) {
    const first = citing.day ? ctx.time.firstIn(token, file.path) : null;
    if (first && laterThan(first, citing.day!)) { const note = `${noteOf(citing, `${token} (a row of ${file.path})`, first)}`; if (!tried.includes(note)) tried.push(note); continue; }
    const executed = ctx.planOf(file);
    if (!executed.length) continue;
    // The arrangement that lists the work by its own batch is the record Spec §1.4 places by: it counts as written.
    plans.add(executed[0]!.id, WEIGHT.written, `${how} ${token}, a row of ${file.path} (line ${row.line}), which executed ${executed[0]!.name}`);
    found = true;
  }
  return found;
}

/** A link or path in a text to an arrangement or a plan document, each leading to its plan. */
function followPaths(ctx: InferenceContext, text: string, how: string, plans: Tally): boolean {
  let found = false;
  for (const p of pathsIn(text)) {
    const file = ctx.fileByPath(p);
    if (file && (file.kind === 'plan' || file.kind === 'index')) {
      for (const lead of ctx.planOf(file).slice(0, 1)) { plans.add(lead.id, WEIGHT.record, `${how} ${file.path}, which executed ${lead.name} (${lead.through[0] ?? 'by its rows'})`); found = true; }
      continue;
    }
    const docs = ctx.plansInDocument(p.replace(/^\.\//, ''));
    if (docs.length === 1) { plans.add(docs[0]!.id, WEIGHT.decision, `${how} ${p}, the document of ${shortName(ctx.store, docs[0]!.id)}`); found = true; }
  }
  return found;
}

// ───────────────────────── the pointers of a work item ─────────────────────────

/** Where the records lead for a work item: its plan and its module, with the pointers tried. */
export function inferThread(ctx: InferenceContext, t: WorkThread): Inference {
  const { store } = ctx;
  const plans = new Tally(store);
  const areas = new Tally(store);
  const tried: string[] = [];
  const nums = [...new Set([...t.ids.map(upper), ...(t.ids.length ? [] : [upper(t.id)])])].filter((n) => n.length >= 2 && n.length <= 24);
  // CR: each of its records cites as of the date it was last written; its own words as of its records now.
  const records: Citing = { day: ctx.time.current(t.id), how: 'it', self: 'its records' };

  // a · the rows of a plan or dispatch table, and of the index, that list it.
  const rows = nums.length ? ctx.rowsNaming(nums) : [];
  if (!rows.length) tried.push('no plan or dispatch table and no index row lists it');
  for (const { file, row } of rows) {
    const where = `${file.path}:${row.line}`;
    const before = plans.size;
    const rowCiting: Citing = { day: ctx.time.line(file.path, row.line) ?? records.day, how: `its row (${where})`, self: 'that row' };
    for (const [header, value] of Object.entries(row.cells)) follow(ctx, value, `its row (${where}) writes ${header}:`, plans, areas, { written: WEIGHT.written, item: WEIGHT.record, decision: WEIGHT.decision }, rowCiting, tried);
    if (plans.size > before) continue;
    const executed = ctx.planOf(file);
    // A plan arrangement that lists the work is the record Spec §1.4 places by: it counts as written.
    if (executed.length) plans.add(executed[0]!.id, WEIGHT.written, `${file.path} lists it (line ${row.line}); that arrangement executed ${executed[0]!.name} (${executed[0]!.through[0] ?? 'by its rows'})`);
    else tried.push(`${file.path} lists it (line ${row.line}) but ${file.kind === 'index' ? "its row writes no plan or module (an index of every plan's work places only by its row's own cells)" : 'that arrangement names no plan, or names several'}`);
  }

  // b · the batch or row of an arrangement its own words name (`D59 批次 B`, `B2`).
  if (!followRows(ctx, ownWords(t), 'its own words name', plans, records, tried)) tried.push('its own words name no batch or row of an arrangement');

  // c · its prompt's front matter.
  const prompts = nums.length ? ctx.promptsOf(nums) : [];
  if (!prompts.length) tried.push('no prompt of its own carries metadata');
  for (const f of prompts) {
    let any = false;
    const promptCiting: Citing = { day: ctx.time.file(f.path) ?? records.day, how: `its front matter (${f.path})`, self: 'that prompt' };
    for (const [k, v] of Object.entries(f.fields)) {
      if (PLAN_FIELDS.test(k) || AREA_FIELDS.test(k)) any = follow(ctx, v, `its front matter (${f.path}) says ${k}:`, plans, areas, { written: WEIGHT.written, item: WEIGHT.record, decision: WEIGHT.decision }, promptCiting, tried) || any;
      else if (UPSTREAM_FIELDS.test(k)) any = follow(ctx, v, `its front matter (${f.path}) says ${k}:`, plans, areas, { written: WEIGHT.record, item: WEIGHT.record, decision: WEIGHT.decision }, promptCiting, tried) || any;
    }
    if (!any) tried.push(`its prompt ${f.path} carries metadata (${Object.keys(f.fields).slice(0, 6).join(', ')}) that names no plan or module`);
  }

  // d · the contract it implements.
  const contracts = store.relations.filter((r) => r.type === 'implements' && r.from === t.id).map((r) => r.to);
  if (!contracts.length) tried.push('it implements no contract');
  for (const c of contracts) {
    const name = store.threads.get(c)?.ids[0] ?? store.reference.get(c)?.ids[0] ?? shortName(store, c);
    const at = ctx.placesOf(c);
    for (const p of at.plans) plans.add(p, WEIGHT.contract / at.plans.length, `it implements ${name}, which serves ${shortName(store, p)}`);
    at.areas.forEach((a, i) => areas.add(a, i === 0 ? WEIGHT.contract : WEIGHT.record, `it implements ${name}, which serves ${shortName(store, a)}`));
    if (!at.plans.length && !at.areas.length) tried.push(`it implements ${name}, which is placed nowhere yet`);
  }

  // e · the decisions it carries out, cites or is cited by. What it carries out counts in full (3 each); citations are one
  // kind of evidence and diminish: the first `cites` 2 and each further 1, the first `cited by` 1 and each further ½ (a
  // later decision that reviews old work as history names many old numbers).
  const via = planThroughDecisions(store, ctx.ledger, t, { reach: ctx.reach, index: ctx.index, lines: ctx.lines, time: ctx.time, dropped: tried });
  if (!via.length) tried.push('no decision it carries out, cites or is cited by leads to a plan');
  for (const s of via) {
    const kinds = s.through.map((x) => (x.endsWith('(carries out)') ? 'carries out' : x.endsWith('(cites)') ? 'cites' : 'cited by'));
    const n = (k: string) => kinds.filter((x) => x === k).length;
    const weight = n('carries out') * 3 + (n('cites') ? 2 + (n('cites') - 1) : 0) + (n('cited by') ? 1 + (n('cited by') - 1) * 0.5 : 0);
    plans.add(s.planId, weight, `${s.through.slice(0, 3).join(', ')} → ${s.plan}`);
  }

  // f · a link or path to a plan document, in its own words or its prompt.
  const texts = [ownWords(t), ...prompts.map((f) => ctx.textOf(f) ?? '')].join('\n');
  if (!followPaths(ctx, texts, 'it links', plans)) tried.push('no link or path to a plan document');

  // g · the directory it sits in, when that is one plan's.
  for (const dir of [...new Set(prompts.map((f) => f.path.split('/').slice(0, -1).join('/')))]) {
    if (!dir) continue;
    const key = `/${dir.toLowerCase()}/`;
    const here = store.reference.filter((r) => r.category === 'Plan' && !GONE.has(r.validity) && r.sourceIds.some((sid) => {
      const a = store.sources.get(sid)?.anchor;
      if (a?.kind !== 'file') return false;
      const p = slash(a.path).toLowerCase();
      const at = p.indexOf(key);
      return at >= 0 && !p.slice(at + key.length).includes('/');
    }));
    if (here.length === 1) plans.add(here[0]!.id, WEIGHT.faint, `it sits in ${dir}/, the directory of ${shortName(store, here[0]!.id)}'s document`);
  }
  return { plans: inTimeOf(ctx, ctx.time.own(t.id), 'this work item', plans.leads(), tried), areas: areas.leads(), tried };
}

/**
 * CR: a work item or an execution decision does not go to a plan first written after it — the plan it executed existed at
 * its date. Each dropped lead is noted in `tried`. Unknown dates keep the lead.
 */
function inTimeOf(ctx: InferenceContext, own: string | null, self: string, leads: readonly Lead[], tried: string[]): Lead[] {
  if (!own) return [...leads];
  return leads.filter((l) => {
    if (l.category !== 'Plan') return true;
    const first = ctx.time.first(l.id);
    if (!first || !laterThan(first, own)) return true;
    tried.push(`leads to ${l.name} through ${l.through[0] ?? 'its records'}; ${l.name} was first written ${first}, after ${self} of ${own}`);
    return false;
  });
}

// ───────────────────────── the pointers of a decision or boundary ─────────────────────────

/** Where the records lead for a decision or boundary placed nowhere: the plan its arrangement executed, or the module it acts on. */
export function inferDecision(ctx: InferenceContext, d: ReferenceItem): Inference {
  const { store } = ctx;
  const plans = new Tally(store);
  const areas = new Tally(store);
  const tried: string[] = [];
  const own = (d.ids[0] ?? '').toUpperCase();
  const entry = entryTextOf(store, d);
  // CR: its entry cites as of the entry's own date.
  const ownDay = ctx.time.own(d.id);
  const citing: Citing = { day: ownDay, how: 'its entry', self: 'this entry', text: entry };

  // 1 · what its own entry names: a plan, a module, a contract, a ticket, a decision.
  const names = ctx.index.named(entry).filter((n) => n.toUpperCase() !== own);
  let named = false;
  for (const n of names) {
    for (const id of ctx.resolve(n)) {
      if (!ctx.existed(citing, n, id, tried)) continue;
      const r = store.reference.get(id);
      if (r?.category === 'Plan') { plans.add(id, WEIGHT.written, `its entry names ${n}`); named = true; }
      else if (r?.category === 'Area') { areas.add(id, WEIGHT.written, `its entry names ${n}`); named = true; }
      else if (r && (r.category === 'Decision' || r.category === 'Boundary')) {
        for (const lead of ctx.decisionLeads(r)) { plans.add(lead.id, WEIGHT.decision, `its entry names ${n}; ${lead.through}`); named = true; }
        for (const note of ctx.decisionDrops(r)) { const x = `its entry names ${n}; ${note}`; if (!tried.includes(x)) tried.push(x); }
        for (const a of ctx.reach.ofReference(r.id).areas) { areas.add(a, WEIGHT.decision, `its entry names ${n}, which is placed on ${shortName(store, a)}`); named = true; }
      } else if (r || store.threads.has(id)) {
        const at = ctx.placesOf(id);
        for (const p of at.plans) { plans.add(p, WEIGHT.record / at.plans.length, `its entry names ${n}, which serves ${shortName(store, p)}`); named = true; }
        for (const a of at.areas) { areas.add(a, WEIGHT.record / at.areas.length, `its entry names ${n}, which serves ${shortName(store, a)}`); named = true; }
      }
    }
  }
  if (!named) tried.push(names.length ? `its entry names ${listOf(names, 6)}, none placed` : 'its entry names no plan, module, number or section');

  // 2 · the batch or row of an arrangement its entry names (`B2 合入`, `批次 A`).
  if (!followRows(ctx, entry, 'its entry names', plans, citing, tried)) tried.push('its entry names no batch or row of an arrangement');

  // 3 · a link or path in its entry to an arrangement or a plan document.
  if (!followPaths(ctx, entry, 'its entry links', plans)) tried.push('its entry links no arrangement or plan document');

  // 4 · the log's own plan: the entry stands in an arrangement document.
  const logPaths = [...new Set(d.sourceIds.flatMap((sid) => { const a = store.sources.get(sid)?.anchor; return a?.kind === 'file' ? [slash(a.path)] : []; }))];
  let ownPlan = false;
  for (const abs of logPaths) {
    const file = ctx.files.find((f) => abs.toLowerCase().endsWith(`/${f.path.toLowerCase()}`));
    if (file && file.kind !== 'prompt' && file.kind !== 'receipt') {
      for (const lead of ctx.planOf(file).slice(0, 1)) { plans.add(lead.id, WEIGHT.decision, `its log ${file.path} is the arrangement of ${lead.name}`); ownPlan = true; }
    }
  }
  if (!ownPlan && logPaths.length) tried.push(`its log (${logPaths.map((p) => p.split('/').slice(-2).join('/')).join(', ')}) is no plan's own arrangement`);

  // 5 · the current documents that cite it, each standing in a placed item (placing.ts `tracePlacement`).
  // The names its entry writes were checked above; of the trace's drops only the citing lines are new.
  const traceDrops: string[] = [];
  const trace = tracePlacement(store, ctx.ledger, d, { reach: ctx.reach, index: ctx.index, lines: ctx.lines, time: ctx.time, dropped: traceDrops });
  for (const note of traceDrops) if (!note.includes("'s entry names ") && !tried.includes(note)) tried.push(note);
  for (const lead of trace.leads) {
    const r = store.reference.get(lead.id);
    if (!r) continue;
    (r.category === 'Plan' ? plans : areas).add(lead.id, WEIGHT.faint * Math.min(lead.count, 3), trace.citations ? `the documents citing it lead to ${shortName(store, lead.id)} (${trace.cited[0] ?? `${trace.citations} citations`})` : `its entry leads to ${shortName(store, lead.id)}`);
  }
  if (!trace.citations) tried.push('no current document cites it from a placed item');
  // An execution decision executed a plan that existed at its date; a product decision may shape a later plan.
  return { plans: ctx.time.executionEntry(d) ? inTimeOf(ctx, ownDay, 'this entry', plans.leads(), tried) : plans.leads(), areas: areas.leads(), tried };
}

// ───────────────────────── the defined zeros ─────────────────────────

/** Whether the project has a plan layer at all: Plan items, or a Plan or Execution arrangement layer in the layer map (current or not). */
export function planLayerPresent(store: ProjectStore): boolean {
  return store.reference.find((r) => r.category === 'Plan' && !GONE.has(r.validity)) !== undefined || store.layers.find((l) => l.layer === 'Plan' || l.layer === 'Execution arrangement') !== undefined;
}
/** Whether the project has Areas (modules) yet. */
export function areasPresent(store: ProjectStore): boolean {
  return store.reference.find((r) => r.category === 'Area' && !GONE.has(r.validity) && r.validity !== 'Abandoned') !== undefined;
}
/** Whether the project has a contract layer: a Task contract layer in the layer map, or work that records what it implements. */
export function contractLayerPresent(store: ProjectStore): boolean {
  return store.layers.find((l) => l.layer === 'Task contract') !== undefined || store.relations.find((r) => r.type === 'implements') !== undefined;
}

export const NO_PLAN_LAYER = 'not applicable: this project has no plan layer (no Plan items, no Plan or Execution arrangement layer), so no work item is in no plan and no noPlanWhy is needed';
export const NO_AREAS = 'not applicable: this project has no Areas yet, so no work item is in no module';
export const NO_CONTRACT_LAYER = 'not applicable: this project has no contract layer (no Task contract layer, and no work item implements a contract), so no ticket is missing its contract';

// ───────────────────────── the reasons the program can refuse ─────────────────────────

const chainOf = (lead: Lead): string => lead.through.join('; ');

/**
 * Why `noPlanWhy` is refused for this work item, or null when the reason stands (the records lead nowhere, or the project
 * has no plan layer). DB: `drawn` are the plans the workbench draws a band for (workbench-placement.ts); a lead to a plan
 * with no band — not current, or an earlier generation's — places nothing, so the reason stands against it.
 */
export function noPlanWhyRefusal(ctx: InferenceContext, t: WorkThread, drawn: ReadonlySet<string> | null = null): string | null {
  if (!planLayerPresent(ctx.store)) return null;
  const leads = inferThread(ctx, t).plans.filter((l) => !drawn || drawn.has(l.id));
  const inf = { plans: leads };
  if (!inf.plans.length) return null;
  const top = pick(inf.plans) ?? inf.plans[0]!;
  const others = inf.plans.filter((l) => l !== top).slice(0, 2);
  return `noPlanWhy is refused: the records lead to ${top.name} — ${chainOf(top)}${others.length ? `; they also lead to ${others.map((l) => `${l.name} (${l.through[0]})`).join(' and ')}` : ''}. Place it there with the record (serves the Plan item), or move it with the record that says otherwise; a reason stands only where the records lead nowhere. Nothing was written.`;
}

/** Why `noAreaWhy` is refused for this work item, or null when the reason stands (no record names a module, or the project has no Areas). */
export function noAreaWhyRefusal(ctx: InferenceContext, t: WorkThread): string | null {
  if (!areasPresent(ctx.store)) return null;
  const inf = inferThread(ctx, t);
  if (!inf.areas.length) return null;
  const top = pick(inf.areas) ?? inf.areas[0]!;
  const others = inf.areas.filter((l) => l !== top).slice(0, 2);
  return `noAreaWhy is refused: the records name ${top.name} — ${chainOf(top)}${others.length ? `; they also name ${others.map((l) => `${l.name} (${l.through[0]})`).join(' and ')}` : ''}. Place it there with the record (serves the Area first), or move it with the record that says otherwise; a reason stands only where the records name no module. Nothing was written.`;
}

// ───────────────────────── the program places first ─────────────────────────

const PROGRAM_SUMMARY = 'Placed by the program (Inferred)';

/** Whether a trace summary is one of the program's own placements. */
export const isProgramPlacement = (summary: string): boolean => summary.startsWith(PROGRAM_SUMMARY);

export interface PlacedByProgram {
  readonly placed: readonly InferredPlacement[];
  /** Work items and decisions still unplaced after the pass — in no plan, in no module, or placed nowhere — each with the pointers tried. */
  readonly empty: readonly { readonly id: string; readonly name: string; readonly needs: readonly ('plan' | 'module' | 'placement')[]; readonly tried: readonly string[]; readonly leads: readonly Lead[] }[];
}

/** The live work items in no plan or no module, and the decisions and boundaries placed nowhere (or on the Product with no reason). */
function unplacedNow(store: ProjectStore, reach: Reach): { threads: WorkThread[]; decisions: ReferenceItem[] } {
  const inGeneration = earlierWork(store);   // CZ: carried-on items are current work
  const threads = store.threads.filter((t) => !GONE.has(t.validity)).filter((t) => {
    const inPlan = inGeneration.has(t.id) || plansOf(store, t).length > 0;
    const inArea = reach.ofThread(t).areas.length > 0 || Boolean(t.wholePlanWhy?.trim());
    return (!inPlan && !t.noPlanWhy?.trim()) || (!inArea && !t.noAreaWhy?.trim());
  });
  const decisions = store.reference.filter((r) => (r.category === 'Decision' || r.category === 'Boundary') && !GONE.has(r.validity)).filter((d) => {
    const at = reach.ofReference(d.id);
    if (at.areas.length || at.plans.length) return false;
    return !(at.product && d.wholeProductWhy?.trim());
  });
  return { threads, decisions };
}

/** The targets a decision's leads settle on: the heaviest, or a plan and an area tied; none on a tie within a kind. */
function decisionTargets(inf: Inference): Lead[] {
  const all = [...inf.plans, ...inf.areas].sort((a, b) => b.weight - a.weight);
  if (!all.length) return [];
  const tied = all.filter((l) => l.weight === all[0]!.weight);
  return tied.length === 1 || (tied.length === 2 && tied[0]!.category !== tied[1]!.category) ? tied : [];
}

/**
 * Place what the records lead to, basis Inferred, and record each on the round (CQ, D104). Run as the main agent enters
 * reconcile and the cross-check, and at its handover. Later passes pick up work items whose chain only closes once the
 * decisions are placed, and decisions whose chain closes once the tickets they name are. Nothing already placed is
 * touched; a work item with an accepted reason is left as written.
 */
export function placeByProgram(store: ProjectStore, ledger: Ledger | null, round: Pick<ClerkRound, 'id'>, jobId: string | null, stage: string): PlacedByProgram {
  const at = new Date().toISOString();
  const placed: InferredPlacement[] = [];
  const trace = (summary: string): TraceInfo => ({ jobId, basisSourceIds: [], summary });
  const empty = new Map<string, { id: string; name: string; needs: ('plan' | 'module' | 'placement')[]; tried: readonly string[]; leads: readonly Lead[] }>();
  // CS: a placement of any round that a write took off its item since has its result first, so it is not written again below.
  settleProgramPlacements(store, { jobId, roundId: round.id });
  // A placement a model moved away from is not written again: the model's word stands over the program's reading.
  const movedAway = new Set(store.clerkRounds.all().flatMap((r) => (r.inferredPlacements ?? []).filter((p) => p.result?.kind === 'moved').map((p) => `${p.kind}:${p.id}:${p.targetId}`)));
  const stands = (kind: InferredPlacement['kind'], id: string, lead: Lead | null): Lead | null => (lead && !movedAway.has(`${kind}:${id}:${lead.id}`) ? lead : null);

  const pass = (ctx: InferenceContext, what: 'threads' | 'decisions'): number => {
    let n = 0;
    const now = unplacedNow(store, ctx.reach);
    if (what === 'threads') {
      for (const t of now.threads) {
        const inPlan = earlierWork(store).has(t.id) || plansOf(store, t).length > 0;
        const inArea = ctx.reach.ofThread(t).areas.length > 0 || Boolean(t.wholePlanWhy?.trim());
        const needPlan = !inPlan && !t.noPlanWhy?.trim();
        const needArea = !inArea && !t.noAreaWhy?.trim();
        const inf = inferThread(ctx, t);
        const plan = needPlan ? stands('thread', t.id, pick(inf.plans)) : null;
        const area = needArea ? stands('thread', t.id, pick(inf.areas)) : null;
        const stillPlan = needPlan && !plan;
        const stillArea = needArea && !area;
        if (stillPlan || stillArea) empty.set(t.id, { id: t.id, name: threadName(t), needs: [...(stillPlan ? ['plan' as const] : []), ...(stillArea ? ['module' as const] : [])], tried: inf.tried, leads: [...(stillPlan ? inf.plans : []), ...(stillArea ? inf.areas : [])] });
        else empty.delete(t.id);
        if (!plan && !area) continue;
        const serves = [...t.serves];
        if (area) serves.unshift({ referenceId: area.id, claim: chainOf(area), basis: 'Inferred' });
        if (plan) serves.push({ referenceId: plan.id, claim: chainOf(plan), basis: 'Inferred' });
        store.threads.put({ ...t, serves, updatedAt: at }, trace(`${PROGRAM_SUMMARY}: ${threadName(t)} → ${[area?.name, plan?.name].filter(Boolean).join(', ')}: ${[area, plan].filter((l): l is Lead => l !== null).map(chainOf).join(' | ')}`));
        for (const lead of [area, plan]) if (lead) { placed.push({ kind: 'thread', id: t.id, name: threadName(t), targetId: lead.id, target: lead.name, targetCategory: lead.category, chain: chainOf(lead), at, stage, jobId }); n += 1; }
      }
    } else {
      for (const d of now.decisions) {
        const inf = inferDecision(ctx, d);
        const targets = decisionTargets(inf).filter((l) => stands('reference', d.id, l) !== null);
        if (!targets.length) { empty.set(d.id, { id: d.id, name: refName(d), needs: ['placement'], tried: inf.tried, leads: [...inf.plans, ...inf.areas].sort((a, b) => b.weight - a.weight) }); continue; }
        empty.delete(d.id);
        store.reference.put({ ...d, refines: [...d.refines, ...targets.map((l) => l.id).filter((id) => !d.refines.includes(id))], updatedAt: at }, trace(`${PROGRAM_SUMMARY}: ${refName(d)} → ${targets.map((l) => l.name).join(', ')}: ${targets.map(chainOf).join(' | ')}`));
        for (const lead of targets) { placed.push({ kind: 'reference', id: d.id, name: refName(d), targetId: lead.id, target: lead.name, targetCategory: lead.category, chain: chainOf(lead), at, stage, jobId }); n += 1; }
      }
    }
    return n;
  };

  // Each pass reads the store as it stands, so the next sees the last one's placements. It stops once a pass places nothing.
  const time = chronology(store, ledger);
  for (let i = 0; i < 3; i++) {
    const ctx = inferenceContext(store, ledger, { time });
    const a = pass(ctx, 'threads');
    const b = pass(inferenceContext(store, ledger, { index: ctx.index, lines: ctx.lines, time }), 'decisions');
    if (a + b === 0) break;
  }
  if (placed.length) {
    const current = store.clerkRounds.get(round.id);
    if (current) {
      const kept = (current.inferredPlacements ?? []).filter((p) => !placed.some((x) => x.kind === p.kind && x.id === p.id && x.targetId === p.targetId));
      store.clerkRounds.put({ ...current, inferredPlacements: [...kept, ...placed], updatedAt: at }, trace(`Round: the program placed ${placed.length} item${placed.length === 1 ? '' : 's'} from the records (Inferred) as the main agent entered ${stage}`));
    }
  }
  return { placed, empty: [...empty.values()] };
}

/** The note `pk_stage` gives the main agent after the program placed: how many, where, and how to check them. */
export function placedNote(result: PlacedByProgram, stage: string): string | null {
  if (!result.placed.length) return null;
  const byTarget = new Map<string, number>();
  for (const p of result.placed) byTarget.set(p.target, (byTarget.get(p.target) ?? 0) + 1);
  const shown = result.placed.slice(0, 8).map((p) => `${p.name.slice(0, 50)} → ${p.target}`).join('; ');
  return `=== Placed by the program (Inferred), entering ${stage}\n${result.placed.length} placement${result.placed.length === 1 ? '' : 's'} from the records, basis Inferred, the chain in each claim: ${[...byTarget].map(([t, n]) => `${n} → ${t}`).join(', ')}. ${shown}${result.placed.length > 8 ? `; and ${result.placed.length - 8} more` : ''}. pk_round_state({ list: "inferredPlacements" }) lists each with its chain: check it against the record, keep it, or move it with replaceServes / refines and the record that says otherwise.`;
}

// ───────────────────────── what became of each program placement ─────────────────────────

export interface InferredPlacementRow {
  readonly id: string;
  readonly kind: InferredPlacement['kind'];
  readonly name: string;
  readonly placedOn: string;
  readonly chain: string;
  /** The round that placed it, in words (`First usable round 1`), and the stage the program placed it in. */
  readonly round: string;
  readonly roundId: string;
  readonly stage: string;
  readonly at: string;
  /** `left`: nobody confirmed or moved it yet; it stands as placed. Only these are listed. */
  readonly result: 'left';
  /** The Area or Plan it was placed on, by id. */
  readonly targetId: string;
}

/** Who gives a program placement its result: the job writing (its round's trace shows the result) and that round. */
export interface ResultBy { readonly jobId: string | null; readonly roundId?: string | null }

/** How many placements the program wrote in every round of the project, and what became of them. */
export interface ProgramPlacementCounts { readonly placed: number; readonly confirmed: number; readonly moved: number; readonly unreviewed: number }

/**
 * Whether a program placement is still on its item as the program wrote it: `stands` (the item still carries the target,
 * basis Inferred), `kept` (it carries the target, written since as a model's own), or `gone` (a later write replaced or
 * removed it, or the item is no longer there).
 */
function standingOf(store: ProjectStore, p: InferredPlacement): 'stands' | 'kept' | 'gone' {
  if (p.kind === 'thread') {
    const s = store.threads.get(p.id)?.serves.find((x) => x.referenceId === p.targetId);
    return !s ? 'gone' : s.basis === 'Inferred' ? 'stands' : 'kept';
  }
  return store.reference.get(p.id)?.refines.includes(p.targetId) ? 'stands' : 'gone';
}

const roundLabel = (r: Pick<ClerkRound, 'kind' | 'number'>): string => `${r.kind} round ${r.number}`;

/** Every placement the program wrote, in every round of the project, oldest first, each with what became of it. */
function programPlacements(store: ProjectStore): { readonly round: ClerkRound; readonly p: InferredPlacement; readonly state: 'left' | 'confirmed' | 'moved' }[] {
  return store.clerkRounds.all().sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.number - b.number).flatMap((round) => (round.inferredPlacements ?? []).map((p) => {
    if (p.result) return { round, p, state: p.result.kind };
    const now = standingOf(store, p);
    return { round, p, state: now === 'stands' ? 'left' as const : now === 'kept' ? 'confirmed' as const : 'moved' as const };
  }));
}

/**
 * The program's placements that still stand and have no result yet, whichever round placed them (CS; the owner's U86:
 * 「U86按照落位就算，主agent可以核查，暂时不用改成逐条确认」): they stand as placed, and stay listed — for the main agent to check and
 * for the spot-check to sample — until a write confirms or moves them. On the CQ run 11 of the 18 placements of the first
 * usable round were never reviewed, and the deepening's list read 0 because it was kept per round.
 */
export function inferredPlacementRows(store: ProjectStore): InferredPlacementRow[] {
  return programPlacements(store).filter((x) => x.state === 'left').map(({ round, p }) => ({
    id: p.id, kind: p.kind, name: p.name, placedOn: p.target, chain: p.chain, round: roundLabel(round), roundId: round.id, stage: p.stage, at: p.at, result: 'left' as const, targetId: p.targetId,
  }));
}

/** The counts the handover note and the round's Result give: placed in all, confirmed, moved, still unreviewed. */
export function programPlacementCounts(store: ProjectStore): ProgramPlacementCounts {
  const all = programPlacements(store);
  const n = (state: string) => all.filter((x) => x.state === state).length;
  return { placed: all.length, confirmed: n('confirmed'), moved: n('moved'), unreviewed: n('left') };
}

/** Where an item sits now, in short names, for a `moved` result. */
function sitsNow(store: ProjectStore, p: InferredPlacement): string {
  const targets = p.kind === 'thread' ? store.threads.get(p.id)?.serves.map((s) => s.referenceId) ?? [] : store.reference.get(p.id)?.refines ?? [];
  return targets.filter((x) => x !== p.targetId).map((x) => shortName(store, x)).join(', ');
}

/** Write results onto the records of the rounds that placed them, each round's change traced under the job that gave it. */
function writeResults(store: ProjectStore, by: ResultBy, how: 'write' | 'spot-check' | 'program', resultOf: (p: InferredPlacement) => { readonly kind: 'confirmed' | 'moved'; readonly to?: string } | null): number {
  const at = new Date().toISOString();
  let given = 0;
  for (const round of store.clerkRounds.all()) {
    const said: string[] = [];
    const next = (round.inferredPlacements ?? []).map((p) => {
      if (p.result) return p;
      const r = resultOf(p);
      if (!r) return p;
      said.push(`${clip(p.name, 40)} on ${p.target}: ${r.kind}${r.to ? ` to ${r.to}` : ''}`);
      return { ...p, result: { kind: r.kind, at, ...(r.to ? { to: r.to } : {}), ...(by.roundId ? { roundId: by.roundId } : {}), by: how } };
    });
    if (!said.length) continue;
    given += said.length;
    const who = how === 'spot-check' ? 'checked by the spot-check' : how === 'program' ? 'as the program finds them on the items now' : 'by a write';
    store.clerkRounds.put({ ...round, inferredPlacements: next, updatedAt: at }, { jobId: by.jobId, basisSourceIds: [], summary: `Program placements of ${roundLabel(round)}, ${who}: ${said.slice(0, 6).join('; ')}${said.length > 6 ? `; and ${said.length - 6} more` : ''}` });
  }
  return given;
}

/**
 * A model's write touched an item the program placed (CQ): record what became of each program placement — kept as the
 * model's own (`confirmed`: its basis or claim rewritten), or replaced (`moved`, with where the item sits now). CS: the
 * result lands on the record of the round that placed it, whichever round the write is in, and is traced under the
 * writing job, so it shows in that round's trace. Returns the placements moved, for the writer's result and trace.
 */
export function noteOverride(store: ProjectStore, kind: InferredPlacement['kind'], id: string, after: { readonly targets: readonly string[]; readonly kept: (targetId: string) => 'as written' | 'rewritten' | 'gone' }, by: ResultBy = { jobId: null }): string[] {
  const moved: string[] = [];
  writeResults(store, by, 'write', (p) => {
    if (p.kind !== kind || p.id !== id) return null;
    const state = after.kept(p.targetId);
    if (state === 'as written') return null;
    if (state === 'rewritten') return { kind: 'confirmed' };
    const to = after.targets.filter((x) => x !== p.targetId).map((x) => shortName(store, x)).join(', ');
    moved.push(`${p.target} (${clip(p.chain, 80)})`);
    return { kind: 'moved', ...(to ? { to } : {}) };
  });
  return moved;
}

/**
 * CS: a placement with no result that is no longer on its item as the program wrote it has its result — a writer that
 * does not report to `noteOverride` (a range placed again, a merge) replaced or removed it, or wrote it as its own. The
 * program records that on the round that placed it: `moved` with where the item sits now, or `confirmed`. Run with the
 * program's own upkeep (placing as a stage is entered, counting the round for the main agent, starting the spot-check);
 * a second run finds nothing.
 */
export function settleProgramPlacements(store: ProjectStore, by: ResultBy): number {
  return writeResults(store, by, 'program', (p) => {
    const now = standingOf(store, p);
    if (now === 'stands') return null;
    if (now === 'kept') return { kind: 'confirmed' };
    const to = sitsNow(store, p);
    return { kind: 'moved', ...(to ? { to } : {}) };
  });
}

/**
 * CS: the spot-check checked a program placement against the records and found it right: that is its result
 * (`confirmed`, by the spot-check, in the spot-check's round), so it leaves the list and is not sampled again. One it found
 * wrong and corrected was moved by the correcting write; one found wrong and left stays with no result, and stays listed.
 */
export function confirmBySpotCheck(store: ProjectStore, checked: readonly { readonly kind: InferredPlacement['kind']; readonly id: string; readonly targetId: string }[], by: ResultBy): number {
  if (!checked.length) return 0;
  const keys = new Set(checked.map((c) => `${c.kind}:${c.id}:${c.targetId}`));
  return writeResults(store, by, 'spot-check', (p) => (keys.has(`${p.kind}:${p.id}:${p.targetId}`) && standingOf(store, p) === 'stands' ? { kind: 'confirmed' } : null));
}

/** The targets of the program's placements this item still carries. */
export function programTargetsOf(store: ProjectStore, kind: InferredPlacement['kind'], id: string): string[] {
  return [...new Set(store.clerkRounds.all().flatMap((r) => (r.inferredPlacements ?? []).filter((p) => p.kind === kind && p.id === id && !p.result).map((p) => p.targetId)))];
}

/** The pointers tried for an item still unplaced, in one line for the spot-check and the unplaced list. */
export function triedLine(ctx: InferenceContext, item: WorkThread | ReferenceItem): string {
  const inf = 'serves' in item ? inferThread(ctx, item) : inferDecision(ctx, item);
  const leads = [...inf.plans, ...inf.areas];
  return [...(leads.length ? [`the records lead to ${leads.slice(0, 3).map((l) => `${l.name} (${l.through[0]})`).join('; ')}`] : []), ...inf.tried].join('; ');
}

// ───────────────────────── an archived arrangement, as a generation candidate ─────────────────────────

/**
 * What an execution arrangement kept under a root (an archive directory, a not-current plan document) executes, as the
 * program reads its rows (CQ, D104): "its rows name work of plan(s) P1 (23 tickets, 69 log entries)". Orientation accepts
 * or rejects the candidate generation with that in hand; the rows place the work they list whatever the verdict. Null when
 * no arrangement under the root leads to a plan.
 */
export function arrangementEvidence(ctx: InferenceContext, root: string): string | null {
  const rel = slash(root).replace(/\/+$/, '').toLowerCase();
  const files = ctx.files.filter((f) => (f.kind === 'plan' || f.kind === 'index') && (f.path.toLowerCase() === rel || f.path.toLowerCase().startsWith(`${rel}/`)));
  if (!files.length) return null;
  const plans = new Map<string, string>();
  const tickets = new Set<string>();
  for (const f of files) {
    const lead = ctx.planOf(f)[0];
    if (!lead) continue;
    plans.set(lead.id, lead.name);
    for (const row of f.rows) {
      for (const n of [rowToken(row.id), ...Object.values(row.cells).flatMap((c) => ctx.index.numbers(c))]) for (const id of ctx.resolve(n)) if (ctx.store.threads.has(id)) tickets.add(id);
    }
  }
  if (!plans.size) return null;
  let entries = 0;
  const paths = new Set(files.map((f) => f.path.toLowerCase()));
  for (const d of ctx.store.reference.filter((r) => (r.category === 'Decision' || r.category === 'Boundary') && !GONE.has(r.validity))) {
    const entry = entryTextOf(ctx.store, d);
    if (ctx.rowsNamedIn(entry).some((hit) => paths.has(hit.file.path.toLowerCase())) || pathsIn(entry).some((p) => { const f = ctx.fileByPath(p); return f !== null && paths.has(f.path.toLowerCase()); })) entries += 1;
  }
  return `its rows name work of plan(s) ${[...plans.values()].join(', ')} (${tickets.size} work item${tickets.size === 1 ? '' : 's'}, ${entries} log entr${entries === 1 ? 'y' : 'ies'})`;
}
