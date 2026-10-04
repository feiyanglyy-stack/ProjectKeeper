/**
 * `Change log` has the semantic patches (CKC-26 AC-4; Spec §1.17, §6.5; QC AY B7): a patch is its own kind of row, read
 * from the patches themselves — never a second copy that could drift from them — oldest first by when the supersession
 * happened; a strike-through's pointer opens the patch's details, the same text `pk get SP-n` prints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import type { Project, ReferenceItem } from '../model/types.ts';
import type { SemanticPatch } from '../model/k-types.ts';
import type { App } from './app.ts';
import { patchesView, patchView, registerKRoutes } from './k-views.ts';
import { registerKAgentRoutes } from './k-agent-api.ts';

const project = { id: 'p1', name: 'Tags', locations: [], scope: [], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: '', lastOpenedAt: null, lastScopedAt: null } as unknown as Project;
const patch = (id: string, number: string, status: SemanticPatch['status'], at: string, extra: Partial<SemanticPatch> = {}): SemanticPatch => ({
  id, projectId: 'p1', number, title: `${number} title`, invalidated: 'the tag browser', replacedBy: 'search (D4)', affects: ['ref_plan'], affectsText: 'the plan',
  mustNotPassAsCurrent: 'the tag browser as the way to find things', oldAnchor: { kind: 'file', id: 'docs/plan-v1.md', label: 'plan v1', line: 'The tag browser.' }, newAnchor: null,
  decision: { kind: 'object', id: 'ref_d4', label: 'D4' }, candidate: { kind: 'ledger', id: `sup:${id}`, label: 'supersedes', line: 'D4 supersedes the tag browser' },
  partial: false, occurred: { at, basis: 'Commit', anchor: null }, status, writtenToFolder: null, roundId: null, jobId: null, updatedAt: '', ...extra,
});

test('Change log reads the semantic patches oldest first, and a patch’s details are the text the CLI prints', () => {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-patches-')));
  store.reference.put({ id: 'ref_plan', projectId: 'p1', category: 'Plan', name: 'The plan', ids: [], text: '', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: null, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: '', updatedAt: '' } as unknown as ReferenceItem);
  store.patches.putMany([
    patch('patch_b', 'SP-2', 'Confirmed', '2026-09-10T09:00:00Z', { partial: true }),
    patch('patch_a', 'SP-1', 'Draft', '2026-09-05'),
    patch('patch_c', 'SP-3', 'Rejected', '2026-09-12T09:00:00Z'),
  ]);
  const all = patchesView(store);
  assert.deepEqual(all.map((p) => [p.number, p.status]), [['SP-1', 'Draft'], ['SP-2', 'Confirmed'], ['SP-3', 'Rejected']], 'oldest first by when it happened, each with its status (Change log shows the confirmed)');
  assert.deepEqual(all[1]!.affects, [{ id: 'ref_plan', label: 'The plan' }], 'affects are named');
  assert.equal(all[1]!.partial, true);
  assert.equal(all[1]!.text, undefined, 'the list carries no details text');

  // The routes: the list, and one patch by id or by its number, with the same text the agent entry prints for it.
  const routes = new Map<string, (req: { params: Record<string, string>; query: URLSearchParams }) => unknown>();
  const app = { store: () => store, project: () => project, kEngines: {}, ledger: { ledger: () => null } } as unknown as App;
  const http = { route: (m: string, p: string, h: never) => routes.set(`${m} ${p}`, h) } as never;
  registerKRoutes(http, app);
  registerKAgentRoutes(http, app);
  const list = routes.get('GET /api/projects/:id/patches')!({ params: { id: 'p1' }, query: new URLSearchParams() }) as { patches: { number: string }[] };
  assert.deepEqual(list.patches.map((p) => p.number), ['SP-1', 'SP-2', 'SP-3']);
  const byNumber = routes.get('GET /api/projects/:id/patches/:pid')!({ params: { id: 'p1', pid: 'SP-2' }, query: new URLSearchParams() }) as { id: string; text: string };
  assert.equal(byNumber.id, 'patch_b');
  const brief = routes.get('GET /api/projects/:id/k-briefs/:oid')!({ params: { id: 'p1', oid: 'patch_b' }, query: new URLSearchParams() }) as { text: string };
  assert.equal(byNumber.text, brief.text, 'the details are, word for word, what `pk get` prints');
  assert.match(byNumber.text, /Replaced by: search \(D4\)/);
  assert.equal(patchView(store, store.patches.get('patch_b')!, true).text, brief.text);
  assert.throws(() => routes.get('GET /api/projects/:id/patches/:pid')!({ params: { id: 'p1', pid: 'SP-9' }, query: new URLSearchParams() }), /Unknown semantic patch/);
});
