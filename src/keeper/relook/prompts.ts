/**
 * The product re-look prompt (Spec §3.4, §4; CKC-08). The judgement record already exists
 * with the inputs the job received; the model judges and writes notes and assessments against it.
 */

export function relookPrompt(positioning: string, scopeLabel: string, judgementId: string, inputs: string, first: boolean, requestedByOwner: boolean): string {
  return `Task: product re-look · ${scopeLabel}

Project positioning:
${positioning}

Judgement record: ${judgementId} (already recorded with the inputs below; use it as judgementRecordId in pk_write_note and pk_assess_relation).
${requestedByOwner ? 'The owner asked for this re-look.' : first ? 'This is the first product re-look of the project: the owner has no note yet.' : 'This re-look was triggered by a change in this scope.'}

What to judge, starting from the owner’s words — the top layer of the product reference, what the owner said and confirmed — then the product description that refines them, never from the execution record's own justification:
- For each piece of work or path in scope: what it changes in the use experience or capability, what result it protects, how far the actual results support it (observed facts, not claims), why the remaining work is still worth it, whether it is needed at this stage, whether existing capability could carry it, whether there is a more direct route.
- Upward: whether the Modules, requirements, designs, plans and specs are consistent and commensurate with the owner's words they refine (say so on the reference item; that is an interpretation, never the owner's decision). Drift is measured against the owner’s words: a document that says something other than the owner's words it refines has drifted even when the plan and the work below it all follow it — what agrees with the PRD is not on course for that reason. Name which of the owner's words you compared and where the document departs from them.
- A rule or decision marked Decided without owner that touches the product, red lines or users' data: a For your decision note, one note per matter — what it is, who set it and when, where it is in force now, and why it is the owner's to decide. Do not write it as decided by the owner, nor as void because the owner has not decided.
- A note that cites an agent's report says who reported it and when ("the batch 3 receipt, 2026-09-17, says …"); where a check against the code found otherwise, set the two side by side ("… says …; the code does …") — a comparison of facts, not whether anyone was honest.
- Verification: what new valid information a test or QC adds and what current product behaviour it protects; whether repeated investment is proportionate. Never grade by number of tests, rounds, or rarity of a scenario. An important unexplained failure can make further investigation valuable.
- Entry marks (undocumented decisions, layer drift, suspected stale) are facts to weigh, not verdicts.

Outputs:
- ${first ? 'Write one project-level note (mountKind project) that says where the project stands: where it is heading, whether that matches the purpose, which work is worth continuing, where adjustment is needed.' : 'Update the project-level note only if the picture changed; otherwise leave it.'}
- Write an object-level note (mountKind node, relation or path with the ids) only where something is worth explaining: investment not commensurate with effect, an old decision still driving new work, verification of behaviour no longer in scope, an unglamorous foundation that protects user results, a comparison of two adjustment options, a product-direction question the material cannot answer (ask For your decision with the question, why it matters, clues and options). A note may also confirm that current work is sound and worth keeping.
- Note body: only sections with content (currentView, whyItMatters, facts with source ids and inferred flag, otherExplanations, keepAdjust, whatWouldSettleIt). Preview short; body as long as the question needs. Language of the project material. Not in the owner's deciding voice; no judgement of any agent's honesty; no invented phases or dates. Differing conclusions are separate notes, never a score.
- Assess relations with pk_assess_relation: Holds when the facts support the contribution now, Questioned when you have a concrete reason (then a note on the relation or its work must state why), Not assessed if you cannot tell. Do not assess more than you actually judged.
- When there is nothing new of importance: write no new note and say "Reconsidered; no new finding" in your reply. Do not produce a note to show activity.
- Need detail (a file, a test output, git history, a command that changes nothing)? Use pk_investigate; its conclusion and sources are recorded as an input of this judgement. Do not read whole session histories.
- If the assets are wrong or missing something you established, correct them with the pk_* tools and say so.

Reply with: the notes written or updated (id · title · ask), the assessments set, and open questions for the owner, if any.

=== Inputs of this judgement ===
${inputs}`;
}
