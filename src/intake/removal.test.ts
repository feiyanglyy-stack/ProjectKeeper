/**
 * Deletion means "no longer needed" (D61; Spec §2.1, §2.6; CKC-02 AC-5, AC-23). When intake finds that a file was
 * deleted from the project's current version — not moved — every object whose material is now all gone becomes
 * `Removed`, by the program, with a change record; an object that still has other material keeps its validity; a
 * current object that still relies on the deleted material is marked on itself. A move, with or without a small edit,
 * changes no validity. A whole scope location that vanished is not a deletion of the project's content.
 *
 * The fixture is an invented project, "Ledger", a small invoicing tool, read from a temporary directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'pk-removal-home-'));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

const { ProjectStore } = await import('../store/project-store.ts');
const { fullIntake, incrementalIntake } = await import('./intake.ts');
type Project = import('../model/types.ts').Project;
type ScopeItem = import('../model/types.ts').ScopeItem;
type ReferenceItem = import('../model/types.ts').ReferenceItem;
type WorkThread = import('../model/types.ts').WorkThread;
type FactRecord = import('../model/types.ts').FactRecord;
type Store = import('../store/project-store.ts').ProjectStore;
type PendingChange = import('../sources/watch.ts').PendingChange;

const AT = '2026-09-17T00:00:00.000Z';

function write(root: string, rel: string, text: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const item = (id: string, path: string, extra: Partial<ScopeItem> = {}): ScopeItem => ({
  id, path, category: 'Directory', relation: 'Main project', reason: 'Owner-given location', reasonSourceIds: [], sessionHost: null,
  readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'none', missing: null, addedBy: 'owner', ...extra,
});
const projectOf = (root: string, scope: ScopeItem[]): Project => ({ id: 'p1', name: 'Ledger', language: 'en', locations: [root], scope, scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false, createdAt: AT, lastOpenedAt: null, lastScopedAt: null }) as Project;

const attribution = { author: { kind: 'unknown' as const, name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' as const };
const reference = (store: Store, id: string, name: string, sourceIds: string[], extra: Partial<ReferenceItem> = {}) =>
  store.reference.put({ id, projectId: 'p1', category: 'Design', name, ids: [], text: name, quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution, sourceIds, refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT, ...extra } as ReferenceItem);
const fact = (store: Store, id: string, sourceIds: string[]) =>
  store.facts.put({ id, projectId: 'p1', title: id, aboutSourceIds: sourceIds, statements: [], decisions: [], changes: [], openQuestions: [], executionFacts: [], language: 'en', inputs: { jobId: 'j', sourceIds, factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: AT, updatedAt: AT, pendingSourceIds: [] } as FactRecord);
const thread = (store: Store, id: string, title: string, factRecordIds: string[], extra: Partial<WorkThread> = {}) =>
  store.threads.put({ id, projectId: 'p1', title, ids: [], doing: title, changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds, serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution, inputs: { jobId: 'j', sourceIds: [], factRecordIds, threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: AT, updatedAt: AT, pendingSourceIds: [], ...extra } as WorkThread);

/** Source ids of one file, by its path relative to the project root. */
const sourcesOf = (store: Store, root: string, rel: string): string[] =>
  store.sources.filter((s) => s.anchor.kind === 'file' && s.anchor.path.toLowerCase() === join(root, rel).toLowerCase()).map((s) => s.id);

const change = (path: string, scopeItemId = 'scope_main'): PendingChange => ({ kind: 'file', ref: path, label: path, since: AT, lastEventAt: 0, scopeItemId });

const FILTER = '# Filter design\n\n## Fields\n\nBy date and by amount.\n\n## Presets\n\nThis month and last month.\n\n## Saving\n\nFilters can be saved per user.\n';

async function ledger() {
  const root = mkdtempSync(join(tmpdir(), 'pk-removal-'));
  write(root, 'docs/PLAN.md', '# Plan\n\n## Export\n\nExport invoices as CSV.\n\n## Sync\n\nMatch bank statements to invoices.\n');
  write(root, 'docs/design/SYNC.md', '# Sync design\n\nPull bank statements every night.\n');
  write(root, 'docs/design/EXPORT.md', '# Export design\n\nCSV with a header row.\n');
  write(root, 'docs/design/SEARCH.md', '# Search design\n\nSearch invoices by customer.\n');
  write(root, 'docs/design/FILTER.md', FILTER);
  write(root, 'docs/ui/SYNC-UI.md', '# Sync screen\n\nShows when the last sync ran.\n');
  const project = projectOf(root, [item('scope_main', root)]);
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-removal-store-')));
  await fullIntake(store, project);
  const src = (rel: string) => { const ids = sourcesOf(store, root, rel); assert.ok(ids.length > 0, `intake read ${rel}`); return ids; };
  const planExport = store.sources.find((s) => s.anchor.kind === 'file' && s.anchor.path.endsWith('PLAN.md') && s.anchor.headingPath.includes('Export'))!.id;
  const planSync = store.sources.find((s) => s.anchor.kind === 'file' && s.anchor.path.endsWith('PLAN.md') && s.anchor.headingPath.includes('Sync'))!.id;

  reference(store, 'ref_sync', 'Sync design', src('docs/design/SYNC.md'));
  reference(store, 'ref_sync_v0', 'Sync design v0', src('docs/design/SYNC.md'), { validity: 'Replaced', replacedBy: 'ref_sync' });
  reference(store, 'ref_export', 'Export design', [...src('docs/design/EXPORT.md'), planExport]);
  reference(store, 'ref_search', 'Search design', src('docs/design/SEARCH.md'));
  reference(store, 'ref_filter', 'Filter design', src('docs/design/FILTER.md'));
  reference(store, 'ref_nightly', 'R-4 · nightly matching', [planSync], { category: 'Requirement', refines: ['ref_sync'] });
  fact(store, 'fact_sync', src('docs/design/SYNC.md'));
  fact(store, 'fact_ui', src('docs/ui/SYNC-UI.md'));
  thread(store, 'thread_sync', 'L-2 · build the nightly sync', ['fact_sync']);
  thread(store, 'thread_ui', 'L-3 · sync screen', ['fact_ui'], { serves: [{ referenceId: 'ref_sync', claim: 'shows the sync', basis: 'Explicit' }] });
  thread(store, 'thread_proto', 'L-1 · sync prototype', ['fact_ui'], { progress: 'Done', serves: [{ referenceId: 'ref_sync', claim: 'first prototype', basis: 'Explicit' }] });
  return { root, project, store, src };
}

const openMark = (store: Store, targetId: string) => store.marks.find((m) => m.targetId === targetId && m.kind === 'Suspected stale' && m.closed === null);

test('a deleted file removes the objects that rest only on it, by the program and with a change record; a move removes nothing (CKC-02 AC-5; Spec §2.1, §2.6)', async () => {
  const { root, project, store, src } = await ledger();
  const syncSources = src('docs/design/SYNC.md');
  const exportSources = src('docs/design/EXPORT.md');
  const searchSources = src('docs/design/SEARCH.md');
  const filterSources = src('docs/design/FILTER.md');

  rmSync(join(root, 'docs/design/SYNC.md'));
  rmSync(join(root, 'docs/design/EXPORT.md'));
  mkdirSync(join(root, 'docs/archive'), { recursive: true });
  renameSync(join(root, 'docs/design/SEARCH.md'), join(root, 'docs/archive/SEARCH.md'));
  rmSync(join(root, 'docs/design/FILTER.md'));
  write(root, 'docs/archive/FILTER.md', FILTER.replace('Filters can be saved per user.', 'Filters can be saved per user and shared.'));
  incrementalIntake(store, project, [
    change(join(root, 'docs/design/SYNC.md')), change(join(root, 'docs/design/EXPORT.md')),
    change(join(root, 'docs/design/SEARCH.md')), change(join(root, 'docs/design/FILTER.md')),
    change(join(root, 'docs/archive/SEARCH.md')), change(join(root, 'docs/archive/FILTER.md')),
  ]);

  // Deleted: all its material is gone.
  assert.equal(store.reference.get('ref_sync')!.validity, 'Removed', 'the design whose only document was deleted is Removed');
  assert.equal(store.threads.get('thread_sync')!.validity, 'Removed', 'so is the work item whose facts all came from it');
  assert.equal(store.threads.get('thread_sync')!.progress, 'In progress', 'progress is a different fact and stays');
  for (const id of syncSources) assert.equal(store.sources.get(id)!.availability, 'No longer available');
  assert.equal(store.reference.get('ref_sync_v0')!.validity, 'Replaced', 'what was already replaced keeps saying by what');

  // Other material still there: validity unchanged, the object is marked.
  assert.equal(store.reference.get('ref_export')!.validity, 'Current', 'an object that still has other material keeps its validity');
  const partial = openMark(store, 'ref_export');
  assert.ok(partial, 'it is marked: part of what it rests on was deleted');
  assert.ok(partial.clueSourceIds.length > 0 && partial.clueSourceIds.every((id) => exportSources.includes(id)), 'the mark cites the deleted material');
  assert.match(partial.clue, /EXPORT\.md/);

  // Moved: availability says so, validity does not change — also when the moved file was edited a little.
  assert.equal(store.reference.get('ref_search')!.validity, 'Current');
  for (const id of searchSources) assert.equal(store.sources.get(id)!.availability, 'Moved', 'a moved file is Moved, not gone');
  assert.ok(store.sources.get(searchSources[0]!)!.movedTo?.toLowerCase().endsWith(join('docs', 'archive', 'SEARCH.md').toLowerCase()));
  assert.equal(store.reference.get('ref_filter')!.validity, 'Current', 'moved and edited in the same stretch is still a move');
  for (const id of filterSources) assert.equal(store.sources.get(id)!.availability, 'Moved');

  // Current objects that relied on what was removed are marked on themselves; a point-in-time record is not.
  const ui = openMark(store, 'thread_ui');
  assert.ok(ui, 'the work item serving the removed design is marked');
  assert.match(ui.clue, /Sync design/);
  assert.ok(ui.clueSourceIds.every((id) => syncSources.includes(id)));
  assert.ok(openMark(store, 'ref_nightly'), 'the requirement refining the removed design is marked');
  assert.equal(openMark(store, 'thread_proto'), undefined, 'a Done work item records how things stood then and gets no mark');
  assert.equal(store.threads.get('thread_ui')!.validity, 'Current');

  // One change record says what was removed and why.
  const records = store.changes.filter((c) => (c.items ?? []).some((i) => i.affects.includes('ref_sync')));
  assert.equal(records.length, 1, records.map((r) => r.id).join(', '));
  const record = records[0]!;
  const items = record.items ?? [];
  const removed = items.filter((i) => i.effect === ('Removed' as never));
  assert.deepEqual(removed.map((i) => i.affects[0]).sort(), ['ref_sync', 'thread_sync'], 'one item per object removed, and only those');
  for (const i of removed) {
    assert.equal(i.before, 'Current');
    assert.equal(i.after, 'Removed');
    assert.ok(i.sourceIds.length > 0 && i.sourceIds.every((id) => syncSources.includes(id)), 'the basis is the deleted material');
    assert.match(i.summary, /SYNC\.md/);
  }
  assert.equal(record.work?.kind, 'Time range', 'no session is known for a deletion observed on disk');
  assert.ok(syncSources.every((id) => record.sourceIds.includes(id)));
  assert.ok(!record.affects.includes('ref_export') && !record.affects.includes('ref_search'), 'nothing that was not removed is an item');
});

test('the material coming back undoes what the program removed (D61; Spec §2.1)', async () => {
  const { root, project, store } = await ledger();
  const text = '# Sync design\n\nPull bank statements every night.\n';
  rmSync(join(root, 'docs/design/SYNC.md'));
  incrementalIntake(store, project, [change(join(root, 'docs/design/SYNC.md'))]);
  assert.equal(store.reference.get('ref_sync')!.validity, 'Removed');
  assert.ok(openMark(store, 'thread_ui'));

  write(root, 'docs/design/SYNC.md', text);
  incrementalIntake(store, project, [change(join(root, 'docs/design/SYNC.md'))]);
  assert.equal(store.reference.get('ref_sync')!.validity, 'Current', 'the design is in the current version again');
  assert.equal(store.threads.get('thread_sync')!.validity, 'Current');
  assert.equal(openMark(store, 'thread_ui'), undefined, 'the mark the deletion put on the work item is closed');
  const back = store.changes.all().flatMap((c) => c.items ?? []).filter((i) => i.affects.includes('ref_sync') && i.before === 'Removed');
  assert.equal(back.length, 1, 'the return is recorded as well');
  assert.equal(back[0]!.after, 'Current');
});

test('a deletion found by a full intake, a deleted directory and a committed deletion are handled the same way (CKC-02 AC-5)', async () => {
  const { root, project, store } = await ledger();
  // A whole directory deleted: the watcher reports only the directory.
  rmSync(join(root, 'docs/ui'), { recursive: true });
  incrementalIntake(store, project, [change(join(root, 'docs/ui'))]);
  assert.equal(store.threads.get('thread_ui')!.validity, 'Removed', 'every file under a deleted directory is deleted');
  // A deletion noticed at the next start.
  rmSync(join(root, 'docs/design/SEARCH.md'));
  await fullIntake(store, project);
  assert.equal(store.reference.get('ref_search')!.validity, 'Removed', 'a full intake finds the deletion too');
  assert.equal(store.reference.get('ref_filter')!.validity, 'Current');
});

test('a deletion committed in git is dated by its commit and says why in the commit’s own words (Spec §1.8)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-removal-git-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ledger Dev', GIT_AUTHOR_EMAIL: 'dev@ledger.invalid', GIT_COMMITTER_NAME: 'Ledger Dev', GIT_COMMITTER_EMAIL: 'dev@ledger.invalid' };
  const git = (args: string[], extra: Record<string, string> = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']);
  write(root, 'docs/design/SYNC.md', '# Sync design\n\nPull bank statements every night.\n');
  write(root, 'docs/PLAN.md', '# Plan\n\nExport invoices.\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Start'], { GIT_AUTHOR_DATE: '2026-09-01T09:00:00+08:00', GIT_COMMITTER_DATE: '2026-09-01T09:00:00+08:00' });
  const project = projectOf(root, [item('scope_main', root, { category: 'Repository', versionControl: 'git' })]);
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-removal-store-')));
  await fullIntake(store, project);
  reference(store, 'ref_sync', 'Sync design', sourcesOf(store, root, 'docs/design/SYNC.md'));
  git(['rm', '-q', 'docs/design/SYNC.md']);
  git(['commit', '-q', '-m', 'Drop the bank sync: the bank has no API'], { GIT_AUTHOR_DATE: '2026-09-05T10:30:00+08:00', GIT_COMMITTER_DATE: '2026-09-05T10:30:00+08:00' });
  const dropped = git(['rev-parse', 'HEAD']);
  incrementalIntake(store, project, [change(join(root, 'docs/design/SYNC.md'))]);
  assert.equal(store.reference.get('ref_sync')!.validity, 'Removed');
  const i = store.changes.all().flatMap((c) => c.items ?? []).find((x) => x.affects.includes('ref_sync'))!;
  assert.ok(i, 'an item records the removal');
  assert.equal(i.at, '2026-09-05T02:30:00.000Z', 'the time is the commit’s');
  assert.equal(i.atSource, 'material');
  assert.ok(i.summary.includes(dropped.slice(0, 8)), 'the summary names the commit');
  assert.equal(i.why, 'Drop the bank sync: the bank has no API', 'why is the commit’s own words');
});

test('a move committed in git is a move even into a place intake does not read; moved and then deleted is a deletion, dated by the deleting commit (Spec §1.2, §2.1)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-removal-mv-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ledger Dev', GIT_AUTHOR_EMAIL: 'dev@ledger.invalid', GIT_COMMITTER_NAME: 'Ledger Dev', GIT_COMMITTER_EMAIL: 'dev@ledger.invalid' };
  const git = (args: string[], date = '2026-09-01T09:00:00+08:00') => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']);
  write(root, 'docs/design/SYNC.md', '# Sync design\n\nPull bank statements every night.\n');
  write(root, 'docs/design/EXPORT.md', '# Export design\n\nCSV with a header row.\n');
  write(root, 'docs/PLAN.md', '# Plan\n\nExport invoices.\n');
  write(root, 'attic/README.md', '# Attic\n\nOld things.\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Start']);
  // The attic is outside what intake reads.
  const project = projectOf(root, [item('scope_main', root, { category: 'Repository', versionControl: 'git' }), item('scope_attic', join(root, 'attic'), { relation: 'Excluded' })]);
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-removal-store-')));
  await fullIntake(store, project);
  const sync = sourcesOf(store, root, 'docs/design/SYNC.md');
  const exp = sourcesOf(store, root, 'docs/design/EXPORT.md');
  assert.ok(sync.length > 0 && exp.length > 0);
  assert.equal(sourcesOf(store, root, 'attic/README.md').length, 0, 'the attic is not read');
  reference(store, 'ref_sync', 'Sync design', sync);
  reference(store, 'ref_export', 'Export design', exp);

  git(['mv', 'docs/design/SYNC.md', 'attic/SYNC.md']);
  git(['commit', '-q', '-m', 'Put the sync design in the attic'], '2026-09-03T09:00:00+08:00');
  git(['mv', 'docs/design/EXPORT.md', 'attic/EXPORT.md']);
  git(['commit', '-q', '-m', 'Put the export design in the attic'], '2026-09-04T09:00:00+08:00');
  git(['rm', '-q', 'attic/EXPORT.md']);
  git(['commit', '-q', '-m', 'Drop the export design: CSV is enough'], '2026-09-06T09:00:00+08:00');
  incrementalIntake(store, project, [change(join(root, 'docs/design/SYNC.md')), change(join(root, 'docs/design/EXPORT.md'))]);

  for (const id of sync) {
    assert.equal(store.sources.get(id)!.availability, 'Moved', 'git recorded a move: the file is elsewhere, not gone');
    assert.equal(store.sources.get(id)!.movedTo?.toLowerCase(), join(root, 'attic', 'SYNC.md').toLowerCase(), 'and says where');
  }
  assert.equal(store.reference.get('ref_sync')!.validity, 'Current', 'a move changes no validity; where it went is for the round’s rules to judge');
  assert.ok(!store.changes.all().some((c) => c.affects.includes('ref_sync')), 'no removal is recorded for a move');

  for (const id of exp) assert.equal(store.sources.get(id)!.availability, 'No longer available', 'moved and then deleted: the content is gone');
  assert.equal(store.reference.get('ref_export')!.validity, 'Removed');
  const i = store.changes.all().flatMap((c) => c.items ?? []).find((x) => x.affects.includes('ref_export'))!;
  assert.ok(i, 'an item records the removal');
  assert.equal(i.why, 'Drop the export design: CSV is enough', 'the deletion is the commit that deleted the moved file');
  assert.equal(i.at, '2026-09-06T01:00:00.000Z');
});

test('a scope location that vanished as a whole is not a deletion of the project’s content: nothing becomes Removed (Spec §2.6)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-removal-root-'));
  const notes = mkdtempSync(join(tmpdir(), 'pk-removal-notes-'));
  write(root, 'docs/PLAN.md', '# Plan\n\nExport invoices.\n');
  write(notes, 'IDEAS.md', '# Ideas\n\nRecurring invoices.\n');
  const project = projectOf(root, [item('scope_main', root), item('scope_notes', notes, { relation: 'Experiment' })]);
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-removal-store-')));
  await fullIntake(store, project);
  const ideas = sourcesOf(store, notes, 'IDEAS.md');
  assert.ok(ideas.length > 0);
  reference(store, 'ref_ideas', 'Recurring invoices', ideas, { category: 'Goal' });
  rmSync(notes, { recursive: true });
  await fullIntake(store, project);
  for (const id of ideas) assert.equal(store.sources.get(id)!.availability, 'No longer available', 'its material is not readable');
  assert.equal(store.reference.get('ref_ideas')!.validity, 'Current', 'a location that is gone as a whole (a drive, a removed worktree) is not a decision that the content is not needed');
  assert.equal(store.changes.size, 0);
});
