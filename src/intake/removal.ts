/**
 * Deletion means "no longer needed" (D61; Spec §2.1, §2.6, §7.1; CKC-02 AC-5, AC-23), recorded by the program when
 * intake finds a file deleted from the project's current version — not moved:
 *
 * - an object whose material is now all gone becomes `Removed`, and one change record says what was removed and why;
 * - an object that still has other material keeps its validity, and is marked `Suspected stale` on itself, because
 *   part of what it rests on is gone;
 * - a current object that relies on something removed is marked on itself, never the removed object (§1.11);
 * - when the material comes back, what the program removed returns to the validity it had, and the program's marks
 *   close. What the Keeper or the owner judged `Removed` is theirs and is not touched.
 *
 * Moves into a place the project keeps for archive, recovery or deletion are judged by the round's main job by the
 * project's rules (§1.15), not here. A whole scope location that vanished — a drive, a removed worktree — is not a
 * deletion of the project's content, so nothing is removed for it. No model is involved.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Attribution, ChangeItem, ChangeRecord, EntryMark, Project, ProjectRule, ReferenceItem, Source, WorkThread } from '../model/types.ts';
import { VALIDITY, isOneOf, type Validity } from '../model/vocab.ts';
import { stableId } from '../model/ids.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { markRefusal } from '../keeper/adjustment.ts';
import { commitSourceId } from '../sources/anchor.ts';
import { isHistoryOnly } from '../sources/history.ts';
import { gitPathFates, gitToplevel, type CommitMeta, type PathFate } from '../util/git.ts';
import { isWithin, relativeDisplay } from '../util/paths.ts';

export interface DeletedFile {
  readonly path: string;
  readonly scopeItemId: string;
  readonly sourceIds: readonly string[];
  /** The commit that deleted it, when git knows one; null for a deletion in the working tree; absent: not asked yet. */
  readonly deletedIn?: CommitMeta | null;
}

/**
 * What git says became of files that are gone from disk, for the ones inside a repository of the scope: deleted by a
 * commit, or moved away by a commit to a file that is still there (where, absolute) — also outside the scope. A file
 * moved and then deleted, or moved on again, is followed to what finally became of it. No entry: nothing committed says
 * (a change in the working tree). A few questions per repository, however many files.
 */
export function gitFates(project: Project, paths: readonly string[]): Map<string, { fate: PathFate; movedTo: string | null }> {
  const out = new Map<string, { fate: PathFate; movedTo: string | null }>();
  const tops = new Map<string, string | null>();
  const byTop = new Map<string, string[]>();
  for (const path of paths) {
    const item = project.scope.filter((i) => i.category !== 'Session source' && i.relation !== 'Excluded' && i.versionControl !== 'none' && isWithin(i.path, path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!item || !existsSync(item.path)) continue;
    if (!tops.has(item.path)) tops.set(item.path, gitToplevel(item.path));
    const top = tops.get(item.path);
    if (!top || !isWithin(top, path)) continue;
    const list = byTop.get(top) ?? [];
    list.push(path);
    byTop.set(top, list);
  }
  for (const [top, list] of byTop) {
    const origin = new Map(list.map((p) => [relativeDisplay(top, p), p]));   // the path asked about → the file that is gone
    const seen = new Set(origin.keys());
    let ask = [...origin.keys()];
    while (ask.length) {
      const next: string[] = [];
      for (const [rel, fate] of gitPathFates(top, ask)) {
        const gone = origin.get(rel);
        if (!fate || gone === undefined) continue;
        if (fate.kind === 'deleted') { out.set(gone, { fate, movedTo: null }); continue; }
        const to = join(top, ...fate.to.split('/'));
        if (existsSync(to)) { out.set(gone, { fate, movedTo: to }); continue; }
        if (seen.has(fate.to)) continue;
        seen.add(fate.to);
        origin.set(fate.to, gone);
        next.push(fate.to);
      }
      ask = next;
    }
  }
  return out;
}

export interface RemovalOutcome {
  readonly removed: readonly string[];
  readonly marked: readonly string[];
  readonly changeIds: readonly string[];
}

/** Every mark the program writes about a deletion says this, and nothing the Keeper writes is expected to. */
const DELETED = 'deleted from the project’s current version';
/** A current object relies on another through these (§1.6): it serves, refines, implements, verifies, depends on or carries it out. */
const RELIES = ['serves', 'refines', 'implements', 'verifies', 'depends on', 'carries out'];
/** What a deletion turns into `Removed`: what was in force, proposed, deferred or not yet judged. What was already replaced or
 *  abandoned keeps saying by what and why. */
const REMOVABLE: readonly Validity[] = ['Current', 'Proposed', 'Deferred', 'Unjudged'];
const PROGRAM: Attribution = { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' };

type Obj =
  | { readonly kind: 'reference'; readonly item: ReferenceItem }
  | { readonly kind: 'thread'; readonly item: WorkThread }
  | { readonly kind: 'rule'; readonly item: ProjectRule };

const nameOf = (o: Obj): string => (o.kind === 'reference' ? o.item.name : o.kind === 'thread' ? o.item.title : o.item.summary);

function objects(store: ProjectStore): Obj[] {
  return [
    ...store.reference.all().map((item) => ({ kind: 'reference' as const, item })),
    ...store.threads.all().map((item) => ({ kind: 'thread' as const, item })),
    ...store.rules.all().map((item) => ({ kind: 'rule' as const, item })),
  ];
}

/** Every source an object rests on: the ones it cites, and for a work item those of its fact records, results and checks. */
function restsOn(store: ProjectStore, o: Obj): string[] {
  if (o.kind !== 'thread') return [...o.item.sourceIds];
  const t = o.item;
  return [...new Set([
    ...t.factRecordIds.flatMap((f) => store.facts.get(f)?.aboutSourceIds ?? []),
    ...[...t.executionFacts, ...t.qcFacts].flatMap((s) => s.sourceIds),
  ])];
}

/** The sources that can carry it as current: history never does, and reference-only material makes no requirement (§1.2). */
function currentBasis(store: ProjectStore, ids: readonly string[]): Source[] {
  return ids.map((id) => store.sources.get(id)).filter((s): s is Source => s !== undefined && !isHistoryOnly(s) && s.usedAs !== 'Reference only');
}

function put(store: ProjectStore, o: Obj, validity: Validity, at: string, summary: string, basis: readonly string[]): void {
  const trace = { jobId: null, basisSourceIds: basis, summary };
  if (o.kind === 'reference') store.reference.put({ ...o.item, validity, validityByRuleId: null, updatedAt: at }, trace);
  else if (o.kind === 'thread') store.threads.put({ ...o.item, validity, validityByRuleId: null, updatedAt: at }, trace);
  else store.rules.put({ ...o.item, validity, updatedAt: at }, trace);
}

/** Write or extend the program's `Suspected stale` on a current object; a mark the Keeper wrote there stands as it is. */
function programMark(store: ProjectStore, project: Project, targetId: string, clue: string, clueSourceIds: readonly string[], at: string): boolean {
  if (markRefusal(store, 'Suspected stale', targetId, clue, clueSourceIds, null)) return false;
  const id = stableId('mark', 'Suspected stale', targetId);
  const existing = store.marks.get(id);
  if (existing && existing.closed === null && !existing.clue.includes(DELETED)) return false;
  const open = existing && existing.closed === null ? existing : null;
  const mark: EntryMark = {
    id, projectId: project.id, kind: 'Suspected stale', targetId,
    clueSourceIds: [...new Set([...(open?.clueSourceIds ?? []), ...clueSourceIds])],
    clue: open ? (open.clue.includes(clue) ? open.clue : `${open.clue} ${clue}`) : clue,
    since: open?.since ?? at, noteId: existing?.noteId ?? null, closed: null,
  };
  store.marks.put(mark, { jobId: null, basisSourceIds: clueSourceIds, summary: `Mark Suspected stale on ${targetId}: ${clue.slice(0, 120)}` });
  return true;
}

interface Deletion { readonly key: string; readonly commit: CommitMeta | null; readonly at: string }

/**
 * Record what a batch of file deletions means for the assets. `deleted` lists the files intake found gone (not moved),
 * each with the sources it had; their availability is already `No longer available`.
 */
export function recordDeletions(store: ProjectStore, project: Project, deleted: readonly DeletedFile[], now = new Date().toISOString()): RemovalOutcome {
  // A location that is gone as a whole is not a deletion of content (a drive, a removed worktree): skip its files.
  const items = new Map(project.scope.map((i) => [i.id, i]));
  const files = deleted.filter((d) => {
    const item = items.get(d.scopeItemId) ?? project.scope.filter((i) => i.category !== 'Session source' && isWithin(i.path, d.path)).sort((a, b) => b.path.length - a.path.length)[0];
    return item !== undefined && item.relation !== 'Excluded' && existsSync(item.path);
  });
  if (files.length === 0) return { removed: [], marked: [], changeIds: [] };

  // How each file was deleted: by a commit git knows (dated by it, and saying why in its own words), or in the working tree.
  const unasked = files.filter((f) => f.deletedIn === undefined).map((f) => f.path);
  const asked = unasked.length ? gitFates(project, unasked) : new Map<string, { fate: PathFate }>();
  const deletionOf = new Map<string, Deletion>();
  for (const f of files) {
    const fate = f.deletedIn === undefined ? asked.get(f.path)?.fate : undefined;
    const commit = f.deletedIn !== undefined ? f.deletedIn : fate?.kind === 'deleted' ? fate.commit : null;
    deletionOf.set(f.path, commit ? { key: commit.hash, commit, at: new Date(commit.at).toISOString() } : { key: `working tree ${now}`, commit: null, at: now });
  }
  const deletedIds = new Set(files.flatMap((f) => f.sourceIds));
  const fileOf = new Map(files.flatMap((f) => f.sourceIds.map((id) => [id, f] as const)));
  const pathsOf = (ids: readonly string[]) => [...new Set(ids.map((id) => fileOf.get(id)?.path).filter((p): p is string => p !== undefined))].map((p) => {
    const root = project.locations.find((l) => isWithin(l, p));
    return root ? relativeDisplay(root, p) : p;
  });

  const removed: { o: Obj; before: Validity; gone: string[] }[] = [];
  const partial: { o: Obj; gone: string[] }[] = [];
  for (const o of objects(store)) {
    const rests = restsOn(store, o);
    const gone = rests.filter((id) => deletedIds.has(id));
    if (gone.length === 0) continue;
    const basis = currentBasis(store, rests);
    if (basis.length === 0) continue;
    if (basis.every((s) => s.availability === 'No longer available')) {
      if (REMOVABLE.includes(o.item.validity)) removed.push({ o, before: o.item.validity, gone });
    } else if (o.item.validity === 'Current' || o.item.validity === 'Proposed' || o.item.validity === 'Deferred') {
      partial.push({ o, gone });
    }
  }

  for (const r of removed) put(store, r.o, 'Removed', now, `Removed: its material was ${DELETED} (${pathsOf(r.gone).join(', ')})`, r.gone);

  // One change record per deletion — the commit that deleted the files, or what the working tree lost — with an item for
  // each object it removed (§1.8, §2.1).
  const changeIds: string[] = [];
  const groups = new Map<string, { deletion: Deletion; entries: typeof removed }>();
  for (const r of removed) {
    const d = r.gone.map((id) => deletionOf.get(fileOf.get(id)!.path)!).sort((a, b) => b.at.localeCompare(a.at))[0]!;
    const g = groups.get(d.key) ?? { deletion: d, entries: [] };
    g.entries.push(r);
    groups.set(d.key, g);
  }
  for (const { deletion, entries } of groups.values()) {
    const c = deletion.commit;
    const recordId = stableId('chg', project.id, 'Removed', deletion.key);
    const commitSource = c ? project.scope.map((i) => commitSourceId(i.path, c.hash)).find((id) => store.sources.has(id)) : undefined;
    const by: Attribution = c ? { ...PROGRAM, author: { ...PROGRAM.author, name: c.author || null } } : PROGRAM;
    const items: ChangeItem[] = entries.map((r) => {
      const paths = pathsOf(r.gone).join(', ');
      return {
        id: stableId('item', recordId, 'Removed', r.o.item.id), at: deletion.at, atSource: c ? 'material' : 'observed',
        material: 'Other', effect: 'Removed', title: `${nameOf(r.o)} removed`,
        summary: `Its material was ${DELETED}: ${paths}${c ? ` (commit ${c.hash.slice(0, 8)}, ${c.author}, ${c.at.slice(0, 10)})` : ' (seen missing from the working tree; no commit records it yet)'}. Deletion means it is no longer needed.`,
        before: r.before, after: 'Removed', sourceIds: [...r.gone, ...(commitSource ? [commitSource] : [])], by, why: c ? c.subject || null : null,
        affects: [r.o.item.id],
      };
    });
    const previous = store.changes.get(recordId);
    const all = [...(previous?.items ?? []).filter((old) => !items.some((i) => i.id === old.id)), ...items].sort((a, b) => a.at.localeCompare(b.at));
    const head = all[0]!;
    const record: ChangeRecord = {
      id: recordId, projectId: project.id, at: head.at, atSource: head.atSource, material: head.material, effect: head.effect,
      title: c ? `Commit ${c.hash.slice(0, 8)} · ${c.subject}` : `Files missing from the working tree (seen ${deletion.at.slice(0, 16).replace('T', ' ')})`,
      summary: all.length > 1 ? all.map((i) => `${i.effect}: ${i.title}`).join('; ') : head.summary, before: head.before, after: head.after,
      sourceIds: [...new Set(all.flatMap((i) => i.sourceIds))], by, affects: [...new Set(all.flatMap((i) => i.affects))],
      propagation: previous?.propagation ?? [], notJudged: previous?.notJudged ?? [], segment: null, createdInJobId: null, updatedAt: now,
      work: { kind: 'Time range', label: c ? `Commit ${c.hash.slice(0, 8)}` : 'Deletions seen in the working tree', sessionId: null, startedAt: deletion.at, endedAt: deletion.at, openEnded: false },
      items: all,
    };
    store.changes.put(record, { jobId: null, basisSourceIds: record.sourceIds, summary: `Change record (deletion): ${items.length} object${items.length === 1 ? '' : 's'} removed` });
    changeIds.push(recordId);
  }

  // Marks go on the current objects that still rely on what was deleted (§2.1, §2.6, §7.1; §1.11 says where).
  const marked = new Set<string>();
  const removedIds = new Set(removed.map((r) => r.o.item.id));
  for (const p of partial) {
    if (programMark(store, project, p.o.item.id, `Part of the material it rests on was ${DELETED}: ${pathsOf(p.gone).join(', ')}. What it says may no longer hold.`, p.gone, now)) marked.add(p.o.item.id);
  }
  for (const r of removed) {
    const id = r.o.item.id;
    const dependents = new Set<string>([
      ...store.relations.filter((rel) => rel.to === id && RELIES.includes(rel.type)).map((rel) => rel.from),
      ...store.reference.filter((x) => x.refines.includes(id)).map((x) => x.id),
      ...store.threads.filter((t) => t.serves.some((s) => s.referenceId === id) || t.dependsOn.some((d) => d.threadId === id)).map((t) => t.id),
      ...(r.o.kind === 'rule' ? [...store.reference.filter((x) => x.validityByRuleId === id).map((x) => x.id), ...store.threads.filter((t) => t.validityByRuleId === id || t.progressByRuleId === id).map((t) => t.id)] : []),
    ]);
    for (const x of dependents) {
      if (removedIds.has(x)) continue;
      const target = store.reference.get(x) ?? store.threads.get(x);
      if (!target || !['Current', 'Proposed', 'Deferred'].includes(target.validity)) continue;
      const how = r.o.kind === 'rule' ? `It is judged by the project’s rule “${nameOf(r.o)}”, which was removed` : `It relies on “${nameOf(r.o)}”, which was removed`;
      if (programMark(store, project, x, `${how}: its material was ${DELETED} (${pathsOf(r.gone).join(', ')}).`, r.gone, now)) marked.add(x);
    }
  }
  return { removed: [...removedIds], marked: [...marked], changeIds };
}

/**
 * Material the program saw deleted is back (the same file, at the same place): what the program removed because of it
 * returns to the validity it had, the return is recorded, and the program's marks whose material is all back close.
 */
export function recordReturns(store: ProjectStore, project: Project, returnedIds: readonly string[], now = new Date().toISOString()): { restored: readonly string[]; changeIds: readonly string[] } {
  if (returnedIds.length === 0) return { restored: [], changeIds: [] };
  const back = new Set(returnedIds);
  const removedBy = (id: string): ChangeItem | null => {
    let found: ChangeItem | null = null;
    for (const c of store.changes.all()) {
      if (c.createdInJobId !== null) continue;
      for (const i of c.items ?? []) if (i.effect === 'Removed' && i.affects.includes(id) && (!found || i.at >= found.at)) found = i;
    }
    return found;
  };
  const items: ChangeItem[] = [];
  const recordId = stableId('chg', project.id, 'Returned', now);
  for (const o of objects(store)) {
    if (o.item.validity !== 'Removed') continue;
    const rests = restsOn(store, o);
    const returned = rests.filter((id) => back.has(id));
    if (returned.length === 0) continue;
    if (!currentBasis(store, rests).some((s) => s.availability !== 'No longer available')) continue;
    const item = removedBy(o.item.id);
    if (!item) continue;   // the Keeper or the owner judged it Removed; that judgement is not the program's to undo
    const before: Validity = isOneOf(VALIDITY, item.before) && item.before !== 'Removed' ? item.before : 'Current';
    const paths = returned.map((id) => store.sources.get(id)).map((s) => (s && s.anchor.kind === 'file' ? s.anchor.path : '')).filter(Boolean);
    const shown = [...new Set(paths)].map((p) => { const root = project.locations.find((l) => isWithin(l, p)); return root ? relativeDisplay(root, p) : p; });
    put(store, o, before, now, `Back: its material is in the project’s current version again (${shown.join(', ')})`, returned);
    items.push({
      id: stableId('item', recordId, 'Corrected', o.item.id), at: now, atSource: 'observed', material: 'Other', effect: 'Corrected',
      title: `${nameOf(o)} is back`, summary: `Its material is in the project’s current version again: ${shown.join(', ')}. The removal recorded when it went missing no longer holds.`,
      before: 'Removed', after: before, sourceIds: returned, by: PROGRAM, why: null, affects: [o.item.id],
    });
  }
  // The program's marks about a deletion close once everything they named is back.
  for (const m of store.marks.all()) {
    if (m.closed !== null || !m.clue.includes(DELETED) || !m.clueSourceIds.some((id) => back.has(id))) continue;
    if (m.clueSourceIds.some((id) => store.sources.get(id)?.availability === 'No longer available')) continue;
    store.marks.put({ ...m, closed: { result: 'No longer relevant', at: now, reason: 'The deleted material it named is back in the project’s current version.' } }, { jobId: null, basisSourceIds: m.clueSourceIds, summary: `Mark closed: ${m.targetId}'s deleted material is back` });
  }
  if (items.length === 0) return { restored: [], changeIds: [] };
  const head = items[0]!;
  const record: ChangeRecord = {
    id: recordId, projectId: project.id, at: now, atSource: 'observed', material: 'Other', effect: 'Corrected',
    title: `Files back in the working tree (seen ${now.slice(0, 16).replace('T', ' ')})`,
    summary: items.length > 1 ? items.map((i) => `${i.effect}: ${i.title}`).join('; ') : head.summary, before: head.before, after: head.after,
    sourceIds: [...new Set(items.flatMap((i) => i.sourceIds))], by: PROGRAM, affects: [...new Set(items.flatMap((i) => i.affects))],
    propagation: [], notJudged: [], segment: null, createdInJobId: null, updatedAt: now,
    work: { kind: 'Time range', label: 'Files back in the working tree', sessionId: null, startedAt: now, endedAt: now, openEnded: false },
    items,
  };
  store.changes.put(record, { jobId: null, basisSourceIds: record.sourceIds, summary: `Change record: ${items.length} removed object${items.length === 1 ? '' : 's'} back` });
  return { restored: items.map((i) => i.affects[0]!), changeIds: [recordId] };
}
