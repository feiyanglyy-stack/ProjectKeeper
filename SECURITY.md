# Security

ProjectKeeper runs on your machine, reads your projects and your agent sessions, holds your model keys, and runs a coding agent. A weakness in any of that matters, and a report is welcome.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately, by either of:

- e-mail to <angelina2026999@gmail.com> — it is read daily;
- GitHub's private reporting on this repository: `Security` → `Advisories` → `Report a vulnerability` (<https://github.com/feiyanglyy-stack/ProjectKeeper/security/advisories/new>).

Say what you found, how to reproduce it, and what it lets someone do. Leave real keys and private project content out of the report.

You will get an acknowledgement, then a fix or an explanation. Please give us a reasonable time to fix it before you publish. There is no bounty.

## Supported versions

The latest release, and `main`. ProjectKeeper is at v0.1; older versions are not patched.

## What counts

Things we treat as vulnerabilities:

- a way for the Keeper to **read outside the project's scope** — other folders, other projects' data, credential files;
- a way for the Keeper to **write into a project** without the owner's authorization, or outside the one authorized folder, or for such a write not to be undone;
- a **saved key appearing** anywhere but `keys.json`: in a project file, an export, a context pack, a log, the workbench, or a prompt;
- the workbench being **reachable from another machine**, or a web page in the user's browser being able to drive it;
- text from a project's material (a document, a commit message, a session) making the Keeper **do something outside its task** in a way that crosses one of the bounds above.

Known limits, stated in [docs/privacy.md](docs/privacy.md), and not vulnerabilities in themselves:

- the bounds on the Keeper's shell are a guardrail against a wandering agent, not an operating-system sandbox;
- the workbench has no login: anything running on the machine as the user can reach it;
- project text is sent to the model provider the user chose;
- saved keys are kept in plain text in one file in the user's home folder.

If you can turn one of these limits into something worse than what is stated, that is a report.

## Dependencies

A vulnerability in a dependency (pi, the code engine, cytoscape) that affects ProjectKeeper as it uses it is in scope here; otherwise please report it upstream.
