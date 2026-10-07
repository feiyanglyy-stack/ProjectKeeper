# Privacy

What ProjectKeeper reads, what it keeps, what leaves your machine, and what it can change. Short version: it runs on your machine, it reads your project and your agent sessions, and the only place your project's text goes is the model provider you chose.

## What it reads

- **The folders you add** as a project's locations: files and, for a git repository, the whole history, including deleted documents and side branches.
- **Your agent sessions for those folders**: the Claude Code and Codex session logs on this machine whose working directory is one of the project's folders, in whatever spelling the log records it (through a junction or a `subst` drive, say). To tell which folder a log belongs to, the start of the log is looked at for the directory it records; sessions for other folders are not read beyond that, and nothing of them is kept.
- **What it leaves alone inside those folders:** what your ignore rules exclude is listed, not organized (if such a folder holds documents, it asks you). Third-party and generated material is listed and set aside. Where it recognises a credential in a text, the value is redacted before the text is stored, and the source is flagged as containing one. Recognition is by pattern and can miss; keep secrets out of the folders you add.

`Project scope` in the workbench shows every item it treats as the project, with the reason.

## What it keeps, and where

Everything is in one folder on your machine, `~/.projectkeeper` (or where `PROJECTKEEPER_HOME` points):

- the list of your projects and your settings;
- per project: the picture it built (objects, relations, notes, change records), excerpts of the sources it cites, a ledger database with the project's commit history, document versions and the text of your session messages, and a trace of every write;
- your saved keys, in `keys.json`, in plain text. The workbench never shows a saved key again, and the key is written nowhere else. On macOS that file is readable by your account alone.

The Keeper's own model sessions are kept by pi, the agent library, in its folder (`~/.pi/agent`, or where `PI_CODING_AGENT_DIR` points).

This folder holds a detailed copy of your project's intent and your own words. Treat it as you treat the project itself. **Clear** on a project's Takeover page removes what was organized for that project.

## What leaves your machine

- **Prompts to the model provider you chose.** They contain text from your project: documents, code, commit messages, and what you and your agents said in sessions. This is the product working as intended; it is also the thing to decide about. Which provider sees your project is your choice of key, per project.
- **The key check.** When you save a key or press `Check`, one small request goes to that provider. For DeepSeek, the balance is also read from the provider.
- **Nothing else.** ProjectKeeper has no account, no server of ours, and sends no telemetry. The workbench's pages load no outside resource; its scripts are served from your installation.

One thing belongs to pi and not to us: pi has an "install telemetry" setting of its own, used by its interactive terminal, which ProjectKeeper does not run. When that setting is on, pi adds an attribution header naming itself to requests to a few providers (OpenRouter, NVIDIA, Cloudflare). `PI_TELEMETRY=0` turns the setting off.

The demo (`npm run demo`) uses no network at all: its "provider" is a local stand-in.

## Who can reach the workbench

It listens on `127.0.0.1` only: other machines on your network cannot open it. There is no login; anything running on your machine as you can read it, as it can read your files.

## What it can change

**In your project: nothing, unless you authorize one folder.**

- The Keeper reads. Its file-reading tools are limited to the project's scope, and its shell commands are parsed before they run: a command that would write into the project is refused, and a write detected afterwards is undone.
- This is a guardrail against an agent wandering, not an operating-system sandbox. A determined or badly confused model running arbitrary programs is not something a parser can fully contain. If that matters for a project, point ProjectKeeper at a clone.
- While you or your agents are working in the project at the same time, the undo touches only what the Keeper's own command named as its output, so it never reverts your changes.
- **The project folder.** With your authorization, ProjectKeeper maintains one folder of its own inside the project (for example `projectkeeper/`), with exactly four files: a README, the list of meaning changes it recognised in your documents, the numbers it gave to things your project left unnumbered, and the decisions it distilled. By default it commits that folder itself — each commit contains only that folder, names ProjectKeeper as its author, and is never pushed — or you can choose write-only. It is off until granted. You grant it on the **Keeper** page, under **Project folder**: `Authorize…` asks for the folder's name and whether the Keeper commits it, and writes the folder at once. `Withdraw`, in the same place, takes the authorization back: the Keeper stops writing, and the folder and its commits stay in your project. `Project scope` shows whether it is granted too.

**On your machine:** it writes its own folder and pi's. `npm ci` patches the model library inside this repository's `node_modules` ([patches/README.md](../patches/README.md)); nothing global is installed or changed.

**Git:** it never pushes, and it never changes your git configuration.

## Removing it

Stop the workbench, delete the clone, and delete `~/.projectkeeper`. If you authorized the project folder, that folder stays in your project until you delete it.
