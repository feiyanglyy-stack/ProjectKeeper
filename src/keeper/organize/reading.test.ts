/**
 * What was read of a deepening's material (Spec §3.3, §3.7): the program's count from the steps' recorded reads, which the
 * coverage check holds against its plan (D99) — a file whole, an older version through what it changed, a commit, a
 * session's every message — and the views of a deepening from before D99, read by reading assignments, which still render.
 * The reading assignments themselves (placing, sizing, packing, queuing, chasing) went with D99: the lanes are the main
 * agent's, and the coverage check lists what no lane touched (coverage-tools.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../../store/project-store.ts';
import type { ClerkRound, ReadingMaterial, RoundReading } from '../../model/k-types.ts';
import type { KeeperJob, Project, StepRead } from '../../model/types.ts';
import { FOCUSED_READING, pathReadingOf, readingBasisText, readsOf } from './reading.ts';
import { tallyReads } from './clerk-coverage.ts';
import { clerkSkillFile } from './skills.ts';
import { ledgerSessionReads, stepReads } from '../bounds/reads.ts';

const AT = '2026-09-28T10:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'pk-reading-'));
const file = (rel: string, lines: number) => { const p = join(dir, ...rel.split('/')); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n') + '\n'); return p; };
const P = { id: 'p1', name: 'Orchard', locations: [dir], language: 'en', scope: [], takeoverDepth: 'Full' } as unknown as Project;

const mat = (key: string, over: Partial<ReadingMaterial>): ReadingMaterial => ({ key, category: 'code files', label: key, group: 'dir:r:src', bytes: 100, how: 'read it', ...over });

type Reads = readonly StepRead[];
const job = (id: string, path: string, assignment: string | null, reads: Reads[], status: KeeperJob['status'] = 'Done', kind: 'dig' | 'lane' = 'dig'): KeeperJob => ({
  id, projectId: 'p1', kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: ['crd_1'], label: `Deep sweep: ${path}` }, status,
  queuedAt: AT, startedAt: AT, endedAt: status === 'Done' ? AT : null, savedResults: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1 }, agent: 'pi', model: null,
  sessionFile: null, sessionId: null, steps: reads.map((r) => ({ at: AT, tool: 'read', target: '', summary: '', isError: false, reads: r })), error: null, requestBasis: null,
  parentJobId: 'job_root', resultText: null, priority: 1, task: null, step: { roundId: 'crd_1', kind, path, ...(assignment ? { assignment } : {}) },
} as KeeperJob);

test('what a step read is held against the plan: a file whole, an older version through what it changed, a commit, a session’s every message', () => {
  const plan = file('docs/plan.md', 10);
  const code = file('src/app.ts', 30);
  const materials: ReadingMaterial[] = [
    mat('doc:docs/plan.md@c2', { category: 'document versions', file: plan, rev: 'c2c2c2c2c2', current: true, lines: 10 }),
    mat('doc:docs/plan.md@c1', { category: 'document versions', file: plan, rev: 'c1c1c1c1c1', next: 'doc:docs/plan.md@c2', diff: [[3, 4]], lines: 9 }),
    mat('doc:docs/plan.md@c0', { category: 'document versions', file: plan, rev: 'c0c0c0c0c0', next: 'doc:docs/plan.md@c1', diff: [[1, 1]], lines: 9 }),
    mat('r:src/app.ts', { file: code, lines: 30 }),
    mat('commit:abcdef1234', { category: 'commits', rev: 'abcdef1234' }),
    mat('session:s1', { category: 'sessions', session: 'session:s1', messages: 300 }),
  ];
  const reads = (steps: Reads[]) => readsOf(materials, tallyReads([job('j', 'p', null, steps)], P));
  const r = reads([
    [{ path: plan }],                                                    // the plan as it stands, whole
    [{ path: plan, rev: 'c1c1c1c1c1', from: 3, to: 4, lines: 9 }],       // what version c1 changed
    [{ path: code, from: 1, to: 20, lines: 30 }, { path: code, from: 21, lines: 30 }],   // the code file in two ranges
    [{ rev: 'abcdef1234' }],
    [{ session: 'session:s1', from: 1, to: 200, lines: 300 }, { session: 'session:s1', from: 201, to: 300, lines: 300 }],
  ]);
  assert.equal(r.get('doc:docs/plan.md@c2')!.outcome, 'whole', 'the file as it stands reads the current version');
  assert.equal(r.get('doc:docs/plan.md@c1')!.outcome, 'whole', 'its own lines read, and the version after it read whole');
  assert.equal(r.get('doc:docs/plan.md@c0')!.outcome, 'none', 'its own line was not read');
  assert.equal(r.get('r:src/app.ts')!.outcome, 'whole', 'two ranges that cover it');
  assert.equal(r.get('commit:abcdef1234')!.outcome, 'whole');
  assert.equal(r.get('session:s1')!.outcome, 'whole', 'every message, in two pages');
  const partial = reads([[{ path: plan, rev: 'c1c1c1c1c1', from: 3, to: 4, lines: 9 }], [{ session: 'session:s1', from: 1, to: 200, lines: 300 }]]);
  assert.equal(partial.get('doc:docs/plan.md@c1')!.outcome, 'part', 'its own lines read, but not the version after it: a part');
  assert.deepEqual([partial.get('session:s1')!.outcome, partial.get('session:s1')!.ranges], ['part', [[1, 200]]]);
});

test('an agent reading the install’s own clerk skills is reading its method, not the project’s material: the tally leaves it out (D99, build plan §4 自指)', () => {
  const skill = clerkSkillFile('lane-plan');
  const code = file('src/lane.ts', 3);
  const t = tallyReads([job('j', 'Lane', null, [[{ path: skill }], [{ path: code }]], 'Done', 'lane')], P);
  assert.equal(t.files.size, 1, 'only the project’s file is counted');
  assert.ok([...t.files.keys()].every((k) => !/skills[\\/]clerk/i.test(k)));
  // The same, for a step recorded before reads were kept: its target counts as the file read whole.
  const old = { ...job('j2', 'Lane', null, [], 'Done', 'lane'), steps: [{ at: AT, tool: 'read', target: skill, summary: '', isError: false }] } as KeeperJob;
  assert.equal(tallyReads([old], P).files.size, 0);
});

test('a deepening from before D99, read by reading assignments, still shows each path’s reading and how it was counted', () => {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-reading-store-')));
  const a = file('docs/a.md', 5), b = file('docs/b.md', 5), c = file('src/c.ts', 5);
  const m = (k: string, f: string) => mat(k, { file: f, lines: 5, current: true, category: k.startsWith('doc:') ? 'document versions' : 'code files', group: k });
  const assignment = (id: string, n: number, keys: string[], jobId: string, followUpOf: number[] = []) => ({ id, n, jobId, keys, bytes: 100, followUpOf, at: AT, handledAt: AT });
  // As a round of the time recorded it: two paths, the docs path with a follow-up that read nothing more.
  const reading: RoundReading = {
    at: AT, budget: { bytes: 400_000, basis: "a tenth of zai/glm-5.3's 1,000,000-token context window" },
    paths: [
      { path: 'The document chain and decisions', basis: 'counted from what its brief names', materials: [m('doc:docs/a.md@1', a), m('doc:docs/b.md@1', b)],
        assignments: [assignment('asg_1', 1, ['doc:docs/a.md@1', 'doc:docs/b.md@1'], 'job_d1'), assignment('asg_2', 2, ['doc:docs/b.md@1'], 'job_d2', [1])],
        accounted: [{ key: 'doc:docs/b.md@1', outcome: 'none', why: 'listed in assignments 1, 2; none read it, and the last read nothing more of its list, so the chase ends here', by: 'program', at: AT }], complete: true },
      { path: 'The code as it stands', basis: `${FOCUSED_READING}`, materials: [m('r:src/c.ts', c)], assignments: [assignment('asg_3', 1, ['r:src/c.ts'], 'job_c1')],
        accounted: [{ key: 'r:src/c.ts', outcome: 'part', why: 'lines 3–5 are a generated table', by: 'assignment', at: AT }], complete: true },
    ],
  };
  const round: ClerkRound = { id: 'crd_1', projectId: 'p1', kind: 'Deepen', number: 2, startedAt: AT, endedAt: AT, status: 'Done', rootJobId: 'job_root', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: AT, reading };
  store.clerkRounds.put(round);
  store.jobs.put(job('job_d1', 'The document chain and decisions', 'asg_1', [[{ path: a }]]));
  store.jobs.put(job('job_d2', 'The document chain and decisions', 'asg_2', [[{ path: a }]]));
  store.jobs.put(job('job_c1', 'The code as it stands', 'asg_3', [[{ path: c, from: 1, to: 2, lines: 5 }]]));
  const docs = pathReadingOf(store, P, round, reading.paths[0]!);
  assert.deepEqual([docs.planned, docs.whole, docs.part, docs.notRead, docs.open, docs.assignments.total, docs.assignments.done, docs.assignments.followUps], [2, 1, 0, 1, 0, 2, 2, 1]);
  assert.deepEqual(docs.accounted.map((x) => [x.key, x.outcome, x.by]), [['doc:docs/b.md@1', 'none', 'program']]);
  const code = pathReadingOf(store, P, round, reading.paths[1]!);
  assert.deepEqual([code.planned, code.whole, code.part], [1, 0, 1], 'read in part with the assignment’s reason');
  assert.match(readingBasisText(reading), /^Under Focused only what the organizing plan says to read closely is planned/, 'a Focused deepening of the time says so');
});

test('the recorder: a session read through the ledger, page by page, by message positions', () => {
  const page = (offset: number, n: number, total: number) => JSON.stringify({ session: { id: 'session:ab12', host: 'claude' }, total, offset, rows: Array.from({ length: n }, (_, i) => ({ id: `msg:${i}`, session: 'session:ab12', index: offset + i, speaker: 'agent' })), next: offset + n < total ? offset + n : null }, null, 1);
  assert.deepEqual(ledgerSessionReads({ session: 'ab12', limit: 200 }, page(0, 200, 300)), [{ session: 'session:ab12', from: 1, to: 200, lines: 300 }]);
  assert.deepEqual(stepReads('pk_ledger_sessions', { session: 'ab12', offset: 200 }, page(200, 100, 300), false, { cwd: dir }), [{ session: 'session:ab12', from: 201, to: 300, lines: 300 }]);
  assert.deepEqual(ledgerSessionReads({ session: 'ab12', speaker: 'owner' }, page(0, 5, 5)), [{ session: 'session:ab12', part: true }], 'one speaker’s messages are a part');
  assert.deepEqual(ledgerSessionReads({}, page(0, 5, 5)), [], 'a list of sessions reads none of them');
  const t = tallyReads([job('j', 'p', null, [[{ session: 'session:ab12', from: 1, to: 200, lines: 300 }], [{ session: 'session:ab12', from: 201, to: 300, lines: 300 }]])], P);
  assert.equal(t.sessions.get('session:ab12')!.ranges.length, 2);
});
