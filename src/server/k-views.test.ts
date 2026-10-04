/**
 * The increment K views assembled from the assets (views-k.ts; Spec v3.0 §6.3, §6.9, §6.7, §1.18, §2.12): a work item
 * shows its four things and what is still open on it; a send-back carries the text `Copy for agent` puts on the clipboard,
 * with the CLI command that fetches the same item; the owner's `No action needed` stops a breakpoint and a send-back
 * lighting up and keeps the answer; a round's tree carries its steps' timing and its longest path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import type { KeeperJob, Project, WorkThread } from '../model/types.ts';
import type { Breakpoint, ClerkRound, Occurred, SendBack } from '../model/k-types.ts';
import { processView, respondToBreakpoint, respondToSendBack, roundsView, scopeKView } from './k-views.ts';

const at = (d: string): Occurred => ({ at: d, basis: 'Commit', anchor: null });
const project = { id: 'p1', name: 'Demo', locations: [], scope: [], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: '2026-09-01T00:00:00Z', lastOpenedAt: null, lastScopedAt: null } as unknown as Project;

function seeded(): ProjectStore {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-kviews-')));
  const thread = { id: 'thread_a', projectId: 'p1', title: 'BYOK', ids: [], doing: '', changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, inputs: { jobId: '', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: '', updatedAt: '', pendingSourceIds: [] } as unknown as WorkThread;
  store.threads.put(thread);
  store.numbers.put({ id: 'num_1', projectId: 'p1', number: 'K-1', objectId: 'thread_a', objectKind: 'work', projectNumber: null, at: '2026-09-02' });
  const bp: Breakpoint = { id: 'bp_1', projectId: 'p1', kind: 'Findings open', targetId: 'thread_a', why: 'AF found 7 issues; no fix follows', evidence: [{ kind: 'file', id: 'subagent/reports/AF-report.md', label: 'AF-report.md', line: 'Verdict: fail' }], basis: 'Explicit', since: at('2026-09-05'), lit: true, out: null, ownerResponse: null, confirmedInRoundId: null, sixThing: 5, sendBackId: 'sb_1', roundId: null, updatedAt: '' };
  store.breakpoints.put(bp);
  const sb: SendBack = { id: 'sb_1', projectId: 'p1', to: 'Work', stage: 'Suggested', targetId: 'thread_a', what: 'Seven QC findings on BYOK have no fix', suggestion: 'Open a fix task for the seven findings', evidence: bp.evidence, from: { kind: 'breakpoint', id: 'bp_1' }, returned: null, closed: null, ownerResponse: null, sixThing: 5, occurred: at('2026-09-05'), roundId: null, updatedAt: '' };
  store.sendbacks.put(sb);
  return store;
}

test('a work item shows its four things, its Keeper number and what is still open on it; the top bar counts what is lit', () => {
  const store = seeded();
  const view = processView(store, project);
  const w = view.works.thread_a!;
  assert.deepEqual(w.number, { value: 'K-1', byKeeper: true }, 'a number the Keeper gave says so');
  assert.equal(w.four.open.breakpoints, 1);
  assert.equal(w.four.open.sendBacks, 1);
  assert.deepEqual(w.sixThings, [5]);
  assert.equal(view.counts.breakpointsLit, 1);
  assert.equal(view.counts.byKind['Findings open'], 1);
  assert.equal(view.counts.sendBacksOpen, 1);
  const sb = view.sendBacks[0]!;
  assert.equal(sb.cliCommand, 'pk get sb_1 --project p1');
  assert.ok(sb.copyForAgent.includes(sb.cliCommand) && sb.copyForAgent.includes('Verdict: fail'), 'the copy carries the evidence line and the command (CKC-24 AC-9)');
  assert.deepEqual(view.sixThings.find((s) => s.thing === 5)!.objectIds, ['thread_a']);
});

test('the owner’s No action needed stops a breakpoint and a send-back lighting up, and the answer stays', () => {
  const store = seeded();
  const b = respondToBreakpoint(store, 'bp_1', 'The findings were accepted as they are');
  assert.equal(b.lit, false);
  assert.equal(b.ownerResponse!.reason, 'The findings were accepted as they are');
  const s = respondToSendBack(store, 'p1', 'sb_1', 'Handled outside the project');
  assert.equal(s.lit, false);
  const view = processView(store, project);
  assert.equal(view.counts.breakpointsLit, 0);
  assert.equal(view.counts.sendBacksOpen, 0);
  assert.ok(view.breakpoints[0]!.ownerResponse, 'the answer is kept');
});

test('a round’s tree carries each step’s timing; its longest path adds up the slowest job of each step', () => {
  const store = seeded();
  const round: ClerkRound = { id: 'crd_1', projectId: 'p1', kind: 'Deepen', number: 2, startedAt: '2026-09-26T10:00:00Z', endedAt: '2026-09-26T11:00:00Z', status: 'Done', rootJobId: 'job_root', questionsDocId: null, paths: ['owner', 'code'], outputs: [{ position: 'Work items (process view)', count: 3 }], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: { sampled: 10, wrong: 1, byKind: { 'code state': 1 }, corrected: 1 }, ledger: { ms: 4000, commitsAdded: 12 }, followUpRoundId: null, updatedAt: '' };
  store.clerkRounds.put(round);
  const job = (id: string, kind: 'dig' | 'cross-check', path: string | null, wall: number): KeeperJob => ({ id, projectId: 'p1', kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['crd_1'], label: id }, status: 'Done', queuedAt: `2026-09-26T10:0${id.length % 9}:00Z`, startedAt: null, endedAt: null, savedResults: [], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 }, agent: 'pi', model: { provider: 'zai', id: 'glm-5.3', thinking: 'max' }, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: 'job_root', resultText: null, priority: 1, task: null, step: { roundId: 'crd_1', kind, path }, timing: { wallMs: wall, generationMs: wall - 100, toolMs: 100, queueMs: 0, parseRetryMs: 0, otherMs: 0 } });
  store.jobs.put(job('job_d1', 'dig', 'owner', 30_000));
  store.jobs.put(job('job_d2', 'dig', 'code', 50_000));
  store.jobs.put(job('job_cc', 'cross-check', null, 20_000));
  const [view] = roundsView(store);
  assert.equal(view!.steps.length, 3);
  assert.equal(view!.longestPathMs, 50_000 + 20_000, 'the sweeps ran at once: the slower one counts, then the cross-check');
  assert.equal(view!.timing!.generationMs, 29_900 + 49_900 + 19_900);
  assert.equal(view!.usage!.output, 15);
  assert.equal(view!.spotCheck!.wrong, 1);
  assert.equal(view!.wallMs, 3_600_000);
});

test('Project scope shows the layers, the questions of the deepening and whether the project folder is granted', () => {
  const store = seeded();
  store.clerkRounds.put({ id: 'crd_0', projectId: 'p1', kind: 'First usable', number: 1, startedAt: '2026-09-26T09:00:00Z', endedAt: '2026-09-26T09:30:00Z', status: 'Done', rootJobId: 'r', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: '' });
  store.roundDocs.put({ id: 'doc_q', projectId: 'p1', roundId: 'crd_0', jobId: null, kind: 'Questions', path: null, title: 'Questions', markdown: '...', at: '' });
  store.roundDocs.put({ id: 'doc_b', projectId: 'p1', roundId: 'crd_0', jobId: null, kind: 'Brief', path: 'owner meaning', title: 'Brief', markdown: '...', at: '' });
  store.layers.put({ id: 'lay_1', projectId: 'p1', repo: null, path: 'design/DECISIONS.md', layer: 'Decision record', note: null, current: true, roundId: 'crd_0', updatedAt: '' });
  const view = scopeKView(store, project);
  assert.deepEqual(view.layers.map((l) => l.layer), ['Decision record']);
  assert.deepEqual(view.questions, { roundId: 'crd_0', docId: 'doc_q', paths: ['owner meaning'] });
  assert.equal(view.projectFolder!.granted, false, 'no folder is written without the authorization (CKC-26 AC-7)');
  assert.equal(view.ledger, null, 'without the ledger the coverage is not invented');
});

test('a plan with an execution shape is a unit of the process view: no steps of its own, its batches, what is open on it (CKC-24 AC-2)', () => {
  const store = seeded();
  const plan = (id: string, progress: string) => ({ id, projectId: 'p1', category: 'Plan', name: `Plan ${id}`, ids: [], text: '', quote: null, basis: 'Explicit', validity: 'Current', progress, attribution: null, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: '', updatedAt: '' });
  store.reference.put(plan('ref_plan', 'In progress') as never);
  store.reference.put(plan('ref_no_shape', 'Done') as never);
  store.sendbacks.put({ ...store.sendbacks.get('sb_1')!, id: 'sb_plan', targetId: 'ref_plan', to: 'Plan', from: { kind: 'owner-judgement', id: 'ref_plan' } });
  const shape = { planId: 'ref_plan', actualOrder: '1 → 2', plannedOrder: '2 → 1', differs: 'batch 2 ran first', dependsOn: [],
    batches: ['1', '2'].map((label) => ({ label, workIds: ['thread_a'], parallel: false, running: false, agent: null, worktree: null, mergeCommit: null, occurred: null })) };
  const view = processView(store, project, { process: { work: () => null, plan: (_s, _p, id) => (id === 'ref_plan' ? shape : null) } });
  const w = view.works.ref_plan!;
  assert.deepEqual(w.steps, [], 'a plan has no steps of its own; its batches are its shape');
  assert.equal(w.folded, '2 batches · execution differed from the plan · open items');
  assert.deepEqual([w.four.execution, w.four.progress, w.four.open.sendBacks], [null, 'In progress', 1]);
  assert.deepEqual(w.sendBackIds, ['sb_plan']);
  assert.equal(view.plans.ref_plan, shape);
  assert.equal(view.works.ref_no_shape, undefined, 'a plan the engine gives no shape for is not made a unit');
});

test('a round the main agent runs (D99): the main agent with its stages, its lanes with their question, slots, status and reads, the coverage check and the missing steps; an older round has none of it', () => {
  const store = seeded();
  const base = { projectId: 'p1', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, ledger: null, followUpRoundId: null, updatedAt: '' };
  const t = (m: number) => new Date(Date.parse('2026-09-29T10:00:00Z') + m * 60_000).toISOString();
  const timing = (ms: number) => ({ wallMs: ms, generationMs: ms / 2, toolMs: ms / 2, queueMs: 0, parseRetryMs: 0, otherMs: 0 });
  const round: ClerkRound = {
    ...base, id: 'crd_d99', kind: 'Deepen', number: 3, startedAt: t(0), endedAt: t(60), status: 'Done', rootJobId: 'job_root', spotCheck: { sampled: 4, wrong: 0, byKind: {}, corrected: 0 },
    stage: 'synthesis',
    stageLog: [
      { stage: 'orientation', startedAt: t(1), endedAt: t(10), timing: timing(540_000) },
      { stage: 'dig', startedAt: t(10), endedAt: t(40), timing: timing(1_800_000) },
      { stage: 'coverage', startedAt: t(40), endedAt: t(45), timing: timing(300_000) },
      { stage: 'cross-check', startedAt: t(45), endedAt: t(50), timing: timing(300_000) },
      { stage: 'synthesis', startedAt: t(50), endedAt: null, timing: null },
    ],
    lanes: [
      { name: 'PLAN K', kind: 'plan', briefDocId: 'brief_k', slots: ['threads', 'links'], jobId: 'job_lane_k', stage: 'dig', sentAt: t(10), reportDocId: 'report_k' },
      { name: 'pi runtime', kind: 'topic', briefDocId: 'brief_pi', slots: ['territories', 'reference:Design'], jobId: 'job_lane_pi', stage: 'dig', sentAt: t(10), reportDocId: null },
    ],
    coverage: {
      at: t(44), settled: true,
      untouched: [{ group: 'code files · src/ui', category: 'code files', dir: 'src/ui', count: 3, bytes: 4_200, keys: ['a', 'b', 'c'] }],
      accounted: [{ group: 'code files · src/ui', outcome: 'not needed', why: 'generated', by: 'main', at: t(44) }],
    },
  };
  store.clerkRounds.put(round);
  const old: ClerkRound = { ...base, id: 'crd_old', kind: 'Deepen', number: 2, startedAt: '2026-09-26T10:00:00Z', endedAt: '2026-09-26T11:00:00Z', status: 'Done', rootJobId: 'job_old', spotCheck: null };
  store.clerkRounds.put(old);
  const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.5 };
  const job = (id: string, over: Partial<KeeperJob>): KeeperJob => ({ id, projectId: 'p1', kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['crd_d99'], label: id }, status: 'Done', queuedAt: t(0), startedAt: t(0), endedAt: t(1), savedResults: [], usage, agent: 'pi', model: { provider: 'zai', id: 'glm-5.3', thinking: 'max' }, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: 'job_root', resultText: null, priority: 1, task: null, step: null, timing: null, ...over });
  const read = (reads: NonNullable<KeeperJob['steps'][number]['reads']>) => ({ at: t(12), tool: 'read', target: '', summary: '', isError: false, reads });
  store.jobs.put(job('job_ledger', { agent: 'program', usage: { ...usage, cost: null }, queuedAt: t(0), step: { roundId: 'crd_d99', kind: 'ledger', path: null }, timing: timing(60_000) }));
  store.jobs.put(job('job_main', { queuedAt: t(1), startedAt: t(1), endedAt: t(55), step: { roundId: 'crd_d99', kind: 'main', path: null }, timing: timing(3_240_000) }));
  store.jobs.put(job('job_lane_k', {
    queuedAt: t(10), startedAt: t(10), endedAt: t(30), parentJobId: 'job_main', status: 'Done', step: { roundId: 'crd_d99', kind: 'lane', path: 'PLAN K', lane: { kind: 'plan', slots: ['threads', 'links'] } }, timing: timing(1_200_000),
    steps: [read([{ path: 'D:/p/docs/PLAN.md' }, { path: 'D:/p/docs/PLAN.md', from: 1, to: 20, lines: 80 }]), read([{ path: 'D:/p/docs/PLAN.md', rev: 'abcdef1234567890' }, { rev: 'ABCDEF1234567890' }, { session: 'ses_1', from: 1, to: 4, lines: 4 }])],
  }));
  store.jobs.put(job('job_lane_pi', { queuedAt: t(10), startedAt: t(11), endedAt: null, parentJobId: 'job_main', status: 'Running', step: { roundId: 'crd_d99', kind: 'lane', path: 'pi runtime', lane: { kind: 'topic', slots: ['territories', 'reference:Design'] } }, steps: [read([{ path: 'D:/p/src/runtime.ts' }])] }));
  // The investigation the pi lane sent: its reads are the lane's, its usage too; it is no step of the round.
  store.jobs.put(job('job_inv', { kind: 'Investigation', parentJobId: 'job_lane_pi', steps: [read([{ path: 'D:/p/src/runtime.ts' }, { path: 'D:/p/src/roles.ts' }])] }));
  // The investigation the main agent sent stands under it; its lanes do not (they stand in `lanes`).
  store.jobs.put(job('job_main_inv', { kind: 'Investigation', parentJobId: 'job_main' }));
  store.jobs.put(job('job_spot', { queuedAt: t(56), startedAt: t(56), endedAt: t(59), step: { roundId: 'crd_d99', kind: 'spot-check', path: null }, timing: timing(180_000) }));
  const doc = (id: string, jobId: string, kind: 'Brief' | 'Report' | 'Adoption', path: string | null, markdown: string) => store.roundDocs.put({ id, projectId: 'p1', roundId: 'crd_d99', jobId, kind, path, title: `${kind}${path ? `: ${path}` : ''}`, markdown, at: t(9) });
  doc('brief_k', 'job_main', 'Brief', 'PLAN K', '# Brief: PLAN K\n\nWas each K work item done, and where is the evidence?\nWhat is still open?\n\n1. Background: shared.\n2. Rules: read only.\n');
  doc('brief_pi', 'job_main', 'Brief', 'pi runtime', '# Brief: pi runtime\n\nWhich pi components does the Keeper use?\n');
  doc('report_k', 'job_lane_k', 'Report', 'PLAN K', '# Report: PLAN K\n');
  doc('adoption', 'job_main', 'Adoption', null, '# Adoption\n');
  store.breakpoints.put({ ...store.breakpoints.get('bp_1')!, looked: { roundId: 'crd_d99', jobId: 'job_lane_k', where: ['docs/PLAN.md'], at: t(20) }, checked: { roundId: 'crd_d99', jobId: 'job_spot', at: t(58) } });
  store.breakpoints.put({ ...store.breakpoints.get('bp_1')!, id: 'bp_2', lit: false, looked: { roundId: 'crd_d99', jobId: 'job_lane_pi', where: ['src/runtime.ts'], at: t(21) }, checked: null });

  const views = roundsView(store);
  const v = views.find((r) => r.id === 'crd_d99')!;
  assert.equal(v.main!.jobId, 'job_main');
  assert.equal(v.main!.stage, 'synthesis');
  assert.deepEqual(v.main!.stages.map((s) => [s.stage, s.current]), [['orientation', false], ['dig', false], ['coverage', false], ['cross-check', false], ['synthesis', true]], 'the stage it is in is the current one');
  assert.equal(v.main!.stages[1]!.timing!.wallMs, 1_800_000, 'each stage has its time');

  assert.deepEqual(v.lanes!.map((l) => [l.name, l.kind, l.status, l.stage]), [['PLAN K', 'plan', 'Done', 'dig'], ['pi runtime', 'topic', 'Running', 'dig']]);
  const [k, pi] = v.lanes!;
  assert.equal(k!.question, 'Was each K work item done, and where is the evidence?\nWhat is still open?\n1. Background: shared.', 'the question is the first lines of its brief, headings left out');
  assert.deepEqual(k!.slots, ['threads', 'links']);
  assert.deepEqual(k!.read, { files: 1, versions: 1, commits: 1, sessions: 1 }, 'each material once: a file read whole and in part is one file; a version, a commit and a session each count');
  assert.deepEqual(pi!.read, { files: 2, versions: 0, commits: 0, sessions: 0 }, 'what the jobs a lane sent read counts as the lane’s');
  assert.deepEqual([k!.brief?.id, k!.report?.id, pi!.brief?.id, pi!.report], ['brief_k', 'report_k', 'brief_pi', null]);
  assert.equal(pi!.usage!.input, 200, 'a lane’s usage holds the jobs it sent');

  const mainStep = v.steps.find((s) => s.kind === 'main')!;
  assert.deepEqual(mainStep.docs.map((d) => d.id), ['adoption'], 'the lanes’ briefs stand under the lanes, not the main agent');
  assert.deepEqual(mainStep.children.map((c) => c.jobId), ['job_main_inv'], 'the main agent’s children are the jobs it sent that are not steps of the round');
  assert.equal(v.usage!.input, 100 * 6, 'each job of the round once, the ledger aside: a lane is a step and a job the main agent sent, counted once');
  assert.equal(v.longestPathMs, 60_000 + 3_240_000 + 180_000, 'the lanes run inside the main agent’s time');

  assert.deepEqual(v.coverage, { at: t(44), settled: true, untouched: round.coverage!.untouched, accounted: round.coverage!.accounted });
  assert.deepEqual(v.missing, { looked: 2, checked: 1 });

  const o = views.find((r) => r.id === 'crd_old')!;
  assert.deepEqual([o.main, o.lanes, o.coverage, o.missing], [undefined, undefined, undefined, undefined], 'a round from before D99 reads as its steps');
});
