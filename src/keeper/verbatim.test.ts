/**
 * Words recorded as someone's own are the words of the sources they cite (Spec §1.3, §1.15; E80, E86): an owner quote
 * on any reference item, a rule's owner confirmation, and the project's own wording of an Explicit rule. A quote is
 * checked part by part — an ellipsis separates the parts — and each part has to stand in the sources cited, in source
 * order within a source, read the same way on both sides: case, spacing, Markdown marks, punctuation and quotation
 * marks make no difference, and a doubled backslash counts as one. A part that is absent or out of order is refused,
 * and the refusal says which part and how to put it right. An inferred rule is written as before.
 *
 * Every refusal here is paired with the write that must go through, and every write that must go through also must
 * not come back with a warning: before this, the check compared the whole quote and warned about quotes that were
 * the owner's words, joined with an ellipsis.
 *
 * The fixtures are an invented project, "Kiln", a booking tool for a small pottery studio. The harness is the one of
 * tools-validation.test.ts, kept local for the same reason given there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { keeperTools, type ToolContext } from './tools.ts';
import { readFileSources } from '../sources/files.ts';
import { sessionSources } from '../sources/sessions/read.ts';
import { ownerUtterances } from '../sources/sessions/utterances.ts';
import type { Project, Source } from '../model/types.ts';

const AT = '2026-09-10T01:00:00.000Z';

interface Harness {
  readonly store: ProjectStore;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean; json: Record<string, unknown> }>;
}

function harness(): Harness {
  return harnessWith(ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-verbatim-'))), null);
}

/** The tools on a store; with the owner's message, as the owner's conversation has them. */
function harnessWith(store: ProjectStore, ownerSourceId: string | null): Harness {
  const project = { id: 'p1', name: 'Kiln', language: 'en', locations: ['D:\\kiln'], scope: [], roles: [] } as unknown as Project;
  const ctx: ToolContext = { store, project, jobId: ownerSourceId ? 'job_talk' : 'job_1', jobKind: ownerSourceId ? 'Answering' : 'Organizing', model: null, ownerSourceId };
  const tools = keeperTools(ctx);
  return {
    store,
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

/** The project's notes for agents, read the way intake reads a Markdown file: one source per section. */
const AGENTS_MD = [
  '# Kiln · notes for agents',
  '',
  'Kiln books firing slots for a small pottery studio.',
  '',
  '## Folders',
  '',
  '| Folder | What it holds | Who may change it |',
  '| --- | --- | --- |',
  '| `samples/` | 示例数据 | 只读 |',
  '| `attic/` | old drafts, kept for recovery only | nobody |',
  '',
  '## Working rules',
  '',
  '- Every change goes through a pull request,',
  '  and **nobody** pushes to `main` directly.',
  '- Tasks are numbered K-1, K-2 and so on.',
  '- The next free number is kept in docs/TASKS.md.',
  '',
  '## 交付',
  '',
  '1. 所有改动都走合并请求；',
  '2. 不直接推送到主分支。',
  '',
  '> 构建产物放在 D:\\kiln\\out 下面，不要提交。',
  '',
].join('\n');

function markdownSources(store: ProjectStore, name: string, body: string): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'pk-verbatim-kiln-'));
  const path = join(dir, name);
  writeFileSync(path, body);
  const st = statSync(path);
  const { sources } = readFileSources('p1', { path, scopeItemId: 'scope_main', bytes: st.size, mtimeMs: st.mtimeMs });
  store.sources.putMany(sources.map((s) => ({ ...s, usedAs: 'Other' as const, usedAsBy: 'keeper' as const })));
  // Section title → source id ("part 2" titles for a long section cut in parts).
  return new Map(sources.map((s) => [s.title, s.id]));
}

/** What the owner said, as a session segment shows it: the owner's messages whole, the agent's in between. */
const SAID = '预约只能取消，不能删除。取消的预约保留原来的编号，这样对账的时候能找到。确认邮件要在两分钟内发出';
const SAID_PATH = '把导出的表格放到 D:\\kiln\\exports 里，别放桌面。';
const SEGMENT = `[3] OWNER 2026-09-10 01:00\n${SAID}\n\n[4] AGENT (claude-test) 2026-09-10 01:01\n明白，我先看预约的计划。\n\n[5] OWNER 2026-09-10 01:05\n${SAID_PATH}`;

const sessionSource = (store: ProjectStore, id: string, excerpt: string, messageStart = 3) =>
  store.sources.put({ id, projectId: 'p1', title: `session ${id}`, anchor: { kind: 'session', host: 'claude', sessionId: 'kiln-session-1', file: 'D:\\s\\kiln-session-1.jsonl', cwd: null, messageStart, messageEnd: messageStart + 2, at: AT }, ids: [], version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt, usedAs: 'Session', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: 'scope', hasCredential: false, bytes: excerpt.length } as Source);

const fileSource = (store: ProjectStore, id: string, path: string, excerpt: string) =>
  store.sources.put({ id, projectId: 'p1', title: path.split('\\').pop()!, anchor: { kind: 'file', path, headingPath: [], lineStart: 1, lineEnd: 9 }, ids: [], version: { fingerprint: `f-${excerpt.length}`, readAt: AT, commit: null }, excerpt, usedAs: 'Decision', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: 'scope', hasCredential: false, bytes: excerpt.length } as Source);

const WORDS = { category: "Owner's words", name: 'Bookings are cancelled, never deleted', text: 'The owner wants every booking kept.', basis: 'Explicit', validity: 'Current', identity: 'Decision', authorKind: 'owner' };
const words = (h: Harness, quote: string, sourceIds: string[], extra: Record<string, unknown> = {}) =>
  h.call('pk_write_reference', { ...WORDS, quote, sourceIds, ...extra });

const RULE = { group: 'Working rules', summary: 'How changes reach the main branch.', appliesTo: ['the whole project'], basis: 'Explicit' };
const rule = (h: Harness, excerpt: string, sourceIds: string[], extra: Record<string, unknown> = {}) =>
  h.call('pk_write_rule', { ...RULE, excerpt, sourceIds, ...extra });

/** A write that must go through: no refusal, and no warning that the words are not in the sources. */
function written(r: { text: string; error: boolean; json: Record<string, unknown> }, what: string): string {
  assert.equal(r.error, false, `${what}: ${r.text}`);
  assert.equal(r.json.warning, undefined, `${what} is the source’s own words, so nothing is said against it: ${String(r.json.warning)}`);
  return r.json.id as string;
}

/** A write that must be refused because a part of the quote is not in the sources — naming that part. */
function refused(r: { text: string; error: boolean }, part: string, what: string): void {
  assert.equal(r.error, true, `${what} must be refused: ${r.text}`);
  assert.ok(r.text.includes(`“${part}”`), `${what}: the refusal names the part that is not there, “${part}”: ${r.text}`);
}

// ───────────────────────── the owner's words (Spec §1.3) ─────────────────────────

test("an Owner's words quote whose every part, joined with ……, is the owner's words is written without a warning (Spec §1.3; E80)", async () => {
  const h = harness();
  sessionSource(h.store, 'src_talk', SEGMENT);
  written(await words(h, '预约只能取消，不能删除……确认邮件要在两分钟内发出', ['src_talk']), 'two parts of one message, joined with ……');
  written(await words(h, '预约只能取消，不能删除...取消的预约保留原来的编号', ['src_talk'], { name: 'Cancelled bookings keep their number' }), 'two parts joined with ...');
  written(await words(h, '预约只能取消，不能删除…这样对账的时候能找到', ['src_talk'], { name: 'Bookings can be found when accounts are settled' }), 'two parts joined with …');
  assert.equal(h.store.reference.size, 3);
  assert.equal(h.store.reference.all().find((r) => r.name === WORDS.name)!.quote, '预约只能取消，不能删除……确认邮件要在两分钟内发出', 'the quote is kept as written, ellipsis and all');
});

test("an extra full stop, other punctuation, quotation marks, case and a doubled backslash make no difference (Spec §1.3; E80)", async () => {
  const h = harness();
  sessionSource(h.store, 'src_talk', SEGMENT);
  written(await words(h, '确认邮件要在两分钟内发出。', ['src_talk']), 'a full stop the owner did not type');
  written(await words(h, '预约只能取消, 不能删除.', ['src_talk'], { name: 'English punctuation for Chinese' }), 'English punctuation where the owner typed Chinese');
  written(await words(h, '“预约只能取消，不能删除”', ['src_talk'], { name: 'In quotation marks' }), 'the quote put in quotation marks');
  written(await words(h, '把导出的表格放到 D:\\\\kiln\\\\exports 里，别放桌面。', ['src_talk'], { name: 'Where exports go' }), 'a path whose backslashes a JSON escape doubled');
  fileSource(h.store, 'src_record', 'D:\\kiln\\docs\\DECIDED.md', 'The owner, 2026-09-12: Firing Slots Are Booked By The Hour.');
  written(await words(h, 'firing slots are booked by the hour', ['src_record'], { name: 'By the hour' }), 'the same words in another case');
});

test("an Owner's words quote that drops a sentence without an ellipsis, changes a word or is not in the source is refused, naming the part (Spec §1.3; E80)", async () => {
  const h = harness();
  sessionSource(h.store, 'src_talk', SEGMENT);

  const dropped = await words(h, '预约只能取消，不能删除。确认邮件要在两分钟内发出', ['src_talk']);
  refused(dropped, '预约只能取消，不能删除。确认邮件要在两分钟内发出', 'a sentence left out without an ellipsis');
  assert.ok(dropped.text.includes('取消的预约保留原来的编号'), `the refusal shows what the source has where the quote parts from it: ${dropped.text}`);
  assert.match(dropped.text, /……/, 'and says to mark what is left out with ……');

  const changed = await words(h, '预约只能取消……不能移除', ['src_talk']);
  refused(changed, '不能移除', 'a changed word');
  assert.ok(!changed.text.includes('“预约只能取消”'), `the part that is the owner’s words is not listed: ${changed.text}`);

  const rewritten = await words(h, 'The owner wants every booking kept forever.', ['src_talk']);
  refused(rewritten, 'The owner wants every booking kept forever.', 'a restatement in other words');
  assert.match(rewritten.text, /pk_owner_utterances/, 'the refusal says where the owner’s messages are given whole');
  assert.match(rewritten.text, /product description/, 'and what a reading of the owner is recorded as instead');

  assert.equal(h.store.reference.size, 0, 'none of the three wrote an item');
  written(await words(h, '预约只能取消，不能删除', ['src_talk']), 'the owner’s words as they are');
});

test("each part is looked for in every source cited, and a part in a section the call did not cite is refused, naming that section (Spec §1.3; E80)", async () => {
  const h = harness();
  sessionSource(h.store, 'src_talk', SEGMENT);
  sessionSource(h.store, 'src_talk_later', '[9] OWNER 2026-09-10 02:00\n窑炉每周清理一次，周一上午不接预约。', 9);
  written(await words(h, '预约只能取消，不能删除……周一上午不接预约', ['src_talk', 'src_talk_later']), 'parts from two cited messages');
  written(await words(h, '预约只能取消，不能删除……周一上午不接预约', ['src_talk_later', 'src_talk'], { name: 'Mondays, citations reversed' }), 'source ids are citations, not the quote-part order');

  const one = await words(h, '预约只能取消，不能删除……周一上午不接预约', ['src_talk'], { name: 'Mondays' });
  refused(one, '周一上午不接预约', 'a part from a message that is not cited');
  assert.ok(one.text.includes('src_talk_later'), `the refusal names the source of the same session that holds it: ${one.text}`);
});

test('parts separated by an ellipsis must keep the order in which the source says them', async () => {
  const h = harness();
  fileSource(h.store, 'src_order', 'D:\\kiln\\docs\\DECIDED.md', 'First choose a firing slot. Then pay the deposit. Finally collect the glazed piece.');

  const reversed = await words(h, 'Finally collect the glazed piece……First choose a firing slot', ['src_order']);
  assert.equal(reversed.error, true, `real parts in a false order must be refused: ${reversed.text}`);
  assert.match(reversed.text, /order|before/i, 'the refusal explains that the parts are out of source order');
  written(await words(h, 'First choose a firing slot……Finally collect the glazed piece', ['src_order']), 'the same parts in source order');
});

test("a quote on a reference item outside the Owner's words category is still copied from its cited source", async () => {
  const h = harness();
  sessionSource(h.store, 'src_decision', '[owner 2026-09-10T01:00:00.000Z]\nUse the blue confirmation screen for the first release.', 12);
  const decision = { category: 'Decision', name: 'Blue confirmation screen', text: 'The first release uses the blue confirmation screen.', basis: 'Explicit', validity: 'Current', identity: 'Decision', authorKind: 'owner', sourceIds: ['src_decision'] };

  const invented = await h.call('pk_write_reference', { ...decision, quote: 'Use the green confirmation screen for the first release.' });
  assert.equal(invented.error, true, `a non-verbatim owner quote must be refused on any reference category: ${invented.text}`);
  assert.match(invented.text, /green confirmation screen/);
  written(await h.call('pk_write_reference', { ...decision, quote: 'Use the blue confirmation screen for the first release.' }), 'a verbatim quote on a Decision item');
});

test('an owner’s long message is whole in its session source, so its words can be quoted from anywhere in it (Spec §1.2, §1.3; E80)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-verbatim-logs-'));
  mkdirSync(join(dir, 'claude'), { recursive: true });
  const file = join(dir, 'claude', 'a1b2c3d4-0000-4000-8000-00000000000a.jsonl');
  const long = `先说预约的规矩：${'窑炉每周清理一次，清理那天不接预约。'.repeat(1200)}最后，确认邮件要在两分钟内发出。`;
  const t = (minute: number) => new Date(Date.UTC(2026, 8, 10, 1, minute)).toISOString();
  const record = (minute: number, role: 'user' | 'assistant', text: string) => JSON.stringify({
    type: role, sessionId: 'a1b2c3d4-0000-4000-8000-00000000000a', cwd: 'D:\\kiln', isSidechain: false, entrypoint: 'claude-desktop', timestamp: t(minute),
    ...(role === 'user' ? { origin: { kind: 'human' } } : {}), message: { role, ...(role === 'assistant' ? { model: 'claude-test' } : {}), content: role === 'user' ? text : [{ type: 'text', text }] },
  });
  writeFileSync(file, [record(0, 'user', '先看一下预约页面。'), record(1, 'assistant', '好的。'), record(2, 'user', long), record(3, 'assistant', '明白。')].join('\n'));
  const st = statSync(file);
  const h = harness();
  const { sources } = sessionSources('p1', { host: 'claude', file, cwd: 'D:\\kiln', sessionId: 'a1b2c3d4-0000-4000-8000-00000000000a', bytes: st.size, mtimeMs: st.mtimeMs, isSubagent: false, home: dir }, 'scope_sessions');
  h.store.sources.putMany(sources);
  assert.ok(long.length > 20_000, 'longer than a segment and far longer than an agent’s trimmed text');

  const found = ownerUtterances(h.store);
  assert.ok(typeof found !== 'string');
  const u = found.utterances.find((x) => x.text === long);
  assert.ok(u, 'pk_owner_utterances gives the long message whole');
  assert.ok(h.store.sources.get(u.sourceId)!.excerpt.includes(long), 'and the source it names holds the whole message, not a cut one');

  written(await words(h, '先说预约的规矩……最后，确认邮件要在两分钟内发出', [u.sourceId]), 'the start and the end of a long message');
});

// ───────────────────────── the project's rules (Spec §1.15) ─────────────────────────

test('an Explicit rule copied from a sentence across lines, from list items, from a table row or a quoted line is written without a warning (Spec §1.15; E80)', async () => {
  const h = harness();
  const s = markdownSources(h.store, 'AGENTS.md', AGENTS_MD);
  const [folders, working, delivery] = [s.get('Folders')!, s.get('Working rules')!, s.get('交付')!];
  assert.ok(folders && working && delivery, `the notes are read one section per source: ${[...s.keys()].join(', ')}`);

  written(await rule(h, 'Every change goes through a pull request, and nobody pushes to main directly.', [working]), 'a sentence across two lines, with emphasis and code marks');
  written(await rule(h, 'Tasks are numbered K-1, K-2 and so on. The next free number is kept in docs/TASKS.md.', [working], { summary: 'Task numbers.' }), 'two list items joined');
  written(await rule(h, '| `samples/` | 示例数据 | 只读 |', [folders], { group: 'Material rules', category: 'Reference only', summary: 'samples/ is read only.', appliesTo: ['samples/'] }), 'a table row copied as it is');
  written(await rule(h, '所有改动都走合并请求，不直接推送到主分支。', [delivery], { summary: 'Merge requests only.' }), 'a numbered list joined into one sentence');
  written(await rule(h, '构建产物放在 D:\\\\kiln\\\\out 下面，不要提交。', [delivery], { summary: 'Build output stays out of the repository.' }), 'a quoted line, its path with doubled backslashes');
  written(await rule(h, 'EVERY CHANGE GOES THROUGH A PULL REQUEST……NOBODY PUSHES TO MAIN', [working], { summary: 'Pull requests, in capitals.' }), 'another case, with a part left out');
  assert.equal(h.store.rules.size, 6);
});

test('an Explicit rule whose excerpt rewrites a table row, is not in the section cited, or is not the project’s words is refused, naming the part and the fix (Spec §1.15; E80)', async () => {
  const h = harness();
  const s = markdownSources(h.store, 'AGENTS.md', AGENTS_MD);
  const [folders, working] = [s.get('Folders')!, s.get('Working rules')!];

  const row = await rule(h, '`samples/`=示例数据，只读', [folders], { group: 'Material rules', category: 'Reference only', summary: 'samples/ is read only.', appliesTo: ['samples/'] });
  refused(row, '`samples/`=示例数据，只读', 'a table row written as a sentence');
  assert.match(row.text, /Inferred/, 'the refusal says a rule the project never wrote in its own words is Inferred');
  assert.match(row.text, /summary/, 'with the reading in summary');

  const elsewhere = await rule(h, 'Tasks are numbered K-1, K-2 and so on.', [folders], { summary: 'Task numbers.' });
  refused(elsewhere, 'Tasks are numbered K-1, K-2 and so on.', 'words from another section of the same file');
  assert.ok(elsewhere.text.includes(working), `the refusal names the section that holds them: ${elsewhere.text}`);

  const invented = await rule(h, 'Agents never push to main.', [working]);
  refused(invented, 'Agents never push to main.', 'a rule the notes do not word this way');

  const dropped = await rule(h, 'Every change goes through a pull request directly.', [working]);
  refused(dropped, 'Every change goes through a pull request directly.', 'words left out without an ellipsis');

  assert.equal(h.store.rules.size, 0, 'no refused rule was written');
  written(await rule(h, 'nobody pushes to `main` directly', [working]), 'the project’s words as they are');
});

test('a rule inferred from practice is written as before; an excerpt it carries that is not the project’s words is only warned about, naming the part (Spec §1.15, §3.9; E80)', async () => {
  const h = harness();
  sessionSource(h.store, 'src_s1', '[1] AGENT 2026-09-10 01:00\nBatch 1 done; the reviewer checked it before the merge.', 1);
  sessionSource(h.store, 'src_s2', '[1] AGENT 2026-09-11 01:00\nBatch 2 done; the reviewer checked it before the merge.', 30);
  const inferred = { group: 'How work is organized', summary: 'Every batch is reviewed before it is merged.', sourceIds: ['src_s1', 'src_s2'], appliesTo: ['every batch'], basis: 'Inferred' };
  const plain = await h.call('pk_write_rule', inferred);
  assert.equal(plain.error, false, plain.text);
  assert.equal(plain.json.warning, undefined);
  assert.equal(h.store.rules.get(plain.json.id as string)!.basis, 'Inferred');

  const withWords = await h.call('pk_write_rule', { ...inferred, summary: 'A reviewer checks each batch.', excerpt: 'Each batch is reviewed by a second agent.' });
  assert.equal(withWords.error, false, `an inferred rule is not refused for its excerpt: ${withWords.text}`);
  assert.ok(String(withWords.json.warning ?? '').includes('“Each batch is reviewed by a second agent.”'), `the warning names the part that is not the project’s words: ${String(withWords.json.warning)}`);
  assert.equal(h.store.rules.size, 2);

  // The owner confirms that rule in the conversation: it becomes Explicit by the owner's word, and the confirmation is
  // never refused for the excerpt the inference carried.
  const talk = harnessWith(h.store, 'src_owner');
  sessionSource(h.store, 'src_owner', '[owner 2026-09-12T08:00:00.000Z]\n对，每一批都要先审再合。', 40);
  const inventedConfirmation = await talk.call('pk_write_rule', { id: withWords.json.id, ownerConfirmed: { quote: '对，每一批都可以直接合。' } });
  assert.equal(inventedConfirmation.error, true, `a rule confirmation must quote the current owner message: ${inventedConfirmation.text}`);
  assert.equal(h.store.rules.get(withWords.json.id as string)!.basis, 'Inferred', 'a refused quote confirms nothing');
  const confirmed = await talk.call('pk_write_rule', { id: withWords.json.id, ownerConfirmed: { quote: '对，每一批都要先审再合。' } });
  assert.equal(confirmed.error, false, `the owner’s confirmation is written: ${confirmed.text}`);
  assert.equal(h.store.rules.get(withWords.json.id as string)!.basis, 'Explicit');
  assert.ok(String(confirmed.json.warning ?? '').includes('“Each batch is reviewed by a second agent.”'), `and the excerpt is still named as not the project’s words: ${String(confirmed.json.warning)}`);
});

test('a long section cut in parts is one text: a part of a quote may run across the cut when both parts are cited (Spec §1.2, §1.15; E80)', async () => {
  const h = harness();
  const first = `${'Slots are booked by the hour and paid at the desk. '.repeat(300)}The last slot of the day ends at six.`;
  const second = 'Glaze firings need two slots in a row. Nothing else does.';
  const s = markdownSources(h.store, 'BOOKING.md', `# Booking\n\n## Slots\n\n${first}\n\n${second}\n`);
  const parts = [...s.entries()].filter(([title]) => /^part \d$/.test(title)).map(([, id]) => id);
  assert.equal(parts.length, 2, `the section is cut in two parts: ${[...s.keys()].join(', ')}`);
  const across = 'The last slot of the day ends at six. Glaze firings need two slots in a row.';
  written(await rule(h, across, parts, { summary: 'The day’s last slot and glaze firings.' }), 'a sentence pair across the cut, both parts cited');
  refused(await rule(h, across, [parts[0]!], { summary: 'Only the first part.' }), across, 'the same, citing only the first part');
});

// ───────────────────────── writing again what is already recorded ─────────────────────────

test('an item written earlier can be marked Replaced with its quote as it was, after its source changed; a changed quote is checked again (Spec §1.3, §2.1; E80)', async () => {
  const h = harness();
  fileSource(h.store, 'src_record', 'D:\\kiln\\docs\\DECIDED.md', 'The owner, 2026-09-12: 「取消的预约保留原来的编号。」');
  const old = written(await words(h, '取消的预约保留原来的编号', ['src_record'], { name: 'Cancelled bookings keep their number' }), 'the owner’s words from the decision record');
  // The record is rewritten: the owner changed their mind, and the record now holds the later words only.
  fileSource(h.store, 'src_record', 'D:\\kiln\\docs\\DECIDED.md', 'The owner, 2026-09-18: 「取消的预约换一个新编号。」');
  const later = written(await words(h, '取消的预约换一个新编号', ['src_record'], { name: 'Cancelled bookings get a new number' }), 'the later words');
  written(await words(h, '取消的预约保留原来的编号', ['src_record'], { id: old, name: 'Cancelled bookings keep their number', validity: 'Replaced', replacedBy: later }), 'the earlier item marked Replaced, its quote as it was');
  assert.equal(h.store.reference.get(old)!.validity, 'Replaced');
  refused(await words(h, '取消的预约保留旧编号', ['src_record'], { id: old, name: 'Cancelled bookings keep their number', validity: 'Replaced', replacedBy: later }), '取消的预约保留旧编号', 'a quote changed on the way');

  // The same for a rule: marking it Replaced once its source says something else is not refused for its old words.
  fileSource(h.store, 'src_numbers', 'D:\\kiln\\docs\\TASKS.md', 'Task numbers continue from K-40.');
  const oldRule = written(await rule(h, 'Task numbers continue from K-40.', ['src_numbers'], { summary: 'Tasks continue from K-40.' }), 'a rule from the task index');
  fileSource(h.store, 'src_numbers', 'D:\\kiln\\docs\\TASKS.md', 'From now on tasks are numbered B-1, B-2 and so on.');
  const newRule = written(await rule(h, 'From now on tasks are numbered B-1, B-2 and so on.', ['src_numbers'], { summary: 'Tasks are numbered B-n.' }), 'the new rule');
  written(await h.call('pk_write_rule', { id: oldRule, validity: 'Replaced', replacedBy: newRule }), 'the old rule marked Replaced');
  assert.equal(h.store.rules.get(oldRule)!.validity, 'Replaced');
});

test('a link quoted as the words it shows, and a doubled backslash before a dot, make no difference either (Spec §1.15; E80)', async () => {
  const h = harness();
  const s = markdownSources(h.store, 'CONTRIBUTING.md', '# Contributing\n\n## Before you start\n\nRead [the booking plan](docs/PLAN.md) before you change a form.\n\nLocal caches live in D:\\kiln\\.cache and are never committed.\n');
  const start = s.get('Before you start')!;
  written(await rule(h, 'Read the booking plan before you change a form.', [start], { summary: 'The plan comes first.' }), 'a link as the words it shows');
  written(await rule(h, 'Read [the booking plan](docs/PLAN.md) before you change a form.', [start], { summary: 'The plan comes first, link and all.' }), 'the link as it is written');
  written(await rule(h, 'Local caches live in D:\\\\kiln\\\\.cache and are never committed.', [start], { summary: 'Caches stay local.' }), 'a doubled backslash before a dot');
  refused(await rule(h, 'Read the plan before you change a form.', [start], { summary: 'A word dropped.' }), 'Read the plan before you change a form.', 'a word of the link left out');
});
