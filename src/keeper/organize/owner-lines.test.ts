/**
 * The owner's Decision and Confirmation lines no position cites yet (Spec §3.11, §1.15; CKC-21, CKC-23 AC-18). test-C-1:
 * the orchestrator's session draft held the owner's answers 「让各自commit就可以」 and 「可以，需要的时候就即时更新」 as a
 * Confirmation, and neither became a rule or an Owner's words item.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClerkRound, SessionDraft, SlotKind } from '../../model/k-types.ts';
import type { Project, ProjectRule, ReferenceItem, Source } from '../../model/types.ts';
import { ProjectStore } from '../../store/project-store.ts';
import { keeperTools, type ToolContext } from '../tools.ts';
import { writeRefusal } from './stage-gate.ts';
import { carries, fold, GENERATION_WORDS, judgedLinesBlock, ownerLineTools, ownerLinesBlock, ownerLinesCountBlock, ownerWordsContextRefusal, standsAlone, uncitedOwnerLines, wordParts } from './owner-lines.ts';

const now = '2026-09-27T08:00:00Z';
const attribution = { author: { kind: 'owner', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' } as const;

function session(id: string, start: number, end: number, excerpt: string, at: string): Source {
  return {
    id, projectId: 'p', title: `claude session s1 [${start}-${end}]`, anchor: { kind: 'session', host: 'claude', sessionId: 's1', file: 's1.jsonl', cwd: null, messageStart: start, messageEnd: end, at },
    ids: [], version: { fingerprint: '', readAt: now, commit: null }, excerpt, usedAs: null, usedAsBy: null, availability: null, movedTo: null, scopeItemId: 'p', hasCredential: false, bytes: excerpt.length,
  } as unknown as Source;
}
function rule(id: string, excerpt: string, sourceIds: string[]): ProjectRule {
  return { id, projectId: 'p', group: 'Working rules', category: null, summary: excerpt, excerpt, sourceIds, appliesTo: ['the whole project'], basis: 'Explicit', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: null, asOf: now, updatedAt: now };
}
function reference(id: string, category: ReferenceItem['category'], quote: string | null, sourceIds: string[]): ReferenceItem {
  return { id, projectId: 'p', category, name: id, ids: [], text: id, quote, basis: 'Explicit', validity: 'Current', progress: null, attribution, sourceIds, refines: [], replacedBy: null, inputs: null, asOf: now, updatedAt: now } as unknown as ReferenceItem;
}

const THREE_ANSWERS = 'Who commits changes to the documents? 让各自commit就可以，Should I download pi 0.87.1 可以，需要的时候就即时更新。';

function seed(): ProjectStore {
  const store = ProjectStore.open('p', mkdtempSync(join(tmpdir(), 'pk-owner-lines-')));
  store.sources.put(session('src_seg1', 0, 9, '[3] OWNER 2026-09-27 05:43\nWho commits … 让各自commit就可以 …', '2026-09-27T05:40:00Z'));
  store.sources.put(session('src_seg2', 10, 20, '[12] OWNER\n以后大批审核都给 Kimi K3，Codex 只给小而聚焦的任务\n[15] OWNER\n对的', '2026-09-27T06:00:00Z'));
  store.sources.put({ ...session('src_doc', 0, 0, '', now), anchor: { kind: 'file', path: 'D:/p/subagent/DECISIONS.md', headingPath: [], lineStart: 1, lineEnd: 9 } } as unknown as Source);
  const draft: SessionDraft = {
    id: 'draft_s1', projectId: 'p', session: { host: 'claude', sessionId: 's1', file: 's1.jsonl', startedAt: '2026-09-27T05:00:00Z', endedAt: '2026-09-27T07:00:00Z' },
    ownerLines: [
      { ref: '3', at: '2026-09-27T05:43:41Z', text: THREE_ANSWERS, kind: 'Confirmation', answers: 'Who commits changes to the documents? …', confirms: 'the owner confirmed the orchestrator’s proposal that each role commits its own documents, and that pi is updated when needed' },
      { ref: '12', at: '2026-09-27T06:01:00Z', text: '以后大批审核都给 Kimi K3，Codex 只给小而聚焦的任务', kind: 'Decision', answers: null, confirms: null },
      { ref: '15', at: '2026-09-27T06:05:00Z', text: '对的', kind: 'Decision', answers: null, confirms: null },
      { ref: '17', at: '2026-09-27T06:06:00Z', text: '好的，谢谢', kind: 'Chat', answers: null, confirms: null },
    ],
    agentSummary: [], jobId: null, at: now,
  };
  store.drafts.put(draft);
  // A rule quoting the second line's words from the decision record (not the session): its words cite the line.
  store.rules.put(rule('rule_review', '大批审核都给 Kimi K3', ['src_doc']));
  // An Owner's words item quoting 「对的」 on the line's own segment: a short part counts only there.
  store.reference.put(reference('ref_yes', "Owner's words", '「对的」', ['src_seg2']));
  // A decision citing the first line's segment with no words of its own.
  store.reference.put(reference('ref_segment', 'Decision', null, ['src_seg1']));
  return store;
}

test('how words are compared: only the words, and a quote in its parts', () => {
  assert.equal(fold('「让各自 commit 就可以」。'), '让各自commit就可以');
  assert.deepEqual(wordParts('「今天证伪了一个事情」……「pi 很难代替 explore」'), ['今天证伪了一个事情', 'pi很难代替explore']);
  const onSeg = new Set(['src_seg2']);
  assert.equal(carries({ id: 'r', kind: 'rule', label: '', words: ['大批审核都给 Kimi K3'], sourceIds: ['src_doc'] }, fold('以后大批审核都给 Kimi K3，Codex …'), onSeg), true, 'a long enough part tells the line apart wherever it is cited from');
  assert.equal(carries({ id: 'r', kind: 'reference', label: '', words: ['对的'], sourceIds: ['src_other'] }, fold('对的'), onSeg), false, 'a short part elsewhere does not');
  assert.equal(carries({ id: 'r', kind: 'reference', label: '', words: ['对的'], sourceIds: ['src_seg2'] }, fold('对的'), onSeg), true, 'a short part on the line’s own segment does');
});

test('the owner’s lines no rule, Owner’s words item or decision cites, whatever the draft labelled them (CM) — here the confirmation of two working rules', () => {
  const store = seed();
  const r = uncitedOwnerLines(store, null);
  assert.equal(r.considered, 4, 'the Chat line is one of them: a label is the draft’s reading, never a filter (CM, E151)');
  assert.deepEqual(r.cited.map((c) => [c.line.ref, c.by]).sort(), [['12', ['rule_review']], ['15', ['ref_yes']]]);
  assert.deepEqual(r.lines.map((l) => l.ref), ['17', '3']);
  assert.equal(r.lines[0]!.kind, 'Chat', 'the label stays on the line');
  const line = r.lines[1]!;
  assert.deepEqual(line.sourceIds, ['src_seg1'], 'the segment its message position falls in: the source to cite');
  assert.deepEqual(line.segmentCitedBy.map((i) => i.id), ['ref_segment'], 'an item citing its segment with no words of its own is named beside it');
});

test('the block gives each line verbatim, with what it confirms and the source to cite', () => {
  const store = seed();
  const block = ownerLinesBlock(store, null);
  assert.match(block, /^=== The owner's lines no position cites yet/);
  assert.match(block, /2 of the 4 owner's lines in the 1 session drafts are cited, 0 judged to need nothing, 2 not looked at yet\./);
  assert.match(block, /- 2026-09-27 05:43 · Confirmation · claude session s1 · line draft_s1:3 · cite src_seg1\n  the owner's message: 「Who commits changes to the documents\? 让各自commit就可以，Should I download pi 0\.87\.1 可以，需要的时候就即时更新。」/);
  assert.match(block, /what it confirms \(the draft's words, not the owner's\): the owner confirmed the orchestrator’s proposal that each role commits its own documents/);
  assert.match(block, /its segment is cited, with no words of its own, by: ref_segment/);
  assert.match(block, /the owner's message: 「好的，谢谢」\n  too short to stand alone, and the program has no message it answers: read its segment\. An item that quotes this line gives what it answers \(answers\)\./, 'DA: a line too short to stand alone is given with what it answers, as far as the program has it');
  assert.doesNotMatch(block, /让各自commit就可以[^\n]*\n[^\n]*\n  too short/, 'a line that stands alone is not');

  // Once a rule carries the owner's words (as its excerpt, citing the segment), the line leaves the list.
  store.rules.put(rule('rule_commit', '让各自commit就可以', ['src_seg1']));
  store.rules.put(rule('rule_thanks', '好的，谢谢', ['src_seg2']));
  assert.match(ownerLinesBlock(store, null), /None left: 4 of the 4 owner's lines in the 1 session drafts are cited, 0 judged to need nothing, 0 not looked at yet\./);
});

test('a Follow up: the lines since the last round in full, the earlier ones one line each', () => {
  const store = seed();
  const block = ownerLinesBlock(store, null, { since: '2026-09-27T06:00:00Z' });
  assert.match(block, /2 of the 4 owner's lines in the 1 session drafts are cited, 0 judged to need nothing, 2 not looked at yet: 1 said since 2026-09-27 06:00 \(in full\), 1 earlier\./);
  assert.match(block, /Said before 2026-09-27 06:00 and still not looked at \(1; pk_read_assets kind draft for any of them in full\):\n- 2026-09-27 05:43 · Confirmation/);
});

test('with no draft yet the block says so', () => {
  const store = ProjectStore.open('q', mkdtempSync(join(tmpdir(), 'pk-owner-lines-')));
  assert.match(ownerLinesBlock(store, null), /No session draft yet\./);
});

test('the main agent gets a count and the lines that name generations; the label does not hide one (CM, E151)', () => {
  const store = seed();
  const draft = store.drafts.all()[0]!;
  store.drafts.put({ ...draft, ownerLines: [...draft.ownerLines, { ref: '20', at: '2026-09-27T06:10:00Z', text: '更早还有两代，Module v0.1–v0.3 与文档链 v1.0；文档链 v2.0–v3.x', kind: 'Chat', answers: null, confirms: null }] });
  const block = ownerLinesCountBlock(store, null);
  assert.match(block, /^=== The owner's lines no position cites yet \(a count; the full list goes to the lane you give the slot reference:Owner's words\)/);
  assert.match(block, /2 of the 5 owner's lines in the 1 session drafts are cited, 0 judged to need nothing, 3 not looked at yet \(the drafts labelled those 2 Chat, 1 Confirmation\)/);
  assert.match(block, /1 of them name versions, generations or a supersession/);
  assert.match(block, /- 2026-09-27 06:10 · Chat · draft_s1, 20: 「更早还有两代，Module v0\.1–v0\.3 与文档链 v1\.0；文档链 v2\.0–v3\.x」/);
  assert.doesNotMatch(block, /让各自commit就可以/, 'the full list stays out of the main agent’s context');
  assert.ok(GENERATION_WORDS.test('上一代的计划') && !GENERATION_WORDS.test('代码领地'), 'generation words, not code');
});

// ───────────────────────── DA: the third outcome, and a short quote with what it answers ─────────────────────────

const project = { id: 'p', name: 'P', locations: [], scope: [], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en' } as unknown as Project;
const roundOf = (id: string, startedAt: string): ClerkRound => ({
  id, projectId: 'p', kind: 'First usable', number: 1, startedAt, endedAt: null, status: 'Running', rootJobId: 'job_root', questionsDocId: null, paths: [], outputs: [], groundwork: [],
  unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: startedAt, stage: 'skeleton', stageLog: [], lanes: [],
} as unknown as ClerkRound);
const laneCtx = (store: ProjectStore, roundId: string, slots: SlotKind[]): ToolContext => ({ store, project, jobId: 'job_lane', jobKind: 'Organizing', model: null, step: { roundId, kind: 'lane', path: 'Product and owner', lane: { kind: 'slot', slots } } } as unknown as ToolContext);
const mainCtx = (store: ProjectStore, roundId: string): ToolContext => ({ store, project, jobId: 'job_main', jobKind: 'Organizing', model: null, step: { roundId, kind: 'main', path: null } } as unknown as ToolContext);
async function judge(ctx: ToolContext, args: Record<string, unknown>) {
  const tool = ownerLineTools(ctx).find((t) => t.name === 'pk_judge_owner_lines')!;
  const result = await (tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)('call', args);
  const out = result.content.map((x) => x.text).join('\n');
  return { text: out, error: result.isError === true, json: result.isError ? null : JSON.parse(out) as Record<string, unknown> };
}

test('a line for its moment only is judged to need nothing: it leaves the count, is not given again, and the spot-check samples it (DA)', async () => {
  const store = seed();
  store.clerkRounds.put(roundOf('crd_1', '2026-09-27T08:00:00Z'));
  const lane = laneCtx(store, 'crd_1', ["reference:Owner's words"]);

  // Who may: the lane with the Owner's words slot, and the main agent in reconcile or the cross-check.
  assert.equal(writeRefusal(store, lane.step, 'pk_judge_owner_lines', { lines: [] }), null);
  assert.match(writeRefusal(store, laneCtx(store, 'crd_1', ['reference:Decision']).step, 'pk_judge_owner_lines', { lines: [] }) ?? '', /the slot reference:Owner's words; this lane \(Product and owner\) writes reference:Decision/);
  assert.match(writeRefusal(store, mainCtx(store, 'crd_1').step, 'pk_judge_owner_lines', { lines: [] }) ?? '', /written in the reconcile or cross-check stage/);
  assert.equal((await judge(laneCtx(store, 'crd_1', ['reference:Decision']), { lines: ['draft_s1:17'], why: 'thanks' })).error, true, 'the tool itself refuses a lane without the slot');

  // By line reference, many in one call, with why; a cited line needs no judgement, an unknown reference is said.
  const empty = await judge(lane, { lines: ['draft_s1:17'], why: ' ' });
  assert.match(empty.text, /why is empty/);
  const r = await judge(lane, { lines: ['draft_s1:17', 'draft_s1:12', 'draft_s1:99'], why: 'thanks at the end of the exchange: for that moment only' });
  assert.equal(r.error, false, r.text);
  assert.deepEqual([r.json!.judged, r.json!.cited, r.json!.judgedToNeedNothing, r.json!.notLookedAtYet], [1, 2, 1, 1]);
  assert.deepEqual(r.json!.unknown, ['draft_s1:99']);
  assert.match(String((r.json!.alreadyCited as string[])[0]), /^draft_s1:12 \(cited by rule_review\)/);

  // It leaves the count, and the list.
  const after = uncitedOwnerLines(store, null);
  assert.deepEqual(after.lines.map((l) => l.ref), ['3']);
  assert.deepEqual(after.judged.map((l) => [l.ref, l.why, l.by, l.lane, l.roundId]), [['17', 'thanks at the end of the exchange: for that moment only', 'lane', 'Product and owner', 'crd_1']]);
  const block = ownerLinesBlock(store, null);
  assert.match(block, /2 of the 4 owner's lines in the 1 session drafts are cited, 1 judged to need nothing, 1 not looked at yet\./);
  assert.doesNotMatch(block, /好的，谢谢/, 'the judged line is not given again');
  assert.match(ownerLinesCountBlock(store, null), /2 of the 4 owner's lines in the 1 session drafts are cited, 1 judged to need nothing, 1 not looked at yet \(the drafts labelled those 1 Confirmation\)/);
  assert.match((await judge(lane, { lines: ['draft_s1:17'], why: 'again' })).text, /judged already: draft_s1:17/);

  // Not given again in a later round; the main agent may judge too, in the stages that list it.
  store.clerkRounds.put({ ...roundOf('crd_2', '2026-09-28T08:00:00Z'), kind: 'Deepen', number: 2, stage: 'cross-check' } as ClerkRound);
  assert.doesNotMatch(ownerLinesBlock(store, null, { since: '2026-09-27T00:00:00Z' }), /好的，谢谢/);
  assert.equal(writeRefusal(store, mainCtx(store, 'crd_2').step, 'pk_judge_owner_lines', { lines: [] }), null);

  // The next spot-check — the deepening's: a first usable round has none — is given the count, the reasons and a sample
  // of what was judged since the last one, whichever round judged it; once a spot-check has had them, a later one has none.
  const sample = judgedLinesBlock(store, { id: 'crd_2' }, null)!;
  assert.match(sample, /^=== The owner's lines judged to need nothing since the last spot-check \(1; the program's record — a sample of 1 to check\)/);
  assert.match(sample, /The reasons given: “thanks at the end of the exchange: for that moment only” \(1\)\./);
  assert.match(sample, /- 2026-09-27 06:06 · Chat · line draft_s1:17 · cite src_seg2 · judged by the lane Product and owner: [^\n]*\n  the owner's message: 「好的，谢谢」/);
  store.jobs.put({ id: 'job_spot', projectId: 'p', kind: 'Organizing', status: 'Done', queuedAt: new Date(Date.now() + 1000).toISOString(), steps: [], step: { roundId: 'crd_2', kind: 'spot-check', path: null } } as never);
  assert.match(judgedLinesBlock(store, { id: 'crd_2' }, null) ?? '', /since the last spot-check \(1;/, 'the same spot-check, started again, keeps them');
  assert.equal(judgedLinesBlock(store, { id: 'crd_3' }, null), null, 'a later round’s spot-check is not given them again');

  // A line whose words changed since is looked at again; a line cited afterwards is cited.
  const draft = store.drafts.all()[0]!;
  store.drafts.put({ ...draft, ownerLines: draft.ownerLines.map((l) => (l.ref === '17' ? { ...l, text: '好的，谢谢。以后 QC 都另开窗口做' } : l)) });
  assert.deepEqual(uncitedOwnerLines(store, null).lines.map((l) => l.ref), ['17', '3'], 'the judgement was of other words');
  store.drafts.put(draft);
  store.rules.put(rule('rule_thanks', '好的，谢谢', ['src_seg2']));
  const cited = uncitedOwnerLines(store, null);
  assert.deepEqual([cited.cited.length, cited.judged.length, cited.lines.length], [3, 0, 1], 'a cited line is cited, whatever was judged of it');
});

test('a quote too short to stand alone is an Owner’s words item only with the message it answers (DA; Spec §3.11)', async () => {
  const store = seed();
  assert.equal(standsAlone('「对的」'), false);
  assert.equal(standsAlone('「可以」……「对的」'), false, 'every part is short');
  assert.equal(standsAlone('以后大批审核都给 Kimi K3'), true);
  // The segment holds the agent's question and the owner's 「对的」; the draft's line has what the program took as answered.
  store.sources.put(session('src_seg2', 10, 20, '[12] OWNER\n以后大批审核都给 Kimi K3，Codex 只给小而聚焦的任务\n[14] AGENT\nSo bulk review goes to Kimi K3 from now on, and Codex keeps the small focused tasks — is that right?\n[15] OWNER\n对的', '2026-09-27T06:00:00Z'));
  const draft = store.drafts.all()[0]!;
  store.drafts.put({ ...draft, ownerLines: draft.ownerLines.map((l) => (l.ref === '15' ? { ...l, kind: 'Confirmation' as const, answers: 'So bulk review goes to Kimi K3 from now on, and Codex keeps the small focused tasks — is that right? (and a second paragraph the segment cut off)' } : l)) });

  const none = ownerWordsContextRefusal(store, { quote: '对的', answers: '', sourceIds: ['src_seg2'] });
  assert.match(none ?? '', /「对的」 is too short to stand alone as an Owner's words item \(when the owner says “ok” or 「可以」, look at what it answers\)\. Give answers: the message it answers/);
  assert.match(none ?? '', /The message before it, as the program has it: 「So bulk review goes to Kimi K3 from now on/, 'the refusal gives what the program has');
  assert.match(none ?? '', /judge it with pk_judge_owner_lines instead\. Nothing was written\./);
  assert.equal(ownerWordsContextRefusal(store, { quote: '对的', answers: 'bulk review goes to Kimi K3 from now on …… is that right?', sourceIds: ['src_seg2'] }), null, 'copied from the segment cited');
  assert.equal(ownerWordsContextRefusal(store, { quote: '对的', answers: 'and a second paragraph the segment cut off', sourceIds: ['src_seg2'] }), null, 'or from the message the program has before the line');
  assert.match(ownerWordsContextRefusal(store, { quote: '对的', answers: 'The agent proposed a new review policy and the owner agreed.', sourceIds: ['src_seg2'] }) ?? '', /stands neither in the sources cited nor in the agent's message before the owner's line/);
  assert.equal(ownerWordsContextRefusal(store, { quote: '以后大批审核都给 Kimi K3，Codex 只给小而聚焦的任务', answers: '', sourceIds: ['src_seg2'] }), null, 'no length filter beyond that: a quote that stands alone needs no context');

  // Through pk_write_reference: refused without, written with, and the item keeps what it answers.
  const tools = keeperTools({ store, project, jobId: 'job_lane', jobKind: 'Organizing', model: null });
  const write = async (args: Record<string, unknown>) => {
    const result = await (tools.find((t) => t.name === 'pk_write_reference')!.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)('call', args);
    return { text: result.content.map((x) => x.text).join('\n'), error: result.isError === true };
  };
  const item = { category: "Owner's words", name: 'Bulk review goes to Kimi K3', text: 'The owner confirmed that bulk review goes to Kimi K3.', quote: '对的', basis: 'Explicit', validity: 'Current', identity: 'Decision', authorKind: 'owner', sourceIds: ['src_seg2'] };
  const refused = await write(item);
  assert.equal(refused.error, true);
  assert.match(refused.text, /too short to stand alone as an Owner's words item/);
  const written = await write({ ...item, answers: 'So bulk review goes to Kimi K3 from now on, and Codex keeps the small focused tasks — is that right?' });
  assert.equal(written.error, false, written.text);
  const saved = store.reference.find((r) => r.name === 'Bulk review goes to Kimi K3')!;
  assert.equal(saved.answers, 'So bulk review goes to Kimi K3 from now on, and Codex keeps the small focused tasks — is that right?');
  // An update that leaves the quote as it is does not ask again; one that changes it to another short quote does.
  assert.equal((await write({ id: saved.id, validity: 'Replaced' })).error, false);
  assert.equal(store.reference.get(saved.id)!.answers, saved.answers, 'what it answers stays with the quote');
});
