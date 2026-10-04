/**
 * Version history is read in full (D77; CKC-22 AC-1): no "recent 200 commits" cap on the commits intake reads, and the
 * history of a path is reached page by page, however long it is. The fixture is a repository with 260 commits, made in
 * one go with `git fast-import` in a temporary directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRecentCommits } from '../util/git.ts';
import { commitSources } from './gitobs.ts';
import { pathHistory } from './history.ts';
import type { Project, ScopeItem } from '../model/types.ts';

const COMMITS = 260;
const base = mkdtempSync(join(tmpdir(), 'pk-caps-'));
const root = join(base, 'long');
mkdirSync(root);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
const stream: string[] = [];
for (let i = 1; i <= COMMITS; i++) {
  const text = `# Log\n\nentry ${i}\n`;
  const when = 1_780_000_000 + i * 3600;
  stream.push('commit refs/heads/main', `mark :${i}`, `author Dev <dev@long.invalid> ${when} +0800`, `committer Dev <dev@long.invalid> ${when} +0800`,
    `data ${Buffer.byteLength(`step ${i}`)}`, `step ${i}`, ...(i > 1 ? [`from :${i - 1}`] : []), `M 100644 inline docs/LOG.md`, `data ${Buffer.byteLength(text)}`, text, '');
}
execFileSync('git', ['fast-import', '--quiet'], { cwd: root, input: `${stream.join('\n')}\n` });
execFileSync('git', ['checkout', '-q', 'main'], { cwd: root });

const item = { id: 'si-long', path: root, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as ScopeItem;
const project = { id: 'long', name: 'Long', locations: [root], scope: [item], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: '', lastOpenedAt: null, lastScopedAt: null } as Project;

test('intake reads every commit reachable from HEAD, not the most recent 200', () => {
  assert.equal(gitRecentCommits(root, null).length, COMMITS);
  assert.equal(commitSources('long', item, null).length, COMMITS);
  assert.equal(gitRecentCommits(root, null, 10).length, 10, 'a caller may still ask for fewer');
});

test('the history of a path is paged to its first commit', () => {
  const seen = new Set<string>();
  let offset: number | null = 0;
  let pages = 0;
  while (offset !== null) {
    const r = pathHistory(project, { path: 'docs/LOG.md', limit: 100, offset });
    assert.ok(typeof r !== 'string', String(r));
    for (const row of r.rows) seen.add(row.commit);
    offset = r.next;
    pages += 1;
  }
  assert.equal(seen.size, COMMITS);
  assert.equal(pages, 3);
});

test.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ } });
