/**
 * The workbench's own placement, read by the program (DB; Spec §1.4 "落位", §6.3).
 *
 * One definition of "unplaced": the story map's placement model (`ui/placement.js`) decides where every object sits and
 * what is not placed yet, and the program's counts for the Keeper — `pk_round_state`, the handover note, the reasons a
 * writer accepts — are read from that same model, never from a second rule. On the DeepSeek run (2026-10-04) the
 * program counted 0 unplaced while the workbench showed 2 work items in no band (their only plan was written `Proposed`,
 * which has no band) and 8 Requirements on nothing or on the Product with no reason: the program's rule covered
 * decisions, boundaries, designs and work items, and took any Plan item as a plan.
 *
 * The model is given what the workbench is given: each object's node as the graph derivation writes it (graph.ts
 * `referenceNode`, `threadNode`), the fields its placement reads (server/graph-view.ts `placementFields`), the earlier
 * generations (`generationsView`) and the relations. They are built from the assets as they stand now — the claims the
 * items carry (`claimedRelations`) together with the relations already written — because the graph is derived again
 * only when a job ends, and the main agent counts while its job runs.
 */
import { placementOf, unplacedOf, type Placement, type PlacementData, type PlacementNode, type UnplacedLists } from '../../../ui/placement.js';
import type { GraphRelation, ReferenceItem, WorkThread } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { generationsView, placementFields, recentChanges, recentlyChanged } from '../../server/graph-view.ts';
import { claimedRelations, referenceNode, threadNode } from './graph.ts';

/** A work item as a write is about to leave it, read in place of the stored one: the writer checks its reasons before it writes. */
export interface PlacementOverride { readonly thread?: WorkThread }

/** What the placement model is given: the objects still in the project's current version, as the graph view gives them. */
export function placementData(store: ProjectStore, override: PlacementOverride = {}): PlacementData {
  const own = override.thread;
  const threads = own ? [...store.threads.filter((t) => t.id !== own.id), own] : store.threads.all();
  const derived = [...store.reference.filter((r) => r.validity !== 'Removed').map((r) => referenceNode(store, r)), ...threads.filter((t) => t.validity !== 'Removed').map((t) => threadNode(store, t))];
  const ids = new Set(derived.map((n) => n.id));
  const seen = new Set<string>();
  const relations: Pick<GraphRelation, 'type' | 'from' | 'to'>[] = [];
  // The item being written states its own serves; the relations already written stay, as the next derivation keeps them.
  const stated = own ? own.serves.filter((s) => store.reference.has(s.referenceId)).map((s) => ({ type: 'serves' as const, from: own.id, to: s.referenceId })) : [];
  for (const r of [...stated, ...claimedRelations(store), ...store.relations.all()]) {
    const key = `${r.type}\u0000${r.from}\u0000${r.to}`;
    if (seen.has(key) || !ids.has(r.from) || !ids.has(r.to)) continue;
    seen.add(key);
    relations.push({ type: r.type, from: r.from, to: r.to });
  }
  const recent = recentlyChanged(recentChanges(store), relations);
  const fields = (n: (typeof derived)[number]) => (own && n.id === own.id
    ? { servesOrder: own.serves.map((s) => s.referenceId), ...(own.wholePlanWhy?.trim() ? { wholePlanWhy: own.wholePlanWhy.trim() } : {}), ...(own.noPlanWhy?.trim() ? { noPlanWhy: own.noPlanWhy.trim() } : {}), ...(own.noAreaWhy?.trim() ? { noAreaWhy: own.noAreaWhy.trim() } : {}) }
    : placementFields(store, n));
  const nodes: PlacementNode[] = derived.map((n) => ({ id: n.id, category: n.category, label: n.label, validity: n.validity, progress: n.progress, areaId: n.areaId, parentId: null, replacedBy: n.replacedBy, recentChange: recent.has(n.id), ...fields(n) }));
  return { nodes, relations, generations: generationsView(store) };
}

/** The workbench's placement of the project as its assets stand now — or as they would with the work item a write is about to store. */
export function workbenchPlacement(store: ProjectStore, override: PlacementOverride = {}): Placement {
  return placementOf(placementData(store, override));
}

export interface WorkbenchUnplaced {
  readonly placement: Placement;
  /** What is not placed yet, by kind (ui/placement.js `unplacedOf`). */
  readonly lists: UnplacedLists;
  /** The plans the workbench draws a band for: the current ones. */
  readonly drawnPlans: ReadonlySet<string>;
}

/** The workbench's placement together with its lists of what is not placed. */
export function workbenchUnplaced(store: ProjectStore): WorkbenchUnplaced {
  const placement = workbenchPlacement(store);
  return { placement, lists: unplacedOf(placement), drawnPlans: new Set(placement.plans.map((p) => p.id)) };
}

/** A plan in words for a list: its name, and why the workbench draws no band for it. */
export function planNotDrawnLine(store: ProjectStore, placement: Placement, planId: string): string {
  const plan = store.reference.get(planId);
  if (!plan) return planId;
  const gen = placement.generations.find((g) => g.planIds.includes(planId));
  const name = plan.name.length > 60 ? `${plan.name.slice(0, 59)}…` : plan.name;
  return `${name} (${plan.validity}${gen ? `; held in the earlier generation ${gen.name}` : ''})`;
}

/**
 * The plans a work item serves that the workbench draws no band for, each in words — empty when it serves none, or
 * stands in a band. A work item whose only plans are these is in no plan (ui/placement.js `plansNotDrawn`).
 */
export function plansNotDrawnOf(store: ProjectStore, placement: Placement, thread: Pick<WorkThread, 'id'>): string[] {
  return (placement.place.get(thread.id)?.plansNotDrawn ?? []).map((id) => planNotDrawnLine(store, placement, id));
}

/** Where a requirement, design or decision stands when it is not placed: on nothing, or only on the Product (or a Goal) with no reason. */
export function unplacedIntent(store: ProjectStore, lists: UnplacedLists): { readonly item: ReferenceItem; readonly on: 'nothing' | 'the Product only' }[] {
  const out: { item: ReferenceItem; on: 'nothing' | 'the Product only' }[] = [];
  for (const id of lists.intentNowhere) { const item = store.reference.get(id); if (item) out.push({ item, on: 'nothing' }); }
  for (const id of lists.intentProductOnly) { const item = store.reference.get(id); if (item) out.push({ item, on: 'the Product only' }); }
  return out;
}
