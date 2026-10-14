/**
 * The execution agent's own entry (Spec §7.10; CKC-12 AC-20–AC-23, AC-26, AC-27, AC-29): the same choices, the same
 * content and the same originals as the workbench, read from the running workbench so both come from the same code.
 * Reading needs the workbench, not the Keeper; only `ask` needs the Keeper.
 *
 * Two callers say the same thing through it: the command line (`pk context`, `get`, `options`, `help`, `ask`, in
 * src/cli.ts), which prints `out` on stdout and `err` on stderr, and the MCP server (`pk mcp`, src/mcp/server.ts; D108),
 * which hands both back to its client as one tool result. Neither writes anywhere else, so the MCP server's stdout stays
 * pure JSON-RPC.
 */
import { changeBrief, factBrief, nodeBrief, relationBrief } from './object-brief.ts';
import type { BriefChange, BriefFact, BriefNode } from './object-brief.ts';

/** Where an entry's text goes: `out` what was asked for, `err` what went wrong or is said beside it. */
export interface EntryOutput {
  out(text: string): void;
  err(text: string): void;
}

/** Leaving with a code without cutting the event loop short: on Windows, exiting while fetch handles are still
 *  closing trips a libuv assertion (seen in the 2026-09-18 trial as exit 127). The MCP server turns it into a result. */
export class Exit extends Error { readonly code: number; constructor(code: number) { super(`exit ${code}`); this.code = code; } }

/** Which workbench and which project: `project` by id, or else the project containing `cwd`. */
export interface EntryTarget {
  readonly base: string;
  readonly project: string | null;
  readonly cwd: string;
}

/** What `pk context` and a work pack are asked with (`--work`, `--purpose`, `--kind`, `--recipient`, `--since`). */
export interface PackOptions {
  readonly work?: string | null;
  readonly purpose?: string | null;
  readonly kind?: string | null;
  readonly recipient?: string | null;
  readonly since?: string | null;
}

export const NOT_RUNNING = (base: string) => `ProjectKeeper is not running at ${base}. Start it with \`pk serve\` (packs, originals and options are read from the saved assets; the Keeper itself does not need to be running).`;
export const NOT_RUNNING_FOR_ASK = (base: string) => `ProjectKeeper is not running at ${base}. Start it with \`pk serve\`.`;

/** A GET or POST against the workbench; what is not running or answers with an error is said on `err` and leaves. */
function caller(base: string, io: EntryOutput, notRunning: (base: string) => string, json: boolean) {
  return async <T,>(path: string, init?: RequestInit): Promise<T> => {
    let res: Response;
    try { res = await (json ? fetch(`${base}${path}`, { headers: { 'Content-Type': 'application/json' }, ...init }) : fetch(`${base}${path}`)); }
    catch { io.err(notRunning(base)); throw new Exit(3); }
    const data = await res.json() as T & { error?: string };
    if (!res.ok) { io.err(String(data.error ?? res.statusText)); throw new Exit(1); }
    return data;
  };
}

/**
 * `pk context`, `pk get <id>`, `pk options` and `pk help` for the project at hand. `args` are the command's
 * positionals (`get` reads the first as its id).
 */
export async function agentEntry(command: string, target: EntryTarget, io: EntryOutput, args: readonly string[], options: PackOptions = {}): Promise<number> {
  const call = caller(target.base, io, NOT_RUNNING, false);
  let projectId = target.project;
  if (!projectId) {
    const r = await call<{ projectId: string | null; message?: string }>(`/api/resolve?cwd=${encodeURIComponent(target.cwd)}`);
    if (!r.projectId) { io.out(`${r.message} Give --project <id>; \`pk projects\` lists them.`); return 4; }
    projectId = r.projectId;
  }
  const P = encodeURIComponent(projectId);
  if (command === 'help') {
    const r = await call<{ lines: string[] }>(`/api/projects/${P}/usage`);
    io.out(`ProjectKeeper for execution agents · project ${projectId}\n\n${r.lines.map((l) => `- ${l}`).join('\n')}`);
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
    io.out(`Areas:\n${byKind('area').map((x) => `- ${x.id}  ${x.label}`).join('\n') || '- none'}`);
    io.out(`\nWork items:\n${byKind('work').map((x) => `- ${x.id}  ${x.label}${x.progress ? ` · ${x.progress}` : ''}`).join('\n') || '- none'}`);
    io.out(`\nRoles recognised: ${o.roles.length ? o.roles.join(', ') : 'none (that is not a gap)'}`);
    io.out(`Purposes: ${o.purposes.join(', ')}`);
    // Each kind and recipient says how its pack differs from the default one on this project, measured by assembling
    // both and comparing them, so nobody has to fetch all nine to find out (Spec §7.10; CKC-12 AC-21).
    const differences = (title: string, list: Difference[]) => io.out(`\n${title} (against the default pack: --purpose Start --kind Implement --recipient "Incoming agent", whole project):\n${list.map((x) => `- ${x.name} — ${x.difference}`).join('\n')}`);
    differences('Kinds', o.kindDifferences);
    differences('Recipients', o.recipientDifferences);
    io.out(`\nLit breakpoints:\n${k.breakpoints.map((b) => `- ${b.id} · ${b.kind} · on ${b.targetName} (${b.targetId})`).join('\n') || '- none'}`);
    io.out(`\nOpen send-backs:\n${k.sendBacks.map((s) => `- ${s.id} · ${s.stage} · to ${s.to} · ${s.what} · on ${s.targetName} (${s.targetId})`).join('\n') || '- none'}`);
    const sixNames: Record<number, string> = { 1: 'stale', 2: 'drift', 3: 'dropped along the way', 4: 'grown by itself', 5: 'let pass', 6: 'looks residual' };
    io.out(`\nSix things:\n${k.sixThings.map((s) => `${s.thing} ${sixNames[s.thing] ?? ''}:\n${s.objects.map((x) => `- ${x.id}  ${x.name}`).join('\n') || '- none'}`).join('\n')}`);
    return 0;
  }
  const pack = async (scope: { kind: string; id: string } | null, purposeDefault: 'Start' | 'Work') => {
    const q = new URLSearchParams({ scope: scope?.kind ?? 'project', purpose: options.purpose ?? purposeDefault, kind: options.kind ?? 'Implement', recipient: options.recipient ?? 'Incoming agent' });
    if (scope) q.set('ids', scope.id);
    const since = options.since;
    if (since) q.set('since', since);
    const r = await call<{ markdown: string }>(`/api/projects/${P}/context?${q}`);
    io.out(r.markdown);
    return 0;
  };
  if (command === 'context') {
    const work = options.work;
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
    io.err(hits.length ? `"${work}" matches ${hits.length} items; give one id:\n${hits.slice(0, 20).map((x) => `- ${x.id}  ${x.label}`).join('\n')}` : `No work item or area is named "${work}". \`pk options\` lists them with their ids.`);
    return 2;
  }
  // pk get <id>
  const asked = args[0];
  if (!asked) { io.err('usage: pk get <id>   (work item, area, source, note, rule, change, mark, breakpoint, send-back, semantic patch, code territory …)'); return 2; }
  if (/[\\/]/.test(asked) || /^[A-Za-z]:/.test(asked)) { io.err('pk get reads ids from the assets, not paths. A pack names every source by its id (src_…).'); return 2; }
  const what = await call<{ id?: string; kind: string | null; mergedFrom?: string; elsewhere?: { projectId: string; name: string } | null }>(`/api/projects/${P}/lookup/${encodeURIComponent(asked)}`);
  if (!what.kind) {
    io.err(what.elsewhere ? `${asked} belongs to project ${what.elsewhere.name} (${what.elsewhere.projectId}), not ${projectId}; it is not read here. Ask that project: pk get --project ${what.elsewhere.projectId} ${asked}` : `${asked} is not an id of project ${projectId}.`);
    return 4;
  }
  // A merged work item's id reaches the one kept (Spec §1.4, §7.10): everything below reads that one.
  const id = what.id ?? asked;
  if (what.mergedFrom) io.err(`${asked} was merged into ${id}; reading ${id}.`);
  const out = (lines: (string | null | undefined | false)[]) => { io.out(lines.filter((l) => l !== null && l !== undefined && l !== false).join('\n')); return 0; };
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

/** What `pk ask` is given, and how its answer says to fetch it later (the command line names `pk ask`, MCP its tool). */
export interface AskOptions {
  readonly question: string;
  readonly fetch: string | null;
  readonly thread: string | null;
  readonly wait: boolean;
  readonly fetchLater: (projectId: string, jobId: string) => string;
  readonly askAgain: (projectId: string, thread: string) => string;
}

/** `pk ask` (§7.6): a query entry without any host integration, talking to the running workbench. */
export async function askEntry(target: EntryTarget, io: EntryOutput, options: AskOptions): Promise<number> {
  const call = caller(target.base, io, NOT_RUNNING_FOR_ASK, true) as <T = Record<string, unknown>>(path: string, init?: RequestInit) => Promise<T>;
  const fetchId = options.fetch;
  let projectId = target.project;
  if (!projectId) {
    const r = await call<{ projectId: string | null; message?: string }>(`/api/resolve?cwd=${encodeURIComponent(target.cwd)}`);
    if (!r.projectId) { io.out(String(r.message)); return 4; }
    projectId = r.projectId;
  }
  if (fetchId) {
    const r = await call<{ status: string; answer: string | null; error: string | null; steps: number; startedAt?: string | null; sources: { id: string; title: string; label: string }[] }>(`/api/projects/${encodeURIComponent(projectId)}/ask/${encodeURIComponent(fetchId)}`);
    if (r.status === 'Done') { io.out(r.answer ?? ''); if (r.sources.length) io.out(`\nSources:\n${r.sources.map((s) => `- ${s.id} ${s.title} — ${s.label}`).join('\n')}`); }
    else {
      // What the investigation is doing, so waiting is not blind (trial: "no progress or ETA").
      const running = r.status === 'Running' && r.startedAt ? ` for ${Math.max(1, Math.round((Date.now() - Date.parse(r.startedAt)) / 60000))} min, ${r.steps} step${r.steps === 1 ? '' : 's'} so far` : '';
      io.out(`${r.status}${running}${r.error ? `: ${r.error}` : ''}. Fetch again later: ${options.fetchLater(projectId, fetchId)}`);
    }
    return 0;
  }
  const question = options.question.trim();
  if (!question) { io.err('usage: pk ask [--project <id> | --cwd <dir>] [--thread <id>] [--wait] "<question>"'); return 2; }
  const r = await call<{ known: string; investigation: { jobId: string; thread: string; status: string } }>(`/api/projects/${encodeURIComponent(projectId)}/ask`, { method: 'POST', body: JSON.stringify({ question, thread: options.thread }) });
  if (r.known) io.out(`Known now (from the organized assets):\n${r.known}\n`); else io.out('Nothing organized answers this yet.\n');
  io.out(`Investigation ${r.investigation.jobId} (${r.investigation.status}) in thread ${r.investigation.thread}.`);
  if (!options.wait) { io.out(`Fetch the answer later: ${options.fetchLater(projectId, r.investigation.jobId)}\nKeep asking in the same thread: ${options.askAgain(projectId, r.investigation.thread)}`); return 0; }
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const s = await call<{ status: string; answer: string | null; error: string | null; sources: { id: string; title: string; label: string }[] }>(`/api/projects/${encodeURIComponent(projectId)}/ask/${encodeURIComponent(r.investigation.jobId)}`);
    if (['Done', 'Failed', 'Stopped'].includes(s.status)) { io.out(`\n${s.answer ?? s.error ?? s.status}`); if (s.sources.length) io.out(`\nSources:\n${s.sources.map((x) => `- ${x.id} ${x.title} — ${x.label}`).join('\n')}`); return s.status === 'Done' ? 0 : 1; }
    if (s.status === 'Waiting for quota') { io.out(`Waiting for quota; fetch later: ${options.fetchLater(projectId, r.investigation.jobId)}`); return 0; }
  }
}
