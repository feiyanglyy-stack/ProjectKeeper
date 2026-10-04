// §6.9, §3.3, §3.10 a round in the Keeper view: the round is one item; below it the ledger, the session drafts, the
// main agent — the stage it is in and each stage's time — with the lanes it sent (what each answers, its slots, status,
// what it read, its brief and report) and the coverage check with each account, then the spot check and the process
// (D99). A round from before D99 reads as its steps: orientation, skeleton, the deep sweeps and their reading
// assignments, cross-check, synthesis and spot check — each with its scope, status, time split, tokens and openable
// documents (CKC-23). Pure rendering: data comes in as parameters.
import { h, fmtTime } from '../app.js';
import { fillMarkdown } from '../markdown.js';

const ensureStyle = () => {
  if (document.getElementById('k-views-css')) return;
  const link = document.createElement('link');
  link.id = 'k-views-css';
  link.rel = 'stylesheet';
  link.href = '/k/k-views.css';
  document.head.append(link);
};

const num = (n) => Number(n).toLocaleString('en-US');
const ms = (v) => {
  if (v == null) return '—';
  if (v < 60000) return `${Math.round(v / 1000)} s`;
  const m = v / 60000;
  return `${m >= 20 ? Math.round(m) : m.toFixed(1)} min`;
};
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const hm = (iso) => (iso ? iso.slice(11, 16) : '—');

export const STEP_LABEL = {
  ledger: 'Ledger (program)', 'session-drafts': 'Session drafts', orientation: 'Orientation',
  skeleton: 'Skeleton', dig: 'Deep sweep', 'cross-check': 'Cross-check', process: 'Process and breakpoints', synthesis: 'Synthesis', 'spot-check': 'Spot check',
  // D99: one main agent through the stages, and the lanes it sends.
  main: 'Main agent', lane: 'Lanes',
};

// ── D99: the main agent's stages, its lanes and the coverage check (Spec §3.3, §3.10, §6.9) ──

/** The stages of the main agent's session, by the words the Keeper view uses (ClerkStage). */
export const STAGE_LABEL = {
  orientation: 'Orientation', skeleton: 'Skeleton', reconcile: 'Reconcile the lanes', dig: 'Dig by question',
  coverage: 'Coverage check', 'cross-check': 'Cross-check', synthesis: 'Synthesis',
};
/**
 * The main agent's stages in each kind of round, in order (clerk-steps.ts ROUND_STAGES). D103: the synthesis is a step of
 * its own after the main agent's handover; a round recorded before still lists it as the last stage it ran.
 */
const ROUND_STAGES = {
  'First usable': ['orientation', 'skeleton', 'reconcile'],
  Deepen: ['orientation', 'dig', 'coverage', 'cross-check'],
  'Follow up': ['orientation', 'skeleton', 'reconcile', 'dig', 'coverage', 'cross-check'],
};
/** What a lane answers (LaneKind). */
export const LANE_KIND_LABEL = { slot: 'slots', plan: 'plan or stage', topic: 'topic', 'follow-up': 'follow-up' };
/** A round the main agent runs carries `main`; a round from before D99 reads as its steps. */
export const isMainAgentRound = (round) => Boolean(round && round.main);

const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
/** What a lane read, each material once (RoundLaneView.read), in one line. */
export const readText = (r) => {
  const parts = [r.files ? plural(r.files, 'file') : null, r.versions ? plural(r.versions, 'version') : null, r.commits ? plural(r.commits, 'commit') : null, r.sessions ? plural(r.sessions, 'session') : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'nothing recorded';
};
/** The most lanes that ran at the same time, from their start and end. */
export const lanesAtOnce = (lanes) => {
  const edges = lanes.filter((l) => l.startedAt).flatMap((l) => [[Date.parse(l.startedAt), 1], [l.endedAt ? Date.parse(l.endedAt) : Infinity, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let n = 0, most = 0;
  for (const [, d] of edges) { n += d; most = Math.max(most, n); }
  return most;
};
/** The coverage check in one line: untouched, accounted for, settled (RoundCoverageView). */
export const coverageText = (c) => {
  if (!c) return 'not run yet';
  const materials = (c.untouched ?? []).reduce((n, g) => n + g.count, 0);
  const notNeeded = c.accounted.filter((a) => a.outcome === 'not needed').length;
  const part = c.accounted.filter((a) => a.outcome === 'part').length;
  return [
    c.untouched === null ? 'its listing was not recorded' : c.untouched.length ? `${plural(materials, 'material')} in ${plural(c.untouched.length, 'group')} untouched by any lane` : 'every planned material touched by a lane',
    c.accounted.length ? `${plural(c.accounted.length, 'account')} (${num(notNeeded)} not needed, ${num(part)} in part)` : 'no account written',
    c.settled ? 'settled' : 'not settled',
  ].join(' · ');
};

const SEGMENTS = [
  ['generationMs', 'kv-seg-gen', 'model generation'],
  ['toolMs', 'kv-seg-tool', 'tool execution'],
  ['queueMs', 'kv-seg-queue', 'queue'],
  ['parseRetryMs', 'kv-seg-parse', 'parse & retry'],
  ['otherMs', 'kv-seg-other', 'other'],
];

function timingRow(t) {
  if (!t) return null;
  return h('div', {
    class: 'kv-timing',
    dataset: { wall: t.wallMs, gen: t.generationMs, tool: t.toolMs, queue: t.queueMs, parse: t.parseRetryMs, other: t.otherMs },
  },
    h('span', { class: 'kv-bar' }, SEGMENTS.map(([k, cls, label]) =>
      h('span', { class: cls, title: label, style: `width:${t.wallMs ? (t[k] / t.wallMs) * 100 : 0}%` }))),
    SEGMENTS.map(([k, cls, label]) => h('span', { class: 'kv-legend' }, h('i', { class: cls }), `${label} ${ms(t[k])}`)),
    h('span', { class: 'kv-strong' }, `wall ${ms(t.wallMs)}`));
}

function usageRow(u) {
  if (!u) return null;
  return h('div', { class: 'kv-usage' },
    `tokens in ${tok(u.input)} · out ${tok(u.output)} · cache read ${tok(u.cacheRead)}`,
    u.cost != null ? ` · $${u.cost.toFixed(3)}` : '');
}

function docButton(roundId, d, ctx) {
  let panel = null;
  const btn = h('button', {
    class: 'btn small kv-btn', type: 'button', dataset: { doc: d.id, kind: d.kind },
    onClick: async () => {
      if (panel) { panel.remove(); panel = null; return; }
      panel = h('div', { class: 'kv-doc-panel' }, h('div', { class: 'kv-doc-loading' }, 'Loading…'));
      // Under the step it belongs to, or — a sweep's own document, such as a brief the program composed — under the sweep.
      (btn.closest('.kv-step') ?? btn.closest('.kv-dig-path'))?.append(panel);
      try {
        const doc = await ctx.fetchDoc(roundId, d.id);
        panel.replaceChildren();
        if (!doc) { panel.append(h('div', { class: 'kv-none' }, 'Document not found.')); return; }
        fillMarkdown(panel, doc.markdown);
      } catch (e) {
        panel.replaceChildren(h('div', { class: 'kv-none' }, `Could not load: ${e.message}`));
      }
    },
  }, `${d.kind} · ${d.title}`);
  // When the document was written (RoundDocRef.at), beside its button.
  return d.at ? h('span', { class: 'kv-docitem' }, btn, h('span', { class: 'kv-faint kv-doc-at', title: 'When the document was written' }, fmtTime(d.at))) : btn;
}

/**
 * The session drafts a session-drafts step wrote (RoundStepView.drafts; CKC-23 AC-18): one line per session — host,
 * session, when, how many owner lines and how they were read — each opening the draft (ctx.openDraft).
 */
function draftsRow(drafts, ctx) {
  if (!drafts) return null;
  if (!drafts.length) return h('div', { class: 'kv-drafts kv-none' }, 'No session drafted in this step.');
  const count = (d) => [`${d.ownerLines} owner line${d.ownerLines === 1 ? '' : 's'}`, d.decisions ? `${d.decisions} decision${d.decisions === 1 ? '' : 's'}` : null,
    d.confirmations ? `${d.confirmations} confirmation${d.confirmations === 1 ? '' : 's'}` : null, d.unjudged ? `${d.unjudged} not yet classified` : null].filter(Boolean).join(' · ');
  return h('details', { class: 'kv-drafts' },
    h('summary', { class: 'kv-text-btn' }, `Session drafts written · ${drafts.length}`),
    h('ul', { class: 'kv-draft-list' }, drafts.map((d) => h('li', { dataset: { draft: d.id ?? '' } },
      ctx.openDraft && d.id
        ? h('button', { class: 'btn small kv-btn kv-draft', type: 'button', title: 'Open the draft: the owner’s words verbatim with their kind, and what the agents said, as claims', onClick: () => ctx.openDraft(d.id) }, `${d.host} ${d.sessionId.slice(0, 8)}`)
        : h('span', { class: 'kv-mono' }, `${d.host} ${d.sessionId.slice(0, 8)}`),
      h('span', { class: 'kv-faint' }, ` ${d.startedAt ? `${d.startedAt.slice(0, 10)} ${hm(d.startedAt)}` : ''} · ${count(d)}`)))));
}

/** The sweep the program added for this deep-sweep step, when it is one (RoundView.sweepsAdded; CKC-23 AC-4). */
const addedSweep = (s, round) => (s.kind === 'dig' && s.path ? (round?.sweepsAdded ?? []).find((x) => x.path === s.path) ?? null : null);

/** A reading assignment's number and whether it is a follow-up, from its job's label ("… · assignment 3 (follow-up)"). */
const assignmentOf = (s) => {
  const m = /· assignment (\d+)( \(follow-up\))?$/.exec(s.label || '');
  return m ? { n: Number(m[1]), followUp: Boolean(m[2]) } : null;
};

/**
 * What of a round did not finish (Spec §3.10): the coverage's failure list (ctx.failures) holds every job of a round's
 * step that did not finish, with why and where it stands — run again by the program, waiting for the owner, or listed
 * with the round going on without it. A round's are the ones whose job is one of its steps.
 */
function failuresOf(round, ctx) {
  const steps = new Map(round.steps.map((s) => [s.jobId, s]));
  return (ctx.failures ?? []).filter((f) => steps.has(f.ref)).map((f) => ({ ...f, step: steps.get(f.ref) }));
}

/** The round's note of what did not finish, each with its reason and a Retry — Continue for a stopped one (ctx.runAgain). */
function failuresNote(round, failures, ctx) {
  if (!failures.length) return null;
  const head = round.status === 'Running'
    ? `${failures.length === 1 ? 'A job has' : `${failures.length} jobs have`} not finished in this round:`
    : `${failures.length === 1 ? 'A job' : `${failures.length} jobs`} did not finish; the round closed without ${failures.length === 1 ? 'it' : 'them'}:`;
  return h('div', { class: 'kv-round-note kv-failures', dataset: { failures: failures.length } },
    h('div', {}, head),
    h('ul', {}, failures.map((f) => {
      const action = f.step.status === 'Stopped' ? 'continue' : 'retry';
      return h('li', { dataset: { job: f.ref, kind: f.step.kind } },
        h('span', { class: 'kv-fail-reason' }, f.reason),
        ctx.runAgain ? h('button', { class: 'btn small kv-btn', type: 'button', title: action === 'retry' ? 'Run this job again: it goes on from what it saved, told why it ended' : 'Continue this job from what it saved', onClick: () => ctx.runAgain(f.ref, action) }, action === 'retry' ? 'Retry' : 'Continue') : null);
    })));
}

function stepView(roundId, s, ctx, round, inPath = false) {
  const failed = /fail/i.test(s.status || '') || (ctx.failures ?? []).some((f) => f.ref === s.jobId);
  const added = inPath ? null : addedSweep(s, round);
  const asg = inPath ? assignmentOf(s) : null;
  // An added sweep's brief is the one the program composed: a document of the round no job wrote, so it rides here.
  const docs = added?.doc && !s.docs.some((d) => d.id === added.doc.id) ? [added.doc, ...s.docs] : s.docs;
  return h('li', { class: `kv-step${failed ? ' kv-failed' : ''}${added ? ' kv-added' : ''}${asg ? ' kv-assignment' : ''}`, dataset: { kind: s.kind, job: s.jobId, path: s.path ?? '', ...(asg ? { assignment: asg.n } : {}) } },
    h('div', { class: 'kv-step-head' },
      h('span', { class: 'kv-step-label' }, asg ? `Reading assignment ${asg.n}` : STEP_LABEL[s.kind] ?? s.label),
      // The main agent says which stage it has reached (Spec §6.9).
      // D103: once it handed the round over to the synthesis, it says so; its Handover opens among its documents.
      s.kind === 'main' && round?.main ? h('span', { class: 'kv-tag kv-blue kv-main-stage', dataset: { stage: round.main.stage ?? '', handover: round.main.handover ? 'yes' : 'no' } }, round.main.handover ? `handed over to the synthesis ${hm(round.main.handover.at)}` : round.main.stage ? STAGE_LABEL[round.main.stage] ?? round.main.stage : 'not started') : null,
      asg?.followUp ? h('span', { class: 'kv-tag kv-blue', title: 'Takes up what an earlier assignment of this sweep left unread' }, 'follow-up') : null,
      s.path && !inPath ? h('span', { class: 'kv-step-path' }, `— ${s.path}`) : null,
      added ? h('span', { class: 'kv-tag kv-amber kv-added-tag', title: added.why }, 'added by the program') : null,
      s.model ? h('span', { class: 'kv-model' }, `${s.model.id} · thinking ${s.model.thinking ?? 'default'}`) : null,
      h('span', { class: `kv-status${failed ? ' kv-bad' : ''}` }, s.status),
      s.startedAt ? h('span', { class: 'kv-faint' }, `${hm(s.startedAt)}–${hm(s.endedAt)}`) : null),
    timingRow(s.timing),
    usageRow(s.usage),
    s.kind === 'ledger' && round?.ledger ? h('div', { class: 'kv-usage' }, `${num(round.ledger.commitsAdded)} commits added`) : null,
    docs.length ? h('div', { class: 'kv-docs' }, docs.map((d) => docButton(roundId, d, ctx))) : null,
    s.kind === 'session-drafts' ? draftsRow(s.drafts, ctx) : null,
    s.children?.length ? h('ol', { class: 'kv-steps' }, s.children.map((c) => stepView(roundId, c, ctx, round))) : null);
}

function roundSum(round) {
  const cell = (title, lit, ...kids) => h('div', { class: `kv-sum-cell${lit ? ' kv-lit' : ''}`, dataset: { sum: title } },
    h('div', { class: 'kv-sum-title' }, title), ...kids);
  return h('div', { class: 'kv-round-sum' },
    cell('Outputs by position', false,
      h('ul', {}, round.outputs.map((o) => h('li', {}, `${o.position} × ${num(o.count)}`)))),
    cell('Groundwork for later steps & recall', false,
      h('ul', {}, round.groundwork.map((g) => h('li', {}, `${g.kind} × ${num(g.count)}`)))),
    cell(`Unplaced × ${round.unplaced.count}`, round.unplaced.count > 0,
      round.unplaced.count === 0
        ? h('div', { class: 'kv-muted' }, 'everything landed somewhere')
        : h('ul', {}, round.unplaced.reasons.map((r) => h('li', {}, r)))),
    cell('Spot check', round.spotCheck && round.spotCheck.wrong > 0,
      round.spotCheck
        ? h('div', {},
            // CM: a wrong by timing (right when written, overtaken by a later write or recompute) apart from a wrong of substance.
            h('div', {}, `${round.spotCheck.sampled} ${round.spotCheck.synthesis ? 'checked' : 'sampled'} · ${round.spotCheck.wrong} wrong${round.spotCheck.wrongByKind && round.spotCheck.wrong ? ` (${round.spotCheck.wrongByKind.substance} of substance, ${round.spotCheck.wrongByKind.timing} by timing)` : ''} · ${round.spotCheck.corrected} corrected`),
            // D103: what the synthesis wrote and every current note are checked in full, and counted apart from the sample.
            round.spotCheck.synthesis ? h('div', { class: 'kv-muted kv-spot-full', dataset: { outputs: round.spotCheck.synthesis.outputs, checked: round.spotCheck.synthesis.checked, wrong: round.spotCheck.synthesis.wrong } },
              `the synthesis and the notes, in full: ${round.spotCheck.synthesis.checked} of ${round.spotCheck.synthesis.outputs} checked · ${round.spotCheck.synthesis.wrong} wrong; the rest, sampled: ${round.spotCheck.sampled - round.spotCheck.synthesis.checked} checked · ${round.spotCheck.wrong - round.spotCheck.synthesis.wrong} wrong`) : null,
            // CS (D104): the placement readings on a line of their own — the reasons that left an item unplaced, whichever
            // round wrote them, and the program's placements nobody had reviewed.
            round.spotCheck.placement ? h('div', { class: 'kv-muted kv-spot-placement', dataset: { reasons: round.spotCheck.placement.reasons, checked: round.spotCheck.placement.reasonsChecked, wrong: round.spotCheck.placement.reasonsWrong, sampled: round.spotCheck.placement.programPlacementsSampled, placedWrong: round.spotCheck.placement.programPlacementsWrong } },
              `placement: ${round.spotCheck.placement.reasonsChecked} of ${round.spotCheck.placement.reasons} reason${round.spotCheck.placement.reasons === 1 ? '' : 's'} for leaving an item unplaced checked · ${round.spotCheck.placement.reasonsWrong} wrong; ${round.spotCheck.placement.programPlacementsSampled} program placement${round.spotCheck.placement.programPlacementsSampled === 1 ? '' : 's'} sampled · ${round.spotCheck.placement.programPlacementsWrong} wrong`) : null,
            round.standingNotes?.standing ? h('div', { class: 'kv-muted kv-standing-notes', dataset: { standing: round.standingNotes.standing, open: round.standingNotes.open } },
              `notes from earlier rounds: ${round.standingNotes.standing} — ${round.standingNotes.confirmed} confirmed, ${round.standingNotes.updated} updated, ${round.standingNotes.withdrawn} withdrawn${round.standingNotes.open ? `, ${round.standingNotes.open} with no result` : ''}`) : null,
            Object.keys(round.spotCheck.byKind).length
              ? h('div', { class: 'kv-muted' }, `wrong by kind: ${Object.entries(round.spotCheck.byKind).map(([k, n]) => `${k} ×${n}`).join(', ')}`)
              : null,
            // D99: the missing steps the lanes looked for, and those the spot check confirmed and lit (Spec §2.12).
            round.missing ? h('div', { class: 'kv-muted kv-missing-steps', dataset: { looked: round.missing.looked, checked: round.missing.checked } }, `missing steps: ${round.missing.looked} looked for by the lanes · ${round.missing.checked} checked and lit`) : null)
        : h('div', { class: 'kv-muted' }, 'not run')),
    cell('Ledger (program)', false,
      round.ledger
        ? h('div', {}, `${ms(round.ledger.ms)} · ${num(round.ledger.commitsAdded)} commits added`)
        : h('div', { class: 'kv-muted' }, '—')));
}

/**
 * What a sweep read of its plan (PathReading, from the coverage: ctx.deepening), in one line — planned, read whole, in
 * part, not read, still open, and its assignments — with each material recorded as read in part or not read, and why.
 */
function readingLine(r) {
  if (!r) return null;
  const a = r.assignments;
  const going = [a.running ? `${a.running} running` : null, a.queued ? `${a.queued} queued` : null, a.failed ? `${a.failed} failed or stopped` : null].filter(Boolean).join(', ');
  return h('div', { class: 'kv-reading', dataset: { planned: r.planned, whole: r.whole, part: r.part, notRead: r.notRead, open: r.open } },
    h('span', {}, `${num(r.planned)} planned · ${num(r.whole)} read whole · ${num(r.part)} in part · ${num(r.notRead)} not read${r.open ? ` · ${num(r.open)} still open` : ''}`),
    h('span', { class: 'kv-faint' }, ` — ${a.total} assignment${a.total === 1 ? '' : 's'}${a.followUps ? ` (${a.followUps} follow-up${a.followUps === 1 ? '' : 's'})` : ''}: ${a.done} done${going ? `, ${going}` : ''}`),
    r.accounted.length ? h('details', { class: 'kv-accounted' },
      h('summary', { class: 'kv-text-btn' }, `Read in part or not read, with why · ${r.accounted.length}`),
      h('ul', {}, r.accounted.map((x) => h('li', { dataset: { key: x.key, outcome: x.outcome } },
        h('span', { class: `kv-tag ${x.outcome === 'none' ? 'kv-red' : 'kv-amber'}` }, x.outcome === 'none' ? 'not read' : 'in part'), ' ',
        h('span', { class: 'kv-mono' }, x.label), h('span', { class: 'kv-faint' }, ` — ${x.why}${x.by === 'program' ? ' (the program)' : ''}`))))) : null);
}

/** A deepening read by reading assignments: its sweeps, each with its reading line and its assignments under it. */
function sweepsByPath(round, digs, ctx) {
  const dp = ctx.deepening;
  const rows = dp && dp.actual && dp.actual.roundId === round.id ? dp.progress.filter((p) => p.reading) : [];
  const byPath = new Map();
  for (const d of digs) { const k = d.path ?? d.label; byPath.set(k, [...(byPath.get(k) ?? []), d]); }
  if (!rows.length && [...byPath.values()].every((list) => list.length === 1)) return null;
  const readingOf = new Map(rows.map((p) => [p.path, p.reading]));
  return h('div', { class: 'kv-digs', dataset: { assignments: digs.length } },
    h('div', { class: 'kv-digs-head' }, `Deep sweeps — ${byPath.size} path${byPath.size === 1 ? '' : 's'} in parallel, read in ${digs.length} reading assignment${digs.length === 1 ? '' : 's'} on the lanes`),
    ...[...byPath].map(([path, list]) => {
      const added = addedSweep({ kind: 'dig', path }, round);
      const docs = added?.doc ? [added.doc] : [];
      return h('div', { class: 'kv-dig-path', dataset: { path } },
        h('div', { class: 'kv-dig-path-head' }, h('span', { class: 'kv-step-path' }, path),
          added ? h('span', { class: 'kv-tag kv-amber kv-added-tag', title: added.why }, 'added by the program') : null),
        readingLine(readingOf.get(path)),
        docs.length ? h('div', { class: 'kv-docs' }, docs.map((d) => docButton(round.id, d, ctx))) : null,
        h('ol', { class: 'kv-steps' }, list.map((d) => stepView(round.id, d, ctx, round, true))));
    }));
}

/**
 * The main agent's stages (RoundView.main): the stages of this kind of round in order, each with when it ran and how
 * long; the one it is in is tagged, the ones not reached yet are listed faint. A stage it skipped stays faint too.
 */
function stagesBlock(round) {
  const m = round.main;
  const ran = new Map();
  for (const e of m.stages) ran.set(e.stage, e);
  const order = [...new Set([...(ROUND_STAGES[round.kind] ?? []), ...m.stages.map((e) => e.stage)])];
  const split = (t) => (t ? SEGMENTS.map(([k, , label]) => `${label} ${ms(t[k])}`).join(' · ') : '');
  return h('table', { class: 'kv-mini kv-stages', dataset: { stage: m.stage ?? '' } },
    h('thead', {}, h('tr', {}, h('th', {}, 'Stage'), h('th', {}, 'From'), h('th', {}, 'To'), h('th', {}, 'Time'))),
    h('tbody', {}, order.map((stage) => {
      const e = ran.get(stage);
      // A stage not run while a later one did was skipped (a Follow up whose document chain had not changed, §3.3).
      const skipped = !e && order.slice(order.indexOf(stage) + 1).some((x) => ran.has(x));
      const time = e ? e.timing?.wallMs ?? (e.endedAt ? Date.parse(e.endedAt) - Date.parse(e.startedAt) : null) : null;
      return h('tr', { class: e ? '' : 'kv-faint', dataset: { stage, ran: e ? 'yes' : skipped ? 'skipped' : 'no' } },
        h('td', {}, STAGE_LABEL[stage] ?? stage, e?.current ? h('span', { class: 'kv-tag kv-blue', style: 'margin-left:6px' }, 'now') : null),
        h('td', {}, e ? hm(e.startedAt) : '—'), h('td', {}, e ? hm(e.endedAt) : '—'),
        h('td', { title: split(e?.timing) }, e ? ms(time) : skipped ? 'skipped' : 'not reached'));
    })));
}

/** One lane (RoundLaneView): what it answers, its slots, the stage it was sent in, status, what it read, brief and report. */
function laneView(round, l, ctx) {
  const failed = /fail|stop/i.test(l.status || '') || (ctx.failures ?? []).some((f) => f.ref === l.jobId);
  const docs = [l.brief, l.report].filter(Boolean);
  return h('li', { class: `kv-step kv-lane${failed ? ' kv-failed' : ''}`, dataset: { kind: 'lane', lane: l.name, laneKind: l.kind, job: l.jobId ?? '', status: l.status } },
    h('div', { class: 'kv-step-head' },
      h('span', { class: 'kv-step-label' }, l.name),
      h('span', { class: `kv-tag ${l.kind === 'follow-up' ? 'kv-amber' : 'kv-blue'}`, title: 'What the lane answers' }, LANE_KIND_LABEL[l.kind] ?? l.kind),
      l.stage ? h('span', { class: 'kv-faint' }, `sent in ${STAGE_LABEL[l.stage] ?? l.stage}`) : null,
      l.model ? h('span', { class: 'kv-model' }, `${l.model.id} · thinking ${l.model.thinking ?? 'default'}`) : null,
      h('span', { class: `kv-status${failed ? ' kv-bad' : ''}` }, l.status),
      l.startedAt ? h('span', { class: 'kv-faint' }, `${hm(l.startedAt)}–${hm(l.endedAt)}`) : null),
    l.question ? h('div', { class: 'kv-reading kv-question', style: 'white-space:pre-line' }, l.question) : h('div', { class: 'kv-reading kv-none' }, 'No brief found for this lane.'),
    h('div', { class: 'kv-usage kv-slots', dataset: { slots: l.slots.join(' ') } }, `Writes: ${l.slots.length ? l.slots.join(', ') : 'its report only'}`),
    h('div', { class: 'kv-usage kv-lane-read', dataset: { files: l.read.files, versions: l.read.versions, commits: l.read.commits, sessions: l.read.sessions } }, `Read: ${readText(l.read)}`),
    timingRow(l.timing),
    usageRow(l.usage),
    docs.length ? h('div', { class: 'kv-docs' }, docs.map((d) => docButton(round.id, d, ctx))) : null);
}

/** The lanes the main agent sent (RoundView.lanes), in the order sent, with how many ran at once. */
function lanesBlock(round, ctx) {
  const lanes = round.lanes ?? [];
  if (!lanes.length) return h('div', { class: 'kv-digs kv-lanes', dataset: { lanes: 0 } }, h('div', { class: 'kv-digs-head' }, 'Lanes — none sent yet'));
  const most = lanesAtOnce(lanes);
  return h('div', { class: 'kv-digs kv-lanes', dataset: { lanes: lanes.length, atOnce: most } },
    h('div', { class: 'kv-digs-head' }, `Lanes — ${plural(lanes.length, 'lane')} sent by the main agent${most > 1 ? `, up to ${most} at once` : ''}`),
    h('ol', { class: 'kv-steps' }, lanes.map((l) => laneView(round, l, ctx))));
}

/** The coverage check (RoundView.coverage): what it listed as untouched by any lane, and the main agent's account of each. */
function coverageBlock(round) {
  const c = round.coverage ?? null;
  // A round whose kind has no coverage stage (First usable) shows none; a deepening shows it before the check has run too.
  if (!c && !(ROUND_STAGES[round.kind] ?? []).includes('coverage')) return null;
  const followUps = (round.lanes ?? []).filter((l) => l.kind === 'follow-up').length;
  return h('div', { class: 'kv-digs kv-coverage', dataset: { settled: c ? String(c.settled) : 'none' } },
    h('div', { class: 'kv-digs-head' }, 'Coverage check',
      c ? h('span', { class: `kv-tag ${c.settled ? 'kv-green' : 'kv-amber'}`, style: 'margin-left:8px' }, c.settled ? 'settled' : 'not settled') : null,
      c ? h('span', { class: 'kv-faint' }, ` ${fmtTime(c.at)}`) : null),
    h('div', { class: 'kv-coverage-body' },
      h('div', { class: 'kv-reading' }, coverageText(c), followUps ? ` · ${plural(followUps, 'follow-up lane')} sent` : ''),
      c?.untouched?.length ? h('details', { class: 'kv-accounted kv-untouched' },
        h('summary', { class: 'kv-text-btn' }, `Untouched by any lane · ${plural(c.untouched.length, 'group')}`),
        h('ul', {}, c.untouched.map((g) => h('li', { dataset: { group: g.group } },
          h('span', { class: 'kv-mono' }, g.group), h('span', { class: 'kv-faint' }, ` — ${plural(g.count, 'material')}, ${g.category}${g.dir ? ` in ${g.dir}` : ''}`),
          g.keys.length ? h('div', { class: 'kv-faint kv-mono' }, `${g.keys.slice(0, 5).join(', ')}${g.count > 5 ? ', …' : ''}`) : null)))) : null,
      c?.accounted.length ? h('details', { class: 'kv-accounted' },
        h('summary', { class: 'kv-text-btn' }, `Accounted for, with why · ${c.accounted.length}`),
        h('ul', {}, c.accounted.map((a) => h('li', { dataset: { outcome: a.outcome, group: a.group ?? '' } },
          h('span', { class: `kv-tag${a.outcome === 'part' ? ' kv-amber' : ''}` }, a.outcome === 'part' ? 'in part' : 'not needed'), ' ',
          h('span', { class: 'kv-mono' }, a.group ?? (a.keys?.length === 1 ? a.keys[0] : `${plural(a.keys?.length ?? 0, 'material')}`)),
          h('span', { class: 'kv-faint' }, ` — ${a.why}${a.by === 'program' ? ' (the program)' : ''}`))))) : null));
}

/** The main agent's item: its job as a step, then its stages, its lanes and the coverage check under it. */
function mainView(round, s, ctx) {
  const item = s ? stepView(round.id, s, ctx, round)
    : h('li', { class: 'kv-step', dataset: { kind: 'main', job: round.main.jobId ?? '' } }, h('div', { class: 'kv-step-head' }, h('span', { class: 'kv-step-label' }, STEP_LABEL.main), h('span', { class: 'kv-status' }, 'Not started')));
  item.classList.add('kv-main');
  item.append(h('div', { class: 'kv-main-body' }, stagesBlock(round), lanesBlock(round, ctx), coverageBlock(round)));
  return item;
}

/** A round the main agent runs: the ledger and session drafts, the main agent with all under it, the spot check, the process. */
function mainAgentSteps(round, ctx) {
  const steps = round.steps.filter((s) => s.kind !== 'lane');
  const out = steps.map((s) => (s.kind === 'main' ? mainView(round, s, ctx) : stepView(round.id, s, ctx, round)));
  if (!steps.some((s) => s.kind === 'main')) {
    const at = steps.findIndex((s) => !['ledger', 'session-drafts'].includes(s.kind));
    out.splice(at < 0 ? out.length : at, 0, mainView(round, null, ctx));
  }
  return out;
}

function roundView(round, ctx) {
  const d99 = isMainAgentRound(round);
  const steps = d99 ? mainAgentSteps(round, ctx) : [];
  let i = d99 ? round.steps.length : 0;
  while (i < round.steps.length) {
    const s = round.steps[i];
    if (s.kind === 'dig') {
      const digs = [];
      while (i < round.steps.length && round.steps[i].kind === 'dig') { digs.push(round.steps[i]); i += 1; }
      steps.push(sweepsByPath(round, digs, ctx) ?? h('div', { class: 'kv-digs' },
        h('div', { class: 'kv-digs-head' }, `Deep sweeps — ${digs.length} paths in parallel`),
        h('ol', { class: 'kv-steps' }, digs.map((d) => stepView(round.id, d, ctx, round)))));
    } else {
      steps.push(stepView(round.id, s, ctx, round));
      i += 1;
    }
  }
  const digsCount = d99 ? (round.lanes ?? []).length : new Set(round.steps.filter((s) => s.kind === 'dig').map((s) => s.path ?? s.label)).size;
  // A round that ran through closes Done; what did not finish is said with its status, never left out of it.
  const failures = failuresOf(round, ctx);
  return h('section', { class: 'kv-round kv-card', dataset: { round: round.id, kind: round.kind, number: round.number } },
    h('div', { class: 'kv-round-head' },
      h('span', { class: 'kv-tag kv-blue' }, round.kind),
      h('span', { class: 'kv-round-title' }, `Round ${round.number}`),
      h('span', { class: `kv-tag ${failures.length ? 'kv-red' : 'kv-green'}`, dataset: { status: round.status, failures: failures.length } }, failures.length ? `${round.status} · ${failures.length} not finished` : round.status),
      h('span', { class: 'kv-round-meta' }, `${fmtTime(round.startedAt)} → ${hm(round.endedAt)}`),
      h('span', { class: 'kv-round-meta kv-strong' }, `wall ${ms(round.wallMs)}`)),
    round.longestPathMs != null
      ? h('div', { class: 'kv-round-note' }, `longest path ${ms(round.longestPathMs)}${digsCount > 1 ? (d99 ? ` — ${digsCount} lanes, the main agent waiting while they run: the round lasts as long as its longest lane` : ` — ${digsCount} paths in parallel: the round lasts as long as its longest path`) : ''}`)
      : null,
    failuresNote(round, failures, ctx),
    // What the round's end did with the project's `projectkeeper/` folder, or why it could not (RoundView.folder).
    round.folder ? h('div', { class: 'kv-round-note kv-round-folder', dataset: { folder: 'yes' } }, round.folder) : null,
    // The sweeps the program added for kinds of question orientation set none for, each with why (CKC-23 AC-4); the
    // step of each carries the tag and opens the brief the program composed.
    round.sweepsAdded?.length ? h('div', { class: 'kv-round-note kv-sweeps-added', dataset: { added: round.sweepsAdded.length } },
      h('div', {}, round.sweepsAdded.length === 1 ? 'The program added a sweep for a kind of question orientation left out:' : `The program added ${round.sweepsAdded.length} sweeps for kinds of question orientation left out:`),
      h('ul', {}, round.sweepsAdded.map((x) => h('li', { dataset: { path: x.path } }, h('span', { class: 'kv-step-path' }, x.path), ` — ${x.why}`)))) : null,
    resultNote(round, ctx),
    h('ol', { class: 'kv-steps' }, steps),
    roundSum(round));
}

/**
 * A finished Follow up round's one result (§5.5, §6.9): what it found, in one line, and the result itself — which stays
 * reachable here after the owner has opened it from Notes (attention). `ctx.resultOf` gives it; none for other rounds.
 */
function resultNote(round, ctx) {
  const result = round.kind === 'Follow up' ? ctx.resultOf?.(round) ?? null : null;
  if (!result) return null;
  return h('div', { class: 'kv-round-note kv-round-result', dataset: { result: result.id } },
    h('span', {}, `Result: ${result.line}`), ' ',
    h('button', { class: 'btn small kv-btn', type: 'button', title: `Open the result of ${result.name}`, onClick: () => ctx.openResult?.(result) }, 'Open the result'));
}

export function renderRoundTree(container, rounds, ctx) {
  ensureStyle();
  container.replaceChildren();
  container.append(h('div', { class: 'kv-rounds', dataset: { kv: 'rounds' } },
    rounds.length ? rounds.map((r) => roundView(r, ctx)) : h('div', { class: 'kv-none' }, 'No rounds yet.')));
  return container;
}
