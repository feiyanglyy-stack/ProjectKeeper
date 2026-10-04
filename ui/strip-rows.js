// The bottom strip, one line per item (Spec §6.2; CKC-09 AC-38, after WorkflowKeeper's D55): every row is the same four
// slots — mark · one sentence · object · time — and what used to be tags written into the line are its leading marks,
// named on hover. This module says how the slots of a row are taken from an item of /overview, which mark stands for
// which word, and what the header of `Notes (attention)` says about the notes that are not in it (D50). No DOM here:
// items in, rows out, so the rules are tested with `node --test` (src/ui/strip-rows.test.ts). views.js draws them.
//
// A row is { key, marks: [{ glyph, tone, title }], text, object: { text, title }, time, noteId, opens }. `tone` is a
// class of the stylesheet, which gives it one of the colours the interface already has; `time` is an ISO string or
// null; `opens` is an object the row stands for (it then opens that object instead of unfolding).

/** What a note asks of the owner. WorkflowKeeper's ladder for the same three steps (‼ ! ·); the first is the strongest. */
const ASK = Object.freeze({
  'For your decision': { glyph: '‼', tone: 'decide' },
  'Worth discussing': { glyph: '!', tone: 'discuss' },
  'For information': { glyph: '·', tone: 'info' },
});
/** How a note came about (Spec §4.1): a letter in a dashed frame, as the origin tag had a dashed frame. */
const ORIGIN = Object.freeze({ 'Product re-look': 'R', 'Change follow-up': 'C', 'Investigation': 'I', 'Owner question': 'Q' });
/** What is listed with the notes and is not one. */
const NOT_A_NOTE = Object.freeze({
  'scope-question': { glyph: '?', tone: 'decide', name: 'Scope question', about: 'Project scope' },
  job: { glyph: '✓', tone: 'good', name: 'Request finished', about: 'Your request' },
  round: { glyph: '↻', tone: 'info', name: 'Follow up result', about: 'Change follow-up' },
});
/** How a piece of work was cut out of the stream (Spec §1.8, D56). */
const WORK = Object.freeze({ Session: 'S', Execution: 'E', 'Time range': 'T' });
/** The effect of a record written before pieces of work; the tones are the colours the effect tags had. */
const EFFECT = Object.freeze({
  Added: { glyph: '+', tone: 'good' }, Approved: { glyph: '✓', tone: 'good' }, Completed: { glyph: '■', tone: 'good' },
  Replaced: { glyph: '⇄', tone: 'bad' }, Abandoned: { glyph: '×', tone: 'bad' }, Deferred: { glyph: '‖', tone: 'wait' },
  Corrected: { glyph: '~', tone: 'plain' }, Removed: { glyph: '−', tone: 'plain' },
});
const PROGRESS = Object.freeze({ Planned: '○', 'In progress': '◑', Done: '●', 'On hold': '‖' });

const NONE = Object.freeze({ text: '', title: '' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const askMark = (ask, prefix = '') => { const a = ASK[ask]; return a ? { glyph: a.glyph, tone: a.tone, title: `${prefix}${ask}` } : null; };
const effectMark = (effect) => { const e = EFFECT[effect] ?? { glyph: '•', tone: 'plain' }; return { glyph: e.glyph, tone: e.tone, title: effect ?? 'Change' }; };

/** The object slot of a note: what it hangs on. One object by name, the first of several with how many more, or the project. */
function mountSlot(object) {
  if (!object) return NONE;
  if (object.kind === 'project') return { text: 'Whole project', title: 'Whole project' };
  const names = (object.objects ?? []).map((o) => o.label);
  if (names.length === 0) return NONE;
  return { text: names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`, title: names.join('\n') };
}

/** A row of `Notes (attention)`: a note, a scope question, a finished request or a Follow up result. */
export function attentionRow(x) {
  const base = { key: `${x.kind}:${x.id}`, text: x.label ?? '', time: x.at ?? null, noteId: null, opens: null };
  if (x.kind === 'note') {
    const origin = x.cameFrom?.kind ? { glyph: ORIGIN[x.cameFrom.kind] ?? '•', tone: 'origin', title: `Came from: ${x.cameFrom.kind}${x.cameFrom.changes?.length ? ` — ${x.cameFrom.changes.map((c) => c.title).join('; ')}` : ''}` } : null;
    return { ...base, marks: [askMark(x.ask), origin].filter(Boolean), object: mountSlot(x.object), noteId: x.id };
  }
  const k = NOT_A_NOTE[x.kind] ?? { glyph: '•', tone: 'info', name: x.kind, about: '' };
  // A Follow up result with news names the objects its news is about, as a note names what it hangs on; one without
  // (a round closed before rounds counted their news) says where it belongs.
  const objects = x.kind === 'round' && x.news ? mountSlot(x.object) : NONE;
  return { ...base, marks: [{ glyph: k.glyph, tone: k.tone, title: x.ask ? `${k.name} · ${x.ask}` : k.name }], object: objects.text ? objects : { text: k.about, title: k.about } };
}

/** A row of `Recent changes`: one piece of work with how many net changes it made; an older record by effect and title. */
export function changeRow(c) {
  const removed = c.removed?.length ? { glyph: '−', tone: 'bad', title: `Removed: ${c.removed.map((x) => x.label).join(', ')}` } : null;
  if (c.work) {
    const n = (c.items ?? []).length || 1;
    const count = plural(n, 'change');
    return { key: `change:${c.id}`, marks: [{ glyph: WORK[c.work.kind] ?? '•', tone: 'work', title: c.work.kind }, removed].filter(Boolean), text: c.work.label, object: { text: count, title: count }, time: c.at ?? null, noteId: null, opens: null };
  }
  return { key: `change:${c.id}`, marks: [effectMark(c.effect), removed].filter(Boolean), text: c.title ?? '', object: NONE, time: c.at ?? null, noteId: null, opens: null };
}

/**
 * The rows of `Since last visit`: each Follow up round since then, summed up in one line as `Notes (attention)` gives it —
 * the same row, opened or not (Spec §3.8, §5.5) — then the work that moved on (each is an object, and opens it), the
 * changes, the new notes.
 */
export function sinceRows(s) {
  if (!s) return [];
  return [
    ...(s.rounds ?? []).map((r) => attentionRow(r)),
    ...(s.threads ?? []).map((t) => ({ key: `work:${t.id}`, marks: [{ glyph: PROGRESS[t.progress] ?? '○', tone: 'work', title: `Work · ${t.progress}` }], text: t.title, object: { text: t.progress ?? '', title: t.progress ?? '' }, time: t.updatedAt ?? null, noteId: null, opens: { kind: 'node', id: t.id, label: t.title } })),
    ...(s.changes ?? []).map((c) => ({ key: `change:${c.id}`, marks: [effectMark(c.effect)], text: c.title, object: NONE, time: c.at ?? null, noteId: null, opens: null })),
    ...(s.notes ?? []).map((n) => ({ key: `note:${n.id}`, marks: [askMark(n.ask)].filter(Boolean), text: n.title, object: mountSlot(n.object), time: n.at ?? null, noteId: n.id, opens: null })),
  ];
}

// ── The drawer and the ❓ on objects (Spec §6.1, §6.2; D100; CKC-09 AC-38) ─────────────────────────────────────
/**
 * Whether an item of `Notes (attention)` is marked ❓ on its objects instead of listed in the drawer: a note that hangs on
 * a node, a relation or a path the project still has (§2.7 keeps it in `Notes (attention)`; D100 puts it on the object).
 * A note on the whole project, one whose objects are all gone, and everything that is not a note stay in the drawer —
 * an item with nowhere to be marked is never dropped.
 */
export function markedOnObjects(item) {
  return item?.kind === 'note' && Boolean(item.object) && item.object.kind !== 'project' && (item.object.objects?.length ?? 0) > 0;
}

/**
 * The attention notes marked ❓ on objects. SEAM (CF → CE): the Graph and the List draw the ❓ marks from CE's own
 * `objectAttentionNotes(view)`; until that lands, the drawer counts with this, which follows the same rule
 * (`markedOnObjects`). Once CE exports it, views.js `onObjectNotes` calls CE's function and this stays as its test.
 */
export function objectAttentionNotes(ov) {
  return (ov?.needsYou ?? []).filter(markedOnObjects);
}

/** What the drawer's `Notes (attention)` lists: the whole-project part (Spec §6.2). */
export function drawerAttention(ov) {
  return (ov?.needsYou ?? []).filter((x) => !markedOnObjects(x));
}

/**
 * The objects the ❓ count shows when it is pressed (the Graph and the List see only these, with what they need to be
 * understood): each note's nodes, a relation by its two ends (the line is drawn between them), every object of a path.
 * `relations` are the graph's, to find a relation's ends; one the graph does not have is left out.
 */
export function attentionTargets(notes, relations = []) {
  const ends = new Map((relations ?? []).map((r) => [r.id, [r.from, r.to]]));
  const ids = new Set();
  for (const n of notes ?? []) {
    for (const o of n.object?.objects ?? []) {
      if (o.kind === 'relation') for (const id of ends.get(o.id) ?? []) ids.add(id);
      else ids.add(o.id);
    }
  }
  return [...ids];
}

/**
 * The drawer's one line (Spec §6.1, §6.2): how many rows `Notes (attention)` and `Recent changes` have, whether there is a
 * `Since last visit`, and how many attention notes are marked ❓ on objects. `onObjects` defaults to the rule above.
 */
export function drawerSummary(ov, onObjects = objectAttentionNotes(ov)) {
  return {
    attention: drawerAttention(ov).length,
    changes: (ov?.recentChanges ?? []).length,
    since: Boolean(ov?.sinceLastVisit),
    onObjects: onObjects.length,
  };
}

/**
 * The header of `Notes (attention)` (D50; CKC-09 AC-1, AC-38; Spec §6.2): it says, in sight, why this list holds fewer
 * notes than the project has — how many only inform, how many the owner has answered, how many wait on objects (❓) —
 * and counts what is listed here and is not a note apart, never folded into the note number (§2.4). `hint` is the same
 * in full sentences, for the hover. `onObjects` is the number of attention notes marked ❓ on objects.
 */
export function attentionHeader(ov, onObjects = objectAttentionNotes(ov).length) {
  const list = drawerAttention(ov);
  const of = (kind) => list.filter((x) => x.kind === kind).length;
  const notes = of('note'), questions = of('scope-question'), finished = of('job'), rounds = of('round');
  // A Follow up result is here when its round found something new (it carries the news, CKC-07 AC-27); one from a round
  // closed before rounds counted their news is here, as it always was, when it left objects on the old understanding.
  const withNews = list.filter((x) => x.kind === 'round' && x.news).length;
  const earlier = rounds - withNews;
  const c = ov?.noteCounts ?? null;
  const count = c ? `${notes} of ${plural(c.current, 'note')}` : notes ? plural(notes, 'note') : '';
  const why = c ? [c.information ? `${c.information} for information` : '', c.answered ? `${c.answered} answered` : '', onObjects ? `❓ ${onObjects} on objects` : ''].filter(Boolean).join(' · ') : onObjects ? `❓ ${onObjects} on objects` : '';
  const also = [questions ? plural(questions, 'scope question') : '', finished ? `${plural(finished, 'request')} done` : '', rounds ? plural(rounds, 'Follow up result') : ''].filter(Boolean).join(' · ');
  const onObjectsSaid = onObjects ? ` ${onObjects} ${onObjects === 1 ? 'waits' : 'wait'} on you on ${onObjects === 1 ? 'its object' : 'their objects'}, marked ❓ there; press the ❓ count to see only those objects.` : '';
  const hint = [
    c ? `${notes} of the project's ${c.current} current notes wait on you here. The other ${c.current - notes} are not here: ${c.information} are for information only and ${c.answered} you have already answered.${onObjectsSaid} The Notes log has all of them.` : `Notes on the whole project that ask something of you and you have not answered yet.${onObjectsSaid} The Notes log has all of them.`,
    questions ? `Also here, counted separately: ${plural(questions, 'unanswered scope question')}.` : '',
    finished ? `${plural(finished, 'request')} you gave finished and wait${finished === 1 ? 's' : ''} for you to look.` : '',
    withNews ? `${plural(withNews, 'Follow up result')} with something new.` : '',
    earlier ? `${plural(earlier, 'Follow up result')} from before rounds counted what they found new, with objects still on the old understanding.` : '',
  ].filter(Boolean).join(' ');
  return { count, why: why ? `Not here: ${why}` : '', also: also ? `Also here: ${also}` : '', hint, onObjects };
}
