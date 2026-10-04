# The `pk` command

`pk` is how an agent reads what the workbench shows you: the same content, from the same code, as plain text. It also has a few commands for you.

## Getting it

From the folder you cloned, `npx pk …` works as it is. `npm link` puts `pk` on your path so it works from any folder, together with its long name, `projectkeeper`: the two are the same command. Use `npx pk` only inside the clone; elsewhere npm would look for an unrelated package named `pk`.

The reading commands talk to the **running workbench** (`npm start`). They read what has already been organized, so they answer at once and use no model. Only `pk ask` needs the Keeper and a key.

## For your agents

### `pk context` — the pack before starting

```sh
pk context                      # the start pack for the whole project
pk context --work T-18          # the work pack for one work item or area, by id or by name
```

A pack is Markdown. The start pack for a project has the purpose and your words behind it, the current direction, how the project works, the plan, the relevant work, who is doing what, what changed lately, what not to revive, decisions waiting for you, the Keeper's notes, how fresh all of it is, and the sources. A work pack narrows this to one work item:

```text
$ pk context --work T-18
# Context for Incoming agent · Work: T-18 Search index incremental rebuild 增量重建 · Kind: Implement
…
## Owner's words
What the owner said that this work traces up to, word for word:
- `ow_save_fast` · the owner, 2026-09-09 [1]:
  “Saving has to be faster than deciding where it goes”
…
## How it got here
…
- 2026-08-20 · First appeared · T-18 defined in docs/TASKS.md:10: | T-18 | Search index incremental rebuild | in progress |
…
- 2026-09-11 · Send-back · Send-back to Work (Suggested): Batch 2 says the index refreshes every minute; the review could not confirm it from the code, and batch 2 was signed off anyway.
…
## Open problems
- The receipt claims a one-minute background refresh; the code does not have it.
- Is the one-minute refresh claim measured anywhere?
…
```

Every statement ends in a number in brackets that points into the `Sources` list at the end of the pack. A pack gives **where the code is, not the code**: the agent opens the current version itself.

Options:

| Option | Values | Default |
|---|---|---|
| `--work <id or name>` | a work item or an area | the whole project |
| `--purpose` | `Start`, `Work` | `Start` for the project, `Work` with `--work` |
| `--kind` | `Implement`, `Review`, `Plan`, `"Discuss product"`, `Investigate` | `Implement` |
| `--recipient <role>` | `"Incoming agent"`, or a role the project recognises | `"Incoming agent"` |
| `--since <time>` | the time of the agent's last pack | — (gives only what changed since) |

If a name matches several items, `pk` lists them with their ids and asks for one.

### `pk options` — what can be asked for

Lists the areas and work items with their ids and progress, the roles recognised, how each kind and recipient changes the pack, the breakpoints lit, the send-backs open, and the objects tagged among the six things.

```text
$ pk options
Areas:
- ref_capture  A1 · Capture 快速收藏
- ref_reading  A2 · Reading 阅读体验
…
Work items:
- thread_tag_suggest  T-28 Auto-tag suggestions 标签自荐 · In progress
…
Lit breakpoints:
- bp_search_refresh · Findings open · on Search index incremental rebuild 增量重建 (thread_search_index)

Open send-backs:
- sb_export_images · Returned · to Work · DEC-3 says export includes the attachments; export.ts still marks them todo. · on Export with attachments 导出附件 (thread_export_attach)
…
```

### `pk get <id>` — anything a pack names

Every id in a pack can be read in full:

| Id | Gives |
|---|---|
| a work item or area | its work pack |
| a source (`src_…`) | the original with line numbers, where it is, and the version that was read; for a code file, where it is and the version read, not its lines |
| a note (`note_…`) | the whole note: view, why it matters, options, facts, discussion, earlier versions |
| a project rule (`rule_…`) | the rule in the project's own words, and where it is written |
| a breakpoint, a send-back, a code territory | what it is, its evidence, and for a send-back the `Copy for agent` text |
| any other object | the object in full, with its neighbours named by id |

```text
$ pk get sb_search_refresh
# Send-back · sb_search_refresh
Where: Search index incremental rebuild 增量重建 (thread_search_index)
What: Batch 2 says the index refreshes every minute; the review could not confirm it from the code, and batch 2 was signed off anyway.
Send back to: Work · Reopen T-18: make the index refresh in the background, or correct the receipt.
Status: Suggested · Open
…
## Evidence
- file · docs/review-search.md (docs/review-search.md)
  Original line: The refresh claim in batch 2 could not be confirmed from the code.
…
```

`pk get` reads ids, not paths.

### `pk ask "<question>"` — ask the Keeper

What is already organized comes back at once, with sources. What needs investigating becomes a job: `pk ask` prints its id, and `pk ask --fetch <job id>` reads the answer later. `--wait` waits for it; `--thread <id>` keeps asking in the same thread.

### `pk help`

Prints the above for the project at hand, with the exact options to pass. It is the text to give an agent that has never seen ProjectKeeper. In the workbench, **Keeper** → **Execution-agent access** has the same as `Copy for an agent`.

## Which project, which workbench

- **The project** is the one that contains the folder you run `pk` in. Elsewhere, pass `--project <id>` or `--cwd <folder>`. `pk projects` lists the ids.
- **The workbench** is looked for on the port in your settings (4870 unless you changed it). Pass `--port <n>` for another.

So against the demo, which serves on port 4880:

```sh
npx pk options --port 4880 --project <id>
npx pk context --work T-18 --port 4880 --project <id>
npx pk get sb_search_refresh --port 4880 --project <id>
```

`<id>` is in the address the demo prints: `…/#/p/<id>/graph`.

## For you

| Command | What it does |
|---|---|
| `pk serve [--port N]` | Starts the workbench; `npm start` runs this. |
| `pk add <name> <folder> [more folders]` | Adds a project. Nothing runs until you press `Start` on its Takeover page. |
| `pk projects` | Lists the projects: id, name, locations. |
| `pk scope <project id>` | Prints what the Keeper treats as the project, with the reason for each item. |

`--home <folder>` (or `PROJECTKEEPER_HOME`) points any command at another ProjectKeeper folder.

## Exit codes

`0` done · `1` the workbench answered with an error · `2` wrong usage, or a name that matched nothing or several · `3` the workbench is not running on that port · `4` no such project, or the id is not one of this project's.
