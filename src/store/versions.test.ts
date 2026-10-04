/**
 * Comparing two saved versions (D45): the five kinds of difference, each object counted once, in the first kind
 * that applies, so the counts add up to the objects touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffVersions, type Version } from './versions.ts';

const node = (id: string, over: Partial<Version['nodes'][number]> = {}) => ({
  id, category: 'Work item', label: id, validity: 'Current', progress: 'In progress', acceptance: '',
  areaId: 'area1', parentId: null, text: 'aaa', ...over,
});
const version = (nodes: Version['nodes'], relations: Version['relations'] = []): Version =>
  ({ id: 'v', at: '2026-09-18T00:00:00.000Z', reason: 'Opened', nodes, relations });

test('compare reports added, removed, content changed, regrouped and relinked, each object once', () => {
  const before = version(
    [node('kept'), node('gone'), node('progressed'), node('moved'), node('linked'), node('renamed')],
    [{ id: 'r1', type: 'serves', from: 'linked', to: 'area1', assessment: 'Not assessed' }],
  );
  const after = version(
    [node('kept'), node('fresh'), node('progressed', { progress: 'Done' }), node('moved', { areaId: 'area2' }), node('linked'), node('renamed', { text: 'bbb' }), node('area2', { id: 'area2', category: 'Area', label: 'Second area' })],
    [
      { id: 'r1', type: 'serves', from: 'linked', to: 'area1', assessment: 'Holds' },
      { id: 'r2', type: 'serves', from: 'linked', to: 'area2', assessment: 'Not assessed' },
    ],
  );
  const { items, counts } = diffVersions(before, after);

  assert.deepEqual(counts, { 'Added': 2, 'Removed': 1, 'Content changed': 2, 'Regrouped': 1, 'Relinked': 1 });
  assert.equal(items.length, 7, 'every difference is one item');
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, 'an object is counted once, not in several kinds');

  const of = (id: string) => items.find((i) => i.id === id)!;
  assert.equal(of('fresh').kind, 'Added');
  assert.equal(of('gone').kind, 'Removed');
  assert.equal(of('progressed').kind, 'Content changed');
  assert.match(of('progressed').detail, /progress In progress → Done/);
  assert.equal(of('renamed').kind, 'Content changed');
  assert.match(of('renamed').detail, /text rewritten/);
  assert.equal(of('moved').kind, 'Regrouped');
  assert.match(of('moved').detail, /Second area/, 'it says where it hangs now, by name');
  assert.equal(of('linked').kind, 'Relinked');
  assert.match(of('linked').detail, /2 relations gained, 1 lost/, 'a re-assessed relation counts as gained and lost');
  assert.equal(items.findIndex((i) => i.kind === 'Removed'), items.length - 1, 'what is gone is read last');

  // The same picture twice has no differences at all.
  assert.deepEqual(diffVersions(after, after).items, []);
});
