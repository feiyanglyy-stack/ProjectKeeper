#!/usr/bin/env node
/**
 * pk — ProjectKeeper command line. The same command is also installed under its long name, `projectkeeper`.
 *
 *   pk serve [--port N]                 start the workbench at http://127.0.0.1:N
 *   pk add <name> <location> [...]      add a project (nothing runs until Start on its Takeover page)
 *   pk scope <projectId>                print the scope list
 *   pk projects                         list projects
 *
 * An execution agent's own entry (Spec §7.10), all talking to the running workbench:
 *   pk context [--work <id|name>] [--purpose Start|Work] [--kind K] [--recipient R] [--since T]
 *   pk get <id>                         whatever an id in a pack names: a pack, an original (a code file: where it is
 *                                       and the version read), a note, a project rule, or the object itself in full
 *                                       with its neighbours named by id
 *   pk options                          areas, work items, lit breakpoints, open send-backs, six things and context choices
 *   pk ask "<question>"                 ask the Keeper
 *   pk help                             how to use these
 * The project is --project <id>, or the one containing --cwd <dir> (default: the current directory).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { App } from './server/app.ts';
import { HttpApp } from './server/http.ts';
import { registerRoutes } from './server/api.ts';
import { vendorDir } from './server/vendor.ts';
import { changeBrief, factBrief, nodeBrief, relationBrief } from './context/object-brief.ts';
import type { BriefChange, BriefFact, BriefNode } from './context/object-brief.ts';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

function arg(flag: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'serve';
  const app = new App(arg('--home') ?? undefined);
  const VALUE_FLAGS = ['--home', '--port', '--project', '--cwd', '--thread', '--fetch', '--work', '--purpose', '--kind', '--recipient', '--since'];
  const positionals = () => process.argv.slice(3).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(all[i - 1]!)));
  if (command === 'serve') {
    const http = new HttpApp();
    registerRoutes(http, app, join(appRoot, 'ui'), vendorDir(appRoot));
    http.route('GET', '/api/events', ({ res }) => { http.sse.attach(res); });
    app.on('event', (event) => http.sse.broadcast('app', event));
    const port = Number(arg('--port', String(app.workspace.settings.port)));
    app.servedPort = port;
    await app.initKeeper({ fakeProvider: process.argv.includes('--fake-provider') });
    if (app.workspace.settings.watchProjects === false) console.log('Not watching the projects (settings.watchProjects is false): this home works through what it already holds.');
    // A project the owner has not started is not watched: before `Start` nothing counts as waiting (D105).
    else for (const p of app.workspace.list()) { try { if (p.lastScopedAt) app.startWatching(p.id); } catch (e) { console.warn(`[watch] ${p.id}: ${(e as Error).message}`); } }
    const server = await http.listen(port);
    console.log(`ProjectKeeper workbench: http://127.0.0.1:${server.port}/`);
    const stop = async () => { app.stopAll(); await app.flushAll(); await server.close(); process.exit(0); };
    process.on('SIGINT', () => { void stop(); });
    process.on('SIGTERM', () => { void stop(); });
    return new Promise(() => { /* keep running */ });
  }
  if (command === 'add') {
    const [name, ...locations] = positionals();
    if (!name || locations.length === 0) { console.error('usage: pk add <name> <location> [...]'); return 2; }
    const project = app.addProject(name, locations);
    await app.flushAll();
    console.log(JSON.stringify({ id: project.id, name: project.name, state: 'Not organized yet', next: 'Open the workbench: Keeper → Takeover → choose a depth → Start' }, null, 2));
    return 0;
  }
  if (command === 'intake') {
    const id = positionals()[0];
    if (!id) { console.error('usage: pk intake <projectId>'); return 2; }
    const result = await app.intakeProject(id);
    await app.flushAll();
    console.log(JSON.stringify(result, null, 2));
    app.stopAll();
    return 0;
  }
  if (command === 'scope') {
    const id = positionals()[0];
    if (!id) { console.error('usage: pk scope <projectId>'); return 2; }
    const project = app.project(id);
    for (const item of project.scope) {
      console.log(`${item.category.padEnd(14)} ${item.relation.padEnd(24)} ${item.path}\n${' '.repeat(39)}${item.reason}`);
    }
    if (project.scopeQuestions.length) console.log('\nQuestions:\n' + project.scopeQuestions.map((q) => `- ${q.question}${q.answer ? ` → ${q.answer.text}` : ''}`).join('\n'));
    return 0;
  }
  if (command === 'ask') {
    // Query entry without any host integration (§7.6): talks to the running workbench.
    const base = `http://127.0.0.1:${arg('--port', String(app.workspace.settings.port))}`;
    const call = async (path: string, init?: RequestInit) => {
      let res: Response;
      try { res = await fetch(`${base}${path}`, { headers: { 'Content-Type': 'application/json' }, ...init }); }
      catch { console.error(`ProjectKeeper is not running at ${base}. Start it with \`pk serve\`.`); throw new Exit(3); }
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) { console.error(String(data.error ?? res.statusText)); throw new Exit(1); }
      return data;
    };
    const fetchId = arg('--fetch');
    const portFlag = arg('--port') ? ` --port ${arg('--port')}` : '';
    let projectId = arg('--project');
    if (!projectId) {
      const r = await call(`/api/resolve?cwd=${encodeURIComponent(arg('--cwd') ?? process.cwd())}`) as { projectId: string | null; message?: string };
      if (!r.projectId) { console.log(r.message); return 4; }
      projectId = r.projectId;
    }
    if (fetchId) {
      const r = await call(`/api/projects/${encodeURIComponent(projectId)}/ask/${encodeURIComponent(fetchId)}`) as { status: string; answer: string | null; error: string | null; steps: number; startedAt?: string | null; sources: { id: string; title: string; label: string }[] };
      if (r.status === 'Done') { console.log(r.answer ?? ''); if (r.sources.length) console.log(`\nSources:\n${r.sources.map((s) => `- ${s.id} ${s.title} — ${s.label}`).join('\n')}`); }
      else {
        // What the investigation is doing, so waiting is not blind (trial: "no progress or ETA").
        const running = r.status === 'Running' && r.startedAt ? ` for ${Math.max(1, Math.round((Date.now() - Date.parse(r.startedAt)) / 60000))} min, ${r.steps} step${r.steps === 1 ? '' : 's'} so far` : '';
        console.log(`${r.status}${running}${r.error ? `: ${r.error}` : ''}. Fetch again later: pk ask --project ${projectId}${portFlag} --fetch ${fetchId}`);
      }
      return 0;
    }
    const positional = process.argv.slice(3).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1]!.startsWith('--') && ['--project', '--cwd', '--thread', '--port', '--home', '--fetch'].includes(all[i - 1]!)));
    const question = positional.join(' ').trim();
    if (!question) { console.error('usage: pk ask [--project <id> | --cwd <dir>] [--thread <id>] [--wait] "<question>"'); return 2; }
    const r = await call(`/api/projects/${encodeURIComponent(projectId)}/ask`, { method: 'POST', body: JSON.stringify({ question, thread: arg('--thread') }) }) as { known: string; investigation: { jobId: string; thread: string; status: string } };
    if (r.known) console.log(`Known now (from the organized assets):\n${r.known}\n`); else console.log('Nothing organized answers this yet.\n');
    console.log(`Investigation ${r.investigation.jobId} (${r.investigation.status}) in thread ${r.investigation.thread}.`);
    if (!process.argv.includes('--wait')) { console.log(`Fetch the answer later: pk ask --project ${projectId}${portFlag} --fetch ${r.investigation.jobId}\nKeep asking in the same thread: pk ask --project ${projectId}${portFlag} --thread ${r.investigation.thread} "<question>"`); return 0; }
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const s = await call(`/api/projects/${encodeURIComponent(projectId)}/ask/${encodeURIComponent(r.investigation.jobId)}`) as { status: string; answer: string | null; error: string | null; sources: { id: string; title: string; label: string }[] };
      if (['Done', 'Failed', 'Stopped'].includes(s.status)) { console.log(`\n${s.answer ?? s.error ?? s.status}`); if (s.sources.length) console.log(`\nSources:\n${s.sources.map((x) => `- ${x.id} ${x.title} — ${x.label}`).join('\n')}`); return s.status === 'Done' ? 0 : 1; }
      if (s.status === 'Waiting for quota') { console.log(`Waiting for quota; fetch later: pk ask --project ${projectId}${portFlag} --fetch ${r.investigation.jobId}`); return 0; }
    }
  }
  if (['context', 'get', 'options', 'help'].includes(command)) return agentEntry(command, app, positionals());
  if (command === 'projects') {
    for (const p of app.workspace.list()) console.log(`${p.id}\t${p.name}\t${p.locations.join(', ')}`);
    return 0;
  }
  console.error(`unknown command: ${command}`);
  return 2;
}

/**
 * The execution agent's own entry (Spec §7.10; CKC-12 AC-20–AC-23, AC-26, AC-27, AC-29): the same choices, the same
 * content and the same originals as the workbench, read from the running workbench so both come from the same code.
 * Reading needs the workbench, not the Keeper; only `pk ask` needs the Keeper.
 */
async function agentEntry(command: string, app: App, args: string[]): Promise<number> {
  const base = `http://127.0.0.1:${arg('--port', String(app.workspace.settings.port))}`;
  const call = async <T,>(path: string): Promise<T> => {
    let res: Response;
    try { res = await fetch(`${base}${path}`); }
    catch { console.error(`ProjectKeeper is not running at ${base}. Start it with \`pk serve\` (packs, originals and options are read from the saved assets; the Keeper itself does not need to be running).`); throw new Exit(3); }
    const data = await res.json() as T & { error?: string };
    if (!res.ok) { console.error(String(data.error ?? res.statusText)); throw new Exit(1); }
    return data;
  };
  let projectId = arg('--project');
  if (!projectId) {
    const r = await call<{ projectId: string | null; message?: string }>(`/api/resolve?cwd=${encodeURIComponent(arg('--cwd') ?? process.cwd())}`);
    if (!r.projectId) { console.log(`${r.message} Give --project <id>; \`pk projects\` lists them.`); return 4; }
    projectId = r.projectId;
  }
  const P = encodeURIComponent(projectId);
  if (command === 'help') {
    const r = await call<{ lines: string[] }>(`/api/projects/${P}/usage`);
    console.log(`ProjectKeeper for execution agents · project ${projectId}\n\n${r.lines.map((l) => `- ${l}`).join('\n')}`);
    return 0;
  }
  if (command === 'options') {
    type Difference = { name: string; difference: string };
    const o = await call<{ forWork: { kind: string; id: string; label: string; progress?: string }[]; purposes: string[]; kinds: string[]; recipients: string[]; roles: string[]; kindDifferences: Difference[]; recipientDifferences: Difference[] }>(`/api/projects/${P}/context/options`);
    const k = await call<{
      breakpoints: { id: string; kind: string; targetId: string; targetName: string }[];
      sendBacks: { id: string; stage: string; to: string; what: string; targetId: string; targetName: string }[];
      sixThings: { thing: number; objects: { id: string; name: string }[] }[];
    }>(`/api/projects/${P}/k-options`);
    const byKind = (k: string) => o.forWork.filter((x) => x.kind === k);
    console.log(`Areas:\n${byKind('area').map((x) => `- ${x.id}  ${x.label}`).join('\n') || '- none'}`);
    console.log(`\nWork items:\n${byKind('work').map((x) => `- ${x.id}  ${x.label}${x.progress ? ` · ${x.progress}` : ''}`).join('\n') || '- none'}`);
    console.log(`\nRoles recognised: ${o.roles.length ? o.roles.join(', ') : 'none (that is not a gap)'}`);
    console.log(`Purposes: ${o.purposes.join(', ')}`);
    // Each kind and recipient says how its pack differs from the default one on this project, measured by assembling
    // both and comparing them, so nobody has to fetch all nine to find out (Spec §7.10; CKC-12 AC-21).
    const differences = (title: string, list: Difference[]) => console.log(`\n${title} (against the default pack: --purpose Start --kind Implement --recipient "Incoming agent", whole project):\n${list.map((x) => `- ${x.name} — ${x.difference}`).join('\n')}`);
    differences('Kinds', o.kindDifferences);
    differences('Recipients', o.recipientDifferences);
    console.log(`\nLit breakpoints:\n${k.breakpoints.map((b) => `- ${b.id} · ${b.kind} · on ${b.targetName} (${b.targetId})`).join('\n') || '- none'}`);
    console.log(`\nOpen send-backs:\n${k.sendBacks.map((s) => `- ${s.id} · ${s.stage} · to ${s.to} · ${s.what} · on ${s.targetName} (${s.targetId})`).join('\n') || '- none'}`);
    const sixNames: Record<number, string> = { 1: 'stale', 2: 'drift', 3: 'dropped along the way', 4: 'grown by itself', 5: 'let pass', 6: 'looks residual' };
    console.log(`\nSix things:\n${k.sixThings.map((s) => `${s.thing} ${sixNames[s.thing] ?? ''}:\n${s.objects.map((x) => `- ${x.id}  ${x.name}`).join('\n') || '- none'}`).join('\n')}`);
    return 0;
  }
  const pack = async (scope: { kind: string; id: string } | null, purposeDefault: 'Start' | 'Work') => {
    const q = new URLSearchParams({ scope: scope?.kind ?? 'project', purpose: arg('--purpose') ?? purposeDefault, kind: arg('--kind') ?? 'Implement', recipient: arg('--recipient') ?? 'Incoming agent' });
    if (scope) q.set('ids', scope.id);
    const since = arg('--since');
    if (since) q.set('since', since);
    const r = await call<{ markdown: string }>(`/api/projects/${P}/context?${q}`);
    console.log(r.markdown);
    return 0;
  };
  if (command === 'context') {
    const work = arg('--work');
    if (!work) return pack(null, 'Start');
    const found = await call<{ id?: string; kind: string | null }>(`/api/projects/${P}/lookup/${encodeURIComponent(work)}`).catch(() => ({ id: work, kind: null }));
    // A merged work item's id comes back as the id of the one kept (Spec §1.4).
    if (found.kind === 'work' || found.kind === 'area') return pack({ kind: found.kind, id: found.id ?? work }, 'Work');
    // Not an id: a name, matched against the choices the workbench offers.
    const o = await call<{ forWork: { kind: string; id: string; label: string }[] }>(`/api/projects/${P}/context/options`);
    const w = work.toLowerCase();
    const named = (x: { label: string }) => { const l = x.label.toLowerCase(); return l === w || l.startsWith(`${w} `) || l.startsWith(`${w}·`) || l.startsWith(`${w}：`) || l.startsWith(`${w}:`); };
    const exact = o.forWork.filter((x) => x.kind !== 'project' && named(x));
    if (exact.length === 1) return pack({ kind: exact[0]!.kind, id: exact[0]!.id }, 'Work');
    const hits = exact.length ? exact : o.forWork.filter((x) => x.kind !== 'project' && x.label.toLowerCase().includes(w));
    if (hits.length === 1) return pack({ kind: hits[0]!.kind, id: hits[0]!.id }, 'Work');
    console.error(hits.length ? `"${work}" matches ${hits.length} items; give one id:\n${hits.slice(0, 20).map((x) => `- ${x.id}  ${x.label}`).join('\n')}` : `No work item or area is named "${work}". \`pk options\` lists them with their ids.`);
    return 2;
  }
  // pk get <id>
  const asked = args[0];
  if (!asked) { console.error('usage: pk get <id>   (work item, area, source, note, rule, change, mark, breakpoint, send-back, semantic patch, code territory …)'); return 2; }
  if (/[\\/]/.test(asked) || /^[A-Za-z]:/.test(asked)) { console.error('pk get reads ids from the assets, not paths. A pack names every source by its id (src_…).'); return 2; }
  const what = await call<{ id?: string; kind: string | null; mergedFrom?: string; elsewhere?: { projectId: string; name: string } | null }>(`/api/projects/${P}/lookup/${encodeURIComponent(asked)}`);
  if (!what.kind) {
    console.error(what.elsewhere ? `${asked} belongs to project ${what.elsewhere.name} (${what.elsewhere.projectId}), not ${projectId}; it is not read here. Ask that project: pk get --project ${what.elsewhere.projectId} ${asked}` : `${asked} is not an id of project ${projectId}.`);
    return 4;
  }
  // A merged work item's id reaches the one kept (Spec §1.4, §7.10): everything below reads that one.
  const id = what.id ?? asked;
  if (what.mergedFrom) console.error(`${asked} was merged into ${id}; reading ${id}.`);
  const out = (lines: (string | null | undefined | false)[]) => { console.log(lines.filter((l) => l !== null && l !== undefined && l !== false).join('\n')); return 0; };
  if (['breakpoint', 'sendback', 'patch', 'territory'].includes(what.kind)) {
    const brief = await call<{ text: string }>(`/api/projects/${P}/k-briefs/${encodeURIComponent(id)}`);
    return out([brief.text]);
  }
  if (what.kind === 'work' || what.kind === 'area') return pack({ kind: what.kind, id }, 'Work');
  if (what.kind === 'source') {
    // The same as the workbench's original reading (§6.4, §7.10), except a code file: where it is and the version read,
    // never its lines — the agent opens the current version itself (D65). The workbench composes the text.
    const s = await call<{ text: string }>(`/api/projects/${P}/sources/${encodeURIComponent(id)}?for=agent`);
    return out([s.text]);
  }
  if (what.kind === 'rule') {
    // A project rule in full, with where it is written (§1.15, §7.10).
    const r = await call<{ text: string }>(`/api/projects/${P}/rules/${encodeURIComponent(id)}`);
    return out([r.text]);
  }
  if (what.kind === 'note') {
    const n = await call<{ status: string; ownerResponse: string | null; mount: { kind: string; ids: string[] }; versions: { version: number; at: string; title: string; preview: string; ask: string; reason: string; body: Record<string, unknown> & { facts?: { text: string; sourceIds: string[]; inferred: boolean }[] } }[]; discussion: { role: string; text: string }[]; followUps: { kind: string; at: string; summary: string }[]; cameFrom: { kind: string | null; changes: { id: string; title: string }[] } | null; judgement: { scope: { label: string }; at: string } | null ; looked?: { where: string[]; upTo: string; sessionsUpTo?: string | null; behind: string | null } | null }>(`/api/projects/${P}/notes/${encodeURIComponent(id)}`);
    const v = n.versions[n.versions.length - 1]!;
    const sec = (title: string, text: unknown) => (text ? `\n## ${title}\n${String(text)}` : null);
    return out([
      `# ${v.title}`, `Keeper note · v${v.version} · ${v.at} · ${v.ask} · ${n.status}${n.ownerResponse ? ` · owner: ${n.ownerResponse}` : ''}`,
      `Mounted on: ${n.mount.kind}${n.mount.ids.length ? ` ${n.mount.ids.join(', ')}` : ''}`,
      n.cameFrom?.kind ? `Came from: ${n.cameFrom.kind}${n.cameFrom.changes.length ? ` — ${n.cameFrom.changes.map((c) => `${c.title} (${c.id})`).join('; ')}` : ''}` : null,
      '', v.preview,
      sec('Current view', v.body.currentView), sec('Why it matters', v.body.whyItMatters),
      Array.isArray(v.body.options) && v.body.options.length ? `\n## Options\n${(v.body.options as { option: string; then: string }[]).map((o) => `- ${o.option} — ${o.then}`).join('\n')}` : null,
      v.body.facts?.length ? `\n## Facts\n${v.body.facts.map((f) => `- ${f.inferred ? '(Inferred) ' : ''}${f.text}${f.sourceIds.length ? ` [${f.sourceIds.join(', ')}]` : ''}`).join('\n')}` : null,
      sec('Other explanations', v.body.otherExplanations), sec('Keep or adjust', v.body.keepAdjust), sec('What would settle it', v.body.whatWouldSettleIt),
      n.looked ? `\n## What was read\n${n.looked.where.map((w) => `- ${w}`).join('\n')}\nRead up to ${n.looked.upTo}${n.looked.sessionsUpTo ? ` · sessions to ${n.looked.sessionsUpTo}` : ''}${n.looked.behind ? `\nDoes not reach the present: ${n.looked.behind}` : ''}` : null,
      n.judgement ? `\nBased on: judged ${n.judgement.at} · scope ${n.judgement.scope.label}` : null,
      n.followUps.length ? `\n## Course\n${n.followUps.map((f) => `- ${f.kind} · ${f.at} · ${f.summary}`).join('\n')}` : null,
      n.discussion.length ? `\n## Discussion\n${n.discussion.map((d) => `- ${d.role}: ${d.text}`).join('\n')}` : null,
      n.versions.length > 1 ? `\n## Earlier versions\n${n.versions.slice(0, -1).reverse().map((x) => `- v${x.version} · ${x.at} · ${x.title} — ${x.reason}`).join('\n')}` : null,
    ]);
  }
  if (what.kind === 'change') {
    // The record itself, without its whole propagation list: only what has not followed it, the rest counted (D59).
    const r = await call<{ changes: BriefChange[] }>(`/api/projects/${P}/changes`);
    const c = r.changes.find((x) => x.id === id)!;
    return out([changeBrief(c)]);
  }
  if (what.kind === 'mark') {
    const m = await call<{ kind: string; targetId: string; targetLabel: string; clue: string; since: string; clueSources: { id: string; title: string; label: string }[]; note: { id: string; title: string } | null; closed: { result: string; at: string; reason: string } | null }>(`/api/projects/${P}/marks/${encodeURIComponent(id)}`);
    return out([`# ${m.kind} on ${m.targetLabel} (${m.targetId})`, `Since ${m.since}${m.closed ? ` · closed ${m.closed.at}: ${m.closed.result} — ${m.closed.reason}` : ' · open'}`, '', `Clue: ${m.clue}`, m.clueSources.length ? `Clue sources: ${m.clueSources.map((s) => `${s.title} — ${s.label} (${s.id})`).join('; ')}` : null, m.note ? `Note: ${m.note.title} (${m.note.id})` : null]);
  }
  // Fact records, relations, reference items and other graph objects: the same facts as the workbench's object
  // detail, written for an agent to read (Spec §7.10; CKC-12 AC-23) — the object's own content whole, its
  // neighbours by name and id, none of the workbench's own bookkeeping.
  if (what.kind === 'fact') return out([factBrief(await call<BriefFact>(`/api/projects/${P}/facts/${encodeURIComponent(id)}`))]);
  if (what.kind === 'relation') return out([relationBrief(await call<Parameters<typeof relationBrief>[0]>(`/api/projects/${P}/relations/${encodeURIComponent(id)}`))]);
  return out([nodeBrief(await call<BriefNode>(`/api/projects/${P}/nodes/${encodeURIComponent(id)}`))]);
}

/** Leaving with a code without cutting the event loop short: on Windows, exiting while fetch handles are still
 *  closing trips a libuv assertion (seen in the 2026-09-18 trial as exit 127). */
class Exit extends Error { readonly code: number; constructor(code: number) { super(`exit ${code}`); this.code = code; } }
main().then((code) => { process.exitCode = code; }, (error) => { if (error instanceof Exit) { process.exitCode = error.code; return; } console.error(error); process.exitCode = 1; });
