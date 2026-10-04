/**
 * What an untouched group holds (DA; E156, the flash run: 637 materials in 17 groups written off in 80 seconds, a side
 * decision log and 35 reports unread). For each group the coverage check lists, the program counts what its materials
 * hold that nothing on the workbench carries — stated verdict lines no work item links, numbers no item carries, the
 * owner's lines not looked at yet — and a group that holds any of it is not accounted for as a group: a lane reads it, or
 * each holding material is accounted for by its key with its own reason. A group id is matched exactly. A project with
 * no reports, no decision log and no sessions holds nothing, and nothing is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Nothing here may look at the real home: the ledger reads sessions from a home of our own.
const fakeHome = mkdtempSync(join(tmpdir(), 'pk-holds-home-'));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
const { rebuildLedgerInPlace, ledgerPath } = await import('../../ledger/rebuild.ts');
const { Ledger } = await import('../../ledger/index.ts');
const { ProjectStore } = await import('../../store/project-store.ts');
const { coverageTools, coverageOf, coverageGroups, materialHolds, groupHoldsOf } = await import('./coverage-tools.ts');
type Project = import('../../model/types.ts').Project;
type KeeperJob = import('../../model/types.ts').KeeperJob;
type Source = import('../../model/types.ts').Source;
type ReferenceItem = import('../../model/types.ts').ReferenceItem;
type ClerkRound = import('../../model/k-types.ts').ClerkRound;
type RoundLane = import('../../model/k-types.ts').RoundLane;
type SessionDraft = import('../../model/k-types.ts').SessionDraft;
type ProcessLink = import('../../model/k-types.ts').ProcessLink;
type ToolContext = import('../tools.ts').ToolContext;
type CoverageItem = import('./coverage-tools.ts').CoverageItem;
type StepRead = NonNullable<KeeperJob['steps'][number]['reads']>[number];

const ENV = { GIT_AUTHOR_NAME: 'Mill Dev', GIT_AUTHOR_EMAIL: 'dev@mill.invalid', GIT_COMMITTER_NAME: 'Mill Dev', GIT_COMMITTER_EMAIL: 'dev@mill.invalid' };
const AT = '2026-09-05T10:00:00.000Z';
const home = join(fakeHome, '.projectkeeper');
const OWNER_LINE = '每一卷布出厂前都要过秤，不过秤的不许发货';

/** A project in a repository of its own, its ledger and store, a round in its coverage stage, and the tools as its main agent. */
function build(id: string, files: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), `pk-holds-${id}-`));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: '2026-09-01T10:00:00+00:00', GIT_COMMITTER_DATE: '2026-09-01T10:00:00+00:00' }, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']);
  for (const [rel, text] of Object.entries(files)) { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), text); }
  git(['add', '-A']); git(['commit', '-q', '-m', 'Start']);
  const P = {
    id, name: id, locations: [repo], language: 'en', organizingPaused: false, createdAt: '2026-09-01T00:00:00Z', lastOpenedAt: null, lastScopedAt: null,
    scopeQuestions: [], keeperFiles: [], roles: [], takeoverDepth: 'Full',
    scope: [{ id: 'si', path: repo, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' }],
  } as unknown as Project;
  rebuildLedgerInPlace(ledgerPath(P.id, home), P, {});
  const L = Ledger.openPath(ledgerPath(P.id, home))!;
  const store = ProjectStore.open(P.id, home);
  const abs = (rel: string) => join(repo, ...rel.split('/'));
  const job = (jobId: string, kind: 'main' | 'lane', path: string | null, reads: StepRead[][], parentJobId: string | null = null): KeeperJob => ({
    id: jobId, projectId: P.id, kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['crd_deep'], label: path ?? 'Main' }, status: 'Done', queuedAt: AT, startedAt: AT, endedAt: AT,
    savedResults: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, agent: 'pi', model: null, sessionFile: null, sessionId: null,
    steps: reads.map((r) => ({ at: AT, tool: 'read', target: '', summary: '', isError: false, reads: r })), error: null, requestBasis: null, parentJobId, resultText: null, priority: 1, task: null,
    step: { roundId: 'crd_deep', kind, path },
  } as unknown as KeeperJob);
  const lane = (name: string, kind: RoundLane['kind'], briefDocId: string, jobId: string): RoundLane => ({ name, kind, briefDocId, slots: [], jobId, stage: 'dig', sentAt: AT, reportDocId: null });
  const brief = (docId: string, name: string, markdown: string) => store.roundDocs.put({ id: docId, projectId: P.id, roundId: 'crd_deep', jobId: 'job_main', kind: 'Brief', path: name, title: `Brief: ${name}`, markdown, at: AT });
  const round: ClerkRound = {
    id: 'crd_deep', projectId: P.id, kind: 'Deepen', number: 2, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root', questionsDocId: null, paths: [], outputs: [], groundwork: [],
    unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT, stage: 'coverage', stageLog: [], lanes: [], coverage: null,
  };
  const main: ToolContext = { store, project: P, jobId: 'job_main', jobKind: 'Organizing', model: null, step: { roundId: 'crd_deep', kind: 'main', path: null } };
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = coverageTools(main).find((t) => t.name === name)!;
    const result = await (tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)('call', args);
    const text = result.content.map((x) => x.text).join('\n');
    return { text, error: result.isError === true, json: result.isError ? null : JSON.parse(text) };
  };
  return { repo, P, L, store, abs, job, lane, brief, round, call, now: () => store.clerkRounds.get('crd_deep')! };
}

// ───────────────────────── a mill: a plan, a side log, reports nobody named a ticket for, notes that quote the owner ─────────────────────────

const mill = build('mill', {
  'README.md': '# Mill\n\nWeaves cloth.\n',
  'docs/plan.md': '# Plan\n\n| ID | Task |\n| --- | --- |\n| T-1 | Build the press |\n| T-2 | Fit the belt |\n| T-3 | Test the press |\n',
  'docs/notes.md': '# Notes\n\nThe belt is old.\nBuy a new one.\nAsk the yard.\n',
  'docs/old.md': '# Old notes\n\nNothing of note.\n',
  'logs/side-log.md': '# Side decisions\n\n### J1 · Buy the second press\n\nBought in May.\n\n### J2 · Keep the old belt\n\nUntil it snaps.\n\n### J3 · Mill at night\n\nPower is cheaper.\n',
  'logs/trip.md': '# Trip to the yard\n\nIt rained.\n',
  'reports/review-september.md': '# Review of the press\n\n结论：fail\n\nThe press jams on thick cloth.\n',
  'reports/owner-notes.md': `# Notes from the owner\n\nOn the scale the owner said: 「${OWNER_LINE}」\n`,
  'reports/weather.md': '# Weather\n\nDry all week.\n',
  'src/press.ts': 'export const press = 1;\n',
  // Outside what the round planned: a ticket file named for its number, and a loose list, each with a table of checks.
  'tickets/T-2-fit-the-belt.md': '# T-2 · Fit the belt\n\n| ID | Check |\n| --- | --- |\n| AC-1 | The belt runs true |\n| AC-2 | The guard is on |\n| AC-3 | The motor stays cool |\n',
  'tickets/checks.md': '# Checks to keep\n\n| ID | Check |\n| --- | --- |\n| AC-1 | Oil weekly |\n| AC-2 | Sweep daily |\n| AC-3 | Lock at night |\n',
});
{
  const { store, P, abs, job, lane, brief, round } = mill;
  store.plans.put({ id: 'organizing-plan', projectId: P.id, byRule: [], readClosely: [{ what: 'the code', targets: ['src/'], why: 'it is small' }], focus: [], order: [], corrections: [], jobId: null, asOf: AT, updatedAt: AT });
  brief('rdoc_docs', 'The document chain and decisions: the plan', '# Brief\n\n3. Read `docs/`, `logs/` and `reports/` in full.');
  store.jobs.put(job('job_main', 'main', null, []));
  // The lane read the plan whole and the first line of docs/notes.md; nothing of the logs and the reports.
  store.jobs.put(job('job_docs', 'lane', 'docs', [[{ path: abs('docs/plan.md') }], [{ path: abs('docs/notes.md'), from: 1, to: 1, lines: 5 }]], 'job_main'));
  store.clerkRounds.put({ ...round, lanes: [lane('The document chain and decisions: the plan', 'plan', 'rdoc_docs', 'job_docs')] });
  // The owner's line, in a session draft: cited by nothing, judged by nobody.
  store.sources.put({ id: 'src_seg', projectId: P.id, title: 'claude session s1 [0-9]', anchor: { kind: 'session', host: 'claude', sessionId: 's1', file: 's1.jsonl', cwd: null, messageStart: 0, messageEnd: 9, at: '2026-09-02T10:00:00Z' }, ids: [], version: { fingerprint: '', readAt: AT, commit: null }, excerpt: `[3] OWNER\n${OWNER_LINE}`, usedAs: null, usedAsBy: null, availability: null, movedTo: null, scopeItemId: 'si', hasCredential: false, bytes: 40 } as unknown as Source);
  store.drafts.put({ id: 'draft_s1', projectId: P.id, session: { host: 'claude', sessionId: 's1', file: 's1.jsonl', startedAt: '2026-09-02T09:00:00Z', endedAt: '2026-09-02T11:00:00Z' }, ownerLines: [{ ref: '3', at: '2026-09-02T10:00:00Z', text: OWNER_LINE, kind: 'Decision', answers: null, confirms: null }], agentSummary: [], jobId: null, at: AT } as SessionDraft);
}
const reference = (store: import('../../store/project-store.ts').ProjectStore, id: string, category: ReferenceItem['category'], name: string, ids: string[], quote: string | null = null, sourceIds: string[] = []): void => {
  store.reference.put({ id, projectId: store.projectId, category, name, ids, text: name, quote, basis: 'Explicit', validity: 'Current', progress: null, attribution: { author: { kind: 'owner', name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' }, sourceIds, refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT } as unknown as ReferenceItem);
};
type Group = { group: string; count: number; keys: string[]; read: string; holds?: { verdictLines?: { count: number; examples: string[] }; numbers?: { count: number; examples: string[] }; ownerQuotes?: { count: number; examples: string[] }; materials: string[] } };

test('the check says what each untouched group holds that nothing carries: verdict lines, numbers, the owner’s lines — as counts with examples (DA)', async () => {
  const r = await mill.call('pk_coverage_check', {});
  assert.equal(r.error, false, r.text);
  const groups = r.json.untouched as Group[];
  assert.deepEqual(groups.map((g) => [g.group, g.count]), [['documents:docs', 1], ['documents:docs (read in part)', 1], ['documents:logs', 2], ['documents:reports', 3], ['code files:src', 1]]);
  const by = new Map(groups.map((g) => [g.group, g.holds]));
  assert.deepEqual(by.get('documents:logs'), { numbers: { count: 3, examples: ['logs/side-log.md: J1, J2, J3'] }, materials: ['doc:logs/side-log.md'] }, 'the side log’s own entries, which no item carries');
  const reports = by.get('documents:reports')!;
  assert.deepEqual(reports.materials, ['doc:reports/owner-notes.md', 'doc:reports/review-september.md']);
  assert.equal(reports.verdictLines!.count, 1);
  assert.match(reports.verdictLines!.examples[0]!, /^reports\/review-september\.md:3 — 结论：fail$/);
  assert.equal(reports.ownerQuotes!.count, 1);
  assert.match(reports.ownerQuotes!.examples[0]!, /^reports\/owner-notes\.md: 「每一卷布出厂前都要过秤，不过秤的不许发货」 \(the owner, 2026-09-02; line draft_s1:3\)$/);
  assert.equal(reports.numbers, undefined);
  for (const quiet of ['documents:docs', 'documents:docs (read in part)', 'code files:src']) assert.equal(by.get(quiet), undefined, `${quiet} holds nothing`);
  // The round records what the check counted, for the Keeper view.
  assert.deepEqual(mill.now().coverage!.untouched!.find((g) => g.group === 'documents:logs')!.holds!.numbers!.count, 3);
});

test('a group that holds something is not written off whole; a group that holds nothing is accounted for as before (DA)', async () => {
  const refused = await mill.call('pk_account_material', { group: 'documents:logs', outcome: 'not needed', why: 'no open item points here' });
  assert.equal(refused.error, true);
  assert.match(refused.text, /documents:logs is not accounted for as a group: 1 of the 2 materials holds what nothing on the workbench carries — 3 numbers no item carries:\n- doc:logs\/side-log\.md: 3 numbers no item carries \(J1, J2, J3\)\n/);
  assert.match(refused.text, /Send a follow-up lane for them[^\n]*or account for each by its key with its own reason: pk_account_material \{ each: \[\{ key, why \}\], outcome \}\. The rest of the group is then accounted for as before\. Nothing was recorded\./);
  // A category is a group too.
  const whole = await mill.call('pk_account_material', { group: 'documents', outcome: 'not needed', why: 'none of it is needed' });
  assert.equal(whole.error, true);
  assert.match(whole.text, /documents is not accounted for as a group: 3 of the 6 materials hold what nothing on the workbench carries — 1 verdict line no work item links, 3 numbers no item carries, 1 owner's line not looked at yet/);
  // Several holding materials under one reason are a group by another name.
  const lumped = await mill.call('pk_account_material', { keys: ['doc:reports/owner-notes.md', 'doc:reports/review-september.md'], outcome: 'not needed', why: 'old reports' });
  assert.equal(lumped.error, true);
  assert.match(lumped.text, /These materials are not accounted for with one reason: 2 of the 2 materials hold/);
  assert.equal(mill.now().coverage!.accounted.length, 0, 'nothing was recorded');
  // What holds nothing goes as before: by group.
  const code = await mill.call('pk_account_material', { group: 'code files:src', outcome: 'not needed', why: 'one constant; the plan names no code question' });
  assert.deepEqual(code.json, { accounted: 1, settled: false, left: 7 });
});

test('a group id is matched exactly: the unread group does not take its part-read twin with it (DA)', async () => {
  const docs = await mill.call('pk_account_material', { group: 'documents:docs', outcome: 'not needed', why: 'old notes with nothing of note' });
  assert.deepEqual(docs.json, { accounted: 1, settled: false, left: 6 });
  assert.deepEqual(mill.now().coverage!.accounted.at(-1)!.keys, ['doc:docs/old.md'], 'docs/notes.md, read in part, is not swallowed');
  let listed = coverageGroups(coverageOf(mill.store, mill.now(), mill.L, mill.P)).map((g) => g.group);
  assert.ok(listed.includes('documents:docs (read in part)'));
  // The twin is a group of its own, with its own outcome.
  const twin = await mill.call('pk_account_material', { group: 'documents:docs (read in part)', outcome: 'part', why: 'its first line names the belt; the rest is a shopping list' });
  assert.deepEqual(twin.json, { accounted: 1, settled: false, left: 5 });
  listed = coverageGroups(coverageOf(mill.store, mill.now(), mill.L, mill.P)).map((g) => g.group);
  assert.deepEqual(listed, ['documents:logs', 'documents:reports']);
});

test('the two ways past: each holding material by its key with its own reason, or a lane — and what a lane wrote or read takes the count away (DA)', async () => {
  // By key, each with its own reason; a reason is not optional.
  const noWhy = await mill.call('pk_account_material', { each: [{ key: 'doc:logs/side-log.md', why: '' }], outcome: 'not needed' });
  assert.match(noWhy.text, /each material has its own reason; none was given for doc:logs\/side-log\.md/);
  const each = await mill.call('pk_account_material', { each: [{ key: 'doc:logs/side-log.md', why: 'the yard foreman’s own log of purchases: J1–J3 are his, not decisions of this project' }], outcome: 'not needed' });
  assert.equal(each.error, false, each.text);
  assert.deepEqual(each.json, { accounted: 1, settled: false, left: 4, held: 1 });
  const account = mill.now().coverage!.accounted.at(-1)!;
  assert.deepEqual([account.keys, account.group, account.holds], [['doc:logs/side-log.md'], null, '3 numbers no item carries (J1, J2, J3)'], 'the account keeps what the material held');
  // The rest of the group now holds nothing, and goes as a group.
  const rest = await mill.call('pk_account_material', { group: 'documents:logs', outcome: 'not needed', why: 'a trip in the rain' });
  assert.deepEqual(rest.json, { accounted: 1, settled: false, left: 3 });

  // A lane: what it writes carries what the group held, and what it reads whole leaves the list.
  const items = () => [...coverageOf(mill.store, mill.now(), mill.L, mill.P).open];
  assert.deepEqual([...materialHolds(mill.store, mill.L, items()).keys()].sort(), ['doc:reports/owner-notes.md', 'doc:reports/review-september.md']);
  // The owner's line becomes an Owner's words item: the quote in the notes is cited.
  reference(mill.store, 'ref_scale', "Owner's words", 'Every bolt is weighed', [], OWNER_LINE, ['src_seg']);
  assert.deepEqual([...materialHolds(mill.store, mill.L, items()).keys()], ['doc:reports/review-september.md']);
  // A link of a work item cites the review: its verdict line is linked.
  mill.store.links.put({ id: 'link_1', projectId: 'mill', workId: 'thread_press', ledgerRef: 'file:reports/review-september.md', evidence: null, stepKind: 'Checked', why: 'the review of the press', basis: 'Inferred', confirmed: false, check: null, roundId: 'crd_deep', jobId: 'job_follow', at: AT } as unknown as ProcessLink);
  assert.equal(materialHolds(mill.store, mill.L, items()).size, 0);
  const reports = await mill.call('pk_account_material', { group: 'documents:reports', outcome: 'not needed', why: 'the follow-up lane linked the review and wrote the owner’s line; the weather report serves no question' });
  assert.deepEqual(reports.json, { accounted: 3, settled: true, left: 0 });
});

test('what holds: a number an item carries or an account names is not counted; a numbered document’s rows of another family are its points; a session holds its lines not looked at (DA)', () => {
  const { store, L, P } = mill;
  const all = [...coverageOf(store, { ...mill.now(), coverage: null }, L, P).items.values()];
  const log = all.filter((i) => i.key === 'doc:logs/side-log.md');
  assert.deepEqual(materialHolds(store, L, log).get('doc:logs/side-log.md')?.numbers, ['J1', 'J2', 'J3']);
  // Carried by an item (its ids, or the start of its name), or accounted for by number (pk_account_entries).
  reference(store, 'ref_j1', 'Decision', 'J1 · Buy the second press', ['J1']);
  store.clerkRounds.put({ ...mill.now(), entryAccounts: [{ path: 'logs/side-log.md', numbers: ['J3'], why: 'a note on power prices, not a decision', at: AT }] });
  assert.deepEqual(materialHolds(store, L, log).get('doc:logs/side-log.md')?.numbers, ['J2']);
  // The plan's own rows are entries; nothing carries T-1…T-3 here.
  const plan = all.filter((i) => i.key === 'doc:docs/plan.md');
  assert.deepEqual(materialHolds(store, L, plan).get('doc:docs/plan.md')?.numbers, ['T-1', 'T-2', 'T-3']);
  // A document that is itself a numbered entry (its name, its title) holds its table rows of another family as its points.
  const doc = (rel: string): CoverageItem => ({ key: `doc:${rel}`, category: 'documents', label: rel, dir: 'tickets', bytes: 100, material: { key: `doc:${rel}`, category: 'document versions', label: rel, group: '', bytes: 100, how: '', file: mill.abs(rel), rev: null, current: true, lines: null } });
  assert.deepEqual(materialHolds(store, L, [doc('tickets/T-2-fit-the-belt.md')]).get('doc:tickets/T-2-fit-the-belt.md')?.numbers, ['T-2'], 'its own number, not its acceptance rows');
  assert.deepEqual(materialHolds(store, L, [doc('tickets/checks.md')]).get('doc:tickets/checks.md')?.numbers, ['AC-1', 'AC-2', 'AC-3'], 'a document with no number of its own: its rows are its entries');
  // A session: its owner's lines not looked at yet. The mill's one line is cited by now; a second one is not.
  const draft = store.drafts.get('draft_s1')!;
  store.drafts.put({ ...draft, ownerLines: [...draft.ownerLines, { ref: '7', at: '2026-09-02T10:30:00Z', text: '夜班的电价再去问一次', kind: 'Chat', answers: null, confirms: null }] });
  const session: CoverageItem = { key: 'session:s1', category: 'sessions', label: 'claude session s1 (9 messages)', dir: 'claude', bytes: 100, material: { key: 'session:s1', category: 'sessions', label: 'claude session s1', group: '', bytes: 100, how: '', session: 'session:s1', messages: 9, file: 's1.jsonl' } };
  assert.deepEqual(materialHolds(store, L, [session]).get('session:s1'), { verdictLines: [], numbers: [], ownerQuotes: ['claude session s1 (9 messages): 「夜班的电价再去问一次」 (line draft_s1:7)'] });
  // Code files and commits hold none of the three.
  assert.equal(materialHolds(store, L, all.filter((i) => i.category === 'code files' || i.category === 'commits')).size, 0);
  assert.equal(groupHoldsOf(coverageOf(store, mill.now(), L, P), new Map()).size, 0);
});

// ───────────────────────── a project with no decision log, no reports and no sessions ─────────────────────────

test('a project without a decision log, reports or sessions holds nothing: everything is accounted for by group, and nothing is refused (DA)', async () => {
  const small = build('feeder', {
    'README.md': '# Feeder\n\nAn app for pet owners.\n',
    'planning/roadmap.md': '# Roadmap\n\nFirst the feeding schedule, then the vet visits.\n',
    'planning/feeding.md': '# Feeding schedule\n\nTwice a day. “Never skip breakfast”, as the vet says.\n',
    'app/feed.ts': 'export const meals = 2;\n',
    'app/vet.ts': 'export const visits = 1;\n',
  });
  const { store, P, L, job, lane, brief, round, call } = small;
  store.plans.put({ id: 'organizing-plan', projectId: P.id, byRule: [], readClosely: [{ what: 'the code', targets: ['app/'], why: 'it is small' }], focus: [], order: [], corrections: [], jobId: null, asOf: AT, updatedAt: AT });
  brief('rdoc_docs', 'The document chain and decisions: planning', '# Brief\n\n3. Read `planning/` and `README.md` in full.');
  store.jobs.put(job('job_main', 'main', null, []));
  store.jobs.put(job('job_docs', 'lane', 'planning', [[{ path: small.abs('planning/roadmap.md'), from: 1, to: 1, lines: 3 }]], 'job_main'));
  store.clerkRounds.put({ ...round, lanes: [lane('The document chain and decisions: planning', 'plan', 'rdoc_docs', 'job_docs')] });

  const check = await call('pk_coverage_check', {});
  const groups = check.json.untouched as Group[];
  assert.deepEqual(groups.map((g) => g.group), ['documents:.', 'documents:planning', 'documents:planning (read in part)', 'code files:app']);
  assert.ok(groups.every((g) => g.holds === undefined), 'no group holds anything');
  assert.equal(materialHolds(store, L, [...coverageOf(store, small.now(), L, P).open]).size, 0);
  // By category: the unread documents as not needed, the part-read one as part, the code as not needed.
  const docs = await call('pk_account_material', { group: 'documents', outcome: 'not needed', why: 'the roadmap’s first line gave the order of work; the rest restates it' });
  assert.equal(docs.error, false, docs.text);
  assert.deepEqual(docs.json, { accounted: 2, settled: false, left: 3, leftListed: '1 material of documents read in part (account for them with outcome part)' });
  assert.deepEqual((await call('pk_account_material', { group: 'documents', outcome: 'part', why: 'its first line gives the order of work' })).json, { accounted: 1, settled: false, left: 2 });
  assert.deepEqual((await call('pk_account_material', { group: 'code files', outcome: 'not needed', why: 'two constants' })).json, { accounted: 2, settled: true, left: 0 });
  assert.equal(small.now().coverage!.settled, true);
});
