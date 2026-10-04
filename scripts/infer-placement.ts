/**
 * CQ (D104) acceptance run: the placement inference over a store, without the server.
 *
 *   node scripts/infer-placement.ts --home <PROJECTKEEPER_HOME copy> --project <project id> [--write] [--ids AD,AF,E25-E101]
 *
 * Reads the store and its ledger, runs `inferThread` over every live work item in no plan or no module and `inferDecision`
 * over every decision or boundary placed nowhere, and prints one row per item: where the program would place it on a
 * single pass and through which chain, or what stays empty and the pointers tried. `--write` then runs `placeByProgram`
 * on that store (use a copy: it writes), prints the counts before and after, where each item of `--ids` ended up with the
 * chain the round record keeps, and every item still empty with the pointers tried. Never point it at the live store.
 */
import { ProjectStore } from '../src/store/project-store.ts';
import { Ledger } from '../src/ledger/index.ts';
import { expandRanges } from '../src/ledger/ranges.ts';
import { reachOf } from '../src/keeper/organize/placing.ts';
import { inferDecision, inferThread, inferenceContext, pick, placeByProgram, shortName, type Lead } from '../src/keeper/organize/placement-inference.ts';
import { plansOf } from '../src/process/placement.ts';

const arg = (name: string): string | null => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? null : null; };
const home = arg('home');
const projectId = arg('project');
if (!home || !projectId) { console.error('usage: node scripts/infer-placement.ts --home <home> --project <id> [--write] [--ids AB,D25-D101]'); process.exit(2); }
if (home.replace(/\\/g, '/').toLowerCase().includes('/.projectkeeper')) { console.error('refusing: this looks like the live store; run on a copy'); process.exit(2); }
const only = arg('ids') ? new Set(expandRanges(arg('ids')!).toUpperCase().split(/[^A-Z0-9#-]+/).filter(Boolean)) : null;

const store = ProjectStore.open(projectId, home);
const ledger = Ledger.openDir(store.dir);
const GONE = new Set(['Replaced', 'Removed']);
const cell = (s: string, n: number) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, n);
const leadText = (l: Lead | null, all: readonly Lead[]) => (l ? `**${l.name}** (${l.weight})` : all.length ? `tie: ${all.slice(0, 3).map((x) => `${x.name} (${x.weight})`).join(' / ')}` : '—');
const wanted = (ids: readonly string[], id: string) => !only || ids.some((i) => only.has(i.toUpperCase())) || only.has(id.toUpperCase());

function counts() {
  const reach = reachOf(store);
  const inGen = new Set(store.generations.all().flatMap((g) => g.workIds));
  const threads = store.threads.filter((t) => !GONE.has(t.validity));
  const noPlan = threads.filter((t) => !inGen.has(t.id) && plansOf(store, t).length === 0 && !t.noPlanWhy?.trim());
  const noArea = threads.filter((t) => reach.ofThread(t).areas.length === 0 && !t.wholePlanWhy?.trim() && !t.noAreaWhy?.trim());
  const decisions = store.reference.filter((r) => (r.category === 'Decision' || r.category === 'Boundary') && !GONE.has(r.validity));
  const onNothing = decisions.filter((d) => { const at = reach.ofReference(d.id); return !at.areas.length && !at.plans.length && !at.product; });
  const productOnly = decisions.filter((d) => { const at = reach.ofReference(d.id); return !at.areas.length && !at.plans.length && at.product && !d.wholeProductWhy?.trim(); });
  return { reach, noPlan, noArea, onNothing, productOnly };
}

const before = counts();
console.log(`# Placement inference on ${projectId} (${store.dir})\n`);
console.log(`Before: ${before.noPlan.length} work items in no plan, ${before.noArea.length} in no module, ${before.onNothing.length} decisions on nothing, ${before.productOnly.length} on the Product without a reason.\n`);

const ctx = inferenceContext(store, ledger);

console.log('## Single pass: work items in no plan or no module\n');
console.log('| item | plan lead | chain | module lead | pointers tried / empty |');
console.log('| --- | --- | --- | --- | --- |');
const openThreads = [...before.noPlan, ...before.noArea.filter((t) => !before.noPlan.includes(t))].sort((a, b) => (a.ids[0] ?? a.title).localeCompare(b.ids[0] ?? b.title, undefined, { numeric: true }));
for (const t of openThreads) {
  if (!wanted(t.ids, t.id)) continue;
  const inf = inferThread(ctx, t);
  const plan = pick(inf.plans);
  const area = pick(inf.areas);
  console.log(`| ${cell(`${t.ids[0] ?? ''} ${t.title}`, 60)} | ${leadText(plan, inf.plans)} | ${cell(plan ? plan.through.join('; ') : inf.plans[0]?.through.join('; ') ?? '', 220)} | ${leadText(area, inf.areas)} | ${cell(inf.tried.join('; '), 200)} |`);
}

console.log('\n## Single pass: decisions and boundaries placed nowhere\n');
console.log('| item | lead | chain | pointers tried / empty |');
console.log('| --- | --- | --- | --- |');
const groups = new Map<string, string[]>();
const openDecisions = [...before.onNothing, ...before.productOnly].sort((a, b) => (a.ids[0] ?? a.name).localeCompare(b.ids[0] ?? b.name, undefined, { numeric: true }));
for (const d of openDecisions) {
  if (!wanted(d.ids, d.id)) continue;
  const inf = inferDecision(ctx, d);
  const all = [...inf.plans, ...inf.areas].sort((a, b) => b.weight - a.weight);
  const tied = all.filter((l) => l.weight === all[0]?.weight);
  const target = tied.length === 1 || (tied.length === 2 && tied[0]!.category !== tied[1]!.category) ? tied : [];
  const key = target.length ? target.map((l) => l.name).join('+') : all.length ? 'tie' : 'empty';
  groups.set(key, [...(groups.get(key) ?? []), d.ids[0] ?? d.name.slice(0, 20)]);
  console.log(`| ${cell(`${d.ids[0] ?? ''} ${d.name}`, 70)} | ${target.length ? `**${target.map((l) => l.name).join(', ')}**` : all.length ? `tie: ${all.slice(0, 3).map((x) => `${x.name} (${x.weight})`).join(' / ')}` : '—'} | ${cell((target[0] ?? all[0])?.through.join('; ') ?? '', 220)} | ${cell(inf.tried.join('; '), 180)} |`);
}
console.log('\nBy outcome (single pass): ' + [...groups].map(([k, ids]) => `${k}: ${ids.length} (${ids.slice(0, 12).join(', ')}${ids.length > 12 ? ' …' : ''})`).join('; '));

if (process.argv.includes('--write')) {
  const round = store.clerkRounds.all().sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const roundId = round?.id ?? 'none';
  const result = placeByProgram(store, ledger, { id: roundId }, null, 'acceptance');
  const after = counts();
  const byTarget = new Map<string, number>();
  for (const p of result.placed) byTarget.set(p.target, (byTarget.get(p.target) ?? 0) + 1);
  console.log(`\n## placeByProgram (passes until nothing more places)\n\nPlaced ${result.placed.length}: ${[...byTarget].map(([t, n]) => `${n} → ${t}`).join(', ')}.`);
  console.log(`After: ${after.noPlan.length} work items in no plan (${after.noPlan.map((t) => t.ids[0] ?? t.title.slice(0, 20)).join(', ')}), ${after.noArea.length} in no module, ${after.onNothing.length} decisions on nothing (${after.onNothing.map((d) => d.ids[0]).join(', ')}), ${after.productOnly.length} on the Product without a reason.`);

  const records = store.clerkRounds.get(roundId)?.inferredPlacements ?? [];
  console.log('\n## Where each item ended up\n');
  console.log('| item | placed on | chain (the serves claim / the round record) |');
  console.log('| --- | --- | --- |');
  const final = (id: string, kind: 'thread' | 'reference') => {
    const recs = records.filter((p) => p.kind === kind && p.id === id);
    const places = kind === 'thread' ? (() => { const t = store.threads.get(id)!; const r = after.reach.ofThread(t); return [...r.plans, ...r.areas]; })() : (() => { const r = after.reach.ofReference(id); return [...r.plans, ...r.areas]; })();
    return { places: places.map((p) => shortName(store, p)), chain: recs.map((p) => `→ ${p.target}: ${p.chain}`).join(' | ') };
  };
  const groupsAfter = new Map<string, string[]>();
  for (const t of openThreads) {
    if (!wanted(t.ids, t.id)) continue;
    const f = final(t.id, 'thread');
    const key = f.places.length ? f.places.join('+') : 'empty';
    groupsAfter.set(key, [...(groupsAfter.get(key) ?? []), t.ids[0] ?? t.title.slice(0, 16)]);
    console.log(`| ${cell(`${t.ids[0] ?? ''} ${t.title}`, 60)} | ${f.places.length ? `**${f.places.join(', ')}**` : '—'} | ${cell(f.chain || result.empty.find((e) => e.id === t.id)?.tried.join('; ') || '', 260)} |`);
  }
  for (const d of openDecisions) {
    if (!wanted(d.ids, d.id)) continue;
    const f = final(d.id, 'reference');
    const key = f.places.length ? f.places.join('+') : 'empty';
    groupsAfter.set(key, [...(groupsAfter.get(key) ?? []), d.ids[0] ?? d.name.slice(0, 16)]);
    console.log(`| ${cell(`${d.ids[0] ?? ''} ${d.name}`, 60)} | ${f.places.length ? `**${f.places.join(', ')}**` : '—'} | ${cell(f.chain || result.empty.find((e) => e.id === d.id)?.tried.join('; ') || '', 260)} |`);
  }
  console.log('\nBy outcome (after the write): ' + [...groupsAfter].map(([k, ids]) => `${k}: ${ids.length} (${ids.join(', ')})`).join('; '));

  console.log(`\n## Still empty after the write (${result.empty.length})\n`);
  for (const e of result.empty) console.log(`- ${cell(e.name, 60)} — needs ${e.needs.join(' and ')}: ${e.leads.length ? `leads tied: ${e.leads.slice(0, 3).map((l) => `${l.name} (${l.weight})`).join(' / ')}; ` : ''}${cell(e.tried.join('; '), 260)}`);
  await store.flush();
}
ledger?.close();
