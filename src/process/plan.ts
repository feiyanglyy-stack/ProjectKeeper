/**
 * A plan's execution shape (Spec v3.0 §6.3 执行形状, D72; CKC-24 AC-2): its batches as the plan wrote them, the order they
 * actually ran in — by when their work was dispatched and delivered — which ran in parallel, the merge commit of each,
 * and where the actual order differs from the planned one, in one sentence. As the orchestrator wrote it and as git shows
 * it; ProjectKeeper schedules nothing.
 *
 * The plan's own batches are read from its section: numbered items (`1. **地基**：…`), or lines and headings naming a batch
 * (`批次 3`, `Batch 3`), with the parallel it states (`和 3、4 并行`, `in parallel with 3`). Which batch a piece of work is
 * comes from its own arrangement (`批次 5b`, `batch 6 of 7`; placement.ts).
 */
import type { Occurred } from '../model/k-types.ts';
import type { PlanShapeView } from '../model/views-k.ts';
import type { WorkThread } from '../model/types.ts';
import { splitMarkdown } from '../sources/files.ts';
import type { Analysis } from './analysis.ts';
import { batchOf, planDocument, workOfPlan } from './placement.ts';
import type { Unit } from './units.ts';
import type { WorkProcess } from './work.ts';

export interface PlannedBatch {
  readonly label: string;
  readonly name: string;
  readonly text: string;
  /** Other batches the plan says this one runs in parallel with. */
  readonly parallelWith: readonly string[];
}

/** The batches a plan section names, in its order. */
export function plannedBatches(text: string): PlannedBatch[] {
  const out: PlannedBatch[] = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const item = /^\s{0,3}(\d{1,2})[.)、]\s+(.+)$/.exec(raw);
    const named = /^\s{0,3}(?:#{1,6}\s+|[-*+]\s+)?(?:\*\*)?(?:批次|第)\s*(\d{1,2})\s*批?\s*[:：·—-]?\s*(.*)$/.exec(raw) ?? /^\s{0,3}(?:#{1,6}\s+|[-*+]\s+)?(?:\*\*)?batch\s*(\d{1,2})\b\s*[:：·—-]?\s*(.*)$/i.exec(raw);
    const m = item ?? named;
    if (!m) continue;
    const label = m[1]!;
    if (out.some((b) => b.label === label)) continue;
    const body = m[2]!.trim();
    const bold = /\*\*([^*]+)\*\*/.exec(body)?.[1];
    const name = (bold ?? body).replace(/[：:（(。].*$/, '').replace(/[*_`]/g, '').trim() || body.slice(0, 30);
    const hint = /(?:和|与|跟|同)\s*((?:\d{1,2}\s*[、,，和与及]\s*)*\d{1,2})\s*(?:同时|一起)?\s*并行|(?:in )?parallel with\s+(?:batch(?:es)?\s*)?((?:\d{1,2}\s*(?:,|and|&)\s*)*\d{1,2})/i.exec(body);
    const parallelWith = hint ? [...(hint[1] ?? hint[2] ?? '').matchAll(/\d{1,2}/g)].map((x) => x[0]) : [];
    out.push({ label, name, text: body, parallelWith });
  }
  return out;
}

/** The text of a document's section (the heading path) in a version's text; the whole text when no section is given. */
export function sectionText(text: string, headingPath: readonly string[]): string {
  if (headingPath.length === 0) return text;
  const want = headingPath.join(' › ');
  const sections = splitMarkdown(text);
  const own = sections.filter((s) => s.headingPath.join(' › ') === want || s.headingPath.join(' › ').startsWith(`${want} › `));
  return own.length ? own.map((s) => s.text).join('\n') : text;
}

interface WorkRun {
  readonly thread: WorkThread;
  readonly process: WorkProcess;
  readonly units: readonly Unit[];
  readonly batch: string | null;
  readonly part: string | null;
  readonly start: { readonly ms: number; readonly occurred: Occurred } | null;
  readonly end: number | null;
}

/** One time a plan's batch ran: all of it, or — when its work ran at different times — one part of it. */
interface ActualBatch {
  readonly label: string;
  readonly runs: readonly WorkRun[];
  /** Work of the batch not started yet (shown with its first part). */
  readonly waiting: readonly WorkRun[];
  readonly start: number;
  readonly end: number;
  readonly startOccurred: Occurred | null;
  /** Which part of the batch this is (1-based), and of how many. */
  readonly part: number;
  readonly parts: number;
}

const joinList = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const byLabelOrder = (x: string, y: string): number => x.localeCompare(y, 'en', { numeric: true });

export function planShapeOf(a: Analysis, planId: string): PlanShapeView | null {
  const { store, facts, index } = a;
  const plan = store.reference.get(planId);
  if (!plan || plan.category !== 'Plan') return null;
  const doc = planDocument(store, facts, plan);
  const version = doc?.current ?? doc?.first ?? null;
  const text = version ? facts.textOf(version.id) : null;
  const planned = text ? plannedBatches(sectionText(text, doc?.headingPath ?? [])) : [];
  // The work of the plan, each with its batch and when it ran (dispatch or first commit, to its last merge, fix or check).
  const runs: WorkRun[] = workOfPlan(store, planId).map((thread) => {
    const process = a.process(thread.id)!;
    const units = process.own.map((n) => index.units.get(n)!).filter(Boolean);
    const b = units.map(batchOf).find((x) => x !== null) ?? null;
    const d = process.delivery;
    const start = d.dispatched ? { ms: d.dispatched.ms, occurred: d.dispatched.occurred } : d.codeCommits[0] ? { ms: d.codeCommits[0].ms, occurred: d.codeCommits[0].occurred } : null;
    const endCandidates = [...d.merges.map((m) => m.ms), d.deliveredAt?.ms ?? 0, ...process.checks.map((c) => c.ms), ...process.fixes.flatMap((f) => [f.ms, ...f.merges.map((m) => m.ms)])].filter((x) => x > 0);
    const end = endCandidates.length ? Math.max(...endCandidates) : null;
    return { thread, process, units, batch: b?.batch ?? null, part: b?.part ?? null, start, end };
  });
  // Batches as they ran: by the plan's batch number (work with no batch of its own is a batch of its own); a batch whose
  // work ran at different times is split into the parts that ran together.
  const byLabel = new Map<string, WorkRun[]>();
  for (const r of runs) {
    const label = r.batch ?? r.thread.ids[0] ?? r.thread.id;
    byLabel.set(label, [...(byLabel.get(label) ?? []), r]);
  }
  const actual: ActualBatch[] = [];
  for (const [label, rs] of byLabel) {
    const ran = rs.filter((r) => r.start).sort((x, y) => x.start!.ms - y.start!.ms);
    const waiting = rs.filter((r) => !r.start);
    const clusters: WorkRun[][] = [];
    let until = -Infinity;
    for (const r of ran) {
      const e = r.end ?? r.start!.ms;
      const c = clusters[clusters.length - 1];
      if (c && r.start!.ms < until) { c.push(r); until = Math.max(until, e); }
      else { clusters.push([r]); until = e; }
    }
    if (clusters.length === 0) { actual.push({ label, runs: [], waiting, start: Number.MAX_SAFE_INTEGER, end: 0, startOccurred: null, part: 1, parts: 1 }); continue; }
    clusters.forEach((c, i) => actual.push({
      label, runs: c, waiting: i === 0 ? waiting : [], start: c[0]!.start!.ms, end: Math.max(...c.map((r) => r.end ?? r.start!.ms)),
      startOccurred: c[0]!.start!.occurred, part: i + 1, parts: clusters.length,
    }));
  }
  const started = actual.filter((b) => b.runs.length).sort((x, y) => x.start - y.start || byLabelOrder(x.label, y.label));
  const notStarted = actual.filter((b) => b.runs.length === 0).sort((x, y) => byLabelOrder(x.label, y.label));
  // Batches that ran at the same time: one that starts before the ones before it ended joins them.
  const groups: ActualBatch[][] = [];
  for (const b of started) {
    const g = groups[groups.length - 1];
    if (g && b.start < Math.max(...g.map((x) => x.end))) g.push(b);
    else groups.push([b]);
  }
  const nameOfRun = (b: ActualBatch, r: WorkRun) => (r.part ? `${b.label}${r.part}` : r.thread.ids[0] ?? r.thread.id);
  const partsOf = (b: ActualBatch): string => {
    const names = b.runs.map((r) => nameOfRun(b, r));
    const pieces = b.parts > 1 || b.runs.length > 1 ? [names.join(runsOverlap(b.runs) ? ' ∥ ' : ' → ')] : [];
    const waiting = b.waiting.map((r) => `${nameOfRun(b, r)} not started`);
    return pieces.length || waiting.length ? ` (${[...pieces, ...waiting].join('; ')})` : '';
  };
  const actualOrder = groups.length
    ? [...groups.map((g) => (g.length > 1 ? `(${g.map((b) => `${b.label}${partsOf(b)}`).join(' ∥ ')})` : `${g[0]!.label}${partsOf(g[0]!)}`)), ...notStarted.map((b) => `${b.label} (not started)`)].join(' → ')
    : null;
  // The planned order, with the parallel the plan states.
  const plannedGroups: string[][] = [];
  for (const p of planned) {
    if (plannedGroups.some((g) => g.includes(p.label))) continue;
    const mates = new Set([p.label, ...p.parallelWith.filter((x) => planned.some((q) => q.label === x))]);
    for (const q of planned) if (q.parallelWith.includes(p.label)) mates.add(q.label);
    plannedGroups.push([...mates].sort(byLabelOrder));
  }
  const plannedOrder = plannedGroups.length ? plannedGroups.map((g) => (g.length > 1 ? `(${g.join(' ∥ ')})` : g[0]!)).join(' → ') : null;
  const differs = differences(plannedGroups, groups, actual, planned, nameOfRun);
  const nameOf = (label: string) => planned.find((p) => p.label === label)?.name ?? null;
  const batches: PlanShapeView['batches'] = [...groups.flat(), ...notStarted].map((b) => {
    const group = groups.find((g) => g.includes(b));
    const members = [...b.runs, ...b.waiting];
    // The merge commits that brought the batch in; work committed straight to the trunk has none, and its last commit stands in.
    const merged = [...new Map(b.runs.flatMap((r) => [...r.process.delivery.merges, ...r.process.fixes.flatMap((f) => f.merges)]).map((m) => [m.hash, m])).values()];
    const direct = b.runs.flatMap((r) => (r.process.delivery.merges.length ? [] : r.process.delivery.codeCommits.filter((c) => c.fpTrunk).slice(-1)));
    const merges = [...merged, ...direct].sort((x, y) => x.ms - y.ms);
    const agents = [...new Set(members.flatMap((r) => r.units.map((u) => u.executor).filter((x): x is string => Boolean(x))))];
    const worktrees = [...new Set(b.runs.flatMap((r) => r.units.map((u) => (u.fields.worktree ?? u.branches[0] ?? '').split(/[\\/ ]/).filter(Boolean).pop() ?? '').filter(Boolean)))];
    const name = nameOf(b.label);
    return {
      label: `Batch ${b.label}${name ? ` · ${name}` : ''}${b.parts > 1 ? ` (part ${b.part} of ${b.parts})` : ''}`,
      workIds: members.map((r) => r.thread.id),
      parallel: (group?.length ?? 1) > 1 || (b.runs.length > 1 && runsOverlap(b.runs)),
      running: b.runs.some((r) => r.process.execution === 'In progress' && r.process.delivery.dispatched !== null),
      agent: agents.length ? agents.join(', ') : null,
      worktree: worktrees.length ? worktrees.join(', ') : null,
      mergeCommit: merges.length ? merges.map((m) => m.short).join(', ') : null,
      occurred: b.startOccurred,
    };
  });
  return { planId, actualOrder, plannedOrder, differs, batches, dependsOn: dependenciesOf(a, runs) };
}

function runsOverlap(runs: readonly WorkRun[]): boolean {
  const spans = runs.filter((r) => r.start).map((r) => ({ s: r.start!.ms, e: r.end ?? r.start!.ms })).sort((x, y) => x.s - y.s);
  for (let i = 1; i < spans.length; i++) if (spans[i]!.s < Math.max(...spans.slice(0, i).map((x) => x.e))) return true;
  return false;
}

/** Where the actual order differs from the plan, in one sentence; null when it does not (or the plan names no batches). */
function differences(
  plannedGroups: readonly string[][], groups: readonly ActualBatch[][], actual: readonly ActualBatch[], planned: readonly PlannedBatch[],
  nameOfRun: (b: ActualBatch, r: WorkRun) => string,
): string | null {
  if (plannedGroups.length === 0 || groups.length === 0) return null;
  const rank = new Map<string, number>();
  plannedGroups.forEach((g, i) => { for (const l of g) rank.set(l, i); });
  const sequence = groups.flat().filter((b) => rank.has(b.label));
  const said = (b: ActualBatch) => (b.parts > 1 ? `${b.runs.map((r) => nameOfRun(b, r)).join(', ')} of batch ${b.label}` : `batch ${b.label}`);
  // The batches that keep the planned order are the longest run of non-decreasing planned ranks; the others moved.
  const n = sequence.length;
  const len = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) if (rank.get(sequence[j]!.label)! <= rank.get(sequence[i]!.label)! && len[j]! + 1 > len[i]!) { len[i] = len[j]! + 1; prev[i] = j; }
  let best = 0;
  for (let i = 1; i < n; i++) if (len[i]! > len[best]!) best = i;
  const kept = new Set<number>();
  for (let i = n ? best : -1; i >= 0; i = prev[i]!) kept.add(i);
  const parts: string[] = [];
  const unique = (xs: string[]) => [...new Set(xs)];
  sequence.forEach((b, i) => {
    if (kept.has(i)) return;
    const r = rank.get(b.label)!;
    // Said against the batches that kept their order.
    const jumped = unique(sequence.flatMap((x, j) => (j > i && kept.has(j) && rank.get(x.label)! < r ? [x.label] : [])));
    const after = unique(sequence.flatMap((x, j) => (j < i && kept.has(j) && rank.get(x.label)! > r ? [x.label] : [])));
    if (jumped.length) parts.push(`${said(b)} ran before batch${jumped.length > 1 ? 'es' : ''} ${joinList(jumped)}`);
    else if (after.length) parts.push(`${said(b)} ran after batch${after.length > 1 ? 'es' : ''} ${joinList(after)}`);
  });
  // A batch the plan wrote as one, run as several pieces of work together, or in parts at different times.
  for (const b of actual) {
    if (b.runs.length < 2 || !rank.has(b.label)) continue;
    const pieces = b.runs.map((r) => nameOfRun(b, r));
    parts.push(`batch ${b.label} ran as ${b.runs.length === 2 ? 'two halves' : `${b.runs.length} parts`} ${runsOverlap(b.runs) ? 'in parallel' : 'one after the other'} (${pieces.join(', ')})`);
  }
  for (const label of unique(actual.filter((b) => b.parts > 1 && b.part === 1).map((b) => b.label))) {
    const pieces = actual.filter((b) => b.label === label).sort((x, y) => x.part - y.part).map((b) => b.runs.map((r) => nameOfRun(b, r)).join(', '));
    parts.push(`batch ${label} ran in ${pieces.length} parts at different times (${pieces.join('; then ')})`);
  }
  // Parallel the plan stated and the run did not keep, or the other way round.
  const groupOf = (label: string) => groups.findIndex((g) => g.some((b) => b.label === label && b.part === 1));
  for (const g of plannedGroups) {
    if (g.length < 2) continue;
    const ran = g.map(groupOf).filter((i) => i >= 0);
    if (ran.length === g.length && new Set(ran).size > 1) parts.push(`batches ${joinList(g)}, planned in parallel, ran one after another`);
  }
  for (const grp of groups) {
    const labels = unique(grp.map((b) => b.label).filter((l) => rank.has(l)));
    if (labels.length < 2) continue;
    if (new Set(labels.map((l) => rank.get(l))).size > 1) parts.push(`batches ${joinList(labels)} ran in parallel, planned one after another`);
  }
  const missing = planned.filter((p) => !actual.some((b) => b.label === p.label)).map((p) => p.label);
  if (missing.length) parts.push(`no work item is recorded for batch${missing.length > 1 ? 'es' : ''} ${joinList(missing)}`);
  return parts.length ? `Execution differs from the plan: ${parts.join('; ')}.` : null;
}

/** Dependencies between the plan's work: the round's `dependsOn`, and the arrangement's own fields (`upstream`, `blocks`). */
function dependenciesOf(a: Analysis, runs: readonly WorkRun[]): PlanShapeView['dependsOn'] {
  const { index } = a;
  const byNum = new Map<string, string>();
  for (const t of a.store.threads.all()) for (const n of t.ids) if (!byNum.has(n)) byNum.set(n, t.id);
  for (const r of runs) for (const n of r.thread.ids) byNum.set(n, r.thread.id);
  const byBatch = new Map<string, string[]>();
  for (const r of runs) if (r.batch) byBatch.set(r.batch, [...(byBatch.get(r.batch) ?? []), r.thread.id]);
  const edges = new Map<string, { from: string; to: string }>();
  const add = (from: string | undefined, to: string | undefined) => { if (from && to && from !== to) edges.set(`${from}\x1f${to}`, { from, to }); };
  const unitNames = [...index.units.keys()];
  const named = (v: string) => unitNames.filter((n) => new RegExp(`(?<![A-Za-z0-9_])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_]|-\\d)`).test(v));
  for (const r of runs) {
    for (const d of r.thread.dependsOn) if (runs.some((x) => x.thread.id === d.threadId)) add(r.thread.id, d.threadId);
    for (const u of r.units) {
      for (const [k, v] of Object.entries(u.fields)) {
        if (/^(upstream|depends_on|depends|after|blocked_by|requires|prerequisites?)$/i.test(k)) for (const n of named(v)) add(r.thread.id, byNum.get(n));
        if (/^blocks$/i.test(k)) {
          for (const n of named(v)) add(byNum.get(n), r.thread.id);
          // `batches 2 (B runner), 3 (A assembly), 4 (memory rooms)`: every batch number after the word.
          const after = /(?:batch(?:es)?|批次)([\s\S]*)$/i.exec(v)?.[1] ?? '';
          for (const b of after.replace(/\([^)]*\)|（[^）]*）/g, ' ').match(/(?<![\d.])\d{1,2}(?![\d.])/g) ?? []) for (const t of byBatch.get(b) ?? []) add(t, r.thread.id);
        }
      }
    }
  }
  return [...edges.values()];
}

