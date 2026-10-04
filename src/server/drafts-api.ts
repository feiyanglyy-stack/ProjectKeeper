/**
 * The session drafts (Spec v3.0 §3.11, §1.4; D88; CKC-23 AC-18) as the owner drills into a session: one draft per
 * session — the owner's lines verbatim with their kind, what a confirmation answers and what it confirms, the agents'
 * intents and reports as claims — openable wherever a session is reached: from a work item's (or any object's) session
 * sources, and from the session-drafts step of the round that wrote it.
 *
 *   GET /api/projects/:id/drafts                → { drafts: SessionDraftRef[] }   every draft, by when its session began
 *   GET /api/projects/:id/drafts?objectId=…     → { drafts: SessionDraftRef[] }   the sessions among an object's sources,
 *                                                  a session not drafted yet listed with `id: null`
 *   GET /api/projects/:id/drafts/:key           → SessionDraftView               key: the draft's id, a session source's
 *                                                  id, `<host>:<sessionId>`, or a session id
 *
 * Read only: the drafts are written by the round's session-drafts step (keeper/clerk-tools.ts `pk_write_session_draft`).
 * `registerDraftRoutes` is registered with the other routes (server/api.ts).
 */
import { stableId } from '../model/ids.ts';
import type { SessionDraft } from '../model/k-types.ts';
import type { Source } from '../model/types.ts';
import type { SessionDraftRef, SessionDraftView } from '../model/views-k.ts';
import type { ProjectStore } from '../store/project-store.ts';
import type { App } from './app.ts';
import { HttpError, optionalString, type HttpApp } from './http.ts';

type SessionAnchorOf = Extract<Source['anchor'], { kind: 'session' }>;

/** The sources that hold one session (its message ranges), in the session's order. */
function sessionSources(store: ProjectStore, host: string, sessionId: string): Source[] {
  const start = (s: Source) => (s.anchor.kind === 'session' ? s.anchor.messageStart : 0);
  return store.sources.filter((s) => s.anchor.kind === 'session' && s.anchor.host === host && s.anchor.sessionId === sessionId).sort((a, b) => start(a) - start(b));
}

const draftIdOf = (projectId: string, host: string, sessionId: string): string => stableId('draft', projectId, host, sessionId);

function countsOf(d: SessionDraft) {
  const lines = d.ownerLines;
  return {
    lines: lines.length, chat: lines.filter((l) => l.kind === 'Chat').length, decisions: lines.filter((l) => l.kind === 'Decision').length,
    confirmations: lines.filter((l) => l.kind === 'Confirmation').length, unjudged: lines.filter((l) => l.kind === null).length,
  };
}

/** A draft as a round step or an object lists it. */
export function draftRef(store: ProjectStore, d: SessionDraft): SessionDraftRef {
  const c = countsOf(d);
  return {
    id: d.id, host: d.session.host, sessionId: d.session.sessionId, startedAt: d.session.startedAt || null, endedAt: d.session.endedAt || null,
    ownerLines: c.lines, decisions: c.decisions, confirmations: c.confirmations, chat: c.chat, unjudged: c.unjudged, agentSummaries: d.agentSummary.length,
    sourceIds: sessionSources(store, d.session.host, d.session.sessionId).map((s) => s.id), at: d.at,
  };
}

/** A session not drafted yet, as a list shows it: its sources, and no draft. */
function undraftedRef(store: ProjectStore, host: string, sessionId: string): SessionDraftRef {
  const sources = sessionSources(store, host, sessionId);
  const times = sources.map((s) => (s.anchor.kind === 'session' ? s.anchor.at : null)).filter((t): t is string => Boolean(t)).sort();
  return {
    id: null, host, sessionId, startedAt: times[0] ?? null, endedAt: times[times.length - 1] ?? null,
    ownerLines: 0, decisions: 0, confirmations: 0, chat: 0, unjudged: 0, agentSummaries: 0, sourceIds: sources.map((s) => s.id), at: null,
  };
}

const byStart = (a: SessionDraftRef, b: SessionDraftRef) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || a.sessionId.localeCompare(b.sessionId);

/** Every job that wrote a draft (`writtenBy`), or, for a draft written before that was kept, the one job known. */
function writersOf(d: SessionDraft): readonly { readonly jobId: string | null; readonly roundId: string | null; readonly at: string }[] {
  return d.writtenBy?.length ? d.writtenBy : [{ jobId: d.jobId, roundId: null, at: d.at }];
}

/** The drafts a job wrote — the session-drafts step of a round — including those a later round drafted again. */
export function draftRefsOfJob(store: ProjectStore, jobId: string): SessionDraftRef[] {
  return store.drafts.filter((d) => writersOf(d).some((w) => w.jobId === jobId)).map((d) => draftRef(store, d)).sort(byStart);
}

/** The session source ids an object stands on: its own, its graph node's, a work item's fact records' and statements'. */
function sourceIdsOf(store: ProjectStore, objectId: string): string[] | null {
  const node = store.nodes.get(objectId);
  const ref = store.reference.get(node?.refKind === 'reference' ? node.refId : objectId);
  const thread = store.threads.get(node?.refKind === 'thread' ? node.refId : objectId);
  if (!node && !ref && !thread) return null;
  const ids = new Set<string>([...(node?.sourceIds ?? []), ...(ref?.sourceIds ?? [])]);
  if (thread) {
    for (const s of [...thread.executionFacts, ...thread.qcFacts]) for (const id of s.sourceIds) ids.add(id);
    for (const f of thread.factRecordIds.flatMap((id) => store.facts.get(id) ?? [])) {
      for (const id of f.aboutSourceIds) ids.add(id);
      for (const s of [...f.statements, ...f.executionFacts]) for (const id of s.sourceIds) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * The sessions among an object's sources, each with its draft — a session not drafted yet is listed with `id: null` so
 * the owner sees it exists and has no draft. Null when the object is not in the assets.
 */
export function sessionsOfObject(store: ProjectStore, projectId: string, objectId: string): SessionDraftRef[] | null {
  const ids = sourceIdsOf(store, objectId);
  if (!ids) return null;
  const sessions = new Map<string, { host: string; sessionId: string }>();
  for (const id of ids) {
    const a = store.sources.get(id)?.anchor;
    if (a?.kind === 'session') sessions.set(`${a.host}\x1f${a.sessionId}`, { host: a.host, sessionId: a.sessionId });
  }
  return [...sessions.values()].map(({ host, sessionId }) => {
    const d = store.drafts.get(draftIdOf(projectId, host, sessionId)) ?? store.drafts.find((x) => x.session.host === host && x.session.sessionId === sessionId);
    return d ? draftRef(store, d) : undraftedRef(store, host, sessionId);
  }).sort(byStart);
}

/** A draft by its id, a session source's id, `<host>:<sessionId>`, or a session id (unique among the drafts). */
export function findDraft(store: ProjectStore, projectId: string, key: string): SessionDraft | null {
  const k = key.trim();
  if (!k) return null;
  const direct = store.drafts.get(k);
  if (direct) return direct;
  const a = store.sources.get(k)?.anchor as SessionAnchorOf | undefined;
  if (a?.kind === 'session') return store.drafts.get(draftIdOf(projectId, a.host, a.sessionId)) ?? store.drafts.find((d) => d.session.host === a.host && d.session.sessionId === a.sessionId) ?? null;
  const pair = /^([a-z]+):(.+)$/.exec(k);
  if (pair) {
    const found = store.drafts.find((d) => d.session.host === pair[1] && d.session.sessionId === pair[2]);
    if (found) return found;
  }
  const bySession = store.drafts.filter((d) => d.session.sessionId === k || d.session.sessionId.startsWith(k));
  return bySession.length === 1 ? bySession[0]! : null;
}

/**
 * One draft as the owner reads it: every owner line verbatim with its kind (unclassified ones say so), what a confirmation
 * answers — the agent message, verbatim — and what it confirms, the source that holds each line for its original, and
 * the agents' summaries as claims (§2.4: who and when; never facts).
 */
export function draftView(store: ProjectStore, d: SessionDraft): SessionDraftView {
  const sources = sessionSources(store, d.session.host, d.session.sessionId);
  const holder = (ref: string): string | null => {
    const n = /^\[?(\d+)\]?$/.exec(ref.trim())?.[1];
    if (n === undefined) return null;
    const i = Number(n);
    return sources.find((s) => s.anchor.kind === 'session' && s.anchor.messageStart <= i && i <= s.anchor.messageEnd)?.id ?? null;
  };
  const roundLabel = (roundId: string | null): string | null => {
    const r = roundId ? store.clerkRounds.get(roundId) : undefined;
    return r ? `${r.kind} · round ${r.number}` : null;
  };
  return {
    id: d.id,
    session: { host: d.session.host, sessionId: d.session.sessionId, file: d.session.file, startedAt: d.session.startedAt || null, endedAt: d.session.endedAt || null },
    ownerLines: d.ownerLines.map((l) => ({ ref: l.ref, at: l.at || null, text: l.text, kind: l.kind, answers: l.answers, confirms: l.confirms, sourceId: holder(l.ref) })),
    agentSummary: d.agentSummary.map((s) => ({ at: s.at || null, who: s.who, summary: s.summary, basis: 'Claimed' as const })),
    counts: countsOf(d), sourceIds: sources.map((s) => s.id), at: d.at,
    writtenBy: writersOf(d).map((w) => ({ jobId: w.jobId, roundId: w.roundId, roundLabel: roundLabel(w.roundId ?? (w.jobId ? store.jobs.get(w.jobId)?.step?.roundId ?? null : null)), at: w.at })),
  };
}

export function registerDraftRoutes(http: HttpApp, app: App): void {
  http.route('GET', '/api/projects/:id/drafts', ({ params, query }) => {
    const store = app.store(params.id!);
    const objectId = optionalString(query.get('objectId'));
    if (objectId) {
      const sessions = sessionsOfObject(store, params.id!, objectId);
      if (!sessions) throw new HttpError(404, `Unknown object ${objectId}`);
      return { drafts: sessions };
    }
    return { drafts: store.drafts.all().map((d) => draftRef(store, d)).sort(byStart) };
  });
  http.route('GET', '/api/projects/:id/drafts/:key', ({ params }) => {
    const store = app.store(params.id!);
    const d = findDraft(store, params.id!, params.key!);
    if (!d) throw new HttpError(404, `No session draft for ${params.key}`);
    return draftView(store, d);
  });
}
