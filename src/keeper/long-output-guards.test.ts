/**
 * CKC-03 AC-30 guards (QC AX-1), through App and pi against loopback providers:
 *  - a tool call whose streamed arguments did not arrive as complete JSON never runs, whichever tool it names — pi's
 *    built-in `write` included; the model is told to send it again in full, and the refused call is a step;
 *  - a `length` stop is a failure unless a complete reply follows it;
 *  - the count of one call refused the same way is kept in turns and starts again when anything else happens in between;
 *    calls to different targets refused together in one turn count once each (test-D-1).
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';

const scratch = mkdtempSync(join(tmpdir(), 'pk-long-output-'));
process.env.PI_CODING_AGENT_DIR = join(scratch, 'pi-agent');
after(async () => {
  // waitFor resolves on Keeper's done event, just before the runtime's final flush/dispose.
  await new Promise((resolve) => setTimeout(resolve, 300));
  rmSync(scratch, { recursive: true, force: true });
});

const { App } = await import('../server/app.ts');
const { startFakeProvider, FAKE_MODEL } = await import('./fake-provider.ts');
const { measureToolStream } = await import('./testing/streaming-arguments.ts');
const { REPEATED_REFUSAL_LIMIT } = await import('./step-timing.ts');

/** The patched pi-ai modules, in both installed copies (the Keeper's is the one under pi-coding-agent). */
type PiJson = { finalizeStreamingToolArguments(raw: string, block: object): unknown; incompleteToolArgumentsError(call: object): string | undefined };
type PiValidation = { validateToolArguments(tool: { name: string; parameters: unknown }, call: object): unknown };
const copies = ['../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai', '../../node_modules/@earendil-works/pi-ai'];
const piAi = await Promise.all(copies.map(async (copy) => ({
  copy,
  json: await import(new URL(`${copy}/dist/utils/json-parse.js`, import.meta.url).href) as PiJson,
  validation: await import(new URL(`${copy}/dist/utils/validation.js`, import.meta.url).href) as PiValidation,
})));

async function appFixture() {
  const home = mkdtempSync(join(scratch, 'home-'));
  const projectDir = mkdtempSync(join(scratch, 'project-'));
  mkdirSync(join(projectDir, 'docs'));
  writeFileSync(join(projectDir, 'README.md'), '# Guard project\n');
  const app = new App(home, { organizing: false });
  app.workspace.setSettings({ watchProjects: false });
  const project = app.addProject('Guard project', [projectDir]);
  await app.intakeProject(project.id);
  await app.initKeeper();
  const register = (url: string) => {
    app.keeper.models.registerProvider('fake', { name: 'Local guard fake', baseUrl: url, apiKey: 'fake', api: 'openai-completions', models: [FAKE_MODEL] });
    app.keeper.setModel({ provider: 'fake', id: FAKE_MODEL.id, thinking: null });
  };
  const enqueue = (label: string) => app.keeper.enqueue(project.id, {
    kind: 'Answering', initiator: 'owner', scope: { kind: 'question', ids: [], label }, prompt: label,
    step: { roundId: 'crd_guard', kind: 'orientation', path: null },
  });
  return { app, project, projectDir, register, enqueue, store: app.store(project.id) };
}

type Turn = { calls: { name: string; arguments: string }[]; finish?: 'tool_calls' | 'length'; outputTokens?: number } | string;
/** A provider that plays `turns` in order, one per request — no safety valve of its own; past the end it answers. */
function scriptedProvider(turns: readonly Turn[]): Promise<{ url: string; requests: { role: string; content: unknown }[][]; close(): void }> {
  const requests: { role: string; content: unknown }[][] = [];
  const server = createServer((req, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push((JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages);
      const turn = turns[requests.length - 1] ?? 'Done.';
      const chunk = (delta: object, finish: string | null, outputTokens = 8) => ({ id: 'guard', object: 'chat.completion.chunk', created: 1, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 80, completion_tokens: outputTokens, total_tokens: 80 + outputTokens } } : {}) });
      const chunks = typeof turn === 'string'
        ? [chunk({ role: 'assistant', content: turn }, null), chunk({}, 'stop')]
        : [chunk({ role: 'assistant', tool_calls: turn.calls.map((c, i) => ({ index: i, id: `call_${requests.length}_${i}`, type: 'function', function: { name: c.name, arguments: c.arguments } })) }, null), chunk({}, turn.finish ?? 'tool_calls', turn.outputTokens)];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const value of chunks) res.write(`data: ${JSON.stringify(value)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, requests, close: () => server.close() })));
}

const toolResults = (messages: { role: string; content: unknown }[]) => messages.filter((m) => m.role === 'tool').map((m) => String(m.content));

test('pi\'s built-in write never runs on cut-off arguments: nothing written, the model told to resend, the step visible', { timeout: 60_000 }, async (t) => {
  const f = await appFixture();
  const content = `# Notes\n${'a line of the note\n'.repeat(40)}END\n`;
  const complete = JSON.stringify({ path: 'notes/out.md', content });
  const cut = complete.slice(0, 200);
  const target = join(f.projectDir, 'notes', 'out.md');
  let writtenAfterRefusal: boolean | null = null;
  const fake = await startFakeProvider((_prompt, messages, afterTool) => {
    if (!afterTool) return [{ name: 'write', args: {}, rawArguments: cut }];
    if (messages.filter((m) => m.role === 'tool').length > 1) return 'Done.';
    writtenAfterRefusal = existsSync(target);
    return [{ name: 'write', args: {}, rawArguments: complete }];
  }, { toolArgumentChunkSize: 23 });
  try {
    f.register(fake.url);
    const job = f.enqueue('write-incomplete');
    const done = await f.app.keeper.waitFor(f.project.id, job.id);
    assert.ok(fake.requests[0]?.tools.includes('write'), 'write is offered in the step');
    assert.equal(writtenAfterRefusal, false, 'the cut-off call wrote nothing');
    const [refusal] = toolResults(fake.requests[1]!.messages);
    assert.match(refusal ?? '', /^Tool call "write" was not executed: its arguments did not arrive as complete JSON, so they may have been cut off\. Nothing was run; send the call again with the complete arguments\. \(200 characters arrived; /);
    const writes = done.steps.filter((s) => s.tool === 'write');
    assert.deepEqual(writes.map((s) => s.isError), [true, false]);
    assert.equal(writes[0]!.target, 'notes/out.md', 'the step names the call');
    assert.match(writes[0]!.summary, /^Tool call "write" was not executed/);
    assert.equal(readFileSync(target, 'utf8'), content, 'the re-sent call wrote the whole file');
    assert.equal(done.status, 'Done');
    t.diagnostic(JSON.stringify({ status: done.status, cutLength: cut.length, completeLength: complete.length, refusedStep: writes[0]!.summary }));
  } finally { fake.close(); f.app.stopAll(); }
});

test('the refusal holds for any tool — built-in, pk_* or an extension\'s — ahead of its validation, in both pi-ai copies', () => {
  const tools = [
    { name: 'write', parameters: Type.Object({ path: Type.String(), content: Type.String() }) },
    { name: 'ls', parameters: Type.Object({ path: Type.Optional(Type.String()) }) },
    { name: 'extension_anything', parameters: Type.Object({}, { additionalProperties: true }) },
  ];
  for (const { copy, json, validation } of piAi) {
    for (const tool of tools) {
      const raw = JSON.stringify({ path: 'a.md', content: 'x'.repeat(50) });
      const cut = { type: 'toolCall', id: 'c1', name: tool.name, arguments: {} as unknown };
      cut.arguments = json.finalizeStreamingToolArguments(raw.slice(0, 30), cut);
      // agent-loop copies the call when a tool prepares its arguments: the mark goes with the copy.
      const prepared = { ...cut, arguments: structuredClone(cut.arguments) };
      assert.throws(() => validation.validateToolArguments(tool, prepared), new RegExp(`^Error: Tool call "${tool.name}" was not executed: its arguments did not arrive as complete JSON`), `${copy} ${tool.name}`);
      assert.equal(JSON.stringify(cut).includes('projectkeeper'), false, 'the mark is never serialized into sessions or requests');
      const whole = { type: 'toolCall', id: 'c2', name: tool.name, arguments: {} as unknown };
      whole.arguments = json.finalizeStreamingToolArguments(raw, whole);
      assert.equal(json.incompleteToolArgumentsError(whole), undefined);
      assert.doesNotThrow(() => validation.validateToolArguments(tool, whole));
      // A block finalized twice (the Responses API's `.done`, then `output_item.done`) follows the last parse.
      cut.arguments = json.finalizeStreamingToolArguments(raw, cut);
      assert.equal(json.incompleteToolArgumentsError(cut), undefined, `${copy}: a later complete parse clears the mark`);
    }
    // No arguments at all stays upstream's empty object, not a refusal.
    const empty = { type: 'toolCall', id: 'c3', name: 'ls', arguments: {} as unknown };
    empty.arguments = json.finalizeStreamingToolArguments('', empty);
    assert.deepEqual(empty.arguments, {});
    assert.equal(json.incompleteToolArgumentsError(empty), undefined);
  }
});

test('on the Keeper\'s provider path exactly the calls that are not complete JSON are marked; the shown value is unchanged', async () => {
  const inputs = [
    JSON.stringify({ note: 'complete', n: 1 }),
    '{"note":"raw\nnewline\tand tab","tail":"last"}',   // pi repairs raw control characters: complete
    '{"note":"missing closing brace","nested":{"n":1}',
    '{"note":"cut inside a stri',
    '{"note":"two values"}{"note":"glued"}',
    '',
  ];
  const result = await measureToolStream(inputs, 7);
  const calls = result.message.content.filter((b) => b.type === 'toolCall');
  const { json } = piAi[0]!;
  assert.deepEqual(calls.map((c) => json.incompleteToolArgumentsError(c) !== undefined), [false, false, true, true, true, false]);
  assert.deepEqual(calls.map((c) => c.arguments), [{ note: 'complete', n: 1 }, { note: 'raw\nnewline\tand tab', tail: 'last' }, { note: 'missing closing brace', nested: { n: 1 } }, { note: 'cut inside a stri' }, { note: 'two values' }, {}]);
});

test('a length stop followed by a complete reply is Done; the calls it cut were refused, not run', { timeout: 60_000 }, async (t) => {
  const f = await appFixture();
  const fake = await scriptedProvider([
    { calls: [{ name: 'write', arguments: JSON.stringify({ path: 'cut.md', content: 'partial' }) }], finish: 'length', outputTokens: FAKE_MODEL.maxTokens },
    'Finished after the cut.',
  ]);
  try {
    f.register(fake.url);
    const job = f.enqueue('length-then-complete');
    const done = await f.app.keeper.waitFor(f.project.id, job.id);
    assert.equal(done.status, 'Done', done.error ?? '');
    assert.equal(done.resultText, 'Finished after the cut.');
    assert.equal(existsSync(join(f.projectDir, 'cut.md')), false);
    const [step] = done.steps;
    assert.equal(step?.isError, true);
    assert.match(step?.summary ?? '', /was not executed: the response hit the output token limit/);
    assert.equal(done.timing?.parseRetryMs, 0, 'the final answer re-sends nothing: generation, not parse/retry');
    t.diagnostic(JSON.stringify({ status: done.status, requests: fake.requests.length, step: step?.summary, timing: done.timing }));
  } finally { fake.close(); f.app.stopAll(); }
});

test('a step’s reply is kept verbatim, its leading and trailing lines included; a reply with no words is no result', { timeout: 60_000 }, async (t) => {
  const f = await appFixture();
  const reply = '\n\n  # Report\n\n- first finding  \n\n```\ncode block\n```\n\n';
  const fake = await scriptedProvider([reply, '  \n\t\n']);
  try {
    f.register(fake.url);
    const first = await f.app.keeper.waitFor(f.project.id, f.enqueue('verbatim').id);
    assert.equal(first.status, 'Done', first.error ?? '');
    assert.equal(first.resultText, reply, 'nothing trimmed on the way to the store');
    assert.equal(f.store.jobs.get(first.id)!.resultText, reply);
    const blank = await f.app.keeper.waitFor(f.project.id, f.enqueue('blank').id);
    assert.equal(blank.resultText, null, 'whitespace alone is no result');
    t.diagnostic(JSON.stringify({ kept: JSON.stringify(first.resultText) }));
  } finally { fake.close(); f.app.stopAll(); }
});

test('ten calls to different targets refused together in one turn do not end the job; the same ten re-sent turn after turn do', { timeout: 60_000 }, async (t) => {
  // test-D-1's skeleton sent ten parallel calls, each refused for one missing field, and the guard read them as one call
  // refused ten times. Here each of ten Briefs lacks its kind, which the schema still requires, so pi refuses all ten.
  const f = await appFixture();
  const briefs = Array.from({ length: 10 }, (_, i) => ({ name: 'pk_write_round_doc', arguments: JSON.stringify({ path: `sweep-${i + 1}`, title: `Brief ${i + 1}`, markdown: `# Brief ${i + 1}` }) }));
  const fixed = briefs.map((b) => ({ ...b, arguments: JSON.stringify({ kind: 'Brief', ...JSON.parse(b.arguments) as object }) }));
  const once = await scriptedProvider([{ calls: briefs }, { calls: fixed }, 'Ten briefs written.']);
  try {
    f.register(once.url);
    const job = f.enqueue('ten-refused-once');
    const done = await f.app.keeper.waitFor(f.project.id, job.id);
    assert.equal(done.status, 'Done', done.error ?? '');
    assert.equal(done.steps.filter((s) => s.isError).length, 10, 'all ten were refused');
    assert.match(toolResults(once.requests[1]!).join('\n'), /must have required propert/, 'by pi, before they ran');
    assert.equal(f.store.roundDocs.filter((d) => d.jobId === job.id).length, 10, 'and the model was asked again, and wrote them');
    assert.equal(once.requests.length, 3);
  } finally { once.close(); f.app.stopAll(); }
  const g = await appFixture();
  const again = await scriptedProvider([...Array(REPEATED_REFUSAL_LIMIT + 2).fill({ calls: briefs }), 'Never asked.']);
  try {
    g.register(again.url);
    const job = g.enqueue('ten-refused-again-and-again');
    const done = await g.app.keeper.waitFor(g.project.id, job.id);
    assert.equal(done.status, 'Failed');
    assert.equal(again.requests.length, REPEATED_REFUSAL_LIMIT, 'the model is not asked again after the limit');
    assert.equal(done.steps.filter((s) => s.isError).length, 10 * REPEATED_REFUSAL_LIMIT);
    assert.match(done.error ?? '', new RegExp(`the same call to pk_write_round_doc in ${REPEATED_REFUSAL_LIMIT} turns in a row, refused the same way each time`));
    assert.match(done.error ?? '', /9 more refused calls were re-sent with it/);
    assert.equal(g.store.roundDocs.filter((d) => d.jobId === job.id).length, 0);
    t.diagnostic(JSON.stringify({ once: 'Done', again: done.status, requests: again.requests.length, error: done.error }));
  } finally { again.close(); g.app.stopAll(); }
});

test('a call cut off at the output limit turn after turn ends the job at the limit: each cut is the same refused call', { timeout: 60_000 }, async (t) => {
  const f = await appFixture();
  // Each reply hits the output limit inside a long write, cut at another length every time: pi refuses the call unrun.
  const cut = (i: number) => ({ calls: [{ name: 'write', arguments: JSON.stringify({ path: 'notes/long.md', content: 'x'.repeat(40 + i * 17) }) }], finish: 'length' as const, outputTokens: FAKE_MODEL.maxTokens });
  const fake = await scriptedProvider([...Array.from({ length: REPEATED_REFUSAL_LIMIT + 2 }, (_, i) => cut(i)), 'Never asked.']);
  try {
    f.register(fake.url);
    const job = f.enqueue('cut-again-and-again');
    const done = await f.app.keeper.waitFor(f.project.id, job.id);
    assert.equal(done.status, 'Failed');
    const writes = done.steps.filter((s) => s.tool === 'write');
    assert.equal(writes.length, REPEATED_REFUSAL_LIMIT);
    assert.ok(writes.every((s) => s.isError && /was not executed: the response hit the output token limit/.test(s.summary)), 'every cut call was refused, not run');
    assert.equal(existsSync(join(f.projectDir, 'notes', 'long.md')), false);
    assert.match(done.error ?? '', new RegExp(`the same call to write in ${REPEATED_REFUSAL_LIMIT} turns in a row`));
    t.diagnostic(JSON.stringify({ status: done.status, requests: fake.requests.length, error: done.error }));
  } finally { fake.close(); f.app.stopAll(); }
});

test('refusals of one call with anything else in between never reach the limit', { timeout: 60_000 }, async (t) => {
  const f = await appFixture();
  // A History map with no text would create one without what a new document needs: the writer refuses it every time
  // (the Questions written in between is another document, so this never becomes an update).
  const refused = { calls: [{ name: 'pk_write_round_doc', arguments: JSON.stringify({ kind: 'History map', title: 'Missing markdown' }) }] };
  const runs = { calls: [{ name: 'pk_write_round_doc', arguments: JSON.stringify({ kind: 'Questions', title: 'Written', markdown: '# Written' }) }] };
  const other = { calls: [{ name: 'ls', arguments: '{}' }] };
  const below = REPEATED_REFUSAL_LIMIT - 1;
  const fake = await scriptedProvider([...Array(below).fill(refused), runs, ...Array(below).fill(refused), other, ...Array(below).fill(refused), 'Gave up on the rest.']);
  try {
    f.register(fake.url);
    const job = f.enqueue('refusals-reset');
    const done = await f.app.keeper.waitFor(f.project.id, job.id);
    assert.equal(done.status, 'Done', done.error ?? '');
    assert.equal(done.steps.filter((s) => s.isError).length, 3 * below);
    assert.equal(f.store.roundDocs.filter((d) => d.jobId === job.id).length, 1);
    assert.equal(fake.requests.length, 3 * below + 3);
    t.diagnostic(JSON.stringify({ status: done.status, requests: fake.requests.length, refused: 3 * below }));
  } finally { fake.close(); f.app.stopAll(); }
});
