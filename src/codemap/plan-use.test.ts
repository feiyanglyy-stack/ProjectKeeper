/**
 * The code map's program facts the QC AY review found missing (CKC-25 AC-6, AC-7, AC-10, AC-12; Spec §1.19, §6.17):
 * - `In current plan` says what it claims — current code references it AND current work or requirements point at it —
 *   and code that is referenced with nothing current pointing at it says so (`In use, not in current plan`);
 * - a work item's territories are counted as `Built by` counts them, so the jump there and back agree;
 * - a territory whose path the current version no longer has says so, and the cross-check is told;
 * - a file of the current version opens through the ledger's `fileRefs`, not a search of the sources;
 * - `Code` carries the notes behind an anomaly by title and the send-back it carries, without the process view.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { GraphNode, Note, Project, ScopeItem, WorkThread } from '../model/types.ts';
import type { CodeTerritory, SendBack } from '../model/k-types.ts';
import { ProjectStore } from '../store/project-store.ts';
import { Ledger } from '../ledger/index.ts';
import { LedgerService } from '../ledger/adapters.ts';
import { ledgerPath, rebuildLedgerInPlace } from '../ledger/rebuild.ts';
import { codeView } from '../ledger/views.ts';
import { codeViewOf, processView } from '../server/k-views.ts';
import { CodeMapIndex, codeAnomalyCandidates } from './facts.ts';
import { codeMapEngines } from './engines.ts';

const git = (dir: string, args: string[], date = '2026-09-01T12:00:00Z'): string => execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true,
}).trim();
const write = (dir: string, path: string, content: string): void => { const full = join(dir, path); mkdirSync(resolve(full, '..'), { recursive: true }); writeFileSync(full, content); };
const commit = (dir: string, message: string, date: string): string => { git(dir, ['add', '-A'], date); git(dir, ['commit', '-q', '-m', message], date); return git(dir, ['rev-parse', 'HEAD']); };
const PID = 'plan-use-test';
const territory = (id: string, paths: string[], extra: Partial<CodeTerritory> = {}): CodeTerritory => ({ id, projectId: PID, repo: 'repo', name: id, summary: id, paths,
  kind: 'shared', areaId: null, alsoServes: [], anomalies: [], roundId: null, jobId: null, updatedAt: '', ...extra });
const thread = (id: string, num: string, validity = 'Current'): WorkThread => ({ id, projectId: PID, title: `Work ${num}`, ids: [num], validity, progress: 'Done', serves: [], dependsOn: [], replacedBy: null, unresolved: '' } as unknown as WorkThread);
const node = (id: string, category: GraphNode['category'], areaId: string | null, validity: GraphNode['validity'] = 'Current'): GraphNode => ({
  id, projectId: PID, category, label: id, refKind: category === 'Work item' ? 'thread' : 'reference', refId: id, validity, progress: null, basis: 'Explicit',
  attribution: null, sourceIds: [], areaId, parentWorkId: null, replacedBy: null, updatedAt: '' });

test('Code says what the current plan uses, what each work changed, which paths are gone, and opens a file by the ledger', async () => {
  const root = mkdtempSync(resolve('.plan-use-test-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  let ledger: Ledger | null = null;
  const service = new LedgerService({ home: root });
  try {
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'core.autocrlf', 'false']);
    // An earlier generation's work made lib; that generation ended on 09-02.
    write(repo, 'src/lib/util.ts', 'export const util = 1;\n');
    commit(repo, 'CD: lib', '2026-09-01T12:00:00Z');
    write(repo, 'src/main.ts', "import './core/api.ts';\nimport './feature/view.ts';\nimport './lib/util.ts';\nimport './old/gone.ts';\n");
    write(repo, 'src/core/api.ts', 'export const api = 1;\n');
    write(repo, 'src/feature/view.ts', "import '../core/api.ts';\nexport const view = 1;\n");
    write(repo, 'src/old/gone.ts', 'export const gone = 1;\n');
    commit(repo, 'Start', '2026-09-04T12:00:00Z');
    // Current work AB changes core through a merge.
    git(repo, ['switch', '-q', '-c', 'wip/AB']);
    write(repo, 'src/core/api.ts', 'export const api = 2;\nexport const more = 3;\n');
    commit(repo, 'AB: api more', '2026-09-05T12:00:00Z');
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge AB', 'wip/AB'], '2026-09-05T13:00:00Z');
    // The old directory is deleted afterwards: the territory drawn on it names a path the current version has not.
    rmSync(join(repo, 'src/old'), { recursive: true });
    write(repo, 'src/main.ts', "import './core/api.ts';\nimport './feature/view.ts';\nimport './lib/util.ts';\n");
    const cleanup = commit(repo, 'Remove the old directory', '2026-09-06T12:00:00Z');
    const long = Array.from({ length: 4000 }, (_, i) => `export const line${i} = ${i}; // ${'x'.repeat(20)}`).join('\n');
    write(repo, 'src/lib/long.ts', `${long}\n`);
    commit(repo, 'A long file', '2026-09-07T12:00:00Z');

    const scope = { id: 'repo', path: repo, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null,
      readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as ScopeItem;
    const project = { id: PID, name: 'Test', locations: [repo], scope: [scope], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en',
      organizingPaused: false, createdAt: '2026-09-07T00:00:00Z', lastOpenedAt: null, lastScopedAt: null } as Project;
    rebuildLedgerInPlace(ledgerPath(PID, root), project);
    ledger = Ledger.openPath(ledgerPath(PID, root))!;
    const store = ProjectStore.open(PID, root);
    store.threads.putMany([thread('thr_ab', 'AB'), thread('thr_old', 'CD'), thread('thr_none', 'EF')]);
    store.generations.put({ id: 'gen_old', projectId: PID, name: 'Before 09-02', started: null, ended: { at: '2026-09-02', basis: 'Written in text', anchor: null },
      endedBy: { kind: 'file', id: 'README.md', label: 'the restart' }, planRefs: [], workIds: ['thr_old'], roundId: null, updatedAt: '' });
    // The area `feature` serves has a requirement in force; nothing points at lib.
    store.nodes.putMany([node('ref_area', 'Area', 'ref_area'), node('ref_req', 'Requirement', 'ref_area'), node('thr_ab', 'Work item', null), node('thr_old', 'Work item', 'ref_lib_area')]);
    store.territories.putMany([
      territory('t_core', ['src/core']),
      territory('t_feature', ['src/feature'], { kind: 'area', areaId: 'ref_area' }),
      territory('t_lib', ['src/lib']),
      territory('t_old', ['src/old', 'src/main.ts']),
    ]);

    // ── current use: the references, and what in the plan points at it ──
    const index = new CodeMapIndex(ledger, store, 'repo');
    assert.equal(index.currentUse(['src/core']), 'In current plan', 'current work AB changed it (its merge) and current code references it');
    assert.equal(index.currentUse(['src/feature']), 'In current plan', 'its area has a requirement in force');
    assert.equal(index.currentUse(['src/lib']), 'In use, not in current plan', 'referenced by main, changed only by an earlier generation’s work, no area: nothing current points at it');
    store.nodes.put(node('ref_req', 'Requirement', 'ref_area', 'Replaced'));
    assert.equal(new CodeMapIndex(ledger, store, 'repo').currentUse(['src/feature']), 'In use, not in current plan', 'a replaced requirement points at nothing current');
    store.nodes.put(node('ref_req', 'Requirement', 'ref_area'));

    // ── the territories a work changed, counted as Built by counts ──
    const byWork = index.territoriesByWork(store.territories.all());
    const ab = byWork.get('thr_ab') ?? [];
    assert.deepEqual(ab.map((r) => [r.territoryId, r.files]), [['t_core', 1]], 'AB changed one file of core');
    const view = codeView(ledger, store, project)!;
    const built = view.territories.find((t) => t.id === 't_core')!.builtBy.find((b) => b.workId === 'thr_ab')!;
    assert.equal(built.files, ab[0]!.files, 'the work’s jump and the territory’s Built by give the same number');
    assert.deepEqual([...built.commits].sort(), [...ab[0]!.commits].sort());

    // ── a path gone from the current version ──
    assert.deepEqual(index.gonePaths(['src/old', 'src/main.ts']), ['src/old']);
    const gone = codeAnomalyCandidates(ledger, store, project).find((c) => c.kind === 'Territory path gone');
    assert.ok(gone && gone.territoryId === 't_old' && gone.path === 'src/old' && gone.commit === cleanup.slice(0, 12), `the cross-check is told, with the commit that removed it: ${JSON.stringify(gone)}`);
    assert.ok(gone.detail.includes('1 of its 2 paths is no longer in the current version'), gone.detail);

    // ── the engines as the server uses them ──
    const engines = codeMapEngines(service);
    assert.deepEqual(engines.workTerritories(store, project)?.thr_ab?.map((r) => r.territoryId), ['t_core']);
    assert.deepEqual(engines.gonePaths(store, project), { t_old: ['src/old'] });
    const file = engines.fileText(project, { path: 'src/core/api.ts', repo: repo });
    assert.ok(file && typeof file !== 'string', `a file of the current version opens: ${JSON.stringify(file)}`);
    assert.equal(file.text, 'export const api = 2;\nexport const more = 3;\n', 'its text as the ledger’s current version has it');
    assert.equal(file.path, 'src/core/api.ts');
    const first = engines.fileText(project, { path: 'src/lib/long.ts' });
    assert.ok(first && typeof first !== 'string' && first.nextFromLine !== null && first.toLine < first.lines, 'a long file comes in pages');
    const next = engines.fileText(project, { path: 'src/lib/long.ts', fromLine: first.nextFromLine });
    assert.ok(next && typeof next !== 'string' && next.fromLine === first.nextFromLine && next.text.startsWith(`export const line${first.nextFromLine! - 1} =`), 'the next page follows on');
    assert.match(String(engines.fileText(project, { path: 'src/old/gone.ts' })), /not in the current version/, 'a file gone from the current version says so');

    // ── the process view carries each work's territories; Code carries notes and send-backs ──
    const kEngines = { ledger: { code: (s: ProjectStore, p: Project) => codeView(ledger!, s, p) } as never, codemap: engines };
    const proc = processView(store, project, kEngines);
    assert.deepEqual(proc.works.thr_ab!.territories?.map((t) => [t.territoryId, t.name, t.files]), [['t_core', 't_core', 1]]);
    assert.deepEqual(proc.works.thr_old!.territories?.map((t) => [t.territoryId, t.files]), [['t_lib', 1]], 'an earlier generation’s work still shows what it changed');
    assert.deepEqual(proc.works.thr_none!.territories, [], 'a work that changed no territory has none — the list is there, empty');
    assert.equal(processView(store, project).works.thr_ab!.territories, undefined, 'without the code map, nothing is claimed');
    const noteVersion = { version: 1, at: '2026-09-08T00:00:00Z', title: 'Is lib still needed?', preview: 'p', body: {}, ask: 'For your decision', judgementRecordId: 'j', reason: 'r' };
    store.notes.put({ id: 'note_lib', projectId: PID, mount: { kind: 'node', ids: ['ref_area'] }, status: 'Current', versions: [noteVersion] } as unknown as Note);
    const sb = { id: 'sb_lib', projectId: PID, to: 'Work', stage: 'Suggested', targetId: 't_lib', what: 'lib is referenced by nothing current', suggestion: 'decide', evidence: [{ kind: 'file', id: 'src/lib/util.ts', label: 'util.ts' }],
      from: { kind: 'code-anomaly', id: 't_lib' }, returned: null, closed: null, ownerResponse: null, sixThing: 6, occurred: { at: '2026-09-08', basis: 'First observed', anchor: null }, roundId: null, updatedAt: '' } as SendBack;
    store.sendbacks.put(sb);
    store.territories.put(territory('t_lib', ['src/lib'], { anomalies: [{ kind: 'Unreferenced', text: 'nothing current', evidence: [], basis: 'Inferred', sendBackId: 'sb_lib', noteIds: ['note_lib'], sixThing: 6 }] }));
    const code = codeViewOf(store, project, kEngines)!;
    const lib = code.territories.find((t) => t.id === 't_lib')!;
    assert.deepEqual(lib.anomalies[0]!.notes, [{ id: 'note_lib', title: 'Is lib still needed?', ask: 'For your decision', status: 'Current' }], 'the jump to the note names it');
    assert.equal(code.sendBacks?.sb_lib?.what, 'lib is referenced by nothing current', 'Code carries the send-back itself');
    assert.equal(code.sendBacks?.sb_lib?.onTerritory, true, 'and says it hangs on a territory, found in Code');
    assert.deepEqual(code.territories.find((t) => t.id === 't_old')!.gonePaths, ['src/old']);
    assert.equal(code.territories.find((t) => t.id === 't_core')!.gonePaths, undefined);
    assert.equal(code.territories.find((t) => t.id === 't_lib')!.currentUse, 'In use, not in current plan');
    await store.flush();
  } finally {
    ledger?.close();
    service.release();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
