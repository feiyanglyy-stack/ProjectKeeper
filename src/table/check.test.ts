import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from '../util/git.ts';
import { tmpdir } from '../util/tmp.test-helpers.ts';
import { checkFacts, checkShape, checkTableFile, SCHEMA_FILE } from './check.ts';

/** A one-repository project with a plan, a decision log and one code file, committed once. */
function project(): { dir: string; commit: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pk-table-'));
  mkdirSync(join(dir, 'docs'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'docs', 'PLAN.md'), '# Plan\n\n## PLAN-1 · First cut\n\nT-1 capture, T-2 search.\n');
  writeFileSync(join(dir, 'docs', 'DECISIONS.md'), '# Decisions\n\n- DEC-1 · No accounts.\n- DEC-2 · Accounts after all — replaced by DEC-3.\n- DEC-3 · Still no accounts.\n');
  writeFileSync(join(dir, 'src', 'capture.ts'), 'export const capture = 1;\n');
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first']]) assert.ok(git(dir, args).ok);
  const commit = git(dir, ['rev-parse', 'HEAD']).out.trim();
  return { dir, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function table(commit: string): Record<string, any> {
  const plan = { file: 'docs/PLAN.md', lines: '3-5' };
  return {
    format: 'projectkeeper.table/1',
    project: { name: 'Tiny', asOf: { date: '2026-10-13', repos: [{ path: '.', commit }] }, filledBy: { agent: 'test', at: '2026-10-13' } },
    ownerWants: [{ id: 'W1', want: 'No accounts.', kind: 'Product', status: 'Current', said: [{ session: 'claude:s1', message: 2, quote: 'no accounts, ever' }], reflectedIn: ['DEC-3'] }],
    product: { id: 'Tiny', name: 'Tiny', summary: 'A tiny list.', forWhom: 'One person.', sources: [plan] },
    goals: [{ id: 'G1', name: 'Quick', summary: 'Quick saving.', status: 'Current', sources: [plan] }],
    areas: [{ id: 'A1', name: 'Capture', summary: 'Saving.', status: 'Current', goals: ['G1'], sources: [plan] }],
    requirements: [],
    designs: [],
    decisions: [
      { id: 'DEC-1', name: 'No accounts', summary: 'No accounts.', status: 'Current', place: { area: 'A1' }, sources: [{ file: 'docs/DECISIONS.md', lines: '3', quote: 'DEC-1 · No accounts.' }] },
      { id: 'DEC-2', name: 'Accounts', summary: 'Accounts after all.', status: 'Replaced', replacedBy: 'DEC-3', place: { area: 'A1' }, sources: [{ file: 'docs/DECISIONS.md', lines: '4' }] },
      { id: 'DEC-3', name: 'Still no accounts', summary: 'Still none.', status: 'Current', place: { wholeProduct: 'Storage everywhere.' }, sources: [{ file: 'docs/DECISIONS.md', lines: '5' }] },
    ],
    plans: [{ id: 'PLAN-1', name: 'First cut', summary: 'Capture and search.', status: 'Current', sources: [plan] }],
    work: [{ id: 'T-1', name: 'Capture', summary: 'Save a page.', plan: 'PLAN-1', area: 'A1', implements: ['DEC-1'], status: 'Current', progress: 'Done', sources: [plan, { commit }] }],
    code: [{ id: 'capture', name: 'Capture', summary: 'Saving.', area: 'A1', paths: ['src/capture.ts', 'src'] }],
    notes: [{ id: 'N-1', title: 'All fine.', kind: 'Question', ask: 'For information', by: 'Main agent', on: ['T-1', 'W1'], text: 'Nothing to do.', sources: [plan] }],
  };
}
const sessions = [{ session: 'claude:s1', message: 2, text: 'I want no accounts, ever.' }];
const problemsOf = (t: Record<string, any>, dir: string, s = sessions) => checkFacts(t, dir, s).map((p) => `${p.at} ${p.problem}`);

test('a well-filled table has no problems in either layer', () => {
  const p = project();
  try {
    const t = table(p.commit);
    assert.deepEqual(checkShape(t), []);
    assert.deepEqual(problemsOf(t, p.dir), []);
  } finally { p.done(); }
});

test('the shape layer names the field that breaks the schema', () => {
  const t = table('abcdef1');
  t.decisions[0].status = 'Done';
  delete t.work[0].plan;
  t.work[0].colour = 'red';
  const at = checkShape(t).map((p) => p.at);
  assert.ok(at.includes('/decisions/0/status'));
  assert.ok(at.includes('/work/0'));
});

test('ids are one namespace, and every reference must name an entry of the right kind', () => {
  const p = project();
  try {
    const t = table(p.commit);
    t.goals.push({ ...t.goals[0], id: 'A1' });
    t.work[0].plan = 'A1';
    t.work[0].dependsOn = ['T-9'];
    const got = problemsOf(t, p.dir).join('\n');
    // Goals are taken in before areas, so the area is the second to claim "A1".
    assert.match(got, /\/areas\/0\/id the id "A1" is already used by a goal/);
    assert.match(got, /\/work\/0\/plan "A1" is a goal; this needs a plan/);
    assert.match(got, /\/work\/0\/dependsOn\/0 "T-9" is not an id in this table/);
  } finally { p.done(); }
});

test('a status brings its fields: Replaced names what replaced it, Deferred says why, old plans say what became of their work', () => {
  const p = project();
  try {
    const t = table(p.commit);
    delete t.decisions[1].replacedBy;
    t.goals[0].status = 'Deferred';
    t.plans[0].status = 'Replaced';
    t.plans[0].replacedBy = 'PLAN-2';
    t.plans.push({ id: 'PLAN-2', name: 'Second', summary: 'Again.', status: 'Current', sources: t.plans[0].sources });
    const got = problemsOf(t, p.dir).join('\n');
    assert.match(got, /\/decisions\/1 it is Replaced, so replacedBy must name/);
    assert.match(got, /\/goals\/0 it is Deferred, so why must say/);
    assert.match(got, /\/work\/0 its plan PLAN-1 is Replaced, so became must say/);
    t.work[0].became = { finished: 'Done before the new plan.' };
    assert.doesNotMatch(problemsOf(t, p.dir).join('\n'), /became/);
  } finally { p.done(); }
});

test('a part replaced names an entry that exists, and only an entry still in force can lose a part', () => {
  const p = project();
  try {
    const t = table(p.commit);
    t.decisions[0].partlyReplaced = [{ by: 'DEC-9', part: 'x' }];
    t.decisions[1].partlyReplaced = [{ by: 'DEC-3', part: 'y' }];
    const got = problemsOf(t, p.dir).join('\n');
    assert.match(got, /\/decisions\/0\/partlyReplaced\/0\/by "DEC-9" is not an id in this table/);
    assert.match(got, /\/decisions\/1 it is Replaced as a whole, so partlyReplaced does not apply/);
  } finally { p.done(); }
});

test('sources are checked against the project at its asOf commit, and quotes word for word', () => {
  const p = project();
  try {
    const t = table(p.commit);
    t.decisions[0].sources[0].quote = 'DEC-1 · No accounts at all.';
    t.decisions[1].sources[0].lines = '40';
    t.goals[0].sources = [{ file: 'docs/MISSING.md' }];
    t.work[0].sources[1] = { commit: '1234567' };
    t.code[0].paths.push('src/later.ts');
    // A file written after the asOf commit and never committed is read from the folder; one that was never there is not.
    writeFileSync(join(p.dir, 'src', 'later.ts'), 'x');
    t.code[0].paths.push('src/never.ts');
    const got = problemsOf(t, p.dir).join('\n');
    assert.match(got, /\/decisions\/0\/sources\/0\/quote the quote does not stand word for word in docs\/DECISIONS\.md lines 3/);
    assert.match(got, /\/decisions\/1\/sources\/0 lines 40 are outside docs\/DECISIONS\.md, which has \d+ lines/);
    assert.match(got, /\/goals\/0\/sources\/0 the file docs\/MISSING\.md is not in the project/);
    assert.match(got, /\/work\/0\/sources\/1 the commit 1234567 is not in/);
    assert.match(got, /\/code\/0\/paths\/3 src\/never\.ts is not in the project/);
    assert.doesNotMatch(got, /src\/later\.ts/);
  } finally { p.done(); }
});

test('a session source needs the session material, and its quote must stand in the message', () => {
  const p = project();
  try {
    const t = table(p.commit);
    assert.match(checkFacts(t, p.dir, null).map((x) => x.problem).join('\n'), /check it with the session material/);
    t.ownerWants[0].said[0].quote = 'no accounts, never';
    t.ownerWants[0].said.push({ session: 'claude:s1', message: 9 });
    const got = problemsOf(t, p.dir).join('\n');
    assert.match(got, /\/ownerWants\/0\/said\/0\/quote the quote does not stand word for word in message 2 of claude:s1/);
    assert.match(got, /\/ownerWants\/0\/said\/1 message 9 of claude:s1 is not in the session material/);
  } finally { p.done(); }
});

test('a table file that does not parse, or fails its shape, stops before the facts', () => {
  const p = project();
  try {
    const file = join(p.dir, 'projectkeeper.json');
    writeFileSync(file, '{ not json');
    assert.match(checkTableFile(file, { projectDir: p.dir })[0]!.problem, /not readable as JSON/);
    writeFileSync(file, JSON.stringify({ format: 'projectkeeper.table/1' }));
    assert.ok(checkTableFile(file, { projectDir: p.dir }).every((x) => x.at === '/' || x.at.startsWith('/')));
  } finally { p.done(); }
});

test('the template example keeps to the schema', () => {
  const example = JSON.parse(readFileSync(resolve(SCHEMA_FILE, '..', 'examples', 'papertrail.json'), 'utf8'));
  assert.deepEqual(checkShape(example), []);
});
