/**
 * D105 (CU; CKC-08 AC-26, AC-27; Spec §4.2, §6.13): a note the owner reads is in a form they can read, and the program
 * checks it. The owner, of the note 「D13/D20 被取代却无 ADR 取代行：补不补记，请 owner 定」, whose body carried
 * `mark_7236fe3d8503083c`, a lane report's section number and a run of decision numbers: 「这个可读性太差了。」
 *
 * - Text for the owner carries no internal identifier: every id pattern the store mints is refused and named, with where
 *   the evidence goes instead; a lane named as a lane and a section of a lane's report or brief likewise. The project's
 *   own numbers pass.
 * - A `For your decision` note opens with the question and gives at least two options, each with what follows.
 * - The refusal comes from the writer (`pk_write_note`), whole and at once, so it costs one retry.
 *
 * The project is invented ("Lantern", a reading-light app).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { JudgementRecord, Project } from '../model/types.ts';
import type { ToolContext } from './tools.ts';
import { STORE_ID_PREFIXES, firstSentence, internalRefs, noteFormRefusal, optionsLines, ownerTextRefusal } from './owner-text.ts';

const scratch = mkdtempSync(join(tmpdir(), 'pk-owner-text-'));
process.env.PI_CODING_AGENT_DIR = join(scratch, 'pi-agent');
after(() => { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left in the temp directory */ } });

const { ProjectStore: Store } = await import('../store/project-store.ts');
const { keeperTools } = await import('./tools.ts');

const AT = '2026-10-02T00:00:00.000Z';
const LANES = ['generations', 'owner-words', 'chain-decisions', 'decisions', 'plan K'];

// ───────────────────────── the store's ids ─────────────────────────

test('every id prefix the store mints is one the check knows (newId and stableId call sites in src/)', () => {
  const src = fileURLToPath(new URL('..', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p); } };
  walk(src);
  const minted = new Set<string>();
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/\b(?:newId|stableId)\('([a-z]+)'/g)) minted.add(m[1]!);
  assert.ok(minted.size >= 30, `the call sites were read: ${[...minted].join(', ')}`);
  const unknown = [...minted].filter((p) => !(STORE_ID_PREFIXES as readonly string[]).includes(p));
  assert.deepEqual(unknown, [], 'a collection whose ids the check does not know');
});

test('each store id pattern is found and named with where it stands; hex and base36 alike', () => {
  for (const prefix of ['mark', 'ref', 'rule', 'note', 'thread', 'rel', 'sb', 'bp', 'rdoc', 'draft', 'job', 'gen', 'terr', 'crd']) {
    const stable = `${prefix}_7236fe3d8503083c`;     // stableId: sixteen hex
    const minted = `${prefix}_muravoszb8e43620`;     // newId: base36 time, then hex
    const found = internalRefs({ currentView: `两条已各挂标记（${stable}、${minted}）。`, preview: 'Nothing here.' });
    assert.deepEqual(found, [{ kind: 'store id', text: stable, where: 'currentView' }, { kind: 'store id', text: minted, where: 'currentView' }], prefix);
  }
  // The rest of the store's prefixes too, at the start, the end and inside brackets.
  for (const prefix of STORE_ID_PREFIXES) assert.equal(internalRefs({ t: `(${prefix}_9cb19ad380a3f96d)` }).length, 1, prefix);
  assert.deepEqual(internalRefs({ title: 'scope_9cb19ad380a3f96d corrected', 'facts[2]': 'see jdg_mureoyj10b97b938' }).map((r) => [r.text, r.where]), [['scope_9cb19ad380a3f96d', 'title'], ['jdg_mureoyj10b97b938', 'facts[2]']]);
  // Said once per part of the note it stands in… and once in all when it repeats.
  assert.equal(internalRefs({ a: 'mark_7236fe3d8503083c and again mark_7236fe3d8503083c', b: 'mark_7236fe3d8503083c' }).length, 1);
});

test('the project’s own numbers, file names, commits and ordinary words are not internal identifiers', () => {
  const fine = [
    'v0.4（D32）在事实上取代了 D13「四大块」与 D20「子块切法」；CKC-08 AC-26、E151、R-25、U88、PA-11、V25、OW-157 照写。',
    'Commit 302111a merged into main as 80a031c; see design/DECISIONS.md:298 and SPEC.md §6.16.',
    'A rule_based check, thread_safety, a note_taking app, job_scheduler.ts, ref_count, the gen_2 fixtures, src_main and scope_creep are words.',
    'note_takeover-depth is the program’s own name for its question; mark_up and rel_path are not ids.',
    'test-C-1 对照报告 §7 里三件等 owner；QC report §3 says the same; PLAN §6 lists the candidates.',
    'The decisions are recorded; the generations differ; what the owner said in plain words; plan K is in progress.',
    'thread_internationalization and draft_abcdefghijklmnop carry no digit: words, not ids.',
  ];
  for (const text of fine) assert.deepEqual(internalRefs({ body: text }, LANES), [], text);
});

// ───────────────────────── lanes, and the sections of their reports ─────────────────────────

test('a section of a lane’s report or brief, and a lane named as a lane, are found; a project report’s section is not', () => {
  const found = (text: string) => internalRefs({ body: text }, LANES).map((r) => [r.kind, r.text]);
  assert.deepEqual(found('第一代的去向已记进代记录（generations 路报告 §一），缺的只是取代行。'), [['lane report section', 'generations 路报告 §一']]);
  assert.deepEqual(found('处置是 owner/EO 的决定（代码领地路报告 §五）。'), [['lane report section', '路报告 §五']], 'a lane the store does not know by that name: still a lane’s report');
  assert.deepEqual(found('清单在 owner-words 报告 §6。'), [['lane report section', 'owner-words 报告 §6']]);
  assert.deepEqual(found('As the lane report section 3 says; and the plan K lane’s brief §2.'), [['lane report section', 'lane report section 3'], ['lane report section', 'plan K lane’s brief §2']]);
  assert.deepEqual(found('已在加深轮由 chain-decisions 路与交叉核对落进工作台。'), [['lane name', 'chain-decisions 路']]);
  assert.deepEqual(found('The decisions lane found two; so did the sweep owner-words.'), [['lane name', 'decisions lane'], ['lane name', 'sweep owner-words']]);
  // No lane names known (a project before its first round): the report phrase alone still tells.
  assert.deepEqual(internalRefs({ body: 'the lane’s report §4' }).map((r) => r.kind), ['lane report section']);
  assert.deepEqual(internalRefs({ body: '路由报告 §3 与 第三节' }, LANES), []);
});

// ───────────────────────── the form of a note ─────────────────────────

const OPTIONS = [{ option: 'Add the two supersession lines', then: 'the decision log says the four blocks were replaced, and both decisions show as Replaced' }, { option: 'Leave it', then: 'the log keeps reading as if the four blocks were current' }];

test('the first sentence: up to the first sentence mark, the program’s own stamp aside', () => {
  assert.equal(firstSentence('要不要补记这两条决定的取代行？两条在工作台上仍按字面 Current。'), '要不要补记这两条决定的取代行？');
  assert.equal(firstSentence('v0.4（D32）在事实上取代了 D13。要不要补记？'), 'v0.4（D32）在事实上取代了 D13。');
  assert.equal(firstSentence('Is residual.dart still needed? Nothing references it.'), 'Is residual.dart still needed?');
  assert.equal(firstSentence('[As far as read — sessions to 2026-10-02 16:28Z; the ledger has sessions to 17:13Z] Should P3 reopen? It waits.'), 'Should P3 reopen?');
  assert.equal(firstSentence('The first picture is ready (83 min, $31.98). Choose Full, Focused or First picture only.'), 'The first picture is ready (83 min, $31.98).');
});

test('a For your decision note without the question first or without options is refused, both said at once; a well-formed one passes', () => {
  const body = { currentView: 'The module structure replaced the four blocks when version 0.4 was adopted (D32), but the decision log has no line saying so for the two decisions that set the blocks up (D13, D20).' };
  const bad = noteFormRefusal({ ask: 'For your decision', title: 'D13/D20 被取代却无 ADR 取代行：补不补记，请 owner 定', preview: 'v0.4（D32）在事实上取代了 D13 与 D20。要不要补记取代行，请 owner 定。', body, options: [] }, LANES)!;
  assert.match(bad, /opens with the question[^]*This one opens with “v0\.4（D32）在事实上取代了 D13 与 D20。”/);
  assert.match(bad, /gives the owner the options: at least two in options[^]*This one gives 0\./);
  assert.match(bad, /Nothing was written\.$/);
  assert.doesNotMatch(bad, /internal identifier/);
  // One option, or options with nothing following: still short of a choice.
  assert.match(noteFormRefusal({ ask: 'For your decision', title: 't', preview: 'Add the lines?', body, options: [OPTIONS[0]!, { option: 'Leave it', then: ' ' }] }, LANES)!, /This one gives 1 \(1 without option or then\)\./);
  assert.equal(noteFormRefusal({ ask: 'For your decision', title: 'Should the decision log say the four blocks were replaced?', preview: '要不要在决定记录里补上「四大块被取代」这两行？', body, options: OPTIONS }, LANES), null);
  // Another ask needs neither.
  assert.equal(noteFormRefusal({ ask: 'For information', title: 'What waits for the owner', preview: 'Three things wait for the owner after this round.', body, options: [] }, LANES), null);
  assert.equal(noteFormRefusal({ ask: 'Worth discussing', title: 't', preview: 'The hold length is set only in code.', body, options: [] }, LANES), null);
});

test('internal identifiers are refused in any note, each named with what it is, where it stands and where the evidence goes', () => {
  const refusal = noteFormRefusal({
    ask: 'For information', title: 'Two classifications misfire', preview: 'Two classification rules misfire on this repository.',
    body: { currentView: 'The scope already corrected one (scope_9cb19ad380a3f96d); the generations 路报告 §一 has the list.', 'facts[0]': 'Both carry a mark (mark_7236fe3d8503083c).', whatWouldSettleIt: 'chain-decisions 路 re-read it.' },
    options: [],
  }, LANES)!;
  assert.match(refusal, /It carries 4 internal identifiers, which the owner cannot read/);
  assert.match(refusal, /“scope_9cb19ad380a3f96d” in currentView \(a ProjectKeeper store id\)/);
  assert.match(refusal, /“generations 路报告 §一” in currentView \(a section of a lane’s report or brief\)/);
  assert.match(refusal, /“mark_7236fe3d8503083c” in facts\[0\] \(a ProjectKeeper store id\)/);
  assert.match(refusal, /“chain-decisions 路” in whatWouldSettleIt \(the name of a lane\)/);
  assert.match(refusal, /The evidence goes in the note’s sources and links, not in its sentences: sourceIds on the facts, the objects it hangs on \(mountIds\), looked, changeIds, codeAnomalies\./);
  // In an option too; and with the decision form wrong as well, everything is said in the one answer.
  const all = noteFormRefusal({ ask: 'For your decision', title: 't', preview: 'It waits.', body: {}, options: [{ option: 'Close bp_52281dd2b06f84f8', then: 'done' }] }, LANES)!;
  assert.match(all, /“bp_52281dd2b06f84f8” in options\[0\]\.option/);
  assert.match(all, /opens with the question/);
  assert.match(all, /This one gives 1\./);
});

test('a round’s Result is read by the owner too: refused with what it carries, by name', () => {
  const refusal = ownerTextRefusal('The round’s Result', { title: '合成结果', markdown: '送回新 1：sb_muravoszb8e43620。note 写 4：note_murawcjo06b7f3d3。owner-words 路报的 13 条里缺 4 条。' }, LANES)!;
  assert.match(refusal, /^The round’s Result is read by the owner, and it carries 3 internal identifiers: “sb_muravoszb8e43620” in markdown \(a ProjectKeeper store id\); “note_murawcjo06b7f3d3” in markdown \(a ProjectKeeper store id\); “owner-words 路” in markdown \(the name of a lane\)\./);
  assert.match(refusal, /Nothing was written\.$/);
  assert.equal(ownerTextRefusal('The round’s Result', { markdown: '新写了四条 note，其中一条要 owner 定（要不要补记两条决定的取代行）。计划 K 的四件已知未排项仍未接。' }, LANES), null);
});

test('a decision note’s options as lines, one per choice', () => {
  assert.deepEqual(optionsLines(OPTIONS), ['- Add the two supersession lines — the decision log says the four blocks were replaced, and both decisions show as Replaced', '- Leave it — the log keeps reading as if the four blocks were current']);
  assert.deepEqual(optionsLines(undefined), []);
});

test('the conversation shows what was written earlier under `Written earlier · <time>`, with no word of the store (Spec §6.8)', () => {
  const views = readFileSync(fileURLToPath(new URL('../../ui/views.js', import.meta.url)), 'utf8');
  assert.match(views, /`Written earlier · \$\{fmtRel\(r\.existing\.at\)\}`/);
  assert.doesNotMatch(views, /Read from the assets, not newly generated/);
});

// ───────────────────────── through the writer ─────────────────────────

type Called = { text: string; error: boolean; json: Record<string, unknown> };
function harness() {
  const store = Store.open('p1', mkdtempSync(join(scratch, 'store-')));
  const project = { id: 'p1', name: 'Lantern', language: 'en', locations: ['D:\\lantern'], scope: [], roles: [] } as unknown as Project;
  const ctx: ToolContext = { store, project, jobId: 'job_1', jobKind: 'Organizing', model: null };
  const tools: readonly ToolDefinition[] = keeperTools(ctx);
  store.judgements.put({ id: 'jdg_1', projectId: 'p1', jobId: 'job_1', at: AT, scope: { kind: 'project', ids: [], label: 'Lantern' }, inputs: { referenceIds: [], threadIds: [], areaIds: [], relationIds: [], keyEvidenceSourceIds: [], conflictingSourceIds: [], previousNoteIds: [], investigations: [] }, excluded: [], outcome: { noteIds: [], assessments: [], reconsideredOnly: false } } as JudgementRecord);
  const call = async (name: string, args: Record<string, unknown>): Promise<Called> => {
    const tool = tools.find((t) => t.name === name)!;
    let text = '';
    let error = false;
    try {
      const r = await (tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)('call', structuredClone(args));
      text = r.content.map((c) => c.text).join('\n');
      error = r.isError === true;
    } catch (e) { text = (e as Error).message; error = true; }
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a refusal is prose */ }
    return { text, error, json };
  };
  return { store, call };
}
const NOTE = { mountKind: 'project', mountIds: [], judgementRecordId: 'jdg_1', reason: 'synthesis' };

test('pk_write_note refuses each id pattern and names it, and accepts the project’s own numbers', async () => {
  const h = harness();
  for (const prefix of ['mark', 'ref', 'rule', 'note', 'thread', 'rel', 'sb', 'bp', 'rdoc', 'draft', 'job', 'gen', 'terr', 'crd']) {
    const id = `${prefix}_7236fe3d8503083c`;
    const r = await h.call('pk_write_note', { ...NOTE, title: `About ${prefix}`, preview: 'The dimmer has two decisions that disagree.', ask: 'For information', currentView: `Both carry a mark (${id}).` });
    assert.equal(r.error, true, `${prefix}: ${r.text}`);
    assert.ok(r.text.includes(`“${id}” in currentView (a ProjectKeeper store id)`), `${prefix} is named: ${r.text}`);
    assert.match(r.text, /The evidence goes in the note’s sources and links/);
    assert.match(r.text, /Nothing was written\.$/);
  }
  assert.equal(h.store.notes.size, 0, 'nothing was written');
  // In the title, the preview, a fact, any section.
  for (const part of ['title', 'preview', 'whyItMatters', 'otherExplanations', 'keepAdjust', 'whatWouldSettleIt']) {
    const r = await h.call('pk_write_note', { ...NOTE, title: 'The dimmer', preview: 'The dimmer has two decisions that disagree.', ask: 'For information', [part]: 'See ref_93bf571fc1afe65d for the rest.' });
    assert.ok(r.error && r.text.includes(`“ref_93bf571fc1afe65d” in ${part}`), `${part}: ${r.text}`);
  }
  const inFact = await h.call('pk_write_note', { ...NOTE, title: 'The dimmer', preview: 'The dimmer has two decisions that disagree.', ask: 'For information', facts: [{ text: 'fine', sourceIds: [], inferred: false }, { text: 'bp_52281dd2b06f84f8 is lit', sourceIds: [], inferred: false }] });
  assert.ok(inFact.error && inFact.text.includes('“bp_52281dd2b06f84f8” in facts[1]'), inFact.text);
  // The project's own numbers are the project's words. Evidence by id is welcome where it belongs: the sources of a fact.
  const fine = await h.call('pk_write_note', {
    ...NOTE, title: 'The dimmer decisions disagree (D13, D20)', ask: 'For information',
    preview: 'Two decisions about the dimmer disagree: the first set four brightness steps (D13), the later one made it continuous (D20), and the contract still lists four (CKC-08 AC-4).',
    currentView: 'The plan entry that carried the change out is E151; nothing in the decision log says the first decision was replaced.',
    facts: [{ text: 'The contract lists four steps (CKC-08 AC-4).', sourceIds: ['src_7236fe3d8503083c'], inferred: false }],
  });
  assert.equal(fine.error, false, fine.text);
  assert.equal(h.store.notes.size, 1);
});

test('pk_write_note refuses a decision note without the question or the options, accepts a well-formed one and keeps its options', async () => {
  const h = harness();
  const base = { ...NOTE, title: 'Should the dimmer keep its four steps?', ask: 'For your decision', currentView: 'The dimmer was built with four brightness steps; a later decision made it continuous, and the contract was not changed.' };
  const noQuestion = await h.call('pk_write_note', { ...base, preview: 'The dimmer was decided twice. Which stands is for the owner.', options: [{ option: 'Four steps', then: 'the later decision is withdrawn' }, { option: 'Continuous', then: 'the contract is edited' }] });
  assert.equal(noQuestion.error, true);
  assert.match(noQuestion.text, /opens with the question[^]*This one opens with “The dimmer was decided twice\.”/);
  assert.doesNotMatch(noQuestion.text, /at least two in options/);
  const noOptions = await h.call('pk_write_note', { ...base, preview: 'Should the dimmer keep its four steps? It was decided twice.' });
  assert.equal(noOptions.error, true);
  assert.match(noOptions.text, /gives the owner the options: at least two in options[^]*This one gives 0\./);
  assert.doesNotMatch(noOptions.text, /opens with the question/);
  const oneOption = await h.call('pk_write_note', { ...base, preview: 'Should the dimmer keep its four steps?', options: [{ option: 'Four steps', then: 'the later decision is withdrawn' }] });
  assert.match(oneOption.text, /This one gives 1\./);
  assert.equal(h.store.notes.size, 0);

  const options = [{ option: 'Keep four steps', then: 'the later decision is withdrawn in the decision log; nothing is rebuilt' }, { option: 'Make it continuous', then: 'the contract’s acceptance line is edited and the dimmer is reworked' }, { option: 'Leave it', then: 'the contract and the decision keep disagreeing' }];
  const good = await h.call('pk_write_note', { ...base, preview: 'Should the dimmer keep its four steps, or become continuous as the later decision says? The contract still lists four.', options });
  assert.equal(good.error, false, good.text);
  const stored = h.store.notes.get(String(good.json.id))!;
  assert.deepEqual(stored.versions[0]!.body.options, options);
  // An update keeps the options it does not change; a note that no longer asks for a decision carries none.
  const again = await h.call('pk_write_note', { id: stored.id, whyItMatters: 'Readers at night want the lowest step lower.', reason: 'why it matters' });
  assert.equal(again.error, false, again.text);
  assert.deepEqual(h.store.notes.get(stored.id)!.versions[1]!.body.options, options);
  const settled = await h.call('pk_write_note', { id: stored.id, ask: 'For information', preview: 'The owner kept four steps; the later decision is withdrawn.', reason: 'the owner decided' });
  assert.equal(settled.error, false, settled.text);
  assert.equal(h.store.notes.get(stored.id)!.versions[2]!.body.options, undefined);
  // Options on a note that asks for no decision are not kept.
  const info = await h.call('pk_write_note', { ...NOTE, title: 'The lamp colours', preview: 'The lamp has three colours and no setting for them.', ask: 'For information', options });
  assert.equal(info.error, false, info.text);
  assert.equal(h.store.notes.get(String(info.json.id))!.versions[0]!.body.options, undefined);
});
