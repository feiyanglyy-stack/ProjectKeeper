/**
 * Which scope item a session belongs to (batch D4; Spec §1.1, §1.2, §6.7). Intake looked for the session's working
 * directory inside each session item's reason text, so with two working directories where one path is a prefix of the
 * other — `…\kestrel` and `…\kestrel-lab` — a session of the first was filed under the second whenever that item came
 * first, and the same directory spelt with other slashes or another case matched nothing. Discovery, for its part, kept
 * only the first directory's session item of each host: every one sits at the host's log root, and items were told
 * apart by path alone. A session item now records the working directory it reads sessions for, discovery keeps one per
 * host and directory, and intake compares paths.
 *
 * The fixtures are an invented project, "Kestrel", a field-notes app, in two directories, with one Claude Code session
 * each, in a temporary home: the machine's own home is never read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from '../util/tmp.test-helpers.ts';
import { join, resolve } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'pk-session-scope-home-'));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

const { discoverScope } = await import('../scope/discover.ts');
const { fullIntake, incrementalIntake } = await import('./intake.ts');
const { ProjectStore } = await import('../store/project-store.ts');
const { claudeProjectDirName, pathKey, samePath } = await import('../util/paths.ts');
const { stableId } = await import('../model/ids.ts');
type Project = import('../model/types.ts').Project;
type ScopeItem = import('../model/types.ts').ScopeItem;
type DiscoveredItem = import('../scope/discover.ts').DiscoveredItem;

const WIN = process.platform === 'win32';
const base = mkdtempSync(join(tmpdir(), 'pk-kestrel-prefix-'));
const APP = join(base, 'kestrel');
const LAB = join(base, 'kestrel-lab');   // the first directory's path is a prefix of this one
for (const dir of [APP, LAB]) { mkdirSync(dir); writeFileSync(join(dir, 'README.md'), '# Kestrel\n\nField notes, synced when the phone is back online.\n'); }

const SESSION_APP = 'a1a1a1a1-0000-4000-8000-000000000001';
const SESSION_LAB = 'b2b2b2b2-0000-4000-8000-000000000002';
/** A Claude Code log where the host keeps it for `cwd`; `recorded` is how the log itself spells the directory. */
function claudeSession(cwd: string, sessionId: string, words: string, recorded = cwd): void {
  const dir = join(fakeHome, '.claude', 'projects', claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const common = { sessionId, cwd: recorded, isSidechain: false, userType: 'external', entrypoint: 'cli', version: '2.1.0' };
  writeFileSync(join(dir, `${sessionId}.jsonl`), [
    { ...common, uuid: `${sessionId}-0`, type: 'user', timestamp: '2026-09-10T01:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: words } },
    { ...common, uuid: `${sessionId}-1`, type: 'assistant', timestamp: '2026-09-10T01:01:00.000Z', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Noted.' }] } },
  ].map((r) => JSON.stringify(r)).join('\n'));
}
claudeSession(APP, SESSION_APP, 'Sync the notes queue only on Wi-Fi.');
// The log may spell the directory in another case where the file system takes that for the same directory (Windows, a
// Mac's usual volume: asked of the file system), and on Windows with forward slashes; it is still the same directory.
const otherCase = existsSync(LAB.toUpperCase()) ? LAB.toUpperCase() : LAB;
claudeSession(LAB, SESSION_LAB, 'Try the map layer in the lab first.', WIN ? otherCase.split('\\').join('/') : otherCase);

const discover = (ownerItems: readonly ScopeItem[] = []) => discoverScope({ id: 'p1', name: 'Kestrel', locations: [APP, LAB] }, { home: fakeHome, ownerItems });
const strip = (items: readonly DiscoveredItem[]): ScopeItem[] => items.map(({ reasonRef: _r, sessions: _s, ...rest }) => rest);
const directories = strip(discover().items).filter((i) => i.category !== 'Session source');

/**
 * The two session items as discovery words them — one per directory, at the host's log root — built here, so what
 * intake does with them does not depend on what discovery keeps. `named` says whether the item records its directory.
 */
const sessionItem = (cwd: string, id: string, named: boolean): ScopeItem => ({
  id, path: join(fakeHome, '.claude', 'projects'), category: 'Session source', relation: 'Session source',
  reason: `Claude Code sessions whose working directory is ${cwd}: 1 found`, reasonSourceIds: [], sessionHost: 'claude',
  readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'unknown', missing: null, addedBy: 'keeper',
  ...(named ? { sessionCwd: cwd } : {}),
});
const projectWith = (scope: readonly ScopeItem[]): Project =>
  ({ id: 'p1', name: 'Kestrel', language: 'en', locations: [APP, LAB], scope, scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false, createdAt: '2026-09-01T00:00:00.000Z', lastOpenedAt: null, lastScopedAt: null }) as unknown as Project;

/** Read the project and say which scope item each session's sources were filed under. */
async function filedUnder(scope: readonly ScopeItem[]): Promise<{ app: string[]; lab: string[] }> {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-session-scope-store-')));
  const result = await fullIntake(store, projectWith(scope));
  assert.equal(result.sessionsRead, 2, 'both sessions are read');
  const of = (sessionId: string) => [...new Set(store.sources.filter((s) => s.anchor.kind === 'session' && s.anchor.sessionId === sessionId).map((s) => s.scopeItemId))];
  return { app: of(SESSION_APP), lab: of(SESSION_LAB) };
}

test('two working directories where one path is a prefix of the other: each session is filed under its own directory’s item, whichever comes first', async () => {
  const app = sessionItem(APP, 'scope_sessions_app', true);
  const lab = sessionItem(LAB, 'scope_sessions_lab', true);
  const expected = { app: [app.id], lab: [lab.id] };
  assert.deepEqual(await filedUnder([...directories, lab, app]), expected, 'the lab’s item first: the app’s session is not taken for the lab’s');
  assert.deepEqual(await filedUnder([...directories, app, lab]), expected, 'the app’s item first');
});

test('a session item recorded before it named its directory is matched by the whole path its reason gives', async () => {
  const app = sessionItem(APP, 'scope_sessions_app', false);
  const lab = sessionItem(LAB, 'scope_sessions_lab', false);
  const expected = { app: [app.id], lab: [lab.id] };
  assert.deepEqual(await filedUnder([...directories, lab, app]), expected, 'the lab’s item first');
  assert.deepEqual(await filedUnder([...directories, app, lab]), expected, 'the app’s item first');
});

test('discovery keeps one session item per directory, each naming its directory, and the sessions read go under their own', async () => {
  const found = discover().items.filter((i) => i.category === 'Session source' && i.sessionHost === 'claude');
  const itemOf = (cwd: string) => found.filter((i) => (i.sessions ?? []).some((s) => samePath(s.cwd ?? '', cwd))).map((i) => i.id);
  assert.equal(found.length, 2, `one Claude Code session item for each directory: ${found.map((i) => i.reason).join(' | ')}`);
  for (const cwd of [APP, LAB]) {
    const item = found.find((i) => itemOf(cwd).includes(i.id))!;
    assert.ok(item.sessionCwd && samePath(item.sessionCwd, cwd), `the item for ${cwd} names it: ${item.sessionCwd}`);
  }
  assert.deepEqual(await filedUnder(strip(discover().items)), { app: itemOf(APP), lab: itemOf(LAB) });
});

test('an item the owner edited before items named their directory gets its directory back from discovery; the owner’s decision stands', () => {
  const lab = strip(discover().items).find((i) => i.category === 'Session source' && i.sessionCwd && samePath(i.sessionCwd, LAB));
  assert.ok(lab, 'discovery made the lab’s session item');
  const { sessionCwd: _c, ...unnamed } = lab;
  const excluded: ScopeItem = { ...unnamed, relation: 'Excluded', reason: `Excluded by the owner (was: ${lab.reason})`, addedBy: 'owner' };
  const kept = discover([excluded]).items.find((i) => i.id === lab.id)!;
  assert.equal(kept.relation, 'Excluded', 'the owner’s exclusion stands');
  assert.ok(kept.sessionCwd && samePath(kept.sessionCwd, LAB), 'and the item names its directory');
});

test('a session item id is stable across service working directories', () => {
  const serviceA = join(base, 'service-a');
  const serviceB = join(base, 'service-b');
  mkdirSync(serviceA);
  mkdirSync(serviceB);
  const before = process.cwd();
  try {
    process.chdir(serviceA);
    const first = strip(discover().items).find((i) => i.sessionHost === 'claude' && i.sessionCwd && samePath(i.sessionCwd, APP));
    process.chdir(serviceB);
    const second = strip(discover().items).find((i) => i.sessionHost === 'claude' && i.sessionCwd && samePath(i.sessionCwd, APP));
    assert.ok(first && second);
    assert.equal(second.id, first.id, 'the service launch directory is not part of the session identity');
  } finally {
    process.chdir(before);
  }
});

test('rescan migrates an owner-edited legacy session item by host and cwd without losing the owner decision', () => {
  const oldServiceCwd = join(base, 'old-service-cwd');
  mkdirSync(oldServiceCwd);
  const current = strip(discover().items).find((i) => i.sessionHost === 'claude' && i.sessionCwd && samePath(i.sessionCwd, LAB));
  assert.ok(current);
  // Before D5, itemId path-normalised the relative string `host:cwd`, accidentally resolving it under the service cwd.
  const legacyId = stableId('scope', 'sessions', pathKey(resolve(oldServiceCwd, `claude:${LAB}`)));
  assert.notEqual(legacyId, current.id, 'the fixture represents the old cwd-dependent identity');
  const { sessionCwd: _cwd, ...legacyBase } = current;
  const ownerEdited: ScopeItem = {
    ...legacyBase, id: legacyId, relation: 'Excluded',
    reason: `Excluded by the owner (was: ${current.reason})`, addedBy: 'owner',
  };

  const matching = strip(discover([ownerEdited]).items).filter((i) => i.sessionHost === 'claude' && i.sessionCwd && samePath(i.sessionCwd, LAB));
  assert.equal(matching.length, 1, 'the legacy owner item is migrated, not appended beside the canonical item');
  assert.equal(matching[0]!.id, current.id, 'the migrated item adopts the stable identity');
  assert.equal(matching[0]!.relation, 'Excluded', 'the owner’s decision survives the identity migration');
  assert.equal(matching[0]!.reason, ownerEdited.reason, 'the owner’s explanation survives the identity migration');
});

/** How many times the hosts' session stores are walked while `body` runs: each walk lists Claude Code's `projects` folder once. */
function storeWalks(body: () => void): number {
  const root = join(fakeHome, '.claude', 'projects');
  const real = fs.readdirSync;
  let walks = 0;
  fs.readdirSync = ((...args: Parameters<typeof real>) => { if (typeof args[0] === 'string' && samePath(args[0], root)) walks += 1; return real(...args); }) as typeof real;
  syncBuiltinESMExports();
  try { body(); } finally { fs.readdirSync = real; syncBuiltinESMExports(); }
  return walks;
}

test('a pass over changes walks the hosts’ session stores once however many session logs changed, and not at all when none did', () => {
  const app = sessionItem(APP, 'scope_sessions_app', true);
  const lab = sessionItem(LAB, 'scope_sessions_lab', true);
  const project = projectWith([...directories, app, lab]);
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-session-scope-store-')));
  const log = (cwd: string, sessionId: string) => join(fakeHome, '.claude', 'projects', claudeProjectDirName(cwd), `${sessionId}.jsonl`);
  const change = (kind: 'file' | 'session', ref: string) => ({ kind, ref, label: ref, since: '2026-09-10T02:00:00.000Z', lastEventAt: Date.now(), scopeItemId: '' });
  let read = 0;
  const walks = storeWalks(() => {
    read = incrementalIntake(store, project, [
      change('session', log(APP, SESSION_APP)), change('file', join(APP, 'README.md')), change('session', log(LAB, SESSION_LAB)),
      change('session', join(fakeHome, '.claude', 'projects', 'some-other-directory', 'c3c3c3c3.jsonl')),   // a log for some other directory
    ]).sessionsRead;
  });
  assert.equal(read, 2, 'both logs of the project are read; the other directory’s is not');
  const of = (sessionId: string) => [...new Set(store.sources.filter((s) => s.anchor.kind === 'session' && s.anchor.sessionId === sessionId).map((s) => s.scopeItemId))];
  assert.deepEqual({ app: of(SESSION_APP), lab: of(SESSION_LAB) }, { app: [app.id], lab: [lab.id] }, 'each under its own directory’s item');
  assert.equal(walks, 1, 'three changed session logs, one walk');
  assert.equal(storeWalks(() => { incrementalIntake(store, project, [change('file', join(APP, 'README.md'))]); }), 0, 'no session log changed, no walk');
});
