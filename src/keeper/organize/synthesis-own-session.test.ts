/**
 * The synthesis runs in its own session (D103; E153; Spec §3.3 合成另开会话; CKC-23 AC-8, AC-9; CKC-08 AC-25).
 *
 * The owner, after seeing that the main agent entered the synthesis at 341–399K tokens and wrote the two notes the
 * spot-check had to correct within three minutes, from memory: 「可以，合成另开会话，做吧」. And then: 「那你说是不是应该最后再做
 * 一轮复检，反正也就不到1mb的事。」 and 「first usable 不去full synthesis check 理论上第二轮应该其实是比较容易看出矛盾的，但是我
 * 不确定第二轮是确定会纠正么。」
 *
 *   A. what each job is offered: the synthesis the synthesis' writers and where the round stands; the main agent none of
 *      the notes;
 *   B. the synthesis job's task: the handover in full, the round's documents by id, counts, the lanes' Unsure items, the
 *      notes standing from earlier rounds — far smaller than a main agent's context — and its judgement record (`Based on`);
 *      a round with no handover; a round recorded before D103;
 *   C. notes standing from earlier rounds: each one result — confirmed, updated, withdrawn — and one with none is open;
 *   D. the spot-check's full check covers everything the synthesis job wrote and every note current now, apart from the
 *      sample; it corrects the Result in place;
 *   E. an old home without the synthesis' step setting; the Keeper view's round tree.
 *
 * The handover being required, the gates still refusing and the stage log are in stage-lanes.test.ts, round-open.test.ts,
 * cj-gates.test.ts and cm-attention.test.ts; the rounds end to end in clerk.test.ts, takeover-e2e.test.ts and
 * qc/ay-live-takeover.test.ts; the synthesis job's resume in run-through.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { ProjectStore } from '../../store/project-store.ts';
import type { JudgementRecord, KeeperJob, Note, Project } from '../../model/types.ts';
import type { ClerkRound, ClerkStage, RoundDoc, RoundKind, RoundStepKind } from '../../model/k-types.ts';
import type { App } from '../../server/app.ts';
import { keeperTools, type ToolContext } from '../tools.ts';
import { clerkTools, type ClerkToolContext } from '../clerk-tools.ts';
import { roundTools } from '../round-tools.ts';
import { CLERK_WRITER_STEPS, clerkWritersOf, MAIN_ALWAYS, ROUND_STAGES, STAGE_WRITERS, STEP_SETTING_AS, stepSettingOf, SYNTHESIS_ALWAYS, SYNTHESIS_WRITERS } from '../clerk-steps.ts';
import { STEP_WRITES, stepToolsFor } from '../roles.ts';
import { ClerkPlanner, ROUND_STEPS, mainFinished, synthesisFinished } from './clerk.ts';
import { stageTools } from './stage-tools.ts';
import { handedOver } from './stage-gate.ts';
import { roundOpen } from './round-open.ts';
import { standingCounts, standingNotes, standingNotesBlock } from './standing-notes.ts';
import { fullCheckTargets, judgementWritesOf, spotCheckBlock, spotCheckTargets } from '../../process/breakpoint-candidates.ts';
import { roundsView } from '../../server/k-views.ts';

const P = 'p1';
const EARLIER = '2026-09-30T08:00:00.000Z';   // the first round
const AT = '2026-10-01T10:00:00.000Z';        // this round begins
const LATER = '2026-10-01T11:00:00.000Z';
const project = { id: P, name: 'Kiln', language: 'en', locations: [tmpdir()], scope: [], scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false, createdAt: EARLIER, lastOpenedAt: null, lastScopedAt: null, takeoverDepth: 'Full' } as unknown as Project;

function round(kind: RoundKind, stage: ClerkStage, patch: Partial<ClerkRound> = {}): ClerkRound {
  return {
    id: 'round_2', projectId: P, kind, number: 2, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root',
    questionsDocId: 'rdoc_q', paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT,
    stage, stageLog: [{ stage, startedAt: AT, endedAt: LATER, timing: null }], lanes: [], ...patch,
  } as ClerkRound;
}
const job = (id: string, kind: RoundStepKind, patch: Partial<KeeperJob> = {}): KeeperJob => ({
  id, projectId: P, kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['round_2'], label: kind }, status: 'Done', queuedAt: AT, startedAt: AT, endedAt: LATER,
  savedResults: [], usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: `${id}.jsonl`, sessionId: id, steps: [], error: null,
  requestBasis: null, parentJobId: 'job_root', resultText: null, priority: 1, task: { prompt: `Task: ${kind}`, extra: null }, step: { roundId: 'round_2', kind, path: null },
  timing: { wallMs: 60_000, generationMs: 40_000, toolMs: 10_000, queueMs: 0, parseRetryMs: 0, otherMs: 10_000 }, ...patch,
} as KeeperJob);
const doc = (id: string, kind: RoundDoc['kind'], markdown: string, patch: Partial<RoundDoc> = {}): RoundDoc => ({ id, projectId: P, roundId: 'round_2', jobId: 'job_main', kind, path: null, title: kind, markdown, at: LATER, ...patch });
const judgement = (id: string, jobId: string): JudgementRecord => ({
  id, projectId: P, jobId, at: AT, scope: { kind: 'project', ids: [], label: 'Synthesis' },
  inputs: { referenceIds: [], threadIds: [], areaIds: [], relationIds: [], keyEvidenceSourceIds: [], conflictingSourceIds: [], previousNoteIds: [], investigations: [] },
  excluded: [], outcome: { noteIds: [], assessments: [], reconsideredOnly: false },
});
const note = (id: string, title: string, at: string, patch: Partial<Note> = {}): Note => ({
  id, projectId: P, mount: { kind: 'project', ids: [] }, status: 'Current', ownerResponse: null,
  versions: [{ version: 1, at, title, preview: `${title}: as the first picture shows it.`, body: { currentView: null, whyItMatters: null, facts: [{ text: 'The plan names four work items.', sourceIds: ['src_plan'], inferred: false }], otherExplanations: null, keepAdjust: null, whatWouldSettleIt: null }, ask: 'For information', judgementRecordId: 'jdg_first', reason: 'synthesis of the round' }],
  discussion: [], followUps: [], author: { agent: 'pi', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, language: 'en', updatedAt: at, ...patch,
} as Note);

function newStore(): ProjectStore {
  return ProjectStore.open(P, mkdtempSync(join(tmpdir(), 'pk-synth-store-')));
}

type Called = { text: string; error: boolean; json: Record<string, unknown> };
function caller(tools: readonly ToolDefinition[]) {
  return async (name: string, args: Record<string, unknown>): Promise<Called> => {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `no tool ${name}`);
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
}
/** The tools of a job of the round, as its step is offered them. */
function toolsOf(store: ProjectStore, kind: RoundStepKind, jobId: string, judgementId: string | null = null) {
  // `investigate` is the runtime's: every job has it, and the tool is defined where it is given.
  const ctx = { store, project, jobId, jobKind: 'Organizing', model: null, step: { roundId: 'round_2', kind, path: null }, judgementId, investigate: async () => ({ jobId: 'job_inv', conclusion: '', sourceIds: [] }) } as unknown as ClerkToolContext;
  const all = [...keeperTools(ctx as ToolContext), ...roundTools(ctx as ToolContext), ...clerkTools(ctx), ...stageTools(ctx as ToolContext, { coverageSettled: () => true, stageSkill: (s) => `SKILL ${s}` })];
  const offered = stepToolsFor(all, kind, store.clerkRounds.get('round_2')?.kind ?? 'Deepen', null, null);
  return { call: caller(offered), names: new Set(offered.map((t) => t.name)) };
}

// ───────────────────────── A · what each job is offered ─────────────────────────

test('the round is main → synthesis → spot-check → process in a deepening and a Follow up, main → synthesis → process in a first usable; the main agent’s stages end before the synthesis', () => {
  assert.deepEqual(ROUND_STEPS['First usable'], ['ledger', 'session-drafts', 'main', 'synthesis', 'process']);
  assert.deepEqual(ROUND_STEPS.Deepen, ['ledger', 'session-drafts', 'main', 'synthesis', 'spot-check', 'process']);
  assert.deepEqual(ROUND_STEPS['Follow up'], ['ledger', 'session-drafts', 'main', 'synthesis', 'spot-check', 'process']);
  assert.deepEqual(ROUND_STAGES['First usable'], ['orientation', 'skeleton', 'reconcile']);
  assert.deepEqual(ROUND_STAGES.Deepen, ['orientation', 'dig', 'coverage', 'cross-check']);
  assert.deepEqual(ROUND_STAGES['Follow up'], ['orientation', 'skeleton', 'reconcile', 'dig', 'coverage', 'cross-check']);
  assert.deepEqual(STAGE_WRITERS.synthesis, [], 'the main agent writes nothing in the synthesis');
});

test('the synthesis job is offered what the synthesis stage wrote — with area understanding and the note result — and where the round stands; the main agent none of the notes', () => {
  // What the main agent's synthesis stage wrote before D103 (app 2d2c137 `STAGE_WRITERS.synthesis`).
  const before = ['pk_write_note', 'pk_close_note', 'pk_record_judgement', 'pk_assess_relation', 'pk_ask_owner_about_rules', 'pk_write_mark', 'pk_investigate', 'pk_suggest_sendback', 'pk_tag_six', 'pk_write_round_doc'];
  const added = ['pk_write_area', 'pk_confirm_note'];   // Spec §3.3 合成 row: 区域理解; CKC-08 AC-25: 仍然成立
  assert.deepEqual([...SYNTHESIS_WRITERS].sort(), [...before, ...added].sort());
  assert.deepEqual([...STEP_WRITES.synthesis!].sort(), [...before, ...added, ...SYNTHESIS_ALWAYS].sort(), 'nothing else');
  assert.deepEqual([...SYNTHESIS_ALWAYS], ['pk_round_state']);
  for (const t of clerkWritersOf('synthesis')) assert.ok(STEP_WRITES.synthesis!.has(t), `${t}: a clerk writer the synthesis step lists is offered to it`);
  assert.deepEqual(CLERK_WRITER_STEPS.pk_confirm_note, ['synthesis']);
  // The main agent's session: every stage's writers, none of what only the synthesis writes.
  const main = new Set([...MAIN_ALWAYS, ...Object.values(STAGE_WRITERS).flat()]);
  for (const t of ['pk_write_note', 'pk_close_note', 'pk_confirm_note', 'pk_record_judgement', 'pk_assess_relation', 'pk_ask_owner_about_rules', 'pk_investigate']) assert.ok(!main.has(t), `the main agent is not offered ${t}`);
  for (const t of ['pk_tag_six', 'pk_suggest_sendback', 'pk_write_area', 'pk_write_mark']) assert.ok(main.has(t), `${t} stays the cross-check’s too`);
  // In a real tool set: the synthesis has no stages, no lanes and no trunk writers.
  const store = newStore();
  store.clerkRounds.put(round('Deepen', 'cross-check', { handover: { at: LATER, docId: 'rdoc_h' } }));
  const synth = toolsOf(store, 'synthesis', 'job_synth').names;
  for (const t of [...before, ...added, 'pk_round_state', 'pk_read_assets', 'pk_read_source']) assert.ok(synth.has(t), `the synthesis has ${t}`);
  for (const t of ['pk_stage', 'pk_write_reference', 'pk_write_thread', 'pk_relate', 'pk_link_process', 'pk_confirm', 'pk_write_patch', 'pk_write_territory', 'pk_record_spot_check', 'pk_write_rule']) assert.ok(!synth.has(t), `the synthesis has no ${t}`);
});

test('once handed over, the main agent’s work is done; the synthesis is done once the round has its Result', () => {
  const store = newStore();
  const running = round('Deepen', 'cross-check');
  assert.equal(handedOver(running), false);
  assert.equal(mainFinished(store, running), false);
  const handed = round('Deepen', 'cross-check', { handover: { at: LATER, docId: 'rdoc_h' } });
  assert.equal(mainFinished(store, handed), true);
  assert.equal(synthesisFinished(store, handed), false);
  store.roundDocs.put(doc('rdoc_r', 'Result', '# Result', { jobId: 'job_synth' }));
  assert.equal(synthesisFinished(store, handed), true);
  // A round recorded before D103, whose main agent had moved into its own synthesis stage, reads as handed over.
  assert.equal(handedOver(round('Deepen', 'synthesis')), true);
});

// ───────────────────────── B · the synthesis job's task ─────────────────────────

let n = 0;
function harness(store: ProjectStore) {
  const queued: { label: string; prompt: string; job: KeeperJob; judgementId: string | null }[] = [];
  const program: KeeperJob[] = [];
  const app = {
    ledger: { ledger: () => null },
    keeper: {
      hooks: {},
      enqueue(projectId: string, req: { kind: KeeperJob['kind']; initiator: KeeperJob['initiator']; scope: KeeperJob['scope']; prompt: string; step?: KeeperJob['step']; parentJobId?: string | null; priority?: number; task?: unknown; judgementId?: string | null }): KeeperJob {
        const j = job(`job_q${++n}`, req.step!.kind, { projectId, status: 'Queued', startedAt: null, endedAt: null, scope: req.scope, parentJobId: req.parentJobId ?? null, step: req.step ?? null, task: { prompt: req.prompt, extra: req.task ?? null } });
        store.jobs.put(j);
        queued.push({ label: req.scope.label, prompt: req.prompt, job: j, judgementId: req.judgementId ?? null });
        return j;
      },
      recordProgramJob(projectId: string, req: { kind: KeeperJob['kind']; scope: KeeperJob['scope']; step: KeeperJob['step']; parentJobId: string | null }): KeeperJob {
        const j = job(`job_p${++n}`, req.step!.kind, { projectId, agent: 'program', status: 'Running', scope: req.scope, step: req.step, parentJobId: req.parentJobId, sessionFile: null });
        store.jobs.put(j);
        program.push(j);
        return j;
      },
      endProgramJob(_projectId: string, jobId: string, status: KeeperJob['status'], patch: Partial<KeeperJob> = {}) { store.jobs.put({ ...store.jobs.get(jobId)!, status, ...patch } as KeeperJob); },
    },
  };
  const planner = new ClerkPlanner(app as unknown as App) as unknown as {
    startStep(store: ProjectStore, project: Project, round: ClerkRound, step: RoundStepKind): Promise<string>;
    synthesisPrompt(store: ProjectStore, project: Project, round: ClerkRound): string;
  };
  return { queued, program, planner };
}

/** A deepening after its cross-check: two lanes with their briefs and reports, an adoption record, the handover, a note from the first round. */
function handedOverDeepening(store: ProjectStore): ClerkRound {
  const lanes = [
    { name: 'plan K', kind: 'plan' as const, slots: ['threads', 'links'] as const, briefDocId: 'rdoc_b1', jobId: 'job_l1', stage: 'dig' as const, sentAt: AT, reportDocId: 'rdoc_r1' },
    { name: 'The code as it stands', kind: 'topic' as const, slots: ['territories'] as const, briefDocId: 'rdoc_b2', jobId: 'job_l2', stage: 'dig' as const, sentAt: AT, reportDocId: 'rdoc_r2' },
  ];
  const r = round('Deepen', 'cross-check', { lanes: lanes as unknown as ClerkRound['lanes'], handover: { at: LATER, docId: 'rdoc_h' } });
  store.clerkRounds.put({ ...round('First usable', 'reconcile'), id: 'round_1', number: 1, startedAt: EARLIER, endedAt: EARLIER, status: 'Done', rootJobId: 'job_root_1' });
  store.clerkRounds.put(r);
  store.jobs.put(job('job_main', 'main'));
  store.jobs.put(job('job_l1', 'lane', { step: { roundId: 'round_2', kind: 'lane', path: 'plan K' } }));
  store.jobs.put(job('job_l2', 'lane', { step: { roundId: 'round_2', kind: 'lane', path: 'The code as it stands' } }));
  store.roundDocs.put(doc('rdoc_q', 'Questions', '# Questions\n\nWhat is now? What got buried?'));
  store.roundDocs.put(doc('rdoc_b1', 'Brief', '# Brief\n\nEach work item\'s process and checks.', { path: 'plan K' }));
  store.roundDocs.put(doc('rdoc_b2', 'Brief', '# Brief\n\nThe code as it stands.', { path: 'The code as it stands' }));
  store.roundDocs.put(doc('rdoc_r1', 'Report', `# Report: plan K\n\n## Present now\n- K-1 is delivered by its commit.\n\n${'REPORT-BODY-LINE '.repeat(400)}\n\n## Unsure\n- Whether K-2's delivery is in the sealed dispatch records: not read.\n`, { path: 'plan K', jobId: 'job_l1' }));
  store.roundDocs.put(doc('rdoc_r2', 'Report', '# Report: code\n\n## Present now\n- src/kiln.ts cools the kiln.', { path: 'The code as it stands', jobId: 'job_l2' }));
  store.roundDocs.put(doc('rdoc_a', 'Adoption', '# Adoption\n\n- plan K: adopted after checking the commits.'));
  store.roundDocs.put(doc('rdoc_h', 'Handover', '# Handover to the synthesis: Deepen round 2\n\n## What I settled\n\nK-4 is linked to its delivery.\n\n## What I left open, and why\n\nK-2: looked for, not found.\n\n## Look at first\n\nplan K\'s report.'));
  store.notes.put(note('note_first', 'Where Kiln stands', EARLIER), { jobId: 'job_first_synth', summary: 'Note: Where Kiln stands' });
  return r;
}

test('the synthesis job’s task gives the handover in full, the round’s documents by id and size, counts and the lanes’ Unsure items — no report pasted — and opens its judgement record with what it was given', async () => {
  const store = newStore();
  const r = handedOverDeepening(store);
  const { queued, planner } = harness(store);
  assert.equal(await planner.startStep(store, project, r, 'synthesis'), 'started');
  assert.equal(queued.length, 1);
  const { prompt, job: synth, judgementId } = queued[0]!;
  assert.deepEqual([synth.step!.kind, synth.parentJobId, queued[0]!.label], ['synthesis', 'job_root', 'Synthesis']);
  assert.match(prompt, /^Task: the synthesis of this round — its product look-back, in a session of your own\. You were not there for the round/);
  assert.match(prompt, /# Synthesis: the round's product look-back/, 'its skill, in its task');
  // The handover, in full.
  assert.ok(prompt.includes("=== The main agent's handover (rdoc_h; written as it left the cross-check stage)\n# Handover to the synthesis: Deepen round 2"));
  assert.ok(prompt.includes('K-2: looked for, not found.'));
  // The round's documents by id and size; the reports themselves are read, not pasted.
  assert.ok(prompt.includes(`The round's questions: rdoc_q (${store.roundDocs.get('rdoc_q')!.markdown.length} characters)`));
  assert.ok(prompt.includes(`- plan K (plan; threads, links; sent in dig) · Done · brief rdoc_b1 (${store.roundDocs.get('rdoc_b1')!.markdown.length} characters) · report rdoc_r1 (${store.roundDocs.get('rdoc_r1')!.markdown.length} characters)`));
  assert.match(prompt, /Adoption record \(what the cross-check adopted, what not, and why\): rdoc_a \(\d+ characters\)/);
  assert.ok(!prompt.includes('REPORT-BODY-LINE'), 'no report is pasted');
  assert.ok(prompt.length < store.roundDocs.get('rdoc_r1')!.markdown.length + 30_000, 'the task stays small whatever the reports weigh');
  // The program's lists: the lanes' Unsure items, what is open as counts, the candidates counted, what the round wrote.
  assert.match(prompt, /=== What the lanes marked Unsure \(1\)[\s\S]*- plan K \(rdoc_r1:\d+\): Whether K-2's delivery is in the sealed dispatch records: not read\./);
  assert.match(prompt, /=== What is still open \(the program's counts as you start; pk_round_state\(\{\}\) counts them again, pk_round_state\(\{ list: "<key>" \}\) gives one list in full\)\n- standingNotes: 1 — /);
  assert.match(prompt, /Breakpoint candidates \(0\) — leads, not findings; only the spot-check, which runs after you, lights one/);
  assert.match(prompt, /=== What this round wrote on the workbench so far/);
  // The notes still current from earlier rounds, each to get a result.
  assert.match(prompt, /=== Notes still current from earlier rounds \(1\): give each one result/);
  assert.ok(prompt.includes('- note_first · “Where Kiln stands” · For information · since 2026-09-30 · on the project'));
  assert.ok(prompt.includes('  claims: Where Kiln stands: as the first picture shows it.') && prompt.includes('  sources: src_plan'));
  // `Based on` (CKC-23 AC-8): what it received — the lanes' reports, the adoption record, the handover among it.
  const jdg = store.judgements.get(judgementId!)!;
  assert.equal(jdg.jobId, synth.id);
  assert.deepEqual([...jdg.inputs.roundDocIds!].sort(), ['rdoc_a', 'rdoc_h', 'rdoc_r1', 'rdoc_r2']);
  assert.deepEqual(jdg.inputs.previousNoteIds, ['note_first']);
  assert.equal(jdg.excluded.length, 2);
  assert.equal(planner.synthesisPrompt(store, project, r), prompt, 'what a replay builds is what the job is given');
});

test('a round whose main agent did not hand over still gets its synthesis, told so; a round recorded before D103 with its Result has nothing left to synthesize', async () => {
  const store = newStore();
  handedOverDeepening(store);
  // The main agent was listed as not finished: no handover.
  const none = { ...store.clerkRounds.get('round_2')!, handover: null, failures: [{ jobId: 'job_main', step: 'main' as const, label: 'Main agent', status: 'Failed' as const, reason: 'The provider refused', runs: 3, at: LATER }] };
  store.clerkRounds.put(none);
  store.roundDocs.remove('rdoc_h');
  const a = harness(store);
  assert.equal(await a.planner.startStep(store, project, none, 'synthesis'), 'started');
  assert.match(a.queued[0]!.prompt, /=== The main agent's handover\nThere is none: the main agent's session ended in the cross-check stage without handing over\./);
  assert.match(a.queued[0]!.prompt, /say in the Result that the round had no handover and what that leaves unchecked/);
  assert.match(a.queued[0]!.prompt, /=== What did not finish earlier in this round\n- Main agent \(job_main\): failed 3 times — The provider refused/);

  // Before D103 the main agent wrote the Result in its own synthesis stage: the step has nothing to do.
  const old = newStore();
  const before = round('Deepen', 'synthesis');
  old.clerkRounds.put(before);
  old.roundDocs.put(doc('rdoc_r', 'Result', '# Result'));
  const b = harness(old);
  assert.equal(await b.planner.startStep(old, project, before, 'synthesis'), 'skipped');
  assert.equal(b.queued.length, 0, 'no model job');
  assert.deepEqual(b.program.map((j) => [j.step!.kind, old.jobs.get(j.id)!.status]), [['synthesis', 'Done']]);
});

test('a main agent whose session fails after its handover is done: it is not run again; one that fails before it, or that the owner stopped, is left as it is', () => {
  const store = newStore();
  const { planner } = harness(store);
  const settle = (r: ClerkRound) => (planner as unknown as { settleMain(store: ProjectStore, round: ClerkRound): void }).settleMain(store, r);
  // Before the handover: a failure stays a failure, for the program to run again.
  const running = round('Deepen', 'cross-check');
  store.clerkRounds.put(running);
  store.jobs.put(job('job_main', 'main', { status: 'Failed', error: 'The provider refused' }));
  settle(running);
  assert.equal(store.jobs.get('job_main')!.status, 'Failed');
  // After it: the reply that follows the handover was refused, or a restart cut it short — its work was done.
  const handed = round('Deepen', 'cross-check', { handover: { at: LATER, docId: 'rdoc_h' } });
  store.clerkRounds.put(handed);
  settle(handed);
  assert.deepEqual([store.jobs.get('job_main')!.status, store.jobs.get('job_main')!.error], ['Done', null]);
  assert.match(store.traceByJob('job_main', 100).at(-1)!.summary, /its session ended after its handover \(The provider refused\); its work was done at the handover/);
  store.jobs.put(job('job_main', 'main', { status: 'Stopped', error: 'ProjectKeeper restarted while this work was running', resume: { why: 'restart', since: LATER } }));
  settle(handed);
  assert.deepEqual([store.jobs.get('job_main')!.status, store.jobs.get('job_main')!.resume ?? null], ['Done', null]);
  // The owner's Stop is the owner's.
  store.jobs.put(job('job_main', 'main', { status: 'Stopped', error: null }));
  settle(handed);
  assert.equal(store.jobs.get('job_main')!.status, 'Stopped');
});

// ───────────────────────── C · notes standing from earlier rounds ─────────────────────────

test('a note standing from an earlier round gets one result — confirmed with what was read, updated, or withdrawn — and one with none is open (CKC-08 AC-25)', async () => {
  const store = newStore();
  const r = handedOverDeepening(store);
  store.notes.put(note('note_update', 'The glaze', EARLIER));
  store.notes.put(note('note_close', 'The clay', EARLIER));
  store.notes.put(note('note_open', 'The tongs', EARLIER));
  store.notes.put(note('note_gone', 'Closed long ago', EARLIER, { status: 'Resolved', resolvedReason: 'fixed', updatedAt: EARLIER }));
  store.notes.put(note('note_takeover-depth', 'How deep?', EARLIER, { author: { agent: 'ProjectKeeper', model: null } }));
  store.jobs.put(job('job_synth', 'synthesis', { status: 'Running', endedAt: null }));
  store.judgements.put(judgement('jdg_synth', 'job_synth'));
  const standing = () => standingNotes(store, r).map((s) => [s.note.id, s.result]);
  assert.deepEqual(standing(), [['note_close', null], ['note_first', null], ['note_open', null], ['note_update', null]], 'the notes current when the round began; not the closed one, not the program’s own question');
  assert.deepEqual(standingCounts(store, r), { standing: 4, confirmed: 0, updated: 0, withdrawn: 0, open: 4 });
  // Each with no result is an open item of the round, by its key.
  const open = roundOpen(store, r).notes.standing;
  assert.equal(open.count, 4);
  assert.deepEqual(open.items.find((i) => i.id === 'note_first'), { id: 'note_first', name: 'Where Kiln stands', ask: 'For information', since: '2026-09-30', on: 'the project', claims: 'Where Kiln stands: as the first picture shows it.', sources: ['src_plan'] });

  const synth = toolsOf(store, 'synthesis', 'job_synth', 'jdg_synth');
  const state = await synth.call('pk_round_state', {});
  assert.equal(state.error, false, state.text);
  assert.equal((state.json.open as Record<string, number>).standingNotes, 4, 'pk_round_state counts them, for the synthesis job too');
  assert.deepEqual(state.json.standingNotes, { standing: 4, confirmed: 0, updated: 0, withdrawn: 0, open: 4 });
  assert.equal(store.traceByJob('job_synth', 1000).length, 0, 'reading where the round stands writes nothing under the synthesis job');
  const listed = await synth.call('pk_round_state', { list: 'standingNotes' });
  assert.deepEqual((listed.json.items as { id: string }[]).map((i) => i.id).sort(), ['note_close', 'note_first', 'note_open', 'note_update']);

  // Confirmed: with what was read, in the judgement record; the note gets no new version.
  assert.match((await synth.call('pk_confirm_note', { id: 'note_first', read: [] })).text, /read is empty: a note is confirmed as still holding with what you read/);
  const confirmed = await synth.call('pk_confirm_note', { id: 'note_first', read: ['rdoc_r1 § Present now', 'docs/PLAN.md:5'] });
  assert.equal(confirmed.error, false, confirmed.text);
  assert.deepEqual(store.judgements.get('jdg_synth')!.outcome.stillHolds!.map((h) => [h.noteId, h.read]), [['note_first', ['rdoc_r1 § Present now', 'docs/PLAN.md:5']]]);
  assert.equal(store.notes.get('note_first')!.versions.length, 1, 'no new version');
  assert.equal(store.traceByJob('job_synth', 1000).filter((e) => e.collection === 'notes').length, 0, 'and the note itself is not written');
  // Updated: a new version. Withdrawn: Resolved or Withdrawn, with why (Spec §2.7).
  assert.equal((await synth.call('pk_write_note', { id: 'note_update', preview: 'The glaze is now tested.', reason: 'the deepening read the QC' })).error, false);
  assert.equal((await synth.call('pk_close_note', { id: 'note_close', status: 'Withdrawn', reason: 'The clay lane found the claim wrong.' })).error, false);
  assert.deepEqual(standing(), [['note_close', 'withdrawn'], ['note_first', 'confirmed'], ['note_open', null], ['note_update', 'updated']]);
  assert.deepEqual(standingCounts(store, r), { standing: 4, confirmed: 1, updated: 1, withdrawn: 1, open: 1 });
  assert.deepEqual(roundOpen(store, r).notes.standing.items.map((i) => i.id), ['note_open'], 'the one with no result stays open');
  assert.match(standingNotesBlock(store, r)!, /- note_first · “Where Kiln stands” · For information · since 2026-09-30 · on the project · confirmed this round/);
  // What is not a standing note is refused, and nothing is recorded.
  assert.match((await synth.call('pk_confirm_note', { id: 'note_update', read: ['x'] })).text, /got a new version in this round: its result is updated/);
  assert.match((await synth.call('pk_confirm_note', { id: 'note_close', read: ['x'] })).text, /That note is Withdrawn, not current/);
  assert.match((await synth.call('pk_confirm_note', { id: 'note_takeover-depth', read: ['x'] })).text, /the program’s own question to the owner/);
  const fresh = await synth.call('pk_write_note', { mountKind: 'project', mountIds: [], title: 'New this round', preview: 'New.', ask: 'For information', reason: 'synthesis' });
  assert.match((await synth.call('pk_confirm_note', { id: String(fresh.json.id), read: ['x'] })).text, /written in this round: it is not standing from an earlier one/);
  // The Result's write comes back with the program's count, and says one still has no result.
  const result = await synth.call('pk_write_round_doc', { kind: 'Result', title: 'Result', markdown: '# Result\n\nNotes from earlier rounds: 1 confirmed, 1 updated, 1 withdrawn.' });
  assert.equal(result.error, false, result.text);
  assert.deepEqual(result.json.standingNotes, { standing: 4, confirmed: 1, updated: 1, withdrawn: 1, open: 1 });
  assert.match(String(result.json.note), /1 of the 4 notes standing from earlier rounds have no result yet/);
  // Only the synthesis confirms; a first usable round has no earlier round.
  assert.ok(!toolsOf(store, 'main', 'job_main').names.has('pk_confirm_note') && !toolsOf(store, 'spot-check', 'job_spot').names.has('pk_confirm_note'));
  const first = newStore();
  first.clerkRounds.put(round('First usable', 'reconcile', { handover: { at: LATER, docId: 'rdoc_h' } }));
  first.notes.put(note('note_old', 'From a takeover before', EARLIER));
  assert.deepEqual(standingNotes(first, first.clerkRounds.get('round_2')!), []);
  assert.equal(standingNotesBlock(first, first.clerkRounds.get('round_2')!), null);
  assert.equal(roundOpen(first, first.clerkRounds.get('round_2')!).notes.standing.count, 0);
});

// ───────────────────────── D · the spot-check: the round's final re-check ─────────────────────────

test('the spot-check’s full check covers everything the synthesis job wrote and every note current now, apart from the sample; the bulk stays a sample', () => {
  const store = newStore();
  const r = handedOverDeepening(store);
  store.jobs.put(job('job_synth', 'synthesis'));
  store.judgements.put({ ...judgement('jdg_synth', 'job_synth'), outcome: { noteIds: [], assessments: [], reconsideredOnly: false, stillHolds: [{ noteId: 'note_first', read: ['rdoc_r1'], at: LATER }] } }, { jobId: 'job_synth', summary: 'Note “Where Kiln stands” still holds' });
  store.notes.put(note('note_open', 'The tongs', EARLIER));   // standing, with no result: still checked
  store.notes.put(note('note_takeover-depth', 'How deep?', EARLIER, { author: { agent: 'ProjectKeeper', model: null } }));
  // What the main agent and its lanes wrote: the bulk.
  const bulk = ['thr_1', 'thr_2', 'thr_3'];
  for (const id of bulk) store.threads.put({ id, projectId: P, title: id, ids: [id], progress: 'Done', validity: 'Current', serves: [] } as never, { jobId: 'job_l1', summary: `Work item ${id}` });
  store.links.put({ id: 'link_1', projectId: P, workId: 'thr_1', stepKind: 'Delivered', confirmed: true } as never, { jobId: 'job_main', summary: 'Link confirmed' });
  // What the synthesis job wrote: a note, a six-things judgement on a breakpoint and on a mark, a Suggested send-back,
  // area understanding, a relation it assessed, the round's Result — and its bookkeeping.
  const by = (summary: string) => ({ jobId: 'job_synth', summary });
  store.notes.put(note('note_new', 'T-1 let pass', LATER, { sixThing: 5 }), by('Note: T-1 let pass'));
  store.breakpoints.put({ id: 'bp_1', projectId: P, kind: 'Findings open', targetId: 'thr_1', lit: true, out: null, sixThing: 5 } as never, by('Six things: breakpoint Findings open on thr_1 is let pass'));
  store.marks.put({ id: 'mark_1', projectId: P, kind: 'Suspected stale', targetId: 'thr_2', sixThing: 1 } as never, by('Six things: mark Suspected stale on thr_2 is stale'));
  store.sendbacks.put({ id: 'sb_1', projectId: P, to: 'Work', stage: 'Suggested', targetId: 'thr_1' } as never, by('Send-back suggested to Work'));
  store.areas.put({ id: 'area_1', projectId: P, referenceId: 'ref_area' } as never, by('Area understanding: Kiln'));
  store.relations.put({ id: 'rel_1', projectId: P, type: 'serves', from: 'thr_1', to: 'ref_area', assessment: 'Holds' } as never, by('Assessed Holds: serves thr_1 → ref_area'));
  store.roundDocs.put(doc('rdoc_result', 'Result', '# Result\n\nT-1 was let pass.', { jobId: 'job_synth' }), by('Wrote Result'));
  store.jobs.put({ ...store.jobs.get('job_synth')!, resultText: 'done' }, by('Organizing Done'));

  const written = judgementWritesOf(store, 'job_synth');
  assert.deepEqual(written.map((w) => `${w.collection}:${w.id}`).sort(), ['areas:area_1', 'breakpoints:bp_1', 'marks:mark_1', 'notes:note_new', 'relations:rel_1', 'sendbacks:sb_1'], 'its writes, bookkeeping and the round’s documents aside');
  const full = fullCheckTargets(store, r);
  const keys = new Set(full.map((t) => `${t.collection}:${t.id}`));
  // Every write of the synthesis job is a target, and the claims of its Result.
  for (const w of written) assert.ok(keys.has(`${w.collection}:${w.id}`), `${w.collection} ${w.id} is checked in full`);
  assert.ok(keys.has('roundDocs:rdoc_result'), 'and the Result');
  // Every note current now: this round's, and the standing ones — confirmed or with no result; not the program's question.
  for (const id of ['note_new', 'note_first', 'note_open']) assert.ok(keys.has(`notes:${id}`), `${id} is checked`);
  assert.ok(!keys.has('notes:note_takeover-depth'));
  assert.equal(full.length, 9);
  assert.match(full.find((t) => t.id === 'note_first')!.summary, /note “Where Kiln stands” \(For information\) — standing from an earlier round, confirmed as still holding this round/);
  assert.match(full.find((t) => t.id === 'note_open')!.summary, /standing from an earlier round, with no result this round/);
  assert.match(full.find((t) => t.id === 'note_new')!.summary, /written this round · six thing 5/);
  // The bulk stays a sample, and holds none of what is checked in full.
  const targets = spotCheckTargets(store, r, 2);
  assert.deepEqual(targets.full.map((t) => `${t.collection}:${t.id}`).sort(), [...keys].sort());
  assert.equal(targets.sample.length, 2, 'a sample of the size asked');
  assert.equal(targets.written, 4, 'the three work items and the link');
  assert.ok(targets.sample.every((s) => !keys.has(`${s.collection}:${s.id}`)));
  // The spot-check is given them as a list with ids.
  const block = spotCheckBlock(store, targets);
  assert.match(block, /=== Checked in full, not sampled \(9\): every note current now/);
  for (const t of full) assert.ok(block.includes(`- ${t.collection} ${t.id}: `), `${t.collection} ${t.id} is listed with its id`);
  assert.match(block, /=== The sample \(2 of 4 other judgements this round wrote\)/);
  // A note the spot-check itself withdraws stays a target: the counts do not move under it.
  store.jobs.put(job('job_spot', 'spot-check'));
  store.notes.put({ ...store.notes.get('note_new')!, status: 'Withdrawn', withdrawnReason: 'a later commit handled T-1' }, { jobId: 'job_spot', summary: 'Note Withdrawn' });
  assert.equal(fullCheckTargets(store, r).length, 9);
  assert.match(fullCheckTargets(store, r).find((t) => t.id === 'note_new')!.summary, /withdrawn this round/);
});

test('the round reports what was checked in full apart from the sample; the spot-check corrects the Result in place and writes none of its own', async () => {
  const store = newStore();
  const r = handedOverDeepening(store);
  store.jobs.put(job('job_synth', 'synthesis'));
  store.jobs.put(job('job_spot', 'spot-check', { status: 'Running', endedAt: null }));
  store.threads.put({ id: 'thr_1', projectId: P, title: 'K-1', ids: ['K-1'], progress: 'Done', validity: 'Current', serves: [] } as never, { jobId: 'job_l1', summary: 'Work item K-1' });
  const spot = toolsOf(store, 'spot-check', 'job_spot');
  // No Result yet: the spot-check writes none of its own.
  assert.match((await spot.call('pk_write_round_doc', { kind: 'Result', title: 'Result', markdown: '# Result' })).text, /The spot check corrects the round’s Result where a claim in it is wrong; this round has no Result to correct/);
  const synth = toolsOf(store, 'synthesis', 'job_synth');
  const wrote = await synth.call('pk_write_round_doc', { kind: 'Result', title: 'Result', markdown: '# Result\n\nK-2 had no follow-up.' });
  assert.equal(wrote.error, false, wrote.text);
  const resultId = String(wrote.json.id);
  // A sample item and a target checked in full, recorded: counted apart.
  const first = await spot.call('pk_record_spot_check', { checked: [{ target: { collection: 'threads', id: 'thr_1' }, kind: 'progress', verdict: 'Right' }, { target: { collection: 'notes', id: 'note_first' }, kind: 'note', verdict: 'Right' }] });
  assert.equal(first.error, false, first.text);
  assert.deepEqual((first.json.spotCheck as { synthesis: unknown; sampled: number }).synthesis, { outputs: 2, checked: 1, wrong: 0 }, 'the standing note and the Result are the two checked in full');
  assert.match(String(first.json.note), /1 of the 2 targets checked in full .* are not recorded yet/);
  // A wrong claim in the Result: corrected in place — it stays the synthesis' document — then recorded.
  assert.match((await spot.call('pk_record_spot_check', { checked: [{ target: { collection: 'roundDocs', id: resultId }, kind: 'no follow-up', verdict: 'Wrong', correction: 'K-2 was delivered by a later commit' }] })).text, /nothing in this job wrote to roundDocs/);
  const corrected = await spot.call('pk_write_round_doc', { kind: 'Result', markdown: '# Result\n\nK-2 was delivered by a later commit (abc1234).' });
  assert.equal(corrected.error, false, corrected.text);
  assert.deepEqual([corrected.json.id, corrected.json.replaced], [resultId, true]);
  assert.equal(store.roundDocs.get(resultId)!.jobId, 'job_synth', 'still the synthesis’ document');
  assert.match(store.roundDocs.get(resultId)!.markdown, /abc1234/);
  const recorded = await spot.call('pk_record_spot_check', { checked: [{ target: { collection: 'roundDocs', id: resultId }, kind: 'no follow-up', verdict: 'Wrong', correction: 'K-2 was delivered by a later commit' }] });
  assert.equal(recorded.error, false, recorded.text);
  const counts = store.clerkRounds.get(r.id)!.spotCheck!;
  assert.deepEqual([counts.sampled, counts.wrong, counts.corrected, counts.synthesis], [3, 1, 1, { outputs: 2, checked: 2, wrong: 1 }], 'in full: 2 checked, 1 wrong; the sample: 1 checked, 0 wrong');
  assert.equal(recorded.json.note, undefined, 'everything checked in full is recorded');
});

// ───────────────────────── E · an old home; the Keeper view ─────────────────────────

test('an old home without the synthesis’ step setting runs the synthesis on what the main agent is set to', () => {
  assert.deepEqual(STEP_SETTING_AS, { synthesis: 'main' });
  // The resident home's settings as they stood before D103: no entry for the synthesis.
  const old = { 'session-drafts': { model: 'glm-5.3', thinking: 'max' }, main: { model: 'glm-5.3', thinking: 'max' }, lane: { model: 'glm-5.3-flash', thinking: 'high' }, 'spot-check': { model: 'glm-5.3', thinking: 'max' } };
  assert.deepEqual(stepSettingOf(old, 'synthesis'), { model: 'glm-5.3', thinking: 'max' }, 'the same as main');
  assert.deepEqual(stepSettingOf(old, 'lane'), { model: 'glm-5.3-flash', thinking: 'high' });
  assert.deepEqual(stepSettingOf(old, 'main'), { model: 'glm-5.3', thinking: 'max' });
  // Its own setting takes effect, each part it leaves unset still the main agent's.
  assert.deepEqual(stepSettingOf({ ...old, synthesis: { thinking: 'high' } }, 'synthesis'), { model: 'glm-5.3', thinking: 'high' });
  assert.deepEqual(stepSettingOf({ ...old, synthesis: { model: 'glm-5.3-flash', thinking: 'low' } }, 'synthesis'), { model: 'glm-5.3-flash', thinking: 'low' });
  // No settings at all: the chosen model, as for every step.
  assert.equal(stepSettingOf(undefined, 'synthesis'), undefined);
  assert.equal(stepSettingOf({}, 'synthesis'), undefined);
  assert.equal(stepSettingOf({ lane: { model: 'x' } }, 'spot-check'), undefined, 'no other step borrows a setting');
});

test('the Keeper view’s round tree shows the synthesis as its own step with its time and usage, the main agent’s stages ending at its handover, and the handover openable', () => {
  const store = newStore();
  const r = handedOverDeepening(store);
  store.clerkRounds.put({ ...r, stageLog: [{ stage: 'orientation', startedAt: AT, endedAt: AT, timing: null }, { stage: 'cross-check', startedAt: AT, endedAt: LATER, timing: null }] });
  store.roundDocs.put({ ...store.roundDocs.get('rdoc_h')!, jobId: 'job_main' });
  store.jobs.put(job('job_synth', 'synthesis', { queuedAt: LATER, usage: { input: 52_000, output: 4_000, cacheRead: 0, cacheWrite: 0, cost: null } }));
  store.roundDocs.put(doc('rdoc_result', 'Result', '# Result', { jobId: 'job_synth' }));
  store.jobs.put(job('job_spot', 'spot-check', { queuedAt: '2026-10-01T12:00:00.000Z' }));
  const view = roundsView(store).find((v) => v.id === 'round_2')!;
  const steps = view.steps.filter((s) => s.kind !== 'lane');
  assert.deepEqual(steps.map((s) => s.kind), ['main', 'synthesis', 'spot-check']);
  const synth = steps.find((s) => s.kind === 'synthesis')!;
  assert.deepEqual([synth.jobId, synth.status, synth.usage?.input, synth.timing?.wallMs], ['job_synth', 'Done', 52_000, 60_000], 'its own job, time and usage');
  assert.deepEqual(synth.docs.map((d) => d.kind), ['Result'], 'the round’s Result opens under it');
  // The main agent: its stages end at its last one; it handed over, and the handover opens from the tree.
  assert.deepEqual(view.main!.stages.map((s) => [s.stage, s.current]), [['orientation', false], ['cross-check', false]]);
  assert.equal(view.main!.stage, 'cross-check');
  assert.deepEqual([view.main!.handover!.at, view.main!.handover!.doc?.id, view.main!.handover!.doc?.kind], [LATER, 'rdoc_h', 'Handover']);
  assert.ok(steps.find((s) => s.kind === 'main')!.docs.some((d) => d.id === 'rdoc_h' && d.kind === 'Handover'), 'among the main agent’s documents');
  // What the round did with the notes standing from earlier rounds, counted live while it runs.
  assert.deepEqual(view.standingNotes, { standing: 1, confirmed: 0, updated: 0, withdrawn: 0, open: 1 });
  // What a watcher of a running round reads: each step's kind and status, and the main agent's stage.
  assert.deepEqual(steps.map((s) => `${s.kind}=${s.status}`), ['main=Done', 'synthesis=Done', 'spot-check=Done']);
});

// ───────────────────────── D105 (CU): what the owner reads carries no internal identifiers ─────────────────────────

test('a standing note the owner cannot read is not confirmed as it stands; the round’s Result is refused with internal identifiers, the agents’ own documents are not (D105; CKC-08 AC-26, AC-27)', async () => {
  const store = newStore();
  const r = handedOverDeepening(store);
  const version = (title: string, preview: string, ask: Note['versions'][number]['ask'], currentView: string) => ({ versions: [{ version: 1, at: EARLIER, title, preview, body: { currentView, whyItMatters: null, facts: [], otherExplanations: null, keepAdjust: null, whatWouldSettleIt: null }, ask, judgementRecordId: 'jdg_first', reason: 'synthesis of the round' }] }) as Partial<Note>;
  store.notes.put(note('note_ids', 'The cooling log', EARLIER, version('The cooling log', 'The cooling log has two decisions with no line saying one replaced the other.', 'For information', 'Both carry a mark (mark_7236fe3d8503083c); the list is in the plan K lane’s report §2.')));
  store.notes.put(note('note_decide', 'Which glaze test stands', EARLIER, version('Which glaze test stands', 'The glaze was tested twice. Which result stands is for the owner.', 'For your decision', 'The second test used a different kiln.')));
  store.jobs.put(job('job_synth', 'synthesis', { status: 'Running', endedAt: null }));
  store.judgements.put(judgement('jdg_synth', 'job_synth'));
  const synth = toolsOf(store, 'synthesis', 'job_synth', 'jdg_synth');

  // It may still hold; it is not confirmed in a form the owner cannot read: its result is an update, written anew.
  const ids = await synth.call('pk_confirm_note', { id: 'note_ids', read: ['docs/PLAN.md:5'] });
  assert.equal(ids.error, true);
  assert.match(ids.text, /It carries 2 internal identifiers[^]*“mark_7236fe3d8503083c” in currentView \(a ProjectKeeper store id\)[^]*“plan K lane’s report §2” in currentView \(a section of a lane’s report or brief\)/);
  assert.match(ids.text, /it is not confirmed in this form: give it its result by updating it \(pk_write_note with id "note_ids"\)[^]*Nothing was recorded\.$/);
  const decide = await synth.call('pk_confirm_note', { id: 'note_decide', read: ['docs/PLAN.md:5'] });
  assert.match(decide.text, /opens with the question[^]*This one opens with “The glaze was tested twice\.”[^]*at least two in options[^]*Nothing was recorded\.$/);
  assert.equal(store.judgements.get('jdg_synth')!.outcome.stillHolds, undefined, 'nothing was recorded');
  // Updated in the form the owner reads: that is its result.
  const updated = await synth.call('pk_write_note', { id: 'note_ids', currentView: 'Both decisions are marked as never written into the decision log; the plan’s own list names them.', reason: 'written again for the owner to read' });
  assert.equal(updated.error, false, updated.text);
  const asked = await synth.call('pk_write_note', { id: 'note_decide', preview: 'Which of the two glaze tests stands? They used different kilns.', options: [{ option: 'The first test', then: 'the second is recorded as a re-run on other equipment' }, { option: 'The second test', then: 'the acceptance line is edited to its figure' }], reason: 'the question first, with the options' });
  assert.equal(asked.error, false, asked.text);
  assert.deepEqual(standingNotes(store, r).filter((s) => s.note.id === 'note_ids' || s.note.id === 'note_decide').map((s) => [s.note.id, s.result]), [['note_decide', 'updated'], ['note_ids', 'updated']]);

  // The Result is read by the owner: no store ids, no lane named as a lane. The agents' own documents keep theirs.
  const refused = await synth.call('pk_write_round_doc', { kind: 'Result', title: 'Result', markdown: '# Result\n\nNotes written: note_murawcjo06b7f3d3. The plan K lane found K-1 delivered.' });
  assert.equal(refused.error, true);
  assert.match(refused.text, /The round’s Result is read by the owner, and it carries 2 internal identifiers: “note_murawcjo06b7f3d3” in markdown \(a ProjectKeeper store id\); “plan K lane” in markdown \(the name of a lane\)\./);
  assert.equal(store.roundDocs.filter((d) => d.kind === 'Result').length, 0, 'nothing was written');
  const wrote = await synth.call('pk_write_round_doc', { kind: 'Result', title: 'Result', markdown: '# Result\n\nOne note was written again for the owner to read (the cooling log). Plan K: the first item is delivered.' });
  assert.equal(wrote.error, false, wrote.text);
  store.jobs.put(job('job_spot', 'spot-check', { status: 'Running', endedAt: null }));
  const spot = toolsOf(store, 'spot-check', 'job_spot');
  const own = await spot.call('pk_write_round_doc', { kind: 'Spot check', title: 'Spot check', markdown: '# Spot check\n\nChecked note_ids against rdoc_7900ff2b10ca0222 (the plan K lane’s report §2).' });
  assert.equal(own.error, false, own.text);
});
