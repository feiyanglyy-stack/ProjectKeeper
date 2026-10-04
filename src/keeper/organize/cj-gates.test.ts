/**
 * CJ (E150 「保证重要事项全量通过」): what the first D100 run missed, where the program can count it, no longer rests on the
 * model's promise. A small project with a ledger built from its git history, in the shapes of ContextKeeper's records:
 *   - a decision record kept as bold entries (`**D1 · …**`, with a `**D3 补**` supplement), an execution log with a table
 *     and headings (E1–E4) whose E3 holds bold points of another family (P1–P3), a plan with its contract table and its
 *     own decisions table (CKC-01…03, PA-1…3), a task index of two-capital tickets (AA, AB, AC) with prompts, commits and a
 *     QC report.
 * It checks each gate and fix of the CJ contract:
 *   1. the entry completeness gate (open.entries by file; pk_stage leaving reconcile, entering the cross-check; accounts
 *      by number only);
 *   2. the bold-entry fill, names as written, and the refusal of a number-only name;
 *   3. work item ids: a number given as id kept in ids, two capitals, checked against the ledger, never another object's;
 *   4. links confirmed before a deepening's synthesis, and an unconfirmed link shown as Inferred;
 *   5. QC links: the verdict file, never the prompt, never the work item itself, one per work item and file; `verifies`
 *      relations as QC steps;
 *   6. contract progress: a ticket records its contract; a contract Planned with Done tickets is open until a reason;
 *   7. product-only decisions and boundaries whose entry names a contract are traceable; boundaries counted.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Project, ReferenceItem, ScopeItem, Source, WorkThread } from '../../model/types.ts';
import type { ClerkRound, ClerkStage, LayerEntry, RoundKind } from '../../model/k-types.ts';
import { ProjectStore } from '../../store/project-store.ts';
import { Ledger } from '../../ledger/index.ts';
import { ledgerPath, rebuildLedgerInPlace } from '../../ledger/rebuild.ts';
import { keeperTools, primaryIdentifier } from '../tools.ts';
import { clerkTools, type ClerkToolContext } from '../clerk-tools.ts';
import { stageTools } from './stage-tools.ts';
import { entryGaps, entryGateTools } from './entry-gate.ts';
import { entriesOf, entryTitle, isNumberOnly } from './entries.ts';
import { roundOpen } from './round-open.ts';
import { displayName } from './graph.ts';
import { resolveMergedId } from '../merge.ts';
import { work } from '../../process/index.ts';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-cj-'));
after(() => { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const AT = '2026-09-30T10:00:00.000Z';

// ───────────────────────── the project and its ledger ─────────────────────────

const repo = join(scratch, 'kiln');
mkdirSync(repo);
const git = (args: string[], date = '2026-09-01T12:00:00Z'): string => execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 'Kiln', GIT_AUTHOR_EMAIL: 'k@kiln.invalid', GIT_COMMITTER_NAME: 'Kiln', GIT_COMMITTER_EMAIL: 'k@kiln.invalid' }, windowsHide: true,
}).trim();
const files: Record<string, string> = {};
const write = (rel: string, text: string) => { files[rel] = text; const full = join(repo, rel); mkdirSync(resolve(full, '..'), { recursive: true }); writeFileSync(full, text); };
const commit = (message: string, date: string) => { git(['add', '-A'], date); git(['commit', '-q', '-m', message], date); return git(['rev-parse', 'HEAD']); };

git(['init', '-q', '-b', 'main']);
git(['config', 'core.autocrlf', 'false']);
write('design/DECISIONS.md', [
  '# Decisions', '', '## Early decisions', '',
  '**D1 · Build it on the trial project.** The trial project shows what to build next.', '',
  '**D2 · Split the work into roles.** 改到的文档：CKC-02。', '',
  '**D3 · Keep a ledger of what can be counted.** The ledger counts commits.', '',
  '**D3 补（2026-09-02）**：the ledger counts numbers too.', '',
].join('\n'));
write('subagent/DECISIONS.md', [
  '# Execution decisions', '', '## Early table', '',
  '| # | 日期 | 决定 |', '| --- | --- | --- |', '| E1 | 2026-09-01 | Work in worktrees |', '| E2 | 2026-09-01 | Commit per batch |', '',
  '### E3 · The first batch is merged', '', '**P1 · a point of E3.**', '', '**P2 · another point.**', '', '**P3 · a third point.**', '',
  '### E4 · The second batch is merged', '', 'Merged after its QC.', '',
].join('\n'));
write('docs/PLAN.md', [
  '# Plan', '', '## Contracts', '',
  '| ID | Contract | Status |', '| --- | --- | --- |', '| CKC-01 | The ledger | ready |', '| CKC-02 | The views | ready |', '| CKC-03 | The skills | ready |', '',
  '## Execution decisions', '',
  '| # | Decision |', '| --- | --- |', '| PA-1 | Run on clones |', '| PA-2 | Two keys |', '| PA-3 | Lanes per key |', '',
].join('\n'));
write('subagent/INDEX.md', [
  '# Index', '', '## Tickets', '',
  '| ID | Executor | Prompt |', '| --- | --- | --- |', '| AA | kimi | AA-ledger.md |', '| AB | claude | AB-views.md |', '| AC | sol | AC-qc.md |', '',
].join('\n'));
const prompt = (id: string, title: string, status: string) => `---\nid: "${id}"\nexecutor: "claude"\nstatus: "${status}"\n---\n\n# ${id} · ${title}\n\nDo it.\n`;
write('subagent/AA-ledger.md', prompt('AA', 'The ledger', 'ready'));
write('subagent/AB-views.md', prompt('AB', 'The views', 'ready'));
write('subagent/AC-qc.md', prompt('AC', 'QC of the views', 'ready'));
commit('Plan the kiln', '2026-09-01T12:00:00Z');
write('src/ledger.ts', 'export const ledger = 1;\n');
write('subagent/AA-ledger.md', prompt('AA', 'The ledger', 'done'));
const AA_COMMIT = commit('AA: build the ledger', '2026-09-02T12:00:00Z');
write('src/views.ts', 'export const views = 1;\n');
write('subagent/AB-views.md', prompt('AB', 'The views', 'done'));
const AB_COMMIT = commit('AB: build the views', '2026-09-03T12:00:00Z');
write('src/decided.ts', 'export const decided = 3;\n');
commit('D3 keep the ledger in code', '2026-09-04T12:00:00Z');
write('subagent/reports/AC-report.md', '# AC report\n\n结论：pass\n\nThe views hold.\n');
write('subagent/AC-qc.md', prompt('AC', 'QC of the views', 'done'));
commit('AC: QC report', '2026-09-05T12:00:00Z');

const scope = { id: 'scope_kiln', path: repo, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null,
  readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as unknown as ScopeItem;
const project = { id: 'kiln', name: 'Kiln', locations: [repo], scope: [scope], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en',
  organizingPaused: false, createdAt: AT, lastOpenedAt: null, lastScopedAt: null, takeoverDepth: 'Full' } as unknown as Project;
const baseHome = mkdtempSync(join(scratch, 'home-'));
rebuildLedgerInPlace(ledgerPath(project.id, baseHome), project);

const LAYERS: [string, LayerEntry['layer']][] = [['design/DECISIONS.md', 'Decision record'], ['subagent/DECISIONS.md', 'Decision record'], ['docs/PLAN.md', 'Plan'], ['subagent/INDEX.md', 'Task index']];

function round(kind: RoundKind, stage: ClerkStage): ClerkRound {
  return {
    id: 'round_1', projectId: project.id, kind, number: 1, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root',
    questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT,
    stage, stageLog: [{ stage, startedAt: AT, endedAt: null, timing: null }], lanes: [],
  } as ClerkRound;
}

type Called = { text: string; error: boolean; json: Record<string, unknown> };

/** A fresh workbench on the project: the ledger copied in, the layer map, a source per document, a round's main agent. */
function bench(kind: RoundKind = 'First usable', stage: ClerkStage = 'reconcile') {
  const home = mkdtempSync(join(scratch, 'bench-'));
  const store = ProjectStore.open(project.id, home);
  copyFileSync(ledgerPath(project.id, baseHome), join(store.dir, 'ledger.sqlite'));
  for (const [path, layer] of LAYERS) store.layers.put({ id: `layer_${path}`, projectId: project.id, repo, path, layer, note: null, current: true, roundId: null, updatedAt: AT });
  for (const [rel, text] of Object.entries(files)) {
    store.sources.put({
      id: `src_${rel.replace(/\W/g, '_')}`, projectId: project.id, title: rel, anchor: { kind: 'file', path: join(repo, ...rel.split('/')), headingPath: [], lineStart: 1, lineEnd: text.split('\n').length },
      ids: [], version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt: text, usedAs: 'Design', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: scope.id, hasCredential: false, bytes: text.length,
    } as unknown as Source);
  }
  store.clerkRounds.put(round(kind, stage));
  const ctx = { store, project, jobId: 'job_main', jobKind: 'Organizing', model: null, step: { roundId: 'round_1', kind: 'main', path: null }, stageEntered: () => ({ note: null }) } as unknown as ClerkToolContext;
  const tools: ToolDefinition[] = [...keeperTools(ctx), ...clerkTools(ctx), ...stageTools(ctx, { coverageSettled: () => true, stageSkill: (s) => `SKILL ${s}` }), ...entryGateTools(ctx)];
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
  const ledger = () => Ledger.openDir(store.dir)!;
  return { store, call, ok, setStage, ledger };
}

const byNumber = (store: ProjectStore, num: string) => store.threads.find((t) => t.ids.includes(num));
const refByNumber = (store: ProjectStore, num: string) => store.reference.find((r) => r.ids.includes(num));
const product = (store: ProjectStore) => store.reference.put({
  id: 'ref_product', projectId: project.id, category: 'Product', name: 'Kiln', ids: [], text: 'Kiln', quote: null, basis: 'Explicit', validity: 'Current', progress: null,
  attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, sourceIds: [], refines: [], replacedBy: null, updatedAt: AT,
} as unknown as ReferenceItem);

// ───────────────────────── entries, as the program reads them ─────────────────────────

/** The main agent's handover to the synthesis (D103): required once the gates pass. */
const HANDOVER = { settled: 'What the lanes brought back is joined and placed.', open: 'What no record places stays unplaced.', first: 'The lane reports.' };

test('entries: a bold entry is named by its number and title as written, its supplement folded in; bold points of a numbered heading of another family are not entries', () => {
  const design = entriesOf(files['design/DECISIONS.md']!);
  assert.deepEqual(design.map((e) => e.name), ['D1 · Build it on the trial project.', 'D2 · Split the work into roles.', 'D3 · Keep a ledger of what can be counted.']);
  assert.equal(design[2]!.folded.length, 1, 'D3 补 is D3’s supplement');
  const log = entriesOf(files['subagent/DECISIONS.md']!);
  assert.deepEqual(log.map((e) => e.num), ['E1', 'E2', 'E3', 'E4'], 'P1–P3 are points of E3');
  assert.equal(log[0]!.name, 'E1 · Work in worktrees', 'a table row: its first cell with words, a date passed over');
  assert.equal(entryTitle('**P5**（`Settled by rule` 第六个整理层次）。', 'P5', 'bold entry').name, 'P5 · （Settled by rule 第六个整理层次）');
  assert.deepEqual(['D1', '[E50]', 'AP:', 'D1 · x', 'UI polish', 'd1'].map(isNumberOnly), [true, true, true, false, false, false]);
  assert.equal(displayName('D1', '**D1 · Build it on the trial project.** The trial project shows what.'), 'D1 · Build it on the trial project.', 'a name that is the number alone shows its first sentence');
  assert.equal(displayName('D1 · Build it', 'anything'), 'D1 · Build it');
  assert.equal(primaryIdentifier(['AS'], ''), 'AS', 'two capitals as an id');
  assert.equal(primaryIdentifier([], 'UI polish'), null, 'but never from a name');
});

// ───────────────────────── 1 · the entry completeness gate ─────────────────────────

test('the entry gate: every number the counted files define is carried or accounted for by number before a First usable round leaves reconcile', async () => {
  const b = bench('First usable', 'reconcile');
  const gaps = () => { const l = b.ledger(); try { return entryGaps(b.store, l); } finally { l.close(); } };
  const missing = () => Object.fromEntries(gaps().files.map((f) => [f.path, f.missing.map((m) => m.num)]));
  assert.deepEqual(missing(), {
    'design/DECISIONS.md': ['D1', 'D2', 'D3'], 'docs/PLAN.md': ['CKC-01', 'CKC-02', 'CKC-03', 'PA-1', 'PA-2', 'PA-3'],
    'subagent/DECISIONS.md': ['E1', 'E2', 'E3', 'E4'], 'subagent/INDEX.md': ['AA', 'AB', 'AC'],
  }, 'P1–P3, points of E3, are not counted; D3 补 is D3');
  const refused = await b.call('pk_stage', { to: 'synthesis' });
  assert.equal(refused.error, true);
  assert.match(refused.text, /16 numbers are neither/);
  assert.match(refused.text, /subagent\/DECISIONS\.md \(Decision record\): 4 of 4 — E1, E2, E3, E4/);
  assert.equal(b.store.clerkRounds.get('round_1')!.stage, 'reconcile', 'nothing changed');
  const state = await b.call('pk_round_state', {});
  assert.equal((state.json.open as { entries: number }).entries, 16, 'pk_round_state counts them');
  const listed = await b.call('pk_round_state', { list: 'entries' });
  assert.deepEqual((listed.json.items as { path: string; missing: string[] }[]).find((f) => f.path === 'subagent/INDEX.md')!.missing, ['AA', 'AB', 'AC'], 'and lists them by file when asked');

  // Each log whole, in one call per kind of entry.
  const bold = await b.ok('pk_fill_from_bold', { path: 'design/DECISIONS.md', category: 'Decision' });
  assert.equal(bold.written, 3);
  assert.deepEqual(bold.folded, [{ line: 11, into: 'D3' }]);
  assert.equal(refByNumber(b.store, 'D1')!.name, 'D1 · Build it on the trial project.');
  assert.match(refByNumber(b.store, 'D3')!.text, /the ledger counts numbers too/, 'the supplement folded into D3’s text');
  assert.equal((await b.ok('pk_fill_from_headings', { path: 'subagent/DECISIONS.md', level: 3, category: 'Decision' })).written, 2);
  assert.equal((await b.ok('pk_fill_from_table', { path: 'subagent/DECISIONS.md', table: { heading: 'Early table' }, into: 'reference', category: 'Decision', columns: { title: '决定', id: '#' } })).written, 2);
  assert.equal((await b.ok('pk_fill_from_table', { path: 'docs/PLAN.md', table: { heading: 'Contracts' }, into: 'threads', category: 'Requirement', columns: { title: 'Contract', id: 'ID', status: 'Status' } })).written, 3);
  const index = await b.ok('pk_fill_from_table', { path: 'subagent/INDEX.md', into: 'threads', columns: { title: 'Prompt', id: 'ID' } });
  assert.equal(index.written, 3);
  assert.deepEqual(['AA', 'AB', 'AC'].map((n) => byNumber(b.store, n)?.ids), [['AA'], ['AB'], ['AC']], 'the index’s ID column is kept: two capitals are ids');
  assert.deepEqual(missing()['docs/PLAN.md'], ['PA-1', 'PA-2', 'PA-3']);

  // An account names each number; a bulk account is refused.
  const bulk = await b.call('pk_account_entries', { path: 'docs/PLAN.md', numbers: ['PA-1～PA-3'], why: 'process records' });
  assert.equal(bulk.error, true);
  assert.match(bulk.text, /an account in bulk is not one/);
  const none = await b.call('pk_account_entries', { path: 'docs/PLAN.md', numbers: ['PA-1'], why: '' });
  assert.equal(none.error, true, 'why is required');
  const account = await b.ok('pk_account_entries', { path: 'docs/PLAN.md', numbers: ['PA-1', 'PA-2', 'PA-3', 'PA-9'], why: 'The execution decisions of the plan are recorded in the execution log; they are not items of their own here.' });
  assert.deepEqual([account.accounted, account.left, account.notEntries], [3, 0, ['PA-9']]);
  assert.deepEqual(b.store.clerkRounds.get('round_1')!.entryAccounts!.map((a) => a.numbers), [['PA-1', 'PA-2', 'PA-3']]);
  const moved = await b.call('pk_stage', { to: 'synthesis', handover: HANDOVER });
  assert.equal(moved.error, false, moved.text);
});

test('the entry gate holds a deepening at the door of the cross-check, and names no gate where there is no ledger', async () => {
  const b = bench('Deepen', 'coverage');
  const refused = await b.call('pk_stage', { to: 'cross-check' });
  assert.equal(refused.error, true);
  assert.match(refused.text, /before you enter the cross-check/);
  // Without a ledger there is nothing to count.
  rmSync(join(b.store.dir, 'ledger.sqlite'));
  const open = await b.call('pk_stage', { to: 'cross-check' });
  assert.equal(open.error, false, open.text);
});

// ───────────────────────── 2, 3 · names and ids ─────────────────────────

test('a name that is the number alone is refused where the document gives a title; a work item keeps its own number in ids, checked against the ledger, never another object’s', async () => {
  const b = bench('First usable', 'reconcile');
  const src = 'src_design_DECISIONS_md';
  const numberOnly = await b.call('pk_write_reference', { category: 'Decision', name: 'D2', ids: ['D2'], text: 'Split the work.', basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [src] });
  assert.equal(numberOnly.error, true);
  assert.match(numberOnly.text, /“D2” is its number alone[\s\S]*“D2 · Split the work into roles\.”/);
  await b.ok('pk_write_reference', { category: 'Decision', name: 'D2 · Split the work into roles.', ids: ['D2'], text: 'Split the work.', basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [src] });

  // A number given as id is the work item's number, in its ids; its id is the program's, and the number finds it.
  const created = await b.ok('pk_write_thread', { id: 'AA', title: 'The ledger', progress: 'Done' });
  assert.notEqual(created.id, 'AA');
  assert.deepEqual(b.store.threads.get(created.id as string)!.ids, ['AA']);
  assert.equal(resolveMergedId(b.store, 'AA'), created.id, 'the number names the work item that carries it');
  assert.deepEqual((await b.ok('pk_write_thread', { id: 'AA', results: 'Built.' })).id, created.id, 'an update by the number reaches it');
  // Another object's number, and a label the project never writes, are refused as ids.
  const decision = await b.call('pk_write_thread', { title: 'Split roles work', ids: ['D2'], progress: 'Done' });
  assert.equal(decision.error, true);
  assert.match(decision.text, /D2 is the number of the Decision D2/);
  const label = await b.call('pk_write_thread', { title: 'The views', ids: ['KIMI-P1'], progress: 'Done' });
  assert.equal(label.error, true);
  assert.match(label.text, /KIMI-P1 is not a number the project defines/);
  // A title that opens with another object's number does not give the work item that number.
  const titled = await b.ok('pk_write_thread', { title: 'D3 W1: the ledger in code', progress: 'Done' });
  assert.deepEqual(b.store.threads.get(titled.id as string)!.ids, [], 'D3 is the decision’s number, not the ticket’s');
  // A work item written before CJ with the number as its id gets the number in its ids when next written.
  b.store.threads.put({ ...b.store.threads.get(created.id as string)!, id: 'AB', ids: [], title: 'The views' });
  await b.ok('pk_write_thread', { id: 'AB', progress: 'Done' });
  assert.deepEqual(b.store.threads.get('AB')!.ids, ['AB']);
});

// ───────────────────────── 4, 5 · links and QC ─────────────────────────

test('QC links cite the verdict file, never the prompt and never the work item itself, one per work item and file; a deepening settles every suspect link before its synthesis', async () => {
  const b = bench('Deepen', 'cross-check');
  const views = (await b.ok('pk_write_thread', { id: 'AB', title: 'The views', progress: 'Done' })).id as string;
  const qc = (await b.ok('pk_write_thread', { id: 'AC', title: 'QC of the views', progress: 'Done' })).id as string;
  b.setStage('reconcile', 'Deepen');
  const prompt = await b.call('pk_link_process', { workId: views, ledgerRef: { kind: 'file', id: 'subagent/AC-qc.md' }, stepKind: 'QC', why: 'AC checked AB.' });
  assert.equal(prompt.error, true);
  assert.match(prompt.text, /is the dispatch prompt of AC[\s\S]*subagent\/reports\/AC-report\.md/);
  const self = await b.call('pk_link_process', { workId: qc, ledgerRef: { kind: 'file', id: 'subagent/reports/AC-report.md' }, stepKind: 'QC', why: 'its own report' });
  assert.equal(self.error, true);
  assert.match(self.text, /never the QC of itself/);
  const first = await b.ok('pk_link_process', { workId: views, ledgerRef: { kind: 'file', id: 'subagent/reports/AC-report.md' }, stepKind: 'QC', why: 'AC’s report judges AB.' });
  const again = await b.ok('pk_link_process', { workId: views, ledgerRef: { kind: 'file', id: 'subagent/reports/AC-report.md', line: '结论：pass' }, stepKind: 'QC', why: 'AC’s verdict on AB.' });
  assert.equal(again.id, first.id, 'one link per work item and file');
  const delivered = await b.ok('pk_link_process', { workId: views, ledgerRef: { kind: 'commit', id: AA_COMMIT }, stepKind: 'Delivered', why: 'a test link' });
  assert.equal(b.store.links.size, 2);

  // CM: the program checked both as they were written. AC's report never names AB, and the AA commit is not AB's: suspect.
  assert.match(String(again.check), /^suspect: the cited line names no number of AB/);
  assert.match(String(delivered.check), /^suspect: commit [0-9a-f]{7} “AA: build the ledger” names no number of AB, changed none of its files, and no line of the project.s documents names both/);
  // The view shows a suspect link as Inferred, saying so.
  const l = b.ledger();
  try {
    const steps = work(b.store, project, l, views)!.steps;
    const qcStep = steps.find((s) => s.kind === 'QC');
    assert.ok(qcStep && qcStep.basis === 'Inferred' && qcStep.link === 'suspect' && /^Suspect, not confirmed/.test(qcStep.result), JSON.stringify(steps.map((s) => [s.kind, s.result])));
  } finally { l.close(); }

  b.setStage('cross-check', 'Deepen');
  const held = await b.call('pk_stage', { to: 'synthesis' });
  assert.equal(held.error, true);
  assert.match(held.text, /2 suspect links: /);
  const state = await b.call('pk_round_state', {});
  assert.equal((state.json.open as { links: number }).links, 2);
  const confirmed = await b.ok('pk_confirm', { kind: 'link', id: first.id, ids: [delivered.id], confirmed: true, why: 'Read the report and the commit.' });
  assert.deepEqual([confirmed.ids, confirmed.confirmed], [[first.id, delivered.id], true]);
  // The entry gate is the cross-check's door; here the synthesis waits only on the links.
  const through = await b.call('pk_stage', { to: 'synthesis', handover: HANDOVER });
  assert.equal(through.error, false, through.text);
});

test('a link whose evidence passes the program’s check is lane-checked: it counts like a confirmed one and the synthesis does not wait on it (CM)', async () => {
  const b = bench('Deepen', 'reconcile');
  const views = (await b.ok('pk_write_thread', { id: 'AB', title: 'The views', progress: 'Done' })).id as string;
  // The commit's message names AB: the program checks it as the lane writes it.
  const byMessage = await b.ok('pk_link_process', { workId: views, ledgerRef: { kind: 'commit', id: AB_COMMIT }, stepKind: 'Delivered', why: 'AB’s delivery' });
  assert.match(String(byMessage.check), /^lane-checked: the commit's message names AB/);
  assert.equal(byMessage.confirmed, false, 'lane-checked is not confirmed: the distinction stays');
  // A line of a report that names the work item.
  const contract = (await b.ok('pk_write_thread', { id: 'CKC-02', title: 'CKC-02 The views contract', progress: 'Planned' })).id as string;
  const byLine = await b.ok('pk_link_process', { workId: contract, ledgerRef: { kind: 'file', id: 'docs/PLAN.md', line: '| CKC-02 | The views | ready |' }, stepKind: 'Planned', why: 'the plan lists it' });
  assert.match(String(byLine.check), /^lane-checked: the cited line names CKC-02/);
  const l = b.ledger();
  try {
    const step = work(b.store, project, l, views)!.steps.find((x) => x.link === 'lane-checked');
    assert.ok(step && /^Lane-checked · /.test(step.result), 'the view says Lane-checked');
  } finally { l.close(); }
  b.setStage('cross-check', 'Deepen');
  const state = await b.call('pk_round_state', {});
  assert.equal((state.json.open as { links: number }).links, 0, 'nothing for the cross-check to settle');
  const moved = await b.call('pk_stage', { to: 'synthesis', handover: HANDOVER });
  assert.equal(moved.error, false, moved.text);
});

test('with why, a deepening enters its synthesis with links left unconfirmed', async () => {
  const b = bench('Deepen', 'reconcile');
  const views = (await b.ok('pk_write_thread', { id: 'AB', title: 'The views', progress: 'Done' })).id as string;
  await b.ok('pk_link_process', { workId: views, ledgerRef: { kind: 'commit', id: AA_COMMIT }, stepKind: 'Delivered', why: 'a test link' });
  b.setStage('cross-check', 'Deepen');
  const moved = await b.call('pk_stage', { to: 'synthesis', why: 'The commit could not be read this round; the next Follow up checks it.', handover: HANDOVER });
  assert.equal(moved.error, false, moved.text);
});

test('the process ties work by its own numbers: an id written before CJ still ties, a decision’s number never does; a verifies relation is a QC step', async () => {
  const b = bench('First usable', 'reconcile');
  const thread = (id: string, ids: string[], title: string): WorkThread => ({
    id, projectId: project.id, title, ids, doing: '', changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [],
    progress: 'Done', validity: 'Current', replacedBy: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' },
    inputs: null, asOf: AT, updatedAt: AT, pendingSourceIds: [],
  } as unknown as WorkThread);
  b.store.threads.put(thread('AA', [], 'The ledger'));
  b.store.threads.put(thread('thread_d3', ['D3'], 'D3 W1: the ledger in code'));
  b.store.threads.put(thread('thread_views', ['AB'], 'The views'));
  await b.ok('pk_fill_from_bold', { path: 'design/DECISIONS.md', category: 'Decision' });
  b.store.relations.put({ id: 'rel_v', projectId: project.id, type: 'verifies', from: 'src_subagent_reports_AC_report_md', to: 'thread_views', claim: 'AC’s report judges the views', basis: 'Explicit', evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: AT });
  const l = b.ledger();
  try {
    const legacy = work(b.store, project, l, 'AA')!.steps;
    assert.ok(legacy.some((s) => (s.kind === 'Delivered' || s.kind === 'Merged') && s.unit === 'AA'), `AA’s commit is its delivery: ${JSON.stringify(legacy.map((s) => [s.kind, s.unit]))}`);
    const d3 = work(b.store, project, l, 'thread_d3')!.steps;
    assert.ok(!d3.some((s) => s.unit === 'D3'), `the decision’s commit is not the ticket’s delivery: ${JSON.stringify(d3.map((s) => [s.kind, s.unit]))}`);
    const views = work(b.store, project, l, 'thread_views')!.steps;
    assert.equal(views.filter((s) => s.kind === 'QC').length, 1, `the verifies relation is its QC step: ${JSON.stringify(views.map((s) => [s.kind, s.result]))}`);
  } finally { l.close(); }
});

// ───────────────────────── 6, 7 · contracts, product-only decisions ─────────────────────────

test('open: a contract Planned with Done tickets until a reason is given; tickets that record no contract; traceable Product-only decisions and boundaries; number-only names; tickets with no ids or another object’s', async () => {
  const b = bench('First usable', 'reconcile');
  product(b.store);
  await b.ok('pk_fill_from_table', { path: 'docs/PLAN.md', table: { heading: 'Contracts' }, into: 'threads', category: 'Requirement', columns: { title: 'Contract', id: 'ID', status: 'Status' } });
  const ticket = (await b.ok('pk_write_thread', { id: 'AA', title: 'The ledger', progress: 'Done', implements: ['CKC-01'] })).id as string;
  assert.ok(b.store.relations.find((r) => r.type === 'implements' && r.from === ticket && r.to === byNumber(b.store, 'CKC-01')!.id), 'the ticket records its contract as a relation');
  const self = await b.call('pk_write_thread', { id: 'CKC-02', implements: ['CKC-02'] });
  assert.equal(self.error, true, 'a contract does not implement itself');
  await b.ok('pk_write_thread', { id: 'AB', title: 'The views', progress: 'Done' });
  // D2's entry names CKC-02, and it is placed on the Product alone; a boundary on the Product is counted like a decision.
  await b.ok('pk_fill_from_bold', { path: 'design/DECISIONS.md', category: 'Decision' });
  await b.ok('pk_write_reference', { id: refByNumber(b.store, 'D2')!.id, refines: ['ref_product'] });
  b.store.reference.put({ ...refByNumber(b.store, 'D1')!, id: 'ref_boundary', category: 'Boundary', ids: [], name: 'Not a scheduler', text: 'Never assigns work (R-09).', refines: ['ref_product'] });
  // A number-only name written before the writers refused it; a ticket that took a decision's number.
  b.store.reference.put({ ...refByNumber(b.store, 'D3')!, id: 'ref_numonly', ids: ['E4'], name: 'E4', category: 'Decision', sourceIds: ['src_subagent_DECISIONS_md'] });
  b.store.threads.put({ ...b.store.threads.get(ticket)!, id: 'thread_other', ids: ['D1'], title: 'D1 follow-up' });
  const l = b.ledger();
  let open;
  try { open = roundOpen(b.store, b.store.clerkRounds.get('round_1')!, { ledger: l }); } finally { l.close(); }
  assert.deepEqual(open.contracts.stuckPlanned.items.map((c) => [c.name, c.done]), [['CKC-01 The ledger', ['AA The ledger']]]);
  assert.deepEqual(open.tickets.noContract.items.map((t) => t.name), ['AB The views'], 'AA records its contract; AB does not; AC is not written');
  assert.deepEqual(open.tickets.otherNumbers.items.map((t) => t.ids), [['D1']]);
  assert.deepEqual(open.decisions.traceable.items.map((d) => [d.id, d.names]), [['ref_boundary', ['R-09']], [refByNumber(b.store, 'D2')!.id, ['CKC-02']]].sort());
  assert.ok(open.decisions.productOnly.items.some((d) => d.id === 'ref_boundary'), 'boundaries are counted like decisions');
  assert.deepEqual(open.names.numberOnly.items.map((n) => [n.id, n.suggested]), [['ref_numonly', 'E4 · The second batch is merged']]);
  // A reason stated for the progress settles the contract.
  await b.ok('pk_write_thread', { id: 'CKC-01', progressWhy: 'The owner has not reviewed the ledger yet; its QC is due in the next milestone.' });
  const l2 = b.ledger();
  try { assert.equal(roundOpen(b.store, b.store.clerkRounds.get('round_1')!, { ledger: l2 }).contracts.stuckPlanned.count, 0); } finally { l2.close(); }
});
