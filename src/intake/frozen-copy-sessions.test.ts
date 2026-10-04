import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hostHome = mkdtempSync(join(tmpdir(), 'pk-copy-host-'));
process.env.USERPROFILE = hostHome;
process.env.HOME = hostHome;

const { discoverScope } = await import('../scope/discover.ts');
const { fullIntake, incrementalIntake } = await import('./intake.ts');
const { ProjectStore } = await import('../store/project-store.ts');
const { ownerUtterances } = await import('../sources/sessions/utterances.ts');
const { claudeProjectDirName, samePath } = await import('../util/paths.ts');
type Project = import('../model/types.ts').Project;

const base = mkdtempSync(join(tmpdir(), 'pk-copy-frozen-'));
const original = join(base, 'original project');
const copy = join(base, 'copy');
const fallbackCopy = join(base, 'fallback-copy');
const chineseCopy = join(base, 'chinese-copy');
const frozen = join(base, 'sessions at T');
for (const dir of [copy, fallbackCopy, chineseCopy, frozen]) mkdirSync(dir);
writeFileSync(join(copy, 'README.md'), '# Frozen copy\n');
writeFileSync(join(fallbackCopy, 'README.md'), '# Ordinary copy\n');
writeFileSync(join(chineseCopy, 'README.md'), '# Chinese copy log\n');
writeFileSync(`${copy}.copy-log.txt`, `source: ${original}\nsessions: ${frozen}\n`);
writeFileSync(`${fallbackCopy}.copy-log.txt`, `来源：${original}\n`);
writeFileSync(`${chineseCopy}.copy-log.txt`, `来源：${original}\n会话：${frozen}\n`);

const claudeId = '11111111-1111-4111-8111-111111111111';
const codexId = '22222222-2222-4222-8222-222222222222';
function claudeLog(home: string, words: string): string {
  const dir = join(home, '.claude', 'projects', claudeProjectDirName(original));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${claudeId}.jsonl`);
  writeFileSync(file, JSON.stringify({
    sessionId: claudeId, cwd: original, type: 'user', timestamp: '2026-09-20T01:00:00.000Z',
    origin: { kind: 'human' }, message: { role: 'user', content: words },
  }) + '\n');
  return file;
}
const hostClaude = claudeLog(hostHome, 'Live host words must stay out.');
const frozenClaude = claudeLog(frozen, 'Frozen Claude decision at T.');
const codexDir = join(frozen, '.codex', 'sessions', '2026', '09', '20');
mkdirSync(codexDir, { recursive: true });
const frozenCodex = join(codexDir, `rollout-2026-09-20T01-00-00-${codexId}.jsonl`);
writeFileSync(frozenCodex, [
  { timestamp: '2026-09-20T01:00:00.000Z', type: 'session_meta', payload: { id: codexId, cwd: original, source: 'cli' } },
  { timestamp: '2026-09-20T01:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Frozen Codex decision at T.' }] } },
].map((line) => JSON.stringify(line)).join('\n') + '\n');

const discovery = (location: string) => discoverScope({ id: 'p1', name: 'Frozen copy', locations: [location] }, { home: hostHome });
const project = (location: string, items: ReturnType<typeof discovery>['items']): Project => ({
  id: 'p1', name: 'Frozen copy', locations: [location], scope: items.map(({ reasonRef: _r, sessions: _s, ...item }) => item),
  language: 'en', scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false,
  createdAt: '2026-09-20T00:00:00.000Z', lastOpenedAt: null, lastScopedAt: null,
}) as unknown as Project;

test('copy log selects frozen native session storage while matching the original cwd through discovery, intake, and owner utterances', async () => {
  const result = discovery(copy);
  assert.equal(result.items.find((i) => i.path === copy)?.copyOf, original);
  const sessionItems = result.items.filter((i) => i.category === 'Session source' && i.sessionCwd && samePath(i.sessionCwd, original));
  assert.equal(sessionItems.length, 2);
  for (const item of sessionItems) {
    assert.equal(item.sessionStoreRoot, frozen);
    assert.match(item.reason, /frozen session storage/);
    assert.ok(item.path.startsWith(frozen), 'Project scope points to the frozen store');
    assert.ok((item.sessions ?? []).every((s) => s.file.startsWith(frozen)));
  }

  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-copy-store-')));
  const scoped = project(copy, result.items);
  const intake = await fullIntake(store, scoped);
  assert.equal(intake.sessionsRead, 2);
  const sources = store.sources.filter((s) => s.anchor.kind === 'session');
  assert.ok(sources.some((s) => s.anchor.kind === 'session' && samePath(s.anchor.file, frozenClaude)));
  assert.ok(sources.some((s) => s.anchor.kind === 'session' && samePath(s.anchor.file, frozenCodex)));
  assert.ok(!sources.some((s) => s.anchor.kind === 'session' && samePath(s.anchor.file, hostClaude)), 'live host log is excluded');
  const found = ownerUtterances(store);
  assert.equal(typeof found, 'object');
  if (typeof found === 'string') return;
  assert.deepEqual(found.utterances.map((u) => u.text).sort(), ['Frozen Claude decision at T.', 'Frozen Codex decision at T.']);

  appendFileSync(frozenClaude, JSON.stringify({
    sessionId: claudeId, cwd: original, type: 'user', timestamp: '2026-09-20T01:02:00.000Z',
    origin: { kind: 'human' }, message: { role: 'user', content: 'Frozen follow-up at T.' },
  }) + '\n');
  const changed = incrementalIntake(store, scoped, [{ kind: 'session', ref: frozenClaude, label: 'frozen update', since: '2026-09-20T01:02:00.000Z', lastEventAt: 0, scopeItemId: sessionItems.find((i) => i.sessionHost === 'claude')!.id }]);
  assert.equal(changed.sessionsRead, 1, 'incremental intake also uses the frozen store');
  const updated = ownerUtterances(store);
  assert.equal(typeof updated, 'object');
  if (typeof updated !== 'string') assert.ok(updated.utterances.some((u) => u.text === 'Frozen follow-up at T.'));
});

test('a copy log without sessions keeps the host-native lookup', () => {
  const items = discovery(fallbackCopy).items;
  const claude = items.find((i) => i.category === 'Session source' && i.sessionHost === 'claude' && i.sessionCwd && samePath(i.sessionCwd, original));
  assert.ok(claude);
  assert.equal(claude.sessionStoreRoot, undefined);
  assert.match(claude.reason, /host session storage/);
  assert.ok((claude.sessions ?? []).some((s) => samePath(s.file, hostClaude)));
});

test('the Chinese 会话 label selects the same frozen session store', () => {
  const items = discovery(chineseCopy).items;
  assert.equal(items.find((i) => i.path === chineseCopy)?.copyOf, original);
  const sessionItems = items.filter((i) => i.category === 'Session source' && i.sessionCwd && samePath(i.sessionCwd, original));
  assert.equal(sessionItems.length, 2);
  assert.ok(sessionItems.every((i) => i.sessionStoreRoot === frozen));
});
