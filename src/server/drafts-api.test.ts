/**
 * The session drafts where the owner drills into a session (CKC-23 AC-18; Spec §3.11; QC AY B4): from a work item's
 * session sources and from the session-drafts step of every round that wrote the draft. A draft shows the owner's lines
 * verbatim with their kind, what a confirmation answers and what it confirms, and the agents' summary as claims.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import type { FactRecord, KeeperJob, Project, Source, WorkThread } from '../model/types.ts';
import type { ClerkRound, RoundStepKind } from '../model/k-types.ts';
import { clerkTools } from '../keeper/clerk-tools.ts';
import type { App } from './app.ts';
import { draftView, findDraft, registerDraftRoutes, sessionsOfObject } from './drafts-api.ts';
import { roundsView } from './k-views.ts';

const BASE = mkdtempSync(join(tmpdir(), 'pk-drafts-'));
const LOG = join(BASE, 'sess-1.jsonl');
const rec = (type: 'user' | 'assistant', timestamp: string, content: unknown) => JSON.stringify({
  type, timestamp, sessionId: 'sess-1', cwd: BASE, message: type === 'user' ? { role: 'user', content } : { role: 'assistant', model: 'claude-opus', content },
});
writeFileSync(LOG, [
  rec('user', '2026-09-02T01:00:10.000Z', 'Should the export keep the old CSV layout?'),
  rec('assistant', '2026-09-02T01:05:20.000Z', [{ type: 'text', text: 'I propose a new layout with one row per shipment and a header line.' }]),
  rec('user', '2026-09-02T03:30:45.000Z', '可以，按这个办'),
].join('\n'));

const project = { id: 'p1', name: 'Harbor', language: 'en', locations: [BASE], scope: [], scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false, createdAt: '2026-09-01T00:00:00Z', lastOpenedAt: null, lastScopedAt: null } as unknown as Project;
const session = (id: string, sessionId: string, start: number, end: number, at: string): Source => ({
  id, projectId: 'p1', title: id, anchor: { kind: 'session', host: 'claude', sessionId, file: sessionId === 'sess-1' ? LOG : join(BASE, 'gone.jsonl'), cwd: BASE, messageStart: start, messageEnd: end, at },
  ids: [], version: { fingerprint: 'f', readAt: at, commit: null }, excerpt: '', usedAs: 'Session', usedAsBy: null, availability: null, movedTo: null, scopeItemId: 's', hasCredential: false, bytes: 0,
} as unknown as Source);
const round = (id: string, kind: ClerkRound['kind'], number: number, startedAt: string): ClerkRound => ({
  id, projectId: 'p1', kind, number, startedAt, endedAt: null, status: 'Done', rootJobId: `root_${id}`, questionsDocId: null, paths: [], outputs: [], groundwork: [],
  unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: startedAt,
});
const job = (id: string, roundId: string, kind: RoundStepKind, queuedAt: string): KeeperJob => ({
  id, projectId: 'p1', kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: [roundId], label: `${kind} ${roundId}` }, status: 'Done', queuedAt, startedAt: queuedAt, endedAt: queuedAt,
  savedResults: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null,
  requestBasis: null, parentJobId: `root_${roundId}`, resultText: null, priority: 1, task: null, step: { roundId, kind, path: null }, timing: null,
} as unknown as KeeperJob);

async function draftIn(store: ProjectStore, jobId: string, roundId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tools = clerkTools({ store, project, jobId, jobKind: 'Organizing', model: null, step: { roundId, kind: 'session-drafts', path: null } });
  const run = tools.find((t) => t.name === 'pk_write_session_draft')!.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  const r = await run('call', args);
  const text = r.content.map((c) => c.text).join('\n');
  assert.ok(!r.isError, text);
  return JSON.parse(text) as Record<string, unknown>;
}

test('a session drafted in two rounds opens from each round’s session-drafts step and from the work it is a source of', async () => {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-drafts-store-')));
  store.sources.put(session('src_s1', 'sess-1', 0, 2, '2026-09-02T01:00:10.000Z'));
  store.sources.put(session('src_s2', 'sess-2', 0, 4, '2026-09-04T08:00:00.000Z'));
  store.clerkRounds.put(round('round_1', 'First usable', 1, '2026-09-10T00:00:00Z'));
  store.clerkRounds.put(round('round_2', 'Deepen', 2, '2026-09-11T00:00:00Z'));
  store.jobs.put(job('job_d1', 'round_1', 'session-drafts', '2026-09-10T00:01:00Z'));
  store.jobs.put(job('job_o1', 'round_1', 'orientation', '2026-09-10T00:02:00Z'));
  store.jobs.put(job('job_d2', 'round_2', 'session-drafts', '2026-09-11T00:01:00Z'));
  const confirms = 'the owner confirmed the agent’s proposal of a new export layout';
  const first = await draftIn(store, 'job_d1', 'round_1', {
    session: { host: 'claude', sessionId: 'sess-1' },
    lines: [{ ref: '2', kind: 'Confirmation', confirms }],
    agentSummary: [{ at: '[1]', who: 'Claude Code (claude-opus)', summary: 'Proposed a new export layout.' }],
  });
  await draftIn(store, 'job_d2', 'round_2', { session: { host: 'claude', sessionId: 'sess-1' }, lines: [{ ref: '0', kind: 'Chat' }], agentSummary: [{ at: '[1]', who: 'Claude Code (claude-opus)', summary: 'Proposed a new export layout.' }] });
  const draft = store.drafts.get(first.id as string)!;
  assert.deepEqual(draft.writtenBy?.map((w) => [w.jobId, w.roundId]), [['job_d1', 'round_1'], ['job_d2', 'round_2']], 'every job that wrote it, with its round');
  assert.equal(draft.jobId, 'job_d2', 'the last writer stays the draft’s job');

  // The round tree: each round's session-drafts step lists the draft, the other steps list none.
  const rounds = roundsView(store);
  for (const r of rounds) {
    const step = r.steps.find((s) => s.kind === 'session-drafts')!;
    assert.deepEqual(step.drafts?.map((d) => [d.id, d.ownerLines, d.decisions, d.confirmations, d.chat, d.unjudged]), [[draft.id, 2, 0, 1, 1, 0]], `round ${r.number} lists the draft it wrote`);
    assert.deepEqual(step.drafts?.[0]?.sourceIds, ['src_s1']);
  }
  assert.equal(rounds.find((r) => r.id === 'round_1')!.steps.find((s) => s.kind === 'orientation')!.drafts, undefined, 'only the session-drafts step lists drafts');

  // A work item whose fact record stands on both sessions: one drafted, one not drafted yet (listed, and says so).
  store.facts.put({ id: 'fact_1', projectId: 'p1', title: 'Export', aboutSourceIds: ['src_s1', 'src_s2'], statements: [], decisions: [], changes: [], openQuestions: [], executionFacts: [], language: 'en', inputs: {} as never, asOf: '', updatedAt: '', pendingSourceIds: [] } as FactRecord);
  store.threads.put({ id: 'thr_export', projectId: 'p1', title: 'Export', ids: ['AH'], factRecordIds: ['fact_1'], executionFacts: [], qcFacts: [], serves: [] } as unknown as WorkThread);
  const sessions = sessionsOfObject(store, 'p1', 'thr_export')!;
  assert.deepEqual(sessions.map((s) => [s.sessionId, s.id, s.ownerLines]), [['sess-1', draft.id, 2], ['sess-2', null, 0]], 'the work’s sessions, the one not yet drafted with no draft');
  assert.equal(sessionsOfObject(store, 'p1', 'thr_nowhere'), null);

  // A draft is found by its id, a session source of it, host:session, or the session id.
  for (const key of [draft.id, 'src_s1', 'claude:sess-1', 'sess-1']) assert.equal(findDraft(store, 'p1', key)?.id, draft.id, `found by ${key}`);
  assert.equal(findDraft(store, 'p1', 'src_s2'), null, 'a session not drafted has no draft to open');

  // What the owner reads.
  const view = draftView(store, draft);
  assert.deepEqual(view.ownerLines.map((l) => [l.ref, l.text, l.kind, l.sourceId]), [
    ['0', 'Should the export keep the old CSV layout?', 'Chat', 'src_s1'],
    ['2', '可以，按这个办', 'Confirmation', 'src_s1'],
  ], 'the owner’s words verbatim, each with its kind and the source that holds it');
  assert.equal(view.ownerLines[1]!.answers, 'I propose a new layout with one row per shipment and a header line.', 'what the confirmation answers, verbatim');
  assert.equal(view.ownerLines[1]!.confirms, confirms, 'what it confirms, in the Keeper’s words');
  assert.deepEqual(view.agentSummary.map((s) => [s.who, s.basis]), [['Claude Code (claude-opus)', 'Claimed']], 'the agents’ summary is claims');
  assert.deepEqual(view.counts, { lines: 2, chat: 1, decisions: 0, confirmations: 1, unjudged: 0 });
  assert.deepEqual(view.writtenBy.map((w) => w.roundLabel), ['First usable · round 1', 'Deepen · round 2']);

  // The routes, as the server registers them.
  const routes = new Map<string, (req: { params: Record<string, string>; query: URLSearchParams }) => unknown>();
  registerDraftRoutes({ route: (m: string, p: string, h: never) => routes.set(`${m} ${p}`, h) } as never, { store: () => store } as unknown as App);
  assert.deepEqual([...routes.keys()], ['GET /api/projects/:id/drafts', 'GET /api/projects/:id/drafts/:key']);
  const list = routes.get('GET /api/projects/:id/drafts')!({ params: { id: 'p1' }, query: new URLSearchParams() }) as { drafts: { id: string }[] };
  assert.deepEqual(list.drafts.map((d) => d.id), [draft.id]);
  const ofWork = routes.get('GET /api/projects/:id/drafts')!({ params: { id: 'p1' }, query: new URLSearchParams({ objectId: 'thr_export' }) }) as { drafts: { sessionId: string }[] };
  assert.deepEqual(ofWork.drafts.map((d) => d.sessionId), ['sess-1', 'sess-2']);
  const one = routes.get('GET /api/projects/:id/drafts/:key')!({ params: { id: 'p1', key: 'src_s1' }, query: new URLSearchParams() }) as { id: string };
  assert.equal(one.id, draft.id);
  assert.throws(() => routes.get('GET /api/projects/:id/drafts/:key')!({ params: { id: 'p1', key: 'src_s2' }, query: new URLSearchParams() }), /No session draft/);
  assert.throws(() => routes.get('GET /api/projects/:id/drafts')!({ params: { id: 'p1' }, query: new URLSearchParams({ objectId: 'nope' }) }), /Unknown object/);
});
