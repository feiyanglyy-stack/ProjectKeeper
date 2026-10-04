/**
 * The Keeper looks up its own assets by id (Spec §3.1; CKC-03 AC-22; subagent/DECISIONS.md E63). Given a source id or
 * any record id, it gets the fact records, reference items, work items, relations, change records, marks and notes
 * that cite it or touch it — as short rows (kind, id, name, category, and which field makes the link). The full text
 * of any row is read by id with the existing reading tools. Pure reads; nothing here writes or leaves the assets.
 *
 * Basis: two organizing jobs of a first takeover wanted exactly this ("which records cite this source"), no tool could
 * answer it, and they went to the file system for it — into the ProjectKeeper home the owner was using (E62, E63).
 */
import type { ProjectStore } from '../store/project-store.ts';
import { anchorLabel } from '../sources/anchor.ts';
import { itemsOf } from './adjustment.ts';
import { mergeOf, resolveMergedId } from './merge.ts';

export interface ReferenceRow {
  readonly kind: string;
  readonly id: string;
  readonly name: string;
  readonly category: string;
  /** Which of its fields names the id: "cites it as a source", "serves it", "from", "mounted on it" … */
  readonly via: string;
}
export interface WhatItIs { readonly kind: string; readonly name: string; readonly category: string }
export interface FoundReferences {
  readonly id: string;
  readonly is: WhatItIs | null;
  /** Set when the id is a merged work item: the id of the one kept, whose references follow. */
  readonly mergedInto?: string;
  readonly rows: readonly ReferenceRow[];
  readonly note?: string;
}

/**
 * The records formed from these sources: the reference items citing them, the fact records about them, and the work
 * items whose fact records are about them. `affectsFromSources` in the tools is the first and last of these.
 */
export function formedFrom(store: ProjectStore, sourceIds: readonly string[]): { referenceIds: string[]; factIds: string[]; threadIds: string[] } {
  if (sourceIds.length === 0) return { referenceIds: [], factIds: [], threadIds: [] };
  const cited = new Set(sourceIds);
  const referenceIds = store.reference.filter((r) => r.sourceIds.some((id) => cited.has(id))).map((r) => r.id);
  const factIds = store.facts.filter((f) => f.aboutSourceIds.some((id) => cited.has(id))).map((f) => f.id);
  const facts = new Set(factIds);
  const threadIds = store.threads.filter((t) => t.factRecordIds.some((id) => facts.has(id))).map((t) => t.id);
  return { referenceIds, factIds, threadIds };
}

/** A name for any asset id, for the rows: the project's own name where there is one. */
export function assetName(store: ProjectStore, id: string): string {
  const s = store.sources.get(id);
  if (s) return `${s.title} — ${anchorLabel(s.anchor)}`;
  const r = store.relations.get(id);
  if (r) return `${assetName(store, r.from)} ${r.type} ${assetName(store, r.to)}`;
  return store.reference.get(id)?.name ?? store.threads.get(id)?.title ?? store.facts.get(id)?.title ?? store.changes.get(id)?.title
    ?? store.rules.get(id)?.summary ?? store.nodes.get(id)?.label
    ?? (store.areas.get(id) ? `Area understanding of ${store.reference.get(store.areas.get(id)!.referenceId)?.name ?? store.areas.get(id)!.referenceId}` : undefined)
    ?? (() => { const n = store.notes.get(id); return n ? n.versions[n.versions.length - 1]?.title : undefined; })()
    ?? (() => { const m = store.marks.get(id); return m ? `${m.kind} on ${assetName(store, m.targetId)}` : undefined; })()
    ?? id;
}

/** What the id is, or null when the assets hold no such id. */
export function describeId(store: ProjectStore, id: string): WhatItIs | null {
  const name = () => assetName(store, id);
  if (store.sources.has(id)) return { kind: 'source', name: name(), category: store.sources.get(id)!.usedAs ?? 'Not yet judged' };
  if (store.facts.has(id)) return { kind: 'fact record', name: name(), category: 'Fact record' };
  if (store.reference.has(id)) return { kind: 'reference item', name: name(), category: store.reference.get(id)!.category };
  if (store.threads.has(id)) return { kind: 'work item', name: name(), category: 'Work item' };
  if (store.areas.has(id)) return { kind: 'area understanding', name: name(), category: 'Area' };
  if (store.relations.has(id)) { const r = store.relations.get(id)!; return { kind: 'relation', name: `${assetName(store, r.from)} ${r.type} ${assetName(store, r.to)}`, category: r.type }; }
  if (store.changes.has(id)) return { kind: 'change record', name: name(), category: store.changes.get(id)!.effect };
  if (store.marks.has(id)) return { kind: 'mark', name: name(), category: store.marks.get(id)!.kind };
  if (store.notes.has(id)) { const n = store.notes.get(id)!; return { kind: 'note', name: name(), category: n.versions[n.versions.length - 1]?.ask ?? 'Note' }; }
  if (store.rules.has(id)) { const r = store.rules.get(id)!; return { kind: 'rule', name: r.summary, category: r.category ?? r.group }; }
  if (store.nodes.has(id)) return { kind: 'node', name: name(), category: store.nodes.get(id)!.category };
  return null;
}

/** Everything in the assets that cites or touches the id, as short rows. */
export function findReferences(store: ProjectStore, requested: string): FoundReferences {
  const merged = mergeOf(store, requested);
  const id = merged ? resolveMergedId(store, requested) : requested;
  // One row per record, however many of its fields name the id: the links are joined in `via`.
  const rows = new Map<string, ReferenceRow>();
  const add = (kind: string, rowId: string, category: string, via: string) => {
    if (rowId === id) return;
    const key = `${kind}:${rowId}`;
    const row = rows.get(key);
    if (row) { if (!row.via.split('; ').includes(via)) rows.set(key, { ...row, via: `${row.via}; ${via}` }); return; }
    rows.set(key, { kind, id: rowId, name: assetName(store, rowId), category, via });
  };
  const has = (list: readonly string[] | undefined) => (list ?? []).includes(id);

  const formed = formedFrom(store, [id]);
  for (const f of store.facts.all()) {
    if (formed.factIds.includes(f.id)) add('fact record', f.id, 'Fact record', 'about it');
    if ([...f.statements, ...f.executionFacts].some((s) => has(s.sourceIds))) add('fact record', f.id, 'Fact record', 'a statement cites it');
    if ([...f.statements, ...f.executionFacts].some((s) => s.claimedBy?.untrustedRuleId === id)) add('fact record', f.id, 'Fact record', 'a claim rests on this Untrusted rule');
    if (f.decisions.some((d) => has(d.sourceIds)) || f.changes.some((c) => has(c.sourceIds))) add('fact record', f.id, 'Fact record', 'a decision or change in it cites it');
  }
  for (const r of store.reference.all()) {
    if (has(r.sourceIds)) add('reference item', r.id, r.category, 'cites it as a source');
    if (has(r.refines)) add('reference item', r.id, r.category, 'refines it');
    if (r.replacedBy === id) add('reference item', r.id, r.category, 'replaced by it');
    if ((r.supersededParts ?? []).some((p) => p.byId === id)) add('reference item', r.id, r.category, 'part superseded by it');
    if (r.carryOut && has(r.carryOut.workIds)) add('reference item', r.id, r.category, 'carried out by it');
    if (r.carryOut && has(r.carryOut.evidenceSourceIds)) add('reference item', r.id, r.category, 'its carry-out cites it');
    if (r.validityByRuleId === id) add('reference item', r.id, r.category, 'validity by this rule');
    if (r.ids.includes(id)) add('reference item', r.id, r.category, 'carries this number');
  }
  for (const t of store.threads.all()) {
    if (formed.threadIds.includes(t.id)) add('work item', t.id, 'Work item', 'its fact records are about it');
    if (has(t.factRecordIds)) add('work item', t.id, 'Work item', 'rests on this fact record');
    if (t.serves.some((s) => s.referenceId === id)) add('work item', t.id, 'Work item', 'serves it');
    if (t.dependsOn.some((d) => d.threadId === id)) add('work item', t.id, 'Work item', 'depends on it');
    if (t.replacedBy === id) add('work item', t.id, 'Work item', 'replaced by it');
    if ([...t.executionFacts, ...t.qcFacts].some((s) => has(s.sourceIds))) add('work item', t.id, 'Work item', 'a result or QC fact cites it');
    if (has(t.pendingSourceIds)) add('work item', t.id, 'Work item', 'waits to take it in');
    if (t.validityByRuleId === id || t.progressByRuleId === id) add('work item', t.id, 'Work item', t.progressByRuleId === id ? 'progress by this rule' : 'validity by this rule');
    if (t.ids.some((x) => x.toUpperCase() === id.toUpperCase())) add('work item', t.id, 'Work item', 'carries this number');
  }
  for (const a of store.areas.all()) {
    if (a.referenceId === id) add('area understanding', a.id, 'Area', 'understands this area');
    if (a.contributions.some((c) => c.threadId === id)) add('area understanding', a.id, 'Area', 'counts it as a contribution');
    if (has(a.pendingSourceIds)) add('area understanding', a.id, 'Area', 'waits to take it in');
  }
  for (const r of store.relations.all()) {
    if (r.from === id) add('relation', r.id, r.type, 'from it');
    if (r.to === id) add('relation', r.id, r.type, 'to it');
    if (has(r.evidence.sourceIds) || has(r.evidence.factRecordIds)) add('relation', r.id, r.type, 'its evidence cites it');
  }
  for (const c of store.changes.all()) {
    const items = itemsOf(c);
    if (has(c.sourceIds) || items.some((i) => has(i.sourceIds))) add('change record', c.id, c.effect, 'cites it as a source');
    if (has(c.affects) || items.some((i) => has(i.affects))) add('change record', c.id, c.effect, 'an item changed it');
    const reached = c.propagation.find((p) => p.nodeId === id);
    if (reached) add('change record', c.id, c.effect, `reached it (${reached.state})`);
    if ((c.notJudged ?? []).some((e) => e.nodeId === id)) add('change record', c.id, c.effect, 'reached it, not judged');
  }
  for (const m of store.marks.all()) {
    if (m.targetId === id) add('mark', m.id, m.kind, m.closed ? `on it (closed: ${m.closed.result})` : 'on it');
    if (has(m.clueSourceIds)) add('mark', m.id, m.kind, 'its clue cites it');
  }
  for (const n of store.notes.all()) {
    const v = n.versions[n.versions.length - 1];
    const category = v?.ask ?? 'Note';
    if (has(n.mount.ids)) add('note', n.id, category, 'mounted on it');
    if (v && v.body.facts.some((f) => has(f.sourceIds))) add('note', n.id, category, 'a fact in it cites it');
    if (has(n.cameFrom?.changeIds)) add('note', n.id, category, 'came from it');
  }
  for (const r of store.rules.all()) {
    if (has(r.sourceIds)) add('rule', r.id, r.category ?? r.group, 'cites it as a source');
    if (r.replacedBy === id) add('rule', r.id, r.category ?? r.group, 'replaced by it');
    if (r.differsInPractice.some((d) => has(d.sourceIds))) add('rule', r.id, r.category ?? r.group, 'practice differing from it cites it');
  }
  for (const p of store.plans.all()) {
    if (p.byRule.some((e) => e.ruleId === id)) add('organizing plan', p.id, 'Organizing plan', 'settles material by this rule');
    if (p.focus.some((f) => has(f.sourceIds)) || p.corrections.some((c) => c.sourceId === id)) add('organizing plan', p.id, 'Organizing plan', 'cites it');
  }
  for (const m of store.merges.all()) {
    if (m.keptId === id) add('merge', m.id, 'Merge', `kept when ${m.mergedId} was merged into it`);
  }
  for (const s of store.sources.all()) {
    if (s.ids.some((x) => x.toUpperCase() === id.toUpperCase())) add('source', s.id, s.usedAs ?? 'Not yet judged', 'carries this number');
    if (s.usedAsByRuleId === id) add('source', s.id, s.usedAs ?? 'Not yet judged', 'Used as by this rule');
  }

  const is = merged
    ? { kind: 'merged work item', name: merged.merged.title, category: 'Work item' }
    : describeId(store, id);
  return {
    id: requested,
    is,
    ...(merged ? { mergedInto: id } : {}),
    rows: [...rows.values()],
    ...(is === null && rows.size === 0 ? { note: `${requested} is not an id of this project’s assets, and no record carries it as a number. Ids come from the pk_* tools and from context packs; nothing outside the assets is searched.` } : {}),
  };
}
