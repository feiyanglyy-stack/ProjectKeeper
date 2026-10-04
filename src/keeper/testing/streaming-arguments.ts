import { setTimeout as delay } from 'node:timers/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { FAKE_MODEL, startFakeProvider } from '../fake-provider.ts';

const noCredentials: CredentialStore = {
  async read() { return undefined; },
  async list() { return []; },
  async modify(_providerId, fn) { return fn(undefined); },
  async delete() {},
};

/** Keeper's real ModelRuntime/provider path, loopback HTTP only, synthetic in-memory credentials. */
export async function measureToolStream(inputs: string[], chunkSize = 20) {
  const fake = await startFakeProvider(() => inputs.map((rawArguments) => ({ name: 'synthetic_note', args: {}, rawArguments })), { toolArgumentChunkSize: chunkSize });
  const provider = 'ao-local-test';
  const runtime = await ModelRuntime.create({ credentials: noCredentials, modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider(provider, {
    name: 'AO local test', baseUrl: fake.url, api: 'openai-completions', apiKey: 'local-fake-key',
    models: [{ ...FAKE_MODEL, api: 'openai-completions', baseUrl: fake.url }],
  });
  const model = runtime.getModel(provider, FAKE_MODEL.id);
  if (!model) throw new Error('AO local test model registration failed');
  let maxDelayMs = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxDelayMs = Math.max(maxDelayMs, now - last - 10);
    last = now;
  }, 10);
  const started = performance.now();
  let deltas = 0;
  const wire = inputs.map(() => '');
  const ended: string[] = [];
  try {
    const events = runtime.streamSimple(model, {
      messages: [{ role: 'user', content: 'Emit the synthetic tool calls.', timestamp: 0 }],
    }, { apiKey: 'local-fake-key', maxTokens: 100000, maxRetries: 0 });
    for await (const event of events) {
      if (event.type === 'toolcall_delta') { deltas++; wire[event.contentIndex] += event.delta; }
      if (event.type === 'toolcall_end') ended.push(JSON.stringify(event.toolCall.arguments));
    }
    const message = await events.result();
    const elapsedMs = performance.now() - started;
    // Let the overdue timer fire even when the stream completed in one microtask burst.
    await delay(20);
    if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage);
    return { elapsedMs, maxDelayMs, deltas, wire, ended, message };
  } finally {
    clearInterval(timer);
    fake.close();
  }
}

export function syntheticArguments(bytes: number): string {
  return JSON.stringify({ note: 'x'.repeat(bytes - 11) });
}
