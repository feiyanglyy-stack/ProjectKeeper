/**
 * BH, as D99 runs it: every planned material of a Full deepening has an outcome before the cross-check (Spec §3.3
 * 每份材料都有交代, §3.7; CKC-23 AC-20), run live through App + pi against the loopback fake provider. No real model, no
 * network, no real repository. The reading assignments BH built (E142) are gone with D99: the main agent's lanes read by
 * their briefs, and the coverage check is a check after them, not the unit work is handed out by.
 *
 * The scripted clerk's lanes read what this test has them read, and leave the rest. What it proves:
 *   - the plan is what the lanes' briefs name, each material once — a document one material, however many versions;
 *   - the coverage check lists what no lane read whole, by category and directory, reads in part apart;
 *   - a follow-up lane settles what it reads; what it was sent for and did not read is listed again;
 *   - the cross-check of a Full deepening is refused until everything is read or accounted for, with why;
 *   - the round keeps what no lane read and the accounts for the Keeper view, and the cross-check gets every lane's report.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'qc-bh-'));
process.env.PI_CODING_AGENT_DIR = join(scratch, 'pi-agent');
// The ledger reads sessions from the machine's home: this run has a home of its own.
process.env.USERPROFILE = join(scratch, 'user');
process.env.HOME = join(scratch, 'user');
mkdirSync(join(scratch, 'user'), { recursive: true });
after(() => { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const { App } = await import('../server/app.ts');
const { startFakeProvider, callResults, taskText, FAKE_MODEL } = await import('../keeper/fake-provider.ts');
const { clerkPlanner, jobOf, roundKindOf } = await import('../keeper/testing/clerk-script.ts');
import type { ScriptedLane } from '../keeper/testing/clerk-script.ts';
const { roundsView } = await import('../server/k-views.ts');

// ───────────────────────── the fixture project ─────────────────────────

const ENV = { GIT_AUTHOR_NAME: 'Orchard Dev', GIT_AUTHOR_EMAIL: 'dev@orchard.invalid', GIT_COMMITTER_NAME: 'Orchard Dev', GIT_COMMITTER_EMAIL: 'dev@orchard.invalid' };
const projectDir = mkdtempSync(join(scratch, 'project-'));
const git = (args: string[], date: string) => execFileSync('git', ['--no-optional-locks', '-C', projectDir, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel: string, text: string) => { mkdirSync(join(projectDir, rel, '..'), { recursive: true }); writeFileSync(join(projectDir, rel), text); };

git(['init', '-q', '-b', 'main'], '2026-09-01T09:00:00+00:00');
write('README.md', '# Orchard\n\nPicks apples.\n');
write('docs/plan.md', '# Plan\n\n## T-1 Hand picking\n\nPick by hand, on ladders.\n');
write('design/DECISIONS.md', '# Decisions\n\n**D1 · Pick by hand first.**\n\nBy hand before any robot.\n');
write('src/a.ts', 'export const a = 1;\n');
write('src/b.ts', 'export const b = 2;\n');
write('src/b2.ts', 'export const b2 = 3;\n');
// A file too large for one assignment (the fake model's window is 200k tokens: an assignment holds about 78 KB).
write('src/big.ts', Array.from({ length: 2400 }, (_, i) => `export const line${i} = '${'x'.repeat(40)}';`).join('\n') + '\n');
git(['add', '-A'], '2026-09-01T09:00:00+00:00');
git(['commit', '-q', '-m', 'Start the orchard'], '2026-09-01T09:00:00+00:00');
write('docs/plan.md', '# Plan\n\n## T-1 Hand picking\n\nPick by hand.\n\n## T-2 Conveyor\n\nBuild the conveyor.\n');
git(['add', '-A'], '2026-09-03T09:00:00+00:00');
git(['commit', '-q', '-m', 'T-2 planned; ladders dropped'], '2026-09-03T09:00:00+00:00');
const firstCommit = git(['rev-list', '--max-parents=0', 'HEAD'], '2026-09-03T09:00:00+00:00').trim();

// ───────────────────────── the scripted clerk ─────────────────────────

const CODE = 'The code as it stands: src';
const OWNER = "The owner's meaning: decisions";
const PLANS = 'The document chain and decisions: plans';
const PROCESS = "Each work item's process and checks: the start";
const FOLLOW = 'Follow up: src';
const brief = (name: string, read: string) => `# Brief: ${name}\n\n1. Background: Orchard. 2. Rules: read only, cite. 3. Read: ${read}. 4. Verdicts: present / replaced / no follow-up. 5. Clues: 以后. 6. Report: complete.`;
const LANES: readonly ScriptedLane[] = [
  { name: OWNER, kind: 'topic', slots: [], brief: brief(OWNER, 'design/DECISIONS.md') },
  { name: PLANS, kind: 'topic', slots: [], brief: brief(PLANS, 'docs/plan.md in every version') },
  { name: PROCESS, kind: 'plan', slots: [], brief: brief(PROCESS, `the commit ${firstCommit.slice(0, 10)}`) },
  { name: CODE, kind: 'topic', slots: [], brief: brief(CODE, 'src/') },
];
const pages = (path: string, lines: number, size: number) => Array.from({ length: Math.ceil(lines / size) }, (_, i) => ({ name: 'read', args: { path, offset: 1 + i * size, limit: size } }));

type Msg = { role: string; content: unknown };
const ok = (messages: readonly Msg[], tool: string) => callResults(messages as never, tool).filter((c) => !/^(?:ERROR|No result provided)/.test(c.result));
const idOf = (result: string): string | null => /"id": "([^"]+)"/.exec(result)?.[1] ?? null;

/**
 * The deepening's main agent in its coverage stage, the way the method asks (Spec §3.3 每份材料都有交代): check; send a
 * follow-up lane for the code no lane read; check again — what the follow-up lane did not read is listed again; try the
 * cross-check (a Full deepening's gate refuses it while anything is listed); account for the rest, with why; move on.
 */
function coverageStage(messages: readonly Msg[]): ReturnType<ReturnType<typeof clerkPlanner>> {
  const checks = ok(messages, 'pk_coverage_check');
  const followBrief = ok(messages, 'pk_write_round_doc').find((c) => c.args.kind === 'Brief' && c.args.path === FOLLOW);
  const followSent = ok(messages, 'pk_send_lanes').some((c) => (c.args.lanes as { name: string }[]).some((l) => l.name === FOLLOW));
  const tried = callResults(messages as never, 'pk_stage').filter((c) => c.args.to === 'cross-check');
  const accounts = callResults(messages as never, 'pk_account_material');
  const entries = callResults(messages as never, 'pk_account_entries');
  if (!checks.length) return [{ name: 'pk_coverage_check', args: {} }];
  if (!followBrief) return [{ name: 'pk_write_round_doc', args: { kind: 'Brief', path: FOLLOW, title: FOLLOW, markdown: brief(FOLLOW, 'src/b.ts and src/big.ts, the code no lane read') } }];
  if (!followSent) return [{ name: 'pk_send_lanes', args: { lanes: [{ name: FOLLOW, kind: 'follow-up', briefDocId: idOf(followBrief.result), slots: [] }] } }];
  if (checks.length < 2) return [{ name: 'pk_coverage_check', args: {} }];
  if (!tried.length) return [{ name: 'pk_stage', args: { to: 'cross-check' } }];
  if (!accounts.length) {
    const listed = JSON.parse(checks[checks.length - 1]!.result) as { untouched: { group: string; read: 'none' | 'part'; holds?: { materials: string[] } }[] };
    // DA: a group that holds what nothing carries (here the decision record's entries, which no item carries yet) is
    // accounted for by key, each material with its own reason; a group that holds nothing, as a group.
    return listed.untouched.map((g) => ({ name: 'pk_account_material', args: g.holds
      ? { each: g.holds.materials.map((key) => ({ key, why: 'only its first two lines bear on the owner’s words; its entries are the reconciling’s to fill' })), outcome: g.read === 'part' ? 'part' : 'not needed' }
      : g.read === 'part'
        ? { group: g.group, outcome: 'part', why: 'only its first two lines bear on the owner’s words' }
        : { group: g.group, outcome: 'not needed', why: 'b.ts is a constant nothing imports; the follow-up lane found nothing that asks for it' } }));
  }
  // CZ: docs/plan.md alone defines T-1 and T-2, so the entry gate counts them though no layer names the file a plan; this
  // scripted round writes no work items, so it accounts for the two by number.
  if (!entries.length) return [{ name: 'pk_account_entries', args: { path: 'docs/plan.md', numbers: ['T-1', 'T-2'], why: 'the two headings of the plan, read by the plans lane; this round writes no work item of them' } }];
  return [{ name: 'pk_stage', args: { to: 'cross-check' } }];
}

const script = clerkPlanner({
  lanes: (round) => (round === 'Deepen' ? LANES : []),
  laneWork: (name) => {
    // What this test has the lanes leave: all but the first two lines of the decision record, and src/b.ts and
    // src/big.ts on the code lane; the follow-up lane reads big.ts, page by page, and leaves b.ts.
    if (name === OWNER) return [{ name: 'read', args: { path: 'design/DECISIONS.md', offset: 1, limit: 2 } }];
    if (name === PLANS) return [{ name: 'read', args: { path: 'docs/plan.md' } }];
    if (name === PROCESS) return [{ name: 'pk_ledger_commit', args: { hash: firstCommit } }];
    if (name === CODE) return [{ name: 'read', args: { path: 'src/a.ts' } }, { name: 'read', args: { path: 'src/b2.ts' } }];
    if (name === FOLLOW) return pages('src/big.ts', 2800, 700);   // the file tool shows about 50 KB a call
    return [];
  },
  stageWork: (_round, stage) => (stage === 'cross-check' ? [{ name: 'pk_write_round_doc', args: { kind: 'Adoption', title: 'What was adopted', markdown: '# Adoption\n\nNothing to adopt in this test.' } }] : []),
}, (task, messages) => {
  if (jobOf(task).kind !== 'main' || roundKindOf(task) !== 'Deepen') return undefined;
  const entered = ok(messages, 'pk_stage').map((c) => String(c.args.to));
  return entered[entered.length - 1] === 'coverage' ? coverageStage(messages) : undefined;
});
const planner = script;

async function until(check: () => boolean, ms = 120_000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('BH live (D99): a Full deepening’s coverage check lists what no lane read, a follow-up lane settles what it reads, the rest is listed again, and the cross-check waits until all is accounted for', { timeout: 600_000 }, async () => {
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

    await app.organizing.replan(project.id);
    await until(() => store.clerkRounds.find((r) => r.kind === 'First usable' && r.status !== 'Running') !== undefined, 120_000, 'the first usable round');
    assert.equal(store.clerkRounds.find((r) => r.kind === 'First usable')!.status, 'Done');
    await until(() => store.coverage.takeover?.stage === 'Daily', 30_000, 'the takeover done at First picture only');

    app.startTakeover(project.id, 'Full');
    await app.organizing.replan(project.id);
    await until(() => store.clerkRounds.find((r) => r.kind === 'Deepen' && r.status !== 'Running') !== undefined, 300_000, 'the deepening round');
    const deepen = store.clerkRounds.find((r) => r.kind === 'Deepen')!;
    assert.equal(deepen.status, 'Done', store.jobs.filter((j) => j.step?.roundId === deepen.id).map((j) => `${j.scope.label}=${j.status}:${j.error ?? ''}`).join('; '));
    assert.equal(deepen.reading ?? undefined, undefined, 'no reading assignments any more (D99)');
    assert.ok(!store.jobs.find((j) => j.step?.roundId === deepen.id && j.step.kind === 'dig'), 'no sweep job of the planner’s');

    // The main agent's session, as the fake saw it last: its checks, its refused cross-check, its accounts.
    const main = fake.requests.map((r) => r.messages as Msg[]).filter((m) => { const t = taskText(m as never); return jobOf(t).kind === 'main' && roundKindOf(t) === 'Deepen'; }).at(-1)!;
    const checks = ok(main, 'pk_coverage_check').map((c) => JSON.parse(c.result) as { untouched: { group: string; keys: string[]; read: string }[]; settled: boolean; totals: { planned: number; readWhole: number } });
    assert.equal(checks.length, 2, 'the main agent checked twice: after its lanes, and after its follow-up lane');

    // The plan: what each lane's brief names — a document once however many versions (D99), the commit, the code under
    // src/ — each material once.
    assert.equal(checks[0]!.totals.planned, 1 + 1 + 1 + 4, 'the decision record, the plan (one material), the commit, four code files');
    const listed = (c: (typeof checks)[number]) => Object.fromEntries(c.untouched.map((g) => [g.group, g.keys.map((k) => k.replace(/^.*?:/, ''))]));
    assert.deepEqual(listed(checks[0]!), { 'documents:design (read in part)': ['design/DECISIONS.md'], 'code files:src': ['src/b.ts', 'src/big.ts'] }, 'what no lane read whole, by category and directory: the decision record read in part, two code files not at all');
    // The follow-up lane read big.ts, page by page: it is settled; what it was sent for and did not read is listed again.
    assert.deepEqual(listed(checks[1]!), { 'documents:design (read in part)': ['design/DECISIONS.md'], 'code files:src': ['src/b.ts'] });
    assert.equal(checks[1]!.totals.readWhole, checks[0]!.totals.readWhole + 1);
    // A Full deepening enters the cross-check only once every planned material is read or accounted for (CKC-23 AC-20).
    const refused = callResults(main as never, 'pk_stage').find((c) => c.args.to === 'cross-check' && /^ERROR/.test(c.result));
    assert.ok(refused, 'the first try at the cross-check was refused');
    assert.match(refused.result, /the coverage check still lists material no lane touched/);
    const accounts = callResults(main as never, 'pk_account_material').map((c) => JSON.parse(c.result) as { accounted: number; settled: boolean });
    assert.deepEqual(accounts.map((a) => a.accounted), [1, 1]);
    assert.equal(accounts.at(-1)!.settled, true);

    // On the round, for the Keeper view: what no lane read whole, and each account beside it (Spec §6.9).
    const coverage = store.clerkRounds.get(deepen.id)!.coverage!;
    assert.equal(coverage.settled, true);
    assert.deepEqual(coverage.accounted.map((a) => [a.group ?? a.keys, a.outcome, a.by]), [[['doc:design/DECISIONS.md'], 'part', 'main'], ['code files:src', 'not needed', 'main']], 'DA: the decision record holds entries no item carries, so it is accounted for by its key; the code holds nothing and goes as a group');
    assert.match(coverage.accounted[0]!.holds ?? '', /numbers? no item carries/, 'the account keeps what the material held');
    assert.deepEqual((coverage.untouched ?? []).map((g) => g.keys.map((k) => k.replace(/^.*?:/, ''))), [['design/DECISIONS.md'], ['src/b.ts']], 'the view keeps what no lane read, the accounts standing beside it');
    const lanes = store.clerkRounds.get(deepen.id)!.lanes!;
    assert.deepEqual(lanes.map((l) => [l.name, l.kind, l.stage]), [...LANES.map((l) => [l.name, l.kind, 'dig']), [FOLLOW, 'follow-up', 'coverage']]);
    const tree = roundsView(store).find((r) => r.id === deepen.id)!;
    assert.equal(tree.coverage?.accounted.length, 2, 'the round tree shows the accounts');
    assert.deepEqual(tree.lanes!.map((l) => l.name), lanes.map((l) => l.name), 'and each lane');

    // The cross-check started once all was accounted for, and was given every lane's report.
    const entered = ok(main, 'pk_stage').find((c) => c.args.to === 'cross-check')!;
    for (const l of lanes) assert.ok(entered.result.includes(`- ${l.name.replace(/'/g, "\\u0027")}`) || entered.result.includes(`- ${l.name}`), `the cross-check is given ${l.name}'s report`);
    assert.deepEqual(store.clerkRounds.get(deepen.id)!.stageLog!.map((e) => e.stage), ['orientation', 'dig', 'coverage', 'cross-check']);
    assert.ok(store.clerkRounds.get(deepen.id)!.handover, 'and handed the round over to the synthesis (D103)');
  } finally {
    fake.close();
    app.stopAll();
    await new Promise((r) => setTimeout(r, 500));
    await app.flushAll();
  }
});
