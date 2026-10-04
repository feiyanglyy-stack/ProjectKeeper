/**
 * Where a job's time went (Spec §3.10, D81; CKC-23 AC-10): the split has to add up to the wall clock, count parallel tool
 * calls once, and put failed requests, retry waits and re-sent refused calls under parsing and retrying — the way the
 * test-B-1 baseline counted them (E106), so the next run compares with it. And the guard that ends a step re-sending the
 * same refused call turn after turn (CKC-03 AC-30; QC AX-1), which counts turns, not results (test-D-1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardTurn, incompleteCall, isRefusal, keeperBuiltinTools, RefusalStreak, REPEATED_REFUSAL_LIMIT, StepTimer } from './step-timing.ts';

test('generation, parallel tool calls and the rest add up to the wall clock', () => {
  const t = new StepTimer();
  // turn 1: request sent at 1000, reply at 3000 (2 s generation); two tools in parallel 3000–3500 and 3100–4000
  t.assistantEnded({ timestamp: 1000, stopReason: 'toolUse' }, 3000);
  t.toolStarted(3000); t.toolStarted(3100); t.toolEnded(3500, false, 'ok'); t.toolEnded(4000, false, 'ok');
  // turn 2: request at 4000, final answer at 7000
  t.assistantEnded({ timestamp: 4000, stopReason: 'stop' }, 7000);
  const timing = t.finish(0, 500, 7500);
  assert.equal(timing.generationMs, 5000);
  assert.equal(timing.toolMs, 1000, 'the two parallel calls count once, first start to last end');
  assert.equal(timing.parseRetryMs, 0);
  assert.equal(timing.queueMs, 500);
  assert.equal(timing.wallMs, 7000);
  assert.equal(timing.otherMs, 1000, 'what is left: before the first request and after the last reply');
});

test('a failed request, the wait before pi re-sends it, and the re-send of refused calls are parsing and retrying', () => {
  const t = new StepTimer();
  t.assistantEnded({ timestamp: 0, stopReason: 'error' }, 400);          // failed request
  t.retryWait(2000);                                                     // pi waits 2 s before retrying
  t.assistantEnded({ timestamp: 2400, stopReason: 'toolUse' }, 3400);   // a turn whose only call is refused
  t.toolStarted(3400); t.toolEnded(3410, true, 'Validation failed for tool "pk_write_note": must have required property "title"');
  t.assistantEnded({ timestamp: 3410, stopReason: 'toolUse' }, 4410);   // re-sends it: parsing and retrying
  t.toolStarted(4410); t.toolEnded(4500, false, 'ok');
  t.assistantEnded({ timestamp: 4500, stopReason: 'stop' }, 5500);
  const timing = t.finish(0, 0, 5500);
  assert.equal(timing.parseRetryMs, 400 + 2000 + 1000);
  assert.equal(timing.generationMs, 1000 + 1000, 'the refused turn itself stays generation, as in the baseline');
  assert.equal(timing.toolMs, 10 + 90);
});

test('a turn with only some calls refused is not a re-send', () => {
  const t = new StepTimer();
  t.assistantEnded({ timestamp: 0, stopReason: 'toolUse' }, 100);
  t.toolStarted(100); t.toolStarted(100);
  t.toolEnded(150, true, 'Unknown tool: pk_nothing'); t.toolEnded(200, false, 'ok');
  t.assistantEnded({ timestamp: 200, stopReason: 'stop' }, 1200);
  const timing = t.finish(0, 0, 1200);
  assert.equal(timing.parseRetryMs, 0);
  assert.equal(timing.generationMs, 1100);
});

test('after a refusal, the next turn is a re-send only when it sends a tool call (QC AX-1)', () => {
  const refuse = (t: StepTimer, at: number, text: string) => { t.toolStarted(at); t.toolEnded(at + 10, true, text); };
  // A final answer after a refused call re-sends nothing: generation.
  const answered = new StepTimer();
  answered.assistantEnded({ timestamp: 0, stopReason: 'toolUse' }, 100);
  refuse(answered, 100, 'Validation failed for tool "pk_write_note": must have required property "title"');
  answered.assistantEnded({ timestamp: 110, stopReason: 'stop', content: [{ type: 'text' }] }, 1110);
  assert.deepEqual([answered.finish(0, 0, 1110).parseRetryMs, answered.finish(0, 0, 1110).generationMs], [0, 1100]);
  // pi's refusals of cut-off calls — at the output limit, or not complete JSON — are refusals too; a turn that sends the
  // call again is the re-send, whatever its own stop reason (a re-send cut off again is still one).
  for (const text of [
    'Tool call "write" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.',
    'Tool call "write" was not executed: its arguments did not arrive as complete JSON, so they may have been cut off. Nothing was run; send the call again with the complete arguments. (88 characters arrived; Unterminated string in JSON at position 88)',
  ]) {
    const resent = new StepTimer();
    resent.assistantEnded({ timestamp: 0, stopReason: 'toolUse' }, 100);
    refuse(resent, 100, text);
    resent.assistantEnded({ timestamp: 110, stopReason: 'length', content: [{ type: 'text' }, { type: 'toolCall' }] }, 1110);
    assert.equal(resent.finish(0, 0, 1110).parseRetryMs, 1000, text.slice(0, 60));
  }
  // A tool that ran and failed is not a refusal: the next turn is generation.
  const failed = new StepTimer();
  failed.assistantEnded({ timestamp: 0, stopReason: 'toolUse' }, 100);
  refuse(failed, 100, 'ENOENT: no such file or directory');
  failed.assistantEnded({ timestamp: 110, stopReason: 'toolUse', content: [{ type: 'toolCall' }] }, 1110);
  assert.equal(failed.finish(0, 0, 1110).parseRetryMs, 0);
});

// ───────────────────────── the refusal guard: the same call re-sent turn after turn (QC AX-1; test-D-1) ─────────────────────────

/** pi's refusal of a call that lacks a required field, echoing the arguments after it as pi does. */
const missingField = (tool: string, field: string, args: object) =>
  `Validation failed for tool "${tool}":\n  - ${field}: must have required properties ${field}\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`;
const QUESTIONS = { kind: 'Questions', title: 'Still missing markdown' };
/** One turn whose only call is the round document refused for its missing markdown (the QC AX-1 call). */
const axTurn = (args: object = QUESTIONS) => ({ stopReason: 'toolUse', calls: [{ tool: 'pk_write_round_doc', args, isError: true, resultText: missingField('pk_write_round_doc', 'markdown', args) }] });
const turns = (streak: RefusalStreak, turn: Parameters<RefusalStreak['turnEnded']>[0], n: number) => { for (let i = 0; i < n; i++) streak.turnEnded(turn); };

test(`the same call refused the same way in ${REPEATED_REFUSAL_LIMIT} turns in a row reaches the limit; any other turn in between starts the count again`, () => {
  const streak = new RefusalStreak();
  turns(streak, axTurn(), REPEATED_REFUSAL_LIMIT - 1);
  assert.equal(streak.reached, null, 'one short of the limit');
  streak.turnEnded(axTurn({ title: 'Still missing markdown', kind: 'Questions' }));   // the same arguments, keys in another order
  assert.deepEqual(streak.reached, { tool: 'pk_write_round_doc', error: 'Validation failed for tool "pk_write_round_doc": - markdown: must have required properties markdown', turns: REPEATED_REFUSAL_LIMIT, alongside: 0 });
  // Each of these, as the turn in between, starts the count again: a call that ran, a call that ran and failed, the same
  // error from another tool, another error from the same tool, the same error for a call with other arguments.
  const between: [string, Parameters<RefusalStreak['turnEnded']>[0]][] = [
    ['a call that ran', { stopReason: 'toolUse', calls: [{ tool: 'pk_write_round_doc', args: { ...QUESTIONS, markdown: '# Q' }, isError: false, resultText: '{ "id": "rdoc_1" }' }] }],
    ['a call that ran and failed', { stopReason: 'toolUse', calls: [{ tool: 'read', args: { path: 'x.md' }, isError: true, resultText: 'ENOENT: no such file or directory' }] }],
    ['the same error from another tool', { stopReason: 'toolUse', calls: [{ tool: 'pk_write_note', args: QUESTIONS, isError: true, resultText: missingField('pk_write_note', 'markdown', QUESTIONS) }] }],
    ['another error from the same tool', { stopReason: 'toolUse', calls: [{ tool: 'pk_write_round_doc', args: QUESTIONS, isError: true, resultText: 'Validation failed for tool "pk_write_round_doc":\n  - kind: must be equal to one of the allowed values' }] }],
    ['the same error for other arguments', axTurn({ kind: 'Questions', title: 'Another title' })],
    ['a final answer', { stopReason: 'stop', calls: [] }],
  ];
  for (const [what, turn] of between) {
    const s = new RefusalStreak();
    turns(s, axTurn(), REPEATED_REFUSAL_LIMIT - 1);
    s.turnEnded(turn);
    turns(s, axTurn(), REPEATED_REFUSAL_LIMIT - 1);
    assert.equal(s.reached, null, what);
  }
  // A request that failed or was aborted is no turn of the model's: the count goes on across it.
  const retried = new RefusalStreak();
  turns(retried, axTurn(), REPEATED_REFUSAL_LIMIT - 1);
  retried.turnEnded({ stopReason: 'error', calls: [] });
  retried.turnEnded(axTurn());
  assert.equal(retried.reached?.turns, REPEATED_REFUSAL_LIMIT);
});

test('calls to different targets refused for the same reason in one turn count once each; the same batch re-sent turn after turn still ends the step (test-D-1)', () => {
  // test-D-1's skeleton: ten updates of ten work items in one reply, each refused for the title and progress it had to
  // repeat. Kept per result and keyed on tool and error, that read as one call refused ten times and ended the job.
  const update = (n: number) => ({ id: `CKC-${String(n).padStart(2, '0')}`, replaceServes: true, serves: [{ referenceId: `ref_area_${n}`, claim: 'the area it serves', basis: 'Explicit' }] });
  const batch = { stopReason: 'toolUse', calls: [1, 2, 3, 4, 5, 7, 8, 9, 10, 11].map((n) => ({ tool: 'pk_write_thread', args: update(n), isError: true, resultText: missingField('pk_write_thread', 'title', update(n)) })) };
  const streak = new RefusalStreak();
  streak.turnEnded(batch);
  assert.equal(streak.reached, null, 'ten refusals in one turn are ten calls, once each');
  turns(streak, batch, REPEATED_REFUSAL_LIMIT - 2);
  assert.equal(streak.reached, null, 'one short of the limit');
  streak.turnEnded(batch);
  const hit = (streak as RefusalStreak).reached;
  assert.equal(hit?.turns, REPEATED_REFUSAL_LIMIT, 'the same batch re-sent turn after turn reaches it');
  assert.equal(hit?.alongside, 9, 'with the nine others re-sent beside it');
  // The same call twice in one turn is one re-send, not two.
  const twice = new RefusalStreak();
  turns(twice, { stopReason: 'toolUse', calls: [...axTurn().calls, ...axTurn().calls] }, REPEATED_REFUSAL_LIMIT - 1);
  assert.equal(twice.reached, null);
  // A batch that shrinks keeps counting what it still re-sends; what it dropped is gone.
  const shrinking = new RefusalStreak();
  turns(shrinking, batch, REPEATED_REFUSAL_LIMIT - 1);
  shrinking.turnEnded({ stopReason: 'toolUse', calls: batch.calls.slice(0, 1) });
  assert.deepEqual([shrinking.reached?.turns, shrinking.reached?.alongside], [REPEATED_REFUSAL_LIMIT, 0]);
  // A turn in which anything ran is the model doing something else: a refusal beside it starts no run of turns.
  const mixed = new RefusalStreak();
  turns(mixed, { stopReason: 'toolUse', calls: [...axTurn().calls, { tool: 'ls', args: {}, isError: false, resultText: 'docs/' }] }, REPEATED_REFUSAL_LIMIT * 2);
  assert.equal(mixed.reached, null);
});

test('a call cut off at a different length each turn is the same refused call: what arrived is not what the model sent', () => {
  const cut = new RefusalStreak();
  for (let i = 0; i < REPEATED_REFUSAL_LIMIT; i++) {
    const arrived = `{"path":"notes/out.md","content":"${'x'.repeat(60 + i * 37)}`;
    cut.turnEnded({ stopReason: 'toolUse', calls: [{ tool: 'write', args: { path: 'notes/out.md', content: 'x'.repeat(60 + i * 37) }, isError: true, resultText: `Tool call "write" was not executed: its arguments did not arrive as complete JSON, so they may have been cut off. Nothing was run; send the call again with the complete arguments. (${arrived.length} characters arrived; Unterminated string in JSON at position ${arrived.length})` }] });
  }
  assert.equal(cut.reached?.turns, REPEATED_REFUSAL_LIMIT);
  // So is a reply cut at the output limit, whose every call pi refuses.
  const length = new RefusalStreak();
  for (let i = 0; i < REPEATED_REFUSAL_LIMIT; i++) {
    length.turnEnded({ stopReason: 'length', calls: [{ tool: 'write', args: { path: `part-${i}.md` }, isError: true, resultText: 'Tool call "write" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.' }] });
  }
  assert.equal(length.reached?.turns, REPEATED_REFUSAL_LIMIT);
});

test('the guard reads a turn as pi finishes it: each call with its own result, matched by the call id', () => {
  const turn = guardTurn({
    message: { stopReason: 'toolUse', content: [
      { type: 'thinking', thinking: '…' },
      { type: 'toolCall', id: 'c1', name: 'pk_write_thread', arguments: { id: 'CKC-01' } },
      { type: 'text', text: 'Fixing the serves.' },
      { type: 'toolCall', id: 'c2', name: 'pk_write_thread', arguments: { id: 'CKC-02' } },
    ] },
    // Parallel calls end in any order; the second one's result comes back first.
    toolResults: [
      { toolCallId: 'c2', isError: false, content: [{ type: 'text', text: '{ "id": "CKC-02", "updated": true }' }] },
      { toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'Invalid arguments: …' }] },
    ],
  });
  assert.deepEqual(turn, { stopReason: 'toolUse', calls: [
    { tool: 'pk_write_thread', args: { id: 'CKC-01' }, isError: true, resultText: 'Invalid arguments: …' },
    { tool: 'pk_write_thread', args: { id: 'CKC-02' }, isError: false, resultText: '{ "id": "CKC-02", "updated": true }' },
  ] });
});

test('a write tool’s refusal of an incomplete create reads as the refusal of a call that never ran', () => {
  const refusal = incompleteCall('a new work item needs title and progress, which this call leaves out. Nothing was written.');
  assert.ok(refusal instanceof Error, 'it is thrown, so pi records the result as an error');
  assert.equal(isRefusal(true, refusal.message), true);
  // The turn after it that sends a call again is the re-send, as after pi's own refusal of the same call.
  const t = new StepTimer();
  t.assistantEnded({ timestamp: 0, stopReason: 'toolUse' }, 100);
  t.toolStarted(100); t.toolEnded(110, true, refusal.message);
  t.assistantEnded({ timestamp: 110, stopReason: 'toolUse', content: [{ type: 'toolCall' }] }, 1110);
  assert.equal(t.finish(0, 0, 1110).parseRetryMs, 1000);
});

test('every pi built-in tool is on, powershell on Windows only', () => {
  assert.deepEqual(keeperBuiltinTools('linux'), ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
  assert.ok(keeperBuiltinTools('win32').includes('powershell'));
  for (const name of ['grep', 'find', 'ls']) assert.ok(keeperBuiltinTools('win32').includes(name), `${name} is on (D87)`);
});
