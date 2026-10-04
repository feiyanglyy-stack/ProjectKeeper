/**
 * CQ (D104), after the six-run read-through of 2026-10-01 — placement by the program: the records lead, the program places
 * and marks Inferred; a reason for "no plan" is a record the program can refuse; a missing layer gives a defined zero; the
 * spot-check sees the placement readings.
 *
 * Two invented projects:
 * - **Forge**, with the layers ContextKeeper's shape has (a plan with increments and a contract table, a decision record,
 *   a ticket index, prompts with front matter, an execution log, an archived execution arrangement): every pointer kind
 *   the inference follows is exercised on it.
 * - **Kennel**, shaped like a project with two-letter tickets from an index table, prompts with front matter, an issue
 *   number, and no plan, contract or decision layer: the defined zeros, nothing refused, no crash on `AB` or `#18`.
 *
 * CS (D104, after the CQ run), on Forge with a second and a third round: a program placement with no result stays listed
 * and counted in later rounds, and its result lands on the record of the round that placed it; the spot-check is given
 * every standing reason no spot-check has checked, whichever round wrote it, and at least five of the unreviewed
 * placements, and counts them apart (`SpotCheck.placement`).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { KeeperJob, Project, ScopeItem, Source } from '../../model/types.ts';
import type { ClerkRound, ClerkStage, LayerEntry, RoundKind } from '../../model/k-types.ts';
import { ProjectStore } from '../../store/project-store.ts';
import { Ledger } from '../../ledger/index.ts';
import { ledgerPath, rebuildLedgerInPlace } from '../../ledger/rebuild.ts';
import { keeperTools } from '../tools.ts';
import { clerkTools, type ClerkToolContext } from '../clerk-tools.ts';
import { stageTools } from './stage-tools.ts';
import { placeTools } from './place-tools.ts';
import { roundOpen, unplacedNote } from './round-open.ts';
import { lineIndex, numberMatcher, planThroughDecisions, tracePlacement } from './placing.ts';
import { NO_AREAS, NO_CONTRACT_LAYER, NO_PLAN_LAYER, inferDecision, inferThread, inferenceContext, pick, placeByProgram } from './placement-inference.ts';
import { generationCandidates } from './generation-check.ts';
import { placementLine, spotCheckBlock, spotCheckTargets } from '../../process/breakpoint-candidates.ts';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-cq-'));
after(() => { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const AT = '2026-10-01T10:00:00.000Z';

// ───────────────────────── two invented projects, each with its ledger ─────────────────────────

interface Fixture { readonly project: Project; readonly scope: ScopeItem; readonly repo: string; readonly files: Record<string, string>; readonly baseHome: string }

function makeProject(id: string, name: string, write: (put: (rel: string, text: string) => void) => void): Fixture {
  const repo = join(scratch, id);
  mkdirSync(repo);
  const git = (args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-01T12:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T12:00:00Z', GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${id}@example.invalid`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${id}@example.invalid` }, windowsHide: true,
  }).trim();
  const files: Record<string, string> = {};
  const put = (rel: string, text: string) => { files[rel] = text; const full = join(repo, rel); mkdirSync(resolve(full, '..'), { recursive: true }); writeFileSync(full, text); };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'core.autocrlf', 'false']);
  write(put);
  git(['add', '-A']);
  git(['commit', '-q', '-m', `Plan ${name}`]);
  const scope = { id: `scope_${id}`, path: repo, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as unknown as ScopeItem;
  const project = { id, name, locations: [repo], scope: [scope], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: AT, lastOpenedAt: null, lastScopedAt: null, takeoverDepth: 'Full' } as unknown as Project;
  const baseHome = mkdtempSync(join(scratch, `home-${id}-`));
  rebuildLedgerInPlace(ledgerPath(project.id, baseHome), project);
  return { project, scope, repo, files, baseHome };
}

const prompt = (id: string, title: string, fields: Record<string, string>, body: string) => `---\nid: "${id}"\n${Object.entries(fields).map(([k, v]) => `${k}: "${v}"`).join('\n')}\n---\n\n# ${id} · ${title}\n\n${body}\n`;

const forge = makeProject('forge', 'Forge', (put) => {
  put('docs/PRD.md', ['# Forge PRD', '', '## 4 · Modules', '', '| Module | Effect |', '| --- | --- |', '| FG-M1 · Smelt | ore becomes metal |', '| FG-M2 · Cast | metal takes a shape |', '| FG-M3 · Temper | the shape holds an edge |', ''].join('\n'));
  put('docs/PLAN.md', [
    '# Forge plan', '', '## 3 · Increments', '', '### P1 · First blade', '', 'Smelt, cast and temper one blade.', '', '### P2 · Many blades', '', 'A rack of blades.', '', '### K · Keep the forge', '', 'Keep the forge in order while the blades are made.', '',
    '## 7 · Contracts', '',
    '| ID | Contract | Increment | Module | Status |', '| --- | --- | --- | --- | --- |',
    '| FGC-01 | The smelt | P1 | FG-M1 | ready |', '| FGC-02 | The cast | P1 | FG-M2 | ready |', '| FGC-03 | The temper | P1 | FG-M3 | ready |', '| FGC-04 | The rack | P2 | FG-M1 | draft |', '',
  ].join('\n'));
  put('docs/DECISIONS.md', [
    '# Decisions', '',
    '**D1 · Smelt before cast.** 影响：FGC-01、FGC-02。', '',
    '**D2 · The trial batch is frozen and moved out.** Redone the way D1 says.', '',
    '**D3 · The rack waits.** The ticket AE is put off; 影响：增量 P2 的安排。', '',
    '**D4 · One blade is tried on a real cut.** The owner: 「先切一刀」.', '',
    '**D5 · The same tongs at every station.** No station gets tongs of its own.', '',
  ].join('\n'));
  put('subagent/INDEX.md', [
    '# Index', '', '## Tickets', '', '| ID | Executor | Prompt |', '| --- | --- | --- |',
    '| AA | kimi | [AA-milestone-qc.md](AA-milestone-qc.md) |', '| AB | pi | Reading of the whole graph |', '| AC | pi | Sharpen the tongs |',
    '| AD | kimi | AD-audit.md · archived (D2) |', '| AE | sol | [AE-rack.md](AE-rack.md) |', '| AF | sol | The real cut |', '| AG | kimi | [AG-tongs.md](AG-tongs.md) |', '',
  ].join('\n'));
  put('subagent/AA-milestone-qc.md', prompt('AA', 'Milestone QC', { executor: 'kimi', status: 'done', plan: 'P1' }, 'Judge every contract of the increment.'));
  put('subagent/AE-rack.md', prompt('AE', 'The rack, first half', { executor: 'sol', status: 'queued', upstream: 'FGC-04' }, 'Build the first half of the rack.'));
  put('subagent/AG-tongs.md', prompt('AG', 'The tongs', { executor: 'kimi', status: 'done' }, 'Follows the first batch of [the execution plan](archive/execution-plan.md).'));
  put('subagent/archive/execution-plan.md', [
    '# Forge · P1 execution plan', '', '| Batch | Delivers | Contracts | Tickets |', '| --- | --- | --- | --- |',
    '| B1 | The smelt and the cast | FGC-01、FGC-02 | AA |', '| B2 | The temper and the whole-graph reading | FGC-03 | AB、AF |', '',
    'Kept here once P1 was done.', '',
  ].join('\n'));
  put('subagent/DECISIONS.md', ['# Execution log', '', '### E1 · B1 merged', '', 'B1 is in: the smelt and the cast.', '', '### E2 · The tongs question', '', 'The owner asked why every station has the same tongs.', '', '### E3 · AG dispatched', '', 'AG goes to kimi.', ''].join('\n'));
});

const kennel = makeProject('kennel', 'Kennel', (put) => {
  put('docs/PRODUCT.md', ['# Kennel', '', 'A phone app that remembers every dog it meets.', '', '## What it does', '', '- remembers a dog by its collar tag', '- tells two dogs apart', ''].join('\n'));
  put('docs/MEMORY_DESIGN.md', ['# Memory design', '', '## 15.8 批次', '', '| 批次 | 内容 | 票 |', '| --- | --- | --- |', '| 批次 1 | 记忆底座 | AA、AB |', '| 批次 2 | 两只狗分开 | AC |', ''].join('\n'));
  put('subagent/INDEX.md', ['# Index', '', '| ID | Executor | Prompt |', '| --- | --- | --- |', '| AA | kimi | [AA-kimi-memory.md](AA-kimi-memory.md) |', '| AB | kimi | [AB-kimi-tags.md](AB-kimi-tags.md) |', '| AC | grok | [AC-grok-two-dogs.md](AC-grok-two-dogs.md) |', '| AD | kimi | QC of AA and AB |', '| #18 | github | Crash on start |', ''].join('\n'));
  put('subagent/AA-kimi-memory.md', prompt('AA', 'Memory', { executor: 'kimi', status: 'done', milestone_qc: 'AD' }, 'Build the memory.'));
  put('subagent/AB-kimi-tags.md', prompt('AB', 'Tags', { executor: 'kimi', status: 'done', resolved_by: 'AC' }, 'Read the collar tags.'));
  put('subagent/AC-grok-two-dogs.md', prompt('AC', 'Two dogs', { executor: 'grok', status: 'queued' }, 'Tell two dogs apart.'));
});

/** A document's sources as the scan cuts them: one per heading's section, with its heading path. */
function sectionSources(fx: Fixture, rel: string, text: string): Source[] {
  const lines = text.split('\n');
  const heads = lines.flatMap((l, i) => { const m = /^(#{1,6})\s+(.*)$/.exec(l); return m ? [{ line: i + 1, level: m[1]!.length, text: m[2]!.trim() }] : []; });
  const out: Source[] = [];
  const stack: { level: number; text: string }[] = [];
  heads.forEach((h, k) => {
    while (stack.length && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push({ level: h.level, text: h.text });
    const end = (heads[k + 1]?.line ?? lines.length + 1) - 1;
    out.push({
      id: `src_${fx.project.id}_${rel.replace(/\W/g, '_')}_${h.line}`, projectId: fx.project.id, title: h.text, anchor: { kind: 'file', path: join(fx.repo, ...rel.split('/')), headingPath: stack.map((s) => s.text), lineStart: h.line, lineEnd: end },
      ids: [], version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt: lines.slice(h.line - 1, end).join('\n'), usedAs: 'Design', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: fx.scope.id, hasCredential: false, bytes: 10,
    } as unknown as Source);
  });
  return out;
}

function round(projectId: string, kind: RoundKind, stage: ClerkStage): ClerkRound {
  return {
    id: 'round_1', projectId, kind, number: 1, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root',
    questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT,
    stage, stageLog: [{ stage, startedAt: AT, endedAt: null, timing: null }], lanes: [],
  } as ClerkRound;
}

type Called = { text: string; error: boolean; json: Record<string, unknown> };

/** A workbench on a fixture: its layers, its sources, a First usable round in the skeleton stage, the main job, the tools. */
function bench(fx: Fixture, layers: readonly [string, LayerEntry['layer'], boolean][]) {
  const home = mkdtempSync(join(scratch, `bench-${fx.project.id}-`));
  const store = ProjectStore.open(fx.project.id, home);
  copyFileSync(ledgerPath(fx.project.id, fx.baseHome), join(store.dir, 'ledger.sqlite'));
  for (const [path, layer, current] of layers) store.layers.put({ id: `layer_${path}`, projectId: fx.project.id, repo: fx.repo, path, layer, note: null, current, roundId: null, updatedAt: AT });
  for (const [rel, text] of Object.entries(fx.files)) for (const s of sectionSources(fx, rel, text)) store.sources.put(s);
  store.clerkRounds.put(round(fx.project.id, 'First usable', 'skeleton'));
  /** The tools as one job of a round has them: the job is put, so the trace of its writes is its round's (the spot-check reads it by job). */
  const as = (jobId: string, step: { roundId: string; kind: string; path: null }) => {
    if (!store.jobs.has(jobId)) store.jobs.put({ id: jobId, projectId: fx.project.id, kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: [step.roundId], label: step.kind }, status: 'Running', queuedAt: AT, startedAt: AT, endedAt: null, savedResults: [], usage: {}, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: 'job_root', resultText: null, priority: 1, task: null, step } as unknown as KeeperJob);
    const ctx = { store, project: fx.project, jobId, jobKind: 'Organizing', model: null, step, stageEntered: () => ({ note: null }) } as unknown as ClerkToolContext;
    const tools: ToolDefinition[] = [...keeperTools(ctx), ...clerkTools(ctx), ...stageTools(ctx, { coverageSettled: () => true, stageSkill: (s) => `SKILL ${s}` })];
    for (const t of placeTools(ctx)) if (!tools.some((x) => x.name === t.name)) tools.push(t);
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
    return { call, ok };
  };
  // The main job of the first round.
  const { call, ok } = as('job_main', { roundId: 'round_1', kind: 'main', path: null });
  const ledger = () => Ledger.openDir(store.dir)!;
  const src = (rel: string, heading: string) => store.sources.find((s) => s.anchor.kind === 'file' && s.anchor.path.replace(/\\/g, '/').endsWith(rel) && s.title === heading)!.id;
  const byNumber = (n: string) => store.threads.find((t) => t.ids.some((i) => i.toUpperCase() === n.toUpperCase()))!;
  const refBy = (n: string, category?: string) => store.reference.find((r) => r.ids.some((i) => i.toUpperCase() === n.toUpperCase()) && (!category || r.category === category))!;
  const open = () => { const l = ledger(); try { return roundOpen(store, store.clerkRounds.get('round_1')!, { ledger: l }); } finally { l.close(); } };
  const withCtx = <T>(fn: (ctx: ReturnType<typeof inferenceContext>) => T): T => { const l = ledger(); try { return fn(inferenceContext(store, l)); } finally { l.close(); } };
  return { store, call, ok, as, ledger, src, byNumber, refBy, open, withCtx, fx };
}

const FORGE_LAYERS: [string, LayerEntry['layer'], boolean][] = [
  ['docs/PRD.md', 'PRD', true], ['docs/PLAN.md', 'Plan', true], ['docs/DECISIONS.md', 'Decision record', true], ['subagent/INDEX.md', 'Task index', true],
  ['subagent/DECISIONS.md', 'Decision record', true], ['subagent/archive', 'Execution arrangement', false],
];

/** Forge's workbench as the skeleton lanes leave it: modules, plans (K among them), contracts, tickets, decisions, the log; nothing of the tickets placed yet. */
async function forgeBench(opts: { readonly areasLate?: boolean } = {}) {
  const b = bench(forge, FORGE_LAYERS);
  const ref = (category: string, name: string, extra: Record<string, unknown> = {}) => b.ok('pk_write_reference', { category, name, text: name, basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [b.src('docs/PRD.md', '4 · Modules')], ...extra });
  const product = (await ref('Product', 'Forge')).id as string;
  const goal = (await ref('Goal', 'A blade that holds its edge', { refines: [product] })).id as string;
  const areas: Record<string, string> = {};
  if (!opts.areasLate) for (const [n, name] of [['FG-M1', 'FG-M1 · Smelt'], ['FG-M2', 'FG-M2 · Cast'], ['FG-M3', 'FG-M3 · Temper']]) areas[n!] = (await ref('Area', name!, { ids: [n], refines: [goal] })).id as string;
  // The plans from their headings: P1, P2, and K — a plan named by one letter.
  await b.ok('pk_fill_from_headings', { path: 'docs/PLAN.md', level: 3, category: 'Plan', under: 'Increments' });
  await b.ok('pk_fill_from_table', { path: 'docs/PLAN.md', table: { heading: 'Contracts' }, into: 'threads', category: 'Requirement', columns: { title: 'Contract', id: 'ID', parent: 'Module', plan: 'Increment', status: 'Status' } });
  await b.ok('pk_fill_from_table', { path: 'subagent/INDEX.md', table: { heading: 'Tickets' }, into: 'threads', columns: { title: 'Prompt', id: 'ID' } });
  await b.ok('pk_fill_from_bold', { path: 'docs/DECISIONS.md', category: 'Decision' });
  await b.ok('pk_fill_from_headings', { path: 'subagent/DECISIONS.md', level: 3, category: 'Decision' });
  for (const n of ['D1', 'D2', 'D3', 'D4', 'D5']) await b.ok('pk_write_reference', { id: b.refBy(n, 'Decision').id, refines: [product] });
  await b.ok('pk_write_thread', { id: 'AF', implements: ['FGC-03'] });
  const plan = (n: string) => b.refBy(n, 'Plan').id;
  return { ...b, ids: { product, goal, ...areas, p1: plan('P1'), p2: plan('P2'), k: plan('K') } };
}

// ───────────────────────── 1 · the pointers, one by one ─────────────────────────

test('the records lead: a plan through the index row, the front matter, the contract, the decision chain, a link, and the archived arrangement that lists the work', async () => {
  const b = await forgeBench();
  assert.deepEqual(b.refBy('K', 'Plan').ids, ['K'], 'a plan named by one letter carries that letter as its id');
  b.withCtx((ctx) => {
    const leads = (n: string) => inferThread(ctx, b.byNumber(n));
    const chain = (n: string) => pick(leads(n).plans)?.through.join('; ') ?? '(none)';
    // The front matter of its prompt.
    assert.equal(pick(leads('AA').plans)?.name, 'P1');
    assert.match(chain('AA'), /its front matter \(subagent\/AA-milestone-qc\.md\) says plan: P1/);
    // The archived arrangement whose row lists it: its header names P1.
    assert.equal(pick(leads('AB').plans)?.name, 'P1');
    assert.match(chain('AB'), /its row \(subagent\/archive\/execution-plan\.md:6\) writes Contracts: FGC-03, which serves P1/);
    // The index row names a decision; the decision's entry names another, whose entry names the contracts of P1.
    assert.equal(pick(leads('AD').plans)?.name, 'P1');
    assert.match(chain('AD'), /its row \(subagent\/INDEX\.md:10\) writes Prompt: D2; D2's entry names D1; D1's entry names FGC-01, FGC-02, which serve P1/);
    // The front matter names the unit it follows: a contract of P2.
    assert.equal(pick(leads('AE').plans)?.name, 'P2');
    assert.match(chain('AE'), /its front matter \(subagent\/AE-rack\.md\) says upstream: FGC-04, which serves P2/);
    // The contract it implements, and its module.
    assert.equal(pick(leads('AF').plans)?.name, 'P1');
    assert.match(chain('AF'), /it implements FGC-03, which serves P1/);
    assert.equal(pick(leads('AF').areas)?.name, 'FG-M3');
    // A link in its prompt to the arrangement.
    assert.equal(pick(leads('AG').plans)?.name, 'P1');
    assert.match(chain('AG'), /it links subagent\/archive\/execution-plan\.md, which executed P1/);
    // Nothing leads anywhere for AC: the pointers tried are said.
    const ac = leads('AC');
    assert.deepEqual(ac.plans, []);
    assert.ok(ac.tried.some((t) => /subagent\/INDEX\.md lists it \(line 9\) but its row writes no plan or module/.test(t)), ac.tried.join(' | '));
    assert.ok(ac.tried.includes('no prompt of its own carries metadata') && ac.tried.includes('it implements no contract'), ac.tried.join(' | '));
    // An execution decision follows the batch it names to the plan the arrangement executed; one that names nothing stays empty.
    const e1 = inferDecision(ctx, b.refBy('E1', 'Decision'));
    assert.equal(pick(e1.plans)?.name, 'P1');
    assert.match(e1.plans[0]!.through.join('; '), /its entry names B1, a row of subagent\/archive\/execution-plan\.md \(line 5\), which executed P1/);
    const e2 = inferDecision(ctx, b.refBy('E2', 'Decision'));
    assert.deepEqual([e2.plans, e2.areas], [[], []]);
    assert.ok(e2.tried.includes('its entry names no plan, module, number or section'), e2.tried.join(' | '));
    // The project's numbers, not a fixed shape: two letters, the contracts, the log's family, a batch the ledger finds defined; not a stranger.
    assert.deepEqual(numberMatcher(b.store, ctx.ledger)('AB, FGC-02 and E2 follow B1; ZZ-99 and #18 are nobody’s').sort(), ['AB', 'B1', 'E2', 'FGC-02']);
  });
  // A table row of an archived arrangement is not dated; the rest of it, and a decision record, are.
  const lines = lineIndex(b.store);
  assert.equal(lines.dated('subagent/archive/execution-plan.md', '| B1 | The smelt and the cast | FGC-01、FGC-02 | AA |'), false);
  assert.equal(lines.dated('subagent/archive/execution-plan.md', 'Kept here once P1 was done.'), true);
  assert.equal(lines.dated('subagent/archive/execution-plan.md'), true);
  assert.equal(lines.dated('docs/DECISIONS.md', '| D1 | x |'), true);
});

// ───────────────────────── 2 · a reason is a record the program can refuse ─────────────────────────

test('noPlanWhy is refused where the records lead to a plan, with the chain; accepted where they lead nowhere; cleared only with a placement', async () => {
  const b = await forgeBench();
  const refused = await b.call('pk_write_thread', { id: 'AD', noPlanWhy: 'Its arrangement is archived.' });
  assert.ok(refused.error, refused.text);
  assert.match(refused.text, /noPlanWhy is refused: the records lead to P1 — its row \(subagent\/INDEX\.md:10\) writes Prompt: D2; D2's entry names D1; D1's entry names FGC-01, FGC-02, which serve P1[^\n]*Nothing was written\./);
  assert.equal(b.byNumber('AD').noPlanWhy, undefined);
  // The records lead nowhere for AC: the reason stands, and AC leaves the noPlan list for the written list.
  const why = 'The index lists it with no plan; no prompt, no contract, no decision names it.';
  const written = await b.ok('pk_write_thread', { id: 'AC', noPlanWhy: why });
  assert.equal(written.id, b.byNumber('AC').id);
  assert.equal(b.byNumber('AC').noPlanWhy, why);
  let open = b.open();
  assert.ok(!open.workItems.noPlan.items.some((i) => i.name.startsWith('AC')), 'not counted as unplaced');
  assert.deepEqual(open.workItems.noPlanWritten.items.map((i) => [i.name.split(' ')[0], i.why]), [['AC', why]]);
  assert.match(unplacedNote(open)!, /1 work item written: no plan — AC: The index lists it with no plan; no prompt, no contract, no… \(placed by the recorded reason, not counted as unplaced\)/);
  // An update that leaves it out keeps it; clearing it without a placement is refused; with the plan it goes.
  await b.ok('pk_write_thread', { id: 'AC', results: 'Tongs sharpened.' });
  assert.equal(b.byNumber('AC').noPlanWhy, why);
  const cleared = await b.call('pk_write_thread', { id: 'AC', noPlanWhy: null });
  assert.match(cleared.text, /noPlanWhy is cleared only together with a placement/);
  assert.equal(b.byNumber('AC').noPlanWhy, why);
  await b.ok('pk_write_thread', { id: 'AC', noPlanWhy: null, serves: [{ referenceId: 'P1', claim: 'the owner said so in the forge', basis: 'Explicit' }] });
  assert.equal(b.byNumber('AC').noPlanWhy, undefined);
  assert.equal(b.byNumber('AC').serves[0]!.referenceId, b.ids.p1, 'serves names a Plan by the id its document gives it');
  // In a plan already: a reason is for work in no plan.
  const inPlan = await b.call('pk_write_thread', { id: 'AC', noPlanWhy: 'nothing' });
  assert.match(inPlan.text, /noPlanWhy says no record places this work item in a plan, and it is in P1/);
  // The module: refused where a contract names one, accepted where none does.
  const area = await b.call('pk_write_thread', { id: 'AF', noAreaWhy: 'No module is written.' });
  assert.match(area.text, /noAreaWhy is refused: the records name FG-M3 — its row \(subagent\/archive\/execution-plan\.md:6\) writes Contracts: FGC-03, which serves FG-M3; it implements FGC-03, which serves FG-M3/);
  await b.ok('pk_write_thread', { id: 'AC', noAreaWhy: 'No contract, no Module column, no dispatch field names a module.' });
  open = b.open();
  assert.ok(!open.workItems.noModule.items.some((i) => i.name.startsWith('AC')));
  assert.deepEqual(open.workItems.noAreaWritten.items.map((i) => i.name.split(' ')[0]), ['AC']);
});

// ───────────────────────── 3 · the program places first, basis Inferred ─────────────────────────

test('entering reconcile the program places what the records lead to, basis Inferred with the chain; pk_round_state lists them; a model’s write confirms or moves one, and un-placing needs an accepted reason', async () => {
  const b = await forgeBench();
  const moved = await b.ok('pk_stage', { to: 'reconcile' });
  assert.match(String(moved.note), /=== Placed by the program \(Inferred\), entering reconcile\n\d+ placements from the records, basis Inferred, the chain in each claim/);
  const serving = (n: string) => b.byNumber(n).serves.map((s) => [b.store.reference.get(s.referenceId)!.name.split(' · ')[0], s.basis, s.claim] as const);
  assert.deepEqual(serving('AD').map((s) => [s[0], s[1]]), [['P1', 'Inferred']]);
  assert.match(serving('AD')[0]![2], /^its row \(subagent\/INDEX\.md:10\) writes Prompt: D2; D2's entry names D1; D1's entry names FGC-01, FGC-02, which serve P1/);
  assert.deepEqual(serving('AA').map((s) => [s[0], s[1]]), [['P1', 'Inferred']]);
  // The archived row that lists AB names the contract FGC-03, whose module is FG-M3: the module too, first.
  assert.deepEqual(serving('AB').map((s) => [s[0], s[1]]), [['FG-M3', 'Inferred'], ['P1', 'Inferred']]);
  // The unit AE follows (FGC-04) stands in P2 and in FG-M1: both, the Area first.
  assert.deepEqual(serving('AE').map((s) => [s[0], s[1]]), [['FG-M1', 'Inferred'], ['P2', 'Inferred']]);
  assert.deepEqual(serving('AG').map((s) => [s[0], s[1]]), [['P1', 'Inferred']]);
  // The Area first, then the Plan.
  assert.deepEqual(serving('AF').map((s) => [s[0], s[1]]), [['FG-M3', 'Inferred'], ['P1', 'Inferred']]);
  // AC stays: nothing leads anywhere.
  assert.deepEqual(serving('AC'), []);
  // The execution decisions: E1 by its batch; E3 by the ticket it names, once that ticket is placed (the second pass); E2 stays.
  const refines = (n: string) => b.refBy(n, 'Decision').refines.map((id) => b.store.reference.get(id)!.name.split(' · ')[0]);
  assert.deepEqual(refines('E1'), ['P1']);
  assert.deepEqual(refines('E3'), ['P1']);
  assert.deepEqual(refines('E2'), []);
  // The list, with the chain, every one left as written so far.
  const listed = await b.ok('pk_round_state', { list: 'inferredPlacements' });
  const rows = listed.items as { name: string; placedOn: string; chain: string; result: string }[];
  assert.ok((listed.count as number) >= 9, `${listed.count} placements`);
  assert.ok(rows.every((r) => r.result === 'left' && r.chain.length > 0), JSON.stringify(rows.slice(0, 3)));
  assert.ok(rows.some((r) => r.name.startsWith('AD') && r.placedOn === 'P1' && /D2's entry names D1/.test(r.chain)));
  const state = await b.ok('pk_round_state', {});
  assert.equal((state.open as Record<string, number>).inferredPlacements, listed.count);
  assert.equal((state.open as Record<string, number>).noPlan, 1, 'only AC is left in no plan');
  // A model moves one with the record: the write succeeds and says what it replaced; the list shows it moved.
  const over = await b.ok('pk_write_thread', { id: 'AE', replaceServes: true, serves: [{ referenceId: 'P1', claim: 'the owner moved the rack into the first blade', basis: 'Explicit' }] });
  // replaceServes gives the whole list: both program placements (the module and the plan) were replaced.
  assert.deepEqual((over.replacedInferred as string[]).map((s) => s.split(' (')[0]), ['FG-M1', 'P2']);
  assert.deepEqual(serving('AE').map((s) => [s[0], s[1]]), [['P1', 'Explicit']]);
  // CS: the list holds what nobody confirmed or moved yet; the result is on the round's record.
  const record = (name: string, target: string) => b.store.clerkRounds.get('round_1')!.inferredPlacements!.find((p) => p.name.startsWith(name) && p.target === target)!;
  const after = (await b.ok('pk_round_state', { list: 'inferredPlacements' })).items as { name: string; result: string }[];
  assert.ok(!after.some((r) => r.name.startsWith('AE')), 'a moved placement leaves the list');
  assert.deepEqual([record('AE', 'P2').result?.kind, record('AE', 'P2').result?.to], ['moved', 'P1']);
  // A model confirms one by writing it as its own.
  await b.ok('pk_write_thread', { id: 'AB', serves: [{ referenceId: b.ids.p1, claim: 'checked against the archived plan, row B2', basis: 'Explicit' }] });
  const confirmed = (await b.ok('pk_round_state', { list: 'inferredPlacements' })).items as { name: string; placedOn: string; result: string }[];
  assert.equal(record('AB', 'P1').result?.kind, 'confirmed', 'the plan entry rewritten');
  assert.ok(!confirmed.some((r) => r.name.startsWith('AB') && r.placedOn === 'P1'), 'a confirmed placement leaves the list');
  assert.equal(confirmed.find((r) => r.name.startsWith('AB') && r.placedOn === 'FG-M3')!.result, 'left', 'the module entry untouched');
  // Un-placing without a reason the program accepts is refused.
  const bare = await b.call('pk_write_thread', { id: 'AD', replaceServes: true, serves: [] });
  assert.match(bare.text, /replaceServes leaves this work item in no plan \(it served P1\)/);
  assert.deepEqual(serving('AD').map((s) => s[0]), ['P1']);
  // Running the moments again writes nothing twice.
  const l = b.ledger();
  try { assert.equal(placeByProgram(b.store, l, { id: 'round_1' }, 'job_main', 'again').placed.length, 0); } finally { l.close(); }
});

// ───────────────────────── 4 · basis on the bulk tools; a plan’s own id ─────────────────────────

test('pk_place_range takes a basis (Explicit by default); the program’s own placeAgain writes Inferred; a Plan is found by the id its document gives it', async () => {
  const b = await forgeBench();
  await b.ok('pk_place_range', { numbers: 'AC', to: 'K', only: 'threads', basis: 'Inferred', claim: 'read off the index' });
  assert.deepEqual(b.byNumber('AC').serves.map((s) => [s.referenceId, s.basis]), [[b.ids.k, 'Inferred']]);
  await b.ok('pk_place_range', { numbers: 'AB', to: 'P2', only: 'threads' });
  assert.deepEqual(b.byNumber('AB').serves.map((s) => [s.referenceId, s.basis]), [[b.ids.p2, 'Explicit']]);
  assert.match((await b.call('pk_place_range', { numbers: 'AB', to: 'P2', basis: 'Guessed' })).text, /basis is Explicit or Inferred/);
  // A single write names the Plan by its one-letter id, as pk_place_range does.
  await b.ok('pk_write_thread', { id: 'AD', serves: [{ referenceId: 'K', claim: 'kept in order', basis: 'Explicit' }] });
  assert.equal(b.byNumber('AD').serves[0]!.referenceId, b.ids.k);
  await b.ok('pk_write_reference', { id: b.refBy('E2', 'Decision').id, refines: ['K'] });
  assert.deepEqual(b.refBy('E2', 'Decision').refines, [b.ids.k]);
  // An Area created after the contracts were filled places again what names it — the program's write, Inferred.
  const late = await forgeBench({ areasLate: true });
  const made = await late.ok('pk_write_reference', { category: 'Area', name: 'FG-M1 · Smelt', ids: ['FG-M1'], text: 'Smelt', basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [late.src('docs/PRD.md', '4 · Modules')], refines: [late.ids.goal] });
  assert.ok((made.placedAgain as { count: number }).count >= 1, JSON.stringify(made));
  const smelt = late.byNumber('FGC-01').serves.find((s) => s.referenceId === made.id);
  assert.equal(smelt?.basis, 'Inferred');
});

// ───────────────────────── 5 · the defined zeros: a project with no plan, contract or decision layer ─────────────────────────

test('a project shaped like a ticket index with prompts: noContract and noPlan are not applicable with their sentences, nothing is refused, nothing crashes on AB or #18; a batch table then gives the Plan items', async () => {
  const b = bench(kennel, [['subagent/INDEX.md', 'Task index', true]]);
  await b.ok('pk_write_reference', { category: 'Product', name: 'Kennel', text: 'A phone app that remembers every dog it meets.', basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [b.src('docs/PRODUCT.md', 'Kennel')] });
  await b.ok('pk_fill_from_table', { path: 'subagent/INDEX.md', into: 'threads', columns: { title: 'Prompt', id: 'ID' } });
  assert.deepEqual(b.store.threads.all().map((t) => t.ids[0]).sort(), ['#18', 'AA', 'AB', 'AC', 'AD']);
  let open = b.open();
  assert.deepEqual([open.tickets.noContract.count, open.tickets.noContract.notApplicable], [0, NO_CONTRACT_LAYER]);
  assert.deepEqual([open.workItems.noPlan.count, open.workItems.noPlan.notApplicable], [0, NO_PLAN_LAYER]);
  assert.deepEqual([open.workItems.noModule.count, open.workItems.noModule.notApplicable], [0, NO_AREAS]);
  assert.equal(unplacedNote(open), null, 'nothing is unplaced: no note');
  const state = await b.ok('pk_round_state', {});
  assert.deepEqual(state.notApplicable, { noPlan: NO_PLAN_LAYER, noModule: NO_AREAS, noContract: NO_CONTRACT_LAYER });
  // Nothing refused: a reason is accepted where the project has no plan layer; the inference runs and places nothing.
  await b.ok('pk_write_thread', { id: 'AB', noPlanWhy: 'This project plans by its index alone.' });
  const l = b.ledger();
  try {
    assert.equal(placeByProgram(b.store, l, { id: 'round_1' }, 'job_main', 'test').placed.length, 0);
    const ctx = inferenceContext(b.store, l);
    for (const n of ['AB', '#18']) {
      const t = b.byNumber(n);
      assert.deepEqual(inferThread(ctx, t).plans, []);
      assert.deepEqual(planThroughDecisions(b.store, l, t), []);
    }
    const product = b.store.reference.find((r) => r.category === 'Product')!;
    assert.doesNotThrow(() => tracePlacement(b.store, l, product));
    assert.deepEqual(numberMatcher(b.store, l)('AB fixed #18; AD checked it').sort(), ['#18', 'AB', 'AD']);
  } finally { l.close(); }
  // The project's only planning layer is a batch table: its batches become the Plan items, each with the batch as its id.
  await b.ok('pk_fill_from_table', { path: 'docs/MEMORY_DESIGN.md', table: { heading: '批次' }, into: 'reference', category: 'Plan', columns: { title: '内容', id: '批次' } });
  assert.deepEqual(b.store.reference.filter((r) => r.category === 'Plan').map((r) => r.ids).sort(), [['批次 1'], ['批次 2']]);
  open = b.open();
  assert.equal(open.workItems.noPlan.notApplicable, undefined, 'a plan layer now: the list applies');
  assert.deepEqual(open.workItems.noPlan.items.map((i) => b.store.threads.get(i.id)!.ids[0]).sort(), ['#18', 'AA', 'AC', 'AD'], 'AB keeps its written reason');
  await b.ok('pk_write_thread', { id: 'AA', serves: [{ referenceId: '批次 1', claim: 'the batch table lists it', basis: 'Explicit' }] });
  assert.equal(b.byNumber('AA').serves[0]!.referenceId, b.store.reference.find((r) => r.ids[0] === '批次 1')!.id);
});

// ───────────────────────── 6 · the spot-check sees the placement readings; the candidate carries its evidence ─────────────────────────

test('the spot-check checks every recorded reason in full with the records the trace names, and samples the program’s placements; an archived arrangement is listed as a candidate with what its rows execute', async () => {
  const b = await forgeBench();
  await b.ok('pk_stage', { to: 'reconcile' });
  await b.ok('pk_write_thread', { id: 'AC', noPlanWhy: 'The index lists it with no plan; no prompt, no contract, no decision names it.' });
  await b.ok('pk_write_reference', { id: b.refBy('D5', 'Decision').id, wholeProductWhy: 'Every station of the forge uses the same tongs.' });
  const l = b.ledger();
  try {
    const targets = spotCheckTargets(b.store, { id: 'round_1' }, 24, l);
    const ac = targets.full.find((t) => t.collection === 'threads' && t.id === b.byNumber('AC').id);
    assert.ok(ac, JSON.stringify(targets.full.map((t) => t.summary.slice(0, 60))));
    assert.match(ac!.summary, /work item AC .* written as no plan — “The index lists it with no plan; no prompt, no contract, no decision names it\.”; the records the program's trace names: .*subagent\/INDEX\.md lists it \(line 9\)/);
    const d5 = targets.full.find((t) => t.collection === 'reference' && t.id === b.refBy('D5', 'Decision').id);
    assert.match(d5!.summary, /written on the whole product — “Every station of the forge uses the same tongs\.”; the records the program's trace names:/);
    assert.ok(targets.sample.some((t) => /placed by the program \(Inferred\) on P1 — /.test(t.summary)), targets.sample.map((t) => t.summary.slice(0, 80)).join('\n'));
    const archive = generationCandidates(b.store, l).find((c) => c.key === 'set:subagent/archive');
    assert.ok(archive, 'the archived arrangement is a candidate');
    assert.match(archive!.executes ?? '', /^its rows name work of plan\(s\) P1 \(6 work items, 1 log entry\)$/);
    assert.match(archive!.why, /its rows name work of plan\(s\) P1/);
  } finally { l.close(); }
});

// ───────────────────────── 7 · CS: unreviewed program placements carry over; the spot-check reaches the placement reasons ─────────────────────────

/**
 * Forge after its first usable round: the program placed as the main agent entered reconcile, the main agent confirmed
 * one placement (AB → P1) and wrote four reasons (AC in no plan; D4, D5 and a design on the whole product), and the round
 * closed.
 * Round 2 is a deepening in its cross-check, with a main job and a spot-check job of its own.
 */
async function forgeSecondRound() {
  const b = await forgeBench();
  await b.ok('pk_stage', { to: 'reconcile' });
  await b.ok('pk_write_thread', { id: 'AB', serves: [{ referenceId: b.ids.p1, claim: 'checked against the archived plan, row B2', basis: 'Explicit' }] });
  await b.ok('pk_write_thread', { id: 'AC', noPlanWhy: 'The index lists it with no plan; no prompt, no contract, no decision names it.' });
  await b.ok('pk_write_reference', { id: b.refBy('D4', 'Decision').id, wholeProductWhy: 'The cut tries the whole blade.' });
  await b.ok('pk_write_reference', { id: b.refBy('D5', 'Decision').id, wholeProductWhy: 'Every station of the forge uses the same tongs.' });
  const floor = (await b.ok('pk_write_reference', { category: 'Design', name: 'The forge floor', text: 'Where every station stands.', basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [b.src('docs/PRD.md', '4 · Modules')], refines: [b.ids.product], wholeProductWhy: 'The floor plan holds every station.' })).id as string;
  const LATER = '2026-10-02T10:00:00.000Z';
  b.store.clerkRounds.put({ ...b.store.clerkRounds.get('round_1')!, status: 'Done', endedAt: '2026-10-01T12:00:00.000Z' });
  b.store.clerkRounds.put({ ...round(forge.project.id, 'Deepen', 'cross-check'), id: 'round_2', number: 2, startedAt: LATER, updatedAt: LATER, rootJobId: 'job_root_2', stageLog: [{ stage: 'cross-check', startedAt: LATER, endedAt: null, timing: null }] });
  const main = b.as('job_main_2', { roundId: 'round_2', kind: 'main', path: null });
  const spot = b.as('job_spot_2', { roundId: 'round_2', kind: 'spot-check', path: null });
  const records = (roundId = 'round_1') => b.store.clerkRounds.get(roundId)!.inferredPlacements ?? [];
  const record = (name: string, target: string) => records().find((p) => p.name.startsWith(name) && p.target === target)!;
  const listed = async () => (await main.ok('pk_round_state', { list: 'inferredPlacements' })).items as { id: string; name: string; placedOn: string; round: string; stage: string; result: string; chain: string }[];
  const targets = (roundId: string, size = 24) => { const l = b.ledger(); try { return spotCheckTargets(b.store, { id: roundId }, size, l); } finally { l.close(); } };
  return { ...b, main, spot, records, record, listed, targets, floor };
}

test('a program placement with no result is listed and counted in the next round; a result written there lands on the record of the round that placed it; one a write took off its item is recorded as moved', async () => {
  const b = await forgeSecondRound();
  const placed = b.records().length;
  assert.ok(placed >= 9, `${placed} placements in round 1`);
  assert.equal(b.records('round_2').length, 0, 'round 2 placed nothing itself');
  // Round 2 lists what round 1 left: every placement but the one confirmed there, each with the round and stage that placed it.
  const rows = await b.listed();
  assert.equal(rows.length, placed - 1);
  assert.ok(rows.every((r) => r.round === 'First usable round 1' && r.stage === 'reconcile' && r.result === 'left' && r.chain.length > 0), JSON.stringify(rows[0]));
  assert.ok(rows.some((r) => r.name.startsWith('AD') && r.placedOn === 'P1'));
  assert.ok(!rows.some((r) => r.name.startsWith('AB') && r.placedOn === 'P1'), 'the one confirmed in round 1 is not listed');
  let state = await b.main.ok('pk_round_state', {});
  assert.equal((state.open as Record<string, number>).inferredPlacements, placed - 1);
  assert.deepEqual(state.programPlacements, { placed, confirmed: 1, moved: 0, unreviewed: placed - 1 });
  // A write of round 2 moves one: the result is on round 1's record, says which round gave it, and shows in round 2's trace.
  const over = await b.main.ok('pk_write_thread', { id: 'AE', replaceServes: true, serves: [{ referenceId: 'P1', claim: 'the owner moved the rack into the first blade', basis: 'Explicit' }] });
  assert.deepEqual((over.replacedInferred as string[]).map((s) => s.split(' (')[0]), ['FG-M1', 'P2']);
  const ae = b.record('AE', 'P2').result!;
  assert.deepEqual([ae.kind, ae.to, ae.roundId, ae.by], ['moved', 'P1', 'round_2', 'write']);
  const traced = b.store.traceByJob('job_main_2', 1000).filter((e) => e.collection === 'clerkRounds' && e.id === 'round_1');
  assert.match(traced.map((e) => e.summary).join('\n'), /Program placements of First usable round 1, by a write: AE[^\n]* on FG-M1: moved to P1; AE[^\n]* on P2: moved to P1/);
  // A write of round 2 confirms one by making it its own.
  await b.main.ok('pk_write_reference', { id: b.refBy('E1', 'Decision').id, refines: [b.ids.p1] });
  assert.deepEqual([b.record('E1', 'P1').result?.kind, b.record('E1', 'P1').result?.roundId], ['confirmed', 'round_2']);
  // A writer that does not report replaces one (E3 goes to K): it is counted as moved at once, and the program records it on round 1 as it next counts.
  const e3 = b.refBy('E3', 'Decision');
  b.store.reference.put({ ...e3, refines: [b.ids.k] });
  assert.ok(!(await b.listed()).some((r) => r.name.startsWith('E3')), 'a replaced placement is not listed');
  assert.equal(b.record('E3', 'P1').result ?? null, null, 'not recorded yet');
  state = await b.main.ok('pk_round_state', {});
  const moved = b.record('E3', 'P1').result!;
  assert.deepEqual([moved.kind, moved.to, moved.roundId, moved.by], ['moved', 'K', 'round_2', 'program']);
  assert.deepEqual(state.programPlacements, { placed, confirmed: 2, moved: 3, unreviewed: placed - 5 });
  assert.equal((await b.listed()).length, placed - 5, 'the list shrinks with each result');
  // The handover note and, through the synthesis' task, the Result: counts, not lists.
  const l = b.ledger();
  try {
    const note = unplacedNote(roundOpen(b.store, b.store.clerkRounds.get('round_2')!, { ledger: l }))!;
    assert.match(note, new RegExp(`${placed} placements the program wrote from the records in all \\(basis Inferred\\): 2 confirmed, 3 moved, ${placed - 5} not reviewed yet \\(they stand as placed; pk_round_state \\{ list: "inferredPlacements" \\} lists them, whichever round placed them\\)`));
    // Nothing is refused on them, and the program does not write again what a model moved away from.
    assert.equal(placeByProgram(b.store, l, { id: 'round_2' }, 'job_main_2', 'cross-check').placed.length, 0);
  } finally { l.close(); }
  assert.deepEqual(b.refBy('E3', 'Decision').refines, [b.ids.k]);
});

test('the spot-check of a later round is given every standing reason no spot-check has checked, whichever round wrote it, and at least five of the program’s unreviewed placements; its record counts them apart and settles them', async () => {
  const b = await forgeSecondRound();
  const d4 = b.refBy('D4', 'Decision').id;
  const d5 = b.refBy('D5', 'Decision').id;
  const ac = b.byNumber('AC').id;
  // Round 2 wrote four heavier judgements of its own (claims about the code): without the floor they crowd the placements out.
  for (const n of ['FGC-01', 'FGC-02', 'FGC-03', 'FGC-04']) b.store.threads.put({ ...b.byNumber(n), updatedAt: AT }, { jobId: 'job_main_2', basisSourceIds: [], summary: `Work thread updated: ${n} — the residual code file is deleted` });
  const unreviewed = await b.listed();
  const items = [...new Set(unreviewed.map((r) => r.id))];
  assert.ok(items.length > 5, `${items.length} items carry an unreviewed program placement`);
  // The reasons written in round 1 — which had no spot-check — are checked in full in round 2.
  const all = b.targets('round_2');
  // A design on the whole product carries the same kind of reason as a decision: it is checked like one.
  assert.deepEqual(all.reasons.map((r) => [r.collection, r.id, r.field]).sort(), [['reference', d4, 'wholeProductWhy'], ['reference', d5, 'wholeProductWhy'], ['reference', b.floor, 'wholeProductWhy'], ['threads', ac, 'noPlanWhy']].sort());
  assert.match(all.full.find((t) => t.id === b.floor)!.summary, /^Design The forge floor written on the whole product — “The floor plan holds every station\.”/);
  assert.match(all.full.find((t) => t.id === d5)!.summary, /written on the whole product — “Every station of the forge uses the same tongs\.”; the records the program's trace names:/);
  assert.match(all.full.find((t) => t.id === ac)!.summary, /work item AC .* written as no plan — /);
  assert.equal(all.placementsUnreviewed, unreviewed.length);
  assert.equal(all.placements.length, unreviewed.length, 'a sample with room holds them all');
  assert.match(all.sample[0]!.summary, /placed by the program \(Inferred\) on \S+ — .* \(First usable round 1, entering reconcile; not reviewed since\)/);
  // The floor: with room for eight, five are the program's placements although four of this round's writes weigh more.
  const tight = b.targets('round_2', 8);
  const isPlacement = (t: { summary: string }) => /placed by the program \(Inferred\)/.test(t.summary);
  assert.equal(tight.sample.length, 8);
  assert.equal(tight.sample.filter(isPlacement).length, 5);
  assert.equal(tight.sample.filter((t) => !isPlacement(t)).length, 3);
  assert.equal(new Set(tight.placements.map((p) => p.id)).size, 5);
  // With fewer than five, all of them.
  assert.equal(b.targets('round_2', 3).sample.filter(isPlacement).length, 3, 'a sample smaller than the floor is all placements');
  assert.match(spotCheckBlock(b.store, all), new RegExp(`wholeProductWhy: 4 on 4 items\\), each with the records the program's trace names[^\\n]*\\n[\\s\\S]*=== The sample \\(\\d+ of \\d+ other judgements: what this round wrote, and the program's ${unreviewed.length} Inferred placements nobody has reviewed yet, of this round and earlier ones — ${unreviewed.length} of them in the sample\\)`));

  // The spot-check starts: what it is given is fixed on the round (clerk.ts `startSpotCheck`).
  b.store.clerkRounds.put({ ...b.store.clerkRounds.get('round_2')!, placementCheck: { at: AT, reasons: all.reasons, placements: all.placements } });
  // It finds D5's reason right, D4's wrong and leaves it, AC's wrong and corrects it: the item is placed and the reason cleared, then recorded.
  await b.spot.ok('pk_write_thread', { id: 'AC', noPlanWhy: null, serves: [{ referenceId: 'K', claim: 'the tongs are kept in order with the forge', basis: 'Explicit' }] });
  const first = await b.spot.ok('pk_record_spot_check', { checked: [
    { target: { collection: 'reference', id: d5 }, kind: 'placement reason', verdict: 'Right' },
    { target: { collection: 'threads', id: ac }, kind: 'placement reason', verdict: 'Wrong', correction: 'placed on K, the reason cleared' },
  ] });
  assert.deepEqual((first.spotCheck as { placement: unknown }).placement, { reasons: 4, reasonsChecked: 2, reasonsWrong: 1, programPlacementsSampled: 0, programPlacementsWrong: 0 });
  assert.match(String(first.note), /2 of the 4 reasons that leave an item unplaced \(noPlanWhy, noAreaWhy, wholeProductWhy\) are not recorded yet/);
  // Then D4 and the design, and three of the placements: AD and AG right, AF (its module and its plan) wrong and left.
  const second = await b.spot.ok('pk_record_spot_check', { checked: [
    { target: { collection: 'reference', id: d4 }, kind: 'placement reason', verdict: 'Wrong' },
    { target: { collection: 'reference', id: b.floor }, kind: 'placement reason', verdict: 'Right' },
    { target: { collection: 'threads', id: b.byNumber('AD').id }, kind: 'program placement', verdict: 'Right' },
    { target: { collection: 'threads', id: b.byNumber('AG').id }, kind: 'program placement', verdict: 'Right' },
    { target: { collection: 'threads', id: b.byNumber('AF').id }, kind: 'program placement', verdict: 'Wrong' },
  ] });
  assert.deepEqual((second.spotCheck as { placement: unknown }).placement, { reasons: 4, reasonsChecked: 4, reasonsWrong: 2, programPlacementsSampled: 4, programPlacementsWrong: 2 });
  assert.equal(second.note, undefined);
  const r2 = b.store.clerkRounds.get('round_2')!;
  assert.deepEqual(r2.spotCheck!.placement, { reasons: 4, reasonsChecked: 4, reasonsWrong: 2, programPlacementsSampled: 4, programPlacementsWrong: 2 });
  assert.deepEqual(r2.spotCheck!.reasonChecks!.map((c) => [c.id, c.field, c.wrong]).sort(), [[ac, 'noPlanWhy', true], [d4, 'wholeProductWhy', true], [d5, 'wholeProductWhy', false], [b.floor, 'wholeProductWhy', false]].sort());
  assert.equal(r2.spotCheck!.reasonChecks!.find((c) => c.id === d5)!.reason, 'Every station of the forge uses the same tongs.');
  assert.equal(placementLine(r2.spotCheck!.placement!), 'placement: 4 of 4 reasons for leaving an item unplaced checked · 2 wrong; 4 program placements sampled · 2 wrong');
  // A placement the spot-check found right has its result, on round 1's record; the one found wrong and left stays listed.
  const ad = b.record('AD', 'P1').result!;
  assert.deepEqual([ad.kind, ad.roundId, ad.by], ['confirmed', 'round_2', 'spot-check']);
  assert.equal(b.record('AG', 'P1').result?.by, 'spot-check');
  assert.equal(b.record('AF', 'P1').result ?? null, null);
  const after = await b.listed();
  assert.ok(after.some((r) => r.name.startsWith('AF')) && !after.some((r) => r.name.startsWith('AD') || r.name.startsWith('AG')), after.map((r) => r.name.slice(0, 2)).join(','));
  assert.equal(after.length, unreviewed.length - 2);

  // Round 3: a reason checked once and unchanged is not a target again; one found wrong and still standing is; one that changed is.
  b.store.clerkRounds.put({ ...r2, status: 'Done', endedAt: '2026-10-02T12:00:00.000Z' });
  b.store.clerkRounds.put({ ...round(forge.project.id, 'Follow up', 'cross-check'), id: 'round_3', number: 3, startedAt: '2026-10-03T10:00:00.000Z', rootJobId: 'job_root_3' });
  let third = b.targets('round_3');
  assert.deepEqual(third.reasons.map((r) => r.id), [d4], 'D5 and the design were found right and have not changed; AC is placed; D4 was found wrong and still stands');
  assert.match(third.full.find((t) => t.id === d4)!.summary, /the spot-check of Deepen round 2 found it wrong, and it still stands$/);
  assert.ok(!third.full.some((t) => t.id === d5 || t.id === ac));
  assert.ok(!third.sample.some((t) => t.id === b.byNumber('AD').id), 'a placement the spot-check confirmed is not sampled again');
  assert.ok(third.sample.some((t) => t.id === b.byNumber('AF').id));
  await b.main.ok('pk_write_reference', { id: d5, wholeProductWhy: 'The tongs are one tool for the whole forge, by the owner’s word.' });
  third = b.targets('round_3');
  assert.deepEqual(third.reasons.map((r) => r.id).sort(), [d4, d5].sort(), 'a reason that changed is a target again');
});
