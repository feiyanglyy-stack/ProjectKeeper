// Views of the workbench. Each view renders from the assets the API returns; fixed text is
// English and identical across projects (Spec §6.13).
import { api, append, clear, fmtRel, fmtTime, h, navigate, openDialog, refreshActivity, refreshProject, select, state, toast, toggleKeeper, activity, renderBody, openActivity, visHtml, popover, flyout, setKeeperMode, keeperMode, setTopTools } from './app.js';
import { createGraph, starredIds, NOT_DRAWN, OBSERVED, observedCells, cellSummary, cleanName, MARKS, currentPalette, placementOf } from './graph.js';
import { NO_PLAN, INTENT_KINDS, destinationLine, destinationText, isCopyIn, sharedMark, areaWorkLine, listRowsOf, MAIN_BY, replacementOf, whereItSits, FOUNDATION_LABEL, WHOLE_LABEL, WHOLE_PLAN_LABEL } from './placement.js';
import { fillMarkdown } from './markdown.js';
import { failuresOf, reasonText } from './failures.js';
import { FILTERS, activeFilters, clearFilters, filterLabel, readabilityMark } from './graph-tools.js';
import { attentionHeader, attentionRow, attentionTargets, changeRow, drawerAttention, drawerSummary, objectAttentionNotes, sinceRows } from './strip-rows.js';
// Increment K (CKC-24, §6.3, §6.4, §6.17, §6.9, §6.7): the process view, the popover's lineage and versions, and the
// three blocks AS's renderers draw (Code, the round tree, the scope additions) — placeholders until that merge lands.
import * as kProcess from './k-process.js';
import * as kData from './k-data.js';
import { renderCodeView } from './k/code-view.js';
import { keeperView } from './keeper-view.js';
import { activityView } from './keeper-activity.js';
import { renderScopeK } from './k/scope-k.js';
import { openDraft } from './k/draft-view.js';
import { openInside } from './k-fold.js';
import { createListFold, PLATE_KEY, CROSS_KEY, blockKey, generationKey } from './list-fold.js';

const P = () => encodeURIComponent(state.projectId);
/** Replace a rendered block only when it actually differs: an unconditional swap on every asset event made the
 *  legend, the strip and the rail blink while the Keeper worked (owner, 2026-09-17). */
/** A row that is pressed like a button but holds a button of its own: Tab reaches it, Enter or Space presses it. */
const pressable = (onPress) => ({ role: 'button', tabindex: 0, onClick: onPress, onKeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPress(e); } } });
const swap = (current, next) => {
  if (!current?.isConnected) return next;
  if (visHtml(current.outerHTML) === visHtml(next.outerHTML)) return current;
  current.replaceWith(next);
  return next;
};
const validityTag = (v) => v === 'Current' ? null : v === 'Unjudged' ? h('span', { class: 'tag' }, 'Not yet judged') : h('span', { class: `tag ${v === 'Proposed' ? 'blue' : v === 'Replaced' || v === 'Abandoned' || v === 'Removed' ? 'strike' : ''}` }, v);
/** An object named in a change: one removed from the project's current version is struck through (Spec §2.1, §6.3). */
const REMOVED_TITLE = 'Removed from the project’s current version';
const namedObject = (x) => x.removed ? h('s', { title: REMOVED_TITLE }, x.label) : x.label;
// Owner acceptance sits next to progress and is its own fact (owner D41): `Done` says the result exists, this says
// whether the owner accepted it. A project with no acceptance step leaves it empty and nothing is shown.
const acceptanceTag = (n) => !n?.acceptance ? null : h('span', { class: `tag ${n.acceptance === 'Accepted' ? 'green' : ''}`, title: n.acceptance === 'Accepted' ? 'The owner accepted this work' : 'Not yet accepted by the owner; this does not change its progress' }, n.acceptance);
const basisTag = (b) => b === 'Inferred' ? h('span', { class: 'tag purple' }, 'Inferred') : null;
const assessmentTag = (a) => h('span', { class: `tag ${a === 'Holds' ? 'green' : a === 'Questioned' ? 'amber' : ''}` }, a);

function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('h2', {}, title), text ? h('p', {}, text) : null, action ?? null);
}

// ── Sources ───────────────────────────────────────────────────────────────
export async function openSource(sourceId) {
  const s = await api(`/api/projects/${P()}/sources/${encodeURIComponent(sourceId)}`);
  const lines = s.excerpt.split('\n');
  const start = s.anchor.kind === 'file' ? s.anchor.lineStart : 1;
  const notice = s.currentState === 'changed' ? 'This source changed after it was read; the excerpt below is what was read.'
    : s.currentState === 'missing' ? 'This source is no longer available at its path; the excerpt below is what was read.' : null;
  const quote = h('div', { class: 'source-quote' }, ...lines.map((line, i) => h('div', { class: 'src-line' }, h('span', { class: 'no' }, start + i), h('span', { class: 'tx' }, line))));
  const copy = h('button', { class: 'btn small', onClick: async () => { try { await navigator.clipboard.writeText(s.excerpt); toast('Excerpt copied'); } catch { quote.setAttribute('tabindex', '0'); quote.focus(); const r = document.createRange(); r.selectNodeContents(quote); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Clipboard unavailable — the excerpt is selected, copy it with Ctrl+C'); } } }, 'Copy excerpt');
  openDialog(s.title, [
    h('dl', { class: 'kv' },
      h('dt', {}, 'Kind'), h('dd', {}, s.anchor.kind),
      h('dt', {}, 'Location'), h('dd', { class: 'mono' }, s.label),
      h('dt', {}, 'Read at'), h('dd', {}, fmtTime(s.version.readAt)),
      h('dt', {}, 'Version'), h('dd', { class: 'mono' }, s.version.commit ? `${s.version.commit.slice(0, 10)} · ` : '', s.version.fingerprint.slice(0, 23)),
      h('dt', {}, 'Used as'), h('dd', {}, s.usedAs ?? 'Not yet judged'),
      s.origin ? h('dt', {}, 'Origin') : null, s.origin ? h('dd', {}, `${s.origin.relation} · ${s.origin.path}`) : null,
      s.availabilityNow ? h('dt', {}, 'Availability') : null, s.availabilityNow ? h('dd', {}, h('span', { class: 'tag amber' }, s.availabilityNow)) : null,
      s.hasCredential ? h('dt', {}, 'Credential') : null, s.hasCredential ? h('dd', {}, 'This source contains a credential; its value is not shown or stored.') : null),
    notice ? h('p', { class: 'muted' }, notice) : null,
    quote,
    h('p', { class: 'faint' }, 'Excerpts keep the original text. Interpretations and relations built on them can be corrected; the original is never changed.'),
    h('div', { class: 'dialog-foot' }, copy),
  ]);
}

// The process view opens originals through this module (k-process.js is imported here and does not import it back).
kProcess.setOpeners({ openSource: (id) => openSource(id).catch((e) => toast(`${id}: ${e.message}`)) });

// ── Sources (D34: shown inside Project scope, under the scope items) ─────
const sources = {
  async render(main, { scopeItems = [], levels = [] } = {}) {
    const q = h('input', { class: 'input', placeholder: 'Filter by file, section or content', value: state.filters.sourceQuery ?? '' });
    const usedAs = h('select', { class: 'input' }, h('option', { value: '' }, 'Used as: any'), ...['Not yet judged', 'Purpose', 'Decision', 'Requirement', 'Design', 'Plan', 'Task', 'Status', 'Code', 'Test', 'QC', 'Session', 'Run result', 'Other'].map((v) => h('option', { value: v, selected: state.filters.usedAs === v }, v)));
    const avail = h('select', { class: 'input' }, h('option', { value: '' }, 'Availability: any'), ...['Changed since read', 'Moved', 'No longer available'].map((v) => h('option', { value: v, selected: state.filters.availability === v }, v)));
    const origin = h('select', { class: 'input' }, h('option', { value: '' }, 'Origin: any scope item'), ...scopeItems.map((i) => h('option', { value: i.id, selected: state.filters.sourceOrigin === i.id }, `${i.relation === 'Main project' ? 'This project' : i.relation} · ${i.path}`)));
    // §6.7: also by organizing level; the level names come from the vocabulary the server sends, not from the page.
    const level = levels.length ? h('select', { class: 'input' }, h('option', { value: '' }, 'Level: any'), ...levels.map((v) => h('option', { value: v, selected: state.filters.sourceLevel === v }, v))) : null;
    const summary = h('div', { class: 'muted' });
    const table = h('div');
    const load = async () => {
      state.filters.sourceQuery = q.value; state.filters.usedAs = usedAs.value; state.filters.availability = avail.value; state.filters.sourceOrigin = origin.value;
      state.filters.sourceLevel = level?.value ?? '';
      const params = new URLSearchParams({ q: q.value, usedAs: usedAs.value, availability: avail.value });
      if (level?.value) params.set('level', level.value);
      let list = await api(`/api/projects/${P()}/sources?${params}`);
      if (origin.value) list = list.filter((x) => x.scopeItemId === origin.value);
      clear(table);
      summary.textContent = list.length ? `${list.length} source(s)${origin.value || q.value || usedAs.value || avail.value || level?.value ? ' match' : ''}` : '';
      if (list.length === 0) { append(table, h('div', { class: 'empty' }, h('h2', {}, 'No sources read yet'), h('p', {}, 'Sources appear as the Keeper reads files, sessions and commits inside the project scope.'))); return; }
      append(table, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Source'), h('th', {}, 'Used as'), h('th', {}, 'Origin'))),
        h('tbody', {}, ...list.map((x) => h('tr', { class: `clickable${state.selection?.id === x.id ? ' sel' : ''}`, onClick: () => openSource(x.id) },
          h('td', {}, h('div', {}, x.title), h('small', { class: 'mono' }, x.label), x.ids.length ? h('div', {}, ...x.ids.slice(0, 8).map((id) => h('span', { class: 'tag' }, id))) : null),
          h('td', {}, x.usedAs ?? h('span', { class: 'faint' }, 'Not yet judged')),
          h('td', {}, h('div', {}, originLabel(x.scopeItemId)), x.availability ? h('span', { class: 'tag amber' }, x.availability) : null, x.hasCredential ? h('span', { class: 'tag red' }, 'credential') : null))))));
    };
    let timer;
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 150); });
    usedAs.addEventListener('change', load); avail.addEventListener('change', load); origin.addEventListener('change', load);
    level?.addEventListener('change', load);
    append(main,
      h('p', { class: 'sub' }, 'Every piece of material the Keeper has read from the scope above, with where it came from and how it was used. Click a row to read the original excerpt.'),
      h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, q), origin, level, usedAs, avail),
      summary, table);
    await load();
    sources._origin = origin; sources._reload = load;
  },
  /** Called from a scope item: show only that item's sources and scroll to them. */
  showOrigin(id) { if (sources._origin) { sources._origin.value = id; sources._reload?.(); document.querySelector('#sources')?.scrollIntoView({ behavior: 'smooth' }); } },
};
function originLabel(scopeItemId) {
  const item = state.project?.scope?.find((i) => i.id === scopeItemId);
  return item ? `${item.relation === 'Main project' ? 'This project' : item.relation}${item.copyOf ? ` (copy of ${item.copyOf})` : ''}` : '—';
}

// ── How this project works, and the organizing plan (Spec §1.15, §3.7, §6.7; CKC-21 AC-11) ──
// Every word comes from the server (workbench-content.ts); the owner confirms or corrects through Ask Keeper, and
// the answer is recorded as their statement.
const PLAN_CONTEXT = { kind: 'plan', id: 'organizing-plan', label: 'Organizing plan and focus' };
const scrollToRule = (id) => { const el = document.getElementById(`rule-${id}`); if (!el) return; el.closest('details')?.setAttribute('open', ''); el.scrollIntoView({ block: 'center' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); };
const sourceButtons = (list) => list.map((s) => h('button', { class: 'text-btn', title: s.label, onClick: () => openSource(s.id) }, s.title));

function ruleRow(r) {
  const c = r.confirmation;
  const state = c.state === 'Waiting for the owner to confirm' ? [h('span', { class: 'tag purple' }, 'Inferred'), ' ', h('span', { class: 'tag amber' }, c.state)]
    : c.state === 'Confirmed by the owner' ? [h('span', { class: 'tag green' }, c.state), c.at ? h('small', { class: 'faint' }, ` ${fmtTime(c.at)}`) : null]
      : [h('span', { class: 'tag' }, c.state)];
  return h('div', { class: 'rule-row', id: `rule-${r.id}` },
    h('div', { class: 'row spread' },
      h('div', {}, h('b', {}, r.summary), r.category ? [' ', h('span', { class: 'tag' }, r.category)] : null, r.ownerSystem ? [' ', h('span', { class: 'tag blue', title: 'From the way of working the owner summarized' }, r.ownerSystem)] : null),
      h('button', { class: 'btn small', title: 'Confirm or correct this rule in the conversation; your answer is recorded as your statement', onClick: () => toggleKeeper(true, { kind: 'rule', id: r.id, label: r.summary }) }, 'Ask Keeper')),
    h('div', { class: 'row wrap' }, ...state, validityTag(r.validity)),
    r.excerpt ? h('blockquote', { class: 'quote' }, r.excerpt) : null,
    c.quote ? h('div', { class: 'muted' }, '“', c.quote, '” ', c.source ? h('button', { class: 'text-btn', onClick: () => openSource(c.source.id) }, 'source') : null) : null,
    r.appliesTo.length ? h('div', { class: 'faint' }, 'Applies to: ', r.appliesTo.join(', ')) : null,
    r.sources.length ? h('div', { class: 'row wrap' }, h('small', {}, 'Source'), ...sourceButtons(r.sources)) : null,
    ...r.differsInPractice.map((d) => h('div', {}, h('span', { class: 'tag amber' }, 'Differs in practice'), ' ', d.text, ' ', ...sourceButtons(d.sources))),
    ...r.marks.map((m) => h('div', {}, h('span', { class: `tag ${m.kind === 'Decided without owner' ? 'red' : 'amber'}` }, `⚑ ${m.label}`), ' ', h('span', { class: m.inForce ? 'muted' : 'faint' }, m.detail))));
}

/**
 * What the project's rules settle directly, and which rule or plan decided it (Spec §1.11, §3.7): shown with the
 * coverage's organizing levels and in the Keeper view's takeover progress. `onRule` opens the rule — the rule rows
 * live in Project scope, so elsewhere it navigates there first.
 */
function settledByRuleBlock(s, onRule) {
  if (!s || !s.byRule?.length) return null;
  const via = { plan: 'the organizing plan names it under this rule', sources: 'the rule set how its sources are used', away: 'the rule took it out of what is organized' };
  return h('div', {}, h('h4', {}, `Settled by rule (${s.materials})`),
    h('div', { class: 'faint' }, 'Material the project’s own rules judge directly, without close reading:'),
    ...s.byRule.map((r) => h('div', {}, h('button', { class: 'text-btn', title: 'Open the rule in Project scope', onClick: () => onRule(r.ruleId) }, r.summary),
      h('span', { class: 'faint' }, ` — ${r.count} (${r.names.join(', ')}${r.count > r.names.length ? ', …' : ''}) · ${via[r.via] ?? r.via}`))));
}

function rulesSection(how) {  const group = (g) => h('div', { class: 'rule-group' }, h('h4', {}, g.group, h('small', { class: 'faint' }, ` ${g.rules.length}`)),
    ...g.rules.map(ruleRow),
    g.replaced.length ? h('details', { class: 'fold' }, h('summary', {}, `Replaced (${g.replaced.length})`), h('div', { class: 'content stack' }, ...g.replaced.map((r) => h('div', { class: 'rule-row replaced', id: `rule-${r.id}` },
      h('s', {}, r.summary), r.replacedBy ? [' → ', h('button', { class: 'text-btn', title: 'The rule that replaced it', onClick: () => scrollToRule(r.replacedBy.id) }, r.replacedBy.summary)] : null,
      r.sources.length ? h('div', { class: 'row wrap' }, h('small', {}, 'Source'), ...sourceButtons(r.sources)) : null)))) : null);
  const counts = how.counts;
  return h('div', { class: 'section', id: 'how-this-project-works' },
    h('header', {}, 'How this project works', h('span', { class: 'faint', style: { fontWeight: 400 } }, counts.rules ? ` ${counts.rules} rule${counts.rules === 1 ? '' : 's'}${counts.waiting ? ` · ${counts.waiting} waiting for the owner to confirm` : ''}` : '')),
    h('div', { class: 'content stack' },
      how.groups.length === 0 ? h('div', { class: 'faint' }, 'No rule of this project has been recorded yet. Orientation looks for them first.') : null,
      how.ownerSystems.length ? h('div', { class: 'muted' }, 'From the way of working the owner summarized: ', how.ownerSystems.join(', '), '. Where practice differs from it, the rule says so.')
        : how.groups.length ? h('div', { class: 'muted' }, 'Found by the Keeper in the project’s own records. What it inferred is marked and waits for the owner to confirm.') : null,
      ...how.groups.map(group)));
}

function planSection(plan) {
  const ask = h('button', { class: 'btn small', title: 'Correct the plan in the conversation; your words are kept with what the plan said before', onClick: () => toggleKeeper(true, PLAN_CONTEXT) }, 'Ask Keeper');
  const head = h('header', {}, 'Organizing plan and focus', h('span', { class: 'faint', style: { fontWeight: 400 } }, ' what the rules settle, what is read closely, where the focus is'), plan ? ask : null);
  if (!plan) return h('div', { class: 'section', id: 'organizing-plan' }, head, h('div', { class: 'content faint' }, 'No organizing plan has been recorded yet. Orientation writes it once it has found the project’s rules; you can also tell the Keeper what to read closely, where to focus and in what order.'));
  const targets = (t) => t.length ? h('span', { class: 'mono faint' }, ` ${t.join(', ')}`) : null;
  const previous = (p) => [
    p.byRule.length ? h('div', {}, h('b', {}, 'Settled by the project’s rules: '), p.byRule.map((e) => `${e.what} → ${e.treatment}`).join('; ')) : null,
    p.readClosely.length ? h('div', {}, h('b', {}, 'Read closely: '), p.readClosely.map((e) => e.what).join('; ')) : null,
    p.focus.length ? h('div', {}, h('b', {}, 'Focus: '), p.focus.map((e) => e.what).join('; ')) : null,
    p.order.length ? h('div', {}, h('b', {}, 'Order: '), p.order.join(' → ')) : null,
  ];
  return h('div', { class: 'section', id: 'organizing-plan' }, head,
    h('div', { class: 'content stack' },
      plan.byRule.length ? h('div', {}, h('h4', {}, 'Settled by the project’s rules'), ...plan.byRule.map((e) => h('div', {}, h('b', {}, e.what), targets(e.targets), ' → ', h('span', { class: 'tag' }, e.treatment), ' ', h('button', { class: 'text-btn', title: 'The rule that settles it', onClick: () => scrollToRule(e.rule.id) }, e.rule.summary)))) : null,
      plan.readClosely.length ? h('div', {}, h('h4', {}, 'Read closely'), ...plan.readClosely.map((e) => h('div', {}, h('b', {}, e.what), targets(e.targets), e.why ? h('div', { class: 'muted' }, e.why) : null))) : null,
      plan.focus.length ? h('div', {}, h('h4', {}, 'Focus'), ...plan.focus.map((f) => h('div', {}, h('b', {}, f.what), f.why ? h('div', { class: 'muted' }, f.why) : null, f.sources.length ? h('div', { class: 'row wrap' }, ...sourceButtons(f.sources)) : null))) : null,
      plan.order.length ? h('div', {}, h('h4', {}, 'Order'), h('ol', {}, ...plan.order.map((o) => h('li', {}, o)))) : null,
      plan.corrections.length ? h('div', {}, h('h4', {}, 'Corrected by the owner'), ...plan.corrections.map((c) => h('div', { class: 'stack' },
        h('div', {}, h('small', { class: 'faint' }, fmtTime(c.at)), ' “', c.quote, '” ', h('button', { class: 'text-btn', onClick: () => openSource(c.source.id) }, 'source')),
        h('div', { class: 'muted' }, c.changed),
        h('details', { class: 'fold' }, h('summary', {}, 'What the plan said before'), h('div', { class: 'content' }, ...previous(c.previous)))))) : null,
      h('div', { class: 'faint' }, `As of ${fmtTime(plan.asOf)}`)));
}

// ── Project scope ─────────────────────────────────────────────────────────
const scope = {
  async render(main) {
    const d = await api(`/api/projects/${P()}/scope`);
    const p = state.project;
    // read counts per scope item, so each item says what was read from it (D34)
    const bySource = new Map();
    try { for (const x of await api(`/api/projects/${P()}/sources?q=&usedAs=&availability=`)) { const c = bySource.get(x.scopeItemId) ?? { read: 0, unjudged: 0 }; c.read++; if (!x.usedAs) c.unjudged++; bySource.set(x.scopeItemId, c); } } catch { /* counts are a convenience */ }
    const readLine = (item) => { const c = bySource.get(item.id); return c ? h('div', { class: 'faint' }, h('button', { class: 'text-btn', title: 'Show the sources read from this item', onClick: () => sources.showOrigin(item.id) }, `${c.read} source${c.read === 1 ? '' : 's'} read`), c.unjudged ? ` · ${c.unjudged} not yet judged` : '') : h('div', { class: 'faint' }, 'nothing read yet'); };
    const included = d.scope.filter((i) => i.relation !== 'Excluded');
    const excluded = d.scope.filter((i) => i.relation === 'Excluded');
    const reasonLink = (item) => item.reasonSourceIds.length ? h('button', { class: 'text-btn', onClick: () => openSource(item.reasonSourceIds[0]) }, 'source') : null;
    const mergedTag = (w) => w.merged === null ? null : h('span', { class: `tag ${w.merged ? 'green' : 'amber'}` }, w.merged ? 'merged' : 'not merged');
    const itemRow = (view) => {
      const item = view.item ?? view;   // the sectioned view data, or a bare item for an older server
      const worktree = view.worktree ?? (item.worktree ? { sentence: '', merged: item.worktree.merged ?? null } : null);
      return h('div', { class: `scope-item${item.relation === 'Excluded' ? ' excluded' : ''}` },
        h('div', {}, h('span', { class: 'tag' }, item.category), item.readOnly ? h('span', { class: 'tag blue' }, 'read-only') : null),
        h('div', {}, item.relation, item.copyOf ? h('div', { class: 'faint' }, `copy of ${item.copyOf}`) : null, item.worktreeOf ? h('div', { class: 'faint' }, `of ${item.worktreeOf}`) : null, item.versionControl === 'none' ? h('div', { class: 'faint' }, 'no version control') : null),
        h('div', {}, h('div', { class: 'path mono' }, item.path), h('div', { class: 'reason' }, view.reason ?? item.reason, ' ', reasonLink(item)), item.missing ? h('div', {}, h('span', { class: 'tag red' }, item.missing.reason)) : null, readLine(item),
          worktree ? h('div', { class: 'faint' }, mergedTag(worktree), ' ', worktree.sentence || `${item.worktree.files} files measured against the trunk`) : null,
          view.ignored ? h('div', { class: 'faint' }, 'Left out by ', h('span', { class: 'mono' }, view.ignored.rule), ' · ', view.ignored.sentence) : null,
          view.classification ? h('div', { class: 'faint' }, view.classification.sentence, ' ', basisTag(view.classification.basis)) : null,
          view.covers?.length ? h('div', { class: 'row wrap' }, h('small', {}, 'Covered by'), ...view.covers.map((c) => h('button', { class: 'text-btn', title: c.excerpt ?? c.summary, onClick: () => scrollToRule(c.ruleId) }, c.summary))) : null),
        h('div', {}, h('button', { class: 'btn small', title: 'Remove from scope', onClick: async () => { await api(`/api/projects/${P()}/scope/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); toast('Scope changed — the Keeper re-evaluates the affected part'); await refreshProject(); } }, '×')));
    };
    const listView = d.scopeView ?? null;
    const scopeSection = (id, title, items, note) => h('div', { class: 'section', id }, h('header', {}, title, note ? h('span', { class: 'faint', style: { fontWeight: 400 } }, ` ${note}`) : null), h('div', {}, ...items.map(itemRow)));
    const sourcesSection = h('div', { class: 'section', id: 'sources' }, h('header', {}, `Sources (${[...bySource.values()].reduce((a, c) => a + c.read, 0)})`), h('div', { class: 'content' }));
    const followUpSection = h('div', { class: 'section', id: 'follow-up' }, h('header', {}, 'Change follow-up', h('span', { class: 'faint', style: { fontWeight: 400 } }, ' what moved upstream, and whether what depends on it followed')), h('div', { class: 'content' }, h('div', { class: 'faint' }, 'Loading…')));
    const cov = d.coverage;
    const covRows = cov.scopes.map((s) => h('tr', {}, h('td', {}, s.label), h('td', {}, h('span', { class: `tag ${s.coverage === 'Up to date' ? 'green' : 'amber'}` }, s.coverage)), h('td', {}, s.asOf ? `${fmtTime(s.asOf)}${s.commit ? ` @ ${s.commit.slice(0, 8)}` : ''}` : '—'), h('td', {}, s.pending.length ? s.pending.slice(0, 6).map((x) => h('div', { class: 'mono' }, x.label)) : '—', s.pending.length > 6 ? h('small', {}, `+${s.pending.length - 6} more`) : null), h('td', {}, s.organizing.length ? s.organizing.map((x) => h('div', { class: 'mono' }, x.label)) : '—'), h('td', {}, s.failed.length ? failuresOf({ scopes: [s] }).map((f) => h('div', {}, h('span', { class: 'mono' }, f.ref), h('small', {}, ` ${reasonText(f.reason)}`))) : '—'), h('td', {}, s.lastRelookAt ? fmtRel(s.lastRelookAt) : '—')));
    const addItem = () => {
      const path = h('input', { class: 'input', placeholder: 'D:\\path' });
      // The choices come from the vocabularies the server sends, not from a list written into the page.
      const category = h('select', { class: 'input' }, ...(d.scopeVocab?.categories ?? ['Directory', 'Repository', 'Worktree', 'Session source']).map((v) => h('option', { value: v }, v)));
      const relation = h('select', { class: 'input' }, ...(d.scopeVocab?.relations ?? ['Main project', 'Worktree of main repo', 'Copy of another project', 'Nested repository', 'Experiment', 'Third-party material', 'Generated', 'Excluded', 'Session source']).map((v) => h('option', { value: v }, v)));
      const reason = h('input', { class: 'input', placeholder: 'Why it belongs (or does not)' });
      const err = h('small');
      openDialog('Add scope item', [h('div', { class: 'field' }, h('label', {}, 'Path'), path), h('div', { class: 'row' }, h('div', { class: 'field grow' }, h('label', {}, 'Category'), category), h('div', { class: 'field grow' }, h('label', {}, 'Relation'), relation)), h('div', { class: 'field' }, h('label', {}, 'Reason'), reason), err,
        h('div', { class: 'dialog-foot' }, h('button', { class: 'btn primary', onClick: async () => { try { await api(`/api/projects/${P()}/scope/items`, { method: 'POST', body: { path: path.value, category: category.value, relation: relation.value, reason: reason.value } }); document.querySelector('#dialog').close(); await refreshProject(); } catch (e) { err.textContent = e.message; } } }, 'Add'))]);
    };
    append(main, 
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Project scope'), h('p', { class: 'sub' }, 'What the Keeper treats as this project, with the reason for each item. Understanding state: ', h('span', { class: cov.state === 'Takeover complete' ? 'tag green' : 'tag amber' }, cov.state), cov.takeover && cov.state !== 'Not organized yet' ? h('span', { class: 'faint' }, ' · takeover depth ', h('button', { class: 'text-btn', onClick: () => navigate(state.projectId, 'keeper', 'takeover') }, cov.takeover.depth)) : null, d.lastScopedAt ? h('span', { class: 'faint' }, ` · boundary drawn ${fmtRel(d.lastScopedAt)}`) : null, d.roles.length ? h('span', { class: 'faint' }, ` · roles recognised: ${d.roles.join(', ')}`) : h('span', { class: 'faint' }, ' · no role system recognised (that is not a gap)'))),
        h('div', { class: 'row' }, h('button', { class: 'btn small', onClick: addItem }, 'Add item'), h('button', { class: 'btn small', onClick: async () => { await api(`/api/projects/${P()}/scope/rescan`, { method: 'POST' }); toast('Boundary re-drawn'); await refreshProject(); } }, 'Rescan'), h('button', { class: 'btn small', onClick: () => document.querySelector('#sources')?.scrollIntoView({ behavior: 'smooth' }) }, 'Sources'))),
      d.questions.filter((q) => !q.answer).length ? h('div', { class: 'section' }, h('header', {}, 'Questions for you'), h('div', { class: 'content' }, ...d.questions.filter((q) => !q.answer).map((q) => {
        const answer = h('input', { class: 'input', placeholder: q.options.join(' / ') });
        return h('div', { class: 'stack' }, h('b', {}, q.question), h('div', { class: 'muted' }, 'Why it matters: ', q.whyItMatters), q.clues.length ? h('ul', {}, ...q.clues.map((c) => h('li', {}, c))) : null, h('div', { class: 'row' }, h('div', { class: 'grow' }, answer), h('button', { class: 'btn small', onClick: async () => { await api(`/api/projects/${P()}/scope/questions/${encodeURIComponent(q.id)}`, { method: 'POST', body: { answer: answer.value } }); await refreshProject(); } }, 'Answer')));
      }))) : null,
      listView
        ? [
            scopeSection('in-scope', `In scope (${listView.inScope.length})`, listView.inScope),
            listView.thirdParty.length ? scopeSection('third-party', `Third-party material (${listView.thirdParty.length})`, listView.thirdParty, 'what the project uses, not its own intent; its documents are read as Reference only') : null,
            listView.generated.length ? scopeSection('generated', `Generated (${listView.generated.length})`, listView.generated, 'build output, caches and exports — listed, not organized') : null,
            listView.ignoredDocuments.length ? scopeSection('ignored-documents', `Ignored, holding documents (${listView.ignoredDocuments.length})`, listView.ignoredDocuments, 'the ignore rules leave these out, but they hold documents that may carry intent — the owner decides whether to include them') : null,
            listView.excluded.length ? scopeSection('excluded', `Excluded (${listView.excluded.length})`, listView.excluded) : null,
          ]
        : [
            h('div', { class: 'section' }, h('header', {}, `In scope (${included.length})`), h('div', {}, ...included.map(itemRow))),
            excluded.length ? h('div', { class: 'section' }, h('header', {}, `Excluded (${excluded.length})`), h('div', {}, ...excluded.map(itemRow))) : null,
          ],
      planSection(d.organizingPlan ?? null),
      h('div', { class: 'section', id: 'coverage' }, h('header', {}, 'Coverage'), h('div', { class: 'content' },
        h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, 'Scope'), h('th', {}, 'Coverage'), h('th', {}, 'As of'), h('th', {}, 'Pending'), h('th', {}, 'Organizing'), h('th', {}, 'Failed'), h('th', {}, 'Last re-look'))), h('tbody', {}, ...covRows)),
        cov.missingSourceKinds.length ? h('div', {}, h('h4', {}, 'Missing source kinds'), ...cov.missingSourceKinds.map((m) => h('div', {}, h('b', {}, m.kind), ' — ', m.reason))) : h('div', { class: 'faint' }, 'No missing source kinds'),
        Object.keys(cov.processedByKind).length ? h('div', { class: 'faint' }, 'Processed: ', Object.entries(cov.processedByKind).map(([k, v]) => `${k} ${v}`).join(' · '), ' · Pending: ', Object.entries(cov.pendingByKind).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none') : null,
        cov.takeover ? h('div', {}, h('h4', {}, 'Organizing levels'), h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, 'Level'), h('th', {}, 'Materials'), h('th', {}, 'By kind'))), h('tbody', {}, ...cov.takeover.levels.filter((l) => l.materials > 0).map((l) => h('tr', {}, h('td', {}, l.level), h('td', {}, l.materials), h('td', { class: 'faint' }, kindsText(l.byKind)))))), partReadsLine(cov.takeover.readInPart), cov.takeover.remaining ? h('div', { class: 'faint' }, `Remaining under ${cov.takeover.depth}: ${cov.takeover.remaining.materials} materials, about ${fmtMinutes(cov.takeover.remaining.minutes)}.`) : cov.takeover.historyNotOrganized ? h('div', { class: 'faint' }, `${cov.takeover.historyNotOrganized} older materials are not organized (depth ${cov.takeover.depth}); they are indexed and read on demand.`) : null) : null,
        settledByRuleBlock(d.settledByRule, scrollToRule))),
      d.howThisProjectWorks ? rulesSection(d.howThisProjectWorks) : null,
      h('div', { class: 'section' }, h('header', {}, 'Standing authorizations'), h('div', { class: 'content' }, d.authorizations.length ? d.authorizations.map((a) => h('div', { class: 'row spread' }, h('div', {}, h('b', {}, a.scope), h('div', { class: 'muted' }, `“${a.quote}” · ${fmtTime(a.at)} `, a.sourceId ? h('button', { class: 'text-btn', onClick: () => openSource(a.sourceId) }, 'source') : null)), h('button', { class: 'btn small danger', onClick: async () => { await api(`/api/projects/${P()}/authorizations/${encodeURIComponent(a.id)}/revoke`, { method: 'POST' }); await refreshProject(); } }, 'Revoke'))) : h('div', { class: 'faint' }, 'None. A standing authorization is recorded when you give one in the conversation, e.g. “fix stale document references directly”.'))),
      h('div', { class: 'section' }, h('header', {}, 'Files ProjectKeeper produces for this project'), h('div', { class: 'content' }, ...d.keeperFiles.map((f) => h('div', {}, h('span', { class: 'mono' }, f.path), h('div', { class: 'muted' }, f.kind, ' — can be removed without affecting the project'))))),
      d.toolchain?.entries?.length ? h('div', { class: 'section', id: 'toolchain' }, h('header', {}, 'Toolchain', h('span', { class: 'faint', style: { fontWeight: 400 } }, ' what the project’s configuration points at')), h('div', { class: 'content' },
        h('div', { class: 'muted' }, d.toolchain.note, ' ', h('button', { class: 'text-btn', title: 'Correct a wrong entry in the conversation', onClick: () => toggleKeeper(true, { kind: 'path', id: 'toolchain', label: 'Toolchain locations' }) }, 'Ask Keeper')),
        ...d.toolchain.entries.map((t) => h('div', { class: 'stack' },
          h('div', { class: 'row wrap', style: { alignItems: 'baseline', gap: '8px' } }, h('span', { class: 'mono' }, t.path), t.used ? h('span', { class: 'tag green', title: 'An allowed read root for the Keeper' }, 'used') : h('span', { class: 'tag amber' }, 'listed, not used')),
          h('div', { class: 'faint' }, t.reason, t.used ? '' : ` · ${t.notUsedReason}`))))) : null,
      followUpSection,
      sourcesSection,
      // The ledger's coverage, layers, generations and the project folder (§6.7), by AS's renderer, after the rest.
      h('div', { class: 'section', id: 'k-scope' }, h('header', {}, 'Project ledger'), h('div', { class: 'content', id: 'k-scope-body' }, h('div', { class: 'faint' }, 'Loading…'))),
    );
    followUpBlock(followUpSection.querySelector('.content'));
    await sources.render(sourcesSection.querySelector('.content'), { scopeItems: d.scope, levels: d.scopeVocab?.organizingLevels ?? [] });
    const scopeKBody = main.querySelector('#k-scope-body');
    kData.getScopeK(state.projectId).then((scopeK) => {
      if (!scopeKBody.isConnected) return;
      clear(scopeKBody);
      if (!scopeK) { scopeKBody.append(h('div', { class: 'faint' }, kData.noData())); return; }
      renderScopeK(scopeKBody, scopeK, { navigate: (view, rest) => navigate(state.projectId, view, rest) });
    }).catch(() => { if (scopeKBody.isConnected) { clear(scopeKBody); scopeKBody.append(h('div', { class: 'faint' }, kData.noData())); } });
    if (state.routeRest === 'coverage') document.querySelector('#coverage')?.scrollIntoView();
    if (state.routeRest === 'sources') document.querySelector('#sources')?.scrollIntoView();
    if (state.routeRest === 'rules') document.querySelector('#how-this-project-works')?.scrollIntoView();
    if (state.routeRest === 'plan') document.querySelector('#organizing-plan')?.scrollIntoView();
  },
};

// ── Takeover depth (Spec §3.7, D36) — the same choice on the depth note, in Project scope and in the Keeper view ──
const DEPTH_NOTE_ID = 'note_takeover-depth';
const fmtMinutes = (m) => (m == null ? '—' : m < 1 ? 'under a minute' : m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`);
const kindsText = (byKind) => Object.entries(byKind || {}).map(([k, v]) => `${v} ${k}${v === 1 ? '' : 's'}`).join(', ') || '—';
const JUDGED = ['Updated', 'Still on old understanding', 'Reusable as is'];

/**
 * Change follow-up coverage (Spec §5.5, D48): how many downstream objects are still waiting to be judged, where they
 * are, and what the current (or last) round judged. Counted from the propagation entries themselves, so it agrees
 * with the Change log.
 */
async function followUpBlock(el) {
  let g;
  try { g = await api(`/api/projects/${P()}/graph`); } catch (e) { el.replaceChildren(h('div', { class: 'faint' }, `Could not load: ${e.message}`)); return; }
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const areaOf = (id) => { const n = nodes.get(id); return n ? (n.category === 'Area' ? n.id : n.areaId ?? '') : ''; };
  const areaName = (id) => (id ? nodes.get(id)?.label ?? id : 'No area');
  const p = state.project ?? {};
  const roundFrom = p.followUpAt ?? null;
  const roundOpen = roundFrom && (!p.lastRoundAt || p.lastRoundAt < roundFrom);
  const roundTo = roundOpen ? null : p.lastRoundAt ?? null;
  const inRound = (e) => roundFrom && e.state !== 'Not yet checked' && e.updatedAt >= roundFrom && (!roundTo || e.updatedAt <= roundTo);
  const totals = Object.fromEntries([...JUDGED, 'Not yet checked'].map((k) => [k, 0]));
  const rows = new Map();
  const row = (a) => rows.get(a) ?? (rows.set(a, { left: 0, changes: new Set(), round: Object.fromEntries(JUDGED.map((k) => [k, 0])) }), rows.get(a));
  for (const c of g.changes) for (const e of c.propagation) {
    totals[e.state] = (totals[e.state] ?? 0) + 1;
    const r = row(areaOf(e.nodeId));
    if (e.state === 'Not yet checked') { r.left++; r.changes.add(c.id); }
    else if (inRound(e)) r.round[e.state]++;
  }
  const left = totals['Not yet checked'];
  const judgedThisRound = [...rows.values()].reduce((n, r) => n + JUDGED.reduce((m, k) => m + r.round[k], 0), 0);
  const roundLabel = !roundFrom ? null : roundOpen ? `This round (since ${fmtTime(roundFrom)})` : `Last round (${fmtTime(roundFrom)} – ${fmtTime(roundTo)})`;
  const ordered = [...rows.entries()].filter(([, r]) => r.left || JUDGED.some((k) => r.round[k])).sort((a, b) => b[1].left - a[1].left);
  el.replaceChildren(
    h('div', {}, left ? h('span', {}, h('b', {}, new Set(g.changes.flatMap((c) => c.propagation.filter((e) => e.state === 'Not yet checked').map((e) => e.nodeId))).size), ' objects not yet judged against ', h('b', {}, left), ` change entr${left === 1 ? 'y' : 'ies'} from ${new Set(g.changes.filter((c) => c.propagation.some((e) => e.state === 'Not yet checked')).map((c) => c.id)).size} changes. Each object is judged once against every change that reached it, area by area.`) : 'Every downstream object has been judged.'),
    h('div', { class: 'faint' }, 'All entries: ', [...JUDGED, 'Not yet checked'].map((k) => `${k} ${totals[k]}`).join(' · ')),
    ordered.length ? h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Area'), h('th', {}, 'Not yet judged'), roundLabel ? h('th', {}, `${roundLabel}: ${judgedThisRound} judged`) : null)),
      h('tbody', {}, ...ordered.map(([a, r]) => h('tr', {},
        h('td', {}, areaName(a)),
        h('td', {}, r.left ? `${r.left} (${r.changes.size} change${r.changes.size === 1 ? '' : 's'})` : '—'),
        roundLabel ? h('td', { class: 'faint' }, JUDGED.some((k) => r.round[k]) ? JUDGED.filter((k) => r.round[k]).map((k) => `${k} ${r.round[k]}`).join(' · ') : '—') : null)))) : null,
  );
}

/**
 * Beside the levels (CKC-13 AC-8): the materials a job read only in part. §1.11 has no level for a part read, so each
 * keeps its own, and the line says which.
 */
function partReadsLine(rp) {
  if (!rp || !rp.materials) return null;
  return h('div', { class: 'faint read-in-part' }, `Read in part: ${rp.materials} material${rp.materials === 1 ? '' : 's'} (${kindsText(rp.byKind)}) — some of their lines were read, not all. Each stays at its level: ${Object.entries(rp.byLevel).map(([l, n]) => `${l} ${n}`).join(', ')}.`);
}
// The Keeper view's two pages are in keeper-view.js, and Keeper activity — the one list of the Keeper's work, with
// each round's tree — in keeper-activity.js (Spec §6.9, §6.10; D105).

/**
 * One follow-up round: its own account, the numbers the program counted, and what is still behind — one item in
 * `Notes (attention)` for the whole round, which leaves once it has been opened (D56 item 3). Opened from an item with
 * news (§3.8), it is named as the item names it (the round's number among all rounds) and carries the item's news with
 * their jumps; the news counts stand with the others. It stays reachable once opened — from `Since last visit`, from the
 * round in the Keeper view (§6.9), from an object the round judged — and reopened from where the news has no jumps at
 * hand, it lists the round's own news, each where it is.
 */
export async function openRound(roundId, { name = null, news = null } = {}) {
  const r = await api(`/api/projects/${P()}/rounds`);
  const round = r.rounds.find((x) => x.id === roundId);
  if (!round || !round.result) { toast('This round has no result yet'); return; }
  const c = round.result.counts;
  const n = c.news ?? null;
  news = [news, round.result.news ?? null].find((x) => x && !x.nothingNew) ?? null;
  const count = (k, one, many = `${one}s`) => (n?.[k] ? h('span', { class: 'tag news-count', 'data-news': k }, `${n[k]} ${n[k] === 1 ? one : many}`) : null);
  const body = h('div', { class: 'stack' },
    h('p', {}, round.result.summary),
    n ? h('div', { class: 'row wrap round-news-counts' },
      count('breakpoints', 'breakpoint newly lit', 'breakpoints newly lit'), count('sendbacksNew', 'new send-back'), count('sendbacksMoved', 'send-back moved', 'send-backs moved'),
      count('sixThings', 'newly among the six things', 'newly among the six things'), count('patches', 'semantic patch confirmed', 'semantic patches confirmed'), count('notes', 'note written or updated', 'notes written or updated')) : null,
    news ? newsBlock(news, () => document.querySelector('#dialog')?.close()) : null,
    h('div', { class: 'row wrap' },
      h('span', { class: 'tag' }, `${c.objectsJudged} object${c.objectsJudged === 1 ? '' : 's'} judged`),
      c.behind ? h('span', { class: 'tag amber' }, `${c.behind} still on the old understanding`) : null,
      c.itemsLacked ? h('span', { class: 'tag' }, `${c.itemsLacked} item${c.itemsLacked === 1 ? '' : 's'} not followed`) : null,
      c.notJudged ? h('span', { class: 'tag' }, `${c.notJudged} recorded at the time, not judged`) : null,
      c.requests ? h('span', { class: 'tag' }, `${c.requests} modification request${c.requests === 1 ? '' : 's'}`) : null,
      c.notes ? h('span', { class: 'tag' }, `${c.notes} note${c.notes === 1 ? '' : 's'}`) : null,
      c.decisionsReplaced ? h('span', { class: 'tag' }, `${c.decisionsReplaced} decision${c.decisionsReplaced === 1 ? '' : 's'} replaced`) : null),
    round.result.behind.length
      ? h('div', {}, h('b', {}, 'Still on the old understanding'), ...round.result.behind.map((b) => h('div', { class: 'item', ...pressable(() => openObject({ kind: 'node', id: b.nodeId, label: b.label })) }, h('div', {}, b.label), h('div', { class: 'meta' }, `${b.lacks} item${b.lacks === 1 ? '' : 's'} not followed${b.holder ? ` · held by ${b.holder}` : ''}`))))
      : null,
    round.result.unassigned.length ? h('div', {}, h('b', {}, 'Nobody to hand these to'), ...round.result.unassigned.map((u) => h('div', { class: 'muted' }, u))) : null,
    // Named as its item names it, the round's number is its number among all rounds; the record keeps a number of its own.
    h('div', { class: 'faint' }, `${name ? `Follow up record ${round.number}` : `Round ${round.number}`} · started ${fmtTime(round.startedAt)} · ended ${fmtTime(round.endedAt)}${round.mainJob ? ` · ${round.mainJob}` : ''}`));
  openDialog(name ?? `Follow up round ${round.number}`, [body]);
  // Opening it is the owner looking: it leaves the attention list. Opening it again leaves the record as it is.
  if (round.seenAt) return;
  await api(`/api/projects/${P()}/rounds/${encodeURIComponent(roundId)}/seen`, { method: 'POST' }).catch(() => undefined);
  await refreshProject();
}

// ── Keeper conversation panel (§6.8) ─────────────────────────────────────
const tokenAmount = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1000000).toFixed(n < 10000000 ? 1 : 0).replace(/\.0$/, '')}m`;
};
const contextAmount = (context) => {
  if (!context || (context.usedTokens == null && context.limitTokens == null)) return '—';
  const used = `${context.estimated && context.usedTokens != null ? '≈' : ''}${tokenAmount(context.usedTokens)}`;
  return `${used} / ${tokenAmount(context.limitTokens)}`;
};
/**
 * The conversation is built once and then only updated in its parts — the state and context in its head, the list of
 * sessions, the messages — so the panel can be docked, popped out and docked again, the view and even the project can
 * change, and a half-typed message and the scroll position are still there (CKC-10 AC-20). The Keeper's answers are
 * drawn as Markdown (AC-21); they are untrusted text, so they only ever become elements and text nodes (markdown.js).
 */
const conversation = {
  _ui: null, _loadedFor: null, _loading: 0, _branching: false, _lastJobId: null, _telemetry: null,
  loadKey() { const c = state.keeperContext; return `${state.projectId}|${state.conversationId ?? ''}|${c ? `${c.kind}:${c.id}` : ''}`; },

  render(panel) {
    if (conversation._ui?.panel !== panel || !panel.firstChild) conversation.mount(panel);
    conversation.sync();
    if (conversation.loadKey() !== conversation._loadedFor) void conversation.load();
  },

  mount(panel) {
    clear(panel);
    const stream = h('div', { class: 'keeper-stream', id: 'keeper-stream', role: 'log', 'aria-label': 'Conversation', tabindex: 0 });
    const sessionSel = h('select', { class: 'input small', title: 'Switch session', 'aria-label': 'Session', onChange: (e) => { state.conversationId = e.target.value || 'new'; void conversation.load(); } });
    const ta = h('textarea', { 'aria-label': 'Message to the Keeper' });
    let composing = false;
    ta.addEventListener('compositionstart', () => { composing = true; });
    ta.addEventListener('compositionend', () => { composing = false; });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !composing && !e.isComposing) { e.preventDefault(); send(); } });
    const send = async () => {
      const text = ta.value.trim();
      if (!text || ta.disabled) return;
      ta.value = '';
      append(stream, h('div', { class: 'msg user' }, text));
      stream.scrollTop = stream.scrollHeight;
      try {
        const r = await api(`/api/projects/${P()}/chat`, { method: 'POST', body: { text, context: state.keeperContext, conversationId: state.conversationId } });
        state.conversationId = r.conversationId;
        conversation._loadedFor = conversation.loadKey();   // the session this message started is the one already on screen
        if (r.mode === 'steer') append(stream, h('div', { class: 'msg system' }, 'Delivered as a mid-course adjustment; it reaches the Keeper after the current tool step.'));
        else if (r.status !== 'Running' && r.status !== 'Queued') append(stream, h('div', { class: 'msg system' }, `Queued (${r.status.toLowerCase()}). ${activity.reason || 'It is answered when the Keeper is back.'}`));
        conversation.loadSessions(sessionSel);
      } catch (e) { append(stream, h('div', { class: 'msg system' }, e.message)); }
    };
    const usage = h('span', { class: 'keeper-context-usage', dataset: { chatContext: '' } }, '—');
    const model = h('span', { class: 'keeper-model-name', dataset: { chatModel: '' } }, '—');
    const form = h('button', { class: 'btn small', onClick: () => setKeeperMode(keeperMode() === 'floating' ? 'docked' : 'floating') }, 'Pop out');
    const ctxName = h('strong', {});
    const ctxClear = h('button', { class: 'text-btn', onClick: () => toggleKeeper(true, null) }, 'clear');
    const foot = h('span', {});
    const sendBtn = h('button', { class: 'btn small primary', onClick: send }, 'Send');
    append(panel,
      h('div', { class: 'keeper-head' },
        h('div', { class: 'title' },
          h('span', { class: 'keeper-who' }, h('span', { class: 'pi-mark' }, 'π'), h('span', {}, 'Keeper')),
          h('span', { class: 'keeper-head-right' },
            h('span', { class: 'keeper-telemetry' },
              h('span', { class: 'keeper-telemetry-item' }, h('small', {}, 'Context'), usage),
              h('span', { class: 'keeper-telemetry-item' }, h('small', {}, 'Model'), model)),
            h('span', { class: 'row keeper-actions' }, form, h('button', { class: 'btn small', onClick: () => toggleKeeper(false) }, 'Close')))),
        h('div', { class: 'ctx' }, 'Context ', ctxName, ctxClear),
        h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, sessionSel),
          h('button', { class: 'btn small', title: 'Start a new session; earlier sessions stay available', onClick: () => { state.conversationId = 'new'; void conversation.load(); } }, 'New session'),
          h('button', { class: 'btn small', title: 'Continue in pi’s own interface with the same project assets', onClick: async () => { try { const r = await api(`/api/projects/${P()}/keeper/open-in-pi`, { method: 'POST', body: { jobId: conversation._lastJobId ?? null } }); toast(r.message); } catch (e) { toast(e.message); } } }, 'Open in pi'))),
      stream,
      h('div', { class: 'composer' }, ta, h('div', { class: 'foot' }, foot, sendBtn)));
    conversation._ui = { panel, stream, sessionSel, ta, usage, model, form, ctxName, ctxClear, foot, sendBtn };
    conversation._loadedFor = null;
  },

  /** The head and the composer follow the Keeper's state, the context and the panel's form, in place. */
  sync() {
    const ui = conversation._ui;
    if (!ui) return;
    const st = activity.status;
    const ctx = state.keeperContext;
    const off = st === 'Not connected';
    conversation.paintTelemetry();
    ui.ctxName.textContent = ctx ? (ctx.label || `${ctx.kind} ${ctx.id}`) : 'Whole project';
    ui.ctxName.title = ui.ctxName.textContent;
    ui.ctxClear.hidden = !ctx;
    const floating = keeperMode() === 'floating';
    ui.form.textContent = floating ? 'Dock' : 'Pop out';
    ui.form.title = floating ? 'Put the conversation back on the right of the workbench' : 'Make the conversation a window you can move and resize';
    ui.ta.disabled = off;
    ui.sendBtn.disabled = off;
    ui.ta.placeholder = off ? `Input unavailable: ${activity.reason || 'the Keeper is not connected'}` : 'Ask, correct, or delegate. Enter sends, Shift+Enter is a new line.';
    ui.foot.textContent = off ? 'Messages cannot be sent while not connected.' : st === 'Waiting for quota' ? 'Messages are queued until quota is back; you can also switch model or provider in Keeper.' : st === 'Unavailable' ? `Messages are queued; the Keeper is temporarily unavailable${activity.reason ? `: ${activity.reason}` : ''}.` : st === 'Organizing paused' ? 'Organizing is paused; the conversation works as usual.' : '';
  },

  setTelemetry(telemetry) {
    conversation._telemetry = telemetry ?? null;
    conversation.paintTelemetry();
  },
  paintTelemetry() {
    const ui = conversation._ui;
    if (!ui) return;
    const telemetry = conversation._telemetry;
    const ctx = telemetry?.context ?? null;
    const model = telemetry?.model ?? null;
    ui.usage.textContent = contextAmount(ctx);
    ui.usage.title = ctx ? `${ctx.estimated ? 'Estimated ' : ''}context use${ctx.source ? ` · ${ctx.source}` : ''}${ctx.percent == null ? '' : ` · ${ctx.percent}%`}` : 'Context use unavailable';
    ui.model.textContent = model?.name || model?.id || '—';
    ui.model.title = model ? [model.name, model.provider && model.id ? `${model.provider}/${model.id}` : model.provider || model.id].filter(Boolean).join(' · ') : 'Model unavailable';
  },

  async refreshTelemetry() {
    if (!conversation._ui || !state.projectId) return;
    const key = conversation.loadKey();
    const ui = conversation._ui;
    try {
      const r = await api(`/api/projects/${P()}/chat?conversation=${encodeURIComponent(state.conversationId ?? '')}`);
      if (key !== conversation.loadKey() || ui !== conversation._ui) return;
      conversation.setTelemetry(r.telemetry);
    } catch { /* keep the last live reading */ }
  },

  /** Another project, session or context: the messages are read again. What is being typed is not touched. */
  async load() {
    const ui = conversation._ui;
    if (!ui) return;
    const token = ++conversation._loading;
    const key = conversation.loadKey();
    if (conversation._loadedFor !== key) conversation.setTelemetry(null);
    conversation._loadedFor = key;
    const stream = h('div');
    const acceptedKey = await conversation.loadHistory(stream, state.keeperContext, ui.sessionSel, { key, token, ui });
    if (!acceptedKey || token !== conversation._loading || acceptedKey !== conversation.loadKey() || ui !== conversation._ui) return;
    conversation._loadedFor = acceptedKey;
    ui.stream.replaceChildren(...stream.childNodes);
    ui.stream.scrollTop = ui.stream.scrollHeight;
  },
  focus() { const ui = conversation._ui; if (!ui) return; if (!ui.ta.disabled) ui.ta.focus({ preventScroll: true }); else ui.panel.closest('#keeper')?.focus({ preventScroll: true }); },
  /**
   * Before the panel changes form: remember what the owner is looking at, and return a function that brings it back.
   * At the end of the conversation it stays at the end; elsewhere the message at the top of the view stays there,
   * whatever the new width does to the lines.
   */
  holdScroll() {
    const s = conversation._ui?.stream;
    if (!s) return () => {};
    const atEnd = s.scrollHeight - s.scrollTop - s.clientHeight < 4;
    const top = s.getBoundingClientRect().top;
    const first = [...s.children].find((m) => m.getBoundingClientRect().bottom > top + 1) ?? null;
    const offset = first ? first.getBoundingClientRect().top - top : 0;
    return () => {
      if (atEnd) s.scrollTop = s.scrollHeight;
      else if (first?.isConnected) s.scrollTop += first.getBoundingClientRect().top - s.getBoundingClientRect().top - offset;
    };
  },

  async loadSessions(sel) {
    const key = conversation.loadKey();
    const ui = conversation._ui;
    try {
      const r = await api(`/api/projects/${P()}/chat?conversation=${encodeURIComponent(state.conversationId ?? '')}`);
      if (key !== conversation.loadKey() || ui !== conversation._ui || sel !== ui?.sessionSel) return;
      conversation.fillSessions(sel, r);
      conversation.setTelemetry(r.telemetry);
    } catch { /* keep */ }
  },
  fillSessions(sel, r) {
    clear(sel);
    if (state.conversationId === 'new' || (!r.conversationId && r.sessions.length === 0)) sel.append(h('option', { value: '', selected: true }, 'New session'));
    for (const s of r.sessions) sel.append(h('option', { value: s.id, selected: s.id === (state.conversationId === 'new' ? null : r.conversationId) }, `${s.title} · ${s.turns} turn${s.turns === 1 ? '' : 's'} · ${fmtRel(s.lastAt)}`));
    if (state.conversationId !== 'new' && r.sessions.length) sel.append(h('option', { value: '' }, 'New session'));
  },
  async loadHistory(stream, ctx, sel, request) {
    try {
      const r = await api(`/api/projects/${P()}/chat?conversation=${encodeURIComponent(state.conversationId ?? '')}&context=${encodeURIComponent(JSON.stringify(ctx ?? null))}`);
      if (request.token !== conversation._loading || request.key !== conversation.loadKey() || request.ui !== conversation._ui || sel !== request.ui.sessionSel) return null;
      conversation.fillSessions(sel, r);
      conversation.setTelemetry(r.telemetry);
      conversation._branching = r.branchingSupported;
      if (state.conversationId !== 'new') state.conversationId = r.conversationId;
      if (r.existing) append(stream, h('div', { class: 'msg keeper existing' }, h('small', { class: 'faint', title: r.existing.at ? fmtTime(r.existing.at) : 'Written before this conversation, not generated now' }, r.existing.at ? `Written earlier · ${fmtRel(r.existing.at)}` : 'Written earlier'), conversation.answer(r.existing.text), r.existing.sourceIds?.length ? h('div', { class: 'cites' }, ...r.existing.sourceIds.slice(0, 8).map((sid) => h('button', { class: 'cite', title: 'Open this source', onClick: () => openSource(sid) }, sid.slice(0, 10)))) : null));
      const turns = state.conversationId === 'new' ? [] : r.turns;
      for (const t of turns) {
        conversation.appendMessage(stream, { role: 'user', text: t.question, context: t.context });
        for (const f of t.followUps) conversation.appendMessage(stream, { role: 'user', text: f.text, mid: true });
        if (t.answer) conversation.appendMessage(stream, { role: 'keeper', id: t.jobId, text: t.answer, steps: t.steps, status: t.status, kind: t.kind, requestBasis: t.requestBasis, canBranch: t.canBranch, savedResults: t.savedResults, result: t.result });
        else conversation.appendMessage(stream, { role: 'system', text: t.status === 'Running' ? 'The Keeper is answering…' : t.error ? `${t.status}: ${t.error}` : t.status === 'Queued' ? 'Queued.' : t.status });
        conversation._lastJobId = t.jobId;
      }
      return conversation.loadKey();
    } catch (e) {
      if (request.token !== conversation._loading || request.key !== conversation.loadKey() || request.ui !== conversation._ui) return null;
      append(stream, h('div', { class: 'msg system' }, e.message));
      return conversation.loadKey();
    }
  },
  /** An answer, drawn as Markdown with its `[src_…]` citations as chips that open the source (Spec §6.8). */
  answer(text) { return fillMarkdown(h('div', { class: 'text md' }), text || '', { onCite: openCited }); },
  /** While an answer streams it is drawn again at most once a frame, so the marks never show and a long answer does not stall. */
  paint(el, text) {
    el._md = text;
    if (el._queued) return;
    el._queued = true;
    requestAnimationFrame(() => {
      el._queued = false;
      if (!el.isConnected) return;
      const stream = el.closest('.keeper-stream');
      const atEnd = stream ? stream.scrollHeight - stream.scrollTop - stream.clientHeight < 24 : false;
      fillMarkdown(el, el._md, { onCite: openCited });
      if (atEnd) stream.scrollTop = stream.scrollHeight;
    });
  },
  /** An investigation result (§5.2): what to adjust, why, where it affects; the current description or discussable options. */
  resultBlock(r) {
    const cites = (ids) => (ids || []).map((sid) => h('button', { class: 'cite', title: 'Open this source', onClick: () => openCited(sid) }, sid.slice(0, 10)));
    const nodeBtn = (id) => h('button', { class: 'text-btn', onClick: () => select({ kind: 'node', id, label: id }) }, id);
    return h('div', { class: 'result' },
      h('div', {}, h('b', {}, 'What to adjust: '), r.adjust), h('div', {}, h('b', {}, 'Why: '), r.why),
      r.affected?.length ? h('div', {}, h('b', {}, 'Affects: '), h('button', { class: 'text-btn', onClick: () => highlightOnGraph(r.affected.map((a) => a.id)) }, 'Show on graph'), h('ul', {}, ...r.affected.map((a) => h('li', {}, nodeBtn(a.id), ' — ', a.reason, ' ', ...cites(a.sourceIds))))) : null,
      r.decided ? h('div', {}, h('span', { class: 'tag green' }, 'Already decided'), r.currentDescription ? h('div', {}, h('b', {}, 'Now in force: '), r.currentDescription) : null, r.oldWording?.length ? h('div', {}, h('b', {}, 'Still on the old wording:'), h('ul', {}, ...r.oldWording.map((o) => h('li', {}, ...cites([o.sourceId]), ' ', o.wording)))) : null, r.referencesToUpdate?.length ? h('div', {}, h('b', {}, 'References to update: '), r.referencesToUpdate.join(', ')) : null)
        : h('div', {}, h('span', { class: 'tag blue' }, 'Direction not decided'), ...(r.options || []).map((o) => h('div', { class: 'option' }, h('b', {}, o.title), ' ', h('span', { class: 'tag blue' }, 'Proposed'), h('div', { class: 'muted' }, 'Effects: ', o.effects), h('div', { class: 'muted' }, 'Work and results that change: ', o.workToChange), h('div', { class: 'muted' }, 'Cost: ', o.cost), h('div', { class: 'muted' }, 'Reusable: ', o.reusable)))));
  },
  appendMessage(stream, m) {
    const atEnd = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 24;
    if (m.role === 'user') append(stream, h('div', { class: `msg user${m.mid ? ' mid' : ''}` }, m.mid ? h('small', { class: 'faint' }, 'mid-course · ') : null, m.text, m.context?.label ? h('small', { class: 'faint' }, ` · on ${m.context.label}`) : null));
    else if (m.role === 'keeper') {
      const steps = Array.isArray(m.steps) ? m.steps : [];
      append(stream, h('div', { class: 'msg keeper', dataset: { id: m.id } },
        m.kind === 'Your request' ? h('div', {}, h('span', { class: 'tag amber' }, 'Your request'), m.requestBasis ? h('small', { class: 'faint' }, ` ${m.requestBasis.label}`) : null) : null,
        conversation.answer(m.text),
        m.result ? conversation.resultBlock(m.result) : null,
        m.status && m.status !== 'Done' ? h('small', { class: 'faint' }, m.status) : null,
        steps.length ? h('details', { class: 'fold' }, h('summary', {}, `How the Keeper investigated (${steps.length} steps)`), h('div', { class: 'content' }, ...steps.map((s) => h('div', { class: `mono${s.isError ? ' red' : ''}` }, `${s.tool} ${s.target}${s.summary ? ' — ' + s.summary : ''}`)))) : h('small', { class: 'faint' }, 'Answered from the assets; no tool was used.'),
        m.savedResults?.length ? h('div', { class: 'row wrap' }, h('small', { class: 'faint' }, 'Saved:'), ...m.savedResults.slice(0, 6).map((r) => h('span', { class: 'tag' }, r.label))) : null,
        h('div', { class: 'row wrap' }, state.keeperContext?.kind === 'node' ? h('button', { class: 'text-btn', onClick: () => showOnGraph(state.keeperContext) }, 'Show on graph') : null, m.canBranch && conversation._branching ? h('button', { class: 'text-btn', title: 'Continue from this point in a new branch of the same session', onClick: async () => { const r = await api(`/api/projects/${P()}/chat/branch`, { method: 'POST', body: { conversationId: state.conversationId, jobId: m.id } }); toast(r.ok ? 'Branched: the next message continues from here' : `Branch unavailable: ${r.reason}`); } }, 'Branch here') : null)));
    } else append(stream, h('div', { class: 'msg system' }, m.text));
    if (atEnd || m.role === 'user') stream.scrollTop = stream.scrollHeight;
  },
  onEvent(event) {
    const stream = conversation._ui?.stream;
    if (!stream) return;
    const d = event.data || {};
    if (event.type === 'chat' && d.kind === 'delta') {
      const x = d.data || {};
      let el = stream.querySelector(`[data-id="${CSS.escape(String(x.messageId))}"]`);
      if (!el) { el = h('div', { class: 'msg keeper streaming', dataset: { id: x.messageId } }, h('div', { class: 'text md' })); append(stream, el); }
      el._raw = (el._raw ?? '') + (x.text ?? '');
      conversation.paint(el.querySelector('.text'), el._raw);
    } else if (event.type === 'keeper' && d.kind === 'done') {
      const x = d.data || {};
      if (!x.conversation) return;
      const el = x.messageId ? stream.querySelector(`[data-id="${CSS.escape(String(x.messageId))}"]`) : null;
      if (el) el.remove();
      const t = { role: 'keeper', id: d.jobId, text: x.resultText || '', steps: x.steps, status: x.status, kind: x.kind, requestBasis: x.requestBasis, savedResults: x.savedResults, canBranch: Boolean(x.leafId), result: x.result };
      if (x.resultText) conversation.appendMessage(stream, t);
      else if (x.error || x.status !== 'Done') conversation.appendMessage(stream, { role: 'system', text: x.error ? `${x.status}: ${x.error}` : x.status });
      conversation._lastJobId = d.jobId;
      void conversation.refreshTelemetry();
    } else if (event.type === 'keeper') void conversation.refreshTelemetry();
  },
};

// ── Project graph (Spec §6.2, §6.3) ──────────────────────────────────────
// Stars mark what is new or changed (owner 2026-09-17): since the last visit, or within the last one to three days.
const STAR_KEY = 'pk.graph.stars';
function starMode() { try { return localStorage.getItem(STAR_KEY) === 'days' ? 'days' : 'visit'; } catch { return 'visit'; } }
function setStarMode(mode) { try { localStorage.setItem(STAR_KEY, mode); } catch { /* per-viewer convenience only */ } }
let graphCtl = null;
let stripEl = null;
let legendEl = null;
let compareEl = null;
const compareState = { from: '', to: 'now', index: 0, all: false };

const DIFF_KINDS = ['Added', 'Content changed', 'Regrouped', 'Relinked', 'Removed'];

function closeCompare() {
  if (compareEl?.isConnected) compareEl.remove();
  compareEl = null;
  graphCtl?.setCompare(null);
}

/**
 * `Compare` (D45): two saved versions side by side. `Before` and `After` are the pictures themselves; `Delta`
 * draws only the objects that differ, so a project of this size does not hide the difference among everything that
 * stayed the same. The bar walks the differences one at a time, which is how the owner asked to read them.
 */
async function openCompare(wrap) {
  let data;
  try { data = await api(`/api/projects/${P()}/compare?from=${encodeURIComponent(compareState.from)}&to=${encodeURIComponent(compareState.to)}`); }
  catch (e) { toast(e.message); return; }
  const versions = data.versions ?? [];
  if (data.error) { toast(data.error); }
  compareState.from = data.from?.id ?? compareState.from;
  compareState.index = Math.min(compareState.index, Math.max(0, (data.items?.length ?? 1) - 1));
  const items = data.items ?? [];
  const label = (v) => `${fmtTime(v.at)} · ${v.reason}`;
  const pick = (which, value) => h('select', { class: 'input small', onChange: (e) => { compareState[which] = e.target.value; compareState.index = 0; void openCompare(wrap); } },
    ...(which === 'to' ? [h('option', { value: 'now', selected: value === 'now' }, 'Now')] : []),
    ...versions.slice().reverse().map((v) => h('option', { value: v.id, selected: v.id === value }, label(v))));
  const side = (name) => h('button', { class: `btn small${compareState.side === name ? ' active' : ''}`, onClick: () => { compareState.side = name; graphCtl?.setCompare({ ...compareState, items }); paint(); } }, name);
  const current = items[compareState.index];
  const step = (by) => { compareState.index = Math.max(0, Math.min(items.length - 1, compareState.index + by)); graphCtl?.setCompare({ ...compareState, items }); paint(); };
  const bar = h('div', { class: 'compare-bar' });
  const paint = () => {
    clear(bar);
    const it = items[compareState.index];
    append(bar,
      h('div', { class: 'row wrap' }, h('small', {}, 'From'), pick('from', compareState.from), h('small', {}, 'to'), pick('to', compareState.to),
        side('Before'), side('Delta'), side('After')),
      h('div', { class: 'row wrap' }, ...DIFF_KINDS.map((k) => h('span', { class: `tag${(data.counts?.[k] ?? 0) ? ' amber' : ''}` }, `${k} ${data.counts?.[k] ?? 0}`))),
      items.length
        ? h('div', { class: 'row wrap' },
          h('button', { class: 'btn small', disabled: compareState.index <= 0, onClick: () => step(-1) }, '‹'),
          h('small', {}, `${compareState.index + 1} / ${items.length}`),
          h('button', { class: 'btn small', disabled: compareState.index >= items.length - 1, onClick: () => step(1) }, '›'),
          it ? h('span', {}, h('span', { class: 'tag' }, it.kind), ' ', h('button', { class: 'text-btn', onClick: () => select({ kind: 'node', id: it.id, label: it.label }) }, it.label), it.detail ? h('span', { class: 'muted' }, ` — ${it.detail}`) : null) : null)
        : h('small', { class: 'faint' }, data.error ?? 'Nothing differs between these two versions.'));
  };
  compareState.side = compareState.side ?? 'Delta';
  paint();
  if (compareEl?.isConnected) compareEl.replaceWith(bar); else wrap.prepend(bar);
  compareEl = bar;
  graphCtl?.setCompare({ ...compareState, items });
}
const NODE_SEL = (n) => ({ kind: 'node', id: n.id, label: n.label, category: n.category });

function overviewUrl() {
  return `/api/projects/${P()}/overview?since=${encodeURIComponent(state.lastVisit ?? '')}&selection=${encodeURIComponent(state.selection?.kind === 'node' || state.selection?.kind === 'relation' ? state.selection.id : '')}`;
}

// ── The bottom strip (Spec §6.2; CKC-09 AC-38, AC-1): one-line indexes and one full-width reading sheet ─────────
/**
 * Every row of the three columns is the same four slots — mark · one sentence · object · time (strip-rows.js says how
 * they are taken from /overview). A press on a row opens it where it is: the whole text, how it came about, what it
 * rests on and what can be done about it, nothing less than the two-line items and the popover behind them held. One
 * row is open at a time, in a sheet across the whole strip, so the columns stay useful as indexes. A row
 * that is itself an object (work that moved on) opens that object's popover instead (§6.4).
 *
 * The strip is rebuilt from every overview the page fetches and swapped in column by column only where it differs, so
 * nothing blinks while the Keeper works; which row is open, how far each column is scrolled and where focus is are
 * kept. What an open row shows is kept too (`stripData`), so a rebuilt strip draws it at once and unchanged, and it
 * is read again after an asset event and redrawn only if it differs.
 */
let stripOpen = null;          // { col, key }: the one row shown in the full-width reading sheet
const stripData = new Map();   // row key → what its expansion is drawn from (a note's details, a change record)
let stripOv = null;            // the overview the strip was last built from
const STRIP_COLS = { attention: 'Notes (attention)', changes: 'Recent changes', since: 'Since last visit' };

function strip(ov) {
  stripOv = ov;
  syncAttentionTargets();
  const cols = ['attention', 'changes', ...(ov.sinceLastVisit ? ['since'] : [])];
  if (stripOpen && (!cols.includes(stripOpen.col) || !stripRows(stripOpen.col).some((r) => r.row.key === stripOpen.key))) stripOpen = null;
  return h('div', { class: `strip${ov.sinceLastVisit ? ' three' : ' two'}`, id: 'drawer-strip' }, ...cols.map(stripSection));
}
/** The rows of one column, each with the /overview item it was made from. */
function stripRows(col) {
  const ov = stripOv;
  // The whole-project part only: an attention note on an object is marked ❓ on it (Spec §6.2; D100).
  if (col === 'attention') return drawerAttention(ov).map((item) => ({ row: attentionRow(item), item }));
  if (col === 'changes') return ov.recentChanges.map((item) => ({ row: changeRow(item), item }));
  const s = ov.sinceLastVisit;
  const items = [...(s.rounds ?? []), ...s.threads, ...s.changes, ...s.notes];
  return sinceRows(s).map((row, i) => ({ row, item: items[i] }));
}
function stripSection(col) {
  const ov = stripOv;
  const rows = stripRows(col);
  let head;
  let none = '';
  if (col === 'attention') {
    // The header says why this is fewer than the project's notes, counting notes only (D50; CKC-09 AC-1, Spec §6.2):
    // scope questions, finished requests and Follow up results are listed here too, but counted on their own. The
    // header itself is one line, like the other columns'; the two lines and the full sentences open in a card on
    // hover or focus of the header (owner 2026-09-22; styles.css .strip-why).
    const a = attentionHeader(ov, onObjectNotes(ov).length);
    // How many more wait on objects, marked ❓ there, stays in sight in the header; pressed, the Graph and the List show
    // only those objects (CKC-09 AC-38).
    head = h('header', { tabindex: '0' }, h('div', { class: 'strip-title' }, h('span', {}, STRIP_COLS[col]), h('span', { class: 'strip-counts' }, a.onObjects ? attentionCountButton(a.onObjects) : null, h('small', {}, a.count))),
      h('div', { class: 'strip-why', role: 'tooltip' }, a.why ? h('span', {}, a.why) : null, a.also ? h('span', {}, a.also) : null, h('small', {}, a.hint)));
    none = ov.relookDone ? 'Nothing waits for you.' : 'No notes yet — the first product re-look has not finished.';
  } else if (col === 'changes') {
    head = h('header', { title: 'The last ten changes of product meaning or state, the newest at the bottom. The Change log is the whole history, oldest to newest.' }, h('div', { class: 'strip-title' }, h('span', {}, STRIP_COLS[col]), h('small', {}, rows.length || '')));
    none = 'No change history has been established for this project.';
  } else {
    const s = ov.sinceLastVisit;
    const said = `${fmtRel(s.since)} · ${s.jobs} Keeper jobs${s.failed ? ` · ${s.failed} failed` : ''}`;
    const rounds = (s.rounds ?? []).length;
    head = h('header', { title: `What moved since you last opened this project (${fmtTime(s.since)}): ${rounds ? `${rounds} Follow up round${rounds === 1 ? '' : 's'}, each summed up in its row; ` : ''}${s.jobs} Keeper jobs finished${s.failed ? `, ${s.failed} failed` : ''}` }, h('div', { class: 'strip-title' }, h('span', {}, STRIP_COLS[col]), h('small', {}, said)));
  }
  return h('section', { 'data-col': col }, head, h('div', { class: 'items' }, rows.length ? rows.map(({ row, item }) => stripRow(col, row, item)) : h('div', { class: 'none' }, none)));
}
function stripRow(col, row, item) {
  const open = !row.opens && stripOpen?.col === col && stripOpen.key === row.key;
  const picked = Boolean(state.selection) && state.selection.id === item.id;
  const line = h('div', { class: `item${picked ? ' sel' : ''}`, 'data-note': row.noteId, 'aria-expanded': row.opens ? null : String(open), ...pressable(() => pressStripRow(col, row, item)) },
    h('span', { class: 'row-marks' }, ...row.marks.map((m) => h('span', { class: `mk mk-${m.tone}`, title: m.title, role: 'img', 'aria-label': m.title }, m.glyph))),
    // The hover has the whole row: in a narrow column the object and the time give way to the sentence (styles.css).
    h('span', { class: 'row-text', title: [row.text, row.object.title, row.time ? fmtTime(row.time) : ''].filter(Boolean).join('\n') }, row.text),
    row.object.text ? h('span', { class: 'row-object', title: row.object.title }, row.object.text) : null,
    row.time ? h('time', { class: 'row-time', datetime: row.time, title: fmtTime(row.time) }, fmtRel(row.time)) : null);
  return h('div', { class: `strip-row${open ? ' open' : ''}`, 'data-row': row.key }, line);
}

/** A press on a row: an object opens its popover; anything else opens in place, and closes what was open in its column. */
function pressStripRow(col, row, item) {
  if (row.opens) { select(row.opens); return; }
  const opening = stripOpen?.col !== col || stripOpen.key !== row.key;
  stripOpen = opening ? { col, key: row.key } : null;
  // The note that is open is the one the owner is on: the top bar names it and `Ask Keeper` is about it, as before.
  if (opening && row.noteId) select({ kind: 'note', id: row.noteId, label: row.text }, { popover: false });
  syncStripRowStates();
  syncStripSheet({ opening });
  // At the same time the objects it is about are found on the graph (Spec §6.2); closing it takes the marks away.
  locateOnGraph(opening ? stripObjects(row, item) : []);
}

function openStripEntry() {
  if (!stripOpen) return null;
  const found = stripRows(stripOpen.col).find((x) => x.row.key === stripOpen.key);
  return found ? { ...found, col: stripOpen.col } : null;
}

function syncStripRowStates() {
  if (!stripEl) return;
  for (const el of stripEl.querySelectorAll('.strip-row')) {
    const section = el.closest('section[data-col]');
    const open = Boolean(stripOpen && section?.dataset.col === stripOpen.col && el.dataset.row === stripOpen.key);
    el.classList.toggle('open', open);
    el.querySelector('.item')?.setAttribute('aria-expanded', String(open));
  }
}

function stripSheet(entry) {
  const { col, row, item } = entry;
  const title = [row.text, row.object?.text, row.time ? fmtTime(row.time) : ''].filter(Boolean).join(' · ');
  return h('aside', { class: 'strip-sheet', 'data-row': row.key, 'data-col': col, 'aria-label': title, tabindex: '-1' },
    h('div', { class: 'strip-sheet-head' },
      h('div', { class: 'strip-sheet-heading' },
        h('span', { class: 'row-marks' }, ...row.marks.map((m) => h('span', { class: `mk mk-${m.tone}`, title: m.title, role: 'img', 'aria-label': m.title }, m.glyph))),
        h('strong', { title }, row.text),
        row.object?.text ? h('small', { title: row.object.title }, row.object.text) : null),
      h('button', { class: 'btn small strip-sheet-close', 'aria-label': 'Close reading panel', title: 'Close', onClick: () => closeStripSheet({ focus: true }) }, 'Close')),
    h('div', { class: 'row-more strip-sheet-body' }, ...stripExpansion(col, row, item)));
}

/** Keep the sheet stable across polling. If its content is unchanged, its DOM and reading position stay untouched. */
function syncStripSheet({ opening = false } = {}) {
  if (!stripEl?.isConnected) return;
  const current = stripEl.querySelector(':scope > .strip-sheet');
  const entry = openStripEntry();
  stripEl.classList.toggle('has-sheet', Boolean(entry));
  if (!entry) { current?.remove(); return; }
  const next = stripSheet(entry);
  if (current && current.dataset.row === next.dataset.row && visHtml(current.outerHTML) === visHtml(next.outerHTML)) return;
  const top = current?.querySelector('.strip-sheet-body')?.scrollTop ?? 0;
  if (current) current.replaceWith(next); else stripEl.append(next);
  next.querySelector('.strip-sheet-body').scrollTop = top;
  if (opening && !current) {
    next.classList.add('opening');
    const settled = () => next.classList.remove('opening');
    next.addEventListener('animationend', settled, { once: true });
    setTimeout(settled, 300);   // reduced motion has no animationend
  }
}

function closeStripSheet({ focus = false } = {}) {
  if (!stripOpen) return false;
  const closing = stripOpen;
  stripOpen = null;
  stripEl?.querySelector(':scope > .strip-sheet')?.remove();
  stripEl?.classList.remove('has-sheet');
  syncStripRowStates();
  locateOnGraph([]);
  if (focus) stripEl?.querySelector(`section[data-col="${CSS.escape(closing.col)}"] [data-row="${CSS.escape(closing.key)}"] .item`)?.focus({ preventScroll: true });
  return true;
}
/** The objects a row is about: what a note hangs on (a relation by its two ends), what a change reached and did not remove. */
function stripObjects(row, item) {
  if (row.key.startsWith('change:')) { const c = changeOf(item); return c ? (c.affectsLabels ?? []).filter((a) => !a.removed).map((a) => a.id) : []; }
  const relations = graph._data?.relations ?? [];
  return (item.object?.objects ?? []).flatMap((o) => { if (o.kind !== 'relation') return [o.id]; const r = relations.find((x) => x.id === o.id); return r ? [r.from, r.to] : []; });
}
/** Find objects on the graph without taking the view over: they are marked, and brought into view only when none of them is in sight. */
let located = 0;
function locateOnGraph(ids) {
  const token = ++located;
  if (!onGraphNow()) return;
  if (!ids.length) { graphCtl.highlight([]); return; }
  const inSight = (id) => { const r = graphCtl.rectOf(id); return Boolean(r) && r.right - r.left > 1 && r.bottom - r.top > 1; };
  if (!ids.some(inSight)) graphCtl.reveal(ids[0]);   // folded away or out of the window: opened, and brought to the middle
  graphCtl.highlight(ids);
  // `reveal` takes its own flash away after a moment; the mark stays for as long as the row is open.
  setTimeout(() => { if (token === located && onGraphNow()) graphCtl.highlight(ids); }, 1600);
}
/** The full record of a change row: Recent changes carries it; one of `Since last visit` is looked up there, or read. */
const changeOf = (item) => (item.propagationSummary ? item : stripOv?.recentChanges.find((c) => c.id === item.id) ?? stripData.get(`change:${item.id}`) ?? null);

/** What an open row holds. Read from the assets where the row itself does not carry it, and kept for the next rebuild. */
function stripExpansion(col, row, item) {
  if (row.noteId) {
    const x = stripData.get(row.key);
    if (!x) { void loadStripRow(col, row.key, () => api(`/api/projects/${P()}/notes/${encodeURIComponent(row.noteId)}`), { reveal: true }); return [h('div', { class: 'faint' }, 'Loading…')]; }
    return noteExpansion(col, row, item, x);
  }
  if (row.key.startsWith('change:')) {
    const c = changeOf(item);
    if (!c) { void loadStripRow(col, row.key, async () => (await api(`/api/projects/${P()}/changes`)).changes.find((k) => k.id === item.id) ?? { id: item.id, title: item.title, effect: item.effect, at: item.at, affectsLabels: [], propagationSummary: {} }, { reveal: true }); return [h('div', { class: 'faint' }, 'Loading…')]; }
    return changeExpansion(c);
  }
  // A Follow up result with news: what the round made new, by kind, each where it is and a press away (CKC-07 AC-27).
  if (item.kind === 'round' && item.news) return roundNewsExpansion(item);
  // A scope question, a finished request, a Follow up result from before rounds counted their news: what the second line
  // said, and the way to the rest.
  const go = item.kind === 'scope-question' ? ['Answer in Project scope', () => navigate(state.projectId, 'scope')] : item.kind === 'round' ? ['Open the result', () => openRound(item.id)] : ['Open Keeper activity', () => openActivity()];
  return [h('div', { class: 'more-title' }, item.label), item.detail ? h('p', { class: 'more-text' }, item.kind === 'scope-question' ? `Why it matters: ${item.detail}` : item.detail) : null,
    h('div', { class: 'row wrap more-actions' }, h('button', { class: 'btn small', onClick: go[1] }, go[0]))];
}

// ── A Follow up result's news (Spec §3.8, §6.2; D79; CKC-07 AC-27, CKC-24 AC-15) ─────────────────────────────
/** The five kinds of news in the order the contract names them, each a fixed slot the round's count fills. */
const NEWS_KINDS = [
  ['breakpoints', 'Breakpoints newly lit'], ['sendbacks', 'Send-backs new or moved'], ['sixThings', 'Newly among the six things'],
  ['patches', 'Semantic patches confirmed'], ['notes', 'Notes written or updated'],
];
/** What a press on an entry opens: the jumps the workbench has. */
const NEWS_GO = {
  process: (go) => `Show ${go.label} in the process view`, code: (go) => `Show the territory ${go.label} in Code`,
  note: (go) => `Open the note “${go.label}”`, patch: (go) => `Open the semantic patch ${go.label}`,
};
function goNews(go) {
  if (go.to === 'note') { select({ kind: 'note', id: go.id, label: go.label }); return; }
  if (go.to === 'patch') { void kProcess.openPatch(go.id); return; }
  // An object in the process view (the Project graph, from Code too), or a territory in Code: the way a breakpoint's
  // or a send-back's `Show on object` goes (k-process.js).
  void kProcess.locateTarget(go.id, go.to === 'code');
}
/**
 * The news of a round by kind, a kind only when it has something: each entry says what it is, where it is (its
 * position), and what changed for it this round; a press on it goes there. `leave` closes what it is drawn in first.
 */
function newsBlock(news, leave) {
  return h('div', { class: 'round-news' }, ...NEWS_KINDS.filter(([kind]) => news[kind]?.length).map(([kind, title]) => h('section', { class: 'news-kind', 'data-news': kind },
    h('h4', {}, `${title} (${news[kind].length})`),
    h('ul', { class: 'news-list' }, ...news[kind].map((i) => h('li', { 'data-news-id': i.id, 'data-go': i.go?.to ?? '' },
      i.go ? h('button', { class: 'text-btn news-go', title: NEWS_GO[i.go.to]?.(i.go) ?? i.position, onClick: () => { leave?.(); goNews(i.go); } }, i.label) : h('span', { class: 'news-label' }, i.label),
      h('span', { class: 'news-pos' }, i.position),
      // What changed for it this round: a stage or a version as a tag; a breakpoint's is the sentence of why it is lit.
      i.detail ? kind === 'breakpoints' ? h('span', { class: 'news-why' }, i.detail) : h('span', { class: 'tag news-detail' }, i.detail) : null))))));
}
function roundNewsExpansion(item) {
  const news = item.news;
  const name = item.roundName ?? null;
  return [
    h('div', { class: 'more-title' }, item.label),
    newsBlock(news, () => closeStripSheet()),
    // The objects its judgements left on the old understanding (§5.5): counted here, named in the result.
    item.behind ? h('p', { class: 'more-text round-behind' }, `${item.behind} object${item.behind === 1 ? '' : 's'} still on the old understanding${item.unassigned ? `, ${item.unassigned} with no holder` : ''}: the round's result names them.`) : null,
    news.complete === false ? h('p', { class: 'more-text news-incomplete' }, 'This round began before rounds kept where things stood at their start: the send-backs it moved, what it newly tagged among the six things and the patches it confirmed are not counted.') : null,
    // The foot stays below the list in the reading sheet (styles.css .strip-sheet-body>.more-foot), as a note's does.
    h('div', { class: 'more-foot' }, h('div', { class: 'row wrap more-actions' }, h('button', { class: 'btn small', onClick: () => openRound(item.id, { name, news }) }, 'Open the result'))),
  ];
}
async function loadStripRow(col, key, read, { reveal = false } = {}) {
  let data;
  try { data = await read(); } catch (e) { data = { error: e.message }; }
  if (JSON.stringify(stripData.get(key)) === JSON.stringify(data)) return;
  stripData.set(key, data);
  if (stripOpen?.col === col && stripOpen.key === key) syncStripSheet();
}
/**
 * A note, opened in place: everything its popover page holds (details.parts is the one description of a note's
 * details) — the whole title and preview, what it asks and its state, how it came about with the changes it is about,
 * the owner's choice when it asks for one, the objects it hangs on, the ways to answer, the walk through a change,
 * and `Details` for the whole note. The `On` line is `parts.on`, the same one the popover and the full details draw.
 */
function noteExpansion(col, row, _item, x) {
  if (x.error) return [h('div', { class: 'faint' }, x.error)];
  const sel = { kind: 'note', id: x.id, label: row.text };
  const leave = () => closeStripSheet();
  const parts = details.parts(sel, x, { surface: 'strip', leave, note: (n) => { leave(); select(n); }, object: (o) => { leave(); select(o); }, redraw: () => loadStripRow(col, row.key, () => api(`/api/projects/${P()}/notes/${encodeURIComponent(x.id)}`)) });
  return [
    h('div', { class: 'more-title' }, parts.title),
    h('div', { class: 'row wrap more-state' }, h('small', { class: 'faint' }, parts.sub), ...parts.tags.childNodes),
    parts.sentence ? h('p', { class: 'more-text' }, parts.sentence) : null,
    ...parts.extras,
    parts.on,
    // Keep the response actions and Details in one sticky foot. If Details alone is sticky it can cover the action
    // row above it while the strip is near the bottom of the window, leaving visible buttons that cannot receive a
    // real mouse event.
    h('div', { class: 'more-foot' },
      h('div', { class: 'row wrap more-actions' }, ...parts.actions),
      h('button', { class: 'btn small primary', title: 'The whole note, in a larger window', onClick: () => details.full(sel) }, 'Details')),
  ];
}
/**
 * A change, opened in place: the piece of work and when, each of its net changes by effect and title (an older record:
 * its own effect, title and summary), what it removed from the project's current version — struck through, the only
 * place that still appears (Spec §2.1, §6.3; CKC-09 AC-32) — how far it has been followed, the objects it reached,
 * `Show affected`, and the way to the same record in the Change log.
 */
function changeExpansion(c) {
  const items = c.work ? c.items ?? [] : [];
  const reached = c.affectsLabels ?? [];
  return [
    h('div', { class: 'more-title' }, c.work ? c.work.label : c.title),
    h('div', { class: 'row wrap more-state' }, c.work ? h('span', { class: 'tag' }, c.work.kind) : effectTag(c.effect), h('small', { class: 'faint' }, fmtTime(c.at)), c.work?.openEnded ? h('small', { class: 'faint' }, 'still going when the round began') : null,
      c.by?.identity === 'Decision' ? h('span', { class: 'tag amber' }, 'Owner decision') : c.by?.author?.name ? h('span', { class: 'tag' }, c.by.author.name) : null),
    items.length ? h('div', { class: 'more-items' }, ...items.map((i) => h('div', {}, effectTag(i.effect), ' ', i.title))) : !c.work && c.summary ? h('p', { class: 'more-text' }, c.summary) : null,
    c.removed?.length ? h('div', { class: 'removed-line' }, 'Removed: ', ...c.removed.flatMap((x, i) => [i ? ', ' : null, h('s', { title: REMOVED_TITLE }, x.label)])) : null,
    h('div', { class: 'row wrap' }, h('small', {}, 'Propagation'), h('span', { class: 'muted' }, propagationText(c.propagationSummary))),
    reached.length ? h('div', { class: 'row wrap more-objects' }, h('small', {}, 'Affects'), ...reached.map((a) => (a.removed ? h('span', { class: 'muted' }, namedObject(a)) : h('button', { class: 'text-btn', title: 'Open this object', onClick: () => select({ kind: 'node', id: a.id, label: a.label }) }, a.label)))) : null,
    h('div', { class: 'row wrap more-actions' },
      h('button', { class: 'btn small', title: 'Bring the objects this change reached into view on the graph, and mark them', onClick: () => { closeStripSheet(); showAffected(c); } }, 'Show affected'),
      h('button', { class: 'btn small', title: 'The same record in the Change log, with its sources and what it said before and after', onClick: () => { closeStripSheet(); navigate(state.projectId, 'changes', encodeURIComponent(c.id)); } }, 'Open in Change log')),
  ];
}

/** One column drawn again where it stands: how far it is scrolled is kept, and focus goes to the row that was pressed. */
function redrawStripColumn(col, { focusKey = null, revealKey = focusKey } = {}) {
  const current = stripEl?.querySelector(`:scope > section[data-col="${col}"]`);
  if (!current || !stripOv) return;
  const focus = focusKey ? { key: focusKey, at: -1 } : focusInStrip(current);
  const next = stripSection(col);
  const top = current.querySelector('.items').scrollTop;
  current.replaceWith(next);
  fitStripToDock();
  const list = next.querySelector('.items');
  list.scrollTop = top;
  restoreStripFocus(next, focus);
  // The row that was pressed stays in sight: all of it when the column is tall enough, else from its own line down.
  const rowEl = revealKey ? next.querySelector(`[data-row="${CSS.escape(revealKey)}"]`) : null;
  if (rowEl) {
    const r = rowEl.getBoundingClientRect(), l = list.getBoundingClientRect();
    if (r.top < l.top || r.height > l.height) list.scrollTop += r.top - l.top;
    else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom;
  }
}
const STRIP_FOCUSABLE = 'button:not([disabled]), [tabindex="0"]';
/** Where focus is inside a column: which row, and which of its buttons (−1: the row's own line). */
function focusInStrip(section) {
  const a = document.activeElement;
  const rowEl = a && section.contains(a) ? a.closest('[data-row]') : null;
  return rowEl ? { key: rowEl.dataset.row, at: a.classList.contains('item') ? -1 : [...rowEl.querySelectorAll(STRIP_FOCUSABLE)].indexOf(a) } : null;
}
function restoreStripFocus(section, focus) {
  if (!focus) return;
  const rowEl = section.querySelector(`[data-row="${CSS.escape(focus.key)}"]`);
  const to = rowEl ? (focus.at >= 0 ? rowEl.querySelectorAll(STRIP_FOCUSABLE)[focus.at] : null) ?? rowEl.querySelector('.item') : null;
  to?.focus({ preventScroll: true });
}
/**
 * A strip built from a new overview takes the place of the one on the page, column by column and only where it differs
 * (relative clocks aside): an unchanged column is not touched, a changed one keeps its scroll position and its focus.
 */
function swapStrip(next) {
  const current = stripEl;
  if (!current?.isConnected) { stripEl = next; return next; }
  // `over-dock` is put on a column after it is drawn (fitStripToDock); it is not a difference in what the column says.
  const norm = (el) => { const c = el.cloneNode(true); c.classList.remove('over-dock'); if (!c.classList.length) c.removeAttribute('class'); return visHtml(c.outerHTML); };
  if (current.className !== next.className) current.className = next.className;   // two columns, or three
  const have = new Map([...current.querySelectorAll(':scope > section[data-col]')].map((c) => [c.dataset.col, c]));
  [...next.querySelectorAll(':scope > section[data-col]')].forEach((want, i) => {
    const old = have.get(want.dataset.col);
    have.delete(want.dataset.col);
    // A column that is already there is never taken out and put back: that would lose how far it is scrolled.
    if (!old) { current.insertBefore(want, current.children[i] ?? null); return; }   // `Since last visit` has come
    if (norm(old) === norm(want)) return;
    const top = old.querySelector('.items')?.scrollTop ?? 0;
    const focus = focusInStrip(old);
    old.replaceWith(want);
    const items = want.querySelector('.items');
    if (items) items.scrollTop = top;
    restoreStripFocus(want, focus);
  });
  for (const gone of have.values()) gone.remove();
  fitStripToDock();
  syncStripRowStates();
  syncStripSheet();
  paintDrawerBar();
  return stripEl;
}
/** After an asset event: what the open rows show is read again, and a row is drawn again only if it differs. */
function refreshOpenStripRows() {
  if (!stripOpen) return;
  const { col, key } = stripOpen;
  if (key.startsWith('note:')) void loadStripRow(col, key, () => api(`/api/projects/${P()}/notes/${encodeURIComponent(key.slice(5))}`));
  else if (key.startsWith('change:') && stripData.has(key)) void loadStripRow(col, key, async () => (await api(`/api/projects/${P()}/changes`)).changes.find((k) => k.id === key.slice(7)) ?? stripData.get(key));
}
/**
 * The pill at the bottom right lies over the strip's corner (Spec §6.1: it never lies on text). No column is kept empty
 * for it: the strip takes the whole width, and only a column the pill actually stands over ends its list above the
 * pill — usually the last one, two of them when the main view is very narrow. Asked again whenever the strip is drawn
 * or the main view changes size (the Keeper docking moves the pill). Such a column also keeps the strip tall enough
 * that its header stays clear of the pill.
 */
function fitStripToDock() {
  if (!stripEl?.isConnected) return;
  const p = document.querySelector('#keeper-dock .dock-pill')?.getBoundingClientRect();
  let need = 0;
  for (const s of stripEl.querySelectorAll(':scope > section[data-col]')) {
    const r = s.getBoundingClientRect();
    const under = Boolean(p && p.width) && r.left < p.right + 2 && p.left - 2 < r.right && r.top < p.bottom && p.top < r.bottom;
    s.classList.toggle('over-dock', under);
    if (under) need = Math.max(need, Math.ceil(s.querySelector('header').getBoundingClientRect().height + (r.bottom - p.top) + 8 + STRIP_SIZE.step));
  }
  stripEl.style.minHeight = need > STRIP_SIZE.min ? `${need}px` : '';
}
let stripWatch = null;
function watchStripDock(main) {
  if (!('ResizeObserver' in window) || stripWatch?.main === main) return;
  stripWatch?.observer.disconnect();
  const observer = new ResizeObserver(() => fitStripToDock());
  observer.observe(main);
  stripWatch = { main, observer };
}

/**
 * The strip's height once the drawer is pulled up (Spec §6.2 "拉起之后……可以拖高"): the owner drags its top edge — or,
 * with focus on the edge, presses the arrow keys; Home and End go to the limits and a double-click back to the default.
 * The height is this browser's (a per-viewer convenience, like the Keeper panel's width), between what shows a row or
 * two and what leaves the main panel above it enough to be used. The graph follows by itself: it watches its own
 * container (graph.js onResize).
 */
const STRIP_KEY = 'pk.strip.height';
const STRIP_SIZE = Object.freeze({ initial: 260, min: 120, leaveAbove: 240, step: 27 });
function rememberedStripHeight() { try { const v = Number(localStorage.getItem(STRIP_KEY)); return Number.isFinite(v) && v > 0 ? v : STRIP_SIZE.initial; } catch { return STRIP_SIZE.initial; } }
/** The room the drawer and the main panel share: the main panel keeps `leaveAbove` of it. */
function stripRoom() {
  const panel = document.getElementById('main-panel');
  const open = stripEl?.isConnected && drawerOpen ? stripEl.getBoundingClientRect().height : 0;
  return (panel?.clientHeight || 748) + open;
}
function setStripHeight(px, { remember = true, handle = document.querySelector('#drawer .strip-resizer') } = {}) {
  const max = Math.max(STRIP_SIZE.min, stripRoom() - STRIP_SIZE.leaveAbove);
  const height = Math.round(Math.min(max, Math.max(STRIP_SIZE.min, px)));
  document.documentElement.style.setProperty('--pk-strip-h', `${height}px`);
  if (handle) { handle.setAttribute('aria-valuenow', String(height)); handle.setAttribute('aria-valuemin', String(STRIP_SIZE.min)); handle.setAttribute('aria-valuemax', String(max)); }
  if (remember) { try { localStorage.setItem(STRIP_KEY, String(height)); } catch { /* a convenience only */ } }
  return height;
}
function stripResizer() {
  const el = h('div', { class: 'strip-resizer', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Height of the drawer', tabindex: 0, title: 'Drag to make the drawer taller or lower (or use the arrow keys; double-click for the default height)' });
  const now = () => stripEl?.getBoundingClientRect().height ?? rememberedStripHeight();
  let dragging = null;
  el.addEventListener('pointerdown', (e) => { dragging = e.pointerId; el.setPointerCapture(e.pointerId); el.classList.add('sizing'); e.preventDefault(); });
  el.addEventListener('pointermove', (e) => { if (dragging === e.pointerId && stripEl) setStripHeight(stripEl.getBoundingClientRect().bottom - e.clientY, { remember: false, handle: el }); });
  const done = (e) => { if (dragging !== e.pointerId) return; dragging = null; el.classList.remove('sizing'); setStripHeight(now(), { handle: el }); };
  el.addEventListener('pointerup', done);
  el.addEventListener('pointercancel', done);
  el.addEventListener('dblclick', () => setStripHeight(STRIP_SIZE.initial, { handle: el }));
  el.addEventListener('keydown', (e) => {
    const to = e.key === 'ArrowUp' ? now() + STRIP_SIZE.step : e.key === 'ArrowDown' ? now() - STRIP_SIZE.step : e.key === 'Home' ? Infinity : e.key === 'End' ? 0 : null;
    if (to === null) return;
    e.preventDefault();
    setStripHeight(to, { handle: el });
  });
  return el;
}

// ── The drawer (Spec §6.1, §6.2; D100; CKC-09 AC-38, AC-45) ──────────────────────────────────────────────────────
/**
 * The strip lives in the drawer, a panel of its own under the main panel. By default it is one line that says how many
 * rows `Notes (attention)` and `Recent changes` have, whether there is a `Since last visit`, and how many attention
 * notes are marked ❓ on objects; a press on the line pulls it up to the columns (as tall as the owner last dragged
 * it), a second press puts it away. It is one line again on every visit (平时只占一行): only while the page is open is
 * "pulled up" kept, across Graph, List and Code.
 */
let drawerOpen = false;
const drawerEl = () => document.getElementById('drawer');
/**
 * The notes marked ❓ on objects, for the drawer's count. One rule with the marks the Graph and the List draw (CE): a current
 * note still in `Notes (attention)` (graph-view.ts `inAttention`) that hangs on objects, not on the whole project. The marks
 * come from the graph payload (`noteAttention` on each object, a path's note on its top object); the count here is of
 * notes, from the overview, so a note on two objects counts once.
 */
const onObjectNotes = (ov) => objectAttentionNotes(ov);
/** Whether the reading sheet over the drawer is open (app.js: Escape closes it first). */
export function stripSheetOpen() { return Boolean(stripOpen) && Boolean(stripEl?.isConnected); }
/** Another view than the Project graph: the drawer is put away, and only keeps the band beside the pill. */
export function hideDrawer() {
  const d = drawerEl();
  if (!d) return;
  closeStripSheet();
  d.replaceChildren();
  d.classList.add('empty');
  d.classList.remove('open');
  stripEl = null;
}
function toggleDrawer(open = !drawerOpen) {
  drawerOpen = open;
  if (!open) closeStripSheet();
  drawerEl()?.classList.toggle('open', open);
  paintDrawerBar();
  if (open) setStripHeight(rememberedStripHeight(), { remember: false });
  fitStripToDock();
  popover.reposition({ measure: true });
}
/** The ❓ count: how many attention notes wait on objects; pressed, the Graph and the List show only those objects. */
function attentionCountButton(n) {
  const on = Boolean(graphFilters().attention);
  return h('button', {
    class: `attn-count${on ? ' active' : ''}`, 'aria-pressed': String(on),
    title: on ? 'Showing only the objects with an attention note (❓). Press to see everything again.' : `${n} attention note${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} marked ❓ on ${n === 1 ? 'its object' : 'their objects'}, not listed here. Press to see only those objects in the Graph and the List.`,
    onClick: (e) => { e.stopPropagation(); setAttentionFilter(!graphFilters().attention); },
  }, h('span', { class: 'attn-mark', 'aria-hidden': 'true' }, '❓'), h('b', {}, String(n)), ' on objects');
}
function drawerBar(ov) {
  const s = drawerSummary(ov, onObjectNotes(ov));
  const part = (name, n) => h('span', { class: 'drawer-part' }, h('span', { class: 'dp-name' }, name), ' ', h('b', {}, String(n)));
  const sep = () => h('span', { class: 'drawer-sep', 'aria-hidden': 'true' }, '·');
  return h('div', { class: 'drawer-bar' },
    h('button', { class: 'drawer-toggle', 'aria-expanded': String(drawerOpen), 'aria-controls': 'drawer-strip', title: drawerOpen ? 'Put the notes and changes away' : 'Pull up the notes and changes', onClick: () => toggleDrawer() },
      h('span', { class: 'drawer-caret', 'aria-hidden': 'true' }, drawerOpen ? '▾' : '▴'),
      part('Notes (attention)', s.attention), sep(), part('Recent changes', s.changes),
      s.since ? [sep(), h('span', { class: 'drawer-part since' }, 'Since last visit')] : null),
    s.onObjects ? attentionCountButton(s.onObjects) : null);
}
function paintDrawerBar() {
  const bar = drawerEl()?.querySelector(':scope > .drawer-bar');
  if (!bar || !stripOv) return;
  const next = drawerBar(stripOv);
  if (visHtml(bar.outerHTML) === visHtml(next.outerHTML)) return;
  const a = document.activeElement;
  const focused = bar.contains(a) ? (a.classList.contains('attn-count') ? '.attn-count' : '.drawer-toggle') : null;
  bar.replaceWith(next);
  if (focused) next.querySelector(focused)?.focus({ preventScroll: true });
}
/** The strip in the drawer, under the Graph, the List and Code alike, with the edge it is dragged by. */
function mountStrip(main, ov) {
  const d = drawerEl();
  if (!d) return;
  const handle = stripResizer();
  stripEl = strip(ov);
  d.replaceChildren(handle, drawerBar(ov), stripEl);
  d.classList.remove('empty');
  d.classList.toggle('open', drawerOpen);
  setStripHeight(rememberedStripHeight(), { remember: false, handle });
  fitStripToDock();
  syncStripSheet();
  watchStripDock(main);
}

/**
 * The ❓ count pressed (Spec §6.2, §6.3's filter; CKC-09 AC-38): the Graph and the List see only the objects the
 * attention notes hang on, with what they need to be understood. It is the `❓ Waiting on you` filter (graph-tools.js),
 * so the Filter button counts it and `Clear filters` puts it out of force too. The ids follow the overview: a note
 * answered leaves, and its object with it.
 */
function syncAttentionTargets() {
  const f = graphFilters();
  const ids = stripOv ? attentionTargets(onObjectNotes(stripOv), graph._data?.relations ?? []) : [];
  const same = JSON.stringify(ids) === JSON.stringify(f.attentionIds ?? []);
  f.attentionIds = ids;
  if (!same && f.attention) graphCtl?.setFilters(f);
}
function setAttentionFilter(on) {
  const f = graphFilters();
  f.attention = Boolean(on);
  syncAttentionTargets();
  graphCtl?.setFilters(f);
  if (state.graphMode === 'list') void refreshList();
  controlFilterSync?.();
  paintDrawerBar();
  if (stripOv && stripEl?.isConnected) redrawStripColumn('attention');
}
const askTag = (ask) => ask ? h('span', { class: `tag ${ask === 'For your decision' ? 'amber' : ask === 'Worth discussing' ? 'blue' : ''}` }, ask) : null;
/** How a note came about (Spec §4.1): one of four, so the owner can tell which reminders a change follow-up brought. */
const NOTE_ORIGINS = ['Product re-look', 'Change follow-up', 'Investigation', 'Owner question'];
const originTag = (cameFrom) => cameFrom?.kind ? h('span', { class: 'tag origin', title: `Came from: ${cameFrom.kind}${cameFrom.changes?.length ? ` — ${cameFrom.changes.map((c) => c.title).join('; ')}` : ''}` }, cameFrom.kind) : null;
const effectTag = (e) => h('span', { class: `tag ${e === 'Approved' || e === 'Completed' || e === 'Added' ? 'green' : e === 'Replaced' || e === 'Abandoned' ? 'red' : e === 'Deferred' ? 'amber' : ''}` }, e);
const propagationText = (s) => { const parts = Object.entries(s || {}).map(([k, v]) => `${v} ${k.toLowerCase()}`); return parts.length ? parts.join(' · ') : 'no downstream entries'; };
/**
 * `Show affected` (D48): bring the objects this change touched into view and mark them. The scale does not change
 * and nothing is dimmed; whether each of them followed the change is the Keeper's judgement, reported in the
 * change's own details and, when the owner has to act, as a note.
 */
function showAffected(c) {
  const named = c.affectsLabels ?? (c.affects ?? []).map((id) => ({ id }));
  const ids = named.filter((a) => !a.removed).map((a) => a.id);
  if (state.view !== 'graph') { navigate(state.projectId, 'graph', `change/${encodeURIComponent(c.id)}`); return; }
  if (state.graphMode === 'list') { toast('Switch to Graph to see the affected objects'); return; }
  const allRemoved = named.length > 0 && named.every((a) => a.removed);
  if (graphCtl) { const n = graphCtl.showAffected(ids); toast(n ? `${n} affected object${n === 1 ? '' : 's'} highlighted` : allRemoved ? 'What it affected was removed from the project’s current version, so it is not on the graph' : 'None of the affected objects is on the graph'); }
  else navigate(state.projectId, 'graph', `change/${encodeURIComponent(c.id)}`);
}

/**
 * The legend lists only what the picture shows right now, with counts, on one line; `More` opens what each means
 * (D53, the WorkflowKeeper rule: only what would be misread without it, where the misreading would change what you
 * do). Kinds written on the objects and relation types written on the lines are not in it.
 */
// The icons take the graph's palette (graph-palette.js), so they follow the theme with the picture they explain.
const LEGEND_ICON = {
  doc: (c, p) => `<svg width="16" height="12"><polygon points="1,1 11,1 15,4 15,11 1,11" fill="${p.nodeBg}" stroke="${c}" stroke-width="1.5"/></svg>`,
  hex: (c, p) => `<svg width="18" height="12"><polygon points="4,1 14,1 17,6 14,11 4,11 1,6" fill="${p.nodeBg}" stroke="${c}" stroke-width="1.5"/></svg>`,
  folder: (c, p) => `<svg width="18" height="13"><path d="M1,11 V3 Q1,1 3,1 H7 L9,3 H15 Q17,3 17,5 V10 Q17,12 15,12 H3 Q1,12 1,11 Z" fill="${p.nodeBg}" stroke="${c}" stroke-width="1.4"/></svg>`,
  ellipse: (c, p) => `<svg width="18" height="12"><ellipse cx="9" cy="6" rx="8" ry="5" fill="${p.nodeBg}" stroke="${c}" stroke-width="1.4"/></svg>`,
  line: (c, p) => `<svg width="20" height="8"><line x1="1" y1="4" x2="19" y2="4" stroke="${p.edgeOther}" stroke-width="2"/></svg>`,
  dotted: (c, p) => `<svg width="20" height="8"><line x1="1" y1="4" x2="19" y2="4" stroke="${p.edgeOther}" stroke-width="2" stroke-dasharray="2 3"/></svg>`,
  // A work item's copy in another module it serves: its hexagon faded, with a dashed frame (the only dashed frame).
  dashed: (c, p) => `<svg width="18" height="12" opacity="0.5"><polygon points="4,1 14,1 17,6 14,11 4,11 1,6" fill="${p.nodeBg}" stroke="${c}" stroke-width="1.5" stroke-dasharray="3 2"/></svg>`,
  // An inferred object: the word on it.
  inferred: (c, p) => `<svg width="34" height="12"><rect x="0.5" y="0.5" width="33" height="11" rx="3" fill="${p.chipBg}" stroke="${p.edgeOther}"/><text x="17" y="9" font-size="7.5" text-anchor="middle" fill="${p.nodeMuted}">Inferred</text></svg>`,
  questioned: (c, p) => `<svg width="20" height="8"><line x1="1" y1="4" x2="19" y2="4" stroke="${p.questioned}" stroke-width="2"/></svg>`,
  count: () => '<span class="lg-count">↗n</span>',
  stack: (c, p) => `<svg width="22" height="13"><rect x="4.5" y="0.5" width="16" height="9" rx="2" fill="${p.groupBack}" stroke="${p.groupBackBorder}"/><rect x="1" y="3" width="16" height="9" rx="2" fill="${p.groupBg}" stroke="${p.groupBorder}"/></svg>`,
  band: (c) => `<svg width="24" height="12"><rect x="1" y="2" width="22" height="8" rx="3" fill="${c}" fill-opacity="0.15" stroke="${c}" stroke-opacity="0.6"/></svg>`,
  ring: (c) => `<svg width="24" height="12"><rect x="1" y="1" width="22" height="10" rx="5" fill="${c}" fill-opacity="0.08" stroke="${c}" stroke-width="1.4"/></svg>`,
};
function renderLegend(el, items, expanded) {
  const shown = items.filter((i, k) => !i.sep || (k > 0 && k < items.length - 1 && !items[k - 1].sep));
  const icon = (i) => {
    const s = h('span', { class: 'lg-icon' });
    if (i.icon === 'mark') { s.className = `lg-mark mark-${i.mark.key}`; s.textContent = i.mark.glyph; return s; }
    s.innerHTML = LEGEND_ICON[i.icon]?.(i.color, currentPalette()) ?? '';
    return s;
  };
  const next = h('div', { class: `legend${expanded ? ' expanded' : ''}` },
    h('div', { class: 'lg-items' }, ...shown.map((i) => i.sep ? h('span', { class: 'sep' }) : h('span', { class: 'lg-item', title: i.desc }, icon(i), h('span', {}, `${i.label}${i.count ? ` (${i.count})` : ''}`), h('span', { class: 'lg-desc' }, ` — ${i.desc}`)))),
    h('button', { class: 'text-btn lg-more', onClick: (e) => { const box = e.currentTarget.parentElement; box.classList.toggle('expanded'); legendOpen = box.classList.contains('expanded'); e.currentTarget.textContent = legendOpen ? 'Less' : 'More'; } }, expanded ? 'Less' : 'More'));
  return swap(el, next);
}
let legendOpen = false;
// D55: a folder opens the same row's Observed reality cell in List, scrolled into view and picked out.
function openFolderInList(key) {
  state.graphMode = 'list';
  state.listTarget = `obs-${key ?? 'project-wide'}`;
  renderBody();
}
/** After arriving in List from elsewhere (Spec §6.3): scroll the target row or cell into view and pick it out. */
function revealInList() {
  const id = state.listTarget ?? (state.selection?.kind === 'node' ? `row-${state.selection.id}` : null);
  state.listTarget = null;
  if (!id) return;
  const el = document.getElementById(id);
  if (!el) return;
  openListAround(el);
  // A cell can be taller than the window: its top comes into view. A row goes to the middle.
  el.scrollIntoView({ block: id.startsWith('obs-') ? 'start' : 'center' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1800);
}

// ── The List's blocks open and close (E153; ui/list-fold.js keeps what the owner opened) ───────────────────────
const listFold = createListFold();
let listBlockKeys = [];   // the blocks the List draws now: what `Expand all` opens
const foldBodyId = (key) => `fold-body-${key}`;
/** Open or fold one block where it stands — nothing is rebuilt — and remember it for this browser. */
function setListBlock(block, open) {
  block.dataset.open = String(open);
  block.querySelector(':scope > [data-fold-head]')?.setAttribute('aria-expanded', String(open));
  const body = block.querySelector(':scope > [data-fold-body]');
  if (body) body.hidden = !open;
  listFold.set(state.projectId, block.dataset.fold, open);
}
/**
 * A block's head: pressed anywhere but on something of its own to press (its name, `Intent & basis`), it opens or
 * folds the block. Tab reaches it; Enter or Space presses it; `aria-expanded` says which way it stands.
 */
function foldHead(key, open) {
  const press = (e) => { const block = e.currentTarget.closest('[data-fold]'); if (block) setListBlock(block, block.dataset.open !== 'true'); };
  return {
    'data-fold-head': '', role: 'button', tabindex: 0, 'aria-expanded': String(open), 'aria-controls': foldBodyId(key),
    onClick: (e) => {
      if (e.target.closest('button, a, input, select, textarea, details')) return;
      const picked = getSelection?.();   // words of the head just dragged over to copy: not a press
      if (picked && !picked.isCollapsed && e.currentTarget.contains(picked.anchorNode)) return;
      press(e);
    },
    onKeydown: (e) => { if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return; e.preventDefault(); press(e); },
  };
}
/**
 * Before a row or a cell is scrolled to (a `row-<id>` link, `Show in List` from the Graph, an observed-reality folder):
 * every block and fold that holds it is opened. What the target itself heads — its own block, its own process — stays
 * as it is.
 */
function openListAround(el) {
  for (let p = el.parentElement; p && !p.classList.contains('list-wrap'); p = p.parentElement) {
    if (p.tagName === 'DETAILS') { if (!p.open && !p.querySelector(':scope > summary')?.contains(el)) p.open = true; }
    else if (p.dataset.fold && p.dataset.open !== 'true' && !p.querySelector(':scope > [data-fold-head]')?.contains(el)) setListBlock(p, true);
  }
}

/** In List a click only opens the details (CKC-09 AC-31): the table is not rebuilt, scrolled or rewrapped. */
function markListSelection(selection) {
  document.querySelectorAll('.list-wrap .sel').forEach((el) => el.classList.remove('sel'));
  if (!selection?.id) return;
  document.querySelectorAll(`.list-wrap [data-node="${CSS.escape(selection.id)}"]`).forEach((el) => el.classList.add('sel'));
}

// ── The control row (Spec §6.1 "顶上的控件只占一行", §6.3 "控件放在哪"; CKC-09 AC-37) ────────────────────────────
const SCALES = ['Overview', 'Work', 'Compare'];
let controlFilterSync = null;
const graphFilters = () => state.filters.graph ?? (state.filters.graph = clearFilters({}));
const toList = () => { closeStripSheet(); state.graphMode = 'list'; state.listTarget = state.selection?.kind === 'node' ? `row-${state.selection.id}` : null; renderBody(); };
const toGraph = () => { closeStripSheet(); state.graphMode = 'graph'; renderBody(); };
const toCode = () => { closeStripSheet(); state.graphMode = 'code'; renderBody(); };

/**
 * One row above the graph and above the List, the same in both and in the same place: the scale, `Graph` / `List` /
 * `Code` (§6.17), `Filter`, and — over the graph — the readability mark. Everything else the old four rows held is one
 * press away: the filters and what is shown in the `Filter` panel, the graph's own operations on the graph's corner
 * (graph.render). `scales` is the Graph's live switch; the List shows it set and out of use, so nothing in the row
 * changes place. `Expand all` and `Fold all` ride here too — one fold rule for both (CKC-24); over the List they open and
 * fold its blocks as well (E153).
 */
function controlRow({ mode, scales = null, focusPath = null }) {
  const inGraph = mode === 'graph';
  const scaleSwitch = scales ?? h('div', { class: 'segmented', title: 'The scales are views of the Graph' }, ...SCALES.map((s) => h('button', { class: state.scale === s ? 'active' : '', disabled: true }, s)));
  const modeBtn = (id, label) => h('button', mode === id ? { class: 'active', 'aria-pressed': 'true' } : { 'aria-pressed': 'false', onClick: id === 'graph' ? toGraph : id === 'list' ? toList : toCode }, label);
  const modeSwitch = h('div', { class: 'segmented' }, modeBtn('graph', 'Graph'), modeBtn('list', 'List'), modeBtn('code', 'Code'));
  // The one fold rule of the process view, offered in both views (CKC-24 AC-11, AC-12).
  const expandAll = mode !== 'code' ? kProcess.foldAllButtons(() => { if (state.graphMode === 'list') void refreshList(); else graphCtl?.refresh(); },
    mode === 'list' ? { setAll: (on) => listFold.setAll(state.projectId, listBlockKeys, on) } : null) : null;

  const filterBtn = h('button', { class: 'btn small filter-btn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onClick: () => flyout.toggle({ button: filterBtn, label: 'Filter', className: 'filter-panel', render: () => filterPanel(mode, () => { syncFilter(); paintDrawerBar(); flyout.refresh(filterBtn); }) }) });
  // The number is the filters in force: choices that can take objects off the picture (graph-tools.js). None of them
  // acts on the List, so there the button says `Filter` whatever was chosen for the Graph.
  const syncFilter = () => {
    const on = inGraph ? [...activeFilters(graphFilters()), ...kProcess.activeProcessFilters(graphFilters())] : [];
    filterBtn.textContent = filterLabel(on.length);
    filterBtn.classList.toggle('active', on.length > 0);
    filterBtn.title = on.length ? `In force — ${on.map((x) => (x.value === 'on' ? x.label : `${x.label}: ${x.value}`)).join(' · ')}` : inGraph ? 'Filter the picture, and choose what is shown' : 'Choose what is shown';
  };
  syncFilter();
  controlFilterSync = syncFilter;   // the ❓ count in the drawer sets a filter too, and the button says so

  let mark = null;
  if (inGraph) {
    let report = null;
    let seen = '';
    const btn = h('button', { class: 'read-mark', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onClick: () => flyout.toggle({ button: btn, label: 'Readability of the picture', className: 'read-panel', render: () => readabilityPanel(report, { focusPath }) }) });
    const set = (r) => {
      report = r;
      const m = readabilityMark(r);
      const sig = JSON.stringify((r?.issues ?? []).map((i) => [i.kind, i.count, i.text, i.ids]));
      if (btn.textContent !== m.text) btn.textContent = m.text;
      btn.title = m.title;
      btn.dataset.count = String(m.count);
      btn.classList.toggle('alert', m.count > 0);
      if (sig !== seen) { seen = sig; flyout.refresh(btn); }   // an open panel follows the check; an unchanged one is left alone
    };
    set(null);
    mark = { btn, set };
  }
  return { el: h('div', { class: 'graph-tools' }, scaleSwitch, modeSwitch, expandAll, filterBtn, mark?.btn ?? null), filter: { btn: filterBtn, sync: syncFilter }, mark };
}

/**
 * The `Filter` panel: the filters (what can take objects off the picture), then what is shown — replaced and deferred
 * objects, and which period the stars mark, with the sentence that says what they mark now. `Clear filters` puts every
 * filter out of force in one press and leaves what is shown alone. The List has no filters; it shares what is shown.
 */
function filterPanel(mode, changed) {
  const g = graph._data ?? { categories: [], nodes: [], counts: {} };
  const f = graphFilters();
  const inGraph = mode === 'graph';
  const apply = () => { graphCtl?.setFilters(f); changed(); };
  const OPTIONS = {
    category: g.categories.filter((c) => !NOT_DRAWN.has(c)), validity: ['Current', 'Proposed', 'Deferred', 'Replaced', 'Abandoned'], progress: ['Planned', 'In progress', 'Done', 'On hold'],
    acceptance: g.nodes.some((n) => n.acceptance) ? ['Accepted', 'Not yet accepted'] : null, assessment: ['Holds', 'Questioned', 'Not assessed'],
  };
  const choice = (x) => h('div', { class: 'field' }, h('label', { for: `filter-${x.key}` }, x.label),
    h('select', { id: `filter-${x.key}`, class: 'input small', onChange: (e) => { f[x.key] = e.target.value; apply(); } }, h('option', { value: '' }, 'all'), ...OPTIONS[x.key].map((o) => h('option', { value: o, selected: f[x.key] === o }, o))));
  const tick = (x) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: f[x.key] || null, onChange: (e) => { f[x.key] = e.target.checked; apply(); } }), x.label);
  const redraw = () => (inGraph ? null : refreshList());
  const replaced = g.counts?.replacedOrDeferred ?? 0;
  const showReplaced = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: state.filters.showReplaced || null, onChange: (e) => { state.filters.showReplaced = e.target.checked; graphCtl?.setShowReplaced(e.target.checked); redraw(); changed(); } }), `Show replaced & deferred${replaced ? ` (${replaced})` : ''}`);
  const stars = h('div', { class: 'segmented', title: 'Stars mark new or changed objects' }, ...[['visit', '★ Since last visit'], ['days', '★ Last days']].map(([m, label]) => h('button', { class: starMode() === m ? 'active' : '', 'aria-pressed': String(starMode() === m), onClick: () => { setStarMode(m); graphCtl?.setStars(m, state.lastVisit); redraw(); changed(); } }, label)));
  const starNote = inGraph ? graph._starNote ?? '' : starredIds(g.nodes, starMode(), state.lastVisit).note;
  // The process filters (CKC-24 AC-16), offered when the process view has data: a breakpoint's kind, a send-back's
  // stage, one of the six things. They are not in graph-tools.js's FILTERS (that list is pinned by its test); the
  // button counts them via kProcess.activeProcessFilters, and Clear puts them out of force here.
  const procView = kProcess.current();
  const procSelects = inGraph && procView ? (() => {
    const pchoice = (key, label, options) => h('div', { class: 'field' }, h('label', { for: `filter-${key}` }, label),
      h('select', { id: `filter-${key}`, class: 'input small', onChange: (e) => { f[key] = e.target.value; apply(); } }, h('option', { value: '' }, 'all'), ...options.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l))));
    const kinds = [...new Set(procView.breakpoints.map((b) => b.kind))].sort();
    const stages = [...new Set(procView.sendBacks.map((s) => s.stage))].sort();
    const things = (procView.sixThings ?? []).map((t) => [String(t.thing), `${t.thing} · ${kProcess.SIX_THING[t.thing] ?? t.thing}`]);
    return h('div', { class: 'filter-grid' },
      kinds.length ? pchoice('bpKind', 'Breakpoint kind', kinds.map((k) => [k, k])) : null,
      stages.length ? pchoice('sbStage', 'Send-back stage', stages.map((s) => [s, s])) : null,
      things.length ? pchoice('sixThing', 'One of the six things', things) : null);
  })() : null;
  return [
    inGraph ? h('div', { class: 'filter-grid' }, ...FILTERS.filter((x) => !x.tick && OPTIONS[x.key]).map(choice)) : null,
    inGraph ? h('div', { class: 'row wrap filter-ticks' }, ...FILTERS.filter((x) => x.tick).map(tick)) : null,
    procSelects,
    h('div', { class: 'filter-show' }, h('h4', {}, 'Show'), showReplaced, stars, starNote ? h('div', { class: 'faint star-note' }, starNote) : null),
    inGraph ? h('div', { class: 'flyout-foot' }, h('button', { class: 'btn small', disabled: activeFilters(f).length === 0 && kProcess.activeProcessFilters(f).length === 0, title: 'Put every filter out of force; what is shown stays as it is', onClick: () => { clearFilters(f); f.bpKind = f.sbStage = f.sixThing = ''; apply(); } }, 'Clear filters'))
      : h('div', { class: 'faint' }, 'Filters act on the Graph.'),
  ];
}

const graph = {
  closeSheet(options) { return closeStripSheet(options); },
  async render(main) {
    const rest = state.routeRest || '';
    const m = /^(change|sel)\/(?:(\w+)\/)?(.+)$/.exec(rest);
    if (m) {
      const id = decodeURIComponent(m[3]);
      if (m[1] === 'change') state.pendingAffected = id;
      else { state.selection = { kind: m[2] || 'node', id, label: id }; state.pendingPopover = state.pendingPopover ?? {}; if (state.graphMode === 'list') state.listTarget = `row-${id}`; }
      state.routeRest = '';
    }
    const [g, ov] = await Promise.all([api(`/api/projects/${P()}/graph`), api(overviewUrl())]);
    // The process view (CKC-24) loads beside the graph; null when its endpoint is not built yet.
    await kProcess.load(state.projectId);
    if (kProcess.current()) kProcess.indexNodes(g.nodes);
    if (state.selection?.kind === 'node') { const n = g.nodes.find((x) => x.id === state.selection.id); if (n) state.selection = NODE_SEL(n); }
    if (state.graphMode === 'code') {
      graphCtl?.destroy(); graphCtl = null;
      await renderCode(main, ov);
      return;
    }
    if (g.nodes.length === 0) {
      graphCtl?.destroy(); graphCtl = null;
      // §6.14: the empty graph says why it is empty. A project not organized yet — just added, or cleared — leads to the
      // Takeover page, where the owner chooses a depth and presses Start; nothing runs before that (D105).
      const notConnected = activity.status === 'Not connected';
      const notOrganized = state.project?.coverage?.state === 'Not organized yet';
      append(main, h('div', { class: 'graph-wrap' }, h('div', { class: 'graph-empty' }, emptyState('The project graph starts here',
        notOrganized
          ? 'This project has not been organized yet. The Keeper does nothing until you choose a depth and press Start on the Takeover page; the graph then fills in as the first usable picture forms.'
          : notConnected
            ? 'The takeover has started, but the Keeper is not connected to a model, so nothing has been organized yet. Set a key and a model in Keeper → Model provider. Project scope shows what will be read.'
            : 'The Keeper is drawing the project boundary and reading its material. Established parts appear here as they are formed; nothing waits for the whole project to be read.',
        h('div', { class: 'row' }, notOrganized ? h('button', { class: 'btn primary', id: 'graph-to-takeover', onClick: () => navigate(state.projectId, 'keeper', 'takeover') }, 'Open the Takeover page') : notConnected ? h('button', { class: 'btn primary', onClick: () => navigate(state.projectId, 'keeper') }, 'Open Keeper') : null, notOrganized ? null : h('button', { class: 'btn', onClick: () => navigate(state.projectId, 'scope') }, 'Open Project scope'))))));
      mountStrip(main, ov);
      return;
    }
    if (state.graphMode === 'list') {
      graphCtl?.destroy(); graphCtl = null;
      await renderList(main, g, ov);
      return;
    }
    const wrap = h('div', { class: 'graph-wrap' });
    const cyEl = h('div', { id: 'cy' });
    graph._data = g;
    const syncScale = () => { scales.querySelectorAll('button').forEach((b) => { b.classList.toggle('active', b.textContent === state.scale); if (scaleNeedsSelection[b.textContent]) b.disabled = !state.selection; }); syncFocus(); };
    const scaleNeedsSelection = { Work: 'Select a work item first' };
    const scales = h('div', { class: 'segmented' }, ...SCALES.map((s) => h('button', {
      class: state.scale === s ? 'active' : '', disabled: Boolean(scaleNeedsSelection[s]) && !state.selection,
      title: scaleNeedsSelection[s] ?? '',
      onClick: () => { state.scale = s; graphCtl.setScale(s); syncScale(); if (s === 'Compare') void openCompare(wrap); else closeCompare(); },
    }, s)));
    // Focus path is a toggle: the same button clears the focus and returns to the overview.
    const focusOn = () => state.scale === 'Work' && Boolean(state.selection) && graphCtl?.view.focusId === state.selection.id;
    const focusBtn = h('button', { class: 'btn small', title: 'Show only the path through the selected object; click again to clear', disabled: !state.selection, onClick: () => {
      if (!state.selection) return;
      if (focusOn()) { state.scale = 'Overview'; graphCtl.setScale('Overview'); } else { state.scale = 'Work'; graphCtl.setScale('Work', { focusId: state.selection.id }); }
      syncScale();
    } }, 'Focus path');
    const syncFocus = () => { const on = focusOn(); focusBtn.textContent = on ? 'Clear focus' : 'Focus path'; focusBtn.classList.toggle('active', on); };
    const upBtn = h('button', { class: 'btn small', title: 'Draw what the selected object serves and rests on', disabled: !state.selection, onClick: () => state.selection && graphCtl.expand(state.selection.id, 'up') }, 'Expand upstream');
    const downBtn = h('button', { class: 'btn small', title: 'Draw the work, results and checks under the selected object', disabled: !state.selection, onClick: () => state.selection && graphCtl.expand(state.selection.id, 'down') }, 'Expand downstream');
    const fitBtn = h('button', { class: 'btn small', title: 'The whole picture, as far as its names stay readable', onClick: () => graphCtl.fit() }, 'Fit');
    // D54: the links between areas and between work items show as a count beside each object, or all drawn.
    const links = h('div', { class: 'segmented', title: 'Other links (between areas, or between work items): a count beside each object and drawn while you point at it or select it, or all drawn' }, ...[['counts', '↗ Link counts'], ['lines', 'All links']].map(([m, label]) => h('button', { class: (state.graphLinks ?? 'counts') === m ? 'active' : '', onClick: (e) => {
      state.graphLinks = m; links.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.currentTarget)); graphCtl.setLinks(m);
    } }, label)));
    // What is done to the picture itself floats over its top right corner (Spec §6.3 "控件放在哪"): it takes no row, and
    // a view the graph chooses keeps the band under it clear of objects (`fitPadTop`, graph-fit.js).
    const float = h('div', { class: 'graph-float', role: 'toolbar', 'aria-label': 'Graph operations' }, focusBtn, upBtn, downBtn, fitBtn, links);
    const stage = h('div', { class: 'graph-stage' }, cyEl, float);
    // Focus path on one object, from the readability panel: the same as selecting it and pressing Focus path.
    const focusPath = (id) => { select({ kind: 'node', id, label: graphCtl.labelOf(id) }); state.scale = 'Work'; graphCtl.setScale('Work', { focusId: id }); syncScale(); };
    const row = controlRow({ mode: 'graph', scales, focusPath });
    legendEl = h('div', { class: 'legend' });
    append(wrap, stage, legendEl);
    setTopTools(row.el);
    append(main, wrap);
    mountStrip(main, ov);
    graphCtl?.destroy();
    // A tap on the graph picks the object where it is: the graph does not move, the popover opens beside it, and it
    // follows the object while the graph is panned, zoomed or made narrower by the docked Keeper (Spec §6.4).
    graphCtl = createGraph(cyEl, {
      onSelect: (s) => select(s, { origin: 'graph' }), onViewport: () => popover.reposition(),
      onStars: (r) => { graph._starNote = r.note; flyout.refresh(row.filter.btn); },
      onReadability: (r) => row.mark.set(r),
      onLegend: (items) => { legendEl = renderLegend(legendEl, items, legendOpen); }, onFolder: openFolderInList,
      // A send-back ellipse or arrow on the graph opens the send-back beside it (CKC-24 §1.18).
      onProcNode: (sbId, elId) => { if (sbId) kProcess.openSendBackPopover(sbId, () => graphCtl?.rectOf(elId) ?? null); },
      // The band under the floating buttons, which a view of the graph's own choosing keeps clear of objects.
      fitPadTop: () => (float.offsetHeight ? float.offsetTop + float.offsetHeight + 6 : 0),
    });
    cyEl.dataset.fitPadTop = String(float.offsetHeight ? float.offsetTop + float.offsetHeight + 6 : 0);
    graphCtl.view.scale = state.scale;
    graphCtl.view.starMode = starMode();
    graphCtl.view.lastVisit = state.lastVisit;
    graphCtl.view.selectionId = state.selection?.id ?? null;
    graphCtl.view.showReplaced = Boolean(state.filters.showReplaced);
    graphCtl.view.links = state.graphLinks ?? 'counts';
    Object.assign(graphCtl.view.filters, graphFilters());
    if (state.scale === 'Work' && state.selection) graphCtl.view.focusId = state.selection.id;
    graphCtl.update(g);
    if (state.selection?.kind === 'node') graphCtl.reveal(state.selection.id);
    else if (state.selection?.kind === 'relation') graphCtl.setSelection(state.selection.id);
    // Sent here to see particular objects (a note's mount, what an investigation affects): they are brought into view.
    if (state.pendingShow?.length) {
      const ids = state.pendingShow;
      const tell = state.pendingShowTell;
      setTimeout(() => { const n = graphCtl?.showAffected(ids) ?? 0; if (tell && ids.length && !n) toast('None of the affected objects is on the graph'); }, 60);
    }
    state.pendingShow = null;
    state.pendingShowTell = false;
    graph._needSelection = [focusBtn, upBtn, downBtn];
    graph._syncFocus = syncFocus;
    graph._syncScale = syncScale;
    // The readability panel offers the List when the picture is too big to read at once (CKC-09 AC-39).
    graph._openList = toList;
    if (state.resultFocus) graph.focusResult();
    // Arriving from a change link (`Show affected` in another view): highlight what it touched once the graph is up.
    if (state.pendingAffected) {
      const c = g.changes?.find((x) => x.id === state.pendingAffected);
      state.pendingAffected = null;
      if (c) setTimeout(() => showAffected(c), 60);
    }
    syncFocus();
  },
  onSelect(selection, _state, opts = {}) {
    if (!opts.keepMarks) graphCtl?.clearMarks();
    if (state.graphMode === 'list') {
      markListSelection(selection);
      // Arriving at an object from search or a link does move the List to it; a click inside the List does not.
      if (opts.reveal && selection?.id) { state.listTarget = `row-${selection.id}`; revealInList(); }
      return;
    }
    if (!graphCtl) return;
    graphCtl.setSelection(selection && selection.kind !== 'note' ? selection.id : null);
    // Picked on the graph itself, the object is where the owner is looking and nothing moves; picked anywhere else
    // (the outline, the strip, search, a link) it is brought to the middle so it can be seen (CKC-09 AC-34).
    if (selection?.kind === 'node' && opts.origin !== 'graph') graphCtl.reveal(selection.id);
    graph._needSelection?.forEach((b) => { b.disabled = !selection || selection.kind === 'note'; });
    graph._syncFocus?.();
    graph._syncScale?.();
    api(overviewUrl()).then((ov) => swapStrip(strip(ov))).catch(() => {});
  },
  async onAssets() {
    const [g, ov] = await Promise.all([api(`/api/projects/${P()}/graph`), api(overviewUrl())]);
    await kProcess.reload(state.projectId);
    if (kProcess.current()) kProcess.indexNodes(g.nodes);
    if (state.graphMode === 'code') { await renderCode(document.querySelector('#main'), ov); return; }
    if (state.graphMode === 'list' && g.nodes.length > 0) { await refreshList(g, ov); refreshOpenStripRows(); return; }
    if (!graphCtl || g.nodes.length === 0) { renderBody(); return; }
    graph._data = g;
    graphCtl.update(g);
    swapStrip(strip(ov));
    refreshOpenStripRows();
  },
  highlight(ids) { graphCtl?.highlight(ids); },
  clearMarks() { graphCtl?.clearMarks(); },
  /** The theme changed: the graph reads its palette again and repaints in place; nothing is fetched or laid out again. */
  repaint() { graphCtl?.repaint(); },
  /** Where the selected object is on the graph right now, for the popover to stand beside; null when it is not drawn. */
  anchorRect(selection) {
    if (!selection || selection.kind === 'note' || !onGraphNow() || !graphCtl.cy.container()?.isConnected) return null;
    return graphCtl.rectOf(selection.id, selection.at ?? null);
  },
  /** The first of these objects that is drawn: where a note's or an undrawn relation's popover stands on the graph. */
  hintRect(ids = []) {
    if (!onGraphNow() || !graphCtl.cy.container()?.isConnected) return null;
    for (const id of ids) { const r = graphCtl.rectOf(id); if (r) return r; }
    return null;
  },
  /** A result, review or test found by search: its work item's Work scale, with the result picked out (Spec §6.12). */
  focusResult() {
    const id = state.resultFocus;
    state.resultFocus = null;
    const n = graphCtl?.view.data?.nodes.find((x) => x.id === id);
    if (!graphCtl || !n) return;
    if (n.parentId) { state.scale = 'Work'; graphCtl.setScale('Work', { focusId: n.parentId }); graph._syncScale?.(); }
    graphCtl.setSelection(id);
    graphCtl.reveal(id);
  },
};

// ── List view: by module (D100; Spec §6.3 `List`; CKC-09 AC-15, CKC-24 AC-20) ─────────────────────────────────
// The owner's drawn structure: on top the owner's words, the product and the goals; then the earlier generations rolled,
// one line each; then one block per area — its name with `Intent & basis`, one sentence of the effect it is for, its
// requirements, designs and decisions folded, then `Work & plan` · `Observed reality`, a row per work item — and last the
// ringed cross-cutting block. Places come from the same model as the Graph (ui/placement.js), so the two agree.
// Every part opens and closes at its head and starts folded (E153; ui/list-fold.js): the top plate to one line with the
// product's name, a generation to its row, a block to its head card — its name, the effect it is for, its counts, and
// what is still open inside it (D75) — so the whole List is about one screen and the owner opens the module they want.
/** A ❓ in the List, the same mark as on the Graph: lit while a note on it needs you, quiet otherwise (D100). */
const noteMark = (attention, notes, title) => (attention || notes ? h('span', { class: `q-mark ${attention ? 'ask' : 'note'}`, title: title ?? (attention ? `${attention} note${attention === 1 ? '' : 's'} on it still need${attention === 1 ? 's' : ''} you` : `${notes} note${notes === 1 ? '' : 's'} on it`) }, attention ? `❓${attention > 1 ? ` ${attention}` : ''}` : '❓') : null);
function buildList(g, ov) {
  const showReplaced = Boolean(state.filters.showReplaced);
  const vis = (n) => !['Replaced', 'Deferred', 'Abandoned'].includes(n.validity) || showReplaced || n.recentChange;
  const M = placementOf(g, { showReplaced });
  const byId = M.byId;
  const areas = M.areas;
  const starred = starredIds(g.nodes, starMode(), state.lastVisit).ids;
  const star = (n) => (starred.has(n.id) ? h('span', { class: 'star', title: 'New or changed' }, '★ ') : null);
  // The drawer's ❓ count pressed (CF, views.js setAttentionFilter; Spec §6.2): only the objects its attention notes hang
  // on — each in its module's block, with the block's head so it can be read. Every other filter acts on the Graph only.
  const only = graphFilters().attention ? new Set(graphFilters().attentionIds ?? []) : null;
  const keep = (id) => !only || only.has(id);
  // One count for the List's blocks and the graph's folders (D55): the same objects, the same numbers.
  const cells = observedCells(g, showReplaced, M);
  const sel = (n) => (state.selection?.id === n.id ? ' sel' : '');
  const nodeBtn = (n, text = n.label) => h('span', { id: `row-${n.id}` }, star(n), h('button', { class: `text-btn${sel(n)}`, 'data-node': n.id, title: text !== n.label ? n.label : null, onClick: () => select(NODE_SEL(n)) }, n.validity === 'Replaced' || n.validity === 'Abandoned' ? h('s', {}, text) : text, n.updatePending ? ' ⟳' : ''), noteMark(n.noteAttention, n.noteCount));
  const procView = kProcess.current();
  // Document-like objects name their current version (CKC-24 AC-4); a project that keeps only the latest says so.
  const docTag = (id) => {
    const d = procView?.docs?.[id];
    if (!d) return null;
    return h('span', { class: 'faint', title: d.historyFrom ? `Under version control only from ${d.historyFrom} — earlier versions cannot be shown` : `${d.versions} version${d.versions === 1 ? '' : 's'}` },
      ` · ${d.current ? `current: ${d.current}` : 'no current version recorded'}${d.historyFrom ? ` (history from ${d.historyFrom})` : ''}`);
  };
  const planName = (id) => (id === NO_PLAN ? 'Not in a plan' : cleanName(byId.get(id)?.label ?? id).split(' · ')[0]);
  const planTag = (n) => { const p = M.place.get(n.id); if (!p) return null; const also = M.also.get(n.id)?.plans ?? []; return h('span', { class: `tag plan-tag${p.band === NO_PLAN ? ' none' : ''}`, title: p.band === NO_PLAN ? 'Not in a plan yet: no record read so far places it in a plan' : `Plan: ${cleanName(byId.get(p.band)?.label ?? '')}${also.length ? ` · also listed in ${also.map(planName).join(', ')}` : ''}` }, planName(p.band), also.length ? ` +${also.length}` : ''); };
  // `Basis`: where it rests, in its popover (sources, how it got here, its relations with their basis).
  const basisBtn = (n) => h('button', { class: 'text-btn basis-btn', title: `${n.basis ?? 'Explicit'}: open what it rests on — its sources, how it got here and its relations`, onClick: (e) => { e.stopPropagation(); select(NODE_SEL(n)); } }, n.basis === 'Inferred' ? 'Basis · Inferred' : 'Basis');
  const notesIn = (ids) => { let attention = 0, notes = 0; for (const id of ids) { const n = byId.get(id); attention += n?.noteAttention ?? 0; notes += n?.noteCount ?? 0; } return { attention, quiet: Math.max(0, notes - attention) }; };
  const foldMark = (ids) => { const m = notesIn(ids); return noteMark(m.attention, m.attention + m.quiet, m.attention ? `${m.attention} note${m.attention === 1 ? '' : 's'} inside still need${m.attention === 1 ? 's' : ''} you` : `${m.quiet} note${m.quiet === 1 ? '' : 's'} inside`); };
  const kindCount = (ids) => { const c = {}; for (const id of ids) { const k = byId.get(id)?.category; c[k] = (c[k] ?? 0) + 1; } return INTENT_KINDS.filter((k) => c[k]).map((k) => `${c[k]} ${k === 'Design' ? 'design' : k === 'Decision' ? 'decision' : 'requirement'}${c[k] === 1 ? '' : 's'}`).join(' · '); };
  // A send-back hanging on a requirement or decision shows in its block, open, not inside the fold (mockup 3.5).
  const intentFlagsOf = (ids) => (procView ? ids.flatMap((id) => kProcess.intentFlags(id)).map((f) => (f.classList.add('intent-flag'), f)) : []);
  /** A folded group of requirements, designs and decisions with its counts; expand / collapse (the owner's drawing). */
  const intentFold = (ids, label, key) => {
    const list = ids.filter((id) => vis(byId.get(id)) && keep(id));
    if (!list.length) return null;
    const open = state.listOpen?.has(key) || list.some((id) => id === state.selection?.id);
    return h('details', { class: 'ref-fold rdd', open: open || null, onToggle: (e) => { state.listOpen ??= new Set(); if (e.currentTarget.open) state.listOpen.add(key); else state.listOpen.delete(key); } },
      h('summary', {}, `${label} · ${kindCount(list)}`, ' ', foldMark(list)),
      ...INTENT_KINDS.flatMap((k) => list.filter((id) => byId.get(id).category === k).sort((a, b) => byId.get(a).label.localeCompare(byId.get(b).label, undefined, { numeric: true })).map((id) => {
        const r = byId.get(id), p = M.place.get(id);
        // On the whole product (CM; Spec §1.4 "写明为什么"): the Keeper's written reason under its line.
        return h('div', p?.ring === 'whole' ? { title: `${WHOLE_LABEL}: ${p.why}` } : {}, h('span', { class: 'tag' }, r.category), ' ', nodeBtn(r), docTag(r.id), ' ', validityTag(r.validity),
          p?.ring === 'multi' ? h('span', { class: 'faint' }, ` · reaches ${p.areas.map((a) => cleanName(byId.get(a)?.label ?? a).split(' · ')[0]).join(', ')}`) : null,
          p?.ring === 'whole' ? h('div', { class: 'faint whole-why' }, p.why) : null);
      })));
  };
  // The blocks that open and close (E153): folded until the owner opens them. With the ❓ filter on, every block that
  // is left is drawn open — it is there only for what the filter picked.
  const pid = state.projectId;
  const drawn = [];
  const blockOpen = (key) => { drawn.push(key); return Boolean(only) || listFold.isOpen(pid, key); };
  /**
   * What a folded head lights of its inside (D75 「折起来也亮着」; Spec §6.3 List, CKC-09 AC-15): the count of what is
   * still open — send-backs, lit breakpoints, findings — and the count of the notes inside, lit while any needs the
   * owner. `works` are the work rows drawn inside, `objects` the other objects it holds, `notes` whatever inside can
   * carry a note. Nothing open and no note: nothing is drawn.
   */
  const insideMarks = ({ works = [], objects = [], notes = [...works, ...objects] }) => {
    const open = openInside(procView, { works, objects });
    const m = notesIn([...new Set(notes)]);
    const k = m.attention || m.quiet;
    return [
      open ? h('span', { class: 'tag red inside-open', title: `Still open inside: ${open.text}` }, `⚠ ${open.count}`) : null,
      k ? h('span', { class: `q-mark ${m.attention ? 'ask' : 'note'} inside-notes`, title: m.attention ? `${m.attention} note${m.attention === 1 ? '' : 's'} inside still need${m.attention === 1 ? 's' : ''} you${m.quiet ? ` · ${m.quiet} more inside` : ''}` : `${m.quiet} note${m.quiet === 1 ? '' : 's'} inside` }, `❓ ${k}`) : null,
    ];
  };
  const shownIds = (ids) => ids.filter((id) => byId.has(id) && vis(byId.get(id)) && keep(id));
  const procCtx = { nodeBtn, acceptanceTag, validityTag, planTag, basisBtn, nodeOf: (id) => byId.get(id) ?? null, labelOf: (id) => byId.get(id)?.label ?? id, destinationLine, destinationText, foldMarks: foldMark,
    insideMarks, openGen: (id) => blockOpen(generationKey(id)), genToggled: (id, open) => { if (!only) listFold.set(pid, generationKey(id), open); } };
  const absorbed = procView ? kProcess.absorbedIds() : new Set();
  const bandIndex = (id) => M.bandOrder.get(M.place.get(id)?.band) ?? 999;
  const PROGRESS = { 'In progress': 0, 'Planned': 1, 'On hold': 2, 'Done': 3 };
  // A work item serving several modules has a row in each (owner, 2026-09-30): solid in its main module, saying where
  // else it is; dashed in the others, saying where its main one is. The same object: a click selects it, and both rows
  // light up (markListSelection); only the main row carries the id a link scrolls to.
  const sharedTag = (n, area) => {
    const m = sharedMark(M, n.id, area);
    if (!m) return null;
    const name = (a) => cleanName(byId.get(a)?.label ?? a);
    const why = MAIN_BY[m.by] ? ` — ${MAIN_BY[m.by]}` : '';
    return h('span', { class: `tag shared-tag ${m.copy ? 'copy' : 'main'}`, title: m.copy ? `Also serves this module; its main row is under ${name(m.main)}${why}` : `Its main module${why}; also serves ${m.others.map(name).join(', ')}, listed there dashed` }, m.text);
  };
  const copyBtn = (area) => (n) => h('span', { id: `row-${n.id}--in-${area}` }, star(n), h('button', { class: `text-btn${sel(n)}`, 'data-node': n.id, onClick: () => select(NODE_SEL(n)) }, n.label, n.updatePending ? ' ⟳' : ''), noteMark(n.noteAttention, n.noteCount));
  const workRowIn = (id, area, repeated = null) => {
    const copy = isCopyIn(M, id, area);
    // A line the block states once: the row keeps the kind of the step and, when the block states more than one, what
    // tells them apart (`Planned · e37a24f (Modified)`).
    const same = (step, text) => (repeated.has(text) ? h('span', { class: 'wr-steps same', title: text }, repeated.prefix ? `${step.kind} · ${text.slice(repeated.prefix.length)}` : step.kind) : null);
    const row = kProcess.workRow(byId.get(id), { ...procCtx, extraLeft: (n) => sharedTag(n, area), ...(copy ? { nodeBtn: copyBtn(area) } : {}), ...(repeated?.size ? { stepLine: same } : {}) });
    if (copy) { row.classList.add('shared-copy'); row.dataset.copyIn = area; }
    return row;
  };
  // Rows in the order of the Graph's bands (a plan's rows together), then by progress and name; no plan last.
  const rowIds = (ids) => ids.filter((id) => vis(byId.get(id)) && keep(id) && !absorbed.has(id))
    .sort((a, b) => bandIndex(a) - bandIndex(b) || (PROGRESS[byId.get(a).progress] ?? 4) - (PROGRESS[byId.get(b).progress] ?? 4) || byId.get(a).label.localeCompare(byId.get(b).label, undefined, { numeric: true }));
  const rowsOf = (ids, area = null, repeated = null) => rowIds(ids).map((id) => workRowIn(id, area, repeated));
  // The one-step line a row shows beside its name, and the ones two rows or more of a block share: each is said once
  // under the block's column heads, and the rows say only the kind of the step.
  const repeatedSteps = (ids) => {
    const count = new Map();
    for (const id of rowIds(ids)) { const t = kProcess.stepText(id); if (t) count.set(t, (count.get(t) ?? 0) + 1); }
    const repeated = new Map([...count].filter(([, k]) => k > 1));
    // What the lines the block states share, up to a space or a slash: the rows say only the rest.
    const keys = [...repeated.keys()];
    let prefix = keys.length > 1 ? keys.reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i); }) : '';
    prefix = prefix.slice(0, Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('/')) + 1);
    repeated.prefix = prefix;
    return repeated;
  };
  const repeatedNote = (repeated) => (repeated.size ? h('div', { class: 'rows-note' }, ...[...repeated].map(([t, k]) => h('div', {}, h('b', {}, `${k} rows`), ` · ${t}`))) : null);
  const worksIn = (area) => listRowsOf(M, area).map((r) => r.id);
  // Observed reality: what the graph's folder for this column holds, with the same count on top (D55, AC-15, AC-30).
  const realityOf = (key) => {
    const cell = cells.get(key);
    const flags = cell ? [[MARKS.flag, cell.flagged], [MARKS.note, cell.noted], [MARKS.pending, cell.pending]].filter(([, k]) => k).map(([m, k]) => h('span', { class: `mark-${m.key}` }, ` ${m.glyph} ${k}`)) : [];
    return h('details', { id: `obs-${key ?? 'project-wide'}`, class: 'ref-fold obs-fold', open: state.listTarget === `obs-${key ?? 'project-wide'}` || null },
      h('summary', {}, 'Observed reality · ', cell?.total ? [h('b', {}, String(cell.total)), ` · ${cellSummary(cell)}`, cell.unplaced ? ` · ${cell.unplaced} not linked to any work` : null, ...flags] : 'No result or verification recorded yet'),
      ...(cell?.items ?? []).map((r) => h('div', {}, h('span', { class: 'tag' }, r.category), ' ', nodeBtn(r), r.parentId ? h('span', { class: 'faint' }, ` · ${cleanName(byId.get(r.parentId)?.label ?? '')}`) : h('span', { class: 'faint' }, ' · not linked to any work'))));
  };
  const colsHead = () => h('div', { class: 'cols' }, h('span', {}, 'Work & plan'), h('span', {}, 'Observed reality'));
  // The first sentence: up to a full stop — a Chinese one anywhere, a Latin one only before a space or the end, so
  // "(v0.4 …" is not cut at "v0." (owner 2026-09-30's screenshot of CK-M1).
  const firstSentence = (t) => { const s = String(t ?? '').replace(/\*\*|__|`/g, '').split(/(?<=[。！？])|(?<=[.!?])(?=\s)|\n/)[0]?.trim() ?? ''; return s.length > 160 ? `${s.slice(0, 159)}…` : s; };
  /** A module's code and its name: `CK-M1 · 看懂项目全貌与工作关系` → the kicker and the title of its lane card. */
  const codeAndName = (label) => { const t = cleanName(label ?? ''); const i = t.indexOf(' · '); return i > 0 && i <= 16 ? [t.slice(0, i), t.slice(i + 3)] : [null, t]; };

  const areaBlock = (a) => {
    const works = worksIn(a.id);
    const repeated = repeatedSteps(works);
    const rows = rowsOf(works, a.id, repeated);
    const intentIds = M.intent.get(a.id) ?? [];
    const noPlan = works.filter((id) => M.place.get(id)?.band === NO_PLAN).length;
    const count = M.areaWork.get(a.id);
    if (only && !keep(a.id) && !rows.length && !intentIds.some(keep)) return null;
    const [code, name] = codeAndName(a.label);
    // A cross-cutting foundation (D101; Spec §6.3 List): its block comes after every module's (M.areas puts it last) and
    // its head keeps the project's name and says `Cross-cutting foundation` in the kicker.
    const kicker = a.foundation ? (code ? `${code} · ${FOUNDATION_LABEL}` : FOUNDATION_LABEL) : code ?? 'Module';
    const key = blockKey(a.id);
    const open = blockOpen(key);
    const rowsIn = rowIds(works), intentIn = shownIds(intentIds);
    // The module's own ❓ stands beside its name; the head counts what is inside.
    const inside = insideMarks({ works: rowsIn, objects: [a.id, ...intentIn], notes: [...rowsIn, ...intentIn, ...(cells.get(a.id)?.items ?? []).map((r) => r.id)] });
    return h('section', { class: `ablock${a.foundation ? ' foundation' : ''}${sel(a)}`, id: `block-${a.id}`, 'data-node': a.id, 'data-fold': key, 'data-open': String(open) },
      // The head is a lane card (owner 2026-09-30, from a design study of hers): the small caps kicker — the module's code and
      // its counts —, the title, the one-sentence effect, and its intent and basis to open. Pressed, it opens or folds
      // the block's body (E153); folded, the card is the whole block, on two lines.
      h('div', { class: 'ab-head lane', ...foldHead(key, open) },
        h('div', { class: 'lane-top' },
          h('span', { class: 'fold-caret', 'aria-hidden': 'true' }), h('span', { class: 'lane-kicker', title: a.foundation ? `${FOUNDATION_LABEL}: the base the modules share, not a module users face` : null }, kicker),
          h('span', { class: 'lane-right' }, inside,
            h('span', { class: 'lane-count', title: count?.shared ? `${count.shared} of them also serve another module: ${count.main} with their main row here, ${count.shared - count.main} listed here dashed` : '' }, areaWorkLine(count)))),
        h('h3', { class: 'lane-title' }, nodeBtn(a, name)),
        h('p', { class: 'effect lane-sub' }, firstSentence(a.summary) || h('span', { class: 'faint' }, 'The effect it is for is not written yet.'), a.basis === 'Inferred' ? [' ', basisTag('Inferred')] : null),
        h('details', { class: 'intent-basis' }, h('summary', {}, 'Intent & basis'),
          h('div', { class: 'ib-body' }, a.summary ? h('p', {}, a.summary) : h('p', { class: 'faint' }, 'No description of this area yet.'),
            h('div', {}, basisTag(a.basis) ?? h('span', { class: 'tag' }, 'Explicit'), ' ', validityTag(a.validity), a.noEstablishedLink ? h('span', { class: 'tag red' }, 'No established link') : null, ' ',
              h('button', { class: 'btn small', onClick: () => select(NODE_SEL(a)) }, 'Details'))))),
      h('div', { class: 'ab-body', id: foldBodyId(key), 'data-fold-body': '', hidden: !open },
        h('div', { class: 'rddrow' }, intentFold(intentIds, 'Requirements, designs & decisions', `intent:${a.id}`) ?? h('span', { class: 'faint' }, 'No requirement, design or decision placed on this area yet'), ...intentFlagsOf([a.id, ...intentIds])),
        colsHead(),
        repeatedNote(repeated),
        ...(rows.length ? rows : [h('div', { class: 'faint pad' }, 'No work item placed in this area yet')]),
        noPlan ? h('div', { class: 'faint pad' }, `${noPlan} of these ${noPlan === 1 ? 'is' : 'are'} not in a plan yet`) : null,
        realityOf(a.id)));
  };

  // The ringed cross-cutting block, last: what reaches several areas or none, the work of no area, each plan's own row.
  const crossBlock = () => {
    // Work for a whole plan — all of the plan's modules, no single one — is placed, with the Keeper's written reason
    // (CN, E152; Spec §1.4): listed apart from the work no record places in an area yet.
    const noArea = listRowsOf(M, null);
    const wholeWhy = new Map(noArea.filter((r) => r.whole).map((r) => [r.id, r.whole]));
    const works = noArea.filter((r) => !r.whole).map((r) => r.id);
    const repeated = repeatedSteps(works);
    const rows = rowsOf(works, null, repeated);
    // The Keeper's reason stands beside the tag, on the row's one line; the whole of it is in the hover.
    const wholeTag = (n) => [h('span', { class: 'tag whole-tag', title: `${WHOLE_PLAN_LABEL}: it serves all of its plan’s modules and no single one` }, WHOLE_PLAN_LABEL.toLowerCase()), wholeWhy.get(n.id) ? h('span', { class: 'wr-why', title: wholeWhy.get(n.id) }, wholeWhy.get(n.id)) : null];
    // A plan's unit also names the work of its batches; work for the whole plan is listed here in its own right, with why.
    const wholeIds = [...wholeWhy.keys()].filter((id) => vis(byId.get(id)) && keep(id) && !procView?.works?.[id]?.stepOf)
      .sort((a, b) => bandIndex(a) - bandIndex(b) || byId.get(a).label.localeCompare(byId.get(b).label, undefined, { numeric: true }));
    const wholeRows = wholeIds.map((id) => { const row = kProcess.workRow(byId.get(id), { ...procCtx, extraLeft: wholeTag }); row.classList.add('whole-plan'); return row; });
    const planRows = M.plans.filter((p) => keep(p.id) || (M.exec.get(p.id) ?? []).some(keep)).map((p) => h('div', { class: 'plan-row' },
      procView?.works?.[p.id] ? kProcess.unitBlock(p, procCtx) : h('div', { class: 'unit' }, h('div', { class: 'row2' }, h('div', {}, h('span', { class: 'tag' }, 'Plan'), ' ', nodeBtn(p), ' ', p.progress ? h('span', { class: 'tag' }, p.progress) : null), h('div', {}, basisBtn(p)))),
      intentFold(M.exec.get(p.id) ?? [], 'Execution decisions', `exec:${p.id}`) ?? h('div', { class: 'faint pad' }, 'No execution decision placed on this plan yet')));
    const u = M.unplaced;
    const open = blockOpen(CROSS_KEY);
    const ringIds = shownIds([...M.ring.multi, ...M.ring.whole, ...M.ring.product, ...M.ring.none]);
    const planIds = M.plans.filter((p) => keep(p.id) || (M.exec.get(p.id) ?? []).some(keep)).map((p) => p.id);
    const execIds = shownIds(planIds.flatMap((id) => M.exec.get(id) ?? []));
    const workIn = [...wholeIds, ...rowIds(works)];
    const inside = insideMarks({ works: [...planIds, ...workIn], objects: [...ringIds, ...execIds], notes: [...planIds, ...workIn, ...ringIds, ...execIds, ...(cells.get(null)?.items ?? []).map((r) => r.id)] });
    const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
    const holds = [ringIds.length + execIds.length ? `${ringIds.length + execIds.length} requirements, designs & decisions` : null, planIds.length ? plural(planIds.length, 'plan') : null, plural(workIn.length, 'work item')].filter(Boolean).join(' · ');
    return h('section', { class: 'ablock cross', id: 'block-cross', 'data-fold': CROSS_KEY, 'data-open': String(open) },
      h('div', { class: 'ab-head lane', ...foldHead(CROSS_KEY, open) },
        h('div', { class: 'lane-top' },
          h('span', { class: 'fold-caret', 'aria-hidden': 'true' }), h('span', { class: 'lane-kicker' }, 'Not one-to-one with the modules above'),
          h('span', { class: 'lane-right' }, inside, h('span', { class: 'lane-count' }, holds))),
        h('h3', { class: 'lane-title' }, 'Cross-cutting')),
      h('div', { class: 'ab-body', id: foldBodyId(CROSS_KEY), 'data-fold-body': '', hidden: !open },
        h('div', { class: 'rddrow' }, intentFold(M.ring.multi, 'Reaching several areas', 'ring:multi'), intentFold(M.ring.whole, WHOLE_LABEL, 'ring:whole'), intentFold(M.ring.product, 'Only on the product — not placed yet', 'ring:product'), intentFold(M.ring.none, 'Not placed yet', 'ring:none'), ...intentFlagsOf([...M.ring.multi, ...M.ring.whole, ...M.ring.product, ...M.ring.none])),
        u.intent ? h('div', { class: 'faint pad' }, `${u.intent} requirement${u.intent === 1 ? '' : 's'}, design${u.intent === 1 ? '' : 's'} or decision${u.intent === 1 ? '' : 's'} not placed yet (the Keeper places each on the area or plan it acts on)`) : null,
        h('h4', { class: 'sub-h' }, 'Plans'), ...planRows,
        wholeRows.length ? [h('h4', { class: 'sub-h' }, `Work for a whole plan · ${wholeRows.length}`), colsHead(), ...wholeRows] : null,
        h('h4', { class: 'sub-h' }, `Work of no area${rows.length ? ` · ${rows.length}` : ''}`),
        colsHead(),
        repeatedNote(repeated),
        ...(rows.length ? rows : [h('div', { class: 'faint pad' }, 'Every work item is placed in an area')]),
        realityOf(null)));
  };

  const words = g.nodes.filter((n) => n.group === "Owner's words" && vis(n) && keep(n.id)).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const wordsFold = words.length ? h('details', { class: 'ref-fold words-fold', open: state.listWordsOpen || words.some((w) => w.id === state.selection?.id) || null, onToggle: (e) => { state.listWordsOpen = e.currentTarget.open; } },
    h('summary', {}, h('span', { class: 'plate-label' }, "Owner's words"), ' ', h('span', { class: 'plate-count' }, String(words.length)), ' ', foldMark(words.map((w) => w.id))),
    ...words.map((w) => h('div', {}, nodeBtn(w), ' ', validityTag(w.validity)))) : null;
  const goals = g.nodes.filter((n) => n.category === 'Goal' && vis(n));
  const products = g.nodes.filter((n) => n.category === 'Product' && vis(n));
  const marksOf = (x) => (x.noteAttention || x.noteCount ? [' ', noteMark(x.noteAttention, x.noteCount)] : null);
  const productSlot = (x) => h('button', { class: `plate-slot${sel(x)}`, 'data-node': x.id, onClick: () => select(NODE_SEL(x)) }, x.label, marksOf(x));
  const goalLine = (x) => h('li', {}, h('button', { class: `goal-line${sel(x)}`, 'data-node': x.id, onClick: () => select(NODE_SEL(x)) }, x.label), marksOf(x));
  // The top plate (the Sign in card): pressed at its title line it folds to one line — the project, the product's
  // name, how many owner's words and goals it holds, and what inside is open or carries a note — and opens again.
  const plateOpen = wordsFold || products.length || goals.length ? blockOpen(PLATE_KEY) : false;
  const plateInside = [...words, ...products, ...goals].map((x) => x.id);
  const plate = wordsFold || products.length || goals.length ? h('section', { class: 'list-plate', 'aria-label': 'The owner\u2019s words, the product and its goals', 'data-fold': PLATE_KEY, 'data-open': String(plateOpen) },
    h('i', { class: 'rivet r1', 'aria-hidden': 'true' }), h('i', { class: 'rivet r2', 'aria-hidden': 'true' }), h('i', { class: 'rivet r3', 'aria-hidden': 'true' }), h('i', { class: 'rivet r4', 'aria-hidden': 'true' }),
    h('div', { class: 'plate-head', ...foldHead(PLATE_KEY, plateOpen) },
      h('span', { class: 'fold-caret', 'aria-hidden': 'true' }),
      h('p', { class: 'plate-title' }, state.project?.name ?? 'The project'),
      h('span', { class: 'plate-brief', title: products.map((x) => x.label).join(' · ') || null }, products.map((x) => x.label).join(' · ')),
      h('span', { class: 'plate-holds' }, insideMarks({ objects: plateInside }),
        h('span', { class: 'plate-holds-text' }, [words.length ? `${words.length} owner\u2019s word${words.length === 1 ? '' : 's'}` : null, goals.length ? `${goals.length} goal${goals.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')))),
    h('div', { class: 'plate-body', id: foldBodyId(PLATE_KEY), 'data-fold-body': '', hidden: !plateOpen },
      wordsFold ? h('div', { class: 'plate-group goals' }, wordsFold) : null,
      products.length ? h('div', { class: 'plate-group plate-product goals' }, h('span', { class: 'plate-label' }, 'Product'), ...products.map((x) => h('div', { class: 'plate-row' }, productSlot(x), docTag(x.id)))) : null,
      goals.length ? h('div', { class: 'plate-group plate-goals' }, h('span', { class: 'plate-label' }, 'Goals ', h('span', { class: 'plate-count' }, String(goals.length))), h('ol', { class: 'goal-list' }, ...goals.map(goalLine))) : null)) : null;
  const wrap = h('div', { class: 'list-wrap by-module' },
    only ? h('div', { class: 'list-only' }, `Showing only the objects whose notes need you (${only.size})`, ' ', h('button', { class: 'text-btn', onClick: () => { setAttentionFilter(false); } }, 'Show everything')) : null,
    plate,
    procView || M.generations.length ? kProcess.generationBands(procCtx, M.generations) : null,
    ...areas.map(areaBlock),
    crossBlock(),
    areas.length === 0 ? h('div', { class: 'faint', style: { padding: '12px' } }, 'No area established yet.') : null);
  listBlockKeys = [...new Set(drawn)];
  return { wrap };
}

async function renderList(main, g, ov) {
  graph._data = g;
  await kProcess.load(state.projectId);
  if (kProcess.current()) kProcess.indexNodes(g.nodes);
  const { wrap } = buildList(g, ov);
  // The same control row as over the graph, outside the table: a refreshed List does not rebuild it (AC-37).
  setTopTools(controlRow({ mode: 'list' }).el);
  append(main, wrap);
  mountStrip(main, ov);
  if (state.listTarget) requestAnimationFrame(revealInList);
}
/** New assets or a filter while the List is open: the table is replaced only if it changed, and stays where it was. */
async function refreshList(g, ov) {
  if (!g || !ov) [g, ov] = await Promise.all([api(`/api/projects/${P()}/graph`), api(overviewUrl())]);
  await kProcess.load(state.projectId);
  if (kProcess.current()) kProcess.indexNodes(g.nodes);
  const current = document.querySelector('#main .list-wrap');
  if (!current) { renderBody(); return; }
  graph._data = g;
  const { wrap } = buildList(g, ov);
  if (wrap.outerHTML !== current.outerHTML) { const top = current.scrollTop; current.replaceWith(wrap); wrap.scrollTop = top; }
  swapStrip(strip(ov));
}

// ── Code (§6.17): the territories of the current version, next to Graph and List ─────────────────────────────
/**
 * The `Code` of the Project graph's control row: AS's `ui/k/code-view.js` draws the territories; this mounts it,
 * hands it the view and the bridges (to a work's process, a note, a send-back, a file), and says `No data for this
 * yet` when the endpoint is not built yet.
 */
async function renderCode(main, ov) {
  if (!main) return;
  setTopTools(controlRow({ mode: 'code' }).el);
  const container = h('div', { class: 'k-code', id: 'k-code' });
  append(main, container);
  mountStrip(main, ov);
  const code = await kData.getCode(state.projectId).catch((e) => ({ error: e }));
  // 404 — the endpoint is not built yet: `No data for this yet`. Any other answer carries the server's own reason
  // (e.g. the ledger is not carried by this build): shown as it arrived, nothing invented.
  if (!code || code.error) { state.codeTarget = null; append(container, h('div', { class: 'empty' }, h('h2', {}, 'Code'), h('p', {}, code?.error ? `Could not load: ${code.error.message}` : kData.noData()))); return; }
  const ctx = {
    fetchTerritory: (tid) => kData.getTerritory(state.projectId, tid),
    openWork: (workId) => { state.graphMode = 'graph'; state.selection = { kind: 'node', id: workId, label: workId }; state.pendingPopover = {}; renderBody(); },
    openNote: (noteId) => select({ kind: 'note', id: noteId, label: noteId }),
    // The view carries the send-backs its anomalies have (CodeView.sendBacks), so an anomaly reaches its send-back
    // however the page was opened; the process view is only a second place to look (QC AY B6).
    getSendBack: (id) => code.sendBacks?.[id] ?? (kProcess.current()?.sendBacks ?? []).find((s) => s.id === id) ?? null,
    openSendBack: (sb, anchorEl) => kProcess.openSendBackPopover(sb, () => { if (!anchorEl?.isConnected) return null; const r = anchorEl.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }),
    copy: (text) => kProcess.copyText(text),
    // A file of the current version, found by the ledger's fileRefs and read as the ledger read it (§6.17; QC AY B13).
    openFile: (repo, path) => openCodeFile(repo, path),
  };
  renderCodeView(container, code, ctx);
  // Arrived from a work's `Code it changed`: its territory is brought into view, marked, and its files opened.
  const target = state.codeTarget;
  state.codeTarget = null;
  if (target) {
    const row = container.querySelector(`tr[data-terr="${CSS.escape(target)}"]`);
    if (!row) { toast('That territory is not in the current version’s Code'); return; }
    if (!container.querySelector(`tr.kv-drill[data-tid="${CSS.escape(target)}"]`)) row.querySelector('.kv-tname')?.click();
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash', 'kv-target');
    setTimeout(() => row.classList.remove('flash'), 1800);
  }
}

/** A file of the current version in the reading dialog (§6.4 原文阅读): where it is, the version read, its lines numbered. */
async function openCodeFile(repo, path, from = 1) {
  let f;
  try { f = await kData.getCodeFile(state.projectId, { repo, path, from }); } catch (e) { toast(`${path}: ${e.message}`); return; }
  const quote = h('div', { class: 'source-quote' }, ...f.text.split('\n').map((line, i) => h('div', { class: 'src-line' }, h('span', { class: 'no' }, f.fromLine + i), h('span', { class: 'tx' }, line))));
  openDialog(path.split('/').pop() ?? path, [
    h('dl', { class: 'kv' },
      h('dt', {}, 'Kind'), h('dd', {}, `code${f.lang ? ` · ${f.lang}` : ''}${f.generated ? ' · generated' : ''}`),
      h('dt', {}, 'Location'), h('dd', { class: 'mono' }, `${f.repo} › ${f.path}`),
      h('dt', {}, 'Version'), h('dd', {}, f.commit ? h('span', { class: 'mono' }, f.commit) : '—', f.occurred ? ` · ${kProcess.fmtOccurred(f.occurred)}` : '', ' — the current version the ledger read'),
      h('dt', {}, 'Lines'), h('dd', {}, f.fromLine === 1 && f.toLine >= f.lines ? `${f.lines}` : `${f.fromLine}–${f.toLine} of ${f.lines}`)),
    quote,
    f.nextFromLine ? h('div', { class: 'dialog-foot' }, h('button', { class: 'btn small', onClick: () => openCodeFile(repo, path, f.nextFromLine) }, `Lines ${f.nextFromLine}–…`)) : null,
  ]);
}

// ── Changes (§6.5) ───────────────────────────────────────────────────────
// ── Readability (D46, CKC-09 AC-26/27, AC-37) ────────────────────────────
/**
 * What the graph's own check found, said plainly: where the picture is hard to read, which objects, and a way to look
 * at it that is readable (focus a path, the whole picture anyway, the List, one object brought into view). Nothing is
 * removed from the picture to make it look tidier. The control row carries the mark and its number (graph-tools.js);
 * this is the panel behind the mark, floating over the graph, so reading it costs the picture no height.
 */
function readabilityPanel(report, { focusPath }) {
  const m = readabilityMark(report);
  const name = (id) => graphCtl?.labelOf(id) ?? id;
  const objBtn = (id) => h('button', { class: 'text-btn', title: 'Bring it into view', onClick: () => bringIntoView(id) }, name(id));
  // What changes the whole picture puts the panel away, so the picture asked for can be seen.
  const focusBtn = (id) => h('button', { class: 'btn small', title: 'Show only the path through this object', onClick: () => { flyout.close(); focusPath(id); } }, 'Focus path');
  const part = (i) => {
    if (i.kind === 'overlap') return h('div', { class: 'read-issue' }, h('b', {}, i.text), ...i.pairs.slice(0, 6).map(([a, b]) => h('div', { class: 'row wrap' }, objBtn(a), h('span', { class: 'faint' }, 'and'), objBtn(b), focusBtn(a))), i.pairs.length > 6 ? h('small', { class: 'faint' }, `and ${i.pairs.length - 6} more`) : null);
    if (i.kind === 'behind') return h('div', { class: 'read-issue' }, h('b', {}, i.text), h('small', { class: 'faint' }, 'The worst ones; Focus path shows a line with only what it connects:'), ...i.worst.slice(0, 5).map((w) => h('div', { class: 'row wrap' }, objBtn(w.source), h('span', { class: 'faint' }, '→'), objBtn(w.target), h('small', { class: 'faint' }, `behind ${w.hidden.length}`), focusBtn(w.source))));
    // The graph does not choose a view smaller than its names can be read (CKC-09 AC-39); the owner may: `Show all anyway`
    // is the whole picture at whatever size that takes, and `Fit` brings the readable view back. Or see less at once.
    if (i.kind === 'size') return h('div', { class: 'read-issue' }, h('b', {}, i.text), h('div', { class: 'row wrap' }, h('button', { class: 'btn small', title: 'The whole picture in the window, however small its words get; Fit brings the readable size back', onClick: () => { flyout.close(); graphCtl?.fitAll(); } }, 'Show all anyway'), h('button', { class: 'btn small', onClick: () => { flyout.close(); graph._openList?.(); } }, 'Open List'), h('small', { class: 'faint' }, 'or fold what you opened (double-click the area or work item again), or select an area or work item and use Focus path')));
    if (i.kind === 'bundle') return h('div', { class: 'read-issue' }, h('b', {}, i.text), ...i.hubs.slice(0, 5).map((x) => h('div', { class: 'row wrap' }, objBtn(x.id), h('small', { class: 'faint' }, `${x.degree} lines`), focusBtn(x.id))));
    return null;
  };
  return [
    h('div', { class: 'read-head' }, h('span', { class: `read-flag${m.count ? ' alert' : ''}` }, '◐'),
      h('b', {}, m.count ? `Hard to read in ${m.count} place${m.count === 1 ? '' : 's'}` : 'Nothing is hard to read'),
      ...m.kinds.map((k) => h('span', { class: 'tag' }, k.kind === 'size' ? k.label : `${k.label} ${k.places}`))),
    h('small', { class: 'faint' }, m.count ? 'Nothing is hidden to tidy it.' : 'Checked each time the picture is drawn: objects on top of each other, lines behind objects, a picture too big to read at once, bunched lines.'),
    m.count ? h('div', { class: 'read-body' }, ...report.issues.map(part)) : null,
  ];
}
/** An object named in the panel is brought to the middle of the graph — and, the panel floating there, out from under it. */
function bringIntoView(id) {
  if (!graphCtl) return;
  graphCtl.reveal(id);
  const r = graphCtl.rectOf(id);
  if (!r || flyout.el.hidden) return;
  const p = flyout.el.getBoundingClientRect(), box = graphCtl.cy.container().getBoundingClientRect();
  if (!(r.left < p.right && p.left < r.right && r.top < p.bottom && p.top < r.bottom)) return;
  const toRight = p.right + 12 - r.left, toLeft = p.left - 12 - r.right;
  const dx = r.right + toRight <= box.right - 8 ? toRight : r.left + toLeft >= box.left + 8 ? toLeft : 0;
  if (dx) graphCtl.cy.panBy({ x: dx, y: 0 });
}

// ── Walkthrough of a change follow-up (Spec §4.2, D47 supplement) ──────────
/**
 * A note from a change follow-up opens into a walkthrough: what the change altered, which objects it reached, and for
 * each one whether it followed, one place at a time, back and forth. Everything shown is read from the assets — the
 * change record, its propagation entries with their sources or reasons, and the objects' names — nothing is written
 * for the occasion, and no legend is needed. Offered only from the note and from Notes (attention).
 */
const PROP_ORDER = ['Still on old understanding', 'Updated', 'Reusable as is', 'Not yet checked'];
const propTag = (st) => h('span', { class: `tag ${st === 'Still on old understanding' ? 'amber' : st === 'Updated' ? 'green' : st === 'Reusable as is' ? 'blue' : ''}` }, st);

export async function openWalkthrough(noteId) {
  const [n, c, g] = await Promise.all([
    api(`/api/projects/${P()}/notes/${encodeURIComponent(noteId)}`),
    api(`/api/projects/${P()}/changes`),
    api(`/api/projects/${P()}/graph`),
  ]);
  const ids = (n.cameFrom?.changes ?? []).map((x) => x.id);
  const rows = ids.map((id) => c.changes.find((x) => x.id === id)).filter(Boolean);
  if (!rows.length) { toast('The change this note came from is no longer in the Change log'); return; }
  const nodes = new Map(g.nodes.map((x) => [x.id, x]));
  const mount = new Set(n.mount?.ids ?? []);
  const dialog = document.querySelector('#dialog');
  const body = h('div', { class: 'walk-root' });
  let change = 0; let cur = 0; let steps = [];

  const stepsOf = (row) => row.propagation
    .map((e) => ({ ...e, label: nodes.get(e.nodeId)?.label ?? row.affectsLabels.find((a) => a.id === e.nodeId)?.label ?? e.nodeId, category: nodes.get(e.nodeId)?.category ?? '' }))
    .sort((a, b) => (Number(mount.has(b.nodeId)) - Number(mount.has(a.nodeId))) || PROP_ORDER.indexOf(a.state) - PROP_ORDER.indexOf(b.state));

  const draw = () => {
    const row = rows[change];
    steps = stepsOf(row);
    cur = Math.max(0, Math.min(steps.length - 1, cur));
    const counts = PROP_ORDER.map((st) => [st, steps.filter((e) => e.state === st).length]).filter(([, k]) => k);
    const step = steps[cur];
    const spine = h('div', { class: 'walk-spine' }, ...steps.map((e, i) => h('button', { class: `walk-item${i === cur ? ' on' : ''}`, onClick: () => { cur = i; draw(); } },
      h('div', { class: 'row wrap' }, propTag(e.state), mount.has(e.nodeId) ? h('span', { class: 'tag origin' }, 'this note') : null),
      h('div', { class: 'walk-name' }, e.label),
      e.sourceOrReason ? h('div', { class: 'walk-why' }, e.sourceOrReason) : null)));
    body.replaceChildren(...[
      rows.length > 1 ? h('div', { class: 'row wrap' }, h('small', {}, `This note is about ${rows.length} changes`), ...rows.map((r, i) => h('button', { class: `btn small${i === change ? ' primary' : ''}`, onClick: () => { change = i; cur = 0; draw(); } }, r.title.slice(0, 40)))) : null,
      h('div', {}, h('h3', { class: 'walk-title' }, row.title), h('div', { class: 'row wrap' }, h('small', {}, fmtTime(row.at)), effectTag(row.effect), row.by?.identity === 'Decision' ? h('span', { class: 'tag amber' }, 'Owner decision') : row.by?.author?.name ? h('span', { class: 'tag' }, row.by.author.name) : null, ...row.sources.map((x) => h('button', { class: 'text-btn', onClick: () => openSource(x.id) }, x.title)))),
      row.before || row.after ? h('div', { class: 'diff' }, h('div', { class: 'old' }, h('small', {}, 'Before'), h('del', {}, row.before || '—')), h('div', { class: 'new' }, h('small', {}, 'After'), row.after || '—')) : null,
      row.summary ? h('p', { class: 'muted' }, row.summary) : null,
      h('div', { class: 'row wrap' }, ...counts.map(([st, k]) => h('span', {}, propTag(st), ` ${k}`))),
      h('div', { class: 'row spread walk-bar' },
        h('b', {}, `Place ${cur + 1} / ${steps.length}`),
        h('div', { class: 'row' }, h('button', { class: 'btn small', disabled: cur === 0 || null, onClick: () => { cur--; draw(); } }, '← Previous'), h('button', { class: 'btn small', disabled: cur >= steps.length - 1 || null, onClick: () => { cur++; draw(); } }, 'Next →'))),
      h('div', { class: 'walk' }, spine,
        step ? h('div', { class: 'walk-step' },
          h('div', { class: 'row wrap' }, propTag(step.state), step.category ? h('span', { class: 'tag' }, step.category) : null),
          h('h3', {}, step.label),
          step.sourceOrReason ? h('p', {}, step.sourceOrReason) : h('p', { class: 'faint' }, step.state === 'Not yet checked' ? 'Not judged yet; the next Follow up will judge it.' : 'No source or reason was recorded.'),
          step.state === 'Not yet checked' ? null : h('small', { class: 'faint' }, `Judged ${fmtTime(step.updatedAt)}`),
          nodes.has(step.nodeId) ? h('div', {}, h('button', { class: 'btn small', onClick: () => { dialog.close(); select({ kind: 'node', id: step.nodeId, label: step.label }); } }, 'Open this object')) : null) : h('div', { class: 'faint' }, 'This change reached nothing downstream.')),
    ].filter(Boolean));
    body.querySelector('.walk-item.on')?.scrollIntoView({ block: 'nearest' });
  };
  const keys = (e) => {
    if (!body.isConnected) return;   // another dialog layer is on top of the walkthrough
    if (e.key === 'ArrowRight' && cur < steps.length - 1) { cur++; draw(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' && cur > 0) { cur--; draw(); e.preventDefault(); }
  };
  openDialog(`Walkthrough · ${n.versions[n.versions.length - 1].title}`, [body], { onClose: () => { dialog.classList.remove('wide'); dialog.removeEventListener('keydown', keys); } });
  dialog.classList.add('wide');
  dialog.addEventListener('keydown', keys);
  draw();
}

/**
 * A semantic patch as a row of the Change log (§1.17, §6.5; CKC-26 AC-4): when the supersession happened, what no longer
 * holds (struck through), what replaced it — which opens the patch — who is affected, and what must not pass as current
 * again. Read from the patch itself, so the log and the patch never say different things.
 */
function patchEvent(p, target) {
  return h('div', { class: `tl-event tl-patch${target === p.id || target === p.number ? ' sel' : ''}`, id: `chg-${p.id}`, dataset: { patch: p.id } },
    h('time', { title: `${p.occurred.basis}${p.occurred.anchor ? ` — ${p.occurred.anchor}` : ''}` }, kProcess.fmtOccurred(p.occurred)),
    h('div', {}, h('span', { class: 'tag purple' }, 'Semantic patch'), ' ', h('span', { class: 'tag', title: 'Numbered by the Keeper' }, `${p.number} · Keeper's number`), ' ', effectTag('Replaced'), p.partial ? [' ', h('span', { class: 'tag amber', title: 'Only part of the old state is withdrawn; the rest stays current' }, 'Partial')] : null),
    h('h3', {}, p.title),
    h('div', { class: 'diff' },
      h('div', { class: 'old' }, h('small', {}, 'No longer holds'), h('del', {}, p.invalidated)),
      h('div', { class: 'new' }, h('small', {}, 'Replaced by'), h('button', { class: 'text-btn tl-patch-link', title: 'Open the semantic patch: its four answers and the evidence', onClick: () => kProcess.openPatch(p.id) }, p.replacedBy))),
    p.affects.length || p.affectsText ? h('div', { class: 'row wrap' }, h('small', {}, 'Affects'), p.affectsText ? h('span', { class: 'muted' }, p.affectsText) : null,
      ...p.affects.map((a) => h('button', { class: 'text-btn', onClick: () => select({ kind: 'node', id: a.id, label: a.label }) }, a.label))) : null,
    h('div', { class: 'row wrap' }, h('small', {}, 'Must not pass as current'), h('span', { class: 'muted' }, p.mustNotPassAsCurrent)),
    h('div', { class: 'row' }, h('button', { class: 'btn small', onClick: () => kProcess.openPatch(p.id) }, 'Patch details')));
}

const changes = {
  async render(main) {
    const [c, allPatches] = await Promise.all([api(`/api/projects/${P()}/changes`), kData.getPatches(state.projectId).catch(() => null)]);
    // Confirmed patches only: a draft is not yet checked, a rejected one withdrew nothing (§3.3 cross-check).
    const patches = (allPatches ?? []).filter((p) => p.status === 'Confirmed');
    const target = state.routeRest ? decodeURIComponent(state.routeRest) : null;
    append(main, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Change log'), h('p', { class: 'sub' }, `Oldest to newest · ${c.changes.length} change record${c.changes.length === 1 ? '' : 's'}${patches.length ? ` · ${patches.length} semantic patch${patches.length === 1 ? '' : 'es'}` : ''} · ${c.pending} pending change${c.pending === 1 ? '' : 's'} not yet organized`))));
    if (c.changes.length === 0 && patches.length === 0) { append(main, emptyState('No change history has been established for this project.', 'Change records are created when material shows a decision, replacement, deferral, abandonment or completion, with the evidence for it.')); return; }
    const event = (x) => h('div', { class: `tl-event${target === x.id || state.selection?.id === x.id ? ' sel' : ''}`, id: `chg-${x.id}` },
      h('time', {}, fmtTime(x.at), x.atSource === 'observed' ? h('span', { class: 'faint' }, ' (first observed; the material gives no time)') : null),
      h('div', {}, x.work ? h('span', { class: 'tag' }, x.work.kind) : [h('span', { class: 'tag' }, x.material), ' ', effectTag(x.effect)], ' ', x.by?.identity === 'Decision' ? h('span', { class: 'tag amber' }, 'Owner decision') : x.by?.author?.name ? h('span', { class: 'tag' }, x.by.author.name) : null),
      // A piece of work leads with what it was, and its net changes are listed under it (D56); each says what changed
      // and, where the material gave one, why. A record written before this keeps its single-change shape.
      x.work ? h('h3', {}, x.work.label, x.work.openEnded ? h('small', { class: 'faint' }, ' · still going when the round began') : null) : h('h3', {}, x.title),
      x.work ? null : h('p', { class: 'muted' }, x.summary),
      x.work && (x.items ?? []).length
        ? h('div', { class: 'stack' }, ...x.items.map((i) => h('div', { class: 'item' },
          h('div', {}, effectTag(i.effect), ' ', h('span', { class: 'tag' }, i.material), ' ', h('b', {}, i.title)),
          i.summary ? h('div', { class: 'muted' }, i.summary) : null,
          i.before || i.after ? h('div', { class: 'diff' }, h('div', { class: 'old' }, h('small', {}, 'Before'), h('del', {}, i.before || '—')), h('div', { class: 'new' }, h('small', {}, 'After'), i.after || '—')) : null,
          i.why ? h('div', { class: 'muted' }, h('small', {}, 'Why'), ' ', i.why) : null,
          i.affects?.length ? h('div', { class: 'row wrap' }, h('small', {}, 'Affects'), ...i.affects.map((id) => { const a = x.affectsLabels.find((y) => y.id === id) ?? { id, label: id, removed: false }; return h('button', { class: 'text-btn', onClick: () => select({ kind: 'node', id, label: a.label }) }, namedObject(a)); })) : null)))
        : null,
      !x.work && (x.before || x.after) ? h('div', { class: 'diff' }, h('div', { class: 'old' }, h('small', {}, 'Before'), h('del', {}, x.before || '—')), h('div', { class: 'new' }, h('small', {}, 'After'), x.after || '—')) : null,
      (x.notJudged ?? []).length ? h('div', { class: 'row wrap' }, h('small', {}, 'Recorded at the time, not judged'), ...x.notJudged.map((n) => { const a = x.notJudgedLabels?.find((y) => y.id === n.nodeId) ?? x.propagationLabels?.find((y) => y.id === n.nodeId) ?? { id: n.nodeId, label: n.nodeId }; return h('span', { class: 'muted', title: n.reason }, namedObject(a)); })) : null,
      x.affectsLabels.length ? h('div', { class: 'row wrap' }, h('small', {}, 'Affects'), ...x.affectsLabels.map((a) => h('button', { class: 'text-btn', onClick: () => select({ kind: 'node', id: a.id, label: a.label }) }, namedObject(a)))) : null,
      h('div', { class: 'row wrap' }, h('small', {}, 'Sources'), ...x.sources.map((s) => h('button', { class: 'text-btn', onClick: () => openSource(s.id) }, s.title))),
      h('div', { class: 'row wrap' }, h('small', {}, 'Propagation'), h('span', { class: 'muted' }, propagationText(x.propagationSummary)), x.propagation.length ? h('details', { class: 'fold' }, h('summary', {}, 'By state'), h('div', { class: 'content' }, ...['Updated', 'Still on old understanding', 'Reusable as is', 'Not yet checked'].map((st) => { const items = x.propagation.filter((p) => p.state === st); return items.length ? h('div', {}, h('b', {}, st), ...items.map((p) => h('div', { class: 'muted' }, namedObject(x.propagationLabels?.find((a) => a.id === p.nodeId) ?? x.affectsLabels.find((a) => a.id === p.nodeId) ?? { label: p.nodeId }), p.sourceOrReason ? ` — ${p.sourceOrReason}` : ''))) : null; }))) : null),
      h('div', { class: 'row' }, h('button', { class: 'btn small', onClick: () => showAffected(x) }, 'Show affected')));
    // Patches and change records on one timeline, oldest to newest by when each happened; a segment takes the patches
    // that happened from its first record up to the next segment's (the first segment also takes any before it).
    const ms = (at) => { const t = Date.parse(/^\d{4}-\d\d-\d\d$/.test(at) ? `${at}T00:00:00Z` : at); return Number.isNaN(t) ? 0 : t; };
    const merged = (records, ps) => [...records.map((x) => ({ at: ms(x.at), node: () => event(x) })), ...ps.map((p) => ({ at: ms(p.occurred.at), node: () => patchEvent(p, target) }))].sort((a, b) => a.at - b.at).map((r) => r.node());
    const segments = c.segments.length ? c.segments : [{ name: null, sourceId: null, changes: [] }];
    if (segments.length === 1 && segments[0].name === null) append(main, h('div', { class: 'timeline' }, ...merged(segments[0].changes, patches)));
    else {
      const starts = segments.map((s) => Math.min(...s.changes.map((x) => ms(x.at))));
      const patchesOf = (i) => patches.filter((p) => { const t = ms(p.occurred.at); return (i === 0 || t >= starts[i]) && (i === segments.length - 1 || t < starts[i + 1]); });
      segments.forEach((s, i) => {
        const mine = patchesOf(i);
        const open = i === segments.length - 1 || s.changes.some((x) => x.id === target) || mine.some((p) => p.id === target || p.number === target);
        append(main, h('details', { class: 'fold', open: open || null }, h('summary', {}, s.name ?? 'Before any named segment', h('small', {}, ` ${s.changes.length}${mine.length ? ` · ${mine.length} patch${mine.length === 1 ? '' : 'es'}` : ''}`), s.sourceId ? h('button', { class: 'text-btn', onClick: (e) => { e.preventDefault(); openSource(s.sourceId); } }, 'source') : null), h('div', { class: 'content' }, h('div', { class: 'timeline' }, ...merged(s.changes, mine)))));
      });
    }
    // A change record's id, or a patch's id or number (SP-n), scrolls to it.
    if (target) setTimeout(() => document.getElementById(`chg-${patches.find((p) => p.number === target)?.id ?? target}`)?.scrollIntoView({ block: 'center' }), 50);
  },
  /** A pick marks the record it names, if any; the log is not rebuilt under the popover. */
  onSelect(selection) {
    document.querySelectorAll('#main .tl-event').forEach((e) => e.classList.toggle('sel', Boolean(selection) && e.id === `chg-${selection.id}`));
  },
};

// ── Notes (§6.6) ─────────────────────────────────────────────────────────
const notes = {
  async render(main) {
    const n = await api(`/api/projects/${P()}/notes`);
    const f = state.filters.notes ?? (state.filters.notes = { ask: '', response: '', origin: '' });
    const latest = (x) => x.versions[x.versions.length - 1];
    const current = n.notes.filter((x) => x.status === 'Current').filter((x) => (!f.ask || latest(x).ask === f.ask) && (!f.response || x.ownerResponse === f.response) && (!f.origin || x.cameFrom?.kind === f.origin)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const history = n.notes.filter((x) => x.status !== 'Current');
    const mountLabel = (x) => x.mount.kind === 'project' ? 'Whole project' : `${x.mount.kind} · ${x.mount.ids.length} object${x.mount.ids.length === 1 ? '' : 's'}`;
    const card = (x) => { const v = latest(x); return h('button', { class: `note-card${state.selection?.id === x.id ? ' sel' : ''}`, 'data-note': x.id, onClick: () => select({ kind: 'note', id: x.id, label: v.title }) }, h('span', { class: 'row spread' }, h('b', {}, v.title), askTag(v.ask)), h('span', { class: 'preview' }, v.preview), h('span', { class: 'row wrap' }, originTag(x.cameFrom), h('small', {}, mountLabel(x)), h('small', {}, `updated ${fmtRel(x.updatedAt)}`), x.ownerResponse ? h('span', { class: 'tag blue' }, x.ownerResponse) : null, x.status !== 'Current' ? h('span', { class: 'tag' }, x.status) : null, v.version > 1 ? h('small', {}, `v${v.version}`) : null)); };
    append(main, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Notes log'), h('p', { class: 'sub' }, 'Every note the Keeper has written about this project and its parts, newest first; resolved and withdrawn ones are kept below. A note is never a decision; what it asks of you is marked.')),
      h('div', { class: 'row' }, h('select', { class: 'input', onChange: (e) => { f.ask = e.target.value; renderBody(); } }, h('option', { value: '' }, 'Ask: any'), ...['For your decision', 'Worth discussing', 'For information'].map((a) => h('option', { value: a, selected: f.ask === a }, a))), h('select', { class: 'input', onChange: (e) => { f.response = e.target.value; renderBody(); } }, h('option', { value: '' }, 'Your response: any'), ...['Discussed', 'Decided', 'Delegated', 'No action needed'].map((a) => h('option', { value: a, selected: f.response === a }, a))), h('select', { class: 'input', onChange: (e) => { f.origin = e.target.value; renderBody(); } }, h('option', { value: '' }, 'Came from: any'), ...NOTE_ORIGINS.map((a) => h('option', { value: a, selected: f.origin === a }, a))))));
    if (n.notes.length === 0) { append(main, emptyState(n.relookDone ? 'No note to show' : 'No notes yet — the first product re-look has not finished.', n.relookDone ? 'The Keeper found nothing worth a separate note; the project-level note is shown on the graph.' : 'Notes are written after the product re-look, from the product reference and the organized facts.')); return; }
    append(main, h('div', { class: 'stack' }, ...current.map(card)), current.length === 0 ? h('div', { class: 'faint' }, 'No current note matches the filter.') : null,
      history.length ? h('details', { class: 'fold' }, h('summary', {}, `Resolved and withdrawn (${history.length})`), h('div', { class: 'content stack' }, ...history.map(card))) : null);
    if (state.selection?.kind === 'note') document.querySelector(`#main .note-card[data-note="${CSS.escape(state.selection.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  },
  /** A pick marks the card; the log is not rebuilt, so it stays where it was scrolled and the popover stands beside the card. */
  onSelect(selection) {
    document.querySelectorAll('#main .note-card').forEach((c) => c.classList.toggle('sel', selection?.kind === 'note' && c.dataset.note === selection.id));
  },
};

// ── Authority, carry-out and claims (Spec §1.9, §2.2, §2.4, §6.4; CKC-09 AC-33) ──
// The server works out every word below (workbench-content.ts); these only draw it.
function authorityBlock(a) {
  const cls = a.layer === 'Decided without owner' ? 'tag red' : a.layer === 'Owner' ? 'tag amber' : 'tag';
  return h('div', { class: 'authority' }, h('h4', {}, 'Authority'),
    h('div', {}, h('span', { class: cls }, a.layer === 'Decided without owner' ? `⚑ ${a.label}` : a.label)),
    a.detail ? h('div', { class: a.inForce ? 'muted' : 'faint' }, a.detail) : null);
}
function carryOutBlock(c, go = { object: openObject }) {
  return h('div', { class: 'carry-out' }, h('h4', {}, 'Carry-out'),
    c.status ? h('div', {}, h('span', { class: `tag ${c.status === 'Carried out' ? 'green' : c.status === 'Partly carried out' ? 'amber' : ''}` }, c.status), c.at ? h('small', { class: 'faint' }, ` ${fmtTime(c.at)}`) : null) : null,
    c.remaining ? h('div', { class: 'muted' }, 'Still left: ', c.remaining) : null,
    c.work.length ? h('div', { class: 'row wrap' }, h('small', {}, 'Work that carries it out'), ...c.work.map((w) => h('button', { class: 'text-btn', title: 'Open this work', onClick: () => go.object({ kind: 'node', id: w.id, label: w.label }) }, namedObject(w), w.progress ? ` · ${w.progress}` : ''))) : null,
    c.evidence.length ? h('div', { class: 'row wrap' }, h('small', {}, 'Shown by'), ...c.evidence.map((e) => h('button', { class: 'text-btn', onClick: () => openSource(e.id) }, e.title))) : null);
}
/** A statement with who claimed it and when; an observation made in the code with where (Spec §2.4). */
function statementItem(s) {
  const typeCls = s.type === 'Observed' ? 'green' : s.type === 'Claimed' ? 'blue' : s.type === 'Open' ? 'amber' : 'purple';
  return h('li', {},
    h('span', { class: `tag ${typeCls}` }, s.type), ' ', s.text, ' ', ...s.sourceIds.map((sid) => h('button', { class: 'cite', onClick: () => openSource(sid) }, sid.slice(0, 10))),
    s.reportedBy ? h('div', { class: 'faint' }, s.reportedBy) : null,
    s.untrusted ? h('div', { class: 'faint' }, h('span', { class: 'tag amber' }, 'Untrusted'), ' ', s.untrusted.summary) : null,
    ...(s.code ?? []).map((c) => h('div', { class: 'faint' }, 'Observed in the code: ', h('button', { class: 'text-btn mono', onClick: () => openSource(c.id) }, c.label))));
}
/**
 * What was found when the material the claims rest on was checked, the code above all (Spec §2.4): shown once, on that
 * material, in the check's own words. A claim with no check here stays as it was reported.
 */
function checksBlock(checks) {
  if (!checks?.length) return null;
  const open = (id, isSource) => (isSource ? openSource(id) : openObject({ kind: 'node', id, label: id }));
  return h('div', {}, h('h4', {}, checks.some((x) => x.code) ? 'Checked against the code' : 'Contradictions'),
    ...checks.map((x) => h('div', {}, h('span', { class: 'tag red' }, x.code ? 'Differs from the code' : 'Contradicted'), ' ', h('button', { class: 'text-btn', title: x.on.label, onClick: () => openSource(x.on.id) }, x.on.title), ': ', x.claim, ' ', h('button', { class: 'text-btn mono', onClick: () => open(x.otherId, x.otherIsSource) }, x.otherLabel))));
}

// ── Fact record dialog (drill-down, §6.4) ────────────────────────────────
export async function openFact(id) {
  const f = await api(`/api/projects/${P()}/facts/${encodeURIComponent(id)}`);
  const stmt = statementItem;
  openDialog(f.title, [
    h('div', { class: 'row wrap' }, h('small', {}, `As of ${fmtTime(f.asOf)}`), f.pendingSourceIds.length ? h('span', { class: 'tag amber' }, 'Update pending') : null),
    h('h4', {}, 'About'), h('div', { class: 'row wrap' }, ...f.sources.map((s) => h('button', { class: 'text-btn', onClick: () => openSource(s.id) }, s.title))),
    h('h4', {}, 'Statements'), h('ul', { class: 'stmts' }, ...f.statements.map(stmt)),
    checksBlock(f.checks),
    f.decisions.length ? h('div', {}, h('h4', {}, 'Decisions'), h('ul', {}, ...f.decisions.map((d) => h('li', {}, d.by.identity === 'Decision' ? h('span', { class: 'tag amber' }, 'Owner') : h('span', { class: 'tag' }, d.by.author.name || 'agent'), ' ', d.text, d.documented ? '' : h('span', { class: 'tag' }, 'not in the project’s decision record'), ...d.sourceIds.map((sid) => h('button', { class: 'cite', onClick: () => openSource(sid) }, sid.slice(0, 10))))))) : null,
    f.changes.length ? h('div', {}, h('h4', {}, 'Changes reported'), h('ul', {}, ...f.changes.map((c) => h('li', {}, c.text)))) : null,
    f.openQuestions.length ? h('div', {}, h('h4', {}, 'Open questions'), h('ul', {}, ...f.openQuestions.map((q) => h('li', {}, q)))) : null,
    f.executionFacts.length ? h('div', {}, h('h4', {}, 'Execution and QC facts'), h('ul', { class: 'stmts' }, ...f.executionFacts.map(stmt))) : null,
    whyFold(f.trace),
  ]);
}
function whyFold(trace) {
  return h('details', { class: 'fold' }, h('summary', {}, 'Why the Keeper thinks so'), h('div', { class: 'content' }, trace?.length ? trace.map((t) => h('div', { class: 'muted' }, fmtTime(t.at), ' · ', t.summary, t.jobId ? h('button', { class: 'text-btn', onClick: () => openActivity() }, ' job') : null, t.basisSourceIds?.length ? h('span', {}, ' · ', ...t.basisSourceIds.slice(0, 6).map((sid) => h('button', { class: 'cite', onClick: () => openSource(sid) }, sid.slice(0, 10)))) : null)) : h('div', { class: 'faint' }, 'No trace recorded.')));
}

// ── Object details (§6.4): the popover beside the object, and the full details behind `Details` ─────────
/**
 * One description of an object's details, drawn in two places (D67). The popover beside the object takes the summary
 * — name and kind, one sentence, state and marks, the notes on it and on its path, the usual actions. `Details`
 * draws every part in the dialog. There is no second copy of the content: both are made from `detailParts`, so
 * whatever the old details column held is in one of the two, one press from the popover at most (CKC-09 AC-35; the
 * table is in subagent/eo2/details-mapping.md).
 */
const onGraphNow = () => state.view === 'graph' && state.graphMode !== 'list' && Boolean(graphCtl);
const NOT_ON_GRAPH = 'None of the affected objects is on the graph';
/** Take the owner to the object on the graph, with its popover beside it; for a note, to what it is mounted on. */
function showOnGraph(sel, ids = []) {
  closeStripSheet();
  const dialog = document.querySelector('#dialog');
  if (dialog?.open) dialog.close();
  const mark = () => {
    if (!ids.length || !graphCtl) return;
    const n = graphCtl.showAffected(ids);
    if (!n) toast(NOT_ON_GRAPH);
  };
  if (onGraphNow()) {
    // Mark after the selection, so picking the note does not clear the mark it just asked for.
    select(sel, { trigger: null, anchorIds: ids, reveal: true, keepMarks: true });
    mark();
    return;
  }
  state.selection = sel;
  state.graphMode = 'graph';
  state.pendingPopover = { anchorIds: ids };
  state.pendingShow = ids;
  state.pendingShowTell = ids.length > 0;
  if (state.view !== 'graph') navigate(state.projectId, 'graph'); else renderBody();
}
/** Bring some objects into view on the graph without picking any of them. */
function highlightOnGraph(ids) {
  closeStripSheet();
  if (onGraphNow()) { graphCtl.showAffected(ids); return; }
  state.graphMode = 'graph';
  state.pendingShow = ids;
  state.pendingShowTell = false;
  if (state.view !== 'graph') navigate(state.projectId, 'graph'); else renderBody();
}
/**
 * The objects a note hangs on, named from the graph. An id the picture does not have is left out — it is not shown
 * as the id itself. A note on the whole project hangs on nothing.
 */
function describedMount(mount) {
  if (!mount || mount.kind === 'project') return { kind: 'project', objects: [] };
  const nodes = graph._data?.nodes ?? [];
  const rels = graph._data?.relations ?? [];
  const objects = [];
  for (const id of mount.ids ?? []) {
    if (mount.kind === 'relation') {
      const r = rels.find((x) => x.id === id);
      if (!r) continue;
      const from = nodes.find((n) => n.id === r.from)?.label;
      const to = nodes.find((n) => n.id === r.to)?.label;
      objects.push({ id, kind: 'relation', label: `${r.type}: ${from ?? '…'} → ${to ?? '…'}` });
    } else {
      const n = nodes.find((x) => x.id === id);
      if (!n?.label) continue;
      objects.push({ id, kind: 'node', label: n.label });
    }
  }
  return { kind: mount.kind, objects };
}
/** `On` plus the names, as text, and `Show on graph` unless the note hangs on the whole project. */
function noteOnLine(n, self) {
  const mount = n.mount ?? { kind: 'project', ids: [] };
  if (mount.kind === 'project') return h('div', { class: 'row wrap on-line' }, h('small', {}, 'On'), h('span', { class: 'on-name' }, 'Whole project'));
  const names = describedMount(mount).objects.flatMap((o, i) => [i ? ', ' : null, h('span', { class: 'on-name' }, o.label)]);
  return h('div', { class: 'row wrap on-line' }, h('small', {}, 'On'), ...names,
    h('button', { class: 'btn small', title: 'Go to it on the graph', onClick: () => showOnGraph(self, [...(mount.ids ?? [])]) }, 'Show on graph'));
}
/** A link to an object: inside the dialog the reading goes on there; on the page the object is picked. */
function openObject(sel) {
  if (document.querySelector('#dialog')?.open) void details.full(sel);
  else select(sel);
}
/** A citation that names a source the project does not have says so instead of failing silently. */
const openCited = (id) => openSource(id).catch((e) => toast(`${id}: ${e.message}`));

// ── What an object still lacks, and how it follows the changes that reached it (Spec §2.10, §5.5, §6.4; QC AH #6) ──
// The server reads it from the object's latest judgement (graph-view.ts `propagationOf`), as the context pack does.
/** A change record, opened where it is read in full — its items, before and after, why: its record in the Change log. */
function changeLink(c, title, go) {
  return h('button', { class: 'text-btn', title: 'Open this change in the Change log', onClick: () => { go.leave?.(); closeStripSheet(); navigate(state.projectId, 'changes', encodeURIComponent(c.id)); } }, title);
}
/** One lacked item: what the object still has to follow, and the change it comes from — the item of that record, or the record. */
function lackLine(l, go) {
  const c = l.change;
  return h('div', { class: 'lack', dataset: { change: l.changeId, item: l.itemId } },
    l.what ? h('div', { class: 'lack-what' }, l.what) : h('div', { class: 'faint' }, 'What it lacks was not written down.'),
    h('div', { class: 'lack-from' }, h('small', { class: 'faint' }, 'From '),
      c ? [effectTag(l.item?.effect ?? c.effect), ' ', changeLink(c, l.item?.title ?? c.work ?? c.title, go), h('small', { class: 'faint' }, ` · ${l.item ? `${c.work ?? c.title} · ` : ''}${fmtTime(l.item?.at ?? c.at)}`)]
        : h('span', { class: 'faint' }, 'a change record no longer in the assets')));
}
/** The round that judged it, whose result opens from here (§6.9); and that it changed since, when it did (§5.5). */
function judgedLine(pv) {
  if (!pv.round) return null;
  const round = pv.round.ended
    ? h('button', { class: 'text-btn', title: 'Open this round’s result', onClick: () => openRound(pv.round.id, { name: pv.round.name }) }, pv.round.name)
    : `${pv.round.name} (still running)`;
  return h('div', { class: 'faint judged-in' }, 'Judged in ', round, pv.at ? ` · ${fmtRel(pv.at)}` : '',
    pv.movedSince ? ' · it has changed since: the next Follow up judges it again, with what it still lacks' : '');
}
/** The popover's block (§6.4): what the object still lacks, item by item, each with the change it comes from. */
function lacksBlock(pv, go) {
  if (!pv?.lacks?.length) return null;
  return h('div', { class: 'kp-block prop-lacks' }, h('h4', {}, `Still on old understanding (${pv.lacks.length})`), ...pv.lacks.map((l) => lackLine(l, go)), judgedLine(pv));
}
/**
 * The full details' part (§5.5): the state its latest round gave it — the round, when and why — what it still lacks, the
 * records that state covers, and the records that reached it since and wait for the next Follow up.
 */
function propagationBlock(pv, go) {
  // A record as the Change log heads it: a piece of work by its label, an older record by its title.
  const record = (c, extra = []) => h('div', { class: 'prop-record', dataset: { change: c.id } }, changeLink(c, c.work ?? c.title, go), h('small', { class: 'faint' }, ` · ${fmtTime(c.at)}`), ...extra);
  return h('div', { class: 'stack prop-detail' },
    h('div', { class: 'row wrap' }, propTag(pv.state), pv.round ? null : h('small', { class: 'faint' }, pv.at ? 'judged for each change, before Follow up rounds judged each object once' : 'no Follow up round has judged it yet')),
    judgedLine(pv),
    pv.reason ? h('p', { class: 'muted' }, pv.reason) : null,
    pv.lacks.length ? h('div', { class: 'prop-part prop-lacks' }, h('h4', {}, `Still lacks (${pv.lacks.length})`), ...pv.lacks.map((l) => lackLine(l, go))) : null,
    pv.covers.length ? h('div', { class: 'prop-part prop-covers' }, h('h4', {}, `Covers ${pv.covers.length} change record${pv.covers.length === 1 ? '' : 's'}`),
      ...pv.covers.map((x) => record(x.change, [h('small', { class: 'faint' }, ` · ${x.items} item${x.items === 1 ? '' : 's'} `), propTag(x.state), x.reason ? h('div', { class: 'muted' }, x.reason) : null]))) : null,
    pv.waiting.length ? h('div', { class: 'prop-part prop-waiting' }, h('h4', {}, `Waits for the next Follow up (${pv.waiting.length})`), ...pv.waiting.map((c) => record(c))) : null);
}
const foldKey = (d) => (d.querySelector(':scope > summary')?.textContent ?? '').replace(/\d+/g, '#');

// ── What an object is, first (owner 2026-09-30, of D1's popover: 「感觉写的很全来龙去脉的……但是他到底是什么，现在是不是
// current看不出来」): its validity as a clear tag — Current, Replaced by what, Proposed —, its summary, and where it sits
// (a module or a plan, product only, not placed yet), before any history. The places are the Graph's and the List's own
// (placement.js), read from the graph the view already holds.
let placeCache = { data: null, M: null, projectId: null };
async function placementNow() {
  let data = graph._data;
  if (!data) data = placeCache.projectId === state.projectId && placeCache.data ? placeCache.data : await api(`/api/projects/${P()}/graph`);
  if (placeCache.data !== data) placeCache = { data, M: placementOf(data, { showReplaced: true }), projectId: state.projectId };
  return placeCache.M;
}
const STATUS = {
  Current: ['green', 'Current', 'In force now'],
  Proposed: ['blue', 'Proposed', 'Proposed; not decided yet'],
  Unjudged: ['', 'Not yet judged', 'Whether it is still in force has not been judged yet'],
  Deferred: ['amber', 'Deferred', 'Put off; not in force now'],
  Replaced: ['red', 'Replaced', 'No longer in force: something later replaced it'],
  Abandoned: ['red', 'Abandoned', 'No longer in force: given up'],
  Removed: ['red', 'Removed', 'No longer in force: removed'],
};
/** Its validity, always said (Current too), with what replaced it as a link. */
function statusTag(n, M, go) {
  const [tone, text, why] = STATUS[n.validity] ?? ['', n.validity ?? 'Not yet judged', ''];
  const by = n.replacedBy && M ? replacementOf(M, n.replacedBy) : null;
  const byPart = n.replacedBy && n.validity !== 'Current'
    ? [' by ', by ? h('button', { class: 'text-btn', title: `Open ${by.label}`, onClick: (e) => { e.stopPropagation(); go.object(NODE_SEL(by)); } }, by.label) : h('b', {}, n.replacedBy)]
    : null;
  return h('span', { class: `tag status-tag ${tone}`, title: why }, text, byPart);
}
/** Where it sits, one line: the module(s) or the plan as links, or that it is on the product only or not placed yet. */
function placeLine(n, M, go) {
  const w = M ? whereItSits(M, n.id) : null;
  if (!w) return null;
  const name = (id) => M.byId.get(id)?.label ?? id;
  return h('div', { class: `place-line place-${w.kind}` },
    h('span', { class: 'place-lead' }, w.lead),
    ...w.ids.map((id) => [' ', h('button', { class: 'text-btn', title: 'Open it', onClick: (e) => { e.stopPropagation(); go.object({ kind: 'node', id, label: name(id) }); } }, name(id))]),
    w.note ? h('span', { class: 'faint' }, ` · ${w.note}`) : null);
}

const details = {
  async load(sel) {
    if (sel.kind === 'note') return api(`/api/projects/${P()}/notes/${encodeURIComponent(sel.id)}`);
    if (sel.kind === 'relation') return api(`/api/projects/${P()}/relations/${encodeURIComponent(sel.id)}`);
    const d = await api(`/api/projects/${P()}/nodes/${encodeURIComponent(sel.id)}`);
    // Increment K rides along (CKC-24): the lineage, the versions and what is open on the object; null when the
    // endpoints are not built yet, and the blocks simply do not appear then.
    d._k = await kProcess.detailsData(sel.id).catch(() => null);
    // Where it sits, from the same placement the Graph and the List draw.
    d._place = await placementNow().catch(() => null);
    return d;
  },

  /**
   * The parts of one object's details. `go` says what a press does where the parts are drawn: `go.note` opens a note
   * of this object, `go.object` another object, `go.redraw` draws this one again after the owner answered.
   */
  parts(sel, x, go) {
    // A session among the sources opens its draft beside the original (CKC-23 AC-18: 钻取一段会话时点得开).
    const draftOf = new Map();
    for (const r of x?._k?.sessions ?? []) if (r.id) for (const sid of r.sourceIds) draftOf.set(sid, r.id);
    const sourceList = (list) => list.length ? h('div', { class: 'stack' }, ...list.map((s) => h('div', {}, h('button', { class: 'text-btn', onClick: () => openSource(s.id) }, s.title),
      draftOf.has(s.id) ? [' ', h('button', { class: 'text-btn kd-src-draft', title: 'The draft of this session: the owner’s words verbatim, and what the agents said, as claims', onClick: () => openDraft(draftOf.get(s.id), kProcess.draftCtx()) }, 'Session draft')] : null,
      h('div', { class: 'faint mono' }, s.label), s.availability ? h('span', { class: 'tag amber' }, s.availability) : null))) : h('div', { class: 'faint' }, 'No source recorded.');
    const noteCards = (list, none) => list.length ? h('div', { class: 'stack' }, ...list.map((n) => h('button', { class: 'note-card', 'data-note': n.id, title: 'Open this note', onClick: () => go.note({ kind: 'note', id: n.id, label: n.title }) }, h('span', { class: 'row spread' }, h('b', {}, n.title), askTag(n.ask)), h('span', { class: 'preview' }, n.preview)))) : h('div', { class: 'faint' }, none);
    const ask = (context) => h('button', { class: 'btn small', onClick: () => { go.leave?.(); toggleKeeper(true, context); } }, 'Ask Keeper');
    const onGraph = (label, ids) => h('button', { class: 'btn small', title: 'Go to it on the graph', onClick: () => showOnGraph(label, ids) }, 'Show on graph');
    const section = (key, label, node, count = null) => (node ? { key, label, count, node } : null);

    if (sel.kind === 'note') {
      const n = x;
      const v = n.versions[n.versions.length - 1];
      const self = { kind: 'note', id: n.id, label: v.title };
      const text = (key, title, body) => section(key, title, body ? h('p', {}, body) : null);
      const respond = async (response) => { try { await api(`/api/projects/${P()}/notes/${encodeURIComponent(n.id)}/response`, { method: 'POST', body: { response } }); toast(`Recorded: ${response.toLowerCase()}`); await go.redraw(); } catch (e) { toast(e.message); } };
      const canConfirm = n.status === 'Current' && n.ownerResponse !== 'Decided' && n.id !== DEPTH_NOTE_ID;
      const confirm = async () => {
        try {
          const r = await api(`/api/projects/${P()}/notes/${encodeURIComponent(n.id)}/confirm`, { method: 'POST' });
          state.conversationId = r.conversationId;
          go.leave?.();
          toggleKeeper(true, self);
          toast('Sent to the Keeper');
        } catch (e) { toast(e.message); }
      };
      return {
        title: v.title, sub: `Keeper note · v${v.version} · ${fmtRel(v.at)}`, label: `Note: ${v.title}`,
        tags: h('div', { class: 'row wrap' }, askTag(v.ask), h('span', { class: 'tag' }, n.status), n.ownerResponse ? h('span', { class: 'tag blue' }, n.ownerResponse) : null),
        sentence: v.preview,
        notes: null,
        on: noteOnLine(n, self),
        // How it came about, and what it asks the owner to choose (Spec §4.1, §3.7): part of the note's own page.
        extras: [
          n.cameFrom?.kind ? h('div', { class: 'row wrap came-from' }, h('small', {}, 'Came from'), originTag(n.cameFrom), ...(n.cameFrom.changes ?? []).map((c) => h('button', { class: 'text-btn', title: 'Open this change in the Change log', onClick: () => { go.leave?.(); navigate(state.projectId, 'changes', encodeURIComponent(c.id)); } }, c.title))) : null,
          n.id === DEPTH_NOTE_ID ? h('div', { class: 'stack' }, h('div', { class: 'muted' }, 'The depth is chosen on the Takeover page of the Keeper view, before the takeover starts.'), h('div', {}, h('button', { class: 'btn small', onClick: () => navigate(state.projectId, 'keeper', 'takeover') }, 'Open the Takeover page'))) : null,
        ],
        actions: [
          h('button', { class: 'btn small', onClick: () => { go.leave?.(); toggleKeeper(true, self); } }, 'Discuss with Keeper'),
          canConfirm ? h('button', { class: 'btn small', title: 'Tell the Keeper you confirm this note; it records your confirmation', onClick: confirm }, 'Confirm') : null,
          n.status === 'Current' && n.ownerResponse !== 'No action needed' ? h('button', { class: 'btn small', title: 'Leaves Notes (attention); the note stays where it is', onClick: () => respond('No action needed') }, 'No action needed') : null,
          n.cameFrom?.kind === 'Change follow-up' && n.cameFrom.changes?.length ? h('button', { class: 'btn small', onClick: () => openWalkthrough(n.id) }, '▶ Walk through the change') : null,
        ],
        sections: [
          text('current-view', 'Current view', v.body.currentView), text('why-it-matters', 'Why it matters', v.body.whyItMatters),
          // A `For your decision` note's options, each with what follows from it (Spec §4.2; D105; CKC-08 AC-26).
          section('options', 'Options', v.body.options?.length ? h('ul', { class: 'note-options' }, ...v.body.options.map((o) => h('li', {}, h('b', {}, o.option), ' — ', o.then))) : null, v.body.options?.length ?? null),
          section('facts', 'Facts', v.body.facts?.length ? h('ul', {}, ...v.body.facts.map((f) => h('li', {}, f.inferred ? h('span', { class: 'tag purple' }, 'Inferred') : null, ' ', f.text, ' ', ...f.sourceIds.map((sid) => h('button', { class: 'cite', onClick: () => openSource(sid) }, sid.slice(0, 10)))))) : null, v.body.facts?.length ?? null),
          text('other-explanations', 'Other explanations', v.body.otherExplanations), text('keep-or-adjust', 'Keep or adjust', v.body.keepAdjust), text('what-would-settle-it', 'What would settle it', v.body.whatWouldSettleIt),
          // What an absence claim rests on (CN, E152; Spec §2.12): where the Keeper looked for what came after, and up to when.
          section('what-was-read', 'What was read', n.looked ? h('div', { class: 'looked' },
            h('ul', {}, ...n.looked.where.map((w) => h('li', {}, w))),
            h('div', { class: 'muted' }, `Read up to ${n.looked.upTo}${n.looked.sessionsUpTo ? ` · sessions to ${n.looked.sessionsUpTo}` : ''}`),
            n.looked.behind ? h('div', {}, h('span', { class: 'tag amber', title: 'When the note was written, the ledger held later material than what was read' }, 'Does not reach the present'), ' ', h('span', { class: 'muted' }, n.looked.behind)) : null) : null, n.looked?.where.length ?? null),
          section('based-on', 'Based on', n.judgement ? h('details', { class: 'fold' }, h('summary', {}, 'Based on'), h('div', { class: 'content' }, h('div', { class: 'muted' }, `Judged ${fmtTime(n.judgement.at)} · scope ${n.judgement.scope.label}`), h('div', {}, `${n.judgement.inputs.referenceIds.length} reference items · ${n.judgement.inputs.threadIds.length} threads · ${n.judgement.inputs.areaIds.length} areas · ${n.judgement.inputs.relationIds.length} relations · ${n.judgement.inputs.keyEvidenceSourceIds.length} key sources${n.judgement.inputs.conflictingSourceIds.length ? ` · ${n.judgement.inputs.conflictingSourceIds.length} conflicting` : ''}${n.judgement.inputs.roundDocIds?.length ? ` · ${n.judgement.inputs.roundDocIds.length} round documents (the lanes’ reports, the adoption record, the main agent’s handover)` : ''}`), n.judgement.excluded.length ? h('div', { class: 'faint' }, `Excluded: ${n.judgement.excluded.join(', ')}`) : null, n.judgement.inputs.investigations.length ? h('div', {}, ...n.judgement.inputs.investigations.map((i) => h('div', { class: 'muted' }, 'Investigation: ', i.conclusion.slice(0, 200)))) : null)) : null),
          section('handed-over', 'Handed over', n.delegatedTo ? h('div', { class: 'muted' }, `Handed to ${n.delegatedTo.holder} as a modification request · ${n.delegatedTo.handledAt ? `handled ${fmtRel(n.delegatedTo.handledAt)}` : 'not yet handled (judged from later material)'}`) : null),
          section('course', 'Course', n.followUps?.length ? h('div', {}, ...n.followUps.map((f) => h('div', { class: 'muted' }, h('span', { class: 'tag' }, f.kind), ' ', fmtTime(f.at), ' · ', f.summary, f.jobId ? h('button', { class: 'text-btn', onClick: () => openActivity() }, ' job') : null))) : null, n.followUps?.length ?? null),
          section('discussion', 'Discussion', n.discussion.length ? h('div', { class: 'stack' }, ...n.discussion.map((d) => (d.role === 'owner' ? h('div', { class: 'msg user' }, d.text) : h('div', { class: 'msg keeper' }, fillMarkdown(h('div', { class: 'text md' }), d.text, { onCite: openCited }))))) : null, n.discussion.length || null),
          section('earlier-versions', 'Earlier versions', n.versions.length > 1 ? h('details', { class: 'fold' }, h('summary', {}, `Earlier versions (${n.versions.length - 1})`), h('div', { class: 'content' }, ...n.versions.slice(0, -1).reverse().map((e) => h('div', { class: 'muted' }, `v${e.version} · ${fmtTime(e.at)} · ${e.title} — ${e.reason}`)))) : null, n.versions.length - 1 || null),
        ].filter(Boolean),
      };
    }

    if (sel.kind === 'relation') {
      const r = x;
      const self = { kind: 'relation', id: r.id, label: `${r.type}: ${r.fromLabel} → ${r.toLabel}` };
      return {
        title: `${r.fromLabel} → ${r.toLabel}`, sub: `Relation · ${r.type}`, label: `Relation: ${r.fromLabel} → ${r.toLabel}`,
        tags: h('div', { class: 'row wrap' }, basisTag(r.basis), assessmentTag(r.assessment)),
        sentence: r.claim || null, sentenceNone: 'No claim recorded',
        notes: noteCards(r.notes, 'No note on this relation.'), noteCount: r.notes.length,
        extras: [],
        actions: [ask(sel), go.surface === 'popover' && onGraphNow() && graphCtl.rectOf(r.id) ? null : onGraph(self)],
        sections: [
          section('claim', 'Claim', h('p', {}, r.claim || h('span', { class: 'faint' }, 'No claim recorded'))),
          section('evidence', 'Evidence', h('div', { class: 'stack' }, r.evidence.factsSoFar ? h('p', {}, r.evidence.factsSoFar) : null, sourceList(r.evidenceSources), r.evidenceFacts.length ? h('div', { class: 'row wrap' }, ...r.evidenceFacts.map((f) => h('button', { class: 'text-btn', onClick: () => openFact(f.id) }, f.title))) : null), r.evidenceSources.length + r.evidenceFacts.length || null),
          section('assessment', 'Keeper assessment', h('div', {}, assessmentTag(r.assessment), r.assessedAt ? h('small', {}, ` ${fmtRel(r.assessedAt)}`) : h('small', {}, ' Only a product re-look or your correction changes it.'))),
          section('notes', 'Notes', noteCards(r.notes, 'No note on this relation.'), r.notes.length),
          section('why', 'Why the Keeper thinks so', whyFold(r.trace)),
        ].filter(Boolean),
      };
    }

    const d = x;
    const n = d.node;
    const self = NODE_SEL(n);
    const t = d.thread ?? null;
    const c = d.change ?? null;
    const isSource = n.category === 'Session' || n.category === 'Result' || n.category === 'Run';
    return {
      title: n.label, sub: `${n.category}${n.refKind === 'thread' ? ' · work thread' : ''}`, label: `${n.category}: ${n.label}`,
      // What it is, first: its validity always said (Current too, with what replaced it); its kind is the line under the
      // title, so it is not said again here.
      tags: h('div', { class: 'row wrap' }, statusTag(n, d._place, go), n.progress ? h('span', { class: 'tag' }, n.progress) : null, acceptanceTag(n), basisTag(n.basis), n.attribution ? h('span', { class: 'tag' }, n.attribution.identity, n.attribution.author?.name ? ` · ${n.attribution.author.name}` : n.attribution.author?.kind === 'owner' ? ' · owner' : '') : null, d.updatePending ? h('span', { class: 'tag amber' }, 'Update pending') : null, n.noEstablishedLink ? h('span', { class: 'tag red' }, 'No established link') : null, ...d.marks.map((m) => h('span', { class: 'tag red', title: m.clue }, `⚑ ${m.kind}`))),
      // Its own summary: a reference item's description, what a piece of work is doing, what a change was (Spec §6.4).
      sentence: d.reference?.text || d._place?.byId.get(n.id)?.summary || t?.doing || c?.summary || (isSource ? 'This node is a source; its original is under Sources.' : null),
      // Where it sits: its module or plan, product only, or not placed yet (the Graph's and the List's placement).
      place: placeLine(n, d._place, go),
      notes: noteCards(d.notes, 'No note on this object or on its path.'), noteCount: d.notes.length,
      // What it still lacks, item by item (§5.5; in the full details it is part of `Propagation`), then increment K (§6.4):
      // what is open on the object, `How it got here`, and the versions of a document-like object.
      extras: [go.surface === 'full' ? null : lacksBlock(d.propagation, go), ...kProcess.popoverBlocks(d._k, { surface: go.surface })].filter(Boolean),
      actions: [ask(sel), h('button', { class: 'btn small', onClick: () => { go.leave?.(); navigate(state.projectId, 'context', `sel/${sel.kind}/${encodeURIComponent(sel.id)}`); } }, 'Prepare context'), go.surface === 'popover' && onGraphNow() && graphCtl.rectOf(n.id) ? null : onGraph(self)],
      sections: [
        // Its summary stands at the top of the details (what it is, first); here what it rests on in words: the quote, its numbers.
        section('description', 'Description', d.reference ? h('div', {}, d.reference.quote ? h('blockquote', { class: 'quote' }, d.reference.quote) : null, d.reference.answers ? h('p', { class: 'faint' }, 'In answer to: “', d.reference.answers, '”') : null, d.reference.ids.length ? h('div', {}, ...d.reference.ids.map((i) => h('span', { class: 'tag' }, i))) : null, !d.reference.quote && !d.reference.ids.length ? h('p', { class: 'faint' }, 'No quote or number recorded; its summary is at the top.') : null) : null),
        section('authority', 'Authority', d.reference && d.authority ? authorityBlock(d.authority) : null),
        section('carry-out', 'Carry-out', d.reference && d.carryOut ? carryOutBlock(d.carryOut, go) : null, d.carryOut?.work.length || null),
        section('area', 'Area understanding', d.reference?.category === 'Area' ? h('div', {}, h('h4', {}, 'Area understanding'), d.area ? h('div', {}, h('p', {}, h('b', {}, 'Effect now: '), d.area.effectNow), h('p', {}, h('b', {}, 'Gaps: '), d.area.gaps), h('small', {}, `As of ${fmtTime(d.area.asOf)}`)) : h('div', { class: 'faint' }, 'Not organized yet.'), d.contributions.length ? h('div', { class: 'stack' }, h('h4', {}, 'Contributing work'), ...d.contributions.map((k) => h('div', {}, h('button', { class: 'text-btn', onClick: () => go.object({ kind: 'node', id: k.threadId, label: k.thread?.title ?? k.threadId }) }, k.thread?.title ?? k.threadId), ' ', basisTag(k.basis), h('div', { class: 'muted' }, k.claim)))) : null) : null, d.contributions?.length || null),
        section('work', 'Work thread', t ? h('div', { class: 'stack' }, h('div', {}, h('h4', {}, 'Doing'), h('p', {}, t.doing)), h('div', {}, h('h4', {}, 'Changed on the way'), h('p', {}, t.changed || '—')), h('div', {}, h('h4', {}, 'Actual results'), h('p', {}, t.results || '—')), h('div', {}, h('h4', {}, 'Unresolved'), h('p', {}, t.unresolved || '—'))) : null),
        section('serves', 'Claims to serve', t?.servesLabels.length ? h('div', {}, h('h4', {}, 'Claims to serve'), ...t.servesLabels.map((s) => h('div', {}, h('button', { class: 'text-btn', onClick: () => go.object({ kind: 'node', id: s.referenceId, label: s.name }) }, s.name), ' ', basisTag(s.basis), h('div', { class: 'muted' }, s.claim)))) : null, t?.servesLabels.length || null),
        section('execution', 'Execution and QC facts', t && (t.executionFacts.length || t.qcFacts.length) ? h('details', { class: 'fold' }, h('summary', {}, 'Execution and QC facts'), h('div', { class: 'content' }, h('ul', { class: 'stmts' }, ...[...t.executionFacts, ...t.qcFacts].map(statementItem)), checksBlock(t.checks))) : null, t ? t.executionFacts.length + t.qcFacts.length || null : null),
        section('fact-records', 'Fact records', t ? h('details', { class: 'fold' }, h('summary', {}, `Show fact records (${t.facts.length})`), h('div', { class: 'content stack' }, ...t.facts.map((f) => h('div', {}, h('button', { class: 'text-btn', onClick: () => openFact(f.id) }, f.title), h('small', {}, ` ${f.statements} statements${f.open ? ` · ${f.open} open` : ''}`))))) : null, t ? t.facts.length : null),
        section('sessions', 'Agent sessions and context delivery', t ? h('div', {}, h('small', { class: 'faint' }, `As of ${fmtTime(t.asOf)}`), h('div', { class: 'faint' }, 'Agent sessions on this work and context delivery: none connected yet.')) : null),
        section('change', 'Change', c ? h('div', {}, h('div', { class: 'row wrap' }, h('span', { class: 'tag' }, c.material), effectTag(c.effect), h('small', {}, fmtTime(c.at))), h('p', {}, c.summary), c.before || c.after ? h('div', { class: 'diff' }, h('div', { class: 'old' }, h('small', {}, 'Before'), h('del', {}, c.before || '—')), h('div', { class: 'new' }, h('small', {}, 'After'), c.after || '—')) : null,
          c.affectsLabels?.length ? h('div', { class: 'row wrap' }, h('small', {}, 'Affects'), ...c.affectsLabels.map((a) => h('button', { class: 'text-btn', onClick: () => go.object({ kind: 'node', id: a.id, label: a.label }) }, namedObject(a)))) : null,
          h('div', { class: 'row wrap' }, h('small', {}, 'Propagation'), h('span', { class: 'muted' }, propagationText(c.propagationSummary))), h('button', { class: 'btn small', onClick: () => { go.leave?.(); showAffected(c); } }, 'Show affected')) : null),
        section('sources', 'Sources', h('div', {}, isSource ? h('div', { class: 'faint' }, 'This node is a source; open it below to read the original.') : null, sourceList(d.sources)), d.sources.length),
        section('relations', 'Relations', d.relations.length ? h('div', { class: 'stack' }, ...d.relations.map((r) => h('div', {}, h('button', { class: 'text-btn', onClick: () => go.object({ kind: 'relation', id: r.id, label: `${r.type}: ${r.fromLabel} → ${r.toLabel}` }) }, r.from === n.id ? `${r.type} → ${r.toLabel}` : `${r.fromLabel} → ${r.type}`), ' ', assessmentTag(r.assessment), basisTag(r.basis)))) : h('div', { class: 'faint' }, n.noEstablishedLink ? 'No established link.' : 'No relation recorded.'), d.relations.length),
        section('notes', 'Notes', noteCards(d.notes, 'No note on this object or on its path.'), d.notes.length),
        section('changes', 'Changes', d.changes.length ? h('div', {}, ...d.changes.map((k) => h('div', {}, effectTag(k.effect), ' ', h('button', { class: 'text-btn', onClick: () => go.object({ kind: 'node', id: k.id, label: k.title, category: 'Change' }) }, k.title), h('small', {}, ` ${fmtTime(k.at)}`)))) : null, d.changes.length || null),
        section('propagation', 'Propagation', d.propagation ? propagationBlock(d.propagation, go) : null, d.propagation?.lacks.length || null),
        section('why', 'Why the Keeper thinks so', whyFold(d.trace)),
      ].filter(Boolean),
    };
  },

  /**
   * The popover's page for one object: the summary. `Details` opens the rest. A note of the object opens as another
   * page of the same popover, with a way back (Spec §6.4).
   */
  async popover(mount, sel, p, { back = null, hints = null } = {}) {
    const x = await details.load(sel);
    // What it hangs on, for the popover's place when the object itself is not on screen (app.js anchorFor).
    if (hints && hints.length === 0) hints.push(...(sel.kind === 'relation' ? [x.to, x.from] : sel.kind === 'note' ? x.mount?.ids ?? [] : []));
    const page = (target, from) => p.show({ key: `${target.kind}:${target.id}`, label: `Details: ${target.label ?? target.id}`, render: (m, pp) => details.popover(m, target, pp, { back: from }) });
    const go = {
      surface: 'popover',
      note: (note) => page(note, { sel, label: parts.title }),
      object: (other) => select(other),
      redraw: () => p.refresh({ force: true }),   // the rest of the page follows the asset event, in place
    };
    const parts = details.parts(sel, x, go);
    append(mount,
      h('div', { class: 'popover-head' },
        h('div', { class: 'grow' },
          back ? h('button', { class: 'text-btn popover-back', title: 'Back to the object this note is on', onClick: () => page(back.sel, null) }, `‹ ${back.label}`) : null,
          h('h3', { class: 'popover-title' }, parts.title), h('div', { class: 'popover-sub' }, parts.sub)),
        h('button', { class: 'popover-close', title: 'Close (Esc)', 'aria-label': 'Close', onClick: () => p.close('button') }, '×')),
      h('div', { class: 'popover-body' },
        parts.tags,
        parts.sentence ? h('p', { class: 'popover-sentence' }, parts.sentence) : parts.sentenceNone ? h('p', { class: 'popover-sentence faint' }, parts.sentenceNone) : null,
        parts.place ?? null,
        ...parts.extras,
        parts.on ?? null,
        parts.notes ? h('div', { class: 'popover-notes' }, h('h4', {}, `Notes${parts.noteCount ? ` (${parts.noteCount})` : ''}`), parts.notes) : null,
        h('div', { class: 'row wrap popover-actions' }, ...parts.actions)),
      h('div', { class: 'popover-foot' },
        h('button', { class: 'btn small primary', title: sel.kind === 'note' ? 'The whole note, in a larger window' : 'Everything about this object, in a larger window', onClick: () => details.full(sel) }, 'Details')));
  },

  /**
   * `Details`: every part, in the dialog (Spec §6.4; CKC-09 AC-12, AC-33, AC-35). A link to another object opens that
   * object's full details on top of this one — `Back` returns here as it was, `Show on graph` leaves for the graph —
   * so reading on never drops the owner out of the dialog and no link is a dead end. While it is open it follows the
   * assets like the popover does: fetched again, swapped only when it differs, scroll position and open folds kept.
   */
  async full(sel, { section = null } = {}) {
    let x;
    try { x = await details.load(sel); } catch (e) { toast(e.message); return; }
    const body = h('div', { class: 'full-details' });
    let sig = null;
    const go = {
      surface: 'full',
      leave: () => { const d = document.querySelector('#dialog'); if (d?.open) d.close(); },
      note: (note) => details.full(note),
      object: (other) => details.full(other),
      redraw: async () => { await draw(true); void popover.refresh(); },
    };
    const build = (data) => {
      const parts = details.parts(sel, data, go);
      return { parts, nodes: [
        h('div', { class: 'full-head' }, h('div', { class: 'muted' }, parts.sub), parts.tags),
        parts.sentence && sel.kind === 'note' ? h('p', { class: 'muted' }, parts.sentence) : null,
        parts.sentence && sel.kind === 'node' ? h('p', { class: 'full-sentence' }, parts.sentence) : null,
        parts.place ?? null,
        ...parts.extras,
        parts.on ?? null,
        h('div', { class: 'row wrap' }, ...parts.actions),
        ...parts.sections.map((s) => h('section', { class: 'full-section', 'data-section': s.key }, s.node.matches?.('details') || s.node.querySelector?.(':scope > h4') ? null : h('h4', {}, s.count !== null && s.count !== undefined && s.count !== 0 ? `${s.label} (${s.count})` : s.label), s.node)),
      ].filter(Boolean) };
    };
    const draw = async (force = false) => {
      if (!body.isConnected && sig !== null) return;
      let data = x;
      if (sig !== null) { try { data = await details.load(sel); } catch { return; } }
      const { nodes } = build(data);
      const next = visHtml(nodes.map((n) => n.outerHTML).join(''));
      if (!force && next === sig) return;
      const scroller = body.closest('.dialog-body');
      const top = scroller?.scrollTop ?? 0;
      const openFolds = new Set([...body.querySelectorAll('details[open]')].map(foldKey));
      sig = next;
      body.replaceChildren(...nodes);
      body.querySelectorAll('details').forEach((f) => { if (openFolds.has(foldKey(f))) f.open = true; });
      if (scroller) scroller.scrollTop = top;
    };
    const first = build(x);
    sig = visHtml(first.nodes.map((n) => n.outerHTML).join(''));
    body.append(...first.nodes);
    if (sel.kind === 'note') body.classList.add('note-body');
    const dialog = openDialog(first.parts.title, [body]);
    dialog.classList.add('details-dialog');
    dialog._details = { refresh: () => draw(false) };
    if (section) {
      const target = body.querySelector(`[data-section="${CSS.escape(section)}"]`);
      if (target) {
        target.querySelectorAll(':scope > details').forEach((f) => { f.open = true; });
        target.scrollIntoView({ block: 'start' });
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 1800);
      }
    }
  },
};

// ── Agent context (§7.8) ─────────────────────────────────────────────────
function mdToNodes(md) {
  const nodes = [];
  let list = null;
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^- /.test(line)) { if (!list) { list = h('ul', { class: 'ctx-list' }); nodes.push(list); } const item = h('li', {}); inline(item, line.slice(2)); list.append(item); continue; }
    if (/^ {2,6}- /.test(line)) { const sub = list?.lastElementChild; const item = h('li', { class: 'sub' }); inline(item, line.trim().slice(2)); if (sub) { let ul = sub.querySelector(':scope > ul'); if (!ul) { ul = h('ul'); sub.append(ul); } ul.append(item); } continue; }
    list = null;
    if (!line.trim()) continue;
    if (line.startsWith('# ')) nodes.push(h('h2', {}, line.slice(2)));
    else if (line.startsWith('## ')) nodes.push(h('h3', {}, line.slice(3)));
    else { const p = h('p', {}); inline(p, line); nodes.push(p); }
  }
  return nodes;
  function inline(el, text) {
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith('**')) el.append(h('b', {}, part.slice(2, -2)));
      else if (part.startsWith('`')) el.append(h('code', {}, part.slice(1, -1)));
      else el.append(part);
    }
  }
}

const context = {
  async render(main) {
    const opts = await api(`/api/projects/${P()}/context/options`);
    const f = state.filters.context ?? (state.filters.context = { scope: 'project', ids: '', purpose: 'Start', kind: 'Implement', recipient: 'Incoming agent', taskVersion: '' });
    const m = /^sel\/(\w+)\/(.+)$/.exec(state.routeRest || '');
    if (m) {
      const id = decodeURIComponent(m[2]);
      const opt = opts.forWork.find((o) => o.id === id);
      if (opt) { f.scope = opt.kind; f.ids = opt.id; f.purpose = opt.kind === 'work' ? 'Work' : 'Start'; }
      else { f.scope = 'path'; f.ids = id; f.purpose = 'Work'; }
      state.routeRest = '';
    }
    const sel = (label, key, options, render) => h('div', { class: 'field' }, h('label', {}, label), h('select', { class: 'input', onChange: (e) => { f[key] = e.target.value; if (key === 'work') { const o = opts.forWork.find((x) => `${x.kind}:${x.id}` === e.target.value); f.scope = o?.kind ?? 'project'; f.ids = o?.id ?? ''; if (o?.kind === 'work') f.purpose = 'Work'; } load(); } }, ...options.map((o) => render(o))));
    const workValue = `${f.scope}:${f.ids}`;
    const forWork = sel('For work', 'work', opts.forWork, (o) => h('option', { value: `${o.kind}:${o.id}`, selected: `${o.kind}:${o.id}` === workValue }, o.label + (o.progress ? ` · ${o.progress}` : '')));
    if (f.scope === 'path' && f.ids) forWork.querySelector('select').append(h('option', { value: `path:${f.ids}`, selected: true }, `Selected path (${f.ids.split(',').length})`));
    const purpose = sel('Purpose', 'purpose', opts.purposes, (o) => h('option', { value: o, selected: f.purpose === o }, o));
    const kind = sel('Kind', 'kind', opts.kinds, (o) => h('option', { value: o, selected: f.kind === o }, o));
    const recipient = sel('Recipient', 'recipient', opts.recipients, (o) => h('option', { value: o, selected: f.recipient === o }, o));
    const taskVersion = h('div', { class: 'field' }, h('label', {}, 'Task version (as your task states it)'), h('input', { class: 'input', value: f.taskVersion ?? '', placeholder: 'e.g. T-05 v2.0', onChange: (e) => { f.taskVersion = e.target.value; load(); } }));
    const preview = h('div', { class: 'ctx-preview' });
    const meta = h('div', { class: 'muted' });
    let pkg = null;
    const load = async () => {
      const params = new URLSearchParams({ scope: f.scope, ids: f.ids, purpose: f.purpose, kind: f.kind, recipient: f.recipient, since: state.lastVisit ?? '', taskVersion: f.taskVersion ?? '' });
      pkg = await api(`/api/projects/${P()}/context?${params}`);
      clear(preview); append(preview, ...mdToNodes(pkg.markdown));
      meta.textContent = `As of ${pkg.asOf ? fmtTime(pkg.asOf) : '—'}${pkg.commit ? ` @ ${pkg.commit.slice(0, 8)}` : ''} · Keeper ${pkg.keeperStatus} · ${pkg.citedSourceIds.length} sources cited · ${pkg.markdown.length} characters`;
    };
    const copy = h('button', { class: 'btn small primary', onClick: async () => { if (!pkg) return; try { await navigator.clipboard.writeText(pkg.markdown); toast('Context copied — nothing was installed or injected anywhere'); } catch { const ta = h('textarea', { class: 'input', style: { minHeight: '40vh' } }, pkg.markdown); openDialog('Copy the context', [h('p', { class: 'muted' }, 'The clipboard is unavailable; select the text below and copy it.'), ta]); ta.select(); } } }, 'Copy context');
    const download = h('button', { class: 'btn small', onClick: () => { if (!pkg) return; const a = h('a', { href: URL.createObjectURL(new Blob([pkg.markdown], { type: 'text/markdown' })), download: `context-${state.projectId}-${f.purpose.toLowerCase()}-${f.kind.toLowerCase().replace(/\s+/g, '-')}.md` }); document.body.append(a); a.click(); a.remove(); } }, 'Download .md');
    append(main,
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Agent context'), h('p', { class: 'sub' }, 'Prepare the start or work context for the next agent, then copy or download it. Roles are optional. Copying or downloading installs nothing and injects nothing into any host session; the same input always gives the same content.')), h('div', { class: 'row' }, copy, download)),
      h('div', { class: 'row wrap ctx-controls' }, forWork, purpose, kind, recipient, taskVersion),
      meta, preview);
    await load();
    context._load = load;
  },
  async onAssets() { if (context._load) await context._load(); },
};

const search = {
  go(x) {
    if (x.type === 'source') { openSource(x.id); return; }
    if (x.type === 'node') {
      const sel = { kind: 'node', id: x.id, label: x.label };
      if (OBSERVED.includes(x.detail) && state.graphMode !== 'list') state.resultFocus = x.id;
      if (state.view !== 'graph') { state.selection = sel; state.pendingPopover = {}; navigate(state.projectId, 'graph'); return; }
      if (state.resultFocus) { state.selection = sel; graph.focusResult(); select(sel, { trigger: null, origin: 'search-result' }); }
      else select(sel, { trigger: null, reveal: true });
      return;
    }
    if (x.type === 'change') { navigate(state.projectId, 'changes', encodeURIComponent(x.id)); return; }
    if (x.type === 'note') {
      const sel = { kind: 'note', id: x.id, label: x.label };
      if (state.view === 'notes') { select(sel, { trigger: null }); document.querySelector(`#main .note-card[data-note="${CSS.escape(x.id)}"]`)?.scrollIntoView({ block: 'nearest' }); }
      else { state.selection = sel; state.pendingPopover = {}; navigate(state.projectId, 'notes'); }
    }
  },
};

export const views = { graph, notes, changes, context, scope, keeper: keeperView, connections: keeperView, details, conversation, activity: activityView, search };
