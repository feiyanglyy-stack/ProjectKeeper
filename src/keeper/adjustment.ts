/**
 * The rules of change follow-up that the program keeps, not the model (Spec §1.8, §1.11, §2.1, §2.10, §5.4, §5.5;
 * D56, D59). Everything here is deterministic and calls no model.
 *
 * Why these are rules and not prompt wording: on the 2026-09-18 assets, 42 matters were written as 160 change
 * records, 233 objects were judged 5,237 times, 1,759 of 6,301 propagation judgements were about decisions (16 of
 * them "has not followed") while the decisions that had really been superseded were not marked at all, and 38 of 85
 * marks hung on a point-in-time record, on another mark, or on a note. A model that is merely asked to remember
 * these will forget them again.
 */
import type {
  ChangeItem, ChangeRecord, ClosedItem, ItemRef, LackedItem, NotJudgedEntry, ObjectJudgement, PropagationEntry, RoundResult,
} from '../model/types.ts';
import type { NotAChange, NotJudgedReason, Propagation } from '../model/vocab.ts';
import type { RoundNews } from '../model/k-types.ts';
import type { ProjectStore } from '../store/project-store.ts';

const now = () => new Date().toISOString();

// ───────────────────────── what a change record holds ─────────────────────────

/**
 * A record written before items existed reads as one item covering the whole record, so every rule below works the
 * same on old and new records.
 */
export function itemsOf(change: ChangeRecord): readonly ChangeItem[] {
  if (change.items && change.items.length) return change.items;
  return [{
    id: '', at: change.at, atSource: change.atSource, material: change.material, effect: change.effect,
    title: change.title, summary: change.summary, before: change.before, after: change.after,
    sourceIds: change.sourceIds, by: change.by, why: null, affects: change.affects,
  }];
}

/** Every item of every record, in the order they happened. */
export function allItems(store: ProjectStore): { change: ChangeRecord; item: ChangeItem }[] {
  return store.changes.all()
    .flatMap((change) => itemsOf(change).map((item) => ({ change, item })))
    .sort((a, b) => a.item.at.localeCompare(b.item.at));
}

const normalise = (s: string | null): string =>
  (s ?? '').toLowerCase().replace(/\bv?\d+(\.\d+)+\b/g, '#').replace(/[\s`*_"'“”‘’,.;:!?()[\]{}\-—–]+/g, ' ').trim();

/**
 * Whether an item is one of the things §1.8 says is not a change, and which one. Three of the seven are decided
 * from the item itself; the other four — restating, re-reading, checking a dependency, re-reading after a
 * compaction, recalling from memory — all mean the same net change was already recorded, so they are found by
 * comparing the item with what is already in the assets.
 */
export function notAChange(store: ProjectStore, item: ChangeItem, recordId: string): NotAChange | null {
  const before = normalise(item.before);
  const after = normalise(item.after);
  // Changed and changed back: the piece of work ends exactly where it started, so its net change is nothing.
  if (item.before !== null && item.after !== null && item.before.trim() === item.after.trim()) return 'Changed and changed back';
  // Wording, formatting or a version number that leaves the meaning alone: what differs is only spacing,
  // punctuation, case or a version string.
  if (before.length > 0 && before === after) return 'Wording, formatting or version number only';
  // Already recorded: the same subject, effect and content as an item of an earlier record. Being met again is not
  // a new change — it is the same one being restated, re-read, looked up as a dependency, or recalled.
  const subject = [...item.affects].sort().join(',');
  for (const { change, item: other } of allItems(store)) {
    if (change.id === recordId) continue;
    if (other.effect !== item.effect) continue;
    if ([...other.affects].sort().join(',') !== subject) continue;
    if (normalise(other.after) !== after || normalise(other.before) !== before) continue;
    if (normalise(other.title) !== normalise(item.title) && normalise(other.summary) !== normalise(item.summary)) continue;
    return 'Restating';
  }
  return null;
}

/**
 * Two items of the same piece of work that undo each other — the second puts back what the first replaced, on the
 * same subject — are the "changed it and changed it back" of §1.8: the work's net change on that subject is
 * nothing, so neither item survives. Returns the pairs, by index.
 */
export function undonePairs(items: readonly ChangeItem[]): [number, number][] {
  const pairs: [number, number][] = [];
  const taken = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    if (taken.has(i)) continue;
    const a = items[i]!;
    for (let j = i + 1; j < items.length; j++) {
      if (taken.has(j)) continue;
      const b = items[j]!;
      if ([...a.affects].sort().join(',') !== [...b.affects].sort().join(',')) continue;
      if (normalise(a.before) !== normalise(b.after) || normalise(a.after) !== normalise(b.before)) continue;
      if (normalise(a.after).length === 0 && normalise(a.before).length === 0) continue;
      pairs.push([i, j]); taken.add(i); taken.add(j); break;
    }
  }
  return pairs;
}

export const NOT_A_CHANGE_ADVICE: Readonly<Record<NotAChange, string>> = {
  'Restating': 'the same net change is already recorded; add the material to that record’s sources instead of recording it again',
  'Re-reading': 'reading a material again is not a change',
  'Checking a dependency': 'looking a dependency up is not a change',
  'Re-reading after compaction': 'reading the same material again after a compaction is not a change',
  'Recalling from memory': 'bringing the same matter up again is not a change',
  'Changed and changed back': 'the piece of work ends where it started, so it has no net change on this object',
  'Wording, formatting or version number only': 'before and after differ only in wording, formatting or a version number, so the meaning did not change',
};

// ───────────────────────── who is judged, and who is not ─────────────────────────

const POINT_IN_TIME_NODES = new Set(['Session', 'Run', 'Review', 'Result', 'Change']);

/**
 * A point-in-time record: something written down and then not maintained — a `Done` work item, a `Replaced`,
 * `Abandoned` or `Removed` entry, a session, an execution or review report, a commit, a run result, a status statement. It says
 * how things stood then, so a later change cannot leave it behind (§2.10). An item on hold is not one of these: it
 * will be resumed from its text.
 */
export function isPointInTime(store: ProjectStore, id: string): boolean {
  const node = store.nodes.get(id);
  const refId = node ? node.refId : id;
  if (store.changes.has(refId)) return true;
  // What the material is used as decides this, and it is asked before the node's category. The graph has no `Code`
  // category, so a file kept as code or as a design becomes a `Result` node (§1.5); reading the category first
  // classed every maintained code area as a point-in-time record and took it out of propagation for good, against
  // §2.10, which judges documents, plans, unfinished work, code areas and tests as usual.
  const source = store.sources.get(refId);
  if (source) return source.anchor.kind !== 'file' || source.usedAs === 'Status' || source.usedAs === 'QC' || source.usedAs === 'Run result';
  if (node && POINT_IN_TIME_NODES.has(node.category)) return true;
  // `Removed` (v2.8, D61) is no longer in the project's current version: nobody maintains it, so a later change cannot
  // leave it behind, and a doubt that it still applies belongs on the current object that relies on it (§2.1).
  const thread = store.threads.get(refId);
  if (thread) return thread.progress === 'Done' || thread.validity === 'Replaced' || thread.validity === 'Abandoned' || thread.validity === 'Removed';
  const ref = store.reference.get(refId);
  if (ref) return ref.validity === 'Replaced' || ref.validity === 'Abandoned' || ref.validity === 'Removed';
  return false;
}

/** A decision entry: judged by the replacement check (§5.5), never by propagation. */
export function isDecision(store: ProjectStore, id: string): boolean {
  const node = store.nodes.get(id);
  const ref = store.reference.get(node ? node.refId : id);
  return ref !== undefined && (ref.category === 'Decision' || ref.category === 'Boundary');
}

/** A mark or a note: a judgement about something else, never an object that falls behind or carries a mark. */
export function isJudgementRecord(store: ProjectStore, id: string): boolean {
  return store.marks.has(id) || store.notes.has(id) || id.startsWith('mark_') || id.startsWith('note_');
}

/** Why an object is never judged, or null when it is judged as usual (documents, plans, unfinished work, code
 *  areas, tests). Point-in-time comes first: a `Replaced` decision is listed as a point-in-time record. */
export function notJudgedReason(store: ProjectStore, id: string): NotJudgedReason | null {
  if (isJudgementRecord(store, id)) return 'Point-in-time record';
  if (isPointInTime(store, id)) return 'Point-in-time record';
  if (isDecision(store, id)) return 'Decision';
  return null;
}

export const NOT_JUDGED_MESSAGE: Readonly<Record<NotJudgedReason, string>> = {
  'Point-in-time record': 'A point-in-time record says how things stood when it was written, so a later change cannot leave it behind. It is listed in the change’s detail and does not count towards what is pending. Judge instead the current object that still uses the old content.',
  'Decision': 'A decision records what was settled at one moment, so it is not judged for propagation. What it needs is the replacement check: whether a later decision superseded it, and which part. Use pk_check_decisions.',
};

/** Whether the object exists at all in the assets. */
export function objectExists(store: ProjectStore, id: string): boolean {
  return store.nodes.has(id) || store.reference.has(id) || store.threads.has(id) || store.areas.has(id);
}

/** The object's own last change, used to tell whether a settled item has to be judged again. */
export function objectUpdatedAt(store: ProjectStore, id: string): string {
  const node = store.nodes.get(id);
  const refId = node ? node.refId : id;
  return store.threads.get(refId)?.updatedAt ?? store.reference.get(refId)?.updatedAt ?? store.areas.get(refId)?.updatedAt ?? node?.updatedAt ?? '';
}

// ───────────────────────── downstream, by rule ─────────────────────────

const DOWNSTREAM_RELATIONS = ['serves', 'refines', 'implements', 'verifies', 'depends on'];

/**
 * The downstream of one item: from its subject, along the relations, by rule (§5.5). The subject itself is not
 * downstream of its own item — an object never fails to follow its own revision — and objects that are never
 * judged are left out, so they cannot reach the pending list at all. An object changed inside the same piece of
 * work is still downstream: that it was touched is evidence, not a conclusion.
 */
export function downstreamOfItem(store: ProjectStore, item: Pick<ChangeItem, 'affects'>, depth = 2): string[] {
  return rawDownstream(store, item, depth).filter((id) => notJudgedReason(store, id) === null);
}

/** What one item of a record reached: the object, and the item that reached it. */
export interface Reached {
  readonly nodeId: string;
  readonly itemIds: readonly string[];
}

/**
 * Every object the items of this record reached, each with the items that actually reached it, and the not-judged
 * ones listed apart. The per-item mapping is what the round hands to a model: a piece of work with several
 * unrelated items used to give every object it reached all of the record's items, so an object was asked about
 * items that never came near it — inventing judgements, wrong `lacks` and wrong numbers.
 */
export function downstreamOfChange(store: ProjectStore, change: ChangeRecord): { judged: Reached[]; notJudged: NotJudgedEntry[] } {
  const judged = new Map<string, Set<string>>();
  const notJudged = new Map<string, NotJudgedReason>();
  const at = now();
  // An object another item of the same piece of work changed is still judged when it lies downstream of this item
  // (D56 rule 2): that the work touched it is evidence, not a conclusion. Only the item's own subject is excluded,
  // and `rawDownstream` does that.
  for (const item of itemsOf(change)) {
    // The walk is run once without the filter, so the change's detail can list what was left out and why.
    for (const id of rawDownstream(store, item, 2)) {
      const reason = notJudgedReason(store, id);
      if (reason) { if (!notJudged.has(id)) notJudged.set(id, reason); continue; }
      if (!judged.has(id)) judged.set(id, new Set());
      judged.get(id)!.add(item.id);
    }
  }
  return {
    judged: [...judged].map(([nodeId, itemIds]) => ({ nodeId, itemIds: [...itemIds] })),
    notJudged: [...notJudged].map(([nodeId, reason]) => ({ nodeId, reason, at })),
  };
}

/** The walk without the not-judged filter, so the callers above can list what was left out and why. */
function rawDownstream(store: ProjectStore, item: Pick<ChangeItem, 'affects'>, depth = 2): string[] {
  const subjects = new Set(item.affects);
  const out = new Set<string>();
  const relations = store.relations.all();
  // `left` is how many edges may still be crossed from `id`. Stopping at `left < 0` crossed one edge more than
  // the rule allows: from depth 2 the walk reached a third object, which was then judged against a change two
  // steps removed from it.
  const walk = (id: string, left: number) => {
    if (left <= 0) return;
    for (const r of relations) {
      if (r.to !== id || !DOWNSTREAM_RELATIONS.includes(r.type)) continue;
      if (subjects.has(r.from) || out.has(r.from)) continue;
      out.add(r.from);
      walk(r.from, left - 1);
    }
  };
  for (const s of subjects) walk(s, depth);
  return [...out].filter((id) => objectExists(store, id));
}

/**
 * Move every object that is never judged out of the change records' pending entries and into the record's own
 * `notJudged` list, so it is shown in the change's detail and counted nowhere else. Returns how many it moved.
 * Runs before each round: a decision or a `Done` work item may have become one since the entry was made.
 */
export function settleNotJudged(store: ProjectStore, at = now()): number {
  let moved = 0;
  for (const change of store.changes.all()) {
    const keep: PropagationEntry[] = [];
    const listed = new Map<string, NotJudgedEntry>((change.notJudged ?? []).map((e) => [e.nodeId, e]));
    for (const p of change.propagation) {
      const reason = notJudgedReason(store, p.nodeId);
      if (!reason) { keep.push(p); continue; }
      moved++;
      listed.set(p.nodeId, { nodeId: p.nodeId, reason, at });
    }
    if (keep.length === change.propagation.length && listed.size === (change.notJudged ?? []).length) continue;
    store.changes.put({ ...change, propagation: keep, notJudged: [...listed.values()], updatedAt: at });
  }
  return moved;
}

// ───────────────────────── one judgement per object per round ─────────────────────────

export const roundIdOf = (n: number) => `round_${String(n).padStart(4, '0')}`;

/** The round now open, or null. A round is open from when it starts until its result is written. */
export function openRound(store: ProjectStore) {
  return store.rounds.filter((r) => r.endedAt === null).sort((a, b) => b.number - a.number)[0] ?? null;
}

/** Open the next round, or return the one already open. The main job of the round owns it (§3.3). */
export function startRound(store: ProjectStore, projectId: string, mainJobId: string | null = null, at = now()) {
  const already = openRound(store);
  if (already) return already;
  const number = Math.max(0, ...store.rounds.all().map((r) => r.number)) + 1;
  // Before a round begins, whatever has become a point-in-time record or a decision since the entries were made is
  // moved out of what is pending, so no round ever hands one to a model (§2.10).
  settleNotJudged(store, at);
  const round = { id: roundIdOf(number), projectId, number, startedAt: at, endedAt: null, mainJobId, result: null };
  store.rounds.put(round, { jobId: mainJobId, summary: `Follow up round ${number} started` });
  return round;
}

/**
 * A round id's number. Round ids are compared by this and never as strings: `roundIdOf` pads to four digits, so
 * from `round_10000` on the dictionary order stops matching the numeric one and `round_9999 < round_10000` is
 * false — a project that long-lived would silently carry the wrong round's judgement forward.
 */
export function roundNumberOf(roundId: string): number {
  const n = Number.parseInt(roundId.replace(/^round_/, ''), 10);
  return Number.isFinite(n) ? n : -1;
}

/** The object's judgement from the round before this one, if any. */
export function lastJudgement(store: ProjectStore, nodeId: string, beforeRoundId: string): ObjectJudgement | null {
  const before = roundNumberOf(beforeRoundId);
  return store.propagation.filter((j) => j.nodeId === nodeId && roundNumberOf(j.roundId) < before)
    .sort((a, b) => roundNumberOf(b.roundId) - roundNumberOf(a.roundId))[0] ?? null;
}

export const sameItem = (a: ItemRef, b: ItemRef) => a.changeId === b.changeId && a.itemId === b.itemId;

/** Where one item stands on an object after the rounds before this one. */
export type ItemStanding = { readonly kind: 'concluded' } | { readonly kind: 'lacked'; readonly lacked: LackedItem } | { readonly kind: 'open' };

/**
 * Where every item that ever reached an object stands, over all the rounds before `beforeRoundId` — not only the
 * latest one. An item is concluded once a judgement followed it, closed it, or covered it with a state that settles
 * it (`Updated`, `Reusable as is`, or `Still on old understanding` without naming it as lacked — the per-record
 * entries already read those as followed); it is lacked while the latest judgement that names it lists it as lacked;
 * it is open when only `Not yet checked` ever covered it. A concluded item stays concluded (§2.10).
 */
export function itemStandings(store: ProjectStore, nodeId: string, beforeRoundId: string): Map<string, ItemStanding> {
  const before = roundNumberOf(beforeRoundId);
  const judgements = store.propagation.filter((j) => j.nodeId === nodeId && roundNumberOf(j.roundId) < before)
    .sort((a, b) => roundNumberOf(a.roundId) - roundNumberOf(b.roundId));
  const standing = new Map<string, ItemStanding>();
  for (const j of judgements) {
    for (const ref of [...j.covers, ...j.lacks.filter((l) => !j.covers.some((c) => sameItem(c, l)))]) {
      const key = itemKey(ref);
      if (standing.get(key)?.kind === 'concluded') continue;
      const lacked = j.lacks.find((l) => sameItem(l, ref));
      if (lacked) standing.set(key, { kind: 'lacked', lacked });
      else if (j.closed.some((c) => sameItem(c, ref)) || j.followed.some((f) => sameItem(f, ref)) || j.state !== 'Not yet checked') standing.set(key, { kind: 'concluded' });
      else if (!standing.has(key)) standing.set(key, { kind: 'open' });
    }
  }
  return standing;
}
/** The key `itemStandings` files one item of one record under. */
export const itemKey = (r: ItemRef) => `${r.changeId}\0${r.itemId}`;

/**
 * The items this round has to judge for one object (Spec v2.8 §2.10, §5.5; CKC-11 AC-12): the items that reached it
 * and have no conclusion yet, together with what it still lacks. What it still lacks is judged again only alongside
 * something new, or once the object itself has moved since its last judgement — "the previous round's outstanding
 * items are not judged again while the object has not moved". An item that already has a conclusion is never judged
 * again, however often the object is modified: the object's whole history is not walked again (E50, and the Product
 * architect's reading written into §2.10 on 2026-09-21).
 */
export function itemsForObject(store: ProjectStore, nodeId: string, roundId: string): { covers: ItemRef[]; carried: LackedItem[] } {
  const previous = lastJudgement(store, nodeId, roundId);
  const movedSince = previous !== null && objectUpdatedAt(store, nodeId) > previous.objectUpdatedAt;
  const standings = itemStandings(store, nodeId, roundId);
  const covers: ItemRef[] = [];
  for (const change of store.changes.all()) {
    for (const p of change.propagation) {
      if (p.nodeId !== nodeId) continue;
      // Only the items that actually reached this object. An entry written before the seeding recorded which item
      // arrived carries no `itemIds` and is read as the whole record, the way it was meant when it was written.
      const reached = p.itemIds ? itemsOf(change).filter((i) => p.itemIds!.includes(i.id)) : itemsOf(change);
      for (const item of reached) {
        const ref = { changeId: change.id, itemId: item.id };
        const standing = standings.get(itemKey(ref));
        if (standing?.kind === 'concluded') continue;
        if (standing?.kind === 'lacked' && !movedSince) continue;
        if (!covers.some((c) => sameItem(c, ref))) covers.push(ref);
      }
    }
  }
  const carried = [...standings.values()].flatMap((s) => (s.kind === 'lacked' ? [s.lacked] : []));
  return { covers, carried };
}

export interface JudgeInput {
  readonly nodeId: string;
  readonly state: Propagation;
  readonly sourceOrReason: string;
  readonly followed?: readonly ItemRef[];
  readonly lacks?: readonly LackedItem[];
  readonly closed?: readonly ClosedItem[];
  readonly jobId?: string | null;
}

/**
 * Write one object's judgement for one round, and fan it out to the entries inside the change records so every
 * existing view of a change shows the same conclusion. A second judgement of the same object in the same round
 * replaces the first: one object, one state, one round.
 */
export function judgeObject(store: ProjectStore, projectId: string, roundId: string, input: JudgeInput, at = now()): ObjectJudgement {
  const id = `${roundId}:${input.nodeId}`;
  const existing = store.propagation.get(id);
  const { covers, carried } = itemsForObject(store, input.nodeId, roundId);
  // What the previous round left open is judged again together with what arrived since, never dropped. §5.5 ends
  // an item in exactly three ways — the object followed it, a later change superseded it, or the owner or holder
  // said it need not be handled — and taking only `covers` here was a fourth: an item still lacked last round
  // disappeared without any of them the moment a new change reached the same object.
  const carriedRefs: ItemRef[] = carried.filter((l) => store.changes.has(l.changeId)).map((l) => ({ changeId: l.changeId, itemId: l.itemId }));
  const reached = [...covers, ...carriedRefs.filter((c) => !covers.some((x) => sameItem(x, c)))];
  const all = existing ? [...reached, ...existing.covers.filter((c) => !reached.some((x) => sameItem(x, c)))] : reached;
  const known = (r: ItemRef) => all.some((c) => sameItem(c, r));
  // A caller that names only the record means all of its items: the judgement is about the whole piece of work.
  const expand = <T extends ItemRef>(refs: readonly T[]): T[] => refs.flatMap((r) => {
    if (r.itemId) return [r];
    const change = store.changes.get(r.changeId);
    return change ? itemsOf(change).map((i) => ({ ...r, itemId: i.id })) : [r];
  });
  // Where the object stood before this call: what this round has already concluded, or — on the round's first call
  // — what the previous round left open.
  const wasLacking: readonly LackedItem[] = existing ? existing.lacks : carried.filter(known);
  const wasFollowed = existing?.followed ?? [];
  const wasClosed = existing?.closed ?? [];
  const take = <T extends ItemRef>(refs: readonly T[] | undefined): T[] => expand(refs ?? []).filter(known);
  const saysLacks = take(input.lacks);
  const saysClosed = take(input.closed).filter((c) => !saysLacks.some((l) => sameItem(l, c)));
  const saysFollowed = take(input.followed).filter((f) => ![...saysLacks, ...saysClosed].some((x) => sameItem(x, f)));
  const named = [...saysLacks, ...saysClosed, ...saysFollowed];
  // An item this call names moves to the bucket the call put it in and leaves the others. A union kept the earlier
  // conclusion instead, so a second look in the same round could add a lacked item but never take one back: a
  // re-check that found the object had followed it after all left the object behind anyway.
  const kept = <T extends ItemRef>(before: readonly T[]): T[] => before.filter((o) => !named.some((n) => sameItem(n, o)));
  const lacks = [...saysLacks, ...kept(wasLacking)];
  const closed = [...saysClosed, ...kept(wasClosed)].filter((c) => !lacks.some((l) => sameItem(l, c)));
  const followed = [...saysFollowed, ...kept(wasFollowed)].filter((f) => ![...lacks, ...closed].some((x) => sameItem(x, f)));
  // One object, one state: a second call in the same round adds to the one judgement instead of writing another,
  // and anything the object still lacks decides the state however the call phrased it.
  const state: Propagation = lacks.length > 0 ? 'Still on old understanding' : input.state;
  const reason = existing && existing.sourceOrReason && existing.sourceOrReason !== input.sourceOrReason
    ? `${existing.sourceOrReason} · ${input.sourceOrReason}` : input.sourceOrReason;
  const judgement: ObjectJudgement = {
    id, projectId, nodeId: input.nodeId, roundId, state, sourceOrReason: reason,
    covers: all, followed, lacks, closed,
    objectUpdatedAt: objectUpdatedAt(store, input.nodeId), jobId: input.jobId ?? existing?.jobId ?? null, at,
  };
  store.propagation.put(judgement, { jobId: judgement.jobId, summary: `${state}: ${input.nodeId} (round ${roundId})` });
  // The per-record entries follow from the one judgement; nothing else writes them, so a change's own detail and
  // the object's state can never disagree.
  const lacking = new Set(lacks.map((l) => l.changeId));
  for (const change of store.changes.all()) {
    if (!change.propagation.some((p) => p.nodeId === input.nodeId)) continue;
    const items = all.filter((c) => c.changeId === change.id);
    if (!items.length) continue;
    const perChange: Propagation = state === 'Still on old understanding' && !lacking.has(change.id) ? 'Updated' : state;
    // An entry's `itemIds` record what reached the object, not what this round judged, so they never shrink: a
    // round that judges only a newly arrived item must not erase the older item that an earlier round settled, or
    // the next round after the object moves would never ask about it again.
    const before = change.propagation.find((p) => p.nodeId === input.nodeId);
    const entry: PropagationEntry = {
      nodeId: input.nodeId, state: perChange, sourceOrReason: reason, updatedAt: at, roundId,
      itemIds: [...new Set([...(before?.itemIds ?? []), ...items.map((i) => i.itemId)])],
    };
    store.changes.put({ ...change, propagation: change.propagation.map((p) => (p.nodeId === input.nodeId ? entry : p)), updatedAt: at });
  }
  return judgement;
}

// ───────────────────────── where a mark may hang ─────────────────────────

/** What a mark on a point-in-time record is about: the record's own time, or something that happened after it. */
export const MARK_ABOUT = ['At its own time', 'A later change'] as const;
export type MarkAbout = (typeof MARK_ABOUT)[number];

/**
 * Why this mark may not be written, or null when it may (Spec §1.11; CKC-02 AC-22). Three rules:
 * a mark never hangs on another mark or on a note, because both are judgements about something else; a
 * point-in-time record does not get `Suspected stale` or `Layer drift` because of something that happened later —
 * that belongs on the current object that still uses the old content — though a doubt about whether the record was
 * true at its own time may still hang on it; and a mark that names neither what differs nor what it was checked
 * against is never shown to an agent (§7.1), so writing one only hides it.
 */
export function markRefusal(
  store: ProjectStore, kind: string, targetId: string,
  clue: string, clueSourceIds: readonly string[], about: MarkAbout | null,
): string | null {
  if (isJudgementRecord(store, targetId)) {
    return store.notes.has(targetId) || targetId.startsWith('note_')
      ? `A mark does not hang on a note. A note that has gone stale is updated by a re-look, or closed as Resolved or Withdrawn with pk_close_note. Hang the mark on the object the note is about.`
      : `A mark does not hang on another mark. When the same doubt comes up again, update the clue of the mark that is already there (pk_write_mark with the same kind and targetId does exactly that).`;
  }
  if (clue.trim().length === 0 || clueSourceIds.length === 0) {
    return `A mark that cannot be checked does not exist: the pack only prints a mark that says what differs and names the material it was checked against. Add clue: what differs, in one sentence${clueSourceIds.length === 0 ? ', and clueSourceIds: the source ids you checked it against' : ''}.`;
  }
  if ((kind === 'Suspected stale' || kind === 'Layer drift') && isPointInTime(store, targetId) && about !== 'At its own time') {
    return `${kind} does not hang on a point-in-time record because of something that happened later: it records how things stood when it was written. Hang it on the current object that still uses the old content. If instead you doubt whether this record was true at its own time — the material says it is done and the evidence contradicts that — say so with about: "At its own time" and let the clue name the contradiction.`;
  }
  return null;
}

// ───────────────────────── notes and requests of one round ─────────────────────────

/**
 * A current note already on this mount about the same matter, or null. The round writes one note per matter, not
 * one per object: on the 2026-09-18 assets five mount points carried duplicate notes about the same thing.
 */
export function duplicateNote(store: ProjectStore, mountIds: readonly string[], changeIds: readonly string[], title: string, exceptId: string) {
  const mounts = new Set(mountIds);
  const changes = new Set(changeIds);
  const key = normalise(title);
  return store.notes.find((n) => {
    if (n.id === exceptId || n.status !== 'Current') return false;
    if (!n.mount.ids.some((id) => mounts.has(id))) return false;
    const version = n.versions[n.versions.length - 1];
    if (version && normalise(version.title) === key) return true;
    return changes.size > 0 && (n.cameFrom?.changeIds ?? []).some((id) => changes.has(id));
  }) ?? null;
}

/** The request this round already holds for that holder, or null: one holder gets one request per round (§5.4). */
export function requestForHolder(store: ProjectStore, holder: string, roundId: string | null) {
  if (!roundId) return null;
  return store.requests.find((r) => r.holder === holder && r.roundId === roundId && !r.handled) ?? null;
}

// ───────────────────────── the round's one result ─────────────────────────

/** Every count the round's result carries, taken from the assets (D43). No model writes these. */
export function countRound(store: ProjectStore, roundId: string) {
  const judgements = store.propagation.filter((j) => j.roundId === roundId);
  const byState: Record<string, number> = {};
  for (const j of judgements) byState[j.state] = (byState[j.state] ?? 0) + 1;
  const behind = judgements.filter((j) => j.state === 'Still on old understanding');
  const requests = store.requests.filter((r) => r.roundId === roundId);
  // Judgements and requests carry the round they belong to. Notes, marks and reference items do not, so they are
  // attributed by the round's own window: from when it started until it ended, and for the open round up to now.
  // Counting everything from the round's start with no end let a closed round's result report what later rounds
  // wrote, and taking the not-judged objects from every record of every round reported the project's history as
  // this round's number — a round that added none still showed the historical total.
  const round = store.rounds.get(roundId);
  const from = round?.startedAt ?? '';
  const to = round?.endedAt ?? '9999';
  const inRound = (at: string) => at >= from && at <= to;
  const notes = store.notes.filter((n) => n.cameFrom?.kind === 'Change follow-up' && inRound(n.updatedAt));
  const notJudged = new Set(store.changes.all().flatMap((c) => (c.notJudged ?? []).filter((e) => inRound(e.at)).map((e) => e.nodeId)));
  // What the new decisions superseded this round, counted both ways §5.5 allows: a decision replaced as a whole,
  // and a decision one part of which was superseded while the rest stays in force. Counting only `Replaced` left
  // every partial supersession out of the round result's account of what the new decisions replaced — and partial
  // is the ordinary case, since a later decision usually changes one clause.
  const replaced = store.reference.filter((r) => isDecision(store, r.id) && (
    (r.validity === 'Replaced' && inRound(r.updatedAt)) || (r.supersededParts ?? []).some((s) => inRound(s.at))
  ));
  const suspected = store.marks.filter((m) => m.kind === 'Suspected stale' && !m.closed && isDecision(store, m.targetId) && inRound(m.since));
  return {
    counts: {
      objectsJudged: judgements.length, byState, behind: behind.length,
      itemsLacked: behind.reduce((n, j) => n + j.lacks.length, 0), notJudged: notJudged.size,
      requests: requests.length, notes: notes.length,
      decisionsReplaced: replaced.length, decisionsSuspected: suspected.length,
    },
    behindJudgements: behind, requests, noteIds: notes.map((n) => n.id),
  };
}

/**
 * A round's one result (§5.5): the account in words, and everything counted from the assets (D43). An object behind
 * reaches its holder: the holder of the work item or reference item, else the one a request of this round names.
 * `news`: what the round made new with its positions (organize/round-news.ts, §3.8; CKC-07 AC-27), counted into the
 * result beside the propagation account.
 */
export function roundResultOf(store: ProjectStore, roundId: string, summary: string, at: string, news: RoundNews | null = null): RoundResult {
  const counted = countRound(store, roundId);
  const holderOf = (nodeId: string) => store.threads.get(nodeId)?.attribution.holder?.role ?? store.reference.get(nodeId)?.attribution.holder?.role ?? counted.requests.find((r) => r.impact.includes(nodeId))?.holder ?? null;
  const fresh = (s: { detail: string | null }) => s.detail?.startsWith('new') === true;
  return {
    at, summary,
    counts: news ? { ...counted.counts, news: { breakpoints: news.breakpoints.length, sendbacksNew: news.sendbacks.filter(fresh).length, sendbacksMoved: news.sendbacks.filter((s) => !fresh(s)).length, sixThings: news.sixThings.length, patches: news.patches.length, notes: news.notes.length } } : counted.counts,
    behind: counted.behindJudgements.map((j) => ({ nodeId: j.nodeId, holder: holderOf(j.nodeId), lacks: j.lacks.length })),
    byHolder: counted.requests.map((r) => ({ holder: r.holder, requestId: r.id, nodeIds: r.impact })),
    noteIds: counted.noteIds,
    unassigned: counted.behindJudgements.filter((j) => holderOf(j.nodeId) === null).map((j) => j.nodeId),
    ...(news ? { news } : {}),
  };
}
