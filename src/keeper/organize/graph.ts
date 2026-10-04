/**
 * Graph derivation (Spec §1.5, §1.6): nodes are the project's own objects already in the assets;
 * relations come from the claims the assets carry (serves, refines, depends on, replaces, affects)
 * plus relations the Keeper wrote directly. Derivation is deterministic and keeps existing
 * assessments; nothing here calls a model.
 */
import type { ChangeRecord, GraphNode, GraphRelation, Project, PropagationEntry, ReferenceItem, Source, WorkThread } from '../../model/types.ts';
import type { NodeCategory } from '../../model/vocab.ts';
import { stableId } from '../../model/ids.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { anchorLabel } from '../../sources/anchor.ts';
import { downstreamOfChange } from '../adjustment.ts';
import { isNumberOnly } from './entries.ts';

const now = () => new Date().toISOString();

function referenceCategory(item: ReferenceItem): NodeCategory {
  return item.category === 'Boundary' ? 'Decision' : item.category;
}

function sourceCategory(source: Source): NodeCategory {
  switch (source.anchor.kind) {
    case 'session': return 'Session';
    case 'command': return 'Run';
    default:
      // What the material is used as decides the observed-reality category (§1.5): a QC or review report, a test, or a result.
      if (source.usedAs === 'QC') return 'Review';
      if (source.usedAs === 'Test') return 'Test';
      return 'Result';
  }
}

/** The Area an item belongs to: itself, or the first Area reached through `refines`. */
export function areaOf(store: ProjectStore, referenceId: string, depth = 0): string | null {
  const item = store.reference.get(referenceId);
  if (!item || depth > 6) return null;
  if (item.category === 'Area') return item.id;
  for (const up of item.refines) { const a = areaOf(store, up, depth + 1); if (a) return a; }
  return null;
}

export function threadArea(store: ProjectStore, thread: WorkThread): string | null {
  for (const s of thread.serves) { const a = areaOf(store, s.referenceId); if (a) return a; }
  return null;
}

/**
 * What an item is called on the workbench (CJ): its name; a name that is the number alone (`D1`, written before the writers
 * refused it) shows the first sentence of its text after the number, so the List and the Graph read as the document does.
 */
export function displayName(name: string, text: string): string {
  if (!isNumberOnly(name)) return name;
  const num = name.trim().replace(/^[\s[(（]+|[\s\])）.:：·、—–-]+$/g, '');
  const body = text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
  const rest = body.startsWith(num) ? body.slice(num.length).replace(/^[\s·:：.、—–-]+/, '') : body;
  const first = (/^(.+?[。！？!?；;]|.+?\.(?=\s|$))/u.exec(rest)?.[1] ?? rest).trim();
  if (!first) return name;
  return `${num} · ${first.length > 80 ? `${first.slice(0, 79)}…` : first}`;
}

/** A node as the derivation writes it, before the project and its times are put on it. */
export type DerivedNode = Omit<GraphNode, 'projectId' | 'updatedAt' | 'createdAt'>;

/** The node of a reference item: one definition for the derivation and for the program's own reading of the workbench (workbench-placement.ts). */
export function referenceNode(store: ProjectStore, item: ReferenceItem): DerivedNode {
  return { id: item.id, category: referenceCategory(item), label: displayName(item.name, item.text), refKind: 'reference', refId: item.id, validity: item.validity, progress: item.progress, basis: item.basis, attribution: item.attribution, sourceIds: item.sourceIds, areaId: item.category === 'Area' ? item.id : areaOf(store, item.id), parentWorkId: null, replacedBy: item.replacedBy };
}

const factSourcesOf = (store: ProjectStore, thread: WorkThread): string[] => [...new Set((thread.factRecordIds ?? []).flatMap((f) => store.facts.get(f)?.aboutSourceIds ?? []))];

/** The node of a work item. */
export function threadNode(store: ProjectStore, thread: WorkThread): DerivedNode {
  return { id: thread.id, category: 'Work item', label: thread.ids.length && !thread.title.includes(thread.ids[0]) ? `${thread.ids[0]} ${thread.title}` : thread.title, refKind: 'thread', refId: thread.id, validity: thread.validity, progress: thread.progress, acceptance: thread.acceptance ?? '', basis: 'Explicit', attribution: thread.attribution, sourceIds: factSourcesOf(store, thread), areaId: threadArea(store, thread), parentWorkId: null, replacedBy: thread.replacedBy };
}

/** A relation the assets' own claims state: what an item refines, serves, depends on or replaces. */
export interface ClaimedRelation {
  readonly type: GraphRelation['type'];
  readonly from: string;
  readonly to: string;
  readonly claim: string;
  readonly basis: GraphRelation['basis'];
  readonly evidence: GraphRelation['evidence'];
  /** An area's contribution restates a `serves` the work item may claim itself: written only when no claim before it did. */
  readonly unlessClaimed?: true;
}

/**
 * The relations the assets' claims state as they stand now, in the derivation's order: each reference item's `refines`
 * and `replacedBy`, each work item's `serves`, `dependsOn` and `replacedBy`, each area's contributions. The derivation
 * writes them; the program's reading of the workbench (workbench-placement.ts) reads them before the next derivation.
 */
export function claimedRelations(store: ProjectStore): ClaimedRelation[] {
  const out: ClaimedRelation[] = [];
  for (const item of store.reference.all()) {
    for (const up of item.refines ?? []) if (store.reference.has(up)) out.push({ type: 'refines', from: item.id, to: up, claim: `${item.name} refines ${store.reference.get(up)!.name}`, basis: item.basis, evidence: { sourceIds: item.sourceIds, factRecordIds: [], factsSoFar: '' } });
    if (item.replacedBy && store.reference.has(item.replacedBy)) out.push({ type: 'replaces', from: item.replacedBy, to: item.id, claim: `${store.reference.get(item.replacedBy)!.name} replaces ${item.name}`, basis: item.basis, evidence: { sourceIds: item.sourceIds, factRecordIds: [], factsSoFar: '' } });
  }
  for (const thread of store.threads.all()) {
    const factSources = factSourcesOf(store, thread);
    for (const s of thread.serves ?? []) if (store.reference.has(s.referenceId)) out.push({ type: 'serves', from: thread.id, to: s.referenceId, claim: s.claim, basis: s.basis, evidence: { sourceIds: factSources.slice(0, 12), factRecordIds: thread.factRecordIds, factsSoFar: `${thread.progress}: ${thread.results.slice(0, 200)}` } });
    for (const d of thread.dependsOn ?? []) if (store.threads.has(d.threadId)) out.push({ type: 'depends on', from: thread.id, to: d.threadId, claim: d.claim, basis: d.basis, evidence: { sourceIds: factSources.slice(0, 6), factRecordIds: thread.factRecordIds, factsSoFar: '' } });
    if (thread.replacedBy && store.threads.has(thread.replacedBy)) out.push({ type: 'replaces', from: thread.replacedBy, to: thread.id, claim: `${store.threads.get(thread.replacedBy)!.title} replaces ${thread.title}`, basis: 'Explicit', evidence: { sourceIds: factSources.slice(0, 6), factRecordIds: [], factsSoFar: '' } });
  }
  for (const area of store.areas.all()) {
    for (const c of area.contributions ?? []) {
      if (!store.threads.has(c.threadId) || !store.reference.has(area.referenceId)) continue;
      out.push({ type: 'serves', from: c.threadId, to: area.referenceId, claim: c.claim, basis: c.basis, evidence: { sourceIds: [], factRecordIds: store.threads.get(c.threadId)!.factRecordIds, factsSoFar: '' }, unlessClaimed: true });
    }
  }
  return out;
}

export interface DeriveResult { nodes: number; relations: number; removedNodes: number; removedRelations: number }

export function deriveGraph(store: ProjectStore, project: Project): DeriveResult {
  const nodes = new Map<string, GraphNode>();
  const relations = new Map<string, GraphRelation>();
  const known = store.nodes.size > 0;
  const put = (n: DerivedNode) => { const prev = store.nodes.get(n.id); nodes.set(n.id, { ...n, projectId: project.id, createdAt: prev ? (prev.createdAt ?? '') : known || store.jobs.size > 0 ? now() : '', updatedAt: now() }); };
  const relate = (type: GraphRelation['type'], from: string, to: string, claim: string, basis: GraphRelation['basis'], evidence: GraphRelation['evidence']) => {
    const id = stableId('rel', type, from, to);
    const previous = store.relations.get(id);
    // The replacement check (§5.5, §2.1) settles two things about a `replaces` relation that no field can rebuild:
    // which part of the old decision the new one supersedes, and whether the new decision said so itself
    // (`Explicit`) or only gave different content for the same matter (`Inferred`). The derivation restates the
    // relation from `replacedBy` without touching either. It used to overwrite both on the first derivation after
    // any round that ran the check: `Inferred` silently became `Explicit`, so the owner lost the mark saying the
    // basis was the program's reading and could be corrected, and the superseded part vanished from the claim.
    const settled = type === 'replaces' && previous !== undefined;
    const keptClaim = settled ? previous.claim : claim;
    const keptBasis = settled ? previous.basis : basis;
    relations.set(id, { id, projectId: project.id, type, from, to, claim: keptClaim, basis: keptBasis, evidence, assessment: previous?.assessment ?? 'Not assessed', assessedAt: previous?.assessedAt ?? null, assessedInJobId: previous?.assessedInJobId ?? null, updatedAt: previous && previous.claim === keptClaim ? previous.updatedAt : now() });
  };

  for (const item of store.reference.all()) put(referenceNode(store, item));
  for (const thread of store.threads.all()) put(threadNode(store, thread));
  for (const c of claimedRelations(store)) {
    if (c.unlessClaimed && relations.has(stableId('rel', c.type, c.from, c.to))) continue;
    relate(c.type, c.from, c.to, c.claim, c.basis, c.evidence);
  }

  for (const change of store.changes.all()) {
    put({ id: change.id, category: 'Change', label: change.title, refKind: 'change', refId: change.id, validity: 'Current', progress: null, basis: 'Explicit', attribution: change.by, sourceIds: change.sourceIds, areaId: null, parentWorkId: null, replacedBy: null });
    for (const target of change.affects) relate('affects', change.id, target, `${change.effect}: ${change.title}`, 'Explicit', { sourceIds: change.sourceIds, factRecordIds: [], factsSoFar: '' });
  }

  // Relations the Keeper wrote directly stay; endpoints that are sources become nodes of their kind.
  for (const r of store.relations.all()) {
    if (relations.has(r.id)) continue;
    relations.set(r.id, r);
  }
  for (const r of relations.values()) {
    for (const end of [r.from, r.to]) {
      if (nodes.has(end)) continue;
      const source = store.sources.get(end);
      // What exists only in history — an old version read from version history, what the project keeps for recovery
      // only — forms no node (Spec §1.2, §2.6, D61), so a relation to it is dropped below; a source deleted from the
      // project's current version is not drawn as current.
      if (!source || source.usedAs === 'History only' || source.anchor.kind === 'revision') continue;
      put({ id: source.id, category: sourceCategory(source), label: source.title, refKind: 'source', refId: source.id, validity: source.availability === 'No longer available' ? 'Removed' : 'Current', progress: null, basis: 'Explicit', attribution: null, sourceIds: [source.id], areaId: null, parentWorkId: null, replacedBy: null });
    }
  }
  // Drop relations whose endpoints are not nodes (a fact record or a removed asset).
  for (const [id, r] of [...relations]) if (!nodes.has(r.from) || !nodes.has(r.to)) relations.delete(id);

  const existingNodes = store.nodes.all();
  const removedNodes = existingNodes.filter((n) => !nodes.has(n.id)).map((n) => n.id);
  const existingRelations = store.relations.all();
  const removedRelations = existingRelations.filter((r) => !relations.has(r.id)).map((r) => r.id);
  for (const id of removedNodes) store.nodes.remove(id);
  for (const id of removedRelations) store.relations.remove(id);
  const changedNodes = [...nodes.values()].filter((n) => { const e = store.nodes.get(n.id); return !e || JSON.stringify({ ...e, updatedAt: '' }) !== JSON.stringify({ ...n, updatedAt: '' }); });
  if (changedNodes.length) store.nodes.putMany(changedNodes);
  const changedRelations = [...relations.values()].filter((r) => { const e = store.relations.get(r.id); return !e || JSON.stringify(e) !== JSON.stringify(r); });
  if (changedRelations.length) store.relations.putMany(changedRelations);

  // Seeding comes last, over the graph as it now stands. It used to run in the middle of the derivation, before the
  // relations the Keeper wrote directly were merged back in, so a change never seeded downstream along an
  // `implements`, `verifies`, `depends on` or `serves` relation the Keeper had written itself: the real current
  // objects working to the old understanding never appeared as `Not yet checked`, and no round ever asked about them.
  for (const change of store.changes.all()) seedPropagation(store, change);

  return { nodes: nodes.size, relations: relations.size, removedNodes: removedNodes.length, removedRelations: removedRelations.length };
}

/**
 * Give a change's downstream objects an entry to judge (§5.5); new ones start as `Not yet checked`. The walk runs
 * per item, from that item's own subject, and leaves out what is never judged — a point-in-time record or a
 * decision — which is listed in the record's detail instead (D56 rule 2). Seeding those as `Not yet checked` was
 * how 5,237 judgements landed on 233 objects in the 2026-09-18 assets.
 *
 * Each entry records which items reached that object, so a piece of work with several unrelated items asks each
 * object only about the items that came near it. Without that, one object was handed the whole record and judged
 * against items that never touched it.
 *
 * An item that reaches an object after its entry was written has not been judged (§2.10: what arrives in a round is
 * judged in it): the entry then reads as a new one does — `Not yet checked`, no reason — until the next round judges it
 * together with what the object still lacked. It used to keep the earlier state and reason, so the change's detail and
 * the counts showed that conclusion as if it covered the new item too. Nothing is lost by this: the object's judgement
 * keeps what it followed and what it lacks, the next round carries the lacks forward, and the pack reads them from the
 * judgement. An entry written before items were recorded covered the whole record; it only has its items written down.
 */
function seedPropagation(store: ProjectStore, change: ChangeRecord): void {
  const { judged, notJudged } = downstreamOfChange(store, change);
  const blocked = new Set(notJudged.map((n) => n.nodeId));
  const reached = new Map(judged.map((j) => [j.nodeId, j.itemIds]));
  const at = now();
  let moved = false;
  const propagation: PropagationEntry[] = [];
  for (const p of change.propagation) {
    if (blocked.has(p.nodeId)) { moved = true; continue; }
    const arrived = reached.get(p.nodeId);
    const merged = arrived ? [...new Set([...(p.itemIds ?? []), ...arrived])] : p.itemIds;
    if (merged && (!p.itemIds || merged.length !== p.itemIds.length)) {
      propagation.push(p.itemIds ? { nodeId: p.nodeId, state: 'Not yet checked', sourceOrReason: '', updatedAt: at, itemIds: merged } : { ...p, itemIds: merged, updatedAt: at });
      moved = true;
      continue;
    }
    propagation.push(p);
  }
  for (const [nodeId, itemIds] of reached) {
    if (change.propagation.some((p) => p.nodeId === nodeId)) continue;
    propagation.push({ nodeId, state: 'Not yet checked', sourceOrReason: '', updatedAt: at, itemIds });
    moved = true;
  }
  const listed = [...(change.notJudged ?? [])];
  for (const n of notJudged) if (!listed.some((x) => x.nodeId === n.nodeId)) { listed.push(n); moved = true; }
  if (moved) store.changes.put({ ...change, propagation, notJudged: listed });
}
