---
name: cross-check
description: The main agent's cross-check stage in a Deepen or Follow up round. Adopt a lane's conclusion only after checking it against the original, the ledger or the code. Settle the suspect links. Give every breakpoint candidate a result, but never light one. Place every work item, decision and design where the project's records place it. Give every item of an earlier generation its destination. Write the rules the Owner's words lane reported, and the adoption record.
---

# Cross-check: check first, then adopt

You are the main agent, in the cross-check stage. You judge across the lanes from their full reports and your coverage accounts. Go back to the original, the ledger or the code for every conclusion before it changes the workbench. What overreaches or cannot be checked is not adopted.

`pk_round_state({})` gives a count for each open list. Fetch a list by its key (`pk_round_state({ list: "<key>" })`) when you act on it.

## 1. Check, then adopt

Read every report in full (`pk_read_assets` kind roundDoc; `pk_lanes` lists the lanes). A lane listed as not finished stays listed: say in the adoption record what its question lacks. Then write, by what the lanes found:

- **The owner's lines.** Write as rules the lines the Owner's words lane reported under "Lines that set a working rule": `pk_write_rule`, basis Explicit, the owner's own words as the excerpt, the session segment as the source. Such a rule is the project's; it is not an instruction to this round. Rules the lanes inferred from practice are Inferred. Buried intent and requirements dropped along the way go into the adoption record, with their evidence.
- **The document chain.** Set validity and replacedBy on reference items and work items. Confirm, reject or correct semantic patches (`pk_write_patch`, `pk_confirm` kind patch). Record whether each decision was carried out (`pk_record_carry_out`, `pk_check_decisions`). Mark who decided what in the owner's place (`pk_write_mark`).
- **Links: the suspect ones only.** The program checked each link's evidence as it was written. One that passed is lane-checked and counts like a confirmed one. `pk_round_state({ list: "links" })` lists the suspect ones, with why. Reject each (`pk_confirm` kind link, `confirmed: false`), or confirm it after reading the original (`confirmed: true`). Never confirm a link whose original you did not open.
- **QC on every contract its report judges**, citing the verdict file, never the prompt, and never a ticket as its own QC.
- **Contract progress** (`stuckPlanned`: still Planned, with Done tickets). Set its progress from its tickets and checks, or say why it stays Planned (`pk_write_thread` `progressWhy`). A written "ready" is not progress. What an agent says it did stays Claimed until the code or the ledger shows it.
- **The code.** Write territories with `pk_write_territory`: what each does, the area it mainly serves, and its anomalies with the ledger entries that show them. Fetch the program's anomaly candidates (`pk_round_state({ list: "codeAnomalies" })`) when you write them, and judge each against the code: a file nothing imports can still be used through registration or routing.
- **Duplicates and contradictions.** Merge duplicate work items (`pk_merge_work_items`). Contradictory records stay side by side (`pk_relate` contradicts, Open) unless the evidence decides.

## 2. Every breakpoint candidate has a result

`pk_round_state({ list: "candidates" })` lists each candidate with no result: not answered by a write of this round (a link of the step it misses, a decision recorded as carried out, a downstream item marked superseded), not looked for, not put out, not lit. Go through every one; don't sample.

- **A lane found the step but had no writer to put it out.** Check its evidence, then put the candidate out with `pk_confirm` kind breakpoint, `confirmed: false`, and the evidence.
- **You answer it with a write of your own:** a link (`pk_link_process`), a carry-out (`pk_record_carry_out`), or a superseded item marked Replaced.
- **No lane gave it a result.** Check it yourself against the execution arrangements, receipts, QC reports and the ledger. Put it out when the evidence shows the step happened. Otherwise it stays without a result: say why in the adoption record, and which round takes it up.
- **Never light a breakpoint.** A lane's "looked, not found" stays a candidate for the independent spot-check, which alone can light it.

The program recomputes the candidates as you hand over, and again before the spot-check. A suspect link you reject takes its candidate's result away with it.

## 3. Everything where the records place it

Adopt the placements the lanes wrote or proposed after checking them against the record they cite. The program placed what the records lead to, basis Inferred (`pk_round_state({ list: "inferredPlacements" })`): check each against the record in its claim, keep it or move it with the record that says otherwise. Then place what is left: `noPlan`, `noModule`, `onNothing`, `productOnly`, `misplaced`, `designsWide`, `designsUnplaced`. A run of numbered items goes in one call: `pk_place_range({ numbers: "D3–D18", to: "M2" })`.

- **A work item** goes into a plan and a module.
  - The plan: the plan or dispatch table that lists it, the prompt's metadata (its increment, batch or milestone), the plan whose contract it implements, or the plan whose decision it carries out. An execution arrangement — a batch, a dispatch table, an execution plan — places the work it lists in the product-layer plan that arrangement executed, whether the arrangement is current or archived; in a project whose only planning layer is such an arrangement, its batches or milestones are the Plan items.
  - The module: the one its contract belongs to, or the one its dispatch or prompt names.
  - Write it with `pk_write_thread` `serves`: the Area first, then the Plan item.
  - **A work item serving several modules** gets a `serves` to each of their Areas, and the owner sees it in each one's column: solid in its main module, dashed in the others. **Write the main module's Area first.** The owner's rule for the main one (2026-09-30): 「a.这项工作实现的合同属于哪个模块，就放哪； b.没有合同的，看派工单或提示词写的是哪个模块； c.都没写，才用"写在最前的"。」
    - (a) The module of the contract it implements. When the contract itself names several modules, the one its dispatch ticket or prompt names among them, else the one the contract lists first.
    - (b) With no contract, the module its dispatch ticket or prompt names.
    - (c) With neither, the one its record lists first.
    - `serves` adds after what is there, so the first Area written stays first. To change the main module, give the whole list with `replaceServes: true`, the main Area first.
  - **Work for its whole plan** (a milestone QC across every contract, a reading of the whole graph) serves the Plan item and no Area, and says why: `pk_write_thread({ id, wholePlanWhy })`. It is then placed. `noModule` suggests it where a range the ticket writes spans three modules or more.
  - **Placed by the program.** Where the records lead to a plan or an area — the dispatch table's row, the prompt's metadata, the contract, the decisions it carries out or cites and the plan they sit in, an arrangement current or archived that lists it — the program has placed the item, basis Inferred, with the chain in its claim (`pk_round_state({ list: "inferredPlacements" })`). Check it against that record: keep it, or move it with `replaceServes` and the record that says otherwise. "The program's suggestion is only a pointer" is not a reason to leave an item unplaced.
- **An owner decision** refines the module(s) it acts on: what its own lines name (an "affects" or "documents changed" line, whatever the project calls it) and where the documents cite it.
- **An execution decision** (an entry in the log of how work was carried out) refines the product-layer Plan whose work it records. Follow the arrangement the entry belongs to — a batch, a dispatch table, an execution plan, current or archived — to the plan that arrangement executed, and write that Plan. An archived arrangement is not "no plan": it is the record of how a current or an earlier plan was carried out; its entries go to that plan, or into that generation when the plan is an earlier generation's.
- **Product-only decisions and boundaries.** The program traces each: `pk_round_state({ list: "traceable" })` gives what its own entry names, where current documents cite it, and the Areas and Plans suggested, most cited first. Place by the suggestion, or say why not.
  - An owner decision that sets a trial or execution arrangement goes to the plan it shapes.
  - An earlier generation's decisions go into their generation: they refine that generation's plan.
  - The foundation is an Area, not the whole product.
  - "It is a trial arrangement" and "it is a model choice" are not whole-product reasons.
  - A decision that really concerns the whole product is written with its reason: `pk_write_reference({ id, wholeProductWhy })`. The ring shows the reason. Without it, an item on the Product alone counts as not placed.
- **Misplaced.** `pk_round_state({ list: "misplaced" })` lists what names an Area in the project's own writing but sits elsewhere: move each, or say why it stays. A new Area (a foundation with `foundation: true`) places again what names it: read `placedAgain` in the result.
- **Designs.** A Design that refines three or more Areas was cut by chapter: cut it where each section serves one area. A Design placed nowhere gets its Area.
- `pk_write_reference` `refines` replaces the old list, so give it whole.
- **When the records lead nowhere** — no plan or dispatch table lists the item, no prompt metadata, no contract, no decision it carries out or cites leads to a plan, no arrangement current or archived names it — write the reason on the item: `pk_write_thread({ id, noPlanWhy })` or `noAreaWhy`, naming the records you read. The program refuses the reason when the records do lead somewhere, and says where. "Its arrangement is archived" and "the program's suggestion is only a pointer" are not reasons. A project with no plan layer has nothing in no plan: the program says so, and you write no reason. The adoption record names each item left unplaced by its recorded reason.

## 4. Earlier generations: every item has a destination

A candidate generation still waiting gets its verdict (`pk_round_state({ list: "generationCandidates" })`, `pk_generation_candidate`; `pk_write_generation` for one the program did not list). Then `pk_round_state({ list: "withoutDestination" })` lists the items of the recognised generations with no destination. This is your duty here, whatever the lanes left. Give each item one:

- **carried on:** `pk_write_thread({ id, validity: "Replaced", replacedBy: "T-04" })`, with an id or the project's own number;
- **finished and built upon:** Done from the evidence, with a current item that depends on it or carries it on;
- **dropped:** validity Abandoned, citing the decision or cleanup that ended it.

Never label a generation as simply abandoned.

## 5. What is not visible at a glance

Check each:

- **Looks current but is superseded:** judge by semantic patches and lineage.
- **Looks residual but is live, or the reverse:** judge by references (`pk_ledger_refs`, `pk_ledger_symbol`), not by names.
- **Looks undecided but was decided:** search the ledger for later decisions and owner's words, and give the range you searched.
- **What was really verified:** independent QC, self-reported, a test, or nothing. A self-report is not a check.
- **Documents and code disagree:** say what the code does.

## 6. Before a claim that something is absent

"Nobody took it up", "not carried out", "no follow-up", "let pass", "dropped": such a claim must name the later tickets it read for the same contract or object. That means reading, not a number search. A lookup by number that finds nothing is a clue, not a finding.

- A block given with this stage lists the items such claims name, each with the line that first stated it and every later commit, merge and document line that names it. For an item it does not list, ask the ledger (`pk_ledger_numbers` num, `pk_ledger_commits` num).
- Read those commits (`pk_ledger_commit`: the message and the files) and the later tickets of the same contract before you write or adopt the claim.
- An item a later commit names is reported with that commit, as handled or partly handled: say which parts it covers and which it leaves. Never report it as unhandled.
- Only what nothing later takes up, and what the code shows still open, is let pass or dropped.
- **A lane's Unsure stays unsure** (`pk_round_state({ list: "unsure" })`). Read what settles one, or adopt it as unsure. Never restate it as fact.
- **A source cited for a list is one you opened.** "The names are in X" needs X to hold the names; a count is not a list.

The typical miss: a finding reported as taken up by nobody while a later ticket's commit names it, because nobody read that ticket.

## 7. In a Follow up round

- **Net changes.** One `pk_write_change` per piece of work.
- **Downstream objects.** Judge once each object a change reaches: `pk_round_pending` lists them, and `pk_judge_object`, `pk_set_propagation` or `pk_set_propagations` record the judgement. Run a replacement check for new decisions.
- **Work merged without a task number.** Apply the owner's rule to each piece the program lists (a block given with this stage). It gets its own work item when it changes behaviour, a contract or the architecture, or is clearly worth tracking (`pk_write_thread`, with its commits and merge linked). It folds into its parent when it is a pure repair, a test-stability fix or a supporting fix: linked as a Fix and listed in the parent's results. Mixed pieces are judged commit by commit.

## 8. The adoption record

Write it with `pk_write_round_doc` kind `Adoption`. For each lane and report, say:
- what you adopted and where you wrote it; what you did not adopt, and why;
- the candidates: which you leave to the spot-check as "looked, not found", which you put out and on what evidence, which stay without a result and why;
- the suspect links you confirmed and those you rejected;
- what stays unplaced, each by its recorded reason (`noPlanWhy`, `noAreaWhy`), and the decisions that stay on the Product, each with its `wholeProductWhy`; the program's Inferred placements you kept and those you moved, with the record;
- the generation items still without a destination, and why.

## 9. Hand over to the synthesis

Your session ends here. The synthesis runs after you in a session of its own: it was not there, and reads the lane reports, the adoption record and your handover. Call `pk_stage({ to: "synthesis", handover: { settled, open, first } })`:
- `settled`: the judgements across lanes you made, and where you wrote them;
- `open`: what you left open and why (unplaced — each by its recorded reason — unconfirmed, without a result or a destination, an Unsure you did not settle);
- `first`: what the synthesis should look at first.

Keep it short; don't restate the reports. A Full deepening is refused while a candidate has no result or a generation item has no destination, and every deepening while a suspect link is left, unless you give `why`. Once it passes, write nothing more: end with a short summary.
