/**
 * Code structure of the version the checkout has (Spec §1.16 row 7, §1.19; CKC-22 AC-8; D98, R-61): the file tree with
 * sizes, what is generated (and how that was recognised), what the scope classifies as third-party or other non-product
 * material, the dependencies between files, test files and their test cases, the last change of every file and directory,
 * and which directories each merge changed.
 *
 * Who reads the references between files (`code_files.reader`; the coverage gives what each reached, measured):
 * - TypeScript / JavaScript: the TypeScript compiler. File level through its own pre-parser (`preProcessFile`: imports,
 *   `import()`, triple-slash references), relative specifiers resolved to the repository's files (`.js` → `.ts` as
 *   TypeScript's NodeNext resolution does, `/index`); symbol level on demand (ts-symbols.ts). Exact there, so it stays.
 * - Every other language the code engine reads (code-engine.ts): on a snapshot of this version, the references it resolved
 *   — through an import, a path, a qualified name, a function reference or an instance method, never by a name alone — are
 *   the file dependencies, with their kind (import, calls, references …); its unresolved imports are the external ones;
 *   symbols on demand. No code here for any particular language. A file the engine only tracks (no symbol, no import:
 *   YAML, a manifest) has no reader.
 * - Anything else: the file tree and sizes only.
 * Who names a code file no counted reference reaches (`named_by`, `NamingKind`), read from every tracked text file: a
 * build or manifest file (a C++ source its CMakeLists.txt compiles, the activity AndroidManifest.xml launches) makes it a
 * named entry point; code makes it a reference no reader resolved (an include directive the engine does not follow, a
 * worker started by its URL). Either way that nothing references it is no computed fact (Ledger.referenceReach). Any other
 * text — a document, data, a test's fixture — only mentions it.
 * Generated: file names (`*.g.dart`, `*.freezed.dart`, `*.pb.*`, lock files, minified files, source maps), build and
 * output directories, and a generated-code header in the first 2 KB. Third-party: the scope's classification of the
 * location, else a directory named `third_party`, `vendor` or the like.
 */
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { preProcessFile } from 'typescript';
import { isSkippedName } from '../scope/skip.ts';
import { catBlobs, isText, revList, treeFiles } from './git-read.ts';
import { getState, setState, tx } from './schema.ts';
import type { RepoHandle } from './repo-scan.ts';
import {
  ENGINE_SIGNATURE, contentKey, dropEngineDir, engineDirOf, engineIndexExists, engineLanguage, engineUnavailable, indexSnapshot, mirrorSnapshot,
  readEngineIndex, snapshotSkips, type EngineLanguageReach, type EngineRun, type MirrorStats, type SnapshotFile,
} from './code-engine.ts';

export type Lang = 'typescript' | 'javascript' | 'dart' | 'python' | 'java' | 'kotlin' | 'swift' | 'go' | 'rust' | 'csharp' | 'c' | 'cpp' | 'css' | 'html' | 'json' | 'yaml' | 'shell' | 'sql' | 'xml' | 'markdown' | 'text' | 'other';

export const LANG_BY_EXT: Record<string, Lang> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.dart': 'dart', '.py': 'python', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.swift': 'swift', '.go': 'go',
  '.rs': 'rust', '.cs': 'csharp', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.m': 'c', '.mm': 'cpp',
  '.css': 'css', '.scss': 'css', '.html': 'html', '.htm': 'html', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  '.sh': 'shell', '.ps1': 'shell', '.bat': 'shell', '.cmd': 'shell', '.sql': 'sql', '.xml': 'xml', '.gradle': 'other',
  '.md': 'markdown', '.markdown': 'markdown', '.txt': 'text',
};
export const langOf = (path: string): Lang | null => {
  const m = /\.[^./\\]+$/.exec(path);
  return m ? LANG_BY_EXT[m[0].toLowerCase()] ?? 'other' : null;
};
/** A file whose references the TypeScript compiler reads: TypeScript and JavaScript, by extension. */
export const compilerReads = (path: string): boolean => { const l = langOf(path); return l === 'typescript' || l === 'javascript'; };
/** Prose and data: they reference nothing a residual judgement rests on (the ledger's own kinds, by extension). */
export const NOT_CODE: ReadonlySet<string> = new Set<Lang>(['markdown', 'text', 'json', 'yaml', 'xml', 'other']);

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.bmp', '.svgz', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.jar', '.aar', '.apk', '.aab', '.so', '.dll', '.exe', '.dylib', '.bin', '.dat', '.db', '.sqlite', '.mp4', '.mov', '.mp3', '.wav', '.ogg', '.pdf', '.class', '.keystore', '.jks', '.pyc', '.wasm']);
const extOf = (p: string) => /\.[^./\\]+$/.exec(p)?.[0]?.toLowerCase() ?? '';

const GENERATED_NAME: readonly { re: RegExp; how: string }[] = [
  { re: /\.(g|freezed|gr|mocks|config|pb|pbenum|pbjson|pbserver|grpc|generated|gen)\.(dart|go|ts|js|py|java|kt|swift|cs)$/i, how: 'file name (*.g.dart, *.freezed.dart, *.pb.*, *.generated.* …)' },
  { re: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pubspec\.lock|yarn\.lock|pnpm-lock\.yaml|Gemfile\.lock|Podfile\.lock|composer\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/i, how: 'lock file' },
  { re: /\.min\.(js|css)$|\.map$/i, how: 'minified file or source map' },
  { re: /\.designer\.(cs|vb)$|(^|\/)GeneratedPluginRegistrant\.\w+$|(^|\/)generated_plugin_registrant\.\w+$|(^|\/)generated_plugins\.cmake$/i, how: 'tool-written file' },
];
const GENERATED_DIR = /(^|\/)(build|dist|out|coverage|\.dart_tool|\.pub-cache|\.next|\.nuxt|__generated__|generated)(\/)/i;
const GENERATED_HEAD = /(GENERATED CODE|code generated by|auto-?generated|automatically generated|do not (?:edit|modify)(?: by hand)?|generated by (?:the )?[\w -]+ tool)/i;
const THIRD_PARTY_DIR = /(^|\/)(third[_-]party|thirdparty|vendor|vendored|external|extern)(\/)/i;

export interface GeneratedInfo { readonly generated: boolean; readonly how: string | null }
export function generatedOf(path: string, head: string | null): GeneratedInfo {
  for (const { re, how } of GENERATED_NAME) if (re.test(path)) return { generated: true, how: `name: ${how}` };
  const dir = GENERATED_DIR.exec(path);
  if (dir) return { generated: true, how: `directory: ${dir[2]}/` };
  const h = head !== null ? GENERATED_HEAD.exec(head) : null;
  if (h) return { generated: true, how: `header: "${h[0]}"` };
  return { generated: false, how: null };
}

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|integration_test|test_driver|testing)(\/)|\.(test|spec)\.[a-z]+$|_test\.(dart|go|py)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|swift|cs)$/i;
export const isTestPath = (path: string): boolean => TEST_PATH.test(path);

/** Test cases a test file declares: `test(`, `it(`, `testWidgets(` …, `def test_`, `func Test`, `@Test`. */
export function testCases(lang: Lang | null, text: string): number {
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  if (lang === 'typescript' || lang === 'javascript') return count(/(?<![\w.])(?:test|it)(?:\.(?:only|skip|todo|concurrent))?\s*\(\s*['"`]/g);
  if (lang === 'dart') return count(/(?<![\w.])(?:test|testWidgets|testGoldens|patrolTest|blocTest)\s*(?:<[^>]*>)?\s*\(\s*['"r]/g);
  if (lang === 'python') return count(/^\s*(?:async\s+)?def\s+test_\w+/gm);
  if (lang === 'go') return count(/^func\s+Test\w+\s*\(/gm);
  if (lang === 'java' || lang === 'kotlin' || lang === 'csharp') return count(/@Test\b|\[(?:Test|Fact|Theory)\]/g);
  if (lang === 'swift') return count(/func\s+test\w+\s*\(/g);
  return 0;
}

// ───────────────────────── dependencies ─────────────────────────

export interface Dep { readonly dst: string; readonly kind: string; readonly external: boolean }

const posixDir = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const dirOf = posixDir;
const posixJoin = (dir: string, rel: string): string => {
  const out: string[] = [];
  for (const p of [...(dir ? dir.split('/') : []), ...rel.split('/')]) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
};

/** TypeScript / JavaScript imports and triple-slash references, through the compiler's own pre-parser. */
export function tsDeps(path: string, content: string, tracked: ReadonlySet<string>): Dep[] {
  const pre = preProcessFile(content, true, true);
  const specs = [...pre.importedFiles.map((m) => ({ s: m.fileName, kind: 'import' })), ...pre.referencedFiles.map((r) => ({ s: r.fileName, kind: 'reference' }))];
  const out: Dep[] = [];
  const seen = new Set<string>();
  const dir = posixDir(path);
  for (const { s, kind } of specs) {
    const key = `${kind}:${s}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!s.startsWith('.') && kind === 'import') { out.push({ dst: s, kind, external: true }); continue; }
    const base = posixJoin(dir, s);
    const swapped = base.replace(/\.(js|jsx|mjs|cjs)$/, (m) => ({ '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' })[m] ?? m);
    const hit = [base, swapped, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`].find((c) => tracked.has(c));
    out.push(hit ? { dst: hit, kind, external: false } : { dst: base, kind, external: true });
  }
  return out;
}

/** Dependencies of one file as the TypeScript path reads them; every other language is read by the code engine. */
export function depsOf(lang: Lang | null, path: string, content: string, tracked: ReadonlySet<string>): Dep[] {
  return lang === 'typescript' || lang === 'javascript' ? tsDeps(path, content, tracked) : [];
}

// ───────────────────────── who reads what ─────────────────────────

export type Reader = 'compiler' | 'engine';

/** What one language's references reached in one repository, measured when the code was read (the coverage shows it). */
export interface LanguageReach {
  readonly language: string;
  readonly reader: Reader;
  /** Files whose references it read. */
  readonly files: number;
  /** Import specifiers resolved to a file of the repository, and not (packages, SDKs — and, for the engine, any it missed). */
  readonly imports: { readonly resolved: number; readonly unresolved: number; readonly unresolvedNamingRepoFiles?: number; readonly sample?: readonly string[] };
  /** The engine: references between files by resolution method, counted and matched by a name only (not counted). */
  readonly counted?: Readonly<Record<string, number>>;
  readonly nameOnly?: Readonly<Record<string, number>>;
  /** The engine: files it only tracks (no symbol, no import), and files it could not parse. */
  readonly trackedOnly?: number;
  readonly parseErrors?: number;
  /** Product files no counted reference reaches that code names — where references went unresolved (`NamingKind` reference). */
  readonly namedButUnreferenced: number;
  readonly namedSample: readonly string[];
  /**
   * Product files no counted reference reaches that a build or manifest file names: named entry points (`NamingKind`
   * entry). They say where the code is entered, not how deep it is read. Absent from a reach recorded before build and
   * manifest files were read.
   */
  readonly namedEntryPoints?: number;
  readonly entrySample?: readonly string[];
}
export interface CodeReach {
  readonly engine: { readonly signature: string; readonly unavailable: string | null };
  /** The engine's last run on this repository, and its snapshot; null when it had no file to read. */
  readonly run: EngineRun | null;
  readonly snapshot: MirrorStats | null;
  /** Why the engine's references are missing, when they are. */
  readonly error: string | null;
  readonly languages: readonly LanguageReach[];
}
/** The reach the last read of the code recorded for a repository (or a directory outside version control). */
export function reachOf(db: DatabaseSync, id: string): CodeReach | null {
  try { const v = getState(db, `codeReach:${id}`); return v ? JSON.parse(v) as CodeReach : null; } catch { return null; }
}

// ───────────────────────── who names a file no counted reference reaches ─────────────────────────

/**
 * How another file names a product code file no counted reference reaches (`code_files.named_by`):
 * - `entry`: a build or manifest file names it — a named entry point, compiled, launched, loaded or run by what reads that
 *   file (a C++ source its CMakeLists.txt compiles, the activity AndroidManifest.xml launches);
 * - `reference`: code names it — a reference no reader resolved (an include directive the engine does not follow, a
 *   worker started by its URL, a script nothing reads that runs it);
 * - `mention`: any other text names it — a document, data, a test's fixture: it is said there, and nothing is referenced.
 * The first two make "nothing references it" no computed fact (Ledger.referenceReach); a mention does not.
 */
export type NamingKind = 'entry' | 'reference' | 'mention';
export interface Naming { readonly path: string; readonly kind: NamingKind }
const NAMING_KINDS: readonly NamingKind[] = ['entry', 'reference', 'mention'];

/**
 * Build and manifest files, by name: what a build, a package manager, a platform or a runner reads to know what to compile,
 * launch, load or run. The same table for every project; nothing in it parses a language.
 */
const BUILD_FILES: readonly RegExp[] = [
  // Android and the JVM: the manifest, Gradle, Maven, Ant.
  /(^|\/)AndroidManifest\.xml$/, /(^|\/)(build|settings)\.gradle(\.kts)?$/, /(^|\/)(pom|build|ivy)\.xml$/,
  // C and C++: CMake, Make, Meson, Bazel, GN, GYP, SCons, autotools; Windows resource scripts and application manifests.
  /(^|\/)CMakeLists\.txt$/, /\.cmake$/i, /(^|\/)(GNUmakefile|[Mm]akefile)$/, /\.(mk|mak)$/i, /(^|\/)meson\.build$/,
  /(^|\/)(BUILD|WORKSPACE|MODULE)(\.bazel)?$/, /\.(bzl|gn|gni|gyp|gypi)$/i, /(^|\/)(SConstruct|SConscript|configure\.ac|Makefile\.am)$/, /\.(rc|manifest)$/i,
  // Apple: Xcode projects, schemes and build settings, property lists, entitlements, storyboards, CocoaPods.
  /\.(pbxproj|xcscheme|xcconfig|plist|entitlements|storyboard|xib)$/i, /(^|\/)Podfile$/, /\.podspec$/i,
  // .NET and MSBuild.
  /\.(csproj|vbproj|fsproj|vcxproj|sln|props|targets)$/i,
  // Package manifests: JavaScript, Dart and Flutter, Python, Rust, Go, Ruby, PHP.
  /(^|\/)(package\.json|deno\.jsonc?|pubspec\.yaml|pyproject\.toml|setup\.cfg|Pipfile|Cargo\.toml|go\.mod|Gemfile|Rakefile|composer\.json)$/, /\.gemspec$/i,
  // What runs it: containers, process files, task runners, continuous integration.
  /(^|\/)(Dockerfile|Containerfile|Procfile|Jenkinsfile|Vagrantfile|Taskfile\.ya?ml|[Jj]ustfile)$/, /\.dockerfile$/i, /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/,
  /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/, /(^|\/)\.circleci\/config\.ya?ml$/, /(^|\/)(\.gitlab-ci|azure-pipelines|\.travis|appveyor|bitbucket-pipelines)\.ya?ml$/,
  // Web and platform manifests.
  /(^|\/)(manifest\.json|firebase\.json|vercel\.json|netlify\.toml|app\.json|web\.config)$/, /\.webmanifest$/i,
];
export const isBuildFile = (path: string): boolean => BUILD_FILES.some((re) => re.test(path));

/** A file larger than this is not read for the names in it, unless a reader reads its references. */
export const NAMING_MAX_BYTES = 1_000_000;
/** How the code was read for who names what: a change reads every repository's code again at the next rebuild. */
export const NAMING_RULE = 'named-2';

/** A file's `named_by` as recorded: the files naming it and how, entry points first. A ledger read before build and
 *  manifest files were read recorded code files only, by path. */
export function namingOf(raw: string | null | undefined): Naming[] {
  if (!raw) return [];
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(v)) return [];
  return v.flatMap((x): Naming[] => {
    if (typeof x === 'string') return [{ path: x, kind: 'reference' }];
    const n = x as { path?: unknown; kind?: unknown } | null;
    return n && typeof n.path === 'string' && NAMING_KINDS.includes(n.kind as NamingKind) ? [{ path: n.path, kind: n.kind as NamingKind }] : [];
  });
}
/** What makes it no computed fact that nothing references a file: a build or manifest file, or code, names it. */
export const namingThatCounts = (naming: readonly Naming[]): Naming[] => naming.filter((n) => n.kind !== 'mention');
/** A file name as said for the file naming another: `AndroidManifest.xml`. */
export const fileNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

// ───────────────────────── the scan ─────────────────────────

export interface CodeScanStats {
  readonly head: string | null;
  readonly skipped: boolean;
  readonly files: number;
  readonly lines: number;
  readonly productFiles: number;
  readonly productLines: number;
  readonly generatedFiles: number;
  readonly otherFiles: number;
  readonly testFiles: number;
  readonly testCases: number;
  readonly deps: number;
  readonly depsExternal: number;
  /** The code engine's run at this scan (its time, peak memory and index size), when it had files to read. */
  readonly engine: (EngineRun & { readonly snapshot: MirrorStats }) | null;
}

export interface CodeScanInput {
  /** The scope's classification of the location holding a file (innermost wins), or null. */
  readonly classify?: (absPath: string) => string | null;
  /**
   * Where the code engine keeps this project's snapshots and indexes, a folder ProjectKeeper owns next to the ledger
   * (`<project dir>/code-index`). Absent: the engine is not run and only TypeScript and JavaScript references are read.
   */
  readonly engineRoot?: string | null;
}

const countLines = (buf: Buffer): number => {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n;
};

interface FileFacts {
  path: string; bytes: number; lines: number | null; lang: Lang | null; generated: GeneratedInfo; classification: string | null; test: boolean; cases: number; blob: string | null;
  deps: Dep[]; reader: Reader | null; refLang: string | null; namedBy: Naming[] | null;
}

/**
 * When the files were read (Spec §2.11; CKC-22 AC-10): `now`, the rebuild reading them, is the first reading of a file the
 * ledger had not recorded (one it had keeps its first reading); `fileTimes`, outside version control, each file's own time
 * as read (`File time`).
 */
interface ReadTimes { readonly now: string; readonly fileTimes?: ReadonlyMap<string, string> }

function writeFiles(db: DatabaseSync, repoId: string, files: readonly FileFacts[], last: ReadonlyMap<string, { hash: string; at: string; ms: number }>, read: ReadTimes, reach: CodeReach): void {
  tx(db, () => {
    const firstSeen = new Map((db.prepare('SELECT path, first_seen FROM code_files WHERE repo = ?').all(repoId) as { path: string; first_seen: string | null }[]).map((r) => [r.path, r.first_seen]));
    db.prepare('DELETE FROM code_files WHERE repo = ?').run(repoId);
    db.prepare('DELETE FROM code_deps WHERE repo = ?').run(repoId);
    db.prepare('DELETE FROM dir_stats WHERE repo = ?').run(repoId);
    const insFile = db.prepare('INSERT INTO code_files (repo, path, bytes, lines, lang, generated, generated_how, blob, classification, test, test_cases, last_commit, last_at, file_at, first_seen, reader, ref_lang, named_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insDep = db.prepare('INSERT OR IGNORE INTO code_deps (repo, src, dst, kind, external) VALUES (?, ?, ?, ?, ?)');
    for (const f of files) {
      const l = last.get(f.path);
      insFile.run(repoId, f.path, f.bytes, f.lines, f.lang, f.generated.generated ? 1 : 0, f.generated.how, f.blob, f.classification, f.test ? 1 : 0, f.cases, l?.hash ?? null, l?.at ?? null,
        read.fileTimes?.get(f.path) ?? null, firstSeen.get(f.path) ?? read.now, f.reader, f.refLang, f.namedBy ? JSON.stringify(f.namedBy) : null);
      for (const d of f.deps) insDep.run(repoId, f.path, d.dst, d.kind, d.external ? 1 : 0);
    }
    // Every directory: its whole subtree, split into product code, generated code and other classified material.
    const agg = new Map<string, { files: number; lines: number; pf: number; pl: number; gf: number; gl: number; of: number; ol: number; tests: number; cases: number; last: { hash: string; at: string; ms: number } | null }>();
    for (const f of files) {
      const segs = f.path.split('/');
      for (let i = 0; i < segs.length - 1; i++) {
        const dir = segs.slice(0, i + 1).join('/');
        const a = agg.get(dir) ?? { files: 0, lines: 0, pf: 0, pl: 0, gf: 0, gl: 0, of: 0, ol: 0, tests: 0, cases: 0, last: null };
        const lines = f.lines ?? 0;
        a.files += 1; a.lines += lines;
        if (f.classification) { a.of += 1; a.ol += lines; } else if (f.generated.generated) { a.gf += 1; a.gl += lines; } else { a.pf += 1; a.pl += lines; }
        if (f.test) { a.tests += 1; a.cases += f.cases; }
        const l = last.get(f.path);
        if (l && (!a.last || l.ms > a.last.ms)) a.last = l;
        agg.set(dir, a);
      }
    }
    const insDir = db.prepare('INSERT INTO dir_stats (repo, dir, files, lines, product_files, product_lines, generated_files, generated_lines, other_files, other_lines, tests, test_cases, last_at, last_commit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [dir, a] of agg) insDir.run(repoId, dir, a.files, a.lines, a.pf, a.pl, a.gf, a.gl, a.of, a.ol, a.tests, a.cases, a.last?.at ?? null, a.last?.hash ?? null);
    setState(db, `codeReach:${repoId}`, JSON.stringify(reach));
  });
}

function facts(path: string, bytes: number, buf: Buffer | null, blob: string | null, classification: string | null): FileFacts {
  const lang = langOf(path);
  const text = buf !== null && isText(buf) ? buf : null;
  const head = text ? text.subarray(0, Math.min(text.length, 2048)).toString('utf8') : null;
  const generated = generatedOf(path, head);
  const test = isTestPath(path);
  const content = text ? text.toString('utf8') : null;
  return {
    path, bytes, lines: text ? countLines(text) : null, lang, generated,
    classification: classification ?? (THIRD_PARTY_DIR.test(path) ? 'third-party (directory name)' : null),
    test, cases: test && content ? testCases(lang, content) : 0, blob, deps: [], reader: null, refLang: null, namedBy: null,
  };
}

const baseName = fileNameOf;
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const list = m.get(k); if (list) list.push(v); else m.set(k, [v]); };
const stemOf = (name: string): string | null => (name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : null);

/** A file name as text says it: `utils.cpp`, `MainActivity.kt` (the same token for every language). */
const FILE_NAME = /[\w.-]+\.[A-Za-z0-9]+/g;
/** A dotted name, read as a path: `.MainActivity` (relative), `com.example.app.MainActivity`, `pkg.module`. */
const DOTTED_NAME = /(?<![\w$.])(?:[A-Za-z_$][\w$]*)?(?:\.[A-Za-z_$][\w$]*)+/g;

/** How a file names others: a build or manifest file, code (read by a reader or not), or any other text. */
function namingKindOf(f: FileFacts): NamingKind {
  if (isBuildFile(f.path)) return 'entry';
  return f.reader || (f.lang !== null && !NOT_CODE.has(f.lang)) ? 'reference' : 'mention';
}

/**
 * Who names each product code file no counted reference reaches (`NamingKind`), from every tracked text file: a file name
 * anywhere (`"utils.cpp"` in a CMakeLists.txt, `part 'x.dart'`); in a build or manifest file also a dotted name read as a
 * path, its last part the file's stem and its other parts, when there are any, the directories just above it
 * (`android:name=".MainActivity"`, `com.example.app.MainActivity`, `pkg.module:main`). A file over `NAMING_MAX_BYTES` is
 * read for names only when a reader reads its references. At most five files of each kind are kept, entry points first.
 */
function readNames(files: FileFacts[], texts: ReadonlyMap<string, Buffer>): void {
  const incoming = new Set<string>();
  for (const f of files) for (const d of f.deps) if (!d.external && d.dst !== f.path) incoming.add(d.dst);
  const byName = new Map<string, FileFacts[]>();
  const byStem = new Map<string, FileFacts[]>();
  for (const f of files) {
    if (f.generated.generated || f.classification || f.test || incoming.has(f.path)) continue;
    // Code only: what a reader reads, or a language the ledger knows is code though nothing reads it (as the code map counts).
    if (!f.reader && (f.lang === null || NOT_CODE.has(f.lang))) continue;
    push(byName, baseName(f.path), f);
    const stem = stemOf(baseName(f.path));
    if (stem) push(byStem, stem, f);
  }
  if (!byName.size) return;
  const found = new Map<FileFacts, Map<NamingKind, Set<string>>>();
  const note = (c: FileFacts, kind: NamingKind, by: string) => {
    if (c.path === by) return;
    const kinds = found.get(c) ?? found.set(c, new Map()).get(c)!;
    (kinds.get(kind) ?? kinds.set(kind, new Set()).get(kind)!).add(by);
  };
  for (const f of files) {
    const buf = texts.get(f.path);
    if (!buf || (!f.reader && buf.length > NAMING_MAX_BYTES)) continue;
    const kind = namingKindOf(f);
    const text = buf.toString('utf8');
    for (const m of text.matchAll(FILE_NAME)) for (const c of byName.get(m[0]) ?? []) note(c, kind, f.path);
    if (kind !== 'entry') continue;
    for (const m of text.matchAll(DOTTED_NAME)) {
      const parts = m[0].split('.');
      const within = parts.slice(0, -1).filter(Boolean);
      for (const c of byStem.get(parts[parts.length - 1]!) ?? []) {
        const dirs = c.path.split('/').slice(0, -1);
        if (within.length <= dirs.length && within.every((p, i) => dirs[dirs.length - within.length + i] === p)) note(c, kind, f.path);
      }
    }
  }
  for (const [c, kinds] of found) c.namedBy = NAMING_KINDS.flatMap((kind) => [...(kinds.get(kind) ?? [])].sort().slice(0, 5).map((path) => ({ path, kind })));
}

/**
 * The references of every file of one version (see the module comment): the compiler for TypeScript and JavaScript, the
 * code engine on the snapshot for the rest, and what each reached. `texts` are the files read as text, `keys` what
 * identifies each content (a git blob; outside version control, a content hash).
 */
function readReferences(files: FileFacts[], texts: ReadonlyMap<string, Buffer>, keys: ReadonlyMap<string, string>, engineDir: string | null): CodeReach {
  const tracked = new Set(files.map((f) => f.path));
  for (const f of files) {
    const buf = texts.get(f.path);
    if (!buf || !compilerReads(f.path)) continue;
    f.reader = 'compiler';
    f.refLang = f.lang;
    if (!f.generated.generated) f.deps = tsDeps(f.path, buf.toString('utf8'), tracked);
  }

  // Every other language: the code engine, on a snapshot it indexes (nothing is written into the project).
  const unavailable = engineUnavailable();
  let run: EngineRun | null = null;
  let snapshot: MirrorStats | null = null;
  let error: string | null = null;
  let engineLanguages: ReturnType<typeof engineReachOf> = [];
  if (engineDir && !unavailable) {
    const wanted: SnapshotFile[] = [];
    for (const f of files) {
      const buf = texts.get(f.path);
      if (!buf || compilerReads(f.path) || snapshotSkips(f.path) || engineLanguage(f.path) === null) continue;
      wanted.push({ path: f.path, key: keys.get(f.path) ?? contentKey(buf), content: buf });
    }
    if (wanted.length === 0) dropEngineDir(engineDir);
    else {
      snapshot = mirrorSnapshot(engineDir, wanted);
      run = indexSnapshot(engineDir, snapshot.written + snapshot.removed > 0);
      const read = run.ok ? readEngineIndex(engineDir) : null;
      if (!run.ok) error = `${run.error ?? 'the engine did not finish'}`;
      else if (typeof read === 'string') error = read;
      else if (read) {
        const bySrc = new Map<string, Dep[]>();
        for (const d of read.deps) {
          const list = bySrc.get(d.src);
          const dep = { dst: d.dst, kind: d.kind, external: d.external };
          if (list) list.push(dep); else bySrc.set(d.src, [dep]);
        }
        for (const f of files) {
          const e = read.files.get(f.path);
          if (!e || f.reader) continue;
          f.refLang = e.language;
          f.reader = e.code ? 'engine' : null;
          if (f.reader && !f.generated.generated) f.deps = bySrc.get(f.path) ?? [];
        }
        engineLanguages = engineReachOf(read.languages);
      }
    }
  } else if (!engineDir) error = 'the code engine was not given a place for its snapshot';
  else error = unavailable;

  // Unreferenced but named: no counted reference reaches the file, yet another file names it (NamingKind).
  readNames(files, texts);

  // Per language: the files code names — references its reader did not resolve, how far the reading went — and, apart,
  // the named entry points, which say where the language's code is entered, not how deep it is read.
  const named = new Map<string, number>();
  const namedSample = new Map<string, string[]>();
  const entries = new Map<string, number>();
  const entrySample = new Map<string, string[]>();
  const sample = (m: Map<string, string[]>, lang: string, line: string) => { const s = m.get(lang) ?? []; if (s.length < 5) m.set(lang, [...s, line]); };
  for (const f of files) {
    if (!f.refLang) continue;
    const code = f.namedBy?.find((n) => n.kind === 'reference');
    const entry = f.namedBy?.find((n) => n.kind === 'entry');
    if (code) { bump(named, f.refLang); sample(namedSample, f.refLang, `${f.path} (named in ${code.path})`); }
    if (entry) { bump(entries, f.refLang); sample(entrySample, f.refLang, `${f.path} (named in ${entry.path})`); }
  }
  const namedOf = (language: string) => ({
    namedButUnreferenced: named.get(language) ?? 0, namedSample: namedSample.get(language) ?? [],
    namedEntryPoints: entries.get(language) ?? 0, entrySample: entrySample.get(language) ?? [],
  });
  const languages: LanguageReach[] = [];
  const compilerLangs = new Map<string, FileFacts[]>();
  for (const f of files) if (f.reader === 'compiler') compilerLangs.set(f.refLang!, [...(compilerLangs.get(f.refLang!) ?? []), f]);
  for (const [language, fs] of compilerLangs) {
    const imports = fs.flatMap((f) => f.deps.filter((d) => d.kind === 'import'));
    languages.push({ language, reader: 'compiler', files: fs.length, imports: { resolved: imports.filter((d) => !d.external).length, unresolved: imports.filter((d) => d.external).length }, ...namedOf(language) });
  }
  for (const l of engineLanguages) languages.push({ ...l, ...namedOf(l.language) });
  return { engine: { signature: ENGINE_SIGNATURE, unavailable }, run, snapshot, error, languages: languages.sort((a, b) => b.files - a.files || a.language.localeCompare(b.language)) };
}

function engineReachOf(langs: readonly EngineLanguageReach[]): Omit<LanguageReach, 'namedButUnreferenced' | 'namedSample' | 'namedEntryPoints' | 'entrySample'>[] {
  return langs.map((l) => ({
    language: l.language, reader: 'engine' as const, files: l.files, trackedOnly: l.trackedOnly, parseErrors: l.parseErrors,
    imports: l.imports, counted: l.counted, nameOnly: l.nameOnly,
  }));
}

/** A recorded engine run whose index is gone (the folder removed): the code is read again even if nothing else moved. */
function engineGone(db: DatabaseSync, id: string, engineDir: string | null): boolean {
  const reach = reachOf(db, id);
  return Boolean(engineDir && reach?.snapshot && reach.snapshot.files > 0 && !engineIndexExists(engineDir));
}

/**
 * One repository's code structure at the checkout's HEAD; skipped when HEAD did not move (and nothing is forced). `now` is
 * the rebuild reading it: the first reading of a file the ledger had not recorded.
 */
export function scanCode(db: DatabaseSync, repo: RepoHandle, input: CodeScanInput = {}, opts: { force?: boolean; now?: string } = {}): CodeScanStats {
  const head = (db.prepare('SELECT head FROM repos WHERE id = ?').get(repo.id) as { head: string | null } | undefined)?.head ?? null;
  const stateKey = `code:${repo.id}`;
  const signature = `${head}|${ENGINE_SIGNATURE}|${NAMING_RULE}`;
  const engineDir = input.engineRoot ? engineDirOf(input.engineRoot, repo.id) : null;
  if (!opts.force && head !== null && getState(db, stateKey) === signature && !engineGone(db, repo.id, engineDir)) return { ...codeTotals(db, repo.id), head, skipped: true, engine: null };
  const tree = head ? treeFiles(repo.path, head) : [];
  const readable = tree.filter((f) => !f.submodule && !BINARY_EXT.has(extOf(f.path)) && f.size !== null && f.size <= 4_000_000);
  const contents = catBlobs(repo.path, readable.map((f) => f.blob));
  const texts = new Map<string, Buffer>();
  const keys = new Map<string, string>();
  const files: FileFacts[] = tree.map((f) => {
    const buf = contents.get(f.blob) ?? null;
    const ff = facts(f.path, f.size ?? 0, buf, f.blob, input.classify?.(join(repo.path, ...f.path.split('/'))) ?? null);
    if (buf && ff.lines !== null) { texts.set(f.path, buf); keys.set(f.path, f.blob); }
    return ff;
  });
  const reach = readReferences(files, texts, keys, engineDir);
  // The last change of each file: the newest commit in HEAD's history whose first-parent change touched it.
  const ancestry = new Set(head ? revList(repo.path, [head]) ?? [] : []);
  const last = new Map<string, { hash: string; at: string; ms: number }>();
  const tracked = new Set(tree.map((f) => f.path));
  for (const r of db.prepare('SELECT cf.path, cf.hash, c.author_at, c.author_ms FROM commit_files cf JOIN commits c ON c.repo = cf.repo AND c.hash = cf.hash WHERE cf.repo = ?').all(repo.id) as { path: string; hash: string; author_at: string; author_ms: number }[]) {
    if (!tracked.has(r.path) || !ancestry.has(r.hash)) continue;
    const cur = last.get(r.path);
    if (!cur || r.author_ms > cur.ms) last.set(r.path, { hash: r.hash, at: r.author_at, ms: r.author_ms });
  }
  writeFiles(db, repo.id, files, last, { now: opts.now ?? new Date().toISOString() }, reach);
  // Merges: which directories each merge changed, against its first parent.
  tx(db, () => {
    db.prepare('DELETE FROM merge_dirs WHERE repo = ?').run(repo.id);
    const ins = db.prepare('INSERT OR REPLACE INTO merge_dirs (repo, commit_hash, at, on_trunk, dirs) VALUES (?, ?, ?, ?, ?)');
    const byMerge = new Map<string, Map<string, number>>();
    for (const r of db.prepare('SELECT cf.hash, cf.path FROM commit_files cf JOIN commits c ON c.repo = cf.repo AND c.hash = cf.hash WHERE cf.repo = ? AND c.merge = 1').all(repo.id) as { hash: string; path: string }[]) {
      const m = byMerge.get(r.hash) ?? new Map<string, number>();
      const d = posixDir(r.path) || '.';
      m.set(d, (m.get(d) ?? 0) + 1);
      byMerge.set(r.hash, m);
    }
    for (const m of db.prepare('SELECT hash, author_at, on_trunk FROM commits WHERE repo = ? AND merge = 1').all(repo.id) as { hash: string; author_at: string; on_trunk: number }[]) {
      ins.run(repo.id, m.hash, m.author_at, m.on_trunk, JSON.stringify([...(byMerge.get(m.hash) ?? new Map()).entries()].sort((a, b) => a[0].localeCompare(b[0]))));
    }
  });
  if (head) setState(db, stateKey, signature);
  return { ...codeTotals(db, repo.id), head, skipped: false, engine: reach.run && reach.snapshot ? { ...reach.run, snapshot: reach.snapshot } : null };
}

function codeTotals(db: DatabaseSync, repo: string): Omit<CodeScanStats, 'head' | 'skipped' | 'engine'> {
  const t = db.prepare(`SELECT count(*) f, ifnull(sum(lines), 0) l,
    ifnull(sum(CASE WHEN classification IS NULL AND generated = 0 THEN 1 ELSE 0 END), 0) pf,
    ifnull(sum(CASE WHEN classification IS NULL AND generated = 0 THEN ifnull(lines, 0) ELSE 0 END), 0) pl,
    ifnull(sum(CASE WHEN classification IS NULL AND generated = 1 THEN 1 ELSE 0 END), 0) gf,
    ifnull(sum(CASE WHEN classification IS NOT NULL THEN 1 ELSE 0 END), 0) otf,
    ifnull(sum(test), 0) t, ifnull(sum(test_cases), 0) tc FROM code_files WHERE repo = ?`).get(repo) as Record<string, number>;
  const d = db.prepare('SELECT ifnull(sum(external = 0), 0) i, ifnull(sum(external = 1), 0) e FROM code_deps WHERE repo = ?').get(repo) as { i: number; e: number };
  return { files: t.f!, lines: t.l!, productFiles: t.pf!, productLines: t.pl!, generatedFiles: t.gf!, otherFiles: t.otf!, testFiles: t.t!, testCases: t.tc!, deps: d.i, depsExternal: d.e };
}

/**
 * A directory outside version control: its files on disk (the scope's skip names apply; other scope items are left to
 * themselves), each with its own time as read (Spec §2.11: `File time`) and the rebuild that first read it (`now`). Its
 * code gets the same snapshot for the engine as a repository's, keyed by content.
 */
export function scanLooseCode(db: DatabaseSync, itemId: string, root: string, skip: (abs: string) => boolean, input: CodeScanInput = {}, force = false, now: string = new Date().toISOString()): CodeScanStats {
  const found: { abs: string; rel: string; size: number; mtimeMs: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 20) return;
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (!isSkippedName(e.name) && e.name !== '.git' && !skip(full)) walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      try { const st = statSync(full); found.push({ abs: full, rel: full.slice(root.length + 1).split('\\').join('/'), size: st.size, mtimeMs: st.mtimeMs }); } catch { continue; }
    }
  };
  walk(root, 0);
  const engineDir = input.engineRoot ? engineDirOf(input.engineRoot, itemId) : null;
  // Nothing on disk moved since the last read: the recorded structure stands.
  const signature = `${found.length}:${found.reduce((n, f) => n + f.size, 0)}:${Math.round(found.reduce((m, f) => Math.max(m, f.mtimeMs), 0))}|${ENGINE_SIGNATURE}|${NAMING_RULE}`;
  if (!force && getState(db, `loosecode:${itemId}`) === signature && !engineGone(db, itemId, engineDir)) return { ...codeTotals(db, itemId), head: null, skipped: true, engine: null };
  const bufs = new Map<string, Buffer | null>();
  for (const f of found) {
    if (BINARY_EXT.has(extOf(f.rel)) || f.size > 4_000_000) { bufs.set(f.rel, null); continue; }
    try { bufs.set(f.rel, readFileSync(f.abs)); } catch { bufs.set(f.rel, null); }
  }
  const texts = new Map<string, Buffer>();
  const files = found.map((f) => {
    const buf = bufs.get(f.rel) ?? null;
    const ff = facts(f.rel, f.size, buf, null, input.classify?.(f.abs) ?? null);
    if (buf && ff.lines !== null) texts.set(f.rel, buf);
    return ff;
  });
  const reach = readReferences(files, texts, new Map(), engineDir);
  // A file time the system cannot give (none, or the epoch) is no time: such a file is dated by its first reading.
  writeFiles(db, itemId, files, new Map(), { now, fileTimes: new Map(found.filter((f) => Number.isFinite(f.mtimeMs) && f.mtimeMs > 0).map((f) => [f.rel, new Date(f.mtimeMs).toISOString()])) }, reach);
  setState(db, `loosecode:${itemId}`, signature);
  return { ...codeTotals(db, itemId), head: null, skipped: false, engine: reach.run && reach.snapshot ? { ...reach.run, snapshot: reach.snapshot } : null };
}
