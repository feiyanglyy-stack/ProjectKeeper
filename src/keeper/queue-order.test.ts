/**
 * Queue order (2026-09-18): priority first, then who has waited longest, and a job that has waited moves up one step
 * every ten minutes — so change follow-up is not starved while plan edits keep queuing framing jobs ahead of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGING_STEP_MS, queueOrder } from './runtime.ts';

const at = (msAgo: number, now: number) => new Date(now - msAgo).toISOString();

test('higher priority first; among equals, the one waiting longest', () => {
  const now = Date.parse('2026-09-18T07:00:00.000Z');
  const order = queueOrder([
    { id: 'material', priority: 2, queuedAt: at(60_000, now) },
    { id: 'frame', priority: 1, queuedAt: at(30_000, now) },
    { id: 'older material', priority: 2, queuedAt: at(120_000, now) },
  ], now).map((j) => j.id);
  assert.deepEqual(order, ['frame', 'older material', 'material']);
});

test('a job that has waited ten minutes goes before newer work one step above it', () => {
  const now = Date.parse('2026-09-18T07:00:00.000Z');
  const order = queueOrder([
    { id: 'fresh frame', priority: 1, queuedAt: at(60_000, now) },
    { id: 'follow-up, waited 12 min', priority: 2, queuedAt: at(12 * 60_000, now) },
    { id: 'follow-up, waited 3 min', priority: 2, queuedAt: at(3 * 60_000, now) },
  ], now).map((j) => j.id);
  assert.deepEqual(order, ['follow-up, waited 12 min', 'fresh frame', 'follow-up, waited 3 min']);
  assert.equal(AGING_STEP_MS, 600_000);
});
