/**
 * The capability table in `Keeper` → `Keeper agent` says what this build has and what provides it (Spec §8.1; CKC-03 AC-1,
 * AC-14, AC-25–AC-31). The rows are held against the program itself where the program states the fact: the built-in
 * tools every job turns on, the languages the ledger reads and to which level, the limit on refused calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PI_CAPABILITIES, type Capability, type CapabilityProvider } from './capabilities.ts';
import { keeperBuiltinTools, REPEATED_REFUSAL_LIMIT } from './step-timing.ts';
import { compilerReads } from '../ledger/code.ts';
import { ENGINE_PACKAGE, engineLanguage } from '../ledger/code-engine.ts';
import { MODEL_STEP_KINDS } from './clerk-steps.ts';
import { LEFT_NOTE } from './bounds/shell-write-guard.ts';

const PROVIDERS: readonly CapabilityProvider[] = ['pi built-in', 'ProjectKeeper tool', 'The ledger', 'TypeScript language service', 'ProjectKeeper adapter', 'Not provided'];
const row = (re: RegExp): Capability => {
  const hit = PI_CAPABILITIES.filter((c) => re.test(c.name));
  assert.equal(hit.length, 1, `one row matches ${re}: ${hit.map((c) => c.name).join(' | ')}`);
  return hit[0]!;
};

test('every row says what provides it, in the fixed words, and every missing one which steps that affects (AC-31)', () => {
  for (const c of PI_CAPABILITIES) {
    assert.ok(PROVIDERS.includes(c.provider), `${c.name}: ${c.provider}`);
    assert.ok(c.source.trim().length > 0, `${c.name}: says how it is provided`);
    assert.equal(c.available, c.provider !== 'Not provided', `${c.name}: available exactly when something provides it`);
    if (!c.available) assert.ok(c.affects && c.affects.trim().length > 0, `${c.name}: a missing item says what it affects`);
  }
  assert.equal(new Set(PI_CAPABILITIES.map((c) => c.name)).size, PI_CAPABILITIES.length, 'no row twice');
});

test('pi\'s built-in tools: all seven, in every step, as the runtime turns them on (AC-25)', () => {
  const tools = row(/^Built-in tools/);
  for (const t of keeperBuiltinTools('linux')) assert.match(tools.name, new RegExp(`\\b${t}\\b`), `the row names ${t}`);
  assert.deepEqual([...keeperBuiltinTools('linux')].sort(), ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'], 'and the runtime turns on exactly these (with PowerShell on Windows)');
  assert.ok(keeperBuiltinTools('win32').includes('powershell'));
  assert.equal(tools.provider, 'pi built-in');
  assert.ok(tools.available);
  for (const job of ['session drafts', 'the main agent', 'each lane', 'spot-check']) assert.match(tools.workbench, new RegExp(job), `in ${job}`);
});

test('the ledger is queryable from every step, and says so as the ledger (AC-26)', () => {
  const ledger = row(/^Querying the ledger/);
  assert.equal(ledger.provider, 'The ledger');
  assert.ok(ledger.available);
  assert.match(ledger.workbench, /pk_ledger_\*/);
  assert.match(ledger.native, /^Not in native pi/, 'native pi does not have ProjectKeeper\'s tools (AC-14)');
});

test('code references: each reader has its row, and what neither reads is said with what it affects (AC-27, D98)', () => {
  // The rows say what the program does: the compiler reads TypeScript and JavaScript, the engine the rest it knows.
  assert.deepEqual(['a.ts', 'a.tsx', 'a.js', 'a.mjs', 'a.dart', 'a.py'].map(compilerReads), [true, true, true, true, false, false]);
  for (const f of ['a.dart', 'a.py', 'a.kt', 'a.swift', 'a.go', 'a.java', 'a.cpp']) assert.notEqual(engineLanguage(f), null, `the engine reads ${f}`);
  for (const f of ['a.css', 'a.html', 'a.sh', 'a.sql']) assert.ok(engineLanguage(f) === null && !compilerReads(f), `neither reads ${f}`);
  const ts = row(/^Code references in TypeScript and JavaScript/);
  assert.equal(ts.provider, 'TypeScript language service');
  assert.match(ts.workbench, /pk_ledger_symbol/);
  const engine = row(/^Code references in every other language the code engine reads/);
  assert.ok(engine.available);
  assert.equal(engine.provider, 'The ledger');
  assert.ok(engine.source.includes(ENGINE_PACKAGE), 'names the engine');
  assert.match(engine.source, /never in the project/);
  assert.match(engine.workbench, /pk_ledger_symbol/);
  assert.match(engine.workbench, /Nothing to set up in the project/);
  const rest = row(/^Code references in languages neither reads/);
  assert.equal(rest.available, false);
  assert.match(rest.affects ?? '', /recorded Inferred/);
});

test('model and thinking per step, each step in its own session, long output, time per step (AC-28, AC-29, AC-30, §8.1 item 7)', () => {
  const perStep = row(/^Model and thinking level per step/);
  assert.ok(perStep.available);
  for (const kind of MODEL_STEP_KINDS) {
    const said = { 'session-drafts': 'session drafts', dig: 'sweeps' }[kind as string] ?? kind;
    assert.match(perStep.workbench, new RegExp(said), `names the ${kind} step`);
  }
  assert.ok(row(/^Each job of a round and each lane in a fresh session/).available);
  const long = row(/^Long output/);
  assert.ok(long.available);
  assert.match(long.workbench, new RegExp(`${REPEATED_REFUSAL_LIMIT} turns in a row`), 'the limit the runtime applies, counted in turns');
  assert.match(long.workbench, /kept as written/);
  assert.match(long.native, /without ProjectKeeper's patch/, 'Open in pi is upstream pi');
  assert.ok(row(/^Time and usage per step/).available);
});

test('the shell row says what the boundary refuses, and what it undoes on a live project and on a controlled trial (BQ)', () => {
  const shell = row(/^Shell commands on the project/);
  assert.equal(shell.provider, 'ProjectKeeper adapter');
  assert.ok(shell.available);
  assert.match(shell.source, /Refused before a command runs: .*redirecting into the project.*git commands that change the repository/);
  assert.match(shell.source, /on a live project \(a home that watches its projects[^)]*\): only what the command itself names as its writes/);
  assert.match(shell.source, /every other change is left as it is and named on the step/);
  assert.match(shell.source, /On a controlled trial \(settings\.watchProjects false[^)]*\): every change to the working tree/);
  assert.match(shell.source, /Never, on either: the index, HEAD, refs or anything else in \.git/);
  assert.ok(shell.workbench.includes(`“${LEFT_NOTE}”`), 'the words a step starts with are the ones the guard writes');
  assert.match(row(/^Built-in tools/).source, /as the shell row says/, 'the built-in tools row no longer claims the shell cannot change project files at all');
});

test('nothing is claimed for native pi that it does not have (AC-14)', () => {
  for (const c of PI_CAPABILITIES.filter((x) => x.provider === 'ProjectKeeper tool' || x.provider === 'The ledger' || x.provider === 'TypeScript language service')) {
    assert.match(c.native, /^Not in native pi/, c.name);
  }
  assert.equal(row(/^MCP servers/).available, false);
});
