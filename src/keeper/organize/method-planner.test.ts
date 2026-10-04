/**
 * What the program does for the organizing method, deterministically (batch C2; Spec §1.1, §1.2, §1.11, §1.15, §2.1,
 * §3.7; CKC-13 AC-25, AC-29, AC-30):
 *
 * - material the project’s rules settle directly, by the organizing plan or by a rule applied to its sources, is
 *   `Settled by rule`: not read closely, and not counted in the depth question’s close reading;
 * - the first round’s slice holds the places a project writes its rules down, marked as such;
 * - material that is only history, only for reference or settled by rule leaves no `Update pending` behind;
 * - a source that is only history, or gone, is no current node of the graph;
 * - a re-look put off while a round ran is kept in the assets, on the request’s own job, and opens once the round ends.
 *
 * The fixtures are an invented project, "Orchard", a planner for community orchard work days.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../../store/project-store.ts';
import * as materials from './materials.ts';
import * as takeover from './takeover.ts';
import { deriveGraph } from './graph.ts';
import type { FactRecord, GraphRelation, KeeperJob, OrganizingPlan, Project, ProjectRule, ScopeItem, Source, WorkThread } from '../../model/types.ts';

const AT = '2026-09-18T00:00:00.000Z';
const ROOT = 'D:\\orchard';
const M = materials as unknown as Record<string, (...a: unknown[]) => unknown>;
const T = takeover as unknown as Record<string, (...a: unknown[]) => unknown>;

const store = () => ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-method-planner-')));
const project = (scope: readonly Partial<ScopeItem>[] = [{ id: 'scope_main', path: ROOT, relation: 'Main project', category: 'Repository' }]) =>
  ({ id: 'p1', name: 'Orchard', locations: [ROOT], createdAt: AT, scope, roles: [], language: 'en' }) as unknown as Project;
const src = (s: ProjectStore, id: string, rel: string, extra: Partial<Source> = {}) =>
  s.sources.put({ id, projectId: 'p1', title: rel, anchor: { kind: 'file', path: `${ROOT}\\${rel.replace(/\//g, '\\')}`, headingPath: [], lineStart: 1, lineEnd: 9 }, ids: [], version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt: `text of ${rel}`, usedAs: null, usedAsBy: null, availability: null, movedTo: null, scopeItemId: 'scope_main', hasCredential: false, bytes: 10, ...extra } as Source);
const rule = (s: ProjectStore, id: string, over: Partial<ProjectRule> = {}) =>
  s.rules.put({ id, projectId: 'p1', group: 'Material rules', category: 'Recovery only', summary: 'attic/ keeps old files for recovery only.', excerpt: 'attic/ keeps old files for recovery only', sourceIds: ['src_readme'], appliesTo: ['attic/'], basis: 'Explicit', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: 'job_frame', asOf: AT, updatedAt: AT, ...over } as ProjectRule);
const plan = (s: ProjectStore, byRule: OrganizingPlan['byRule']) =>
  s.plans.put({ id: 'organizing-plan', projectId: 'p1', byRule, readClosely: [], focus: [], order: [], corrections: [], jobId: 'job_frame', asOf: AT, updatedAt: AT } as OrganizingPlan);

test('material the plan settles by a rule, or whose sources a rule settled, is settled by rule — the rule’s own text never is', () => {
  const s = store();
  src(s, 'src_readme', 'README.md');
  src(s, 'src_old', 'attic/plan-2025.md');
  src(s, 'src_vendor', 'vendor/lib/README.md', { usedAs: 'Reference only', usedAsBy: 'keeper', usedAsByRuleId: 'rule_vendor' });
  src(s, 'src_mixed_a', 'docs/notes.md', { usedAs: 'Reference only', usedAsBy: 'keeper', usedAsByRuleId: 'rule_vendor' });
  rule(s, 'rule_attic');
  rule(s, 'rule_vendor', { category: 'Reference only', appliesTo: ['vendor/'], sourceIds: ['src_readme'] });
  rule(s, 'rule_note', { category: 'Recovery only', appliesTo: ['attic/'], sourceIds: ['src_old'], excerpt: 'this file explains attic', summary: 'The attic note says what attic holds.' });
  plan(s, [{ what: 'old files', targets: ['attic/'], ruleId: 'rule_attic', treatment: 'History only' }]);
  const settlement = M.ruleSettlement;
  assert.equal(typeof settlement, 'function', 'the planner knows what the rules settle');
  const of = (rel: string, sourceIds: string[]) => settlement!(s, s.plans.get('organizing-plan'), { kind: 'file', rel, sourceIds }) as { ruleId: string; via: string } | null;
  // attic/plan-2025.md is the source of rule_note — the rule's own text is read again whenever it changes.
  assert.equal(of('attic/plan-2025.md', ['src_old']), null, 'a material that states one of the rules is never settled away');
  s.rules.put({ ...s.rules.get('rule_note')!, sourceIds: ['src_readme'] });
  assert.deepEqual(of('attic/plan-2025.md', ['src_old']), { ruleId: 'rule_attic', via: 'plan' });
  assert.deepEqual(of('vendor/lib/README.md', ['src_vendor']), { ruleId: 'rule_vendor', via: 'sources' });
  assert.equal(of('docs/PLAN.md', ['src_readme']), null, 'material no rule settles is read as the depth plans');
  // A rule no longer in force settles nothing.
  s.rules.put({ ...s.rules.get('rule_attic')!, validity: 'Replaced', replacedBy: 'rule_vendor' });
  assert.equal(of('attic/plan-2025.md', ['src_old']), null);
});

test('material a rule took out of what is organized is counted as settled by rule, not as waiting', () => {
  const s = store();
  const scope: Partial<ScopeItem>[] = [
    { id: 'scope_main', path: ROOT, relation: 'Main project', category: 'Repository', addedBy: 'keeper' },
    { id: 'scope_attic', path: `${ROOT}\\attic`, relation: 'Excluded', category: 'Directory', addedBy: 'keeper', coveredBy: [{ ruleId: 'rule_attic', category: 'Recovery only', summary: 'attic', excerpt: 'attic', sourceIds: ['src_readme'], basis: 'Explicit', target: 'attic/' }] },
  ];
  src(s, 'src_readme', 'README.md');
  src(s, 'src_old', 'attic/plan-2025.md', { scopeItemId: 'scope_attic' });
  src(s, 'src_guide', 'guides/style.md', { usedAs: 'Reference only', usedAsBy: null, usedAsByRuleId: 'rule_guides' });
  src(s, 'src_mine', 'notes/mine.md', { usedAs: 'Reference only', usedAsBy: 'owner' });
  rule(s, 'rule_attic');
  rule(s, 'rule_guides', { category: 'Reference only', appliesTo: ['guides/'] });
  const away = M.settledAwayMaterials;
  assert.equal(typeof away, 'function');
  const listed = new Set(materials.listMaterials(s, project(scope)).map((m) => m.key));
  const found = (away!(s, project(scope), listed) as { rel: string; ruleId: string }[]).map((m) => `${m.rel.replace(/\\/g, '/')} ${m.ruleId}`).sort();
  assert.deepEqual(found, ['attic/plan-2025.md rule_attic', 'guides/style.md rule_guides'], 'what a rule settles, by the rule; the owner’s own call is not a rule');
  s.rules.put({ ...s.rules.get('rule_guides')!, validity: 'Replaced', replacedBy: 'rule_attic' });
  assert.deepEqual((away!(s, project(scope), listed) as { rel: string }[]).map((m) => m.rel.replace(/\\/g, '/')), ['attic/plan-2025.md'], 'a rule no longer in force settles nothing');
});

test('the first round’s slice holds where the project writes its rules down, marked as such', () => {
  const rulesSource = T.isRulesSource;
  assert.equal(typeof rulesSource, 'function');
  for (const rel of ['AGENTS.md', 'CLAUDE.md', 'README.md', 'docs/README.md', 'docs/TASK-INDEX.md', 'docs/HANDOVER.md', 'archive/README.md', 'deleted/NOTES.md', '交接/说明.md']) assert.equal(rulesSource!(rel), true, `${rel} is where rules are written`);
  for (const rel of ['docs/PLAN.md', 'src/index.ts', 'archive/old-plan.md', 'node_modules/x/README.md', 'deep/a/b/c/README.md']) assert.equal(rulesSource!(rel), false, `${rel} is not`);
  const candidates = ['AGENTS.md', 'README.md', 'archive/README.md', 'docs/PLAN.md', 'archive/old-plan.md'].map((rel) => ({ key: `file:${rel}`, kind: 'file' as const, ref: rel, rel, group: 'g', recency: AT, chars: 10, intent: /AGENTS|README|PLAN/.test(rel) }));
  const chosen = takeover.selectFirstUsable(candidates);
  assert.ok(chosen.has('file:archive/README.md'), 'the note that says what the archive holds is read in the first round');
  assert.ok(!chosen.has('file:archive/old-plan.md'), 'what the archive holds is not');
  assert.equal(chosen.get('file:AGENTS.md') !== null && chosen.has('file:AGENTS.md'), true);
});

test('material is what the scope reads: nothing from a place left out or kept for recovery, only the documents of third-party material', () => {
  const s = store();
  const scope: Partial<ScopeItem>[] = [
    { id: 'scope_main', path: ROOT, relation: 'Main project', category: 'Repository', addedBy: 'keeper' },
    { id: 'scope_gen', path: `${ROOT}\\exports`, relation: 'Generated', category: 'Directory', addedBy: 'keeper' },
    { id: 'scope_lib', path: `${ROOT}\\libs\\chart`, relation: 'Third-party material', category: 'Directory', addedBy: 'keeper', classification: { by: 'keeper', basis: 'Inferred', kind: 'vendored code', evidence: [], sourceIds: [], ruleId: null, jobId: null, at: AT } },
  ];
  src(s, 'src_plan', 'docs/PLAN.md');
  src(s, 'src_export', 'exports/report.md');
  src(s, 'src_lib_doc', 'libs/chart/GUIDE.md');
  src(s, 'src_lib_code', 'libs/chart/index.ts');
  const keys = materials.listMaterials(s, project(scope)).map((m) => m.rel.replace(/\\/g, '/')).sort();
  assert.deepEqual(keys, ['docs/PLAN.md', 'libs/chart/GUIDE.md'].sort(), `generated output and third-party code are not material (${keys.join(', ')})`);
});

test('material that is only history, only for reference or settled by rule leaves no Update pending behind', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-method-pending-'));
  const { App } = await import('../../server/app.ts');
  const app = new App(home, { organizing: false });
  const proj = app.addProject('Orchard', [mkdtempSync(join(tmpdir(), 'pk-orchard-'))]);
  const s = app.store(proj.id);
  const root = app.project(proj.id).locations[0]!;
  const at = (rel: string) => `${root}\\${rel.replace(/\//g, '\\')}`;
  const put = (id: string, rel: string, extra: Partial<Source> = {}) => s.sources.put({ id, projectId: proj.id, title: rel, anchor: { kind: 'file', path: at(rel), headingPath: [], lineStart: 1, lineEnd: 9 }, ids: [], version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt: 'x', usedAs: null, usedAsBy: null, availability: null, movedTo: null, scopeItemId: app.project(proj.id).scope[0]?.id ?? 'scope', hasCredential: false, bytes: 1, ...extra } as Source);
  put('src_plan', 'docs/PLAN.md');
  put('src_ref', 'guides/style.md', { usedAs: 'Reference only', usedAsBy: 'keeper' });
  put('src_hist', 'old/plan.md', { usedAs: 'History only', usedAsBy: 'keeper' });
  put('src_attic', 'attic/x.md');
  put('src_readme', 'README.md');
  s.rules.put({ id: 'rule_attic', projectId: proj.id, group: 'Material rules', category: 'Recovery only', summary: 'attic/', excerpt: 'attic', sourceIds: ['src_readme'], appliesTo: ['attic/'], basis: 'Explicit', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: null, asOf: AT, updatedAt: AT } as ProjectRule);
  s.plans.put({ id: 'organizing-plan', projectId: proj.id, byRule: [{ what: 'attic', targets: ['attic/'], ruleId: 'rule_attic', treatment: 'History only' }], readClosely: [], focus: [], order: [], corrections: [], jobId: null, asOf: AT, updatedAt: AT } as OrganizingPlan);
  for (const id of ['src_plan', 'src_ref', 'src_hist', 'src_attic']) {
    s.facts.put({ id: `fact_${id}`, projectId: proj.id, title: id, aboutSourceIds: [id], statements: [], decisions: [], changes: [], openQuestions: [], executionFacts: [], language: 'en', inputs: {} as never, asOf: AT, updatedAt: AT, pendingSourceIds: [] } as FactRecord);
  }
  const changes = ['docs/PLAN.md', 'guides/style.md', 'old/plan.md', 'attic/x.md'].map((rel) => ({ kind: 'file' as const, ref: at(rel), label: rel, since: AT, lastEventAt: Date.now(), scopeItemId: 'scope' }));
  app.organizing.markPending(proj.id, changes);
  const pending = (id: string) => s.facts.get(`fact_${id}`)!.pendingSourceIds.length > 0;
  assert.equal(pending('src_plan'), true, 'material that will be organized again waits for it');
  assert.equal(pending('src_ref'), false, 'reference-only material is never organized, so nothing waits for it');
  assert.equal(pending('src_hist'), false, 'nor is history');
  assert.equal(pending('src_attic'), false, 'nor what the rules settle');
  app.stopAll();
});

test('a source that is only history forms no node; a source no longer available is not drawn as current', () => {
  const s = store();
  src(s, 'src_code', 'src/booking.ts', { usedAs: 'Code' });
  src(s, 'src_old', 'attic/plan.md', { usedAs: 'History only' });
  src(s, 'src_gone', 'src/removed.ts', { usedAs: 'Code', availability: 'No longer available' });
  s.threads.put({ id: 'thread_w', projectId: 'p1', title: 'W-1', ids: [], doing: '', changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, inputs: {} as never, asOf: AT, updatedAt: AT, pendingSourceIds: [] } as WorkThread);
  const rel = (id: string, from: string): GraphRelation => ({ id, projectId: 'p1', type: 'implements', from, to: 'thread_w', claim: 'c', basis: 'Explicit', evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: AT });
  s.relations.put(rel('rel_code', 'src_code'));
  s.relations.put(rel('rel_old', 'src_old'));
  s.relations.put(rel('rel_gone', 'src_gone'));
  deriveGraph(s, project());
  assert.equal(s.nodes.get('src_code')?.validity, 'Current');
  assert.equal(s.nodes.get('src_old'), undefined, 'history forms no node (Spec §1.2, D61)');
  assert.equal(s.nodes.get('src_gone')?.validity, 'Removed', 'what was deleted is not shown as current');
});

test('a re-look put off while a round ran is kept in the assets, on the request’s own job', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-method-relook-'));
  const { App } = await import('../../server/app.ts');
  const app = new App(home, { organizing: false });
  const proj = app.addProject('Orchard', [mkdtempSync(join(tmpdir(), 'pk-orchard-'))]);
  const s = app.store(proj.id);
  const job = (id: string, over: Partial<KeeperJob>): KeeperJob => ({ id, projectId: proj.id, kind: 'Organizing', initiator: 'auto', scope: { kind: 'takeover', ids: [], label: id }, status: 'Running', queuedAt: AT, startedAt: AT, endedAt: null, savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: null, resultText: null, priority: 1, task: { extra: { kind: 'takeover', round: 'deepen' } }, ...over } as KeeperJob);
  s.jobs.put(job('job_round', {}));
  const request = s.jobs.put(job('job_request', { kind: 'Your request', initiator: 'owner', status: 'Done', scope: { kind: 'conversation', ids: [], label: 'fix the plan' }, task: { extra: { conversationId: 'c' } } }));
  (app.organizing as unknown as { relookAfterRequest(st: ProjectStore, j: KeeperJob): void }).relookAfterRequest(s, request);
  const kept = (s.jobs.get('job_request')!.task as { extra?: { deferredRelooks?: unknown[] } }).extra?.deferredRelooks ?? [];
  assert.equal(kept.length, 1, 'the re-look waits in the assets, not in memory');
  app.stopAll();
});

test('a re-look put off while a round of the clerk method ran opens once the round has ended, and only once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-method-relook-clerk-'));
  const { App } = await import('../../server/app.ts');
  const app = new App(home, { organizing: false });
  const proj = app.addProject('Orchard', [mkdtempSync(join(tmpdir(), 'pk-orchard-'))]);
  const s = app.store(proj.id);
  // The runtime is not started here: what the service queues is written as the runtime would, and counted.
  const queued: string[] = [];
  (app.keeper as unknown as { enqueue(p: string, r: { scope: KeeperJob['scope']; task?: unknown; kind: KeeperJob['kind'] }): KeeperJob }).enqueue = (p, r) => {
    const j = { id: `job_q${queued.length}`, projectId: p, kind: r.kind, initiator: 'auto', scope: r.scope, status: 'Queued', queuedAt: AT, startedAt: null, endedAt: null, savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: null, resultText: null, priority: 2, task: { extra: r.task ?? null } } as KeeperJob;
    queued.push(j.id);
    return s.jobs.put(j);
  };
  const round = s.clerkRounds.put({ id: 'crd_deep', projectId: proj.id, kind: 'Deepen', number: 2, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT });
  const request = s.jobs.put({ id: 'job_request', projectId: proj.id, kind: 'Your request', initiator: 'owner', scope: { kind: 'conversation', ids: [], label: 'fix the plan' }, status: 'Done', queuedAt: AT, startedAt: AT, endedAt: AT, savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: null, resultText: null, priority: 0, task: { extra: { conversationId: 'c' } } } as KeeperJob);
  const service = app.organizing as unknown as { relookAfterRequest(st: ProjectStore, j: KeeperJob): void; openDeferredRelooks(projectId: string): number };
  service.relookAfterRequest(s, request);
  const extra = () => (s.jobs.get('job_request')!.task as { extra?: { deferredRelooks?: unknown[]; relooksOpenedAt?: string | null } }).extra ?? {};
  assert.equal(extra().deferredRelooks?.length, 1, 'while the round runs, the re-look waits on the request’s job');
  assert.equal(queued.length, 0, 'nothing is queued beside the round');
  assert.equal(service.openDeferredRelooks(proj.id), 0, 'nor while it still runs');
  s.clerkRounds.put({ ...round, status: 'Done', endedAt: AT });
  assert.equal(service.openDeferredRelooks(proj.id), 1, 'once the round has ended, the re-look the request left opens');
  assert.equal(queued.length, 1);
  assert.equal((s.jobs.get(queued[0]!)!.task as { extra?: { kind?: string } }).extra?.kind, 'relook');
  assert.ok(extra().relooksOpenedAt, 'and the request’s job says when, so a restart does not open it again');
  assert.equal(service.openDeferredRelooks(proj.id), 0, 'it opens once');
  app.stopAll();
  await app.flushAll();
});
