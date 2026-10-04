---
name: reconcile
description: The main agent's reconcile stage after the skeleton lanes, in a First usable round and in a Follow up whose document chain changed. Join the lanes' slots into one trunk. Place every work item in its plan and module, and every decision on the module or plan it acts on, from the project's own records. Settle the candidate generations and record where each generation's items went. Write as rules the owner's lines the Owner's words lane reported. Write only what was found; draw no conclusion that something is missing.
---

# Reconcile: join the lanes into one trunk

You are the main agent, in the reconcile stage. Each skeleton lane wrote its slots with sources and handed back a report. You make the writes that span lanes: cross-lane links, merges, placements, numbers, patches, generations, and the rules the lanes reported.

## 1. Read what the lanes produced

- Read every report in full (`pk_read_assets` kind roundDoc). Take a lane's proposal only after checking it against the original.
- `pk_read_assets` without ids gives compact rows; ask for whole records with `ids`. `kind: "area"` gives the Areas.
- **Counts come from `pk_round_state({})`.** Fetch one list only when you act on it: `pk_round_state({ list: "<key>" })`. The keys are named below.

## 2. Build the trunk

- **What the program gates.** `entries`: fill what a lane left (`pk_fill_from_headings`, `pk_fill_from_bold`, `pk_fill_from_table`; a log whole), or account for a number that should not be an item, by its number, with why (`pk_account_entries`). `numberOnly`: rename to the number and title as written. `noIds`, `otherNumbers`: give each ticket its own number; a decision it carries out is recorded with `pk_record_carry_out`, not as its id. `noContract`: each ticket records the contract it implements (`pk_write_thread` `implements`).
- **Place in bulk.** `pk_place_range({ numbers: "D3–D18", to: "M2" })` places a run of numbered items in one call: a decision, boundary, requirement or design refines the target, and a work item serves it. Numbers no item carries come back as `missing`. Use single writes (`pk_relate`, `pk_write_reference`, `pk_write_thread`, `pk_write_area`) for what a run does not cover.
- **Areas, the foundation included.** A cross-cutting foundation the documents treat as a peer of the modules is an Area under the project's own name: `pk_write_reference({ category: "Area", …, foundation: true })`. Conventions that own no work stay in the cross-cutting ring. A new Area places again everything that names it: read `placedAgain` in the result, then `pk_round_state({ list: "misplaced" })`.
- **Every work item in a plan and a module** (`noPlan`, `noModule`), from the project's own records:
  - the plan: the plan or dispatch table that lists it, the prompt's metadata (its increment, batch or milestone), the plan whose contract it implements, or the plan whose decision it carries out. An execution arrangement — a batch, a dispatch table, an execution plan — places the work it lists in the product-layer plan that arrangement executed, whether the arrangement is current or archived; in a project whose only planning layer is such an arrangement, its batches or milestones are the Plan items.;
  - the module: the module its contract belongs to, or the one its dispatch or prompt names.
  - Write it with `pk_write_thread` `serves`: the Area first, then the Plan item, each with a claim citing the record.
  - **A work item serving several modules** gets a `serves` to each of their Areas, and the owner sees it in each one's column: solid in its main module, dashed in the others. **Write the main module's Area first.** The owner's rule for the main one (2026-09-30): 「a.这项工作实现的合同属于哪个模块，就放哪； b.没有合同的，看派工单或提示词写的是哪个模块； c.都没写，才用"写在最前的"。」
    - (a) The module of the contract it implements. When the contract itself names several modules, the one its dispatch ticket or prompt names among them, else the one the contract lists first.
    - (b) With no contract, the module its dispatch ticket or prompt names.
    - (c) With neither, the one its record lists first.
    - `serves` adds after what is there, so the first Area written stays first. To change the main module, give the whole list with `replaceServes: true`, the main Area first.
  - **Work for its whole plan** (a milestone QC across every contract, a reading of the whole graph) serves the Plan item and no Area, and says why: `pk_write_thread({ id, wholePlanWhy })`. It is then placed. `noModule` suggests it where a range the ticket writes spans three modules or more.
  - **Placed by the program.** Where the records lead to a plan or an area — the dispatch table's row, the prompt's metadata, the contract, the decisions it carries out or cites and the plan they sit in, an arrangement current or archived that lists it — the program has placed the item, basis Inferred, with the chain in its claim (`pk_round_state({ list: "inferredPlacements" })`). Check it against that record: keep it, or move it with `replaceServes` and the record that says otherwise. "The program's suggestion is only a pointer" is not a reason to leave an item unplaced.
  - **When the records lead nowhere** — no plan or dispatch table lists the item, no prompt metadata, no contract, no decision it carries out or cites leads to a plan, no arrangement current or archived names it — write the reason on the item: `pk_write_thread({ id, noPlanWhy })` or `noAreaWhy`, naming the records you read. The program refuses the reason when the records do lead somewhere, and says where. "Its arrangement is archived" and "the program's suggestion is only a pointer" are not reasons. A project with no plan layer has nothing in no plan: the program says so, and you write no reason.
- **Every decision where it acts** (`onNothing`, `productOnly`). Boundaries are placed like decisions.
  - **An owner decision** refines the module(s) it acts on: what its own lines name (an "affects" or "documents changed" line, whatever the project calls it) and where the documents cite it. One that sets a trial or execution arrangement refines the plan it shapes.
  - **An execution decision** (an entry in the log of how work was carried out) refines the product-layer Plan whose work it records. Follow the arrangement the entry belongs to — a batch, a dispatch table, an execution plan, current or archived — to the plan that arrangement executed, and write that Plan. An archived arrangement is not "no plan": it is the record of how a current or an earlier plan was carried out; its entries go to that plan, or into that generation when the plan is an earlier generation's.
  - **An earlier generation's decision** refines that generation's plan, not the Product.
  - **The program traces the Product-only ones.** `pk_round_state({ list: "traceable" })` gives, for each, what its entry names, where the documents cite it, and the Areas and Plans suggested. Place by the suggestion, or say why not.
  - **The Product only** for a decision that really concerns the whole product, written with its reason: `pk_write_reference({ id, wholeProductWhy })`. Without the reason it counts as not placed. The foundation is an Area, not the whole product.
  - `pk_write_reference` `refines` replaces the old list, so give it whole.
- **Designs** the program flags (`designsWide`, `designsUnplaced`): cut again where each section serves one area, or name them for the deepening's lane with `reference:Design`.
- **Cross-lane links.** A delivery the execution lane found belongs to the work item the plan lane created: tie it with `pk_link_process`, saying why in one sentence. The program checks the evidence as the link is written, and the result says when a link is suspect.
- **Duplicates.** One unit of work is one work item (`pk_merge_work_items`). Of duplicate reference items one stays; the other gets validity Replaced and replacedBy.
- **Numbers.** A unit of work without the project's own number gets a Keeper number (`pk_number`).
- **Supersession.** For every explicit supersession line the ledger lists (`pk_ledger_supersessions`) that no lane drafted, draft a semantic patch (`pk_write_patch`, Draft): what no longer holds and what replaces it, who is affected, what must never again pass as current, and whether only part was withdrawn.
- **Earlier generations.** Give every candidate still waiting its verdict (`pk_round_state({ list: "generationCandidates" })`, `pk_generation_candidate`); `pk_write_generation` is for a generation the program did not list. Each generation holds its planned items (`generationsWithoutItems`; copy a plan table with `pk_fill_from_table`, a deleted document at the commit before its deletion). Every item gets a destination (`withoutDestination`):
  - **carried on into the current plan:** validity Replaced, replacedBy the current work item that took it up. `pk_write_thread({ id, validity: "Replaced", replacedBy: "T-04" })` takes an id or the project's own number;
  - **finished, and built upon:** progress Done from the evidence, and the current work that builds on it depends on it (`dependsOn`);
  - **dropped:** validity Abandoned, with the decision or cleanup that ended it cited in its results.

  Never label a generation as simply abandoned. The owner: 「这两代不是完全废弃了，只是当时做到了一半或者全做完了，然后后面的其实在他基础上做的」.
- **Decisions carried out**, or not yet, with evidence in a lane's report: `pk_record_carry_out`.
- **Contradictions.** Check the original. Say which evidence decides, or keep both side by side (`contradicts`, Open).

## 3. The owner's lines

You get only a count. The lane with `reference:Owner's words` had the full list and wrote the Owner's words items. Write as rules the lines the Owner's words lane reported under "Lines that set a working rule": `pk_write_rule`, basis Explicit, the owner's own words as the excerpt, the session segment as the source. An agent's paraphrase is not the owner's words, and neither is agent text the owner quoted or pasted. When no lane held the slot, say so in the round's documents.

## 4. Work merged without a task number

A block given with this stage lists each piece (a merged branch, or a run of direct commits) with its commits, the numbers its messages name, whose files it changed, and the records that name it. Apply the owner's rule (2026-09-28) to every piece:

- **It needs a work item of its own** when it changes the system's behaviour, a contract or the architecture, or is clearly worth tracking later. Write it with `pk_write_thread`, give it a Keeper number (`pk_number`), and tie its commits and merge to it (`pk_link_process`, Delivered and Merged).
- **It may fold into its parent** when it is a pure repair, a test-stability fix, or a supporting fix that an existing task needed to finish. Tie its merge or commits to the parent as a Fix (`pk_link_process`).
  - List it in the parent's results (`pk_write_thread` results: the branch, its merge commit, what it repaired). A fix folded in without being listed there does not meet the rule.
- **Finding the parent.** The parent is the work whose contract or files the piece served: the contract or work item its messages name, else the numbered work whose own commits changed the same files. A fix of a QC's findings serves the work the QC checked, not the QC.
- **Mixed pieces.** A piece whose commits are of different kinds is judged commit by commit. A piece of an earlier generation is history: it goes under its generation, never as current work.

## What reconcile never does

- **No missing conclusions.** Don't conclude that anything is missing: no "not started", "no trace of done", "not checked" or "dropped". The program's breakpoint candidates stay candidates in this round.
- **No notes, send-backs or six-thing judgements.** The synthesis writes those, after you, in a session of its own.

## Then

- Call `pk_round_state({})` once more. `entries` is 0, every candidate generation has its verdict, and every item still unplaced carries a recorded reason the program accepted (`noPlanWhy`, `noAreaWhy`, `wholeProductWhy`); the handover's `open` names each by it.
- First usable: hand over with `pk_stage({ to: "synthesis", handover: { settled, open, first } })`, refused while `entries` counts a number. The synthesis was not there: it reads the lane reports and your handover. `settled`: what you joined, placed and decided across lanes; `open`: which items stay unplaced and why, and anything else left; `first`: where it should look first. Keep it short. Then write nothing more: end with a short summary.
- Follow up: `pk_stage({ to: 'dig' })` when the questions need lanes. Otherwise `pk_stage({ to: 'cross-check', why })`.
