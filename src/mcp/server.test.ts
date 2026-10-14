/**
 * `pk mcp` (D108), driven the way a client drives it: `node bin/pk.mjs mcp` spawned, JSON-RPC lines written to its
 * stdin and read from its stdout. It lists five tools, checks a table without any workbench, says in the command's own
 * words when the workbench is not running, answers what it does not know with JSON-RPC errors and keeps answering, and
 * writes nothing but JSON-RPC on stdout. Against a running workbench a tool says what the command prints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../util/git.ts';
import { tmpdir } from '../util/tmp.test-helpers.ts';
import { PROTOCOL_VERSIONS } from './server.ts';

const PK = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'pk.mjs');

type Reply = { jsonrpc: '2.0'; id: number | string | null; result?: any; error?: { code: number; message: string } };

/** A client of a spawned `pk mcp`: requests by id, raw lines, and every line the server wrote to stdout. */
function client(args: readonly string[], options: { cwd: string; home: string }) {
  const child = spawn(process.execPath, [PK, 'mcp', ...args], { cwd: options.cwd, env: { ...process.env, PROJECTKEEPER_HOME: options.home }, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: string[] = [];
  let rest = '';
  let stderr = '';
  const waiting = new Map<string, (reply: Reply) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    rest += chunk;
    for (let i = rest.indexOf('\n'); i >= 0; i = rest.indexOf('\n')) {
      const line = rest.slice(0, i);
      rest = rest.slice(i + 1);
      stdout.push(line);
      let reply: Reply;
      try { reply = JSON.parse(line) as Reply; } catch { continue; }
      const key = JSON.stringify(reply.id);
      waiting.get(key)?.(reply);
      waiting.delete(key);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  let next = 1;
  const reply = (id: number | null) => new Promise<Reply>((r) => waiting.set(JSON.stringify(id), r));
  return {
    stdout,
    stderr: () => stderr,
    request(method: string, params?: unknown): Promise<Reply> {
      const id = next++;
      const answered = reply(id);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
      return answered;
    },
    notify(method: string, params?: unknown) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`); },
    raw(line: string, answerId: number | null = null): Promise<Reply> { const answered = reply(answerId); child.stdin.write(`${line}\n`); return answered; },
    call(name: string, args: Record<string, unknown>) { return this.request('tools/call', { name, arguments: args }); },
    async close(): Promise<number | null> { child.stdin.end(); const code = await exited; assert.equal(rest, '', 'stdout ends on a whole line'); return code; },
  };
}

/** Every line on stdout is one JSON-RPC response: nothing else ever goes there. */
function onlyJsonRpc(lines: readonly string[]): void {
  assert.ok(lines.length > 0);
  for (const line of lines) {
    const m = JSON.parse(line) as Record<string, unknown>;
    assert.equal(m.jsonrpc, '2.0', line);
    assert.ok('id' in m && ('result' in m || 'error' in m), line);
  }
}

/** A port nothing listens on: taken from the system, then let go. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** A one-repository project and a table that holds against it (as in src/table/check.test.ts), with its session material. */
function tableProject(): { dir: string; table: Record<string, any>; sessions: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pk-mcp-'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'PLAN.md'), '# Plan\n\n## PLAN-1 · First cut\n\nT-1 capture.\n');
  writeFileSync(join(dir, 'docs', 'DECISIONS.md'), '# Decisions\n\n- DEC-1 · No accounts.\n');
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first']]) assert.ok(git(dir, args).ok);
  const commit = git(dir, ['rev-parse', 'HEAD']).out.trim();
  const plan = { file: 'docs/PLAN.md', lines: '3-5' };
  const table = {
    format: 'projectkeeper.table/1',
    project: { name: 'Tiny', asOf: { date: '2026-10-13', repos: [{ path: '.', commit }] }, filledBy: { agent: 'test', at: '2026-10-13' } },
    ownerWants: [{ id: 'W1', want: 'No accounts.', kind: 'Product', status: 'Current', said: [{ session: 'claude:s1', message: 2, quote: 'no accounts, ever' }], reflectedIn: ['DEC-1'] }],
    product: { id: 'Tiny', name: 'Tiny', summary: 'A tiny list.', forWhom: 'One person.', sources: [plan] },
    goals: [{ id: 'G1', name: 'Quick', summary: 'Quick saving.', status: 'Current', sources: [plan] }],
    areas: [{ id: 'A1', name: 'Capture', summary: 'Saving.', status: 'Current', goals: ['G1'], sources: [plan] }],
    requirements: [], designs: [],
    decisions: [{ id: 'DEC-1', name: 'No accounts', summary: 'No accounts.', status: 'Current', place: { area: 'A1' }, sources: [{ file: 'docs/DECISIONS.md', lines: '3', quote: 'DEC-1 · No accounts.' }] }],
    plans: [{ id: 'PLAN-1', name: 'First cut', summary: 'Capture.', status: 'Current', sources: [plan] }],
    work: [{ id: 'T-1', name: 'Capture', summary: 'Save a page.', plan: 'PLAN-1', area: 'A1', implements: ['DEC-1'], status: 'Current', progress: 'Done', sources: [plan, { commit }] }],
    code: [], notes: [],
  };
  mkdirSync(join(dir, 'projectkeeper'));
  const sessions = join(dir, 'session-material.jsonl');
  writeFileSync(sessions, `${JSON.stringify({ session: 'claude:s1', message: 2, text: 'I want no accounts, ever.' })}\n`);
  return { dir, table, sessions, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const textOf = (reply: Reply): string => (reply.result.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

test('pk mcp speaks MCP over stdio: initialize, five tools, the table check, the workbench not running, errors it survives (D108)', async () => {
  const p = tableProject();
  const home = mkdtempSync(join(tmpdir(), 'pk-mcp-home-'));
  const port = await closedPort();
  const c = client(['--port', String(port)], { cwd: p.dir, home });
  try {
    const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18', 'a version it speaks is echoed');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(init.result.serverInfo.name, 'projectkeeper');
    assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+/);
    c.notify('notifications/initialized');

    const tools = (await c.request('tools/list')).result.tools as { name: string; description: string; inputSchema: { type: string; properties: Record<string, { type: string; description: string }>; required?: string[] } }[];
    assert.deepEqual(tools.map((t) => t.name).sort(), ['projectkeeper_ask', 'projectkeeper_check_table', 'projectkeeper_context', 'projectkeeper_get', 'projectkeeper_options']);
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object', t.name);
      assert.ok(t.description.length < 400, `${t.name}: a short description`);
      for (const [key, schema] of Object.entries(t.inputSchema.properties)) assert.ok(schema.type && schema.description, `${t.name}.${key} has a type and a description`);
    }
    assert.deepEqual(tools.find((t) => t.name === 'projectkeeper_get')!.inputSchema.required, ['id']);

    // The table check needs no workbench; a table that holds has no problems.
    writeFileSync(join(p.dir, 'projectkeeper', 'project.json'), JSON.stringify(p.table));
    const clean = await c.call('projectkeeper_check_table', { table: 'projectkeeper/project.json', sessions: p.sessions });
    assert.equal(clean.result.isError, undefined);
    assert.match(textOf(clean), /project\.json: no problems\.$/);
    // A broken one lists its problems, as `pk check` prints them.
    const broken = structuredClone(p.table);
    broken.decisions[0].status = 'Done';
    broken.work[0].plan = 'PLAN-9';
    writeFileSync(join(p.dir, 'projectkeeper', 'broken.json'), JSON.stringify(broken));
    const bad = await c.call('projectkeeper_check_table', { table: join(p.dir, 'projectkeeper', 'broken.json'), project: p.dir, sessions: p.sessions });
    assert.equal(bad.result.isError, true);
    assert.match(textOf(bad), /broken\.json: \d+ problems?; the table is not taken in until there are none\./);
    assert.match(textOf(bad), /\/decisions\/0\/status/);
    const cli = spawnSync(process.execPath, [PK, 'check', join(p.dir, 'projectkeeper', 'broken.json'), '--project', p.dir, '--sessions', p.sessions], { encoding: 'utf8', env: { ...process.env, PROJECTKEEPER_HOME: home } });
    assert.equal(cli.status, 1);
    assert.equal(textOf(bad), cli.stdout.trimEnd(), 'the tool says what `pk check` prints');

    // A workbench tool with no workbench running says so, and how to start it.
    for (const [name, args] of [['projectkeeper_options', {}], ['projectkeeper_get', { id: 'T-1' }], ['projectkeeper_context', { work: 'T-1' }], ['projectkeeper_ask', { question: 'Why?' }]] as const) {
      const r = await c.call(name, args);
      assert.equal(r.result.isError, true, name);
      assert.match(textOf(r), new RegExp(`ProjectKeeper is not running at http://127\\.0\\.0\\.1:${port}\\. Start it with \`pk serve\``), name);
    }
    // A missing input is the tool's error, an unknown tool a protocol error.
    assert.equal((await c.call('projectkeeper_get', {})).result.isError, true);
    assert.equal((await c.call('projectkeeper_nothing', {})).error!.code, -32602);

    assert.equal((await c.request('resources/list')).error!.code, -32601, 'an unknown method');
    const parse = await c.raw('{"jsonrpc":"2.0","id":7,"method":', null);
    assert.equal(parse.error!.code, -32700, 'a line that is not JSON');
    assert.deepEqual((await c.request('ping')).result, {}, 'and the server keeps answering');
    // A client's response and a notification it does not know get nothing back; the next request still does.
    c.notify('notifications/cancelled', { requestId: 99 });
    c.raw('{"jsonrpc":"2.0","id":"x","result":{}}');
    assert.deepEqual((await c.request('ping')).result, {});

    const code = await c.close();
    assert.equal(code, 0, `the server ends when its input does${c.stderr() ? `; stderr: ${c.stderr()}` : ''}`);
    onlyJsonRpc(c.stdout);
  } finally {
    p.done();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a protocol version it does not speak is answered with its newest (D108)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-mcp-home-'));
  const c = client([], { cwd: home, home });
  try {
    const init = await c.request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.protocolVersion, PROTOCOL_VERSIONS[0]);
    for (const v of ['2025-03-26', '2024-11-05']) assert.ok(PROTOCOL_VERSIONS.includes(v));
    assert.equal(await c.close(), 0);
    onlyJsonRpc(c.stdout);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('against a running workbench, projectkeeper_options and projectkeeper_get say what `pk options` and `pk get` print (D108)', async () => {
  // The workbench runs here, on a home of its own; the MCP server is spawned against its port.
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-pi-agent-'));
  const { App } = await import('../server/app.ts');
  const { HttpApp } = await import('../server/http.ts');
  const { registerRoutes } = await import('../server/api.ts');
  const home = mkdtempSync(join(tmpdir(), 'pk-mcp-home-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-mcp-proj-'));
  writeFileSync(join(projectDir, 'README.md'), '# Demo\n\nA demo.\n');
  const app = new App(home, { organizing: false });
  const project = app.addProject('Demo', [projectDir]);
  const http = new HttpApp();
  registerRoutes(http, app, '', '');
  const server = await http.listen(0);
  const c = client(['--port', String(server.port)], { cwd: projectDir, home });
  const pk = (...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((r) => {
    const child = spawn(process.execPath, [PK, ...args, '--port', String(server.port)], { cwd: projectDir, env: { ...process.env, PROJECTKEEPER_HOME: home } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (status) => r({ status, stdout, stderr }));
  });
  try {
    await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    c.notify('notifications/initialized');
    // The project is the one containing the folder the server was started in.
    const options = await c.call('projectkeeper_options', {});
    assert.equal(options.result.isError, undefined, textOf(options));
    assert.match(textOf(options), /^Areas:/);
    const cli = await pk('options');
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(textOf(options), cli.stdout.trimEnd());
    // An id the project does not have is the tool's error, in the command's words.
    const missing = await c.call('projectkeeper_get', { id: 'thread_nowhere', project: project.id });
    assert.equal(missing.result.isError, true);
    assert.equal(textOf(missing), `thread_nowhere is not an id of project ${project.id}.`);
    assert.equal(await c.close(), 0);
    onlyJsonRpc(c.stdout);
  } finally {
    await server.close();
    app.stopAll();
    await app.flushAll();
    rmSync(home, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});
