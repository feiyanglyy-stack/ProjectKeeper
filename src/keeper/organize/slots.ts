/**
 * The workbench's slots, and the ones no lane holds (DB; Spec §3.3 "工作台是一道填空题").
 *
 * The program knows the slots and which lane holds which. When a first usable round's skeleton lanes are sent
 * (`pk_send_lanes`, lane-tools.ts), a slot no lane holds is listed back before anything is sent: the main agent gives it
 * to a lane, or says in one line why the project has nothing for it. The reason is kept on the round (`emptySlots`) and
 * shown to the next spot-check; the program refuses nothing more and does not judge the reason. On the DeepSeek run
 * (2026-10-04) no lane was given the Boundary slot, and the workbench held no boundary although the PRD had a section on
 * what the product does not include — the two runs before it held 18 and 34.
 */
import type { ClerkRound, EmptySlot, SlotKind } from '../../model/k-types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { REFERENCE_CATEGORY } from '../../model/vocab.ts';

/** What each reference category holds, in words a main agent can match against the project's documents. */
const REFERENCE_HOLDS: Readonly<Record<(typeof REFERENCE_CATEGORY)[number], string>> = {
  "Owner's words": 'the owner’s own lines, verbatim',
  Product: 'what the product is',
  Goal: 'the goals the product serves',
  Area: 'the modules or areas of the product',
  Requirement: 'the requirements: what the product must do',
  Design: 'the designs: how it is built, section by section',
  Decision: 'the decisions and their records',
  Plan: 'the plans: increments, phases, batches, milestones',
  Boundary: 'what the product does not include: non-goals, out of scope, limits it states',
};

/**
 * The slots a first usable round's skeleton fills by lane, each with what it holds: every reference category, the work
 * items, their process links, the code territories, the earlier generations. `patches` and `relations` are not among
 * them: reconcile drafts the supersession lines no lane drafted, and relations tie the items of the other slots — neither
 * is a position left empty because no lane held it.
 */
export const SKELETON_SLOTS: readonly { readonly slot: SlotKind; readonly holds: string }[] = [
  ...REFERENCE_CATEGORY.map((c) => ({ slot: `reference:${c}` as SlotKind, holds: REFERENCE_HOLDS[c] })),
  { slot: 'threads', holds: 'the work items: contracts, tickets, tasks, issues' },
  { slot: 'links', holds: 'what ties work to its delivery: dispatches, deliveries, merges, checks' },
  { slot: 'territories', holds: 'the code as it stands, by area' },
  { slot: 'generations', holds: 'earlier generations of the plan: archived or superseded plan, contract and module sets' },
];

/** A slot as it is compared: the apostrophe as typed, any case. */
export const slotKey = (s: string): string => s.replace(/[’‘`]/g, "'").trim().toLowerCase();

/** The skeleton's slot a name stands for, or undefined. */
export const skeletonSlot = (name: string) => SKELETON_SLOTS.find((s) => slotKey(s.slot) === slotKey(name));

/** The slots of the skeleton that neither a lane holds nor a recorded reason accounts for. */
export function slotsUnheld(held: readonly string[], reasons: readonly Pick<EmptySlot, 'slot'>[]): { readonly slot: SlotKind; readonly holds: string }[] {
  const taken = new Set([...held, ...reasons.map((r) => r.slot)].map(slotKey));
  return SKELETON_SLOTS.filter((s) => !taken.has(slotKey(s.slot)));
}

/** Whether the workbench holds anything in a slot now. */
export function slotHolds(store: ProjectStore, slot: string): boolean {
  const key = slotKey(slot);
  if (key.startsWith('reference:')) return store.reference.find((r) => `reference:${r.category}`.toLowerCase() === key && r.validity !== 'Removed') !== undefined;
  if (key === 'threads') return store.threads.size > 0;
  if (key === 'links') return store.links.size > 0;
  if (key === 'territories') return store.territories.size > 0;
  if (key === 'generations') return store.generations.size > 0;
  return true;
}

/** Every recorded reason of the project, oldest round first, each with its round and whether the slot holds anything now. */
export function emptySlotsOf(store: ProjectStore): (EmptySlot & { readonly round: string; readonly holdsNow: boolean })[] {
  return store.clerkRounds.all().sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .flatMap((r) => (r.emptySlots ?? []).map((e) => ({ ...e, round: `${r.kind} round ${r.number}`, holdsNow: slotHolds(store, e.slot) })));
}

/**
 * What a round's spot-check is shown of the slots left to no lane: the reasons recorded since the last spot-check of an
 * earlier round began, whichever round recorded them — a first usable round has no spot-check of its own — for the slots
 * that still hold nothing. Null when there is none.
 */
export function emptySlotsBlock(store: ProjectStore, round: Pick<ClerkRound, 'id'>): string | null {
  const lastCheck = store.jobs.filter((j) => j.step?.kind === 'spot-check' && j.step.roundId !== round.id).map((j) => j.queuedAt).sort().at(-1) ?? '';
  const standing = emptySlotsOf(store).filter((e) => e.at > lastCheck && !e.holdsNow);
  if (!standing.length) return null;
  return [
    `=== Slots no lane held (${standing.length}; the main agent’s reasons, which the program does not check)`,
    'The skeleton gave these workbench slots to no lane, and the main agent said why the project has nothing for them; the workbench still holds nothing there. Check each reason against the project’s documents: a section or a table that states such material makes it wrong. Say in your Spot check document which reasons hold and which do not, each wrong one with where the material is (path and line), so the next round gives that slot to a lane.',
    ...standing.map((e) => `- ${e.slot} (${skeletonSlot(e.slot)?.holds ?? 'a workbench slot'}) · ${e.round}: “${e.why}”`),
  ].join('\n');
}
