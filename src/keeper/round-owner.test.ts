/**
 * A Follow up round's judgements and its one result are written by that round's own main job (batch D2; independent
 * review AK, P3; Spec §3.3, §5.5; CKC-11 AC-25). The owner's conversation used to be offered the judgement tools and
 * the round result tool, and a judgement from it opened a round when none was open — so a conversation could open a
 * round, judge objects in it and close it with a result, beside the rule that one round has one result, written by its
 * main job. The tools are kept from such a job by role (roles.ts); here the tools themselves refuse it as well, and the
 * round's own main job still judges and writes the result.
 *
 * The fixtures are an invented project, "Kestrel", a field-notes app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { keeperTools, type ToolContext } from './tools.ts';
import { startRound } from './adjustment.ts';
import { assembleContext } from '../context/assemble.ts';
import type { ChangeRecord, ContextRequest, GraphRelation, KeeperJob, Project, ReferenceItem, TakeoverStatus, WorkThread } from '../model/types.ts';

const AT = '2024-03-01T00:00:00.000Z';
const project = { id: 'p1', name: 'Kestrel', language: 'en', locations: ['D:\\kestrel'], scope: [], roles: [] } as unknown as Project;
const attribution = { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' } as const;

/** A store after the takeover: a requirement that changed, a work item downstream of it, and the jobs the runtime keeps. */
function setup() {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-round-owner-')));
  store.setCoverage({ ...store.coverage, takeover: { stage: 'Daily' } as unknown as TakeoverStatus });
  store.reference.put({ id: 'ref_sync', projectId: 'p1', category: 'Requirement', name: 'R-2 offline sync', ids: ['R-2'], text: 'Notes sync when the phone is back online.', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT } as unknown as ReferenceItem);
  store.threads.put({ id: 'thread_sync', projectId: 'p1', title: 'W-4 sync queue', ids: ['W-4'], doing: 'A queue that replays edits made offline.', changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution, inputs: { jobId: 'j', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: AT, updatedAt: AT, pendingSourceIds: [], doneMeans: '', acceptanceMeans: '', acceptance: '' } as unknown as WorkThread);
  store.relations.put({ id: 'rel_w4_r2', projectId: 'p1', type: 'serves', from: 'thread_sync', to: 'ref_sync', claim: '', basis: 'Explicit', evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: AT } as GraphRelation);
  store.changes.put({
    id: 'chg_sync', projectId: 'p1', at: AT, atSource: 'material', material: 'Decision', effect: 'Replaced', title: 'R-2 now syncs on Wi-Fi only', summary: '', before: 'any network', after: 'Wi-Fi only',
    sourceIds: [], by: null, affects: ['ref_sync'], propagation: [{ nodeId: 'thread_sync', state: 'Not yet checked', sourceOrReason: '', updatedAt: AT }], notJudged: [], segment: null, createdInJobId: null, updatedAt: AT,
  } as unknown as ChangeRecord);
  const job = (id: string, kind: string, scopeKind: string, extra: Record<string, unknown>) => store.jobs.put({
    id, projectId: 'p1', kind, initiator: kind === 'Answering' ? 'owner' : 'auto', scope: { kind: scopeKind, ids: [], label: id }, status: 'Running', queuedAt: AT, startedAt: AT, endedAt: null,
    savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null,
    requestBasis: null, parentJobId: null, resultText: null, priority: 0, task: { prompt: '', extra },
  } as unknown as KeeperJob);
  // A turn of the owner's conversation, as the conversation service enqueues it.
  job('job_turn', 'Answering', 'conversation', { conversationId: 'conv_1', question: 'W-4 already follows the new R-2', context: null, ownerSourceId: 'src_msg', turn: 1 });
  const call = async (ctx: ToolContext, name: string, args: Record<string, unknown>) => {
    const tool = keeperTools(ctx).find((t) => t.name === name);
    assert.ok(tool, `no tool ${name}`);
    const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    const result = await run('call', args);
    return { text: result.content.map((c) => c.text).join('\n'), error: result.isError === true };
  };
  const conversation: ToolContext = { store, project, jobId: 'job_turn', jobKind: 'Answering', model: null, ownerSourceId: 'src_msg' };
  return { store, call, conversation, job };
}

const judgement = { nodeId: 'thread_sync', state: 'Updated', sourceOrReason: 'the owner says W-4 already replays on Wi-Fi only' };

test('the owner’s conversation opens no Follow up round by judging an object, and writes no round’s result', async () => {
  const { store, call, conversation } = setup();
  const judged = await call(conversation, 'pk_judge_object', judgement);
  assert.equal(judged.error, true, `a conversation is refused: ${judged.text}`);
  assert.match(judged.text, /main job/, 'and told whose the judgement is');
  const perChange = await call(conversation, 'pk_set_propagations', { nodeId: 'thread_sync', judgements: [{ changeId: 'chg_sync', state: 'Updated', sourceOrReason: 'follows it' }] });
  assert.equal(perChange.error, true, perChange.text);
  const result = await call(conversation, 'pk_write_round_result', { summary: 'W-4 follows R-2.' });
  assert.equal(result.error, true, result.text);
  assert.equal(store.rounds.size, 0, 'no round was opened');
  assert.equal(store.propagation.size, 0, 'and nothing was judged');
});

test('an unregistered job cannot open or join a Follow up round', async () => {
  const { store, call } = setup();
  const missing: ToolContext = { store, project, jobId: 'job_missing', jobKind: 'Organizing', model: null };
  const judged = await call(missing, 'pk_judge_object', judgement);
  assert.equal(judged.error, true, `a job absent from the store must be refused: ${judged.text}`);
  assert.match(judged.text, /job|registered|main/i);
  assert.equal(store.rounds.size, 0, 'the unknown job opened no round');
  assert.equal(store.propagation.size, 0, 'and wrote no judgement');
});

test('while a round is open, the conversation neither judges in it nor closes it; the round’s own main job does both', async () => {
  const { store, call, conversation, job } = setup();
  const round = startRound(store, 'p1', null, AT);
  job('job_round', 'Organizing', 'round', { kind: 'round', roundId: round.id });
  store.rounds.put({ ...store.rounds.get(round.id)!, mainJobId: 'job_round' });

  const judged = await call(conversation, 'pk_judge_object', judgement);
  assert.equal(judged.error, true, judged.text);
  const closed = await call(conversation, 'pk_write_round_result', { summary: 'W-4 follows R-2.' });
  assert.equal(closed.error, true, closed.text);
  assert.equal(store.propagation.size, 0, 'the conversation judged nothing in the round');
  assert.equal(store.rounds.get(round.id)!.endedAt, null, 'nor did it close the round');

  const main: ToolContext = { store, project, jobId: 'job_round', jobKind: 'Organizing', model: null, roundId: round.id };
  const mainJudged = await call(main, 'pk_judge_object', judgement);
  assert.equal(mainJudged.error, false, mainJudged.text);
  const written = await call(main, 'pk_write_round_result', { summary: 'W-4 follows the new R-2.' });
  assert.equal(written.error, false, written.text);
  const ended = store.rounds.get(round.id)!;
  assert.notEqual(ended.endedAt, null, 'the round is closed by its one result');
  assert.equal(ended.result!.counts.objectsJudged, 1, 'and the result counts the judgement its main job wrote');
});

/**
 * A round's requests are part of its one result, and the result is its main job's (batch D4; Spec §5.4, §5.5; CKC-11
 * AC-25). A modification request the owner's conversation wrote while a round happened to be open used to be filed under
 * that round and merged into the round's request to the same holder, so the owner's own delegation became part of the
 * round's Follow up result.
 */
test('while a round is open, a request the conversation writes is its own: under no round, not merged into the round’s request; the main job’s stays with the round', async () => {
  const { store, call, conversation, job } = setup();
  const round = startRound(store, 'p1', null, AT);
  job('job_round', 'Organizing', 'round', { kind: 'round', roundId: round.id });
  store.rounds.put({ ...store.rounds.get(round.id)!, mainJobId: 'job_round' });
  const main: ToolContext = { store, project, jobId: 'job_round', jobKind: 'Organizing', model: null, roundId: round.id };
  const request = { holderRole: 'Product architect', why: 'R-2 now syncs on Wi-Fi only', basisSourceIds: [], impact: ['thread_sync'] };

  const fromRound = await call(main, 'pk_write_modification_request', { ...request, what: 'bring W-4 in line with the new R-2' });
  assert.equal(fromRound.error, false, fromRound.text);
  const fromConversation = await call(conversation, 'pk_write_modification_request', { ...request, what: 'review the W-4 queue design, as the owner asked' });
  assert.equal(fromConversation.error, false, fromConversation.text);

  const requests = store.requests.all();
  assert.equal(requests.length, 2, 'the conversation’s request was not merged into the round’s');
  const roundRequest = requests.find((r) => r.roundId === round.id);
  assert.ok(roundRequest, 'the main job’s request is filed under its round');
  assert.equal(roundRequest.what, 'bring W-4 in line with the new R-2', 'and holds only what the main job wrote');
  assert.equal(roundRequest.lines!.length, 1);
  const own = requests.find((r) => r.id !== roundRequest.id)!;
  assert.equal(own.roundId ?? null, null, 'the conversation’s request is filed under no round');
  assert.equal(own.what, 'review the W-4 queue design, as the owner asked');

  const written = await call(main, 'pk_write_round_result', { summary: 'W-4 is behind R-2; the architect has the request.' });
  assert.equal(written.error, false, written.text);
  const result = store.rounds.get(round.id)!.result!;
  assert.equal(result.counts.requests, 1, 'the round’s result counts only its main job’s request');
  assert.deepEqual(result.byHolder.map((b) => b.requestId), [roundRequest.id]);

  // Both still reach the holder the way requests always have: in the holder's next context.
  const pack = assembleContext(store, { ...project, roles: ['Product architect'] }, { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Product architect', lastSessionAt: null } as ContextRequest, 'Idle').markdown;
  assert.match(pack, /- Modification request for Product architect: bring W-4 in line with the new R-2 — why: R-2 now syncs on Wi-Fi only/);
  assert.match(pack, /- Modification request for Product architect: review the W-4 queue design, as the owner asked — why: R-2 now syncs on Wi-Fi only/);
});
