/**
 * The blocks every job of a round is given (D99): the round and the organizing plan it follows, and the project's rules
 * in force. The planner gives them to the main job; `pk_send_lanes` gives them to each lane with its skill and its brief.
 */
import type { ClerkRound, LaneKind, SlotKind } from '../../model/k-types.ts';
import type { Project } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { organizingPlanBlock } from './clerk-prompts.ts';
import { ORGANIZING_PLAN_ID } from './reading.ts';
import { laneSkill } from './skills.ts';
import { ownerLinesBlock } from './owner-lines.ts';
import type { Ledger } from '../../ledger/index.ts';

/**
 * The round, and the organizing plan it follows (Spec §3.7; D62, the owner: 「之后的整理照它执行」) as it stands when the
 * job is queued: what the rules settle, what is read closely, the focus, the order, and each of the owner's corrections
 * in their words — those since the last round began marked. A correction made while the round runs so reaches every job
 * queued after it (D97).
 */
export function roundBlockOf(store: ProjectStore, project: Project, round: ClerkRound): string {
  const previous = store.clerkRounds.filter((r) => r.id !== round.id && r.status === 'Done').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const lines = [
    `This is ${round.kind === 'Follow up' ? 'Follow up' : 'takeover'} round ${round.number} (${round.kind}) of ${project.name}; round id ${round.id}.`,
    ...(round.kind === 'Follow up' && previous ? [`What changed since ${previous.startedAt} is this round's scope.`] : []),
    ...(round.kind === 'Deepen' ? [`Depth chosen by the owner: ${project.takeoverDepth ?? 'Full'}.`] : []),
    `The project's language: ${project.language}. Write what you write in it; fixed workbench words stay in English.`,
  ];
  const plan = store.plans.get(ORGANIZING_PLAN_ID);
  const planBlock = plan ? organizingPlanBlock({ plan, rule: (id) => store.rules.get(id)?.summary ?? null, since: previous?.startedAt ?? null }) : null;
  return [`=== This round\n${lines.join('\n')}`, ...(planBlock ? [planBlock] : [])].join('\n\n');
}

/** The project's rules in force, one line each. */
export function rulesBlockOf(store: ProjectStore): string {
  return store.rules.filter((r) => r.validity === 'Current')
    .map((r) => `- ${r.id} [${r.group}${r.category ? ` · ${r.category}` : ''} · ${r.basis}${r.ownerConfirmation ? ' · confirmed by the owner' : ''}] ${r.summary}${r.appliesTo.length ? ` (applies to: ${r.appliesTo.join(', ')})` : ''}`)
    .join('\n');
}

/**
 * A lane's task (D99, E148 D-b): its skill in its prompt — GLM may not open a skill file by itself — then its brief, the
 * round and the project's rules. The first line names it, so its job and its Report are told apart from the others'.
 */
export function lanePrompt(input: { readonly name: string; readonly kind: LaneKind; readonly slots: readonly SlotKind[]; readonly brief: string; readonly briefDocId: string; readonly roundBlock: string; readonly rules: string; readonly blocks?: readonly string[] }): string {
  return [
    `Task: a lane of this round — ${input.name} (${input.kind}). The main agent sent you with the brief below (${input.briefDocId}). Write the slots it gives you — ${input.slots.length ? input.slots.join(', ') : 'none: you report only'} — each with its source, and your Report (pk_write_round_doc kind Report). End with a short summary of what you found and wrote: the main agent reads it first.`,
    laneSkill(input.kind),
    `=== Your brief\n${input.brief}`,
    input.roundBlock,
    ...(input.blocks ?? []),
    `=== The project's rules in force\n${input.rules || 'None recorded yet.'}`,
  ].join('\n\n');
}

/** The slot of the lane that writes the owner's words (CM): it is given the owner's lines in full. */
export const OWNER_WORDS_SLOT = "reference:Owner's words";

/**
 * The program's lists a lane is given with its brief, by its slots (CM, E151): the lane that writes the `Owner's words`
 * items gets every owner's line no position cites yet, verbatim (the main agent gets only their count).
 */
export function laneBlocksOf(store: ProjectStore, slots: readonly SlotKind[], ledger: Ledger | null, since: string | null): string[] {
  if (!slots.some((s) => s.toLowerCase() === OWNER_WORDS_SLOT.toLowerCase())) return [];
  try { return [ownerLinesBlock(store, ledger, { since })]; } catch (e) { return [`=== The owner's lines: the program could not list them (${(e as Error).message}); read the session drafts (pk_read_assets kind draft).`]; }
}
