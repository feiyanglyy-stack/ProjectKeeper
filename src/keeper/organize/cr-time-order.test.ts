/**
 * CR (D104 follow-up to CQ) — time order in the program's placement inference: a citation cannot precede what it cites,
 * and a work item or an execution decision does not go to a plan first written after it.
 *
 * One invented project, **Mill**, written in two commits: on 2026-09-01 the plan P1, a product decision log, a ticket
 * index and an execution log; on 2026-09-20 the plan K, a ticket CN (its index row says `plan K`) and the log entry that
 * dispatches it. The log entry of 09-01 writes "智谱 CN" — a key name, before ticket CN existed — and another follows D1,
 * which the model has placed on K.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { KeeperJob, Project, ScopeItem, Source } from '../../model/types.ts';
import type { ClerkRound, LayerEntry } from '../../model/k-types.ts';
import { ProjectStore } from '../../store/project-store.ts';
import { Ledger } from '../../ledger/index.ts';
import { ledgerPath, rebuildLedgerInPlace } from '../../ledger/rebuild.ts';
import { keeperTools } from '../tools.ts';
import { clerkTools, type ClerkToolContext } from '../clerk-tools.ts';
import { stageTools } from './stage-tools.ts';
import { inferDecision, inferThread, inferenceContext, noPlanWhyRefusal, pick, placeByProgram } from './placement-inference.ts';
import { chronology, laterThan, lineDateNaming } from './placement-time.ts';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-cr-'));
after(() => { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const AT = '2026-10-02T10:00:00.000Z';

const repo = join(scratch, 'mill');
mkdirSync(repo);
const files: Record<string, string> = {};
const put = (rel: string, text: string) => { files[rel] = text; const full = join(repo, rel); mkdirSync(resolve(full, '..'), { recursive: true }); writeFileSync(full, text); };
const git = (args: string[], date = '2026-09-01T12:00:00Z') => execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 'Mill', GIT_AUTHOR_EMAIL: 'mill@example.invalid', GIT_COMMITTER_NAME: 'Mill', GIT_COMMITTER_EMAIL: 'mill@example.invalid' }, windowsHide: true,
}).trim();
git(['init', '-q', '-b', 'main']);
git(['config', 'core.autocrlf', 'false']);

const plan1 = ['# Mill plan', '', '## 3 · Increments', '', '### P1 · First flour', '', 'Grind one sack.', ''];
const contracts = ['## 7 · Contracts', '', '| ID | Contract | Increment | Module | Status |', '| --- | --- | --- | --- | --- |', '| MLC-01 | The grind | P1 | ML-M1 | ready |', ''];
const log1 = [
  '# Execution log', '',
  '### E1 · MLC-01 dispatched (2026-09-01)', '', 'AA goes to kimi for MLC-01.', '',
  '### E2 · The second lane (2026-09-01)', '', 'The second lane uses 智谱 CN `zai-coding-cn`.', '',
  '### E3 · The stones (2026-09-01)', '', 'Oiling the stones follows D1.', '',
];
put('docs/PRD.md', ['# Mill PRD', '', '## Modules', '', '| Module | Effect |', '| --- | --- |', '| ML-M1 · Grind | grain becomes flour |', ''].join('\n'));
put('docs/PLAN.md', [...plan1, ...contracts].join('\n'));
put('docs/DECISIONS.md', ['# Decisions', '', '**D1 · The millstone stays where it is.** 影响：MLC-01。', '', '**D3 · Oil before grinding.** As D1 keeps the stone, it is oiled in place.', ''].join('\n'));
put('subagent/INDEX.md', ['# Index', '', '## Tickets', '', '| ID | Executor | Prompt |', '| --- | --- | --- |', '| AA | kimi | The grind |', '| AB | kimi | Oil the stones, per D1 |', ''].join('\n'));
put('subagent/DECISIONS.md', log1.join('\n'));
git(['add', '-A']);
git(['commit', '-q', '-m', 'Mill: the first plan']);

// Nineteen days later: the plan K, ticket CN under it, and the entry that dispatches CN.
put('docs/PLAN.md', [...plan1, '### K · Keep the mill', '', 'Keep the mill in order while it grinds.', '', ...contracts].join('\n'));
put('subagent/INDEX.md', [files['subagent/INDEX.md']!.trimEnd(), '| CN | claude | Keep the mill (plan K) |', ''].join('\n'));
put('subagent/DECISIONS.md', [...log1, '### E4 · CN dispatched (2026-09-20)', '', 'CN goes to claude.', ''].join('\n'));
git(['add', '-A'], '2026-09-20T12:00:00Z');
git(['commit', '-q', '-m', 'Mill: plan K and ticket CN'], '2026-09-20T12:00:00Z');

const scope = { id: 'scope_mill', path: repo, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as unknown as ScopeItem;
const project = { id: 'mill', name: 'Mill', locations: [repo], scope: [scope], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: AT, lastOpenedAt: null, lastScopedAt: null, takeoverDepth: 'Full' } as unknown as Project;
const baseHome = mkdtempSync(join(scratch, 'home-mill-'));
rebuildLedgerInPlace(ledgerPath(project.id, baseHome), project);

/** A document's sources as the scan cuts them: one per heading's section. */
function sectionSources(rel: string, text: string): Source[] {
  const lines = text.split('\n');
  const heads = lines.flatMap((l, i) => { const m = /^(#{1,6})\s+(.*)$/.exec(l); return m ? [{ line: i + 1, level: m[1]!.length, text: m[2]!.trim() }] : []; });
  const stack: { level: number; text: string }[] = [];
  return heads.map((h, k) => {
    while (stack.length && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push({ level: h.level, text: h.text });
    const end = (heads[k + 1]?.line ?? lines.length + 1) - 1;
    return {
      id: `src_mill_${rel.replace(/\W/g, '_')}_${h.line}`, projectId: 'mill', title: h.text, anchor: { kind: 'file', path: join(repo, ...rel.split('/')), headingPath: stack.map((s) => s.text), lineStart: h.line, lineEnd: end },
      ids: [], version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt: lines.slice(h.line - 1, end).join('\n'), usedAs: 'Design', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: scope.id, hasCredential: false, bytes: 10,
    } as unknown as Source;
  });
}

const LAYERS: [string, LayerEntry['layer']][] = [['docs/PRD.md', 'PRD'], ['docs/PLAN.md', 'Plan'], ['docs/DECISIONS.md', 'Decision record'], ['subagent/INDEX.md', 'Task index'], ['subagent/DECISIONS.md', 'Decision record']];

/** Mill's workbench as the skeleton lanes leave it, with D1 placed on K by the model. */
async function millBench() {
  const home = mkdtempSync(join(scratch, 'bench-mill-'));
  const store = ProjectStore.open(project.id, home);
  copyFileSync(ledgerPath(project.id, baseHome), join(store.dir, 'ledger.sqlite'));
  for (const [path, layer] of LAYERS) store.layers.put({ id: `layer_${path}`, projectId: project.id, repo, path, layer, note: null, current: true, roundId: null, updatedAt: AT });
  for (const [rel, text] of Object.entries(files)) for (const s of sectionSources(rel, text)) store.sources.put(s);
  store.clerkRounds.put({
    id: 'round_1', projectId: project.id, kind: 'First usable', number: 1, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root',
    questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT,
    stage: 'skeleton', stageLog: [{ stage: 'skeleton', startedAt: AT, endedAt: null, timing: null }], lanes: [],
  } as ClerkRound);
  store.jobs.put({ id: 'job_main', projectId: project.id, kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['round_1'], label: 'main' }, status: 'Running', queuedAt: AT, startedAt: AT, endedAt: null, savedResults: [], usage: {}, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: 'job_root', resultText: null, priority: 1, task: null, step: { roundId: 'round_1', kind: 'main', path: null } } as unknown as KeeperJob);
  const ctx = { store, project, jobId: 'job_main', jobKind: 'Organizing', model: null, step: { roundId: 'round_1', kind: 'main', path: null }, stageEntered: () => ({ note: null }) } as unknown as ClerkToolContext;
  const tools: ToolDefinition[] = [...keeperTools(ctx), ...clerkTools(ctx), ...stageTools(ctx, { coverageSettled: () => true, stageSkill: (s) => `SKILL ${s}` })];
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name)!;
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
  const ok = async (name: string, args: Record<string, unknown>) => { const r = await call(name, args); assert.equal(r.error, false, `${name} → ${r.text}`); return r.json; };
  const src = (rel: string, heading: string) => store.sources.find((s) => s.anchor.kind === 'file' && s.anchor.path.replace(/\\/g, '/').endsWith(rel) && s.title === heading)!.id;
  const thread = (n: string) => store.threads.find((t) => t.ids.some((i) => i.toUpperCase() === n))!;
  const decision = (n: string) => store.reference.find((r) => r.category === 'Decision' && r.ids.some((i) => i.toUpperCase() === n))!;
  const ref = (category: string, name: string, extra: Record<string, unknown> = {}) => ok('pk_write_reference', { category, name, text: name, basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [src('docs/PRD.md', 'Modules')], ...extra });
  const product = (await ref('Product', 'Mill')).id as string;
  await ref('Area', 'ML-M1 · Grind', { ids: ['ML-M1'], refines: [product] });
  await ok('pk_fill_from_headings', { path: 'docs/PLAN.md', level: 3, category: 'Plan', under: 'Increments' });
  await ok('pk_fill_from_table', { path: 'docs/PLAN.md', table: { heading: 'Contracts' }, into: 'threads', category: 'Requirement', columns: { title: 'Contract', id: 'ID', parent: 'Module', plan: 'Increment', status: 'Status' } });
  await ok('pk_fill_from_table', { path: 'subagent/INDEX.md', table: { heading: 'Tickets' }, into: 'threads', columns: { title: 'Prompt', id: 'ID' } });
  await ok('pk_fill_from_bold', { path: 'docs/DECISIONS.md', category: 'Decision' });
  await ok('pk_fill_from_headings', { path: 'subagent/DECISIONS.md', level: 3, category: 'Decision' });
  // The model placed D1 on K (as the d103 run's model placed D59 on K).
  await ok('pk_write_reference', { id: decision('D1').id, refines: ['K'] });
  const plan = (n: string) => store.reference.find((r) => r.category === 'Plan' && r.ids.includes(n))!.id;
  const withCtx = <T>(fn: (c: ReturnType<typeof inferenceContext>, l: Ledger) => T): T => { const l = Ledger.openDir(store.dir)!; try { return fn(inferenceContext(store, l), l); } finally { l.close(); } };
  return { store, call, ok, thread, decision, withCtx, ids: { product, p1: plan('P1'), k: plan('K') } };
}

test('the chronology reads first appearances and entry dates off the ledger; a dated note in an entry cites as of its own date', async () => {
  const b = await millBench();
  b.withCtx((ctx, l) => {
    const time = chronology(b.store, l);
    assert.equal(time.first(b.thread('CN').id), '2026-09-20', 'ticket CN was first written with the second commit');
    assert.equal(time.first(b.thread('AA').id), '2026-09-01');
    assert.equal(time.first(b.ids.k), '2026-09-20', 'plan K: the first version of its document whose heading defines it');
    assert.equal(time.first(b.ids.p1), '2026-09-01');
    assert.equal(time.own(b.decision('E2').id), '2026-09-01');
    assert.equal(time.own(b.decision('E4').id), '2026-09-20');
    assert.equal(time.executionEntry(b.decision('E2')), true, 'an entry of the log beside the task index');
    assert.equal(time.executionEntry(b.decision('D1')), false, 'a product decision: its log sits beside the plan');
    assert.equal(ctx.time.first(b.thread('CN').id), '2026-09-20');
  });
  assert.equal(laterThan('2026-09-03', '2026-09-01'), true);
  assert.equal(laterThan('2026-09-02', '2026-09-01'), false, 'one day of slack for time zones');
  assert.equal(lineDateNaming('**D48 · A rule.**\n**部分被 D67 改动（2026-09-21）**：…', 'D67'), '2026-09-21');
  assert.equal(lineDateNaming('**D48 · A rule.** See D67.', 'D67'), null);
});

test('a token naming an item first written after the citing record is not followed; one written before is; unknown dates keep today’s behaviour', async () => {
  const b = await millBench();
  // The program places what the records lead to: CN by its index row, E4 through CN, E1 through MLC-01.
  const l = Ledger.openDir(b.store.dir)!;
  try { placeByProgram(b.store, l, { id: 'round_1' }, 'job_main', 'test'); } finally { l.close(); }
  const refines = (n: string) => b.decision(n).refines.map((id) => b.store.reference.get(id)!.name.split(' · ')[0]);
  assert.deepEqual(b.thread('CN').serves.map((s) => b.store.reference.get(s.referenceId)!.name.split(' · ')[0]), ['K']);
  assert.deepEqual(refines('E4'), ['K'], 'E4 (09-20) names CN, written that day: followed');
  assert.deepEqual(refines('E1'), ['P1', 'ML-M1'], 'E1 names MLC-01, written before it: followed');
  assert.deepEqual(refines('E2'), [], 'E2 (09-01) writes 智谱 CN, nineteen days before ticket CN existed: not followed');
  b.withCtx((ctx) => {
    const e2 = inferDecision(ctx, b.decision('E2'));
    assert.deepEqual(e2.plans, []);
    assert.ok(e2.tried.includes('its entry names CN, first written 2026-09-20, after this entry of 2026-09-01'), e2.tried.join(' | '));
  });
  // Without the ledger nothing is dated: the token counts as it did before.
  const e2Undated = inferDecision(inferenceContext(b.store, null), b.decision('E2'));
  assert.equal(pick(e2Undated.plans)?.name, 'K');
  assert.ok(!e2Undated.tried.some((t) => /first written/.test(t)));
});

test('an execution decision or a work item is not placed on a plan first written after it, while a product decision still may be; the refusal never names a dropped chain', async () => {
  const b = await millBench();
  b.withCtx((ctx) => {
    // E3 (an entry of the execution log, 09-01) follows D1, which the model placed on K (first written 09-20).
    const e3 = inferDecision(ctx, b.decision('E3'));
    assert.deepEqual(e3.plans.map((p) => p.name), []);
    assert.ok(e3.tried.some((t) => /^leads to K through its entry names D1; D1 is placed on K; K was first written 2026-09-20, after this entry of 2026-09-01$/.test(t)), e3.tried.join(' | '));
    // D3 (a product decision of the same day) follows D1 to K: a product decision may shape a later plan.
    assert.equal(pick(inferDecision(ctx, b.decision('D3')).plans)?.name, 'K');
    // AB (a ticket of 09-01) cites D1 in its row: K is dropped, and the reason is not refused with that chain.
    const ab = inferThread(ctx, b.thread('AB'));
    assert.ok(!ab.plans.some((p) => p.name === 'K'), JSON.stringify(ab.plans));
    assert.ok(ab.tried.some((t) => /^leads to K through .*D1.*; K was first written 2026-09-20, after this work item of 2026-09-01$/.test(t)), ab.tried.join(' | '));
    assert.equal(noPlanWhyRefusal(ctx, b.thread('AB')), null);
    // CN (09-20) goes to K by its own index row.
    assert.equal(pick(inferThread(ctx, b.thread('CN')).plans)?.name, 'K');
  });
  const accepted = await b.call('pk_write_thread', { id: 'AB', noPlanWhy: 'Its row follows D1, but D1 leads only to K, written after this ticket.' });
  assert.equal(accepted.error, false, accepted.text);
  assert.doesNotMatch(accepted.text, /refused/);
  // The program's pass leaves E3 and AB off K, and places D3 there.
  const l = Ledger.openDir(b.store.dir)!;
  try { placeByProgram(b.store, l, { id: 'round_1' }, 'job_main', 'test'); } finally { l.close(); }
  assert.deepEqual(b.decision('E3').refines, []);
  assert.deepEqual(b.decision('D3').refines.map((id) => b.store.reference.get(id)!.name.split(' · ')[0]), ['K']);
  assert.ok(!b.thread('AB').serves.some((s) => s.referenceId === b.ids.k));
});
