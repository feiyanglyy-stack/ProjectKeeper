/**
 * The read boundary end to end, against a fake provider (Spec §3.1; CKC-03 AC-2, AC-4, AC-23; E69):
 *  - a job that reads a file outside the project is refused, and the refusal is a visible step;
 *  - a job reads a file inside the project as usual;
 *  - every job kind is offered pi's default built-in tools, nothing removed (AC-4);
 *  - a credential environment variable is not visible to a shell the job runs (PA-10).
 *
 * On the baseline (efe74d0) there is no boundary: the out-of-scope read would succeed, so the first
 * test fails for the right reason; the credential variable would show in `env`, so that test fails too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from '../../util/tmp.test-helpers.ts';
import { join } from 'node:path';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-pi-agent-'));
const { App } = await import('../../server/app.ts');

interface Fake { url: string; requests: { messages: { role: string; content: unknown }[]; tools: string[] }[]; close(): void }

/** A fake provider that reads a `DIRECTIVE <tool> <arg>` line from the task and calls that one tool, then replies. */
function fakeProvider(): Promise<Fake> {
  const fake: Fake = { url: '', requests: [], close: () => undefined };
  const sse = (res: ServerResponse, chunks: unknown[]) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  };
  const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) => ({
    id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model: 'fake-1',
    choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
  });
  const textOf = (m: { content: unknown }) => (typeof m.content === 'string' ? m.content : (m.content as { text?: string }[] | null ?? []).map((p) => p.text ?? '').join('\n'));
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body) as { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
      fake.requests.push({ messages: json.messages, tools: (json.tools ?? []).map((t) => t.function.name) });
      const toolResult = json.messages.find((m) => m.role === 'tool');
      if (toolResult) {
        sse(res, [chunk({ role: 'assistant', content: `Done: ${String(toolResult.content).replace(/\s+/g, ' ').slice(0, 200)}` }, null), chunk({}, 'stop', { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 })]);
        return;
      }
      const user = json.messages.filter((m) => m.role === 'user').map(textOf).join('\n');
      const m = /DIRECTIVE (\w+) (.+)/.exec(user);
      if (!m) { sse(res, [chunk({ role: 'assistant', content: 'Nothing to do.' }, null), chunk({}, 'stop', { prompt_tokens: 80, completion_tokens: 4, total_tokens: 84 })]); return; }
      const [, tool, arg] = m;
      const args = tool === 'bash' ? { command: arg } : { path: arg };
      sse(res, [
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool!, arguments: JSON.stringify(args) } }] }, null),
        chunk({}, 'tool_calls', { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 }),
      ]);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    fake.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    fake.close = () => server.close();
    resolve(fake);
  }));
}

/** `deep`: the project in a directory whose path is exactly that many characters long, made a repository when asked. */
async function setup(deep?: { length: number; repository?: boolean }) {
  const base = mkdtempSync(join(tmpdir(), 'pk-int-'));
  const home = join(base, 'home');
  let projectDir = join(base, 'project');
  if (deep) {
    while (projectDir.length + 41 < deep.length) projectDir = join(projectDir, 'd'.repeat(40));
    projectDir = join(projectDir, 'k'.repeat(deep.length - projectDir.length - 1));
  }
  const outside = join(base, 'outside');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(projectDir, 'README.md'), '# Demo\n\nA neutral project for the boundary test.\n');
  writeFileSync(join(projectDir, 'src', 'inside.txt'), 'in-scope content the Keeper may read');
  writeFileSync(join(outside, 'secret.txt'), 'out-of-scope content the Keeper must not read');
  if (deep?.repository) {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Demo Dev', '-c', 'user.email=dev@demo.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.longpaths=true', '-C', projectDir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'Demo: first version');
  }
  const app = new App(home, { organizing: false });
  const project = app.addProject('Demo', [projectDir]);
  await app.intakeProject(project.id);
  app.stopAll();
  await app.initKeeper();
  const fake = await fakeProvider();
  app.keeper.models.registerProvider('fake', {
    name: 'Fake', baseUrl: fake.url, apiKey: 'fake-key', api: 'openai-completions',
    models: [{ id: 'fake-1', name: 'Fake 1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }],
  });
  app.keeper.setModel({ provider: 'fake', id: 'fake-1', thinking: null });
  return { app, project, projectDir, outside, fake, home };
}

test('a job that reads a file outside the project is refused, and the refusal is a visible step', { timeout: 60_000 }, async () => {
  const { app, project, outside, fake } = await setup();
  try {
    const target = join(outside, 'secret.txt');
    const job = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'x' }, prompt: `Task: material organizing. DIRECTIVE read ${target}` });
    const done = await app.keeper.waitFor(project.id, job.id);
    assert.equal(done.status, 'Done', done.error ?? '');
    const readStep = done.steps.find((s) => s.tool === 'read');
    assert.ok(readStep, 'the read attempt is recorded as a step');
    assert.equal(readStep!.isError, true, 'the blocked read is marked as an error step (visible in the Keeper view)');
    assert.match(readStep!.summary, /read boundary/, 'the step says why it was refused and names the path');
    assert.equal(done.boundaryDenials, 1, 'the job records that one read was refused');
    assert.ok(!/out-of-scope content/.test(done.resultText ?? ''), 'the out-of-scope content did not come back');
  } finally { fake.close(); app.stopAll(); }
});

test('the @ spelling pi strips is refused at the gate, so it cannot read the outside file (audit A)', { timeout: 60_000 }, async () => {
  const { app, project, outside, fake } = await setup();
  try {
    // pi resolves `@<path>` by stripping the `@`; the gate now resolves it the same way, so the read is refused
    // before pi runs it, instead of reading one file at the tool and checking another.
    const job = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'x' }, prompt: `Task: material organizing. DIRECTIVE read @${join(outside, 'secret.txt')}` });
    const done = await app.keeper.waitFor(project.id, job.id);
    const readStep = done.steps.find((s) => s.tool === 'read');
    assert.ok(readStep && readStep.isError, 'the @ read is refused as an error step');
    assert.match(readStep!.summary, /read boundary/);
    assert.equal(done.boundaryDenials, 1);
    assert.ok(!/out-of-scope content/.test(done.resultText ?? ''), 'the outside content did not come back');
  } finally { fake.close(); app.stopAll(); }
});

test('a job reads a file inside the project as usual', { timeout: 60_000 }, async () => {
  const { app, project, projectDir, fake } = await setup();
  try {
    const target = join(projectDir, 'src', 'inside.txt');
    const job = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'x' }, prompt: `Task: material organizing. DIRECTIVE read ${target}` });
    const done = await app.keeper.waitFor(project.id, job.id);
    assert.equal(done.status, 'Done', done.error ?? '');
    const readStep = done.steps.find((s) => s.tool === 'read');
    assert.ok(readStep && !readStep.isError, 'the in-scope read is not an error');
    assert.equal(done.boundaryDenials ?? 0, 0, 'no read was refused');
    assert.match(done.resultText ?? '', /in-scope content/, 'the in-scope content came back');
  } finally { fake.close(); app.stopAll(); }
});

test('every job kind is offered every pi built-in tool, grep, find and ls included, nothing removed (CKC-03 AC-4, AC-25)', { timeout: 60_000 }, async () => {
  const { app, project, fake } = await setup();
  try {
    const builtins = new Set(['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls']);
    const offeredBuiltins = async (kind: 'Organizing' | 'Answering' | 'Investigation' | 'Product re-look') => {
      const before = fake.requests.length;
      const job = app.keeper.enqueue(project.id, { kind, initiator: kind === 'Answering' ? 'owner' : 'auto', scope: { kind: 'x', ids: [], label: 'x' }, prompt: 'Task: nothing. Just answer.' });
      await app.keeper.waitFor(project.id, job.id);
      const req = fake.requests[before];
      return new Set((req?.tools ?? []).filter((t) => builtins.has(t)));
    };
    const organizing = await offeredBuiltins('Organizing');
    const answering = await offeredBuiltins('Answering');
    const relook = await offeredBuiltins('Product re-look');
    // Every built-in is on in every step (D87: 「自带的几个命令全部打开，grep find」): pi's default four plus grep, find, ls
    // (and powershell on Windows); the boundary re-provides its guarded versions and removes none of them.
    const expected = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', ...(process.platform === 'win32' ? ['powershell'] : [])]);
    for (const kind of [organizing, answering, relook]) {
      assert.deepEqual([...kind].sort(), [...expected].sort(), 'every built-in tool is offered, nothing removed');
    }
    // The pk_* asset tools are offered alongside them.
    assert.ok(fake.requests.some((r) => r.tools.includes('pk_project_overview')), 'the pk_* tools are still offered');
  } finally { fake.close(); app.stopAll(); }
});

/**
 * With the per-role tool filter (D59 rule 1): a subagent keeps pi's built-in tools, including the re-provided shell,
 * because they are not pk_* tools; the filter still keeps cross-object pk_* writes from it; and a read it tries outside
 * the project is refused and shows as its own step (results are paired to steps by tool call id).
 */
test('a subagent keeps the built-in tools and its shell, the role filter still limits its pk_* tools, and its refused read is a step', { timeout: 60_000 }, async () => {
  const { app, project, outside, fake } = await setup();
  try {
    const parent = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'x', ids: [], label: 'parent' }, prompt: 'Task: nothing. Just answer.' });
    await app.keeper.waitFor(project.id, parent.id);
    const before = fake.requests.length;
    const child = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', parentJobId: parent.id, scope: { kind: 'source', ids: [], label: 'a material' }, prompt: `Task: material organizing. DIRECTIVE read ${join(outside, 'secret.txt')}` });
    const done = await app.keeper.waitFor(project.id, child.id);
    const offered = fake.requests[before]?.tools ?? [];
    for (const t of ['read', 'bash', 'edit', 'write']) assert.ok(offered.includes(t), `a subagent keeps ${t} (had: ${offered.join(', ')})`);
    assert.ok(offered.includes('pk_write_fact_record'), 'a subagent keeps the fact-record tool for its own material');
    assert.ok(!offered.includes('pk_write_thread'), 'the role filter still keeps a cross-object write from a subagent');
    const readStep = done.steps.find((s) => s.tool === 'read');
    assert.ok(readStep, 'the read attempt is a step');
    assert.equal(readStep!.isError, true, 'the refused read is an error step');
    assert.match(readStep!.summary, /read boundary/, 'the refusal is filed on the step of its own call');
    assert.equal(done.boundaryDenials, 1, 'the subagent records its refusal');
  } finally { fake.close(); app.stopAll(); }
});

test('a credential environment variable is not visible to a shell the job runs (PA-10)', { timeout: 60_000 }, async () => {
  process.env.SOMETHING_API_KEY = 'super-secret-value-1234';
  const { app, project, fake } = await setup();
  try {
    // `printenv NAME` prints only that variable's value (or nothing): a precise probe, unlike `env`, whose long
    // output would truncate before the value and pass even without the strip.
    const job = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'x' }, prompt: 'Task: material organizing. DIRECTIVE bash printenv SOMETHING_API_KEY' });
    const done = await app.keeper.waitFor(project.id, job.id);
    const bashStep = done.steps.find((s) => s.tool === 'bash');
    assert.ok(bashStep, 'the shell command ran as a step');
    if (bashStep!.isError && /No bash shell|not found/i.test(bashStep!.summary)) return;   // no shell on this machine: skip
    assert.ok(!/super-secret-value-1234/.test(bashStep!.summary), 'the secret value is not in the shell output');
    assert.ok(!/super-secret-value-1234/.test(done.resultText ?? ''), 'the secret value is not in the reply');
  } finally { delete process.env.SOMETHING_API_KEY; fake.close(); app.stopAll(); }
});

test('git runs in a shell the job runs when git is configured through the environment, and a secret among those settings is not visible (PA-10)', { timeout: 60_000 }, async () => {
  const group = {
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'http.https://example.invalid/.extraheader', GIT_CONFIG_VALUE_0: 'AUTHORIZATION: bearer invented-bearer-1234',
    GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 'Invented Name',
    GIT_CONFIG_KEY_2: 'user.email', GIT_CONFIG_VALUE_2: 'someone@example.invalid',
  };
  const saved = Object.keys(group).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, group);
  const { app, project, fake } = await setup();
  try {
    // `git var` reads the settings (`git config` is refused outside --local). The name is now the first of the group,
    // so `printenv` shows it where the secret was.
    const job = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'x' }, prompt: 'Task: material organizing. DIRECTIVE bash git var GIT_AUTHOR_IDENT; printenv GIT_CONFIG_VALUE_0; echo end' });
    const done = await app.keeper.waitFor(project.id, job.id);
    const bashStep = done.steps.find((s) => s.tool === 'bash');
    assert.ok(bashStep, 'the shell command ran as a step');
    if (bashStep!.isError && /No bash shell|not found/i.test(bashStep!.summary)) return;   // no shell on this machine: skip
    assert.equal(bashStep!.isError, false, bashStep!.summary);
    assert.doesNotMatch(bashStep!.summary, /missing config key|unable to parse/, 'git read its settings');
    assert.match(bashStep!.summary, /Invented Name <someone@example\.invalid> \d+ \S+\s+Invented Name\s+end/, 'git reads the settings that hold no secret');
    assert.ok(!/invented-bearer-1234/.test(bashStep!.summary), 'the secret value is not in the shell output');
    assert.ok(!/invented-bearer-1234/.test(done.resultText ?? ''), 'the secret value is not in the reply');
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fake.close(); app.stopAll();
  }
});

test('what leads to a stored login is not in a shell the job runs: the program that answers for a password, git’s trace switches; and git there is told to ask nobody', { timeout: 60_000 }, async () => {
  const given = { GIT_ASKPASS: 'invented-askpass', SSH_ASKPASS: 'invented-askpass', VSCODE_GIT_IPC_HANDLE: 'invented-handle', GIT_TRACE: '1', GIT_TRACE_REDACT: '0' };
  const saved = Object.keys(given).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, given);
  const { app, project, fake } = await setup();
  try {
    const job = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'x' }, prompt: 'Task: material organizing. DIRECTIVE bash printenv GIT_ASKPASS SSH_ASKPASS VSCODE_GIT_IPC_HANDLE GIT_TRACE GIT_TRACE_REDACT; printenv GIT_TERMINAL_PROMPT; git --version; echo end' });
    const done = await app.keeper.waitFor(project.id, job.id);
    const bashStep = done.steps.find((s) => s.tool === 'bash');
    assert.ok(bashStep, 'the shell command ran as a step');
    if (bashStep!.isError && /No bash shell|not found/i.test(bashStep!.summary)) return;   // no shell on this machine: skip
    assert.equal(bashStep!.isError, false, bashStep!.summary);
    assert.match(bashStep!.summary, /^0\s+git version \S+\s+end\s*$/, 'none of them is set, git prints no trace, and terminal prompts are off');
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fake.close(); app.stopAll();
  }
});

test('in a repository at a deep path a shell command runs, and git typed into it reads the history (Windows: long paths)', { timeout: 60_000 }, async (t) => {
  if (process.platform !== 'win32') { t.diagnostic('not on this system: the path limit is Windows’'); return; }
  // Past 200 characters git's own files under .git pass 260: the guard's `git status` failed before any command ran,
  // and git typed into the shell could not open its objects.
  const { app, project, fake } = await setup({ length: 225, repository: true });
  try {
    const job = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'x' }, prompt: 'Task: material organizing. DIRECTIVE bash git log --format=%s && git status --porcelain && echo end' });
    const done = await app.keeper.waitFor(project.id, job.id);
    const bashStep = done.steps.find((s) => s.tool === 'bash');
    assert.ok(bashStep, 'the shell command ran as a step');
    if (bashStep!.isError && /No bash shell|not found/i.test(bashStep!.summary)) return;   // no shell on this machine: skip
    assert.equal(bashStep!.isError, false, bashStep!.summary);
    assert.match(bashStep!.summary, /^Demo: first version\s+end\s*$/, 'the commit is read and the working tree is clean');
  } finally { fake.close(); app.stopAll(); }
});

test('in a directory whose path is too long for the Keeper a job ends with the limit and what to do, not with a folder that could not be made (Windows)', { timeout: 60_000 }, async (t) => {
  if (process.platform !== 'win32') { t.diagnostic('not on this system: the path limit is Windows’'); return; }
  const { app, project, fake } = await setup({ length: 255 });
  try {
    const job = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'x' }, prompt: 'Task: material organizing. DIRECTIVE bash echo hello' });
    const done = await app.keeper.waitFor(project.id, job.id);
    assert.equal(done.status, 'Failed');
    assert.equal(done.error, 'The Keeper cannot work in this project\'s directory: its path is 255 characters long, and on Windows the Keeper can only work in a directory whose path is at most 251 characters. Move the project to a shorter path.');
    assert.equal(fake.requests.length, 0, 'nothing is sent to the model');
  } finally { fake.close(); app.stopAll(); }
});

test('the runtime tells the shell guard its home: another writer\'s file made during a command stays and is named on the step on a live project, and is undone on a controlled trial (BQ)', { timeout: 90_000 }, async () => {
  const { app, project, projectDir, fake, home } = await setup();
  try {
    const key = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 24);
    // The command waits, after the guard's snapshot, until the other writer has written (boundary.ts's scratch directory).
    const run = async (name: string) => {
      const job = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'x' }, prompt: 'Task: material organizing. DIRECTIVE bash printf s > "$TMPDIR/started" && until [ -f "$TMPDIR/go" ]; do sleep 0.1; done && echo done' });
      const scratch = join(home, 'scratch', key(project.id), key(job.id));
      for (let i = 0; i < 400 && !existsSync(join(scratch, 'started')); i += 1) await new Promise((done) => setTimeout(done, 50));
      writeFileSync(join(projectDir, name), 'written by another writer');
      writeFileSync(join(scratch, 'go'), 'go');
      const done = await app.keeper.waitFor(project.id, job.id);
      return done.steps.find((s) => s.tool === 'bash')!;
    };
    const live = await run('by-another-writer-live.txt');   // settings.watchProjects not false: a live project
    if (live.isError && /No bash shell|not found/i.test(live.summary)) return;   // no shell on this machine: skip
    assert.equal(live.isError, false, live.summary);
    assert.match(live.summary, /^Changed while this command ran, not by it; left as it is: .*by-another-writer-live\.txt/, 'the step record names it');
    assert.ok(existsSync(join(projectDir, 'by-another-writer-live.txt')), 'the other writer\'s file stays');
    app.workspace.setSettings({ watchProjects: false });   // a controlled trial
    const trial = await run('by-another-writer-trial.txt');
    assert.equal(trial.isError, true);
    assert.match(trial.summary, /the changes were restored: .*by-another-writer-trial\.txt/);
    assert.equal(existsSync(join(projectDir, 'by-another-writer-trial.txt')), false, 'on a controlled trial every change is undone');
  } finally { fake.close(); app.stopAll(); }
});

test('what a step read is recorded on it as it ends: the file tool whole, a shell command some lines, a refused read nothing (Spec §1.11; CKC-13 AC-8)', { timeout: 60_000 }, async () => {
  const { app, project, projectDir, outside, fake } = await setup();
  try {
    const run = async (directive: string) => {
      const job = app.keeper.enqueue(project.id, { kind: 'Organizing', initiator: 'auto', scope: { kind: 'source', ids: [], label: 'x' }, prompt: `Task: material organizing. DIRECTIVE ${directive}` });
      return app.keeper.waitFor(project.id, job.id);
    };
    const read = (await run(`read ${join(projectDir, 'src', 'inside.txt')}`)).steps.find((s) => s.tool === 'read')!;
    assert.deepEqual(read.reads, [{ path: join(projectDir, 'src', 'inside.txt') }], 'the file tool showed it all');
    const refused = (await run(`read ${join(outside, 'secret.txt')}`)).steps.find((s) => s.tool === 'read')!;
    assert.deepEqual(refused.reads, [], 'a refused read read nothing — and is not counted by its target either');
    const shell = (await run('bash head -2 README.md && grep -n Demo README.md')).steps.find((s) => s.tool === 'bash')!;
    if (shell.isError && /No bash shell|not found/i.test(shell.summary)) return;   // no shell on this machine: skip
    assert.deepEqual(shell.reads, [{ path: join(projectDir, 'README.md'), from: 1, to: 2, lines: 3 }], 'head showed two of its three lines; grep only searched it');
  } finally { fake.close(); app.stopAll(); }
});
