/**
 * Each model step of a round can run on its own model and thinking level (CKC-03 AC-29, CKC-23 AC-11): the setting
 * names a model on the chosen key's provider and one of pi's thinking levels; a step set to null goes back to the
 * chosen model; the ledger step is the program and takes no model.
 *
 * The routes are called directly on a stub app, as lookup.test.ts does; nothing is served.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRoutes } from './api.ts';
import { HttpError } from './http.ts';

function setup() {
  let settings: Record<string, unknown> = { model: { provider: 'zai-coding-cn', id: 'glm-5.3', thinking: 'max' } };
  const known = new Set(['zai-coding-cn/glm-5.3', 'zai-coding-cn/glm-5.3-flash']);
  const handlers = new Map<string, (ctx: unknown) => unknown>();
  const http = { route: (method: string, path: string, handler: (ctx: unknown) => unknown) => handlers.set(`${method} ${path}`, handler), static: () => undefined };
  const app = {
    workspace: { get settings() { return settings; }, setSettings: (patch: Record<string, unknown>) => { settings = { ...settings, ...patch }; return settings; }, list: () => [] },
    keeper: { models: { getModel: (provider: string, id: string) => (known.has(`${provider}/${id}`) ? { provider, id } : undefined) } },
  };
  registerRoutes(http as never, app as never, '', '');
  const post = (steps: unknown) => handlers.get('POST /api/settings/steps')!({ params: {}, query: new URLSearchParams(), body: { steps } }) as { steps: Record<string, unknown> };
  const get = () => handlers.get('GET /api/settings/steps')!({ params: {}, query: new URLSearchParams(), body: null }) as { steps: Record<string, unknown>; kinds: string[]; thinking: string[]; as: Record<string, string> };
  return { post, get };
}

test('a step gets its own model and thinking level, and null gives it back to the chosen model (CKC-03 AC-29)', () => {
  const { post, get } = setup();
  assert.deepEqual(get().steps, {});
  assert.ok(!get().kinds.includes('ledger') && get().kinds.includes('orientation'), 'the ledger is the program: it takes no model');
  for (const kind of ['main', 'lane', 'spot-check']) assert.ok(get().kinds.includes(kind), `D99: the main agent, each lane and the spot-check can be set apart (CKC-23 AC-11): ${kind}`);
  post({ main: { thinking: 'max' }, lane: { model: 'glm-5.3-flash' } });
  assert.deepEqual(get().steps, { main: { thinking: 'max' }, lane: { model: 'glm-5.3-flash' } });
  post({ main: null, lane: null });
  assert.deepEqual(get().thinking, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

  post({ orientation: { model: 'glm-5.3', thinking: 'max' }, dig: { thinking: 'high' } });
  assert.deepEqual(get().steps, { orientation: { model: 'glm-5.3', thinking: 'max' }, dig: { thinking: 'high' } });
  post({ dig: null, synthesis: { model: 'glm-5.3-flash' } });
  assert.deepEqual(get().steps, { orientation: { model: 'glm-5.3', thinking: 'max' }, synthesis: { model: 'glm-5.3-flash' } }, 'a step set to null uses the chosen model again; others stay');
});

test('an unknown step, a model the chosen provider lacks, or an unknown thinking level is refused, and nothing changes', () => {
  const { post, get } = setup();
  post({ orientation: { thinking: 'max' } });
  const refused = (steps: unknown, pattern: RegExp) => assert.throws(() => post(steps), (e: unknown) => e instanceof HttpError && pattern.test(e.message));
  refused({ ledger: { model: 'glm-5.3' } }, /not a model step/);
  refused({ orientation: { model: 'mimo-v2.6-pro' } }, /has no model mimo-v2\.6-pro/);
  refused({ orientation: { thinking: 'extreme' } }, /thinking must be one of/);
  refused(['orientation'], /object keyed by step/);
  assert.deepEqual(get().steps, { orientation: { thinking: 'max' } });
});

test('the main agent and its lanes (D99) each take their own model and thinking level, as the steps table offers them', () => {
  const { post, get } = setup();
  assert.ok(get().kinds.includes('main') && get().kinds.includes('lane'), 'the table offers both');
  post({ main: { thinking: 'max' }, lane: { model: 'glm-5.3-flash' } });
  assert.deepEqual(get().steps, { main: { thinking: 'max' }, lane: { model: 'glm-5.3-flash' } });
});

test('the synthesis is a model step of its own (D103): the table offers it, and says it runs as the main agent is set when left unset', () => {
  const { post, get } = setup();
  assert.ok(get().kinds.includes('synthesis'), 'the table offers the synthesis');
  assert.deepEqual(get().as, { synthesis: 'main' }, 'left unset, it runs on what main is set to');
  // A home whose settings were written before D103 has no entry for it: nothing is written for it, and it still works.
  post({ main: { model: 'glm-5.3', thinking: 'max' }, 'spot-check': { thinking: 'max' } });
  assert.deepEqual(get().steps, { main: { model: 'glm-5.3', thinking: 'max' }, 'spot-check': { thinking: 'max' } });
  post({ synthesis: { model: 'glm-5.3-flash' } });
  assert.deepEqual(get().steps, { main: { model: 'glm-5.3', thinking: 'max' }, 'spot-check': { thinking: 'max' }, synthesis: { model: 'glm-5.3-flash' } }, 'and it takes a setting of its own');
  post({ synthesis: null });
  assert.deepEqual(get().steps, { main: { model: 'glm-5.3', thinking: 'max' }, 'spot-check': { thinking: 'max' } });
});
