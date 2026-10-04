// The fold rule of the process view (Spec §6.3, §2.12; CKC-24 AC-11, AC-12; D75; E152, E153), and what a folded work says.
//
// One rule for the List and the Graph: every work's process is folded until the owner opens it, and what the owner
// opened or folded is one choice, the same on both. The Graph's steps make the picture long (owner, 2026-10-01, E152:
// 「页面上work item相应的QC之类的目前都展开了，能收进去么。这个会把页面撑大」), and so do the List's (E153: 「List也默认收起，一样」).
// What needs the owner stays on a folded work: its open send-backs and lit breakpoints hang off it, and the count of
// what is open stands on it (`openMark`) — on the Graph on its top edge, in the List on its row.
//
// No DOM here: data in, words out, so the rule is tested with `node --test` (src/ui/k-fold.test.ts). `getProc` gives
// the process view as it stands (src/model/views-k.ts `ProcessView`), or null before it has loaded.

const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;

/** A fix or a check is a step of the work it serves (WorkProcessView.stepOf): not a unit of its own anywhere. */
export const stepOfIn = (proc, id) => proc?.works?.[id]?.stepOf ?? null;
/** A work whose process can be opened: more than one step, or a plan with an execution shape. */
export const expandableIn = (proc, id) => Boolean(proc && !stepOfIn(proc, id) && ((proc.works?.[id]?.steps.length ?? 0) > 1 || proc.plans?.[id]));

export function createFold(getProc) {
  const chosen = new Map();   // work or plan id → open (true) or folded (false), as the owner left it
  const expandable = (id) => expandableIn(getProc(), id);
  const ids = () => Object.keys(getProc()?.works ?? {}).filter(expandable);
  /** Whether a work's process is open, in the List and on the Graph alike: the owner's choice, else folded. */
  const isOpen = (id) => chosen.get(id) === true;
  return {
    has: isOpen,
    expandable,
    any: () => ids().length > 0,
    anyOpen: () => ids().some(isOpen),
    allExpanded: () => Boolean(getProc()) && ids().length > 0 && ids().every(isOpen),
    toggle(id) { chosen.set(id, !isOpen(id)); },
    /** A work opened or folded by hand, to the state given (a List row tells its own state when it toggles). */
    set(id, open) { chosen.set(id, Boolean(open)); },
    /** `Expand all` opens every work, `Fold all` folds every one, on both surfaces. */
    setAll(on) {
      if (!getProc()) return;
      if (on) { for (const id of ids()) chosen.set(id, true); } else { chosen.clear(); }
    },
    reset() { chosen.clear(); },
  };
}

/**
 * The second line of a work on the Graph. A work whose process can be opened says how much is folded under it and
 * whether anything in it is open — `5 steps · all closed`, `7 steps · ⚠ 2 open` — then its latest check and its
 * execution (its progress is on the line above). A work with one step or none keeps its four things (§2.12). Null for a
 * fix or a check, which folds under the work it serves.
 */
export function foldLine(proc, id) {
  const w = proc?.works?.[id];
  if (!w || w.stepOf) return null;
  const four = w.four;
  const open = four.open.findings + four.open.sendBacks + four.open.breakpoints;
  const check = four.check && four.check !== 'Not checked' ? four.check.verdict : four.check === 'Not checked' ? 'Not checked' : null;
  const execution = four.execution !== four.progress ? four.execution : null;
  if (expandableIn(proc, id)) {
    const shape = proc.plans?.[id];
    const size = w.steps.length ? plural(w.steps.length, 'step') : shape ? `${shape.batches.length} batch${shape.batches.length === 1 ? '' : 'es'}` : null;
    return [size, open ? `⚠ ${open} open` : 'all closed', check, execution].filter(Boolean).join(' · ');
  }
  return [four.progress, execution, check, open ? `⚠ ${open} open` : null].filter(Boolean).join(' · ');
}

const openText = (sum) => [sum.sendBacks ? `${plural(sum.sendBacks, 'send-back')} open` : null, sum.breakpoints ? `${plural(sum.breakpoints, 'breakpoint')} lit` : null, sum.findings ? `${plural(sum.findings, 'finding')} still open` : null].filter(Boolean).join(' · ');
/** What a work has open — its own and that of the fixes and checks folded under it — added onto `sum`. */
function addOpenOf(proc, id, sum) {
  const w = proc?.works?.[id];
  if (!w || w.stepOf) return;
  for (const c of [w, ...Object.values(proc.works).filter((x) => x.stepOf === id)]) { sum.sendBacks += c.four.open.sendBacks; sum.breakpoints += c.four.open.breakpoints; sum.findings += c.four.open.findings; }
}

/**
 * What is open on a work, for the count on it, folded or not (D75; E152, E153) — on the Graph on its top edge, in the
 * List on its row: its open send-backs, its lit breakpoints, its findings still open — its own and those of the fixes
 * and checks folded under it. `{ count, text }`, or null when nothing is open.
 */
export function openMark(proc, id) {
  const sum = { sendBacks: 0, breakpoints: 0, findings: 0 };
  addOpenOf(proc, id, sum);
  const count = sum.sendBacks + sum.breakpoints + sum.findings;
  return count ? { count, text: openText(sum) } : null;
}

/**
 * What is still open inside a folded block of the List, for its head (D75 「折起来也亮着」; Spec §6.3 List, CKC-09
 * AC-15; E153): over the work the block draws (`works` — each as `openMark` counts it) and on the other objects it
 * holds (`objects` — a requirement, a decision, the area itself: the open send-backs and lit breakpoints hanging on
 * them). An id named twice counts once. `{ count, text }`, or null when nothing inside is open.
 */
export function openInside(proc, { works = [], objects = [] } = {}) {
  if (!proc) return null;
  const sum = { sendBacks: 0, breakpoints: 0, findings: 0 };
  const seen = new Set();
  for (const id of works) { if (seen.has(id)) continue; seen.add(id); addOpenOf(proc, id, sum); }
  // A fix or a check folded under a work the block draws is counted with that work.
  const under = new Set(Object.entries(proc.works ?? {}).filter(([, w]) => w.stepOf && seen.has(w.stepOf)).map(([id]) => id));
  for (const id of objects) {
    if (seen.has(id) || under.has(id)) continue;
    seen.add(id);
    if (proc.works?.[id]) continue;   // a work the block does not draw as a row is not counted through its objects
    sum.sendBacks += (proc.sendBacks ?? []).filter((x) => x.targetId === id && x.lit && x.stage !== 'Closed').length;
    sum.breakpoints += (proc.breakpoints ?? []).filter((x) => x.targetId === id && x.lit).length;
  }
  const count = sum.sendBacks + sum.breakpoints + sum.findings;
  return count ? { count, text: openText(sum) } : null;
}
