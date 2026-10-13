/**
 * `pk import` (src/table/import.ts): the ProjectKeeper table taken into a home. The mapping alone first — each part of
 * the table onto the store's records, the way the story map reads them — then a whole import into a fresh home of a
 * small invented project ("Tiny", a read-later list) with its own git history: the table replaces the picture, the
 * graph is derived from it, the workbench's placement puts a work item in its area's column and its plan's band, an
 * earlier plan rolls up into a generation that says where its work went, and a table with a problem writes nothing.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Source } from '../model/types.ts';
import type { TableSource } from './check.ts';
import type { Table } from './import.ts';

// The App reads the session stores of the user's home and the model library's settings: both point into the scratch.
const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-import-'));
process.env.USERPROFILE = scratch;
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(scratch, 'pi-'));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const { git } = await import('../util/git.ts');
const { canonicalPath } = await import('../util/paths.ts');
const { carryOwnerSide, importTable, mapTable, sourceKey, storeIdsOf } = await import('./import.ts');
const { ProjectStore } = await import('../store/project-store.ts');
const { workbenchPlacement } = await import('../keeper/organize/workbench-placement.ts');
const { graphView } = await import('../server/graph-view.ts');
const { takeoverState } = await import('../keeper/organize/takeover-state.ts');

/** A one-repository project: a product page, a plan, decisions, a QC receipt and two code files, committed once. */
function project(): { dir: string; commit: string } {
  const dir = canonicalPath(mkdtempSync(join(scratch, 'tiny-')));
  const files: Record<string, string> = {
    'docs/PRODUCT.md': '# Tiny\n\nA read-later list for one person.\n\n## Areas\n\n- A1 Capture: one shortcut.\n- A2 Search: under a second.\n',
    'docs/PLAN.md': '# Plan\n\n## PLAN-1 · First cut\n\nThe first cut had capture, the note field, a tag browser and an import.\n\n## PLAN-2 · Search\n\nSearch first, then the review of the milestone.\n',
    'docs/DECISIONS.md': '# Decisions\n\n- DEC-1 · No accounts.\n- DEC-2 · Ship search before polish.\n- DEC-3 · Accounts after all.\n',
    'docs/receipts/qc-1.md': '# QC\n\nVerdict: PASS\n',
    'src/capture.ts': 'export const capture = 1;\n',
    'src/search.ts': 'export const search = 1;\n',
  };
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); }
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '-m', 'first']]) assert.ok(git(dir, args).ok);
  return { dir, commit: git(dir, ['rev-parse', 'HEAD']).out.trim() };
}

const sessions = [
  { session: 'claude:s1', message: 1, text: 'Shall I build search before anything else, and leave the polish for later?' },
  { session: 'claude:s1', message: 2, text: '可以，先做搜索。' },
];

function table(commit: string): Table {
  const product = { file: 'docs/PRODUCT.md', lines: '1-3' };
  const plan1 = { file: 'docs/PLAN.md', lines: '3-5' };
  const plan2 = { file: 'docs/PLAN.md', lines: '7-9' };
  const decisions = (line: string) => ({ file: 'docs/DECISIONS.md', lines: line });
  return {
    format: 'projectkeeper.table/1',
    project: { name: 'Tiny', asOf: { date: '2026-10-13', repos: [{ path: '.', commit }] }, filledBy: { agent: 'test', at: '2026-10-13' } },
    ownerWants: [{
      id: 'W1', want: 'Search comes first.', kind: 'Product', status: 'Current',
      said: [{ session: 'claude:s1', message: 2, quote: '可以，先做搜索。' }],
      approvedProposal: { part: 'build search before anything else', source: { session: 'claude:s1', message: 1 } },
      reflectedIn: ['A2', 'T-3', 'search'],
    }],
    product: { id: 'Tiny', name: 'Tiny', summary: 'A read-later list.', forWhom: 'One person.', sources: [product] },
    goals: [{ id: 'G1', name: 'Quick', summary: 'Save and find quickly.', status: 'Current', sources: [product] }],
    areas: [
      { id: 'A1', name: 'Capture', summary: 'One shortcut.', status: 'Current', goals: ['G1'], sources: [{ file: 'docs/PRODUCT.md', lines: '7' }] },
      { id: 'A2', name: 'A2 Search', summary: 'Under a second.', status: 'Current', sources: [{ file: 'docs/PRODUCT.md', lines: '8' }] },
    ],
    requirements: [{ id: 'REQ-1', name: 'Search under a second', summary: 'Search answers within a second.', status: 'Current', place: { area: 'A2' }, sources: [{ file: 'docs/PRODUCT.md', lines: '8' }] }],
    designs: [{ id: 'DS-1', name: 'One index', summary: 'One index for capture and search.', status: 'Current', place: { areas: ['A1', 'A2'] }, inferred: true, sources: [{ file: 'src/search.ts' }] }],
    decisions: [
      { id: 'DEC-1', name: 'No accounts', summary: 'No accounts.', status: 'Current', boundary: true, place: { wholeProduct: 'It decides how every part stores the list.' }, sources: [decisions('3')] },
      { id: 'DEC-2', name: 'Search before polish', summary: 'Ship search before polish.', status: 'Current', partlyReplaced: [{ by: 'DEC-1', part: 'Polish waits for search.' }], place: { plan: 'PLAN-2' }, sources: [decisions('4')] },
      { id: 'DEC-3', name: 'Accounts after all', summary: 'Accounts after all.', status: 'Replaced', replacedBy: 'DEC-1', place: { area: 'A1' }, sources: [decisions('5')] },
    ],
    plans: [
      { id: 'PLAN-1', name: 'First cut', summary: 'Capture and a tag browser.', status: 'Replaced', replacedBy: 'PLAN-2', why: 'Search came first.', ended: '2026-09-01', sources: [plan1] },
      { id: 'PLAN-2', name: 'Search', summary: 'Search first.', status: 'Current', sources: [plan2] },
    ],
    work: [
      { id: 'T-1', name: 'Capture shortcut', summary: 'One shortcut saves.', plan: 'PLAN-1', area: 'A1', status: 'Current', progress: 'In progress', became: { carriedOnBy: 'T-3' }, sources: [plan1] },
      { id: 'T-2', name: 'Note field', summary: 'A note saves with the page.', plan: 'PLAN-1', area: 'A1', status: 'Current', progress: 'Planned', became: { movedTo: 'PLAN-2' }, sources: [plan1] },
      { id: 'T-4', name: 'Tag browser', summary: 'Browse by tag.', plan: 'PLAN-1', area: 'A2', status: 'Current', progress: 'Planned', became: { dropped: 'Search replaced it.' }, sources: [plan1] },
      { id: 'T-5', name: 'Import', summary: 'Import a list.', plan: 'PLAN-1', area: 'A1', status: 'Current', progress: 'In progress', became: { finished: 'Done before the new plan.' }, sources: [plan1] },
      {
        id: 'T-3', name: 'Search index', summary: 'Index title and body.', plan: 'PLAN-2', area: 'A2', alsoAreas: ['A1'], implements: ['REQ-1', 'DEC-1'],
        status: 'Current', progress: 'Done', open: 'The refresh is by hand.', accepted: { session: 'claude:s1', message: 2 },
        steps: [{ kind: 'QC', at: '2026-10-01', verdict: 'Verdict: PASS', source: { file: 'docs/receipts/qc-1.md', lines: '3' } }, { kind: 'Merged', source: { commit } }],
        sources: [plan2],
      },
      { id: 'T-6', name: 'Milestone review', summary: 'Review the milestone.', plan: 'PLAN-2', wholePlan: 'It reviews every area of the plan.', dependsOn: ['T-3'], status: 'Current', progress: 'Planned', sources: [plan2] },
    ],
    code: [
      { id: 'capture', name: 'Capture', summary: 'The shortcut.', area: 'A1', paths: ['src/capture.ts'], anomalies: [{ kind: 'Docs disagree', text: 'The product page says one shortcut; the code has none yet.', sources: [{ file: 'src/capture.ts', lines: '1' }] }] },
      { id: 'search', name: 'Search', summary: 'The index.', area: 'A2', alsoAreas: ['A1'], paths: ['src/search.ts', 'src'] },
    ],
    notes: [{
      id: 'N-1', title: 'The refresh is by hand.', kind: 'Anomaly', ask: 'For your decision', by: 'Project', on: ['T-3', 'capture'], text: 'Search is what the owner wants first.',
      options: [{ choice: 'Build the refresh', consequence: 'One more task.' }, { choice: 'Leave it', consequence: 'The index goes stale.' }],
      sources: [{ file: 'docs/receipts/qc-1.md', lines: '3', quote: 'Verdict: PASS' }],
    }],
  } as unknown as Table;
}

/** A store source for every cited place, without reading anything: what `resolveSources` would hand over. */
const fakeSource = (s: TableSource): Source => ({
  id: `src_${sourceKey(s)}`, projectId: 'tiny', title: sourceKey(s),
  anchor: s.commit ? { kind: 'commit', repo: '/tiny', commit: s.commit.padEnd(40, '0') } : { kind: 'file', path: `/tiny/${s.file ?? 'x'}`, headingPath: [], lineStart: 1, lineEnd: 1 },
  ids: [], version: { fingerprint: 'x', readAt: '2026-10-13', commit: null }, excerpt: '', usedAs: null, usedAsBy: null, availability: null, movedTo: null,
  scopeItemId: 'scope', hasCredential: false, bytes: 0,
});

test('the mapping: each part of the table becomes the record the workbench reads, with the place it is drawn in', () => {
  const t = table('abcdef1');
  const m = mapTable(t, { projectId: 'tiny', projectDir: '/tiny', repos: [{ path: '', commit: 'abcdef1', dir: '/tiny' }], source: fakeSource });
  const ids = storeIdsOf(t, 'tiny');
  const id = (x: string) => ids.get(x)!;
  const ref = (x: string) => m.reference.find((r) => r.id === id(x))!;
  const thread = (x: string) => m.threads.find((w) => w.id === id(x))!;

  // Categories, names and the table's own ids; a name that starts with its id keeps it once.
  const byCategory = (c: string) => m.reference.filter((r) => r.category === c).length;
  assert.deepEqual(["Owner's words", 'Product', 'Goal', 'Area', 'Requirement', 'Design', 'Decision', 'Boundary', 'Plan'].map(byCategory), [1, 1, 1, 2, 1, 1, 2, 1, 2]);
  assert.equal(ref('A1').name, 'A1 · Capture');
  assert.equal(ref('A2').name, 'A2 Search');
  assert.deepEqual(ref('A1').ids, ['A1']);

  // The owner's words: author owner, identity Decision, the owner's words as the quote, the message a short yes answers.
  const w1 = ref('W1');
  assert.deepEqual([w1.attribution.author.kind, w1.attribution.identity, w1.quote, w1.answers], ['owner', 'Decision', '可以，先做搜索。', 'build search before anything else']);
  assert.deepEqual(w1.sourceIds, ['src_session:claude:s1#2', 'src_session:claude:s1#1']);
  // What carries a want out refines it (a reference item) or serves it (a work item); a territory has no node to draw it on.
  assert.ok(ref('A2').refines.includes(id('W1')));
  assert.ok(thread('T-3').serves.some((s) => s.referenceId === id('W1')));

  // Places: one area, several areas, a plan (an execution decision), the whole product with its reason.
  assert.deepEqual(ref('REQ-1').refines, [id('A2')]);
  assert.deepEqual(ref('DS-1').refines, [id('A1'), id('A2')]);
  assert.deepEqual([ref('DS-1').basis, ref('DS-1').attribution.identity], ['Inferred', 'Interpretation']);
  assert.deepEqual(ref('DEC-2').refines, [id('PLAN-2')]);
  // A part overturned later: kept for the program, said in the text the popover shows; the decision stays in force.
  assert.equal(ref('DEC-2').validity, 'Current');
  assert.deepEqual(ref('DEC-2').supersededParts!.map((p) => [p.part, p.byId]), [['Polish waits for search.', id('DEC-1')]]);
  assert.match(ref('DEC-2').text, /No longer holds: Polish waits for search\. \(DEC-1\)/);
  assert.deepEqual([ref('DEC-1').category, ref('DEC-1').refines, ref('DEC-1').wholeProductWhy], ['Boundary', [id('Tiny')], 'It decides how every part stores the list.']);
  assert.deepEqual([ref('DEC-3').validity, ref('DEC-3').replacedBy], ['Replaced', id('DEC-1')]);
  assert.deepEqual(ref('A2').refines.slice(0, 1), [id('Tiny')], 'an area with no goal refines the product');
  assert.equal(ref('PLAN-1').text, 'Capture and a tag browser.\n\nSearch came first.');

  // A work item serves its area first, then its other areas, then its plan; its sources ride on a fact record.
  const t3 = thread('T-3');
  assert.deepEqual(t3.serves.slice(0, 3).map((s) => s.referenceId), [id('A2'), id('A1'), id('PLAN-2')]);
  assert.deepEqual([t3.title, t3.ids, t3.unresolved, t3.acceptance], ['Search index', ['T-3'], 'The refresh is by hand.', 'Accepted']);
  assert.deepEqual(m.facts.find((f) => f.id === t3.factRecordIds[0])!.aboutSourceIds, ['src_file:docs/PLAN.md#7-9', 'src_session:claude:s1#2']);
  assert.deepEqual(m.relations.filter((r) => r.from === t3.id).map((r) => [r.type, r.to]), [['implements', id('REQ-1')], ['carries out', id('DEC-1')]]);
  assert.deepEqual([thread('T-6').wholePlanWhy, thread('T-6').serves.map((s) => s.referenceId), thread('T-6').dependsOn.map((d) => d.threadId)], ['It reviews every area of the plan.', [id('PLAN-2')], [t3.id]]);

  // What became of the earlier plan's work.
  assert.deepEqual([thread('T-1').validity, thread('T-1').replacedBy], ['Replaced', t3.id]);
  assert.deepEqual(thread('T-2').serves.map((s) => s.referenceId), [id('A1'), id('PLAN-1'), id('PLAN-2')]);
  assert.equal(thread('T-4').validity, 'Abandoned');
  assert.deepEqual([thread('T-5').validity, thread('T-5').progress], ['Current', 'Done']);
  assert.equal(m.generations.length, 1);
  const g = m.generations[0]!;
  assert.deepEqual([g.name, g.ended.at, g.workIds, g.planRefs.map((r) => r.id)], ['PLAN-1 · First cut', '2026-09-01', ['T-1', 'T-2', 'T-4', 'T-5'].map(id), [id('PLAN-1')]]);

  // Steps the program cannot find become confirmed links with their evidence; a verdict is the evidence's line.
  assert.deepEqual(m.links.map((l) => [l.stepKind, l.ledgerRef, l.evidence?.kind, l.evidence?.line ?? null, l.confirmed]), [
    ['QC', 'file:docs/receipts/qc-1.md', 'file', 'Verdict: PASS', true],
    ['Merged', `commit:${'abcdef1'.padEnd(40, '0').slice(0, 12)}`, 'commit', null, true],
  ]);

  // Code: the area's id, paths by their repository, the anomaly with its evidence and the note that is on it.
  const capture = m.territories.find((x) => x.id === id('capture'))!;
  assert.deepEqual([capture.areaId, capture.paths, capture.repo !== '', capture.anomalies[0]!.noteIds], [id('A1'), ['src/capture.ts'], true, [id('N-1')]]);
  assert.deepEqual(m.territories.find((x) => x.id === id('search'))!.alsoServes, [id('A1')]);

  // Notes: on the objects they name, with the options, as a takeover's note.
  const n1 = m.notes[0]!;
  assert.deepEqual([n1.mount.ids, n1.versions[0]!.ask, n1.versions[0]!.body.options?.map((o) => o.option), n1.cameFrom?.kind], [[t3.id, id('capture')], 'For your decision', ['Build the refresh', 'Leave it'], 'Takeover']);
});

test('the import: the table replaces the picture, the graph is derived, the workbench places the work in its column and band', async () => {
  const p = project();
  const home = join(scratch, 'home-ok');
  const tableFile = join(p.dir, 'projectkeeper', 'project.json');
  mkdirSync(join(p.dir, 'projectkeeper'));
  writeFileSync(tableFile, JSON.stringify(table(p.commit), null, 2));
  const r = await importTable({ tableFile, home, sessions });
  assert.deepEqual(r.problems, []);
  assert.equal(r.added, true);
  const c = r.counts!;
  assert.deepEqual([c.threads, c.facts, c.relations, c.generations, c.links, c.territories, c.notes], [6, 6, 2, 1, 2, 2, 1]);
  assert.equal(c.reference.Area, 2);
  assert.ok(c.graph.nodes >= 18, `nodes: ${c.graph.nodes}`);

  // What was written, read back from the home as the workbench opens it.
  const store = ProjectStore.open(r.projectId!, canonicalPath(home));
  const ids = storeIdsOf(table(p.commit), r.projectId!);
  const id = (x: string) => ids.get(x)!;
  assert.equal(store.reference.get(id('A2'))!.category, 'Area');
  assert.equal(store.territories.get(id('capture'))!.areaId, id('A1'));
  assert.equal(store.territories.get(id('capture'))!.repo, p.dir);
  assert.deepEqual(store.threads.get(id('T-3'))!.serves.slice(0, 3).map((s) => s.referenceId), [id('A2'), id('A1'), id('PLAN-2')]);
  assert.ok(store.nodes.has(id('T-3')) && store.nodes.has(id('W1')), 'derived nodes');
  assert.ok(store.relations.all().some((x) => x.type === 'serves' && x.from === id('T-3') && x.to === id('PLAN-2')), 'derived serves');
  // The cited lines are read as they stood at the asOf commit; a session message carries its text from the material.
  const owner = store.reference.get(id('W1'))!;
  assert.equal(store.sources.get(owner.sourceIds[0]!)!.excerpt, '可以，先做搜索。');
  const req = store.sources.get(store.reference.get(id('REQ-1'))!.sourceIds[0]!)!;
  assert.equal(req.excerpt, '- A2 Search: under a second.');

  // The workbench's own placement: T-3 solid in A2 (the requirement it implements is A2's) in PLAN-2's band, dashed in A1.
  const placement = workbenchPlacement(store);
  const t3 = placement.place.get(id('T-3'))!;
  assert.deepEqual([t3.zone, t3.band, t3.area, t3.areas], ['cell', id('PLAN-2'), id('A2'), [id('A2'), id('A1')]]);
  assert.equal(placement.place.get(id('T-6'))!.whole, 'It reviews every area of the plan.');
  assert.deepEqual(placement.place.get(id('DEC-2')), { zone: 'exec', band: id('PLAN-2') });
  // PLAN-1 rolled up: where each of its items went.
  // ui/placement.d.ts declares a generation's ids only; its items with their destinations are read as placement.js returns them.
  const gen = placement.generations[0]! as typeof placement.generations[0] & { readonly items: readonly { readonly id: string; readonly destination: { readonly kind: string } }[] };
  assert.deepEqual(gen.planIds, [id('PLAN-1')]);
  const where = Object.fromEntries(gen.items.map((i) => [i.id, i.destination.kind]));
  assert.deepEqual([where[id('T-1')], where[id('T-2')], where[id('T-4')], where[id('T-5')]], ['carried', 'moved', 'dropped', 'unrecorded']);
  assert.equal(placement.place.get(id('T-2'))!.band, id('PLAN-2'), 'moved into the current plan, it stands in its band');
  // The note's ❓ is lit on the work item.
  const view = graphView(store, { id: r.projectId! } as never);
  assert.equal(view.nodes.find((n) => n.id === id('T-3'))!.noteAttention, 1);
  // D107: taking the table in is the takeover, so the workbench opens on the picture and not on the Takeover page.
  const record = JSON.parse(readFileSync(join(canonicalPath(home), 'workspace.json'), 'utf8')).projects.find((x: { id: string }) => x.id === r.projectId);
  assert.equal(record.takenOverByTable.by, 'test');
  assert.equal(takeoverState(store, record).phase, 'Done');
  assert.equal(store.coverage.state, 'Takeover complete');

  // Taken in again: the same project, the earlier picture replaced, nothing doubled.
  const again = await importTable({ tableFile, home, sessions });
  assert.equal(again.added, false);
  assert.equal(again.counts!.removed.threads, 6);
  const reread = ProjectStore.open(r.projectId!, canonicalPath(home));
  assert.equal(reread.threads.size, 6);
  assert.equal(reread.notes.size, 1);
});

test('taken in again, a note keeps what the owner did with it, and a changed text is its next version', () => {
  const ctx = { projectId: 'tiny', projectDir: '/tiny', repos: [{ path: '', commit: 'abcdef1', dir: '/tiny' }], source: fakeSource };
  const first = mapTable(table('abcdef1'), ctx).notes;
  const answered = { ...first[0]!, ownerResponse: 'Decided' as const, discussion: [{ at: '2026-10-14', who: 'owner', text: 'Reopen T-3.' }] as never };
  const extra = { ...first[0]!, id: 'note_gone_touched', ownerResponse: 'Discussed' as const };
  const untouched = { ...first[0]!, id: 'note_gone_untouched' };
  const before = [answered, extra, untouched];

  // The same text again: one version, the response and discussion kept.
  const same = carryOwnerSide(first, before, '2026-10-15');
  const kept = same.find((n) => n.id === answered.id)!;
  assert.equal(kept.ownerResponse, 'Decided');
  assert.equal(kept.discussion.length, 1);
  assert.equal(kept.versions.length, 1);
  // A note the table dropped stays, withdrawn, when the owner had answered it; one nobody touched goes with the table.
  assert.equal(same.find((n) => n.id === 'note_gone_touched')!.status, 'Withdrawn');
  assert.equal(same.some((n) => n.id === 'note_gone_untouched'), false);

  // A changed text: the next version, the owner's side still there.
  const changed = first.map((n) => n.id === answered.id ? { ...n, versions: [{ ...n.versions[0]!, title: 'Reworded' }] } : n);
  const next = carryOwnerSide(changed, before, '2026-10-15').find((n) => n.id === answered.id)!;
  assert.deepEqual(next.versions.map((v) => [v.version, v.title]), [[1, answered.versions[0]!.title], [2, 'Reworded']]);
  assert.equal(next.ownerResponse, 'Decided');
});

test('a table with a problem is refused, and nothing is written', async () => {
  const p = project();
  const home = join(scratch, 'home-refused');
  const tableFile = join(p.dir, 'projectkeeper', 'project.json');
  mkdirSync(join(p.dir, 'projectkeeper'));
  const t = table(p.commit) as unknown as { work: { area?: string }[] };
  t.work[0]!.area = 'A9';
  writeFileSync(tableFile, JSON.stringify(t));
  const r = await importTable({ tableFile, home, sessions });
  assert.match(r.problems.map((x) => `${x.at} ${x.problem}`).join('\n'), /\/work\/0\/area "A9" is not an id in this table/);
  assert.equal(r.projectId, undefined);
  assert.equal(existsSync(home), false, 'no home was made');
  // Without the session material it cites, the table is refused too.
  t.work[0]!.area = 'A1';
  writeFileSync(tableFile, JSON.stringify(t));
  assert.match((await importTable({ tableFile, home })).problems[0]!.problem, /session material/);
  assert.equal(existsSync(home), false);
});
