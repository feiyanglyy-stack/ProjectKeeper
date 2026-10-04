/**
 * Change follow-up batches (D48). The work is organized by object: an object reached by several changes is judged in
 * one batch against all of them, and each change is described once. An entry already handed to a running job is never
 * handed out again — even when a new change arrives mid-round and shifts every batch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../../store/project-store.ts';
import { entryKey, pendingByArea, pendingCount, pendingForRound } from './follow-up.ts';
import type { ChangeRecord, WorkThread } from '../../model/types.ts';

function storeWith(threads: number): ProjectStore {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-fu-')));
  for (let i = 0; i < threads; i++) {
    store.threads.put({ id: `thread_${i}`, title: `T${i}`, doing: `doing ${i}`, results: '', progress: 'In progress', validity: 'Current', factRecordIds: [], updatedAt: '2026-09-17T00:00:00.000Z' } as unknown as WorkThread);
  }
  return store;
}
const change = (id: string, at: string, nodeIds: readonly string[]) => ({
  id, projectId: 'p1', at, effect: 'Replaced', title: `title of ${id}`, summary: '', before: null, after: null, sourceIds: [], affects: [],
  propagation: nodeIds.map((nodeId) => ({ nodeId, state: 'Not yet checked', sourceOrReason: '', updatedAt: at })),
}) as unknown as ChangeRecord;
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => `thread_${from + k}`);

test('a new change mid-round does not hand in-flight entries out twice', () => {
  const store = storeWith(60);
  store.changes.put(change('chg_old', '2026-09-17T00:00:00.000Z', range(0, 60)));
  const limits = { objects: 25, entries: 25 };

  const first = pendingByArea(store, limits);
  assert.deepEqual(first.map((b) => b.entries.length), [25, 25, 10]);
  const inFlight = new Set(first.slice(0, 2).flatMap((b) => b.entries.map(entryKey)));   // two batches running

  // A newer change arrives, reaching objects that are already being judged against the old one.
  store.changes.put(change('chg_new', '2026-09-18T00:00:00.000Z', range(0, 5)));
  const next = pendingByArea(store, limits, inFlight);
  const handed = next.flatMap((b) => b.entries.map(entryKey));
  assert.equal(handed.filter((k) => inFlight.has(k)).length, 0, 'nothing already running is handed out again');
  assert.equal(new Set(handed).size, handed.length, 'no entry is in two batches');
  assert.equal(handed.length, 10 + 5, 'the rest of the old change, and all of the new one');
  assert.deepEqual(pendingCount(store), { entries: 65, changes: 2, objects: 60, notJudged: 0 }, 'the count is of what is still to judge, running or not');
});

test('an object reached by several changes is judged once, against all of them', () => {
  const store = storeWith(12);
  // thread_0 is reached by three changes; the others by one each.
  store.changes.put(change('chg_a', '2026-09-16T00:00:00.000Z', ['thread_0', ...range(1, 6)]));
  store.changes.put(change('chg_b', '2026-09-17T00:00:00.000Z', ['thread_0', ...range(6, 12)]));
  store.changes.put(change('chg_c', '2026-09-18T00:00:00.000Z', ['thread_0']));

  const batches = pendingByArea(store, { objects: 4, entries: 80 });
  const holding = batches.filter((b) => b.objects.some((o) => o.nodeId === 'thread_0'));
  assert.equal(holding.length, 1, 'the object is in one batch');
  assert.deepEqual(holding[0]!.objects.find((o) => o.nodeId === 'thread_0')!.entries.map((e) => e.changeId).sort(), ['chg_a', 'chg_b', 'chg_c']);
  assert.ok(batches.every((b) => b.objects.length <= 4), 'no batch takes more objects than the limit');
  assert.equal(batches.reduce((n, b) => n + b.entries.length, 0), 3 + 5 + 6, 'every pending entry is in some batch');
  assert.equal(new Set(batches.flatMap((b) => b.objects.map((o) => o.nodeId))).size, 12, 'every object is in exactly one batch');

  // What the round is given to judge (pk_round_pending) lists the objects this way: each change once, then each object
  // with the changes it is judged against.
  const listed = pendingForRound(store).text;
  const changesPart = listed.slice(listed.indexOf('=== Changes'), listed.indexOf('=== Objects to judge'));
  for (const id of holding[0]!.changeIds) assert.equal(changesPart.split(`- ${id} ·`).length - 1, 1, `${id} is described once`);
  assert.match(listed, /- thread_0 · [^\n]*\n(?: {4}[^\n]*\n)* {4}judge against: chg_c[^,]*, chg_b[^,]*, chg_a/, 'the object lists its changes, newest first');
});
