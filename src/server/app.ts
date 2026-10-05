/**
 * Application wiring: workspace, per-project stores, scope discovery, event fan-out.
 * Keeper runtime, source organizing and the other services attach here in later batches.
 */
import { LedgerService } from '../ledger/adapters.ts';
import { processEngines, processRunner } from '../process/index.ts';
import { codeMapEngines } from '../codemap/engines.ts';
import type { KEngines } from './k-views.ts';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import type { Coverage, OrganizeSchedule, Project, ScopeItem, ScopeQuestion, Source } from '../model/types.ts';
import type { TakeoverDepth } from '../model/vocab.ts';
import { DEPTH_NOTE_ID } from '../keeper/organize/takeover.ts';
import { startRefusal, takeoverState } from '../keeper/organize/takeover-state.ts';
import { scheduleOf } from '../keeper/organize/schedule.ts';
import { lastRoundEnd } from '../keeper/organize/schedule-state.ts';
import { HttpError } from './http.ts';
import { newId } from '../model/ids.ts';
import { decideScope, discoverBase, type DiscoveredItem, type DiscoveryBase } from '../scope/discover.ts';
import { scanSignature } from '../scope/skip.ts';
import { syncAllScopeUsedAs } from '../keeper/scope-tools.ts';
import { anchorLabel, makeFileSource } from '../sources/anchor.ts';
import { ProjectStore } from '../store/project-store.ts';
import { Workspace } from '../store/workspace.ts';
import { projectKeeperHome, projectDir } from '../store/paths.ts';
import { saveVersion, type VersionReason } from '../store/versions.ts';
import { canonicalPath, normalizePath, samePath } from '../util/paths.ts';
import { fullIntake, incrementalIntake, type IntakeResult } from '../intake/intake.ts';
import { applyMaterialRules } from '../intake/material-rules.ts';
import { ScopeWatcher, type PendingChange } from '../sources/watch.ts';
import { KeeperRuntime, type KeeperEvent } from '../keeper/runtime.ts';
import { OrganizingService, writeClerkCoverage } from '../keeper/organize/service.ts';
import { ConversationService } from '../keeper/conversation.ts';

export interface AppEvent {
  readonly type: 'workspace' | 'project' | 'assets' | 'keeper' | 'chat';
  readonly projectId?: string;
  readonly collection?: string;
  readonly ids?: readonly string[];
  readonly data?: unknown;
}

/** The scope items the owner added by hand — not the locations the project was given, which the boundary is drawn from.
 *  An item recorded before locations were kept in the file system's spelling is told by the directory it names. */
export const ownerScopeItems = (project: Project): ScopeItem[] => project.scope.filter((i) => i.addedBy === 'owner' && !project.locations.some((l) => samePath(l, canonicalPath(i.path))));

export class App extends EventEmitter {
  readonly home: string;
  readonly workspace: Workspace;
  private readonly stores = new Map<string, ProjectStore>();
  private readonly watchers = new Map<string, ScopeWatcher>();
  private readonly intakeRunning = new Set<string>();
  /** Called with settled changes; the organizing service (B3) subscribes here. */
  onSettled: ((projectId: string, changes: readonly PendingChange[], result: IntakeResult) => void) | null = null;

  /** The Keeper runtime on pi; `initKeeper()` must run before jobs are queued. */
  readonly keeper: KeeperRuntime;

  constructor(home = projectKeeperHome(), options: { readonly organizing?: boolean } = {}) {
    super();
    // The home in the file system's own spelling, like every project location (util/paths.ts `canonicalPath`).
    this.home = canonicalPath(home);
    this.workspace = Workspace.open(this.home);
    this.workspace.on('change', () => this.emit('event', { type: 'workspace' } satisfies AppEvent));
    this.keeper = new KeeperRuntime(this.workspace, (id) => this.store(id), (id) => this.project(id));
    this.keeper.on('event', (event: KeeperEvent) => {
      this.emit('event', { type: event.kind === 'delta' ? 'chat' : 'keeper', projectId: event.projectId, data: event } satisfies AppEvent);
    });
    this.organizing = new OrganizingService(this, options.organizing ?? true);
    this.organizing.start();
    this.conversation = new ConversationService(this);
    this.conversation.start();
    this.keeper.hooks.requestRelook = (projectId, scope, reason) => { void reason; this.organizing.requestRelook(projectId, { ...scope, label: '' }); };
    // The ledger (§1.16): a round's first step brings it up to date, every step queries it, the writers cite its entries
    // by id, and the views read the versions, the lineage and the coverage from it.
    this.ledger = new LedgerService({ home: this.home });
    this.organizing.setLedgerRunner(this.ledger.runner);
    this.keeper.hooks.ledgerFor = (projectId) => this.ledger.hook(projectId);
    // The process engine (§2.12): a round's process step computes the breakpoints and moves the send-backs on; the
    // process view reads each work item's steps and four things, and a plan's actual shape, from it.
    this.organizing.setProcessRunner(processRunner(this.ledger));
    this.kEngines = { ...this.kEngines, ledger: this.ledger.engines(), process: processEngines(this.ledger), codemap: codeMapEngines(this.ledger) };
    this.onSettled = (projectId, changes, result) => this.organizing.onSettled(projectId, changes, result);
  }

  /** Automatic organizing: plans Keeper jobs from the assets, keeps coverage and the graph current. */
  readonly organizing: OrganizingService;
  /** The ledger and the process engines the increment K views use (k-views.ts); set when the build carries them. */
  kEngines: KEngines = {};
  /** The projects' ledgers (§1.16), one SQLite file per project in its assets. */
  readonly ledger: LedgerService;
  /** The owner's conversation with the Keeper (§6.8). */
  readonly conversation: ConversationService;

  async initKeeper(options: { readonly fakeProvider?: boolean } = {}): Promise<void> {
    await this.keeper.init();
    if (options.fakeProvider) {
      // Dev-only test double (E8): lets the workbench run end to end without a real provider.
      const { startFakeProvider, FAKE_MODEL } = await import('../keeper/fake-provider.ts');
      const fake = await startFakeProvider();
      this.keeper.models.registerProvider('fake', { name: 'Fake provider', baseUrl: fake.url, apiKey: 'fake', api: 'openai-completions', models: [FAKE_MODEL] });
      this.keeper.setModel({ provider: 'fake', id: FAKE_MODEL.id, thinking: null });
      console.warn(`[keeper] using the fake provider at ${fake.url}; answers are canned`);
    }
    this.migrateTakeovers();
    this.organizing.resumeAll();
    this.organizing.watchSchedule();
  }

  /**
   * Bring the projects of a home from before D105 to the two pages (Spec §6.10; plan K CT item 7). A project that has
   * rounds was taken over under the old flow: its depth becomes the depth its rounds actually ran — whatever button was
   * pressed last — its start is the start of its first round, its rhythm becomes a saved-as-default schedule (`Daily`:
   * every day at the time of day its last round ended; `Continuous` stays), and a depth question still standing in
   * `Notes (attention)` is withdrawn, since no note asks for the depth any more. Running it again changes nothing.
   */
  migrateTakeovers(): void {
    for (const p of this.workspace.list()) {
      try {
        const store = this.store(p.id);
        const state = takeoverState(store, p);
        if (state.phase === 'Not started') continue;
        let next: Project = p;
        if ((p.takeoverDepth ?? null) !== state.chosen) next = { ...next, takeoverDepth: state.chosen };
        if (!p.takeoverStartedAt && state.startedAt) next = { ...next, takeoverStartedAt: state.startedAt };
        if (!p.schedule) next = { ...next, schedule: scheduleOf(p, { takeoverDoneAt: state.completedAt, lastRoundEnd: lastRoundEnd(store) }) };
        if (next !== p) this.updateProject(next);
        const note = store.notes.get(DEPTH_NOTE_ID);
        if (note && note.status === 'Current') {
          const now = new Date().toISOString();
          store.notes.put({ ...note, status: 'Withdrawn', withdrawnReason: 'The depth is now chosen on the Takeover page before the takeover starts; no note asks for it.', updatedAt: now }, { jobId: null, summary: 'The depth question is withdrawn: the depth is chosen on the Takeover page before Start' });
        }
      } catch (e) { console.warn(`[takeover ${p.id}] ${(e as Error).message}`); }
    }
  }

  /** Whether the project's material is being read in right now (the planner waits for it after `Start`). */
  intakeBusy(projectId: string): boolean { return this.intakeRunning.has(projectId); }
  private readonly clearing = new Set<string>();
  /** Whether the project is being cleared: nothing is planned or written for it meanwhile. */
  isClearing(projectId: string): boolean { return this.clearing.has(projectId); }

  /**
   * Record that the owner started the takeover at a depth, or — once it is done — chose a deeper one (§3.7; D105). Only
   * the record: `startTakeover` is what the `Start` button does.
   */
  markTakeoverStarted(projectId: string, depth: TakeoverDepth): Project {
    const now = new Date().toISOString();
    const before = this.project(projectId);
    // `Start` is the owner asking for work: a pause left on the project does not hold it.
    if (before.organizingPaused && this.keeper.ready) this.keeper.pauseOrganizing(projectId, false);
    return this.updateProject({ ...before, takeoverDepth: depth, takeoverDepthChosenAt: now, takeoverStartedAt: before.takeoverStartedAt ?? now, organizingPaused: false });
  }

  /**
   * The owner pressed `Start` on the `Takeover` page (§3.7, §6.10; D105; CKC-13 AC-19, AC-23; CKC-04 AC-10). On a project
   * not started: the depth is recorded, the boundary is drawn and the material read, and the takeover runs through — the
   * first usable picture, then the chosen depth, without asking again. On a project whose takeover is done, a deeper
   * depth goes on from what is done. The same depth, a shallower one, or any depth while the takeover is under way is
   * refused, with why: nothing changes. `keyUsable` is whether a model with a usable key is there.
   */
  startTakeover(projectId: string, depth: unknown, keyUsable = true): Project {
    const store = this.store(projectId);
    const state = takeoverState(store, this.project(projectId));
    const refusal = startRefusal(state, depth, keyUsable);
    if (refusal) throw new HttpError(409, refusal);
    const project = this.markTakeoverStarted(projectId, depth as TakeoverDepth);
    if (state.phase === 'Not started') {
      const scoped = this.scopeProject(projectId);
      setImmediate(() => { void this.intakeProject(projectId).catch((e) => console.warn(`[intake ${projectId}] ${(e as Error).message}`)); });
      return scoped;
    }
    void this.organizing.replan(projectId);
    return project;
  }

  /**
   * Clear the project (§3.7 清空, §8.5; D105; CKC-13 AC-40, AC-41): everything the Keeper organized for it goes, and the
   * project is as it was before the takeover — `Not organized yet`, every depth selectable. It takes the word `DELETE`;
   * anything else changes nothing. Work under way is stopped first and waited for. What stays: the project's own files
   * and version control (nothing here writes to them), the ProjectKeeper folder inside the project, the project's name
   * and the locations the owner gave, the settings of the Keeper view (the schedule among them), and what was spent
   * before, kept as one total.
   */
  async clearProject(projectId: string, confirmation: unknown): Promise<{ project: Project; stopped: number; leftBehind: string[] }> {
    if (confirmation !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm. Nothing was changed.');
    const store = this.store(projectId);
    if (takeoverState(store, this.project(projectId)).phase === 'Not started') throw new HttpError(409, 'This project has not been organized: there is nothing to clear.');
    if (this.clearing.has(projectId)) throw new HttpError(409, 'This project is already being cleared.');
    this.clearing.add(projectId);
    try {
      // What takes changes in and what applies decisions to the scope stop first, so nothing new arrives while it clears.
      this.watchers.get(projectId)?.stop();
      this.watchers.delete(projectId);
      const rescope = this.rescopeTimers.get(projectId);
      if (rescope) { clearTimeout(rescope); this.rescopeTimers.delete(projectId); }
      const stopped = this.keeper.ready ? await this.keeper.stopProject(projectId) : 0;
      for (let i = 0; i < 600 && this.intakeRunning.has(projectId); i++) await new Promise((r) => setTimeout(r, 100));
      await this.ledger.idle(projectId);
      const spent = this.keeper.usageSummary(projectId).total;
      const before = this.project(projectId);
      const prior = before.usageBeforeClear ?? null;
      const add = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
      const usageBeforeClear = {
        usage: prior ? { input: prior.usage.input + spent.input, output: prior.usage.output + spent.output, cacheRead: prior.usage.cacheRead + spent.cacheRead, cacheWrite: prior.usage.cacheWrite + spent.cacheWrite, cost: add(prior.usage.cost, spent.cost) } : spent,
        clearedAt: new Date().toISOString(), times: (prior?.times ?? 0) + 1,
      };
      this.ledger.release(projectId);
      const leftBehind = store.clearAll();
      this.keeper.forgetProject(projectId);
      this.scopeBases.delete(projectId);
      // The project's record goes back to what the owner gave: its name, its locations and the items the owner added.
      const { takeoverDepth: _d, takeoverDepthChosenAt: _c, takeoverStartedAt: _s, lastRoundAt: _l, followUpAt: _f, scheduleHandled: _h, toolchain: _t, ...kept } = before;
      const project = this.updateProject({ ...kept, scope: ownerScopeItems(before), scopeQuestions: [], roles: [], lastScopedAt: null, organizingPaused: false, usageBeforeClear });
      this.refreshCoverageAfterIntake(projectId);
      await store.flush();
      return { project, stopped, leftBehind };
    } finally {
      this.clearing.delete(projectId);
    }
  }

  /** §3.8 (D105): the owner saved the schedule on the `Daily` page. Times before the save are not made up for. */
  setSchedule(projectId: string, schedule: OrganizeSchedule): Project {
    const project = this.updateProject({ ...this.project(projectId), schedule, scheduleHandled: null });
    void this.organizing.replan(projectId);
    return project;
  }

  /** Stamp the round the planner just started, without replanning again (§3.2 daily rhythm). */
  setProjectRound(projectId: string, at: string): void {
    this.updateProject({ ...this.project(projectId), lastRoundAt: at });
    this.saveVersion(projectId, 'Organized');   // the end of a round is the other point worth comparing from (D45)
  }

  /** The port the workbench listens on (set by `pk serve`). */
  servedPort: number | null = null;
  /**
   * Where the agent entry has to point (Spec §7.10): `pk` looks for the workbench of the default ProjectKeeper home on
   * that home's port, so a workbench serving another home, or on another port, is named by its port in the usage.
   */
  usageWhere(): { port: number | null } {
    if (!this.servedPort) return { port: null };
    // Another home is always named by its port, so the default home's settings file is not opened for it: this
    // workbench (the demo, say) must not depend on whether that file can be read.
    const usualHome = this.home === projectKeeperHome();
    return { port: !usualHome || this.servedPort !== this.workspace.settings.port ? this.servedPort : null };
  }

  /**
   * The owner pressed Follow up: the next plan opens a round whatever the rhythm says (§3.2). While organizing is
   * paused the round still runs — the owner asked for it — and the pause holds again once it has run out of work
   * (Spec §3.8, §3.10); work the pause was holding is part of this round.
   */
  followUp(projectId: string): Project {
    // Follow up is daily organizing: it waits for the takeover to be done (§6.9; CKC-07 AC-17).
    const phase = takeoverState(this.store(projectId), this.project(projectId)).phase;
    if (phase !== 'Done') throw new HttpError(409, phase === 'Not started' ? 'Start the takeover on the Takeover page first: Follow up organizes what changed after it.' : 'The takeover is still under way: Follow up is available once it is done.');
    const project = this.updateProject({ ...this.project(projectId), followUpAt: new Date().toISOString() });
    if (project.organizingPaused) this.keeper.pauseOrganizing(projectId, false);
    void this.organizing.replan(projectId);
    return project;
  }

  pauseOrganizing(projectId: string, paused: boolean): Project {
    const project = this.updateProject({ ...this.project(projectId), organizingPaused: paused });
    this.keeper.pauseOrganizing(projectId, paused);
    void this.organizing.replan(projectId);
    return project;
  }

  store(projectId: string): ProjectStore {
    let store = this.stores.get(projectId);
    if (!store) {
      if (!this.workspace.get(projectId)) throw new Error(`Unknown project: ${projectId}`);
      store = ProjectStore.open(projectId, this.home);
      store.on('change', (event: { collection: string; ids: readonly string[] }) => {
        this.emit('event', { type: 'assets', projectId, collection: event.collection, ids: event.ids } satisfies AppEvent);
        // The scope is decided again, and then the material rules are applied to the sources already read (§1.1, §1.15).
        if (event.collection === 'rules' || event.collection === 'scopeJudgements') this.scheduleRescope(projectId);
      });
      this.stores.set(projectId, store);
    }
    return store;
  }

  project(projectId: string): Project {
    const project = this.workspace.get(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    return project;
  }

  updateProject(project: Project): Project {
    const saved = this.workspace.update(project);
    this.emit('event', { type: 'project', projectId: project.id } satisfies AppEvent);
    return saved;
  }

  /**
   * Add a project (§3.7 stage 1; D105; CKC-04 AC-10, CKC-13 AC-20). Adding starts nothing: no boundary is drawn, nothing
   * is read, no round runs and no change counts as waiting until the owner chooses a depth and presses `Start`
   * (`startTakeover`). The project opens on the `Takeover` page, `Not organized yet`.
   */
  addProject(name: string, locations: readonly string[]): Project {
    const project = this.workspace.add(name, locations);
    this.store(project.id);
    return project;
  }

  /** Read everything in scope into sources; established parts appear as they are read. The boundary is drawn first when it never was. */
  async intakeProject(projectId: string): Promise<IntakeResult | null> {
    if (this.intakeRunning.has(projectId)) return null;
    this.intakeRunning.add(projectId);
    let result: IntakeResult;
    try {
      if (!this.project(projectId).lastScopedAt) this.scopeProject(projectId);
      const project = this.project(projectId);
      const store = this.store(projectId);
      result = await fullIntake(store, project);
      // What waits is the organizing service's list, written now: intake records only its failures (QC K).
      this.refreshCoverageAfterIntake(projectId);
      await store.flush();
      this.emit('event', { type: 'project', projectId } satisfies AppEvent);
      // A project being cleared is not watched again: what was read is about to go.
      if (this.workspace.settings.watchProjects !== false && !this.clearing.has(projectId)) this.startWatching(projectId);
    } finally {
      this.intakeRunning.delete(projectId);
    }
    // Planned once the reading is over: the planner waits for it after `Start` (clerk.ts `plan`).
    this.organizing.onIntake(projectId);
    return result;
  }

  startWatching(projectId: string): ScopeWatcher {
    const project = this.project(projectId);
    let watcher = this.watchers.get(projectId);
    if (watcher) { watcher.update(project); return watcher; }
    watcher = new ScopeWatcher(project);
    watcher.on('pending', (pending: PendingChange[]) => {
      // Changes are caught without owner action; they show as pending until settled (§3.2).
      const store = this.store(projectId);
      const current = store.coverage;
      const scope = current.scopes.find((s) => s.id === 'project');
      if (!scope) return;
      const known = new Set(scope.pending.map((p) => p.ref));
      const additions = pending.filter((p) => !known.has(p.ref)).map(({ kind, ref, label, since }) => ({ kind, ref, label, since }));
      if (additions.length === 0) return;
      const paused = this.project(projectId).organizingPaused;
      const coverage = paused ? 'Organizing paused' as const : scope.organizing.length ? 'Organizing' as const : 'Changes pending' as const;
      const updated = { ...scope, pending: [...scope.pending, ...additions], coverage };
      store.setCoverage({ ...current, scopes: [updated, ...current.scopes.filter((s) => s.id !== 'project')] });
    });
    watcher.on('settled', (changes: PendingChange[]) => {
      const w = this.watchers.get(projectId);
      if (!w) return;
      w.take(changes);
      const store = this.store(projectId);
      const result = incrementalIntake(store, this.project(projectId), changes);
      this.refreshCoverageAfterIntake(projectId);
      void store.flush();
      this.onSettled?.(projectId, changes, result);
    });
    watcher.on('warning', (message: string) => console.warn(`[watch ${projectId}] ${message}`));
    watcher.start();
    this.watchers.set(projectId, watcher);
    return watcher;
  }

  pendingChanges(projectId: string): PendingChange[] {
    return this.watchers.get(projectId)?.list() ?? [];
  }

  refreshCoverage(projectId: string): void {
    // The coverage the organizing service writes (pending, levels, failures), not intake's count by fact records, which
    // the clerk method's rounds no longer write (QC AY follow-up).
    writeClerkCoverage(this, projectId);
  }

  /**
   * After intake read material: the coverage's list of what waits, the organizing levels and `Update pending` come from the
   * organizing service at once (Spec §1.11, §3.2; CKC-07 AC-1, AC-10), whether or not automatic organizing runs. Intake
   * records only what it could not take in, which this carries over. A failure here never fails the intake.
   */
  private refreshCoverageAfterIntake(projectId: string): void {
    try { this.refreshCoverage(projectId); } catch (e) { console.warn(`[coverage ${projectId}] ${(e as Error).message}`); }
  }

  /** What the last reading of each project's disk and git found; a change in what was decided is applied to it again. */
  private readonly scopeBases = new Map<string, DiscoveryBase>();

  /** Stage 1 of takeover: draw the boundary and record why each item is in or out. */
  scopeProject(projectId: string): Project {
    const project = this.project(projectId);
    const base = discoverBase(project, { existingQuestions: project.scopeQuestions, projectKeeperHome: this.home });
    this.scopeBases.set(projectId, base);
    return this.decideProjectScope(projectId, base, true);
  }

  /**
   * The owner's Rescan (§6.7): read the project from the disk again — the boundary is drawn anew, then what is in it
   * is read, so material added since the last read appears. (Drawing the boundary alone never reads new material.)
   */
  rescanProject(projectId: string): Project {
    const scoped = this.scopeProject(projectId);
    setImmediate(() => { void this.intakeProject(projectId); });
    return scoped;
  }

  /** Apply what the Keeper, the project's rules and the owner decided (§1.1, §1.15, §3.9) to what discovery read. */
  private decideProjectScope(projectId: string, base: DiscoveryBase, drawn: boolean): Project {
    const project = this.project(projectId);
    const store = this.store(projectId);
    const ownerItems = ownerScopeItems(project);
    const result = decideScope(base, {
      existingQuestions: project.scopeQuestions, ownerItems,
      // §1.15, §1.1: the project's rules and the Keeper's classifications shape the listing (CKC-04 AC-1, AC-14, AC-17).
      rules: store.rules.all(), judgements: store.scopeJudgements.all(),
      sourceLabel: (id) => { const s = store.sources.get(id); return s ? anchorLabel(s.anchor) : null; },
    });   // B2 toolchain was read into `base` by discoverBase (with this.home) and is carried through decideScope
    const found: ScopeItem[] = result.items.map((item) => this.materializeItem(store, item));
    // The Keeper's own project folder stays out of the material at every rescope, whatever the scan found (Spec §1.14;
    // QC AW-2): it is the assets written out, never a project document.
    const folders = store.authorizations.filter((a) => !a.revokedAt && a.projectFolder != null).map((a) => ({ id: a.id, path: normalizePath(a.projectFolder!.path) }));
    const scope: ScopeItem[] = [
      ...found.filter((i) => !folders.some((f) => i.path.toLowerCase() === f.path.toLowerCase() && i.relation !== 'Excluded')),
      ...folders.filter((f) => !found.some((i) => i.path.toLowerCase() === f.path.toLowerCase() && i.relation === 'Excluded')).map((f): ScopeItem => ({
        id: newId('scope'), path: f.path, category: 'Directory', relation: 'Excluded',
        reason: `ProjectKeeper's project folder (${f.id}): written from the assets under the owner's authorization, not read as the project's material`,
        reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'unknown',
        missing: existsSync(f.path) ? null : { reason: 'Path does not exist' }, addedBy: 'owner',
      })),
    ];
    syncAllScopeUsedAs(store, scope);   // the documents of third-party material are Reference only (§1.1)
    const keeperFiles = [{ path: projectDir(projectId, this.home), kind: 'ProjectKeeper project assets (outside the project)' }];
    const updated: Project = {
      ...project, scope, scopeQuestions: result.questions, keeperFiles, toolchain: result.toolchain, roles: result.roles,
      language: result.language, lastScopedAt: drawn ? new Date().toISOString() : project.lastScopedAt,
    };
    const coverage: Coverage = {
      ...store.coverage,
      missingSourceKinds: result.missingSourceKinds,
      scopes: store.coverage.scopes.length > 0 ? store.coverage.scopes : [{
        id: 'project', kind: 'project', label: project.name, coverage: 'Changes pending', asOf: null, commit: null,
        pending: [], organizing: [], failed: [], lastRelookAt: null,
      }],
    };
    store.setCoverage(coverage, { jobId: null, summary: 'Scope discovered' });
    this.updateProject(updated);
    // Then the project's material rules, on what is read already (§1.15; CKC-04 AC-14): after the scope, so a source in
    // a location the decision just changed is judged against the scope as it now is. What the scope newly reads is read
    // by the intake that follows, and intake applies them to it as well; no reading happens here.
    try { if (applyMaterialRules(store, updated) > 0) this.refreshCoverage(projectId); } catch (e) { console.warn(`[rules ${projectId}] ${(e as Error).message}`); }
    return updated;
  }

  private materializeItem(store: ProjectStore, item: DiscoveredItem): ScopeItem {
    const { reasonRef, sessions: _sessions, ...rest } = item;
    if (!reasonRef) return rest;
    const source = this.reasonSource(store, item, reasonRef);
    return { ...rest, reasonSourceIds: [...new Set([...rest.reasonSourceIds, source.id])] };   // a rule's source first, then the folder's own file
  }

  /**
   * Apply what was decided to the scope again — a rule written, a classification recorded, a question answered — from
   * what discovery last read (or read it now when there is nothing in memory); when what is read from where changed,
   * read the project again (Spec §1.1).
   */
  rescope(projectId: string): Project {
    // Before `Start` no boundary is drawn (D105): there is nothing to apply a decision to yet.
    if (!this.project(projectId).lastScopedAt) return this.project(projectId);
    const before = scanSignature(this.project(projectId).scope);
    const base = this.scopeBases.get(projectId);
    const after = base ? this.decideProjectScope(projectId, base, false) : this.scopeProject(projectId);
    if (scanSignature(after.scope) !== before) setImmediate(() => { void this.intakeProject(projectId); });
    return after;
  }

  private readonly rescopeTimers = new Map<string, NodeJS.Timeout>();
  /** The project's rules and the Keeper's classifications shape the listing: once their writes settle, apply them again. */
  private scheduleRescope(projectId: string): void {
    if (this.clearing.has(projectId)) return;
    const pending = this.rescopeTimers.get(projectId);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.rescopeTimers.delete(projectId);
      try { this.rescope(projectId); } catch (error) { console.warn(`[scope ${projectId}] ${(error as Error).message}`); }
    }, 1500);
    timer.unref?.();
    this.rescopeTimers.set(projectId, timer);
  }

  private reasonSource(store: ProjectStore, item: DiscoveredItem, ref: NonNullable<DiscoveredItem['reasonRef']>): Source {
    let fileText = '';
    try { fileText = readFileSync(ref.path, 'utf8'); } catch { fileText = ref.excerpt; }
    const source = makeFileSource({
      projectId: store.projectId, path: ref.path, headingPath: ref.headingPath, lineStart: ref.lineStart,
      lineEnd: ref.lineEnd, excerpt: ref.excerpt, fileText, scopeItemId: item.id,
    });
    const existing = store.sources.get(source.id);
    if (existing && existing.version.fingerprint === source.version.fingerprint && existing.excerpt === source.excerpt) return existing;   // read already, unchanged
    const merged: Source = existing ? { ...source, usedAs: existing.usedAs, usedAsBy: existing.usedAsBy } : source;
    store.sources.put(merged, { jobId: null, summary: `Scope reason read from ${ref.path}` });
    return merged;
  }

  addScopeItem(projectId: string, input: { path: string; category: ScopeItem['category']; relation: ScopeItem['relation']; reason: string }): Project {
    const project = this.project(projectId);
    const path = canonicalPath(input.path);   // a path the owner typed: kept in the file system's spelling, like a location
    const item: ScopeItem = {
      id: newId('scope'), path, category: input.category, relation: input.relation, reason: input.reason,
      reasonSourceIds: [], sessionHost: null, readOnly: input.relation === 'Session source', copyOf: null, worktreeOf: null,
      versionControl: existsSync(path) ? 'unknown' : 'unknown', missing: existsSync(path) ? null : { reason: 'Path does not exist' },
      addedBy: 'owner',
    };
    return this.updateProject({ ...project, scope: [...project.scope.filter((i) => i.path !== path || i.category !== item.category), item] });
  }

  removeScopeItem(projectId: string, itemId: string): Project {
    const project = this.project(projectId);
    const item = project.scope.find((i) => i.id === itemId);
    if (!item) throw new Error(`Unknown scope item: ${itemId}`);
    // Removing a Keeper-discovered item records it as an owner exclusion so a rescan honours it.
    const scope = item.addedBy === 'owner'
      ? project.scope.filter((i) => i.id !== itemId)
      : project.scope.map((i) => i.id === itemId ? { ...i, relation: 'Excluded' as const, reason: `Excluded by the owner (was: ${i.reason})`, addedBy: 'owner' as const } : i);
    return this.updateProject({ ...project, scope });
  }

  answerScopeQuestion(projectId: string, questionId: string, answer: string): Project {
    const project = this.project(projectId);
    const questions: ScopeQuestion[] = project.scopeQuestions.map((q) => q.id === questionId
      ? { ...q, answer: { text: answer, at: new Date().toISOString(), sourceId: null } } : q);
    const updated = this.updateProject({ ...project, scopeQuestions: questions });
    // A copy whose source the owner named: treat the answer as the copy's origin and rescan.
    const q = questions.find((x) => x.id === questionId);
    if (q && /copy/i.test(q.question) && /^[A-Za-z]:\\|^\//.test(answer.trim())) {
      const scope = updated.scope.map((i) => i.relation === 'Copy of another project' && !i.copyOf
        ? { ...i, copyOf: canonicalPath(answer.trim()), addedBy: 'owner' as const, reason: `${i.reason}; the owner named the source: ${answer.trim()}` } : i);
      this.updateProject({ ...updated, scope });
      return this.scopeProject(projectId);
    }
    // Any other answer shapes the listing too (ignored documents taken in, a Keeper's question settled; §1.1, §3.9).
    return q ? this.rescope(projectId) : updated;
  }

  /** The owner's response on a note (§2.7, §4.4). Decided and Delegated go through the conversation; this records the response itself. */
  respondToNote(projectId: string, noteId: string, response: 'Discussed' | 'Decided' | 'Delegated' | 'No action needed'): void {
    const store = this.store(projectId);
    const note = store.notes.get(noteId);
    if (!note) throw new Error(`Unknown note: ${noteId}`);
    store.notes.put({ ...note, ownerResponse: response, updatedAt: new Date().toISOString() }, { jobId: null, summary: `Owner response: ${response}` });
  }

  /** Revoke a standing authorization (§1.14): nothing runs on it afterwards; work running under it stops and reports. */
  revokeAuthorization(projectId: string, authorizationId: string): { stoppedJobs: string[] } {
    const store = this.store(projectId);
    const a = store.authorizations.get(authorizationId);
    if (!a) throw new Error(`Unknown authorization: ${authorizationId}`);
    store.authorizations.put({ ...a, revokedAt: new Date().toISOString() }, { jobId: null, summary: 'Standing authorization revoked by the owner' });
    const stopped: string[] = [];
    for (const job of store.jobs.filter((j) => j.status === 'Running' && j.requestBasis?.kind === 'authorization' && j.requestBasis.ref === authorizationId)) {
      if (this.keeper.stopJob(projectId, job.id)) stopped.push(job.id);
    }
    return { stoppedJobs: stopped };
  }

  markOpened(projectId: string): { previous: string | null } {
    const project = this.project(projectId);
    const previous = project.lastOpenedAt;
    this.updateProject({ ...project, lastOpenedAt: new Date().toISOString() });
    this.workspace.setLastProject(projectId);
    // Two points in time can only be compared if both were kept, and "since I last opened it" is the comparison the
    // owner asks for most (D45), so the picture is saved on the way in as well as when a round of organizing ends.
    this.saveVersion(projectId, 'Opened');
    return { previous };
  }

  /** Keep the current picture as a version to compare against later (§6.3, D45). Never fails a caller. */
  saveVersion(projectId: string, reason: VersionReason): void {
    try { saveVersion(projectDir(projectId, this.home), this.store(projectId), reason); }
    catch (e) { console.warn(`[versions ${projectId}] ${(e as Error).message}`); }
  }

  async flushAll(): Promise<void> {
    for (const store of this.stores.values()) await store.flush();
  }

  stopAll(): void {
    this.organizing.stopWatchingSchedule();
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
    this.ledger.release();
  }
}
