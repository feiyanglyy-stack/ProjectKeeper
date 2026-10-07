/**
 * Keeper runtime on pi (CKC-03, Spec §1.13, §3.10, §6.9, §8).
 *
 * One `KeeperRuntime` per process. Each cognitive job runs in its own pi session created with
 * the project directory as cwd, so global skills, extensions, prompt templates and the
 * project's instruction files load exactly as when the owner runs pi there (§8.2). The job's
 * input is what its prompt gives it; nothing is forked from another job's session (§3.4). A job whose run was
 * interrupted — a rate limit or quota from the provider, a restart of ProjectKeeper — goes on in its own session on
 * whichever key it is given next, so what it had read and reasoned is not lost (§3.10, D99; `openSavedSession`).
 *
 * Owner-initiated work and automatic organizing run in separate lanes so an owner request
 * never waits behind backlog (§3.2). Pausing stops only automatic work.
 */
import { guardTurn, keeperBuiltinTools, RefusalStreak, REPEATED_REFUSAL_LIMIT, StepTimer, type RepeatedRefusal } from './step-timing.ts';
import { EventEmitter } from 'node:events';
import { organizingHeld } from './held.ts';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  buildSessionProjection, calculateContextTokens, createAgentSession, DefaultResourceLoader, estimateTokens, getLatestCompactionEntry,
  ModelRuntime, parseSessionEntries, ProjectTrustStore, SessionManager, SettingsManager, getAgentDir,
  type AgentSession, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { estimateContextTokens } from '@earendil-works/pi-agent-core';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import type { JobKind, JobStatus, KeeperStatus } from '../model/vocab.ts';
import type { KeeperJob, Project, Usage } from '../model/types.ts';
import type { ClerkStage, StepTiming } from '../model/k-types.ts';
import { newId } from '../model/ids.ts';
import type { ProjectStore } from '../store/project-store.ts';
import type { Workspace } from '../store/workspace.ts';
import { keeperTools, type ToolContext } from './tools.ts';
import { roundTools } from './round-tools.ts';
import { isReplacedRound, jobRole, stepToolsFor, toolsFor } from './roles.ts';
import { clerkTools } from './clerk-tools.ts';
import { OwnKeyStore, publicKey, type OwnKey, type PublicOwnKey } from './own-keys.ts';
import { checkKey, QUOTA_REPORTERS, type KeyCheck } from './key-check.ts';
import { keysForJob, modelOnKey, onPin, ROUTE_STEPS as ROUTE_STEP_KINDS, routeKeys, routeOf, wantOf, type ProjectRoute, type Route, type RouteKey, type StepRoute, type Want } from './route.ts';
import { THINKING_LEVELS } from './clerk-steps.ts';
import type { RouteModel } from '../model/types.ts';
type RouteModelInput = { readonly provider: string; readonly id: string; readonly thinking?: string | null };
type StepRouteInput = { readonly provider?: string; readonly model?: string; readonly thinking?: string };
import { stageTools } from './organize/stage-tools.ts';
import { laneTools, type LaneRunner } from './organize/lane-tools.ts';
import { writeRefusal } from './organize/stage-gate.ts';
import { clerkSkillPathsFor } from './organize/skills.ts';
import { ledgerTools } from './ledger-tools.ts';
import { coverageTools } from './organize/coverage-tools.ts';
import { ownerLineTools } from './organize/owner-lines.ts';
import { entryGateTools } from './organize/entry-gate.ts';
import { placeTools } from './organize/place-tools.ts';
import type { LedgerHook } from './evidence.ts';
import { keeperPreamble } from './prompts.ts';
import { PI_CAPABILITIES } from './capabilities.ts';
import { createReadBoundary, type ReadBoundary } from './bounds/boundary.ts';
import { READING_TOOLS, stepReads } from './bounds/reads.ts';
import { isAbsolute } from 'node:path';
import { gitStatusAsync } from '../util/git.ts';
import { keeperPathLimit } from '../util/paths.ts';
import { linkPutOutDeliveries } from '../process/delivery-links.ts';
import { unlightUnchecked } from '../process/breakpoint-candidates.ts';

export interface JobRequest {
  readonly kind: JobKind;
  readonly initiator: 'auto' | 'owner';
  readonly scope: { readonly kind: string; readonly ids: readonly string[]; readonly label: string };
  /** The full task prompt (after the preamble). */
  readonly prompt: string;
  readonly priority?: number;
  readonly requestBasis?: KeeperJob['requestBasis'];
  readonly parentJobId?: string | null;
  /** A subagent of a job that is already running: it starts even while automatic organizing is held, because its
   *  parent is mid-flight and waiting for it. Pausing holds what has not started; `Stop` is what ends a running tree. */
  readonly bypassHold?: boolean;
  /** Stream assistant text to listeners (chat). */
  readonly stream?: boolean;
  readonly timeoutMs?: number | null;
  /** Extra tools (e.g. chat-specific) besides the pk_* set. */
  readonly extraTools?: readonly ToolDefinition[];
  readonly task?: unknown;
  /** Materials a material-organizing job covers (fact record ids and coverage follow them). */
  readonly materials?: readonly { readonly key: string; readonly sourceIds: readonly string[] }[];
  /** Judgement record of a product re-look. */
  readonly judgementId?: string | null;
  /** A conversation: turns with the same key share one live pi session (§6.8). */
  readonly sessionKey?: string | null;
  /** Source id of the owner's message that starts this turn. */
  readonly ownerSourceId?: string | null;
  readonly conversation?: boolean;
  /** The step of a clerk-method round this job is (Spec §3.3): it decides the job's tools and its model settings. */
  readonly step?: KeeperJob['step'];
}

/** A job the program does itself (a round's ledger step, a skipped step, a round's root): never queued for a model. */
export interface ProgramJobRequest {
  readonly kind: JobKind;
  readonly scope: { readonly kind: string; readonly ids: readonly string[]; readonly label: string };
  readonly step: KeeperJob['step'];
  readonly parentJobId: string | null;
  readonly task: unknown;
}

export interface KeeperEvent {
  readonly projectId: string;
  readonly jobId: string;
  readonly kind: 'job' | 'delta' | 'step' | 'done' | 'status';
  readonly data?: unknown;
}

export interface ChatTelemetry {
  readonly model: { readonly provider: string; readonly id: string; readonly name: string } | null;
  readonly context: {
    readonly usedTokens: number | null;
    readonly limitTokens: number | null;
    readonly percent: number | null;
    /** True only when messages after the provider's last exact usage had to be estimated. */
    readonly estimated: boolean;
    readonly source: 'live' | 'saved' | 'unavailable';
  };
}

export interface SavedChatSession {
  readonly sessionFile: string | null;
  /** The leaf recorded for the selected conversation turn, so an abandoned branch is never counted. */
  readonly leafId?: string | null;
  /** The model recorded on the job is a fallback only when the session itself cannot name one. */
  readonly model: { readonly provider: string; readonly id: string } | null;
}

/** A backup provider in use because the chosen one reported its quota exhausted (§6.9: visible, never silent). */
export interface ProviderFallback {
  readonly provider: string;
  readonly id: string;
  readonly from: { provider: string; id: string };
  readonly reason: string;
  readonly since: string;
  readonly until: string;      // when the chosen provider is tried again
}

export interface ProviderState {
  readonly connected: boolean;
  readonly reason: string | null;
  readonly model: { provider: string; id: string; thinking: string | null } | null;
  readonly available: { provider: string; id: string; name: string }[];
  readonly backups: readonly { provider: string; id: string }[];
  readonly fallback: ProviderFallback | null;
  readonly switches: readonly { at: string; from: string; to: string; reason: string; until: string }[];
}

/** The reset time a quota error names, when it names one. Z.ai and Zhipu report Beijing time, in English ("… will reset
 *  at 2026-09-18 17:08:09") or in Chinese ("… 将在 2026-09-18 17:08:09 重置"). */
export function quotaResetFrom(message: string, provider: string): string | null {
  const m = /(?:reset(?:s)?\s+at|将在)\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/i.exec(message);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}${/^zai/.test(provider) ? '+08:00' : ''}`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** `parked`: how many subagents the job in this lane is waiting for. While any is out the lane does not count against
 *  the key's capacity — otherwise a main job with several subagents would hold a lane doing nothing, and a round whose
 *  subagents outnumber the lanes could wait on itself (D59 design 1). It is a count because a main job sends several
 *  at once (pi runs the tool calls of one turn in parallel): with a yes/no flag the first subagent to answer put the
 *  lane back in the count while the job was still waiting for the others. */
interface Lane { running: KeeperJob | null; session: AgentSession | null; abort: (() => void) | null; provider: string | null; parked?: number;
  /** Stop the running job to go on when organizing resumes (D99, E148 D-i): it ends `Paused`, marked to continue its session. */
  pause?: (() => void) | null;
  /** The name of the key the owner removed while this lane's job ran on it: the job goes on on the next key (§6.10). */
  keyRemoved?: string | null }
const parkedLane = (l: Lane): boolean => (l.parked ?? 0) > 0;
const newLane = (): Lane => ({ running: null, session: null, abort: null, provider: null, parked: 0, pause: null, keyRemoved: null });

/** One key as `Keeper` → `Model provider` lists it (§6.10; CKC-03 AC-33, AC-34). Never its value. */
export interface KeyView {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly providerName: string;
  /** Where it comes from: saved in ProjectKeeper, an environment variable, pi's own login, the settings' extra keys. */
  readonly from: 'ProjectKeeper' | 'Environment' | 'pi login' | 'Settings' | 'Outside ProjectKeeper';
  readonly fromDetail: string;
  /** The full mask, for a key saved here; null for one configured outside. */
  readonly mask: string | null;
  readonly removable: boolean;
  readonly addedAt: string | null;
  readonly replacedAt: string | null;
  readonly state: { readonly status: KeyCheck['status'] | 'No credentials'; readonly reason: string | null; readonly until: string | null; readonly checkedAt: string | null; readonly how: string | null; readonly quota: string | null; readonly quotaReported: boolean };
  /** Jobs it carries now, across projects. */
  readonly running: number;
  /** Automatic jobs it may run at once; `ownLanes` when set for this key alone. */
  readonly lanes: number;
  readonly ownLanes: boolean;
  readonly models: readonly { readonly id: string; readonly priced: boolean }[];
}
/** The lanes of one project: the owner's own lane, the lanes of automatic work, and the lanes of subagents that owner
 *  work sent — the owner's lane is held by the job waiting for them, so they cannot run in it (batch C1, item 6). */
interface ProjectLanes { owner: Lane; auto: Lane[]; delegated: Lane[] }

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null });
const costSum = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
/** A job's usage after a run that went on from `prior`: what the run's session spent since `baseline`, added to it. */
function usageAfter(prior: Usage, now: Usage, baseline: Usage): Usage {
  const d = (k: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => prior[k] + Math.max(0, now[k] - baseline[k]);
  const cost = now.cost === null ? prior.cost : costSum(prior.cost, Math.max(0, now.cost - (baseline.cost ?? 0)));
  return { input: d('input'), output: d('output'), cacheRead: d('cacheRead'), cacheWrite: d('cacheWrite'), cost };
}
function timingSum(a: StepTiming, b: StepTiming): StepTiming {
  return { wallMs: a.wallMs + b.wallMs, generationMs: a.generationMs + b.generationMs, toolMs: a.toolMs + b.toolMs, queueMs: a.queueMs + b.queueMs, parseRetryMs: a.parseRetryMs + b.parseRetryMs, otherMs: a.otherMs + b.otherMs };
}

/**
 * The message an interrupted job's own session is continued with, in place of its task (D99): the task, the preamble and
 * everything the job read and reasoned are in the session already.
 */
export function continuationMessage(why: NonNullable<KeeperJob['resume']>['why'], model: { provider: string; id: string }, note: string | null = null): string {
  const cause = why === 'provider'
    ? 'The model provider interrupted this work (a rate limit or an exhausted quota).'
    : why === 'restart'
      ? 'ProjectKeeper restarted while this work was running. A tool call that was running then may show no result: check what it did before doing it again.'
      : why === 'pause'
        ? 'The owner paused organizing while this work was running, and has resumed it. A tool call that was running then may show no result: check what it did before doing it again.'
        : 'This work ended before its task was done, and the program runs it again.';
  return `${cause} It goes on now in this same session, on ${model.provider}/${model.id}. Continue where you left off: what you wrote with the tools is saved, and your task is above.${note ? `\n\n${note}` : ''}`;
}

/** Whether a job's interrupted run can go on in its own session: a model's job with a saved session, and not a
 *  conversation turn, which keeps its live session by key (§6.8). */
function continuable(job: KeeperJob): boolean {
  return job.agent !== 'program' && !!job.sessionFile && !((job.task as { sessionKey?: string | null } | null)?.sessionKey);
}

/**
 * Open an interrupted job's saved pi session to continue it, or say why it cannot be: its file is gone, cannot be read as
 * a pi session, or holds none of the job's work. Never creates or repairs anything for a file it cannot use. `model` is
 * the model the session last recorded, so a continuation on another key records the change.
 */
export function openSavedSession(sessionFile: string, cwd: string): { manager: SessionManager; model: { provider: string; modelId: string } | null } | { reason: string } {
  if (!existsSync(sessionFile)) return { reason: `its saved session ${sessionFile} is gone` };
  let manager: SessionManager;
  try { manager = SessionManager.open(sessionFile, undefined, cwd); } catch (e) { return { reason: `its saved session ${sessionFile} cannot be read (${(e as Error).message})` }; }
  let context: ReturnType<SessionManager['buildSessionContext']>;
  try { context = manager.buildSessionContext(); } catch (e) { return { reason: `its saved session ${sessionFile} cannot be read (${(e as Error).message})` }; }
  if (!context.messages.some((m) => m.role === 'user')) return { reason: `its saved session ${sessionFile} holds none of its work` };
  return { manager, model: context.model };
}

export type ErrorKind = 'quota' | 'ratelimit' | 'unavailable' | 'error';
export function classifyError(message: string): ErrorKind {
  // Z.ai and Zhipu send every limit as HTTP 429 and tell them apart by code. 1302, 1303 and 1305 are per-request rate
  // limits: the key rests RATE_LIMIT_REST_MS and the other keys take the work. 1304 (daily), 1308 (the Coding Plan's five-hour window), 1309 (plan expired)
  // and 1310 (weekly or monthly) take the key out of use until the time the message names.
  const code = /"code"\s*:\s*"?(\d{4})\b/.exec(message)?.[1];
  if (code === '1302' || code === '1303' || code === '1305') return 'ratelimit';
  if (code === '1304' || code === '1308' || code === '1309' || code === '1310') return 'quota';
  if (/quota|exhausted|insufficient|credit|limit exhausted|usage limit|使用上限/i.test(message)) return 'quota';
  // A per-request rate limit (HTTP 429 "too many requests"): back off, do not change provider.
  if (/rate.?limit|too many requests|429/i.test(message)) return 'ratelimit';
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network|5\d\d|overloaded|unavailable|timeout/i.test(message)) return 'unavailable';
  return 'error';
}

/** An assistant message as pi's events carry it, as far as the runtime reads it. */
type Reply = { readonly content?: readonly { readonly type: string; readonly text?: string }[]; readonly errorMessage?: string; readonly stopReason?: string; readonly timestamp?: number };

/** What a job records when it ends because the same call kept being refused (CKC-03 AC-30): which tool, what error,
 *  in how many turns, and how many other calls came back refused with it — the steps themselves are in its activity. */
export function repeatedRefusalError(r: RepeatedRefusal): string {
  const error = r.error.length > 300 ? `${r.error.slice(0, 300)}…` : r.error;
  const alongside = r.alongside ? ` (${r.alongside} more refused call${r.alongside === 1 ? ' was' : 's were'} re-sent with it)` : '';
  return `Ended after the model sent the same call to ${r.tool} in ${r.turns} turns in a row, refused the same way each time with nothing else run in those turns${alongside} — the limit is ${REPEATED_REFUSAL_LIMIT} turns — instead of letting it loop until the step's time limit. The refusal: ${error}`;
}

/**
 * The order queued jobs start in: priority first, then who has waited longest. A job moves up one step for every ten
 * minutes it has waited, so lower-priority work is not starved while higher-priority work keeps arriving — seen on
 * 2026-09-18, when every edit to a plan document queued a framing job ahead of the change follow-up and the follow-up
 * waited twenty minutes without a lane. Owner work has its own lane, so this only orders automatic work among itself.
 */
export const AGING_STEP_MS = 10 * 60_000;
export function queueOrder<T extends { readonly priority: number; readonly queuedAt: string }>(jobs: readonly T[], now: number): T[] {
  const effective = (j: T) => j.priority - Math.floor(Math.max(0, now - Date.parse(j.queuedAt)) / AGING_STEP_MS);
  return [...jobs].sort((a, b) => effective(a) - effective(b) || a.queuedAt.localeCompare(b.queuedAt));
}

/** How long a key that answered a rate limit (429) rests before it is tried again (owner 2026-09-28: 「限流了过10分钟再试一下」). */
export const RATE_LIMIT_REST_MS = 10 * 60_000;

/**
 * Rounds of the material method (D59) are not run any more: the clerk method replaced them (Spec v3.0 §3.3), and their
 * prompts name tools that no longer exist. A home a build before increment K left with such a round waiting — queued,
 * paused or waiting for quota — has it stopped at start, with the reason, instead of running it. Returns how many.
 */
/**
 * Work a previous process left waiting for quota was to be queued again by a quota or rate-limit timer, and those timers
 * did not outlive that process: at start it is queued now. If the quota is still out, it waits again with a new timer
 * (Spec §3.10: after a restart, automatic work goes on from its saved progress). Returns how many.
 */
export function requeueWaitingForQuota(store: ProjectStore): number {
  const waiting = store.jobs.filter((j) => j.status === 'Waiting for quota' && j.agent !== 'program' && !isReplacedRound(j));
  for (const job of waiting) store.jobs.put({ ...job, status: 'Queued', error: null }, { jobId: job.id, summary: 'Queued again: ProjectKeeper restarted while it waited for quota' });
  return waiting.length;
}

/**
 * Work that finished carries no error. A run used not to clear the answer of the run before it (a rate limit or a quota
 * answer that sent the job back to the queue), so work that then finished still showed that answer; at start it is
 * cleared. Returns how many.
 */
export function clearErrorsOfFinishedWork(store: ProjectStore): number {
  const stale = store.jobs.filter((j) => j.status === 'Done' && !!j.error);
  for (const job of stale) store.jobs.put({ ...job, error: null }, { jobId: job.id, summary: 'Cleared an error left from an earlier run of this finished work' });
  return stale.length;
}

export function stopReplacedRounds(store: ProjectStore, at = new Date().toISOString()): number {
  const waiting = store.jobs.filter((j) => (j.status === 'Queued' || j.status === 'Paused' || j.status === 'Waiting for quota') && isReplacedRound(j));
  for (const job of waiting) {
    store.jobs.put({ ...job, status: 'Stopped', endedAt: at, error: 'A round of the material method, which the clerk method replaced; not run' }, { jobId: job.id, summary: 'Replaced round not run' });
  }
  return waiting.length;
}

export class KeeperRuntime extends EventEmitter {
  private modelRuntime: ModelRuntime | null = null;
  private readonly lanes = new Map<string, ProjectLanes>();
  /** Automatic organizing runs this many jobs at once (each its own pi session). Material batches are independent,
   *  so the useful maximum is the number of batches; the setting changes without a restart (§3.10: visible, adjustable). */
  /** Automatic jobs per key (trial setting, owner 2026-09-17: one key, five lanes). */
  get lanesPerKey(): number {
    const n = this.workspace.settings.organizingLanesPerKey ?? Number(process.env.PK_LANES_PER_KEY ?? 3);
    return Math.min(32, Math.max(1, Math.floor(Number(n) || 3)));
  }
  /** Automatic jobs at once on one key: its own setting, else the setting for every key (§6.10 每把 key 同时跑几路). */
  lanesFor(provider: string): number {
    const own = this.workspace.settings.keyLanes?.[provider];
    return own === undefined ? this.lanesPerKey : Math.min(32, Math.max(1, Math.floor(Number(own) || 1)));
  }
  /** The route a project runs on (route.ts): its own, or the machine's settings. Without a project, the machine's. */
  routeFor(projectId: string | null = null): Route {
    let project = null;
    if (projectId) { try { project = this.projectOf(projectId); } catch { project = null; } }
    return routeOf(project, this.workspace.settings, this.piDefault());
  }
  private hasModel = (key: string, model: string): boolean => { try { return Boolean(this.models.getModel(key, model)); } catch { return false; } };
  /** The keys automatic work of a project is spread over, in its route's order (route.ts `routeKeys`), one entry per key. */
  private keyChoices(projectId: string | null = null): RouteKey[] {
    return routeKeys(this.routeFor(projectId), [...this.credentialed], this.hasModel);
  }
  private keyUsable(provider: string): boolean { return this.credentialed.has(provider) && !this.exhausted(provider); }
  private keyCapacity(provider: string): number { return this.keyUsable(provider) && !this.resting(provider) ? this.lanesFor(provider) : 0; }
  /** A key that answered a rate limit rests until its time is up; its lanes take no new work meanwhile. */
  private resting(provider: string): boolean { return (this.restingUntil.get(provider) ?? 0) > Date.now(); }
  /** Total automatic lanes across the usable keys of a project's route; the planner fills this many. */
  autoLaneCountFor(projectId: string | null = null): number { return Math.max(1, this.keyChoices(projectId).reduce((n, k) => n + this.keyCapacity(k.provider), 0)); }
  get autoLaneCount(): number { return this.autoLaneCountFor(null); }
  /** How many automatic jobs each key carries now, across projects. */
  private runningByKey(): Map<string, number> {
    const running = new Map<string, number>();
    for (const l of this.lanes.values()) for (const lane of [...l.auto, l.owner, ...l.delegated]) if (lane.running && lane.provider && !parkedLane(lane)) running.set(lane.provider, (running.get(lane.provider) ?? 0) + 1);
    return running;
  }
  laneState(projectId: string | null = null): { lanesPerKey: number; total: number; keys: { provider: string; id: string; lanes: number; capacity: number; running: number; rateLimitedAt: string | null; exhaustedUntil: string | null; credentials: boolean }[] } {
    const running = this.runningByKey();
    const keys = this.keyChoices(projectId).map((k) => ({ provider: k.provider, id: k.id, lanes: this.lanesFor(k.provider), capacity: this.keyCapacity(k.provider), running: running.get(k.provider) ?? 0, rateLimitedAt: this.resting(k.provider) ? new Date(this.lastRateLimitAt.get(k.provider) ?? 0).toISOString() : null, exhaustedUntil: this.exhausted(k.provider) ? this.quotaExhausted.get(k.provider)!.until : null, credentials: this.credentialed.has(k.provider) }));
    return { lanesPerKey: this.lanesPerKey, total: this.autoLaneCountFor(projectId), keys };
  }
  setLanesPerKey(n: number): number {
    this.workspace.setSettings({ organizingLanesPerKey: Math.min(32, Math.max(1, Math.floor(n))) });
    for (const p of this.workspace.list()) setImmediate(() => this.pump(p.id));
    return this.lanesPerKey;
  }
  /** One key's own number of jobs at once; `null` gives it back to the setting for every key. */
  setKeyLanes(provider: string, n: number | null): number {
    const next: Record<string, number> = { ...(this.workspace.settings.keyLanes ?? {}) };
    if (n === null) delete next[provider]; else next[provider] = Math.min(32, Math.max(1, Math.floor(n)));
    this.workspace.setSettings({ keyLanes: next });
    for (const p of this.workspace.list()) setImmediate(() => this.pump(p.id));
    return this.lanesFor(provider);
  }
  private readonly resourceChanges = new Map<string, { at: string; jobId: string; detail: string }[]>();
  private readonly lastError = new Map<string, { at: string; message: string; kind: ErrorKind }>();
  /** Rate-limit rest: until when each key that answered 429 is left alone (§6.9: visible in the lane state, never silent). */
  private readonly restingUntil = new Map<string, number>();
  private readonly lastRateLimitAt = new Map<string, number>();
  /** Providers with credentials, refreshed by providerState(); the synchronous pump reads it. */
  private credentialed = new Set<string>();
  /** The model providerState() resolved last (the chosen one, a stand-in, or the first available); automatic work uses it when no configured key is usable. */
  private resolvedModel: { provider: string; id: string; thinking: string | null } | null = null;
  private restWakeTimer: NodeJS.Timeout | null = null;
  private fallback: ProviderFallback | null = null;
  private readonly quotaExhausted = new Map<string, { until: string; message: string }>();
  private readonly providerSwitches: { at: string; from: string; to: string; reason: string; until: string }[] = [];
  private readonly quotaRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly workspace: Workspace;
  private readonly storeOf: (projectId: string) => ProjectStore;
  private readonly projectOf: (projectId: string) => Project;

  /** The owner's own keys (own-keys.ts): kept in ProjectKeeper's home, each run under a provider id of its own. */
  readonly ownKeys: OwnKeyStore;
  /** The last check of each key (key-check.ts), by the provider id it runs under. In memory: a restart checks again on `Check`. */
  private readonly keyChecks = new Map<string, KeyCheck>();

  constructor(workspace: Workspace, storeOf: (id: string) => ProjectStore, projectOf: (id: string) => Project) {
    super();
    // Every lane the main agent sends is waited for by a listener of its own (D99: five or more at once).
    this.setMaxListeners(0);
    this.workspace = workspace;
    this.storeOf = storeOf;
    this.projectOf = projectOf;
    this.ownKeys = new OwnKeyStore(workspace.home);
  }

  async init(): Promise<void> {
    this.modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    this.registerExtraKeys();
    for (const k of this.ownKeys.list()) await this.registerOwnKey(k);
    await this.providerState().catch(() => undefined);
    // Jobs left Running by a previous process are not running now; jobs it left Queued still carry
    // their prompt, so they start here — otherwise the planner waits forever on a job nobody runs.
    // A model's job that is queued again later goes on in its own session (D99); a conversation keeps its own.
    for (const p of this.workspace.list()) {
      const store = this.storeOf(p.id);
      for (const job of store.jobs.filter((j) => j.status === 'Running')) {
        const at = new Date().toISOString();
        const resume = continuable(job) ? { why: 'restart' as const, since: at } : job.resume ?? null;
        store.jobs.put({ ...job, status: 'Stopped', endedAt: at, error: 'ProjectKeeper restarted while this work was running', resume });
      }
      stopReplacedRounds(store);
      requeueWaitingForQuota(store);
      clearErrorsOfFinishedWork(store);
      linkPutOutDeliveries(store);
      // D99: a breakpoint the program lit before a lane looked and the spot-check confirmed is a candidate again.
      unlightUnchecked(store);
      if (store.jobs.filter((j) => j.status === 'Queued').length > 0) setImmediate(() => this.pump(p.id));
    }
  }

  /** settings.extraKeys: each key is registered as a provider of its own — with the endpoint and models of the provider
   *  it is like, or, for a provider pi does not know, with the endpoint, API and models the key brings. A key that cannot
   *  be registered shows as a key without credentials in the lane state. */
  private registerExtraKeys(): void {
    for (const k of this.workspace.settings.extraKeys ?? []) {
      if (this.models.getProvider(k.provider)) continue;
      type ProviderModels = NonNullable<Parameters<ModelRuntime['registerProvider']>[1]['models']>;
      const own = k.baseUrl && k.api && k.models?.length ? k : null;
      const models: ProviderModels = own
        ? own.models!.map((m) => ({
          id: m.id, name: m.name ?? m.id, api: own.api as ProviderModels[number]['api'], baseUrl: own.baseUrl!, reasoning: m.reasoning ?? false,
          ...(m.thinkingLevelMap ? { thinkingLevelMap: { ...m.thinkingLevelMap } as ProviderModels[number]['thinkingLevelMap'] } : {}),
          input: [...(m.input ?? ['text'])], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...m.cost },
          contextWindow: m.contextWindow, maxTokens: m.maxTokens,
          ...(m.compat ? { compat: { ...m.compat } as ProviderModels[number]['compat'] } : {}),
        }))
        : (k.like ? this.models.getModels(k.like) : []).map((m) => ({ id: m.id, name: m.name, api: m.api, baseUrl: m.baseUrl, reasoning: m.reasoning, thinkingLevelMap: m.thinkingLevelMap, input: [...m.input], cost: { ...m.cost }, contextWindow: m.contextWindow, maxTokens: m.maxTokens, ...(m.compat ? { compat: m.compat } : {}) }));
      if (!models.length) continue;
      try {
        this.models.registerProvider(k.provider, {
          name: k.name ?? `${k.like ?? k.provider} (${k.apiKeyEnv})`,
          baseUrl: models[0]!.baseUrl,
          api: models[0]!.api,
          apiKey: '${' + k.apiKeyEnv + '}',
          models,
        });
      } catch { /* shown as a key without credentials */ }
    }
  }

  /** The models of a provider pi knows, as a provider of a key's own declares them. */
  private modelsLike(provider: string): NonNullable<Parameters<ModelRuntime['registerProvider']>[1]['models']> {
    return this.models.getModels(provider).map((m) => ({ id: m.id, name: m.name, api: m.api, baseUrl: m.baseUrl, reasoning: m.reasoning, thinkingLevelMap: m.thinkingLevelMap, input: [...m.input], cost: { ...m.cost }, contextWindow: m.contextWindow, maxTokens: m.maxTokens, ...(m.compat ? { compat: m.compat } : {}) }));
  }

  /**
   * One of the owner's own keys, as a provider of its own with the endpoint and models of the provider it is for. The
   * value is handed to pi as a runtime key (`setRuntimeApiKey`): held in memory, never written to pi's auth file, never
   * put into the environment the Keeper's shell commands inherit.
   */
  private async registerOwnKey(k: OwnKey): Promise<boolean> {
    const models = this.modelsLike(k.provider);
    if (!models.length) return false;
    try {
      if (this.models.getProvider(k.id)) this.models.unregisterProvider(k.id);
      this.models.registerProvider(k.id, { name: `${k.name} (${k.provider})`, baseUrl: models[0]!.baseUrl, api: models[0]!.api, models });
      await this.models.setRuntimeApiKey(k.id, k.value);
    } catch { return false; }
    return true;
  }

  /** The provider a key runs for: an own key's provider, an extra key's `like`, else the key's own id. */
  familyOf(keyId: string): string {
    const own = this.ownKeys.get(keyId);
    if (own) return own.provider;
    const extra = (this.workspace.settings.extraKeys ?? []).find((k) => k.provider === keyId);
    return extra?.like ?? keyId;
  }

  /** Providers the owner can add a key for: those pi knows with models of their own (not the owner's own keys). */
  keyProviders(): { id: string; name: string }[] {
    const own = new Set(this.ownKeys.list().map((k) => k.id));
    const extra = new Set((this.workspace.settings.extraKeys ?? []).map((k) => k.provider));
    return this.models.getProviders().filter((p) => !own.has(p.id) && !extra.has(p.id) && this.models.getModels(p.id).length > 0)
      .map((p) => ({ id: p.id, name: p.name ?? p.id })).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Save a new key, register it, and check it at once (§6.10 保存时检查一次). Only the masked key comes back. */
  async addKey(provider: string, name: string | null, value: string): Promise<{ key: PublicOwnKey; check: KeyCheck }> {
    if (!this.models.getModels(provider).length || this.ownKeys.get(provider)) throw new Error(`Unknown provider ${provider}`);
    const key = this.ownKeys.add(provider, name, value);
    await this.registerOwnKey(key);
    await this.refreshCredentials();
    const check = await this.checkKeyNow(key.id);
    this.requeueForKeys();
    return { key: publicKey(key), check };
  }

  /** A new value (or name) for a saved key; checked again when the value changed. */
  async replaceKey(id: string, value: string | null, name: string | null): Promise<{ key: PublicOwnKey; check: KeyCheck | null }> {
    const key = this.ownKeys.replace(id, value, name);
    if (value) { this.quotaExhausted.delete(id); this.restingUntil.delete(id); }
    await this.registerOwnKey(key);
    await this.refreshCredentials();
    const check = value ? await this.checkKeyNow(id) : this.keyChecks.get(id) ?? null;
    this.requeueForKeys();
    return { key: publicKey(key), check };
  }

  /**
   * Remove a saved key (§6.10 什么时候生效): the work it carries goes on as when a key's quota runs out — each running job
   * stops where it is and is queued again, to go on in its own session on the next key of its route; with no other usable
   * key it waits, saying why. Routes that name it keep the name and pass over it, so the owner sees what to change.
   */
  async removeKey(id: string): Promise<{ removed: PublicOwnKey | null; rerouted: number }> {
    const key = this.ownKeys.remove(id);
    if (!key) return { removed: null, rerouted: 0 };
    let rerouted = 0;
    for (const l of this.lanes.values()) for (const lane of [...l.auto, l.owner, ...l.delegated]) {
      if (lane.running && lane.provider === id && lane.abort) { lane.keyRemoved = key.name; lane.abort(); rerouted++; }
    }
    await this.models.removeRuntimeApiKey(id).catch(() => undefined);
    try { this.models.unregisterProvider(id); } catch { /* already gone */ }
    this.keyChecks.delete(id); this.quotaExhausted.delete(id); this.restingUntil.delete(id);
    const lanes = { ...(this.workspace.settings.keyLanes ?? {}) };
    if (id in lanes) { delete lanes[id]; this.workspace.setSettings({ keyLanes: lanes }); }
    this.providerSwitches.push({ at: new Date().toISOString(), from: `${key.name} (${id})`, to: '(the next key of each route)', reason: `The key ${key.name} was removed${rerouted ? `; ${rerouted} running job${rerouted === 1 ? '' : 's'} move${rerouted === 1 ? 's' : ''} on` : ''}`, until: '' });
    await this.refreshCredentials();
    for (const p of this.workspace.list()) setImmediate(() => this.pump(p.id));
    return { removed: publicKey(key), rerouted };
  }

  /** Work that waits for a key is queued again: a key was added, its value replaced, or a check found it usable. */
  private requeueForKeys(): void {
    for (const p of this.workspace.list()) {
      const store = this.storeOf(p.id);
      for (const j of store.jobs.filter((x) => x.status === 'Waiting for quota' && !isReplacedRound(x) && x.agent !== 'program')) store.jobs.put({ ...j, status: 'Queued', error: null }, { jobId: j.id, summary: 'Queued again: a key can be used' });
      setImmediate(() => this.pump(p.id));
    }
  }

  /**
   * Change a project's route (§6.10; CKC-03 AC-29, AC-35): its main model, its backup order, a step's own model and
   * thinking (`null` gives the step back to what it follows). The first change copies the route in force — the machine's
   * settings — into the project, so the project goes on from what it ran on. It applies to the jobs that start after it.
   */
  setRoute(projectId: string, patch: { readonly model?: RouteModelInput; readonly backups?: readonly RouteModelInput[]; readonly steps?: Readonly<Record<string, StepRouteInput | null>> }): Route {
    const project = this.projectOf(projectId);
    const current = this.routeFor(projectId);
    const thinkingOk = (t: string | null | undefined) => t == null || t === '' || t === 'off' || (THINKING_LEVELS as readonly string[]).includes(t);
    // A key the route already names keeps its place when the order is sent back, even while it is removed or not
    // configured in this run (the page sends the whole order, its first row the main key): it is passed over at run time.
    const named = (m: RouteModelInput) => [current.main, ...current.backups].some((x) => x && x.provider === m.provider && x.id === m.id);
    const modelOf = (m: RouteModelInput, what: string): RouteModel => {
      if (!this.hasModel(m.provider, m.id) && !named(m)) throw new Error(`${what}: the key ${m.provider} has no model ${m.id}`);
      if (!thinkingOk(m.thinking)) throw new Error(`${what}: thinking must be off or one of ${THINKING_LEVELS.join(', ')}`);
      return { provider: m.provider, id: m.id, thinking: m.thinking || null };
    };
    // With no main model set anywhere, the project goes on from the key and model it runs on now (the page shows that one).
    const main = patch.model ? modelOf(patch.model, 'Main model') : current.main ?? this.resolvedModel;
    if (!main) throw new Error('Choose a key and a model first');
    const backups = patch.backups ? patch.backups.map((b, i) => modelOf(b, `Backup ${i + 1}`)).filter((b, i, all) => b.provider !== main.provider && all.findIndex((x) => x.provider === b.provider) === i) : current.backups;
    const steps: Record<string, StepRoute> = { ...(current.steps as Record<string, StepRoute>) };
    for (const [kind, value] of Object.entries(patch.steps ?? {})) {
      if (!(ROUTE_STEP_KINDS as readonly string[]).includes(kind)) throw new Error(`${kind} is not a step of a round that takes a model; they are ${ROUTE_STEP_KINDS.join(', ')}`);
      if (value === null) { delete steps[kind]; continue; }
      if (!thinkingOk(value.thinking)) throw new Error(`${kind}: thinking must be off or one of ${THINKING_LEVELS.join(', ')}`);
      if (value.model) {
        const keys = [...this.credentialed].filter((k) => this.hasModel(k, value.model!) && (!value.provider || this.familyOf(k) === value.provider || k === value.provider));
        if (!keys.length) throw new Error(`${kind}: no usable key carries ${value.provider ? `${value.provider}/` : ''}${value.model}`);
      }
      const next: StepRoute = { ...(value.model ? { model: value.model, ...(value.provider ? { provider: value.provider } : {}) } : {}), ...(value.thinking ? { thinking: value.thinking } : {}) };
      if (next.model || next.thinking) steps[kind] = next; else delete steps[kind];
    }
    const route: ProjectRoute = { model: main, backups, steps, savedAt: new Date().toISOString() };
    this.workspace.update({ ...project, route });
    for (const p of this.workspace.list()) setImmediate(() => this.pump(p.id));
    return this.routeFor(projectId);
  }

  /** Take every saved key's value out of a file the runtime's work wrote (a pi session record). */
  private scrubKeys(file: string): void {
    if (!this.ownKeys.list().length) return;
    try {
      const text = readFileSync(file, 'utf8');
      const clean = this.ownKeys.redact(text);
      if (clean !== text) writeFileSync(file, clean, 'utf8');
    } catch { /* not there, or not readable: nothing written */ }
  }

  /** Check a key now (key-check.ts: one request of one output token). */
  async checkKeyNow(id: string): Promise<KeyCheck> {
    const check = await checkKey(this.models, id, { family: this.familyOf(id), classify: classifyError, resetFrom: quotaResetFrom, redact: (t) => this.ownKeys.redact(t) });
    this.keyChecks.set(id, check);
    // A key the check finds usable again is tried again at once; one found out of quota or limited is left as a job would leave it.
    if (check.status === 'Usable') { this.quotaExhausted.delete(id); this.restingUntil.delete(id); this.requeueForKeys(); }
    return check;
  }

  /** An own key whose provider pi did not know when it started (one an extension or a test registers later) is registered once it does. */
  private async registerPendingOwnKeys(): Promise<void> {
    for (const k of this.ownKeys.list()) if (!this.models.getProvider(k.id) && this.models.getModels(k.provider).length) await this.registerOwnKey(k);
  }

  private async refreshCredentials(): Promise<void> {
    await this.registerPendingOwnKeys();
    const available = await this.models.getAvailable().catch(() => [] as readonly { provider: string }[]);
    this.credentialed = new Set(available.map((m) => m.provider));
  }

  /**
   * Every key this machine has (§6.10 "owner 自己的 key"; CKC-03 AC-33, AC-34): the owner's own, then those configured
   * outside the product — an environment variable, pi's own login, an extra key of the settings — each saying where it
   * comes from. Each with its state (the last check, or what the work found since: out of quota, rate-limited), how many
   * jobs it carries now and how many it may run at once. No value, ever.
   */
  async keysView(): Promise<KeyView[]> {
    await this.refreshCredentials();
    const running = this.runningByKey();
    const extra = new Map((this.workspace.settings.extraKeys ?? []).map((k) => [k.provider, k] as const));
    const own = this.ownKeys.list();
    const ownIds = new Set(own.map((k) => k.id));
    const out: KeyView[] = [];
    const state = (id: string): KeyView['state'] => {
      const check = this.keyChecks.get(id) ?? null;
      const ex = this.exhausted(id) ? this.quotaExhausted.get(id)! : null;
      const quota = check?.quotaReported ? check.quota : null;
      const reports = Boolean(check?.quotaReported) || this.familyOf(id) in QUOTA_REPORTERS;
      if (!this.credentialed.has(id)) return { status: 'No credentials', reason: 'No key value is configured for it in this run.', until: null, checkedAt: check?.at ?? null, how: check?.how ?? null, quota, quotaReported: reports };
      if (ex) return { status: 'Out of quota', reason: this.ownKeys.redact(ex.message).slice(0, 300), until: ex.until, checkedAt: check?.at ?? null, how: check?.how ?? null, quota, quotaReported: reports };
      if (this.resting(id)) return { status: 'Rate-limited', reason: `Rate-limited at ${new Date(this.lastRateLimitAt.get(id) ?? 0).toISOString()}; tried again after ${new Date(this.restingUntil.get(id)!).toISOString()}`, until: new Date(this.restingUntil.get(id)!).toISOString(), checkedAt: check?.at ?? null, how: check?.how ?? null, quota, quotaReported: reports };
      if (check) return { status: check.status, reason: check.reason, until: check.until, checkedAt: check.at, how: check.how, quota, quotaReported: reports };
      return { status: 'Usable', reason: 'Not checked in this run; press Check to ask the provider.', until: null, checkedAt: null, how: null, quota: null, quotaReported: reports };
    };
    const row = (id: string, base: Omit<KeyView, 'state' | 'running' | 'lanes' | 'ownLanes' | 'models'>): KeyView => ({
      ...base, state: state(id), running: running.get(id) ?? 0, lanes: this.lanesFor(id), ownLanes: this.workspace.settings.keyLanes?.[id] !== undefined,
      models: this.models.getModels(id).map((m) => ({ id: m.id, priced: m.cost.input > 0 || m.cost.output > 0 })),
    });
    const providerName = (p: string) => this.models.getProvider(p)?.name ?? p;
    for (const k of own) out.push(row(k.id, { id: k.id, name: k.name, provider: k.provider, providerName: providerName(k.provider), from: 'ProjectKeeper', fromDetail: 'Saved here, on this machine', mask: publicKey(k).mask, removable: true, addedAt: k.addedAt, replacedAt: k.replacedAt }));
    for (const p of this.models.getProviders()) {
      if (ownIds.has(p.id) || !this.models.getModels(p.id).length) continue;
      const ex = extra.get(p.id);
      const check = await this.models.checkAuth(p.id).catch(() => undefined);
      const status = this.models.getProviderAuthStatus(p.id);
      if (!ex && !check && !status.configured) continue;
      const fromDetail = ex ? `Environment variable ${ex.apiKeyEnv} (an extra key in ProjectKeeper's settings, for ${ex.like ?? p.id})`
        : status.source === 'environment' ? `Environment variable ${status.label ?? check?.source ?? ''}`.trim()
          : status.source === 'stored' ? 'pi’s own login (pi’s credential file)'
            : status.source === 'runtime' ? 'Set for this run only'
              : status.source === 'models_json_key' || status.source === 'models_json_command' ? 'pi’s models.json'
                : check?.source ? `${check.source}` : 'Configured outside ProjectKeeper';
      out.push(row(p.id, { id: p.id, name: ex?.name ?? p.name ?? p.id, provider: ex?.like ?? p.id, providerName: providerName(ex?.like ?? p.id), from: ex ? 'Settings' : status.source === 'stored' ? 'pi login' : status.source === 'environment' ? 'Environment' : 'Outside ProjectKeeper', fromDetail, mask: null, removable: false, addedAt: null, replacedAt: null }));
    }
    return out;
  }

  get models(): ModelRuntime { if (!this.modelRuntime) throw new Error('Keeper runtime not initialised'); return this.modelRuntime; }
  get ready(): boolean { return this.modelRuntime !== null; }

  /**
   * The model the owner's work runs on and what is available. With a project, its route (route.ts); without, the
   * machine's settings. When the main key cannot be used — out of quota, without credentials, removed — the first usable
   * key of the route stands in, shown as a fallback, never silently.
   */
  async providerState(projectId: string | null = null): Promise<ProviderState> {
    await this.registerPendingOwnKeys();
    const available = (await this.models.getAvailable()).map((m) => ({ provider: m.provider, id: m.id, name: m.name ?? m.id }));
    this.credentialed = new Set(available.map((m) => m.provider));
    const route = this.routeFor(projectId);
    const primary = route.main;
    // Owner work and the display use the chosen model; when its key cannot be used, the first usable key stands in (visible as a fallback).
    const standIn = this.keyChoices(projectId).find((k) => this.keyUsable(k.provider));
    const chosen = primary && this.keyUsable(primary.provider) ? primary : standIn ?? primary;
    const ex = primary ? this.quotaExhausted.get(primary.provider) : undefined;
    const standing = Boolean(chosen && primary && chosen.provider !== primary.provider);
    const why = ex ? ex.message.slice(0, 200) : primary && !this.credentialed.has(primary.provider) ? `The key ${primary.provider} has no credentials (removed, or not configured in this run)` : '';
    let fallback: ProviderFallback | null = null;
    if (!route.own) {
      // The machine's route keeps its record of switches across calls.
      if (this.fallback && !(standing && ex)) {
        this.providerSwitches.push({ at: new Date().toISOString(), from: `${this.fallback.provider}/${this.fallback.id}`, to: primary ? `${primary.provider}/${primary.id}` : '', reason: 'The chosen provider is tried again after its quota rest; back to it', until: '' });
        this.fallback = null;
      }
      if (standing && ex) this.fallback = { provider: chosen!.provider, id: chosen!.id, from: { provider: primary!.provider, id: primary!.id }, reason: why, since: this.fallback?.since ?? new Date().toISOString(), until: ex.until };
      fallback = this.fallback ?? (standing ? { provider: chosen!.provider, id: chosen!.id, from: { provider: primary!.provider, id: primary!.id }, reason: why, since: new Date().toISOString(), until: '' } : null);
    } else if (standing) {
      fallback = { provider: chosen!.provider, id: chosen!.id, from: { provider: primary!.provider, id: primary!.id }, reason: why, since: new Date().toISOString(), until: ex?.until ?? '' };
    }
    const model = chosen && available.some((m) => m.provider === chosen.provider && m.id === chosen.id) ? { provider: chosen.provider, id: chosen.id, thinking: chosen.thinking ?? null }
      : available[0] ? { provider: available[0].provider, id: available[0].id, thinking: chosen?.thinking ?? null } : null;
    const extra = { backups: route.backups, fallback, switches: this.providerSwitches.slice(-10) };
    if (!projectId || !route.own) this.resolvedModel = model;
    if (!model) return { connected: false, reason: 'No usable key: add a key in Keeper → Model provider, or run `pi` in a terminal and use /login.', model: null, available, ...extra };
    return { connected: true, reason: null, model, available, ...extra };
  }

  private exhausted(provider: string): boolean {
    const e = this.quotaExhausted.get(provider);
    return e !== undefined && Date.parse(e.until) > Date.now();
  }

  /**
   * A key's quota is exhausted: mark it until its reset time (an hour when none is given) but no longer than
   * RATE_LIMIT_REST_MS, record the switch, and say whether other keys remain. The owner can restore a key's quota by
   * hand, and a key used by the owner's own agents comes back sooner than its window: it is tried again after the rest,
   * and a key still out of quota says so again (owner 2026-09-28: 「试了可以用就用，限流了过10分钟再试一下」).
   */
  private async onQuotaExhausted(projectId: string, provider: string | null, message: string): Promise<boolean> {
    if (!provider) return false;
    const reset = quotaResetFrom(message, this.familyOf(provider)) ?? new Date(Date.now() + 60 * 60_000).toISOString();
    const until = new Date(Math.min(Date.parse(reset), Date.now() + RATE_LIMIT_REST_MS)).toISOString();
    // Several lanes on one key hit its limit at once; the switch is recorded once.
    const already = this.exhausted(provider);
    this.quotaExhausted.set(provider, { until, message });
    await this.providerState(projectId).catch(() => undefined);
    const others = this.keyChoices(projectId).filter((k) => k.provider !== provider && this.keyUsable(k.provider));
    if (!already) this.providerSwitches.push({ at: new Date().toISOString(), from: provider, to: others.length ? others.map((k) => `${k.provider}/${k.id}`).join(', ') : '(no usable key left)', reason: message.slice(0, 200), until });
    return others.length > 0;
  }

  /** Every key with credentials is inside its quota window: automatic work waits for the first one to come back, then the
   *  work that was waiting for quota is queued again (owner 2026-09-18: when a key reaches its five-hour limit, move to
   *  the next; keys become usable again later). */
  private keyReturnTimer: NodeJS.Timeout | null = null;
  private wakeWhenKeyReturns(at: number): void {
    if (this.keyReturnTimer) return;
    const timer = setTimeout(() => {
      this.keyReturnTimer = null;
      void this.providerState().catch(() => undefined).then(() => {
        for (const p of this.workspace.list()) {
          const store = this.storeOf(p.id);
          for (const job of store.jobs.filter((j) => j.status === 'Waiting for quota')) store.jobs.put({ ...job, status: 'Queued', error: null }, { jobId: job.id, summary: 'Requeued: a key is past its quota window' });
          this.pump(p.id);
        }
      });
    }, Math.max(1_000, at - Date.now() + 1_000));
    timer.unref?.();
    this.keyReturnTimer = timer;
  }

  private requeueWaiting(projectId: string): void {
    const store = this.storeOf(projectId);
    for (const j of store.jobs.filter((x) => x.status === 'Waiting for quota')) store.jobs.put({ ...j, status: 'Queued', error: null }, { jobId: j.id, summary: 'Requeued on the remaining keys' });
    this.emitEvent({ projectId, jobId: '', kind: 'job', data: { status: 'provider-switched', to: this.fallback ? `${this.fallback.provider}/${this.fallback.id}` : null } });
    setImmediate(() => this.pump(projectId));
  }

  /** pi's own default (settings.json defaultProvider/defaultModel), so the workbench and a plain `pi` start on the same model until the owner picks one here. */
  private piDefault(): { provider: string; id: string; thinking: string | null } | null {
    try {
      const s = SettingsManager.create(process.cwd(), getAgentDir());
      const provider = s.getDefaultProvider();
      const id = s.getDefaultModel();
      return provider && id ? { provider, id, thinking: null } : null;
    } catch { return null; }
  }

  setModel(choice: { provider: string; id: string; thinking: string | null }, backups?: readonly { provider: string; id: string; thinking: string | null }[]): void {
    this.workspace.setSettings({ model: choice, ...(backups ? { modelBackups: backups } : {}) });
    this.fallback = null;   // the owner's explicit choice ends any backup in use
  }

  /** §6.9 overall status for one project. */
  async status(projectId: string): Promise<{ status: KeeperStatus; reason: string | null; detail: string | null }> {
    const provider = await this.providerState(projectId);
    if (!provider.connected) return { status: 'Not connected', reason: provider.reason, detail: null };
    const lanes = this.lane(projectId);
    const running = [lanes.owner.running, ...lanes.auto.map((l) => l.running), ...lanes.delegated.map((l) => l.running)].filter((j): j is KeeperJob => j !== null);
    const err = this.lastError.get(projectId);
    // §6.9: `Working on your request` is the delegated or authorized work only; answering a question is `Working`.
    const request = running.find((j) => j.kind === 'Your request');
    if (request) return { status: 'Working on your request', reason: request.requestBasis?.label ?? request.kind, detail: request.scope.label };
    if (running.length) return { status: 'Working', reason: null, detail: running.map((j) => `${j.kind}: ${j.scope.label}`).join(' · ') };
    const store = this.storeOf(projectId);
    if (store.jobs.find((j) => j.status === 'Waiting for quota')) return { status: 'Waiting for quota', reason: err?.message ?? null, detail: 'Queued work resumes when quota is back' };
    if (err && err.kind === 'unavailable' && Date.now() - Date.parse(err.at) < 10 * 60_000) return { status: 'Unavailable', reason: err.message, detail: null };
    if (organizingHeld(this.projectOf(projectId))) return { status: 'Organizing paused', reason: null, detail: null };
    return { status: 'Idle', reason: null, detail: null };
  }

  private lane(projectId: string): ProjectLanes {
    let l = this.lanes.get(projectId);
    if (!l) { l = { owner: newLane(), auto: [], delegated: [] }; this.lanes.set(projectId, l); }
    while (l.auto.length < this.autoLaneCountFor(projectId)) l.auto.push(newLane());
    return l;
  }
  private allLanes(projectId: string): Lane[] {
    const l = this.lane(projectId);
    return [l.owner, ...l.auto, ...l.delegated];
  }

  /** Queue a job (§1.13). Returns it immediately; it runs when its lane is free. */
  enqueue(projectId: string, request: JobRequest): KeeperJob {
    const store = this.storeOf(projectId);
    const paused = request.initiator === 'auto' && !request.bypassHold && organizingHeld(this.projectOf(projectId));
    const job: KeeperJob = {
      id: newId('job'), projectId, kind: request.kind, initiator: request.initiator, scope: request.scope,
      status: paused ? 'Paused' : 'Queued', queuedAt: new Date().toISOString(), startedAt: null, endedAt: null, savedResults: [], usage: zeroUsage(),
      agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: request.requestBasis ?? null,
      parentJobId: request.parentJobId ?? null, resultText: null, step: request.step ?? null,
      priority: request.priority ?? (request.initiator === 'owner' ? 0 : request.kind === 'Product re-look' ? 2 : 3),
      task: { prompt: request.prompt, stream: request.stream === true, timeoutMs: request.timeoutMs ?? null, extra: request.task ?? null, hasExtraTools: (request.extraTools?.length ?? 0) > 0, materials: request.materials ?? [], judgementId: request.judgementId ?? null, sessionKey: request.sessionKey ?? null, ownerSourceId: request.ownerSourceId ?? null, conversation: request.conversation === true },
    };
    store.jobs.put(job, { jobId: job.id, summary: `${job.kind} queued: ${job.scope.label}` });
    if (request.extraTools?.length) this.extraTools.set(job.id, request.extraTools);
    if (request.bypassHold) this.bypassing.add(job.id);
    this.emitEvent({ projectId, jobId: job.id, kind: 'job', data: { status: job.status } });
    setImmediate(() => this.pump(projectId));
    return job;
  }
  private readonly extraTools = new Map<string, readonly ToolDefinition[]>();

  /**
   * Record a job the program does itself — a round's ledger step, a step with nothing to do, a round's root — so the
   * Keeper view shows it in the round's tree with its time (Spec §3.10, CKC-23 AC-1). It is written as Running and never
   * queued, so no lane picks it up.
   */
  recordProgramJob(projectId: string, request: ProgramJobRequest): KeeperJob {
    const store = this.storeOf(projectId);
    const now = new Date().toISOString();
    const job: KeeperJob = {
      id: newId('job'), projectId, kind: request.kind, initiator: 'auto', scope: request.scope, status: 'Running', queuedAt: now, startedAt: now,
      endedAt: null, savedResults: [], usage: zeroUsage(), agent: 'program', model: null, sessionFile: null, sessionId: null, steps: [], error: null,
      requestBasis: null, parentJobId: request.parentJobId, resultText: null, priority: 1, task: { prompt: '', stream: false, timeoutMs: null, extra: request.task ?? null }, step: request.step ?? null,
    };
    store.jobs.put(job, { jobId: job.id, summary: `${job.scope.label} started` });
    this.emitEvent({ projectId, jobId: job.id, kind: 'job', data: { status: job.status } });
    return job;
  }

  /** The kind of clerk-method round a step belongs to (its tools differ in a Follow up, Spec §3.8). */
  private clerkRoundKind(store: ProjectStore, job: KeeperJob): 'First usable' | 'Deepen' | 'Follow up' {
    return (job.step ? store.clerkRounds.get(job.step.roundId)?.kind : undefined) ?? 'First usable';
  }

  /** End a job the program did itself. */
  endProgramJob(projectId: string, jobId: string, status: 'Done' | 'Failed' | 'Stopped', patch: Partial<Pick<KeeperJob, 'resultText' | 'error' | 'timing'>> = {}): void {
    const store = this.storeOf(projectId);
    const job = store.jobs.get(jobId);
    if (!job) return;
    const endedAt = new Date().toISOString();
    store.jobs.put({ ...job, ...patch, status, endedAt }, { jobId, summary: `${job.scope.label} ${status}` });
    this.emitEvent({ projectId, jobId, kind: 'done', data: { status, resultText: patch.resultText ?? null, kind: job.kind } });
  }
  /** Jobs that start although automatic organizing is held: subagents of a job that was already running. In memory
   *  only — after a restart their parents are not running either, so nothing is waiting for them. */
  private readonly bypassing = new Set<string>();
  /** Live conversation sessions by key: the pi session and the tool context its tools read. */
  private readonly live = new Map<string, { session: AgentSession; ctx: ToolContext; boundary: ReadBoundary; turns: number }>();
  readonly branchingSupported = true;
  /** Hooks the services attach (the runtime does not know the organizing service). */
  readonly hooks: {
    requestRelook?: (projectId: string, scope: { kind: 'project' | 'area' | 'thread'; id: string | null }, reason: string) => void;
    /** The project's ledger (§1.16), for the evidence the clerk method's writers cite by ledger id. */
    ledgerFor?: (projectId: string) => LedgerHook | null;
    /** D99: the main agent entered a stage (`pk_stage`): the planner recomputes the breakpoint candidates and gives the
     *  program's lists for that stage (clerk.ts `stageEntered`). */
    stageEntered?: (projectId: string, roundId: string, stage: ClerkStage) => Promise<{ readonly note: string | null }> | { readonly note: string | null };
  } = {};

  hasLiveSession(key: string): boolean { return this.live.has(key); }

  /**
   * The model and current context of one Keeper conversation. This is deliberately separate from a job's `usage`:
   * job usage is cumulative billing across every request in that job, while context usage is the active branch that
   * would be sent on the next request. Reading this method never creates a session and never calls a model provider.
   */
  chatTelemetry(key: string | null, saved: SavedChatSession | null = null): ChatTelemetry {
    const defaultRef = (): { provider: string; id: string } | null => {
      if (this.fallback) return { provider: this.fallback.provider, id: this.fallback.id };
      return this.workspace.settings.model ?? this.resolvedModel ?? this.piDefault();
    };
    const describe = (ref: { provider: string; id: string; name?: string; contextWindow?: number } | null) => {
      if (!ref) return { model: null, limit: null };
      let configured: ReturnType<ModelRuntime['getModel']>;
      try { configured = this.models.getModel(ref.provider, ref.id); } catch { configured = undefined; }
      const explicitLimit = Number(ref.contextWindow);
      const configuredLimit = Number(configured?.contextWindow);
      const limit = Number.isFinite(explicitLimit) && explicitLimit > 0 ? explicitLimit
        : Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : null;
      return {
        model: { provider: ref.provider, id: ref.id, name: ref.name?.trim() || configured?.name || ref.id },
        limit,
      };
    };
    const context = (source: ChatTelemetry['context']['source'], usedTokens: number | null, limitTokens: number | null, percent: number | null, estimated: boolean): ChatTelemetry['context'] => ({
      usedTokens: usedTokens !== null && Number.isFinite(usedTokens) && usedTokens > 0 ? usedTokens : null,
      limitTokens: limitTokens !== null && Number.isFinite(limitTokens) && limitTokens > 0 ? limitTokens : null,
      percent: percent !== null && Number.isFinite(percent) && usedTokens !== null && usedTokens > 0 ? percent : null,
      estimated: usedTokens !== null && usedTokens > 0 && estimated,
      source,
    });

    const live = key ? this.live.get(key) : undefined;
    if (live) {
      const active = live.session.model;
      const described = describe(active ? { provider: active.provider, id: active.id, name: active.name, contextWindow: active.contextWindow } : saved?.model ?? defaultRef());
      try {
        const usage = live.session.getContextUsage();
        // A just-created or failed-before-response session can calculate zero. That is no observation, not "0 used".
        const hasExactResponse = live.session.messages.some((message) => message.role === 'assistant'
          && message.stopReason !== 'aborted' && message.stopReason !== 'error'
          && calculateContextTokens(message.usage) > 0);
        const used = hasExactResponse && usage?.tokens !== null && usage?.tokens !== undefined && usage.tokens > 0 ? usage.tokens : null;
        const estimate = used === null ? null : estimateContextTokens(live.session.messages);
        const limit = usage && usage.contextWindow > 0 ? usage.contextWindow : described.limit;
        const percent = used === null ? null : usage?.percent ?? (limit ? (used / limit) * 100 : null);
        return { model: described.model, context: context('live', used, limit, percent, (estimate?.trailingTokens ?? 0) > 0) };
      } catch {
        return { model: described.model, context: context('live', null, described.limit, null, false) };
      }
    }

    const fallbackModel = describe(saved?.model ?? (saved ? null : defaultRef()));
    if (!saved?.sessionFile) return { model: fallbackModel.model, context: context('unavailable', null, fallbackModel.limit, null, false) };

    try {
      // Never open a persisted manager for telemetry: pi repairs empty/legacy files when opening them. Parse bytes,
      // require a real header, then let a non-persisting manager migrate/index only the in-memory objects.
      const entries = parseSessionEntries(readFileSync(saved.sessionFile, 'utf8'));
      const header = entries[0];
      if (!header || header.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') throw new Error('Invalid saved session');
      const manager = SessionManager.inMemory(header.cwd, undefined, entries);
      const leafId = saved.leafId ?? manager.getLeafId();
      if (saved.leafId && !manager.getEntry(saved.leafId)) throw new Error('The recorded branch leaf is absent from the saved session');
      const branch = manager.getBranch(leafId ?? undefined);
      const projected = buildSessionProjection(manager.getEntries(), leafId);
      const lastModelChange = branch.findLastIndex((entry) => entry.type === 'model_change');
      const assistantEntry = projected.entries.findLast((entry) => entry.messages.some((message) => message.role === 'assistant'));
      const lastAssistant = assistantEntry ? branch.findIndex((entry) => entry.id === assistantEntry.sourceEntry.id) : -1;
      const assistant = assistantEntry?.messages.findLast((message) => message.role === 'assistant');
      // The response names the provider that actually answered. A later explicit model change names the model that
      // would answer next and therefore wins when it is newer than that response.
      const branchModel = lastModelChange > lastAssistant && projected.model
        ? { provider: projected.model.provider, id: projected.model.modelId }
        : assistant ? { provider: assistant.provider, id: assistant.model }
          : projected.model ? { provider: projected.model.provider, id: projected.model.modelId } : saved.model;
      const described = describe(branchModel);

      const compact = getLatestCompactionEntry(branch);
      const boundary = compact ? branch.lastIndexOf(compact) : -1;
      const projectedResponses = new Set(projected.entries.filter((entry) => entry.messages.some((message) => message.role === 'assistant'
        && message.stopReason !== 'aborted' && message.stopReason !== 'error' && calculateContextTokens(message.usage) > 0)).map((entry) => entry.sourceEntry.id));
      const exactResponse = branch.slice(boundary + 1).some((entry) => projectedResponses.has(entry.id));
      // Match pi's compaction boundary: until a successful response follows the summary, the token count is unknown.
      if (!exactResponse) return { model: described.model, context: context('saved', null, described.limit, null, false) };
      const estimate = estimateContextTokens(projected.messages);
      let usageEntryId: string | undefined;
      let messageIndex = 0;
      for (const entry of projected.entries) {
        messageIndex += entry.messages.length;
        if (estimate.lastUsageIndex !== null && estimate.lastUsageIndex < messageIndex) { usageEntryId = entry.sourceEntry.id; break; }
      }
      const usageEntryIndex = usageEntryId ? branch.findIndex((entry) => entry.id === usageEntryId) : -1;
      const invalidatingIndex = branch.findLastIndex((entry) => entry.type === 'context_edit' || entry.type === 'compaction');
      // A context edit after that response invalidates its reported token count. Match pi's projected-context estimate.
      const currentSystem = getCurrentSystemMessage(projected.messages);
      const estimatedTokens = (currentSystem ? estimateTokens(currentSystem) : 0)
        + projected.messages.filter((message) => message.role !== 'system').reduce((n, message) => n + estimateTokens(message), 0);
      const useEstimate = usageEntryIndex <= invalidatingIndex;
      const used = (useEstimate ? estimatedTokens : estimate.tokens) || null;
      const percent = used !== null && described.limit ? (used / described.limit) * 100 : null;
      return { model: described.model, context: context('saved', used, described.limit, percent, useEstimate || estimate.trailingTokens > 0) };
    } catch {
      return { model: fallbackModel.model, context: context('unavailable', null, fallbackModel.limit, null, false) };
    }
  }

  /** Move the live session's leaf back to a recorded point; the next turn continues from there (pi keeps the tree). */
  async branchSession(key: string, leafId: string): Promise<{ ok: boolean; reason: string | null }> {
    const entry = this.live.get(key);
    if (!entry) return { ok: false, reason: 'The session is not live in this run; send a message to continue it first.' };
    if (entry.session.isStreaming) return { ok: false, reason: 'The Keeper is answering; stop or wait first.' };
    try {
      const r = await entry.session.navigateTree(leafId, { summarize: false });
      return r.cancelled ? { ok: false, reason: 'Branching was cancelled.' } : { ok: true, reason: null };
    } catch (e) { return { ok: false, reason: (e as Error).message }; }
  }

  private readonly pumping = new Set<string>();
  private readonly pumpAgain = new Set<string>();
  /** Refresh which keys have credentials, then schedule; pumps for one project run one at a time so a job is never started twice. */
  private pump(projectId: string): void {
    if (this.pumping.has(projectId)) { this.pumpAgain.add(projectId); return; }
    this.pumping.add(projectId);
    void this.providerState().catch(() => undefined).then(() => {
      try { this.pumpNow(projectId); } finally {
        this.pumping.delete(projectId);
        if (this.pumpAgain.delete(projectId)) this.pump(projectId);
      }
    });
  }
  private pumpNow(projectId: string): void {
    const store = this.storeOf(projectId);
    const project = this.projectOf(projectId);
    const lanes = this.lane(projectId);
    // A job a lane has already taken is out of the queue, even while the store still reads `Queued`. `run` awaits the
    // provider state before it writes `Running`, so during that await the job is reserved in its lane but still
    // queued in the store: the next pump picked it up again and ran the whole job a second time, in a second lane.
    // Both ran to the end — two subagents, two sets of writes, twice the spend — and nothing reported anything wrong.
    const taken = new Set([lanes.owner, ...lanes.auto, ...lanes.delegated].flatMap((l) => (l.running ? [l.running.id] : [])));
    const queued = queueOrder(store.jobs.filter((j) => j.status === 'Queued' && !taken.has(j.id)), Date.now());
    // Owner work: one lane on the chosen model. Automatic work: up to lanesPerKey jobs on every usable key.
    const start = (lane: Lane, next: KeeperJob, choice: { provider: string; id: string; thinking: string | null } | null) => {
      queued.splice(queued.indexOf(next), 1);
      lane.running = { ...next, status: 'Running' };   // reserve synchronously: two pumps must not start the same job twice
      lane.provider = choice?.provider ?? null;
      lane.parked = 0;
      void this.run(projectId, next, lane, choice);
    };
    // A subagent of work that is running now. The owner's work waits in the owner's lane for the subagents it sent,
    // so those run in lanes of their own on the chosen model — in the owner's lane they would wait for ever on the
    // job that is waiting for them (batch C1, item 6).
    const underRunning = (j: KeeperJob) => j.parentJobId !== null && taken.has(j.parentJobId);
    if (!lanes.owner.running) { const next = queued.find((j) => j.initiator === 'owner' && !underRunning(j)); if (next) start(lanes.owner, next, null); }
    for (const next of queued.filter((j) => j.initiator === 'owner' && underRunning(j))) {
      if (lanes.delegated.filter((l) => l.running && !parkedLane(l)).length >= this.lanesPerKey) break;
      let lane = lanes.delegated.find((l) => !l.running);
      if (!lane) { lane = newLane(); lanes.delegated.push(lane); }
      start(lane, next, null);
    }
    // While automatic organizing is held, the only automatic work that starts is a subagent of a job already
    // running: its parent is waiting for it, and holding it would hang the parent rather than save anything.
    const held = organizingHeld(project);
    if (held && !queued.some((j) => j.initiator === 'auto' && this.bypassing.has(j.id))) return;
    // Automatic work goes to the keys of the project's route (route.ts): each job to the keys that have the model it
    // wants, spread over them up to each key's jobs at once; to the other keys of the order only when none of those is
    // usable. A key that is full makes its jobs wait; it does not send them to another model.
    const order = this.keyChoices(projectId);
    const configured = order.filter((k) => this.keyUsable(k.provider));
    if (!configured.length) {
      // Keys that would refuse the work are not sent it; it waits for the first key to come back.
      const back = order.filter((k) => this.credentialed.has(k.provider) && this.exhausted(k.provider)).map((k) => Date.parse(this.quotaExhausted.get(k.provider)!.until));
      if (back.length) { this.wakeWhenKeyReturns(Math.min(...back)); return; }
    }
    const keys: RouteKey[] = configured.length ? configured : this.resolvedModel ? [this.resolvedModel] : [];
    const capacityOf = (key: RouteKey) => (configured.length ? this.keyCapacity(key.provider) : this.resting(key.provider) ? 0 : Math.max(1, this.lanesFor(key.provider)));
    const runningOn = (key: RouteKey) => lanes.auto.filter((l) => l.running && l.provider === key.provider && !parkedLane(l)).length;
    const route = this.routeFor(projectId);
    // A step set to a model on a key (or a provider's keys) runs there; when those are out it goes to the other keys that
    // carry the same model (route.ts `keysForJob`), and the switch is recorded.
    const look = { familyOf: (k: string) => this.familyOf(k), ready: (k: string) => !this.resting(k), all: [...this.credentialed] };
    for (const next of queued.filter((j) => j.initiator === 'auto' && (!held || this.bypassing.has(j.id)))) {
      const want = wantOf(route, next.step?.kind ?? null);
      const { keys: candidates, switched } = keysForJob(keys, want, this.hasModel, look);
      const key = candidates.find((k) => runningOn(k) < capacityOf(k));
      if (!key) continue;
      this.noteStepSwitch(projectId, next.step?.kind ?? null, want, switched ? key : null, look.familyOf);
      let lane = lanes.auto.find((l) => !l.running);
      if (!lane) { lane = newLane(); lanes.auto.push(lane); }
      start(lane, next, key);
    }
  }

  /** The key each step of a project went on to while the keys it is set to were out (project|step → key). */
  private stepSwitched = new Map<string, string>();
  /**
   * The switch log (§3.10 切换记录) for a step set to a key: once when its work first goes on to another key with the same
   * model, again if it moves to a third, and once when it is back on its own keys.
   */
  private noteStepSwitch(projectId: string, step: string | null, want: Want, to: RouteKey | null, familyOf: (k: string) => string): void {
    if (!want.pin || !want.model) return;
    const at = `${projectId}|${step ?? 'work'}`;
    const was = this.stepSwitched.get(at);
    const pinned = [...this.credentialed, ...this.quotaExhausted.keys()].filter((k, i, all) => all.indexOf(k) === i && onPin(want.pin!, k, familyOf) && this.hasModel(k, want.model!));
    const label = step ? `The ${step} step` : 'Work';
    if (to) {
      if (was === to.provider) return;
      this.stepSwitched.set(at, to.provider);
      const back = pinned.flatMap((k) => [this.exhausted(k) ? Date.parse(this.quotaExhausted.get(k)!.until) : null, this.resting(k) ? this.restingUntil.get(k)! : null]).filter((n): n is number => n !== null);
      const why = pinned.length ? pinned.map((k) => `${k} ${this.exhausted(k) ? 'out of quota' : this.resting(k) ? 'rate-limited' : 'not usable'}`).join(', ') : `no key of ${want.pin.at} can be used`;
      this.providerSwitches.push({ at: new Date().toISOString(), from: `${want.pin.at}/${want.model}`, to: `${to.provider}/${want.model}`, reason: `${label}: the key it is set to cannot take work now (${why}); it runs on the same model on the next key of the order that carries it`, until: back.length ? new Date(Math.min(...back)).toISOString() : '' });
    } else if (was) {
      this.stepSwitched.delete(at);
      this.providerSwitches.push({ at: new Date().toISOString(), from: `${was}/${want.model}`, to: `${want.pin.at}/${want.model}`, reason: `${label}: the key it is set to can take work again; back to it`, until: '' });
    }
  }

  /**
   * Pause or resume automatic work. Pausing holds what has not started and stops what runs — a round's main job and its
   * lanes, the whole running tree — each marked to go on in its own session when organizing resumes (D99, E148 D-i: the
   * lanes used to run on, since they bypass the hold). Resuming queues them again.
   */
  pauseOrganizing(projectId: string, paused: boolean): void {
    const store = this.storeOf(projectId);
    for (const job of store.jobs.filter((j) => j.initiator === 'auto' && (paused ? j.status === 'Queued' : j.status === 'Paused'))) {
      store.jobs.put({ ...job, status: paused ? 'Paused' : 'Queued' });
    }
    if (paused) for (const lane of this.lane(projectId).auto) if (lane.running?.initiator === 'auto' && lane.pause) lane.pause();
    if (!paused) setImmediate(() => this.pump(projectId));
    this.emitEvent({ projectId, jobId: '', kind: 'status' });
  }

  /** What a job delegated to (D59 design 1: stopping reaches the subagents, so nothing keeps spending after the owner
   *  stops the work that started it). */
  private children(projectId: string, jobId: string): KeeperJob[] {
    return this.storeOf(projectId).jobs.filter((j) => j.parentJobId === jobId);
  }

  stopJob(projectId: string, jobId: string): boolean {
    const store = this.storeOf(projectId);
    const job = store.jobs.get(jobId);
    if (!job) return false;
    // Stop what it delegated first: a subagent stopped after its parent would go on running with nobody waiting for it.
    for (const child of this.children(projectId, jobId)) {
      if (child.status === 'Running' || child.status === 'Queued' || child.status === 'Paused' || child.status === 'Waiting for quota') this.stopJob(projectId, child.id);
    }
    if (job.status === 'Queued' || job.status === 'Paused' || job.status === 'Waiting for quota') {
      store.jobs.put({ ...job, status: 'Stopped', endedAt: new Date().toISOString() }, { jobId, summary: 'Stopped by the owner before it started' });
      this.emitEvent({ projectId, jobId, kind: 'job', data: { status: 'Stopped' } });
      return true;
    }
    for (const lane of this.allLanes(projectId)) {
      if (lane.running?.id === jobId && lane.abort) { lane.abort(); return true; }
    }
    return false;
  }

  /**
   * Continue a stopped job or retry a failed one: it runs again as the same job with the saved results kept. A round of the
   * method the clerk method replaced is not run again: its prompt names tools that no longer exist (`stopReplacedRounds`).
   * Nor is a job the program did itself (`recordProgramJob`: a clerk round, its ledger or process step): it has no prompt,
   * so run again here it would be an empty model run that could end `Done` with the step's work never done.
   */
  restartJob(projectId: string, jobId: string): boolean {
    const store = this.storeOf(projectId);
    const job = store.jobs.get(jobId);
    if (!job || !['Stopped', 'Failed', 'Waiting for quota'].includes(job.status) || isReplacedRound(job) || job.agent === 'program') return false;
    store.jobs.put({ ...job, status: 'Queued', error: null, endedAt: null }, { jobId, summary: job.status === 'Failed' ? 'Retried' : 'Continued' });
    setImmediate(() => this.pump(projectId));
    return true;
  }

  steer(projectId: string, jobId: string, text: string): boolean {
    for (const lane of this.allLanes(projectId)) {
      if (lane.running?.id === jobId && lane.session) { void lane.session.steer(text); return true; }
    }
    return false;
  }

  private async run(projectId: string, job: KeeperJob, lane: Lane, choice: { provider: string; id: string; thinking: string | null } | null = null): Promise<void> {
    const store = this.storeOf(projectId);
    const project = this.projectOf(projectId);
    // A job whose task carries no prompt cannot run as a model run (a record written by hand, or a program job that
    // reached a lane): it fails with the reason; reading `task.prompt` off it used to throw and end the whole process.
    if (!job.task || typeof (job.task as { prompt?: unknown }).prompt !== 'string') {
      store.jobs.put({ ...job, status: 'Failed', endedAt: new Date().toISOString(), error: 'This job carries no task to run' }, { jobId: job.id, summary: 'Not run: no task' });
      this.emitEvent({ projectId, jobId: job.id, kind: 'done', data: { status: 'Failed', error: 'This job carries no task to run' } });
      lane.running = null;
      setImmediate(() => this.pump(projectId));
      return;
    }
    const task = job.task as { prompt: string; stream: boolean; timeoutMs: number | null; materials?: readonly { key: string; sourceIds: readonly string[] }[]; judgementId?: string | null; sessionKey?: string | null; ownerSourceId?: string | null; conversation?: boolean };
    const provider = await this.providerState(projectId);
    const keyChoice = choice && (this.keyUsable(choice.provider) || (provider.model && choice.provider === provider.model.provider)) ? choice : provider.model;
    // settings.routes (owner 2026-09-18, arm B): a kind of automatic work can run on another model of the same key's
    // provider (for example follow-up review and product re-look on glm-5.3 while the rest runs on flash); the lane,
    // the key and its quota window stay the same.
    const extra = (job.task as { extra?: { kind?: string; route?: string } | null } | null)?.extra ?? null;
    const routeKey = extra?.route ?? extra?.kind;
    const routedId = keyChoice && routeKey ? this.workspace.settings.routes?.[routeKey] : undefined;
    // The project's route (route.ts; CKC-03 AC-29): a step of a round runs on the model and thinking set for it, or on
    // what it follows (D103: the synthesis follows the main agent; every other step the main model). It is read here, as
    // the job starts: a change of route applies to the jobs that start after it, and a running job is not interrupted.
    // On a key that does not carry the wanted model (a backup standing in), the job runs on that key's own model.
    const route = this.routeFor(projectId);
    const stepKind = job.step?.kind ?? null;
    const want = wantOf(route, stepKind);
    const stepModelSet = Boolean(stepKind && want.follows !== 'main model' && want.model);
    const onKey = keyChoice ? modelOnKey({ provider: keyChoice.provider, id: keyChoice.id, thinking: keyChoice.thinking ?? null }, want, this.hasModel) : null;
    const modelId = !onKey ? undefined
      : stepModelSet && !onKey.standIn ? onKey.id
        : routedId && this.hasModel(keyChoice!.provider, routedId) ? routedId
          : onKey.id;
    const thinking = onKey && modelId === onKey.id ? onKey.thinking : keyChoice?.thinking ?? null;
    const chosen = keyChoice ? { ...keyChoice, ...(modelId ? { id: modelId } : {}), thinking } : keyChoice;
    if (!provider.connected || !chosen) {
      store.jobs.put({ ...job, status: 'Waiting for quota', error: provider.reason }, { jobId: job.id, summary: 'No model available' });
      this.emitEvent({ projectId, jobId: job.id, kind: 'job', data: { status: 'Waiting for quota' } });
      lane.running = null;
      return;
    }
    const model = this.models.getModel(chosen.provider, chosen.id);
    if (!model) { store.jobs.put({ ...job, status: 'Failed', error: `Model ${chosen.provider}/${chosen.id} not found` }); lane.running = null; setImmediate(() => this.pump(projectId)); return; }
    // The owner may have stopped it, or organizing been paused, between the pump taking it and here: it does not start.
    const stored = store.jobs.get(job.id);
    if (stored && stored.status !== 'Queued') {
      lane.running = null; lane.provider = null;
      setImmediate(() => this.pump(projectId));
      return;
    }
    let session: AgentSession | null = null;
    let aborted = false;
    let timedOut = false;   // the time limit stopped it, not the owner: the planner goes on with the next round
    let pausing = false;   // the owner paused organizing: it ends Paused and goes on in its session when organizing resumes (D99)
    lane.running = { ...job, status: 'Running' };
    lane.provider = model.provider;   // the key this job runs on: its jobs are counted, and removing it moves this one on
    lane.keyRemoved = null;
    const started = new Date().toISOString();
    // An interrupted run goes on (D99): in the job's own session when it can be opened, and its usage, time and steps
    // add to the job's totals. The mark is cleared as the run starts and set again if this run is interrupted too.
    const resume = job.resume && continuable(job) ? job.resume : null;
    // A run starts clean: the answer that sent the job back to the queue (a rate limit, a quota) belongs to the run before.
    let current: KeeperJob = { ...job, status: 'Running', startedAt: resume ? job.startedAt ?? started : started, error: null, model: { provider: model.provider, id: model.id, thinking: chosen.thinking }, resume: null };
    store.jobs.put(current, { jobId: job.id, summary: `${job.kind} started: ${job.scope.label}` });
    this.emitEvent({ projectId, jobId: job.id, kind: 'job', data: { status: 'Running' } });
    // The owner's Stop and a pause reach the job from the moment it runs, before its session is open: opening one (the
    // resource loader, a saved session) takes a while, and a Stop or a pause in that time used to be lost — a lane the
    // main agent had just sent ran on after its main job was stopped (D99, E148 D-i). One that came before the session
    // was open ends the run before its prompt.
    lane.abort = () => { aborted = true; void session?.abort(); };
    lane.pause = () => { pausing = true; aborted = true; void session?.abort(); };
    const cwd = project.locations[0]!;
    const before = await this.contentSnapshot(project);
    // Others (the conversation's steer records) may write this job's task while it runs; keep theirs.
    const save = (patch: Partial<KeeperJob>) => {
      const storedExtra = ((store.jobs.get(current.id)?.task as { extra?: Record<string, unknown> } | null | undefined)?.extra) ?? {};
      const base = (patch.task ?? current.task) as { extra?: Record<string, unknown> } | null;
      const task = base && 'followUps' in storedExtra ? { ...base, extra: { ...(base.extra ?? {}), followUps: storedExtra.followUps } } : base;
      current = { ...current, ...patch, task };
      store.jobs.put(current);
    };
    let switched = false;   // a backup provider took over after a quota error; waiting work is requeued once the job is written
    let rateLimited = false;   // the key answered a rate limit: it rests, and waiting work is requeued once the job is written
    let timerOf: StepTimer | null = null;   // stamps the session's events: where this job's time went (§3.10)
    let lastReply = null as Reply | null;   // this job's last reply, as its events showed it
    let restoreStop: (() => void) | null = null;   // puts back the session's own turn-finish hook
    let startIndex = 0;
    let continued = false;   // this run goes on in the job's own saved session (D99)
    let freshReason: string | null = null;   // why an interrupted job's session could not be continued
    // What the job had spent before this run, and what its session had recorded when this run began: a continued session
    // holds the earlier runs' usage too, so only what it spends from here on is added.
    const priorUsage = resume ? job.usage : zeroUsage();
    let baselineUsage = zeroUsage();
    const sessionKey = task.sessionKey ?? null;
    const liveEntry = sessionKey ? this.live.get(sessionKey) : undefined;
    // A run the provider interrupted goes on in this session when the job runs again (D99); a conversation keeps its own.
    const interrupted = (): Partial<KeeperJob> => (session?.sessionFile && !sessionKey ? { resume: { why: 'provider', since: new Date().toISOString() } } : {});
    // This run's time; a run that went on from an interrupted one adds to the job's time so far, its wait for the queue
    // counted from when the interrupted run stopped.
    const timingOf = (timer: StepTimer): StepTiming => {
      const ended = current.endedAt ?? new Date().toISOString();
      if (!resume) return timer.finish(current.queuedAt, current.startedAt ?? started, ended);
      const run = timer.finish(resume.since, started, ended);
      return job.timing ? timingSum(job.timing, run) : run;
    };
    let unsubscribe: (() => void) | null = null;
    // A job outside a round's steps gets its tools by who it is: a subagent reads and writes only the fact records of its
    // material; other work gets every pk_* tool but those only a round's step has a round for (roles.ts `toolsFor`).
    const role = jobRole(job);
    try {
      const perJob: Partial<ToolContext> = {
        jobId: job.id, jobKind: job.kind, materials: task.materials ?? [], judgementId: task.judgementId ?? null, ownerSourceId: task.ownerSourceId ?? null,
        // The round a job belongs to, so what it writes is attributed to that round rather than opening one lazily
        // (D56: one result per round). A step of a clerk-method round carries its round's id.
        roundId: (job.task as { extra?: { roundId?: string } | null } | null)?.extra?.roundId ?? null,
        onSaved: (collection, id, label) => { save({ savedResults: [...current.savedResults.filter((r) => r.id !== id), { collection, id, label }] }); },
        investigate: async (question, hints) => this.investigate(projectId, job.id, question, hints),
        beginRequest: (input) => {
          if (!input.authorizationId && !task.conversation) return 'ERROR: outside the owner’s conversation a request needs a standing authorization id.';
          const basis = input.authorizationId
            ? { kind: 'authorization' as const, ref: input.authorizationId, label: input.label }
            : { kind: 'delegation' as const, ref: task.ownerSourceId ?? job.id, label: input.label };
          save({ kind: 'Your request', requestBasis: basis, scope: { ...current.scope, label: input.label } });
          lane.running = current;
          this.emitEvent({ projectId, jobId: job.id, kind: 'status' });
          return `Recorded as your request (${basis.kind === 'authorization' ? `under standing authorization ${basis.ref}` : 'delegated in this conversation'}): ${input.label}. You may change project content within this scope; report what you changed and what remains, and name the basis.`;
        },
        onInvestigationResult: (result) => { save({ task: { ...(current.task as object), extra: { ...((current.task as { extra?: object }).extra ?? {}), result } } }); },
        requestRelook: (scope, reason) => { this.hooks.requestRelook?.(projectId, scope, reason); },
        // D99: the main agent's stages are timed from this job's step timer, and its lanes run through `delegate`.
        timingSnapshot: () => (timerOf ? timingOf(timerOf) : null),
        ...(job.step?.kind === 'main' ? {
          lanes: this.laneRunner(projectId, job.id),
          stageEntered: (roundId: string, stage: ClerkStage) => this.hooks.stageEntered?.(projectId, roundId, stage) ?? { note: null },
        } : {}),
      };
      if (liveEntry) {
        Object.assign(liveEntry.ctx, perJob);
        session = liveEntry.session;
        liveEntry.turns += 1;
      } else {
        // A directory whose path is too long for pi's session folder and for any process started in it: said as that,
        // with what to do, before pi fails on a folder it cannot make (util/paths.ts `keeperPathLimit`).
        const tooLong = keeperPathLimit(cwd);
        if (tooLong) throw new Error(tooLong);
        const settingsManager = SettingsManager.create(cwd, getAgentDir());
        // Every pi built-in tool is on in every step, the judging ones included (CKC-03 AC-25, D87). They are turned on
        // through the default-tool setting, not the `tools` option: an allowlist there drops every pk_* tool, and the
        // read boundary re-provides its guarded versions of exactly the default set (bounds/boundary.ts).
        settingsManager.applyOverrides({ defaultTools: keeperBuiltinTools() });
        // Read boundary (Spec §3.1; CKC-03 AC-23, E69): reads and shell stay inside the project's roots, and
        // credentials stay out of shell subprocesses, without any tool being removed. The loader is built with the
        // boundary's inline extension, so the boundary reads the loader's resources lazily on the first tool call.
        // A home that watches its projects is a live project, where the owner and agents write while a command runs:
        // the shell guard then undoes only what the command names as its writes; watchProjects false is a controlled trial (BQ).
        const loaderRef: { current: DefaultResourceLoader | null } = { current: null };
        const boundary = createReadBoundary({
          project, store, agentDir: getAgentDir(), settingsManager, jobId: job.id,
          resolveLoader: () => loaderRef.current,
          onDeny: () => save({ boundaryDenials: (current.boundaryDenials ?? 0) + 1 }),
          watchesProjects: () => this.workspace.settings.watchProjects !== false,
        });
        // The clerk round's main agent, lanes, synthesis and spot-check get the method as pi skills (D99, D103; E148 D-b); pi lists them,
        // and the boundary opens each loaded skill's folder for reading.
        const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager, extensionFactories: [boundary.extension], additionalSkillPaths: clerkSkillPathsFor(job.step?.kind) });
        loaderRef.current = loader;
        await loader.reload();
        // The loader's reload re-reads the settings files and drops overrides; set the tools again for the session.
        settingsManager.applyOverrides({ defaultTools: keeperBuiltinTools() });
        const toolCtx: ToolContext = { store, project, model: model.id, jobId: job.id, jobKind: job.kind, step: job.step ?? null, ...perJob };
        const extra = this.extraTools.get(job.id) ?? [];
        // The per-role filter governs the pk_* tools; the boundary's re-provided bash/powershell are not pk_* tools, so they
        // pass through it and every role keeps its shell (roles.ts `toolsFor`).
        // The clerk method's own writers go to its steps only; any other job would be offered writers that refuse it.
        const clerk = job.step ? [...clerkTools({ ...toolCtx, step: job.step, ledger: this.hooks.ledgerFor?.(projectId) ?? null }), ...stageTools(toolCtx), ...laneTools(toolCtx)] : [];
        // D99 (W5): the coverage check and the main agent's accounts; which job is offered them is roles.ts's.
        if (job.step) clerk.push(...coverageTools(toolCtx));
        // DA: an owner's line judged to need nothing, by its line reference (owner-lines.ts).
        if (job.step) clerk.push(...ownerLineTools(toolCtx));
        // CJ: the main agent's account of a counted entry, by number (the entry completeness gate, entry-gate.ts).
        if (job.step) clerk.push(...entryGateTools(toolCtx));
        // CM: bulk placement by number range, and the verdict on a candidate generation (place-tools.ts).
        if (job.step) clerk.push(...placeTools({ ...toolCtx, ledger: this.hooks.ledgerFor?.(projectId) ?? null }));
        // Every job can query the ledger (CKC-03 AC-26): the dates, commits, versions, numbers and verdicts it holds are
        // exact, and asking it is faster than reading them back out of files.
        const allTools = [...keeperTools(toolCtx), ...roundTools(toolCtx), ...ledgerTools(toolCtx), ...clerk, ...boundary.tools, ...extra];
        // A step of a clerk-method round gets its step's tools (Spec §3.3: which step writes what); other jobs keep the
        // per-role filter.
        // The main job and a lane (D99) are offered what they write in any stage or slot, refused at call time outside
        // their effective stage (stage-gate.ts).
        const step = job.step;
        const customTools = step ? stepToolsFor(allTools, step.kind, this.clerkRoundKind(store, job), step.lane ?? null, (tool, args) => writeRefusal(store, step, tool, args)) : toolsFor(allTools, role);
        const thinkingLevel = (chosen.thinking ?? 'medium') as 'medium';
        const createSession = (sessionManager: SessionManager) => createAgentSession({
          cwd, agentDir: getAgentDir(), modelRuntime: this.models, model, thinkingLevel, customTools, resourceLoader: loader, settingsManager, sessionManager,
        });
        // An interrupted job goes on in its own session, on the key it is given now (D99). pi builds the session's
        // messages from the file; the model and thinking level passed in take effect, and a model other than the one the
        // session recorded is recorded as a change, so the file says which key answered what. The interrupted turn needs
        // nothing done to it: pi-ai leaves an errored or aborted assistant message out of every request it builds, and
        // gives a tool call left without a result (cut short by a restart) a synthetic error result (transform-messages.ts).
        let created: Awaited<ReturnType<typeof createAgentSession>> | null = null;
        if (resume) {
          const opened = openSavedSession(job.sessionFile!, cwd);
          if ('reason' in opened) {
            freshReason = opened.reason;
          } else {
            try {
              created = await createSession(opened.manager);
              if (!opened.model || opened.model.provider !== model.provider || opened.model.modelId !== model.id) await created.session.setModel(model);
              created.session.setThinkingLevel(thinkingLevel);
            } catch (e) {
              try { created?.session.dispose(); } catch { /* ignore */ }
              created = null;
              freshReason = `its saved session could not be continued on ${model.provider}/${model.id} (${(e as Error).message})`;
            }
          }
        }
        if (!created) created = await createSession(SessionManager.create(cwd));
        continued = resume !== null && freshReason === null;
        session = created.session;
        if (resume) {
          store.jobs.put(current, {
            jobId: job.id,
            summary: continued
              ? `${job.kind}: continues its own session on ${model.provider}/${model.id} after ${resume.why === 'provider' ? 'the model provider interrupted it' : resume.why === 'restart' ? 'ProjectKeeper restarted' : resume.why === 'pause' ? 'organizing was paused' : 'it ended before its task was done'}`
              : `${job.kind}: starts afresh — ${freshReason}`,
          });
        }
        // Record the thinking level that took effect: a model maps what it does not support (glm-5.3 has low, high, max;
        // `medium` runs as `high`), and the Keeper view shows what actually ran (CKC-03 AC-29).
        const effective = (session as unknown as { thinkingLevel?: string }).thinkingLevel;
        if (effective && current.model && effective !== current.model.thinking) save({ model: { ...current.model, thinking: effective } });
        if (sessionKey) this.live.set(sessionKey, { session, ctx: toolCtx, boundary, turns: 1 });
      }
      lane.session = session;
      if (continued) baselineUsage = this.usageOf(session);
      const liveSession = session;
      const runUsage = (): Usage => usageAfter(priorUsage, this.usageOf(liveSession), baselineUsage);
      save({ sessionFile: session.sessionFile ?? null, sessionId: session.sessionId });
      let messageId = newId('msg');
      // Which step each tool call opened. Parallel calls end in any order, so a result is filed by the call it belongs
      // to; filing it on the last step with the same tool name gave the second of two parallel investigations the
      // first one's answer and left the first with none.
      const stepOfCall = new Map<string, number>();
      // Each call's arguments, kept until it ends: what it read is worked out from them and its result (bounds/reads.ts),
      // since the step's target keeps only the first 160 characters of a command (Spec §1.11; CKC-13 AC-8).
      const argsOfCall = new Map<string, Record<string, unknown>>();
      const readContext = { cwd, repoRoot: (repo: string) => project.scope.find((i) => i.id === repo)?.path ?? (isAbsolute(repo) ? repo : null) };
      // Where this job's time goes (Spec §3.10, D81): pi's events carry no times, so they are stamped as they arrive.
      const stepTimer = new StepTimer();
      timerOf = stepTimer;
      // The same call refused the same way again and again: pi would keep asking the model until the step's time
      // limit. Each turn is read whole as it ends, its reply and every call's result (step-timing.ts RefusalStreak):
      // once the same call has come back refused the same way in REPEATED_REFUSAL_LIMIT turns in a row, with nothing
      // else run in them, the loop stops (QC AX-1). Calls to different targets refused together in one turn count once
      // each, not as one call refused that many times (test-D-1).
      const refusals = new RefusalStreak();
      const agent = session.agent;
      const priorFinishTurn = agent.finishTurn;
      agent.finishTurn = async (turn, signal) => {
        const prior = await priorFinishTurn?.(turn, signal);
        refusals.turnEnded(guardTurn(turn));
        if (turn.message.stopReason !== 'error' && turn.message.stopReason !== 'aborted' && refusals.reached !== null) return { action: 'end' };
        return prior ?? undefined;
      };
      restoreStop = () => { agent.finishTurn = priorFinishTurn; };
      unsubscribe = session.subscribe((event) => {
        const at = Date.now();
        if (event.type === 'message_end' && (event as { message?: { role?: string } }).message?.role === 'assistant') {
          const reply = (event as { message: Reply }).message;
          stepTimer.assistantEnded(reply, at);
          lastReply = reply;
        } else if (event.type === 'tool_execution_start') {
          stepTimer.toolStarted(at);
        } else if (event.type === 'tool_execution_end') {
          const e = event as { toolName: string; isError?: boolean; result?: { content?: { type: string; text?: string }[] } };
          const text = e.result?.content?.find((c) => c.type === 'text')?.text ?? '';
          stepTimer.toolEnded(at, e.isError === true, text);
        } else if ((event as { type: string }).type === 'auto_retry_start') {
          stepTimer.retryWait((event as unknown as { delayMs?: number }).delayMs ?? 0);
        }
        if (event.type === 'message_update' && task.stream) {
          const e = event.assistantMessageEvent as { type: string; delta?: string };
          if (e.type === 'text_delta' && e.delta) this.emitEvent({ projectId, jobId: job.id, kind: 'delta', data: { messageId, text: e.delta } });
        } else if (event.type === 'message_start' && (event as { message?: { role?: string } }).message?.role === 'assistant') {
          messageId = newId('msg');
        } else if (event.type === 'tool_execution_start') {
          const e = event as { toolCallId?: string; toolName: string; args: Record<string, unknown> };
          const keys = Array.isArray(e.args?.keys) ? (e.args.keys as unknown[]).join(', ') : undefined;
          const target = String(e.args?.path ?? e.args?.file_path ?? e.args?.command ?? e.args?.id ?? e.args?.query ?? e.args?.question ?? keys ?? e.args?.title ?? e.args?.name ?? '').slice(0, 160);
          if (e.toolCallId) stepOfCall.set(e.toolCallId, current.steps.length);
          if (e.toolCallId && READING_TOOLS.has(e.toolName)) argsOfCall.set(e.toolCallId, e.args ?? {});
          save({ steps: [...current.steps, { at: new Date().toISOString(), tool: e.toolName, target, summary: '', isError: false }] });
          this.emitEvent({ projectId, jobId: job.id, kind: 'step', data: { tool: e.toolName, target } });
        } else if (event.type === 'tool_execution_end') {
          const e = event as { toolCallId?: string; toolName: string; isError: boolean; result?: { content?: { type: string; text?: string }[] } };
          const steps = [...current.steps];
          const own = e.toolCallId !== undefined ? stepOfCall.get(e.toolCallId) : undefined;
          const args = e.toolCallId !== undefined ? argsOfCall.get(e.toolCallId) : undefined;
          if (e.toolCallId !== undefined) { stepOfCall.delete(e.toolCallId); argsOfCall.delete(e.toolCallId); }
          const idx = own ?? steps.map((s) => s.tool).lastIndexOf(e.toolName);
          if (idx >= 0 && idx < steps.length) {
            const textPart = e.result?.content?.find((c) => c.type === 'text')?.text ?? '';
            // What the call read, as it ended (a call whose arguments were not kept records none, and counts by its target).
            const reads = args ? stepReads(e.toolName, args, textPart, e.isError, readContext) : null;
            steps[idx] = { ...steps[idx]!, summary: textPart.replace(/\s+/g, ' ').slice(0, 160), isError: e.isError, ...(reads ? { reads } : {}) };
            save({ steps });
          }
        } else if (event.type === 'message_end') {
          save({ usage: runUsage() });
        }
      });
      const preamble = keeperPreamble({ projectName: project.name, projectRoot: cwd, language: project.language, jobKind: job.kind, jobId: job.id, conversation: task.conversation === true, subagentOf: role === 'subagent' && job.step?.kind !== 'lane' && job.step?.kind !== 'main' && job.step?.kind !== 'synthesis' && job.step?.kind !== 'spot-check' ? job.parentJobId : null, laneOf: job.step?.kind === 'lane' ? job.parentJobId : null, mayChangeProject: job.requestBasis ? { allowed: true, basis: job.requestBasis.label } : { allowed: false, basis: null }, authorizations: store.authorizations.filter((a) => !a.revokedAt).map((a) => ({ id: a.id, scope: a.scope })) });
      const timeoutMs = task.timeoutMs ?? (job.initiator === 'owner' ? null : 30 * 60_000);
      const timer = timeoutMs ? setTimeout(() => { aborted = true; timedOut = true; void session?.abort(); }, timeoutMs) : null;
      try {
        // A live session may still be settling after its previous turn; wait, then queue as a follow-up if it never settles.
        if (liveEntry) {
          for (let i = 0; i < 200 && session.isStreaming; i++) await new Promise((r) => setTimeout(r, 50));
          liveEntry.boundary.setJobId(job.id, project, () => save({ boundaryDenials: (current.boundaryDenials ?? 0) + 1 }));
        }
        startIndex = session.messages.length;
        const text = liveEntry ? task.prompt : continued ? continuationMessage(resume!.why, model, resume!.note ?? null) : `${preamble}\n\n${task.prompt}`;
        if (!aborted) await session.prompt(text, session.isStreaming ? { streamingBehavior: 'followUp' } : undefined);
      } finally {
        if (timer) clearTimeout(timer);
        // A stopped turn can leave steering queued in pi 0.87.1. It belongs to that stopped job, not the next prompt.
        if (aborted) session.clearQueue();
      }
      let leafId: string | null = null;
      try { leafId = (session as unknown as { sessionManager?: { getLeafId(): string | null } }).sessionManager?.getLeafId() ?? null; } catch { leafId = null; }
      if (sessionKey) save({ task: { ...(current.task as object), extra: { ...((current.task as { extra?: object }).extra ?? {}), leafId } } });
      // How the job ended is its last reply as this job's events showed it. `session.messages` is not a record of that:
      // pi drops a reply cut off at the output limit from it to compact and retry, and when there is nothing to compact
      // it does not retry — the job was then recorded `Done` with no result (QC AX-1) — and compaction rewrites the
      // list, so an index into it no longer finds this turn. The list is only the fallback when no reply was seen.
      // Only this turn's messages count; a live session also holds the earlier turns.
      const messages = session.messages.slice(startIndex);
      const lastAssistant = lastReply ?? ([...messages].reverse().find((m) => m.role === 'assistant') as Reply | undefined);
      // The reply is kept as the model wrote it, its first and last lines included (QC AX-1): trimming belongs where it
      // is shown or compared. A reply with no words in it is no result at all.
      const replyText = (lastAssistant?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
      const resultText = replyText.trim() ? replyText : null;
      // A provider's error may quote what it was sent; a key saved here is taken out before anything is written (§3.1).
      const errorMessage = lastAssistant?.stopReason === 'error' ? this.ownKeys.redact(lastAssistant.errorMessage ?? 'The model returned an error') : null;
      // A last reply cut off at the model's output limit is not a finished job (CKC-03 AC-30): it used to be saved as
      // `Done`, and a truncated report or record passed as complete. A `length` stop stays a failure unless a complete
      // reply came after it — which would then be the last reply. What it wrote before the cut stays.
      const cutOff = !errorMessage && lastAssistant?.stopReason === 'length'
        ? `The last reply was cut off at the model's output limit (${current.model?.id ?? 'the model'}): what it wrote before the cut is kept; run the step again`
        : null;
      const repeated = refusals.reached;
      const usage = runUsage();
      const after = await this.contentSnapshot(project);
      const changed = this.contentDiff(before, after);
      // Only a controlled trial (a home that takes in no new changes) can blame a job for what changed while it ran: on a
      // live project the owner and other agents work at the same time, their commits would be laid at the job's door, and
      // the ledger takes those changes in anyway. There the shell boundary keeps the Keeper's own writes out (BQ).
      if (changed.length && !current.requestBasis && this.workspace.settings.watchProjects === false) {
        const list = this.resourceChanges.get(projectId) ?? [];
        list.push({ at: new Date().toISOString(), jobId: job.id, detail: `Project content changed during autonomous ${job.kind} (${job.scope.label}): ${changed.slice(0, 8).join('; ')}${changed.length > 8 ? ` +${changed.length - 8} more` : ''}` });
        this.resourceChanges.set(projectId, list.slice(-50));
      }
      if (aborted && pausing && !timedOut) {
        // Organizing was paused (D99): it goes on in its own session when organizing resumes — at once, when organizing
        // was resumed while this run was ending (resuming requeues only what already reads Paused).
        save({ status: organizingHeld(this.projectOf(projectId)) ? 'Paused' : 'Queued', usage, resultText, endedAt: null, ...(session?.sessionFile && !sessionKey ? { resume: { why: 'pause' as const, since: new Date().toISOString() } } : {}) });
      } else if (aborted && lane.keyRemoved) {
        // The owner removed the key this job ran on (§6.10): it goes on as when a key runs out of quota — in its own
        // session on the next usable key of its route; with none left, it waits and says why.
        const others = this.keyChoices(projectId).filter((k) => k.provider !== current.model?.provider && this.keyUsable(k.provider));
        const why = `The key ${lane.keyRemoved} was removed while this work ran on it`;
        save({ status: others.length ? 'Queued' : 'Waiting for quota', error: others.length ? null : `${why}, and no other usable key is left: add a key or choose another in Keeper → Model provider`, usage, resultText, endedAt: null,
          ...(session?.sessionFile && !sessionKey ? { resume: { why: 'provider' as const, since: new Date().toISOString(), note: `${why}; it goes on here.` } } : {}) });
      } else if (aborted) {
        // The owner stopped it (or the time limit did): what was produced stays; an abort error is not a failure.
        save({ status: 'Stopped', usage, resultText, endedAt: new Date().toISOString(), ...(timedOut ? { error: 'Stopped at its time limit' } : {}) });
      } else if (repeated) {
        save({ status: 'Failed', error: repeatedRefusalError(repeated), usage, resultText, endedAt: new Date().toISOString() });
      } else if (errorMessage) {
        const kind = classifyError(errorMessage);
        this.lastError.set(projectId, { at: new Date().toISOString(), message: errorMessage, kind });
        if (kind === 'ratelimit') {
          save({ status: 'Waiting for quota', error: errorMessage, usage, resultText, endedAt: null, ...interrupted() });
          rateLimited = true;
        } else if (kind === 'quota' || kind === 'unavailable') {
          save({ status: 'Waiting for quota', error: errorMessage, usage, resultText, endedAt: null, ...interrupted() });
          switched = kind === 'quota' && await this.onQuotaExhausted(projectId, current.model?.provider ?? null, errorMessage);
          if (!switched) this.scheduleQuotaRetry(projectId);
        } else {
          save({ status: 'Failed', error: errorMessage, usage, resultText, endedAt: new Date().toISOString() });
        }
      } else if (cutOff) {
        save({ status: 'Failed', error: cutOff, usage, resultText, endedAt: new Date().toISOString() });
      } else {
        save({ status: 'Done', usage, resultText, endedAt: new Date().toISOString() });
      }
      if (timerOf) save({ timing: timingOf(timerOf) });
      store.jobs.put(current, { jobId: job.id, summary: `${job.kind} ${current.status}: ${job.scope.label}` });
      this.emitEvent({ projectId, jobId: job.id, kind: 'done', data: { status: current.status, resultText: current.resultText, messageId, savedResults: current.savedResults, steps: current.steps, kind: current.kind, requestBasis: current.requestBasis, leafId, conversation: task.conversation === true, result: (current.task as { extra?: { result?: unknown } }).extra?.result ?? null } });
      if (switched) this.requeueWaiting(projectId);
      // After the job is written: requeued before, the job's own last writes put it back to waiting, and nothing took it again.
      if (rateLimited) this.onRateLimit(projectId, current.model?.provider ?? null);
    } catch (error) {
      const message = this.ownKeys.redact(error instanceof Error ? error.message : String(error));
      const kind = classifyError(message);
      this.lastError.set(projectId, { at: new Date().toISOString(), message, kind });
      const paused = aborted && pausing && !timedOut;
      const moved = aborted && Boolean(lane.keyRemoved) && this.keyChoices(projectId).some((k) => k.provider !== current.model?.provider && this.keyUsable(k.provider));
      const status: JobStatus = paused ? (organizingHeld(this.projectOf(projectId)) ? 'Paused' : 'Queued') : moved ? 'Queued' : aborted && lane.keyRemoved ? 'Waiting for quota' : aborted ? 'Stopped' : kind === 'error' ? 'Failed' : 'Waiting for quota';
      save({ status, error: paused || moved ? null : message, endedAt: status === 'Waiting for quota' || paused || moved ? null : new Date().toISOString(), ...(status === 'Waiting for quota' || moved ? interrupted() : paused && session?.sessionFile && !sessionKey ? { resume: { why: 'pause' as const, since: new Date().toISOString() } } : {}) });
      if (timerOf) save({ timing: timingOf(timerOf) });
      store.jobs.put(current, { jobId: job.id, summary: `${job.kind} ${status}: ${message.slice(0, 120)}` });
      if (status === 'Waiting for quota' && kind === 'ratelimit') {
        this.onRateLimit(projectId, current.model?.provider ?? null);
      } else if (status === 'Waiting for quota') {
        switched = kind === 'quota' && await this.onQuotaExhausted(projectId, current.model?.provider ?? null, message);
        if (!switched) this.scheduleQuotaRetry(projectId);
      }
      this.emitEvent({ projectId, jobId: job.id, kind: 'done', data: { status, error: message } });
      if (switched) this.requeueWaiting(projectId);
    } finally {
      try { unsubscribe?.(); } catch { /* ignore */ }
      restoreStop?.();
      if (!sessionKey) { try { session?.dispose(); } catch { /* ignore */ } }
      // A provider's error may quote the key it was sent, and pi records the error in the session file: a key saved here
      // is taken out of the record (§3.1: no key value in session records).
      if (session?.sessionFile) this.scrubKeys(session.sessionFile);
      lane.running = null; lane.session = null; lane.abort = null; lane.pause = null; lane.keyRemoved = null;
      this.extraTools.delete(job.id);
      void store.flush();
      setImmediate(() => this.pump(projectId));
    }
  }

  /**
   * A rate limit (429): that key rests RATE_LIMIT_REST_MS before it is tried again, and the work waiting on it is queued
   * again at once, so the other keys take it (owner 2026-09-28: 「3个key都可以用，试了可以用就用，限流了过10分钟再试一下」).
   * When every key rests, the work waits for the first one back. A 429 here is often the owner's own agents sharing the
   * account, not a broken key. The lane state shows which key rests (§6.9).
   */
  private onRateLimit(projectId: string, provider: string | null): void {
    const p = provider ?? 'unknown';
    const at = Date.now();
    this.lastRateLimitAt.set(p, at);
    this.restingUntil.set(p, at + RATE_LIMIT_REST_MS);
    const store = this.storeOf(projectId);
    for (const job of store.jobs.filter((j) => j.status === 'Waiting for quota' && classifyError(j.error ?? '') === 'ratelimit')) {
      store.jobs.put({ ...job, status: 'Queued' }, { jobId: job.id, summary: `Queued again: ${p} rests ${RATE_LIMIT_REST_MS / 60_000} minutes after a rate limit; another key takes it` });
    }
    setImmediate(() => this.pump(projectId));
    this.wakeAfterRest();
  }

  /** When the first resting key's rest is over, run the pump for every project; then wait for the next one, if any. */
  private wakeAfterRest(): void {
    if (this.restWakeTimer) clearTimeout(this.restWakeTimer);
    this.restWakeTimer = null;
    const pending = [...this.restingUntil.values()].filter((u) => u > Date.now());
    if (!pending.length) return;
    this.restWakeTimer = setTimeout(() => {
      this.restWakeTimer = null;
      for (const w of this.workspace.list()) this.pump(w.id);
      this.wakeAfterRest();
    }, Math.min(...pending) - Date.now() + 1_000);
    this.restWakeTimer.unref?.();
  }

  private scheduleQuotaRetry(projectId: string): void {
    if (this.quotaRetryTimers.has(projectId)) return;
    const timer = setTimeout(() => {
      this.quotaRetryTimers.delete(projectId);
      const store = this.storeOf(projectId);
      for (const job of store.jobs.filter((j) => j.status === 'Waiting for quota')) store.jobs.put({ ...job, status: 'Queued' });
      this.pump(projectId);
    }, 5 * 60_000);
    timer.unref?.();
    this.quotaRetryTimers.set(projectId, timer);
  }

  /**
   * Run a subagent for a job that is running now, and wait for it (D59 design 1). The subagent belongs to the work
   * that sent it: it inherits the parent's lane kind, so pausing automatic organizing holds the subagents too and a
   * Stop on the parent reaches them; owner work's subagents run in lanes of their own on the chosen model (see
   * `pumpNow`). It queues just ahead of its parent's peers so the parent is not left waiting behind a fresh batch of
   * other work. Until 2026-09-20 every investigation was enqueued as owner work, competing with the owner's chat.
   */
  private async delegate(projectId: string, parentJobId: string, request: JobRequest): Promise<KeeperJob> {
    return this.delegated(projectId, parentJobId, { enqueue: request }, 'done').ended;
  }

  /**
   * A subagent of a running job, queued (`enqueue`), queued again (`restart`: a lane that failed or was interrupted) or
   * already queued (`wait`), and the parent parked until it answers. `until`: `done` settles on the first `done` event, as
   * an investigation always has; `end` settles only once it has ended (`waitForEnd`) — a lane the provider interrupted is
   * moved to another key and still waited for (D99).
   */
  private delegated(projectId: string, parentJobId: string, what: { readonly enqueue: JobRequest } | { readonly restart: string } | { readonly wait: string }, until: 'done' | 'end'): { readonly job: KeeperJob; readonly ended: Promise<KeeperJob> } {
    const store = this.storeOf(projectId);
    const parent = store.jobs.get(parentJobId);
    let job: KeeperJob;
    if ('enqueue' in what) {
      job = this.enqueue(projectId, {
        ...what.enqueue, initiator: parent?.initiator ?? what.enqueue.initiator, parentJobId, priority: (parent?.priority ?? 1) - 1,
        bypassHold: parent?.status === 'Running',
      });
    } else {
      const id = 'restart' in what ? what.restart : what.wait;
      if (parent?.status === 'Running') this.bypassing.add(id);
      if ('restart' in what) this.restartJob(projectId, id);
      job = store.jobs.get(id)!;
    }
    // The parent is waiting, not working: its lane carries other work meanwhile, so a main job with several subagents
    // does not hold lanes idle — and a round cannot wait on itself when its subagents outnumber the lanes. The lane is
    // released by the last subagent to answer, and only while it still holds the same parent.
    const parentLane = this.allLanes(projectId).find((l) => l.running?.id === parentJobId);
    if (parentLane) { parentLane.parked = (parentLane.parked ?? 0) + 1; setImmediate(() => this.pump(projectId)); }
    const waited = until === 'end' ? this.waitForEnd(projectId, job.id) : this.waitFor(projectId, job.id);
    const ended = waited.finally(() => { if (parentLane && parentLane.running?.id === parentJobId) parentLane.parked = Math.max(0, (parentLane.parked ?? 1) - 1); });
    return { job, ended };
  }

  /** How the main job's lanes run (D99; lane-tools.ts `pk_send_lanes`): through `delegate`, waited for until each has ended. */
  private laneRunner(projectId: string, mainJobId: string): LaneRunner {
    return {
      send: (request) => this.delegated(projectId, mainJobId, { enqueue: { kind: 'Organizing', initiator: 'auto', scope: request.scope, prompt: request.prompt, step: request.step, task: request.task, timeoutMs: request.timeoutMs } }, 'end'),
      again: (jobId) => this.delegated(projectId, mainJobId, { restart: jobId }, 'end').ended,
      wait: (jobId) => this.delegated(projectId, mainJobId, { wait: jobId }, 'end').ended,
    };
  }

  /** A focused investigation: its own session, returns the conclusion and the sources it cites. */
  async investigate(projectId: string, parentJobId: string, question: string, hints: string[]): Promise<{ conclusion: string; sourceIds: string[]; jobId: string }> {
    const done = await this.delegate(projectId, parentJobId, {
      kind: 'Investigation', initiator: 'owner', scope: { kind: 'question', ids: [], label: question.slice(0, 80) },
      prompt: `Investigate this question for the parent job ${parentJobId} and answer it with evidence.\n\nQuestion: ${question}\n${hints.length ? `Hints: ${hints.join('; ')}\n` : ''}\nRead what you need (sources via pk_list_sources / pk_read_source, project files, code, git history, commands that change nothing). Record any fact you establish that is not yet in the assets with pk_write_fact_record. End with a concise conclusion; list the source ids it rests on as "Sources: id, id".`,
    });
    // A subagent that did not finish says so in its place — failed, stopped, or waiting for quota — and what it had written
    // comes after, marked as unfinished: the job that sent it can send the question again or carry on without it, instead
    // of reading an empty or half answer as the answer (D59 design 1; QC AH #10: one waiting for quota came back empty).
    const ended = done.status === 'Done' ? null
      : done.status === 'Failed' ? `This investigation failed and has no finished answer (${done.error ?? 'no reason recorded'}). Ask again if the answer matters, or say in your reply that it is missing.`
        : done.status === 'Stopped' ? 'This investigation was stopped before it finished. Say in your reply that its answer is missing.'
          : done.status === 'Waiting for quota' ? `This investigation is waiting for quota (${done.error ?? 'the provider refused it'}) and has not answered. It runs again when the quota returns and records what it finds in the assets, but its answer does not come back to this job: say in your reply that it is missing, or ask again later.`
            : `This investigation ended ${done.status} without an answer. Say in your reply that it is missing.`;
    const text = ended ? `${ended}${done.resultText ? `\nWhat it had written when it ended, not a finished answer:\n${done.resultText}` : ''}` : done.resultText ?? '';
    const m = /Sources?:\s*([\s\S]+)$/i.exec(text);
    const sourceIds = m ? (m[1]!.match(/src_[0-9a-f]{16}/g) ?? []) : [];
    return { conclusion: text, sourceIds: [...new Set(sourceIds)], jobId: done.id };
  }

  /**
   * Wait until a job has ended (D99): Done, Failed, or Stopped with nothing to go on with. Unlike `waitFor`, `Waiting for
   * quota` does not end it — the provider interrupted it and it moves to another key (BU) — nor does a pause.
   */
  waitForEnd(projectId: string, jobId: string): Promise<KeeperJob> {
    const store = this.storeOf(projectId);
    const ended = (j: KeeperJob | undefined): j is KeeperJob => !!j && (j.status === 'Done' || j.status === 'Failed' || (j.status === 'Stopped' && !j.resume));
    return new Promise((resolve, reject) => {
      const first = store.jobs.get(jobId);
      if (!first) { reject(new Error(`No job ${jobId}`)); return; }
      if (ended(first)) { resolve(first); return; }
      const check = (e: KeeperEvent) => {
        if (e.projectId !== projectId || e.jobId !== jobId || (e.kind !== 'done' && e.kind !== 'job')) return;
        const j = store.jobs.get(jobId);
        if (ended(j)) { this.off('event', check); resolve(j); }
      };
      this.on('event', check);
    });
  }

  waitFor(projectId: string, jobId: string): Promise<KeeperJob> {
    return new Promise((resolve) => {
      const check = (e: KeeperEvent) => {
        if (e.projectId === projectId && e.jobId === jobId && e.kind === 'done') {
          this.off('event', check);
          resolve(this.storeOf(projectId).jobs.get(jobId)!);
        }
      };
      this.on('event', check);
    });
  }

  private usageOf(session: AgentSession): Usage {
    try {
      const s = session.getSessionStats();
      return { input: s.tokens.input, output: s.tokens.output, cacheRead: s.tokens.cacheRead, cacheWrite: s.tokens.cacheWrite, cost: Number.isFinite(s.cost) ? s.cost : null };
    } catch {
      return zeroUsage();
    }
  }

  private async contentSnapshot(project: Project): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const repos = project.scope.filter((i) => i.category === 'Repository' && i.relation !== 'Excluded' && !i.missing);
    const states = await Promise.all(repos.map(async (repo) => [repo.path, await gitStatusAsync(repo.path)] as const));
    for (const [path, st] of states) if (st) out.set(path, `${st.head}|${st.dirty.join('\n')}`);
    return out;
  }

  private contentDiff(before: Map<string, string>, after: Map<string, string>): string[] {
    const out: string[] = [];
    for (const [path, value] of after) if (before.get(path) !== value) out.push(`${path}: git state changed`);
    return out;
  }

  resourceChangesOf(projectId: string): readonly { at: string; jobId: string; detail: string }[] { return this.resourceChanges.get(projectId) ?? []; }

  /** §6.10 resources pi loads for this project, and whether project-local ones are trusted. */
  async resources(project: Project): Promise<{ resources: { kind: string; name: string; path: string | null }[]; projectTrusted: boolean | null; trustDecision: string }> {
    const cwd = project.locations[0]!;
    const settingsManager = SettingsManager.create(cwd, getAgentDir());
    const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager });
    await loader.reload();
    const resources: { kind: string; name: string; path: string | null }[] = [];
    const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
    const ext = loader.getExtensions();
    for (const e of ext.extensions) if (!e.hidden) resources.push({ kind: 'extension', name: base(e.path), path: e.resolvedPath ?? e.path });
    for (const err of ext.errors) resources.push({ kind: 'extension error', name: err.error, path: err.path });
    for (const s of loader.getSkills().skills) resources.push({ kind: 'skill', name: s.name, path: s.filePath });
    for (const p of loader.getPrompts().prompts as { name: string; filePath?: string }[]) resources.push({ kind: 'prompt template', name: p.name, path: p.filePath ?? null });
    for (const f of loader.getAgentsFiles().agentsFiles) resources.push({ kind: 'context file', name: base(f.path), path: f.path });
    const sys = loader.getSystemPromptSource();
    if (sys) resources.push({ kind: 'system prompt', name: base(sys.path), path: sys.path });
    for (const a of loader.getAppendSystemPromptSources()) resources.push({ kind: 'appended system prompt', name: base(a.path), path: a.path });
    let trustDecision = 'unknown';
    try { const d = new ProjectTrustStore(getAgentDir()).get(cwd); trustDecision = d == null ? 'not decided yet' : String(d); } catch { /* keep unknown */ }
    return { resources, projectTrusted: trustDecision === 'yes' ? true : trustDecision === 'no' ? false : null, trustDecision };
  }

  capabilities() { return PI_CAPABILITIES; }

  /** Launch native pi in the project directory, resuming a Keeper session when one is given. */
  openInPi(project: Project, sessionFile: string | null): { message: string } {
    const cwd = project.locations[0]!;
    const args = ['pi', ...(sessionFile ? ['--session', sessionFile] : [])];
    try {
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', '"ProjectKeeper · pi"', 'cmd', '/k', ...args], { cwd, detached: true, stdio: 'ignore', windowsHide: false, shell: false }).unref();
      } else {
        spawn('sh', ['-c', `${args.join(' ')}`], { cwd, detached: true, stdio: 'ignore' }).unref();
      }
      return { message: `Opened pi in ${cwd}${sessionFile ? ' with the Keeper session' : ''}` };
    } catch (e) {
      return { message: `Could not open pi: ${(e as Error).message}` };
    }
  }

  usageSummary(projectId: string): { total: Usage; byJob: { id: string; kind: string; label: string; startedAt: string | null; model: string | null; usage: Usage }[] } {
    const jobs = this.storeOf(projectId).jobs.all();
    const total = jobs.reduce<Usage>((acc, j) => ({ input: acc.input + j.usage.input, output: acc.output + j.usage.output, cacheRead: acc.cacheRead + j.usage.cacheRead, cacheWrite: acc.cacheWrite + j.usage.cacheWrite, cost: j.usage.cost == null ? acc.cost : (acc.cost ?? 0) + j.usage.cost }), zeroUsage());
    return { total, byJob: jobs.filter((j) => j.startedAt).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, 100).map((j) => ({ id: j.id, kind: j.kind, label: j.scope.label, startedAt: j.startedAt, model: j.model ? `${j.model.provider}/${j.model.id}` : null, usage: j.usage })) };
  }

  /**
   * Stop everything the Keeper is doing for a project and wait until what was running has ended (Spec §3.7 清空:
   * 有整理正在进行时，先停下再清). What had not started is stopped where it stands; what runs is aborted, and this
   * returns once no lane of the project holds a job, or after `timeoutMs`. Returns how many jobs it stopped.
   */
  async stopProject(projectId: string, timeoutMs = 60_000): Promise<number> {
    const store = this.storeOf(projectId);
    const active = store.jobs.filter((j) => j.status === 'Queued' || j.status === 'Running' || j.status === 'Paused' || j.status === 'Waiting for quota');
    for (const j of active) {
      const current = store.jobs.get(j.id);
      if (!current || !(current.status === 'Queued' || current.status === 'Running' || current.status === 'Paused' || current.status === 'Waiting for quota')) continue;
      // A record of the program's own work (a round, its ledger step) is in no lane: it is closed where it stands.
      if (!this.stopJob(projectId, j.id) && current.agent === 'program') store.jobs.put({ ...current, status: 'Stopped', endedAt: new Date().toISOString() }, { jobId: j.id, summary: 'Stopped: the project is being cleared' });
    }
    const busy = () => (this.lanes.has(projectId) ? this.allLanes(projectId).some((l) => l.running !== null) : false);
    const until = Date.now() + timeoutMs;
    while (busy() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return active.length;
  }

  /** Drop what the runtime holds in memory for a project whose assets were cleared: its live conversations and its notices. */
  forgetProject(projectId: string): void {
    for (const [key, entry] of [...this.live]) {
      if (!key.startsWith(`conversation:${projectId}:`)) continue;
      try { entry.session.dispose(); } catch { /* already gone */ }
      this.live.delete(key);
    }
    this.resourceChanges.delete(projectId);
    this.lastError.delete(projectId);
    this.emitEvent({ projectId, jobId: '', kind: 'status' });
  }

  private emitEvent(event: KeeperEvent): void { this.emit('event', event); }
}
