/**
 * What the main agent and its lanes may write, decided at call time by the job's effective stage (D99; E148 D-a).
 *
 * pi cannot change a session's tools halfway through, so the main job is offered every stage's writers at once
 * (`STAGE_WRITERS`, clerk-steps.ts) and each writer refuses outside the stages that list it: the main job's effective
 * stage is the stage its round is in (`ClerkRound.stage`). A lane is offered the writers of the slots it was given
 * (`SLOT_WRITERS`) and its Report; its effective stage is `lane`, and `reference:<category>` is checked by category too.
 * So one matter is still written once, by the one that owns it (Spec §3.3 "谁写什么"), without new sessions per stage.
 *
 * D103: once the main agent has handed the round over to the synthesis (`handedOver`), its session writes nothing more;
 * the synthesis job writes by its own step's table (roles.ts `STEP_WRITES.synthesis`), not by a stage.
 */
import type { ClerkRound, ClerkStage, RoundDocKind, RoundStepKind, SlotKind } from '../../model/k-types.ts';
import type { KeeperJob } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { DOCS_BY_STAGE, LANE_ALWAYS, LANE_DOCS, MAIN_ALWAYS, ROUND_STAGES, SLOT_WRITERS, STAGE_WRITERS } from '../clerk-steps.ts';

type Step = NonNullable<KeeperJob['step']>;

/**
 * The judgements only a Follow up round's cross-check makes (Spec §5.5; roles.ts `FOLLOW_UP_WRITES`): the main agent of a
 * Follow up round is offered them and writes them in its cross-check stage.
 */
export const MAIN_FOLLOW_UP_WRITES: readonly string[] = ['pk_write_change', 'pk_judge_object', 'pk_set_propagation', 'pk_set_propagations', 'pk_write_modification_request', 'pk_mark_request_handled', 'pk_round_pending'];

/** The stage the main agent is in: the round's, or its first stage before it has moved (a round started before it said). */
export function stageOfRound(round: Pick<ClerkRound, 'kind' | 'stage'>): ClerkStage {
  return round.stage ?? ROUND_STAGES[round.kind][0]!;
}

/**
 * Whether the main agent handed the round over to the synthesis (D103): its handover is recorded — or, on a round
 * recorded before D103, it had moved into the synthesis stage, which the synthesis job now holds.
 */
export function handedOver(round: Pick<ClerkRound, 'stage' | 'handover'>): boolean {
  return !!round.handover || round.stage === 'synthesis';
}

/** The main agent's last stage in a round of this kind: the one it hands over from. */
export function lastStageOf(kind: ClerkRound['kind']): ClerkStage {
  const order = ROUND_STAGES[kind];
  return order[order.length - 1]!;
}

const HANDED_OVER = `the main agent handed this round over to the synthesis, which runs in a session of its own: the main agent's work is done, and its session writes nothing more`;

export type EffectiveStage =
  | { readonly kind: 'main'; readonly stage: ClerkStage; readonly round: ClerkRound }
  | { readonly kind: 'lane'; readonly name: string; readonly slots: readonly SlotKind[]; readonly round: ClerkRound | null };

/** Who a job writes as (D99): the main job in its round's stage, a lane with its slots; null for any other job. */
export function effectiveStage(store: ProjectStore, step: Step | null | undefined): EffectiveStage | null {
  if (!step) return null;
  const round = store.clerkRounds.get(step.roundId) ?? null;
  if (step.kind === 'main') return round ? { kind: 'main', stage: stageOfRound(round), round } : null;
  if (step.kind === 'lane') return { kind: 'lane', name: step.path ?? '', slots: step.lane?.slots ?? [], round };
  return null;
}

/**
 * The step kind whose rules a stage-dependent writer applies (a patch is a draft before the cross-check, a link is
 * confirmed and a send-back limited in the cross-check): the main job's stage by the step it replaces, `lane` for a lane,
 * the job's own step kind otherwise.
 */
export function stepKindAs(store: ProjectStore, step: Step | null | undefined): RoundStepKind | 'lane' | null {
  if (!step) return null;
  const eff = effectiveStage(store, step);
  if (!eff) return step.kind;
  if (eff.kind === 'lane') return 'lane';
  const as: Readonly<Record<ClerkStage, RoundStepKind>> = { orientation: 'orientation', skeleton: 'skeleton', reconcile: 'skeleton', dig: 'dig', coverage: 'dig', 'cross-check': 'cross-check', synthesis: 'synthesis' };
  return as[eff.stage];
}

const either = (list: readonly string[]): string => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`);
const slotBase = (slot: string): string => (slot.startsWith('reference:') ? 'reference' : slot.split(':')[0]!);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The stages whose writers list a tool. */
export function stagesWriting(tool: string): ClerkStage[] {
  return (Object.keys(STAGE_WRITERS) as ClerkStage[]).filter((s) => STAGE_WRITERS[s].includes(tool));
}

/** The slot kinds whose writers list a tool (`reference` standing for every `reference:<category>`). */
export function slotsWriting(tool: string): string[] {
  return Object.entries(SLOT_WRITERS).filter(([, tools]) => tools.includes(tool)).map(([slot]) => (slot === 'reference' ? 'reference:<category>' : slot));
}

/** The reference category a call writes, when it writes reference items: given, or the one of the item it updates. */
function referenceCategory(store: ProjectStore, tool: string, args: Record<string, unknown> | null): { readonly writes: 'reference' | 'threads' | null; readonly category: string | null } {
  if (!args) return { writes: null, category: null };
  if (tool === 'pk_write_reference') {
    const given = text(args.category);
    const id = text(args.id);
    return { writes: 'reference', category: given || (id ? store.reference.get(id)?.category ?? null : null) };
  }
  // DA: judging the owner's lines is the Owner's words slot's, like the items it writes.
  if (tool === 'pk_judge_owner_lines') return { writes: 'reference', category: "Owner's words" };
  if (tool === 'pk_fill_from_table') return text(args.into) === 'threads' ? { writes: 'threads', category: null } : { writes: 'reference', category: text(args.category) || null };
  if (tool === 'pk_fill_from_headings' || tool === 'pk_fill_from_bold') return { writes: 'reference', category: text(args.category) || null };
  return { writes: null, category: null };
}

/**
 * Why the main job or a lane may not make this call now, or null (D99): the main job writes only what its stage lists (and
 * in a Follow up's cross-check the round's judgements), a lane only what its slots and every lane may write. Any other job
 * is not decided here.
 */
export function writeRefusal(store: ProjectStore, step: Step | null | undefined, tool: string, args: Record<string, unknown> | null = null): string | null {
  const eff = effectiveStage(store, step);
  if (!eff) return null;
  if (eff.kind === 'main') {
    if ((MAIN_ALWAYS as readonly string[]).includes(tool)) return null;
    if (handedOver(eff.round)) return `${tool}: ${HANDED_OVER}. Nothing was written. End with a short summary of what you handed over.`;
    if (STAGE_WRITERS[eff.stage].includes(tool)) return null;
    if (eff.round.kind === 'Follow up' && MAIN_FOLLOW_UP_WRITES.includes(tool)) {
      return eff.stage === 'cross-check' ? null : `${tool} judges into the Follow up round's record, which the main agent does in its cross-check stage; you are in the ${eff.stage} stage, so nothing was written.`;
    }
    const stages = stagesWriting(tool);
    if (stages.length) return `${tool} is written in the ${either(stages)} stage of the main agent's session (each stage writes its own positions); this round is in the ${eff.stage} stage, so nothing was written. Move to that stage with pk_stage when this one is done, or give the write to a lane whose slot it is.`;
    const slots = slotsWriting(tool);
    return `${tool} is not the main agent's to write in any stage${slots.length ? `: a lane with the slot ${either(slots)} writes it (send one with pk_send_lanes)` : ''}, so nothing was written.`;
  }
  if ((LANE_ALWAYS as readonly string[]).includes(tool)) return null;
  const own = eff.slots.filter((s) => (SLOT_WRITERS[slotBase(s) as keyof typeof SLOT_WRITERS] ?? []).includes(tool));
  const given = eff.slots.length ? eff.slots.join(', ') : 'none';
  if (!own.length) {
    const slots = slotsWriting(tool);
    return `${tool} writes ${slots.length ? `the slot ${either(slots)}` : 'a position no lane writes'}; this lane (${eff.name}) writes ${given} (a lane writes only the slots its brief gives it), so nothing was written. Put what you found in your Report for the main agent.`;
  }
  const ref = referenceCategory(store, tool, args);
  if (ref.writes === 'threads') return eff.slots.includes('threads') ? null : `${tool} into threads writes work items, the slot threads; this lane (${eff.name}) writes ${given}, so nothing was written.`;
  if (ref.writes === 'reference') {
    if (!ref.category) return `${tool} writes reference items, and a lane writes those only in the categories its slots name (reference:<category>): give the category. Nothing was written.`;
    const want = `reference:${ref.category}`.toLowerCase();
    if (eff.slots.some((s) => s.toLowerCase() === want)) return null;
    const cats = eff.slots.filter((s) => s.startsWith('reference:'));
    return `${tool} would write a ${ref.category} reference item, the slot reference:${ref.category}; this lane (${eff.name}) writes ${cats.length ? cats.join(', ') : 'no reference category'}, so nothing was written. Put it in your Report for the main agent.`;
  }
  return null;
}

/** Why the main job or a lane may not write a round document of this kind now, or null (D99; `DOCS_BY_STAGE`, `LANE_DOCS`). */
export function roundDocRefusal(store: ProjectStore, step: Step | null | undefined, kind: RoundDocKind): string | null {
  const eff = effectiveStage(store, step);
  if (!eff) return null;
  if (eff.kind === 'lane') return LANE_DOCS.includes(kind) ? null : `A lane writes its own ${either([...LANE_DOCS])}; a ${kind} is the main agent's. Nothing was written.`;
  if (handedOver(eff.round)) return `A ${kind}: ${HANDED_OVER}. Nothing was written.`;
  if (kind === 'Handover') return `The handover is written as you hand the round over: pk_stage({ to: "synthesis", handover: { settled, open, first } }) once the ${lastStageOf(eff.round.kind)} stage is done. Nothing was written.`;
  const allowed = DOCS_BY_STAGE[eff.stage];
  if (allowed.includes(kind)) return null;
  const stages = (Object.keys(DOCS_BY_STAGE) as ClerkStage[]).filter((s) => DOCS_BY_STAGE[s].includes(kind));
  const where = stages.length ? `in the ${either(stages)} stage` : LANE_DOCS.includes(kind) ? 'by a lane, as its own report' : kind === 'Result' ? 'by the synthesis, in a session of its own' : 'by the spot-check';
  return `In the ${eff.stage} stage the main agent writes ${allowed.length ? either([...allowed]) : 'no round document'}; a ${kind} is written ${where}. Nothing was written.`;
}

type Result = { content: { type: 'text'; text: string }[]; details: Record<string, never>; isError?: boolean };
type Executable = { readonly name: string; execute?: (...args: never[]) => unknown };

/**
 * The same tool, refusing at call time what `refusal` refuses (the main job's stage, a lane's slots). The refusal comes
 * back the way a writer's own refusal does, so the model reads it as a refused call and nothing is written.
 */
export function gatedTool<T extends Executable>(tool: T, refusal: (tool: string, args: Record<string, unknown> | null) => string | null): T {
  const run = tool.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
  if (typeof run !== 'function') return tool;
  return {
    ...tool,
    execute: async (...args: unknown[]) => {
      const params = args[1] && typeof args[1] === 'object' ? args[1] as Record<string, unknown> : null;
      const why = refusal(tool.name, params);
      if (why) return { content: [{ type: 'text', text: `ERROR: ${why}` }], details: {}, isError: true } satisfies Result;
      return run.apply(tool, args);
    },
  } as T;
}
