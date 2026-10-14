/**
 * `pk mcp`: ProjectKeeper as a local MCP server (D108), for agents and clients that take their tools over MCP — Claude
 * Desktop, Cursor, Claude Code, Codex, any MCP client. The command line `pk` stays the primary way; this is an entry for
 * others, and its tools are thin wrappers over what `pk` already does (src/mcp/tools.ts).
 *
 * The transport is MCP's stdio transport, written here so that nothing is added to the dependencies (D108): one
 * JSON-RPC 2.0 message per line on stdin, one per line on stdout, and nothing else ever on stdout — what the server has
 * to say besides goes to stderr. Implemented is what a client needs to list and call tools: `initialize`, the
 * `notifications/initialized` notification, `ping`, `tools/list` and `tools/call`. A line that is not JSON is answered
 * with -32700, a method the server does not have with -32601, and no message, however wrong, stops the server.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { projectKeeperTools, type McpDefaults, type McpTool, type ToolResult } from './tools.ts';

/** The protocol versions this server speaks, newest first. A client asking for one of them gets it echoed; any other gets the newest. */
export const PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];

const here = dirname(fileURLToPath(import.meta.url));
/** ProjectKeeper's version, as the server names itself to the client. */
export const SERVER_VERSION = (JSON.parse(readFileSync(resolve(here, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;

type Id = string | number | null;
type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
type Response = { jsonrpc: '2.0'; id: Id; result: unknown } | { jsonrpc: '2.0'; id: Id; error: { code: number; message: string } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const failure = (id: Id, code: number, message: string): Response => ({ jsonrpc: '2.0', id, error: { code, message } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const validId = (v: unknown): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/**
 * Answer one message: a request gets its response, a notification (no id) and a client's response to us get nothing.
 * Never throws: whatever goes wrong inside becomes an error response.
 */
async function answer(message: unknown, tools: readonly McpTool[], log: (line: string) => void): Promise<Response | null> {
  if (!isRecord(message)) return failure(null, INVALID_REQUEST, 'Invalid Request: a message is a JSON object');
  const m = message as Message;
  const hasId = 'id' in m && m.id !== undefined;
  // A response to a request of ours: this server sends none, so there is nothing to match it with.
  if (typeof m.method !== 'string') return hasId && !('result' in m || 'error' in m) ? failure(validId(m.id) ? m.id : null, INVALID_REQUEST, 'Invalid Request: no method') : null;
  if (!hasId) {
    // Notifications are never answered: `notifications/initialized`, `notifications/cancelled` and the rest.
    return null;
  }
  if (!validId(m.id)) return failure(null, INVALID_REQUEST, 'Invalid Request: the id is a string or a number');
  const id = m.id;
  if (m.jsonrpc !== '2.0') return failure(id, INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"');
  const params = isRecord(m.params) ? m.params : {};
  try {
    switch (m.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return {
          jsonrpc: '2.0', id, result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: 'projectkeeper', version: SERVER_VERSION },
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) } };
      case 'tools/call': {
        const tool = tools.find((t) => t.name === params.name);
        if (!tool) return failure(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
        if (params.arguments !== undefined && params.arguments !== null && !isRecord(params.arguments)) return failure(id, INVALID_PARAMS, 'arguments must be an object');
        const result: ToolResult = await tool.call((params.arguments as Record<string, unknown> | undefined) ?? {});
        return { jsonrpc: '2.0', id, result };
      }
      default:
        return failure(id, METHOD_NOT_FOUND, `Method not found: ${m.method}`);
    }
  } catch (e) {
    log(`[pk mcp] ${m.method}: ${(e as Error)?.stack ?? String(e)}`);
    return failure(id, INTERNAL_ERROR, `Internal error: ${(e as Error)?.message ?? String(e)}`);
  }
}

/** Options of `pk mcp`: the defaults its tools fall back on, and where its own remarks go (stderr). */
export interface McpServerOptions extends Partial<McpDefaults> {
  readonly log?: (line: string) => void;
  /** The tools to serve; ProjectKeeper's own five unless a test gives others. */
  readonly tools?: readonly McpTool[];
}

/**
 * Serve MCP over a pair of streams (stdin and stdout for `pk mcp`) until the input ends. Requests are answered as they
 * finish, each on its own line; a batch (an array, as the 2025-03-26 protocol allows) is answered with one array.
 */
export async function serveMcp(input: Readable, output: Writable, options: McpServerOptions = {}): Promise<void> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const tools = options.tools ?? projectKeeperTools({ port: options.port ?? null, project: options.project ?? null, cwd: resolve(options.cwd ?? process.cwd()), home: options.home });
  const send = (message: Response | Response[]) => { output.write(`${JSON.stringify(message)}\n`); };
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { send(failure(null, PARSE_ERROR, 'Parse error: a line is one JSON-RPC message')); continue; }
    const task = (async () => {
      if (Array.isArray(message)) {
        if (!message.length) { send(failure(null, INVALID_REQUEST, 'Invalid Request: an empty batch')); return; }
        const answers = (await Promise.all(message.map((m) => answer(m, tools, log)))).filter((a): a is Response => a !== null);
        if (answers.length) send(answers);
        return;
      }
      const reply = await answer(message, tools, log);
      if (reply) send(reply);
    })().catch((e) => { log(`[pk mcp] ${(e as Error)?.stack ?? String(e)}`); });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.allSettled([...pending]);
}
