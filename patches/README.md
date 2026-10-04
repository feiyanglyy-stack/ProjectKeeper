# pi-ai patches: streaming argument repair and complete arguments only

`npm ci` / `npm install` runs `scripts/apply-pi-streaming-patch.ts` (through `bin/postinstall.mjs`). The patch targets
pi-ai **0.87.1** in every lockfile installation location (currently two copies); where ProjectKeeper is installed as a
package and has no lockfile of its own, in the copy pi-coding-agent loads and the copy ProjectKeeper itself would load.
It checks package versions, whole-file SHA-256 hashes and unique replacement contexts
before writing any file. Re-running is safe. A changed package or unexpected source
fails installation with an explicit error; upgrading pi requires reviewing this patch.
An installation with `--ignore-scripts` must run the postinstall command explicitly.

The patch has two parts, added one after the other. In the patched files their comments
are marked `ProjectKeeper AO` (delta parsing) and `ProjectKeeper AX` (complete arguments
only); the letters are only the names of the markers.

Each file's replacements apply in order, and a later generation only appends its own.
An installation that an earlier generation patched (for example delta parsing only) is
therefore still recognised: the script undoes whatever replacements it finds, accepts the result
only if it has the upstream hash, and applies the whole current list. So after pulling
a newer patch, `node scripts/apply-pi-streaming-patch.ts` (or `npm ci`) brings an
existing `node_modules` up to date. A file changed any other way is refused; `npm ci`
restores the upstream files.

`pi-ai-0.85.0.ts` is retained as the exact patch manifest for a 0.85.0 rollback.
The installer and baseline benchmark use only `pi-ai-0.87.1.ts`; the older
manifest is not applied to a 0.87.1 installation.

## Delta parsing (marker `AO`)

Only tool argument **delta** parsing changes: each tool-call object has a weakly held
last parsed length. After its first snapshot, parse again at >= 1,024 characters and
at least double that length thereafter. Other deltas retain the last valid snapshot
and still emit the complete raw delta. Total prefix length processed is O(N), instead
of O(N²/k). State is per object, so streams and interleaved tool calls cannot mix.
No scratch state is added to tool arguments or session files.

## Complete arguments only (marker `AX`): a tool call runs only on arguments that arrived as complete JSON

Upstream, every native provider parses the complete buffer at tool end with
`parseStreamingJson`, which falls back to `partial-json` when the buffer does not
parse. That fallback completes a cut-off buffer into a shorter value that can pass the
tool's validation and run: a check run saw 103 characters of markdown saved as 15, with
the job `Done`; with the built-in `write` it would write a truncated file.

This part replaces those final parses with `finalizeStreamingToolArguments` (in
`dist/utils/json-parse.js`). It parses with upstream's `parseJsonWithRepair`, so raw
control characters and invalid escapes are repaired exactly as before, and an empty
buffer is still `{}`. When that fails — the text ends inside a string or before its
brackets close, or anything else keeps it from being one JSON value — the call is
marked with `Symbol.for("projectkeeper.pi-ai.incompleteToolArguments")`. The
`partial-json` value is still stored as the arguments, so the Keeper view and the
replayed conversation show what arrived; a symbol key is never serialized into session
files or provider requests.

`validateToolArguments` (in `dist/utils/validation.js`) refuses a marked call before
it validates anything. pi-agent-core validates every tool call through it, whatever
the tool — the built-ins, ProjectKeeper's `pk_*` tools, an extension's tools — and
before any `tool_call` hook, so nothing runs. The refusal is the tool result the model
gets, and it leads with what the model must do:

> Tool call "write" was not executed: its arguments did not arrive as complete JSON,
> so they may have been cut off. Nothing was run; send the call again with the complete
> arguments. (200 characters arrived; Unterminated string in JSON at position 200)

The Keeper records the refused call as a step, with this text as its summary.

Covered final parses: OpenAI Completions, Anthropic Messages, Bedrock Converse, Mistral,
and the Responses shared implementation (Azure/Codex), including its second parse at
`output_item.done`, which decides whether the call stays marked. Pi Messages receives
arguments its upstream already finalized; Google adapters receive structured arguments.
Neither has a final parse of its own to change. A reply cut off at the output limit
(`length`) is refused by pi-agent-core itself, for all its tool calls.

## Shared notes

The assistant-message frame utility's checkpoint/replay/catch-up logic is separate
from provider argument streaming and is unchanged. This patch does not promise a
fixed latency bound for arbitrarily large single JSON values or transport bursts.
Existing source maps still describe upstream code; line numbers after insertions shift.

ProjectKeeper's runtime forwards `text_delta` only; it reads tool arguments at
`tool_execution_start`, after finalization. It does not consume `toolcall_delta`
argument snapshots. Public pi interfaces and session formats are unchanged.

Local-only reproduction (no model keys or sessions):

```sh
node scripts/benchmark-tool-stream.ts --baseline
node scripts/benchmark-tool-stream.ts
node --test src/keeper/streaming-arguments.test.ts src/keeper/pi-streaming-patch.test.ts src/keeper/long-output-guards.test.ts src/qc/long-output.test.ts
```

The benchmark enters through coding-agent's `ModelRuntime`, the same provider-composition
path as the Keeper service, with an in-memory empty credential store and a synthetic key.
That unbundled SDK resolves its nested pi-ai installation; postinstall patches that copy
and the root copy discovered in the lockfile. coding-agent's prebuilt CLI bundle is a
different executable path and is not loaded by the ProjectKeeper service or changed here
(so native pi, as opened by `Open in pi`, keeps upstream behaviour).
The baseline command restores original pi-ai modules **in memory in its own process**;
it does not change installed dependencies. The benchmark uses 20-character SSE deltas
and a 10 ms heartbeat; reported latency is excess over that interval.
The 200 KB baseline can take about ten seconds; the ordinary regression test uses
100 KB and takes a fraction of a second when patched. It allows 1,500 ms heartbeat
delay to leave ample margin for slower machines and the parallel full test suite.

Investigated npm tarballs: 0.85.0, 0.85.1, 0.86.0, 0.86.1, 0.87.0, 0.87.1. All have the
same `dist/utils/json-parse.js` SHA-256:
`824fa2bf05b37d65b105ac8c07172d19f22f56a4ac66fbffba943933e4fb6d62`.
Their provider delta sites still reparse accumulated arguments.
The [0.86.0 changelog](https://github.com/earendil-works/pi/blob/v0.87.0/packages/ai/CHANGELOG.md)
fix for quadratic `EventStream` draining addresses a different path. No upstream
issue or pull request was submitted for this patch.
