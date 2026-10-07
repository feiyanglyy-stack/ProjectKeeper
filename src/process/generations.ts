/**
 * The plans of an earlier generation (Spec v3.0 §2.12 "上几代的计划", D85, D82; CKC-24 AC-18): which `Plan` objects a
 * rolled-up band holds, and its plan documents as they stood — a document since deleted is read from the version before
 * its deletion, one rewritten in place from the version it had when the generation ended.
 *
 * The generation names its plan documents itself (`Generation.planRefs`, written by orientation or the skeleton from
 * what the material says); the program only locates them in the ledger's document history and reads them. Nothing here
 * decides what a generation is.
 */
import type { Ledger } from '../ledger/index.ts';
import { msOf } from '../ledger/time.ts';
import type { EvidenceRef, Generation } from '../model/k-types.ts';
import type { ReferenceItem } from '../model/types.ts';
import type { GenerationPlanDocView, GenerationPlanTextView } from '../model/views-k.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { isWithin, pathKey, relativeDisplay, samePath } from '../util/paths.ts';
import { plansOf } from './placement.ts';

const slash = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/** Where a plan reference points in a repository: its path (repository-relative when the reference says so, else as the
 *  source anchors it) and the document version, when the reference names one (`doc:<path>@<commit>`). */
interface PlanPlace { readonly path: string; readonly absolute: boolean; readonly repo: string | null; readonly version: string | null }

function placeOf(store: ProjectStore, ref: EvidenceRef): PlanPlace | null {
  if (ref.kind === 'file') return { path: slash(ref.id), absolute: false, repo: ref.repo ?? null, version: null };
  if (ref.kind === 'ledger') {
    const doc = /^doc:(.+)@([0-9a-f]{4,40})$/.exec(ref.id);
    if (doc) return { path: slash(doc[1]!), absolute: false, repo: ref.repo ?? null, version: ref.id };
    const file = /^(?:file|del):(.+?)(?:@[0-9a-f]{4,40})?$/.exec(ref.id);
    if (file) return { path: slash(file[1]!), absolute: false, repo: ref.repo ?? null, version: null };
    return null;
  }
  if (ref.kind === 'source') {
    const a = store.sources.get(ref.id)?.anchor;
    if (a?.kind === 'revision') return { path: slash(a.path), absolute: false, repo: a.repo, version: null };
    if (a?.kind === 'file') return { path: slash(a.path), absolute: true, repo: null, version: null };
  }
  return null;
}

/** A source is at a place: the same document, by repository-relative path or by the absolute path's tail. */
function sourceAt(store: ProjectStore, sourceId: string, place: PlanPlace): boolean {
  const a = store.sources.get(sourceId)?.anchor;
  if (!a || (a.kind !== 'file' && a.kind !== 'revision')) return false;
  const p = slash(a.path);
  if (place.absolute) return a.kind === 'file' && pathKey(p) === pathKey(place.path);
  return pathKey(p) === pathKey(place.path) || pathKey(p).endsWith(`/${pathKey(place.path)}`);
}

/** The plan object's document is gone from the current version: every source of it is history only, or no longer there. */
function onlyInHistory(store: ProjectStore, plan: ReferenceItem): boolean {
  const sources = plan.sourceIds.flatMap((id) => store.sources.get(id) ?? []);
  return sources.length > 0 && sources.every((s) => s.anchor.kind === 'revision' || s.availability === 'No longer available');
}

/**
 * A generation's plan objects (graph node ids): the `Plan` items read from its plan documents that are no longer the
 * current plan (not in force, or read from a document gone from the current version), and the plans its work items were
 * planned in that are no longer in force. A plan item still in force and read from a document still there is the
 * current plan's, even when an earlier generation's plan was once in that same document.
 */
export function generationPlanIds(store: ProjectStore, g: Generation): string[] {
  const places = g.planRefs.flatMap((ref) => placeOf(store, ref) ?? []);
  const sources = new Set(g.planRefs.filter((r) => r.kind === 'source').map((r) => r.id));
  const earlier = (plan: ReferenceItem) => plan.validity !== 'Current' || onlyInHistory(store, plan);
  const ids: string[] = [];
  const add = (id: string) => { if (!ids.includes(id)) ids.push(id); };
  for (const plan of store.reference.filter((r) => r.category === 'Plan')) {
    const named = plan.sourceIds.some((sid) => sources.has(sid) || places.some((p) => sourceAt(store, sid, p)));
    if (named && earlier(plan)) add(plan.id);
  }
  for (const workId of g.workIds) {
    const thread = store.threads.get(workId);
    if (thread) for (const plan of plansOf(store, thread)) if (earlier(plan)) add(plan.id);
  }
  return ids;
}

/** A generation's plan documents as its band lists them, in the order the generation names them. */
export function generationPlanDocs(store: ProjectStore, g: Generation): GenerationPlanDocView[] {
  return g.planRefs.map((ref, index) => {
    const place = placeOf(store, ref);
    return { index, label: ref.label, path: place ? place.path : null, ref };
  });
}

/** The end of a generation in milliseconds: a date alone ends at the end of that day. */
const endMs = (at: string): number => (/^\d{4}-\d\d-\d\d$/.test(at) ? Date.parse(`${at}T23:59:59.999Z`) : msOf(at) ?? Date.parse(at));

/**
 * One plan document of an earlier generation as it stood (D82): the version the generation's reference names; else the
 * last version the ledger has of it up to the generation's end — for a document since deleted that is the version before
 * its deletion — else its first version. `fromLine` pages a long document (the ledger's own paging).
 */
export function generationPlanText(ledger: Ledger, store: ProjectStore, g: Generation, index: number, fromLine = 1): GenerationPlanTextView | null {
  const ref = g.planRefs[index];
  if (!ref) return null;
  const base = { generationId: g.id, index, label: ref.label };
  const none = (why: string, path: string | null = null, repo: string | null = null): GenerationPlanTextView => ({
    ...base, repo, path, version: null, deleted: null, current: false, text: null, lines: 0, fromLine: 1, nextFromLine: null, truncated: false, why,
  });
  const place = placeOf(store, ref);
  if (!place) return none(`${ref.label} names no document (${ref.kind} ${ref.id}); it is shown as the generation cites it.`);
  // An absolute path (a file source) is made relative to the ledger repository it lies in.
  let path = place.path;
  let repoId = place.repo ? ledger.repoId(place.repo) : null;
  if (place.absolute) {
    // Under a repository as the system's own paths are: asked as text with `/` after a key, nothing is under anything
    // on Windows, where a key has `\`.
    const repo = ledger.repos().filter((r) => isWithin(r.path, path) && !samePath(r.path, path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!repo) return none(`${path} is in no repository of the ledger.`, path);
    repoId = repo.id;
    path = relativeDisplay(repo.path, path);
  }
  const repoPath = repoId ? ledger.repos().find((r) => r.id === repoId)?.path ?? null : null;
  let versionId = place.version;
  let deleted: GenerationPlanTextView['deleted'] = null;
  let current = false;
  if (!versionId) {
    const v = ledger.docVersions(path, repoId ? { repo: repoId } : {});
    if (typeof v === 'string') return none(v, path, repoPath);
    const end = endMs(g.ended.at);
    const upToEnd = v.versions.filter((x) => (msOf(x.occurred.at) ?? 0) <= end);
    const pick = upToEnd[upToEnd.length - 1] ?? v.versions[0];
    if (!pick) return none(`The ledger has no version of ${path}.`, path, repoPath);
    versionId = pick.id;
    const gone = v.inCurrentVersion ? undefined : v.deletions[v.deletions.length - 1];
    if (gone?.commit) deleted = { commit: gone.commit, occurred: gone.occurred };
  }
  const page = ledger.docText({ id: versionId }, { from: fromLine });
  if (typeof page === 'string') return none(page, path, repoPath);
  current = page.current;
  return {
    ...base, repo: repoPath ?? page.repo, path: page.path, version: { commit: page.commit, occurred: page.occurred }, deleted, current,
    text: page.text, lines: page.lines, fromLine: page.fromLine, nextFromLine: page.nextFromLine ?? null, truncated: page.nextFromLine !== undefined || page.fromLine > 1, why: null,
  };
}
