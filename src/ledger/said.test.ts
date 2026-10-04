/**
 * What the ledger used to leave out without a word, and a time it used to drop (QC AY's small items, CKC-22 AC-4…AC-10):
 *   - a document version keeps the date the document states for itself as the other time (§2.11: "正文写明日期的，另记"),
 *     and a line's written date is kept even on the commit's own day;
 *   - a document version over the size the ledger reads to is kept without its text, and the coverage and the rebuild
 *     say which, reports among them (their verdicts are not read); a file outside version control too large to read is
 *     listed too;
 *   - an execution arrangement keeps 600 table rows and 60 lines of batches, dependencies and parallel work, and says how
 *     many more there are;
 *   - the numbers the Keeper gave are in the ledger whether or not the project folder holds them (CKC-22 AC-5).
 * An invented project in a temporary directory; git is only read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'pk-said-home-'));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

const { rebuildLedgerInPlace, ledgerPath } = await import('./rebuild.ts');
const { Ledger } = await import('./index.ts');
const { coverageView } = await import('./views.ts');
type Project = import('../model/types.ts').Project;
type ScopeItem = import('../model/types.ts').ScopeItem;

const ENV = { GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@said.invalid', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@said.invalid' };
const repo = mkdtempSync(join(tmpdir(), 'pk-said-repo-'));
const git = (args: string[], date = '2026-09-01T10:00:00+00:00') => execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (root: string, rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };

git(['init', '-q', '-b', 'main']);
write(repo, 'docs/dated.md', '# Dated\n\n日期：2026-09-01\n\nThe robot plan is superseded by the hand plan.\n');
write(repo, 'reports/big-report.md', `# QC report\n\n结论：fail\n\n${'padding line of the report\n'.repeat(160_000)}`);
const rows = Array.from({ length: 605 }, (_, i) => `| T-${i + 1} | item ${i + 1} | done |`);
const batchLines = Array.from({ length: 65 }, (_, i) => `- Batch ${i + 1}: T-${i + 1}`);
write(repo, 'subagent/INDEX.md', ['# Index', '', '| ID | Task | Status |', '|---|---|---|', ...rows, '', ...batchLines, ''].join('\n'));
git(['add', '-A']);
git(['commit', '-q', '-m', 'Start'], '2026-09-01T10:00:00+00:00');

const looseDir = mkdtempSync(join(tmpdir(), 'pk-said-loose-'));
write(looseDir, 'small.md', '# Small\n\nA note.\n');
write(looseDir, 'huge.md', `# Huge\n\n${'x'.repeat(2_100_000)}\n`);

const item = (id: string, path: string, category: ScopeItem['category']): ScopeItem => ({ id, path, category, relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: category === 'Repository' ? 'git' : 'none', missing: null, addedBy: 'owner' }) as ScopeItem;
const P = {
  id: 'said', name: 'Said', locations: [repo, looseDir], scope: [item('repo', repo, 'Repository'), item('loose', looseDir, 'Directory')],
  scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: '2026-09-01T00:00:00Z', lastOpenedAt: null, lastScopedAt: null,
} as unknown as Project;
const file = ledgerPath(P.id, join(fakeHome, '.projectkeeper'));
const keeperNumbers = [{ number: 'K-1', objectId: 'thread_hand', objectKind: 'work', projectNumber: null, at: '2026-09-05T10:00:00.000Z' }];
const stats = rebuildLedgerInPlace(file, P, { keeperNumbers });
const L = Ledger.openPath(file)!;
const page = <T>(r: T | string): T => { if (typeof r === 'string') throw new Error(r); return r; };

test('a document version keeps the date the document states for itself as the other time, even on the commit’s own day (§2.11)', () => {
  const v = page(L.docVersions('docs/dated.md')).versions[0]!;
  assert.equal(v.occurred.basis, 'Commit');
  assert.equal(v.occurred.at, '2026-09-01T10:00:00.000Z');
  assert.deepEqual([v.occurred.other?.at, v.occurred.other?.basis], ['2026-09-01', 'Written in text'], 'the text’s own date is recorded beside the commit, not dropped for naming the same day');
  const line = page(L.supersessions({ path: 'docs/dated.md' })).rows[0]!;
  assert.equal(line.occurred.basis, 'Commit');
  assert.deepEqual([line.occurred.other?.at, line.occurred.other?.basis], ['2026-09-01', 'Written in text'], 'a line keeps the written date on the same day too');
});

test('a version over the size the ledger reads to is kept without its text, and the coverage and the rebuild say which — reports among them', () => {
  const cov = L.coverage();
  const r = cov.repos.find((x) => x.repo === 'repo')!;
  assert.ok(r.documentsWithoutText, 'the coverage says some versions have no text');
  assert.equal(r.documentsWithoutText!.versions, 1);
  assert.equal(r.documentsWithoutText!.overSizeLimit, 1);
  assert.deepEqual(r.documentsWithoutText!.paths, ['reports/big-report.md']);
  assert.deepEqual(r.documentsWithoutText!.reports, ['reports/big-report.md'], 'a report among them: its verdicts are not read');
  assert.equal(page(L.verdicts({ path: 'reports/big-report.md' })).total, 0, 'and indeed none is');
  assert.ok(stats.notes.some((n) => /1 document version recorded without text/.test(n) && n.includes('reports/big-report.md')), `the rebuild says it: ${stats.notes.join(' | ')}`);
});

test('a file outside version control too large to read is listed, not left out without a word', () => {
  const nr = L.coverage().outsideVersionControl.notRead;
  assert.ok(nr, 'the coverage lists files it did not read');
  assert.equal(nr!.files, 1);
  assert.ok(nr!.paths[0]!.endsWith('huge.md'));
  assert.ok(stats.notes.some((n) => /over 2 MB not read/.test(n) && n.includes('huge.md')), `the rebuild says it: ${stats.notes.join(' | ')}`);
});

test('Project scope’s ledger view says what the ledger keeps without reading it', () => {
  const nr = coverageView(L).notRead;
  assert.ok(nr, 'the view carries it');
  assert.equal(nr!.versionsWithoutText, 1);
  assert.deepEqual(nr!.reports, ['reports/big-report.md']);
  assert.equal(nr!.unversionedTooLarge, 1);
  assert.match(nr!.effect, /not in it/);
});

test('an arrangement keeps its first 600 rows and 60 batch lines and says how many more there are', () => {
  const idx = page(L.arrangements({ kind: 'index' })).rows.find((a) => a.path === 'subagent/INDEX.md')!;
  const data = idx.data as { rows: unknown[]; batches: unknown[]; omitted?: Record<string, number> };
  assert.equal(data.rows.length, 600);
  assert.equal(data.batches.length, 60);
  assert.deepEqual(data.omitted, { rows: 5, batches: 5 }, 'the rest are counted, so the list says it goes on');
});

test('the Keeper’s numbers are in the ledger, found like the project’s own, whether or not the project folder holds them (CKC-22 AC-5)', () => {
  const hit = page(L.nums({ num: 'K-1' })).rows;
  assert.equal(hit.length, 1);
  assert.equal(hit[0]!.kind, 'keeper');
  assert.equal(hit[0]!.place, 'definition');
  assert.match(hit[0]!.text, /The Keeper's number for work thread_hand/);
  assert.deepEqual([hit[0]!.occurred.at, hit[0]!.occurred.basis], ['2026-09-05T10:00:00.000Z', 'First observed'], 'when the Keeper gave it');
  const e = L.resolve(hit[0]!.id)!;
  assert.ok(e && /K-1/.test(e.label), 'it reads back as evidence');
  // A rebuild that brings no Keeper numbers leaves them; one that brings the list replaces it.
  L.close();
  rebuildLedgerInPlace(file, P, {});
  let again = Ledger.openPath(file)!;
  assert.equal(page(again.nums({ num: 'K-1' })).total, 1, 'kept when the rebuild does not bring them');
  again.close();
  rebuildLedgerInPlace(file, P, { keeperNumbers: [{ number: 'K-2', objectId: 'thread_robot', objectKind: 'work', projectNumber: 'T-9', at: '2026-09-06T10:00:00.000Z' }] });
  again = Ledger.openPath(file)!;
  assert.equal(page(again.nums({ num: 'K-1' })).total, 0, 'the list the round brings is the Keeper’s numbers now');
  assert.match(page(again.nums({ num: 'K-2' })).rows[0]!.text, /the project numbers it T-9/);
  again.close();
});
