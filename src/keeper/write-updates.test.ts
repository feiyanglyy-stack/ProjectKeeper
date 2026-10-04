/**
 * An update never has to repeat what it does not change (BI; D97, D98; test-D-1). Every pk_* writer that creates or
 * updates an item takes an update as a call naming an item that exists — its id, or the project's number or key the
 * writer matches on — and changes only what the call gives; what it leaves out keeps its value. The fields only a new
 * item needs are optional in the schema: the writer asks for them itself when a call creates, and its refusal says what
 * is missing and how to update instead.
 *
 * Every call here goes the way pi takes it: the tool's schema validates the arguments first (pi-ai's own validation, the
 * Keeper's copy), then the tool runs, and a tool that throws comes back as an error result — which is how a writer
 * refuses an incomplete create, so the refusal guard and the timer read it as a refusal. test-D-1's skeleton is replayed
 * through App and pi against a loopback provider: no model, no network.
 *
 * The fixtures are an invented project, "Harbour", a booking app, except the replay, which carries test-D-1's shape.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { EntryMark, JudgementRecord, Project, ReferenceItem, Source, WorkThread } from '../model/types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import type { ToolContext } from './tools.ts';

const scratch = mkdtempSync(join(tmpdir(), 'pk-write-updates-'));
process.env.PI_CODING_AGENT_DIR = join(scratch, 'pi-agent');
after(async () => {
  // waitFor resolves on Keeper's done event, just before the runtime's final flush/dispose.
  await new Promise((resolve) => setTimeout(resolve, 300));
  rmSync(scratch, { recursive: true, force: true });
});

const { ProjectStore: Store } = await import('../store/project-store.ts');
const { keeperTools } = await import('./tools.ts');
const { clerkTools } = await import('./clerk-tools.ts');
const { isRefusal } = await import('./step-timing.ts');
const { App } = await import('../server/app.ts');
const { FAKE_MODEL } = await import('./fake-provider.ts');
type PiValidation = { validateToolArguments(tool: { name: string; parameters: unknown }, call: object): unknown };
const validation = await import(new URL('../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/validation.js', import.meta.url).href) as PiValidation;

const AT = '2026-09-20T00:00:00.000Z';

interface Called { readonly text: string; readonly error: boolean; readonly refused: boolean; readonly json: Record<string, unknown> }

/** A call as pi makes it: the schema first, then the tool; what throws comes back as an error result. */
async function throughPi(tools: readonly ToolDefinition[], name: string, args: Record<string, unknown>): Promise<Called> {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `no tool ${name}`);
  let text: string;
  let error: boolean;
  try {
    const validated = validation.validateToolArguments(tool, { type: 'toolCall', id: 'c1', name, arguments: structuredClone(args) });
    const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    const result = await run('c1', validated);
    text = result.content.map((c) => c.text).join('\n');
    error = result.isError === true;
  } catch (e) {
    text = (e as Error).message;
    error = true;
  }
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a refusal is prose */ }
  return { text, error, refused: isRefusal(error, text), json };
}

function harness() {
  const store = Store.open('p1', mkdtempSync(join(scratch, 'store-')));
  const project = { id: 'p1', name: 'Harbour', language: 'en', locations: ['D:\\harbour'], scope: [], roles: [] } as unknown as Project;
  const ctx: ToolContext = { store, project, jobId: 'job_1', jobKind: 'Organizing', model: null };
  const tools = keeperTools(ctx);
  return { store, ctx, call: (name: string, args: Record<string, unknown>) => throughPi(tools, name, args) };
}

async function ok(h: ReturnType<typeof harness>, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await h.call(name, args);
  assert.equal(r.error, false, `${name} ${JSON.stringify(args).slice(0, 160)} → ${r.text}`);
  return r.json;
}
/** A create the writer refuses for what a new item needs: pi validated it, the writer threw, the guard reads a refusal. */
async function incomplete(h: ReturnType<typeof harness>, name: string, args: Record<string, unknown>, missing: RegExp): Promise<string> {
  const r = await h.call(name, args);
  assert.equal(r.error, true, `${name} should be refused: ${r.text}`);
  assert.equal(r.refused, true, `read as a refusal: ${r.text}`);
  assert.match(r.text, /^Invalid arguments: /);
  assert.match(r.text, missing);
  assert.match(r.text, /Nothing was written\./);
  assert.match(r.text, /An update gives only what it changes: what it leaves out keeps its value\./);
  return r.text;
}

/** Every field of an item but the ones named and its write times. */
/** The work item that carries a project number (CJ: a number given as id is kept in its ids; its id is the program's). */
const byNumber = (store: ProjectStore, num: string): WorkThread | undefined => store.threads.find((t) => t.ids.includes(num));
const rest = <T extends object>(item: T, ...changed: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(item).filter(([k]) => !['updatedAt', 'asOf', ...changed].includes(k)));

const fileSource = (store: ProjectStore, id: string, path: string) =>
  store.sources.put({ id, projectId: 'p1', title: path.split('\\').pop()!, anchor: { kind: 'file', path, headingPath: [], lineStart: 1, lineEnd: 9 }, ids: [], version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt: 'x', usedAs: 'Design', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: 'scope', hasCredential: false, bytes: 10 } as Source);
const owner = { author: { kind: 'owner' as const, name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' as const };
const reference = (store: ProjectStore, id: string, category: string, name: string, extra: Partial<ReferenceItem> = {}) =>
  store.reference.put({ id, projectId: 'p1', category, name, ids: [], text: name, quote: null, basis: 'Inferred', validity: 'Current', progress: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT, ...extra } as ReferenceItem);
const judgement = (store: ProjectStore, id: string) =>
  store.judgements.put({ id, projectId: 'p1', jobId: 'job_1', at: AT, scope: { kind: 'project', ids: [], label: 'Harbour' }, inputs: { referenceIds: [], threadIds: [], areaIds: [], relationIds: [], keyEvidenceSourceIds: [], conflictingSourceIds: [], previousNoteIds: [], investigations: [] }, excluded: [], outcome: { noteIds: [], assessments: [], reconsideredOnly: false } } as JudgementRecord);

/** Harbour's product: an Area and the contract under it. */
function harbour(store: ProjectStore) {
  fileSource(store, 'src_plan', 'D:\\harbour\\docs\\PLAN.md');
  fileSource(store, 'src_board', 'D:\\harbour\\docs\\BOARD.md');
  fileSource(store, 'src_code', 'D:\\harbour\\src\\booking.ts');
  reference(store, 'ref_area_booking', 'Area', 'Booking');
  reference(store, 'ref_area_payments', 'Area', 'Payments');
  reference(store, 'ref_req_hold', 'Requirement', 'R-3 · a slot is held while the guest pays', { refines: ['ref_area_booking'] });
}

// ───────────────────────── the schemas ask only for what names the item ─────────────────────────

test('every writer’s schema requires only what names the item: what only a new item needs is the writer’s to ask for', () => {
  const h = harness();
  const clerk = clerkTools({ ...h.ctx, step: { roundId: 'crd_1', kind: 'skeleton', path: null } });
  const required = (name: string) => {
    const tool = [...keeperTools(h.ctx), ...clerk].find((t) => t.name === name);
    assert.ok(tool, name);
    return [...((tool.parameters as { required?: string[] }).required ?? [])].sort();
  };
  const keys: Record<string, string[]> = {
    pk_write_thread: [], pk_write_fact_record: [], pk_write_area: [], pk_write_reference: [], pk_write_change: [], pk_write_rule: [], pk_write_organizing_plan: [],
    pk_relate: ['fromId', 'toId', 'type'], pk_write_mark: ['kind', 'targetId'], pk_write_note: ['reason'], pk_record_carry_out: ['decisionId'],
    pk_write_layers: ['entries'], pk_write_generation: [], pk_write_round_doc: ['kind'], pk_write_patch: [], pk_link_process: ['ledgerRef', 'stepKind', 'workId'],
    pk_suggest_sendback: ['targetId', 'what'], pk_write_territory: [], pk_write_session_draft: ['session'],
  };
  for (const [name, fields] of Object.entries(keys)) assert.deepEqual(required(name), fields, name);
  const entry = (clerk.find((t) => t.name === 'pk_write_layers')!.parameters as { properties: { entries: { items: { required?: string[] } } } }).properties.entries.items;
  assert.deepEqual(entry.required, ['path'], 'a layer entry is named by its path');
});

// ───────────────────────── work items ─────────────────────────

test('a work item updated by its id gives only what changes; the calls test-D-1 sent pass pi and change nothing else', async () => {
  const h = harness();
  harbour(h.store);
  const created = await ok(h, 'pk_write_thread', {
    id: 'CKC-03', title: 'CKC-03 · Hold a slot while the guest pays', progress: 'Done', acceptance: 'Not yet accepted', doing: 'Holds a slot for ten minutes.',
    results: 'Delivered in batch B2.', unresolved: 'Owner review pending.', doneMeans: 'A slot is held while the guest pays.',
    serves: [{ basis: 'Explicit', claim: 'holds the slot', referenceId: 'ref_req_hold' }],
    executionFacts: [{ type: 'Claimed', text: 'B2 delivered the hold.', sourceIds: ['src_board'], claimedBy: 'Worker agent, B2 receipt', claimedAt: '2026-09-18' }],
    inputs: { sourceIds: ['src_plan', 'src_board'] },
  });
  assert.match(String(created.warning), /serves names no Area or Goal directly/, 'what test-D-1’s creates were told');
  // CJ: the number given as id is the work item's number, in its ids; its id is the program's.
  assert.notEqual(created.id, 'CKC-03');
  assert.deepEqual(h.store.threads.get(created.id as string)!.ids, ['CKC-03']);
  const before = byNumber(h.store, 'CKC-03')!;
  // test-D-1's update, as the model sent it: the id, replaceServes and serves — no title, no progress.
  const args = { id: 'CKC-03', replaceServes: true, serves: [{ basis: 'Explicit', claim: 'booking holds the slot', referenceId: 'ref_area_booking' }, { basis: 'Explicit', claim: 'holds the slot', referenceId: 'ref_req_hold' }] };
  assert.doesNotThrow(() => validation.validateToolArguments(keeperTools(h.ctx).find((t) => t.name === 'pk_write_thread')!, { type: 'toolCall', id: 'c', name: 'pk_write_thread', arguments: structuredClone(args) }), 'pi’s validation takes it');
  const updated = await ok(h, 'pk_write_thread', args);
  assert.deepEqual(updated, { id: created.id, updated: true }, 'placed now: no warning');
  const after = byNumber(h.store, 'CKC-03')!;
  assert.deepEqual(after.serves.map((s) => s.referenceId), ['ref_area_booking', 'ref_req_hold'], 'replaceServes replaced the list');
  assert.deepEqual(rest(after, 'serves'), rest(before, 'serves'), 'and nothing else changed — inputs and pending marks included');
  assert.equal(h.store.threads.size, 1);
});

test('`serves` keeps the order it was written in: a later write adds after it and never moves the first Area, the main module (owner, 2026-09-30)', async () => {
  const h = harness();
  harbour(h.store);
  await ok(h, 'pk_write_thread', { id: 'CKC-04', title: 'CKC-04 · Take the deposit', progress: 'Planned', serves: [{ basis: 'Explicit', claim: 'the ticket names Payments', referenceId: 'ref_area_payments' }] });
  // A later write names Booking and repeats Payments with a new claim: Payments stays first, its claim is the new one.
  await ok(h, 'pk_write_thread', { id: 'CKC-04', serves: [{ basis: 'Explicit', claim: 'also holds the slot', referenceId: 'ref_area_booking' }, { basis: 'Explicit', claim: 'Payments, from the prompt', referenceId: 'ref_area_payments' }] });
  const t = byNumber(h.store, 'CKC-04')!;
  assert.deepEqual(t.serves.map((s) => s.referenceId), ['ref_area_payments', 'ref_area_booking']);
  assert.equal(t.serves[0]!.claim, 'Payments, from the prompt');
  // replaceServes is how the Keeper moves the main module: the list as given, in its order.
  await ok(h, 'pk_write_thread', { id: 'CKC-04', replaceServes: true, serves: [{ basis: 'Explicit', claim: 'booking', referenceId: 'ref_area_booking' }, { basis: 'Explicit', claim: 'payments', referenceId: 'ref_area_payments' }] });
  assert.deepEqual(byNumber(h.store, 'CKC-04')!.serves.map((s) => s.referenceId), ['ref_area_booking', 'ref_area_payments']);
});

test('a work item is found by the project id it carries — as id, or in ids — and text left empty keeps its value', async () => {
  const h = harness();
  harbour(h.store);
  h.store.threads.put({
    id: 'thread_hold', projectId: 'p1', title: 'CKC-03 · Hold a slot', ids: ['CKC-03'], doing: 'Holds a slot.', changed: '', results: 'B2.', unresolved: '', doneMeans: '', acceptanceMeans: '', acceptance: '',
    executionFacts: [], qcFacts: [], factRecordIds: [], serves: [{ referenceId: 'ref_area_booking', claim: 'booking', basis: 'Explicit' }], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null,
    attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, inputs: { jobId: 'j', sourceIds: ['src_plan'], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' },
    asOf: AT, updatedAt: AT, pendingSourceIds: ['src_board'], waitsFor: [], validityByRuleId: null, progressByRuleId: null,
  } as unknown as WorkThread);
  const before = h.store.threads.get('thread_hold')!;
  const byNumber = await ok(h, 'pk_write_thread', { id: 'ckc-03', progress: 'Done' });
  assert.deepEqual(byNumber, { id: 'thread_hold', updated: true }, 'the number it carries names it: no second work item');
  assert.equal(h.store.threads.size, 1);
  assert.deepEqual(rest(h.store.threads.get('thread_hold')!, 'progress'), rest(before, 'progress'));
  assert.equal(h.store.threads.get('thread_hold')!.progress, 'Done');
  await ok(h, 'pk_write_thread', { ids: ['CKC-03'], results: 'B2, then the fix in B3.', doing: '' });
  const now = h.store.threads.get('thread_hold')!;
  assert.deepEqual([now.results, now.doing, now.title, now.progress], ['B2, then the fix in B3.', 'Holds a slot.', 'CKC-03 · Hold a slot', 'Done']);
  assert.deepEqual(now.pendingSourceIds, ['src_board'], '`Update pending` is the program’s: writing the work item leaves it');
});

test('a call that would create a work item without its title or progress is refused as incomplete, and says how to update', async () => {
  const h = harness();
  harbour(h.store);
  const neither = await incomplete(h, 'pk_write_thread', { id: 'CKC-09', replaceServes: true, serves: [{ basis: 'Explicit', claim: 'x', referenceId: 'ref_area_booking' }] }, /No work item carries CKC-09, so this call would create a work item, and a new one needs title and progress/);
  assert.match(neither, /give its id — or the project id it carries, such as T-09 — as id/);
  await incomplete(h, 'pk_write_thread', { title: 'CKC-10 · Refunds' }, /No work item carries CKC-10, so this call would create a work item, and a new one needs progress, which/);
  await incomplete(h, 'pk_write_thread', { ids: ['CKC-11'], progress: 'Planned' }, /No work item carries CKC-11, so this call would create a work item, and a new one needs title/);
  assert.equal(h.store.threads.size, 0, 'nothing was written');
  // An execution batch records the progress of what it carries out, or what it did; giving neither records nothing.
  await ok(h, 'pk_write_thread', { id: 'CKC-03', title: 'CKC-03 · Hold a slot', progress: 'In progress' });
  const nothing = await h.call('pk_write_thread', { title: 'Batch B4', carriesOut: ['CKC-03'] });
  assert.deepEqual([nothing.error, nothing.refused], [true, true]);
  assert.match(nothing.text, /^Invalid arguments: an execution batch that carries out CKC-03 records their progress \(progress\) or what it did \(executionFacts\), and this call gives neither\. Nothing was written\./);
  const moved = await ok(h, 'pk_write_thread', { title: 'Batch B4', carriesOut: ['CKC-03'], progress: 'Done' });
  assert.deepEqual(moved.recordedOn, [byNumber(h.store, 'CKC-03')!.id]);
  assert.equal(byNumber(h.store, 'CKC-03')!.progress, 'Done');
});

// ───────────────────────── fact records, areas, reference items, relations ─────────────────────────

test('a fact record updated by id or by its material keeps what the call leaves out; a new one needs title, material and statements', async () => {
  const h = harness();
  harbour(h.store);
  const statement = { type: 'Observed', text: 'The plan holds a slot for ten minutes.', sourceIds: ['src_plan'] };
  const first = await ok(h, 'pk_write_fact_record', { title: 'Plan: holding a slot', aboutSourceIds: ['src_plan'], statements: [statement], decisions: [{ text: 'Ten minutes', byOwner: true, sourceIds: ['src_plan'], documented: true }], inputs: { sourceIds: ['src_plan'] } });
  const id = first.id as string;
  const before = h.store.facts.get(id)!;
  await ok(h, 'pk_write_fact_record', { id, openQuestions: ['Does the hold survive a crash?'] });
  const byId = h.store.facts.get(id)!;
  assert.deepEqual(byId.openQuestions, ['Does the hold survive a crash?']);
  assert.deepEqual(rest(byId, 'openQuestions'), rest(before, 'openQuestions'), 'statements, decisions and inputs stay');
  await ok(h, 'pk_write_fact_record', { aboutSourceIds: ['src_plan'], title: 'Plan: holding a slot while paying' });
  assert.equal(h.store.facts.size, 1, 'the same material is the same record');
  assert.deepEqual(h.store.facts.get(id)!.statements, before.statements);
  await incomplete(h, 'pk_write_fact_record', { title: 'Board', aboutSourceIds: ['src_board'] }, /a new one needs statements/);
  await incomplete(h, 'pk_write_fact_record', { title: 'Nothing named', statements: [] }, /names no fact record \(no id, and no aboutSourceIds to find one by\), so this call would create a fact record, and a new one needs aboutSourceIds/);
  assert.equal(h.store.facts.size, 1);
});

test('an area understanding updated by its Area gives only what changes; a new one needs referenceId, effectNow, gaps and contributions', async () => {
  const h = harness();
  harbour(h.store);
  await ok(h, 'pk_write_thread', { id: 'CKC-03', title: 'CKC-03 · Hold a slot', progress: 'Done', serves: [{ referenceId: 'ref_area_booking', claim: 'booking', basis: 'Explicit' }] });
  const first = await ok(h, 'pk_write_area', { referenceId: 'ref_area_booking', effectNow: 'A slot is held while the guest pays.', gaps: 'No refunds yet.', contributions: [{ threadId: 'CKC-03', claim: 'holds the slot', basis: 'Explicit' }] });
  const before = h.store.areas.get(first.id as string)!;
  assert.deepEqual(await ok(h, 'pk_write_area', { referenceId: 'ref_area_booking', gaps: 'No refunds; no waitlist.' }), { id: first.id, updated: true });
  const after = h.store.areas.get(first.id as string)!;
  assert.equal(after.gaps, 'No refunds; no waitlist.');
  assert.deepEqual(rest(after, 'gaps'), rest(before, 'gaps'), 'the effect and the contributions stay');
  await ok(h, 'pk_write_area', { id: first.id, contributions: [] });
  assert.deepEqual(h.store.areas.get(first.id as string)!.contributions, [], 'a list given replaces the list');
  await incomplete(h, 'pk_write_area', { referenceId: 'ref_area_payments', effectNow: 'Card payments work.' }, /a new one needs gaps and contributions/);
  assert.equal(h.store.areas.size, 1);
});

test('a reference item updated by id or by the project id it carries keeps what the call leaves out; a changed validity drops a stale replacedBy', async () => {
  const h = harness();
  harbour(h.store);
  const r4 = await ok(h, 'pk_write_reference', { category: 'Requirement', name: 'R-4 · refunds within a day', ids: ['R-4'], text: 'Refunds are paid within a day.', basis: 'Explicit', validity: 'Current', identity: 'Artifact', authorKind: 'role', authorName: 'Product architect', sourceIds: ['src_plan'], refines: ['ref_area_payments'], holderRole: 'Product architect', inputs: { sourceIds: ['src_plan'] } });
  const id = r4.id as string;
  const before = h.store.reference.get(id)!;
  await ok(h, 'pk_write_reference', { id, refines: ['ref_area_payments', 'ref_area_booking'] });
  assert.deepEqual(rest(h.store.reference.get(id)!, 'refines'), rest(before, 'refines'), 'only refines changed');
  const byNumber = await ok(h, 'pk_write_reference', { ids: ['R-4'], text: 'Refunds are paid within one working day.' });
  assert.deepEqual([byNumber.id, byNumber.merged], [id, true], 'the one item carrying R-4, without its category');
  assert.equal(h.store.reference.get(id)!.attribution.author.name, 'Product architect', 'the author stays');
  await ok(h, 'pk_write_reference', { category: 'Requirement', ids: ['R-4'], validity: 'Replaced', replacedBy: 'ref_req_hold' });
  assert.deepEqual([h.store.reference.get(id)!.validity, h.store.reference.get(id)!.replacedBy], ['Replaced', 'ref_req_hold']);
  await ok(h, 'pk_write_reference', { id, text: 'Refunds are paid within one working day (reread).' });
  assert.equal(h.store.reference.get(id)!.replacedBy, 'ref_req_hold', 'a call that leaves validity alone keeps what replaced it');
  await ok(h, 'pk_write_reference', { id, validity: 'Current' });
  assert.equal(h.store.reference.get(id)!.replacedBy, null, 'a call that changes the validity gives replacedBy anew or drops it');
  // The same number on two items needs the category, or the id.
  reference(h.store, 'ref_p2_plan', 'Plan', 'P2 · payments plan', { ids: ['P2'] });
  reference(h.store, 'ref_p2_goal', 'Goal', 'P2 · pay in one step', { ids: ['P2'] });
  const twoOfThem = await h.call('pk_write_reference', { ids: ['P2'], text: 'x' });
  assert.equal(twoOfThem.error, true);
  assert.match(twoOfThem.text, /2 product reference items carry P2: .*Give the category of the one to update, or its id/);
  await ok(h, 'pk_write_reference', { category: 'Plan', ids: ['P2'], text: 'The payments plan, second draft.' });
  assert.equal(h.store.reference.get('ref_p2_plan')!.text, 'The payments plan, second draft.');
  const text = await incomplete(h, 'pk_write_reference', { category: 'Decision', name: 'D7 · refunds by card only', text: 'Refunds go back to the card.' }, /No product reference item of category Decision carries D7, so this call would create a product reference item, and a new one needs basis, validity, identity and sourceIds/);
  assert.doesNotMatch(text, /needs category|needs name|, name,/, 'only what is missing');
});

test('a relation written again gives only what changes; a new one needs claim and basis', async () => {
  const h = harness();
  harbour(h.store);
  await ok(h, 'pk_write_thread', { id: 'CKC-03', title: 'CKC-03 · Hold a slot', progress: 'Done', serves: [{ referenceId: 'ref_area_booking', claim: 'booking', basis: 'Explicit' }] });
  const rel = await ok(h, 'pk_relate', { type: 'implements', fromId: 'src_code', toId: 'ref_req_hold', claim: 'booking.ts holds the slot', basis: 'Explicit', evidenceSourceIds: ['src_code'] });
  const before = h.store.relations.get(rel.id as string)!;
  await ok(h, 'pk_relate', { type: 'implements', fromId: 'src_code', toId: 'ref_req_hold', factsSoFar: 'the hold is ten minutes in code too' });
  const after = h.store.relations.get(rel.id as string)!;
  assert.deepEqual([after.claim, after.basis, after.evidence.sourceIds, after.evidence.factsSoFar], [before.claim, before.basis, ['src_code'], 'the hold is ten minutes in code too']);
  await incomplete(h, 'pk_relate', { type: 'depends on', fromId: 'CKC-03', toId: 'ref_req_hold', claim: 'needs the hold' }, /There is no depends on relation from thread_\w+ to ref_req_hold yet, so this call would create a relation, and a new one needs basis/);
  assert.equal(h.store.relations.size, 1);
});

// ───────────────────────── change records, marks, notes, a decision's carry-out ─────────────────────────

test('a change record named by id takes an item without its sources or piece of work, and a work-only update keeps the items', async () => {
  const h = harness();
  harbour(h.store);
  const work = { workKind: 'Session', workLabel: 'sess-hold', workSessionId: 'sess-hold', workStartedAt: '2026-09-18', workEndedAt: '2026-09-18', workOpenEnded: true };
  const first = await ok(h, 'pk_write_change', { ...work, sourceIds: ['src_plan'], items: [{ at: '2026-09-18', material: 'Plan update', effect: 'Added', title: 'The hold is planned', summary: 'The plan adds a ten-minute hold.', affects: ['ref_req_hold'] }] });
  const id = first.id as string;
  const added = await ok(h, 'pk_write_change', { id, items: [{ at: '2026-09-18', material: 'Code change', effect: 'Completed', title: 'The hold is built', summary: 'booking.ts holds the slot.', sourceIds: ['src_code'], affects: ['ref_req_hold'] }] });
  assert.equal(added.items, 2);
  const record = h.store.changes.get(id)!;
  assert.deepEqual(record.work, { kind: 'Session', label: 'sess-hold', sessionId: 'sess-hold', startedAt: '2026-09-18', endedAt: '2026-09-18', openEnded: true }, 'the piece of work stays as recorded');
  assert.deepEqual([...record.sourceIds].sort(), ['src_code', 'src_plan']);
  const closed = await ok(h, 'pk_write_change', { id, workEndedAt: '2026-09-19', workOpenEnded: false });
  assert.deepEqual([closed.items, closed.updated], [2, true]);
  const now = h.store.changes.get(id)!;
  assert.deepEqual([now.work?.endedAt, now.work?.openEnded, now.work?.label], ['2026-09-19', false, 'sess-hold']);
  assert.deepEqual(now.items, record.items, 'the items stay');
  await incomplete(h, 'pk_write_change', { workKind: 'Session', workLabel: 'sess-refund', workSessionId: 'sess-refund', workStartedAt: '2026-09-19', workEndedAt: '2026-09-19', material: 'Plan update', effect: 'Added', title: 'Refunds planned', summary: 'x' }, /No change record covers the piece of work “sess-refund” .*a new one needs sourceIds/);
  await incomplete(h, 'pk_write_change', { workKind: 'Session', workLabel: 'sess-refund', workSessionId: 'sess-refund', workStartedAt: '2026-09-19', workEndedAt: '2026-09-19', sourceIds: ['src_plan'] }, /a new one needs items/);
  assert.equal(h.store.changes.size, 1);
});

test('a mark written again gives only what changes and keeps which of the six things it is; a new one needs its clue and what it was checked against', async () => {
  const h = harness();
  harbour(h.store);
  await ok(h, 'pk_write_mark', { kind: 'Undocumented decision', targetId: 'ref_req_hold', clue: 'The ten minutes are in code, not in a decision.', clueSourceIds: ['src_code'] });
  const id = h.store.marks.all()[0]!.id;
  h.store.marks.put({ ...h.store.marks.get(id)!, sixThing: 4 } as EntryMark);
  const again = await ok(h, 'pk_write_mark', { kind: 'Undocumented decision', targetId: 'ref_req_hold', clue: 'Ten minutes is decided only in booking.ts.' });
  assert.equal(again.updated, true);
  const mark = h.store.marks.get(id)!;
  assert.deepEqual([mark.clue, mark.clueSourceIds, mark.sixThing], ['Ten minutes is decided only in booking.ts.', ['src_code'], 4]);
  await incomplete(h, 'pk_write_mark', { kind: 'Suspected stale', targetId: 'ref_req_hold', clue: 'The plan may be older than the code.' }, /ref_req_hold has no Suspected stale mark yet, so this call would create a mark, and a new one needs clueSourceIds/);
  assert.equal(h.store.marks.size, 1);
});

test('a note updated by id keeps its mount, and the new version takes what it leaves out from the one before', async () => {
  const h = harness();
  harbour(h.store);
  judgement(h.store, 'jdg_1');
  const note = await ok(h, 'pk_write_note', { mountKind: 'node', mountIds: ['ref_req_hold'], title: 'How long is a slot held?', preview: 'Ten minutes, set only in code.', ask: 'Worth discussing', whyItMatters: 'Guests paying slowly lose the slot.', judgementRecordId: 'jdg_1', reason: 'first look' });
  const id = note.id as string;
  const v2 = await ok(h, 'pk_write_note', { id, whyItMatters: 'Guests paying slowly lose the slot, and nobody is told.', reason: 'what the guest sees' });
  assert.equal(v2.version, 2);
  const stored = h.store.notes.get(id)!;
  const [first, second] = stored.versions;
  assert.deepEqual({ ...second!, at: '', version: 0, reason: '', body: { ...second!.body, whyItMatters: '' } }, { ...first!, at: '', version: 0, reason: '', body: { ...first!.body, whyItMatters: '' } }, 'title, preview, ask, the rest of the body and the judgement carried over');
  assert.deepEqual([second!.body.whyItMatters, second!.reason, stored.mount], ['Guests paying slowly lose the slot, and nobody is told.', 'what the guest sees', { kind: 'node', ids: ['ref_req_hold'] }]);
  // Asking for a decision changes what the note has to carry (D105; CKC-08 AC-26): the version is checked whole, with
  // what it takes from the one before — the first sentence is not a question, and there are no options.
  const asked = await h.call('pk_write_note', { id, ask: 'For your decision', reason: 'the owner has to choose the length' });
  assert.equal(asked.error, true, asked.text);
  assert.match(asked.text, /opens with the question[^]*This one opens with “Ten minutes, set only in code\.”[^]*at least two in options[^]*Nothing was written/);
  assert.equal(h.store.notes.get(id)!.versions.length, 2, 'nothing was written');
  const v3 = await ok(h, 'pk_write_note', { id, ask: 'For your decision', preview: 'How long should a slot be held? It is ten minutes today, set only in code.', options: [{ option: 'Keep ten minutes', then: 'nothing changes; it is written into the requirement' }, { option: 'Make it a setting', then: 'the hold length moves from code to the booking settings' }], reason: 'the owner has to choose the length' });
  assert.equal(v3.version, 3);
  const third = h.store.notes.get(id)!.versions[2]!;
  assert.deepEqual([third.ask, third.body.options?.length, third.body.whyItMatters], ['For your decision', 2, 'Guests paying slowly lose the slot, and nobody is told.']);
  await incomplete(h, 'pk_write_note', { title: 'Refunds', preview: 'None yet.', ask: 'For information', judgementRecordId: 'jdg_1', reason: 'x' }, /This call names no note to update \(no id\), so this call would create a note, and a new one needs mountKind and mountIds/);
  assert.equal(h.store.notes.size, 1);
});

test('a later call about a decision’s carry-out gives only what changed; the first one needs its status', async () => {
  const h = harness();
  harbour(h.store);
  reference(h.store, 'ref_d5', 'Decision', 'D5 · the old pay-later flow goes with the next release', { attribution: owner, sourceIds: ['src_plan'], basis: 'Explicit' });
  await ok(h, 'pk_write_thread', { id: 'CKC-07', title: 'CKC-07 · Remove pay-later', progress: 'In progress', serves: [{ referenceId: 'ref_area_payments', claim: 'payments', basis: 'Explicit' }] });
  await incomplete(h, 'pk_record_carry_out', { decisionId: 'ref_d5', workIds: ['CKC-07'] }, /ref_d5 .* has no carry-out recorded yet, so this call would create the carry-out of this decision, and a new one needs status/);
  await ok(h, 'pk_record_carry_out', { decisionId: 'ref_d5', status: 'Partly carried out', remaining: 'the settings page still offers it', workIds: ['CKC-07'], evidenceSourceIds: ['src_code'], basis: 'Explicit' });
  const done = await ok(h, 'pk_record_carry_out', { decisionId: 'ref_d5', status: 'Carried out' });
  const ckc07 = byNumber(h.store, 'CKC-07')!.id;
  assert.deepEqual(done.workIds, [ckc07], 'the work carrying it out stays (named by its number, CKC-07)');
  const carry = h.store.reference.get('ref_d5')!.carryOut!;
  assert.deepEqual([carry.status, carry.remaining, carry.workIds, carry.evidenceSourceIds], ['Carried out', null, [ckc07], ['src_code']]);
  const relation = h.store.relations.find((r) => r.type === 'carries out' && r.from === ckc07)!;
  assert.equal(relation.basis, 'Explicit', 'and its relation keeps its basis');
  await ok(h, 'pk_record_carry_out', { decisionId: 'ref_d5', workIds: [] , status: 'Not carried out yet' });
  assert.equal(h.store.relations.find((r) => r.type === 'carries out'), undefined, 'a workIds list given is the whole list');
});

// ───────────────────────── test-D-1's skeleton, replayed through App and pi ─────────────────────────

type Call = { readonly name: string; readonly args: object };
/** A provider that plays `turns` in order, one per request, and lets the test look at the assets as each request comes. */
function replayProvider(turns: readonly (readonly Call[] | string)[], onRequest: (n: number) => void): Promise<{ url: string; bodies: { messages: { role: string; content: unknown }[] }[]; close(): void }> {
  const bodies: { messages: { role: string; content: unknown }[] }[] = [];
  const server = createServer((req, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(body) as { messages: { role: string; content: unknown }[] });
      onRequest(bodies.length);
      const turn = turns[bodies.length - 1] ?? 'Done.';
      const chunk = (delta: object, finish: string | null) => ({ id: 'replay', object: 'chat.completion.chunk', created: 1, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 80, completion_tokens: 8, total_tokens: 88 } } : {}) });
      const chunks = typeof turn === 'string'
        ? [chunk({ role: 'assistant', content: turn }, null), chunk({}, 'stop')]
        : [chunk({ role: 'assistant', tool_calls: turn.map((c, i) => ({ index: i, id: `call_${bodies.length}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, null), chunk({}, 'tool_calls')];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const value of chunks) res.write(`data: ${JSON.stringify(value)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, bodies, close: () => server.close() })));
}

test('test-D-1 replayed: the contract work items are created, then ten parallel updates with only id, replaceServes and serves all go through and change nothing else', { timeout: 60_000 }, async (t) => {
  const home = mkdtempSync(join(scratch, 'home-'));
  const projectDir = mkdtempSync(join(scratch, 'project-'));
  mkdirSync(join(projectDir, 'docs'));
  writeFileSync(join(projectDir, 'README.md'), '# ContextKeeper replay\n');
  const app = new App(home, { organizing: false });
  app.workspace.setSettings({ watchProjects: false });
  const project = app.addProject('ContextKeeper replay', [projectDir]);
  await app.intakeProject(project.id);
  await app.initKeeper();
  const store = app.store(project.id);
  // The skeleton had the Areas and the contracts before it wrote the work items; each contract refines its Area.
  const numbers = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11];
  const ckc = (n: number) => `CKC-${String(n).padStart(2, '0')}`;
  for (let m = 1; m <= 6; m++) reference(store, `ref_area_m${m}`, 'Area', `CK-M${m}`);
  for (const n of numbers) reference(store, `ref_contract_${n}`, 'Requirement', `${ckc(n)} contract`, { refines: [`ref_area_m${(n % 6) + 1}`] });
  const creates: Call[] = numbers.map((n) => ({ name: 'pk_write_thread', args: {
    acceptance: 'Not yet accepted', id: ckc(n), progress: n === 1 ? 'In progress' : 'Done', results: `P1 batches delivered ${ckc(n)}.`,
    serves: [{ basis: 'Explicit', claim: `${ckc(n)} as the contract says`, referenceId: `ref_contract_${n}` }], title: `${ckc(n)} · work item`,
    ...(n === 3 ? { unresolved: 'AX evidence branch not merged.' } : {}),
  } }));
  const updates: Call[] = numbers.map((n) => ({ name: 'pk_write_thread', args: {
    id: ckc(n), replaceServes: true,
    serves: [{ basis: 'Explicit', claim: 'the area it serves', referenceId: `ref_area_m${(n % 6) + 1}` }, { basis: 'Explicit', claim: `${ckc(n)} as the contract says`, referenceId: `ref_contract_${n}` }],
  } }));
  let afterCreates: WorkThread[] = [];
  const provider = await replayProvider([creates, updates, 'Skeleton written.'], (n) => { if (n === 2) afterCreates = structuredClone(store.threads.all()); });
  try {
    app.keeper.models.registerProvider('fake', { name: 'Local replay fake', baseUrl: provider.url, apiKey: 'fake', api: 'openai-completions', models: [FAKE_MODEL] });
    app.keeper.setModel({ provider: 'fake', id: FAKE_MODEL.id, thinking: null });
    const job = app.keeper.enqueue(project.id, {
      kind: 'Answering', initiator: 'owner', scope: { kind: 'question', ids: [], label: 'Skeleton replay' }, prompt: 'Write the contract work items.',
      step: { roundId: 'crd_replay', kind: 'skeleton', path: null },
    });
    const done = await app.keeper.waitFor(project.id, job.id);
    assert.equal(done.status, 'Done', done.error ?? '');
    assert.equal(provider.bodies.length, 3, 'creates, updates, the answer: nothing refused, nothing re-sent');
    // The results of one turn: the tool messages after the last reply in the request that follows it.
    const results = (i: number) => {
      const messages = provider.bodies[i]!.messages;
      const last = messages.map((m) => m.role).lastIndexOf('assistant');
      return messages.slice(last + 1).filter((m) => m.role === 'tool').map((m) => JSON.parse(String(m.content)) as Record<string, unknown>);
    };
    assert.ok(results(1).every((r) => /serves names no Area or Goal directly/.test(String(r.warning))), 'the creates were told to add the Area, as in test-D-1');
    assert.deepEqual(results(2), numbers.map((n) => ({ id: byNumber(store, ckc(n))!.id, updated: true })), 'all ten updates went through, and nothing was left unplaced');
    assert.equal(done.steps.filter((s) => s.tool === 'pk_write_thread').length, 20);
    assert.equal(done.steps.filter((s) => s.isError).length, 0);
    assert.equal(afterCreates.length, 10);
    for (const before of afterCreates) {
      const now = store.threads.get(before.id)!;
      const n = Number(before.ids[0]!.slice(4));
      assert.deepEqual(now.serves.map((s) => s.referenceId), [`ref_area_m${(n % 6) + 1}`, `ref_contract_${n}`], `${before.ids[0]}: the Area first, then the contract`);
      assert.deepEqual(rest(now, 'serves'), rest(before, 'serves'), `${before.id}: no other field changed`);
    }
    t.diagnostic(JSON.stringify({ status: done.status, requests: provider.bodies.length, updated: results(2).length, timing: done.timing }));
  } finally { provider.close(); app.stopAll(); }
});
