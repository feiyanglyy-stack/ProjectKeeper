# Changelog

What changed for someone who uses ProjectKeeper, newest first. Versions follow [Semantic Versioning](https://semver.org/); while the version is 0.x, anything may still change.

## 0.1.0 — first public version (unreleased)

What it includes:

**The workbench** — a local web page at `127.0.0.1`.

- **Project graph**, in three faces: `Graph` (a story map: the owner's words, product and goals on top, areas across, plans down, each piece of work in its cell, earlier plans rolled up), `List` (area by area, what was planned beside what happened) and `Code` (which code belongs to which product area, who built it, whether the current plan uses it).
- **Each piece of work with its steps** — planned, dispatched, delivered, checked, fixed, merged — and the commits, reports and verdicts behind each.
- **Breakpoints and send-backs**: where a step should be and has no trace, and what should go back to the work or the plan, with text to copy for an agent.
- **Notes log**: the Keeper's notes to the owner, those for decision with options.
- **Change log**, **Agent context**, **Project scope**, and a bilingual **Vocabulary**.
- **Keeper** pages: the takeover with three depths, the daily schedule, model provider and keys, a model for each step, backup keys, the project-folder authorization, usage by round and model, and every round as a tree of its steps.
- A conversation with the Keeper (`Ask Keeper`).
- A folder chooser where a location is typed (`Add project`, a scope item's path): `Browse…` lists folders to walk and pick from, with repositories and worktrees marked; a typed or pasted path works as before.
- Answers only at its own local address and, in a browser, only to its own pages: another site's page open in the same browser can neither read the workbench nor post to it.
- Four themes.

**The Keeper** — the resident agent.

- A **takeover** in two rounds: a first usable picture, then a deepening at the depth chosen (`Full`, `Focused`, `First picture only`).
- **Daily upkeep** on a schedule the owner sets, or on `Follow up`.
- A **ledger** built by a program, without a model: commits, document versions, numbering, verdicts, code structure, sessions.
- Each round: session drafts, a main agent that sends sub-agents by question, a synthesis in a session of its own, an independent spot check, and the program's own checks.
- Reads Claude Code and Codex session logs, git repositories and worktrees, and plain folders.
- Reads a project without changing it; one folder of its own inside the project only with the owner's authorization, given and withdrawn on the Keeper page (`Project folder`).

**For agents** — the `pk` command: `context`, `get`, `options`, `ask`, `help`.

**Models** — bring your own key, through pi. Run so far on DeepSeek and Zhipu GLM.

**The demo** — `npm run demo`: an invented project, already organized, with no key and no network.

**Systems** — Windows and macOS.

- On macOS: a project's sessions are looked for where Claude Code and Codex keep them on a Mac; a file named in another case, or in the other Unicode form of an accented, Korean or Japanese character, is the same file; the Keeper's shell is `/bin/bash`, and its check knows paths that start at `/` and macOS's own tools (AppleScript, the clipboard, the keychain and a Spotlight search of the whole machine are refused); `Open in pi` opens Terminal; a location can be typed with `~`.
- On macOS and Linux the saved keys are readable by their owner alone.
- The workbench says at its start when git is missing or too old.

Known limits:

- Linux is not supported yet. On macOS the test suite passes on GitHub's runners, and ProjectKeeper has not yet had daily use there.
- On a Mac volume formatted case-sensitive, two names that differ only in case are taken for one.
- A project whose own path is longer than 246 characters is read without its git history, and one longer than 251 cannot be organized: git and the Keeper cannot work in a directory that deep on Windows. Files deep inside a project are fine.
- The picture has errors, and differs from run to run on the same project. See [docs/cost-and-quality.md](docs/cost-and-quality.md).
- The workbench opens only as `127.0.0.1`, `localhost` or `[::1]` with its port, not under a hosts-file alias or behind a proxy: there it answers `403`.
- Not published to npm; run from a clone.
