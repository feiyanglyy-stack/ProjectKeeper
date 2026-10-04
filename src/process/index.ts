/**
 * The process engine (Spec v3.0 §2.12 工作的过程与断点, §1.18 送回, §2.13 rows 1–5 — what the program computes): each
 * piece of work's process as the ledger shows it, its four things, a plan's execution shape, the breakpoints lit and
 * put out, and the send-backs moved on by themselves. The program half of the owner's process view (CKC-24; CKC-27
 * AC-6, AC-11); the round's model steps confirm or refute what rests on judgement and suggest the other send-backs.
 *
 * What the rest of the app wires in:
 * - `processRunner(ledgerService)` — the round's program step `process` (keeper/organize/clerk.ts `ProcessRunner`);
 * - `processEngines(ledgerService)` — `KEngines.process` for the process view (server/k-views.ts): a work item's steps
 *   and four things, a plan's shape, and the work item a fix or check is a step of (`stepOf`);
 * - `processBlock(store)` — the synthesis' block: breakpoints lit by kind and object, the candidates as leads, open send-backs;
 * - `computeBreakpoints` — the candidates recomputed when the main agent enters a stage that reads them (D99, `pk_stage`);
 * - `spotCheckTargets(store, round)` — what the spot-check checks: every looked candidate and the weighted sample (D99);
 *   and (CS) every standing reason for leaving an item unplaced no spot-check has checked, and the program's unreviewed placements;
 * - `unlightUnchecked(store)` — at start: breakpoints lit without the independent check become candidates again (D99).
 */
import type { Ledger } from '../ledger/index.ts';
import type { LedgerService } from '../ledger/adapters.ts';
import type { ProcessRunner } from '../keeper/organize/clerk.ts';
import type { KEngines } from '../server/k-views.ts';
import type { Project } from '../model/types.ts';
import type { FourThingsView, PlanShapeView, ProcessStepView } from '../model/views-k.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { analyze, type Analysis } from './analysis.ts';
import type { Breakpoint } from '../model/k-types.ts';
import { BREAKPOINT_KINDS, computeFindings, isCandidate, reconcile, type ReconcileResult } from './breakpoints.ts';
import { generationPlanText } from './generations.ts';
import { planShapeOf } from './plan.ts';
import { advance, type SendBackResult } from './sendbacks.ts';
import { clip } from './text.ts';
import { stepOfThread } from './units.ts';
import { fourThingsOf } from './work.ts';

export { analyze } from './analysis.ts';
export type { Analysis } from './analysis.ts';
export { isCandidate, spotCheckTargets, spotCheckBlock, unlightUnchecked, type SpotCheckTargets } from './breakpoint-candidates.ts';

// ───────────────────────── one work item, one plan ─────────────────────────

/** A work item's steps and four things (§2.12). Null when the store has no such work item. */
export function work(store: ProjectStore, project: Project, ledger: Ledger, workId: string): { readonly steps: readonly ProcessStepView[]; readonly four: FourThingsView } | null {
  return workOf(analyze(store, project, ledger), workId);
}

function workOf(a: Analysis, workId: string): { readonly steps: readonly ProcessStepView[]; readonly four: FourThingsView } | null {
  const p = a.process(workId);
  if (!p) return null;
  return { steps: p.steps, four: fourThingsOf(a.store, p, a.expecting(p.thread, 'Independent check') !== null) };
}

/** A plan's execution shape (§6.3, CKC-24 AC-2). Null when the store has no such `Plan` item. */
export function plan(store: ProjectStore, project: Project, ledger: Ledger, planId: string): PlanShapeView | null {
  return planShapeOf(analyze(store, project, ledger), planId);
}

/**
 * The work item a work item is a step of — a fix or a check of it, however many fixes and checks lie between (AD,
 * AF, AK and AO → AB) — so List and Graph fold it under that work; null for a piece of work of its own.
 */
export function stepOf(store: ProjectStore, project: Project, ledger: Ledger, workId: string): string | null {
  return stepOfThread(analyze(store, project, ledger).index, workId);
}

// ───────────────────────── the round's program step ─────────────────────────

/** The job of this round's `process` step, so what it writes is counted as the round's (clerk.ts `closeRound`). */
function processJobOf(store: ProjectStore, roundId: string | null): string | null {
  if (!roundId) return null;
  return store.jobs.filter((j) => j.step?.roundId === roundId && j.step.kind === 'process').sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0]?.id ?? null;
}

/**
 * Recompute the candidates, keep what the spot-check lit and still holds, put out what no longer holds (§2.12, D99). The
 * writes count under `jobId` when given (the main agent entering a stage), else under the round's process step.
 */
export function computeBreakpoints(store: ProjectStore, project: Project, ledger: Ledger, roundId: string | null, jobId?: string | null): ReconcileResult {
  const a = analyze(store, project, ledger);
  return reconcile(store, project.id, computeFindings(a), roundId, jobId === undefined ? processJobOf(store, roundId) : jobId);
}

/** Record the send-backs the project's failed checks and reviews started, and move every send-back on (§1.18). */
export function advanceSendBacks(store: ProjectStore, project: Project, ledger: Ledger, roundId: string | null): SendBackResult {
  return advance(analyze(store, project, ledger), roundId, processJobOf(store, roundId));
}

export interface ProcessRun {
  readonly works: number;
  readonly steps: number;
  readonly sendBacks: SendBackResult;
  readonly breakpoints: ReconcileResult;
  readonly ms: number;
  readonly note: string;
}

/**
 * The whole step once, on one analysis: the breakpoints first, then the send-backs — a send-back that came from a
 * breakpoint closes on the evidence that put the breakpoint out in the same round.
 */
export function runProcess(store: ProjectStore, project: Project, ledger: Ledger, roundId: string | null): ProcessRun {
  const started = Date.now();
  const jobId = processJobOf(store, roundId);
  const a = analyze(store, project, ledger);
  const breakpoints = reconcile(store, project.id, computeFindings(a), roundId, jobId);
  const sendBacks = advance(a, roundId, jobId);
  const threads = store.threads.all();
  const steps = threads.reduce((n, t) => n + (a.process(t.id)?.steps.length ?? 0), 0);
  const ms = Date.now() - started;
  const kinds = BREAKPOINT_KINDS.filter((k) => breakpoints.litByKind[k]).map((k) => `${k} ${breakpoints.litByKind[k]}`).join(', ');
  const leads = BREAKPOINT_KINDS.filter((k) => breakpoints.candidatesByKind[k]).map((k) => `${k} ${breakpoints.candidatesByKind[k]}`).join(', ');
  const note = [
    `${threads.length} work item${threads.length === 1 ? '' : 's'}, ${steps} step${steps === 1 ? '' : 's'} from the ledger`,
    `breakpoints lit ${breakpoints.lit}${kinds ? ` (${kinds})` : ''}, candidates ${breakpoints.candidates}${leads ? ` (${leads})` : ''}, ${breakpoints.putOut} put out, ${breakpoints.keptOut} kept out`,
    `send-backs: ${sendBacks.created} recorded from failed checks and reviews, ${sendBacks.returned} returned, ${sendBacks.closed} closed, ${sendBacks.open} open`,
    `${(ms / 1000).toFixed(1)} s`,
  ].join(' · ');
  return { works: threads.length, steps, sendBacks, breakpoints, ms, note };
}

/** The round's program step (clerk.ts `ProcessRunner`): recompute each round, after the trunk and before the synthesis. */
export function processRunner(ledgerService: LedgerService): ProcessRunner {
  return {
    run: async (store, project, roundId) => {
      const ledger = ledgerService.ledger(project.id);
      if (!ledger) return { note: 'The project has no ledger yet: no process, breakpoint or send-back was computed.' };
      return { note: runProcess(store, project, ledger, roundId).note };
    },
  };
}

// ───────────────────────── the process view's engines ─────────────────────────

/**
 * What the store looks like to the engine: when any of what the processes read changed, the analysis is recomputed. The
 * view asks for every work item in one request; one analysis serves them all.
 */
function storeMark(store: ProjectStore): string {
  const part = (xs: readonly { readonly id: string; readonly updatedAt?: string }[]) => `${xs.length}:${xs.reduce((m, x) => ((x.updatedAt ?? '') > m ? x.updatedAt ?? '' : m), '')}`;
  return [
    part(store.threads.all()), part(store.reference.all()), part(store.relations.all()), part(store.rules.all()), part(store.generations.all()),
    part(store.layers.all()),   // CZ: which documents list work decides what was carried on (carried-on.ts)
    part(store.breakpoints.all()), part(store.sendbacks.all()), part(store.numbers.all().map((n) => ({ id: n.id, updatedAt: n.at }))),
    part(store.links.all().map((l) => ({ id: `${l.id}${l.confirmed ? '+' : l.check?.passed ? '~' : ''}`, updatedAt: l.at }))), String(store.sources.size), String(store.patches.size),
  ].join('|');
}

function ledgerMark(ledger: Ledger): string {
  const r = ledger.db.prepare('SELECT max(id) id, max(ended_at) at FROM rebuilds').get() as { id: number | null; at: string | null } | undefined;
  return `${r?.id ?? 0}:${r?.at ?? ''}`;
}

/** `KEngines.process` (server/k-views.ts): a work item's steps and four things, a plan's execution shape, what a work item
 *  is a step of, and an earlier generation's plan document as it stood (§2.12, D82). */
export function processEngines(ledgerService: LedgerService): NonNullable<KEngines['process']> {
  const cache = new Map<string, { ledger: Ledger; store: ProjectStore; mark: string; analysis: Analysis }>();
  const analysisOf = (store: ProjectStore, project: Project): Analysis | null => {
    const ledger = ledgerService.ledger(project.id);
    if (!ledger) return null;
    const mark = `${ledgerMark(ledger)}#${storeMark(store)}`;
    const hit = cache.get(project.id);
    if (hit && hit.ledger === ledger && hit.store === store && hit.mark === mark) return hit.analysis;
    const analysis = analyze(store, project, ledger);
    cache.set(project.id, { ledger, store, mark, analysis });
    return analysis;
  };
  return {
    work: (store, project, workId) => {
      try { const a = analysisOf(store, project); return a ? workOf(a, workId) : null; } catch { return null; }
    },
    plan: (store, project, planId) => {
      try { const a = analysisOf(store, project); return a ? planShapeOf(a, planId) : null; } catch { return null; }
    },
    stepOf: (store, project, workId) => {
      try { const a = analysisOf(store, project); return a ? stepOfThread(a.index, workId) : null; } catch { return null; }
    },
    generationPlan: (store, project, generationId, index, fromLine) => {
      const ledger = ledgerService.ledger(project.id);
      const g = store.generations.get(generationId);
      if (!ledger || !g) return null;
      try { return generationPlanText(ledger, store, g, index, fromLine ?? 1); } catch { return null; }
    },
  };
}

// ───────────────────────── the synthesis' block ─────────────────────────

/**
 * What the main agent and the synthesis are given of the program's process (§3.3, §2.12): the breakpoints lit — found
 * missing after a lane looked and the spot-check confirmed (D99) — by kind and object, with their ids and evidence, the
 * lines themselves; then, apart from them, the candidates, leads for reading and not findings; and the send-backs still
 * open. The synthesis tags the six things and writes the notes and send-backs from the lit ones only.
 */
export function processBlock(store: ProjectStore, opts: { readonly candidates?: 'list' | 'count'; readonly answered?: number } = {}): string {
  const name = (id: string) => {
    const t = store.threads.get(id);
    const r = t ? undefined : store.reference.get(id);
    return t ? `${t.ids[0] ? `${t.ids[0]} ` : ''}${t.title}` : r ? `${r.category} ${r.name}` : id;
  };
  const evidence = (b: Breakpoint, lines: string[]) => {
    for (const e of b.evidence.slice(0, 5)) lines.push(`  · ${e.kind} ${e.kind === 'file' ? e.label : e.id}${e.line ? `: “${clip(e.line, 160)}”` : ` (${clip(e.label, 100)})`}`);
    if (b.evidence.length > 5) lines.push(`  · … ${b.evidence.length - 5} more`);
  };
  const lit = store.breakpoints.filter((b) => b.lit && !b.ownerResponse);
  const leads = store.breakpoints.filter(isCandidate);
  const lines: string[] = [`=== Process and breakpoints (computed by the program this round; ids to cite, lines as the material wrote them)`];
  lines.push(`Breakpoints lit (${lit.length}) — a lane looked and the spot-check confirmed:`);
  for (const kind of BREAKPOINT_KINDS) {
    const of = lit.filter((b) => b.kind === kind).sort((x, y) => x.since.at.localeCompare(y.since.at));
    if (of.length === 0) continue;
    lines.push(`${kind} (${of.length})${of[0]!.sixThing ? ` — six thing ${of[0]!.sixThing}` : ''}:`);
    for (const b of of) {
      lines.push(`- ${b.id} on ${name(b.targetId)} (${b.targetId}) · ${b.basis}${b.basis === 'Inferred' ? ' (refute with pk_confirm if it does not hold)' : ''}${b.checked ? ` · checked ${b.checked.at.slice(0, 10)}` : b.confirmedInRoundId ? ' · confirmed' : ''}${b.sendBackId ? ` · send-back ${b.sendBackId}` : ''} · since ${b.since.at.slice(0, 10)}`);
      lines.push(`  ${b.why}`);
      evidence(b, lines);
    }
  }
  // D103: the synthesis job gets the candidates' state as counts — a candidate is a clue it writes about as an open
  // question, not a finding it judges one by one; the list comes on request (pk_round_state { list: "candidates" }).
  if (opts.candidates === 'count') {
    const looked = leads.filter((b) => b.looked).length;
    const byKind = BREAKPOINT_KINDS.flatMap((kind) => { const n = leads.filter((b) => b.kind === kind).length; return n ? [`${kind} ${n}`] : []; });
    lines.push(`Breakpoint candidates (${leads.length}) — leads, not findings; only the spot-check, which runs after you, lights one, and never in a First usable round: ${leads.length ? byKind.join(', ') : 'none'}. ${looked} of them a lane looked for and did not find (the spot-check checks those); ${leads.length - looked} nobody looked for yet${opts.answered !== undefined ? `; ${opts.answered} more were answered by this round's writes` : ''}. pk_round_state({ list: "candidates" }) lists those with no result; pk_read_assets kind breakpoint reads any.`);
  }
  if (opts.candidates !== 'count') lines.push(`Breakpoint candidates (${leads.length}) — leads, not findings: the program computed them from the ledger's ids and the links made so far, and what is written elsewhere it may have missed. Before anything is written as missing, a lane reads where the step would be written (execution arrangements, summaries, receipts, QC reports, the ledger, the code): found, it links it (pk_link_process); not found, it records where it looked (pk_record_looked). Only the spot-check lights one, and never in a First usable round:`);
  for (const kind of opts.candidates === 'count' ? [] : BREAKPOINT_KINDS) {
    const of = leads.filter((b) => b.kind === kind).sort((x, y) => x.since.at.localeCompare(y.since.at));
    if (of.length === 0) continue;
    lines.push(`${kind} (${of.length}):`);
    for (const b of of) {
      lines.push(`- ${b.id} on ${name(b.targetId)} (${b.targetId}) · ${b.basis}${b.looked ? ` · looked in ${clip(b.looked.where.join('; '), 200)}` : ' · not looked for yet'}`);
      lines.push(`  ${b.why}`);
      evidence(b, lines);
    }
  }
  const open = store.sendbacks.filter((s) => s.stage !== 'Closed' && !s.ownerResponse).sort((x, y) => x.occurred.at.localeCompare(y.occurred.at));
  lines.push(`Send-backs open (${open.length}):`);
  for (const s of open) {
    lines.push(`- ${s.id} · ${s.stage} · to ${s.to} · on ${name(s.targetId)} (${s.targetId}) · from ${s.from.kind} ${s.from.id}`);
    lines.push(`  ${clip(s.what, 200)}${s.returned ? ` — returned by ${clip(s.returned.by.label, 100)}` : ''}`);
  }
  if (!lit.length && !leads.length && !open.length) lines.push('Nothing is lit, no candidate waits and no send-back is open.');
  return lines.join('\n');
}

