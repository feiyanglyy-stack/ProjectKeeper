/**
 * The delivery grading of Spec §7.1 for what Spec v2.8 added (CKC-12 AC-3, AC-35–AC-38) and assets that contradict
 * themselves (Spec §2.4, D43): history and removed objects are never current content, and current work resting on a
 * removed object says so on its row (their lineage is in pack-lineage.test.ts); the project's obsolete rule sends
 * what it withdraws to `Do not revive`; a receipt's claims are said as reported, and where the code says otherwise the
 * row says what the code does; a rule set without the owner is pending the owner's decision while it is in force; a
 * decision carried out is not a to-do; two records that disagree are both written. A work context lists only the
 * changes that bear on its work (Spec §7.4 item 11) and names no shared foundation where no area is shared.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext } from './assemble.ts';
import { ORCHARD_AT, ORCHARD_ID, orchardProject, orchardStore, sectionOf } from './pack-fixture.ts';
import type { ContextRequest } from '../model/types.ts';
import type { WorkKind } from '../model/vocab.ts';
import type { ProjectStore } from '../store/project-store.ts';

const startPack = (store: ProjectStore, lastSessionAt: string | null = null) =>
  assembleContext(store, orchardProject, { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt } as ContextRequest, 'Idle').markdown;
const workPack = (store: ProjectStore, id: string, kind: WorkKind = 'Implement') =>
  assembleContext(store, orchardProject, { scope: { kind: 'work', ids: [id] }, purpose: 'Work', kind, recipient: 'Incoming agent', lastSessionAt: null } as ContextRequest, 'Idle').markdown;

test('history and removed objects are never current content; current work resting on one says so on its row, with when and what took it out (CKC-12 AC-3, AC-35)', () => {
  const store = orchardStore();
  const start = startPack(store);
  const packs = { start, 'start since 2025': startPack(store, '2025-01-01'), 'R-8 work': workPack(store, 'thread_r8'), 'R-7 investigate': workPack(store, 'thread_r7', 'Investigate'), 'A2 area': assembleContext(store, orchardProject, { scope: { kind: 'area', ids: ['ref_a2'] }, purpose: 'Work', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: '2025-01-01' } as ContextRequest, 'Idle').markdown };
  for (const [name, md] of Object.entries(packs)) {
    assert.doesNotMatch(md, /REMOVED-TEXT|HISTORY-ONLY-TEXT/, `${name}: what a removed object or a history-only source says is never given as content`);
    for (const s of ['Purpose', 'Current direction', 'Plan', 'Serves', 'Relation map']) {
      assert.doesNotMatch(sectionOf(md, s), /\*\*REQ-9|\*\*S-1|^- REQ-9|^- S-1|`ref_sync` · |`thread_s1` · /m, `${name} · ${s}: no row of their own`);
    }
    assert.doesNotMatch(sectionOf(md, 'Relevant work'), /^\s*- \*\*(REQ-9|S-1)/m, `${name}: not on the map`);
    assert.doesNotMatch(md, /mark_on_removed|REMOVED-MARK/, `${name}: a mark on a removed object is written nowhere`);
    assert.doesNotMatch(sectionOf(md, 'Do not revive'), /REQ-9|S-1/, `${name}: removed is not replaced or abandoned: it is lineage, not Do not revive`);
  }
  // The current work that rests on removed objects says so on its own row: what it rests on, by id, and when and how it went.
  const removal = '— history: removed from the current version on 2026-09-04 \\(Abandoned: Sync leaves the plan — the co-op server takes no uploads; `chg_sync_gone`\\)';
  assert.match(start, new RegExp(`\`thread_r8\` · Planned[^\\n]*rests on “S-1 · Sync engine” \\(\`thread_s1\`\\) ${removal}`));
  assert.match(start, new RegExp(`\`thread_r8\` · Planned[^\\n]*rests on “REQ-9 · Two-way sync with the co-op server” \\(\`ref_sync\`\\) ${removal}`));
  assert.doesNotMatch(sectionOf(start, 'Plan'), /S-1/, 'a removed work item is nothing a plan waits on');
  const r8 = packs['R-8 work'];
  assert.match(sectionOf(r8, 'Serves'), new RegExp(`It rests on “REQ-9 · Two-way sync with the co-op server” \\(\`ref_sync\`\\) ${removal}`));
  assert.match(sectionOf(r8, 'Relation map'), new RegExp(`R-8 · Send the report to the co-op server rests on “S-1 · Sync engine” \\(\`thread_s1\`\\) ${removal}`));
  // The change that took them out is a change like any other; what it removed is named as removed.
  assert.match(sectionOf(packs['start since 2025'], 'Changes since last session'), /Abandoned · Plan update · \*\*Sync leaves the plan\*\*[\s\S]*?Affects: REQ-9 · Two-way sync with the co-op server \(`ref_sync`, removed from the current version\); S-1 · Sync engine \(`thread_s1`, removed from the current version\)/);
  // History read to mark something current stale: the mark stands, and the history it was checked against is cited as history.
  const hist = /Suspected stale \(`mark_hist_a2`\): The area still speaks of a CSV layout the history shows was dropped \[(\d+)\]/.exec(start);
  assert.ok(hist, 'the mark is on the area’s row, with its citation');
  assert.match(sectionOf(start, 'Sources'), new RegExp(`\\[${hist![1]}\\] \`src_old_export\` Layout — [^\\n]*export-v1\\.md[^\\n]* — history only, not the current version`));
  // What the project's own rule withdraws goes to Do not revive with the rule as its source (§1.15 `Obsolete`).
  const dnr = sectionOf(start, 'Do not revive');
  assert.match(dnr, /DES-2 · First report layout \(`ref_layout1`\): replaced by REQ-3 · The season report lists every inspected tree \(`ref_req3`\)[^\n]*withdrawn by the project’s rule `rule_obsolete`/);
  assert.match(dnr, /The first report layout \(docs\/LAYOUT-v1\.md\) is withdrawn; REQ-3 replaces it \(`rule_obsolete`\)/);
  assert.match(sectionOf(workPack(store, 'thread_r7'), 'Do not revive'), /`rule_obsolete`/, 'the work it bears on carries it too');
});

test('what a receipt claims is said as reported, with who and when; where the code says otherwise the row says what the code does (CKC-12 AC-36)', () => {
  const store = orchardStore();
  const known = sectionOf(workPack(store, 'thread_r7'), 'Known results & failures');
  assert.match(known, /- Reported by Builder, R-7 receipt, 2026-09-10: The counts are exact; nothing is rounded\.[^\n]*does not hold in the code: The code rounds each page’s tree count to the nearest ten before it prints it/);
  assert.match(known, /- Reported by Builder, R-7 receipt, 2026-09-10: The PDF lists every inspected tree with its date\.(?! [^\n]*does not hold)/, 'a claim nobody checked stays a report, with nothing added');
  assert.doesNotMatch(known, /^- Claimed: /m, 'a claim is never written as if it were a fact');
  assert.match(known, /- Observed in the code \(app\/src\/report\/build\.ts, lines 1–6\): The report is built one batch of pages at a time\./);
  // The status that rests on the contradicted claim is marked where the status is: its map row, or Freshness in a work pack.
  assert.match(startPack(store), /`thread_r7` · In progress[^\n]*Suspected stale \(`mark_stale_r7`\): R-7’s progress rests on the receipt’s word/);
  assert.match(sectionOf(workPack(store, 'thread_r7'), 'Freshness'), /Suspected stale \(`mark_stale_r7`\)/);
});

test('a rule a role set without the owner is pending the owner’s decision: in force now, who set it and when, why the owner decides (CKC-12 AC-37)', () => {
  const start = startPack(orchardStore());
  const pending = sectionOf(start, 'Pending owner decisions');
  assert.match(pending, /- Decided without owner, in force now: DEC-4 · Reports are built in batches of 500 trees \(`ref_dec4`\) — set by Lead on 2026-09-08; the owner decides because: The batch size decides what a grower with more than 500 trees gets in one report[^\n]*\(`mark_dwo_dec4`\)/);
  assert.match(pending, /- Decided without owner, in force now: The Checker may skip the review of a one-line fix \(`rule_skip`\) — set by Lead on 2026-09-12; the owner decides because: Skipping a review changes the QC arrangement/);
  // Not written as the owner's decision, and not dropped as if it were not in force.
  const dir = sectionOf(start, 'Current direction');
  assert.match(dir, /\*\*DEC-4 · Reports are built in batches of 500 trees\*\*[^\n]*set by Lead without the owner — see `Pending owner decisions`/);
});

test('a decision already carried out is not a to-do; one partly carried out says what is left (CKC-12 AC-38)', () => {
  const store = orchardStore();
  const dir = sectionOf(startPack(store), 'Current direction');
  assert.match(dir, /\*\*DEC-2 · Inspections save without a network\*\*[^\n]*carried out by I-1 · Save inspections offline \(`thread_i1`\)/);
  assert.match(dir, /\*\*DEC-4 · Reports are built in batches of 500 trees\*\*[^\n]*partly carried out by R-7 · Build the season report \(`thread_r7`\); still left: the summary page still counts all trees in one batch/);
  assert.match(sectionOf(workPack(store, 'thread_r7'), 'Existing results'), /- Carries out DEC-4 · Reports are built in batches of 500 trees \(`ref_dec4`\): partly carried out; still left: the summary page still counts all trees in one batch/);
  assert.match(sectionOf(workPack(store, 'thread_i1'), 'Existing results'), /- Carries out DEC-2 · Inspections save without a network \(`ref_dec2`\): carried out/);
});

test('two records that disagree are both written, and neither is picked (Spec §2.4, D43)', () => {
  const start = startPack(orchardStore());
  assert.match(sectionOf(start, 'Plan'), /\*\*P1 · Field inspections\*\*[^\n]* · Done[^\n]*the records disagree: the plan is recorded as Done, and its work items are In progress 1 · Done 1/);
  const map = sectionOf(start, 'Relevant work');
  assert.match(map, /`thread_i4` · Done[^\n]*the records disagree: I-4 is also I-4 · Photos \(from the hand-over\) \(`thread_i4b`\), Planned/);
  assert.match(map, /`thread_i4b` · Planned[^\n]*the records disagree: I-4 is also I-4 · A photo per tree \(`thread_i4`\), Done/);
  assert.match(sectionOf(start, 'Current direction'), /\*\*DEC-5 · Today’s count on the first screen\*\*[^\n]*the records disagree: it is recorded as carried out by I-5 · Today’s count on the first screen \(`thread_i5`\), which is Planned/);
  assert.match(sectionOf(workPack(orchardStore(), 'thread_i4b'), 'Open problems'), /The records disagree on this work: I-4 is also I-4 · A photo per tree \(`thread_i4`\), Done; this one says Planned/);
});

test('a work context lists the changes that bear on its work, and neither the rest of the project’s nor one a later change superseded (Spec §7.1, §7.4 item 11)', () => {
  const store = orchardStore();
  for (const kind of ['Review', 'Investigate'] as const) {
    const md = assembleContext(store, orchardProject, { scope: { kind: 'work', ids: ['thread_r7'] }, purpose: 'Work', kind, recipient: 'Checker', lastSessionAt: '2026-09-01' } as ContextRequest, 'Idle').markdown;
    const changes = sectionOf(md, 'Changes since last session');
    assert.match(changes, /`chg_dec4`/, `${kind}: a change to this work is listed`);
    assert.match(changes, /`chg_ow_pdf`/, `${kind}: so is the owner’s change to the requirement it serves`);
    assert.doesNotMatch(changes, /`chg_mirror`|`chg_form`|`chg_code_i2`|`chg_done_i1`/, `${kind}: changes to other work stay in the start pack`);
    assert.doesNotMatch(changes, /`chg_round`|rounded to tens/, `${kind}: what a later change superseded for this work is not listed as a change`);
  }
  assert.match(sectionOf(startPack(store, '2026-09-01'), 'Changes since last session'), /`chg_mirror`[\s\S]*`chg_round`|`chg_round`[\s\S]*`chg_mirror`/, 'the start pack still lists the project’s changes');
});

test('the relation map names as shared foundation only work that shares an area with this one (Spec §7.4 item 3)', () => {
  const rel = sectionOf(workPack(orchardStore(), 'thread_i2'), 'Relation map');
  assert.match(rel, /Shared foundation: I-1 · Save inspections offline \(`thread_i1`\) serves A1 · Inspections/, 'work in the same area is named');
  assert.doesNotMatch(rel, /Shared foundation: R-7|Shared foundation: R-8/, 'work that only shares having a plan, in another area, is not');
});

test('a maintained document judged behind shows as behind; a point-in-time record never does — the rule the judging tools apply (Spec §2.10; AC-32)', () => {
  const store = orchardStore();
  const judge = (nodeId: string) => store.propagation.put({
    id: `round_1:${nodeId}`, projectId: ORCHARD_ID, nodeId, roundId: 'round_1', state: 'Still on old understanding', sourceOrReason: 'x',
    covers: [{ changeId: 'chg_dec4', itemId: 'it_dec4' }], followed: [], lacks: [{ changeId: 'chg_dec4', itemId: 'it_dec4', what: 'the build doc does not mention batches' }],
    closed: [], objectUpdatedAt: ORCHARD_AT, jobId: null, at: ORCHARD_AT,
  });
  judge('src_build_doc');   // docs/BUILD.md: a document the project maintains
  judge('src_commit_r7');   // a commit: how things stood then
  const fresh = sectionOf(startPack(store), 'Freshness');
  assert.match(fresh, /Still on old understanding: [^\n]*BUILD\.md[^\n]*\(`src_build_doc`\) has not followed[^\n]*the build doc does not mention batches/);
  assert.doesNotMatch(fresh, /src_commit_r7/, 'a commit never falls behind');
});

test('without a last-session reference point, the recent changes are chiefly the ones that changed the direction (Spec §1.12, §7.3 item 7)', () => {
  const changes = sectionOf(startPack(orchardStore()), 'Changes since last session');
  assert.match(changes, /No last-session reference point was given; the most recent meaningful changes follow in time order — chiefly the decisions and replacements that changed the direction/);
  for (const id of ['chg_dec4', 'chg_photos', 'chg_mirror', 'chg_ow_pdf', 'chg_round']) assert.match(changes, new RegExp(`\`${id}\``), `${id}: a decision, an owner statement or a replacement`);
  assert.doesNotMatch(changes, /`chg_code_r7`/, 'the latest code change gives way to them');
  const dates = [...changes.matchAll(/^- (\d{4}-\d\d-\d\d) · /gm)].map((m) => m[1]!);
  assert.deepEqual(dates, [...dates].sort(), 'in time order');
});

test('decisions that do not fit the start pack’s direction are named by name and id, not left out (Spec §7.1; CKC-12 AC-31)', () => {
  const store = orchardStore();
  for (let i = 1; i <= 12; i++) {
    const n = String(i).padStart(2, '0');
    store.reference.put({ ...store.reference.get('ref_dec2')!, id: `ref_extra_${n}`, name: `DEC-X${n} · Extra decision ${n}`, ids: [`DEC-X${n}`], carryOut: null, asOf: `2026-10-${n}T00:00:00.000Z` });
  }
  const md = startPack(store);
  const dir = sectionOf(md, 'Current direction');
  assert.equal((dir.match(/^- \*\*/gm) ?? []).length, 12, 'twelve in full, the most recent first');
  const rest = /^- Also in force, older — each in full with `pk get <id>`: (.+)$/m.exec(dir);
  assert.ok(rest, dir);
  for (const id of ['ref_dec2', 'ref_dec4', 'ref_dec5', 'ref_bound']) assert.ok(rest![1]!.includes('(`' + id + '`)'), `${id} is named, by id`);
  assert.match(sectionOf(md, 'Relevant work'), /Decisions and boundaries: 12 of 16 in `Current direction` above, most recent first; the others are named at its end/);
});
