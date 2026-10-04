/**
 * Context assembly (§7.1–§7.4, §7.8): sections only when they have content, the D15 grading
 * (Do not revive, Not in current scope, Pending owner decisions, Freshness), kind emphasis,
 * sources listed at the end, determinism, and the known part of a query.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../server/app.ts';
import { assembleContext, contextOptions } from './assemble.ts';
import { knownPart, resolveProject } from './ask.ts';
import { deriveGraph } from '../keeper/organize/graph.ts';
import { fullIntake } from '../intake/intake.ts';

async function seed() {
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-proj-'));
  writeFileSync(join(projectDir, 'PRODUCT.md'), '# Product\n\nCapture fast. api_key=sk-secret-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123\n');
  const app = new App(home, { organizing: false });
  const project = app.scopeProject(app.addProject('Notesy', [projectDir]).id);   // the boundary, as the takeover draws it
  const store = app.store(project.id);
  await fullIntake(store, project);
  const s = store.sources.find((x) => x.anchor.kind === 'file')!;
  const now = '2026-09-16T10:00:00.000Z';
  const owner = { author: { kind: 'owner' as const, name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' as const };
  const role = { author: { kind: 'role' as const, name: 'Worker', window: null, host: null, model: null }, holder: { role: 'Worker', window: 'w1' }, identity: 'Artifact' as const };
  const inputs = { jobId: 'x', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' };
  const ref = (id: string, category: 'Goal' | 'Area' | 'Decision' | 'Boundary' | 'Requirement', name: string, text: string, extra: Partial<{ validity: 'Current' | 'Proposed' | 'Replaced' | 'Deferred'; replacedBy: string | null; refines: string[]; quote: string | null }> = {}) =>
    store.reference.put({ id, projectId: project.id, category, name, ids: [], text, quote: extra.quote ?? null, basis: 'Explicit', validity: extra.validity ?? 'Current', progress: null, attribution: owner, sourceIds: [s.id], refines: extra.refines ?? [], replacedBy: extra.replacedBy ?? null, inputs: null, asOf: now, updatedAt: now });
  ref('ref_goal', 'Goal', 'Capture fast', 'Capture a thought in two seconds.', { quote: 'two seconds, no dialog' });
  ref('ref_search', 'Area', 'Search', 'Full text search.', { refines: ['ref_goal'] });
  ref('ref_tags', 'Area', 'Tag browser', 'Browse by tag.', { validity: 'Replaced', replacedBy: 'ref_search', refines: ['ref_goal'] });
  ref('ref_sync', 'Area', 'Sync', 'Later.', { validity: 'Deferred', refines: ['ref_goal'] });
  ref('ref_dec1', 'Decision', 'DEC-1 No accounts', 'No accounts in v1.', { quote: 'No accounts in v1' });
  ref('ref_bound', 'Boundary', 'Not in v1: sharing', 'Sharing is out.');
  ref('ref_prop', 'Requirement', 'REQ-9 Offline mode', 'Work offline.', { validity: 'Proposed', refines: ['ref_search'] });
  store.threads.put({ id: 'thread_t2', projectId: project.id, title: 'Search index', ids: ['T-2'], doing: 'Build the full-text index.', changed: 'Scope narrowed to notes only.', results: 'Index builds; 80 ms on 10k notes.', unresolved: 'Speed target of 50 ms not met.', executionFacts: [{ id: 'st1', type: 'Observed', text: 'Benchmark: 80 ms for 10k notes.', sourceIds: [s.id] }], qcFacts: [{ id: 'st2', type: 'Observed', text: 'QC: one placeholder test.', sourceIds: [s.id] }], factRecordIds: [], serves: [{ referenceId: 'ref_search', claim: 'makes search fast', basis: 'Explicit' }], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution: role, inputs, asOf: now, updatedAt: now, pendingSourceIds: [] });
  store.areas.put({ id: 'area_search', projectId: project.id, referenceId: 'ref_search', effectNow: 'Index exists; speed target not met.', gaps: 'REQ-2 unverified.', contributions: [{ threadId: 'thread_t2', claim: 'makes search fast', basis: 'Explicit' }], inputs, asOf: now, updatedAt: now, pendingSourceIds: [] });
  store.marks.put({ id: 'mark_1', projectId: project.id, kind: 'Suspected stale', targetId: 'thread_t2', clueSourceIds: [s.id], clue: 'PLAN.md still lists T-3', since: now, noteId: null, closed: null });
  store.marks.put({ id: 'mark_2', projectId: project.id, kind: 'Undocumented decision', targetId: 'ref_dec1', clueSourceIds: [s.id], clue: 'said in a session', since: now, noteId: null, closed: null });
  store.changes.put({ id: 'chg_1', projectId: project.id, at: '2026-09-10T10:00:00.000Z', atSource: 'material', material: 'Decision', effect: 'Replaced', title: 'DEC-2: search replaces the tag browser', summary: 'The tag browser is replaced by search.', before: 'Tag browser', after: 'Search', sourceIds: [s.id], by: owner, affects: ['ref_tags', 'ref_search'], propagation: [{ nodeId: 'thread_t2', state: 'Still on old understanding', sourceOrReason: 'PLAN.md', updatedAt: now }], segment: null, createdInJobId: null, updatedAt: now });
  store.judgements.put({ id: 'jdg_1', projectId: project.id, jobId: 'x', at: now, scope: { kind: 'project', ids: [], label: 'p' }, inputs: { referenceIds: [], threadIds: [], areaIds: [], relationIds: [], keyEvidenceSourceIds: [], conflictingSourceIds: [], previousNoteIds: [], investigations: [] }, excluded: [], outcome: { noteIds: ['note_1'], assessments: [], reconsideredOnly: false } });
  store.notes.put({ id: 'note_1', projectId: project.id, mount: { kind: 'node', ids: ['thread_t2'] }, status: 'Current', ownerResponse: null, versions: [{ version: 1, at: now, title: 'Search speed is claimed, not shown', preview: 'Only a placeholder test.', body: { currentView: 'Verification is missing.', whyItMatters: null, facts: [{ text: 'one empty test', sourceIds: [s.id], inferred: false }], otherExplanations: null, keepAdjust: 'Keep T-2; add a benchmark.', whatWouldSettleIt: null }, ask: 'For your decision', judgementRecordId: 'jdg_1', reason: 'first' }], discussion: [], followUps: [], author: { agent: 'pi', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, language: 'en', updatedAt: now });
  store.requests.put({ id: 'req_1', projectId: project.id, holder: 'Worker', what: 'Rename T-3 in PLAN.md', why: 'DEC-2', basisSourceIds: [s.id], impact: ['thread_t2'], noteId: 'note_1', at: now, handled: null });
  deriveGraph(store, project);
  store.setCoverage({ ...store.coverage, scopes: store.coverage.scopes.map((x) => ({ ...x, coverage: 'Up to date', asOf: now, commit: null, pending: [] })) });
  return { app, project, store, projectDir };
}

test('start and work contexts follow the grading and emphasis rules and are deterministic', async () => {
  const { app, project, store, projectDir } = await seed();
  try {
    const opts = contextOptions(store, project);
    assert.ok(opts.forWork.some((o) => o.kind === 'area' && o.label === 'Search'));
    assert.ok(opts.forWork.some((o) => o.kind === 'work' && o.label === 'T-2 Search index'));
    assert.deepEqual(opts.recipients, ['Incoming agent']);

    const start = assembleContext(store, project, { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null }, 'Idle');
    const md = start.markdown;
    assert.match(md, /^# Context for Incoming agent · Project: Notesy · Kind: Implement/);
    assert.match(md, /## Purpose[\s\S]*Capture fast[\s\S]*Owner’s words: “two seconds, no dialog”/);
    assert.match(md, /## Current direction[\s\S]*DEC-1 No accounts[\s\S]*not yet written into the project documents/, 'Undocumented decision goes in the body with a note');
    // A map (D52; CKC-12 AC-18, AC-32): first what the assets hold and how much of it is here, then each area with its
    // area understanding, then the work of the areas in focus one line each, from the fixed fields. What a work item is
    // doing is in its work context; `Up to date` is a normal state and is not written (D59).
    assert.match(md, /## Relevant work\nThis pack against what the assets hold:\n- Areas: 1 of 1 listed/);
    assert.match(md, /- \*\*Search\*\* · `ref_search` · serves Capture fast · work: In progress 1\n {2}Now: Index exists; speed target not met\.\n {2}Still missing: REQ-2 unverified\./, 'every area carries its area understanding');
    assert.doesNotMatch(md, /Up to date/, 'the normal coverage state is not written');
    assert.match(md, /\n {2}- \*\*T-2 Search index\*\* · `thread_t2` · In progress · held by Worker — Suspected stale \(`mark_1`\): PLAN\.md still lists T-3/, 'a mark on the map is on its row, saying what differs');
    assert.doesNotMatch(md, /Build the full-text index/, 'no work detail on the map');
    assert.match(md, /## Who is doing what[\s\S]*T-2 Search index \(`thread_t2`\): Worker \(w1\)/);
    assert.match(md, /## Do not revive[\s\S]*Tag browser \(`ref_tags`\): replaced by Search \(`ref_search`\)/);
    assert.match(md, /## Not in current scope[\s\S]*Sync/);
    assert.match(md, /## Pending owner decisions[\s\S]*Proposed: REQ-9 Offline mode[\s\S]*For the owner’s decision: Search speed/);
    assert.match(md, /## Notes for you[\s\S]*Search speed is claimed, not shown \(`note_1` · For your decision\)/, 'each note carries the id its full text is fetched with');
    // An object that is on the map carries what it has not followed on its own row, not in a list at the end (D59).
    assert.match(md, /`thread_t2` · In progress[^\n]*Still on old understanding: has not followed “DEC-2[^”]*” \(`chg_1`\) — PLAN\.md/);
    assert.doesNotMatch(md.slice(md.indexOf('## Freshness')), /mark_1|Still on old understanding/, 'what is on a map row is not repeated in Freshness');
    assert.match(md, /## Explore further[\s\S]*pk ask --project/);
    assert.match(md, /## Sources\n\[1\] `src_[0-9a-f]+` Product/, 'every source is named by its id');
    assert.doesNotMatch(md, /sk-secret/, 'credential values never appear');
    assert.doesNotMatch(md, /Tag browser: Browse by tag/, 'replaced content is not in the body');
    assert.doesNotMatch(md, /Work: /, 'start context has no work header');
    assert.doesNotMatch(md, /\n## [^\n]+\n\n## /, 'no empty sections');

    const work = assembleContext(store, project, { scope: { kind: 'work', ids: ['thread_t2'] }, purpose: 'Work', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null }, 'Idle');
    const w = work.markdown;
    assert.match(w, /^# Context for Incoming agent · Work: T-2 Search index · Kind: Implement/);
    assert.match(w, /## Serves[\s\S]*Search \(`ref_search`\): makes search fast[\s\S]*Why now: Replaced/);
    assert.match(w, /## Relation map[\s\S]*Capture fast → Search → \*\*Search index\*\*/);
    assert.match(w, /## Not included[\s\S]*Not in v1: sharing/);
    assert.match(w, /## Existing results[\s\S]*80 ms/);
    assert.match(w, /## Known results & failures[\s\S]*Changed on the way: Scope narrowed[\s\S]*Observed: Benchmark[\s\S]*QC: one placeholder test/);
    assert.match(w, /## Open problems[\s\S]*Speed target/);
    assert.doesNotMatch(w, /## Purpose/, 'work context does not repeat the start sections');

    const discuss = assembleContext(store, project, { scope: { kind: 'work', ids: ['thread_t2'] }, purpose: 'Work', kind: 'Discuss product', recipient: 'Incoming agent', lastSessionAt: null }, 'Idle');
    assert.doesNotMatch(discuss.markdown, /## Known results & failures/, 'Discuss product skips execution failures');
    assert.match(discuss.markdown, /## Notes for you[\s\S]*Keep\/adjust: Keep T-2/);

    const worker = assembleContext(store, project, { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Worker', lastSessionAt: null }, 'Idle');
    assert.match(worker.markdown, /Modification request for Worker: Rename T-3/);
    const orchestrator = assembleContext(store, project, { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Plan', recipient: 'Execution orchestrator', lastSessionAt: null }, 'Idle');
    // An orchestrator's map rows carry the product effect each piece of work serves (Spec §7.3).
    assert.match(orchestrator.markdown, /`thread_t2` · In progress[^\n]*effect: Search — makes search fast/);

    const again = assembleContext(store, project, { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null }, 'Idle');
    assert.equal(again.markdown, md, 'same input, same content');

    const k = knownPart(store, 'How fast is search?');
    assert.ok(k.hits > 0 && /Search index/.test(k.text) && /Sources:/.test(k.text));
    assert.equal(resolveProject(app.workspace.list(), join(projectDir, 'sub', 'dir'))?.id, project.id);
    assert.equal(resolveProject(app.workspace.list(), tmpdir()), null);
  } finally { app.stopAll(); }
});

/**
 * The Freshness line says what the repository's head actually is in the assets (CKC-12 AC-28). A home that does not
 * watch the project has no pending commits, and the head used to go unmentioned as if it were covered.
 */
test('Freshness says whether the head commit is read and organized, never by default', async () => {
  const { app, project, store } = await seed();
  try {
    const head = 'abc1234567890abcdef1234567890abcdef123456';
    const ask = () => assembleContext(store, project, { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null }, 'Idle').markdown;
    store.setCoverage({ ...store.coverage, scopes: store.coverage.scopes.map((x) => ({ ...x, commit: head, pending: [] })) });
    assert.match(ask(), /at commit abc1234567, not read into the assets yet\./, 'a head nobody read is not called organized');

    const now = '2026-09-16T10:00:00.000Z';
    const commitSource = { id: 'src_head', projectId: project.id, anchor: { kind: 'commit' as const, repo: 'r', commit: head }, title: 'the head commit', label: head.slice(0, 10), excerpt: 'x', ids: [], scopeItemId: store.sources.all()[0]!.scopeItemId, availability: 'Available' as const, usedAs: null, usedAsBy: null, version: { readAt: now, fingerprint: 'f', commit: head }, hasCredential: false, lineStart: null, lineEnd: null };
    store.sources.put(commitSource as unknown as Parameters<typeof store.sources.put>[0]);
    assert.match(ask(), /at commit abc1234567, read but not organized yet\./);

    store.sources.put({ ...commitSource, usedAs: 'Code', usedAsBy: 'keeper' } as unknown as Parameters<typeof store.sources.put>[0]);
    assert.match(ask(), /at commit abc1234567, organized\./);
  } finally { app.stopAll(); }
});
