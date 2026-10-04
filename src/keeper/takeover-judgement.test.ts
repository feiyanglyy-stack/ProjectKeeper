/**
 * Work that takes a project over never opens or joins a Follow up round (D59 rule 1; Spec §5.5, §3.7).
 *
 * Propagation is judged in the Follow up rounds after the takeover. Before this, a judgement tool called from any job
 * that had no round of its own opened one — so a takeover round that judged an object, or a subagent under it,
 * started "Follow up round 1" in the middle of the takeover, and a request it wrote was filed under whichever
 * Follow up round happened to be open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { keeperTools, type ToolContext } from './tools.ts';
import { startRound } from './adjustment.ts';
import type { ChangeRecord, GraphRelation, KeeperJob, Project, ReferenceItem, Source, WorkThread } from '../model/types.ts';

const AT = '2026-09-18T00:00:00.000Z';
const project = { id: 'p1', name: 'P', language: 'en', locations: ['D:\\p'], scope: [], roles: ['Product architect'] } as unknown as Project;
const attribution = { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' } as const;

/** A store with one change on a requirement, a work item downstream of it, and the jobs of a takeover round. */
function setup() {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-takeover-judge-')));
  store.sources.put({ id: 'src_a', projectId: 'p1', title: 'A', anchor: { kind: 'file', path: 'D:\\p\\A.md', headingPath: [], lineStart: 1, lineEnd: 2 }, ids: [], version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt: 'x', usedAs: 'Design', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: 'scope', hasCredential: false, bytes: 10 } as unknown as Source);
  store.reference.put({ id: 'ref_a', projectId: 'p1', category: 'Requirement', name: 'R-1', ids: [], text: 'R-1', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution, sourceIds: ['src_a'], refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT } as unknown as ReferenceItem);
  store.threads.put({ id: 'thread_w', projectId: 'p1', title: 'W-1', ids: [], doing: 'W-1', changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution, inputs: { jobId: 'j', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: AT, updatedAt: AT, pendingSourceIds: [], doneMeans: '', acceptanceMeans: '', acceptance: '' } as unknown as WorkThread);
  store.relations.put({ id: 'rel_serves_w_a', projectId: 'p1', type: 'serves', from: 'thread_w', to: 'ref_a', claim: '', basis: 'Explicit', evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: AT } as GraphRelation);
  store.changes.put({
    id: 'chg_a', projectId: 'p1', at: AT, atSource: 'material', material: 'Decision', effect: 'Replaced', title: 'R-1 rewritten', summary: '', before: 'old', after: 'new',
    sourceIds: ['src_a'], by: null, affects: ['ref_a'], propagation: [{ nodeId: 'thread_w', state: 'Not yet checked', sourceOrReason: '', updatedAt: AT }], notJudged: [], segment: null, createdInJobId: null, updatedAt: AT,
  } as unknown as ChangeRecord);
  const job = (id: string, scopeKind: string, extra: Record<string, unknown>, parentJobId: string | null = null) => store.jobs.put({
    id, projectId: 'p1', kind: 'Organizing', initiator: 'auto', scope: { kind: scopeKind, ids: [], label: id }, status: 'Running', queuedAt: AT, startedAt: AT, endedAt: null,
    savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null,
    requestBasis: null, parentJobId, resultText: null, priority: 1, task: { prompt: '', extra },
  } as unknown as KeeperJob);
  job('job_takeover', 'takeover', { kind: 'takeover', round: 'deepen' });
  job('job_reader', 'materials', { kind: 'materials', keys: ['file:D:\\p\\A.md'] }, 'job_takeover');
  const call = async (jobId: string, name: string, args: Record<string, unknown>) => {
    const ctx: ToolContext = { store, project, jobId, jobKind: 'Organizing', model: null };
    const tool = keeperTools(ctx).find((t) => t.name === name);
    assert.ok(tool, `no tool ${name}`);
    const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    const result = await run('call', args);
    return { text: result.content.map((c) => c.text).join('\n'), error: result.isError === true };
  };
  return { store, call };
}

test('a takeover round that judges an object does not open a Follow up round', async () => {
  const { store, call } = setup();
  const r = await call('job_takeover', 'pk_judge_object', { nodeId: 'thread_w', state: 'Updated', sourceOrReason: 'it follows the new R-1' });
  assert.equal(r.error, true, `a takeover job is told propagation belongs to the Follow up: ${r.text}`);
  assert.match(r.text, /Follow up/);
  assert.equal(store.rounds.size, 0, 'no Follow up round was opened in the middle of the takeover');
  assert.equal(store.propagation.size, 0, 'and no judgement was filed under one');
});

test('neither does a subagent under a takeover round, nor does the round result tool', async () => {
  const { store, call } = setup();
  const judged = await call('job_reader', 'pk_set_propagations', { nodeId: 'thread_w', judgements: [{ changeId: 'chg_a', state: 'Updated', sourceOrReason: 'follows it' }] });
  assert.equal(judged.error, true, judged.text);
  const result = await call('job_takeover', 'pk_write_round_result', { summary: 'nothing' });
  assert.equal(result.error, true, result.text);
  assert.equal(store.rounds.size, 0, 'no round was opened by either');
});

test('a request a takeover round writes is not filed under the Follow up round that happens to be open', async () => {
  const { store, call } = setup();
  const open = startRound(store, 'p1', null, AT);   // a Follow up round left open from before (e.g. the depth was deepened later)
  const r = await call('job_takeover', 'pk_write_modification_request', { holderRole: 'Product architect', what: 'update W-1', why: 'R-1 moved', basisSourceIds: ['src_a'], impact: ['thread_w'] });
  assert.equal(r.error, false, r.text);
  assert.equal(store.requests.all()[0]!.roundId ?? null, null, `the takeover's request is its own, not round ${open.number}'s`);
  // A Follow up round's own job still files its request under its round.
  const followUp = await call('job_other', 'pk_write_modification_request', { holderRole: 'Main agent', what: 'update product.md', why: 'same', basisSourceIds: ['src_a'], impact: ['ref_a'] });
  assert.equal(followUp.error, false, followUp.text);
  assert.equal(store.requests.all().find((q) => q.holder === 'Main agent')!.roundId, open.id);
});

test('a merge a takeover round makes names the takeover round, never the Follow up round that happens to be open', async () => {
  const { store, call } = setup();
  const w = store.threads.get('thread_w')!;
  store.threads.put({ ...w, id: 'thread_w2', title: 'W-1 (second name)' });
  store.threads.put({ ...w, id: 'thread_w3', title: 'W-1 (third name)' });
  const open = startRound(store, 'p1', null, AT);
  const r = await call('job_takeover', 'pk_merge_work_items', { keepId: 'thread_w', mergeIds: ['thread_w2'], reason: 'the same number in the plan', sourceIds: ['src_a'] });
  assert.equal(r.error, false, r.text);
  assert.equal(store.merges.all().find((m) => m.mergedId === 'thread_w2')!.roundId, 'job_takeover', `the merge belongs to the takeover round, not to round ${open.number}`);
  assert.equal(store.rounds.size, 1, 'and no Follow up round was opened for it');
  // Work outside the takeover still files its merge under the open Follow up round.
  const other = await call('job_other', 'pk_merge_work_items', { keepId: 'thread_w', mergeIds: ['thread_w3'], reason: 'the same number in the plan', sourceIds: ['src_a'] });
  assert.equal(other.error, false, other.text);
  assert.equal(store.merges.all().find((m) => m.mergedId === 'thread_w3')!.roundId, open.id);
});
