/**
 * The table follow-up, planned and taken in (D106, D107). A project taken over by the ProjectKeeper table
 * (`takenOverByTable`) is never given the clerk method's rounds: its Follow up — the owner's button, the schedule,
 * Continuous — is one pi job that carries the same table on. The job gets:
 * - a brief of what changed since the table's `asOf` (src/table/follow-up.ts);
 * - a short skill (skills/table-follow-up);
 * - read access to the project and the ledger;
 * - one writer, `pk_write_table`.
 * The writer is `write` below:
 * - it sets `asOf` and `filledBy`;
 * - it checks the whole table as `pk check` does, and refuses it with the problem list;
 * - or else it saves the table, takes it in (import.ts `applyTable`), commits the version when the table lives in
 *   ProjectKeeper's own folder, and records the run as a Follow up round, so the top bar and Keeper activity say what
 *   happened.
 * The program's check is the only hard gate: mid-tier models did worse under many rules and gates, and well with a plain
 * reading and a clear output (D106).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { App } from '../../server/app.ts';
import type { KeeperJob, PendingMaterial, Project } from '../../model/types.ts';
import type { RoundNews, RoundNewsItem } from '../../model/k-types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { organizingHeld } from '../held.ts';
import { roundIdOf, roundResultOf } from '../adjustment.ts';
import { KEEPER_AUTHOR } from '../project-folder.ts';
import { git, LONG_PATHS } from '../../util/git.ts';
import { checkFacts, checkShape, type TableProblem } from '../../table/check.ts';
import { applyTable, storeIdsOf, type Table } from '../../table/import.ts';
import {
  TABLE_FOLLOW_UP, briefText, draftFileOf, followUpPrompt, readTable, sessionMaterial, tableChanges, tableDiff, tablePlace,
  type TableChanges, type TableDiff, type TablePlace,
} from '../../table/follow-up.ts';
import type { TableWriteResult } from '../../table/follow-up-tools.ts';
import { takeoverState } from './takeover-state.ts';
import { scheduleDueFor, scheduleInForce } from './schedule-state.ts';
import { writeClerkCoverage } from './service.ts';

const ACTIVE: readonly string[] = ['Queued', 'Running', 'Waiting for quota', 'Paused'];
const RESTARTED = /restarted while this work was running/i;
/** A table follow-up reads and edits one table: two hours is far more than it needs, and only guards a session that never ends. */
const TIMEOUT_MS = 2 * 60 * 60_000;
const STARTED_BY = { owner: 'you pressed Follow up', schedule: 'the schedule', continuous: 'Continuous' } as const;
type StartedBy = keyof typeof STARTED_BY;

/** What a table follow-up's job carries in its task, set when it is queued. */
export interface TableJobExtra {
  readonly kind: typeof TABLE_FOLLOW_UP;
  readonly tableFile: string;
  readonly projectDir: string;
  readonly inHome: boolean;
  /** The working copy the session edits and hands in. */
  readonly draftFile: string;
  /** The asOf the program sets on what the session hands in: where each repository stood when the brief was made. */
  readonly asOf: TableChanges['asOf'];
  /**
   * When the brief was made: taken before the ledger was brought up to date, so an owner message written after it is the
   * next follow-up's. The program sets it as `filledBy.at`, which the next brief reads the owner's new messages from.
   */
  readonly briefAt: string;
  readonly startedBy: StartedBy;
}

export const tableExtraOf = (job: Pick<KeeperJob, 'task'> | undefined): TableJobExtra | null => {
  const extra = (job?.task as { extra?: { kind?: string } } | null | undefined)?.extra;
  return extra?.kind === TABLE_FOLLOW_UP ? extra as TableJobExtra : null;
};
/** A table follow-up's job: the model's session, or the program's record of a follow-up that found nothing to do. */
export const isTableJob = (job: Pick<KeeperJob, 'task'>): boolean => tableExtraOf(job) !== null
  || (job.task as { extra?: { kind?: string } } | null)?.extra?.kind === `${TABLE_FOLLOW_UP}:program`;
export const tableJobs = (store: ProjectStore): KeeperJob[] => store.jobs.filter(isTableJob).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));

/** Whether a job took a version of the table in: its run is recorded as a Follow up round (`recordRound`). */
const tookIn = (store: ProjectStore, jobId: string): boolean => store.rounds.find((r) => r.mainJobId === jobId && r.result !== null) !== undefined;

export class TableFollowUp {
  private readonly app: App;
  /** The clock the schedule is read against; a test sets it (service.ts `setClock`). */
  clock: () => number = () => Date.now();

  constructor(app: App) {
    this.app = app;
    // The runtime gives a table follow-up's session its writer through this hook (runtime.ts).
    if (app?.keeper?.hooks) app.keeper.hooks.tableWriter = (projectId, jobId) => (input) => this.write(projectId, jobId, input);
  }

  /**
   * One planning pass for a table project, in place of the clerk method's (service.ts `plan`). A follow-up is due when
   * the owner pressed Follow up since the last one ended; on Continuous, when the table is behind; else at a scheduled
   * time when the table is behind. Behind means a commit since its asOf, or an owner message since it was filled in.
   * A follow-up that failed or was stopped is not started again by itself: the owner retries it or presses Follow up.
   * One that a restart cut short goes on.
   */
  async plan(projectId: string): Promise<void> {
    const app = this.app;
    if (app.isClearing?.(projectId)) return;
    const store = app.store(projectId);
    const project = app.project(projectId);
    const jobs = tableJobs(store);
    this.settle(store, jobs);
    if (jobs.some((j) => ACTIVE.includes(j.status))) { this.scheduledTime(store, project, true, () => false); return; }
    const last = jobs[jobs.length - 1];
    if (organizingHeld(project)) return;
    if (last && last.status === 'Stopped' && RESTARTED.test(last.error ?? '') && last.agent !== 'program') { app.keeper.restartJob(projectId, last.id); return; }
    const state = takeoverState(store, project);
    const place = tablePlace(project, app.home);
    if (state.phase !== 'Done' || !place) return;
    const lastEnd = jobs.reduce((at, j) => ((j.endedAt ?? '') > at ? j.endedAt ?? '' : at), '');
    const held = last !== undefined && (last.status === 'Failed' || last.status === 'Stopped');
    // Commits are read from git as they are now; the owner's messages from the ledger as it stood when last rebuilt.
    const behind = () => { try { return !tableChanges(readTable(place.tableFile), place.projectDir, app.ledger.ledger(projectId), { diffs: false }).nothing; } catch { return false; } };
    let startedBy: StartedBy;
    if ((project.followUpAt ?? '') > lastEnd) startedBy = 'owner';
    else if (held) return;
    else if (scheduleInForce(project, state.completedAt).frequency === 'Continuous') { if (!behind()) return; startedBy = 'continuous'; }
    else if (this.scheduledTime(store, project, false, behind)) startedBy = 'schedule';
    else return;
    await this.start(store, app.project(projectId), place, startedBy);
  }

  /** A session that ended without a version the check took in did not do its work: it is recorded as failed, with why. */
  private settle(store: ProjectStore, jobs: readonly KeeperJob[]): void {
    for (const job of jobs) {
      if (job.agent === 'program' || job.status !== 'Done' || tookIn(store, job.id)) continue;
      store.jobs.put({ ...job, status: 'Failed', error: 'The session ended without handing in a table the check took in (pk_write_table)' }, { jobId: job.id, summary: `${job.scope.label}: no table was taken in` });
    }
  }

  /**
   * A scheduled time that has come (§3.8): recorded as dealt with, and whether a follow-up starts for it — not while one
   * runs, and not when the table is not behind.
   */
  private scheduledTime(store: ProjectStore, project: Project, running: boolean, behind: () => boolean): boolean {
    const state = takeoverState(store, project);
    if (state.phase !== 'Done') return false;
    const due = scheduleDueFor(store, project, state.completedAt, this.clock());
    if (!due) return false;
    const outcome = running ? 'a round was running' as const : behind() ? 'round' as const : 'nothing changed' as const;
    this.app.updateProject({ ...this.app.project(project.id), scheduleHandled: { slot: due.slot.toISOString(), at: new Date(this.clock()).toISOString(), outcome, roundId: null } });
    return outcome === 'round';
  }

  /**
   * Start a follow-up: the ledger brought up to date (it holds the owner's messages), the brief made, and the working
   * copy written beside the project's assets, where the session may edit it; then the job queued. A table not behind
   * gets no session: the program records that nothing changed.
   */
  private async start(store: ProjectStore, project: Project, place: TablePlace, startedBy: StartedBy): Promise<void> {
    const app = this.app;
    const startedAt = new Date().toISOString();
    try { await app.ledger.rebuild(project); } catch (e) { console.warn(`[table follow-up ${project.id}] the ledger was not brought up to date: ${(e as Error).message}`); }
    const label = `Table follow-up (${STARTED_BY[startedBy]})`;
    let table: Table;
    let changes: TableChanges;
    try {
      table = readTable(place.tableFile);
      changes = tableChanges(table, place.projectDir, app.ledger.ledger(project.id));
    } catch (e) {
      this.programJob(project.id, label, 'Failed', `The table ${place.tableFile} could not be read: ${(e as Error).message}`);
      return;
    }
    if (changes.nothing) {
      const job = this.programJob(project.id, label, 'Done', `Nothing changed since the table's asOf: no commit, and no owner message since ${table.project.filledBy.at}.`);
      this.recordRound(store, project.id, job.id, startedAt, 'Nothing new: no commit and no owner message since the table was filled in', true, []);
      app.setProjectRound(project.id, new Date().toISOString());
      return;
    }
    const runId = startedAt.replace(/[:.]/g, '-');
    const draftFile = draftFileOf(store, runId);
    // Earlier working copies are of follow-ups that have ended.
    const drafts = dirname(draftFile);
    mkdirSync(drafts, { recursive: true });
    for (const f of readdirSync(drafts)) if (f.endsWith('.json')) rmSync(join(drafts, f), { force: true });
    writeFileSync(draftFile, readFileSync(place.tableFile, 'utf8'));
    const extra: TableJobExtra = { kind: TABLE_FOLLOW_UP, tableFile: place.tableFile, projectDir: place.projectDir, inHome: place.inHome, draftFile, asOf: changes.asOf, briefAt: startedAt, startedBy };
    app.keeper.enqueue(project.id, {
      kind: 'Organizing', initiator: 'auto', priority: 1, timeoutMs: TIMEOUT_MS,
      scope: { kind: TABLE_FOLLOW_UP, ids: [], label },
      prompt: followUpPrompt(briefText(table, place, draftFile, changes)),
      task: extra,
    });
  }

  /** A follow-up the program settled by itself, in Keeper activity beside the sessions. */
  private programJob(projectId: string, label: string, status: 'Done' | 'Failed', text: string): KeeperJob {
    const job = this.app.keeper.recordProgramJob(projectId, { kind: 'Organizing', scope: { kind: TABLE_FOLLOW_UP, ids: [], label }, step: null, parentJobId: null, task: { kind: `${TABLE_FOLLOW_UP}:program` } });
    this.app.keeper.endProgramJob(projectId, job.id, status, status === 'Done' ? { resultText: text } : { error: text });
    return this.app.store(projectId).jobs.get(job.id) ?? job;
  }

  /**
   * `pk_write_table` (D107): one version of the table handed in by a follow-up's session — the one given, or else its
   * working copy. The program sets `asOf` and `filledBy.at` (the brief's) and `filledBy.agent` (this run), checks the shape
   * and then the facts, with the session material built from the ledger and the sources the table already cites. A table
   * with any problem is refused with the list and nothing changes. One that holds is saved, taken in, committed to the
   * table's own history when it lives in ProjectKeeper's folder, and recorded as a Follow up round.
   */
  async write(projectId: string, jobId: string, input: unknown): Promise<TableWriteResult> {
    const app = this.app;
    const store = app.store(projectId);
    const job = store.jobs.get(jobId);
    const extra = tableExtraOf(job);
    if (!job || !extra) return { ok: false, text: 'This job is not a table follow-up, so it has no table to hand in.' };
    let given: unknown = input;
    if (given === undefined || given === null || given === '') {
      try { given = JSON.parse(readFileSync(extra.draftFile, 'utf8')); } catch (e) { return { ok: false, text: `Your working copy ${extra.draftFile} is not readable as JSON: ${(e as Error).message}` }; }
    } else if (typeof given === 'string') {
      try { given = JSON.parse(given); } catch (e) { return { ok: false, text: `table is not readable as JSON: ${(e as Error).message}` }; }
    }
    if (!given || typeof given !== 'object' || Array.isArray(given)) return { ok: false, text: 'The table must be one JSON object.' };
    const at = new Date().toISOString();
    const agent = `ProjectKeeper Keeper (pi${job.model ? `, ${job.model.provider}/${job.model.id}` : ''})`;
    const t = given as Record<string, unknown>;
    const header = t.project && typeof t.project === 'object' ? t.project as Record<string, unknown> : null;
    const filled = header?.filledBy && typeof header.filledBy === 'object' ? header.filledBy as Record<string, unknown> : {};
    const stamped = header ? { ...t, project: { ...header, asOf: extra.asOf, filledBy: { agent, at: extra.briefAt ?? at, ...(filled.read !== undefined ? { read: filled.read } : {}) } } } : t;
    const refused = (problems: readonly TableProblem[]): TableWriteResult => ({
      ok: false,
      text: [
        `The table was not taken in: ${problems.length} problem${problems.length === 1 ? '' : 's'}. Nothing changed. Fix each one in your working copy and call pk_write_table again.`,
        ...problems.slice(0, 80).map((p) => `${p.at}  ${p.problem}`),
        ...(problems.length > 80 ? [`… and ${problems.length - 80} more`] : []),
      ].join('\n'),
    });
    const shape = checkShape(stamped);
    if (shape.length) return refused(shape);
    const table = stamped as unknown as Table;
    const sessions = sessionMaterial(app.ledger.ledger(projectId), store, table);
    const facts = checkFacts(stamped, extra.projectDir, sessions);
    if (facts.length) return refused(facts);

    let before: Table | null = null;
    try { before = readTable(extra.tableFile); } catch { before = null; }
    const diff = before ? tableDiff(before, table) : null;
    const tmp = `${extra.tableFile}.${jobId}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`);
    renameSync(tmp, extra.tableFile);
    await applyTable(app, projectId, table, { tableFile: extra.tableFile, projectDir: extra.projectDir, sessions, jobId, summary: `Taken in from the table follow-up ${jobId}` });
    const what = diff ? diff.line : 'the table file could not be read before, so what changed is not known';
    // The table's own history (D107 addendum): kept beside the table in ProjectKeeper's folder; never in the project.
    const commit = extra.inHome ? commitTableVersion(extra.tableFile, `Table follow-up ${jobId} (${STARTED_BY[extra.startedBy]}): ${what}`) : null;
    const news = diff ? this.noteNews(table, projectId, diff) : [];
    const nothingNew = diff !== null && diff.count === 0;
    this.recordRound(store, projectId, jobId, job.startedAt ?? at, nothingNew ? 'Nothing new' : `the table follow-up changed ${what}`, nothingNew, news);
    app.setProjectRound(projectId, at);
    writeClerkCoverage(app, projectId);
    await store.flush();
    return {
      ok: true,
      text: [
        `Taken in: ${what}.`,
        commit && 'commit' in commit ? `The version is committed to the table's history (${commit.commit.slice(0, 12)}).` : commit ? `The version is saved but not committed to the table's history: ${commit.reason}` : null,
        `The table is saved at ${extra.tableFile}. End now with a few sentences: what you changed, and why.`,
      ].filter(Boolean).join(' '),
    };
  }

  /** The notes a version added or changed, as the round's news names them (§3.8: each with where it is). */
  private noteNews(table: Table, projectId: string, diff: TableDiff): RoundNewsItem[] {
    const notes = diff.lists.find((l) => l.list === 'notes');
    if (!notes) return [];
    const ids = storeIdsOf(table, projectId);
    return [...notes.added.map((id) => [id, 'new'] as const), ...notes.changed.map((id) => [id, 'changed'] as const)].flatMap(([id, detail]) => {
      const n = table.notes.find((x) => x.id === id);
      return n ? [{ id: ids.get(id)!, label: n.title, position: `Notes · ${n.title}`, objectId: n.on[0] ? ids.get(n.on[0]) ?? null : null, detail }] : [];
    });
  }

  /**
   * The follow-up's run as a Follow up round record (`store.rounds`) with its result, so the top bar's last Follow up
   * (service.ts `lastFollowUp`) and the round's result say what it changed, or that it found nothing new. A session
   * that hands in several versions keeps one record.
   */
  private recordRound(store: ProjectStore, projectId: string, jobId: string, startedAt: string, statement: string, nothingNew: boolean, notes: readonly RoundNewsItem[]): void {
    const existing = store.rounds.find((r) => r.mainJobId === jobId);
    const number = existing?.number ?? Math.max(0, ...store.rounds.all().map((r) => r.number)) + 1;
    const id = existing?.id ?? roundIdOf(number);
    const at = new Date().toISOString();
    const base = { id, projectId, number, startedAt: existing?.startedAt ?? startedAt, endedAt: at, mainJobId: jobId, result: null };
    const trace = { jobId, summary: `Table follow-up: ${statement}` };
    store.rounds.put(base, trace);
    const news: RoundNews = { breakpoints: [], sendbacks: [], sixThings: [], patches: [], notes, nothingNew, statement: nothingNew ? 'Nothing new' : statement, complete: true };
    store.rounds.put({ ...base, result: roundResultOf(store, id, `Table follow-up: ${statement}`, at, news) }, trace);
  }
}

/**
 * Commit one version of a table kept in ProjectKeeper's own folder to a git repository of the table's folder, made on
 * first use (D107 addendum three). Only the table file is added, and the Keeper is the author and the committer. Returns the commit, or why there is none.
 */
export function commitTableVersion(tableFile: string, message: string): { readonly commit: string } | { readonly reason: string } {
  const dir = dirname(tableFile);
  const name = basename(tableFile);
  const [, authorName = 'ProjectKeeper', email = 'keeper@projectkeeper.invalid'] = /^(.*) <(.*)>$/.exec(KEEPER_AUTHOR) ?? [];
  const run = (args: readonly string[]): { ok: boolean; out: string; err: string } => {
    try {
      const out = execFileSync('git', ['--no-pager', '-c', `user.name=${authorName}`, '-c', `user.email=${email}`, ...LONG_PATHS, '-C', dir, ...args], {
        encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 20_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, out, err: '' };
    } catch (e) { const x = e as { stdout?: string; stderr?: string; message?: string }; return { ok: false, out: x.stdout ?? '', err: (x.stderr || x.message || String(e)).trim() }; }
  };
  if (!existsSync(join(dir, '.git'))) {
    const init = run(['init', '-q']);
    if (!init.ok) return { reason: `git init failed: ${init.err}` };
  }
  const add = run(['add', '--', name]);
  if (!add.ok) return { reason: `git add failed: ${add.err}` };
  if (run(['diff', '--cached', '--quiet', '--', name]).ok && git(dir, ['rev-parse', '--verify', 'HEAD']).ok) return { reason: 'the table is the same as the version committed last' };
  const commit = run(['commit', '-q', '-m', message, '--', name]);
  if (!commit.ok) return { reason: `git commit failed: ${commit.err}` };
  return { commit: git(dir, ['rev-parse', 'HEAD']).out.trim() };
}

/**
 * What waits for a table project's next follow-up, the way the coverage lists it (§1.11): each commit since the table's
 * asOf, and each session with an owner message since the table was filled in. Read from git and the ledger as they are.
 */
export function tablePending(app: App, project: Project): PendingMaterial[] {
  const place = tablePlace(project, app.home);
  if (!place) return [];
  let changes: TableChanges;
  try { changes = tableChanges(readTable(place.tableFile), place.projectDir, app.ledger.ledger(project.id), { diffs: false }); } catch { return []; }
  const pending: PendingMaterial[] = [];
  for (const r of changes.repos) for (const c of r.commits) pending.push({ kind: 'commit', ref: `${join(place.projectDir, r.path)}@${c.hash}`, label: `${c.hash.slice(0, 8)} ${c.subject}`.trim(), since: c.at });
  const sessions = new Map<string, PendingMaterial>();
  for (const m of changes.owner) if (!sessions.has(m.session)) sessions.set(m.session, { kind: 'session', ref: m.session, label: `${m.session.split(':')[0]} session ${m.session.split(':').slice(1).join(':').slice(0, 8)}`, since: m.at ?? project.takenOverByTable?.at ?? '' });
  return [...pending, ...sessions.values()].sort((a, b) => a.since.localeCompare(b.since) || a.label.localeCompare(b.label));
}
