---
name: coverage
description: The main agent's coverage stage, after the dig lanes. The program lists the planned materials no lane touched, grouped by category and directory, and accounts by itself for the reports and prompts the workbench already cites. Account for every listed group honestly, as not needed or as read in part on purpose and why, or send a follow-up lane to read it, then check again. A group that holds what nothing carries is never accounted for as a group. Send the open candidates and unplaced items with a follow-up lane.
---

# Coverage: every planned material is accounted for

You are the main agent, in the coverage stage, after the dig lanes. Before you cross-check, each material the round planned to read has an outcome: a lane read it, the program accounts for it, or you say why it is not needed. This stage finds what nobody got to.

## 1. See what is untouched

`pk_coverage_check({})` returns `untouched` (groups by category and directory, each with its `holds`), `accounted`, `cited` and `settled`. Pass `group` to see one group's members.

- The list is what the organizing plan says to read closely plus what the briefs named, checked against the lanes' actual reads.
- **The program accounts for cited reports and prompts** (`cited`): one that a work item or a decision entry already cites is not listed. A follow-up lane reads only what is listed.

## 2. Account for each group, honestly

- **Account for it:** `pk_account_material({ group, outcome, why })` with the group's id exactly as listed, or `keys` for single materials.
  - `not needed`, with the real reason: settled by a named rule; third-party or generated; the same content as material lane X read; outside every question of this round (say which question it would serve).
  - `part`: read in part on purpose. Say which part, and why the rest does not matter.
  - "Not needed" is not a way to close the list. A group that could hold what a question asks about (the owner's words, a decision, a delivery, a QC finding) needs a lane.
- **Or send a follow-up lane.** Write its brief in the seven parts (`pk_write_round_doc` kind `Brief`, `path` = the lane's name): part 3 names the listed materials by key or group and the questions they serve; part 7 names the slots. Send it with `pk_send_lanes`, kind `follow-up`. When several groups need lanes, send all of them in one call.

**A group with `holds` is never accounted for as a group.** `holds` is the program's count of what its materials hold that nothing carries (verdict lines no work item links, numbers no item carries, the owner's lines not looked at yet): send a lane for the materials it names, or account for each by key with its own reason (`each: [{ key, why }]`).

**The open items are follow-up work too.** This is the last stage that sends lanes.
- **Candidates with no result.** Every one goes into a follow-up lane's brief, by id, with its kind and object (`pk_round_state({ list: "candidates" })`).
- **Unplaced work items and decisions** (`noPlan`, `noModule`, `onNothing`). Where the records that place them sit in a group no lane read, the follow-up lane reads it and places them, with `threads`, `reference:Decision` or `relations`. The program's inferred placements stand unless a lane moves them with the record; a follow-up lane writes `noPlanWhy` or `noAreaWhy` only where the records lead nowhere.

Check again when the lanes are back, until `settled` is true. Time, tokens and the number of lanes are not capped.

## 3. Then

`pk_stage({ to: 'cross-check' })`. At Full depth it is refused until coverage is settled. At every depth it is refused while `entries` counts a number no item carries: a follow-up lane with `reference:Decision` fills a log whole, or you account for a number with `pk_account_entries`. At Focused depth and in a Follow up, still account honestly for what the list shows.
