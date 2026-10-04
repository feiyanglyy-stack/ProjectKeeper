/**
 * The start-of-work context is a map with pointers (D52; Spec §7.3; CKC-12 AC-18, AC-24, AC-28): areas and work as
 * one line each with their ids and fixed fields, a work item serving two areas listed once, marks written on their
 * row with how to check them now, the rest of the marks indexed in Freshness, numbers that add up, and every source
 * named by its id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { assembleContext } from './assemble.ts';
import { organizingHeld } from '../keeper/held.ts';
import type { EntryMark, Project, ReferenceItem, Source, WorkThread } from '../model/types.ts';

const at = '2026-09-18T00:00:00.000Z';
const project = { id: 'p1', name: 'Demo', roles: [], scope: [], language: 'en', organizingPaused: false } as unknown as Project;
const ref = (id: string, category: string, name: string, refines: string[] = [], ids: string[] = []) =>
  ({ id, projectId: 'p1', category, name, ids, text: `${name} text`, quote: null, basis: 'Explicit', validity: 'Current', progress: null, sourceIds: [], refines, replacedBy: null, asOf: at, updatedAt: at }) as unknown as ReferenceItem;
const thread = (id: string, title: string, areas: string[], progress: string, over: Partial<WorkThread> = {}) =>
  ({ id, title, ids: [], progress, validity: 'Current', doing: `DOING-${id}`, results: `RESULTS-${id}`, unresolved: '', changed: '', serves: areas.map((a) => ({ referenceId: a, claim: '', basis: 'Explicit' })), dependsOn: [], factRecordIds: [], pendingSourceIds: [], attribution: { holder: null, author: { kind: 'unknown', name: null } }, acceptance: null, executionFacts: [], qcFacts: [], updatedAt: at, ...over }) as unknown as WorkThread;

function demoStore(): ProjectStore {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-map-')));
  store.reference.put(ref('ref_goal', 'Goal', 'G1 · Understand the project', [], ['G1']));
  store.reference.put(ref('ref_a', 'Area', 'A1 · First area', ['ref_goal'], ['A1']));
  store.reference.put(ref('ref_b', 'Area', 'A2 · Second area', ['ref_goal'], ['A2']));
  store.reference.put(ref('ref_doc', 'Design', 'Design doc'));
  store.sources.put({ id: 'src_spec1', title: 'Spec §1', anchor: { kind: 'file', path: 'D:\\demo\\SPEC.md', headingPath: ['§1'], lineStart: 1, lineEnd: 9 }, excerpt: 'x', version: { readAt: at, fingerprint: 'sha256:0' }, hasCredential: false } as unknown as Source);
  store.sources.put({ id: 'src_spec2', title: 'Spec §2', anchor: { kind: 'file', path: 'D:\\demo\\SPEC.md', headingPath: ['§2'], lineStart: 10, lineEnd: 19 }, excerpt: 'y', version: { readAt: at, fingerprint: 'sha256:1' }, hasCredential: false } as unknown as Source);
  // shared serves both areas and is in progress: both areas are in focus, and it must be listed once.
  store.threads.put(thread('thread_shared', 'Shared work', ['ref_a', 'ref_b'], 'In progress', { ids: ['W-1'], title: 'W-1 · Shared work', pendingSourceIds: ['src_spec1', 'src_spec2'] }));
  store.threads.put(thread('thread_a', 'Only A', ['ref_a'], 'Done'));
  store.threads.put(thread('thread_b', 'Only B', ['ref_b'], 'Planned'));
  // A mark goes into a pack only when it says what differs and names what it was checked against (D59); `mark_hearsay`
  // has no source to check it against and stays in the assets.
  store.marks.put({ id: 'mark_row', projectId: 'p1', kind: 'Suspected stale', targetId: 'thread_a', clueSourceIds: ['src_spec1'], clue: 'SPEC §1 still asks for the old shape', since: at, noteId: null, closed: null } as EntryMark);
  store.marks.put({ id: 'mark_doc', projectId: 'p1', kind: 'Suspected stale', targetId: 'ref_doc', clueSourceIds: ['src_spec2'], clue: 'the design doc predates SPEC §2', since: at, noteId: null, closed: null } as EntryMark);
  store.marks.put({ id: 'mark_hearsay', projectId: 'p1', kind: 'Suspected stale', targetId: 'thread_b', clueSourceIds: [], clue: '', since: at, noteId: null, closed: null } as EntryMark);
  store.setCoverage({ ...store.coverage, scopes: [{ id: 'project', label: 'Demo', coverage: 'Changes pending', asOf: at, commit: null, pending: [{ kind: 'file', ref: 'a', label: 'a', since: at }, { kind: 'file', ref: 'b', label: 'b', since: at }, { kind: 'session', ref: 'c', label: 'c', since: at }], organizing: [], failed: [], lastRelookAt: null }], pendingByKind: { file: 30, session: 9, commit: 1 } } as never);
  return store;
}

test('the start-of-work context is a map with ids, each work item listed once', () => {
  const md = assembleContext(demoStore(), project, { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null, taskVersion: null }, 'Idle').markdown;
  const map = md.slice(md.indexOf('## Relevant work'), md.indexOf('\n## ', md.indexOf('## Relevant work') + 5));
  assert.match(map, /- \*\*A1 · First area\*\* · `ref_a` · serves G1 · Understand the project · work: In progress 1 · Done 1 · Changes pending/);
  assert.equal(map.split('`thread_shared` · In progress').length - 1, 1, 'the shared work item has one row');
  assert.match(map, /`thread_shared` · In progress · serves A1, A2/, 'its row says which areas it serves');
  assert.match(map, /Also in this area, listed above: W-1 · Shared work \(`thread_shared`, under A1\)/);
  assert.doesNotMatch(md, /DOING-|RESULTS-/, 'what a work item is doing and its results are in its work context, not on the map');
  assert.doesNotMatch(map, /W-1 W-1/, 'a title that starts with its number is not prefixed again');
  // Marks on a row are written there by kind and id; Update pending names the documents. How to check a mark now and
  // when waiting material is organized is the same for every mark, so it is said once, above the map (2026-09-18
  // trial: the same sentence on every row).
  assert.match(map, /`thread_shared` · In progress · serves A1, A2 — Update pending: SPEC\.md \(`src_spec1`, 2 parts\)/);
  assert.match(map, /`thread_a` · Done — Suspected stale \(`mark_row`\): SPEC §1 still asks for the old shape \[\d\]/, 'a mark says what differs and cites what it was checked against');
  assert.doesNotMatch(md, /mark_hearsay/, 'a mark with nothing to check it against is not written into the pack');
  // The map opens by saying what the assets hold and how much of it is here, so an agent knows whether this pack is
  // complete without fetching every object to find out (D59; CKC-12 AC-18).
  assert.match(map, /^## Relevant work\nThis pack against what the assets hold:\n- Areas: 2 of 2 listed below, each with its area understanding\.\n- Work items: 3 of 3 listed[^\n]*`pk get <area id>`[^\n]*\n- Entry marks: 2 of 3 open marks are written into this pack — 1 on the row of the object they belong to/);
  assert.match(map, /- How to read the marks: each names an id — `pk get <id>` reads it now[^\n]*or ask the Keeper; material that is `Update pending` is organized at the next Follow up/);
  assert.equal(map.split('How to read the marks').length - 1, 1, 'said once');
  const fresh = md.slice(md.indexOf('## Freshness'), md.indexOf('\n## ', md.indexOf('## Freshness') + 5));
  assert.doesNotMatch(fresh, /mark_row/, 'a mark on the map is not repeated in Freshness');
  assert.match(fresh, /- Suspected stale \(`mark_doc`\) on Design doc \(`ref_doc`\): the design doc predates SPEC §2 \[\d\]/, 'a mark off the map is indexed by kind, id, name and what differs');
  // The total and its parts come from the same list.
  assert.match(fresh, /- Unprocessed changes, counted when this pack was generated: 3 \(file 2, session 1\)\./);
  assert.match(md, /`pk get --project p1 <id>`/, 'Explore further says how to fetch by id');
});

test('pausing holds automatic rounds, not a round the owner started', () => {
  assert.equal(organizingHeld({ organizingPaused: false, followUpAt: null, lastRoundAt: null }), false);
  assert.equal(organizingHeld({ organizingPaused: true, followUpAt: null, lastRoundAt: at }), true, 'paused: automatic rounds are held');
  assert.equal(organizingHeld({ organizingPaused: true, followUpAt: '2026-09-18T01:00:00.000Z', lastRoundAt: at }), false, 'Follow up while paused: this round runs');
  assert.equal(organizingHeld({ organizingPaused: true, followUpAt: '2026-09-18T01:00:00.000Z', lastRoundAt: '2026-09-18T02:00:00.000Z' }), true, 'once that round has run out of work the pause holds again');
});
