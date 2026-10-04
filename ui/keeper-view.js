// The Keeper view as two pages (Spec §6.10; D105; CKC-03 AC-12): `Takeover` — choose a depth, Start, the progress as the
// Keeper works, the briefing at the end, Clear — and `Daily` — the schedule the owner sets, Follow up now, one line of
// status. Under both, the same settings blocks. What the Keeper is doing and has done is not listed here: it is in
// `Keeper activity` (keeper-activity.js), which both pages open.
//
// The page stays short (§6.13 给 agent 看的折起): what the owner decides or acts on is open; what an agent uses, or what
// is only read when looking into a problem, is folded under a one-line head that says what is inside and how much.
// A head carries what the owner must know, so nothing that matters hides in a fold.
import { api, append, fmtRel, fmtTime, h, navigate, openDialog, refreshActivity, refreshProject, state, toast, visHtml } from './app.js';
import { STAGE_LABEL, STEP_LABEL, LANE_KIND_LABEL, readText, coverageText, lanesAtOnce, isMainAgentRound } from './k/round-tree.js';
import { openKeeperActivity } from './keeper-activity.js';
import { chooseKey, mainChosen, modelFor, moveRow, orderBody, orderRows } from './key-order.js';
import { folderStatus, grantOutcome, grantWords } from './project-folder.js';

const P = () => encodeURIComponent(state.projectId);
const ensureStyle = () => {
  if (document.getElementById('keeper-css')) return;
  document.head.append(h('link', { id: 'keeper-css', rel: 'stylesheet', href: '/keeper.css' }));
};

// ── small formatters ──────────────────────────────────────────────────────
const fmtMinutes = (m) => (m == null ? '—' : m < 1 ? 'under a minute' : m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`);
const fmtWall = (ms) => (ms == null ? '—' : fmtMinutes(Math.round(ms / 60000)));
const fmtCost = (c) => (c == null ? 'cost not reported' : `$${c.toFixed(2)}`);
const kindsText = (byKind) => Object.entries(byKind || {}).map(([k, v]) => `${v} ${k}${v === 1 ? '' : 's'}`).join(', ') || '—';
const countsText = (byKind) => Object.entries(byKind || {}).map(([k, v]) => `${v} ${k}`).join(', ') || '—';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const statusTag = (st) => h('span', { class: `tag ${/fail|stop/i.test(st) ? 'red' : /done/i.test(st) ? 'green' : /running|organizing/i.test(st) ? 'blue' : ''}` }, st);

/** A block folded by default: one line that says what is inside and how much; opening it shows all of it. */
function fold(id, head, body, { open = false, note = null } = {}) {
  return h('details', { class: 'fold kp-fold', id, open: open || folds.has(id), onToggle: (e) => { if (e.target.open) folds.add(id); else folds.delete(id); } },
    h('summary', {}, h('span', { class: 'kp-fold-head' }, head), note ? h('span', { class: 'kp-fold-note' }, note) : null),
    h('div', { class: 'content stack' }, body));
}
/** The folds the owner opened stay open while the page is redrawn for new data. */
const folds = new Set();

// ── navigation to where a thing lives on the workbench ────────────────────
const goNode = (id, label) => { state.selection = { kind: 'node', id, label }; state.pendingPopover = {}; navigate(state.projectId, 'graph'); };
const goNote = (id, label) => { state.selection = { kind: 'note', id, label }; state.pendingPopover = {}; navigate(state.projectId, 'notes'); };
const goWaiting = (w) => (w.kind === 'note' ? goNote(w.id, w.text) : navigate(state.projectId, 'scope'));
const waitingList = (items) => h('ul', { class: 'kp-list kp-waiting' }, ...items.map((w) => h('li', {},
  h('button', { class: 'text-btn', 'data-waiting': w.kind, title: w.kind === 'note' ? 'Open the note' : 'Answer it in Project scope', onClick: () => goWaiting(w) }, w.text),
  h('span', { class: 'faint' }, w.kind === 'note' ? ' · note for your decision' : ' · scope question'))));

// ── the page ──────────────────────────────────────────────────────────────
const STATE_LINE = {
  'Not taken over': 'This project has not been taken over. Nothing runs until you choose a depth and press Start.',
  'Takeover under way': 'The takeover is under way. Daily organizing begins when it is done.',
  Daily: 'The takeover is done. The Keeper organizes what changes on your schedule, or now when you press Follow up.',
};

export const keeperView = {
  _page: null, _for: null, _dirty: false, _choice: null,

  async render(main) {
    ensureStyle();
    // Everything the page shows is read before it is drawn, so a redraw for new data can be compared with what stands.
    const [view, c, summary, mpv, usage, usageRounds] = await Promise.all([api(`/api/projects/${P()}/keeper-page`), api(`/api/projects/${P()}/connections`), api(`/api/projects/${P()}`),
      api(`/api/projects/${P()}/model-provider`).catch(() => null), api(`/api/projects/${P()}/usage`).catch(() => null), api(`/api/projects/${P()}/usage-rounds`).catch(() => null)]);
    // The page that opens: Takeover until the takeover is done, Daily from then on; a link or the owner's own choice
    // of tab stands while they stay on this project.
    if (keeperView._for !== state.projectId) { keeperView._for = state.projectId; keeperView._page = null; keeperView._dirty = false; keeperView._choice = null; }
    const asked = state.routeRest === 'takeover' || state.routeRest === 'daily' ? state.routeRest : null;
    const page = asked ?? keeperView._page ?? view.page;
    // Always the page on screen: the element this render drew into may be a detached one an in-place update drew into.
    const redraw = () => keeperView.redraw();
    const show = (p) => { keeperView._page = p; if (state.routeRest) navigate(state.projectId, 'keeper'); else redraw(); };
    append(main,
      h('div', { class: 'page-head kp-head', id: 'kp-head' },
        h('div', {}, h('h1', {}, 'Keeper'),
          h('p', { class: 'sub' }, h('span', { class: `tag ${view.state === 'Daily' ? 'green' : view.state === 'Takeover under way' ? 'blue' : 'amber'}`, id: 'kp-state' }, view.state), ' ', STATE_LINE[view.state])),
        h('div', { class: 'row' }, h('button', { class: 'btn small', id: 'kp-activity', title: 'What the Keeper is doing and has done: every round, with its tree', onClick: () => openKeeperActivity() }, 'Keeper activity'))),
      h('div', { class: 'segmented kp-tabs', role: 'tablist', 'aria-label': 'Keeper pages' },
        ...[['takeover', 'Takeover'], ['daily', 'Daily']].map(([id, label]) => h('button', { class: page === id ? 'active' : '', role: 'tab', 'aria-selected': String(page === id), 'data-page': id, onClick: () => { if (page !== id) show(id); } }, label))),
      h('div', { id: 'kp-page', 'data-page': page }, page === 'takeover' ? takeoverPage(view, summary, redraw) : dailyPage(view, redraw)),
      h('div', { id: 'kp-settings', class: 'stack' }, ...settingsBlocks(c, view, { keyFirst: page === 'takeover' && view.takeover.phase === 'Not started', mpv, usageRounds, usageLines: usage?.lines ?? null, redraw })),
    );
  },

  /**
   * The page drawn again after the owner changed something (a key, the route, the page): drawn off screen, then swapped
   * into the page on screen, keeping where it is scrolled. A redraw that a later one overtook is dropped, so two changes
   * in a row end on the second.
   */
  _gen: 0,
  async redraw() {
    await keeperView._swap(false);
  },

  /** New data while the page is open: redrawn in place, unless the owner is in the middle of changing the schedule. */
  async onAssets() {
    const main = document.querySelector('#main');
    if (!main || state.view !== 'keeper' || keeperView._dirty) return;
    if (main.querySelector('#kp-page input:focus, #kp-page select:focus, #kp-settings input:focus, #kp-settings select:focus')) return;
    await keeperView._swap(true);
  },

  async _swap(onlyIfChanged) {
    const gen = ++keeperView._gen;
    const project = state.projectId;
    const next = h('main', {});
    try { await keeperView.render(next); } catch (e) { if (!onlyIfChanged) toast(e.message); return; }
    const main = document.querySelector('#main');
    if (gen !== keeperView._gen || !main || state.view !== 'keeper' || state.projectId !== project) return;
    if (onlyIfChanged && visHtml(next.innerHTML) === visHtml(main.innerHTML)) return;
    const scroll = main.scrollTop;
    main.replaceChildren(...next.childNodes);
    main.scrollTop = scroll;
  },
};

// ── Takeover ──────────────────────────────────────────────────────────────

/** The three depths: selectable before the start and — a deeper one — once it is done; otherwise disabled, with why. */
function depthChoices(tk, onChoose) {
  const anySelectable = tk.options.some((o) => o.selectable);
  return h('div', { class: 'kp-depths', role: 'radiogroup', 'aria-label': 'Takeover depth' }, ...tk.options.map((o) => {
    const chosen = keeperView._choice === o.depth && o.selectable;
    const mark = o.ran ? h('span', { class: 'tag green' }, 'ran') : tk.phase === 'Under way' && o.chosen ? h('span', { class: 'tag blue' }, 'chosen') : null;
    return h('label', { class: `kp-depth${o.selectable ? '' : ' disabled'}${chosen ? ' selected' : ''}`, 'data-depth': o.depth, title: o.selectable ? '' : o.why ?? '' },
      h('div', { class: 'row' },
        h('input', { type: 'radio', name: 'kp-depth', value: o.depth, disabled: !o.selectable, checked: chosen, onChange: () => { keeperView._choice = o.depth; onChoose(); } }),
        h('b', {}, o.depth), mark),
      h('div', { class: 'muted' }, o.does),
      h('div', { class: 'faint' }, h('span', {}, 'Beyond the first usable picture: '), o.gains),
      !o.selectable && anySelectable && o.why ? h('div', { class: 'faint kp-why' }, o.why) : null);
  }));
}

function startRow(tk, redraw) {
  const choice = tk.options.find((o) => o.depth === keeperView._choice && o.selectable) ?? null;
  const why = !tk.key.usable ? 'No usable key: add a key in Model provider below first.' : !choice ? (tk.phase === 'Done' ? 'Choose a deeper depth to go on from what is done.' : 'Choose a depth.') : null;
  const start = async () => {
    try {
      await api(`/api/projects/${P()}/takeover/start`, { method: 'POST', body: { depth: choice.depth } });
      keeperView._choice = null;
      toast(tk.phase === 'Done' ? `Going on to ${choice.depth}` : `Takeover started: ${choice.depth}`);
      await refreshProject();
      await refreshActivity();
    } catch (e) { toast(e.message); redraw(); }
  };
  return h('div', { class: 'row wrap kp-start-row' },
    h('button', { class: 'btn primary', id: 'kp-start', disabled: Boolean(why), title: why ?? (tk.phase === 'Done' ? `Go on to ${choice.depth} from what is done` : 'Start the takeover at this depth'), onClick: start }, 'Start'),
    why ? h('span', { class: 'faint', id: 'kp-start-why' }, why) : h('span', { class: 'muted' }, tk.phase === 'Done' ? `${choice.depth}: goes on from what is done; nothing already organized is done again.` : `${choice.depth}: the first usable picture comes first, then the Keeper goes on to this depth without asking again.`));
}

function clearButton(redraw) {
  return h('button', { class: 'btn small danger', id: 'kp-clear', title: 'Remove everything the Keeper organized for this project, to choose again. The project’s own files are not touched.', onClick: () => openClearDialog(redraw) }, 'Clear');
}

/** The dialog of `Clear` (§3.7 清空; CKC-13 AC-40): what goes, what stays, and the word DELETE to confirm. */
async function openClearDialog(redraw) {
  let preview;
  try { preview = await api(`/api/projects/${P()}/takeover/clear`); } catch (e) { toast(e.message); return; }
  const word = h('input', { class: 'input', id: 'kp-clear-word', placeholder: 'DELETE', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Type DELETE to confirm' });
  const err = h('small', { class: 'faint', id: 'kp-clear-err' });
  const confirm = h('button', { class: 'btn danger', id: 'kp-clear-confirm', disabled: true }, 'Clear this project');
  word.addEventListener('input', () => { confirm.disabled = word.value !== 'DELETE'; err.textContent = ''; });
  const run = async () => {
    confirm.disabled = true;
    err.textContent = preview.running ? 'Stopping what is running, then clearing…' : 'Clearing…';
    try {
      const r = await api(`/api/projects/${P()}/takeover/clear`, { method: 'POST', body: { confirm: word.value } });
      document.querySelector('#dialog').close();
      keeperView._page = null; keeperView._choice = null;
      folds.clear();
      toast(r.leftBehind?.length ? `Cleared. Could not remove: ${r.leftBehind.join(', ')}` : 'Cleared — the project is not organized');
      await refreshProject();
      await refreshActivity();
    } catch (e) { err.textContent = e.message; confirm.disabled = word.value !== 'DELETE'; }
  };
  confirm.addEventListener('click', run);
  word.addEventListener('keydown', (e) => { if (e.key === 'Enter' && word.value === 'DELETE') run(); });
  openDialog('Clear this project', [h('div', { class: 'stack kp-clear' },
    h('p', {}, 'Everything the Keeper organized for this project is removed, and the project goes back to ', h('b', {}, 'Not organized yet'), ': every depth can be chosen again and nothing runs until you press Start. This cannot be undone.'),
    preview.running ? h('p', { class: 'kp-warn' }, `${plural(preview.running, 'piece')} of Keeper work ${preview.running === 1 ? 'is' : 'are'} under way and will be stopped first.`) : null,
    h('h4', {}, 'Removed'),
    h('table', { class: 'list kp-clear-removed' }, h('tbody', {}, ...preview.removed.map((r) => h('tr', {}, h('td', {}, r.what), h('td', { class: 'kp-num' }, r.count == null ? '' : r.count), h('td', { class: 'faint' }, r.note ?? ''))))),
    h('p', { id: 'kp-clear-owner-only' }, h('b', {}, preview.ownerOnly), preview.ownerOnly === 1 ? ' thing you said only to the Keeper is among them' : ' things you said only to the Keeper are among them', ' — decisions and corrections given in the Keeper conversation or on a note, which the project’s documents do not hold.'),
    h('h4', {}, 'Kept'),
    h('ul', { class: 'kp-list kp-clear-kept' }, ...preview.kept.map((k) => h('li', {}, h('b', {}, k.what), ' — ', k.detail))),
    h('div', { class: 'field' }, h('label', { for: 'kp-clear-word' }, 'Type DELETE to confirm'), word),
    err,
    h('div', { class: 'dialog-foot' }, h('button', { class: 'btn', onClick: () => document.querySelector('#dialog').close() }, 'Cancel'), confirm))]);
  word.focus();
}

/** The round under way, as the page fills in: its steps, the main agent's stage, the lanes and what each answers. */
function progressBlock(tk, summary, redraw) {
  const r = tk.round;
  const cov = summary.coverage?.takeover ?? null;
  const chosen = cov?.options?.find((o) => o.depth === tk.chosen) ?? null;
  // The chosen depth's amount on this project is counted from the organizing plan the first usable round wrote (§3.7).
  const planned = Boolean(cov?.firstUsable?.completedAt) && Boolean(chosen?.toOrganize);
  const failures = summary.coverage?.scopes?.find((s) => s.id === 'project')?.failed ?? [];
  const stepRows = r ? r.steps.filter((s) => s.kind !== 'lane') : [];
  const stopped = r ? r.steps.filter((s) => /stopped|failed/i.test(s.status)) : [];
  const open = (roundId) => openKeeperActivity({ roundId });
  const act = async (jobId, action) => { try { await api(`/api/projects/${P()}/keeper/jobs/${encodeURIComponent(jobId)}/${action}`, { method: 'POST' }); await refreshActivity(); } catch (e) { toast(e.message); } redraw(); };
  const stage = r?.main?.stage ?? null;
  return h('div', { class: 'stack kp-progress', id: 'kp-progress' },
    h('div', { class: 'row wrap' }, h('b', {}, tk.stage ?? 'Starting'),
      r ? h('span', { class: 'muted' }, `Round ${r.number} · ${r.kind}${stage ? ` · main agent in ${STAGE_LABEL[stage] ?? stage}` : ''}`) : h('span', { class: 'muted' }, 'The boundary is drawn and the material read first; the first round starts when that is done.'),
      r && r.status === 'Running' ? h('button', { class: 'btn small', id: 'kp-stop', title: 'Stop this round: what is saved stays, and it can be continued', onClick: async () => { const root = r.rootJobId; try { await api(`/api/projects/${P()}/keeper/jobs/${encodeURIComponent(root)}/stop`, { method: 'POST' }); for (const s of r.steps.filter((x) => /running|queued|paused|waiting/i.test(x.status))) await api(`/api/projects/${P()}/keeper/jobs/${encodeURIComponent(s.jobId)}/stop`, { method: 'POST' }); toast('Stopping the round'); await refreshActivity(); } catch (e) { toast(e.message); } redraw(); } }, 'Stop') : null),
    h('div', { class: 'faint', id: 'kp-so-far' }, `So far: ${fmtWall(tk.total.wallMs)} · ${fmtCost(tk.total.cost)}${tk.total.models.length ? ` · ${tk.total.models.join(', ')}` : ''}`),
    stepRows.length ? h('ol', { class: 'kp-steps' }, ...stepRows.map((s) => h('li', { 'data-step': s.kind },
      h('button', { class: 'text-btn', title: 'Open this round’s tree in Keeper activity', onClick: () => open(r.id) }, STEP_LABEL[s.kind] ?? s.label),
      s.kind === 'main' && stage ? h('span', { class: 'faint' }, ` ${STAGE_LABEL[stage] ?? stage}`) : null, ' ', statusTag(s.status),
      /stopped/i.test(s.status) ? h('button', { class: 'btn small', onClick: () => act(s.jobId, 'continue') }, 'Continue') : /failed/i.test(s.status) ? h('button', { class: 'btn small', onClick: () => act(s.jobId, 'retry') }, 'Retry') : null))) : null,
    r?.lanes?.length ? h('div', {}, h('div', { class: 'muted' }, `${plural(r.lanes.length, 'lane')} sent${lanesAtOnce(r.lanes) > 1 ? `, up to ${lanesAtOnce(r.lanes)} at once` : ''}`),
      h('ul', { class: 'kp-list kp-lanes' }, ...r.lanes.map((l) => h('li', { 'data-lane': l.name }, h('b', {}, l.name), ' ', statusTag(l.status), l.question ? h('div', { class: 'faint kp-lane-q' }, l.question.split('\n')[0]) : null)))) : null,
    chosen && tk.chosen !== 'First picture only' ? h('div', { class: 'muted', id: 'kp-amount' }, planned
      ? `${tk.chosen} on this project: ${chosen.toOrganize} materials to read closely · about ${fmtMinutes(chosen.minutes)} · ${chosen.cost == null ? 'cost not reported' : `about $${chosen.cost.toFixed(2)}`}${cov?.remaining ? ` · remaining: ${cov.remaining.materials} materials, about ${fmtMinutes(cov.remaining.minutes)}` : ''}.${cov?.rates?.basis ? ` Basis: ${cov.rates.basis}.` : ''}`
      : `How much ${tk.chosen} is on this project — the lanes, the materials to read closely, the time and cost — is counted once orientation has written the organizing plan.`) : null,
    tk.waiting.length ? h('div', {}, h('b', {}, 'Waiting for you'), waitingList(tk.waiting)) : null,
    stopped.length || failures.length ? h('div', { class: 'faint' }, `${plural(stopped.length, 'step')} stopped or failed; the round’s tree in Keeper activity says why.`) : null);
}

/** The briefing (§3.7 接手简报; CKC-13 AC-39): five things, each item opening where it lives on the workbench. */
function briefingBlock(b, tk) {
  const w = b.work;
  const planLine = (p) => `${p.done} done · ${p.inProgress} under way · ${p.notStarted} not started${p.onHold ? ` · ${p.onHold} on hold` : ''}`;
  const notRead = b.read.levels.filter((l) => /Indexed|Sampled|Not organized|Skipped/.test(l.level));
  return h('div', { class: 'section kp-briefing', id: 'kp-briefing' },
    h('header', {}, 'Takeover briefing', h('span', { class: 'faint', style: { fontWeight: 400 } }, `as of ${fmtTime(tk.completedAt)}`)),
    h('div', { class: 'content' },
      h('h4', {}, 'What this project is'),
      b.project.text
        ? h('p', { class: 'kp-brief-text' }, b.project.nodeId ? h('button', { class: 'text-btn', onClick: () => goNode(b.project.nodeId, b.project.name) }, b.project.name) : h('b', {}, b.project.name), h('br'), b.project.text)
        : h('p', { class: 'faint' }, 'The takeover recorded no product overview for this project.'),
      h('h4', {}, `Its areas (${b.areas.length})`),
      b.areas.length ? h('ul', { class: 'kp-list' }, ...b.areas.map((a) => h('li', {}, h('button', { class: 'text-btn', onClick: () => goNode(a.nodeId, a.name) }, a.name), a.sentence ? h('div', { class: 'muted' }, a.sentence) : null))) : h('p', { class: 'faint' }, 'No area was established.'),
      h('h4', {}, 'Where the work stands'),
      w.plans.length || w.noPlan.total ? h('table', { class: 'list kp-work' }, h('tbody', {},
        ...w.plans.map((p) => h('tr', {}, h('td', {}, p.nodeId ? h('button', { class: 'text-btn', onClick: () => goNode(p.nodeId, p.name) }, p.name) : p.name, p.progress ? h('span', { class: `tag ${p.progress === 'In progress' ? 'blue' : p.progress === 'Done' ? 'green' : ''}` }, p.progress) : null), h('td', { class: 'muted' }, p.total ? planLine(p) : 'no work item placed under it'))),
        w.noPlan.total ? h('tr', {}, h('td', { class: 'muted' }, 'In no plan'), h('td', { class: 'muted' }, planLine(w.noPlan))) : null)) : h('p', { class: 'faint' }, 'No plan or work item was established.'),
      w.underWay.length ? h('div', {}, h('span', { class: 'muted' }, 'Under way now: '), ...w.underWay.map((t, i) => [i ? ' · ' : null, h('button', { class: 'text-btn', onClick: () => goNode(t.nodeId, t.name) }, t.name)])) : null,
      h('h4', {}, `Waiting for your decision (${b.waiting.length})`),
      b.waiting.length ? waitingList(b.waiting) : h('p', { class: 'faint' }, 'Nothing waits for your decision.'),
      h('h4', {}, 'What was read, and what it cost'),
      h('div', {}, h('b', {}, b.read.depth ?? '—'), b.read.models.length ? ` · ${b.read.models.join(', ')}` : '', ` · ${fmtWall(b.read.total.wallMs)} · ${fmtCost(b.read.total.cost)}`),
      h('table', { class: 'list kp-rounds' }, h('tbody', {}, ...b.read.rounds.map((r) => h('tr', { 'data-round': r.id },
        h('td', {}, h('button', { class: 'text-btn', title: 'Open this round’s tree in Keeper activity', onClick: () => openKeeperActivity({ roundId: r.id }) }, `Round ${r.number} · ${r.kind === 'Deepen' ? `deepening (${r.depth ?? '—'})` : 'first usable picture'}`)),
        h('td', { class: 'muted' }, fmtWall(r.wallMs)), h('td', { class: 'muted' }, fmtCost(r.cost)))))),
      b.read.levels.length ? h('div', { class: 'muted' }, 'Materials by how far they were read: ', b.read.levels.map((l) => `${l.level} ${l.materials}`).join(' · '), '.') : null,
      notRead.length ? h('div', { class: 'faint' }, `Not read closely: ${notRead.map((l) => `${l.materials} ${l.level.toLowerCase()}`).join(', ')} — indexed material is searchable and read when a question needs it; what waits is taken in by the next round.`) : null,
      b.read.missingSourceKinds.length ? h('div', { class: 'faint' }, 'Kinds of source that could not be read: ', b.read.missingSourceKinds.map((m) => `${m.kind} (${m.reason})`).join('; '), '.') : null));
}

function takeoverPage(view, summary, redraw) {
  const tk = view.takeover;
  const cov = summary.coverage?.takeover ?? null;
  // §6.10 第一次用 (CKC-03 AC-36): the key and the model the takeover will run on, and where to change them; without a usable key, add one first.
  const toModel = () => { const el = document.querySelector('#kp-model'); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); (el.querySelector('#kp-add-provider, #kp-main-key'))?.focus({ preventScroll: true }); } };
  const modelId = (tk.key.model ?? '').split('/').slice(1).join('/') || tk.key.model;
  const key = tk.key.usable ? h('span', { title: tk.key.model ?? '' }, h('span', { class: 'tag green' }, 'key usable'), ' The takeover runs on the key ', h('b', {}, tk.key.keyName ?? '—'), ' with the model ', h('b', {}, modelId ?? '—'), tk.key.thinking ? ` · thinking ${tk.key.thinking}` : '', '. ', h('button', { class: 'text-btn', id: 'kp-change-key', onClick: toModel }, 'Change the key or the models'))
    : h('span', {}, h('span', { class: 'tag red' }, 'no usable key'), ' ', tk.key.reason ?? '', ' ', h('button', { class: 'text-btn', id: 'kp-change-key', onClick: toModel }, 'Add a key'));
  const head = tk.phase === 'Not started'
    ? [h('p', { id: 'kp-intro' }, tk.intro), h('div', { id: 'kp-key' }, key)]
    : tk.phase === 'Under way'
      ? [h('div', { class: 'row spread wrap', id: 'kp-ran' }, h('div', {}, h('b', {}, tk.chosen), ` chosen · started ${fmtTime(tk.startedAt)}${tk.total.models.length ? ` · ${tk.total.models.join(', ')}` : tk.key.model ? ` · ${tk.key.model}` : ''}`), clearButton(redraw))]
      : [h('div', { class: 'row spread wrap', id: 'kp-ran' }, h('div', {}, h('b', {}, tk.ran), ` ran · finished ${fmtTime(tk.completedAt)}${tk.total.models.length ? ` · ${tk.total.models.join(', ')}` : ''} · ${fmtWall(tk.total.wallMs)} · ${fmtCost(tk.total.cost)}`), clearButton(redraw))];
  const canChoose = tk.options.some((o) => o.selectable);
  return h('div', { class: 'stack' },
    h('div', { class: 'section', id: 'takeover' }, h('header', {}, 'Takeover'), h('div', { class: 'content' },
      ...head,
      depthChoices(tk, redraw),
      canChoose ? startRow(tk, redraw) : tk.phase === 'Done' ? h('div', { class: 'faint' }, 'To run a shallower depth, or the same one from the beginning, Clear first.') : null,
      tk.phase === 'Under way' ? progressBlock(tk, summary, redraw) : null)),
    tk.phase === 'Done' && tk.briefing ? briefingBlock(tk.briefing, tk) : null,
    tk.phase !== 'Not started' && cov ? fold('kp-reading', readingHead(cov, tk), readingDetails(cov, tk)) : null);
}

// What was read, path by path and level by level: an agent's and an investigator's table, folded (§6.10).
function readingHead(cov, tk) {
  const lanes = isMainAgentRound(tk.round) ? tk.round.lanes?.length ?? 0 : 0;
  const materials = (cov.levels ?? []).reduce((n, l) => n + l.materials, 0);
  return `Reading details — ${lanes ? `${plural(lanes, 'lane')} of the latest round, ` : ''}${plural(materials, 'material')} by organizing level, the estimates of each depth`;
}
function readingDetails(tk, page) {
  const dp = tk.deepening ?? null;
  const round = page.round;
  const byLane = isMainAgentRound(round) ? round : null;
  const pair = (b) => (b.whole || b.part ? `${b.whole} whole · ${b.part} in part` : '—');
  const minutesOf = (l) => (l.startedAt ? Math.round(((l.endedAt ? Date.parse(l.endedAt) : Date.now()) - Date.parse(l.startedAt)) / 60000) : null);
  const optRows = tk.options.map((o) => h('tr', { 'data-depth': o.depth }, h('td', {}, h('b', {}, o.depth)), h('td', {}, o.toOrganize),
    h('td', {}, o.depth === 'First picture only' ? '—' : fmtMinutes(o.minutes)), h('td', {}, o.depth === 'First picture only' ? '—' : o.cost == null ? 'not reported' : `$${o.cost.toFixed(2)}`)));
  const levelRows = (tk.levels ?? []).filter((l) => l.materials > 0).map((l) => h('tr', {}, h('td', {}, l.level), h('td', {}, l.materials), h('td', { class: 'faint' }, kindsText(l.byKind))));
  const ow = tk.firstUsable?.ownerWords ?? null;
  const counted = Boolean(dp?.paths.some((p) => p.basis));
  const act = dp?.actual ?? null;
  return [
    h('div', { class: 'faint' }, `First usable picture: started ${fmtTime(tk.firstUsable.startedAt)}${tk.firstUsable.completedAt ? `, complete ${fmtTime(tk.firstUsable.completedAt)} (${fmtMinutes(tk.firstUsable.minutes)})` : ', not complete yet'} · organized from ${countsText(tk.firstUsable.byKind)}.`),
    ow ? h('div', { class: 'faint' }, `Owner’s words step: ${fmtMinutes(ow.minutes)} · read ${ow.utterances} of ${ow.total} of the owner’s messages in ${plural(ow.calls, 'call')} · wrote ${ow.items} Owner’s words items.`) : null,
    byLane && byLane.lanes?.length ? h('div', {},
      h('h4', {}, `What each lane read — round ${byLane.number}`),
      h('div', { class: 'kp-table-frame' }, h('table', { class: 'list deepening-progress deepening-by-lane' },
        h('thead', {}, h('tr', {}, ...['Lane', 'Answers', 'Slots', 'Status', 'Time', 'Read'].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...byLane.lanes.map((l) => h('tr', { 'data-lane': l.name },
          h('td', {}, l.name), h('td', {}, LANE_KIND_LABEL[l.kind] ?? l.kind), h('td', { class: 'faint' }, l.slots.join(', ') || '—'),
          h('td', {}, statusTag(l.status)), h('td', {}, fmtMinutes(minutesOf(l))), h('td', { class: 'faint lane-read' }, readText(l.read))))))),
      h('div', { class: 'faint' }, h('b', {}, 'Coverage check: '), coverageText(byLane.coverage ?? null))) : null,
    act ? h('div', { class: 'faint as-run' }, `${act.depth}, as it ran: read ${act.whole + act.part} of the ${act.planned} the question list plans — ${act.whole} whole, ${act.part} in part; ${act.left} not read${act.beyond.whole + act.beyond.part ? `; beyond the plan ${pair(act.beyond)}` : ''} · ${fmtMinutes(act.minutes)} · ${act.cost == null ? 'cost not reported' : `$${act.cost.toFixed(2)}`}.`) : null,
    dp?.paths.length ? h('div', {}, h('h4', {}, 'What a Full deepening reads, path by path'),
      h('table', { class: 'list deepening-paths' }, h('thead', {}, h('tr', {}, h('th', {}, 'Path'), h('th', {}, 'Materials by category'), counted ? h('th', {}, 'How it was counted') : null)),
        h('tbody', {}, ...dp.paths.map((p) => h('tr', { 'data-path': p.path }, h('td', {}, p.path), h('td', { class: 'faint' }, p.reads.map((r) => h('div', {}, `${r.count} ${r.category}`))), counted ? h('td', { class: 'faint path-basis' }, p.basis ?? '—') : null)))),
      dp.focused.length ? h('div', { class: 'faint' }, h('b', {}, 'Focused covers: '), dp.focused.map((c) => `${c.count} ${c.category}`).join(' · '), ', with the history they directly involve.') : null) : null,
    h('h4', {}, 'Each depth on this project'),
    h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, 'Depth'), h('th', {}, 'Materials to read closely'), h('th', {}, 'Estimated time'), h('th', {}, 'Estimated cost'))), h('tbody', {}, ...optRows)),
    h('div', { class: 'faint' }, `Estimates: ${tk.rates.basis}.`),
    levelRows.length ? h('h4', {}, 'Organizing levels of all materials') : null,
    levelRows.length ? h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, 'Level'), h('th', {}, 'Materials'), h('th', {}, 'By kind'))), h('tbody', {}, ...levelRows)) : null,
    tk.readInPart?.materials ? h('div', { class: 'faint read-in-part' }, `Read in part: ${plural(tk.readInPart.materials, 'material')} (${kindsText(tk.readInPart.byKind)}) — some of their lines were read, not all.`) : null,
    h('div', { class: 'faint history-not-organized' }, tk.historyNotOrganized ? `Older material not organized: ${tk.historyNotOrganized} — indexed, sampled or waiting for a round; read when a question needs it.` : 'Older material not organized: none.'),
    tk.sampled?.length ? h('div', { class: 'faint' }, `Sampling rules (${tk.sampled.length}): `, tk.sampled.map((g) => g.rule).join('; ')) : null,
  ];
}

// ── Daily ─────────────────────────────────────────────────────────────────

function dailyPage(view, redraw) {
  const d = view.daily;
  const s = d.schedule;
  const timed = (f) => ['Every day', 'On selected days', 'Every N days'].includes(f);
  const frequency = h('select', { class: 'input', id: 'kp-frequency', disabled: !d.available, 'aria-label': 'How often' }, ...d.frequencies.map((f) => h('option', { value: f, selected: s.frequency === f }, f)));
  const time = h('input', { class: 'input', id: 'kp-time', type: 'time', value: s.time, disabled: !d.available, 'aria-label': 'Time of day' });
  const days = h('div', { class: 'row wrap kp-days', id: 'kp-days' }, ...d.dayNames.map((name, i) => h('label', { class: 'kp-day' }, h('input', { type: 'checkbox', value: String(i), checked: (s.days ?? []).includes(i), disabled: !d.available }), name.slice(0, 3))));
  const every = h('input', { class: 'input', id: 'kp-every', type: 'number', min: 1, max: 365, value: s.everyDays ?? 2, disabled: !d.available, 'aria-label': 'Every how many days' });
  const fTime = h('div', { class: 'field' }, h('label', { for: 'kp-time' }, 'Starts at (this machine’s time)'), time);
  const fDays = h('div', { class: 'field' }, h('label', {}, 'On'), days);
  const fEvery = h('div', { class: 'field' }, h('label', { for: 'kp-every' }, 'Every … days'), every);
  const hint = h('span', { class: 'faint', id: 'kp-unsaved' });
  const save = h('button', { class: 'btn primary small', id: 'kp-save', disabled: true }, 'Save');
  const body = () => ({ frequency: frequency.value, time: time.value, days: [...days.querySelectorAll('input:checked')].map((x) => Number(x.value)), everyDays: Number(every.value) });
  const sync = (changed) => {
    fTime.hidden = !timed(frequency.value);
    fDays.hidden = frequency.value !== 'On selected days';
    fEvery.hidden = frequency.value !== 'Every N days';
    if (!changed) return;
    keeperView._dirty = true;
    save.disabled = false;
    hint.textContent = 'Changed, not saved: it has no effect until you Save.';
  };
  for (const el of [frequency, time, every]) el.addEventListener('input', () => sync(true));
  days.addEventListener('change', () => sync(true));
  save.addEventListener('click', async () => {
    try {
      await api(`/api/projects/${P()}/keeper/schedule`, { method: 'POST', body: body() });
      keeperView._dirty = false;
      toast('Schedule saved');
      await refreshProject();
    } catch (e) { hint.textContent = e.message; }
  });
  sync(false);
  const followUp = async () => {
    try {
      const r = await api(`/api/projects/${P()}/keeper/follow-up`, { method: 'POST' });
      toast(r?.queued ? `Follow up: organizing ${plural(r.queued, 'material')}` : 'Follow up: nothing has changed since the last round');
      await refreshActivity();
    } catch (e) { toast(`Follow up: ${e.message}`); }
    redraw();
  };
  const last = d.lastRound;
  const startedBy = last ? (last.kind !== 'Follow up' ? 'the takeover' : last.startedBy === 'owner' ? 'you pressed Follow up' : last.startedBy === 'schedule' ? 'the schedule started it' : last.startedBy === 'continuous' ? 'started by Continuous' : null) : null;
  const slot = d.lastTime;
  const status = h('div', { class: 'kp-status', id: 'kp-daily-status' },
    d.running ? h('div', {}, statusTag('Running'), ` Round ${d.running.number} · ${d.running.kind} · started ${fmtRel(d.running.startedAt)}. `, h('button', { class: 'text-btn', onClick: () => openKeeperActivity({ roundId: d.running.id }) }, 'Open it in Keeper activity')) : null,
    last ? h('div', {}, h('span', { class: 'muted' }, 'Last round: '), `round ${last.number} (${last.kind}) finished ${fmtTime(last.endedAt)}${startedBy ? ` — ${startedBy}` : ''}. `,
      last.nothingNew === true ? 'It found nothing new. ' : last.statement ? `${last.statement}. ` : '',
      last.resultId ? h('button', { class: 'text-btn', id: 'kp-last-result', onClick: async () => { const { openRound } = await import('./views.js'); openRound(last.resultId); } }, 'Open its result') : h('button', { class: 'text-btn', onClick: () => openKeeperActivity({ roundId: last.id }) }, 'Open it in Keeper activity')) : h('div', { class: 'faint' }, 'No round has finished yet.'),
    slot && slot.outcome !== 'round' ? h('div', { class: 'faint', id: 'kp-last-time' }, slot.outcome === 'nothing changed' ? `At the scheduled time ${fmtTime(slot.slot)} nothing had changed, so no round ran.` : `The scheduled time ${fmtTime(slot.slot)} came while a round was running, so no second round started; what changed waits for the next one.`) : null,
    h('div', {}, h('b', {}, d.pending), ` change${d.pending === 1 ? '' : 's'} waiting for the next round.`, d.paused ? h('span', { class: 'tag amber', style: { marginLeft: '8px' } }, 'Organizing paused') : null,
      d.paused ? h('span', { class: 'faint' }, ' Scheduled rounds do not start while paused; Follow up still runs.') : null));
  return h('div', { class: 'stack' },
    !d.available ? h('div', { class: 'section', id: 'kp-daily-unavailable' }, h('div', { class: 'content' }, h('div', {}, d.why), h('div', {}, h('button', { class: 'btn small', onClick: () => { keeperView._page = 'takeover'; if (state.routeRest) navigate(state.projectId, 'keeper'); else redraw(); } }, 'Open the Takeover page')))) : null,
    h('div', { class: `section${d.available ? '' : ' kp-disabled'}`, id: 'kp-schedule' }, h('header', {}, 'Schedule'), h('div', { class: 'content' },
      h('div', { class: 'row wrap kp-schedule-row' }, h('div', { class: 'field' }, h('label', { for: 'kp-frequency' }, 'How often'), frequency), fTime, fDays, fEvery, save),
      hint,
      d.available ? h('div', { class: 'muted', id: 'kp-next' }, h('span', {}, 'In force: '), h('b', {}, d.scheduleText), s.savedAt ? '' : ' (not changed since the takeover)', ' · ',
        d.paused ? 'no scheduled round while organizing is paused' : d.nextAt ? ['next: ', h('b', {}, fmtTime(d.nextAt))] : s.frequency === 'Off' ? 'no round starts by itself' : 'a round follows each stretch of work') : null,
      h('div', { class: 'faint' }, 'At the scheduled time a round starts when something changed since the last one. A time missed while ProjectKeeper was not running is made up for with one round.'))),
    h('div', { class: `section${d.available ? '' : ' kp-disabled'}`, id: 'kp-follow-up' }, h('div', { class: 'content' },
      h('div', { class: 'row wrap' }, h('button', { class: 'btn', id: 'kp-follow-up-btn', disabled: !d.available || Boolean(d.running), title: d.running ? 'A round is already running' : 'Organize what changed since the last round, now', onClick: followUp }, '↻ Follow up'),
        h('span', { class: 'muted' }, 'Organize what changed since the last round now, without waiting for the schedule.')),
      d.available ? status : null,
      h('div', { class: 'faint' }, 'Earlier rounds are in ', h('button', { class: 'text-btn', onClick: () => openKeeperActivity() }, 'Keeper activity'), '.'))));
}

// ── the settings blocks, under both pages (§6.10 设置区块) ──────────────────

/**
 * How an execution agent reaches this project by itself (Spec §6.10, §7.10): the same lines the context pack gives in
 * `Explore further`, so what the owner copies to an agent works as written.
 */
function agentUsageBlock(lines) {
  if (!lines?.length) return null;   // an older server without the entry: nothing to show
  const text = lines.map((l) => `- ${l}`).join('\n');
  return h('div', { class: 'stack' },
    h('div', {}, h('b', {}, 'An agent can reach this project by itself'), h('span', { class: 'muted' }, ' — from a terminal in the project, without you passing anything on:')),
    h('ul', {}, ...lines.map((l) => h('li', { class: 'muted' }, l))),
    h('div', {}, h('button', { class: 'btn small', onClick: async () => { try { await navigator.clipboard.writeText(text); toast('Usage copied — paste it to an agent'); } catch { openDialog('Copy the usage', [h('textarea', { class: 'input', style: { minHeight: '30vh' } }, text)]); } } }, 'Copy for an agent')));
}

function settingsBlocks(c, view, { keyFirst, mpv, usageRounds, usageLines, redraw }) {
  const ka = c.keeperAgent;
  const status = ka.status;
  // ── Keeper agent: who it is and its state are open; the capability table and the loaded resources are an agent's
  // matter and folded. What the owner must know stands on the fold's head.
  const untrusted = ka.projectTrusted === false;
  const changed = ka.resourceChanges?.length ?? 0;
  const agentNote = [untrusted ? 'project-local pi resources are not loaded: the project is not trusted in pi' : null, changed ? `${plural(changed, 'change')} to project content during autonomous work` : null, ka.resourcesError ? 'resources could not be listed' : null].filter(Boolean).join(' · ') || null;
  const agent = h('div', { class: 'section', id: 'kp-agent' },
    h('header', {}, 'Keeper agent', h('span', { class: `tag ${status === 'Idle' || status === 'Working' || status === 'Working on your request' ? 'green' : status === 'Not connected' || status === 'Unavailable' ? 'red' : 'amber'}` }, status)),
    h('div', { class: 'content' },
      h('div', { class: 'row spread' }, h('div', {}, h('b', {}, ka.name), h('div', { class: 'muted' }, ka.reason || ka.detail || 'Full pi with the resources it loads in this project directory'), ka.trustDecision ? h('div', { class: 'faint' }, `Project trust in pi: ${ka.trustDecision}`) : null),
        h('button', { class: 'btn small', onClick: async () => { const r = await api(`/api/projects/${P()}/keeper/open-in-pi`, { method: 'POST' }); toast(r.message); } }, 'Open in pi')),
      fold('kp-agent-details', `Capabilities (${ka.capabilities.length}) and resources loaded in this project (${ka.resources.length})`, [
        h('h4', {}, 'Capabilities'), ka.capabilities.length ? h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, 'Capability'), h('th', {}, 'In the workbench'), h('th', {}, 'In pi'), h('th', {}, 'Availability'))), h('tbody', {}, ...ka.capabilities.map((x) => h('tr', {}, h('td', {}, x.name, x.source ? h('small', {}, ` · via ${x.source}`) : null), h('td', {}, x.workbench), h('td', {}, x.native), h('td', {}, h('span', { class: `tag ${x.available ? 'green' : ''}` }, x.available ? 'Available' : 'Not provided by this agent'), x.affects ? h('small', {}, ` ${x.affects}`) : null))))) : h('div', { class: 'faint' }, 'The capability table appears once the Keeper runtime is attached.'),
        h('h4', {}, 'Resources loaded in this project'), ka.resources.length ? h('ul', {}, ...ka.resources.map((r) => h('li', {}, h('span', { class: 'tag' }, r.kind), ' ', r.name, r.path ? h('small', { class: 'mono' }, ` ${r.path}`) : null))) : h('div', { class: 'faint' }, untrusted ? 'Project-local pi resources are not loaded because the project is not trusted in pi. Trust it in pi (/trust) to load them.' : 'No resources listed yet.'),
        ka.resourcesError ? h('div', { class: 'faint' }, `Resources could not be listed: ${ka.resourcesError}`) : null,
        changed ? h('div', {}, h('h4', {}, 'Project content changed during autonomous Keeper work'), ...ka.resourceChanges.map((r) => h('div', {}, h('small', { class: 'faint' }, fmtTime(r.at)), ' ', r.detail))) : null,
      ], { note: agentNote })));

  // ── Model provider (§6.10 key、模型与路由): the keys, this project's route — the main model, each step's model, the
  // backups in order — and each key's jobs at once are open (they are what the owner chooses before Start); the record of
  // switches is folded.
  const provider = modelProviderBlock(mpv, redraw);

  // ── Usage: the totals and each round split by model are open (CKC-03 AC-37); the usage of each piece of work is folded.
  const u = c.usage;
  const before = view.usageBeforeClear;
  const usage = h('div', { class: 'section', id: 'kp-usage' }, h('header', {}, 'Usage'), h('div', { class: 'content', id: 'kp-usage-content' },
    u.total ? h('div', { id: 'kp-usage-total' }, h('b', {}, 'In all: '), `input ${fmtTokens(u.total.input)} · output ${fmtTokens(u.total.output)} · cache read ${fmtTokens(u.total.cacheRead)} · cost ${u.total.cost == null ? 'not reported' : '$' + u.total.cost.toFixed(2)}`, u.quota ? h('div', { class: 'muted' }, u.quota) : null) : h('div', { class: 'faint' }, 'No usage reported yet.'),
    before ? h('div', { class: 'muted', id: 'kp-usage-before' }, `Before the last clear (${fmtTime(before.clearedAt)}${before.times > 1 ? `, ${before.times} clears in all` : ''}): input ${before.usage.input} · output ${before.usage.output} · cost ${before.usage.cost == null ? 'not reported' : '$' + before.usage.cost.toFixed(4)}`) : null,
    roundsUsage(usageRounds),
    fold('kp-usage-jobs', `Usage of each piece of work (${u.byJob?.length ?? 0})`, u.byJob?.length ? [h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, 'Work'), h('th', {}, 'Started'), h('th', {}, 'Model'), h('th', {}, 'Input'), h('th', {}, 'Output'), h('th', {}, 'Cost'))), h('tbody', {}, ...u.byJob.map((j) => h('tr', {}, h('td', {}, `${j.kind} · ${j.label}`), h('td', {}, fmtTime(j.startedAt)), h('td', { class: 'faint' }, j.model ?? '—'), h('td', {}, j.usage.input), h('td', {}, j.usage.output), h('td', {}, j.usage.cost == null ? '—' : `$${j.usage.cost.toFixed(4)}`)))))] : [h('div', { class: 'faint' }, 'No piece of work has run yet.')])));

  // ── Project memory and execution-agent access: nothing here is a daily decision; both are folded whole.
  const memory = fold('kp-memory', 'Project memory belongs to ProjectKeeper — what is kept when the Keeper agent changes', [
    h('div', {}, 'Kept when the Keeper agent changes: ', c.memory.keeps.join(', '), '.'), h('div', { class: 'muted' }, 'Not promised: ', c.memory.doesNotPromise, '.'),
    h('button', { class: 'text-btn', onClick: () => navigate(state.projectId, 'graph') }, 'Back to the same project')]);
  const hosts = c.executionAgents.connected.length;
  const access = fold('kp-access', `Execution-agent access — ${hosts ? `${plural(hosts, 'host')} connected` : 'no host connected yet'} · how an agent reaches this project by itself`, [
    hosts ? h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, 'Host'), h('th', {}, 'Status'))), h('tbody', {}, ...c.executionAgents.connected.map((x) => h('tr', {}, h('td', {}, x.host), h('td', {}, x.status))))) : h('div', {}, h('b', {}, 'None connected yet.')),
    h('p', { class: 'muted' }, c.executionAgents.note, ' The session sources the Keeper reads are listed in Project scope.'),
    agentUsageBlock(usageLines)]);
  // ── Project folder (§1.14): the one thing the Keeper may write inside the project, and only on the owner's word. It is
  // the owner's decision, so it is open: what it allows, whether it stands, and the control to give or withdraw it.
  const folder = projectFolderBlock(view.projectFolder, redraw);
  // Before the first Start the key and the model are what the owner chooses first, so that block comes first.
  return keyFirst ? [provider, folder, agent, usage, memory, access] : [agent, provider, folder, usage, memory, access];
}

/** The project-folder authorization: one sentence on what it allows, its state, and `Authorize…` or `Withdraw`. */
function projectFolderBlock(pf, redraw) {
  if (!pf) return null;   // an older server without the state: nothing to show
  const s = folderStatus(pf, { time: fmtTime, rel: fmtRel });
  const withdraw = async () => {
    try {
      await api(`/api/projects/${P()}/authorizations/${encodeURIComponent(pf.authorizationId)}/revoke`, { method: 'POST' });
      toast('Withdrawn: the Keeper no longer writes the folder. What it wrote stays in the project.');
      await refreshProject();
    } catch (e) { toast(e.message); }
    redraw();
  };
  return h('div', { class: 'section', id: 'kp-folder', 'data-granted': pf.granted ? 'yes' : 'no' },
    h('header', {}, 'Project folder', h('span', { class: `tag ${s.tone}`, id: 'kp-folder-state' }, s.tag)),
    h('div', { class: 'content' },
      h('div', { class: 'row spread wrap kp-folder-row' },
        h('div', { class: 'stack kp-folder-text' },
          h('div', { id: 'kp-folder-allows' }, pf.allows),
          ...s.lines.map((line, i) => h('div', { class: i === 0 && pf.granted ? 'mono' : 'muted' }, line))),
        s.action === 'withdraw'
          ? h('button', { class: 'btn small danger', id: 'kp-folder-withdraw', title: 'The Keeper stops writing the folder. The folder and its commits stay in the project.', onClick: withdraw }, 'Withdraw')
          : h('button', { class: 'btn small', id: 'kp-folder-grant', title: 'Choose the folder and whether the Keeper commits it, then authorize', onClick: () => openGrantFolder(pf, redraw) }, 'Authorize…'))));
}

/** The dialog of `Authorize…`: the sentence again, the folder's name, whether the Keeper commits it, and the grant. */
function openGrantFolder(pf, redraw) {
  const name = h('input', { class: 'input', id: 'kp-folder-name', value: pf.usual, autocomplete: 'off', spellcheck: 'false' });
  const commits = h('input', { type: 'checkbox', id: 'kp-folder-commits', checked: true });
  const err = h('small', { class: 'faint', id: 'kp-folder-err' });
  const confirm = h('button', { class: 'btn primary', id: 'kp-folder-confirm' }, 'Authorize');
  const run = async () => {
    const folder = name.value.trim();
    if (!folder) { err.textContent = 'Name the folder.'; return; }
    confirm.disabled = true;
    err.textContent = 'Writing the folder…';
    try {
      const r = await api(`/api/projects/${P()}/authorizations/project-folder`, { method: 'POST', body: { path: folder, commits: commits.checked, quote: grantWords({ folder, commits: commits.checked }) } });
      document.querySelector('#dialog').close();
      toast(grantOutcome(r.sync));
      await refreshProject();
      redraw();
    } catch (e) { err.textContent = e.message; confirm.disabled = false; }
  };
  confirm.addEventListener('click', run);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  openDialog('Authorize the project folder', [h('div', { class: 'stack kp-folder-grant' },
    h('p', {}, pf.allows),
    h('div', { class: 'field' }, h('label', { for: 'kp-folder-name' }, 'Folder, relative to the project’s root'), name),
    h('label', { class: 'chk' }, commits, ' The Keeper commits the folder itself — each commit contains only this folder and is never pushed. Unticked, it only writes the files and they appear as uncommitted changes.'),
    h('p', { class: 'muted' }, 'The folder is written now, from what is organized so far, and again after each round. It holds four files: a README, the meaning changes recognised in your documents, the numbers the Keeper gave to things your project left unnumbered, and the decisions it distilled. You can withdraw the authorization here at any time; what was written stays in the project.'),
    err,
    h('div', { class: 'dialog-foot' }, h('button', { class: 'btn', onClick: () => document.querySelector('#dialog').close() }, 'Cancel'), confirm))]);
  name.focus();
  name.select();
}

const STEP_NAMES = STEP_LABEL;
const fmtTokens = (n) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n));
const KEY_TAG = { Usable: 'green', Refused: 'red', 'Out of quota': 'red', 'Rate-limited': 'amber', 'Could not check': 'amber', 'No credentials': '' };
const keyLabel = (mpv, id) => mpv?.keys.find((k) => k.id === id)?.name ?? id;
const isUsable = (k) => k.state.status === 'Usable' || k.state.status === 'Rate-limited';
/** After a key or the route changed: the Keeper's status (left rail, dock) is read again with the page. */
const afterKeys = (redraw) => { void refreshActivity().catch(() => undefined); redraw(); };

/**
 * `Model provider` (Spec §6.10 key、模型与路由; CKC-03 AC-33～AC-36): the keys of this machine — the owner's own, saved
 * here and shown only masked, and those configured outside, saying where they come from — each with its state, the jobs
 * it carries and how many it runs at once; then this project's route: the main model, each step's model or whom it
 * follows, the backups in order. Changes apply to the steps that start afterwards.
 */
function modelProviderBlock(mpv, redraw) {
  if (!mpv) {
    return h('div', { class: 'section', id: 'kp-model' }, h('header', {}, 'Model provider'), h('div', { class: 'content', id: 'kp-model-content' }, h('div', { class: 'faint' }, 'The keys and routes could not be read from this server.')));
  }
  const usableKeys = mpv.keys.filter(isUsable);
  const unusable = mpv.keys.filter((k) => !isUsable(k) && k.state.status !== 'No credentials');
  const head = usableKeys.length
    ? h('span', { class: 'tag green' }, `${plural(usableKeys.length, 'usable key')}`)
    : h('span', { class: 'tag red' }, 'no usable key');
  return h('div', { class: 'section', id: 'kp-model' },
    h('header', {}, 'Model provider', head, unusable.length ? h('span', { class: 'tag amber' }, `${plural(unusable.length, 'key')} not usable now`) : null),
    h('div', { class: 'content', id: 'kp-model-content' },
      h('h4', {}, 'Keys on this machine'),
      keysTable(mpv, redraw),
      addKeyRow(mpv, redraw),
      h('div', { class: 'faint' }, 'A key you save is kept on this machine in ProjectKeeper’s own settings, not in any project, and is never shown again — only masked. Any project can use it. Keys set outside ProjectKeeper (an environment variable, pi’s own login) are listed too and are used the same way.'),
      routeBlock(mpv, redraw),
      fold('kp-switches', `Switches between keys (${mpv.switches?.length ?? 0})`, mpv.switches?.length ? mpv.switches.map((s) => h('div', { class: 'faint' }, `${fmtTime(s.at)} · ${s.from} → ${s.to}: ${s.reason}`)) : [h('div', { class: 'faint' }, 'No switch between keys has happened in this run.')])));
}

function keyStateCell(k) {
  const s = k.state;
  const tag = h('span', { class: `tag ${KEY_TAG[s.status] ?? ''}`, 'data-key-state': s.status }, s.status);
  const lines = [];
  if (s.status === 'Out of quota' && s.until) lines.push(`back ${fmtTime(s.until)}`);
  if (s.reason) lines.push(s.reason);
  lines.push(s.quotaReported ? (s.quota ?? 'quota: press Check to read it') : 'this provider does not report quota');
  if (s.checkedAt) lines.push(`checked ${fmtRel(s.checkedAt)} (${s.how})`);
  return h('td', { class: 'kp-key-state' }, tag, ...lines.map((l) => h('div', { class: 'faint' }, l)));
}

function keysTable(mpv, redraw) {
  if (!mpv.keys.length) return h('div', { class: 'kp-warn', id: 'kp-no-keys' }, 'No key yet. Add one below: choose the provider, paste the key, Save. Start stays off until a key can be used.');
  const act = async (fn, done) => { try { const r = await fn(); if (done) toast(done(r)); } catch (e) { toast(e.message); } afterKeys(redraw); };
  const lanesInput = (k) => {
    const input = h('input', { class: 'input small kp-key-lanes', type: 'number', min: 1, max: 32, value: k.lanes, title: k.ownLanes ? 'Set for this key' : 'The setting for every key', 'aria-label': `Jobs at once on ${k.name}` });
    input.addEventListener('change', () => act(() => api(`/api/keys/${encodeURIComponent(k.id)}/lanes`, { method: 'POST', body: { lanes: Number(input.value) } }), (r) => `${k.name}: up to ${r.lanes} at once`));
    return input;
  };
  return h('div', { class: 'kp-table-frame' }, h('table', { class: 'list kp-keys', id: 'kp-keys' },
    h('thead', {}, h('tr', {}, ...['Key', 'Provider', 'Value', 'From', 'State', 'Jobs now', 'At once', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, ...mpv.keys.map((k) => h('tr', { 'data-key': k.id },
      h('td', {}, h('b', {}, k.name)),
      h('td', {}, k.providerName, h('div', { class: 'faint mono' }, k.provider)),
      h('td', { class: 'mono kp-mask' }, k.mask ?? '—'),
      h('td', { class: 'faint' }, k.fromDetail),
      keyStateCell(k),
      h('td', { class: 'kp-num' }, k.running),
      h('td', {}, lanesInput(k)),
      h('td', { class: 'kp-key-actions' },
        h('button', { class: 'btn small', 'data-act': 'check', title: 'Ask the provider whether this key works: one request of one output token', onClick: (e) => { e.target.disabled = true; e.target.textContent = 'Checking…'; act(() => api(`/api/keys/${encodeURIComponent(k.id)}/check`, { method: 'POST' }), (r) => `${k.name}: ${r.check.status}${r.check.reason ? ` — ${r.check.reason}` : ''}`); } }, 'Check'),
        k.removable ? h('button', { class: 'btn small', 'data-act': 'replace', title: 'Paste a new value for this key', onClick: () => openReplaceKey(k, redraw) }, 'Replace') : null,
        k.removable ? h('button', { class: 'btn small danger', 'data-act': 'remove', title: 'Remove this key from this machine; work on it moves to the next key of each route', onClick: () => openRemoveKey(k, redraw) }, 'Remove') : null))))));
}

function openReplaceKey(k, redraw) {
  const value = h('input', { class: 'input', type: 'password', id: 'kp-replace-value', autocomplete: 'off', spellcheck: 'false', placeholder: 'the new key' });
  const name = h('input', { class: 'input', id: 'kp-replace-name', value: k.name });
  const err = h('small', { class: 'faint' });
  const save = h('button', { class: 'btn primary', id: 'kp-replace-save' }, 'Save');
  save.addEventListener('click', async () => {
    save.disabled = true; err.textContent = 'Saving and checking…';
    try {
      const r = await api(`/api/keys/${encodeURIComponent(k.id)}`, { method: 'POST', body: { key: value.value, name: name.value } });
      value.value = '';
      document.querySelector('#dialog').close();
      toast(`${r.key.name} saved${r.check ? ` · ${r.check.status}` : ''}`);
      afterKeys(redraw);
    } catch (e) { err.textContent = e.message; save.disabled = false; }
  });
  openDialog(`Replace ${k.name}`, [h('div', { class: 'stack' },
    h('div', { class: 'field' }, h('label', { for: 'kp-replace-name' }, 'Name'), name),
    h('div', { class: 'field' }, h('label', { for: 'kp-replace-value' }, 'New key (leave empty to rename only)'), value),
    err, h('div', { class: 'dialog-foot' }, h('button', { class: 'btn', onClick: () => document.querySelector('#dialog').close() }, 'Cancel'), save))]);
  value.focus();
}

function openRemoveKey(k, redraw) {
  const err = h('small', { class: 'faint' });
  const go = h('button', { class: 'btn danger', id: 'kp-remove-confirm' }, 'Remove the key');
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const r = await api(`/api/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
      document.querySelector('#dialog').close();
      toast(`Removed ${k.name}${r.rerouted ? ` · ${plural(r.rerouted, 'job')} moved on to the next key` : ''}`);
      afterKeys(redraw);
    } catch (e) { err.textContent = e.message; go.disabled = false; }
  });
  openDialog(`Remove ${k.name}`, [h('div', { class: 'stack' },
    h('p', {}, 'The key is removed from this machine. ', k.running ? `The ${plural(k.running, 'job')} running on it ${k.running === 1 ? 'goes' : 'go'} on, in ${k.running === 1 ? 'its' : 'their'} own session, on the next usable key of ${k.running === 1 ? 'its' : 'their'} project’s order; with none left, ${k.running === 1 ? 'it waits' : 'they wait'} and say${k.running === 1 ? 's' : ''} why.` : 'No work runs on it now.', ' A project whose route names it passes over it to its next key.'),
    err, h('div', { class: 'dialog-foot' }, h('button', { class: 'btn', onClick: () => document.querySelector('#dialog').close() }, 'Cancel'), go))]);
}

function addKeyRow(mpv, redraw) {
  const prov = h('select', { class: 'input', id: 'kp-add-provider', 'aria-label': 'Provider' }, h('option', { value: '' }, 'Choose the provider'), ...mpv.providers.map((p) => h('option', { value: p.id }, p.name === p.id ? p.id : `${p.name} (${p.id})`)));
  const name = h('input', { class: 'input', id: 'kp-add-name', placeholder: 'a name (optional)', autocomplete: 'off' });
  const value = h('input', { class: 'input', id: 'kp-add-key', type: 'password', placeholder: 'paste the key', autocomplete: 'off', spellcheck: 'false' });
  const save = h('button', { class: 'btn primary small', id: 'kp-add-save' }, 'Save');
  const note = h('span', { class: 'faint', id: 'kp-add-note' });
  save.addEventListener('click', async () => {
    if (!prov.value) { note.textContent = 'Choose the provider the key is for.'; return; }
    save.disabled = true; note.textContent = 'Saving and checking…';
    try {
      const r = await api('/api/keys', { method: 'POST', body: { provider: prov.value, name: name.value, key: value.value } });
      value.value = '';
      toast(`${r.key.name} saved · ${r.check.status}${r.check.reason ? ` — ${r.check.reason}` : ''}`);
      afterKeys(redraw);
    } catch (e) { note.textContent = e.message; save.disabled = false; }
  });
  return h('div', { class: 'row wrap kp-add-key', id: 'kp-add-key-row' },
    h('div', { class: 'field' }, h('label', { for: 'kp-add-provider' }, 'Add a key — provider'), prov),
    h('div', { class: 'field' }, h('label', { for: 'kp-add-name' }, 'Name'), name),
    h('div', { class: 'field grow' }, h('label', { for: 'kp-add-key' }, 'Key'), value),
    save, note);
}

/** The models a key carries, for a select. */
const modelOptions = (key, selected) => (key?.models ?? []).map((m) => h('option', { value: m.id, selected: m.id === selected }, `${m.id}${m.priced ? '' : ' (no price reported)'}`));
const thinkingOptions = (levels, selected, first = null) => [first ? h('option', { value: '', selected: !selected }, first) : null, ...levels.map((t) => h('option', { value: t, selected: selected === t }, t))];

/** This project's route (§6.10 每一步用哪个模型, 备用与并行). */
function routeBlock(mpv, redraw) {
  const r = mpv.route;
  const usable = mpv.keys.filter(isUsable);
  const post = async (body, done) => { try { await api(`/api/projects/${P()}/route`, { method: 'POST', body }); toast(done); } catch (e) { toast(e.message); } afterKeys(redraw); };
  // ── the main model: a key, one of its models, how hard it thinks.
  const mainKeyId = r.main?.provider ?? '';
  // The empty choice only while no key is set: with one, the select holds that key and nothing reads as "Choose a key".
  const keySel = h('select', { class: 'input', id: 'kp-main-key', 'aria-label': 'Key' }, mainKeyId ? null : h('option', { value: '' }, usable.length ? 'Choose a key' : 'No usable key'),
    ...mpv.keys.filter((k) => isUsable(k) || k.id === mainKeyId).map((k) => h('option', { value: k.id, selected: k.id === mainKeyId }, `${k.name}${isUsable(k) ? '' : ` (${k.state.status.toLowerCase()})`}`)));
  const modelSel = h('select', { class: 'input', id: 'kp-main-model', 'aria-label': 'Model' }, ...modelOptions(mpv.keys.find((k) => k.id === mainKeyId), r.main?.id));
  keySel.addEventListener('change', () => {
    const k = mpv.keys.find((x) => x.id === keySel.value);
    const keep = modelSel.value;
    modelSel.replaceChildren(...modelOptions(k, k?.models.some((m) => m.id === keep) ? keep : null));
  });
  const thinkSel = h('select', { class: 'input', id: 'kp-main-thinking', 'aria-label': 'Thinking' }, ...thinkingOptions(mpv.thinking, r.main?.thinking ?? 'medium'));
  // A key that sits in a lower row of the key order changes places with the main key, as that list's own select does (CY; key-order.js `mainChosen`); any other key replaces it.
  const use = h('button', { class: 'btn small primary', id: 'kp-main-use', onClick: () => { if (!keySel.value || !modelSel.value) { toast('Choose a key and a model'); return; } const swapped = mainChosen(orderRows(r).map((b) => ({ provider: b.provider, id: b.id, thinking: b.thinking ?? null })), mpv.keys.find((k) => k.id === keySel.value), modelSel.value, r.main?.id); post(swapped ? orderBody(swapped, thinkSel.value) : { model: { provider: keySel.value, id: modelSel.value, thinking: thinkSel.value } }, `Main model: ${keyLabel(mpv, keySel.value)} · ${modelSel.value} — the steps that follow it change with it`); } }, 'Use');
  const mainKey = r.main ? mpv.keys.find((k) => k.id === r.main.provider) : null;
  const mainWarn = r.main && !r.main.usable ? h('div', { class: 'kp-warn', id: 'kp-main-warn' }, `${r.main.keyName} cannot be used now (${mainKey ? mainKey.state.status.toLowerCase() : 'removed'}): ${mpv.fallback ? `${mpv.fallback.keyName} · ${mpv.fallback.id} stands in` : 'no other key can stand in'}. Choose another key, or add one.`) : null;
  return h('div', { class: 'stack kp-route', id: 'kp-route' },
    h('h4', {}, 'This project runs on', h('span', { class: 'faint', style: { fontWeight: 400 } }, r.own ? ' — set for this project' : ' — the machine’s settings, until you change them here')),
    h('div', { class: 'row wrap kp-main-row' },
      h('div', { class: 'field' }, h('label', { for: 'kp-main-key' }, 'Main model — key'), keySel),
      h('div', { class: 'field grow' }, h('label', { for: 'kp-main-model' }, 'Model'), modelSel),
      h('div', { class: 'field' }, h('label', { for: 'kp-main-thinking' }, 'Thinking'), thinkSel), use),
    h('div', { class: 'faint' }, 'Your conversation and requests run on the main model, and so does every step below that follows it.'),
    mainWarn,
    stepsTable(mpv, post),
    backupsBlock(mpv, post),
    lanesLine(mpv),
    h('div', { class: 'faint' }, 'A change applies to the steps that start after it; a step already running is not interrupted.'));
}

/** Each step of a round: its own model and thinking, or whom it follows (CKC-03 AC-29). Only models of usable keys are offered. */
function stepsTable(mpv, post) {
  const r = mpv.route;
  // Whom a step follows when it has no model of its own — said in the select's first option even while it has one.
  const followText = (s) => {
    const whom = s.followsWhom ?? 'main model';
    const model = s.followsModel ?? (whom === 'main model' ? r.main?.id : null);
    return whom === 'main model' ? `follows the main model (${model ?? 'none chosen'})` : `follows ${STEP_NAMES[whom] ?? whom} (${model ?? '—'})`;
  };
  const byProvider = new Map();
  for (const o of mpv.offered) { if (!byProvider.has(o.provider)) byProvider.set(o.provider, { name: o.providerName, models: [] }); byProvider.get(o.provider).models.push(o); }
  return h('div', { id: 'steps-settings' },
    h('h5', {}, 'Each step of a round'),
    h('table', { class: 'list kp-steps-route' }, h('thead', {}, h('tr', {}, h('th', {}, 'Step'), h('th', {}, 'Model'), h('th', {}, 'Thinking'))),
      h('tbody', {}, ...r.steps.map((s) => {
        const own = s.own;
        const ownValue = own?.model ? s.place ?? `${own.provider ?? ''}|${own.model}` : '';
        const modelSel = h('select', { class: 'input small', 'aria-label': `Model of ${STEP_NAMES[s.kind] ?? s.kind}` },
          h('option', { value: '', selected: !own?.model }, `— ${followText(s)}`),
          ...[...byProvider.entries()].map(([prov, g]) => h('optgroup', { label: g.name === prov ? prov : `${g.name} (${prov})` },
            ...g.models.map((o) => h('option', { value: `${prov}|${o.model}`, selected: ownValue === `${prov}|${o.model}` }, `${o.model} · ${o.keys.length === 1 ? o.keys[0] : `${o.keys.length} keys`}`)))));
        // A step set to a model no usable key carries now still shows what it is set to.
        if (own?.model && ![...modelSel.querySelectorAll('option')].some((o) => o.value === ownValue)) modelSel.append(h('option', { value: ownValue, selected: true }, `${own.model} (no usable key carries it now)`));
        const thinkSel = h('select', { class: 'input small', 'aria-label': `Thinking of ${STEP_NAMES[s.kind] ?? s.kind}` }, ...thinkingOptions(mpv.thinking, own?.thinking ?? null, `— as it follows (${s.thinking ?? 'medium'})`));
        const save = () => {
          const [prov, model] = modelSel.value ? modelSel.value.split('|') : [null, null];
          const value = model || thinkSel.value ? { ...(model ? { provider: prov, model } : {}), ...(thinkSel.value ? { thinking: thinkSel.value } : {}) } : null;
          post({ steps: { [s.kind]: value } }, value ? `${STEP_NAMES[s.kind] ?? s.kind}: ${model ?? 'as it follows'} · thinking ${thinkSel.value || 'as it follows'}` : `${STEP_NAMES[s.kind] ?? s.kind}: follows again`);
        };
        modelSel.addEventListener('change', save);
        thinkSel.addEventListener('change', save);
        return h('tr', { dataset: { step: s.kind } }, h('td', {}, STEP_NAMES[s.kind] ?? s.kind, own?.model ? null : h('div', { class: 'faint kp-follows' }, followText(s))), h('td', {}, modelSel), h('td', {}, thinkSel));
      }))));
}

/**
 * The order of keys that stand in when one runs out of quota or is rate-limited (CKC-03 AC-35). Its first row is the main
 * key — the same setting as `Main model — key` above. Every row chooses its key and its model and moves like any other; a
 * key chosen in one row that sits in another changes places with it. Whichever row is first is the main key, and runs
 * with the main model's thinking.
 */
function backupsBlock(mpv, post) {
  const r = mpv.route;
  const thinking = r.main?.thinking ?? null;
  const rows = orderRows(r);
  const list = rows.map((b) => ({ provider: b.provider, id: b.id, thinking: b.thinking ?? null }));
  // The whole order back to the server (key-order.js): the first row is the main model, the rest the backups.
  const send = (next, done) => { const body = orderBody(next, thinking); if (!body) { toast('Keep at least one key in the order'); return; } post(body, done); };
  const move = (i, d) => { const next = moveRow(list, i, d); send(next, i + d === 0 || i === 0 ? `${keyLabel(mpv, next[0].provider)} · ${next[0].id} is the main key now — the steps that follow it change with it` : 'Backup order saved'); };
  const others = mpv.keys.filter((k) => isUsable(k) && !list.some((b) => b.provider === k.id));
  const add = h('select', { class: 'input small', id: 'kp-backup-add', 'aria-label': 'Add a backup key' }, h('option', { value: '' }, others.length ? 'Add a key to the order…' : 'No other usable key to add'), ...others.map((k) => h('option', { value: k.id }, k.name)));
  add.addEventListener('change', () => {
    const k = mpv.keys.find((x) => x.id === add.value);
    if (!k) return;
    // On the backup, the main model when it carries it, else its first model.
    send([...list, { provider: k.id, id: modelFor(k, null, r.main?.id), thinking }], `${k.name} added to the backup order`);
  });
  // A row's key: any usable key, and the keys of the order as they are. A key that sits in another row changes places
  // with this one; a key outside the order takes the row (key-order.js). The first row's key is the main key.
  const keySel = (b, i, first) => {
    const set = mpv.keys.some((k) => k.id === b.provider);
    const sel = h('select', { class: 'input small kp-order-key', 'aria-label': first ? 'The main key' : `Key of row ${i + 1}`, ...(first ? { id: 'kp-order-main-key' } : {}), title: 'The key of this row. A key that is already in another row changes places with this one.' },
      set ? null : h('option', { value: b.provider, selected: true }, `${b.keyName} (removed)`),
      ...mpv.keys.filter((k) => isUsable(k) || list.some((x) => x.provider === k.id)).map((k) => h('option', { value: k.id, selected: k.id === b.provider }, `${k.name}${isUsable(k) ? '' : ` (${k.state.status.toLowerCase()})`}`)));
    sel.addEventListener('change', () => {
      const k = mpv.keys.find((x) => x.id === sel.value);
      if (!k || k.id === b.provider) return;
      const from = list.findIndex((x) => x.provider === k.id);
      const next = chooseKey(list, i, k, r.main?.id);
      const main = next[0].provider !== list[0].provider ? `${keyLabel(mpv, next[0].provider)} · ${next[0].id} is the main key now — the steps that follow it change with it` : null;
      send(next, main ?? (from >= 0 ? `${k.name} and ${b.keyName} changed places` : `${k.name} takes the place of ${b.keyName}, on ${next[i].id}`));
    });
    return sel;
  };
  return h('div', { id: 'kp-backups' },
    h('h5', {}, 'When a key runs out of quota or is rate-limited'),
    h('ol', { class: 'kp-backup-list' },
      rows.length ? null : h('li', { class: 'faint' }, 'No main key chosen.'),
      ...rows.map((b, i) => {
        const k = mpv.keys.find((x) => x.id === b.provider);
        const first = i === 0 && Boolean(r.main);
        const sel = h('select', { class: 'input small kp-order-model', 'aria-label': first ? 'The main model' : `Model on ${b.keyName}`, ...(first ? { id: 'kp-order-main-model' } : {}), title: first ? 'The main model: your conversation and every step that follows it run on it' : 'The model this key runs when it stands in for a model it does not carry' }, ...modelOptions(k, b.id));
        sel.addEventListener('change', () => send(list.map((x, j) => (j === i ? { ...x, id: sel.value } : x)), first ? `Main model: ${b.keyName} · ${sel.value} — the steps that follow it change with it` : `${b.keyName}: stands in with ${sel.value}`));
        return h('li', { 'data-backup': b.provider, ...(first ? { 'data-main': '' } : {}) }, h('div', { class: 'kp-backup-row' },
          keySel(b, i, first), b.usable ? null : h('span', { class: 'tag amber' }, k ? k.state.status.toLowerCase() : 'removed'), sel,
          first ? h('span', { class: 'faint' }, 'the main key, used first') : null,
          h('button', { class: 'btn small', title: 'Earlier', disabled: i === 0, onClick: () => move(i, -1) }, '↑'),
          h('button', { class: 'btn small', title: first ? 'Later: the next key becomes the main key' : 'Later', disabled: i === rows.length - 1, onClick: () => move(i, 1) }, '↓'),
          h('button', { class: 'btn small', title: first ? 'Take it out of the order: the next key becomes the main key' : 'Take it out of the order', disabled: rows.length === 1, onClick: () => send(list.filter((_, j) => j !== i), first ? `${b.keyName} taken out; ${keyLabel(mpv, list[1]?.provider)} is the main key now` : `${b.keyName} taken out of the backup order`) }, '×')));
      })),
    add,
    h('div', { class: 'faint' }, 'The first row is the main key — the same setting as the main model above. Every row chooses its key and its model; a key already in another row changes places with it. Work goes on in its own session on the next usable key of this order, and comes back when the first key is usable again. A step set to a model on a key runs on that key (on a provider’s keys, shared by them); when they are out of quota or rate-limited, on the other keys of this order that carry the same model, recorded under Switches between keys. Only when no usable key carries the model does a key stand in with the model of its row.'));
}

function lanesLine(mpv) {
  const keys = mpv.lanes.keys;
  return h('div', { class: 'muted', id: 'kp-lanes' }, h('b', {}, `Up to ${mpv.lanes.total} jobs at once`), ` on this project’s ${plural(keys.length, 'key')}: `, keys.map((k) => `${k.keyName} ${k.running}/${k.capacity}`).join(' · ') || '—', '. Each key’s number is set in the keys table above.');
}

/** `Usage` per round, split by model (§6.10; CKC-03 AC-37): the recent rounds open, earlier ones folded. */
function roundsUsage(data) {
  const rounds = data?.rounds ?? null;
  if (!rounds) return null;
  if (!rounds.length) return h('div', { class: 'faint', id: 'kp-usage-rounds' }, 'No round has run yet.');
  const OPEN = 3;
  const kindText = (k) => (k === 'Deepen' ? 'deepening' : k === 'First usable' ? 'first usable picture' : k.toLowerCase());
  const row = (r, open) => h('details', { class: 'fold kp-round-usage', 'data-round': r.id, open },
    h('summary', {}, h('span', { class: 'kp-fold-head' }, `Round ${r.number} · ${kindText(r.kind)} · ${fmtWall(r.wallMs)} · ${r.cost == null ? 'cost not reported' : `$${r.cost.toFixed(2)}`} · ${plural(r.byModel.length, 'model')}`), h('span', { class: 'faint' }, ` ${fmtTime(r.startedAt)} · ${r.status}`)),
    h('div', { class: 'content' }, h('div', { class: 'kp-table-frame' }, h('table', { class: 'list kp-model-usage' },
      h('thead', {}, h('tr', {}, ...['Model', 'Keys', 'Steps it carried', 'Time', 'Input', 'Output', 'Cost'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...r.byModel.map((m) => h('tr', { 'data-model': m.model },
        h('td', {}, h('b', {}, m.model)), h('td', { class: 'faint' }, m.keys.join(', ')),
        h('td', { class: 'faint' }, m.steps.map((s) => `${STEP_NAMES[s.kind] ?? s.kind}${s.count > 1 ? ` ×${s.count}` : ''}`).join(', ')),
        h('td', {}, fmtWall(m.timeMs)), h('td', { class: 'kp-num' }, fmtTokens(m.input)), h('td', { class: 'kp-num' }, fmtTokens(m.output)),
        h('td', { class: 'kp-num' }, m.priced ? `$${(m.cost ?? 0).toFixed(2)}` : 'price not reported')))))),
      h('div', { class: 'faint' }, 'Time is each model’s jobs added up; the round’s own time is its wall clock, set by the longest lane.')));
  const earlier = rounds.slice(OPEN);
  return h('div', { class: 'stack', id: 'kp-usage-rounds' }, h('h4', {}, 'Each round, by model'), ...rounds.slice(0, OPEN).map((r) => row(r, true)),
    earlier.length ? fold('kp-usage-earlier', `Earlier rounds (${earlier.length})`, earlier.map((r) => row(r, false))) : null);
}
