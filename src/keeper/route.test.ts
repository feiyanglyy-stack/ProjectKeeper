/**
 * A project's route (Spec §6.10 每一步用哪个模型、备用与并行, §3.10; D105; CKC-03 AC-29, AC-35): each step's model or
 * whom it follows, the keys in order, which keys a job may go to, the model it runs on there. Pure functions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keysForJob, modelOnKey, onPin, routeKeys, routeOf, wantOf } from './route.ts';

const settings = { model: { provider: 'zai-coding-cn', id: 'glm-5.3', thinking: 'max' }, modelBackups: [{ provider: 'zai-coding-cn-team', id: 'glm-5.3', thinking: 'max' }], steps: {} };
const carries: Record<string, string[]> = {
  'zai-coding-cn': ['glm-5.3', 'glm-5.3-flash'], 'zai-coding-cn-team': ['glm-5.3', 'glm-5.3-flash'], zai: ['glm-5.3', 'glm-5.3-flash'], deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
};
const has = (key: string, model: string) => (carries[key] ?? []).includes(model);

test('a project without a route of its own runs on the machine’s settings; one with a route runs on its own', () => {
  const machine = routeOf({}, settings);
  assert.equal(machine.own, false);
  assert.deepEqual(machine.main, settings.model);
  const own = routeOf({ route: { model: { provider: 'deepseek', id: 'deepseek-flash', thinking: 'high' }, backups: [], steps: { lane: { provider: 'zai-coding-cn', model: 'glm-5.3-flash' } }, savedAt: '2026-10-02T00:00:00Z' } }, settings);
  assert.equal(own.own, true);
  assert.equal(own.main?.provider, 'deepseek');
});

test('a step set apart runs on its own model; a step not set follows the main model, and says so; the synthesis follows the main agent', () => {
  const route = routeOf({ route: { model: { provider: 'zai-coding-cn', id: 'glm-5.3', thinking: 'max' }, backups: [], steps: { lane: { provider: 'deepseek', model: 'deepseek-flash', thinking: 'high' }, main: { thinking: 'xhigh' } }, savedAt: 'x' } }, settings);
  assert.deepEqual(wantOf(route, 'lane'), { provider: 'deepseek', model: 'deepseek-flash', thinking: 'high', follows: null, pin: { at: 'deepseek', loose: false } });
  assert.deepEqual(wantOf(route, 'spot-check'), { provider: 'zai-coding-cn', model: 'glm-5.3', thinking: 'max', follows: 'main model', pin: null });
  assert.deepEqual(wantOf(route, 'main'), { provider: 'zai-coding-cn', model: 'glm-5.3', thinking: 'xhigh', follows: 'main model', pin: null }, 'its own thinking, the main model');
  assert.deepEqual(wantOf(route, 'synthesis'), { provider: 'zai-coding-cn', model: 'glm-5.3', thinking: 'xhigh', follows: 'main', pin: null }, 'D103: as the main agent is set');
  assert.deepEqual(wantOf(route, null), { provider: 'zai-coding-cn', model: 'glm-5.3', thinking: 'max', follows: 'main model', pin: null }, 'the owner’s work: the main model');
  // The main model changed: every step that follows it changes with it.
  const moved = { ...route, main: { provider: 'zai-coding-cn', id: 'glm-5.3-flash', thinking: 'low' } };
  assert.equal(wantOf(moved, 'spot-check').model, 'glm-5.3-flash');
  assert.equal(wantOf(moved, 'lane').model, 'deepseek-flash', 'a step set apart stays');
});

test('the keys of a route: the main key, the backups in order, then a key that carries a step’s model', () => {
  const route = routeOf({ route: { model: { provider: 'zai-coding-cn', id: 'glm-5.3', thinking: 'max' }, backups: [{ provider: 'zai', id: 'glm-5.3', thinking: 'max' }, { provider: 'zai-coding-cn-team', id: 'glm-5.3', thinking: 'max' }], steps: { lane: { provider: 'deepseek', model: 'deepseek-flash' } }, savedAt: 'x' } }, settings);
  assert.deepEqual(routeKeys(route, ['zai-coding-cn-team', 'deepseek', 'zai'], has).map((k) => `${k.provider}/${k.id}`), ['zai-coding-cn/glm-5.3', 'zai/glm-5.3', 'zai-coding-cn-team/glm-5.3', 'deepseek/deepseek-flash']);
});

test('a job goes to the keys that carry the model it wants; only when none of them can be used, to the others in order, on their own model', () => {
  const route = routeOf({ route: { model: { provider: 'zai-coding-cn', id: 'glm-5.3', thinking: 'max' }, backups: [{ provider: 'zai-coding-cn-team', id: 'glm-5.3', thinking: 'max' }], steps: { lane: { provider: 'deepseek', model: 'deepseek-flash', thinking: 'high' } }, savedAt: 'x' } }, settings);
  const keys = routeKeys(route, ['deepseek'], has);
  const lane = wantOf(route, 'lane');
  assert.deepEqual(keysForJob(keys, lane, has).keys.map((k) => k.provider), ['deepseek'], 'lanes go to the DeepSeek key while it can be used');
  assert.deepEqual(keysForJob(keys, wantOf(route, 'main'), has).keys.map((k) => k.provider), ['zai-coding-cn', 'zai-coding-cn-team'], 'the main agent’s model is on both GLM keys: their work is shared');
  // The DeepSeek key is out: its lanes stand in on the GLM keys, in order, on the model each runs.
  const usable = keys.filter((k) => k.provider !== 'deepseek');
  const standIn = keysForJob(usable, lane, has);
  assert.equal(standIn.standIn, true);
  assert.deepEqual(standIn.keys.map((k) => k.provider), ['zai-coding-cn', 'zai-coding-cn-team']);
  assert.deepEqual(modelOnKey(standIn.keys[0]!, lane, has), { id: 'glm-5.3', thinking: 'max', standIn: true });
  assert.deepEqual(modelOnKey(keys.find((k) => k.provider === 'deepseek')!, lane, has), { id: 'deepseek-flash', thinking: 'high', standIn: false });
});

test('a step set to a model on a key runs on that key, not on the first key of the order that has the model', () => {
  // The owner's own keys: two of one provider (`zai~1`, `zai~2`), and the Coding Plan keys; every one carries glm-5.3-flash.
  const fam = (k: string) => k.replace(/~\d+$/, '');
  const hasAll = (key: string, model: string) => has(fam(key), model);
  const route = routeOf({ route: { model: { provider: 'zai-coding-cn', id: 'glm-5.3', thinking: 'max' }, backups: [{ provider: 'zai-coding-cn-team', id: 'glm-5.3', thinking: 'max' }], steps: { lane: { provider: 'zai~2', model: 'glm-5.3-flash' }, 'spot-check': { provider: 'zai', model: 'glm-5.3-flash' } }, savedAt: 'x' } }, settings);
  const keys = routeKeys(route, ['zai~1', 'zai~2'], hasAll);
  const look = { familyOf: fam };
  assert.deepEqual(keysForJob(keys, wantOf(route, 'lane'), hasAll, look), { keys: keys.filter((k) => k.provider === 'zai~2'), standIn: false, switched: false }, 'the one key it is set to');
  assert.deepEqual(keysForJob(keys, wantOf(route, 'spot-check'), hasAll, look).keys.map((k) => k.provider), ['zai~1', 'zai~2'], '"· 2 keys": the provider’s keys, shared');
  assert.deepEqual(keysForJob(keys, wantOf(route, 'main'), hasAll, look).keys.map((k) => k.provider), ['zai-coding-cn', 'zai-coding-cn-team', 'zai~1', 'zai~2'], 'work that follows the main model: every key with the model, as before');
  assert.ok(onPin({ at: 'zai', loose: false }, 'zai~1', fam) && !onPin({ at: 'zai~2', loose: false }, 'zai~1', fam));
});

test('a step whose key is out goes on to the other keys with the same model, in order, as a switch; it stands in only when no key carries the model', () => {
  const route = routeOf({ route: { model: { provider: 'zai-coding-cn', id: 'glm-5.3', thinking: 'max' }, backups: [{ provider: 'zai-coding-cn-team', id: 'glm-5.3', thinking: 'max' }, { provider: 'deepseek', id: 'deepseek-flash', thinking: 'max' }], steps: { lane: { provider: 'zai-coding-cn-team', model: 'glm-5.3-flash', thinking: 'low' } }, savedAt: 'x' } }, settings);
  const keys = routeKeys(route, [], has);
  const lane = wantOf(route, 'lane');
  assert.deepEqual(keysForJob(keys, lane, has).keys.map((k) => k.provider), ['zai-coding-cn-team']);
  // Out of quota: the usable keys no longer hold it. The other key with glm-5.3-flash takes the lane, on that model.
  const out = keysForJob(keys.filter((k) => k.provider !== 'zai-coding-cn-team'), lane, has);
  assert.deepEqual(out, { keys: keys.filter((k) => k.provider === 'zai-coding-cn'), standIn: false, switched: true });
  assert.deepEqual(modelOnKey(out.keys[0]!, lane, has), { id: 'glm-5.3-flash', thinking: 'low', standIn: false }, 'the same model, not a stand-in');
  // Rate-limited: still usable, but resting — the same.
  const resting = keysForJob(keys, lane, has, { ready: (k) => k !== 'zai-coding-cn-team' });
  assert.equal(resting.switched, true);
  assert.deepEqual(resting.keys.map((k) => k.provider), ['zai-coding-cn']);
  // Every key with the model rests: it waits for them, it does not stand in.
  const allResting = keysForJob(keys, lane, has, { ready: (k) => k === 'deepseek' });
  assert.deepEqual([allResting.keys.map((k) => k.provider), allResting.standIn, allResting.switched], [['zai-coding-cn-team'], false, false]);
  // No usable key carries glm-5.3-flash: only then the stand-in, on the model of each key of the order.
  const none = keysForJob(keys.filter((k) => k.provider === 'deepseek'), lane, has);
  assert.deepEqual([none.keys.map((k) => k.provider), none.standIn, none.switched], [['deepseek'], true, false]);
  assert.deepEqual(modelOnKey(none.keys[0]!, lane, has).standIn, true);
});

test('a step set by model alone sits on the main key’s provider when that carries it; otherwise on every key with the model', () => {
  const route = routeOf({ route: { model: { provider: 'zai-coding-cn', id: 'glm-5.3', thinking: 'max' }, backups: [{ provider: 'zai-coding-cn-team', id: 'glm-5.3', thinking: 'max' }, { provider: 'deepseek', id: 'deepseek-flash', thinking: null }], steps: { lane: { model: 'glm-5.3-flash' }, 'spot-check': { model: 'deepseek-flash' } }, savedAt: 'x' } }, settings);
  const keys = routeKeys(route, [], has);
  assert.deepEqual(wantOf(route, 'lane').pin, { at: 'zai-coding-cn', loose: true });
  assert.deepEqual(keysForJob(keys, wantOf(route, 'lane'), has).keys.map((k) => k.provider), ['zai-coding-cn']);
  assert.deepEqual(keysForJob(keys, wantOf(route, 'spot-check'), has).keys.map((k) => k.provider), ['deepseek'], 'the main key’s provider has no deepseek-flash: no pin');
});
