/**
 * The tools of `pk mcp` (D108): `pk context`, `pk get`, `pk options`, `pk ask` and `pk check`, each a thin wrapper over
 * the same code the command line runs (src/context/agent-entry.ts, src/table/check.ts), so a tool says what the command
 * prints. Every tool but the table check reads the running workbench; when it is not running the tool says so, in the
 * command's own words. Descriptions are short on purpose: a client loads them into every session it starts.
 */
import { resolve } from 'node:path';
import { agentEntry, askEntry, Exit, type EntryOutput, type EntryTarget } from '../context/agent-entry.ts';
import { Workspace } from '../store/workspace.ts';
import { checkTableFile, readSessionMaterial, tableCheckReport } from '../table/check.ts';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: true;
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<ToolResult>;
}

/** What a tool falls back on when its call does not say: the flags `pk mcp` was started with. */
export interface McpDefaults {
  /** The workbench port (`--port`); otherwise the one in the home's settings, read at each call. */
  readonly port: string | null;
  /** The project id (`--project`); otherwise the project containing `cwd`. */
  readonly project: string | null;
  /** The folder the client started the server in (`--cwd`, or the server's own working directory). */
  readonly cwd: string;
  /** ProjectKeeper's home (`--home` or PROJECTKEEPER_HOME), whose settings name the port. */
  readonly home?: string;
}

/** An input given with the wrong type: said back to the agent as the tool's error, not as a protocol error. */
class InputError extends Error {}

const text = (lines: readonly string[], error: boolean): ToolResult => ({ content: [{ type: 'text', text: lines.join('\n') || '(nothing)' }], ...(error ? { isError: true as const } : {}) });

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new InputError(`${key} must be a string.`);
  return v;
}

/** Run an entry as the command line would, collecting what it says; a code other than 0 is the tool's error. */
async function collect(run: (io: EntryOutput) => Promise<number>): Promise<ToolResult> {
  const lines: string[] = [];
  const io: EntryOutput = { out: (t) => lines.push(t), err: (t) => lines.push(t) };
  let code: number;
  try { code = await run(io); }
  catch (e) {
    if (e instanceof Exit) code = e.code;
    else { lines.push(e instanceof Error ? e.message : String(e)); code = 1; }
  }
  return text(lines, code !== 0);
}

const PROJECT_INPUTS = {
  project: { type: 'string', description: 'Project id (`pk projects` lists them). Default: the project containing cwd.' },
  cwd: { type: 'string', description: 'A folder inside the project. Default: the folder the server was started in.' },
  port: { type: 'integer', description: 'Workbench port. Default: the one in ProjectKeeper\'s settings (4870).' },
} as const;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function projectKeeperTools(defaults: McpDefaults): McpTool[] {
  /** Which workbench and project a call reads: its own inputs first, then the server's flags, then the settings. */
  const target = (args: Record<string, unknown>): EntryTarget => {
    const givenPort = args.port;
    if (givenPort !== undefined && givenPort !== null && !(Number.isInteger(givenPort) || (typeof givenPort === 'string' && /^\d+$/.test(givenPort)))) throw new InputError('port must be an integer.');
    const port = givenPort ?? defaults.port ?? Workspace.open(defaults.home).settings.port;
    const project = stringArg(args, 'project');
    const cwd = stringArg(args, 'cwd');
    // A folder given in the call names its project; the server's --project stands only when the call names neither.
    return { base: `http://127.0.0.1:${String(port)}`, project: project ?? (cwd ? null : defaults.project), cwd: resolve(defaults.cwd, cwd ?? '.') };
  };
  const guarded = (call: (args: Record<string, unknown>) => Promise<ToolResult>) => async (args: Record<string, unknown>): Promise<ToolResult> => {
    try { return await call(args); }
    catch (e) { return text([e instanceof Error ? e.message : String(e)], true); }
  };

  return [
    {
      name: 'projectkeeper_context',
      description: 'Read-only. The context pack to read before starting work on this project (like `pk context`): purpose and the owner\'s words, direction, plan, relevant work, recent changes, open notes, with numbered sources. Whole project by default; give `work` for one work item or area.',
      inputSchema: {
        type: 'object',
        properties: {
          work: { type: 'string', description: 'A work item or area, by id or name. Omit for the whole project.' },
          purpose: { type: 'string', enum: ['Start', 'Work'], description: 'Start (default for the project) or Work (default with work).' },
          kind: { type: 'string', enum: ['Implement', 'Review', 'Plan', 'Discuss product', 'Investigate'], description: 'What the pack is for. Default: Implement.' },
          recipient: { type: 'string', description: 'Who reads it: "Incoming agent" (default) or a role the project recognises.' },
          since: { type: 'string', description: 'Time of your last pack; gives only what changed since.' },
          ...PROJECT_INPUTS,
        },
      },
      annotations: { title: 'ProjectKeeper context pack', ...READ_ONLY },
      call: guarded(async (args) => {
        const options = { work: stringArg(args, 'work'), purpose: stringArg(args, 'purpose'), kind: stringArg(args, 'kind'), recipient: stringArg(args, 'recipient'), since: stringArg(args, 'since') };
        const t = target(args);
        return collect((io) => agentEntry('context', t, io, [], options));
      }),
    },
    {
      name: 'projectkeeper_get',
      description: 'Read-only. Read in full any id a pack names (like `pk get`): a work item or area (its pack), a source src_… (the original; for code, where it is and the version read), a note, a rule, a breakpoint, a send-back, or any other object with its neighbours. Ids, not paths.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'An id from a pack or from projectkeeper_options.' }, ...PROJECT_INPUTS },
        required: ['id'],
      },
      annotations: { title: 'ProjectKeeper get', ...READ_ONLY },
      call: guarded(async (args) => {
        const id = stringArg(args, 'id');
        if (!id) return text(['Give the id to read.'], true);
        const t = target(args);
        return collect((io) => agentEntry('get', t, io, [id]));
      }),
    },
    {
      name: 'projectkeeper_options',
      description: 'Read-only. What can be asked for (like `pk options`): areas and work items with ids and progress, roles, how each pack kind and recipient differs, lit breakpoints, open send-backs, the six things.',
      inputSchema: { type: 'object', properties: { ...PROJECT_INPUTS } },
      annotations: { title: 'ProjectKeeper options', ...READ_ONLY },
      call: guarded(async (args) => {
        const t = target(args);
        return collect((io) => agentEntry('options', t, io, []));
      }),
    },
    {
      name: 'projectkeeper_ask',
      description: 'Ask the Keeper about the project (like `pk ask`). Returns what is already organized at once, and an investigation job id; call again with jobId to fetch its answer. Read-only toward the project; the investigation uses the owner\'s model key.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question. Not needed with jobId.' },
          jobId: { type: 'string', description: 'An investigation job id from an earlier ask: fetches its answer.' },
          thread: { type: 'string', description: 'Keep asking in this thread (from an earlier ask).' },
          ...PROJECT_INPUTS,
        },
      },
      annotations: { title: 'Ask the ProjectKeeper Keeper', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      call: guarded(async (args) => {
        const question = stringArg(args, 'question');
        const jobId = stringArg(args, 'jobId');
        if (!question && !jobId) return text(['Give a question, or jobId to fetch the answer of an earlier one.'], true);
        const t = target(args);
        const portArg = args.port !== undefined && args.port !== null ? `, "port": ${JSON.stringify(args.port)}` : '';
        return collect((io) => askEntry(t, io, {
          question: question ?? '', fetch: jobId, thread: stringArg(args, 'thread'), wait: false,
          fetchLater: (projectId, job) => `projectkeeper_ask with {"project": ${JSON.stringify(projectId)}${portArg}, "jobId": ${JSON.stringify(job)}}`,
          askAgain: (projectId, thread) => `projectkeeper_ask with {"project": ${JSON.stringify(projectId)}${portArg}, "thread": ${JSON.stringify(thread)}, "question": "…"}`,
        }));
      }),
    },
    {
      name: 'projectkeeper_check_table',
      description: 'Read-only. Check a filled ProjectKeeper table (like `pk check`): its shape against the schema, its ids and references, and every source against the project\'s files. Lists every problem, or says there are none. Needs no workbench.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'The table file, e.g. projectkeeper/project.json. Relative paths start at the server\'s folder.' },
          project: { type: 'string', description: 'The project folder. Default: the folder holding the table\'s projectkeeper/ folder.' },
          sessions: { type: 'string', description: 'The session-material.jsonl the table quotes the owner from (written by `pk sessions`).' },
        },
        required: ['table'],
      },
      annotations: { title: 'Check a ProjectKeeper table', ...READ_ONLY },
      call: guarded(async (args) => {
        const table = stringArg(args, 'table');
        if (!table) return text(['Give the table file to check.'], true);
        const project = stringArg(args, 'project');
        const sessions = stringArg(args, 'sessions');
        const tableFile = resolve(defaults.cwd, table);
        const problems = checkTableFile(tableFile, {
          projectDir: project ? resolve(defaults.cwd, project) : undefined,
          sessions: sessions ? readSessionMaterial(resolve(defaults.cwd, sessions)) : null,
        });
        return text(tableCheckReport(tableFile, problems), problems.length > 0);
      }),
    },
  ];
}
