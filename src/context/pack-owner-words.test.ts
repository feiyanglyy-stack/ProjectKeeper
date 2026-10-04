/**
 * D66: a work context opens with the owner's words this work traces up to, word for word, and the adjustments made on
 * the way from those words to this work — who decided each and why (Spec §7.1, §7.4; CKC-12 AC-4, AC-40–AC-42).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext } from './assemble.ts';
import { WORDS, headings, orchardProject, orchardStore, sectionOf } from './pack-fixture.ts';
import type { ContextRequest } from '../model/types.ts';
import type { WorkKind } from '../model/vocab.ts';
import type { ProjectStore } from '../store/project-store.ts';

const workPack = (store: ProjectStore, id: string, kind: WorkKind = 'Implement', recipient = 'Incoming agent') =>
  assembleContext(store, orchardProject, { scope: { kind: 'work', ids: [id] }, purpose: 'Work', kind, recipient, lastSessionAt: null } as ContextRequest, 'Idle').markdown;

test('a work context opens with the owner’s words, whole and word for word, then the adjustments on the way (CKC-12 AC-4, AC-40)', () => {
  const md = workPack(orchardStore(), 'thread_r7');
  const order = headings(md);
  assert.equal(order[0], "Owner's words", 'the first section is the owner’s words');
  assert.equal(order[1], 'Serves', 'Serves, the Keeper’s own summary of the effect, comes after them');
  const ow = sectionOf(md, "Owner's words");
  // Word for word and whole: the two-line statement keeps both lines, with the id of the item and of where it was said.
  assert.ok(ow.includes(WORDS.pdfLine1) && ow.includes(WORDS.pdfLine2), 'the words are copied whole, not paraphrased or cut');
  assert.match(ow, /`ref_ow_pdf`[^\n]*2026-09-06[^\n]*\[\d+\]/, 'each carries its id, when it was said and the source it was said in');
  assert.ok(ow.includes(WORDS.redLine), 'the red line the area details is on this work’s way up');
  assert.ok(!ow.includes(WORDS.forWhom), 'product-wide words that do not bear on this work stay in the start pack’s Purpose');
  assert.ok(!ow.includes(WORDS.csv), 'words the owner later replaced are not given as the direction');
  assert.ok(!ow.includes('The season report is a PDF with exact counts'), 'the Keeper’s one-line reading does not stand in for the words');
  // Adjustments: oldest first; what changed, who decided (three layers of authority) and why, each with its id.
  const adj = ow.slice(ow.indexOf('Adjustments along the way'));
  assert.ok(adj.length > 0, 'there is an Adjustments along the way part');
  const pos = (id: string) => adj.indexOf(`\`${id}\``);
  assert.ok(pos('chg_ow_pdf') > 0 && pos('chg_photos') > pos('chg_ow_pdf') && pos('chg_dec4') > pos('chg_photos'), 'in the order they happened');
  assert.match(adj, /The season report becomes a PDF; CSV is dropped \(`chg_ow_pdf`\)[^\n]*decided by the owner[^\n]*why: the co-op stopped taking CSV and pays per tree/);
  assert.match(adj, /Before: a CSV the co-op opens in a spreadsheet → after: a PDF listing every inspected tree/);
  assert.match(adj, /Photos leave the season report for P3 \(`chg_photos`\)[^\n]*decided by Lead, within its remit[^\n]*why: the PDF grew past 20 MB/);
  assert.match(adj, /DEC-4: reports are built in batches of 500 trees \(`chg_dec4`\)[^\n]*decided by Lead without the owner[^\n]*Pending owner decisions[^\n]*why: the PDF library runs out of memory/);
  assert.doesNotMatch(adj, /chg_round|rounded to tens/, 'an adjustment a later one superseded is not listed');
  assert.doesNotMatch(adj, /chg_code_r7|chg_done_i1/, 'building the code and finishing work are not adjustments to what the work is');
  // The one decided without the owner is also where the owner’s pending decisions are (§1.9).
  assert.match(sectionOf(md, 'Pending owner decisions'), /DEC-4 · Reports are built in batches of 500 trees \(`ref_dec4`\)/);
});

test('where what the work serves drifted from the owner’s words, the owner’s words section says so and marks it Layer drift (CKC-12 AC-42)', () => {
  const md = workPack(orchardStore(), 'thread_r7');
  const ow = sectionOf(md, "Owner's words");
  assert.match(ow, /Layer drift \(`mark_drift_req3`\) on REQ-3 · The season report lists every inspected tree \(`ref_req3`\): REQ-3 has the counts rounded to the nearest ten; the owner said never round the counts/);
  assert.doesNotMatch(sectionOf(md, 'Freshness'), /mark_drift_req3/, 'written where it belongs, not again in Freshness');
});

test('a work item that traces to no owner’s words says so, and names the documents it rests on and who wrote them (CKC-12 AC-41)', () => {
  const md = workPack(orchardStore(), 'thread_t1');
  assert.equal(headings(md)[0], "Owner's words");
  const ow = sectionOf(md, "Owner's words");
  assert.match(ow, /^Not traced to the owner’s words:/m);
  assert.match(ow, /DES-7 · Build pipeline \(`ref_des7`\)[^\n]*docs\/BUILD\.md[^\n]*written by Builder/, 'the design it rests on, its document and its author');
  assert.match(ow, /A3 · Tooling \(`ref_a3`\)[^\n]*written by Lead/);
  assert.ok(!ow.includes(WORDS.forWhom), 'no product-wide words are pulled in to fill the gap');
});

test('another work item traces to the words of the goal above it, and to the owner’s own adjustments (Implement)', () => {
  const md = workPack(orchardStore(), 'thread_i2');
  const ow = sectionOf(md, "Owner's words");
  assert.ok(ow.includes(WORDS.underAMinute), 'the goal’s words');
  assert.match(ow, /The inspection form goes from nine fields to five \(`chg_form`\)[^\n]*decided by Lead, within its remit/);
  assert.match(ow, /The form works for left-handed growers too \(`chg_mirror`\)[^\n]*decided by the owner/);
  assert.doesNotMatch(ow, /chg_code_i2/, 'the code change is in Code entry and recent changes');
});

test('Investigate lists the owner’s words and adjustments briefly; the words are fetched by id (Spec §7.1)', () => {
  const md = workPack(orchardStore(), 'thread_r7', 'Investigate');
  const ow = sectionOf(md, "Owner's words");
  assert.match(ow, /`ref_ow_pdf`/);
  assert.ok(!ow.includes(WORDS.pdfLine2), 'the words themselves are not copied in the brief form');
  assert.match(ow, /pk get/, 'it says how to fetch them');
  assert.match(ow, /`chg_dec4`/);
});

test('the start pack carries the product-wide owner’s words in Purpose, word for word (Spec §7.4 item 1)', () => {
  const md = assembleContext(orchardStore(), orchardProject, { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null } as ContextRequest, 'Idle').markdown;
  const purpose = sectionOf(md, 'Purpose');
  assert.ok(purpose.includes(WORDS.forWhom), 'what the product is for, in the owner’s words');
  assert.ok(purpose.includes(WORDS.underAMinute), 'a goal’s words, under the goal');
  assert.doesNotMatch(md, /## Owner's words/, 'the start pack has no work of its own to trace');
});
