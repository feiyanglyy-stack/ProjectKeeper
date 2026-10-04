// The bottom strip, one line per item (Spec §6.2; CKC-09 AC-38, AC-1), and the drawer that holds it (D100): how the four slots of a row — mark · one sentence
// · object · time — are taken from an item of /overview, which marks stand for which words, and what the header of
// `Notes (attention)` says about the notes that are not in it (D50). Pure, so checked here without a browser;
// scripts/ui-s3-check.mjs measures the rows on the real page. The interface is plain ES modules, loaded at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-explicit-any */
const rows: any = await import(new URL('../../ui/strip-rows.js', import.meta.url).href);

const node = (id: string, label: string) => ({ id, kind: 'node', label });
const note = (over: Record<string, unknown> = {}) => ({ kind: 'note', id: 'note_a', label: 'The acceptance of Capture has no owner judgement yet', detail: 'T-1 and T-2 are Done…', ask: 'For your decision', at: '2026-09-21T10:00:00.000Z', object: { kind: 'node', objects: [node('ref_capture', 'A1 · Capture')] }, cameFrom: { kind: 'Product re-look', jobKind: 'Product re-look', changes: [] }, ...over });

// ── Notes (attention) ────────────────────────────────────────────────────
test('a note: what it asks and how it came about are its leading marks, then its title, the object it hangs on, and when it was written', () => {
  const r = rows.attentionRow(note());
  assert.equal(r.key, 'note:note_a');
  assert.deepEqual(r.marks.map((m: any) => [m.glyph, m.tone, m.title]), [['‼', 'decide', 'For your decision'], ['R', 'origin', 'Came from: Product re-look']]);
  assert.equal(r.text, 'The acceptance of Capture has no owner judgement yet');
  assert.deepEqual(r.object, { text: 'A1 · Capture', title: 'A1 · Capture' });
  assert.equal(r.time, '2026-09-21T10:00:00.000Z');
  assert.equal(r.noteId, 'note_a');
});

test('the three asks are three marks, the one that waits for a decision the strongest; the four origins are four marks', () => {
  const asks = ['For your decision', 'Worth discussing', 'For information'].map((ask) => rows.attentionRow(note({ ask, cameFrom: null })).marks);
  assert.deepEqual(asks.map((m: any) => m.length), [1, 1, 1], 'no origin recorded: no origin mark');
  assert.deepEqual(asks.map((m: any) => m[0].tone), ['decide', 'discuss', 'info']);
  assert.equal(new Set(asks.map((m: any) => m[0].glyph)).size, 3);
  const origins = ['Product re-look', 'Change follow-up', 'Investigation', 'Owner question'].map((kind) => rows.attentionRow(note({ cameFrom: { kind, changes: [] } })).marks[1]);
  assert.equal(new Set(origins.map((m: any) => m.glyph)).size, 4);
  assert.ok(origins.every((m: any) => m.tone === 'origin'));
  // A change follow-up names the changes it is about in the hover, as the tag did.
  const followUp = rows.attentionRow(note({ cameFrom: { kind: 'Change follow-up', changes: [{ id: 'c1', title: 'DEC-2 replaced the tag browser' }, { id: 'c2', title: 'Search moved' }] } })).marks[1];
  assert.equal(followUp.title, 'Came from: Change follow-up — DEC-2 replaced the tag browser; Search moved');
});

test('the object slot names what a note hangs on: one object, the first of several with how many more, a relation by its ends, or the whole project', () => {
  const path = rows.attentionRow(note({ object: { kind: 'path', objects: [node('t1', 'T-18 Search index'), node('t2', 'T-19 Tokenizer'), node('t3', 'T-20 Filters')] } })).object;
  assert.deepEqual(path, { text: 'T-18 Search index +2', title: 'T-18 Search index\nT-19 Tokenizer\nT-20 Filters' });
  const rel = rows.attentionRow(note({ object: { kind: 'relation', objects: [{ id: 'r1', kind: 'relation', label: 'verifies: Benchmark → REQ-S1' }] } })).object;
  assert.equal(rel.text, 'verifies: Benchmark → REQ-S1');
  assert.deepEqual(rows.attentionRow(note({ object: { kind: 'project', objects: [] } })).object, { text: 'Whole project', title: 'Whole project' });
  // An overview written before the slot existed: the row still stands, the slot is empty.
  assert.deepEqual(rows.attentionRow(note({ object: undefined, at: undefined })).object, { text: '', title: '' });
  assert.equal(rows.attentionRow(note({ object: undefined, at: undefined })).time, null);
});

test('what is not a note has a mark of its own: a scope question, a finished request, a Follow up result', () => {
  const q = rows.attentionRow({ kind: 'scope-question', id: 'sq1', label: 'Is docs/notes.md working material?', detail: 'It changes what is read', ask: 'For your decision', at: null, object: { kind: 'scope', objects: [] } });
  const job = rows.attentionRow({ kind: 'job', id: 'job1', label: 'Done: update TASKS.md', detail: 'Updated', ask: 'For information', at: '2026-09-21T09:00:00.000Z', object: { kind: 'request', objects: [] } });
  const round = rows.attentionRow({ kind: 'round', id: 'round_1', label: 'Follow up round 1: 2 objects still on the old understanding', detail: '…', ask: 'For information', at: '2026-09-21T08:00:00.000Z', object: { kind: 'round', objects: [] } });
  assert.deepEqual([q, job, round].map((r: any) => r.marks.length), [1, 1, 1]);
  assert.equal(new Set([q, job, round].map((r: any) => r.marks[0].glyph)).size, 3);
  assert.deepEqual([q, job, round].map((r: any) => r.marks[0].title), ['Scope question · For your decision', 'Request finished · For information', 'Follow up result · For information']);
  assert.equal(q.marks[0].tone, 'decide', 'a scope question waits for the owner’s decision, like a note that does');
  assert.deepEqual([q.object.text, job.object.text, round.object.text], ['Project scope', 'Your request', 'Change follow-up']);
  assert.deepEqual([q.key, job.key, round.key], ['scope-question:sq1', 'job:job1', 'round:round_1']);
  assert.equal(q.time, null);
  assert.equal(q.noteId, null);
  // None of their glyphs is a note's.
  const noteGlyphs = new Set(['For your decision', 'Worth discussing', 'For information'].map((ask) => rows.attentionRow(note({ ask })).marks[0].glyph));
  assert.ok([q, job, round].every((r: any) => !noteGlyphs.has(r.marks[0].glyph)));
});

test('a Follow up result with news names the objects its news is about in the object slot; the mark and the sentence stay a Follow up result’s (CKC-07 AC-27)', () => {
  const news = { breakpoints: [], sendbacks: [], sixThings: [], patches: [], notes: [], nothingNew: false, statement: '1 breakpoint newly lit', complete: true };
  const withNews = rows.attentionRow({ kind: 'round', id: 'round_0002', label: 'Follow up round 3: 1 breakpoint newly lit', detail: '…', ask: 'For information', at: '2026-09-21T08:00:00.000Z', object: { kind: 'round', objects: [node('t18', 'T-18 Search index'), node('terr_sync', 'Sync (deferred)')] }, news });
  assert.deepEqual(withNews.object, { text: 'T-18 Search index +1', title: 'T-18 Search index\nSync (deferred)' });
  assert.deepEqual([withNews.marks[0].glyph, withNews.marks[0].title, withNews.text], ['↻', 'Follow up result · For information', 'Follow up round 3: 1 breakpoint newly lit']);
  // News about nothing the workbench can name still says where it belongs.
  const unplaced = rows.attentionRow({ kind: 'round', id: 'round_0003', label: 'Follow up round 4: 1 note written or updated', detail: '…', ask: 'For information', at: null, object: { kind: 'round', objects: [] }, news });
  assert.equal(unplaced.object.text, 'Change follow-up');
});

// ── Recent changes ───────────────────────────────────────────────────────
const change = (over: Record<string, unknown> = {}) => ({ id: 'chg_1', at: '2026-09-19T10:30:00.000Z', effect: 'Completed', title: 'Search benchmark: first query 812 ms', removed: [], items: [{ title: 'a' }], work: { kind: 'Execution', label: 'bench.js --case search' }, ...over });

test('a piece of work: its kind is the mark, then the work and how many changes it made, and the time', () => {
  const r = rows.changeRow(change());
  assert.equal(r.key, 'change:chg_1');
  assert.deepEqual(r.marks.map((m: any) => [m.glyph, m.tone, m.title]), [['E', 'work', 'Execution']]);
  assert.equal(r.text, 'bench.js --case search');
  assert.deepEqual(r.object, { text: '1 change', title: '1 change' });
  assert.equal(r.time, '2026-09-19T10:30:00.000Z');
  assert.equal(rows.changeRow(change({ items: [{}, {}, {}] })).object.text, '3 changes');
  assert.equal(rows.changeRow(change({ items: [] })).object.text, '1 change', 'a piece of work with no items listed is its own single change');
  const kinds = ['Session', 'Execution', 'Time range'].map((kind) => rows.changeRow(change({ work: { kind, label: 'x' } })).marks[0].glyph);
  assert.equal(new Set(kinds).size, 3);
});

test('a record from before pieces of work: its effect is the mark and its title the sentence', () => {
  const r = rows.changeRow(change({ work: null, items: undefined, effect: 'Approved', title: 'DEC-4: reader themes use system fonts' }));
  assert.deepEqual(r.marks.map((m: any) => [m.tone, m.title]), [['good', 'Approved']]);
  assert.equal(r.text, 'DEC-4: reader themes use system fonts');
  assert.deepEqual(r.object, { text: '', title: '' });
  const effects = ['Added', 'Approved', 'Replaced', 'Deferred', 'Abandoned', 'Completed', 'Corrected', 'Removed'];
  const marks = effects.map((effect) => rows.changeRow(change({ work: null, effect })).marks[0]);
  assert.equal(new Set(marks.map((m: any) => m.glyph)).size, effects.length, 'every effect has a mark of its own');
  assert.deepEqual(marks.map((m: any) => m.tone), ['good', 'good', 'bad', 'wait', 'bad', 'good', 'plain', 'plain'], 'the colours the effect tags had');
});

test('a change that removed objects says so on its row: a mark whose hover names them', () => {
  const r = rows.changeRow(change({ removed: [{ id: 'a', label: 'REQ-X9 · v1 sync prototype' }, { id: 'b', label: 'T-40 sync' }] }));
  assert.deepEqual(r.marks.map((m: any) => m.glyph), ['E', '−']);
  assert.equal(r.marks[1].title, 'Removed: REQ-X9 · v1 sync prototype, T-40 sync');
  assert.equal(r.marks[1].tone, 'bad');
});

// ── Since last visit ─────────────────────────────────────────────────────
test('Since last visit: work that moved, changes and new notes, one row each, in that order', () => {
  const s = {
    since: '2026-09-20T08:00:00.000Z', jobs: 8, failed: 1,
    threads: [{ id: 't1', title: 'Result ranking', progress: 'Done', updatedAt: '2026-09-21T11:00:00.000Z' }, { id: 't2', title: 'Saved searches', progress: 'Planned', updatedAt: '2026-09-21T10:00:00.000Z' }],
    changes: [{ id: 'c1', title: 'Owner asked for Chinese search', effect: 'Added', at: '2026-09-21T09:00:00.000Z' }],
    notes: [{ id: 'n1', title: 'Search speed is a placeholder', ask: 'Worth discussing', at: '2026-09-21T08:30:00.000Z', object: { kind: 'node', objects: [node('t9', 'T-18 Search index')] } }],
  };
  const out = rows.sinceRows(s);
  assert.deepEqual(out.map((r: any) => r.key), ['work:t1', 'work:t2', 'change:c1', 'note:n1']);
  assert.deepEqual(out[0].marks.map((m: any) => [m.tone, m.title]), [['work', 'Work · Done']]);
  assert.notEqual(out[0].marks[0].glyph, out[1].marks[0].glyph, 'progress tells the marks apart');
  assert.deepEqual([out[0].text, out[0].object.text, out[0].time], ['Result ranking', 'Done', '2026-09-21T11:00:00.000Z']);
  assert.deepEqual(out[0].opens, { kind: 'node', id: 't1', label: 'Result ranking' }, 'a row that is an object opens that object');
  assert.deepEqual([out[2].marks[0].title, out[2].text, out[2].time], ['Added', 'Owner asked for Chinese search', '2026-09-21T09:00:00.000Z']);
  assert.deepEqual([out[3].marks[0].title, out[3].object.text, out[3].noteId], ['Worth discussing', 'T-18 Search index', 'n1']);
  assert.deepEqual(rows.sinceRows(null), []);
});

test('Since last visit sums up each Follow up round first, one row each, the same row as in Notes (attention) (QC AH #11)', () => {
  const news = { breakpoints: [], sendbacks: [], sixThings: [], patches: [], notes: [], nothingNew: false, statement: '1 breakpoint newly lit', complete: true };
  const quiet = { ...news, nothingNew: true, statement: 'Follow up round 6 found nothing new' };
  const round3 = { kind: 'round', id: 'round_0002', label: 'Follow up round 5: 1 breakpoint newly lit', detail: '…', ask: 'For information', at: '2026-09-21T08:00:00.000Z', object: { kind: 'round', objects: [node('t18', 'T-18 Search index')] }, news, roundName: 'Follow up round 5', seen: true };
  const round4 = { kind: 'round', id: 'round_0003', label: 'Follow up round 6: found nothing new', detail: '', ask: 'For information', at: '2026-09-22T08:00:00.000Z', object: { kind: 'round', objects: [] }, news: quiet, roundName: 'Follow up round 6', seen: false };
  const out = rows.sinceRows({ since: '2026-09-20T12:00:00.000Z', jobs: 2, failed: 0, rounds: [round3, round4], threads: [{ id: 't1', title: 'Result ranking', progress: 'Done', updatedAt: '2026-09-21T11:00:00.000Z' }], changes: [], notes: [] });
  assert.deepEqual(out.map((r: any) => r.key), ['round:round_0002', 'round:round_0003', 'work:t1'], 'the rounds first, in the order they ended');
  assert.deepEqual(out[0], rows.attentionRow(round3), 'the row Notes (attention) gives the round, opened or not');
  assert.deepEqual([out[0].marks[0].title, out[0].text, out[0].object.text, out[0].time, out[0].opens], ['Follow up result · For information', 'Follow up round 5: 1 breakpoint newly lit', 'T-18 Search index', '2026-09-21T08:00:00.000Z', null], 'it opens in place, as a Follow up result does');
  assert.deepEqual([out[1].text, out[1].object.text], ['Follow up round 6: found nothing new', 'Change follow-up']);
  assert.deepEqual(rows.sinceRows({ since: 'x', jobs: 0, failed: 0, threads: [], changes: [], notes: [] }), [], 'an overview from before rounds were summed up here');
});

// ── The header of Notes (attention) (D50; CKC-09 AC-1) ───────────────────
const overviewOf = (needsYou: any[], noteCounts: any) => ({ needsYou, noteCounts });
const items = (notes: number, questions: number, jobs: number, rounds: number) => [
  ...Array.from({ length: notes }, (_, i) => ({ kind: 'note', id: `n${i}` })), ...Array.from({ length: questions }, (_, i) => ({ kind: 'scope-question', id: `q${i}` })),
  ...Array.from({ length: jobs }, (_, i) => ({ kind: 'job', id: `j${i}` })), ...Array.from({ length: rounds }, (_, i) => ({ kind: 'round', id: `r${i}` })),
];

test('the header says, in sight, why fewer notes are here than exist, and counts what is not a note apart', () => {
  const head = rows.attentionHeader(overviewOf(items(6, 1, 2, 1), { current: 10, asking: 7, information: 3, answered: 1 }));
  assert.equal(head.count, '6 of 10 notes');
  assert.equal(head.why, 'Not here: 3 for information · 1 answered');
  assert.equal(head.also, 'Also here: 1 scope question · 2 requests done · 1 Follow up result');
  assert.match(head.hint, /6 of the project's 10 current notes wait on you/);
  assert.match(head.hint, /3 are for information only and 1 you have already answered/);
  assert.match(head.hint, /Notes log has all of them/);
  assert.match(head.hint, /1 unanswered scope question/);
  assert.match(head.hint, /2 requests you gave finished/);
  assert.match(head.hint, /1 Follow up result/);
});

test('the header says what a Follow up result is now: one with something new, or one from before rounds counted their news with objects left behind (QC AY package C)', () => {
  const withNews = { kind: 'round', id: 'r_news', news: { nothingNew: false } };
  const head = rows.attentionHeader(overviewOf([...items(1, 0, 0, 0), withNews], { current: 1, asking: 1, information: 0, answered: 0 }));
  assert.equal(head.also, 'Also here: 1 Follow up result');
  assert.match(head.hint, /1 Follow up result with something new\./);
  assert.doesNotMatch(head.hint, /from before rounds/);
  assert.doesNotMatch(head.hint, /something for you to settle/, 'the old words are gone');
  const both = rows.attentionHeader(overviewOf([...items(0, 0, 0, 2), withNews], null));
  assert.equal(both.also, 'Also here: 3 Follow up results');
  assert.match(both.hint, /1 Follow up result with something new\. 2 Follow up results from before rounds counted what they found new, with objects still on the old understanding\./);
});

test('the note number never takes in what is not a note, and the sentence leaves out what there is none of', () => {
  const head = rows.attentionHeader(overviewOf(items(2, 0, 0, 3), { current: 2, asking: 2, information: 0, answered: 0 }));
  assert.equal(head.count, '2 of 2 notes');
  assert.equal(head.why, '', 'every note is here: nothing to explain');
  assert.equal(head.also, 'Also here: 3 Follow up results');
  const one = rows.attentionHeader(overviewOf(items(1, 1, 1, 0), { current: 5, asking: 1, information: 4, answered: 0 }));
  assert.deepEqual([one.count, one.why, one.also], ['1 of 5 notes', 'Not here: 4 for information', 'Also here: 1 scope question · 1 request done']);
  // An overview without the counts (an older server): the number of notes here, and no claim about the rest.
  const old = rows.attentionHeader(overviewOf(items(3, 0, 0, 0), null));
  assert.deepEqual([old.count, old.why, old.also], ['3 notes', '', '']);
  assert.deepEqual(rows.attentionHeader(overviewOf([], null)).count, '');
});

// ── The drawer and the ❓ on objects (Spec §6.1, §6.2; D100; CKC-09 AC-38) ─────────────────────────────────────────
const onNode = note({ id: 'n_node' });
const onRelation = note({ id: 'n_rel', object: { kind: 'relation', objects: [{ id: 'r1', kind: 'relation', label: 'verifies: Benchmark → REQ-S1' }] } });
const onPath = note({ id: 'n_path', object: { kind: 'path', objects: [node('t1', 'T-18'), node('t2', 'T-19')] } });
const onProject = note({ id: 'n_proj', object: { kind: 'project', objects: [] } });
const onGone = note({ id: 'n_gone', object: { kind: 'node', objects: [] } });
const question = { kind: 'scope-question', id: 'sq1', label: 'Is docs/notes.md working material?', object: { kind: 'scope', objects: [] } };
const round = { kind: 'round', id: 'round_1', label: 'Follow up round 1', object: { kind: 'round', objects: [node('t1', 'T-18')] }, news: { nothingNew: false } };
const drawerOv = (over: Record<string, unknown> = {}) => ({ needsYou: [onNode, onRelation, onPath, onProject, onGone, question, round], noteCounts: { current: 9, asking: 6, information: 3, answered: 1 }, recentChanges: [{ id: 'c1' }, { id: 'c2' }], sinceLastVisit: null, ...over });

test('an attention note on a node, a relation or a path is marked ❓ on its objects; the whole project, a note whose objects are gone, and what is not a note stay in the drawer', () => {
  assert.deepEqual(rows.objectAttentionNotes(drawerOv()).map((x: any) => x.id), ['n_node', 'n_rel', 'n_path']);
  assert.deepEqual(rows.drawerAttention(drawerOv()).map((x: any) => x.id), ['n_proj', 'n_gone', 'sq1', 'round_1'], 'nothing with nowhere to be marked is dropped');
  assert.equal(rows.markedOnObjects(round), false, 'a Follow up result names objects but is one item for the round, in the drawer');
  assert.equal(rows.markedOnObjects(note({ object: undefined })), false, 'an overview from before the object slot: listed, as before');
  assert.deepEqual(rows.objectAttentionNotes(undefined), []);
  assert.deepEqual(rows.drawerAttention({}), []);
});

test('the drawer line counts its own rows, the recent changes, whether there is a Since last visit, and the ❓ on objects apart', () => {
  assert.deepEqual(rows.drawerSummary(drawerOv()), { attention: 4, changes: 2, since: false, onObjects: 3 });
  assert.equal(rows.drawerSummary(drawerOv({ sinceLastVisit: { since: 'x' } })).since, true, 'only when the overview has one: it has none without a meaningful change');
  // CE's list of the notes on objects takes the place of the rule when it is given (the seam).
  assert.equal(rows.drawerSummary(drawerOv(), [onNode]).onObjects, 1);
  assert.deepEqual(rows.drawerSummary(null), { attention: 0, changes: 0, since: false, onObjects: 0 });
});

test('pressed, the ❓ count shows each note’s objects: a node, a relation by its two ends, every object of a path, each once', () => {
  const relations = [{ id: 'r1', from: 'bench', to: 'req_s1' }];
  assert.deepEqual(rows.attentionTargets(rows.objectAttentionNotes(drawerOv()), relations), ['ref_capture', 'bench', 'req_s1', 't1', 't2']);
  assert.deepEqual(rows.attentionTargets([onRelation], []), [], 'a relation the graph does not have gives no object');
  assert.deepEqual(rows.attentionTargets([onNode, onNode]), ['ref_capture']);
  assert.deepEqual(rows.attentionTargets(undefined), []);
});

test('the header of Notes (attention) says how many more wait on objects, in the reason and in the hover, and the note count is the drawer’s own', () => {
  const head = rows.attentionHeader(drawerOv());
  assert.equal(head.count, '2 of 9 notes', 'the whole-project note and the one whose objects are gone');
  assert.equal(head.why, 'Not here: 3 for information · 1 answered · ❓ 3 on objects');
  assert.equal(head.onObjects, 3);
  assert.match(head.hint, /3 wait on you on their objects, marked ❓ there; press the ❓ count to see only those objects\./);
  assert.equal(head.also, 'Also here: 1 scope question · 1 Follow up result');
  const one = rows.attentionHeader(drawerOv({ needsYou: [onNode] }));
  assert.equal(one.why, 'Not here: 3 for information · 1 answered · ❓ 1 on objects');
  assert.match(one.hint, /1 waits on you on its object/);
  // The count CE gives overrides the rule, and none on objects says nothing about them.
  assert.equal(rows.attentionHeader(drawerOv(), 0).why, 'Not here: 3 for information · 1 answered');
  assert.equal(rows.attentionHeader(overviewOf([onNode], null)).why, 'Not here: ❓ 1 on objects', 'an older server without the counts still says where they are');
});
