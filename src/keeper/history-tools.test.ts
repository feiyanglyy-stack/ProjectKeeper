/**
 * The Keeper reads old content from version history (Spec §1.2 `History only`, §3.1; CKC-03 AC-24), and what it reads
 * stays history (Spec §2.6; CKC-02 AC-23; D61): it forms no current node, is never pending material, and its label
 * cannot be turned into a current one. Every refusal is paired with the write that must go through.
 *
 * The fixture is an invented project, "Ledger", a small invoicing tool, built as a real git repository in a temporary
 * directory: a design document that was deleted, a plan revised over three commits, a document that was only renamed,
 * one deleted and added back, and a worktree branch merged into main whose earlier version of a file exists only in
 * history. Only read-only git commands may run against it; one test hands the tool a ref shaped like an option.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Nothing here may look at the real home: intake would otherwise list the real session folders.
const fakeHome = mkdtempSync(join(tmpdir(), 'pk-hist-home-'));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

const { ProjectStore } = await import('../store/project-store.ts');
const { keeperTools } = await import('./tools.ts');
const { recomputeCoverage } = await import('../intake/intake.ts');
const { listMaterials } = await import('./organize/materials.ts');
const { stepToolsFor, toolsFor } = await import('./roles.ts');
type Project = import('../model/types.ts').Project;
type ScopeItem = import('../model/types.ts').ScopeItem;
type Source = import('../model/types.ts').Source;
type ToolContext = import('./tools.ts').ToolContext;

const AT = '2026-09-17T00:00:00.000Z';
const ENV = { GIT_AUTHOR_NAME: 'Ledger Dev', GIT_AUTHOR_EMAIL: 'dev@ledger.invalid', GIT_COMMITTER_NAME: 'Ledger Dev', GIT_COMMITTER_EMAIL: 'dev@ledger.invalid' };

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(root: string, rel: string, text: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}
function commit(cwd: string, message: string, date: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(cwd, ['rev-parse', 'HEAD']);
}

interface Repo {
  readonly root: string; readonly worktree: string;
  readonly c: Record<'first' | 'planV2' | 'dropSync' | 'pdfDraft' | 'pdfFinal' | 'merge' | 'planV3' | 'moveExport' | 'dropReadme' | 'readmeBack', string>;
}

/** Ledger's history, oldest first. */
function buildRepo(): Repo {
  const base = mkdtempSync(join(tmpdir(), 'pk-hist-'));
  const root = join(base, 'ledger');
  mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  write(root, 'README.md', '# Ledger\n\nA small invoicing tool.\n');
  write(root, 'docs/PLAN.md', '# Plan\n\nPlan v1: export invoices as CSV.\n');
  write(root, 'docs/design/EXPORT.md', '# Export design\n\nCSV only, one row per invoice line.\n');
  write(root, 'docs/design/SYNC.md', '# Sync design\n\nPull bank statements every night and match them to invoices.\n');
  write(root, 'src/sync.ts', 'export const sync = () => 0;\n');
  const first = commit(root, 'Start Ledger with a plan and two designs', '2026-09-01T09:00:00+08:00');
  write(root, 'docs/PLAN.md', '# Plan\n\nPlan v2: export invoices as CSV and PDF.\n');
  const planV2 = commit(root, 'Plan v2 adds PDF export', '2026-09-03T09:00:00+08:00');
  rmSync(join(root, 'docs/design/SYNC.md'));
  rmSync(join(root, 'src/sync.ts'));
  const dropSync = commit(root, 'Drop the bank sync: not needed', '2026-09-05T09:00:00+08:00');
  git(root, ['checkout', '-q', '-b', 'feature-pdf']);
  write(root, 'docs/design/PDF.md', '# PDF export design\n\nDraft: render with the system print dialog.\n');
  const pdfDraft = commit(root, 'PDF export design, first draft', '2026-09-06T09:00:00+08:00');
  write(root, 'docs/design/PDF.md', '# PDF export design\n\nFinal: render server-side with a fixed template.\n');
  const pdfFinal = commit(root, 'PDF export design, final', '2026-09-07T09:00:00+08:00');
  git(root, ['checkout', '-q', 'main']);
  git(root, ['merge', '-q', '--no-ff', '-m', 'Merge the PDF export design', 'feature-pdf'], { GIT_AUTHOR_DATE: '2026-09-08T09:00:00+08:00', GIT_COMMITTER_DATE: '2026-09-08T09:00:00+08:00' });
  const merge = git(root, ['rev-parse', 'HEAD']);
  write(root, 'docs/PLAN.md', '# Plan\n\nPlan v3: export invoices as CSV and PDF, and e-mail them.\n');
  const planV3 = commit(root, 'Plan v3 adds e-mail', '2026-09-09T09:00:00+08:00');
  mkdirSync(join(root, 'docs/design/archive'), { recursive: true });
  renameSync(join(root, 'docs/design/EXPORT.md'), join(root, 'docs/design/archive/EXPORT.md'));
  const moveExport = commit(root, 'Archive the export design', '2026-09-10T09:00:00+08:00');
  rmSync(join(root, 'README.md'));
  const dropReadme = commit(root, 'Remove README for a rewrite', '2026-09-11T09:00:00+08:00');
  write(root, 'README.md', '# Ledger\n\nInvoicing for small shops.\n');
  const readmeBack = commit(root, 'README rewritten', '2026-09-12T09:00:00+08:00');
  const worktree = join(base, 'ledger-pdf');
  git(root, ['worktree', 'add', '-q', worktree, 'feature-pdf']);
  return { root, worktree, c: { first, planV2, dropSync, pdfDraft, pdfFinal, merge, planV3, moveExport, dropReadme, readmeBack } };
}

const scopeItem = (id: string, path: string, extra: Partial<ScopeItem> = {}): ScopeItem => ({
  id, path, category: 'Repository', relation: 'Main project', reason: 'Owner-given location; git repository', reasonSourceIds: [],
  sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner', ...extra,
});

interface Harness {
  readonly store: import('../store/project-store.ts').ProjectStore;
  readonly project: Project;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean; json: Record<string, unknown> }>;
}

function harness(repo: Repo | null): Harness {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-hist-store-')));
  const scope = repo ? [scopeItem('scope_main', repo.root), scopeItem('scope_pdf', repo.worktree, { category: 'Worktree', relation: 'Worktree of main repo', worktreeOf: repo.root, addedBy: 'keeper' })] : [];
  const project = { id: 'p1', name: 'Ledger', language: 'en', locations: repo ? [repo.root] : ['D:\\ledger'], scope, scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false, createdAt: AT, lastOpenedAt: null, lastScopedAt: null } as Project;
  const ctx: ToolContext = { store, project, jobId: 'job_1', jobKind: 'Organizing', model: null };
  const tools = keeperTools(ctx);
  return {
    store, project,
    async call(name, args) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `no tool ${name}: the Keeper cannot read version history`);
      const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
      const result = await run('call', args);
      const text = result.content.map((c) => c.text).join('\n');
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a refusal is prose */ }
      return { text, error: result.isError === true, json };
    },
  };
}

const fileSource = (store: import('../store/project-store.ts').ProjectStore, id: string, path: string, extra: Partial<Source> = {}) =>
  store.sources.put({ id, projectId: 'p1', title: path.split(/[\\/]/).pop()!, anchor: { kind: 'file', path, headingPath: [], lineStart: 1, lineEnd: 9 }, ids: [], version: { fingerprint: `f-${id}`, readAt: AT, commit: null }, excerpt: `text of ${id}`, usedAs: null, usedAsBy: null, availability: null, movedTo: null, scopeItemId: 'scope_main', hasCredential: false, bytes: 10, ...extra } as Source);

/** A source read out of version history, put straight into the store: the guards hold whatever made it. */
const historySource = (store: import('../store/project-store.ts').ProjectStore, id: string, path: string) =>
  store.sources.put({ id, projectId: 'p1', title: `${path} (old)`, anchor: { kind: 'revision', repo: 'D:\\ledger', commit: 'a'.repeat(40), path } as unknown as Source['anchor'], ids: [], version: { fingerprint: `f-${id}`, readAt: AT, commit: 'a'.repeat(40) }, excerpt: `old text of ${path}`, usedAs: 'History only', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: 'scope_main', hasCredential: false, bytes: 10 } as Source);

const repo = buildRepo();

// ───────────────────────── reading history (CKC-03 AC-24) ─────────────────────────

test('the history of a path lists every commit that touched it, and a deleted document’s includes the commit that deleted it (CKC-03 AC-24)', async () => {
  const h = harness(repo);
  const plan = await h.call('pk_history_log', { path: 'docs/PLAN.md' });
  assert.equal(plan.error, false, plan.text);
  const commits = plan.json.commits as { commit: string; subject: string; change: string; readAt: string }[];
  assert.deepEqual(commits.map((c) => c.commit), [repo.c.planV3, repo.c.planV2, repo.c.first], 'newest first, the three versions of the plan');
  assert.deepEqual(commits.map((c) => c.change), ['Modified', 'Modified', 'Added']);
  assert.equal(commits[1]!.readAt, repo.c.planV2, 'each version is read at its own commit');

  const sync = await h.call('pk_history_log', { path: 'docs/design/SYNC.md' });
  assert.equal(sync.error, false, sync.text);
  const syncCommits = sync.json.commits as { commit: string; change: string; readAt: string; subject: string }[];
  assert.equal(syncCommits[0]!.commit, repo.c.dropSync, 'the deletion is in the history');
  assert.equal(syncCommits[0]!.change, 'Deleted');
  assert.equal(syncCommits[0]!.subject, 'Drop the bank sync: not needed');
  assert.equal(syncCommits[0]!.readAt, repo.c.planV2, 'what was deleted is read at the last commit that still had it');

  const renamed = await h.call('pk_history_log', { path: 'docs/design/EXPORT.md' });
  assert.equal(renamed.error, false, renamed.text);
  const moved = (renamed.json.commits as { commit: string; change: string; to?: string }[])[0]!;
  assert.equal(moved.commit, repo.c.moveExport);
  assert.equal(moved.change, 'Renamed', 'a move is not a deletion');
  assert.equal(moved.to, 'docs/design/archive/EXPORT.md');

  const never = await h.call('pk_history_log', { path: 'docs/NEVER.md' });
  assert.equal(never.error, false, never.text);
  assert.deepEqual(never.json.commits, [], 'a path nothing ever touched has an empty history, not an error');
});

test('an old version or a deleted file read from history becomes a History only source anchored at repository, commit and path (CKC-03 AC-24; Spec §1.2)', async () => {
  const h = harness(repo);
  const atDeletion = await h.call('pk_history_read', { path: 'docs/design/SYNC.md', commit: repo.c.dropSync });
  assert.equal(atDeletion.error, true, atDeletion.text);
  assert.match(atDeletion.text, /deleted/i);
  assert.ok(atDeletion.text.includes(repo.c.planV2.slice(0, 10)), 'the refusal names where the last version is');
  assert.equal(h.store.sources.size, 0, 'a refused read records nothing');

  const deleted = await h.call('pk_history_read', { path: 'docs/design/SYNC.md', commit: repo.c.planV2 });
  assert.equal(deleted.error, false, deleted.text);
  assert.match(String(deleted.json.text), /Pull bank statements every night/);
  const saved = h.store.sources.get(String(deleted.json.id))!;
  assert.ok(saved, 'the read is a source the Keeper can cite');
  assert.equal(saved.usedAs, 'History only');
  assert.deepEqual(saved.anchor, { kind: 'revision', repo: repo.root, commit: repo.c.planV2, path: 'docs/design/SYNC.md' });
  assert.equal(saved.version.commit, repo.c.planV2);
  assert.match(saved.excerpt, /Pull bank statements every night/);
  assert.equal(saved.availability, null);

  const v1 = await h.call('pk_history_read', { path: 'docs\\PLAN.md', commit: repo.c.first.slice(0, 12) });
  assert.equal(v1.error, false, v1.text);
  assert.match(String(v1.json.text), /Plan v1: export invoices as CSV\./);
  assert.equal(h.store.sources.get(String(v1.json.id))!.anchor.kind, 'revision');
  assert.equal((h.store.sources.get(String(v1.json.id))!.anchor as unknown as { commit: string }).commit, repo.c.first, 'an abbreviated commit is anchored by its full hash');

  const again = await h.call('pk_history_read', { path: 'docs/PLAN.md', commit: repo.c.first });
  assert.equal(again.json.id, v1.json.id, 'reading the same version again is the same source');

  // The version that is the current content is not history: nothing is recorded as History only.
  const before = h.store.sources.size;
  const current = await h.call('pk_history_read', { path: 'docs/PLAN.md', commit: 'HEAD' });
  assert.equal(current.error, false, current.text);
  assert.equal(current.json.current, true, current.text);
  assert.equal(h.store.sources.size, before, 'the current version is read as current material, not as History only');
});

test('an old file of a worktree branch already merged into main reads from the shared history (CKC-03 AC-24)', async () => {
  const h = harness(repo);
  const draft = await h.call('pk_history_read', { repo: 'scope_pdf', path: 'docs/design/PDF.md', commit: 'feature-pdf~1' });
  assert.equal(draft.error, false, draft.text);
  assert.match(String(draft.json.text), /Draft: render with the system print dialog/);
  const saved = h.store.sources.get(String(draft.json.id))!;
  assert.equal(saved.usedAs, 'History only');
  assert.deepEqual(saved.anchor, { kind: 'revision', repo: repo.root, commit: repo.c.pdfDraft, path: 'docs/design/PDF.md' }, 'the repository of a worktree’s history is the main repository');
  const final = await h.call('pk_history_read', { path: join(repo.worktree, 'docs', 'design', 'PDF.md'), commit: repo.c.pdfFinal });
  assert.equal(final.error, false, final.text);
  assert.equal(final.json.current, true, 'the merged final version is what the project has now');
});

test('reading history runs read-only git only: a ref shaped like an option, an unknown ref and a path outside the repository are refused (CKC-03 AC-24; Spec §1.1)', async () => {
  const h = harness(repo);
  const target = join(repo.root, 'written-by-git.txt');
  const option = await h.call('pk_history_read', { path: 'docs/PLAN.md', commit: `--output=${target}` });
  assert.equal(option.error, true, option.text);
  assert.match(option.text, /commit/i);
  assert.equal(existsSync(target), false, 'nothing was written into the project');
  const unknown = await h.call('pk_history_read', { path: 'docs/PLAN.md', commit: 'no-such-branch' });
  assert.equal(unknown.error, true, unknown.text);
  assert.match(unknown.text, /no-such-branch/);
  const outside = await h.call('pk_history_read', { path: '../outside.md', commit: repo.c.first });
  assert.equal(outside.error, true, outside.text);
  const log = await h.call('pk_history_log', { path: 'docs/PLAN.md', repo: 'scope_nowhere' });
  assert.equal(log.error, true, log.text);
  assert.match(log.text, /scope_nowhere/);
  assert.equal(git(repo.root, ['status', '--porcelain']), '', 'the repository is exactly as it was');
});

test('the deleted documents of main’s history are listed by directory with the last commit they appear in; a move and a document added back are not deletions (CKC-03 AC-24; Spec §2.6)', async () => {
  const h = harness(repo);
  const docs = await h.call('pk_history_deleted', {});
  assert.equal(docs.error, false, docs.text);
  const dirs = docs.json.directories as { dir: string; count: number; files: { path: string; deletedIn: { commit: string; subject: string } | string; lastPresentIn: string }[] }[];
  const all = dirs.flatMap((d) => d.files.map((f) => f.path));
  assert.deepEqual(all, ['docs/design/SYNC.md'], 'only what is gone from the current version: not the renamed export design, not the README added back, not code');
  const design = dirs.find((d) => d.dir === 'docs/design')!;
  assert.equal(design.count, 1);
  const sync = design.files[0]!;
  assert.equal((sync.deletedIn as { commit: string }).commit, repo.c.dropSync);
  assert.equal((sync.deletedIn as { subject: string }).subject, 'Drop the bank sync: not needed');
  assert.equal(sync.lastPresentIn, repo.c.planV2);

  const everything = await h.call('pk_history_deleted', { all: true });
  assert.equal(everything.error, false, everything.text);
  const allPaths = (everything.json.directories as { files: { path: string }[] }[]).flatMap((d) => d.files.map((f) => f.path)).sort();
  assert.deepEqual(allPaths, ['docs/design/SYNC.md', 'src/sync.ts'], 'every kind of file on request');
});

// ───────────────────────── history stays history (CKC-02 AC-23; D61) ─────────────────────────

test('what exists only in history is never pending material and never counted in coverage (CKC-02 AC-23; Spec §1.2)', async () => {
  const h = harness(null);
  const root = 'D:\\ledger';
  const project = { ...h.project, scope: [scopeItem('scope_main', root, { category: 'Directory', versionControl: 'none' })] } as Project;
  historySource(h.store, 'src_old_plan', 'docs/PLAN.md');
  fileSource(h.store, 'src_attic', `${root}\\attic\\export-v1.md`);
  fileSource(h.store, 'src_plan', `${root}\\docs\\PLAN.md`);
  const set = await h.call('pk_set_used_as', { sourceId: 'src_attic', usedAs: 'History only' });
  assert.equal(set.error, false, set.text);

  const coverage = recomputeCoverage(h.store, project);
  const pending = coverage.scopes.find((s) => s.id === 'project')!.pending.map((m) => m.ref);
  assert.ok(pending.some((ref) => ref.endsWith('PLAN.md') && ref.startsWith(root)), 'current material still waits to be organized');
  assert.ok(!pending.some((ref) => ref.includes('attic')), 'a file kept only for recovery is not pending');
  assert.ok(!pending.some((ref) => ref.includes('src_old_plan') || ref === 'docs/PLAN.md'), 'an old version read from history is not pending');
  const counted = Object.values(coverage.pendingByKind).reduce((n, v) => n + v, 0);
  assert.equal(counted, 1, 'the pending count holds the current plan only');

  const materials = listMaterials(h.store, project).map((m) => m.ref);
  assert.ok(materials.some((ref) => ref.endsWith('PLAN.md')), 'the current plan is material to organize');
  assert.ok(!materials.some((ref) => ref.includes('attic')), 'History only material is not planned for organizing');
});

test('History only material forms no current node: no work item, no relation endpoint, no rule in force rests on it (CKC-02 AC-23; D61)', async () => {
  const h = harness(null);
  historySource(h.store, 'src_old_sync', 'docs/design/SYNC.md');
  fileSource(h.store, 'src_ui', 'D:\\ledger\\docs\\ui\\SYNC-UI.md', { usedAs: 'Design', usedAsBy: 'keeper' });
  fileSource(h.store, 'src_agents', 'D:\\ledger\\AGENTS.md', { usedAs: 'Other', usedAsBy: 'keeper', excerpt: 'Tasks are numbered L-1, L-2 and so on.' });

  const oldFact = await h.call('pk_write_fact_record', { title: 'What the old sync design said', aboutSourceIds: ['src_old_sync'], statements: [{ type: 'Observed', text: 'The old design pulled statements nightly.', sourceIds: ['src_old_sync'] }] });
  assert.equal(oldFact.error, false, 'a fact record of what an old version said is allowed: it is the Keeper’s memory, not a node');
  const uiFact = await h.call('pk_write_fact_record', { title: 'The sync screen', aboutSourceIds: ['src_ui'], statements: [{ type: 'Observed', text: 'The screen shows the last sync.', sourceIds: ['src_ui'] }] });
  assert.equal(uiFact.error, false, uiFact.text);

  const fromHistory = await h.call('pk_write_thread', { title: 'L-9 · nightly bank sync', ids: ['L-9'], factRecordIds: [oldFact.json.id], progress: 'Planned' });
  assert.equal(fromHistory.error, true, fromHistory.text);
  assert.match(fromHistory.text, /History only/);
  assert.equal(h.store.threads.size, 0, 'no work item was written from history');
  const current = await h.call('pk_write_thread', { title: 'L-3 · sync screen', ids: ['L-3'], factRecordIds: [uiFact.json.id], progress: 'In progress' });
  assert.equal(current.error, false, current.text);

  const ref = await h.call('pk_write_reference', { category: 'Design', name: 'Sync screen design', text: 'The screen shows the last sync.', basis: 'Explicit', validity: 'Current', identity: 'Artifact', sourceIds: ['src_ui'] });
  assert.equal(ref.error, false, ref.text);
  const endpoint = await h.call('pk_relate', { type: 'refines', fromId: 'src_old_sync', toId: ref.json.id, claim: 'the old design details the screen', basis: 'Inferred' });
  assert.equal(endpoint.error, true, endpoint.text);
  assert.match(endpoint.text, /History only/);
  const asEvidence = await h.call('pk_relate', { type: 'serves', fromId: current.json.id, toId: ref.json.id, claim: 'L-3 builds the screen', basis: 'Explicit', evidenceSourceIds: ['src_ui', 'src_old_sync'] });
  assert.equal(asEvidence.error, false, 'history can be cited as evidence next to current material');

  const oldRule = await h.call('pk_write_rule', { group: 'Working rules', summary: 'Tasks were numbered S-n.', excerpt: 'old text of docs/design/SYNC.md', sourceIds: ['src_old_sync'], appliesTo: ['task numbering'], basis: 'Explicit' });
  assert.equal(oldRule.error, true, oldRule.text);
  assert.match(oldRule.text, /History only/);
  const rule = await h.call('pk_write_rule', { group: 'Working rules', summary: 'Tasks are numbered L-n.', excerpt: 'Tasks are numbered L-1, L-2 and so on.', sourceIds: ['src_agents'], appliesTo: ['task numbering'], basis: 'Explicit' });
  assert.equal(rule.error, false, rule.text);
});

test('a source read from version history stays History only: its label cannot be changed into a current one (Spec §1.2; D61)', async () => {
  const h = harness(null);
  historySource(h.store, 'src_old_sync', 'docs/design/SYNC.md');
  fileSource(h.store, 'src_ui', 'D:\\ledger\\docs\\ui\\SYNC-UI.md');
  const relabel = await h.call('pk_set_used_as', { sourceId: 'src_old_sync', usedAs: 'Design' });
  assert.equal(relabel.error, true, relabel.text);
  assert.match(relabel.text, /History only/);
  assert.equal(h.store.sources.get('src_old_sync')!.usedAs, 'History only');
  const same = await h.call('pk_set_used_as', { sourceId: 'src_old_sync', usedAs: 'History only' });
  assert.equal(same.error, false, same.text);
  const ordinary = await h.call('pk_set_used_as', { sourceId: 'src_ui', usedAs: 'Design' });
  assert.equal(ordinary.error, false, 'a current source is labelled as before');

  const viaFact = await h.call('pk_write_fact_record', { title: 'Old sync', aboutSourceIds: ['src_old_sync'], statements: [{ type: 'Observed', text: 'It pulled statements nightly.', sourceIds: ['src_old_sync'] }], usedAs: { src_old_sync: 'Design' } });
  assert.equal(viaFact.error, false, viaFact.text);
  assert.equal(h.store.sources.get('src_old_sync')!.usedAs, 'History only', 'the fact record’s Used as map does not relabel history');
});

test('a subagent sent to read material may read version history too; the owner’s words are gathered by a round’s steps (Spec §3.3)', () => {
  const h = harness(repo);
  const all = keeperTools({ store: h.store, project: h.project, jobId: 'job_1', jobKind: 'Organizing', model: null });
  const HISTORY = ['pk_history_log', 'pk_history_read', 'pk_history_deleted'];
  const sub = toolsFor(all, 'subagent').map((t) => t.name);
  for (const n of HISTORY) assert.ok(sub.includes(n), `a subagent may use ${n}: reading history is reading, and concerns its own material alone`);
  assert.ok(!sub.includes('pk_owner_utterances'), 'the owner’s words are gathered for the round as a whole, by its steps');
  assert.ok(!sub.includes('pk_write_thread'), 'a subagent still writes nothing that spans objects');
  for (const step of ['orientation', 'skeleton', 'dig', 'cross-check', 'synthesis'] as const) {
    const tools = stepToolsFor(all, step, 'Deepen').map((t) => t.name);
    for (const n of [...HISTORY, 'pk_owner_utterances']) assert.ok(tools.includes(n), `the ${step} step has ${n}`);
  }
  const other = toolsFor(all, 'other').map((t) => t.name);
  for (const n of [...HISTORY, 'pk_owner_utterances']) assert.ok(other.includes(n), `other work has ${n}`);
});
