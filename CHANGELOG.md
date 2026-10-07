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

Known limits:

- Windows only. macOS and Linux are not supported yet: the test suite fails on Linux and has never been run on macOS.
- A project whose own path is longer than 246 characters is read without its git history, and one longer than 251 cannot be organized: git and the Keeper cannot work in a directory that deep on Windows. Files deep inside a project are fine.
- The picture has errors, and differs from run to run on the same project. See [docs/cost-and-quality.md](docs/cost-and-quality.md).
- Not published to npm; run from a clone.
