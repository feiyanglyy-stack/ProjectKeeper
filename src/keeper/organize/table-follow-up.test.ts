/**
 * The table follow-up (D106, D107): daily upkeep of a project taken over by the ProjectKeeper table is one pi session that
 * carries the same table on. A small invented project ("Tiny", a read-later list) has a git history and a Claude Code
 * session planted under a scratch user home. Its table lives in ProjectKeeper's own folder, as a public project's does,
 * and is taken in with `importTable`. Then the project moves on: a commit, and a new owner message. The tests check:
 * - the brief lists the commit, the document's diff and the new message with the answer it replies to;
 * - the write refuses a table with problems, listing them, and takes a good one in: the store, the asOf, the table's
 *   own git history and the last Follow up all move;
 * - the owner's Follow up starts no clerk round. It queues the table follow-up, whose session is given the brief, the
 *   skill and pk_write_table, and nothing else that writes. What it hands in is taken in. With nothing new since, the
 *   program records that and runs no session.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-table-fu-'));
process.env.USERPROFILE = scratch;
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(scratch, 'pi-'));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const { git } = await import('../../util/git.ts');
const { canonicalPath, claudeProjectDirName } = await import('../../util/paths.ts');
const { importTable, storeIdsOf } = await import('../../table/import.ts');
const { briefText, readTable, sessionMaterial, tableChanges, tablePlace, followUpPrompt } = await import('../../table/follow-up.ts');
const { TableFollowUp, isTableJob } = await import('./table-follow-up.ts');
const { App } = await import('../../server/app.ts');
const { keeperPageView } = await import('../../server/keeper-page.ts');
const { startFakeProvider, FAKE_MODEL } = await import('../fake-provider.ts');
type Table = import('../../table/import.ts').Table;
type KeeperJob = import('../../model/types.ts').KeeperJob;

const SESSION = '55555555-5555-4555-8555-555555555555';
const session = `claude:${SESSION}`;
const sh = (dir: string, args: string[]) => { const r = git(dir, args); assert.ok(r.ok, r.err); return r.out.trim(); };
const commitAll = (dir: string, message: string) => { sh(dir, ['add', '-A']); sh(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '-m', message]); return sh(dir, ['rev-parse', 'HEAD']); };

const dir = canonicalPath(mkdtempSync(join(scratch, 'tiny-')));
mkdirSync(join(dir, 'docs'));
writeFileSync(join(dir, 'docs', 'PLAN.md'), '# Plan\n\n## PLAN-1 · First cut\n\n- T-1 Capture: in progress.\n- T-2 Search: planned.\n');
writeFileSync(join(dir, 'README.md'), '# Tiny\n\nA read-later list for one person.\n');
sh(dir, ['init', '-q']);
const first = commitAll(dir, 'first');

/** The project's Claude Code session, where Claude Code keeps it under the scratch home. */
const sessionFile = join(scratch, '.claude', 'projects', claudeProjectDirName(dir), `${SESSION}.jsonl`);
mkdirSync(join(sessionFile, '..'), { recursive: true });
const user = (at: string, content: string) => JSON.stringify({ sessionId: SESSION, cwd: dir, type: 'user', timestamp: at, origin: { kind: 'human' }, message: { role: 'user', content } });
const agent = (at: string, text: string) => JSON.stringify({ sessionId: SESSION, cwd: dir, type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text }] } });
writeFileSync(sessionFile, [
  user('2026-09-20T01:00:00.000Z', 'I want a read-later list that saves in one keystroke.'),
  agent('2026-09-20T01:01:00.000Z', 'Shall I build capture first?'),
  user('2026-09-20T01:02:00.000Z', 'Yes, capture first.'),
].join('\n') + '\n');

const home = join(scratch, 'home');
/** The public-project case (D107 addendum three): the table kept in ProjectKeeper's own folder. */
const tableFile = join(home, 'tables', 'tiny', 'project.json');

function table(commit: string): Table {
  const plan = { file: 'docs/PLAN.md', lines: '3' };
  return {
    format: 'projectkeeper.table/1',
    project: { name: 'Tiny', asOf: { date: '2026-10-01', repos: [{ path: '.', commit }] }, filledBy: { agent: 'outside agent', at: '2026-10-01T00:00:00Z' } },
    ownerWants: [{ id: 'W1', want: 'Capture comes first.', kind: 'Product', status: 'Current', said: [{ session, message: 2, quote: 'Yes, capture first.' }] }],
    product: { id: 'Tiny', name: 'Tiny', summary: 'A read-later list.', forWhom: 'One person.', sources: [{ file: 'README.md', lines: '3' }] },
    goals: [],
    areas: [{ id: 'A1', name: 'Capture', summary: 'Saving a page.', status: 'Current', sources: [{ file: 'docs/PLAN.md', lines: '5' }] }],
    requirements: [], designs: [], decisions: [],
    plans: [{ id: 'PLAN-1', name: 'First cut', summary: 'Capture, then search.', status: 'Current', sources: [plan] }],
    work: [
      { id: 'T-1', name: 'Capture', summary: 'One keystroke saves.', plan: 'PLAN-1', area: 'A1', status: 'Current', progress: 'In progress', sources: [{ file: 'docs/PLAN.md', lines: '5' }] },
      { id: 'T-2', name: 'Search', summary: 'Find a saved page.', plan: 'PLAN-1', area: 'A1', status: 'Current', progress: 'Planned', sources: [{ file: 'docs/PLAN.md', lines: '6' }] },
    ],
    code: [], notes: [],
  } as unknown as Table;
}

mkdirSync(join(tableFile, '..'), { recursive: true });
writeFileSync(tableFile, JSON.stringify(table(first), null, 2));
const imported = await importTable({ tableFile, projectDir: dir, home, sessions: [{ session, message: 2, text: 'Yes, capture first.' }] });
assert.deepEqual(imported.problems, []);
const projectId = imported.projectId!;

// The project moves on after the table was filled in: T-1 is done, and the owner accepts it in the session.
writeFileSync(join(dir, 'docs', 'PLAN.md'), '# Plan\n\n## PLAN-1 · First cut\n\n- T-1 Capture: done.\n- T-2 Search: planned.\n');
const second = commitAll(dir, 'T-1: capture is done');
appendFileSync(sessionFile, [
  agent('2026-10-05T09:00:00.000Z', 'T-1 is done: one keystroke saves the page. Shall I start T-2?'),
  user('2026-10-05T09:01:00.000Z', 'Accepted. Start search.'),
].join('\n') + '\n');

test('the brief: the commits since the asOf, the documents they changed, the owner’s new messages with the answers before them', () => {
  const app = new App(home, { organizing: false });
  try {
    app.ledger.rebuildNow(app.project(projectId));
    const place = tablePlace(app.project(projectId), app.home)!;
    assert.deepEqual([place.tableFile, place.projectDir, place.inHome], [canonicalPath(tableFile), dir, true]);
    const t = readTable(place.tableFile);
    const changes = tableChanges(t, place.projectDir, app.ledger.ledger(projectId));
    assert.equal(changes.nothing, false);
    const repo = changes.repos[0]!;
    assert.deepEqual([repo.from, repo.to, repo.commits.map((c) => [c.hash, c.subject, c.files])], [first, second, [[second, 'T-1: capture is done', ['docs/PLAN.md']]]]);
    assert.deepEqual(repo.docs.map((d) => [d.path, d.status]), [['docs/PLAN.md', 'M']]);
    assert.match(repo.docs[0]!.diff, /-- T-1 Capture: in progress\.\n\+- T-1 Capture: done\./);
    // Only the messages since the table was filled in, numbered as the ledger numbers them.
    assert.deepEqual(changes.owner.map((m) => [m.session, m.message, m.text, m.answers?.message, m.answers?.text]), [
      [session, 4, 'Accepted. Start search.', 3, 'T-1 is done: one keystroke saves the page. Shall I start T-2?'],
    ]);
    assert.deepEqual(changes.asOf.repos, [{ path: '.', commit: second }]);
    const brief = briefText(t, place, '/drafts/x.json', changes);
    for (const s of ['T-1: capture is done', '+- T-1 Capture: done.', `{ "session": "${session}", "message": 4 }`, 'It answers message 3', 'Accepted. Start search.', '/drafts/x.json', second]) assert.ok(brief.includes(s), `the brief says ${s}`);
    // The skill heads the prompt and the table's guide closes it.
    const prompt = followUpPrompt(brief);
    assert.match(prompt, /^# Table follow-up/);
    assert.match(prompt, /=== The table’s guide \(template\/FILLING-IN\.md\)\n# Filling in the ProjectKeeper table/);
    // The session material: the ledger's owner messages and answers, and what the table already cites.
    const material = sessionMaterial(app.ledger.ledger(projectId), app.store(projectId), t);
    assert.deepEqual(material.filter((m) => m.session === session).map((m) => m.message).sort(), [0, 1, 2, 3, 4]);
  } finally { app.stopAll(); }
});

/** A table follow-up's job as the planner queues it, written straight into the store: no model runs it here. */
function plantJob(app: InstanceType<typeof App>, draftFile: string): KeeperJob {
  const store = app.store(projectId);
  const job = {
    id: `job_test_${Math.random().toString(36).slice(2)}`, projectId, kind: 'Organizing', initiator: 'auto', scope: { kind: 'table-follow-up', ids: [], label: 'Table follow-up (test)' },
    status: 'Running', queuedAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null, savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null },
    agent: 'pi', model: { provider: 'fake', id: 'fake-1', thinking: null }, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: null, resultText: null, step: null, priority: 1,
    task: { prompt: '', stream: false, timeoutMs: null, extra: { kind: 'table-follow-up', tableFile: canonicalPath(tableFile), projectDir: dir, inHome: true, draftFile, asOf: { date: '2026-10-06', repos: [{ path: '.', commit: git(dir, ['rev-parse', 'HEAD']).out.trim() }] }, briefAt: new Date().toISOString(), startedBy: 'owner' } },
  } as unknown as KeeperJob;
  store.jobs.put(job);
  return job;
}

test('the write refuses a table with problems, listing them, and takes a good one in: store, asOf and the table’s history move', async () => {
  const app = new App(home, { organizing: false });
  try {
    app.ledger.rebuildNow(app.project(projectId));
    const writer = new TableFollowUp(app);
    const draftFile = join(app.store(projectId).dir, 'table-follow-up', 'test.json');
    mkdirSync(join(draftFile, '..'), { recursive: true });
    const job = plantJob(app, draftFile);
    const t = readTable(canonicalPath(tableFile));

    // A reference to an id the table does not have, and a quote not in the message it cites: refused, each problem named.
    const bad = structuredClone(t) as unknown as { work: { area: string }[]; ownerWants: { said: { quote: string }[] }[] };
    bad.work[0]!.area = 'A9';
    bad.ownerWants[0]!.said[0]!.quote = 'Words the owner never said.';
    const refused = await writer.write(projectId, job.id, bad);
    assert.equal(refused.ok, false);
    assert.match(refused.text, /2 problems\. Nothing changed/);
    assert.match(refused.text, /\/work\/0\/area {2}"A9" is not an id in this table/);
    assert.match(refused.text, /\/ownerWants\/0\/said\/0\/quote {2}the quote does not stand word for word/);
    assert.equal(app.store(projectId).threads.get(storeIdsOf(t, projectId).get('T-1')!)!.progress, 'In progress', 'nothing changed');
    // A working copy that is not JSON is refused with why.
    writeFileSync(draftFile, '{ not json');
    assert.match((await writer.write(projectId, job.id, undefined)).text, /is not readable as JSON/);

    // The good one, handed in as the working copy: T-1 done by the new line and the owner's acceptance; a new want.
    const good = structuredClone(t) as unknown as Table & { work: Record<string, unknown>[]; ownerWants: Record<string, unknown>[] };
    good.work[0] = { ...good.work[0]!, progress: 'Done', accepted: { session, message: 4, quote: 'Accepted.' } };
    good.ownerWants.push({ id: 'W2', want: 'Search comes next.', kind: 'Product', status: 'Current', said: [{ session, message: 4, quote: 'Start search.' }], approvedProposal: { part: 'start T-2', source: { session, message: 3 } } });
    (good.project as { filledBy: Record<string, unknown> }).filledBy = { agent: 'whoever', at: '1999-01-01', read: 'The commit since the asOf and the owner’s new message.' };
    writeFileSync(draftFile, JSON.stringify(good, null, 2));
    const taken = await writer.write(projectId, job.id, undefined);
    assert.equal(taken.ok, true, taken.text);
    assert.match(taken.text, /Taken in: ownerWants W2 new · work T-1 changed\./);

    const store = app.store(projectId);
    const ids = storeIdsOf(good, projectId);
    assert.equal(store.threads.get(ids.get('T-1')!)!.progress, 'Done');
    assert.equal(store.threads.get(ids.get('T-1')!)!.acceptance, 'Accepted');
    assert.equal(store.reference.get(ids.get('W2')!)!.category, "Owner's words");
    // The program set asOf and filledBy; the file and the project's record say so.
    const saved = readTable(canonicalPath(tableFile));
    assert.deepEqual(saved.project.asOf.repos, [{ path: '.', commit: second }]);
    assert.match(saved.project.filledBy.agent, /^ProjectKeeper Keeper \(pi, fake\/fake-1\)$/);
    assert.notEqual(saved.project.filledBy.at, '1999-01-01');
    assert.equal(saved.project.filledBy.read, 'The commit since the asOf and the owner’s new message.');
    const record = app.project(projectId).takenOverByTable!;
    assert.deepEqual([record.at, record.by], [saved.project.filledBy.at, saved.project.filledBy.agent]);
    // The table's own history, in its folder in ProjectKeeper's home (never in the project).
    const log = sh(join(canonicalPath(tableFile), '..'), ['log', '--format=%an|%s']);
    assert.match(log, new RegExp(`^ProjectKeeper\\|Table follow-up ${job.id} \\(you pressed Follow up\\): ownerWants W2 new · work T-1 changed$`));
    assert.equal(git(dir, ['status', '--porcelain']).out.trim(), '', 'nothing was written into the project');
    // The run is recorded as a Follow up round: the top bar's last Follow up says what it changed.
    const round = store.rounds.find((r) => r.mainJobId === job.id)!;
    assert.equal(round.result?.news?.nothingNew, false);
    assert.equal(store.coverage.lastFollowUp?.statement, 'The last Follow up round: the table follow-up changed ownerWants W2 new · work T-1 changed');
    assert.equal(store.coverage.state, 'Takeover complete');
    // Up to date now: nothing waits.
    assert.deepEqual(store.coverage.scopes.find((s) => s.id === 'project')!.pending, []);
    // The session ends.
    store.jobs.put({ ...store.jobs.get(job.id)!, status: 'Done', endedAt: new Date().toISOString() });
    await store.flush();
    // The Daily page's last round is this follow-up, not "No round has finished yet" (D107).
    const daily = (await keeperPageView(app, projectId)).daily;
    assert.deepEqual([daily.lastRound?.kind, daily.lastRound?.startedBy, daily.lastRound?.nothingNew, daily.lastRound?.resultId], ['Follow up', 'owner', false, round.id]);
    assert.match(daily.lastRound!.statement!, /ownerWants W2 new/);
    assert.equal(daily.running, null);
  } finally { app.stopAll(); await app.flushAll(); }
});

test('Follow up on a table project queues the table follow-up, never a clerk round; its session hands the table in', { timeout: 180_000 }, async () => {
  // The project moves on again: T-2 starts.
  writeFileSync(join(dir, 'docs', 'PLAN.md'), '# Plan\n\n## PLAN-1 · First cut\n\n- T-1 Capture: done.\n- T-2 Search: in progress.\n');
  const third = commitAll(dir, 'T-2: search started');
  const handed = structuredClone(readTable(canonicalPath(tableFile))) as unknown as Table & { work: Record<string, unknown>[] };
  handed.work[1] = { ...handed.work[1]!, progress: 'In progress', sources: [{ file: 'docs/PLAN.md', lines: '6', quote: 'T-2 Search: in progress.' }] };
  // The double plays the session: it hands the table in once, then ends.
  const fake = await startFakeProvider((prompt, _messages, afterTool) => {
    if (afterTool) return 'T-2 is in progress by the plan; I changed its progress.';
    return /# Table follow-up/.test(prompt) ? [{ name: 'pk_write_table', args: { table: handed } }] : 'Nothing to do.';
  });
  const app = new App(home);
  try {
    await app.initKeeper();
    app.keeper.models.registerProvider('fake', { name: 'Fake', baseUrl: fake.url, apiKey: 'k', api: 'openai-completions', models: [FAKE_MODEL] });
    app.keeper.setModel({ provider: 'fake', id: FAKE_MODEL.id, thinking: null });
    const store = app.store(projectId);
    const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 900 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); assert.ok(ok(), what); };
    const ended = (j: KeeperJob) => j.status === 'Done' || j.status === 'Failed';
    const before = store.jobs.filter(isTableJob).length;
    app.followUp(projectId);
    await until(() => store.jobs.filter((j) => isTableJob(j) && ended(j)).length > before, `the table follow-up ended: ${JSON.stringify(store.jobs.all().map((j) => [j.scope.label, j.status, j.error]))} ${JSON.stringify(app.project(projectId).followUpAt)}`);
    const job = store.jobs.filter(isTableJob).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)).pop()!;
    assert.equal(job.status, 'Done', job.error ?? '');
    assert.equal(job.scope.kind, 'table-follow-up');
    assert.equal(store.clerkRounds.size, 0, 'no clerk round was started');
    // What the session was given: the skill and the brief, pi's tools and the ledger's reads, and one writer.
    const tools = fake.requests[0]!.tools;
    for (const t of ['pk_write_table', 'pk_ledger_commits', 'read', 'edit']) assert.ok(tools.includes(t), `offered ${t}`);
    for (const t of ['pk_write_reference', 'pk_write_thread', 'pk_stage', 'pk_write_note']) assert.ok(!tools.includes(t), `not offered ${t}`);
    const prompt = fake.requests[0]!.messages.filter((m) => m.role === 'user').map((m) => String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    assert.match(prompt, /a table follow-up/);
    assert.match(prompt, /# Table follow-up/);
    assert.match(prompt, /T-2: search started/);
    // What it handed in was taken in.
    const ids = storeIdsOf(handed, projectId);
    await until(() => store.threads.get(ids.get('T-2')!)?.progress === 'In progress', 'T-2 in progress in the store');
    assert.deepEqual(readTable(canonicalPath(tableFile)).project.asOf.repos, [{ path: '.', commit: third }]);
    assert.equal(job.savedResults[0]?.collection, 'table');

    // Pressed again with nothing new: the program records that, and no session runs.
    const requests = fake.requests.length;
    await new Promise((r) => setTimeout(r, 20));
    app.followUp(projectId);
    await until(() => store.jobs.filter((j) => isTableJob(j) && j.agent === 'program').length === 1, 'the program recorded the follow-up');
    const nothing = store.jobs.find((j) => isTableJob(j) && j.agent === 'program')!;
    assert.match(nothing.resultText ?? '', /^Nothing changed since the table's asOf/);
    await until(() => store.coverage.lastFollowUp?.nothingNew === true, 'the top bar says the last Follow up found nothing new');
    assert.equal(fake.requests.length, requests, 'no model was asked');
    assert.equal(store.clerkRounds.size, 0);
  } finally { fake.close(); app.stopAll(); await app.flushAll(); }
});
