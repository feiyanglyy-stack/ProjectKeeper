# Filling in the ProjectKeeper table

You are taking over a software project. Read it in whatever way you think best, and write down what you understood as one JSON file. You are told where it goes:
- `projectkeeper/project.json` in the project folder, under the project's git;
- for a public project, ProjectKeeper's own folder, so that the owner's words and the session material never reach the public repository.

Either way the table means the same, and its paths are relative to the project folder. ProjectKeeper draws that file as its workbench: the Graph (a story map of the whole project), the List (area by area, planned against what happened) and the Code view. The owner reads the picture there; the next agent reads the same file.

The shape of the file is fixed by [`projectkeeper.schema.json`](projectkeeper.schema.json). Everything else is your judgement: what to read and in what order, what deserves an entry, how big an entry is, and where it belongs. Nothing here tells you how to read the project.

[`examples/papertrail.json`](examples/papertrail.json) is a filled table for Papertrail, a small fictional project.

## Who fills what

A takeover fills the table in three steps:

1. **The owner's words.** One agent reads the session material and fills `ownerWants`. Its notes have `by: "Owner's words"`.
2. **The project.** Another agent reads the project folder and fills everything else. Its notes have `by: "Project"`.
   - The two read independently. Neither sees the other's part.
3. **The main agent reads both.**
   - It fills each want's `reflectedIn`.
   - Where the owner and the project part ways, it writes a note with `by: "Main agent"` and kind `Owner and project differ`.
   - When the owner is there, it starts from those notes and talks them through with the owner instead of deciding alone.

One agent may do all three, in that order. Later upkeep changes the same table: new words go into `ownerWants`, new work and new evidence go into their parts, and new notes are added.

## What you have to read

- **The project folder**: documents, code, and the git history of every repository in it.
- **The session material**, when you are given it: the owner's messages from past agent sessions, each with the agent's last answer before it. Tool calls and thinking are already taken out. Each message carries the session's name and its number; cite it by those. Without the session material, the owner's words come only from where the documents quote them.

Stay inside the project folder and the material you were given.

## The table, part by part

The `project` header says which project, the commit each repository stood at when you read it (`asOf`), and who filled the table. Under `filledBy.read`, say in a few sentences what you read and in what order, and what you left out.

The rest of the table has eleven parts.

| Part | What it is | Shown |
|---|---|---|
| `ownerWants` | What the owner wants, in the owner's words | The top of the Graph |
| `product` | What the product is and for whom | The top of the Graph |
| `goals` | Why the product exists; what a user should get | The top of the Graph |
| `areas` | The parts of the product | The columns of the Graph |
| `requirements`, `designs`, `decisions` | What the product must do, how it is meant to work, what was decided | Folded at the top of their column |
| `plans` | Plans, milestones, phases | The rows of the Graph |
| `work` | Each piece of work in a plan | The cells, where its plan's row meets its area's column |
| `code` | Which code belongs to which area | The Code view, and the foot of each column |
| `notes` | What needs the owner's attention | A ? on each entry it is about, and the notes list |

### `ownerWants`

One entry per thing the owner wants. When the owner said the same thing several times, that is one entry.

- `want`: one sentence. `kind`: about the product, or about the way of working (how documents are kept, how trials run, what the owner will not have done).
- `said`: one to three of the owner's clearest sentences, each quoted word for word with its source.
- Read the agent message before a short reply. A short reply such as 「可以」 or "yes" approves what that message proposed. Record what was approved under `approvedProposal`, saying which part of the proposal. An agent's message is never the owner's words.
- Text the owner pasted in (another agent's report, a log) is not the owner's words. What the owner says about it is.
- Later words can overturn earlier ones. Give the final position as the `want`, and list the turns under `changed`. An entry the owner later reversed is `Replaced`, and `replacedBy` names the entry that holds now. A question the owner left undecided is `Open`.
- `reflectedIn`: the entries elsewhere in the table that carry the want out. If nothing does, leave it empty and write a note of kind `Owner and project differ`.

### `requirements`, `designs`, `decisions`

Take them from the project's own documents, with the project's own numbers and names.

- `place` puts each one in exactly one spot:
  - one `area`;
  - several `areas`;
  - one `plan`, for a decision about how a plan is carried out;
  - `wholeProduct`, with the reason it concerns the whole product.
- A decision that says what the product will not do is a decision with `boundary: true`.
- An execution log or run diary is not a list of decisions. Cite it as a source where it explains what happened.

### `plans` and `work`

A plan that is in force is `Current` (or `Proposed`, `Deferred`). A plan that a later plan replaced is `Replaced`. It is an earlier generation: its row rolls up, and each of its work items needs `became`:

- `carriedOnBy`: a current work item continues it;
- `movedTo`: a current plan took it over unchanged;
- `deferred`: it was put off;
- `dropped`: it was given up;
- `finished`: it was done under the earlier plan and needed no continuation.

A work item is a task, contract or ticket from the project's own plan. A commit or a session is never a work item by itself.

- `id` is the project's own number for the work. The program uses it to find the work's dispatches, commits, receipts, reviews and merges in git and in the documents, and builds the steps from them.
- Add `steps` only for a step the program cannot find that way, and always with its evidence.
- `progress` is how far the work got by the records. It is not whether anyone checked or accepted it. Acceptance by the owner goes in `accepted`, with its source.
- `area` is the column the work mainly serves. `alsoAreas` puts it in other columns too, drawn dashed. Work that serves a whole plan and no single area takes `wholePlan`, with the reason, instead of `area`.

### `code`

A territory is a piece of code (files or folders) and the area it belongs to. Give its paths. The program computes everything else: size, tests, who built it, and whether the current plan still uses it. Record an anomaly only when you saw it in the material.

### `notes`

A note is for what is wrong, or for where the owner and the project part ways.

- The `title` says it in one sentence; `text` gives the background and why it matters.
- For a decision, give the owner `options`, each with its consequence.
- `on` names the entries the note is about. The note shows on each of them.
- `by` says which step wrote it (see [Who fills what](#who-fills-what)).
- Something that is fine needs no note. Normal, finished work stays quiet.

## How much to put in

As few entries as still make the project clear. The owner reads this table at a glance; every extra entry costs attention.

- **One entry per thing that matters, not per line of the records.**
  - A decision log with a hundred entries may hold a few dozen decisions that still shape the product. Merge the entries that settle one matter into one decision, and cite them all as its sources.
  - Fold the many small tasks under a contract into the contract.
  - Merge the owner's many sayings of one want into one want.
- **Drop what changes nothing for the reader.** Leave out:
  - wording fixes and dates of runs;
  - an arrangement that was carried out and left nothing behind;
  - a rule that only repeats another.
- **Of what was overturned, keep only what someone could plausibly bring back.** Give it the status `Replaced` or `Abandoned`, with `replacedBy` or `why`. The workbench gathers these as the "do not revive" list.
- **When only part of an entry was overturned,** keep the entry `Current`. Name the part and the entry that overturned it under `partlyReplaced`.
- **Do not fill a table to look complete.** An empty part is better than an invented one.

## Sources

Every entry has at least one source.

- **A file**: `{ "file": "product/PLAN.md", "lines": "40-52" }`. The path is relative to the project folder, with forward slashes.
- **A commit**: `{ "commit": "8854c20", "repo": "app" }`. Leave `repo` out when the repository is the project folder itself.
- **A session message**: `{ "session": "claude:4f1c…", "message": 153 }`.

Add `quote` when the words matter, and copy them exactly.

## What the program checks

The program checks the whole table when you run `pk check`, and again when `pk import` takes it in. If anything fails, the whole table is refused and nothing changes. Each failure names the entry, the field and the reason.

| Checked: the table is refused if it fails | Not checked: your judgement |
|---|---|
| The shape matches the schema; statuses and kinds use the listed words | What you read, and in what order |
| Every id is unique, and every id you refer to exists in the table | What deserves an entry, and how big it is |
| A `Replaced` entry names `replacedBy`; an `Abandoned` or `Deferred` one says `why` | Which area, plan or place an entry belongs to |
| A work item in a `Replaced` plan has `became` | What counts as an anomaly, and what to tell the owner |
| Every source exists: the file and its lines, the commit, the session message | How you word names and summaries |
| Every `quote` stands word for word in what it cites | How many entries there are |
| Every code path exists at the `asOf` commit | |

## How it is drawn

Each field has one place on the screen, and everything on the screen comes from the table or from git. `pk import` takes the table in as it is. The table stays in the project under git, so `git diff` on it shows what changed between two fillings.
