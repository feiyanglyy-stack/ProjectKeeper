/**
 * Session change watching (D5). The fixture has two invented projects whose paths share a prefix and a wholly
 * isolated agent home. A watcher must attribute Claude and Codex logs by the complete recorded working directory,
 * and a Codex log for another project must never become this project's pending material.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const oldProfile = process.env.USERPROFILE;
const oldHome = process.env.HOME;
const fakeHome = mkdtempSync(join(tmpdir(), 'pk-watch-home-'));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

const { ScopeWatcher } = await import('./watch.ts');
const { claudeProjectDirName, samePath } = await import('../util/paths.ts');
type Project = import('../model/types.ts').Project;
type ScopeItem = import('../model/types.ts').ScopeItem;

after(() => {
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
});

const base = mkdtempSync(join(tmpdir(), 'pk-watch-kestrel-'));
const APP = join(base, 'kestrel');
const LAB = join(base, 'kestrel-lab');
const QUIET = join(base, 'kestrel-quiet');
const NEW = join(base, 'kestrel-new');
const OTHER = join(base, 'other-project');
for (const dir of [APP, LAB, QUIET, NEW, OTHER]) mkdirSync(dir, { recursive: true });

const mainItem = (path: string, id: string): ScopeItem => ({
  id, path, category: 'Directory', relation: 'Main project', reason: 'Owner-given location', reasonSourceIds: [],
  sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'none', missing: null,
  addedBy: 'owner',
});

const sessionItem = (host: 'claude' | 'codex', cwd: string, id: string, excluded = false): ScopeItem => ({
  id, path: host === 'claude' ? join(fakeHome, '.claude', 'projects') : join(fakeHome, '.codex', 'sessions'),
  category: 'Session source', relation: excluded ? 'Excluded' : 'Session source',
  reason: `${excluded ? 'Excluded by the owner (was: ' : ''}${host === 'claude' ? 'Claude Code' : 'Codex'} sessions whose working directory is ${cwd}: 1 found${excluded ? ')' : ''}`,
  reasonSourceIds: [], sessionHost: host, sessionCwd: cwd, readOnly: true, copyOf: null, worktreeOf: null,
  versionControl: 'unknown', missing: null, addedBy: excluded ? 'owner' : 'keeper',
});

const scope = [
  mainItem(APP, 'scope_app'), mainItem(LAB, 'scope_lab'), mainItem(QUIET, 'scope_quiet'), mainItem(NEW, 'scope_new'),
  // The longer path deliberately comes first. Substring matching assigns APP's event to LAB's item.
  sessionItem('claude', LAB, 'scope_claude_lab'), sessionItem('claude', APP, 'scope_claude_app'),
  sessionItem('codex', LAB, 'scope_codex_lab'), sessionItem('codex', APP, 'scope_codex_app'),
  sessionItem('claude', QUIET, 'scope_claude_quiet', true), sessionItem('codex', QUIET, 'scope_codex_quiet', true),
];
const project = {
  id: 'p1', name: 'Kestrel', language: 'en', locations: [APP, LAB, QUIET, NEW], scope, scopeQuestions: [], keeperFiles: [], roles: [],
  organizingPaused: false, createdAt: '2026-09-01T00:00:00.000Z', lastOpenedAt: null, lastScopedAt: null,
} as unknown as Project;

const claudeApp = join(fakeHome, '.claude', 'projects', claudeProjectDirName(APP));
const claudeLab = join(fakeHome, '.claude', 'projects', claudeProjectDirName(LAB));
const claudeQuiet = join(fakeHome, '.claude', 'projects', claudeProjectDirName(QUIET));
const claudeNew = join(fakeHome, '.claude', 'projects', claudeProjectDirName(NEW));
const codexDir = join(fakeHome, '.codex', 'sessions', '2026', '09', '22');
for (const dir of [claudeApp, claudeLab, claudeQuiet, claudeNew, codexDir]) mkdirSync(dir, { recursive: true });

const waitFor = async (predicate: () => boolean, message: string): Promise<void> => {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
};

const codexLine = (id: string, cwd: string) => JSON.stringify({
  timestamp: '2026-09-22T12:00:00.000Z', type: 'session_meta',
  payload: { id, cwd, originator: 'codex-test', source: 'cli', thread_source: 'user' },
});

test('session watcher uses exact cwd ownership and ignores Codex logs whose header names another project', async () => {
  const watcher = new ScopeWatcher(project, { pollMs: 60_000 });
  watcher.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));

    const claudeFile = join(claudeApp, '11111111-1111-4111-8111-111111111111.jsonl');
    writeFileSync(claudeFile, `${JSON.stringify({ type: 'user', sessionId: '11111111-1111-4111-8111-111111111111', cwd: APP })}\n`);

    const foreign = join(codexDir, 'rollout-2026-09-22T12-00-00-foreign.jsonl');
    // The body mentions APP on purpose. Only the session_meta header is allowed to decide ownership.
    writeFileSync(foreign, `${codexLine('foreign', OTHER)}\n${JSON.stringify({ type: 'event_msg', payload: { cwd: APP, text: 'unrelated body' } })}\n`);

    const bodyOnly = join(codexDir, 'rollout-2026-09-22T12-01-00-body-only.jsonl');
    writeFileSync(bodyOnly, `${JSON.stringify({ type: 'event_msg', payload: { text: 'not a session header' } })}\n${JSON.stringify({ cwd: APP })}\n`);

    const codexFile = join(codexDir, 'rollout-2026-09-22T12-02-00-project.jsonl');
    writeFileSync(codexFile, `${codexLine('project', APP)}\n${JSON.stringify({ type: 'event_msg', payload: { text: 'project body' } })}\n`);

    await waitFor(
      () => watcher.list().some((change) => samePath(change.ref, claudeFile))
        && watcher.list().some((change) => samePath(change.ref, codexFile)),
      'the two matching session changes were not observed',
    );
    await new Promise((resolve) => setTimeout(resolve, 350));

    const changes = watcher.list();
    assert.equal(changes.find((change) => samePath(change.ref, claudeFile))?.scopeItemId, 'scope_claude_app', 'Claude uses the complete cwd, not a prefix match');
    assert.equal(changes.find((change) => samePath(change.ref, codexFile))?.scopeItemId, 'scope_codex_app', 'Codex uses the item for its header cwd');
    assert.ok(!changes.some((change) => samePath(change.ref, foreign)), 'a foreign Codex session never enters pending');
    assert.ok(!changes.some((change) => samePath(change.ref, bodyOnly)), 'a cwd outside session_meta is not treated as the header');
  } finally {
    watcher.stop();
  }
});

test('an owner-excluded session source stays quiet, while a first new session without an item is still caught', async () => {
  const watcher = new ScopeWatcher(project, { pollMs: 60_000 });
  watcher.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));

    const excludedClaude = join(claudeQuiet, '22222222-2222-4222-8222-222222222222.jsonl');
    writeFileSync(excludedClaude, `${JSON.stringify({ type: 'user', sessionId: '22222222-2222-4222-8222-222222222222', cwd: QUIET })}\n`);
    const excludedCodex = join(codexDir, 'rollout-2026-09-22T12-03-00-excluded.jsonl');
    writeFileSync(excludedCodex, `${codexLine('excluded', QUIET)}\n`);

    const newClaude = join(claudeNew, '33333333-3333-4333-8333-333333333333.jsonl');
    writeFileSync(newClaude, `${JSON.stringify({ type: 'user', sessionId: '33333333-3333-4333-8333-333333333333', cwd: NEW })}\n`);
    const newCodex = join(codexDir, 'rollout-2026-09-22T12-04-00-new.jsonl');
    writeFileSync(newCodex, `${codexLine('new', NEW)}\n`);

    await waitFor(
      () => watcher.list().some((change) => samePath(change.ref, newClaude))
        && watcher.list().some((change) => samePath(change.ref, newCodex)),
      'the first matching sessions without a pre-existing scope item were not observed',
    );
    await new Promise((resolve) => setTimeout(resolve, 350));

    const changes = watcher.list();
    assert.ok(!changes.some((change) => samePath(change.ref, excludedClaude)), 'the owner-excluded Claude source stays quiet');
    assert.ok(!changes.some((change) => samePath(change.ref, excludedCodex)), 'the owner-excluded Codex source stays quiet');
    assert.equal(changes.find((change) => samePath(change.ref, newClaude))?.scopeItemId, '', 'a first Claude session is caught before discovery has made its item');
    assert.equal(changes.find((change) => samePath(change.ref, newCodex))?.scopeItemId, '', 'a first Codex session is caught before discovery has made its item');
  } finally {
    watcher.stop();
  }
});

test('a frozen copy watches its selected Claude and Codex store, not live logs for the same cwd', async () => {
  const frozenHome = mkdtempSync(join(tmpdir(), 'pk-watch-frozen-'));
  const frozenClaudeDir = join(frozenHome, '.claude', 'projects', claudeProjectDirName(APP));
  const frozenCodexDir = join(frozenHome, '.codex', 'sessions', '2026', '09', '22');
  mkdirSync(frozenClaudeDir, { recursive: true });
  mkdirSync(frozenCodexDir, { recursive: true });
  const frozenScope = scope.map((item) => item.category === 'Session source' && item.sessionCwd === APP
    ? { ...item, sessionStoreRoot: frozenHome } : item);
  const watcher = new ScopeWatcher({ ...project, scope: frozenScope }, { pollMs: 60_000 });
  watcher.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const frozenClaude = join(frozenClaudeDir, '44444444-4444-4444-8444-444444444444.jsonl');
    const frozenCodex = join(frozenCodexDir, 'rollout-2026-09-22T12-05-00-frozen.jsonl');
    const liveClaude = join(claudeApp, '55555555-5555-4555-8555-555555555555.jsonl');
    const liveCodex = join(codexDir, 'rollout-2026-09-22T12-06-00-live-app.jsonl');
    writeFileSync(frozenClaude, `${JSON.stringify({ type: 'user', cwd: APP })}\n`);
    writeFileSync(frozenCodex, `${codexLine('frozen', APP)}\n`);
    writeFileSync(liveClaude, `${JSON.stringify({ type: 'user', cwd: APP })}\n`);
    writeFileSync(liveCodex, `${codexLine('live', APP)}\n`);
    await waitFor(() => watcher.list().some((c) => samePath(c.ref, frozenClaude)) && watcher.list().some((c) => samePath(c.ref, frozenCodex)), 'the frozen store changes were not observed');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const changes = watcher.list();
    assert.equal(changes.find((c) => samePath(c.ref, frozenClaude))?.scopeItemId, 'scope_claude_app');
    assert.equal(changes.find((c) => samePath(c.ref, frozenCodex))?.scopeItemId, 'scope_codex_app');
    assert.ok(!changes.some((c) => samePath(c.ref, liveClaude) || samePath(c.ref, liveCodex)), 'live host logs for the frozen cwd stay out');
  } finally {
    watcher.stop();
  }
});
