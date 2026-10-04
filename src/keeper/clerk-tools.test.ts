/**
 * The Keeper's position-writing tools for the clerk method (Spec v3.0 §3.3; CKC-23, CKC-24, CKC-26, CKC-27). Every tool
 * writes only at the step whose position it is, takes references and never a date, a number or a label the program
 * cannot check, and refuses what does not resolve. Every refusal is paired with the write that must go through, so no
 * test passes on a tool that simply refuses everything.
 *
 * The fixture is an invented project, "Tidepool", a tide-table app: a real git repository in a temporary directory (a
 * plan revised, a decision record that grows, a sync design deleted, code for alerts and a leftover), a Claude Code
 * session in which the owner says yes to a proposal, and the assets a round would find.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import type { EntryMark, Note, Project, ReferenceItem, ScopeItem, Source, WorkThread } from '../model/types.ts';
import type { Breakpoint, ClerkRound, Occurred, RoundStepKind, SemanticPatch } from '../model/k-types.ts';
import { clerkTools, type ClerkToolContext } from './clerk-tools.ts';
import type { LedgerHook } from './evidence.ts';

const AT = '2026-09-26T00:00:00.000Z';
const ENV = { GIT_AUTHOR_NAME: 'Tide Dev', GIT_AUTHOR_EMAIL: 'dev@tidepool.invalid', GIT_COMMITTER_NAME: 'Tide Dev', GIT_COMMITTER_EMAIL: 'dev@tidepool.invalid' };

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(root: string, rel: string, body: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), body);
}
function commit(root: string, message: string, date: string): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(root, ['rev-parse', 'HEAD']);
}

const BASE = mkdtempSync(join(tmpdir(), 'pk-clerk-repo-'));
const ROOT = join(BASE, 'tidepool');
mkdirSync(ROOT);
git(ROOT, ['init', '-q', '-b', 'main']);
git(ROOT, ['config', 'core.autocrlf', 'false']);
write(ROOT, 'docs/PLAN.md', '# Plan\n\nPlan v1: show the tide table for one harbour.\n');
write(ROOT, 'docs/DECISIONS.md', '# Decisions\n\n- D1: tides come from the national feed.\n');
write(ROOT, 'docs/design/SYNC.md', '# Sync\n\nPull the feed every night.\n');
write(ROOT, 'src/tides/feed.ts', 'export const feed = () => [];\n');
write(ROOT, 'src/legacy/old.ts', 'export const old = 0;\n');
const C_START = commit(ROOT, 'Start Tidepool with the plan', '2026-09-01T09:00:00+08:00');
write(ROOT, 'docs/DECISIONS.md', '# Decisions\n\n- D1: tides come from the national feed.\n- **D2**: the offline cache replaces the nightly pull (supersedes the sync design).\n');
const C_CACHE = commit(ROOT, 'Decide the offline cache', '2026-09-03T09:00:00+08:00');
rmSync(join(ROOT, 'docs/design/SYNC.md'));
const C_DROP = commit(ROOT, 'Drop the sync design: not needed', '2026-09-05T09:00:00+08:00');
write(ROOT, 'docs/PLAN.md', '# Plan\n\nPlan v2: tide table and storm alerts.\n');
write(ROOT, 'src/alerts/storm.ts', 'export const storm = () => true;\n');
const C_ALERTS = commit(ROOT, 'Plan v2 adds alerts\n\nThe owner asked for storm alerts.', '2026-09-07T09:00:00+08:00');
const UTC = { start: '2026-09-01T01:00:00.000Z', cache: '2026-09-03T01:00:00.000Z', drop: '2026-09-05T01:00:00.000Z', alerts: '2026-09-07T01:00:00.000Z' };

const LOG = join(BASE, 'sess-tide-1.jsonl');
const rec = (type: 'user' | 'assistant', timestamp: string, content: unknown) => JSON.stringify({
  type, timestamp, sessionId: 'sess-tide-1', cwd: ROOT, message: type === 'user' ? { role: 'user', content } : { role: 'assistant', model: 'claude-opus', content },
});
writeFileSync(LOG, [
  rec('user', '2026-09-02T01:00:10.000Z', 'Can the app work offline?'),
  rec('assistant', '2026-09-02T01:05:20.000Z', [{ type: 'text', text: 'I propose an offline cache that replaces the nightly pull.' }]),
  rec('user', '2026-09-02T03:30:45.000Z', 'yes, go with the cache'),
].join('\n'));
const TRANSCRIPT = '[0] OWNER 2026-09-02 01:00\nCan the app work offline?\n\n[1] AGENT (claude-opus) 2026-09-02 01:05\nI propose an offline cache that replaces the nightly pull.\n  tools: Read docs/PLAN.md\n\n[2] OWNER 2026-09-02 03:30\nyes, go with the cache';

const scopeItem: ScopeItem = {
  id: 'scope_main', path: ROOT, category: 'Repository', relation: 'Main project', reason: 'Owner-given location', reasonSourceIds: [],
  sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner',
};
const project = { id: 'p1', name: 'Tidepool', language: 'en', locations: [ROOT], scope: [scopeItem], scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false, createdAt: AT, lastOpenedAt: null, lastScopedAt: null } as Project;

const source = (id: string, anchor: Source['anchor'], excerpt: string, commitAt: string | null = null): Source => ({
  id, projectId: 'p1', title: id, anchor, ids: [], version: { fingerprint: 'f', readAt: AT, commit: commitAt }, excerpt,
  usedAs: null, usedAsBy: null, availability: null, movedTo: null, scopeItemId: 'scope_main', hasCredential: false, bytes: excerpt.length,
});
const attribution = { author: { kind: 'unknown' as const, name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' as const };
const reference = (id: string, category: string, name: string, ids: string[] = []) => ({
  id, projectId: 'p1', category, name, ids, text: name, quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution,
  sourceIds: ['src_plan'], refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT,
}) as unknown as ReferenceItem;
const thread = (id: string, title: string, ids: string[] = []) => ({
  id, projectId: 'p1', title, ids, doing: title, changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [],
  progress: 'In progress', validity: 'Current', replacedBy: null, attribution, inputs: { jobId: 'j', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: AT, updatedAt: AT, pendingSourceIds: [],
}) as unknown as WorkThread;
const since: Occurred = { at: UTC.alerts, basis: 'Commit', anchor: C_ALERTS };
const breakpoint = (id: string, kind: Breakpoint['kind'], targetId: string, basis: Breakpoint['basis']): Breakpoint => ({
  id, projectId: 'p1', kind, targetId, why: `${kind} on ${targetId}`, evidence: [], basis, since, lit: true, out: null, ownerResponse: null,
  confirmedInRoundId: null, sixThing: null, sendBackId: null, roundId: null, updatedAt: AT,
});
const ROUND: ClerkRound = {
  id: 'round_1', projectId: 'p1', kind: 'First usable', number: 1, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root',
  questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT,
};

function seed(store: ProjectStore): void {
  store.sources.put(source('src_plan', { kind: 'file', path: join(ROOT, 'docs', 'PLAN.md'), headingPath: ['Plan'], lineStart: 1, lineEnd: 3 }, '# Plan\n\nPlan v2: tide table and storm alerts.', C_ALERTS));
  store.sources.put(source('src_board', { kind: 'file', path: join(ROOT, 'docs', 'BOARD.md'), headingPath: [], lineStart: 1, lineEnd: 2 }, '| TP-9 | storm alerts | in progress |'));
  store.sources.put(source('src_session', { kind: 'session', host: 'claude', sessionId: 'sess-tide-1', file: LOG, cwd: ROOT, messageStart: 0, messageEnd: 2, at: '2026-09-02T01:00:10.000Z' }, TRANSCRIPT));
  store.sources.put(source('src_lost', { kind: 'session', host: 'claude', sessionId: 'sess-tide-0', file: join(BASE, 'gone.jsonl'), cwd: ROOT, messageStart: 0, messageEnd: 2, at: '2026-09-02T01:00:10.000Z' }, TRANSCRIPT));
  store.reference.put(reference('ref_area_tides', 'Area', 'Tide table'));
  store.reference.put(reference('ref_area_alerts', 'Area', 'Alerts'));
  store.reference.put(reference('ref_d2', 'Decision', 'D2 Offline cache', ['D2']));
  store.reference.put(reference('ref_plan', 'Plan', 'Plan v2'));
  store.threads.put(thread('thread_alerts', 'Storm alerts'));
  store.threads.put(thread('thread_cache', 'Offline cache'));
  store.threads.put(thread('thread_feed', 'National feed', ['TP-7']));
  store.breakpoints.put(breakpoint('bp_findings', 'Findings open', 'thread_alerts', 'Inferred'));
  store.breakpoints.put(breakpoint('bp_merge', 'Not merged', 'thread_cache', 'Explicit'));
  store.breakpoints.put(breakpoint('bp_plan', 'Not planned', 'ref_plan', 'Explicit'));
  store.marks.put({ id: 'mark_stale', projectId: 'p1', kind: 'Suspected stale', targetId: 'ref_plan', clueSourceIds: ['src_plan'], clue: 'Plan v2 still names the nightly pull', since: AT, noteId: null, closed: null } as EntryMark);
  store.notes.put({ id: 'note_dropped', projectId: 'p1', mount: { kind: 'project', ids: [] }, status: 'Current', ownerResponse: null, versions: [{ version: 1, at: AT, title: 'Dropped along the way? Tide gauges', preview: 'x', body: { currentView: null, whyItMatters: null, facts: [], otherExplanations: null, keepAdjust: null, whatWouldSettleIt: null }, ask: 'For your decision', judgementRecordId: 'jdg_1', reason: 'x' }], discussion: [], followUps: [], author: { agent: 'pi', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, language: 'en', updatedAt: AT } as Note);
  store.clerkRounds.put(ROUND);
}

interface Harness {
  readonly store: ProjectStore;
  readonly ctx: ClerkToolContext;
  as(kind: RoundStepKind | null, path?: string | null): void;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean; json: Record<string, unknown> }>;
}

/** A session of one step: its own job and tool set, on a fresh store — or on `shared`, as a later session of the same round. */
function setup(kind: RoundStepKind | null, extra: Partial<ClerkToolContext> = {}, shared?: ProjectStore): Harness {
  const store = shared ?? ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-clerk-store-')));
  if (!shared) seed(store);
  const ctx: ClerkToolContext = { store, project, jobId: 'job_clerk', jobKind: 'Organizing', model: null, step: kind ? { roundId: 'round_1', kind, path: null } : null, ...extra };
  const tools = clerkTools(ctx);
  return {
    store, ctx,
    as(k, path = null) { ctx.step = k ? { roundId: 'round_1', kind: k, path } : null; },
    async call(name, args) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `no tool ${name}`);
      const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
      // A call a writer refuses as incomplete throws, and pi returns the message as an error result: so does this.
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
  return r.json;
}
async function expectRefused(h: Harness, name: string, args: Record<string, unknown>, reason: RegExp) {
  const r = await h.call(name, args);
  assert.equal(r.error, true, `${name} should be refused: ${JSON.stringify(args).slice(0, 200)} → ${r.text}`);
  assert.match(r.text, reason);
  return r.text;
}

const D2_LINE = 'D2: the offline cache replaces the nightly pull (supersedes the sync design)';
const PATCH = {
  title: 'The nightly pull is withdrawn', invalidated: 'Pulling the feed every night', replacedBy: 'the offline cache (D2)',
  affects: ['ref_plan', 'thread_cache'], affectsText: 'the plan and the cache work', mustNotPassAsCurrent: 'a nightly pull as the way tides are fetched',
  candidate: { kind: 'file', id: 'docs/DECISIONS.md', line: D2_LINE },
  oldAnchor: { kind: 'file', id: 'docs/design/SYNC.md', line: 'Pull the feed every night.' },
  decision: { kind: 'object', id: 'ref_d2' },
};
const SENDBACK = {
  to: 'Work', targetId: 'thread_alerts', what: 'Storm alerts passed QC with seven findings nobody fixed.', suggestion: 'reopen the storm-alerts work to fix the findings',
  evidence: [{ kind: 'commit', id: C_ALERTS.slice(0, 8) }, { kind: 'file', id: 'docs/DECISIONS.md', line: 'D1: tides come from the national feed.' }],
  from: { kind: 'breakpoint', id: 'bp_findings' }, sixThing: 5,
};
const TERRITORY = {
  name: 'Leftovers', summary: 'Code left from the first sketch.', repo: 'scope_main', paths: ['src/legacy'], kind: 'non-product',
  anomalies: [{ kind: 'Unreferenced', text: 'src/legacy/old.ts is imported by nothing.', evidence: [{ kind: 'file', id: 'src/legacy/old.ts' }], basis: 'Inferred' }],
};
const K_COLLECTIONS = ['layers', 'generations', 'roundDocs', 'patches', 'numbers', 'links', 'sendbacks', 'territories', 'drafts'] as const;
const kCount = (store: ProjectStore) => K_COLLECTIONS.reduce((n, c) => n + store[c].size, 0);

// ───────────────────────── which step writes which position (§3.3) ─────────────────────────

test('each position is written by the step whose position it is; a job that is no step of a round writes none', async () => {
  const h = setup(null);
  const attempts: [string, Record<string, unknown>, RoundStepKind][] = [
    ['pk_write_layers', { entries: [{ path: 'docs/PLAN.md', layer: 'Plan', current: true }] }, 'skeleton'],
    ['pk_write_generation', { name: 'Sync era', ended: { kind: 'commit', id: C_DROP }, planRefs: [] }, 'dig'],
    ['pk_write_round_doc', { kind: 'Questions', title: 'Questions', markdown: 'What is current?' }, 'skeleton'],
    ['pk_write_patch', PATCH, 'orientation'],
    ['pk_number', { objectId: 'thread_alerts', objectKind: 'work' }, 'cross-check'],
    ['pk_link_process', { workId: 'thread_alerts', ledgerRef: { kind: 'commit', id: C_ALERTS }, stepKind: 'Delivered', why: 'it adds storm.ts' }, 'synthesis'],
    ['pk_confirm', { kind: 'breakpoint', id: 'bp_findings', confirmed: true, why: 'read the QC report' }, 'skeleton'],
    ['pk_suggest_sendback', SENDBACK, 'dig'],
    ['pk_tag_six', { target: { kind: 'mark', id: 'mark_stale' }, thing: 1 }, 'orientation'],
    ['pk_write_territory', TERRITORY, 'synthesis'],
    ['pk_record_spot_check', { checked: [{ target: { collection: 'threads', id: 'thread_alerts' }, kind: 'code state', verdict: 'Right' }] }, 'synthesis'],
    ['pk_write_session_draft', { session: { host: 'claude', sessionId: 'sess-tide-1' }, lines: [], agentSummary: [] }, 'orientation'],
  ];
  for (const [name, args, wrong] of attempts) {
    h.as(null);
    await expectRefused(h, name, args, /no step of a round.*nothing was written/is);
    h.as(wrong);
    await expectRefused(h, name, args, /nothing was written/i);
  }
  assert.equal(kCount(h.store), 0, 'nothing was written anywhere');
  assert.equal(h.store.breakpoints.get('bp_findings')!.confirmedInRoundId, null);
  assert.equal(h.store.marks.get('mark_stale')!.sixThing, undefined);
});

// ───────────────────────── orientation: layers, generations, documents ─────────────────────────

test('orientation maps each document to its layer; a path that is neither in the tree nor in its history is refused', async () => {
  const h = setup('orientation');
  const r = await expectOk(h, 'pk_write_layers', { entries: [
    { path: 'docs/PLAN.md', layer: 'Plan', current: true },
    { path: 'docs/design/SYNC.md', layer: 'Spec', current: false, note: 'the sync design the cache replaced' },
    { path: 'docs/MISSING.md', layer: 'PRD', current: true },
    { path: 'docs/DECISIONS.md', layer: 'Decisions', current: true },
  ] });
  assert.equal(r.written, 2);
  assert.equal((r.refused as string[]).length, 2);
  assert.match((r.refused as string[]).join('\n'), /docs\/MISSING\.md is not in .* now, and no commit in its history touched that path/);
  assert.match((r.refused as string[]).join('\n'), /layer must be one of Product, PRD, Spec, Plan/);
  assert.equal(h.store.layers.size, 2);
  const sync = h.store.layers.all().find((l) => l.path === 'docs/design/SYNC.md')!;
  assert.deepEqual({ layer: sync.layer, current: sync.current, note: sync.note, roundId: sync.roundId }, { layer: 'Spec', current: false, note: 'the sync design the cache replaced', roundId: 'round_1' });
  assert.equal((r.entries as { onlyInHistory?: boolean }[])[1]!.onlyInHistory, true, 'a deleted document is mapped from its history');

  await expectOk(h, 'pk_write_layers', { entries: [{ path: 'docs\\PLAN.md', repo: 'scope_main', layer: 'Plan', current: false }] });
  assert.equal(h.store.layers.size, 2, 'mapping a path again updates it');
  assert.equal(h.store.layers.all().find((l) => l.path === 'docs/PLAN.md')!.current, false);
  await expectRefused(h, 'pk_write_layers', { entries: [{ path: 'docs/NOPE.md', layer: 'Plan', current: true }] }, /Nothing was written/);
});

test('a generation is cut where the material ends one, dated by that evidence; a date written out is not evidence', async () => {
  const h = setup('orientation');
  const g = await expectOk(h, 'pk_write_generation', {
    name: 'Nightly-sync generation', ended: { kind: 'commit', id: C_DROP.slice(0, 8) }, started: { kind: 'commit', id: C_START },
    planRefs: [{ kind: 'file', id: 'docs/design/SYNC.md' }, { kind: 'source', id: 'src_plan' }], workIds: ['thread_feed'],
  });
  const gen = h.store.generations.get(g.id as string)!;
  assert.deepEqual(gen.ended, { at: UTC.drop, basis: 'Commit', anchor: C_DROP }, 'the date is read from what ended it');
  assert.equal(gen.endedBy.label, `${C_DROP.slice(0, 7)} Drop the sync design: not needed`);
  assert.equal(gen.started?.at, UTC.start);
  assert.equal(gen.planRefs.length, 2);
  assert.match(gen.planRefs[0]!.label, /version history/, 'a deleted plan is cited from its history');
  assert.deepEqual(gen.workIds, ['thread_feed']);

  await expectRefused(h, 'pk_write_generation', { name: 'Sync era', ended: '2026-09-05', planRefs: [] }, /ended is not evidence/);
  await expectRefused(h, 'pk_write_generation', { name: 'Sync era', ended: { kind: 'commit', id: C_DROP }, started: { kind: 'commit', id: C_ALERTS }, planRefs: [] }, /comes after ended/);
  await expectRefused(h, 'pk_write_generation', { name: 'Sync era', ended: { kind: 'commit', id: C_DROP }, planRefs: [], workIds: ['thread_nowhere'] }, /names no work item/);
  await expectRefused(h, 'pk_write_generation', { name: 'Sync era', ended: { kind: 'commit', id: C_DROP }, endedBy: { kind: 'commit', id: C_DROP }, planRefs: [] }, /endedBy is not yours to write/);
  await expectRefused(h, 'pk_write_generation', { name: 'Sync era', ended: { kind: 'commit', id: 'feedface99' }, planRefs: [] }, /names no commit/);

  h.as('skeleton');
  const again = await expectOk(h, 'pk_write_generation', { name: 'Nightly-sync  generation', ended: { kind: 'file', id: 'docs/DECISIONS.md', line: D2_LINE }, planRefs: [] });
  assert.equal(again.updated, true, 'a generation with the same name is updated');
  assert.equal(h.store.generations.size, 1);
  assert.equal(h.store.generations.get(g.id as string)!.ended.at, UTC.cache, 'a line is dated by the commit it first appeared in');
});

test('each step leaves its own documents in full; a deep sweep files only its own report, and writing one again replaces it', async () => {
  const h = setup('orientation');
  const q = await expectOk(h, 'pk_write_round_doc', { kind: 'Questions', title: 'What this round asks', markdown: '1. What is current?\n2. What was dropped?' });
  assert.equal(h.store.clerkRounds.get('round_1')!.questionsDocId, q.id, 'the round knows its questions');
  await expectOk(h, 'pk_write_round_doc', { kind: 'Brief', path: 'owner-intent', title: 'Brief: the owner’s intent', markdown: '## Shared background\n…' });
  await expectOk(h, 'pk_write_round_doc', { kind: 'History map', title: 'History map', markdown: '4 commits; the sync design deleted in the third.' });
  assert.deepEqual(h.store.clerkRounds.get('round_1')!.paths, ['owner-intent'], 'a brief sets a deep sweep of the round');
  await expectRefused(h, 'pk_write_round_doc', { kind: 'Brief', title: 'x', markdown: 'y' }, /give the sweep’s name in path/);
  await expectRefused(h, 'pk_write_round_doc', { kind: 'Questions', path: 'owner-intent', title: 'x', markdown: 'y' }, /belongs on a Brief or a Report/);
  await expectRefused(h, 'pk_write_round_doc', { kind: 'Report', path: 'owner-intent', title: 'x', markdown: 'y' }, /a Report is written by a deep sweep \(step 3\)/);
  await expectRefused(h, 'pk_write_round_doc', { kind: 'Layers', title: 'x', markdown: 'y' }, /pk_write_layers/);
  await expectRefused(h, 'pk_write_round_doc', { kind: 'Questions', title: 'x', markdown: '  ' }, /markdown is empty/);

  h.as('dig', 'owner-intent');
  const report = await expectOk(h, 'pk_write_round_doc', { kind: 'Report', title: 'Report: owner intent', markdown: 'short' });
  assert.equal(report.path, 'owner-intent', 'a sweep’s report is filed under the sweep itself');
  await expectRefused(h, 'pk_write_round_doc', { kind: 'Report', path: 'code-state', title: 'x', markdown: 'y' }, /“code-state” is another sweep’s/);
  await expectRefused(h, 'pk_write_round_doc', { kind: 'Adoption', title: 'x', markdown: 'y' }, /a deep sweep \(step 3\) writes Report/);
  const long = `# Report\n\n${'The owner asked for storm alerts [src_session]. '.repeat(3200)}`;
  const replaced = await expectOk(h, 'pk_write_round_doc', { kind: 'Report', path: 'owner-intent', title: 'Report: owner intent', markdown: long });
  assert.equal(replaced.id, report.id);
  assert.equal(replaced.replaced, true);
  assert.equal(h.store.roundDocs.get(report.id as string)!.markdown, long, 'the full text, never shortened');

  for (const [step, kind] of [['cross-check', 'Adoption'], ['synthesis', 'Result'], ['spot-check', 'Spot check']] as const) {
    h.as(step);
    await expectOk(h, 'pk_write_round_doc', { kind, title: kind, markdown: `${kind} of round 1` });
  }
  assert.equal(h.store.roundDocs.size, 7);
});

// ───────────────────────── skeleton: semantic patches, numbers, links ─────────────────────────

test('a semantic patch comes from a written supersession: the program numbers it and dates it by its candidate', async () => {
  const h = setup('skeleton');
  const first = await expectOk(h, 'pk_write_patch', PATCH);
  assert.deepEqual({ number: first.number, status: first.status, created: first.created }, { number: 'SP-1', status: 'Draft', created: true });
  const patch = h.store.patches.get(first.id as string)!;
  assert.deepEqual(patch.occurred, { at: UTC.cache, basis: 'Commit', anchor: C_CACHE }, 'when the supersession was written: the commit its line first appeared in');
  assert.equal(patch.candidate.line, '**D2**: the offline cache replaces the nightly pull (supersedes the sync design).', 'the line as the decision record has it');
  assert.match(patch.oldAnchor.label, /SYNC\.md .*version history/);
  assert.equal(patch.decision?.label, 'D2 Offline cache');

  await expectRefused(h, 'pk_write_patch', { ...PATCH, status: 'Confirmed' }, /The skeleton drafts a patch/);
  await expectRefused(h, 'pk_write_patch', { ...PATCH, number: 'SP-9' }, /number is not yours to write/);
  await expectRefused(h, 'pk_write_patch', { ...PATCH, occurred: { at: '2026-09-03', basis: 'Commit', anchor: null } }, /occurred is not yours to write/);
  await expectRefused(h, 'pk_write_patch', { ...PATCH, candidate: { kind: 'file', id: 'docs/DECISIONS.md' } }, /not the line that says the supersession/);
  await expectRefused(h, 'pk_write_patch', { ...PATCH, candidate: { kind: 'file', id: 'docs/DECISIONS.md', line: 'D3: the cache replaces the feed' } }, /The line “D3: the cache replaces the feed” is not in docs\/DECISIONS\.md/);
  await expectRefused(h, 'pk_write_patch', { ...PATCH, candidate: { kind: 'object', id: 'ref_d2' } }, /an object of the assets is the Keeper’s record/);
  await expectRefused(h, 'pk_write_patch', { ...PATCH, affects: ['ref_nowhere'] }, /affects names what is not in the assets: ref_nowhere/);
  const { mustNotPassAsCurrent: _dropped, ...withoutFourth } = PATCH;
  await expectRefused(h, 'pk_write_patch', { ...withoutFourth, oldAnchor: { kind: 'commit', id: C_DROP } }, /missing: mustNotPassAsCurrent/);
  assert.equal(h.store.patches.size, 1, 'nothing was written by a refused call');

  const again = await expectOk(h, 'pk_write_patch', PATCH);
  assert.deepEqual({ id: again.id, number: again.number, created: again.created }, { id: first.id, number: 'SP-1', created: false }, 'the same candidate and old anchor are the same patch');
  const second = await expectOk(h, 'pk_write_patch', { ...PATCH, title: 'The sync design is withdrawn', oldAnchor: { kind: 'commit', id: C_DROP } });
  assert.equal(second.number, 'SP-2');

  h.as('cross-check');
  const confirmed = await expectOk(h, 'pk_write_patch', { id: 'SP-1', status: 'Confirmed' });
  assert.equal(confirmed.status, 'Confirmed');
  const own = await expectOk(h, 'pk_write_patch', { ...PATCH, title: 'D1 source narrowed', candidate: { kind: 'commit', id: C_DROP, line: 'Drop the sync design: not needed' }, oldAnchor: { kind: 'file', id: 'docs/DECISIONS.md', line: 'D1: tides come from the national feed.' } });
  assert.deepEqual({ number: own.number, status: own.status }, { number: 'SP-3', status: 'Confirmed' }, 'a patch the cross-check writes itself is one it checked');

  h.as('skeleton');
  assert.equal((await expectOk(h, 'pk_write_patch', PATCH)).status, 'Confirmed', 'a draft the skeleton only repeats keeps what the cross-check said');
  assert.equal((await expectOk(h, 'pk_write_patch', { ...PATCH, replacedBy: 'the offline cache, refreshed hourly (D2)' })).status, 'Draft', 'a changed one is a draft again');
});

test('with the ledger in the build, a patch’s candidate is the ledger’s explicit-supersession entry', async () => {
  const entry = { label: 'DECISIONS.md: “supersedes the sync design”', occurred: { at: '2026-09-03', basis: 'Written in text' as const, anchor: 'led_sup_2' }, text: D2_LINE };
  const ledger: LedgerHook = { resolve: (id) => (id === 'led_sup_2' ? entry : null) };
  const h = setup('skeleton', { ledger });
  await expectRefused(h, 'pk_write_patch', PATCH, /This build has the ledger/);
  const p = await expectOk(h, 'pk_write_patch', { ...PATCH, candidate: { kind: 'ledger', id: 'led_sup_2' } });
  assert.deepEqual(h.store.patches.get(p.id as string)!.occurred, entry.occurred, 'dated by the ledger entry: a date stays a date');
});

test('a Keeper number goes to what the project did not number; the project’s own number wins and the Keeper’s stays an alias', async () => {
  const h = setup('skeleton');
  const k1 = await expectOk(h, 'pk_number', { objectId: 'thread_alerts', objectKind: 'work' });
  assert.deepEqual(k1, { objectId: 'thread_alerts', number: 'K-1', byKeeper: true, recorded: true });
  assert.deepEqual(await expectOk(h, 'pk_number', { objectId: 'thread_alerts', objectKind: 'work' }), { objectId: 'thread_alerts', number: 'K-1', byKeeper: true, recorded: false });
  assert.equal((await expectOk(h, 'pk_number', { objectId: 'thread_cache', objectKind: 'work' })).number, 'K-2');
  const own = await expectOk(h, 'pk_number', { objectId: 'thread_feed', objectKind: 'work' });
  assert.deepEqual({ number: own.number, byKeeper: own.byKeeper, recorded: own.recorded }, { number: 'TP-7', byKeeper: false, recorded: false }, 'the project numbers it: nothing is recorded');
  assert.equal((await expectOk(h, 'pk_number', { objectId: 'ref_d2', objectKind: 'decision' })).number, 'D2');
  assert.equal((await expectOk(h, 'pk_number', { objectId: 'ref_plan', objectKind: 'other' })).number, 'K-3');
  assert.equal(h.store.numbers.size, 3);
  await expectRefused(h, 'pk_number', { objectId: 'ref_d2', objectKind: 'work' }, /its objectKind is decision/);
  await expectRefused(h, 'pk_number', { objectId: 'thread_nowhere', objectKind: 'work' }, /is not an object of this project’s assets/);
  await expectRefused(h, 'pk_number', { objectId: 'thread_cache', objectKind: 'work', number: 'K-7' }, /number is not yours to write/);
  await expectRefused(h, 'pk_number', { objectId: 'thread_cache' }, /Give objectKind .* or projectNumber/);

  const later = await expectOk(h, 'pk_number', { objectId: 'thread_alerts', projectNumber: 'TP-9' });
  assert.deepEqual(later, { objectId: 'thread_alerts', number: 'TP-9', alias: 'K-1', recorded: true });
  const record = h.store.numbers.all().find((n) => n.objectId === 'thread_alerts')!;
  assert.deepEqual({ number: record.number, projectNumber: record.projectNumber }, { number: 'K-1', projectNumber: 'TP-9' });
  assert.deepEqual(await expectOk(h, 'pk_number', { objectId: 'thread_alerts', objectKind: 'work' }), { objectId: 'thread_alerts', number: 'TP-9', byKeeper: false, alias: 'K-1', recorded: false });
  await expectRefused(h, 'pk_number', { objectId: 'thread_cache', projectNumber: 'TP-99' }, /TP-99 is written nowhere in the project’s material/);
  await expectRefused(h, 'pk_number', { objectId: 'thread_cache', projectNumber: 'TP-9' }, /TP-9 is already the number of thread_alerts/);
  await expectRefused(h, 'pk_number', { objectId: 'thread_feed', projectNumber: 'TP-9' }, /has no Keeper number to keep as an alias; the project numbers it TP-7/);

  h.store.patches.put({ id: 'patch_x', number: 'SP-4', title: 'x' } as unknown as SemanticPatch);
  assert.deepEqual(await expectOk(h, 'pk_number', { objectId: 'SP-4', objectKind: 'patch' }), { objectId: 'patch_x', number: 'SP-4', byKeeper: true, recorded: false, note: 'A semantic patch is numbered by the program when it is written.' });
});

test('a fact the program could not tie by ids is linked to a step of a work item as Inferred, and confirmed only in the cross-check', async () => {
  const h = setup('skeleton');
  const link = { workId: 'thread_alerts', ledgerRef: { kind: 'commit', id: C_ALERTS.slice(0, 10) }, stepKind: 'Delivered', why: 'the commit adds src/alerts/storm.ts, the storm-alerts code' };
  const made = await expectOk(h, 'pk_link_process', link);
  assert.deepEqual({ ledgerRef: made.ledgerRef, confirmed: made.confirmed, occurred: made.occurred }, { ledgerRef: `commit:${C_ALERTS}`, confirmed: false, occurred: { at: UTC.alerts, basis: 'Commit', anchor: C_ALERTS } });
  const stored = h.store.links.get(made.id as string)!;
  assert.deepEqual({ basis: stored.basis, roundId: stored.roundId, jobId: stored.jobId }, { basis: 'Inferred', roundId: 'round_1', jobId: 'job_clerk' });
  assert.deepEqual(stored.evidence, {
    kind: 'commit', id: C_ALERTS, label: `${C_ALERTS.slice(0, 7)} Plan v2 adds alerts`, line: null, occurred: { at: UTC.alerts, basis: 'Commit', anchor: C_ALERTS },
  }, 'the fact is kept as the evidence it is — label and time — beside its reference');
  const byLine = await expectOk(h, 'pk_link_process', { workId: 'thread_cache', ledgerRef: { kind: 'file', id: 'docs/DECISIONS.md', line: D2_LINE }, stepKind: 'Planned', why: 'D2 plans the offline cache' });
  const lineEvidence = h.store.links.get(byLine.id as string)!.evidence!;
  assert.deepEqual({ line: lineEvidence.line, at: lineEvidence.occurred?.at }, { line: '**D2**: the offline cache replaces the nightly pull (supersedes the sync design).', at: UTC.cache }, 'with the original line and the time it first appeared');
  h.store.links.remove(byLine.id as string);
  const early = await expectOk(h, 'pk_link_process', { ...link, confirm: true });
  assert.equal(early.confirmed, false, 'the skeleton cannot confirm its own link');
  assert.match(String(early.note), /confirmed in the cross-check/);
  await expectRefused(h, 'pk_link_process', { ...link, stepKind: 'Shipped' }, /stepKind must be one of Planned, Dispatched, Delivered/);
  await expectRefused(h, 'pk_link_process', { ...link, workId: 'thread_nowhere' }, /is not a work item of the assets/);
  await expectRefused(h, 'pk_link_process', { ...link, ledgerRef: { kind: 'object', id: 'ref_d2' } }, /an object of the assets is a judgement, not a step/);
  await expectRefused(h, 'pk_link_process', { ...link, confirmed: true }, /confirmed is not yours to write/);
  // A new link says why; linking the same fact to the same step again gives only what changes.
  await expectRefused(h, 'pk_link_process', { ...link, stepKind: 'Merged', why: ' ' }, /why: in one sentence/);
  await expectRefused(h, 'pk_link_process', { workId: link.workId, ledgerRef: link.ledgerRef, stepKind: 'Merged' }, /^Invalid arguments: .*a new one needs why/);
  assert.equal((await expectOk(h, 'pk_link_process', { workId: link.workId, ledgerRef: link.ledgerRef, stepKind: link.stepKind })).id, made.id);
  assert.equal(h.store.links.get(made.id as string)!.why, link.why, 'an update that leaves why out keeps it');

  h.as('cross-check');
  assert.equal((await expectOk(h, 'pk_link_process', { ...link, confirm: true })).confirmed, true);
  await expectOk(h, 'pk_confirm', { kind: 'link', id: made.id, confirmed: true, why: 'storm.ts is the alerts code' });
  assert.equal(h.store.links.get(made.id as string)!.evidence?.label, `${C_ALERTS.slice(0, 7)} Plan v2 adds alerts`, 'a confirmation keeps the evidence');
  h.as('skeleton');
  assert.equal((await expectOk(h, 'pk_link_process', link)).confirmed, true, 'a later skeleton that repeats it leaves it confirmed');
  assert.equal(h.store.links.size, 1);
});

// ───────────────────────── cross-check: confirmations, territories ─────────────────────────

test('the cross-check confirms or refutes: a refuted link goes, a refuted breakpoint goes out, a patch is Confirmed or Rejected', async () => {
  const h = setup('skeleton');
  const link = await expectOk(h, 'pk_link_process', { workId: 'thread_cache', ledgerRef: { kind: 'commit', id: C_CACHE }, stepKind: 'Planned', why: 'the decision plans the cache' });
  const patch = await expectOk(h, 'pk_write_patch', PATCH);

  h.as('cross-check');
  const gone = await expectOk(h, 'pk_confirm', { kind: 'link', id: link.id, confirmed: false, why: 'the commit records a decision, not a plan' });
  assert.equal(gone.removed, true);
  assert.equal(h.store.links.size, 0, 'a link that does not hold is no association at all');

  await expectOk(h, 'pk_confirm', { kind: 'breakpoint', id: 'bp_findings', confirmed: false, why: 'the findings were fixed in the same batch; the link to the QC report was wrong' });
  const findings = h.store.breakpoints.get('bp_findings')!;
  assert.deepEqual({ lit: findings.lit, by: findings.out?.by, evidence: findings.out?.evidence }, { lit: false, by: 'model', evidence: [] }, 'an Inferred breakpoint goes out on the check, put out by the step that refuted it');

  await expectRefused(h, 'pk_confirm', { kind: 'breakpoint', id: 'bp_merge', confirmed: false, why: 'I think it was merged' }, /goes out only on evidence/);
  assert.equal(h.store.breakpoints.get('bp_merge')!.lit, true);
  await expectOk(h, 'pk_confirm', { kind: 'breakpoint', id: 'bp_merge', confirmed: false, why: 'the cache commit is on main', evidence: [{ kind: 'commit', id: C_CACHE }] });
  const merged = h.store.breakpoints.get('bp_merge')!;
  assert.equal(merged.lit, false);
  assert.equal(merged.out?.evidence[0]?.id, C_CACHE, 'with the evidence that puts it out');

  // D99: the cross-check puts out; only the round's spot-check lights (the tests below).
  await expectRefused(h, 'pk_confirm', { kind: 'breakpoint', id: 'bp_plan', confirmed: true, why: 'no plan item mentions tide gauges' }, /lights only when the round's independent spot-check confirms it.*cross-check/s);
  assert.equal(h.store.breakpoints.get('bp_plan')!.confirmedInRoundId, null);
  await expectRefused(h, 'pk_confirm', { kind: 'breakpoint', id: 'bp_merge', confirmed: true, why: 'x' }, /already out/);

  assert.equal((await expectOk(h, 'pk_confirm', { kind: 'patch', id: 'SP-1', confirmed: false, why: 'D2 withdraws only the nightly schedule' })).status, 'Rejected');
  assert.equal(h.store.patches.get(patch.id as string)!.status, 'Rejected');
  await expectRefused(h, 'pk_confirm', { kind: 'patch', id: 'SP-8', confirmed: true, why: 'x' }, /is not a semantic patch/);
  await expectRefused(h, 'pk_confirm', { kind: 'note', id: 'note_dropped', confirmed: true, why: 'x' }, /kind must be link, breakpoint or patch/);
  await expectRefused(h, 'pk_confirm', { kind: 'patch', id: 'SP-1', confirmed: true, why: '' }, /why: what you checked it against/);
});

// ───────────────────────── D99: a breakpoint lights after a lane looked and the spot-check checked ─────────────────────────

/** A breakpoint the program computed, not lit: a candidate (breakpoints.ts `reconcile`). */
const candidateOf = (id: string, kind: Breakpoint['kind'], targetId: string, basis: Breakpoint['basis'] = 'Inferred'): Breakpoint => ({ ...breakpoint(id, kind, targetId, basis), lit: false });
const DEEPEN: ClerkRound = { ...ROUND, id: 'round_2', kind: 'Deepen', number: 2 };

test('a lane records where it looked for a missing step; only a lane, only on what is not out, and only with the places named', async () => {
  const h = setup('lane');
  h.store.breakpoints.put(candidateOf('bp_done', 'No trace of done', 'thread_feed'));
  const r = await expectOk(h, 'pk_record_looked', { breakpointId: 'bp_done', where: ['docs/PLAN.md §Plan', ' ledger: commits naming TP-7 ', 'docs/PLAN.md §Plan'] });
  const looked = h.store.breakpoints.get('bp_done')!.looked!;
  assert.deepEqual([looked.roundId, looked.jobId, looked.where], ['round_1', 'job_clerk', ['docs/PLAN.md §Plan', 'ledger: commits naming TP-7']]);
  assert.deepEqual(r.looked, JSON.parse(JSON.stringify(looked)));
  assert.equal(h.store.breakpoints.get('bp_done')!.lit, false, 'looking lights nothing');
  await expectRefused(h, 'pk_record_looked', { breakpointId: 'bp_done', where: [' '] }, /where: each place you read/);
  await expectRefused(h, 'pk_record_looked', { breakpointId: 'bp_nowhere', where: ['x'] }, /is not a breakpoint/);
  h.store.breakpoints.put({ ...candidateOf('bp_gone', 'Not merged', 'thread_cache'), out: { at: AT, by: 'evidence', evidence: [] } });
  await expectRefused(h, 'pk_record_looked', { breakpointId: 'bp_gone', where: ['x'] }, /already out/);
  for (const other of ['cross-check', 'spot-check', 'main', null] as const) {
    h.as(other);
    await expectRefused(h, 'pk_record_looked', { breakpointId: 'bp_done', where: ['x'] }, /where a lane looked.*nothing was written/s);
  }
});

test('only the round’s spot-check lights a candidate, only after a lane looked, and never in First usable; refuting stays open to the cross-check', async () => {
  const h = setup('spot-check');
  h.store.clerkRounds.put(DEEPEN);
  h.store.breakpoints.put(candidateOf('bp_done', 'No trace of done', 'thread_feed'));
  h.store.breakpoints.put(candidateOf('bp_check', 'Not checked', 'thread_alerts', 'Explicit'));
  // First usable (round_1): nothing lights, looked or not.
  h.store.breakpoints.put({ ...h.store.breakpoints.get('bp_done')!, looked: { roundId: 'round_1', jobId: 'job_lane', where: ['docs/PLAN.md'], at: AT } });
  await expectRefused(h, 'pk_confirm', { kind: 'breakpoint', id: 'bp_done', confirmed: true, why: 'no commit anywhere' }, /First usable.*nothing lights/s);
  assert.equal(h.store.breakpoints.get('bp_done')!.lit, false);
  // A deepening's spot-check: a candidate no lane looked for does not light.
  h.ctx.step = { roundId: 'round_2', kind: 'spot-check', path: null };
  await expectRefused(h, 'pk_confirm', { kind: 'breakpoint', id: 'bp_check', confirmed: true, why: 'no QC report' }, /No lane has looked for the missing step/);
  assert.equal(h.store.breakpoints.get('bp_check')!.lit, false);
  // Looked and checked: it lights, with the check and the round it lit in.
  const r = await expectOk(h, 'pk_confirm', { kind: 'breakpoint', id: 'bp_done', confirmed: true, why: 'read the plan and the ledger again: no commit, receipt or report of TP-7' });
  const done = h.store.breakpoints.get('bp_done')!;
  assert.deepEqual([r.lit, done.lit, done.checked?.roundId, done.checked?.jobId, done.confirmedInRoundId, done.roundId], [true, true, 'round_2', 'job_clerk', 'round_2', 'round_2']);
  // Any other job of the deepening may not light: the main agent in its cross-check, a lane.
  h.store.breakpoints.put({ ...h.store.breakpoints.get('bp_check')!, looked: { roundId: 'round_2', jobId: 'job_lane', where: ['docs/qc/'], at: AT } });
  for (const other of ['cross-check', 'main', 'lane', 'synthesis'] as const) {
    h.ctx.step = { roundId: 'round_2', kind: other, path: null };
    const text = (await h.call('pk_confirm', { kind: 'breakpoint', id: 'bp_check', confirmed: true, why: 'x' })).text;
    assert.match(text, /nothing was written/i, `${other} does not light`);
  }
  assert.equal(h.store.breakpoints.get('bp_check')!.lit, false);
  // The cross-check still puts a candidate out, on evidence where it is Explicit (b236989: delivery commits tie as links).
  h.ctx.step = { roundId: 'round_2', kind: 'cross-check', path: null };
  await expectOk(h, 'pk_confirm', { kind: 'breakpoint', id: 'bp_check', confirmed: false, why: 'the alerts were checked in the cache review', evidence: [{ kind: 'commit', id: C_ALERTS }] });
  assert.deepEqual([h.store.breakpoints.get('bp_check')!.lit, h.store.breakpoints.get('bp_check')!.out?.by], [false, 'model']);
});

test('a candidate about delivery refuted with its commit is put out and the commit tied to the work (b236989)', async () => {
  const h = setup('spot-check');
  h.store.clerkRounds.put(DEEPEN);
  h.ctx.step = { roundId: 'round_2', kind: 'spot-check', path: null };
  h.store.breakpoints.put({ ...candidateOf('bp_done', 'No trace of done', 'thread_alerts'), looked: { roundId: 'round_2', jobId: 'job_lane', where: ['docs/PLAN.md'], at: AT } });
  const r = await expectOk(h, 'pk_confirm', { kind: 'breakpoint', id: 'bp_done', confirmed: false, why: 'the plan v2 commit adds storm.ts', evidence: [{ kind: 'commit', id: C_ALERTS }] });
  assert.equal(r.deliveryLinks, 1);
  const link = h.store.links.all().find((l) => l.workId === 'thread_alerts')!;
  assert.deepEqual([link.stepKind, link.confirmed], ['Delivered', true]);
  assert.equal(h.store.breakpoints.get('bp_done')!.lit, false);
});

test('refuting a numbered supersession breakpoint records the exact family and the deciding round', async () => {
  const h = setup('cross-check');
  const familyBasis = { lineId: 'sup:line-one', syntax: 'passive', replaced: 'D1' };
  h.store.breakpoints.put({ ...breakpoint('bp_down', 'Downstream behind', 'ref_d2', 'Inferred'), familyBasis });
  await expectOk(h, 'pk_confirm', { kind: 'breakpoint', id: 'bp_down', confirmed: false, why: 'D1 is cited as history, not as a current rule' });
  const out = h.store.breakpoints.get('bp_down')!;
  assert.equal(out.lit, false);
  assert.deepEqual(out.familyRefutations?.map((r) => [r.basis, r.decision.breakpointId, r.decision.roundId]), [[familyBasis, 'bp_down', 'round_1']]);
  assert.equal(out.out?.decision?.breakpointId, 'bp_down');
});

test('a code territory is made of the current code, serves an Area, and names each anomaly with its evidence', async () => {
  const h = setup('cross-check');
  const alerts = await expectOk(h, 'pk_write_territory', { name: 'Storm alerts', summary: 'Raises storm alerts from the feed.', repo: 'scope_main', paths: ['src/alerts', 'src/tides/feed.ts'], kind: 'area', areaId: 'ref_area_alerts', alsoServes: ['ref_area_tides'] });
  const t = h.store.territories.get(alerts.id as string)!;
  assert.deepEqual({ repo: t.repo, paths: t.paths, kind: t.kind, areaId: t.areaId, alsoServes: t.alsoServes }, { repo: ROOT, paths: ['src/alerts', 'src/tides/feed.ts'], kind: 'area', areaId: 'ref_area_alerts', alsoServes: ['ref_area_tides'] });

  await expectRefused(h, 'pk_write_territory', { ...TERRITORY, paths: ['src/gone'] }, /not in .*current tree: src\/gone/);
  await expectRefused(h, 'pk_write_territory', { ...TERRITORY, paths: ['docs/design/SYNC.md'] }, /current tree: docs\/design\/SYNC\.md/);
  await expectRefused(h, 'pk_write_territory', { ...TERRITORY, kind: 'area', areaId: 'ref_d2' }, /areaId must be an Area reference item; ref_d2 is not one/);
  await expectRefused(h, 'pk_write_territory', { ...TERRITORY, kind: 'shared', areaId: 'ref_area_tides' }, /serves no single area/);
  await expectRefused(h, 'pk_write_territory', { ...TERRITORY, alsoServes: ['ref_plan'] }, /alsoServes names what is not an Area/);
  await expectRefused(h, 'pk_write_territory', { ...TERRITORY, anomalies: [{ ...TERRITORY.anomalies[0], evidence: [] }] }, /cites no evidence/);
  await expectRefused(h, 'pk_write_territory', { ...TERRITORY, anomalies: [{ ...TERRITORY.anomalies[0], kind: 'Dead code' }] }, /kind must be one of Unreferenced/);

  const left = await expectOk(h, 'pk_write_territory', TERRITORY);
  const anomaly = h.store.territories.get(left.id as string)!.anomalies[0]!;
  assert.equal(anomaly.evidence[0]!.label, 'src/legacy/old.ts');
  assert.equal(anomaly.evidence[0]!.occurred?.at, UTC.start);
  assert.equal(anomaly.sixThing, 6, 'code nothing references is material for “looks residual” from the start (Spec §2.13)');
  const sb = await expectOk(h, 'pk_suggest_sendback', { to: 'Work', targetId: left.id, what: 'src/legacy is imported by nothing.', suggestion: 'new work: remove src/legacy', evidence: [{ kind: 'file', id: 'src/legacy/old.ts' }], from: { kind: 'code-anomaly', id: left.id } });
  assert.equal(h.store.territories.get(left.id as string)!.anomalies[0]!.sendBackId, sb.id, 'the anomaly points at its send-back');
  const rewritten = await expectOk(h, 'pk_write_territory', { ...TERRITORY, summary: 'Code left from the first sketch; nothing uses it.' });
  assert.equal(rewritten.updated, true);
  assert.equal(h.store.territories.get(left.id as string)!.anomalies[0]!.sendBackId, sb.id, 'the same anomaly written again keeps its send-back');
  const overlap = await expectOk(h, 'pk_write_territory', { ...TERRITORY, name: 'Old code', anomalies: [] });
  assert.match(String(overlap.warning), /also in/);
});

// ───────────────────────── synthesis: send-backs, the six things ─────────────────────────

test('a send-back is suggested with evidence, dated by its earliest evidence, and updated rather than duplicated', async () => {
  const h = setup('synthesis');
  const sb = await expectOk(h, 'pk_suggest_sendback', SENDBACK);
  const record = h.store.sendbacks.get(sb.id as string)!;
  assert.equal(record.stage, 'Suggested');
  assert.deepEqual(record.occurred, { at: UTC.start, basis: 'Commit', anchor: C_START }, 'the earliest of its evidence: the D1 line’s first commit');
  assert.equal(record.evidence.length, 2);
  assert.equal(record.sixThing, 5);
  assert.equal(sb.cli, `pk get ${sb.id} --project p1`);
  assert.equal(h.store.breakpoints.get('bp_findings')!.sendBackId, sb.id, 'the breakpoint points at its send-back');

  const again = await expectOk(h, 'pk_suggest_sendback', { ...SENDBACK, what: 'storm alerts passed QC with seven findings — nobody fixed', evidence: [{ kind: 'commit', id: C_CACHE }] });
  assert.deepEqual({ id: again.id, updated: again.updated, evidence: again.evidence }, { id: sb.id, updated: true, evidence: 3 });
  assert.equal(h.store.sendbacks.size, 1, 'the same problem on the same object is one send-back');

  await expectRefused(h, 'pk_suggest_sendback', { ...SENDBACK, stage: 'Returned' }, /Returned and Closed are recognised from the ledger/);
  await expectRefused(h, 'pk_suggest_sendback', { ...SENDBACK, occurred: { at: '2026-09-07', basis: 'Commit', anchor: null } }, /occurred is not yours to write/);
  // A new send-back carries its evidence; an update of the open one gives only what changes and keeps the rest.
  const other = { targetId: 'thread_cache', what: 'The offline cache was never merged.', from: { kind: 'breakpoint', id: 'bp_merge' } };
  await expectRefused(h, 'pk_suggest_sendback', { ...SENDBACK, ...other, evidence: [] }, /evidence is empty/);
  await expectRefused(h, 'pk_suggest_sendback', { targetId: other.targetId, what: other.what, suggestion: 'merge it' }, /^Invalid arguments: .*a new one needs to, evidence and from/);
  const reworded = await expectOk(h, 'pk_suggest_sendback', { targetId: SENDBACK.targetId, what: SENDBACK.what, suggestion: 'reopen the storm-alerts work and fix all seven findings' });
  assert.deepEqual({ id: reworded.id, updated: reworded.updated, evidence: reworded.evidence }, { id: sb.id, updated: true, evidence: 3 });
  const kept = h.store.sendbacks.get(sb.id as string)!;
  assert.deepEqual({ to: kept.to, from: kept.from, suggestion: kept.suggestion }, { to: 'Work', from: { kind: 'breakpoint', id: 'bp_findings' }, suggestion: 'reopen the storm-alerts work and fix all seven findings' });
  await expectRefused(h, 'pk_suggest_sendback', { ...SENDBACK, evidence: [{ kind: 'file', id: 'docs/PLAN.md', line: 'Plan v2: tide table, storm alerts and surf' }] }, /is not in docs\/PLAN\.md/);
  await expectRefused(h, 'pk_suggest_sendback', { ...SENDBACK, to: 'Owner' }, /to must be Work .* or Plan/);
  await expectRefused(h, 'pk_suggest_sendback', { ...SENDBACK, targetId: 'thread_nowhere' }, /is not an object of the assets/);
  await expectRefused(h, 'pk_suggest_sendback', { ...SENDBACK, from: { kind: 'breakpoint', id: 'bp_nowhere' } }, /is not a breakpoint/);
  await expectRefused(h, 'pk_suggest_sendback', { ...SENDBACK, sixThing: 9 }, /sixThing must be a whole number from 1 to 6/);

  // A closed one is history: the same problem found again is a new send-back.
  h.store.sendbacks.put({ ...h.store.sendbacks.get(sb.id as string)!, stage: 'Closed', closed: { by: record.evidence[0]!, at: AT } });
  const fresh = await expectOk(h, 'pk_suggest_sendback', SENDBACK);
  assert.notEqual(fresh.id, sb.id);
  assert.equal(h.store.sendbacks.size, 2);

  h.as('cross-check');
  await expectRefused(h, 'pk_suggest_sendback', SENDBACK, /only for a code anomaly/);
});

test('the six things are tagged where they are, and a breakpoint, mark or code anomaly takes the thing the Spec’s tables give it', async () => {
  const h = setup('cross-check');
  assert.deepEqual(await expectOk(h, 'pk_tag_six', { target: { kind: 'mark', id: 'mark_stale' }, thing: 1 }), { kind: 'mark', id: 'mark_stale', thing: 1, is: 'stale', on: 'Suspected stale' });
  assert.equal(h.store.marks.get('mark_stale')!.sixThing, 1);
  await expectRefused(h, 'pk_tag_six', { target: { kind: 'mark', id: 'mark_stale' }, thing: 2 }, /A Suspected stale mark is thing 1 \(stale\)/);
  await expectOk(h, 'pk_tag_six', { target: { kind: 'breakpoint', id: 'bp_findings' }, thing: 5 });
  assert.equal(h.store.breakpoints.get('bp_findings')!.sixThing, 5);
  await expectRefused(h, 'pk_tag_six', { target: { kind: 'breakpoint', id: 'bp_plan' }, thing: 4 }, /A Not planned breakpoint is thing 3/);
  await expectOk(h, 'pk_tag_six', { target: { kind: 'breakpoint', id: 'bp_merge' }, thing: 2 });
  await expectRefused(h, 'pk_tag_six', { target: { kind: 'note', id: 'note_dropped' }, thing: 7 }, /whole number from 1 to 6/);
  await expectRefused(h, 'pk_tag_six', { target: { kind: 'note', id: 'note_dropped' }, thing: 2.5 }, /whole number from 1 to 6/);
  await expectRefused(h, 'pk_tag_six', { target: { kind: 'note', id: 'note_nowhere' }, thing: 3 }, /is not a note/);

  // A code territory's anomalies are named by their territory and index.
  const both = {
    ...TERRITORY, anomalies: [
      { kind: 'Looks residual, is live', text: 'src/legacy looks left over; its name says so, its references do not.', evidence: [{ kind: 'file', id: 'src/legacy/old.ts' }], basis: 'Inferred' },
      { kind: 'Docs disagree', text: 'The plan no longer mentions the legacy code.', evidence: [{ kind: 'source', id: 'src_plan' }], basis: 'Explicit' },
    ],
  };
  const terr = await expectOk(h, 'pk_write_territory', both);
  const sixOf = () => h.store.territories.get(terr.id as string)!.anomalies.map((a) => a.sixThing);
  assert.deepEqual(sixOf(), [6, null], 'what the table fixes carries its thing from the start; the rest waits for a judgement');
  await expectRefused(h, 'pk_tag_six', { target: { kind: 'territory-anomaly', id: terr.id }, thing: 2 }, /target\.index: which of Leftovers.s 2 anomalies/);
  await expectRefused(h, 'pk_tag_six', { target: { kind: 'territory-anomaly', id: terr.id, index: 2 }, thing: 2 }, /target\.index/);
  await expectRefused(h, 'pk_tag_six', { target: { kind: 'territory-anomaly', id: terr.id, index: 0 }, thing: 4 }, /A code anomaly “Looks residual, is live” is thing 6 \(looks residual\)/);
  await expectRefused(h, 'pk_tag_six', { target: { kind: 'territory-anomaly', id: 'terr_nowhere', index: 0 }, thing: 6 }, /terr_nowhere is not a code territory/);
  assert.deepEqual(
    await expectOk(h, 'pk_tag_six', { target: { kind: 'territory-anomaly', id: terr.id, index: 1 }, thing: 2 }),
    { kind: 'territory-anomaly', id: terr.id, index: 1, thing: 2, is: 'drift', on: 'Leftovers: Docs disagree' },
  );
  assert.deepEqual(sixOf(), [6, 2]);
  await expectOk(h, 'pk_tag_six', { target: { kind: 'territory-anomaly', id: terr.id, index: 0 }, thing: 6 });
  await expectOk(h, 'pk_write_territory', { ...both, summary: 'Code left from the first sketch, written again.' });
  assert.deepEqual(sixOf(), [6, 2], 'a territory written again keeps what its anomalies were tagged');

  h.as('synthesis');
  // CN (E152): dropped along the way says nothing took it up afterwards — the judgement carries what was read.
  await expectRefused(h, 'pk_tag_six', { target: { kind: 'note', id: 'note_dropped' }, thing: 3 }, /Tagging this note as dropped along the way[^\n]*Such a claim carries what was read/);
  await expectOk(h, 'pk_tag_six', { target: { kind: 'note', id: 'note_dropped' }, thing: 3, looked: { where: ['the plan’s later versions', 'pk_ledger_commits keyword=export'], upTo: '2026-09-27' } });
  assert.equal(h.store.notes.get('note_dropped')!.sixThing, 3);
  const sb = await expectOk(h, 'pk_suggest_sendback', SENDBACK);
  await expectOk(h, 'pk_tag_six', { target: { kind: 'sendback', id: sb.id }, thing: 2 });
  assert.equal(h.store.sendbacks.get(sb.id as string)!.sixThing, 2);
});

// ───────────────────────── spot check ─────────────────────────

test('the spot check records what it checked into the round, each judgement once whichever session checks it; a correction counts only once that job has made it', async () => {
  const h = setup('skeleton');
  const patch = await expectOk(h, 'pk_write_patch', PATCH);
  h.as('spot-check');
  const before = h.store.clerkRounds.get('round_1')!.spotCheck;
  await expectRefused(h, 'pk_record_spot_check', { checked: [{ target: { collection: 'threads', id: 'thread_feed' }, kind: 'code state', verdict: 'Wrong', correction: 'fixed the progress' }] }, /nothing in this job wrote to threads thread_feed/);
  await expectRefused(h, 'pk_record_spot_check', { checked: [{ target: { collection: 'jobs', id: 'job_clerk' }, kind: 'x', verdict: 'Right' }] }, /is not a collection of judgements/);
  await expectRefused(h, 'pk_record_spot_check', { checked: [{ target: { collection: 'patches', id: 'patch_nowhere' }, kind: 'x', verdict: 'Right' }] }, /is not in patches/);
  await expectRefused(h, 'pk_record_spot_check', { checked: [{ target: { collection: 'threads', id: 'thread_feed' }, kind: 'code state', verdict: 'Maybe' }] }, /verdict must be Right or Wrong/);
  assert.equal(h.store.clerkRounds.get('round_1')!.spotCheck, before, 'a refused record counts nothing');

  // The correction first, with the writer of that position; then the record of it.
  await expectOk(h, 'pk_confirm', { kind: 'patch', id: patch.id, confirmed: false, why: 'D2 withdraws only the nightly schedule, not the feed' });
  const first = await expectOk(h, 'pk_record_spot_check', { checked: [
    { target: { collection: 'patches', id: patch.id }, kind: 'supersession', verdict: 'Wrong', correction: 'rejected: the line withdraws only the schedule' },
    { target: { collection: 'threads', id: 'thread_alerts' }, kind: 'code state', verdict: 'Right' },
  ] });
  // D103: what is checked in full — every current note, what the synthesis wrote, the Result — is counted apart from the sample.
  const inFull = h.store.notes.filter((n) => n.status === 'Current');
  assert.ok(inFull.length > 0, 'the fixture has a current note');
  assert.deepEqual(first.spotCheck, { sampled: 2, wrong: 1, byKind: { supersession: 1 }, corrected: 1, wrongByKind: { timing: 0, substance: 1 }, synthesis: { outputs: inFull.length, checked: 0, wrong: 0 } });
  assert.match(String(first.note), new RegExp(`${inFull.length} of the ${inFull.length} targets checked in full .* are not recorded yet`));
  const spot = () => h.store.clerkRounds.get('round_1')!.spotCheck!;
  const counts = () => { const { targets: _targets, synthesis: _synthesis, ...rest } = spot(); return rest; };
  assert.deepEqual(spot().targets, [
    { collection: 'patches', id: patch.id, kind: 'supersession', wrong: true, corrected: true, wrongKind: 'substance' },
    { collection: 'threads', id: 'thread_alerts', kind: 'code state', wrong: false, corrected: false },
  ], 'what was checked is kept, one entry per collection and id');
  await expectOk(h, 'pk_record_spot_check', { checked: [{ target: { collection: 'threads', id: 'thread_feed' }, kind: 'code state', verdict: 'Wrong' }] });
  assert.deepEqual(counts(), { sampled: 3, wrong: 2, byKind: { supersession: 1, 'code state': 1 }, corrected: 1, wrongByKind: { timing: 0, substance: 2 } });
  await expectOk(h, 'pk_record_spot_check', { checked: [{ target: { collection: 'threads', id: 'thread_feed' }, kind: 'code state', verdict: 'Right' }] });
  assert.deepEqual(counts(), { sampled: 3, wrong: 2, byKind: { supersession: 1, 'code state': 1 }, corrected: 1, wrongByKind: { timing: 0, substance: 2 } }, 'checked again it is one judgement, and one found wrong stays counted wrong');

  // The spot check run again in another session — its own job and tools — counts each judgement once. The patch it
  // finds right now was corrected in the first session: the round still made that error, and it stays corrected.
  const second = setup('spot-check', { jobId: 'job_clerk_2' }, h.store);
  await expectOk(second, 'pk_record_spot_check', { checked: [
    { target: { collection: 'patches', id: patch.id }, kind: 'supersession', verdict: 'Right' },
    { target: { collection: 'threads', id: 'thread_alerts' }, kind: 'code state', verdict: 'Right' },
    { target: { collection: 'breakpoints', id: 'bp_plan' }, kind: 'nobody handled it', verdict: 'Wrong', wrongKind: 'timing' },
  ] });
  // CM: a wrong by timing (the candidate was recomputed after its link was confirmed) is counted apart from a wrong of substance.
  assert.deepEqual(counts(), { sampled: 4, wrong: 3, byKind: { supersession: 1, 'code state': 1, 'nobody handled it': 1 }, corrected: 1, wrongByKind: { timing: 1, substance: 2 } });
  await expectRefused(second, 'pk_record_spot_check', { checked: [{ target: { collection: 'breakpoints', id: 'bp_plan' }, kind: 'nobody handled it', verdict: 'Wrong', wrongKind: 'late' }] }, /wrongKind must be timing or substance/);
  await expectRefused(second, 'pk_record_spot_check', { checked: [{ target: { collection: 'threads', id: 'thread_feed' }, kind: 'progress', verdict: 'Wrong', correction: 'progress back to In progress' }] }, /nothing in this job wrote to threads thread_feed/);
  // The second session corrects it with the writer of the work item (its trace names this job), then records it.
  h.store.threads.put({ ...h.store.threads.get('thread_feed')!, progress: 'In progress' }, { jobId: 'job_clerk_2', summary: 'Progress corrected by the spot check' });
  await expectOk(second, 'pk_record_spot_check', { checked: [{ target: { collection: 'threads', id: 'thread_feed' }, kind: 'progress', verdict: 'Wrong', correction: 'progress back to In progress' }] });
  const end = spot();
  assert.deepEqual(counts(), { sampled: 4, wrong: 3, byKind: { supersession: 1, progress: 1, 'nobody handled it': 1 }, corrected: 2, wrongByKind: { timing: 1, substance: 2 } }, 'a later record of a wrong one gives its kind');
  assert.deepEqual(
    { sampled: end.targets!.length, wrong: end.targets!.filter((t) => t.wrong).length, corrected: end.targets!.filter((t) => t.corrected).length },
    { sampled: end.sampled, wrong: end.wrong, corrected: end.corrected }, 'every count is the targets’ own',
  );

  // A note checked: it counts among what is checked in full, apart from the sample.
  const noted = await expectOk(second, 'pk_record_spot_check', { checked: [{ target: { collection: 'notes', id: inFull[0]!.id }, kind: 'decided or not', verdict: 'Wrong' }] });
  assert.deepEqual((noted.spotCheck as { synthesis: unknown }).synthesis, { outputs: inFull.length, checked: 1, wrong: 1 });
  assert.equal(spot().sampled, 5, 'the total counts every check');

  h.ctx.step = { roundId: 'round_x', kind: 'spot-check', path: null };
  await expectRefused(h, 'pk_record_spot_check', { checked: [{ target: { collection: 'threads', id: 'thread_feed' }, kind: 'x', verdict: 'Right' }] }, /round_x is not registered/);
});

// ───────────────────────── session drafts (§3.11) ─────────────────────────

test('a session draft holds the owner’s words as the session has them; the model only classifies them and summarises the agents', async () => {
  const h = setup('session-drafts');
  const confirms = 'the owner confirmed the agent’s proposal to replace the nightly pull with an offline cache';
  const args = {
    session: { host: 'claude', sessionId: 'sess-tide-1' },
    lines: [{ ref: '[2]', kind: 'Confirmation', confirms }, { ref: '0', kind: 'Chat' }],
    agentSummary: [{ at: '[1]', who: 'Claude Code (claude-opus)', summary: 'Proposed an offline cache replacing the nightly pull.' }, { who: 'Claude Code', summary: 'Built nothing in this session.' }],
  };
  const r = await expectOk(h, 'pk_write_session_draft', args);
  assert.deepEqual({ ownerLines: r.ownerLines, classified: r.classified, readFrom: r.readFrom }, { ownerLines: 2, classified: 2, readFrom: 'session log' });
  const draft = h.store.drafts.get(r.id as string)!;
  assert.deepEqual(draft.session, { host: 'claude', sessionId: 'sess-tide-1', file: LOG, startedAt: '2026-09-02T01:00:10.000Z', endedAt: '2026-09-02T03:30:45.000Z' });
  assert.deepEqual(draft.ownerLines, [
    { ref: '0', at: '2026-09-02T01:00:10.000Z', text: 'Can the app work offline?', kind: 'Chat', answers: null, confirms: null },
    { ref: '2', at: '2026-09-02T03:30:45.000Z', text: 'yes, go with the cache', kind: 'Confirmation', answers: 'I propose an offline cache that replaces the nightly pull.', confirms },
  ], 'the owner’s words verbatim with their times; a confirmation carries the agent message it answers');
  assert.deepEqual(draft.agentSummary.map((s) => s.at), ['2026-09-02T01:05:20.000Z', '2026-09-02T01:00:10.000Z'], 'the program reads the time of the message a summary points at');

  await expectRefused(h, 'pk_write_session_draft', { ...args, lines: [{ ref: '2', kind: 'Chat', text: 'yes, go with the cache' }] }, /taken from the session by the program/);
  await expectRefused(h, 'pk_write_session_draft', { ...args, lines: [{ ref: '[1]', kind: 'Chat' }] }, /ref \[1\] is not one of the owner’s messages in this session \(their positions: 0, 2\)/);
  await expectRefused(h, 'pk_write_session_draft', { ...args, lines: [{ ref: '2', kind: 'Confirmation' }] }, /say in confirms what the owner confirmed/);
  await expectRefused(h, 'pk_write_session_draft', { ...args, lines: [{ ref: '0', kind: 'Chat', confirms: 'x' }] }, /confirms belongs to a Confirmation only/);
  await expectRefused(h, 'pk_write_session_draft', { ...args, lines: [{ ref: '0', kind: 'Instruction' }] }, /kind must be one of Chat, Decision, Confirmation/);
  await expectRefused(h, 'pk_write_session_draft', { ...args, agentSummary: [{ at: '2026-09-02', who: 'Claude Code', summary: 'x' }] }, /a time is never written/);
  await expectRefused(h, 'pk_write_session_draft', { ...args, session: { host: 'cursor', sessionId: 'sess-tide-1' } }, /session\.host must be one of claude, codex, pi/);
  await expectRefused(h, 'pk_write_session_draft', { ...args, session: { host: 'claude', sessionId: 'sess-nowhere' } }, /No claude session sess-nowhere/);

  const later = await expectOk(h, 'pk_write_session_draft', { ...args, lines: [{ ref: '0', kind: 'Decision' }], agentSummary: [] });
  assert.equal(later.updated, true);
  const redrafted = h.store.drafts.get(r.id as string)!;
  assert.deepEqual(redrafted.ownerLines.map((l) => l.kind), ['Decision', 'Confirmation'], 'a line not classified again keeps its kind');
  assert.equal(redrafted.ownerLines[1]!.confirms, confirms);
  assert.equal(h.store.drafts.size, 1, 'one draft per session');
});

test('a line cited by its ledger message id keeps that id as its ref; a Keeper conversation is drafted from the messages the assets keep', async () => {
  const entry = { label: 'owner · sess-tide-1 · message 2', occurred: { at: '2026-09-02T03:30:45.000Z', basis: 'Session' as const, anchor: 'led_msg_2' }, text: 'yes, go with the cache' };
  const ledger: LedgerHook = { resolve: (id) => (id === 'led_msg_2' ? entry : null) };
  const h = setup('session-drafts', { ledger });
  const session = { host: 'claude', sessionId: 'sess-tide-1' };
  const first = await expectOk(h, 'pk_write_session_draft', { session, lines: [{ ref: 'led_msg_2', kind: 'Confirmation', confirms: 'the owner confirmed the offline cache' }], agentSummary: [] });
  const lines = () => h.store.drafts.get(first.id as string)!.ownerLines;
  assert.deepEqual(lines().map((l) => [l.ref, l.kind]), [['0', null], ['led_msg_2', 'Confirmation']], 'an unclassified line stays unjudged');
  assert.equal(lines()[1]!.answers, 'I propose an offline cache that replaces the nightly pull.', 'the session supplies the message it answers');
  await expectOk(h, 'pk_write_session_draft', { session, lines: [{ ref: '0', kind: 'Chat' }], agentSummary: [] });
  assert.deepEqual(lines().map((l) => [l.ref, l.kind]), [['0', 'Chat'], ['led_msg_2', 'Confirmation']], 'a line once known by its ledger id keeps the id and its kind');
  await expectRefused(h, 'pk_write_session_draft', { session, lines: [{ ref: 'led_msg_9', kind: 'Chat' }], agentSummary: [] }, /ref led_msg_9 is not one of the owner’s messages/);

  const pi = (id: string, turn: number, by: 'owner' | 'agent', words: string): Source => {
    const heading = `[${by} 2026-09-20 10:0${turn}]\n`;
    return { ...source(id, { kind: 'session', host: 'pi', sessionId: 'conv_1', file: '', cwd: ROOT, messageStart: turn, messageEnd: turn, at: `2026-09-20T10:0${turn}:00.000Z` }, `${heading}${words}`), said: { by, wordsFrom: heading.length } };
  };
  h.store.sources.put(pi('src_pi_1', 1, 'owner', 'Keep the alerts quiet at night.'));
  h.store.sources.put(pi('src_pi_2', 2, 'agent', 'Which alerts does the owner want?'));
  h.store.sources.put(pi('src_pi_3', 3, 'owner', 'Yes, do that.'));
  const conv = await expectOk(h, 'pk_write_session_draft', { session: { host: 'pi', sessionId: 'conv_1' }, lines: [{ ref: '1', kind: 'Decision' }], agentSummary: [] });
  assert.equal(conv.readFrom, 'Keeper conversation');
  assert.deepEqual(h.store.drafts.get(conv.id as string)!.ownerLines.map((l) => [l.ref, l.at, l.text, l.kind]), [
    ['1', '2026-09-20T10:01:00.000Z', 'Keep the alerts quiet at night.', 'Decision'],
    ['3', '2026-09-20T10:03:00.000Z', 'Yes, do that.', null],
  ], 'the owner’s messages only: an agent’s query is not the owner speaking');
});

test('with the session log gone, the draft is read from the transcripts the assets keep', async () => {
  const h = setup('session-drafts');
  const r = await expectOk(h, 'pk_write_session_draft', { session: { host: 'claude', sessionId: 'sess-tide-0' }, lines: [{ ref: '2', kind: 'Confirmation', confirms: 'the owner confirmed the offline cache' }], agentSummary: [{ at: '1', who: 'Claude Code', summary: 'Proposed the cache.' }] });
  assert.equal(r.readFrom, 'transcripts in the assets');
  const draft = h.store.drafts.get(r.id as string)!;
  assert.deepEqual(draft.ownerLines.map((l) => [l.ref, l.at, l.text]), [['0', '2026-09-02T01:00:00.000Z', 'Can the app work offline?'], ['2', '2026-09-02T03:30:00.000Z', 'yes, go with the cache']], 'the minutes the transcript shows');
  assert.equal(draft.ownerLines[1]!.answers, 'I propose an offline cache that replaces the nightly pull.', 'the agent message before it, without its tool lines');
  assert.equal(draft.agentSummary[0]!.at, '2026-09-02T01:05:00.000Z');
});

// ───────────────────────── an update gives only what changes (BI; test-D-1) ─────────────────────────

test('a clerk position written again gives only what changes, and a new one says exactly what it needs', async () => {
  // Every writer here that creates or updates a position takes the position that exists — its id, or the key it is
  // found by — and keeps what the call leaves out. A call that would create one without what a new one needs is refused
  // as incomplete (thrown, so pi returns it as an error the refusal guard reads), and writes nothing.
  const h = setup('orientation');
  const incomplete = (name: string, args: Record<string, unknown>, missing: RegExp) => expectRefused(h, name, args, new RegExp(`^Invalid arguments: .*${missing.source}.*Nothing was written`, 's'));

  // The layer map: a path mapped again with only what changes.
  await expectOk(h, 'pk_write_layers', { entries: [{ path: 'docs/PLAN.md', layer: 'Plan', current: true, note: 'the plan the project works to' }] });
  const plan = () => h.store.layers.all().find((l) => l.path === 'docs/PLAN.md')!;
  await expectOk(h, 'pk_write_layers', { entries: [{ path: 'docs/PLAN.md', current: false }] });
  assert.deepEqual({ layer: plan().layer, current: plan().current, note: plan().note }, { layer: 'Plan', current: false, note: 'the plan the project works to' });
  const partly = await expectOk(h, 'pk_write_layers', { entries: [{ path: 'docs/PLAN.md', note: 'superseded by the board' }, { path: 'docs/DECISIONS.md', current: true }] });
  assert.equal(partly.written, 1, 'the entry that updates is written');
  assert.match((partly.refused as string[])[0]!, /docs\/DECISIONS\.md\): not mapped yet, so this entry would map it, and a new entry needs layer/);
  await incomplete('pk_write_layers', { entries: [{ path: 'docs/DECISIONS.md' }] }, /a new entry needs layer and current/);
  assert.equal(h.store.layers.size, 1);

  // A generation, found by its name: what began it and the work planned in it stay.
  const g = await expectOk(h, 'pk_write_generation', { name: 'Nightly-sync generation', ended: { kind: 'commit', id: C_DROP }, started: { kind: 'commit', id: C_START }, planRefs: [{ kind: 'source', id: 'src_plan' }], workIds: ['thread_feed'] });
  const before = h.store.generations.get(g.id as string)!;
  const renamed = await expectOk(h, 'pk_write_generation', { name: 'Nightly-sync  generation', planRefs: [{ kind: 'file', id: 'docs/design/SYNC.md' }, { kind: 'source', id: 'src_plan' }] });
  assert.deepEqual([renamed.id, renamed.updated], [g.id, true]);
  const after = h.store.generations.get(g.id as string)!;
  assert.deepEqual({ started: after.started, ended: after.ended, endedBy: after.endedBy, workIds: after.workIds }, { started: before.started, ended: before.ended, endedBy: before.endedBy, workIds: before.workIds }, 'what began and ended it, and its work, stay');
  assert.equal(after.planRefs.length, 2);
  await incomplete('pk_write_generation', { name: 'Offline generation', planRefs: [] }, /No generation is recorded as “Offline generation”, so this call would create a generation, and a new one needs ended/);
  assert.equal(h.store.generations.size, 1);

  // A round document written again with a new title keeps its text; a new one needs its text.
  const q = await expectOk(h, 'pk_write_round_doc', { kind: 'Questions', title: 'What this round asks', markdown: '1. What is current?' });
  await expectOk(h, 'pk_write_round_doc', { kind: 'Questions', title: 'The round’s questions' });
  assert.deepEqual([h.store.roundDocs.get(q.id as string)!.title, h.store.roundDocs.get(q.id as string)!.markdown], ['The round’s questions', '1. What is current?']);
  await incomplete('pk_write_round_doc', { kind: 'History map', title: 'History map' }, /This round has no History map document yet, so this call would create a History map document, and a new one needs markdown/);

  // A code territory, found by its repository and name: its paths, kind and anomalies stay.
  h.as('cross-check');
  const t = await expectOk(h, 'pk_write_territory', TERRITORY);
  const territory = h.store.territories.get(t.id as string)!;
  const summary = 'Code left from the first sketch; nothing imports it.';
  assert.equal((await expectOk(h, 'pk_write_territory', { name: 'Leftovers', repo: 'scope_main', summary })).updated, true);
  const now = h.store.territories.get(t.id as string)!;
  assert.deepEqual({ ...now, summary: '', updatedAt: '' }, { ...territory, summary: '', updatedAt: '' }, 'only the summary changed');
  assert.equal(now.summary, summary);
  await incomplete('pk_write_territory', { name: 'Alerts code', repo: 'scope_main', paths: ['src/alerts'] }, /has no territory named “Alerts code”, so this call would create a code territory, and a new one needs summary and kind/);

  // A session draft: a later call that classifies lines only keeps the agents’ summary.
  h.as('session-drafts');
  const session = { host: 'claude', sessionId: 'sess-tide-1' };
  await incomplete('pk_write_session_draft', { session, lines: [{ ref: '0', kind: 'Chat' }] }, /claude session sess-tide-1 has no draft yet, so this call would create a session draft, and a new one needs agentSummary/);
  const d = await expectOk(h, 'pk_write_session_draft', { session, lines: [{ ref: '0', kind: 'Chat' }], agentSummary: [{ at: '[1]', who: 'Claude Code', summary: 'Proposed the offline cache.' }] });
  await expectOk(h, 'pk_write_session_draft', { session, lines: [{ ref: '2', kind: 'Confirmation', confirms: 'the owner confirmed the offline cache' }] });
  const draft = h.store.drafts.get(d.id as string)!;
  assert.deepEqual(draft.agentSummary.map((s) => s.summary), ['Proposed the offline cache.'], 'the summary stays');
  assert.deepEqual(draft.ownerLines.map((l) => l.kind), ['Chat', 'Confirmation']);
});
