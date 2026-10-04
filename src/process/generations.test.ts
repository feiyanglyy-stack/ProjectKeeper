/**
 * An earlier generation's band holds its plans (CKC-24 AC-18; Spec §2.12, D85, D82; QC AY B11): the `Plan` objects read
 * from its plan documents or planned into by its work — never the current plan — and, when the band is unrolled, each
 * plan document as it stood: a document since deleted from the version before its deletion, one rewritten in place from
 * the version it had when the generation ended.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Project, ReferenceItem, ScopeItem, Source, WorkThread } from '../model/types.ts';
import type { Generation } from '../model/k-types.ts';
import { ProjectStore } from '../store/project-store.ts';
import { LedgerService } from '../ledger/adapters.ts';
import { Ledger } from '../ledger/index.ts';
import { ledgerPath, rebuildLedgerInPlace } from '../ledger/rebuild.ts';
import { processView, registerKRoutes } from '../server/k-views.ts';
import type { App } from '../server/app.ts';
import { generationPlanDocs, generationPlanIds, generationPlanText } from './generations.ts';
import { processEngines } from './index.ts';

const git = (dir: string, args: string[], date: string) => execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.invalid', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const write = (dir: string, rel: string, body: string) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), body); };
const commit = (dir: string, message: string, date: string) => { git(dir, ['add', '-A'], date); git(dir, ['commit', '-q', '-m', message], date); return git(dir, ['rev-parse', 'HEAD'], date); };
const attribution = { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' };
const plan = (id: string, name: string, validity: string, sourceIds: string[]) => ({ id, projectId: 'gp', category: 'Plan', name, ids: [], text: name, quote: null, basis: 'Explicit', validity, progress: null, attribution, sourceIds, refines: [], replacedBy: null, inputs: null, asOf: '', updatedAt: '' }) as unknown as ReferenceItem;
const thread = (id: string, serves: string[]) => ({ id, projectId: 'gp', title: id, ids: [], serves: serves.map((referenceId) => ({ referenceId, claim: 'planned in it', basis: 'Explicit' })), dependsOn: [], progress: 'Done', validity: 'Replaced', replacedBy: null, unresolved: 'the restart', factRecordIds: [], executionFacts: [], qcFacts: [] }) as unknown as WorkThread;

test('a generation’s band carries its plan objects, and reads each plan document as it stood when the generation ended', async () => {
  const root = mkdtempSync(resolve('.generations-test-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const service = new LedgerService({ home: root });
  let ledger: Ledger | null = null;
  try {
    git(repo, ['init', '-q', '-b', 'main'], '2026-09-01T09:00:00Z');
    write(repo, 'docs/plan-v1.md', '# Plan v1\n\n## Batch 1\n\nThe tag browser.\n');
    write(repo, 'docs/ROADMAP.md', '# Roadmap\n\nFirst: tags.\n');
    commit(repo, 'Plan v1', '2026-09-01T09:00:00Z');
    write(repo, 'docs/plan-v1.md', '# Plan v1\n\n## Batch 1\n\nThe tag browser.\n\n## Batch 2\n\nTag colours.\n');
    commit(repo, 'Plan v1: batch 2', '2026-09-03T09:00:00Z');
    rmSync(join(repo, 'docs/plan-v1.md'));
    write(repo, 'docs/plan-v2.md', '# Plan v2\n\nSearch replaces the tag browser.\n');
    const cleanup = commit(repo, 'Restart: plan v2 replaces plan v1', '2026-09-05T09:00:00Z');
    write(repo, 'docs/ROADMAP.md', '# Roadmap\n\nFirst: search.\n');
    commit(repo, 'Roadmap follows v2', '2026-09-06T09:00:00Z');

    const scope = { id: 'repo', path: repo, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as ScopeItem;
    const project = { id: 'gp', name: 'Tags', locations: [repo], scope: [scope], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: '', lastOpenedAt: null, lastScopedAt: null } as unknown as Project;
    rebuildLedgerInPlace(ledgerPath('gp', root), project);
    ledger = Ledger.openPath(ledgerPath('gp', root))!;
    const store = ProjectStore.open('gp', root);
    // The old plan was read from history (a revision source); the current plan from the file as it is.
    store.sources.put({ id: 'src_v1', projectId: 'gp', title: 'plan v1 (history)', anchor: { kind: 'revision', repo, path: 'docs/plan-v1.md', commit: '', headingPath: [], lineStart: 1, lineEnd: 9 } } as unknown as Source);
    store.sources.put({ id: 'src_v2', projectId: 'gp', title: 'plan v2', anchor: { kind: 'file', path: join(repo, 'docs', 'plan-v2.md'), headingPath: [], lineStart: 1, lineEnd: 3 }, availability: null } as unknown as Source);
    store.reference.putMany([plan('ref_v1', 'Plan v1', 'Replaced', ['src_v1']), plan('ref_v2', 'Plan v2', 'Current', ['src_v2']), plan('ref_roadmap_old', 'Roadmap: tags first', 'Replaced', [])]);
    // Its work served the old plan — and the current one, which must stay out of the band.
    store.threads.putMany([thread('thr_tags', ['ref_v1', 'ref_v2']), thread('thr_colours', ['ref_roadmap_old'])]);
    const g: Generation = {
      id: 'gen_v1', projectId: 'gp', name: 'Plan v1 (tags)', started: null, ended: { at: '2026-09-05', basis: 'Commit', anchor: `commit:${cleanup.slice(0, 12)}` },
      endedBy: { kind: 'commit', id: cleanup, label: 'Restart: plan v2 replaces plan v1' },
      planRefs: [{ kind: 'file', id: 'docs/plan-v1.md', label: 'Plan v1 (deleted)' }, { kind: 'file', id: 'docs/ROADMAP.md', label: 'Roadmap as it stood' }, { kind: 'commit', id: cleanup, label: 'the restart commit' }],
      workIds: ['thr_tags', 'thr_colours'], roundId: null, updatedAt: '',
    };
    store.generations.put(g);

    assert.deepEqual(generationPlanIds(store, g), ['ref_v1', 'ref_roadmap_old'], 'the plan read from its deleted document and the plan its work was planned in; never the current plan');
    assert.deepEqual(generationPlanDocs(store, g).map((d) => [d.index, d.label, d.path]), [[0, 'Plan v1 (deleted)', 'docs/plan-v1.md'], [1, 'Roadmap as it stood', 'docs/ROADMAP.md'], [2, 'the restart commit', null]]);
    const band = processView(store, project).generations[0]!;
    assert.deepEqual(band.planIds, ['ref_v1', 'ref_roadmap_old'], 'the band carries its plans (planIds were always empty)');
    assert.deepEqual(band.plans, [{ id: 'ref_v1', name: 'Plan v1', validity: 'Replaced' }, { id: 'ref_roadmap_old', name: 'Roadmap: tags first', validity: 'Replaced' }], 'named, so the band shows them whether or not the graph draws them');
    assert.equal(band.planDocs?.length, 3);

    const deleted = generationPlanText(ledger, store, g, 0)!;
    assert.equal(deleted.text, '# Plan v1\n\n## Batch 1\n\nThe tag browser.\n\n## Batch 2\n\nTag colours.\n', 'the deleted plan, from the version before its deletion');
    assert.ok(deleted.deleted && deleted.deleted.commit.length >= 7 && cleanup.startsWith(deleted.deleted.commit), `and the commit that deleted it: ${JSON.stringify(deleted.deleted)}`);
    assert.equal(deleted.current, false);
    assert.equal(deleted.fromLine, 1);
    const page = generationPlanText(ledger, store, g, 0, 5)!;
    assert.deepEqual([page.fromLine, page.text?.split('\n')[0], page.truncated], [5, 'The tag browser.', true], 'a later page starts where it was asked to, and says it is a page');
    const roadmap = generationPlanText(ledger, store, g, 1)!;
    assert.equal(roadmap.text, '# Roadmap\n\nFirst: tags.\n', 'a document rewritten after the generation ended is read as it stood at the end');
    assert.equal(roadmap.deleted, null);
    const commitRef = generationPlanText(ledger, store, g, 2)!;
    assert.equal(commitRef.text, null);
    assert.match(commitRef.why ?? '', /names no document/);
    assert.equal(generationPlanText(ledger, store, g, 3), null);

    // The route, through the process engine the app wires.
    const routes = new Map<string, (req: { params: Record<string, string>; query: URLSearchParams }) => unknown>();
    const app = { store: () => store, project: () => project, ledger: service, kEngines: { process: processEngines(service) } } as unknown as App;
    registerKRoutes({ route: (m: string, p: string, h: never) => routes.set(`${m} ${p}`, h) } as never, app);
    const route = routes.get('GET /api/projects/:id/generations/:gid/plans/:n')!;
    const viaRoute = route({ params: { id: 'gp', gid: 'gen_v1', n: '0' }, query: new URLSearchParams() }) as { text: string };
    assert.equal(viaRoute.text, deleted.text);
    assert.throws(() => route({ params: { id: 'gp', gid: 'gen_v1', n: '7' }, query: new URLSearchParams() }), /has no plan document 7/);
    assert.throws(() => route({ params: { id: 'gp', gid: 'gen_nope', n: '0' }, query: new URLSearchParams() }), /Unknown generation/);
    await store.flush();
  } finally {
    ledger?.close();
    service.release();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
