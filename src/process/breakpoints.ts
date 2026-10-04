/**
 * Breakpoints (Spec v3.0 §2.12 断点): where the next step of the flow should be there and has no trace. An observation on
 * an object, not a ticket: later evidence puts it out by itself; the owner's `No action needed` stops it lighting up and
 * stays; whether the next step is due follows the project's own rules (§1.15 `expects`; D72: ProjectKeeper adds no steps
 * to a project and asks nobody to write more for it).
 *
 * | kind | on | lit when | six (§2.13) | needs |
 * | --- | --- | --- | --- | --- |
 * | `Not planned` | owner's words, requirements | nothing downstream reaches a plan item or a work item; not deferred or abandoned | 3 | `Written plan` |
 * | `Not started` | planned work | its batch has started; no dispatch, branch or commit of its own | — | — |
 * | `Not merged` | work with commits that says it is done | its commits are not on the trunk; not written as an experiment or abandoned | — | — |
 * | `No trace of done` | work reported done | no commit and no product of its own in the ledger | — | — |
 * | `Not checked` | work the rules say is checked | no independent check at all | — | `Independent check` |
 * | `Findings open` | a check's findings | no fix, send-back or disposition afterwards | 5 | — |
 * | `Passed with open items` | a check that passed | its report leaves items for later that nothing followed up | 5 | — |
 * | `Fix not re-checked` | a fix the rules say is checked again | no check after the fix | 5 | `Re-check after fix` |
 * | `No plan` | work merged into the trunk | traces to no plan item, owner's words or decision | 4 | `Written plan` |
 * | `Downstream behind` | current downstream of a superseded version | a current object still cites what was superseded | 1 | — (Inferred) |
 * | `Not carried out` | a decision with a date or a precondition | due, and no later trace | 2 | — (Inferred) |
 *
 * `basis` is `Explicit` when the ledger's ids alone show it, `Inferred` when it rests on a judged link or a judged
 * relation, for the round's steps to confirm or refute (§3.3). The ids are stable per kind and object.
 *
 * D99 (§2.12 没有痕迹，要读过才算; CKC-24 AC-7, CKC-23 AC-22): "lit when" above is when the program computes a candidate.
 * A candidate lights only after a lane looked for the missing step and did not find it (pk_record_looked, `looked`) and
 * the round's independent spot-check confirmed it (pk_confirm, `checked`); a First usable round lights nothing.
 * `breakpoint-candidates.ts` holds the lighting rule, the spot-check's targets and the start-up fix.
 */
import type { Breakpoint, BreakpointKind, EvidenceRef, Occurred, SixThing } from '../model/k-types.ts';
import type { ProjectRule, ReferenceItem, WorkThread } from '../model/types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { stableId } from '../model/ids.ts';
import { datesOnLine, msOf } from '../ledger/time.ts';
import { replacedNumbers } from '../ledger/lines.ts';
import { itemRanges } from '../ledger/item-range.ts';

import type { Analysis } from './analysis.ts';
import { msOfOccurred } from './facts.ts';
import { batchOf, workOfPlan } from './placement.ts';
import { clip, standsAlone } from './text.ts';
import { earlierGenerationOf, earlierWork } from '../keeper/organize/carried-on.ts';
import { startsSendBack, type WorkProcess } from './work.ts';

/** §2.12's table: the six things each kind is material for. */
export const SIX_OF: Readonly<Record<BreakpointKind, SixThing | null>> = {
  'Not planned': 3, 'Not started': null, 'Not merged': null, 'No trace of done': null, 'Not checked': null, 'Findings open': 5,
  'Passed with open items': 5, 'Fix not re-checked': 5, 'No plan': 4, 'Downstream behind': 1, 'Not carried out': 2,
};

export const BREAKPOINT_KINDS: readonly BreakpointKind[] = Object.keys(SIX_OF) as BreakpointKind[];

export interface Candidate {
  readonly kind: BreakpointKind;
  readonly targetId: string;
  readonly why: string;
  readonly evidence: readonly EvidenceRef[];
  readonly basis: 'Explicit' | 'Inferred';
  readonly since: Occurred;
  readonly familyBasis?: Breakpoint['familyBasis'];
}

/** What the computation found for one kind and object: lit, or out with the evidence that the step did happen. */
export type Finding = { readonly lit: Candidate } | { readonly out: readonly EvidenceRef[]; readonly kind: BreakpointKind; readonly targetId: string };

export const breakpointId = (projectId: string, kind: BreakpointKind, targetId: string): string => stableId('bp', projectId, kind, targetId);
const keyOf = (kind: BreakpointKind, targetId: string): string => `${kind}\x1f${targetId}`;

// ───────────────────────── evidence helpers ─────────────────────────

function objectRef(store: ProjectStore, id: string, line: string | null = null, occurred: Occurred | null = null): EvidenceRef {
  const t = store.threads.get(id);
  const r = t ? undefined : store.reference.get(id);
  const rule = t || r ? undefined : store.rules.get(id);
  const label = t ? `${t.ids[0] ? `${t.ids[0]} ` : ''}${t.title}` : r ? `${r.category}: ${r.name}` : rule ? `Rule: ${rule.summary}` : id;
  return { kind: 'object', id, label, line: line ?? (r?.quote ? clip(r.quote, 200) : rule?.excerpt ? clip(rule.excerpt, 200) : null), occurred };
}

const undated = (at: string, anchor: string | null): Occurred => ({ at, basis: 'First observed', anchor, undated: true });

/** When a reference item's material happened: its first source's time (a session message, a commit, the document version). */
function itemOccurred(a: Analysis, item: ReferenceItem): Occurred {
  const { store, facts } = a;
  for (const sid of item.sourceIds) {
    const s = store.sources.get(sid);
    if (!s) continue;
    const an = s.anchor;
    if (an.kind === 'session' && an.at) return { at: an.at, basis: 'Session', anchor: sid };
    if (an.kind === 'commit') { const c = facts.commitByPrefix(an.commit); if (c) return c.occurred; }
    if (an.kind === 'revision') { const c = facts.commitByPrefix(an.commit); if (c) return c.occurred; }
    if (an.kind === 'file') {
      const at = facts.relPathOf(an.path);
      if (!at) continue;
      const versions = (facts.docsByPath.get(at.path) ?? []).filter((d) => d.repo === at.repo);
      const section = an.headingPath.join(' › ');
      const first = versions.find((d) => section && (d.added.includes(section) || d.changed.includes(section))) ?? versions[0];
      if (first) return facts.entry(first.id)?.occurred ?? { at: new Date(first.ms).toISOString(), basis: 'Commit', anchor: first.id };
    }
  }
  return undated(item.asOf || item.updatedAt, item.id);
}

// ───────────────────────── which work the breakpoints about work look at ─────────────────────────

/**
 * Current work of the current generation: struck work and earlier generations light nothing (their end closed them). CZ:
 * an item an earlier generation lists that was carried on under the same number is current work, and may light.
 */
function liveWork(a: Analysis): WorkThread[] {
  const gen = earlierWork(a.store);
  return a.store.threads.filter((t) => t.validity === 'Current' && !gen.has(t.id));
}

/** The work item a check's findings hang on: the check's own work item, else the work it checks, else the chain's root. */
function checkTarget(a: Analysis, checkUnit: string, root: WorkThread): string {
  const own = a.index.threadOf.get(checkUnit);
  if (own && a.store.threads.get(own)?.validity === 'Current') return own;
  const u = a.index.units.get(checkUnit);
  for (const r of u?.relations ?? []) { const t = a.index.threadOf.get(r.num); if (t) return t; }
  return root.id;
}

// ───────────────────────── the eleven kinds ─────────────────────────

export function computeFindings(a: Analysis): Finding[] {
  const out: Finding[] = [];
  const work = liveWork(a);
  const processes = new Map(work.map((t) => [t.id, a.process(t.id)!]));
  out.push(...notPlanned(a));
  out.push(...notStarted(a, work, processes));
  for (const t of work) out.push(...aboutWork(a, t, processes.get(t.id)!));
  out.push(...findingsOpen(a, work, processes));
  out.push(...passedWithOpenItems(a, work, processes));
  out.push(...fixNotRechecked(a, work, processes));
  out.push(...downstreamBehind(a));
  out.push(...notCarriedOut(a));
  // One result per kind and object: a lit one wins over an out one computed from another chain.
  const merged = new Map<string, Finding>();
  for (const f of out) {
    const k = 'lit' in f ? keyOf(f.lit.kind, f.lit.targetId) : keyOf(f.kind, f.targetId);
    const prev = merged.get(k);
    if (!prev) { merged.set(k, f); continue; }
    if ('lit' in f && 'lit' in prev) merged.set(k, { lit: { ...prev.lit, evidence: dedupe([...prev.lit.evidence, ...f.lit.evidence]) } });
    else if ('lit' in f) merged.set(k, f);
  }
  return [...merged.values()];
}

const dedupe = (xs: readonly EvidenceRef[]): EvidenceRef[] => [...new Map(xs.map((e) => [`${e.kind}\x1f${e.id}\x1f${e.line ?? ''}`, e])).values()];

/** `Not planned`: owner's words and requirements nothing downstream brings to a plan item or a piece of work. */
function notPlanned(a: Analysis): Finding[] {
  const { store } = a;
  const below = downstreamIndex(store);
  const rules = store.rules.filter((r) => r.validity === 'Current' && r.group === 'How work is organized' && (r.expects ?? []).includes('Written plan'));
  const items = store.reference.filter((r) => r.category === "Owner's words" || r.category === 'Requirement');
  const out: Finding[] = [];
  for (const item of items) {
    const rule = rules.find((r) => ruleCoversItem(r, item));
    if (!rule || item.validity !== 'Current') {
      out.push({ out: [objectRef(store, rule ? item.id : (rules[0]?.id ?? item.id))], kind: 'Not planned', targetId: item.id });
      continue;
    }
    const reached = downstreamPlanOrWork(store, below, item.id);
    if (reached) { out.push({ out: [objectRef(store, reached)], kind: 'Not planned', targetId: item.id }); continue; }
    out.push({ lit: {
      kind: 'Not planned', targetId: item.id, basis: 'Inferred', since: itemOccurred(a, item),
      why: `${item.category === "Owner's words" ? 'The owner\'s words' : 'The requirement'} “${clip(item.name, 60)}” lead to no plan item and no work item, and nothing defers or abandons ${item.category === "Owner's words" ? 'them' : 'it'}`,
      evidence: [objectRef(store, item.id), ...item.sourceIds.slice(0, 1).map((s) => ({ kind: 'source' as const, id: s, label: store.sources.get(s)?.title ?? s, line: null, occurred: null })), objectRef(store, rule.id)],
    } });
  }
  return out;
}

function ruleCoversItem(rule: ProjectRule, item: ReferenceItem): boolean {
  if (rule.appliesTo.length === 0) return true;
  const text = `${item.name} ${item.ids.join(' ')} ${item.category}`.toLowerCase();
  return rule.appliesTo.some((e) => e.trim() && (item.id === e || text.includes(e.trim().toLowerCase())));
}

/** What lies directly downstream of each object: what refines it, serves it, implements or carries it out. */
function downstreamIndex(store: ProjectStore): Map<string, string[]> {
  const below = new Map<string, string[]>();
  const add = (up: string, down: string) => below.set(up, [...(below.get(up) ?? []), down]);
  for (const r of store.reference.all()) for (const up of r.refines) add(up, r.id);
  for (const t of store.threads.all()) for (const s of t.serves) add(s.referenceId, t.id);
  for (const rel of store.relations.all()) if (['serves', 'implements', 'refines', 'carries out', 'verifies'].includes(rel.type)) add(rel.to, rel.from);
  return below;
}

/** The first plan item or piece of work reached going downstream. */
function downstreamPlanOrWork(store: ProjectStore, below: ReadonlyMap<string, readonly string[]>, fromId: string): string | null {
  const seen = new Set<string>([fromId]);
  const queue = [fromId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const n of below.get(id) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      const t = store.threads.get(n);
      if (t && t.validity !== 'Abandoned' && t.validity !== 'Removed') return n;
      const r = store.reference.get(n);
      if (r?.category === 'Plan' && r.validity !== 'Abandoned') return n;
      queue.push(n);
    }
  }
  return null;
}

/** `Not started`: planned work whose batch has started while it has no dispatch, branch or commit of its own. */
function notStarted(a: Analysis, work: readonly WorkThread[], processes: ReadonlyMap<string, WorkProcess>): Finding[] {
  const { store, facts, index } = a;
  const out: Finding[] = [];
  const live = new Set(work.map((t) => t.id));
  for (const plan of store.reference.filter((r) => r.category === 'Plan')) {
    const runs = workOfPlan(store, plan.id).filter((t) => live.has(t.id)).map((t) => {
      const p = processes.get(t.id) ?? a.process(t.id)!;
      const units = p.own.map((n) => index.units.get(n)!).filter(Boolean);
      return { t, p, batch: units.map(batchOf).find((b) => b !== null) ?? null };
    });
    for (const r of runs) {
      if (!r.batch) continue;
      const started = r.p.delivery.dispatched !== null || r.p.delivery.commits.length > 0 || r.p.delivery.branches.length > 0 || r.p.delivery.receipts.length > 0;
      if (started) { out.push({ out: [r.p.delivery.dispatched ? facts.ref(r.p.delivery.dispatched.entry.id) : r.p.delivery.commits[0] ? facts.ref(r.p.delivery.commits[0].id) : objectRef(store, r.t.id)], kind: 'Not started', targetId: r.t.id }); continue; }
      if (r.t.progress === 'Done') continue;
      const mates = runs.filter((m) => m !== r && m.batch?.batch === r.batch!.batch && (m.p.delivery.dispatched || m.p.delivery.commits.length));
      const first = mates.map((m) => m.p.delivery.dispatched ? { ms: m.p.delivery.dispatched.ms, occurred: m.p.delivery.dispatched.occurred, ev: facts.ref(m.p.delivery.dispatched.entry.id), t: m.t } : { ms: m.p.delivery.commits[0]!.ms, occurred: m.p.delivery.commits[0]!.occurred, ev: facts.ref(m.p.delivery.commits[0]!.id), t: m.t }).sort((x, y) => x.ms - y.ms)[0];
      if (!first) continue;
      out.push({ lit: {
        kind: 'Not started', targetId: r.t.id, basis: 'Inferred', since: first.occurred,
        why: `Batch ${r.batch.batch} of ${plan.name} started (${first.t.ids[0] ?? first.t.title}); ${r.t.ids[0] ?? r.t.title} has no dispatch, branch or commit`,
        evidence: [first.ev, objectRef(store, plan.id), ...(r.p.delivery.planned ? [r.p.delivery.planned.evidence] : [])],
      } });
    }
  }
  return out;
}

/** `Not merged`, `No trace of done`, `Not checked`, `No plan`: the breakpoints about one piece of work's own steps. */
function aboutWork(a: Analysis, t: WorkThread, p: WorkProcess): Finding[] {
  const { store, facts, index } = a;
  const out: Finding[] = [];
  const d = p.delivery;
  const units = p.own.map((n) => index.units.get(n)!).filter(Boolean);
  const isCheckOrFix = units.length > 0 && units.every((u) => u.nature !== 'work');
  const done = d.reportedDone ?? (t.progress === 'Done' ? { occurred: undated(t.asOf || t.updatedAt, t.id), ms: 0, evidence: null } : null);

  // Not merged: delivered code that never reached the trunk, and the work says it is done.
  if (d.codeCommits.length && d.unmerged && (done || d.receipts.length) && !d.experiment) {
    const last = d.codeCommits[d.codeCommits.length - 1]!;
    const since = done && done.ms > last.ms ? done.occurred : last.occurred;
    out.push({ lit: {
      kind: 'Not merged', targetId: t.id, basis: 'Explicit', since,
      why: `${t.ids[0] ?? t.title}'s ${d.codeCommits.length} commit${d.codeCommits.length === 1 ? '' : 's'}${d.branches[0] ? ` on ${d.branches[0]}` : ''} never reached the trunk${done ? ', and it says it is done' : ''}`,
      evidence: [facts.ref(last.id), ...(done?.evidence ? [done.evidence] : [])],
    } });
  } else if (d.codeCommits.length) {
    const merged = d.merges[d.merges.length - 1] ?? d.codeCommits.find((c) => c.onTrunk);
    out.push({ out: [merged ? facts.ref(merged.id) : d.experiment ?? objectRef(store, t.id)], kind: 'Not merged', targetId: t.id });
  }

  // No trace of done: it says it is done, and the ledger has no commit or product of its own.
  const tiedByLink = p.linked.some((l) => l.stepKind === 'Delivered' || l.stepKind === 'Fix' || l.stepKind === 'Merged');
  const product = d.codeCommits.length > 0 || d.commits.length > 0 || d.receipts.length > 0 || p.checks.some((c) => c.unit && p.own.includes(c.unit)) || tiedByLink;
  if (done && !product && (units.length > 0 || p.linked.length > 0)) {
    out.push({ lit: {
      kind: 'No trace of done', targetId: t.id, basis: units.length ? 'Explicit' : 'Inferred', since: done.occurred,
      why: `${t.ids[0] ?? t.title} is reported done, and the ledger has no commit, receipt or report of its own`,
      evidence: [...(done.evidence ? [done.evidence] : [objectRef(store, t.id)]), ...(d.missingReceipt ? [objectRef(store, t.id, `named receipt never committed: ${d.missingReceipt}`)] : [])],
    } });
  } else if (product) {
    const ev = d.codeCommits[0] ? facts.ref(d.codeCommits[0].id) : d.receipts[0] ? facts.ref(d.receipts[0].id) : p.linked[0]?.evidence ?? objectRef(store, t.id);
    out.push({ out: [ev], kind: 'No trace of done', targetId: t.id });
  }

  // Not checked: the rules say this work is checked independently, it was delivered, and no independent check exists.
  const checkRule = isCheckOrFix ? null : a.expecting(t, 'Independent check');
  const delivered = d.deliveredAt !== null || done !== null;
  const independent = p.checks.filter((c) => c.by === 'Independent QC').sort((x, y) => y.ms - x.ms)[0] ?? null;
  const linkedCheck = p.linked.find((l) => l.stepKind === 'QC' || l.stepKind === 'Review' || l.stepKind === 'Walkthrough') ?? null;
  if (checkRule && delivered && !independent && !linkedCheck) {
    out.push({ lit: {
      kind: 'Not checked', targetId: t.id, basis: checkRule.basis === 'Explicit' ? 'Explicit' : 'Inferred', since: d.deliveredAt?.occurred ?? done!.occurred,
      why: `The project's rule asks for an independent check of ${t.ids[0] ?? t.title}; it was delivered and nothing checked it${p.latestCheck?.by === 'Self-reported' ? ` (its own report says ${p.latestCheck.verdict}: a self-report is not a check)` : ''}`,
      evidence: [objectRef(store, checkRule.id), ...(d.codeCommits.length ? [facts.ref(d.codeCommits[d.codeCommits.length - 1]!.id)] : done?.evidence ? [done.evidence] : [])],
    } });
  } else {
    out.push({ out: [independent?.verdict ? facts.ref(independent.verdict.id, independent.verdict.text) : linkedCheck?.evidence ?? objectRef(store, checkRule?.id ?? t.id)], kind: 'Not checked', targetId: t.id });
  }

  // No plan: merged work that traces to no plan item, owner's words or decision (only where the rules expect a written plan).
  const planRule = a.expecting(t, 'Written plan');
  if (planRule && p.execution === 'Merged' && !isCheckOrFix) {
    const traced = tracedToIntent(a, t, p);
    if (!traced) {
      const first = d.codeCommits[0] ?? d.commits[0];
      out.push({ lit: {
        kind: 'No plan', targetId: t.id, basis: 'Inferred', since: first?.occurred ?? d.deliveredAt?.occurred ?? undated(t.asOf || t.updatedAt, t.id),
        why: `${t.ids[0] ?? t.title} was merged into the trunk and traces to no plan item, owner's words or decision`,
        evidence: [...(first ? [facts.ref(first.id)] : []), objectRef(store, t.id), objectRef(store, planRule.id)],
      } });
    } else out.push({ out: [traced], kind: 'No plan', targetId: t.id });
  } else out.push({ out: [objectRef(store, planRule?.id ?? t.id)], kind: 'No plan', targetId: t.id });
  return out;
}

/** What a piece of work traces up to: a plan item, owner's words or a decision (the round's relations), or a plan document naming it. */
function tracedToIntent(a: Analysis, t: WorkThread, p: WorkProcess): EvidenceRef | null {
  const { store, facts, index } = a;
  const seen = new Set<string>([t.id]);
  const queue = [...t.serves.map((s) => s.referenceId), ...store.relations.filter((r) => r.from === t.id).map((r) => r.to)];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const r = store.reference.get(id);
    if (!r) continue;
    if (r.category === 'Plan' || r.category === "Owner's words" || r.category === 'Decision' || r.category === 'Requirement') return objectRef(store, r.id);
    queue.push(...r.refines);
  }
  const planPaths = new Set([...store.layers.filter((l) => l.layer === 'Plan' || l.layer === 'Task contract').map((l) => l.path.replace(/\\/g, '/')), ...facts.arrangements.filter((x) => x.kind === 'plan').map((x) => x.path)]);
  for (const n of p.own) {
    const hit = (index.nums.get(n) ?? []).find((r) => r.kind === 'doc' && r.path && [...planPaths].some((pp) => r.path === pp || r.path!.endsWith(pp) || pp.endsWith(r.path!)));
    if (hit) return facts.ref(hit.id, hit.context);
  }
  return null;
}

/** `Findings open`: a check's findings that nothing fixed, sent back or disposed of afterwards. */
function findingsOpen(a: Analysis, work: readonly WorkThread[], processes: ReadonlyMap<string, WorkProcess>): Finding[] {
  const { facts } = a;
  const byTarget = new Map<string, { open: Map<string, WorkProcess['findings'][number]>; handled: Map<string, WorkProcess['findings'][number]>; root: WorkThread }>();
  for (const t of work) {
    for (const f of processes.get(t.id)!.findings) {
      const target = checkTarget(a, f.check.unit, t);
      const e = byTarget.get(target) ?? { open: new Map(), handled: new Map(), root: t };
      (f.handled ? e.handled : e.open).set(f.finding.id, f);
      byTarget.set(target, e);
    }
  }
  const out: Finding[] = [];
  for (const [target, e] of byTarget) {
    const open = [...e.open.values()].filter((f) => !e.handled.has(f.finding.id));
    if (open.length === 0) { out.push({ out: dedupe([...e.handled.values()].map((f) => f.handled!.evidence)).slice(0, 8), kind: 'Findings open', targetId: target }); continue; }
    const checks = [...new Set(open.map((f) => f.check.unit))];
    const first = open.sort((x, y) => x.finding.ms - y.finding.ms)[0]!;
    out.push({ lit: {
      kind: 'Findings open', targetId: target, basis: 'Explicit', since: first.finding.occurred,
      why: `${open.length} finding${open.length === 1 ? '' : 's'} of ${checks.join(', ')} (${open.map((f) => f.num).join(', ')}) ${open.length === 1 ? 'has' : 'have'} no fix, send-back or disposition afterwards`,
      evidence: dedupe([...open.map((f) => f.check.verdict).filter((v): v is NonNullable<typeof v> => v !== null).map((v) => facts.ref(v.id, v.text)), ...open.map((f) => facts.ref(f.finding.id, f.finding.text))]),
    } });
  }
  return out;
}

/** `Passed with open items`: a passing report that leaves items for later which nothing followed up. */
function passedWithOpenItems(a: Analysis, work: readonly WorkThread[], processes: ReadonlyMap<string, WorkProcess>): Finding[] {
  const { facts } = a;
  const byTarget = new Map<string, { open: WorkProcess['openItems'][number][]; handled: WorkProcess['openItems'][number][] }>();
  for (const t of work) {
    for (const i of processes.get(t.id)!.openItems) {
      const target = checkTarget(a, i.check.unit, t);
      const e = byTarget.get(target) ?? { open: [], handled: [] };
      if (i.handled) e.handled.push(i);
      else if (!e.open.some((x) => x.check.reportPath === i.check.reportPath && x.item.line === i.item.line)) e.open.push(i);
      byTarget.set(target, e);
    }
  }
  const out: Finding[] = [];
  for (const [target, e] of byTarget) {
    if (e.open.length === 0) { out.push({ out: dedupe(e.handled.map((i) => i.handled!.evidence)).slice(0, 8), kind: 'Passed with open items', targetId: target }); continue; }
    const c = e.open[0]!.check;
    const text = c.report ? facts.textOf(c.report.id) : null;
    const deferLine = text ? text.split(/\r?\n/).find((l) => /不单开|不另开|照实记下|之后再|以后再|留给|留到|defer|later|follow[- ]?up/i.test(l) && !/^\s*#/.test(l)) : undefined;
    const itemRef = (i: WorkProcess['openItems'][number]): EvidenceRef => ({ kind: 'file', id: i.check.reportPath, label: `${i.check.reportPath}:${i.item.line}`, line: i.item.text, occurred: i.check.report?.occurred ?? i.check.occurred });
    out.push({ lit: {
      kind: 'Passed with open items', targetId: target, basis: c.fromCandidates ? 'Inferred' : 'Explicit', since: c.firstReport?.occurred ?? c.occurred,
      why: `${c.unit}'s report says ${c.verdictWord ?? 'pass'} and leaves ${e.open.length} item${e.open.length === 1 ? '' : 's'} for later that nothing followed up`,
      evidence: dedupe([...(c.verdict ? [facts.ref(c.verdict.id, c.verdict.text)] : []), ...e.open.map(itemRef), ...(deferLine ? [{ kind: 'file' as const, id: c.reportPath, label: c.reportPath, line: deferLine.trim(), occurred: c.report?.occurred ?? null }] : [])]),
    } });
  }
  return out;
}

/** `Fix not re-checked`: where the rules ask a fix after a failure to be checked again, and no check came after it. */
function fixNotRechecked(a: Analysis, work: readonly WorkThread[], processes: ReadonlyMap<string, WorkProcess>): Finding[] {
  const { store, facts, index } = a;
  const out: Finding[] = [];
  for (const t of work) {
    const p = processes.get(t.id)!;
    if (p.fixes.length === 0) continue;
    const rule = a.expecting(t, 'Re-check after fix');
    for (const fix of p.fixes.filter((f) => f.delivered)) {
      const target = index.threadOf.get(fix.unit) && store.threads.get(index.threadOf.get(fix.unit)!)?.validity === 'Current' ? index.threadOf.get(fix.unit)! : t.id;
      // A failure that sent the work back: a check's failing verdict (not one still in progress) or the host's review.
      const failure = [...p.checks.filter(startsSendBack).map((c) => ({ ms: c.ms, ev: facts.ref(c.verdict!.id, c.verdict!.text) })), ...p.reviews.map((r) => ({ ms: r.ms, ev: facts.ref(r.entry.id, `status: ${r.status}`) }))]
        .filter((x) => x.ms <= (fix.dispatched?.ms ?? fix.ms)).sort((x, y) => y.ms - x.ms)[0];
      const recheck = p.checks.filter((c) => c.by === 'Independent QC' && c.ms > fix.ms).sort((x, y) => x.ms - y.ms)[0];
      if (!rule || !failure) { out.push({ out: [objectRef(store, rule?.id ?? t.id)], kind: 'Fix not re-checked', targetId: target }); continue; }
      if (recheck) { out.push({ out: [facts.ref(recheck.verdict?.id ?? recheck.report!.id, recheck.verdict?.text ?? null)], kind: 'Fix not re-checked', targetId: target }); continue; }
      out.push({ lit: {
        kind: 'Fix not re-checked', targetId: target, basis: rule.basis === 'Explicit' ? 'Explicit' : 'Inferred', since: fix.occurred,
        why: `${fix.unit} fixed ${fix.targets.join(', ') || (t.ids[0] ?? t.title)} after a failure, and no check came after the fix`,
        evidence: [failure.ev, ...fix.evidence.slice(0, 2), objectRef(store, rule.id)],
      } });
    }
  }
  return out;
}

/**
 * `Downstream behind` (the program's half, Inferred): a semantic patch withdrew something and an object it affects has
 * not changed since; a line of the ledger says a numbered entry was superseded and a current object still cites it.
 */
function downstreamBehind(a: Analysis): Finding[] {
  const { store, facts } = a;
  const out: Finding[] = [];
  const current = (id: string) => (store.reference.get(id)?.validity ?? store.threads.get(id)?.validity) === 'Current';
  // 1. Semantic patches: the objects they name as affected, whose document has no version since.
  for (const patch of store.patches.filter((x) => x.status !== 'Rejected')) {
    const at = msOfOccurred(patch.occurred);
    for (const id of patch.affects) {
      if (!current(id)) continue;
      const paths = objectPaths(a, id);
      if (paths.length === 0) continue;
      const newer = paths.flatMap((pp) => facts.docsByPath.get(pp) ?? []).filter((d) => d.ms > at).sort((x, y) => x.ms - y.ms)[0];
      if (newer) { out.push({ out: [facts.ref(newer.id)], kind: 'Downstream behind', targetId: id }); continue; }
      out.push({ lit: {
        kind: 'Downstream behind', targetId: id, basis: 'Inferred', since: patch.occurred,
        why: `${patch.number} withdrew “${clip(patch.invalidated, 70)}”; ${objectRef(store, id).label} is affected and its document has not changed since`,
        evidence: [patch.candidate, ...(patch.decision ? [patch.decision] : []), objectRef(store, id)],
      } });
    }
  }
  // 2. The ledger's explicit supersessions of a numbered entry, and current lines that still cite the number.
  // CM (E151): a dated record is a note of its time, not a supersession or a citation in force — a decision log's
  // entries (a decision's 影响 or 改到的文档 note), reports and receipts, what the layer map marks not current. On the gated
  // run all 38 Downstream-behind candidates came from such notes, and none lit. A decision log supersedes in the entry of
  // the decision that does it (「D53 取代 D40」 under D53) or of the one it supersedes, never in another entry's background
  // or in its discussion.
  const dated = datedRecords(a);
  const reps = new Map<string, { at: number; ev: EvidenceRef; num: string; familyBasis: NonNullable<Breakpoint['familyBasis']> }>();
  for (const s of facts.supersessions) {
    if ((s.source !== 'content' && s.source !== 'loose') || !s.path || s.line === null || !s.current) continue;
    const at = dated.rel(s.path);
    if (dated.isDated(at)) continue;
    if (dated.isLog(at)) {
      const entry = dated.entryAt(at, s.line);
      const replacers: string[] = (s.replacement ?? '').toUpperCase().match(/[A-Z]{1,6}-?[A-Z]?\d{1,4}/g) ?? [];
      // The entry of the decision that supersedes, or of the one superseded (「D1 …（superseded by D2）」 under D1).
      if (!entry || ![...replacers, ...replacedNumbers(s.replaced).map((n) => n.toUpperCase())].includes(entry.toUpperCase())) continue;
    }
    for (const num of replacedNumbers(s.replaced)) {
      if (!reps.has(num)) reps.set(num, { at: s.ms, ev: facts.ref(s.id, s.text), num,
        familyBasis: { lineId: s.id, syntax: s.syntax ?? s.pattern, replaced: s.replaced! } });
    }
  }
  if (reps.size) {
    const rows = facts.numsOf(reps.keys());
    const objectsByPath = pathObjects(a);
    for (const [num, r] of reps) {
      for (const m of rows.get(num) ?? []) {
        if (m.kind !== 'doc' || !m.current || !m.path || m.line === null || m.place === 'definition') continue;
        if (dated.isLog(m.path) || dated.isDated(m.path)) continue;
        if (/supersed|replac|取代|作废|废弃|撤回|obsolete|deprecated|不再|历史|history|→|->/i.test(m.context)) continue;
        if (!standsAlone(m.context, num)) continue;
        for (const o of objectsByPath.get(m.path) ?? []) {
          if (m.line < o.lineStart || m.line > o.lineEnd || !current(o.id)) continue;
          out.push({ lit: {
            kind: 'Downstream behind', targetId: o.id, basis: 'Inferred', since: m.occurred,
            why: `${num} is written as superseded; ${objectRef(store, o.id).label} still cites it`,
            evidence: [r.ev, facts.ref(m.id, m.context), objectRef(store, o.id)],
            familyBasis: r.familyBasis,
          } });
        }
      }
    }
  }
  return out;
}

/**
 * Where the project keeps dated records (CM, E151): its decision logs (the layer map's `Decision record`, or by name when
 * the layer map does not say), its reports and receipts (`QC and receipts`, the ledger's receipts), and what the layer map
 * marks not current (archives); and, in a decision log, the entry a line stands in (the last number defined at or above it).
 */
function datedRecords(a: Analysis): { rel: (path: string) => string; isLog: (path: string) => boolean; isDated: (path: string) => boolean; entryAt: (path: string, line: number) => string | null } {
  const { store, facts } = a;
  const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const layers = store.layers.all().map((l) => ({ path: slash(l.path), layer: l.layer, current: l.current }));
  const layerOf = (path: string) => layers.filter((l) => path === l.path || path.startsWith(`${l.path}/`)).sort((x, y) => y.path.length - x.path.length)[0] ?? null;
  const rel = (path: string) => (/^[A-Za-z]:|^[\\/]/.test(path) ? facts.relPathOf(path)?.path ?? slash(path) : slash(path));
  const isLog = (path: string) => { const l = layerOf(path); return l ? l.layer === 'Decision record' : /(^|\/)(DECISIONS?|ADR|decision[-_ ]?log)[^/]*\.md$/i.test(path); };
  const isDated = (path: string) => { const l = layerOf(path); return Boolean(l && (l.layer === 'QC and receipts' || !l.current)) || (facts.arrangementsByPath.get(path) ?? []).some((x) => x.kind === 'receipt'); };
  const defs = new Map<string, { num: string; line: number }[]>();
  const entryAt = (path: string, line: number): string | null => {
    let list = defs.get(path);
    if (!list) {
      try {
        list = (facts.ledger.db.prepare("SELECT num, line FROM nums WHERE path = ? AND place = 'definition' AND kind = 'doc' AND current = 1 AND line IS NOT NULL ORDER BY line").all(path) as { num: string; line: number }[]);
      } catch { list = []; }
      defs.set(path, list);
    }
    let found: string | null = null;
    for (const d of list) { if (d.line > line) break; found = d.num; }
    return found;
  };
  return { rel, isLog, isDated, entryAt };
}

/** Repository-relative paths an object's sources are in. */
function objectPaths(a: Analysis, id: string): string[] {
  const { store, facts } = a;
  const ref = store.reference.get(id);
  const thread = ref ? undefined : store.threads.get(id);
  const sourceIds = ref?.sourceIds ?? thread?.factRecordIds.flatMap((f) => store.facts.get(f)?.aboutSourceIds ?? []) ?? [];
  const out = new Set<string>();
  for (const sid of sourceIds) {
    const an = store.sources.get(sid)?.anchor;
    if (an?.kind !== 'file') continue;
    const at = facts.relPathOf(an.path);
    if (at) out.add(at.path);
  }
  return [...out];
}

/** The current objects each document's sections are the source of, with their line ranges. */
function pathObjects(a: Analysis): Map<string, { id: string; lineStart: number; lineEnd: number }[]> {
  const { store, facts } = a;
  const out = new Map<string, { id: string; lineStart: number; lineEnd: number }[]>();
  const add = (id: string, ids: readonly string[], sids: readonly string[]) => {
    for (const sid of sids) {
      const an = store.sources.get(sid)?.anchor;
      if (an?.kind !== 'file') continue;
      const at = facts.relPathOf(an.path);
      if (at) for (const range of itemRanges(facts.ledger.db, at.repo, at.path, ids, { from: an.lineStart, to: an.lineEnd }))
        out.set(at.path, [...(out.get(at.path) ?? []), { id, lineStart: range.from, lineEnd: range.to }]);
    }
  };
  for (const r of store.reference.all()) if (r.validity === 'Current' && r.category !== "Owner's words") add(r.id, r.ids, r.sourceIds);
  return out;
}

/** `Not carried out` (the program's half, Inferred): a decision asking for something by a date or after a precondition, now due, with no later trace. */
function notCarriedOut(a: Analysis): Finding[] {
  const { store, facts, index } = a;
  const out: Finding[] = [];
  const latest = facts.latestMs;
  for (const d of store.reference.filter((r) => r.category === 'Decision')) {
    if (d.validity !== 'Current' || d.carryOut?.status === 'Carried out') {
      out.push({ out: [objectRef(store, d.id, d.carryOut?.status === 'Carried out' ? `Carried out${d.carryOut.remaining ? `; left: ${d.carryOut.remaining}` : ''}` : null)], kind: 'Not carried out', targetId: d.id });
      continue;
    }
    const text = `${d.quote ?? ''}\n${d.text}\n${d.name}`;
    if (!/要|必须|应该|应当|需要|将|删|改|做|完成|落实|上线|迁移|随|before|by |must|should|will|to be|deadline|截止|之前|以前|前/i.test(text)) continue;
    let due: { at: string; ms: number; how: string; ev: EvidenceRef | null } | null = null;
    // A date the decision names that has passed (by the latest commit the ledger holds).
    for (const line of text.split(/\r?\n/)) {
      for (const x of datesOnLine(line, null)) {
        const ms = msOf(x.at) ?? 0;
        if (ms && ms < latest && (!due || ms < due.ms)) due = { at: x.at, ms, how: `the date it names (${x.at}) has passed`, ev: null };
      }
    }
    // A precondition naming a unit of work that has since merged (`AK 合入后`, `after AK`, `随 AK`).
    for (const m of text.matchAll(/(?:after|once|when|随|等|在)\s*([A-Z]{1,6}-?\d*)\s*(?:合入|完成|之后|以后|后|merged|lands|is done)?|([A-Z]{1,6}-?\d*)\s*(?:合入|完成)(?:之后|以后|后)/g)) {
      const n = m[1] ?? m[2];
      if (!n) continue;
      const u = index.units.get(n);
      const merge = u?.merges[0];
      if (merge && merge.ms < latest && (!due || merge.ms < due.ms)) due = { at: merge.occurred.at, ms: merge.ms, how: `its precondition happened (${n} merged ${merge.short})`, ev: facts.ref(merge.id) };
    }
    if (!due) continue;
    // A later trace: work carrying it out, or a commit or document naming the decision's own number after it was due.
    const trace = laterTrace(a, d, due.ms);
    if (trace) { out.push({ out: [trace], kind: 'Not carried out', targetId: d.id }); continue; }
    out.push({ lit: {
      kind: 'Not carried out', targetId: d.id, basis: 'Inferred', since: due.ev?.occurred ?? { at: due.at, basis: 'Written in text', anchor: d.id },
      why: `The decision “${clip(d.name, 60)}” is due — ${due.how} — and nothing later carries it out`,
      evidence: [objectRef(store, d.id), ...(due.ev ? [due.ev] : [])],
    } });
  }
  return out;
}

/** A later trace of a decision: work that carries it out and is done, or a commit or document naming its number after it was due. */
function laterTrace(a: Analysis, d: ReferenceItem, dueMs: number): EvidenceRef | null {
  const { store, facts } = a;
  const carrier = store.relations.filter((r) => r.to === d.id && r.type === 'carries out').map((r) => store.threads.get(r.from)).find((t) => t?.progress === 'Done');
  if (carrier) return objectRef(store, carrier.id, `carries out ${d.name}; progress Done`);
  if (d.carryOut?.workIds.some((w) => store.threads.get(w)?.progress === 'Done')) return objectRef(store, d.carryOut.workIds.find((w) => store.threads.get(w)?.progress === 'Done')!);
  const rows = facts.numsOf(d.ids);
  for (const n of d.ids) {
    const later = (rows.get(n) ?? []).filter((r) => r.ms > dueMs && r.place !== 'definition').sort((x, y) => x.ms - y.ms)[0];
    if (later) return facts.ref(later.id, later.context);
  }
  return null;
}

// ───────────────────────── reconciling with what the workbench already holds ─────────────────────────

export interface ReconcileResult {
  /** Lit after this computation: only those the independent check lit before and that still hold (D99). */
  readonly lit: number;
  readonly litByKind: Readonly<Partial<Record<BreakpointKind, number>>>;
  /** Always 0 since D99: the program never lights; the spot-check does (pk_confirm). Kept for the step's note. */
  readonly newlyLit: number;
  /** Candidates after this computation: leads for the lanes to read, not findings (Spec §2.12, D99). */
  readonly candidates: number;
  readonly candidatesByKind: Readonly<Partial<Record<BreakpointKind, number>>>;
  readonly putOut: number;
  readonly keptOut: number;
  readonly written: number;
}

/** A breakpoint waiting to be read and checked: computed, neither lit nor out (D99). */
export const isCandidate = (b: Breakpoint): boolean => !b.lit && !b.out && !b.ownerResponse;

const evidenceKey = (x: { readonly evidence: readonly EvidenceRef[] }): string => x.evidence.map((e) => `${e.id}\x1f${e.line ?? ''}`).join('\x1e');

/**
 * Write the findings on the workbench (Spec §2.12, D99: 没有痕迹，要读过才算). What the program computes is a candidate,
 * a lead for the lanes to read; the program never lights one. A candidate keeps where a lane looked (`looked`) and the
 * independent check (`checked`) while it holds on the same evidence; one the spot-check lit (pk_confirm) stays lit while
 * it still holds, so a Follow up keeps it. What no longer holds goes out with its evidence, candidate or lit. The owner's
 * `No action needed` is kept (never lit again), and so is a model's refutation (`out.by: 'model'`, pk_confirm
 * `confirmed: false`: not a candidate again on the same evidence). Records are written only when something changed.
 */
export function reconcile(store: ProjectStore, projectId: string, findings: readonly Finding[], roundId: string | null, jobId: string | null): ReconcileResult {
  const now = new Date().toISOString();
  const trace = (summary: string) => ({ jobId, summary });
  const seen = new Set<string>();
  let putOut = 0; let keptOut = 0; let written = 0;
  const litByKind: Partial<Record<BreakpointKind, number>> = {};
  const candidatesByKind: Partial<Record<BreakpointKind, number>> = {};
  const put = (b: Breakpoint, summary: string) => { store.breakpoints.put(b, trace(summary)); written += 1; };
  const basisKey = (b: NonNullable<Breakpoint['familyBasis']>) => `${b.lineId}\x1f${b.syntax}\x1f${b.replaced}`;
  type Refutation = NonNullable<Breakpoint['familyRefutations']>[number];
  const refutedFamilies = new Map<string, Refutation>();
  for (const b of store.breakpoints.filter((x) => x.projectId === projectId)) {
    for (const r of b.familyRefutations ?? []) refutedFamilies.set(basisKey(r.basis), r);
    if (b.out?.by !== 'model') continue;
    const decision = b.out.decision ?? { breakpointId: b.id, at: b.out.at, roundId: null };
    if (b.familyBasis && !refutedFamilies.has(basisKey(b.familyBasis)))
      refutedFamilies.set(basisKey(b.familyBasis), { basis: b.familyBasis, decision, evidence: b.out.evidence });
    else if (!b.familyBasis) {
      // A judgement recorded before this field existed can still be carried to siblings on the same ledger line.
      const lineId = b.evidence.find((e) => e.id.startsWith('sup:'))?.id;
      for (const f of findings) if ('lit' in f && f.lit.familyBasis && f.lit.familyBasis.lineId === lineId)
        refutedFamilies.set(basisKey(f.lit.familyBasis), { basis: f.lit.familyBasis, decision, evidence: b.out.evidence });
    }
  }
  // One object has one breakpoint id. If several lines support it, an unrefuted line keeps it lit regardless of order.
  const byId = new Map<string, Finding[]>();
  for (const f of findings) {
    const c = 'lit' in f ? f.lit : f;
    const id = breakpointId(projectId, c.kind, c.targetId);
    byId.set(id, [...(byId.get(id) ?? []), f]);
  }
  const selected: Finding[] = [...byId.values()].map((group): Finding => {
    const candidates = group.filter((f): f is { readonly lit: Candidate } => 'lit' in f);
    return candidates.find((f) => !f.lit.familyBasis || !refutedFamilies.has(basisKey(f.lit.familyBasis))) ?? candidates[0] ?? group[0]!;
  });
  for (const f of selected) {
    if ('lit' in f) {
      const c = f.lit;
      const id = breakpointId(projectId, c.kind, c.targetId);
      seen.add(id);
      const existing = store.breakpoints.get(id);
      if (existing?.ownerResponse) {
        // The owner said no action is needed: it stays unlit; the answer stays.
        if (existing.lit || !existing.out) put({ ...existing, lit: false, out: existing.out ?? { at: existing.ownerResponse.at, by: 'owner', evidence: [] }, updatedAt: now }, `Breakpoint ${c.kind} on ${c.targetId}: stays out, the owner answered No action needed`);
        keptOut += 1;
        continue;
      }
      const precedent = c.familyBasis ? refutedFamilies.get(basisKey(c.familyBasis)) : undefined;
      if (precedent) {
        const decision = precedent.decision;
        const familyRefutations = [...(existing?.familyRefutations ?? []).filter((r) => basisKey(r.basis) !== basisKey(precedent.basis)), precedent];
        const next: Breakpoint = {
          id, projectId, kind: c.kind, targetId: c.targetId, why: c.why, evidence: c.evidence, basis: c.basis, since: c.since,
          lit: false, out: { at: decision.at, by: 'model', evidence: precedent.evidence, decision }, ownerResponse: null,
          confirmedInRoundId: null, sixThing: existing?.sixThing ?? SIX_OF[c.kind], sendBackId: existing?.sendBackId ?? null,
          roundId: existing?.roundId ?? roundId, updatedAt: existing?.updatedAt ?? now, familyBasis: c.familyBasis, familyRefutations,
        };
        if (existing && !existing.out) putOut += 1;
        keptOut += 1;
        if (!existing || changed(existing, next) || existing.out?.decision?.breakpointId !== decision.breakpointId)
          put({ ...next, updatedAt: now }, `Breakpoint ${c.kind} on ${c.targetId} stays out by ${decision.breakpointId} at ${decision.at}`);
        continue;
      }
      if (!c.familyBasis && existing && !existing.lit && existing.out?.by === 'model') {
        // A model step refuted it: light it again only on a fact it has not seen — neither what lit it nor what refuted it.
        const seenIds = new Set([...existing.evidence, ...existing.out.evidence].map((e) => e.id));
        if (c.evidence.every((e) => seenIds.has(e.id))) { keptOut += 1; continue; }
      }
      // D99: the program computes a candidate and never lights it. One the independent check lit (it has `checked`) and
      // that still holds stays lit; one lit before D99 without a check goes back to being a candidate.
      const staysLit = existing?.lit === true && !existing.out && !!existing.checked;
      const same = !!existing && evidenceKey(existing) === evidenceKey(c);
      const next: Breakpoint = {
        id, projectId, kind: c.kind, targetId: c.targetId, why: c.why, evidence: c.evidence, basis: c.basis, since: c.since, lit: staysLit, out: null, ownerResponse: null,
        looked: staysLit || same ? existing?.looked ?? null : null,
        checked: staysLit || same ? existing?.checked ?? null : null,
        confirmedInRoundId: staysLit ? existing!.confirmedInRoundId : null, sixThing: existing?.sixThing ?? SIX_OF[c.kind], sendBackId: existing?.sendBackId ?? null,
        roundId: existing && !existing.out ? existing.roundId : roundId, updatedAt: existing?.updatedAt ?? now, familyBasis: c.familyBasis,
        familyRefutations: existing?.familyRefutations,
      };
      if (staysLit) litByKind[c.kind] = (litByKind[c.kind] ?? 0) + 1;
      else candidatesByKind[c.kind] = (candidatesByKind[c.kind] ?? 0) + 1;
      if (!existing || changed(existing, next)) put({ ...next, updatedAt: now }, `Breakpoint ${c.kind} on ${c.targetId} ${staysLit ? 'stays lit' : 'is a candidate'} (program): ${clip(c.why, 120)}`);
    } else {
      const id = breakpointId(projectId, f.kind, f.targetId);
      seen.add(id);
      const existing = store.breakpoints.get(id);
      // Lit or still a candidate: evidence that the step did happen puts it out. What is out keeps its treatment.
      if (!existing || existing.out) continue;
      put({ ...existing, lit: false, out: { at: now, by: existing.ownerResponse ? 'owner' : 'evidence', evidence: f.out }, updatedAt: now }, `Breakpoint ${f.kind} on ${f.targetId} out (program): ${f.out.map((e) => e.label).join('; ').slice(0, 160)}`);
      putOut += 1;
    }
  }
  // Lit breakpoints and candidates nothing computed any more (the object went, was struck, or fell into an earlier generation).
  for (const b of store.breakpoints.filter((x) => x.projectId === projectId && !x.out && !seen.has(x.id))) {
    const t = store.threads.get(b.targetId);
    const r = t ? undefined : store.reference.get(b.targetId);
    const gen = earlierGenerationOf(store, b.targetId);
    const o = t ?? r;
    const ev: EvidenceRef = gen ? gen.endedBy
      : o && o.validity !== 'Current' ? objectRef(store, b.targetId, `validity ${o.validity}${o.replacedBy ? `, replaced by ${o.replacedBy}` : ''}`)
      : o ? objectRef(store, b.targetId, `the ledger no longer shows what lit ${b.kind} here (its material changed or went)`)
      : { kind: 'object', id: b.targetId, label: `${b.targetId} is no longer on the workbench`, line: null, occurred: null };
    put({ ...b, lit: false, out: { at: now, by: 'evidence', evidence: [ev] }, updatedAt: now }, `Breakpoint ${b.kind} on ${b.targetId} out (program): ${ev.label}`);
    putOut += 1;
  }
  const count = (by: Partial<Record<BreakpointKind, number>>) => Object.values(by).reduce((n, x) => n + (x ?? 0), 0);
  return { lit: count(litByKind), litByKind, newlyLit: 0, candidates: count(candidatesByKind), candidatesByKind, putOut, keptOut, written };
}

function changed(a: Breakpoint, b: Breakpoint): boolean {
  return a.lit !== b.lit || a.why !== b.why || a.basis !== b.basis || a.since.at !== b.since.at || evidenceKey(a) !== evidenceKey(b) ||
    JSON.stringify(a.looked ?? null) !== JSON.stringify(b.looked ?? null) || JSON.stringify(a.checked ?? null) !== JSON.stringify(b.checked ?? null) ||
    a.confirmedInRoundId !== b.confirmedInRoundId ||
    a.out?.by !== b.out?.by || a.out?.at !== b.out?.at || a.sixThing !== b.sixThing ||
    (a.familyBasis ? basisKeyChanged(a.familyBasis) : '') !== (b.familyBasis ? basisKeyChanged(b.familyBasis) : '') ||
    JSON.stringify(a.familyRefutations ?? []) !== JSON.stringify(b.familyRefutations ?? []);
}

const basisKeyChanged = (b: NonNullable<Breakpoint['familyBasis']>): string => `${b.lineId}\x1f${b.syntax}\x1f${b.replaced}`;
