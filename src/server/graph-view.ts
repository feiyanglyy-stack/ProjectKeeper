/**
 * What the workbench shows, assembled from the assets (Spec §6.2–§6.5): graph nodes with their
 * visibility flags and markers, the strip (Notes (attention), Recent changes, Since last visit),
 * and object details. Pure reads; nothing here changes an asset.
 */
import type { ChangeRecord, FollowUpRound, GraphNode, GraphRelation, LackedItem, Note, NoteMount, PendingWait, Project, RoundResult } from '../model/types.ts';
import type { RoundNews, RoundNewsItem } from '../model/k-types.ts';
import { OWNER_WORDS, type ChangeEffect, type Propagation } from '../model/vocab.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { anchorLabel } from '../sources/anchor.ts';
import { itemsOf, notJudgedReason, objectUpdatedAt, roundNumberOf } from '../keeper/adjustment.ts';
import { generationPlanIds } from '../process/generations.ts';
import { authorityOf, carryOutOf, checksOn, claimMaterials, isRemoved, OWNER_WORDS_GROUP, statementView } from './workbench-content.ts';
import { scheduleOf } from '../keeper/organize/schedule.ts';
import { carriedOn } from '../keeper/organize/carried-on.ts';

export interface ViewNode extends GraphNode {
  /** The current notes on it; a note on a path counts on the path's top object only (Spec §6.2, D100). */
  readonly noteCount: number;
  /** Of those, the notes still in `Notes (attention)` (§2.7): a highlighted ❓ on the object (D100). */
  readonly noteAttention: number;
  readonly noteAsk: string | null;              // strongest ask among current notes on it
  readonly marks: readonly { readonly kind: string; readonly clue: string }[];
  readonly updatePending: boolean;
  readonly noEstablishedLink: boolean;
  /** `Owner's words` is the group on top of the graph and above the List's areas, folded until opened (§6.3, D63). */
  readonly group: 'Existing foundation' | 'Unplaced' | typeof OWNER_WORDS_GROUP | null;
  readonly recentChange: boolean;               // affected by, or replaced through, a recent change
  readonly parentId: string | null;             // area for work items; work item for sessions/runs/results
  readonly summary: string | null;              // a line of the object's own text for lists
  readonly changedAt: string | null;            // latest change record that affects it (or replaced it)
  /** A work item's `serves`, in the order the Keeper wrote them: the first Area written is the module its dispatch
   *  ticket or prompt names, where it is drawn solid when it implements no contract (owner, 2026-09-30; ui/placement.js). */
  readonly servesOrder?: readonly string[];
  /** An Area that is a cross-cutting foundation (D101; Spec §1.4, §6.3): its column goes after every module's and its
   *  head says `Cross-cutting foundation` (ui/placement.js). Present only when set. */
  readonly foundation?: true;
  /** A requirement, design or decision placed on the whole product, with the Keeper's written reason (CM; Spec §1.4
   *  落位): the cross-cutting ring's `Whole product` group shows it with that reason. Present only when written. */
  readonly wholeProductWhy?: string;
  /** A work item that serves its whole plan — all of the plan's modules — and no single one, with the Keeper's written
   *  reason (CN; Spec §1.4 落位): it stands in its plan's cross-cutting cell with that reason. Present only when written. */
  readonly wholePlanWhy?: string;
  /** CQ (D104): a work item written as in no plan, with the recorded reason the program accepted; the placement detail shows it
   *  as "written: no plan — why" and it is not counted as unplaced. Present only when written. */
  readonly noPlanWhy?: string;
  /** CQ (D104): a work item written as in no module, with its recorded reason. Present only when written. */
  readonly noAreaWhy?: string;
}

const ASK_ORDER: Record<string, number> = { 'For your decision': 3, 'Worth discussing': 2, 'For information': 1 };
const RECENT_CHANGES = 10;

function latest(note: Note) { return note.versions[note.versions.length - 1]!; }

/** The layers of the product from the top, for a path's top object (Spec §6.2: a note on a path is marked on its top). */
const LAYER_RANK: Record<string, number> = { [OWNER_WORDS]: 0, Product: 1, Goal: 2, Area: 3, Requirement: 4, Design: 5, Decision: 6, Plan: 7, 'Work item': 8, Review: 9, Test: 9, Result: 9, Session: 10, Run: 10, Change: 11 };

/**
 * The objects a note is marked on (D100): the objects of a node or relation mount; a path's top object — the one
 * highest in the product's layers, the first of them on a tie; nothing for the whole project (the drawer has those).
 */
export function noteOnIds(store: ProjectStore, note: Note): readonly string[] {
  if (note.mount.kind === 'project') return [];
  if (note.mount.kind !== 'path') return note.mount.ids;
  const rank = (id: string) => { const n = store.nodes.get(id); return n ? LAYER_RANK[n.category] ?? 99 : store.relations.has(id) ? 98 : 100; };
  const top = [...note.mount.ids].sort((a, b) => rank(a) - rank(b))[0];
  return top ? [top] : [];
}

/**
 * Whether a current note is still in `Notes (attention)` (Spec §2.7): it asks for a decision or is worth discussing,
 * and the owner has not answered it in a way that lets it leave. The drawer lists the ones on the whole project; the
 * others are the highlighted ❓ on their objects (D100).
 */
export function inAttention(n: Note): boolean {
  if (n.status !== 'Current') return false;
  const v = latest(n);
  const resp = n.ownerResponse ?? null;
  const left = resp === 'Decided' || resp === 'Delegated' || resp === 'No action needed' || (v.ask === 'Worth discussing' && resp === 'Discussed');
  return (v.ask === 'For your decision' || v.ask === 'Worth discussing') && !left;
}

export function recentChanges(store: ProjectStore, limit = RECENT_CHANGES): ChangeRecord[] {
  return store.changes.all().sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit).reverse();
}

/** The objects a recent change affected, or that replaced or were replaced through one: drawn even when no longer in force. */
export function recentlyChanged(recent: readonly ChangeRecord[], relations: readonly Pick<GraphRelation, 'type' | 'from' | 'to'>[]): Set<string> {
  const ids = new Set(recent.flatMap((c) => c.affects));
  for (const r of relations) if (r.type === 'replaces' && (ids.has(r.from) || ids.has(r.to))) { ids.add(r.from); ids.add(r.to); }
  return ids;
}

/** The fields of a node that only its placement on the story map reads (ui/placement.js), each present only when set. */
export type PlacementFields = Pick<ViewNode, 'servesOrder' | 'foundation' | 'wholeProductWhy' | 'wholePlanWhy' | 'noPlanWhy' | 'noAreaWhy'>;

/**
 * What a node's placement reads besides the node itself: one definition for the view the workbench draws and for the
 * program's own count of what is not placed (DB; keeper/organize/workbench-placement.ts).
 */
export function placementFields(store: ProjectStore, n: Pick<GraphNode, 'refKind' | 'refId'>): PlacementFields {
  const thread = n.refKind === 'thread' ? store.threads.get(n.refId) : undefined;
  const servesOrder = thread?.serves.map((s) => s.referenceId);
  // D101 and CM (Spec §1.4): the foundation column and the whole-product reason ride on the node only when set.
  const ref = n.refKind === 'reference' ? store.reference.get(n.refId) : undefined;
  const foundation = ref?.category === 'Area' && ref.foundation === true;
  const wholeProductWhy = ref?.wholeProductWhy?.trim() || null;
  const wholePlanWhy = thread?.wholePlanWhy?.trim() || null;
  // CQ (D104): the recorded reasons the records lead nowhere, shown where the placement detail shows the whole-plan reason.
  const noPlanWhy = thread?.noPlanWhy?.trim() || null;
  const noAreaWhy = thread?.noAreaWhy?.trim() || null;
  return { ...(servesOrder ? { servesOrder } : {}), ...(foundation ? { foundation: true as const } : {}), ...(wholeProductWhy ? { wholeProductWhy } : {}), ...(wholePlanWhy ? { wholePlanWhy } : {}), ...(noPlanWhy ? { noPlanWhy } : {}), ...(noAreaWhy ? { noAreaWhy } : {}) };
}

/**
 * The earlier generations as the story map reads them (Spec §2.12, D85, D100): their plans and work items as the Keeper
 * recorded them. CZ: `carriedIds` are the items carried on under the same number — current work, placed in its current plan.
 */
export function generationsView(store: ProjectStore) {
  const carried = carriedOn(store);
  return store.generations.all().sort((a, b) => a.ended.at.localeCompare(b.ended.at)).map((g) => ({ id: g.id, name: g.name, started: g.started, ended: g.ended, endedBy: { label: g.endedBy.label, line: g.endedBy.line ?? null }, workIds: g.workIds, carriedIds: g.workIds.filter((id) => carried.has(id)), planIds: generationPlanIds(store, g) }));
}

export function graphView(store: ProjectStore, project: Project) {
  // What was removed from the project's current version stays in the assets as history, but is neither drawn nor
  // listed, and nothing is drawn to it (§2.1, D61; CKC-09 AC-32): it appears only, struck through, in the changes.
  const removed = new Set(store.nodes.all().filter((n) => n.validity === 'Removed' || isRemoved(store, n.refId)).map((n) => n.id));
  const nodes = store.nodes.all().filter((n) => !removed.has(n.id));
  const relations = store.relations.all().filter((r) => !removed.has(r.from) && !removed.has(r.to));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, GraphRelation[]>();
  const inc = new Map<string, GraphRelation[]>();
  for (const r of relations) {
    if (!out.has(r.from)) out.set(r.from, []);
    out.get(r.from)!.push(r);
    if (!inc.has(r.to)) inc.set(r.to, []);
    inc.get(r.to)!.push(r);
  }
  const currentNotes = store.notes.filter((n) => n.status === 'Current');
  const notesOn = new Map<string, Note[]>();
  for (const n of currentNotes) for (const id of noteOnIds(store, n)) { if (!notesOn.has(id)) notesOn.set(id, []); notesOn.get(id)!.push(n); }
  const marksOn = new Map<string, { kind: string; clue: string }[]>();
  for (const m of store.marks.filter((x) => !x.closed)) { if (!marksOn.has(m.targetId)) marksOn.set(m.targetId, []); marksOn.get(m.targetId)!.push({ kind: m.kind, clue: m.clue }); }
  const recent = recentChanges(store);
  const recentIds = recentlyChanged(recent, relations);
  const changedAt = new Map<string, string>();
  for (const c of store.changes.all()) for (const id of c.affects) if ((changedAt.get(id) ?? '') < c.at) changedAt.set(id, c.at);
  for (const r of relations) if (r.type === 'replaces') { const at = changedAt.get(r.from) ?? changedAt.get(r.to); if (at) { if ((changedAt.get(r.from) ?? '') < at) changedAt.set(r.from, at); if ((changedAt.get(r.to) ?? '') < at) changedAt.set(r.to, at); } }
  const hasWork = nodes.some((n) => n.category === 'Work item');
  // `Update pending` (§1.11): a work item, an area — its own item or the work its understanding is made of — or any other
  // product reference item that a change waiting for the next round affects (keeper/organize/update-pending.ts).
  const pendingThreads = new Set(store.threads.filter((t) => (t.pendingSourceIds ?? []).length > 0).map((t) => t.id));
  const pendingAreas = new Set(store.areas.filter((a) => (a.pendingSourceIds ?? []).length > 0).map((a) => a.referenceId));
  const pendingRefs = new Set(store.reference.filter((r) => (r.pendingSourceIds ?? []).length > 0).map((r) => r.id));
  const workOf = (n: GraphNode): string | null => {
    // sessions, runs, results and reviews fold under the work item they relate to
    for (const r of [...(out.get(n.id) ?? []), ...(inc.get(n.id) ?? [])]) {
      const other = r.from === n.id ? r.to : r.from;
      if (byId.get(other)?.category === 'Work item') return other;
    }
    return null;
  };
  const FOLDABLE = new Set(['Session', 'Run', 'Result', 'Review', 'Test']);
  const viewNodes: ViewNode[] = nodes.map((n) => {
    const notes = notesOn.get(n.id) ?? [];
    const ask = notes.map((x) => latest(x).ask).sort((a, b) => (ASK_ORDER[b] ?? 0) - (ASK_ORDER[a] ?? 0))[0] ?? null;
    const outs = out.get(n.id) ?? [];
    const ins = inc.get(n.id) ?? [];
    let noLink = false;
    if (hasWork && n.validity === 'Current') {
      if (n.category === 'Work item' && n.progress === 'In progress' && !outs.some((r) => r.type === 'serves' || r.type === 'implements' || r.type === 'refines')) noLink = true;
      if ((n.category === 'Goal' || n.category === 'Area') && !ins.some((r) => r.type === 'serves' || r.type === 'refines' || r.type === 'implements') && !outs.some((r) => r.type === 'refines')) noLink = true;
    }
    let group: ViewNode['group'] = null;
    const parentWork = FOLDABLE.has(n.category) ? workOf(n) : null;
    if (n.category === OWNER_WORDS) group = OWNER_WORDS_GROUP;
    if (n.category === 'Work item' && n.validity === 'Current' && n.progress === 'Done' && !recentIds.has(n.id) && notes.length === 0) group = 'Existing foundation';
    if (FOLDABLE.has(n.category) && !parentWork && !ins.length && !outs.length) group = 'Unplaced';
    if (FOLDABLE.has(n.category) && !parentWork && (ins.length || outs.length) && ![...ins, ...outs].some((r) => { const o = byId.get(r.from === n.id ? r.to : r.from); return o && (o.category === 'Area' || o.category === 'Goal' || o.category === 'Work item'); })) group = 'Unplaced';
    const updatePending = (n.refKind === 'thread' && pendingThreads.has(n.refId)) || (n.refKind === 'reference' && (pendingRefs.has(n.refId) || (n.category === 'Area' && pendingAreas.has(n.refId))));
    const summary = n.refKind === 'reference' ? (store.reference.get(n.refId)?.text ?? null) : n.refKind === 'thread' ? (store.threads.get(n.refId)?.doing ?? null) : n.refKind === 'change' ? (store.changes.get(n.refId)?.summary ?? null) : null;
    return { ...n, ...placementFields(store, n), noteCount: notes.length, noteAttention: notes.filter(inAttention).length, noteAsk: ask, marks: marksOn.get(n.id) ?? [], updatePending, noEstablishedLink: noLink, group, recentChange: recentIds.has(n.id), changedAt: changedAt.get(n.id) ?? null, parentId: n.category === 'Work item' ? n.areaId : parentWork ?? n.parentWorkId, summary: summary ? summary.slice(0, 240) : null };
  });
  const relationNotes = new Map<string, { all: number; attention: number }>();
  for (const [id, list] of notesOn) if (store.relations.has(id)) relationNotes.set(id, { all: list.length, attention: list.filter(inAttention).length });
  // The project's rules are not on the graph (R-50; CKC-21 AC-12), and neither is what hangs on them: a mark on a rule
  // is shown with the rule in Project scope. A mark on a removed object goes with it.
  const graphMarks = store.marks.filter((m) => !m.closed && !store.rules.has(m.targetId) && !removed.has(m.targetId));
  return {
    nodes: viewNodes,
    relations: relations.map((r) => ({ ...r, noteCount: relationNotes.get(r.id)?.all ?? 0, noteAttention: relationNotes.get(r.id)?.attention ?? 0 })),
    // The earlier generations (Spec §2.12, D85, D100), for the story map's rolled bands above the current plan: their
    // plans and work items as the Keeper recorded them; where each item went is read off the relations (ui/placement.js).
    // CZ: `carriedIds` are the items carried on under the same number — current work, placed in its current plan.
    generations: generationsView(store),
    marks: graphMarks,
    recentChangeIds: recent.map((c) => c.id),
    changes: store.changes.all().map((c) => ({ id: c.id, at: c.at, title: c.title, effect: c.effect, affects: c.affects, propagation: c.propagation })),
    categories: [...new Set(nodes.map((n) => n.category))],
    relationTypes: [...new Set(relations.map((r) => r.type))],
    markKinds: [...new Set(graphMarks.map((m) => m.kind))],
    counts: { existingFoundation: viewNodes.filter((n) => n.group === 'Existing foundation').length, unplaced: viewNodes.filter((n) => n.group === 'Unplaced').length, replacedOrDeferred: viewNodes.filter((n) => n.validity === 'Replaced' || n.validity === 'Deferred' || n.validity === 'Abandoned').length },
  };
}

/** Where a note came from (Spec §4.1), with the changes a follow-up note is about named by their titles. */
export function cameFromView(store: ProjectStore, n: Note) {
  const c = n.cameFrom;
  if (!c) return null;
  return { kind: c.kind, jobKind: c.jobKind, changes: c.changeIds.map((id) => ({ id, title: store.changes.get(id)?.title ?? id })) };
}

/**
 * What a row of the bottom strip is about (Spec §6.2: mark · one sentence · object · time), named, so the page neither
 * shows a bare id nor asks for each object in turn. A note's mount: the objects it hangs on, a relation written as its
 * type and its two ends; `project` hangs on nothing. What is not a note says where it belongs in the same slot.
 */
export interface RowObject { readonly kind: NoteMount['kind'] | 'scope' | 'request' | 'round'; readonly objects: readonly { readonly id: string; readonly kind: 'node' | 'relation'; readonly label: string }[] }
export function mountView(store: ProjectStore, mount: NoteMount): RowObject {
  // A note on the whole project hangs on nothing, even when ids were filled in with the project id.
  if (mount.kind === 'project') return { kind: 'project', objects: [] };
  const nodeLabel = (id: string): string | null => store.nodes.get(id)?.label ?? store.reference.get(id)?.name ?? store.threads.get(id)?.title ?? null;
  const objects: { id: string; kind: 'node' | 'relation'; label: string }[] = [];
  for (const id of mount.ids) {
    if (mount.kind === 'relation') {
      const rel = store.relations.get(id);
      if (!rel) continue; // an id the project does not have is not listed, and is not shown as itself
      const from = nodeLabel(rel.from);
      const to = nodeLabel(rel.to);
      objects.push({ id, kind: 'relation', label: `${rel.type}: ${from ?? '…'} → ${to ?? '…'}` });
      continue;
    }
    const label = nodeLabel(id);
    if (!label) continue;
    objects.push({ id, kind: 'node', label });
  }
  return { kind: mount.kind, objects };
}

function noteRow(store: ProjectStore, n: Note) {
  const v = latest(n);
  return { id: n.id, title: v.title, preview: v.preview, ask: v.ask, mount: n.mount, status: n.status, ownerResponse: n.ownerResponse, updatedAt: n.updatedAt, version: v.version, cameFrom: cameFromView(store, n) };
}

/**
 * Where a piece of a Follow up round's news is, as one of the jumps the workbench already has (§3.8: "各带位置"; CKC-07
 * AC-27, CKC-24 AC-15): the object in the process view (a work item, a plan or a document on the Project graph), a
 * territory in `Code`, the note, the semantic patch. `label` names the destination for the page's selection. Null when
 * what it hangs on is not on the workbench (any more): the entry is still listed, with its position, and has no jump.
 */
export interface NewsGo { readonly to: 'process' | 'code' | 'note' | 'patch'; readonly id: string; readonly label: string }
export type NewsItemView = RoundNewsItem & { readonly go: NewsGo | null };
/** A round's news as `Notes (attention)` carries it: the program's count (round-news.ts), each entry with its jump. */
export type RoundNewsView = Omit<RoundNews, 'breakpoints' | 'sendbacks' | 'sixThings' | 'patches' | 'notes'> & {
  readonly breakpoints: readonly NewsItemView[];
  readonly sendbacks: readonly NewsItemView[];
  readonly sixThings: readonly NewsItemView[];
  readonly patches: readonly NewsItemView[];
  readonly notes: readonly NewsItemView[];
};

/**
 * The jump of one news entry, by what it is: a patch opens itself; a note (written or updated, or a note that became one
 * of the six things) opens itself; anything else goes to the object it hangs on — a code territory in `Code`, any other
 * object drawn on the Project graph in the process view.
 */
function newsGo(store: ProjectStore, kind: 'breakpoints' | 'sendbacks' | 'sixThings' | 'patches' | 'notes', item: RoundNewsItem): NewsGo | null {
  if (kind === 'patches') { const p = store.patches.get(item.id); return p ? { to: 'patch', id: p.id, label: `${p.number} ${p.title}` } : null; }
  const note = kind === 'notes' || kind === 'sixThings' ? store.notes.get(item.id) : undefined;
  if (note) return { to: 'note', id: note.id, label: latest(note).title };
  const id = item.objectId;
  if (!id) return null;
  const territory = store.territories.get(id);
  if (territory) return { to: 'code', id, label: territory.name };
  const node = store.nodes.get(id);
  return node && node.validity !== 'Removed' && !isRemoved(store, node.refId) ? { to: 'process', id, label: node.label } : null;
}

function newsView(store: ProjectStore, news: RoundNews): RoundNewsView {
  const withGo = (kind: 'breakpoints' | 'sendbacks' | 'sixThings' | 'patches' | 'notes') => news[kind].map((i) => ({ ...i, go: newsGo(store, kind, i) }));
  return { ...news, breakpoints: withGo('breakpoints'), sendbacks: withGo('sendbacks'), sixThings: withGo('sixThings'), patches: withGo('patches'), notes: withGo('notes') };
}

/** The news of a Follow up round as lines a person reads, each thing with its position (§3.8: "各带位置"). */
function newsLines(news: RoundNews): string[] {
  const section = (title: string, items: readonly RoundNewsItem[]) => (items.length ? [`${title} (${items.length}):`, ...items.map((i) => `- ${i.label} — ${i.position}${i.detail ? ` (${i.detail})` : ''}`)] : []);
  return [
    ...section('Breakpoints newly lit', news.breakpoints),
    ...section('Send-backs new or moved', news.sendbacks),
    ...section('Newly among the six things', news.sixThings),
    ...section('Semantic patches confirmed', news.patches),
    ...section('Notes written or updated', news.notes),
  ];
}

/**
 * A Follow up round by the name the workbench gives it (§6.2, §6.9): its number among all rounds — the clerk round it
 * closed with — or, for a round from before the clerk's rounds, the record's own number.
 */
export function roundName(store: ProjectStore, recordId: string): string {
  const clerk = store.clerkRounds.find((c) => c.followUpRoundId === recordId);
  return `Follow up round ${clerk?.number ?? store.rounds.get(recordId)?.number ?? roundNumberOf(recordId)}`;
}

/** One row of the bottom strip (Spec §6.2): what `Notes (attention)` lists, and a round of `Since last visit` too. */
export interface StripItem {
  readonly kind: string;
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly ask: string | null;
  readonly at: string | null;
  readonly object: RowObject;
  readonly cameFrom?: ReturnType<typeof cameFromView>;
  /** A Follow up result: its news with each entry's jump, its name, and how many objects its judgements left behind. */
  readonly news?: RoundNewsView;
  readonly roundName?: string;
  readonly behind?: number;
  readonly unassigned?: number;
  /** A Follow up result: the summary after its name — what it made new, that it found nothing new, or what it left behind. */
  readonly line?: string;
  /** A Follow up result the owner has already opened. */
  readonly seen?: boolean;
}

/**
 * A Follow up round's result as one row (§3.8, §5.5, §6.2; D79; CKC-07 AC-27, CKC-24 AC-15): its name and, in one line,
 * what it made new — breakpoints newly lit, send-backs new or moved, what newly became one of the six things, semantic
 * patches confirmed, notes written or updated, each with its position and its jump — or that it found nothing new, and
 * the objects its judgements left on the old understanding (§5.5). A result closed before rounds counted their news says
 * what it left behind, or how many objects it judged. The same row stands in `Notes (attention)` until the owner has
 * opened it, and in `Since last visit` for every round since their last visit.
 */
function roundItem(store: ProjectStore, r: FollowUpRound): StripItem {
  const result = r.result!;
  const behind = result.counts.behind;
  const unassigned = result.unassigned.length;
  const name = roundName(store, r.id);
  const line = roundLine(result);
  const base = { kind: 'round', id: r.id, label: `${name}: ${line}`, line, ask: 'For information', at: r.endedAt, roundName: name, behind, unassigned, seen: Boolean(r.seenAt) };
  const news = result.news ?? null;
  if (!news) return { ...base, detail: result.summary, object: { kind: 'round', objects: [] } };
  const lines = [...newsLines(news), ...(behind ? [`${behind} object${behind === 1 ? '' : 's'} still on the old understanding${unassigned ? `, ${unassigned} with no holder` : ''}: the round's result names them.`] : [])];
  const located = new Map<string, string>();
  for (const i of [...news.breakpoints, ...news.sendbacks, ...news.sixThings, ...news.patches, ...news.notes]) {
    if (!i.objectId || located.has(i.objectId)) continue;
    const label = store.nodes.get(i.objectId)?.label ?? store.reference.get(i.objectId)?.name ?? store.threads.get(i.objectId)?.title ?? store.territories.get(i.objectId)?.name ?? null;
    if (label) located.set(i.objectId, label);
  }
  return { ...base, detail: lines.join('\n'), object: { kind: 'round', objects: [...located].map(([id, label]) => ({ id, kind: 'node' as const, label })) }, news: newsView(store, news) };
}

/** A round's result in one line, after its name: what it made new, or that it found nothing new; counted before rounds
 *  counted news, what it left on the old understanding — or how many objects it judged. */
function roundLine(result: RoundResult): string {
  const news = result.news ?? null;
  if (news) return news.nothingNew ? 'found nothing new' : news.statement;
  const { behind, objectsJudged } = result.counts;
  const unassigned = result.unassigned.length;
  return [behind ? `${behind} object${behind === 1 ? '' : 's'} still on the old understanding` : `${objectsJudged} object${objectsJudged === 1 ? '' : 's'} judged`, unassigned ? `${unassigned} with no holder` : ''].filter(Boolean).join(', ');
}

/** Whether a round's result is something new to the owner: news, or — counted before rounds counted news — objects left behind. */
const roundHasNews = (x: StripItem) => (x.news ? !x.news.nothingNew : (x.behind ?? 0) > 0 || (x.unassigned ?? 0) > 0);

/** The Follow up rounds that have their result, in the order they ended. */
const finishedRounds = (store: ProjectStore) => store.rounds.filter((r) => r.endedAt !== null && r.result !== null).sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? '') || a.number - b.number);

export function needsYou(store: ProjectStore, project: Project) {
  // A Follow up result carries its news with each entry's jump, and how many objects its judgements left behind (§5.5),
  // so the page lists them by category without reading the lines of `detail` back.
  const items: StripItem[] = [];
  for (const n of store.notes.filter((x) => x.status === 'Current')) {
    const v = latest(n);
    if (inAttention(n)) items.push({ kind: 'note', id: n.id, label: v.title, detail: v.preview, ask: v.ask, at: n.updatedAt, object: mountView(store, n.mount), cameFrom: cameFromView(store, n) });
  }
  for (const q of project.scopeQuestions.filter((x) => !x.answer)) items.push({ kind: 'scope-question', id: q.id, label: q.question, detail: q.whyItMatters, ask: 'For your decision', at: null, object: { kind: 'scope', objects: [] } });
  for (const j of store.jobs.filter((x) => x.kind === 'Your request' && x.status === 'Done' && !(x.task as { seen?: boolean } | null)?.seen)) items.push({ kind: 'job', id: j.id, label: `Done: ${j.scope.label}`, detail: (j.resultText ?? '').slice(0, 200), ask: 'For information', at: j.endedAt, object: { kind: 'request', objects: [] } });
  // One item per Follow up round, not one per object (D56 item 3), and it leaves once the owner has opened it: Follow up
  // is how the owner sees what is new (§3.8, §6.2; D79). A round that found nothing new has no item here — the top bar
  // says so (`coverage.lastFollowUp`) — and neither has a result from before rounds counted their news that left no
  // object behind. Once opened, a result stays reachable: in `Since last visit`, and in the Keeper view's rounds (§6.9).
  for (const r of finishedRounds(store)) {
    if (r.seenAt) continue;
    const item = roundItem(store, r);
    if (roundHasNews(item)) items.push(item);
  }
  return items;
}

function propagationSummary(c: ChangeRecord) {
  const counts: Record<string, number> = {};
  for (const p of c.propagation) counts[p.state] = (counts[p.state] ?? 0) + 1;
  return counts;
}

export function changeRow(store: ProjectStore, c: ChangeRecord) {
  const labelOf = (id: string) => store.nodes.get(id)?.label ?? store.reference.get(id)?.name ?? store.threads.get(id)?.title ?? id;
  // Every object a record reached is named, not only the ones it changed: a reader given a bare id has to look each
  // one up, and Spec §7.10 asks for the other end's name with its id (batch C, 2026-09-20). One that has since been
  // removed from the project's current version is flagged, so it is struck through: the changes are the only place it
  // still appears (§2.1, §6.3; CKC-09 AC-32).
  const named = (id: string) => ({ id, label: labelOf(id), removed: isRemoved(store, id) });
  const touched = [...new Set([...c.affects, ...(c.items ?? []).flatMap((i) => i.affects), ...(c.notJudged ?? []).map((n) => n.nodeId), ...c.propagation.map((p) => p.nodeId)])];
  return {
    ...c,
    affectsLabels: c.affects.map(named), propagationLabels: c.propagation.map((p) => named(p.nodeId)), notJudgedLabels: (c.notJudged ?? []).map((n) => named(n.nodeId)),
    removed: touched.filter((id) => isRemoved(store, id)).map((id) => ({ id, label: labelOf(id) })),
    propagationSummary: propagationSummary(c), sources: c.sourceIds.map((id) => { const s = store.sources.get(id); return { id, label: s ? anchorLabel(s.anchor) : id, title: s?.title ?? id }; }),
  };
}

export function overview(store: ProjectStore, project: Project, since: string | null, selectionId: string | null) {
  const current = store.notes.filter((n) => n.status === 'Current');
  // With nothing selected the default view lists every current note, not only the project-level ones: the owner has
  // to see everything still open without clicking object by object to find it (D49). A selection narrows it to that
  // object. Notes that ask something are listed in `Notes (attention)` in the default view.
  const related = selectionId ? current.filter((n) => n.mount.ids.includes(selectionId)) : current;
  const relook = store.judgements.size > 0;
  const recent = recentChanges(store).map((c) => changeRow(store, c));
  let sinceLastVisit: null | { since: string; rounds: StripItem[]; threads: { id: string; title: string; progress: string; updatedAt: string }[]; changes: { id: string; title: string; effect: string; at: string }[]; notes: { id: string; title: string; ask: string; at: string; object: RowObject }[]; jobs: number; failed: number } = null;
  if (since) {
    // Every Follow up round that ended since the last visit, each summed up in one line as `Notes (attention)` gives it —
    // what it made new, or that it found nothing new — whether or not the owner has opened it since (§3.8, §5.5).
    const rounds = finishedRounds(store).filter((r) => (r.endedAt ?? '') > since).map((r) => roundItem(store, r));
    // A removed work item appears only through the change that removed it (§2.1), not as work that moved on.
    const threads = store.threads.filter((t) => t.updatedAt > since && t.validity !== 'Removed').map((t) => ({ id: t.id, title: t.title, progress: t.progress, updatedAt: t.updatedAt })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12);
    const changes = store.changes.filter((c) => c.updatedAt > since).sort((a, b) => a.at.localeCompare(b.at)).map((c) => ({ id: c.id, title: c.title, effect: c.effect, at: c.at })).slice(0, 12);
    const notes = current.filter((n) => n.updatedAt > since).map((n) => ({ id: n.id, title: latest(n).title, ask: latest(n).ask, at: n.updatedAt, object: mountView(store, n.mount) })).slice(0, 12);
    const jobs = store.jobs.filter((j) => j.status === 'Done' && (j.endedAt ?? '') > since).length;
    const failed = store.jobs.filter((j) => j.status === 'Failed' && (j.endedAt ?? '') > since).length;
    // Rounds that found nothing new are summed up with the rest, but alone they are no meaningful change: then there is
    // no summary at all, and the top bar says the last round found nothing new (§3.8, §6.2).
    if (threads.length || changes.length || notes.length || rounds.some(roundHasNews)) sinceLastVisit = { since, rounds, threads, changes, notes, jobs, failed };
  }
  // How the current notes divide up, so the default view can say why fewer are waiting than exist (owner D50).
  const asking = current.filter((n) => latest(n).ask !== 'For information');
  const noteCounts = {
    current: current.length,
    asking: asking.length,
    information: current.length - asking.length,
    answered: asking.length - needsYou(store, project).filter((x) => x.kind === 'note').length,
  };
  const row = (n: Note) => noteRow(store, n);
  return { notes: related.map(row), noteCounts, relookDone: relook, needsYou: needsYou(store, project), recentChanges: recent, sinceLastVisit, projectNote: current.filter((n) => n.mount.kind === 'project').map(row)[0] ?? null, roundResults: roundResults(store) };
}

/**
 * Every Follow up round that has its result, in the order they ended: its name, the clerk round it closed with and its
 * one-line summary. The Keeper view's rounds open their results by these (§6.9: a finished Follow up round opens its
 * result), so a result stays reachable after the owner has opened it once and it left `Notes (attention)`.
 */
export function roundResults(store: ProjectStore): { readonly id: string; readonly name: string; readonly clerkRoundId: string | null; readonly at: string; readonly line: string; readonly seen: boolean }[] {
  return finishedRounds(store).map((r) => ({
    id: r.id, name: roundName(store, r.id), clerkRoundId: store.clerkRounds.find((c) => c.followUpRoundId === r.id)?.id ?? null,
    at: r.endedAt!, line: roundLine(r.result!), seen: Boolean(r.seenAt),
  }));
}

/** The excerpt goes whole. It used to be cut at 400 characters, which left `pk get` a half sentence it was not allowed
 *  to print (CKC-12 AC-31), so the reader got only an id where the original was right there (batch C, 2026-09-20). */
function sourceRef(store: ProjectStore, id: string) {
  const s = store.sources.get(id);
  return s ? { id, title: s.title, label: anchorLabel(s.anchor), excerpt: s.excerpt, usedAs: s.usedAs, availability: s.availability } : { id, title: id, label: id, excerpt: '', usedAs: null, availability: null };
}

/**
 * A fact record's statements say who claimed what and when; `checks` says what was found when the material they rest
 * on was checked against the code (§2.4, §6.4; CKC-09 AC-33).
 */
export function factDetail(store: ProjectStore, id: string) {
  const f = store.facts.get(id);
  if (!f) return null;
  const materials = [...new Set([...f.aboutSourceIds, ...claimMaterials([...f.statements, ...f.executionFacts])])];
  return { ...f, statements: f.statements.map((s) => statementView(store, s)), executionFacts: f.executionFacts.map((s) => statementView(store, s)), checks: checksOn(store, materials), sources: f.aboutSourceIds.map((s) => sourceRef(store, s)), trace: store.traceFor('facts', f.id, 20) };
}

export function threadDetail(store: ProjectStore, id: string) {
  const t = store.threads.get(id);
  if (!t) return null;
  return { ...t, executionFacts: t.executionFacts.map((s) => statementView(store, s)), qcFacts: t.qcFacts.map((s) => statementView(store, s)), checks: checksOn(store, claimMaterials([...t.executionFacts, ...t.qcFacts])), facts: t.factRecordIds.map((f) => { const x = store.facts.get(f); return x ? { id: x.id, title: x.title, statements: x.statements.length, open: x.openQuestions.length, asOf: x.asOf } : { id: f, title: f, statements: 0, open: 0, asOf: null }; }), servesLabels: t.serves.map((s) => ({ ...s, name: store.reference.get(s.referenceId)?.name ?? s.referenceId })), trace: store.traceFor('threads', t.id, 20) };
}

/**
 * When what an entry waits for will be taken in (§3.8; §7.1: `Update pending` says it): at the next Follow up at the
 * project's rhythm, after the current stretch of work when it organizes continuously, as it goes during the takeover.
 */
export function pendingWhen(store: ProjectStore, project: Project): string {
  const takingOver = store.coverage.takeover ? store.coverage.takeover.stage !== 'Daily' : false;
  return takingOver ? 'as the takeover goes on' : scheduleOf(project).frequency === 'Continuous' ? 'after the current stretch of work' : 'at the next Follow up (on the owner’s schedule, or earlier when the owner starts one)';
}

/**
 * `Update pending` on one object (§1.11, §6.4, §7.1): the changes it waits for — the coverage's own entries, each with the
 * parts of it that reach the object (source ids to read now) and how — and when they will be taken in. An area's are its
 * own item's and those of the work its understanding is made of.
 */
function pendingOf(store: ProjectStore, project: Project, waits: readonly (readonly PendingWait[] | undefined)[], ids: readonly (readonly string[] | undefined)[]) {
  const byRef = new Map<string, PendingWait>();
  for (const w of waits.flatMap((x) => x ?? [])) {
    const had = byRef.get(w.ref);
    byRef.set(w.ref, had ? { ...had, sourceIds: [...new Set([...had.sourceIds, ...w.sourceIds])], reasons: [...new Map([...had.reasons, ...w.reasons].map((r) => [`${r.link}|${r.detail}`, r])).values()] } : w);
  }
  const sourceIds = [...new Set(ids.flatMap((x) => x ?? []))];
  const waitsFor = [...byRef.values()].sort((a, b) => a.since.localeCompare(b.since) || a.label.localeCompare(b.label));
  return { updatePending: sourceIds.length > 0 || waitsFor.length > 0, pendingSourceIds: sourceIds, waitsFor, pendingWhen: sourceIds.length || waitsFor.length ? pendingWhen(store, project) : null };
}

// ───────────────────────── an object's propagation state (§2.10, §5.5, §6.4) ─────────────────────────

/** A change record as an object's propagation names it: its title, its piece of work, its effect, and when. */
export interface ChangeRef { readonly id: string; readonly title: string; readonly work: string | null; readonly effect: ChangeEffect; readonly at: string }
const changeRef = (c: ChangeRecord): ChangeRef => ({ id: c.id, title: c.title, work: c.work?.label ?? null, effect: c.effect, at: c.at });

/** One item an object still lacks (§2.10: "还差哪几项、各差什么"), with the change it comes from. */
export interface LackView {
  readonly changeId: string;
  readonly itemId: string;
  /** What the object still has to follow, in the judgement's words; empty when the judgement did not say. */
  readonly what: string;
  /** The record it comes from; null when that record is no longer in the assets. */
  readonly change: ChangeRef | null;
  /** The item of that record it lacks; null when the record reads as one item (written before records had items). */
  readonly item: { readonly title: string; readonly effect: ChangeEffect; readonly at: string } | null;
}

/**
 * An object's propagation as its details show it (Spec §5.5: its current state, which records it covers, which items it
 * still lacks; §2.10; QC AH #6): the state its latest round gave it, with the round, when and why; what it still lacks,
 * item by item, each with the change it comes from; the records that state covers; and the records that reached it
 * since and wait for the next Follow up.
 */
export interface PropagationView {
  readonly state: Propagation;
  /** The Follow up round whose one judgement gave the state, and whether it has ended (its result opens then); null when
   *  no round has judged the object — the state is then what the per-change entries say. */
  readonly round: { readonly id: string; readonly name: string; readonly ended: boolean } | null;
  readonly at: string | null;
  readonly reason: string;
  /** The object changed after it was judged: the next Follow up judges again what it still lacks (§5.5, §2.10). */
  readonly movedSince: boolean;
  readonly lacks: readonly LackView[];
  /** The records the state covers, each with how many of its items, and where the object stands on that record. */
  readonly covers: readonly { readonly change: ChangeRef; readonly items: number; readonly state: Propagation; readonly reason: string }[];
  /** Records whose items reached it and have not been judged yet: they wait for the next Follow up. */
  readonly waiting: readonly ChangeRef[];
}

/**
 * The reading is the one the context pack makes (context/assemble.ts `behindOn`), so the owner and an agent are told the
 * same: the object's latest judgement — rounds ordered by number, never as strings — carries every lack still open, since
 * each round judges what reached the object together with what it still lacked (§2.10, §5.5). An object no round has
 * judged has only the per-change entries, which say how it stood against each record. Null for what is never judged — a
 * point-in-time record or a decision (§2.10) — and for an object no change has reached.
 */
export function propagationOf(store: ProjectStore, nodeId: string): PropagationView | null {
  if (notJudgedReason(store, nodeId) !== null) return null;
  const latest = store.propagation.filter((j) => j.nodeId === nodeId).sort((a, b) => roundNumberOf(b.roundId) - roundNumberOf(a.roundId))[0] ?? null;
  const entries = store.changes.all().flatMap((change) => change.propagation.filter((p) => p.nodeId === nodeId).map((entry) => ({ change, entry })));
  if (!latest && entries.length === 0) return null;
  const covered = (changeId: string, itemId: string) => latest?.covers.some((c) => c.changeId === changeId && (c.itemId === itemId || c.itemId === '')) ?? false;
  // An entry is `Not yet checked` when it is new, or when an item reached the object after its judgement (graph.ts
  // `seedPropagation`): what it carries that the latest judgement did not cover waits for the next round.
  const waiting = entries
    .filter(({ change, entry }) => entry.state === 'Not yet checked' && (entry.itemIds ?? itemsOf(change).map((i) => i.id)).some((itemId) => !covered(change.id, itemId)))
    .map(({ change }) => changeRef(change)).sort((a, b) => a.at.localeCompare(b.at));
  const lackOf = (l: LackedItem): LackView => {
    const change = store.changes.get(l.changeId);
    const item = change && l.itemId ? itemsOf(change).find((i) => i.id === l.itemId) ?? null : null;
    return { changeId: l.changeId, itemId: l.itemId, what: l.what, change: change ? changeRef(change) : null, item: item ? { title: item.title, effect: item.effect, at: item.at } : null };
  };
  const inOrder = (a: LackView, b: LackView) => (a.item?.at ?? a.change?.at ?? '').localeCompare(b.item?.at ?? b.change?.at ?? '');
  if (latest) {
    // Only `Still on old understanding` lacks anything: judging it names the lacked items, and the program keeps that state
    // while any is left (adjustment.ts `judgeObject`).
    const lacks = latest.state === 'Still on old understanding' ? latest.lacks.map(lackOf).sort(inOrder) : [];
    const lacking = new Set(lacks.map((l) => l.changeId));
    const items = new Map<string, number>();
    for (const c of latest.covers) items.set(c.changeId, (items.get(c.changeId) ?? 0) + 1);
    // Where it stands on each record follows from the one judgement, as the record's own entry does.
    const covers = [...items].flatMap(([changeId, n]) => {
      const change = store.changes.get(changeId);
      if (!change) return [];
      const state: Propagation = latest.state === 'Still on old understanding' && !lacking.has(changeId) ? 'Updated' : latest.state;
      return [{ change: changeRef(change), items: n, state, reason: '' }];
    }).sort((a, b) => a.change.at.localeCompare(b.change.at));
    const record = store.rounds.get(latest.roundId);
    return {
      state: latest.state, round: { id: latest.roundId, name: roundName(store, latest.roundId), ended: Boolean(record?.endedAt && record.result) },
      at: latest.at, reason: latest.sourceOrReason, movedSince: objectUpdatedAt(store, nodeId) > latest.objectUpdatedAt,
      lacks, covers, waiting,
    };
  }
  const judged = entries.filter(({ entry }) => entry.state !== 'Not yet checked').sort((a, b) => a.change.at.localeCompare(b.change.at));
  const lacks = judged.filter(({ entry }) => entry.state === 'Still on old understanding').map(({ change, entry }) => lackOf({ changeId: change.id, itemId: '', what: entry.sourceOrReason }));
  const last = [...judged].sort((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt))[0] ?? null;
  const state: Propagation = lacks.length ? 'Still on old understanding' : waiting.length || !last ? 'Not yet checked' : last.entry.state;
  return {
    state, round: null, at: last?.entry.updatedAt ?? null, reason: '', movedSince: false, lacks,
    covers: judged.map(({ change, entry }) => ({ change: changeRef(change), items: entry.itemIds?.length ?? itemsOf(change).length, state: entry.state, reason: entry.sourceOrReason })),
    waiting,
  };
}

export function nodeDetail(store: ProjectStore, project: Project, id: string) {
  const node = store.nodes.get(id);
  if (!node) return null;
  const relations = store.relations.filter((r) => r.from === id || r.to === id).map((r) => ({ ...r, fromLabel: store.nodes.get(r.from)?.label ?? r.from, toLabel: store.nodes.get(r.to)?.label ?? r.to }));
  const notes = store.notes.filter((n) => n.status === 'Current' && n.mount.ids.includes(id)).map((n) => noteRow(store, n));
  const changes = store.changes.filter((c) => c.affects.includes(id)).sort((a, b) => a.at.localeCompare(b.at)).map((c) => changeRow(store, c));
  const marks = store.marks.filter((m) => m.targetId === id && !m.closed);
  // Its propagation (§5.5, §6.4): its state, the records that state covers, and what it still lacks, item by item.
  const propagation = propagationOf(store, id);
  const base = { node, relations, notes, changes, marks, propagation, sources: node.sourceIds.map((s) => sourceRef(store, s)), trace: store.traceFor(node.refKind === 'reference' ? 'reference' : node.refKind === 'thread' ? 'threads' : node.refKind === 'change' ? 'changes' : 'sources', node.refId, 20) };
  const none = { updatePending: false, pendingSourceIds: [] as string[], waitsFor: [] as PendingWait[], pendingWhen: null };
  if (node.refKind === 'reference') {
    const item = store.reference.get(node.refId);
    const area = item?.category === 'Area' ? store.areas.find((a) => a.referenceId === item.id) : undefined;
    const threads = area ? area.contributions.map((c) => ({ ...c, thread: threadDetail(store, c.threadId) })) : [];
    // The authority layer and, for a decision that asks for something, its carry-out (§1.9, §2.2, §6.4; CKC-09 AC-33).
    return { ...base, reference: item ?? null, area: area ?? null, contributions: threads, authority: authorityOf(store, node.refId), carryOut: carryOutOf(store, node.refId), ...pendingOf(store, project, [item?.waitsFor, area?.waitsFor], [item?.pendingSourceIds, area?.pendingSourceIds]) };
  }
  if (node.refKind === 'thread') { const t = store.threads.get(node.refId); return { ...base, thread: threadDetail(store, node.refId), ...pendingOf(store, project, [t?.waitsFor], [t?.pendingSourceIds]) }; }
  if (node.refKind === 'change') return { ...base, change: store.changes.get(node.refId) ? changeRow(store, store.changes.get(node.refId)!) : null, ...none };
  return { ...base, ...none };
}

export function relationDetail(store: ProjectStore, id: string) {
  const r = store.relations.get(id);
  if (!r) return null;
  return {
    ...r, fromLabel: store.nodes.get(r.from)?.label ?? r.from, toLabel: store.nodes.get(r.to)?.label ?? r.to,
    evidenceSources: r.evidence.sourceIds.map((s) => sourceRef(store, s)),
    evidenceFacts: r.evidence.factRecordIds.map((f) => ({ id: f, title: store.facts.get(f)?.title ?? f })),
    notes: store.notes.filter((n) => n.status === 'Current' && n.mount.ids.includes(id)).map((n) => noteRow(store, n)),
    trace: store.traceFor('relations', r.id, 20),
  };
}
