// What the Project graph's control row says (Spec §6.1, §6.3 "控件放在哪" and "可读性自检 · 在哪里说"; CKC-09 AC-37): which
// filters are in force and what the `Filter` button therefore reads, and the number on the readability mark with the
// words of its hover. No DOM here: data in, words and numbers out, so the rules are tested with `node --test`
// (src/ui/graph-tools.test.ts).

/**
 * The filters, in the order the Filter panel lists them. A filter is a choice that can take objects off the picture.
 * What only changes how the picture is drawn — `Show replaced & deferred` (it adds objects), the period the stars mark,
 * how the other links are drawn (D54) — sits in the same panel or on the graph's corner but is not a filter, is not
 * counted on the button and is not touched by `Clear filters`.
 */
export const FILTERS = Object.freeze([
  { key: 'category', label: 'Category' }, { key: 'validity', label: 'Validity' }, { key: 'progress', label: 'Progress' },
  { key: 'acceptance', label: 'Acceptance' }, { key: 'assessment', label: 'Assessment' },
  { key: 'withNotes', label: 'With notes', tick: true }, { key: 'recent', label: '★ only', tick: true },
  // The objects an attention note hangs on, marked ❓ (Spec §6.2, D100): what the drawer's ❓ count turns on. The ids are
  // the page's (`attentionIds`, from the overview), so this filter is a tick like the two before it.
  { key: 'attention', label: '❓ Waiting on you', tick: true },
]);

/** The filters in force: `{ key, label, value }` each, a tick's value being `on`. */
export function activeFilters(filters) {
  const f = filters ?? {};
  return FILTERS.filter((x) => (x.tick ? f[x.key] === true : Boolean(f[x.key]))).map((x) => ({ key: x.key, label: x.label, value: x.tick ? 'on' : String(f[x.key]) }));
}

/** What the button reads: `Filter`, or `Filter · 2` while two filters are in force. */
export const filterLabel = (n) => (n > 0 ? `Filter · ${n}` : 'Filter');

/** Put every filter out of force, in place (the graph keeps a reference to the same object); returns it. */
export function clearFilters(filters) {
  for (const x of FILTERS) filters[x.key] = x.tick ? false : '';
  return filters;
}

// ── The readability mark (D46) ───────────────────────────────────────────
export const READ_KIND = Object.freeze({ overlap: 'On top of each other', behind: 'Lines behind objects', size: 'Too big to read at once', bundle: 'Bunched lines' });

/**
 * How many places one kind of problem makes hard to read. A place is something the owner can point at: a pair of
 * objects on top of each other, a line that runs behind an object, an object on which twenty or more lines meet — and
 * the picture itself, once, when it cannot be read at one size that fits the window.
 */
export function readabilityPlaces(issue) {
  if (issue.kind === 'overlap') return issue.pairs?.length ?? issue.count ?? 0;
  if (issue.kind === 'size') return 1;
  return issue.count ?? 0;
}

/**
 * The mark in the control row: `◐ n`, n being the places that are hard to read, added up over the kinds of problem.
 * At 0 it stays, quietly. The hover names each kind found with its places; the panel behind the mark has the objects
 * and the ways out. `report` is graph.js readabilityReport's, or null before the first check.
 */
export function readabilityMark(report) {
  const kinds = (report?.issues ?? []).map((i) => ({ kind: i.kind, label: READ_KIND[i.kind] ?? i.kind, places: readabilityPlaces(i) })).filter((k) => k.places > 0);
  const count = kinds.reduce((n, k) => n + k.places, 0);
  const title = count === 0
    ? 'Readability check: nothing in this picture is hard to read'
    : `Hard to read in ${count} place${count === 1 ? '' : 's'}: ${kinds.map((k) => (k.kind === 'size' ? k.label : `${k.label} ${k.places}`)).join(' · ')}. Nothing is hidden to tidy it; open for the objects and what you can do.`;
  return { count, text: `◐ ${count}`, title, kinds };
}
