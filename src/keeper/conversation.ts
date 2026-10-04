/**
 * Keeper conversation (Spec §6.8, CKC-10): sessions continue across turns in one pi session;
 * each owner message is a source (the owner's statement); a message sent while the Keeper is
 * answering is delivered as a mid-course adjustment; a conversation on a note joins its discussion.
 */
import type { KeeperJob, Note, Project, Source } from '../model/types.ts';
import { newId } from '../model/ids.ts';
import { makeSessionSource } from '../sources/anchor.ts';
import type { ProjectStore } from '../store/project-store.ts';
import type { App } from '../server/app.ts';
import { HttpError } from '../server/http.ts';
import type { ChatTelemetry, KeeperEvent } from './runtime.ts';
import { turnPrompt } from './jobs/answering.ts';
import { cameFromView, mountView, nodeDetail, relationDetail } from '../server/graph-view.ts';
import { ruleOrPlanSummary } from '../server/workbench-content.ts';
import { DEPTH_NOTE_ID } from './organize/takeover.ts';
import { optionsLines } from './owner-text.ts';

export interface ChatContext { readonly kind: string; readonly id: string; readonly label: string }
interface TurnExtra { readonly conversationId: string; readonly question: string; readonly context: ChatContext | null; readonly ownerSourceId: string; readonly followUps?: readonly { text: string; at: string; sourceId: string }[]; readonly leafId?: string | null; readonly turn: number; readonly asker?: 'owner' | 'agent' }

const extraOf = (job: KeeperJob): TurnExtra | null => { const x = (job.task as { extra?: TurnExtra } | null)?.extra; return x && typeof x.conversationId === 'string' ? x : null; };
const cut = (s: string | null | undefined, n: number) => (s ?? '').length > n ? `${(s ?? '').slice(0, n)}…` : (s ?? '');

/**
 * The note whole, for the prompt when the owner discusses or confirms it (owner 2026-09-22): the panel's brief stays
 * short, but the Keeper answers from everything the note carries — body, mount, origin, the judgement record behind
 * this version, the rules a rules note lists, and the discussion so far.
 */
function noteBrief(store: ProjectStore, note: Note): string {
  const v = note.versions[note.versions.length - 1]!;
  const lines: string[] = [];
  lines.push(`Note ${note.id} — "${v.title}"`);
  lines.push(`Ask: ${v.ask} · status: ${note.status} · owner response: ${note.ownerResponse ?? 'none yet'} · version ${v.version} at ${v.at}`);
  lines.push(`Preview: ${v.preview}`);
  if (v.body.currentView) lines.push(`Current view: ${v.body.currentView}`);
  if (v.body.whyItMatters) lines.push(`Why it matters: ${v.body.whyItMatters}`);
  if (v.body.options?.length) lines.push('Options:', ...optionsLines(v.body.options));
  for (const f of v.body.facts) lines.push(`Fact${f.inferred ? ' (inferred)' : ''}: ${f.text} [sources: ${f.sourceIds.join(', ') || 'none'}]`);
  if (v.body.otherExplanations) lines.push(`Other explanations: ${v.body.otherExplanations}`);
  if (v.body.keepAdjust) lines.push(`Keep or adjust: ${v.body.keepAdjust}`);
  if (v.body.whatWouldSettleIt) lines.push(`What would settle it: ${v.body.whatWouldSettleIt}`);
  const mount = mountView(store, note.mount);
  lines.push(mount.objects.length === 0 ? `Mounted on: the whole project (${mount.kind}).` : `Mounted on (${mount.kind}): ${mount.objects.map((o) => `${o.label} (${o.id})`).join('; ')}`);
  const came = cameFromView(store, note);
  if (came) lines.push(`Came from: ${came.kind ?? 'unknown origin'} · job: ${came.jobKind ?? 'unknown kind'}${note.cameFrom?.jobId ? ` (${note.cameFrom.jobId})` : ''}${came.changes.length ? ` · about the changes: ${came.changes.map((c) => `${c.title} (${c.id})`).join('; ')}` : ''}`);
  const j = store.judgements.get(v.judgementRecordId);
  if (j) {
    lines.push(`Based on judgement record ${j.id}: scope ${j.scope.kind} "${j.scope.label}"${j.scope.ids.length ? ` — ${j.scope.ids.join(', ')}` : ''}`);
    const inputs: string[] = [];
    if (j.inputs.referenceIds.length) inputs.push(`reference: ${j.inputs.referenceIds.join(', ')}`);
    if (j.inputs.threadIds.length) inputs.push(`work: ${j.inputs.threadIds.join(', ')}`);
    if (j.inputs.areaIds.length) inputs.push(`areas: ${j.inputs.areaIds.join(', ')}`);
    if (j.inputs.relationIds.length) inputs.push(`relations: ${j.inputs.relationIds.join(', ')}`);
    if (j.inputs.keyEvidenceSourceIds.length) inputs.push(`key evidence: ${j.inputs.keyEvidenceSourceIds.join(', ')}`);
    if (j.inputs.conflictingSourceIds.length) inputs.push(`conflicting: ${j.inputs.conflictingSourceIds.join(', ')}`);
    for (const inv of j.inputs.investigations) inputs.push(`investigation ${inv.jobId}: ${inv.conclusion} [sources: ${inv.sourceIds.join(', ') || 'none'}]`);
    if (inputs.length) lines.push(`Judgement inputs — ${inputs.join('; ')}`);
    if (j.scope.kind === 'rules') {
      for (const ruleId of j.scope.ids) {
        const r = store.rules.get(ruleId);
        lines.push(r
          ? `Rule ${r.id}: ${r.summary} · group: ${r.group}${r.category ? ` · category: ${r.category}` : ''} · basis: ${r.basis} · applies to: ${r.appliesTo.join('; ')} · validity: ${r.validity} · ${r.ownerConfirmation ? `confirmed by the owner in ${r.ownerConfirmation.sourceId}` : 'not confirmed by the owner yet'} · sources: ${r.sourceIds.join(', ')}`
          : `Rule ${ruleId}: no longer in the assets.`);
      }
    }
  }
  if (note.discussion.length) {
    lines.push('Discussion so far:');
    for (const d of note.discussion) lines.push(`- ${d.role} at ${d.at}${d.sourceId ? ` (source ${d.sourceId})` : ''}: ${d.text}`);
  }
  return lines.join('\n');
}

export class ConversationService {
  private readonly app: App;
  constructor(app: App) { this.app = app; }

  start(): void {
    this.app.keeper.on('event', (event: KeeperEvent) => { if (event.kind === 'done') this.afterTurn(event.projectId, event.jobId); });
  }

  private turnJobs(store: ProjectStore, conversationId?: string): KeeperJob[] {
    return store.jobs.filter((j) => { const x = extraOf(j); return x !== null && (!conversationId || x.conversationId === conversationId); }).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  }

  sessions(projectId: string, asker: 'owner' | 'agent' = 'owner') {
    const store = this.app.store(projectId);
    const byId = new Map<string, KeeperJob[]>();
    for (const j of this.turnJobs(store)) { const x = extraOf(j)!; if ((x.asker ?? 'owner') !== asker) continue; if (!byId.has(x.conversationId)) byId.set(x.conversationId, []); byId.get(x.conversationId)!.push(j); }
    return [...byId.entries()].map(([id, jobs]) => ({ id, title: cut(extraOf(jobs[0]!)!.question, 60), startedAt: jobs[0]!.queuedAt, lastAt: jobs[jobs.length - 1]!.endedAt ?? jobs[jobs.length - 1]!.queuedAt, turns: jobs.length, sessionFile: jobs[jobs.length - 1]!.sessionFile, live: this.app.keeper.hasLiveSession(`conversation:${projectId}:${id}`) }))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  turns(projectId: string, conversationId: string) {
    const store = this.app.store(projectId);
    return this.turnJobs(store, conversationId).map((j) => {
      const x = extraOf(j)!;
      return { jobId: j.id, turn: x.turn, at: j.queuedAt, question: x.question, context: x.context, followUps: x.followUps ?? [], answer: j.resultText, status: j.status, kind: j.kind, requestBasis: j.requestBasis, error: j.error, steps: j.steps, savedResults: j.savedResults, usage: j.usage, canBranch: Boolean(x.leafId) && this.app.keeper.branchingSupported, result: (x as { result?: unknown }).result ?? null };
    });
  }

  /** Read-only telemetry for the selected conversation. A new conversation has a model/window but no usage yet. */
  telemetry(projectId: string, conversationId: string | null): ChatTelemetry {
    if (!conversationId) return this.app.keeper.chatTelemetry(null);
    const jobs = this.turnJobs(this.app.store(projectId), conversationId);
    const recorded = [...jobs].reverse().find((job) => job.sessionFile !== null || job.model !== null) ?? jobs[jobs.length - 1];
    return this.app.keeper.chatTelemetry(`conversation:${projectId}:${conversationId}`, recorded ? {
      sessionFile: recorded.sessionFile,
      leafId: extraOf(recorded)?.leafId ?? null,
      model: recorded.model,
    } : null);
  }

  /**
   * What the Keeper wrote earlier about the current object (§6.8: shown before any message, as written earlier, not
   * generated now). `at`: when it was written, where it is one piece of writing with a time — a note's latest version —
   * for the line above it (`Written earlier · <time>`, D105).
   */
  existing(projectId: string, context: ChatContext | null): { text: string; sourceIds: string[]; at?: string } | null {
    const store = this.app.store(projectId);
    const project = this.app.project(projectId);
    if (!context) {
      const note = store.notes.find((n) => n.status === 'Current' && n.mount.kind === 'project');
      if (note) { const v = note.versions[note.versions.length - 1]!; return { text: [v.title, v.preview, v.body.currentView, ...optionsLines(v.body.options)].filter(Boolean).join('\n'), sourceIds: v.body.facts.flatMap((f) => f.sourceIds), at: v.at }; }
      const areas = store.areas.all();
      if (areas.length) return { text: areas.map((a) => `${store.reference.get(a.referenceId)?.name ?? a.referenceId}: ${cut(a.effectNow, 300)}`).join('\n'), sourceIds: [] };
      return null;
    }
    if (context.kind === 'note') {
      const n = store.notes.get(context.id);
      if (!n) return null;
      const v = n.versions[n.versions.length - 1]!;
      return { text: [v.title, v.preview, v.body.currentView, ...optionsLines(v.body.options), v.body.keepAdjust].filter(Boolean).join('\n'), sourceIds: v.body.facts.flatMap((f) => f.sourceIds), at: v.at };
    }
    if (context.kind === 'relation') {
      const r = relationDetail(store, context.id);
      if (!r) return null;
      return { text: `${r.type}: ${r.fromLabel} → ${r.toLabel}\nClaim: ${r.claim}\nEvidence so far: ${r.evidence.factsSoFar || '—'}\nAssessment: ${r.assessment}`, sourceIds: [...r.evidence.sourceIds] };
    }
    // A rule or the organizing plan, opened from Project scope for the owner to confirm or correct (§6.7; CKC-21 AC-11).
    if (context.kind === 'rule' || context.kind === 'plan') return ruleOrPlanSummary(store, context.kind, context.id);
    const d = nodeDetail(store, project, context.id);
    if (!d) return null;
    const lines: string[] = [`${d.node.label} · ${d.node.category} · ${d.node.validity}${d.node.progress ? ` · ${d.node.progress}` : ''}`];
    if ('reference' in d && d.reference) { lines.push(cut(d.reference.text, 500)); if (d.reference.quote) lines.push(`Owner's words: “${cut(d.reference.quote, 300)}”`); }
    if ('area' in d && d.area) lines.push(`Effect now: ${cut(d.area.effectNow, 500)}`, `Gaps: ${cut(d.area.gaps, 300)}`);
    if ('thread' in d && d.thread) lines.push(`Doing: ${cut(d.thread.doing, 400)}`, `Results: ${cut(d.thread.results, 300)}`, `Unresolved: ${cut(d.thread.unresolved, 300)}`);
    if ('change' in d && d.change) lines.push(cut(d.change.summary, 400));
    for (const n of d.notes.slice(0, 3)) lines.push(`Note: ${n.title} — ${cut(n.preview, 200)}`);
    return { text: lines.join('\n'), sourceIds: [...d.node.sourceIds].slice(0, 12) };
  }

  /** Send a message: a new turn, or a mid-course adjustment when this conversation is answering. */
  send(projectId: string, input: { text: string; context: ChatContext | null; conversationId: string | null; asker?: 'owner' | 'agent'; waiting?: readonly string[]; confirm?: boolean }): { conversationId: string; jobId: string; mode: 'turn' | 'steer'; status: string } {
    const store = this.app.store(projectId);
    const project = this.app.project(projectId);
    const asker = input.asker ?? 'owner';
    const conversationId = input.conversationId ?? newId(asker === 'agent' ? 'ask' : 'conv');
    const previous = this.turnJobs(store, conversationId);
    const turn = previous.length + (previous.flatMap((j) => extraOf(j)!.followUps ?? []).length) + 1;
    const source = this.ownerSource(store, project, conversationId, turn, input.text, previous.length ? previous[previous.length - 1]!.sessionFile : null, asker);
    const running = previous.find((j) => j.status === 'Running');
    if (running) {
      const x = extraOf(running)!;
      store.jobs.put({ ...running, task: { ...(running.task as object), extra: { ...x, followUps: [...(x.followUps ?? []), { text: input.text, at: new Date().toISOString(), sourceId: source.id }] } } });
      this.app.keeper.steer(projectId, running.id, `Owner (mid-course, source ${source.id}): ${input.text}`);
      return { conversationId, jobId: running.id, mode: 'steer', status: 'Running' };
    }
    // The whole note goes into the prompt (owner 2026-09-22); the panel's brief from `existing` stays short.
    let contextSummary: string | null = null;
    let brief: string | null = null;
    if (input.context) {
      if (input.context.kind === 'note') {
        const n = store.notes.get(input.context.id);
        brief = n ? noteBrief(store, n) : null;
      } else {
        contextSummary = this.existing(projectId, input.context)?.text ?? null;
      }
    }
    const job = this.app.keeper.enqueue(projectId, {
      kind: 'Answering', initiator: 'owner', priority: asker === 'agent' ? 1 : 0, stream: asker === 'owner',
      scope: { kind: asker === 'agent' ? 'agent-query' : 'conversation', ids: [conversationId], label: cut(input.text, 80) },
      prompt: turnPrompt({ project, text: input.text, ownerSourceId: source.id, context: input.context, contextSummary, noteBrief: brief, first: previous.length === 0, asker, waiting: input.waiting, confirming: input.confirm === true }),
      sessionKey: `conversation:${projectId}:${conversationId}`, ownerSourceId: asker === 'owner' ? source.id : null, conversation: asker === 'owner',
      task: { conversationId, question: input.text, context: input.context, ownerSourceId: source.id, turn, asker } satisfies TurnExtra,
    });
    return { conversationId, jobId: job.id, mode: 'turn', status: job.status };
  }

  /**
   * `Confirm` on a note (owner 2026-09-22): the owner's fixed statement — their agreement with what the note says
   * now — sent with the note as context and answered in the background. It joins the latest session, or opens a new
   * one when that session is answering: a confirm is never a mid-course steer, which would lose the note's context.
   */
  confirm(projectId: string, noteId: string): { conversationId: string; jobId: string; mode: 'turn' | 'steer'; status: string } {
    const store = this.app.store(projectId);
    const note = store.notes.get(noteId);
    if (!note) throw new HttpError(404, 'Unknown note');
    if (note.status !== 'Current') throw new HttpError(409, `Note ${noteId} is ${note.status}: only a Current note can be confirmed.`);
    if (note.ownerResponse === 'Decided') throw new HttpError(409, `Note ${noteId} is already Decided.`);
    // The depth question is answered by the owner picking one of the options it lists, not by a confirm (§3.7).
    if (noteId === DEPTH_NOTE_ID) throw new HttpError(409, 'The takeover-depth note is answered by choosing one of the depths it offers, not by confirming it.');
    const v = note.versions[note.versions.length - 1]!;
    const text = note.language === 'zh' ? `我确认这条 note：「${v.title}」（${note.id}）。` : `I confirm this note: "${v.title}" (${note.id}).`;
    const latest = this.sessions(projectId)[0]?.id ?? null;
    const answering = latest !== null && this.turnJobs(store, latest).some((j) => j.status === 'Running');
    return this.send(projectId, { text, context: { kind: 'note', id: note.id, label: v.title }, conversationId: answering ? null : latest, confirm: true });
  }

  /** Branch the live session back to the end of a turn (pi keeps the tree in the same file). */
  async branch(projectId: string, conversationId: string, jobId: string): Promise<{ ok: boolean; reason: string | null }> {
    const store = this.app.store(projectId);
    const job = store.jobs.get(jobId);
    const leaf = job ? extraOf(job)?.leafId ?? null : null;
    if (!leaf) return { ok: false, reason: 'This turn has no recorded branch point.' };
    return this.app.keeper.branchSession(`conversation:${projectId}:${conversationId}`, leaf);
  }

  private ownerSource(store: ProjectStore, project: Project, conversationId: string, turn: number, text: string, sessionFile: string | null, asker: 'owner' | 'agent' = 'owner') {
    const at = new Date().toISOString();
    const scopeItemId = project.scope.find((i) => i.relation === 'Main project')?.id ?? project.scope[0]?.id ?? '';
    // Who wrote the message, and where their words begin after the heading it is shown under, are recorded on the source
    // (`said`; the time is the anchor's): reading them back out of the heading meant a new heading would have dropped the
    // owner's words from what counts as theirs without a sign (Spec §1.2, §3.3).
    const heading = `[${asker} ${at}]\n`;
    const made = makeSessionSource({ projectId: project.id, host: 'pi', sessionId: conversationId, file: sessionFile ?? '', cwd: project.locations[0] ?? null, messageStart: turn, messageEnd: turn, at, excerpt: `${heading}${text}`, title: asker === 'agent' ? `Agent query · message ${turn}` : `Keeper conversation · message ${turn}`, scopeItemId });
    const source: Source = { ...made, said: { by: asker, wordsFrom: heading.length } };
    // An owner message is an owner statement (§2.6); what it is used as (a decision, a correction, a question) is judged per message, so it starts as Not yet judged.
    store.sources.put({ ...source, usedAs: null, usedAsBy: null }, { jobId: null, summary: 'Owner message in the Keeper conversation' });
    return source;
  }

  /** A conversation on a note joins its discussion; the owner's response becomes Discussed unless something stronger is recorded (§4.4). */
  private afterTurn(projectId: string, jobId: string): void {
    const store = this.app.store(projectId);
    const job = store.jobs.get(jobId);
    const x = job ? extraOf(job) : null;
    if (!job || !x || x.context?.kind !== 'note') return;
    const note = store.notes.get(x.context.id);
    if (!note) return;
    const entries = [...note.discussion, { role: 'owner' as const, text: x.question, at: job.queuedAt, sourceId: x.ownerSourceId }, ...(x.followUps ?? []).map((f) => ({ role: 'owner' as const, text: f.text, at: f.at, sourceId: f.sourceId }))];
    if (job.resultText) entries.push({ role: 'keeper', text: job.resultText, at: job.endedAt ?? new Date().toISOString(), sourceId: null });
    const delegated = job.kind === 'Your request';
    // §4.4, §3.9: the note is Decided when this message's source was used to record a confirmation or a decision;
    // otherwise the response stands as it was, Discussed by default.
    const recorded = store.rules.find((r) => r.ownerConfirmation?.sourceId === x.ownerSourceId) !== undefined
      || store.reference.find((r) => r.attribution.identity === 'Decision' && r.sourceIds.includes(x.ownerSourceId)) !== undefined;
    const ownerResponse = delegated ? 'Delegated' : recorded ? 'Decided' : (note.ownerResponse ?? 'Discussed');
    const followUps = delegated && !note.followUps.some((f) => f.jobId === job.id) ? [...note.followUps, { kind: 'adjustment' as const, jobId: job.id, at: job.endedAt ?? new Date().toISOString(), summary: `${job.status}: ${(job.resultText ?? '').slice(0, 200)}` }] : note.followUps;
    store.notes.put({ ...note, discussion: entries, ownerResponse, followUps, updatedAt: new Date().toISOString() }, { jobId, summary: delegated ? 'Adjustment delegated on the note' : 'Discussed in the Keeper conversation' });
  }
}
