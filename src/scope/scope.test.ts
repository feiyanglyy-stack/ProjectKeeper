/**
 * What the project scope includes and what is read from it (Spec §1.1, §1.2, §1.15, §6.7; CKC-04 AC-1, AC-3, AC-11,
 * AC-13–AC-17; CKC-02 AC-25). The fixtures are real git repositories built in a temporary directory for an invented
 * project, "Ledger", a small invoicing tool:
 *
 * - a worktree whose branch is merged into the trunk, holding files the same as the trunk, an older version the trunk has
 *   since moved past, and uncommitted changes; a merged worktree with nothing uncommitted; and a worktree whose branch
 *   has a commit the trunk does not have;
 * - directories and files the project's `.gitignore` leaves out, one of them holding notes;
 * - a vendored library with its own upstream repository and license, and a build output directory nobody ignored.
 *
 * Every test runs on the code before this batch first and fails there for the reason it names. The machine's own git
 * configuration and home are kept out: the tests point git at an empty global configuration and the home at a
 * temporary directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from '../util/tmp.test-helpers.ts';
import { dirname, join, relative } from 'node:path';
import { discoverScope, type DiscoveredItem } from './discover.ts';
import { scanFiles } from '../sources/files.ts';
import { ScopeWatcher } from '../sources/watch.ts';
import { fullIntake } from '../intake/intake.ts';
import { ProjectStore } from '../store/project-store.ts';
import { keeperTools, type ToolContext } from '../keeper/tools.ts';
import { App } from '../server/app.ts';
import type { Project, ProjectRule, ScopeItem, Source } from '../model/types.ts';

// ───────────────────────── isolation from the machine ─────────────────────────

const HOME = mkdtempSync(join(tmpdir(), 'pk-scope-home-'));
writeFileSync(join(HOME, 'gitconfig'), '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(HOME, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  HOME, USERPROFILE: HOME,
});

// ───────────────────────── fixtures ─────────────────────────

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (root: string, rel: string, text: string | Buffer) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

interface Ledger {
  readonly repo: string;
  readonly exportCsv: string;   // merged, with uncommitted changes
  readonly tidy: string;        // merged, nothing uncommitted
  readonly reminders: string;   // not merged: one commit the trunk does not have, plus an uncommitted file
  readonly pdfkit: string;      // vendored library: its own repository with an upstream, and a license
}

function ledger(): Ledger {
  const base = mkdtempSync(join(tmpdir(), 'pk-scope-'));
  const repo = join(base, 'ledger');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(repo, '.gitignore', 'build/\nnotes/\n*.log\n.worktrees/\n');
  put(repo, 'README.md', '# Ledger\n\nA small invoicing tool.\n');
  put(repo, 'docs/plan.md', '# Plan\n\n- L-1 export invoices\n');
  put(repo, 'docs/design.md', '# Design\n\nInvoices are exported as CSV.\n');
  put(repo, 'src/export.ts', 'export const format = "csv";\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Ledger: first version');

  // A branch worked in its own worktree and merged; the trunk moves on afterwards.
  const exportCsv = join(repo, '.worktrees', 'export-csv');
  git(repo, 'worktree', 'add', '-q', '-b', 'export-csv', exportCsv);
  put(exportCsv, 'docs/design.md', '# Design\n\nInvoices are exported as CSV and PDF.\n');
  git(exportCsv, 'commit', '-q', '-am', 'L-1: the design adds PDF');
  git(repo, 'merge', '-q', '--no-ff', 'export-csv', '-m', 'Merge export-csv');
  put(repo, 'docs/plan.md', '# Plan\n\n- L-1 export invoices (done)\n- L-2 reminders\n');
  git(repo, 'commit', '-q', '-am', 'Plan: L-2 reminders');
  // Left in the merged worktree without committing.
  put(exportCsv, 'docs/design.md', '# Design\n\nInvoices are exported as CSV and PDF.\n\nDraft: a footer on every page.\n');
  put(exportCsv, 'docs/footer-notes.md', '# Footer\n\nWhat the footer shows.\n');

  // A worktree at the trunk with nothing of its own.
  const tidy = join(repo, '.worktrees', 'tidy');
  git(repo, 'worktree', 'add', '-q', '-b', 'tidy', tidy);

  // Work in progress on a branch the trunk does not have yet.
  const reminders = join(repo, '.worktrees', 'reminders');
  git(repo, 'worktree', 'add', '-q', '-b', 'reminders', reminders);
  put(reminders, 'docs/reminders.md', '# Reminders\n\nL-2: email a reminder a week before an invoice is due.\n');
  put(reminders, 'src/export.ts', 'export const format = "csv";\nexport const remind = true;\n');
  git(reminders, 'add', '-A');
  git(reminders, 'commit', '-q', '-m', 'L-2: reminders design and flag');
  put(reminders, 'docs/reminders-wip.md', '# Reminder wording\n\nStill being written.\n');

  // What the project's ignore rules leave out.
  put(repo, 'notes/idea-1.md', '# Idea\n\nLate fees.\n');
  put(repo, 'notes/idea-2.md', '# Idea\n\nCurrency per client.\n');
  put(repo, 'notes/todo.txt', 'ask about tax rounding\n');
  put(repo, 'notes/sketch.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  put(repo, 'build/out.js', 'console.log(1);\n');
  put(repo, 'build/report.md', '# Build report\n');
  put(repo, 'debug.log', 'started\n');
  put(repo, 'src/trace.log', 'trace\n');

  // A vendored library: its own repository with an upstream and a license. Nobody ignores it.
  const pdfkit = join(repo, 'third_party', 'pdfkit');
  mkdirSync(pdfkit, { recursive: true });
  git(pdfkit, 'init', '-q', '-b', 'main');
  git(pdfkit, 'remote', 'add', 'origin', 'https://example.com/pdfkit.git');
  put(pdfkit, 'LICENSE', 'MIT License\n\nCopyright (c) the pdfkit authors\n');
  put(pdfkit, 'README.md', '# pdfkit\n\nRender PDF documents.\n');
  put(pdfkit, 'docs/release-plan.md', '# Release plan\n\n1. Tag the release\n2. Publish the package\n');
  put(pdfkit, 'lib/pdf.js', 'module.exports = {};\n');
  git(pdfkit, 'add', '-A');
  git(pdfkit, 'commit', '-q', '-m', 'pdfkit 2.1');

  // Build output nobody ignored.
  put(repo, 'dist/bundle.js', 'var a=1;\n');
  put(repo, 'dist/index.html', '<!doctype html><title>Ledger</title>\n');
  return { repo, exportCsv, tidy, reminders, pdfkit };
}

const project = (locations: readonly string[], scope: readonly ScopeItem[] = []): Project =>
  ({ id: 'p1', name: 'Ledger', language: 'en', locations, scope, scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false, createdAt: '2026-09-01T00:00:00.000Z', lastOpenedAt: null, lastScopedAt: null }) as unknown as Project;

const discover = (locations: readonly string[], options: Parameters<typeof discoverScope>[1] = {}) =>
  discoverScope({ id: 'p1', name: 'Ledger', locations }, { home: HOME, ...options });

const strip = (items: readonly DiscoveredItem[]): ScopeItem[] => items.map(({ reasonRef: _r, sessions: _s, ...rest }) => rest);
const at = <T extends { path: string }>(items: readonly T[], path: string): T | undefined => items.find((i) => i.path.toLowerCase() === path.toLowerCase());
const rel = (root: string, path: string) => relative(root, path).split('\\').join('/');
const filesRead = (sources: readonly Source[], root: string) =>
  [...new Set(sources.filter((s) => s.anchor.kind === 'file').map((s) => rel(root, (s.anchor as { path: string }).path)))].sort();

type Worktree = { merged: boolean; branch: string | null; uniqueCommits: number; files: number; sameAsTrunk: number; olderVersions: number; taken: { path: string; kind: string }[]; trunk: { ref: string } | null };
type Ignored = { file: string; line: number; pattern: string; files: number; documents: number; documentNames?: string[] };
type Classification = { by: string; basis: string; kind: string | null; evidence: string[] };
type Cover = { ruleId: string; category: string; excerpt: string | null; sourceIds: string[] };
const wt = (item: unknown) => (item as { worktree?: Worktree } | undefined)?.worktree;
const ignoredBy = (item: unknown) => (item as { ignoredBy?: Ignored } | undefined)?.ignoredBy;
const classification = (item: unknown) => (item as { classification?: Classification } | undefined)?.classification;
const coveredBy = (item: unknown) => (item as { coveredBy?: Cover[] } | undefined)?.coveredBy ?? [];

let shared: Ledger | null = null;
const fixture = () => (shared ??= ledger());
/** The tests that only read share one discovery and one scan of the shared fixture (each git call costs a process). */
let sharedDiscovery: ReturnType<typeof discoverScope> | null = null;
let sharedScan: ReturnType<typeof scanFiles> | null = null;
const scoped = () => (sharedDiscovery ??= discover([fixture().repo]));
const scanned = () => (sharedScan ??= scanFiles('p1', strip(scoped().items)));

// ───────────────────────── AC-15: worktrees measured against the trunk (E60) ─────────────────────────

test('a merged worktree takes only its uncommitted changes; what is the same as the trunk, or older, is skipped (CKC-04 AC-15, E60)', () => {
  const f = fixture();
  const result = scoped();
  const item = at(result.items, f.exportCsv);
  assert.ok(item, 'the registered worktree is listed');
  assert.equal(item.relation, 'Worktree of main repo');
  const w = wt(item);
  assert.ok(w, 'the listing says how the worktree stands against the trunk (merged, skipped, taken)');
  assert.equal(w.merged, true, 'every commit of export-csv is in main');
  assert.equal(w.trunk?.ref, 'main');
  assert.equal(w.sameAsTrunk, 3, '.gitignore, README.md and src/export.ts are the same as main');
  assert.equal(w.olderVersions, 1, 'docs/plan.md is an older version main has moved past; the version history keeps it');
  assert.deepEqual(w.taken.map((t) => `${t.path} · ${t.kind}`).sort(), ['docs/design.md · Uncommitted change', 'docs/footer-notes.md · Uncommitted change']);
  assert.equal(w.files, 6);
  assert.match(item.reason, /merged into main/);
  assert.match(item.reason, /3 .*same as main/);
  assert.match(item.reason, /docs\/footer-notes\.md/);

  const tidy = at(result.items, f.tidy);
  assert.equal(wt(tidy)?.merged, true);
  assert.deepEqual(wt(tidy)?.taken, [], 'a merged worktree with nothing uncommitted takes nothing');
  assert.match(tidy!.reason, /nothing taken/i);

  const scan = scanned();
  assert.deepEqual(filesRead(scan.sources.filter((s) => s.scopeItemId === item.id), f.exportCsv), ['docs/design.md', 'docs/footer-notes.md'], 'only the uncommitted changes are read from the merged worktree');
  assert.equal(scan.sources.filter((s) => s.scopeItemId === tidy!.id).length, 0, 'nothing is read from a merged worktree with nothing uncommitted');
  assert.ok(filesRead(scan.sources, f.repo).includes('docs/plan.md'), 'the main project is still read in full');
});

// ───────────────────────── AC-16: a worktree not merged into the trunk ─────────────────────────

test('a worktree not merged into the trunk contributes its own commits and uncommitted changes, marked as work in progress on its branch (CKC-04 AC-16)', async () => {
  const f = fixture();
  const result = scoped();
  const item = at(result.items, f.reminders)!;
  const w = wt(item);
  assert.ok(w, 'the listing says how the worktree stands against the trunk');
  assert.equal(w.merged, false);
  assert.equal(w.uniqueCommits, 1, 'one commit on reminders that main does not have');
  assert.equal(w.branch, 'reminders');
  assert.deepEqual(w.taken.map((t) => `${t.path} · ${t.kind}`).sort(), ['docs/reminders-wip.md · Uncommitted change', 'docs/reminders.md · Changed on branch', 'src/export.ts · Changed on branch']);
  assert.equal(w.sameAsTrunk, 4);
  assert.match(item.reason, /not merged into main/);
  assert.match(item.reason, /1 commit/);

  const scan = scanned();
  const own = scan.sources.filter((s) => s.scopeItemId === item.id);
  assert.deepEqual(filesRead(own, f.reminders), ['docs/reminders-wip.md', 'docs/reminders.md', 'src/export.ts']);

  // The Keeper reading one of them is told whose it is: which worktree, which branch, and that it is not the trunk.
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-scope-store-')));
  store.sources.putMany(own);
  const ctx: ToolContext = { store, project: project([f.repo], strip(result.items)), jobId: 'job_1', jobKind: 'Organizing', model: null };
  const read = keeperTools(ctx).find((t) => t.name === 'pk_read_source')!;
  const doc = own.find((s) => s.anchor.kind === 'file' && s.anchor.path.endsWith('reminders.md'))!;
  const out = await (read.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[] }>)('c', { id: doc.id });
  const shown = JSON.parse(out.content[0]!.text) as { inProgress?: { worktree: string; branch: string; merged: boolean; label: string } };
  assert.ok(shown.inProgress, 'a source from a worktree not merged into the trunk says so where the Keeper reads it');
  assert.equal(shown.inProgress.branch, 'reminders');
  assert.equal(shown.inProgress.merged, false);
  assert.equal(shown.inProgress.worktree.toLowerCase(), f.reminders.toLowerCase());
  assert.match(shown.inProgress.label, /not the trunk/i);
});

// ───────────────────────── AC-17: the project's ignore rules ─────────────────────────

test('what the project’s ignore rules leave out is listed by directory with the rule, and not read; ignored notes go to the owner (CKC-04 AC-17)', () => {
  const f = fixture();
  const result = scoped();
  const notes = at(result.items, join(f.repo, 'notes'));
  assert.ok(notes, 'the ignored notes directory is listed');
  assert.equal(notes.relation, 'Excluded');
  assert.deepEqual({ file: ignoredBy(notes)?.file, line: ignoredBy(notes)?.line, pattern: ignoredBy(notes)?.pattern }, { file: '.gitignore', line: 2, pattern: 'notes/' });
  assert.match(notes.reason, /\.gitignore/);
  assert.match(notes.reason, /line 2/);
  assert.match(notes.reason, /notes\//);
  assert.equal(ignoredBy(notes)?.files, 4);
  assert.equal(ignoredBy(notes)?.documents, 3, 'two notes and a text file; the picture is not a document');
  const question = result.questions.find((q) => q.question.includes('notes'));
  assert.ok(question, 'an ignored directory holding documents is put to the owner as a scope question');
  assert.match(question.question, /3 documents/);
  assert.ok(question.clues.some((c) => c.includes('idea-1.md')));

  const build = at(result.items, join(f.repo, 'build'));
  assert.equal(build?.relation, 'Excluded');
  assert.equal(ignoredBy(build)?.pattern, 'build/');
  assert.equal(result.questions.filter((q) => q.question.includes('build')).length, 0, 'a build output directory is not asked about');
  const logs = result.items.filter((i) => ignoredBy(i)?.pattern === '*.log');
  assert.ok(logs.length > 0 && logs.every((i) => i.relation === 'Excluded'), 'ignored files outside ignored directories are listed by directory with their rule');
  assert.equal(logs.reduce((n, i) => n + (ignoredBy(i)?.files ?? 0), 0), 2);
  assert.equal(result.items.filter((i) => rel(f.repo, i.path) === '.worktrees').length, 0, 'the ignored directory that holds the registered worktrees is not listed as ignored: the worktrees are measured on their own');

  const read = filesRead(scanned().sources, f.repo);
  assert.deepEqual(read.filter((p) => p.startsWith('notes/') || p.startsWith('build/') || p.endsWith('.log')), [], 'nothing the ignore rules leave out is read');
  assert.ok(read.includes('README.md'));
});

test('an ignored directory with its own git repository is nested scope; ordinary ignored directories stay excluded', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-ignored-nested-'));
  const parent = join(base, 'parent');
  const nested = join(parent, 'app');
  mkdirSync(parent);
  git(parent, 'init', '-q', '-b', 'main');
  put(parent, '.gitignore', '/app/\n/ordinary/\n');
  put(parent, 'README.md', '# Parent\n');
  git(parent, 'add', '-A');
  git(parent, 'commit', '-q', '-m', 'Parent');
  mkdirSync(nested);
  git(nested, 'init', '-q', '-b', 'main');
  put(nested, '.gitignore', 'node_modules/\n.worktrees/\n');
  put(nested, 'src/main.ts', 'export const ownCode = true;\n');
  git(nested, 'add', '-A');
  git(nested, 'commit', '-q', '-m', 'Independent app');
  put(nested, 'node_modules/pkg/index.js', 'ignored dependency\n');
  put(nested, '.worktrees/scratch.txt', 'ignored scratch\n');
  put(parent, 'ordinary/note.md', '# Ignored ordinary directory\n');

  const result = discover([parent]);
  const own = at(result.items, nested);
  assert.equal(own?.relation, 'Nested repository');
  assert.match(own.reason, /own \.git/);
  assert.equal(result.items.filter((i) => i.path === nested && i.relation === 'Excluded').length, 0, 'the parent does not exclude the independent repository');
  assert.equal(at(result.items, join(parent, 'ordinary'))?.relation, 'Excluded');
  for (const [name, pattern] of [['node_modules', 'node_modules/'], ['.worktrees', '.worktrees/']]) {
    const item = at(result.items, join(nested, name));
    assert.equal(item?.relation, 'Excluded', `${name} is judged by the nested repository`);
    assert.equal(ignoredBy(item)?.pattern, pattern);
    assert.equal(ignoredBy(item)?.file, '.gitignore');
  }
  const read = filesRead(scanFiles('p1', strip(result.items)).sources, parent);
  assert.ok(read.includes('app/src/main.ts'), 'the nested repository contributes its code');
  assert.ok(!read.some((p) => p.startsWith('ordinary/') || p.startsWith('app/node_modules/') || p.startsWith('app/.worktrees/')));
});

test('a repository inside a directory the parent ignores stays out with it; one whose own root is ignored comes in (D98)', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-nested-in-ignored-'));
  const parent = join(base, 'parent');
  mkdirSync(parent);
  git(parent, 'init', '-q', '-b', 'main');
  put(parent, '.gitignore', '/app/\ntemp/\n');
  put(parent, 'README.md', '# Parent\n');
  git(parent, 'add', '-A');
  git(parent, 'commit', '-q', '-m', 'Parent');
  const app = join(parent, 'app');
  const demo = join(parent, 'tools', 'temp', 'demo');
  for (const repo of [app, demo]) {
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    put(repo, 'README.md', '# Its own\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Own');
  }

  const result = discover([parent]);
  assert.equal(at(result.items, app)?.relation, 'Nested repository', 'a repository whose own root the parent ignores is the project’s');
  assert.ok(!result.items.some((i) => i.path === demo && i.relation === 'Nested repository'), 'a repository inside an ignored temp/ folder is not');
  assert.equal(at(result.items, join(parent, 'tools', 'temp'))?.relation, 'Excluded', 'it stays out with the directory the parent ignores');
  const read = filesRead(scanFiles('p1', strip(result.items)).sources, parent);
  assert.ok(read.includes('app/README.md'));
  assert.ok(!read.some((p) => p.startsWith('tools/temp/')));
});

test('a tracked submodule gitlink is not classified as an independent nested repository', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-scope-gitlink-'));
  const upstream = join(base, 'upstream');
  const parent = join(base, 'parent');
  mkdirSync(upstream);
  mkdirSync(parent);
  git(upstream, 'init', '-q', '-b', 'main');
  put(upstream, 'README.md', '# Upstream\n');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-q', '-m', 'Upstream');
  git(parent, 'init', '-q', '-b', 'main');
  put(parent, 'README.md', '# Parent\n');
  git(parent, 'add', '-A');
  git(parent, 'commit', '-q', '-m', 'Parent');
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'module');
  const result = discover([parent]);
  assert.ok(!result.items.some((i) => i.path === join(parent, 'module') && i.relation === 'Nested repository'));
});

test('the owner’s answer to include ignored notes takes them in; without version control there are no ignore rules (CKC-04 AC-17)', () => {
  const f = fixture();
  const first = scoped();
  const question = first.questions.find((q) => q.question.includes('notes'));
  assert.ok(question, 'the scope question about the ignored notes is raised');
  const answered = { ...question, answer: { text: question.options[0]!, at: '2026-09-21T10:00:00.000Z', sourceId: null } };
  const second = discover([f.repo], { existingQuestions: [answered] });
  const notes = at(second.items, join(f.repo, 'notes'))!;
  assert.equal(notes.relation, 'Main project', 'the owner chose to include them');
  assert.match(notes.reason, /owner/);
  const read = filesRead(scanFiles('p1', strip(second.items)).sources, f.repo);
  assert.ok(read.includes('notes/idea-1.md') && read.includes('notes/todo.txt'));
  assert.ok(!read.includes('notes/sketch.png'));

  // A directory without version control has no ignore rules: a .gitignore there is just a file.
  const plain = mkdtempSync(join(tmpdir(), 'pk-scope-plain-'));
  put(plain, '.gitignore', 'notes/\n');
  put(plain, 'notes/idea.md', '# Idea\n');
  const loose = discover([plain]);
  assert.equal(loose.items.filter((i) => ignoredBy(i)).length, 0);
  assert.ok(filesRead(scanFiles('p1', strip(loose.items)).sources, plain).includes('notes/idea.md'));
});

// ───────────────────────── AC-13 / CKC-02 AC-25: third-party material and generated output ─────────────────────────

test('a vendored library and a build output nobody ignored are listed apart; the library’s documents are read as Reference only, its code and the build output not at all (CKC-04 AC-13, CKC-02 AC-25)', () => {
  const f = fixture();
  const result = scoped();
  const lib = at(result.items, f.pdfkit);
  assert.ok(lib);
  assert.equal(lib.relation, 'Third-party material');
  assert.equal(classification(lib)?.by, 'program', 'the program offers it; the Keeper judges it');
  assert.equal(classification(lib)?.basis, 'Inferred');
  assert.match(lib.reason, /https:\/\/example\.com\/pdfkit\.git/);
  assert.match(lib.reason, /LICENSE/);
  const dist = at(result.items, join(f.repo, 'dist'));
  assert.equal(dist?.relation, 'Generated');
  assert.equal(classification(dist)?.basis, 'Inferred');

  const scan = scanned();
  const plan = scan.sources.find((s) => s.anchor.kind === 'file' && s.anchor.path.endsWith('release-plan.md'));
  assert.ok(plan, 'the library’s own documents are read');
  assert.equal(plan.usedAs, 'Reference only', 'they are read as Reference only: citable, never a requirement or plan of this project');
  assert.equal((plan as Source & { usedAsByScopeItemId?: string }).usedAsByScopeItemId, lib.id);
  const read = filesRead(scan.sources, f.repo);
  assert.ok(!read.includes('third_party/pdfkit/lib/pdf.js'), 'the library’s code is not organized');
  assert.deepEqual(read.filter((p) => p.startsWith('dist/')), [], 'build output is not organized');
});

test('one skip list: a build cache and installed dependencies are listed and left unread in a project without version control too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-scope-app-'));
  put(dir, 'README.md', '# Tally\n');
  put(dir, 'src/app.ts', 'export {};\n');
  put(dir, '.parcel-cache/data.json', '{"version":2}\n');
  put(dir, 'node_modules/left-pad/README.md', '# left-pad\n');
  const result = discover([dir]);
  assert.equal(at(result.items, join(dir, '.parcel-cache'))?.relation, 'Generated');
  assert.equal(at(result.items, join(dir, 'node_modules'))?.relation, 'Third-party material');
  const read = filesRead(scanFiles('p1', strip(result.items)).sources, dir);
  assert.deepEqual(read, ['README.md', 'src/app.ts']);
});

// ───────────────────────── AC-1, AC-14 (the listing half): locations a project rule covers ─────────────────────────

test('locations a project rule covers carry the rule’s words and where they are written (CKC-04 AC-1, AC-14)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-scope-handbook-'));
  put(dir, 'AGENTS.md', '# Agents\n\ntrash/ keeps retired files so they can be restored if needed; nothing in it describes current work.\narchive/ holds superseded designs kept for traceability.\n');
  put(dir, 'archive/README.md', '# Archive\n\nSuperseded designs, kept for traceability.\n');
  put(dir, 'archive/old-design.md', '# Old design\n');
  put(dir, 'trash/README.md', '# Trash\n\nRetired files, kept for now.\n');
  put(dir, 'trash/old-plan.md', '# Old plan\n');
  put(dir, 'docs/guide.md', '# Guide\n');
  put(dir, 'docs/reference/vendor-api.md', '# Vendor API\n');
  const rule = (id: string, category: ProjectRule['category'], appliesTo: string[], excerpt: string): ProjectRule => ({
    id, projectId: 'p1', group: 'Material rules', category, summary: `${category} rule`, excerpt, sourceIds: ['src_agents'], appliesTo,
    basis: 'Explicit', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: 'job_1', asOf: '2026-09-21', updatedAt: '2026-09-21',
  });
  const rules = [
    rule('rule_recovery', 'Recovery only', ['trash/'], 'trash/ keeps retired files so they can be restored if needed; nothing in it describes current work.'),
    rule('rule_obsolete', 'Obsolete', ['archive/'], 'archive/ holds superseded designs kept for traceability.'),
    rule('rule_reference', 'Reference only', ['docs/reference/', 'the whole vendor documentation'], 'docs/reference/ is for reference only.'),
  ];
  const labels: Record<string, string> = { src_agents: 'AGENTS.md › Agents (L3–L4)' };
  const result = discover([dir], { rules, sourceLabel: (id: string) => labels[id] ?? null } as Parameters<typeof discoverScope>[1]);

  const root = at(result.items, dir)!;
  assert.match(root.reason, /no version control/);
  const del = at(result.items, join(dir, 'trash'))!;
  assert.equal(del.relation, 'Excluded', 'kept only for recovery: nothing in it is current material');
  assert.deepEqual(coveredBy(del).map((c) => c.ruleId), ['rule_recovery']);
  assert.match(del.reason, /so they can be restored if needed/);
  assert.match(del.reason, /AGENTS\.md/);
  assert.match(del.reason, /History only/);
  assert.ok(del.reasonSourceIds.includes('src_agents'), 'the reason opens where the rule is written');
  const archive = at(result.items, join(dir, 'archive'))!;
  assert.equal(archive.relation, 'Main project');
  assert.deepEqual(coveredBy(archive).map((c) => c.category), ['Obsolete']);
  assert.match(archive.reason, /superseded designs kept for traceability/);
  const reference = at(result.items, join(dir, 'docs', 'reference'));
  assert.ok(reference, 'a directory only a rule names is listed too');
  assert.deepEqual(coveredBy(reference).map((c) => c.category), ['Reference only']);

  // What a recovery-only location holds stays readable for the three uses of history (its Used as is B1b's), and out of
  // the current material (Excluded).
  const read = filesRead(scanFiles('p1', strip(result.items)).sources, dir);
  assert.ok(read.includes('trash/old-plan.md'));

  // Without the rule, a directory named for deletion stays out, as before.
  const bare = discover([dir]);
  assert.equal(at(bare.items, join(dir, 'trash'))?.relation, 'Excluded');
  assert.ok(!filesRead(scanFiles('p1', strip(bare.items)).sources, dir).includes('trash/old-plan.md'));
});

// ───────────────────────── AC-3, AC-11: nothing in the project changes ─────────────────────────

function fingerprintTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.set(rel(root, full), createHash('sha1').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

test('measuring worktrees and reading ignore rules leave the project’s files, index, refs and worktrees exactly as they were (CKC-04 AC-3, AC-11)', () => {
  const f = fixture();
  // Files whose timestamps moved but content did not: a git call that may refresh the index would rewrite it here.
  const later = new Date(Date.now() + 60_000);
  for (const p of [join(f.exportCsv, 'README.md'), join(f.tidy, 'docs', 'plan.md'), join(f.reminders, 'README.md'), join(f.repo, 'README.md')]) utimesSync(p, later, later);
  // The test's own look at the status must not refresh the index either.
  const status = () => execFileSync('git', ['status', '--porcelain'], { cwd: f.repo, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const statusBefore = status();
  const before = fingerprintTree(join(f.repo, '..'));
  const result = discover([f.repo]);
  scanFiles('p1', strip(result.items));
  assert.equal(wt(at(result.items, f.exportCsv))?.merged, true, 'the worktrees were measured against the trunk');
  const after = fingerprintTree(join(f.repo, '..'));
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
  assert.deepEqual(changed, [], 'no file anywhere in the repository, its .git or its worktrees was written');
  assert.equal(status(), statusBefore);
});

// ───────────────────────── intake: what a worktree contributes ─────────────────────────

test('intake takes nothing from a merged worktree with nothing uncommitted, and no history from a vendored library (CKC-04 AC-13, AC-15)', async () => {
  const f = fixture();
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-scope-home2-')), { organizing: false });
  app.workspace.setSettings({ watchProjects: false });
  const created = app.workspace.add('Ledger', [f.repo]);
  const store = app.store(created.id);
  const p = app.scopeProject(created.id);
  await fullIntake(store, p);
  const tidy = at(p.scope, f.tidy)!;
  assert.deepEqual(store.sources.filter((s) => s.scopeItemId === tidy.id).map((s) => s.title), [], 'no status, commit or file source from a merged worktree with nothing uncommitted');
  const lib = at(p.scope, f.pdfkit)!;
  assert.deepEqual(store.sources.filter((s) => s.anchor.kind === 'commit' && s.scopeItemId === lib.id).map((s) => s.title), [], 'the library’s own commits are its upstream’s history, not this project’s');
  const reminders = at(p.scope, f.reminders)!;
  assert.ok(store.sources.find((s) => s.anchor.kind === 'commit' && s.scopeItemId === reminders.id), 'the commit only reminders has is taken');
});

// ───────────────────────── the workbench: the owner's answer and a rule written later ─────────────────────────

test('answering the question about ignored notes re-draws the scope, and a rule written later shows in the listing without a rescan (CKC-04 AC-17, AC-14)', async () => {
  const f = fixture();
  const app = new App(mkdtempSync(join(tmpdir(), 'pk-scope-home3-')), { organizing: false });
  app.workspace.setSettings({ watchProjects: false });
  const created = app.workspace.add('Ledger', [f.repo]);
  const store = app.store(created.id);
  const scoped = app.scopeProject(created.id);
  const question = scoped.scopeQuestions.find((q) => q.question.includes('notes'));
  assert.ok(question, 'the scope question about the ignored notes is in Project scope');
  app.answerScopeQuestion(created.id, question.id, 'Include them');
  assert.equal(at(app.project(created.id).scope, join(f.repo, 'notes'))?.relation, 'Main project', 'the answer takes effect at once');

  // The framing round writes a rule; the listing follows by itself.
  store.sources.put({ id: 'src_readme', projectId: created.id, title: 'Ledger', anchor: { kind: 'file', path: join(f.repo, 'README.md'), headingPath: ['Ledger'], lineStart: 1, lineEnd: 3 }, ids: [], version: { fingerprint: 'f', readAt: '2026-09-21', commit: null }, excerpt: 'docs/ is for reference only.', usedAs: null, usedAsBy: null, availability: null, movedTo: null, scopeItemId: created.id, hasCredential: false, bytes: 10 } as Source);
  store.rules.put({ id: 'rule_docs', projectId: created.id, group: 'Material rules', category: 'Reference only', summary: 'docs/ is reference only', excerpt: 'docs/ is for reference only.', sourceIds: ['src_readme'], appliesTo: ['docs/'], basis: 'Explicit', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: 'job_1', asOf: '2026-09-21', updatedAt: '2026-09-21' });
  await store.flush();
  let docs: ScopeItem | undefined;
  for (let i = 0; i < 80 && !coveredBy(docs = at(app.project(created.id).scope, join(f.repo, 'docs'))).length; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(coveredBy(docs).map((c) => c.ruleId), ['rule_docs'], 'the rule’s location shows in Project scope once the rule is written');
});

// ───────────────────────── the watcher uses the same skip list and ignore rules ─────────────────────────

test('the watcher reports changes the scan would read and nothing it would not (CKC-04 AC-13, AC-17)', async () => {
  const f = fixture();
  const result = scoped();
  const watcher = new ScopeWatcher(project([f.repo], strip(result.items)), { pollMs: 60_000 });
  watcher.start();
  try {
    await new Promise((r) => setTimeout(r, 300));
    put(f.repo, 'notes/idea-3.md', '# Idea\n\nDiscounts.\n');
    put(f.repo, 'dist/chunk.js', 'var b=2;\n');
    put(f.pdfkit, 'lib/font.js', 'module.exports = 1;\n');
    put(f.repo, 'src/audit.log', 'x\n');
    put(f.pdfkit, 'docs/fonts.md', '# Fonts\n');
    put(f.repo, 'docs/tax.md', '# Tax\n');
    put(f.reminders, 'docs/schedule.md', '# Schedule\n');
    // The worktree `reminders` lies under `.worktrees/`, which the repository's own ignore rules leave out: its working
    // files are no change to take in (D105; its branch and commits are polled from version control, tested below).
    const want = ['docs/tax.md', 'third_party/pdfkit/docs/fonts.md'];
    const seen = () => watcher.list().map((c) => rel(f.repo, c.ref));
    for (let i = 0; i < 50 && !want.every((w) => seen().includes(w)); i += 1) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 400));
    for (const w of want) assert.ok(seen().includes(w), `reported: ${w}`);
    for (const w of ['notes/idea-3.md', 'dist/chunk.js', 'third_party/pdfkit/lib/font.js', 'src/audit.log', '.worktrees/reminders/docs/schedule.md']) assert.ok(!seen().includes(w), `not reported: ${w}`);
  } finally {
    watcher.stop();
  }
});
