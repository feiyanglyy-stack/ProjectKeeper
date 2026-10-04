/**
 * `Came from` (Spec §4.1, §4.2; D47 supplement, D56 item 5): a note names the kind of work that wrote it. By the clerk
 * method (Spec v3.0 §3.3) that is the round a step belongs to — a Follow up round's notes came from following the changes
 * up and name the changes they are about, the takeover's from taking the project over — and outside a round the kind of
 * job. A follow-up note names the changes the round took up whose downstream holds the object it is mounted on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { cameFromFor, originOfJob } from './note-origin.ts';
import { countRound } from './adjustment.ts';
import type { ChangeRecord, KeeperJob, Note, ObjectJudgement } from '../model/types.ts';
import type { ClerkRound, RoundStepKind } from '../model/k-types.ts';

const AT = '2026-09-18T00:00:00.000Z';
const job = (kind: string, scopeKind: string, extra: Record<string, unknown> | null = null) =>
  ({ id: `job_${kind}_${scopeKind}`, kind, scope: { kind: scopeKind, ids: [], label: '' }, task: { extra }, step: null, parentJobId: null }) as unknown as KeeperJob;
const stepJob = (round: ClerkRound, step: RoundStepKind) =>
  ({ id: `job_${round.id}_${step}`, kind: step === 'synthesis' ? 'Product re-look' : 'Organizing', scope: { kind: 'clerk-step', ids: [round.id], label: step }, task: { extra: { kind: 'clerk-step', roundId: round.id } }, step: { roundId: round.id, kind: step, path: null }, parentJobId: round.rootJobId }) as unknown as KeeperJob;
const clerkRound = (id: string, kind: ClerkRound['kind'], followUpRoundId: string | null): ClerkRound => ({
  id, projectId: 'p1', kind, number: 1, startedAt: AT, endedAt: null, status: 'Running', rootJobId: `root_${id}`, questionsDocId: null, paths: [], outputs: [],
  groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId, updatedAt: AT,
});
const change = (id: string, nodeId: string) => ({
  id, projectId: 'p1', at: AT, effect: 'Replaced', title: id, summary: '', before: null, after: null,
  sourceIds: [], affects: [], propagation: [{ nodeId, state: 'Still on old understanding', sourceOrReason: 'x', updatedAt: AT }],
}) as unknown as ChangeRecord;

test('outside a round the origin comes from the kind of work; a job that is none of them has none', () => {
  assert.equal(originOfJob(job('Product re-look', 'area')), 'Product re-look', 'a re-look the owner asked for, or one after a request');
  assert.equal(originOfJob(job('Investigation', 'question')), 'Investigation');
  assert.equal(originOfJob(job('Your request', 'conversation')), 'Owner question');
  assert.equal(originOfJob(job('Answering', 'agent-query')), 'Owner question');
  assert.equal(originOfJob(job('Organizing', 'clerk-step')), 'Organizing');
  assert.equal(originOfJob(job('Context', 'project')), null, 'assembling a pack writes no note, so it has no origin');
  assert.equal(originOfJob(undefined), null, 'a note written by ProjectKeeper itself has no job');
});

test('a note a Follow up round writes came from following the changes up, names the changes it took up, and the round counts it', () => {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-origin-')));
  store.changes.put(change('chg_a', 'thread_x'));
  store.changes.put(change('chg_b', 'thread_y'));
  store.changes.put(change('chg_old', 'thread_x'));
  const round = clerkRound('crd_fu', 'Follow up', 'round_1');
  store.clerkRounds.put(round);
  store.rounds.put({ id: 'round_1', projectId: 'p1', number: 1, startedAt: AT, endedAt: null, mainJobId: null, result: null });
  // The round's cross-check judged thread_x against chg_a and thread_y against chg_b; chg_old reached thread_x long before.
  const judged = (nodeId: string, changeId: string) => ({ id: `round_1:${nodeId}`, projectId: 'p1', nodeId, roundId: 'round_1', state: 'Still on old understanding', sourceOrReason: 'x', covers: [{ changeId, itemId: 'it' }], followed: [], lacks: [{ changeId, itemId: 'it', what: 'x' }], closed: [], objectUpdatedAt: AT, jobId: null, at: AT }) as ObjectJudgement;
  store.propagation.put(judged('thread_x', 'chg_a'));
  store.propagation.put(judged('thread_y', 'chg_b'));

  for (const step of ['synthesis', 'spot-check'] as const) {
    const came = cameFromFor(store, stepJob(round, step), ['thread_x']);
    assert.equal(came.kind, 'Change follow-up', `${step}: a Follow up round's note came from following the changes up`);
    assert.deepEqual(came.changeIds, ['chg_a'], `${step}: of the changes the round took up, the one reaching the mounted object — not an older one`);
  }
  const synthesis = stepJob(round, 'synthesis');
  assert.deepEqual(cameFromFor(store, synthesis, ['thread_x'], { given: ['chg_b'] }).changeIds, ['chg_b'], 'what the Keeper named wins');
  assert.deepEqual(cameFromFor(store, synthesis, ['thread_x'], { given: ['chg_missing'] }).changeIds, ['chg_a'], 'an id that is not a change falls back to the rule');

  // The round's one result counts its notes by that origin (adjustment.ts countRound): a Follow up round whose notes came
  // out as `Product re-look` or `Organizing` counted none of them.
  const note = { id: 'note_1', projectId: 'p1', mount: { kind: 'node', ids: ['thread_x'] }, status: 'Current', ownerResponse: null, versions: [], discussion: [], followUps: [], author: { agent: 'pi', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, cameFrom: cameFromFor(store, synthesis, ['thread_x']), language: 'en', updatedAt: AT } as unknown as Note;
  store.notes.put(note);
  assert.deepEqual(countRound(store, 'round_1').noteIds, ['note_1']);
});

test('a note a takeover round writes came from taking the project over; only a follow-up note names changes', () => {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-origin-')));
  store.changes.put(change('chg_a', 'thread_x'));
  for (const kind of ['First usable', 'Deepen'] as const) {
    const round = clerkRound(`crd_${kind === 'Deepen' ? 'dp' : 'fu'}`, kind, null);
    store.clerkRounds.put(round);
    const came = cameFromFor(store, stepJob(round, 'synthesis'), ['thread_x'], { given: ['chg_a'] });
    assert.equal(came.kind, 'Takeover', `${kind}: written while taking the project over`);
    assert.deepEqual(came.changeIds, []);
  }
  assert.deepEqual(cameFromFor(store, job('Product re-look', 'area'), ['thread_x']).changeIds, []);
});
