---
name: table-follow-up
description: Daily upkeep of a project taken over by the ProjectKeeper table. Bring the table up to date with what changed since its asOf, and hand it in through pk_write_table.
---

# Table follow-up

This project was taken over by filling in one JSON table, the ProjectKeeper table. Its guide comes after the brief. Your job is the upkeep: carry the same table on for what changed since it was last filled in. The brief lists those changes: the commits since the table's `asOf`, the documents they changed, and the owner's new messages, each with the agent message it answers.

## What to do

1. Read the brief, then the table: your working copy, named in the brief.
2. Read in the project whatever you need in order to understand a change: the files, git, and the `pk_ledger_*` tools.
3. Edit the working copy for what changed, and nothing else:
   - **Work items:** `progress`, `open`, `accepted`. Add `steps` only where the program cannot find the step by the work's id. Add a new work item when the project's own plan added one.
   - **Requirements, designs, decisions, plans:** add the new ones, and change the ones that changed.
   - **The owner's wants:** add a new want, or record a turn of an existing one under `changed`.
   - **Statuses:** a whole entry that was overturned becomes `Replaced`, with `replacedBy`. When only part of it was overturned, it stays `Current` and gets `partlyReplaced`.
   - **Code:** change a territory's `paths` when code moved.
   - **Notes:** add a note for what now needs the owner's attention, and remove a note that no longer applies.
   - **`project.filledBy.read`:** in one or two sentences, say what you read this time.
4. Call `pk_write_table`. It checks the whole table: its shape, every id and reference, and every source against the project at the new `asOf`. Then it either takes the table in, or refuses with a list of problems. Fix each problem in the working copy and call it again.
5. Once the table is taken in, end with a few sentences: what you changed, and why.

## How

- **Leave alone what the changes do not touch.** Keep the same ids, the same wording and the same sources. Never rewrite, reorder or reword the table as a whole.
- **Keep the grain:** as few entries as still make the project clear.
  - Fold a change into the entry it belongs to.
  - One entry per thing that matters, not one per commit or per message.
  - A commit or a session is never a work item by itself.
- **Give every new or changed entry a source:**
  - a file with its lines;
  - a commit;
  - a session message, written as the brief names it: `{ "session": "claude:…", "message": 12 }`.
  - Copy any `quote` word for word.
- **The owner's words are the owner's messages.**
  - A short reply such as 「可以」 or "yes" approves what the agent message before it proposed. Record that as `approvedProposal`.
  - The agent's message itself is never the owner's words.
- **If nothing in the changes touches the table,** change only `filledBy.read`, and hand the table in.
- **The program sets `project.asOf` and `filledBy.agent`/`filledBy.at`** when it takes the table in. `asOf` becomes the commits the brief names. Sources are checked at those commits, so a cited line that has moved must be cited where it is now.
- **Write only through `pk_write_table`.** Do not edit the table file itself, or anything else in the project.
