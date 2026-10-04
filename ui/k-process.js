// The process view of increment K (Spec v3.0 §6.3, §2.11, §2.12, §1.18; CKC-24): the List's work cells with each
// step's did on the left and what reality gave on the right (mockup list-process-v1.html), the graph's default of
// results only with a work's branch growing on click (mockup graph-process-v0.html), breakpoints, send-backs with
// `Copy for agent`, earlier generations rolled up, and the popover's `How it got here` and versions.
//
// Everything shown comes from the views of k-data.js (src/model/views-k.ts shapes); when an endpoint is not built yet
// the surface says `No data for this yet` and nothing is invented. List and Graph share one fold rule (CKC-24 AC-11,
// AC-12; k-fold.js): every work is folded until the owner opens it, and what the owner opened or folded holds in both
// (E152, E153).
import { h, append, clear, toast, openDialog, select, state, navigate, popover, flyout, refreshProject, renderBody } from './app.js';
import * as K from './k-data.js';
import { setProcessLayer, processImage, PROC_SIZE } from './graph.js';
import { openDraft, sessionsBlock } from './k/draft-view.js';
import { fillMarkdown } from './markdown.js';
import { createFold, expandableIn, stepOfIn, foldLine, openMark } from './k-fold.js';
import { generationKey } from './list-fold.js';

const NO_DATA = K.noData();

// What the views module opens for the process view: an original source, a code territory in `Code`. Set by views.js
// (this module is imported by it, so it does not import it back).
let openers = { openSource: null };
export function setOpeners(o) { openers = { ...openers, ...o }; }

/** A session's draft, from anywhere a session is reached (§3.11; CKC-23 AC-18). */
export const draftCtx = () => ({
  fetchDraft: (key) => K.getDraft(state.projectId, key),
  openSource: openers.openSource,
  openDraft: (key) => openDraft(key, draftCtx()),
});

/**
 * `Code` with one territory brought into view (§6.17 "从过程视图的工作跳到它改过的领地"): the Project graph switches to
 * its `Code` mode, and the territory's row is scrolled to, marked, and its files opened.
 */
export function openTerritory(territoryId) {
  popover.close('navigate');
  state.graphMode = 'code';
  state.codeTarget = territoryId;
  if (state.view !== 'graph') navigate(state.projectId, 'graph');
  else void renderBody();
}

// ── the data and the one fold rule ─────────────────────────────────────────
// undefined until the first answer arrives — a caller that comes in while the fetch is in flight must wait on
// `loading`, not take null as the answer (the first render's Expand all and branches depend on it).
let proc;
let procPid = null;
let loading = null;
// The one fold rule (CKC-24 AC-11; k-fold.js): every work folded until the owner opens it, the same choice in the List
// and in the Graph (E152, E153).
let seededFor = null;

export async function load(pid, { refresh = false } = {}) {
  if (!refresh && procPid === pid && proc !== undefined) return proc;
  if (!refresh && loading && procPid === pid) return loading;
  procPid = pid;
  loading = (async () => {
    try { proc = await K.getProcess(pid); } catch { proc = null; }
    if (proc && seededFor !== pid) {
      seededFor = pid;
      fold.reset();
    }
    loading = null;
    return proc;
  })();
  return loading;
}
export function current() { return proc; }
export async function reload(pid) { return load(pid, { refresh: true }); }

const stepOf = (id) => stepOfIn(proc, id);
const expandable = (id) => expandableIn(proc, id);
export const fold = createFold(() => proc);
const listOpen = (id) => fold.has(id);
/** A row of the List opened or folded by hand. The browser also says `toggle` for a row drawn open, which changes nothing. */
const listToggled = (id, open) => { if (open !== fold.has(id)) fold.set(id, open); };

// ── §2.11 times ────────────────────────────────────────────────────────────
const shortAt = (at) => {
  if (!at) return '—';
  if (!at.includes('T')) return at;   // a date stays a date (§1.8)
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const BASIS_WORD = { Commit: 'committed', Session: 'session', 'Written in text': 'Text says', 'File time': 'file time', 'First observed': 'first seen' };
/** One `Occurred` as §2.11 wants it: the text's claim and the observed time are both written when they disagree. */
export function fmtOccurred(o) {
  if (!o) return '—';
  if (o.undated) return `Undated · first seen ${shortAt(o.at)}`;
  const main = `${BASIS_WORD[o.basis] ?? o.basis} ${shortAt(o.at)}`;
  if (!o.other?.at) return shortAt(o.at);
  const other = `${BASIS_WORD[o.other.basis] ?? o.other.basis} ${shortAt(o.other.at)}`;
  return o.basis === 'Written in text' ? `${main} · ${other}` : `${other} · ${main}`;
}
const occurredTitle = (o) => !o ? '' : o.undated ? `Undated · first seen ${shortAt(o.at)} (basis: First observed)` : `${BASIS_WORD[o.basis] ?? o.basis} ${shortAt(o.at)}${o.other?.at ? ` · ${BASIS_WORD[o.other.basis] ?? o.other.basis} ${shortAt(o.other.at)}` : ''}${o.anchor ? ` — ${o.anchor}` : ''}`;

// ── small shared pieces ────────────────────────────────────────────────────
/** `Copy for agent` (§1.18): the clipboard gets the send-back's text; a toast confirms. The checks read the hook. */
export async function copyText(text, note = 'Copied — paste it to the execution agent') {
  try {
    await navigator.clipboard.writeText(text);
    toast(note);
  } catch {
    const ta = h('textarea', { class: 'input', style: { minHeight: '30vh' } }, text);
    openDialog('Copy for agent', [h('p', { class: 'muted' }, 'The clipboard is unavailable; select the text below and copy it.'), ta]);
    ta.select();
  }
  window.__ckCopied = text;   // headless checks cannot always read the clipboard; the write path is the same
}

const copyBtn = (sb) => h('button', { class: 'text-btn copy', title: 'Copy this send-back for the execution agent: where the problem is, the evidence, where to send it back, the CLI command', onClick: (e) => { e.stopPropagation(); void copyText(sb.copyForAgent); } }, 'Copy for agent');

/** `No action needed` (§2.7): one reason, then the matching response endpoint; the answer stays with the object. */
export function askNoAction(kind, id, label) {
  const reason = h('textarea', { class: 'input', placeholder: 'Why is no action needed?' });
  const err = h('small', { class: 'faint' });
  const submit = async () => {
    if (!reason.value.trim()) { err.textContent = 'A reason is needed — it stays with the object.'; return; }
    try {
      if (kind === 'breakpoint') await K.respondBreakpoint(state.projectId, id, reason.value.trim());
      else await K.respondSendBack(state.projectId, id, reason.value.trim());
      document.querySelector('#dialog')?.close();
      toast('Recorded: no action needed');
      await refreshProject();
    } catch (e) { err.textContent = e.message; }
  };
  openDialog('No action needed', [
    h('p', { class: 'muted' }, label),
    h('div', { class: 'field' }, h('label', {}, 'Reason'), reason), err,
    h('div', { class: 'dialog-foot' }, h('button', { class: 'btn primary', onClick: submit }, 'Record')),
  ]);
  reason.focus();
}
const noActionBtn = (kind, id, label) => h('button', { class: 'text-btn copy', title: 'Answer “No action needed” with a reason; it stops lighting up and the answer stays', onClick: (e) => { e.stopPropagation(); askNoAction(kind, id, label); } }, 'No action needed');

const basisNote = (b) => b === 'Inferred' ? h('span', { class: 'tag purple', title: 'Tied to this work by a judged link, not an id' }, 'Inferred') : null;
/**
 * How far a step's judged link has been checked (CM; ProcessStepView.link): a link the cross-check confirmed says
 * nothing more; one that passed the program's evidence check when written counts like a confirmed one but says so
 * (`Lane-checked`); a suspect one and one not checked yet say so too. Steps tied by an id carry no `link`.
 */
const LINK_TAG = {
  'lane-checked': { label: 'Lane-checked', tone: '', graphTone: 'muted', title: 'The link passed the program’s evidence check when it was written; the cross-check has not confirmed it yet. It counts like a confirmed one.' },
  suspect: { label: 'Suspect link', tone: 'red', graphTone: 'danger', title: 'The cross-check doubts this step belongs to this work' },
  unconfirmed: { label: 'Not confirmed yet', tone: 'amber', graphTone: 'faint', title: 'A judged link nothing has checked yet' },
};
const linkNote = (link) => { const t = LINK_TAG[link]; return t ? h('span', { class: `tag link-tag ${t.tone}`.trim(), title: t.title }, t.label) : null; };

// Look up the send-backs and breakpoints hanging on an object.
const sendBacksOf = (id) => (proc?.sendBacks ?? []).filter((s) => s.targetId === id);
const breakpointsOf = (id) => (proc?.breakpoints ?? []).filter((b) => b.targetId === id);
const litOf = (id) => ({ sendBacks: sendBacksOf(id).filter((s) => s.lit), breakpoints: breakpointsOf(id).filter((b) => b.lit) });

/** A `Suggested`/`Returned` send-back is open; a `Closed` one says what evidence closed it. */
export function routeChips(step) {
  const chips = [];
  const sb = step?.sendBackId ? proc?.sendBacks.find((s) => s.id === step.sendBackId) : null;
  if (sb) {
    if (sb.stage === 'Suggested') chips.push(h('span', { class: 'route back', title: sb.what }, `↩ Suggested · back to ${sb.to === 'Plan' ? 'plan' : 'work'}`), copyBtn(sb), noActionBtn('sendback', sb.id, `Send-back ${sb.id}: ${sb.what}`));
    else if (sb.stage === 'Returned') chips.push(h('span', { class: 'route back', title: `${sb.what}${sb.returned ? ` — caught by ${sb.returned.label}` : ''}` }, `↩ Returned → ${sb.returned?.label ?? '…'}`), noActionBtn('sendback', sb.id, `Send-back ${sb.id}: ${sb.what}`));
    else chips.push(h('span', { class: 'route closed', title: `Closed${sb.closed?.label ? ` — ${sb.closed.label}` : ''}${sb.returned?.label ? ` · returned → ${sb.returned.label}` : ''}` }, `✓ Closed${sb.returned?.label ? ` → ${sb.returned.label}` : ''}`));
  }
  if (step?.kind === 'Handed to') chips.push(h('span', { class: 'route hand', title: step.result || step.did }, `→ ${step.did}`));
  if (step?.kind === 'Handed in') chips.push(h('span', { class: 'route hand', title: step.did }, `← handed in`));
  return chips;
}

/**
 * The evidence of a breakpoint or a send-back as the owner reads it (§2.12, §1.18; CKC-24 AC-3): what each piece is and
 * when, and the original line itself, verbatim — the report's line an open item was left in, the verdict as written.
 */
export function evidenceList(evidence) {
  if (!evidence?.length) return null;
  return h('ul', { class: 'kp-evid' }, ...evidence.map((e) => h('li', {},
    h('span', { class: 'kp-evid-label' }, e.label || e.id),
    e.occurred ? h('span', { class: 'kp-when', title: occurredTitle(e.occurred) }, ` · ${fmtOccurred(e.occurred)}`) : null,
    e.kind === 'source' && openers.openSource ? [' ', h('button', { class: 'text-btn kp-orig', title: 'Read the original where this line stands', onClick: (ev) => { ev.stopPropagation(); void openers.openSource(e.id); } }, 'Original')] : null,
    e.line ? h('blockquote', { class: 'kp-line', title: 'The original line, verbatim' }, e.line) : null)));
}

/** The mark of an open send-back or a lit breakpoint, drawn on the folded line as well (D75). The mark opens the item
 *  beside it, with its evidence's original lines (CKC-24 AC-3). */
function flagLines(ids, { lit = true } = {}) {
  const out = [];
  for (const id of ids ?? []) {
    const sb = proc?.sendBacks.find((s) => s.id === id);
    if (sb && sb.lit === lit && sb.stage !== 'Closed') {
      const open = h('button', { class: 'text-btn flag-open', title: 'Open this send-back: where the problem is, its evidence and the original lines', onClick: (e) => { e.stopPropagation(); openSendBackPopover(sb.id, () => rectOfEl(open)); } }, `↩ ${sb.stage} · back to ${sb.to === 'Plan' ? 'plan' : 'work'} · ${sb.what}`);
      out.push(h('div', { class: 'flag back', dataset: { sendback: sb.id } }, open, ' ', copyBtn(sb)));
    }
  }
  for (const id of ids ?? []) {
    const bp = proc?.breakpoints.find((b) => b.id === id);
    if (bp && bp.lit === lit) {
      const lines = (bp.evidence ?? []).filter((e) => e.line).length;
      const open = h('button', { class: 'text-btn flag-open', title: lines ? `Open this breakpoint: its evidence and the ${lines === 1 ? 'original line' : `${lines} original lines`}` : 'Open this breakpoint and its evidence', onClick: (e) => { e.stopPropagation(); openBreakpointPopover(bp.id, () => rectOfEl(open)); } }, `⚠ ${bp.kind} · ${bp.why}`);
      out.push(h('div', { class: 'flag back', dataset: { breakpoint: bp.id } }, open, lines ? h('span', { class: 'kp-lines-mark', title: 'It carries the original lines — open it to read them' }, ` ❝${lines}`) : null, ' ', basisNote(bp.basis), ' ', noActionBtn('breakpoint', bp.id, `Breakpoint ${bp.kind}: ${bp.why}`)));
    }
  }
  return out;
}
const rectOfEl = (el) => { if (!el?.isConnected) return null; const r = el.getBoundingClientRect(); return r.width || r.height ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null; };

// ── the List (mockup list-process-v1.html) ─────────────────────────────────
/** One step: what was done on the left, what reality gave on the right, in one row. The step's own task number
 *  (ProcessStepView.unit — a fix or a check that is a task of its own, e.g. AD) stands at the step's left. */
function stepRow(step) {
  const verdict = step.verdict ?? null;
  const tone = verdict ? (/fail|needs repair/i.test(verdict) ? 'red' : /pass/i.test(verdict) ? 'green' : 'amber') : step.kind === 'Merged' ? 'green' : '';
  const resultTag = verdict ? verdict : step.kind === 'Merged' ? 'Merged' : step.kind === 'Delivered' ? 'Result' : step.kind === 'Fix' ? 'Fix' : step.kind;
  return h('div', { class: `step row2${step.history ? ' history' : ''}` },
    h('div', {},
      h('span', { class: 'k' }, step.kind), step.unit ? h('span', { class: 'tag unit', title: 'The task of its own that made this step (a fix or a check) — it folds under this work, not a row of its own' }, step.unit) : null, step.who && step.who !== step.unit ? h('span', { class: 'who' }, step.who) : null, ' ',
      // The unit badge already names the task, so the text does not repeat it ("AD" + "AD fixed …" read "ADAD fixed").
      h('span', { class: 'say' }, step.unit && step.did.startsWith(`${step.unit} `) ? step.did.slice(step.unit.length + 1) : step.did), ' ', basisNote(step.basis), linkNote(step.link),
      step.history ? h('span', { class: 'tag', title: 'This step lies in history (a side branch, a deleted document)' }, 'history') : null),
    h('div', { title: occurredTitle(step.occurred) },
      h('span', { class: `tag ${tone}` }, resultTag), ' ', h('span', { class: 'say' }, step.result), ...routeChips(step)));
}

/** The four things of §2.12 on the work's own line: execution, progress, the latest check and by whom, what is open. */
export function fourThingsTags(w) {
  const four = w?.four;
  if (!four) return [];
  const open = (four.open.findings + four.open.sendBacks + four.open.breakpoints) || 0;
  return [
    four.execution ? h('span', { class: `tag ${four.execution === 'Merged' ? 'green' : four.execution === 'In progress' ? 'blue' : four.execution === 'Not merged' ? 'red' : ''}` }, four.execution) : null,
    four.check && four.check !== 'Not checked'
      ? h('span', { class: `tag ${/fail|needs repair/i.test(four.check.verdict) ? 'red' : 'green'}`, title: `Latest check ${four.check.occurred ? fmtOccurred(four.check.occurred) : ''}` }, `${four.check.verdict} · ${four.check.by}`)
      : four.check === 'Not checked' ? h('span', { class: 'tag amber' }, 'Not checked') : null,
    open ? h('span', { class: 'tag red', title: `${four.open.findings} findings · ${four.open.sendBacks} send-backs · ${four.open.breakpoints} breakpoints still open` }, `⚠ ${open} open`) : null,
  ];
}

const numberTag = (w) => {
  if (!w?.number) return null;
  return w.number.byKeeper
    ? h('span', { class: 'tag', title: 'Numbered by the Keeper — the project had no number for it' }, `${w.number.value} · Keeper's number`)
    : h('span', { class: 'tag faint-num', title: 'The project’s own number' }, w.number.value);
};

/** A struck work (Replaced / Abandoned / Deferred): struck through, with what replaced it or why (§2.12). */
const struckNote = (w) => w?.struck ? h('span', { class: 'tag strike', title: `${w.struck.validity}${w.struck.why ? ` — ${w.struck.why}` : ''}` }, `${w.struck.validity}${w.struck.why ? ` · ${w.struck.why}` : ''}`) : null;

/**
 * One unit of the `Work & plan` cell: folded to one line that still lights what is open, until the owner opens it
 * (k-fold.js); a work whose steps are one line anyway stays a flat row (mockup: AA).
 */
export function unitBlock(node, ctx) {
  const w = proc?.works[node.id];
  const label = ctx.nodeBtn(node);
  if (!w) {
    // No process assembled for this work (yet): the plain line, nothing invented.
    return h('div', { class: 'unit' }, h('div', { class: 'row2' }, h('div', {}, h('span', { class: 'nocaret' }), label), h('div', {}, h('span', { class: 'faint' }, NO_DATA))));
  }
  const plan = proc?.plans?.[node.id];
  const head = h('div', {},
    w.steps.length > 1 || plan ? h('span', { class: 'caret' }) : h('span', { class: 'nocaret' }),
    node.category === 'Plan' ? h('span', { class: 'tag' }, 'Plan') : null, ' ', label, ' ', numberTag(w), ' ',
    w.four.progress ? h('span', { class: 'tag' }, w.four.progress) : null, ' ', ctx.acceptanceTag(node), ' ', struckNote(w),
    // What is folded under it, at the end of its own line (E153: one line a unit, not a second one for the count).
    w.steps.length > 1 || plan ? [' ', h('span', { class: 'wr-steps' }, w.folded)] : null);
  const right = h('div', {}, ...fourThingsTags(w));
  const openFlags = [...flagLines(w.sendBackIds), ...flagLines(w.breakpointIds), ...childFlagsOf(node.id)];
  if (!(w.steps.length > 1 || plan)) {
    const only = w.steps[0];
    return h('div', { class: 'unit' },
      h('div', { class: 'row2' }, head, only ? h('div', { title: occurredTitle(only.occurred) }, ...fourThingsTags(w), ' ', h('span', { class: 'say' }, only.result)) : right),
      ...openFlags);
  }
  const body = h('div', { class: 'steps' }, ...w.steps.map(stepRow));
  const det = h('details', { class: 'unit', open: listOpen(node.id) || null, onToggle: (e) => listToggled(node.id, e.currentTarget.open) },
    h('summary', {},
      h('div', { class: 'row2' }, head, right),
      ...openFlags,
      plan?.differs ? h('div', { class: 'sumline' }, `Execution differed from the plan: ${plan.differs}`) : null),
    plan ? planShape(plan, ctx) : null,
    w.steps.length ? body : null);
  return det;
}

/**
 * A work's state in one sentence, the right half of its row in the List by module (D100; Spec §6.3; CKC-24 AC-20):
 * done work says what it actually delivered and how it was checked (by whom); open work says how far it is and what is
 * still open (lit breakpoints, open send-backs and findings). The same four things as its node on the Graph.
 */
export function stateSentence(node, w = proc?.works?.[node.id]) {
  const four = w?.four;
  const progress = four?.progress || node.progress || '';
  if (!four) return progress ? `${progress}${node.acceptance ? ` · ${node.acceptance}` : ''}` : NO_DATA;
  const steps = w.steps ?? [];
  const delivered = [...steps].reverse().find((s) => s.kind === 'Merged' || s.kind === 'Delivered' || s.kind === 'Fix');
  const check = four.check && four.check !== 'Not checked' ? `${four.check.verdict} · checked by ${four.check.by}` : four.check === 'Not checked' ? 'Not checked' : 'no check recorded';
  const open = [];
  const lit = (w.breakpointIds ?? []).map((id) => proc?.breakpoints.find((b) => b.id === id)).filter(Boolean);
  if (lit.length) open.push(lit.map((b) => b.kind).join(', '));
  if (four.open.sendBacks) open.push(`${four.open.sendBacks} send-back${four.open.sendBacks === 1 ? '' : 's'} open`);
  if (four.open.findings) open.push(`${four.open.findings} finding${four.open.findings === 1 ? '' : 's'} open`);
  if (progress === 'Done') {
    const result = delivered ? `${delivered.kind === 'Merged' ? 'Merged' : delivered.kind}: ${delivered.result || delivered.did}` : four.execution ?? 'no delivery linked yet';
    return [result, check, open.length ? `⚠ ${open.join(' · ')}` : null].filter(Boolean).join(' · ');
  }
  return [progress, four.execution !== progress ? four.execution : null, open.length ? `⚠ ${open.join(' · ')}` : 'nothing left open'].filter(Boolean).join(' · ');
}

/**
 * One work item's row in the List by module (D100, the owner's drawn structure; Spec §6.3; CKC-09 AC-15, CKC-24 AC-20;
 * E153). Folded — as every row is until the owner opens it, the same fold as the Graph's branch — it is one line on
 * each side: on the left its number and name, its plan and where else it stands, the count of what is open and how
 * many steps are folded under it; on the right one sentence of its state, cut to the line with the whole of it in the
 * hover, and `Basis`. Expanded, the sentence is whole and its `Process` · `Outcome` follow — one step a line, what was
 * done and what reality gave. What needs the owner is on the folded row too: the ⚠ count, and under it each open
 * send-back and lit breakpoint (D75).
 */
const stepLineText = (step) => `${step.kind}: ${step.result || step.did}`;
/** The line a one-step work shows beside its name (`Planned: product/PLAN.md @ 8f8d3e6 (Modified)`); null otherwise. */
export function stepText(workId) {
  const w = proc?.works?.[workId];
  return w && w.steps.length === 1 ? stepLineText(w.steps[0]) : null;
}

export function workRow(node, ctx) {
  const w = proc?.works[node.id];
  const many = Boolean(w) && w.steps.length > 1;
  const only = w?.steps.length === 1 ? w.steps[0] : null;
  const onlyText = only ? stepLineText(only) : null;
  // What is folded under the row, or the one step it has: beside the name, the first thing to give way in a narrow row.
  const stepsNote = many ? h('span', { class: 'wr-steps', title: w.folded }, w.folded)
    : only ? ctx.stepLine?.(only, onlyText) ?? h('span', { class: 'wr-steps', title: onlyText }, onlyText) : null;
  const mark = openMarkOf(node.id);
  const sentence = ctx.sentence?.(node) ?? stateSentence(node, w);
  const left = h('div', { class: 'wr-left' },
    many ? h('span', { class: 'caret' }) : h('span', { class: 'nocaret' }),
    h('span', { class: 'wr-name', title: node.label }, ctx.nodeBtn(node)), ctx.planTag?.(node) ?? null, ctx.acceptanceTag?.(node) ?? null, struckNote(w), ctx.extraLeft?.(node) ?? null,
    mark ? h('span', { class: 'tag red wr-open', title: mark.text }, `⚠ ${mark.count} open`) : null, stepsNote);
  const right = h('div', { class: 'wr-right' }, h('span', { class: 'say', title: sentence }, sentence), ctx.basisBtn?.(node) ?? null);
  const flags = w ? [...flagLines(w.sendBackIds), ...flagLines(w.breakpointIds), ...childFlagsOf(node.id)] : [];
  if (!many) return h('div', { class: 'unit wrow', dataset: { work: node.id } }, h('div', { class: 'row2' }, left, right), ...flags);
  return h('details', { class: 'unit wrow', dataset: { work: node.id }, open: listOpen(node.id) || null, onToggle: (e) => listToggled(node.id, e.currentTarget.open) },
    h('summary', {}, h('div', { class: 'row2' }, left, right), ...flags),
    h('div', { class: 'proc-head row2' }, h('span', {}, 'Process'), h('span', {}, 'Outcome')),
    h('div', { class: 'steps' }, ...w.steps.map(stepRow)));
}

/** A plan's execution shape (D72): the actual order as it happened, the batches as the orchestrator wrote them. */
function planShape(shape, ctx) {
  const batchWork = (wid) => ctx.nodeOf(wid);
  const rows = [];
  let par = null;
  for (const b of shape.batches) {
    const row = h('div', { class: 'step row2' },
      h('div', {},
        h('span', { class: 'k' }, /^batch\b/i.test(b.label) ? b.label : `Batch ${b.label}`),
        b.workIds.length ? h('span', { class: 'who' }, b.workIds.map((id) => batchWork(id)?.label ?? id).join(' + ')) : null, ' ',
        b.agent ? h('span', { class: 'say' }, `${b.agent}${b.worktree ? ` · ${b.worktree}` : ''}`) : null,
        b.parallel ? h('span', { class: 'tag blue', title: 'Could run in parallel with its sibling batch' }, '∥ parallel') : null,
        b.running ? h('span', { class: 'tag amber' }, 'running') : null),
      h('div', { title: b.occurred ? occurredTitle(b.occurred) : '' },
        b.mergeCommit ? h('span', { class: 'tag green' }, 'Merged') : null, ' ',
        h('span', { class: 'mono' }, b.mergeCommit ?? ''), b.mergeCommit ? ' ' : null));
    // What a batch's work still has open lights up under it, folded or not (D75; mockup: the .sub under batch 7).
    const sub = b.workIds.flatMap((wid) => [...flagLines(proc?.works[wid]?.sendBackIds ?? []), ...flagLines(proc?.works[wid]?.breakpointIds ?? [])]);
    const withSub = sub.length ? h('div', {}, row, h('div', { class: 'sub' }, ...sub)) : row;
    if (b.parallel) {
      if (!par) { par = h('div', { class: 'par' }, h('div', { class: 'par-head' }, `Batch ${b.label} · two halves, run in parallel`)); rows.push(par); }
      par.append(withSub);
    } else { par = null; rows.push(withSub); }
  }
  return h('div', {},
    shape.actualOrder ? h('div', { class: 'order' }, 'Execution order: ', h('b', {}, shape.actualOrder), shape.plannedOrder && shape.plannedOrder !== shape.actualOrder ? h('span', { class: 'faint' }, ` (planned: ${shape.plannedOrder})`) : null) : null,
    ...rows,
    shape.dependsOn.length ? h('div', { class: 'sumline' }, `Depends on: ${shape.dependsOn.map((d) => `${d.from} → ${d.to}`).join(', ')}`) : null);
}

/** Send-backs and breakpoints hanging on an intent object (a requirement, a decision): shown in its cell (mockup 3.5). */
export function intentFlags(objectId) {
  return [...flagLines(sendBacksOf(objectId).map((s) => s.id)), ...flagLines(breakpointsOf(objectId).map((b) => b.id))];
}
/** Works that ride inside another unit's steps (a fix, a QC round) are not units of their own in the process List. */
export function absorbedIds() {
  const out = new Set();
  if (!proc) return out;
  // The engine says so directly (WorkProcessView.stepOf): a fix or a check folds under the work it is a step of.
  for (const [id, w] of Object.entries(proc.works)) if (w.stepOf) out.add(id);
  for (const w of Object.values(proc.works)) {
    for (const s of w.steps) for (const e of s.evidence ?? []) if (e.kind === 'object' && !proc.works[e.id]) out.add(e.id);
  }
  // A plan's batches are drawn inside the plan's unit, in the plan's own area.
  for (const [pid_, shape] of Object.entries(proc?.plans ?? {})) {
    const planArea = proc.works[pid_] ? areaOf(pid_) : null;
    for (const b of shape.batches) for (const wid of b.workIds) if (!proc.works[wid] || areaOf(wid) === planArea) out.add(wid);
  }
  return out;
}
/** What a folded-in child (stepOf) still has open rides under the parent's unit, lit folded or not (D75). */
function childFlagsOf(id) {
  const out = [];
  for (const [cid, w] of Object.entries(proc?.works ?? {})) {
    if (w.stepOf !== id) continue;
    out.push(...flagLines(w.sendBackIds), ...flagLines(w.breakpointIds));
  }
  return out;
}
let nodeIndex = new Map();   // graph node id → payload node (for labels and areas while drawing)
export function indexNodes(nodes) { nodeIndex = new Map(nodes.map((n) => [n.id, n])); }
const nodeOf = (id) => nodeIndex.get(id) ?? null;
const areaOf = (id) => nodeOf(id)?.areaId ?? null;

/**
 * Earlier generations (D85, §2.12): one rolled-up band per generation before the current plan — what was planned,
 * done and struck, and the decision or cleanup that ended it. Unrolled it reads like the current generation.
 */
export function generationBands(ctx, placed = []) {
  // The generations as the story map places them (ui/placement.js: each item's destination), with what the process
  // view adds (the plan documents as they stood). Without either, nothing.
  const procGens = new Map((proc?.generations ?? []).map((g) => [g.id, g]));
  const gens = placed.length ? placed : [...procGens.values()].map((g) => ({ ...g, items: [], destinations: null }));
  if (!gens.length) return null;
  // A generation's works may be gone from the current version (D82): they are drawn from the band's own data.
  const genCtx = { ...ctx, nodeBtn: (n) => nodeOf(n.id) ? ctx.nodeBtn(n) : h('span', { class: 'text-btn', style: { cursor: 'default' } }, n.label) };
  return h('div', { class: 'genbands' }, ...gens.map((g) => {
    const pg = procGens.get(g.id);
    const plans = (g.planIds ?? pg?.planIds ?? []).filter((id) => !g.workIds.includes(id));
    const docs = pg?.planDocs ?? [];
    const destOf = new Map((g.items ?? []).map((i) => [i.id, i.destination]));
    // Folded to its row, it still lights what is open inside it and counts the notes inside (D75; E153).
    const marks = ctx.insideMarks?.({ works: [...g.workIds, ...plans] }) ?? ctx.foldMarks?.([...g.workIds, ...plans]) ?? null;
    // Written as where its work went, never as "abandoned" (Spec §2.12, D100).
    // A generation the organizing recorded no items for says `Not organized` (owner, 2026-09-30: 「显示未整理」); its
    // name, end and ending document stand as they are.
    const summary = g.destinations ? ctx.destinationLine(g.destinations) : pg?.planned ? `${pg.planned} planned · ${pg?.done ?? 0} done` : 'Not organized';
    const det = h('details', { class: 'genband', dataset: { generation: g.id, fold: generationKey(g.id) }, open: ctx.openGen?.(g.id) || null, onToggle: (e) => ctx.genToggled?.(g.id, e.currentTarget.open) },
      h('summary', {},
        h('span', { class: 'genname' }, `Earlier generation · ${g.name}`), ' ', marks, ' ',
        h('span', { class: 'gendest' }, summary), ' ',
        plans.length ? h('span', { class: 'tag', title: 'Its plans, drawn in the band below' }, `${plans.length} plan${plans.length === 1 ? '' : 's'}`) : null, ' ',
        h('span', { class: 'faint' }, `ended ${fmtOccurred(g.ended)}${g.endedBy?.label ? ` · ${g.endedBy.label}` : ''}`)),
      h('div', { class: 'genbody' },
        // Its plans, as the current plan is drawn (CKC-24 AC-18): a plan object with its shape, and its plan documents as
        // they stood — a deleted one from the version before its deletion (D82).
        ...plans.map((id) => planOfBand(id, genCtx, pg?.plans?.find((p) => p.id === id) ?? null)),
        docs.length ? h('div', { class: 'gendocs' }, h('span', { class: 'faint' }, 'Plan documents, as they stood: '),
          ...docs.map((d) => h('button', { class: 'text-btn gendoc', dataset: { index: String(d.index) }, title: d.path ? `Read ${d.path} as it stood when this generation ended (a deleted document from the version before its deletion)` : 'Named by the generation; it is not a document', onClick: (e) => { e.stopPropagation(); void openGenerationPlan(g.id, d.index, `${g.name} · ${d.label}`); } }, d.label))) : null,
        g.workIds.length ? null : h('div', { class: 'faint pad' }, 'Not organized: the organizing has not recorded its items or where each went.'),
        ...g.workIds.map((id) => {
          const w = proc?.works?.[id];
          const node = nodeOf(id) ?? { id, label: [w?.number?.value, w?.struck?.why].filter(Boolean).join(' · ') || id, category: 'Work item', validity: w?.struck ? 'Replaced' : 'Current' };
          // Each item says where it went: carried on, moved into the current plan, dropped by which decision.
          return workRow(node, { ...genCtx, sentence: (n) => [ctx.destinationText?.(destOf.get(id)), stateSentence(n)].filter(Boolean).join(' · ') });
        })));
    return det;
  }));
}

/** One plan of an earlier generation in its band: the plan's own unit when the process view carries it, else its name
 *  (and shape, when there is one) — nothing invented. `named` is the band's own naming of it (GenerationBandView.plans). */
function planOfBand(planId, ctx, named = null) {
  const w = proc?.works?.[planId];
  const node = nodeOf(planId) ?? { id: planId, label: named?.name || (w ? [w.number?.value, w.struck?.why].filter(Boolean).join(' · ') : '') || planId, category: 'Plan', validity: named?.validity ?? 'Replaced' };
  if (w) {
    const el = unitBlock(node, ctx);
    el.classList.add('genplan');
    el.dataset.plan = planId;
    return el;
  }
  const shape = proc?.plans?.[planId];
  return h('div', { class: 'genplan', dataset: { plan: planId } },
    h('div', { class: 'row2' }, h('div', {}, h('span', { class: 'nocaret' }), h('span', { class: 'tag' }, 'Plan'), ' ', ctx.nodeBtn(node), ' ', ctx.validityTag?.(node.validity) ?? null), h('div', {})),
    shape ? planShape(shape, ctx) : null);
}

// ── the Graph (mockup graph-process-v0.html): results by default, a click grows the branch ─────────────────
const graphOpen = (id) => fold.has(id);
const foldLineOf = (id) => foldLine(proc, id);
const openMarkOf = (id) => openMark(proc, id);

const trunc = (s, n = 64) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const stepTone = (step) => step.verdict ? (/fail|needs repair/i.test(step.verdict) ? 'danger' : /pass/i.test(step.verdict) ? 'ok' : 'accent') : step.kind === 'Merged' ? 'ok' : 'muted';

/**
 * Where an open item hangs when its object is not itself on the picture (D75): the card of the fold that holds it on
 * the story map — a stacked cell, a column's requirements, designs & decisions, a group of the ring, a rolled earlier
 * generation. `cards` maps each folded object to its card this pass (graph.js). Null when nothing stands for it now.
 */
const anchorOf = (id, byId, shown, cards) => {
  if (shown.has(id)) return id;
  return cards?.get?.(id) ?? null;
};
/** The ellipse of a send-back still open, and its arrow back (mockup graph-process-v0). */
const sugData = (sb, anchorId, byId) => ({ id: `ksb:${sb.id}`, kind: 'proc-suggest', procOf: anchorId, sbId: sb.id, seq: 99, areaId: byId.get(sb.targetId)?.areaId ?? null, rawLabel: `↩ ${sb.stage} · back to ${sb.to === 'Plan' ? 'plan' : 'work'}\n${trunc(sb.what, 56)}`, full: `${sb.what}\n${sb.suggestion}`, tones: ['danger', 'muted'], w: PROC_SIZE.suggest[0], h: PROC_SIZE.suggest[1] });
const sugEdge = (sb, fromId) => ({ data: { id: `ksug:${sb.id}`, source: fromId, target: `ksb:${sb.id}`, part: 'proc', elabel: `↩ ${sb.stage}`, mark: '', sbId: sb.id }, classes: `proc-sug${sb.to === 'Plan' ? ' plan' : ''}` });

/**
 * The elements of one work's branch: a chain of step nodes under it; a send-back still open is an ellipse the chain
 * points at (folded, it hangs on the work itself — or on the group card the work is folded into, D75); a handed-out
 * finding is a curved line to the work that took it.
 * Returns { nodes, edges } with stable ids (`kstep:<step.id>`, `ksb:<sb.id>`) so the graph's diffing keeps them put.
 */
function branchElements(workId, byId, shown) {
  const w = proc?.works[workId];
  const work = byId.get(workId);
  if (!w || !work) return { nodes: [], edges: [] };
  const nodes = [], edges = [];
  let prev = workId;
  let seq = 0;
  for (const step of w.steps) {
    const id = `kstep:${step.id}`;
    // A judged link the cross-check has not confirmed says how far it is checked, on the step's third line (CM).
    const link = LINK_TAG[step.link];
    nodes.push({
      data: { id, kind: 'proc-step', procOf: workId, seq: seq++, areaId: work.areaId ?? null, rawLabel: `${step.kind}${step.unit ? ` ${step.unit}` : ''}${step.who ? ` · ${step.who}` : ''}\n${step.result || step.did}${link ? `\n${link.label}` : ''}`, full: `${step.did}\n${step.result}${link ? `\n${link.label}` : ''}`, tones: ['kind', stepTone(step), ...(link ? [link.graphTone] : [])], w: PROC_SIZE.step[0], h: PROC_SIZE.step[1] },
      classes: `proc-step${step.basis === 'Inferred' ? ' inferred' : ''}${step.history ? ' history' : ''}`,
    });
    edges.push({ data: { id: `kchain:${prev}>${step.id}`, source: prev, target: id, part: 'proc', elabel: '', mark: '', sbId: step.sendBackId ?? null }, classes: step.sendBackId ? 'proc-ret' : 'proc-chain' });
    prev = id;
  }
  // Open send-backs of this work: an ellipse the branch (or the folded work, or its group card) points back from.
  for (const sb of sendBacksOf(workId)) {
    if (!sb.lit || sb.stage === 'Closed') continue;
    const id = `ksb:${sb.id}`;
    const stepWith = w.steps.find((s) => s.sendBackId === sb.id);
    nodes.push({
      data: { id, kind: 'proc-suggest', procOf: workId, sbId: sb.id, seq: stepWith ? w.steps.indexOf(stepWith) + 0.5 : 99, areaId: work.areaId ?? null, rawLabel: `↩ ${sb.stage} · back to ${sb.to === 'Plan' ? 'plan' : 'work'}\n${trunc(sb.what, 56)}`, full: `${sb.what}\n${sb.suggestion}`, tones: ['danger', 'muted'], w: PROC_SIZE.suggest[0], h: PROC_SIZE.suggest[1] },
      classes: `proc-suggest${sb.stage === 'Returned' ? ' returned' : ''}`,
    });
    const from = graphOpen(workId) && stepWith ? `kstep:${stepWith.id}` : workId;
    edges.push({ data: { id: `ksug:${sb.id}`, source: from, target: id, part: 'proc', elabel: `↩ ${sb.stage}`, mark: '', sbId: sb.id }, classes: `proc-sug${sb.to === 'Plan' ? ' plan' : ''}` });
  }
  // A finding handed to another work: a curved line across columns (mockup: hand).
  if (graphOpen(workId)) {
    for (const step of w.steps) {
      if (step.kind !== 'Handed to') continue;
      const target = (step.evidence ?? []).find((e) => e.kind === 'object' && shown.has(e.id));
      if (target) edges.push({ data: { id: `khand:${step.id}`, source: `kstep:${step.id}`, target: target.id, part: 'proc', elabel: `→ ${trunc(step.did, 30)}`, mark: '' }, classes: 'proc-hand' });
    }
  }
  return { nodes, edges };
}

/** A plan's branch: the batches chained in the order they actually ran (D72), cross-area halves as dotted pointers. */
function planEdges(planId, byId, shown) {
  const shape = proc?.plans[planId];
  const plan = byId.get(planId);
  if (!shape || !plan) return { nodes: [], edges: [] };
  const edges = [];
  const mk = (from, t, b) => {
    const cross = (byId.get(t)?.areaId ?? null) !== (plan.areaId ?? null);
    edges.push({
      data: { id: `kplan:${planId}:${b.label}>${t}`, source: from, target: t, part: 'proc', elabel: `B${b.label}${b.mergeCommit ? ` · ${b.mergeCommit}` : ''}`, mark: '' },
      classes: cross ? 'proc-ptr' : 'proc-chain',
    });
  };
  // Consecutive batches chain; the halves of a parallel batch both hang off the batch before them, and the next batch
  // hangs off every half (mockup: batch 4 → 5a and 5b, both → 7).
  let prevSources = [planId];
  let parSources = null, parTargets = [];
  for (const b of shape.batches) {
    const targets = b.workIds.filter((id) => shown.has(id));
    if (!targets.length) continue;
    if (b.parallel) {
      if (!parSources) { parSources = prevSources; parTargets = []; }
      for (const t of targets) mk(parSources[parSources.length - 1], t, b);
      parTargets.push(...targets);
      prevSources = parTargets;
    } else {
      for (const s of prevSources) for (const t of targets) mk(s, t, b);
      prevSources = targets;
      parSources = null; parTargets = [];
    }
  }
  return { nodes: [], edges };
}

// The layer graph.js asks for its process elements: nothing when there is no data, so the picture is exactly as before.
setProcessLayer({
  /** Which payload nodes pass the process filters (AC-16): breakpoint kind, send-back stage, one of the six things. */
  match(n, f) {
    if (!proc) return false;
    if (f.bpKind && !proc.breakpoints.some((b) => b.kind === f.bpKind && b.targetId === n.id && b.lit)) return false;
    if (f.sbStage && !proc.sendBacks.some((s) => s.stage === f.sbStage && s.targetId === n.id)) return false;
    if (f.sixThing) { const t = proc.sixThings.find((x) => String(x.thing) === String(f.sixThing)); if (!t || !t.objectIds.includes(n.id)) return false; }
    return true;
  },
  /** The second line of a work node: what is folded under it and its state, or null to leave the node as it was. */
  foldLineOf,
  /** The count of what is open on a work, for its top edge: { count, text }, or null. */
  openMarkOf,
  /** Works with a lit breakpoint or an open send-back get the alert border — the group card when the work is folded into one. */
  alertIds({ shown, byId, cards } = {}) {
    const out = new Set();
    const put = (id) => { const a = shown ? anchorOf(id, byId, shown, cards) : id; if (a) out.add(a); };
    for (const b of proc?.breakpoints ?? []) if (b.lit) put(b.targetId);
    for (const s of proc?.sendBacks ?? []) if (s.lit) put(s.targetId);
    return out;
  },
  elements({ shown, byId, cards }) {
    if (!proc) return null;
    const out = [];
    const drawnSb = new Set();
    const drawSug = (sb, anchorId, fromId) => {
      const data = sugData(sb, anchorId, byId);
      out.push({ data: { ...data, ...processImage(data) }, classes: `proc-suggest${sb.stage === 'Returned' ? ' returned' : ''}` });
      out.push(sugEdge(sb, fromId ?? anchorId));
      drawnSb.add(sb.id);
    };
    for (const id of Object.keys(proc.works)) {
      if (stepOf(id)) continue;   // a fix or a check rides in its work's branch (the steps name it, `unit`)
      const anchor = anchorOf(id, byId, shown, cards);
      if (!anchor) continue;
      if (graphOpen(id) && anchor === id) {
        const { nodes, edges } = branchElements(id, byId, shown);
        for (const n of nodes) { if (n.data.sbId) drawnSb.add(n.data.sbId); out.push({ data: { ...n.data, ...processImage(n.data) }, classes: n.classes }); }
        out.push(...edges);
        if (proc.plans[id]) out.push(...planEdges(id, byId, shown).edges);
      } else {
        // Folded — or folded into a group card: the open send-backs hang off whatever stands for the work (D75).
        for (const sb of sendBacksOf(id)) if (sb.lit && sb.stage !== 'Closed' && !drawnSb.has(sb.id)) drawSug(sb, anchor);
      }
    }
    // A send-back on something that is not a work with a branch (an area, a requirement) hangs on that object — or on
    // the card it is folded into.
    for (const sb of proc.sendBacks ?? []) {
      if (!sb.lit || sb.stage === 'Closed' || drawnSb.has(sb.id)) continue;
      const anchor = anchorOf(sb.targetId, byId, shown, cards);
      if (anchor) drawSug(sb, anchor);
    }
    return { elements: out };
  },
  toggle: (id) => fold.toggle(id),
  isOpen: (id) => graphOpen(id),
  expandable: (id) => expandable(id),
});

// ── the popover (§6.4; CKC-24 AC-14): How it got here, the versions, what is open on the object ──────────────
export async function detailsData(objectId) {
  await load(state.projectId);
  const [lineage, versions, sessions] = await Promise.all([
    K.getLineage(state.projectId, objectId), K.getVersions(state.projectId, objectId),
    // The sessions the object stands on, each with its draft (CKC-23 AC-18); none when the endpoint is not built.
    K.getObjectDrafts(state.projectId, objectId).catch(() => null),
  ]);
  return { lineage, versions, open: litOf(objectId), sessions, territories: proc?.works?.[objectId]?.territories ?? null };
}

const LIN_KIND_TONE = { 'Send-back': 'red', Verdict: 'green', Replaced: 'strike', Now: 'blue' };
/** In a document's history a patch that withdrew the document reads as the document's (owner 2026-09-30). */
const DOC_KIND = { Replaced: 'Document superseded', Replaces: 'Document replaces' };
function stepLines(steps, { doc = false } = {}) {
  const stepLine = (s) => h('div', { class: `kp-lin${s.history ? ' history' : ''}` },
    h('span', { class: `tag ${LIN_KIND_TONE[s.kind] ?? ''}` }, doc ? DOC_KIND[s.kind] ?? s.kind : s.kind), ' ',
    h('span', { class: 'kp-when', title: occurredTitle(s.occurred) }, fmtOccurred(s.occurred)), ' ',
    h('span', { class: 'kp-what' }, s.title),
    s.history ? h('span', { class: 'tag', title: 'Lies in history; not a current requirement' }, 'history') : null);
  const recent = steps.slice(-3);
  const earlier = steps.slice(0, -3);
  return [...recent.map(stepLine),
    earlier.length ? h('details', { class: 'fold kp-more' }, h('summary', {}, `All ${steps.length} steps`), h('div', { class: 'content' }, ...steps.map(stepLine))) : null];
}
function lineageBlock(steps) {
  if (!steps?.length) return null;
  return h('div', { class: 'kp-block' }, h('h4', {}, 'How it got here'), ...stepLines(steps));
}

function versionsBlock(versions, { doc = false } = {}) {
  if (!versions) return null;
  const vs = versions.versions ?? [];
  if (!vs.length) return null;
  const line = (v) => h('div', { class: `kp-ver${v.current ? ' current' : ''}${v.supersededBy ? ' superseded' : ''}` },
    h('span', { class: 'kp-when', title: occurredTitle(v.occurred) }, fmtOccurred(v.occurred)), ' ',
    v.supersededBy ? h('s', {}, v.label) : h('b', {}, v.label),
    v.current ? h('span', { class: 'tag green' }, 'current') : null, ' ',
    h('span', { class: 'faint' }, [
      v.sections.added.length ? `+${v.sections.added.length} sections` : null,
      v.sections.removed.length ? `−${v.sections.removed.length}` : null,
      v.sections.changed.length ? `~${v.sections.changed.length} changed` : null,
    ].filter(Boolean).join(' · ') || 'no section diff'),
    // The pointer to what replaced it opens the semantic patch itself (CKC-26 AC-4: "指向替代它的内容与 patch"). Of a
    // document an object sits in, it is the document's version that was superseded, not the object.
    v.supersededBy ? h('div', { class: 'kp-sup' }, `${doc ? 'This version of the document superseded' : 'Superseded'}${v.supersededBy.partial ? ' in part' : ''} by `,
      h('button', { class: 'text-btn kp-patch-link', title: 'Open the semantic patch: what no longer holds, what replaced it, who is affected', onClick: (e) => { e.stopPropagation(); void openPatch(v.supersededBy.patchId); } }, `${v.supersededBy.number} · ${v.supersededBy.title}`)) : null);
  return h('div', { class: 'kp-block' },
    h('h4', {}, `Versions (${vs.length})`),
    ...vs.slice().reverse().slice(0, 4).map(line),
    vs.length > 4 ? h('details', { class: 'fold kp-more' }, h('summary', {}, `All ${vs.length} versions`), h('div', { class: 'content' }, ...vs.slice().reverse().map(line))) : null,
    versions.historyFrom ? h('div', { class: 'faint' }, `Under version control only from ${versions.historyFrom} — earlier versions cannot be shown.`) : null);
}

/**
 * The history of the document an object sits in, labelled as that document's (owner 2026-09-30: D1's popover showed
 * DECISIONS.md's 43 steps, 15 versions and the patch that archived a whole generation as if they were D1's own):
 * "design/DECISIONS.md · 43 steps · 15 versions", folded in the popover, open in the full details.
 */
function documentHistoryBlock(document, steps, versions, { open = false } = {}) {
  const vs = versions?.versions ?? [];
  if (!steps.length && !vs.length) return null;
  const counts = [steps.length ? `${steps.length} step${steps.length === 1 ? '' : 's'}` : null, vs.length ? `${vs.length} version${vs.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
  return h('details', { class: 'kp-block kp-doc-history', open: open || null },
    h('summary', { title: 'The document this sits in: its versions, commits and patches. They are the document’s history, not this object’s own.' },
      h('span', { class: 'kp-doc-kicker' }, 'History of the document it sits in'), ' ', h('span', { class: 'kp-doc-name' }, `${document} · ${counts}`)),
    steps.length ? h('div', { class: 'kp-doc-steps' }, ...stepLines(steps, { doc: true })) : null,
    versionsBlock(versions, { doc: true }));
}

/** What is open on this object: lit breakpoints and open send-backs, each with its evidence's original lines and its
 *  actions (§6.4, §1.18; CKC-24 AC-3 "Observed reality 写明是哪几条、原文那一行"). */
function openItemsBlock(open) {
  if (!open || (!open.breakpoints.length && !open.sendBacks.length)) return null;
  return h('div', { class: 'kp-block kp-open' },
    h('h4', {}, 'Open on this object'),
    ...open.breakpoints.map((b) => h('div', { class: 'kp-openitem', dataset: { breakpoint: b.id } },
      h('span', { class: 'tag red' }, `⚠ ${b.kind}`), ' ', basisNote(b.basis), ' ', h('span', { class: 'kp-what' }, b.why), ' ',
      noActionBtn('breakpoint', b.id, `Breakpoint ${b.kind}: ${b.why}`),
      evidenceList(b.evidence))),
    ...open.sendBacks.map((s) => h('div', { class: 'kp-openitem', dataset: { sendback: s.id } },
      h('span', { class: 'tag red' }, `↩ ${s.stage}`), ' ', h('span', { class: 'kp-what' }, s.what), ' ',
      s.suggestion ? h('div', { class: 'faint' }, s.suggestion) : null,
      copyBtn(s), ' ', noActionBtn('sendback', s.id, `Send-back ${s.id}: ${s.what}`),
      evidenceList(s.evidence))));
}

/** The code territories a work changed (§6.17 "从过程视图的工作跳到它改过的领地"): each opens in `Code`. */
function codeChangedBlock(territories) {
  if (!territories?.length) return null;
  return h('div', { class: 'kp-block kp-code' },
    h('h4', {}, `Code it changed (${territories.length})`),
    h('div', { class: 'row wrap' }, ...territories.map((t) => h('button', {
      class: 'btn small kp-terr', dataset: { territory: t.territoryId }, title: `${t.files} file${t.files === 1 ? '' : 's'} of ${t.name} changed by its commits and merges (${t.commits.join(', ')}) — open it in Code`,
      onClick: (e) => { e.stopPropagation(); openTerritory(t.territoryId); },
    }, `${t.name} ×${t.files}`))));
}

/** The popover's and the full details' increment-K blocks, in the order §6.4 lists them. */
export function popoverBlocks(k, { surface = 'popover' } = {}) {
  if (!k) return [];
  const steps = k.lineage?.steps ?? [];
  const docSteps = steps.filter((st) => st.about === 'document');
  const document = k.lineage?.document ?? k.versions?.document ?? null;
  // An object that is the whole document (or a view that does not say whose a step is) keeps one trail: its own.
  const history = document && docSteps.length
    ? [lineageBlock(steps.filter((st) => st.about !== 'document')), documentHistoryBlock(document, docSteps, k.versions, { open: surface === 'full' })]
    : [lineageBlock(steps), versionsBlock(k.versions)];
  return [openItemsBlock(k.open), codeChangedBlock(k.territories), sessionsBlock(k.sessions, draftCtx()), ...history].filter(Boolean);
}

// ── the top bar: breakpoints still lit (§6.2, §2.12; CKC-24 AC-7) ───────────────────────────────────────────
let labelCache = null;
export async function fetchLabels() {
  if (labelCache) return labelCache;
  try {
    const g = await (await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/graph`)).json();
    labelCache = new Map((g.nodes ?? []).map((n) => [n.id, n.label]));
  } catch { labelCache = new Map(); }
  return labelCache;
}

/** Fills `#k-bp-count` in the top bar: the lit breakpoints and open send-backs, opening to a list by kind. */
export async function updateCounts({ refresh = false } = {}) {
  const mount = document.getElementById('k-bp-count');
  if (!mount || !state.projectId) return;
  await load(state.projectId, { refresh });
  const c = proc?.counts;
  const n = (c?.breakpointsLit ?? 0) + (c?.sendBacksOpen ?? 0);
  const btn = h('button', { class: 'btn small kp-count', title: 'Breakpoints still lit and send-backs still open', onClick: () => flyout.toggle({ button: btn, label: 'Breakpoints and send-backs', className: 'kp-counts-panel', render: countsPanel }) },
    c?.breakpointsLit ? `⚠ ${c.breakpointsLit}` : null, c?.breakpointsLit && c?.sendBacksOpen ? ' · ' : null, c?.sendBacksOpen ? `↩ ${c.sendBacksOpen}` : null);
  const next = n ? btn : h('span', {});
  if (mount.firstChild?.outerHTML === next.outerHTML) return;
  clear(mount); mount.append(next);
}

function countsPanel() {
  const lit = (proc?.breakpoints ?? []).filter((b) => b.lit);
  const open = (proc?.sendBacks ?? []).filter((s) => s.lit);
  // A code territory is found in `Code`, anything else on the graph.
  const locate = (id, onTerritory = false) => { flyout.close(); void locateTarget(id, onTerritory); };
  const byKind = new Map();
  for (const b of lit) byKind.set(b.kind, [...(byKind.get(b.kind) ?? []), b]);
  // The row's words open the item beside the panel, with its evidence's original lines (CKC-24 AC-3).
  const opener = (text, open) => { const btn = h('button', { class: 'text-btn kp-what', title: 'Open it: its evidence and the original lines', onClick: () => { const r = rectOfEl(btn); flyout.close(); open(() => r); } }, text); return btn; };
  return [
    h('h4', {}, `Breakpoints still lit (${lit.length})`),
    ...[...byKind.entries()].map(([kind, list]) => h('div', {},
      h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'tag red' }, kind), h('small', { class: 'faint' }, `${list.length}`)),
      ...list.map((b) => h('div', { class: 'kp-countrow' },
        h('button', { class: 'text-btn', title: 'Locate the object it hangs on', onClick: () => locate(b.targetId) }, '◈'),
        opener(b.why, (a) => openBreakpointPopover(b.id, a)), ' ', basisNote(b.basis), ' ',
        noActionBtn('breakpoint', b.id, `Breakpoint ${b.kind}: ${b.why}`))))),
    h('h4', {}, `Send-backs still open (${open.length})`),
    ...open.map((s) => h('div', { class: 'kp-countrow' },
      h('button', { class: 'text-btn', title: s.onTerritory ? 'Show the code territory it hangs on, in Code' : 'Locate the object it hangs on', onClick: () => locate(s.targetId, s.onTerritory) }, '◈'),
      h('span', { class: `tag ${s.stage === 'Suggested' ? 'red' : 'amber'}` }, s.stage), ' ', opener(s.what, (a) => openSendBackPopover(s.id, a)), ' ',
      copyBtn(s), ' ', noActionBtn('sendback', s.id, `Send-back ${s.id}: ${s.what}`))),
    !lit.length && !open.length ? h('div', { class: 'faint' }, 'Nothing is lit.') : null,
  ];
}

// ── the process filters (AC-16), counted beside graph-tools.js's FILTERS (whose list is pinned by its test) ──────
export const SIX_THING = { 1: 'stale', 2: 'drift', 3: 'dropped along the way', 4: 'grown by itself', 5: 'let pass', 6: 'looks residual' };
export function activeProcessFilters(f) {
  const out = [];
  if (f?.bpKind) out.push({ key: 'bpKind', label: 'Breakpoint kind', value: f.bpKind });
  if (f?.sbStage) out.push({ key: 'sbStage', label: 'Send-back stage', value: f.sbStage });
  if (f?.sixThing) out.push({ key: 'sixThing', label: 'Six things', value: `${f.sixThing} · ${SIX_THING[f.sixThing] ?? f.sixThing}` });
  return out;
}

// ── misc wiring ────────────────────────────────────────────────────────────
/**
 * `Expand all` and `Fold all` of the control row (AC-11, AC-12; E153): one fold rule for List and Graph. `blocks` is the
 * List's own part — its blocks open and close with the works (views.js); the Graph has none. Null when there is
 * nothing to open.
 */
export function foldAllButtons(onChange, blocks = null) {
  if (!(proc && fold.any()) && !blocks) return null;
  const all = (on) => () => { fold.setAll(on); blocks?.setAll(on); onChange(); };
  return [
    h('button', { class: 'btn small', title: blocks ? 'Open every block of the List and every work’s process' : 'Open every work’s process', onClick: all(true) }, 'Expand all'),
    h('button', { class: 'btn small', title: blocks ? 'Fold every block of the List to its head, and every work’s process' : 'Fold every work’s process again', onClick: all(false) }, 'Fold all'),
  ];
}

/**
 * Brings the object a breakpoint or send-back hangs on into view: a code territory in `Code`, anything else on the graph.
 * Also the jump of a Follow up result's news to the object an entry is on (views.js).
 */
export async function locateTarget(targetId, onTerritory = false) {
  if (onTerritory) { openTerritory(targetId); return; }
  const labels = await fetchLabels();
  popover.close('navigate');
  flyout.close();
  const sel = { kind: 'node', id: targetId, label: labels.get(targetId) ?? targetId };
  // From `Code` the graph comes back with the object picked (as a territory's `Built by` does).
  if (state.view === 'graph' && state.graphMode === 'code') { state.graphMode = 'graph'; state.selection = sel; state.pendingPopover = {}; await renderBody(); return; }
  if (state.view !== 'graph') navigate(state.projectId, 'graph');
  select(sel, { reveal: true });
}

/**
 * A send-back beside what was pressed (§1.18): the ellipse on the graph, a flag in the List, an anomaly in `Code`. It is
 * not a graph object, so no node popover exists. `sbOrId` is the send-back itself (Code carries its own) or its id.
 */
export function openSendBackPopover(sbOrId, anchor) {
  const sb = typeof sbOrId === 'string' ? proc?.sendBacks.find((s) => s.id === sbOrId) : sbOrId;
  if (!sb) return false;
  popover.open({
    key: `sendback:${sb.id}`, label: `Send-back ${sb.id}`,
    anchor,
    render: (mount) => append(mount,
      h('div', { class: 'popover-head' }, h('div', { class: 'grow' }, h('h3', { class: 'popover-title' }, `↩ ${sb.stage} · back to ${sb.to === 'Plan' ? 'Plan' : 'Work'}`), h('div', { class: 'popover-sub' }, `Send-back · ${sb.id}${sb.sixThing ? ` · six things ${sb.sixThing}` : ''}${sb.from?.kind === 'code-anomaly' ? ' · from a code anomaly' : ''}`)), h('button', { class: 'popover-close', title: 'Close (Esc)', onClick: () => popover.close('button') }, '×')),
      h('div', { class: 'popover-body' },
        h('p', { class: 'popover-sentence' }, sb.what),
        h('div', {}, h('h4', {}, 'Suggestion'), h('p', { class: 'popover-sentence' }, sb.suggestion)),
        h('div', { class: 'kp-when', title: occurredTitle(sb.occurred) }, fmtOccurred(sb.occurred)),
        sb.returned ? h('div', { class: 'faint' }, `Returned → ${sb.returned.label} · ${fmtOccurred(sb.returned.occurred)}`) : null,
        sb.closed ? h('div', { class: 'faint' }, `Closed — ${sb.closed.label} · ${fmtOccurred(sb.closed.occurred)}`) : null,
        sb.ownerResponse ? h('div', { class: 'faint' }, `Your answer: no action needed — ${sb.ownerResponse.reason}`) : null,
        sb.evidence?.length ? h('div', { class: 'kp-block' }, h('h4', {}, 'Evidence'), evidenceList(sb.evidence)) : null,
        h('div', { class: 'row wrap popover-actions' }, copyBtn(sb), sb.lit ? noActionBtn('sendback', sb.id, `Send-back ${sb.id}: ${sb.what}`) : null,
          h('button', { class: 'btn small', title: sb.onTerritory ? 'Show the code territory it hangs on, in Code' : 'Locate the object this send-back hangs on', onClick: () => locateTarget(sb.targetId, sb.onTerritory) }, sb.onTerritory ? 'Show in Code' : 'Show on object'))),
      ),
  });
  return true;
}

/**
 * A breakpoint beside its flag (§2.12; CKC-24 AC-3, AC-7): which step has no trace, since when, on what basis, and its
 * evidence — the ledger entries and the original lines themselves, e.g. the report's line an open item was left in.
 */
export function openBreakpointPopover(bpId, anchor) {
  const bp = proc?.breakpoints.find((b) => b.id === bpId);
  if (!bp) return false;
  const sb = bp.sendBackId ? proc.sendBacks.find((s) => s.id === bp.sendBackId) : null;
  popover.open({
    key: `breakpoint:${bp.id}`, label: `Breakpoint ${bp.kind}`,
    anchor,
    render: (mount) => append(mount,
      h('div', { class: 'popover-head' }, h('div', { class: 'grow' }, h('h3', { class: 'popover-title' }, `⚠ ${bp.kind}`), h('div', { class: 'popover-sub' }, `Breakpoint · ${bp.basis}${bp.sixThing ? ` · six things ${bp.sixThing} (${SIX_THING[bp.sixThing]})` : ''}`)), h('button', { class: 'popover-close', title: 'Close (Esc)', onClick: () => popover.close('button') }, '×')),
      h('div', { class: 'popover-body' },
        h('p', { class: 'popover-sentence' }, bp.why),
        h('div', { class: 'kp-when', title: occurredTitle(bp.since) }, `Due since ${fmtOccurred(bp.since)}`),
        bp.ownerResponse ? h('div', { class: 'faint' }, `Your answer: no action needed — ${bp.ownerResponse.reason}`) : null,
        h('div', { class: 'kp-block' }, h('h4', {}, 'Evidence — the original lines'), evidenceList(bp.evidence) ?? h('div', { class: 'faint' }, 'No evidence line recorded.')),
        sb ? h('div', { class: 'kp-block' }, h('h4', {}, 'Send-back'), h('div', { class: 'kp-openitem' }, h('span', { class: `tag ${sb.stage === 'Closed' ? 'green' : 'red'}` }, `↩ ${sb.stage}`), ' ', h('span', { class: 'kp-what' }, sb.what), ' ', sb.stage !== 'Closed' ? copyBtn(sb) : null)) : null,
        h('div', { class: 'row wrap popover-actions' }, bp.lit ? noActionBtn('breakpoint', bp.id, `Breakpoint ${bp.kind}: ${bp.why}`) : null,
          h('button', { class: 'btn small', title: 'Locate the object this breakpoint hangs on', onClick: () => locateTarget(bp.targetId) }, 'Show on object'))),
      ),
  });
  return true;
}

/** A semantic patch's details (§1.17; CKC-26 AC-4): the words `pk get SP-n` prints, and the objects it affects. */
export async function openPatch(patchId) {
  let p;
  try { p = await K.getPatch(state.projectId, patchId); } catch (e) { toast(`${patchId}: ${e.message}`); return; }
  if (!p) { toast(`${patchId}: ${NO_DATA}`); return; }
  const text = h('div', { class: 'md kp-patch-text' });
  if (p.text) fillMarkdown(text, p.text);
  const dialog = openDialog(`${p.number} · ${p.title}`, [
    h('div', { class: 'row wrap' }, h('span', { class: `tag ${p.status === 'Confirmed' ? 'green' : p.status === 'Rejected' ? 'strike' : 'amber'}` }, p.status), p.partial ? h('span', { class: 'tag amber', title: 'Only part of the old state is withdrawn; the rest stays current' }, 'Partial') : null,
      h('span', { class: 'kp-when', title: occurredTitle(p.occurred) }, fmtOccurred(p.occurred)), h('span', { class: 'tag', title: 'Numbered by the Keeper' }, "Keeper's number")),
    h('div', { class: 'kp-patch-four' },
      h('div', {}, h('small', { class: 'faint' }, 'No longer holds'), h('div', {}, h('s', {}, p.invalidated))),
      h('div', {}, h('small', { class: 'faint' }, 'Replaced by'), h('div', {}, p.replacedBy)),
      h('div', {}, h('small', { class: 'faint' }, 'Affects'), h('div', {}, p.affectsText), p.affects?.length ? h('div', { class: 'row wrap' }, ...p.affects.map((a) => h('button', { class: 'text-btn', title: 'Show it', onClick: () => { document.querySelector('#dialog')?.close(); void locateTarget(a.id); } }, a.label))) : null),
      h('div', {}, h('small', { class: 'faint' }, 'Must not pass as current again'), h('div', {}, p.mustNotPassAsCurrent))),
    p.text ? h('details', { class: 'fold' }, h('summary', {}, 'As the agent entry prints it (pk get)'), text) : null,
  ]);
  dialog.classList.add('patch-dialog');
}

/** An earlier generation's plan document as it stood (§2.12, D82): the ledger's copy, a deleted one from before its deletion. */
export async function openGenerationPlan(generationId, index, label, from = 1) {
  let v;
  try { v = await K.getGenerationPlan(state.projectId, generationId, index, from); } catch (e) { openDialog(label, [h('p', { class: 'muted' }, `Could not load: ${e.message}`)]); return; }
  if (!v) { openDialog(label, [h('p', { class: 'muted' }, NO_DATA)]); return; }
  const first = v.fromLine ?? 1;
  const body = [
    h('dl', { class: 'kv' },
      v.path ? h('dt', {}, 'Document') : null, v.path ? h('dd', { class: 'mono' }, v.path) : null,
      v.version ? h('dt', {}, 'Version read') : null, v.version ? h('dd', {}, h('span', { class: 'mono' }, v.version.commit), ' · ', h('span', { class: 'kp-when', title: occurredTitle(v.version.occurred) }, fmtOccurred(v.version.occurred))) : null,
      v.deleted ? h('dt', {}, 'Deleted') : null, v.deleted ? h('dd', { class: 'kp-deleted' }, `in ${v.deleted.commit} · ${fmtOccurred(v.deleted.occurred)} — this is the version before its deletion`) : null,
      h('dt', {}, 'Now'), h('dd', {}, v.current ? 'This version is still the current one' : v.deleted ? 'Gone from the current version' : 'A later version replaced it')),
    v.text !== null
      ? h('div', { class: 'source-quote kp-plan-text' }, ...v.text.split('\n').map((line, i) => h('div', { class: 'src-line' }, h('span', { class: 'no' }, first + i), h('span', { class: 'tx' }, line))))
      : h('p', { class: 'muted' }, v.why ?? NO_DATA),
    // A long document comes in pages (the ledger's own paging): the next page opens on top, with a way back.
    v.truncated && v.text !== null ? h('div', { class: 'dialog-foot' }, h('span', { class: 'faint' }, `Lines ${first}–${first + v.text.split('\n').length - 1} of ${v.lines}`),
      v.nextFromLine ? h('button', { class: 'btn small', onClick: () => openGenerationPlan(generationId, index, label, v.nextFromLine) }, `Lines ${v.nextFromLine}–…`) : null) : null,
  ];
  const dialog = openDialog(label, body);
  dialog.classList.add('genplan-dialog');
}
