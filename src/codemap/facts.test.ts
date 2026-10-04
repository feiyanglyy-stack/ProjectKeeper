import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { Project, ScopeItem, WorkThread } from '../model/types.ts';
import type { CodeTerritory, Generation } from '../model/k-types.ts';
import { ProjectStore } from '../store/project-store.ts';
import { Ledger } from '../ledger/index.ts';
import { ledgerPath, rebuildLedgerInPlace } from '../ledger/rebuild.ts';
import { codeView, territoryView } from '../ledger/views.ts';
import { CodeMapIndex, codeAnomalyCandidates } from './facts.ts';

const git = (dir: string, args: string[], date = '2026-09-01T12:00:00Z'): string => execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true,
}).trim();
const write = (dir: string, path: string, content: string): void => { const full = join(dir, path); mkdirSync(resolve(full, '..'), { recursive: true }); writeFileSync(full, content); };
const commit = (dir: string, message: string, date: string): string => { git(dir, ['add', '-A'], date); git(dir, ['commit', '-m', message], date); return git(dir, ['rev-parse', 'HEAD']); };
const territory = (id: string, path: string): CodeTerritory => ({ id, projectId: 'codemap-test', repo: 'repo', name: id, summary: id, paths: [path],
  kind: 'shared', areaId: null, alsoServes: [], anomalies: [], roundId: null, jobId: null, updatedAt: '' });

test('merged and fast-forward work, rename, generations, non-test closure, and live residual name', async () => {
  const root = mkdtempSync(resolve('.codemap-test-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  let ledger: Ledger | null = null;
  try {
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'core.autocrlf', 'false']);
    write(repo, 'src/main.ts', "import './live.ts';\nimport './old/legacy_v1.ts';\nimport './old-importer.ts';\nimport './old/move.ts';\n");
    write(repo, 'src/live.ts', 'export const live = 1;\n');
    write(repo, 'src/old/legacy_v1.ts', "import '../helper.ts';\nexport const old = true;\n");
    write(repo, 'src/helper.ts', 'export const helper = 1;\n');
    write(repo, 'src/old-importer.ts', "import './old-target.ts';\nexport const importer = 1;\n");
    write(repo, 'src/old-target.ts', 'export const target = 1;\n');
    write(repo, 'src/old/move.ts', 'export const moved = 1;\n');
    write(repo, 'src/orphan.ts', "import './orphan-child.ts';\nexport const orphan = 1;\n");
    write(repo, 'src/orphan-child.ts', 'export const child = 1;\n');
    write(repo, 'test/orphan.test.ts', "import '../src/orphan-child.ts';\n");
    const base = commit(repo, 'Initial code', '2026-09-01T12:00:00Z');
    git(repo, ['switch', '-c', 'feature/AD-change']);
    write(repo, 'src/live.ts', 'export const live = 2;\n');
    git(repo, ['mv', 'src/old/move.ts', 'src/renamed.ts']);
    write(repo, 'src/main.ts', "import './live.ts';\nimport './old/legacy_v1.ts';\nimport './old-importer.ts';\nimport './renamed.ts';\n");
    commit(repo, 'AD implementation', '2026-09-03T12:00:00Z');
    git(repo, ['switch', 'main']);
    git(repo, ['merge', '--no-ff', '-m', 'Merge AD', 'feature/AD-change'], '2026-09-03T13:00:00Z');
    const merge = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['switch', '-c', 'feature/FF-slice']);
    write(repo, 'src/extra.ts', 'export const extra = 1;\n');
    commit(repo, 'First part', '2026-09-06T10:00:00Z');
    write(repo, 'src/main.ts', "import './live.ts';\nimport './old/legacy_v1.ts';\nimport './old-importer.ts';\nimport './renamed.ts';\nimport './extra.ts';\n");
    commit(repo, 'Second part', '2026-09-06T11:00:00Z');
    git(repo, ['switch', 'main']);
    git(repo, ['merge', '--ff-only', 'feature/FF-slice']);
    const scope = { id: 'repo', path: repo, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null,
      readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as ScopeItem;
    const project = { id: 'codemap-test', name: 'Test', locations: [repo], scope: [scope], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en',
      organizingPaused: false, createdAt: '2026-09-07T00:00:00Z', lastOpenedAt: null, lastScopedAt: null } as Project;
    const dbPath = ledgerPath(project.id, root);
    const full = rebuildLedgerInPlace(dbPath, project);
    assert.ok(full.repos[0]!.blame.scanned >= 8);
    const second = rebuildLedgerInPlace(dbPath, project);
    assert.equal(second.repos[0]!.blame.scanned, 0);
    assert.equal(second.repos[0]!.blame.failed, 0);
    ledger = Ledger.openPath(dbPath)!;
    const store = ProjectStore.open(project.id, root);
    const fallback = codeView(ledger, store, project)!;
    assert.ok(fallback.territories.length > 0);
    assert.ok(fallback.territories.every((t) => t.summary === 'No territories drawn yet'));
    store.threads.put({ id: 'ad', projectId: project.id, title: 'Change', ids: ['AD'] } as unknown as WorkThread);
    store.threads.put({ id: 'ff', projectId: project.id, title: 'Fast forward', ids: ['FF'] } as unknown as WorkThread);
    store.generations.put({ id: 'old', projectId: project.id, name: 'Before decision', started: null,
      ended: { at: '2026-09-05', basis: 'Written in text', anchor: 'decision' }, endedBy: { kind: 'source', id: 'decision', label: 'decision' },
      planRefs: [], workIds: ['ad'], roundId: null, updatedAt: '' } as Generation);
    store.territories.putMany([territory('all', 'src'), territory('target', 'src/old-target.ts'), territory('legacy', 'src/old/legacy_v1.ts'), territory('helper', 'src/helper.ts')]);
    const view = codeView(ledger, store, project)!;
    const all = view.territories.find((t) => t.id === 'all')!;
    assert.ok(all.builtBy.some((w) => w.workId === 'ad' && w.commits.includes(merge.slice(0, 12))));
    assert.ok(all.builtBy.some((w) => w.workId === 'ff' && w.commits.length === 2), 'fast-forward series belongs to one work item');
    assert.ok(all.generations.some((g) => g.generationId === 'old' && g.share > 0));
    assert.ok(all.generations.some((g) => g.generationId === null && g.share > 0));
    assert.equal(view.territories.find((t) => t.id === 'target')!.currentUse, 'Previous generation only');
    assert.equal(view.territories.find((t) => t.id === 'legacy')!.dependsOnCounts?.helper, 1, 'one distinct source-target file pair');
    assert.equal(view.territories.find((t) => t.id === 'helper')!.dependedByCounts?.legacy, 1);
    const index = new CodeMapIndex(ledger, store, 'repo');
    assert.ok(index.isUnused('src/orphan.ts'));
    assert.ok(index.isUnused('src/orphan-child.ts'), 'only an orphan and a test import this file');
    assert.equal(index.isUnused('src/old/legacy_v1.ts'), false);
    assert.equal(index.currentUse(['docs']), 'Not known', 'a place with no code: its use is not claimed either way');
    const candidates = codeAnomalyCandidates(ledger, store, project);
    assert.ok(candidates.some((c) => c.kind === 'Residual name, referenced' && c.path === 'src/old/legacy_v1.ts'));
    assert.ok(candidates.some((c) => c.kind === 'Unclaimed integrated commit' && c.commit === base.slice(0, 12)));
    const detail = territoryView(ledger, store, 'all')!;
    assert.equal(detail.files.find((f) => f.path === 'src/renamed.ts')?.workId, 'ad');
    assert.ok(detail.files.find((f) => f.path === 'src/renamed.ts')?.workLabel?.includes('AD'));
    ledger.close(); ledger = null;
    store.threads.put({ id: 'alias', projectId: project.id, title: 'Alias', ids: [] } as unknown as WorkThread);
    store.numbers.put({ id: 'num-alias', projectId: project.id, number: 'K-7', objectId: 'alias', objectKind: 'work', projectNumber: null, at: '2026-09-07' });
    write(repo, 'src/live.ts', 'export const live = 3;\n');
    const aliasCommit = commit(repo, 'K-7 Update live', '2026-09-07T12:00:00Z');
    const changed = rebuildLedgerInPlace(dbPath, project);
    assert.equal(changed.repos[0]!.blame.scanned, 1, 'only the changed content is reblamed');
    ledger = Ledger.openPath(dbPath)!;
    assert.equal(new CodeMapIndex(ledger, store, 'repo').workForCommit(aliasCommit)?.id, 'alias', 'Keeper number connects the commit');
    ledger.close(); ledger = null;
    store.threads.put({ id: 'linked', projectId: project.id, title: 'Linked work', ids: [] } as unknown as WorkThread);
    write(repo, 'src/live.ts', 'export const live = 4;\n');
    const linkedCommit = commit(repo, 'Unnumbered follow-up', '2026-09-08T12:00:00Z');
    store.links.put({ id: 'link', projectId: project.id, workId: 'linked', ledgerRef: `commit:${linkedCommit.slice(0, 12)}`, stepKind: 'Merged',
      why: 'confirmed in test', basis: 'Inferred', confirmed: true, roundId: null, jobId: null, at: '2026-09-08' });
    rebuildLedgerInPlace(dbPath, project);
    ledger = Ledger.openPath(dbPath)!;
    assert.equal(new CodeMapIndex(ledger, store, 'repo').workForCommit(linkedCommit)?.id, 'linked', 'confirmed process link connects the commit');
    await store.flush();
  } finally {
    ledger?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
