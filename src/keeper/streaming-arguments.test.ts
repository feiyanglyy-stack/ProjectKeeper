import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseJsonWithRepair, parseStreamingJson } from '@earendil-works/pi-ai/utils/json-parse';
import { measureToolStream, syntheticArguments } from './testing/streaming-arguments.ts';

test('long fragmented tool arguments keep the event loop responsive', async (t) => {
  await measureToolStream([syntheticArguments(1000)]);
  const input = syntheticArguments(100000);
  const result = await measureToolStream([input]);
  t.diagnostic(JSON.stringify({ elapsedMs: result.elapsedMs, maxDelayMs: result.maxDelayMs }));
  assert.deepEqual(result.wire, [input]);
  assert.deepEqual(result.ended, [input]);
  // The original adapter stalls for >2 seconds here; fixed runs are tens of ms.
  // Generous margin for the full parallel suite and slower CI machines.
  assert.ok(result.maxDelayMs < 1500, `event loop stalled ${result.maxDelayMs.toFixed(0)} ms (limit 1500 ms)`);
});

test('interleaved tool calls finalize with the original repair and incomplete-JSON semantics', async () => {
  const inputs = [
    JSON.stringify({ note: 'line\nquote " slash \\ 中文 😀'.repeat(80), count: 42, items: [true, null, { n: -1.25 }] }),
    '{"note":"raw\nnewline\tand tab","tail":"last"}',
    '{"note":"missing closing brace","nested":{"n":1}',
    '{"note":"raw\nnewline and missing brace"',
    '{"note":"invalid \\q escape","ok":true}',
    '',
  ];
  const expected = inputs.map((s) => JSON.stringify(parseStreamingJson(s)));
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../../scripts/benchmark-tool-stream.ts', import.meta.url)), '--baseline', '--consistency', JSON.stringify(inputs),
  ], { timeout: 10000 });
  assert.deepEqual(JSON.parse(stdout), { wire: inputs, ended: expected });
  assert.equal(expected[1], JSON.stringify(parseJsonWithRepair(inputs[1]!)));
  for (const size of [10, 20, 30]) {
    const result = await measureToolStream(inputs, size);
    assert.deepEqual(result.wire, inputs);
    assert.deepEqual(result.ended, expected);
    assert.deepEqual(result.message.content.filter((b) => b.type === 'toolCall').map((b) => JSON.stringify(b.arguments)), expected);
    assert.ok(result.message.content.every((b) => !('partialArgs' in b)));
  }
});
