/**
 * The UI fixture (scripts/seed-ui-fixture.ts): an invented, neutral demo project — "Papertrail", a
 * one-person read-later list — seeded so that every kind of content the workbench can show appears
 * at least once, plus a `large` size that does not fit on one screen.
 *
 * The assertions go through the same layer the interface uses: graph-view.ts / workbench-content.ts
 * directly, and the routes of api.ts registered on a stub app (the same approach as
 * workbench-content.test.ts). Nothing is served and no real home, project or key is touched:
 * everything lives in temporary directories.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedUiFixture, type UiFixtureResult } from '../../scripts/seed-ui-fixture.ts';
import { App } from './app.ts';
import { ProjectStore } from '../store/project-store.ts';
import { Workspace } from '../store/workspace.ts';
import { projectDir } from '../store/paths.ts';
import { listVersions } from '../store/versions.ts';
import { NODE_CATEGORY, RELATION_TYPE } from '../model/vocab.ts';
import type { Project } from '../model/types.ts';
import { factDetail, graphView, mountView, nodeDetail, overview, relationDetail } from './graph-view.ts';
import { roundsView, scopeKView } from './k-views.ts';
import { registerRoutes } from './api.ts';
import { ConversationService } from '../keeper/conversation.ts';

let seeded: Promise<UiFixtureResult> | null = null;
/** Seed the standard fixture once; every test shares the result. */
function standard(): Promise<UiFixtureResult> {
  if (!seeded) seeded = seedUiFixture(mkdtempSync(join(tmpdir(), 'pk-uifix-home-')), { size: 'standard' });
  return seeded;
}

function openStore(r: UiFixtureResult): ProjectStore {
  return ProjectStore.open(r.projectId, r.home);
}
function openProject(r: UiFixtureResult): Project {
  const p = Workspace.open(r.home).get(r.projectId);
  if (!p) throw new Error(`project ${r.projectId} missing from the fixture home`);
  return p;
}

/** The API's handlers on a stub app that holds the seeded store; nothing is served. */
function routes(r: UiFixtureResult) {
  const store = openStore(r);
  const project = openProject(r);
  const handlers = new Map<string, (ctx: unknown) => unknown>();
  const http = { route: (method: string, path: string, handler: (ctx: unknown) => unknown) => handlers.set(`${method} ${path}`, handler), static: () => undefined };
  const app = {
    home: r.home,
    project: () => project, store: () => store, workspace: { list: () => [project], settings: { port: 4922 } },
    keeper: {
      status: async () => ({ status: 'Not connected', reason: 'no key', detail: '' }),
      providerState: async () => ({ model: null, connected: false, available: [], backups: [], fallback: null, switches: [] }),
      hasLiveSession: () => false, branchingSupported: false,
      chatTelemetry: () => ({ model: null, context: { usedTokens: null, limitTokens: null, percent: null, estimated: false, source: 'unavailable' } }),
      resources: async () => ({ resources: [], projectTrusted: null, trustDecision: 'unknown' }),
      capabilities: () => [], laneState: () => ({ lanesPerKey: 3, total: 0, keys: [] }), usageSummary: () => ({}), resourceChangesOf: () => [],
    },
    usageWhere: () => ({ port: 4922 }),
    pendingChanges: () => [],   // the watcher's list; a served fixture home is not watched
    ledger: { ledger: () => null },   // the packs' lineage reads the project's ledger when there is one
  };
  app['conversation' as never] = new ConversationService(app as never) as never;
  registerRoutes(http as never, app as never, '', '');
  return async (method: string, path: string, params: Record<string, string>, query = '') =>
    (await handlers.get(`${method} ${path}`)!({ params: { id: r.projectId, ...params }, query: new URLSearchParams(query), body: null })) as Record<string, any>;
}

test('ui fixture seeds under a temporary home and reports what it planted', async () => {
  const r = await standard();
  assert.ok(r.projectId, 'project id');
  const store = openStore(r);
  assert.ok(store.sources.size >= 60, `sources: ${store.sources.size}`);
  assert.equal(r.counts.ownerWords, 9);
  assert.equal(r.counts.areas, 7);
  assert.ok(r.counts.workItems >= 39 && r.counts.workItems <= 46, `work items: ${r.counts.workItems}`);
  assert.ok(r.counts.changes >= 12, `changes: ${r.counts.changes}`);
});

test('the graph draws every node category, the owner’s words as one group, and every relation type', async () => {
  const r = await standard();
  const g = graphView(openStore(r), openProject(r));
  const categories = new Set(g.nodes.map((n) => n.category));
  for (const c of NODE_CATEGORY) assert.ok(categories.has(c), `node category ${c} appears`);
  const words = g.nodes.filter((n) => n.group === "Owner's words");
  assert.equal(words.length, 9, 'the owner’s words form one group of their own');
  for (const t of RELATION_TYPE) assert.ok(g.relationTypes.includes(t), `relation type ${t} appears`);
  assert.ok(g.counts.existingFoundation >= 3, 'completed, still-current work forms the Existing foundation group');
  assert.ok(g.counts.unplaced >= 2, 'results that reach no work are Unplaced');
  assert.ok(g.counts.replacedOrDeferred >= 3, 'replaced and deferred objects are counted');
  const hub = g.relations.filter((x) => x.from === 'thread_search_index' || x.to === 'thread_search_index');
  assert.ok(hub.length >= 10, `one object carries more than ten relations (got ${hub.length})`);
  assert.equal(g.nodes.find((n) => n.id === 'thread_side_prototype')?.noEstablishedLink, true, 'an in-progress work item with no links is marked No established link');
  assert.equal(g.nodes.find((n) => n.id === 'ref_search')?.updatePending, true, 'an area with pending material is Update pending');
  assert.ok(g.nodes.some((n) => n.id === 'thread_zh_tokenizer' && n.updatePending), 'a work item with pending material is Update pending');
  assert.ok(g.nodes.some((n) => n.marks.some((m) => m.kind === 'Suspected stale')), 'an entry mark shows on the graph');
  assert.ok(g.nodes.some((n) => n.areaId === null && n.category === 'Work item'), 'work outside any area (Project-wide) exists');
  const validities = new Set(openStore(r).reference.all().map((x) => x.validity));
  for (const v of ['Current', 'Proposed', 'Replaced', 'Deferred', 'Abandoned', 'Removed']) assert.ok(validities.has(v as never), `reference validity ${v} appears`);
  const progress = new Set(openStore(r).threads.all().map((t) => t.progress));
  for (const p of ['Planned', 'In progress', 'Done', 'On hold']) assert.ok(progress.has(p as never), `progress ${p} appears`);
  const acc = new Set(openStore(r).threads.all().map((t) => t.acceptance ?? ''));
  assert.ok(acc.has('Accepted') && acc.has('Not yet accepted'), 'both acceptance states appear');
});

test('Notes (attention) carries a note, a scope question, a finished request and a follow-up round; Recent changes strikes removed objects through', async () => {
  const r = await standard();
  const project = openProject(r);
  const ov = overview(openStore(r), project, project.lastOpenedAt, null);
  const kinds = new Set(ov.needsYou.map((x: { kind: string }) => x.kind));
  for (const k of ['note', 'scope-question', 'job', 'round']) assert.ok(kinds.has(k), `Notes (attention) holds a ${k}`);
  const walk = ov.needsYou.find((x: { id: string }) => x.id === 'note_tag_suggest');
  assert.equal(walk?.cameFrom?.kind, 'Change follow-up');
  assert.ok(walk?.cameFrom?.changes?.length >= 1, 'the change follow-up note names its change, so ▶ Walk through can be offered');
  assert.ok(ov.needsYou.every((x: { id: string }) => x.id !== 'note_no_action'), 'an answered note (No action needed) leaves Notes (attention)');
  const removed = ov.recentChanges.find((c) => c.id === 'chg_remove_v1');
  assert.ok(removed && removed.removed.length >= 2, 'Recent changes names the objects the record removed');
  const gone = removed.affectsLabels.find((a) => a.id === 'thread_gone_sync');
  assert.equal(gone?.removed, true, 'a removed object is flagged so it is struck through');
  assert.ok(ov.recentChanges.some((c) => c.id === 'chg_wording_only' && c.affectsLabels.length === 0), 'a record that touched nothing says so');
  const states = new Set(ov.recentChanges.flatMap((c) => Object.keys(c.propagationSummary)));
  for (const s of ['Updated', 'Still on old understanding', 'Reusable as is', 'Not yet checked']) assert.ok(states.has(s), `propagation state ${s} appears`);
  assert.ok(ov.sinceLastVisit, 'Since last visit has content (lastOpenedAt is set earlier)');
  assert.ok(ov.sinceLastVisit.threads.length >= 1 && ov.sinceLastVisit.changes.length >= 1 && ov.sinceLastVisit.notes.length >= 1, 'new work, changes and notes since the last visit');
  assert.ok(ov.noteCounts.current >= 9, 'notes of every ask and status exist');
  assert.equal(ov.relookDone, true, 'a judgement record exists');
});

test('every item of the bottom strip carries what its row shows: the object it is about, by name, and a time (CKC-09 AC-38)', async () => {
  // A row is: mark · one sentence · object · time (Spec §6.2). The mark and the sentence were always there; the object
  // and the time are what the one-line row adds, so the overview names them instead of leaving the page to look each up.
  const r = await standard();
  const project = openProject(r);
  const store = openStore(r);
  const ov = overview(store, project, project.lastOpenedAt, null);
  type Row = { kind: string; id: string; at: string | null; object: { kind: string; objects: { id: string; kind: string; label: string }[] } };
  const rows = ov.needsYou as unknown as Row[];
  for (const x of rows) assert.ok(x.object && Array.isArray(x.object.objects) && 'at' in x, `${x.id} carries an object and a time`);
  const byId = (id: string) => rows.find((x) => x.id === id)!;
  const labelOf = (id: string) => store.nodes.get(id)!.label;
  // A note on one object, on a path of two, on a relation, on the whole project.
  const onNode = byId('note_tag_suggest');
  assert.deepEqual(onNode.object, { kind: 'node', objects: [{ id: 'thread_tag_suggest', kind: 'node', label: labelOf('thread_tag_suggest') }] });
  assert.equal(onNode.at, store.notes.get('note_tag_suggest')!.updatedAt, 'a note’s time is when it was last written');
  assert.deepEqual(byId('note_zh_search').object.objects.map((o) => o.id), ['thread_search_index', 'thread_zh_tokenizer']);
  const rel = store.relations.get('rel_verify_search_perf')!;
  assert.deepEqual(byId('note_search_speed').object.objects, [{ id: rel.id, kind: 'relation', label: `${rel.type}: ${labelOf(rel.from)} → ${labelOf(rel.to)}` }]);
  assert.deepEqual(mountView(store, store.notes.get('note_project')!.mount), { kind: 'project', objects: [] }, 'a note on the whole project hangs on no object');
  assert.deepEqual(mountView(store, { kind: 'project', ids: [project.id, 'thread_tag_suggest'] }), { kind: 'project', objects: [] }, 'a project mount lists nothing even when ids were filled in');
  const withUnknown = mountView(store, { kind: 'node', ids: ['thread_tag_suggest', 'missing-node'] });
  assert.deepEqual(withUnknown.objects.map((o) => o.id), ['thread_tag_suggest'], 'an id the project does not have is not listed');
  assert.equal(withUnknown.objects.some((o) => o.label === 'missing-node'), false, 'an unknown id is not shown as its own name');
  assert.deepEqual(mountView(store, { kind: 'relation', ids: ['rel_verify_search_perf', 'missing-relation'] }).objects.map((o) => o.id), ['rel_verify_search_perf'], 'a relation id the project does not have is not listed');
  // What is not a note says what it is about in the same slot, and gives the time it has.
  const question = rows.find((x) => x.kind === 'scope-question')!;
  assert.deepEqual([question.object.kind, question.at], ['scope', null], 'a scope question has no time of its own');
  const job = rows.find((x) => x.kind === 'job')!;
  assert.equal(job.at, store.jobs.get(job.id)!.endedAt);
  const round = rows.find((x) => x.kind === 'round')!;
  assert.equal(round.at, store.rounds.get(round.id)!.endedAt);
  // Since last visit: its notes name their object too.
  const since = ov.sinceLastVisit!.notes as unknown as { id: string; at: string; object: Row['object'] }[];
  assert.ok(since.length > 0 && since.every((n) => n.at && n.object && Array.isArray(n.object.objects)));
});

test('object details carry the authority layer, a decision’s carry-out, and pending state', async () => {
  const r = await standard();
  const store = openStore(r);
  const project = openProject(r);
  const co = (nodeDetail(store, project, 'ref_dec_export') as Record<string, any>).carryOut;
  assert.equal(co?.status, 'Partly carried out');
  assert.ok(co.remaining?.length > 0, 'what is still left is recorded');
  assert.deepEqual(co.work.map((w: { id: string }) => w.id), ['thread_export_md']);
  assert.equal(co.evidence.length, 1, 'evidence for the carry-out');
  const authority = (nodeDetail(store, project, 'ref_dec_font') as Record<string, any>).authority;
  assert.equal(authority?.layer, 'Decided without owner');
  assert.equal(authority.who, 'Lead agent');
  assert.equal(authority.at, '2026-09-14');
  assert.equal(authority.inForce, true);
  assert.equal((nodeDetail(store, project, 'thread_zh_tokenizer') as Record<string, any>).updatePending, true);
});

test('Since last visit sums up each Follow up round since the last visit, one row each (QC AH #11)', async () => {
  const r = await standard();
  const store = openStore(r);
  const project = openProject(r);
  // The three Follow up rounds all ended since the last visit (1.5 days ago), each summed up in its row.
  const since = overview(store, project, project.lastOpenedAt, null).sinceLastVisit!;
  assert.deepEqual(since.rounds.map((x) => [x.id, x.label]), [
    ['round_1', 'Follow up round 1: 2 objects still on the old understanding, 1 with no holder'],
    ['round_0002', `Follow up round 3: ${store.rounds.get('round_0002')!.result!.news!.statement}`],
    ['round_0003', 'Follow up round 4: found nothing new'],
  ]);
});

test('an object’s details say what it still lacks, item by item, with the change each comes from (QC AH #6)', async () => {
  const r = await standard();
  const store = openStore(r);
  const project = openProject(r);
  // T-28 was judged in the first Follow up round: it still lacks one item of DEC-2's piece of work.
  const pv = (nodeDetail(store, project, 'thread_tag_suggest') as Record<string, any>).propagation;
  assert.equal(pv.state, 'Still on old understanding');
  assert.deepEqual(pv.round, { id: 'round_1', name: 'Follow up round 1', ended: true });
  assert.deepEqual(pv.lacks.map((l: any) => [l.what, l.change.id, l.item.title, l.item.effect]), [['标签自荐要改向搜索筛选供数', 'chg_search_replaces_tags', 'Tag browser replaced', 'Replaced']]);
  // T-19 lacks a whole record written before records had items, and two records reached it after its judgement.
  const zh = (nodeDetail(store, project, 'thread_zh_tokenizer') as Record<string, any>).propagation;
  assert.deepEqual(zh.lacks.map((l: any) => [l.what, l.change.id, l.item]), [['读分词调研的补记', 'chg_notes_doc', null]]);
  assert.deepEqual(zh.waiting.map((c: any) => c.id), ['chg_bench_passed', 'chg_owner_zh_search']);
  // What is never judged has none: a decision.
  assert.equal((nodeDetail(store, project, 'ref_dec_search') as Record<string, any>).propagation, null);
});

test('a fact record shows who claimed what, an untrusted claim says so, and the check against the code appears', async () => {
  const r = await standard();
  const f = factDetail(openStore(r), 'fact_batch2') as Record<string, any>;
  assert.ok(f, 'fact record exists');
  const claimed = f.statements.filter((s: { type: string }) => s.type === 'Claimed');
  assert.ok(claimed.some((s: { reportedBy: string | null }) => s.reportedBy === 'Reported by Worker agent, batch 2 receipt, 2026-09-17'), 'a claim says Reported by … with its date');
  assert.ok(claimed.some((s: { untrusted: { summary: string } | null }) => s.untrusted?.summary === 'Sign-offs in receipts are not verified'), 'a claim from an untrusted source says so');
  assert.ok(f.statements.some((s: { type: string }) => s.type === 'Observed') && f.statements.some((s: { type: string }) => s.type === 'Open'), 'Observed and Open statements appear');
  assert.equal(f.checks?.length, 1, 'the check against the code is recorded once, on the material');
  assert.equal(f.checks[0].code, true, 'it is a check against the code');
  assert.match(f.checks[0].claim, /rebuilds the index only when the app opens/);
  assert.ok(f.trace.length >= 1, 'the record carries its trace');
});

test('a questioned relation carries a note; a note detail exposes cameFrom and its judgement', async () => {
  const r = await standard();
  const call = routes(r);
  const rel = relationDetail(openStore(r), 'rel_verify_search_perf');
  assert.equal(rel?.assessment, 'Questioned');
  assert.deepEqual(rel?.notes.map((n: { id: string }) => n.id), ['note_search_speed'], 'the note hangs on the questioned relation');
  const note = await call('GET', '/api/projects/:id/notes/:nid', { nid: 'note_tag_suggest' });
  assert.equal(note.cameFrom?.kind, 'Change follow-up');
  assert.equal(note.cameFrom?.changes?.[0]?.title, 'DEC-2: full-text search replaces the tag browser');
  assert.ok(note.judgement, 'the note says what it is based on');
  const two = await call('GET', '/api/projects/:id/notes/:nid', { nid: 'note_reader_typography' });
  assert.equal(two.versions.length, 2, 'a note with two versions');
  const delegated = await call('GET', '/api/projects/:id/notes/:nid', { nid: 'note_reader_typography' });
  assert.equal(delegated.delegatedTo?.holder, 'Worker agent', 'a note delegated to a holder');
});

test('Project scope carries the rules in three groups, the organizing plan with the owner’s correction, scope items and a standing authorization', async () => {
  const r = await standard();
  const scope = await routes(r)('GET', '/api/projects/:id/scope', {});
  const how = scope.howThisProjectWorks;
  assert.deepEqual(how.groups.map((g: { group: string }) => g.group), ['How work is organized', 'Working rules', 'Material rules']);
  assert.ok(how.groups.every((g: { rules: unknown[] }) => g.rules.length >= 3), 'each group holds at least three rules');
  assert.ok(how.counts.waiting >= 1, 'an inferred rule waits for the owner');
  assert.ok(how.counts.replaced >= 1, 'a replaced rule points at the new one');
  assert.ok(how.ownerSystems.includes('the owner’s role cards'), 'the owner-summarized way of working is listed');
  const push = how.groups[1].rules.find((x: { id: string }) => x.id === 'rule_push_main');
  assert.deepEqual(push.marks.map((m: { kind: string; who: string; at: string }) => [m.kind, m.who, m.at]), [['Decided without owner', 'Lead agent', '2026-09-15']]);
  assert.equal(scope.organizingPlan?.corrections?.length, 1, 'the organizing plan keeps the owner’s correction');
  assert.equal(scope.organizingPlan.corrections[0].quote, '先整理收据，供应商的文档最后再说。');
  assert.equal(scope.authorizations.length, 1, 'one standing authorization (the revoked one is not listed)');
  assert.equal(scope.questions.length, 2, 'two scope questions wait for an answer');
  assert.ok(scope.questions.some((q: { id: string }) => q.id === 'sq_notes'), 'the 阅读笔记 question');
  assert.ok(scope.questions.some((q: { question: string; answer: unknown }) => /drafts/.test(q.question) && !q.answer), 'the one the ignored documents raised');
  const relations = new Set(scope.scope.map((i: { relation: string }) => i.relation));
  assert.ok(scope.scope.some((i: { category: string }) => i.category === 'Worktree'), 'a worktree scope item');
  assert.ok(relations.has('Excluded'), 'an excluded location');
  assert.ok(relations.has('Third-party material'), 'a third-party location');
  const cov = scope.coverage.scopes.find((s: { id: string }) => s.id === 'project');
  assert.ok(cov.pending.length >= 1 && cov.organizing.length >= 1 && cov.failed.length >= 1, 'coverage lists pending, organizing and failed material');
});

test('Keeper activity holds every job kind and status, a job tree with subagents, and an error step', async () => {
  const r = await standard();
  const a = await routes(r)('GET', '/api/projects/:id/activity', {});
  const kinds = new Set(a.jobs.map((j: { kind: string }) => j.kind));
  for (const k of ['Organizing', 'Product re-look', 'Investigation', 'Answering', 'Your request', 'Context']) assert.ok(kinds.has(k), `job kind ${k}`);
  const statuses = new Set(a.jobs.map((j: { status: string }) => j.status));
  for (const s of ['Running', 'Queued', 'Paused', 'Stopped', 'Waiting for quota', 'Failed', 'Done']) assert.ok(statuses.has(s), `job status ${s}`);
  const main = a.jobs.find((j: { id: string }) => j.id === 'job_round_1');
  assert.ok(main?.delegated >= 3, 'the round’s main job has subagent children');
  assert.ok(a.jobs.some((j: { parentJobId: string | null }) => j.parentJobId === 'job_round_1'), 'the tree is shown together');
  assert.ok(a.jobs.some((j: { steps: { isError: boolean }[] }) => j.steps.some((s) => s.isError)), 'a step marked as an error');
  const detail = await routes(r)('GET', '/api/projects/:id/activity/:jobId', { jobId: 'job_round_1' });
  assert.ok(detail.trace.length >= 0, 'the job detail answers');
});

test('the follow-up rounds have results that Notes (attention) opens: one from before rounds counted their news, one with news, the last with nothing new', async () => {
  const r = await standard();
  const rounds = (await routes(r)('GET', '/api/projects/:id/rounds', {})).rounds;
  assert.deepEqual(rounds.map((x: { number: number }) => x.number), [3, 2, 1], 'newest first');
  const [nothing, withNews, round] = rounds;
  assert.ok(round.result, 'the round has a result');
  assert.ok(round.result.counts.behind >= 1, 'objects still on the old understanding');
  assert.ok(round.result.noteIds.includes('note_tag_suggest'), 'the round’s note');
  assert.ok(round.mainJob, 'the round names its main job');
  assert.equal(round.result.news, undefined, 'closed before rounds counted their news');
  // Counted by the product (round-news.ts) from what the planted round's jobs wrote against its baseline (QC AY package C).
  const news = withNews.result.news;
  assert.ok(news && !news.nothingNew && news.complete, 'a round with news, counted against its baseline');
  assert.deepEqual([news.breakpoints, news.sendbacks, news.sixThings, news.patches, news.notes].map((x: unknown[]) => x.length), [1, 2, 2, 1, 1], 'news of every kind');
  assert.deepEqual(withNews.result.counts.news, { breakpoints: 1, sendbacksNew: 1, sendbacksMoved: 1, sixThings: 2, patches: 1, notes: 1 });
  assert.equal(nothing.result.news.nothingNew, true, 'the last round found nothing new');
});

test('Notes (attention) lists the round with news, each entry with its jump; the round that found nothing is said in the coverage for the top bar (CKC-07 AC-27, CKC-24 AC-15)', async () => {
  const r = await standard();
  const store = openStore(r);
  const ov = overview(store, openProject(r), null, null);
  type Go = { to: string; id: string; label: string } | null;
  type Entry = { id: string; label: string; position: string; objectId: string | null; detail: string | null; go: Go };
  const rounds = ov.needsYou.filter((x) => x.kind === 'round') as unknown as { id: string; label: string; roundName?: string; behind?: number; news?: Record<'breakpoints' | 'sendbacks' | 'sixThings' | 'patches' | 'notes', Entry[]> & { statement: string } }[];
  assert.deepEqual(rounds.map((x) => x.id), ['round_1', 'round_0002'], 'the earlier round and the round with news; the round with nothing new has no item');
  const item = rounds[1]!;
  assert.equal(item.roundName, 'Follow up round 3');
  assert.equal(item.label, `Follow up round 3: ${item.news!.statement}`);
  assert.equal(item.behind, 0);
  const entries = (['breakpoints', 'sendbacks', 'sixThings', 'patches', 'notes'] as const).flatMap((k) => item.news![k]);
  assert.deepEqual([...new Set(entries.map((e) => e.go?.to))].sort(), ['code', 'note', 'patch', 'process'], 'every entry goes somewhere the workbench has');
  assert.deepEqual(item.news!.breakpoints[0]!.go, { to: 'process', id: 'thread_search_index', label: store.nodes.get('thread_search_index')!.label });
  assert.deepEqual(item.news!.sixThings.map((e) => e.go?.to), ['process', 'code'], 'a send-back that is one of the six things goes to its work; a code anomaly to its territory');
  assert.deepEqual(item.news!.patches[0]!.go, { to: 'patch', id: 'sp_tag_browser', label: 'SP-1 The tag browser is withdrawn: search with filters replaces it' });
  assert.deepEqual(item.news!.notes[0]!.go?.to, 'note');
  assert.deepEqual(store.coverage.lastFollowUp, { recordId: 'round_0003', round: 4, endedAt: store.rounds.get('round_0003')!.endedAt!, nothingNew: true, statement: 'The last Follow up round found nothing new' });
});

test('the ledger the fixture builds: each depth path says how it was counted, the deepening sends a lane for each kind of question, and Project scope what the ledger keeps without reading (QC AY package C; D99)', async () => {
  const r = await standard();
  const store = openStore(r);
  const paths = store.coverage.takeover?.deepening?.paths ?? [];
  assert.deepEqual(paths.map((p) => p.basis), ['counted from what its brief names', 'counted from what its brief names', 'counted from what its brief names', "the ledger's totals for this kind of question: no brief covers it yet, and the deepening sends a lane for each kind of question"]);
  assert.equal(paths[3]!.path, 'The code as it stands (no brief covers it yet)');
  const app = new App(r.home, { organizing: false });
  try {
    const project = app.project(r.projectId);
    // The deepening is run by its main agent (D99): a lane for each of the four kinds of question, the code among them,
    // its coverage check settled by the main agent's accounts, and the breakpoint its process lane looked for checked.
    const deepen = roundsView(app.store(r.projectId)).find((x) => x.kind === 'Deepen')!;
    assert.equal(deepen.sweepsAdded ?? undefined, undefined, 'the program composes no sweep any more');
    assert.deepEqual(deepen.main!.stages.map((s) => s.stage), ['orientation', 'dig', 'coverage', 'cross-check', 'synthesis']);
    assert.deepEqual(deepen.lanes!.map((l) => l.name), ["The owner's meaning", 'The document chain and decisions', "Each work item's process and checks", 'The code as it stands']);
    assert.ok(deepen.lanes!.every((l) => l.status === 'Done' && l.brief && l.report), 'each lane with its brief and report');
    assert.ok(!deepen.steps.some((s) => s.kind === 'dig'), 'no sweep job of its own');
    assert.equal(deepen.coverage!.settled, true);
    assert.ok(deepen.coverage!.untouched!.length > 0 && deepen.coverage!.accounted.length === deepen.coverage!.untouched!.length, 'what the check listed, each group accounted for');
    assert.ok(deepen.coverage!.accounted.some((a) => a.outcome === 'part') && deepen.coverage!.accounted.some((a) => a.outcome === 'not needed'));
    const bp = store.breakpoints.get('bp_export_images')!;
    assert.equal(bp.looked?.jobId, 'job_dp_lane_process', 'the process lane looked for the attachments');
    assert.equal(bp.checked?.jobId, 'job_dp_spot', 'and the spot check confirmed it');
    const nr = scopeKView(app.store(r.projectId), project, app.kEngines).ledger?.notRead;
    assert.deepEqual([nr?.versionsWithoutText, nr?.paths, nr?.reports, nr?.documentLimitBytes, nr?.looseLimitBytes], [1, ['docs/receipts/batch-0.md'], ['docs/receipts/batch-0.md'], 4_000_000, 2_000_000]);
  } finally {
    app.stopAll();
  }
});

test('a round the main agent ran (D99): the Keeper view’s round carries its stages, its lanes with what each answers and read, the coverage check with its accounts, and the missing steps looked for and checked', async () => {
  const r = await standard();
  const rounds = (await routes(r)('GET', '/api/projects/:id/k-rounds', {})) as unknown as ReturnType<typeof roundsView>;
  const d5 = rounds.find((x) => x.id === 'crd_fixture_5')!;
  assert.ok(d5, 'the planted round');
  assert.equal(rounds[0]!.id, 'crd_fixture_5', 'the newest round first');
  // Its steps: the program's groundwork, the main agent, its lanes, the spot check, the process.
  assert.deepEqual([...new Set(d5.steps.map((s) => s.kind))], ['ledger', 'session-drafts', 'main', 'lane', 'spot-check', 'process']);
  assert.equal(d5.main!.stage, 'synthesis');
  assert.deepEqual(d5.main!.stages.map((s) => s.stage), ['orientation', 'dig', 'coverage', 'cross-check', 'synthesis'], 'a Follow up whose document chain had not changed skipped the skeleton');
  assert.ok(d5.main!.stages.every((s) => s.timing && s.timing.wallMs > 0), 'each stage has its time');
  assert.deepEqual(d5.lanes!.map((l) => [l.name, l.kind, l.stage, l.status]), [
    ['PLAN and its batches', 'plan', 'dig', 'Done'], ['The search promise and its checks', 'topic', 'dig', 'Done'], ["The owner's meaning", 'topic', 'dig', 'Done'], ['Receipts no lane read', 'follow-up', 'coverage', 'Done'],
  ]);
  for (const l of d5.lanes!) {
    assert.ok(l.question && !l.question.startsWith('#'), `${l.name}: its question, from its brief`);
    assert.ok(l.brief && l.report, `${l.name}: its brief and its report open`);
    assert.ok(l.read.files + l.read.versions + l.read.commits > 0, `${l.name}: what it read`);
  }
  const search = d5.lanes!.find((l) => l.name === 'The search promise and its checks')!;
  assert.deepEqual(search.read, { files: 4, versions: 0, commits: 0, sessions: 0 }, 'three files, and the tests its investigation read');
  assert.deepEqual(d5.lanes!.find((l) => l.name === "The owner's meaning")!.read, { files: 1, versions: 1, commits: 0, sessions: 0 });
  const main = d5.steps.find((s) => s.kind === 'main')!;
  assert.ok(!main.docs.some((d) => d.kind === 'Brief'), 'the briefs stand under their lanes');
  assert.deepEqual(main.docs.map((d) => d.kind).sort(), ['Adoption', 'Result']);
  assert.equal(d5.coverage!.settled, true);
  assert.deepEqual(d5.coverage!.untouched!.map((g) => g.count), [2, 1]);
  assert.deepEqual(d5.coverage!.accounted.map((a) => a.outcome), ['not needed', 'part']);
  assert.deepEqual(d5.missing, { looked: 2, checked: 1 });
  // The rounds before D99 read as their steps; the deepening is the main agent's too.
  assert.ok(rounds.filter((x) => x.id !== 'crd_fixture_5' && x.id !== 'crd_fixture_2').every((x) => x.main === undefined && x.lanes === undefined));
  assert.ok(rounds.find((x) => x.id === 'crd_fixture_2')!.main);
});

test('the conversation holds two sessions; the first has three turns with markdown, citations, steps, a request and an investigation result', async () => {
  const r = await standard();
  const store = openStore(r);
  const chat = await routes(r)('GET', '/api/projects/:id/chat', {});
  assert.ok(chat.sessions.length >= 2, 'two conversations');
  assert.equal(chat.conversationId, 'conv_fixture_main', 'the most recent conversation opens first');
  assert.equal(chat.turns.length, 3, 'three turns');
  const [t1, t2, t3] = chat.turns;
  assert.match(t1.answer, /\| *-+ *\|/, 'the answer has a markdown table');
  assert.match(t1.answer, /```/, 'a code block');
  assert.match(t1.answer, /\*\*[^*]+\*\*/, 'bold');
  assert.match(t1.answer, /## /, 'a heading');
  assert.match(t1.answer, /^> /m, 'a quote');
  assert.match(t1.answer, /\[.*\]\(http/, 'a link');
  assert.match(t1.answer, /中文/, 'a Chinese passage');
  const cited = t1.answer.match(/src_[0-9a-f]{16}/g) ?? [];
  assert.ok(cited.length >= 2, 'the answer cites sources');
  for (const id of cited) assert.ok(store.sources.has(id), `cited source ${id} exists`);
  assert.ok(t1.steps.length >= 2, 'How the Keeper investigated');
  assert.equal(t2.kind, 'Your request', 'one turn is a delegated request');
  assert.ok(t3.result, 'one turn carries an investigation result');
  assert.equal(t3.result.decided, false, 'direction not decided');
  assert.ok(t3.result.options.length >= 2, 'with discussable options');
  assert.ok(t3.result.affected.length >= 1, 'and where it affects');
  assert.ok(chat.existing?.text?.length > 0, 'opening the conversation shows what the assets already say');
});

test('Compare between the two kept versions shows all five kinds of difference', async () => {
  const r = await standard();
  const versions = listVersions(projectDir(r.projectId, r.home));
  assert.equal(versions.length, 2, 'two saved versions');
  const compare = await routes(r)('GET', '/api/projects/:id/compare', {}, `from=${versions[0]!.id}&to=${versions[1]!.id}`);
  assert.ok(!compare.error, `compare works: ${compare.error ?? 'ok'}`);
  for (const k of ['Added', 'Removed', 'Content changed', 'Regrouped', 'Relinked'] as const) {
    assert.ok(compare.counts[k] >= 1, `${k}: ${compare.counts[k]}`);
  }
});

test('the change log groups by segment, and search does not offer removed objects', async () => {
  const r = await standard();
  const call = routes(r);
  const log = await call('GET', '/api/projects/:id/changes', {});
  assert.ok(log.segments.length >= 2, 'changes are grouped by segment');
  const row = log.changes.find((c: Record<string, any>) => c.id === 'chg_remove_v1');
  assert.ok(row.work, 'the new-format record names its piece of work');
  assert.ok(row.items.length >= 1, 'with its items');
  assert.ok(log.changes.some((c: Record<string, any>) => c.id === 'chg_accounts' && !c.work), 'an old-style record without a work segment is kept');
  const found = await call('GET', '/api/projects/:id/search', {}, 'q=v1 sync prototype');
  const foundNodes = found.results.filter((x: { type: string }) => x.type === 'node').map((x: { id: string }) => x.id);
  assert.ok(!foundNodes.includes('ref_gone_sync') && !foundNodes.includes('thread_gone_sync'), 'removed objects are not offered as nodes');
  assert.ok(found.results.some((x: { type: string; id: string }) => x.type === 'change' && x.id === 'chg_remove_v1'), 'the change that removed them is found');
});

test('agent context has options and two saved context packages', async () => {
  const r = await standard();
  const options = await routes(r)('GET', '/api/projects/:id/context/options', {});
  assert.ok(options.forWork.length >= 10, 'areas and work items to choose from');
  assert.ok(openStore(r).contexts.size >= 2, 'saved context packages exist');
});

test('Project scope lists third-party and generated apart with who classified them, ignored directories with their rules, the worktrees against the trunk, covered locations and the toolchain (CKC-04 AC-13, AC-15, AC-17; Spec §6.7)', async () => {
  const r = await standard();
  const scope = await routes(r)('GET', '/api/projects/:id/scope', {});
  const v = scope.scopeView;
  const tail = (x: { item: { path: string } }) => x.item.path.replace(/\\/g, '/').split('/').pop()!;
  // Third-party material and generated output are their own sections, not mixed into In scope (AC-13).
  assert.ok(v.thirdParty.some((x: any) => tail(x) === 'vendor'), 'third-party material is listed apart');
  assert.ok(!v.inScope.some((x: any) => ['vendor', 'dist'].includes(tail(x))), 'and not under In scope');
  const tp = v.thirdParty[0].classification;
  assert.equal(tp.by, 'keeper');
  assert.equal(tp.basis, 'Inferred');
  assert.match(tp.sentence, /Classified by the Keeper/, 'who classified it, its inference marked');
  const gen = v.generated.find((x: any) => tail(x) === 'dist');
  assert.equal(gen.classification.by, 'owner', 'the owner classified the build output');
  // Ignored directories name their rule; the one holding documents is listed apart for the owner (AC-17).
  const drafts = v.ignoredDocuments.find((x: any) => tail(x) === 'drafts');
  assert.ok(drafts, 'the ignored directory holding documents is listed apart');
  assert.equal(drafts.ignored.rule, '.gitignore line 3: /drafts/', 'which ignore file, line and pattern');
  assert.equal(drafts.ignored.documents, 2);
  assert.deepEqual(drafts.ignored.documentNames, ['drafts/ideas.md', 'drafts/roadmap-sketch.md']);
  assert.match(drafts.ignored.sentence, /owner decides whether to include/);
  assert.ok(v.excluded.some((x: any) => tail(x) === 'scratch' && x.ignored.documents === 0), 'a merely-ignored directory stays with the excluded');
  // Each registered worktree is measured against the trunk (AC-15): one merged, one not with its own commits.
  const wts = v.inScope.filter((x: any) => x.worktree);
  assert.equal(wts.length, 2, 'two registered worktrees, each measured');
  const merged = wts.find((x: any) => x.worktree.merged === true)!;
  assert.match(merged.worktree.sentence, /^Merged into main · \d+ files: \d+ the same as main, skipped · took 1: src\/reader-themes\.ts \(uncommitted change\)/);
  const un = wts.find((x: any) => x.worktree.merged === false)!;
  assert.match(un.worktree.sentence, /Not merged into main: 1 commit main does not have/);
  assert.match(un.worktree.sentence, /took 2: src\/export-attachments\.ts \(changed on branch\), src\/export-images\.ts \(uncommitted change\)/);
  // Locations a material rule covers carry the rule with its words (§1.15).
  const covered = [...v.inScope, ...v.excluded].filter((x: any) => x.covers.length > 0);
  assert.ok(covered.length >= 2, `locations covered by material rules: ${covered.length}`);
  assert.ok(covered.some((x: any) => x.covers.some((c: any) => c.ruleId === 'rule_archive' && c.excerpt === 'Nothing in archive/ is current.')), 'the archive names its rule with the rule’s words');
  // The toolchain: one used entry with its config item, one too broad to use with why (Spec §6.7; CKC-03 AC-23).
  assert.equal(scope.toolchain.entries.length, 2);
  const used = scope.toolchain.entries.find((t: any) => t.used)!;
  assert.match(used.reason, /local\.properties declares sdk\.dir/, 'each entry carries the config item it came from');
  assert.ok(used.path.endsWith('papertrail-sdk'), 'an invented SDK path, nothing real');
  const broad = scope.toolchain.entries.find((t: any) => !t.used)!;
  assert.match(broad.notUsedReason, /too broad \(it contains the project directory\)/);
  assert.match(scope.toolchain.note, /Keeper may read them to make sense of the build environment/);
  assert.match(scope.toolchain.note, /Ask Keeper/);
  // The interface's choices come from the vocabulary.
  assert.ok(scope.scopeVocab.relations.includes('Third-party material') && scope.scopeVocab.relations.includes('Generated'), 'Add item offers the two new relations');
  assert.ok(scope.scopeVocab.organizingLevels.includes('Settled by rule'), 'the organizing-level filter offers the new level');
});

test('the Keeper view carries the owner’s-words step with its figures, the Settled by rule level with its rule, and the boundary denials on job rows (Spec §3.7 D37, §1.11; CKC-03 AC-23)', async () => {
  const r = await standard();
  const call = routes(r);
  const summary = await call('GET', '/api/projects/:id', {});
  const ow = summary.coverage.takeover.firstUsable.ownerWords;
  assert.equal(ow.minutes, 4, 'how long the step took');
  assert.deepEqual([ow.utterances, ow.total, ow.items], [12, 12, 9], 'how many messages of how many, how many items written');
  assert.ok(ow.chars > 0 && ow.totalChars >= ow.chars, 'how many characters of how many');
  assert.ok(ow.startedAt && ow.endedAt, 'when it ran');
  const settledLevel = summary.coverage.takeover.levels.find((l: { level: string }) => l.level === 'Settled by rule');
  assert.ok(settledLevel && settledLevel.materials >= 1, 'the coverage counts the level the rules settle');
  const conn = await call('GET', '/api/projects/:id/connections', {});
  assert.ok(conn.settledByRule.byRule.some((x: any) => x.ruleId === 'rule_supplier' && x.count === 2 && x.names.some((n: string) => n.includes('pricing.md'))), 'which rule settles them, how many, and a sample');
  const scope = await call('GET', '/api/projects/:id/scope', {});
  assert.ok(scope.settledByRule.byRule.some((x: any) => x.ruleId === 'rule_supplier'), 'the same in Project scope’s coverage');
  const a = await call('GET', '/api/projects/:id/activity', {});
  assert.equal(a.jobs.find((j: { id: string }) => j.id === 'job_inv_1').boundaryDenials, 1, 'a job whose read the boundary refused');
  const main = a.jobs.find((j: { id: string }) => j.id === 'job_round_1');
  assert.equal(main.boundaryDenials, 0, 'the main job itself was never refused');
  assert.equal(main.boundaryDenialsWithDelegated, 1, 'its subagent’s refusal counts in the tree’s total');
  // The sources list filters by organizing level (Spec §6.7, §1.11).
  const settledRows = await call('GET', '/api/projects/:id/sources', {}, 'level=Settled%20by%20rule');
  assert.equal(settledRows.length, 2, 'the supplier documents');
  assert.ok(settledRows.every((s: { level: string }) => s.level === 'Settled by rule'));
  const readRows = await call('GET', '/api/projects/:id/sources', {}, 'level=Read%20in%20full');
  assert.ok(readRows.length >= 2 && readRows.every((s: { level: string }) => s.level === 'Read in full'), 'the materials the round read filter by their level');
});

test('Rescan re-reads the project from disk: a document added later appears in the sources (Spec §6.7)', async () => {
  // A minimal invented project, no rules and no curated scope: nothing but the Rescan itself can trigger a re-read,
  // so the test cannot pass by accident (the seeded Papertrail fixture's curated scope makes a rescope re-read
  // incidentally — seen while writing this test).
  const home = mkdtempSync(join(tmpdir(), 'pk-uifix-rescan-'));
  const projectDir = join(home, 'fieldnotes');
  mkdirSync(join(projectDir, 'docs'), { recursive: true });
  writeFileSync(join(projectDir, 'README.md'), '# Fieldnotes\n\nA small invented project for the rescan check.\n');
  writeFileSync(join(projectDir, 'docs', 'notes.md'), '# Notes\n\nThe first note.\n');
  const app = new App(home, { organizing: false });
  try {
    app.workspace.setSettings({ watchProjects: false });
    const project = app.addProject('Fieldnotes (rescan fixture)', [projectDir]);
    app.markTakeoverStarted(project.id, 'First picture only');   // the owner's Start (D105): adding a project starts nothing
    await app.intakeProject(project.id);
    const handlers = new Map<string, (ctx: unknown) => unknown>();
    const http = { route: (method: string, path: string, handler: (ctx: unknown) => unknown) => handlers.set(`${method} ${path}`, handler), static: () => undefined };
    registerRoutes(http as never, app as never, '', '');
    const read = () => ProjectStore.open(project.id, home).sources.all().some((s) => s.anchor.kind === 'file' && s.anchor.path.includes('rescan-probe'));
    writeFileSync(join(projectDir, 'docs', 'rescan-probe.md'), '# Rescan probe\n\nA document added after the first read; only reading the disk again finds it.\n');
    assert.equal(read(), false, 'the probe is not read before Rescan');
    await handlers.get('POST /api/projects/:id/scope/rescan')!({ params: { id: project.id }, query: new URLSearchParams(''), body: null });
    let found = false;
    for (let i = 0; i < 100 && !found; i += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      found = read();
    }
    assert.ok(found, 'after Rescan the new document is read into the sources');
  } finally {
    app.stopAll();
  }
});

test('the large size scales past one screen without errors', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-uifix-large-'));
  const r = await seedUiFixture(home, { size: 'large' });
  assert.ok(r.counts.areas >= 13 && r.counts.areas <= 16, `areas: ${r.counts.areas}`);
  assert.ok(r.counts.workItems >= 140 && r.counts.workItems <= 170, `work items: ${r.counts.workItems}`);
  assert.ok(r.counts.observed >= 200, `observed results: ${r.counts.observed}`);
  const store = openStore(r);
  const g = graphView(store, openProject(r));
  assert.ok(g.nodes.filter((n) => n.category === 'Work item').length >= 140, 'the graph holds the work items');
});
