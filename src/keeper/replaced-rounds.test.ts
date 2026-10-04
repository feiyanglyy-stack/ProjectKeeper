/**
 * A home that a build before increment K left with a round of the material method waiting — queued, paused or waiting
 * for quota — has it stopped at start, with the reason: the clerk method replaced those rounds (Spec v3.0 §3.3) and
 * their prompts name tools that no longer exist. A clerk step, an ordinary job and a finished round are left alone. One
 * that was stopped or failed is not continued or retried either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { Workspace } from '../store/workspace.ts';
import type { KeeperJob, Project } from '../model/types.ts';
import { KeeperRuntime, clearErrorsOfFinishedWork, requeueWaitingForQuota, stopReplacedRounds } from './runtime.ts';

const AT = '2026-09-26T00:00:00.000Z';
const job = (id: string, status: KeeperJob['status'], extra: Record<string, unknown> | null, step: KeeperJob['step'] = null): KeeperJob => ({
  id, projectId: 'p1', kind: 'Organizing', initiator: 'auto', scope: { kind: 'x', ids: [], label: id }, status, queuedAt: AT, startedAt: null, endedAt: null,
  savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null,
  steps: [], error: null, requestBasis: null, parentJobId: null, resultText: null, priority: 1, task: { extra }, step,
} as unknown as KeeperJob);

test('a round of the material method left waiting is stopped at start, with the reason; nothing else is touched', () => {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-replaced-')));
  store.jobs.put(job('job_takeover', 'Queued', { kind: 'takeover', round: 'deepen' }));
  store.jobs.put(job('job_reader', 'Paused', { kind: 'materials', keys: ['file:a.md'] }));
  store.jobs.put(job('job_followup', 'Waiting for quota', { kind: 'round' }));
  store.jobs.put(job('job_done', 'Done', { kind: 'takeover' }));
  store.jobs.put(job('job_step', 'Queued', { kind: 'clerk-step', roundId: 'crd_1' }, { roundId: 'crd_1', kind: 'orientation', path: null }));
  store.jobs.put(job('job_answer', 'Queued', null));

  assert.equal(stopReplacedRounds(store), 3);
  for (const id of ['job_takeover', 'job_reader', 'job_followup']) {
    const j = store.jobs.get(id)!;
    assert.equal(j.status, 'Stopped', id);
    assert.match(j.error ?? '', /material method.*not run/);
  }
  assert.equal(store.jobs.get('job_done')!.status, 'Done');
  assert.equal(store.jobs.get('job_step')!.status, 'Queued', 'a step of a clerk round runs');
  assert.equal(store.jobs.get('job_answer')!.status, 'Queued', 'an answer or a request runs');
  assert.equal(stopReplacedRounds(store), 0, 'a second start finds nothing more');
});

test('after a restart, work left waiting for quota is queued again; a program job and a replaced round are not (Spec §3.10)', () => {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-requeue-')));
  store.jobs.put(job('job_answer', 'Waiting for quota', null));
  store.jobs.put(job('job_step', 'Waiting for quota', { kind: 'clerk-step', roundId: 'crd_1' }, { roundId: 'crd_1', kind: 'dig', path: 'A' }));
  store.jobs.put({ ...job('job_ledger', 'Waiting for quota', { kind: 'clerk-step' }), agent: 'program' } as KeeperJob);
  store.jobs.put(job('job_old_round', 'Waiting for quota', { kind: 'takeover', round: 'deepen' }));
  store.jobs.put(job('job_done', 'Done', null));
  assert.equal(requeueWaitingForQuota(store), 2);
  for (const id of ['job_answer', 'job_step']) {
    assert.equal(store.jobs.get(id)!.status, 'Queued', id);
    assert.equal(store.jobs.get(id)!.error, null, id);
  }
  assert.equal(store.jobs.get('job_ledger')!.status, 'Waiting for quota', 'the program runs its own steps again (clerk.ts)');
  assert.equal(store.jobs.get('job_old_round')!.status, 'Waiting for quota', 'stopReplacedRounds stops it instead');
  assert.equal(store.jobs.get('job_done')!.status, 'Done');
  assert.equal(requeueWaitingForQuota(store), 0);
});

test('at start, finished work carries no error left from an earlier run; work that failed or waits keeps its own', () => {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-stale-error-')));
  const quota = '429: {"code":"1308","message":"已达到 5 小时的使用上限"}';
  store.jobs.put({ ...job('job_done_after_quota', 'Done', null), error: quota } as KeeperJob);
  store.jobs.put({ ...job('job_failed', 'Failed', null), error: 'the model refused the same call twice' } as KeeperJob);
  store.jobs.put({ ...job('job_queued_again', 'Queued', null), error: quota } as KeeperJob);
  store.jobs.put(job('job_done', 'Done', null));
  assert.equal(clearErrorsOfFinishedWork(store), 1);
  assert.equal(store.jobs.get('job_done_after_quota')!.error, null, 'done work does not show the quota answer of the run before');
  assert.equal(store.jobs.get('job_failed')!.error, 'the model refused the same call twice', 'a failure keeps its reason');
  assert.equal(store.jobs.get('job_queued_again')!.error, quota, 'queued work shows why it went back until it runs again');
  assert.equal(clearErrorsOfFinishedWork(store), 0);
});

test('a round of the material method is not continued or retried: Continue and Retry leave it as it is', () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-replaced-home-'));
  const store = ProjectStore.open('p1', home);
  const runtime = new KeeperRuntime(Workspace.open(home), () => store, () => ({ id: 'p1' }) as unknown as Project);
  store.jobs.put(job('job_followup', 'Stopped', { kind: 'round' }));
  store.jobs.put(job('job_frame', 'Failed', { kind: 'takeover', round: 'frame' }));
  store.jobs.put(job('job_reader', 'Waiting for quota', { kind: 'materials', keys: [] }));
  for (const id of ['job_followup', 'job_frame', 'job_reader']) {
    const before = store.jobs.get(id)!.status;
    assert.equal(runtime.restartJob('p1', id), false, id);
    assert.equal(store.jobs.get(id)!.status, before, `${id} stays ${before}`);
  }
});

test('a job the program did itself (a round, its ledger or process step) is not continued or retried as a model run (AH #10)', () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-program-home-'));
  const store = ProjectStore.open('p1', home);
  const runtime = new KeeperRuntime(Workspace.open(home), () => store, () => ({ id: 'p1' }) as unknown as Project);
  const ledger = runtime.recordProgramJob('p1', { kind: 'Organizing', scope: { kind: 'clerk-step', ids: ['crd_1'], label: 'Ledger' }, step: { roundId: 'crd_1', kind: 'ledger', path: null }, parentJobId: null, task: null });
  runtime.endProgramJob('p1', ledger.id, 'Failed', { error: 'git log failed' });
  const round = runtime.recordProgramJob('p1', { kind: 'Organizing', scope: { kind: 'clerk-round', ids: ['crd_1'], label: 'First usable' }, step: null, parentJobId: null, task: null });
  runtime.endProgramJob('p1', round.id, 'Stopped');
  for (const [id, before] of [[ledger.id, 'Failed'], [round.id, 'Stopped']] as const) {
    assert.equal(runtime.restartJob('p1', id), false, id);
    assert.equal(store.jobs.get(id)!.status, before, `${id} stays ${before}`);
    assert.equal(store.jobs.get(id)!.task && (store.jobs.get(id)!.task as { prompt?: string }).prompt, '', 'still the program’s job, not a queued model run');
  }
});
