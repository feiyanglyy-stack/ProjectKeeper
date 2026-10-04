/**
 * A local OpenAI-compatible test double for the Keeper (E8). It plays each job kind with canned
 * tool calls so the workbench and the tests can run without a real model provider. Never
 * registered unless asked for explicitly (`pk serve --fake-provider` or a test).
 */
import { createServer, type ServerResponse } from 'node:http';

type Msg = { role: string; content: unknown };
export interface ToolCall { name: string; args: Record<string, unknown>; /** Test malformed provider JSON without pre-normalizing it. */ rawArguments?: string }
/** `afterTool` is true on a turn that follows a tool result: a planner that wants a second turn answers it. */
export type Planner = (prompt: string, messages: Msg[], afterTool?: boolean) => ToolCall[] | string;

const contentOf = (m: Msg): string => (typeof m.content === 'string' ? m.content : ((m.content as { text?: string }[] | null) ?? []).map((p) => p.text ?? '').join('\n'));

export function userText(messages: Msg[]): string {
  const users = messages.filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  return last ? contentOf(last) : '';
}

/** The job's own task, which on a turn after a tool call is no longer the last message. */
export function taskText(messages: Msg[]): string {
  const task = messages.filter((m) => m.role === 'user').map(contentOf).find((s) => /^Task: /m.test(s));
  return task ?? userText(messages);
}

/**
 * Every call the job made to one tool so far, with the text it got back: a job that works in several turns (a round's
 * main job reads, then writes what the reading lets it write) finds the ids it needs here. A result belongs to the
 * call with its id in the assistant turn just before it; the double numbers each turn's calls from call_0 again.
 */
export function callResults(messages: Msg[], tool: string): { args: Record<string, unknown>; result: string }[] {
  const out: { args: Record<string, unknown>; result: string }[] = [];
  let calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const m of messages as (Msg & { tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string })[]) {
    if (m.role === 'assistant') {
      calls = new Map((m.tool_calls ?? []).map((c) => { let args: Record<string, unknown> = {}; try { args = JSON.parse(c.function.arguments) as Record<string, unknown>; } catch { /* keep empty */ } return [c.id, { name: c.function.name, args }]; }));
    } else if (m.role === 'tool' && m.tool_call_id) {
      const call = calls.get(m.tool_call_id);
      if (call?.name === tool) out.push({ args: call.args, result: contentOf(m) });
    }
  }
  return out;
}

/** Default behaviour: a product re-look writes a note, an investigation answers plainly, a conversation turn answers with
 *  an echo, and any other job has nothing to do. */
export const defaultPlanner: Planner = (prompt, messages, afterTool = false) => {
  // Every job the double plays is finished once its first batch of calls has run, and says so rather than planning
  // them again.
  if (afterTool) return '';
  const task = /^Task: ([a-z ]+)/m.exec(prompt)?.[1] ?? '';
  // The subagent's own session answers plainly, or the double would delegate for ever.
  if (/^Investigate this question for the parent job/m.test(prompt)) return 'The fake provider reads nothing, so there is nothing to report. Sources: none';
  if (task.startsWith('product re')) {
    const jdg = /Judgement record: (jdg_[a-z0-9]+)/.exec(prompt)?.[1];
    return [{ name: 'pk_write_note', args: { mountKind: 'project', mountIds: [], title: 'Fake provider note', preview: 'This note was written by the local test double; it carries no judgement.', ask: 'For information', currentView: 'No real model has looked at this project yet.', judgementRecordId: jdg, reason: 'fake re-look' } }];
  }
  // Owner turns say "Owner message (source src_…; cite …)", agent queries say "(… source src_…)".
  const owner = /source (src_[0-9a-f]{16})[;)]/.exec(prompt)?.[1];
  const text = /"""\n([\s\S]*?)\n"""/.exec(prompt)?.[1] ?? prompt;
  if (owner && /^DELEGATE:/i.test(text)) return [{ name: 'pk_begin_request', args: { scope: text.replace(/^DELEGATE:\s*/i, '').slice(0, 80), quote: text } }];
  if (owner) {
    const turns = messages.filter((m) => m.role === 'user').length;
    return `Answer #${turns} (fake provider): I read “${text.slice(0, 80)}”. No real model is connected, so this is an echo with the owner message cited [${owner}].`;
  }
  return 'Nothing to do (fake provider).';
};

export function startFakeProvider(planner: Planner = defaultPlanner, options: { toolArgumentChunkSize?: number } = {}): Promise<{ url: string; requests: { messages: Msg[]; tools: string[] }[]; close(): void; mode: { value: 'normal' | 'quota' | 'hang' } }> {
  if (options.toolArgumentChunkSize !== undefined && (!Number.isSafeInteger(options.toolArgumentChunkSize) || options.toolArgumentChunkSize < 1)) throw new Error('toolArgumentChunkSize must be a positive integer');
  const state = { url: '', requests: [] as { messages: Msg[]; tools: string[] }[], mode: { value: 'normal' as 'normal' | 'quota' | 'hang' }, close: () => undefined as void };
  const sse = (res: ServerResponse, chunks: unknown[]) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  };
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 80, completion_tokens: 8, total_tokens: 88 } } : {}) });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body) as { messages: Msg[]; tools?: { function: { name: string } }[] };
      state.requests.push({ messages: json.messages, tools: (json.tools ?? []).map((t) => t.function.name) });
      if (state.mode.value === 'quota') { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'insufficient_quota: You exceeded your current quota', type: 'insufficient_quota' } })); return; }
      if (state.mode.value === 'hang') { req.on('close', () => res.destroy()); return; }
      // A turn is "after a tool call" only when the latest message is a tool result; earlier turns' results are history.
      const last = json.messages[json.messages.length - 1];
      const hasToolResult = last?.role === 'tool';
      // A planner may answer a turn that follows a tool result — a job that delegates has a second turn, in which it
      // writes what the subagent's answer lets it write. One that has nothing more to say returns nothing and the
      // double closes the turn with text, as it always did.
      const planned = planner(userText(json.messages), json.messages, hasToolResult);
      if (hasToolResult && (typeof planned === 'string' || planned.length === 0)) {
        const errors = json.messages.filter((m) => m.role === 'tool' && String(m.content).startsWith('ERROR')).map((m) => String(m.content));
        const last = userText(json.messages);
        const owner = /Owner message \(source (src_[0-9a-f]{16})/.exec(last)?.[1];
        const text = errors.length ? `Tool errors: ${errors.join(' | ')}` : typeof planned === 'string' && planned.length ? planned : owner && /DELEGATE:/i.test(last) ? `Done as you asked (fake provider): nothing was actually changed. Basis [${owner}].` : 'Done.';
        sse(res, [chunk({ role: 'assistant', content: text }, null), chunk({}, 'stop')]);
        return;
      }
      if (typeof planned === 'string' || planned.length === 0) { const text = typeof planned === 'string' ? planned : 'Nothing to do.'; sse(res, [chunk({ role: 'assistant', content: text }, null), chunk({}, 'stop')]); return; }
      // A safety valve for the double itself: a planner that ignores `afterTool` would keep asking for the same
      // calls for ever (seen 2026-09-20: an area job reached 1,360 steps). Twelve turns of tool calls is more than any
      // canned job needs — D99's main agent moves through its stages, sends its lanes and accounts for its coverage in
      // about eight — so the turn is closed with text instead. Turns are counted, not results: one turn of parallel
      // calls has several.
      const lastUser = json.messages.map((m) => m.role).lastIndexOf('user');
      if (json.messages.slice(lastUser + 1).filter((m) => m.role === 'assistant').length >= 12) { sse(res, [chunk({ role: 'assistant', content: 'Done.' }, null), chunk({}, 'stop')]); return; }
      const chunkSize = options.toolArgumentChunkSize;
      if (chunkSize) {
        const parts = planned.map((c) => c.rawArguments ?? JSON.stringify(c.args));
        const chunks = [chunk({ role: 'assistant', tool_calls: planned.map((c, i) => ({ index: i, id: `call_${i}`, type: 'function', function: { name: c.name, arguments: '' } })) }, null)];
        // Interleave independent calls as real providers do; SSE boundaries need not be TCP boundaries.
        for (let offset = 0; parts.some((p) => offset < p.length); offset += chunkSize) {
          chunks.push(chunk({ tool_calls: parts.flatMap((p, i) => offset < p.length ? [{ index: i, function: { arguments: p.slice(offset, offset + chunkSize) } }] : []) }, null));
        }
        sse(res, [...chunks, chunk({}, 'tool_calls')]);
      } else {
        sse(res, [chunk({ role: 'assistant', tool_calls: planned.map((c, i) => ({ index: i, id: `call_${i}`, type: 'function', function: { name: c.name, arguments: c.rawArguments ?? JSON.stringify(c.args) } })) }, null), chunk({}, 'tool_calls')]);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    state.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    state.close = () => { server.close(); };
    resolve(state);
  }));
}

export const FAKE_MODEL = { id: 'fake-1', name: 'Fake provider (test double)', reasoning: false, input: ['text'] as ('text' | 'image')[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000 };
