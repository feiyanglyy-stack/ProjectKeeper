/**
 * History in a context pack, given as lineage (Spec §2.11, §7.1; CKC-12 AC-35). D82 withdrew D61's "what exists only in
 * history enters no context": history is a first-hand source, and what bears on the work is given — marked as history,
 * saying when, and what replaced it or why it was removed. What remains of D61: what exists only in history (old versions,
 * deleted files, side branches, material kept for recovery) and objects `Removed` from the project's current version never
 * appear as current content; replaced and abandoned directions still go to `Do not revive`; a current object that still
 * rests on a removed one says so on its own row.
 *
 * Everything here is what the program already has, read and never inferred:
 * - the assets: the change records (the program records one per deletion, with the commit that deleted the material —
 *   intake/removal.ts), the round judgements that closed an item as superseded by a later change (§2.10), the sources a
 *   rule or the history reading made `History only`, and the objects that became `Removed`;
 * - the ledger's `How it got here` (ledger/views.ts `lineageView`): versions, the lines that say something was superseded,
 *   deletions, side branches, the plans and commits that name the object, where it stands now — when the project has a
 *   ledger.
 */
import type { ChangeItem, ChangeRecord } from '../model/types.ts';
import type { LineageStepView } from '../model/views-k.ts';
import type { ProjectStore } from '../store/project-store.ts';
import type { Ledger } from '../ledger/index.ts';
import { lineageView } from '../ledger/views.ts';
import { itemsOf } from '../keeper/adjustment.ts';

/** How an object left the project's current version, as the change records give it. */
export interface Removal {
  readonly at: string;
  readonly changeId: string;
  readonly effect: string;
  readonly title: string;
  readonly why: string | null;
  readonly sourceIds: readonly string[];
}

/**
 * The change that took an object out of the current version: the item that recorded it `Removed` (the program writes one
 * per deletion, dated by the commit that deleted the material and giving that commit's reason), else the latest item that
 * gave it up or replaced it. Null when the records hold neither — the pack then says the records do not say when.
 */
export function removalOf(store: ProjectStore, id: string): Removal | null {
  let removed: { c: ChangeRecord; it: ChangeItem } | null = null;
  let other: { c: ChangeRecord; it: ChangeItem } | null = null;
  for (const c of store.changes.all()) {
    for (const it of itemsOf(c)) {
      if (!it.affects.includes(id)) continue;
      if (it.effect === 'Removed') { if (!removed || it.at >= removed.it.at) removed = { c, it }; }
      else if ((it.effect === 'Abandoned' || it.effect === 'Replaced') && (!other || it.at >= other.it.at)) other = { c, it };
    }
  }
  const hit = removed ?? other;
  return hit ? { at: hit.it.at, changeId: hit.c.id, effect: hit.it.effect, title: hit.it.title, why: hit.it.why ?? null, sourceIds: hit.it.sourceIds } : null;
}

/** Why a change item that bears on the work is history rather than a change in force. */
export type HistoryReason =
  /** A later change superseded it for an object it reached (§2.10): the round closed the item with that change's id. */
  | { readonly kind: 'superseded'; readonly byChangeId: string | null; readonly reason: string }
  /** Every source it rests on exists only in history (§1.2 `History only`). */
  | { readonly kind: 'history only' }
  /** Everything it set down has since been replaced, given up or removed. */
  | { readonly kind: 'overtaken' };

export interface HistoryChange { readonly change: ChangeRecord; readonly item: ChangeItem; readonly why: HistoryReason }

const GONE = new Set(['Removed', 'Replaced', 'Abandoned']);

/**
 * The change items that reached one of `ids` and are history now, oldest first: superseded for one of them by a later
 * change, written only from material that exists in history, or everything they set down since replaced, given up or
 * removed. A proposal nobody adopted changed nothing and is not history of the work.
 */
export function historyChanges(store: ProjectStore, ids: ReadonlySet<string>): HistoryChange[] {
  const superseded = new Map<string, { byChangeId: string | null; reason: string }>();
  for (const j of store.propagation.filter((x) => ids.has(x.nodeId))) {
    for (const c of j.closed) if (c.close === 'Superseded by a later change') superseded.set(`${c.changeId}|${c.itemId}`, { byChangeId: c.supersededByChangeId ?? null, reason: c.reason });
  }
  const validity = (id: string) => store.reference.get(id)?.validity ?? store.threads.get(id)?.validity ?? store.nodes.get(id)?.validity ?? null;
  const out: HistoryChange[] = [];
  for (const change of store.changes.all()) {
    for (const item of itemsOf(change)) {
      if (!item.affects.some((id) => ids.has(id)) || item.by?.identity === 'Proposal') continue;
      const over = superseded.get(`${change.id}|${item.id}`);
      if (over) { out.push({ change, item, why: { kind: 'superseded', ...over } }); continue; }
      const sources = item.sourceIds.map((id) => store.sources.get(id)).filter((s) => s !== undefined);
      if (sources.length && sources.every((s) => s.usedAs === 'History only')) { out.push({ change, item, why: { kind: 'history only' } }); continue; }
      const states = item.affects.map(validity).filter((v): v is NonNullable<typeof v> => v !== null);
      if (states.length && states.every((v) => GONE.has(v))) out.push({ change, item, why: { kind: 'overtaken' } });
    }
  }
  return out.sort((a, b) => a.item.at.localeCompare(b.item.at));
}

/** The ledger's `How it got here` for one object, or why it could not be read; empty without a ledger. */
export function ledgerLineage(ledger: Ledger | null, store: ProjectStore, objectId: string): { readonly steps: readonly LineageStepView[]; readonly error: string | null } {
  if (!ledger) return { steps: [], error: null };
  try {
    return { steps: lineageView(ledger, store, objectId)?.steps ?? [], error: null };
  } catch (e) {
    return { steps: [], error: (e as Error).message };
  }
}
