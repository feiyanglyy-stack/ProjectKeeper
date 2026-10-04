/**
 * A takeover end to end, as D99 and D103 run it, on a small project and two fake keys (in the style of keys.test.ts and
 * lanes-keys.test.ts): the planner, the runtime, pi, the skills, the tools and the process engine are the real ones; the
 * model is a scripted clerk (testing/clerk-script.ts) behind two key doubles.
 *
 *   First usable   orientation maps the layers → the skeleton fills the PLAN table with pk_fill_from_table and the
 *                  decision record, kept as bold entries, whole with pk_fill_from_bold (CJ), and sends its slot lanes in
 *                  one call → reconcile, which it leaves only once every counted entry is on the workbench (CJ, E150) →
 *                  its handover, where the main job ends → the synthesis, a job of its own in a new session, which
 *                  writes the note and the Result (D103). It closes with the work items the table names, each Planned with its written status kept,
 *                  each decision named by its number and title as written, and no breakpoint lit (CKC-23 AC-21, AC-22;
 *                  Spec §2.12, §3.7).
 *   Deepen (Full)  a lane per kind of question; the plan lane reads K-1's delivery and sets its progress, and gives each
 *                  of its two candidates one result (CD): K-4's delivery, a commit without its number, it finds and
 *                  links (pk_link_process); K-2's it looks for and does not find (pk_record_looked). The coverage check
 *                  lists what no lane read and the main agent accounts for it; the cross-check confirms the link; the
 *                  round is handed over at once, since every candidate has a result; the synthesis, in its own session,
 *                  is given the handover, the lane reports by id and the note the first round left, which it updates;
 *                  then the independent spot-check follows: it checks the looked candidate and lights it — the only way
 *                  a breakpoint lights (CKC-24 AC-7) — and checks in full what the synthesis wrote; the linked one goes out.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-e2e-'));
process.env.PI_CODING_AGENT_DIR = join(scratch, 'pi-agent');
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
// The ledger reads sessions from the machine's home: this run has a home of its own.
process.env.USERPROFILE = join(scratch, 'user');
process.env.HOME = join(scratch, 'user');
mkdirSync(join(scratch, 'user'), { recursive: true });
after(() => { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const { App } = await import('../../server/app.ts');
const { startFakeProvider, callResults, taskText, FAKE_MODEL } = await import('../fake-provider.ts');
const { clerkPlanner, jobOf, roundKindOf } = await import('../testing/clerk-script.ts');
import type { ScriptedLane } from '../testing/clerk-script.ts';
import type { ProjectStore } from '../../store/project-store.ts';

// ───────────────────────── the fixture project ─────────────────────────

const ENV = { GIT_AUTHOR_NAME: 'Kiln Dev', GIT_AUTHOR_EMAIL: 'dev@kiln.invalid', GIT_COMMITTER_NAME: 'Kiln Dev', GIT_COMMITTER_EMAIL: 'dev@kiln.invalid' };
const projectDir = mkdtempSync(join(scratch, 'kiln-'));
const git = (args: string[], date: string) => execFileSync('git', ['--no-optional-locks', '-C', projectDir, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel: string, text: string) => { mkdirSync(join(projectDir, rel, '..'), { recursive: true }); writeFileSync(join(projectDir, rel), text); };
const commit = (message: string, date: string) => { git(['add', '-A'], date); git(['commit', '-q', '-m', message], date); };

git(['init', '-q', '-b', 'main'], '2026-09-01T09:00:00+00:00');
write('README.md', '# Kiln\n\nA pottery workshop planner: mix the clay, fire the kiln, glaze the pots.\n');
write('docs/PLAN.md', [
  '# Plan', '', '## Work items', '',
  '| ID | Task | Module | Status |',
  '| --- | --- | --- | --- |',
  '| K-1 | Mix the clay | Clay | done |',
  '| K-2 | Fire the kiln | Kiln | done |',
  '| K-3 | Glaze the pots | Kiln | ready |',
  '| K-4 | Cool the kiln | Kiln | done |',
  '',
].join('\n'));
write('design/DECISIONS.md', [
  '# Decisions', '',
  '**D1 · Mix before firing.** The clay is mixed before any firing.', '',
  '**D2 · One kiln at a time.** Only one firing runs at once.', '',
  '**D3 · Glaze last.** Glazing waits for the cooled pots.', '',
  '**D3 补（2026-09-02）**：glaze only pots that passed the tap test.', '',
].join('\n'));
const prompt = (id: string, title: string, status: string) => `---\nid: "${id}"\nexecutor: "claude"\nstatus: "${status}"\n---\n\n# ${id} · ${title}\n\nDo ${title.toLowerCase()}.\n`;
write('subagent/K-1-mix.md', prompt('K-1', 'Mix the clay', 'ready'));
write('subagent/K-2-fire.md', prompt('K-2', 'Fire the kiln', 'ready'));
write('subagent/K-3-glaze.md', prompt('K-3', 'Glaze the pots', 'ready'));
write('subagent/K-4-cool.md', prompt('K-4', 'Cool the kiln', 'ready'));
commit('Plan the workshop', '2026-09-01T09:00:00+00:00');
// K-1 is delivered: a commit that opens with its number. K-2 is reported done in its prompt, and nothing delivers it.
write('src/clay.ts', 'export const mix = (water: number, clay: number) => water / clay;\n');
write('subagent/K-1-mix.md', prompt('K-1', 'Mix the clay', 'done'));
commit('K-1: mix the clay', '2026-09-02T09:00:00+00:00');
write('subagent/K-2-fire.md', prompt('K-2', 'Fire the kiln', 'done'));
commit('Mark K-2 done', '2026-09-03T09:00:00+00:00');
// K-4 is delivered by a commit that does not carry its number, and reported done in its prompt: a candidate the program
// finds by numbers, which a lane that reads the commits answers.
write('src/kiln.ts', 'export const cool = (hours: number) => hours >= 12;\n');
commit('Cool the kiln slowly after firing', '2026-09-04T09:00:00+00:00');
const K4_DELIVERY = git(['rev-parse', 'HEAD'], '2026-09-04T09:00:00+00:00').trim();
write('subagent/K-4-cool.md', prompt('K-4', 'Cool the kiln', 'done'));
commit('Mark K-4 done', '2026-09-05T09:00:00+00:00');

// ───────────────────────── the scripted clerk ─────────────────────────

/** The store the scripted lanes and spot-check read ids from, as a model would from pk_read_assets. */
let store: ProjectStore | null = null;
const threadOf = (num: string) => store!.threads.find((t) => t.ids.includes(num));
const candidateOf = (num: string) => { const t = threadOf(num); return t ? store!.breakpoints.find((b) => b.targetId === t.id && b.kind === 'No trace of done' && !b.out) : undefined; };

const FIRST: readonly ScriptedLane[] = [
  { name: 'Product and modules', kind: 'slot', slots: ['reference:Product', 'reference:Area'], brief: '# Brief\n\nThe product and its modules: README.md, docs/PLAN.md.' },
  { name: 'Code territories', kind: 'slot', slots: ['territories'], brief: '# Brief\n\nThe code under src/.' },
];
const PLAN_LANE = "Each work item's process and checks: PLAN";
const DEEPEN: readonly ScriptedLane[] = [
  { name: PLAN_LANE, kind: 'plan', slots: ['threads', 'links'], brief: "# Brief\n\nEach work item's process and checks for docs/PLAN.md: is each done, where is the evidence (subagent/, the commits), what is open." },
  { name: "The owner's meaning", kind: 'topic', slots: [], brief: "# Brief\n\nThe owner's meaning: README.md." },
  { name: 'The document chain and decisions', kind: 'topic', slots: [], brief: '# Brief\n\nThe document chain and decisions: docs/PLAN.md.' },
  { name: 'The code as it stands', kind: 'topic', slots: ['territories'], brief: '# Brief\n\nThe code as it stands: src/clay.ts.' },
];

const planner = clerkPlanner({
  lanes: (round) => (round === 'First usable' ? FIRST : round === 'Deepen' ? DEEPEN : []),
  stageWork: (round, stage, task) => {
    if (round === 'First usable' && stage === 'orientation') {
      return [{ name: 'pk_write_layers', args: { entries: [{ path: 'README.md', layer: 'Readme', current: true }, { path: 'docs/PLAN.md', layer: 'Plan', current: true }, { path: 'design/DECISIONS.md', layer: 'Decision record', current: true }, { path: 'subagent', layer: 'Task contract', current: true }] } }];
    }
    // The model says which table and which column is what; the program copies it (D-e). No statusMap: "done" in a
    // plan's own column stays a written status until a lane reads the delivery.
    if (round === 'First usable' && stage === 'skeleton') {
      return [
        { name: 'pk_fill_from_table', args: { path: 'docs/PLAN.md', table: { heading: 'Work items' }, into: 'threads', columns: { title: 'Task', id: 'ID', status: 'Status' } } },
        // CJ: the decision record whole, in one call: every bold entry a Decision, named as written.
        { name: 'pk_fill_from_bold', args: { path: 'design/DECISIONS.md', category: 'Decision' } },
      ];
    }
    if (stage === 'cross-check') {
      // The plan lane's link of K-4's delivery, checked against the commit and confirmed.
      const k4 = threadOf('K-4');
      return [
        ...(k4 ? [{ name: 'pk_link_process', args: { workId: k4.id, ledgerRef: { kind: 'commit', id: K4_DELIVERY }, stepKind: 'Delivered', confirm: true } }] : []),
        { name: 'pk_write_round_doc', args: { kind: 'Adoption', title: 'What was adopted', markdown: '# Adoption\n\n- The plan lane: K-1 delivered by its commit; K-4 delivered by a commit without its number, linked and confirmed; K-2 reported done with no delivery found — left to the spot check.' } },
      ];
    }
    // The synthesis job's (D103). The first round writes the note; the deepening's is given it as a note standing from
    // an earlier round, and updates it with what the lanes found — a new version, not a second note.
    if (stage === 'synthesis' && round === 'First usable') return [{ name: 'pk_write_note', args: { mountKind: 'project', mountIds: [], title: 'Where Kiln stands', preview: 'The plan names four work items; nothing is checked yet.', ask: 'For information', currentView: 'Four work items, each as the plan writes it.', reason: 'synthesis of the round' } }];
    if (stage === 'synthesis') {
      const standing = /^- (note_[\w-]+) · “Where Kiln stands”/m.exec(task)?.[1];
      return standing ? [{ name: 'pk_write_note', args: { id: standing, preview: 'Clay mixed; the kiln firing reported done, and the plan lane looked for its delivery.', currentView: 'K-1 is delivered; K-4 is delivered by a commit without its number; K-2 says done.', reason: 'the deepening read the deliveries' } }] : [];
    }
    return [];
  },
  laneWork: (name) => {
    if (name === 'Product and modules') return [{ name: 'pk_write_reference', args: { category: 'Product', name: 'Kiln', text: 'A pottery workshop planner.', basis: 'Explicit', validity: 'Current', identity: 'Interpretation', sourceIds: [] } }];
    if (name === PLAN_LANE) {
      const k1 = threadOf('K-1');
      const k2 = candidateOf('K-2');
      const k4 = threadOf('K-4');
      return [
        { name: 'read', args: { path: 'docs/PLAN.md' } }, { name: 'read', args: { path: 'subagent/K-1-mix.md' } }, { name: 'read', args: { path: 'subagent/K-2-fire.md' } }, { name: 'read', args: { path: 'subagent/K-4-cool.md' } },
        // K-1's delivery is its commit: done, now that it has been read (the progress is the lane's to set).
        ...(k1 ? [{ name: 'pk_write_thread', args: { id: k1.id, progress: 'Done' } }] : []),
        // Each candidate one result (CD). K-4's delivery is a commit without its number: found, and linked.
        ...(k4 ? [{ name: 'pk_link_process', args: { workId: k4.id, ledgerRef: { kind: 'commit', id: K4_DELIVERY }, stepKind: 'Delivered', why: 'The commit that adds the kiln cooling (src/kiln.ts) is K-4 “Cool the kiln”, though its message carries no number.' } }] : []),
        // K-2's delivery is nowhere: where the lane looked.
        ...(k2 ? [{ name: 'pk_record_looked', args: { breakpointId: k2.id, where: ['subagent/K-2-fire.md', 'docs/PLAN.md', 'the trunk: no commit names K-2'] } }] : []),
      ];
    }
    if (name === 'The code as it stands') return [{ name: 'read', args: { path: 'src/clay.ts' } }];
    return [];
  },
  // The spot check: every candidate a lane looked for, checked and lit; everything listed as checked in full, checked;
  // then its record.
  spotCheck: (task) => {
    const block = task.slice(task.indexOf('=== Breakpoint candidates a lane looked for'), task.indexOf('=== Checked in full'));
    const ids = [...block.matchAll(/^- (bp_[0-9a-z_-]+) · /gm)].map((m) => m[1]!);
    const full = [...task.slice(task.indexOf('=== Checked in full'), task.indexOf('=== The sample')).matchAll(/^- (\w+) ([\w-]+): /gm)].map((m) => ({ collection: m[1]!, id: m[2]! }));
    return [
      ...ids.map((id) => ({ name: 'pk_confirm', args: { kind: 'breakpoint', id, confirmed: true, why: 'Read subagent/K-2-fire.md and the trunk: no commit, receipt or report delivers K-2.' } })),
      { name: 'pk_record_spot_check', args: { checked: [
        ...ids.map((id) => ({ target: { collection: 'breakpoints', id }, kind: 'breakpoint', verdict: 'Right' })),
        ...full.map((target) => ({ target, kind: target.collection === 'roundDocs' ? 'the Result’s claims' : 'note', verdict: 'Right' })),
      ] } },
    ];
  },
});

// ───────────────────────── two key doubles in front of the scripted clerk ─────────────────────────

async function keys(ids: readonly string[]) {
  const fake = await startFakeProvider(planner);
  const servers: { id: string; url: string; bodies: number; server: Server; sockets: Set<Socket> }[] = [];
  for (const id of ids) {
    const sockets = new Set<Socket>();
    const k = { id, url: '', bodies: 0, server: null as unknown as Server, sockets };
    k.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        k.bodies++;
        void fetch(`${fake.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then(async (r) => {
          res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'text/event-stream' });
          res.end(await r.text());
        }, () => res.destroy());
      });
    });
    k.server.on('connection', (s: Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise<void>((r) => k.server.listen(0, '127.0.0.1', () => r()));
    k.url = `http://127.0.0.1:${(k.server.address() as { port: number }).port}/v1`;
    servers.push(k);
  }
  return { fake, keys: servers, close() { for (const k of servers) { for (const s of k.sockets) s.destroy(); k.server.close(); } fake.close(); } };
}

async function until(check: () => boolean, ms = 180_000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('a takeover end to end on two fake keys: the table filled, slot lanes in one call, nothing lit in the first picture; then lanes by question, the plan lane’s two candidates each with a result (one linked, one looked), the coverage accounted for, the round handed over at once, the synthesis in a session of its own, and the spot check follows it and lights the looked one', { timeout: 600_000 }, async () => {
  const doubles = await keys(['zai-a', 'zai-b']);
  const app = new App(mkdtempSync(join(scratch, 'home-')));
  try {
    const project = app.addProject('Kiln', [projectDir]);
    await app.intakeProject(project.id);
    app.markTakeoverStarted(project.id, 'First picture only');   // the owner's Start (D105): adding a project starts nothing
    app.stopAll();
    await app.initKeeper();
    for (const k of doubles.keys) app.keeper.models.registerProvider(k.id, { name: k.id, baseUrl: k.url, apiKey: 'test-key', api: 'openai-completions', models: [FAKE_MODEL] });
    app.keeper.setModel({ provider: 'zai-a', id: FAKE_MODEL.id, thinking: null }, [{ provider: 'zai-b', id: FAKE_MODEL.id, thinking: null }]);
    app.keeper.setLanesPerKey(2);
    await app.keeper.providerState();
    store = app.store(project.id);
    const s = store;
    const jobsOf = (roundId: string, kind?: string) => s.jobs.filter((j) => j.step?.roundId === roundId && (!kind || j.step.kind === kind));
    const describe = (roundId: string) => jobsOf(roundId).map((j) => `${j.scope.label}=${j.status}:${j.error ?? ''}`).join('; ');
    const mainSession = (kind: string) => doubles.fake.requests.map((r) => r.messages).filter((m) => { const t = taskText(m as never); return jobOf(t).kind === 'main' && roundKindOf(t) === kind; }).at(-1)!;

    // ── the first usable picture ──
    await app.organizing.replan(project.id);
    await until(() => s.clerkRounds.find((r) => r.kind === 'First usable' && r.status !== 'Running') !== undefined, 180_000, 'the first usable round');
    const first = s.clerkRounds.find((r) => r.kind === 'First usable')!;
    assert.equal(first.status, 'Done', describe(first.id));
    // CM: the main agent starts with counts, not lists — the owner's lines as a count, the candidate generations to judge.
    const firstTask = taskText(mainSession('First usable') as never);
    assert.match(firstTask, /=== The owner's lines no position cites yet \(a count; the full list goes to the lane you give the slot reference:Owner's words\)/);
    assert.match(firstTask, /=== Candidate generations \(the program’s list/);
    assert.deepEqual(first.failures ?? [], []);
    assert.deepEqual(s.clerkRounds.get(first.id)!.stageLog!.map((e) => e.stage), ['orientation', 'skeleton', 'reconcile']);
    // D103: the main job ends at the handover; the synthesis runs after it as a job of its own, in a new session, and
    // writes the note and the round's Result. A first usable round has no spot-check.
    assert.deepEqual(jobsOf(first.id).filter((j) => j.step!.kind !== 'lane').map((j) => j.step!.kind), ['ledger', 'session-drafts', 'main', 'synthesis', 'process']);
    const main1 = jobsOf(first.id, 'main')[0]!;
    const synth1 = jobsOf(first.id, 'synthesis')[0]!;
    const handover1 = s.roundDocs.get(s.clerkRounds.get(first.id)!.handover!.docId)!;
    assert.deepEqual([handover1.kind, handover1.jobId], ['Handover', main1.id]);
    assert.match(String(JSON.parse(callResults(mainSession('First usable') as never, 'pk_stage').at(-1)!.result).note), /Your work in this round is done and your session writes nothing more/);
    assert.equal(callResults(mainSession('First usable') as never, 'pk_write_round_doc').filter((c) => (c.args as { kind?: string }).kind === 'Result').length, 0, 'the main agent wrote no Result');
    assert.deepEqual([main1.status, synth1.status], ['Done', 'Done']);
    assert.ok(synth1.sessionFile && synth1.sessionFile !== main1.sessionFile, 'a new session');
    assert.ok(main1.endedAt! <= synth1.startedAt!, 'after the main agent\'s session ended');
    const note1 = s.notes.find((n) => n.versions[0]!.title === 'Where Kiln stands')!;
    assert.ok(s.traceByJob(synth1.id, 1000).some((e) => e.collection === 'notes' && e.id === note1.id), 'the note is the synthesis job\'s');
    assert.equal(s.roundDocs.find((d) => d.roundId === first.id && d.kind === 'Result')!.jobId, synth1.id);
    // The table, copied: the work items it names, by the project's ids, each Planned, the written status kept (AC-21).
    const filled = callResults(mainSession('First usable') as never, 'pk_fill_from_table');
    assert.equal(filled.length, 1);
    assert.equal((JSON.parse(filled[0]!.result) as { written: number }).written, 4, filled[0]!.result);
    // CJ: the decision record filled whole, each entry named by its number and title as written, D3's supplement folded
    // into D3; and the round left reconcile at once, every counted entry being on the workbench.
    const decisions = ['D1', 'D2', 'D3'].map((n) => s.reference.find((r) => r.category === 'Decision' && r.ids.includes(n))!);
    assert.deepEqual(decisions.map((d) => d?.name), ['D1 · Mix before firing.', 'D2 · One kiln at a time.', 'D3 · Glaze last.']);
    assert.match(decisions[2]!.text, /tap test/, 'the supplement folded into D3');
    const intoSynthesis1 = callResults(mainSession('First usable') as never, 'pk_stage').filter((c) => (c.args as { to?: string }).to === 'synthesis');
    assert.deepEqual(intoSynthesis1.map((c) => /neither/.test(c.result)), [false], 'the entry gate let reconcile go at once');
    const items = ['K-1', 'K-2', 'K-3', 'K-4'].map((n) => threadOf(n)!);
    assert.deepEqual(items.map((t) => [t.title, t.progress, t.writtenStatus?.text]), [['Mix the clay', 'Planned', 'done'], ['Fire the kiln', 'Planned', 'done'], ['Glaze the pots', 'Planned', 'ready'], ['Cool the kiln', 'Planned', 'done']]);
    // The skeleton's slot lanes, sent in one call, each in its own session.
    const lanes1 = jobsOf(first.id, 'lane');
    assert.deepEqual(lanes1.map((j) => j.step!.path).sort(), ['Code territories', 'Product and modules']);
    assert.equal(callResults(mainSession('First usable') as never, 'pk_send_lanes').length, 1, 'all in one call');
    assert.equal(new Set(lanes1.map((j) => j.sessionFile)).size, 2);
    // Nothing lit: the first picture draws no "missing" conclusion; what the program found is a candidate for later.
    assert.equal(s.breakpoints.filter((b) => b.lit).length, 0, 'no breakpoint lit after the first usable round');
    assert.ok(candidateOf('K-2'), `K-2, reported done with nothing delivering it, is a candidate: ${JSON.stringify(s.breakpoints.all().map((b) => [b.kind, b.targetId, b.lit]))}`);
    assert.ok(!candidateOf('K-1'), 'K-1 has its commit');
    assert.ok(candidateOf('K-4'), 'K-4, delivered by a commit without its number, is a candidate by numbers');
    const k4Candidate = candidateOf('K-4')!.id;

    // ── the Full deepening ──
    await until(() => s.coverage.takeover?.stage === 'Daily', 30_000, 'the takeover done at First picture only');
    app.startTakeover(project.id, 'Full');
    await app.organizing.replan(project.id);
    await until(() => s.clerkRounds.find((r) => r.kind === 'Deepen' && r.status !== 'Running') !== undefined, 300_000, 'the deepening');
    const deepen = s.clerkRounds.find((r) => r.kind === 'Deepen')!;
    assert.equal(deepen.status, 'Done', describe(deepen.id));
    assert.deepEqual(deepen.failures ?? [], []);
    assert.deepEqual(jobsOf(deepen.id).filter((j) => j.step!.kind !== 'lane').map((j) => j.step!.kind), ['ledger', 'session-drafts', 'main', 'synthesis', 'spot-check', 'process']);
    assert.deepEqual(s.clerkRounds.get(deepen.id)!.stageLog!.map((e) => e.stage), ['orientation', 'dig', 'coverage', 'cross-check']);
    const lanes2 = jobsOf(deepen.id, 'lane');
    assert.deepEqual(lanes2.map((j) => j.step!.path).sort(), DEEPEN.map((l) => l.name).sort(), 'a lane per kind of question, the plan’s among them');
    assert.ok(lanes2.every((j) => j.status === 'Done'));
    // The plan lane read K-1's delivery and set its progress; the written status stays as the plan wrote it.
    assert.deepEqual([threadOf('K-1')!.progress, threadOf('K-1')!.writtenStatus?.text], ['Done', 'done']);
    assert.equal(threadOf('K-3')!.progress, 'Planned', '“ready” never became progress');
    // It looked for K-2's delivery and did not find it.
    const bp = s.breakpoints.find((b) => b.targetId === threadOf('K-2')!.id && b.kind === 'No trace of done')!;
    const planLane = lanes2.find((j) => j.step!.path === PLAN_LANE)!;
    assert.equal(bp.looked?.jobId, planLane.id);
    assert.deepEqual(bp.looked?.where, ['subagent/K-2-fire.md', 'docs/PLAN.md', 'the trunk: no commit names K-2']);
    // It found K-4's delivery and linked it: the other result (CD), confirmed in the cross-check.
    const k4Link = s.links.find((l) => l.workId === threadOf('K-4')!.id && l.stepKind === 'Delivered');
    assert.ok(k4Link, 'K-4 linked to its delivery');
    assert.deepEqual([k4Link.jobId !== null, k4Link.roundId, k4Link.confirmed, k4Link.ledgerRef.includes(K4_DELIVERY.slice(0, 7))], [true, deepen.id, true, true], JSON.stringify(k4Link));
    assert.equal(s.breakpoints.get(k4Candidate)?.looked ?? null, null, 'found, so not recorded as looked');
    // CM: the program checked the link's evidence as the lane wrote it — the commit is in the ledger and changed the file
    // the link names — so it was lane-checked before the cross-check ever looked at it.
    const linked = callResults(doubles.fake.requests.map((r) => r.messages).filter((m) => taskText(m as never).includes(PLAN_LANE) && jobOf(taskText(m as never)).kind === 'lane').at(-1) as never, 'pk_link_process');
    assert.match(String((JSON.parse(linked[0]!.result) as { check: string }).check), /^lane-checked: the commit changed src\/kiln\.ts, which the link's why names/);
    assert.equal(k4Link.check?.passed, true);
    // Both candidates had a result, so the round was handed over at once: no refusal, and no why.
    const intoSynthesis = callResults(mainSession('Deepen') as never, 'pk_stage').filter((c) => (c.args as { to?: string }).to === 'synthesis');
    assert.deepEqual(intoSynthesis.map((c) => [(c.args as { why?: string }).why ?? null, /no result yet/.test(c.result)]), [[null, false]], 'handed over to the synthesis at once');
    assert.equal(s.clerkRounds.get(deepen.id)!.handover!.why, undefined);
    // D103: the main job ends at the handover, a synthesis job runs in a new session, and the spot-check follows.
    const main2 = jobsOf(deepen.id, 'main')[0]!;
    const synth2 = jobsOf(deepen.id, 'synthesis')[0]!;
    const spot2 = jobsOf(deepen.id, 'spot-check')[0]!;
    assert.deepEqual([main2.status, synth2.status, spot2.status], ['Done', 'Done', 'Done']);
    assert.equal(new Set([main2.sessionFile, synth2.sessionFile, spot2.sessionFile, synth1.sessionFile]).size, 4, 'each in a session of its own');
    assert.ok(main2.endedAt! <= synth2.startedAt! && synth2.endedAt! <= spot2.startedAt!, 'main → synthesis → spot-check');
    const handover2 = s.roundDocs.get(s.clerkRounds.get(deepen.id)!.handover!.docId)!;
    const synthTask = doubles.fake.requests.map((r) => taskText(r.messages as never)).filter((t) => jobOf(t).kind === 'synthesis' && roundKindOf(t) === 'Deepen').at(-1)!;
    assert.ok(synthTask.includes(`=== The main agent's handover (${handover2.id}; written as it left the cross-check stage)`), 'the synthesis is given the handover');
    const planReport = s.roundDocs.find((d) => d.roundId === deepen.id && d.kind === 'Report' && d.path === PLAN_LANE)!;
    assert.ok(synthTask.includes(`report ${planReport.id} (${planReport.markdown.length} characters)`) && !synthTask.includes(planReport.markdown), 'and the lane reports by id, not pasted');
    assert.match(synthTask, /Adoption record \(what the cross-check adopted, what not, and why\): rdoc_/);
    // The note the first round left stands, is given to this synthesis, and gets its result: updated (a new version).
    assert.ok(synthTask.includes(`- ${note1.id} · “Where Kiln stands” · For information`), 'the standing note is among the synthesis\' inputs');
    assert.deepEqual([s.notes.get(note1.id)!.versions.length, s.notes.filter((n) => n.versions[0]!.title === 'Where Kiln stands').length], [2, 1], 'updated in place, not written again');
    assert.deepEqual(s.clerkRounds.get(deepen.id)!.standingNotes, { standing: 1, confirmed: 0, updated: 1, withdrawn: 0, open: 0 });
    // The coverage check listed what no lane read, and the main agent accounted for it.
    const coverage = s.clerkRounds.get(deepen.id)!.coverage!;
    assert.equal(coverage.settled, true);
    assert.ok(coverage.accounted.some((a) => a.by === 'main') && coverage.accounted.every((a) => a.why), JSON.stringify(coverage.accounted));
    // CM: the prompts a work item already cites (its own dispatch prompt) are the program's to account for; the main agent
    // accounts only for what is listed.
    const byProgram = coverage.accounted.filter((a) => a.by === 'program');
    assert.ok(byProgram.length === 1 && /^Cited already: /.test(byProgram[0]!.why) && byProgram[0]!.keys!.every((k) => /^doc:subagent\/K-\d-/.test(k)), JSON.stringify(byProgram));
    assert.ok(coverage.accounted.filter((a) => a.by === 'main').every((a) => !(a.keys ?? []).some((k) => /^doc:subagent\/K-/.test(k))), 'the main agent was not asked about them');
    assert.ok((coverage.untouched ?? []).length >= 1, 'what no lane read is kept for the view');
    assert.ok(s.roundDocs.find((d) => d.roundId === deepen.id && d.kind === 'Adoption') && s.roundDocs.find((d) => d.roundId === deepen.id && d.kind === 'Result'));
    // The spot check was given the looked candidate, checked it, and lit it — the only way one lights.
    const spot = jobsOf(deepen.id, 'spot-check')[0]!;
    const spotTask = doubles.fake.requests.map((r) => taskText(r.messages as never)).find((t) => jobOf(t).kind === 'spot-check')!;
    assert.ok(spotTask.includes(`- ${bp.id} · No trace of done on K-2 Fire the kiln`), 'the candidate, with where the lane looked, is in the spot check’s block');
    assert.deepEqual([bp.lit, bp.checked?.jobId, bp.confirmedInRoundId], [true, spot.id, deepen.id]);
    assert.equal(s.breakpoints.filter((b) => b.lit).length, 1, 'one breakpoint lit, the one checked');
    // The linked one is out once the program recomputes on the confirmed link, and was never lit.
    await until(() => s.breakpoints.get(k4Candidate)?.out !== null, 30_000, 'K-4’s candidate out on its confirmed link');
    assert.equal(s.breakpoints.get(k4Candidate)!.lit, false);
    // The spot-check follows the synthesis and checks in full what it wrote — the note, the round's Result — apart from the sample.
    const result2 = s.roundDocs.find((d) => d.roundId === deepen.id && d.kind === 'Result')!;
    assert.ok(spotTask.includes(`- notes ${note1.id}: note “Where Kiln stands” (For information) — standing from an earlier round, updated this round`), 'the note, standing and updated, is a target');
    assert.ok(spotTask.includes(`- roundDocs ${result2.id}: the round's Result`), 'and so are the claims of the Result');
    assert.deepEqual(s.clerkRounds.get(deepen.id)!.spotCheck?.synthesis, { outputs: 2, checked: 2, wrong: 0 }, 'counted apart from the sample');
    assert.equal(s.clerkRounds.get(deepen.id)!.spotCheck?.sampled, 3, 'the looked candidate and the two checked in full');
    // Both keys carried the work.
    assert.ok(doubles.keys.every((k) => k.bodies > 0), `each key answered: ${doubles.keys.map((k) => `${k.id}=${k.bodies}`).join(', ')}`);
    await until(() => s.coverage.state === 'Takeover complete', 30_000, 'the takeover complete');
  } finally {
    doubles.close();
    app.stopAll();
    await new Promise((r) => setTimeout(r, 400));
    await app.flushAll();
  }
});
