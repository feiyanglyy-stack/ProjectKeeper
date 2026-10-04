/**
 * The Keeper agent's capability table (Spec §8.1, §8.3; CKC-03 AC-1, AC-14, AC-25–AC-31), shown in `Keeper` → `Keeper
 * agent`. It says what the program on this build does, not what is planned: each row names what provides it — pi as it
 * comes, a ProjectKeeper tool, the ledger, the TypeScript language service, or ProjectKeeper's own adapter around pi — and a
 * row that is not available says which steps that affects. Nothing here is claimed that pi does not have: what
 * ProjectKeeper adds says so in `provider` and `source`, and `native` says what `Open in pi` (the pi installed on the
 * machine, without ProjectKeeper's tools or patch) has of it.
 */
import { LEFT_NOTE } from './bounds/shell-write-guard.ts';

export type CapabilityProvider = 'pi built-in' | 'ProjectKeeper tool' | 'The ledger' | 'TypeScript language service' | 'ProjectKeeper adapter' | 'Not provided';

export interface Capability {
  readonly name: string;
  /** Where it is used in the workbench, and by which steps. */
  readonly workbench: string;
  /** What native pi (`Open in pi`) has of it. */
  readonly native: string;
  readonly available: boolean;
  /** What provides it, in one of the fixed words (CKC-03 AC-31). */
  readonly provider: CapabilityProvider;
  /** How it is provided, in a sentence; the table shows it after the name. */
  readonly source: string;
  /** For a row that is not available: which steps that affects, and how. */
  readonly affects: string | null;
}

/** The model jobs of a round as D99 runs it (clerk.ts `ROUND_STEPS`), as the table names them. */
const EVERY_STEP = 'every job — each job of a round (the session drafts, the main agent through its stages, each lane it sends, the synthesis, the spot-check), investigations, answers, requests and re-looks';

export const PI_CAPABILITIES: readonly Capability[] = [
  // ── pi as it comes (Spec §8.1's first table) ──
  { name: 'Conversation: streaming output, tool calls', workbench: 'Keeper conversation', native: 'Native', available: true, provider: 'pi built-in', source: 'pi, as it comes', affects: null },
  {
    name: 'Built-in tools: read, write, edit, bash (and PowerShell on Windows), grep, find, ls',
    workbench: `All on in ${EVERY_STEP}; none removed. Autonomous work that changes project content is shown in the Keeper view`,
    native: 'Native; grep, find and ls are off in pi\'s own defaults',
    available: true, provider: 'pi built-in',
    source: 'pi\'s own tools, all turned on for every job (settings defaultTools). ProjectKeeper\'s adapter keeps them inside the project: a read boundary on read, grep, find, ls and edit, shell commands checked before they run and their changes to the project undone as the shell row says, shell without credential variables',
    affects: null,
  },
  {
    name: 'Shell commands on the project: what the boundary refuses, and what it undoes on a live project and on a controlled trial',
    workbench: `Every shell command in ${EVERY_STEP}. A refused command, and one whose changes were undone, is a step marked as an error with the reason and the paths; when something changed while a command ran, not by it, the step's result starts with “${LEFT_NOTE}” and the paths it left`,
    native: 'Not in native pi: Open in pi runs shell commands as they are given',
    available: true, provider: 'ProjectKeeper adapter',
    source: 'ProjectKeeper\'s shell boundary. Refused before a command runs: reading outside the project; a path that cannot be worked out beforehand (a variable, a command substitution, eval, code piped into an interpreter); redirecting into the project, and writing into it with tee, cp, mv, rm, touch, mkdir, rmdir, truncate or sed -i, projectkeeper/ included; git commands that change the repository; Git-ignored and Excluded paths. '
      + 'Undone after it runs, on a live project (a home that watches its projects, where the owner and agents write at the same time): only what the command itself names as its writes — its redirection targets, the value of an output option (--output, sort -o …), the operands of the commands above — and every other change is left as it is and named on the step, including one the command made through a program or a script, which cannot be told from another writer\'s. '
      + 'On a controlled trial (settings.watchProjects false: nobody else writes there): every change to the working tree that git status or the directory scan shows. '
      + 'Never, on either: the index, HEAD, refs or anything else in .git, nor what a commit made while the command ran',
    affects: null,
  },
  { name: 'Sessions: save, resume, name', workbench: 'Session switch in the conversation', native: 'Native', available: true, provider: 'pi built-in', source: 'pi, as it comes', affects: null },
  { name: 'Branching: tree navigation, fork, clone', workbench: 'Branch in the conversation', native: 'Native', available: true, provider: 'pi built-in', source: 'pi, as it comes', affects: null },
  { name: 'Compaction: automatic and manual', workbench: 'Long sessions continue', native: 'Native', available: true, provider: 'pi built-in', source: 'pi, as it comes', affects: null },
  { name: 'Steering, queued follow-ups, abort', workbench: 'Send while answering; Stop', native: 'Native', available: true, provider: 'pi built-in', source: 'pi, as it comes', affects: null },
  { name: 'Model and thinking level; provider login or API key', workbench: 'Keeper → Model provider', native: 'Native (/login, /model)', available: true, provider: 'pi built-in', source: 'pi, as it comes; backups and extra keys are ProjectKeeper\'s settings', affects: null },
  { name: 'Project instruction files, skills, prompt templates, extensions, pi packages', workbench: 'Loaded the native way for the project directory', native: 'Native', available: true, provider: 'pi built-in', source: 'pi, as it comes', affects: null },
  { name: 'Themes', workbench: 'Not applicable', native: 'Native', available: true, provider: 'pi built-in', source: 'pi, as it comes', affects: null },
  { name: 'Usage and cost reporting', workbench: 'Usage, Keeper activity', native: 'Native', available: true, provider: 'pi built-in', source: 'pi\'s session statistics', affects: null },

  // ── what the clerk method needs (Spec §8.1 "书记员需要的能力"; CKC-03 AC-25–AC-31) ──
  {
    name: 'Querying the ledger: commits and merges, document versions and their sections, supersession lines, numbers, verdicts, execution arrangements, a word across all history, file references, sessions and the owner\'s words, how something got here',
    workbench: `The pk_ledger_* tools, in ${EVERY_STEP}; a round's first step brings the ledger up to date`,
    native: 'Not in native pi',
    available: true, provider: 'The ledger',
    source: 'The project\'s ledger (one SQLite file in its assets, rebuilt from git, the documents and the session logs), read through the pk_ledger_* tools',
    affects: null,
  },
  {
    name: 'Code references in TypeScript and JavaScript: file level, and symbol level (references, implementations, callers, callees)',
    workbench: `File-level dependencies of every file in the ledger; symbol level on demand with pk_ledger_symbol, compiler-exact, in ${EVERY_STEP}. Project scope says the same level per language`,
    native: 'Not in native pi',
    available: true, provider: 'TypeScript language service',
    source: 'File level: the ledger, through the TypeScript pre-parser. Symbol level: the TypeScript language service over the current checkout',
    affects: null,
  },
  {
    name: 'Code references in every other language the code engine reads (Dart, Python, Kotlin, Swift, Go, Java, C/C++ and the rest): file level, and symbol level (references, implementations, callers, callees)',
    workbench: `File-level dependencies of every such file in the ledger; symbol level on demand with pk_ledger_symbol, each hit with how it was resolved and whether it counts, in ${EVERY_STEP}. Nothing to set up in the project. Project scope and pk_ledger_coverage say per language what was resolved and where references went unresolved; a residue judged by references there is recorded Inferred (pk_write_territory)`,
    native: 'Not in native pi',
    available: true, provider: 'The ledger',
    source: 'The ledger\'s general code engine, @colbymchenry/codegraph (pinned), indexing a snapshot of the current version kept next to the ledger — never in the project; only references it resolved through an import, a path, a qualified name, a function reference or an instance method count',
    affects: null,
  },
  {
    name: 'Code references in languages neither reads (CSS, HTML, shell scripts, SQL …)',
    workbench: 'The file tree and sizes only; no dependencies. Project scope lists each language with its level',
    native: 'Not in native pi',
    available: false, provider: 'Not provided',
    source: 'Neither the TypeScript compiler nor the code engine reads their references',
    affects: 'On such code, the code-state sweep and the cross-check read dependencies by hand; a residue judged by references there is recorded Inferred (pk_write_territory)',
  },
  {
    name: 'Each job of a round and each lane in a fresh session, in parallel',
    workbench: 'A round\'s main agent, each lane it sends, the session drafts and the spot-check run as jobs of their own in new pi sessions — the lanes as many at once as the keys allow (Parallel jobs per key); they hand over through the workbench\'s positions and the round\'s documents, never a shared session',
    native: 'One session at a time',
    available: true, provider: 'ProjectKeeper adapter',
    source: 'The Keeper runtime: a new pi session per job, nothing forked from another',
    affects: null,
  },
  {
    name: 'Delegating a local investigation (sub-agent)',
    workbench: 'The conversation, answers, requests, product re-looks and a round\'s synthesis send focused investigations',
    native: 'Not in native pi (pi has no sub-agents of its own)',
    available: true, provider: 'ProjectKeeper tool',
    source: 'pk_investigate: a focused pi session of its own whose conclusion and sources return to the job that sent it; it is a child of that job in Keeper activity',
    affects: null,
  },
  {
    name: 'Model and thinking level per step',
    workbench: 'Keeper → Model provider, for each model step of a round (session drafts, the main agent, each lane, the synthesis — which, left unset, runs on what the main agent is set to — and the spot-check; and for rounds of the earlier method, where each step was a job of its own: orientation, skeleton, sweeps, cross-check); the model and the thinking level a job actually ran on are in Keeper activity',
    native: 'One model per session (/model)',
    available: true, provider: 'ProjectKeeper adapter',
    source: 'The workspace setting steps, applied when a step\'s pi session is created; the thinking level the model accepted is recorded',
    affects: null,
  },
  {
    name: 'Long output: long judgements and tool calls with long arguments',
    workbench: `In ${EVERY_STEP}: long tool arguments stream in whole; a call whose arguments did not arrive as complete JSON never runs — any tool, pi's write included — and the model is told to send it again; a last reply cut at the output limit, or the same call refused the same way in 8 turns in a row with nothing else run in them, ends the job Failed with the step and the reason in Keeper activity (calls refused together in one turn count once each); the reply is kept as written`,
    native: 'Upstream behaviour: Open in pi runs the pi installed on the machine, without ProjectKeeper\'s patch',
    available: true, provider: 'ProjectKeeper adapter',
    source: 'ProjectKeeper\'s patch of pi-ai 0.87.1 (scripts/apply-pi-streaming-patch.ts, applied at npm install) and the runtime\'s rules for how a job ends',
    affects: null,
  },
  {
    name: 'Time and usage per step',
    workbench: 'Keeper activity and the round tree: each job\'s time split into generation, tools, queue, parse & retry and other, and its tokens; a round sums its steps',
    native: 'Usage per session',
    available: true, provider: 'ProjectKeeper adapter',
    source: 'The Keeper runtime stamps pi\'s events as they arrive (StepTimer); usage from pi\'s session statistics',
    affects: null,
  },
  { name: 'MCP servers', workbench: 'Not provided by pi itself; an extension may add it', native: 'Only through an extension', available: false, provider: 'Not provided', source: 'pi has no built-in MCP; nothing in ProjectKeeper adds it', affects: 'No step and no workbench control depends on it' },
];
