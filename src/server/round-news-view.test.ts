/**
 * A Follow up round's news as `Notes (attention)` carries it (graph-view.ts; Spec §3.8, §6.2; CKC-07 AC-27, CKC-24
 * AC-15; QC AY package C): each entry keeps the program's count — what it is, its position, what changed for it — and
 * gains the jump the workbench has to where it is: the patch, the note, a territory in `Code`, or the object in the
 * process view. An entry whose object the workbench no longer draws is still listed, with its position, and has no jump.
 * A round that found nothing new has no item. `Since last visit` sums up every round since the owner's last visit, one
 * row each, opened or not, and every round's result stays reachable after it has been opened: the Keeper view's rounds
 * find it by the clerk round it closed with (§3.8, §5.5, §6.9; QC AH #11). An invented project ("Tern", a tide-table
 * app) in a store of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClerkRound, CodeTerritory, EvidenceRef, RoundNews, RoundNewsItem, SemanticPatch } from '../model/k-types.ts';
import type { FollowUpRound, GraphNode, Note, Project, RoundResult } from '../model/types.ts';
import { ProjectStore } from '../store/project-store.ts';
import { overview, roundName, roundResults } from './graph-view.ts';

const P = 'tern';
const AT = '2026-09-20T10:00:00.000Z';
const ev: EvidenceRef = { kind: 'object', id: 'x', label: 'x' };
const node = (id: string, label: string, validity: GraphNode['validity'] = 'Current'): GraphNode => ({ id, projectId: P, category: 'Work item', label, refKind: 'thread', refId: id, validity, progress: 'In progress', basis: 'Explicit', attribution: null, sourceIds: [], areaId: null, parentWorkId: null, replacedBy: null, updatedAt: AT });
const entry = (id: string, objectId: string | null, label = id): RoundNewsItem => ({ id, label, position: `Process view · ${label}`, objectId, detail: null });
const note: Note = {
  id: 'note_leap', projectId: P, mount: { kind: 'node', ids: ['thr_tides'] }, status: 'Current', ownerResponse: null,
  versions: [{ version: 1, at: AT, title: 'Leap days are missing', preview: '', body: { currentView: '', whyItMatters: null, facts: [], otherExplanations: null, keepAdjust: null, whatWouldSettleIt: null }, ask: 'For information', judgementRecordId: 'jdg', reason: '' }],
  discussion: [], followUps: [], author: { agent: 'pi', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, cameFrom: null, language: 'en', updatedAt: AT,
} as unknown as Note;
const patch: SemanticPatch = { id: 'sp_tides', projectId: P, number: 'SP-1', title: 'Tides v1 withdrawn', invalidated: 'the v1 table', replacedBy: 'the v2 table', affects: ['thr_tides'], affectsText: 'the tide work', mustNotPassAsCurrent: 'v1', oldAnchor: ev, newAnchor: null, decision: null, candidate: ev, partial: false, occurred: { at: '2026-09-19', basis: 'Commit', anchor: null }, status: 'Confirmed', writtenToFolder: null, roundId: null, jobId: null, updatedAt: AT };
const territory: CodeTerritory = { id: 'terr_moon', projectId: P, name: 'Moon phases', summary: '', repo: 'tern', paths: ['src/moon.ts'], kind: 'area', areaId: null, alsoServes: [], anomalies: [], roundId: null, jobId: null, updatedAt: AT };
const result = (news: RoundNews): RoundResult => ({ at: AT, summary: 'the round', counts: { objectsJudged: 0, byState: {}, behind: 0, itemsLacked: 0, notJudged: 0, requests: 0, notes: 0, decisionsReplaced: 0, decisionsSuspected: 0 }, behind: [], byHolder: [], noteIds: [], unassigned: [], news });
const record = (id: string, number: number, news: RoundNews): FollowUpRound => ({ id, projectId: P, number, startedAt: AT, endedAt: AT, mainJobId: null, result: result(news), seenAt: null });
const empty = { breakpoints: [], sendbacks: [], sixThings: [], patches: [], notes: [] };

test('each news entry carries the jump to where it is; one whose object is gone is listed without one; a round with nothing new has no item', () => {
  const store = ProjectStore.open(P, mkdtempSync(join(tmpdir(), 'pk-news-view-')));
  store.nodes.put(node('thr_tides', 'T-4 Tide tables'));
  store.nodes.put(node('thr_gone', 'T-9 Old almanac', 'Removed'));
  store.notes.put(note);
  store.patches.put(patch);
  store.territories.put(territory);
  store.rounds.put(record('round_0001', 1, {
    ...empty,
    breakpoints: [entry('bp_1', 'thr_tides', 'Findings open on T-4 Tide tables'), entry('bp_2', 'thr_gone'), entry('bp_3', null)],
    sixThings: [entry('terr_moon', 'terr_moon', '6 looks residual · code anomaly Unreferenced in Moon phases'), entry('note_leap', 'thr_tides', '2 drift · note “Leap days are missing”')],
    patches: [entry('sp_tides', 'thr_tides', 'SP-1 Tides v1 withdrawn'), entry('sp_missing', 'thr_tides')],
    notes: [entry('note_leap', 'thr_tides', 'Leap days are missing')],
    nothingNew: false, statement: '3 breakpoints newly lit · 2 newly among the six things · 2 semantic patches confirmed · 1 note written or updated', complete: true,
  }));
  store.rounds.put(record('round_0002', 2, { ...empty, nothingNew: true, statement: 'Follow up round 2 found nothing new', complete: true }));
  const ov = overview(store, { id: P, scopeQuestions: [] } as unknown as Project, null, null);
  const rounds = ov.needsYou.filter((x) => x.kind === 'round');
  assert.deepEqual(rounds.map((x) => x.id), ['round_0001'], 'the round with nothing new has no item');
  const news = rounds[0]!.news!;
  assert.equal(rounds[0]!.roundName, 'Follow up round 1');
  assert.deepEqual(news.breakpoints.map((i) => i.go), [{ to: 'process', id: 'thr_tides', label: 'T-4 Tide tables' }, null, null], 'the object in the process view; a removed object and no object: no jump');
  assert.deepEqual(news.sixThings.map((i) => i.go), [{ to: 'code', id: 'terr_moon', label: 'Moon phases' }, { to: 'note', id: 'note_leap', label: 'Leap days are missing' }], 'a territory in Code; a note tagged among the six things opens the note');
  assert.deepEqual(news.patches.map((i) => i.go), [{ to: 'patch', id: 'sp_tides', label: 'SP-1 Tides v1 withdrawn' }, null], 'a patch the project does not have has no jump');
  assert.deepEqual(news.notes.map((i) => i.go), [{ to: 'note', id: 'note_leap', label: 'Leap days are missing' }]);
  assert.deepEqual(news.breakpoints.map((i) => i.position), ['Process view · Findings open on T-4 Tide tables', 'Process view · bp_2', 'Process view · bp_3'], 'the positions stay as the program counted them');
});

// ───────────────────────── every round since the last visit, and every result after it was opened (QC AH #11) ─────────────────────────

const T0 = '2026-09-20T08:00:00.000Z';
const VISIT = '2026-09-20T12:00:00.000Z';
const T1 = '2026-09-21T08:00:00.000Z';
const T2 = '2026-09-22T08:00:00.000Z';
const quietCounts = { objectsJudged: 3, byState: {}, behind: 0, itemsLacked: 0, notJudged: 0, requests: 0, notes: 0, decisionsReplaced: 0, decisionsSuspected: 0 };
const closed = (s: ProjectStore, id: string, number: number, endedAt: string, over: Partial<RoundResult>, seenAt: string | null = null) =>
  s.rounds.put({ id, projectId: P, number, startedAt: endedAt, endedAt, mainJobId: null, seenAt, result: { at: endedAt, summary: 'the round', counts: quietCounts, behind: [], byHolder: [], noteIds: [], unassigned: [], ...over } });
const clerk = (s: ProjectStore, id: string, number: number, followUpRoundId: string) =>
  s.clerkRounds.put({ id, projectId: P, kind: 'Follow up', number, startedAt: AT, endedAt: AT, status: 'Done', rootJobId: `job_${id}`, questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId, updatedAt: AT } as ClerkRound);

/** A result closed before rounds counted their news, before the last visit, never opened, with objects left behind; a
 *  round with news the owner has opened since; the last round, which found nothing new. */
function threeRounds() {
  const s = ProjectStore.open(P, mkdtempSync(join(tmpdir(), 'pk-news-view-')));
  closed(s, 'round_0001', 1, T0, { counts: { ...quietCounts, behind: 2 }, behind: [{ nodeId: 'thr_a', holder: null, lacks: 1 }, { nodeId: 'thr_b', holder: 'Worker agent', lacks: 2 }], unassigned: ['thr_a'] });
  closed(s, 'round_0002', 2, T1, { news: { ...empty, nothingNew: false, statement: '1 breakpoint newly lit', complete: true } }, T2);
  closed(s, 'round_0003', 3, T2, { news: { ...empty, nothingNew: true, statement: 'Follow up round 6 found nothing new', complete: true } });
  clerk(s, 'crd_5', 5, 'round_0002');
  clerk(s, 'crd_6', 6, 'round_0003');
  return s;
}
const tern = { id: P, scopeQuestions: [] } as unknown as Project;

test('Since last visit sums up every Follow up round since the last visit, one row each in the order they ended — the one already opened too, and the one that found nothing new', () => {
  const s = threeRounds();
  const since = overview(s, tern, VISIT, null).sinceLastVisit!;
  assert.ok(since, 'a round with news since the last visit is a meaningful change');
  assert.deepEqual(since.rounds.map((r) => [r.id, r.label, r.seen, r.kind]), [
    ['round_0002', 'Follow up round 5: 1 breakpoint newly lit', true, 'round'],
    ['round_0003', 'Follow up round 6: found nothing new', false, 'round'],
  ]);
  assert.ok(since.rounds[0]!.news && since.rounds[0]!.roundName === 'Follow up round 5', 'the row opens as its Notes (attention) item does: its news and its name');
  assert.deepEqual([since.threads, since.changes, since.notes], [[], [], []]);
});

test('rounds that found nothing new are no meaningful change on their own: then there is no Since last visit at all', () => {
  assert.equal(overview(threeRounds(), tern, T1, null).sinceLastVisit, null, 'only the round that found nothing new ended since');
});

test('Notes (attention) keeps one item per round with something new until it is opened; every round’s result stays reachable by the clerk round it closed with', () => {
  const s = threeRounds();
  const ov = overview(s, tern, null, null);
  assert.deepEqual(ov.needsYou.filter((x) => x.kind === 'round').map((x) => [x.id, x.label]), [['round_0001', 'Follow up round 1: 2 objects still on the old understanding, 1 with no holder']],
    'the opened round has left, the round that found nothing new never came; the earlier result is here as it always was');
  assert.deepEqual(roundResults(s), [
    { id: 'round_0001', name: 'Follow up round 1', clerkRoundId: null, at: T0, line: '2 objects still on the old understanding, 1 with no holder', seen: false },
    { id: 'round_0002', name: 'Follow up round 5', clerkRoundId: 'crd_5', at: T1, line: '1 breakpoint newly lit', seen: true },
    { id: 'round_0003', name: 'Follow up round 6', clerkRoundId: 'crd_6', at: T2, line: 'found nothing new', seen: false },
  ]);
  assert.deepEqual(ov.roundResults, roundResults(s), 'the overview carries them for the Keeper view');
  assert.equal(roundName(s, 'round_0002'), 'Follow up round 5');
});
