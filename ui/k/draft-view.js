// §3.11 a session's draft where the owner drills into a session (CKC-23 AC-18; D88): the owner's lines verbatim, each
// with its kind — chat, decision or confirmation — what a confirmation answers and what it confirms, and the agents'
// intents and reports as claims. Opened from an object's sessions (a work item's session sources) and from the
// session-drafts step of the round that wrote it. Pure rendering over SessionDraftView / SessionDraftRef
// (src/model/views-k.ts); fetching and opening an original go through ctx.
import { h, fmtTime, openDialog } from '../app.js';

const KIND_TONE = { Decision: 'amber', Confirmation: 'green', Chat: '' };
const shortId = (id) => (id && id.length > 12 ? id.slice(0, 8) : id);
const span = (from, to) => (from ? `${fmtTime(from)}${to && to !== from ? ` – ${fmtTime(to)}` : ''}` : 'time not recorded');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The counts of one draft, in words: the owner's lines and how they were read. */
export function draftCounts(d) {
  const lines = d.ownerLines ?? d.counts?.lines ?? 0;
  const n = typeof lines === 'number' ? lines : lines.length;
  const parts = [plural(n, 'owner line')];
  const c = d.counts ?? d;
  if (c.decisions) parts.push(plural(c.decisions, 'decision'));
  if (c.confirmations) parts.push(plural(c.confirmations, 'confirmation'));
  if (c.chat) parts.push(`${c.chat} chat`);
  if (c.unjudged) parts.push(`${c.unjudged} not yet classified`);
  return parts.join(' · ');
}

/** One session as a list names it: host, session, when; with its draft, or saying it has none yet. */
export function draftRefLine(ref, ctx) {
  const head = `${ref.host} session ${shortId(ref.sessionId)}`;
  return h('div', { class: 'kd-ref', dataset: { draft: ref.id ?? '', session: ref.sessionId } },
    ref.id
      ? h('button', { class: 'text-btn kd-open', title: 'Open the draft of this session: the owner’s words verbatim, and what the agents said, as claims', onClick: (e) => { e.stopPropagation(); void ctx.openDraft(ref.id); } }, `Session draft · ${head}`)
      : h('span', { class: 'kd-none', title: 'This session is among the sources, and the round has not drafted it yet' }, `${head} · not drafted yet`),
    ' ', h('span', { class: 'faint' }, `${span(ref.startedAt, ref.endedAt)}${ref.id ? ` · ${draftCounts(ref)}` : ''}`));
}

/** The popover's and the full details' block: the sessions an object stands on, each openable (a work item's sessions). */
export function sessionsBlock(refs, ctx) {
  if (!refs || !refs.length) return null;
  return h('div', { class: 'kp-block kd-sessions' },
    h('h4', {}, `Sessions (${refs.length})`),
    ...refs.map((r) => draftRefLine(r, ctx)));
}

/** One owner line: when, where, its kind, the words verbatim; a confirmation with what it answers and confirms. */
function ownerLine(l, ctx) {
  const kind = l.kind
    ? h('span', { class: `tag ${KIND_TONE[l.kind] ?? ''} kd-kind`, title: l.kind === 'Confirmation' ? 'A decision: the owner said yes to what the agent proposed' : l.kind === 'Decision' ? 'The owner decided something' : 'The owner talking, not deciding' }, l.kind)
    : h('span', { class: 'tag kd-kind kd-unjudged', title: 'The round has not classified this line yet' }, 'Not yet classified');
  return h('div', { class: `kd-line${l.kind ? ` kd-${l.kind.toLowerCase()}` : ''}`, dataset: { ref: l.ref } },
    h('div', { class: 'kd-line-head' },
      h('span', { class: 'kd-when' }, l.at ? fmtTime(l.at) : 'time not recorded'), ' ',
      h('span', { class: 'faint mono', title: 'Its place in the session' }, /^\d+$/.test(l.ref) ? `[${l.ref}]` : l.ref), ' ', kind,
      l.sourceId && ctx.openSource ? h('button', { class: 'text-btn kd-orig', title: 'Read this part of the session as it was read', onClick: () => ctx.openSource(l.sourceId) }, 'Original') : null),
    h('div', { class: 'kd-text', title: 'The owner’s words, verbatim' }, l.text),
    l.kind === 'Confirmation' ? h('div', { class: 'kd-confirm' },
      l.answers ? h('div', {}, h('small', { class: 'faint' }, 'Answers — the agent message just before, verbatim'),
        l.answers.length > 700
          ? h('details', { class: 'fold' }, h('summary', {}, `${l.answers.slice(0, 200)}…`), h('blockquote', { class: 'quote kd-answers' }, l.answers))
          : h('blockquote', { class: 'quote kd-answers' }, l.answers)) : null,
      l.confirms ? h('div', { class: 'kd-confirms' }, h('small', { class: 'faint' }, 'Confirms — in the Keeper’s words'), ' ', l.confirms) : null) : null);
}

/** The draft, read in the dialog (§6.4's reading surface). */
export function draftBody(d, ctx) {
  const c = d.counts;
  return [
    h('dl', { class: 'kv kd-meta' },
      h('dt', {}, 'Session'), h('dd', { class: 'mono' }, `${d.session.host} · ${d.session.sessionId}`),
      h('dt', {}, 'When'), h('dd', {}, span(d.session.startedAt, d.session.endedAt)),
      d.session.file ? h('dt', {}, 'Log') : null, d.session.file ? h('dd', { class: 'mono faint' }, d.session.file) : null,
      h('dt', {}, 'Owner’s lines'), h('dd', { class: 'kd-counts' }, draftCounts(d)),
      h('dt', {}, 'Drafted'), h('dd', {}, (d.writtenBy ?? []).map((w, i) => [i ? ' · ' : null, `${w.roundLabel ?? 'a round'} ${fmtTime(w.at)}`]))),
    h('h4', { class: 'kd-h' }, `The owner’s words (${c.lines})`),
    c.lines ? h('div', { class: 'kd-lines' }, ...d.ownerLines.map((l) => ownerLine(l, ctx))) : h('div', { class: 'faint' }, 'The owner said nothing in this session.'),
    h('h4', { class: 'kd-h' }, `What the agents said they did or meant to do (${d.agentSummary.length})`),
    d.agentSummary.length
      ? h('div', { class: 'kd-claims' }, ...d.agentSummary.map((s) => h('div', { class: 'kd-claim' },
        h('span', { class: 'tag purple', title: 'An agent’s account of itself: a claim, until the ledger or the code shows it' }, 'Claimed'), ' ',
        h('b', {}, s.who), ' ', h('span', { class: 'faint' }, s.at ? fmtTime(s.at) : ''), h('div', { class: 'kd-claim-text' }, s.summary))))
      : h('div', { class: 'faint' }, 'No summary of the agents was written.'),
    h('p', { class: 'faint kd-foot' }, 'The owner’s words and their times are taken from the session by the program, verbatim; which lines are decisions, and the agents’ summary, are the Keeper’s reading.'),
  ];
}

/** Opens one draft in the dialog: `ctx.fetchDraft(key)` gives the SessionDraftView, `ctx.openSource(id)` an original. */
export async function openDraft(key, ctx) {
  let d;
  try { d = await ctx.fetchDraft(key); } catch (e) { openDialog('Session draft', [h('p', { class: 'muted' }, `Could not load: ${e.message}`)]); return null; }
  if (!d) { openDialog('Session draft', [h('p', { class: 'muted' }, 'No draft of this session yet.')]); return null; }
  const dialog = openDialog(`Session draft · ${d.session.host} ${shortId(d.session.sessionId)}`, draftBody(d, ctx));
  dialog.classList.add('draft-dialog');
  return dialog;
}
