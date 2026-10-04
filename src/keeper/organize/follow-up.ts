/**
 * Change follow-up (Spec §5.5, CKC-11 AC-14–AC-19; owner D48). After something upstream moved, the next round of
 * daily upkeep walks its downstream and says, for each one, how it stands. This is a judgement, not a re-check: the
 * Keeper does not re-run verification, does not re-do work an agent already did, and does not grade anyone.
 *
 * The work is organized by object, not by change. On a project that has been worked on for a while, one object sits
 * downstream of many changes (on the trial, 4871 pending entries were 227 objects, a median of 18 changes each), so a
 * batch takes a few objects of one area and shows each with every change that reached it: the object is read once and
 * judged against all of them.
 *
 * Since D56 the asset is per object and per round as well: one object gets one state covering every item that
 * reached it, written with pk_judge_object. Objects that are never judged — point-in-time records and decisions
 * (§2.10) — never enter a batch and never count as pending, and an item settled in an earlier round comes back only
 * when the object itself has moved.
 */
import type { ChangeRecord, GraphNode, PropagationEntry } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { itemKey, itemStandings, itemsForObject, itemsOf, notJudgedReason, objectUpdatedAt, openRound, type ItemStanding } from '../adjustment.ts';

export interface PendingFollowUp {
  readonly changeId: string;
  readonly nodeId: string;
  /** Which items of that record reached this object. Absent on an entry seeded before it was recorded, which is
   *  read as the whole record. */
  readonly itemIds?: readonly string[];
}
export interface FollowUpBatch {
  /** The area these downstream objects belong to; null for objects that hang from nothing. */
  readonly areaId: string | null;
  readonly areaName: string;
  /** The objects of this batch, each with the pending entries (one per change) to judge. */
  readonly objects: readonly { readonly nodeId: string; readonly entries: readonly PendingFollowUp[] }[];
  readonly entries: readonly PendingFollowUp[];
  readonly changeIds: readonly string[];
}

/** The key of one entry: a change and one of its downstream objects. */
export const entryKey = (e: PendingFollowUp) => `${e.changeId}>${e.nodeId}`;

export interface BatchLimits {
  /** At most this many objects in one batch. */
  readonly objects: number;
  /** A batch stops taking objects once it holds this many entries; an object with more still goes whole, alone. */
  readonly entries: number;
}
export const DEFAULT_LIMITS: BatchLimits = { objects: 8, entries: 80 };

/** Whether an object still has something for this round: at least one item of a change that reached it has no
 *  conclusion yet. An object whose outstanding items were all settled in an earlier round, and which has not moved
 *  since, is not judged again (§5.5). */
export function objectPending(store: ProjectStore, nodeId: string): boolean {
  if (notJudgedReason(store, nodeId) !== null) return false;
  const roundId = openRound(store)?.id ?? 'round_9999';
  return itemsForObject(store, nodeId, roundId).covers.length > 0;
}

/**
 * Entries still to judge, grouped by object and the objects by area; an area's objects with the most waiting go
 * first. Entries already handed to a running job are left out one by one, so a change arriving mid-round never hands
 * the same pair out twice.
 */
export function pendingByArea(store: ProjectStore, limits: BatchLimits = DEFAULT_LIMITS, inFlight: ReadonlySet<string> = new Set()): FollowUpBatch[] {
  const nodes = new Map(store.nodes.all().map((n) => [n.id, n]));
  const areaName = (id: string | null) => (id ? store.reference.get(id)?.name ?? id : 'No area');
  const areaOfNode = (n: GraphNode | undefined): string | null => (n ? (n.category === 'Area' ? n.id : n.areaId ?? null) : null);
  const byObject = new Map<string, PendingFollowUp[]>();
  const judged = new Map<string, boolean>();
  const takes = (id: string) => { if (!judged.has(id)) judged.set(id, objectPending(store, id)); return judged.get(id)!; };
  const roundId = openRound(store)?.id ?? null;
  // One object, one judgement, one round: an object this round has already judged is not handed out again, however
  // its individual entries read.
  const done = (nodeId: string) => roundId !== null && store.propagation.get(`${roundId}:${nodeId}`) !== undefined;
  // An entry a model has already answered — including "Not yet checked" with the reason it could not check it —
  // is not handed back, or the round would ask the same question forever. It comes back when the object itself
  // moves after that answer: §5.5 re-opens an object as soon as it changes. The answer is the round's judgement, not
  // the entry's own time: other writers touch an entry too — the seeding merges into it an item that reached the object
  // later, and refreshes its time — and an item that arrived after the judgement has not been asked about at all.
  const standings = new Map<string, Map<string, ItemStanding>>();
  const standingsOf = (nodeId: string) => {
    if (!standings.has(nodeId)) standings.set(nodeId, itemStandings(store, nodeId, roundId ?? 'round_9999'));
    return standings.get(nodeId)!;
  };
  const answered = (c: ChangeRecord, p: PropagationEntry) => {
    if (roundId !== null && p.roundId === roundId) return true;
    if (!p.sourceOrReason) return false;
    const judgement = p.roundId ? store.propagation.get(`${p.roundId}:${p.nodeId}`) : undefined;
    if (!judgement) return objectUpdatedAt(store, p.nodeId) <= p.updatedAt;
    const arrived = p.itemIds ?? itemsOf(c).map((i) => i.id);
    if (arrived.some((itemId) => !standingsOf(p.nodeId).has(itemKey({ changeId: c.id, itemId })))) return false;
    return objectUpdatedAt(store, p.nodeId) <= judgement.at;
  };
  for (const c of store.changes.all().sort((a, b) => b.at.localeCompare(a.at))) {
    for (const p of c.propagation) {
      if (!nodes.has(p.nodeId) && !store.reference.has(p.nodeId) && !store.threads.has(p.nodeId)) continue;
      if (inFlight.has(`${c.id}>${p.nodeId}`)) continue;
      if (done(p.nodeId) || answered(c, p)) continue;
      // §2.10: point-in-time records and decisions never enter a batch, and an item settled in an earlier round
      // comes back only after the object itself has moved. The entry's own state is not the gate — scanning only
      // `Not yet checked` meant a changed object was pending by rule (§5.5 re-opens it as soon as it changes) and
      // yet no batch ever carried it: `objectPending` said true while `pendingByArea` came back empty.
      if (!takes(p.nodeId)) continue;
      if (!byObject.has(p.nodeId)) byObject.set(p.nodeId, []);
      byObject.get(p.nodeId)!.push({ changeId: c.id, nodeId: p.nodeId, itemIds: p.itemIds });
    }
  }
  const byArea = new Map<string, { nodeId: string; entries: PendingFollowUp[] }[]>();
  for (const [nodeId, entries] of byObject) {
    const key = areaOfNode(nodes.get(nodeId)) ?? '';
    if (!byArea.has(key)) byArea.set(key, []);
    byArea.get(key)!.push({ nodeId, entries });
  }
  const out: FollowUpBatch[] = [];
  for (const [key, objects] of byArea) {
    objects.sort((a, b) => b.entries.length - a.entries.length || a.nodeId.localeCompare(b.nodeId));
    let current: { nodeId: string; entries: PendingFollowUp[] }[] = [];
    let count = 0;
    const flush = () => {
      if (!current.length) return;
      const entries = current.flatMap((o) => o.entries);
      out.push({ areaId: key || null, areaName: areaName(key || null), objects: current, entries, changeIds: [...new Set(entries.map((e) => e.changeId))] });
      current = []; count = 0;
    };
    for (const o of objects) {
      if (current.length && (current.length >= limits.objects || count + o.entries.length > limits.entries)) flush();
      current.push(o); count += o.entries.length;
    }
    flush();
  }
  // The batches with the most waiting first: the area the owner is most likely to be looking at has the most to say.
  return out.sort((a, b) => b.entries.length - a.entries.length);
}

/**
 * What is still to judge. Objects §2.10 never judges are not counted — the old count called 5,237 pairs pending on
 * the 2026-09-18 assets, and about six in ten of what came back was a closed record judged behind.
 */
export function pendingCount(store: ProjectStore): { entries: number; changes: number; objects: number; notJudged: number } {
  let entries = 0;
  const changes = new Set<string>();
  const objects = new Set<string>();
  const judged = new Map<string, boolean>();
  const takes = (id: string) => { if (!judged.has(id)) judged.set(id, objectPending(store, id)); return judged.get(id)!; };
  for (const c of store.changes.all()) for (const p of c.propagation) {
    if (p.state !== 'Not yet checked' || !takes(p.nodeId)) continue;
    entries++; changes.add(c.id); objects.add(p.nodeId);
  }
  const notJudged = new Set(store.changes.all().flatMap((c) => (c.notJudged ?? []).map((e) => e.nodeId)));
  return { entries, changes: changes.size, objects: objects.size, notJudged: notJudged.size };
}

export interface FollowUpItemForPrompt {
  readonly id: string;
  readonly effect: string;
  readonly title: string;
  readonly summary: string;
  readonly before: string | null;
  readonly after: string | null;
}
export interface FollowUpChangeForPrompt {
  readonly id: string;
  readonly at: string;
  readonly effect: string;
  readonly title: string;
  readonly summary: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly sourceIds: readonly string[];
  /** The piece of work's own net changes; the judgement names the ones the object followed and the ones it lacks. */
  readonly items?: readonly FollowUpItemForPrompt[];
  /** How this piece of work was cut out: which session or execution, or that it was grouped by time. */
  readonly work?: string | null;
}
export interface FollowUpObjectForPrompt {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly progress: string | null;
  readonly validity: string;
  readonly marks: readonly string[];
  readonly text: string;
  readonly factRecordIds: readonly string[];
  /** The changes to judge this object against, newest first, each saying whether the object moved after it and
   *  which of its items reached this object — an object is asked only about the items that came near it. */
  readonly changes: readonly { readonly id: string; readonly updatedAfter: boolean; readonly itemIds?: readonly string[] }[];
  /** What the previous round said this object still lacks and nothing has closed since. It is judged again with
   *  the rest: an item ends only when the object follows it, a later change supersedes it, or the owner or holder
   *  says it need not be handled (§5.5), so the model has to see it to be able to conclude on it. */
  readonly stillLacks: readonly { readonly changeId: string; readonly itemId: string; readonly what: string }[];
}

/** What one follow-up job is given: the batch's changes, described once, and its objects, each with its changes. */
export function packFollowUp(store: ProjectStore, batch: FollowUpBatch): { changes: FollowUpChangeForPrompt[]; objects: FollowUpObjectForPrompt[] } {
  const nodes = new Map(store.nodes.all().map((n) => [n.id, n]));
  const marksOn = new Map<string, string[]>();
  for (const m of store.marks.filter((x) => !x.closed)) { if (!marksOn.has(m.targetId)) marksOn.set(m.targetId, []); marksOn.get(m.targetId)!.push(m.kind); }
  const changes = batch.changeIds.flatMap((id) => store.changes.get(id) ?? []).sort((a, b) => b.at.localeCompare(a.at));
  const at = new Map(changes.map((c) => [c.id, c.at]));
  return {
    changes: changes.map((c: ChangeRecord) => ({
      id: c.id, at: c.at, effect: c.effect, title: c.title, summary: c.summary, before: c.before, after: c.after, sourceIds: c.sourceIds,
      work: c.work ? `${c.work.kind}: ${c.work.label}${c.work.openEnded ? ' (up to its last pause)' : ''}` : null,
      items: itemsOf(c).map((i) => ({ id: i.id, effect: i.effect, title: i.title, summary: i.summary, before: i.before, after: i.after })),
    })),
    objects: batch.objects.map((o) => {
      const n = nodes.get(o.nodeId);
      const thread = store.threads.get(o.nodeId);
      const ref = store.reference.get(o.nodeId);
      const updatedAt = thread?.updatedAt ?? ref?.updatedAt ?? '';
      return {
        id: o.nodeId,
        label: n?.label ?? thread?.title ?? ref?.name ?? o.nodeId,
        category: n?.category ?? (thread ? 'Work item' : ref?.category ?? 'unknown'),
        progress: thread?.progress ?? null,
        validity: thread?.validity ?? ref?.validity ?? 'Current',
        marks: marksOn.get(o.nodeId) ?? [],
        text: (thread ? `${thread.doing} ${thread.results}` : ref?.text ?? '').slice(0, 400),
        factRecordIds: thread?.factRecordIds.slice(0, 6) ?? [],
        changes: o.entries.map((e) => ({ id: e.changeId, updatedAfter: updatedAt > (at.get(e.changeId) ?? ''), itemIds: e.itemIds }))
          .sort((a, b) => (at.get(b.id) ?? '').localeCompare(at.get(a.id) ?? '')),
        stillLacks: itemsForObject(store, o.nodeId, openRound(store)?.id ?? 'round_9999').carried,
      };
    }),
  };
}

const clip = (s: string | null, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? '');

/** The changes of a batch, each described once, then its objects, each with the changes to judge it against. */
function renderPacked(packed: { changes: readonly FollowUpChangeForPrompt[]; objects: readonly FollowUpObjectForPrompt[] }): string[] {
  const parts: string[] = ['=== Changes (one record per piece of work; its items are its net changes)'];
  for (const c of packed.changes) {
    parts.push(`- ${c.id} · ${c.at} · ${c.title}${c.work ? ` · ${c.work}` : ''}`);
    if (c.summary) parts.push(`    ${clip(c.summary, 400)}`);
    const items = c.items ?? [];
    if (items.length > 1 || (items[0]?.id ?? '')) {
      for (const i of items) {
        parts.push(`    · item ${i.id || '(the record itself)'} · ${i.effect} · ${i.title}`);
        if (i.summary) parts.push(`        ${clip(i.summary, 300)}`);
        if (i.before || i.after) parts.push(`        before: ${clip(i.before, 200) || '—'} | after: ${clip(i.after, 200) || '—'}`);
      }
    } else if (c.before || c.after) {
      parts.push(`    before: ${clip(c.before, 200) || '—'} | after: ${clip(c.after, 200) || '—'}`);
    }
    parts.push(`    sources: ${c.sourceIds.join(', ')}`);
  }
  parts.push('', '=== Objects to judge');
  for (const o of packed.objects) {
    parts.push(`- ${o.id} · ${o.category} · ${o.label}${o.progress ? ` · ${o.progress}` : ''} · ${o.validity}${o.marks.length ? ` · marks: ${o.marks.join(', ')}` : ''}`);
    if (o.text) parts.push(`    ${o.text}`);
    if (o.factRecordIds.length) parts.push(`    fact records: ${o.factRecordIds.join(', ')}`);
    // Only the items that reached this object are named, so the object is not asked about the other items of the
    // same piece of work — those went somewhere else and judging against them invents findings.
    parts.push(`    judge against: ${o.changes.map((c) => {
      const items = c.itemIds && c.itemIds.length ? ` items ${c.itemIds.map((i) => i || '(the record itself)').join(', ')}` : '';
      return `${c.id}${items}${c.updatedAfter ? ' (object updated after it)' : ' (not updated since)'}`;
    }).join(', ')}`);
    for (const l of o.stillLacks) parts.push(`    still lacking from an earlier round: ${l.changeId}${l.itemId ? ` item ${l.itemId}` : ''} — ${clip(l.what, 200)}. Conclude on it too: say it is followed now, or closed, or that it is still lacked.`);
  }
  return parts;
}

/** A round is not cut into batches: its one job holds the whole of it, so the per-batch caps do not apply. */
export const ROUND_LIMITS: BatchLimits = { objects: 100_000, entries: 1_000_000 };

/**
 * What the open round still has to judge: every object waiting on an item, area by area, with the items that reached
 * it and what it still lacks. Objects this round already judged are left out. A round's main job asks for it
 * (pk_round_pending) after recording the changes of its own material, so the objects those changes reached are judged
 * in the same round (§3.8).
 */
export function pendingForRound(store: ProjectStore): { objects: number; text: string } {
  const parts: string[] = [];
  let objects = 0;
  for (const batch of pendingByArea(store, ROUND_LIMITS)) {
    const packed = packFollowUp(store, batch);
    objects += packed.objects.length;
    parts.push(`=== Area: ${batch.areaName} (${packed.objects.length} object${packed.objects.length === 1 ? '' : 's'})`, ...renderPacked(packed), '');
  }
  return { objects, text: parts.join('\n').trim() };
}
