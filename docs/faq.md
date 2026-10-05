# FAQ

### Do I have to change how I work, or write anything in a special format?

No. ProjectKeeper reads what the project already has: its documents, plans, tickets, decision records, git history, code and agent sessions, in whatever shape they are. It adds no steps to your process. A project with a clear plan and numbered tickets gives a sharper picture than one with a README and commits, but both are read as they are.

### Will it change my project?

No. It reads. The one exception is a folder of its own inside the project, and only if you authorize it. See [Privacy](privacy.md).

### What does it cost?

On the one project measured: about 50 minutes and about 11 CNY (about $1.5) for the first picture on DeepSeek, and from 29 CNY (about $4) to $67 at list price for a full takeover, depending on the models. Afterwards a daily round reads only what changed. [Cost and quality](cost-and-quality.md) has the table. A larger or older project will cost more; we have not measured how much more.

### How long does it take?

The first picture took 50 to 106 minutes in the four runs, a full deepening 71 to 117 more. You can read the first picture while the deepening runs.

### Which model should I use?

The measured runs used DeepSeek and Zhipu GLM. The cheapest run was DeepSeek's fast model for everything and its strong model for the final check, and its result was among the better ones — though that run had help the others did not ([Cost and quality](cost-and-quality.md) says what). Other providers are listed and untested. See [Models and keys](models-and-keys.md).

### Can I try it without a key?

Yes: `npm run demo` opens an invented, already organized project. It shows what the result looks like; it does not organize anything, and the Keeper's answers in it are canned.

### Is the picture right?

Mostly, and not always. In the four measured runs a fresh reader checked ten sub-agent claims per round against the files: seven to nine held, and in the run where the misses were classified they were all a line number or a count off by one. Structural mistakes happen too — a whole class of item left out, a status shown wrong. That is why every statement opens to its source, why what the Keeper inferred is marked `Inferred`, and why the last step of a deepening is an independent check. Treat it as a well-read colleague's account, not as the record.

### It says something is missing. Is it?

A "missing step" on the first pass is only a candidate and is not shown as a breakpoint. A breakpoint is lit after a sub-agent looked for the step and did not find it, and the independent check confirmed that. If it is wrong or does not matter, `No action needed` turns it off for good.

### What is the difference between a note, a breakpoint and a send-back?

A **breakpoint** is an observation: the next step should be there and has no trace. A **send-back** is a suggested action: this should go back to the work or to the plan, with text you can hand an agent. A **note** is the Keeper writing to you, sometimes asking for a decision. None of them is a ticket, and none needs closing by hand. [Concepts](concepts.md).

### My project is not in English. Does that work?

The project used for the measured runs is written in Chinese; the demo project mixes English and Chinese. The workbench's own labels are English. In the measured runs the notes and summaries came out in the language of the material.

### Which agents' sessions does it read?

Claude Code and Codex, from their usual folders in your home folder. `PROJECTKEEPER_CODEX_HOMES` names additional Codex folders. Sessions of other tools are not read yet; documents and git history are read regardless of which tool wrote them.

### Does it work on macOS or Linux?

Not yet. ProjectKeeper 0.1 is supported on Windows only, and CI runs there. Its test suite fails on Linux and has never been run on macOS, so neither is supported. The code is Node.js and git with no native build of its own; contributions that make it work on either system are welcome ([CONTRIBUTING.md](../CONTRIBUTING.md)).

### Does my project need to be a git repository?

No, but much of what ProjectKeeper shows — what was merged, which work built which code, what a document said before — comes from the history. A plain folder gives a thinner picture.

### Can several people use one workbench?

It is built for one person on one machine: it listens on `127.0.0.1`, has no login, and reads the session logs of the user who runs it.

### How do agents use it?

Through the `pk` command, while the workbench is running: `pk context --work <item>` before starting on something, `pk get <id>` to read anything a pack names. Nothing is installed into the agent's host and nothing is injected into its sessions; you tell the agent the command exists. [The `pk` command](pk.md).

### Can I talk to it?

Yes. `Ask Keeper` in the top bar opens a conversation with the Keeper about the project, and a note has `Discuss with Keeper`. What you correct there is taken as a correction from the owner.

### How do I stop it, start over, or remove it?

`Pause organizing` in `Keeper activity` pauses automatic work. `Clear` on the Takeover page removes what was organized for a project. To remove ProjectKeeper, delete the clone and `~/.projectkeeper`.

### Can I install it from npm?

Not yet. It is run from a clone; nothing named `projectkeeper` is on npm yet. An unrelated package named `pk` is: inside the clone `npx pk` finds this project's own command, but anywhere else it would fetch that other package. To use the command from other folders, run `npm link` in the clone and then call `pk` or `projectkeeper` directly.

### Why are the themes not MIT?

The code is MIT. The four visual themes under `ui/themes/` are the author's own design work and are published so the product looks as it was made to look; they are not licensed for reuse elsewhere. Without a theme the workbench uses a built-in dark look that is part of the MIT code. [ui/themes/LICENSE.md](../ui/themes/LICENSE.md).
