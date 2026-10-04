/**
 * Independent QC (AY) of the ledger against CKC-22 and Spec §2.11/§3.1: four breaches found by reading the code, proven
 * by running it. They are fixed now, and each test asserts the contract:
 *
 *   1. CKC-22 AC-10 (Spec §2.11): a word found in a document outside version control is dated by the date its text writes
 *      (with the file's own time as the other time), else by the file's own time the rebuild recorded — never the epoch
 *      dressed as a `File time`. src/ledger/index.ts `looseOccurred`.
 *   2. CKC-22 AC-4 (Spec §1.16): a supersession phrase inside a fenced code block is not an explicit supersession — a
 *      code example is not the document saying something is replaced; the same phrase outside the fence still is.
 *   3. Spec §3.1 (credentials): a worktree's uncommitted file list is redacted like every other text.
 *   4. CKC-22 AC-8: Project scope's language list names every language with how far the ledger goes in it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after } from 'node:test';
import { join } from 'node:path';

// The scratch lives in the system's temp directory, not the worktree: a write that lands after cleanup would otherwise
// leave test homes in the repository, where a frozen copy of the project would take them in as material.
const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'qc-ay-ledger-'));
process.env.USERPROFILE = scratch;
process.env.HOME = scratch;
after(() => { try { ledger.close(); } catch { /* already closed */ } rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const { rebuildLedgerInPlace, ledgerPath } = await import('../ledger/rebuild.ts');
const { Ledger } = await import('../ledger/index.ts');
const { coverageView } = await import('../ledger/views.ts');
type Project = import('../model/types.ts').Project;
type ScopeItem = import('../model/types.ts').ScopeItem;

const ENV = { GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@qc.invalid', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@qc.invalid' };
const repo = mkdtempSync(join(scratch, 'repo-'));
const git = (args: string[], date = '2026-09-01T10:00:00+00:00') => execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel: string, text: string, root = repo) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };

git(['init', '-q', '-b', 'main']);
write('docs/guide.md', [
  '# Guide',
  '',
  'The orchard picks apples.',
  '',
  '```yaml',
  '# an example of the old config, kept for illustration:',
  'deprecated: use the new picker',
  '```',
  '',
  'The new picker runs daily.',
  '',
  'The hand ladder is deprecated since the new picker came.',
].join('\n'));
write('src/Main.java', 'class Main {}\n');
write('src/style.css', 'body { color: #333; }\n');
write('src/app.ts', 'export const app = 1;\n');
git(['add', '-A']);
git(['commit', '-q', '-m', 'Start']);
// A worktree with an uncommitted, credential-shaped file name (never committed anywhere).
git(['worktree', 'add', '-q', join(scratch, 'repo-wt')]);
write('api_key=sk-canary0123456789abcdef.txt', 'canary\n', join(scratch, 'repo-wt'));

// Documents outside version control (a loose directory of the scope) with no supersession line: one writes its date,
// one writes none, and its file time is set to a known moment.
const looseDir = mkdtempSync(join(scratch, 'loose-'));
write('notes.md', '# Notes\n\n日期：2026-09-02\n\nThe orchard ladder is missing.\n', looseDir);
write('undated.md', '# Undated\n\nThe orchard basket is full.\n', looseDir);
const undatedTime = new Date('2026-09-04T08:30:00.000Z');
utimesSync(join(looseDir, 'undated.md'), undatedTime, undatedTime);

const item = (id: string, path: string, category: ScopeItem['category']): ScopeItem => ({ id, path, category, relation: 'Main project', reason: 'qc', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: category === 'Repository' ? 'git' : 'none', missing: null, addedBy: 'owner' }) as ScopeItem;
const project = {
  id: 'qc-ledger', name: 'QC ledger', locations: [repo, looseDir], scope: [item('repo', repo, 'Repository'), item('loose', looseDir, 'Directory')],
  scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: '2026-09-01T00:00:00Z', lastOpenedAt: null, lastScopedAt: null,
} as unknown as Project;
const file = ledgerPath(project.id, join(scratch, 'home'));
rebuildLedgerInPlace(file, project, {});
const ledger = Ledger.openPath(file)!;

test('CKC-22 AC-10: a word hit in a loose document is dated by what its text writes, with the file time beside it (fixed after QC AY)', () => {
  const page = ledger.word('ladder', { limit: 10 });
  assert.ok(typeof page !== 'string');
  const hit = page.rows.find((r) => r.kind === 'loose');
  assert.ok(hit, `the loose document is found: ${JSON.stringify(page.rows.map((r) => r.kind))}`);
  // Spec §2.11, the table's last row: "没有版本管理的材料 — 正文写明的日期；没有时用文件时间，标为 File time".
  assert.equal(hit.occurred.at, '2026-09-02', 'the date the text writes for the line the word is on (its entry’s 日期 line)');
  assert.equal(hit.occurred.basis, 'Written in text');
  assert.equal(hit.occurred.other?.basis, 'File time', 'the file’s own time is kept beside it');
  assert.ok(hit.occurred.other && !hit.occurred.other.at.startsWith('1970'), `the file time is the file’s own, not the epoch: ${hit.occurred.other?.at}`);
  const resolved = ledger.resolve(hit.id);
  assert.equal(resolved?.occurred.at, '2026-09-02', 'the entry read back as evidence carries the same time, not the moment of the query');
});

test('CKC-22 AC-10: a loose document that writes no date is dated by its file time, the real one (fixed after QC AY)', () => {
  const page = ledger.word('basket', { limit: 10 });
  assert.ok(typeof page !== 'string');
  const hit = page.rows.find((r) => r.kind === 'loose');
  assert.ok(hit, 'the undated loose document is found');
  assert.equal(hit.occurred.basis, 'File time');
  assert.equal(hit.occurred.at, undatedTime.toISOString(), 'the file time the rebuild recorded, not 1970-01-01');
  assert.ok(!hit.occurred.undated);
  const again = ledger.resolve(hit.id)!;
  assert.deepEqual([again.occurred.basis, again.occurred.at], ['File time', undatedTime.toISOString()], 'resolve says the same; it used to say “first seen” at the moment it was asked');
});

test('CKC-22 AC-4: a supersession phrase inside a fenced code block is no supersession; outside the fence it is (fixed after QC AY)', () => {
  const page = ledger.supersessions({ limit: 50 });
  assert.ok(typeof page !== 'string');
  assert.ok(!page.rows.some((r) => /deprecated: use the new picker/.test(r.text)), `the fenced example is not recorded: ${JSON.stringify(page.rows.map((r) => r.text))}`);
  const prose = page.rows.find((r) => /hand ladder is deprecated/.test(r.text));
  assert.ok(prose, 'the same phrase in the document’s own prose is recorded');
  assert.equal(prose.pattern, 'deprecated');
});

test('Spec §3.1: a worktree’s uncommitted list is redacted like the rest of the ledger (fixed after QC AY)', () => {
  const rows = ledger.db.prepare("SELECT uncommitted_list FROM worktrees WHERE repo = 'repo'").all() as { uncommitted_list: string }[];
  const joined = rows.map((r) => r.uncommitted_list).join('\n');
  assert.ok(!joined.includes('sk-canary0123456789abcdef'), `the credential value never reaches the ledger: ${joined}`);
  assert.ok(joined.includes('[credential redacted]'));
});

test('CKC-22 AC-8: Project scope lists every language, a file tree only said as such (fixed after QC AY)', () => {
  const coverage = coverageView(ledger);
  const langs = coverage.languages.map((l) => l.language).sort();
  assert.ok(langs.includes('typescript'), `typescript is listed: ${langs.join(', ')}`);
  assert.ok(langs.includes('java') && langs.includes('css'), `java and css are listed: ${langs.join(', ')}`);
  assert.equal(coverage.languages.find((l) => l.language === 'java')?.level, 'symbol', 'with how far the ledger goes in them: Java is read by the code engine (D98)');
  assert.equal(coverage.languages.find((l) => l.language === 'css')?.level, 'file tree', 'CSS by no reader: said as such');
  const full = ledger.coverage().languages.map((l) => l.language).sort();
  assert.ok(full.includes('java') && full.includes('css'), `the ledger itself knows them: ${full.join(', ')}`);
});
