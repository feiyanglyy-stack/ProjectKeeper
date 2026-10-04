/**
 * Time order in the program's placement inference (CR, D104 follow-up to CQ). Two countable facts the ledger already
 * holds, checked by the program so the model's attention is not spent overriding them:
 *
 * - **A citation cannot precede what it cites.** A token a record names (a number of any family, a two-letter id, `#n`,
 *   an id in front matter, a row's batch) counts only when the item it names was first written on or before the citing
 *   record's date (one day of slack for time zones). The acceptance run of CQ placed E88 on K through "E87's entry names
 *   CN": E87 (2026-09-22) writes `智谱 CN` — China in a key name — and ticket CN was first written on 2026-10-01.
 * - **A work item or an execution decision does not go to a plan written after it.** An execution decision records the
 *   execution of a plan that existed at that time; a plan first written after it cannot be the one it executed. Product
 *   decisions are exempt: a product decision may shape a later plan.
 *
 * Where either date is unknown the check keeps the inference as it was. The dates:
 *
 * - **When an item was first written** (`first`): its first appearance as the ledger dates its defining lines (`nums`
 *   definitions of its numbers, every version, deleted documents included), and for a Plan item the first version of the
 *   document whose heading or table row defines it (the date the ledger gives that line). A date is exact when it is
 *   written for the line or its entry, or is the commit of an ordinary commit; a file's time, a first observation, the
 *   commit of an import-style root commit, or a document's stated date only say the line existed by then. When such a
 *   bound is earlier than every exact date, the first appearance is unknown.
 * - **The date of a citing record**: a decision's own entry date (the date its heading or bold entry carries, else the
 *   date its name writes; a later note in the entry that names the token and writes its own date cites as of that date);
 *   for a table row, a work item's row, prompt or words, and a line of a current document, the latest version of the
 *   document that holds it (the line was written by then, so a later date only keeps more).
 */
import type { Ledger } from '../../ledger/index.ts';
import { versionText } from '../../ledger/docs.ts';
import { dateContext, datesOnLine, dayOf } from '../../ledger/time.ts';
import type { ReferenceItem } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';

const slash = (p: string) => p.replace(/\\/g, '/');
const upper = (s: string) => s.trim().toUpperCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME_SEP = ' · ';

/** One day of slack for time zones: `a` is after `b` only when it is two calendar days later or more. */
export function laterThan(a: string, b: string): boolean {
  const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const x = ms(a);
  const y = ms(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return false;
  return x - y > 86_400_000;
}

/**
 * The latest a ledger row says its line was written by: a commit (ordinary or import), a file's time, a first
 * observation. A date written in the text is not one (a row may write a date it refers to, `会话边界（2026-09-18）`): for
 * content of an import commit the import is (`other_at`); outside version control, none.
 */
export function writtenBy(r: { readonly occurred_at: string; readonly occurred_basis: string; readonly other_at?: string | null }): string | null {
  return dayOf(r.occurred_basis === 'Written in text' ? r.other_at ?? null : r.occurred_at);
}

/**
 * The latest full date written on a line of an entry that names `n` as a whole token, or null. An entry kept "in place and
 * whole" may get a dated note later (`部分被 D67 改动（2026-09-21）`): that line cites as of its own date, not the entry's.
 */
export function lineDateNaming(text: string, n: string): string | null {
  const re = new RegExp(`(?<![\\p{L}\\p{N}_-])${esc(n)}(?![\\p{L}\\p{N}_])`, 'iu');
  let out: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!re.test(line)) continue;
    for (const d of datesOnLine(line, null)) if (!out || d.at > out) out = d.at;
  }
  return out;
}

/** Whether `first` (when the cited item was first written) is after the citing record's day, allowing a later dated note in its text that names it. */
export function citedAfter(first: string | null, day: string | null, text?: string, n?: string): boolean {
  if (!first || !day || !laterThan(first, day)) return false;
  const noted = text && n ? lineDateNaming(text, n) : null;
  return !(noted && !laterThan(first, noted));
}

/** The layers whose documents are the product layer: a decision log beside them is a product log. */
const PRODUCT_LAYERS = new Set(['Plan', 'PRD', 'Spec', 'Product', 'Task contract']);
/** The layers of the execution layer: a decision log beside them is an execution log. */
const EXECUTION_LAYERS = new Set(['Execution arrangement', 'Task index']);

export interface Chronology {
  /** When the item (a work item or a reference item) was first written, `YYYY-MM-DD`; null when the records cannot say. */
  first(id: string): string | null;
  /** The date of an item's own record for "after it" checks: a decision's entry date; a work item's first appearance. */
  own(id: string): string | null;
  /** The date a work item's records as they stand now were written by: the latest version of the documents that define it. */
  current(id: string): string | null;
  /** The date a line of a document as it stands now was written by: the document's latest version (else the ledger's rows of that line). */
  line(path: string, line: number | null): string | null;
  /** The date of a document's latest version. */
  file(path: string): string | null;
  /** When a token of a table was first written in that document (a batch row `B2` of an arrangement), or null. */
  firstIn(token: string, path: string): string | null;
  /** Whether a decision or boundary is an entry of an execution log (its log sits with the execution layer, not the product layer). */
  executionEntry(d: ReferenceItem): boolean;
}

/** Without a ledger nothing is dated: every check keeps the inference as it was. */
export const NO_CHRONOLOGY: Chronology = {
  first: () => null, own: () => null, current: () => null, line: () => null, file: () => null, firstIn: () => null,
  executionEntry: () => false,
};

interface NumRow {
  readonly num: string; readonly kind: string; readonly repo: string | null; readonly position: string | null; readonly path: string | null; readonly line: number | null; readonly commit_hash: string | null;
  readonly occurred_at: string; readonly occurred_basis: string; readonly occurred_anchor: string | null; readonly other_at: string | null; readonly current: number;
}

export function chronology(store: ProjectStore, ledger: Ledger | null): Chronology {
  if (!ledger) return { ...NO_CHRONOLOGY, executionEntry: (d) => executionEntryByLayers(store, null, d) };
  const db = ledger.db;
  const all = <T>(sql: string, ...params: (string | number | null)[]): T[] => { try { return db.prepare(sql).all(...params) as T[]; } catch { return []; } };
  const imports = all<{ hash: string }>('SELECT hash FROM commits WHERE import_root = 1').map((r) => r.hash);
  const atImport = (r: NumRow): boolean => r.occurred_basis === 'Commit' && imports.some((h) => (r.commit_hash ?? '').startsWith(h.slice(0, 10)) || (r.occurred_anchor ?? '').includes(h.slice(0, 10)));
  // A line dated only by its document's stated date (`日期：` in the preamble of content that predates version control):
  // that is when the document's version was written, so the line existed by then, not since then.
  const docDateLine = new Map<string, number | null>();
  const documentDated = (r: NumRow): boolean => {
    if (r.occurred_basis !== 'Written in text' || !r.occurred_anchor) return false;
    const m = /^(.*):(\d+)$/.exec(r.occurred_anchor);
    if (!m) return false;
    const [, at, n] = m;
    const key = `${r.repo ?? ''}|${at}`;
    if (!docDateLine.has(key)) {
      let text: string | null = null;
      if (r.kind === 'loose') text = all<{ content: string }>('SELECT content FROM texts WHERE key = ?', `loose:${at}`)[0]?.content ?? null;
      else {
        const v = all<{ repo: string; blob: string }>('SELECT repo, blob FROM docs WHERE path = ? AND import_root = 1' + (r.repo ? ' AND repo = ?' : '') + ' ORDER BY at_ms LIMIT 1', ...(r.repo ? [at!, r.repo] : [at!]))[0];
        if (v) { try { text = versionText(db, v.repo, v.blob); } catch { text = null; } }
      }
      docDateLine.set(key, text === null ? null : dateContext(text).document?.line ?? null);
    }
    const docLine = docDateLine.get(key);
    return docLine !== null && docLine !== undefined && docLine === Number(n) && r.line !== Number(n);
  };
  /**
   * Exact: a date written for the line itself or its entry, or the commit of an ordinary commit. Everything else — a
   * file's time, a first observation, an import commit, a document's stated date — only says the line existed by then.
   */
  const exact = (r: NumRow): boolean => (r.occurred_basis === 'Written in text' && !documentDated(r)) || (r.occurred_basis === 'Commit' && !atImport(r));
  /** The earliest a row says its line existed by (its date, or the import's when that is earlier). */
  const boundOf = (r: NumRow): string | null => { const a = dayOf(r.occurred_at); const b = dayOf(r.other_at); return a && b ? (a < b ? a : b) : a ?? b; };
  let repos: { id: string; path: string }[] = [];
  try { repos = ledger.repos().map((r) => ({ id: r.id, path: slash(r.path).replace(/\/+$/, '') })); } catch { repos = []; }
  /** A path as the ledger keys it: repository-relative when it is in a repository. */
  const relative = (p: string): { repo: string | null; path: string } => {
    const s = slash(p);
    const root = repos.filter((x) => s.toLowerCase().startsWith(`${x.path.toLowerCase()}/`)).sort((a, b) => b.path.length - a.path.length)[0];
    return root ? { repo: root.id, path: s.slice(root.path.length + 1) } : { repo: null, path: s };
  };

  const rowsCache = new Map<string, NumRow[]>();
  const definitions = (num: string): NumRow[] => {
    const key = upper(num);
    let rows = rowsCache.get(key);
    if (!rows) {
      rows = all<NumRow>("SELECT num, kind, repo, position, path, line, commit_hash, occurred_at, occurred_basis, occurred_anchor, other_at, current FROM nums WHERE num = ? AND place = 'definition' AND confidence = 'stated'", key);
      rowsCache.set(key, rows);
    }
    return rows;
  };
  /** The first appearance the rows support: the earliest exact date, unless a bound says the line existed before it. */
  const firstOf = (rows: readonly NumRow[], extra: readonly { day: string; exact: boolean }[] = []): string | null => {
    let exactMin: string | null = null;
    let boundMin: string | null = null;
    const take = (day: string | null, isExact: boolean) => {
      if (!day) return;
      if (isExact) { if (!exactMin || day < exactMin) exactMin = day; } else if (!boundMin || day < boundMin) boundMin = day;
    };
    for (const r of rows) { if (exact(r)) take(dayOf(r.occurred_at), true); else take(boundOf(r), false); }
    for (const e of extra) take(e.day, e.exact);
    if (!exactMin) return null;
    return boundMin && boundMin < exactMin ? null : exactMin;
  };

  const numbersOf = (id: string): string[] => {
    const t = store.threads.get(id);
    const ids = t ? t.ids : store.reference.get(id)?.ids ?? [];
    return [...new Set(ids.map(upper))].filter((n) => n.length >= 2 && n.length <= 24);
  };

  // A Plan item: the first version of its own document whose heading or table row defines it by its token.
  const planTokens = (r: ReferenceItem): string[] => {
    const lead = (r.name.split(NAME_SEP)[0] ?? '').trim();
    return [...new Set([...r.ids, ...(lead && lead.length <= 16 ? [lead] : [])].map(upper))].filter(Boolean);
  };
  const definesLine = (line: string, tokens: readonly string[]): boolean => {
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    const cell = /^\s*\|\s*([^|]*)\|/.exec(line);
    const text = heading?.[1] ?? cell?.[1];
    if (text === undefined) return false;
    const bare = text.replace(/[*`[\]]/g, '').trim();
    return tokens.some((t) => new RegExp(`^${esc(t)}(?![\\p{L}\\p{N}_-])`, 'iu').test(bare));
  };
  const planVersions = (r: ReferenceItem): { day: string; exact: boolean }[] => {
    const tokens = planTokens(r);
    if (!tokens.length) return [];
    const out: { day: string; exact: boolean }[] = [];
    const paths = new Set<string>();
    for (const sid of r.sourceIds) { const a = store.sources.get(sid)?.anchor; if (a?.kind === 'file') paths.add(a.path); }
    for (const p of paths) {
      const rel = relative(p);
      const versions = all<{ repo: string; blob: string; at: string; import_root: number }>(`SELECT repo, blob, at, import_root FROM docs WHERE path = ?${rel.repo ? ' AND repo = ?' : ''} ORDER BY at_ms`, ...(rel.repo ? [rel.path, rel.repo] : [rel.path]));
      for (const v of versions) {
        let text: string | null = null;
        try { text = versionText(db, v.repo, v.blob); } catch { text = null; }
        if (text === null) continue;
        const lines = text.split(/\r?\n/);
        const i = lines.findIndex((l) => definesLine(l, tokens));
        if (i < 0) continue;
        if (!v.import_root) out.push({ day: dayOf(v.at)!, exact: true });
        else {
          // Content that existed before version control: the date the ledger gives that line (its own, its entry's, else the
          // date of the document's version that has it first), else only "by the import".
          const written = dateContext(text).at(i + 1);
          out.push(written ? { day: written.at.slice(0, 10), exact: true } : { day: dayOf(v.at)!, exact: false });
        }
        break;
      }
    }
    return out;
  };

  const firstCache = new Map<string, string | null>();
  const first = (id: string): string | null => {
    if (firstCache.has(id)) return firstCache.get(id)!;
    const rows = numbersOf(id).flatMap(definitions);
    const r = store.reference.get(id);
    const extra = r?.category === 'Plan' ? planVersions(r) : [];
    const out = firstOf(rows, extra);
    firstCache.set(id, out);
    return out;
  };

  const ownSourcePaths = (r: ReferenceItem): string[] => [...new Set(r.sourceIds.flatMap((sid) => { const a = store.sources.get(sid)?.anchor; return a?.kind === 'file' ? [relative(a.path).path.toLowerCase()] : []; }))];
  const ownCache = new Map<string, string | null>();
  const own = (id: string): string | null => {
    if (ownCache.has(id)) return ownCache.get(id)!;
    let out: string | null = null;
    const r = store.reference.get(id);
    if (r && (r.category === 'Decision' || r.category === 'Boundary')) {
      // Its entry in its own log: the date its heading (or bold entry) carries, or the commit that added it.
      const paths = ownSourcePaths(r);
      const mine = numbersOf(id).flatMap(definitions).filter((x) => x.path && paths.some((p) => slash(x.path!).toLowerCase() === p || slash(x.path!).toLowerCase().endsWith(`/${p}`)));
      const heads = mine.filter((x) => x.position === 'heading' || x.position === 'bold entry');
      for (const x of heads) if (exact(x)) { const d = dayOf(x.occurred_at); if (d && (!out || d < out)) out = d; }
      // Else the date its name (its heading) writes, when it is an entry with a heading or none the ledger read.
      if (!out && (heads.length || !mine.length)) out = /(\d{4}-\d{2}-\d{2})/.exec(r.name)?.[1] ?? null;
      // Else (a row of a table, where a date written may be one it refers to, and a long row may change past what the ledger
      // keeps of it) the latest version of the log that holds it: the row was written by then.
      if (!out) for (const x of mine) { const d = (x.path && x.kind !== 'loose' ? fileIn(x.repo, x.path) : null) ?? writtenBy(x); if (d && (!out || d > out)) out = d; }
    } else out = first(id);
    ownCache.set(id, out);
    return out;
  };

  const fileCache = new Map<string, string | null>();
  /** The day of a document's latest version (a repository-relative path in a known repository, or any). */
  function fileIn(repo: string | null, rel: string): string | null {
    const key = `${repo ?? ''}:${rel.toLowerCase()}`;
    if (fileCache.has(key)) return fileCache.get(key)!;
    const v = all<{ at: string }>(`SELECT at FROM docs WHERE path = ?${repo ? ' AND repo = ?' : ''} ORDER BY at_ms DESC LIMIT 1`, ...(repo ? [rel, repo] : [rel]))[0];
    const out = v ? dayOf(v.at) : null;
    fileCache.set(key, out);
    return out;
  }
  const file = (path: string): string | null => { const rel = relative(path); return fileIn(rel.repo, rel.path); };
  // A line as it stands now was written by the document's latest version. (The ledger's rows of a line keep its first
  // version, and a long line may change past what they keep of it: the document's version is the safe date.)
  const line = (path: string, n: number | null): string | null => {
    const out = file(path);
    if (out || n === null) return out;
    const rel = relative(path);
    let latest: string | null = null;
    for (const r of all<{ occurred_at: string; occurred_basis: string; other_at: string | null }>('SELECT occurred_at, occurred_basis, other_at FROM nums WHERE path = ? AND line = ? AND current = 1', rel.path, n)) { const d = writtenBy(r); if (d && (!latest || d > latest)) latest = d; }
    return latest;
  };
  const current = (id: string): string | null => {
    let out: string | null = null;
    for (const r of numbersOf(id).flatMap(definitions)) if (r.current) { const d = (r.path && r.kind !== 'loose' ? fileIn(r.repo, r.path) : null) ?? writtenBy(r); if (d && (!out || d > out)) out = d; }
    return out ?? own(id);
  };
  const firstIn = (token: string, path: string): string | null => {
    const rel = relative(path).path.toLowerCase();
    return firstOf(definitions(token).filter((r) => r.path && slash(r.path).toLowerCase() === rel));
  };
  return { first, own, current, line, file, firstIn, executionEntry: (d) => executionEntryByLayers(store, ledger, d, relative) };
}

/**
 * Whether a decision or boundary is an entry of an execution log: the log's directory holds (or contains) the execution
 * layer — an execution arrangement or a task index — and no document of the product layer (plan, PRD, Spec, product,
 * contracts) sits beside it. Without a layer map: an index or a prompt the ledger read sits beside the log.
 */
function executionEntryByLayers(store: ProjectStore, ledger: Ledger | null, d: ReferenceItem, relative?: (p: string) => { repo: string | null; path: string }): boolean {
  if (d.category !== 'Decision' && d.category !== 'Boundary') return false;
  const rel = relative ?? ((p: string) => ({ repo: null, path: slash(p) }));
  const logs = [...new Set(d.sourceIds.flatMap((sid) => { const a = store.sources.get(sid)?.anchor; return a?.kind === 'file' ? [a.path] : []; }))];
  if (!logs.length) return false;
  const layers = store.layers.all();
  return logs.some((abs) => {
    const s = slash(abs).toLowerCase();
    const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
    if (layers.length) {
      // The layer map's paths are relative to their repository: joined to it, they compare with the log's absolute path.
      const inRepo = layers.map((l) => ({ ...l, full: `${slash(l.repo ?? '').replace(/\/+$/, '').toLowerCase()}/${slash(l.path).replace(/\/+$/, '').toLowerCase()}` }));
      const dir = dirOf(s);
      const below = (p: string) => p.startsWith(`${dir}/`);
      const execution = inRepo.some((l) => EXECUTION_LAYERS.has(l.layer) && below(l.full));
      const product = inRepo.some((l) => PRODUCT_LAYERS.has(l.layer) && (dirOf(l.full) === dir || l.full === dir));
      return execution && !product;
    }
    if (!ledger) return false;
    const r = rel(abs);
    const dir = dirOf(r.path.toLowerCase());
    let files: { path: string; kind: string }[] = [];
    try { files = ledger.db.prepare("SELECT DISTINCT path, kind FROM plans WHERE current = 1 AND kind IN ('index', 'prompt')").all() as typeof files; } catch { files = []; }
    return files.some((f) => dirOf(rel(f.path).path.toLowerCase()) === dir);
  });
}
