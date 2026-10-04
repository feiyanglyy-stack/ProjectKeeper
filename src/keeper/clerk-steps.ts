/**
 * Which step of a round of the clerk method writes which of the clerk method's own positions (Spec v3.0 §3.3
 * “跨对象的记录由哪一步写”). One table for both sides: a writer refuses a step not listed for it (clerk-tools.ts), and
 * a step is offered exactly the writers that list it (roles.ts `STEP_WRITES`), so a step is never offered a writer
 * that then refuses it, nor denied a correction the writer allows. The spot-check corrects through the same writers,
 * on records that already exist.
 */
import type { ClerkStage, RoundDocKind, RoundStepKind, SlotKind } from '../model/k-types.ts';

/**
 * The round documents each step writes; a round document is written by the step listed for its kind. The synthesis
 * (D103: a job of its own) writes the round's Result; the spot-check, which checks every claim of it, corrects a Result
 * that is there (clerk-tools.ts `pk_write_round_doc`).
 */
export const DOCS_BY_STEP: Readonly<Partial<Record<RoundStepKind, readonly RoundDocKind[]>>> = {
  orientation: ['Questions', 'Brief', 'History map'],
  dig: ['Report'],
  'cross-check': ['Adoption'],
  synthesis: ['Result'],
  'spot-check': ['Spot check', 'Result'],
};

export const CLERK_WRITER_STEPS = {
  pk_write_session_draft: ['session-drafts'],
  pk_write_layers: ['orientation', 'spot-check'],
  pk_write_generation: ['orientation', 'skeleton', 'cross-check', 'spot-check'],
  pk_write_round_doc: Object.keys(DOCS_BY_STEP) as RoundStepKind[],
  pk_write_patch: ['skeleton', 'cross-check', 'spot-check'],
  pk_number: ['skeleton'],
  pk_link_process: ['skeleton', 'cross-check'],
  pk_confirm: ['cross-check', 'spot-check'],
  pk_suggest_sendback: ['cross-check', 'synthesis'],
  pk_tag_six: ['cross-check', 'synthesis', 'spot-check'],
  pk_confirm_note: ['synthesis'],
  pk_write_territory: ['cross-check', 'spot-check'],
  pk_record_spot_check: ['spot-check'],
} as const satisfies Readonly<Record<string, readonly RoundStepKind[]>>;

export type ClerkWriter = keyof typeof CLERK_WRITER_STEPS;

/** The clerk method's writers a step is offered. */
export function clerkWritersOf(step: RoundStepKind | string): ClerkWriter[] {
  return (Object.keys(CLERK_WRITER_STEPS) as ClerkWriter[]).filter((t) => (CLERK_WRITER_STEPS[t] as readonly string[]).includes(step));
}

/**
 * The steps of a round in the method's order (§3.3); D99's main agent and its lanes last, so each has its own model setting
 * (CKC-23 AC-11). D103: `synthesis` is a step of its own again; left unset, it runs on what `main` is set to (`STEP_SETTING_AS`).
 */
export const ROUND_STEP_KINDS = ['ledger', 'session-drafts', 'orientation', 'skeleton', 'dig', 'cross-check', 'process', 'synthesis', 'spot-check', 'main', 'lane'] as const satisfies readonly RoundStepKind[];
/** The program's steps: the ledger (§1.16) and the process with its breakpoints (§2.12). Every other step runs a model. */
export const PROGRAM_STEP_KINDS: readonly RoundStepKind[] = ['ledger', 'process'];
export const MODEL_STEP_KINDS: readonly RoundStepKind[] = ROUND_STEP_KINDS.filter((k) => !PROGRAM_STEP_KINDS.includes(k));

/**
 * A step whose model setting, left unset, is another step's (D103): the synthesis runs on what the main agent is set to,
 * so a home whose settings were written before the synthesis had a session of its own keeps running it on the same model.
 */
export const STEP_SETTING_AS: Readonly<Partial<Record<RoundStepKind, RoundStepKind>>> = { synthesis: 'main' };

/** A step's model setting as it takes effect: its own, each part it leaves unset taken from the step it defaults to. */
export function stepSettingOf<T extends { readonly model?: string; readonly thinking?: string }>(steps: Readonly<Partial<Record<string, T>>> | null | undefined, kind: RoundStepKind): { readonly model?: string; readonly thinking?: string } | undefined {
  const own = steps?.[kind];
  const as = STEP_SETTING_AS[kind];
  const from = as ? steps?.[as] : undefined;
  if (!own && !from) return undefined;
  const model = own?.model ?? from?.model;
  const thinking = own?.thinking ?? from?.thinking;
  return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}

/** pi's thinking levels (`ThinkingLevel`), for the per-step setting (CKC-03 AC-29). */
export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

// ───────────────────────── D99: the main agent's stages and the lanes' slots (W0 contract) ─────────────────────────

/** The trunk's writers from before the clerk method (roles.ts `TRUNK_WRITES`), named here for the D99 tables. */
const TRUNK = ['pk_write_reference', 'pk_write_thread', 'pk_write_area', 'pk_relate', 'pk_write_mark', 'pk_merge_work_items', 'pk_record_carry_out', 'pk_check_decisions', 'pk_set_used_as'] as const;

/** Tools the main agent has in every stage (D99): moving between stages, where the round stands, its lanes. */
export const MAIN_ALWAYS = ['pk_stage', 'pk_round_state', 'pk_lanes'] as const;

/**
 * What the main agent writes in each stage (D99; Spec §3.3 "谁写什么"). Its session is offered the union; a writer
 * refuses outside the stages that list it (gate at call time, E148 D-a). Round documents by kind follow `DOCS_BY_STAGE`.
 * D103: the main agent writes nothing in the synthesis — it hands over, and the synthesis job writes what the stage wrote
 * (`SYNTHESIS_WRITERS`).
 */
export const STAGE_WRITERS: Readonly<Record<ClerkStage, readonly string[]>> = {
  orientation: ['pk_write_rule', 'pk_classify_scope', 'pk_set_used_as', 'pk_write_organizing_plan', 'pk_write_layers', 'pk_write_generation', 'pk_generation_candidate', 'pk_write_round_doc'],
  skeleton: ['pk_write_round_doc', 'pk_send_lanes', 'pk_fill_from_table', 'pk_fill_from_headings', 'pk_fill_from_bold', 'pk_account_entries'],
  reconcile: [...TRUNK, 'pk_judge_owner_lines', 'pk_write_rule', 'pk_number', 'pk_link_process', 'pk_write_patch', 'pk_write_generation', 'pk_generation_candidate', 'pk_place_range', 'pk_fill_from_table', 'pk_fill_from_headings', 'pk_fill_from_bold', 'pk_account_entries'],
  dig: ['pk_write_round_doc', 'pk_send_lanes'],
  coverage: ['pk_coverage_check', 'pk_account_material', 'pk_account_entries', 'pk_write_round_doc', 'pk_send_lanes'],
  'cross-check': [...TRUNK, 'pk_judge_owner_lines', 'pk_write_rule', 'pk_account_entries', 'pk_confirm', 'pk_link_process', 'pk_write_patch', 'pk_write_generation', 'pk_generation_candidate', 'pk_place_range', 'pk_suggest_sendback', 'pk_tag_six', 'pk_write_territory', 'pk_write_round_doc'],
  synthesis: [],
};

/**
 * What the synthesis job writes (D103; Spec §3.3 the stage table's 合成 row: note, the six things, `Suggested` send-backs,
 * area understanding, the round's Result). What the main agent's synthesis stage wrote before it — the notes, the
 * judgement record and relations it reached, the rules note, marks, an investigation, send-backs, the six things, the
 * round's Result — and the two D103 gives the synthesis: area understanding (`pk_write_area`, which the stage did not
 * offer), and `pk_confirm_note`, the result "still holds" for a note standing from an earlier round (standing-notes.ts).
 * roles.ts offers exactly these (`STEP_WRITES.synthesis`).
 */
export const SYNTHESIS_WRITERS = ['pk_write_note', 'pk_close_note', 'pk_record_judgement', 'pk_assess_relation', 'pk_ask_owner_about_rules', 'pk_write_mark', 'pk_investigate', 'pk_suggest_sendback', 'pk_tag_six', 'pk_write_round_doc', 'pk_write_area', 'pk_confirm_note'] as const;
/** What the synthesis job is offered besides its writers and the reads every step has: where the round stands, counted, and one list at a time. */
export const SYNTHESIS_ALWAYS = ['pk_round_state'] as const;

/** The round documents the main agent writes in each stage (D99). */
export const DOCS_BY_STAGE: Readonly<Record<ClerkStage, readonly RoundDocKind[]>> = {
  orientation: ['Questions', 'Brief', 'History map'],
  skeleton: ['Brief'],
  reconcile: [],
  dig: ['Brief'],
  coverage: ['Brief'],
  'cross-check': ['Adoption'],
  synthesis: [],
};

/** What a lane may write, by the slot kind it was given (D99, E148 D-d); `reference:<category>` is checked by category too. */
export const SLOT_WRITERS: Readonly<Record<'reference' | Exclude<SlotKind, `reference:${string}`>, readonly string[]>> = {
  // DA: `pk_judge_owner_lines` is the Owner's words lane's (stage-gate.ts checks the category, as for the items).
  reference: ['pk_write_reference', 'pk_judge_owner_lines', 'pk_fill_from_table', 'pk_fill_from_headings', 'pk_fill_from_bold', 'pk_place_range'],
  threads: ['pk_write_thread', 'pk_number', 'pk_merge_work_items', 'pk_record_carry_out', 'pk_fill_from_table', 'pk_place_range'],
  links: ['pk_link_process'],
  territories: ['pk_write_territory'],
  patches: ['pk_write_patch'],
  generations: ['pk_write_generation', 'pk_generation_candidate'],
  relations: ['pk_relate', 'pk_place_range'],
};

/** What every lane may write whatever its slots (D99): its own Report, and where it looked for a missing step. */
export const LANE_ALWAYS = ['pk_write_round_doc', 'pk_record_looked'] as const;
/** The round document a lane writes. */
export const LANE_DOCS: readonly RoundDocKind[] = ['Report'];

/**
 * The main agent's stages in each kind of round, in order (D99; Spec §3.3, §3.7, §3.8). D103: its session ends after its
 * last check — the reconciling of a first usable round, the cross-check of a deepening and a Follow up — with a handover
 * to the synthesis, which runs in a session of its own.
 */
export const ROUND_STAGES: Readonly<Record<'First usable' | 'Deepen' | 'Follow up', readonly ClerkStage[]>> = {
  'First usable': ['orientation', 'skeleton', 'reconcile'],
  Deepen: ['orientation', 'dig', 'coverage', 'cross-check'],
  'Follow up': ['orientation', 'skeleton', 'reconcile', 'dig', 'coverage', 'cross-check'],
};

/** What the main agent hands the round over to with `pk_stage` once its last stage is done (D103): the synthesis. */
export const HANDOVER_TO: ClerkStage = 'synthesis';
