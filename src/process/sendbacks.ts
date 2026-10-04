/**
 * Send-backs (Spec v3.0 §1.18 送回): a relation, not a ticket. `Suggested → Returned → Closed`, recognised from the
 * ledger at each round; nobody changes a state by hand, and the owner's `No action needed` stays.
 *
 * - **Where they come from.** A check that failed (QC, review or walkthrough judged `fail`, `needs repair` …; a check
 *   still in progress, `incomplete（审核进行中）`, has judged nothing and starts none) and a
 *   host's review that sent a delivery back (`status: needs-repair`) are send-backs to Work the project itself wrote
 *   (§1.18 "QC 与走查的判定"); the program records each once, keyed by the ledger entry it started from. The round's
 *   synthesis suggests the others — from breakpoints, the six things, code anomalies (clerk-tools `pk_suggest_sendback`).
 * - **`Returned`**: a later task, commit or document version picks it up — a fix whose task names the work or the check
 *   (by number), a commit or document that cites the send-back's own id (the `Copy for agent` text carries it), a later
 *   version of the document a send-back to Plan hangs on, or a confirmed link (then `Inferred`).
 * - **`Closed`**: later evidence shows it fixed — a check after the fix that passed; the fix merged (for a host's review,
 *   or where the project does not ask for a re-check); the breakpoint it came from put out by evidence; the note or mark
 *   it came from resolved — always with that evidence.
 */
import { linkHolds } from '../model/k-types.ts';
import type { Basis } from '../model/vocab.ts';
import type { EvidenceRef, Occurred, SendBack } from '../model/k-types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import type { Analysis } from './analysis.ts';
import { msOfOccurred } from './facts.ts';
import { FIX_WORDS } from './units.ts';
import { clip, standsAlone } from './text.ts';
import { earlierWork } from '../keeper/organize/carried-on.ts';
import { ownFindings, sendBackIdFor, startsSendBack, type CheckRecord, type FixRecord, type ReviewRecord, type WorkProcess } from './work.ts';

export interface SendBackResult {
  readonly created: number;
  readonly returned: number;
  readonly closed: number;
  readonly open: number;
  readonly written: number;
}

interface Origin {
  readonly id: string;
  readonly kind: 'check' | 'review';
  readonly targetId: string;
  readonly occurred: Occurred;
  readonly ms: number;
  readonly what: string;
  readonly suggestion: string;
  readonly evidence: readonly EvidenceRef[];
  readonly process: WorkProcess;
  readonly check: CheckRecord | null;
  readonly review: ReviewRecord | null;
}

type Stage = { readonly stage: SendBack['stage']; readonly returned: SendBack['returned']; readonly closed: SendBack['closed'] };

const RANK: Record<SendBack['stage'], number> = { Suggested: 0, Returned: 1, Closed: 2 };

/** The failed checks and the host's send-back reviews of every current piece of work, once each (a chain is seen from several works). */
function originsOf(a: Analysis): Origin[] {
  const { store, facts, index } = a;
  const gen = earlierWork(store);   // CZ: an item carried on under the same number is current work
  const out = new Map<string, Origin>();
  for (const t of store.threads.filter((x) => x.validity === 'Current' && !gen.has(x.id))) {
    const p = a.process(t.id)!;
    for (const c of p.checks) {
      // A check unit's failing verdict; a "fail" in a delivery's own receipt is its account, not a check (CKC-27 AC-11), and
      // a check still in progress (`incomplete（审核进行中）`) has judged nothing yet.
      if (!startsSendBack(c) || !c.verdict || out.has(c.verdict.id)) continue;
      const checked = index.units.get(c.unit)?.relations.map((r) => r.num) ?? [];
      const targetNum = checked.find((n) => index.threadOf.has(n)) ?? null;
      const targetId = targetNum ? index.threadOf.get(targetNum)! : t.id;
      const findings = ownFindings(c);
      out.set(c.verdict.id, {
        id: c.verdict.id, kind: 'check', targetId, occurred: c.occurred, ms: c.ms, process: targetId === t.id ? p : a.process(targetId) ?? p, check: c, review: null,
        what: `${c.unit}'s ${c.by === 'Independent QC' ? 'independent ' : ''}${c.kind === 'QC' ? 'QC' : c.kind.toLowerCase()} judged ${checked.filter((n) => index.units.has(n)).join(', ') || (t.ids[0] ?? t.title)} ${c.verdictWord ?? c.normalized}${findings.length ? `: ${findings.length} finding${findings.length === 1 ? '' : 's'}, ${clip(findings[0]!.text.replace(/^#+\s*/, ''), 80)}` : ''}`,
        suggestion: `Fix what ${c.unit} found${findings.length ? ` (${findings.map((f) => f.verdict).join(', ')})` : ''} in new or reopened work, then have it checked again`,
        evidence: [facts.ref(c.verdict.id, c.verdict.text), ...findings.slice(0, 8).map((f) => facts.ref(f.id, f.text))],
      });
    }
    for (const r of p.reviews) {
      if (out.has(r.entry.id)) continue;
      const targetId = index.threadOf.get(r.unit) ?? t.id;
      out.set(r.entry.id, {
        id: r.entry.id, kind: 'review', targetId, occurred: r.occurred, ms: r.ms, process: targetId === t.id ? p : a.process(targetId) ?? p, check: null, review: r,
        what: `${r.who ?? 'The host'} reviewed ${r.unit}'s delivery: ${r.status}`,
        suggestion: `Repair ${r.unit}'s delivery in new or reopened work`,
        evidence: [facts.ref(r.entry.id, `status: ${r.status}`), ...r.receipts.map((x) => facts.ref(x.id))],
      });
    }
  }
  return [...out.values()];
}

/** The stage of a send-back that a failed check or a host's review started, from its work's process. */
function stageOfOrigin(a: Analysis, o: Origin): Stage {
  const p = o.process;
  // The fix that caught it: the first fix whose task was written at or after the failure and that fixes the checked
  // unit or the check itself.
  const failedUnit = o.check ? o.check.unit : o.review!.unit;
  const checked = o.check ? a.index.units.get(o.check.unit)?.relations.map((r) => r.num) ?? [] : [o.review!.unit];
  const fix: FixRecord | undefined = p.fixes
    .filter((f) => (f.taskWritten?.ms ?? f.dispatched?.ms ?? f.ms) >= o.ms && f.targets.some((n) => n === failedUnit || checked.includes(n)))
    .sort((x, y) => (x.taskWritten?.ms ?? x.ms) - (y.taskWritten?.ms ?? y.ms))[0];
  if (!fix) return { stage: 'Suggested', returned: null, closed: null };
  const by = fix.taskWritten?.evidence ?? fix.dispatched?.evidence ?? fix.evidence[0]!;
  const returned = { by, at: by.occurred?.at ?? new Date().toISOString(), basis: 'Explicit' as Basis };
  // Fixed: the earliest of a check after the fix that passed, and the fix landing on the trunk — the latter counts
  // for a host's review, and for a failed check only where the project does not ask for a re-check after a fix.
  const recheck = p.checks.filter((c) => c.ms > fix.ms && c.normalized === 'pass' && c.verdict).sort((x, y) => x.ms - y.ms)[0];
  const needsRecheck = o.kind === 'check' && a.expecting(p.thread, 'Re-check after fix') !== null;
  const closings = [
    ...(recheck ? [{ ms: recheck.ms, by: a.facts.ref(recheck.verdict!.id, recheck.verdict!.text), at: recheck.occurred.at }] : []),
    ...(!needsRecheck && fix.landed ? [{ ms: fix.landed.ms, by: fix.landed.evidence, at: fix.landed.occurred.at }] : []),
  ].sort((x, y) => x.ms - y.ms);
  const c = closings[0];
  return c ? { stage: 'Closed', returned, closed: { by: c.by, at: c.at } } : { stage: 'Returned', returned, closed: null };
}

/** The numbers of a send-back's target (the work item, or what the reference item or territory names). */
function targetNumbers(store: ProjectStore, sb: SendBack): string[] {
  return store.threads.get(sb.targetId)?.ids.slice() ?? store.reference.get(sb.targetId)?.ids.slice() ?? [];
}

/** The stage a suggested send-back has reached by what came later (§1.18), whoever suggested it. */
function stageOfSuggested(a: Analysis, sb: SendBack): Stage {
  const { store, facts, index } = a;
  const since = msOfOccurred(sb.occurred);
  let returned: SendBack['returned'] = sb.returned;
  const candidates: { ms: number; by: EvidenceRef; basis: Basis }[] = [];
  // 1. A later commit or document that cites the send-back's own id (the text `Copy for agent` hands over carries it).
  const cited = facts.ledger.word(sb.id, { limit: 20, oldestFirst: true });
  if (typeof cited !== 'string') for (const h of cited.rows) if (h.kind === 'doc' || h.kind === 'commit' || h.kind === 'loose') candidates.push({ ms: msOfOccurred(h.occurred), by: facts.ref(h.id, h.snippet), basis: 'Explicit' });
  const nums = targetNumbers(store, sb);
  if (sb.to === 'Work') {
    // 2. A later fix task that names the work, or a later commit that says it fixes it.
    for (const u of index.units.values()) {
      if (u.nature !== 'fix' || !u.relations.some((r) => nums.includes(r.num))) continue;
      const task = u.prompts[0];
      if (task && task.ms > since) candidates.push({ ms: task.ms, by: facts.ref(task.id, task.data.title ?? null), basis: 'Explicit' });
    }
    for (const c of facts.commits.values()) {
      if (c.ms <= since || c.merge || !FIX_WORDS.test(c.subject) || !nums.some((n) => standsAlone(c.subject, n))) continue;
      candidates.push({ ms: c.ms, by: facts.ref(c.id), basis: 'Explicit' });
    }
  } else {
    // 2'. A later version of the document the send-back to Plan hangs on.
    for (const path of documentPaths(a, sb.targetId)) {
      const v = (facts.docsByPath.get(path) ?? []).find((d) => d.ms > since);
      if (v) candidates.push({ ms: v.ms, by: facts.ref(v.id), basis: 'Explicit' });
    }
  }
  // 3. A confirmed link on the target, later than the problem.
  for (const l of store.links.filter((x) => x.workId === sb.targetId && linkHolds(x) && (x.stepKind === 'Fix' || x.stepKind === 'Delivered' || x.stepKind === 'Dispatched'))) {
    const ms = msOfOccurred(l.evidence?.occurred);
    if (ms > since) candidates.push({ ms, by: l.evidence ?? facts.ref(l.ledgerRef), basis: 'Inferred' });
  }
  const first = candidates.filter((c) => c.ms > 0).sort((x, y) => x.ms - y.ms)[0];
  if (!returned && first) returned = { by: first.by, at: first.by.occurred?.at ?? new Date(first.ms).toISOString(), basis: first.basis };
  // Closed: the breakpoint it came from went out on evidence; the note or mark it came from was resolved; for Work, a
  // passing check or a merge of the work after it was returned.
  let closed: SendBack['closed'] = null;
  if (sb.from.kind === 'breakpoint') {
    // Put out by evidence of the step — not by this send-back itself, which only says the problem went back.
    const bp = store.breakpoints.get(sb.from.id);
    const ev = bp && !bp.lit && bp.out?.by === 'evidence' ? bp.out.evidence.find((e) => e.id !== sb.id && !(e.kind === 'object' && store.sendbacks.has(e.id))) : undefined;
    if (ev) closed = { by: ev, at: bp!.out!.at };
  } else if (sb.from.kind === 'owner-judgement') {
    const mark = store.marks.get(sb.from.id);
    const note = store.notes.get(sb.from.id);
    if (mark?.closed) closed = { by: { kind: 'object', id: mark.id, label: `${mark.kind} closed: ${mark.closed.result}`, line: mark.closed.reason, occurred: null }, at: mark.closed.at };
    else if (note?.status === 'Resolved') closed = { by: { kind: 'object', id: note.id, label: `Note resolved: ${note.versions[note.versions.length - 1]?.title ?? note.id}`, line: note.resolvedReason, occurred: null }, at: note.updatedAt };
  }
  if (!closed && returned && sb.to === 'Work') {
    const thread = store.threads.get(sb.targetId);
    const p = thread ? a.process(thread.id) : null;
    const after = msOfOccurred(returned.by.occurred) || Date.parse(returned.at) || since;
    const pass = p?.checks.filter((c) => c.ms > after && c.normalized === 'pass').sort((x, y) => x.ms - y.ms)[0];
    const merge = p ? [...p.delivery.merges, ...p.fixes.flatMap((f) => f.merges)].filter((m) => m.ms > after).sort((x, y) => x.ms - y.ms)[0] : undefined;
    if (pass?.verdict) closed = { by: facts.ref(pass.verdict.id, pass.verdict.text), at: pass.occurred.at };
    else if (merge && !(thread && a.expecting(thread, 'Re-check after fix'))) closed = { by: facts.ref(merge.id), at: merge.occurred.at };
  }
  if (closed && !returned) returned = { by: closed.by, at: closed.at, basis: 'Explicit' };
  return { stage: closed ? 'Closed' : returned ? 'Returned' : 'Suggested', returned, closed };
}

function documentPaths(a: Analysis, id: string): string[] {
  const { store, facts } = a;
  const ref = store.reference.get(id);
  const out = new Set<string>();
  for (const sid of ref?.sourceIds ?? []) {
    const an = store.sources.get(sid)?.anchor;
    if (an?.kind !== 'file') continue;
    for (const path of facts.docsByPath.keys()) if (an.path.replace(/\\/g, '/').endsWith(`/${path}`)) out.add(path);
  }
  return [...out];
}

/**
 * Record the send-backs the project's own failed checks and reviews started, and move every send-back on by what the
 * ledger shows (never back, never by hand). Returns what moved.
 */
export function advance(a: Analysis, roundId: string | null, jobId: string | null): SendBackResult {
  const { store, project } = a;
  const now = new Date().toISOString();
  const trace = (summary: string, sourceIds: readonly string[] = []) => ({ jobId, summary, basisSourceIds: sourceIds });
  let created = 0; let returned = 0; let closed = 0; let written = 0;
  const handled = new Set<string>();
  for (const o of originsOf(a)) {
    const existing = store.sendbacks.get(sendBackIdFor(project.id, o.id)) ?? store.sendbacks.find((s) => s.from.id === o.id);
    const st = stageOfOrigin(a, o);
    if (existing) {
      handled.add(existing.id);
      const next = moveOn(existing, st, now);
      if (next) { store.sendbacks.put(next, trace(`Send-back ${existing.id}: ${existing.stage} → ${next.stage} (program)`)); written += 1; if (next.stage !== existing.stage) (next.stage === 'Closed' ? closed++ : returned++); }
      continue;
    }
    const record: SendBack = {
      id: sendBackIdFor(project.id, o.id), projectId: project.id, to: 'Work', stage: st.stage, targetId: o.targetId, what: o.what, suggestion: o.suggestion,
      evidence: o.evidence, from: { kind: 'verdict', id: o.id }, returned: st.returned, closed: st.closed, ownerResponse: null, sixThing: null,
      occurred: o.occurred, roundId, updatedAt: now,
    };
    store.sendbacks.put(record, trace(`Send-back to Work (program, from ${o.kind === 'check' ? 'a failed check' : "the host's review"}): ${clip(o.what, 120)} — ${st.stage}`));
    handled.add(record.id);
    created += 1; written += 1;
    if (st.stage === 'Returned') returned += 1;
    if (st.stage === 'Closed') closed += 1;
  }
  for (const sb of store.sendbacks.filter((s) => s.projectId === project.id && !handled.has(s.id) && s.stage !== 'Closed')) {
    const next = moveOn(sb, stageOfSuggested(a, sb), now);
    if (!next) continue;
    store.sendbacks.put(next, trace(`Send-back ${sb.id}: ${sb.stage} → ${next.stage} (program): ${next.stage === 'Closed' ? next.closed!.by.label : next.returned!.by.label}`));
    written += 1;
    if (next.stage !== sb.stage) (next.stage === 'Closed' ? closed++ : returned++);
  }
  const open = store.sendbacks.filter((s) => s.projectId === project.id && s.stage !== 'Closed' && !s.ownerResponse).length;
  return { created, returned, closed, open, written };
}

/** The send-back moved on to a computed stage, never back; null when nothing changes. The owner's answer stays. */
function moveOn(sb: SendBack, st: Stage, now: string): SendBack | null {
  if (RANK[st.stage] < RANK[sb.stage]) return null;
  const returned = sb.returned ?? st.returned;
  const closed = sb.closed ?? st.closed;
  const stage = closed ? 'Closed' : returned ? 'Returned' : 'Suggested';
  if (stage === sb.stage && returned === sb.returned && closed === sb.closed) return null;
  return { ...sb, stage, returned, closed, updatedAt: now };
}

