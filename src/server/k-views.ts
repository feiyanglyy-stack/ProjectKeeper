/**
 * What the workbench receives for increment K (src/model/views-k.ts), assembled from the assets and — when the build
 * carries them — the ledger (src/ledger) and the process engines (src/process). Pure reads, apart from the owner's
 * `No action needed` on a breakpoint or a send-back.
 *
 * Every part that needs the ledger or the engines says so by what it leaves out rather than by inventing it: a work
 * item's steps stay empty until the engines can derive them, a document's versions until the ledger has read them.
 */
import { cliCommandFor, copyForAgentText } from '../keeper/sendback-text.ts';
import type { ProjectStore } from '../store/project-store.ts';
import type { Authorization, KeeperJob, Project, Usage } from '../model/types.ts';
import type { Breakpoint, Occurred, SemanticPatch, SendBack, SixThing, StepTiming } from '../model/k-types.ts';
import type {
  BreakpointView, CodeView, DocCurrentView, FourThingsView, GenerationBandView, GenerationPlanTextView, LineageView, PatchView, PlanShapeView,
  ProcessStepView, ProcessView, RoundDocView, RoundStepView, RoundView, ScopeKView, SendBackView, TerritoryDetailView, VersionsView,
  WorkProcessView, WorkTerritoryView,
} from '../model/views-k.ts';
import { codeMapEngines, type CodeMapEngines } from '../codemap/engines.ts';
import { MAX_DOC_BYTES } from '../ledger/docs.ts';
import { MAX_LOOSE_BYTES } from '../ledger/rebuild.ts';
import { patchBrief } from '../context/k-briefs.ts';
import { generationPlanDocs, generationPlanIds } from '../process/generations.ts';
import { isCandidate } from '../process/breakpoints.ts';
import { anchorLabel } from '../sources/anchor.ts';
import type { App } from './app.ts';
import { draftRefsOfJob } from './drafts-api.ts';
import { isMainAgentRound, mainAgentParts, mainDocsOf } from './k-rounds-d99.ts';
import { looksAtStandingNotes, standingCounts } from '../keeper/organize/standing-notes.ts';
import { HttpError, optionalString, requireString, type HttpApp } from './http.ts';
import { roundDepth } from '../keeper/organize/takeover-state.ts';
import { carriedOn } from '../keeper/organize/carried-on.ts';

/** The ledger and the process engines as the views use them; absent until a build carries them. */
export interface KEngines {
  readonly ledger?: {
    coverage(project: Project): ScopeKView['ledger'];
    versions(store: ProjectStore, project: Project, objectId: string): VersionsView | null;
    lineage(store: ProjectStore, project: Project, objectId: string): LineageView | null;
    docCurrent(store: ProjectStore, project: Project, objectId: string): DocCurrentView | null;
    code(store: ProjectStore, project: Project): CodeView | null;
    territory(store: ProjectStore, project: Project, territoryId: string): TerritoryDetailView | null;
  } | null;
  readonly process?: {
    work(store: ProjectStore, project: Project, workId: string): { readonly steps: readonly ProcessStepView[]; readonly four: FourThingsView } | null;
    plan(store: ProjectStore, project: Project, planId: string): PlanShapeView | null;
    /** The work item a work item is a step of (a fix or a check of it), or null. */
    stepOf?(store: ProjectStore, project: Project, workId: string): string | null;
    /** An earlier generation's plan document as it stood (§2.12, D82): its `index` in `Generation.planRefs`, a page of it. */
    generationPlan?(store: ProjectStore, project: Project, generationId: string, index: number, fromLine?: number | null): GenerationPlanTextView | null;
  } | null;
  /**
   * The code map beside the ledger's own views (src/codemap/engines.ts): the territories each work changed, a territory's
   * paths gone from the current version, a file of the current version. `registerKRoutes` supplies it from the app's
   * ledger when the app's engines do not carry it.
   */
  readonly codemap?: CodeMapEngines | null;
  /** The text `Copy for agent` puts on the clipboard, and the CLI command in it (§1.18). */
  readonly copyForAgent?: (projectId: string, sendBack: SendBack, store: ProjectStore) => { readonly text: string; readonly command: string };
}

type FolderAuthorization = Authorization & { readonly projectFolder?: { readonly path: string; readonly commits: boolean; readonly lastWrite: { readonly at: string; readonly commit: string | null } | null } | null };

const noActionOf = (r: { readonly reason: string; readonly at: string } | null): { reason: string; at: string } | null => (r ? { reason: r.reason, at: r.at } : null);

export function breakpointView(b: Breakpoint): BreakpointView {
  return {
    id: b.id, kind: b.kind, targetId: b.targetId, why: b.why, since: b.since, evidence: b.evidence, basis: b.basis === 'Explicit' ? 'Explicit' : 'Inferred',
    lit: b.lit && !b.ownerResponse, ownerResponse: noActionOf(b.ownerResponse), sixThing: b.sixThing, sendBackId: b.sendBackId,
    state: b.lit && !b.ownerResponse ? 'Lit' : isCandidate(b) ? 'Candidate' : 'Out',
    looked: b.looked ? { where: b.looked.where, at: b.looked.at } : null, checked: b.checked ? { at: b.checked.at } : null,
  };
}

export { cliCommandFor } from '../keeper/sendback-text.ts';

/** An object's number as the process view shows it: the project's own first, else the one the Keeper gave (§1.19). */
function objectNumber(store: ProjectStore, id: string, projectIds: readonly string[]): { value: string; byKeeper: boolean } | null {
  if (projectIds.length) return { value: projectIds[0]!, byKeeper: false };
  const k = store.numbers.find((n) => n.objectId === id);
  return k ? { value: k.projectNumber ?? k.number, byKeeper: k.projectNumber === null } : null;
}

/**
 * The copy is the send-back text module's (Spec §1.18, §7.10): where, the evidence word for word, where to, and the
 * command that shows the same send-back, with credentials redacted, the same text `pk get` prints for it.
 */
function defaultCopy(store: ProjectStore, projectId: string, sb: SendBack): { text: string; command: string } {
  const thread = store.threads.get(sb.targetId);
  const ref = thread ? undefined : store.reference.get(sb.targetId);
  const label = thread?.title ?? ref?.name ?? null;
  const number = label ? objectNumber(store, sb.targetId, thread?.ids ?? ref?.ids ?? [])?.value ?? null : null;
  return { command: cliCommandFor(projectId, sb.id), text: copyForAgentText(projectId, sb, sb.evidence, { target: label ? { label, number } : null }) };
}

export function sendBackView(store: ProjectStore, projectId: string, sb: SendBack, engines: KEngines = {}): SendBackView {
  const copy = engines.copyForAgent ? engines.copyForAgent(projectId, sb, store) : defaultCopy(store, projectId, sb);
  const at = (o: Occurred) => o;
  return {
    id: sb.id, to: sb.to, stage: sb.stage, targetId: sb.targetId, what: sb.what, suggestion: sb.suggestion, evidence: sb.evidence, occurred: sb.occurred,
    returned: sb.returned ? { label: sb.returned.by.label, occurred: at(sb.returned.by.occurred ?? { at: sb.returned.at, basis: 'First observed', anchor: null }) } : null,
    closed: sb.closed ? { label: sb.closed.by.label, occurred: at(sb.closed.by.occurred ?? { at: sb.closed.at, basis: 'First observed', anchor: null }) } : null,
    ownerResponse: noActionOf(sb.ownerResponse), sixThing: sb.sixThing, copyForAgent: copy.text, cliCommand: copy.command,
    lit: sb.stage !== 'Closed' && !sb.ownerResponse,
    from: { kind: sb.from.kind, id: sb.from.id }, onTerritory: store.territories.has(sb.targetId),
  };
}

// ───────────────────────── the process view ─────────────────────────


export function processView(store: ProjectStore, project: Project, engines: KEngines = {}): ProcessView {
  const breakpoints = store.breakpoints.all().map(breakpointView);
  const sendBacks = store.sendbacks.all().sort((a, b) => a.occurred.at.localeCompare(b.occurred.at)).map((sb) => sendBackView(store, project.id, sb, engines));
  const litOn = new Map<string, string[]>();
  for (const b of breakpoints) if (b.lit) litOn.set(b.targetId, [...(litOn.get(b.targetId) ?? []), b.id]);
  const openOn = new Map<string, string[]>();
  for (const s of sendBacks) if (s.lit) openOn.set(s.targetId, [...(openOn.get(s.targetId) ?? []), s.id]);
  const sixOn = new Map<string, Set<SixThing>>();
  const tagSix = (id: string, t: SixThing | null | undefined) => { if (!t) return; if (!sixOn.has(id)) sixOn.set(id, new Set()); sixOn.get(id)!.add(t); };
  for (const m of store.marks.filter((x) => !x.closed)) tagSix(m.targetId, m.sixThing);
  for (const n of store.notes.filter((x) => x.status === 'Current')) for (const id of n.mount.ids) tagSix(id, n.sixThing);
  for (const b of breakpoints) if (b.lit) tagSix(b.targetId, b.sixThing);
  for (const s of sendBacks) if (s.lit) tagSix(s.targetId, s.sixThing);
  // A code anomaly counts where it is tagged; the two kinds §2.13 row 6 names are 6 even before anyone tags them.
  for (const t of store.territories.all()) for (const a of t.anomalies) tagSix(t.id, a.sixThing ?? (a.kind === 'Unreferenced' || a.kind === 'Looks residual, is live' ? 6 : null));
  // CZ: a work item carried on under the same number is current work: it belongs to no earlier generation here, though
  // its generation's band still lists it (with where it went).
  const carried = carriedOn(store);
  const generationOf = new Map<string, string>();
  for (const g of store.generations.all()) for (const w of g.workIds) if (!carried.has(w)) generationOf.set(w, g.id);
  const numberOf = (id: string, projectIds: readonly string[]): WorkProcessView['number'] => objectNumber(store, id, projectIds);
  // The territories each work changed, once for the whole view (CKC-25 AC-7): absent without a code map.
  const changedCode: Readonly<Record<string, readonly WorkTerritoryView[]>> | null = engines.codemap?.workTerritories(store, project) ?? null;

  const works: Record<string, WorkProcessView> = {};
  for (const t of store.threads.all()) {
    const derived = engines.process?.work(store, project, t.id) ?? null;
    const breakpointIds = litOn.get(t.id) ?? [];
    const sendBackIds = openOn.get(t.id) ?? [];
    const four: FourThingsView = derived?.four ?? {
      // Without the engine the ledger says nothing about execution, so none is shown rather than one guessed from progress.
      execution: null, progress: t.progress, check: null,
      open: { findings: 0, sendBacks: sendBackIds.length, breakpoints: breakpointIds.length },
    };
    const steps = derived?.steps ?? [];
    const sent = steps.filter((s) => s.sendBackId).length;
    works[t.id] = {
      workId: t.id, number: numberOf(t.id, t.ids), steps, four,
      folded: `${steps.length} step${steps.length === 1 ? '' : 's'}${sent ? ` · ${sent} send-back${sent === 1 ? '' : 's'}` : ''}${sendBackIds.length || breakpointIds.length || four.open.findings ? ' · open items' : steps.length ? ' · all closed' : ''}`,
      stepOf: engines.process?.stepOf?.(store, project, t.id) ?? null,
      generationId: generationOf.get(t.id) ?? null,
      struck: t.validity === 'Replaced' || t.validity === 'Abandoned' || t.validity === 'Deferred' ? { validity: t.validity, why: t.replacedBy ? `Replaced by ${t.replacedBy}` : t.unresolved || t.validity, byId: t.replacedBy } : null,
      breakpointIds, sendBackIds, sixThings: [...(sixOn.get(t.id) ?? [])],
      ...(changedCode ? { territories: changedCode[t.id] ?? [] } : {}),
    };
  }
  const plans: Record<string, PlanShapeView> = {};
  const docs: Record<string, DocCurrentView> = {};
  for (const r of store.reference.all()) {
    if (r.category === 'Plan') { const shape = engines.process?.plan(store, project, r.id); if (shape) plans[r.id] = shape; }
    if (['Product', 'Requirement', 'Design', 'Decision', 'Plan'].includes(r.category)) { const cur = engines.ledger?.docCurrent(store, project, r.id); if (cur) docs[r.id] = cur; }
  }
  // A plan with an execution shape is a unit of the List and the Graph too (its batches fold under it, CKC-24 AC-2): it
  // has no steps of its own, and its four things are what the plan item and what hangs on it say. Without this entry the
  // live List drew "No data" where the plan's execution order belongs (found while fixing QC AY B11).
  // An earlier generation's plans, by generation (its band draws them; the plan's unit names its generation).
  const bandPlans = new Map(store.generations.all().map((g) => [g.id, generationPlanIds(store, g)]));
  const planGeneration = new Map([...bandPlans].flatMap(([gid, ids]) => ids.map((id) => [id, gid] as const)));
  for (const [id, shape] of Object.entries(plans)) {
    if (works[id]) continue;
    const r = store.reference.get(id)!;
    const breakpointIds = litOn.get(id) ?? [];
    const sendBackIds = openOn.get(id) ?? [];
    works[id] = {
      workId: id, number: numberOf(id, r.ids), steps: [],
      four: { execution: null, progress: r.progress ?? '', check: null, open: { findings: 0, sendBacks: sendBackIds.length, breakpoints: breakpointIds.length } },
      folded: `${shape.batches.length} batch${shape.batches.length === 1 ? '' : 'es'}${shape.differs ? ' · execution differed from the plan' : ''}${sendBackIds.length || breakpointIds.length ? ' · open items' : ''}`,
      stepOf: null, generationId: planGeneration.get(id) ?? null,
      struck: r.validity === 'Replaced' || r.validity === 'Abandoned' || r.validity === 'Deferred' ? { validity: r.validity, why: r.replacedBy ? `Replaced by ${r.replacedBy}` : r.validity, byId: r.replacedBy } : null,
      breakpointIds, sendBackIds, sixThings: [...(sixOn.get(id) ?? [])],
    };
  }
  // An earlier generation's band holds its plans as well as its work (CKC-24 AC-18): the plan objects read from its plan
  // documents or planned into by its work, and the documents themselves, read as they stood when the band is unrolled.
  const generations: GenerationBandView[] = store.generations.all().sort((a, b) => a.ended.at.localeCompare(b.ended.at)).map((g) => {
    const items = g.workIds.flatMap((id) => store.threads.get(id) ?? []);
    const planIds = bandPlans.get(g.id) ?? [];
    return {
      id: g.id, name: g.name, started: g.started, ended: g.ended, endedBy: g.endedBy, workIds: g.workIds, carriedIds: g.workIds.filter((id) => carried.has(id)),
      planIds, plans: planIds.flatMap((id) => { const r = store.reference.get(id); return r ? [{ id, name: r.name, validity: r.validity }] : []; }),
      planDocs: generationPlanDocs(store, g),
      planned: items.length, done: items.filter((t) => t.progress === 'Done').length, struck: items.filter((t) => t.validity === 'Replaced' || t.validity === 'Abandoned' || t.validity === 'Deferred').length,
    };
  });
  const byKind: Record<string, number> = {};
  for (const b of breakpoints) if (b.lit) byKind[b.kind] = (byKind[b.kind] ?? 0) + 1;
  const ledgerAsOf = store.clerkRounds.all().filter((r) => r.ledger).map((r) => r.startedAt).sort().pop() ?? null;
  return {
    projectId: project.id, asOf: new Date().toISOString(), ledgerAsOf, works, plans, docs, generations, breakpoints, sendBacks,
    sixThings: ([1, 2, 3, 4, 5, 6] as SixThing[]).map((thing) => ({ thing, objectIds: [...sixOn].filter(([, s]) => s.has(thing)).map(([id]) => id) })),
    // Only lit breakpoints are findings (D99): candidates are counted apart and never shown red.
    counts: { breakpointsLit: breakpoints.filter((b) => b.lit).length, byKind, sendBacksOpen: sendBacks.filter((s) => s.lit).length, breakpointCandidates: breakpoints.filter((b) => b.state === 'Candidate').length },
  };
}

// ───────────────────────── a round in the Keeper view ─────────────────────────

const zero: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const addUsage = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost === null || b.cost === null ? (a.cost ?? b.cost) : a.cost + b.cost });
const addTiming = (a: StepTiming, b: StepTiming): StepTiming => ({ wallMs: a.wallMs + b.wallMs, generationMs: a.generationMs + b.generationMs, toolMs: a.toolMs + b.toolMs, queueMs: a.queueMs + b.queueMs, parseRetryMs: a.parseRetryMs + b.parseRetryMs, otherMs: a.otherMs + b.otherMs });

export function roundsView(store: ProjectStore): RoundView[] {
  const docsOf = (roundId: string, jobId: string | null) => store.roundDocs.filter((d) => d.roundId === roundId && (jobId === null || d.jobId === jobId)).map((d) => ({ id: d.id, kind: d.kind, title: d.title, path: d.path, at: d.at }));
  // A job's children are the jobs it sent that are not steps of the round themselves (an investigation, say): a lane the
  // main agent sent is a step of the round and stands under the main agent by `RoundView.lanes`.
  const stepView = (j: KeeperJob): RoundStepView => ({
    jobId: j.id, kind: j.step!.kind, label: j.scope.label, path: j.step!.path, status: j.status, model: j.model, startedAt: j.startedAt, endedAt: j.endedAt,
    timing: j.timing ?? null, usage: j.agent === 'program' ? null : j.usage, docs: docsOf(j.step!.roundId, j.id),
    children: store.jobs.filter((c) => c.parentJobId === j.id && c.step?.roundId !== j.step!.roundId).map((c) => ({ jobId: c.id, kind: j.step!.kind, label: c.scope.label, path: null, status: c.status, model: c.model, startedAt: c.startedAt, endedAt: c.endedAt, timing: c.timing ?? null, usage: c.usage, docs: [], children: [] })),
    // The session drafts the step wrote, each openable where the round is drilled into (CKC-23 AC-18).
    ...(j.step!.kind === 'session-drafts' ? { drafts: draftRefsOfJob(store, j.id) } : {}),
  });
  return store.clerkRounds.all().sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((r) => {
    const steps = store.jobs.filter((j) => j.step?.roundId === r.id).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    const timings = steps.flatMap((j) => (j.timing ? [j.timing] : []));
    // What the round spent includes the jobs its steps sent (an investigation, say); their time is already inside the
    // step that waited for them, so they add to the usage, not to the timing (QC AY). A lane is both a step and a job the
    // main agent sent: counted once.
    const descendants = (ids: readonly string[]): KeeperJob[] => { const kids = store.jobs.filter((c) => c.parentJobId !== null && ids.includes(c.parentJobId)); return kids.length ? [...kids, ...descendants(kids.map((k) => k.id))] : []; };
    const usageOf = (jobs: readonly KeeperJob[]): Usage => [...new Map(jobs.map((j) => [j.id, j])).values()].filter((j) => j.agent !== 'program').reduce((u, j) => addUsage(u, j.usage), zero);
    const usage = usageOf([...steps, ...descendants(steps.map((j) => j.id))]);
    const wallMs = r.endedAt ? Date.parse(r.endedAt) - Date.parse(r.startedAt) : Date.now() - Date.parse(r.startedAt);
    // With several paths at once a round lasts as long as its longest path (§3.10): the steps in sequence, each as long
    // as its slowest job. The main agent waits while its lanes run, so its own time already holds the longest lane.
    const byStep = new Map<string, number>();
    for (const j of steps) { if (j.step!.kind === 'lane') continue; const w = j.timing ? j.timing.wallMs + j.timing.queueMs : 0; byStep.set(j.step!.kind, Math.max(byStep.get(j.step!.kind) ?? 0, w)); }
    // A round the main agent runs (D99): its stages, its lanes, the coverage check and the missing steps looked for.
    const d99 = isMainAgentRound(r) ? mainAgentParts(store, r, steps, usageOf) : null;
    const views = steps.map(stepView).map((s) => (d99 && s.kind === 'main' ? { ...s, docs: mainDocsOf(s.docs, d99.lanes ?? []) } : s));
    // The sweeps the program added for the kinds of question orientation left out (CKC-23 AC-4), each with why and the
    // brief it composed: a document of this round no step's job wrote, so `docsOf` gives it to no step.
    const composed = (path: string) => store.roundDocs.find((d) => d.roundId === r.id && d.kind === 'Brief' && d.jobId === null && (d.path ?? d.title) === path);
    const sweepsAdded = (r.sweepsAdded ?? []).map((s) => { const d = composed(s.path); return { path: s.path, why: s.why, doc: d ? { id: d.id, kind: d.kind, title: d.title, path: d.path, at: d.at } : null }; });
    return {
      id: r.id, kind: r.kind, number: r.number, rootJobId: r.rootJobId, depth: roundDepth(r, store.jobs.get(r.rootJobId)), startedBy: r.startedBy ?? null, startedAt: r.startedAt, endedAt: r.endedAt, status: r.status, wallMs,
      longestPathMs: [...byStep.values()].reduce((n, x) => n + x, 0),
      timing: timings.length ? timings.reduce(addTiming) : null, usage,
      steps: views, outputs: r.outputs, groundwork: r.groundwork, unplaced: r.unplaced, spotCheck: r.spotCheck, ledger: r.ledger, folder: r.folder ?? null,
      // D103: what the round did with the notes standing from earlier rounds — as counted at its close, live while it runs.
      ...(looksAtStandingNotes(r) ? { standingNotes: r.standingNotes ?? (r.status === 'Running' ? standingCounts(store, r) : null) } : {}),
      ...(sweepsAdded.length ? { sweepsAdded } : {}),
      ...(d99 ?? {}),
    };
  });
}

export function roundDocView(store: ProjectStore, roundId: string, docId: string): RoundDocView | null {
  const d = store.roundDocs.get(docId);
  return d && d.roundId === roundId ? { id: d.id, roundId: d.roundId, kind: d.kind, title: d.title, path: d.path, markdown: d.markdown, at: d.at } : null;
}

// ───────────────────────── `Code` (§6.17) ─────────────────────────

/**
 * The `Code` view as the workbench receives it: the ledger's view of the territories, with what the code map and the assets
 * add — the paths a territory names that the current version no longer has (CKC-25 AC-10), the notes behind each anomaly's
 * `noteIds` by title (the jump to them, AC-7), and the send-backs its anomalies carry, so `Code` shows them without the
 * process view loaded first (QC AY B6). Null when the build has no ledger.
 */
export function codeViewOf(store: ProjectStore, project: Project, engines: KEngines = {}): CodeView | null {
  const base = engines.ledger?.code(store, project) ?? null;
  if (!base) return null;
  const gone = engines.codemap?.gonePaths(store, project) ?? {};
  const noteOf = (id: string) => {
    const n = store.notes.get(id);
    const v = n?.versions[n.versions.length - 1];
    return n && v ? [{ id: n.id, title: v.title, ask: v.ask, status: n.status }] : [];
  };
  const sendBacks: Record<string, SendBackView> = {};
  const territories = base.territories.map((t) => ({
    ...t,
    ...(gone[t.id]?.length ? { gonePaths: gone[t.id] } : {}),
    anomalies: t.anomalies.map((a) => {
      const sb = a.sendBackId ? store.sendbacks.get(a.sendBackId) : undefined;
      if (sb) sendBacks[sb.id] = sendBackView(store, project.id, sb, engines);
      return { ...a, notes: a.noteIds.flatMap(noteOf) };
    }),
  }));
  return { ...base, territories, sendBacks };
}

// ───────────────────────── semantic patches (§1.17; CKC-26 AC-4) ─────────────────────────

/** An object's name as the workbench shows it, whatever kind of asset it is. */
function objectLabel(store: ProjectStore, id: string): string {
  const s = store.sources.get(id);
  return store.nodes.get(id)?.label ?? store.reference.get(id)?.name ?? store.threads.get(id)?.title ?? store.territories.get(id)?.name
    ?? store.generations.get(id)?.name ?? store.layers.get(id)?.path ?? store.patches.get(id)?.title ?? (s ? anchorLabel(s.anchor) : id);
}

/** An object's name as the agent entry names it in a brief (server/k-agent-api.ts): the same words the CLI prints. */
const briefName = (store: ProjectStore, id: string): string => store.threads.get(id)?.title ?? store.reference.get(id)?.name ?? store.nodes.get(id)?.label
  ?? store.territories.get(id)?.name ?? store.patches.get(id)?.title ?? id;

/** A semantic patch as `Change log` and its details show it; `withText` adds the text `pk get SP-n` prints, word for word. */
export function patchView(store: ProjectStore, p: SemanticPatch, withText = false): PatchView {
  return {
    id: p.id, number: p.number, title: p.title, status: p.status, partial: p.partial, occurred: p.occurred,
    invalidated: p.invalidated, replacedBy: p.replacedBy, affects: p.affects.map((id) => ({ id, label: objectLabel(store, id) })), affectsText: p.affectsText,
    mustNotPassAsCurrent: p.mustNotPassAsCurrent, oldAnchor: p.oldAnchor, newAnchor: p.newAnchor, decision: p.decision, candidate: p.candidate,
    writtenToFolder: p.writtenToFolder,
    ...(withText ? { text: patchBrief(p, (id) => briefName(store, id)) } : {}),
  };
}

/** Every semantic patch, oldest first by when the supersession happened (§2.11); `Change log` shows the confirmed ones. */
export function patchesView(store: ProjectStore): PatchView[] {
  const ms = (o: Occurred) => Date.parse(/^\d{4}-\d\d-\d\d$/.test(o.at) ? `${o.at}T00:00:00Z` : o.at) || 0;
  return store.patches.all().sort((a, b) => ms(a.occurred) - ms(b.occurred) || a.number.localeCompare(b.number, undefined, { numeric: true })).map((p) => patchView(store, p));
}

// ───────────────────────── Project scope additions ─────────────────────────

export function scopeKView(store: ProjectStore, project: Project, engines: KEngines = {}): ScopeKView {
  const firstRound = store.clerkRounds.filter((r) => r.kind === 'First usable').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const questions = firstRound ? store.roundDocs.find((d) => d.roundId === firstRound.id && d.kind === 'Questions') : undefined;
  // The `Project folder` authorization (§1.14): the one standing authorization with a folder, not revoked.
  const auth = store.authorizations.find((a) => !a.revokedAt && (a as FolderAuthorization).projectFolder != null) as FolderAuthorization | undefined;
  // What the ledger keeps without reading it says the sizes it reads to, so Project scope can name them (QC AY; Spec §6.7).
  const ledger = engines.ledger?.coverage(project) ?? null;
  return {
    ledger: ledger?.notRead ? { ...ledger, notRead: { ...ledger.notRead, documentLimitBytes: MAX_DOC_BYTES, looseLimitBytes: MAX_LOOSE_BYTES } } : ledger,
    layers: store.layers.all().sort((a, b) => a.path.localeCompare(b.path)).map((l) => ({ path: l.path, layer: l.layer, note: l.note, current: l.current })),
    generations: store.generations.all().sort((a, b) => a.ended.at.localeCompare(b.ended.at)).map((g) => ({ id: g.id, name: g.name, ended: g.ended, endedBy: g.endedBy })),
    questions: questions && firstRound ? { roundId: firstRound.id, docId: questions.id, paths: store.roundDocs.filter((d) => d.roundId === firstRound.id && d.kind === 'Brief').map((d) => d.path ?? d.title) } : null,
    projectFolder: auth?.projectFolder ? { granted: true, path: auth.projectFolder.path, commits: auth.projectFolder.commits, lastWrite: auth.projectFolder.lastWrite, authorizationId: auth.id } : { granted: false, path: null, commits: true, lastWrite: null, authorizationId: null },
  };
}

// ───────────────────────── the owner's `No action needed` ─────────────────────────

export function respondToBreakpoint(store: ProjectStore, id: string, reason: string): BreakpointView {
  const b = store.breakpoints.get(id);
  if (!b) throw new HttpError(404, 'Unknown breakpoint');
  const now = new Date().toISOString();
  const next: Breakpoint = { ...b, ownerResponse: { text: 'No action needed', reason, at: now, sourceId: null }, updatedAt: now };
  store.breakpoints.put(next, { jobId: null, summary: `The owner: no action needed on ${b.kind} (${b.targetId})` });
  return breakpointView(next);
}

export function respondToSendBack(store: ProjectStore, projectId: string, id: string, reason: string, engines: KEngines = {}): SendBackView {
  const sb = store.sendbacks.get(id);
  if (!sb) throw new HttpError(404, 'Unknown send-back');
  const now = new Date().toISOString();
  const next: SendBack = { ...sb, ownerResponse: { text: 'No action needed', reason, at: now, sourceId: null }, updatedAt: now };
  store.sendbacks.put(next, { jobId: null, summary: `The owner: no action needed on send-back ${sb.id}` });
  return sendBackView(store, projectId, next, engines);
}

// ───────────────────────── routes ─────────────────────────

export function registerKRoutes(http: HttpApp, app: App): void {
  // The code map rides on the app's ledger when the app's engines do not carry it already (one per registration).
  let codemap: CodeMapEngines | null = null;
  const engines = (): KEngines => ({ ...app.kEngines, codemap: app.kEngines.codemap ?? (codemap ??= codeMapEngines(app.ledger)) });
  const notYet = (what: string) => new HttpError(404, `${what} needs the ledger, which this build does not carry yet`);
  http.route('GET', '/api/projects/:id/process', ({ params }) => processView(app.store(params.id!), app.project(params.id!), engines()));
  http.route('GET', '/api/projects/:id/objects/:oid/lineage', ({ params }) => engines().ledger?.lineage(app.store(params.id!), app.project(params.id!), params.oid!) ?? (() => { throw notYet('How it got here'); })());
  http.route('GET', '/api/projects/:id/objects/:oid/versions', ({ params }) => engines().ledger?.versions(app.store(params.id!), app.project(params.id!), params.oid!) ?? (() => { throw notYet('The versions'); })());
  http.route('GET', '/api/projects/:id/code', ({ params }) => codeViewOf(app.store(params.id!), app.project(params.id!), engines()) ?? (() => { throw notYet('Code'); })());
  // A file of the current version, found by the ledger's fileRefs (§6.17 "点文件打开原文阅读"; QC AY B13).
  http.route('GET', '/api/projects/:id/code/file', ({ params, query }) => {
    const project = app.project(params.id!);
    const path = requireString(query.get('path'), 'path');
    const from = Number(query.get('from') ?? '1');
    const page = engines().codemap?.fileText(project, { path, repo: optionalString(query.get('repo')), fromLine: Number.isFinite(from) && from > 0 ? Math.floor(from) : 1 }) ?? null;
    if (page === null) throw notYet('A file of the current version');
    if (typeof page === 'string') throw new HttpError(404, page);
    return page;
  });
  // An earlier generation's plan document as it stood — before its deletion, or when the generation ended (D82).
  http.route('GET', '/api/projects/:id/generations/:gid/plans/:n', ({ params, query }) => {
    const store = app.store(params.id!);
    const g = store.generations.get(params.gid!);
    if (!g) throw new HttpError(404, 'Unknown generation');
    const index = Number(params.n);
    if (!Number.isInteger(index) || index < 0 || index >= g.planRefs.length) throw new HttpError(404, `${g.name} has no plan document ${params.n}`);
    const from = Number(query.get('from') ?? '1');
    return engines().process?.generationPlan?.(store, app.project(params.id!), g.id, index, Number.isFinite(from) && from > 0 ? Math.floor(from) : 1) ?? (() => { throw notYet('An earlier plan document'); })();
  });
  // Semantic patches: every one for `Change log` (which shows the confirmed), and one with its details (CKC-26 AC-4).
  http.route('GET', '/api/projects/:id/patches', ({ params }) => ({ patches: patchesView(app.store(params.id!)) }));
  http.route('GET', '/api/projects/:id/patches/:pid', ({ params }) => {
    const store = app.store(params.id!);
    const p = store.patches.get(params.pid!) ?? store.patches.find((x) => x.number === params.pid);
    if (!p) throw new HttpError(404, 'Unknown semantic patch');
    return patchView(store, p, true);
  });
  http.route('GET', '/api/projects/:id/code/territories/:tid', ({ params }) => engines().ledger?.territory(app.store(params.id!), app.project(params.id!), params.tid!) ?? (() => { throw notYet('The territory'); })());
  http.route('GET', '/api/projects/:id/k-rounds', ({ params }) => roundsView(app.store(params.id!)));
  http.route('GET', '/api/projects/:id/k-rounds/:rid/docs/:docId', ({ params }) => roundDocView(app.store(params.id!), params.rid!, params.docId!) ?? (() => { throw new HttpError(404, 'Unknown round document'); })());
  http.route('GET', '/api/projects/:id/scope-k', ({ params }) => scopeKView(app.store(params.id!), app.project(params.id!), engines()));
  http.route('POST', '/api/projects/:id/breakpoints/:bid/response', ({ params, body }) => respondToBreakpoint(app.store(params.id!), params.bid!, requireString((body as { reason?: unknown })?.reason, 'reason')));
  http.route('POST', '/api/projects/:id/sendbacks/:sid/response', ({ params, body }) => respondToSendBack(app.store(params.id!), params.id!, params.sid!, requireString((body as { reason?: unknown })?.reason, 'reason'), engines()));
}
