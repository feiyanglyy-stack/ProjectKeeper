/**
 * Each piece of work's process as the ledger shows it (Spec v3.0 §2.12 工作的过程): the steps in the order they happened,
 * what was done on the left and what reality gave on the right, and the four things every piece of work shows at a
 * glance (execution, progress, check, what is still open).
 *
 * The steps come from the ledger by the project's numbers (units.ts), then from the links the round confirmed:
 *
 * | step | from | result |
 * | --- | --- | --- |
 * | `Planned` | the plan version it entered (the plan's section in its document), or its task written and queued | plan and time |
 * | `Dispatched` | the prompt's first running version (else its first version, when it went on to be worked), a run file | to whom, when |
 * | `Delivered` | its own commits, branch and receipts; a receipt's account is a claim (§2.4) | commits, merged or not, tests |
 * | `Review` | the host's review written into the arrangement (`status: needs-repair`) | the status word as written |
 * | `QC` / `Review` / `Walkthrough` | a check's report | the verdict as written, findings counted |
 * | `Fix` | a unit that fixes this work, or a check of it | as `Delivered` |
 * | `Merged` | the merge that brought its commits into the trunk | the merge commit |
 * | `Accepted` | an owner's acceptance written in the arrangement | the record |
 * | `Handed to` / `Handed in` | a finding its report hands to another unit, or one handed to it | from where, to where |
 *
 * No step the project does not have is added; the order is what happened, not what should have (§2.12).
 */
import type { Occurred, EvidenceRef, ProcessLink, StepKind } from '../model/k-types.ts';
import { linkHolds, linkStanding } from '../model/k-types.ts';
import type { FourThingsView, ProcessStepView, ExecutionState } from '../model/views-k.ts';
import type { Project, WorkThread } from '../model/types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { stableId } from '../model/ids.ts';
import type { ArrangementFact, CommitFact, Facts, VerdictFact } from './facts.ts';
import { msOfOccurred } from './facts.ts';
import {
  DONE_STATUS, PLANNED_STATUS, REPAIR_STATUS, RUNNING_STATUS, baseNumber, chainOf, isArrangementPath, isHostEvidence, ownNumbers, type CheckKind, type Unit, type UnitIndex,
} from './units.ts';
import { definitionsInPath } from '../ledger/numbering.ts';
import { batchOf, planDocument, plansOf, versionOccurred } from './placement.ts';
import { earlierWork } from '../keeper/organize/carried-on.ts';
import {
  DISPOSE_WORDS, FAILING, IN_PROGRESS, SELF_DISPOSE_WORDS, claimLineOf, clausesOf, clip, deferLinesOf, evidenceLineOf, isTestCount, openItemsOf,
  rootCommentLineOf, severityOf, standsAlone, tokensOf, verdictAsWritten, withGloss, type OpenItem,
} from './text.ts';

// ───────────────────────── records the steps, the four things and the breakpoints share ─────────────────────────

export interface CheckRecord {
  readonly unit: string;
  readonly kind: CheckKind;
  readonly reportPath: string;
  /** The latest version of the report (its text is read through the ledger). */
  readonly report: ArrangementFact | null;
  /** The first version of the report. */
  readonly firstReport: ArrangementFact | null;
  /** The line that states the overall verdict. */
  readonly verdict: VerdictFact | null;
  readonly verdictWord: string | null;
  /** pass, fail, needs-repair …, or null when the report states none. */
  readonly normalized: string | null;
  /** The verdict rests on what the ledger lists only as candidates (section headings), not on a stated verdict. */
  readonly fromCandidates: boolean;
  readonly occurred: Occurred;
  readonly ms: number;
  readonly by: 'Independent QC' | 'Self-reported';
  /** The report is a check unit's (a QC, review or walkthrough task), not a delivery's own receipt: only such a verdict
   *  starts a send-back (§1.18 "QC 与走查的判定"). */
  readonly fromCheckUnit: boolean;
  /** The check has not concluded (`incomplete（审核进行中）`, `blocked`): shown as a check in progress, never as a failure. */
  readonly inProgress: boolean;
  readonly findings: readonly VerdictFact[];
  readonly counts: readonly VerdictFact[];
}

/**
 * A check whose verdict sends the work back (§1.18): a check unit's failing verdict (fail, 不通过, needs repair …). Not a
 * delivery's own account (CKC-27 AC-11), and not a check still in progress (`incomplete（审核进行中）`), which has judged
 * nothing yet.
 */
export const startsSendBack = (c: CheckRecord): boolean =>
  c.fromCheckUnit && c.verdict !== null && c.normalized !== null && FAILING.has(c.normalized);

export interface ReviewRecord {
  readonly unit: string;
  /** The status word as the arrangement wrote it (`needs-repair`). */
  readonly status: string;
  readonly entry: ArrangementFact;
  readonly receipts: readonly ArrangementFact[];
  readonly occurred: Occurred;
  readonly ms: number;
  readonly who: string | null;
}

export interface Handling {
  readonly how: 'disposed' | 'followed' | 'sent back' | 'handed';
  readonly evidence: EvidenceRef;
  /** The unit it was handed to. */
  readonly to?: string;
}

export interface FindingState {
  readonly check: CheckRecord;
  readonly finding: VerdictFact;
  readonly num: string;
  readonly handled: Handling | null;
}

export interface OpenItemState {
  readonly check: CheckRecord;
  readonly item: OpenItem;
  readonly handled: Handling | null;
}

export interface FixRecord {
  readonly unit: string;
  readonly ms: number;
  readonly occurred: Occurred;
  readonly evidence: readonly EvidenceRef[];
  /** When the fix was handed out (its dispatch). */
  readonly dispatched: { readonly ms: number; readonly occurred: Occurred; readonly evidence: EvidenceRef } | null;
  /** When its task was first written, queued or not: the task that catches a send-back (§1.18 `Returned`). */
  readonly taskWritten: { readonly ms: number; readonly occurred: Occurred; readonly evidence: EvidenceRef } | null;
  /** It delivered something: commits or a receipt (a fix only dispatched has nothing to re-check yet). */
  readonly delivered: boolean;
  /** Its code reached the trunk (its merge, or its commits on the trunk). */
  readonly landed: { readonly ms: number; readonly occurred: Occurred; readonly evidence: EvidenceRef } | null;
  readonly merges: readonly CommitFact[];
  readonly targets: readonly string[];
}

export interface Delivery {
  readonly commits: readonly CommitFact[];
  readonly codeCommits: readonly CommitFact[];
  readonly merges: readonly CommitFact[];
  readonly receipts: readonly ArrangementFact[];
  /** A receipt the arrangement names (`report: …`) that the ledger never saw committed. */
  readonly missingReceipt: string | null;
  readonly dispatched: { readonly occurred: Occurred; readonly ms: number; readonly entry: ArrangementFact } | null;
  readonly planned: { readonly occurred: Occurred; readonly ms: number; readonly evidence: EvidenceRef; readonly text: string; readonly basis: 'Explicit' | 'Inferred'; readonly unit: string | null } | null;
  /** The material says it is done: its arrangement's status, or the work item's progress. */
  readonly reportedDone: { readonly occurred: Occurred; readonly ms: number; readonly evidence: EvidenceRef | null } | null;
  /** Delivered code commits are there and none of them reached the trunk. */
  readonly unmerged: boolean;
  readonly branches: readonly string[];
  /** The work says it is an experiment or abandoned, or its worktree is an experiment of the scope (§1.1). */
  readonly experiment: EvidenceRef | null;
  /** When it was delivered: its last code commit, else its first receipt. */
  readonly deliveredAt: { readonly ms: number; readonly occurred: Occurred } | null;
}

export interface WorkProcess {
  readonly thread: WorkThread;
  readonly own: readonly string[];
  readonly chain: readonly string[];
  readonly steps: readonly ProcessStepView[];
  readonly delivery: Delivery;
  readonly checks: readonly CheckRecord[];
  readonly reviews: readonly ReviewRecord[];
  readonly fixes: readonly FixRecord[];
  readonly findings: readonly FindingState[];
  readonly openItems: readonly OpenItemState[];
  /** Null when neither the ids nor the round's links say how the work was carried out (§2.12: a lookup that finds nothing is not absence). */
  readonly execution: ExecutionState | null;
  readonly latestCheck: { readonly verdict: string; readonly by: 'Independent QC' | 'Self-reported' | 'Test'; readonly occurred: Occurred } | null;
  /** The confirmed links this process uses (a step on one of them is `Inferred`). */
  readonly linked: readonly ProcessLink[];
}

const STEP_ORDER: Record<StepKind, number> = { Planned: 0, Dispatched: 1, Delivered: 2, Review: 3, Fix: 4, Merged: 5, QC: 6, Walkthrough: 6, Accepted: 8, 'Handed to': 9, 'Handed in': 9 };

const short = (h: string): string => h.slice(0, 7);
export const statusOf = (a: ArrangementFact): string => (a.data.status ?? a.data.fields?.status ?? '').trim();
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** The id of the send-back a failed check or a host's `needs-repair` review starts (§1.18); sendbacks.ts records it. */
export const sendBackIdFor = (projectId: string, originEntryId: string): string => stableId('sb', projectId, 'origin', originEntryId);

export interface WorkContext {
  readonly store: ProjectStore;
  readonly project: Project;
  readonly facts: Facts;
  readonly index: UnitIndex;
}

/** A step to push: every step names the task that made it (`unit`, e.g. `AD` for AB's fix step), or null for a judged link. */
type StepInput = Omit<ProcessStepView, 'id' | 'unit'> & { readonly key: string; readonly unit: string | null };

// ───────────────────────── building a work item's process ─────────────────────────

export function processOf(ctx: WorkContext, thread: WorkThread): WorkProcess {
  const { facts, index, store } = ctx;
  const own = (index.threadNums.get(thread.id) ?? []).filter((n) => index.units.has(n));
  const chain = chainOf(index, own);
  const steps: ProcessStepView[] = [];
  const cited = new Set<string>();
  const push = (s: StepInput) => {
    const { key, ...rest } = s;
    for (const e of rest.evidence) cited.add(e.id);
    if (steps.some((x) => x.id === stableId('step', thread.id, rest.kind, key))) return;
    steps.push({ id: stableId('step', thread.id, rest.kind, key), ...rest });
  };
  // Work of an earlier generation, or no longer current, lies in history (D82). CZ: not work that was carried on under
  // the same number — that is the current plan's.
  const history = thread.validity !== 'Current' || earlierWork(store).has(thread.id);

  // ── the work's own units ──
  const ownUnits = own.map((n) => index.units.get(n)!);
  const delivery = deliveryOf(ctx, thread, ownUnits);
  const reviews: ReviewRecord[] = [];
  const checks: CheckRecord[] = [];
  const fixes: FixRecord[] = [];

  if (delivery.planned) {
    push({ key: 'planned', kind: 'Planned', occurred: delivery.planned.occurred, did: delivery.planned.text, unit: delivery.planned.unit, result: delivery.planned.evidence.label, verdict: null, who: null, evidence: [delivery.planned.evidence], basis: delivery.planned.basis, history, sendBackId: null });
  }
  for (const u of ownUnits) {
    const d = dispatchOf(u);
    if (d) {
      const who = whoOf(u, d);
      const status = statusOf(d);
      push({
        key: `dispatch:${u.num}`, kind: 'Dispatched', occurred: d.occurred, did: `${u.num} dispatched${u.title ? ` — ${clip(stripNum(u.title, u.num), 80)}` : ''}`, unit: u.num,
        result: [who ? `to ${who}` : null, status ? `status ${status}` : null].filter(Boolean).join(' · ') || 'task written',
        verdict: null, who, evidence: [facts.ref(d.id, status ? `status: ${status}` : d.data.title ?? null)], basis: 'Explicit', history: history || !arrangementStillThere(facts, d.path), sendBackId: null,
      });
    }
    for (const r of reviewsOf(ctx, u)) {
      reviews.push(r);
      pushReview(push, ctx, u, r, history);
    }
    if (u.nature === 'check') {
      // A check unit that is itself the work item: independent of what it checks when it checks another unit.
      for (const c of checksOf(ctx, u, u.relations.length ? 'Independent QC' : 'Self-reported')) { checks.push(c); pushCheck(push, ctx, c, history); }
    } else {
      const mine = delivery.commits.filter((c) => (index.commitUnits.get(c.hash) ?? []).includes(u.num));
      if (mine.length || u.receipts.length || missingReceiptOf(facts, u)) pushDelivery(push, ctx, u, mine, 'Delivered', history);
      for (const c of checksOf(ctx, u, 'Self-reported')) checks.push(c);
    }
    if (u.merges.length) pushMerges(push, ctx, u, u.merges);
    const accepted = acceptanceOf(u);
    if (accepted) push({ key: `accepted:${accepted.entry.id}`, kind: 'Accepted', occurred: accepted.entry.occurred, did: `${u.num} accepted`, unit: u.num, result: accepted.line, verdict: null, who: null, evidence: [facts.ref(accepted.entry.id, accepted.line)], basis: 'Explicit', history, sendBackId: null });
  }

  // ── the units that fix or check it (§2.12: related tasks name the work's number) ──
  for (const n of chain) {
    if (own.includes(n)) continue;
    const u = index.units.get(n)!;
    const targets = u.relations.filter((r) => chain.includes(r.num)).map((r) => r.num);
    for (const r of reviewsOf(ctx, u)) { reviews.push(r); pushReview(push, ctx, u, r, history); }
    const isCheck = u.nature === 'check' || (u.nature === 'work' && u.relations.some((r) => r.as === 'check'));
    if (isCheck) {
      const found = checksOf(ctx, u, 'Independent QC');
      for (const c of found) { checks.push(c); pushCheck(push, ctx, c, history, targets); }
      if (found.length === 0) {
        const d = dispatchOf(u);
        if (d) push({ key: `check-dispatched:${u.num}`, kind: u.checkKind ?? 'QC', occurred: d.occurred, did: `${u.num} ${checkWord(u.checkKind ?? 'QC')} of ${targets.join(', ') || 'it'} dispatched`, unit: u.num, result: 'no report yet', verdict: null, who: whoOf(u, d), evidence: [facts.ref(d.id, statusOf(d) ? `status: ${statusOf(d)}` : null)], basis: 'Explicit', history, sendBackId: null });
      }
    } else {
      const at = pushDelivery(push, ctx, u, u.commits.filter((c) => !c.merge), 'Fix', history, targets);
      const d = dispatchOf(u);
      const task = u.prompts[0] ?? d;
      const merge = u.merges[0];
      const onTrunk = merge ? null : u.commits.filter((c) => !c.merge && c.onTrunk).sort((x, y) => x.ms - y.ms)[0];
      if (at) {
        fixes.push({
          unit: u.num, ms: at.ms, occurred: at.occurred, evidence: at.evidence, merges: u.merges, targets, delivered: u.commits.some((c) => !c.merge) || u.receipts.length > 0,
          dispatched: d ? { ms: d.ms, occurred: d.occurred, evidence: facts.ref(d.id, statusOf(d) ? `status: ${statusOf(d)}` : d.data.title ?? null) } : null,
          taskWritten: task ? { ms: task.ms, occurred: task.occurred, evidence: facts.ref(task.id, task.data.title ?? (statusOf(task) ? `status: ${statusOf(task)}` : null)) } : null,
          landed: merge ? { ms: merge.ms, occurred: merge.occurred, evidence: facts.ref(merge.id) } : onTrunk ? { ms: onTrunk.ms, occurred: onTrunk.occurred, evidence: facts.ref(onTrunk.id) } : null,
        });
      }
    }
  }

  // ── findings of the checks: handled, handed to another unit, or still open ──
  const findings = findingsOf(ctx, checks, chain);
  for (const f of findings) {
    if (f.handled?.how !== 'handed' || !f.handled.to) continue;
    push({ key: `handed:${f.finding.id}:${f.handled.to}`, kind: 'Handed to', occurred: f.handled.evidence.occurred ?? f.check.occurred, did: `${f.num} (${f.check.unit}) handed to ${f.handled.to}`, unit: f.check.unit, result: clip(f.handled.evidence.line ?? f.handled.evidence.label, 120), verdict: null, who: null, evidence: [facts.ref(f.finding.id, f.finding.text), f.handled.evidence], basis: 'Explicit', history, sendBackId: null });
  }
  for (const h of handedIn(ctx, own)) push({ ...h, history });
  const openItems = openItemsOfChecks(ctx, checks);

  // ── links the round confirmed (§1.4: what the program could not tie by ids) ──
  // CJ: a link not confirmed yet is shown too, as Inferred and saying so — not as "no delivery linked yet" — but only a
  // confirmed one counts for the execution and the breakpoints. One step per work item, step and file; a check whose
  // file is the work item's own is not its check (a work item is never the QC of itself).
  const linked: ProcessLink[] = [];
  const mine = new Set(ownNumbersOf(thread));
  const shownFiles = new Set<string>();
  // A report the chain's own checks already show is not shown again as a link or a relation.
  for (const c of checks) for (const k of [c.kind, 'QC']) shownFiles.add(`${k}\u0000${c.reportPath.toLowerCase()}`);
  const links = store.links.filter((x) => x.workId === thread.id).sort((a, b) => Number(linkHolds(b)) - Number(linkHolds(a)) || Number(b.confirmed) - Number(a.confirmed) || a.at.localeCompare(b.at));
  for (const l of links) {
    if (cited.has(l.ledgerRef) || (l.evidence && cited.has(l.evidence.id))) continue;
    const checkKind = l.stepKind === 'QC' || l.stepKind === 'Review' || l.stepKind === 'Walkthrough';
    const file = linkFile(facts, l);
    if (file && checkKind && fileOwners(facts, file).some((n) => mine.has(n))) continue;
    const fileKey = file ? `${l.stepKind}\u0000${file.toLowerCase()}` : null;
    if (fileKey && shownFiles.has(fileKey)) continue;
    if (fileKey) shownFiles.add(fileKey);
    // CM: a lane-checked link (its evidence passed the program's check when written) counts like a confirmed one.
    if (linkHolds(l)) linked.push(l);
    const ev: EvidenceRef = l.evidence ?? facts.ref(l.ledgerRef);
    const occurred = ev.occurred ?? { at: l.at, basis: 'First observed' as const, anchor: l.ledgerRef, undated: true };
    const result = clip(ev.line ?? ev.label, 120);
    push({
      key: `link:${l.id}`, kind: l.stepKind, occurred, did: clip(l.why, 120), unit: null,
      result: l.confirmed ? result : l.check?.passed ? `Lane-checked · ${result}` : l.check ? `Suspect, not confirmed · ${result}` : `Inferred, not confirmed yet · ${result}`,
      verdict: checkKind && ev.line ? verdictAsWritten(ev.line) : null, who: null, evidence: [ev], basis: 'Inferred', history, sendBackId: null, link: linkStanding(l),
    });
  }
  // CJ: a check recorded as a `verifies` relation — from the report (its source) or a Review or Test item to this work
  // item, or to the Requirement of the same number — is its QC step, unless its report already made one.
  for (const r of store.relations.filter((x) => x.type === 'verifies' && verifiesThis(store, thread, x.to))) {
    const src = store.sources.get(r.from);
    const item = src ? null : store.reference.get(r.from);
    const file = src && src.anchor.kind === 'file' ? relativeFile(facts, src.anchor.path) : null;
    if (file && fileOwners(facts, file).some((n) => mine.has(n))) continue;
    const fileKey = file ? `QC\u0000${file.toLowerCase()}` : null;
    if (fileKey && shownFiles.has(fileKey)) continue;
    if (fileKey) shownFiles.add(fileKey);
    if (src && cited.has(src.id)) continue;
    const ev: EvidenceRef = src ? { kind: 'source', id: src.id, label: file ?? src.title, line: null, occurred: null } : { kind: 'object', id: r.from, label: item?.name ?? r.from, line: null, occurred: null };
    const firstVersion = src && file ? (facts.docsByPath.get(file) ?? [])[0] : undefined;
    const occurred = firstVersion ? versionOccurred(facts, firstVersion) : { at: r.updatedAt, basis: 'First observed' as const, anchor: r.id, undated: true };
    push({ key: `verifies:${r.id}`, kind: 'QC', occurred, did: clip(r.claim, 120), unit: null, result: clip(file ?? ev.label, 120), verdict: null, who: null, evidence: [ev], basis: r.basis === 'Explicit' ? 'Explicit' : 'Inferred', history, sendBackId: null });
  }

  steps.sort((a, b) => msOfOccurred(a.occurred) - msOfOccurred(b.occurred) || STEP_ORDER[a.kind] - STEP_ORDER[b.kind] || a.id.localeCompare(b.id));
  const execution = executionOf(thread, delivery, ownUnits, checks, linked, (l) => linkedOnTrunk(facts, l));
  const latestCheck = latestCheckOf(checks, ownUnits);
  return { thread, own, chain, steps, delivery, checks, reviews, fixes, findings, openItems, execution, latestCheck, linked };
}

const stripNum = (title: string, num: string): string => title.replace(new RegExp(`^${baseNumber(num).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[—–·:：-]*\\s*`), '');
const checkWord = (k: CheckKind): string => (k === 'QC' ? 'QC' : k.toLowerCase());

function arrangementStillThere(facts: Facts, path: string): boolean {
  return (facts.arrangementsByPath.get(path) ?? []).some((a) => a.current) || (facts.docsByPath.get(path) ?? []).some((d) => d.current);
}

// ───────────────────────── the own unit: planned, dispatched, delivered ─────────────────────────

/**
 * When the work was handed out: the prompt's first running version; when no version says running but the work went on
 * (a later status, commits, a receipt), its first version — the task written is the task handed out; a task only ever
 * ready or queued was not dispatched. A run status file counts when it is earlier.
 */
export function dispatchOf(u: Unit): ArrangementFact | null {
  const running = u.prompts.find((p) => RUNNING_STATUS.test(statusOf(p)));
  const wentOn = u.prompts.some((p) => statusOf(p) && !PLANNED_STATUS.test(statusOf(p))) || u.commits.length > 0 || u.receipts.length > 0;
  const fromPrompt = running ?? (wentOn ? u.prompts[0] ?? null : null);
  const run = u.runs[0] ?? null;
  if (run && (!fromPrompt || run.ms < fromPrompt.ms)) return run;
  return fromPrompt;
}

function whoOf(u: Unit, d: ArrangementFact): string | null {
  const f = d.data.fields ?? {};
  const executor = f.executor ?? f.agent ?? d.data.agent ?? u.executor;
  const model = f.requested_model ?? f.model ?? d.data.model ?? null;
  const worktree = f.worktree ?? d.data.worktree ?? null;
  const parts = [executor ? `${executor}${model && !executor.toLowerCase().includes(model.toLowerCase()) ? ` (${model})` : ''}` : null, worktree ? `worktree ${baseName(worktree.split(' ')[0]!)}` : null];
  return parts.filter(Boolean).join(' · ') || null;
}

/** A receipt the prompt names (`report: …`) that the ledger never saw in any version. */
export function missingReceiptOf(facts: Facts, u: Unit): string | null {
  const named = u.fields.report ?? u.fields.receipt ?? null;
  if (!named || u.receipts.length) return null;
  const rel = named.replace(/\\/g, '/').trim();
  return facts.hasDocument(rel) ? null : rel.replace(/^[A-Za-z]:\/[^/]+\//, '');
}

function deliveryOf(ctx: WorkContext, thread: WorkThread, units: readonly Unit[]): Delivery {
  const { facts, store, project } = ctx;
  const commits = [...new Map(units.flatMap((u) => u.commits).map((c) => [c.hash, c])).values()].sort((a, b) => a.ms - b.ms);
  const codeCommits = commits.filter((c) => facts.filesOf(c).some((f) => !isArrangementPath(f.path)));
  const merges = [...new Map(units.flatMap((u) => u.merges).map((c) => [c.hash, c])).values()].sort((a, b) => a.ms - b.ms);
  const receipts = units.flatMap((u) => u.receipts).sort((a, b) => a.ms - b.ms);
  const dispatches = units.map(dispatchOf).filter((d): d is ArrangementFact => d !== null).sort((a, b) => a.ms - b.ms);
  const dispatched = dispatches[0] ? { occurred: dispatches[0].occurred, ms: dispatches[0].ms, entry: dispatches[0] } : null;
  // Planned: the plan version it entered, or its task written and queued before it was dispatched.
  let planned: Delivery['planned'] = null;
  const plan = plansOf(store, thread)[0];
  if (plan) {
    const doc = planDocument(store, facts, plan);
    const batched = units.find((u) => batchOf(u) !== null) ?? null;
    const batch = batched ? batchOf(batched) : null;
    if (doc?.first) {
      const occurred = versionOccurred(facts, doc.first);
      const saysSo = units.some((u) => u.prompts.some((p) => `${p.data.title ?? ''} ${Object.values(p.data.fields ?? {}).join(' ')}`.includes(doc.path)));
      planned = {
        occurred, ms: msOfOccurred(occurred), basis: saysSo ? 'Explicit' : 'Inferred',
        text: `Planned in ${plan.name}${batch ? ` as batch ${batch.batch}${batch.part ?? ''}` : ''}`,
        evidence: facts.ref(doc.first.id, doc.section ? doc.headingPath[doc.headingPath.length - 1]! : null),
        unit: batched?.num ?? units[0]?.num ?? null,
      };
    }
  }
  const queued = units.flatMap((u) => {
    const firstRunning = u.prompts.find((p) => RUNNING_STATUS.test(statusOf(p)));
    const q = u.prompts.find((p) => PLANNED_STATUS.test(statusOf(p)));
    return q && firstRunning && q.ms < firstRunning.ms ? [{ q, u }] : [];
  }).sort((a, b) => a.q.ms - b.q.ms)[0];
  if (queued && (!planned || queued.q.ms < planned.ms)) {
    const { q, u } = queued;
    planned = { occurred: q.occurred, ms: q.ms, basis: 'Explicit', text: `${u.num} task written, not dispatched yet`, evidence: facts.ref(q.id, `status: ${statusOf(q)}`), unit: u.num };
  }
  if (planned && dispatched && planned.ms >= dispatched.ms) planned = null;
  // Reported done: the arrangement's status first, else the work item's progress.
  const doneVersion = units.flatMap((u) => u.prompts.filter((p) => DONE_STATUS.test(statusOf(p)))).sort((a, b) => a.ms - b.ms)[0];
  let reportedDone: Delivery['reportedDone'] = null;
  if (doneVersion) reportedDone = { occurred: doneVersion.occurred, ms: doneVersion.ms, evidence: facts.ref(doneVersion.id, `status: ${statusOf(doneVersion)}`) };
  else if (thread.progress === 'Done') {
    const r = receipts[0];
    reportedDone = r ? { occurred: r.occurred, ms: r.ms, evidence: facts.ref(r.id) } : { occurred: { at: thread.asOf || thread.updatedAt, basis: 'First observed', anchor: thread.id, undated: true }, ms: Date.parse(thread.asOf || thread.updatedAt) || 0, evidence: null };
  }
  const unmerged = codeCommits.length > 0 && !codeCommits.some((c) => c.onTrunk);
  const branches = [...new Set(units.flatMap((u) => u.branches))];
  const lastCode = codeCommits[codeCommits.length - 1];
  const deliveredAt = lastCode ? { ms: lastCode.ms, occurred: lastCode.occurred } : receipts[0] ? { ms: receipts[0].ms, occurred: receipts[0].occurred } : null;
  return {
    commits, codeCommits, merges, receipts, missingReceipt: units.map((u) => missingReceiptOf(facts, u)).find((x) => x !== null) ?? null, dispatched, planned, reportedDone,
    unmerged, branches, experiment: experimentOf(ctx, project, units, branches), deliveredAt,
  };
}

const EXPERIMENT_WORDS = /\bexperiment(?:al)?\b|实验|试验性|\babandon(?:ed)?\b|放弃|\bwithdrawn\b|撤回|\bsuperseded\b|作废|废弃/i;

/** §2.12 `Not merged` does not light when the project wrote that the work is an experiment or abandoned. */
function experimentOf(ctx: WorkContext, project: Project, units: readonly Unit[], branches: readonly string[]): EvidenceRef | null {
  for (const u of units) {
    const p = u.prompts[u.prompts.length - 1];
    if (!p) continue;
    for (const k of ['status', 'kind', 'note', 'result']) {
      const v = u.fields[k];
      if (v && EXPERIMENT_WORDS.test(v)) return ctx.facts.ref(p.id, `${k}: ${v}`);
    }
    const wt = u.fields.worktree ?? p.data.worktree ?? null;
    if (wt) {
      const name = baseName(wt.split(' ')[0]!).toLowerCase();
      const item = project.scope.find((i) => i.relation === 'Experiment' && baseName(i.path).toLowerCase() === name);
      if (item) return { kind: 'object', id: item.id, label: `${item.path} (scope: Experiment)`, line: item.reason || null, occurred: null };
    }
  }
  const b = branches.find((x) => /(?:^|\/)(?:exp|experiment|experiments|spike|poc|scratch)[-_/]/i.test(x));
  if (b) return { kind: 'object', id: `branch:${b}`, label: `branch ${b}`, line: null, occurred: null };
  return null;
}

function pushDelivery(push: (s: StepInput) => void, ctx: WorkContext, u: Unit, commits: readonly CommitFact[], kind: 'Delivered' | 'Fix', history: boolean, targets: readonly string[] = []): { ms: number; occurred: Occurred; evidence: EvidenceRef[] } | null {
  const { facts } = ctx;
  const code = commits.filter((c) => facts.filesOf(c).some((f) => !isArrangementPath(f.path)));
  const shown = code.length ? code : commits;
  const receipts = u.receipts;
  const d = dispatchOf(u);
  const missing = missingReceiptOf(facts, u);
  if (shown.length === 0 && receipts.length === 0 && !d) return null;
  const last = shown[shown.length - 1];
  const at = last ? { occurred: last.occurred, ms: last.ms } : receipts[0] ? { occurred: receipts[0].occurred, ms: receipts[0].ms } : { occurred: d!.occurred, ms: d!.ms };
  const onTrunk = shown.filter((c) => c.onTrunk);
  const merge = u.merges[u.merges.length - 1];
  const branch = u.branches[0] ?? null;
  const parts: string[] = [];
  if (shown.length) parts.push(`${shown.length} commit${shown.length === 1 ? '' : 's'} ${shown.length === 1 ? short(shown[0]!.hash) : `${short(shown[0]!.hash)}…${short(last!.hash)}`}${branch ? ` on ${branch}` : ''}`);
  if (merge) parts.push(`merged ${short(merge.hash)}`);
  else if (shown.length && onTrunk.length === shown.length) parts.push('on the trunk');
  else if (shown.length && onTrunk.length === 0) parts.push('not merged');
  const counts = receipts.flatMap((r) => (facts.verdictsByPath.get(r.path) ?? []).filter((v) => v.kind === 'count' && v.confidence === 'stated' && isTestCount(v.text, v.verdict)));
  const uniqueCounts = [...new Map(counts.map((c) => [c.id, c])).values()];
  if (uniqueCounts[0]) parts.push(`tests ${uniqueCounts[0].verdict}${uniqueCounts.length > 1 ? ` (+${uniqueCounts.length - 1} more counts)` : ''}`);
  const receipt = receipts[receipts.length - 1];
  const claim = receipt ? claimLineOf(facts.textOf(receipt.id)) : null;
  if (missing) parts.push(`no receipt: ${baseName(missing)}, which the prompt names, was never committed`);
  const hostEvidence = !receipts.length ? u.evidence[0] : undefined;
  const hostLine = hostEvidence ? evidenceLineOf(facts.textOf(hostEvidence.id), u.num) : null;
  if (hostEvidence) parts.push(`the host's evidence ${baseName(hostEvidence.path)}${hostLine ? `: ${clip(hostLine, 80)}` : ''}`);
  if (receipt) parts.push(`${baseName(receipt.path)}${claim ? ` (${clip(claim, 80)})` : ''}`);
  if (shown.length === 0 && receipts.length === 0) parts.push('dispatched, nothing delivered yet');
  const evidence: EvidenceRef[] = [
    ...(shown.length ? [facts.ref(shown[0]!.id)] : []),
    ...(shown.length > 1 ? [facts.ref(last!.id)] : []),
    ...(merge ? [facts.ref(merge.id)] : []),
    ...(receipt ? [facts.ref(receipt.id, claim)] : []),
    ...(hostEvidence ? [facts.ref(hostEvidence.id, hostLine)] : []),
    ...(uniqueCounts[0] ? [facts.ref(uniqueCounts[0].id, uniqueCounts[0].text)] : []),
    ...(!shown.length && !receipts.length && d ? [facts.ref(d.id)] : []),
  ];
  const fixOf = kind === 'Fix' && targets.length ? ` (fixes ${targets.join(', ')})` : '';
  push({
    key: `${kind}:${u.num}`, kind, occurred: at.occurred,
    did: `${u.num} ${kind === 'Fix' ? 'fix' : 'delivered'}${fixOf}${u.title ? ` — ${clip(stripNum(u.title, u.num), 70)}` : ''}`, unit: u.num,
    result: parts.join(' · '), verdict: null, who: d ? whoOf(u, d) : u.executor, evidence, basis: 'Explicit',
    history: history || (shown.length > 0 && onTrunk.length === 0 && u.merges.length === 0 && u.branches.length === 0), sendBackId: null,
  });
  return { ms: at.ms, occurred: at.occurred, evidence };
}

/** Its merges into the trunk as one step, when the work landed: a branch merged several times as it went is one landing. */
function pushMerges(push: (s: StepInput) => void, ctx: WorkContext, u: Unit, merges: readonly CommitFact[]): void {
  const { facts, index } = ctx;
  const last = merges[merges.length - 1]!;
  const others = [...new Set([...index.commitUnits.entries()].filter(([h]) => merges.some((m) => facts.introducedBy.get(h) === m.hash)).flatMap(([, us]) => us))].filter((n) => n !== u.num);
  push({
    key: `merge:${last.hash}`, kind: 'Merged', occurred: last.occurred,
    did: `${u.num} merged into the trunk${others.length ? ` together with ${others.join(', ')}` : ''}${merges.length > 1 ? ` (${merges.length} merges)` : ''}`, unit: u.num,
    result: merges.length > 1 ? `merges ${merges.map((m) => short(m.hash)).join(', ')} · last: ${clip(last.subject, 70)}` : `merge ${short(last.hash)} · ${clip(last.subject, 90)}`,
    verdict: null, who: null, evidence: merges.map((m) => facts.ref(m.id)), basis: 'Explicit', history: false, sendBackId: null,
  });
}

function pushReview(push: (s: StepInput) => void, ctx: WorkContext, u: Unit, r: ReviewRecord, history: boolean): void {
  const { facts, store, project } = ctx;
  const said = r.receipts.map((x) => ({ x, line: isHostEvidence(x.path) ? evidenceLineOf(facts.textOf(x.id), u.num) : rootCommentLineOf(facts.textOf(x.id)) ?? evidenceLineOf(facts.textOf(x.id), u.num) }));
  const first = said.find((x) => x.line) ?? said[0];
  push({
    key: `review:${r.entry.id}`, kind: 'Review', occurred: r.occurred, did: `${r.who ?? 'The host'} reviewed ${u.num}`, unit: u.num, verdict: r.status,
    result: [r.status, first ? `${baseName(first.x.path)}${first.line ? `: ${clip(first.line, 100)}` : ''}` : null].filter(Boolean).join(' · '),
    who: r.who, evidence: [facts.ref(r.entry.id, `status: ${r.status}`), ...said.map((x) => facts.ref(x.x.id, x.line))], basis: 'Explicit', history,
    sendBackId: sendBackOf(store, project.id, r.entry.id),
  });
}

// ───────────────────────── reviews by the host, and checks ─────────────────────────

/** The host's reviews written into the arrangement: each change of the status to `needs-repair` or the like. */
export function reviewsOf(ctx: WorkContext, u: Unit): ReviewRecord[] {
  const out: ReviewRecord[] = [];
  let previous = '';
  for (const p of u.prompts) {
    const s = statusOf(p);
    if (s && REPAIR_STATUS.test(s) && s !== previous) {
      // Who reviewed: the review field's `root = …`, else the host that dispatched it (`dispatched_by: root (…)`).
      const rr = p.data.fields?.root_review ?? p.data.fields?.review ?? '';
      const by = p.data.fields?.dispatched_by ?? '';
      const who = /root\s*=\s*([^;,]+)/i.exec(rr)?.[1]?.trim() ?? /\broot\s*\(([^)]+)\)/i.exec(by)?.[1]?.trim() ?? null;
      // What was written with the review: this task's receipts and the host's evidence in the same commit.
      const receipts = [...u.receipts, ...u.evidence].filter((a) => a.commit === p.commit).sort((x, y) => x.ms - y.ms || x.path.localeCompare(y.path));
      out.push({ unit: u.num, status: s, entry: p, receipts, occurred: p.occurred, ms: p.ms, who: who ? `root (${who})` : rr || /\broot\b/i.test(by) ? 'root' : null });
    }
    previous = s;
  }
  return out;
}

/** The checks one unit's reports record: the overall verdict, its findings and counts. */
export function checksOf(ctx: WorkContext, u: Unit, by: 'Independent QC' | 'Self-reported'): CheckRecord[] {
  const { facts } = ctx;
  const out: CheckRecord[] = [];
  const paths = [...new Set(u.receipts.map((r) => r.path))];
  for (const path of paths) {
    const rows = facts.verdictsByPath.get(path) ?? [];
    const stated = rows.filter((v) => v.kind === 'verdict' && v.confidence === 'stated').sort((a, b) => a.ms - b.ms || (a.line ?? 0) - (b.line ?? 0));
    // Section-heading verdicts (`## 1. 登录 — pass`) are how a walkthrough reports; in a delivery's own receipt they are
    // as often the state before the fix, so they count only for a check unit.
    const headings = u.nature === 'check' ? rows.filter((v) => v.kind === 'verdict' && v.confidence === 'candidate' && /^#{1,6}\s/.test(v.text)) : [];
    const overall = stated[0] ?? null;
    const fromCandidates = !overall && headings.length > 0;
    // From section headings: a failing section fails the report; all passing, it passes; a section not finished leaves
    // the whole in progress.
    const fromHeadings = (): string | null => {
      if (headings.some((h) => FAILING.has(h.verdict ?? ''))) return 'fail';
      if (headings.every((h) => h.verdict === 'pass')) return 'pass';
      if (headings.some((h) => IN_PROGRESS.has(h.verdict ?? ''))) return 'incomplete';
      return headings[0]!.verdict;
    };
    const normalized = overall?.verdict ?? (fromCandidates ? fromHeadings() : null);
    const inProgress = normalized !== null && IN_PROGRESS.has(normalized);
    const findings = rows.filter((v) => v.kind === 'finding' && v.confidence === 'stated' && /^[A-Z]{1,3}-\d{1,3}$/.test(v.verdict ?? ''));
    const counts = rows.filter((v) => v.kind === 'count' && v.confidence === 'stated');
    if (!overall && !fromCandidates && findings.length === 0) continue;
    const receipts = u.receipts.filter((r) => r.path === path);
    const verdictRow = overall ?? headings[0] ?? null;
    const occurred = verdictRow?.occurred ?? receipts[0]!.occurred;
    const written = overall ? verdictAsWritten(overall.text) ?? overall.verdict : null;
    out.push({
      unit: u.num, kind: u.checkKind ?? 'QC', reportPath: path, report: receipts[receipts.length - 1] ?? null, firstReport: receipts[0] ?? null, verdict: verdictRow,
      // A check still in progress keeps the words it said so with (`incomplete（审核进行中）`).
      verdictWord: overall ? (written && inProgress ? withGloss(overall.text, written) : written) : fromCandidates ? (normalized === 'pass' ? `pass ×${headings.length}` : normalized) : null,
      normalized, fromCandidates, occurred, ms: msOfOccurred(occurred), by, fromCheckUnit: u.nature === 'check', inProgress, findings, counts,
    });
  }
  return out;
}

function pushCheck(push: (s: StepInput) => void, ctx: WorkContext, c: CheckRecord, history: boolean, targets: readonly string[] = []): void {
  const { facts, store, project } = ctx;
  const own = ownFindings(c);
  const failing = startsSendBack(c);
  const severity = own.map((f) => severityOf(f.text)).filter((x): x is string => Boolean(x));
  const bySeverity = [...new Set(severity)].map((s) => `${severity.filter((x) => x === s).length} ${s}`).join(' / ');
  const result = [
    c.verdictWord ?? 'no verdict stated',
    c.inProgress ? 'check in progress, no verdict yet' : null,
    own.length ? `${own.length} finding${own.length === 1 ? '' : 's'}${bySeverity ? ` (${bySeverity})` : ''}` : null,
    own[0] && failing ? clip(own[0].text.replace(/^#+\s*/, ''), 90) : null,
    c.by === 'Self-reported' ? 'self-reported' : null,
  ].filter(Boolean).join(' · ');
  push({
    key: `check:${c.reportPath}`, kind: c.kind, occurred: c.occurred,
    did: `${c.unit} ${c.by === 'Independent QC' ? 'independent ' : ''}${checkWord(c.kind)}${targets.length ? ` of ${targets.join(', ')}` : ''}`, unit: c.unit,
    result, verdict: c.verdictWord, who: null,
    evidence: [...(c.verdict ? [facts.ref(c.verdict.id, c.verdict.text)] : []), ...own.slice(0, 12).map((f) => facts.ref(f.id, f.text))],
    basis: c.fromCandidates ? 'Inferred' : 'Explicit', history, sendBackId: failing && c.verdict ? sendBackOf(store, project.id, c.verdict.id) : null,
  });
}

/** The findings a report introduces: the first line of each number, except a check re-reading an earlier finding (`→ 已修`). */
export function ownFindings(c: CheckRecord): VerdictFact[] {
  const seen = new Set<string>();
  const out: VerdictFact[] = [];
  for (const f of [...c.findings].sort((a, b) => (a.line ?? 0) - (b.line ?? 0))) {
    const n = f.verdict!;
    if (seen.has(n)) continue;
    seen.add(n);
    if (/已修|已解决|已关闭|已处理|→\s*已|\bfixed\b|\bresolved\b|\bclosed\b/i.test(f.text)) continue;
    out.push(f);
  }
  return out;
}

/** An existing send-back that started from this entry (a verdict, a review), whoever recorded it. */
export function sendBackOf(store: ProjectStore, projectId: string, originEntryId: string): string | null {
  const id = sendBackIdFor(projectId, originEntryId);
  if (store.sendbacks.has(id)) return id;
  return store.sendbacks.find((s) => s.from.id === originEntryId)?.id ?? null;
}

function acceptanceOf(u: Unit): { entry: ArrangementFact; line: string } | null {
  for (const p of u.prompts) {
    for (const [k, v] of Object.entries(p.data.fields ?? {})) {
      if (/^(owner_accept(?:ed|ance)?|accepted_by_owner|owner_sign_?off)$/i.test(k) && v.trim()) return { entry: p, line: `${k}: ${v}` };
      if (/^(acceptance|accepted_by)$/i.test(k) && /\bowner\b|owner\s*验收/i.test(v)) return { entry: p, line: `${k}: ${v}` };
    }
  }
  return null;
}

// ───────────────────────── findings: handled or still open (§2.13 row 5) ─────────────────────────

/** A section of a report where it is dealt with what the report found: the root comment, the disposition. */
const DISPOSITION_HEADING = /root comment|root disposition|处置|disposition|response|回应|root 的|决定/i;
/** A line that does something with a finding: accepts it, fixes it, sends it on, leaves it for later. */
const DISPOSITION_VERB = /处置|接受|不处理|不修|修(?:复|掉|好)?|进下一批|下一批|并入|留给|留到|记下|延后|推迟|转给|交给|送回|\baccept|\bfix|\bdefer|\bwon'?t\b|\bhandled?\b|\bmoved? to\b|\bgoes? to\b/i;

function findingsOf(ctx: WorkContext, checks: readonly CheckRecord[], chain: readonly string[]): FindingState[] {
  const { facts, index, store } = ctx;
  const out: FindingState[] = [];
  const definedAt = new Map<string, number>();
  for (const c of [...checks].sort((a, b) => a.ms - b.ms)) {
    const own = ownFindings(c).filter((f) => { const t = definedAt.get(f.verdict!); return t === undefined || t >= f.ms; });
    for (const f of own) if (!definedAt.has(f.verdict!)) definedAt.set(f.verdict!, f.ms);
    if (own.length === 0) continue;
    const reportRows = facts.verdictsByPath.get(c.reportPath) ?? [];
    const text = c.report ? facts.textOf(c.report.id) : null;
    const lines = text ? text.split(/\r?\n/) : [];
    const headingAt: string[] = [];
    let heading = '';
    lines.forEach((l, i) => { const m = /^\s{0,3}#{1,6}\s+(.*)$/.exec(l); if (m) heading = m[1]!; headingAt[i] = heading; });
    const numRows = facts.numsOf(own.map((f) => f.verdict!));
    const context = new Set<string>([c.unit, ...chain]);
    for (const f of own) {
      const num = f.verdict!;
      let handled: Handling | null = null;
      // 1. The same report deals with it further down: its root comment, its disposition. A clause that hands it to
      //    another unit (`F-4 并入正在跑的 AJ`) says where it went; else the first line that disposes of it.
      const dispositions: Handling[] = [];
      for (let i = f.line ?? 0; i < lines.length; i++) {
        const l = lines[i]!;
        if (!standsAlone(l, num) || /^\s{0,3}#/.test(l)) continue;
        for (const clause of l.split(/[，,；;。]/).filter((x) => standsAlone(x, num))) {
          if (!DISPOSITION_HEADING.test(headingAt[i] ?? '') && !DISPOSITION_VERB.test(clause)) continue;
          const others = [...index.units.keys()].filter((n) => !context.has(n) && standsAlone(clause, n));
          // Cite the ledger's own entry for that line (a verdict row or the number's row), which dates it by the version it first appeared in.
          const row = reportRows.find((r) => r.line === i + 1 && r.id !== f.id) ?? (numRows.get(num) ?? []).find((r) => r.path === c.reportPath && r.line === i + 1);
          const ev: EvidenceRef = row ? facts.ref(row.id, l.trim()) : { kind: 'file', id: c.reportPath, label: `${c.reportPath}:${i + 1}`, line: l.trim(), occurred: c.report?.occurred ?? c.occurred };
          dispositions.push(others.length ? { how: 'handed', evidence: ev, to: others[0]! } : { how: 'disposed', evidence: ev });
        }
      }
      handled = dispositions.find((d) => d.how === 'handed') ?? dispositions[0] ?? null;
      // 2. A later document or commit of the chain names it (a fix prompt, the next QC).
      if (!handled) {
        const rows = numRows.get(num) ?? [];
        const later = rows.filter((r) => r.ms >= f.ms && r.path !== c.reportPath && standsAlone(r.context, num))
          .filter((r) => { const named = index.namedIn.get(r.kind === 'commit' ? `commit:${r.commit}` : `path:${r.path}`); return named !== undefined && [...context].some((n) => named.has(n)); })
          .sort((a, b) => a.ms - b.ms)[0];
        if (later) handled = { how: 'followed', evidence: facts.ref(later.id, later.context) };
        else if (rows.length === 0) handled = followedLater(ctx, c, [num], context);
      }
      // 3. A send-back suggested for it carries it — not the one the failed check itself started, which covers the
      //    check as a whole and closes when a re-check passes, whatever became of this finding.
      if (!handled) {
        const sb = store.sendbacks.find((s) => s.from.id !== c.verdict?.id && s.evidence.some((e) => e.id === f.id));
        if (sb) handled = { how: 'sent back', evidence: { kind: 'object', id: sb.id, label: `Send-back to ${sb.to}: ${sb.what}`, occurred: sb.occurred } };
      }
      out.push({ check: c, finding: f, num, handled });
    }
  }
  return out;
}

/** Findings of other units' checks that a report hands to this work (`F-4 并入正在跑的 AJ`): `Handed in`. */
function handedIn(ctx: WorkContext, own: readonly string[]): (Omit<StepInput, 'history'>)[] {
  const { facts, index } = ctx;
  const out: (Omit<StepInput, 'history'>)[] = [];
  if (own.length === 0) return out;
  const nums = facts.numsOf(own);
  const seen = new Set<string>();
  for (const n of own) {
    for (const r of nums.get(n) ?? []) {
      if (r.kind !== 'doc' || !r.path) continue;
      const reportRows = facts.verdictsByPath.get(r.path);
      if (!reportRows) continue;
      const clause = r.context.split(/[，,；;。]/).find((x) => standsAlone(x, n)) ?? r.context;
      if (!DISPOSITION_VERB.test(clause)) continue;
      const finding = reportRows.find((v) => v.kind === 'finding' && v.confidence === 'stated' && v.verdict && standsAlone(clause, v.verdict) && (v.line ?? 0) < (r.line ?? 0));
      if (!finding) continue;
      const from = facts.arrangementsByPath.get(r.path)?.[0]?.ident ?? null;
      if (!from || own.includes(from) || !index.units.has(from) || seen.has(finding.id)) continue;
      seen.add(finding.id);
      out.push({ key: `handed-in:${finding.id}`, kind: 'Handed in', occurred: r.occurred, did: `${finding.verdict} from ${from} handed in`, unit: from, result: clip(r.context, 120), verdict: null, who: null, evidence: [facts.ref(finding.id, finding.text), facts.ref(r.id, r.context)], basis: 'Explicit', sendBackId: null });
    }
  }
  return out;
}

// ───────────────────────── a passing report's items left for later ─────────────────────────

function openItemsOfChecks(ctx: WorkContext, checks: readonly CheckRecord[]): OpenItemState[] {
  const { facts } = ctx;
  const out: OpenItemState[] = [];
  for (const c of checks) {
    if (c.normalized !== 'pass' || !c.report) continue;
    const text = facts.textOf(c.report.id);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    const rows = facts.verdictsByPath.get(c.reportPath) ?? [];
    const findingNums = [...new Set(rows.filter((v) => v.kind === 'finding' && /^[A-Z]{1,3}-\d{1,3}$/.test(v.verdict ?? '')).map((v) => v.verdict!))];
    const items = [...openItemsOf(text), ...deferLinesOf(text).filter((d) => findingNums.some((n) => standsAlone(d.text, n)))];
    for (const item of items) {
      // The item's own tokens, and those of the finding it names (whose line says where in the code it is).
      const named = findingNums.filter((n) => standsAlone(item.text, n));
      const defLines = named.flatMap((n) => rows.filter((v) => v.kind === 'finding' && v.verdict === n).slice(0, 1).map((v) => v.text));
      const tokens = [...new Set([...tokensOf(item.text), ...defLines.flatMap(tokensOf)])].filter((t) => !named.includes(t));
      let handled: Handling | null = null;
      if (SELF_DISPOSE_WORDS.test(item.text)) handled = { how: 'disposed', evidence: lineRef(c, item.line, item.text) };
      for (let i = item.line; i < lines.length && !handled && tokens.length; i++) {
        const clause = clausesOf(lines[i]!).find((x) => tokens.some((t) => x.includes(t)) && DISPOSE_WORDS.test(x));
        if (clause) handled = { how: 'disposed', evidence: lineRef(c, i + 1, lines[i]!.trim()) };
      }
      if (!handled) handled = followedLater(ctx, c, tokens, null);
      out.push({ check: c, item, handled });
    }
  }
  return out;
}

function lineRef(c: CheckRecord, line: number, text: string): EvidenceRef {
  return { kind: 'file', id: c.reportPath, label: `${c.reportPath}:${line}`, line: text, occurred: c.report?.occurred ?? c.occurred };
}

/**
 * A later document version or commit (after the report first appeared) that carries one of the tokens — not the report
 * itself, and not the checking unit's own prompt or receipts. With `context`, only material that names one of those units.
 */
function followedLater(ctx: WorkContext, c: CheckRecord, tokens: readonly string[], context: ReadonlySet<string> | null): Handling | null {
  const { facts, index } = ctx;
  const since = c.firstReport?.ms ?? c.ms;
  const ownPaths = new Set([...(index.units.get(c.unit)?.prompts ?? []), ...(index.units.get(c.unit)?.receipts ?? [])].map((a) => a.path));
  for (const t of tokens) {
    const hits = facts.ledger.word(t, { limit: 300, oldestFirst: true });
    if (typeof hits === 'string') continue;
    for (const h of hits.rows) {
      if (h.kind !== 'doc' && h.kind !== 'commit' && h.kind !== 'loose') continue;
      const path = h.kind === 'doc' ? h.label.split(' — ')[0]! : null;
      if (path && (path === c.reportPath || ownPaths.has(path))) continue;
      const first = msOfOccurred(h.occurred);
      const last = h.last ? Date.parse(h.last.at) || first : first;
      if (Math.max(first, last) <= since) continue;
      if (context) {
        const named = index.namedIn.get(h.kind === 'commit' ? `commit:${facts.commitByPrefix(h.id.replace(/^commit:/, ''))?.hash ?? ''}` : `path:${path}`);
        if (!named || ![...context].some((n) => named.has(n))) continue;
      }
      const id = h.kind === 'doc' && h.last && last > since && first <= since ? h.last.id : h.id;
      return { how: 'followed', evidence: facts.ref(id, h.snippet) };
    }
  }
  return null;
}

// ───────────────────────── the four things ─────────────────────────

/** A confirmed link whose fact is a commit on the trunk. */
function linkedOnTrunk(facts: Facts, l: ProcessLink): boolean {
  const hash = l.ledgerRef.startsWith('commit:') ? l.ledgerRef.slice('commit:'.length) : l.evidence?.kind === 'commit' ? l.evidence.id : null;
  return hash ? facts.commitByPrefix(hash)?.onTrunk === true : false;
}

function executionOf(thread: WorkThread, d: Delivery, units: readonly Unit[], checks: readonly CheckRecord[], linked: readonly ProcessLink[], onTrunk: (l: ProcessLink) => boolean): ExecutionState | null {
  const hasCode = d.codeCommits.length > 0;
  if (hasCode && d.codeCommits.some((c) => c.onTrunk)) return 'Merged';
  // A check or a report-only piece of work lands as its report on the trunk.
  if (!hasCode && units.some((u) => u.nature === 'check') && checks.some((c) => c.report?.current)) return 'Merged';
  if (!hasCode && d.reportedDone && d.receipts.some((r) => r.current)) return 'Merged';
  if (hasCode && d.reportedDone) return 'Not merged';
  // What the round confirmed where the ids could not tie it (§1.4): the work's delivered or merged commits.
  const delivered = linked.filter((l) => l.stepKind === 'Delivered' || l.stepKind === 'Fix' || l.stepKind === 'Merged');
  if (delivered.length) return delivered.some((l) => l.stepKind === 'Merged' || onTrunk(l)) ? 'Merged' : 'In progress';
  if (hasCode || d.dispatched || d.receipts.length || thread.progress === 'In progress' || thread.progress === 'On hold') return 'In progress';
  // Said to be done, and nothing ties its execution to it yet: that is not evidence it never started (§2.12). The
  // deepening's reading ties it, or leaves a finding that says what is missing; until then the execution is not shown.
  if (thread.progress === 'Done') return null;
  return 'Not started';
}

/** A run status file's recorded outcome (a headless run's result or exit code): the one test record the ledger holds. */
function latestRunResult(units: readonly Unit[]): { verdict: string; occurred: Occurred; ms: number } | null {
  const runs = units.flatMap((u) => u.runs).filter((r) => r.data.json && (r.data.json.exit_code !== undefined || typeof r.data.json.result === 'string')).sort((a, b) => b.ms - a.ms);
  const r = runs[0];
  if (!r) return null;
  const j = r.data.json!;
  return { verdict: typeof j.result === 'string' ? j.result : `exit ${String(j.exit_code)}`, occurred: r.occurred, ms: r.ms };
}

/** The latest check and who made it (CKC-27 AC-11: a self-report is never written as a check someone else made). */
function latestCheckOf(checks: readonly CheckRecord[], units: readonly Unit[]): WorkProcess['latestCheck'] {
  const latest = [...checks].filter((c) => c.normalized || c.verdictWord).sort((a, b) => b.ms - a.ms)[0] ?? null;
  const run = latestRunResult(units);
  if (latest && (!run || latest.ms >= run.ms)) {
    const word = latest.verdictWord ?? latest.normalized!;
    return { verdict: latest.inProgress ? `${word} · in progress` : word, by: latest.by, occurred: latest.occurred };
  }
  return run ? { verdict: run.verdict, by: 'Test', occurred: run.occurred } : null;
}

/** The four things of one work item (§2.12); the open counts read what the runner last wrote on the workbench. */
export function fourThingsOf(store: ProjectStore, p: WorkProcess, expectsCheck: boolean): FourThingsView {
  const breakpoints = store.breakpoints.filter((b) => b.targetId === p.thread.id && b.lit && !b.ownerResponse).length;
  const sendBacks = store.sendbacks.filter((s) => s.targetId === p.thread.id && s.stage !== 'Closed' && !s.ownerResponse).length;
  const findings = p.findings.filter((f) => !f.handled).length + p.openItems.filter((i) => !i.handled).length;
  return {
    execution: p.execution, progress: p.thread.progress,
    check: p.latestCheck ?? (expectsCheck ? 'Not checked' : null),
    open: { findings, sendBacks, breakpoints },
  };
}

// ───────────────────────── CJ: which file a link or a check is, and whose ─────────────────────────

/** A work item's own numbers, as the process engine reads them (units.ts). */
function ownNumbersOf(t: WorkThread): string[] {
  return ownNumbers(t).map((n) => n.toUpperCase());
}

/** The repository-relative file of an absolute path under one of the ledger's repositories, or null. */
function relativeFile(facts: Facts, abs: string): string | null {
  const a = abs.replace(/\\/g, '/');
  for (const r of facts.ledger.repos()) {
    const root = r.path.replace(/\\/g, '/').replace(/\/+$/, '');
    if (a.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return a.slice(root.length + 1);
  }
  return null;
}

/** The file a link's fact is about (a file, a source's file, a ledger entry's document), or null for a commit. */
function linkFile(facts: Facts, l: ProcessLink): string | null {
  const ev = l.evidence;
  if (ev?.kind === 'file') return ev.id.replace(/\\/g, '/');
  if (l.ledgerRef.startsWith('file:')) return l.ledgerRef.slice('file:'.length).replace(/\\/g, '/');
  if (ev?.kind === 'ledger' || (!ev && !l.ledgerRef.includes(':'))) return facts.ledger.pathOfEntry(ev?.id ?? l.ledgerRef)?.path ?? null;
  return null;
}

/** The numbers a file belongs to: the work ids its arrangement versions are about, and the numbers its path defines. */
function fileOwners(facts: Facts, path: string): string[] {
  const kinds = facts.ledger.arrangementKinds(path);
  return [...new Set([...kinds.map((k) => k.ident ?? ''), ...definitionsInPath(path).map((d) => d.num)].filter(Boolean).map((x) => x.toUpperCase()))];
}

/** A `verifies` relation's target is this work item, or the Requirement of the same number it stands for. */
function verifiesThis(store: ProjectStore, t: WorkThread, to: string): boolean {
  if (to === t.id) return true;
  const r = store.reference.get(to);
  if (!r || r.category !== 'Requirement') return false;
  const nums = new Set(t.ids.map((i) => i.toUpperCase()));
  return r.ids.some((i) => nums.has(i.toUpperCase())) || t.serves.some((s) => s.referenceId === to && /the same row/.test(s.claim));
}
