/**
 * `Done means` and `Version check` in a work context (CKC-12 AC-4; Spec §7.3 items 3 and 7), and
 * `Disposal` marks in `Do not revive` (§7.1, §2.8).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../server/app.ts';
import { assembleContext } from './assemble.ts';
import { fullIntake } from '../intake/intake.ts';

test('work context states what done means, checks the cited version and lists disposal leftovers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-proj-'));
  writeFileSync(join(projectDir, 'CONTRACT.md'), '# Contract T-2\n\nContract version: v2.0 · ready\n\nDone when search answers in under 50 ms on 10k notes.\n');
  const app = new App(home, { organizing: false });
  const project = app.scopeProject(app.addProject('Notesy', [projectDir]).id);   // the boundary, as the takeover draws it
  const store = app.store(project.id);
  await fullIntake(store, project);
  const s = store.sources.find((x) => x.anchor.kind === 'file')!;
  const now = '2026-09-16T10:00:00.000Z';
  const owner = { author: { kind: 'owner' as const, name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' as const };
  const inputs = { jobId: 'x', sourceIds: [s.id], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' };
  store.reference.put({ id: 'ref_goal', projectId: project.id, category: 'Goal', name: 'Capture fast', ids: [], text: 'Capture a thought in two seconds.', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: owner, sourceIds: [s.id], refines: [], replacedBy: null, inputs, asOf: now, updatedAt: now });
  store.reference.put({ id: 'ref_search', projectId: project.id, category: 'Area', name: 'Search', ids: [], text: 'Full text search.', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: owner, sourceIds: [s.id], refines: ['ref_goal'], replacedBy: null, inputs, asOf: now, updatedAt: now });
  store.reference.put({ id: 'ref_old', projectId: project.id, category: 'Area', name: 'Tag browser', ids: [], text: 'Browse by tag.', quote: null, basis: 'Explicit', validity: 'Abandoned', progress: null, attribution: owner, sourceIds: [s.id], refines: ['ref_goal'], replacedBy: null, inputs, asOf: now, updatedAt: now });
  store.facts.put({ id: 'fact_c', projectId: project.id, title: 'Contract T-2', aboutSourceIds: [s.id], statements: [{ id: 'st_1', type: 'Observed', text: 'The contract is at v2.0.', sourceIds: [s.id] }], decisions: [], changes: [], openQuestions: [], executionFacts: [], language: 'en', inputs, asOf: now, updatedAt: now, pendingSourceIds: [] });
  store.threads.put({ id: 'thread_t2', projectId: project.id, title: 'Search index', ids: ['T-2'], doing: 'Build the full-text index.', changed: '', results: 'Index builds.', unresolved: 'Speed target not met.', doneMeans: 'Search answers in under 50 ms on 10k notes.', executionFacts: [], qcFacts: [], factRecordIds: ['fact_c'], serves: [{ referenceId: 'ref_search', claim: 'makes search fast', basis: 'Explicit' }], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, inputs, asOf: now, updatedAt: now, pendingSourceIds: [] });
  store.marks.put({ id: 'mark_d', projectId: project.id, kind: 'Disposal', targetId: 'ref_old', clueSourceIds: [s.id], clue: 'tags/ directory is left over from the abandoned tag browser', since: now, noteId: null, closed: null });

  const base = { scope: { kind: 'work' as const, ids: ['thread_t2'] }, purpose: 'Work' as const, kind: 'Implement' as const, recipient: 'Incoming agent', lastSessionAt: null };
  const same = assembleContext(store, project, { ...base, taskVersion: 'T-2 v2.0' }, 'Idle').markdown;
  assert.match(same, /## Done means\n- Search answers in under 50 ms/, 'Done means comes from the thread');
  assert.match(same, /## Version check\n- Your task cites: T-2 v2\.0\n- Current material for .*v2\.0 — same as your task/, 'a matching version is confirmed with its source');
  const differs = assembleContext(store, project, { ...base, taskVersion: 'T-2 v1.0' }, 'Idle').markdown;
  assert.match(differs, /Version check[\s\S]*differs from your task's v1\.0/, 'a stale version is called out');
  const none = assembleContext(store, project, base, 'Idle').markdown;
  assert.doesNotMatch(none, /## Version check/, 'no version check without a cited version');
  const start = assembleContext(store, project, { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null }, 'Idle').markdown;
  assert.match(start, /## Do not revive[\s\S]*Disposal: Tag browser \(`ref_old`\) — tags\/ directory is left over/, 'disposal leftovers are listed under Do not revive, with the id that reads them');
});
