/**
 * What a round has left open on the workbench (D99; Spec §2.12, §3.3; CKC-23 AC-21, AC-22), so the main agent can check
 * it has done the steps its skills give it rather than remember them:
 *   - breakpoint candidates with no result yet: not put out, not lit, no lane recorded where it looked
 *     (`pk_record_looked`), and no write of this round answers it (a link of the step it misses, a decision recorded as
 *     carried out, a superseded downstream item marked so) — each with the briefs of this round that name it;
 *   - work items in no plan, and work items in no module (Area);
 *   - decisions placed on nothing, and decisions placed only on the Product (or a Goal);
 *   - earlier generations with no planned item recorded;
 *   - (CJ, E150) what the program can count on the first D100 run's shortfalls: the numbers a current decision record,
 *     plan, task index or execution arrangement defines that no item carries and no account names (`entries`,
 *     entry-gate.ts); items named by their number alone where the defining line has a title; tickets with no ids, or
 *     with another object's number as their id; this round's links not confirmed yet; contracts still Planned although
 *     tickets implementing them are Done, with no reason stated; tickets that record no contract; decisions and
 *     boundaries placed only on the Product whose own entry names a contract, a Spec section, a module or an R-item
 *     ("traceable, placed on product"). Boundaries are counted like decisions.
 *   - (CM, E151) what the program can read off the project's own writing: the suspect links (their evidence failed the
 *     program's check as they were written; a lane-checked link counts like a confirmed one); the items of an earlier
 *     generation with no destination, and the candidate generations with no verdict (generation-check.ts); designs that
 *     refine three Areas or more, or sit nowhere; items that name an Area but sit elsewhere; and, for each decision placed
 *     only on the Product, where its own entry and the documents that cite it lead (placing.ts). `pk_round_state` gives a
 *     count per list and one list in full by its key (`OPEN_KEYS`).
 *   - (CZ) the numbers two items of one category carry (`duplicates`); and the entries count also the numbers of a family
 *     that one current document alone defines (entry-gate.ts).
 *   - (DB) what is not placed is the workbench's own count: the lists of work in no plan or module, of decisions and
 *     boundaries on nothing or only on the Product, and of requirements and designs likewise, are read from the story
 *     map's placement model (workbench-placement.ts; `ui/placement.js`), so the program and the workbench cannot disagree.
 *     A work item whose only plan has no band there (not current: Proposed, Replaced, an earlier generation's) is in no
 *     plan, with that plan named. On the DeepSeek run the program counted 0 while the workbench showed 2 + 8.
 * Seen on the first D99 deepening of ContextKeeper (2026-09-30): 55 candidates stayed with no result and no lane called
 * pk_record_looked; 44 work items had no plan and 43 no module; 192 decisions were placed on no module; the two earlier
 * generations had no items. `pk_round_state` lists these; `pk_stage` into the synthesis refuses a `Full` deepening while
 * candidates have no result (unless the main agent says why), and notes the unplaced counts without refusing on them —
 * some work really has no plan.
 */
import { linkHolds, type Breakpoint, type ClerkRound } from '../../model/k-types.ts';
import type { GraphRelation, ReferenceItem, WorkThread } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { isCandidate } from '../../process/breakpoints.ts';
import { CHECK_WORDS } from '../../process/units.ts';
import { Ledger } from '../../ledger/index.ts';
import { definitionsInText } from '../../ledger/numbering.ts';
import { isNumberShaped, numberOnlyRefusal, otherObjectOf, undefinedNumbers } from '../numbers-check.ts';
import { entryGaps, requiredEntries, type EntryGaps } from './entry-gate.ts';
import { isNumberOnly } from './entries.ts';
import { primaryIdentifier } from '../tools.ts';
import { entryNames, lineIndex, misplacedItems, reachOf, traceIndex, tracePlacement, wholePlanSuggestion, WHOLE_PLAN_MODULES } from './placing.ts';
import { candidateWorkLines, itemsWithoutDestination, openCandidates } from './generation-check.ts';
import { standingItem, standingNotes } from './standing-notes.ts';
import { planNotDrawnLine, unplacedIntent, workbenchUnplaced } from './workbench-placement.ts';
import { NO_AREAS, NO_CONTRACT_LAYER, NO_PLAN_LAYER, areasPresent, contractLayerPresent, inferThread, inferenceContext, inferredPlacementRows, planLayerPresent, programPlacementCounts, type InferredPlacementRow, type ProgramPlacementCounts } from './placement-inference.ts';

/** How many entries each list gives at most; its count is always the whole. */
export const OPEN_LIST_LIMIT = 200;

export interface OpenCandidate {
  readonly id: string;
  readonly kind: Breakpoint['kind'];
  /** The object it hangs on, by its number and name. */
  readonly target: string;
  readonly why: string;
  /** The briefs of this round that name it (by lane name): the lanes it was given to. Empty when no brief names it. */
  readonly briefs: readonly string[];
}

export interface OpenItem {
  readonly id: string;
  readonly name: string;
}

export interface OpenList<T> {
  readonly count: number;
  readonly items: readonly T[];
  /** CQ (D104): the defined zero when the project lacks the layer the list counts against — the sentence to print instead of a list. */
  readonly notApplicable?: string;
}

export interface RoundOpen {
  /** Candidates with no result: not answered by a write of this round, not looked for, not put out, not lit. */
  readonly candidates: OpenList<OpenCandidate>;
  readonly workItems: {
    /**
     * In force and in no plan, as the workbench places it (DB): it serves no plan that has a band there, and stands in no
     * earlier generation's band. `notCurrent` names the plans it does serve that have no band — not current (Proposed,
     * Deferred, Replaced, Abandoned), or held by an earlier generation. CN: `suggest` is the plan the decisions it carries
     * out, cites or is cited by lead to, with those decisions.
     */
    readonly noPlan: OpenList<OpenItem & { readonly suggest?: readonly string[]; readonly notCurrent?: readonly string[] }>;
    /**
     * In force and in no module: nothing it serves leads to an Area. CN: work recorded as serving its whole plan
     * (`wholePlanWhy`, in a plan) is placed and not listed; `suggest` says when a range the ticket writes spans three
     * modules or more — work for the whole plan.
     */
    readonly noModule: OpenList<OpenItem & { readonly suggest?: string }>;
    /** CN: work recorded as serving its whole plan and no single module, each with the Keeper's written reason. */
    readonly wholePlan: OpenList<OpenItem & { readonly why: string }>;
    /** CQ (D104): work written as in no plan, each with the recorded reason the program accepted (`noPlanWhy`); not counted in `noPlan`. */
    readonly noPlanWritten: OpenList<OpenItem & { readonly why: string }>;
    /** CQ (D104): work written as in no module, each with its recorded reason (`noAreaWhy`); not counted in `noModule`. */
    readonly noAreaWritten: OpenList<OpenItem & { readonly why: string }>;
  };
  /**
   * CQ (D104), CS: the placements the program wrote from the records, basis Inferred, that still stand and have no result
   * yet — of every round of the project, each with its chain and the round and stage that placed it. They stand as placed
   * (U86); the list is what the main agent can still check.
   */
  readonly inferred: OpenList<InferredPlacementRow>;
  /** CS: how many placements the program wrote in all, in every round, and how many were confirmed, moved, or are still unreviewed. */
  readonly programPlacements: ProgramPlacementCounts;
  readonly decisions: {
    /** What it refines leads to no Area, Plan, Goal or Product. */
    readonly onNothing: OpenList<OpenItem>;
    /** What it refines leads to the Product or a Goal only, to no Area and no Plan. */
    readonly productOnly: OpenList<OpenItem>;
    /**
     * Of those, the traceable ones (CJ; CM): their own entry names a contract, a Spec section, a module, an R-item, a plan
     * or an Area, or current documents cite them from a placed requirement, design or contract — with the Areas and Plans
     * those lead to, most cited first.
     */
    readonly traceable: OpenList<OpenItem & { readonly names: readonly string[]; readonly cited: readonly string[]; readonly suggest: readonly string[] }>;
  };
  /**
   * CM (CL's findings §2): designs that refine three Areas or more (a chapter cut too wide), and designs placed nowhere.
   * DB: `unplaced` is the workbench's — on nothing, or only on the Product (or a Goal) with no written reason (`on`).
   */
  readonly designs: {
    readonly wide: OpenList<OpenItem & { readonly areas: readonly string[] }>;
    readonly unplaced: OpenList<OpenItem & { readonly on: string }>;
  };
  /** DB: requirements the workbench does not place — on nothing, or only on the Product (or a Goal) with no written reason (`on`). */
  readonly requirements: { readonly unplaced: OpenList<OpenItem & { readonly on: string }> };
  /** CM (D101): items whose contract, group or own entry names an Area in the project's writing but which sit elsewhere. */
  readonly misplaced: OpenList<OpenItem & { readonly area: string; readonly how: string; readonly sits: string }>;
  readonly generations: {
    /** Earlier generations with no work item recorded as planned in them. */
    readonly withoutItems: OpenList<OpenItem>;
    /**
     * CM: items of a recorded generation with no destination — not replaced by anything (`replacedBy`), no current item
     * depending on them or carrying them on, not moved into a current plan, not deferred or abandoned.
     */
    readonly withoutDestination: OpenList<OpenItem & { readonly generation: string; readonly validity: string }>;
    /** CM: the candidate generations the program lists that have no verdict yet and that no recorded generation holds. */
    readonly candidates: OpenList<OpenItem & { readonly why: string; readonly documents: number; readonly numbers: number; readonly carriedOn: number; readonly work: readonly string[] }>;
  };
  /**
   * CZ: numbers carried by two items of one category — two work items, two Decisions. A number is written once: on the
   * flash run a lane wrote `E14` a second time under an id of its own, and nothing counted it.
   */
  readonly duplicates: OpenList<OpenItem & { readonly number: string; readonly category: string; readonly items: readonly OpenItem[] }>;
  /** CJ: numbers of the current decision records, plans, task indexes and execution arrangements neither carried nor accounted for, by file. */
  readonly entries: EntryGaps;
  /** CJ: items named by their number alone although the line that defines the number gives a title. */
  readonly names: { readonly numberOnly: OpenList<OpenItem & { readonly suggested: string }> };
  readonly tickets: {
    /** Work items with no ids although a number the project defines for tickets is theirs (their internal id, or in their title). */
    readonly noIds: OpenList<OpenItem & { readonly number: string }>;
    /** Work items whose ids are another object's number (a decision's: D99, D100), not their own. */
    readonly otherNumbers: OpenList<OpenItem & { readonly ids: readonly string[] }>;
    /** Tickets (numbers a task index or execution arrangement defines) that record no contract they implement; checks aside. */
    readonly noContract: OpenList<OpenItem>;
  };
  /**
   * The process links not confirmed yet (CJ), and of them the suspect ones (CM): the program checked each as it was written,
   * and a lane-checked link counts like a confirmed one; the cross-check rejects the suspect ones, or confirms them after
   * reading the original.
   */
  readonly links: { readonly unconfirmed: OpenList<OpenItem & { readonly stepKind: string; readonly evidence: string }>; readonly suspect: OpenList<OpenItem & { readonly stepKind: string; readonly evidence: string; readonly why: string }> };
  /** CJ: contracts still Planned although tickets implementing them are Done, with no reason stated (progressWhy). */
  readonly contracts: { readonly stuckPlanned: OpenList<OpenItem & { readonly done: readonly string[] }> };
  /**
   * E153: the notes still current from earlier rounds that this round — a deepening or a Follow up — gave no result yet:
   * not confirmed as still holding, not updated, not withdrawn (standing-notes.ts). The synthesis' to settle.
   */
  readonly notes: { readonly standing: OpenList<OpenItem & { readonly ask: string; readonly since: string; readonly on: string; readonly claims: string; readonly sources: readonly string[] }> };
}

let listLimit = OPEN_LIST_LIMIT;
const list = <T>(all: readonly T[]): OpenList<T> => ({ count: all.length, items: all.slice(0, listLimit) });
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const GONE = new Set(['Replaced', 'Removed']);

function threadName(t: WorkThread): string {
  return t.ids[0] && !t.title.includes(t.ids[0]) ? `${t.ids[0]} ${t.title}` : t.title;
}
function nameOf(store: ProjectStore, id: string): string {
  const t = store.threads.get(id);
  if (t) return threadName(t);
  const r = store.reference.get(id);
  return r ? `${r.category} ${r.ids[0] && !r.name.startsWith(r.ids[0]) ? `${r.ids[0]} ` : ''}${r.name}` : id;
}

/**
 * The steps of the process whose link answers a candidate of this kind (Spec §2.12): the delivery a `No trace of done`
 * misses, the check a `Not checked` misses, and so on.
 */
const ANSWERING_STEPS: Readonly<Partial<Record<Breakpoint['kind'], readonly string[]>>> = {
  'No trace of done': ['Delivered', 'Merged', 'Fix'],
  'Not started': ['Dispatched', 'Delivered', 'Merged', 'Fix'],
  'Not merged': ['Merged'],
  'Not checked': ['QC', 'Review', 'Walkthrough'],
  'Fix not re-checked': ['QC', 'Review', 'Walkthrough'],
  'Findings open': ['Fix', 'Handed to'],
  'Passed with open items': ['Fix', 'Handed to'],
  'No plan': ['Planned'],
};

/**
 * What answers a candidate that has not gone out yet, or null (a lane's "found it, and linked it"): a link of the step it
 * misses — written in this round, or confirmed — a decision recorded as carried out, or a downstream item recorded as no
 * longer current. The program puts the candidate out when it next recomputes the candidates, on confirmed links (a lane's
 * link is confirmed in the cross-check); until then the write itself is the result.
 */
export function answeredBy(store: ProjectStore, roundId: string, b: Breakpoint): string | null {
  const steps = ANSWERING_STEPS[b.kind];
  if (steps) {
    const link = store.links.find((l) => l.workId === b.targetId && steps.includes(l.stepKind) && (l.roundId === roundId || linkHolds(l)));
    if (link) return `link ${link.stepKind}: ${link.evidence?.label ?? link.ledgerRef}`;
  }
  if (b.kind === 'Not carried out' && store.reference.get(b.targetId)?.carryOut?.status === 'Carried out') return 'recorded as carried out';
  if (b.kind === 'Downstream behind') {
    const validity = store.reference.get(b.targetId)?.validity ?? store.threads.get(b.targetId)?.validity;
    if (validity && validity !== 'Current') return `the downstream item is ${validity}`;
  }
  return null;
}

/** A candidate with no result yet: still a candidate (not out, not lit, no owner answer), no lane looked for it, and no write of this round answers it. */
export function candidatesWithoutResult(store: ProjectStore, roundId: string): Breakpoint[] {
  return store.breakpoints.filter((b) => isCandidate(b) && !b.looked && !answeredBy(store, roundId, b)).sort((a, b) => a.kind.localeCompare(b.kind) || a.targetId.localeCompare(b.targetId));
}

/** Candidates a write answers that have not gone out yet: they go out once the link is confirmed and the candidates recomputed. */
export function candidatesAnswered(store: ProjectStore, roundId: string): Breakpoint[] {
  return store.breakpoints.filter((b) => isCandidate(b) && !b.looked && answeredBy(store, roundId, b) !== null);
}

/** What a round has left open on the workbench, as it stands now. */
export function roundOpen(store: ProjectStore, round: Pick<ClerkRound, 'id' | 'lanes'>, opts: { readonly ledger?: Ledger | null; readonly limit?: number; readonly suggest?: boolean } = {}): RoundOpen {
  const before = listLimit;
  listLimit = opts.limit ?? OPEN_LIST_LIMIT;
  try { return roundOpenNow(store, round, opts); } finally { listLimit = before; }
}

function roundOpenNow(store: ProjectStore, round: Pick<ClerkRound, 'id' | 'lanes'>, opts: { readonly ledger?: Ledger | null; readonly suggest?: boolean }): RoundOpen {
  // The briefs of this round, by lane: a candidate is given to a lane when its brief names the candidate's id.
  const briefs = (round.lanes ?? []).flatMap((l) => { const d = store.roundDocs.get(l.briefDocId); return d ? [{ lane: l.name, text: `${d.title}\n${d.markdown}` }] : []; });
  const candidates = candidatesWithoutResult(store, round.id).map((b): OpenCandidate => ({
    id: b.id, kind: b.kind, target: `${nameOf(store, b.targetId)} (${b.targetId})`, why: clip(b.why, 160),
    briefs: briefs.filter((x) => x.text.includes(b.id)).map((x) => x.lane),
  }));

  const relations = store.relations.all();
  // DB: what is not placed is read from the workbench's own placement (ui/placement.js through workbench-placement.ts):
  // one definition for the story map and for these counts. CZ: an item carried on under the same number is current
  // work there — it needs its current plan and its module like any other; an earlier generation's items are on its band.
  const bench = workbenchUnplaced(store);
  const placeOf = (id: string) => bench.placement.place.get(id);
  const threadsOf = (ids: readonly string[]): WorkThread[] => ids.flatMap((id) => store.threads.get(id) ?? []);

  // CQ (D104): the defined zeros. A project with no plan layer has nothing in no plan; one with no Areas nothing in no
  // module; a work item with a recorded reason the program accepted is written as such, not counted as unplaced.
  const planLayer = planLayerPresent(store);
  const hasAreas = areasPresent(store);
  const noPlanThreads = planLayer ? threadsOf(bench.lists.workNoPlan) : [];
  const noModuleThreads = hasAreas ? threadsOf(bench.lists.workNoArea) : [];
  // CN (E152): work for its whole plan, with the Keeper's reason, is placed — in its plan's cross-cutting cell.
  const wholePlan = threadsOf(bench.lists.workWholePlan).map((t) => ({ id: t.id, name: threadName(t), why: clip(placeOf(t.id)?.whole ?? '', 160) }));
  const noPlanWritten = planLayer ? threadsOf(bench.lists.workWrittenNoPlan).map((t) => ({ id: t.id, name: threadName(t), why: clip(placeOf(t.id)?.noPlanWhy ?? '', 160) })) : [];
  const noAreaWritten = hasAreas ? threadsOf(bench.lists.workWrittenNoArea).map((t) => ({ id: t.id, name: threadName(t), why: clip(placeOf(t.id)?.noAreaWhy ?? '', 160) })) : [];

  const onNothing: OpenItem[] = [];
  const productOnly: OpenItem[] = [];
  const productOnlyItems: ReferenceItem[] = [];
  const designsUnplaced: (OpenItem & { on: string })[] = [];
  const requirementsUnplaced: (OpenItem & { on: string })[] = [];
  const numbered = (d: ReferenceItem): string => `${d.ids[0] && !d.name.startsWith(d.ids[0]) ? `${d.ids[0]} ` : ''}${clip(d.name, 100)}`;
  // Boundaries are counted like decisions (CJ: 13 Boundaries were placed only on the Product and never questioned). CM: one
  // placed on the whole product with its written reason (the cross-cutting ring shows it) is placed, and not listed here.
  for (const { item: d, on } of unplacedIntent(store, bench.lists)) {
    if (d.category === 'Decision' || d.category === 'Boundary') {
      const item = { id: d.id, name: `${d.category === 'Boundary' ? 'Boundary ' : ''}${numbered(d)}` };
      (on === 'nothing' ? onNothing : productOnly).push(item);
      if (on !== 'nothing') productOnlyItems.push(d);
    } else if (d.category === 'Design') designsUnplaced.push({ id: d.id, name: clip(d.name, 100), on });
    else if (d.category === 'Requirement') requirementsUnplaced.push({ id: d.id, name: numbered(d), on });
  }

  // CM (CL §2): a design that refines three Areas or more was cut by chapter, not by what it serves; one that reaches no
  // Area and no Plan is placed nowhere (Spec §8 had no placement while the unplaced count read 0).
  const reach = reachOf(store, relations);
  const areaShort = (id: string) => store.reference.get(id)?.name.split(/\s*[·:：]\s*/)[0] ?? id;
  const wide: (OpenItem & { areas: string[] })[] = [];
  for (const d of store.reference.filter((r) => r.category === 'Design' && !GONE.has(r.validity))) {
    const r = reach.ofReference(d.id);
    if (r.areas.length >= WIDE_DESIGN) wide.push({ id: d.id, name: clip(d.name, 100), areas: r.areas.map(areaShort) });
  }
  const misplaced = misplacedItems(store).map((m) => ({ id: m.id, name: clip(m.name, 100), area: m.area, how: m.how, sits: m.sits }));

  const withoutItems = store.generations.filter((g) => g.workIds.length === 0).map((g) => ({ id: g.id, name: g.name }));

  // ── CJ: what the program counts against the ledger ──
  let ledger: Ledger | null = opts.ledger ?? null;
  const opened = opts.ledger === undefined;
  if (opened) { try { ledger = Ledger.openDir(store.dir); } catch { ledger = null; } }
  try {
    // CZ: an item listed because current documents define its number too went on under that number (generation-check.ts).
    const withoutDestination = itemsWithoutDestination(store, ledger).map((x) => ({ id: x.id, name: `${x.number ? `${x.number} ` : ''}${clip(x.name, 80)}`, generation: x.generation, validity: x.validity }));
    const counted = countedOpen(store, round, ledger, relations);
    // Where each Product-only decision traces to: its own entry, and the current documents citing it (CM; placing.ts).
    const index = traceIndex(store, reach);
    const lines = lineIndex(store);
    const traceable: (OpenItem & { names: readonly string[]; cited: readonly string[]; suggest: readonly string[] })[] = [];
    for (const d of productOnlyItems) {
      const t = tracePlacement(store, ledger, d, { reach, index, lines });
      if (!t.names.length && !t.citations) continue;
      traceable.push({ id: d.id, name: `${d.category === 'Boundary' ? 'Boundary ' : ''}${d.ids[0] && !d.name.startsWith(d.ids[0]) ? `${d.ids[0]} ` : ''}${clip(d.name, 100)}`, names: t.names, cited: t.cited, suggest: t.suggest });
    }
    // CN (E152): where the project's own writing leads for the work items not placed — a plan through the decisions a
    // work item carries out, cites or is cited by; the whole plan when a range its ticket writes spans three modules.
    // Read for the lists themselves; a caller that only counts leaves them out (`suggest: false`).
    const suggest = opts.suggest !== false;
    // CQ (D104): the suggestion is the whole inference — rows, front matter, contract, decisions, links — not the decision
    // chain alone; what it leads to clearly the program has placed already, so what is listed here is what it could not.
    const ctx = suggest ? inferenceContext(store, ledger, { reach, index, lines }) : null;
    const noPlan = noPlanThreads.map((t) => {
      // DB: the plans it serves that have no band are named; the records' leads to those same plans are not a suggestion.
      const notDrawn = placeOf(t.id)?.plansNotDrawn ?? [];
      const via = !ctx ? [] : inferThread(ctx, t).plans.filter((l) => bench.drawnPlans.has(l.id)).slice(0, 3).map((l) => `${l.name} (plan) — ${l.through.join('; ')}`);
      return { id: t.id, name: threadName(t), ...(notDrawn.length ? { notCurrent: notDrawn.map((id) => planNotDrawnLine(store, bench.placement, id)) } : {}), ...(via.length ? { suggest: via } : {}) };
    });
    const noModule = noModuleThreads.map((t) => {
      const w = suggest ? wholePlanSuggestion(store, ledger, t, { reach, index }) : null;
      return { id: t.id, name: threadName(t), ...(w ? { suggest: `the whole plan: ${w.from} names ${w.range}, items of ${w.modules.length} modules (${w.modules.join(', ')}) — if it serves the plan as a whole and no single module, pk_write_thread({ id, wholePlanWhy })` } : {}) };
    });
    const zero = <T>(sentence: string): OpenList<T> => ({ count: 0, items: [], notApplicable: sentence });
    return {
      candidates: list(candidates),
      workItems: {
        noPlan: planLayer ? list(noPlan) : zero(NO_PLAN_LAYER), noModule: hasAreas ? list(noModule) : zero(NO_AREAS), wholePlan: list(wholePlan),
        noPlanWritten: list(noPlanWritten), noAreaWritten: list(noAreaWritten),
      },
      inferred: list(inferredPlacementRows(store)),
      programPlacements: programPlacementCounts(store),
      decisions: { onNothing: list(onNothing), productOnly: list(productOnly), traceable: list(traceable) },
      generations: {
        withoutItems: list(withoutItems), withoutDestination: list(withoutDestination),
        candidates: list(openCandidates(store, ledger).map((c) => ({ id: c.key, name: c.name, why: clip(c.why, 220), documents: c.planRefs.length, numbers: c.numbers.length, carriedOn: c.carriedOn.length, work: candidateWorkLines(c) }))),
      },
      designs: { wide: list(wide), unplaced: list(designsUnplaced) },
      requirements: { unplaced: list(requirementsUnplaced) },
      duplicates: list(duplicateNumbers(store)),
      misplaced: list(misplaced),
      notes: { standing: list(standingOpen(store, round.id)) },
      ...counted,
    };
  } finally {
    if (opened) ledger?.close();
  }
}

/**
 * CZ: the numbers two items of one category carry — in their ids, or at the start of their name. Work items are one
 * category; reference items go by theirs (a Requirement and the work item of the same contract share a number by design).
 * Items no longer in the project's current version (`Removed`) are left out.
 */
export function duplicateNumbers(store: ProjectStore): (OpenItem & { number: string; category: string; items: OpenItem[] })[] {
  const groups = new Map<string, OpenItem & { number: string; category: string; items: OpenItem[] }>();
  const add = (category: string, id: string, name: string, ids: readonly string[]) => {
    const numbers = new Set([...ids.map((i) => i.trim().toUpperCase()).filter((i) => isNumberShaped(i)), ...(primaryIdentifier(ids, name) ? [primaryIdentifier(ids, name)!] : [])]);
    for (const number of numbers) {
      const k = `${category}\u0000${number}`;
      const g = groups.get(k) ?? { id: `${category}:${number}`, name: `${category} ${number}`, number, category, items: [] };
      g.items.push({ id, name: clip(name, 100) });
      groups.set(k, g);
    }
  };
  for (const r of store.reference.filter((x) => x.validity !== 'Removed')) add(r.category, r.id, r.name, r.ids);
  for (const t of store.threads.filter((x) => x.validity !== 'Removed')) add('Work item', t.id, t.title, t.ids);
  return [...groups.values()].filter((g) => g.items.length > 1).sort((a, b) => a.category.localeCompare(b.category) || a.number.localeCompare(b.number, undefined, { numeric: true }));
}

/** How many Areas a design refines before the program flags it as cut too wide (CM; CL's findings §2). */
export const WIDE_DESIGN = 3;

/** What an item's own entry names that traces it below the Product (placing.ts `entryNames`). */
export function traceableNames(store: ProjectStore, item: ReferenceItem): string[] {
  return entryNames(store, item);
}

/** The lists the ledger's numbering lets the program count (CJ); empty without a ledger. */
function countedOpen(store: ProjectStore, round: Pick<ClerkRound, 'id' | 'lanes'>, ledger: Ledger | null, relations: readonly GraphRelation[]): Pick<RoundOpen, 'entries' | 'names' | 'tickets' | 'links' | 'contracts'> {
  const entries = entryGaps(store, ledger);

  // Items named by their number alone although the defining line has a title.
  const numberOnly: (OpenItem & { suggested: string })[] = [];
  if (ledger) {
    const named = [...store.reference.all().map((r) => ({ id: r.id, name: r.name, sourceIds: r.sourceIds, what: `${r.category}` })), ...store.threads.all().map((t) => ({ id: t.id, name: t.title, sourceIds: [] as readonly string[], what: 'Work item' }))];
    for (const x of named) {
      if (!isNumberOnly(x.name)) continue;
      const refusal = numberOnlyRefusal(store, ledger, x.name, x.sourceIds, 'The name');
      if (!refusal) continue;
      const suggested = /e\.g\. “([^”]*)”/.exec(refusal)?.[1] ?? '';
      numberOnly.push({ id: x.id, name: `${x.what} ${x.name}`, suggested });
    }
  }

  // Tickets: the numbers a task index or an execution arrangement defines.
  const ticketNums = new Set<string>();
  if (ledger) for (const f of requiredEntries(store, ledger)) if (f.layer === 'Task index' || f.layer === 'Execution arrangement') for (const e of f.entries) ticketNums.add(e.num.toUpperCase());
  const standsIn = (title: string, n: string) => new RegExp(`(?<![A-Za-z0-9_-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`).test(title);
  const noIds: (OpenItem & { number: string })[] = [];
  const otherNumbers: (OpenItem & { ids: string[] })[] = [];
  const noContract: OpenItem[] = [];
  const live = store.threads.filter((t) => !GONE.has(t.validity));
  const unknownIds = ledger ? new Set(undefinedNumbers(ledger, [...new Set(live.flatMap((t) => t.ids))]).map((i) => i.toUpperCase())) : new Set<string>();
  for (const t of live) {
    // Not its own: another object's number (a decision's D99), or a label the project never writes (KIMI-P1, CLAUDE-D99).
    const others = ledger ? t.ids.filter((i) => unknownIds.has(i.toUpperCase()) || otherObjectOf(store, ledger, i) !== null) : [];
    if (others.length) otherNumbers.push({ id: t.id, name: threadName(t), ids: others });
    const own = t.ids.filter((i) => !others.includes(i));
    if (own.length === 0) {
      const number = isNumberShaped(t.id) && ticketNums.has(t.id.toUpperCase()) ? t.id : [...ticketNums].find((n) => standsIn(t.title, n)) ?? null;
      if (number) noIds.push({ id: t.id, name: threadName(t), number });
    }
    const isTicket = [...own, ...(own.length ? [] : [t.id])].some((i) => ticketNums.has(i.toUpperCase()));
    if (isTicket && !CHECK_WORDS.test(t.title) && !relations.some((r) => r.type === 'implements' && r.from === t.id)) noContract.push({ id: t.id, name: threadName(t) });
  }

  // The links not confirmed yet, whichever round wrote them: a skeleton's links wait for a deepening's cross-check.
  const unconfirmed = unconfirmedLinks(store).map((l) => ({
    id: l.id, name: nameOf(store, l.workId), stepKind: l.stepKind, evidence: clip(l.evidence?.label ?? l.ledgerRef, 120),
  }));
  const suspect = suspectLinks(store).map((l) => ({
    id: l.id, name: nameOf(store, l.workId), stepKind: l.stepKind, evidence: clip(l.evidence?.line ?? l.evidence?.label ?? l.ledgerRef, 120), why: clip(l.check?.why ?? 'not checked by the program', 160),
  }));

  // Contracts still Planned although tickets implementing them are Done, with no reason stated.
  const stuck: (OpenItem & { done: string[] })[] = [];
  const contractThread = (to: string): WorkThread | undefined => {
    const t = store.threads.get(to);
    if (t) return t;
    const r = store.reference.get(to);
    if (!r) return undefined;
    const n = r.ids.map((i) => i.toUpperCase());
    return store.threads.find((x) => x.ids.some((i) => n.includes(i.toUpperCase())));
  };
  const doneBy = new Map<string, string[]>();
  for (const r of relations.filter((x) => x.type === 'implements')) {
    const ticket = store.threads.get(r.from);
    const contract = contractThread(r.to);
    if (!ticket || !contract || ticket.id === contract.id || ticket.progress !== 'Done') continue;
    doneBy.set(contract.id, [...new Set([...(doneBy.get(contract.id) ?? []), threadName(ticket)])]);
  }
  for (const [id, done] of doneBy) {
    const c = store.threads.get(id)!;
    if (c.progress === 'Planned' && !GONE.has(c.validity) && !c.progressWhy) stuck.push({ id, name: threadName(c), done });
  }

  return {
    entries,
    names: { numberOnly: list(numberOnly) },
    // CQ (D104): a project with no contract layer (no Task contract layer, nothing implementing a contract) has no ticket missing its contract.
    tickets: { noIds: list(noIds), otherNumbers: list(otherNumbers), noContract: contractLayerPresent(store) ? list(noContract) : { count: 0, items: [], notApplicable: NO_CONTRACT_LAYER } },
    links: { unconfirmed: list(unconfirmed), suspect: list(suspect) },
    contracts: { stuckPlanned: list(stuck) },
  };
}

/** The notes standing from earlier rounds that the round gave no result yet (E153); none for a round the assets do not hold. */
function standingOpen(store: ProjectStore, roundId: string) {
  const round = store.clerkRounds.get(roundId);
  return round ? standingNotes(store, round).filter((s) => s.result === null).map((s) => standingItem(store, s)) : [];
}

/** The process links not confirmed yet, whichever round wrote them (lane-checked ones among them). */
export function unconfirmedLinks(store: ProjectStore): ProcessLinkLike[] {
  return store.links.filter((l) => !l.confirmed);
}

/**
 * The links the synthesis waits on (CM, E151): neither confirmed nor lane-checked — their evidence failed the program's
 * check when they were written, or they were written before the check. On the gated run the gate counted every
 * unconfirmed link, and 82 were "confirmed" in 26 seconds without a file opened.
 */
export function suspectLinks(store: ProjectStore): ProcessLinkLike[] {
  return store.links.filter((l) => !linkHolds(l));
}
type ProcessLinkLike = ReturnType<ProjectStore['links']['all']>[number];

const wholeSuggested = (open: RoundOpen): number => open.workItems.noModule.items.filter((i) => i.suggest).length;
/** DB: of the work in no plan, how many serve only a plan the workbench draws no band for, and which plans. */
function notCurrentNote(open: RoundOpen): string {
  const listed = open.workItems.noPlan.items.filter((i) => i.notCurrent?.length);
  if (!listed.length) return '';
  const plans = [...new Set(listed.flatMap((i) => i.notCurrent ?? []))];
  return ` (${listed.length} of them serve${listed.length === 1 ? 's' : ''} only a plan the workbench draws no band for: ${plans.slice(0, 3).join('; ')}${plans.length > 3 ? '; …' : ''})`;
}

/**
 * CS: the program's placements in one clause, as counts — for the handover note and, through the synthesis' task, the
 * round's Result: how many it placed in all, how many have a result (confirmed, moved), how many nobody reviewed yet.
 * Empty when the program placed nothing in any round.
 */
export function programPlacementsLine(c: ProgramPlacementCounts): string {
  if (!c.placed) return '';
  return `${c.placed} placement${c.placed === 1 ? '' : 's'} the program wrote from the records in all (basis Inferred): ${c.confirmed} confirmed, ${c.moved} moved, ${c.unreviewed} not reviewed yet${c.unreviewed ? ' (they stand as placed; pk_round_state { list: "inferredPlacements" } lists them, whichever round placed them)' : ''}`;
}

/**
 * The note on what is still unplaced, counted; it refuses nothing. `pk_stage` gives it to the main agent as it hands the
 * round over (D103: for its handover to say which stay unplaced and why), and the synthesis job gets it in its task.
 */
export function unplacedNote(open: RoundOpen): string | null {
  const parts = [
    open.workItems.noPlan.count ? `${open.workItems.noPlan.count} work item${open.workItems.noPlan.count === 1 ? '' : 's'} in no plan${notCurrentNote(open)}` : '',
    open.workItems.noModule.count ? `${open.workItems.noModule.count} work item${open.workItems.noModule.count === 1 ? '' : 's'} in no module${wholeSuggested(open) ? ` (${wholeSuggested(open)} of them the program reads as work for the whole plan)` : ''}` : '',
    // CQ (D104): a recorded reason is "written: no plan — why". CS: the program's placements of every round are counted —
    // placed in all, confirmed, moved, still unreviewed — as counts; the unreviewed ones stand as placed (U86).
    programPlacementsLine(open.programPlacements),
    open.workItems.noPlanWritten.count ? `${open.workItems.noPlanWritten.count} work item${open.workItems.noPlanWritten.count === 1 ? '' : 's'} written: no plan — ${open.workItems.noPlanWritten.items.slice(0, 3).map((i) => `${i.name.split(' ')[0]}: ${clip(i.why, 60)}`).join('; ')}${open.workItems.noPlanWritten.count > 3 ? '; …' : ''} (placed by the recorded reason, not counted as unplaced)` : '',
    open.workItems.noAreaWritten.count ? `${open.workItems.noAreaWritten.count} work item${open.workItems.noAreaWritten.count === 1 ? '' : 's'} written: no module — ${open.workItems.noAreaWritten.items.slice(0, 3).map((i) => `${i.name.split(' ')[0]}: ${clip(i.why, 60)}`).join('; ')}${open.workItems.noAreaWritten.count > 3 ? '; …' : ''}` : '',
    open.decisions.onNothing.count ? `${open.decisions.onNothing.count} decision${open.decisions.onNothing.count === 1 ? '' : 's'} placed on nothing` : '',
    open.decisions.productOnly.count ? `${open.decisions.productOnly.count} decision${open.decisions.productOnly.count === 1 ? '' : 's'} placed only on the Product` : '',
    open.generations.withoutItems.count ? `${open.generations.withoutItems.count} earlier generation${open.generations.withoutItems.count === 1 ? '' : 's'} with no planned item recorded` : '',
    open.generations.withoutDestination.count ? `${open.generations.withoutDestination.count} item${open.generations.withoutDestination.count === 1 ? '' : 's'} of an earlier generation with no destination recorded` : '',
    open.generations.candidates.count ? `${open.generations.candidates.count} candidate generation${open.generations.candidates.count === 1 ? '' : 's'} neither accepted nor rejected` : '',
    open.decisions.traceable.count ? `${open.decisions.traceable.count} of the Product-only decisions and boundaries traceable (their entry names a contract, a Spec section, a module, a requirement or a plan, or placed documents cite them; pk_round_state { list: "traceable" } suggests the area)` : '',
    open.designs.wide.count ? `${open.designs.wide.count} design${open.designs.wide.count === 1 ? '' : 's'} refining ${WIDE_DESIGN} areas or more (cut by chapter: one design per section that serves one area)` : '',
    open.designs.unplaced.count ? `${open.designs.unplaced.count} design${open.designs.unplaced.count === 1 ? '' : 's'} placed on nothing or only on the Product with no reason` : '',
    open.requirements.unplaced.count ? `${open.requirements.unplaced.count} requirement${open.requirements.unplaced.count === 1 ? '' : 's'} placed on nothing or only on the Product with no reason` : '',
    open.misplaced.count ? `${open.misplaced.count} item${open.misplaced.count === 1 ? '' : 's'} naming an area in the project’s own writing but sitting elsewhere` : '',
    open.names.numberOnly.count ? `${open.names.numberOnly.count} item${open.names.numberOnly.count === 1 ? '' : 's'} named by the number alone` : '',
    open.tickets.noIds.count ? `${open.tickets.noIds.count} ticket${open.tickets.noIds.count === 1 ? '' : 's'} with no ids` : '',
    open.tickets.otherNumbers.count ? `${open.tickets.otherNumbers.count} work item${open.tickets.otherNumbers.count === 1 ? '' : 's'} carrying another object’s number as their id` : '',
    open.tickets.noContract.count ? `${open.tickets.noContract.count} ticket${open.tickets.noContract.count === 1 ? '' : 's'} recording no contract they implement` : '',
    open.contracts.stuckPlanned.count ? `${open.contracts.stuckPlanned.count} contract${open.contracts.stuckPlanned.count === 1 ? '' : 's'} still Planned with Done tickets and no reason stated` : '',
  ].filter(Boolean);
  if (!parts.length) return null;
  // CQ (D104): the defined zeros — a layer the project lacks is said in a sentence, after the counts, never as a list.
  const zeros = [
    open.workItems.noPlan.notApplicable ? `work in no plan: ${open.workItems.noPlan.notApplicable}` : '',
    open.workItems.noModule.notApplicable ? `work in no module: ${open.workItems.noModule.notApplicable}` : '',
    open.tickets.noContract.notApplicable ? `tickets without a contract: ${open.tickets.noContract.notApplicable}` : '',
  ].filter(Boolean);
  return `=== Unplaced on the workbench\n${[...parts, ...zeros].join('; ')}. pk_round_state lists them (open). Where the project's own records place an item the program has placed it (basis Inferred; check its chain, keep it or move it with the record); say in the Result which stay unplaced and why, each by its recorded reason (noPlanWhy, noAreaWhy — the program refuses a reason where the records lead somewhere); a decision, requirement or design that really concerns the whole product refines the Product and is written with its reason (pk_write_reference wholeProductWhy), which places it in the cross-cutting ring; a work item whose only plan is not current is in no plan — write that plan Current when the current plan document lists it as in force, or give the work the current plan it belongs to, or its reason (noPlanWhy).`;
}

// ───────────────────────── one list at a time (CM) ─────────────────────────

/**
 * The open lists by one flat key each (CM, E151; CK fix 5): `pk_round_state` returns their counts, and one list in full
 * when asked by its key (`{ list: "entries" }`). On the gated run the whole of `open` came back with every call — 34K and
 * 57K characters, six calls, about 91K tokens — though the main agent acted on a few lists at a time.
 */
export const OPEN_KEYS: Readonly<Record<string, { readonly what: string; readonly of: (o: RoundOpen) => { readonly count: number; readonly items: readonly unknown[] } }>> = {
  candidates: { what: 'breakpoint candidates with no result yet (not answered by a write, not looked for, not put out, not lit), each with the briefs that name it', of: (o) => o.candidates },
  noPlan: { what: 'work items in no plan, as the workbench places them: in no band, and not placed from the records by the program; `suggest` lists the current plans the records lead to, each with its chain, where they lead to several — place it by the record (pk_write_thread serves the Plan), or write noPlanWhy naming the records you read; `notCurrent` names the plans it serves that the workbench draws no band for (not current: Proposed, Deferred, Replaced, Abandoned, or held by an earlier generation) — write that plan Current when the current plan document lists it as in force, or give the work the current plan it belongs to, or noPlanWhy saying why its only plan is not in force; "not applicable" when the project has no plan layer', of: (o) => o.workItems.noPlan },
  noModule: { what: `work items in no module; \`suggest\` says when a range its ticket writes spans ${WHOLE_PLAN_MODULES} modules or more — work for its whole plan is recorded with pk_write_thread wholePlanWhy and is then placed; "not applicable" when the project has no Areas`, of: (o) => o.workItems.noModule },
  noPlanWritten: { what: 'work items written as in no plan, each with the recorded reason the program accepted (noPlanWhy): placed by the reason, not counted as unplaced', of: (o) => o.workItems.noPlanWritten },
  noAreaWritten: { what: 'work items written as in no module, each with its recorded reason (noAreaWhy)', of: (o) => o.workItems.noAreaWritten },
  inferredPlacements: { what: 'the placements the program wrote from the records, basis Inferred, that nobody has confirmed or moved yet — of this round and of earlier ones: each with where it was placed, the chain of records, and the round and stage that placed it. They stand as placed; check each against the record in its claim, and move a wrong one with replaceServes / refines. One a write keeps as its own (the same serves with your claim and basis; refines given whole with the target) or moves leaves the list', of: (o) => o.inferred },
  onNothing: { what: 'decisions and boundaries placed on nothing', of: (o) => o.decisions.onNothing },
  productOnly: { what: 'decisions and boundaries placed only on the Product, with no written reason', of: (o) => o.decisions.productOnly },
  traceable: { what: 'of those, the ones their own entry or the documents citing them trace to an area or a plan, each with what it names, where it is cited and the areas suggested', of: (o) => o.decisions.traceable },
  designsWide: { what: `designs that refine ${WIDE_DESIGN} areas or more: cut by chapter, to be cut where a section serves one area`, of: (o) => o.designs.wide },
  designsUnplaced: { what: 'designs the workbench does not place: on nothing, or only on the Product with no reason (`on`) — refine the area or plan each serves, or, for one that concerns the whole product, refine the Product and write wholeProductWhy', of: (o) => o.designs.unplaced },
  requirementsUnplaced: { what: 'requirements the workbench does not place: on nothing, or only on the Product with no reason (`on`) — refine the area each belongs to (its group heading or module column names it), or, for one that holds for the whole product, refine the Product and write wholeProductWhy', of: (o) => o.requirements.unplaced },
  misplaced: { what: 'items whose contract, group heading or own entry names an area but which sit elsewhere', of: (o) => o.misplaced },
  generationsWithoutItems: { what: 'earlier generations with no planned item recorded', of: (o) => o.generations.withoutItems },
  withoutDestination: { what: 'items of an earlier generation with no destination: give each replacedBy (an id or the project’s number), a current item that depends on or carries it, or Abandoned', of: (o) => o.generations.withoutDestination },
  generationCandidates: { what: 'candidate generations the program lists (archived or superseded plan, contract and module sets) waiting for pk_generation_candidate accept or reject; `work` says what each set’s plan documents list as rows, what went on under the same number, and what its other documents define (not its work)', of: (o) => o.generations.candidates },
  entries: { what: 'numbers a current decision record, plan, task index or execution arrangement defines — or a current document that alone defines their family (`families`) — that no item carries and no account names, by file', of: (o) => ({ count: o.entries.count, items: o.entries.files.filter((f) => f.missing.length).map((f) => ({ path: f.path, layer: f.layer, ...(f.families ? { families: f.families } : {}), missing: f.missing.map((m) => m.num) })) }) },
  duplicates: { what: 'numbers two items of one category carry: a number is written once — keep the item the document’s fill wrote (update it by its id or by the number), and merge or withdraw the other (pk_merge_work_items for work items; validity Removed has its own conditions, so say in your Result which one stands)', of: (o) => o.duplicates },
  numberOnly: { what: 'items named by the number alone', of: (o) => o.names.numberOnly },
  noIds: { what: 'tickets with no ids', of: (o) => o.tickets.noIds },
  otherNumbers: { what: 'work items carrying another object’s number as their id', of: (o) => o.tickets.otherNumbers },
  noContract: { what: 'tickets recording no contract they implement', of: (o) => o.tickets.noContract },
  links: { what: 'process links neither confirmed nor lane-checked: their evidence failed the program’s check (or was never checked) — reject each, or confirm it after reading the original', of: (o) => o.links.suspect },
  stuckPlanned: { what: 'contracts still Planned with Done tickets and no reason stated', of: (o) => o.contracts.stuckPlanned },
  standingNotes: { what: 'notes still current from earlier rounds with no result this round (a deepening or a Follow up): the synthesis confirms each as still holding with what it read (pk_confirm_note), updates it (pk_write_note with its id), or withdraws it with why (pk_close_note)', of: (o) => o.notes.standing },
};

/** The count of every open list, by key. */
export function openCounts(open: RoundOpen): Record<string, number> {
  return Object.fromEntries(Object.entries(OPEN_KEYS).map(([k, v]) => [k, v.of(open).count]));
}
