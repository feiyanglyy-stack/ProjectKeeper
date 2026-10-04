/**
 * CS (D104, after the CQ run) replay: what a new round is shown of the program's placements, and what its spot-check is
 * given of the placement readings, on a copy of a store. Without the server.
 *
 *   node scripts/placement-review.ts --home <PROJECTKEEPER_HOME copy> --project <project id>
 *
 * It registers a new round on the copy (a Follow up after the last one, in its cross-check, with a main job), asks
 * `pk_round_state({ list: "inferredPlacements" })` and `pk_round_state({})` as that round's main agent, and computes the
 * spot-check's targets for it (`spotCheckTargets`). It prints the placements listed with the round and stage that placed
 * each and its chain, the counts, the reasons checked in full by kind, and the program placements in the sample. It also
 * prints what the last recorded round's spot-check would be given, where that round's own writes compete for the sample.
 * Use a copy: it writes the new round and the program's upkeep. Never point it at the live store or at a snapshot.
 */
import { ProjectStore } from '../src/store/project-store.ts';
import { Workspace } from '../src/store/workspace.ts';
import { Ledger } from '../src/ledger/index.ts';
import type { ClerkRound } from '../src/model/k-types.ts';
import type { KeeperJob } from '../src/model/types.ts';
import type { ToolContext } from '../src/keeper/tools.ts';
import { stageTools } from '../src/keeper/organize/stage-tools.ts';
import { programPlacementsLine, roundOpen } from '../src/keeper/organize/round-open.ts';
import { PLACEMENT_SAMPLE_FLOOR, SPOT_CHECK_SAMPLE, spotCheckTargets, standingReasons, type SpotCheckTargets } from '../src/process/breakpoint-candidates.ts';

const arg = (name: string): string | null => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? null : null; };
const home = arg('home');
const projectId = arg('project');
if (!home || !projectId) { console.error('usage: node scripts/placement-review.ts --home <home copy> --project <id>'); process.exit(2); }
const where = home.replace(/\\/g, '/').toLowerCase();
if (where.includes('/.projectkeeper') || where.includes('/snapshots/')) { console.error('refusing: this looks like the live store or a snapshot; run on a copy'); process.exit(2); }

const project = Workspace.open(home).get(projectId);
if (!project) { console.error(`no project ${projectId} in ${home}`); process.exit(2); }
const store = ProjectStore.open(projectId, home);
const ledger = Ledger.openDir(store.dir);
const cell = (s: string, n: number) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, n);

const rounds = store.clerkRounds.all().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
const last = rounds[rounds.length - 1];
if (!last) { console.error('this store has no round'); process.exit(2); }
console.log(`# Placement review on ${projectId} (${store.dir})\n`);
console.log(`Rounds on record: ${rounds.map((r) => `${r.kind} round ${r.number} (${r.status}; the program placed ${(r.inferredPlacements ?? []).length}; spot-check ${r.spotCheck ? `${r.spotCheck.sampled} checked` : 'none'})`).join('; ')}.\n`);

// What the last recorded round's spot-check would be given, before anything is written.
const replayed = spotCheckTargets(store, last, SPOT_CHECK_SAMPLE, ledger);

// A new round, in its cross-check, with its main job.
const at = new Date().toISOString();
const round: ClerkRound = {
  id: 'crd_cs_replay', projectId, kind: 'Follow up', number: last.number + 1, startedAt: at, endedAt: null, status: 'Running', rootJobId: 'job_cs_replay_root',
  questionsDocId: null, paths: [], outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: null, followUpRoundId: null, updatedAt: at,
  stage: 'cross-check', stageLog: [{ stage: 'cross-check', startedAt: at, endedAt: null, timing: null }], lanes: [],
};
store.clerkRounds.put(round);
const step = { roundId: round.id, kind: 'main', path: null };
store.jobs.put({ id: 'job_cs_replay_main', projectId, kind: 'Organizing', initiator: 'auto', scope: { kind: 'clerk-step', ids: [round.id], label: 'main' }, status: 'Running', queuedAt: at, startedAt: at, endedAt: null, savedResults: [], usage: {}, agent: 'pi', model: null, sessionFile: null, sessionId: null, steps: [], error: null, requestBasis: null, parentJobId: round.rootJobId, resultText: null, priority: 1, task: null, step } as unknown as KeeperJob);
const ctx = { store, project, jobId: 'job_cs_replay_main', jobKind: 'Organizing', model: null, step, stageEntered: () => ({ note: null }) } as unknown as ToolContext;
const tool = stageTools(ctx).find((t) => t.name === 'pk_round_state')!;
const ask = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const r = await (tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[] }>)('call', args);
  return JSON.parse(r.content.map((c) => c.text).join('\n')) as Record<string, unknown>;
};

const state = await ask({});
const listed = await ask({ list: 'inferredPlacements' });
const rows = listed.items as { id: string; name: string; placedOn: string; chain: string; round: string; stage: string; result: string }[];
console.log(`## pk_round_state({ list: "inferredPlacements" }) as the main agent of ${round.kind} round ${round.number}\n`);
console.log(`count: ${listed.count}; open.inferredPlacements: ${(state.open as Record<string, number>).inferredPlacements}; programPlacements: ${JSON.stringify(state.programPlacements)}\n`);
console.log('| item | placed on | placed in | result | chain |');
console.log('| --- | --- | --- | --- | --- |');
for (const r of rows) console.log(`| ${cell(r.name, 48)} | ${r.placedOn} | ${r.round}, entering ${r.stage} | ${r.result} | ${cell(r.chain, 400)} |`);
console.log(`\nThe handover note's clause (and, through the synthesis' task, the Result's): ${programPlacementsLine(roundOpen(store, store.clerkRounds.get(round.id)!, { ledger, suggest: false }).programPlacements) || '(none)'}\n`);

const say = (title: string, t: SpotCheckTargets) => {
  const byField = new Map<string, number>();
  for (const r of t.reasons) byField.set(r.field, (byField.get(r.field) ?? 0) + 1);
  const placed = t.sample.filter((s) => /placed by the program \(Inferred\)/.test(s.summary));
  console.log(`## ${title}\n`);
  console.log(`Checked in full: ${t.full.length} targets, of them ${t.reasons.length} standing reasons no spot-check has checked (${[...byField].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}).`);
  console.log(`The sample: ${t.sample.length} of ${t.written} other judgements; the program's unreviewed placements: ${t.placementsUnreviewed}, in the sample: ${t.placements.length} (floor ${PLACEMENT_SAMPLE_FLOOR}).\n`);
  for (const s of placed) console.log(`- ${s.collection} ${s.id}: ${cell(s.summary, 260)}`);
  console.log('');
};
say(`The spot-check's targets for ${round.kind} round ${round.number} (a new round: it wrote nothing of its own yet)`, spotCheckTargets(store, round, SPOT_CHECK_SAMPLE, ledger));
say(`What the spot-check of ${last.kind} round ${last.number} would be given (that round's own writes compete for the sample)`, replayed);

const standing = standingReasons(store);
const byCategory = new Map<string, number>();
for (const r of standing.filter((x) => x.field === 'wholeProductWhy')) { const c = store.reference.get(r.id)?.category ?? '?'; byCategory.set(c, (byCategory.get(c) ?? 0) + 1); }
const written = store.reference.filter((r) => Boolean(r.wholeProductWhy?.trim()));
console.log(`Standing reasons in the store: ${standing.length} (${['noPlanWhy', 'noAreaWhy', 'wholeProductWhy'].map((f) => `${f} ${standing.filter((r) => r.field === f).length}`).join(', ')}); the wholeProductWhy by category: ${[...byCategory].map(([c, n]) => `${c} ${n}`).join(', ') || 'none'}. Items carrying a wholeProductWhy in all: ${written.length}; not standing, because the item is also on an Area or a Plan: ${written.length - standing.filter((r) => r.field === 'wholeProductWhy').length}.`);
await store.flush();
ledger?.close();
