/**
 * Independent QC (AY): a full takeover round of the clerk method, run live through App + pi against the loopback fake
 * provider (CKC-23, CKC-13, CKC-07, CKC-26; Spec §3.3, §3.7, §3.8). No real model, no network, no real repository.
 *
 * What this proves satisfied, it locks — as D99 runs a round, one main agent through its stages with its lanes, a
 * scripted clerk playing them (keeper/testing/clerk-script.ts): the first usable round's steps in order, the main agent
 * and each lane in a session of their own with pi's built-ins open; the deepening's lanes, coverage check, cross-check,
 * synthesis and independent spot-check; the round's outputs counted by position; the depth question with the project's
 * own figures; the project folder committed by the Keeper alone, nothing else in the project touched; the Follow up round
 * over the change since the last round.
 *
 * What it found broken is fixed, and the same run now asserts the contract:
 *   - CKC-23 AC-4: the main agent sends two lanes first; the dig does not end until each of the four kinds of question
 *     has its lane (E148 D-g), and it sends the other two.
 *   - CKC-07 AC-1/AC-10/AC-18: a settled change waiting for the daily gate shows as pending, labelled Changes pending.
 *   - CKC-13 AC-8: the coverage counts every material at its organizing level; what a sweep read is Read in full.
 *   - CKC-07 AC-27 / CKC-24 AC-15: a Follow up round's news is one item in Notes (attention), each thing with its
 *     position; a round that finds nothing new has no item, and the top bar's data says the last round found nothing new.
 *   - CKC-03 AC-19: a round's aggregate usage includes its steps' delegated subagent jobs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { after } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The scratch lives in the system's temp directory, not the worktree: a write that lands after cleanup would otherwise
// leave test homes in the repository, where a frozen copy of the project would take them in as material.
const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'qc-ay-'));
process.env.PI_CODING_AGENT_DIR = join(scratch, 'pi-agent');
after(() => { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const { App } = await import('../server/app.ts');
const { startFakeProvider, callResults, taskText, FAKE_MODEL } = await import('../keeper/fake-provider.ts');
const { clerkPlanner, jobOf, roundKindOf } = await import('../keeper/testing/clerk-script.ts');
import type { ScriptedLane } from '../keeper/testing/clerk-script.ts';
import type { RoundKind } from '../model/k-types.ts';
const { grantProjectFolder } = await import('../server/project-folder-api.ts');
const { incrementalIntake } = await import('../intake/intake.ts');
const { overview } = await import('../server/graph-view.ts');
const { roundsView, processView } = await import('../server/k-views.ts');

// ───────────────────────── the fixture project ─────────────────────────

const ENV = { GIT_AUTHOR_NAME: 'Orchard Dev', GIT_AUTHOR_EMAIL: 'dev@orchard.invalid', GIT_COMMITTER_NAME: 'Orchard Dev', GIT_COMMITTER_EMAIL: 'dev@orchard.invalid' };
const projectDir = mkdtempSync(join(scratch, 'project-'));
const git = (args: string[], date: string) => execFileSync('git', ['--no-optional-locks', '-C', projectDir, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel: string, text: string) => { mkdirSync(join(projectDir, rel, '..'), { recursive: true }); writeFileSync(join(projectDir, rel), text); };

git(['init', '-q', '-b', 'main'], '2026-09-01T09:00:00+00:00');
write('README.md', '# Orchard\n\nPicks apples.\n');
write('docs/PRODUCT.md', '# Orchard product\n\n## What it is\n\nA basket.\n');
write('docs/plan.md', '# Plan\n\n## T-1 Hand picking\n\nPick by hand.\n');
write('design/DECISIONS.md', '# Decisions\n\n**D1 · Pick by hand first.**\n\n日期：2026-09-01\n\nBy hand before any robot.\n');
write('src/main.ts', 'import { pick } from "./util";\nexport const main = () => pick();\n');
write('src/util.ts', 'export const pick = () => 1;\n');
write('src/orphan.ts', 'export const orphan = () => 2;\n');
git(['add', '-A'], '2026-09-01T09:00:00+00:00');
git(['commit', '-q', '-m', 'Start the orchard'], '2026-09-01T09:00:00+00:00');

write('docs/PRODUCT.md', '# Orchard product v2\n\n## What it is\n\nA conveyor. (V1 已被 V2 取代)\n');
write('docs/plan.md', '# Plan\n\n## T-1 Hand picking\n\nPick by hand.\n\n## T-2 Conveyor\n\nBuild the conveyor.\n');
write('docs/qc/T-1-qc.md', '# T-1 QC\n\n结论：fail\n\n### F-1 提示: ladder missing\n');
git(['add', '-A'], '2026-09-03T09:00:00+00:00');
git(['commit', '-q', '-m', 'PRODUCT v2 replaces v1; T-2 planned; T-1 QC fail'], '2026-09-03T09:00:00+00:00');

git(['checkout', '-q', '-b', 'wip/conveyor'], '2026-09-04T09:00:00+00:00');
write('src/conveyor.ts', 'export const conveyor = () => 3;\n');
git(['add', '-A'], '2026-09-04T09:00:00+00:00');
git(['commit', '-q', '-m', 'T-2 conveyor'], '2026-09-04T09:00:00+00:00');
git(['checkout', '-q', 'main'], '2026-09-05T09:00:00+00:00');
git(['merge', '-q', '--no-ff', 'wip/conveyor', '-m', 'Merge T-2 conveyor'], '2026-09-05T09:00:00+00:00');

// ───────────────────────── the scripted clerk (D99) ─────────────────────────

/**
 * A synthesis that writes no note and nothing else new: the second Follow up round finds nothing new. It still gives the
 * note standing from the earlier rounds its result — still holds, with what it read — which is no news (D103).
 */
let quietSynthesis = false;
/** The Area the first lane writes, read when the main agent places the decision record's entries (CJ). */
let areaIdNow: () => string | undefined = () => undefined;

const FIRST_LANES: readonly ScriptedLane[] = [
  { name: 'Goals and areas', kind: 'slot', slots: ['reference:Goal', 'reference:Area'], brief: '# Brief: Goals and areas\n\nThe product and its areas: README.md, docs/PRODUCT.md.' },
  { name: 'Work', kind: 'slot', slots: ['threads'], brief: '# Brief: Work\n\nThe work items docs/plan.md names, with their QC.' },
];
const DEEPEN_LANES: readonly ScriptedLane[] = [
  { name: "The owner's meaning", kind: 'topic', slots: [], brief: "# Brief\n\nThe owner's meaning. 1. Background: Orchard v2, T-1 QC failed. 2. Rules: read only, cite everything. 3. Read: design/DECISIONS.md. 4. Verdicts: present / replaced / no follow-up. 5. Clues: 以后, TBD. 6. Report: complete, dense citations." },
  { name: 'The code as it stands', kind: 'topic', slots: ['territories'], brief: '# Brief\n\nThe code as it stands. 1. Background: src/ with an orphan. 2. Rules: read only. 3. Read: src/, the ledger. 4. Verdicts: live / residual / unknown. 5. Clues: orphan.ts. 6. Report: complete.' },
  { name: 'The document chain and decisions', kind: 'topic', slots: [], brief: '# Brief\n\nThe document chain and decisions: docs/PRODUCT.md v1 and v2, docs/plan.md.' },
  { name: "Each work item's process and checks", kind: 'plan', slots: ['links'], brief: "# Brief\n\nEach work item's process and checks: docs/plan.md, docs/qc/T-1-qc.md." },
];
const planner = clerkPlanner({
  lanes: (round) => (round === 'First usable' ? FIRST_LANES : round === 'Deepen' ? DEEPEN_LANES : []),
  // Orientation sends two of the four kinds first: the dig's gate asks for the other two (CKC-23 AC-4; E148 D-g).
  firstBatch: () => ["The owner's meaning", 'The code as it stands'],
  laneWork: (name) => {
    if (name === 'Goals and areas') {
      return [
        { name: 'pk_write_reference', args: { category: 'Goal', name: 'Fresh apples', text: 'Apples picked and delivered fresh.', basis: 'Inferred', validity: 'Current', identity: 'Interpretation', sourceIds: [] } },
        { name: 'pk_write_reference', args: { category: 'Area', name: 'Picking', ids: ['A1'], text: 'How the apples are picked.', basis: 'Inferred', validity: 'Current', identity: 'Interpretation', sourceIds: [] } },
      ];
    }
    if (name === 'Work') {
      return [
        { name: 'pk_write_thread', args: { title: 'Hand picking', ids: ['T-1'], doing: 'Pick by hand', serves: [], progress: 'Done' } },
        { name: 'pk_write_thread', args: { title: 'Conveyor', ids: ['T-2'], doing: 'Build the conveyor', serves: [], progress: 'In progress' } },
      ];
    }
    // A deepening lane reads before it reports: the read is recorded on its job, and the material's level follows (§1.11).
    return [{ name: 'read', args: { path: 'docs/PRODUCT.md' } }];
  },
  stageWork: (round, stage, task) => {
    if (stage === 'orientation' && round !== 'Follow up') {
      return [
        { name: 'pk_write_layers', args: { entries: [
          { path: 'README.md', layer: 'Readme', current: true },
          { path: 'docs/PRODUCT.md', layer: 'Product', current: true },
          { path: 'docs/plan.md', layer: 'Plan', current: true },
          { path: 'design/DECISIONS.md', layer: 'Decision record', current: true },
          { path: 'docs/qc/T-1-qc.md', layer: 'QC and receipts', current: true },
        ] } },
        { name: 'pk_write_rule', args: { group: 'Material rules', category: 'Reference only', summary: 'docs/qc holds QC reports, cited as evidence.', excerpt: null, appliesTo: ['docs/qc/'], basis: 'Inferred' } },
        ...(round === 'First usable' ? [{ name: 'pk_write_round_doc', args: { kind: 'Questions', title: 'What the deepening asks', markdown: '# Questions\n\nWhat is now? What got buried? Where does the flow break?' } }] : []),
      ];
    }
    // CJ: the decision record is filled whole in one call, each entry named as written, and placed on its module; the
    // first usable round leaves reconcile only once every counted entry is on the workbench.
    if (round === 'First usable' && stage === 'reconcile') {
      return [
        { name: 'pk_fill_from_bold', args: { path: 'design/DECISIONS.md', category: 'Decision' } },
        ...(areaIdNow() ? [{ name: 'pk_write_reference', args: { ids: ['D1'], category: 'Decision', refines: [areaIdNow()] } }] : []),
      ];
    }
    if (stage === 'cross-check') return [{ name: 'pk_write_round_doc', args: { kind: 'Adoption', title: 'What was adopted', markdown: '# Adoption\n\n- Every lane’s report: adopted after checking it against the files.\n- The code lane’s orphan.ts: noted for the synthesis; not adopted as an anomaly (entry points exist).' } }];
    // The synthesis job's (D103), in its own session. The first round writes the project's note; a later round is given
    // it as a note standing from an earlier round and gives it one result: updated (a new version), or — the quiet
    // round — still holds, with what it read.
    if (stage === 'synthesis') {
      const standing = /^- (note_[\w-]+) · “Where Orchard stands”/m.exec(task)?.[1];
      const note = standing
        ? { id: standing, preview: `v2 current; T-1 failed QC and stayed so (${round}).`, reason: `the ${round} round looked at it again` }
        : { mountKind: 'project', mountIds: [], title: 'Where Orchard stands', preview: 'v2 current; T-1 failed QC and stayed so.', ask: 'For information', currentView: 'The conveyor is the current product direction; T-1’s QC failure has no fix.', reason: 'synthesis of the round' };
      return [
        { name: 'pk_investigate', args: { question: 'Is src/orphan.ts referenced by anything?', hints: ['src/orphan.ts'] } },
        ...(quietSynthesis ? (standing ? [{ name: 'pk_confirm_note', args: { id: standing, read: ['docs/qc/T-1-qc.md: the verdict is still fail', 'pk_ledger_commits num=T-1: no later commit'] } }] : []) : [{ name: 'pk_write_note', args: note }]),
      ];
    }
    return [];
  },
});

async function until(check: () => boolean, ms = 120_000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

type Msg = { role: string; content: unknown };
const textOf = (m: Msg | undefined): string => (!m ? '' : typeof m.content === 'string' ? m.content : ((m.content as { text?: string }[] | null) ?? []).map((p) => p.text ?? '').join('\n'));

test('AY live: a full takeover (first usable → Full deepening → Follow up) lands on the contracted positions', { timeout: 600_000 }, async () => {
  const home = mkdtempSync(join(scratch, 'home-'));
  const app = new App(home);
  const fake = await startFakeProvider(planner);
  try {
    const project = app.addProject('Orchard', [projectDir]);
    await app.intakeProject(project.id);
    app.markTakeoverStarted(project.id, 'First picture only');   // the owner's Start (D105): adding a project starts nothing
    app.stopAll();
    await app.initKeeper();
    app.keeper.models.registerProvider('fake', { name: 'Fake', baseUrl: fake.url, apiKey: 'k', api: 'openai-completions', models: [FAKE_MODEL] });
    app.keeper.setModel({ provider: 'fake', id: FAKE_MODEL.id, thinking: null });
    const store = app.store(project.id);
    areaIdNow = () => store.reference.find((r) => r.category === 'Area')?.id;
    grantProjectFolder(app, project.id, { quote: 'Keep a projectkeeper folder in the project and commit only that folder; never push.' });
    // Each request's job, from its task (the first user message): the main agent, a lane by name, the spot-check.
    const jobsOf = () => fake.requests.map((r) => ({ ...jobOf(taskText(r.messages as never)), task: textOf(r.messages.find((m) => m.role === 'user')), tools: new Set(r.tools), messages: r.messages }));

    // ── Stage 2: the first usable round ──
    await app.organizing.replan(project.id);
    await until(() => store.clerkRounds.find((r) => r.kind === 'First usable' && r.status !== 'Running') !== undefined, 120_000, 'the first usable round');
    const round = store.clerkRounds.find((r) => r.kind === 'First usable')!;
    assert.equal(round.status, 'Done', `first usable done: ${store.jobs.all().map((j) => `${j.scope.label}=${j.status}:${j.error ?? ''}`).join('; ')}`);
    const steps = store.jobs.filter((j) => j.step?.roundId === round.id).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    assert.deepEqual(steps.filter((j) => j.step!.kind !== 'lane').map((j) => j.step!.kind), ['ledger', 'session-drafts', 'main', 'synthesis', 'process'], 'CKC-23 AC-1 (D99, D103): the first usable round is ledger → drafts → the main agent → the synthesis → process');
    const main = steps.find((j) => j.step!.kind === 'main')!;
    // CKC-23 AC-8 (D103): the main job ends at its handover; the synthesis is a job of its own, in a new session.
    const synthesis = steps.find((j) => j.step!.kind === 'synthesis')!;
    const handover = store.roundDocs.get(store.clerkRounds.get(round.id)!.handover!.docId)!;
    assert.deepEqual([main.status, synthesis.status, synthesis.agent, handover.kind, handover.jobId], ['Done', 'Done', 'pi', 'Handover', main.id]);
    assert.ok(main.endedAt! <= synthesis.startedAt!, 'the synthesis starts after the main agent’s session has ended');
    assert.equal(store.roundDocs.find((d) => d.roundId === round.id && d.kind === 'Result')?.jobId, synthesis.id, 'the synthesis wrote the round’s Result');
    assert.equal(store.traceByJob(main.id, 10_000).filter((e) => e.collection === 'notes').length, 0, 'the main agent wrote no note');
    const synthRun = jobsOf().find((r) => r.kind === 'synthesis')!;
    assert.ok(synthRun.tools.has('pk_write_note') && synthRun.tools.has('pk_round_state') && !synthRun.tools.has('pk_stage') && !synthRun.tools.has('pk_send_lanes'), 'it has the synthesis’ writers and no stages');
    assert.ok(synthRun.task.includes(`=== The main agent's handover (${handover.id};`) && synthRun.task.includes('=== This round\'s documents (read each in full with pk_read_assets kind roundDoc, by its id)'), 'and is given the handover and the round’s documents by reference');
    assert.ok(!jobsOf().find((r) => r.kind === 'main')!.tools.has('pk_write_note'), 'the main agent is not offered the notes');
    const lanes = steps.filter((j) => j.step!.kind === 'lane');
    assert.deepEqual(lanes.map((j) => j.step!.path).sort(), ['Goals and areas', 'Work'], 'the main agent sent its skeleton’s lanes');
    assert.ok(steps.filter((j) => j.step!.kind !== 'lane').every((j) => j.parentJobId === round.rootJobId) && lanes.every((j) => j.parentJobId === main.id), 'CKC-03 AC-19: every step under the round’s root job, each lane under the main agent — the tree');
    const modelSteps = steps.filter((j) => j.agent === 'pi');
    assert.equal(modelSteps.length, 4, 'the main agent, its two lanes, the synthesis');
    assert.equal(new Set(modelSteps.map((j) => j.sessionFile)).size, modelSteps.length, 'CKC-03 AC-28: the main agent, each lane and the synthesis in a session of its own');
    assert.ok(steps.every((j) => j.timing && j.timing.wallMs >= 0), 'CKC-23 AC-10: every job carries its timing');
    assert.deepEqual(store.clerkRounds.get(round.id)!.stageLog!.map((e) => e.stage), ['orientation', 'skeleton', 'reconcile'], 'and every stage of the main agent with its time; its log ends at its last stage');
    // CJ: the decision record's entry is an item, named by its number and its title as written.
    assert.equal(store.reference.find((r) => r.category === 'Decision' && r.ids.includes('D1'))?.name, 'D1 · Pick by hand first.', 'the decision record filled from its bold entry, named as written');

    // CKC-03 AC-25, AC-26: the main agent and each lane were offered the full built-ins and the ledger tools.
    for (const who of ['main', 'Goals and areas', 'Work']) {
      const offered = jobsOf().find((r) => (who === 'main' ? r.kind === 'main' : r.lane === who))?.tools;
      assert.ok(offered, `${who} ran`);
      for (const builtin of ['read', 'grep', 'find', 'ls', 'bash']) assert.ok(offered.has(builtin), `CKC-03 AC-25: ${who} has ${builtin}`);
      assert.ok([...offered].some((t) => t.startsWith('pk_ledger_')), `CKC-03 AC-26: ${who} has ledger queries`);
    }

    // CKC-23 AC-6: what the round produced is counted by position; nothing it wrote served nothing.
    const closed = store.clerkRounds.get(round.id)!;
    assert.ok(closed.outputs.length > 0, `the round’s outputs are counted: ${JSON.stringify(closed.outputs)}`);
    assert.equal(closed.unplaced.count, 0, `nothing unplaced: ${closed.unplaced.reasons.join('; ')}`);
    assert.ok(closed.ledger && closed.ledger.ms >= 0, 'CKC-22 AC-16: the ledger’s recompute is its own item');
    // CKC-23 AC-22 (D99): the first usable round lights nothing.
    assert.equal(store.breakpoints.filter((b) => b.lit).length, 0, 'the first usable round draws no “missing” conclusion');

    // CKC-13 AC-38 (D105): the depth was chosen before the start, so no note asks for it; the options keep this project’s figures.
    await until(() => store.coverage.takeover?.stage === 'Daily', 30_000, 'the takeover done at First picture only');
    assert.ok(!store.notes.has('note_takeover-depth'), 'no note asks for the depth');
    const full = store.coverage.takeover?.options.find((o) => o.depth === 'Full');
    assert.ok(full && full.toOrganize > 0 && full.minutes != null, `each option names materials, time and cost: ${JSON.stringify(store.coverage.takeover?.options)}`);

    // CKC-13 AC-30: the question list is visible from Project scope’s data (the Questions doc), and the lanes' briefs.
    assert.ok(store.roundDocs.find((d) => d.roundId === round.id && d.kind === 'Questions'), 'orientation’s question list is a round document, openable under the round');
    assert.equal(store.roundDocs.filter((d) => d.roundId === round.id && d.kind === 'Brief').length, 2, 'a brief for each lane');

    // CKC-13 AC-8 (fixed after QC AY): the coverage counts every material at its organizing level, in §1.11's words.
    const firstLevels = store.coverage.takeover?.levels ?? [];
    assert.deepEqual(firstLevels.map((l) => l.level), ['Read in full', 'Conclusions only', 'Sampled', 'Settled by rule', 'Indexed', 'Not organized', 'Skipped: too large'], 'every level of §1.11, in its order');
    assert.ok(firstLevels.reduce((n, l) => n + l.materials, 0) >= 8, `every material is counted at a level: ${JSON.stringify(firstLevels)}`);
    assert.equal(firstLevels.find((l) => l.level === 'Read in full')!.materials, 0, 'no job of this round read a file, and none is claimed read');
    assert.ok(firstLevels.find((l) => l.level === 'Indexed')!.materials > 0, 'what nobody read is in the ledger and the sources, read on demand');

    // ── Stage 4: the Full deepening ──
    app.startTakeover(project.id, 'Full');
    await app.organizing.replan(project.id);
    await until(() => store.clerkRounds.find((r) => r.kind === 'Deepen' && r.status !== 'Running') !== undefined, 180_000, 'the deepening round');
    const deepen = store.clerkRounds.find((r) => r.kind === 'Deepen')!;
    assert.equal(deepen.status, 'Done', `deepening done: ${store.jobs.filter((j) => j.step?.roundId === deepen.id).map((j) => `${j.scope.label}=${j.status}:${j.error ?? ''}`).join('; ')}`);
    const deepJobs = store.jobs.filter((j) => j.step?.roundId === deepen.id).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    assert.deepEqual(deepJobs.filter((j) => j.step!.kind !== 'lane').map((j) => j.step!.kind), ['ledger', 'session-drafts', 'main', 'synthesis', 'spot-check', 'process'], 'CKC-23 AC-1 (D99, D103): the main agent, then the synthesis, the independent spot-check and the process');
    assert.deepEqual(store.clerkRounds.get(deepen.id)!.stageLog!.map((e) => e.stage), ['orientation', 'dig', 'coverage', 'cross-check']);
    // D103: main → synthesis → spot-check, each in a session of its own; the spot-check follows the synthesis.
    const [deepMainJob, deepSynth, deepSpot] = ['main', 'synthesis', 'spot-check'].map((k) => deepJobs.find((j) => j.step!.kind === k)!);
    assert.equal(new Set([deepMainJob!.sessionFile, deepSynth!.sessionFile, deepSpot!.sessionFile]).size, 3);
    assert.ok(deepMainJob!.endedAt! <= deepSynth!.startedAt! && deepSynth!.endedAt! <= deepSpot!.startedAt!, 'in that order');
    // CKC-08 AC-25: the note the first round left was given to this synthesis and got its result — updated, a new version.
    const standingNote = store.notes.find((n) => n.versions[0]!.title === 'Where Orchard stands')!;
    assert.ok((deepSynth!.task as { prompt: string }).prompt.includes(`- ${standingNote.id} · “Where Orchard stands” · For information`), 'the standing note is in the synthesis’ inputs');
    assert.deepEqual(store.clerkRounds.get(deepen.id)!.standingNotes, { standing: 1, confirmed: 0, updated: 1, withdrawn: 0, open: 0 });
    assert.equal(store.notes.filter((n) => n.versions[0]!.title === 'Where Orchard stands').length, 1, 'one note, updated in place');
    // CKC-23 AC-9: it is among what the spot-check checks in full, with the round's Result.
    assert.ok((deepSpot!.task as { prompt: string }).prompt.includes(`- notes ${standingNote.id}: note “Where Orchard stands” (For information) — standing from an earlier round, updated this round`));
    assert.match((deepSpot!.task as { prompt: string }).prompt, /- roundDocs rdoc_\w+: the round's Result/);

    // CKC-23 AC-4 (E148 D-g): the main agent sent two lanes first; leaving the dig was refused until each of the four kinds
    // of question had its lane, and it sent the other two.
    const deepLanes = deepJobs.filter((j) => j.step!.kind === 'lane');
    assert.deepEqual(deepLanes.map((j) => j.step!.path).sort(), ["Each work item's process and checks", 'The code as it stands', 'The document chain and decisions', "The owner's meaning"]);
    const deepMain = jobsOf().filter((r) => r.kind === 'main' && /\(Deepen\)/.test(r.task)).at(-1)!;
    const refused = callResults(deepMain.messages as never, 'pk_stage').find((c) => c.args.to === 'coverage' && /^ERROR/.test(c.result));
    assert.ok(refused, 'leaving the dig with two kinds unanswered was refused');
    assert.match(refused.result, /“The document chain and decisions”, “Each work item's process and checks”/, 'naming the kinds no lane answers');
    assert.deepEqual(store.clerkRounds.get(deepen.id)!.lanes!.map((l) => l.stage), ['dig', 'dig', 'dig', 'dig']);
    assert.equal(store.clerkRounds.get(deepen.id)!.sweepsAdded ?? undefined, undefined, 'the program composes no sweep any more');

    // CKC-23 AC-7: the briefs, the lanes' reports and the adoption record are kept and openable.
    const reports = store.roundDocs.filter((d) => d.roundId === deepen.id && d.kind === 'Report');
    assert.deepEqual(reports.map((d) => d.path).sort(), deepLanes.map((j) => j.step!.path).sort(), 'each lane filed its report');
    // CKC-13 AC-8: what a lane read is Read in full (the lanes read docs/PRODUCT.md).
    await until(() => (store.coverage.takeover?.levels.find((l) => l.level === 'Read in full')?.materials ?? 0) >= 1, 30_000, 'the level of what the lanes read');
    assert.ok(store.roundDocs.find((d) => d.roundId === deepen.id && d.kind === 'Adoption'), 'the cross-check left its adoption record');
    assert.ok(store.roundDocs.find((d) => d.roundId === deepen.id && d.kind === 'Result'), 'the synthesis left the round’s result');
    // CKC-23 AC-20: a Full deepening's cross-check waited for its coverage: every listed material accounted for.
    const coverage = store.clerkRounds.get(deepen.id)!.coverage!;
    assert.ok(coverage.settled && coverage.accounted.length > 0 && (coverage.untouched ?? []).length >= 0, `the coverage check settled with the main agent's accounts: ${JSON.stringify(coverage.accounted.map((a) => a.group))}`);

    // CKC-23 AC-9: the spot check recorded its sample on the round.
    const deepClosed = store.clerkRounds.get(deepen.id)!;
    assert.ok(deepClosed.spotCheck && deepClosed.spotCheck.sampled >= 1, `the spot check is counted on the round: ${JSON.stringify(deepClosed.spotCheck)}`);

    // CKC-03 AC-19: the round tree with usage: the aggregate includes the investigations its jobs sent.
    const tree = roundsView(store).find((r) => r.id === deepen.id)!;
    assert.ok(tree.steps.length === deepJobs.length && tree.usage !== null, 'the round renders as a tree with usage: every job, each lane among them');
    const stepJobs = deepJobs.filter((j) => j.agent !== 'program');
    const stepUsage = stepJobs.reduce((n, j) => n + j.usage.input, 0);
    const delegated = store.jobs.filter((j) => Boolean(j.parentJobId) && stepJobs.some((s) => s.id === j.parentJobId) && !j.step);
    assert.ok(delegated.length >= 1, 'the synthesis delegated an investigation, a child job of its own');
    const delegatedUsage = delegated.reduce((n, j) => n + j.usage.input, 0);
    assert.ok(delegatedUsage > 0, 'the delegated investigation has usage of its own');
    assert.equal(tree.usage.input, stepUsage + delegatedUsage, `CKC-03 AC-19: the round’s aggregate includes the ${delegatedUsage} input tokens of the investigations its jobs sent (fixed after QC AY)`);

    // CKC-23 AC-18: the session drafts are served where a session is drilled into.
    {
      const { registerRoutes } = await import('../server/api.ts');
      const { registerDraftRoutes } = await import('../server/drafts-api.ts');
      const handlers = new Map<string, (req: { params: Record<string, string>; query: URLSearchParams }) => unknown>();
      const http = { route: (method: string, path: string, h: never) => handlers.set(`${method} ${path}`, h), static: () => undefined } as never;
      registerRoutes(http, app, '', '');
      registerDraftRoutes(http, app);
      assert.ok(handlers.has('GET /api/projects/:id/drafts') && handlers.has('GET /api/projects/:id/drafts/:key'), 'CKC-23 AC-18: a session draft has a route (钻取一段会话时点得开)');
      const served = handlers.get('GET /api/projects/:id/drafts')!({ params: { id: project.id }, query: new URLSearchParams() }) as { drafts: { id: string }[] };
      assert.deepEqual(served.drafts.map((d) => d.id).sort(), store.drafts.all().map((d) => d.id).sort(), 'every draft the method wrote is served');
      for (const r of roundsView(store)) {
        const step = r.steps.find((s) => s.kind === 'session-drafts');
        assert.ok(step && Array.isArray(step.drafts), `round ${r.number}: its session-drafts step lists the drafts it wrote`);
      }
    }

    // CKC-26 AC-8, AC-11: the project folder was committed by the Keeper alone; nothing else in the project changed.
    const gitOut = (...args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', projectDir, ...args], { encoding: 'utf8' });
    const log = gitOut('log', '--format=%H %an|%s').trim().split(/\r?\n/).filter(Boolean);
    const pkHashes = log.filter((l) => l.includes(' ProjectKeeper|')).map((l) => l.split(' ')[0]!);
    assert.ok(pkHashes.length >= 1, `the Keeper committed the folder itself: ${pkHashes.length} commits`);
    assert.ok(log.filter((l) => l.includes(' ProjectKeeper|')).every((l) => l.includes(' ProjectKeeper|ProjectKeeper: ')), 'every Keeper commit is named as from ProjectKeeper');
    const pkFiles = pkHashes.flatMap((h) => gitOut('show', '--pretty=', '--name-only', h).trim().split(/\r?\n/).filter(Boolean));
    assert.ok(pkFiles.length > 0 && pkFiles.every((f) => f.startsWith('projectkeeper/')), `CKC-26 AC-8: only the folder is in those commits: ${pkFiles.join(', ')}`);
    assert.equal(gitOut('status', '--porcelain').trim(), '', 'CKC-26 AC-11 / CKC-07 AC-16: nothing else in the project changed');
    assert.equal(gitOut('remote').trim(), '', 'no remote at all, so nothing was pushed');
    assert.ok(app.project(project.id).scope.some((i) => i.relation === 'Excluded' && /[\\/]projectkeeper$/.test(i.path)), 'the folder is excluded from the project’s material');

    // Takeover complete → Daily.
    await until(() => store.coverage.state === 'Takeover complete', 30_000, 'takeover complete');
    assert.equal(store.coverage.takeover?.stage, 'Daily');

    // ── A change arrives, pending the daily gate (CKC-07 AC-1, AC-10, AC-18) ──
    write('docs/plan.md', '# Plan\n\n## T-1 Hand picking\n\nPick by hand.\n\n## T-2 Conveyor\n\nBuild the conveyor.\n\n## T-3 Sorting\n\nSort the apples.\n');
    git(['add', '-A'], '2026-09-06T09:00:00+00:00');
    git(['commit', '-q', '-m', 'T-3 planned'], '2026-09-06T09:00:00+00:00');
    incrementalIntake(store, app.project(project.id), [{ kind: 'file', ref: join(projectDir, 'docs', 'plan.md'), label: 'docs/plan.md', since: new Date().toISOString(), lastEventAt: Date.now(), scopeItemId: 'si' }]);
    await app.organizing.replan(project.id);
    const covAfterSettle = store.coverage.scopes.find((s) => s.id === 'project')!;
    assert.equal(store.clerkRounds.filter((r) => r.kind === 'Follow up').length, 0, 'the daily gate is closed: no round started');
    assert.deepEqual(covAfterSettle.pending.map((p) => p.label), ['docs/plan.md'], 'the changed plan is pending, and nothing else is');
    assert.equal(covAfterSettle.coverage, 'Changes pending', 'the label says a change waits, with nothing running');
    assert.equal(store.coverage.pendingByKind.file, 1, 'the pending count agrees with the list');
    assert.equal(store.coverage.takeover?.levels.find((l) => l.level === 'Not organized')?.materials, 1, 'the changed plan is not organized until a round takes it');

    // ── The Follow up round over that change (CKC-07 AC-19, AC-26, AC-27) ──
    app.followUp(project.id);
    await until(() => store.clerkRounds.find((r) => r.kind === 'Follow up' && r.status !== 'Running') !== undefined, 180_000, 'the Follow up round');
    const followUp = store.clerkRounds.find((r) => r.kind === 'Follow up')!;
    assert.equal(followUp.status, 'Done', `Follow up done: ${store.jobs.filter((j) => j.step?.roundId === followUp.id).map((j) => `${j.scope.label}=${j.status}:${j.error ?? ''}`).join('; ')}`);
    const followSteps = store.jobs.filter((j) => j.step?.roundId === followUp.id).map((j) => j.step!.kind);
    for (const s of ['ledger', 'main', 'synthesis', 'spot-check', 'process'] as const) assert.ok(followSteps.includes(s), `CKC-07 AC-26: the Follow up ran ${s}`);
    assert.deepEqual(store.clerkRounds.get(followUp.id)!.standingNotes, { standing: 1, confirmed: 0, updated: 1, withdrawn: 0, open: 0 }, 'its synthesis updated the standing note');
    assert.ok(followUp.followUpRoundId && store.rounds.get(followUp.followUpRoundId)?.endedAt, 'the Follow up record closed with the round');

    // CKC-07 AC-27 / CKC-24 AC-15 (fixed after QC AY): the round's news is one item in Notes (attention), each thing with
    // its position — here the note the synthesis updated; the top bar's data says the last round found something.
    const record = store.rounds.get(followUp.followUpRoundId!)!;
    const news = record.result!.news!;
    assert.ok(news && news.complete, 'the round counted its news against where things stood when it started');
    assert.deepEqual(news.notes.map((n) => n.label), ['Where Orchard stands'], 'the note the synthesis wrote, and only that');
    assert.match(news.notes[0]!.detail ?? '', /^(new|v\d+)$/, 'new, or the version it reached');
    assert.equal(news.breakpoints.length + news.sendbacks.length + news.sixThings.length + news.patches.length, 0, 'nothing else this round is new');
    assert.match(news.notes[0]!.position, /^Notes log · on the project$/, 'with where it is');
    assert.equal(record.result!.counts.news?.notes, 1, 'counted into the result');
    const attention = overview(store, app.project(project.id), null, null).needsYou;
    const item = attention.find((a) => a.kind === 'round' && a.id === record.id);
    assert.ok(item, `one item for the round in Notes (attention): ${JSON.stringify(attention.map((a) => a.label))}`);
    assert.match(item.label, new RegExp(`^Follow up round ${followUp.number}: .*1 note written or updated`));
    assert.match(item.detail, /Notes written or updated \(1\):\n- Where Orchard stands — Notes log · on the project/);
    assert.equal(store.coverage.lastFollowUp?.nothingNew, false);

    // A second Follow up round that writes nothing new: no item for it, and the top bar's data says so.
    quietSynthesis = true;
    app.followUp(project.id);
    await until(() => store.clerkRounds.filter((r) => r.kind === 'Follow up' && r.status !== 'Running').length === 2, 180_000, 'the second Follow up round');
    const second = store.clerkRounds.filter((r) => r.kind === 'Follow up').sort((a, b) => a.number - b.number)[1]!;
    assert.equal(second.status, 'Done');
    const quiet = store.rounds.get(second.followUpRoundId!)!.result!.news!;
    assert.equal(quiet.nothingNew, true, `nothing new: ${quiet.statement}`);
    assert.equal(quiet.statement, `Follow up round ${second.number} found nothing new`);
    await until(() => store.coverage.lastFollowUp?.recordId === second.followUpRoundId, 30_000, 'the coverage names the last round');
    assert.deepEqual([store.coverage.lastFollowUp?.nothingNew, store.coverage.lastFollowUp?.statement], [true, 'The last Follow up round found nothing new'], 'the top bar says the last round found nothing new');
    const afterNews = overview(store, app.project(project.id), null, null).needsYou;
    assert.ok(!afterNews.some((a) => a.kind === 'round' && a.id === second.followUpRoundId), 'a round with nothing new has no item in Notes (attention)');
    assert.ok(!store.clerkRounds.get(second.id)!.baseline, 'the baseline goes once the round is counted');
    // Its synthesis looked at the standing note again and found it still holds: recorded in its judgement record with
    // what it read, no new version of the note — and that is no news.
    assert.deepEqual(store.clerkRounds.get(second.id)!.standingNotes, { standing: 1, confirmed: 1, updated: 0, withdrawn: 0, open: 0 });
    const secondSynth = store.jobs.find((j) => j.step?.roundId === second.id && j.step.kind === 'synthesis')!;
    assert.deepEqual(store.judgements.find((j) => j.jobId === secondSynth.id)!.outcome.stillHolds!.map((h) => [h.noteId, h.read.length]), [[standingNote.id, 2]]);
    assert.equal(store.notes.get(standingNote.id)!.versions.length, 3, 'the first round’s, the deepening’s and the first Follow up’s versions; none from the quiet round');

    // The program's lists reach the stages that judge from them (test-C-1; the owner's rule of 2026-09-28; D99): the
    // owner's lines no position cites → orientation (the main agent's prompt), reconcile and the cross-check (given as the
    // main agent enters them); what later names a "not handled" claim's items → the cross-check, the synthesis and the
    // spot-check; the work merged without a task number → reconcile, and a Follow up's cross-check.
    // CM: the main agent is given the count of the owner's lines (and those naming generations); the list itself goes to
    // the lane that holds the Owner's words slot.
    const OWNER_LINES = "=== The owner's lines no position cites yet (a count";
    const CLAIMS = '=== Before you write that something was not handled';
    const UNNUMBERED = '=== Work merged without a task number';
    const mains = jobsOf().filter((r) => r.kind === 'main');
    const entering = (to: string, round: RoundKind) => mains.filter((r) => roundKindOf(r.task) === round).flatMap((r) => callResults(r.messages as never, 'pk_stage')).filter((c) => c.args.to === to && !/^ERROR/.test(c.result)).map((c) => c.result);
    assert.ok(mains.filter((r) => roundKindOf(r.task) === 'First usable').every((r) => r.task.includes(OWNER_LINES)), 'the main agent starts in orientation with the owner’s lines no position cites');
    assert.ok(entering('reconcile', 'First usable').some((t) => t.includes(OWNER_LINES) && t.includes(UNNUMBERED)), 'reconcile is given the owner’s lines and the unnumbered work');
    assert.ok(entering('cross-check', 'Deepen').some((t) => t.includes(OWNER_LINES) && t.includes(CLAIMS) && !t.includes(UNNUMBERED)), 'a deepening’s cross-check the owner’s lines and the claims, not the unnumbered work');
    assert.ok(entering('cross-check', 'Follow up').some((t) => t.includes(CLAIMS) && t.includes(UNNUMBERED)), 'a Follow up’s cross-check the unnumbered work too');
    // D103: the synthesis is a job of its own; the claims are in its task, and the handover gives the main agent none.
    const synthTasks = (round: RoundKind) => jobsOf().filter((r) => r.kind === 'synthesis' && roundKindOf(r.task) === round).map((r) => r.task);
    assert.ok(synthTasks('Deepen').length > 0 && synthTasks('Deepen').every((t) => t.includes(CLAIMS)), 'the synthesis the claims');
    assert.ok(synthTasks('Deepen').every((t) => t.includes('=== What the lanes marked Unsure')), 'and the lanes’ Unsure items');
    assert.ok(entering('synthesis', 'Deepen').length > 0 && entering('synthesis', 'Deepen').every((t) => !t.includes(CLAIMS) && /"handedOver": true/.test(t)), 'the handover gives the main agent no list');
    assert.ok(jobsOf().filter((r) => r.kind === 'spot-check').some((r) => r.task.includes(CLAIMS)), 'the spot-check the claims');
    assert.ok(jobsOf().filter((r) => r.kind === 'lane').every((r) => !r.task.includes(OWNER_LINES) && !r.task.includes(CLAIMS) && !r.task.includes(UNNUMBERED)), 'a lane writes from its brief');

    // The project folder followed the rounds; the project still has no other change.
    assert.equal(gitOut('status', '--porcelain').trim(), '', 'still nothing else in the project changed');
  } finally {
    fake.close();
    app.stopAll();
    // Let the last replans settle and their writes land before the scratch directory is removed, so nothing is written
    // back into it afterwards.
    await new Promise((r) => setTimeout(r, 500));
    await app.flushAll();
  }
});

// ───────────────────────── smaller characterizations, same evidence run ─────────────────────────

test('AY: the process view’s no-engine fallback does not invent an execution state (CKC-24 AC-6)', async () => {
  // A work item marked Done, with no ledger/engines connected: the honest display would leave the four things empty.
  // What the view emits instead is EXECUTION_FROM_PROGRESS — 'In progress' for a Done work (k-views.ts).
  const home = mkdtempSync(join(scratch, 'home2-'));
  const app = new App(home);
  app.stopAll();
  const project = app.addProject('Empty', [mkdtempSync(join(scratch, 'empty-'))]);
  const store = app.store(project.id);
  store.threads.put({ id: 'thread_x', projectId: project.id, title: 'Done work', ids: ['T-9'], doing: 'x', serves: [], progress: 'Done', validity: 'Current', factRecordIds: [], pendingSourceIds: [], unresolved: null, replacedBy: null, results: '', sessions: [], updatedAt: '' } as never);
  const view = processView(store, app.project(project.id), {});
  assert.equal(view.works['thread_x']?.four.execution, null, 'CKC-24 AC-6: with no engines, no execution state is shown rather than one invented from progress (fixed after QC AY)');
  assert.equal(view.works['thread_x']?.steps.length, 0, 'its steps stay honestly empty');
  app.stopAll();
  await app.flushAll();   // its writes land before the scratch is removed
});

test('AY: a generation band carries its plan objects and its plan documents (CKC-24 AC-18)', async () => {
  const home = mkdtempSync(join(scratch, 'home3-'));
  const app = new App(home);
  app.stopAll();
  const dir = mkdtempSync(join(scratch, 'empty2-'));
  const project = app.addProject('Empty2', [dir]);
  const store = app.store(project.id);
  // The old plan, read from its deleted document (a history source), and no longer in force.
  store.sources.put({ id: 'src_plan_v1', projectId: project.id, title: 'plan v1 (history)', anchor: { kind: 'revision', repo: dir, path: 'docs/plan-v1.md', commit: '', headingPath: [], lineStart: 1, lineEnd: 5 } } as never);
  store.reference.put({ id: 'ref_plan_v1', projectId: project.id, category: 'Plan', name: 'Plan v1', ids: [], text: 'plan v1', quote: null, basis: 'Explicit', validity: 'Replaced', progress: null, attribution: null, sourceIds: ['src_plan_v1'], refines: [], replacedBy: null, inputs: null, asOf: '', updatedAt: '' } as never);
  store.generations.put({ id: 'gen_1', projectId: project.id, name: 'v1 plans', started: null, ended: { at: '2026-09-01', basis: 'Written in text', anchor: 'docs/plan.md' }, endedBy: { kind: 'file', id: 'docs/plan.md', label: 'v2 replaced v1' }, planRefs: [{ kind: 'file', id: 'docs/plan-v1.md', label: 'plan v1 (deleted)' }], workIds: [], roundId: null, updatedAt: '' });
  const view = processView(store, app.project(project.id), {});
  assert.equal(view.generations.length, 1);
  assert.deepEqual(view.generations[0]!.planIds, ['ref_plan_v1'], 'CKC-24 AC-18: the band renders the old generation’s plan objects (fixed after QC AY B11)');
  assert.deepEqual(view.generations[0]!.planDocs?.map((d) => [d.index, d.path]), [[0, 'docs/plan-v1.md']], 'and its plan documents, each read as it stood when the band is unrolled (D82)');
  app.stopAll();
  await app.flushAll();   // its writes land before the scratch is removed
});
