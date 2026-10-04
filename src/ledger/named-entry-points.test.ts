/**
 * Code reached only through build or manifest files is not called unreferenced (D97, D98; Spec §1.19; CKC-25 AC-5): the
 * ledger reads every tracked text file for the code files no counted reference reaches. A build or manifest file naming
 * one makes it a named entry point — AndroidManifest.xml launching `.MainActivity`, a CMakeLists.txt compiling
 * `twice.cpp`, package.json running `scripts/build.ts` — code naming one a reference no reader resolved, and any other
 * text only mentions it. A residual call there, or on what only such a file reaches, is Inferred and the candidate says
 * why; a territory holding one is not computed Unreferenced; a document's mention leaves the fact as computed. The same
 * table and the same matching for every project: file names, and in a build or manifest file dotted names read as paths.
 * The engine runs for real (a child process with --liftoff-only) on a small repository made here, with no network.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-named-entry-'));
process.env.USERPROFILE = scratch;
process.env.HOME = scratch;

const { rebuildLedgerInPlace, ledgerPath } = await import('./rebuild.ts');
const { Ledger } = await import('./index.ts');
const { NAMING_RULE, isBuildFile, namingOf } = await import('./code.ts');
const { coverageView, codeView } = await import('./views.ts');
const { ProjectStore } = await import('../store/project-store.ts');
const { CodeMapIndex, codeAnomalyCandidates, codeLevels } = await import('../codemap/facts.ts');
type Project = import('../model/types.ts').Project;
type ScopeItem = import('../model/types.ts').ScopeItem;
type CodeTerritory = import('../model/k-types.ts').CodeTerritory;
type LedgerT = import('./index.ts').Ledger;

const repo = join(scratch, 'app');
mkdirSync(repo);
const ENV = { GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@named.invalid', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@named.invalid' };
const git = (args: string[], date = '2026-09-01T10:00:00+00:00') => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel: string, text: string) => { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), text); };

const KT = 'android/app/src/main/kotlin/com/example/app';
const ACTIVITY = `${KT}/MainActivity.kt`;
const BRIDGE = `${KT}/bridge/Bridge.kt`;
const SYNC = `${KT}/sync/SyncService.kt`;
const STALE = `${KT}/Stale.kt`;
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const CMAKE = 'windows/runner/CMakeLists.txt';
git(['init', '-q', '-b', 'main']);
git(['config', 'core.autocrlf', 'false']);
// The activity by a name relative to the package, the service by its qualified name; the platform's own names name nothing here.
write(MANIFEST, '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n  <application android:label="app">\n    <activity android:name=".MainActivity" android:exported="true">\n      <intent-filter>\n        <action android:name="android.intent.action.MAIN" />\n      </intent-filter>\n    </activity>\n    <service android:name="com.example.app.sync.SyncService" />\n  </application>\n</manifest>\n');
// A qualified name of another package names no file of this one, though a file here has that class's name.
write('android/app/build.gradle', 'android {\n    namespace = "com.example.app"\n}\n\napplication {\n    mainClass = "io.other.lib.Stale"\n}\n');
write(ACTIVITY, 'package com.example.app\n\nimport com.example.app.bridge.Bridge\n\nclass MainActivity {\n  fun start() {\n    Bridge().open()\n  }\n}\n');
write(BRIDGE, 'package com.example.app.bridge\n\nclass Bridge {\n  fun open() {}\n}\n');
write(SYNC, 'package com.example.app.sync\n\nclass SyncService {\n  fun sync() {}\n}\n');
write(STALE, 'package com.example.app\n\nclass Stale {\n  fun idle() {}\n}\n');
// C++: a header is included, the source that implements it only compiled — named by its build file.
write(CMAKE, 'cmake_minimum_required(VERSION 3.14)\nproject(runner LANGUAGES CXX)\n\nadd_executable(runner WIN32\n  "main.cpp"\n  "twice.cpp"\n)\n');
write('windows/runner/main.cpp', '#include "twice.h"\n\nint main() {\n  return 0;\n}\n');
write('windows/runner/twice.h', 'int twice(int x);\n');
write('windows/runner/twice.cpp', '#include "twice.h"\n\nint twice(int x) {\n  return 2 * x;\n}\n');
// TypeScript through the compiler: a script package.json runs.
write('package.json', '{\n  "name": "app",\n  "private": true,\n  "scripts": { "build": "node scripts/build.ts" }\n}\n');
write('scripts/build.ts', 'export const built = true;\n');
// Dart: the app, a library whose `part` the engine does not follow, and a screen a document mentions.
write('lib/main.dart', "import 'app.dart';\n\nvoid main() => App().run();\n");
write('lib/app.dart', "import 'shelf.dart';\n\nclass App {\n  void run() => Shelf().open();\n}\n");
write('lib/shelf.dart', "part 'shelf_part.dart';\n\nclass Shelf {\n  void open() {}\n}\n");
write('lib/shelf_part.dart', "part of 'shelf.dart';\n\nclass ShelfPart {}\n");
write('lib/old_screen.dart', 'class OldScreen {}\n');
write('lib/dead/dead_lib.dart', "part 'dead_part.dart';\n\nclass DeadLib {}\n");
write('lib/dead/dead_part.dart', "part of 'dead_lib.dart';\n\nclass DeadPart {}\n");
write('docs/HISTORY.md', '# History\n\nThe old screen (lib/old_screen.dart) left the menu in September; `.Stale` went with it.\n');
git(['add', '-A']);
git(['commit', '-q', '-m', 'Start']);

const PID = 'named-entry';
const item = { id: 'app', path: repo, category: 'Repository', relation: 'Main project', reason: 'named entry points test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as ScopeItem;
const project = { id: PID, name: 'App', locations: [repo], scope: [item], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: '2026-09-01T00:00:00Z', lastOpenedAt: null, lastScopedAt: null } as unknown as Project;
const home = join(scratch, 'home');
const file = ledgerPath(PID, home);
const first = rebuildLedgerInPlace(file, project, {});
let L: LedgerT | null = Ledger.openPath(file)!;
const store = ProjectStore.open(PID, home);
const territory = (id: string, paths: string[]): CodeTerritory => ({ id, projectId: PID, repo: 'app', name: id, summary: id, paths, kind: 'shared', areaId: null, alsoServes: [], anomalies: [], roundId: null, jobId: null, updatedAt: '' });
const page = <T>(r: T | string): T => { if (typeof r === 'string') throw new Error(r); return r; };
const naming = (path: string) => namingOf((L!.db.prepare("SELECT named_by FROM code_files WHERE repo = 'app' AND path = ?").get(path) as { named_by: string | null } | undefined)?.named_by);
after(async () => {
  try { L?.close(); } catch { /* closed */ }
  await store.flush();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('build and manifest files are known by their names, the same for every project', () => {
  for (const p of [MANIFEST, CMAKE, 'package.json', 'mobile_app/pubspec.yaml', 'android/app/build.gradle.kts', 'ios/Runner.xcodeproj/project.pbxproj', 'ios/Runner/Info.plist', 'ios/Podfile', 'src/App/App.csproj', 'Makefile', 'windows/runner/Runner.rc', '.github/workflows/ci.yml', 'Dockerfile'])
    assert.ok(isBuildFile(p), p);
  for (const p of ['README.md', 'docs/HISTORY.md', 'config.json', 'analysis_options.yaml', 'test/fixtures/list.json', 'lib/main.dart', '.gitignore'])
    assert.ok(!isBuildFile(p), p);
});

test('who names a file no counted reference reaches: a build or manifest file, code, or other text — and how', () => {
  assert.equal(first.repos[0]!.code.engine?.ok, true, first.repos[0]!.code.engine?.error ?? '');
  assert.deepEqual(naming(ACTIVITY), [{ path: MANIFEST, kind: 'entry' }], 'the manifest launches .MainActivity');
  assert.deepEqual(naming(SYNC), [{ path: MANIFEST, kind: 'entry' }], 'by its qualified name, the package its directories');
  assert.deepEqual(naming('windows/runner/twice.cpp'), [{ path: CMAKE, kind: 'entry' }], 'its CMakeLists.txt compiles it');
  assert.deepEqual(naming('scripts/build.ts'), [{ path: 'package.json', kind: 'entry' }], 'package.json runs it');
  assert.deepEqual(naming('lib/shelf_part.dart'), [{ path: 'lib/shelf.dart', kind: 'reference' }], 'a part the engine does not follow');
  assert.deepEqual(naming('lib/old_screen.dart'), [{ path: 'docs/HISTORY.md', kind: 'mention' }], 'a document mentions it');
  assert.deepEqual(naming(STALE), [], 'io.other.lib.Stale is another package’s, and a document’s dotted name is no reference');
  assert.deepEqual(naming(BRIDGE), [], 'the activity references it: a counted reference reaches it');
});

test('fileRefs and unreferenced say it: a named entry point, a reference no reader resolved, a mention', () => {
  const activity = page(L!.fileRefs(ACTIVITY, { repo: 'app' }));
  assert.deepEqual(activity.namedBy, [MANIFEST]);
  assert.match(activity.namedByNote ?? '', /named entry point: named in AndroidManifest\.xml/);
  assert.match(activity.namedByNote ?? '', /no computed fact/);
  const screen = page(L!.fileRefs('lib/old_screen.dart', { repo: 'app' }));
  assert.ok(!('namedBy' in screen), 'a mention does not make the fact uncertain');
  assert.deepEqual(screen.mentionedBy, ['docs/HISTORY.md']);
  const rows: readonly { path: string; namedBy?: string[]; entryPoint?: string; mentionedBy?: string[] }[] = page(L!.unreferenced({ repo: 'app' })).rows;
  const row = (p: string) => rows.find((r) => r.path === p);
  assert.deepEqual([row(ACTIVITY)?.namedBy, row(ACTIVITY)?.entryPoint], [[MANIFEST], 'named in AndroidManifest.xml']);
  assert.equal(row('windows/runner/twice.cpp')?.entryPoint, 'named in CMakeLists.txt');
  assert.deepEqual([row('lib/shelf_part.dart')?.namedBy, row('lib/shelf_part.dart')?.entryPoint], [['lib/shelf.dart'], undefined]);
  assert.deepEqual([row('lib/old_screen.dart')?.namedBy, row('lib/old_screen.dart')?.mentionedBy], [undefined, ['docs/HISTORY.md']]);
  assert.deepEqual(Object.keys(row(STALE) ?? {}).filter((k) => /named|mention|entry/i.test(k)), []);
});

test('a residual call on a named entry point is Inferred; on what a document only mentions it stands on the references', () => {
  const android = L!.referenceReach('app', ['android']);
  assert.equal(android.complete, false);
  assert.match(android.gaps.join(' '), /named by a build or manifest file, so they are named entry points: .*MainActivity\.kt \(named in android\/app\/src\/main\/AndroidManifest\.xml\)/);
  assert.equal(L!.referenceReach('app', [ACTIVITY]).complete, false);
  assert.match(L!.referenceReach('app', ['windows/runner']).gaps.join(' '), /twice\.cpp \(named in windows\/runner\/CMakeLists\.txt\)/);
  assert.match(L!.referenceReach('app', ['scripts']).gaps.join(' '), /it is a named entry point: scripts\/build\.ts \(named in package\.json\)/);
  assert.match(L!.referenceReach('app', ['lib/shelf_part.dart']).gaps.join(' '), /named by other files, so a reference went unresolved/);
  assert.deepEqual(L!.referenceReach('app', [STALE]), { complete: true, languages: ['kotlin'], gaps: [] }, 'nothing names it: computed');
  assert.deepEqual(L!.referenceReach('app', ['lib/old_screen.dart']), { complete: true, languages: ['dart'], gaps: [] }, 'a document mentions it: still computed');
});

test('per language, named entry points say where the code is entered, not how deep it is read; Project scope says what Code says', () => {
  const langs = L!.coverage().languages;
  const kotlin = langs.find((l) => l.language === 'kotlin')!;
  assert.deepEqual([kotlin.reach?.namedEntryPoints, kotlin.reach?.namedButUnreferenced, kotlin.gaps], [2, 0, []], 'the activity and the service; nothing left unresolved');
  assert.equal(kotlin.referenceLevel, 'symbol');
  assert.match(kotlin.level, /2 named entry points no counted reference reaches, named by a build or manifest file/);
  assert.equal(langs.find((l) => l.language === 'cpp')?.reach?.namedEntryPoints, 2, 'main.cpp and twice.cpp, compiled');
  assert.equal(langs.find((l) => l.language === 'typescript')?.reach?.namedEntryPoints, 1);
  const dart = langs.find((l) => l.language === 'dart')!;
  assert.deepEqual([dart.reach?.namedButUnreferenced, dart.reach?.namedEntryPoints], [3, 0], 'the two parts, named by their libraries, and the dead library its part names');
  const levels = codeLevels(langs);
  assert.deepEqual(levels.find((l) => l.language === 'kotlin'), { language: 'kotlin', files: 4, read: 4, readBy: 'engine', imports: { resolved: 1, unresolvedNamingRepoFiles: 0 }, namedButUnreferenced: 0, parseErrors: 0, complete: true, gaps: [] });
  const scope = coverageView(L!).languages;
  for (const l of levels) assert.deepEqual(scope.find((s) => s.language === l.language)?.code, l, `Project scope and Code agree on ${l.language}`);
  assert.deepEqual(scope.filter((s) => !s.code).map((s) => s.language).sort(), ['json', 'markdown', 'other', 'text', 'xml'], 'prose and data (build files among them): no code');
  assert.deepEqual(codeView(L!, store, project)!.levels, levels);
});

test('the candidates say it, and a territory holding a named entry point is not computed Unreferenced', () => {
  const all = codeAnomalyCandidates(L!, store, project);
  const detail = (path: string) => all.find((c) => c.kind === 'Unreferenced file' && c.path === path)?.detail ?? '(no candidate)';
  assert.match(detail(ACTIVITY), /It is a named entry point: named in AndroidManifest\.xml \(android\/app\/src\/main\/AndroidManifest\.xml\).*A judgement here is Inferred\./);
  assert.ok(all.find((c) => c.path === ACTIVITY)!.evidence.some((e) => e.id === `file:${MANIFEST}`), 'the manifest is its evidence');
  assert.match(detail(BRIDGE), /Only files other files name reach it, from android\/app\/src\/main\/kotlin\/com\/example\/app\/MainActivity\.kt \(named in AndroidManifest\.xml\)\. A judgement here is Inferred\./);
  assert.match(detail('windows/runner/twice.cpp'), /named in CMakeLists\.txt/);
  assert.match(detail('scripts/build.ts'), /named in package\.json/);
  assert.match(detail('lib/old_screen.dart'), /Mentioned in docs\/HISTORY\.md, which references nothing\.$/);
  assert.doesNotMatch(detail('lib/old_screen.dart'), /Inferred/, 'a mention leaves it computed');
  assert.equal(detail(STALE), 'No path from a conventional entry point or currently claimed work through non-test file references.', 'plain');
  assert.match(detail('lib/dead/dead_part.dart'), /Named in lib\/dead\/dead_lib\.dart, which nothing reaches either: a reference its reader did not resolve/);
  assert.match(detail('lib/shelf_part.dart'), /Named in lib\/shelf\.dart: a reference its reader did not resolve\. A judgement here is Inferred\./, 'a part of live code');

  const index = new CodeMapIndex(L!, store, 'app');
  assert.equal(index.currentUse([ACTIVITY, BRIDGE]), 'Not known', 'entered from the manifest: not shown to be unreferenced');
  assert.equal(index.currentUse(['android']), 'Not known', 'it holds a named entry point');
  assert.equal(index.currentUse([STALE]), 'Unreferenced', 'nothing names it and nothing reaches it: computed');
  assert.equal(index.currentUse(['lib/old_screen.dart']), 'Unreferenced', 'a document’s mention changes nothing');
  assert.equal(index.currentUse(['lib/dead']), 'Unreferenced', 'a part named only by a library nothing reaches is as dead as its library');
  assert.equal(index.currentUse(['lib/shelf_part.dart']), 'Not known', 'a part live code names');
  const blocks = all.filter((c) => c.kind === 'Unreferenced block').map((c) => c.path).sort();
  assert.deepEqual(blocks, ['lib/dead'], 'by directory: the activity’s holds a named entry point, the bridge’s is reached only from it, the service’s is one');
  store.territories.putMany([territory('t_shell', [ACTIVITY, BRIDGE, SYNC]), territory('t_stale', [STALE])]);
  try {
    const byTerritory = codeAnomalyCandidates(L!, store, project).filter((c) => c.kind === 'Unreferenced block').map((c) => c.territoryId);
    assert.deepEqual(byTerritory, ['t_stale']);
    assert.deepEqual(['t_shell', 't_stale'].map((id) => codeView(L!, store, project)!.territories.find((t) => t.id === id)?.currentUse), ['Not known', 'Unreferenced']);
  } finally {
    store.territories.remove('t_shell'); store.territories.remove('t_stale');
  }
});

test('a ledger whose code was read before build and manifest files were: read again once, its old names still read', () => {
  L!.close();
  L = null;
  const db = new DatabaseSync(file);
  const key = "code:app";
  const signature = (db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string }).value;
  assert.ok(signature.endsWith(`|${NAMING_RULE}`), signature);
  // As a ledger read before looked: the signature without the rule, a code file's old list of names, no entry points.
  db.prepare('UPDATE state SET value = ? WHERE key = ?').run(signature.slice(0, -(NAMING_RULE.length + 1)), key);
  db.prepare("UPDATE code_files SET named_by = ? WHERE repo = 'app' AND path = ?").run(JSON.stringify(['lib/shelf.dart']), 'lib/shelf_part.dart');
  db.prepare("UPDATE code_files SET named_by = NULL WHERE repo = 'app' AND path = ?").run(ACTIVITY);
  db.close();
  L = Ledger.openPath(file)!;
  assert.deepEqual(naming('lib/shelf_part.dart'), [{ path: 'lib/shelf.dart', kind: 'reference' }], 'an old list is read as code naming it');
  assert.equal(page(L.fileRefs('lib/shelf_part.dart', { repo: 'app' })).namedBy?.[0], 'lib/shelf.dart');
  L.close();
  L = null;
  const again = rebuildLedgerInPlace(file, project, {});
  assert.equal(again.repos[0]!.code.skipped, false, 'the code is read again');
  L = Ledger.openPath(file)!;
  assert.deepEqual(naming(ACTIVITY), [{ path: MANIFEST, kind: 'entry' }]);
  const next = rebuildLedgerInPlace(file, project, {});
  assert.equal(next.repos[0]!.code.skipped, true, 'and not again while nothing moved');
});
