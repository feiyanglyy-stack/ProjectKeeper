/**
 * History in a context pack, given as lineage (Spec §2.11, §7.1; CKC-12 AC-35; D82 withdrew D61's "history enters no
 * context"). What exists only in history and objects `Removed` from the current version are never current content; where
 * they bear on the work they are the work's `How it got here`, marked as history, with when and what replaced them or why
 * they went: a removed object the work rests on, with the change that took it out; an adjustment a later change
 * superseded, with that change; a change recorded only from history; a change whose subjects were all since replaced.
 * With a ledger, the rest of the lineage comes from it — the versions, supersession lines and commits that name the
 * work — and a step that lies only in history (an older version) is marked as such.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleContext } from './assemble.ts';
import { headings, orchardProject, orchardStore, sectionOf } from './pack-fixture.ts';
import { ProjectStore } from '../store/project-store.ts';
import { Ledger } from '../ledger/index.ts';
import { ledgerPath, rebuildLedgerInPlace } from '../ledger/rebuild.ts';
import type { ChangeRecord, ContextRequest, Project, ScopeItem, Source, WorkThread } from '../model/types.ts';
import type { WorkKind } from '../model/vocab.ts';

const pack = (store: ProjectStore, scope: ContextRequest['scope'], purpose: 'Start' | 'Work', kind: WorkKind = 'Implement', lastSessionAt: string | null = null) =>
  assembleContext(store, orchardProject, { scope, purpose, kind, recipient: 'Incoming agent', lastSessionAt } as ContextRequest, 'Idle').markdown;
const workPack = (store: ProjectStore, id: string, kind: WorkKind = 'Implement', lastSessionAt: string | null = null) => pack(store, { kind: 'work', ids: [id] }, 'Work', kind, lastSessionAt);

/** A change record of one item, as the fixture writes them. */
function oneItemChange(id: string, at: string, effect: 'Replaced' | 'Added', title: string, affects: readonly string[], sourceIds: readonly string[]): ChangeRecord {
  const by = { author: { kind: 'role' as const, name: 'Lead', window: null, host: null, model: null }, holder: null, identity: 'Artifact' as const };
  const item = { id: `${id}_item`, at, atSource: 'material' as const, material: 'Decision' as const, effect, title, summary: title, before: null, after: null, sourceIds, by, why: null, affects };
  return {
    id, projectId: orchardProject.id, at, atSource: 'material', material: 'Decision', effect, title, summary: title, before: null, after: null, sourceIds, by, affects,
    propagation: [], segment: null, createdInJobId: null, updatedAt: at, work: { kind: 'Session', label: title, sessionId: null, startedAt: at, endedAt: at, openEnded: false }, items: [item], notJudged: [],
  };
}

test('a work item resting on removed objects has them in its lineage: marked as history, with when and the change that took them out (AC-35)', () => {
  const md = workPack(orchardStore(), 'thread_r8');
  const lineage = sectionOf(md, 'How it got here');
  assert.ok(headings(md).indexOf('How it got here') === headings(md).indexOf('Relation map') + 1, 'right after the relation map');
  assert.match(lineage, /A step marked History is not current/);
  assert.match(lineage, /The project has no ledger yet, so the steps are what the assets record\./);
  assert.match(lineage, /^- 2026-09-04 · History · Removed · “REQ-9 · Two-way sync with the co-op server” \(`ref_sync`\), which this work serves: removed from the current version \(Abandoned: Sync leaves the plan — the co-op server takes no uploads; `chg_sync_gone`\) \[\d+\]$/m);
  assert.match(lineage, /^- 2026-09-04 · History · Removed · “S-1 · Sync engine” \(`thread_s1`\), which this work depends on: removed from the current version \(Abandoned: Sync leaves the plan/m);
  assert.doesNotMatch(md, /REMOVED-TEXT/, 'what the removed objects said is not given');
});

test('an adjustment a later change superseded is lineage, with the change that superseded it and why — not a change in force (AC-35, AC-40)', () => {
  const store = orchardStore();
  const md = workPack(store, 'thread_r7', 'Review', '2026-09-01');
  assert.match(sectionOf(md, 'How it got here'), /^- 2026-09-05 · History · Added · Counts on the summary page are rounded to tens \(`chg_round`, decided by Lead, within its remit\) — superseded on 2026-09-06 by “The season report becomes a PDF; CSV is dropped” \(`chg_ow_pdf`\): the owner said never round the counts \[\d+\]$/m);
  assert.doesNotMatch(sectionOf(md, 'Changes since last session'), /`chg_round`/, 'not listed again as a change');
  assert.doesNotMatch(sectionOf(md, "Owner's words"), /`chg_round`/, 'nor as an adjustment along the way');
});

test('a change recorded only from history bears on the work as lineage, its source cited as history; the start pack lists it nowhere (AC-35)', () => {
  const store = orchardStore();
  store.changes.put(oneItemChange('chg_old_r7', '2025-11-03', 'Replaced', 'The season report was a one-line CSV per tree', ['thread_r7'], ['src_old_export']));
  const md = workPack(store, 'thread_r7', 'Review', '2025-01-01');
  const line = /^- 2025-11-03 · History · Replaced · The season report was a one-line CSV per tree \(`chg_old_r7`, decided by Lead, within its remit\) — recorded only from material that exists in history \[(\d+)\]$/m.exec(sectionOf(md, 'How it got here'));
  assert.ok(line, sectionOf(md, 'How it got here'));
  assert.match(sectionOf(md, 'Sources'), new RegExp(`\\[${line![1]}\\] \`src_old_export\`[^\\n]*— history only, not the current version`));
  assert.doesNotMatch(sectionOf(md, 'Changes since last session'), /chg_old_r7/, 'not a change in force');
  assert.ok(sectionOf(md, 'How it got here').indexOf('2025-11-03') < sectionOf(md, 'How it got here').indexOf('2026-09-05'), 'oldest first');
  const start = pack(store, { kind: 'project', ids: [] }, 'Start', 'Implement', '2025-01-01');
  assert.doesNotMatch(start, /chg_old_r7/, 'the start pack is the map: lineage belongs to the work it bears on');
  assert.ok(!headings(start).includes('How it got here'));
});

test('an area’s lineage: what was part of it and was removed, and a change whose subjects were all since replaced (AC-35)', () => {
  const store = orchardStore();
  store.changes.put(oneItemChange('chg_layout', '2026-08-30', 'Added', 'The first report layout: one table, no dates', ['ref_layout1'], ['src_layout_v1']));
  const md = pack(store, { kind: 'area', ids: ['ref_a2'] }, 'Work', 'Implement', '2025-01-01');
  const lineage = sectionOf(md, 'How it got here');
  assert.match(lineage, /History · Removed · “REQ-9 · Two-way sync with the co-op server” \(`ref_sync`\), which was part of A2 · Season reports: removed from the current version/);
  assert.match(lineage, /History · Removed · “S-1 · Sync engine” \(`thread_s1`\), which R-8 · Send the report to the co-op server \(`thread_r8`\) depends on/);
  assert.match(lineage, /^- 2026-08-30 · History · Added · The first report layout: one table, no dates \(`chg_layout`, decided by Lead, within its remit\) — what it set down has since been replaced, given up or removed: DES-2 · First report layout \(`ref_layout1`\) replaced/m);
  assert.doesNotMatch(sectionOf(md, 'Changes since last session'), /chg_layout/, 'given once, as lineage');
  // What was replaced still goes to Do not revive.
  assert.match(sectionOf(md, 'Do not revive'), /DES-2 · First report layout \(`ref_layout1`\): replaced by/);
});

test('asking for a removed work item says it is history, when it went and why, and gives the start-of-work map', () => {
  const md = workPack(orchardStore(), 'thread_s1');
  assert.match(md, /The work item asked for, “S-1 · Sync engine” \(`thread_s1`\), is history: it was removed from the current version on 2026-09-04 \(Abandoned: Sync leaves the plan — the co-op server takes no uploads; `chg_sync_gone`\) \[\d+\]\. It has no context of its own/);
});

// ───────────────────────── with the project's ledger ─────────────────────────

const ENV = { GIT_AUTHOR_NAME: 'Kiln Dev', GIT_AUTHOR_EMAIL: 'dev@kiln.invalid', GIT_COMMITTER_NAME: 'Kiln Dev', GIT_COMMITTER_EMAIL: 'dev@kiln.invalid' };
const git = (cwd: string, args: string[], env: Record<string, string> = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, message: string, date: string) => { git(cwd, ['add', '-A']); git(cwd, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }); return git(cwd, ['rev-parse', 'HEAD']); };

test('with the ledger, the work’s own lineage comes along: where it first appeared, its versions — the older one marked History — and where it stands now (AC-35)', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-lineage-'));
  const repo = join(base, 'kiln');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'docs', 'PLAN.md'), '# Plan\n\n## W-1 · Export\n\nW-1 exports the list as CSV.\n');
  const c1 = commit(repo, 'Plan: W-1 exports CSV', '2026-09-01T10:00:00+00:00');
  writeFileSync(join(repo, 'docs', 'PLAN.md'), '# Plan\n\n## W-1 · Export\n\nW-1 exports the list as PDF.\n\nThe CSV export is superseded by the PDF export.\n');
  const c2 = commit(repo, 'Plan: W-1 exports PDF', '2026-09-05T10:00:00+00:00');

  const item: ScopeItem = { id: 'si-kiln', path: repo, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' };
  const project: Project = { ...orchardProject, id: 'p_kiln', name: 'Kiln', locations: [repo], scope: [item], roles: [] };
  const home = join(base, 'home');
  const store = ProjectStore.open(project.id, home);
  const source: Source = {
    id: 'src_plan_w1', projectId: project.id, title: 'W-1 · Export', anchor: { kind: 'file', path: join(repo, 'docs', 'PLAN.md'), headingPath: ['Plan', 'W-1 · Export'], lineStart: 3, lineEnd: 7 }, ids: ['W-1'],
    version: { fingerprint: 'sha256:w1', readAt: '2026-09-06T00:00:00.000Z', commit: c2 }, excerpt: 'W-1 exports the list as PDF.', usedAs: 'Plan', usedAsBy: 'keeper',
    availability: null, movedTo: null, scopeItemId: 'si-kiln', hasCredential: false, bytes: 30,
  };
  store.sources.put(source);
  store.facts.put({ id: 'fact_w1', projectId: project.id, title: 'W-1 in the plan', aboutSourceIds: [source.id], statements: [], decisions: [], changes: [], openQuestions: [], executionFacts: [], language: 'en', inputs: { jobId: 't', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: 'Kiln' }, asOf: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z', pendingSourceIds: [] });
  const w1: WorkThread = {
    id: 'thread_w1', projectId: project.id, title: 'W-1 · Export', ids: ['W-1'], doing: 'Export the list as PDF.', changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: ['fact_w1'],
    serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null,
    attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' },
    inputs: { jobId: 't', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: 'Kiln' }, asOf: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z', pendingSourceIds: [],
  };
  store.threads.put(w1);
  const file = ledgerPath(project.id, home);
  rebuildLedgerInPlace(file, project, {});
  const ledger = Ledger.openPath(file)!;
  try {
    const request = { scope: { kind: 'work', ids: ['thread_w1'] }, purpose: 'Work', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null } as ContextRequest;
    const md = assembleContext(store, project, request, 'Idle', {}, ledger).markdown;
    const lineage = sectionOf(md, 'How it got here');
    assert.doesNotMatch(lineage, /no ledger yet/);
    assert.match(lineage, /^- 2026-09-01 · First appeared · W-1 defined in docs\/PLAN\.md:3/m, lineage);
    assert.match(lineage, new RegExp(`^- 2026-09-01 · History · First appeared · docs/PLAN\\.md first version at ${c1.slice(0, 10)}`, 'm'), 'the older version is history');
    assert.match(lineage, new RegExp(`^- 2026-09-05 · Changed · docs/PLAN\\.md [^\\n]*at ${c2.slice(0, 10)}`, 'm'), 'the current version is not');
    assert.match(lineage, /^- 2026-09-05 · Replaces · docs\/PLAN\.md:7 reads \([^)]*\): The CSV export is superseded by the PDF export\./m, 'the line that says what it replaced');
    assert.match(lineage, /^- [\d-]+ · Now · docs\/PLAN\.md is in the current version/m);
    // The same request without the ledger: only what the assets record, and it says so.
    assert.doesNotMatch(assembleContext(store, project, request, 'Idle').markdown, /## How it got here/, 'nothing in the assets is history here');
  } finally {
    ledger.close();
  }
});
