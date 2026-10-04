/**
 * CN (E152), after the CM run — on "Forge", an invented smithy with three modules, a plan with a contract table, a
 * decision record and a ticket index:
 *
 *   B · absence claims carry what was read: a note that says "no follow-up", "let pass" or "nobody took it up" is
 *       refused in a round without `looked`; a look that stops before the ledger's newest session or commit is said on
 *       the note's line (`As far as read — …`); a six-things judgement of dropped (3) or let pass (5) needs it too; the
 *       lanes' Unsure items are listed for the synthesis and the spot-check, and by key;
 *   C · work for its whole plan (`wholePlanWhy`) is placed and not counted in no module, and the program suggests it
 *       where a range the ticket writes spans three modules; a work item in no plan is given the plan the decisions it
 *       carries out, cites or is cited by lead to.
 *
 * The spot-check of the CM run found 3 wrong of 29, all three absence or list claims written at the synthesis; four work
 * items stayed "unplaced" (AB, AC: P1 work for no single module; AD, AF: no plan, though the decision they carry out is
 * P1's trial arrangement).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Project, ScopeItem, Source } from '../../model/types.ts';
import type { ClerkRound, ClerkStage, LayerEntry, RoundDoc, RoundKind, SendBack } from '../../model/k-types.ts';
import { ProjectStore } from '../../store/project-store.ts';
import { Ledger } from '../../ledger/index.ts';
import { ledgerPath, rebuildLedgerInPlace } from '../../ledger/rebuild.ts';
import { keeperTools } from '../tools.ts';
import { clerkTools, type ClerkToolContext } from '../clerk-tools.ts';
import { stageTools } from './stage-tools.ts';
import { roundOpen, unplacedNote } from './round-open.ts';
import { planThroughDecisions, wholePlanSuggestion } from './placing.ts';
import { absenceClaims, absenceLookedBlock, behindOf, laneUnsure, ledgerPresent, parseLooked, stampAsFarAs, unsureBlock, unsureIn } from './absence.ts';
import { stageSkill, synthesisSkill, spotCheckSkill } from './skills.ts';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-cn-'));
after(() => { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const AT = '2026-09-30T10:00:00.000Z';

// ───────────────────────── the project and its ledger ─────────────────────────

const repo = join(scratch, 'forge');
mkdirSync(repo);
const git = (args: string[], date: string): string => execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 'Forge', GIT_AUTHOR_EMAIL: 'f@forge.invalid', GIT_COMMITTER_NAME: 'Forge', GIT_COMMITTER_EMAIL: 'f@forge.invalid' }, windowsHide: true,
}).trim();
const files: Record<string, string> = {};
const write = (rel: string, text: string) => { files[rel] = text; const full = join(repo, rel); mkdirSync(resolve(full, '..'), { recursive: true }); writeFileSync(full, text); };

git(['init', '-q', '-b', 'main'], '2026-09-01T12:00:00Z');
git(['config', 'core.autocrlf', 'false'], '2026-09-01T12:00:00Z');
write('docs/PRD.md', ['# Forge PRD', '', '## 4 · Modules', '', '| Module | Effect |', '| --- | --- |', '| FG-M1 · Smelt | ore becomes metal |', '| FG-M2 · Cast | metal takes a shape |', '| FG-M3 · Temper | the shape holds an edge |', ''].join('\n'));
write('docs/PLAN.md', [
  '# Forge plan', '', '## 3 · Increments', '', '### P1 · First blade', '', 'Smelt, cast and temper one blade.', '', '### P2 · Many blades', '', 'A rack of blades.', '',
  '## 7 · Contracts', '',
  '| ID | Contract | Increment | Module | Status |', '| --- | --- | --- | --- | --- |',
  '| FGC-01 | The smelt | P1 | FG-M1 | ready |', '| FGC-02 | The cast | P1 | FG-M2 | ready |', '| FGC-03 | The temper | P1 | FG-M3 | ready |', '| FGC-04 | The rack | P2 | FG-M1 | draft |', '',
].join('\n'));
write('docs/DECISIONS.md', [
  '# Decisions', '',
  '**D1 · Smelt before cast.** 影响：FGC-01、FGC-02。', '',
  '**D2 · The trial batch is frozen and moved out.** Redone the way D1 says.', '',
  '**D3 · The rack waits.** The ticket AE is put off; 影响：增量 P2 的安排。', '',
  '**D4 · One blade is tried on a real cut.** The owner: 「先切一刀」.', '',
  '**D5 · The same tongs at every station.** No station gets tongs of its own.', '',
].join('\n'));
write('subagent/INDEX.md', [
  '# Index', '', '## Tickets', '', '| ID | Executor | Ticket |', '| --- | --- | --- |',
  '| AA | kimi | Milestone QC (FGC-01～FGC-03) |', '| AB | pi | Reading of the whole graph |', '| AD | kimi | Audit of the trial batch · archived (D2) |', '| AE | sol | The rack, first half |', '| AF | sol | The real cut |', '',
].join('\n'));
const prompt = (id: string, title: string, body: string) => `---\nid: "${id}"\nexecutor: "claude"\nstatus: "done"\n---\n\n# ${id} · ${title}\n\n${body}\n`;
write('subagent/AA-milestone-qc.md', prompt('AA', 'Milestone QC', 'Judge every contract of the increment.'));
write('subagent/AB-whole-graph.md', prompt('AB', 'Reading of the whole graph', 'Does the graph show FGC-01～03 as one path from ore to edge?'));
write('subagent/AE-rack.md', prompt('AE', 'The rack, first half', 'Build the first half of the rack.'));
git(['add', '-A'], '2026-09-01T12:00:00Z');
git(['commit', '-q', '-m', 'Plan the forge'], '2026-09-01T12:00:00Z');
/** The newest commit of the ledger: what a look in commits has to reach. */
const NEWEST_COMMIT = '2026-09-01T12:00:00Z';

const scope = { id: 'scope_forge', path: repo, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null,
  readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as unknown as ScopeItem;
const project = { id: 'forge', name: 'Forge', locations: [repo], scope: [scope], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en',
  organizingPaused: false, createdAt: AT, lastOpenedAt: null, lastScopedAt: null, takeoverDepth: 'Full' } as unknown as Project;
const baseHome = mkdtempSync(join(scratch, 'home-'));
rebuildLedgerInPlace(ledgerPath(project.id, baseHome), project);

const LAYERS: [string, LayerEntry['layer'], boolean][] = [['docs/PRD.md', 'PRD', true], ['docs/PLAN.md', 'Plan', true], ['docs/DECISIONS.md', 'Decision record', true], ['subagent/INDEX.md', 'Task index', true]];

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
    id: 'round_1', projectId: project.id, kind, number: 2, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root',
    questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT,
    stage, stageLog: [{ stage, startedAt: AT, endedAt: null, timing: null }], lanes: [],
  } as ClerkRound;
}

type Called = { text: string; error: boolean; json: Record<string, unknown> };

/** A workbench on Forge as a deepening finds it: modules, plans, contracts in their modules, decisions on the product, tickets placed nowhere. */
async function bench(stage: ClerkStage = 'cross-check', opts: { readonly inRound?: boolean; readonly session?: { started: string; ended: string } } = {}) {
  const home = mkdtempSync(join(scratch, 'bench-'));
  const store = ProjectStore.open(project.id, home);
  copyFileSync(ledgerPath(project.id, baseHome), join(store.dir, 'ledger.sqlite'));
  if (opts.session) {
    // A session the ledger read: the owner's window, still going after the lanes read their part of it.
    const db = new DatabaseSync(join(store.dir, 'ledger.sqlite'));
    db.prepare('INSERT INTO sessions (key, host, session_id, file, cwd, started_at, ended_at, messages, owner_messages, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('session:forge1', 'claude', 's-forge-1', join(scratch, 's-forge-1.jsonl'), repo, opts.session.started, opts.session.ended, 40, 12, AT);
    db.close();
  }
  for (const [path, layer, current] of LAYERS) store.layers.put({ id: `layer_${path}`, projectId: project.id, repo, path, layer, note: null, current, roundId: null, updatedAt: AT });
  for (const [rel, text] of Object.entries(files)) for (const s of sectionSources(rel, text)) store.sources.put(s);
  store.clerkRounds.put(round('Deepen', 'reconcile'));
  const step = { roundId: 'round_1', kind: 'main', path: null };
  const ctx = { store, project, jobId: 'job_main', jobKind: 'Organizing', model: null, step, stageEntered: () => ({ note: null }) } as unknown as ClerkToolContext;
  const tools: ToolDefinition[] = [...keeperTools(ctx), ...clerkTools(ctx), ...stageTools(ctx, { coverageSettled: () => true, stageSkill: (s) => `SKILL ${s}` })];
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
  const setStage = (s: ClerkStage) => store.clerkRounds.put({ ...store.clerkRounds.get('round_1')!, stage: s });
  const ledger = () => Ledger.openDir(store.dir)!;
  const src = (rel: string, heading: string) => store.sources.find((s) => s.anchor.kind === 'file' && s.anchor.path.replace(/\\/g, '/').endsWith(rel) && s.title === heading)!.id;
  const ref = (category: string, name: string, extra: Record<string, unknown> = {}) => ok('pk_write_reference', { category, name, text: name, basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: [src('docs/PRD.md', '4 · Modules')], ...extra });
  const byNumber = (n: string) => store.threads.find((t) => t.ids.includes(n))!;
  const refBy = (n: string, category?: string) => store.reference.find((r) => r.ids.includes(n) && (!category || r.category === category))!;

  const product = (await ref('Product', 'Forge')).id as string;
  const goal = (await ref('Goal', 'A blade that holds its edge', { refines: [product] })).id as string;
  const m1 = (await ref('Area', 'FG-M1 · Smelt', { ids: ['FG-M1'], refines: [goal] })).id as string;
  const m2 = (await ref('Area', 'FG-M2 · Cast', { ids: ['FG-M2'], refines: [goal] })).id as string;
  const m3 = (await ref('Area', 'FG-M3 · Temper', { ids: ['FG-M3'], refines: [goal] })).id as string;
  const p1 = (await ref('Plan', 'P1 · First blade', { ids: ['P1'], refines: [product], sourceIds: [src('docs/PLAN.md', 'P1 · First blade')] })).id as string;
  const p2 = (await ref('Plan', 'P2 · Many blades', { ids: ['P2'], refines: [product], sourceIds: [src('docs/PLAN.md', 'P2 · Many blades')] })).id as string;
  await ok('pk_fill_from_table', { path: 'docs/PLAN.md', table: { heading: 'Contracts' }, into: 'threads', category: 'Requirement', columns: { title: 'Contract', id: 'ID', parent: 'Module', plan: 'Increment', status: 'Status' } });
  await ok('pk_fill_from_table', { path: 'subagent/INDEX.md', table: { heading: 'Tickets' }, into: 'threads', columns: { title: 'Ticket', id: 'ID' } });
  await ok('pk_fill_from_bold', { path: 'docs/DECISIONS.md', category: 'Decision' });
  for (const n of ['D1', 'D2', 'D3', 'D4', 'D5']) await ok('pk_write_reference', { id: refBy(n, 'Decision').id, refines: [product] });
  // The milestone QC and the reading of the whole graph are in P1 (the index's own batch); the others in no plan.
  for (const n of ['AA', 'AB']) await ok('pk_write_thread', { id: n, serves: [{ referenceId: p1, claim: 'INDEX: the P1 batch', basis: 'Explicit' }] });
  // D103: the synthesis is a job of its own, after the main agent's handover from its last stage.
  if (stage === 'synthesis') {
    store.clerkRounds.put({ ...store.clerkRounds.get('round_1')!, stage: 'cross-check', handover: { at: AT, docId: 'rdoc_handover' } });
    (ctx as { step: unknown }).step = { roundId: 'round_1', kind: 'synthesis', path: null };
  } else setStage(stage);
  if (opts.inRound === false) (ctx as { step: unknown }).step = null;
  const judgement = async () => (await ok('pk_record_judgement', { scopeKind: 'project', scopeIds: [], scopeLabel: 'Synthesis', referenceIds: [], threadIds: [], areaIds: [], relationIds: [], keyEvidenceSourceIds: [], conflictingSourceIds: [], previousNoteIds: [], excluded: [] })).id as string;
  const open = (extra: { suggest?: boolean } = {}) => { const l = ledger(); try { return roundOpen(store, store.clerkRounds.get('round_1')!, { ledger: l, ...extra }); } finally { l.close(); } };
  return { store, call, ok, setStage, ledger, byNumber, refBy, judgement, open, ids: { product, goal, m1, m2, m3, p1, p2 } };
}

const note = (judgementRecordId: string, extra: Record<string, unknown> = {}) => ({
  mountKind: 'project', mountIds: [], title: 'The owner’s question about the tongs', ask: 'For information', reason: 'synthesis', judgementRecordId,
  preview: 'The owner asked why every station has the same tongs; no follow-up in the sessions.', ...extra,
});

// ───────────────────────── B · absence claims carry what was read ─────────────────────────

test('which lines claim an absence: no follow-up, let pass, nobody took it up — in the project’s language too', () => {
  for (const line of [
    'After the owner’s question there was no follow-up.', 'The finding was let pass.', 'Nobody took it up.', 'It was never answered.', 'F-6 was not handled by any later ticket.',
    '底稿里未见后续回答', '两条 UI 碎线未见下文', '余下四项无人再接', '这条发现被放过去了', 'Dropped along the way: the export button.',
  ]) assert.deepEqual(absenceClaims(line), [line], line);
  for (const line of [
    'Two findings are still open in the report.', 'The owner answered No action needed.', 'A follow-up ticket fixed it in c96d40e.', 'The decision was carried out.', '后续由 CI 修复，当晚上线。',
  ]) assert.deepEqual(absenceClaims(line), [], line);
  assert.deepEqual(absenceClaims('The rack is built.\nThe paint was let pass.\nDone.'), ['The paint was let pass.']);
});

test('`looked` is where and up to when; a look that names sessions says how far they were read', () => {
  assert.match(parseLooked({ upTo: '2026-09-30' }) as string, /looked\.where: each place you read/);
  assert.match(parseLooked({ where: ['docs/DECISIONS.md'], upTo: 'recently' }) as string, /looked\.upTo: up to when your reading reaches/);
  assert.match(parseLooked({ where: ['session s-forge-1 [1500–1587]'], upTo: '2026-09-30' }) as string, /looked\.where names sessions: give looked\.sessionsUpTo/);
  assert.deepEqual(parseLooked({ where: [' docs/DECISIONS.md D3–D5 ', 'docs/DECISIONS.md D3–D5'], upTo: '2026-09-30', sessionsUpTo: '' }), { where: ['docs/DECISIONS.md D3–D5'], upTo: '2026-09-30', sessionsUpTo: null });
  // Reaching the present: the ledger's newest session message for sessions, its newest commit otherwise.
  const present = { sessions: '2026-10-01T04:00:37.895Z', commits: '2026-09-30T18:00:00Z' };
  assert.equal(behindOf({ upTo: '2026-09-30', sessionsUpTo: '2026-10-01T04:00:00Z' }, present), null, 'a date reaches to the end of its day; a minute short of the last message still reaches it');
  assert.equal(behindOf({ upTo: '2026-09-30', sessionsUpTo: '2026-09-30T19:53:00Z' }, present), 'sessions to 2026-09-30 19:53Z; the ledger has sessions to 2026-10-01 04:00Z');
  assert.equal(behindOf({ upTo: '2026-09-28', sessionsUpTo: null }, present), 'commits to 2026-09-28; the ledger has commits to 2026-09-30 18:00Z');
  assert.equal(behindOf({ upTo: '2026-09-28' }, { sessions: null, commits: null }), null, 'with no ledger there is nothing to fall short of');
  // The stamp: on, replaced, and off again.
  const behind = { behind: 'sessions to 2026-09-30 19:53Z; the ledger has sessions to 2026-10-01 04:00Z' };
  const stamped = stampAsFarAs('No answer was seen.', behind);
  assert.equal(stamped, '[As far as read — sessions to 2026-09-30 19:53Z; the ledger has sessions to 2026-10-01 04:00Z] No answer was seen.');
  assert.equal(stampAsFarAs(stamped, behind), stamped, 'stamped once');
  assert.equal(stampAsFarAs(stamped, { behind: null }), 'No answer was seen.');
  assert.equal(stampAsFarAs(stamped, null), 'No answer was seen.');
});

test('a note that claims an absence is refused in a round without `looked`, and written with it; outside a round it is not held', async () => {
  const b = await bench('synthesis');
  const j = await b.judgement();
  const refused = await b.call('pk_write_note', note(j));
  assert.equal(refused.error, true);
  assert.match(refused.text, /The note “The owner’s question about the tongs” says something has no follow-up, was let pass or was taken up by nobody \(“The owner asked why every station has the same tongs; no follow-up in the sessions\.”\)/);
  assert.match(refused.text, /give looked: \{ where: \[each place you read for what came after\], upTo: /);
  assert.match(refused.text, /A lane’s Unsure you did not settle by reading is written as unsure, not as a finding\. Nothing was written\./);
  assert.equal(b.store.notes.all().length, 0);
  // A claim in the body is a claim too.
  assert.equal((await b.call('pk_write_note', note(j, { preview: 'The owner asked about the tongs.', facts: [{ text: 'Nobody took the question up.', sourceIds: [], inferred: true }] }))).error, true);
  // With what was read: written, the look kept on the note; it reaches the ledger's newest commit, so nothing is stamped.
  const written = await b.ok('pk_write_note', note(j, { looked: { where: ['docs/DECISIONS.md D4–D5', 'pk_ledger_commits num=D5'], upTo: '2026-09-30' } }));
  const n = b.store.notes.get(written.id as string)!;
  assert.deepEqual([n.looked!.where, n.looked!.upTo, n.looked!.behind, n.looked!.roundId, n.looked!.jobId], [['docs/DECISIONS.md D4–D5', 'pk_ledger_commits num=D5'], '2026-09-30', null, 'round_1', 'job_main']);
  assert.equal(n.versions[0]!.preview, 'The owner asked why every station has the same tongs; no follow-up in the sessions.');
  assert.match(written.looked as string, /^looked in docs\/DECISIONS\.md D4–D5; pk_ledger_commits num=D5 · up to 2026-09-30$/);
  assert.ok(!('asFarAs' in written));
  // An update keeps the look the note has.
  const again = await b.ok('pk_write_note', { id: written.id, reason: 'reworded', preview: 'The owner asked about the tongs; nobody took it up.' });
  assert.equal(again.version, 2);
  assert.equal(b.store.notes.get(written.id as string)!.looked!.upTo, '2026-09-30');
  // A note with no such claim needs none.
  assert.equal((await b.call('pk_write_note', note(j, { title: 'The tongs', preview: 'Every station has the same tongs (D5).' }))).error, false);
  // The spot-check is given each claim with what it read.
  assert.match(absenceLookedBlock(b.store, { id: 'round_1' }), /=== Absence claims this round wrote, with what was read \(1\)[^\n]*\n- note note_\w+ “The owner’s question about the tongs”: looked in docs\/DECISIONS\.md D4–D5; pk_ledger_commits num=D5 · up to 2026-09-30/);

  // Outside a round (the owner's conversation) the writer does not hold the note.
  const chat = await bench('synthesis', { inRound: false });
  assert.equal((await chat.call('pk_write_note', note(await chat.judgement()))).error, false);
});

test('a look that stops before the ledger’s newest session or commit is said on the note’s line: as far as read', async () => {
  const b = await bench('synthesis', { session: { started: '2026-09-28T15:47:29.398Z', ended: '2026-10-01T04:00:37.895Z' } });
  const l = b.ledger();
  try { assert.deepEqual(ledgerPresent(l), { sessions: '2026-10-01T04:00:37.895Z', commits: NEWEST_COMMIT }); } finally { l.close(); }
  const j = await b.judgement();
  // The lane read the session up to the owner's question, and no further (the CM run's OW-157).
  const where = ['session s-forge-1 [1500–1587]', 'docs/DECISIONS.md D4–D5'];
  assert.match((await b.call('pk_write_note', note(j, { looked: { where, upTo: '2026-09-30' } }))).text, /looked\.where names sessions: give looked\.sessionsUpTo[^\n]*Nothing was written\./);
  const short = await b.ok('pk_write_note', note(j, { looked: { where, upTo: '2026-09-30', sessionsUpTo: '2026-09-30T19:53:48Z' } }));
  const id = short.id as string;
  assert.equal(b.store.notes.get(id)!.versions[0]!.preview, '[As far as read — sessions to 2026-09-30 19:53Z; the ledger has sessions to 2026-10-01 04:00Z] The owner asked why every station has the same tongs; no follow-up in the sessions.');
  assert.equal(b.store.notes.get(id)!.looked!.behind, 'sessions to 2026-09-30 19:53Z; the ledger has sessions to 2026-10-01 04:00Z');
  assert.match(short.asFarAs as string, /Your look does not reach the present of the ledger \(sessions to 2026-09-30 19:53Z; the ledger has sessions to 2026-10-01 04:00Z\), so the note opens with “As far as read — …”\. Word the claim as “as far as … read”, not as a bare “no follow-up”/);
  assert.match(absenceLookedBlock(b.store, { id: 'round_1' }), /sessions to 2026-09-30 19:53Z · does not reach the present \(sessions to 2026-09-30 19:53Z; the ledger has sessions to 2026-10-01 04:00Z\)/);
  // An update that gives no new look keeps the opening, and is told so again.
  const kept = await b.ok('pk_write_note', { id, reason: 'why it matters', whyItMatters: 'The owner may still be waiting for the answer.' });
  assert.match(kept.asFarAs as string, /Your look does not reach the present of the ledger/);
  assert.match(b.store.notes.get(id)!.versions[1]!.preview, /^\[As far as read — sessions to 2026-09-30 19:53Z; the ledger has sessions to 2026-10-01 04:00Z\] The owner asked/);
  // Read to the end: the opening goes.
  const full = await b.ok('pk_write_note', { id, reason: 'read the rest of the session', looked: { where, upTo: '2026-10-01', sessionsUpTo: '2026-10-01T04:00:00Z' } });
  assert.ok(!('asFarAs' in full));
  const n = b.store.notes.get(id)!;
  assert.equal(n.versions[2]!.preview, 'The owner asked why every station has the same tongs; no follow-up in the sessions.');
  assert.equal(n.looked!.behind, null);
  // A look in commits that stops before the newest one says so too.
  const old = await b.ok('pk_write_note', note(j, { title: 'The paint', preview: 'The paint finding was let pass.', looked: { where: ['pk_ledger_commits num=FGC-03 until 2026-08-25'], upTo: '2026-08-25' } }));
  assert.equal(b.store.notes.get(old.id as string)!.versions[0]!.preview, '[As far as read — commits to 2026-08-25; the ledger has commits to 2026-09-01 12:00Z] The paint finding was let pass.');
});

test('a six-things judgement of dropped along the way or let pass carries what was read; the others need none', async () => {
  const b = await bench('synthesis', { session: { started: '2026-09-28T15:47:29.398Z', ended: '2026-10-01T04:00:37.895Z' } });
  const j = await b.judgement();
  const plain = (await b.ok('pk_write_note', note(j, { title: 'The quench', preview: 'The quench step is written in two places that disagree.' }))).id as string;
  // 2 drift: no absence claim.
  assert.equal((await b.call('pk_tag_six', { target: { kind: 'note', id: plain }, thing: 2 })).error, false);
  // 5 let pass on a note that carries no look: refused; with one, kept on the note, and its line says how far it reaches.
  const refused = await b.call('pk_tag_six', { target: { kind: 'note', id: plain }, thing: 5 });
  assert.match(refused.text, /Tagging this note as let pass says something has no follow-up, was let pass or was taken up by nobody\. Such a claim carries what was read/);
  assert.equal(b.store.notes.get(plain)!.sixThing, 2);
  const tagged = await b.ok('pk_tag_six', { target: { kind: 'note', id: plain }, thing: 5, looked: { where: ['session s-forge-1 [1–900]'], upTo: '2026-09-30', sessionsUpTo: '2026-09-29T10:00:00Z' } });
  assert.match(tagged.looked as string, /sessions to 2026-09-29 10:00Z · does not reach the present/);
  const n = b.store.notes.get(plain)!;
  assert.equal(n.sixThing, 5);
  assert.match(n.versions[n.versions.length - 1]!.preview, /^\[As far as read — sessions to 2026-09-29 10:00Z; the ledger has sessions to 2026-10-01 04:00Z\] The quench step/);
  // A note written with its look is tagged without giving it again.
  const withLook = (await b.ok('pk_write_note', note(j, { looked: { where: ['docs/DECISIONS.md D4–D5'], upTo: '2026-09-30' } }))).id as string;
  assert.equal((await b.call('pk_tag_six', { target: { kind: 'note', id: withLook }, thing: 3 })).error, false);
  // A send-back.
  const sb: SendBack = { id: 'sb_1', projectId: project.id, to: 'Work', stage: 'Suggested', targetId: b.byNumber('AE').id, what: 'The rack’s second half has no ticket', suggestion: 'Open one', evidence: [], from: { kind: 'verdict', id: 'x' }, returned: null, closed: null, ownerResponse: null, sixThing: null, occurred: { at: '2026-09-20', basis: 'Commit', anchor: null }, roundId: 'round_1', updatedAt: AT };
  b.store.sendbacks.put(sb);
  assert.equal((await b.call('pk_tag_six', { target: { kind: 'sendback', id: 'sb_1' }, thing: 5 })).error, true);
  await b.ok('pk_tag_six', { target: { kind: 'sendback', id: 'sb_1' }, thing: 5, looked: { where: ['subagent/INDEX.md Tickets', 'pk_ledger_commits num=AE'], upTo: '2026-09-30' } });
  assert.deepEqual([b.store.sendbacks.get('sb_1')!.sixThing, b.store.sendbacks.get('sb_1')!.looked!.where.length, b.store.sendbacks.get('sb_1')!.what], [5, 2, 'The rack’s second half has no ticket']);
});

// ───────────────────────── B · a lane's Unsure stays unsure ─────────────────────────

test('the Unsure items of a lane report: under its heading, under a bold label, counted ①②③', () => {
  // A section of its own, one bullet an item (a bullet's continuation line belongs to it).
  assert.deepEqual(unsureIn(['# Report', '', '## Proposed for the main agent', '- Confirm link_1.', '', '## Unsure', '', '- Whether the rack’s second half was ever ticketed:', '  I read the index only.', '- The paint finding’s owner.', '', '## Not read', '- runs/AE-1/stderr.log'].join('\n')),
    [{ line: 8, text: 'Whether the rack’s second half was ever ticketed: I read the index only.' }, { line: 10, text: 'The paint finding’s owner.' }]);
  // A heading that names other parts too: only the part labelled Unsure.
  const mixed = ['## 7 · Unsure / Looked for, not found', '', '- **Unsure**：① 那句版面反馈是否有后续回答——未通读 09-30 之后的会话；② 双语窗口消失的时点；③ 概念承接是我的读法（Inferred）。', '- **Looked for, not found**：`pk_ledger_word` brain（0 命中）。', '', '## 8 · Proposed'].join('\n');
  assert.deepEqual(unsureIn(mixed).map((u) => u.text), ['① 那句版面反馈是否有后续回答——未通读 09-30 之后的会话', '② 双语窗口消失的时点', '③ 概念承接是我的读法（Inferred）']);
  assert.deepEqual([...new Set(unsureIn(mixed).map((u) => u.line))], [3]);
  // A label with bullets under it; the next label ends it.
  assert.deepEqual(unsureIn(['## ⑥ Unsure / Looked for not found / Not read', '', '**Unsure**', '- ③ 的锚点归属：锚行在 D94 的背景段内。', '- ⑤.3 的 E2–E100 挂 P1：只观察不改。', '', '**Looked for not found**：无。', '', '**Not read**', '- semantic-patches.md'].join('\n')).map((u) => u.text),
    ['③ 的锚点归属：锚行在 D94 的背景段内。', '⑤.3 的 E2–E100 挂 P1：只观察不改。']);
  // A label in a section of another name; a lone circled number points at a section and is no count.
  assert.deepEqual(unsureIn(['## ⑦ 落位、提议、Unsure、Not read', '', '**落位**：未新立工作项。', '', '**Unsure**：BU 是否真走过那条路径（⑤）；AY B13 的四项名字只拼出两条，不硬猜。', '', '**Looked for not found**：无。'].join('\n')).map((u) => u.text),
    ['BU 是否真走过那条路径（⑤）；AY B13 的四项名字只拼出两条，不硬猜。']);
  // The project's own word for it; "none" is no item; a report without the part has none.
  assert.deepEqual(unsureIn(['## 8 · 不确定', '', '- §7 表行数：简报说 26 行，实际 27 行。', '', '## 9 · 找过没找到'].join('\n')).map((u) => u.text), ['§7 表行数：简报说 26 行，实际 27 行。']);
  assert.deepEqual(unsureIn(['## Unsure', '', '无。', '', '## Not read'].join('\n')), []);
  assert.deepEqual(unsureIn('# Report\n\nAll found.\n'), []);
});

test('the lanes’ Unsure items are listed for the synthesis and the spot-check, and by key', async () => {
  const b = await bench('synthesis');
  const doc = (id: string, path: string, markdown: string, at: string, roundId = 'round_1', kind: RoundDoc['kind'] = 'Report'): RoundDoc => ({ id, projectId: project.id, roundId, jobId: 'job_lane', kind, path, title: `Report: ${path}`, markdown, at });
  b.store.roundDocs.put(doc('rdoc_owner', 'owner-meaning', '# Report\n\n## Unsure\n\n- Whether the owner’s question about the tongs was answered: I did not read the sessions after 09-30.\n', '2026-09-30T11:00:00.000Z'));
  b.store.roundDocs.put(doc('rdoc_plan', 'plan-P1', '# Report\n\n## Findings\n\nAll linked.\n\n**Unsure**：① which four of the six items stay open — the record gives a count, not the names；② whether AE’s second half was ticketed。\n', '2026-09-30T11:05:00.000Z'));
  b.store.roundDocs.put(doc('rdoc_other', 'old-lane', '## Unsure\n\n- An earlier round’s doubt.\n', '2026-09-29T11:00:00.000Z', 'round_0'));
  b.store.roundDocs.put(doc('rdoc_brief', 'plan-P1', '## Unsure\n\n- A brief is no report.\n', '2026-09-30T10:30:00.000Z', 'round_1', 'Brief'));
  const items = laneUnsure(b.store, { id: 'round_1' });
  assert.deepEqual(items.map((u) => [u.lane, u.reportId, u.line]), [['owner-meaning', 'rdoc_owner', 5], ['plan-P1', 'rdoc_plan', 7], ['plan-P1', 'rdoc_plan', 7]]);
  const synthesis = unsureBlock(b.store, { id: 'round_1' });
  assert.match(synthesis, /^=== What the lanes marked Unsure \(3\): each is unsure until someone reads what settles it\n/);
  assert.match(synthesis, /read what settles it, and say what you read \(looked\) — or write it as unsure, with what was not read\. Never restate it as a fact\./);
  assert.match(synthesis, /- owner-meaning \(rdoc_owner:5\): Whether the owner’s question about the tongs was answered: I did not read the sessions after 09-30\./);
  assert.match(synthesis, /- plan-P1 \(rdoc_plan:7\): ① which four of the six items stay open — the record gives a count, not the names/);
  assert.match(unsureBlock(b.store, { id: 'round_1' }, { forStep: 'spot-check' }), /states one of these as fact, without naming what was read to settle it, is Wrong as written/);
  assert.match(unsureBlock(b.store, { id: 'round_none' }), /No lane report of this round has an Unsure item\./);
  // By key, at any stage.
  const listed = await b.ok('pk_round_state', { list: 'unsure' });
  assert.deepEqual([listed.count, (listed.items as { lane: string; report: string }[]).map((i) => `${i.lane} ${i.report}`)], [3, ['owner-meaning rdoc_owner:5', 'plan-P1 rdoc_plan:7', 'plan-P1 rdoc_plan:7']]);
});

test('the skills say it briefly: the claim carries what was read, an Unsure stays unsure, a cited source is one opened', () => {
  const synthesis = synthesisSkill();
  assert.match(synthesis, /\*\*An absence claim names the later tickets you read\.\*\*[^\n]*Give `looked` with the note \(`pk_write_note`\), or with `pk_tag_six` for 3 and 5/);
  assert.match(synthesis, /A look that stops before the newest commit or session is worded "as far as … read"/);
  for (const skill of [synthesis, stageSkill('cross-check')]) {
    assert.match(skill, /a lane's Unsure stays unsure/i);
    assert.match(skill, /Never restate it as fact\./);
    assert.match(skill, /"The names are in X" needs X to hold the names; a count is not a list\./);
  }
  assert.match(synthesis, /a source you cite is one you opened/);
  assert.match(stageSkill('cross-check'), /\*\*A source cited for a list is one you opened\.\*\*/);
  // D103: the synthesis was not there for the round; it reads the handover and the reports before it writes.
  assert.match(synthesis, /\*\*You were not there for the round\.\*\*/);
  assert.match(synthesis, /Write nothing before 1 and 2 are done\./);
  assert.match(stageSkill('cross-check'), /pk_round_state\(\{ list: "unsure" \}\)/);
  assert.match(spotCheckSkill(), /A claim that states a lane's Unsure as fact, or cites a source that lacks what it is cited for, is \*\*Wrong as written\*\*\. Read past where its look stopped\./);
  for (const skill of [stageSkill('cross-check'), stageSkill('reconcile')]) {
    assert.match(skill, /\*\*Work for its whole plan\*\* \(a milestone QC across every contract, a reading of the whole graph\) serves the Plan item and no Area, and says why: `pk_write_thread\(\{ id, wholePlanWhy \}\)`/);
    // D104: the program places first; a reason stands only where the records lead nowhere.
    assert.match(skill, /\*\*Placed by the program\.\*\* Where the records lead to a plan or an area/);
    assert.match(skill, /\*\*When the records lead nowhere\*\*[\s\S]*pk_write_thread\(\{ id, noPlanWhy \}\)/);
  }
});

// ───────────────────────── C · work for its whole plan ─────────────────────────

test('work for its whole plan is recorded with its reason, placed, and not counted in no module', async () => {
  const b = await bench('cross-check');
  const before = b.open();
  assert.deepEqual(before.workItems.noModule.items.map((i) => i.name.split(' ')[0]), ['AA', 'AB', 'AD', 'AE', 'AF']);
  assert.deepEqual(before.workItems.noPlan.items.map((i) => i.name.split(' ')[0]), ['AD', 'AE', 'AF']);
  assert.equal(before.workItems.wholePlan.count, 0);
  // It needs a plan to serve the whole of.
  assert.match((await b.call('pk_write_thread', { id: 'AD', wholePlanWhy: 'It audits the whole batch.' })).text, /wholePlanWhy says the work serves its whole plan, and this work item is in no plan: give serves with the Plan item it belongs to in the same call[^\n]*Nothing was written\./);
  assert.equal(b.byNumber('AD').wholePlanWhy, undefined);
  // In its plan, with the reason: placed.
  const why = 'The milestone QC judges every contract of P1; it belongs to no single module.';
  const written = await b.ok('pk_write_thread', { id: 'AA', wholePlanWhy: why });
  assert.ok(!('warning' in written), 'no "serves names no Area" for work recorded as serving its whole plan');
  assert.equal(b.byNumber('AA').wholePlanWhy, why);
  // The plan and the reason in one call.
  await b.ok('pk_write_thread', { id: 'AF', serves: [{ referenceId: b.ids.p1, claim: 'D4: the real cut is P1’s trial', basis: 'Explicit' }], wholePlanWhy: 'The real cut tries the whole blade.' });
  const after = b.open();
  assert.deepEqual(after.workItems.noModule.items.map((i) => i.name.split(' ')[0]), ['AB', 'AD', 'AE']);
  assert.deepEqual(after.workItems.wholePlan.items.map((i) => [i.name.split(' ')[0], i.why]), [['AA', why], ['AF', 'The real cut tries the whole blade.']]);
  assert.match(unplacedNote(after)!, /2 work items in no plan; 3 work items in no module \(1 of them the program reads as work for the whole plan\)/);
  // An update that leaves it out keeps it; an empty one takes it away.
  await b.ok('pk_write_thread', { id: 'AA', results: 'Signed report.' });
  assert.equal(b.byNumber('AA').wholePlanWhy, why);
  await b.ok('pk_write_thread', { id: 'AA', wholePlanWhy: '' });
  assert.equal(b.byNumber('AA').wholePlanWhy, undefined);
  assert.deepEqual(b.open().workItems.noModule.items.map((i) => i.name.split(' ')[0]), ['AA', 'AB', 'AD', 'AE']);
  // Work that serves a module stands there: the reason then places nothing, and the call says so.
  const both = await b.ok('pk_write_thread', { id: 'AB', serves: [{ referenceId: b.ids.m2, claim: 'the cast', basis: 'Inferred' }], wholePlanWhy: 'It reads the whole graph.' });
  assert.match(both.warning as string, /It also serves FG-M2 · Cast, so it stands in that module; wholePlanWhy places work that serves no single module/);
  assert.equal(b.open().workItems.wholePlan.items.some((i) => i.name.startsWith('AB')), false);
});

test('the program suggests the whole plan where a range the ticket writes spans three modules or more', async () => {
  const b = await bench('cross-check');
  const l = b.ledger();
  try {
    // In its title.
    assert.deepEqual(wholePlanSuggestion(b.store, l, b.byNumber('AA')), { range: 'FGC-01～FGC-03', from: 'its title', modules: ['FG-M1', 'FG-M2', 'FG-M3'] });
    // In its own prompt (`AB-whole-graph.md`, id "AB"): 「FGC-01～03」.
    assert.deepEqual(wholePlanSuggestion(b.store, l, b.byNumber('AB')), { range: 'FGC-01～03', from: 'its ticket', modules: ['FG-M1', 'FG-M2', 'FG-M3'] });
    assert.equal(wholePlanSuggestion(b.store, null, b.byNumber('AB')), null, 'without the ledger its prompt is not read');
    // A ticket of one module, and one that names no range.
    assert.equal(wholePlanSuggestion(b.store, l, b.byNumber('AE')), null);
    assert.equal(wholePlanSuggestion(b.store, l, b.byNumber('AD')), null);
    // The contracts it implements.
    await b.ok('pk_write_thread', { id: 'AF', implements: ['FGC-01', 'FGC-02', 'FGC-03'] });
    assert.deepEqual(wholePlanSuggestion(b.store, l, b.byNumber('AF')), { range: 'FGC-01, FGC-02, FGC-03', from: 'the contracts it implements', modules: ['FG-M1', 'FG-M2', 'FG-M3'] });
    // Two modules are not the whole plan.
    await b.ok('pk_write_thread', { id: 'AE', title: 'The rack, first half (FGC-01～FGC-02)' });
    assert.equal(wholePlanSuggestion(b.store, l, b.byNumber('AE')), null);
  } finally { l.close(); }
  const open = b.open();
  const suggest = new Map(open.workItems.noModule.items.map((i) => [i.name.split(' ')[0], i.suggest]));
  assert.equal(suggest.get('AA'), 'the whole plan: its title names FGC-01～FGC-03, items of 3 modules (FG-M1, FG-M2, FG-M3) — if it serves the plan as a whole and no single module, pk_write_thread({ id, wholePlanWhy })');
  assert.match(suggest.get('AB')!, /^the whole plan: its ticket names FGC-01～03, items of 3 modules/);
  assert.equal(suggest.get('AD'), undefined);
  // The list by its key carries the suggestion; the counts are taken without reading for it.
  const listed = await b.ok('pk_round_state', { list: 'noModule' });
  assert.match((listed.items as { name: string; suggest?: string }[]).find((i) => i.name.startsWith('AA'))!.suggest!, /^the whole plan: its title names FGC-01～FGC-03/);
  assert.ok(b.open({ suggest: false }).workItems.noModule.items.every((i) => !('suggest' in i)));
  assert.equal(b.open({ suggest: false }).workItems.noModule.count, open.workItems.noModule.count);
});

// ───────────────────────── C · a plan through decisions ─────────────────────────

test('a work item in no plan is given the plan of the decisions it carries out, cites, or is cited by', async () => {
  const b = await bench('cross-check');
  const l = b.ledger();
  try {
    // AD cites D2 (its row: "archived (D2)"). D2 sits on the product and names nothing; it follows D1, whose entry names
    // the contracts FGC-01 and FGC-02 of P1.
    assert.deepEqual(planThroughDecisions(b.store, l, b.byNumber('AD')).map((s) => [s.plan, s.through, s.weight]), [['P1', ['D2 (cites)'], 2]]);
    // AE is cited by D3 (「The ticket AE is put off」), whose entry names the plan it shapes.
    assert.deepEqual(planThroughDecisions(b.store, l, b.byNumber('AE')).map((s) => [s.plan, s.through, s.weight]), [['P2', ['D3 (cited by)'], 1]]);
    assert.deepEqual(planThroughDecisions(b.store, null, b.byNumber('AE')).map((s) => [s.plan, s.through]), [['P2', ['D3 (cited by)']]], 'without the ledger: a decision whose own entry names the number');
    // AF names no decision and none names it.
    assert.deepEqual(planThroughDecisions(b.store, l, b.byNumber('AF')), []);
    // It carries out D4, which the cross-check placed on P1: the heaviest way of meeting a decision.
    await b.ok('pk_write_reference', { id: b.refBy('D4', 'Decision').id, refines: [b.ids.p1] });
    b.store.relations.put({ id: 'rel_carry', projectId: project.id, type: 'carries out', from: b.byNumber('AF').id, to: b.refBy('D4', 'Decision').id, claim: 'AF makes the real cut D4 asks for', basis: 'Explicit', evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: AT });
    assert.deepEqual(planThroughDecisions(b.store, l, b.byNumber('AF')).map((s) => [s.plan, s.through, s.weight]), [['P1', ['D4 (carries out)'], 3]]);
    // Several decisions, two plans: the heavier first, each with what leads to it.
    await b.ok('pk_write_thread', { id: 'AE', doing: 'The first half of the rack, as D4 and D2 left it.' });
    assert.deepEqual(planThroughDecisions(b.store, l, b.byNumber('AE')).map((s) => [s.plan, s.through, s.weight]), [['P1', ['D2 (cites)', 'D4 (cites)'], 4], ['P2', ['D3 (cited by)'], 1]]);
  } finally { l.close(); }
  const noPlan = new Map(b.open().workItems.noPlan.items.map((i) => [i.name.split(' ')[0], i.suggest]));
  // D104: the suggestion is the whole inference's chain (the index row that names D2, the decision chain), heaviest first.
  assert.match(noPlan.get('AD')![0]!, /^P1 \(plan\) — .*D2 \(cites\)/);
  assert.deepEqual(noPlan.get('AE')!.map((s) => s.split(' (plan)')[0]), ['P1', 'P2']);
  assert.match(noPlan.get('AE')![1]!, /D3 \(cited by\)/);
  assert.match(noPlan.get('AF')![0]!, /^P1 \(plan\) — .*D4 \(carries out\)/);
  const listed = await b.ok('pk_round_state', { list: 'noPlan' });
  assert.match((listed.items as { name: string; suggest?: string[] }[]).find((i) => i.name.startsWith('AD'))!.suggest![0]!, /^P1 \(plan\) — .*D2 \(cites\)/);
  // Placed by the suggestion, it leaves the list.
  await b.ok('pk_write_thread', { id: 'AD', serves: [{ referenceId: b.ids.p1, claim: 'D2 is P1’s trial arrangement; AD carries it out', basis: 'Inferred' }] });
  assert.deepEqual(b.open().workItems.noPlan.items.map((i) => i.name.split(' ')[0]), ['AE', 'AF']);
});
