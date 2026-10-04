/**
 * How this project works in the packs (Spec §7.3, §7.4; CKC-21 AC-9, AC-10; CKC-12 AC-2, AC-18, AC-39), the sections'
 * order, and every rule id a pack names being readable by id (Spec §7.10).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext } from './assemble.ts';
import { headings, orchardProject, orchardStore, sectionOf } from './pack-fixture.ts';
import { registerRoutes } from '../server/api.ts';
import type { ContextRequest } from '../model/types.ts';
import type { WorkKind } from '../model/vocab.ts';
import type { ProjectStore } from '../store/project-store.ts';

const startPack = (store: ProjectStore) =>
  assembleContext(store, orchardProject, { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null } as ContextRequest, 'Idle').markdown;
const workPack = (store: ProjectStore, id: string, kind: WorkKind = 'Implement', recipient = 'Incoming agent', taskVersion: string | null = null) =>
  assembleContext(store, orchardProject, { scope: { kind: 'work', ids: [id] }, purpose: 'Work', kind, recipient, lastSessionAt: null, taskVersion } as ContextRequest, 'Idle').markdown;

/** Spec §7.3 and §7.4: the default order of the sections a pack may have. A pack has only those with content. */
const START_ORDER = ['Purpose', 'Current direction', 'How this project works', 'Plan', 'Relevant work', 'Who is doing what', 'Changes since last session', 'Do not revive', 'Not in current scope', 'Pending owner decisions', 'Notes for you', 'Freshness', 'Explore further', 'Sources'];
const WORK_ORDER = ["Owner's words", 'Serves', 'Relation map', 'Done means', 'Owner acceptance', 'Not included', 'Existing results', 'Known results & failures', 'Open problems', 'Version check', 'Code entry and recent changes', 'How this project works', 'Do not revive', 'Pending owner decisions', 'Notes for you', 'Freshness', 'Explore further', 'Sources'];
const inOrder = (md: string, order: readonly string[]) => {
  const got = headings(md);
  const known = got.filter((h) => order.includes(h));
  assert.deepEqual(known, [...known].sort((a, b) => order.indexOf(a) - order.indexOf(b)), `sections in the Spec’s order: ${got.join(' / ')}`);
  return got;
};

test('the sections come in the Spec’s order: How this project works right after Current direction; a work context opens with the owner’s words (CKC-12 AC-2)', () => {
  const store = orchardStore();
  const start = inOrder(startPack(store), START_ORDER);
  assert.equal(start[start.indexOf('Current direction') + 1], 'How this project works');
  for (const [id, kind] of [['thread_r7', 'Implement'], ['thread_r7', 'Review'], ['thread_i2', 'Implement'], ['thread_t1', 'Plan']] as const) {
    const got = inOrder(workPack(store, id, kind, 'Incoming agent', 'R-7 v2.0'), WORK_ORDER);
    assert.equal(got[0], "Owner's words", `${id} ${kind}: the owner’s words come first`);
  }
});

test('the start pack says how this project works: where it comes from, three groups, one line per rule with its id (CKC-21 AC-9; CKC-12 AC-18)', () => {
  const start = startPack(orchardStore());
  const htpw = sectionOf(start, 'How this project works');
  const opening = htpw.split('\n')[0]!;
  assert.match(opening, /\*\*Crew handbook\*\*/, 'it opens with where it comes from: the owner’s own summary, by name');
  assert.match(opening, /\[\d+\]/, 'with the id of where that summary is written');
  assert.match(opening, /the Keeper dug out of the project’s records/, 'and says which rules the Keeper dug out instead');
  const at = ['How work is organized', 'Working rules', 'Material rules'].map((g) => htpw.indexOf(`\n${g}:`));
  assert.ok(at[0]! > 0 && at[0]! < at[1]! && at[1]! < at[2]!, 'three groups, in the fixed order');
  assert.match(htpw, /\n- Multi-agent: a Lead plans, Builders implement, and a Checker reviews each item once before the owner sees it \(`rule_crew`\)[^\n]*in practice: R-5 went through review twice, the second round by the Lead/, 'where practice differs from the owner’s summary, on that line');
  assert.match(htpw, /\n- The Lead sets the order of tasks; product scope and anything a grower sees is the owner’s call \(`rule_who`\) · Inferred, awaiting the owner’s confirmation/);
  assert.match(htpw, /\n- Task numbers come from docs\/TASKS\.md; the next free number is R-9 \(`rule_numbers`\)/);
  assert.match(htpw, /\n- Reference only · docs\/vendor-pdf\/ is the PDF library’s own documentation, for reference only \(`rule_vendor`\)/);
  assert.match(htpw, /\n- The Checker may skip the review of a one-line fix \(`rule_skip`\)[^\n]*set by Lead on 2026-09-12 without the owner/);
  // Not the instruction files' own text, not a list of files; obsolete ones are in Do not revive, replaced ones nowhere.
  assert.ok(!htpw.includes('Put what you built in dist/, named after the task.'), 'the project’s own wording is fetched by id, not pasted');
  assert.doesNotMatch(htpw, /`rule_obsolete`/);
  assert.doesNotMatch(start, /rule_push_old|push straight to main/);
});

test('the start pack has Not in current scope, and Plan says how far the work in progress got and what the rest waits on (CKC-12 AC-18)', () => {
  const start = startPack(orchardStore());
  assert.match(sectionOf(start, 'Not in current scope'), /REQ-11 · Photos in the season report \(`ref_photos`\)/);
  const plan = sectionOf(start, 'Plan');
  assert.match(plan, /\*\*P2 · Season reports\*\*[\s\S]*In progress here: R-7 · Build the season report \(`thread_r7`\)/);
  assert.match(plan, /Inside this plan: R-8 · Send the report to the co-op server \(`thread_r8`, Planned\) waits on R-7 · Build the season report \(`thread_r7`, In progress\)/);
  assert.match(plan, /Waits on the owner: the decision on “Should the season report round counts\?” \(`note_round`\)/);
});

test('a work context carries the project’s rules that bear on this work, and no others (CKC-21 AC-10; CKC-12 AC-39)', () => {
  const store = orchardStore();
  const has = (md: string, ids: readonly string[], what: string) => { const h = sectionOf(md, 'How this project works'); for (const id of ids) assert.match(h, new RegExp(`\\(\`${id}\`\\)`), `${what}: ${id} bears on it`); };
  const hasNot = (md: string, ids: readonly string[], what: string) => { const h = sectionOf(md, 'How this project works'); for (const id of ids) assert.doesNotMatch(h, new RegExp(`\`${id}\``), `${what}: ${id} does not bear on it`); };
  // R-7 is held by a Builder and touches the vendor documentation, the task index and a receipt under runs/.
  const implement = workPack(store, 'thread_r7');
  has(implement, ['rule_crew', 'rule_who', 'rule_numbers', 'rule_push', 'rule_deliver', 'rule_vendor', 'rule_authority', 'rule_untrusted', 'rule_open'], 'R-7 Implement');
  hasNot(implement, ['rule_qc', 'rule_findings', 'rule_skip', 'rule_recovery', 'rule_obsolete', 'rule_push_old'], 'R-7 Implement');
  // A review by the Checker brings the independent QC arrangement and the Checker's own rules.
  const review = workPack(store, 'thread_r7', 'Review', 'Checker');
  has(review, ['rule_qc', 'rule_findings', 'rule_skip', 'rule_crew'], 'R-7 Review by the Checker');
  hasNot(review, ['rule_recovery'], 'R-7 Review by the Checker');
  // I-2 touches none of R-7's material.
  hasNot(workPack(store, 'thread_i2'), ['rule_vendor', 'rule_untrusted', 'rule_open', 'rule_qc'], 'I-2 Implement');
  has(workPack(store, 'thread_i2'), ['rule_authority', 'rule_numbers'], 'I-2 Implement');
});

test('every rule id a pack names is read by id, in full with where it is written (Spec §7.10)', () => {
  const store = orchardStore();
  const handlers = new Map<string, (ctx: unknown) => unknown>();
  const http = { route: (method: string, path: string, handler: (ctx: unknown) => unknown) => handlers.set(`${method} ${path}`, handler), static: () => undefined };
  const app = { project: () => orchardProject, store: () => store, workspace: { list: () => [orchardProject] } };
  registerRoutes(http as never, app as never, '', '');
  const call = (key: string, params: Record<string, string>) => handlers.get(key)?.({ params: { id: orchardProject.id, ...params }, query: new URLSearchParams(), body: null }) as Record<string, unknown> | undefined;
  assert.deepEqual(call('GET /api/projects/:id/lookup/:oid', { oid: 'rule_crew' }), { id: 'rule_crew', kind: 'rule', projectId: orchardProject.id });
  const page = call('GET /api/projects/:id/rules/:rid', { rid: 'rule_crew' });
  assert.ok(page, 'there is a way to read a rule by its id');
  const text = String(page!.text);
  assert.match(text, /^# Multi-agent: a Lead plans/);
  assert.ok(text.includes('One Lead plans; Builders build; the Checker checks every item once, on a fresh clone, before the owner sees it.'), 'the project’s own words, whole');
  assert.match(text, /`src_crew`/, 'where it is written, by id');
  assert.match(text, /Crew handbook/);
  assert.match(text, /R-5 went through review twice/);
});
