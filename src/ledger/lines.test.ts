/**
 * What the ledger reads off lines of the material, as pure functions (Spec §1.16 rows 3–5, §2.11): the dates a text
 * writes (the one rule), the lines that say something was superseded and the rows of the project's own obsolete lists,
 * verdicts, test counts and findings in reports, the numbering (definitions decide the rules; two letters only where an
 * index or a numbered folder has them), and the parse of git's NUL-separated log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateContext, datesOnLine } from './time.ts';
import { replacedNumbers, supersessionInPath, supersessionLines, verdictLines, isReportLike, verdictWord } from './lines.ts';
import { definitionsInBranch, definitionsInPath, definitionsInSubject, definitionsInText, familyOf, keepTwoLetterGroups, mentionMatcher, mentionsInName } from './numbering.ts';
import { parseLogZ } from './git-read.ts';
import { arrangementKind, frontMatter, identOf, parseArrangement } from './arrangements.ts';
import { compilerReads, testCases, tsDeps, generatedOf } from './code.ts';
import { counts, specifierNames } from './code-engine.ts';
import { diffSections, sectionMap } from './docs.ts';

// ───────────────────────── dates written in a text ─────────────────────────

test('a date on the line itself wins; month-day forms need a year from an earlier full date, and 5-6 is never a date', () => {
  assert.deepEqual(datesOnLine('见 2026-09-26 的记录', null).map((d) => d.at), ['2026-09-26']);
  assert.deepEqual(datesOnLine('2026年9月3日 定下', null).map((d) => d.at), ['2026-09-03']);
  assert.deepEqual(datesOnLine('09-26 再看', null), [], 'no year known yet');
  assert.deepEqual(datesOnLine('09-26 再看', 2026).map((d) => d.at), ['2026-09-26']);
  assert.deepEqual(datesOnLine('第 5-6 行', 2026), [], 'not zero-padded: a range, not a date');
  assert.deepEqual(datesOnLine('9月26日', 2026).map((d) => d.at), ['2026-09-26']);
  assert.deepEqual(datesOnLine('2026-02-30 is no day', null), []);
});

test('an entry takes its 日期 line, else its own heading date, else the document date; "最后更新" is never the document date', () => {
  const text = [
    '# Decisions',                                   // 1
    '',                                             // 2
    '编写：Main agent。最后更新：2026-09-26（D3）。', // 3 — a last update, not the document's date
    '',                                             // 4
    '**D1 · Keep invoices forever.**',              // 5
    '日期：2026-08-01。Owner confirmed.',            // 6
    '> 「永远不删」',                                 // 7
    '',                                             // 8
    '**D2 补（2026-08-03）· Void instead.**',        // 9
    'The owner said so.',                           // 10
    '',                                             // 11
    '**D3 · No date here.**',                       // 12
    'Nothing dated.',                               // 13
  ].join('\n');
  const d = dateContext(text);
  assert.equal(d.document, null, '最后更新 is not a stated date of the document');
  assert.deepEqual(d.at(7), { at: '2026-08-01', line: 6, how: 'entry' });
  assert.deepEqual(d.at(10), { at: '2026-08-03', line: 9, how: 'entry-head' });
  assert.equal(d.at(13), null, 'D3 has no written date: the caller falls back to the file time');
  assert.equal(d.at(3)?.at, '2026-09-26', 'the line itself says a date');
  const withDoc = dateContext('# Plan\n\n编写角色：PA。日期：2026-09-20。状态：v3.0\n\n## One\n\nText.\n');
  assert.deepEqual(withDoc.document, { at: '2026-09-20', line: 3, how: 'document' });
  assert.equal(withDoc.at(7)?.at, '2026-09-20');
});

// ───────────────────────── explicit supersession ─────────────────────────

test('an obsolete list gives one row per table row and list item, never its header; other lines by their phrase', () => {
  const text = [
    '# Product',
    '',
    '## 5. 已纠正的旧规则',
    '',
    '以下规则曾写在旧计划里，**已作废**。',
    '',
    '| 旧规则 | 问题 | 现在 |',
    '|---|---|---|',
    '| 同一模型拒绝保存 | 常规用法被禁 | 允许相同 |',
    '| 纸条每轮清空 | 收不到 | 持续有效 |',
    '',
    '### 5.1 More',
    '- 旧的 50 轮一批',
    '',
    '## 6. Timeline',
    '',
    '| 日期 | 决定 |',
    '|---|---|',
    '| 2026-09-10 | Rewrite |',
    '',
    'The sync design is superseded by PDF-2 (the server renderer).',
    'Module v0.3 → v0.4 on the same day.',
    '### F-1 — 已作废的后台任务又被登记',
    '- a finding about obsolete tasks is not a list of them',
  ].join('\n');
  const lines = supersessionLines(text);
  const rows = lines.filter((l) => l.obsoleteList);
  assert.deepEqual(rows.map((r) => r.line), [9, 10, 13]);
  assert.equal(rows[0]!.target, '同一模型拒绝保存');
  assert.equal(rows[0]!.listHeading, 'Product › 5. 已纠正的旧规则');
  assert.equal(rows[2]!.listHeading, 'Product › 5. 已纠正的旧规则', 'a subsection belongs to the obsolete section');
  assert.ok(!lines.some((l) => l.line === 5), 'an obsolete-list introduction is not itself an old rule');
  const by = lines.find((l) => l.pattern === 'superseded by')!;
  assert.equal(by.target, 'PDF-2 (the server renderer)');
  assert.equal(lines.find((l) => l.pattern === 'version replacement')?.target, 'v0.3 → v0.4');
  assert.ok(!lines.some((l) => l.line >= 17 && l.line <= 19), 'the timeline table is not an obsolete list');
  assert.ok(!lines.some((l) => l.line === 24 && l.obsoleteList), 'a finding heading about obsolete things is not a list');
});

test('explicit old and new sides: generic questions and a rule about replacement do not supersede their entry', () => {
  const rows = supersessionLines([
    '# Decisions',
    '**D82 · 历史的读法。**',
    '历史出现时写明被什么取代，说明哪些内容退役。',
    'D21、D23 被 D60 取代。',
    '**D61 · 本条取代 D40 里旧的限制。**',
    '**D62 · 已被 D70 取代。**',
    '**D63 · 已作废。**',
    '~~聊天当首页~~ → 地图当首页',
    'The old export is deprecated.',
    '| 旧说法 | 读作 |',
    '| --- | --- |',
    '| 逐级整理 D80 | 按问题深挖 |',
    '| D51 | D52 |',
  ].join('\n'));
  assert.ok(!rows.some((r) => r.line === 3));
  assert.deepEqual(rows.filter((r) => r.line >= 4 && r.line <= 7).map((r) => [r.replaced, r.replacement, r.syntax]), [
    ['D21、D23', 'D60', 'passive'], ['D40 里旧的限制', 'D61', 'active'], ['D62', 'D70', 'passive'], ['D63', null, 'entry-status'],
  ]);
  assert.deepEqual(rows.filter((r) => r.line >= 8).map((r) => [r.replaced, r.replacement, r.syntax]), [
    ['聊天当首页', '地图当首页', 'struck-arrow'], ['The old export', null, 'status'],
    ['逐级整理 D80', '按问题深挖', 'comparison-row'], ['D51', 'D52', 'comparison-row'],
  ]);
  assert.deepEqual(replacedNumbers('D21、D23'), ['D21', 'D23']);
  assert.deepEqual(replacedNumbers('D21 和 D23'), ['D21', 'D23']);
  assert.deepEqual(replacedNumbers('E57 安排的四次'), [], 'the source of a plan is not itself the retired work');
  assert.deepEqual(replacedNumbers('逐级整理 D80'), [], 'an incidental number in an old phrase is not the old entry');
});

test('a row or a new entry may name another entry as the old side without replacing itself', () => {
  const lines = supersessionLines([
    '## SP-1 · CKC-06 被 CKC-22、CKC-23 取代',
    'D32 采用、v1.0 被 v2.0 取代。',
    'E57 安排的四次全部作废。',
  ].join('\n'));
  assert.deepEqual(lines.map((r) => [r.replaced, r.replacement]), [
    ['CKC-06', 'CKC-22、CKC-23'], ['v1.0', 'v2.0'], ['E57 安排的四次全部', null],
  ]);
  assert.deepEqual(lines.flatMap((r) => replacedNumbers(r.replaced)), ['CKC-06']);
});

test('a path whose name says superseded is recorded once, at the segment that says it', () => {
  assert.deepEqual(supersessionInPath('design/archive/superseded-by-v0.4-20260916/product/PRD.md'), { at: 'design/archive/superseded-by-v0.4-20260916/', pattern: 'superseded-by name', target: 'v0.4-20260916' });
  assert.equal(supersessionInPath('docs/PLAN.md'), null);
  assert.equal(supersessionInPath('docs/deprecated/old.md')?.pattern, 'obsolete name');
});

// ───────────────────────── verdicts ─────────────────────────

test('a verdict field is stated, a verdict word in a row is a candidate, a list of choices is a template', () => {
  const report = [
    '# AF — 独立里程碑 QC',
    '',
    '**结论：`fail`**',
    '状态：待第 2 轮 QC，等 T6 复审通过后 rebase',
    '结论：`pass` / `fail` / `incomplete`，加上确切提交号。',
    '| S3 | 自定义路径 | 不成立 |',
    'Tests: 511/511 pass',
    'ℹ fail 0',
    'T1 通过后，T2 开始',
    '### F-1【严重 · S3 失败】chat path ignored',
    '- **D-3** minor',
  ].join('\n');
  const v = verdictLines(report);
  const at = (line: number) => v.filter((x) => x.line === line);
  assert.deepEqual(at(3).map((x) => [x.kind, x.verdict, x.confidence]), [['verdict', 'fail', 'stated']]);
  assert.ok(!at(4).some((x) => x.confidence === 'stated'), 'a status waiting for a pass is no verdict');
  assert.deepEqual(at(5), [], 'the template names the choices, it chooses none');
  assert.deepEqual(at(6).map((x) => [x.verdict, x.confidence]), [['fail', 'candidate']]);
  assert.deepEqual(at(7).map((x) => [x.kind, x.verdict]), [['count', '511/511'], ['verdict', 'pass']].slice(0, at(7).length));
  assert.equal(at(7)[0]!.verdict, '511/511');
  assert.deepEqual(at(8).map((x) => [x.kind, x.verdict]), [['count', '0 fail']]);
  assert.ok(!at(9).some((x) => x.kind === 'count'), 'the 1 of T1 is not a count');
  assert.deepEqual(at(10).filter((x) => x.kind === 'finding').map((x) => [x.verdict, x.confidence]), [['F-1', 'stated']]);
  assert.deepEqual(at(11).filter((x) => x.kind === 'finding').map((x) => x.verdict), ['D-3']);
  assert.equal(verdictWord('部分做到'), 'partial');
  assert.equal(verdictWord('需修复'), 'needs-repair');
});

test('reports are known by folder, name or title; a prompt is not a report', () => {
  assert.ok(isReportLike('subagent/reports/AF-report.md', ''));
  assert.ok(isReportLike('Owner_review/qc/2026-07-24_T9_R4_QC.md', ''));
  assert.ok(isReportLike('notes/x.md', '# QC report of batch 3\n'));
  assert.ok(!isReportLike('subagent/AF-kimi-qc-byok-milestone.md', '# AF — prompt\n'));
});

// ───────────────────────── numbering ─────────────────────────

test('definitions decide the rules: headings, bold entries, an index table, front matter, names, subjects', () => {
  const text = [
    '---', 'id: "AK"', 'status: "complete"', '---',
    '# Index',
    '**D83 · Keeper is the clerk.**',
    '### CKC-22 Ledger',
    '- **R-52** the ledger',
    '| ID | Executor |', '|---|---|', '| AA | kimi |', '| AB | kimi |', '| AC | glm |',
    '| Thing | Value |', '|---|---|', '| UI | Compose |',
    '## AF — a heading that starts with two capitals is prose',
  ].join('\n');
  const defs = definitionsInText(text).map((d) => `${d.num}@${d.position}`);
  assert.deepEqual(defs, ['AK@front matter', 'D83@bold entry', 'CKC-22@heading', 'R-52@bold entry', 'AA@table first column', 'AB@table first column', 'AC@table first column']);
  assert.deepEqual(definitionsInPath('product/contracts/CKC-22-ledger-and-time.md').map((d) => d.num), ['CKC-22']);
  assert.deepEqual(definitionsInPath('subagent/runs/AA-1/status.json').map((d) => d.num), ['AA-1', 'AA'], 'a run directory reads both ways; the rules decide');
  assert.deepEqual(definitionsInPath('qc/2026-07-22_T5-round7-qc-request.md').map((d) => d.num), ['T5']);
  assert.deepEqual(definitionsInPath('README.md'), []);
  assert.deepEqual(definitionsInBranch('wip/AB-byok').map((d) => d.num), ['AB']);
  assert.deepEqual(definitionsInSubject('AB: rewire chat').map((d) => d.num), ['AB']);
  assert.deepEqual(definitionsInSubject('B1+B2: sources and sessions').map((d) => d.num), ['B1', 'B2']);
  assert.deepEqual(definitionsInSubject('docs(qc): T5 completion report'), []);
  assert.equal(familyOf('CK-M2')?.family, 'CK-M<n>');
  assert.equal(familyOf('V2')?.family, 'V<n>');
  assert.deepEqual(keepTwoLetterGroups([{ num: 'AA', g: 1 }, { num: 'AB', g: 1 }, { num: 'QC', g: 2 }, { num: 'D1', g: 3 }], (d) => String(d.g)).map((d) => d.num), ['D1'], 'fewer than three together: not an index');
});

test('mentions of the recognised rules only; two letters that are words are candidates in prose', () => {
  const rules = [
    { family: 'D<n>', shape: 'letter-digits' as const, defined: new Set(['D1']) },
    { family: 'CKC-<n>', shape: 'prefix-hyphen' as const, defined: new Set(['CKC-1']) },
    { family: 'two letters', shape: 'two-letters' as const, defined: new Set(['AB', 'AI']) },
  ];
  const match = mentionMatcher(rules)!;
  const m = match('D83 and CKC-22 replace D7; AB merged; AI helps; PDF-2 and V2 are not rules; xD83 is not one\nThe AI model');
  assert.deepEqual(m.map((x) => `${x.num}:${x.line}:${x.confidence}`), ['D83:1:stated', 'CKC-22:1:stated', 'D7:1:stated', 'AB:1:stated', 'AI:1:candidate', 'AI:2:candidate']);
  assert.deepEqual(mentionsInName('ag-d56-rules', [...rules, { family: 'two letters', shape: 'two-letters' as const, defined: new Set(['AG']) }]).sort(), ['AG', 'D56']);
});

// ───────────────────────── git's log, parsed ─────────────────────────

test('the NUL-separated raw and numstat log gives status, move source, content ids and rename-aware counts', () => {
  const Z = '\0';
  const out = [
    '\x1e' + 'a'.repeat(40) + '\x1f' + 'b'.repeat(40) + '\x1f2026-09-11T03:55:05-07:00\x1f2026-09-11T04:00:00-07:00\x1fRobin\x1fMerge AB\x1fBody line\nsecond\x04',
    '\n:100644 100644 ' + '1'.repeat(40) + ' ' + '2'.repeat(40) + ' M', 'docs/PRODUCT.md',
    ':100644 100644 ' + '3'.repeat(40) + ' ' + '4'.repeat(40) + ' R098', 'docs/PLAN.md', 'docs/plan/PLAN.md',
    ':100644 000000 ' + '5'.repeat(40) + ' ' + '0'.repeat(40) + ' D', 'docs/old.md',
    '3\t1\tdocs/PRODUCT.md', '2\t2\t', 'docs/PLAN.md', 'docs/plan/PLAN.md', '0\t9\tdocs/old.md',
    '\x1e' + 'c'.repeat(40) + '\x1f\x1f2026-07-20T17:58:10+09:00\x1f2026-07-20T17:58:10+09:00\x1fA\x1fRoot\x1f\x04',
    '\n:000000 100644 ' + '0'.repeat(40) + ' ' + '6'.repeat(40) + ' A', 'README.md', '-\t-\tREADME.md', '',
  ].join(Z);
  const [merge, root] = parseLogZ(out);
  assert.equal(merge!.hash, 'a'.repeat(40));
  assert.deepEqual(merge!.parents, ['b'.repeat(40)]);
  assert.equal(merge!.body, 'Body line\nsecond');
  assert.deepEqual(merge!.files.map((f) => [f.status, f.path, f.from, f.oldBlob?.[0] ?? null, f.newBlob?.[0] ?? null, f.added, f.deleted]), [
    ['M', 'docs/PRODUCT.md', null, '1', '2', 3, 1],
    ['R', 'docs/plan/PLAN.md', 'docs/PLAN.md', '3', '4', 2, 2],
    ['D', 'docs/old.md', null, '5', null, 0, 9],
  ]);
  assert.deepEqual(root!.parents, []);
  assert.deepEqual(root!.files.map((f) => [f.status, f.path, f.added]), [['A', 'README.md', null]], 'a binary file has no line counts');
});

// ───────────────────────── arrangements, code, sections ─────────────────────────

test('arrangement files by convention; front matter, index rows and run status read into fields', () => {
  assert.equal(arrangementKind('subagent/INDEX.md'), 'index');
  assert.equal(arrangementKind('subagent/AK-grok-fix.md'), 'prompt');
  assert.equal(arrangementKind('subagent/runs/AA-1/status.json'), 'status');
  assert.equal(arrangementKind('subagent/reports/AK-report.md'), 'receipt');
  assert.equal(arrangementKind('subagent/execution-plan-k.md'), 'plan');
  assert.equal(arrangementKind('docs/notes.md'), null);
  const prompt = '---\nid: "AK"\nexecutor: "grok"\nstatus: "running"\nworktree: "D:\\\\app\\\\.worktrees\\\\AK"\nbase_commit: "5a49848"\n---\n# AK — fix\n\nDepends on AB.\n';
  assert.deepEqual(frontMatter(prompt)?.status, 'running');
  const p = parseArrangement('prompt', prompt);
  assert.ok(p.parsed);
  assert.equal(p.data.running, true);
  assert.equal(p.data.baseline, '5a49848');
  assert.equal(identOf('subagent/AK-grok-fix.md', p.data.fields ?? null), 'AK');
  const index = parseArrangement('index', '# Index\n\n| ID | Executor | Prompt |\n|---|---|---|\n| AA | kimi | [x](AA.md) |\n| AB | glm | [y](AB.md) |\n');
  assert.deepEqual(index.data.rows?.map((r) => [r.id, r.cells.Executor]), [['AA', 'kimi'], ['AB', 'glm']]);
  const status = parseArrangement('status', JSON.stringify({ status: 'incomplete', agent: 'kimi', model: 'k3', worktree: 'D:\\wt', preflight: { base_commit: '4127e4a' } }));
  assert.deepEqual([status.data.status, status.data.agent, status.data.baseline], ['incomplete', 'kimi', '4127e4a']);
  assert.equal(parseArrangement('status', '{ not json').parsed, false, 'unreadable: read it whole and judge');
});

test('dependencies: TypeScript through the compiler; which code-engine references count; history matches a specifier by stem; test cases and generated files', () => {
  const tracked = new Set(['src/a.ts', 'src/b.ts', 'src/c/index.ts']);
  assert.deepEqual(tsDeps('src/a.ts', "import { b } from './b.ts';\nimport x from './c';\nimport fs from 'node:fs';\nconst later = await import('./b.ts');\n", tracked).map((d) => [d.dst, d.external]),
    [['src/b.ts', false], ['src/c/index.ts', false], ['node:fs', true]], 'await import() of the same file is the same dependency');
  assert.deepEqual(['src/a.ts', 'ui/app.jsx', 'lib/x.mjs', 'lib/app.dart', 'tools/p.py', 'App.vue'].map(compilerReads), [true, true, true, false, false, false], 'the compiler reads TypeScript and JavaScript; the code engine the rest');
  // The code engine's references count when resolved otherwise than by a matching name (code-engine.ts COUNTED_FROM).
  for (const [how, confidence] of [['import', 0.9], ['file-path', 0.7], ['qualified-name', 0.85], ['instance-method', 0.9], ['instance-method', 0.8], ['function-ref', 0.95], ['function-ref', 0.85]] as const) {
    assert.equal(counts(how, confidence), true, `${how} ${confidence} counts`);
  }
  for (const [how, confidence, why] of [['instance-method', 0.7, 'the only method of that name in the codebase'], ['instance-method', 0.65, 'a method name scored against the receiver\'s words'],
    ['function-ref', 0.8, 'a cross-file function taken as the only one of that name'], ['exact-match', 0.9, 'a matching name'], ['fuzzy', 0.5, 'a similar name']] as const) {
    assert.equal(counts(how, confidence), false, `${how} ${confidence} does not count: ${why}`);
  }
  assert.equal(counts(null, null), true, 'an edge the extractor made itself');
  assert.equal(counts(null, null, 'heuristic'), false);
  // A historical version's import specifiers name the target by its stem.
  assert.ok(specifierNames('package:shop_app/core/database/startup/orders_startup_coordinator.dart', 'orders_startup_coordinator.dart'));
  assert.ok(specifierNames('../util', 'util.ts'));
  assert.ok(specifierNames('pkg.sub', 'sub.py'));
  assert.ok(specifierNames('com.example.Bar', 'Bar.kt'));
  assert.ok(specifierNames('x_models.dart', 'x_models.dart'));
  assert.ok(specifierNames('example.com/proj/internal/store', 'store.go'));
  assert.ok(!specifierNames('package:flutter/material.dart', 'providers.dart'));
  assert.ok(!specifierNames('pkg.sub', 'pkg.py'), 'a dotted module names its last part');
  assert.equal(testCases('typescript', "test('a', () => {});\nit('b', () => {});\ndescribe('c', () => {});\n"), 2);
  assert.equal(testCases('dart', "testWidgets('a', (t) async {});\ntest('b', () {});\n"), 2);
  assert.equal(generatedOf('lib/x.g.dart', null).generated, true);
  assert.equal(generatedOf('lib/x.dart', '// GENERATED CODE - DO NOT MODIFY BY HAND\n').generated, true);
  assert.equal(generatedOf('pubspec.lock', null).how, 'name: lock file');
  assert.equal(generatedOf('src/app.ts', 'export {}\n').generated, false);
});

test('the section diff of two versions names sections by heading path, a repeated heading by its position', () => {
  const before = '# Plan\n\n## Scope\n\nCSV.\n\n## Notes\n\nA\n\n## Notes\n\nB\n';
  const after = '# Plan\n\n## Scope\n\nCSV and PDF.\n\n## Notes\n\nA\n\n## Risks\n\nNone.\n';
  assert.deepEqual([...sectionMap(before).keys()], ['Plan', 'Plan › Scope', 'Plan › Notes', 'Plan › Notes #2']);
  assert.deepEqual(diffSections(before, after), { added: ['Plan › Risks'], removed: ['Plan › Notes #2'], changed: ['Plan › Scope'] });
  assert.deepEqual(diffSections(null, '# A\n\nx\n'), { added: ['A'], removed: [], changed: [] });
});
