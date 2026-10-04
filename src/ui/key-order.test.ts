// The key order on Keeper → Model provider (Spec §6.10 备用与并行; CKC-03 AC-35): its first row is the main key and can be
// chosen like the others (owner 2026-10-03: 「第二个截图索性第一个也可以自选吧」) — its key and model changed there, moved
// down, taken out; whichever row is first is the main key. Every row below chooses its key and model the same way (owner
// 2026-10-03: 「不过既然可以detailed made顺序，下面也应该可以选provider和model。」): one key per row, and a key chosen where
// another row has it changes places with that row. The interface is plain ES modules, loaded at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-explicit-any */
const O: any = await import(new URL('../../ui/key-order.js', import.meta.url).href);

const route = {
  main: { provider: 'kestrel~1', id: 'kestrel-pro', thinking: 'high', keyName: 'K one', usable: true },
  backups: [{ provider: 'kestrel~2', id: 'kestrel-pro', thinking: 'high', keyName: 'K two', usable: true }, { provider: 'merlin~1', id: 'merlin-flash', thinking: 'low', keyName: 'M one', usable: true }],
};
const keys: Record<string, any> = {
  'kestrel~1': { id: 'kestrel~1', models: [{ id: 'kestrel-pro' }, { id: 'kestrel-flash' }] },
  'kestrel~2': { id: 'kestrel~2', models: [{ id: 'kestrel-pro' }, { id: 'kestrel-flash' }] },
  'merlin~1': { id: 'merlin~1', models: [{ id: 'merlin-flash' }] },
  'osprey~1': { id: 'osprey~1', models: [{ id: 'osprey-1' }] },
};
const list = () => O.orderRows(route).map((r: any) => ({ provider: r.provider, id: r.id, thinking: r.thinking }));

test('the order’s rows are the main key first, then the backups', () => {
  assert.deepEqual(O.orderRows(route).map((r: any) => `${r.provider}/${r.id}`), ['kestrel~1/kestrel-pro', 'kestrel~2/kestrel-pro', 'merlin~1/merlin-flash']);
  assert.deepEqual(O.orderRows({ main: null, backups: [] }), []);
});

test('the first row moved down: the next key is the main key, on the main model’s thinking; the old main key is the first backup', () => {
  const body = O.orderBody(O.moveRow(list(), 0, 1), 'high');
  assert.deepEqual(body, {
    model: { provider: 'kestrel~2', id: 'kestrel-pro', thinking: 'high' },
    backups: [{ provider: 'kestrel~1', id: 'kestrel-pro', thinking: 'high' }, { provider: 'merlin~1', id: 'merlin-flash', thinking: 'low' }],
  });
  // A backup moved to the top is the main key too.
  assert.deepEqual(O.orderBody(O.moveRow(list(), 2, -1), 'high').model.provider, 'kestrel~1', 'a move below the top leaves the main key');
  const top = O.orderBody(O.moveRow(O.moveRow(list(), 2, -1), 1, -1), 'high');
  assert.deepEqual(top.model, { provider: 'merlin~1', id: 'merlin-flash', thinking: 'high' });
  assert.deepEqual(top.backups.map((b: any) => b.provider), ['kestrel~1', 'kestrel~2']);
});

test('the first row’s model changed, or its key: that is the main model; a key chosen there from a lower row changes places with it', () => {
  const changed = list().map((x: any, j: number) => (j === 0 ? { ...x, id: 'kestrel-flash' } : x));
  assert.deepEqual(O.orderBody(changed, 'high').model, { provider: 'kestrel~1', id: 'kestrel-flash', thinking: 'high' });
  // M one chosen as the main key: on the model it had in its row, with the main model's thinking; K one takes M one's old place.
  const m = O.chooseKey(list(), 0, keys['merlin~1'], 'kestrel-pro');
  assert.deepEqual(O.orderBody(m, 'high'), { model: { provider: 'merlin~1', id: 'merlin-flash', thinking: 'high' }, backups: [{ provider: 'kestrel~2', id: 'kestrel-pro', thinking: 'high' }, { provider: 'kestrel~1', id: 'kestrel-pro', thinking: 'high' }] });
  // K two chosen: it runs the model of its row, the main model here.
  assert.equal(O.chooseKey(list(), 0, keys['kestrel~2'], 'kestrel-pro')[0].id, 'kestrel-pro');
  // A key outside the order without the row's model or the main model: its first model; the key that was there leaves the order.
  const o = O.chooseKey(list(), 0, keys['osprey~1'], 'kestrel-pro');
  assert.deepEqual(o.map((x: any) => `${x.provider}/${x.id}`), ['osprey~1/osprey-1', 'kestrel~2/kestrel-pro', 'merlin~1/merlin-flash']);
});

test('row 2’s key changed to a key outside the order: it takes the row, the other rows stay, no key is listed twice', () => {
  const next = O.chooseKey(list(), 1, keys['osprey~1'], 'kestrel-pro');
  assert.deepEqual(O.orderBody(next, 'high'), {
    model: { provider: 'kestrel~1', id: 'kestrel-pro', thinking: 'high' },
    backups: [{ provider: 'osprey~1', id: 'osprey-1', thinking: 'high' }, { provider: 'merlin~1', id: 'merlin-flash', thinking: 'low' }],
  });
  // A key outside the order that carries the row's model keeps that model, before the main model.
  const flash = list().map((x: any, j: number) => (j === 1 ? { ...x, id: 'kestrel-flash' } : x));
  const spare = { id: 'kestrel~3', models: [{ id: 'kestrel-pro' }, { id: 'kestrel-flash' }] };
  assert.deepEqual(O.chooseKey(flash, 1, spare, 'kestrel-pro')[1], { provider: 'kestrel~3', id: 'kestrel-flash', thinking: 'high' });
  // The key the row already has: nothing changes.
  assert.deepEqual(O.chooseKey(list(), 1, keys['kestrel~2'], 'kestrel-pro'), list());
});

test('row 2’s key changed to the key of row 3: the two rows change places, each key on its own model and thinking', () => {
  const next = O.chooseKey(list(), 1, keys['merlin~1'], 'kestrel-pro');
  assert.deepEqual(O.orderBody(next, 'high'), {
    model: { provider: 'kestrel~1', id: 'kestrel-pro', thinking: 'high' },
    backups: [{ provider: 'merlin~1', id: 'merlin-flash', thinking: 'low' }, { provider: 'kestrel~2', id: 'kestrel-pro', thinking: 'high' }],
  });
  assert.equal(new Set(next.map((x: any) => x.provider)).size, 3, 'one key per row');
});

test('row 2’s key changed to the key of row 1: they change places, so row 2’s old key is the main key, on the main model’s thinking', () => {
  const next = O.chooseKey(list(), 1, keys['kestrel~1'], 'kestrel-pro');
  assert.deepEqual(O.orderBody(next, 'high'), {
    model: { provider: 'kestrel~2', id: 'kestrel-pro', thinking: 'high' },
    backups: [{ provider: 'kestrel~1', id: 'kestrel-pro', thinking: 'high' }, { provider: 'merlin~1', id: 'merlin-flash', thinking: 'low' }],
  });
  // The same order as choosing row 2's key in row 1.
  assert.deepEqual(next, O.chooseKey(list(), 0, keys['kestrel~2'], 'kestrel-pro'));
  // From row 3: its key comes up on its own model, and takes the main model's thinking in place of its own.
  const third = O.chooseKey(list(), 2, keys['kestrel~1'], 'kestrel-pro');
  assert.deepEqual(O.orderBody(third, 'high'), {
    model: { provider: 'merlin~1', id: 'merlin-flash', thinking: 'high' },
    backups: [{ provider: 'kestrel~2', id: 'kestrel-pro', thinking: 'high' }, { provider: 'kestrel~1', id: 'kestrel-pro', thinking: 'high' }],
  });
});

test('the first row taken out: the next is the main key; the last key cannot be taken out', () => {
  assert.equal(O.orderBody(list().slice(1), 'high').model.provider, 'kestrel~2');
  assert.equal(O.orderBody([], 'high'), null);
});

test('the main row’s Use with a key of a lower row: the two rows change places and the old main key stays in the order (DA)', () => {
  // K two sits in row 2: chosen above with a model, it is the main key on that model, and K one takes its row.
  const swapped = O.mainChosen(list(), keys['kestrel~2'], 'kestrel-flash', 'kestrel-pro');
  assert.deepEqual(O.orderBody(swapped, 'medium'), {
    model: { provider: 'kestrel~2', id: 'kestrel-flash', thinking: 'medium' },
    backups: [{ provider: 'kestrel~1', id: 'kestrel-pro', thinking: 'high' }, { provider: 'merlin~1', id: 'merlin-flash', thinking: 'low' }],
  });
  // The key of the third row: the same, and the second row stays where it is.
  assert.deepEqual(O.mainChosen(list(), keys['merlin~1'], 'merlin-flash', 'kestrel-pro').map((x: any) => x.provider), ['merlin~1', 'kestrel~2', 'kestrel~1']);
  // The main key itself (a change of its model or thinking), a key outside the order, or no key: the main model is set as before.
  assert.equal(O.mainChosen(list(), keys['kestrel~1'], 'kestrel-flash', 'kestrel-pro'), null);
  assert.equal(O.mainChosen(list(), keys['osprey~1'], 'osprey-1', 'kestrel-pro'), null);
  assert.equal(O.mainChosen(list(), undefined, 'x', 'kestrel-pro'), null);
});
