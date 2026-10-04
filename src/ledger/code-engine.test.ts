/**
 * The general code engine (D98, R-61; code-engine.ts): every language the TypeScript path does not read is read by the
 * engine on a snapshot ProjectKeeper owns — nothing written into the project — with dependencies from references it
 * resolved (never by a name alone), symbols on demand with each hit's method, history through its extraction, and the
 * reach measured per language. TypeScript stays on the compiler. The fixture is a small repository of Dart, Python and
 * TypeScript made here; the engine runs for real (a child process with --liftoff-only), with no network.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-code-engine-'));
process.env.USERPROFILE = scratch;
process.env.HOME = scratch;
after(() => { try { L?.close(); } catch { /* closed */ } rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const { rebuildLedgerInPlace, ledgerPath, engineRootOf } = await import('./rebuild.ts');
const { Ledger } = await import('./index.ts');
const { engineDirOf, mirrorSnapshot, ENGINE_SIGNATURE } = await import('./code-engine.ts');
const { coverageView } = await import('./views.ts');
const { codeLevels } = await import('../codemap/facts.ts');
type Project = import('../model/types.ts').Project;
type ScopeItem = import('../model/types.ts').ScopeItem;
type LedgerT = import('./index.ts').Ledger;

const ENV = { GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@engine.invalid', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@engine.invalid' };
const repo = join(scratch, 'shop');
mkdirSync(repo);
const git = (args: string[], date = '2026-09-01T10:00:00+00:00') => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel: string, text: string) => { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), text); };
const listing = (dir: string): string => {
  const out: string[] = [];
  const walk = (d: string, rel: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) { if (e.name !== '.git') walk(join(d, e.name), r); } else out.push(`${r} ${statSync(join(d, e.name)).mtimeMs}`); } };
  walk(dir, '');
  return out.sort().join('\n');
};

git(['init', '-q', '-b', 'main']);
write('lib/store.dart', 'class Store {\n  String read(String key) => key;\n}\n');
write('lib/barrel.dart', "export 'store.dart';\n");
write('lib/shape.dart', 'abstract class Shape {\n  double area();\n}\n\nclass Square implements Shape {\n  @override\n  double area() => 1;\n}\n');
write('lib/app.dart', "import 'package:flutter/material.dart';\nimport 'barrel.dart';\nimport 'shape.dart';\n\npart 'app_part.dart';\n\nclass App {\n  String go() {\n    final store = Store();\n    return store.read('x');\n  }\n\n  double size(Shape s) => s.area();\n}\n");
write('lib/app_part.dart', "part of 'app.dart';\n\nclass AppPart {}\n");
write('lib/orphan.dart', 'class Orphan {}\n');
write('lib/user.dart', 'class User {}\n');
write('pkg/__init__.py', '');
write('pkg/util.py', 'def util():\n    return 1\n');
write('pkg/rel.py', 'from .util import util\n\n\ndef twice():\n    return util() * 2\n');
write('run.py', 'import os\nfrom pkg.util import util\n\nprint(util(), os.sep)\n');
write('src/x.ts', 'export const x = 1;\n');
write('src/index.ts', "import { x } from './x.ts';\nexport const y = x + 1;\n");
write('README.md', '# Shop\n');
write('.gitignore', 'build/\n');
git(['add', '-A']);
git(['commit', '-q', '-m', 'Start']);
write('lib/user.dart', "import 'store.dart';\n\nclass User {\n  final store = Store();\n}\n");
git(['add', '-A']);
git(['commit', '-q', '-m', 'User keeps a store'], '2026-09-02T10:00:00+00:00');
const userCommit = git(['rev-parse', 'HEAD']).trim();

const item = (id: string, path: string): ScopeItem => ({ id, path, category: 'Repository', relation: 'Main project', reason: 'engine test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' }) as ScopeItem;
const project = { id: 'engine-test', name: 'Shop', locations: [repo], scope: [item('shop', repo)], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: '2026-09-01T00:00:00Z', lastOpenedAt: null, lastScopedAt: null } as unknown as Project;
const file = ledgerPath(project.id, join(scratch, 'home'));
const before = listing(repo);
const statusBefore = git(['status', '--porcelain', '--ignored']);
const first = rebuildLedgerInPlace(file, project, {});
let L: LedgerT | null = Ledger.openPath(file)!;
const page = <T>(r: T | string): T => { if (typeof r === 'string') throw new Error(r); return r; };

test('nothing is written into the project: the snapshot and the index live next to the ledger', () => {
  assert.equal(listing(repo), before, 'the checkout has exactly the files it had');
  assert.equal(git(['status', '--porcelain', '--ignored']), statusBefore);
  assert.ok(!existsSync(join(repo, '.codegraph')));
  const dir = engineDirOf(engineRootOf(file), 'shop');
  assert.ok(existsSync(join(dir, 'tree', '.codegraph', 'codegraph.db')), 'the index is in the project\'s own ProjectKeeper folder');
  assert.ok(existsSync(join(dir, 'tree', 'lib', 'store.dart')) && existsSync(join(dir, 'tree', 'run.py')));
  assert.ok(!existsSync(join(dir, 'tree', 'src', 'x.ts')), 'TypeScript is the compiler\'s: not in the snapshot');
  assert.ok(!existsSync(join(dir, 'tree', '.gitignore')), 'an ignore file would only drop tracked files again');
  const engine = first.repos[0]!.code.engine!;
  assert.equal(engine.ran, 'full');
  assert.ok(engine.ok, engine.error ?? '');
  assert.ok(engine.indexBytes > 0 && engine.snapshot.files >= 9);
});

test('dependencies: TypeScript through the compiler, every other language from what the engine resolved; unresolved imports are external', () => {
  const rows = L!.db.prepare("SELECT src, dst, kind, external FROM code_deps WHERE repo = 'shop'").all() as { src: string; dst: string; kind: string; external: number }[];
  const has = (src: string, dst: string, external = 0) => rows.some((r) => r.src === src && r.dst === dst && r.external === external);
  assert.ok(has('src/index.ts', 'src/x.ts'), 'the compiler');
  assert.ok(has('lib/app.dart', 'lib/barrel.dart') && has('lib/app.dart', 'lib/shape.dart'), 'Dart imports');
  assert.ok(has('lib/barrel.dart', 'lib/store.dart'), 'a Dart export is a dependency');
  assert.ok(has('lib/app.dart', 'package:flutter/material.dart', 1), 'a package the repository does not hold is external');
  assert.ok(has('run.py', 'pkg/util.py'), 'a Python import of the package\'s module');
  assert.ok(has('pkg/rel.py', '.util', 1) && !has('pkg/rel.py', 'pkg/util.py'), 'a relative Python import the engine only matches by name: unresolved, so external (the coverage counts it)');
  const readers = Object.fromEntries((L!.db.prepare("SELECT path, reader FROM code_files WHERE repo = 'shop'").all() as { path: string; reader: string | null }[]).map((r) => [r.path, r.reader]));
  assert.deepEqual([readers['src/index.ts'], readers['lib/app.dart'], readers['run.py'], readers['README.md']], ['compiler', 'engine', 'engine', null]);
});

test('unreferenced, and where a reader missed a reference: a file another file names', () => {
  const un = page(L!.unreferenced({ repo: 'shop' })).rows;
  const orphan = un.find((r) => r.path === 'lib/orphan.dart');
  assert.ok(orphan && !('namedBy' in orphan), 'nothing references or names the orphan');
  const part = un.find((r) => r.path === 'lib/app_part.dart');
  assert.ok(part, 'the engine does not follow part directives');
  assert.deepEqual((part as { namedBy?: string[] }).namedBy, ['lib/app.dart'], 'but the file that includes it names it');
  assert.ok(!un.some((r) => r.path === 'lib/store.dart' || r.path === 'pkg/util.py' || r.path === 'src/x.ts'), JSON.stringify(un.map((r) => r.path)));
  const refs = page(L!.fileRefs('lib/app_part.dart', { repo: 'shop' }));
  assert.deepEqual(refs.namedBy, ['lib/app.dart']);
  assert.match(refs.level, /code engine/);
  // A residual judgement stands on computed references only where nothing went unresolved (CKC-25 AC-5).
  assert.deepEqual(L!.referenceReach('shop', ['lib/orphan.dart']), { complete: true, languages: ['dart'], gaps: [] });
  const lib = L!.referenceReach('shop', ['lib']);
  assert.equal(lib.complete, false);
  assert.match(lib.gaps.join(' '), /lib\/app_part\.dart \(named in lib\/app\.dart\)/);
  assert.equal(L!.referenceReach('shop', ['src']).complete, true, 'TypeScript, through the compiler');
  assert.match(L!.referenceReach('shop', ['README.md']).gaps[0]!, /no code/);
});

test('symbols in every language: the engine for Dart, each hit with its method and whether it counts; the language service for TypeScript', () => {
  const store = page(L!.symbol('references', { file: 'lib/store.dart', name: 'Store' }, { repo: 'shop' }));
  assert.match(store.answeredBy, /code engine/);
  const hits = store.locations ?? [];
  const fromApp = hits.find((h) => h.file === 'lib/app.dart');
  assert.ok(fromApp, JSON.stringify(hits));
  assert.equal((fromApp as { counted?: boolean }).counted, true);
  assert.ok('how' in fromApp && 'confidence' in fromApp);
  const impl = page(L!.symbol('implementations', { file: 'lib/shape.dart', name: 'Shape' }, { repo: 'shop' }));
  assert.deepEqual((impl.locations ?? []).map((h) => (h as { from?: string }).from), ['class Square']);
  const read = page(L!.symbol('callers', { file: 'lib/store.dart', name: 'Store.read' }, { repo: 'shop' }));
  assert.ok(((read as { incoming?: { file: string }[] }).incoming ?? []).some((c) => c.file === 'lib/app.dart'), 'a method by its container\'s name');
  const ts = page(L!.symbol('references', { file: 'src/x.ts', name: 'x' }, { repo: 'shop' }));
  assert.equal(ts.answeredBy, 'the TypeScript language service');
  assert.ok((ts.locations ?? []).some((l) => l.file === 'src/index.ts' && (l as { how?: string }).how === 'compiler'));
  const none = L!.symbol('references', { file: 'README.md', name: 'Shop' }, { repo: 'shop' });
  assert.equal(typeof none, 'string');
  assert.match(none as string, /does not read/, 'no reader, said');
});

test('history through the engine: since when a Dart file references another, the target matched by its stem', () => {
  const h = page(L!.refHistory('lib/user.dart', 'store.dart', { repo: 'shop' }));
  assert.match(h.readBy, /code engine/);
  assert.equal(h.firstOnTrunk, `commit:${userCommit.slice(0, 12)}`);
  assert.deepEqual(h.changes.map((c) => c.references), [false, true]);
  assert.equal(h.referencesNow, true);
});

test('coverage: each language\'s reach, measured', () => {
  const langs = L!.coverage().languages;
  const dart = langs.find((l) => l.language === 'dart')!;
  assert.match(dart.readBy ?? '', /code engine/);
  assert.equal(dart.referenceLevel, 'file', 'a reference went unresolved (the part), so a residual judgement there is Inferred');
  assert.ok((dart.reach?.imports.resolved ?? 0) >= 4 && (dart.reach?.imports.unresolved ?? 0) >= 1);
  assert.ok(Object.keys(dart.reach?.counted ?? {}).length > 0);
  const python = langs.find((l) => l.language === 'python')!;
  assert.equal(python.reach?.imports.unresolvedNamingRepoFiles, 1, 'the relative import names pkg/util.py by its stem');
  assert.equal(python.referenceLevel, 'file');
  assert.equal(langs.find((l) => l.language === 'typescript')?.referenceLevel, 'symbol');
  assert.equal(langs.find((l) => l.language === 'markdown')?.referenceLevel, 'file tree');
  // Project scope says of each language of the code what `Code` says (codemap codeLevels); prose and data are no code.
  const scope = coverageView(L!).languages;
  assert.deepEqual(scope.find((l) => l.language === 'dart'), { language: 'dart', level: 'file', files: dart.files, code: codeLevels(langs).find((l) => l.language === 'dart') });
  assert.equal(scope.find((l) => l.language === 'dart')?.code?.readBy, 'engine');
  assert.equal(scope.find((l) => l.language === 'markdown')?.code, undefined, 'prose is no code');
  assert.equal(L!.coverage().codeEngine.runs[0]?.lastRun?.ok, true);
});

test('incremental: nothing new reads nothing; one changed and one removed file are all the snapshot writes, and the index syncs', () => {
  L!.close();
  L = null;
  const again = rebuildLedgerInPlace(file, project, {});
  assert.equal(again.repos[0]!.code.skipped, true);
  write('lib/orphan.dart', 'class Orphan {\n  int n = 0;\n}\n');
  git(['rm', '-q', 'pkg/util.py']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Orphan grows; util goes'], '2026-09-03T10:00:00+00:00');
  const next = rebuildLedgerInPlace(file, project, {});
  const engine = next.repos[0]!.code.engine!;
  assert.equal(engine.ran, 'sync');
  assert.deepEqual([engine.snapshot.written, engine.snapshot.removed], [1, 1]);
  const dir = engineDirOf(engineRootOf(file), 'shop');
  assert.ok(!existsSync(join(dir, 'tree', 'pkg', 'util.py')), 'the removed file left the snapshot');
  L = Ledger.openPath(file)!;
  const rows = L.db.prepare("SELECT dst, external FROM code_deps WHERE repo = 'shop' AND src = 'run.py'").all() as { dst: string; external: number }[];
  assert.ok(rows.some((r) => r.dst === 'pkg.util' && r.external === 1), `the import of the removed module is unresolved now: ${JSON.stringify(rows)}`);
  assert.ok(!rows.some((r) => r.external === 0));
});

test('a repository that leaves the scope takes its snapshot with it', () => {
  L!.close();
  L = null;
  const dir = engineDirOf(engineRootOf(file), 'shop');
  assert.ok(existsSync(dir));
  const other = join(scratch, 'empty');
  mkdirSync(other);
  execFileSync('git', ['-C', other, 'init', '-q', '-b', 'main']);
  rebuildLedgerInPlace(file, { ...project, scope: [item('empty', other)] } as unknown as Project, {});
  assert.ok(!existsSync(dir));
  L = Ledger.openPath(file)!;
});

test('the snapshot mirror writes only what changed, deletes what left, and starts over on a folder it did not make', () => {
  const dir = join(scratch, 'mirror');
  const f = (path: string, text: string) => ({ path, key: text, content: Buffer.from(text) });
  assert.deepEqual(mirrorSnapshot(dir, [f('a/b.dart', '1'), f('c.py', '2')]), { files: 2, written: 2, removed: 0, failed: [] });
  assert.deepEqual(mirrorSnapshot(dir, [f('a/b.dart', '1'), f('c.py', '2')]), { files: 2, written: 0, removed: 0, failed: [] });
  assert.deepEqual(mirrorSnapshot(dir, [f('c.py', '3')]), { files: 1, written: 1, removed: 1, failed: [] });
  assert.ok(!existsSync(join(dir, 'tree', 'a')), 'an emptied directory goes too');
  assert.equal(readFileSync(join(dir, 'tree', 'c.py'), 'utf8'), '3');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ engine: 'another engine', files: { 'c.py': '3' } }));
  writeFileSync(join(dir, 'tree', 'stray.txt'), 'x');
  assert.equal(mirrorSnapshot(dir, [f('c.py', '3')]).written, 1, 'a manifest of another engine: every file written again');
  assert.ok(!existsSync(join(dir, 'tree', 'stray.txt')));
  assert.equal(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).engine, ENGINE_SIGNATURE);
});
