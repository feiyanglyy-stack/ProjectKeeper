/**
 * DA (after the flash run, E156) replay: what the coverage check of a recorded deepening would say its groups hold, what
 * the new `pk_account_material` does with the accounts that round's main agent gave, and which Owner's words items carry a
 * quote too short to stand alone. On a copy of a store, without the server.
 *
 *   node scripts/coverage-holds-replay.ts --home <PROJECTKEEPER_HOME copy> --project <project id> [--accounts]
 *
 * The group table lists every group as the main agent first saw it (its own accounts taken away, the program's kept), with
 * the three counts and examples. `--accounts` puts the round back into its coverage stage on the copy and gives the
 * recorded accounts again, in their order, through the tool: accepted, or refused with what the group holds.
 * Use a copy: `--accounts` writes to the round. Never point it at the live store or at a snapshot.
 */
import { ProjectStore } from '../src/store/project-store.ts';
import { Workspace } from '../src/store/workspace.ts';
import { Ledger } from '../src/ledger/index.ts';
import type { ToolContext } from '../src/keeper/tools.ts';
import { coverageGroups, coverageOf, coverageTools, groupHoldsOf, holdsLine, materialHolds } from '../src/keeper/organize/coverage-tools.ts';
import { fold, standsAlone, uncitedOwnerLines } from '../src/keeper/organize/owner-lines.ts';

const arg = (name: string): string | null => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? null : null; };
const home = arg('home');
const projectId = arg('project');
const replayAccounts = process.argv.includes('--accounts');
if (!home || !projectId) { console.error('usage: node scripts/coverage-holds-replay.ts --home <home copy> --project <id> [--accounts]'); process.exit(2); }
const where = home.replace(/\\/g, '/').toLowerCase();
if (where.includes('/.projectkeeper') || where.includes('/snapshots/')) { console.error('refusing: this looks like the live store or a snapshot; run on a copy'); process.exit(2); }

const project = Workspace.open(home).get(projectId);
if (!project) { console.error(`no project ${projectId} in ${home}`); process.exit(2); }
const store = ProjectStore.open(projectId, home);
const ledger = Ledger.openDir(store.dir);
if (!ledger) { console.error('this store has no ledger'); process.exit(2); }
const round = store.clerkRounds.all().filter((r) => r.coverage).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
if (!round) { console.error('this store has no round with a coverage check'); process.exit(2); }
const row = (cells: (string | number)[]) => `| ${cells.map((c) => String(c).replace(/\|/g, '/')).join(' | ')} |`;

// ── 1 · the group table
const state = coverageOf(store, { ...round, coverage: { ...round.coverage!, accounted: [] } }, ledger, project);
const holds = materialHolds(store, ledger, state.open);
const byGroup = groupHoldsOf(state, holds);
const lines = uncitedOwnerLines(store, ledger);
console.log(`# Coverage holds on ${projectId} (${store.dir}) — ${round.kind} round ${round.number}\n`);
console.log(`Planned ${state.items.size}, listed ${state.open.length} in ${coverageGroups(state).length} groups, ${state.cited.size} cited by the program. Owner's lines: ${lines.cited.length} cited, ${lines.judged.length} judged to need nothing, ${lines.lines.length} not looked at yet, of ${lines.considered}.\n`);
console.log(row(['group', 'materials', 'read', 'verdict lines', 'numbers', "owner's lines", 'materials holding', 'examples']));
console.log(row(['---', '---', '---', '---', '---', '---', '---', '---']));
for (const g of coverageGroups(state, null)) {
  const h = byGroup.get(g.group);
  const examples = h ? [...(h.verdictLines?.examples ?? []), ...(h.numbers?.examples ?? []), ...(h.ownerQuotes?.examples ?? [])].slice(0, 3).map((e) => e.slice(0, 110)).join(' · ') : '';
  console.log(row([g.group, g.count, g.read, h?.verdictLines?.count ?? 0, h?.numbers?.count ?? 0, h?.ownerQuotes?.count ?? 0, h?.materials.length ?? 0, examples]));
}
console.log('\nEvery material that holds something:');
for (const [key, h] of holds) {
  console.log(`- ${key}: ${holdsLine(h)}`);
  for (const q of h.ownerQuotes) console.log(`  - ${q}`);
}

// ── 2 · the Owner's words items with a quote too short to stand alone
const words = store.reference.filter((r) => r.category === "Owner's words");
const short = words.filter((r) => !standsAlone(r.quote ?? ''));
console.log(`\n## Owner's words items: ${words.length}; quote too short to stand alone: ${short.length}; of those with what they answer: ${short.filter((r) => r.answers).length}\n`);
for (const r of short) console.log(`- 「${r.quote}」 (${fold(r.quote ?? '').length} letters) · ${r.name}`);

// ── 3 · the round's own accounts, given again
if (replayAccounts) {
  const given = (round.coverage?.accounted ?? []).filter((a) => a.by === 'main');
  store.clerkRounds.put({ ...round, stage: 'coverage', handover: null, coverage: { ...round.coverage!, accounted: [] } });
  const ctx: ToolContext = { store, project, jobId: 'job_replay', jobKind: 'Organizing', model: null, step: { roundId: round.id, kind: 'main', path: null } };
  const tool = coverageTools(ctx).find((t) => t.name === 'pk_account_material')!;
  const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  console.log(`\n## The round's ${given.length} accounts of the main agent, given again in their order\n`);
  console.log(row(['#', 'as given', 'outcome', 'materials then', 'now', 'what it holds / what changed']));
  console.log(row(['---', '---', '---', '---', '---', '---']));
  let n = 0;
  for (const a of given) {
    n++;
    const result = await run('replay', a.group ? { group: a.group, outcome: a.outcome, why: a.why } : { keys: a.keys, outcome: a.outcome, why: a.why });
    const text = result.content.map((x) => x.text).join('\n');
    const then = a.keys?.length ?? 0;
    if (result.isError) { console.log(row([n, a.group ?? `${then} keys`, a.outcome, then, 'refused', text.replace(/^ERROR: /, '').split('\nSend a follow-up')[0]!.replace(/\n/g, ' ⏎ ').slice(0, 900)])); continue; }
    const accounted = (JSON.parse(text) as { accounted: number }).accounted;
    console.log(row([n, a.group ?? `${then} keys`, a.outcome, then, `accepted (${accounted})`, accounted === then ? '' : `${then - accounted} read in part, no longer taken with the unread group: still listed`]));
  }
  const after = coverageOf(store, store.clerkRounds.get(round.id)!, ledger, project);
  console.log(`\nAfter the replay ${after.open.length} materials are still listed in ${coverageGroups(after).length} groups: ${coverageGroups(after).map((g) => `${g.group} (${g.count})`).join(', ') || 'none'}.`);
}
ledger.close();
