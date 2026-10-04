/**
 * What the organizing works on, and when it counts as new (Spec §3.7; CKC-13):
 *
 * - A repository's commits are as recent as its latest commit, and the time of a commit is the one intake records on
 *   the commit's anchor — never parsed back out of the excerpt intake wrote for people to read. A later change to how
 *   that excerpt is written, redacted or cut must not turn the commits made before the takeover into new material that
 *   the round after the first claims whole (D1; the fix in 9f7d808 read the "at:" line of the excerpt).
 * - The documents a project's tests keep as fixtures — a made-up project with its own plan, status and README under a
 *   fixtures folder — are the test side's, like the code beside them: they do not frame the project, are not where it
 *   writes its rules, and are not organized as its documents afterwards (D1; seen on a trial of 2026-09-21, where three
 *   such documents were claimed by round 1 as the project's plan and status).
 *
 * The fixtures are an invented project, "Atlas", a small map-tile viewer, whose tests keep a made-up shop, "toy-bakery".
 * Each test was run on the code before this change first and failed there for the reason it names; the assertions
 * about records written before the anchor carried the time, and about the project's own documents, passed there too,
 * as they must.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../../store/project-store.ts';
import { listMaterials } from './materials.ts';
import { focusedLevel } from './takeover.ts';
import { commitSources } from '../../sources/gitobs.ts';
import { commitFacts } from '../../context/code-source.ts';
import type { Project, ScopeItem, Source } from '../../model/types.ts';

const ROOT = 'D:\\atlas';
const TAKEOVER = '2026-09-20T00:00:00.000Z';
const READ_AT = '2026-09-21T09:00:00.000Z';   // intake read the commits after the takeover started

const store = () => ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-materials-')));
const project = (over: Partial<Project> = {}): Project =>
  ({ id: 'p1', name: 'Atlas', locations: [ROOT], createdAt: TAKEOVER, scope: [{ id: 'scope_main', path: ROOT, relation: 'Main project', category: 'Repository', addedBy: 'owner' }], roles: [], language: 'en', ...over }) as unknown as Project;
const commit = (s: ProjectStore, id: string, repo: string, excerpt: string, at?: string) =>
  s.sources.put({
    id, projectId: 'p1', title: `${id} commit`, anchor: { kind: 'commit', repo, commit: id.padEnd(40, '0'), ...(at ? { at } : {}) }, ids: [],
    version: { fingerprint: `f-${id}`, readAt: READ_AT, commit: id.padEnd(40, '0') }, excerpt, usedAs: null, usedAsBy: null, availability: null,
    movedTo: null, scopeItemId: 'scope_main', hasCredential: false, bytes: excerpt.length,
  } as Source);
const commitsOf = (s: ProjectStore, repo: string) => listMaterials(s, project()).find((m) => m.kind === 'commits' && m.ref === repo);
const file = (s: ProjectStore, rel: string) =>
  s.sources.put({
    id: `src_${rel.replace(/[^a-z0-9]+/gi, '_')}`, projectId: 'p1', title: rel, anchor: { kind: 'file', path: `${ROOT}\\${rel.replace(/\//g, '\\')}`, headingPath: [], lineStart: 1, lineEnd: 9 }, ids: [],
    version: { fingerprint: `f-${rel}`, readAt: READ_AT, commit: null }, excerpt: `text of ${rel}`, usedAs: null, usedAsBy: null, availability: null,
    movedTo: null, scopeItemId: 'scope_main', hasCredential: false, bytes: 20,
  } as Source);

test('a commit is as old as the time on its anchor, whatever its excerpt shows; one made before the takeover is history (D1; Spec §3.7)', () => {
  const s = store();
  commit(s, 'a1', `${ROOT}\\a`, 'Cache tiles on disk\n\nauthor: Atlas Dev\nfiles:\n  src/cache.ts', '2026-09-01T10:00:00+02:00');   // no "at:" line
  commit(s, 'b1', `${ROOT}\\b`, 'Draw the scale bar\n\nauthor: Atlas Dev\ndate: 2026-09-02\nfiles:\n  src/scale.ts', '2026-09-02T08:00:00Z');   // written another way
  for (const repo of [`${ROOT}\\a`, `${ROOT}\\b`]) {
    const m = commitsOf(s, repo);
    assert.ok(m, `the commits of ${repo} are a material`);
    assert.equal(m.tier, 'history', `${repo}: made before the takeover, so history that waits for the depth — not new because it was read after it`);
  }
  assert.equal(commitsOf(s, `${ROOT}\\a`)!.recency, '2026-09-01T08:00:00.000Z', 'as recent as the time the anchor records');
});

test('a commit the anchor gives no time for is not made new by when it was read; records written before the anchor carried the time keep the time their excerpt gives (D1)', () => {
  const s = store();
  // Written before the anchor carried the time: the excerpt is the one intake wrote then, and its "at:" line is kept.
  commit(s, 'c1', `${ROOT}\\c`, 'Pan with the arrow keys\n\nauthor: Atlas Dev\nat: 2026-09-03T12:00:00+00:00\nfiles:\n  src/keys.ts');
  commit(s, 'c2', `${ROOT}\\c`, 'Zoom with the wheel\n\nauthor: Atlas Dev\nat: 2026-09-25T12:00:00+00:00\nfiles:\n  src/wheel.ts');
  const c = commitsOf(s, `${ROOT}\\c`)!;
  assert.equal(c.recency, '2026-09-25T12:00:00.000Z', 'an older record keeps the time its excerpt gives');
  assert.equal(c.tier, 'active', 'and a commit made after the takeover started is daily work');
  // No time anywhere: nothing says it is new.
  commit(s, 'd1', `${ROOT}\\d`, 'Tidy the tile loader');
  const d = commitsOf(s, `${ROOT}\\d`)!;
  assert.equal(d.tier, 'history', 'a commit with no recorded time is not new material because intake read it after the takeover');
});

test('intake writes each commit’s time on its anchor, and the commit lines of a context pack take it from there (D1)', () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-materials-home-'));
  writeFileSync(join(home, 'gitconfig'), '');
  const repo = mkdtempSync(join(tmpdir(), 'pk-atlas-'));
  const when = '2026-09-10T15:30:00+00:00';
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', HOME: home, USERPROFILE: home, GIT_AUTHOR_NAME: 'Atlas Dev', GIT_AUTHOR_EMAIL: 'dev@atlas.invalid', GIT_COMMITTER_NAME: 'Atlas Dev', GIT_COMMITTER_EMAIL: 'dev@atlas.invalid', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Atlas\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Atlas: first version');
  const item = { id: 'scope_repo', path: repo, category: 'Repository', relation: 'Main project' } as ScopeItem;
  const [read] = commitSources('p1', item, null);
  assert.ok(read);
  const anchor = read.anchor as { kind: string; at?: string };
  assert.equal(anchor.kind, 'commit');
  assert.ok(anchor.at, 'the anchor records when the commit was made');
  assert.equal(Date.parse(anchor.at!), Date.parse(when));

  // Whatever becomes of the excerpt later — another layout, redaction, a cut — the time stays on the anchor.
  const reworded: Source = { ...read, excerpt: 'Atlas: first version' };
  const s = store();
  s.sources.put(reworded);
  const m = listMaterials(s, project({ locations: [repo], scope: [item] })).find((x) => x.kind === 'commits');
  assert.equal(m?.tier, 'history', 'a commit made before the takeover stays history');
  assert.equal(Date.parse(commitFacts(reworded).at ?? ''), Date.parse(when), 'the pack’s commit line gives the time the anchor records');
});

test('a test fixture’s plan, status and README do not frame the project and are not where it writes its rules; its own documents of those names are (D1; Spec §3.7)', () => {
  const s = store();
  const own = ['README.md', 'AGENTS.md', 'docs/plan.md', 'docs/status.md'];
  const fixtures = [
    'tests/fixtures/toy-bakery/README.md', 'tests/fixtures/toy-bakery/docs/plan.md', 'tests/fixtures/toy-bakery/STATUS.md', 'tests/fixtures/toy-bakery/AGENTS.md',
    'fixtures/README.md', 'pkg/tiles/testdata/plan.md', 'src/__fixtures__/orders/README.md', 'test/Fixtures/status.md',
  ];
  for (const rel of [...own, ...fixtures]) file(s, rel);
  const byRel = new Map(listMaterials(s, project()).map((m) => [m.rel.replace(/\\/g, '/'), m]));
  for (const rel of fixtures) {
    const m = byRel.get(rel);
    assert.ok(m, `${rel} is read, as the code beside it is`);
    assert.equal(m.frame, null, `${rel}: a document the tests keep as a fixture does not frame the project`);
    assert.equal(m.rulesSource, false, `${rel}: nor is it where the project writes its rules`);
    assert.equal(m.intent, false, `${rel}: nor is it the project’s intent material`);
  }
  for (const rel of own) assert.notEqual(byRel.get(rel)?.frame ?? null, null, `${rel}: the project’s own document frames it`);
  assert.equal(byRel.get('README.md')?.rulesSource, true, 'and its own README is where it writes its rules');
});

test('after round 1 a test fixture’s documents are organized as the code beside them is, not as the project’s documents (D1; Spec §3.7)', () => {
  const level = (rel: string) => focusedLevel({ kind: 'file', rel, key: `file:${rel}` }, []);
  assert.equal(level('tests/fixtures/toy-bakery/STATUS.md'), level('src/viewer.ts'), 'under Focused, a fixture’s status report is indexed, as code is');
  assert.equal(level('tests/fixtures/toy-bakery/docs/review-notes.md'), 'Indexed');
  assert.equal(level('docs/status.md'), 'Read in full', 'the project’s own status report is read in full');
});
