/**
 * What counts as code is the ledger's to say (D98, D98 补; src/codemap/README.md): a file a reader reads — the TypeScript
 * compiler, or the code engine for every other language — or one in a language the ledger knows is code though nothing
 * reads it. Kotlin and Swift enter a territory's code, its generation lines and its unreferenced facts as TypeScript and
 * Dart do; third-party code does not; code nothing reads is a candidate that says so, and a territory of nothing else is
 * `Not known`. `Code` says per language how deep the ledger reads it, from the coverage it measured. The engine runs for
 * real (a child process with --liftoff-only) on a small repository made here, with no network.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-codemap-languages-'));
process.env.USERPROFILE = scratch;
process.env.HOME = scratch;

const { rebuildLedgerInPlace, ledgerPath } = await import('../ledger/rebuild.ts');
const { Ledger } = await import('../ledger/index.ts');
const { codeView } = await import('../ledger/views.ts');
const { ProjectStore } = await import('../store/project-store.ts');
const { CodeMapIndex, codeAnomalyCandidates, isCodeFile } = await import('./facts.ts');
type Project = import('../model/types.ts').Project;
type ScopeItem = import('../model/types.ts').ScopeItem;
type WorkThread = import('../model/types.ts').WorkThread;
type CodeTerritory = import('../model/k-types.ts').CodeTerritory;
type CodeMapFile = import('./facts.ts').CodeMapFile;
type LedgerT = import('../ledger/index.ts').Ledger;

const repo = join(scratch, 'app');
mkdirSync(repo);
const ENV = { GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@languages.invalid', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@languages.invalid' };
const git = (args: string[], date = '2026-09-01T10:00:00+00:00') => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel: string, text: string) => { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), text); };

const ACTIVITY = 'android/app/src/main/kotlin/com/example/app/MainActivity.kt';
const BRIDGE = 'android/app/src/main/kotlin/com/example/app/bridge/Bridge.kt';
git(['init', '-q', '-b', 'main']);
git(['config', 'core.autocrlf', 'false']);
write('lib/main.dart', "import 'app.dart';\n\nvoid main() => HomeApp().run();\n");
write('lib/app.dart', 'class HomeApp {\n  void run() {}\n}\n');
write(ACTIVITY, 'package com.example.app\n\nimport com.example.app.bridge.Bridge\n\nclass MainActivity {\n  fun start() {\n    Bridge().open()\n  }\n}\n');
write(BRIDGE, 'package com.example.app.bridge\n\nclass Bridge {\n  fun open() {}\n}\n');
write('ios/Runner/App.swift', 'class RunnerApp {\n  func start() {\n    let helper = Helper()\n    helper.run()\n  }\n}\n');
write('ios/Runner/Helper.swift', 'class Helper {\n  func run() {}\n}\n');
write('ios/Runner/Orphan.swift', 'class Orphan {\n  func idle() {}\n}\n');
write('tool/build.sh', '#!/bin/sh\necho build\n');
write('third_party/share/Plugin.swift', 'class SharePlugin {\n  func share() {}\n}\n');
write('src/index.ts', "import { x } from './x.ts';\nexport const y = x;\n");
write('src/x.ts', 'export const x = 1;\n');
write('README.md', '# App\n');
write('config.json', '{}\n');
git(['add', '-A']);
git(['commit', '-q', '-m', 'Start']);
// Current work AB changes the activity: an anchor of the reference walk, as a TypeScript file it changed would be.
write(ACTIVITY, 'package com.example.app\n\nimport com.example.app.bridge.Bridge\n\nclass MainActivity {\n  fun start() {\n    Bridge().open()\n  }\n\n  fun stop() {}\n}\n');
git(['commit', '-q', '-am', 'AB: the activity stops too'], '2026-09-02T10:00:00+00:00');

const PID = 'codemap-languages';
const item = { id: 'app', path: repo, category: 'Repository', relation: 'Main project', reason: 'languages test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as ScopeItem;
const project = { id: PID, name: 'App', locations: [repo], scope: [item], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: '2026-09-01T00:00:00Z', lastOpenedAt: null, lastScopedAt: null } as unknown as Project;
const home = join(scratch, 'home');
const file = ledgerPath(PID, home);
rebuildLedgerInPlace(file, project, {});
let L: LedgerT | null = Ledger.openPath(file)!;
const store = ProjectStore.open(PID, home);
store.threads.put({ id: 'thr_ab', projectId: PID, title: 'The activity', ids: ['AB'], validity: 'Current', progress: 'Done', serves: [], dependsOn: [], replacedBy: null, unresolved: '' } as unknown as WorkThread);
const territory = (id: string, paths: string[]): CodeTerritory => ({ id, projectId: PID, repo: 'app', name: id, summary: id, paths, kind: 'shared', areaId: null, alsoServes: [], anomalies: [], roundId: null, jobId: null, updatedAt: '' });
after(async () => {
  try { L?.close(); } catch { /* closed */ }
  await store.flush();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('what counts as code is the ledger’s: what a reader reads, or a language it knows is code; not third-party, prose or data', () => {
  const rows = L!.db.prepare("SELECT * FROM code_files WHERE repo = 'app'").all() as unknown as CodeMapFile[];
  const byPath = new Map(rows.map((r) => [r.path, r]));
  assert.deepEqual(rows.filter(isCodeFile).map((r) => r.path).sort(), [
    ACTIVITY, BRIDGE, 'ios/Runner/App.swift', 'ios/Runner/Helper.swift', 'ios/Runner/Orphan.swift', 'lib/app.dart', 'lib/main.dart', 'src/index.ts', 'src/x.ts', 'tool/build.sh',
  ]);
  assert.deepEqual([byPath.get(ACTIVITY)?.reader, byPath.get('ios/Runner/App.swift')?.reader, byPath.get('src/x.ts')?.reader], ['engine', 'engine', 'compiler']);
  const vendored = byPath.get('third_party/share/Plugin.swift')!;
  assert.equal(vendored.reader, 'engine', 'the engine reads vendored Swift too');
  assert.ok(vendored.classification && !isCodeFile(vendored), 'but third-party code is no territory’s code');
  assert.equal(byPath.get('tool/build.sh')?.reader, null, 'nothing reads a shell script, yet the ledger knows it is code');
});

test('Kotlin and Swift count as TypeScript does: their references carry the walk, their lines are blamed, what nothing reaches is unreferenced', () => {
  const index = new CodeMapIndex(L!, store, 'app');
  assert.equal(index.isUnused(BRIDGE), false, 'reached from the activity current work changed, through the Kotlin import');
  assert.equal(index.isUnused('ios/Runner/Helper.swift'), false, 'reached from App.swift, an entry point by its name, through the Swift call');
  assert.equal(index.isUnused('ios/Runner/Orphan.swift'), true);
  assert.equal(index.currentUse(['android']), 'In current plan', 'current work changed it, and it is live');
  assert.equal(index.currentUse(['ios/Runner/Orphan.swift']), 'Unreferenced', 'Swift the engine reads, reached by nothing: computed');
  assert.equal(index.currentUse(['ios']), 'In use, not in current plan');
  assert.equal(index.currentUse(['tool']), 'Not known', 'a script nothing reads and nothing reaches: not shown either way');
  assert.equal(index.currentUse(['third_party']), 'Not known', 'no territory’s code there');
  const lines = index.generationOrigins(['android']).reduce((n, g) => n + g.lines, 0);
  assert.equal(lines, 11 + 5, 'the Kotlin files’ lines, blamed');
  assert.deepEqual(index.generationOrigins(['tool']), [], 'code nothing reads is not blamed, so it adds no lines');
});

test('the candidates: code nothing reads is one and says so; a block of nothing else is not called unreferenced', () => {
  const unreferencedFile = (all: ReturnType<typeof codeAnomalyCandidates>, path: string) => all.find((c) => c.kind === 'Unreferenced file' && c.path === path);
  const byDirectory = codeAnomalyCandidates(L!, store, project);
  const orphan = unreferencedFile(byDirectory, 'ios/Runner/Orphan.swift');
  assert.ok(orphan && !/reads no references/.test(orphan.detail), `read by the engine, so the fact is computed: ${orphan?.detail}`);
  assert.match(unreferencedFile(byDirectory, 'tool/build.sh')?.detail ?? '', /reads no references of this shell file.*Inferred/);
  assert.ok(!unreferencedFile(byDirectory, 'third_party/share/Plugin.swift'));
  assert.ok(!byDirectory.some((c) => c.kind === 'Unreferenced block' && c.path === 'tool'), 'a directory of nothing but a script nobody reads');
  store.territories.putMany([territory('t_orphan', ['ios/Runner/Orphan.swift']), territory('t_tool', ['tool']), territory('t_android', ['android'])]);
  const byTerritory = codeAnomalyCandidates(L!, store, project);
  assert.deepEqual(byTerritory.filter((c) => c.kind === 'Unreferenced block').map((c) => c.territoryId), ['t_orphan']);
  const view = codeView(L!, store, project)!;
  assert.deepEqual(['t_orphan', 't_tool', 't_android'].map((id) => view.territories.find((t) => t.id === id)?.currentUse), ['Unreferenced', 'Not known', 'In current plan']);
  store.territories.remove('t_orphan'); store.territories.remove('t_tool'); store.territories.remove('t_android');
});

test('Code says per language how deep the ledger reads it: the compiler, the engine with what it resolved, or not read', () => {
  const view = codeView(L!, store, project)!;
  const level = (language: string) => view.levels.find((l) => l.language === language);
  assert.deepEqual(view.levels.map((l) => l.language).sort(), ['dart', 'kotlin', 'shell', 'swift', 'typescript'], 'the code, not the prose or data (README.md, config.json)');
  assert.deepEqual(level('kotlin'), { language: 'kotlin', files: 2, read: 2, readBy: 'engine', imports: { resolved: 1, unresolvedNamingRepoFiles: 0 }, namedButUnreferenced: 0, parseErrors: 0, complete: true, gaps: [] });
  assert.equal(level('swift')?.files, 3, 'the vendored Swift file is no code of the project');
  assert.deepEqual([level('swift')?.readBy, level('swift')?.complete], ['engine', true]);
  assert.deepEqual([level('dart')?.readBy, level('dart')?.imports?.resolved], ['engine', 1]);
  assert.deepEqual([level('typescript')?.readBy, level('typescript')?.imports, level('typescript')?.complete], ['compiler', null, true]);
  assert.deepEqual(level('shell'), { language: 'shell', files: 1, read: 0, readBy: null, imports: null, namedButUnreferenced: 0, parseErrors: 0, complete: false, gaps: [] });
  // The ledger's coverage says the same for a program to read: who reads the language, and how many of its files.
  const shell = L!.coverage().languages.find((l) => l.language === 'shell')!;
  assert.deepEqual([shell.reader, shell.read, shell.files, shell.readBy], [null, 0, 1, null]);
});

test('a ledger not rebuilt since D98 has no reader: TypeScript counts as read, as the ledger falls back; the rest is code nothing reads', () => {
  const old = join(scratch, 'before-d98.sqlite');
  L!.db.exec(`VACUUM INTO '${old.replace(/'/g, "''")}'`);
  const db = new DatabaseSync(old);
  for (const c of ['reader', 'ref_lang', 'named_by']) db.exec(`ALTER TABLE code_files DROP COLUMN ${c}`);
  db.close();
  const before = Ledger.openPath(old)!;
  try {
    const index = new CodeMapIndex(before, store, 'app');
    assert.equal(index.currentUse(['src']), 'In use, not in current plan', 'TypeScript, read by the compiler by its extension');
    assert.equal(index.currentUse(['ios/Runner/Orphan.swift']), 'Not known', 'Swift, no reader recorded: nothing claimed');
    const levels = codeView(before, store, project)!.levels;
    assert.deepEqual(levels.map((l) => [l.language, l.readBy]).sort(), [['dart', null], ['kotlin', null], ['shell', null], ['swift', null], ['typescript', 'compiler']]);
  } finally {
    before.close();
  }
});
