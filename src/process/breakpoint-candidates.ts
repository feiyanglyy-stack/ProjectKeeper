/**
 * Breakpoint candidates and how one lights (Spec §2.12 没有痕迹，要读过才算, §3.3 抽查; D99; CKC-24 AC-7, CKC-23 AC-22).
 *
 * What the program computes (breakpoints.ts `reconcile`) is a candidate: a lead for reading, not a conclusion. A lookup
 * by number that finds nothing may only mean the delivery is written in an execution arrangement, a milestone summary or
 * a QC report. A candidate lights when
 *   1. a lane read where the missing step would be and did not find it, and recorded where it looked (`looked`,
 *      pk_record_looked) — a lane that finds it links it instead (pk_link_process), and the candidate goes out;
 *   2. the round's independent spot-check confirmed it (`checked`, pk_confirm kind breakpoint confirmed true);
 *   3. the round is not First usable, which draws no "something is missing" conclusion (§3.7).
 * Seen on the resident run: after the first usable picture, 16 Done work items were lit `No trace of done` and read
 * `Not started`; their deliveries were in the execution plan, the milestone summaries and the QC reports (E147).
 *
 * Also here: the spot-check's targets (every looked candidate; what is checked in full — the notes and the synthesis'
 * outputs, D103; then the weighted sample of the rest), and the start-up fix that turns breakpoints lit without a check
 * back into candidates.
 *
 * CS (D104, after the CQ run): the placement readings reach the spot-check whichever round wrote them. Every standing
 * reason that left an item unplaced is checked in full until a spot-check found it right (`uncheckedReasons`; the round's
 * spot-check record keeps each reason it checked, with its words and the outcome); the program's placements nobody
 * reviewed are in the sample with a floor (`PLACEMENT_SAMPLE_FLOOR`); and the spot-check's count says both
 * (`SpotCheck.placement`, `placementCounts`). The program counts all of it: the model is given the targets, not the duty
 * to remember them.
 */
import type { Breakpoint, ClerkRound, PlacementCheckPlan, ReasonCheck, ReasonTarget, RoundStepKind, SpotCheckPlacement } from '../model/k-types.ts';
import type { ReferenceItem, WorkThread } from '../model/types.ts';
import type { ProjectStore, TraceInfo } from '../store/project-store.ts';
import type { Ledger } from '../ledger/index.ts';
import { isCandidate } from './breakpoints.ts';
import { clip } from './text.ts';
import { isProgramNote, stillHolding } from '../keeper/organize/standing-notes.ts';
import { inferenceContext, inferredPlacementRows, triedLine, type InferenceContext } from '../keeper/organize/placement-inference.ts';
import { reachOf } from '../keeper/organize/placing.ts';
import { earlierWork } from '../keeper/organize/carried-on.ts';
import { plansOf } from './placement.ts';
import { workbenchUnplaced } from '../keeper/organize/workbench-placement.ts';

export { isCandidate } from './breakpoints.ts';

// ───────────────────────── lighting ─────────────────────────

/** Why this job may not light this breakpoint, or null when it may (the three conditions above). */
export function lightingRefusal(store: ProjectStore, bp: Breakpoint, step: { readonly roundId: string; readonly kind: RoundStepKind } | null): string | null {
  const leave = 'Put it out if the missing step did happen (confirmed: false, with the evidence that shows it), or leave it as it is. Nothing was written.';
  if (!step || step.kind !== 'spot-check') {
    return `A breakpoint lights only when the round's independent spot-check confirms it, after a lane looked for the missing step and did not find it. This job is ${step ? `the round's ${step.kind}` : 'no step of a round'}. ${leave}`;
  }
  const round = store.clerkRounds.get(step.roundId);
  if (!round) return `The round ${step.roundId} is not on record, so it cannot be told whether it may draw a "missing" conclusion. Nothing was written.`;
  if (round.kind === 'First usable') {
    return `This round is First usable: it draws no conclusion that something is missing, so nothing lights in it. ${bp.kind} on ${bp.targetId} stays a candidate for the deepening. Nothing was written.`;
  }
  if (bp.lit) return null;
  if (!bp.looked) {
    return `No lane has looked for the missing step of ${bp.kind} on ${bp.targetId} yet (pk_record_looked): a candidate lights only after a lane read where the step would be written and did not find it. ${leave}`;
  }
  return null;
}

/** Light a breakpoint the spot-check confirmed (its conditions checked by `lightingRefusal`): `checked`, lit, this round's. */
export function lightCandidate(store: ProjectStore, bp: Breakpoint, meta: { readonly roundId: string; readonly jobId: string | null; readonly at: string }, trace: TraceInfo): Breakpoint {
  const next: Breakpoint = {
    ...bp, lit: true, out: null,
    checked: { roundId: meta.roundId, jobId: meta.jobId, at: meta.at },
    confirmedInRoundId: meta.roundId,
    // The round it lit in: its news counts it (round-news.ts), and the process view dates it from here.
    roundId: bp.lit ? bp.roundId : meta.roundId,
    updatedAt: meta.at,
  };
  store.breakpoints.put(next, trace);
  return next;
}

// ───────────────────────── the spot-check's targets ─────────────────────────

/** How many of the round's other judgements the spot-check samples (clerk.ts `SPOT_CHECK_SAMPLE`). */
export const SPOT_CHECK_SAMPLE = 24;
/** What goes wrong most, by collection (clerk.ts `startSpotCheck`). */
const WEIGHT: Readonly<Record<string, number>> = { patches: 3, threads: 3, territories: 3, breakpoints: 3, sendbacks: 3, reference: 2, marks: 2, notes: 2, links: 1, relations: 1, areas: 1 };
/** Claims about the code, residue, deletion, "decided" and "nobody", which a spot check finds wrong most often. */
const CODEISH = /code|file|wired|接线|unused|residual|残留|deleted|删除|decided|undecided|未定|已定|nobody|没人|verified|验过/i;

export interface SpotCheckTarget {
  readonly collection: string;
  readonly id: string;
  readonly summary: string;
  readonly weight: number;
}

export interface SpotCheckTargets {
  /** Every candidate a lane looked for and did not find: each is checked, and lights only if the check confirms it. */
  readonly candidates: readonly SpotCheckTarget[];
  /**
   * D103 (E153): what the spot-check checks in full, not as a sample — the round's final re-check of the synthesis. Every
   * note current at the end of the round (this round's and those standing from earlier rounds), everything else the
   * synthesis job wrote (its six-things judgements, its send-backs, marks and assessments), and the round's Result.
   */
  readonly full: readonly SpotCheckTarget[];
  /** The weighted sample of the rest of what the round's jobs wrote: the bulk (links, placements, fills, candidates). */
  readonly sample: readonly SpotCheckTarget[];
  /** How many judgements the round's jobs wrote, the looked candidates and what is checked in full left out. */
  readonly written: number;
  /** CS: the reasons that leave an item unplaced among `full` — standing, not settled by a spot-check yet, whichever round wrote them. */
  readonly reasons: readonly ReasonTarget[];
  /** CS: the program's unreviewed placements in the sample (at least `PLACEMENT_SAMPLE_FLOOR`, or all when fewer), and how many there are in all. */
  readonly placements: PlacementCheckPlan['placements'];
  readonly placementsUnreviewed: number;
}

/** Collections a job writes for the record, not as a judgement of the project: no spot-check target. */
const BOOKKEEPING: ReadonlySet<string> = new Set(['jobs', 'judgements', 'clerkRounds', 'rounds', 'contexts', 'authorizations', 'sources']);

/** What a job of a round wrote that a check can be held against: its puts, bookkeeping and the round's documents left out. */
export function judgementWritesOf(store: ProjectStore, jobId: string): { readonly collection: string; readonly id: string; readonly summary: string }[] {
  const seen = new Set<string>();
  const out: { collection: string; id: string; summary: string }[] = [];
  for (const e of store.traceByJob(jobId, 100_000)) {
    const key = `${e.collection}:${e.id}`;
    if (e.op !== 'put' || BOOKKEEPING.has(e.collection) || e.collection === 'roundDocs' || seen.has(key)) continue;
    seen.add(key);
    out.push({ collection: e.collection, id: e.id, summary: e.summary });
  }
  return out;
}

/**
 * What the spot-check checks in full (D103, E153; the owner: 「那你说是不是应该最后再做一轮复检，反正也就不到1mb的事。」):
 * - every note current now, and every note a job of this round wrote, changed or closed — this round's notes and those
 *   standing from earlier rounds, whatever the round did with them (a note the spot-check itself withdraws stays a target);
 *   the program's own notes (the depth question) are not judgements and are left out;
 * - everything else the round's synthesis job wrote: each six-things judgement, send-back, mark and assessment;
 * - the round's Result, for the claims in it.
 * Stable while the spot-check runs: its own corrections add nothing and take nothing away.
 */
export function fullCheckTargets(store: ProjectStore, round: Pick<ClerkRound, 'id'>): SpotCheckTarget[] {
  const out = new Map<string, SpotCheckTarget>();
  const add = (collection: string, id: string, summary: string) => { const key = `${collection}:${id}`; if (!out.has(key)) out.set(key, { collection, id, summary, weight: WEIGHT[collection] ?? 2 }); };
  const jobs = store.jobs.filter((j) => j.step?.roundId === round.id);
  const noteLine = (id: string, how: string): string => {
    const n = store.notes.get(id);
    const v = n?.versions[n.versions.length - 1];
    return `note “${clip(v?.title ?? id, 100)}”${v?.ask ? ` (${v.ask})` : ''} — ${how}${n?.sixThing ? ` · six thing ${n.sixThing}` : ''}: ${clip((v?.preview ?? '').replace(/\s+/g, ' '), 200)}`;
  };
  const started = store.clerkRounds.get(round.id)?.startedAt ?? '';
  const held = stillHolding(store, round.id);
  const how = (id: string): string => {
    const n = store.notes.get(id);
    if (!n) return 'written this round';
    if (n.status !== 'Current') return `${n.status.toLowerCase()} this round`;
    if ((n.versions[0]?.at ?? '') >= started) return 'written this round';
    if ((n.versions[n.versions.length - 1]?.at ?? '') >= started) return 'standing from an earlier round, updated this round';
    return held.has(id) ? 'standing from an earlier round, confirmed as still holding this round' : 'standing from an earlier round, with no result this round';
  };
  for (const n of store.notes.filter((x) => x.status === 'Current' && !isProgramNote(x)).sort((a, b) => a.id.localeCompare(b.id))) add('notes', n.id, noteLine(n.id, how(n.id)));
  for (const job of jobs) for (const w of judgementWritesOf(store, job.id)) if (w.collection === 'notes' && store.notes.has(w.id)) add('notes', w.id, noteLine(w.id, how(w.id)));
  for (const job of jobs.filter((j) => j.step?.kind === 'synthesis')) for (const w of judgementWritesOf(store, job.id)) add(w.collection, w.id, w.summary);
  for (const d of store.roundDocs.filter((x) => x.roundId === round.id && x.kind === 'Result')) add('roundDocs', d.id, `the round's Result “${clip(d.title, 100)}” (${d.markdown.length} characters; pk_read_assets kind roundDoc): check the claims in it`);
  return [...out.values()];
}

const nameOf = (store: ProjectStore, id: string): string => {
  const t = store.threads.get(id);
  if (t) return `${t.ids[0] ? `${t.ids[0]} ` : ''}${t.title}`;
  const r = store.reference.get(id);
  return r ? `${r.category} ${r.name}` : id;
};

// ───────────────────────── the placement readings (CQ, CS; D104) ─────────────────────────

/** Of the program's unreviewed placements, how many the sample holds at least; all of them when there are fewer (CS). */
export const PLACEMENT_SAMPLE_FLOOR = 5;

const GONE = new Set(['Replaced', 'Removed']);
const reasonKey = (r: Pick<ReasonTarget, 'collection' | 'id' | 'field'>): string => `${r.collection}\x1f${r.id}\x1f${r.field}`;
const collectionOf = (kind: 'thread' | 'reference'): 'threads' | 'reference' => (kind === 'thread' ? 'threads' : 'reference');

/**
 * Every reason that leaves an item unplaced as the store stands: a live work item in no plan with its `noPlanWhy`, or in
 * no module with its `noAreaWhy`; a live reference item on no Area and no Plan with its `wholeProductWhy` — a decision or
 * a boundary, and a requirement or a design where the Keeper wrote one (`pk_write_reference` takes the reason on all
 * four; on the CQ run 42 stood on decisions and boundaries, 7 on requirements, 1 on a design). A reason left on an item
 * that was placed since leaves nothing unplaced and is not one. DB: "in no plan" is the workbench's — a work item whose
 * only plan has no band there stands by its `noPlanWhy`, and that reason is checked like any other.
 */
export function standingReasons(store: ProjectStore): ReasonTarget[] {
  const reach = reachOf(store);
  const inGeneration = earlierWork(store);   // CZ: an item carried on under the same number needs its current plan like any current work
  const out: ReasonTarget[] = [];
  const bench = workbenchUnplaced(store);
  const byReason = new Set(bench.lists.workWrittenNoPlan);
  for (const t of store.threads.filter((x) => !GONE.has(x.validity)).sort((a, b) => a.id.localeCompare(b.id))) {
    const noPlan = t.noPlanWhy?.trim();
    const noArea = t.noAreaWhy?.trim();
    // Placed by its reason on the workbench; an item the workbench does not draw (deferred, abandoned) by the plans it names.
    const standsByReason = byReason.has(t.id) || (!bench.placement.place.has(t.id) && !inGeneration.has(t.id) && plansOf(store, t).length === 0);
    if (noPlan && standsByReason) out.push({ collection: 'threads', id: t.id, field: 'noPlanWhy', reason: noPlan });
    if (noArea && reach.ofThread(t).areas.length === 0) out.push({ collection: 'threads', id: t.id, field: 'noAreaWhy', reason: noArea });
  }
  for (const d of store.reference.filter((x) => !GONE.has(x.validity)).sort((a, b) => a.id.localeCompare(b.id))) {
    const why = d.wholeProductWhy?.trim();
    if (!why) continue;
    const at = reach.ofReference(d.id);
    if (!at.areas.length && !at.plans.length) out.push({ collection: 'reference', id: d.id, field: 'wholeProductWhy', reason: why });
  }
  return out;
}

/** The last spot-check record of each reason, whichever round's spot-check made it, with that round. */
function lastReasonChecks(store: ProjectStore): Map<string, { readonly check: ReasonCheck; readonly round: string }> {
  const out = new Map<string, { check: ReasonCheck; round: string }>();
  for (const r of store.clerkRounds.all().sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    for (const check of r.spotCheck?.reasonChecks ?? []) {
      const before = out.get(reasonKey(check));
      if (!before || before.check.at <= check.at) out.set(reasonKey(check), { check, round: `${r.kind} round ${r.number}` });
    }
  }
  return out;
}

/**
 * CS: the standing reasons no spot-check has settled yet, whichever round wrote them — never checked (most are written in
 * the first usable round, which has no spot-check: on the CQ run the store held 52 `wholeProductWhy` and none was among
 * the deepening's 39 targets), changed since they were checked, or found wrong and still standing (`earlier` says which
 * round found it wrong). A reason a spot-check found right and nobody changed since is not a target again.
 */
export function uncheckedReasons(store: ProjectStore): (ReasonTarget & { readonly earlier?: string })[] {
  const checks = lastReasonChecks(store);
  return standingReasons(store).flatMap((r) => {
    const last = checks.get(reasonKey(r));
    if (!last || last.check.reason !== r.reason) return [r];
    return last.check.wrong ? [{ ...r, earlier: last.round }] : [];
  });
}

/** What a spot-check is given of the placement readings, as the store stands: for a round whose spot-check step did not fix it. */
export function placementCheckNow(store: ProjectStore, at: string): PlacementCheckPlan {
  return { at, reasons: uncheckedReasons(store).map(({ collection, id, field, reason }) => ({ collection, id, field, reason })), placements: inferredPlacementRows(store).map((p) => ({ kind: p.kind, id: p.id, targetId: p.targetId })) };
}

/**
 * CS: the spot-check's count of the placement readings, from the plan fixed as it started and the round's records of
 * what was checked: the reasons it was given, those it recorded, those it found wrong; the program placements of its
 * sample it recorded, and those it found wrong. `checks` are the reasons recorded, to keep on the round; `right` the
 * program placements it found right, which gives them their result.
 */
export function placementCounts(plan: PlacementCheckPlan, recorded: readonly { readonly collection: string; readonly id: string; readonly wrong: boolean }[], at: string, before: readonly ReasonCheck[] = []): { readonly placement: SpotCheckPlacement; readonly checks: ReasonCheck[]; readonly right: PlacementCheckPlan['placements'] } {
  const verdict = new Map(recorded.map((t) => [`${t.collection}\x1f${t.id}`, t.wrong]));
  const was = new Map(before.map((c) => [reasonKey(c), c]));
  const checks = plan.reasons.flatMap((r): ReasonCheck[] => {
    const wrong = verdict.get(`${r.collection}\x1f${r.id}`);
    return wrong === undefined ? [] : [{ ...r, wrong, at: was.get(reasonKey(r))?.at ?? at }];
  });
  const sampled = plan.placements.filter((p) => verdict.has(`${collectionOf(p.kind)}\x1f${p.id}`));
  const wrong = sampled.filter((p) => verdict.get(`${collectionOf(p.kind)}\x1f${p.id}`) === true);
  return {
    placement: { reasons: plan.reasons.length, reasonsChecked: checks.length, reasonsWrong: checks.filter((c) => c.wrong).length, programPlacementsSampled: sampled.length, programPlacementsWrong: wrong.length },
    checks, right: sampled.filter((p) => !wrong.includes(p)),
  };
}

/** The spot-check's placement count in one line, for the round's result and for the spot-check's own messages. */
export function placementLine(p: SpotCheckPlacement): string {
  return `placement: ${p.reasonsChecked} of ${p.reasons} reason${p.reasons === 1 ? '' : 's'} for leaving an item unplaced checked · ${p.reasonsWrong} wrong; ${p.programPlacementsSampled} program placement${p.programPlacementsSampled === 1 ? '' : 's'} sampled · ${p.programPlacementsWrong} wrong`;
}

/**
 * What the round's spot-check checks (Spec §3.3 抽查: **all** of the round's "missing" conclusions, then a sample of the
 * rest): every looked candidate, whatever round looked; what is checked in full (`fullCheckTargets`: the notes, the
 * synthesis' outputs, the Result; and — CQ, CS — every standing reason that left an item unplaced and that no spot-check
 * has settled yet, whichever round wrote it); and the weighted sample `startSpotCheck` draws from the rest of what the
 * round's jobs (the main agent, its lanes, the earlier steps; not the spot-check itself) wrote, which holds at least
 * `PLACEMENT_SAMPLE_FLOOR` of the program's unreviewed placements of any round — the bulk stays a sample.
 */
export function spotCheckTargets(store: ProjectStore, round: Pick<ClerkRound, 'id'>, size = SPOT_CHECK_SAMPLE, ledger: Ledger | null = null): SpotCheckTargets {
  const looked = store.breakpoints.filter((b) => isCandidate(b) && !!b.looked).sort((a, b) => a.kind.localeCompare(b.kind) || a.targetId.localeCompare(b.targetId));
  const candidates = looked.map((b): SpotCheckTarget => ({
    collection: 'breakpoints', id: b.id, weight: WEIGHT.breakpoints!,
    summary: `${b.kind} on ${nameOf(store, b.targetId)} (${b.targetId}): ${clip(b.why, 160)} — looked in ${b.looked!.where.join('; ')}`,
  }));
  const skip = new Set(looked.map((b) => `breakpoints:${b.id}`));
  const full = fullCheckTargets(store, round).filter((t) => !skip.has(`${t.collection}:${t.id}`));
  for (const t of full) skip.add(`${t.collection}:${t.id}`);
  const jobIds = store.jobs.filter((j) => j.step?.roundId === round.id && j.step.kind !== 'spot-check').map((j) => j.id);
  // CQ (D104), CS: the placement readings. Every standing reason that left an item unplaced and that no spot-check has
  // settled yet — a work item's noPlanWhy or noAreaWhy, a reference item's wholeProductWhy, whichever round wrote it — is
  // checked in full, with the records the program's trace names.
  let ctx: InferenceContext | null = null;
  const tried = (item: WorkThread | ReferenceItem): string => { try { ctx ??= inferenceContext(store, ledger); return clip(triedLine(ctx, item), 320); } catch { return 'the program could not read the records'; } };
  const reasons = uncheckedReasons(store);
  const byItem = new Map<string, (typeof reasons)[number][]>();
  for (const r of reasons) byItem.set(`${r.collection}:${r.id}`, [...(byItem.get(`${r.collection}:${r.id}`) ?? []), r]);
  for (const [key, own] of byItem) {
    const first = own[0]!;
    const earlier = own.find((r) => r.earlier)?.earlier;
    const again = earlier ? ` · the spot-check of ${earlier} found it wrong, and it still stands` : '';
    let summary: string;
    if (first.collection === 'threads') {
      const t = store.threads.get(first.id)!;
      const said = own.map((r) => `${r.field === 'noPlanWhy' ? 'no plan' : 'no module'} — “${clip(r.reason, 120)}”`).join('; ');
      summary = `work item ${nameOf(store, t.id)} written as ${said}; the records the program's trace names: ${tried(t)}${again}`;
    } else {
      const d = store.reference.get(first.id)!;
      summary = `${nameOf(store, d.id)} written on the whole product — “${clip(first.reason, 120)}”; the records the program's trace names: ${tried(d)}${again}`;
    }
    // An item the synthesis wrote is a target already: its reason is checked with it.
    const at = full.findIndex((t) => `${t.collection}:${t.id}` === key);
    if (at >= 0) full[at] = { ...full[at]!, summary: `${full[at]!.summary} · also: ${summary}` };
    else full.push({ collection: first.collection, id: first.id, weight: WEIGHT[first.collection]!, summary });
    skip.add(key);
  }
  // CS: the program's placements nobody confirmed or moved yet, of this round and of earlier ones, oldest first. The
  // sample holds at least PLACEMENT_SAMPLE_FLOOR of them (all when fewer); the rest join the weighted pool.
  const placed = new Map<string, { target: SpotCheckTarget; records: PlacementCheckPlan['placements'][number][] }>();
  for (const p of inferredPlacementRows(store)) {
    const collection = collectionOf(p.kind);
    const key = `${collection}:${p.id}`;
    if (skip.has(key)) continue;
    const said = `on ${p.placedOn} — ${clip(p.chain, 200)} (${p.round}, entering ${p.stage}; not reviewed since)`;
    const before = placed.get(key);
    if (before) placed.set(key, { target: { ...before.target, summary: `${before.target.summary}; and ${said}` }, records: [...before.records, { kind: p.kind, id: p.id, targetId: p.targetId }] });
    else placed.set(key, { target: { collection, id: p.id, weight: WEIGHT.threads!, summary: `${p.name}: placed by the program (Inferred) ${said}` }, records: [{ kind: p.kind, id: p.id, targetId: p.targetId }] });
  }
  for (const key of placed.keys()) skip.add(key);
  const writes: SpotCheckTarget[] = [];
  for (const jobId of jobIds) {
    for (const e of store.traceByJob(jobId, 5_000)) {
      const key = `${e.collection}:${e.id}`;
      if (e.op !== 'put' || skip.has(key) || !(e.collection in WEIGHT)) continue;
      skip.add(key);
      writes.push({ collection: e.collection, id: e.id, summary: e.summary, weight: WEIGHT[e.collection]! + (CODEISH.test(e.summary) ? 2 : 0) });
    }
  }
  const placedTargets = [...placed.values()].map((x) => x.target);
  const floor = Math.min(PLACEMENT_SAMPLE_FLOOR, placedTargets.length, size);
  const rest = [...placedTargets.slice(floor), ...writes].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id)).slice(0, Math.max(0, size - floor));
  const sample = [...placedTargets.slice(0, floor), ...rest];
  const sampled = new Set(sample.map((t) => `${t.collection}:${t.id}`));
  return {
    candidates, full, sample, written: placedTargets.length + writes.length,
    reasons: reasons.map(({ collection, id, field, reason }) => ({ collection, id, field, reason })),
    placements: [...placed].filter(([key]) => sampled.has(key)).flatMap(([, x]) => x.records),
    placementsUnreviewed: [...placed.values()].reduce((n, x) => n + x.records.length, 0),
  };
}

/** The spot-check's block of targets: the looked candidates with where they were looked for, then the sample. */
export function spotCheckBlock(store: ProjectStore, t: SpotCheckTargets): string {
  const lines: string[] = [];
  lines.push(`=== Breakpoint candidates a lane looked for and did not find (${t.candidates.length}): check every one against the original, the ledger and the code; pk_confirm kind breakpoint confirmed true lights it, confirmed false with the evidence puts it out`);
  for (const c of t.candidates) {
    const b = store.breakpoints.get(c.id);
    lines.push(`- ${c.id} · ${c.summary}`);
    for (const e of (b?.evidence ?? []).slice(0, 4)) lines.push(`  · ${e.kind} ${e.kind === 'file' ? e.label : e.id}${e.line ? `: “${clip(e.line, 160)}”` : ` (${clip(e.label, 100)})`}`);
  }
  if (!t.candidates.length) lines.push('None this round.');
  const reasonItems = new Set(t.reasons.map((r) => `${r.collection}:${r.id}`)).size;
  lines.push(`=== Checked in full, not sampled (${t.full.length}): every note current now — this round's and those standing from earlier rounds — everything else the synthesis wrote, the claims of the round's Result, and every reason that leaves an item unplaced and that no spot-check has checked yet, whichever round wrote it (noPlanWhy, noAreaWhy, wholeProductWhy: ${t.reasons.length ? `${t.reasons.length} on ${reasonItems} item${reasonItems === 1 ? '' : 's'}` : 'none'}), each with the records the program's trace names. Check each against the original, the ledger or the code, and record each (pk_record_spot_check)`);
  for (const s of t.full) lines.push(`- ${s.collection} ${s.id}: ${s.summary}`);
  if (!t.full.length) lines.push('Nothing: no note is current, the synthesis wrote nothing, and no reason stands unchecked.');
  lines.push(t.placementsUnreviewed
    ? `=== The sample (${t.sample.length} of ${t.written} other judgements: what this round wrote, and the program's ${t.placementsUnreviewed} Inferred placement${t.placementsUnreviewed === 1 ? '' : 's'} nobody has reviewed yet, of this round and earlier ones — ${t.placements.length} of them in the sample)`
    : `=== The sample (${t.sample.length} of ${t.written} other judgements this round wrote)`);
  for (const s of t.sample) lines.push(`- ${s.collection} ${s.id}: ${s.summary}`);
  return lines.join('\n');
}

// ───────────────────────── the start-up fix ─────────────────────────

/**
 * At start, once: a breakpoint lit without the independent check (lit by the program before D99) goes back to being a
 * candidate — not lit, not out, still recorded, for the lanes to look at and the spot-check to check. The owner's answers
 * are left as they are. Returns how many went back. Like `linkPutOutDeliveries`, a second run finds nothing.
 */
export function unlightUnchecked(store: ProjectStore): number {
  let n = 0;
  for (const b of store.breakpoints.filter((x) => x.lit && !x.checked && !x.ownerResponse)) {
    store.breakpoints.put({ ...b, lit: false, out: null, confirmedInRoundId: null, updatedAt: new Date().toISOString() }, {
      jobId: null, summary: `Breakpoint ${b.kind} on ${b.targetId}: a candidate again — it was lit without a lane's look and the independent check`,
    });
    n++;
  }
  return n;
}
