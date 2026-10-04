// The increment K data layer (Spec v3.0 §6.3, §6.4, §6.17, §6.9, §6.7; src/model/views-k.ts lists the endpoints and
// the shapes). The UI only draws these views; it never invents content. An endpoint that does not exist yet answers
// 404 — the caller gets null and shows `No data for this yet`.
import { api } from './app.js';

const NO_DATA = 'No data for this yet';

// ── reads ─────────────────────────────────────────────────────────────────
// A 404 is an answer ("this end is not built yet"), not an error: null, cached, and the surface says so.
const missing = new Set();
async function read(path) {
  if (missing.has(path)) return null;
  try {
    return await api(path);
  } catch (e) {
    if (/\b404\b/.test(e.message)) { missing.add(path); return null; }
    throw e;
  }
}

const pid = (id) => encodeURIComponent(id);
export const noData = () => NO_DATA;

/** ProcessView for the project, or null when the endpoint is not built yet. */
export async function getProcess(projectId) {
  return read(`/api/projects/${pid(projectId)}/process`);
}
/** LineageView of one object: its dated path to now (§2.11). */
export async function getLineage(projectId, objectId) {
  return read(`/api/projects/${pid(projectId)}/objects/${pid(objectId)}/lineage`);
}
/** VersionsView of one document-like object. */
export async function getVersions(projectId, objectId) {
  return read(`/api/projects/${pid(projectId)}/objects/${pid(objectId)}/versions`);
}
/** CodeView (§6.17); its send-backs ride on the view (`CodeView.sendBacks`), so Code never waits on the process view
 *  for them. */
export async function getCode(projectId) {
  return read(`/api/projects/${pid(projectId)}/code`);
}
/** CodeFileTextView: a file of the current version, found by the ledger's fileRefs (§6.17; a page from `from`). Throws
 *  with the server's reason (e.g. not in the current version) — the reader says it, rather than `No data`. */
export async function getCodeFile(projectId, { repo = null, path, from = 1 }) {
  const q = new URLSearchParams({ path, ...(repo ? { repo } : {}), ...(from > 1 ? { from: String(from) } : {}) });
  return api(`/api/projects/${pid(projectId)}/code/file?${q}`);
}

// ── §3.11 session drafts (server/drafts-api.ts) ─────────────────────────────
/** SessionDraftRef[] of the sessions an object stands on (a work item's session sources), each with its draft or none. */
export async function getObjectDrafts(projectId, objectId) {
  const r = await read(`/api/projects/${pid(projectId)}/drafts?objectId=${pid(objectId)}`);
  return r ? r.drafts : null;
}
/** SessionDraftView by draft id, session source id, `host:session` or session id. */
export async function getDraft(projectId, key) {
  return read(`/api/projects/${pid(projectId)}/drafts/${pid(key)}`);
}

// ── §1.17 semantic patches (CKC-26 AC-4) ────────────────────────────────────
/** PatchView[], oldest first by when it happened; `Change log` shows the confirmed ones. Null when not built. */
export async function getPatches(projectId) {
  const r = await read(`/api/projects/${pid(projectId)}/patches`);
  return r ? r.patches : null;
}
/** One patch with its details text (the words `pk get SP-n` prints), by id or number. */
export async function getPatch(projectId, key) {
  return read(`/api/projects/${pid(projectId)}/patches/${pid(key)}`);
}

// ── §2.12 an earlier generation's plan document as it stood (D82) ───────────
/** GenerationPlanTextView of one of a generation's plan documents (its index in the band's `planDocs`); a page from `from`. */
export async function getGenerationPlan(projectId, generationId, index, from = 1) {
  return read(`/api/projects/${pid(projectId)}/generations/${pid(generationId)}/plans/${index}${from > 1 ? `?from=${from}` : ''}`);
}
/** TerritoryDetailView: the files of one code territory. */
export async function getTerritory(projectId, territoryId) {
  return read(`/api/projects/${pid(projectId)}/code/territories/${pid(territoryId)}`);
}
/** RoundView[], newest first (§6.9). */
export async function getRounds(projectId) {
  return read(`/api/projects/${pid(projectId)}/k-rounds`);
}
/** RoundDocView: one document a round left behind. */
export async function getRoundDoc(projectId, roundId, docId) {
  return read(`/api/projects/${pid(projectId)}/k-rounds/${pid(roundId)}/docs/${pid(docId)}`);
}
/** ScopeKView: the ledger's coverage, layers, generations and the Project folder authorization (§6.7). */
export async function getScopeK(projectId) {
  return read(`/api/projects/${pid(projectId)}/scope-k`);
}

// ── writes: the owner's `No action needed` (§1.18, §2.12) ─────────────────
/** The response lands on the cached view too, so a redraw shows it without a refetch. */
function applyBreakpointResponse(view, bid, reason, at) {
  const bp = view?.breakpoints.find((b) => b.id === bid);
  if (!bp) return null;
  Object.assign(bp, { lit: false, ownerResponse: { reason, at } });
  return bp;
}

export async function respondBreakpoint(projectId, bid, reason) {
  const bp = await api(`/api/projects/${pid(projectId)}/breakpoints/${pid(bid)}/response`, { method: 'POST', body: { reason } });
  applyBreakpointResponse(await getProcess(projectId), bid, reason, bp?.ownerResponse?.at ?? new Date().toISOString());
  return bp;
}

export async function respondSendBack(projectId, sid, reason) {
  const sb = await api(`/api/projects/${pid(projectId)}/sendbacks/${pid(sid)}/response`, { method: 'POST', body: { reason } });
  const view = await getProcess(projectId);
  const cached = view?.sendBacks.find((s) => s.id === sid);
  if (cached) Object.assign(cached, { lit: false, ownerResponse: sb?.ownerResponse ?? { reason, at: new Date().toISOString() } });
  return sb;
}

/** Assets changed: the next read fetches again. */
export function invalidate() {
  missing.clear();
}
