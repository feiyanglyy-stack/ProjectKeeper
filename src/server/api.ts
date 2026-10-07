/**
 * JSON API consumed by the workbench and the CLI. Handlers stay thin: the App and the
 * services own the behaviour.
 */
import type { App } from './app.ts';
import { HttpApp, HttpError, optionalString, requireString } from './http.ts';
import { SCOPE_CATEGORY, SCOPE_RELATION, isOneOf } from '../model/vocab.ts';
import { ORGANIZING_LEVEL } from '../model/vocab.ts';
import type { KeeperJob, Usage } from '../model/types.ts';
import { anchorLabel } from '../sources/anchor.ts';
import { existsSync, readFileSync } from 'node:fs';
import { fingerprint } from '../model/ids.ts';
import { cameFromView, changeRow, factDetail, graphView, nodeDetail, overview, relationDetail, threadDetail } from './graph-view.ts';
import { howThisProjectWorks, isRemoved, jobOpens, organizingLevels, organizingPlanView, scopeListView, settledByRuleView, toolchainView } from './workbench-content.ts';
import { diffVersions, listVersions, readVersion, snapshot } from '../store/versions.ts';
import { projectDir } from '../store/paths.ts';
import { pendingCount } from '../keeper/organize/follow-up.ts';
import { agentUsage, assembleContext, contextOptions } from '../context/assemble.ts';
import { knownPart, resolveProject } from '../context/ask.ts';
import { fileLocation, isCodeSource, locationText } from '../context/code-source.ts';
import { sourceOriginal } from '../context/object-brief.ts';
import { rulePage } from '../context/project-rules.ts';
import { resolveMergedId } from '../keeper/merge.ts';
import { samePath } from '../util/paths.ts';
import { registerKRoutes } from './k-views.ts';
import { registerProjectFolderRoutes } from './project-folder-api.ts';
import { registerKAgentRoutes } from './k-agent-api.ts';
import { registerDraftRoutes } from './drafts-api.ts';
import { notOrganizedPackage, registerKeeperPageRoutes } from './keeper-page.ts';
import { registerKeyRoutes } from './keys-api.ts';
import { registerFolderRoutes } from './folders-api.ts';
import { takeoverState } from '../keeper/organize/takeover-state.ts';
import { MODEL_STEP_KINDS, STEP_SETTING_AS, THINKING_LEVELS } from '../keeper/clerk-steps.ts';

export function registerRoutes(http: HttpApp, app: App, uiDir: string, vendorDir: string): void {
  // Increment K: the process view, versions and lineage, Code, a round's tree, the Project scope additions (views-k.ts).
  registerKRoutes(http, app);
  registerProjectFolderRoutes(http, app);
  registerKAgentRoutes(http, app);
  registerDraftRoutes(http, app);
  // The Keeper view's two pages: Takeover (Start, Clear) and Daily (the schedule) — keeper-page.ts (D105).
  registerKeeperPageRoutes(http, app);
  registerKeyRoutes(http, app);
  // The folders of a directory, for the folder chooser where a location is typed (folders-api.ts).
  registerFolderRoutes(http);
  const projectSummary = (id: string) => {
    const project = app.project(id);
    const store = app.store(id);
    return {
      ...project,
      counts: {
        sources: store.sources.size, facts: store.facts.size, threads: store.threads.size, notes: store.notes.filter((n) => n.status === 'Current').length,
        // `nodes` is everything the graph draws; `reference` is the product reference alone. Reporting one as the
        // other turned a graph total into a reference count in a status report, so both are given by name.
        changes: store.changes.size, nodes: store.nodes.size, reference: store.reference.size,
        followUp: pendingCount(store),   // §5.5: downstream objects still to judge, and how many changes they belong to
      },
      coverage: store.coverage,
    };
  };

  http.route('GET', '/api/workspace', () => ({
    projects: app.workspace.list().map((p) => ({ id: p.id, name: p.name, locations: p.locations, lastOpenedAt: p.lastOpenedAt, createdAt: p.createdAt })),
    settings: app.workspace.settings,
    lastProjectId: app.workspace.lastProjectId,
    home: app.home,
  }));

  http.route('POST', '/api/projects', ({ body }) => {
    const b = (body ?? {}) as { name?: unknown; locations?: unknown };
    const name = requireString(b.name, 'name');
    const locations = Array.isArray(b.locations) ? b.locations.filter((l): l is string => typeof l === 'string' && l.trim().length > 0).map((l) => l.trim()) : [];
    if (locations.length === 0) throw new HttpError(400, 'At least one location is required');
    return projectSummary(app.addProject(name, locations).id);
  });

  http.route('GET', '/api/projects/:id', ({ params }) => projectSummary(params.id!));

  http.route('POST', '/api/projects/:id/opened', ({ params }) => app.markOpened(params.id!));

  http.route('GET', '/api/projects/:id/scope', ({ params }) => {
    const project = app.project(params.id!);
    const store = app.store(params.id!);
    const reasonSources = Object.fromEntries(project.scope.flatMap((i) => i.reasonSourceIds.map((sid) => {
      const s = store.sources.get(sid);
      return [sid, s ? { id: s.id, title: s.title, label: anchorLabel(s.anchor), excerpt: s.excerpt } : null];
    })));
    return {
      scope: project.scope, questions: project.scopeQuestions, keeperFiles: project.keeperFiles, roles: project.roles,
      language: project.language, lastScopedAt: project.lastScopedAt, coverage: store.coverage,
      authorizations: store.authorizations.filter((a) => !a.revokedAt), reasonSources, organizingPaused: project.organizingPaused,
      // §6.7: the list sectioned (third-party material and generated output apart, ignored directories holding
      // documents apart; CKC-04 AC-13, AC-17), the toolchain, and what the rules settle directly (§1.11, §3.7).
      scopeView: scopeListView(project), toolchain: toolchainView(project), settledByRule: settledByRuleView(store, project),
      // The interface's choices come from the vocabularies, never from a second list written into the page.
      scopeVocab: { categories: SCOPE_CATEGORY, relations: SCOPE_RELATION, organizingLevels: ORGANIZING_LEVEL },
      // §6.7 (D62, D64; CKC-21 AC-11): the project's rules in their three groups, and the framing round's plan and focus.
      howThisProjectWorks: howThisProjectWorks(store), organizingPlan: organizingPlanView(store),
    };
  });

  // Before `Start` the Keeper reads nothing (D105; CKC-13 AC-20): the boundary is drawn and the material read by the takeover.
  const started = (id: string) => { if (takeoverState(app.store(id), app.project(id)).phase === 'Not started') throw new HttpError(409, 'This project has not been started: choose a depth and press Start on the Takeover page. Nothing is read before that.'); return id; };
  http.route('POST', '/api/projects/:id/scope/rescan', ({ params }) => projectSummary(app.rescanProject(started(params.id!)).id));
  http.route('POST', '/api/projects/:id/intake', async ({ params }) => (await app.intakeProject(started(params.id!))) ?? { running: true });

  http.route('POST', '/api/projects/:id/scope/items', ({ params, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const category = b.category;
    const relation = b.relation;
    if (!isOneOf(SCOPE_CATEGORY, category)) throw new HttpError(400, `category must be one of ${SCOPE_CATEGORY.join(', ')}`);
    if (!isOneOf(SCOPE_RELATION, relation)) throw new HttpError(400, `relation must be one of ${SCOPE_RELATION.join(', ')}`);
    return app.addScopeItem(params.id!, { path: requireString(b.path, 'path'), category, relation, reason: requireString(b.reason, 'reason') }).scope;
  });

  http.route('DELETE', '/api/projects/:id/scope/items/:itemId', ({ params }) => app.removeScopeItem(params.id!, params.itemId!).scope);

  http.route('POST', '/api/projects/:id/scope/questions/:qid', ({ params, body }) => {
    const b = (body ?? {}) as { answer?: unknown };
    return app.answerScopeQuestion(params.id!, params.qid!, requireString(b.answer, 'answer')).scopeQuestions;
  });

  http.route('GET', '/api/projects/:id/sources', ({ params, query }) => {
    const store = app.store(params.id!);
    const text = (query.get('q') ?? '').toLowerCase();
    const usedAs = query.get('usedAs');
    const availability = query.get('availability');
    const level = query.get('level');   // §6.7: the list also filters by organizing level (§1.11)
    const levels = organizingLevels(store, app.project(params.id!), app.pendingChanges(params.id!));
    return store.sources.all()
      .filter((s) => !text || s.title.toLowerCase().includes(text) || anchorLabel(s.anchor).toLowerCase().includes(text) || s.excerpt.toLowerCase().includes(text))
      .filter((s) => !usedAs || (usedAs === 'Not yet judged' ? s.usedAs === null : s.usedAs === usedAs))
      .filter((s) => !availability || s.availability === availability)
      .filter((s) => !level || levels.ofSource(s) === level)
      .map((s) => ({ id: s.id, title: s.title, label: anchorLabel(s.anchor), kind: s.anchor.kind, usedAs: s.usedAs, availability: s.availability, scopeItemId: s.scopeItemId, readAt: s.version.readAt, ids: s.ids, hasCredential: s.hasCredential, bytes: s.bytes, level: levels.ofSource(s) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  // One route for both readers of an original (Spec §6.4, §7.10): the workbench gets the source as it is; the agent
  // entry (`for=agent`) gets the text it prints — the same reading, except that a code file gives where it is and the
  // version read, and never its lines (D65; CKC-12 AC-22, AC-43).
  http.route('GET', '/api/projects/:id/sources/:sid', ({ params, query }) => {
    const store = app.store(params.id!);
    const source = store.sources.get(params.sid!);
    if (!source) throw new HttpError(404, 'Unknown source');
    // Re-check availability at read time: the excerpt stays as saved (§6.4).
    let availability = source.availability;
    let current: 'same' | 'changed' | 'missing' = 'same';
    if (source.anchor.kind === 'file') {
      if (!existsSync(source.anchor.path)) current = 'missing';
      else {
        try {
          if (fingerprint(readFileSync(source.anchor.path)) !== source.version.fingerprint) current = 'changed';
        } catch { current = 'missing'; }
      }
      if (current === 'missing' && !availability) availability = 'No longer available';
      if (current === 'changed' && !availability) availability = 'Changed since read';
    }
    const project = app.project(params.id!);
    const origin = project.scope.find((i) => i.id === source.scopeItemId);
    if (query.get('for') === 'agent') {
      const code = isCodeSource(source) ? fileLocation(project, source) : null;
      const path = source.anchor.kind === 'file' ? source.anchor.path : null;
      const otherParts = path === null ? [] : store.sources.filter((x) => x.id !== source.id && x.anchor.kind === 'file' && samePath(x.anchor.path, path))
        .map((x) => ({ id: x.id, label: anchorLabel(x.anchor).slice(path.length).replace(/^ › /, '') || anchorLabel(x.anchor) }));
      const text = sourceOriginal({
        title: source.title, kind: source.anchor.kind, label: anchorLabel(source.anchor), readAt: source.version.readAt, commit: source.version.commit ?? null,
        fingerprint: source.version.fingerprint, usedAs: source.usedAs, origin: origin ? { path: origin.path, relation: origin.relation } : null,
        availabilityNow: availability, currentState: current, hasCredential: source.hasCredential,
        excerpt: code ? '' : source.excerpt, lineStart: source.anchor.kind === 'file' ? source.anchor.lineStart : 1,
        code: code ? { location: locationText(code), file: code.file } : null, otherParts,
      });
      return { id: source.id, kind: source.anchor.kind, code: code !== null, text };
    }
    return { ...source, label: anchorLabel(source.anchor), availabilityNow: availability, currentState: current, origin: origin ? { path: origin.path, relation: origin.relation } : null, trace: store.traceFor('sources', source.id, 20) };
  });
  // A project rule by its id, for the agent entry (Spec §7.10, §1.15): every rule id a pack names can be read.
  http.route('GET', '/api/projects/:id/rules/:rid', ({ params }) => {
    const store = app.store(params.id!);
    const rule = store.rules.get(params.rid!);
    if (!rule) throw new HttpError(404, 'Unknown rule');
    const sources = rule.sourceIds.map((id) => { const s = store.sources.get(id); return { id, title: s?.title ?? id, label: s ? anchorLabel(s.anchor) : id }; });
    const next = rule.replacedBy ? store.rules.get(rule.replacedBy) : undefined;
    const withoutOwner = store.marks.find((m) => m.targetId === rule.id && m.kind === 'Decided without owner' && !m.closed) ?? null;
    return { id: rule.id, kind: 'rule', text: rulePage({ rule, sources, replacedBy: next ? { id: next.id, summary: next.summary } : null, withoutOwner }) };
  });

  // ---- Graph, strip, details (§6.2–§6.5) ----
  http.route('GET', '/api/projects/:id/graph', ({ params }) => {
    const store = app.store(params.id!);
    return { ...graphView(store, app.project(params.id!)), changes: store.changes.all().map((c) => ({ id: c.id, affects: c.affects, propagation: c.propagation })) };
  });
  http.route('GET', '/api/projects/:id/overview', ({ params, query }) => overview(app.store(params.id!), app.project(params.id!), optionalString(query.get('since')), optionalString(query.get('selection'))));
  http.route('GET', '/api/projects/:id/nodes/:nid', ({ params }) => { const d = nodeDetail(app.store(params.id!), app.project(params.id!), params.nid!); if (!d) throw new HttpError(404, 'Unknown node'); return d; });
  http.route('GET', '/api/projects/:id/relations/:rid', ({ params }) => { const d = relationDetail(app.store(params.id!), params.rid!); if (!d) throw new HttpError(404, 'Unknown relation'); return d; });
  http.route('GET', '/api/projects/:id/facts/:fid', ({ params }) => { const d = factDetail(app.store(params.id!), params.fid!); if (!d) throw new HttpError(404, 'Unknown fact record'); return d; });
  http.route('GET', '/api/projects/:id/threads/:tid', ({ params }) => { const d = threadDetail(app.store(params.id!), params.tid!); if (!d) throw new HttpError(404, 'Unknown work thread'); return d; });
  http.route('GET', '/api/projects/:id/notes', ({ params }) => ({ notes: app.store(params.id!).notes.all(), relookDone: app.store(params.id!).judgements.size > 0 }));
  http.route('GET', '/api/projects/:id/notes/:nid', ({ params }) => { const store = app.store(params.id!); const n = store.notes.get(params.nid!); if (!n) throw new HttpError(404, 'Unknown note'); const j = store.judgements.get(n.versions[n.versions.length - 1]!.judgementRecordId) ?? null; return { ...n, judgement: j, cameFrom: cameFromView(store, n) }; });
  http.route('GET', '/api/projects/:id/changes', ({ params }) => {
    const store = app.store(params.id!);
    const rows = store.changes.all().sort((a, b) => a.at.localeCompare(b.at)).map((c) => changeRow(store, c));
    const segments: { name: string | null; sourceId: string | null; changes: typeof rows }[] = [];
    for (const r of rows) {
      const name = r.segment?.name ?? null;
      let seg = segments.find((s) => s.name === name);
      if (!seg) { seg = { name, sourceId: r.segment?.sourceId ?? null, changes: [] }; segments.push(seg); }
      seg.changes.push(r);
    }
    const pending = store.coverage.scopes.reduce((n, s) => n + s.pending.length, 0);
    return { changes: rows, segments, pending };
  });
  const store_ = (id: string) => app.store(id);

  // ---- Keeper: activity, control, connections (§6.9, §6.10) ----
  const jobRow = (j: KeeperJob) => ({
    id: j.id, kind: j.kind, initiator: j.initiator, agent: j.agent, scope: j.scope, status: j.status, queuedAt: j.queuedAt, startedAt: j.startedAt, endedAt: j.endedAt,
    savedResults: j.savedResults, usage: j.usage, model: j.model, steps: j.steps.slice(-40), error: j.error, requestBasis: j.requestBasis, parentJobId: j.parentJobId,
    resultText: j.resultText, priority: j.priority, sessionFile: j.sessionFile,
    // CKC-03 AC-23: reads the boundary refused during this job (each is also a step of its own).
    boundaryDenials: j.boundaryDenials ?? 0,
    // §6.9: the round that recorded the project's rules and the plan and focus opens them (§3.7).
    opens: jobOpens(j),
  });

  /** A job and what it delegated are one piece of work: the tree is shown together and the usage is counted both ways —
   *  each job on its own, and the whole tree under the job that started it (D59 design 1; §6.9). */
  const delegationOf = (all: readonly KeeperJob[]) => {
    const children = new Map<string, KeeperJob[]>();
    for (const j of all) if (j.parentJobId) children.set(j.parentJobId, [...(children.get(j.parentJobId) ?? []), j]);
    const withDelegated = (j: KeeperJob): Usage => (children.get(j.id) ?? []).reduce((u, c) => {
      const t = withDelegated(c);
      return { input: u.input + t.input, output: u.output + t.output, cacheRead: u.cacheRead + t.cacheRead, cacheWrite: u.cacheWrite + t.cacheWrite, cost: u.cost === null && t.cost === null ? null : (u.cost ?? 0) + (t.cost ?? 0) };
    }, { ...j.usage });
    const under = (j: KeeperJob): KeeperJob[] => (children.get(j.id) ?? []).flatMap((c) => [c, ...under(c)]);
    // Boundary denials are recorded on the job that was refused; the main job's total counts the tree under it.
    const denialsDelegated = (j: KeeperJob): number => (children.get(j.id) ?? []).reduce((n, c) => n + denialsDelegated(c), j.boundaryDenials ?? 0);
    return { children, withDelegated, under, denialsDelegated };
  };

  http.route('GET', '/api/projects/:id/activity', async ({ params }) => {
    const store = app.store(params.id!);
    const project = app.project(params.id!);
    const status = await app.keeper.status(params.id!);
    const provider = await app.keeper.providerState(params.id!);
    const all = store.jobs.all();
    const { children, withDelegated, under, denialsDelegated } = delegationOf(all);
    const recent = all.sort((a, b) => (b.startedAt ?? b.queuedAt).localeCompare(a.startedAt ?? a.queuedAt)).slice(0, 200);
    // A subagent is shown with the job that sent it even when it falls outside the most recent 200, so the tree is
    // never missing a branch the reader can see the top of.
    const shown = new Map(recent.map((j) => [j.id, j]));
    for (const j of recent) for (const c of under(j)) shown.set(c.id, c);
    const jobs = [...shown.values()].map((j) => ({ ...jobRow(j), delegated: (children.get(j.id) ?? []).length, usageWithDelegated: withDelegated(j), boundaryDenialsWithDelegated: denialsDelegated(j) }));
    return { ...status, jobs, organizingPaused: project.organizingPaused, agent: 'pi', model: provider.model, connected: provider.connected };
  });
  http.route('GET', '/api/projects/:id/activity/:jobId', ({ params }) => {
    const store = app.store(params.id!);
    const job = store.jobs.get(params.jobId!);
    if (!job) throw new HttpError(404, 'Unknown job');
    return { ...jobRow(job), steps: job.steps, trace: store.traceByJob(job.id, 200) };
  });
  // Follow-up rounds: what each round judged, and the owner marking one as looked at (D56 item 3).
  http.route('GET', '/api/projects/:id/rounds', ({ params }) => {
    const store = app.store(params.id!);
    const name = (id: string) => store.nodes.get(id)?.label ?? store.reference.get(id)?.name ?? store.threads.get(id)?.title ?? id;
    return {
      rounds: store.rounds.all().sort((a, b) => b.number - a.number).map((r) => ({
        ...r,
        result: r.result ? { ...r.result, behind: r.result.behind.map((b) => ({ ...b, label: name(b.nodeId) })) } : null,
        mainJob: r.mainJobId ? store.jobs.get(r.mainJobId)?.scope.label ?? null : null,
      })),
    };
  });
  http.route('POST', '/api/projects/:id/rounds/:roundId/seen', ({ params }) => {
    const store = app.store(params.id!);
    const round = store.rounds.get(params.roundId!);
    if (!round) throw new HttpError(404, 'Unknown round');
    store.rounds.put({ ...round, seenAt: new Date().toISOString() });
    return { ok: true };
  });
  http.route('POST', '/api/projects/:id/organize', async ({ params }) => ({ coverage: await app.organizing.replan(params.id!) }));
  http.route('POST', '/api/projects/:id/relook', ({ params, body }) => {
    const b = (body ?? {}) as { kind?: unknown; id?: unknown };
    const kind = b.kind === 'area' || b.kind === 'thread' ? b.kind : 'project';
    const id = kind === 'project' ? null : requireString(b.id, 'id');
    const job = app.organizing.requestRelook(params.id!, { kind, id, label: '' });
    return { jobId: job.id, status: job.status };
  });
  // Confirm on a note (owner 2026-09-22): the owner's fixed statement with the note as context, answered in the background.
  http.route('POST', '/api/projects/:id/notes/:nid/confirm', ({ params }) => app.conversation.confirm(params.id!, params.nid!));
  http.route('GET', '/api/projects/:id/authorizations', ({ params }) => ({ authorizations: app.store(params.id!).authorizations.all() }));
  http.route('POST', '/api/projects/:id/authorizations/:aid/revoke', ({ params }) => app.revokeAuthorization(params.id!, params.aid!));
  http.route('GET', '/api/projects/:id/requests', ({ params }) => ({ requests: app.store(params.id!).requests.all() }));
  http.route('POST', '/api/projects/:id/notes/:nid/response', ({ params, body }) => {
    const response = requireString((body as { response?: unknown })?.response, 'response');
    if (!['Discussed', 'Decided', 'Delegated', 'No action needed'].includes(response)) throw new HttpError(400, 'response must be Discussed, Decided, Delegated or No action needed');
    app.respondToNote(params.id!, params.nid!, response as 'Discussed');
    return { ok: true };
  });
  http.route('POST', '/api/projects/:id/keeper/pause',({ params }) => ({ organizingPaused: app.pauseOrganizing(params.id!, true).organizingPaused }));
  http.route('POST', '/api/projects/:id/keeper/resume', ({ params }) => ({ organizingPaused: app.pauseOrganizing(params.id!, false).organizingPaused }));
  // Compare (D45): the versions that were kept, and the difference between any two of them.
  http.route('GET', '/api/projects/:id/versions', ({ params }) => ({ versions: listVersions(projectDir(params.id!, app.home)) }));
  http.route('GET', '/api/projects/:id/compare', ({ params, query }) => {
    const dir = projectDir(params.id!, app.home);
    const all = listVersions(dir);
    if (all.length === 0) return { versions: [], error: 'No version has been kept yet; one is saved each time you open the project and at the end of each round.' };
    const toId = query.get('to') || 'now';
    const fromId = query.get('from') || all[all.length - 1]!.id;
    const before = readVersion(dir, fromId);
    const after = toId === 'now' ? snapshot(app.store(params.id!), 'Asked') : readVersion(dir, toId);
    if (!before || !after) return { versions: all, error: 'That version is no longer kept.' };
    const { items, counts } = diffVersions(before, after);
    return { versions: all, from: { id: fromId, at: before.at }, to: { id: toId, at: after.at }, counts, items };
  });
  // Follow up (the dock's and the `Daily` page's, the same action): organize what has changed since the last round, now,
  // instead of waiting for the next scheduled time. Refused, with why, until the takeover is done (§6.9).
  http.route('POST', '/api/projects/:id/keeper/follow-up', ({ params }) => {
    const id = params.id!;
    app.followUp(id);
    const store = app.store(id);
    const scope = store.coverage.scopes.find((s) => s.id === 'project');
    return { queued: (scope?.pending.length ?? 0) + (scope?.organizing.length ?? 0) };
  });
  http.route('POST', '/api/projects/:id/keeper/jobs/:jobId/stop', ({ params }) => ({ ok: app.keeper.stopJob(params.id!, params.jobId!) }));
  // Continue a stopped job, retry a failed one (§3.10, §6.9). A round's step goes through the organizing service, which
  // runs again what the program did itself (the ledger, the process, the program's part of a step) — the runtime runs
  // only a model's jobs — and counts the owner's run again as the owner's.
  http.route('POST', '/api/projects/:id/keeper/jobs/:jobId/continue', ({ params }) => ({ ok: app.organizing.runAgain(params.id!, params.jobId!) }));
  http.route('POST', '/api/projects/:id/keeper/jobs/:jobId/retry', ({ params }) => ({ ok: app.organizing.runAgain(params.id!, params.jobId!) }));
  http.route('POST', '/api/projects/:id/keeper/jobs/:jobId/steer', ({ params, body }) => ({ ok: app.keeper.steer(params.id!, params.jobId!, requireString((body as { text?: unknown })?.text, 'text')) }));
  http.route('POST', '/api/projects/:id/keeper/open-in-pi', ({ params, body }) => {
    const jobId = optionalString((body as { jobId?: unknown })?.jobId);
    const job = jobId ? app.store(params.id!).jobs.get(jobId) : undefined;
    return app.keeper.openInPi(app.project(params.id!), job?.sessionFile ?? null);
  });

  http.route('GET', '/api/projects/:id/connections', async ({ params }) => {
    const project = app.project(params.id!);
    const store = app.store(params.id!);
    const status = await app.keeper.status(params.id!);
    const provider = await app.keeper.providerState(params.id!);
    let resources: Awaited<ReturnType<App['keeper']['resources']>> = { resources: [], projectTrusted: null, trustDecision: 'unknown' };
    let resourcesError: string | null = null;
    try { resources = await app.keeper.resources(project); } catch (e) { resourcesError = (e as Error).message; }
    // §6.10 `Execution-agent access` lists the hosts that receive context; none is integrated in P1 (host integration is P3).
    const executionAgents = { connected: [] as { host: string; status: string }[], note: 'No execution agent is connected yet. Context is prepared and copied from Agent context, and any agent can query the Keeper without a host integration; nothing is installed into any agent.' };
    return {
      keeperAgent: {
        name: 'pi', status: status.status, reason: status.reason, detail: status.detail, capabilities: app.keeper.capabilities(),
        resources: resources.resources, projectTrusted: resources.projectTrusted, trustDecision: resources.trustDecision, resourcesError,
        resourceChanges: app.keeper.resourceChangesOf(params.id!),
      },
      modelProvider: { connected: provider.connected, reason: provider.reason, provider: provider.model?.provider ?? null, model: provider.model?.id ?? null, thinking: provider.model?.thinking ?? null, available: provider.available, backups: provider.backups, fallback: provider.fallback, switches: provider.switches },
      organizing: app.keeper.laneState(params.id!),
      // §3.7, §1.11: what the project's rules settle directly, and which rule or plan settled it.
      settledByRule: settledByRuleView(store, project),
      usage: app.keeper.usageSummary(params.id!),
      memory: { keeps: ['Project scope', 'Sources and excerpts', 'Product reference', 'Fact records, work threads, area understanding', 'Graph nodes and relations', 'Notes with versions and discussion', 'Change records and propagation', 'Entry marks', 'Judgement records and trace', 'Standing authorizations', 'Context packages'], doesNotPromise: 'Native sessions moving losslessly between runtimes', location: project.keeperFiles },
      executionAgents,
    };
  });

  http.route('POST', '/api/settings/model', ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const provider = requireString(b.provider, 'provider');
    const id = requireString(b.id, 'id');
    const thinking = optionalString(b.thinking) ?? null;
    if (!app.keeper.models.getModel(provider, id)) throw new HttpError(400, `Unknown model ${provider}/${id}`);
    const backups = Array.isArray(b.backups) ? (b.backups as { provider?: unknown; id?: unknown }[]).map((x) => ({ provider: requireString(x.provider, 'backups[].provider'), id: requireString(x.id, 'backups[].id'), thinking })) : undefined;
    for (const x of backups ?? []) if (!app.keeper.models.getModel(x.provider, x.id)) throw new HttpError(400, `Unknown backup model ${x.provider}/${x.id}`);
    app.keeper.setModel({ provider, id, thinking }, backups);
    return { model: app.workspace.settings.model, backups: app.workspace.settings.modelBackups };
  });
  http.route('POST', '/api/settings/organizing', ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const lanes = Number(b.lanesPerKey ?? b.lanes);
    if (!Number.isFinite(lanes) || lanes < 1 || lanes > 32) throw new HttpError(400, 'lanesPerKey must be a number from 1 to 32');
    app.keeper.setLanesPerKey(lanes);
    for (const p of app.workspace.list()) void app.organizing.replan(p.id);   // fill the new lanes now, not at the next event
    return app.keeper.laneState();
  });
  // Keys are entered in Keeper → Model provider and kept in ProjectKeeper's home (keys-api.ts, own-keys.ts; D105).
  // Each model step of a round can run on its own model and thinking level (CKC-03 AC-29, CKC-23 AC-11): the model on
  // the provider of whichever key the lane uses, so a step keeps its key and quota window; a step not set uses the
  // chosen model. What each step actually ran on is recorded on its job and shown in Keeper activity.
  // D99: the main agent and its lanes are model jobs of a round too, each settable (the runtime looks a job's setting up by
  // its step kind); the table shows them with the steps from before D99.
  const stepKinds: readonly string[] = [...new Set<string>([...MODEL_STEP_KINDS, 'main', 'lane'])];
  // D103: a step left unset runs on the chosen model, except one that defaults to another step's setting (`as`: the
  // synthesis runs on what the main agent is set to).
  http.route('GET', '/api/settings/steps', () => ({ steps: app.workspace.settings.steps ?? {}, kinds: stepKinds, thinking: THINKING_LEVELS, as: STEP_SETTING_AS }));
  http.route('POST', '/api/settings/steps', ({ body }) => {
    const raw = (body as { steps?: unknown } | null)?.steps;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'steps must be an object keyed by step, e.g. { "orientation": { "model": "glm-5.3", "thinking": "max" } }');
    const chosen = app.workspace.settings.model;
    const next: Record<string, { model?: string; thinking?: string }> = { ...(app.workspace.settings.steps ?? {}) };
    for (const [kind, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!stepKinds.includes(kind)) throw new HttpError(400, `${kind} is not a model step of a round; they are ${stepKinds.join(', ')}`);
      if (value === null) { delete next[kind]; continue; }   // back to the chosen model
      const v = (value ?? {}) as Record<string, unknown>;
      const model = optionalString(v.model) ?? undefined;
      const thinking = optionalString(v.thinking) ?? undefined;
      if (thinking && !(THINKING_LEVELS as readonly string[]).includes(thinking)) throw new HttpError(400, `thinking must be one of ${THINKING_LEVELS.join(', ')}`);
      if (model && chosen && !app.keeper.models.getModel(chosen.provider, model)) throw new HttpError(400, `${chosen.provider} has no model ${model}`);
      next[kind] = { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
    }
    app.workspace.setSettings({ steps: next });
    return { steps: app.workspace.settings.steps ?? {} };
  });
  http.route('GET', '/api/settings/providers', () => app.keeper.models.getProviders().map((p) => ({ id: p.id, name: p.name ?? p.id, configured: app.keeper.models.hasConfiguredAuth(p.id) })));

  // ---- Keeper conversation (§6.8) ----
  const parseContext = (raw: unknown): { kind: string; id: string; label: string } | null => {
    let c: unknown = raw;
    if (typeof raw === 'string') { try { c = JSON.parse(raw); } catch { c = null; } }
    const o = c as { kind?: unknown; id?: unknown; label?: unknown } | null;
    return o && typeof o.kind === 'string' && typeof o.id === 'string' ? { kind: o.kind, id: o.id, label: typeof o.label === 'string' ? o.label : o.id } : null;
  };
  http.route('GET', '/api/projects/:id/chat', ({ params, query }) => {
    const sessions = app.conversation.sessions(params.id!);
    const requested = optionalString(query.get('conversation'));
    const conversationId = requested && sessions.some((s) => s.id === requested) ? requested : requested === 'new' ? null : sessions[0]?.id ?? null;
    return { conversationId, sessions, turns: conversationId ? app.conversation.turns(params.id!, conversationId) : [], existing: app.conversation.existing(params.id!, parseContext(query.get('context'))), branchingSupported: app.keeper.branchingSupported, telemetry: app.conversation.telemetry(params.id!, conversationId) };
  });
  http.route('POST', '/api/projects/:id/chat', ({ params, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    return app.conversation.send(params.id!, { text: requireString(b.text, 'text').trim(), context: parseContext(b.context), conversationId: optionalString(b.conversationId) });
  });
  http.route('POST', '/api/projects/:id/chat/branch', async ({ params, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    return app.conversation.branch(params.id!, requireString(b.conversationId, 'conversationId'), requireString(b.jobId, 'jobId'));
  });

  // ---- Agent context and the query entry (§7.6, §7.8) ----
  http.route('GET', '/api/projects/:id/context/options', ({ params }) => ({ ...contextOptions(app.store(params.id!), app.project(params.id!), app.ledger.ledger(params.id!)), roles: app.project(params.id!).roles }));
  http.route('GET', '/api/projects/:id/context', async ({ params, query }) => {
    const scopeKind = query.get('scope') ?? 'project';
    const kind = (['project', 'area', 'work', 'path', 'question'] as const).find((k) => k === scopeKind) ?? 'project';
    // A work item merged into another is reached through the one kept (Spec §1.4, §7.10).
    const ids = (query.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((id) => resolveMergedId(app.store(params.id!), id));
    const purpose = query.get('purpose') === 'Work' ? 'Work' : 'Start';
    const kindRaw = query.get('kind') ?? 'Implement';
    const workKind = (['Implement', 'Review', 'Plan', 'Discuss product', 'Investigate'] as const).find((k) => k === kindRaw) ?? 'Implement';
    const recipient = optionalString(query.get('recipient')) ?? 'Incoming agent';
    // A project not organized yet — just added, or cleared — says so; it does not answer with an empty pack (§7.10, §3.7).
    if (takeoverState(app.store(params.id!), app.project(params.id!)).phase === 'Not started') return notOrganizedPackage(app.project(params.id!), { scope: { kind, ids }, purpose, kind: workKind, recipient, lastSessionAt: optionalString(query.get('since')), taskVersion: optionalString(query.get('taskVersion')) }, app.keeper.ready ? (await app.keeper.status(params.id!)).status : 'Not connected');
    const status = await app.keeper.status(params.id!);
    // The project's ledger, when it has one, gives the rest of a work's lineage (`How it got here`, CKC-12 AC-35).
    const pkg = assembleContext(app.store(params.id!), app.project(params.id!), { scope: { kind, ids }, purpose, kind: workKind, recipient, lastSessionAt: optionalString(query.get('since')), taskVersion: optionalString(query.get('taskVersion')) }, status.status, app.usageWhere(), app.ledger.ledger(params.id!));
    return pkg;
  });
  // Whatever an id in a pack names (Spec §7.10): its kind, so the agent entry knows how to read it. An id of another
  // project is not read here; the answer says which project it belongs to, or that it is not found.
  const kindOf = (store: ReturnType<App['store']>, id: string): string | null => {
    if (store.threads.has(id)) return 'work';
    const ref = store.reference.get(id);
    if (ref) return ref.category === 'Area' ? 'area' : 'reference';
    if (store.sources.has(id)) return 'source';
    if (store.notes.has(id)) return 'note';
    if (store.changes.has(id)) return 'change';
    if (store.marks.has(id)) return 'mark';
    if (store.facts.has(id)) return 'fact';
    if (store.relations.has(id)) return 'relation';
    if (store.rules.has(id)) return 'rule';
    if (store.nodes.has(id)) return 'node';
    if (store.breakpoints.has(id)) return 'breakpoint';
    if (store.sendbacks.has(id)) return 'sendback';
    if (store.patches.has(id)) return 'patch';
    if (store.territories.has(id)) return 'territory';
    return null;
  };
  const findObject = (projectId: string, asked: string) => {
    const store = app.store(projectId);
    const kept = resolveMergedId(store, asked);
    const directKind = kindOf(store, kept);
    if (directKind) return { id: kept, kind: directKind, mergedFrom: kept !== asked ? asked : null };
    const patch = store.patches.find((p) => p.number === asked);
    if (patch) return { id: patch.id, kind: 'patch', mergedFrom: null };
    const number = store.numbers.find((n) => n.number === asked || n.projectNumber === asked);
    if (number) {
      const target = resolveMergedId(store, number.objectId);
      const targetKind = kindOf(store, target);
      if (targetKind) return { id: target, kind: targetKind, mergedFrom: null };
    }
    return null;
  };
  http.route('GET', '/api/projects/:id/lookup/:oid', ({ params }) => {
    const oid = params.oid!;
    if (/[\\/]/.test(oid) || /^[A-Za-z]:/.test(oid)) throw new HttpError(400, 'Only ids from the assets are read here, not paths');
    app.project(params.id!);
    // The id of a work item merged into another reaches the one kept (Spec §1.4, §7.10; CKC-06 AC-28): the answer
    // names the kept id, which is what the caller reads next.
    const found = findObject(params.id!, oid);
    if (found) return found.mergedFrom ? { id: found.id, kind: found.kind, projectId: params.id, mergedFrom: found.mergedFrom } : { id: found.id, kind: found.kind, projectId: params.id };
    for (const p of app.workspace.list()) {
      if (p.id === params.id) continue;
      if (findObject(p.id, oid)) return { id: oid, kind: null, elsewhere: { projectId: p.id, name: p.name } };
    }
    return { id: oid, kind: null, elsewhere: null };
  });
  http.route('GET', '/api/projects/:id/marks/:mid', ({ params }) => {
    const store = app.store(params.id!);
    const m = store.marks.get(params.mid!);
    if (!m) throw new HttpError(404, 'Unknown mark');
    const label = (id: string) => store.reference.get(id)?.name ?? store.threads.get(id)?.title ?? store.nodes.get(id)?.label ?? (store.sources.get(id) ? anchorLabel(store.sources.get(id)!.anchor) : id);
    return { ...m, targetLabel: label(m.targetId), clueSources: m.clueSourceIds.map((id) => { const s = store.sources.get(id); return { id, title: s?.title ?? id, label: s ? anchorLabel(s.anchor) : id }; }), note: m.noteId ? { id: m.noteId, title: store.notes.get(m.noteId)?.versions.at(-1)?.title ?? m.noteId } : null };
  });
  http.route('GET', '/api/projects/:id/usage', ({ params }) => ({ lines: agentUsage(params.id!, app.usageWhere()) }));
  http.route('GET', '/api/resolve', ({ query }) => {
    const cwd = optionalString(query.get('cwd'));
    if (!cwd) throw new HttpError(400, 'cwd is required');
    const p = resolveProject(app.workspace.list(), cwd);
    return p ? { projectId: p.id, name: p.name } : { projectId: null, message: `${cwd} is not inside any project added to ProjectKeeper.` };
  });
  http.route('POST', '/api/projects/:id/ask', ({ params, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const question = requireString(b.question, 'question').trim();
    const store = app.store(params.id!);
    const known = knownPart(store, question);
    const turn = app.conversation.send(params.id!, { text: question, context: null, conversationId: optionalString(b.thread), asker: 'agent', waiting: known.pendingSourceIds });
    return { known: known.text, knownSourceIds: known.sourceIds, waitingSourceIds: known.pendingSourceIds, investigation: { jobId: turn.jobId, thread: turn.conversationId, status: turn.status, fetch: `/api/projects/${params.id}/ask/${turn.jobId}` }, note: 'The known part comes from the organized assets. The investigation runs in the Keeper; fetch it by job id, or keep asking in the same thread.' };
  });
  http.route('GET', '/api/projects/:id/ask/:jobId', ({ params }) => {
    const job = app.store(params.id!).jobs.get(params.jobId!);
    if (!job) throw new HttpError(404, 'Unknown job');
    const store = app.store(params.id!);
    const cited = [...new Set((job.resultText ?? '').match(/src_[0-9a-f]{16}/g) ?? [])].map((id) => { const s = store.sources.get(id); return { id, title: s?.title ?? id, label: s ? anchorLabel(s.anchor) : id }; });
    return { jobId: job.id, status: job.status, answer: job.resultText, error: job.error, steps: job.steps.length, startedAt: job.startedAt, sources: cited, thread: (job.task as { extra?: { conversationId?: string } } | null)?.extra?.conversationId ?? null };
  });

  http.route('GET', '/api/projects/:id/search', ({ params, query }) => {
    const store = app.store(params.id!);
    const q = (query.get('q') ?? '').trim().toLowerCase();
    if (!q) return { results: [] };
    const hit = (text: string | null | undefined) => (text ?? '').toLowerCase().includes(q);
    const results: { type: string; id: string; label: string; detail: string }[] = [];
    // A node found here is shown on the graph; what was removed is not on it (§2.1, §6.12). The change that removed it
    // is still found, and opens in the Change log.
    for (const n of store.nodes.all()) if (hit(n.label) && n.validity !== 'Removed' && !isRemoved(store, n.refId)) results.push({ type: 'node', id: n.id, label: n.label, detail: n.category });
    for (const s of store.sources.all()) if (hit(s.title) || hit(anchorLabel(s.anchor)) || hit(s.excerpt)) results.push({ type: 'source', id: s.id, label: s.title, detail: anchorLabel(s.anchor) });
    for (const c of store.changes.all()) if (hit(c.title) || hit(c.summary)) results.push({ type: 'change', id: c.id, label: c.title, detail: c.at });
    for (const n of store.notes.all()) { const v = n.versions[n.versions.length - 1]; if (v && (hit(v.title) || hit(v.preview))) results.push({ type: 'note', id: n.id, label: v.title, detail: n.status }); }
    return { results: results.slice(0, 60) };
  });

  http.static('/vendor/', vendorDir);
  http.static('/', uiDir);
}
