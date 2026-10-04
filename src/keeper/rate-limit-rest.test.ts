/**
 * A key that answers a rate limit (429) rests ten minutes before it is tried again, and the work waiting on it is queued
 * again at once for the other keys (owner 2026-09-28: 「3个key都可以用，试了可以用就用，限流了过10分钟再试一下」). A 429 there
 * is often the owner's own agents sharing the account. Work waiting on an exhausted quota is not touched by it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { Workspace } from '../store/workspace.ts';
import type { KeeperJob, Project } from '../model/types.ts';
import { KeeperRuntime, RATE_LIMIT_REST_MS } from './runtime.ts';

const AT = '2026-09-28T00:00:00.000Z';
const job = (id: string, status: KeeperJob['status'], error: string): KeeperJob => ({
  id, projectId: 'p1', kind: 'Organizing', initiator: 'auto', scope: { kind: 'x', ids: [], label: id }, status, queuedAt: AT, startedAt: null, endedAt: null,
  savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null,
  steps: [], error, requestBasis: null, parentJobId: null, resultText: null, priority: 1, task: { prompt: 'Organize.', stream: false, timeoutMs: null }, step: null,
} as unknown as KeeperJob);

test('a rate-limited key rests ten minutes and takes no new work; the work waiting on it is queued again for the other keys', () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-rest-'));
  const workspace = Workspace.open(home);
  workspace.setSettings({ model: { provider: 'glm', id: 'glm-5.3', thinking: 'max' }, modelBackups: [{ provider: 'glm-team', id: 'glm-5.3', thinking: 'max' }], organizingLanesPerKey: 5 });
  const store = ProjectStore.open('p1', home);
  const runtime = new KeeperRuntime(workspace, () => store, () => ({ id: 'p1', organizingPaused: true }) as unknown as Project);
  const inside = runtime as unknown as { credentialed: Set<string>; restingUntil: Map<string, number>; onRateLimit(projectId: string, provider: string): void; pump(projectId: string): void };
  inside.credentialed = new Set(['glm', 'glm-team']);
  inside.pump = () => {};   // nothing runs here: the test reads the lanes and the queue
  store.jobs.put(job('job_limited', 'Waiting for quota', '429: {"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}'));
  store.jobs.put(job('job_quota', 'Waiting for quota', '429: {"code":"1308","message":"已达到 5 小时的使用上限"}'));

  const before = Date.now();
  inside.onRateLimit('p1', 'glm');
  const lanes = runtime.laneState();
  const glm = lanes.keys.find((k) => k.provider === 'glm')!;
  const team = lanes.keys.find((k) => k.provider === 'glm-team')!;
  assert.equal(glm.capacity, 0, 'the rate-limited key takes no new work while it rests');
  assert.ok(glm.rateLimitedAt !== null && Date.parse(glm.rateLimitedAt) >= before - 5, 'the lane state says it rests, and since when');
  assert.equal(team.capacity, 5, 'the other key keeps all its lanes');
  assert.equal(lanes.total, 5);
  assert.equal(store.jobs.get('job_limited')!.status, 'Queued', 'the job waiting on the limit is queued again at once, for the other key');
  assert.equal(store.jobs.get('job_quota')!.status, 'Waiting for quota', 'work waiting on an exhausted quota is not');
  assert.ok(inside.restingUntil.get('glm')! - before >= RATE_LIMIT_REST_MS - 5 && RATE_LIMIT_REST_MS === 10 * 60_000, 'the rest is ten minutes');

  inside.restingUntil.set('glm', Date.now() - 1);
  assert.equal(runtime.laneState().keys.find((k) => k.provider === 'glm')!.capacity, 5, 'after its rest the key is tried again');
});
