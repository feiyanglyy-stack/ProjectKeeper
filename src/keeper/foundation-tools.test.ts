/**
 * What the Spec v2.8 foundation lets the Keeper store and write, and what it refuses (Spec §1.2, §1.3, §1.8, §1.9,
 * §1.11, §1.15, §2.1, §2.2, §2.4, §2.6, §3.7; CKC-02 AC-5, AC-8, AC-9, AC-23–AC-27; CKC-05 AC-13, AC-15; CKC-06
 * AC-22, AC-24; CKC-21). Every test pairs a write that must be refused — and says why — with the write that must go
 * through, so none of them can pass on code that simply refuses a word it does not know.
 *
 * The fixtures are an invented project, "Ledger", a small invoicing tool. The harness is the one of
 * tools-validation.test.ts, kept local for the same reason given there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { keeperTools, type ToolContext } from './tools.ts';
import { markRefusal, notJudgedReason } from './adjustment.ts';
import { deriveGraph } from './organize/graph.ts';
import type { Project, ReferenceItem, Source, WorkThread } from '../model/types.ts';

const AT = '2026-09-17T00:00:00.000Z';
const LATER = '2026-09-19T09:00:00.000Z';

interface Harness {
  readonly store: ProjectStore;
  readonly ctx: ToolContext;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean; json: Record<string, unknown> }>;
}

function harness(extra: Partial<ToolContext> = {}, shared?: ProjectStore): Harness {
  const store = shared ?? ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-foundation-')));
  const project = { id: 'p1', name: 'Ledger', language: 'en', locations: ['D:\\ledger'], scope: [], roles: [] } as unknown as Project;
  const ctx: ToolContext = { store, project, jobId: 'job_1', jobKind: 'Organizing', model: null, ...extra };
  const tools = keeperTools(ctx);
  return {
    store, ctx,
    async call(name, args) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `no tool ${name}`);
      const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
      const result = await run('call', args);
      const text = result.content.map((c) => c.text).join('\n');
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a refusal is prose, not JSON */ }
      return { text, error: result.isError === true, json };
    },
  };
}

const fileSource = (store: ProjectStore, id: string, path: string, extra: Partial<Source> = {}) =>
  store.sources.put({ id, projectId: 'p1', title: path.split('\\').pop()!, anchor: { kind: 'file', path, headingPath: [], lineStart: 1, lineEnd: 9 }, ids: [], version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt: 'x', usedAs: 'Design', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: 'scope', hasCredential: false, bytes: 10, ...extra } as Source);

const sessionSource = (store: ProjectStore, id: string, excerpt: string, at = AT) =>
  store.sources.put({ id, projectId: 'p1', title: `session ${id}`, anchor: { kind: 'session', host: 'claude', sessionId: id, file: `D:\\s\\${id}.jsonl`, cwd: null, messageStart: 1, messageEnd: 4, at }, ids: [], version: { fingerprint: 'f', readAt: at, commit: null }, excerpt, usedAs: 'Session', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: 'scope', hasCredential: false, bytes: 10 } as Source);

const reference = (store: ProjectStore, id: string, category: string, name: string, extra: Partial<ReferenceItem> = {}) =>
  store.reference.put({ id, projectId: 'p1', category, name, ids: [], text: name, quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT, ...extra } as ReferenceItem);

const thread = (store: ProjectStore, id: string, title: string, extra: Partial<WorkThread> = {}) =>
  store.threads.put({ id, projectId: 'p1', title, ids: [], doing: title, changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, inputs: { jobId: 'j', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: AT, updatedAt: AT, ...extra } as WorkThread);

const owner = { author: { kind: 'owner' as const, name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' as const };
const role = (name: string, identity: 'Artifact' | 'Report') => ({ author: { kind: 'role' as const, name, window: null, host: null, model: null }, holder: null, identity });

const AGENTS_TEXT = 'Everything under vendor/ is third-party code; its documents never define our requirements.';

/** The rules a project like this one writes down for itself, one per material category the tests need. */
async function withRules(h: Harness) {
  // The notes hold the words of every rule the tests write from them as Explicit, the later ones too (an Explicit
  // rule's excerpt is the project's own words, E80).
  fileSource(h.store, 'src_agents', 'D:\\ledger\\AGENTS.md', { excerpt: [
    AGENTS_TEXT, 'attic/ is for recovery only; nothing in it is a requirement.', 'The per-customer export template is withdrawn; use the shared template.',
    'docs/TASKS.md is the task index; its Status column is what counts.', 'Signatures in batch reports are not verified; treat them as unverified.',
    'docs/BOARD.md replaces docs/TASKS.md as the task index.',
  ].join('\n\n') });
  const write = async (args: Record<string, unknown>) => {
    const r = await h.call('pk_write_rule', { group: 'Material rules', sourceIds: ['src_agents'], basis: 'Explicit', ...args });
    assert.equal(r.error, false, r.text);
    return r.json.id as string;
  };
  return {
    referenceOnly: await write({ category: 'Reference only', summary: 'The vendored library’s documents are reference only.', excerpt: AGENTS_TEXT, appliesTo: ['vendor/'] }),
    recovery: await write({ category: 'Recovery only', summary: 'attic/ holds old files kept only for recovery.', excerpt: 'attic/ is for recovery only; nothing in it is a requirement.', appliesTo: ['attic/'] }),
    obsolete: await write({ category: 'Obsolete', summary: 'The per-customer export template is withdrawn.', excerpt: 'The per-customer export template is withdrawn; use the shared template.', appliesTo: ['export templates'] }),
    authoritative: await write({ category: 'Authoritative', summary: 'docs/TASKS.md is the task index and its Status column counts.', excerpt: 'docs/TASKS.md is the task index; its Status column is what counts.', appliesTo: ['docs/TASKS.md', 'work item progress'] }),
    untrusted: await write({ category: 'Untrusted', summary: 'Signatures in batch reports are unverified.', excerpt: 'Signatures in batch reports are not verified; treat them as unverified.', appliesTo: ['reports/'] }),
  };
}

// ───────────────────────── A · the project's rules (Spec §1.15; CKC-21) ─────────────────────────

test('a rule without a source is refused, and so is an Explicit rule without the project’s own words (Spec §1.15; CKC-21 AC-4)', async () => {
  const h = harness();
  fileSource(h.store, 'src_agents', 'D:\\ledger\\AGENTS.md', { excerpt: AGENTS_TEXT });
  const rule = { group: 'Material rules', category: 'Reference only', summary: 'The vendored library’s documents are reference only.', excerpt: AGENTS_TEXT, appliesTo: ['vendor/'], basis: 'Explicit' };

  const noSource = await h.call('pk_write_rule', { ...rule, sourceIds: [] });
  assert.equal(noSource.error, true, noSource.text);
  assert.match(noSource.text, /needs its source/);
  const unknownSource = await h.call('pk_write_rule', { ...rule, sourceIds: ['src_nowhere'] });
  assert.equal(unknownSource.error, true, unknownSource.text);
  assert.match(unknownSource.text, /needs its source/);
  const noWords = await h.call('pk_write_rule', { ...rule, excerpt: '  ', sourceIds: ['src_agents'] });
  assert.equal(noWords.error, true, noWords.text);
  assert.match(noWords.text, /quotes the project’s own words/);
  const nowhere = await h.call('pk_write_rule', { ...rule, sourceIds: ['src_agents'], appliesTo: [] });
  assert.equal(nowhere.error, true, nowhere.text);
  assert.match(nowhere.text, /applies to/);
  assert.equal(h.store.rules.size, 0, 'none of the four wrote a rule');

  const good = await h.call('pk_write_rule', { ...rule, sourceIds: ['src_agents'] });
  assert.equal(good.error, false, good.text);
  const saved = h.store.rules.get(good.json.id as string)!;
  assert.equal(saved.group, 'Material rules');
  assert.equal(saved.category, 'Reference only');
  assert.equal(saved.summary, rule.summary);
  assert.equal(saved.excerpt, AGENTS_TEXT);
  assert.deepEqual(saved.sourceIds, ['src_agents']);
  assert.deepEqual(saved.appliesTo, ['vendor/']);
  assert.equal(saved.basis, 'Explicit');
  assert.equal(saved.validity, 'Current');
  assert.equal(saved.replacedBy, null);
  assert.equal(saved.ownerConfirmation, null);
  const read = await h.call('pk_read_assets', { kind: 'rule', ids: [saved.id] });
  assert.equal(read.error, false, read.text);
  assert.match(read.text, /vendored library/, 'the rule can be read back by id');
});

test('rules are grouped the Spec’s way: a material rule has its category, a working rule has none', async () => {
  const h = harness();
  sessionSource(h.store, 'src_s1', 'Worker: batch 1 done. Reviewer: checked batch 1 independently.');
  sessionSource(h.store, 'src_s2', 'Worker: batch 2 done. Reviewer: checked batch 2 independently.');
  const inferred = { summary: 'Every batch is checked by an independent reviewer before it is merged.', sourceIds: ['src_s1', 'src_s2'], appliesTo: ['every batch'], basis: 'Inferred' };

  const badGroup = await h.call('pk_write_rule', { ...inferred, group: 'Team habits' });
  assert.equal(badGroup.error, true, badGroup.text);
  assert.match(badGroup.text, /group must be one of How work is organized, Working rules, Material rules/);
  const noCategory = await h.call('pk_write_rule', { ...inferred, group: 'Material rules' });
  assert.equal(noCategory.error, true, noCategory.text);
  assert.match(noCategory.text, /needs its category/);
  const strayCategory = await h.call('pk_write_rule', { ...inferred, group: 'How work is organized', category: 'Authoritative' });
  assert.equal(strayCategory.error, true, strayCategory.text);
  assert.match(strayCategory.text, /for material rules only/);
  const confirmedByNobody = await h.call('pk_write_rule', { ...inferred, group: 'How work is organized', ownerConfirmed: { quote: 'yes' } });
  assert.equal(confirmedByNobody.error, true, confirmedByNobody.text);
  assert.match(confirmedByNobody.text, /Only the owner’s message/);
  assert.equal(h.store.rules.size, 0);

  // A rule inferred from practice needs no quotation: it names the records it was inferred from.
  const good = await h.call('pk_write_rule', { ...inferred, group: 'How work is organized' });
  assert.equal(good.error, false, good.text);
  const saved = h.store.rules.get(good.json.id as string)!;
  assert.equal(saved.basis, 'Inferred');
  assert.equal(saved.category, null);
  assert.equal(saved.excerpt, null);
  assert.deepEqual(saved.sourceIds, ['src_s1', 'src_s2']);
});

test('the owner’s confirmation makes an inferred rule Explicit and is kept with the owner’s words (Spec §1.15, §3.9; CKC-21 AC-5)', async () => {
  const job = harness();
  sessionSource(job.store, 'src_s1', 'Reviewer: checked batch 1 independently.');
  const inferred = await job.call('pk_write_rule', { group: 'How work is organized', summary: 'Every batch is checked by an independent reviewer.', sourceIds: ['src_s1'], appliesTo: ['every batch'], basis: 'Inferred' });
  assert.equal(inferred.error, false, inferred.text);
  const id = inferred.json.id as string;

  const quote = 'Yes — every batch goes to an independent reviewer first.';
  const talk = harness({ ownerSourceId: 'src_owner', jobKind: 'Answering' }, job.store);
  sessionSource(talk.store, 'src_owner', `Owner: ${quote}`, LATER);
  const confirmed = await talk.call('pk_write_rule', { id, ownerConfirmed: { quote } });
  assert.equal(confirmed.error, false, confirmed.text);
  const saved = talk.store.rules.get(id)!;
  assert.equal(saved.basis, 'Explicit', 'confirmed by the owner, it is no longer shown as an inference');
  assert.deepEqual([...saved.sourceIds].sort(), ['src_owner', 'src_s1']);
  assert.equal(saved.ownerConfirmation?.sourceId, 'src_owner');
  assert.equal(saved.ownerConfirmation?.quote, quote);
  assert.equal(saved.summary, 'Every batch is checked by an independent reviewer.', 'what was not given keeps its value');

  // A later job that records the same rule again, without its id and as its own inference, does not undo the owner.
  const again = await job.call('pk_write_rule', { group: 'How work is organized', summary: 'Every batch is checked by an independent reviewer.', sourceIds: ['src_s1'], appliesTo: ['every batch'], basis: 'Inferred' });
  assert.equal(again.error, false, again.text);
  assert.equal(again.json.id, id, 'the same rule, not a second one');
  assert.equal(job.store.rules.get(id)!.basis, 'Explicit');
  assert.equal(job.store.rules.get(id)!.ownerConfirmation?.quote, quote);
  assert.ok(job.store.rules.get(id)!.sourceIds.includes('src_owner'), 'and the owner’s message stays among its sources');
});

test('when a rule changes the new one is Current and the old one Replaced, pointing to it; never itself, never in a circle (Spec §1.15; R-49)', async () => {
  const h = harness();
  fileSource(h.store, 'src_handover', 'D:\\ledger\\docs\\HANDOVER.md', { excerpt: 'Task numbers continue from T-40.' });
  fileSource(h.store, 'src_tasks', 'D:\\ledger\\docs\\TASKS.md', { excerpt: 'From now on tasks are numbered L-1, L-2, …' });
  const old = await h.call('pk_write_rule', { group: 'Working rules', summary: 'Tasks are numbered T-n.', excerpt: 'Task numbers continue from T-40.', sourceIds: ['src_handover'], appliesTo: ['task numbering'], basis: 'Explicit' });
  assert.equal(old.error, false, old.text);
  const oldId = old.json.id as string;

  const itself = await h.call('pk_write_rule', { id: oldId, replaces: [oldId] });
  assert.equal(itself.error, true, itself.text);
  assert.match(itself.text, /does not replace itself/);
  const nowhere = await h.call('pk_write_rule', { id: oldId, validity: 'Replaced', replacedBy: 'rule_nowhere' });
  assert.equal(nowhere.error, true, nowhere.text);
  assert.match(nowhere.text, /replacedBy/);
  assert.equal(h.store.rules.get(oldId)!.validity, 'Current');

  const fresh = await h.call('pk_write_rule', { group: 'Working rules', summary: 'Tasks are numbered L-n.', excerpt: 'From now on tasks are numbered L-1, L-2, …', sourceIds: ['src_tasks'], appliesTo: ['task numbering'], basis: 'Explicit', replaces: [oldId] });
  assert.equal(fresh.error, false, fresh.text);
  const freshId = fresh.json.id as string;
  assert.equal(h.store.rules.get(oldId)!.validity, 'Replaced');
  assert.equal(h.store.rules.get(oldId)!.replacedBy, freshId);
  assert.equal(h.store.rules.get(freshId)!.validity, 'Current');

  const circle = await h.call('pk_write_rule', { id: freshId, validity: 'Replaced', replacedBy: oldId });
  assert.equal(circle.error, true, circle.text);
  assert.match(circle.text, /circle/);
  assert.equal(h.store.rules.get(freshId)!.validity, 'Current', 'the refused call changed nothing');
  assert.equal(h.store.rules.get(freshId)!.replacedBy, null);
});

test('a rule about where credentials live keeps the place and never the value (CKC-21 AC-6)', async () => {
  const h = harness();
  // The README as intake keeps it: the value redacted, the place kept.
  fileSource(h.store, 'src_readme', 'D:\\ledger\\README.md', { excerpt: 'Set LEDGER_API_KEY in .env.local:\nLEDGER_API_KEY=[credential redacted] goes in .env.local' });
  const r = await h.call('pk_write_rule', { group: 'Working rules', summary: 'The API key is read from LEDGER_API_KEY in .env.local.', excerpt: 'LEDGER_API_KEY=sk-live1234567890abcdefghij goes in .env.local', sourceIds: ['src_readme'], appliesTo: ['.env.local'], basis: 'Explicit' });
  assert.equal(r.error, false, r.text);
  const saved = h.store.rules.get(r.json.id as string)!;
  assert.ok(!saved.excerpt!.includes('sk-live1234567890abcdefghij'), 'the value is not stored');
  assert.match(saved.excerpt!, /credential redacted/);
  assert.match(saved.summary, /LEDGER_API_KEY/, 'the place is kept');
});

// ───────────────────────── B · the organizing plan and focus (Spec §3.7, D62) ─────────────────────────

test('the organizing plan says what the rules settle, what is read closely and where the focus is; what a rule settles names that rule (Spec §3.7, D62)', async () => {
  const h = harness();
  const rules = await withRules(h);
  const unknownRule = await h.call('pk_write_organizing_plan', { byRule: [{ what: 'the vendored library', targets: ['vendor/'], ruleId: 'rule_nowhere', treatment: 'Reference only' }] });
  assert.equal(unknownRule.error, true, unknownRule.text);
  assert.match(unknownRule.text, /names no rule/);
  const noTargets = await h.call('pk_write_organizing_plan', { byRule: [{ what: 'the vendored library', targets: [], ruleId: rules.referenceOnly, treatment: 'Reference only' }] });
  assert.equal(noTargets.error, true, noTargets.text);
  assert.match(noTargets.text, /names no targets/);
  assert.equal(h.store.plans.size, 0);

  const good = await h.call('pk_write_organizing_plan', {
    byRule: [{ what: 'the vendored chart library', targets: ['vendor/'], ruleId: rules.referenceOnly, treatment: 'Reference only' }, { what: 'old files kept for recovery', targets: ['attic/'], ruleId: rules.recovery, treatment: 'History only' }],
    readClosely: [{ what: 'the task index', targets: ['docs/TASKS.md'], why: 'progress is read from it' }],
    focus: [{ what: 'where the product document and the owner’s words part ways', why: 'drift is judged against the owner’s words' }],
    order: ['the task index', 'the reports that claim completion'],
  });
  assert.equal(good.error, false, good.text);
  const plan = h.store.plans.all()[0]!;
  assert.deepEqual(plan.byRule.map((e) => e.ruleId), [rules.referenceOnly, rules.recovery]);
  assert.deepEqual(plan.byRule[0]!.targets, ['vendor/']);
  assert.equal(plan.readClosely[0]!.what, 'the task index');
  assert.equal(plan.focus[0]!.why, 'drift is judged against the owner’s words');
  assert.deepEqual(plan.order, ['the task index', 'the reports that claim completion']);
  assert.deepEqual(plan.corrections, []);
});

test('the owner corrects the plan in conversation; the correction is kept with the owner’s words and what the plan said before', async () => {
  const job = harness();
  const rules = await withRules(job);
  const first = await job.call('pk_write_organizing_plan', {
    byRule: [{ what: 'the vendored chart library', targets: ['vendor/'], ruleId: rules.referenceOnly, treatment: 'Reference only' }],
    order: ['the handover notes', 'the batch reports'],
  });
  assert.equal(first.error, false, first.text);

  const quote = 'Read the batch reports before the old handover notes.';
  const byJob = await job.call('pk_write_organizing_plan', { order: ['the batch reports', 'the handover notes'], ownerCorrection: { quote, changed: 'batch reports first' } });
  assert.equal(byJob.error, true, byJob.text);
  assert.match(byJob.text, /Only the owner’s message/);

  const talk = harness({ ownerSourceId: 'src_owner', jobKind: 'Answering' }, job.store);
  sessionSource(talk.store, 'src_owner', `Owner: ${quote}`, LATER);
  const corrected = await talk.call('pk_write_organizing_plan', { order: ['the batch reports', 'the handover notes'], ownerCorrection: { quote, changed: 'the batch reports are read before the handover notes' } });
  assert.equal(corrected.error, false, corrected.text);
  let plan = talk.store.plans.all()[0]!;
  assert.deepEqual(plan.order, ['the batch reports', 'the handover notes']);
  assert.equal(plan.corrections.length, 1);
  assert.equal(plan.corrections[0]!.sourceId, 'src_owner');
  assert.equal(plan.corrections[0]!.quote, quote);
  assert.deepEqual(plan.corrections[0]!.previous.order, ['the handover notes', 'the batch reports'], 'what the owner corrected is kept');
  assert.equal(plan.byRule.length, 1, 'what the correction did not touch stays');

  // A later rewrite by a job keeps the owner's correction on record.
  const later = await job.call('pk_write_organizing_plan', { focus: [{ what: 'work still in progress' }] });
  assert.equal(later.error, false, later.text);
  plan = job.store.plans.all()[0]!;
  assert.equal(plan.corrections.length, 1);
  assert.equal(plan.focus[0]!.what, 'work still in progress');
});

test('the owner’s first word on the plan, before any step wrote one, starts it and is kept as a correction (D62)', async () => {
  const talk = harness({ ownerSourceId: 'src_owner', jobKind: 'Answering' });
  const quote = 'Read the task index in full before anything else.';
  sessionSource(talk.store, 'src_owner', `Owner: ${quote}`, LATER);
  const r = await talk.call('pk_write_organizing_plan', { readClosely: [{ what: 'the task index', targets: ['docs/TASKS.md'] }], order: ['the task index'], ownerCorrection: { quote, changed: 'the task index is read in full, first' } });
  assert.equal(r.error, false, r.text);
  const plan = talk.store.plans.all()[0]!;
  assert.equal(plan.readClosely[0]!.what, 'the task index');
  assert.equal(plan.corrections.length, 1, 'the owner’s words are kept as a correction');
  assert.equal(plan.corrections[0]!.quote, quote);
  assert.deepEqual(plan.corrections[0]!.previous, { byRule: [], readClosely: [], focus: [], order: [] }, 'it replaced no plan');
});

// ───────────────────────── C · the owner's words (Spec §1.3; CKC-05 AC-13) ─────────────────────────

test("an Owner's words item carries the owner’s own words and where they were said; an agent’s restatement is not one (Spec §1.3; CKC-05 AC-13)", async () => {
  const h = harness();
  const quote = 'Invoices must never be deleted, only voided.';
  sessionSource(h.store, 'src_talk', `Owner: ${quote}`);
  const words = { category: "Owner's words", name: 'Invoices are voided, never deleted', text: 'The owner wants every invoice kept: voided, never deleted.', basis: 'Explicit', validity: 'Current', identity: 'Decision', authorKind: 'owner' };

  const noQuote = await h.call('pk_write_reference', { ...words, sourceIds: ['src_talk'] });
  assert.equal(noQuote.error, true, noQuote.text);
  assert.match(noQuote.text, /carries the owner’s own words/);
  const noSource = await h.call('pk_write_reference', { ...words, quote, sourceIds: [] });
  assert.equal(noSource.error, true, noSource.text);
  assert.match(noSource.text, /names where the owner said it/);
  const restated = await h.call('pk_write_reference', { ...words, quote, sourceIds: ['src_talk'], authorKind: 'agent', authorName: 'Product architect', identity: 'Artifact' });
  assert.equal(restated.error, true, restated.text);
  assert.match(restated.text, /restatement/);
  assert.equal(h.store.reference.size, 0);

  const good = await h.call('pk_write_reference', { ...words, quote, sourceIds: ['src_talk'] });
  assert.equal(good.error, false, good.text);
  assert.equal(good.json.warning, undefined, 'the top layer refines nothing and is not told it is unplaced');
  const item = h.store.reference.get(good.json.id as string)!;
  assert.equal(item.category, "Owner's words");
  assert.equal(item.quote, quote);
  assert.deepEqual(item.sourceIds, ['src_talk']);
  assert.equal(item.attribution.author.kind, 'owner');
  assert.equal(item.attribution.identity, 'Decision');

  // The product description refines the owner's words, and the graph draws that layer.
  fileSource(h.store, 'src_product', 'D:\\ledger\\docs\\PRODUCT.md');
  const product = await h.call('pk_write_reference', { category: 'Product', name: 'Ledger', text: 'A small invoicing tool for freelancers.', basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: ['src_product'], refines: [item.id] });
  assert.equal(product.error, false, product.text);
  deriveGraph(h.store, h.ctx.project);
  assert.equal(h.store.nodes.get(item.id)?.category, "Owner's words");
  assert.ok(h.store.relations.find((r) => r.type === 'refines' && r.from === product.json.id && r.to === item.id), 'refines runs from the product description to the owner’s words');
});

// ───────────────────────── D · decided without the owner (Spec §1.9, §1.11; CKC-05 AC-15, CKC-02 AC-8) ─────────────────────────

test('Decided without owner hangs on a rule in force that a role set in the owner’s place, with who set it and when (CKC-05 AC-15; CKC-02 AC-8)', async () => {
  const h = harness();
  fileSource(h.store, 'src_receipt', 'D:\\ledger\\reports\\batch-3.md', { usedAs: 'Status', excerpt: 'Settled: exported invoices drop the customer tax number.' });
  reference(h.store, 'ref_settled', 'Decision', 'Exports drop the tax number', { attribution: role('Execution orchestrator', 'Report'), sourceIds: ['src_receipt'] });
  reference(h.store, 'ref_owner', 'Decision', 'D3 · Invoices are voided, never deleted', { attribution: owner });
  reference(h.store, 'ref_gone', 'Decision', 'An older export rule', { attribution: role('Execution orchestrator', 'Report'), validity: 'Replaced', replacedBy: 'ref_settled' });
  const mark = (targetId: string, extra: Record<string, unknown> = {}) => h.call('pk_write_mark', {
    kind: 'Decided without owner', targetId, clue: 'Only the batch-3 receipt says this was settled; no owner decision or product document has it.', clueSourceIds: ['src_receipt'], ...extra,
  });
  const who = { decidedBy: 'Execution orchestrator', decidedAt: '2026-09-17' };

  const onOwner = await mark('ref_owner', who);
  assert.equal(onOwner.error, true, onOwner.text);
  assert.match(onOwner.text, /owner’s own decision/);
  const onGone = await mark('ref_gone', who);
  assert.equal(onGone.error, true, onGone.text);
  assert.match(onGone.text, /in force/);
  const nobody = await mark('ref_settled');
  assert.equal(nobody.error, true, nobody.text);
  assert.match(nobody.text, /who set it and when/);
  assert.equal(h.store.marks.size, 0);

  const good = await mark('ref_settled', who);
  assert.equal(good.error, false, good.text);
  const saved = h.store.marks.get(good.json.id as string)!;
  assert.equal(saved.kind, 'Decided without owner');
  assert.equal(saved.targetId, 'ref_settled');
  assert.deepEqual(saved.decidedBy, { who: 'Execution orchestrator', at: '2026-09-17' });
  const item = h.store.reference.get('ref_settled')!;
  assert.equal(item.validity, 'Current', 'it is in force, so it stays Current');
  assert.notEqual(item.attribution.identity, 'Decision', 'and it is not recorded as the owner’s decision');
});

// ───────────────────────── E · who claimed it, and when (Spec §2.4; CKC-06 AC-22, CKC-02 AC-9) ─────────────────────────

test('a Claimed statement says who claimed it and when, and a claim dated by day keeps its day (CKC-06 AC-22; CKC-02 AC-9)', async () => {
  const h = harness();
  fileSource(h.store, 'src_receipt', 'D:\\ledger\\reports\\batch-3.md', { usedAs: 'Status' });
  const claim = { type: 'Claimed', text: 'The export no longer writes the tax number.', sourceIds: ['src_receipt'] };
  const record = (statements: unknown[]) => h.call('pk_write_fact_record', { title: 'Batch 3 receipt', aboutSourceIds: ['src_receipt'], statements });

  const bare = await record([claim]);
  assert.equal(bare.error, true, bare.text);
  assert.match(bare.text, /who claimed it and when/);
  const noWhen = await record([{ ...claim, claimedBy: 'Worker agent' }]);
  assert.equal(noWhen.error, true, noWhen.text);
  assert.match(noWhen.text, /who claimed it and when/);
  const vague = await record([{ ...claim, claimedBy: 'Worker agent', claimedAt: 'last week' }]);
  assert.equal(vague.error, true, vague.text);
  assert.match(vague.text, /claimedAt must be/);
  assert.equal(h.store.facts.size, 0);

  const good = await record([
    { ...claim, claimedBy: 'Worker agent (batch 3 receipt)', claimedAt: '2026-09-17' },
    { type: 'Observed', text: 'The receipt is dated 2026-09-17.', sourceIds: ['src_receipt'] },
  ]);
  assert.equal(good.error, false, good.text);
  const [claimed, observed] = h.store.facts.get(good.json.id as string)!.statements;
  assert.deepEqual(claimed!.claimedBy, { who: 'Worker agent (batch 3 receipt)', at: '2026-09-17', untrustedRuleId: null });
  assert.equal(observed!.claimedBy, undefined, 'an observed fact is not a claim');

  // The same holds for the facts a work item keeps.
  const qc = await h.call('pk_write_thread', { title: 'L-2 · export', progress: 'Done', qcFacts: [{ type: 'Claimed', text: 'QC passed', sourceIds: ['src_receipt'] }] });
  assert.equal(qc.error, true, qc.text);
  assert.match(qc.text, /who claimed it and when/);
});

test('a claim from a source the project marks untrusted names that rule and stays Claimed (Spec §1.15 Untrusted)', async () => {
  const h = harness();
  const rules = await withRules(h);
  fileSource(h.store, 'src_receipt', 'D:\\ledger\\reports\\batch-3.md', { usedAs: 'Status' });
  const claim = { type: 'Claimed', text: 'Signed off by the reviewer.', sourceIds: ['src_receipt'], claimedBy: 'batch 3 receipt', claimedAt: '2026-09-17' };
  const record = (statements: unknown[]) => h.call('pk_write_fact_record', { title: 'Batch 3 receipt', aboutSourceIds: ['src_receipt'], statements });

  const wrongRule = await record([{ ...claim, untrustedRuleId: rules.referenceOnly }]);
  assert.equal(wrongRule.error, true, wrongRule.text);
  assert.match(wrongRule.text, /must name an Untrusted rule/);
  const observed = await record([{ type: 'Observed', text: 'Signed off by the reviewer.', sourceIds: ['src_receipt'], untrustedRuleId: rules.untrusted }]);
  assert.equal(observed.error, true, observed.text);
  assert.match(observed.text, /stays Claimed/);
  assert.equal(h.store.facts.size, 0);

  const good = await record([{ ...claim, untrustedRuleId: rules.untrusted }]);
  assert.equal(good.error, false, good.text);
  assert.equal(h.store.facts.get(good.json.id as string)!.statements[0]!.claimedBy?.untrustedRuleId, rules.untrusted);
});

// ───────────────────────── F · a decision's carry-out (Spec §2.2; CKC-02 AC-26) ─────────────────────────

test('a decision that asks for something shows whether it was carried out, linked by carries out to the work (CKC-02 AC-26)', async () => {
  const h = harness();
  fileSource(h.store, 'src_dec', 'D:\\ledger\\docs\\DECISIONS.md');
  fileSource(h.store, 'src_code', 'D:\\ledger\\src\\export.ts', { usedAs: 'Code' });
  reference(h.store, 'ref_dec', 'Decision', 'D5 · the old CSV export goes with the next release', { attribution: owner, sourceIds: ['src_dec'] });
  reference(h.store, 'ref_req', 'Requirement', 'R-2 · export invoices to CSV', { sourceIds: ['src_dec'] });
  thread(h.store, 'thread_cleanup', 'L-7 · remove the old CSV export', { ids: ['L-7'] });
  const carry = (args: Record<string, unknown>) => h.call('pk_record_carry_out', args);

  const notDecision = await carry({ decisionId: 'ref_req', status: 'Carried out', workIds: ['thread_cleanup'] });
  assert.equal(notDecision.error, true, notDecision.text);
  assert.match(notDecision.text, /not a decision/);
  const noRest = await carry({ decisionId: 'ref_dec', status: 'Partly carried out', workIds: ['thread_cleanup'] });
  assert.equal(noRest.error, true, noRest.text);
  assert.match(noRest.text, /still left/);
  const noWork = await carry({ decisionId: 'ref_dec', status: 'Carried out', workIds: [] });
  assert.equal(noWork.error, true, noWork.text);
  assert.match(noWork.text, /names the work that carries it out/);
  const badStatus = await carry({ decisionId: 'ref_dec', status: 'Done', workIds: ['thread_cleanup'] });
  assert.equal(badStatus.error, true, badStatus.text);
  assert.match(badStatus.text, /status must be one of Carried out, Partly carried out, Not carried out yet/);
  assert.equal(h.store.reference.get('ref_dec')!.carryOut, undefined);
  assert.equal(h.store.relations.size, 0);

  const partly = await carry({ decisionId: 'ref_dec', status: 'Partly carried out', remaining: 'the settings page still offers the old export', workIds: ['thread_cleanup'], evidenceSourceIds: ['src_code'] });
  assert.equal(partly.error, false, partly.text);
  let dec = h.store.reference.get('ref_dec')!;
  assert.equal(dec.carryOut?.status, 'Partly carried out');
  assert.equal(dec.carryOut?.remaining, 'the settings page still offers the old export');
  assert.deepEqual(dec.carryOut?.workIds, ['thread_cleanup']);
  assert.equal(dec.validity, 'Current', 'a decision being carried out stays Current, it is not moved into history');
  assert.ok(h.store.relations.find((r) => r.type === 'carries out' && r.from === 'thread_cleanup' && r.to === 'ref_dec'), 'the work is linked to the decision by carries out');

  const done = await carry({ decisionId: 'ref_dec', status: 'Carried out', workIds: ['thread_cleanup'], evidenceSourceIds: ['src_code'] });
  assert.equal(done.error, false, done.text);
  dec = h.store.reference.get('ref_dec')!;
  assert.equal(dec.carryOut?.status, 'Carried out');
  assert.equal(dec.carryOut?.remaining, null);

  // Re-reading the decision record rewrites its text, never what the carry-out check found.
  const reread = await h.call('pk_write_reference', { id: 'ref_dec', category: 'Decision', name: 'D5 · the old CSV export goes with the next release', text: 'D5 as re-read', basis: 'Explicit', validity: 'Current', identity: 'Decision', authorKind: 'owner', sourceIds: ['src_dec'] });
  assert.equal(reread.error, false, reread.text);
  assert.equal(h.store.reference.get('ref_dec')!.carryOut?.status, 'Carried out');

  const relateToRequirement = await h.call('pk_relate', { type: 'carries out', fromId: 'thread_cleanup', toId: 'ref_req', claim: 'L-7 carries out R-2', basis: 'Inferred' });
  assert.equal(relateToRequirement.error, true, relateToRequirement.text);
  assert.match(relateToRequirement.text, /ends at a decision/);
});

// ───────────────────────── G · history only, reference only, removed (Spec §1.2, §2.1, §2.6; CKC-02 AC-5, AC-23, AC-25) ─────────────────────────

test('history-only and reference-only material forms no current product reference (CKC-02 AC-23, AC-25)', async () => {
  const h = harness();
  fileSource(h.store, 'src_attic', 'D:\\ledger\\attic\\export-v1.md');
  fileSource(h.store, 'src_vendor', 'D:\\ledger\\vendor\\chartlib\\ROADMAP.md');
  fileSource(h.store, 'src_design', 'D:\\ledger\\docs\\EXPORT.md');
  const history = await h.call('pk_set_used_as', { sourceId: 'src_attic', usedAs: 'History only' });
  assert.equal(history.error, false, history.text);
  const vendor = await h.call('pk_set_used_as', { sourceId: 'src_vendor', usedAs: 'Reference only' });
  assert.equal(vendor.error, false, vendor.text);
  const item = (name: string, category: string, sourceIds: string[]) => h.call('pk_write_reference', { category, name, text: name, basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds });

  const fromHistory = await item('Export v1 design', 'Design', ['src_attic']);
  assert.equal(fromHistory.error, true, fromHistory.text);
  assert.match(fromHistory.text, /History only/);
  const fromVendor = await item('Chart library release plan', 'Plan', ['src_vendor']);
  assert.equal(fromVendor.error, true, fromVendor.text);
  assert.match(fromVendor.text, /Reference only/);
  assert.equal(h.store.reference.size, 0);

  const citing = await item('Export design', 'Design', ['src_design', 'src_vendor']);
  assert.equal(citing.error, false, 'a reference-only document can be cited next to the project’s own');
});

test('an object whose material was deleted becomes Removed; a move removes nothing (CKC-02 AC-5)', async () => {
  const h = harness();
  fileSource(h.store, 'src_live', 'D:\\ledger\\docs\\LIVE.md');
  fileSource(h.store, 'src_moved', 'D:\\ledger\\docs\\MOVED.md', { availability: 'Moved', movedTo: 'D:\\ledger\\docs\\archive\\MOVED.md' });
  fileSource(h.store, 'src_gone', 'D:\\ledger\\docs\\GONE.md', { availability: 'No longer available' });
  const removed = (id: string, sourceIds: string[]) => h.call('pk_write_reference', { id, category: 'Design', name: id, text: id, basis: 'Explicit', validity: 'Removed', identity: 'Artifact', sourceIds });

  const live = await removed('ref_live', ['src_live']);
  assert.equal(live.error, true, live.text);
  assert.match(live.text, /was deleted/);
  const moved = await removed('ref_moved', ['src_moved']);
  assert.equal(moved.error, true, moved.text);
  assert.match(moved.text, /moved, not deleted/);
  assert.equal(h.store.reference.size, 0);

  const gone = await removed('ref_gone', ['src_gone']);
  assert.equal(gone.error, false, gone.text);
  assert.equal(h.store.reference.get('ref_gone')!.validity, 'Removed');
  // What is no longer in the project is not maintained, so a later change cannot leave it behind (§2.10), and a
  // doubt about a later change belongs on the current object still relying on it (§2.1).
  assert.equal(notJudgedReason(h.store, 'ref_gone'), 'Point-in-time record');
  assert.match(markRefusal(h.store, 'Suspected stale', 'ref_gone', 'a later change touched it', ['src_live'], null) ?? '', /point-in-time record/);
});

// ───────────────────────── H · an object judged by one of the project's rules (Spec §1.15; CKC-02 AC-24, CKC-06 AC-24) ─────────────────────────

test('an object judged by one of the project’s rules names that rule, and the rule has to be one that says so (CKC-02 AC-24; CKC-06 AC-24)', async () => {
  const h = harness();
  const rules = await withRules(h);
  fileSource(h.store, 'src_vendor', 'D:\\ledger\\vendor\\chartlib\\README.md');
  fileSource(h.store, 'src_attic', 'D:\\ledger\\attic\\old.md');
  fileSource(h.store, 'src_tpl', 'D:\\ledger\\docs\\TEMPLATES.md');

  const wrongRule = await h.call('pk_set_used_as', { sourceId: 'src_vendor', usedAs: 'Reference only', byRuleId: rules.authoritative });
  assert.equal(wrongRule.error, true, wrongRule.text);
  assert.match(wrongRule.text, /needs a Reference only rule/);
  const byRule = await h.call('pk_set_used_as', { sourceId: 'src_vendor', usedAs: 'Reference only', byRuleId: rules.referenceOnly });
  assert.equal(byRule.error, false, byRule.text);
  assert.equal(h.store.sources.get('src_vendor')!.usedAsByRuleId, rules.referenceOnly);
  const recovery = await h.call('pk_set_used_as', { sourceId: 'src_attic', usedAs: 'History only', byRuleId: rules.recovery });
  assert.equal(recovery.error, false, recovery.text);

  const template = { category: 'Design', name: 'Per-customer export template', text: 'Each customer gets an export template of its own.', identity: 'Artifact', sourceIds: ['src_tpl'] };
  const inferred = await h.call('pk_write_reference', { ...template, basis: 'Inferred', validity: 'Abandoned', validityByRuleId: rules.obsolete });
  assert.equal(inferred.error, true, inferred.text);
  assert.match(inferred.text, /Explicit/);
  const stillCurrent = await h.call('pk_write_reference', { ...template, basis: 'Explicit', validity: 'Current', validityByRuleId: rules.obsolete });
  assert.equal(stillCurrent.error, true, stillCurrent.text);
  assert.match(stillCurrent.text, /Replaced or Abandoned/);
  assert.equal(h.store.reference.size, 0);
  const withdrawn = await h.call('pk_write_reference', { ...template, basis: 'Explicit', validity: 'Abandoned', validityByRuleId: rules.obsolete });
  assert.equal(withdrawn.error, false, withdrawn.text);
  assert.equal(h.store.reference.get(withdrawn.json.id as string)!.validityByRuleId, rules.obsolete);

  // Progress by the authoritative index: the rule has to be in force.
  const newer = await h.call('pk_write_rule', { group: 'Material rules', category: 'Authoritative', summary: 'The board, not TASKS.md, is the index now.', excerpt: 'docs/BOARD.md replaces docs/TASKS.md as the task index.', sourceIds: ['src_agents'], appliesTo: ['work item progress'], basis: 'Explicit', replaces: [rules.authoritative] });
  assert.equal(newer.error, false, newer.text);
  const byOldIndex = await h.call('pk_write_thread', { title: 'L-3 · void an invoice', ids: ['L-3'], progress: 'Done', progressByRuleId: rules.authoritative });
  assert.equal(byOldIndex.error, true, byOldIndex.text);
  assert.match(byOldIndex.text, /not in force/);
  const byIndex = await h.call('pk_write_thread', { title: 'L-3 · void an invoice', ids: ['L-3'], progress: 'Done', progressByRuleId: newer.json.id });
  assert.equal(byIndex.error, false, byIndex.text);
  assert.equal(h.store.threads.get(byIndex.json.id as string)!.progressByRuleId, newer.json.id);
});

test('a new work item carrying a number another work item already has is refused and pointed at that one (Spec §1.4, §2.6; CKC-06 AC-24)', async () => {
  const h = harness();
  const first = await h.call('pk_write_thread', { title: 'L-4 · export invoices', ids: ['L-4'], progress: 'In progress' });
  assert.equal(first.error, false, first.text);
  const again = await h.call('pk_write_thread', { title: 'Batch 2 · export', ids: ['B-2', 'L-4'], progress: 'Done' });
  assert.equal(again.error, true, again.text);
  assert.match(again.text, /already the number of work item/);
  assert.ok(again.text.includes(first.json.id as string), 'the refusal names the work item that has it');
  assert.equal(h.store.threads.size, 1, 'no second work item for the same unit');
  // The same number under its own id is the ordinary update.
  const update = await h.call('pk_write_thread', { title: 'L-4 · export invoices', ids: ['L-4'], progress: 'Done', results: 'exports run nightly' });
  assert.equal(update.error, false, update.text);
  assert.equal(update.json.id, first.json.id);
});

// ───────────────────────── I · time precision (Spec §1.8; CKC-02 AC-27) ─────────────────────────

test('a change item the material dates only by day keeps the day (CKC-02 AC-27)', async () => {
  const h = harness();
  fileSource(h.store, 'src_dec', 'D:\\ledger\\docs\\DECISIONS.md');
  reference(h.store, 'ref_d', 'Decision', 'D6 · exports are signed', { attribution: owner });
  const change = (at: string) => h.call('pk_write_change', {
    workKind: 'Time range', workLabel: 'DECISIONS.md, 2026-09-17', workStartedAt: '2026-09-17', workEndedAt: '2026-09-17', sourceIds: ['src_dec'],
    items: [{ at, material: 'Decision', effect: 'Added', title: 'D6 · exports are signed', summary: 'Every export is signed.', byOwner: true, affects: ['ref_d'] }],
  });
  const impossible = await change('2026-13-40');
  assert.equal(impossible.error, true, impossible.text);
  const good = await change('2026-09-17');
  assert.equal(good.error, false, good.text);
  const record = h.store.changes.get(good.json.id as string)!;
  assert.equal(record.items![0]!.at, '2026-09-17', 'no midnight UTC is added');
  assert.equal(record.at, '2026-09-17');
  assert.equal(record.work!.startedAt, '2026-09-17');
});

test('a rule of how work is organized names the steps the project expects of its work, for the breakpoints (Spec §2.12)', async () => {
  const h = harness();
  fileSource(h.store, 'src_agents', 'D:\ledger\AGENTS.md', { excerpt: 'Every batch is checked by another agent before it is merged; a fix is checked again.' });
  const base = { group: 'How work is organized', summary: 'Every batch gets an independent check, and a fix is checked again.', sourceIds: ['src_agents'], appliesTo: ['every batch'], basis: 'Inferred' };

  const bad = await h.call('pk_write_rule', { ...base, expects: ['Independent check', 'Daily standup'] });
  assert.equal(bad.error, true, bad.text);
  assert.match(bad.text, /Daily standup is not one of/);
  const misplaced = await h.call('pk_write_rule', { ...base, group: 'Working rules', expects: ['Independent check'] });
  assert.equal(misplaced.error, true, misplaced.text);
  assert.match(misplaced.text, /How work is organized/);

  const good = await h.call('pk_write_rule', { ...base, expects: ['Independent check', 'Re-check after fix', 'Independent check'] });
  assert.equal(good.error, false, good.text);
  const id = good.json.id as string;
  assert.deepEqual(h.store.rules.get(id)!.expects, ['Independent check', 'Re-check after fix'], 'each step once');
  const updated = await h.call('pk_write_rule', { id, summary: 'Every batch gets an independent check; a fix is checked again.' });
  assert.equal(updated.error, false, updated.text);
  assert.deepEqual(h.store.rules.get(id)!.expects, ['Independent check', 'Re-check after fix'], 'an update that leaves expects out keeps it');
});
