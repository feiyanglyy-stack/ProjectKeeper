/**
 * `pk get <id>` on an object that is not a pack, a source or a note (Spec §7.10; CKC-12 AC-23): the object's own
 * content whole, its neighbours by name and id only, a change record without its propagation list, and none of the
 * workbench's own bookkeeping. The store here is shaped like the one measured on 2026-09-18, where one reference item
 * came back as 82 KB of raw JSON of which the item itself was about 3%.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { changeRow, nodeDetail } from '../server/graph-view.ts';
import { deriveGraph } from '../keeper/organize/graph.ts';
import { changeBrief, nodeBrief } from './object-brief.ts';
import type { BriefChange, BriefNode } from './object-brief.ts';
import type { ChangeRecord, EntryMark, GraphRelation, Note, Project, ReferenceItem, Source, WorkThread } from '../model/types.ts';

const at = '2026-09-18T00:00:00.000Z';
const project = { id: 'p1', name: 'Demo', roles: [], scope: [], language: 'en', organizingPaused: false } as unknown as Project;
const EXPLANATION = `The area delivers one readable pack. ${'Every sentence of this explanation belongs in the answer, because a cut explanation is what made PRD §4.2 unreadable. '.repeat(6)}`;

/** A reference item with the traffic a real one carries: many changes reaching it, each with a long propagation list. */
function busyStore(): ProjectStore {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-brief-')));
  const src = (i: number) => ({ id: `src_${i}`, projectId: 'p1', title: `SPEC §${i}`, anchor: { kind: 'file', path: 'D:\\demo\\SPEC.md', headingPath: [`§${i}`], lineStart: i, lineEnd: i + 8 }, excerpt: `line ${i} of the spec`, ids: [], usedAs: 'Design', version: { readAt: at, fingerprint: `sha256:${i}` }, hasCredential: false } as unknown as Source);
  for (let i = 0; i < 10; i++) store.sources.put(src(i));
  store.reference.put({ id: 'ref_a', projectId: 'p1', category: 'Area', name: 'A1 · Context for execution agents', ids: ['A1'], text: EXPLANATION, quote: 'the pack has to read like a story', basis: 'Explicit', validity: 'Current', progress: null, sourceIds: ['src_0', 'src_1', 'src_2'], refines: [], replacedBy: null, asOf: at, updatedAt: at } as unknown as ReferenceItem);
  store.areas.put({ id: 'area_a', projectId: 'p1', referenceId: 'ref_a', effectNow: 'One pack is produced end to end.', gaps: 'Nothing checks it against the original yet.', contributions: [], asOf: at, updatedAt: at, pendingSourceIds: [] } as never);
  for (let i = 0; i < 20; i++) {
    store.threads.put({ id: `thread_${i}`, projectId: 'p1', title: `W-${i} · Work ${i}`, ids: [`W-${i}`], doing: `doing ${i}`, changed: '', results: '', unresolved: '', serves: [{ referenceId: 'ref_a', claim: 'serves the area', basis: 'Explicit' }], dependsOn: [], factRecordIds: [], progress: 'Planned', validity: 'Current', replacedBy: null, attribution: { holder: null, author: { kind: 'unknown', name: null } }, executionFacts: [], qcFacts: [], pendingSourceIds: [], asOf: at, updatedAt: at } as unknown as WorkThread);
  }
  // Twenty change records reach the item, each carrying the whole propagation list the workbench keeps.
  for (let c = 0; c < 20; c++) {
    store.changes.put({
      id: `chg_${c}`, projectId: 'p1', at, atSource: 'material', material: 'Decision', effect: 'Replaced', title: `Change ${c}`,
      summary: `What change ${c} did, at the length a real summary runs to. ${'It keeps going for a while. '.repeat(4)}`,
      before: 'the old shape', after: 'the new shape', sourceIds: ['src_0'], by: { author: { kind: 'owner', name: null }, holder: null, identity: 'Decision' },
      affects: ['ref_a', 'thread_3'],
      propagation: Array.from({ length: 20 }, (_, i) => ({ nodeId: `thread_${i}`, state: i === 3 ? 'Still on old understanding' : i % 2 ? 'Updated' : 'Reusable as is', sourceOrReason: i === 3 ? `W-3 still writes the old shape (change ${c})` : 'checked against the document', updatedAt: at })),
      segment: null, createdInJobId: null, updatedAt: at,
    } as unknown as ChangeRecord);
  }
  store.relations.put({ id: 'rel_1', projectId: 'p1', type: 'refines', from: 'ref_a', to: 'ref_a', claim: 'holds the area together', basis: 'Explicit', evidence: { sourceIds: ['src_0'], factRecordIds: [], factsSoFar: 'written' }, assessment: 'Holds', assessedAt: at, assessedInJobId: null, updatedAt: at } as GraphRelation);
  store.marks.put({ id: 'mark_1', projectId: 'p1', kind: 'Suspected stale', targetId: 'ref_a', clueSourceIds: ['src_1'], clue: 'SPEC §1 was rewritten after this was judged', since: at, noteId: null, closed: null } as EntryMark);
  store.notes.put({ id: 'note_1', projectId: 'p1', mount: { kind: 'node', ids: ['ref_a'] }, status: 'Current', ownerResponse: null, versions: [{ version: 1, at, title: 'Is the area still one area?', preview: 'It may have become two.', body: { facts: [] }, ask: 'Worth discussing', judgementRecordId: null, reason: 'first' }], discussion: [], followUps: [], author: { agent: 'pi', model: null }, language: 'en', updatedAt: at } as unknown as Note);
  deriveGraph(store, project);
  return store;
}

test('fetching an object gives its own content whole and its neighbours by id, not the workbench’s raw data', () => {
  const store = busyStore();
  const nodeId = store.nodes.all().find((n) => n.refId === 'ref_a')!.id;
  const detail = nodeDetail(store, project, nodeId)!;
  const brief = nodeBrief(detail as unknown as BriefNode);
  const raw = JSON.stringify(detail, null, 2);

  // The item's own explanation and the owner's words go in whole (AC-31).
  assert.ok(brief.includes(EXPLANATION.trim()), 'the explanation is not cut');
  assert.match(brief, /Owner’s words: “the pack has to read like a story”/);
  assert.match(brief, /^# A1 · Context for execution agents \(A1\) \(`ref_a`\)\nArea\n/);
  assert.match(brief, /## Area understanding\nNow: One pack is produced end to end\.\nStill missing: Nothing checks it against the original yet\./);
  // Neighbours are named, not expanded: one line per change record, note and mark, each with the id that reads it.
  assert.match(brief, /## Change records that reach it \(20\)\n- 2026-09-18 · Replaced · Change 0 \(`chg_0`\)/);
  assert.match(brief, /## Notes on it \(1\)\n- Is the area still one area\? \(`note_1` · Worth discussing\)/);
  assert.match(brief, /## Entry marks on it \(1\)\n- Suspected stale \(`mark_1`\): SPEC §1 was rewritten after this was judged/);
  assert.doesNotMatch(brief, /Still on old understanding|checked against the document/, 'a change record’s propagation list is not carried here');
  assert.doesNotMatch(brief, /What change 3 did/, 'a change record’s own summary is fetched by its id');
  // Normal states and the workbench's own bookkeeping never appear.
  for (const internal of ['trace', 'refKind', 'noEstablishedLink', 'Holds', 'Not assessed', 'Reusable as is']) {
    assert.ok(!brief.includes(internal), `${internal} is workbench-internal or a normal state and is not returned`);
  }
  // The point of the change (D59): what comes back is the object, not the traffic around it.
  assert.ok(brief.length * 10 < raw.length, `the brief (${brief.length} bytes) is under a tenth of the raw detail (${raw.length} bytes)`);
});

test('a change record names what has not followed it and counts the rest', () => {
  const store = busyStore();
  const c = store.changes.get('chg_0')!;
  const brief = changeBrief({ ...c, affectsLabels: [{ id: 'ref_a', label: 'A1 · Context for execution agents' }, { id: 'thread_3', label: 'W-3 · Work 3' }], sources: [{ id: 'src_0', title: 'SPEC §0', label: 'D:\\demo\\SPEC.md › §0' }] } as unknown as BriefChange);
  assert.match(brief, /^# Change 0 \(`chg_0`\)/);
  assert.ok(brief.includes(c.summary.trim()), 'the summary goes in whole');
  assert.match(brief, /Before: the old shape → after: the new shape/);
  assert.match(brief, /## Not followed yet \(1\)\n- W-3 · Work 3 \(`thread_3`\) — W-3 still writes the old shape \(change 0\)/);
  assert.match(brief, /The other 19 object\(s\) this record reached: Reusable as is 10, Updated 9\. Those are the normal states/);
  assert.equal(brief.split('thread_3').length - 1, 2, 'only the object that has not followed is named, on its own line and in Affects');
  assert.doesNotMatch(brief, /thread_(?!3)\d/, 'the other nineteen are counted, not listed');
});

/**
 * An object that has not followed a change is usually not one the change altered, so it is not in `affects`. It used to
 * come back as a bare id, which left the reader to look it up (batch C reported it; fixed in graph-view).
 */
test('an object that has not followed is named even when the change did not alter it', () => {
  const store = busyStore();
  const c = store.changes.get('chg_0')!;
  // thread_7 is reached by the record but not among the objects it changed.
  store.changes.put({ ...c, affects: ['ref_a'], propagation: c.propagation.map((p) => (p.nodeId === 'thread_7' ? { ...p, state: 'Still on old understanding', sourceOrReason: 'W-7 still asks for the old shape' } : p)) });
  const row = changeRow(store, store.changes.get('chg_0')!) as unknown as BriefChange;
  const brief = changeBrief(row);
  assert.match(brief, /- W-7 · Work 7 \(`thread_7`\) — W-7 still asks for the old shape/, 'the other end comes with its name (Spec §7.10)');
  assert.doesNotMatch(brief, /- \(`thread_7`\)|- thread_7 \(/, 'not a bare id');
});

test('a change record gives its piece of work and each net change — what, why, what it changed — naming the removed as removed (Spec §7.10; CKC-12 AC-35)', () => {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-brief-')));
  store.threads.put({ id: 'thread_w1', projectId: 'p1', title: 'W-1 · One-hand form', ids: ['W-1'], doing: '', changed: '', results: '', unresolved: '', serves: [], dependsOn: [], factRecordIds: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution: { holder: null, author: { kind: 'unknown', name: null } }, executionFacts: [], qcFacts: [], pendingSourceIds: [], asOf: at, updatedAt: at } as unknown as WorkThread);
  store.reference.put({ id: 'ref_gone', projectId: 'p1', category: 'Requirement', name: 'REQ-9 · Two-way sync', ids: ['REQ-9'], text: 'gone', quote: null, basis: 'Explicit', validity: 'Removed', progress: null, sourceIds: [], refines: [], replacedBy: null, asOf: at, updatedAt: at } as unknown as ReferenceItem);
  const by = { author: { kind: 'role', name: 'Lead' }, holder: null, identity: 'Artifact' };
  const item = (id: string, effect: string, title: string, summary: string, affects: string[], extra: Record<string, unknown> = {}) => ({ id, at: '2026-09-04', atSource: 'material', material: 'Decision', effect, title, summary, before: null, after: null, sourceIds: [], by, why: null, affects, ...extra });
  store.changes.put({
    id: 'chg_w', projectId: 'p1', at: '2026-09-04', atSource: 'material', material: 'Decision', effect: 'Replaced', title: 'Lead session, 4 Sep', summary: 'Replaced: nine fields to five; Removed: sync',
    before: null, after: null, sourceIds: [], by, affects: ['thread_w1', 'ref_gone'], propagation: [], segment: null, createdInJobId: null, updatedAt: at,
    work: { kind: 'Session', label: 'Lead session, 4 Sep', sessionId: null, startedAt: '2026-09-04', endedAt: '2026-09-04', openEnded: false },
    items: [
      item('it_1', 'Replaced', 'The form goes from nine fields to five', 'Four fields leave the form.', ['thread_w1'], { before: 'nine fields', after: 'five fields', why: 'the field trial took two minutes' }),
      item('it_2', 'Abandoned', 'Sync leaves the plan', 'Two-way sync leaves the plan.', ['ref_gone'], { why: 'the co-op server takes no uploads' }),
    ],
    notJudged: [],
  } as unknown as ChangeRecord);
  const brief = changeBrief(changeRow(store, store.changes.get('chg_w')!) as unknown as BriefChange);
  assert.match(brief, /^# Lead session, 4 Sep \(`chg_w`\)\nChange record of one piece of work · Session: Lead session, 4 Sep · 2026-09-04\n/);
  assert.match(brief, /## Its net changes \(2\)\n- 2026-09-04 · Replaced · Decision · \*\*The form goes from nine fields to five\*\*\n  Four fields leave the form\.\n  Before: nine fields → after: five fields\n  Why: the field trial took two minutes\n  Affects: W-1 · One-hand form \(`thread_w1`\)/);
  assert.match(brief, /- 2026-09-04 · Abandoned · Decision · \*\*Sync leaves the plan\*\*[\s\S]*?Why: the co-op server takes no uploads\n  Affects: REQ-9 · Two-way sync \(`ref_gone`, removed from the current version\)/);
});

test('an object’s sources are its own content: each excerpt whole, however long; a code file only by where it is (Spec §7.10; CKC-12 AC-31, AC-43)', () => {
  const long = `REQ-3: the PDF lists each inspected tree with its date. ${'Every line of the section belongs to the object. '.repeat(20)}`;
  const brief = nodeBrief({
    node: { id: 'ref_req3', label: 'REQ-3', category: 'Requirement', refKind: 'reference', refId: 'ref_req3' },
    reference: { name: 'REQ-3 · Season report', category: 'Requirement', text: 'The PDF lists every tree.' },
    sources: [
      { id: 'src_req3', title: 'REQ-3', label: 'D:/orchard/docs/PRD.md › 3 · Season reports › REQ-3 (L40–L58)', excerpt: `${long.trim()}\nsecond line`, usedAs: 'Requirement' },
      { id: 'src_old', title: 'Layout', label: 'D:/orchard/docs/old/export-v1.md › Layout (L1–L20)', excerpt: 'the v1 export', usedAs: 'History only' },
      { id: 'src_code', title: 'build.ts', label: 'D:/orchard/app/src/report/build.ts (L1–L6)', excerpt: 'export function buildSeasonReport() {}', usedAs: 'Code' },
    ],
  } as unknown as BriefNode);
  assert.ok(long.length > 400);
  assert.ok(brief.includes(`“${long.trim()}\n  second line”`), 'the whole excerpt, its lines kept');
  assert.match(brief, /`src_old` Layout — [^\n]*· history only, not the current version\n  “the v1 export”/);
  assert.match(brief, /`src_code` build\.ts — [^\n]*a code file: open the current version and read it there/);
  assert.doesNotMatch(brief, /buildSeasonReport/, 'no code comes through');
});
