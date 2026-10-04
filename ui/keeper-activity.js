// Keeper activity (Spec §6.9; D35, D105; CKC-03 AC-5, AC-12): the one list of what the Keeper is doing and has done, in a
// dialog. It opens from the Keeper's status line at the foot of the rail and from both pages of the Keeper view; the
// Keeper view keeps no second copy.
//
// A round is one row — which kind, when, its status, its time and cost — and its tree opens on a click: the ledger, the
// main agent with the stage it reached, the lanes it sent, the synthesis, the spot check, each with its scope, status,
// time and usage (k/round-tree.js). The briefs, reports and adoption records open on a further click there. Work that
// belongs to no round — an answer to the owner, a re-look, a request — is listed under the rounds.
import { api, append, clear, fmtRel, fmtTime, h, navigate, openDialog, refreshActivity, state, toast } from './app.js';
import { renderRoundTree } from './k/round-tree.js';
import { openDraft } from './k/draft-view.js';
import * as kData from './k-data.js';
import * as kProcess from './k-process.js';

const P = () => encodeURIComponent(state.projectId);
const fmtWall = (ms) => { if (ms == null) return '—'; const m = Math.round(ms / 60000); return m < 1 ? 'under a minute' : m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`; };
const fmtCost = (c) => (c == null ? 'cost not reported' : `$${c.toFixed(2)}`);
const ROUND_NAME = { 'First usable': 'Takeover: first usable picture', Deepen: 'Takeover: deepening', 'Follow up': 'Follow up' };
const STARTED_BY = { owner: 'you pressed Follow up', schedule: 'started by the schedule', continuous: 'started by Continuous' };

/** The rounds the owner opened stay open while the list is redrawn for new data. */
const openRounds = new Set();

/** The round that recorded the project's rules, or the plan and focus, opens them in Project scope (Spec §6.9, §3.7). */
function opensLinks(j) {
  if (!j.opens?.rules && !j.opens?.plan) return null;
  const go = (rest) => { const d = document.querySelector('#dialog'); if (d?.open) d.close(); navigate(state.projectId, 'scope', rest); };
  return h('div', { class: 'row wrap' },
    j.opens.rules ? h('button', { class: 'text-btn', title: 'Open How this project works in Project scope', onClick: () => go('rules') }, `Project rules (${j.opens.rules})`) : null,
    j.opens.plan ? h('button', { class: 'text-btn', title: 'Open the organizing plan and focus in Project scope', onClick: () => go('plan') }, 'Organizing plan and focus') : null);
}

/**
 * The row drawn for each round and what it was drawn from. A round whose data has not changed keeps its element when the
 * list is redrawn, so a tree the owner is reading — a brief open, an account unfolded — is not rebuilt because another
 * round moved on.
 */
const drawn = new Map();
const sameAs = (round, failures) => JSON.stringify([{ ...round, wallMs: round.endedAt ? round.wallMs : null }, failures]);

/** One round: a row, and under it — once opened — its tree. */
function roundRow(round, ctx, render) {
  const failures = (ctx.failures ?? []).filter((f) => round.steps.some((s) => s.jobId === f.ref));
  const key = sameAs(round, failures);
  const kept = drawn.get(round.id);
  if (kept && kept.key === key && kept.projectId === state.projectId) return kept.el;
  const el = buildRoundRow(round, ctx, render, failures);
  drawn.set(round.id, { key, el, projectId: state.projectId });
  return el;
}
function buildRoundRow(round, ctx, render, failures) {
  const body = h('div', { class: 'ka-round-tree' });
  const draw = () => { if (!body.firstChild) renderRoundTree(body, [round], ctx); };
  const running = round.status === 'Running';
  const stop = async (e) => {
    e.preventDefault(); e.stopPropagation();
    try {
      for (const id of [round.rootJobId, ...round.steps.filter((s) => /running|queued|paused|waiting/i.test(s.status)).map((s) => s.jobId)].filter(Boolean)) await api(`/api/projects/${P()}/keeper/jobs/${encodeURIComponent(id)}/stop`, { method: 'POST' });
      toast('Stopping the round: what is saved stays, and it can be continued');
    } catch (err) { toast(err.message); }
    await render();
  };
  const result = round.kind === 'Follow up' ? ctx.resultOf?.(round) ?? null : null;
  const el = h('details', { class: 'ka-round', 'data-round': round.id, 'data-kind': round.kind, open: openRounds.has(round.id),
    onToggle: (e) => { if (e.target.open) { openRounds.add(round.id); draw(); } else openRounds.delete(round.id); } },
    h('summary', { class: 'ka-round-row' },
      h('span', { class: 'tag blue' }, ROUND_NAME[round.kind] ?? round.kind),
      h('b', {}, `Round ${round.number}`),
      round.kind === 'Deepen' && round.depth ? h('span', { class: 'muted' }, round.depth) : null,
      round.kind === 'Follow up' && round.startedBy ? h('span', { class: 'muted' }, STARTED_BY[round.startedBy] ?? round.startedBy) : null,
      h('span', { class: 'muted' }, fmtTime(round.startedAt)),
      h('span', { class: `tag ${failures.length ? 'red' : /done/i.test(round.status) ? 'green' : running ? 'amber' : ''}` }, failures.length ? `${round.status} · ${failures.length} not finished` : round.status),
      h('span', { class: 'muted' }, `${fmtWall(round.wallMs)} · ${fmtCost(round.usage?.cost ?? null)}`),
      result ? h('span', { class: 'faint ka-round-result' }, result.line) : null,
      running ? h('button', { class: 'btn small', title: 'Stop this round: the whole tree stops; what is saved stays', onClick: stop }, 'Stop') : null),
    body);
  if (openRounds.has(round.id)) draw();
  return el;
}

export async function renderActivity(body) {
  const render = () => renderActivity(body);
  const [a, rounds, summary, ov] = await Promise.all([
    api(`/api/projects/${P()}/activity`),
    kData.getRounds(state.projectId).catch(() => null),
    api(`/api/projects/${P()}`).catch(() => null),
    api(`/api/projects/${P()}/overview?since=&selection=`).catch(() => null),
  ]);
  const scroll = body.closest('.dialog-body')?.scrollTop ?? 0;
  clear(body);
  const pauseBtn = h('button', { class: 'btn small', onClick: async () => { await api(`/api/projects/${P()}/keeper/${a.organizingPaused ? 'resume' : 'pause'}`, { method: 'POST' }); await render(); await refreshActivity(); } }, a.organizingPaused ? 'Resume organizing' : 'Pause organizing');
  const relookBtn = h('button', { class: 'btn small', disabled: a.status === 'Not connected', title: 'Ask the Keeper to re-look at the whole project now', onClick: async () => { await api(`/api/projects/${P()}/relook`, { method: 'POST', body: { kind: 'project' } }); toast('Product re-look requested'); await render(); } }, 'Request product re-look');
  const close = () => { const d = document.querySelector('#dialog'); if (d?.open) d.close(); };
  append(body, h('div', { class: 'row spread' },
    h('div', {}, h('b', {}, a.status), a.reason ? h('div', { class: 'muted' }, a.reason) : null, h('div', { class: 'muted' }, 'Agent: ', a.agent ?? '—', ' · Model: ', a.model ? `${a.model.provider}/${a.model.id}${a.model.thinking ? ':' + a.model.thinking : ''}` : '—')),
    h('div', { class: 'row' }, h('button', { class: 'text-btn', title: 'The schedule of daily organizing is set on the Daily page', onClick: () => { close(); navigate(state.projectId, 'keeper', 'daily'); } }, 'Schedule'), relookBtn, pauseBtn)));

  // ── the rounds: one row each, the tree on a click ──
  const results = new Map((ov?.roundResults ?? []).filter((x) => x.clerkRoundId).map((x) => [x.clerkRoundId, x]));
  const ctx = {
    fetchDoc: (roundId, docId) => kData.getRoundDoc(state.projectId, roundId, docId), openJob: () => undefined,
    // A session draft the session-drafts step wrote opens where the round is drilled into (CKC-23 AC-18).
    openDraft: (draftId) => openDraft(draftId, kProcess.draftCtx()),
    // A deepening read by reading assignments: what each sweep read of its plan, from the coverage (§3.7).
    deepening: summary?.coverage?.takeover?.deepening ?? null,
    // A Follow up round's one result (§5.5), and the way to open it (§6.9).
    resultOf: (round) => results.get(round.id) ?? null,
    openResult: async (result) => { const { openRound } = await import('./views.js'); openRound(result.id, { name: result.name }); },
    // What of a round did not finish, with why (§3.10): the coverage's failure list, and Retry or Continue on each.
    failures: summary?.coverage?.scopes?.find((s) => s.id === 'project')?.failed ?? [],
    runAgain: async (jobId, action) => {
      try {
        const r = await api(`/api/projects/${P()}/keeper/jobs/${encodeURIComponent(jobId)}/${action}`, { method: 'POST' });
        toast(r.ok ? (action === 'retry' ? 'Running it again' : 'Continuing it') : 'It cannot run again now');
      } catch (e) { toast(e.message); }
      await render();
    },
  };
  append(body, h('h4', { class: 'ka-head' }, `Rounds (${rounds?.length ?? 0})`));
  if (!rounds || !rounds.length) append(body, h('div', { class: 'faint', id: 'ka-no-rounds' }, rounds ? 'No round has run yet. A takeover starts on the Takeover page of the Keeper view.' : kData.noData()));
  else append(body, h('div', { class: 'ka-rounds', id: 'ka-rounds' }, ...rounds.map((r) => roundRow(r, ctx, render))));

  // ── work outside the rounds: answers, re-looks, requests; a job and what it delegated are one piece of work ──
  const inRound = new Set((rounds ?? []).flatMap((r) => [r.rootJobId, ...r.steps.flatMap((s) => [s.jobId, ...s.children.map((c) => c.jobId)])]).filter(Boolean));
  const byId = new Map(a.jobs.map((j) => [j.id, j]));
  const partOfRound = (j) => { for (let x = j; x; x = x.parentJobId ? byId.get(x.parentJobId) : null) if (inRound.has(x.id) || x.scope?.kind === 'clerk-round' || x.scope?.kind === 'clerk-step') return true; return false; };
  const others = a.jobs.filter((j) => !partOfRound(j));
  const otherIds = new Set(others.map((j) => j.id));
  const kids = new Map();
  for (const j of others) if (j.parentJobId && otherIds.has(j.parentJobId)) kids.set(j.parentJobId, [...(kids.get(j.parentJobId) || []), j]);
  const roots = others.filter((j) => !j.parentJobId || !otherIds.has(j.parentJobId)).sort((x, y) => (y.queuedAt || '').localeCompare(x.queuedAt || ''));
  const jobs = [];
  const walk = (j, depth) => { jobs.push({ ...j, depth }); for (const c of (kids.get(j.id) || []).sort((x, y) => (x.queuedAt || '').localeCompare(y.queuedAt || ''))) walk(c, depth + 1); };
  for (const r of roots.slice(0, 60)) walk(r, 0);
  append(body, h('h4', { class: 'ka-head' }, `Other work (${jobs.length})`));
  if (jobs.length === 0) append(body, h('div', { class: 'faint' }, 'No other Keeper work: answers to you, re-looks and requests are listed here.'));
  else {
    append(body, h('table', { class: 'list ka-jobs' }, h('thead', {}, h('tr', {}, h('th', {}, 'Kind'), h('th', {}, 'Initiator'), h('th', {}, 'Scope'), h('th', {}, 'Status'), h('th', {}, 'Saved results'), h('th', {}, 'Started'), h('th', {}, 'Usage'), h('th', {}))),
      h('tbody', {}, ...jobs.map((j) => h('tr', {},
        h('td', { style: j.depth ? { paddingLeft: `${8 + j.depth * 16}px` } : null }, j.depth ? h('span', { class: 'faint' }, '↳ ') : null, j.kind, j.requestBasis ? h('div', {}, h('span', { class: 'tag amber' }, j.requestBasis.label)) : null),
        h('td', {}, j.initiator),
        h('td', {}, j.scope.label),
        h('td', {}, h('span', { class: `tag ${j.status === 'Running' ? 'amber' : j.status === 'Done' ? 'green' : j.status === 'Failed' ? 'red' : ''}` }, j.status), j.error ? h('div', { class: 'faint' }, j.error.slice(0, 160)) : null,
          j.boundaryDenials > 0 ? h('div', { class: 'faint', title: 'Reads or shell commands the read boundary refused during this job' }, `${j.boundaryDenials} read${j.boundaryDenials === 1 ? '' : 's'} outside the boundary denied${(j.boundaryDenialsWithDelegated ?? j.boundaryDenials) > j.boundaryDenials ? ` · ${j.boundaryDenialsWithDelegated} with subagents` : ''}`) : null),
        h('td', {}, j.savedResults.length ? j.savedResults.slice(0, 5).map((r) => h('div', { class: 'faint' }, r.label)) : '—', opensLinks(j)),
        h('td', {}, j.startedAt ? fmtTime(j.startedAt) : h('span', { class: 'faint' }, `queued ${fmtRel(j.queuedAt)}`)),
        h('td', {}, `${j.usage.input}↑ ${j.usage.output}↓${j.usage.cost == null ? '' : ' $' + j.usage.cost.toFixed(3)}`,
          j.delegated ? h('div', { class: 'faint', title: 'This job and everything it delegated to' }, `with ${j.delegated} subagent${j.delegated === 1 ? '' : 's'}: ${j.usageWithDelegated.input}↑ ${j.usageWithDelegated.output}↓`) : null),
        h('td', {}, ['Running', 'Queued', 'Paused', 'Waiting for quota'].includes(j.status) ? h('button', { class: 'btn small', onClick: async () => { await api(`/api/projects/${P()}/keeper/jobs/${j.id}/stop`, { method: 'POST' }); await render(); } }, 'Stop') : j.status === 'Stopped' && j.agent !== 'program' ? h('button', { class: 'btn small', onClick: async () => { await api(`/api/projects/${P()}/keeper/jobs/${j.id}/continue`, { method: 'POST' }); await render(); } }, 'Continue') : j.status === 'Failed' && j.agent !== 'program' ? h('button', { class: 'btn small', onClick: async () => { await api(`/api/projects/${P()}/keeper/jobs/${j.id}/retry`, { method: 'POST' }); await render(); } }, 'Retry') : null,
          j.steps?.length ? h('details', { class: 'fold' }, h('summary', {}, `${j.steps.length} steps`), h('div', { class: 'content' }, ...j.steps.slice(-40).map((s) => h('div', { class: `mono ${s.isError ? 'red' : ''}` }, `${s.tool} ${s.target}${s.summary ? ' — ' + s.summary : ''}`)))) : null,
          j.sessionFile ? h('button', { class: 'text-btn', onClick: async () => { const r = await api(`/api/projects/${P()}/keeper/open-in-pi`, { method: 'POST', body: { jobId: j.id } }); toast(r.message); } }, 'Open in pi') : null))))));
  }
  const scroller = body.closest('.dialog-body');
  if (scroller) scroller.scrollTop = scroll;
}

/** Open Keeper activity; with `roundId`, that round's tree is open and in view. */
export async function openKeeperActivity({ roundId = null } = {}) {
  if (roundId) openRounds.add(roundId);
  const body = h('div', { class: 'stack ka-body', id: 'keeper-activity' });
  if (!document.getElementById('keeper-css')) document.head.append(h('link', { id: 'keeper-css', rel: 'stylesheet', href: '/keeper.css' }));
  const dialog = openDialog('Keeper activity', [body]);
  dialog.classList.add('wide');
  const render = () => renderActivity(body);
  await render();
  dialog._rerender = render;
  const row = roundId ? body.querySelector(`[data-round="${CSS.escape(roundId)}"]`) : null;
  if (row) { row.open = true; row.scrollIntoView({ block: 'start' }); }
}

/** The view the shell opens from the rail's Keeper line, and tells of the Keeper's events. */
export const activityView = {
  open: () => openKeeperActivity(),
  onEvent() { const d = document.querySelector('#dialog'); if (d?.open && d._rerender) d._rerender(); },
};
