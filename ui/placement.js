// Where every drawn object sits on the story map (D100; Spec §1.4 "落位", §6.3 "默认可见"; CKC-09 AC-2, AC-15). One
// model for the Graph and the List, so the two cannot disagree (as observedCells does for the folders, D55). Nothing
// here is a new store: the places are read off the relations the Keeper already writes — a work item's `serves` to a
// Plan and to an Area (or to what refines one: the node's `areaId`), a decision's or a requirement's `refines` to the
// Areas and Plans it acts on — and off the earlier generations the Keeper recorded. Placement quality is the Keeper's
// (CKC-23 AC-23); this draws whatever placement exists and counts what is not placed yet where it would sit.
//
// No DOM here: data in, places out, so the rules are tested with `node --test` (src/ui/placement.test.ts).

export const HIDDEN_VALIDITY = new Set(['Replaced', 'Deferred', 'Abandoned']);
export const INTENT_KINDS = ['Requirement', 'Design', 'Decision'];
const INTENT = new Set(INTENT_KINDS);
const RESULT = new Set(['Result', 'Review', 'Test', 'Session', 'Run']);
/** What a work item can implement: a requirement, a design, a contract (itself a work item). */
const CONTRACT = new Set(['Requirement', 'Design', 'Work item']);
/** The band of work in no plan (Spec §6.3 `Not in a plan`). */
export const NO_PLAN = 'none';
/** A band's cell: the band (a plan id, a generation id or NO_PLAN) and the column (an area id, or '' for no area). */
export const cellKey = (band, area) => `${band}|${area ?? ''}`;
const byName = (a, b) => String(a.label ?? '').localeCompare(String(b.label ?? ''), undefined, { numeric: true });
const isStruck = (n) => n?.validity === 'Replaced' || n?.validity === 'Abandoned' || n?.validity === 'Deferred';

/**
 * The places of a project's objects. `data` is the graph payload (nodes, relations and, when the Keeper recorded them,
 * generations); `showReplaced` draws replaced and deferred objects too (Spec §6.3 `Show replaced & deferred`).
 *
 * Returns:
 *   areas, plans         the columns (areas by name, a cross-cutting foundation after every module: D101, Spec §6.3)
 *                        and the current plans' bands (in the project's own order: the order
 *                        the plans are listed in, which is the order its plan documents give them)
 *   generations          the earlier generations, each with its items' destinations (Spec §2.12, D100: where its work
 *                        went — carried on, moved into the current plan, dropped by which decision — never "abandoned")
 *   bands                every band top to bottom: the generations, the current plans, `Not in a plan`
 *   place                object id → { zone, band?, area?, areas?, by?, ring?, gen?, whole? }: a work item's `area` is the
 *                        one it is drawn solid in, `areas` every area it serves (that one first), `by` the rule that chose
 *                        it; `whole` the Keeper's reason when it serves its whole plan and no single area (CN)
 *   cells                cellKey → work item ids, in the band's cell: a work item serving several areas is in each
 *                        area's cell of its band, solid in its own and a dashed copy in the others (isCopyIn)
 *   areaWork             area id → { total, shared, main }: the work in its column, how many shared, how many of those main here
 *   intent               area id → the requirements, designs and decisions folded at the column's top
 *   ring                 { multi, whole, product, none } → ids: the cross-cutting ring (Spec §6.3: under the area row,
 *                        above every band) — reaching several areas; on the whole product, with the Keeper's written
 *                        reason (`wholeProductWhy`: placed, CM); only on the product without one (not placed, §1.4);
 *                        on nothing yet
 *   exec                 plan id → the execution decisions placed on that plan (they refine the Plan)
 *   unplaced             the counts of what is not placed yet, by kind and where it would sit
 */
export function placementOf(data, { showReplaced = false } = {}) {
  const nodes = data?.nodes ?? [];
  const relations = data?.relations ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const vis = (n) => Boolean(n) && (!HIDDEN_VALIDITY.has(n.validity) || showReplaced || n.recentChange);
  // A cross-cutting foundation (D101; Spec §1.4, §6.3) is a column like any other, after every module's: it is the base
  // the modules share, not a module users face. Modules by name, then the foundations by name.
  const areas = nodes.filter((n) => n.category === 'Area' && vis(n)).sort((a, b) => (a.foundation ? 1 : 0) - (b.foundation ? 1 : 0) || byName(a, b));
  const areaIds = new Set(areas.map((a) => a.id));
  const out = new Map();
  for (const r of relations) { if (!out.has(r.from)) out.set(r.from, []); out.get(r.from).push(r); }
  const targets = (id, type, pred) => (out.get(id) ?? []).filter((r) => r.type === type).map((r) => byId.get(r.to)).filter((t) => t && (!pred || pred(t)));

  // Earlier generations (Spec §2.12): their plans and work items, as the Keeper recorded them.
  const gens = [...(data?.generations ?? [])].sort((a, b) => String(a.ended?.at ?? '').localeCompare(String(b.ended?.at ?? '')));
  // CZ: an item a generation lists that was carried on under the same number (`carriedIds`, from the server) is current
  // work: it stands in its current plan, never in the generation's band; the generation lists it as "carried on".
  const carriedOn = new Set(gens.flatMap((g) => g.carriedIds ?? []));
  const genOfPlan = new Map(), genOfWork = new Map();
  for (const g of gens) { for (const p of g.planIds ?? []) genOfPlan.set(p, g.id); for (const w of g.workIds ?? []) if (!carriedOn.has(w)) genOfWork.set(w, g.id); }
  // A current plan: not an earlier generation's, and not itself replaced or abandoned (then it is history, drawn in its
  // generation's band or, with no generation recorded, not as a band of its own).
  const plans = nodes.filter((n) => n.category === 'Plan' && !genOfPlan.has(n.id) && vis(n) && !(n.validity === 'Replaced' || n.validity === 'Abandoned'));
  const planIds = new Set(plans.map((p) => p.id));

  /** The area an object leads to: itself when it is one, else the area the server derived for it (`areaId`). */
  const areaOfTarget = (t) => (t.category === 'Area' ? (areaIds.has(t.id) ? t.id : null) : areaIds.has(t.areaId) ? t.areaId : null);
  const distinct = (list) => [...new Set(list.filter(Boolean))];
  /** What a work item serves, in the order the Keeper wrote it (`servesOrder`, graph-view.ts), else the relations'. */
  const servedInOrder = (n) => {
    const rels = (out.get(n.id) ?? []).filter((r) => r.type === 'serves');
    const order = Array.isArray(n.servesOrder) ? new Map(n.servesOrder.map((id, i) => [id, i])) : null;
    const at = (r) => order?.get(r.to) ?? Number.MAX_SAFE_INTEGER;
    return (order ? [...rels].sort((a, b) => at(a) - at(b)) : rels).map((r) => byId.get(r.to)).filter(Boolean);
  };
  /**
   * The areas a work item serves and the one it is drawn solid in (owner, 2026-09-30, verbatim: 「实线框的规则是。 a.这项
   * 工作实现的合同属于哪个模块，就放哪； b.没有合同的，看派工单或提示词写的是哪个模块； c.都没写，才用"写在最前的"。」;
   * Spec §1.4):
   *   (a) the module of the contract it implements — what it `implements`, or the requirement, design or contract work
   *       item it `serves`, the first of them that leads to an area. A contract of several modules gives the one this
   *       work's ticket or prompt names among them, else the one the contract lists first;
   *   (b) with no contract, the module its dispatch ticket or prompt names, which the Keeper writes as its first `serves`
   *       to an Area;
   *   (c) with neither, the first one listed.
   * `by` says which rule placed it: contract · named · first.
   */
  const workAreas = (n, seen = new Set()) => {
    seen.add(n.id);
    const served = servedInOrder(n);
    const servedAreas = distinct(served.map(areaOfTarget));
    const named = served.filter((t) => t.category === 'Area').map(areaOfTarget).find(Boolean) ?? null;
    // A contract's modules: a contract work item's own areas (its main one first); a requirement's or a design's area and
    // the other areas it refines.
    const modulesOf = (t) => (t.category === 'Work item' ? (seen.has(t.id) ? [] : workAreas(t, seen).areas) : distinct([areaOfTarget(t), ...targets(t.id, 'refines').map(areaOfTarget)]));
    const modules = [...targets(n.id, 'implements'), ...served.filter((t) => CONTRACT.has(t.category))].map(modulesOf).find((l) => l.length) ?? [];
    const contract = modules.length ? (named && modules.includes(named) ? named : modules[0]) : null;
    const first = servedAreas[0] ?? (areaIds.has(n.areaId) ? n.areaId : null);
    const area = contract ?? named ?? first;
    return { area, areas: distinct([area, ...servedAreas]), by: contract ? 'contract' : named ? 'named' : area ? 'first' : null };
  };

  const place = new Map();
  const cells = new Map();
  const intent = new Map(areas.map((a) => [a.id, []]));
  const ring = { multi: [], whole: [], product: [], none: [] };
  const exec = new Map(plans.map((p) => [p.id, []]));
  const genExec = new Map(gens.map((g) => [g.id, []]));
  const genPlans = new Map(gens.map((g) => [g.id, []]));
  const also = new Map();   // work id → { areas: [...], plans: [...] } where it is listed besides its own cell
  const addCell = (band, area, id) => { const k = cellKey(band, area); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(id); };

  for (const n of nodes) {
    // An earlier generation's plan is history in its band, whatever its validity; anything else hidden is not placed.
    if (!vis(n) && !(n.category === 'Plan' && genOfPlan.has(n.id))) continue;
    const c = n.category;
    if (c === "Owner's words" || n.group === "Owner's words") { place.set(n.id, { zone: 'words' }); continue; }
    if (c === 'Product' || c === 'Goal') { place.set(n.id, { zone: c === 'Product' ? 'product' : 'goal' }); continue; }
    if (c === 'Area') { if (areaIds.has(n.id)) place.set(n.id, { zone: 'area', area: n.id }); continue; }
    if (c === 'Plan') {
      if (genOfPlan.has(n.id)) { place.set(n.id, { zone: 'gen-plan', band: genOfPlan.get(n.id), gen: genOfPlan.get(n.id) }); genPlans.get(genOfPlan.get(n.id))?.push(n.id); }
      else if (planIds.has(n.id)) place.set(n.id, { zone: 'head', band: n.id });
      continue;
    }
    if (c === 'Work item') {
      if (!vis(n)) continue;
      const { area, areas: inAreas, by } = workAreas(n);
      const servedPlans = servedInOrder(n).filter((t) => t.category === 'Plan').map((t) => t.id);
      // "写了几个区域或几个计划的，落在写在最前的那一个" (Spec §1.4): the first current plan it serves.
      const plan = servedPlans.find((p) => planIds.has(p)) ?? null;
      // An item an earlier generation planned that moved into a current plan stands in that plan; the generation's band
      // counts it as "moved into" and does not hold it (otherwise the current plan's band would look empty).
      const gen = plan || carriedOn.has(n.id) ? null : genOfWork.get(n.id) ?? servedPlans.map((p) => genOfPlan.get(p)).find(Boolean) ?? null;
      const band = gen ?? plan ?? NO_PLAN;
      // Work for its whole plan — all of the plan's modules, no single one — with the Keeper's written reason (CN; E152;
      // Spec §1.4): placed, in its band's cross-cutting cell. It needs a plan, and counts only while it serves no area.
      const whole = !area && band !== NO_PLAN && n.wholePlanWhy ? String(n.wholePlanWhy) : null;
      // CQ (D104): a recorded reason the records lead nowhere ("written: no plan — why") places the item by that reason: it is
      // shown in the detail and not counted as unplaced.
      const noPlanWhy = band === NO_PLAN && n.noPlanWhy ? String(n.noPlanWhy) : null;
      const noAreaWhy = !area && !whole && n.noAreaWhy ? String(n.noAreaWhy) : null;
      // DB: the plans it serves that have no band of their own — not current (Proposed, Deferred, Replaced, Abandoned) or
      // held by an earlier generation while this item was carried on. It stands in `Not in a plan`, with those plans named.
      const plansNotDrawn = band === NO_PLAN ? distinct(servedPlans.filter((p) => !planIds.has(p))) : [];
      place.set(n.id, { zone: gen ? 'gen' : 'cell', band, area, areas: inAreas, by, gen, plan: gen ? null : plan, ...(whole ? { whole } : {}), ...(noPlanWhy ? { noPlanWhy } : {}), ...(noAreaWhy ? { noAreaWhy } : {}), ...(plansNotDrawn.length ? { plansNotDrawn } : {}) });
      // In every area it serves (owner, 2026-09-30: "appear in every column it serves"): its own cell first — the solid
      // one — then a dashed copy in each other area's cell of the same band.
      addCell(band, area, n.id);
      for (const a of inAreas) if (a !== area) addCell(band, a, n.id);
      const otherAreas = inAreas.filter((a) => a !== area);
      const otherPlans = servedPlans.filter((p) => p !== plan && planIds.has(p));
      if (otherAreas.length || otherPlans.length) also.set(n.id, { areas: otherAreas, plans: otherPlans });
      continue;
    }
    if (INTENT.has(c)) {
      // An execution decision (the log of how a plan was carried out) refines the Plan whose execution it records.
      const onPlans = targets(n.id, 'refines', (t) => t.category === 'Plan').map((t) => t.id);
      const execPlan = onPlans.find((p) => planIds.has(p)) ?? null;
      const execGen = onPlans.map((p) => genOfPlan.get(p)).find(Boolean) ?? null;
      if (execPlan) { place.set(n.id, { zone: 'exec', band: execPlan }); exec.get(execPlan).push(n.id); continue; }
      if (execGen) { place.set(n.id, { zone: 'exec', band: execGen, gen: execGen, plan: onPlans.find((p) => genOfPlan.get(p) === execGen) ?? null }); genExec.get(execGen).push(n.id); continue; }
      const refined = targets(n.id, 'refines');
      let reached = distinct(refined.map(areaOfTarget));
      if (!reached.length && areaIds.has(n.areaId)) reached = [n.areaId];
      if (reached.length === 1) { place.set(n.id, { zone: 'intent', area: reached[0] }); intent.get(reached[0]).push(n.id); continue; }
      if (reached.length > 1) { place.set(n.id, { zone: 'ring', ring: 'multi', areas: reached }); ring.multi.push(n.id); continue; }
      // Only on the product (or a goal) is not a place (Spec §1.4 "只挂在 Product 上、说不出落在哪里的，不算落位") — unless
      // the Keeper wrote why it concerns the whole product (`wholeProductWhy`, CM; Spec §1.4 "不针对任何一个区域的…也在圈里，
      // 写明为什么"): then it is placed, in the ring's `Whole product` group, with that reason.
      const onProduct = refined.some((t) => t.category === 'Product' || t.category === 'Goal');
      if (onProduct && n.wholeProductWhy) { place.set(n.id, { zone: 'ring', ring: 'whole', why: n.wholeProductWhy }); ring.whole.push(n.id); continue; }
      place.set(n.id, { zone: 'ring', ring: onProduct ? 'product' : 'none' });
      ring[onProduct ? 'product' : 'none'].push(n.id);
      continue;
    }
    if (RESULT.has(c)) place.set(n.id, { zone: 'result', work: n.parentId ?? null });
  }

  // ── Earlier generations: where each of their items went (Spec §2.12; D100) ──
  const inGen = (id) => genOfWork.has(id) || genOfPlan.has(id);
  const incoming = new Map();
  for (const r of relations) { if (!incoming.has(r.to)) incoming.set(r.to, []); incoming.get(r.to).push(r); }
  const CARRY = new Set(['replaces', 'depends on', 'carries out', 'refines', 'serves', 'implements']);
  // `replacedBy` is an id, or the successor's own number as the project writes it (e.g. "CKC-04"); a number is
  // matched against the labels of objects still in force (an item carried on from one generation into the current plan is
  // listed in that generation too, and still counts as where the earlier item went).
  const successorOf = (ref) => {
    if (!ref) return null;
    const direct = byId.get(ref);
    if (direct) return direct;
    const key = String(ref).trim();
    return nodes.find((m) => m.validity !== 'Replaced' && m.validity !== 'Abandoned' && (m.label === key || String(m.label ?? '').startsWith(`${key} `))) ?? null;
  };
  const generations = gens.map((g) => {
    const items = (g.workIds ?? []).map((id) => {
      const n = byId.get(id);
      if (!n) return { id, destination: { kind: 'unrecorded', done: false } };
      let destination;
      // Replaced by a current object (not a decision) is carried on in it: the later work was built on it (owner,
      // 2026-09-30: 「这两代不是完全废弃了」). Dropped is what a decision ended, or what was abandoned or deferred.
      const successor = n.validity === 'Replaced' ? successorOf(n.replacedBy) : null;
      // CZ: carried on under the same number — the current plan lists the same item (a deferred one among them).
      if (carriedOn.has(id) && n.validity !== 'Replaced' && n.validity !== 'Abandoned') destination = { kind: 'carried', to: id, toLabel: n.label, how: 'under the same number', same: true, deferred: n.validity === 'Deferred' };
      else if (successor && successor.id !== id && successor.validity !== 'Replaced' && successor.validity !== 'Abandoned' && successor.category !== 'Decision') destination = { kind: 'carried', to: successor.id, toLabel: successor.label, how: 'replaced by', deferred: successor.validity === 'Deferred' };
      else if (n.validity === 'Deferred') destination = { kind: 'deferred' };
      // Dropped needs something that ended it: abandoned, or replaced by a decision. Replaced with no successor recorded
      // says only that the organizing has not found where it went yet.
      else if (n.validity === 'Abandoned' || (n.validity === 'Replaced' && n.replacedBy)) destination = { kind: 'dropped', by: n.replacedBy ?? null, byLabel: byId.get(n.replacedBy)?.label ?? n.replacedBy ?? null, validity: n.validity };
      else if (isStruck(n)) destination = { kind: 'unrecorded', done: n.progress === 'Done' };
      else {
        const moved = targets(id, 'serves', (t) => t.category === 'Plan' && planIds.has(t.id))[0];
        const carrier = (incoming.get(id) ?? []).find((r) => CARRY.has(r.type) && byId.has(r.from) && !inGen(r.from) && !RESULT.has(byId.get(r.from).category));
        if (moved) destination = { kind: 'moved', to: moved.id, toLabel: moved.label };
        else if (carrier) destination = { kind: 'carried', to: carrier.from, toLabel: byId.get(carrier.from).label, how: carrier.type };
        else destination = { kind: 'unrecorded', done: n.progress === 'Done' };
      }
      return { id, destination };
    });
    const count = (k) => items.filter((i) => i.destination.kind === k).length;
    // In the band's one line a dropping decision is named by its number alone (its title is on the item itself).
    const shortName = (label) => { const t = String(label ?? '').trim(); const m = /^([A-Za-z]{1,6}[-‑]?\d+[\w.-]*)/.exec(t); return m ? m[1] : t.length > 28 ? `${t.slice(0, 27)}…` : t; };
    const droppedBy = distinct(items.filter((i) => i.destination.kind === 'dropped').map((i) => (i.destination.byLabel ? shortName(i.destination.byLabel) : i.destination.byLabel)));
    const done = items.filter((i) => byId.get(i.id)?.progress === 'Done').length;
    return {
      id: g.id, name: g.name, started: g.started ?? null, ended: g.ended ?? null, endedBy: g.endedBy ?? null,
      workIds: g.workIds ?? [], planIds: genPlans.get(g.id) ?? [], execIds: genExec.get(g.id) ?? [], items,
      // A generation whose items the organizing did not record is `Not organized` (owner, 2026-09-30); its name, end
      // and ending document still stand.
      organized: items.length > 0,
      destinations: { planned: items.length, done, carried: count('carried'), moved: count('moved'), deferred: count('deferred'), dropped: count('dropped'), droppedBy, unrecorded: count('unrecorded') },
    };
  });
  const destinationOf = new Map(generations.flatMap((g) => g.items.map((i) => [i.id, i.destination])));

  // ── What is not placed yet, counted where it would sit (Spec §1.4, §6.3) ──
  // DB: one definition — the lists (`unplacedOf`) say which objects, the counts here are their sizes, and the program's
  // counts for the Keeper (src/keeper/organize/round-open.ts) are read from the same lists.
  const kindCount = (ids) => { const o = {}; for (const id of ids) { const c = byId.get(id)?.category; if (c) o[c] = (o[c] ?? 0) + 1; } return o; };
  const lists = unplacedOf({ place, ring });
  const unplaced = {
    workNoPlan: lists.workNoPlan.length,
    workNoArea: lists.workNoArea.length,
    workWholePlan: lists.workWholePlan.length,
    workWrittenNoPlan: lists.workWrittenNoPlan.length,
    workWrittenNoArea: lists.workWrittenNoArea.length,
    workNeither: lists.workNeither.length,
    intentProductOnly: kindCount(lists.intentProductOnly),
    intentNowhere: kindCount(lists.intentNowhere),
    intent: lists.intentProductOnly.length + lists.intentNowhere.length,
  };
  const bands = [
    ...generations.map((g) => ({ key: g.id, kind: 'gen', gen: g })),
    ...plans.map((p) => ({ key: p.id, kind: 'plan', plan: p })),
    { key: NO_PLAN, kind: 'none' },
  ];
  const bandOrder = new Map(bands.map((b, i) => [b.key, i]));
  // Each area's current work, drawn or folded, for its own line (`AREA · 9 work items · 2 shared`): every work item in
  // its column under the current plans or in no plan, solid or dashed, and how many of them are shared with another
  // area (`main`: of those, the ones solid here). An earlier generation's items are counted on its band.
  const areaWork = new Map(areas.map((a) => [a.id, { total: 0, shared: 0, main: 0 }]));
  for (const p of place.values()) {
    if (p.zone !== 'cell') continue;
    for (const a of p.areas) { const c = areaWork.get(a); if (!c) continue; c.total++; if (p.areas.length > 1) { c.shared++; if (a === p.area) c.main++; } }
  }
  return { areas, plans, generations, bands, bandOrder, place, cells, intent, ring, exec, also, destinationOf, unplaced, areaWork, byId };
}

/**
 * What is not placed yet, as lists of ids (Spec §1.4, §6.3; DB) — the one definition of "unplaced" for the workbench and
 * for the program's counts:
 *   workNoPlan          current work in the `Not in a plan` band with no recorded reason: it serves no plan that has a band
 *                       (`plansNotDrawn` on its place names the plans it does serve — not current, or an earlier generation's)
 *   workNoArea          current work in no area, not whole-plan work, with no recorded reason
 *   workWholePlan       work for its whole plan, with the Keeper's reason: placed
 *   workWrittenNoPlan   work written as in no plan, with the recorded reason: placed by the reason
 *   workWrittenNoArea   work written as in no module, with the recorded reason
 *   workNeither         in no plan and in no area, with no reason for either
 *   intentProductOnly   requirements, designs and decisions only on the product (or a goal) with no written reason
 *   intentNowhere       requirements, designs and decisions on nothing
 * An earlier generation's items are counted on its band, not here. CQ (D104): a recorded reason places the work by that reason.
 */
export function unplacedOf(M) {
  const works = [...M.place.entries()].filter(([, p]) => p.zone === 'cell');
  const ids = (pred) => works.filter(([, p]) => pred(p)).map(([id]) => id);
  return {
    workNoPlan: ids((p) => p.band === NO_PLAN && !p.noPlanWhy),
    workNoArea: ids((p) => !p.area && !p.whole && !p.noAreaWhy),
    workWholePlan: ids((p) => Boolean(p.whole)),
    workWrittenNoPlan: ids((p) => p.band === NO_PLAN && Boolean(p.noPlanWhy)),
    workWrittenNoArea: ids((p) => !p.area && !p.whole && Boolean(p.noAreaWhy)),
    workNeither: ids((p) => p.band === NO_PLAN && !p.area && !p.noPlanWhy && !p.noAreaWhy),
    intentProductOnly: [...M.ring.product],
    intentNowhere: [...M.ring.none],
  };
}

/** Whether `id` in the column of `area` is a dashed copy: a work item standing there whose solid one is elsewhere. */
export const isCopyIn = (M, id, area) => { const p = M.place.get(id); return Boolean(p && area && p.area !== area && p.areas?.includes(area)); };
const shortArea = (M, id) => String(M.byId.get(id)?.label ?? id).split(' · ')[0];
/**
 * How a shared work item is marked where it stands (owner, 2026-09-30): in the column of `area`, solid (its main one,
 * saying where else it is) or dashed (a copy, saying where its main one is). Null for work that serves one area.
 * The Graph writes `text` on the object's second line, the List on the row's tag.
 */
export function sharedMark(M, id, area) {
  const p = M.place.get(id);
  if (!p || (p.areas?.length ?? 0) < 2 || !p.areas.includes(area)) return null;
  const others = p.areas.filter((a) => a !== p.area);
  if (area === p.area) return { copy: false, main: p.area, others, by: p.by, text: `also in ${others.map((a) => shortArea(M, a)).join(', ')}` };
  return { copy: true, main: p.area, others, by: p.by, text: `main in ${shortArea(M, p.area)}` };
}
/**
 * The work rows of an area's block in the List (`null`: the cross-cutting block's work of no area): each work item in
 * the area's cells under the current plans and in `Not in a plan` — an earlier generation's are in its band — with its
 * marking there (sharedMark): solid, dashed, or none for work that serves one area.
 */
export function listRowsOf(M, area) {
  const gens = new Set(M.generations.map((g) => g.id));
  const rows = [];
  for (const [key, ids] of M.cells) {
    const cut = key.lastIndexOf('|');
    if (key.slice(cut + 1) !== (area ?? '') || gens.has(key.slice(0, cut))) continue;
    for (const id of ids) rows.push({ id, copy: isCopyIn(M, id, area), mark: area ? sharedMark(M, id, area) : null, whole: M.place.get(id)?.whole ?? null });
  }
  return rows;
}
/** Why a shared work item's main one stands where it does (the owner's rule a, b, c), in words for its tooltip. */
export const MAIN_BY = {
  contract: 'the contract it implements belongs to this module',
  named: 'no contract; its dispatch ticket or prompt names this module (the first area the Keeper wrote)',
  first: 'no contract, and no ticket or prompt names a module: the first one listed',
};
/** The label a cross-cutting foundation's column head and List block head carry beside the project's name (D101). */
export const FOUNDATION_LABEL = 'Cross-cutting foundation';
/** The ring's group of items placed on the whole product, each with the Keeper's written reason (CM; Spec §1.4). */
export const WHOLE_LABEL = 'Whole product';
/** Work that serves its whole plan and no single module, with the Keeper's written reason (CN; Spec §1.4). */
export const WHOLE_PLAN_LABEL = 'Whole plan';
/** An area's count of work in words: `9 work items · 2 shared`. */
export function areaWorkLine(c) {
  const t = c?.total ?? 0;
  return `${t} work item${t === 1 ? '' : 's'}${c?.shared ? ` · ${c.shared} shared` : ''}`;
}

/** Whether a work item in this place is placed yet: a plan and an area (Spec §1.4; CKC-23 AC-23). */
// CQ (D104): a recorded reason ("written: no plan — why", "written: no module — why") places the work by that reason.
export const isUnplacedWork = (p) => Boolean(p) && (p.zone === 'cell' || p.zone === 'gen') && ((p.band === NO_PLAN && !p.noPlanWhy) || (!p.area && !p.whole && !p.noAreaWhy));

/** What a generation the organizing recorded no items for says in their place (owner, 2026-09-30: 「显示未整理」). */
export const NOT_ORGANIZED = 'Not organized';
/** A generation's destinations in one line (Spec §2.12): what it planned and where its work went; never "abandoned". */
export function destinationLine(d) {
  if (!d?.planned) return NOT_ORGANIZED;
  const bits = [`${d.planned} planned`, `${d.done} done`];
  if (d.carried) bits.push(`${d.carried} carried on`);
  if (d.moved) bits.push(`${d.moved} moved into the current plan`);
  if (d.deferred) bits.push(`${d.deferred} deferred`);
  if (d.dropped) bits.push(`${d.dropped} dropped${d.droppedBy.length ? ` by ${d.droppedBy.join(', ')}` : ''}`);
  if (d.unrecorded) bits.push(`${d.unrecorded} where it went not recorded yet`);
  return bits.join(' · ');
}
/** One item's destination in words, for the object's second line and the List row. */
export function destinationText(dest) {
  if (!dest) return '';
  if (dest.kind === 'moved') return `→ moved into ${dest.toLabel}`;
  if (dest.kind === 'carried') return dest.same ? `→ carried on under the same number${dest.deferred ? ' (deferred)' : ''}` : `→ carried on in ${dest.toLabel}${dest.deferred ? ' (deferred)' : ''}`;
  if (dest.kind === 'deferred') return 'deferred';
  if (dest.kind === 'dropped') return `dropped${dest.byLabel ? ` by ${dest.byLabel}` : ''}`;
  return dest.done ? 'done · where it went not recorded yet' : 'where it went not recorded yet';
}

/**
 * The notes on objects that still need the owner (Spec §2.7, §6.2; D100): each object — a node, or a relation — with
 * the count of its notes still in `Notes (attention)`; a note on a path counts on the path's top object (the server
 * says which: `noteAttention`). `count` sums the marks, `objects` the objects they hang on, `ids` their ids. The drawer's
 * count of notes (CF, strip-rows.js) follows the same rule from the overview (graph-view.ts `inAttention`).
 */
export function objectAttentionNotes(view) {
  const nodes = view?.nodes ?? [];
  const relations = view?.relations ?? [];
  const label = new Map(nodes.map((n) => [n.id, n.label]));
  const objects = [
    ...nodes.filter((n) => n.noteAttention > 0).map((n) => ({ id: n.id, kind: 'node', label: n.label, category: n.category, attention: n.noteAttention })),
    ...relations.filter((r) => r.noteAttention > 0).map((r) => ({ id: r.id, kind: 'relation', label: `${r.type}: ${label.get(r.from) ?? r.from} → ${label.get(r.to) ?? r.to}`, attention: r.noteAttention, ends: [r.from, r.to] })),
  ];
  return { count: objects.reduce((s, o) => s + o.attention, 0), objects, ids: objects.map((o) => o.id) };
}

/**
 * The object a `replacedBy` names: an id, or the successor's own number as the project writes it ("D60"), matched
 * against the labels of objects still in force — the rule the generation bands use (successorOf above).
 */
export function replacementOf(M, ref) {
  if (!ref) return null;
  const direct = M.byId.get(ref);
  if (direct) return direct;
  const key = String(ref).trim();
  for (const m of M.byId.values()) {
    if (m.validity === 'Replaced' || m.validity === 'Abandoned') continue;
    if (m.label === key || String(m.label ?? '').startsWith(`${key} `)) return m;
  }
  return null;
}

/**
 * Where an object sits, for the top of its popover (owner 2026-09-30, of a decision: 「他到底是什么，现在是不是current
 * 看不出来」): a requirement, design or decision on its module, on several, on a plan (an execution decision), only on
 * the product (not a place, Spec §1.4) or on nothing yet; a work item in its module and plan. `ids` are the objects it
 * sits on, `note` what is missing. Null for what has no place to state (the product, a goal, an area, a result).
 * Read from the same placement the Graph and the List draw, so the three cannot disagree.
 */
export function whereItSits(M, id) {
  const p = M.place.get(id);
  if (!p) return null;
  const genName = (g) => M.generations.find((x) => x.id === g)?.name ?? g;
  switch (p.zone) {
    case 'intent': return { kind: 'module', lead: 'On the module', ids: [p.area], note: null };
    case 'ring':
      if (p.ring === 'multi') return { kind: 'modules', lead: `On ${p.areas.length} modules`, ids: p.areas, note: 'cross-cutting' };
      if (p.ring === 'whole') return { kind: 'whole', lead: 'Whole product', ids: [], note: p.why };
      if (p.ring === 'product') return { kind: 'product', lead: 'Product only', ids: [], note: 'not placed on a module or plan yet' };
      return { kind: 'none', lead: 'Not placed yet', ids: [], note: 'on no module, plan or product' };
    case 'exec':
      return p.gen
        ? { kind: 'plan', lead: 'On a plan of an earlier generation', ids: p.plan ? [p.plan] : [], note: genName(p.gen) }
        : { kind: 'plan', lead: 'On the plan', ids: [p.band], note: 'an execution decision' };
    case 'cell': case 'gen': {
      if (p.whole) return { kind: 'work', lead: `${WHOLE_PLAN_LABEL} of`, ids: [p.plan].filter(Boolean), note: p.gen ? `${p.whole} · in the earlier generation ${genName(p.gen)}` : p.whole };
      // CQ (D104): a recorded reason reads "written: no plan — why" where "not in a plan yet" would stand.
      const missing = [
        !p.area ? (p.noAreaWhy ? `written: no module — ${p.noAreaWhy}` : 'no module yet') : null,
        !p.plan ? (p.gen ? `in the earlier generation ${genName(p.gen)}` : p.noPlanWhy ? `written: no plan — ${p.noPlanWhy}` : 'not in a plan yet') : null,
      ].filter(Boolean);
      return { kind: 'work', lead: 'In', ids: [p.area, p.plan].filter(Boolean), note: missing.join(' · ') || null };
    }
    default: return null;
  }
}
