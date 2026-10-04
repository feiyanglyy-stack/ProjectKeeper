/**
 * Carried on under the same number (CZ; Spec §2.12, D100 「上几代写去向、不标废弃」).
 *
 * An earlier generation lists the work it planned (`Generation.workIds`). Some of that work went on under its own number:
 * the current plan lists the same contract, and the workbench holds one item for it. That item is current work in its
 * current plan — the generation only shows it, with the destination "carried on". Everywhere else an item a generation
 * lists is earlier work (the process engine lights nothing on it, its steps are history, the code it built is an
 * earlier generation's), so every reader of `workIds` that means "earlier work" asks here: `earlierWork` leaves the
 * carried-on items out.
 *
 * The rule is the item's state, not who wrote the membership (on the CQ run the main agent listed the 27 current
 * contracts in the second generation by hand; from CZ the program lists them itself): the item is not Replaced,
 * Abandoned or Removed, and it carries a number that a current document listing work has as a row, or that a current
 * contract is named by. Which documents list work, and what a row is, are read here off the layer map, the documents'
 * names and the ledger's definitions; generation-check.ts reads a candidate set's numbers with the same rules.
 *
 * Without a ledger nothing is known to be carried on, and every listed item is earlier work, as before.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger } from '../../ledger/index.ts';
import { definitionsInPath, definitionsInText } from '../../ledger/numbering.ts';
import type { LayerKind } from '../../model/k-types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { entryDefinitions } from './entries.ts';

export const slash = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** A directory name under which projects keep what was superseded. */
const ARCHIVAL = /^(?:archives?|archived|superseded.*|deprecated|obsolete|legacy|old|attic|history|_?deleted?|归档|旧版?本?|废弃|历史)$/i;

/**
 * The archived set a path belongs to, or null: the archival directory and the dated or named set under it
 * (`design/archive/superseded-by-v0.4-20260916/…` is one set); a document directly in the archive belongs to the archive
 * itself (`subagent/archive/plan.md`). `dir` says the path is a directory, so its last segment may be the set.
 */
export function archiveRootOf(path: string, dir = false): string | null {
  const segs = slash(path).split('/');
  const i = segs.findIndex((s) => ARCHIVAL.test(s));
  if (i < 0) return null;
  const hasSet = dir ? i + 1 < segs.length : i + 2 < segs.length;
  return segs.slice(0, hasSet ? i + 2 : i + 1).join('/');
}

/** The layers whose documents list work as rows — a plan's tables, a task index, a contract set, an execution arrangement. */
const ROW_LAYERS: ReadonlySet<LayerKind> = new Set<LayerKind>(['Plan', 'Task index', 'Task contract', 'Execution arrangement']);
const SEP = String.raw`[\/_.\s-]`;
/** A name holding one of the words as a word of its own (between separators), or one of the CJK words anywhere. */
export const nameSays = (words: string, cjk: string): RegExp => new RegExp(`(?:^|${SEP})(?:${words})(?:${SEP}|$)|${cjk}`, 'i');
/** A name that says the document lists work: a plan, a roadmap, an index, a set of contracts or tasks. */
const ROW_NAME = nameSays('plans?|roadmap|backlog|milestones?|index|contracts?|tasks?|tickets?|issues?|todo', '计划|合同|任务|路线图|索引|清单');
/** A name that says it is something else: a readme, requirements, a specification, modules, a design, decisions, a report. */
const OTHER_NAME = nameSays('readme|prd|specs?|product|modules?|requirements?|designs?|decisions?|adrs?|notes?|reports?|reviews?|changelog', '需求|模块|决定|决策|设计|说明');

/** The layer entry over a path: the file's own, else the longest directory above it. */
export function layerEntryOver(store: ProjectStore, path: string) {
  return store.layers.filter((l) => slash(l.path) === path || path.startsWith(`${slash(l.path)}/`)).sort((a, b) => slash(b.path).length - slash(a.path).length)[0] ?? null;
}

/**
 * Whether a document lists work as its rows. The layer the orientation mapped the file itself to decides; else its
 * name, then the names of the directories above it — inside its set when `root` is one, nearest first; else the layer of
 * the directory the layer map names.
 */
export function listsWork(store: ProjectStore, root: string | null, path: string): boolean {
  const own = store.layers.find((l) => slash(l.path) === path && /\.[A-Za-z0-9]{1,6}$/.test(path));
  if (own) return ROW_LAYERS.has(own.layer);
  const inside = root === null ? path.split('/') : path === root ? path.split('/').slice(-1) : path.slice(root.length + 1).split('/');
  for (const seg of [...inside].reverse()) {
    if (ROW_NAME.test(seg)) return true;
    if (OTHER_NAME.test(seg)) return false;
  }
  const over = layerEntryOver(store, path);
  return over ? ROW_LAYERS.has(over.layer) : false;
}

export interface DefRow { readonly num: string; readonly rule: string; readonly repo: string | null; readonly path: string; readonly position: string | null; readonly kind: string; readonly current: number }
export interface LedgerDefs { readonly rows: readonly DefRow[]; readonly byNum: ReadonlyMap<string, readonly DefRow[]>; readonly repoPaths: ReadonlyMap<string, string>; readonly entries: Map<string, readonly { num: string; rule: string; position: string }[] | null> }
/** Every definition the ledger holds in a document or a file name, read once per opened ledger (a few thousand rows). */
const DEFS = new WeakMap<Ledger, LedgerDefs>();
export function ledgerDefs(ledger: Ledger): LedgerDefs {
  let d = DEFS.get(ledger);
  if (!d) {
    const rows = (ledger.db.prepare("SELECT DISTINCT num, rule, repo, path, position, kind, current FROM nums WHERE place = 'definition' AND kind IN ('doc', 'file-name') AND path IS NOT NULL").all() as unknown as DefRow[]);
    const byNum = new Map<string, DefRow[]>();
    for (const r of rows) byNum.set(r.num, [...(byNum.get(r.num) ?? []), r]);
    d = { rows, byNum, repoPaths: new Map(ledger.repos().map((r) => [r.id, r.path])), entries: new Map() };
    DEFS.set(ledger, d);
  }
  return d;
}

/**
 * A document's own entries as it stands in the checkout — its definitions at entry positions, less the points of another
 * numbered entry (entries.ts) — read from the text the ledger keeps; null when the ledger keeps no current text of it.
 */
export function currentEntries(ledger: Ledger, defs: LedgerDefs, repo: string | null, path: string): readonly { num: string; rule: string; position: string }[] | null {
  const k = `${repo ?? ''}\u0000${path}`;
  if (!defs.entries.has(k)) {
    const text = repo ? ledger.currentText(`${defs.repoPaths.get(repo) ?? ''}/${path}`) : null;
    defs.entries.set(k, text === null ? null : entryDefinitions(
      definitionsInText(text).filter((d) => d.position === 'heading' || d.position === 'bold entry' || d.position === 'table first column').map((d) => ({ num: d.num, rule: d.family, position: d.position, line: d.line ?? 0 })),
      text.split(/\r?\n/),
    ));
  }
  return defs.entries.get(k)!;
}

/** The positions a row of a plan stands at: a heading, or the first cell of a table row (a bold line is a log's entry). */
export const ROW_POSITIONS: ReadonlySet<string> = new Set(['heading', 'table first column']);

export interface CurrentRows {
  readonly defs: LedgerDefs;
  /** A document that is not current: under an archive, mapped not current, or under one of the roots given. */
  readonly setAside: (path: string) => boolean;
  /** A document named by a number: that item's own document, whose rows are its points. */
  readonly numberNamed: (path: string) => boolean;
  /** A file-name definition that is the file's own name (not a directory above it). */
  readonly namedByOwnNumber: (r: DefRow) => boolean;
  /** The current documents that list a number as a row of their own. */
  readonly currentRowsOf: (n: string) => DefRow[];
  /**
   * Carried on: a current document that lists work has the number as a row, or a current file among such documents is
   * named by it (a contract in the contract set). A report that tabulates it, or one named after it, does not carry it on.
   */
  readonly isCurrent: (n: string) => boolean;
}

/** What the current documents list as rows, read off the ledger. `alsoAside` are roots to treat as set aside besides the archives. */
export function currentRows(store: ProjectStore, ledger: Ledger, alsoAside: readonly string[] = []): CurrentRows {
  const defs = ledgerDefs(ledger);
  const aside = new Map<string, boolean>();
  const setAside = (path: string): boolean => {
    if (!aside.has(path)) aside.set(path, alsoAside.some((x) => path === x || path.startsWith(`${x}/`)) || archiveRootOf(path) !== null || layerEntryOver(store, path)?.current === false);
    return aside.get(path)!;
  };
  const namedByOwnNumber = (r: DefRow): boolean => r.kind === 'file-name' && definitionsInPath(r.path.split('/').pop() ?? r.path).some((d) => d.num === r.num);
  const numbered = new Map<string, boolean>();
  const numberNamed = (path: string): boolean => {
    if (!numbered.has(path)) numbered.set(path, definitionsInPath(path.split('/').pop() ?? path).some((d) => (defs.byNum.get(d.num) ?? []).some((r) => r.kind === 'file-name' && r.path === path)));
    return numbered.get(path)!;
  };
  const currentRowsOf = (n: string): DefRow[] => (defs.byNum.get(n) ?? []).filter((d) => d.kind === 'doc' && d.current === 1 && !setAside(d.path) && ROW_POSITIONS.has(d.position ?? '')
    && (currentEntries(ledger, defs, d.repo, d.path)?.some((e) => e.num === n && ROW_POSITIONS.has(e.position)) ?? true));
  const listed = new Map<string, boolean>();
  const isCurrent = (n: string): boolean => {
    if (!listed.has(n)) listed.set(n, currentRowsOf(n).some((d) => !numberNamed(d.path) && listsWork(store, null, d.path))
      || (defs.byNum.get(n) ?? []).some((d) => d.kind === 'file-name' && d.current === 1 && !setAside(d.path) && namedByOwnNumber(d) && listsWork(store, null, d.path)));
    return listed.get(n)!;
  };
  return { defs, setAside, numberNamed, namedByOwnNumber, currentRowsOf, isCurrent };
}

const ENDED: ReadonlySet<string> = new Set(['Replaced', 'Abandoned', 'Removed']);

/**
 * The work items a generation lists that were carried on under the same number (see the module comment): current work,
 * whatever generation lists them and whoever listed them. Empty without a ledger.
 */
export function carriedOnItems(store: ProjectStore, ledger: Ledger | null): Set<string> {
  const out = new Set<string>();
  const listed = new Set(store.generations.all().flatMap((g) => g.workIds));
  if (!ledger || !listed.size) return out;
  let rows: CurrentRows;
  try { rows = currentRows(store, ledger); } catch { return out; }
  for (const id of listed) {
    const t = store.threads.get(id);
    if (!t || ENDED.has(t.validity)) continue;
    if (t.ids.some((i) => rows.isCurrent(i.trim().toUpperCase()) || rows.isCurrent(i.trim()))) out.add(id);
  }
  return out;
}

const CACHE = new WeakMap<ProjectStore, { mark: string; carried: Set<string> }>();
const fileMark = (path: string): string => { try { const s = statSync(path); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch { return '-'; } };

/**
 * `carriedOnItems` for a reader that has only the store: the project's ledger is opened here, and the answer is kept
 * until the generations, their items, the layer map or the ledger change.
 */
export function carriedOn(store: ProjectStore): Set<string> {
  const gens = store.generations.all();
  if (!gens.some((g) => g.workIds.length)) return new Set();
  const mark = [
    fileMark(join(store.dir, 'ledger.sqlite')), fileMark(join(store.dir, 'ledger.sqlite-wal')),
    gens.map((g) => `${g.id}:${g.workIds.map((id) => { const t = store.threads.get(id); return t ? `${id}/${t.validity}/${t.ids.join(',')}` : id; }).join(';')}`).join('|'),
    store.layers.all().map((l) => `${l.path}/${l.layer}/${l.current ? 1 : 0}`).join('|'),
  ].join('#');
  const hit = CACHE.get(store);
  if (hit && hit.mark === mark) return hit.carried;
  let ledger: Ledger | null = null;
  try { ledger = Ledger.openDir(store.dir); } catch { ledger = null; }
  let carried = new Set<string>();
  try { carried = carriedOnItems(store, ledger); } catch { carried = new Set(); } finally { ledger?.close(); }
  CACHE.set(store, { mark, carried });
  return carried;
}

/**
 * The work of earlier generations: what the generations list, less what was carried on under the same number. This is
 * what "in an earlier generation" means to every reader that treats such work as history.
 */
export function earlierWork(store: ProjectStore): Set<string> {
  const listed = store.generations.all().flatMap((g) => g.workIds);
  if (!listed.length) return new Set();
  const carried = carriedOn(store);
  return new Set(listed.filter((id) => !carried.has(id)));
}

/** The earlier generation a work item belongs to as earlier work, or undefined: a carried-on item belongs to none. */
export function earlierGenerationOf(store: ProjectStore, workId: string) {
  const g = store.generations.find((x) => x.workIds.includes(workId));
  return g && !carriedOn(store).has(workId) ? g : undefined;
}
