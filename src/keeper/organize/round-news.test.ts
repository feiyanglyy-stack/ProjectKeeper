/**
 * What a Follow up round made new (Spec §3.8, §5.5, §6.2; D79; CKC-07 AC-27, CKC-24 AC-15; QC AY B2): counted by the
 * program from what the round's jobs wrote, against where things stood when it started —
 *   - a breakpoint newly lit (not one lit before and written again);
 *   - a send-back new, or moved to another stage (not one written again at the same stage);
 *   - what newly became one of the six things;
 *   - a semantic patch confirmed;
 *   - a note written or updated (a new version; a tag alone is no update);
 * each with its position; a write by a job outside the round is not its news. The round's item in `Notes (attention)`
 * lists them, and a round with nothing new has no item — its record says so for the top bar.
 * An invented project ("Tern", a tide-table app) in a store of its own; no model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Breakpoint, ClerkRound, EvidenceRef, SemanticPatch, SendBack } from '../../model/k-types.ts';
import type { EntryMark, FollowUpRound, KeeperJob, Note, Project, WorkThread } from '../../model/types.ts';

const { ProjectStore } = await import('../../store/project-store.ts');
const { roundBaseline, roundNews } = await import('./round-news.ts');
const { roundResultOf } = await import('../adjustment.ts');
const { overview } = await import('../../server/graph-view.ts');

const P = 'tern';
const AT = '2026-09-20T10:00:00.000Z';
const ev: EvidenceRef = { kind: 'object', id: 'x', label: 'x' };
const occurred = { at: '2026-09-19', basis: 'Commit' as const, anchor: null };
const thread = (id: string, num: string, title: string): WorkThread => ({ id, projectId: P, title, ids: [num], doing: '', changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, inputs: null, asOf: AT, updatedAt: AT, pendingSourceIds: [], doneMeans: '', acceptanceMeans: '', acceptance: '' } as unknown as WorkThread);
const bp = (id: string, target: string, lit: boolean, roundId: string | null = null): Breakpoint => ({ id, projectId: P, kind: 'Findings open', targetId: target, why: 'QC listed a finding nobody handled', evidence: [ev], basis: 'Explicit', since: occurred, lit, out: null, ownerResponse: null, confirmedInRoundId: null, sixThing: 5, sendBackId: null, roundId, updatedAt: AT });
const sb = (id: string, target: string, stage: SendBack['stage']): SendBack => ({ id, projectId: P, to: 'Work', stage, targetId: target, what: 'The tide table misses the leap day', suggestion: 'Reopen the work', evidence: [ev], from: { kind: 'verdict', id: 'v' }, returned: null, closed: null, ownerResponse: null, sixThing: null, occurred, roundId: null, updatedAt: AT });
const note = (id: string, title: string, versions: number, ask: Note['versions'][number]['ask'] = 'For information'): Note => ({
  id, projectId: P, mount: { kind: 'node', ids: ['thr_tides'] }, status: 'Current', ownerResponse: null,
  versions: Array.from({ length: versions }, (_, i) => ({ version: i + 1, at: AT, title, preview: '', body: { currentView: '', whyItMatters: null, facts: [], otherExplanations: null, keepAdjust: null, whatWouldSettleIt: null }, ask, judgementRecordId: 'jdg', reason: '' })),
  discussion: [], followUps: [], author: { agent: 'pi', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, language: 'en', updatedAt: AT,
} as unknown as Note);
const patch = (id: string, status: SemanticPatch['status']): SemanticPatch => ({ id, projectId: P, number: 'SP-1', title: 'Tides v1 withdrawn', invalidated: 'the v1 table', replacedBy: 'the v2 table', affects: ['thr_tides'], affectsText: 'the tide work', mustNotPassAsCurrent: 'v1', oldAnchor: ev, newAnchor: null, decision: null, candidate: ev, partial: false, occurred, status, writtenToFolder: null, roundId: null, jobId: null, updatedAt: AT });
const job = (id: string, roundId: string | null, parentJobId: string | null = null): KeeperJob => ({ id, projectId: P, kind: 'Organizing', initiator: roundId ? 'auto' : 'owner', scope: { kind: 'clerk-step', ids: [], label: id }, status: 'Done', queuedAt: AT, startedAt: AT, endedAt: AT, savedResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId, resultText: null, priority: 1, task: null, step: roundId ? { roundId, kind: 'synthesis', path: null } : null } as unknown as KeeperJob);

function setup() {
  const store = ProjectStore.open(P, mkdtempSync(join(tmpdir(), 'pk-news-')));
  store.threads.put(thread('thr_tides', 'T-4', 'Tide tables'));
  store.threads.put(thread('thr_moon', 'T-5', 'Moon phases'));
  // Where things stand before the round: one breakpoint lit, one send-back suggested, one note, a draft patch.
  store.breakpoints.put(bp('bp_old', 'thr_moon', true, 'crd_0'));
  store.sendbacks.put(sb('sb_old', 'thr_moon', 'Suggested'));
  store.notes.put(note('note_old', 'Moon phases lag', 1));
  store.notes.put(note('note_tagged', 'Leap days', 1));
  store.patches.put(patch('sp_1', 'Draft'));
  store.marks.put({ id: 'mark_1', projectId: P, kind: 'Suspected stale', targetId: 'thr_tides', clueSourceIds: ['s'], clue: 'v1 table still cited', since: AT, noteId: null, closed: null, sixThing: null } as EntryMark);
  const round: ClerkRound = { id: 'crd_1', projectId: P, kind: 'Follow up', number: 3, startedAt: AT, endedAt: null, status: 'Running', rootJobId: 'job_root', questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: 'round_0001', updatedAt: AT, baseline: roundBaseline(store) };
  store.clerkRounds.put(round);
  for (const j of [job('job_root', null), job('job_syn', 'crd_1'), job('job_inv', null, 'job_syn'), job('job_owner', null)]) store.jobs.put(j);
  return { store, round };
}

test('a round’s news: what its jobs made new, against where things stood when it started, each with its position', () => {
  const { store, round } = setup();
  const by = (jobId: string) => ({ jobId, summary: 'test write' });
  store.breakpoints.put(bp('bp_new', 'thr_tides', true, 'crd_1'), by('job_syn'));          // newly lit
  store.breakpoints.put({ ...bp('bp_old', 'thr_moon', true, 'crd_0'), why: 'still open' }, by('job_syn'));   // lit before: not new
  store.sendbacks.put(sb('sb_new', 'thr_tides', 'Suggested'), by('job_syn'));             // new
  store.sendbacks.put(sb('sb_old', 'thr_moon', 'Returned'), by('job_syn'));               // moved
  store.marks.put({ ...store.marks.get('mark_1')!, sixThing: 1 }, by('job_syn'));          // newly one of the six things
  store.patches.put(patch('sp_1', 'Confirmed'), by('job_syn'));                           // confirmed
  store.notes.put(note('note_old', 'Moon phases lag', 2), by('job_inv'));                  // updated, by what the round delegated
  store.notes.put(note('note_new', 'Tides need the leap day', 1, 'For your decision'), by('job_syn'));   // written
  store.notes.put({ ...store.notes.get('note_tagged')!, sixThing: 3 }, by('job_syn'));      // tagged only: no update, but six things
  store.notes.put(note('note_owner', 'The owner’s own', 1), by('job_owner'));             // not the round's: not its news
  const news = roundNews(store, store.clerkRounds.get(round.id)!);
  assert.equal(news.complete, true);
  assert.deepEqual(news.breakpoints.map((b) => [b.id, b.label, b.position]), [['bp_new', 'Findings open on T-4 Tide tables', 'Process view · T-4 Tide tables']]);
  assert.deepEqual(news.sendbacks.map((s) => [s.id, s.detail]).sort(), [['sb_new', 'new · Suggested'], ['sb_old', 'Suggested → Returned']]);
  assert.deepEqual(news.sixThings.map((s) => s.label).sort(), ['1 stale · mark Suspected stale on T-4 Tide tables', '3 dropped along the way · note “Leap days”', '5 let pass · breakpoint Findings open on T-4 Tide tables'], 'the newly lit breakpoint is one of the six things too');
  assert.deepEqual(news.patches.map((p) => [p.label, p.position]), [['SP-1 Tides v1 withdrawn', 'Struck through on T-4 Tide tables']]);
  assert.deepEqual(news.notes.map((n) => [n.id, n.detail, n.position]).sort(), [['note_new', 'new', 'Notes (attention) · on T-4 Tide tables'], ['note_old', 'v2', 'Notes log · on T-4 Tide tables']]);
  assert.equal(news.nothingNew, false);
  assert.equal(news.statement, '1 breakpoint newly lit · 1 new send-back · 1 send-back moved · 3 newly among the six things · 1 semantic patch confirmed · 2 notes written or updated');

  // Closed into the Follow up record: one item in Notes (attention), each thing with its position.
  const record: FollowUpRound = { id: 'round_0001', projectId: P, number: 1, startedAt: AT, endedAt: '2026-09-20T11:00:00.000Z', mainJobId: 'job_root', result: null, seenAt: null };
  store.rounds.put({ ...record, result: roundResultOf(store, record.id, '# Result', record.endedAt!, news) });
  assert.deepEqual(store.rounds.get(record.id)!.result!.counts.news, { breakpoints: 1, sendbacksNew: 1, sendbacksMoved: 1, sixThings: 3, patches: 1, notes: 2 });
  const project = { id: P, name: 'Tern', scopeQuestions: [] } as unknown as Project;
  const item = overview(store, project, null, null).needsYou.find((i) => i.kind === 'round')!;
  assert.ok(item, 'one item for the round');
  assert.equal(item.label, `Follow up round 3: ${news.statement}`, 'named as the Keeper view names the round');
  assert.match(item.detail, /Breakpoints newly lit \(1\):\n- Findings open on T-4 Tide tables — Process view · T-4 Tide tables/);
  assert.match(item.detail, /Send-backs new or moved \(2\):/);
  assert.match(item.detail, /Semantic patches confirmed \(1\):\n- SP-1 Tides v1 withdrawn — Struck through on T-4 Tide tables/);
  assert.match(item.detail, /Notes written or updated \(2\):/);
  assert.ok(item.object.objects.some((o) => o.id === 'thr_tides'), 'the objects it hangs on, to find them on the graph');
  assert.ok(item.news, 'the news itself, for the interface to list');
});

test('a round with nothing new says so, and has no item in Notes (attention)', () => {
  const { store, round } = setup();
  store.breakpoints.put(bp('bp_old', 'thr_moon', true, 'crd_0'), { jobId: 'job_syn', summary: 'written again, still lit' });
  store.notes.put(note('note_owner', 'The owner’s own', 1), { jobId: 'job_owner', summary: 'the owner, meanwhile' });
  const news = roundNews(store, store.clerkRounds.get(round.id)!);
  assert.equal(news.nothingNew, true);
  assert.equal(news.statement, 'Follow up round 3 found nothing new');
  store.rounds.put({ id: 'round_0001', projectId: P, number: 1, startedAt: AT, endedAt: '2026-09-20T11:00:00.000Z', mainJobId: 'job_root', result: roundResultOf(store, 'round_0001', '# Result\n\nNothing new.', '2026-09-20T11:00:00.000Z', news), seenAt: null });
  const project = { id: P, name: 'Tern', scopeQuestions: [] } as unknown as Project;
  assert.ok(!overview(store, project, null, null).needsYou.some((i) => i.kind === 'round'), 'no item: the top bar says it instead');
  // Objects the round's judgements left behind are its news too (§5.5): then it is not "nothing new".
  const withBehind = roundNews(store, store.clerkRounds.get(round.id)!, 2);
  assert.equal(withBehind.nothingNew, false);
  assert.equal(withBehind.statement, '2 objects still on the old understanding');
});

test('a round begun before rounds kept a baseline counts what it can tell and says it is not complete', () => {
  const { store, round } = setup();
  store.clerkRounds.put({ ...store.clerkRounds.get(round.id)!, baseline: null });
  store.breakpoints.put(bp('bp_new', 'thr_tides', true, 'crd_1'), { jobId: 'job_syn', summary: 'lit' });
  store.breakpoints.put({ ...bp('bp_old', 'thr_moon', true, 'crd_0'), why: 'again' }, { jobId: 'job_syn', summary: 'again' });
  const news = roundNews(store, store.clerkRounds.get(round.id)!);
  assert.equal(news.complete, false);
  assert.deepEqual(news.breakpoints.map((b) => b.id), ['bp_new'], 'the one this round lit, by its round');
});
