/**
 * `Update pending` by the clerk method (Spec §1.11, §7.1, §7.6, §9; CKC-07 AC-10). The clerk method's rounds write no fact
 * records (D88), so the chain material → fact records → work items → areas marked nothing any more and `Update pending`
 * never lit. Now a change that waits for the next round marks each entry it reaches, with how it reaches it:
 *   - Number: a changed section of a document, a commit's message or the paths it changed, a file's path, a session's
 *     messages or the worktree it ran in names the entry's number — the project's own or the Keeper's;
 *   - Cited source: the entry cites a part that changed (a statement, what it was written from, a relation, the clue of
 *     a mark on it, its own sources), or a section the change removed;
 *   - Code territory: the change is in code of a territory the work item changed (counted as `Built by` counts);
 *   - Process: a step, breakpoint or send-back of the work rests on the file;
 *   - Recorded change: a change the Change log recorded from the same material reached the entry;
 *   - an area waits for its own item's changes and for what its contributing work waits for.
 * A section a change did not touch reaches nothing (the version the latest round took in is compared section by
 * section). What the rules settle, what is history or reference only and the Keeper's own commits mark nothing. The marks
 * name exactly what the coverage lists as pending, and they go when a round starts: its start is the list's watermark.
 *
 * The project is invented ("Heron", a heron count log) and lives in the temp directory; git is only read, except the
 * commits the fixture makes in its own repository.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Breakpoint, ClerkRound, CodeTerritory, ProcessLink } from '../../model/k-types.ts';
import type { AreaUnderstanding, ChangeItem, ChangeRecord, EntryMark, GraphRelation, PendingWait, ProjectRule, ReferenceItem, ScopeItem, Source, Statement, WorkThread } from '../../model/types.ts';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-pending-'));
process.env.USERPROFILE = scratch;
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(scratch, 'pi-'));

const { App } = await import('../../server/app.ts');
const { incrementalIntake } = await import('../../intake/intake.ts');
const { applyMaterialRules } = await import('../../intake/material-rules.ts');
const { makeSessionSource } = await import('../../sources/anchor.ts');
const { deriveGraph } = await import('./graph.ts');
const { graphView, nodeDetail } = await import('../../server/graph-view.ts');
const { assembleContext } = await import('../../context/assemble.ts');
const { nodeBrief } = await import('../../context/object-brief.ts');
const { knownPart } = await import('../../context/ask.ts');
const { clerkPending, takenInAt } = await import('./clerk-coverage.ts');
const { updatePendingMarks } = await import('./update-pending.ts');

const ENV = { GIT_AUTHOR_NAME: 'Heron Dev', GIT_AUTHOR_EMAIL: 'dev@heron.invalid', GIT_COMMITTER_NAME: 'Heron Dev', GIT_COMMITTER_EMAIL: 'dev@heron.invalid' };
const dir = mkdtempSync(join(scratch, 'heron-'));
const git = (args: string[], env: Record<string, string> = {}) => execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel: string, text: string) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
const slash = (p: string) => p.split('\\').join('/');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

write('README.md', '# Heron\n\nCounts herons.\n');
write('docs/PLAN.md', '# Plan\n\n## W-1 Count by hand\n\nCount the herons by hand.\n\n## W-2 Count by ear\n\nListen at dawn.\n');
write('docs/DECISIONS.md', '# Decisions\n\n**D1 · Count at dawn.**\n');
write('docs/receipts/batch-1.md', '# Batch 1\n\n## W-1\n\nCounted 12 herons.\n\n## Notes\n\nThe marsh path is closed.\n');
write('docs/receipts/second-pass.md', '# Second pass\n\nFirst pass done.\n');
write('docs/receipts/W-4-plan.md', '# Plan for the fourth work\n\nNothing yet.\n');
write('src/count/tally.ts', 'export const tally = 1;\n');
write('src/ear/listen.ts', 'export const listen = 1;\n');
write('guides/field-guide.md', '# Field guide\n\nHerons stand still.\n');
write('old/plan-v0.md', '# Plan v0\n\nCount once a year.\n');
const SCHEDULE = '# Schedule\n\n## Dawn\n\nCount at dawn.\n\n## Dusk\n\nCount at dusk.\n';
write('docs/SCHEDULE.md', SCHEDULE);
git(['init', '-q', '-b', 'main']);
git(['add', '-A']);
git(['commit', '-q', '-m', 'Start'], { GIT_AUTHOR_DATE: '2026-09-01T06:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T06:00:00Z' });
// W-1 built the counting code: its commit names it, so the code map counts the territory as changed by W-1.
write('src/count/tally.ts', 'export const tally = 2;\n');
git(['add', '-A']);
git(['commit', '-q', '-m', 'W-1: tally the herons'], { GIT_AUTHOR_DATE: '2026-09-02T06:00:00Z', GIT_COMMITTER_DATE: '2026-09-02T06:00:00Z' });
// An edit nobody committed: intake reads it, the first round takes it in, and after that round it is undone.
write('docs/SCHEDULE.md', SCHEDULE.replace('Count at dusk.', 'Count at dusk, twice.'));

const home = mkdtempSync(join(scratch, 'home-'));
const app = new App(home, { organizing: false });
app.workspace.setSettings({ watchProjects: false });
after(async () => { app.stopAll(); await app.flushAll(); rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const added = app.addProject('Heron', [dir]);
await app.intakeProject(added.id);
const pid = added.id;
const store = app.store(pid);
const P = () => app.project(pid);
const repoItem = P().scope.find((i) => i.category === 'Repository')!;
// The Keeper's project folder is out of the material, as the folder's grant makes it (project-folder-api.ts).
app.updateProject({ ...P(), scope: [...P().scope, { id: 'si-pk', path: join(dir, 'projectkeeper'), category: 'Directory', relation: 'Excluded', reason: 'ProjectKeeper’s project folder', reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'unknown', missing: null, addedBy: 'owner' } as ScopeItem] });

const AT = new Date().toISOString();
store.rules.put({ id: 'rule_guides', projectId: pid, group: 'Material rules', category: 'Reference only', summary: 'guides/ is for reference only.', excerpt: null, sourceIds: [], appliesTo: ['guides/'], basis: 'Inferred', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: null, asOf: AT, updatedAt: AT } as ProjectRule);
applyMaterialRules(store, P());
for (const s of store.sources.filter((x) => x.anchor.kind === 'file' && slash(x.anchor.path).endsWith('old/plan-v0.md'))) store.sources.put({ ...s, usedAs: 'History only', usedAsBy: 'keeper' });
await wait(1700);   // the rule's rescope settles before the round

const src = (rel: string, heading?: string): Source => {
  const s = store.sources.find((x) => x.anchor.kind === 'file' && slash(x.anchor.path).endsWith(`/${rel}`) && (heading === undefined || x.anchor.headingPath[x.anchor.headingPath.length - 1] === heading));
  assert.ok(s, `the source of ${rel}${heading ? ` › ${heading}` : ''} was read`);
  return s;
};
const inputs = (sourceIds: readonly string[] = []) => ({ jobId: 'job_skeleton', sourceIds, factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' });
const attribution = { author: { kind: 'unknown' as const, name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' as const };
const thread = (id: string, ids: string[], title: string, over: Partial<WorkThread> = {}) => store.threads.put({
  id, projectId: pid, title, ids, doing: title, changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [],
  progress: 'In progress', validity: 'Current', replacedBy: null, attribution, inputs: inputs(), asOf: AT, updatedAt: AT, pendingSourceIds: [], ...over,
} as WorkThread);
const ref = (id: string, category: ReferenceItem['category'], name: string, ids: string[], sourceIds: string[]) => store.reference.put({
  id, projectId: pid, category, name, ids, text: name, quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution, sourceIds, refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT,
} as ReferenceItem);

// ── the assets a first round of the clerk method would have written ──
const claimed: Statement = { id: 'st_w1', type: 'Claimed', text: 'W-1 counted 12 herons', sourceIds: [src('docs/receipts/batch-1.md', 'W-1').id], claimedBy: { who: 'Worker agent, batch 1 receipt', at: '2026-09-02', untrustedRuleId: null } };
ref('ref_count', 'Area', 'A1 Counting', ['A1'], [src('README.md', 'Heron').id]);
ref('ref_d1', 'Decision', 'D1 Count at dawn', ['D1'], [src('docs/DECISIONS.md', 'Decisions').id]);
thread('thread_w1', ['W-1'], 'Count by hand', { inputs: inputs([src('docs/PLAN.md', 'W-1 Count by hand').id]), executionFacts: [claimed], serves: [{ referenceId: 'ref_count', claim: 'counting', basis: 'Explicit' }] });
thread('thread_w2', ['W-2'], 'Count by ear', { inputs: inputs([src('docs/PLAN.md', 'W-2 Count by ear').id]) });
thread('thread_w3', ['W-3'], 'Field notes');
thread('thread_w4', ['W-4'], 'Count at night');
thread('thread_w5', ['W-5'], 'Count next week');
thread('thread_w6', ['W-6'], 'Sketch the marsh');
thread('thread_w7', ['W-7'], 'Count by boat');
thread('thread_w8', ['W-8'], 'Count by drone');
thread('thread_w9', ['W-9'], 'Mind the marsh path', { inputs: inputs([src('docs/receipts/batch-1.md', 'Notes').id]) });
thread('thread_w10', ['W-10'], 'Count at dusk twice', { inputs: inputs([src('docs/SCHEDULE.md', 'Dusk').id]) });
thread('thread_k', [], 'Tell herons apart');
store.numbers.put({ id: 'knum_1', projectId: pid, number: 'K-1', objectId: 'thread_k', objectKind: 'work', projectNumber: null, at: AT });
store.areas.put({ id: 'area_count', projectId: pid, referenceId: 'ref_count', effectNow: 'Herons are counted by hand.', gaps: 'Nothing counts by ear yet.', contributions: [{ threadId: 'thread_w1', claim: 'counts by hand', basis: 'Explicit' }], inputs: inputs(), asOf: AT, updatedAt: AT, pendingSourceIds: [] } as AreaUnderstanding);
store.relations.put({ id: 'rel_listen', projectId: pid, type: 'implements', from: src('src/ear/listen.ts').id, to: 'thread_w2', claim: 'listen.ts listens', basis: 'Explicit', evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: AT } as GraphRelation);
store.changes.put({
  id: 'chg_d1', projectId: pid, at: '2026-09-01', atSource: 'material', material: 'Decision', effect: 'Added', title: 'Dawn counts decided', summary: 'D1', before: null, after: null,
  sourceIds: [src('docs/DECISIONS.md', 'Decisions').id], by: null, affects: ['ref_d1'], propagation: [], segment: null, createdInJobId: null, updatedAt: AT,
  items: [{ id: 'i1', at: '2026-09-01', atSource: null, material: 'Decision', effect: 'Added', title: 'Dawn counts decided', summary: 'the field notes follow D1', before: null, after: null, sourceIds: [src('docs/DECISIONS.md', 'Decisions').id], by: null, why: null, affects: ['thread_w3'] } as unknown as ChangeItem],
} as unknown as ChangeRecord);
store.territories.put({ id: 't_count', projectId: pid, name: 'Counting', summary: 'the tally', repo: dir, paths: ['src/count'], kind: 'area', areaId: 'ref_count', alsoServes: [], anomalies: [], roundId: null, jobId: null, updatedAt: AT } as CodeTerritory);
store.marks.put({ id: 'mark_w4', projectId: pid, kind: 'Suspected stale', targetId: 'thread_w4', clueSourceIds: [src('docs/receipts/W-4-plan.md').id], clue: 'its plan says nothing yet', since: AT, noteId: null, closed: null } as EntryMark);
store.breakpoints.put({ id: 'bp_w9', projectId: pid, kind: 'Not checked', targetId: 'thread_w9', why: 'nobody checked the marsh path', evidence: [{ kind: 'file', id: 'docs/receipts/batch-1.md', label: 'batch-1.md', repo: dir }], basis: 'Explicit', since: { at: '2026-09-02', basis: 'Commit', anchor: null }, lit: true, out: null, ownerResponse: null, confirmedInRoundId: null, sixThing: null, sendBackId: null, roundId: null, updatedAt: AT } as Breakpoint);

// ── the first round took in everything read so far; its first step brought the ledger up to date ──
await wait(20);
const r1Start = new Date().toISOString();
store.clerkRounds.put({ id: 'crd_1', projectId: pid, kind: 'First usable', number: 1, startedAt: r1Start, endedAt: new Date().toISOString(), status: 'Done', rootJobId: 'job_r1', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: r1Start } as ClerkRound);
app.ledger.rebuildNow(P());
const receiptVersion = (() => { const v = app.ledger.ledger(pid)!.docVersions('docs/receipts/second-pass.md'); assert.ok(typeof v !== 'string', String(v)); return v.versions[0]!.id; })();
store.links.put({ id: 'link_w2', projectId: pid, workId: 'thread_w2', ledgerRef: receiptVersion, evidence: { kind: 'ledger', id: receiptVersion, label: 'second-pass.md' }, stepKind: 'Delivered', why: 'the second pass’s receipt', basis: 'Inferred', confirmed: true, roundId: 'crd_1', jobId: null, at: AT } as ProcessLink);
deriveGraph(store, P());
app.refreshCoverage(pid);
const before = { marked: store.threads.filter((t) => t.pendingSourceIds.length > 0).map((t) => t.id), pending: store.coverage.scopes.find((s) => s.id === 'project')!.pending.length };

// ── after the round started: changes arrive, and intake reads them ──
await wait(1100);   // commit times are read to the second
write('docs/PLAN.md', '# Plan\n\n## W-1 Count by hand\n\nCount the herons by hand.\n\n## W-2 Count by ear\n\nListen at dawn and at dusk, as K-1 asks.\n');
write('docs/receipts/batch-1.md', '# Batch 1\n\n## W-1\n\nCounted 14 herons.\n');
write('docs/receipts/second-pass.md', '# Second pass\n\nSecond pass done.\n');
write('docs/receipts/W-4-plan.md', '# Plan for the fourth work\n\nStarted.\n');
write('docs/DECISIONS.md', '# Decisions\n\n**D1 · Count at dawn and at dusk.**\n');
write('README.md', '# Heron\n\nCounts herons. A1 counting is by hand.\n');
write('src/count/tally.ts', 'export const tally = 3;\n');
write('src/ear/listen.ts', 'export const listen = 2;\n');
write('guides/field-guide.md', '# Field guide\n\nHerons stand still. W-7 starts here.\n');
write('old/plan-v0.md', '# Plan v0\n\nCount once a year. W-7 was here.\n');
write('docs/notes.md', '# Notes\n\nField notes.\n');
write('docs/SCHEDULE.md', SCHEDULE);   // the uncommitted edit the round took in is undone: the file is the committed one again
git(['add', 'docs/notes.md']);
git(['commit', '-q', '-m', 'W-3: field notes', '--', 'docs/notes.md']);
write('projectkeeper/notes.md', '# Notes\n\nW-7 notes.\n');
git(['add', 'projectkeeper']);
git(['commit', '-q', '-m', 'ProjectKeeper: update W-7 notes', '--author=ProjectKeeper <keeper@projectkeeper.invalid>', '--', 'projectkeeper']);
const changed = ['docs/PLAN.md', 'docs/receipts/batch-1.md', 'docs/receipts/second-pass.md', 'docs/receipts/W-4-plan.md', 'docs/DECISIONS.md', 'README.md', 'src/count/tally.ts', 'src/ear/listen.ts', 'guides/field-guide.md', 'old/plan-v0.md', 'docs/notes.md', 'docs/SCHEDULE.md'];
const now = new Date().toISOString();
incrementalIntake(store, P(), [
  ...changed.map((rel) => ({ kind: 'file' as const, ref: join(dir, ...rel.split('/')), label: rel, since: now, lastEventAt: Date.now(), scopeItemId: repoItem.id })),
  { kind: 'commit' as const, ref: `${dir}@head`, label: 'head', since: now, lastEventAt: Date.now(), scopeItemId: repoItem.id },
]);
// A session in a worktree named after W-6, in which the owner moves W-5.
store.sources.put(makeSessionSource({
  projectId: pid, host: 'claude', sessionId: 'b6b6c7c7-1111-4222-8333-444455556666', file: join(scratch, 'session-w6.jsonl'), cwd: join(dir, '.worktrees', 'W-6-sketch'),
  messageStart: 0, messageEnd: 1, at: now, excerpt: '[0] OWNER 2026-09-27 10:00\nLet us move W-5 to next week.\n\n[1] AGENT 2026-09-27 10:01\nNoted.', title: 'Claude Code session b6b6c7c7', scopeItemId: repoItem.id, readAt: now,
}));
// A session in the project's own directory, as an agent's shell spelled it: through a junction that happens to be named
// after W-2. The log records that spelling; the directory is the project's, not a worktree named after a work.
const desk = join(scratch, 'W-2-desk');
symlinkSync(dir, desk, 'junction');
store.sources.put(makeSessionSource({
  projectId: pid, host: 'claude', sessionId: 'c7c7d8d8-1111-4222-8333-444455556666', file: join(scratch, 'session-desk.jsonl'), cwd: desk,
  messageStart: 0, messageEnd: 1, at: now, excerpt: '[0] OWNER 2026-09-27 11:00\nThe hide needs a new roof.\n\n[1] AGENT 2026-09-27 11:01\nNoted.', title: 'Claude Code session c7c7d8d8', scopeItemId: repoItem.id, readAt: now,
}));
app.refreshCoverage(pid);

const waitsOf = (id: string): readonly PendingWait[] => store.threads.get(id)?.waitsFor ?? store.reference.get(id)?.waitsFor ?? [];
const waitFor = (id: string, label: string | RegExp) => waitsOf(id).find((w) => (typeof label === 'string' ? w.label === label : label.test(w.label)));
const details = (id: string, label: string | RegExp) => (waitFor(id, label)?.reasons ?? []).map((r) => `${r.link}: ${r.detail}`);
const pendingRefs = () => new Set(store.coverage.scopes.find((s) => s.id === 'project')!.pending.map((p) => p.ref));

test('nothing waits right after a round took everything in, so nothing is marked', () => {
  assert.deepEqual(before, { marked: [], pending: 0 });
});

test('Number: a changed section names W-2 (and the Keeper’s K-1); W-1’s untouched section of the same document reaches nothing', () => {
  assert.ok(details('thread_w2', 'docs/PLAN.md').includes('Number: names W-2 in docs/PLAN.md › Plan › W-2 Count by ear'), JSON.stringify(waitsOf('thread_w2')));
  assert.deepEqual(waitFor('thread_w2', 'docs/PLAN.md')!.sourceIds, [src('docs/PLAN.md', 'W-2 Count by ear').id], 'the part to read now is the section that changed');
  assert.ok(details('thread_k', 'docs/PLAN.md').includes('Number: names K-1 in docs/PLAN.md › Plan › W-2 Count by ear'), 'a Keeper number is a number of the work too');
  // W-1 was written from its own section of PLAN.md, which the change left alone (compared with the version the round took in).
  assert.equal(waitFor('thread_w1', 'docs/PLAN.md'), undefined, `the untouched section reaches nothing: ${JSON.stringify(waitsOf('thread_w1'))}`);
});

test('Number: a commit’s message names W-3', () => {
  const w = waitFor('thread_w3', /W-3: field notes$/);
  assert.ok(w, JSON.stringify(waitsOf('thread_w3')));
  assert.equal(w.kind, 'commit');
  assert.ok(w.reasons.some((r) => r.link === 'Number' && /^names W-3 in the message of commit [0-9a-f]{8}$/.test(r.detail)), JSON.stringify(w.reasons));
});

test('Number: a changed file’s path names W-4; and the clue of a mark on W-4 is in that file (Cited source)', () => {
  const w4 = details('thread_w4', 'docs/receipts/W-4-plan.md');
  assert.ok(w4.includes('Number: names W-4 in its path docs/receipts/W-4-plan.md'), JSON.stringify(waitsOf('thread_w4')));
  assert.ok(w4.includes('Cited source: the clue of its mark Suspected stale is docs/receipts/W-4-plan.md › Plan for the fourth work'), JSON.stringify(w4));
});

test('Number: a session names W-5 in its messages, and W-6 in the worktree it runs in', () => {
  assert.ok(details('thread_w5', 'claude session b6b6c7c7').includes('Number: names W-5 in claude session b6b6c7c7 · messages 0–1'), JSON.stringify(waitsOf('thread_w5')));
  assert.ok(details('thread_w6', 'claude session b6b6c7c7').includes('Number: names W-6 in its working directory .worktrees/W-6-sketch'), JSON.stringify(waitsOf('thread_w6')));
});

test('a session recorded in the project’s own directory through a junction names no work by the junction’s name', () => {
  assert.equal(waitFor('thread_w2', 'claude session c7c7d8d8'), undefined, JSON.stringify(waitsOf('thread_w2')));
});

test('Cited source: a statement cites the changed section, a relation ties the work to changed code, a work was written from a section the change removed', () => {
  const w1 = details('thread_w1', 'docs/receipts/batch-1.md');
  assert.ok(w1.includes('Cited source: a Claimed statement of it cites docs/receipts/batch-1.md › Batch 1 › W-1'), JSON.stringify(w1));
  assert.ok(w1.includes('Number: names W-1 in docs/receipts/batch-1.md › Batch 1 › W-1'));
  assert.ok(details('thread_w2', 'src/ear/listen.ts').includes('Cited source: the relation “implements” ties it to src/ear/listen.ts'), JSON.stringify(waitsOf('thread_w2')));
  assert.ok(details('thread_w2', 'docs/PLAN.md').includes('Cited source: it was written from docs/PLAN.md › Plan › W-2 Count by ear'));
  assert.ok(details('thread_w9', 'docs/receipts/batch-1.md').includes('Cited source: it was written from docs/receipts/batch-1.md › Batch 1 › Notes, which the change removed'), JSON.stringify(waitsOf('thread_w9')));
});

test('Code territory: the change is in code of a territory the work changed', () => {
  assert.ok(details('thread_w1', 'src/count/tally.ts').includes('Code territory: src/count/tally.ts is in the code territory “Counting”, which it changed'), JSON.stringify(waitsOf('thread_w1')));
  assert.equal(waitFor('thread_w2', 'src/count/tally.ts'), undefined, 'a work that never changed the territory does not wait for it');
});

test('Process: a step’s receipt changed; a breakpoint rests on a changed report', () => {
  assert.ok(details('thread_w2', 'docs/receipts/second-pass.md').includes('Process: its Delivered step rests on docs/receipts/second-pass.md'), JSON.stringify(waitsOf('thread_w2')));
  assert.ok(details('thread_w9', 'docs/receipts/batch-1.md').includes('Process: its breakpoint Not checked rests on docs/receipts/batch-1.md'));
});

test('an edit the round took in, undone since: no section differs from the version the ledger holds, so which part changed is not known, and every section counts', () => {
  const pendingSchedule = store.coverage.scopes.find((s) => s.id === 'project')!.pending.find((p) => p.label === 'docs/SCHEDULE.md');
  assert.ok(pendingSchedule, 'the schedule was read again after the round started: it waits for the next round');
  // The comparison with the ledger's version (the committed one) finds nothing: the round had taken in the edit.
  const ledgerText = app.ledger.ledger(pid)!.currentText(join(dir, 'docs', 'SCHEDULE.md'));
  assert.equal(ledgerText?.replace(/\r\n/g, '\n'), SCHEDULE, 'the ledger holds the committed version, which the file is again');
  assert.ok(details('thread_w10', 'docs/SCHEDULE.md').includes('Cited source: it was written from docs/SCHEDULE.md › Schedule › Dusk'), `the section the undo changed back still reaches what cites it: ${JSON.stringify(waitsOf('thread_w10'))}`);
});

test('Recorded change: a change the Change log recorded from the same material reached the work', () => {
  assert.ok(details('thread_w3', 'docs/DECISIONS.md').includes('Recorded change: the change “Dawn counts decided” (chg_d1) that reached it came from docs/DECISIONS.md › Decisions'), JSON.stringify(waitsOf('thread_w3')));
});

test('reference items and areas: their own sources and numbers; an area also waits for its contributing work', () => {
  const d1 = details('ref_d1', 'docs/DECISIONS.md');
  assert.ok(d1.includes('Cited source: it rests on docs/DECISIONS.md › Decisions') && d1.includes('Number: names D1 in docs/DECISIONS.md › Decisions'), JSON.stringify(d1));
  assert.ok(details('ref_count', 'README.md').includes('Number: names A1 in README.md › Heron'), JSON.stringify(waitsOf('ref_count')));
  const area = store.areas.get('area_count')!;
  const byLabel = new Map((area.waitsFor ?? []).map((w) => [w.label, w.reasons.map((r) => `${r.link}: ${r.detail}`)]));
  assert.ok(byLabel.get('README.md')?.includes('Cited source: it rests on README.md › Heron'), `its own item's change: ${JSON.stringify(area.waitsFor)}`);
  assert.ok(byLabel.get('src/count/tally.ts')?.includes('Contributing work: its work Count by hand (thread_w1) waits for it'), 'its work’s change');
  assert.ok(area.pendingSourceIds.length > 0);
});

test('what the rules settle, history only, and the Keeper’s own commit mark nothing', () => {
  assert.deepEqual(waitsOf('thread_w7'), [], 'W-7 is named only in a reference-only guide, a history-only plan and the Keeper’s own commit');
  assert.deepEqual(store.threads.get('thread_w7')!.pendingSourceIds, []);
  const refs = pendingRefs();
  // Each ref from the test's own scratch directory on: the directories above it are the machine's, whatever they are called.
  const within = [...refs].map((r) => (r.toLowerCase().startsWith(scratch.toLowerCase()) ? r.slice(scratch.length) : r));
  assert.ok(!within.some((r) => /field-guide|plan-v0|projectkeeper/i.test(r)), `none of them is pending either: ${within.join(', ')}`);
  assert.deepEqual(waitsOf('thread_w8'), [], 'a work nothing reaches waits for nothing');
});

test('a mark names exactly changes the coverage lists as pending; the graph and the node detail show it with its reasons', () => {
  const refs = pendingRefs();
  const all = [...store.threads.all().flatMap((t) => t.waitsFor ?? []), ...store.reference.all().flatMap((r) => r.waitsFor ?? []), ...store.areas.all().flatMap((a) => a.waitsFor ?? [])];
  assert.ok(all.length > 10);
  for (const w of all) assert.ok(refs.has(w.ref), `${w.label} is on the coverage's pending list`);
  for (const t of store.threads.all()) assert.deepEqual(t.pendingSourceIds, [...new Set((t.waitsFor ?? []).flatMap((w) => w.sourceIds))], `${t.id}: the source ids are the waits'`);

  const g = graphView(store, P());
  const lit = (id: string) => g.nodes.find((n) => n.id === id)?.updatePending;
  for (const id of ['thread_w1', 'thread_w2', 'thread_w3', 'thread_w4', 'thread_w5', 'thread_w6', 'thread_w9', 'thread_w10', 'thread_k', 'ref_d1', 'ref_count']) assert.equal(lit(id), true, `${id} shows Update pending on the graph`);
  for (const id of ['thread_w7', 'thread_w8']) assert.equal(lit(id), false, `${id} does not`);

  const d = nodeDetail(store, P(), 'thread_w2') as unknown as { updatePending: boolean; waitsFor: PendingWait[]; pendingWhen: string | null };
  assert.equal(d.updatePending, true);
  assert.deepEqual(d.waitsFor.map((w) => w.label).sort(), ['docs/PLAN.md', 'docs/receipts/second-pass.md', 'src/ear/listen.ts']);
  assert.ok(d.waitsFor.every((w) => w.reasons.length > 0 && w.sourceIds.length > 0), 'each change says how it reaches W-2 and what to read');
  assert.ok(d.pendingWhen, 'and when it is taken in');
});

test('the context pack, the object brief and the known part of a question name the changes and how they reach the entry', () => {
  const pack = assembleContext(store, P(), { scope: { kind: 'work', ids: ['thread_w2'] }, purpose: 'Work', kind: 'Implement', recipient: 'Worker agent', lastSessionAt: null, taskVersion: null }, 'Idle').markdown;
  const plan = src('docs/PLAN.md', 'W-2 Count by ear').id;
  assert.ok(pack.includes(`Count by ear (\`thread_w2\`): Update pending: `), pack.slice(pack.indexOf('## Freshness')));
  assert.ok(pack.includes(`docs/PLAN.md (\`${plan}\` — names W-2 in docs/PLAN.md › Plan › W-2 Count by ear; it was written from docs/PLAN.md › Plan › W-2 Count by ear)`), pack.slice(pack.indexOf('## Freshness')));
  assert.match(pack, /material that is `Update pending` is organized/, 'with when it is organized');

  const brief = nodeBrief(nodeDetail(store, P(), 'ref_d1') as never);
  assert.match(brief, /## Update pending \(1\)\n- docs\/DECISIONS\.md \(`src_[0-9a-f]+`\) — names D1 in docs\/DECISIONS\.md › Decisions; it rests on docs\/DECISIONS\.md › Decisions/, brief);
  assert.match(brief, /Read any of them now with `pk get <id>`; asking the Keeper about this object reads them in\./);

  const known = knownPart(store, 'count at dawn D1');
  assert.match(known.text, /Decision “D1 Count at dawn” \(`ref_d1`, Current\) \[Update pending: waiting for docs\/DECISIONS\.md \(names D1 in docs\/DECISIONS\.md › Decisions; it rests on/, known.text);
  assert.ok(known.pendingSourceIds.includes(src('docs/DECISIONS.md', 'Decisions').id), 'the investigation reads what it waits for');
});

test('without the version the round took in, a changed document counts whole: every section of it may have changed', () => {
  const pending = clerkPending(store, P());
  const marks = updatePendingMarks({ store, project: P(), pending, takenInAt: takenInAt(store), ledger: null });
  const w1 = (marks.threads.get('thread_w1') ?? []).find((w) => w.label === 'docs/PLAN.md');
  assert.ok(w1?.reasons.some((r) => r.detail === 'it was written from docs/PLAN.md › Plan › W-1 Count by hand'), `W-1's section cannot be told apart: ${JSON.stringify(marks.threads.get('thread_w1'))}`);
});

test('a round starts: what it took in leaves the pending list, and every mark that waited for it goes', async () => {
  await wait(20);
  const r2 = new Date().toISOString();
  store.clerkRounds.put({ id: 'crd_2', projectId: pid, kind: 'Follow up', number: 2, startedAt: r2, endedAt: null, status: 'Running', rootJobId: 'job_r2', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: r2 } as ClerkRound);
  app.refreshCoverage(pid);
  assert.deepEqual(store.coverage.scopes.find((s) => s.id === 'project')!.pending, [], 'the round took everything in');
  assert.deepEqual(store.threads.filter((t) => t.pendingSourceIds.length > 0 || t.waitsFor !== undefined).map((t) => t.id), [], 'no work item waits');
  assert.deepEqual(store.reference.filter((r) => (r.pendingSourceIds ?? []).length > 0 || r.waitsFor !== undefined).map((r) => r.id), []);
  assert.deepEqual(store.areas.filter((a) => a.pendingSourceIds.length > 0).map((a) => a.id), []);
  assert.ok(!graphView(store, P()).nodes.some((n) => n.updatePending), 'the graph shows none');
});
