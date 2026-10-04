/**
 * The main agent's bulk tools for what the program can carry (CM, E151; CK fixes 2, 12):
 *
 * - `pk_place_range` places a run of numbered items in one call: `D3–D18 → M2`. On the gated run placement was 154 + 111
 *   single-item writes, and an ADR lane that could not find the Areas handed all of it to the main agent. The numbers are
 *   the project's own; a range names every number between its ends, and what no item carries comes back as missing. A
 *   decision, boundary, requirement or design refines the target; a work item serves it.
 * - `pk_generation_candidate` accepts or rejects a candidate generation the program listed (generation-check.ts):
 *   accepting writes the generation — its plan documents, what ended it, its work items (generation-check.ts: the rows of
 *   its plan documents, by the document each item was written from) — in one call.
 *
 * Which stage or slot may call them is the stage gate's (clerk-steps.ts `STAGE_WRITERS`, `SLOT_WRITERS`); a lane places
 * only what its slots give it.
 */
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Ledger } from '../../ledger/index.ts';
import { expandRanges } from '../../ledger/ranges.ts';
import type { EvidenceRef, Generation, Occurred } from '../../model/k-types.ts';
import type { ReferenceItem, WorkThread } from '../../model/types.ts';
import { stableId } from '../../model/ids.ts';
import { resolveEvidence, resolveEvidenceList, type EvidenceContext, type LedgerHook } from '../evidence.ts';
import type { ToolContext } from '../tools.ts';
import { primaryIdentifier } from '../tools.ts';
import { areaByWrittenName } from './placing.ts';
import { generationCandidates, generationItems, withVerdict } from './generation-check.ts';

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const now = () => new Date().toISOString();
const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }], details: {} });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: `ERROR: ${message}` }], details: {}, isError: true });
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The numbers a written list names: ranges written out, then every number in it (`D3–D18, D12、R-03`). */
export function numbersIn(written: string): string[] {
  const out: string[] = [];
  for (const m of expandRanges(written).toUpperCase().matchAll(/(?<![A-Z0-9_])([A-Z]{1,6}-[A-Z]?\d{1,4}|[A-Z]\d{1,4}|[A-Z]{2})(?![A-Z0-9_])/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

const PLACEABLE: ReadonlySet<string> = new Set(['Decision', 'Boundary', 'Requirement', 'Design']);
const TARGETS: ReadonlySet<string> = new Set(['Area', 'Plan', 'Goal', 'Product']);

export function placeTools(ctx: ToolContext & { readonly ledger?: LedgerHook | null }): ToolDefinition[] {
  const { store, project } = ctx;
  const trace = (summary: string, basisSourceIds: readonly string[] = []) => ({ jobId: ctx.jobId, basisSourceIds, summary });
  const laneSlots = (): readonly string[] | null => (ctx.step?.kind === 'lane' ? ctx.step.lane?.slots ?? [] : null);

  /** The Area, Plan, Goal or Product a call names: by id, by the project's own id, by its name or its short form. */
  const target = (value: string): ReferenceItem | string => {
    const live = store.reference.filter((r) => TARGETS.has(r.category) && r.validity !== 'Replaced' && r.validity !== 'Removed' && r.validity !== 'Abandoned');
    const direct = store.reference.get(value);
    if (direct) return TARGETS.has(direct.category) ? direct : `${value} is a ${direct.category}: items are placed on an Area or a Plan (or, with its reason, on the Product).`;
    const up = value.toUpperCase();
    const byNumber = live.filter((r) => r.ids.some((i) => i.toUpperCase() === up) || primaryIdentifier(r.ids, r.name) === up);
    if (byNumber.length === 1) return byNumber[0]!;
    const byName = live.filter((r) => squash(r.name) === squash(value));
    if (byName.length === 1) return byName[0]!;
    const area = areaByWrittenName(live.filter((r) => r.category === 'Area'), value);
    if (area) return area;
    const starts = live.filter((r) => squash(r.name).startsWith(`${squash(value)} `));
    if (starts.length === 1) return starts[0]!;
    return byNumber.length + byName.length + starts.length > 1 ? `several items answer to “${value}”: give the id of one` : `nothing among the Areas, Plans, Goals and the Product is “${value}”`;
  };

  const tools: ToolDefinition[] = [];

  tools.push(defineTool({
    name: 'pk_place_range', label: 'Place a run of numbered items',
    description: 'Place many numbered items in one call: numbers is the project’s own numbers as a list or a range — "D3–D18", "D12, D28、D87", "AB～CD" is not a range (two letters do not count up) — and to is the Area or Plan they fall on (its id, its project id such as M2 or P1, its name or its short form). A decision, boundary, requirement or design that carries one of the numbers refines it; a work item serves it. What an item already refines or serves stays. Give category to place only reference items of that category (Decision …), or only: "threads" for work items alone. basis says who placed them: Explicit (the default; the document names the run and where it falls) or Inferred (you read it off the records). Numbers no item carries come back in missing; items already there are counted as already. A lane places only what its slots give it. Placing on the Product alone is not a placement: an item that concerns the whole product is written one by one with its reason (pk_write_reference wholeProductWhy).',
    parameters: Type.Object({
      numbers: Type.String({ description: 'the numbers, as a list and ranges: "D3–D18", "D12, D28、D87"' }),
      to: Type.String({ description: 'the Area or Plan: its id, its project id (M2, P1), its name or short form' }),
      category: Type.Optional(Type.String({ description: 'only reference items of this category: Decision | Boundary | Requirement | Design' })),
      only: Type.Optional(Type.String({ description: 'threads: only work items; reference: only reference items' })),
      claim: Type.Optional(Type.String({ description: 'for work items: why they serve it, in a few words (the document that says so)' })),
      basis: Type.Optional(Type.String({ description: 'Explicit (default) | Inferred — who says the items fall there: the document, or your reading of the records' })),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      if (!ctx.step) return fail('pk_place_range places items in a round of the clerk method, and this job is no step of a round. Nothing was written.');
      const numbers = numbersIn(text(p.numbers));
      if (!numbers.length) return fail('numbers: the project’s own numbers, as a list or ranges ("D3–D18", "D12, D28"). Nothing was written.');
      const to = target(text(p.to));
      if (typeof to === 'string') return fail(`to: ${to}. Nothing was written.`);
      if (to.category === 'Product' || to.category === 'Goal') return fail(`to: ${to.name} is the ${to.category}; a run of items is placed on an Area or a Plan. An item that concerns the whole product is written with its reason (pk_write_reference wholeProductWhy). Nothing was written.`);
      const category = text(p.category);
      if (category && !PLACEABLE.has(category)) return fail(`category must be one of ${[...PLACEABLE].join(', ')}. Nothing was written.`);
      const only = text(p.only);
      if (only && only !== 'threads' && only !== 'reference') return fail('only is threads or reference. Nothing was written.');
      // CQ (D104): the caller says who places — the document (Explicit, the default) or its own reading of the records (Inferred).
      const basis = (text(p.basis) || 'Explicit') as 'Explicit' | 'Inferred';
      if (basis !== 'Explicit' && basis !== 'Inferred') return fail('basis is Explicit or Inferred. Nothing was written.');
      const slots = laneSlots();
      const mayRef = (c: string) => slots === null || slots.includes('relations') || slots.some((s) => s.toLowerCase() === `reference:${c}`.toLowerCase());
      const mayThreads = slots === null || slots.includes('relations') || slots.includes('threads');
      const want = new Set(numbers);
      const carried = new Set<string>();
      const placed: string[] = [];
      let already = 0;
      const refusedSlots = new Set<string>();
      const at = now();
      if (only !== 'threads') {
        for (const r of store.reference.filter((x) => PLACEABLE.has(x.category) && (!category || x.category === category) && x.validity !== 'Removed')) {
          const n = [...r.ids.map((i) => i.toUpperCase()), primaryIdentifier(r.ids, r.name) ?? ''].find((i) => want.has(i));
          if (!n) continue;
          carried.add(n);
          if (!mayRef(r.category)) { refusedSlots.add(`reference:${r.category}`); continue; }
          if (r.refines.includes(to.id)) { already += 1; continue; }
          store.reference.put({ ...r, refines: [...r.refines, to.id], updatedAt: at }, trace(`${n} placed on ${to.name} (pk_place_range)`, r.sourceIds));
          ctx.onSaved?.('reference', r.id, `Placed on ${to.name}`);
          placed.push(n);
        }
      }
      if (only !== 'reference' && !category) {
        for (const t of store.threads.filter((x) => x.validity !== 'Removed')) {
          const n = t.ids.map((i) => i.toUpperCase()).find((i) => want.has(i));
          if (!n) continue;
          carried.add(n);
          if (!mayThreads) { refusedSlots.add('threads'); continue; }
          if (t.serves.some((s) => s.referenceId === to.id)) { already += 1; continue; }
          const mine = { referenceId: to.id, claim: text(p.claim) || `placed with ${numbers.length > 1 ? `${numbers[0]}…${numbers[numbers.length - 1]}` : n} (pk_place_range)`, basis };
          // An Area goes after the Areas it already serves (the first stays its main one), a Plan at the end.
          const lastArea = t.serves.reduce((k, s, i) => (store.reference.get(s.referenceId)?.category === 'Area' ? i : k), -1);
          const serves = to.category === 'Area' ? [...t.serves.slice(0, lastArea + 1), mine, ...t.serves.slice(lastArea + 1)] : [...t.serves, mine];
          store.threads.put({ ...t, serves, updatedAt: at } as WorkThread, trace(`${n} placed on ${to.name} (pk_place_range)`));
          ctx.onSaved?.('threads', t.id, `Placed on ${to.name}`);
          if (!placed.includes(n)) placed.push(n);
        }
      }
      const missing = numbers.filter((n) => !carried.has(n));
      if (refusedSlots.size && !placed.length && !already) return fail(`This lane writes ${slots!.join(', ') || 'no slot'}, and the items these numbers name are ${[...refusedSlots].join(', ')}: a lane places only what its slots give it. Put the placement in your Report for the main agent. Nothing was written.`);
      return ok({
        to: { id: to.id, name: to.name, category: to.category }, numbers: numbers.length, placed: placed.length, already,
        ...(missing.length ? { missing: missing.length > 40 ? [...missing.slice(0, 40), `… ${missing.length - 40} more`] : missing, note: 'missing: no item of the workbench carries these numbers (fill them from their document first, or account for them).' } : {}),
        ...(refusedSlots.size ? { notPlaced: `items of ${[...refusedSlots].join(', ')} were left: this lane does not hold those slots` } : {}),
      });
    },
  }));

  tools.push(defineTool({
    name: 'pk_generation_candidate', label: 'Accept or reject a candidate generation',
    description: 'Orientation (and reconcile, the cross-check): the program lists candidate generations — archived or superseded plan, contract and module sets — with the owner’s lines that name generations beside them. Whether a candidate is an earlier generation of the project’s plans is yours to judge from the documents. verdict accept writes the generation in this one call: its plan documents, what ended it (the candidate’s own commit unless you give ended), and its work items — the rows of its plan documents: the items written from them, and the current items of the rows that were carried on under the same number (what its other documents define is not its work, and the reply says so apart); name is the material’s own name for it; generationId adds the candidate to a generation already recorded instead. verdict reject records why, and the candidate is not listed again. Each item of an accepted generation then needs its destination (pk_write_thread replacedBy, validity, a current item that depends on or carries it): pk_round_state { list: "withoutDestination" } lists those without one.',
    parameters: Type.Object({
      key: Type.String({ description: 'the candidate’s key as listed, e.g. set:docs/archive/roadmap-v1' }),
      verdict: Type.String({ description: 'accept | reject' }),
      why: Type.Optional(Type.String({ description: 'reject: why it is not a generation (required). accept: what makes it one, in a sentence' })),
      name: Type.Optional(Type.String({ description: 'accept: the material’s own name for the generation, e.g. "Roadmap v1 and the 2024 plan"' })),
      generationId: Type.Optional(Type.String({ description: 'accept: a recorded generation this set belongs to — its documents and items are added to it' })),
      ended: Type.Optional(Type.Object({ kind: Type.String(), id: Type.String(), line: Type.Optional(Type.String()), repo: Type.Optional(Type.String()) }, { description: 'accept: what ended it, where the material says so — { kind, id, line? } (a decision’s line, the cleanup commit); the program reads its date' })),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const step = ctx.step;
      if (!step) return fail('pk_generation_candidate is a round’s (the main agent in orientation, reconcile or the cross-check). Nothing was written.');
      const round = store.clerkRounds.get(step.roundId);
      if (!round) return fail(`The round ${step.roundId} is not in the assets.`);
      const verdict = text(p.verdict).toLowerCase();
      if (verdict !== 'accept' && verdict !== 'reject') return fail('verdict is accept or reject. Nothing was written.');
      let ledger: Ledger | null = null;
      try { ledger = Ledger.openDir(store.dir); } catch { ledger = null; }
      try {
        const key = text(p.key);
        const candidates = generationCandidates(store, ledger, { all: true });
        const candidate = candidates.find((c) => c.key === key);
        if (!candidate) return fail(`${key || '(empty)'} is not a candidate the program lists (pk_round_state { list: "generationCandidates" }). To record a generation the program did not list, use pk_write_generation. Nothing was written.`);
        if (candidate.kind !== 'set') return fail('An owner’s line is read, not judged: it tells you how the owner counts the generations. Accept or reject the document sets. Nothing was written.');
        const why = text(p.why);
        const at = now();
        if (verdict === 'reject') {
          if (!why) return fail('why: why this set is not an earlier generation of the plans (a version history, a batch of reports, a recovery copy …). Nothing was written.');
          store.clerkRounds.put(withVerdict(store.clerkRounds.get(round.id) ?? round, { key, accepted: false, why, generationId: null, at }), trace(`Candidate generation ${candidate.name} rejected: ${why}`));
          return ok({ key, verdict: 'reject', why });
        }
        const ev: EvidenceContext = { store, project, ledger: ctx.ledger ?? null };
        const existing = text(p.generationId) ? store.generations.get(text(p.generationId)) : undefined;
        if (text(p.generationId) && !existing) return fail(`${text(p.generationId)} is not a generation of this project. Nothing was written.`);
        const name = text(p.name) || existing?.name || candidate.name;
        const planRefs = resolveEvidenceList(ev, candidate.planRefs.map((id) => ({ kind: 'file', id })), 'planRefs');
        if (typeof planRefs === 'string') return fail(`${planRefs} Nothing was written.`);
        let endedBy: EvidenceRef | string | null = null;
        if (p.ended !== undefined && p.ended !== null) endedBy = resolveEvidence(ev, p.ended, 'ended');
        else if (existing) endedBy = existing.endedBy;
        else if (candidate.endedCommit) endedBy = resolveEvidence(ev, { kind: 'commit', id: candidate.endedCommit }, 'ended');
        if (typeof endedBy === 'string') return fail(`${endedBy} Nothing was written.`);
        if (!endedBy) return fail('ended: what ended this generation, where the material says so — { kind, id, line? } (the program found no commit that set these documents aside). Nothing was written.');
        const ended: Occurred = (p.ended === undefined || p.ended === null) && existing ? existing.ended : endedBy.occurred ?? { at, basis: 'First observed', anchor: endedBy.id, undated: true };
        // CZ: its items are the ones written from its documents, or carried on under the same number — never by number alone.
        const workIds = [...new Set([...(existing?.workIds ?? []), ...generationItems(store, ledger, candidate, candidates)])];
        const id = existing?.id ?? stableId('gen', project.id, squash(name));
        const before = store.generations.get(id);
        const merged = [...(before?.planRefs ?? existing?.planRefs ?? [])];
        for (const r of planRefs) if (!merged.some((x) => x.kind === r.kind && x.id === r.id)) merged.push(r);
        const generation: Generation = { id, projectId: project.id, name, started: before?.started ?? null, ended, endedBy, planRefs: merged, workIds, roundId: step.roundId, updatedAt: at };
        store.generations.put(generation, trace(`Generation “${name}” from the candidate ${candidate.name}: ${merged.length} plan documents, ${workIds.length} work items, ended ${ended.at} (${endedBy.label})`));
        ctx.onSaved?.('generations', id, `Generation: ${name}`);
        store.clerkRounds.put(withVerdict(store.clerkRounds.get(round.id) ?? round, { key, accepted: true, why: why || `recorded as ${name}`, generationId: id, at }), trace(`Candidate generation ${candidate.name} accepted as “${name}”`));
        // CZ: only the rows of its plan documents are work to fill; what current documents carry on, and what its other
        // documents define, are said apart — on the flash run this reply told a lane to fill 60 rows of an archived README.
        const carriedBy = (n: string) => store.threads.find((t) => t.validity !== 'Removed' && t.ids.some((i) => i.toUpperCase() === n.toUpperCase()));
        const unfilled = candidate.numbers.filter((n) => !carriedBy(n));
        const listed = new Set(workIds);
        const notJoined = [...candidate.numbers, ...candidate.carriedOn].filter((n) => { const t = carriedBy(n); return t !== undefined && !listed.has(t.id); });
        return ok({
          key, verdict: 'accept', generation: { id, name, ended, endedBy: endedBy.label, planRefs: merged.length, workIds: workIds.length },
          ...(unfilled.length ? { numbersWithNoWorkItem: unfilled.slice(0, 40), note: 'Its plan documents list these rows and no work item carries them yet: a lane with the generations and threads slots fills them from the plan table or contract index that lists them (pk_fill_from_table); they join the generation as they are filled from its documents.' } : {}),
          ...(candidate.carriedOn.length ? { carriedOn: { count: candidate.carriedOn.length, numbers: candidate.carriedOn.slice(0, 40), note: 'Current documents define these rows too: carried on under the same number. The current items of those numbers are this generation’s items, with that destination; they join it as they are filled from the current documents, and need no item of their own here.' } } : {}),
          ...(candidate.alsoDefined.length ? { alsoDefined: candidate.alsoDefined.map((a) => ({ family: a.family, count: a.count, in: a.documents.slice(0, 3), continuedIn: a.continuedIn })), alsoDefinedNote: 'Defined in this set’s other documents, not in a plan document: not work items of this generation, and nothing here asks a lane to fill them as work. What they are is read from their document.' } : {}),
          ...(notJoined.length ? { notJoined: notJoined.slice(0, 40), notJoinedNote: 'Work items carry these numbers, and nothing recorded says they were written from this set’s documents (another set defines the number too, or the item names no source): the number alone does not make them its items. Add the ones that are (pk_write_generation workIds).' } : {}),
        });
      } finally { ledger?.close(); }
    },
  }));

  return tools;
}
