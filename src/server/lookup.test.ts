/**
 * The agent entry's lookup (`pk get <id>`, `pk context --work <id>`; Spec §7.10) answers the id of a merged work item
 * with the work item kept (Spec §1.4; CKC-06 AC-28), so an id an agent still holds from an older pack reads the one
 * that stands for it now instead of "not an id of this project".
 *
 * The route is called directly: registering the routes only defines handlers, so a stub app that holds one store is
 * enough, and nothing is served or started.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { registerRoutes } from './api.ts';
import type { Project, WorkThread } from '../model/types.ts';

test('the lookup of a merged work item’s id answers with the work item kept (CKC-06 AC-28; Spec §7.10)', () => {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-lookup-')));
  const project = { id: 'p1', name: 'Ledger', language: 'en', locations: ['D:\\ledger'], scope: [], roles: [] } as unknown as Project;
  store.threads.put({ id: 'thread_a', projectId: 'p1', title: 'L-4 · export invoices', ids: ['L-4'] } as unknown as WorkThread);
  store.merges.put({ id: 'merge_1', projectId: 'p1', kind: 'thread', mergedId: 'thread_b', keptId: 'thread_a', reason: 'both are L-4', sourceIds: [], merged: { id: 'thread_b', title: 'Invoice export (batch 2 notes)' } as WorkThread, at: '2026-09-17', jobId: null, roundId: null });

  const handlers = new Map<string, (ctx: unknown) => unknown>();
  const http = { route: (method: string, path: string, handler: (ctx: unknown) => unknown) => handlers.set(`${method} ${path}`, handler), static: () => undefined };
  const app = { project: () => project, store: () => store, workspace: { list: () => [project] } };
  registerRoutes(http as never, app as never, '', '');
  const lookup = (oid: string) => handlers.get('GET /api/projects/:id/lookup/:oid')!({ params: { id: 'p1', oid }, query: new URLSearchParams(), body: null }) as Record<string, unknown>;

  assert.deepEqual(lookup('thread_b'), { id: 'thread_a', kind: 'work', projectId: 'p1', mergedFrom: 'thread_b' });
  assert.deepEqual(lookup('thread_a'), { id: 'thread_a', kind: 'work', projectId: 'p1' }, 'an id that was not merged is answered as before');
  assert.equal(lookup('thread_nowhere').kind, null);
});
