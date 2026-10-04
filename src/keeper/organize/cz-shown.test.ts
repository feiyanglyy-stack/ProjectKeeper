/**
 * CZ: what the program shows decides the reading — on "Tidewater", an invented project with two archived plan sets (the
 * first with a task table, a contract index the current plan carries on, a README table of readings and a contract
 * file), a current plan with a contract table whose "Depends on" column qualifies some of its clauses, a decision record
 * kept as bold entries, a README table of readings awaiting the owner, a side decision log numbered V, and an operations
 * log kept as a table; and on "Burrow", a project of another shape: no decision log, a batch table, two-letter tickets,
 * no archive.
 *
 *   1 · a candidate generation says its work (rows of its plan documents), what went on under the same number and what
 *       its other documents define, each apart; an item joins by the document it was written from, never by number alone;
 *   2 · the entry gate also counts a current document that alone defines a number family; a not-a-number family is a
 *       numbering in the one document that holds a series of it at its headings;
 *   3 · a number is written once: an id that is a number updates the item carrying it; a table row's reference item is
 *       named "number · title"; pk_round_state counts the numbers two items of one category carry;
 *   4 · relations the fill wrote can be corrected: replaceDependsOn, pk_relate withdraw, and a "depends on" cell links
 *       only the clauses that hold nothing but identifiers;
 *   5 · Burrow: nothing new is demanded of it, and nothing crashes;
 *   6 · an item carried on under the same number stays current work for every reader of a generation's items.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Project, ScopeItem, Source } from '../../model/types.ts';
import type { ClerkRound, ClerkStage, LayerEntry, RoundKind } from '../../model/k-types.ts';
import { ProjectStore } from '../../store/project-store.ts';
import { Ledger } from '../../ledger/index.ts';
import { ledgerPath, rebuildLedgerInPlace } from '../../ledger/rebuild.ts';
import { definitionsInText, isSeries, mentionMatcher, mentionsInName } from '../../ledger/numbering.ts';
import { keeperTools } from '../tools.ts';
import { clerkTools, type ClerkToolContext } from '../clerk-tools.ts';
import { stageTools } from './stage-tools.ts';
import { entryGapsNow, entryGateRefusal, entryGateTools, soleDefiners } from './entry-gate.ts';
import { placeTools } from './place-tools.ts';
import { duplicateNumbers, roundOpen } from './round-open.ts';
import { carriedOn, earlierGenerationOf, earlierWork } from './carried-on.ts';
import { analyze } from '../../process/analysis.ts';
import { computeFindings } from '../../process/breakpoints.ts';
import { processView } from '../../server/k-views.ts';
import { graphView } from '../../server/graph-view.ts';
import { candidateWorkLines, carriedOnItems, destinationOf, generationCandidates, generationCandidatesBlock, itemsWithoutDestination, listsWork, originOf } from './generation-check.ts';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-cz-'));
after(() => { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const AT = '2026-10-03T10:00:00.000Z';

// ───────────────────────── a project, its ledger, its workbench ─────────────────────────

interface Fixture { readonly project: Project; readonly repo: string; readonly files: Record<string, string>; readonly baseHome: string; readonly scope: ScopeItem; readonly commits: Record<string, string> }

function fixture(name: string, steps: readonly { readonly message: string; readonly date: string; readonly files: Record<string, string> }[]): Fixture {
  const repo = join(scratch, name);
  mkdirSync(repo);
  const git = (args: string[], date: string): string => execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@tide.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@tide.invalid' }, windowsHide: true,
  }).trim();
  const files: Record<string, string> = {};
  const commits: Record<string, string> = {};
  git(['init', '-q', '-b', 'main'], steps[0]!.date);
  git(['config', 'core.autocrlf', 'false'], steps[0]!.date);
  for (const step of steps) {
    for (const [rel, text] of Object.entries(step.files)) { files[rel] = text; const full = join(repo, rel); mkdirSync(resolve(full, '..'), { recursive: true }); writeFileSync(full, text); }
    git(['add', '-A'], step.date);
    git(['commit', '-q', '-m', step.message], step.date);
    commits[step.message] = git(['rev-parse', 'HEAD'], step.date);
  }
  const scope = { id: `scope_${name}`, path: repo, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null,
    readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as unknown as ScopeItem;
  const project = { id: name, name, locations: [repo], scope: [scope], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en',
    organizingPaused: false, createdAt: AT, lastOpenedAt: null, lastScopedAt: null, takeoverDepth: 'Full' } as unknown as Project;
  const baseHome = mkdtempSync(join(scratch, `home-${name}-`));
  rebuildLedgerInPlace(ledgerPath(project.id, baseHome), project);
  return { project, repo, files, baseHome, scope, commits };
}

const doc = (...lines: string[]): string => `${lines.join('\n')}\n`;

const TIDE = fixture('tidewater', [
  { message: 'Set the first plan aside', date: '2026-08-10T12:00:00Z', files: {
    'archive/first/PLAN.md': doc('# Plan (first)', '', '## Tasks', '', '| ID | Task | Status |', '| --- | --- | --- |', '| TW-01 | Sink the piles | done |', '| TW-02 | Hang the gauge | done |', '| TW-03 | Paint the scale | dropped |', '',
      '## Contracts', '', '| ID | Contract |', '| --- | --- |', '| TC-01 | The gauge reads |', '| TC-02 | The log keeps |', '',
      '## Acceptance moved out', '', '| ID | Criterion |', '| --- | --- |', '| AC-2 | The gauge is read at slack water |', '| AC-3 | The reading is written within the hour |', '',
      '## Why', '', '- **D2**：the piles came first.'),
    'archive/first/README.md': doc('# Readings (first)', '', '| ID | Reading | Answer |', '| --- | --- | --- |', '| U1 | Who reads at night | the keeper |', '| U2 | Which datum | chart datum |', '| U3 | How often | hourly |', '| U4 | Where the log lives | the office |'),
    'archive/first/contracts/TC-01-gauge.md': doc('# TC-01 The gauge reads', '', '| ID | Criterion |', '| --- | --- |', '| AC-1 | The gauge shows the level |', '| AC-2 | The gauge is read at slack water |', '| AC-3 | The reading is written within the hour |'),
  } },
  { message: 'Set the second plan aside', date: '2026-08-20T12:00:00Z', files: {
    'archive/second/PLAN.md': doc('# Plan (second)', '', '| ID | Task |', '| --- | --- |', '| TW-01 | Sink the piles again |', '| TW-04 | Light the gauge |', '| TW-05 | Roof the hut |'),
  } },
  { message: 'Plan the harbour', date: '2026-09-01T12:00:00Z', files: {
    'docs/PLAN.md': doc('# Plan', '', '## 3 · Increments', '', '### P1 · The gauge', '', 'One gauge, read and logged.', '', '## 7 · Contracts', '',
      '| ID | Contract | Depends on | Status |', '| --- | --- | --- | --- |',
      '| TC-01 | The gauge reads | — | ready |', '| TC-02 | The log keeps | TC-01 | ready |', '| TC-03 | The alarm rings | TC-01、TC-02；AC 级：TC-04 | ready |', '| TC-04 | The harbour hears | 无；经 TC-03 验收 | draft |'),
    'docs/contracts/TC-01-gauge.md': doc('# TC-01 The gauge reads', '', '| ID | Criterion |', '| --- | --- |', '| AC-1 | The gauge shows the level |', '| AC-2 | The gauge is read at slack water |', '| AC-3 | The reading is written within the hour |'),
    'docs/DECISIONS.md': doc('# Decisions', '', '**D1 · One gauge first.** The owner: 「先一个」.', '', '**D2 · Piles before the gauge.** The piles came first.', '', '**D3 · Chart datum.** Zero is chart datum.'),
    'README.md': doc('# Tidewater', '', 'Reads the tide.', '', '## Readings waiting for the owner', '', '| ID | Reading |', '| --- | --- |', '| U5 | The alarm rings at spring tides only |', '| U6 | The harbour office is told by radio |', '| U7 | A missed reading is written as missed |'),
    'notes/harbour-log.md': doc('# Harbour office log', '', '### V1 · Readings are taken at slack water', '', 'Agreed with the pilot.', '', '### V2 · The lamp is lit for night readings', '', 'So the scale can be seen.', '', '**V2 补** The lamp is red.', '', '### V4 · The log is copied weekly', '', 'To the office.'),
    'docs/release.md': doc('# Releases', '', '## V2 notes', '', 'The second release reads faster.'),
    'docs/OPS.md': doc('# Operations log', '', '| No. | Decision | Date |', '| --- | --- | --- |', '| E1 | Readings every hour | 2026-08-01 |', '| E2 | Gauge zero at chart datum | 2026-08-02 |', '| E3 | Night readings by lamp | 2026-08-03 |'),
    'docs/questions-a.md': doc('# Questions A', '', '## Q1 Who pays', '', 'Open.', '', '## Q2 Who reads', '', 'Open.'),
    'docs/questions-b.md': doc('# Questions B', '', '## Q1 Who pays', '', 'Open.', '', '## Q2 Who reads', '', 'Open.'),
  } },
]);

const TIDE_LAYERS: readonly [string, LayerEntry['layer'], boolean][] = [
  ['docs/PLAN.md', 'Plan', true], ['docs/DECISIONS.md', 'Decision record', true], ['README.md', 'Readme', true], ['docs/contracts', 'Task contract', true],
  ['archive/first/PLAN.md', 'Plan', false],
];

/** Another shape: no decision log, a batch table, two-letter tickets with their prompts, no archive. */
const BURROW = fixture('burrow', [
  { message: 'The burrow', date: '2026-09-05T12:00:00Z', files: {
    'README.md': doc('# Burrow', '', 'A pet diary.'),
    'docs/batches.md': doc('# Batches', '', '| 批次 | 内容 | 票 |', '| --- | --- | --- |', '| 批次 1 | 登录与日记 | AA、AB |', '| 批次 2 | 相册 | AC、AD |'),
    'tasks/INDEX.md': doc('# Tickets', '', '| ID | Ticket | Depends on | Status |', '| --- | --- | --- | --- |', '| AA | Sign in | — | done |', '| AB | Write a diary entry | AA | done |', '| AC | Add a photo | AA、AB | doing |', '| AD | Share an album | AC；等 AB 验收 | todo |'),
    'tasks/AA-sign-in.md': doc('---', 'id: "AA"', 'status: "done"', '---', '', '# AA · Sign in', '', 'Do it.'),
    'tasks/AB-diary.md': doc('---', 'id: "AB"', 'status: "done"', '---', '', '# AB · Write a diary entry', '', 'Do it.'),
    'tasks/AC-photo.md': doc('---', 'id: "AC"', 'status: "doing"', '---', '', '# AC · Add a photo', '', 'Do it.'),
  } },
]);
const BURROW_LAYERS: readonly [string, LayerEntry['layer'], boolean][] = [['README.md', 'Readme', true], ['docs/batches.md', 'Plan', true], ['tasks/INDEX.md', 'Task index', true]];

/** A document's sources as the scan cuts them: one per heading's section. */
function sectionSources(f: Fixture, rel: string, text: string): Source[] {
  const lines = text.split('\n');
  const heads = lines.flatMap((l, i) => { const m = /^(#{1,6})\s+(.*)$/.exec(l); return m ? [{ line: i + 1, text: m[2]!.trim() }] : []; });
  return heads.map((h, k) => {
    const end = (heads[k + 1]?.line ?? lines.length + 1) - 1;
    return {
      id: `src_${rel.replace(/\W/g, '_')}_${h.line}`, projectId: f.project.id, title: h.text, anchor: { kind: 'file', path: join(f.repo, ...rel.split('/')), headingPath: [h.text], lineStart: h.line, lineEnd: end },
      ids: [], version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt: lines.slice(h.line - 1, end).join('\n'), usedAs: 'Design', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: f.scope.id, hasCredential: false, bytes: 10,
    } as unknown as Source;
  });
}

type Called = { text: string; error: boolean; json: Record<string, unknown> };

function bench(f: Fixture, layers: readonly [string, LayerEntry['layer'], boolean][], kind: RoundKind = 'First usable', stage: ClerkStage = 'reconcile') {
  const home = mkdtempSync(join(scratch, 'bench-'));
  const store = ProjectStore.open(f.project.id, home);
  copyFileSync(ledgerPath(f.project.id, f.baseHome), join(store.dir, 'ledger.sqlite'));
  for (const [path, layer, current] of layers) store.layers.put({ id: `layer_${path}`, projectId: f.project.id, repo: f.repo, path, layer, note: null, current, roundId: null, updatedAt: AT });
  for (const [rel, text] of Object.entries(f.files)) for (const s of sectionSources(f, rel, text)) store.sources.put(s);
  store.clerkRounds.put({
    id: 'round_1', projectId: f.project.id, kind, number: 1, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root',
    questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT,
    stage, stageLog: [{ stage, startedAt: AT, endedAt: null, timing: null }], lanes: [],
  } as ClerkRound);
  const ctx = { store, project: f.project, jobId: 'job_main', jobKind: 'Organizing', model: null, step: { roundId: 'round_1', kind: 'main', path: null }, stageEntered: () => ({ note: null }) } as unknown as ClerkToolContext;
  const tools: ToolDefinition[] = [...keeperTools(ctx), ...clerkTools(ctx), ...stageTools(ctx, { coverageSettled: () => true, stageSkill: (s) => `SKILL ${s}` }), ...entryGateTools(ctx), ...placeTools(ctx)];
  const call = async (name: string, args: Record<string, unknown>): Promise<Called> => {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, name);
    let text = '';
    let error = false;
    try {
      const r = await (tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)('call', structuredClone(args));
      text = r.content.map((c) => c.text).join('\n');
      error = r.isError === true;
    } catch (e) { text = (e as Error).message; error = true; }
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* prose */ }
    return { text, error, json };
  };
  const ok = async (name: string, args: Record<string, unknown>) => { const r = await call(name, args); assert.equal(r.error, false, `${name} ${JSON.stringify(args).slice(0, 160)} → ${r.text}`); return r.json; };
  const setStage = (s: ClerkStage, k: RoundKind = kind) => store.clerkRounds.put({ ...store.clerkRounds.get('round_1')!, kind: k, stage: s });
  const withLedger = <T>(fn: (l: Ledger) => T): T => { const l = Ledger.openDir(store.dir)!; try { return fn(l); } finally { l.close(); } };
  const src = (rel: string, heading: string) => store.sources.find((s) => s.anchor.kind === 'file' && s.anchor.path.replace(/\\/g, '/').endsWith(rel) && s.title === heading)!.id;
  const thread = (n: string) => store.threads.find((t) => t.ids.includes(n))!;
  const refs = (n: string, category?: string) => store.reference.filter((r) => r.ids.includes(n) && (!category || r.category === category));
  return { store, call, ok, setStage, withLedger, src, thread, refs };
}

const CONTRACTS = { path: 'docs/PLAN.md', table: { heading: 'Contracts' }, into: 'threads', columns: { title: 'Contract', id: 'ID', dependsOn: 'Depends on', status: 'Status' } };

// ───────────────────────── 2 · a not-a-number family in the one document that holds a series of it ─────────────────────────

test('a not-a-number family is a numbering in the document that defines a series of it at its headings, and nowhere else', () => {
  assert.equal(isSeries(['V1', 'V2', 'V4']), true, 'three, nearly consecutive');
  assert.equal(isSeries(['V1', 'V2']), false, 'two are no series');
  assert.equal(isSeries(['SHA-1', 'SHA-256', 'SHA-512']), false, 'standard names, far apart');
  assert.equal(isSeries(['V1', 'V7', 'V30']), false);
  const log = definitionsInText(TIDE.files['notes/harbour-log.md']!);
  assert.deepEqual(log.map((d) => [d.num, d.family, d.position, d.line]), [['V1', 'V<n>', 'heading', 3], ['V2', 'V<n>', 'heading', 7], ['V4', 'V<n>', 'heading', 13]], 'the headings; the bold supplement is not an entry of its own');
  assert.deepEqual(definitionsInText(TIDE.files['docs/release.md']!), [], 'one heading is a version label');
  assert.deepEqual(definitionsInText('# Notes\n\n**V1** first.\n\n**V2** second.\n\n**V3** third.\n\n| V1 | a |\n| V2 | b |\n| V3 | c |\n'), [], 'only headings make the series');
  assert.deepEqual(definitionsInText('# Type scale\n\n## H1 Title\n\n## SHA-256 digest\n\n## UTF-8 only\n'), [], 'heading levels and standard names stay what they are');
  // Elsewhere it stays a version label: the rule is never looked for in prose or in names.
  const rules = [{ family: 'V<n>', shape: 'letter-digits' as const, defined: new Set(['V1', 'V2', 'V4']) }];
  assert.equal(mentionMatcher(rules), null);
  assert.deepEqual(mentionsInName('docs/v2-plan.md', rules), []);
  const mixed = mentionMatcher([...rules, { family: 'D<n>', shape: 'letter-digits' as const, defined: new Set(['D1']) }])!;
  assert.deepEqual(mixed('See D1 and V2 for the second version.').map((m) => m.num), ['D1']);
});

// ───────────────────────── 1 · candidate generations ─────────────────────────

test('a candidate says its work, what was carried on and what its other documents define, each apart', () => {
  const b = bench(TIDE, TIDE_LAYERS, 'First usable', 'orientation');
  const { first, second, block } = b.withLedger((l) => {
    const all = generationCandidates(b.store, l);
    return { first: all.find((c) => c.key === 'set:archive/first')!, second: all.find((c) => c.key === 'set:archive/second')!, block: generationCandidatesBlock(b.store, l) };
  });
  assert.deepEqual(first.numbers, ['TW-01', 'TW-02', 'TW-03'], 'the rows of its plan table that no current document lists');
  assert.deepEqual(first.carriedOn, ['TC-01', 'TC-02'], 'the rows the current plan lists too are not dropped');
  assert.deepEqual(first.alsoDefined, [{ family: 'U<n>', count: 4, documents: ['archive/first/README.md'], continuedIn: 'README.md' }], 'a README table is not a plan: listed apart, with the current document that goes on with the family');
  assert.ok(![...first.numbers, ...first.carriedOn].some((n) => /^(?:AC-|D|U)/.test(n)), 'no criterion of a contract, no decision referred to in bold, no reading');
  assert.deepEqual([second.numbers, second.carriedOn, second.alsoDefined], [['TW-01', 'TW-04', 'TW-05'], [], []]);
  // The words the main agent reads.
  assert.match(block, /its work — the rows of its plan documents that no current document lists \(3\): TW-01, TW-02, TW-03/);
  assert.match(block, /carried on under the same number \(2\): TC-01, TC-02 — current documents list these rows too; the current items of those numbers are its items, with that destination/);
  assert.match(block, /also defined in this set, not in a plan document: U<n> \(4\) in archive\/first\/README\.md — README\.md continues the family\. These are not its work items/);
  assert.doesNotMatch(block, /the work items carrying/, 'the wording that made 60 readings work items is gone');
  assert.doesNotMatch(block, /U1|U2/, 'no reading is listed as a number of the generation');
  assert.deepEqual(candidateWorkLines({ ...first, numbers: [], carriedOn: [], alsoDefined: [] }), ['its plan documents list no row that only they define (the program found no plan table, task index or contract set in it)']);
  // Which documents list work: the mapped layer of the file, its name, the directory it stands in.
  assert.equal(listsWork(b.store, 'archive/first', 'archive/first/PLAN.md'), true);
  assert.equal(listsWork(b.store, 'archive/first', 'archive/first/README.md'), false);
  assert.equal(listsWork(b.store, 'archive/first', 'archive/first/contracts/TC-01-gauge.md'), true, 'a contract in a contract set');
  assert.equal(listsWork(b.store, null, 'docs/PLAN.md'), true);
  assert.equal(listsWork(b.store, null, 'docs/OPS.md'), false);
});

test('accepting: only the rows of its plan documents are work to fill; an item joins by the document it was written from, never by its number alone', async () => {
  const b = bench(TIDE, TIDE_LAYERS, 'First usable', 'reconcile');
  await b.ok('pk_fill_from_table', CONTRACTS);
  // A work item written by hand, with no source: it carries a number of the first set.
  await b.ok('pk_write_thread', { title: 'Paint the scale', ids: ['TW-03'], progress: 'Planned' });
  const accepted = await b.ok('pk_generation_candidate', { key: 'set:archive/first', verdict: 'accept', name: 'First plan' });
  const gen = (name: string) => b.store.generations.find((g) => g.name === name)!;
  const numbers = (name: string) => gen(name).workIds.map((id) => b.store.threads.get(id)!.ids[0]).sort();
  assert.deepEqual(accepted.numbersWithNoWorkItem, ['TW-01', 'TW-02']);
  assert.match(String(accepted.note), /Its plan documents list these rows[^]*pk_fill_from_table/);
  assert.deepEqual([(accepted.carriedOn as { count: number; numbers: string[] }).count, (accepted.carriedOn as { numbers: string[] }).numbers], [2, ['TC-01', 'TC-02']]);
  assert.deepEqual(accepted.alsoDefined, [{ family: 'U<n>', count: 4, in: ['archive/first/README.md'], continuedIn: 'README.md' }]);
  assert.match(String(accepted.alsoDefinedNote), /not work items of this generation, and nothing here asks a lane to fill them as work/);
  assert.deepEqual(accepted.notJoined, ['TW-03'], 'the item written by hand names no source: its number alone does not make it the generation’s');
  assert.deepEqual(numbers('First plan'), ['TC-01', 'TC-02'], 'the current items of the rows carried on, written from the current plan');
  // The generation's lane fills its task table: those items were written from its document, and join it.
  await b.ok('pk_fill_from_table', { path: 'archive/first/PLAN.md', table: { heading: 'Tasks' }, into: 'threads', columns: { title: 'Task', id: 'ID', status: 'Status' } });
  assert.deepEqual(b.withLedger((l) => originOf(b.store, l, b.thread('TW-01'))), ['archive/first/PLAN.md']);
  await b.ok('pk_round_state', {});
  assert.deepEqual(numbers('First plan'), ['TC-01', 'TC-02', 'TW-01', 'TW-02', 'TW-03'], 'TW-03 too, now that the fill wrote it from the table');
  // The second set's plan defines TW-01 as well: the item written from the first set does not join by its number.
  const again = await b.ok('pk_generation_candidate', { key: 'set:archive/second', verdict: 'accept', name: 'Second plan' });
  assert.deepEqual([numbers('Second plan'), again.notJoined, again.numbersWithNoWorkItem], [[], ['TW-01'], ['TW-04', 'TW-05']]);
  await b.ok('pk_round_state', {});
  assert.deepEqual(numbers('Second plan'), [], 'and reading the round’s state adds none by number');
  assert.equal(b.store.threads.filter((t) => b.store.generations.filter((g) => g.workIds.includes(t.id)).length > 1).length, 0, 'no item stands in two generations');
  // Destinations: what was carried on under the same number has one; the first plan's own tasks wait for theirs.
  const carried = b.withLedger((l) => carriedOnItems(b.store, l));
  assert.deepEqual([...carried].map((id) => b.store.threads.get(id)!.ids[0]).sort(), ['TC-01', 'TC-02']);
  const inGeneration = new Set(b.store.generations.all().flatMap((g) => g.workIds));
  assert.deepEqual(destinationOf(b.store, b.thread('TC-01'), inGeneration, carried), { kind: 'carried', by: 'TC-01', how: 'carried on under the same number' });
  assert.deepEqual(itemsWithoutDestination(b.store).map((x) => x.number).sort(), ['TW-01', 'TW-02', 'TW-03']);
  // A current item carried on is current work: an earlier item it replaced has its destination through it.
  await b.ok('pk_relate', { type: 'replaces', fromId: b.thread('TC-02').id, toId: b.thread('TW-02').id, claim: 'The log took over the gauge’s notebook', basis: 'Explicit' });
  assert.deepEqual(itemsWithoutDestination(b.store).map((x) => x.number).sort(), ['TW-01', 'TW-03']);
});

// ───────────────────────── 2 · the entry gate ─────────────────────────

test('the entry gate counts a current document that alone defines a number family, whatever its layer', async () => {
  const b = bench(TIDE, TIDE_LAYERS, 'First usable', 'reconcile');
  assert.deepEqual(b.withLedger((l) => soleDefiners(b.store, l)).map((d) => [d.path, d.families]), [
    ['docs/OPS.md', ['E<n>']], ['docs/PLAN.md', ['TC-<n>']], ['notes/harbour-log.md', ['V<n>']], ['README.md', ['U<n>']],
  ], 'not the archived tables, not the one V2 heading, not Q<n> that two documents define, not the criteria inside a contract named by its number');
  await b.ok('pk_fill_from_table', CONTRACTS);
  await b.ok('pk_fill_from_bold', { path: 'docs/DECISIONS.md', category: 'Decision' });
  const before = entryGapsNow(b.store);
  assert.deepEqual(before.files.map((f) => [f.path, f.layer, f.families ?? null, f.defined, f.missing.map((m) => m.num)]), [
    ['docs/PLAN.md', 'Plan', null, 5, ['P1']],
    ['docs/DECISIONS.md', 'Decision record', null, 3, []],
    ['docs/OPS.md', 'Other', ['E<n>'], 3, ['E1', 'E2', 'E3']],
    ['notes/harbour-log.md', 'Other', ['V<n>'], 3, ['V1', 'V2', 'V4']],
    ['README.md', 'Readme', ['U<n>'], 3, ['U5', 'U6', 'U7']],
  ]);
  assert.match(entryGateRefusal(before, 'leave reconcile')!, /README\.md \(the only current document defining U<n>\): 3 of 3 — U5, U6, U7/);
  const held = await b.call('pk_stage', { to: 'synthesis' });
  assert.match(held.text, /and every number of a family that one current document alone defines/);
  // The side log is filled whole from its headings: each entry carries its V number, and is carried.
  const log = await b.ok('pk_fill_from_headings', { path: 'notes/harbour-log.md', level: 3, category: 'Decision' });
  assert.equal(log.written, 3);
  assert.deepEqual(b.store.reference.filter((r) => r.name.startsWith('V')).map((r) => [r.name, r.ids]), [['V1 · Readings are taken at slack water', ['V1']], ['V2 · The lamp is lit for night readings', ['V2']], ['V4 · The log is copied weekly', ['V4']]]);
  assert.equal((await b.ok('pk_fill_from_headings', { path: 'notes/harbour-log.md', level: 3, category: 'Decision' })).updated, 3, 'a rerun updates the same three');
  // A reading written by hand under its number, the plan's increment, and the rest accounted for by number.
  await b.ok('pk_write_reference', { category: 'Decision', name: 'U5 · The alarm rings at spring tides only', text: 'A reading of the plan author, waiting for the owner.', basis: 'Explicit', validity: 'Proposed', identity: 'Proposal', sourceIds: [b.src('README.md', 'Readings waiting for the owner')] });
  await b.ok('pk_write_reference', { category: 'Plan', name: 'P1 · The gauge', text: 'One gauge.', basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [b.src('docs/PLAN.md', 'P1 · The gauge')] });
  const account = await b.ok('pk_account_entries', { path: 'README.md', numbers: ['U6', 'U7'], why: 'Both were answered and struck by the owner in the same table.' });
  assert.equal(account.accounted, 2);
  await b.ok('pk_fill_from_table', { path: 'docs/OPS.md', table: {}, into: 'reference', category: 'Decision', columns: { title: 'Decision', id: 'No.' } });
  assert.equal(entryGapsNow(b.store).count, 0);
});

// ───────────────────────── 3 · a number is written once ─────────────────────────

test('a number is written once: a table row’s reference item is named “number · title”, an id that is a number updates the item carrying it, and duplicates are counted', async () => {
  const b = bench(TIDE, TIDE_LAYERS, 'First usable', 'reconcile');
  const ops = await b.ok('pk_fill_from_table', { path: 'docs/OPS.md', table: {}, into: 'reference', category: 'Decision', columns: { title: 'Decision', id: 'No.' } });
  assert.deepEqual((ops.items as { title: string }[]).map((i) => i.title), ['E1 · Readings every hour', 'E2 · Gauge zero at chart datum', 'E3 · Night readings by lamp'], 'named as a heading is');
  const e2 = b.refs('E2', 'Decision')[0]!;
  // What the lane did on the flash run: the number as the id, to give the item its name.
  const renamed = await b.ok('pk_write_reference', { id: 'E2', name: 'E2 · Gauge zero at chart datum (the office agreed)' });
  assert.deepEqual([renamed.id, b.store.reference.has('E2'), b.refs('E2').length, b.store.reference.get(e2.id)!.name, b.store.reference.get(e2.id)!.ids], [e2.id, false, 1, 'E2 · Gauge zero at chart datum (the office agreed)', ['E2']], 'the item that carries E2 is updated; the number is no record id');
  assert.equal((await b.ok('pk_write_reference', { id: 'e2', text: 'Zero is chart datum.' })).id, e2.id, 'in any case');
  // A number no item carries yet is kept as the new item's number, never as its id.
  const fresh = await b.ok('pk_write_reference', { id: 'U5', category: 'Decision', name: 'The alarm rings at spring tides only', text: 'A reading.', basis: 'Explicit', validity: 'Proposed', identity: 'Proposal', sourceIds: [b.src('README.md', 'Readings waiting for the owner')] });
  assert.notEqual(fresh.id, 'U5');
  assert.deepEqual([b.store.reference.has('U5'), b.store.reference.get(fresh.id as string)!.ids], [false, ['U5']]);
  // An id the program made (a row without a number) is still an id, and one that names nothing is refused as before.
  assert.match((await b.call('pk_write_reference', { id: 'ref_nowhere', name: 'x' })).text, /ref_nowhere is no product reference item of the assets/);
  assert.match((await b.call('pk_write_reference', { id: 'E9', name: 'x' })).text, /No product reference item carries E9/);
  // A work item: the number as id reaches the item that carries it (CJ), a side log's V number included.
  await b.ok('pk_fill_from_table', CONTRACTS);
  const tc2 = b.thread('TC-02').id;
  assert.equal((await b.ok('pk_write_thread', { id: 'TC-02', doing: 'Keeps the log.' })).id, tc2);
  assert.equal(b.store.threads.has('TC-02'), false);
  // Two items of one category carrying one number: counted, and listed with both.
  assert.deepEqual(duplicateNumbers(b.store), []);
  b.store.reference.put({ ...b.refs('E3', 'Decision')[0]!, id: 'E3', name: 'E3 · Night readings by lamp' });
  assert.deepEqual(duplicateNumbers(b.store).map((d) => [d.category, d.number, d.items.map((i) => i.id).sort()]), [['Decision', 'E3', ['E3', b.refs('E3').find((r) => r.id !== 'E3')!.id].sort()]]);
  const state = await b.ok('pk_round_state', {});
  assert.equal((state.open as Record<string, number>).duplicates, 1);
  const list = await b.ok('pk_round_state', { list: 'duplicates' });
  assert.deepEqual([list.count, (list.items as { number: string; category: string; items: unknown[] }[]).map((d) => [d.number, d.category, d.items.length])], [1, [['E3', 'Decision', 2]]]);
  // A Requirement and the work item of one contract share its number by design: not a duplicate.
  await b.ok('pk_fill_from_table', { ...CONTRACTS, category: 'Requirement' });
  assert.deepEqual(duplicateNumbers(b.store).map((d) => d.number), ['E3']);
});

// ───────────────────────── 4 · relations the fill wrote can be corrected ─────────────────────────

test('a “depends on” cell links only the clauses that hold nothing but identifiers; what was written wrongly can be taken out', async () => {
  const b = bench(TIDE, TIDE_LAYERS, 'First usable', 'reconcile');
  const filled = await b.ok('pk_fill_from_table', CONTRACTS);
  const deps = (n: string) => b.thread(n).dependsOn.map((d) => b.store.threads.get(d.threadId)!.ids[0]);
  assert.deepEqual([deps('TC-01'), deps('TC-02'), deps('TC-03'), deps('TC-04')], [[], ['TC-01'], ['TC-01', 'TC-02'], []]);
  const unlinked = filled.unlinked as { line: number; column: string; value: string; why: string }[];
  assert.deepEqual(unlinked.map((u) => [u.column, u.value]), [['dependsOn', 'AC 级：TC-04'], ['dependsOn', '经 TC-03 验收']], 'the qualified clauses come back; “无” says there is none');
  assert.match(unlinked[0]!.why, /says more than identifiers[^]*The cell: “TC-01、TC-02；AC 级：TC-04”/);
  assert.equal(filled.removed, undefined);
  // As an earlier fill left it: every identifier of the cell linked. The rerun takes back what the cell does not state.
  const line = filled.unlinked ? unlinked[0]!.line : 0;
  await b.ok('pk_write_thread', { id: 'TC-03', dependsOn: [{ threadId: b.thread('TC-04').id, claim: `docs/PLAN.md, line ${line}: Depends on “TC-01、TC-02；AC 级：TC-04”`, basis: 'Explicit' }] });
  // And what a lane judged for itself, with its own claim: it stays.
  await b.ok('pk_write_thread', { id: 'TC-04', dependsOn: [{ threadId: b.thread('TC-02').id, claim: 'The harbour is told what the log holds (the contract’s own text)', basis: 'Inferred' }] });
  assert.deepEqual(deps('TC-03'), ['TC-01', 'TC-02', 'TC-04']);
  const again = await b.ok('pk_fill_from_table', CONTRACTS);
  assert.deepEqual((again.removed as { column: string; value: string }[]).map((r) => [r.column, r.value]), [['dependsOn', 'TC-04']]);
  assert.deepEqual([deps('TC-03'), deps('TC-04')], [['TC-01', 'TC-02'], ['TC-02']]);
  assert.equal((await b.ok('pk_fill_from_table', CONTRACTS)).removed, undefined, 'nothing left to take back');
  // By hand: the list given whole.
  await b.ok('pk_write_thread', { id: 'TC-03', replaceDependsOn: true, dependsOn: [{ threadId: b.thread('TC-01').id, claim: 'docs/PLAN.md: only the gauge', basis: 'Explicit' }] });
  assert.deepEqual(deps('TC-03'), ['TC-01']);
  await b.ok('pk_write_thread', { id: 'TC-03', dependsOn: [{ threadId: b.thread('TC-02').id, claim: 'and the log', basis: 'Explicit' }] });
  assert.deepEqual(deps('TC-03'), ['TC-01', 'TC-02'], 'without it, dependencies are added');
  await b.ok('pk_write_thread', { id: 'TC-03', replaceDependsOn: true });
  assert.deepEqual(deps('TC-03'), [], 'given whole and empty, it is cleared');
  // A relation between reference items: withdrawn with why, and the withdrawal is in the record.
  await b.ok('pk_fill_from_table', { ...CONTRACTS, into: 'reference', category: 'Requirement' });
  const [r3, r1] = [b.refs('TC-03', 'Requirement')[0]!.id, b.refs('TC-01', 'Requirement')[0]!.id];
  const rel = b.store.relations.find((x) => x.type === 'depends on' && x.from === r3 && x.to === r1)!;
  assert.ok(rel, 'the fill linked the clause of identifiers');
  assert.equal(b.store.relations.filter((x) => x.type === 'depends on' && x.from === r3).length, 2, 'TC-01 and TC-02, not the AC-level TC-04');
  assert.match((await b.call('pk_relate', { type: 'depends on', fromId: r3, toId: r1, withdraw: true })).text, /why: why this relation does not hold/);
  const gone = await b.ok('pk_relate', { type: 'depends on', fromId: r3, toId: r1, withdraw: true, why: 'The alarm reads the log, not the gauge.' });
  assert.deepEqual([gone.withdrawn, b.store.relations.has(rel.id)], [true, false]);
  assert.match(b.store.traceFor('relations', rel.id).at(-1)!.summary, /Relation depends on withdrawn[^]*The alarm reads the log, not the gauge\./);
  assert.match((await b.call('pk_relate', { type: 'depends on', fromId: r3, toId: r1, withdraw: true, why: 'again' })).text, /There is no depends on relation/);
});

// ───────────────────────── 5 · a project with no decision log ─────────────────────────

test('Burrow (no decision log, a batch table, two-letter tickets, no archive): nothing new is demanded, nothing crashes', async () => {
  const b = bench(BURROW, BURROW_LAYERS, 'First usable', 'reconcile');
  const { candidates, block, sole } = b.withLedger((l) => ({ candidates: generationCandidates(b.store, l), block: generationCandidatesBlock(b.store, l), sole: soleDefiners(b.store, l) }));
  assert.deepEqual(candidates, []);
  assert.match(block, /None: no plan, contract or module set is kept under an archive/);
  assert.deepEqual(sole.map((d) => [d.path, d.families]), [['tasks/INDEX.md', ['two letters']]], 'its ticket index — a layer the gate counts already');
  const gaps = entryGapsNow(b.store);
  assert.deepEqual(gaps.files.map((f) => [f.path, f.layer, f.families ?? null, f.defined]), [['tasks/INDEX.md', 'Task index', null, 4]], 'the batch table writes no number; no document is added');
  const filled = await b.ok('pk_fill_from_table', { path: 'tasks/INDEX.md', table: {}, into: 'threads', columns: { title: 'Ticket', id: 'ID', dependsOn: 'Depends on', status: 'Status' } });
  assert.deepEqual([filled.written, (filled.unlinked as { value: string }[]).map((u) => u.value)], [4, ['等 AB 验收']]);
  const deps = (n: string) => b.thread(n).dependsOn.map((d) => b.store.threads.get(d.threadId)!.ids[0]);
  assert.deepEqual([b.thread('AA').title, deps('AB'), deps('AC'), deps('AD')], ['Sign in', ['AA'], ['AA', 'AB'], ['AC']], 'a work item keeps its title; two-letter tickets are linked by clause like any number');
  assert.equal(entryGapsNow(b.store).count, 0);
  assert.deepEqual(duplicateNumbers(b.store), []);
  assert.deepEqual(itemsWithoutDestination(b.store), []);
  const state = await b.ok('pk_round_state', {});
  const open = state.open as Record<string, number>;
  assert.deepEqual([open.entries, open.duplicates, open.generationCandidates, open.withoutDestination], [0, 0, 0, 0]);
  const through = await b.call('pk_stage', { to: 'synthesis', handover: { settled: 'The tickets are on the workbench.', open: 'Nothing the records place is left.', first: 'The ticket index.' } });
  assert.equal(through.error, false, through.text);
});

// ───────────────────────── 6 · carried on under the same number: current work ─────────────────────────

test('an item carried on under the same number stays current work: by its state, whoever listed it — for the process engine, the unplaced counts and the views', async () => {
  const b = bench(TIDE, TIDE_LAYERS, 'Deepen', 'cross-check');
  b.setStage('reconcile', 'First usable');
  await b.ok('pk_fill_from_table', CONTRACTS);
  await b.ok('pk_fill_from_table', { path: 'archive/first/PLAN.md', table: { heading: 'Tasks' }, into: 'threads', columns: { title: 'Task', id: 'ID', status: 'Status' } });
  await b.ok('pk_generation_candidate', { key: 'set:archive/first', verdict: 'accept', name: 'First plan' });
  const id = (n: string) => b.thread(n).id;
  const numbers = (ids: Iterable<string>) => [...ids].map((x) => b.store.threads.get(x)!.ids[0]!).sort();
  const first = b.store.generations.find((g) => g.name === 'First plan')!;
  assert.deepEqual(numbers(first.workIds), ['TC-01', 'TC-02', 'TW-01', 'TW-02', 'TW-03']);
  assert.deepEqual(numbers(carriedOn(b.store)), ['TC-01', 'TC-02'], 'the rows the current plan lists too');
  assert.deepEqual(numbers(earlierWork(b.store)), ['TW-01', 'TW-02', 'TW-03'], 'earlier work is what the generation lists, less what was carried on');
  // A generation the main agent wrote by hand (as on the CQ run): the rule is the item's state, not who listed it.
  b.store.generations.put({ ...first, id: 'gen_by_hand', name: 'By hand', workIds: [id('TC-03'), id('TW-02')] });
  assert.deepEqual(numbers(carriedOn(b.store)), ['TC-01', 'TC-02', 'TC-03']);
  assert.equal(earlierGenerationOf(b.store, id('TC-03')), undefined);
  assert.equal(earlierGenerationOf(b.store, id('TW-02'))?.name, 'First plan');
  // Replaced, it is no longer carried on: it is the generation's again.
  await b.ok('pk_write_thread', { id: 'TC-02', validity: 'Replaced', replacedBy: 'TC-03' });
  assert.deepEqual(numbers(carriedOn(b.store)), ['TC-01', 'TC-03']);
  assert.ok(earlierWork(b.store).has(id('TC-02')));
  // The unplaced counts: a carried-on contract is in no plan until its current plan is written; the earlier tasks are in theirs.
  const open = b.withLedger((l) => roundOpen(b.store, b.store.clerkRounds.get('round_1')!, { ledger: l, limit: Infinity, suggest: false }));
  assert.deepEqual(open.workItems.noPlan.items.map((i) => b.store.threads.get(i.id)!.ids[0]).sort(), ['TC-01', 'TC-03', 'TC-04'], 'TC-01 and TC-03 are listed in a generation and still counted as current work in no plan');
  assert.deepEqual([...new Set(open.generations.withoutDestination.items.map((i) => b.store.threads.get(i.id)!.ids[0]))].sort(), ['TW-01', 'TW-02', 'TW-03'], 'TC-02 was replaced by TC-03; the carried-on ones went on under their number');
  // The process engine: it looks at the carried-on contracts as live work, and not at the earlier tasks.
  const looked = b.withLedger((l) => new Set((computeFindings(analyze(b.store, TIDE.project, l)) as unknown as { lit?: { targetId: string }; targetId?: string }[]).map((f) => f.lit?.targetId ?? f.targetId!)));
  assert.ok(looked.has(id('TC-01')) && looked.has(id('TC-03')), 'findings are computed for work carried on');
  assert.ok(!looked.has(id('TW-01')) && !looked.has(id('TC-02')), 'none for earlier work, or for what was replaced');
  // The views: current work belongs to no earlier generation; the generation still lists it, marked as carried on.
  const view = processView(b.store, TIDE.project);
  assert.deepEqual([view.works[id('TC-01')]!.generationId, view.works[id('TW-01')]!.generationId], [null, first.id]);
  assert.deepEqual(numbers(view.generations.find((g) => g.id === first.id)!.carriedIds), ['TC-01']);
  const graph = graphView(b.store, TIDE.project);
  assert.deepEqual(graph.generations.map((g) => [g.name, numbers(g.carriedIds)]), [['First plan', ['TC-01']], ['By hand', ['TC-03']]]);
  // A work item written as serving its whole plan needs a plan: a carried-on item's generation is not one.
  assert.match((await b.call('pk_write_thread', { id: 'TC-01', wholePlanWhy: 'It reads the whole harbour.' })).text, /this work item is in no plan/);
  assert.equal((await b.call('pk_write_thread', { id: 'TW-01', wholePlanWhy: 'It carried every pile.' })).error, false, 'earlier work has its generation’s plan');
});

test('without a ledger nothing is known to be carried on: every listed item is earlier work, as before', () => {
  const home = mkdtempSync(join(scratch, 'bare-'));
  const store = ProjectStore.open('bare', home);
  store.threads.put({ id: 't1', projectId: 'bare', title: 'One', ids: ['TC-01'], validity: 'Current', progress: 'Planned', serves: [], dependsOn: [] } as never);
  store.generations.put({ id: 'g1', projectId: 'bare', name: 'G', started: null, ended: { at: AT, basis: 'First observed', anchor: null }, endedBy: { kind: 'object', id: 't1', label: 'x' }, planRefs: [], workIds: ['t1'], roundId: null, updatedAt: AT } as never);
  assert.deepEqual([...carriedOn(store)], []);
  assert.deepEqual([...earlierWork(store)], ['t1']);
});
