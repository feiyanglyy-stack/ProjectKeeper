/**
 * What the workbench shows of the assets Spec v2.8 adds (CKC-09 AC-32, AC-33; CKC-21 AC-11, AC-12; Spec §6.3, §6.4,
 * §6.7, §6.9). The view data is assembled on the server, so the browser only draws it: the owner's words as one
 * group on top, removed objects only in the changes, the authority layer, a decision's carry-out, who claimed what
 * and when with what the code shows, the project's rules and the organizing plan in Project scope, and nothing on
 * the graph that a rule produced.
 *
 * The fixtures are an invented project, "Tidewater", a small tide-table app. The routes are called directly: a stub
 * app that holds one store is enough, and nothing is served or started.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { deriveGraph } from '../keeper/organize/graph.ts';
import { changeRow, factDetail, graphView, nodeDetail, overview, threadDetail } from './graph-view.ts';
import { scopeListView, settledByRuleView, toolchainView } from './workbench-content.ts';
import { registerRoutes } from './api.ts';
import { ConversationService } from '../keeper/conversation.ts';
import type {
  Attribution, ChangeRecord, EntryMark, FactRecord, GraphRelation, KeeperJob, Note, OrganizingPlan, Project, ProjectRule,
  ReferenceItem, Source, SourceAnchor, Statement, WorkThread,
} from '../model/types.ts';

const AT = '2026-09-18T08:00:00.000Z';
const inputs = { jobId: 'job_frame', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' };
const project = { id: 'p1', name: 'Tidewater', language: 'en', locations: ['D:\\tidewater'], scope: [], scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false, lastScopedAt: null } as unknown as Project;
const by = (kind: 'owner' | 'role' | 'agent' | 'unknown', name: string | null, identity: Attribution['identity']): Attribution =>
  ({ author: { kind, name, window: null, host: null, model: null }, holder: null, identity });

function tidewater(): ProjectStore {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-bench-')));
  const source = (id: string, title: string, anchor: SourceAnchor, over: Partial<Source> = {}) => store.sources.put({
    id, projectId: 'p1', title, anchor, ids: [], version: { fingerprint: 'sha256:0', readAt: AT, commit: null }, excerpt: `${title} text`,
    usedAs: 'Other', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: 'scope_main', hasCredential: false, bytes: 40, ...over,
  } as Source);
  const file = (path: string, heading: string, from = 1, to = 20): SourceAnchor => ({ kind: 'file', path, headingPath: [heading], lineStart: from, lineEnd: to });
  source('src_talk', 'Owner message, 12 Sep', { kind: 'session', host: 'claude', sessionId: 'sess0001aaaa', file: 'D:\\sessions\\a.jsonl', cwd: 'D:\\tidewater', messageStart: 4, messageEnd: 4, at: '2026-09-12T09:00:00.000Z' }, { usedAs: 'Session', excerpt: 'Tide times have to work offline, and never show a time we have not checked.' });
  source('src_prd', 'PRD.md › Offline', file('D:\\tidewater\\PRD.md', 'Offline'), { usedAs: 'Requirement' });
  source('src_receipt', 'Batch 3 receipt', file('D:\\tidewater\\docs\\receipts\\batch-3.md', 'Done', 1, 12), { usedAs: 'Status', excerpt: 'The cache is refreshed every hour.' });
  source('src_code', 'cache.ts', file('D:\\tidewater\\src\\cache.ts', 'refresh', 40, 52), { usedAs: 'Code', version: { fingerprint: 'sha256:1', readAt: AT, commit: 'abc1234def5678' } });
  source('src_agents', 'AGENTS.md › How we work', file('D:\\tidewater\\AGENTS.md', 'How we work'), { usedAs: 'Other', excerpt: 'Every task gets the next number in docs/TASKS.md.' });
  source('src_old', 'docs/offline-v1.md', file('D:\\tidewater\\docs\\offline-v1.md', 'Offline v1'), { usedAs: 'Design', availability: 'No longer available' });
  source('src_fix', 'Owner message, 19 Sep', { kind: 'session', host: 'claude', sessionId: 'sess0002bbbb', file: 'D:\\sessions\\b.jsonl', cwd: 'D:\\tidewater', messageStart: 2, messageEnd: 2, at: '2026-09-19T10:00:00.000Z' }, { usedAs: 'Session', excerpt: 'Read the receipts closely, not the vendored charts.' });

  const ref = (id: string, category: string, name: string, over: Partial<ReferenceItem> = {}) => store.reference.put({
    id, projectId: 'p1', category, name, ids: [], text: `${name}: what it says`, quote: null, basis: 'Explicit', validity: 'Current', progress: null,
    attribution: by('role', 'Product lead', 'Artifact'), sourceIds: ['src_prd'], refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT, ...over,
  } as ReferenceItem);
  const owner = by('owner', null, 'Decision');
  ref('ow_offline', "Owner's words", 'Works offline', { quote: 'Tide times have to work offline', attribution: owner, sourceIds: ['src_talk'] });
  ref('ow_checked', "Owner's words", 'Only checked times', { quote: 'never show a time we have not checked', attribution: owner, sourceIds: ['src_talk'] });
  ref('ref_product', 'Product', 'Tidewater, tide tables for small harbours', { refines: ['ow_offline'] });
  ref('ref_goal', 'Goal', 'G1 · Tide tables at sea', { ids: ['G1'], refines: ['ref_product', 'ow_offline'] });
  ref('ref_area', 'Area', 'A1 · Tables', { ids: ['A1'], refines: ['ref_goal'] });
  ref('ref_req', 'Requirement', 'R-2 · Only checked times are shown', { ids: ['R-2'], refines: ['ref_area', 'ow_checked'] });
  ref('ref_cache', 'Decision', 'D-4 · The cache refreshes hourly', { ids: ['D-4'], refines: ['ref_area'], attribution: by('role', 'Lead agent', 'Report'), sourceIds: ['src_receipt'] });
  ref('ref_export', 'Decision', 'D-5 · The legacy export goes', { ids: ['D-5'], refines: ['ref_area'], attribution: owner, sourceIds: ['src_talk'],
    carryOut: { status: 'Partly carried out', remaining: 'the settings page still links to the export', workIds: ['thread_export'], evidenceSourceIds: ['src_code'], at: AT, jobId: 'job_frame' } });
  ref('ref_gone', 'Requirement', 'R-9 · Offline v1 sync', { ids: ['R-9'], refines: ['ref_area'], validity: 'Removed', sourceIds: ['src_old'] });

  const claim = (text: string, sourceIds: string[], who: string, at: string, untrustedRuleId: string | null = null): Statement => ({ id: `st_${text.length}_${who.length}`, type: 'Claimed', text, sourceIds, claimedBy: { who, at, untrustedRuleId } });
  const work = (id: string, title: string, over: Partial<WorkThread> = {}) => store.threads.put({
    id, projectId: 'p1', title, ids: [], doing: `${title}: doing`, changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [],
    serves: [{ referenceId: 'ref_area', claim: 'part of the tables', basis: 'Explicit' }], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null,
    attribution: by('role', 'Worker agent', 'Artifact'), inputs, asOf: AT, updatedAt: AT, pendingSourceIds: [], ...over,
  } as WorkThread);
  work('thread_table', 'T-1 · Table view', { ids: ['T-1'], factRecordIds: ['fact_receipt'], executionFacts: [claim('The table renders in under a second', ['src_receipt'], 'Worker agent, batch 3 receipt', '2026-09-17')] });
  work('thread_export', 'T-2 · Remove the legacy export', { ids: ['T-2'], progress: 'Done' });
  work('thread_gone', 'T-9 · Offline v1 sync', { ids: ['T-9'], validity: 'Removed' });

  store.facts.put({
    id: 'fact_receipt', projectId: 'p1', title: 'Batch 3 receipt', aboutSourceIds: ['src_receipt'],
    statements: [
      claim('The cache is refreshed every hour', ['src_receipt'], 'Worker agent, batch 3 receipt', '2026-09-17'),
      { id: 'st_obs', type: 'Observed', text: 'cache.ts refreshes when the app starts, and at no other time', sourceIds: ['src_code'] },
      claim('Signed off by the reviewer', ['src_receipt'], 'Worker agent, batch 3 receipt', '2026-09-17', 'rule_unsigned'),
    ],
    decisions: [], changes: [], openQuestions: [], executionFacts: [], language: 'en', inputs, asOf: AT, updatedAt: AT, pendingSourceIds: [],
  } as FactRecord);
  store.relations.put({ id: 'rel_contra', projectId: 'p1', type: 'contradicts', from: 'src_code', to: 'src_receipt', claim: 'The receipt says hourly; the code refreshes only when the app starts (cache.ts L40–L52)', basis: 'Explicit', evidence: { sourceIds: ['src_code', 'src_receipt'], factRecordIds: ['fact_receipt'], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: AT } as GraphRelation);
  store.relations.put({ id: 'rel_gone', projectId: 'p1', type: 'depends on', from: 'thread_table', to: 'thread_gone', claim: 'used the v1 sync', basis: 'Explicit', evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: AT } as GraphRelation);

  const mark = (id: string, kind: EntryMark['kind'], targetId: string, over: Partial<EntryMark> = {}) => store.marks.put({ id, projectId: 'p1', kind, targetId, clueSourceIds: ['src_receipt'], clue: `${kind} on ${targetId}`, since: AT, noteId: null, closed: null, ...over } as EntryMark);
  mark('mark_cache', 'Decided without owner', 'ref_cache', { decidedBy: { who: 'Lead agent', at: '2026-09-14' } });

  const rule = (id: string, over: Partial<ProjectRule>) => store.rules.put({
    id, projectId: 'p1', group: 'Working rules', category: null, summary: `${id} summary`, excerpt: null, sourceIds: ['src_agents'], appliesTo: ['the whole project'],
    basis: 'Explicit', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: 'job_frame', asOf: AT, updatedAt: AT, ...over,
  } as ProjectRule);
  rule('rule_single', { group: 'How work is organized', summary: 'One agent works through each task and asks for no independent QC', basis: 'Inferred', sourceIds: ['src_receipt'], appliesTo: ['every task'] });
  rule('rule_roles', { group: 'How work is organized', summary: 'Work follows the owner’s role cards', excerpt: 'Each task is done by the role its card names.', ownerSystem: 'the owner’s role cards', differsInPractice: [{ text: 'Batch 3 was reviewed by the worker who wrote it', sourceIds: ['src_receipt'] }] });
  rule('rule_numbers_old', { summary: 'Tasks are numbered by date', excerpt: 'Name tasks by date.', validity: 'Replaced', replacedBy: 'rule_numbers' });
  rule('rule_numbers', { summary: 'Every task gets the next number in the task index', excerpt: 'Every task gets the next number in docs/TASKS.md.', appliesTo: ['docs/TASKS.md'], basis: 'Explicit', ownerConfirmation: { sourceId: 'src_fix', quote: 'yes, the index decides the number', at: '2026-09-19T10:00:00.000Z' } });
  rule('rule_push', { summary: 'Agents push straight to the main branch', excerpt: 'push to main when green', sourceIds: ['src_receipt'] });
  rule('rule_vendor', { group: 'Material rules', category: 'Reference only', summary: 'The vendored chart library’s documents are for reference only', excerpt: 'vendor/ is third-party code.', appliesTo: ['vendor/'] });
  rule('rule_unsigned', { group: 'Material rules', category: 'Untrusted', summary: 'Sign-offs in receipts are not verified', excerpt: 'Treat sign-offs in receipts as unverified.', appliesTo: ['docs/receipts/'] });
  mark('mark_push', 'Decided without owner', 'rule_push', { decidedBy: { who: 'Lead agent', at: '2026-09-15' } });

  store.plans.put({
    id: 'organizing-plan', projectId: 'p1',
    byRule: [{ what: 'the vendored chart library', targets: ['vendor/'], ruleId: 'rule_vendor', treatment: 'Reference only' }],
    readClosely: [{ what: 'the receipts', targets: ['docs/receipts/'], why: 'status rests on them' }],
    focus: [{ what: 'where the PRD parts from the owner’s words', why: 'drift is judged against the owner', sourceIds: ['src_talk'] }],
    order: ['task index first', 'receipts next'],
    corrections: [{ at: '2026-09-19T10:00:00.000Z', sourceId: 'src_fix', quote: 'Read the receipts closely, not the vendored charts.', changed: 'Receipts moved from sampled to read closely', previous: { byRule: [], readClosely: [], focus: [], order: ['task index first'] } }],
    jobId: 'job_frame', asOf: AT, updatedAt: AT,
  } as OrganizingPlan);

  store.changes.put({
    id: 'chg_delete', projectId: 'p1', at: '2026-09-19', atSource: 'material', material: 'Development note', effect: 'Abandoned', title: 'Offline v1 notes deleted',
    summary: 'The v1 design was deleted from the repository.', before: 'Offline v1 design', after: null, sourceIds: ['src_old'], by: by('role', 'Worker agent', 'Artifact'),
    affects: ['ref_gone', 'thread_gone', 'ref_area'], propagation: [], segment: null, createdInJobId: null, updatedAt: AT,
    work: { kind: 'Time range', label: 'File changes on 19 Sep', sessionId: null, startedAt: '2026-09-19', endedAt: '2026-09-19', openEnded: false },
    items: [{ id: 'item_1', at: '2026-09-19', atSource: 'material', material: 'Development note', effect: 'Abandoned', title: 'Offline v1 design deleted', summary: '', before: null, after: null, sourceIds: ['src_old'], by: by('role', 'Worker agent', 'Artifact'), why: null, affects: ['ref_gone', 'thread_gone'] }],
  } as ChangeRecord);

  store.jobs.put({
    id: 'job_frame', projectId: 'p1', kind: 'Organizing', initiator: 'auto', scope: { kind: 'takeover', ids: [], label: 'Framing round' }, status: 'Done',
    queuedAt: AT, startedAt: AT, endedAt: AT,
    savedResults: [{ collection: 'rules', id: 'rule_single', label: 'Rule: one agent' }, { collection: 'rules', id: 'rule_roles', label: 'Rule: role cards' }, { collection: 'plans', id: 'organizing-plan', label: 'Organizing plan and focus' }, { collection: 'threads', id: 'thread_table', label: 'Work thread: T-1' }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null,
    requestBasis: null, parentJobId: null, resultText: null, priority: 3, task: null,
  } as KeeperJob);
  store.jobs.put({ ...store.jobs.get('job_frame')!, id: 'job_other', savedResults: [{ collection: 'threads', id: 'thread_table', label: 'Work thread: T-1' }] });
  deriveGraph(store, project);
  return store;
}

/** The API's handlers, registered on a stub app that holds this one store; nothing is served. */
function routes(store: ProjectStore) {
  const handlers = new Map<string, (ctx: unknown) => unknown>();
  const http = { route: (method: string, path: string, handler: (ctx: unknown) => unknown) => handlers.set(`${method} ${path}`, handler), static: () => undefined };
  const app = {
    project: () => project, store: () => store, workspace: { list: () => [project] },
    keeper: { status: async () => ({ status: 'Idle', reason: '', detail: '' }), providerState: async () => ({ model: null, connected: false }) },
    pendingChanges: () => [],   // the watcher's list; nothing is watched here
  };
  registerRoutes(http as never, app as never, '', '');
  return async (method: string, path: string, params: Record<string, string>, query = '') =>
    (await handlers.get(`${method} ${path}`)!({ params: { id: 'p1', ...params }, query: new URLSearchParams(query), body: null })) as Record<string, any>;
}

test('the owner’s words form one group on top of the graph, and what refines them is linked by refines (CKC-09 AC-32; Spec §6.3)', () => {
  const store = tidewater();
  const g = graphView(store, project);
  const words = g.nodes.filter((n) => n.category === "Owner's words");
  assert.deepEqual(words.map((n) => n.id).sort(), ['ow_checked', 'ow_offline']);
  for (const n of words) assert.equal(n.group, "Owner's words", `${n.id} is drawn inside the owner’s words group, which the graph keeps folded until it is opened`);
  assert.equal(g.nodes.filter((n) => n.group === "Owner's words").length, 2, 'the group holds the owner’s words and nothing else');
  const refines = g.relations.filter((r) => r.type === 'refines' && (r.to === 'ow_offline' || r.to === 'ow_checked')).map((r) => `${r.from}→${r.to}`).sort();
  assert.deepEqual(refines, ['ref_goal→ow_offline', 'ref_product→ow_offline', 'ref_req→ow_checked'], 'each object that details the owner’s words is linked to them by refines');
  assert.equal(g.nodes.find((n) => n.id === 'ref_goal')?.group, null, 'a goal is not put into the owner’s words group by refining them');
});

test('removed objects are not on the graph or in the List, and nothing is drawn to them (CKC-09 AC-32; Spec §2.1, §6.3)', () => {
  const store = tidewater();
  assert.ok(store.nodes.has('ref_gone') && store.nodes.has('thread_gone'), 'the assets keep what was removed: it is history, not deleted data');
  const g = graphView(store, project);
  const ids = new Set(g.nodes.map((n) => n.id));
  assert.equal(ids.has('ref_gone'), false, 'a Removed requirement is not drawn');
  assert.equal(ids.has('thread_gone'), false, 'a Removed work item is not drawn');
  assert.equal(g.relations.some((r) => ['ref_gone', 'thread_gone'].includes(r.from) || ['ref_gone', 'thread_gone'].includes(r.to)), false, 'no relation is drawn to or from a removed object');
  assert.ok(ids.has('ref_req') && ids.has('thread_table'), 'current objects are drawn as before');
  // The same object comes back as soon as its validity is no longer Removed: the rule is the validity, not the object.
  store.threads.put({ ...store.threads.get('thread_gone')!, validity: 'Current' });
  deriveGraph(store, project);
  assert.ok(graphView(store, project).nodes.some((n) => n.id === 'thread_gone'));
});

test('removed objects appear struck through in Recent changes and the change details (CKC-09 AC-32; Spec §6.3)', () => {
  const store = tidewater();
  const row = changeRow(store, store.changes.get('chg_delete')!);
  const flag = (id: string) => row.affectsLabels.find((a) => a.id === id) as { removed?: boolean } | undefined;
  assert.equal(flag('ref_gone')?.removed, true, 'the removed requirement is named, flagged as removed so it is struck through');
  assert.equal(flag('thread_gone')?.removed, true);
  assert.equal(flag('ref_area')?.removed, false, 'an object that is still current is not struck through');
  assert.deepEqual((row as { removed?: { id: string; label: string }[] }).removed?.map((x) => x.label), ['R-9 · Offline v1 sync', 'T-9 · Offline v1 sync'], 'the record names what it removed');
  const recent = overview(store, project, null, null).recentChanges.find((c) => c.id === 'chg_delete') as { removed?: unknown[] } | undefined;
  assert.equal(recent?.removed?.length, 2, 'Recent changes carries the same struck-through names');
});

test('Since last visit does not list a removed work item as updated work; the change that removed it is listed (Spec §2.1, §6.2)', () => {
  const store = tidewater();
  const since = overview(store, project, '2026-09-01T00:00:00.000Z', null).sinceLastVisit;
  assert.ok(since, 'there is something new since the last visit');
  assert.equal(since.threads.some((t) => t.id === 'thread_gone'), false, 'T-9 was removed: it is not shown as work that moved on');
  assert.ok(since.threads.some((t) => t.id === 'thread_table'), 'current work that moved on is listed as before');
  assert.ok(since.changes.some((c) => c.id === 'chg_delete'), 'the change that removed it is');
});

test('the full details show the authority layer: who set a rule in the owner’s place, and when, and that it is in force (CKC-09 AC-33; Spec §1.9, §6.4)', () => {
  const store = tidewater();
  const d = nodeDetail(store, project, 'ref_cache') as Record<string, any>;
  assert.equal(d.authority?.layer, 'Decided without owner');
  assert.equal(d.authority.who, 'Lead agent');
  assert.equal(d.authority.at, '2026-09-14');
  assert.equal(d.authority.inForce, true);
  assert.match(d.authority.detail, /In force now/);
  assert.match(d.authority.detail, /not decided by the owner/i);
  assert.equal((nodeDetail(store, project, 'ref_export') as Record<string, any>).authority?.layer, 'Owner', 'the owner’s own decision');
  assert.equal((nodeDetail(store, project, 'ow_offline') as Record<string, any>).authority?.label, "The owner's own words");
  const role = (nodeDetail(store, project, 'ref_req') as Record<string, any>).authority;
  assert.equal(role?.layer, 'Role', 'a product description a role wrote within its responsibilities');
  assert.match(role.label, /Product lead/);
  // A rule that no longer applies is not said to be in force, even with its mark still open.
  store.reference.put({ ...store.reference.get('ref_cache')!, validity: 'Replaced', replacedBy: 'ref_export' });
  deriveGraph(store, project);
  const gone = (nodeDetail(store, project, 'ref_cache') as Record<string, any>).authority;
  assert.equal(gone.inForce, false);
  assert.doesNotMatch(gone.detail, /In force now/);
});

test('a decision that asks for something shows its carry-out and opens the work that carries it out (CKC-09 AC-33; Spec §2.2, §6.4)', () => {
  const store = tidewater();
  const c = (nodeDetail(store, project, 'ref_export') as Record<string, any>).carryOut;
  assert.equal(c?.status, 'Partly carried out');
  assert.equal(c.remaining, 'the settings page still links to the export');
  assert.deepEqual(c.work.map((w: { id: string; label: string; progress: string }) => [w.id, w.label, w.progress]), [['thread_export', 'T-2 · Remove the legacy export', 'Done']], 'the work is named with its progress and its id, which opens it');
  assert.deepEqual(c.evidence.map((e: { id: string }) => e.id), ['src_code']);
  assert.equal((nodeDetail(store, project, 'ref_req') as Record<string, any>).carryOut, null, 'an item with no carry-out has none');
});

test('a claim in a fact record says who claimed it and when, and what the code shows (CKC-09 AC-33; Spec §2.4, §6.4)', () => {
  const store = tidewater();
  const f = factDetail(store, 'fact_receipt') as Record<string, any>;
  const [hourly, observed, signed] = f.statements;
  assert.equal(hourly.reportedBy, 'Reported by Worker agent, batch 3 receipt, 2026-09-17');
  assert.equal(signed.reportedBy, 'Reported by Worker agent, batch 3 receipt, 2026-09-17');
  assert.equal(observed.reportedBy, null, 'an observation is nobody’s claim');
  assert.match(observed.code?.[0]?.label ?? '', /cache\.ts › refresh \(L40–L52\) @ abc1234def/, 'what was observed in the code carries its file, lines and commit');
  assert.equal(signed.untrusted?.summary, 'Sign-offs in receipts are not verified', 'a claim from a source the project marks untrusted says so');
  // The check that disagrees is recorded between the receipt and the code, so it is shown once, on the material the
  // claims rest on, in the words of the check: the receipt holds other claims the code was never found to contradict.
  assert.equal(f.checks?.length, 1, 'the record shows the check against the code');
  assert.match(f.checks[0].claim, /refreshes only when the app starts/);
  assert.equal(f.checks[0].code, true);
  assert.equal(f.checks[0].on.title, 'Batch 3 receipt');
  assert.match(f.checks[0].otherLabel, /cache\.ts › refresh \(L40–L52\) @ abc1234def/);
  assert.equal(f.statements.some((s: Record<string, unknown>) => 'contradictedBy' in s), false, 'no single claim is said to be contradicted when the check is about the whole material');
  const t = threadDetail(store, 'thread_table') as Record<string, any>;
  assert.equal(t.executionFacts[0].reportedBy, 'Reported by Worker agent, batch 3 receipt, 2026-09-17', 'the same on a work item’s execution facts');
  assert.equal(t.checks?.length, 1, 'and the check on the material they rest on');
  assert.deepEqual((threadDetail(store, 'thread_export') as Record<string, any>).checks, [], 'a work item whose facts rest on nothing checked has none');
});

test('Project scope lists every rule in the three groups with source, scope, basis and confirmation, the owner’s way of working first (CKC-21 AC-11; Spec §6.7)', async () => {
  const call = routes(tidewater());
  const scope = await call('GET', '/api/projects/:id/scope', {});
  const how = scope.howThisProjectWorks;
  assert.ok(how, 'Project scope carries How this project works');
  assert.deepEqual(how.groups.map((g: { group: string }) => g.group), ['How work is organized', 'Working rules', 'Material rules']);
  const organized = how.groups[0];
  assert.deepEqual(organized.rules.map((r: { id: string }) => r.id), ['rule_roles', 'rule_single'], 'the way of working the owner summarized comes first');
  assert.deepEqual(how.ownerSystems, ['the owner’s role cards']);
  const roles = organized.rules[0];
  assert.deepEqual(roles.sources.map((s: { id: string; label: string }) => [s.id, s.label]), [['src_agents', 'D:\\tidewater\\AGENTS.md › How we work (L1–L20)']], 'the source opens to its original');
  assert.deepEqual(roles.appliesTo, ['the whole project']);
  assert.equal(roles.differsInPractice[0].text, 'Batch 3 was reviewed by the worker who wrote it', 'where practice differs from it is on the rule');
  const single = organized.rules[1];
  assert.equal(single.basis, 'Inferred');
  assert.equal(single.confirmation.state, 'Waiting for the owner to confirm', 'an inferred rule is shown as waiting for the owner');
  const working = how.groups[1];
  const numbers = working.rules.find((r: { id: string }) => r.id === 'rule_numbers');
  assert.equal(numbers.confirmation.state, 'Confirmed by the owner');
  assert.equal(numbers.confirmation.quote, 'yes, the index decides the number');
  assert.deepEqual(working.replaced.map((r: { id: string; replacedBy: { id: string; summary: string } }) => [r.id, r.replacedBy.id, r.replacedBy.summary]), [['rule_numbers_old', 'rule_numbers', 'Every task gets the next number in the task index']], 'a replaced rule is kept apart and points to the one that replaced it');
  assert.equal(working.rules.some((r: { id: string }) => r.id === 'rule_numbers_old'), false);
  const push = working.rules.find((r: { id: string }) => r.id === 'rule_push');
  assert.deepEqual(push.marks.map((m: { kind: string; who: string; at: string; inForce: boolean }) => [m.kind, m.who, m.at, m.inForce]), [['Decided without owner', 'Lead agent', '2026-09-15', true]], 'a rule set in the owner’s place says who set it, when, and that it is in force');
  assert.equal(how.groups[2].rules.find((r: { id: string }) => r.id === 'rule_vendor').category, 'Reference only');
});

test('Project scope shows the framing round’s plan and focus with the owner’s corrections (CKC-21 AC-11; Spec §3.7, §6.7)', async () => {
  const call = routes(tidewater());
  const plan = (await call('GET', '/api/projects/:id/scope', {})).organizingPlan;
  assert.ok(plan, 'Project scope carries the organizing plan and focus');
  assert.deepEqual(plan.byRule.map((e: { what: string; rule: { id: string; summary: string }; treatment: string }) => [e.what, e.rule.id, e.rule.summary, e.treatment]), [['the vendored chart library', 'rule_vendor', 'The vendored chart library’s documents are for reference only', 'Reference only']]);
  assert.equal(plan.readClosely[0].what, 'the receipts');
  assert.equal(plan.focus[0].sources[0].id, 'src_talk');
  assert.deepEqual(plan.order, ['task index first', 'receipts next']);
  assert.equal(plan.corrections[0].quote, 'Read the receipts closely, not the vendored charts.', 'the owner’s correction is kept in their words');
  assert.equal(plan.corrections[0].source.id, 'src_fix');
  assert.deepEqual(plan.corrections[0].previous.order, ['task index first'], 'with what the plan said before it');
});

test('nothing on the graph comes from a rule: no node, relation or mark (CKC-21 AC-12; R-50)', () => {
  const store = tidewater();
  // Things that name a rule: a change record whose item changed one, a note about one, and the marks above.
  store.changes.put({ ...store.changes.get('chg_delete')!, id: 'chg_rule', title: 'Numbering changed', affects: ['rule_numbers', 'rule_numbers_old'], items: [] });
  store.notes.put({ id: 'note_rule', projectId: 'p1', mount: { kind: 'node', ids: ['rule_single'] }, status: 'Current', ownerResponse: null, versions: [{ version: 1, at: AT, title: 'Is it one agent?', preview: 'Confirm the inferred rule', body: { currentView: null, whyItMatters: null, facts: [], otherExplanations: null, keepAdjust: null, whatWouldSettleIt: null }, ask: 'For your decision', judgementRecordId: 'j', reason: 'first' }], discussion: [], followUps: [], author: { agent: 'pi', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, language: 'en', updatedAt: AT } as Note);
  deriveGraph(store, project);
  const g = graphView(store, project);
  const rules = new Set(store.rules.all().map((r) => r.id));
  assert.equal(g.nodes.filter((n) => rules.has(n.id) || rules.has(n.refId)).length, 0, 'no node stands for a rule');
  assert.equal(g.relations.filter((r) => rules.has(r.from) || rules.has(r.to)).length, 0, 'no relation ends at a rule');
  assert.deepEqual(g.marks.filter((m) => rules.has(m.targetId)).map((m) => m.id), [], 'a mark on a rule is shown with the rule in Project scope, not with the graph');
  assert.ok(g.marks.some((m) => m.id === 'mark_cache'), 'a mark on a drawn object is still with the graph');
});

test('search does not offer a removed object as a node on the graph (Spec §6.12, §2.1)', async () => {
  const call = routes(tidewater());
  const r = await call('GET', '/api/projects/:id/search', {}, 'q=offline v1');
  const nodes = r.results.filter((x: { type: string }) => x.type === 'node').map((x: { id: string }) => x.id);
  assert.deepEqual(nodes.filter((id: string) => id === 'ref_gone' || id === 'thread_gone'), [], 'R-9 and T-9 were removed, so neither is found as a node to show on the graph');
  assert.ok(r.results.some((x: { type: string; id: string }) => x.type === 'change' && x.id === 'chg_delete'), 'the change that removed them is still found, and opens in the Change log');
  const found = await call('GET', '/api/projects/:id/search', {}, 'q=Table view');
  assert.deepEqual(found.results.filter((x: { type: string }) => x.type === 'node').map((x: { id: string }) => x.id), ['thread_table'], 'current objects are found as before');
});

test('the round that recorded the rules and the plan opens them from Keeper activity (Spec §6.9, §3.7)', async () => {
  const call = routes(tidewater());
  const a = await call('GET', '/api/projects/:id/activity', {});
  const frame = a.jobs.find((j: { id: string }) => j.id === 'job_frame');
  assert.deepEqual(frame.opens, { rules: 2, plan: true }, 'the framing round opens the rules it recorded and the plan and focus');
  assert.deepEqual(a.jobs.find((j: { id: string }) => j.id === 'job_other').opens, { rules: 0, plan: false });
});

/** A scope item as discovery writes it, for the list view tests. */
const scopeItem = (path: string, relation: string, over: Record<string, unknown> = {}) => ({
  id: `scope_${path.length}`, path, category: 'Directory', relation, reason: `${relation}: ${path}`,
  reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'keeper', ...over,
}) as never;

test('Project scope lists third-party material and generated output apart, each with who classified it (CKC-04 AC-13, AC-17; Spec §6.7)', () => {
  const thirdParty = scopeItem('D:\\tidewater\\vendor', 'Third-party material', {
    classification: { by: 'keeper', basis: 'Inferred', kind: 'vendored code', evidence: ['vendor/ is a usual name for vendored third-party code'], sourceIds: [], ruleId: null, jobId: 'job_frame', at: AT },
  });
  const generated = scopeItem('D:\\tidewater\\dist', 'Generated', {
    classification: { by: 'owner', basis: 'Explicit', kind: 'build output', evidence: ['the owner said so'], sourceIds: [], ruleId: null, jobId: null, at: AT },
  });
  const candidate = scopeItem('D:\\tidewater\\coverage', 'Generated', {
    classification: { by: 'program', basis: 'Inferred', kind: 'test coverage output', evidence: ['coverage/ is a usual name for test coverage output'], sourceIds: [], ruleId: null, jobId: null, at: null },
  });
  const p = { ...project, scope: [scopeItem('D:\\tidewater', 'Main project'), thirdParty, generated, candidate] } as Project;
  const v = scopeListView(p);
  assert.deepEqual(v.inScope.map((x) => x.item.path), ['D:\\tidewater'], 'the project itself stays In scope');
  assert.deepEqual(v.thirdParty.map((x) => x.item.path), ['D:\\tidewater\\vendor'], 'third-party material is listed apart, not under In scope');
  assert.deepEqual(v.generated.map((x) => x.item.path), ['D:\\tidewater\\dist', 'D:\\tidewater\\coverage'], 'generated output is listed apart');
  const tp = v.thirdParty[0]!.classification!;
  assert.equal(tp.by, 'keeper');
  assert.equal(tp.basis, 'Inferred');
  assert.match(tp.sentence, /Classified by the Keeper/, 'who classified it is written out');
  assert.match(tp.sentence, /Inferred/, 'the Keeper’s classification is marked as an inference');
  assert.match(tp.sentence, /vendored code/, 'the kind is given');
  assert.match(v.generated[0]!.classification!.sentence, /Classified by the owner/, 'the owner’s correction says whose it is');
  assert.match(v.generated[1]!.classification!.sentence, /offered by the program.*not yet judged/i, 'a program candidate says the Keeper has not judged it');
});

test('an ignored location names the rule that leaves it out, and one holding documents is listed apart for the owner (CKC-04 AC-17; Spec §6.7)', () => {
  const plain = scopeItem('D:\\tidewater\\scratch', 'Excluded', {
    ignoredBy: { file: '.gitignore', line: 3, pattern: 'scratch/', files: 12, documents: 0, documentNames: [] },
  });
  const withDocs = scopeItem('D:\\tidewater\\drafts', 'Excluded', {
    ignoredBy: { file: '.gitignore', line: 4, pattern: 'drafts/', files: 4, documents: 1, documentNames: ['drafts/ideas.md'] },
  });
  const p = { ...project, scope: [scopeItem('D:\\tidewater', 'Main project'), plain, withDocs] } as Project;
  const v = scopeListView(p);
  assert.deepEqual(v.ignoredDocuments.map((x) => x.item.path), ['D:\\tidewater\\drafts'], 'an ignored directory holding documents is listed apart from the merely excluded');
  assert.deepEqual(v.excluded.map((x) => x.item.path), ['D:\\tidewater\\scratch']);
  const ig = v.ignoredDocuments[0]!.ignored!;
  assert.equal(ig.rule, '.gitignore line 4: drafts/', 'which ignore file, line and pattern');
  assert.equal(ig.documents, 1);
  assert.deepEqual(ig.documentNames, ['drafts/ideas.md']);
  assert.match(ig.sentence, /1 of them a document/, 'the count of documents');
  assert.match(ig.sentence, /owner decides whether to include/, 'the decision stays with the owner');
  assert.match(v.excluded[0]!.ignored!.sentence, /12 files/);
  assert.doesNotMatch(v.excluded[0]!.ignored!.sentence, /owner decides/, 'no documents: nothing for the owner to decide');
});

test('a worktree says whether it merged into the trunk, how much was skipped and what was taken (CKC-04 AC-15; Spec §6.7)', () => {
  const merged = scopeItem('D:\\tidewater-wt', 'Worktree of main repo', {
    category: 'Worktree',
    worktree: { trunk: { ref: 'main', commit: 'abc' }, branch: 'wt-a', head: 'def', merged: true, uniqueCommits: 0, files: 15, sameAsTrunk: 14, olderVersions: 0, taken: [{ path: 'src/a.ts', kind: 'Uncommitted change' }], error: null },
  });
  const unmerged = scopeItem('D:\\tidewater-wt2', 'Worktree of main repo', {
    category: 'Worktree',
    worktree: { trunk: { ref: 'main', commit: 'abc' }, branch: 'wt-b', head: 'fed', merged: false, uniqueCommits: 2, files: 16, sameAsTrunk: 14, olderVersions: 1, taken: [{ path: 'src/b.ts', kind: 'Changed on branch' }, { path: 'src/c.ts', kind: 'Uncommitted change', deleted: true }], error: null },
  });
  const p = { ...project, scope: [merged, unmerged] } as Project;
  const v = scopeListView(p);
  assert.equal(v.inScope.length, 2, 'worktrees stay In scope');
  const m = v.inScope[0]!.worktree!;
  assert.equal(m.merged, true);
  assert.match(m.sentence, /^Merged into main/, 'merged into the trunk first');
  assert.match(m.sentence, /14 the same as main, skipped/, 'how many were skipped as identical');
  assert.match(m.sentence, /took 1: src\/a\.ts/, 'what was taken');
  const u = v.inScope[1]!.worktree!;
  assert.equal(u.merged, false);
  assert.match(u.sentence, /Not merged into main: 2 commits main does not have/, 'not merged says what the trunk lacks');
  assert.match(u.sentence, /1 older version .* left to the version history/, 'older versions are left to the version history');
  assert.match(u.sentence, /src\/c\.ts \(uncommitted change, removed\)/, 'a removed file is named as such');
});

test('the reason of a worktree item does not repeat what its own line says: the measured sentence the discovery put in the reason is left out of the view (V15; Spec §6.7)', () => {
  // The discovery (src/scope/discover.ts) ends a worktree's reason with " · " and worktreeSentence(); the view has its own
  // structured line for the same facts, so the reason shown keeps only what comes before.
  const wt = { trunk: { ref: 'main', commit: 'abc' }, branch: 'wt-a', head: 'def', merged: true, uniqueCommits: 0, files: 34, sameAsTrunk: 33, olderVersions: 0, taken: [{ path: 'src/a.ts', kind: 'Uncommitted change' }], error: null };
  const measured = scopeItem('D:\\tidewater-wt', 'Worktree of main repo', {
    category: 'Worktree', worktree: wt,
    reason: 'Registered worktree of D:\\tidewater, branch wt-a · merged into main · 34 files: 33 the same as main, skipped · took 1: src/a.ts (uncommitted change)',
  });
  const v = scopeListView({ ...project, scope: [measured] } as Project);
  assert.equal(v.inScope[0]!.reason, 'Registered worktree of D:\\tidewater, branch wt-a');
  assert.match(v.inScope[0]!.worktree!.sentence, /^Merged into main · 34 files: 33 the same as main, skipped · took 1/);
  // A reason that does not end in the measured sentence (an older store, an owner-written one) is shown whole.
  const plain = scopeItem('D:\\tidewater-wt2', 'Worktree of main repo', { category: 'Worktree', worktree: wt, reason: 'Added by the owner' });
  assert.equal(scopeListView({ ...project, scope: [plain] } as Project).inScope[0]!.reason, 'Added by the owner');
  const noWorktree = scopeItem('D:\\tidewater\\docs', 'Main project');
  assert.equal(scopeListView({ ...project, scope: [noWorktree] } as Project).inScope[0]!.reason, 'Main project: D:\\tidewater\\docs');
});

test('a location a material rule covers carries the rule with its words, so the listing can reach it (CKC-04 AC-1; Spec §1.15, §6.7)', () => {
  const covered = scopeItem('D:\\tidewater\\archive', 'Main project', {
    coveredBy: [{ ruleId: 'rule_vendor', category: 'Obsolete', summary: 'archive/ is not current material', excerpt: 'Nothing in archive/ is current.', sourceIds: ['src_agents'], basis: 'Explicit', target: 'archive/' }],
  });
  const v = scopeListView({ ...project, scope: [covered] } as Project);
  const covers = v.inScope[0]!.covers;
  assert.equal(covers.length, 1);
  assert.deepEqual([covers[0]!.ruleId, covers[0]!.category, covers[0]!.excerpt], ['rule_vendor', 'Obsolete', 'Nothing in archive/ is current.'], 'the covering rule, its category and its words');
});

test('the toolchain lists the locations the project config points at, a too-broad one flagged with its reason (CKC-03 AC-23; Spec §6.7)', () => {
  const p = {
    ...project,
    toolchain: [
      { path: 'D:\\tidewater-sdk', reason: 'local.properties declares sdk.dir → D:\\tidewater-sdk', configPath: 'D:\\tidewater\\local.properties', used: true, notUsedReason: null },
      { path: 'D:\\', reason: 'local.properties declares toolchain.home → D:\\', configPath: 'D:\\tidewater\\local.properties', used: false, notUsedReason: 'not used: too broad (a filesystem root)' },
    ],
  } as Project;
  const t = toolchainView(p)!;
  assert.equal(t.entries.length, 2);
  assert.equal(t.entries[0]!.used, true);
  assert.match(t.entries[0]!.reason, /local\.properties declares sdk\.dir/, 'each entry carries the config item it came from');
  assert.equal(t.entries[1]!.used, false);
  assert.match(t.entries[1]!.notUsedReason!, /too broad/, 'a location too broad to use is listed with why');
  assert.match(t.note, /Keeper may read them to make sense of the build environment/, 'the section says what the Keeper uses them for');
  assert.match(t.note, /Ask Keeper/, 'and how the owner corrects a wrong one');
  assert.equal(toolchainView(project), null, 'a project without the field has no section');
});

test('the coverage counts the materials a rule settles directly, and says which rule or plan settled them (Spec §1.11, §3.7)', () => {
  const store = tidewater();
  // A vendored document the Reference-only rule settles: read for reference, never organized closely.
  store.sources.put({
    id: 'src_vendor_doc', projectId: 'p1', title: 'chart-lib guide', anchor: { kind: 'file', path: 'D:\\tidewater\\vendor\\chart-lib\\guide.md', headingPath: ['Guide'], lineStart: 1, lineEnd: 9 },
    ids: [], version: { fingerprint: 'sha256:2', readAt: AT, commit: null }, excerpt: 'Axes, series and theming.',
    usedAs: 'Reference only', usedAsBy: null, usedAsByRuleId: 'rule_vendor', availability: null, movedTo: null, scopeItemId: 'scope_main', hasCredential: false, bytes: 26,
  } as never);
  const v = settledByRuleView(store, project)!;
  assert.ok(v.materials >= 1, 'at least the vendored document is settled by a rule');
  const entry = v.byRule.find((r) => r.ruleId === 'rule_vendor')!;
  assert.ok(entry, 'the Reference-only rule is named');
  assert.match(entry.summary, /vendored chart library/);
  assert.ok(entry.count >= 1);
  assert.ok(entry.names.some((n) => n.includes('guide.md')), 'a sample of what it settles is named');
});

test('every source carries its organizing level for the sources list filter, and the level names come from the vocabulary (Spec §6.7, §1.11)', async () => {
  const store = tidewater();
  store.sources.put({
    id: 'src_vendor_doc', projectId: 'p1', title: 'chart-lib guide', anchor: { kind: 'file', path: 'D:\\tidewater\\vendor\\chart-lib\\guide.md', headingPath: ['Guide'], lineStart: 1, lineEnd: 9 },
    ids: [], version: { fingerprint: 'sha256:2', readAt: AT, commit: null }, excerpt: 'Axes, series and theming.',
    usedAs: 'Reference only', usedAsBy: null, usedAsByRuleId: 'rule_vendor', availability: null, movedTo: null, scopeItemId: 'scope_main', hasCredential: false, bytes: 26,
  } as never);
  const call = routes(store);
  const rows = await call('GET', '/api/projects/:id/sources', {});
  const settled = rows.find((s: { id: string }) => s.id === 'src_vendor_doc');
  assert.equal(settled.level, 'Settled by rule', 'a source the rule settles directly carries that level');
  assert.ok(rows.some((s: { level: string | null }) => s.level === 'Read in full' || s.level === null), 'other sources carry their own level or none');
  const only = await call('GET', '/api/projects/:id/sources', {}, 'level=Settled%20by%20rule');
  assert.ok(only.length >= 1 && only.every((s: { level: string }) => s.level === 'Settled by rule'), 'the list filters by organizing level');
  const scope = await call('GET', '/api/projects/:id/scope', {});
  assert.ok(Array.isArray(scope.scopeVocab.organizingLevels) && scope.scopeVocab.organizingLevels.includes('Settled by rule'), 'the filter’s options come from the vocabulary, not the interface');
});

test('Project scope carries the list sections, the fixed vocabularies and the toolchain (Spec §6.7; CKC-04 AC-13)', async () => {
  const store = tidewater();
  const p = {
    ...project,
    scope: [scopeItem('D:\\tidewater', 'Main project'), scopeItem('D:\\tidewater\\vendor', 'Third-party material')],
    toolchain: [{ path: 'D:\\tidewater-sdk', reason: 'local.properties declares sdk.dir → D:\\tidewater-sdk', configPath: 'D:\\tidewater\\local.properties', used: true, notUsedReason: null }],
  } as Project;
  const handlers = new Map<string, (ctx: unknown) => unknown>();
  const http = { route: (method: string, path: string, handler: (ctx: unknown) => unknown) => handlers.set(`${method} ${path}`, handler), static: () => undefined };
  const app = { project: () => p, store: () => store, workspace: { list: () => [p] }, keeper: { status: async () => ({ status: 'Idle', reason: '', detail: '' }), providerState: async () => ({ model: null, connected: false }) } };
  registerRoutes(http as never, app as never, '', '');
  const scope = (await handlers.get('GET /api/projects/:id/scope')!({ params: { id: 'p1' }, query: new URLSearchParams(''), body: null })) as Record<string, any>;
  assert.ok(scope.scopeView.thirdParty.length === 1 && scope.scopeView.inScope.length === 1, 'the route carries the sectioned list');
  assert.ok(scope.scopeVocab.relations.includes('Third-party material') && scope.scopeVocab.relations.includes('Generated'), 'the Add item choices come from the vocabulary');
  assert.equal(scope.toolchain.entries.length, 1, 'the toolchain is listed');
});

test('a job row carries how many reads the boundary denied, with the tree’s total on the main job (CKC-03 AC-23; Spec §6.9)', async () => {
  const store = tidewater();
  store.jobs.put({
    ...store.jobs.get('job_frame')!, id: 'job_denied', kind: 'Investigation', boundaryDenials: 2,
    steps: [{ at: AT, tool: 'pk_read_source', target: 'D:\\elsewhere\\secret.txt', summary: 'outside the read boundary', isError: true }],
  } as never);
  store.jobs.put({ ...store.jobs.get('job_frame')!, id: 'job_child', parentJobId: 'job_denied', boundaryDenials: 1 } as never);
  const call = routes(store);
  const a = await call('GET', '/api/projects/:id/activity', {});
  const denied = a.jobs.find((j: { id: string }) => j.id === 'job_denied');
  assert.equal(denied.boundaryDenials, 2, 'the job’s own denials');
  assert.equal(denied.boundaryDenialsWithDelegated, 3, 'the main job’s total counts what it delegated');
  const child = a.jobs.find((j: { id: string }) => j.id === 'job_child');
  assert.equal(child.boundaryDenials, 1);
  assert.equal(child.boundaryDenialsWithDelegated, 1, 'each job’s own count is its own');
});

test('asking the Keeper about a rule starts from what the assets say about that rule (CKC-21 AC-11; Spec §6.7, §6.8)', () => {
  const store = tidewater();
  const conversation = new ConversationService({ store: () => store, project: () => project } as never);
  const existing = conversation.existing('p1', { kind: 'rule', id: 'rule_single', label: 'One agent works through each task' });
  assert.ok(existing, 'the conversation shows the rule it was opened on');
  assert.match(existing.text, /One agent works through each task and asks for no independent QC/);
  assert.match(existing.text, /Inferred · Waiting for the owner to confirm/);
  assert.deepEqual(existing.sourceIds, ['src_receipt']);
  const plan = conversation.existing('p1', { kind: 'plan', id: 'organizing-plan', label: 'Organizing plan and focus' });
  assert.match(plan?.text ?? '', /Read closely: the receipts/);
});
