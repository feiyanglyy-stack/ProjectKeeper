/**
 * What a Follow up round made new (Spec §3.8, §5.5, §6.2; D79; CKC-07 AC-27, CKC-24 AC-15): Follow up is how the owner
 * sees what is new, so each round with news has one item in `Notes (attention)` listing, each with its position,
 *   - the breakpoints it newly lit,
 *   - the send-backs that are new or moved to another stage,
 *   - what newly became one of the six things the owner judges,
 *   - the semantic patches it confirmed,
 *   - the notes it wrote or updated;
 * and a round with nothing new says so, for the top bar (QC AY B2: the item used to exist only when objects were left
 * behind, in the old propagation words, and "nothing new" was said nowhere).
 *
 * Counted by the program, never by a model: the candidates are what the round's jobs wrote — its steps, its root job and
 * what they delegated, from the store's trace — and each is compared with where things stood when the round started
 * (`RoundBaseline`, kept on the round from its start to its close). A write by someone else in the meantime — the
 * owner's conversation, an investigation the owner asked for — is not the round's news.
 */
import { join } from 'node:path';
import type { ClerkRound, RoundBaseline, RoundNews, RoundNewsItem, SixThing } from '../../model/k-types.ts';
import type { Note, TraceEntry } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { readJsonLines } from '../../store/json-file.ts';

const SIX_NAME: Readonly<Record<SixThing, string>> = { 1: 'stale', 2: 'drift', 3: 'dropped along the way', 4: 'grown by itself', 5: 'let pass', 6: 'looks residual' };
const clip = (s: string, n = 140): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A territory anomaly's key: it has no id of its own, and its index moves when the anomalies are written again. */
const anomalyKey = (territoryId: string, a: { kind: string; text: string }) => `anomaly:${territoryId}:${a.kind}:${a.text.slice(0, 120)}`;

/** Where the five kinds of news stand now (the baseline a Follow up round keeps from its start). */
export function roundBaseline(store: ProjectStore): RoundBaseline {
  return {
    litBreakpoints: store.breakpoints.filter((b) => b.lit).map((b) => b.id),
    sendbackStages: Object.fromEntries(store.sendbacks.all().map((s) => [s.id, s.stage])),
    sixThings: Object.fromEntries(liveSixThings(store).map((x) => [x.key, x.six])),
    confirmedPatches: store.patches.filter((p) => p.status === 'Confirmed').map((p) => p.id),
    noteVersions: Object.fromEntries(store.notes.all().map((n) => [n.id, n.versions.length])),
  };
}

/** What the owner sees an object as: a work item by its number and title, a reference item, a territory, a node. */
function labelOf(store: ProjectStore, id: string): string {
  const t = store.threads.get(id);
  if (t) return `${t.ids[0] ? `${t.ids[0]} ` : ''}${t.title}`;
  return store.reference.get(id)?.name ?? store.territories.get(id)?.name ?? store.nodes.get(id)?.label ?? id;
}

function notePosition(store: ProjectStore, n: Note): { position: string; objectId: string | null } {
  const v = n.versions[n.versions.length - 1];
  const asking = (v?.ask === 'For your decision' || v?.ask === 'Worth discussing') && n.status === 'Current';
  const on = n.mount.kind === 'project' ? 'the project' : n.mount.ids.map((id) => labelOf(store, id)).join(', ') || 'the project';
  return { position: `${asking ? 'Notes (attention)' : 'Notes log'} · on ${on}`, objectId: n.mount.kind === 'project' ? null : n.mount.ids[0] ?? null };
}

/** Everything that is one of the six things now and still live, keyed as the baseline keeps it. */
function liveSixThings(store: ProjectStore): { key: string; six: SixThing; id: string; what: string; position: string; objectId: string | null }[] {
  const out: { key: string; six: SixThing; id: string; what: string; position: string; objectId: string | null }[] = [];
  for (const m of store.marks.all()) if (m.sixThing && !m.closed) out.push({ key: `mark:${m.id}`, six: m.sixThing, id: m.id, what: `mark ${m.kind} on ${labelOf(store, m.targetId)}`, position: `Mark on ${labelOf(store, m.targetId)}`, objectId: m.targetId });
  for (const n of store.notes.all()) if (n.sixThing && n.status === 'Current') { const p = notePosition(store, n); out.push({ key: `note:${n.id}`, six: n.sixThing, id: n.id, what: `note “${n.versions[n.versions.length - 1]?.title ?? n.id}”`, position: p.position, objectId: p.objectId }); }
  for (const b of store.breakpoints.all()) if (b.sixThing && b.lit && !b.ownerResponse) out.push({ key: `breakpoint:${b.id}`, six: b.sixThing, id: b.id, what: `breakpoint ${b.kind} on ${labelOf(store, b.targetId)}`, position: `Process view · ${labelOf(store, b.targetId)}`, objectId: b.targetId });
  for (const s of store.sendbacks.all()) if (s.sixThing && s.stage !== 'Closed' && !s.ownerResponse) out.push({ key: `sendback:${s.id}`, six: s.sixThing, id: s.id, what: `send-back to ${s.to} on ${labelOf(store, s.targetId)}`, position: `Process view · ${labelOf(store, s.targetId)} · Reality`, objectId: s.targetId });
  for (const t of store.territories.all()) for (const a of t.anomalies) if (a.sixThing) out.push({ key: anomalyKey(t.id, a), six: a.sixThing, id: t.id, what: `code anomaly ${a.kind} in ${t.name}`, position: `Code view · ${t.name}`, objectId: t.id });
  return out;
}

/** Every job of a round: its steps, its root, and what they delegated, however deep. */
export function roundJobIds(store: ProjectStore, round: ClerkRound): Set<string> {
  const ids = new Set<string>([round.rootJobId, ...store.jobs.filter((j) => j.step?.roundId === round.id).map((j) => j.id)]);
  for (let grew = true; grew;) {
    grew = false;
    for (const j of store.jobs.all()) if (j.parentJobId && ids.has(j.parentJobId) && !ids.has(j.id)) { ids.add(j.id); grew = true; }
  }
  return ids;
}

/** The ids each collection's records the round's jobs wrote (one read of the trace). */
function touchedBy(store: ProjectStore, jobIds: ReadonlySet<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of readJsonLines<TraceEntry>(join(store.dir, 'trace.jsonl'))) {
    if (e.op !== 'put' || !e.jobId || !jobIds.has(e.jobId)) continue;
    if (!out.has(e.collection)) out.set(e.collection, new Set());
    out.get(e.collection)!.add(e.id);
  }
  return out;
}

/**
 * The round's news: what its jobs wrote, against where things stood at its start. Without a baseline (a round begun
 * before rounds kept one), what can be told from the records alone is counted — breakpoints the round lit, send-backs it
 * created, notes it wrote in its window — and the result says it is not complete.
 */
export function roundNews(store: ProjectStore, round: ClerkRound, behind = 0, now = new Date().toISOString()): RoundNews {
  const base = round.baseline ?? null;
  const touched = touchedBy(store, roundJobIds(store, round));
  const ids = (collection: string) => [...(touched.get(collection) ?? [])];

  const breakpoints: RoundNewsItem[] = [];
  for (const id of ids('breakpoints')) {
    const b = store.breakpoints.get(id);
    if (!b || !b.lit || b.ownerResponse) continue;
    if (base ? base.litBreakpoints.includes(id) : b.roundId !== round.id) continue;
    const on = labelOf(store, b.targetId);
    breakpoints.push({ id, label: `${b.kind} on ${on}`, position: `Process view · ${on}`, objectId: b.targetId, detail: clip(b.why) });
  }

  const sendbacks: RoundNewsItem[] = [];
  for (const id of ids('sendbacks')) {
    const s = store.sendbacks.get(id);
    if (!s || s.ownerResponse) continue;
    const before = base ? base.sendbackStages[id] : undefined;
    const isNew = base ? before === undefined : s.roundId === round.id;
    const moved = base ? before !== undefined && before !== s.stage : false;
    if (!isNew && !moved) continue;
    const on = labelOf(store, s.targetId);
    sendbacks.push({ id, label: `Send-back to ${s.to} on ${on}: ${clip(s.what, 100)}`, position: `Process view · ${on} · Reality (Copy for agent)`, objectId: s.targetId, detail: isNew ? `new · ${s.stage}` : `${before} → ${s.stage}` });
  }

  const sixThings: RoundNewsItem[] = [];
  const touchedSix = new Set([...ids('marks').map((id) => `mark:${id}`), ...ids('notes').map((id) => `note:${id}`), ...ids('breakpoints').map((id) => `breakpoint:${id}`), ...ids('sendbacks').map((id) => `sendback:${id}`)]);
  const touchedTerritories = new Set(ids('territories'));
  for (const x of liveSixThings(store)) {
    const mine = x.key.startsWith('anomaly:') ? touchedTerritories.has(x.id) : touchedSix.has(x.key);
    if (!mine) continue;
    if (base) { if (base.sixThings[x.key] === x.six) continue; }
    else if (!breakpoints.some((b) => `breakpoint:${b.id}` === x.key) && !sendbacks.some((s) => `sendback:${s.id}` === x.key) && !(x.key.startsWith('note:') && store.notes.get(x.id)?.versions[0]?.at && store.notes.get(x.id)!.versions[0]!.at >= round.startedAt)) continue;
    sixThings.push({ id: x.id, label: `${x.six} ${SIX_NAME[x.six]} · ${x.what}`, position: x.position, objectId: x.objectId, detail: `${x.six} ${SIX_NAME[x.six]}` });
  }

  const patches: RoundNewsItem[] = [];
  if (base) for (const id of ids('patches')) {
    const p = store.patches.get(id);
    if (!p || p.status !== 'Confirmed' || base.confirmedPatches.includes(id)) continue;
    const on = p.affects.map((a) => labelOf(store, a)).join(', ') || p.oldAnchor.label;
    patches.push({ id, label: `${p.number} ${p.title}`, position: `Struck through on ${on}${p.writtenToFolder ? ' · project folder' : ''}`, objectId: p.affects[0] ?? null, detail: p.partial ? 'part of the old state withdrawn' : null });
  }

  const notes: RoundNewsItem[] = [];
  for (const id of ids('notes')) {
    const n = store.notes.get(id);
    if (!n || n.status !== 'Current') continue;
    const had = base ? base.noteVersions[id] : undefined;
    const written = base ? had === undefined || n.versions.length > had : n.versions.some((v) => v.at >= round.startedAt && v.at <= now);
    if (!written) continue;
    const v = n.versions[n.versions.length - 1]!;
    const p = notePosition(store, n);
    notes.push({ id, label: v.title, position: p.position, objectId: p.objectId, detail: n.versions.length === 1 ? 'new' : `v${n.versions.length}` });
  }

  const parts = [
    breakpoints.length ? `${plural(breakpoints.length, 'breakpoint')} newly lit` : '',
    sendbacks.filter((s) => s.detail?.startsWith('new')).length ? plural(sendbacks.filter((s) => s.detail?.startsWith('new')).length, 'new send-back') : '',
    sendbacks.filter((s) => !s.detail?.startsWith('new')).length ? `${plural(sendbacks.filter((s) => !s.detail?.startsWith('new')).length, 'send-back')} moved` : '',
    sixThings.length ? `${sixThings.length} newly among the six things` : '',
    patches.length ? `${plural(patches.length, 'semantic patch', 'semantic patches')} confirmed` : '',
    notes.length ? `${plural(notes.length, 'note')} written or updated` : '',
    behind ? `${plural(behind, 'object')} still on the old understanding` : '',
  ].filter(Boolean);
  const nothingNew = parts.length === 0;
  return {
    breakpoints, sendbacks, sixThings, patches, notes, nothingNew,
    statement: nothingNew ? `Follow up round ${round.number} found nothing new` : parts.join(' · '),
    complete: base !== null,
  };
}
