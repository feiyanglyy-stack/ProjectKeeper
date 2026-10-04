/**
 * CM (E151): the program carries the lists and the checks, the model keeps the judgements — on "Loom", an invented
 * project with a PRD whose module table has a cross-cutting foundation (底座), a Spec, a plan with a contract table, a
 * decision record, a ticket index and an archived first plan.
 *
 *   A · compact asset dumps, and Areas read as Areas (the round-state lists are in round-open.test.ts, the owner's lines
 *       in owner-lines.test.ts and stage-lanes.test.ts);
 *   B · a run of numbered items placed in one call; reports and prompts the workbench cites marked before coverage; the
 *       candidates recomputed entering the synthesis (links in cj-gates.test.ts, ranges in ledger/ranges.test.ts,
 *       Downstream behind in process/downstream-dated.test.ts);
 *   C · every item of a generation has a destination; candidate generations accepted or rejected; replacedBy by number;
 *   D · the foundation Area: the short form in a Module column names it, and everything naming it is placed again when it
 *       is created; designs cut too wide or placed nowhere are flagged; a Product-only decision is traced through its own
 *       entry and through the documents that cite it; a whole-product decision carries its reason.
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
import { keeperTools, READ_PAGE } from '../tools.ts';
import { clerkTools, type ClerkToolContext } from '../clerk-tools.ts';
import { stageTools, recomputesCandidates } from './stage-tools.ts';
import { entryGateTools } from './entry-gate.ts';
import { placeTools, numbersIn } from './place-tools.ts';
import { roundOpen } from './round-open.ts';
import { areaByWrittenName, areaNames, itemsNaming, taggedWith } from './placing.ts';
import { archiveRootOf, generationCandidates, itemsWithoutDestination } from './generation-check.ts';
import { citedMaterials, type CoverageItem } from './coverage-tools.ts';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-cm-'));
after(() => { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const AT = '2026-09-30T10:00:00.000Z';

// ───────────────────────── the project and its ledger ─────────────────────────

const repo = join(scratch, 'loom');
mkdirSync(repo);
const git = (args: string[], date = '2026-09-01T12:00:00Z'): string => execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 'Loom', GIT_AUTHOR_EMAIL: 'l@loom.invalid', GIT_COMMITTER_NAME: 'Loom', GIT_COMMITTER_EMAIL: 'l@loom.invalid' }, windowsHide: true,
}).trim();
const files: Record<string, string> = {};
const write = (rel: string, text: string) => { files[rel] = text; const full = join(repo, rel); mkdirSync(resolve(full, '..'), { recursive: true }); writeFileSync(full, text); };
const commit = (message: string, date: string) => { git(['add', '-A'], date); git(['commit', '-q', '-m', message], date); return git(['rev-parse', 'HEAD']); };

git(['init', '-q', '-b', 'main']);
git(['config', 'core.autocrlf', 'false']);
write('archive/v1/PLAN.md', ['# Plan v1', '', '| ID | Task |', '| --- | --- |', '| LT-01 | Hand loom |', '| LT-02 | Hand dye |', '| LT-03 | Hand press |', ''].join('\n'));
write('old/roadmap.md', ['# Roadmap notes', '', 'Ideas kept for reference.', ''].join('\n'));
const ARCHIVED = commit('Set the first plan aside', '2026-08-20T12:00:00Z');
write('docs/PRD.md', [
  '# Loom PRD', '', '## 4 · Modules', '',
  '| Module | Effect |', '| --- | --- |', '| LM-M1 · Weave | cloth is woven |', '| LM-M2 · Dye | cloth is dyed |', '| 底座 · Runtime and assets | every module runs on it |', '',
  '## 6 · Requirements', '', '### LM-M1 · Weave', '',
  '| ID | Requirement | Basis |', '| --- | --- | --- |', '| R-01 | The loom weaves plain cloth | D2 |', '| R-02 | The weave is shown as it grows | D2 |', '| R-03 | A broken thread stops the loom | D2 |', '',
  '### 底座 · Runtime and assets', '',
  '| ID | Requirement | Basis |', '| --- | --- | --- |', '| R-10 | One runtime runs every module | D4 |', '| R-11 | The pattern files stay in the project | D4 |', '| R-12 | The runtime says what it can do | D4 |', '',
  '### General quality', '',
  '| ID | Requirement | Basis |', '| --- | --- | --- |', '| R-20 | The same panel on every loom | D1 |', '',
].join('\n'));
write('docs/PLAN.md', [
  '# Loom plan', '', '## 3 · Increments', '', '### P1 · First cloth', '', 'Weave and dye one bolt.', '', '### P2 · Many looms', '', 'Run ten looms.', '',
  '## 7 · Contracts', '',
  '| ID | Contract | Increment | Module | Status |', '| --- | --- | --- | --- | --- |',
  '| LMC-01 | The weave | P1 | LM-M1 | ready |', '| LMC-02 | The dye | P1 | LM-M2 | ready |', '| LMC-03 | The runtime | P1 | 底座 | ready |', '| LMC-04 | The assets | P2 | 底座 | draft |', '',
].join('\n'));
write('docs/DECISIONS.md', [
  '# Decisions', '',
  '**D1 · The same panel on every loom.** No loom gets a panel of its own.', '',
  '**D2 · Weave before dye.** 影响：LMC-01。', '',
  '**D3 · Dye in vats.** 影响：LMC-02。', '',
  '**D4 · One runtime, pluggable later.** The owner: 「一个 runtime」.', '',
  '**D5 · The trial runs on one bolt first.** 影响：增量 P1 的试验安排。', '',
  '**D6 · The runtime says what it can do.** 影响：LMC-03、R-12。', '',
].join('\n'));
write('subagent/INDEX.md', ['# Index', '', '## Tickets', '', '| ID | Executor | Prompt |', '| --- | --- | --- |', '| AA | kimi | AA-weave.md |', '| AB | claude | AB-runtime.md |', '| AC | sol | AC-qc.md |', ''].join('\n'));
const prompt = (id: string, title: string) => `---\nid: "${id}"\nexecutor: "claude"\nstatus: "done"\n---\n\n# ${id} · ${title}\n\nDo it.\n`;
write('subagent/AA-weave.md', prompt('AA', 'The weave'));
write('subagent/AB-runtime.md', prompt('AB', 'The runtime'));
write('subagent/AC-qc.md', prompt('AC', 'QC of the runtime'));
write('subagent/reports/AC-report.md', '# AC report\n\n结论：pass\n');
write('subagent/reports/visit-notes.md', '# Visit notes\n\nThe mill was loud.\n');
commit('Plan the loom', '2026-09-01T12:00:00Z');

const scope = { id: 'scope_loom', path: repo, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null,
  readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as unknown as ScopeItem;
const project = { id: 'loom', name: 'Loom', locations: [repo], scope: [scope], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en',
  organizingPaused: false, createdAt: AT, lastOpenedAt: null, lastScopedAt: null, takeoverDepth: 'Full' } as unknown as Project;
const baseHome = mkdtempSync(join(scratch, 'home-'));
rebuildLedgerInPlace(ledgerPath(project.id, baseHome), project);

const LAYERS: [string, LayerEntry['layer'], boolean][] = [
  ['docs/PRD.md', 'PRD', true], ['docs/PLAN.md', 'Plan', true], ['docs/DECISIONS.md', 'Decision record', true], ['subagent/INDEX.md', 'Task index', true],
  ['subagent/reports', 'QC and receipts', true], ['archive/v1/PLAN.md', 'Plan', false],
];

/** A document's sources as the scan cuts them: one per heading's section, with its heading path. */
function sectionSources(rel: string, text: string): Source[] {
  const lines = text.split('\n');
  const heads = lines.flatMap((l, i) => { const m = /^(#{1,6})\s+(.*)$/.exec(l); return m ? [{ line: i + 1, level: m[1]!.length, text: m[2]!.trim() }] : []; });
  const out: Source[] = [];
  const stack: { level: number; text: string }[] = [];
  heads.forEach((h, k) => {
    while (stack.length && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push({ level: h.level, text: h.text });
    const end = (heads[k + 1]?.line ?? lines.length + 1) - 1;
    out.push({
      id: `src_${rel.replace(/\W/g, '_')}_${h.line}`, projectId: project.id, title: h.text, anchor: { kind: 'file', path: join(repo, ...rel.split('/')), headingPath: stack.map((s) => s.text), lineStart: h.line, lineEnd: end },
      ids: [], version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt: lines.slice(h.line - 1, end).join('\n'), usedAs: 'Design', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: scope.id, hasCredential: false, bytes: 10,
    } as unknown as Source);
  });
  return out;
}

function round(kind: RoundKind, stage: ClerkStage): ClerkRound {
  return {
    id: 'round_1', projectId: project.id, kind, number: 1, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root',
    questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT,
    stage, stageLog: [{ stage, startedAt: AT, endedAt: null, timing: null }], lanes: [],
  } as ClerkRound;
}

type Called = { text: string; error: boolean; json: Record<string, unknown> };

/** A workbench on Loom as a first round leaves it before the foundation Area exists: modules, plans, requirements, contracts, tickets, decisions. */
async function bench(kind: RoundKind = 'First usable', stage: ClerkStage = 'reconcile') {
  const home = mkdtempSync(join(scratch, 'bench-'));
  const store = ProjectStore.open(project.id, home);
  const wanted = stage;
  stage = 'reconcile';   // the workbench is built in reconcile; the round is put in the stage asked for at the end
  copyFileSync(ledgerPath(project.id, baseHome), join(store.dir, 'ledger.sqlite'));
  for (const [path, layer, current] of LAYERS) store.layers.put({ id: `layer_${path}`, projectId: project.id, repo, path, layer, note: null, current, roundId: null, updatedAt: AT });
  for (const [rel, text] of Object.entries(files)) for (const s of sectionSources(rel, text)) store.sources.put(s);
  store.clerkRounds.put(round(kind, stage));
  const ctx = { store, project, jobId: 'job_main', jobKind: 'Organizing', model: null, step: { roundId: 'round_1', kind: 'main', path: null }, stageEntered: () => ({ note: null }) } as unknown as ClerkToolContext;
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
  const ledger = () => Ledger.openDir(store.dir)!;
  const src = (rel: string, heading: string) => store.sources.find((s) => s.anchor.kind === 'file' && s.anchor.path.replace(/\\/g, '/').endsWith(rel) && s.title === heading)!.id;
  const ref = (category: string, name: string, extra: Record<string, unknown> = {}) => ok('pk_write_reference', { category, name, text: name, basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [src('docs/PRD.md', '4 · Modules')], ...extra });
  const byNumber = (n: string) => store.threads.find((t) => t.ids.includes(n))!;
  const refBy = (n: string, category?: string) => store.reference.find((r) => r.ids.includes(n) && (!category || r.category === category))!;

  const product = (await ref('Product', 'Loom')).id as string;
  const goal = (await ref('Goal', 'Cloth without waste', { refines: [product] })).id as string;
  const m1 = (await ref('Area', 'LM-M1 · Weave', { ids: ['LM-M1'], refines: [goal] })).id as string;
  const m2 = (await ref('Area', 'LM-M2 · Dye', { ids: ['LM-M2'], refines: [goal] })).id as string;
  const p1 = (await ref('Plan', 'P1 · First cloth', { ids: ['P1'], refines: [product], sourceIds: [src('docs/PLAN.md', 'P1 · First cloth')] })).id as string;
  await ref('Plan', 'P2 · Many looms', { ids: ['P2'], refines: [product], sourceIds: [src('docs/PLAN.md', 'P2 · Many looms')] });
  for (const h of ['LM-M1 · Weave', '底座 · Runtime and assets', 'General quality']) await ok('pk_fill_from_table', { path: 'docs/PRD.md', table: { heading: h }, into: 'reference', category: 'Requirement', columns: { title: 'Requirement', id: 'ID' } });
  // The module's own requirements were placed by the lane; the foundation's group and the quality group went to the product.
  await ok('pk_place_range', { numbers: 'R-01–R-03', to: 'LM-M1' });
  for (const n of ['R-10', 'R-11', 'R-12', 'R-20']) await ok('pk_write_reference', { id: refBy(n).id, refines: [product] });
  const contracts = await ok('pk_fill_from_table', { path: 'docs/PLAN.md', table: { heading: 'Contracts' }, into: 'threads', category: 'Requirement', columns: { title: 'Contract', id: 'ID', parent: 'Module', plan: 'Increment', status: 'Status' } });
  await ok('pk_fill_from_table', { path: 'subagent/INDEX.md', table: { heading: 'Tickets' }, into: 'threads', columns: { title: 'Prompt', id: 'ID' } });
  await ok('pk_write_thread', { id: 'AB', implements: ['LMC-03'], serves: [{ referenceId: m2, claim: 'the lane guessed', basis: 'Inferred' }, { referenceId: p1, claim: 'INDEX', basis: 'Explicit' }] });
  await ok('pk_fill_from_bold', { path: 'docs/DECISIONS.md', category: 'Decision' });
  for (const n of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']) await ok('pk_write_reference', { id: refBy(n, 'Decision').id, refines: [product] });
  const design = (name: string, heading: string, refines: string[]) => ref('Design', name, { sourceIds: [src('docs/PRD.md', heading)], refines });
  setStage(wanted);
  return { store, call, ok, setStage, ledger, ref, design, byNumber, refBy, src, ids: { product, goal, m1, m2, p1 }, contracts };
}

// ───────────────────────── D · the foundation Area ─────────────────────────

test('an Area’s names: its short form names it in a Module column; a name is tagged only by a bracket of area names', () => {
  const area = { name: '底座 · Runtime and assets', ids: [] as string[] };
  assert.deepEqual(areaNames(area), ['底座 · Runtime and assets', '底座']);
  assert.deepEqual(areaNames({ name: 'LM-M1 · Weave', ids: ['LM-M1'] }), ['LM-M1 · Weave', 'LM-M1']);
  const areas = [{ id: 'a', category: 'Area', name: '底座 · Runtime and assets', ids: [] }, { id: 'b', category: 'Area', name: 'LM-M1 · Weave', ids: ['LM-M1'] }] as never[];
  assert.equal((areaByWrittenName(areas, '底座') as { id: string } | null)?.id, 'a', 'the short form (D101)');
  assert.equal((areaByWrittenName(areas, 'lm-m1') as { id: string } | null)?.id, 'b');
  assert.equal(areaByWrittenName(areas, 'Runtime'), null, 'a word of the name is not its short form');
  assert.equal(taggedWith('Spec §8 · Runtime（底座）', ['底座']), true);
  assert.equal(taggedWith('Dyeing (LM-M2、LM-M1)', ['LM-M1']), true);
  assert.equal(taggedWith('The runtime is the 底座 of every module', ['底座']), false, 'a mention in a sentence is not a tag');
});

test('a foundation Area created mid-round: everything that names it is placed again in the same call, and the short form resolves from then on (D101)', async () => {
  const b = await bench();
  // Before it exists the contract table's Module 「底座」 names nothing, and the contracts sit under their plan alone.
  assert.deepEqual((b.contracts.unlinked as { value: string }[]).map((u) => u.value), ['底座', '底座']);
  await b.design('Spec §8 · Runtime（底座）', '6 · Requirements', []);
  const made = await b.ok('pk_write_reference', { category: 'Area', name: '底座 · Runtime and assets', text: 'What every module runs on.', basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [b.src('docs/PRD.md', '4 · Modules')], refines: [b.ids.goal], foundation: true });
  const area = made.id as string;
  assert.equal(b.store.reference.get(area)!.foundation, true);
  const placed = (made.placedAgain as { count: number; items: string[] }).items.join('\n');
  // Its requirement group (the heading), the Spec chapter tagged with it, the contracts whose row writes it (the reference
  // item and the work item), the ticket implementing one, the decision whose entry names them.
  for (const want of [/R-10 .* — it stands under the heading “底座 · Runtime and assets”/, /R-12 /, /Spec §8 · Runtime（底座） — its name is tagged with 底座/, /LMC-03 · The runtime — its row writes Module: 底座/, /LMC-03 The runtime — its contract row writes Module: 底座/, /LMC-04 The assets — its contract row/, /AB-runtime\.md — it implements LMC-03/, /D6 · The runtime says what it can do\. — its entry names LMC-03, R-12/]) assert.match(placed, want);
  assert.doesNotMatch(placed, /R-20|R-01|LMC-01|D4 ·/, 'the quality group, the other module and a decision that names nothing are left');
  assert.ok(b.refBy('R-10').refines.includes(area) && b.refBy('D6', 'Decision').refines.includes(area));
  // The contract's main area is the foundation: first among what it serves; the ticket that implements only it, too.
  assert.equal(b.byNumber('LMC-03').serves[0]!.referenceId, area);
  assert.deepEqual(b.byNumber('AB').serves.map((s) => s.referenceId).slice(0, 2), [area, b.ids.m2], 'solid in the foundation column, a dashed copy where it sat');
  const open = roundOpen(b.store, b.store.clerkRounds.get('round_1')!);
  assert.deepEqual(open.misplaced.items.map((m) => [m.name.split(' ')[0], m.area.split(' ')[0]]), [['D2', 'LM-M1'], ['D3', 'LM-M2']], 'nothing names the foundation and sits elsewhere any more; two decisions on the Product still name a module’s contract');
  // From now on the short form resolves in the table, and running it again leaves nothing unlinked.
  const again = await b.ok('pk_fill_from_table', { path: 'docs/PLAN.md', table: { heading: 'Contracts' }, into: 'threads', category: 'Requirement', columns: { title: 'Contract', id: 'ID', parent: 'Module', plan: 'Increment', status: 'Status' } });
  assert.equal(again.unlinked, undefined);
  assert.match((await b.call('pk_write_reference', { id: b.refBy('R-20').id, foundation: true })).text, /foundation marks an Area/);
});

test('open lists what names an Area in the project’s own writing and sits elsewhere, until it is placed', async () => {
  const b = await bench();
  // An Area written without the pass having anything to place (as the gated run's was: by a store write of an earlier build).
  b.store.reference.put({ ...b.store.reference.get(b.ids.m2)!, id: 'ref_base', name: '底座 · Runtime and assets', ids: [] });
  const named = itemsNaming(b.store, b.store.reference.get('ref_base')!);
  assert.deepEqual(named.filter((n) => !n.placed).map((n) => n.name.split(' ')[0]).sort(), ['AB-runtime.md', 'D6', 'LMC-03', 'LMC-03', 'LMC-04', 'LMC-04', 'R-10', 'R-11', 'R-12']);
  const open = roundOpen(b.store, b.store.clerkRounds.get('round_1')!);
  assert.equal(open.misplaced.count, 11, 'and D2, D3, whose entries name the two modules’ contracts');
  const lmc = open.misplaced.items.find((m) => m.name.startsWith('LMC-03') && /contract row/.test(m.how))!;
  assert.deepEqual([lmc.area, lmc.sits], ['底座 · Runtime and assets', 'no area']);
  const state = await b.call('pk_round_state', { list: 'misplaced' });
  assert.equal(state.json.count, 11);
});

// ───────────────────────── D · designs and Product-only decisions ─────────────────────────

test('a design cut across three areas, and one placed nowhere, are flagged; a whole-product item carries its reason', async () => {
  const b = await bench();
  const area = (await b.ref('Area', '底座 · Runtime and assets', { refines: [b.ids.goal], foundation: true })).id as string;
  const wide = (await b.design('Spec §1 · Common objects', '6 · Requirements', [b.ids.m1, b.ids.m2, area])).id as string;
  await b.design('Spec §2.1 · Vats', 'LM-M1 · Weave', [b.ids.m2]);
  const errors = (await b.design('Spec §9 · Errors', 'General quality', [b.ids.product])).id as string;
  const open = () => roundOpen(b.store, b.store.clerkRounds.get('round_1')!);
  assert.deepEqual(open().designs.wide.items.map((d) => [d.id, d.areas]), [[wide, ['LM-M1', 'LM-M2', '底座']]]);
  assert.deepEqual(open().designs.unplaced.items.map((d) => d.id), [errors], 'on the Product alone is no placement');
  // Conventions that own no work stay in the ring, with why: then they are placed.
  await b.ok('pk_write_reference', { id: errors, wholeProductWhy: 'Every module handles a broken thread the same way; no area owns it.' });
  assert.equal(open().designs.unplaced.count, 0);
  assert.equal(b.store.reference.get(errors)!.wholeProductWhy, 'Every module handles a broken thread the same way; no area owns it.');
  assert.match((await b.call('pk_write_reference', { id: area, wholeProductWhy: 'x' })).text, /a Area is not placed that way/);
});

test('a decision placed only on the Product is traced through its own entry — a contract, a plan — and through the documents that cite it', async () => {
  const b = await bench();
  const area = (await b.ref('Area', '底座 · Runtime and assets', { refines: [b.ids.goal], foundation: true })).id as string;
  void area;
  const l = b.ledger();
  let open: ReturnType<typeof roundOpen>;
  try { open = roundOpen(b.store, b.store.clerkRounds.get('round_1')!, { ledger: l }); } finally { l.close(); }
  const t = new Map(open.decisions.traceable.items.map((d) => [d.name.split(' ')[0], d]));
  // D6 was placed with the foundation (its entry names LMC-03 and R-12); the rest sit on the Product. D1 traces nowhere:
  // its entry names nothing, and the one requirement that cites it (R-20, general quality) sits on the Product too.
  assert.deepEqual([...t.keys()].sort(), ['D2', 'D3', 'D4', 'D5']);
  assert.deepEqual(open.decisions.productOnly.items.map((d) => d.name.split(' ')[0]).sort(), ['D1', 'D2', 'D3', 'D4', 'D5']);
  assert.deepEqual([t.get('D2')!.names, t.get('D2')!.suggest[0]], [['LMC-01'], 'LM-M1 ×4'], 'its entry names the contract, and the requirements that cite it sit in LM-M1');
  // D4 names nothing itself: the PRD's foundation group cites it (R-10, R-11, R-12 「D4」).
  assert.deepEqual(t.get('D4')!.names, []);
  assert.equal(t.get('D4')!.suggest[0], '底座 ×3');
  assert.match(t.get('D4')!.cited[0]!, /^docs\/PRD\.md:\d+ → R-10.* \(底座\)$/);
  // D5 sets a trial arrangement: its entry names the plan it shapes.
  assert.deepEqual([t.get('D5')!.names, t.get('D5')!.suggest], [['P1'], ['P1 (plan) ×1']]);
  // D1 concerns the whole product: written with its reason, it is placed in the ring.
  await b.ok('pk_write_reference', { id: b.refBy('D1', 'Decision').id, wholeProductWhy: 'One panel for every loom: it binds every module alike.' });
  assert.deepEqual(roundOpen(b.store, b.store.clerkRounds.get('round_1')!).decisions.productOnly.items.map((d) => d.name.split(' ')[0]).sort(), ['D2', 'D3', 'D4', 'D5'], 'with its reason it is placed, in the ring');
});

// ───────────────────────── B · placement in bulk ─────────────────────────

test('pk_place_range places a run of numbered items in one call: decisions refine, work items serve; what no item carries comes back', async () => {
  const b = await bench();
  assert.deepEqual(numbersIn('E1–E3, D12、CKC-03～05 and AA'), ['E1', 'E2', 'E3', 'D12', 'CKC-03', 'CKC-04', 'CKC-05', 'AA']);
  const placed = await b.ok('pk_place_range', { numbers: 'D2–D6, D9', to: 'P1', category: 'Decision' });
  assert.deepEqual([placed.placed, placed.already, placed.missing], [5, 0, ['D9']]);
  assert.ok(b.refBy('D3', 'Decision').refines.includes(b.ids.p1) && b.refBy('D3', 'Decision').refines.includes(b.ids.product), 'what it refined stays');
  assert.equal((await b.ok('pk_place_range', { numbers: 'D2–D6', to: 'P1', category: 'Decision' })).already, 5);
  const tickets = await b.ok('pk_place_range', { numbers: 'AA, AB, AC', to: 'LM-M1', only: 'threads', claim: 'INDEX: the weave line' });
  assert.equal(tickets.placed, 3);
  assert.deepEqual(b.byNumber('AA').serves.map((s) => s.referenceId), [b.ids.m1]);
  assert.deepEqual(b.byNumber('AB').serves.map((s) => s.referenceId), [b.ids.m2, b.ids.m1, b.ids.p1], 'after the area it already serves (that one stays its main area), before its plan');
  assert.match((await b.call('pk_place_range', { numbers: 'D2', to: 'Loom' })).text, /is the Product; a run of items is placed on an Area or a Plan/);
  assert.match((await b.call('pk_place_range', { numbers: 'D2', to: 'LM-M9' })).text, /nothing among the Areas, Plans, Goals and the Product is “LM-M9”/);
});

test('the reports and prompts the workbench cites are the program’s to account for before coverage', async () => {
  const b = await bench();
  const item = (rel: string): CoverageItem => ({ key: `doc:${rel}`, category: 'documents', label: rel, dir: 'subagent', bytes: 10, material: { key: `doc:${rel}`, category: 'document versions', label: rel, group: '', bytes: 10, how: '', file: join(repo, ...rel.split('/')), current: true, lines: 3 } } as CoverageItem);
  const l = b.ledger();
  try {
    const cited = citedMaterials(b.store, l, ['subagent/reports/AC-report.md', 'subagent/AB-runtime.md', 'subagent/reports/visit-notes.md', 'docs/PRD.md'].map(item));
    assert.deepEqual([...cited].sort(), [['doc:subagent/AB-runtime.md', 'the work item AB'], ['doc:subagent/reports/AC-report.md', 'the work item AC']], 'a ticket’s own prompt and report; an uncited report and the PRD are left for a lane');
  } finally { l.close(); }
  assert.equal(recomputesCandidates('Deepen', 'synthesis'), true, 'the candidates are recomputed at the end of the cross-check');
  assert.equal(recomputesCandidates('Follow up', 'synthesis'), true);
});

// ───────────────────────── C · generations ─────────────────────────

test('candidate generations: an archived plan set and its numbers; accepting writes the generation, rejecting is remembered', async () => {
  const b = await bench('First usable', 'orientation');
  assert.equal(archiveRootOf('design/archive/superseded-by-v0.4/product/PLAN.md'), 'design/archive/superseded-by-v0.4');
  assert.equal(archiveRootOf('subagent/archive/plan.md'), 'subagent/archive');
  assert.equal(archiveRootOf('docs/PLAN.md'), null);
  const l = b.ledger();
  let cands: ReturnType<typeof generationCandidates>;
  try { cands = generationCandidates(b.store, l); } finally { l.close(); }
  assert.deepEqual(cands.map((c) => [c.key, c.planRefs, c.numbers, c.endedCommit]), [
    ['set:archive/v1', ['archive/v1/PLAN.md'], ['LT-01', 'LT-02', 'LT-03'], ARCHIVED],
    ['set:old', ['old/roadmap.md'], [], ARCHIVED],
  ]);
  const state = await b.call('pk_round_state', {});
  assert.equal((state.json.open as Record<string, number>).generationCandidates, 2);
  // Orientation accepts or rejects before the skeleton has filled the generation's items.
  assert.match((await b.call('pk_generation_candidate', { key: 'set:old', verdict: 'reject' })).text, /why: why this set is not an earlier generation/);
  await b.ok('pk_generation_candidate', { key: 'set:old', verdict: 'reject', why: 'Notes kept for reference, not a plan the project worked to.' });
  const accepted = await b.ok('pk_generation_candidate', { key: 'set:archive/v1', verdict: 'accept', name: 'Plan v1 (hand tools)' });
  const gen = () => b.store.generations.all()[0]!;
  assert.deepEqual([gen().name, gen().planRefs.map((p) => p.id), gen().workIds.length, gen().endedBy.id, gen().ended.basis], ['Plan v1 (hand tools)', ['archive/v1/PLAN.md'], 0, ARCHIVED, 'Commit']);
  assert.deepEqual(accepted.numbersWithNoWorkItem, ['LT-01', 'LT-02', 'LT-03'], 'its items are not on the workbench yet');
  // The plan lane fills them from the archived table; they join the generation as the round's state is next read.
  b.setStage('reconcile');
  await b.ok('pk_fill_from_table', { path: 'archive/v1/PLAN.md', table: {}, into: 'threads', columns: { title: 'Task', id: 'ID' } });
  assert.equal((((await b.call('pk_round_state', {})).json.open) as Record<string, number>).withoutDestination, 3);
  assert.equal(gen().workIds.length, 3, 'the work items carrying its numbers joined it');
  const l2 = b.ledger();
  try { assert.deepEqual(generationCandidates(b.store, l2), [], 'one rejected, one recorded: nothing waits'); } finally { l2.close(); }
  assert.match((await b.call('pk_generation_candidate', { key: 'set:nowhere', verdict: 'accept' })).text, /is not a candidate the program lists/);
});

test('every item of a generation has a destination before a Full deepening’s synthesis: replaced by a number, depended on, or abandoned', async () => {
  const b = await bench('First usable', 'reconcile');
  await b.ok('pk_fill_from_table', { path: 'archive/v1/PLAN.md', table: {}, into: 'threads', columns: { title: 'Task', id: 'ID' } });
  await b.ok('pk_generation_candidate', { key: 'set:archive/v1', verdict: 'accept' });
  assert.deepEqual(itemsWithoutDestination(b.store).map((x) => x.number), ['LT-01', 'LT-02', 'LT-03']);
  b.setStage('cross-check', 'Deepen');
  const held = await b.call('pk_stage', { to: 'synthesis' });
  assert.equal(held.error, true);
  assert.match(held.text, /3 items have no destination: LT-01, LT-02, LT-03/);
  assert.equal((((await b.call('pk_round_state', {})).json.open) as Record<string, number>).withoutDestination, 3);
  // The project's own number names what replaced it; a name that stands for nothing is refused.
  assert.match((await b.call('pk_write_thread', { id: 'LT-01', validity: 'Replaced', replacedBy: 'the new weave' })).text, /replacedBy: the new weave is no work item or reference item/);
  await b.ok('pk_write_thread', { id: 'LT-01', validity: 'Replaced', replacedBy: 'LMC-01' });
  assert.equal(b.byNumber('LT-01').replacedBy, b.byNumber('LMC-01').id, 'kept as the id it stands for');
  await b.ok('pk_write_thread', { id: 'LMC-02', dependsOn: [{ threadId: b.byNumber('LT-02').id, claim: 'the vats were built for hand dyeing', basis: 'Explicit' }] });
  await b.ok('pk_write_thread', { id: 'LT-03', validity: 'Abandoned' });
  assert.deepEqual(itemsWithoutDestination(b.store), []);
  const through = await b.call('pk_stage', { to: 'synthesis', handover: { settled: 'What the lanes brought back is joined and placed.', open: 'What no record places stays unplaced.', first: 'The lane reports.' } });
  assert.equal(through.error, false, through.text);
});

// ───────────────────────── A · compact dumps ─────────────────────────

test('pk_read_assets lists compact rows and gives whole records on request; area is the Areas with their understanding; the overview is counts and names', async () => {
  const b = await bench();
  const refs = await b.ok('pk_read_assets', { kind: 'reference' });
  const rows = refs.rows as Record<string, unknown>[];
  assert.equal(refs.count, b.store.reference.size);
  assert.ok(rows.length <= READ_PAGE);
  assert.deepEqual(Object.keys(rows.find((r) => r.category === 'Requirement' && (r.ids as string[])[0] === 'R-01')!).sort(), ['category', 'id', 'ids', 'name', 'refines', 'validity'], 'id, name, category, what it refines, validity — no text');
  const decisions = await b.ok('pk_read_assets', { kind: 'reference', category: 'Decision', limit: 2 });
  assert.deepEqual([decisions.count, (decisions.rows as unknown[]).length, decisions.next], [6, 2, 2]);
  const full = await b.ok('pk_read_assets', { kind: 'reference', category: 'Decision', full: true });
  assert.match(String((full.rows as { text: string }[])[0]!.text), /D1 · The same panel/);
  const whole = JSON.parse((await b.call('pk_read_assets', { kind: 'thread', ids: [b.byNumber('LMC-01').id] })).text) as { serves: unknown[] }[];
  assert.ok(Array.isArray(whole[0]!.serves), 'with ids: the whole record');
  // An ADR lane that looks for the Areas finds them (CM C13: `area` used to be the understanding records, and read empty).
  await b.ok('pk_write_area', { referenceId: b.ids.m1, effectNow: 'Plain cloth is woven.', gaps: 'No twill.', contributions: [] });
  const areas = await b.ok('pk_read_assets', { kind: 'area' });
  assert.deepEqual((areas.rows as { name: string; effectNow?: string }[]).map((a) => [a.name, a.effectNow ?? null]), [['LM-M1 · Weave', 'Plain cloth is woven.'], ['LM-M2 · Dye', null]]);
  assert.equal(((await b.ok('pk_read_assets', { kind: 'areaUnderstanding' })).rows as unknown[]).length, 1);
  const overview = await b.ok('pk_project_overview', {});
  assert.deepEqual(overview.areas, [{ id: b.ids.m1, name: 'LM-M1 · Weave' }, { id: b.ids.m2, name: 'LM-M2 · Dye' }]);
  assert.deepEqual((overview.counts as { reference: Record<string, number> }).reference.Decision, 6);
  assert.equal(overview.reference, undefined, 'no dump of every item');
});
