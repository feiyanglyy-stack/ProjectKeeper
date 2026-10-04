/**
 * CM (E151; CK fix 7): `Downstream behind` is not raised from dated records. On the gated run all 38 candidates came from
 * references inside dated decision-log entries (a decision's 影响 or 改到的文档 note, a discussion bullet that mentions
 * 「D21、D23 被 D60 取代」), from a run's output and from a report; none lit, and a lane and the spot-check spent $10 on them.
 *
 * - A supersession a decision log writes counts in the entry of the decision that supersedes or of the one superseded
 *   (「D1 …（superseded by D2）」 under D1), not in another entry's background;
 * - a supersession or a citation in a report or receipt, or in what the layer map marks not current, is a note of its time;
 * - a citation inside a decision log's entry is the entry's own record, dated at the time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHarbor } from './fixture.test-helpers.ts';
import { analyze } from './index.ts';
import { computeFindings } from './breakpoints.ts';
import type { LayerEntry } from '../model/k-types.ts';

const behindOn = (a: ReturnType<typeof analyze>, target: string) => computeFindings(a).filter((f) => 'lit' in f && f.lit.kind === 'Downstream behind' && f.lit.targetId === target).length;

const layer = (path: string, kind: LayerEntry['layer'], current = true): LayerEntry => ({ id: `layer_${path}`, projectId: 'harbor', repo: '', path, layer: kind, note: null, current, roundId: null, updatedAt: '2026-09-30T00:00:00Z' });

test('a supersession in the superseded entry itself raises Downstream behind; one in another entry’s background, or in a report, does not', () => {
  const x = buildHarbor();
  const a = analyze(x.store, x.project, x.ledger);
  const original = a.facts.supersessions.find((s) => s.replaced === 'D1')!;
  assert.equal(original.path, 'docs/DECISIONS.md');
  assert.equal(behindOn(a, 'ref_storage'), 1, 'D1’s own entry says it is superseded by D2, and the spec still cites D1');
  // The same words in D3's entry (line 7): a note of D3's time, not D3 superseding anything.
  a.facts.supersessions.splice(0, a.facts.supersessions.length, { ...original, line: 7 });
  assert.equal(behindOn(a, 'ref_storage'), 0, 'a supersession another entry mentions is a dated note');
  // A report says it: a claim of its day.
  a.facts.supersessions.splice(0, 1, { ...original, path: 'subagent/reports/qc-1.md', line: 3 });
  x.store.layers.put(layer('subagent/reports', 'QC and receipts'));
  assert.equal(behindOn(a, 'ref_storage'), 0, 'a report’s supersession is a dated record');
  a.facts.supersessions.splice(0, 1, original);
  assert.equal(behindOn(a, 'ref_storage'), 1, 'the entry’s own line raises it again');
});

test('a citation inside a decision log’s entry, or in an archive, raises nothing; the same citation in a current document does', () => {
  const x = buildHarbor();
  const a = analyze(x.store, x.project, x.ledger);
  const before = behindOn(a, 'ref_storage');
  assert.equal(before, 1);
  // The spec that cites D1 is mapped as an archive (not current): its lines are history.
  const cite = computeFindings(a).find((f) => 'lit' in f && f.lit.kind === 'Downstream behind')!;
  const path = ('lit' in cite ? cite.lit.evidence[1]!.label : '').split(' named in ')[1]!.split(':')[0]!;
  x.store.layers.put(layer(path, 'Spec', false));
  assert.equal(behindOn(a, 'ref_storage'), 0, `${path} not current: its citation is history`);
  x.store.layers.put(layer(path, 'Decision record'));
  assert.equal(behindOn(a, 'ref_storage'), 0, `${path} as a decision log: its citation is a dated entry`);
  x.store.layers.put(layer(path, 'Spec'));
  assert.equal(behindOn(a, 'ref_storage'), 1, 'a current Spec citing a superseded decision is behind');
});
