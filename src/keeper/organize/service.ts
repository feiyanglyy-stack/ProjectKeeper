/**
 * Organizing service (CKC-05, CKC-06, CKC-07, CKC-13): plans and queues the Keeper's automatic work from the state of
 * the assets, keeps the coverage record honest, marks entries whose material changed (`Update pending`), and derives
 * the graph after every job.
 *
 * Since increment K every round is a round of the clerk method (Spec v3.0 §3.3; clerk.ts). Planning is a pull: after
 * each job (and after intake, settled changes, resume) the service lets the clerk planner advance the round under way or
 * start the one that is due, and brings coverage and the takeover's progress up to date from the rounds, so the Keeper
 * activity list shows what is happening now.
 */
import type { Coverage, CoverageScope, DeepeningPlan, KeeperJob, TakeoverStatus } from '../../model/types.ts';
import { organizingHeld } from '../held.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import type { PendingChange } from '../../sources/watch.ts';
import type { IntakeResult } from '../../intake/intake.ts';
import { excludedLocations, splitTooLarge } from '../../intake/skipped.ts';
import type { App } from '../../server/app.ts';
import type { KeeperEvent } from '../runtime.ts';
import { gitHead } from '../../util/git.ts';
import { listMaterials } from './materials.ts';
import { areaOf, deriveGraph } from './graph.ts';
import { positioningBlock } from './positioning.ts';
import { composeRelook, scopeLabel, type RelookScope } from '../relook/compose.ts';
import { relookPrompt } from '../relook/prompts.ts';
import { takeoverState } from './takeover-state.ts';
import { scheduleDueFor } from './schedule-state.ts';
import { clerkDepthOptions, deepeningAsRun, deepeningPlanned, deepeningReads, firstUsableFigures, focusedCovers } from './takeover-clerk.ts';
import { readingBasisText } from './reading.ts';
import { isRoundMain } from '../roles.ts';
import { ACTIVE_STATUSES, ClerkPlanner, stepFailureText, type LedgerRunner, type ProcessRunner } from './clerk.ts';
import { clerkLevels, clerkPending } from './clerk-coverage.ts';
import { refreshUpdatePending } from './update-pending.ts';

/** What the service reads from a job's task, and writes into a re-look's: its kind, judgement record and scope. */
interface TaskExtra { readonly kind: string; readonly judgementId?: string; readonly scopeKey?: string }

const ACTIVE: readonly string[] = ['Queued', 'Running', 'Waiting for quota', 'Paused'];
const extraOf = (job: KeeperJob): TaskExtra | null => ((job.task as { extra?: TaskExtra } | null)?.extra ?? null);

/** What an owner's request left to re-look at, kept on the request's job until the re-looks open (§3.3, §5.6). */
interface DeferredExtra { readonly deferredRelooks?: readonly RelookScope[]; readonly relooksOpenedAt?: string | null }
const deferredOf = (job: KeeperJob): DeferredExtra | null => ((job.task as { extra?: DeferredExtra } | null)?.extra ?? null);

/** A round under way: a round of the clerk method running, or — left by a build before it — a round's main job still active. */
function roundUnderWay(store: ProjectStore): boolean {
  return store.clerkRounds.find((r) => r.status === 'Running') !== undefined || store.jobs.find((j) => ACTIVE.includes(j.status) && isRoundMain(j)) !== undefined;
}

export class OrganizingService {
  private readonly app: App;
  private readonly enabled: boolean;
  private readonly replanning = new Map<string, { running: boolean; again: boolean }>();

  /** The clerk method (Spec v3.0 §3.3): plans every round since increment K. */
  private clerk: ClerkPlanner;

  constructor(app: App, enabled = true) { this.app = app; this.enabled = enabled; this.clerk = new ClerkPlanner(app, null); }

  /** The program step of every round: bring the ledger up to date (src/ledger). Set once the build carries it. */
  setLedgerRunner(runner: LedgerRunner | null): void { this.clerk.setLedgerRunner(runner); }
  /** The program step that computes each work item's process and breakpoints (§2.12). Set once the build carries it. */
  setProcessRunner(runner: ProcessRunner | null): void { this.clerk.setProcessRunner(runner); }

  start(): void {
    this.app.keeper.on('event', (event: KeeperEvent) => { if (event.kind === 'done') void this.afterJob(event.projectId, event.jobId); });
  }

  /** The clock the schedule is read against (§3.8); a test sets it. */
  setClock(clock: () => number): void { this.clerk.clock = clock; }

  private ticker: NodeJS.Timeout | null = null;
  /**
   * Watch the clock for the scheduled times (§3.8; CKC-07 AC-29, AC-30): twice a minute, a project whose scheduled time
   * has come is planned again, and the planner starts a round when something changed. After the machine slept, or
   * ProjectKeeper was not running, the first pass finds the time that was missed and makes up for it with one round.
   */
  watchSchedule(everyMs = 30_000): void {
    if (!this.enabled || this.ticker) return;
    this.ticker = setInterval(() => { void this.tick(); }, everyMs);
    this.ticker.unref?.();
  }
  stopWatchingSchedule(): void { if (this.ticker) { clearInterval(this.ticker); this.ticker = null; } }
  /** One pass over the projects: one whose scheduled time has come is planned again. A paused project waits for its resume. */
  async tick(): Promise<void> {
    for (const p of this.app.workspace.list()) {
      try {
        if (organizingHeld(p)) continue;
        const store = this.app.store(p.id);
        const state = takeoverState(store, p);
        if (state.phase === 'Done' && scheduleDueFor(store, p, state.completedAt, this.clerk.clock())) await this.replan(p.id);
      } catch (e) { console.warn(`[schedule ${p.id}] ${(e as Error).message}`); }
    }
  }

  /**
   * When ProjectKeeper starts, each project's organizing goes on from its saved progress (Spec §3.10 接着做): the round
   * under way advances — what the restart cut short runs again (clerk.ts `stepEnding`) — and a step of a round that was
   * waiting for quota is queued again, because what would have queued it (the runtime's quota and rate-limit timers) did
   * not outlive the last run. If the quota is still out, it waits again.
   */
  resumeAll(): void {
    for (const p of this.app.workspace.list()) {
      if (this.enabled) {
        try {
          const store = this.app.store(p.id);
          for (const j of store.jobs.filter((x) => x.status === 'Waiting for quota' && store.clerkRounds.get(x.step?.roundId ?? '')?.status === 'Running')) this.app.keeper.restartJob(p.id, j.id);
        } catch (e) { console.warn(`[organize ${p.id}] ${(e as Error).message}`); }
      }
      void this.replan(p.id);
    }
  }
  onIntake(projectId: string): void { void this.replan(projectId); }

  /**
   * The owner's Retry or Continue on a job (Spec §3.10, §6.9). A job of a round's step is the planner's to run again — a
   * job the program did itself as well (the ledger, the process, the program's part of a step), which the runtime does
   * not run; any other job goes back on the runtime's queue.
   */
  runAgain(projectId: string, jobId: string): boolean {
    const store = this.app.store(projectId);
    const job = store.jobs.get(jobId);
    if (!job) return false;
    return job.step ? this.clerk.ownerRunAgain(store, this.app.project(projectId), job) : this.app.keeper.restartJob(projectId, jobId);
  }

  onSettled(projectId: string, changes: readonly PendingChange[], _result: IntakeResult): void {
    this.markPending(projectId, changes);
    void this.replan(projectId);
  }

  /**
   * Settled changes were just read (§3.2): the entries they affect show `Update pending` (§1.11), each naming the changes it
   * waits for and how they reach it (update-pending.ts). The marks follow the coverage's list of what waits for the next
   * round, so only material that will be organized again marks anything: what is History only or Reference only, what the
   * scope does not read, what the project's rules settle and the Keeper's own commits of its project folder never do.
   *
   * A changed material does not modify the work items built on it, so their propagation judgements stand (§2.10,
   * §5.5): a work item is modified when organizing brings it up to date, and then the next round judges what it still
   * lacks, while what already has a conclusion keeps it. Its own time is left alone as well: when an object last
   * changed is evidence a judgement weighs, and the change of a material is not a change of the object. Resetting the
   * entries to `Not yet checked` here left objects in the change's detail that no round would judge — a concluded
   * item is not judged again, and the refreshed time made the entry read as answered (batch D2, AK P4).
   */
  markPending(projectId: string, changes: readonly PendingChange[]): void {
    if (changes.length === 0) return;
    try { refreshUpdatePending(this.app, projectId); } catch (e) { console.warn(`[update pending ${projectId}] ${(e as Error).message}`); }
  }

  private async afterJob(projectId: string, jobId: string): Promise<void> {
    const store = this.app.store(projectId);
    const job = store.jobs.get(jobId);
    if (job && extraOf(job)?.kind === 'relook') this.finalizeRelook(store, job);
    try { deriveGraph(store, this.app.project(projectId)); } catch (e) { console.warn(`[graph ${projectId}] ${(e as Error).message}`); }
    if (job && job.kind === 'Your request' && job.status === 'Done') this.relookAfterRequest(store, job);
    await this.replan(projectId);
  }

  /** §5.6: after a delegated or authorized adjustment, the affected scope is re-looked at; changing files alone resolves nothing. */
  private relookAfterRequest(store: ProjectStore, job: KeeperJob): void {
    const areaIds = new Set<string>();
    const consider = (id: string) => { const a = store.reference.has(id) ? areaOf(store, id) : store.threads.has(id) ? this.threadArea(store, id) : null; if (a) areaIds.add(a); };
    for (const r of job.savedResults) consider(r.id);
    const ctx = (job.task as { extra?: { context?: { kind: string; id: string } } } | null)?.extra?.context;
    if (ctx?.kind === 'note') { const n = store.notes.get(ctx.id); for (const id of n?.mount.ids ?? []) consider(id); }
    else if (ctx) consider(ctx.id);
    const scopes: RelookScope[] = areaIds.size === 0 ? [{ kind: 'project', id: null, label: 'Whole project' }] : [...areaIds].slice(0, 3).map((id) => ({ kind: 'area', id, label: store.reference.get(id)?.name ?? id }));
    // Like every automatic re-look, it opens after the round under way has ended, not alongside it (§3.3): the round's
    // synthesis writes the notes then. What waits is kept on the request's own job, not in memory, so a restart in between
    // does not lose it (C1's hand-back item 2), and `openDeferredRelooks` opens it once no round is under way.
    if (roundUnderWay(store)) {
      const current = store.jobs.get(job.id) ?? job;
      const task = (current.task ?? {}) as { extra?: Record<string, unknown> | null };
      const extra = task.extra ?? {};
      const waiting = [...((extra.deferredRelooks as RelookScope[] | undefined) ?? []), ...scopes];
      store.jobs.put({ ...current, task: { ...task, extra: { ...extra, deferredRelooks: waiting, relooksOpenedAt: null } } }, { jobId: job.id, summary: `Re-look after the request waits for the round under way: ${scopes.map((sc) => sc.label).join(', ')}` });
      return;
    }
    for (const scope of scopes) this.enqueueRelook(job.projectId, scope, false);
  }

  /**
   * The re-looks an owner's request left for after the round under way (`relookAfterRequest`), opened once no round is
   * under way — each scope once — and marked opened on the request's job, so they open once and a restart before then
   * does not lose them. The reader of what waits went with the material rounds' planner (06bccd4), which left the owner's
   * request stored and never opened (explore of test-C-1, §5.6 item 5).
   */
  openDeferredRelooks(projectId: string): number {
    const store = this.app.store(projectId);
    if (roundUnderWay(store)) return 0;
    const waiting = store.jobs.filter((j) => (deferredOf(j)?.deferredRelooks?.length ?? 0) > 0 && !deferredOf(j)?.relooksOpenedAt).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    if (!waiting.length) return 0;
    const now = new Date().toISOString();
    const seen = new Set<string>();
    for (const j of waiting) {
      const task = (j.task ?? {}) as { extra?: Record<string, unknown> | null };
      store.jobs.put({ ...j, task: { ...task, extra: { ...(task.extra ?? {}), relooksOpenedAt: now } } }, { jobId: j.id, summary: 'The re-looks the request left for after the round are opened now' });
      for (const scope of deferredOf(j)!.deferredRelooks!) {
        const key = `${scope.kind}:${scope.id ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.enqueueRelook(projectId, scope, false);
      }
    }
    return seen.size;
  }

  private threadArea(store: ProjectStore, threadId: string): string | null {
    const t = store.threads.get(threadId);
    if (!t) return null;
    for (const s of t.serves) { const a = areaOf(store, s.referenceId); if (a) return a; }
    return null;
  }

  /** After a re-look: a `Questioned` without a note is not allowed (§2.5); record whether anything was found. */
  private finalizeRelook(store: ProjectStore, job: KeeperJob): void {
    const judgementId = extraOf(job)?.judgementId;
    const j = judgementId ? store.judgements.get(judgementId) : undefined;
    if (!j) return;
    const now = new Date().toISOString();
    const assessments = j.outcome.assessments.filter((a) => {
      if (a.assessment !== 'Questioned') return true;
      const r = store.relations.get(a.relationId);
      if (!r) return false;
      const hasNote = store.notes.find((n) => n.status === 'Current' && (n.mount.ids.includes(r.id) || n.mount.ids.includes(r.from) || n.mount.ids.includes(r.to) || n.versions.some((v) => v.judgementRecordId === j.id && (v.preview.includes(r.id) || JSON.stringify(v.body).includes(r.id)))));
      if (hasNote) return true;
      store.relations.put({ ...r, assessment: 'Not assessed', assessedAt: now, assessedInJobId: job.id, updatedAt: now }, { jobId: job.id, summary: 'Questioned without a note; assessment reverted to Not assessed' });
      return false;
    });
    const reconsideredOnly = job.status === 'Done' && j.outcome.noteIds.length === 0 && assessments.length === 0;
    store.judgements.put({ ...j, outcome: { ...j.outcome, assessments, reconsideredOnly } });
    // The notes this re-look touched keep the course of events (§4.5, CKC-11 AC-16).
    for (const noteId of j.outcome.noteIds) {
      const n = store.notes.get(noteId);
      if (!n || n.followUps.some((f) => f.jobId === job.id)) continue;
      store.notes.put({ ...n, followUps: [...n.followUps, { kind: 'relook', jobId: job.id, at: now, summary: `Product re-look: ${j.scope.label}${n.status !== 'Current' ? ` → ${n.status}` : ''}` }] });
    }
    if (job.status === 'Done') {
      const scopes = store.coverage.scopes.map((s) => (s.id === 'project' ? { ...s, lastRelookAt: now } : s));
      store.setCoverage({ ...store.coverage, scopes }, { jobId: job.id, summary: `Product re-look done: ${j.scope.label}${reconsideredOnly ? ' (reconsidered; no new finding)' : ''}` });
    }
  }

  /** Owner-requested re-look (§3.4 "owner 要求"): runs in the owner lane ahead of backlog. */
  requestRelook(projectId: string, scope: RelookScope): KeeperJob {
    return this.enqueueRelook(projectId, scope, true);
  }

  private enqueueRelook(projectId: string, scope: RelookScope, byOwner: boolean): KeeperJob {
    const store = this.app.store(projectId);
    const project = this.app.project(projectId);
    const composed = composeRelook(store, project, scope, '');
    store.judgements.put(composed.judgement, { jobId: null, summary: `Re-look inputs composed: ${composed.judgement.scope.label}` });
    const first = !store.judgements.find((j) => j.scope.kind === 'project' && j.id !== composed.judgement.id);
    const job = this.app.keeper.enqueue(projectId, {
      kind: 'Product re-look', initiator: byOwner ? 'owner' : 'auto', priority: byOwner ? 0 : 2, timeoutMs: 45 * 60_000,
      scope: { kind: scope.kind, ids: scope.id ? [scope.id] : [], label: scopeLabel(store, scope) },
      prompt: relookPrompt(positioningBlock(store, project), composed.judgement.scope.label, composed.judgement.id, composed.text, first, byOwner),
      judgementId: composed.judgement.id,
      task: { kind: 'relook', judgementId: composed.judgement.id, scopeKey: `${scope.kind}:${scope.id ?? ''}` } satisfies TaskExtra,
    });
    store.judgements.put({ ...composed.judgement, jobId: job.id });
    return job;
  }

  /** Re-evaluate what to queue next; serialized per project. */
  async replan(projectId: string): Promise<Coverage> {
    if (!this.enabled || this.app.isClearing(projectId)) return this.app.store(projectId).coverage;
    let st = this.replanning.get(projectId);
    if (!st) { st = { running: false, again: false }; this.replanning.set(projectId, st); }
    if (st.running) { st.again = true; return this.app.store(projectId).coverage; }
    st.running = true;
    try {
      do { st.again = false; await this.plan(projectId); } while (st.again);
    } catch (e) {
      console.warn(`[organize ${projectId}] ${(e as Error).message}`);
    } finally {
      st.running = false;
    }
    return this.app.store(projectId).coverage;
  }

  /**
   * Since increment K every round is a round of the clerk method (Spec v3.0 §3.3; CKC-23): the planner below advances the
   * round under way or starts the one that is due, and the coverage and the depth question follow from its rounds. The
   * material rounds it replaced (D59; CKC-06) are gone.
   */
  private async plan(projectId: string): Promise<void> {
    await this.clerk.plan(projectId);
    this.openDeferredRelooks(projectId);
    this.clerkCoverage(projectId);
  }

  /** The coverage and the takeover's progress for the clerk method's rounds (`writeClerkCoverage`). */
  private clerkCoverage(projectId: string): void {
    writeClerkCoverage(this.app, projectId);
  }
}

/**
 * Coverage and takeover progress for the clerk method's rounds (Spec §3.7, §1.11; CKC-13 AC-1, AC-10, AC-19, AC-20):
 * the first usable round's time as evidence (D37), where the takeover stands (not started, under way, done), what waits and what is
 * running or failed, every material's organizing level, and the last Follow up. The depth options are sized from the
 * project's own material. Exported so a fixture that plants rounds gets the coverage the product computes from them.
 */
export function writeClerkCoverage(app: App, projectId: string): void {
  const store = app.store(projectId);
  const project = app.project(projectId);
  const rounds = store.clerkRounds.all().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const first = rounds.find((r) => r.kind === 'First usable');
  const firstDone = first?.status === 'Done';
  // Where the takeover stands is read from the rounds (takeover-state.ts): the depth is the one the takeover runs to, and
  // once it is done, the one that ran — never the last button pressed (D105).
  const takeover = takeoverState(store, project);
  const notStarted = takeover.phase === 'Not started';
  const depth = takeover.phase === 'Done' ? takeover.ran : takeover.chosen;
  const complete = takeover.phase === 'Done';
  const stage: TakeoverStatus['stage'] = notStarted ? 'Not started' : !firstDone ? 'First usable' : complete ? 'Daily' : 'Deepening';
  // §3.7 by the clerk method: the first usable round's own figures, what a deepening reads path by path (counted from
  // the ledger), the three options on a stated basis, and the deepening's progress path by path — with what each path
  // actually read against its plan, and the round against the whole plan, beside the estimate (CKC-13 AC-8).
  const ledger = app.ledger.ledger(projectId);
  const figures = firstUsableFigures(store, first, ledger, project);
  // The plan is counted once for the options, the paths and the deepening as it ran: counting it reads the ledger's totals.
  const planned = deepeningPlanned(ledger, store);
  const { options, basis, perMaterial } = clerkDepthOptions(figures, ledger, store, app.keeper.autoLaneCountFor(projectId), planned, project);
  const asRun = deepeningAsRun(ledger, store, project, planned);
  // A deepening read by reading assignments (reading.ts): how its reading is counted and its assignments sized.
  const reading = rounds.filter((r) => r.kind === 'Deepen' && r.reading).pop()?.reading ?? null;
  const deepening: DeepeningPlan = { paths: deepeningReads(ledger, store, planned), focused: focusedCovers(store), basis, progress: asRun.progress, actual: asRun.actual, ...(reading ? { readingBasis: readingBasisText(reading) } : {}) };
  const chosen = options.find((o) => o.depth === depth);
  // Under way, what remains of a deepening read by assignments is what its paths have not accounted for yet.
  const open = reading ? asRun.progress.reduce((n, p) => n + (p.reading?.open ?? 0), 0) : null;
  // What waits for the next round, and every material's organizing level (§1.11; CKC-07 AC-1, AC-10; CKC-13 AC-8): from
  // the rounds, the jobs' recorded calls, the drafts and the rules. Both used to be written empty on every pass, which
  // wiped what the watcher and intake had listed and left the level table blank (QC AY B1, B8).
  const materials = listMaterials(store, project);
  // Before `Start` nothing is taken in and nothing counts as waiting (D105; CKC-13 AC-20).
  const found = clerkPending(store, project, app.pendingChanges(projectId), materials);
  const waiting = notStarted ? { ...found, pending: [], keys: new Set<string>() } : found;
  const { pending, keys: pendingKeys } = waiting;
  const { levels, sampled, readInPart, historyNotOrganized } = clerkLevels(store, project, pendingKeys, materials);
  // The entries what waits affects show `Update pending` from the same list (§1.11; CKC-07 AC-10), so the marks and the
  // coverage agree: what a round took in leaves both at once. A failure here never keeps the coverage from being written.
  try { refreshUpdatePending(app, projectId, waiting); } catch (e) { console.warn(`[update pending ${projectId}] ${(e as Error).message}`); }
  const status: TakeoverStatus = {
    depth: depth ?? 'Depth not chosen', stage,
    firstUsable: { startedAt: first?.startedAt ?? project.createdAt, completedAt: firstDone ? first!.endedAt : null, minutes: figures.minutes, byKind: figures.byKind, ownerWords: figures.ownerWords },
    levels, readInPart, sampled,
    remaining: stage === 'Deepening' && chosen && chosen.depth !== 'First picture only'
      ? open !== null && perMaterial
        ? { materials: open, minutes: Math.round((open * perMaterial.minutes) / Math.max(1, app.keeper.autoLaneCountFor(projectId))), cost: perMaterial.cost == null ? null : Math.round(open * perMaterial.cost * 100) / 100 }
        : { materials: chosen.toOrganize, minutes: chosen.minutes, cost: chosen.cost }
      : null,
    options, rates: { basis, msPerChar: 0, costPerChar: null, perMaterial },
    // What history is still not read for meaning, counted from the levels of the history-tier materials whatever the
    // depth (§3.7 stage 5 lists the rest). It used to be 0 by definition once a Full deepening was done.
    historyNotOrganized,
    noteId: null, deepening,
  };
  const running = store.jobs.filter((j) => Boolean(j.step) && ACTIVE_STATUSES.includes(j.status));
  // Every job of a round's step that did not finish, whether the program runs it again, it waits for the owner, or it is
  // listed and the round went on — or closed — without it (Spec §3.10: 列入覆盖情况的失败清单并写明原因，不静默跳过). It
  // leaves the list when a run again finishes it.
  const failed = store.jobs.filter((j) => Boolean(j.step) && (j.status === 'Failed' || j.status === 'Stopped') && store.clerkRounds.has(j.step!.roundId)).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  const previous = store.coverage.scopes.find((s) => s.id === 'project');
  const mainRepo = project.scope.find((i) => i.category === 'Repository' && i.relation !== 'Excluded' && !i.missing);
  // §1.11's four labels: paused holds the rest; what runs is organizing; what waits with nothing running is pending.
  const label: CoverageScope['coverage'] = organizingHeld(project) ? 'Organizing paused' : running.length ? 'Organizing' : pending.length ? 'Changes pending' : 'Up to date';
  // What intake could not take in is carried over; a file too large to read is skipped, not failed (D105) — also one a
  // home written before that still holds among its failures, which moves over here with no step by the owner.
  const intake = splitTooLarge((previous?.failed ?? []).filter((f) => !store.jobs.has(f.ref)), previous?.skipped ?? [], excludedLocations(project));
  const projectScope: CoverageScope = {
    id: 'project', kind: 'project', label: project.name, coverage: label, asOf: rounds.filter((r) => r.endedAt).pop()?.endedAt ?? previous?.asOf ?? null,
    commit: mainRepo ? gitHead(mainRepo.path) : null, pending, organizing: running.map((j) => ({ kind: 'other', ref: j.id, label: j.scope.label, since: j.startedAt ?? j.queuedAt })),
    // A round's step that did not finish, and what intake could not take in with its reason (CKC-07 AC-10): intake
    // writes its own failures, so they are carried over, not wiped by the next pass.
    failed: notStarted ? [] : [...failed.map((j) => ({ ref: j.id, reason: stepFailureText(store, j, organizingHeld(project)), at: j.endedAt ?? j.queuedAt })), ...intake.failed], skipped: notStarted ? [] : intake.skipped, lastRelookAt: previous?.lastRelookAt ?? null,
  };
  const pendingByKind: Record<string, number> = {};
  for (const p of pending) pendingByKind[p.kind] = (pendingByKind[p.kind] ?? 0) + 1;
  store.setCoverage({ ...store.coverage, scopes: [projectScope, ...store.coverage.scopes.filter((s) => s.id !== 'project')], pendingByKind, takeover: status, lastFollowUp: lastFollowUp(store), state: notStarted ? 'Not organized yet' : complete ? 'Takeover complete' : 'Initial model', updatedAt: new Date().toISOString() }, { jobId: null, summary: 'Coverage updated' });
}

/**
 * The last Follow up round that closed, for the top bar (§6.2): whether it found anything new, in one line. When it did
 * not, this is where "the last round found nothing new" is said (CKC-07 AC-27, CKC-24 AC-15); when it did, its item is
 * in `Notes (attention)`. A result closed before rounds counted their news says nothing here.
 */
function lastFollowUp(store: ProjectStore): NonNullable<Coverage['lastFollowUp']> | null {
  const record = store.rounds.filter((r) => r.endedAt !== null && r.result !== null).sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))[0];
  if (!record?.result?.news) return null;
  const news = record.result!.news!;
  const clerk = store.clerkRounds.find((c) => c.followUpRoundId === record.id);
  return { recordId: record.id, round: clerk?.number ?? record.number, endedAt: record.endedAt!, nothingNew: news.nothingNew, statement: news.nothingNew ? 'The last Follow up round found nothing new' : `The last Follow up round: ${news.statement}` };
}
