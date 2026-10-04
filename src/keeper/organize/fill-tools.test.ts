/**
 * The workbench as a fill-in-the-blank (D99; Spec §3.3 "工作台是一道填空题"; CKC-23 AC-21): the model names a table or a
 * level of headings and what each column is, and the program copies the rows and headings into slots — named verbatim,
 * Explicit, cited to the file's section source that holds the line, written through the model's own writers.
 *
 * The fixture is an invented project, "Lighthouse": a plan with two increments and a 27-row work table, a PRD with a goals
 * table and three modules, a decision record with level-3 entries and an architecture log with level-4 ones, and a note
 * with no table. Every refusal is paired with the call that goes through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../../store/project-store.ts';
import type { Project, ReferenceItem, ScopeItem } from '../../model/types.ts';
import type { ClerkRound, ClerkStage, RoundStepKind, SlotKind } from '../../model/k-types.ts';
import { readFileSources } from '../../sources/files.ts';
import { clerkTools, type ClerkToolContext } from '../clerk-tools.ts';
import { keeperTools } from '../tools.ts';
import { markdownTables, tables } from '../../ledger/arrangements.ts';
import { readinessWord } from './readiness.ts';

const AT = '2026-09-29T00:00:00.000Z';
const ROOT = join(mkdtempSync(join(tmpdir(), 'pk-fill-')), 'lighthouse');

// ───────────────────────── the documents ─────────────────────────

const MODULES = ['LH-M1', 'LH-M2', 'LH-M3'];
/** The 27 rows of the plan's work table, as the test expects them read back. */
const ROWS = Array.from({ length: 27 }, (_, k) => {
  const n = k + 1;
  const id = `LH-${String(n).padStart(2, '0')}`;
  const title = n === 1 ? 'Lamp switch from the app' : n === 2 ? 'Schedules: sunset, sunrise and fog' : `Work unit ${n} of the beacon`;
  const modules = n === 2 ? ['LH-M1', 'LH-M2'] : [MODULES[k % 3]!];
  const status = n <= 5 ? 'done' : 'ready';
  const increment = n <= 14 ? 'A' : 'B';
  const deps = n === 1 ? [] : n === 10 ? ['LH-02', 'LH-03', 'LH-04'] : [`LH-${String(n - 1).padStart(2, '0')}`];
  return { n, id, title, modules, status, increment, deps };
});
const cellOf = (r: (typeof ROWS)[number]) => [
  r.n === 1 ? `[${r.id}](contracts/${r.id}.md)` : r.id,
  r.n === 1 ? 'Lamp **switch** from the app' : r.title,
  r.modules.join('、'),
  r.status,
  r.increment,
  r.n === 1 ? '—' : r.n === 10 ? 'LH-02～LH-04' : r.n === 11 ? `${r.deps[0]}；AC 级：${r.deps[0]}` : r.deps.join(', '),
];
const PLAN = [
  '# Lighthouse plan', '',
  '## 1 · Increments', '',
  '### A · First light', '', 'The lamp turns on and off from the app.', '',
  '### B · Beacon network', '', 'Several lighthouses share one schedule.', '',
  '## 2 · Work', '',
  '| ID | Title | Module | Status | Increment | Dependencies |',
  '| --- | --- | --- | --- | --- | --- |',
  ...ROWS.map((r) => `| ${cellOf(r).join(' | ')} |`),
  '',
  '## 3 · Order', '',
  '| Step | What |', '| --- | --- |', '| 1 | A first |', '| 2 | then B |', '',
].join('\n');
/** The line (1-based) of row n of the work table. */
const rowLine = (n: number) => PLAN.split('\n').indexOf('| ID | Title | Module | Status | Increment | Dependencies |') + 2 + n;

const PRD = [
  '# Lighthouse PRD', '',
  '## Goals', '',
  '| Goal | Serves |', '| --- | --- |',
  '| G1 Ships see the light from 20 km | Lighthouse |',
  '| G2 Keepers sleep through the night | Lighthouse |',
  '| G3 One schedule for every lighthouse | Lighthouse |', '',
  '## Modules', '',
  '### LH-M1 Lamp control', '', 'Turns the lamp on and off.', '',
  '### LH-M2 Schedules', '', 'When the lamp is lit.', '',
  '### LH-M3 Network', '', 'Lighthouses talk to each other.', '',
  '## Out of scope', '', '### Radio beacons', '', 'Not this year.', '',
].join('\n');
const DECISIONS = [
  '# Decisions', '',
  '### D1 · The lamp is LED', '', 'Owner, 2026-09-01.', '',
  '### D2 · Schedules live on each lighthouse', '', 'Superseded by D3.', '',
  '### D3 · Schedules live in one place', '', 'Replaces D2.', '',
].join('\n');
const ADR = [
  '# Architecture log', '',
  '## 2026', '',
  '#### ADR-7 Use MQTT between lighthouses', '', 'Small and cheap.', '',
  '#### ADR-8 Keep a local fallback schedule', '', 'When the network is down.', '',
].join('\n');
const NOTES = '# Notes\n\nNothing in a table here.\n';
const BACKLOG = '# Backlog\n\n| ID | Title | Module |\n| --- | --- | --- |\n| LH-40 | Foghorn | LH-M9 |\n| LH-41 | Lamp polish | LH-M1 |\n|  |  | LH-M1 |\n';

const DOCS: Record<string, string> = { 'docs/PLAN.md': PLAN, 'docs/PRD.md': PRD, 'docs/DECISIONS.md': DECISIONS, 'docs/adr.md': ADR, 'docs/NOTES.md': NOTES, 'docs/BACKLOG.md': BACKLOG };
mkdirSync(join(ROOT, 'docs'), { recursive: true });
for (const [rel, body] of Object.entries(DOCS)) writeFileSync(join(ROOT, rel), body);

const scopeItem: ScopeItem = {
  id: 'scope_main', path: ROOT, category: 'Repository', relation: 'Main project', reason: 'Owner-given location', reasonSourceIds: [],
  sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'none', missing: null, addedBy: 'owner',
};
const project = { id: 'p1', name: 'Lighthouse', language: 'en', locations: [ROOT], scope: [scopeItem], scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false, createdAt: AT, lastOpenedAt: null, lastScopedAt: null } as Project;
const ROUND: ClerkRound = {
  id: 'round_1', projectId: 'p1', kind: 'First usable', number: 1, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_main',
  questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT,
  stage: 'skeleton',
};

// ───────────────────────── the harness ─────────────────────────

interface Harness {
  readonly store: ProjectStore;
  readonly ctx: ClerkToolContext;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean; json: Record<string, unknown> }>;
}

/** The project scanned into its section sources, a Product item, and the main agent of round 1 in the skeleton stage. */
function setup(step: { kind: RoundStepKind; slots?: SlotKind[] } | null = { kind: 'main' }, stage: ClerkStage = 'skeleton'): Harness {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-fill-store-')));
  for (const rel of Object.keys(DOCS)) {
    const path = join(ROOT, rel);
    const st = statSync(path);
    for (const s of readFileSources('p1', { path, scopeItemId: 'scope_main', bytes: st.size, mtimeMs: st.mtimeMs }).sources) store.sources.put(s);
  }
  const attribution = { author: { kind: 'unknown' as const, name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' as const };
  store.reference.put({ id: 'ref_product', projectId: 'p1', category: 'Product', name: 'Lighthouse', ids: [], text: 'Lighthouse', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT } as ReferenceItem);
  store.clerkRounds.put({ ...ROUND, stage });
  const ctx: ClerkToolContext = {
    store, project, jobId: 'job_main', jobKind: 'Organizing', model: null,
    step: step ? { roundId: 'round_1', kind: step.kind, path: step.kind === 'lane' ? 'plan-and-contracts' : null, ...(step.slots ? { lane: { kind: 'slot', slots: step.slots } } : {}) } : null,
  };
  // The model's own writers beside the fill-in tools, as a session has them.
  const tools = [...keeperTools(ctx), ...clerkTools(ctx)];
  return {
    store, ctx,
    async call(name, args) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `no tool ${name}`);
      const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
      let result: { content: { text: string }[]; isError?: boolean };
      try { result = await run('call', args); } catch (e) { return { text: (e as Error).message, error: true, json: {} }; }
      const text = result.content.map((c) => c.text).join('\n');
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a refusal is prose */ }
      return { text, error: result.isError === true, json };
    },
  };
}
async function expectOk(h: Harness, name: string, args: Record<string, unknown>) {
  const r = await h.call(name, args);
  assert.equal(r.error, false, `${name} ${JSON.stringify(args).slice(0, 200)} → ${r.text}`);
  return r.json as { written: number; updated: number; items: { id: string; title: string; line: number; referenceId?: string }[]; skipped: { line: number; why: string }[]; unlinked?: { line: number; column: string; value: string; why: string }[]; note?: string; tables?: unknown[]; warnings?: string[] };
}
async function expectRefused(h: Harness, name: string, args: Record<string, unknown>, reason: RegExp) {
  const r = await h.call(name, args);
  assert.equal(r.error, true, `${name} should be refused: ${JSON.stringify(args).slice(0, 200)} → ${r.text}`);
  assert.match(r.text, reason);
}

const AREAS = { path: 'docs/PRD.md', level: 3, category: 'Area', under: 'Modules' };
const INCREMENTS = { path: 'docs/PLAN.md', level: 3, category: 'Plan', under: 'Increments' };
const WORK = {
  path: 'docs/PLAN.md', table: { heading: 'Work' }, into: 'threads', category: 'Requirement',
  columns: { title: 'Title', id: 'ID', parent: 'Module', plan: 'Increment', dependsOn: 'Dependencies', status: 'Status' },
};

/** The source a line is cited to: the file's section source whose lines hold it. */
function sourceOfLine(h: Harness, rel: string, line: number): string {
  const s = h.store.sources.find((x) => x.anchor.kind === 'file' && x.anchor.path.replace(/\\/g, '/').endsWith(rel) && x.anchor.lineStart <= line && line <= x.anchor.lineEnd);
  assert.ok(s, `a source of ${rel} holds line ${line}`);
  return s.id;
}

// ───────────────────────── the parser, exported ─────────────────────────

test('the ledger’s table parser is exported and reads the same rows it did; the raw tables keep every cell as written', () => {
  const parsed = tables(PLAN);
  assert.equal(parsed.rows.length, 27 + 2, 'the work table and the order table, keyed by their first cells');
  assert.equal(parsed.rows[0]!.id, 'LH-01', 'a link in the first cell is read as its text, as before');
  assert.equal(parsed.rows[0]!.cells.Title, 'Lamp **switch** from the app');
  assert.equal(parsed.rows[0]!.line, rowLine(1));
  const raw = markdownTables(PLAN);
  assert.deepEqual(raw.map((t) => t.rows.length), [27, 2]);
  assert.deepEqual(raw[0]!.header, ['ID', 'Title', 'Module', 'Status', 'Increment', 'Dependencies']);
  assert.equal(raw[0]!.rows[0]!.cells[0], '[LH-01](contracts/LH-01.md)', 'unclipped and untouched');
});

// ───────────────────────── headings ─────────────────────────

test('headings of one level become reference items: modules as Areas, increments as Plans, a decision record’s entries as Decisions (level 3 and 4)', async () => {
  const h = setup();
  const areas = await expectOk(h, 'pk_fill_from_headings', AREAS);
  assert.equal(areas.written, 3);
  assert.deepEqual(areas.items.map((i) => i.title), ['LH-M1 Lamp control', 'LH-M2 Schedules', 'LH-M3 Network'], 'verbatim, and only those under Modules');
  const lamp = h.store.reference.get(areas.items[0]!.id)!;
  assert.equal(lamp.category, 'Area');
  assert.deepEqual(lamp.ids, ['LH-M1'], 'its project id read from the start of the heading');
  assert.equal(lamp.basis, 'Explicit');
  assert.equal(lamp.text, 'Turns the lamp on and off.', 'its section is its text');
  assert.deepEqual(lamp.sourceIds, [sourceOfLine(h, 'docs/PRD.md', areas.items[0]!.line)], 'cited to the section source of its line');
  assert.equal(PRD.split('\n')[areas.items[0]!.line - 1], '### LH-M1 Lamp control', 'the line is the heading’s');

  const plans = await expectOk(h, 'pk_fill_from_headings', INCREMENTS);
  assert.deepEqual(plans.items.map((i) => i.title), ['A · First light', 'B · Beacon network']);

  const decisions = await expectOk(h, 'pk_fill_from_headings', { path: 'docs/DECISIONS.md', level: 3, category: 'Decision' });
  assert.deepEqual(decisions.items.map((i) => i.title), ['D1 · The lamp is LED', 'D2 · Schedules live on each lighthouse', 'D3 · Schedules live in one place']);
  const d2 = h.store.reference.get(decisions.items[1]!.id)!;
  assert.deepEqual([d2.category, d2.validity, d2.attribution.identity, d2.ids.join()], ['Decision', 'Current', 'Artifact', 'D2'], 'what replaced what is the model’s to judge');
  const adr = await expectOk(h, 'pk_fill_from_headings', { path: 'docs/adr.md', level: 4, category: 'Decision' });
  assert.deepEqual(adr.items.map((i) => i.title), ['ADR-7 Use MQTT between lighthouses', 'ADR-8 Keep a local fallback schedule']);
  assert.equal(h.store.reference.filter((r) => r.category === 'Decision').length, 5);

  // Again: the same items, updated, none doubled.
  const again = await expectOk(h, 'pk_fill_from_headings', { path: 'docs/DECISIONS.md', level: 3, category: 'Decision' });
  assert.deepEqual([again.written, again.updated], [0, 3]);
  assert.deepEqual(again.items.map((i) => i.id), decisions.items.map((i) => i.id));
  assert.equal(h.store.reference.filter((r) => r.category === 'Decision').length, 5);

  // No such heading: nothing written, no failure.
  const none = await expectOk(h, 'pk_fill_from_headings', { path: 'docs/NOTES.md', level: 3, category: 'Decision' });
  assert.deepEqual([none.written, none.items.length], [0, 0]);
  assert.match(String(none.note), /no level-3 heading/);
  const notUnder = await expectOk(h, 'pk_fill_from_headings', { path: 'docs/PRD.md', level: 3, category: 'Area', under: 'Pricing' });
  assert.equal(notUnder.written, 0);
  await expectRefused(h, 'pk_fill_from_headings', { path: 'docs/PRD.md', level: 9, category: 'Area' }, /level is a heading level from 1 to 6/);
  await expectRefused(h, 'pk_fill_from_headings', { path: 'docs/PRD.md', level: 3, category: "Owner's words" }, /owner’s own quote/);
  await expectRefused(h, 'pk_fill_from_headings', { path: 'docs/GONE.md', level: 3, category: 'Area' }, /is not a file/);
});

// ───────────────────────── a table ─────────────────────────

test('PRD goals from a table: each row a Goal, named verbatim, refining the Product its parent column names', async () => {
  const h = setup();
  const goals = await expectOk(h, 'pk_fill_from_table', { path: 'docs/PRD.md', table: { heading: 'Goals' }, into: 'reference', category: 'Goal', columns: { title: 'Goal', parent: 'Serves' } });
  assert.equal(goals.written, 3);
  assert.deepEqual(goals.items.map((i) => i.title), ['G1 Ships see the light from 20 km', 'G2 Keepers sleep through the night', 'G3 One schedule for every lighthouse']);
  for (const item of goals.items) {
    const goal = h.store.reference.get(item.id)!;
    assert.equal(goal.category, 'Goal');
    assert.deepEqual(goal.refines, ['ref_product'], `${goal.name} refines the Product`);
    assert.deepEqual(goal.sourceIds, [sourceOfLine(h, 'docs/PRD.md', item.line)]);
  }
  assert.equal(goals.warnings, undefined, 'placed: the writer has nothing to say');
});

test('the plan’s 27-row table gives 27 Requirements and 27 work items, as written, cited to their lines — and "ready" is not progress', async () => {
  const h = setup();
  await expectOk(h, 'pk_fill_from_headings', AREAS);
  await expectOk(h, 'pk_fill_from_headings', INCREMENTS);
  const area = (m: string) => h.store.reference.find((r) => r.category === 'Area' && r.ids.includes(m))!.id;
  const plan = (inc: string) => h.store.reference.find((r) => r.category === 'Plan' && r.name.startsWith(`${inc} ·`))!.id;

  const filled = await expectOk(h, 'pk_fill_from_table', WORK);
  assert.deepEqual([filled.written, filled.updated, filled.skipped.length], [27, 0, 0], JSON.stringify(filled.skipped));
  // CZ: a clause that says more than identifiers (row 11's “AC 级：LH-10”) is not linked; it comes back with the cell's text.
  assert.deepEqual((filled.unlinked ?? []).map((u) => [u.line, u.column, u.value]), [[rowLine(11), 'dependsOn', 'AC 级：LH-10']], JSON.stringify(filled.unlinked));
  assert.match(filled.unlinked![0]!.why, /says more than identifiers[^]*The cell: “LH-10；AC 级：LH-10”/);
  assert.equal(h.store.threads.size, 27);
  assert.equal(h.store.reference.filter((r) => r.category === 'Requirement').length, 27);

  for (const [k, r] of ROWS.entries()) {
    const item = filled.items[k]!;
    assert.equal(item.line, rowLine(r.n), `${r.id}: its line`);
    assert.equal(item.title, r.title, `${r.id}: the title as the document writes it`);
    const work = h.store.threads.get(item.id)!;
    const req = h.store.reference.get(item.referenceId!)!;
    const cited = sourceOfLine(h, 'docs/PLAN.md', item.line);
    assert.deepEqual([work.title, work.ids.join()], [r.title, r.id], `${r.id}: work item`);
    // CZ: the reference item of a row is named “number · title”, as a heading's is; the work item keeps the title.
    assert.deepEqual([req.name, req.ids.join(), req.category, req.basis], [`${r.id} · ${r.title}`, r.id, 'Requirement', 'Explicit'], `${r.id}: requirement`);
    assert.deepEqual(req.sourceIds, [cited], `${r.id}: the requirement cites the section source of its row`);
    assert.match(req.text, new RegExp(`Module: ${r.modules.join('、')} · Status: ${r.status} · Increment: ${r.increment}`), `${r.id}: the row is its text`);
    assert.deepEqual(req.refines, r.modules.map(area), `${r.id}: the requirement refines its module`);
    assert.deepEqual(work.serves.map((s) => s.referenceId), [...r.modules.map(area), req.id, plan(r.increment)], `${r.id}: serves its area first, then its requirement and its increment`);
    assert.ok(work.serves.every((s) => s.basis === 'Explicit'));
    assert.deepEqual(work.dependsOn.map((d) => h.store.threads.get(d.threadId)!.ids[0]), r.deps, `${r.id}: its dependencies`);
    assert.equal(work.progress, 'Planned', `${r.id}: the written status (${r.status}) is not its progress`);
    assert.deepEqual(work.writtenStatus, { text: r.status, sourceId: cited, line: item.line }, `${r.id}: the written status is kept as written`);
    assert.equal(req.writtenStatus?.text, r.status);
    assert.equal(req.progress, null);
  }
});

test('progress comes only through statusMap; a rerun updates the same items, keeps the model’s judgements, and doubles nothing', async () => {
  const h = setup();
  await expectOk(h, 'pk_fill_from_headings', AREAS);
  await expectOk(h, 'pk_fill_from_headings', INCREMENTS);
  const first = await expectOk(h, 'pk_fill_from_table', { ...WORK, statusMap: { Done: 'Done' } });
  const progress = () => first.items.map((i) => h.store.threads.get(i.id)!.progress);
  assert.deepEqual(progress(), ROWS.map((r) => (r.status === 'done' ? 'Done' : 'Planned')), 'done → Done; ready, left out of the map, stays unjudged');
  await expectRefused(h, 'pk_fill_from_table', { ...WORK, statusMap: { ready: 'Ready' } }, /progress is one of Planned, In progress, Done, On hold/);

  // The model judges one ready row in progress, and adds a note of its own; the table is filled again.
  const six = first.items[5]!.id;
  const judged = await h.call('pk_write_thread', { id: six, progress: 'In progress', doing: 'Being wired to the beacon.' });
  assert.equal(judged.error, false, judged.text);
  const again = await expectOk(h, 'pk_fill_from_table', WORK);
  assert.deepEqual([again.written, again.updated, again.skipped.length], [0, 27, 0]);
  assert.deepEqual(again.items.map((i) => i.id), first.items.map((i) => i.id), 'the same items');
  assert.deepEqual(again.items.map((i) => i.referenceId), first.items.map((i) => i.referenceId));
  assert.equal(h.store.threads.size, 27);
  assert.equal(h.store.reference.filter((r) => r.category === 'Requirement').length, 27);
  const work = h.store.threads.get(six)!;
  assert.deepEqual([work.progress, work.doing], ['In progress', 'Being wired to the beacon.'], 'the judgement stands');
  assert.equal(h.store.threads.get(first.items[0]!.id)!.progress, 'Done', 'a rerun without the map sets no progress');
  assert.equal(work.serves.length, 3, 'relations are not doubled');
  assert.equal(work.writtenStatus?.text, 'ready', 'and the written status survives the model’s update');
});

// DB (after the DeepSeek run): a brief's 「statusMap：ready→Planned」 was taken as given, and no contract showed Done.
test('a readiness word maps to no progress, whoever asks: the entry is refused with the rule, the rest of the call goes through, and the rows that write it are counted for the lane to judge', async () => {
  const h = setup();
  await expectOk(h, 'pk_fill_from_headings', AREAS);
  await expectOk(h, 'pk_fill_from_headings', INCREMENTS);
  // The call a lane makes from such a brief: readiness words mapped to a progress, beside a word that states progress.
  const r = await h.call('pk_fill_from_table', { ...WORK, statusMap: { ready: 'Planned', Draft: 'Planned', '已批准': 'Done', done: 'Done' } });
  assert.equal(r.error, false, r.text);
  const out = r.json as unknown as { written: number; items: { id: string }[]; refused: { statusMap: string; why: string }[]; progressToJudge: { rows: number; statuses: Record<string, number>; lines: number[]; note: string } };
  assert.equal(Object.keys(r.json)[0], 'refused', 'what was refused is read first');
  assert.deepEqual(out.refused.map((x) => x.statusMap), ['“ready” → Planned', '“Draft” → Planned', '“已批准” → Done'], 'each readiness entry, and only those');
  for (const x of out.refused) assert.match(x.why, /a word for the readiness or approval of the document itself \(ready, draft, approved, accepted, final, 就绪, 草案, 已批准, 定稿\) is not progress: it is kept as the row’s written status and maps to no progress/, 'the rule is named');
  assert.equal(out.written, 27, 'the table is filled all the same');
  const threads = out.items.map((i) => h.store.threads.get(i.id)!);
  assert.deepEqual(threads.map((t) => t.progress), ROWS.map((row) => (row.status === 'done' ? 'Done' : 'Planned')), 'done → Done is taken; a ready row stands at the starting Planned');
  assert.deepEqual(threads.map((t) => t.writtenStatus?.text), ROWS.map((row) => row.status), 'every row keeps the status its document writes');
  // The rows left for the lane: counted, by word, with their lines.
  assert.equal(out.progressToJudge.rows, 22);
  assert.deepEqual(out.progressToJudge.statuses, { ready: 22 });
  assert.deepEqual(out.progressToJudge.lines, ROWS.filter((row) => row.status === 'ready').map((row) => rowLine(row.n)));
  assert.match(out.progressToJudge.note, /Judge each one’s progress from the execution records/);
  assert.match(out.progressToJudge.note, /Where the project has no execution records for a row, it stays Planned/);

  // A lane's own judgement of a ready row stands when the table is filled again, with or without the refused mapping.
  const six = out.items[5]!.id;
  assert.equal((await h.call('pk_write_thread', { id: six, progress: 'Done', progressWhy: 'Its ticket was delivered and checked.' })).error, false);
  const again = await h.call('pk_fill_from_table', { ...WORK, statusMap: { ready: 'Planned' } });
  assert.equal(again.error, false, again.text);
  assert.equal(h.store.threads.get(six)!.progress, 'Done', 'the refused mapping does not put it back to Planned');
  assert.equal((again.json as unknown as { progressToJudge: { rows: number } }).progressToJudge.rows, 22, 'the rows that write readiness are still named');

  // A table that states progress, and no readiness: nothing refused, nothing to judge — the result is as it was before.
  const plain = await h.call('pk_fill_from_table', { ...WORK, statusMap: { done: 'Done' } });
  assert.equal('refused' in plain.json, false);
  // Reference items carry no progress to judge.
  const refs = await h.call('pk_fill_from_table', { path: 'docs/PLAN.md', table: { heading: 'Work' }, into: 'reference', category: 'Requirement', columns: { title: 'Title', id: 'ID', status: 'Status' }, statusMap: { ready: 'Planned' } });
  assert.equal(refs.error, false, refs.text);
  assert.equal((refs.json as unknown as { refused: unknown[] }).refused.length, 1);
  assert.equal('progressToJudge' in refs.json, false);
});

test('which words state readiness: the word a status opens with, in English and Chinese; a word that states progress is none', () => {
  for (const [status, word] of [['ready', 'ready'], ['Ready', 'ready'], ['**ready**', 'ready'], ['ready（评审在 K 之后）', 'ready'], ['ready; the adjustment waits', 'ready'], ['draft', 'draft'], ['Approved by the owner', 'approved'], ['accepted', 'accepted'], ['Final', 'final'], ['就绪', '就绪'], ['已就绪，待排期', '已就绪'], ['草案', '草案'], ['已批准（D12）', '已批准'], ['定稿', '定稿']] as const) {
    assert.equal(readinessWord(status), word, status);
  }
  for (const status of ['done', 'Done', 'in progress', 'not ready', 'deferred（D79）', 'replaced', 'blocked', 'queued', '完成', '进行中', '暂缓', '未就绪', '', '—', 'readying the kiln', 'finalist']) {
    assert.equal(readinessWord(status), null, status);
  }
});

test('what the table cannot give: no table, no such heading, a column it lacks, a parent nothing answers to, an empty title', async () => {
  const h = setup();
  const none = await expectOk(h, 'pk_fill_from_table', { path: 'docs/NOTES.md', into: 'threads', columns: { title: 'Title' } });
  assert.deepEqual([none.written, none.updated, none.items.length], [0, 0, 0]);
  assert.match(String(none.note), /has no table/);
  const noHeading = await expectOk(h, 'pk_fill_from_table', { ...WORK, table: { heading: 'Budget' } });
  assert.equal(noHeading.written, 0);
  assert.equal((noHeading.tables ?? []).length, 2, 'it lists the tables there are, to choose from');
  const which = await expectOk(h, 'pk_fill_from_table', { ...WORK, table: {} });
  assert.match(String(which.note), /2 tables: say which/);
  await expectRefused(h, 'pk_fill_from_table', { ...WORK, columns: { ...WORK.columns, plan: 'Phase' } }, /“Phase” is not a column of the table at line \d+ of docs\/PLAN\.md; its columns are “ID”/);
  await expectRefused(h, 'pk_fill_from_table', { ...WORK, into: 'reference', category: 'Requirement' }, /plan places a work item under its Plan item/);
  await expectRefused(h, 'pk_fill_from_table', { ...WORK, into: 'reference', category: undefined, columns: { title: 'Title' } }, /needs category/);

  await expectOk(h, 'pk_fill_from_headings', AREAS);
  const backlog = await expectOk(h, 'pk_fill_from_table', { path: 'docs/BACKLOG.md', table: { line: 4 }, into: 'threads', columns: { title: 'Title', id: 'ID', parent: 'Module' } });
  assert.equal(backlog.written, 2, 'written, whether or not its parent is found');
  assert.deepEqual(backlog.unlinked?.map((u) => [u.column, u.value]), [['parent', 'LH-M9']]);
  assert.match(backlog.unlinked![0]!.why, /nothing in the assets is named “LH-M9”/);
  assert.deepEqual(backlog.skipped.map((s) => s.line), [7]);
  assert.match(backlog.skipped[0]!.why, /Title column is empty/);
  assert.match(String(backlog.warnings?.[0]), /Not placed/, 'the writer’s own feedback on the unplaced one');
});

test('a row whose source no longer holds it is skipped, not cited to a line its source does not have', async () => {
  const h = setup();
  const planSource = h.store.sources.find((s) => s.anchor.kind === 'file' && s.anchor.path.endsWith('BACKLOG.md'))!;
  h.store.sources.put({ ...planSource, excerpt: planSource.excerpt.replace('| LH-41 | Lamp polish | LH-M1 |', '| LH-41 | Lamp | LH-M1 |') });
  const r = await expectOk(h, 'pk_fill_from_table', { path: 'docs/BACKLOG.md', into: 'threads', columns: { title: 'Title', id: 'ID' } });
  assert.deepEqual(r.items.map((i) => i.title), ['Foghorn']);
  assert.match(r.skipped.find((s) => s.line === 6)!.why, /the file changed since its sources were read/);
});

// ───────────────────────── who fills ─────────────────────────

test('the main agent fills in skeleton and reconcile; a lane fills the slots it was given; no other job fills', async () => {
  const main = setup({ kind: 'main' }, 'orientation');
  await expectRefused(main, 'pk_fill_from_headings', AREAS, /main agent’s in the skeleton or reconcile stage; this round is in orientation/);
  main.store.clerkRounds.put({ ...ROUND, stage: 'reconcile' });
  assert.equal((await expectOk(main, 'pk_fill_from_headings', AREAS)).written, 3);

  await expectRefused(setup(null), 'pk_fill_from_table', WORK, /no step of a round/);
  await expectRefused(setup({ kind: 'skeleton' }), 'pk_fill_from_table', WORK, /the skeleton step of the earlier method, where each step was a job of its own/);

  await expectRefused(setup({ kind: 'lane', slots: ['links'] }), 'pk_fill_from_table', WORK, /this lane writes links/);
  const threadsOnly = setup({ kind: 'lane', slots: ['threads'] });
  await expectRefused(threadsOnly, 'pk_fill_from_table', WORK, /Requirement items are the reference:Requirement slot/);
  await expectRefused(threadsOnly, 'pk_fill_from_headings', AREAS, /this lane writes threads/);
  const filled = await expectOk(threadsOnly, 'pk_fill_from_table', { ...WORK, category: undefined });
  assert.equal(filled.written, 27, 'the work items alone');
  assert.equal(threadsOnly.store.reference.filter((r) => r.category === 'Requirement').length, 0);

  const areasLane = setup({ kind: 'lane', slots: ['reference:Area'] });
  await expectRefused(areasLane, 'pk_fill_from_headings', { ...AREAS, category: 'Goal' }, /Goal items are the reference:Goal slot/);
  assert.equal((await expectOk(areasLane, 'pk_fill_from_headings', AREAS)).written, 3);
  const both = setup({ kind: 'lane', slots: ['threads', 'reference:Requirement'] });
  assert.equal((await expectOk(both, 'pk_fill_from_table', WORK)).written, 27);
});
