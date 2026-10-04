/**
 * DB (after the DeepSeek run of 2026-10-04) replay, on a copy of a store, without the server and without a model.
 *
 *   node scripts/db-replay.ts --home <PROJECTKEEPER_HOME copy> --project <project id> [--readiness [--title <column> --id <column> --status <column>]]
 *
 * 1. Unplaced, one definition: what the workbench draws as not placed (the graph view the store holds, through
 *    `ui/placement.js`) beside what the program now counts for the Keeper (`roundOpen`), with the items named.
 * 2. Slots: which slots the first usable round's lanes held, and which `pk_send_lanes` would list back.
 * 3. `--readiness`: the status mapping the round's fill of a contract table was given (read from the lane reports), which
 *    of its entries the fill now refuses, how many rows that leaves for the lane to judge, and what the execution records
 *    in the store say of each such row — the tickets that implement it, how many are Done, and their confirmed deliveries.
 *    With the table's column names (`--title`, `--id`, `--status`, as the lane named them) it then makes the recorded
 *    call again on the copy, to show the tool's own answer.
 * Use a copy: `--readiness` writes to the store. Never point it at the live store or at a snapshot.
 */
import { ProjectStore } from '../src/store/project-store.ts';
import { Workspace } from '../src/store/workspace.ts';
import type { ClerkRound } from '../src/model/k-types.ts';
import type { WorkThread } from '../src/model/types.ts';
import { linkHolds } from '../src/model/k-types.ts';
import { graphView } from '../src/server/graph-view.ts';
import { openCounts, roundOpen, unplacedNote } from '../src/keeper/organize/round-open.ts';
import { readinessWord } from '../src/keeper/organize/readiness.ts';
import { slotsUnheld, slotHolds, SKELETON_SLOTS } from '../src/keeper/organize/slots.ts';
import { fillTools } from '../src/keeper/organize/fill-tools.ts';
import type { ClerkToolContext } from '../src/keeper/clerk-tools.ts';
import { placementOf, unplacedOf } from '../ui/placement.js';

const arg = (name: string): string | null => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? null : null; };
const home = arg('home');
const projectId = arg('project');
if (!home || !projectId) { console.error('usage: node scripts/db-replay.ts --home <home copy> --project <id> [--readiness]'); process.exit(2); }
const where = home.replace(/\\/g, '/').toLowerCase();
if (where.includes('/.projectkeeper') || where.includes('/snapshots/')) { console.error('refusing: this looks like the live store or a snapshot; run on a copy'); process.exit(2); }

const project = Workspace.open(home).get(projectId);
if (!project) { console.error(`no project ${projectId} in ${home}`); process.exit(2); }
const store = ProjectStore.open(projectId, home);
const rounds = store.clerkRounds.all().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
const last = rounds[rounds.length - 1];
if (!last) { console.error('this store has no round'); process.exit(2); }
const row = (cells: (string | number)[]) => `| ${cells.map((c) => String(c).replace(/\|/g, '/').replace(/\s+/g, ' ')).join(' | ')} |`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

console.log(`# DB replay on ${projectId} (${store.dir})\n`);

// ── 1 · unplaced
const drawn = placementOf(graphView(store, project));
const drawnLists = unplacedOf(drawn);
const open = roundOpen(store, last, { limit: Infinity, suggest: false });
const counts = openCounts(open);
console.log('## 1 · Unplaced\n');
console.log(row(['', 'work in no plan', 'work in no module', 'decisions and boundaries on nothing', '… only on the Product', 'requirements', 'designs']));
console.log(row(['---', '---', '---', '---', '---', '---', '---']));
const kind = (ids: readonly string[], category: string) => ids.filter((id) => drawn.byId.get(id)?.category === category).length;
console.log(row(['the workbench (the stored graph view)', drawn.unplaced.workNoPlan, drawn.unplaced.workNoArea, kind(drawnLists.intentNowhere, 'Decision'), kind(drawnLists.intentProductOnly, 'Decision'), kind([...drawnLists.intentNowhere, ...drawnLists.intentProductOnly], 'Requirement'), kind([...drawnLists.intentNowhere, ...drawnLists.intentProductOnly], 'Design')]));
console.log(row(['the program (pk_round_state open)', counts.noPlan ?? 0, counts.noModule ?? 0, counts.onNothing ?? 0, counts.productOnly ?? 0, counts.requirementsUnplaced ?? 0, counts.designsUnplaced ?? 0]));
for (const i of open.workItems.noPlan.items) console.log(`- in no plan: ${i.name}${i.notCurrent?.length ? ` — serves only ${i.notCurrent.join('; ')}` : ''}`);
for (const i of open.requirements.unplaced.items) console.log(`- requirement on ${i.on}: ${clip(i.name, 70)}`);
for (const i of open.designs.unplaced.items) console.log(`- design on ${i.on}: ${clip(i.name, 70)}`);
const note = unplacedNote(open);
console.log(`\nThe handover note: ${note ? clip(note.replace(/\n/g, ' '), 700) : 'nothing unplaced'}\n`);

// ── 2 · slots
console.log('## 2 · Slots of the first usable round\n');
const first = rounds.find((r) => r.kind === 'First usable');
if (!first) console.log('No first usable round on record.\n');
else {
  const lanes = (first.lanes ?? []).filter((l) => l.stage === 'skeleton');
  const unheld = slotsUnheld(lanes.flatMap((l) => l.slots), first.emptySlots ?? []);
  console.log(`${lanes.length} skeleton lanes held ${new Set(lanes.flatMap((l) => l.slots)).size} slot kinds; of the ${SKELETON_SLOTS.length} slots the skeleton fills, ${unheld.length} ${unheld.length === 1 ? 'was' : 'were'} held by no lane${unheld.length ? ' — pk_send_lanes would list back:' : '.'}`);
  for (const u of unheld) console.log(`- ${u.slot} — ${u.holds} (the workbench holds ${slotHolds(store, u.slot) ? 'something there now' : 'nothing there'})`);
  console.log('');
}

// ── 3 · readiness
if (process.argv.includes('--readiness')) await readiness(last);

async function readiness(round: ClerkRound): Promise<void> {
  console.log('## 3 · A readiness word is not progress\n');
  // The mapping as the lane reported it: `statusMap = {ready→Planned, deferred→On hold, draft→Planned}`.
  const reports = store.roundDocs.filter((d) => d.kind === 'Report' || d.kind === 'Brief');
  const given = new Map<string, string>();
  let from = '';
  for (const d of reports) {
    const m = /statusMap\s*[=：:]\s*\{?([^}。\n]*)/.exec(d.markdown);
    if (!m) continue;
    for (const pair of m[1]!.split(/[,，、]/)) { const p = /^\s*([^→\s]+)\s*→\s*(Planned|In progress|Done|On hold)/.exec(pair); if (p) given.set(p[1]!, p[2]!); }
    if (given.size) { from = `${d.kind} “${d.path ?? d.title}”`; if (d.kind === 'Report') break; }
  }
  console.log(`The mapping given (${from || 'no report states one'}): ${[...given].map(([k, v]) => `${k}→${v}`).join(', ') || 'none'}.`);
  const refusedKeys = [...given.keys()].filter((k) => readinessWord(k));
  console.log(`Refused now: ${refusedKeys.map((k) => `${k}→${given.get(k)}`).join(', ') || 'none'}. Taken: ${[...given.keys()].filter((k) => !readinessWord(k)).map((k) => `${k}→${given.get(k)}`).join(', ') || 'none'}.\n`);

  // The rows of the table: the work items whose written status is on record, in the document's order.
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const rows = store.threads.filter((t) => Boolean(t.writtenStatus)).sort((a, b) => a.writtenStatus!.line - b.writtenStatus!.line);
  const mapped = rows.filter((t) => refusedKeys.some((k) => squash(k) === squash(t.writtenStatus!.text)));
  const opens = rows.filter((t) => readinessWord(t.writtenStatus!.text) && !mapped.includes(t));
  console.log(`${rows.length} rows carry a written status. The refused entries matched ${mapped.length} of them word for word: their progress is no longer set by the mapping and is left for the lane to judge. ${opens.length} more open with a readiness word the mapping never matched (${opens.map((t) => `${t.ids[0]}: “${clip(t.writtenStatus!.text, 30)}”`).join('; ') || 'none'}).\n`);

  // What the execution records in the store say of each: the tickets that implement it, and their confirmed deliveries.
  const relations = store.relations.all();
  const threadOfContract = (to: string): WorkThread | undefined => {
    const t = store.threads.get(to);
    if (t) return t;
    const r = store.reference.get(to);
    if (!r) return undefined;
    const n = r.ids.map((i) => i.toUpperCase());
    return store.threads.find((x) => x.ids.some((i) => n.includes(i.toUpperCase())));
  };
  const ticketsOf = new Map<string, WorkThread[]>();
  for (const r of relations.filter((x) => x.type === 'implements')) {
    const ticket = store.threads.get(r.from);
    const contract = threadOfContract(r.to);
    if (!ticket || !contract || ticket.id === contract.id) continue;
    ticketsOf.set(contract.id, [...new Set([...(ticketsOf.get(contract.id) ?? []), ticket])]);
  }
  const DELIVERY = new Set(['Delivered', 'Merged']);
  const CHECK = new Set(['QC', 'Review', 'Walkthrough']);
  console.log(row(['row', 'written status', 'progress in the store', 'tickets implementing it', 'of them Done', 'tickets with a delivery or merge that holds', 'with a check that holds', 'the reason written']));
  console.log(row(['---', '---', '---', '---', '---', '---', '---', '---']));
  let withAllDone = 0, withSomeDone = 0, withNone = 0;
  for (const t of [...mapped, ...opens]) {
    const tickets = ticketsOf.get(t.id) ?? [];
    const done = tickets.filter((x) => x.progress === 'Done');
    const linked = (steps: ReadonlySet<string>) => tickets.filter((x) => store.links.find((l) => l.workId === x.id && steps.has(l.stepKind) && linkHolds(l)) !== undefined).length;
    if (!tickets.length) withNone++; else if (done.length === tickets.length) withAllDone++; else if (done.length) withSomeDone++;
    console.log(row([`${t.ids[0] ?? t.id} ${clip(t.title, 28)}`, clip(t.writtenStatus!.text, 24), t.progress, tickets.length, done.length, linked(DELIVERY), linked(CHECK), clip(t.progressWhy ?? '—', 90)]));
  }
  const all = [...mapped, ...opens];
  console.log(`\nOf these ${all.length} rows: ${all.filter((t) => (ticketsOf.get(t.id) ?? []).some((x) => x.progress === 'Done')).length} have at least one Done ticket implementing them (${withAllDone} with every ticket Done, ${withSomeDone} with some), ${all.length - withNone - withAllDone - withSomeDone} have tickets and none Done, ${withNone} have no ticket. In the store they stand: ${['Done', 'In progress', 'Planned', 'On hold'].map((p) => `${all.filter((t) => t.progress === p).length} ${p}`).join(', ')}.\n`);

  // The recorded call, made again on the copy: the tool's own answer.
  const columns = { title: arg('title'), id: arg('id'), status: arg('status') };
  if (!columns.title || !columns.status) { console.log('Give --title, --id and --status (the table’s column names) to make the recorded call again on the copy.'); return; }
  const source = store.sources.get(rows[0]?.writtenStatus?.sourceId ?? '');
  if (!source || source.anchor.kind !== 'file') { console.log('The table’s document is not on record as a file source; the call is not made again.'); return; }
  const scope = project!.scope.find((s) => source.anchor.kind === 'file' && source.anchor.path.toLowerCase().startsWith(s.path.toLowerCase()));
  const rel = scope ? source.anchor.path.slice(scope.path.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') : source.anchor.path;
  const at = new Date().toISOString();
  store.clerkRounds.put({ ...round, id: 'crd_db_replay', number: round.number + 1, kind: 'First usable', status: 'Running', endedAt: null, stage: 'reconcile', handover: null, lanes: [], startedAt: at, updatedAt: at });
  const ctx = { store, project: project!, jobId: 'job_db_replay', jobKind: 'Organizing', model: null, step: { roundId: 'crd_db_replay', kind: 'main', path: null } } as unknown as ClerkToolContext;
  const tool = fillTools(ctx).find((x) => x.name === 'pk_fill_from_table')!;
  const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  const before = new Map(rows.map((t) => [t.id, t.progress]));
  const result = await run('replay', { path: rel, table: { line: rows[0]!.writtenStatus!.line }, into: 'threads', category: 'Requirement', columns: { title: columns.title, ...(columns.id ? { id: columns.id } : {}), status: columns.status }, statusMap: Object.fromEntries(given) });
  const text = result.content.map((c) => c.text).join('\n');
  if (result.isError) { console.log(`The call made again on the copy (${rel}) came back refused: ${clip(text, 500)}`); return; }
  const json = JSON.parse(text) as { written: number; updated: number; skipped: unknown[]; refused?: { statusMap: string; why: string }[]; progressToJudge?: { rows: number; statuses: Record<string, number>; note: string } };
  console.log(`The call made again on the copy (${rel}, the same statusMap): written ${json.written}, updated ${json.updated}, skipped ${json.skipped.length}.`);
  for (const r of json.refused ?? []) console.log(`- refused ${r.statusMap}: ${clip(r.why, 260)}`);
  if (json.progressToJudge) console.log(`- progressToJudge: ${json.progressToJudge.rows} rows (${Object.entries(json.progressToJudge.statuses).map(([k, v]) => `${k} ${v}`).join(', ')}). ${clip(json.progressToJudge.note, 200)}`);
  const changed = rows.filter((t) => store.threads.get(t.id)?.progress !== before.get(t.id));
  console.log(`- progress changed by the call: ${changed.length ? changed.map((t) => `${t.ids[0]} ${before.get(t.id)} → ${store.threads.get(t.id)?.progress}`).join(', ') : 'none (the judgements written since stand)'}.`);
}
