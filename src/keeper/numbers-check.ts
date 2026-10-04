/**
 * What the writers check against the ledger's numbering (CJ; Spec §1.16 row 4; CKC-23 AC-21, CKC-24): a work item's ids
 * are numbers the project defines, and not another object's number; an item named by its number alone is named as its
 * document names it. Without a ledger (it is built by the round's first step), or a ledger that recognised no numbering,
 * nothing is checked.
 */
import { Ledger } from '../ledger/index.ts';
import { familyOf } from '../ledger/numbering.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { pathKey } from '../util/paths.ts';
import { entryTitle, isNumberOnly } from './organize/entries.ts';

/** A project number as written (`CKC-22`, `D99`, `AP`, `CK-M2`, `SOL-PI-0871`): the shapes the ledger and the writers read. */
const NUMBER_SHAPE = /^(?:[A-Z]{1,6}(?:-[A-Z]{1,4})?-?\d{1,4}(?:\.\d{1,3})*|[A-Z]{2})$/;
export const isNumberShaped = (s: string): boolean => NUMBER_SHAPE.test(s.trim()) && !/^V\d/.test(s.trim());

/** Reference categories whose numbers are never a work item's own: a decision's, a boundary's, a goal's, a module's. */
const NOT_A_TICKET: ReadonlySet<string> = new Set(['Decision', 'Boundary', "Owner's words", 'Product', 'Goal', 'Area', 'Design']);

/** Run with the project's ledger when it has one that recognised a numbering; the ledger is closed after. */
export function withNumbering<T>(store: ProjectStore, fn: (ledger: Ledger) => T, otherwise: T): T {
  let ledger: Ledger | null = null;
  try { ledger = Ledger.openDir(store.dir); } catch { ledger = null; }
  if (!ledger) return otherwise;
  try {
    const rules = ledger.db.prepare('SELECT count(*) c FROM num_rules').get() as { c: number } | undefined;
    if (!rules || rules.c === 0) return otherwise;
    return fn(ledger);
  } catch {
    return otherwise;
  } finally {
    ledger.close();
  }
}

/** The documents the layer map marks as current decision records, as `repo\0path` keys. */
function decisionRecordKeys(store: ProjectStore): Set<string> {
  return new Set(store.layers.filter((l) => l.layer === 'Decision record').map((l) => `${pathKey(l.repo ?? '')}\u0000${l.path.replace(/\\/g, '/').replace(/\/+$/, '')}`));
}

/**
 * Whose number this is when it is not a work item's: a decision, boundary, goal or module that carries it, or the decision
 * record that alone defines it (`D99`, `E145`). Null when it may be a work item's own number.
 */
export function otherObjectOf(store: ProjectStore, ledger: Ledger | null, num: string): string | null {
  const n = num.trim().toUpperCase();
  const item = store.reference.find((r) => NOT_A_TICKET.has(r.category) && r.ids.some((x) => x.trim().toUpperCase() === n));
  if (item) return `the ${item.category} ${item.ids[0] ?? ''} “${item.name.slice(0, 60)}”`;
  if (!ledger) return null;
  const records = decisionRecordKeys(store);
  if (!records.size) return null;
  const places = ledger.definitionPlaces(n);
  if (!places.length) return null;
  const repos = new Map(ledger.repos().map((r) => [r.id, r.path]));
  const inRecord = (d: { repo: string | null; path: string }) => [...records].some((k) => {
    const [repo, path] = k.split('\u0000') as [string, string];
    return pathKey(repos.get(d.repo ?? '') ?? '') === repo && (d.path === path || d.path.startsWith(`${path}/`));
  });
  if (places.every(inRecord)) return `a decision the decision record ${places[0]!.path} defines`;
  return null;
}

/**
 * The ids the project does not have as its numbers: of a numbering the ledger recognised (or two capitals), one it never
 * defines; of any other shape, one no document, commit or session the ledger read writes at all (`KIMI-P1`,
 * `SOL-PI-0871`: a label of the writer's own).
 */
export function undefinedNumbers(ledger: Ledger, ids: readonly string[]): string[] {
  const shaped = ids.map((i) => i.trim()).filter((i) => isNumberShaped(i.toUpperCase()));
  if (!shaped.length) return [];
  const defined = ledger.definedNumbers(shaped.map((s) => s.toUpperCase()));
  const rules = new Set((ledger.db.prepare('SELECT rule FROM num_rules').all() as { rule: string }[]).map((r) => r.rule));
  return shaped.filter((s) => {
    const up = s.toUpperCase();
    if (defined.has(up)) return false;
    const family = familyOf(up);
    if (family && (family.shape === 'two-letters' || rules.has(family.family))) return true;
    return !ledger.hasToken(up);
  });
}

/**
 * Why a name that is the number alone is refused, or null (CKC-23 AC-21: named as the document names it): the line that
 * defines the number — in a document the item cites, else anywhere current — gives a title besides the number.
 */
export function numberOnlyRefusal(store: ProjectStore, ledger: Ledger, name: string, sourceIds: readonly string[], what: string): string | null {
  if (!isNumberOnly(name)) return null;
  const num = name.replace(/[^A-Za-z0-9-]/g, '').toUpperCase();
  if (!familyOf(num) && !isNumberShaped(num)) return null;
  const defs = ledger.definitionsOf(num).filter((d) => d.position === 'heading' || d.position === 'bold entry' || d.position === 'table first column');
  if (!defs.length) return null;
  const cited = new Set(sourceIds.map((id) => store.sources.get(id)).flatMap((s) => (s && s.anchor.kind === 'file' ? [pathKey(s.anchor.path)] : [])));
  const repos = new Map(ledger.repos().map((r) => [r.id, r.path]));
  const absKey = (d: { repo: string | null; path: string }) => pathKey(`${repos.get(d.repo ?? '') ?? ''}/${d.path}`);
  const ordered = [...defs.filter((d) => cited.has(absKey(d))), ...defs.filter((d) => !cited.has(absKey(d)))];
  for (const d of ordered) {
    const t = entryTitle(d.context, num, d.position as 'heading');
    if (!t.title) continue;
    return `${what} “${name}” is its number alone, and the line that defines ${num} (${d.path}:${d.line}) gives its title: “${d.context.slice(0, 160)}”. Name it by its number and its title as written, e.g. “${t.name.slice(0, 120)}” (named as the document names it). Nothing was written.`;
  }
  return null;
}
