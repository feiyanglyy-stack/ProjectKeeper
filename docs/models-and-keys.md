# Models and keys

ProjectKeeper has no model of its own and no account. You bring a key for a model provider; the Keeper runs on it through [pi](https://github.com/earendil-works/pi), the agent library underneath.

## Which providers

The `Model provider` section lists every provider pi knows — some forty, from Anthropic and OpenAI to DeepSeek, Zhipu (Z.AI), Moonshot and OpenRouter. **Listed is not the same as tried.** The takeovers measured so far ran on:

- **DeepSeek**: `deepseek-v4-pro` and `deepseek-flash`
- **Zhipu GLM** (Z.AI, including Coding Plan keys): `glm-5.3` and `glm-5.3-flash`

Other providers should work as far as pi supports them, and have not been run by us. Keep in mind what a takeover asks of a model: long agentic work with many tool calls, and a main agent whose context reached 300,000 to 700,000 tokens in the measured runs. [Cost and quality](cost-and-quality.md) has the four runs.

## Adding a key

In the workbench: **Keeper** → **Model provider** → **Add a key**. Choose the provider, give the key a name, paste it, **Save**.

- The key is kept in one file on your machine, `~/.projectkeeper/keys.json`, in plain text. It is not written into any project, export, log or context pack, and the workbench never shows it again, not even in part. On macOS the file is readable by your account alone, and so is the `~/.projectkeeper` folder when ProjectKeeper makes it; on Windows your profile's own access rules cover it. Protect that file as you would any credentials file.
- Any project can use a saved key.
- **Check** asks the provider with one request of one output token, and shows `Usable`, `Refused`, `Out of quota`, `Rate-limited` or `Could not check`, with the provider's own words. Where the provider reports what is left (DeepSeek's balance), that is shown; where it does not, the page says so.

### Keys from outside

Keys you already have elsewhere are listed and used the same way:

- **An environment variable** the provider's adapter reads — for example `DEEPSEEK_API_KEY`, `ZAI_API_KEY`, `ZAI_CODING_CN_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`. Set it in the terminal you start the workbench from, before `npm start`:

  ```powershell
  # Windows, PowerShell
  $env:DEEPSEEK_API_KEY = "your key"
  npm start
  ```

  ```sh
  # macOS, zsh (or Git Bash on Windows)
  export DEEPSEEK_API_KEY="your key"
  npm start
  ```

  Set this way the key lasts as long as that terminal. To have it in every terminal, put the `export` line in `~/.zshrc` on a Mac, or set a user environment variable on Windows.
- **pi's own login**: run `pi` in a terminal and use `/login`.

## The main model

Under **This project runs on** you choose the main key, its model, and how hard it thinks (`off` to `max`). Your conversation with the Keeper runs on the main model, and so does every step of a round that is not set apart. Each project chooses its own; a project that has chosen nothing runs on the machine's settings.

The measured runs all used the highest thinking level.

## A model for each step

A round has five kinds of step, and each can follow the main model or have its own model and thinking level:

| Step | What it does | What the measured runs suggest |
|---|---|---|
| **Session drafts** | Reads your agent sessions and keeps what you said | Ran on the fast model in three of the four runs |
| **Main agent** | Orients, writes the questions, sends the sub-agents, cross-checks | Every structural fault found in the runs began here, on every model |
| **Lanes** | The sub-agents: each answers one question from the material | On DeepSeek, fast lanes were no worse than strong ones on the claims checked; on GLM, most errors the final check found began in a fast lane |
| **Synthesis** | Writes the notes and the round's result for you | Follows the main agent unless set. The fast model held: its few errors were inherited from a lane |
| **Spot check** | Independently re-checks what the round concluded | Kept on the strong model in every run; it is the one check made from outside the round |

Set them in the **Each step of a round** table. A change applies to steps that start after it; a running step is not interrupted.

## Backup keys

Under **When a key runs out of quota or is rate-limited** you put keys in order. The first row is the main key. When a key cannot be used, the work goes on **in its own session** on the next usable key of the order — nothing it had read is lost — and comes back when the first key is usable again. Every switch is listed under **Switches between keys**; none is silent.

A step set to a particular model stays on keys that carry that model as long as one is usable.

## How many at once

Each key runs a number of jobs at once, set per key in the **At once** column of the keys table (three unless you change it). More at once means sub-agents finish sooner and the provider's rate limit is reached sooner. The measured DeepSeek runs used one key with eight at once.

## What it costs

The **Usage** section shows tokens, time and cost per round and per model. The cost is an **estimate**: recorded tokens multiplied by a list-price table. It can differ from your bill in both directions — on one measured DeepSeek run it showed $14.48 where the account was charged 57 CNY (about $8) — and on a subscription plan such as Zhipu's Coding Plan the list price says little about what you pay. Read your provider's bill for the real figure.

## Environment variables

| Variable | What it does |
|---|---|
| `PROJECTKEEPER_HOME` | Where ProjectKeeper keeps everything. Default: `~/.projectkeeper`. |
| `PROJECTKEEPER_CODEX_HOMES` | More Codex home folders to read sessions from, besides `~/.codex`, separated like `PATH` (`;` on Windows, `:` elsewhere). A bare name is taken under your home folder; an absolute path is used as it is. |
| `PI_CODING_AGENT_DIR` | pi's own folder (its login, settings and the Keeper's model sessions). Default: `~/.pi/agent`. |
| Provider key variables | `DEEPSEEK_API_KEY`, `ZAI_API_KEY`, `ZAI_CODING_CN_API_KEY` and the like, as above. |
| `PK_LANES_PER_KEY` | Jobs at once per key when nothing is set on the page. Default: 3. |
| `PI_TELEMETRY` | `0` turns off pi's install telemetry setting (see [Privacy](privacy.md)). |
