/**
 * Merging duplicate work items (Spec §1.4; CKC-06 AC-28; subagent/DECISIONS.md E64, E65). Deterministic; no model.
 *
 * The main job merges, at the end of its round, work items that turned out to be one unit of work. The merged one
 * leaves the work items: its sources, facts and relations move to the one kept, everything that named it names the
 * kept one, and a merge record keeps what it was and points to the one kept. So the list, the graph and every pack —
 * all read from the work items — show it once, and its id still resolves to the one kept.
 *
 * It is not written as `Replaced`. `Replaced` is the history of something superseded, struck through and pointing to
 * its successor; a duplicate is the same work written twice, and marking it `Replaced` would blur the one signal the
 * owner reads for what was given up.
 */
import type { ItemRef, MergeRecord, ObjectJudgement, PropagationEntry, WorkThread } from '../model/types.ts';
import { stableId } from '../model/ids.ts';
import type { ProjectStore, TraceInfo } from '../store/project-store.ts';
import { sameItem } from './adjustment.ts';
import { isNumberShaped } from './numbers-check.ts';

const now = () => new Date().toISOString();
const unique = <T>(list: readonly T[]): T[] => [...new Set(list)];
/** `first` wins on a shared key; what only `more` has is added after it. */
const byKey = <T>(first: readonly T[], more: readonly T[], key: (x: T) => string): T[] => {
  const out = new Map(first.map((x) => [key(x), x]));
  for (const x of more) if (!out.has(key(x))) out.set(key(x), x);
  return [...out.values()];
};
const unionRefs = <T extends ItemRef>(a: readonly T[], b: readonly T[]): T[] => [...a, ...b.filter((x) => !a.some((y) => sameItem(x, y)))];

/** The merge record that took this id out of the work items, or null. */
export function mergeOf(store: ProjectStore, id: string): MergeRecord | null {
  return store.merges.find((m) => m.mergedId === id) ?? null;
}

/**
 * The id that stands for this one now: itself, or the work item it was merged into — following a later merge of that
 * one too. Every tool that takes a work item id reads it through this, so an id a job still remembers reaches the
 * kept work item instead of bringing the duplicate back.
 */
export function resolveMergedId(store: ProjectStore, id: string): string {
  let current = id;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const m = mergeOf(store, current);
    if (!m) {
      // CJ: a project number (`CKC-07`, `AP`) names the one work item that carries it, where no asset has it as its id —
      // a work item's number lives in its ids, and its id is the program's.
      const up = current.trim().toUpperCase();
      if (!store.threads.has(current) && !store.reference.has(current) && isNumberShaped(up)) {
        const carriers = store.threads.filter((t) => t.ids.some((x) => x.trim().toUpperCase() === up));
        if (carriers.length === 1 && !seen.has(carriers[0]!.id)) { current = carriers[0]!.id; continue; }
      }
      return current;
    }
    current = m.keptId;
  }
}

/** Why this merge cannot be done, or null. Every id is checked before anything is written. */
export function mergeRefusal(store: ProjectStore, keepId: string, mergeIds: readonly string[], reason: string): string | null {
  if (!reason.trim()) return 'Say why these are one unit of work (reason): the same number in the project’s index, the same task named in a receipt or a hand-over. The merge record keeps it, so the merge can be checked and undone by hand if it was wrong.';
  const kept = resolveMergedId(store, keepId);
  if (!store.threads.has(kept)) return `${keepId} is not a work item in the assets, so there is nothing to keep. Give the id of the work item that stays (pk_read_assets kind thread lists them).`;
  if (mergeIds.length === 0) return 'Name the duplicate work item(s) to merge into the one kept (mergeIds).';
  for (const id of mergeIds) {
    // The kept id was itself merged into this one earlier: merging this one into it would go round in a circle.
    if (kept !== keepId && id === kept) return `${keepId} was merged into ${id} earlier, so merging ${id} into ${keepId} would make a circle. ${id} is the work item that stays; merge into it instead.`;
    if (id === keepId || id === kept) return `A work item is not merged into itself: ${id} is the one being kept. Name the duplicate(s) in mergeIds.`;
    const target = resolveMergedId(store, id);
    if (target !== id) {
      return target === kept
        ? `${id} is already merged into ${kept}; its id already reaches ${kept}, and a second merge would add nothing.`
        : `${id} was merged into ${target} earlier. If ${target} is the same unit of work as ${kept}, merge ${target} into ${kept}.`;
    }
    if (!store.threads.has(id)) return `${id} is not a work item in the assets. Merging is for work items that turned out to be one unit of work.`;
  }
  return null;
}

export interface MergeInput {
  readonly projectId: string;
  readonly keepId: string;
  readonly mergeIds: readonly string[];
  readonly reason: string;
  readonly sourceIds: readonly string[];
  readonly jobId: string | null;
  readonly roundId: string | null;
}
export interface MergeOutcome {
  readonly keptId: string;
  readonly merged: readonly string[];
  /** How many records of each kind now name the kept work item instead of a merged one. */
  readonly moved: Readonly<Record<string, number>>;
}

/** The kept work item with what the merged one brings: its numbers, facts, fact records, what it serves and needs. */
function combine(kept: WorkThread, merged: WorkThread, at: string): WorkThread {
  return {
    ...kept,
    ids: unique([...kept.ids, ...merged.ids]),
    doing: kept.doing || merged.doing,
    changed: kept.changed || merged.changed,
    results: kept.results || merged.results,
    unresolved: kept.unresolved || merged.unresolved,
    doneMeans: kept.doneMeans || merged.doneMeans || '',
    acceptanceMeans: kept.acceptanceMeans || merged.acceptanceMeans || '',
    acceptance: kept.acceptance || merged.acceptance || '',
    executionFacts: byKey(kept.executionFacts, merged.executionFacts, (s) => s.text),
    qcFacts: byKey(kept.qcFacts, merged.qcFacts, (s) => s.text),
    factRecordIds: unique([...kept.factRecordIds, ...merged.factRecordIds]),
    serves: byKey(kept.serves, merged.serves, (s) => s.referenceId),
    dependsOn: byKey(kept.dependsOn, merged.dependsOn, (d) => d.threadId).filter((d) => d.threadId !== kept.id && d.threadId !== merged.id),
    pendingSourceIds: unique([...kept.pendingSourceIds, ...merged.pendingSourceIds]),
    validityByRuleId: kept.validityByRuleId ?? merged.validityByRuleId ?? null,
    progressByRuleId: kept.progressByRuleId ?? merged.progressByRuleId ?? null,
    updatedAt: at,
  };
}

/** One object's entry in a change record, with the merged one's folded in: behind if either was behind. */
function foldEntry(mine: PropagationEntry, theirs: PropagationEntry): PropagationEntry {
  const behind = [mine, theirs].find((p) => p.state === 'Still on old understanding');
  return {
    ...mine,
    state: behind ? behind.state : mine.state,
    sourceOrReason: unique([mine.sourceOrReason, theirs.sourceOrReason].filter((x) => x.trim())).join(' · '),
    // No `itemIds` means the whole record reached the object, so the fold is the whole record too.
    ...(mine.itemIds && theirs.itemIds ? { itemIds: unique([...mine.itemIds, ...theirs.itemIds]) } : { itemIds: undefined }),
  };
}

/** Every record that names `from` names `to` instead. Records of what happened (jobs, contexts, round results) stay. */
function repoint(store: ProjectStore, from: string, to: string, moved: Record<string, number>, trace: TraceInfo): void {
  const swap = (id: string) => (id === from ? to : id);
  const count = (kind: string) => { moved[kind] = (moved[kind] ?? 0) + 1; };

  for (const t of store.threads.all()) {
    if (t.id === from || !t.dependsOn.some((d) => d.threadId === from)) continue;
    const dependsOn = byKey(t.dependsOn.map((d) => ({ ...d, threadId: swap(d.threadId) })), [], (d) => d.threadId).filter((d) => d.threadId !== t.id);
    store.threads.put({ ...t, dependsOn }, trace);
    count('workItems');
  }
  for (const a of store.areas.all()) {
    if (!a.contributions.some((c) => c.threadId === from)) continue;
    store.areas.put({ ...a, contributions: byKey(a.contributions.map((c) => ({ ...c, threadId: swap(c.threadId) })), [], (c) => c.threadId) }, trace);
    count('areas');
  }
  for (const r of store.relations.all()) {
    if (r.from !== from && r.to !== from) continue;
    const f = swap(r.from);
    const t = swap(r.to);
    store.relations.remove(r.id, trace);
    count('relations');
    // The two duplicates were related to each other; one work item is not related to itself.
    if (f === t) continue;
    const id = stableId('rel', r.type, f, t);
    const existing = store.relations.get(id);
    if (existing) {
      store.relations.put({ ...existing, evidence: {
        sourceIds: unique([...existing.evidence.sourceIds, ...r.evidence.sourceIds]),
        factRecordIds: unique([...existing.evidence.factRecordIds, ...r.evidence.factRecordIds]),
        factsSoFar: existing.evidence.factsSoFar || r.evidence.factsSoFar,
      } }, trace);
    } else {
      store.relations.put({ ...r, id, from: f, to: t }, trace);
    }
  }
  store.nodes.remove(from, trace);
  for (const n of store.nodes.all()) if (n.parentWorkId === from) store.nodes.put({ ...n, parentWorkId: to });
  for (const m of store.marks.all()) {
    if (m.targetId !== from) continue;
    store.marks.remove(m.id, trace);
    count('marks');
    // One mark per kind and object (as pk_write_mark keeps them): the same doubt on both becomes one, with both clues.
    const id = stableId('mark', m.kind, to);
    const existing = store.marks.get(id);
    if (!existing || (existing.closed && !m.closed)) store.marks.put({ ...m, id, targetId: to }, trace);
    else if (!existing.closed && !m.closed) {
      store.marks.put({ ...existing, clue: existing.clue === m.clue ? existing.clue : `${existing.clue} · ${m.clue}`, clueSourceIds: unique([...existing.clueSourceIds, ...m.clueSourceIds]) }, trace);
    }
  }
  for (const n of store.notes.all()) {
    if (!n.mount.ids.includes(from)) continue;
    store.notes.put({ ...n, mount: { ...n.mount, ids: unique(n.mount.ids.map(swap)) } }, trace);
    count('notes');
  }
  for (const c of store.changes.all()) {
    const touches = c.affects.includes(from) || (c.items ?? []).some((i) => i.affects.includes(from))
      || c.propagation.some((p) => p.nodeId === from) || (c.notJudged ?? []).some((e) => e.nodeId === from);
    if (!touches) continue;
    const items = c.items?.map((i) => ({ ...i, affects: unique(i.affects.map(swap)) }));
    const affects = unique(c.affects.map(swap));
    const mine = c.propagation.find((p) => p.nodeId === to);
    const theirs = c.propagation.find((p) => p.nodeId === from);
    let propagation = c.propagation.filter((p) => p.nodeId !== from && p.nodeId !== to);
    const folded = theirs ? (mine ? foldEntry(mine, theirs) : { ...theirs, nodeId: to }) : mine;
    // A subject is never downstream of its own item (§1.8): what reached the kept one through an item that now changes
    // it directly is dropped.
    if (folded) {
      const subjectOf = new Set((items ?? []).filter((i) => i.affects.includes(to)).map((i) => i.id));
      const still = folded.itemIds ? folded.itemIds.filter((id) => !subjectOf.has(id)) : folded.itemIds;
      const whole = !folded.itemIds && affects.includes(to);
      if (!whole && (!still || still.length > 0)) propagation = [...propagation, still ? { ...folded, itemIds: still } : folded];
    }
    const notJudged = c.notJudged ? byKey(c.notJudged.map((e) => ({ ...e, nodeId: swap(e.nodeId) })), [], (e) => e.nodeId) : undefined;
    store.changes.put({ ...c, affects, propagation, ...(items ? { items } : {}), ...(notJudged ? { notJudged } : {}) }, trace);
    count('changes');
  }
  for (const j of store.propagation.all()) {
    if (j.nodeId !== from) continue;
    store.propagation.remove(j.id, trace);
    count('judgements');
    const id = `${j.roundId}:${to}`;
    const k = store.propagation.get(id);
    if (!k) { store.propagation.put({ ...j, id, nodeId: to }, trace); continue; }
    // The kept one's judgement of that round takes in what the merged one still lacked, and lacking wins.
    const lacks = unionRefs(k.lacks, j.lacks);
    const closed = unionRefs(k.closed, j.closed).filter((c) => !lacks.some((l) => sameItem(l, c)));
    const followed = unionRefs(k.followed, j.followed).filter((f) => ![...lacks, ...closed].some((x) => sameItem(x, f)));
    const judgement: ObjectJudgement = {
      ...k, covers: unionRefs(k.covers, j.covers), lacks, closed, followed,
      state: lacks.length ? 'Still on old understanding' : k.state,
      sourceOrReason: unique([k.sourceOrReason, j.sourceOrReason].filter((x) => x.trim())).join(' · '),
    };
    store.propagation.put(judgement, trace);
  }
  for (const r of store.requests.all()) {
    if (!r.impact.includes(from) && !(r.lines ?? []).some((l) => l.nodeId === from)) continue;
    store.requests.put({ ...r, impact: unique(r.impact.map(swap)), ...(r.lines ? { lines: r.lines.map((l) => ({ ...l, nodeId: swap(l.nodeId) })) } : {}) }, trace);
    count('requests');
  }
  for (const ref of store.reference.all()) {
    if (!ref.carryOut || !ref.carryOut.workIds.includes(from)) continue;
    store.reference.put({ ...ref, carryOut: { ...ref.carryOut, workIds: unique(ref.carryOut.workIds.map(swap)) } }, trace);
    count('decisions');
  }
}

/** Merge the named duplicates into the work item kept. Call `mergeRefusal` first; this assumes the ids are valid. */
export function mergeWorkItems(store: ProjectStore, input: MergeInput): MergeOutcome {
  const keptId = resolveMergedId(store, input.keepId);
  const moved: Record<string, number> = {};
  const merged: string[] = [];
  for (const mergedId of unique(input.mergeIds)) {
    const at = now();
    const kept = store.threads.get(keptId)!;
    const duplicate = store.threads.get(mergedId)!;
    const trace: TraceInfo = { jobId: input.jobId, basisSourceIds: input.sourceIds, summary: `Merged ${mergedId} (${duplicate.title}) into ${keptId} (${kept.title}): ${input.reason}` };
    store.threads.put(combine(kept, duplicate, at), trace);
    repoint(store, mergedId, keptId, moved, trace);
    store.threads.remove(mergedId, trace);
    store.merges.put({
      id: stableId('merge', input.projectId, mergedId), projectId: input.projectId, kind: 'thread', mergedId, keptId,
      reason: input.reason, sourceIds: [...input.sourceIds], merged: duplicate, at, jobId: input.jobId, roundId: input.roundId,
    }, trace);
    merged.push(mergedId);
  }
  return { keptId, merged, moved };
}
