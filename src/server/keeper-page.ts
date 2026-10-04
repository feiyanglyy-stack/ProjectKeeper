/**
 * The `Keeper` view as two pages (Spec §6.10, §3.7, §3.8; D105; CKC-03 AC-12, CKC-13 AC-19, AC-23, AC-37～AC-41,
 * CKC-07 AC-28～AC-30): `Takeover` — choose a depth, `Start`, the progress as the Keeper works, the briefing at the end,
 * `Clear` — and `Daily` — the schedule the owner sets, `Follow up` now, one line of status.
 *
 * Everything here is read from the record: where the takeover stands and which depth ran come from the rounds
 * (takeover-state.ts), the schedule from what the owner saved (schedule.ts), the briefing's numbers from the assets.
 * The briefing's words are the ones the takeover's synthesis wrote into the assets — the product overview, each area's
 * understanding, the notes — put together by the program; nothing in it is written for the page alone.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ownerScopeItems, type App } from './app.ts';
import { HttpApp, HttpError } from './http.ts';
import type { ContextPackage, ContextRequest, KeeperJob, OrganizeSchedule, Project, Usage } from '../model/types.ts';
import type { ClerkRound } from '../model/k-types.ts';
import type { TakeoverDepth } from '../model/vocab.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { roundDepth, takeoverState, startRefusal, type TakeoverState } from '../keeper/organize/takeover-state.ts';
import { DAY_NAMES, SCHEDULE_FREQUENCIES, parseSchedule, scheduleText } from '../keeper/organize/schedule.ts';
import { nextScheduled, scheduleInForce } from '../keeper/organize/schedule-state.ts';
import { organizingHeld } from '../keeper/held.ts';
import { needsYou } from './graph-view.ts';
import { internalRefs, laneNamesOf } from '../keeper/owner-text.ts';
import { roundsView } from './k-views.ts';
import { projectFolderState, type ProjectFolderState } from './project-folder-api.ts';

// ───────────────────────── the three depths, as the page says them (§3.7 选择深度) ─────────────────────────

/** What the Keeper does at each depth, and what the owner gets beyond the first usable picture: fixed interface text. */
export const DEPTH_TEXT: Readonly<Record<TakeoverDepth, { readonly does: string; readonly gains: string }>> = {
  Full: {
    does: 'Digs the whole history by question: a lane for each plan or stage and for each topic orientation finds, including deleted documents, side branches, everything you said in the sessions, every receipt and report; the code as it stands across every territory. Every material planned for a close reading is accounted for — read, or said to be read in part or not needed, with why — before the cross-check.',
    gains: 'The full lineage of every item; intent that was buried and requirements that were dropped; the complete course and checks of every piece of work; the anomalies of every code territory.',
  },
  Focused: {
    does: 'Digs only what the current objects, the work still open, and the breakpoint candidates and anomalies the program computed involve, with the history they directly touch. The rest of the history stays in the ledger and is read when needed.',
    gains: 'The lineage of the current objects; the course of the work in progress; how each anomaly came about.',
  },
  'First picture only': {
    does: 'No deepening. New changes enter daily organizing as usual; history is read only when an investigation or a question needs it.',
    gains: 'Nothing beyond the first usable picture, and no extra cost.',
  },
};

/** What a takeover does, said before it starts (§6.10 还没开始): fixed interface text. */
export const TAKEOVER_INTRO = 'A takeover draws the project’s boundary, forms a first usable picture — the product, its areas, the planned work, the graph — then digs the history to the depth you choose, and ends with a briefing here. The Keeper reads the project; it does not change the project’s files. Nothing runs until you press Start.';

// ───────────────────────── small helpers ─────────────────────────

const zero: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
const addCost = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
const addUsage = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: addCost(a.cost, b.cost) });
const modelText = (j: KeeperJob): string | null => (j.model ? `${j.model.provider}/${j.model.id}` : null);

/** The jobs of a round: its steps, and everything they sent. */
export function roundJobs(store: ProjectStore, round: ClerkRound): KeeperJob[] {
  const all = store.jobs.all();
  const steps = all.filter((j) => j.step?.roundId === round.id);
  const seen = new Map(steps.map((j) => [j.id, j]));
  let frontier = steps.map((j) => j.id);
  while (frontier.length) {
    const kids = all.filter((j) => j.parentJobId !== null && frontier.includes(j.parentJobId) && !seen.has(j.id));
    for (const k of kids) seen.set(k.id, k);
    frontier = kids.map((k) => k.id);
  }
  return [...seen.values()];
}

export interface RoundRow {
  readonly id: string;
  readonly number: number;
  readonly kind: ClerkRound['kind'];
  readonly depth: TakeoverDepth | null;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly wallMs: number;
  readonly cost: number | null;
  readonly models: readonly string[];
  readonly startedBy: string | null;
}

/** One row for a round: which kind, when, its status, its time and cost, the models that ran it. */
export function roundRow(store: ProjectStore, round: ClerkRound, now = Date.now()): RoundRow {
  const jobs = roundJobs(store, round).filter((j) => j.agent !== 'program');
  return {
    id: round.id, number: round.number, kind: round.kind, depth: round.kind === 'First usable' ? 'First picture only' : roundDepth(round, store.jobs.get(round.rootJobId)),
    status: round.status, startedAt: round.startedAt, endedAt: round.endedAt,
    wallMs: (round.endedAt ? Date.parse(round.endedAt) : now) - Date.parse(round.startedAt),
    cost: jobs.reduce<number | null>((c, j) => addCost(c, j.usage.cost), null),
    models: [...new Set(jobs.map(modelText).filter((m): m is string => m !== null))],
    startedBy: round.startedBy ?? null,
  };
}

/**
 * Text the Keeper wrote, for the owner, without what the owner-text check finds (Spec §6.13 不露内部标识; owner-text.ts):
 * a store id, a lane named as a lane, a section of a lane's report. The briefing is put together by the program, which
 * cannot send the words back to be written again, so what the check finds is taken out, with the brackets it leaves.
 */
export function withoutInternalIds(text: string, laneNames: readonly string[] = []): string {
  let out = text;
  for (const r of internalRefs({ text }, laneNames)) out = out.split(r.text).join('');
  return out.replace(/[（(]\s*[、,，;；]?\s*[)）]/g, '').replace(/[ \t]{2,}/g, ' ').trim();
}
/** The first sentence of a text, in either punctuation. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\*\*[^*]+\*\*\s*/g, '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[。！？!?]|.+?\.(?=\s|$))/.exec(flat);
  return (m ? m[1]! : flat).trim();
}

// ───────────────────────── the briefing (§3.7 接手简报; CKC-13 AC-39) ─────────────────────────

export interface TakeoverBriefing {
  /** What this project is: the product overview the takeover recorded. */
  readonly project: { readonly name: string; readonly text: string | null; readonly nodeId: string | null };
  /** The areas, one sentence each; each opens on the graph. */
  readonly areas: readonly { readonly nodeId: string; readonly name: string; readonly sentence: string }[];
  /** Where the work stands: under each plan, how many items are done, under way, not started, on hold; and what is under way now. */
  readonly work: {
    readonly plans: readonly { readonly nodeId: string | null; readonly name: string; readonly progress: string | null; readonly done: number; readonly inProgress: number; readonly notStarted: number; readonly onHold: number; readonly total: number }[];
    readonly noPlan: { readonly done: number; readonly inProgress: number; readonly notStarted: number; readonly onHold: number; readonly total: number };
    readonly underWay: readonly { readonly nodeId: string; readonly name: string }[];
  };
  /** What waits for the owner's decision: one line each, opening the note or the scope question itself. */
  readonly waiting: readonly { readonly kind: 'note' | 'scope-question'; readonly id: string; readonly text: string }[];
  /** What was read and what it cost. */
  readonly read: {
    readonly depth: TakeoverDepth | null;
    readonly models: readonly string[];
    readonly levels: readonly { readonly level: string; readonly materials: number; readonly byKind: Readonly<Record<string, number>> }[];
    readonly historyNotOrganized: number;
    readonly missingSourceKinds: readonly { readonly kind: string; readonly reason: string }[];
    readonly rounds: readonly RoundRow[];
    readonly total: { readonly wallMs: number; readonly cost: number | null };
  };
}

export function takeoverBriefing(store: ProjectStore, project: Project, state: TakeoverState): TakeoverBriefing {
  const lanes = laneNamesOf(store);
  const clean = (text: string) => withoutInternalIds(text, lanes);
  const nodeOfRef = new Map(store.nodes.all().map((n) => [n.refId, n]));
  const current = <T extends { validity?: string }>(x: T) => !x.validity || x.validity === 'Current';
  const product = store.reference.filter((r) => r.category === 'Product' && current(r))[0] ?? null;
  const areas = store.reference.filter((r) => r.category === 'Area' && current(r)).map((r) => {
    const u = store.areas.find((a) => a.referenceId === r.id);
    return { nodeId: nodeOfRef.get(r.id)?.id ?? r.id, name: r.name, sentence: clean(firstSentence(u?.effectNow || r.text || '')) };
  });
  // Work by plan: a work item belongs to the plans it has a relation to on the graph.
  const planRefs = store.reference.filter((r) => r.category === 'Plan' && current(r));
  const planNode = new Map(planRefs.map((p) => [nodeOfRef.get(p.id)?.id ?? p.id, p]));
  const threads = store.threads.filter((t) => t.validity === 'Current');
  const threadIds = new Set(threads.map((t) => t.id));
  const plansOf = new Map<string, Set<string>>();
  for (const r of store.relations.all()) {
    const [work, plan] = threadIds.has(r.from) && planNode.has(r.to) ? [r.from, r.to] : threadIds.has(r.to) && planNode.has(r.from) ? [r.to, r.from] : [null, null];
    if (!work || !plan) continue;
    if (!plansOf.has(work)) plansOf.set(work, new Set());
    plansOf.get(work)!.add(plan);
  }
  const tally = () => ({ done: 0, inProgress: 0, notStarted: 0, onHold: 0, total: 0 });
  const count = (t: ReturnType<typeof tally>, progress: string) => {
    t.total += 1;
    if (progress === 'Done') t.done += 1; else if (progress === 'In progress') t.inProgress += 1; else if (progress === 'On hold') t.onHold += 1; else t.notStarted += 1;
  };
  const byPlan = new Map([...planNode.keys()].map((id) => [id, tally()]));
  const noPlan = tally();
  for (const t of threads) {
    const plans = plansOf.get(t.id);
    if (!plans?.size) { count(noPlan, t.progress); continue; }
    for (const p of plans) count(byPlan.get(p)!, t.progress);
  }
  const waiting = needsYou(store, project)
    .filter((x) => (x.kind === 'note' && x.ask === 'For your decision') || x.kind === 'scope-question')
    .map((x) => ({ kind: x.kind as 'note' | 'scope-question', id: x.id, text: x.kind === 'note' ? clean(x.label) : x.label }));
  const rounds = state.rounds.map((r) => roundRow(store, r));
  const tk = store.coverage.takeover ?? null;
  return {
    project: { name: product?.name ?? project.name, text: product ? clean(product.text) : null, nodeId: product ? nodeOfRef.get(product.id)?.id ?? product.id : null },
    areas,
    work: {
      plans: [...planNode.entries()].map(([nodeId, p]) => ({ nodeId, name: p.name, progress: p.progress ?? null, ...byPlan.get(nodeId)! })),
      noPlan,
      underWay: threads.filter((t) => t.progress === 'In progress').map((t) => ({ nodeId: t.id, name: `${t.ids[0] ? `${t.ids[0]} ` : ''}${t.title}` })),
    },
    waiting,
    read: {
      depth: state.ran, models: [...new Set(rounds.flatMap((r) => r.models))],
      levels: (tk?.levels ?? []).filter((l) => l.materials > 0).map((l) => ({ level: l.level, materials: l.materials, byKind: l.byKind })),
      historyNotOrganized: tk?.historyNotOrganized ?? 0,
      missingSourceKinds: store.coverage.missingSourceKinds,
      rounds,
      total: { wallMs: rounds.reduce((n, r) => n + r.wallMs, 0), cost: rounds.reduce<number | null>((c, r) => addCost(c, r.cost), null) },
    },
  };
}

// ───────────────────────── Clear: what goes and what stays (§3.7 清空; CKC-13 AC-40) ─────────────────────────

export interface ClearPreview {
  readonly removed: readonly { readonly what: string; readonly count: number | null; readonly note?: string }[];
  /** Decisions and corrections the owner gave only to the Keeper — in the conversation or on a note — not in the project's documents. */
  readonly ownerOnly: number;
  readonly running: number;
  readonly kept: readonly { readonly what: string; readonly detail: string }[];
}

export function clearPreview(app: App, projectId: string): ClearPreview {
  const store = app.store(projectId);
  const project = app.project(projectId);
  const notes = store.notes.all();
  const versions = notes.reduce((n, x) => n + x.versions.length, 0);
  const discussion = notes.reduce((n, x) => n + x.discussion.length, 0);
  const responses = notes.filter((x) => x.ownerResponse !== null).length;
  // What the owner said to the Keeper and nowhere else: messages in the Keeper conversation, replies on notes, responses.
  const ownerMessages = store.sources.filter((s) => s.said?.by === 'owner' && s.anchor.kind === 'session' && (s.anchor as { host?: string }).host === 'pi').length;
  const ownerReplies = notes.reduce((n, x) => n + x.discussion.filter((d) => d.role === 'owner').length, 0);
  const conversations = app.conversation.sessions(projectId).length;
  const spent = app.keeper.usageSummary(projectId).total;
  const prior = project.usageBeforeClear?.usage ?? null;
  const total = prior ? addUsage(prior, spent) : spent;
  const folders = store.authorizations.filter((a) => a.projectFolder != null).map((a) => a.projectFolder!.path);
  const usual = project.locations[0] ? join(project.locations[0], 'projectkeeper') : null;
  const folder = folders[0] ?? (usual && existsSync(usual) ? usual : null);
  let inside: string[] = [];
  if (folder && existsSync(folder)) { try { inside = readdirSync(folder).sort(); } catch { inside = []; } }
  const active = store.jobs.filter((j) => j.status === 'Queued' || j.status === 'Running' || j.status === 'Paused' || j.status === 'Waiting for quota' ).length;
  return {
    removed: [
      { what: 'Scope items the Keeper worked out', count: project.scope.length - ownerScopeItems(project).length, note: project.scopeQuestions.length ? `and ${project.scopeQuestions.length} scope question${project.scopeQuestions.length === 1 ? '' : 's'} with ${project.scopeQuestions.filter((q) => q.answer).length} of your answers` : undefined },
      { what: 'Sources read (anchors and excerpts)', count: store.sources.size },
      { what: 'The ledger of the project’s history', count: null, note: existsSync(app.ledger.file(projectId)) ? 'built; it can be computed again from the project' : 'not built yet' },
      { what: 'Product reference items', count: store.reference.size },
      { what: 'Work items, with their course', count: store.threads.size },
      { what: 'Graph nodes and relations', count: store.nodes.size + store.relations.size },
      { what: 'Notes', count: notes.length, note: `${versions} version${versions === 1 ? '' : 's'}, ${discussion} discussion entr${discussion === 1 ? 'y' : 'ies'}, ${responses} of your responses` },
      { what: 'Change records', count: store.changes.size },
      { what: 'Entry marks, breakpoints and send-backs', count: store.marks.size + store.breakpoints.size + store.sendbacks.size },
      { what: 'Judgement records and the trace of every write', count: store.judgements.size },
      { what: 'Rounds, with their briefs, reports and adoption records', count: store.clerkRounds.size, note: `${store.roundDocs.size} document${store.roundDocs.size === 1 ? '' : 's'}, ${store.jobs.size} piece${store.jobs.size === 1 ? '' : 's'} of Keeper work` },
      { what: 'Context packs', count: store.contexts.size },
      { what: 'Keeper conversations for this project', count: conversations, note: 'pi’s own session files stay in pi’s folder' },
      { what: 'Standing authorizations', count: store.authorizations.size, note: store.authorizations.size ? 'the Keeper needs your Project folder authorization again before it writes the folder in the project' : undefined },
    ],
    ownerOnly: ownerMessages + ownerReplies + responses,
    running: active,
    kept: [
      { what: 'The project’s own files and version control', detail: `Nothing in ${project.locations.join(', ')} is touched.` },
      { what: 'The ProjectKeeper folder inside the project', detail: folder ? `${folder} stays where it is${inside.length ? `, with ${inside.join(', ')}` : ' (empty or not written yet)'}. Remove it in the project yourself if you want it gone.` : 'There is none in this project.' },
      { what: 'The project in the workspace', detail: `Its name (${project.name}), the location${project.locations.length === 1 ? '' : 's'} you gave, and the ${ownerScopeItems(project).length} scope item(s) you added yourself.` },
      { what: 'The settings of the Keeper view', detail: 'The Keeper agent, the model and keys, the schedule, execution-agent access.' },
      { what: 'What was spent so far', detail: `${total.cost == null ? 'Cost not reported' : `$${total.cost.toFixed(2)}`} (${total.input.toLocaleString('en-US')} tokens in, ${total.output.toLocaleString('en-US')} out) stays in Usage as one total, named as from before the clear.` },
    ],
  };
}

// ───────────────────────── the page ─────────────────────────

export interface KeeperPageView {
  /** §6.10 the header: which of the three the project is in. */
  readonly state: 'Not taken over' | 'Takeover under way' | 'Daily';
  /** The page that opens: `takeover` until the takeover is done, `daily` from then on. */
  readonly page: 'takeover' | 'daily';
  readonly takeover: {
    readonly phase: TakeoverState['phase'];
    readonly intro: string;
    readonly chosen: TakeoverDepth | null;
    readonly ran: TakeoverDepth | null;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly options: readonly { readonly depth: TakeoverDepth; readonly does: string; readonly gains: string; readonly selectable: boolean; readonly why: string | null; readonly ran: boolean; readonly chosen: boolean }[];
    /** Whether a model with a usable key is there, and which model new work would run on. */
    readonly key: { readonly usable: boolean; readonly model: string | null; readonly keyName: string | null; readonly thinking: string | null; readonly reason: string | null };
    /** While it is under way: the stage of the takeover (§3.7) — drawing the boundary, the first usable picture, deepening. */
    readonly stage: string | null;
    /** The round under way or last run, as `Keeper activity` shows it: its steps, the main agent's stage, its lanes. */
    readonly round: ReturnType<typeof roundsView>[number] | null;
    readonly rounds: readonly RoundRow[];
    readonly total: { readonly wallMs: number; readonly cost: number | null; readonly models: readonly string[] };
    /** What waits for the owner while it runs: scope questions and notes for decision, each opening itself. */
    readonly waiting: TakeoverBriefing['waiting'];
    readonly briefing: TakeoverBriefing | null;
  };
  readonly daily: {
    readonly available: boolean;
    readonly why: string | null;
    readonly schedule: OrganizeSchedule;
    readonly scheduleText: string;
    readonly nextAt: string | null;
    readonly frequencies: readonly string[];
    readonly dayNames: readonly string[];
    readonly lastRound: (RoundRow & { readonly nothingNew: boolean | null; readonly statement: string | null; readonly resultId: string | null }) | null;
    readonly lastTime: Project['scheduleHandled'];
    readonly pending: number;
    readonly paused: boolean;
    readonly running: RoundRow | null;
  };
  readonly usageBeforeClear: Project['usageBeforeClear'];
  /** The project-folder authorization (§1.14): what it allows, whether it stands, and the control's state. */
  readonly projectFolder: ProjectFolderState;
}

/**
 * The key and model a takeover would run on (§6.10 第一次用; CKC-03 AC-36): the project's main key and model when that
 * key can be used, else the key standing in for it. No usable key at all — none configured, every one refused or out of
 * quota — and `Start` cannot be pressed. A key is usable when it has credentials and is not out of quota or refused.
 */
export async function takeoverKey(app: App, projectId: string): Promise<KeeperPageView['takeover']['key']> {
  if (!app.keeper.ready) return { usable: false, model: null, keyName: null, thinking: null, reason: 'The Keeper runtime is not attached.' };
  const provider = await app.keeper.providerState(projectId).catch(() => null);
  const keys = await app.keeper.keysView().catch(() => []);
  const usable = (id: string) => { const k = keys.find((x) => x.id === id); return Boolean(k && (k.state.status === 'Usable' || k.state.status === 'Rate-limited')); };
  const m = provider?.model ?? null;
  if (!provider?.connected || !m || !usable(m.provider)) {
    const any = keys.some((k) => usable(k.id));
    return { usable: false, model: null, keyName: null, thinking: null, reason: any ? 'The key chosen for this project cannot be used now: choose another in Model provider below.' : 'No usable key: add one in Model provider below — choose the provider, paste the key, Save.' };
  }
  return { usable: true, model: `${m.provider}/${m.id}`, keyName: keys.find((k) => k.id === m.provider)?.name ?? m.provider, thinking: m.thinking ?? null, reason: null };
}

export async function keeperPageView(app: App, projectId: string, now = Date.now()): Promise<KeeperPageView> {
  const store = app.store(projectId);
  const project = app.project(projectId);
  const state = takeoverState(store, project);
  const key = await takeoverKey(app, projectId);
  const all = store.clerkRounds.all().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const views = roundsView(store);
  const latestTakeover = state.rounds[state.rounds.length - 1] ?? null;
  const rounds = state.rounds.map((r) => roundRow(store, r, now));
  const first = state.rounds.find((r) => r.kind === 'First usable');
  const stage = state.phase !== 'Under way' ? null : !first ? 'Drawing the boundary and reading the material' : first.status !== 'Done' ? 'First usable picture' : `Deepening (${state.chosen})`;
  const waiting = needsYou(store, project)
    .filter((x) => (x.kind === 'note' && x.ask === 'For your decision') || x.kind === 'scope-question')
    .map((x) => ({ kind: x.kind as 'note' | 'scope-question', id: x.id, text: x.kind === 'note' ? withoutInternalIds(x.label, laneNamesOf(store)) : x.label }));
  // Daily: the last round that closed, whichever kind, and what started it.
  const closed = all.filter((r) => r.endedAt).sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))[0] ?? null;
  const record = closed?.followUpRoundId ? store.rounds.get(closed.followUpRoundId) ?? null : null;
  const news = record?.result?.news ?? null;
  const runningRound = all.find((r) => r.status === 'Running') ?? null;
  const schedule = scheduleInForce(project, state.completedAt);
  const scope = store.coverage.scopes.find((s) => s.id === 'project');
  const done = state.phase === 'Done';
  const next = done && !organizingHeld(project) ? nextScheduled(project, state.completedAt, now) : null;
  return {
    state: state.phase === 'Not started' ? 'Not taken over' : done ? 'Daily' : 'Takeover under way',
    page: done ? 'daily' : 'takeover',
    takeover: {
      phase: state.phase, intro: TAKEOVER_INTRO, chosen: state.chosen, ran: state.ran, startedAt: state.startedAt, completedAt: state.completedAt,
      options: state.options.map((o) => ({ ...o, ...DEPTH_TEXT[o.depth] })),
      key, stage,
      round: latestTakeover ? views.find((v) => v.id === latestTakeover.id) ?? null : null,
      rounds,
      total: { wallMs: rounds.reduce((n, r) => n + r.wallMs, 0), cost: rounds.reduce<number | null>((c, r) => addCost(c, r.cost), null), models: [...new Set(rounds.flatMap((r) => r.models))] },
      waiting,
      briefing: done ? takeoverBriefing(store, project, state) : null,
    },
    daily: {
      available: done,
      why: done ? null : state.phase === 'Not started' ? 'Daily organizing begins once the takeover is done. Choose a depth and press Start on the Takeover page.' : 'Daily organizing begins once the takeover is done; it is still under way on the Takeover page.',
      schedule, scheduleText: scheduleText(schedule), nextAt: next ? next.toISOString() : null,
      frequencies: SCHEDULE_FREQUENCIES, dayNames: DAY_NAMES,
      lastRound: closed ? { ...roundRow(store, closed, now), nothingNew: news ? news.nothingNew : null, statement: news ? news.statement : null, resultId: record?.result ? record.id : null } : null,
      lastTime: project.scheduleHandled ?? null,
      pending: scope?.pending.length ?? 0,
      paused: Boolean(project.organizingPaused),
      running: runningRound ? roundRow(store, runningRound, now) : null,
    },
    usageBeforeClear: project.usageBeforeClear ?? null,
    projectFolder: projectFolderState(app, projectId),
  };
}

/**
 * What an execution agent gets when it asks for the context of a project that has not been organized — just added, or
 * cleared (Spec §7.10, §3.7 清空; CKC-13 AC-41): the statement that it is not organized, never an empty pack.
 */
export function notOrganizedPackage(project: Project, request: ContextRequest, keeperStatus: string): ContextPackage {
  const at = new Date().toISOString();
  const markdown = [
    `# ${project.name}: not organized yet`,
    '',
    'ProjectKeeper has not organized this project: its owner has not started the takeover, or cleared what was organized. There is no project picture to give yet — this is not an empty pack, and nothing here says the project has no plans, work or decisions.',
    '',
    'Until the owner starts the takeover (workbench → Keeper → Takeover → choose a depth → Start), read the project itself.',
    '',
    `Project location${project.locations.length === 1 ? '' : 's'}: ${project.locations.join(', ')}`,
  ].join('\n');
  return { id: `ctx_not-organized-${project.id}`, projectId: project.id, request, asOf: at, commit: null, keeperStatus, markdown, citedSourceIds: [], generatedAt: at, deliveries: [] };
}

export function registerKeeperPageRoutes(http: HttpApp, app: App): void {
  http.route('GET', '/api/projects/:id/keeper-page', ({ params }) => keeperPageView(app, params.id!));
  // `Start` (§3.7; CKC-13 AC-19, AC-23): the depth chosen on the page; refused with the reason when it cannot start.
  http.route('POST', '/api/projects/:id/takeover/start', async ({ params, body }) => {
    const depth = (body as { depth?: unknown } | null)?.depth;
    const key = await takeoverKey(app, params.id!);
    const refusal = startRefusal(takeoverState(app.store(params.id!), app.project(params.id!)), depth, key.usable);
    if (refusal) throw new HttpError(409, refusal);
    app.startTakeover(params.id!, depth, true);
    return keeperPageView(app, params.id!);
  });
  // `Clear` (§3.7 清空; CKC-13 AC-40, AC-41): what would go and what stays, then the clearing itself, which takes `DELETE`.
  http.route('GET', '/api/projects/:id/takeover/clear', ({ params }) => clearPreview(app, params.id!));
  http.route('POST', '/api/projects/:id/takeover/clear', async ({ params, body }) => {
    const r = await app.clearProject(params.id!, (body as { confirm?: unknown } | null)?.confirm);
    return { cleared: true, stopped: r.stopped, leftBehind: r.leftBehind, page: await keeperPageView(app, params.id!) };
  });
  // The schedule (§3.8; CKC-07 AC-29): saved as given; what was changed and not saved has no effect.
  http.route('POST', '/api/projects/:id/keeper/schedule', async ({ params, body }) => {
    const parsed = parseSchedule(body);
    if ('error' in parsed) throw new HttpError(400, parsed.error);
    app.setSchedule(params.id!, parsed.schedule);
    return keeperPageView(app, params.id!);
  });
}
