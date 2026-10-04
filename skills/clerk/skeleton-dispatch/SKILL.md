---
name: skeleton-dispatch
description: The main agent's skeleton stage in a First usable round, and in a Follow up whose document chain changed. Send the skeleton lanes, one per group of workbench slots and grouped by the project's document chain, all in one pk_send_lanes call. Each lane copies what the documents state with the fill tools and writes its slots with sources. One lane holds the owner's lines. Once every lane has come back, read the reports and move on to reconcile.
---

# Skeleton: send the lanes that fill the slots

You are the main agent, in the skeleton stage. Orientation mapped the document chain onto the workbench's slots and wrote a brief per lane. Now the lanes build the trunk in parallel: owner's words → product → areas → requirements, designs, decisions → plans → work items. You reconcile it in the next stage.

## 1. Check the briefs before you send

- **Every lane has a `Brief`** of this round, in its seven parts. Write a missing one now (`pk_write_round_doc` kind `Brief`, `path` = the lane's name) and keep its id.
- **Lanes follow the project's document chain**, one per group of slots, never split by size. No two lanes write the same slot for the same material: where they border (a contract is both a Requirement and a work item), the briefs say which lane writes and which only proposes.
- **Every decision log goes whole to a lane with `reference:Decision`.** No brief selects entries. A plan's own execution decisions are a log too.
- **One lane holds `reference:Owner's words`:** the product lane, or a lane of its own. The program gives it the full list of the owner's lines. It writes the Owner's words items and reports the lines that set a working rule.
- **A lane with `generations` gets `threads` automatically**, to write each generation's items and where each went.
- **Designs** are cut per Spec section, where a section serves one area. No brief cuts them by chapter.
- **A small table no lane owns:** copy it yourself (`pk_fill_from_table`, `pk_fill_from_headings`, `pk_fill_from_bold`).

## 2. Send all lanes in one call

Call `pk_send_lanes` **once, with every lane in the `lanes` array.** Lanes sent one per call run one after another.

```
pk_send_lanes({ lanes: [
  { name: "Product and modules", kind: "slot", briefDocId: "<id>", slots: ["reference:Owner's words", "reference:Product", "reference:Goal", "reference:Area"] },
  { name: "PLAN and contracts",  kind: "slot", briefDocId: "<id>", slots: ["reference:Requirement", "reference:Plan", "reference:Decision", "threads", "relations"] },
  { name: "Execution and delivery", kind: "slot", briefDocId: "<id>", slots: ["links", "generations"] },
  …
] })
```

- **kind** is `slot`. **slots** are `reference:<category>` (Owner's words, Product, Goal, Area, Requirement, Design, Decision, Plan, Boundary), `threads` (work items), `links` (a delivery, merge, verdict or dispatch tied to a work item's step), `territories`, `patches`, `generations`, `relations`. Give a lane only the slots its brief asks it to write.
- **A slot no lane holds is listed back** before anything is sent: add it to a lane, or say why the project has nothing for it (`empty: [{ slot, why }]`).
- **The call waits for every lane** and returns each one's `status` (`Done`, `Listed` or `Stopped`), `summary` and `reportDocId`.
- **Sending again is safe:** a lane is known by its name within the round. After a restart, call `pk_lanes` or send the same call again.
- **A lane that comes back Listed** failed too often. Send its question again under a new name with a narrower brief, or take its slots up yourself in reconcile.

## 3. When the lanes are back

- Read every report in full (`pk_read_assets` kind roundDoc). A lane copies what the documents state, then judges the rest, and writes only what it found. What it looked for and did not find is a clue for the deepening.
- Read the counts in `pk_round_state({})`. Reconcile takes up what is open.
- Then `pk_stage({ to: 'reconcile' })`.
