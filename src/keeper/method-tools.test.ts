/**
 * What the organizing method needs from the tools, and what they refuse (batch C2; Spec §1.9, §1.15, §2.4, §3.3, §3.9,
 * §5.5; CKC-06 AC-22, AC-23; CKC-21 AC-5). Every refusal is paired with the write that must go through, so no test can
 * pass on a tool that simply refuses everything.
 *
 * - A check of a claim against the code is recorded next to the claim, with its order and result, so how many claims
 *   were checked, in which order and how many did not hold can be counted from the assets.
 * - The rules inferred in a round are put to the owner in one note for the round.
 * - An execution batch's account is recorded as its claim, with who and when — not as an unsourced fact.
 * - Only a Follow up round's main job judges propagation: an owner's conversation opens no round, during the takeover or
 *   after it.
 *
 * The fixtures are an invented project, "Harbour", a berth-booking service.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ProjectStore } from '../store/project-store.ts';
import { keeperTools, type ToolContext } from './tools.ts';
import { roundTools } from './round-tools.ts';
import * as roles from './roles.ts';
import type { FactRecord, KeeperJob, Project, ProjectRule, Source, Statement, TakeoverStatus, WorkThread } from '../model/types.ts';

const AT = '2026-09-18T00:00:00.000Z';

interface Harness {
  readonly store: ProjectStore;
  readonly ctx: ToolContext;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean; json: Record<string, unknown> }>;
}

function harness(extra: Partial<ToolContext> = {}, shared?: ProjectStore): Harness {
  const store = shared ?? ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-method-tools-')));
  const project = { id: 'p1', name: 'Harbour', language: 'en', locations: ['D:\\harbour'], scope: [], roles: [] } as unknown as Project;
  const ctx: ToolContext = { store, project, jobId: 'job_main', jobKind: 'Organizing', model: null, ...extra };
  const tools = [...keeperTools(ctx), ...roundTools(ctx)];
  return {
    store, ctx,
    async call(name, args) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `no tool ${name}`);
      const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
      const result = await run('call', args);
      const text = result.content.map((c) => c.text).join('\n');
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a refusal is prose */ }
      return { text, error: result.isError === true, json };
    },
  };
}

const fileSource = (store: ProjectStore, id: string, path: string, extra: Partial<Source> = {}) =>
  store.sources.put({ id, projectId: 'p1', title: path.split('\\').pop()!, anchor: { kind: 'file', path, headingPath: [], lineStart: 1, lineEnd: 200 }, ids: [], version: { fingerprint: 'f', readAt: AT, commit: 'c0ffee1234567890' }, excerpt: 'x', usedAs: null, usedAsBy: null, availability: null, movedTo: null, scopeItemId: 'scope', hasCredential: false, bytes: 10, ...extra } as Source);

const claim = (id: string, text: string, sourceIds: readonly string[]): Statement => ({ id, type: 'Claimed', text, sourceIds, claimedBy: { who: 'Worker agent, batch 3 receipt', at: '2026-09-17', untrustedRuleId: null } });

function withReport(h: Harness): FactRecord {
  fileSource(h.store, 'src_receipt', 'D:\\harbour\\reports\\batch-3.md');
  fileSource(h.store, 'src_code', 'D:\\harbour\\src\\booking\\retry.ts');
  fileSource(h.store, 'src_doc', 'D:\\harbour\\docs\\DESIGN.md');
  const record = {
    id: 'fact_receipt', projectId: 'p1', title: 'Batch 3 receipt', aboutSourceIds: ['src_receipt'],
    statements: [
      claim('st_retry', 'A failed booking is retried three times before the user sees an error.', ['src_receipt']),
      claim('st_flag', 'The waitlist switch is off by default.', ['src_receipt']),
      { id: 'st_seen', type: 'Observed', text: 'The receipt lists five files.', sourceIds: ['src_receipt'] },
    ],
    decisions: [], changes: [], openQuestions: [], executionFacts: [], language: 'en',
    inputs: { jobId: 'j', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: AT, updatedAt: AT, pendingSourceIds: [],
  } as unknown as FactRecord;
  h.store.facts.put(record);
  return record;
}

const check = (over: Record<string, unknown> = {}) => ({
  factRecordId: 'fact_receipt', claim: 'A failed booking is retried three times before the user sees an error.',
  tier: 'Done or verified', result: 'Inconsistent', codeSourceIds: ['src_code'], lines: '40-58',
  observed: 'The booking call is retried once, then the error is shown.', ...over,
});

// ───────────────────────── claims checked against the code (Spec §2.4; CKC-06 AC-23) ─────────────────────────

test('a check of a claim against the code is refused unless it names the claim, its order, its result and the code it read', async () => {
  const h = harness();
  withReport(h);
  const refusals: [Record<string, unknown>, RegExp][] = [
    [check({ factRecordId: 'fact_nowhere' }), /fact_nowhere is not a fact record/],
    [check({ claim: 'Bookings are stored for ten years.' }), /No claim in fact_receipt reads/],
    [check({ claim: 'The receipt lists five files.' }), /No claim in fact_receipt reads/],
    [check({ tier: 'Urgent' }), /tier must be one of Owner's words or red line, Done or verified, Other/],
    [check({ result: 'Looks fine' }), /result must be one of Consistent, Inconsistent, Partly consistent/],
    [check({ codeSourceIds: ['src_doc'] }), /is not code/],
    [check({ codeSourceIds: [] }), /codeSourceIds/],
    [check({ lines: '' }), /lines/],
    [check({ observed: '  ' }), /what the code does/],
  ];
  for (const [args, reason] of refusals) {
    const r = await h.call('pk_record_code_check', args);
    assert.equal(r.error, true, `${JSON.stringify(args)} → ${r.text}`);
    assert.match(r.text, reason);
  }
  assert.equal(h.store.facts.get('fact_receipt')!.statements.length, 3, 'nothing was written by a refused check');

  const good = await h.call('pk_record_code_check', check());
  assert.equal(good.error, false, good.text);
  const record = h.store.facts.get('fact_receipt')!;
  assert.equal(record.statements.length, 4);
  const observed = record.statements[3]!;
  assert.equal(observed.type, 'Observed', 'what the code shows is an observation');
  assert.deepEqual(observed.sourceIds, ['src_code'], 'anchored to the code it was read in');
  assert.match(observed.text, /retried once/);
  assert.match(observed.text, /retry\.ts:40-58/, 'the anchor names the file and the lines');
  assert.match(observed.text, /c0ffee1234/, 'and the commit the code was read at');
  const c = (observed as Statement & { check?: { of: string; tier: string; result: string; anchor: { file: string; lines: string; commit: string | null } } }).check;
  assert.deepEqual({ of: c?.of, tier: c?.tier, result: c?.result, lines: c?.anchor.lines, commit: c?.anchor.commit }, { of: 'st_retry', tier: 'Done or verified', result: 'Inconsistent', lines: '40-58', commit: 'c0ffee1234567890' });
  assert.equal(record.statements[0]!.type, 'Claimed', 'the claim stays as it was reported');
  assert.match(good.text, /contradicts/, 'the caller is told what the main job writes next for a claim that did not hold');

  // Checking the same claim again replaces the check; it does not add a second one.
  const again = await h.call('pk_record_code_check', check({ result: 'Consistent', claim: 'st_retry', observed: 'Retried three times, then the error is shown.' }));
  assert.equal(again.error, false, again.text);
  const checks = h.store.facts.get('fact_receipt')!.statements.filter((s) => (s as { check?: unknown }).check);
  assert.equal(checks.length, 1, 'one check per claim');
  assert.equal((checks[0] as { check: { result: string } }).check.result, 'Consistent');
});

test('a check stays beside its claim when the report’s fact record is written again, and goes when the claim goes', async () => {
  const h = harness({ materials: [{ key: 'file:D:\\harbour\\reports\\batch-3.md', sourceIds: ['src_receipt'] }] });
  fileSource(h.store, 'src_receipt', 'D:\\harbour\\reports\\batch-3.md');
  fileSource(h.store, 'src_code', 'D:\\harbour\\src\\booking\\retry.ts');
  const claimOf = (text: string) => ({ type: 'Claimed', text, sourceIds: ['src_receipt'], claimedBy: 'Worker agent, batch 3 receipt', claimedAt: '2026-09-17' });
  const write = (statements: unknown[]) => h.call('pk_write_fact_record', { title: 'Batch 3 receipt', aboutSourceIds: ['src_receipt'], statements });
  const first = await write([claimOf('A failed booking is retried three times before the user sees an error.'), claimOf('The waitlist switch is off by default.')]);
  assert.equal(first.error, false, first.text);
  const id = first.json.id as string;
  const checked = await h.call('pk_record_code_check', check({ factRecordId: id }));
  assert.equal(checked.error, false, checked.text);
  const checksOf = () => h.store.facts.get(id)!.statements.filter((s) => s.check);

  const rewritten = await write([claimOf('A failed booking is retried three times before the user sees an error.'), claimOf('The waitlist switch is off by default.'), { type: 'Open', text: 'Which release carries it?', sourceIds: ['src_receipt'] }]);
  assert.equal(rewritten.error, false, rewritten.text);
  const kept = checksOf();
  assert.equal(kept.length, 1, 'the check survives the record being written again');
  const claimNow = h.store.facts.get(id)!.statements.find((s) => s.type === 'Claimed' && s.text.startsWith('A failed booking'))!;
  assert.equal(kept[0]!.check!.of, claimNow.id, 'and points at the claim as it now is');

  const dropped = await write([claimOf('The waitlist switch is off by default.')]);
  assert.equal(dropped.error, false, dropped.text);
  assert.equal(checksOf().length, 0, 'a claim no longer in the record takes its check with it');
});

// ───────────────────────── the rules inferred in a round, put to the owner once (Spec §3.9; CKC-21 AC-5) ─────────────────────────

/** The harness's job as the synthesis of a takeover's deepening round (Spec v3.0 §3.3): the step that puts the rules to the owner. */
function inRound(h: Harness): void {
  h.store.clerkRounds.put({ id: 'crd_deepen', projectId: 'p1', kind: 'Deepen', number: 2, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT });
  h.store.jobs.put({ id: 'job_main', projectId: 'p1', kind: 'Product re-look', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['crd_deepen'], label: 'Synthesis' }, status: 'Running', queuedAt: AT, startedAt: AT, endedAt: null, savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: 'job_root', resultText: null, priority: 1, task: { extra: { kind: 'clerk-step', roundId: 'crd_deepen', route: 'synthesis' } }, step: { roundId: 'crd_deepen', kind: 'synthesis', path: null } } as unknown as KeeperJob);
}
const rule = (h: Harness, id: string, over: Partial<ProjectRule> = {}) => h.store.rules.put({ id, projectId: 'p1', group: 'How work is organized', category: null, summary: `rule ${id}`, excerpt: null, sourceIds: ['src_receipt'], appliesTo: ['every batch'], basis: 'Inferred', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: 'job_main', asOf: AT, updatedAt: AT, ...over } as ProjectRule);

test('the rules a round inferred go to the owner in one For your decision note for the round, each with what it rests on', async () => {
  const h = harness();
  withReport(h);
  inRound(h);
  rule(h, 'rule_review', { summary: 'Every batch is reviewed by another agent before it is merged.' });
  rule(h, 'rule_numbers', { summary: 'Task numbers continue the index without gaps.' });
  rule(h, 'rule_written', { basis: 'Explicit', excerpt: 'Push only to the review branch.', summary: 'Pushes go to the review branch.' });
  rule(h, 'rule_confirmed', { ownerConfirmation: { sourceId: 'src_receipt', quote: 'yes', at: AT } });
  rule(h, 'rule_old_round', { jobId: 'job_earlier' });
  rule(h, 'rule_withdrawn', { validity: 'Replaced', replacedBy: 'rule_review' });
  const refusals: [Record<string, unknown>, RegExp][] = [
    [{ rules: [] }, /Name the rules/],
    [{ rules: [{ ruleId: 'rule_nowhere', changes: 'x' }] }, /rule_nowhere is not one of the project’s rules/],
    [{ rules: [{ ruleId: 'rule_written', changes: 'x' }] }, /written in the project/],
    [{ rules: [{ ruleId: 'rule_confirmed', changes: 'x' }] }, /already confirmed/],
    [{ rules: [{ ruleId: 'rule_withdrawn', changes: 'x' }] }, /is Replaced: only a rule in force/],
    [{ rules: [{ ruleId: 'rule_old_round', changes: 'x' }] }, /not inferred in this round/],
    [{ rules: [{ ruleId: 'rule_review', changes: ' ' }] }, /what it changes/],
  ];
  for (const [args, reason] of refusals) {
    const r = await h.call('pk_ask_owner_about_rules', args);
    assert.equal(r.error, true, `${JSON.stringify(args)} → ${r.text}`);
    assert.match(r.text, reason);
  }
  assert.equal(h.store.notes.size, 0);

  const first = await h.call('pk_ask_owner_about_rules', { rules: [{ ruleId: 'rule_review', changes: 'an agent asks for a review before merging' }] });
  assert.equal(first.error, false, first.text);
  const second = await h.call('pk_ask_owner_about_rules', { rules: [{ ruleId: 'rule_numbers', changes: 'an agent takes the next number from the index' }] });
  assert.equal(second.error, false, second.text);
  assert.equal(h.store.notes.size, 1, 'one note for the round, not one per rule or per call');
  const note = h.store.notes.all()[0]!;
  const v = note.versions[note.versions.length - 1]!;
  assert.equal(v.ask, 'For your decision');
  assert.equal(note.mount.kind, 'project');
  assert.equal(v.body.facts.length, 2, 'both rules are listed');
  for (const f of v.body.facts) { assert.deepEqual(f.sourceIds, ['src_receipt'], 'each with the records it was inferred from'); assert.equal(f.inferred, true); }
  assert.ok(v.body.facts.some((f) => f.text.includes('reviewed by another agent') && f.text.includes('asks for a review')), 'each with what it changes for an agent');
  assert.ok(h.store.judgements.has(v.judgementRecordId), 'based on a judgement record');
  assert.equal(note.cameFrom?.kind, 'Takeover');
  // One question: the first sentence asks it, and the title says the same (Spec §4.2, D105).
  const marks = (t: string) => t.split('?').length - 1;
  assert.equal((marks(v.preview) || marks(v.title)) + marks(v.body.whatWouldSettleIt ?? ''), 1, 'one question');
  assert.match(v.preview, /^Do the 2 rules this round inferred from the project’s records hold\? Each would change how an agent works on the project\./);
  assert.equal(v.body.options?.length, 3, 'with the owner’s options, each with what follows');
  // No store id in what the owner reads: which rule a fact is about is its link.
  assert.deepEqual(v.body.facts.map((f) => f.ruleId).sort(), ['rule_numbers', 'rule_review']);
  assert.doesNotMatch([v.title, v.preview, v.body.currentView, ...v.body.facts.map((f) => f.text)].join(' '), /rule_(review|numbers)/);
});

test('outside a round there is no round note to put inferred rules in', async () => {
  const h = harness({ jobId: 'job_conversation' });
  withReport(h);
  rule(h, 'rule_review', { jobId: 'job_conversation' });
  const r = await h.call('pk_ask_owner_about_rules', { rules: [{ ruleId: 'rule_review', changes: 'x' }] });
  assert.equal(r.error, true, r.text);
  assert.match(r.text, /a round’s main job/);
});

test('by the clerk method the synthesis puts the rules its round inferred to the owner, in one note for the round (Spec v3.0 §3.3, §3.9)', async () => {
  const h = harness({ jobId: 'job_syn' });
  const step = (id: string, kind: string, roundId: string) => h.store.jobs.put({ id, projectId: 'p1', kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: [roundId], label: kind }, status: 'Running', queuedAt: AT, startedAt: AT, endedAt: null, savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: 'job_root', resultText: null, priority: 1, task: { extra: { kind: 'clerk-step', roundId, route: kind } }, step: { roundId, kind, path: null } } as unknown as KeeperJob);
  h.store.clerkRounds.put({ id: 'crd_1', projectId: 'p1', kind: 'First usable', number: 1, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT });
  step('job_orient', 'orientation', 'crd_1');
  step('job_syn', 'synthesis', 'crd_1');
  step('job_earlier', 'orientation', 'crd_0');
  rule(h, 'rule_review', { jobId: 'job_orient' });
  rule(h, 'rule_earlier', { jobId: 'job_earlier' });

  const earlier = await h.call('pk_ask_owner_about_rules', { rules: [{ ruleId: 'rule_earlier', changes: 'x' }] });
  assert.equal(earlier.error, true, earlier.text);
  assert.match(earlier.text, /not inferred in this round/, 'another round’s rule went into that round’s note');
  const asked = await h.call('pk_ask_owner_about_rules', { rules: [{ ruleId: 'rule_review', changes: 'an agent asks for a review before merging' }] });
  assert.equal(asked.error, false, `the orientation inferred it, the synthesis puts it to the owner: ${asked.text}`);
  assert.ok(h.store.notes.has('note_rules-crd_1'), 'one note for the round, keyed to the round');
});

// ───────────────────────── an execution batch’s account is its claim (Spec §2.4; batch A item 3) ─────────────────────────

const thread = (store: ProjectStore, id: string, title: string) =>
  store.threads.put({ id, projectId: 'p1', title, ids: [], doing: title, changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, inputs: { jobId: 'j', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: AT, updatedAt: AT, pendingSourceIds: [] } as unknown as WorkThread);

test('an execution batch that says what it did records that as its claim, never as an unsourced fact', async () => {
  const h = harness();
  withReport(h);
  thread(h.store, 'thread_w1', 'W-1 booking form');
  const told = await h.call('pk_write_thread', { title: 'Batch 3', progress: 'Done', results: 'the booking form is finished', carriesOut: ['thread_w1'] });
  assert.equal(told.error, true, told.text);
  assert.match(told.text, /executionFacts/);
  assert.match(told.text, /Claimed/);
  assert.equal(h.store.threads.get('thread_w1')!.executionFacts.length, 0, 'nothing was written');

  const ok = await h.call('pk_write_thread', {
    title: 'Batch 3', progress: 'Done', results: 'the booking form is finished', carriesOut: ['thread_w1'],
    executionFacts: [{ type: 'Claimed', text: 'The booking form is finished.', sourceIds: ['src_receipt'], claimedBy: 'Worker agent, batch 3 receipt', claimedAt: '2026-09-17' }],
  });
  assert.equal(ok.error, false, ok.text);
  const facts = h.store.threads.get('thread_w1')!.executionFacts;
  assert.ok(facts.length >= 1);
  assert.ok(facts.every((f) => f.type !== 'Observed' || f.sourceIds.length > 0), 'no unsourced observation');
  assert.ok(facts.some((f) => f.type === 'Claimed' && f.claimedBy?.who.includes('batch 3')), 'the claim says whose it is');
  const progressOnly = await h.call('pk_write_thread', { title: 'Batch 4', progress: 'Done', carriesOut: ['thread_w1'] });
  assert.equal(progressOnly.error, false, 'a batch that only moves progress needs no statement');
});

// ───────────────────────── only a Follow up round's main job judges propagation (Spec §3.3, §5.5; C1 item 3; D2) ─────────────────────────

test('an owner’s conversation judges nothing for propagation and opens no round, while the project is being taken over or after', async () => {
  const h = harness({ jobId: 'job_conversation', jobKind: 'Answering' });
  // The job record the runtime keeps for a turn of the owner's conversation.
  h.store.jobs.put({ id: 'job_conversation', projectId: 'p1', kind: 'Answering', initiator: 'owner', scope: { kind: 'conversation', ids: ['conv_1'], label: 'is W-1 behind?' }, status: 'Running', queuedAt: AT, startedAt: AT, endedAt: null, savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: null, resultText: null, priority: 0, task: { extra: { conversationId: 'conv_1', question: 'is W-1 behind?', context: null, ownerSourceId: 'src_msg', turn: 1 } } } as unknown as KeeperJob);
  thread(h.store, 'thread_w1', 'W-1 booking form');
  h.store.setCoverage({ ...h.store.coverage, takeover: { stage: 'Deepening' } as unknown as TakeoverStatus });
  const during = await h.call('pk_judge_object', { nodeId: 'thread_w1', state: 'Reusable as is', sourceOrReason: 'nothing it relies on changed' });
  assert.equal(during.error, true, during.text);
  assert.equal(h.store.rounds.size, 0, 'no round was opened');

  // After the takeover it is still the Follow up round's main job that judges: the owner who wants it now presses
  // Follow up, which starts a round with its own main job (Spec §3.8), rather than the conversation opening one.
  h.store.setCoverage({ ...h.store.coverage, takeover: { stage: 'Daily' } as unknown as TakeoverStatus });
  const after = await h.call('pk_judge_object', { nodeId: 'thread_w1', state: 'Reusable as is', sourceOrReason: 'nothing it relies on changed' });
  assert.equal(after.error, true, after.text);
  assert.match(after.text, /main job/);
  assert.equal(h.store.rounds.size, 0, 'the conversation opens no round after the takeover either');
});

// ───────────────────────── a product reference item’s holder (Spec §1.9, §3.7, §5.4) ─────────────────────────

test('a product reference item records the role that holds it', async () => {
  const h = harness();
  fileSource(h.store, 'src_spec', 'D:\\harbour\\docs\\SPEC.md');
  const r = await h.call('pk_write_reference', { category: 'Design', name: 'Booking spec', text: 'How booking behaves.', basis: 'Explicit', validity: 'Current', identity: 'Artifact', authorKind: 'role', authorName: 'Architect', holderRole: 'Architect', sourceIds: ['src_spec'] });
  assert.equal(r.error, false, r.text);
  assert.equal(h.store.reference.get(r.json.id as string)!.attribution.holder?.role, 'Architect');
  const again = await h.call('pk_write_reference', { id: r.json.id, category: 'Design', name: 'Booking spec', text: 'How booking behaves, v2.', basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: ['src_spec'] });
  assert.equal(again.error, false, again.text);
  assert.equal(h.store.reference.get(r.json.id as string)!.attribution.holder?.role, 'Architect', 'an update that names no holder keeps it');
});

// ───────────────────────── which job gets which tool, and the owner’s-words ledger (Spec §3.3, §3.7) ─────────────────────────

test('a subagent can record a code check; putting rules to the owner is a round’s synthesis’s, classifying the scope its orientation’s', () => {
  const names = ['pk_record_code_check', 'pk_ask_owner_about_rules', 'pk_classify_scope', 'pk_write_fact_record'].map((name) => ({ name }));
  const sub = roles.toolsFor(names, 'subagent').map((t) => t.name);
  assert.deepEqual(sub.sort(), ['pk_record_code_check', 'pk_write_fact_record'], 'a subagent checks claims in the order it was given');
  assert.ok(roles.stepToolsFor(names, 'synthesis', 'Deepen').some((t) => t.name === 'pk_ask_owner_about_rules'));
  assert.ok(roles.stepToolsFor(names, 'orientation', 'First usable').some((t) => t.name === 'pk_classify_scope'));
  const other = roles.toolsFor(names, 'other').map((t) => t.name);
  assert.ok(!other.includes('pk_ask_owner_about_rules'), 'only a round has a round note to put inferred rules in');
});

test('reading the owner’s words is counted where the job’s steps record it: how many messages, how many characters', async () => {
  const utterances: ToolDefinition = defineTool({
    name: 'pk_owner_utterances', label: 'stub', description: 'stub', parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: JSON.stringify({ utterances: [{ sourceId: 's1', host: 'claude', at: AT, text: 'Keep it simple.', chars: 15 }, { sourceId: 's2', host: 'claude', at: AT, text: 'No ads, ever.', chars: 13 }], next: '2', total: 5, totalChars: 70 }) }], details: {} }),
  });
  for (const [wrapped] of [roles.stepToolsFor([utterances], 'orientation', 'First usable'), roles.toolsFor([utterances], 'other')]) {
    const run = wrapped!.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[] }>;
    const text = (await run('c', {})).content[0]!.text;
    assert.match(text.slice(0, 160), /^Read 2 of the owner’s 5 messages \(28 of 70 characters\)/, 'the count leads the answer, where the job’s step keeps it');
    assert.ok(text.includes('"utterances"'), 'and the answer itself follows unchanged');
  }
});
