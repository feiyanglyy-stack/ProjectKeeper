/**
 * Two small items of the QC AY review on code anomalies (CKC-25 AC-5, AC-7; Spec §1.19, §6.17):
 * - a residual judgement (Unreferenced, Looks residual but live) on code whose references the ledger does not read
 *   completely is Inferred — the program sets it from what the ledger measured (D98 补: TypeScript through the compiler,
 *   every other language through the general code engine), whatever basis the model gives;
 * - a note about an anomaly is linked into the anomaly's `noteIds` when it is written, so the anomaly in Code opens it
 *   (they were never written); a code territory is not a note's mount, and the refusal says what to do instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import { ledgerPath, rebuildLedgerInPlace } from '../ledger/rebuild.ts';
import type { Project, ReferenceItem, ScopeItem } from '../model/types.ts';
import type { ClerkRound } from '../model/k-types.ts';
import { clerkTools } from './clerk-tools.ts';
import { keeperTools } from './tools.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'pk-anomaly-'));
const git = (args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.invalid', GIT_AUTHOR_DATE: '2026-09-01T09:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T09:00:00Z' }, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel: string, body: string) => { mkdirSync(join(ROOT, rel, '..'), { recursive: true }); writeFileSync(join(ROOT, rel), body); };
git(['init', '-q', '-b', 'main']);
write('app/lib/residual.dart', 'class Residual {}\n');
write('app/lib/live.dart', "import 'residual.dart';\n\nfinal residual = Residual();\n");
// A Dart `part` the code engine does not follow: the part is named by its library, yet no counted reference reaches it.
write('app/lib/library.dart', "part 'piece.dart';\n\nclass Library {}\n");
write('app/lib/piece.dart', "part of 'library.dart';\n\nclass Piece {}\n");
write('web/src/orphan.ts', 'export const orphan = 1;\n');
write('notes/readme.md', '# Notes\n');
git(['add', '-A']);
git(['commit', '-q', '-m', 'Start']);

const scope = { id: 'scope_main', path: ROOT, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as ScopeItem;
const project = { id: 'p1', name: 'Mixed', language: 'en', locations: [ROOT], scope: [scope], scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false, createdAt: '2026-09-01T00:00:00Z', lastOpenedAt: null, lastScopedAt: null } as unknown as Project;
const area = { id: 'ref_area', projectId: 'p1', category: 'Area', name: 'Library', ids: [], text: 'Library.', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: '', updatedAt: '' } as unknown as ReferenceItem;
const round: ClerkRound = { id: 'round_1', projectId: 'p1', kind: 'Deepen', number: 2, startedAt: '2026-09-26T00:00:00Z', endedAt: null, status: 'Running', rootJobId: 'root', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: '' };

type Run = (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
function tool(list: ReturnType<typeof clerkTools>, name: string) {
  const t = list.find((x) => x.name === name)!;
  return async (args: Record<string, unknown>) => {
    const r = await (t.execute as unknown as Run)('call', args);
    const text = r.content.map((c) => c.text).join('\n');
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* prose */ }
    return { error: r.isError === true, text, json };
  };
}
const unreferenced = (file: string, basis = 'Explicit') => ({ kind: 'Unreferenced', text: `${file} is referenced by nothing.`, evidence: [{ kind: 'file', id: file }], basis });

test('a residual judgement is Inferred where the ledger does not read the references completely; a note about an anomaly opens from it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-anomaly-store-'));
  const store = ProjectStore.open('p1', home);
  store.reference.put(area);
  store.clerkRounds.put(round);
  const clerk = clerkTools({ store, project, jobId: 'job_cc', jobKind: 'Organizing', model: null, step: { roundId: 'round_1', kind: 'cross-check', path: null } });
  const territory = tool(clerk, 'pk_write_territory');

  // Before the ledger is built nothing is measured: a residual call is Inferred, and says so.
  const early = await territory({ name: 'Web early', summary: 'The web client.', repo: 'scope_main', paths: ['web/src'], kind: 'non-product', anomalies: [unreferenced('web/src/orphan.ts')] });
  assert.equal(store.territories.get(early.json.id as string)!.anomalies[0]!.basis, 'Inferred');
  assert.match(JSON.stringify(early.json.basisSetByProgram), /not built yet/);

  rebuildLedgerInPlace(ledgerPath('p1', home), project, {});

  // Dart read by the code engine, with a `part` it does not follow: the part is named by its library, so an Explicit
  // residual call there is set to Inferred; a docs-disagree call keeps its basis.
  const dart = await territory({ name: 'Reading room', summary: 'The reading room screens.', repo: 'scope_main', paths: ['app/lib/library.dart', 'app/lib/piece.dart'], kind: 'area', areaId: 'ref_area',
    anomalies: [unreferenced('app/lib/piece.dart'), { kind: 'Docs disagree', text: 'The design names a room the code has not.', evidence: [{ kind: 'file', id: 'app/lib/library.dart' }], basis: 'Explicit' }] });
  assert.equal(dart.error, false, dart.text);
  const dartT = store.territories.get(dart.json.id as string)!;
  assert.deepEqual(dartT.anomalies.map((a) => [a.kind, a.basis]), [['Unreferenced', 'Inferred'], ['Docs disagree', 'Explicit']], 'the program sets the residual call Inferred; the other judgement keeps its basis');
  assert.match(JSON.stringify(dart.json.basisSetByProgram), /named by other files/, 'and says why');

  // Dart whose references the engine resolves: the model's Explicit stands, as for TypeScript read by the compiler.
  const resolved = await territory({ name: 'Residual', summary: 'The residual class.', repo: 'scope_main', paths: ['app/lib/residual.dart', 'app/lib/live.dart'], kind: 'non-product', anomalies: [unreferenced('app/lib/residual.dart')] });
  assert.equal(store.territories.get(resolved.json.id as string)!.anomalies[0]!.basis, 'Explicit', resolved.text);
  const ts = await territory({ name: 'Web', summary: 'The web client.', repo: 'scope_main', paths: ['web/src'], kind: 'non-product', anomalies: [unreferenced('web/src/orphan.ts')] });
  assert.equal(store.territories.get(ts.json.id as string)!.anomalies[0]!.basis, 'Explicit');
  assert.equal(ts.json.basisSetByProgram, undefined);

  // A place with no code at all: nothing computed either way.
  const notes = await territory({ name: 'Notes', summary: 'Loose notes.', repo: 'scope_main', paths: ['notes'], kind: 'non-product', anomalies: [unreferenced('notes/readme.md')] });
  assert.equal(store.territories.get(notes.json.id as string)!.anomalies[0]!.basis, 'Inferred');
  assert.match(JSON.stringify(notes.json.basisSetByProgram), /hold no code/);

  // A note about the Dart anomaly: hung on the area, linked into the anomaly it names.
  const keeper = keeperTools({ store, project, jobId: 'job_syn', jobKind: 'Organizing', model: null, step: { roundId: 'round_1', kind: 'synthesis', path: null } });
  const judged = await tool(keeper, 'pk_record_judgement')({ scopeKind: 'project', scopeIds: [], scopeLabel: 'round', referenceIds: [], threadIds: [], areaIds: [], relationIds: [], keyEvidenceSourceIds: [], conflictingSourceIds: [], previousNoteIds: [], excluded: [] });
  const note = tool(keeper, 'pk_write_note');
  const base = { mountKind: 'node', mountIds: ['ref_area'], title: 'Is residual.dart still needed?', preview: 'Is residual.dart still needed? Nothing references it.', ask: 'For your decision', options: [{ option: 'Remove it', then: 'the file is deleted and nothing else changes' }, { option: 'Keep it', then: 'it stays unreferenced, and the anomaly stays listed' }], judgementRecordId: judged.json.id, reason: 'synthesis' };
  const onTerritory = await note({ ...base, mountIds: [dartT.id] });
  assert.equal(onTerritory.error, true);
  assert.match(onTerritory.text, /is a code territory, which the graph does not draw\. Hang the note on the area the territory serves.*codeAnomalies/);
  const unknown = await note({ ...base, codeAnomalies: [{ territoryId: 'terr_nowhere' }] });
  assert.match(unknown.text, /terr_nowhere is not a code territory of the assets\. Nothing was written/);
  const ambiguous = await note({ ...base, codeAnomalies: [{ territoryId: dartT.id }] });
  assert.match(ambiguous.text, /which of Reading room’s 2 anomalies the note is about/);
  assert.equal(store.notes.size, 0, 'a refused note is not written');

  const written = await note({ ...base, codeAnomalies: [{ territoryId: dartT.id, index: 0 }, { territoryId: resolved.json.id }] });
  assert.equal(written.error, false, written.text);
  const noteId = written.json.id as string;
  assert.deepEqual(store.territories.get(dartT.id)!.anomalies.map((a) => a.noteIds), [[noteId], []], 'the named anomaly carries the note; the other does not');
  assert.deepEqual(store.territories.get(resolved.json.id as string)!.anomalies[0]!.noteIds, [noteId], 'a territory with one anomaly may be named without the index');
  assert.deepEqual(store.notes.get(noteId)!.mount, { kind: 'node', ids: ['ref_area'] });

  // The cross-check drawing the territory again keeps the note on the same anomaly.
  await territory({ name: 'Reading room', summary: 'The reading room screens, still.', repo: 'scope_main', paths: ['app/lib/library.dart', 'app/lib/piece.dart'], kind: 'area', areaId: 'ref_area', anomalies: [unreferenced('app/lib/piece.dart')] });
  assert.deepEqual(store.territories.get(dartT.id)!.anomalies.map((a) => a.noteIds), [[noteId]]);
});
