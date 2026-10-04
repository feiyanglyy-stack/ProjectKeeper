/**
 * The generation check (CM, E151; CK fixes 2–4; Spec §2.12, D100 「上几代写去向、不标废弃」; CKC-24 AC-18).
 *
 * **Destinations.** Every item of a recognised generation has a destination: it was replaced by something (`replacedBy`:
 * an id or the project's own number), a current item depends on it or carries it on, it moved into a current plan, it was
 * deferred, or it was abandoned. On the gated run the only check was "generations with no planned item" — it read 0, the
 * deepening wrote 「去向已记全」, and the 20 CKT items of the first generation had no destination at all.
 * `itemsWithoutDestination` lists them; `pk_round_state` shows them (`withoutDestination`), and a deepening enters its
 * synthesis only once each has one, or the main agent says why.
 *
 * **Candidates.** The program lists what looks like an earlier generation, for orientation to accept or reject
 * (`pk_generation_candidate`): the archived or superseded sets of plan, contract and module documents — a directory the
 * project keeps under an archive that holds such documents, a plan document the layer map marks not current — and the
 * owner's lines that name generations. Whether a candidate is a generation is orientation's judgement from the documents
 * (whether the current contracts' earlier versions count as one is not decided here); accepting writes the generation with
 * its plan documents, what ended it and its work items, in one call.
 *
 * **What a set's work is (CZ).** The block the main agent reads decides the reading: on the flash run it called the 60 rows
 * of an archived README's table of readings "the work items carrying U1, U2 …", and the main agent made them work items.
 * So a candidate says three things apart, each read off the ledger:
 * - `numbers` — the rows of its plan-like documents (a plan's tables, a task index, a contract set, an execution
 *   arrangement — `listsWork`) that no current document lists: its own work. A row stands at a heading or in the first
 *   cell of a table row. A document named by a number (a contract file) is that number's document: the number is the
 *   row, and the rows inside it are its points.
 * - `carriedOn` — the rows of those documents that a current document listing work has as rows too, or a current
 *   contract is named by: carried on under the same number. They are not dropped (the second generation of ContextKeeper
 *   is the 27 contracts that went on); the current items of those numbers are the generation's items, with that
 *   destination. A report that tabulates a number, or is named after it, does not carry it on.
 * - `alsoDefined` — the number families its other documents define (a README's table, a PRD's requirements), each with
 *   its document and whether a current document continues the family. They are not its work, and nobody is told to fill
 *   them as work.
 * Left out of all three: a number a decision record lists among its own entries (a reference to that decision wherever
 * it stands), and a point of numbered items (an acceptance criterion: no file is named by it, and the current documents
 * that list it are each named by another number).
 *
 * **Which items join (CZ).** A work item joins an accepted generation when it carries one of those rows' numbers and it was
 * written from a document of that set (`originOf`: the source its fill cited, its written status' source) — never by its
 * number alone: on the flash run U1–U16 stood in two generations because both archives define them. An item of a
 * carried-on number written from a current document joins too (that is what carried on means), unless another set's plan
 * documents list the number as well. An item that names no source joins none by itself; the accept reply lists it
 * (`notJoined`) for the main agent to add (`pk_write_generation`).
 *
 * A carried-on item is current work listed in an earlier generation: it stays live. Every reader of `Generation.workIds`
 * that means "earlier work" — the process engine, the unplaced counts, the code map, the views — asks carried-on.ts
 * (`earlierWork`), which leaves those items out by their state, whoever listed them.
 */
import { Ledger } from '../../ledger/index.ts';
import type { ClerkRound, Generation, GenerationVerdict, LayerKind } from '../../model/k-types.ts';
import type { WorkThread } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { familyOf } from '../../ledger/numbering.ts';
import { pathKey } from '../../util/paths.ts';
import { ROW_POSITIONS, archiveRootOf, carriedOnItems, currentEntries, currentRows, layerEntryOver, listsWork, nameSays, slash, type DefRow } from './carried-on.ts';
import { GENERATION_NAMED, generationExcerpts } from './owner-lines.ts';
import { arrangementEvidence, inferenceContext, type InferenceContext } from './placement-inference.ts';


// ───────────────────────── destinations ─────────────────────────

export interface GenerationItem {
  readonly id: string;
  /** The project's own number, when it has one. */
  readonly number: string;
  readonly name: string;
  readonly generationId: string;
  readonly generation: string;
  readonly validity: string;
}

export type Destination =
  | { readonly kind: 'replaced'; readonly by: string }
  | { readonly kind: 'carried'; readonly by: string; readonly how: string }
  | { readonly kind: 'moved'; readonly to: string }
  | { readonly kind: 'deferred' }
  | { readonly kind: 'abandoned' };

/** The item a `replacedBy` names: an id of the assets, or the project's own number of a work item or a reference item. */
export function successorOf(store: ProjectStore, ref: string | null | undefined): { readonly id: string; readonly label: string } | null {
  const key = (ref ?? '').trim();
  if (!key) return null;
  const t = store.threads.get(key);
  if (t) return { id: t.id, label: t.ids[0] ?? t.title };
  const r = store.reference.get(key);
  if (r) return { id: r.id, label: r.ids[0] ?? r.name };
  const up = key.toUpperCase();
  const byNumber = store.threads.find((x) => x.validity !== 'Removed' && x.ids.some((i) => i.toUpperCase() === up));
  if (byNumber) return { id: byNumber.id, label: byNumber.ids[0] ?? byNumber.title };
  const refByNumber = store.reference.find((x) => x.validity !== 'Removed' && x.ids.some((i) => i.toUpperCase() === up));
  return refByNumber ? { id: refByNumber.id, label: refByNumber.ids[0] ?? refByNumber.name } : null;
}

const CARRY: ReadonlySet<string> = new Set(['replaces', 'depends on', 'carries out', 'refines', 'serves', 'implements']);

/**
 * Where an item of an earlier generation went, or null when nothing recorded says (see the module comment). `inGeneration`
 * are the ids every generation lists: an item of the same generation does not carry another on. `carried` (CZ) are the
 * items listed because current documents define their number too: each went on under its own number, and — being current
 * work — it can carry another item on.
 */
export function destinationOf(store: ProjectStore, t: WorkThread, inGeneration: ReadonlySet<string>, carried: ReadonlySet<string> = new Set()): Destination | null {
  if (t.validity === 'Abandoned') return { kind: 'abandoned' };
  // Current work the current plan lists under the same number (carried-on.ts) — a deferred contract among it.
  if (carried.has(t.id) && t.validity !== 'Replaced') return { kind: 'carried', by: t.ids[0] ?? t.title, how: 'carried on under the same number' };
  if (t.validity === 'Deferred') return { kind: 'deferred' };
  const successor = successorOf(store, t.replacedBy);
  if (successor && successor.id !== t.id) return { kind: 'replaced', by: successor.label };
  // A replacement the project writes by a number no item carries yet still says where it went.
  if (t.replacedBy?.trim() && !successor) return { kind: 'replaced', by: t.replacedBy.trim() };
  const current = (id: string): boolean => {
    if (inGeneration.has(id) && !carried.has(id)) return false;
    const v = store.threads.get(id)?.validity ?? store.reference.get(id)?.validity;
    return v === 'Current' || v === 'Proposed' || v === 'Deferred';
  };
  if (t.validity !== 'Replaced') {
    const plan = t.serves.map((s) => store.reference.get(s.referenceId)).find((r) => r?.category === 'Plan' && r.validity === 'Current');
    if (plan) return { kind: 'moved', to: plan.ids[0] ?? plan.name };
  }
  const dependent = store.threads.find((x) => x.id !== t.id && current(x.id) && x.dependsOn.some((d) => d.threadId === t.id));
  if (dependent) return { kind: 'carried', by: dependent.ids[0] ?? dependent.title, how: 'depends on' };
  const carrier = store.relations.find((r) => r.to === t.id && CARRY.has(r.type) && current(r.from));
  if (carrier) return { kind: 'carried', by: store.threads.get(carrier.from)?.ids[0] ?? store.reference.get(carrier.from)?.ids[0] ?? store.threads.get(carrier.from)?.title ?? store.reference.get(carrier.from)?.name ?? carrier.from, how: carrier.type };
  return null;
}

/** The items of every recorded generation that have no destination yet. The ledger, when not given, is opened here. */
export function itemsWithoutDestination(store: ProjectStore, ledger?: Ledger | null): GenerationItem[] {
  const gens = store.generations.all();
  if (!gens.some((g) => g.workIds.length)) return [];
  const inGeneration = new Set(gens.flatMap((g) => g.workIds));
  let own: Ledger | null = null;
  if (ledger === undefined) { try { own = Ledger.openDir(store.dir); } catch { own = null; } }
  let carried = new Set<string>();
  try { carried = carriedOnItems(store, ledger ?? own); } catch { carried = new Set(); } finally { own?.close(); }
  const out: GenerationItem[] = [];
  for (const g of gens) {
    for (const id of g.workIds) {
      const t = store.threads.get(id);
      if (!t || t.validity === 'Removed') continue;
      if (destinationOf(store, t, inGeneration, carried)) continue;
      out.push({ id: t.id, number: t.ids[0] ?? '', name: t.title, generationId: g.id, generation: g.name, validity: t.validity });
    }
  }
  return out;
}

// ───────────────────────── candidates ─────────────────────────

export interface GenerationCandidate {
  /** What names it: the set's directory or document (`set:<path>`), or the owner's line (`line:<draft>:<ref>`). */
  readonly key: string;
  readonly kind: 'set' | 'owner-line';
  readonly name: string;
  /** Why the program lists it, in one sentence. */
  readonly why: string;
  /** A set: its plan, contract and module documents (repository-relative), at most `CANDIDATE_DOCS`. */
  readonly planRefs: readonly string[];
  /** A set: the rows of its plan-like documents that no current document defines — the generation's own work. */
  readonly numbers: readonly string[];
  /** CZ, a set: the rows of its plan-like documents that current documents define too — carried on under the same number. */
  readonly carriedOn: readonly string[];
  /** CZ, a set: the number families its other documents define (not work of the generation), largest first. */
  readonly alsoDefined: readonly AlsoDefined[];
  /** A set: the commit that put it there — what ended it, as far as the program can tell. */
  readonly endedCommit: string | null;
  /** The generation that already holds its documents, when one does. */
  readonly recordedAs: string | null;
  /**
   * CQ (D104): for a not-current execution arrangement, the program's own evidence of what its rows execute — "its rows name
   * work of plan(s) P1 (23 tickets, 69 log entries)" — so orientation accepts or rejects it as a generation with that in
   * hand. Its rows place the work they list whatever the verdict (placement-inference.ts).
   */
  readonly executes?: string | null;
}

/** A number family a set's other documents define: how many numbers, in which document, and the current document that goes on with it. */
export interface AlsoDefined {
  readonly family: string;
  readonly count: number;
  /** The documents of the set that define it (repository-relative), the one with the most numbers first. */
  readonly documents: readonly string[];
  /** The current document that defines numbers of the family, or null when none does. */
  readonly continuedIn: string | null;
}

export const CANDIDATE_DOCS = 12;
/** How many families of a set's other documents a candidate lists. */
export const ALSO_DEFINED = 6;
/** How many of the owner's lines that name generations are listed as candidates (newest first). */
export const OWNER_LINE_CANDIDATES = 12;
const CANDIDATE_NUMBERS = 80;

/** The layers a generation's plan documents are of. */
const PLAN_LAYERS: ReadonlySet<LayerKind> = new Set<LayerKind>(['Product', 'PRD', 'Spec', 'Plan', 'Task index', 'Task contract', 'Execution arrangement']);
const DECISION_NAME = nameSays('decisions?|adrs?', '决定|决策');

/** Whether a document is a decision record: mapped so, or named so. */
function isDecisionRecord(store: ProjectStore, path: string): boolean {
  const over = layerEntryOver(store, path);
  return over?.layer === 'Decision record' || DECISION_NAME.test(path.split('/').pop() ?? '');
}

interface SetNumbers { readonly numbers: string[]; readonly carriedOn: string[]; readonly alsoDefined: AlsoDefined[] }
const byNumber = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/** CZ: what a set's documents define, read off the ledger (see the module comment). `roots` are every candidate's root. */
function setNumbers(store: ProjectStore, ledger: Ledger, root: string, roots: readonly string[]): SetNumbers {
  const { defs, setAside, numberNamed, namedByOwnNumber, isCurrent } = currentRows(store, ledger, roots);
  const rows = defs.rows.filter((r) => r.path === root || r.path.startsWith(`${root}/`));
  if (!rows.length) return { numbers: [], carriedOn: [], alsoDefined: [] };
  const byDoc = new Map<string, DefRow[]>();
  for (const r of rows) byDoc.set(r.path, [...(byDoc.get(r.path) ?? []), r]);
  /** A document's rows: its own entries at row positions; one no longer in the checkout, as the ledger first read it. */
  const rowsIn = (path: string, docRows: readonly DefRow[]): { num: string; rule: string }[] => {
    const now = currentEntries(ledger, defs, docRows.find((r) => r.repo)?.repo ?? null, path);
    return (now ?? docRows.filter((r) => r.kind === 'doc').map((r) => ({ num: r.num, rule: r.rule, position: r.position ?? '' }))).filter((e) => ROW_POSITIONS.has(e.position));
  };
  const rowsOf = new Map<string, string>();        // number → the plan-like document that lists it
  const others = new Map<string, Map<string, Set<string>>>();   // family → document → its numbers
  for (const [path, docRows] of byDoc) {
    const named = docRows.filter(namedByOwnNumber);
    if (listsWork(store, root, path)) {
      // A document named by a number is that number's own document; otherwise its entries are the rows.
      for (const e of named.length ? named : rowsIn(path, docRows)) if (!rowsOf.has(e.num)) rowsOf.set(e.num, path);
    } else if (!named.length) {
      for (const e of rowsIn(path, docRows)) {
        const docs = others.get(e.rule) ?? new Map<string, Set<string>>();
        docs.set(path, (docs.get(path) ?? new Set<string>()).add(e.num));
        others.set(e.rule, docs);
      }
    }
  }
  /** A decision's number: a decision record lists it among its own entries — a reference to that decision wherever else it stands. */
  const isDecision = (n: string): boolean => (defs.byNum.get(n) ?? []).some((d) => {
    if (d.kind !== 'doc' || !isDecisionRecord(store, d.path)) return false;
    const own = currentEntries(ledger, defs, d.repo, d.path);
    return own === null ? true : own.some((e) => e.num === n);
  });
  /**
   * A point of numbered items, not a row of a plan: no file was ever named by it, and the current documents that list it
   * are each named by another number (an acceptance criterion every contract has its own of).
   */
  const isPoint = (n: string): boolean => {
    if ((defs.byNum.get(n) ?? []).some((r) => r.kind === 'file-name')) return false;
    const now = (defs.byNum.get(n) ?? []).filter((d) => d.kind === 'doc' && d.current === 1 && !setAside(d.path) && ROW_POSITIONS.has(d.position ?? ''));
    return now.length > 0 && now.every((d) => numberNamed(d.path));
  };
  const plan = [...rowsOf.keys()].filter((n) => !isDecision(n) && !isPoint(n)).sort(byNumber);
  const alsoDefined: AlsoDefined[] = [];
  for (const [family, docs] of others) {
    const nums = new Set([...docs.values()].flatMap((x) => [...x]).filter((n) => !rowsOf.has(n) && !isDecision(n)));
    if (nums.size < 2) continue;
    const documents = [...docs].map(([path, x]) => ({ path, n: [...x].filter((y) => nums.has(y)).length })).filter((d) => d.n > 0).sort((x, y) => y.n - x.n || x.path.localeCompare(y.path)).map((d) => d.path);
    // The current document that goes on with the family: the one listing the most numbers of it as rows.
    const counts = new Map<string, Set<string>>();
    for (const d of defs.rows) if (d.rule === family && d.kind === 'doc' && d.current === 1 && ROW_POSITIONS.has(d.position ?? '') && !setAside(d.path)) counts.set(d.path, (counts.get(d.path) ?? new Set<string>()).add(d.num));
    const continuedIn = [...counts].sort((x, y) => y[1].size - x[1].size || x[0].localeCompare(y[0]))[0]?.[0] ?? null;
    alsoDefined.push({ family, count: nums.size, documents, continuedIn });
  }
  const own = plan.filter((n) => !isCurrent(n));
  return {
    numbers: own.slice(0, CANDIDATE_NUMBERS),
    carriedOn: plan.filter((n) => !own.includes(n)).slice(0, CANDIDATE_NUMBERS),
    alsoDefined: alsoDefined.sort((x, y) => y.count - x.count || x.family.localeCompare(y.family)).slice(0, ALSO_DEFINED),
  };
}

/** A document named like a plan, a contract or a module set. */
const PLAN_NAME = /(?:^|[\/_.-])(?:plan|plans|prd|spec|roadmap|backlog|milestones?|contracts?|modules?|product|requirements?|计划|合同|模块|需求|路线)(?:[\/_.-]|$)/i;

/** The verdicts the main agent gave on candidates, in every round (a rejected one is not listed again). */
export function generationVerdicts(store: ProjectStore): Map<string, GenerationVerdict> {
  const out = new Map<string, GenerationVerdict>();
  for (const r of store.clerkRounds.all().sort((a, b) => a.startedAt.localeCompare(b.startedAt))) for (const v of r.generationVerdicts ?? []) out.set(v.key, v);
  return out;
}

/**
 * What looks like an earlier generation (see the module comment), every candidate with whether a generation already holds
 * it. Candidates the main agent gave a verdict on are left out unless `all`.
 */
export function generationCandidates(store: ProjectStore, ledger: Ledger | null, opts: { readonly all?: boolean } = {}): GenerationCandidate[] {
  const sets = new Map<string, { docs: Set<string>; notes: string[] }>();
  const add = (root: string, doc: string | null, note: string | null) => {
    const s = sets.get(root) ?? { docs: new Set<string>(), notes: [] };
    if (doc) s.docs.add(doc);
    if (note && !s.notes.includes(note)) s.notes.push(note);
    sets.set(root, s);
  };
  // 1 · the layer map: a plan-like document or directory the orientation marked not current.
  const layerRoots: string[] = [];
  for (const l of store.layers.all()) {
    if (l.current) continue;
    const path = slash(l.path);
    const isFile = /\.[A-Za-z0-9]{1,6}$/.test(path);
    const root = archiveRootOf(path, !isFile) ?? path;
    if (!isFile && !layerRoots.includes(path)) layerRoots.push(path);
    if (PLAN_LAYERS.has(l.layer)) add(root, isFile ? path : null, `${l.layer}, not current${l.note ? `: ${l.note}` : ''}`);
    else if (archiveRootOf(path, !isFile)) add(root, null, l.note ?? null);
  }
  // 2 · the ledger: documents named like plans, contracts or modules kept under an archive.
  if (ledger) {
    let paths: { path: string }[] = [];
    try { paths = ledger.db.prepare('SELECT DISTINCT path FROM docs').all() as { path: string }[]; } catch { paths = []; }
    for (const { path } of paths) {
      // A directory the layer map set aside whole is one set, whatever it holds below.
      const root = layerRoots.filter((r) => path.startsWith(`${r}/`)).sort((a, b) => a.length - b.length)[0] ?? archiveRootOf(path);
      if (!root) continue;
      const inside = path.slice(root.length + 1);
      if (PLAN_NAME.test(`/${inside}`) || sets.has(root)) add(root, PLAN_NAME.test(`/${inside}`) ? path : null, null);
    }
  }
  // A set with no plan-like document is an archive of something else (reports, history logs): not a generation's plans.
  // CQ (D104): what an archived execution arrangement's rows execute, read once when a candidate needs it.
  let ctx: InferenceContext | null = null;
  const evidence = (root: string): string | null => { try { ctx ??= inferenceContext(store, ledger); return arrangementEvidence(ctx, root); } catch { return null; } };
  const verdicts = generationVerdicts(store);
  const gens = store.generations.all();
  const recordedAs = (root: string, docs: readonly string[]): string | null => {
    const g = gens.find((x) => x.planRefs.some((p) => { const id = slash(p.id); return id === root || id.startsWith(`${root}/`) || docs.includes(id); }));
    return g ? g.name : null;
  };
  const roots = [...sets.keys()];
  const out: GenerationCandidate[] = [];
  for (const [root, s] of [...sets].sort((a, b) => a[0].localeCompare(b[0]))) {
    const docs = [...s.docs].sort();
    if (!docs.length && !s.notes.some((n) => /not current/.test(n))) continue;
    let defined: SetNumbers = { numbers: [], carriedOn: [], alsoDefined: [] };
    let endedCommit: string | null = null;
    if (ledger) {
      try {
        defined = setNumbers(store, ledger, root, roots);
        const first = ledger.db.prepare('SELECT c.hash FROM commit_files f JOIN commits c ON c.repo = f.repo AND c.hash = f.hash WHERE f.path = ? OR f.path LIKE ? ORDER BY c.author_ms ASC LIMIT 1').get(root, `${root}/%`) as { hash: string } | undefined;
        endedCommit = first?.hash ?? null;
      } catch { /* the ledger has no such table in this build: the candidate stands without numbers */ }
    }
    const key = `set:${root}`;
    // CQ (D104): a not-current execution arrangement is listed only with the program's own evidence of what its rows execute.
    const executes = s.notes.some((n) => n.startsWith('Execution arrangement')) ? evidence(root) : null;
    const { numbers, carriedOn, alsoDefined } = defined;
    const rowsSaid = [
      numbers.length ? `${numbers.length} row${numbers.length === 1 ? '' : 's'} no current document lists` : '',
      carriedOn.length ? `${carriedOn.length} carried on under the same number` : '',
    ].filter(Boolean).join(' and ');
    const c: GenerationCandidate = {
      key, kind: 'set', name: root.split('/').slice(-1)[0] ?? root,
      why: `${root} holds ${docs.length ? `${docs.length} plan, contract or module document${docs.length === 1 ? '' : 's'}` : 'documents'} set aside${s.notes.length ? ` (${s.notes.slice(0, 2).join('; ')})` : ''}${rowsSaid ? `; its plan documents list ${rowsSaid}` : ''}${executes ? `; ${executes}` : ''}`,
      planRefs: docs.slice(0, CANDIDATE_DOCS), numbers, carriedOn, alsoDefined, endedCommit, recordedAs: recordedAs(root, docs), ...(executes ? { executes } : {}),
    };
    if (!opts.all && verdicts.has(key)) continue;
    out.push(c);
  }
  // 3 · the owner's lines that name generations, whatever the session draft labelled them.
  const lines: (GenerationCandidate & { at: string })[] = [];
  for (const d of store.drafts.all()) {
    for (const l of d.ownerLines) {
      const m = GENERATION_NAMED.exec(l.text);
      if (!m) continue;
      const key = `line:${d.id}:${l.ref}`;
      if (!opts.all && verdicts.has(key)) continue;
      const flat = l.text.replace(/\s+/g, ' ');
      const at = flat.indexOf(m[0]);
      const excerpt = `${at > 60 ? '…' : ''}${flat.slice(Math.max(0, at - 60), at + m[0].length + 100)}${at + m[0].length + 100 < flat.length ? '…' : ''}`;
      lines.push({ key, kind: 'owner-line', name: `the owner, ${l.at.slice(0, 10)}`, why: `the owner's line names generations or versions: 「${excerpt}」`, planRefs: [], numbers: [], carriedOn: [], alsoDefined: [], endedCommit: null, recordedAs: null, at: l.at });
    }
  }
  // The newest lines first; a long history of sessions has many, and the newest say how the owner sees the generations now.
  for (const { at: _at, ...c } of lines.sort((a, b) => b.at.localeCompare(a.at)).slice(0, OWNER_LINE_CANDIDATES)) out.push(c);
  return out;
}

/** The document sets not yet judged and not yet held by a recorded generation: what orientation has to accept or reject. */
export function openCandidates(store: ProjectStore, ledger: Ledger | null): GenerationCandidate[] {
  return generationCandidates(store, ledger).filter((c) => c.kind === 'set' && !c.recordedAs);
}

/** The block orientation is given: the candidate generations to accept or reject, each with why and what accepting writes. */
export function generationCandidatesBlock(store: ProjectStore, ledger: Ledger | null): string {
  const head = '=== Candidate generations (the program’s list: archived or superseded plan, contract and module sets, and the owner’s lines that name generations — accept or reject each with pk_generation_candidate)';
  const all = generationCandidates(store, ledger);
  const open = all.filter((c) => !c.recordedAs);
  const recorded = all.filter((c) => c.recordedAs);
  if (!all.length) return `${head}\nNone: no plan, contract or module set is kept under an archive or marked not current, and no owner's line names a generation.`;
  const lines = [head];
  const sets = open.filter((c) => c.kind === 'set');
  for (const c of sets) {
    lines.push(`- ${c.key} · ${c.name}: ${c.why}`);
    if (c.executes) lines.push(`  the program's evidence: ${c.executes} — an execution arrangement of a current plan is the record of how that plan was carried out, not a generation; its rows place the work they list whatever your verdict`);
    lines.push(`  accepting records it with ${c.planRefs.length} plan document${c.planRefs.length === 1 ? '' : 's'}${c.endedCommit ? `, ended by commit ${c.endedCommit.slice(0, 7)} unless you give what ended it` : ''}`);
    lines.push(...candidateWorkLines(c).map((l) => `  ${l}`));
  }
  if (!sets.length) lines.push('No document set waits for a verdict.');
  if (recorded.length) lines.push(`Already recorded: ${recorded.map((c) => `${c.name} → ${c.recordedAs}`).join('; ')}.`);
  const said = open.filter((c) => c.kind === 'owner-line');
  if (said.length) {
    lines.push(`The owner's lines that name generations or versions (${said.length}, newest first; read them before you count the generations — they are not judged one by one):`);
    for (const c of said) lines.push(`- ${c.key.slice(5)} · ${c.name}: ${c.why.replace(/^the owner's line names generations or versions: /, '')}`);
  }
  lines.push('Whether each set is a generation is yours to judge from the documents (a version history moved to an archive is not a generation of plans; whether an earlier version of the current contracts counts as one is for you to read off the documents and the owner’s lines): reject with why, or accept — one call each.');
  return lines.join('\n');
}

/** Numbers said by family, the largest first: `CKC-01, CKC-02, CKC-03 … (27); AC-15, AC-30 (2)` — or plainly when they are one family. */
function byFamily(list: readonly string[], n = 4): string {
  const groups = new Map<string, string[]>();
  for (const x of list) { const f = familyOf(x)?.family ?? x.replace(/\d+$/, '<n>'); groups.set(f, [...(groups.get(f) ?? []), x]); }
  const said = [...groups.values()].sort((x, y) => y.length - x.length).map((g) => `${g.length > n + 1 ? `${g.slice(0, n).join(', ')} … ${g[g.length - 1]}` : g.join(', ')}${groups.size > 1 ? ` (${g.length})` : ''}`);
  return said.join('; ');
}

/**
 * CZ: what a candidate's documents define, in the words the main agent reads — its work (the rows of its plan documents),
 * what went on under the same number, and what its other documents define, each kept apart.
 */
export function candidateWorkLines(c: GenerationCandidate): string[] {
  const out: string[] = [];
  out.push(c.numbers.length
    ? `its work — the rows of its plan documents that no current document lists (${c.numbers.length}): ${byFamily(c.numbers)}`
    : `its plan documents list no row that only they define${c.carriedOn.length ? '' : ' (the program found no plan table, task index or contract set in it)'}`);
  if (c.carriedOn.length) out.push(`carried on under the same number (${c.carriedOn.length}): ${byFamily(c.carriedOn)} — current documents list these rows too; the current items of those numbers are its items, with that destination`);
  if (c.alsoDefined.length) {
    out.push(`also defined in this set, not in a plan document: ${c.alsoDefined.map((a) => `${a.family} (${a.count}) in ${a.documents[0]}${a.documents.length > 1 ? ` and ${a.documents.length - 1} more` : ''} — ${a.continuedIn ? `${a.continuedIn} continues the family` : 'no current document continues the family'}`).join('; ')}. These are not its work items: what they are is read from their document`);
  }
  return out;
}

/** A verdict recorded on the round, replacing an earlier one on the same candidate. */
export function withVerdict(round: ClerkRound, verdict: GenerationVerdict): ClerkRound {
  return { ...round, generationVerdicts: [...(round.generationVerdicts ?? []).filter((v) => v.key !== verdict.key), verdict], updatedAt: verdict.at };
}

/**
 * CZ: the repository-relative paths of the documents a work item was written from — the source its fill cited
 * (`inputs.sourceIds`) and the source of its written status. Empty when nothing recorded says (an item written by hand
 * before the fill recorded it).
 */
export function originOf(store: ProjectStore, ledger: Ledger | null, t: WorkThread): string[] {
  const ids = [...new Set([...(t.writtenStatus ? [t.writtenStatus.sourceId] : []), ...(t.inputs?.sourceIds ?? [])])];
  if (!ids.length) return [];
  const repos = (ledger?.repos() ?? []).map((r) => r.path.replace(/\\/g, '/').replace(/\/+$/, '')).sort((x, y) => y.length - x.length);
  const out: string[] = [];
  for (const id of ids) {
    const a = store.sources.get(id)?.anchor;
    if (!a) continue;
    if (a.kind === 'revision') { out.push(slash(a.path)); continue; }
    if (a.kind !== 'file') continue;
    const abs = a.path.replace(/\\/g, '/');
    const repo = repos.find((r) => pathKey(abs).startsWith(`${pathKey(r)}/`) || abs.toLowerCase().startsWith(`${r.toLowerCase()}/`));
    out.push(repo ? abs.slice(repo.length + 1) : abs);
  }
  return [...new Set(out)];
}

const under = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`) || path.endsWith(`/${root}`) || path.includes(`/${root}/`);

/**
 * CZ: the work items of a candidate generation (see the module comment, "Which items join"). `all` are every candidate
 * set, so a number two sets' plan documents define is never settled by the number.
 */
export function generationItems(store: ProjectStore, ledger: Ledger | null, c: GenerationCandidate, all: readonly GenerationCandidate[]): string[] {
  const own = new Set(c.numbers.map((n) => n.toUpperCase()));
  const carried = new Set(c.carriedOn.map((n) => n.toUpperCase()));
  if (!own.size && !carried.size) return [];
  const root = c.key.replace(/^set:/, '');
  const otherSets = all.filter((x) => x.kind === 'set' && x.key !== c.key);
  const elsewhere = new Set(otherSets.flatMap((x) => [...x.numbers, ...x.carriedOn]).map((n) => n.toUpperCase()));
  const otherRoots = otherSets.map((x) => x.key.replace(/^set:/, ''));
  const out: string[] = [];
  for (const t of store.threads.filter((x) => x.validity !== 'Removed')) {
    const n = t.ids.map((i) => i.toUpperCase()).find((i) => own.has(i) || carried.has(i));
    if (!n) continue;
    const from = originOf(store, ledger, t);
    if (from.some((p) => under(root, p))) { out.push(t.id); continue; }
    // Written from a current document that defines the number too: carried on — unless another set claims the number.
    if (carried.has(n) && from.length && !elsewhere.has(n) && !from.some((p) => otherRoots.some((r) => under(r, p)) || archiveRootOf(p) !== null)) out.push(t.id);
  }
  return out;
}

/**
 * The work items of an accepted candidate join its generation as they appear (CM): orientation accepts a set before the
 * skeleton's lanes have filled its items, and nobody should have to add them one by one afterwards. CZ: which items those
 * are is `generationItems` — by the document they were written from, never by the number alone. Returns how many were
 * added. Run where the round's state is read (`pk_round_state`, `pk_stage`).
 */
export function attachAcceptedItems(store: ProjectStore, ledger: Ledger | null, jobId: string | null = null): number {
  const accepted = [...generationVerdicts(store).values()].filter((v) => v.accepted && v.generationId);
  if (!accepted.length) return 0;
  const all = generationCandidates(store, ledger, { all: true });
  const byKey = new Map(all.map((c) => [c.key, c]));
  let added = 0;
  for (const v of accepted) {
    const g = store.generations.get(v.generationId!);
    const c = byKey.get(v.key);
    if (!g || !c || (!c.numbers.length && !c.carriedOn.length)) continue;
    const fresh = generationItems(store, ledger, c, all).filter((id) => !g.workIds.includes(id));
    if (!fresh.length) continue;
    store.generations.put({ ...g, workIds: [...g.workIds, ...fresh], updatedAt: new Date().toISOString() }, { jobId, basisSourceIds: [], summary: `Generation “${g.name}”: ${fresh.length} work item${fresh.length === 1 ? '' : 's'} written from its documents, or carried on under the same number, joined it` });
    added += fresh.length;
  }
  return added;
}

export { archiveRootOf, carriedOnItems, listsWork };
export type { Generation };
