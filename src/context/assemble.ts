/**
 * Context for execution agents (Spec §7.1–§7.4, §7.8; CKC-12). Assembly is deterministic and
 * reads only the assets (E6): the same input gives the same content, whatever channel delivers
 * it. Sections appear only when they have content; the delivery grading of D15 decides where a
 * thing goes (body, Do not revive, Not in current scope, Pending owner decisions, Freshness).
 *
 * Two rules from D59 run through the whole file:
 * - The normal state is not written; an anomaly is written only where it can be checked. `Up to date`,
 *   `Updated`, `Reusable as is`, `Holds`, `Not assessed` and "no marks" stay in the assets, to be fetched
 *   by id (§7.10). What is written — an entry mark, `Still on old understanding`, `Questioned` — carries
 *   its source and says what differs, on the line of the object it belongs to, not in a list at the end.
 * - The start pack follows the graph: product → goals → plans → areas → work items, told with the
 *   explanations the assets already hold, whole. What goes in goes in whole; what does not fit this pack
 *   is named by name and id, never by half a sentence (AC-31).
 *
 * History (D82; Spec §7.1; CKC-12 AC-35): what exists only in history and objects `Removed` from the current version are
 * never current content; where they bear on the work they are given as lineage, marked as history, saying when and what
 * replaced them or why they went (lineage.ts). The project's ledger, when it has one, gives the rest of that lineage.
 */
import type { AreaUnderstanding, ChangeItem, ChangeRecord, ContextPackage, ContextRequest, EntryMark, Note, ObjectJudgement, PendingWait, Project, ProjectRule, ReferenceItem, Source, Statement, WorkThread } from '../model/types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import type { Ledger } from '../ledger/index.ts';
import { historyChanges, ledgerLineage, removalOf, type HistoryChange } from './lineage.ts';
import { anchorLabel } from '../sources/anchor.ts';
import { newId } from '../model/ids.ts';
import { OWNER_WORDS } from '../model/vocab.ts';
import { reportedBy } from '../model/time.ts';
import { areaOf } from '../keeper/organize/graph.ts';
import { itemsOf, notJudgedReason, roundNumberOf } from '../keeper/adjustment.ts';
import { pathKey } from '../util/paths.ts';
import { OPEN_CURRENT, commitFacts, fileLocation, isCodeSource, locationText, shortLocationText } from './code-source.ts';
import { dayOf, decidedBy, traceOwnerWords } from './owner-words.ts';
import { ruleBearsOnWork, rulesLines, rulesOpening, type RuleRowHelp, type WorkFacts } from './project-rules.ts';
import { fileURLToPath } from 'node:url';
import { scheduleOf } from '../keeper/organize/schedule.ts';
import { failuresOf as realFailures } from '../intake/skipped.ts';

type Emphasis = 'full' | 'brief' | 'skip';
/**
 * What each kind of work puts first (Spec §7.1). Every kind that does or plans the work — and product discussion —
 * gets the owner's words in full (D66); an investigation lists them, and fetches them by id.
 */
const KIND_EMPHASIS: Record<string, Record<string, Emphasis>> = {
  'Implement': { ownerWords: 'full', serves: 'full', relation: 'full', done: 'full', results: 'full', failures: 'full', open: 'full', code: 'full', notes: 'brief', reference: 'brief' },
  'Review': { ownerWords: 'full', serves: 'full', relation: 'brief', done: 'full', results: 'brief', failures: 'full', open: 'full', code: 'brief', notes: 'full', reference: 'brief', reviewChanges: 'full' },
  'Plan': { ownerWords: 'full', serves: 'full', relation: 'full', done: 'brief', results: 'brief', failures: 'brief', open: 'full', code: 'skip', notes: 'brief', reference: 'full', dependencies: 'full' },
  'Discuss product': { ownerWords: 'full', serves: 'full', relation: 'brief', done: 'brief', results: 'brief', failures: 'skip', open: 'brief', code: 'skip', notes: 'full', reference: 'full' },
  'Investigate': { ownerWords: 'brief', serves: 'brief', relation: 'brief', done: 'brief', results: 'full', failures: 'full', open: 'full', code: 'full', notes: 'brief', reference: 'brief', recentChanges: 'full' },
};

/**
 * The sources a pack cites, numbered in the order they first appear. A source that exists only in history is cited like
 * any other, and `Sources` says it is history (D82; Spec §1.2, §7.1): it backs the lineage and the marks it helped to set,
 * never a current requirement.
 */
class Cites {
  private readonly order: string[] = [];
  private readonly index = new Map<string, number>();
  private readonly store: ProjectStore;
  constructor(store: ProjectStore) { this.store = store; }
  ref(ids: readonly string[]): string {
    const nums: number[] = [];
    for (const id of ids) {
      const s = this.store.sources.get(id);
      if (!s) continue;
      let n = this.index.get(id);
      if (!n) { this.order.push(id); n = this.order.length; this.index.set(id, n); }
      nums.push(n);
    }
    return nums.length ? ` [${nums.join(',')}]` : '';
  }
  list(): string[] { return this.order; }
}

/**
 * What goes into a pack goes in whole (D59; CKC-12 AC-31): `text` keeps every word. `oneLine` keeps every word
 * too and only folds the line breaks away, for content that sits on a row of the map. `indent` puts a whole
 * explanation under the row it belongs to. Nothing here shortens; a thing that does not belong in this pack is
 * named by name and id instead (2026-09-18: reference explanations cut to a hundred characters made PRD §4.2 and
 * PLAN §6 unreadable).
 */
const text = (s: string | null | undefined) => (s ?? '').trim();
const oneLine = (s: string | null | undefined) => text(s).replace(/\s*\n+\s*/g, ' ');
const indent = (s: string | null | undefined, pad: string) => text(s).split('\n').map((l) => l.trim()).filter((l) => l.length).map((l) => `${pad}${l}`).join('\n');
const latest = (n: Note) => n.versions[n.versions.length - 1]!;
/** A work item's name with its own number in front, unless the title already starts with it. */
const titled = (t: WorkThread) => (t.ids.length && !t.title.startsWith(t.ids[0]!) ? `${t.ids[0]} ${t.title}` : t.title);
const nameOf = (store: ProjectStore, id: string) => store.reference.get(id)?.name ?? store.threads.get(id)?.title ?? store.changes.get(id)?.title ?? (store.sources.get(id) ? anchorLabel(store.sources.get(id)!.anchor) : id);

export interface Scope { readonly kind: ContextRequest['scope']['kind']; readonly ids: readonly string[] }

interface ScopeSet { kind: Scope['kind']; areaIds: Set<string>; threads: WorkThread[]; references: ReferenceItem[]; label: string; focusThread: WorkThread | null }

/** The product overview and the goals say what the product is and who it is for; both belong in `Purpose` (§7.3). */
const PURPOSE_CATEGORIES = new Set(['Product', 'Goal']);
/** A change that set or changed the direction (§1.12, §7.3 item 7): a decision, what the owner said, the product's direction,
 *  or anything replaced, given up, put off or removed. */
const DIRECTION_MATERIALS: ReadonlySet<string> = new Set(['Decision', 'Owner statement', 'Product direction']);
const DIRECTION_EFFECTS: ReadonlySet<string> = new Set(['Replaced', 'Abandoned', 'Deferred', 'Removed']);

/**
 * What a pack is about. An object that was `Removed` — its material deleted from the project's current version — is no
 * current content of any pack (Spec §2.1, §7.1; CKC-12 AC-35): not the scope, not an area, not a work item in it. Where it
 * bears on the work it appears as lineage instead.
 */
function resolveScope(store: ProjectStore, project: Project, scope: Scope): ScopeSet {
  const live = (x: { readonly validity: string } | undefined) => x !== undefined && x.validity !== 'Removed';
  const allThreads = store.threads.all().filter(live);
  const refs = store.reference.all().filter(live);
  const liveArea = (id: string | null): id is string => id !== null && live(store.reference.get(id));
  if (scope.kind === 'work' && scope.ids[0] && live(store.threads.get(scope.ids[0]))) {
    const t = store.threads.get(scope.ids[0])!;
    const areaIds = new Set(t.serves.map((s) => areaOf(store, s.referenceId)).filter(liveArea));
    const refIds = new Set([...t.serves.map((s) => s.referenceId), ...areaIds]);
    return { kind: 'work', areaIds, threads: [t], references: refs.filter((r) => refIds.has(r.id) || PURPOSE_CATEGORIES.has(r.category)), label: titled(t), focusThread: t };
  }
  if (scope.kind === 'area' && scope.ids[0] && live(store.reference.get(scope.ids[0]))) {
    const area = store.reference.get(scope.ids[0])!;
    const threads = allThreads.filter((t) => t.serves.some((s) => areaOf(store, s.referenceId) === area.id));
    return { kind: 'area', areaIds: new Set([area.id]), threads, references: refs.filter((r) => r.id === area.id || areaOf(store, r.id) === area.id || PURPOSE_CATEGORIES.has(r.category)), label: `Area: ${area.name}`, focusThread: null };
  }
  if (scope.kind === 'path' && scope.ids.length) {
    const ids = new Set(scope.ids);
    const threads = allThreads.filter((t) => ids.has(t.id));
    const areaIds = new Set<string>([...scope.ids.filter((id) => store.reference.get(id)?.category === 'Area' && liveArea(id)), ...threads.map((t) => t.serves.map((s) => areaOf(store, s.referenceId))).flat().filter(liveArea)]);
    return { kind: 'path', areaIds, threads, references: refs.filter((r) => ids.has(r.id) || areaIds.has(r.id) || PURPOSE_CATEGORIES.has(r.category)), label: `Path: ${scope.ids.map((id) => nameOf(store, id)).join(' → ')}`, focusThread: threads.length === 1 ? threads[0]! : null };
  }
  return { kind: 'project', areaIds: new Set(refs.filter((r) => r.category === 'Area' && r.validity === 'Current').map((r) => r.id)), threads: allThreads, references: refs, label: project.name, focusThread: null };
}

const DEFAULT_REQUEST: ContextRequest = { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null } as ContextRequest;

/**
 * What an option actually changes, measured by assembling both packs and comparing them section by section
 * (D59; CKC-12 AC-21). The agent is told the difference instead of fetching all nine packs to compare them
 * itself; where a project has no difference, it is told that too (2026-09-18: 4 of 9 options were all but
 * identical to the default and nothing said so).
 */
type Sections = Map<string, string[]>;
/**
 * A pack by its sections. The header always names the kind and the recipient that were asked for (§7.1), so it is
 * never the difference an agent is choosing between; what is compared is the sections under it.
 */
function packSections(md: string): Sections {
  const map: Sections = new Map();
  let title: string | null = null;
  for (const line of md.split('\n')) {
    if (line.startsWith('## ')) { title = line.slice(3).trim(); map.set(title, []); } else if (title !== null && line.trim().length) map.get(title)!.push(line);
  }
  return map;
}
function packDifference(A: Sections, B: Sections): string {
  const size = (m: Sections) => [...m.values()].flat().join('\n').length;
  const added = [...B.keys()].filter((k) => !A.has(k));
  const dropped = [...A.keys()].filter((k) => !B.has(k));
  const differs = [...B.keys()].filter((k) => A.has(k) && A.get(k)!.join('\n') !== B.get(k)!.join('\n'));
  if (!added.length && !dropped.length && !differs.length) return 'the same pack as the default, apart from the header naming this kind and recipient';
  const parts: string[] = [];
  if (added.length) parts.push(`adds ${added.map((k) => `\`${k}\``).join(', ')}`);
  if (dropped.length) parts.push(`drops ${dropped.map((k) => `\`${k}\``).join(', ')}`);
  for (const k of differs) parts.push(`\`${k}\` differs (${B.get(k)!.length} lines against ${A.get(k)!.length})`);
  const delta = size(B) - size(A);
  parts.push(`${Math.abs(delta)} characters ${delta >= 0 ? 'more' : 'less'} in all`);
  return parts.join('; ');
}

export function contextOptions(store: ProjectStore, project: Project, ledger: Ledger | null = null) {
  const areas = store.reference.filter((r) => r.category === 'Area' && r.validity === 'Current').map((r) => ({ kind: 'area', id: r.id, label: r.name }));
  const work = store.threads.filter((t) => t.validity === 'Current').sort((a, b) => (a.progress === 'In progress' ? 0 : 1) - (b.progress === 'In progress' ? 0 : 1) || a.title.localeCompare(b.title)).map((t) => ({ kind: 'work', id: t.id, label: titled(t), progress: t.progress }));
  const kinds = ['Implement', 'Review', 'Plan', 'Discuss product', 'Investigate'];
  const recipients = ['Incoming agent', ...project.roles];
  // A kind changes a work pack most and a start pack least, so both are measured, on this project's own assets. The
  // packs are assembled once each and kept, because every option is compared against the same two.
  const sample = work[0] ?? null;
  const assembled = new Map<string, Sections>();
  const sectionsFor = (purpose: 'Start' | 'Work', kind: string, recipient: string): Sections => {
    const key = `${purpose}|${kind}|${recipient}`;
    let s = assembled.get(key);
    if (!s) {
      const request = { ...DEFAULT_REQUEST, kind, recipient, ...(purpose === 'Work' && sample ? { scope: { kind: 'work', ids: [sample.id] }, purpose } : {}) } as ContextRequest;
      s = packSections(assembleContext(store, project, request, 'Idle', {}, ledger).markdown);
      assembled.set(key, s);
    }
    return s;
  };
  const describe = (kind: string, recipient: string): string => {
    const startPart = packDifference(sectionsFor('Start', 'Implement', 'Incoming agent'), sectionsFor('Start', kind, recipient));
    if (!sample) return `start pack: ${startPart}`;
    const workPart = packDifference(sectionsFor('Work', 'Implement', 'Incoming agent'), sectionsFor('Work', kind, recipient));
    return `start pack: ${startPart} · work pack (measured on ${sample.label}): ${workPart}`;
  };
  return {
    forWork: [{ kind: 'project', id: '', label: 'Whole project' }, ...areas, ...work],
    purposes: ['Start', 'Work'], kinds, recipients,
    // Each option says how its pack differs from the default (`Start` · `Implement` · `Incoming agent`, whole project).
    kindDifferences: kinds.map((k) => ({ name: k, difference: k === 'Implement' ? 'the default pack' : describe(k, 'Incoming agent') })),
    recipientDifferences: recipients.map((r) => ({ name: r, difference: r === 'Incoming agent' ? 'the default pack' : describe('Implement', r) })),
  };
}

/**
 * `Version check` (§7.3 item 7): does the version the agent's task cites match the current material?
 * Deterministic: version markers are read from the work, the reference items it names and their sources.
 */
function versionCheck(store: ProjectStore, thread: WorkThread | null, references: readonly ReferenceItem[], taskVersion: string, cites: { ref(ids: readonly string[]): string }): string[] {
  const VERSION_RE = /\bv?(\d+(?:\.\d+)+)\b/i;
  const cited = VERSION_RE.exec(taskVersion)?.[1] ?? null;
  const idsInTask: string[] = taskVersion.match(/\b[A-Za-z]{2,}-\d+\b/g) ?? [];
  type Candidate = { label: string; text: string; sourceIds: readonly string[]; ids: readonly string[] };
  const candidates: Candidate[] = [];
  if (thread) {
    candidates.push({ label: thread.title, text: `${thread.title} ${thread.doing} ${thread.changed} ${thread.results}`, sourceIds: thread.factRecordIds.flatMap((f) => store.facts.get(f)?.aboutSourceIds ?? []).slice(0, 4), ids: thread.ids });
    // A code file is not read for a version: the agent opens the current code itself (D65); what exists only in
    // history is not current material (D61).
    for (const s of thread.factRecordIds.flatMap((f) => store.facts.get(f)?.aboutSourceIds ?? []).map((id) => store.sources.get(id)).filter((x): x is Source => x !== undefined && !isCodeSource(x) && x.usedAs !== 'History only').slice(0, 12)) candidates.push({ label: s.title, text: s.excerpt.slice(0, 2000), sourceIds: [s.id], ids: s.ids });
  }
  // A replaced or abandoned item is not the current version of anything (it is in `Do not revive`).
  for (const r of references.filter((x) => x.validity === 'Current')) candidates.push({ label: r.name, text: `${r.name} ${r.text} ${r.quote ?? ''}`, sourceIds: r.sourceIds, ids: r.ids });
  const relevant = candidates.filter((c) => idsInTask.length === 0 || c.ids.some((id) => idsInTask.includes(id)) || idsInTask.some((id) => c.text.includes(id)));
  const lines = [`- Your task cites: ${taskVersion}`];
  let found = 0;
  for (const c of relevant) {
    if (found >= 4) break;
    const m = VERSION_RE.exec(c.text);
    if (!m) continue;
    found++;
    const verdict = cited ? (m[1] === cited ? ' — same as your task' : ` — differs from your task's v${cited}; work from the current version and say so`) : '';
    lines.push(`- Current material for ${c.label}: v${m[1]}${verdict}${cites.ref(c.sourceIds)}`);
  }
  if (found === 0) lines.push('- Not yet established: no version marker found in the current material for this work. To know it, open the sources below or ask the Keeper.');
  return lines;
}

/**
 * How an execution agent reaches the project by itself (Spec §7.10): the same lines in `Explore further`, in `pk help`,
 * and in the Keeper view's `Execution-agent access`, so what the pack says can be done as written.
 */
export interface UsageWhere {
  /** The port the workbench serves on, when it is not the one the command line would try by default. */
  readonly port?: number | null;
}
export function agentUsage(projectId: string, where: UsageWhere = {}): string[] {
  const port = where.port ? ` --port ${where.port}` : '';
  const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
  const lines = [
    `\`pk\` is the ProjectKeeper command; where it is not installed, run \`node ${cli}\` in its place. It talks to the running workbench${port ? ` (this one serves on port ${where.port}, hence \`--port ${where.port}\` below)` : ''}.`,
    `A context pack: \`pk context --project ${projectId}\` gives the start-of-work map; add \`--work <id>\` for one work item or area (its work context), \`--purpose Start|Work\`, \`--kind Implement|Review|Plan|"Discuss product"|Investigate\`, \`--recipient <role>\`, and \`--since <time of your last pack>\` for the changes since then.`,
    `Anything this pack names by id: \`pk get --project ${projectId} <id>\` — a work item or area gives its context pack, a source (\`src_…\`) the original with line numbers and whether it changed since it was read (a code file gives where it is and the version read: open the current version and read it there), a note (\`note_…\`) the full note, a project rule (\`rule_…\`) the rule in full with where it is written, anything else its own content in full with its neighbours named by id. Only ids of this project are read; no paths.`,
    `What you can ask for: \`pk options --project ${projectId}\` lists the areas, work items and recognised roles with their ids, and the purposes, kinds and recipients, each saying how its pack differs from the default one.`,
    `Ask the Keeper: \`pk ask --project ${projectId} "<question>"\`. What is organized comes at once; what needs investigating returns the known part now and a job id (\`pk ask --project ${projectId} --fetch <jobId>\`); \`--thread <id>\` keeps asking in the same thread. Only asking needs the Keeper; packs, originals and options are read from the saved assets even when it is stopped, paused or out of quota.`,
    'Original records (sessions, long logs, raw files) are not included in a pack; the sources below name them by id, and `pk get` reads them.',
  ];
  return port ? lines.map((l) => l.split(`--project ${projectId}`).join(`--project ${projectId}${port}`)) : lines;
}

/**
 * `ledger`: the project's ledger (§1.16), when it has one; the work context's `How it got here` takes the rest of the
 * work's lineage from it. Without it the lineage has what the assets record.
 */
export function assembleContext(store: ProjectStore, project: Project, request: ContextRequest, keeperStatus: string, where: UsageWhere = {}, ledger: Ledger | null = null): ContextPackage {
  const cites = new Cites(store);
  const scope = resolveScope(store, project, request.scope);
  const em = KIND_EMPHASIS[request.kind] ?? KIND_EMPHASIS['Implement']!;
  const isOrchestrator = /orchestrat|编排/i.test(request.recipient);
  const roleRecipient = request.recipient !== 'Incoming agent' ? request.recipient : null;
  const coverage = store.coverage.scopes.find((s) => s.id === 'project');
  const asOf = coverage?.asOf ?? null;
  const commit = coverage?.commit ?? null;
  const out: string[] = [];
  const section = (title: string, lines: string[]) => { const body = lines.filter((l) => l.trim().length); if (body.length) { out.push(`## ${title}`, ...body, ''); } };
  /**
   * What exists only in history, and objects `Removed` from the project's current version, are never current content of
   * any section (Spec §1.2, §2.1, §7.1; CKC-12 AC-35). Where they bear on the work they are given as lineage, marked as
   * history, with when and what replaced them or why they went (`How it got here`); where a current object still rests
   * on a removed one, that object's own row says so. What was replaced or abandoned still goes to `Do not revive`.
   */
  const removed = (id: string) => store.reference.get(id)?.validity === 'Removed' || store.threads.get(id)?.validity === 'Removed' || store.nodes.get(id)?.validity === 'Removed';
  const historyOnly = (id: string) => store.sources.get(id)?.usedAs === 'History only';
  const gone = (id: string) => removed(id) || historyOnly(id);
  /** When a removed object left the current version and what took it out, as the change records give it. */
  const removedWhen = (id: string, withDay: boolean): string => {
    const r = removalOf(store, id);
    if (!r) return 'removed from the current version (the records do not say when)';
    return `removed from the current version${withDay ? ` on ${dayOf(r.at) ?? r.at}` : ''} (${r.effect}: ${oneLine(r.title)}${text(r.why) ? ` — ${oneLine(r.why)}` : ''}; \`${r.changeId}\`)${cites.ref(r.sourceIds)}`;
  };
  /** The removed objects one object rests on, each with how it rests on it. */
  const removedUnder = (id: string): { id: string; how: string }[] => {
    const t = store.threads.get(id);
    const r = store.reference.get(id);
    const on = [
      ...(t ? [...t.serves.map((s) => ({ id: s.referenceId, how: 'serves' })), ...t.dependsOn.map((d) => ({ id: d.threadId, how: 'depends on' }))] : []),
      ...(r ? r.refines.map((x) => ({ id: x, how: 'refines' })) : []),
      ...store.relations.filter((x) => x.from === id && (x.type === 'depends on' || x.type === 'refines' || x.type === 'serves' || x.type === 'carries out')).map((x) => ({ id: x.to, how: x.type })),
    ];
    return on.filter((x, i) => removed(x.id) && on.findIndex((y) => y.id === x.id) === i);
  };
  const restsOnRemovedText = (x: string) => `rests on “${nameOf(store, x)}” (\`${x}\`) — history: ${removedWhen(x, true)}`;
  const restsOnRemoved = (id: string): string[] => removedUnder(id).map((x) => restsOnRemovedText(x.id));
  /**
   * Two records that disagree are both written and neither is picked (Spec §2.4, D43): one task number on two current
   * work items whose progress differs. Merging them is the organizing round's work (§1.4); until then both stand.
   */
  const twinsOf = (t: WorkThread) => t.validity !== 'Current' ? [] : store.threads.filter((x) => x.id !== t.id && x.validity === 'Current' && x.progress !== t.progress && x.ids.some((n) => t.ids.some((m) => m.toUpperCase() === n.toUpperCase())));
  const twinText = (t: WorkThread): string | null => {
    const tw = twinsOf(t);
    if (!tw.length) return null;
    const number = t.ids.find((m) => tw.some((x) => x.ids.some((n) => n.toUpperCase() === m.toUpperCase()))) ?? t.ids[0]!;
    return `${number} is also ${tw.map((x) => `${titled(x)} (\`${x.id}\`), ${x.progress}`).join('; ')}`;
  };
  const twinNotes = (t: WorkThread): string[] => { const s = twinText(t); return s ? [`the records disagree: ${s}`] : []; };
  const marksOn = new Map<string, EntryMark[]>();
  for (const m of store.marks.filter((x) => !x.closed && !gone(x.targetId))) { if (!marksOn.has(m.targetId)) marksOn.set(m.targetId, []); marksOn.get(m.targetId)!.push(m); }
  /** A role set this rule or decision in the owner's place, and it is in force (§1.9; CKC-12 AC-37). */
  const withoutOwner = (id: string) => marksOn.get(id)?.find((m) => m.kind === 'Decided without owner');
  /** The marks this pack actually writes, so the map's opening can say how many of the open marks are here. */
  const shownMarkIds = new Set<string>();
  const undocumented = (id: string) => marksOn.get(id)?.find((m) => m.kind === 'Undocumented decision');
  /**
   * An anomaly is written into a pack only where the agent reading it can check the same thing: the mark says what
   * differs (its clue) and names the material it was checked against. A mark with neither stays in the assets and is
   * fetched by id. Basis: the 2026-09-18 trial, where 94 mark lines followed the map, some of them judging a
   * point-in-time record stale and some hanging off another mark (D58, D59).
   */
  const checked = (m: EntryMark) => text(m.clue).length > 0 && m.clueSourceIds.length > 0;
  /**
   * §2.10: what is never judged for propagation never appears as `Still on old understanding` (AC-32): a point-in-time
   * record — a `Done` work item, a `Replaced`, `Abandoned` or `Removed` entry, a session, commit, run result or review —
   * which records how things stood then; a decision, which is checked for what replaced it instead (§5.5); and a mark or a
   * note, which judge something else. It is the rule the judging tools apply (adjustment.ts `notJudgedReason`): the copy
   * this file kept had drifted from it — it took every source and every `Result` node for a point-in-time record, so a
   * maintained document or code area judged behind never showed as behind (QC AH #14).
   */
  const pointInTime = (id: string): boolean => notJudgedReason(store, id) !== null;
  /**
   * A mark is a judgement about something else, so it never hangs on another mark or on a note (Spec §1.11; CKC-02
   * AC-22; AC-32). A mark on a point-in-time record is left alone: a doubt about whether that record was true when it
   * was written is legitimate, and only the Keeper that wrote the mark knows which of the two it is (§2.6).
   */
  const onAnotherJudgement = (id: string) => id.startsWith('mark_') || id.startsWith('note_') || store.notes.has(id) || store.marks.has(id);
  /** The owner's words whole, their line breaks kept (D66: word for word, never cut). */
  const quoteBlock = (q: string, pad: string) => `${pad}“${text(q).split('\n').map((l, i) => (i === 0 ? l : `${pad}${l}`)).join('\n')}”`;
  /** When and where the owner said what an item holds: the day of the session it cites, and the citation. */
  const saidOnDay = (w: ReferenceItem) => { for (const id of w.sourceIds) { const a = store.sources.get(id)?.anchor; if (a?.kind === 'session' && a.at) return dayOf(a.at); } return null; };
  /** The owner's words an item of `Purpose` rests on (it `refines` them): what the product and its goals are, as the owner said it. */
  const ownerWordsUnder = (r: ReferenceItem) => r.refines.map((id) => store.reference.get(id)).filter((w): w is ReferenceItem => w !== undefined && w.category === OWNER_WORDS && w.validity === 'Current' && text(w.quote).length > 0);
  /** A decision's carry-out on its own row (Spec §2.2; CKC-12 AC-38): carried out is not a to-do; partly carried out says what is left. */
  const carryOutNotes = (r: ReferenceItem): string[] => {
    const c = r.carryOut;
    if (!c || c.status === 'Not carried out yet') return [];
    const works = c.workIds.map((id) => store.threads.get(id)).filter((t): t is WorkThread => t !== undefined && !gone(t.id));
    const named = works.map((t) => `${titled(t)} (\`${t.id}\`)`).join(', ');
    const notes = [c.status === 'Carried out' ? `carried out${named ? ` by ${named}` : ''}` : `partly carried out${named ? ` by ${named}` : ''}; still left: ${oneLine(c.remaining) || 'not recorded'}`];
    // Two records disagree (Spec §2.4): the decision says it was carried out, the work that carried it out says it has not started.
    if (c.status === 'Carried out' && works.length && works.every((t) => t.progress === 'Planned')) notes.push(`the records disagree: it is recorded as carried out by ${named}, which ${works.length === 1 ? 'is' : 'are'} Planned`);
    return notes;
  };
  const withoutOwnerNote = (id: string): string[] => { const m = withoutOwner(id); return m && checked(m) ? [`set by ${m.decidedBy?.who ?? 'a role'} without the owner — see \`Pending owner decisions\``] : []; };
  /** `Update pending` on a product reference item where the pack names it (§1.11, §7.1); noted so `Freshness` says how to read it. */
  let refPendingWritten = false;
  const refPending = (r: ReferenceItem): string[] => {
    if (!(r.pendingSourceIds ?? []).length) return [];
    refPendingWritten = true;
    return [pendingMark(r.pendingSourceIds!, r.waitsFor)];
  };
  /** A reference item with its whole explanation and the owner's own words, both entire (AC-31). */
  const refLine = (r: ReferenceItem) => {
    const notes = [...refPending(r), ...carryOutNotes(r), ...withoutOwnerNote(r.id), ...restsOnRemoved(r.id)];
    const head = `- **${r.name}**${r.ids.length ? ` (${r.ids.join(', ')})` : ''} · \`${r.id}\`${r.basis === 'Inferred' ? ' · Inferred' : ''}${r.validity === 'Proposed' ? ' · Proposed' : ''}${undocumented(r.id) ? ' — not yet written into the project documents; basis is the owner’s words' : ''}${cites.ref(r.sourceIds)}${notes.length ? ` — ${notes.join('; ')}` : ''}`;
    const words = PURPOSE_CATEGORIES.has(r.category) ? ownerWordsUnder(r).map((w) => { const on = saidOnDay(w); return `  Owner’s words (\`${w.id}\`${on ? `, said ${on}` : ''})${cites.ref(w.sourceIds)}:\n${quoteBlock(w.quote!, '  ')}`; }) : [];
    return [head, indent(r.text, '  '), r.quote ? indent(`Owner’s words: “${text(r.quote)}”`, '  ') : '', ...words].filter((l) => l.length).join('\n');
  };
  const current = (v: string) => v === 'Current';
  // When waiting material will be organized (Spec §3.8): the owner's daily Follow up, or after each stretch of work,
  // or, while the takeover runs, as it goes.
  const takingOver = store.coverage.takeover ? store.coverage.takeover.stage !== 'Daily' : false;
  const whenOrganized = takingOver ? 'as the takeover goes on' : scheduleOf(project).frequency === 'Continuous' ? 'after the current stretch of work' : 'at the next Follow up (on the owner’s schedule, or earlier when the owner starts one)';
  // What an entry waits for (Spec §7.1: `Update pending` names the changes it waits for): each change as the coverage
  // lists it, the id to read it by, and how it reaches the entry. A mark written before the changes were named gives the
  // documents only, by document: a changed file shows up as many section sources, and naming each section made one
  // area's mark list 411 of them. One id per document is enough to read it.
  const pendingMark = (sourceIds: readonly string[], waits?: readonly PendingWait[]) => {
    if (waits?.length) {
      const named = waits.slice(0, 4).map((w) => `${w.label} (\`${w.sourceIds[0] ?? w.ref}\`${w.sourceIds.length > 1 ? `, ${w.sourceIds.length} parts` : ''}${w.reasons.length ? ` — ${w.reasons.map((r) => r.detail).join('; ')}` : ''})`);
      return `Update pending: ${named.join(', ')}${waits.length > 4 ? ` and ${waits.length - 4} more change${waits.length - 4 === 1 ? '' : 's'}` : ''}`;
    }
    const docs = new Map<string, string[]>();
    for (const id of sourceIds) {
      const a = store.sources.get(id)?.anchor;
      const doc = !a ? id : a.kind === 'file' ? a.path.split(/[\\/]/).pop()! : a.kind === 'session' ? `${a.host} session ${a.sessionId.slice(0, 8)}` : a.kind === 'commit' ? `commit ${a.commit.slice(0, 8)}` : a.kind;
      if (!docs.has(doc)) docs.set(doc, []);
      docs.get(doc)!.push(id);
    }
    const named = [...docs].slice(0, 4).map(([doc, ids]) => `${doc} (\`${ids[0]}\`${ids.length > 1 ? `, ${ids.length} parts` : ''})`);
    return `Update pending: ${named.join(', ')}${docs.size > 4 ? ` and ${docs.size - 4} more document${docs.size - 4 === 1 ? '' : 's'}` : ''}`;
  };
  // Short names on the map: an area or work item by its own number when it has one; a title that already starts with
  // that number is not prefixed again.
  const shortName = (id: string) => store.reference.get(id)?.ids[0] ?? store.threads.get(id)?.ids[0] ?? nameOf(store, id);
  const workTitle = titled;
  /** Marks on one object, each saying what differs and naming what it was checked against (D59). */
  const markNotes = (id: string) => (marksOn.get(id) ?? []).filter((m) => m.kind !== 'Undocumented decision' && checked(m) && !onAnotherJudgement(m.targetId)).map((m) => { shownMarkIds.add(m.id); return `${m.kind} (\`${m.id}\`): ${oneLine(m.clue)}${cites.ref(m.clueSourceIds)}`; });
  // Which objects have not followed which change, and what they lack: written on the object's own row when it is on
  // the map, indexed in `Freshness` when it is not (Spec §7.1; CKC-12 AC-3, AC-32). A point-in-time record never
  // appears here, and an entry that names neither what differs nor a source cannot be checked, so it is not written.
  const behindOn = new Map<string, { title: string; id: string; what: string; sourceIds: readonly string[] }[]>();
  // The round's own judgement says which items of which record the object still lacks (D56), so it is read first — the
  // latest one only. Each round judges what reached the object together with what it still lacked, so its judgement
  // carries every lack still open (§2.10, §5.5): an object whose latest judgement is not `Still on old understanding`
  // lacks nothing now, whatever an earlier round said. Reading every round kept an object that had followed since
  // on the map as behind. Rounds are ordered by number, never as strings (`roundNumberOf`); an object keeps the place
  // its first judgement gave it. The per-change entries the program mirrors judgements into cover objects no round has
  // judged yet.
  const latestJudgement = new Map<string, ObjectJudgement>();
  for (const j of store.propagation.all().sort((a, b) => roundNumberOf(a.roundId) - roundNumberOf(b.roundId))) latestJudgement.set(j.nodeId, j);
  const judged = new Set<string>();
  for (const j of latestJudgement.values()) {
    if (pointInTime(j.nodeId)) continue;
    judged.add(j.nodeId);
    if (j.state !== 'Still on old understanding') continue;
    for (const l of j.lacks) {
      const c = store.changes.get(l.changeId);
      if (!c) continue;
      const item = l.itemId ? itemsOf(c).find((x) => x.id === l.itemId) : undefined;
      if (!text(l.what) && c.sourceIds.length === 0) continue;
      if (!behindOn.has(j.nodeId)) behindOn.set(j.nodeId, []);
      behindOn.get(j.nodeId)!.push({ title: item ? `${c.work ? `${c.work.label} · ` : ''}${item.title}` : c.title, id: c.id, what: oneLine(l.what), sourceIds: item ? item.sourceIds : c.sourceIds });
    }
  }
  for (const c of store.changes.all()) for (const p of c.propagation) {
    if (p.state !== 'Still on old understanding' || pointInTime(p.nodeId) || judged.has(p.nodeId)) continue;
    if (!text(p.sourceOrReason) && c.sourceIds.length === 0) continue;
    if (!behindOn.has(p.nodeId)) behindOn.set(p.nodeId, []);
    behindOn.get(p.nodeId)!.push({ title: c.title, id: c.id, what: oneLine(p.sourceOrReason), sourceIds: c.sourceIds });
  }
  // One entry per object, however many changes it is behind: the object is what the row is about, and the twenty
  // change records a single work item can lag behind would otherwise repeat the same opening twenty times.
  const behindNotes = (id: string) => {
    const cs = behindOn.get(id) ?? [];
    return cs.length ? [`Still on old understanding: has not followed ${cs.map((b) => `“${oneLine(b.title)}” (\`${b.id}\`)${b.what ? ` — ${b.what}` : ''}${cites.ref(b.sourceIds)}`).join('; ')}`] : [];
  };
  // How to check a mark now, and when waiting material is organized: the same for every mark, so said once, above the
  // map; each mark carries the id that `pk get` reads (Spec §7.1, §7.3; CKC-12 AC-24).
  const markLegend = `How to read the marks: each names an id — \`pk get <id>\` reads it now (the changed document for \`Update pending\`, the clue for the others), or ask the Keeper; material that is \`Update pending\` is organized ${whenOrganized}.`;

  // Header
  out.push(`# Context for ${request.recipient} · ${request.purpose === 'Work' && scope.focusThread ? `Work: ${scope.label}` : `Project: ${project.name}${scope.kind !== 'project' ? ` · ${scope.label}` : ''}`} · Kind: ${request.kind}`);
  out.push(`As of ${asOf ?? 'unknown'}. If the work, kind or recipient above is wrong, say so; the Keeper takes the correction.`, '');
  const asked = request.scope.ids[0];
  if (asked && (request.scope.kind === 'work' || request.scope.kind === 'area') && removed(asked)) out.push(`The ${request.scope.kind === 'work' ? 'work item' : 'area'} asked for, “${nameOf(store, asked)}” (\`${asked}\`), is history: it was ${removedWhen(asked, true)}. It has no context of its own; what follows is the start-of-work map.`, '');

  // The project's rules (Spec §1.15; CKC-21): in the start pack all of them, in a work pack those that bear on it.
  const rules = store.rules.all();
  const ruleHelp: RuleRowHelp = { cite: (ids) => cites.ref(ids), withoutOwner: (id) => { const m = withoutOwner(id); return m && checked(m) ? m : undefined; } };
  /** A note that waits for the owner's decision (§2.7): `For your decision`, and the owner has not settled it. */
  const waitsForOwner = (n: Note) => n.status === 'Current' && latest(n).ask === 'For your decision' && !['Decided', 'Delegated', 'No action needed'].includes(n.ownerResponse ?? '');

  const purposeItems = scope.references.filter((r) => PURPOSE_CATEGORIES.has(r.category) && current(r.validity)).sort((a, b) => (a.category === 'Product' ? 0 : 1) - (b.category === 'Product' ? 0 : 1));
  // The decisions that set the current direction, most recent first; the map's opening says how many there are in all.
  const decisions = store.reference.filter((r) => (r.category === 'Decision' || r.category === 'Boundary') && current(r.validity)).sort((a, b) => (b.asOf ?? '').localeCompare(a.asOf ?? ''));
  const plans = store.reference.filter((r) => r.category === 'Plan' && current(r.validity));
  const areas = [...scope.areaIds].map((id) => store.reference.get(id)).filter((r): r is ReferenceItem => r !== undefined);
  const inProgress = scope.threads.filter((t) => current(t.validity) && t.progress === 'In progress');

  const inScopeIds = new Set([...scope.references.map((r) => r.id), ...scope.threads.map((t) => t.id)]);
  const wholeProject = scope.kind === 'project';
  const onMapIds = new Set<string>();
  if (request.purpose === 'Start' || !scope.focusThread) {
    section('Purpose', purposeItems.map((g) => refLine(g)));
    const decisionsShown = decisions.slice(0, em.reference === 'full' ? 40 : 12);
    // What does not fit is named by name and id, never left out in silence (Spec §7.1; CKC-12 AC-31; QC AH #12).
    const decisionsLeft = decisions.slice(decisionsShown.length);
    section('Current direction', [
      ...decisionsShown.map((d) => refLine(d)),
      decisionsLeft.length ? `- Also in force, older — each in full with \`pk get <id>\`: ${decisionsLeft.map((d) => `${d.name} (\`${d.id}\`)`).join('; ')}` : '',
      inProgress.length ? `- In progress now: ${inProgress.map((t) => `${workTitle(t)} (\`${t.id}\`)`).join('; ')}` : '',
      roleRecipient ? `- For ${roleRecipient}: the items below that name this role, and the notes and requests addressed to it, come first.` : '',
    ]);
    // `How this project works` (Spec §7.3 item 3; CKC-21 AC-9): a fixed section, right after the current direction.
    section('How this project works', rulesLines(rules, ruleHelp, rulesOpening(rules, ruleHelp, rules.filter((r) => r.validity === 'Current' && r.category === 'Obsolete').length)));

    const PROGRESS_ORDER = ['In progress', 'Planned', 'On hold', 'Done'];
    const distribution = (threads: readonly WorkThread[]) => {
      const n = new Map<string, number>();
      for (const t of threads) n.set(t.progress, (n.get(t.progress) ?? 0) + 1);
      return [...n].sort((a, b) => PROGRESS_ORDER.indexOf(a[0]) - PROGRESS_ORDER.indexOf(b[0])).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none';
    };
    const areasOfThread = (t: WorkThread) => [...new Set(t.serves.map((x) => areaOf(store, x.referenceId)).filter((x): x is string => x !== null && !removed(x)))];
    const inScopeThreads = scope.threads.filter((t) => current(t.validity));
    const PROGRESS_RANK = (t: WorkThread) => PROGRESS_ORDER.indexOf(t.progress);

    // `Plan` (Spec §7.3 item 3; CKC-12 AC-18): the plans and milestones in the project's own order, each with how far
    // its work has got and what it waits on, told with the plan's own explanation, whole. A project with no plan
    // items has no such section.
    const planThreads = (p: ReferenceItem) => inScopeThreads.filter((t) => t.serves.some((s) => s.referenceId === p.id));
    const planOrder = (p: ReferenceItem) => `${p.ids[0] ?? p.name}`;
    const milestonesOf = (p: ReferenceItem) => plans.filter((x) => x.refines.includes(p.id));
    const topPlans = plans.filter((p) => !plans.some((x) => p.refines.includes(x.id))).sort((a, b) => planOrder(a).localeCompare(planOrder(b), undefined, { numeric: true }));
    const planLines: string[] = [];
    const planRow = (p: ReferenceItem, pad: string) => {
      const mine = planThreads(p);
      const done = mine.every((t) => t.progress === 'Done');
      const state = p.progress ?? (mine.length === 0 ? null : mine.some((t) => t.progress === 'In progress') ? 'In progress' : done ? 'Done' : 'Planned');
      // What a plan waits on, from the assets (Spec §7.3 item 4, `Waits on`): the work its own items depend on that is
      // not finished yet — never work that was removed — and, inside the plan, which later item waits on which; and the
      // owner's decisions its work is waiting for.
      const unfinished = (t: WorkThread | undefined): t is WorkThread => t !== undefined && !gone(t.id) && t.progress !== 'Done';
      const waits = [...new Set(mine.flatMap((t) => t.dependsOn.map((d) => d.threadId)))].map((id) => store.threads.get(id)).filter((t): t is WorkThread => unfinished(t) && !mine.some((x) => x.id === t.id));
      const inside = mine.filter((t) => t.progress !== 'Done').flatMap((t) => t.dependsOn.map((d) => store.threads.get(d.threadId)).filter((d): d is WorkThread => unfinished(d) && mine.some((x) => x.id === d.id)).map((d) => `${workTitle(t)} (\`${t.id}\`, ${t.progress}) waits on ${workTitle(d)} (\`${d.id}\`, ${d.progress})`));
      const forOwner = store.notes.filter((n) => waitsForOwner(n) && n.mount.ids.some((id) => id === p.id || mine.some((t) => t.id === id)));
      // Two records disagree (Spec §2.4): the plan's own record of how far it is, against its work items' records.
      const disagree = p.progress && mine.length && ((p.progress === 'Done' && !done) || (p.progress === 'Planned' && mine.some((t) => t.progress !== 'Planned')))
        ? [`the records disagree: the plan is recorded as ${p.progress}, and its work items are ${distribution(mine)}`] : [];
      const marks = [...refPending(p), ...markNotes(p.id), ...behindNotes(p.id), ...restsOnRemoved(p.id), ...disagree];
      planLines.push(`${pad}- **${p.name}**${p.ids.length ? ` (${p.ids.join(', ')})` : ''} · \`${p.id}\`${state ? ` · ${state}` : ''}${mine.length ? ` · work: ${distribution(mine)}` : ''}${p.basis === 'Inferred' ? ' · Inferred' : ''}${cites.ref(p.sourceIds)}${marks.length ? ` — ${marks.join('; ')}` : ''}`);
      if (text(p.text)) planLines.push(indent(p.text, `${pad}  `));
      const running = mine.filter((t) => t.progress === 'In progress');
      if (running.length) planLines.push(`${pad}  In progress here: ${running.map((t) => `${workTitle(t)} (\`${t.id}\`)`).join('; ')}.`);
      if (waits.length) planLines.push(`${pad}  Waits on: ${waits.map((t) => `${workTitle(t)} (\`${t.id}\`, ${t.progress})`).join('; ')}.`);
      if (inside.length) planLines.push(`${pad}  Inside this plan: ${inside.join('; ')}.`);
      if (forOwner.length) planLines.push(`${pad}  Waits on the owner: ${forOwner.map((n) => `the decision on “${oneLine(latest(n).title)}” (\`${n.id}\`)`).join('; ')}.`);
      for (const ms of milestonesOf(p).sort((a, b) => planOrder(a).localeCompare(planOrder(b), undefined, { numeric: true }))) planRow(ms, `${pad}  `);
    };
    for (const p of topPlans) planRow(p, '');
    section('Plan', planLines);

    // `Relevant work` is a map (D52; Spec §7.3; CKC-12 AC-18): one line per area with its area understanding, and the
    // work of the areas in focus one line each, from fixed fields of the assets. What the work is doing, its results
    // and its problems are in the work context, fetched by id. A work item serving several areas is listed once.
    const relevant: string[] = [];
    const planView = isOrchestrator || request.kind === 'Plan';
    const focusAreas = new Set([...inProgress.flatMap(areasOfThread), ...(scope.kind !== 'project' ? scope.areaIds : [])]);
    const paused = project.organizingPaused === true;
    const organizingRefs = new Set((coverage?.organizing ?? []).map((m) => m.ref));
    // The normal state (`Up to date`) is not written; only a scope that is behind says so (D59).
    const coverageOf = (pendingIds: readonly string[]) => {
      if (!pendingIds.length) return null;
      if (paused) return 'Organizing paused';
      return pendingIds.some((id) => { const a = store.sources.get(id)?.anchor; return a?.kind === 'file' && organizingRefs.has(a.path); }) ? 'Organizing' : 'Changes pending';
    };
    const workRow = (t: WorkThread) => {
      const areasHere = areasOfThread(t);
      const holder = t.attribution.holder?.role ?? (t.attribution.author.kind === 'role' ? t.attribution.author.name : null);
      const parts = [`**${workTitle(t)}**`, `\`${t.id}\``, t.progress];
      if (t.acceptance) parts.push(t.acceptance);
      if (holder) parts.push(`held by ${holder}`);
      if (areasHere.length > 1) parts.push(`serves ${areasHere.map(shortName).join(', ')}`);
      if (planView) {
        // The product effect each piece of work serves, with the claim, for whoever orchestrates (Spec §7.3, D11).
        const effects = t.serves.map((x) => `${shortName(x.referenceId)}${x.claim ? ` — ${oneLine(x.claim)}` : ''}`);
        parts.push(`effect: ${effects.length ? effects.join('; ') : 'not yet established'}`);
        if (t.dependsOn.length) parts.push(`depends on ${t.dependsOn.map((d) => `${shortName(d.threadId)} (\`${d.threadId}\`)`).join(', ')}`);
      }
      const marks = [...(t.pendingSourceIds.length ? [pendingMark(t.pendingSourceIds, t.waitsFor)] : []), ...markNotes(t.id), ...behindNotes(t.id), ...(undocumented(t.id) ? ['rests on a decision not yet written into the project documents'] : []), ...restsOnRemoved(t.id), ...twinNotes(t)];
      return `  - ${parts.join(' · ')}${marks.length ? ` — ${marks.join('; ')}` : ''}`;
    };
    const listedUnder = new Map<string, string>();
    const onMap = new Set<string>();
    const mapArea = (a: ReferenceItem | null, threads: readonly WorkThread[]) => {
      const u: AreaUnderstanding | undefined = a ? store.areas.find((x) => x.referenceId === a.id) : undefined;
      const goalsServed = a ? a.refines.map((id) => store.reference.get(id)).filter((r): r is ReferenceItem => r?.category === 'Goal').map((r) => r.name) : [];
      const pendingIds = [...new Set([...(u?.pendingSourceIds ?? []), ...(a?.pendingSourceIds ?? []), ...threads.flatMap((t) => t.pendingSourceIds)])];
      const cover = coverageOf(pendingIds);
      // The area's own item and its understanding wait together: one mark, each change named once.
      const areaIds = [...new Set([...(u?.pendingSourceIds ?? []), ...(a?.pendingSourceIds ?? [])])];
      const areaWaits = [...new Map([...(u?.waitsFor ?? []), ...(a?.waitsFor ?? [])].map((w) => [w.ref, w])).values()];
      const areaMarks = a ? [...(areaIds.length ? [pendingMark(areaIds, areaWaits)] : []), ...markNotes(a.id), ...behindNotes(a.id), ...restsOnRemoved(a.id)] : [];
      relevant.push(`- **${a ? a.name : 'Not under any area'}**${a ? ` · \`${a.id}\`` : ''}${goalsServed.length ? ` · serves ${goalsServed.join('; ')}` : ''} · work: ${distribution(threads)}${cover ? ` · ${cover}` : ''}${a?.basis === 'Inferred' ? ' · Inferred' : ''}${areaMarks.length ? ` — ${areaMarks.join('; ')}` : ''}`);
      // Every area carries its area understanding — what it does now and what is still missing — as the assets write
      // it, whole (Spec §7.3; CKC-12 AC-18). Before D59 the map carried none of it: 26,000 characters of area
      // explanation never reached the agent (D58).
      if (u && text(u.effectNow)) relevant.push(indent(`Now: ${u.effectNow}`, '  '));
      if (u && text(u.gaps)) relevant.push(indent(`Still missing: ${u.gaps}`, '  '));
      if (a) onMap.add(a.id);
      const expanded = a ? focusAreas.has(a.id) : threads.some((t) => t.progress === 'In progress');
      if (!expanded) {
        if (a && threads.length) relevant.push(indent(`Its work is not listed here; \`pk get ${a.id}\` gives this area's context with every work item in it.`, '  '));
        return;
      }
      const elsewhere: WorkThread[] = [];
      for (const t of threads) {
        if (listedUnder.has(t.id)) { elsewhere.push(t); continue; }
        listedUnder.set(t.id, a ? shortName(a.id) : 'Not under any area');
        onMap.add(t.id);
        relevant.push(workRow(t));
      }
      if (elsewhere.length) relevant.push(`  - Also in this area, listed above: ${elsewhere.map((t) => `${workTitle(t)} (\`${t.id}\`, under ${listedUnder.get(t.id)})`).join('; ')}`);
    };
    for (const a of areas) mapArea(a, inScopeThreads.filter((t) => areasOfThread(t).includes(a.id)).sort((x, y) => PROGRESS_RANK(x) - PROGRESS_RANK(y)));
    const unplaced = inScopeThreads.filter((t) => areasOfThread(t).length === 0 || (areas.length > 0 && !areasOfThread(t).some((id) => scope.areaIds.has(id)) && scope.kind === 'project'));
    if (unplaced.length) mapArea(null, unplaced.sort((x, y) => PROGRESS_RANK(x) - PROGRESS_RANK(y)));
    for (const id of onMap) onMapIds.add(id);
    if (relevant.some((l) => / — .*(Update pending|Suspected stale|Layer drift|Scope question)/.test(l))) relevant.unshift(`- ${markLegend}`);
    // The map says first what the assets hold and how much of it is here, so an agent knows whether this pack is
    // complete without fetching every object to find out (D59; 2026-09-18: a subagent fetched the lot and built its
    // own index, 46 minutes).
    const allAreas = store.reference.filter((r) => r.category === 'Area' && current(r.validity)).length;
    const allWork = store.threads.filter((t) => current(t.validity)).length;
    // Marks on what was removed, or on history, are not counted: a mark judges current content, and those are history (AC-35).
    const inScopeMarks = store.marks.filter((m) => !m.closed && m.kind !== 'Undocumented decision' && !gone(m.targetId) && (wholeProject || inScopeIds.has(m.targetId)));
    // Every mark that says what differs and names what it was checked against is written somewhere in this pack: on
    // the row of its object, in `Do not revive` for a disposal, in `Pending owner decisions` for a rule a role set in
    // the owner's place, or in `Freshness` when its object is not on this map.
    const writtenMarks = inScopeMarks.filter((m) => checked(m) && !onAnotherJudgement(m.targetId));
    const inForce = rules.filter((r) => r.validity === 'Current');
    const obsoleteRules = inForce.filter((r) => r.category === 'Obsolete').length;
    const replacedRules = rules.filter((r) => r.validity === 'Replaced').length;
    const allWords = store.reference.filter((r) => r.category === OWNER_WORDS && r.validity === 'Current');
    const wordsInPurpose = new Set(purposeItems.flatMap((r) => ownerWordsUnder(r).map((w) => w.id)));
    const inventory = [
      'This pack against what the assets hold:',
      `- Areas: ${areas.length} of ${allAreas} listed below, each with its area understanding.`,
      `- Work items: ${listedUnder.size} of ${allWork} listed — the work of the areas in focus. \`pk get <area id>\` gives an area's context with every work item in it; \`pk options\` lists them all with their ids.`,
      plans.length ? `- Plans and milestones: ${planLines.length ? plans.length : 0} of ${plans.length} in \`Plan\` above.` : '',
      decisions.length ? `- Decisions and boundaries: ${decisionsShown.length} of ${decisions.length} in \`Current direction\` above, most recent first${decisionsShown.length < decisions.length ? '; the others are named at its end, each by id for `pk get`' : ''}.` : '',
      allWords.length ? `- Owner’s words: ${wordsInPurpose.size} of ${allWords.length} in \`Purpose\` above — what the product and its goals rest on; the others come with the work they bear on, first in its work context (\`pk context --work <id>\`).` : '',
      inForce.length || replacedRules ? `- Project rules: ${inForce.length - obsoleteRules} in \`How this project works\` above${obsoleteRules ? `, ${obsoleteRules} obsolete in \`Do not revive\`` : ''}${replacedRules ? `; ${replacedRules} replaced by newer rules and not given` : ''}.` : '',
      `- Entry marks: ${writtenMarks.length} of ${inScopeMarks.length} open marks are written into this pack — ${shownMarkIds.size} on the row of the object they belong to, the rest in \`Freshness\`, \`Do not revive\` or \`Pending owner decisions\`. The others say neither what differs nor what they were checked against, so they stay in the assets (\`pk get <mark id>\` reads one).`,
      `- Normal states are not written: a row with no mark carries nothing the Keeper has found wrong with it.${asOf ? ` All of this is as of ${asOf}.` : ''}`,
    ].filter((l) => l.length);
    relevant.unshift(...inventory);
    section('Relevant work', relevant);
    const who = inProgress.filter((t) => t.attribution.holder || (t.attribution.author.kind === 'role' && t.attribution.author.name)).map((t) => `- ${workTitle(t)} (\`${t.id}\`): ${t.attribution.holder?.role ?? t.attribution.author.name}${t.attribution.holder?.window ? ` (${t.attribution.holder.window})` : ''}`);
    section('Who is doing what', who);
  }

  /**
   * What of a change record is a change in force: not an item written only from material that exists in history — that
   * is lineage, given in `How it got here` where it bears on the work (CKC-12 AC-35). An item about what was removed is a
   * change like any other (the deletion happened); what it removed is named as removed where the item lists what it
   * affects.
   */
  const fromHistoryOnly = (it: ChangeItem) => { const sources = it.sourceIds.filter((id) => store.sources.has(id)); return sources.length > 0 && sources.every(historyOnly); };
  const visibleItems = (c: ChangeRecord): ChangeItem[] => itemsOf(c).filter((it) => !fromHistoryOnly(it));
  /** The change items this pack gives as history in `How it got here`: they are not listed again as changes in force. */
  const inLineage = new Set<string>();

  /**
   * `How it got here` (Spec §2.11, §7.1; CKC-12 AC-35): how the work got here, oldest first — the ledger's lineage of the
   * object itself, and from the assets what on its way is history now: the removed objects it rests on, and the changes
   * that reached it and were since superseded, written only from history, or overtaken. Every step that is history says
   * so, with when and what replaced it or why it went; none of it is current content.
   */
  const lineageLines = (focusId: string, onTheWay: ReadonlySet<string>, removedHere: readonly { id: string; clause: string }[]): string[] => {
    const steps: { at: string | null; line: string }[] = [];
    const lin = ledgerLineage(ledger, store, focusId);
    for (const s of lin.steps) {
      const when = s.occurred.undated ? `Undated · first seen ${dayOf(s.occurred.at) ?? s.occurred.at}` : dayOf(s.occurred.at) ?? s.occurred.at;
      steps.push({ at: s.occurred.at, line: `- ${when} · ${s.history ? 'History · ' : ''}${s.kind} · ${oneLine(s.title)}` });
    }
    for (const x of removedHere) {
      const r = removalOf(store, x.id);
      steps.push({ at: r?.at ?? null, line: `- ${r ? dayOf(r.at) ?? r.at : 'Undated'} · History · Removed · “${nameOf(store, x.id)}” (\`${x.id}\`), ${x.clause}: ${removedWhen(x.id, false)}` });
    }
    for (const h of historyChanges(store, onTheWay)) {
      steps.push({ at: h.item.at, line: historyChangeLine(h) });
      inLineage.add(`${h.change.id}|${h.item.id}`);
    }
    if (!steps.length && !lin.error) return [];
    steps.sort((a, b) => (a.at === null ? 1 : 0) - (b.at === null ? 1 : 0) || (a.at ?? '').localeCompare(b.at ?? ''));
    return [
      `Oldest first. A step marked History is not current: it lies only in history — an old version, a deleted document, a side branch, material kept for recovery — or it was removed from the current version or superseded; it says when, and what replaced it or why it went.${ledger ? '' : ' The project has no ledger yet, so the steps are what the assets record.'}`,
      ...steps.map((s) => s.line),
      ...(lin.error ? [`- The ledger could not be read for this lineage (${oneLine(lin.error)}); the steps above are what the assets record.`] : []),
    ];
  };
  /** One change on the way that is history now, with why and, when superseded, by what. */
  const historyChangeLine = (h: HistoryChange): string => {
    const it = h.item;
    const head = `- ${dayOf(it.at) ?? 'Undated'} · History · ${it.effect} · ${oneLine(it.title)} (\`${h.change.id}\`, ${decidedBy(it.by, undefined).phrase})`;
    const why = h.why;
    if (why.kind === 'superseded') {
      const by = why.byChangeId ? store.changes.get(why.byChangeId) : undefined;
      const byItem = by ? itemsOf(by).find((x) => x.affects.some((id) => it.affects.includes(id))) ?? itemsOf(by)[0] : undefined;
      return `${head} — superseded${by ? ` on ${dayOf(byItem?.at ?? by.at) ?? by.at} by “${oneLine(byItem?.title ?? by.title)}” (\`${by.id}\`)` : ' by a later change'}${text(why.reason) ? `: ${oneLine(why.reason)}` : ''}${cites.ref(it.sourceIds)}`;
    }
    if (why.kind === 'history only') return `${head} — recorded only from material that exists in history${cites.ref(it.sourceIds)}`;
    const states = it.affects.map((id) => `${nameOf(store, id)} (\`${id}\`) ${(store.reference.get(id)?.validity ?? store.threads.get(id)?.validity ?? store.nodes.get(id)?.validity ?? '').toLowerCase()}`);
    return `${head} — what it set down has since been replaced, given up or removed: ${states.join('; ')}${cites.ref(it.sourceIds)}`;
  };
  // An area's context (Spec §7.4: the area first, then its work) carries the area's lineage: the area item's own, and
  // what is history among the requirements, designs and work in it — the removed ones among them included.
  if (request.purpose === 'Work' && !scope.focusThread && scope.kind === 'area') {
    const areaId = [...scope.areaIds][0];
    if (areaId) {
      const inArea = new Set<string>([areaId, ...scope.references.filter((r) => !PURPOSE_CATEGORIES.has(r.category)).map((r) => r.id), ...scope.threads.map((x) => x.id)]);
      const partOf = [
        ...store.reference.filter((r) => removed(r.id) && (r.refines.some((id) => inArea.has(id)) || areaOf(store, r.id) === areaId)).map((r) => ({ id: r.id, clause: `which was part of ${nameOf(store, areaId)}` })),
        ...store.threads.filter((x) => removed(x.id) && x.serves.some((s) => inArea.has(s.referenceId))).map((x) => ({ id: x.id, clause: `which served ${x.serves.filter((s) => inArea.has(s.referenceId)).map((s) => nameOf(store, s.referenceId)).join(', ')}` })),
        ...[...inArea].flatMap((id) => removedUnder(id).map((x) => ({ id: x.id, clause: `which ${nameOf(store, id)} (\`${id}\`) ${x.how}` }))),
      ].filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i);
      section('How it got here', lineageLines(areaId, inArea, partOf));
    }
  }
  /** A document by its place in the project: `docs/PLAN.md › P2` (who wrote what a work item rests on, Spec §7.4 item 1). */
  const docName = (s: Source) => s.anchor.kind === 'file' ? `${fileLocation(project, s).file}${s.anchor.headingPath.length ? ` › ${s.anchor.headingPath.join(' › ')}` : ''}` : s.anchor.kind === 'session' ? `a ${s.anchor.host} session${s.anchor.at ? ` on ${dayOf(s.anchor.at)}` : ''}` : anchorLabel(s.anchor);
  const writtenBy = (r: ReferenceItem) => r.attribution?.author?.kind === 'owner' ? 'the owner' : r.attribution?.author?.name ?? r.attribution?.holder?.role ?? (r.attribution?.author?.kind === 'agent' ? r.attribution.author.host ?? 'an agent' : 'an author the records do not name');
  /** Where a source is, for `Code entry and recent changes`: a code file by repository, file, lines and commit (D65). */
  const locate = (s: Source) => {
    if (s.anchor.kind !== 'file') return anchorLabel(s.anchor);
    const loc = fileLocation(project, s);
    return isCodeSource(s) ? locationText(loc) : `${loc.repo ? `${loc.repo} · ` : ''}${docName(s)}, ${loc.lines}`;
  };
  const codeSourceOf = (ids: readonly string[]) => ids.map((id) => store.sources.get(id)).find((x): x is Source => x !== undefined && isCodeSource(x));

  // A pack for one work item or one area carries only the project-wide entries that bear on it; the rest are in the
  // start pack (Spec §7.4 item 11; CKC-12 AC-33). What bears on a work item is its own scope and everything on its way
  // up to the owner's words: the decisions it carries out, the rules that apply to it, what its adjustments changed.
  const scopeWords = wholeProject ? [] : [...new Set([...scope.threads.flatMap((t) => [t.id, ...t.ids, t.title]), ...[...scope.areaIds].flatMap((id) => { const r = store.reference.get(id); return r ? [r.id, ...r.ids, r.name] : [id]; })])].filter((w) => w.length > 2);
  /** Does a project-wide entry bear on this scope? It names one of the objects in it, or it is mounted on one. */
  const relatedText = (s: string) => scopeWords.some((w) => s.includes(w));
  const relatedIds = new Set(inScopeIds);
  let workFacts: WorkFacts | null = null;

  if (request.purpose === 'Work' && scope.focusThread) {
    const t = scope.focusThread;

    // ── `Owner's words` (D66; Spec §7.1, §7.4 item 1; CKC-12 AC-4, AC-40–AC-42) ──
    // What the owner said that this work traces up to, word for word, then what was adjusted on the way and by whom.
    // Where nothing traces to the owner, the section says so and names the documents the work rests on, and who wrote
    // them, so the agent knows it is following others' accounts.
    const trace = traceOwnerWords(store, t, { scopeWords, checked });
    for (const id of trace.related) relatedIds.add(id);
    const full = em.ownerWords !== 'brief';
    const ow: string[] = [];
    if (trace.words.length && full) {
      ow.push('What the owner said that this work traces up to, word for word:');
      for (const w of trace.words) {
        const label = w.item.category === OWNER_WORDS ? (w.item.ids.length ? `${w.item.ids.join(', ')} · ` : '') : `${w.item.name} · `;
        ow.push(`- ${label}\`${w.item.id}\` · the owner${w.saidOn ? `, ${w.saidOn}` : ''}${cites.ref(w.item.sourceIds)}:\n${quoteBlock(w.quote, '  ')}${w.item.answers ? `\n  In answer to: ${quoteBlock(w.item.answers, '  ').trimStart()}` : ''}`);
      }
    } else if (trace.words.length) {
      ow.push('What the owner said that this work traces up to; the words themselves: `pk get <id>`:');
      for (const w of trace.words) ow.push(`- ${w.item.name} (\`${w.item.id}\`${w.saidOn ? `, said ${w.saidOn}` : ''})`);
    } else {
      const docs = trace.path.map((r) => {
        const where = [...new Set(r.sourceIds.map((id) => store.sources.get(id)).filter((s): s is Source => s !== undefined && !historyOnly(s.id)).map(docName))];
        return `${r.name} (\`${r.id}\`)${where.length ? ` from ${where.join(', ')}` : ''}, written by ${writtenBy(r)}${cites.ref(r.sourceIds)}`;
      });
      ow.push(`Not traced to the owner’s words: this work rests on ${docs.length ? docs.join('; ') : 'no product description in the assets'}. What it follows was written by others, not said by the owner.`);
    }
    for (const m of trace.drift) {
      shownMarkIds.add(m.id);
      ow.push(`- Layer drift (\`${m.id}\`) on ${nameOf(store, m.targetId)} (\`${m.targetId}\`): ${oneLine(m.clue)}${cites.ref(m.clueSourceIds)} — what this work serves departs from the owner’s words here.`);
    }
    if (trace.adjustments.length) {
      ow.push(full ? 'Adjustments along the way, oldest first:' : 'Adjustments along the way, oldest first; each by id with `pk get`:');
      for (const a of trace.adjustments) {
        const id = a.changeId ?? a.refId;
        if (!full) { ow.push(`- ${a.on ?? 'undated'} · ${a.title} (\`${id}\`) — ${a.decidedBy}`); continue; }
        const what = [a.material, a.effect].filter((x) => x).join(' · ');
        ow.push(`- ${a.on ?? 'undated'}${what ? ` · ${what}` : ''}: ${a.title} (\`${id}\`) — ${a.decidedBy} — why: ${a.why ?? 'the material gives no reason'}${cites.ref(a.sourceIds)}`);
        if (a.summary && a.summary !== a.title) ow.push(indent(a.summary, '  '));
        if (a.before || a.after) ow.push(`  Before: ${oneLine(a.before) || '—'} → after: ${oneLine(a.after) || '—'}`);
      }
    }
    section("Owner's words", ow);

    // ── `Serves`: the Keeper's own summary of the effect, after the owner's words ──
    const servesLines = t.serves.map((s) => {
      if (removed(s.referenceId)) return `- It ${restsOnRemovedText(s.referenceId)}`;
      const r = store.reference.get(s.referenceId);
      const pending = r ? refPending(r) : [];
      return r ? `- ${r.name} (\`${r.id}\`${r.category !== 'Area' ? ` · ${r.category}` : ''}): ${oneLine(s.claim)}${s.basis === 'Inferred' ? ' · Inferred' : ''}${cites.ref(r.sourceIds)}${pending.length ? ` — ${pending.join('; ')}` : ''}` : '';
    });
    if (t.serves.length === 0) servesLines.push('- Not yet established: which product effect this work serves; no material names it. To know it, ask the owner or check the plan that introduced it.');
    const whyNow = store.changes.filter((c) => visibleItems(c).length > 0 && (c.affects.includes(t.id) || t.serves.some((s) => !removed(s.referenceId) && c.affects.includes(s.referenceId)))).sort((a, b) => b.at.localeCompare(a.at))[0];
    if (whyNow) servesLines.push(`- Why now: ${whyNow.effect} — ${oneLine(whyNow.summary)}${cites.ref(whyNow.sourceIds)}`);
    section('Serves', em.serves === 'skip' ? [] : servesLines);
    const rel: string[] = [];
    for (const s of t.serves) {
      if (removed(s.referenceId)) { rel.push(`- **${t.title}** ${restsOnRemovedText(s.referenceId)}`); continue; }
      const found = areaOf(store, s.referenceId);
      const a = found && !removed(found) ? found : null;
      const areaGoals = a ? (store.reference.get(a)?.refines ?? []).map((id) => store.reference.get(id)).filter((r): r is ReferenceItem => r?.category === 'Goal' && !removed(r.id)) : [];
      rel.push(`- ${areaGoals.length ? `${areaGoals.map((g) => g.name).join(' / ')} → ` : ''}${a && a !== s.referenceId ? `${nameOf(store, a)} → ` : ''}${nameOf(store, s.referenceId)} → **${t.title}**`);
    }
    for (const d of t.dependsOn) rel.push(removed(d.threadId) ? `- ${t.title} ${restsOnRemovedText(d.threadId)}` : `- ${t.title} depends on ${nameOf(store, d.threadId)} (\`${d.threadId}\`): ${oneLine(d.claim)}${d.basis === 'Inferred' ? ' · Inferred' : ''}`);
    // Only a questioned assessment is written; `Holds` and `Not assessed` are the normal states and stay in the assets (D59).
    for (const r of store.relations.filter((x) => x.to === t.id && !gone(x.from) && (x.type === 'implements' || x.type === 'verifies' || x.type === 'produced'))) rel.push(`- ${nameOf(store, r.from)} ${r.type} ${t.title}${r.assessment === 'Questioned' ? ' · Questioned' : ''}: ${oneLine(r.evidence.factsSoFar || r.claim)}${cites.ref(r.evidence.sourceIds)}`);
    // Shared only where an area is: what has no area (a plan, a goal) is not a common area of two work items.
    const areasServed = new Set(t.serves.map((y) => areaOf(store, y.referenceId)).filter((a): a is string => a !== null && !removed(a)));
    const shared = store.threads.filter((x) => x.id !== t.id && !gone(x.id) && x.serves.length > 1 && x.serves.some((s) => { const a = areaOf(store, s.referenceId); return a !== null && areasServed.has(a); }));
    for (const x of shared.slice(0, 5)) rel.push(`- Shared foundation: ${x.title} (\`${x.id}\`) serves ${x.serves.filter((s) => !removed(s.referenceId)).map((s) => nameOf(store, s.referenceId)).join(', ')} (${x.progress})`);
    // Where a kind asks for the brief form, the lines that are left out are counted, not dropped in silence: an agent
    // has to be able to tell whether what it holds is all of it (D59).
    const capped = (lines: string[], n: number, what: string) => (lines.length > n ? [...lines.slice(0, n), `- ${lines.length - n} further ${what} are in the assets; \`pk get ${t.id}\` with \`--kind Implement\` gives them all.`] : lines);
    section('Relation map', em.relation === 'skip' ? [] : em.relation === 'brief' ? capped(rel, 4, 'relations') : rel);
    // What is on its way — the same objects `Adjustments along the way` reads — and the removed objects this work or
    // anything on its way rests on.
    const onTheWay = new Set<string>([t.id, ...trace.path.map((r) => r.id), ...trace.words.map((w) => w.item.id), ...trace.replacedWords.map((r) => r.id)]);
    const removedHere = [
      ...removedUnder(t.id).map((x) => ({ id: x.id, clause: `which this work ${x.how}` })),
      ...trace.path.flatMap((r) => removedUnder(r.id).map((x) => ({ id: x.id, clause: `which ${r.name} (\`${r.id}\`) ${x.how}` }))),
    ].filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i);
    section('How it got here', lineageLines(t.id, onTheWay, removedHere));
    const boundaries = store.reference.filter((r) => r.category === 'Boundary' && current(r.validity));
    // The work context is where the detail belongs (D52), and what goes in goes in whole (AC-31): a cut `Done means`
    // hid exactly the open conditions from an agent in the 2026-09-18 trial (D16, D31: no length caps).
    section('Done means', em.done === 'skip' || !t.doneMeans ? [] : [`- ${oneLine(t.doneMeans)}`]);
    // Owner acceptance is its own fact (D41): work that is finished but not accepted still belongs in the context,
    // said plainly, so whoever takes over knows the result exists and knows the owner has not signed it off (CKC-12 AC-19).
    section('Owner acceptance', em.done === 'skip' || !t.acceptance ? [] : [`- ${t.acceptance}${t.acceptanceMeans ? `: ${oneLine(t.acceptanceMeans)}` : ''}`]);
    section('Not included', em.done === 'skip' ? [] : boundaries.map((b) => refLine(b)));
    // A decision this work carries out is a result, not a to-do (Spec §2.2; CKC-12 AC-38): carried out says so; partly
    // carried out says what is left; one not carried out yet is still open.
    const carries = store.reference.filter((r) => !gone(r.id) && r.carryOut?.workIds.includes(t.id) === true);
    const carried = carries.filter((r) => r.carryOut!.status !== 'Not carried out yet').map((r) => {
      const c = r.carryOut!;
      const state = c.status === 'Carried out' ? 'carried out' : `partly carried out; still left: ${oneLine(c.remaining) || 'not recorded'}`;
      const disagree = c.status === 'Carried out' && t.progress === 'Planned' ? ' — the records disagree: this work is Planned' : '';
      return `- Carries out ${r.name} (\`${r.id}\`): ${state}${disagree}${cites.ref(c.evidenceSourceIds)}`;
    });
    section('Existing results', em.results === 'skip' ? [] : [t.results ? `- ${oneLine(t.results)}${t.acceptance === 'Not yet accepted' ? ' (Not yet accepted by the owner)' : ''}` : '', ...carried]);

    // ── What was reported, and what checking the code found (D63; Spec §2.4; CKC-12 AC-36) ──
    // A claim is said as reported — who and when — never as a fact. Where reading the code showed otherwise, the claim's
    // own row says what the code does. The check is tied to the claim it answers: the relation quotes the claim, or the
    // claim is the only one resting on the material the check names.
    const stmts = [...t.executionFacts, ...t.qcFacts];
    const ownSources = new Set(stmts.flatMap((s) => s.sourceIds));
    const contradictions = store.relations.filter((r) => r.type === 'contradicts' && !gone(r.from) && !gone(r.to) && [r.from, r.to].some((id) => id === t.id || t.factRecordIds.includes(id) || ownSources.has(id)));
    const claims = stmts.filter((s) => s.type === 'Claimed');
    const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const answers = (r: (typeof contradictions)[number], s: Statement) => {
      if (squash(s.text).length && squash(r.claim).includes(squash(s.text))) return true;
      const named = [...r.evidence.sourceIds, r.from, r.to].filter((id) => s.sourceIds.includes(id));
      return named.length > 0 && claims.filter((x) => x.sourceIds.some((id) => named.includes(id))).length === 1;
    };
    const heldAgainst = new Map<Statement, typeof contradictions>();
    for (const r of contradictions) for (const s of claims) if (answers(r, s)) heldAgainst.set(s, [...(heldAgainst.get(s) ?? []), r]);
    const answered = new Set([...heldAgainst.values()].flat().map((r) => r.id));
    const reported = (s: Statement) => (s.claimedBy ? `${reportedBy(s.claimedBy, 'UTC')}${s.claimedBy.untrustedRuleId ? ` (a source the project marks untrusted, \`${s.claimedBy.untrustedRuleId}\`)` : ''}` : 'Reported (who and when are not recorded)');
    const doesNotHold = (s: Statement) => (heldAgainst.get(s) ?? []).map((r) => ` — does not hold in the code: ${oneLine(r.claim)}${cites.ref(r.evidence.sourceIds)}`).join('');
    const known = stmts.map((s) => {
      if (s.type === 'Claimed') return `- ${reported(s)}: ${oneLine(s.text)}${cites.ref(s.sourceIds)}${doesNotHold(s)}`;
      const code = s.type === 'Observed' ? codeSourceOf(s.sourceIds) : undefined;
      if (code) return `- Observed in the code (${shortLocationText(fileLocation(project, code))}): ${oneLine(s.text)}${cites.ref(s.sourceIds)}`;
      return `- ${s.type}: ${oneLine(s.text)}${cites.ref(s.sourceIds)}`;
    });
    for (const r of contradictions.filter((x) => !answered.has(x.id))) known.push(`- Checked against the code, and what was reported does not hold: ${oneLine(r.claim)}${cites.ref(r.evidence.sourceIds)}`);
    if (t.changed && em.failures === 'full') known.unshift(`- Changed on the way: ${oneLine(t.changed)}`);
    section('Known results & failures', em.failures === 'skip' ? [] : em.failures === 'full' ? known : capped(known, 6, 'recorded results and failures'));
    const twin = twinText(t);
    const openLines = [
      t.unresolved ? `- ${oneLine(t.unresolved)}` : '',
      ...t.factRecordIds.flatMap((f) => (store.facts.get(f)?.openQuestions ?? []).map((q) => `- ${oneLine(q)}`)),
      ...carries.filter((r) => r.carryOut!.status === 'Not carried out yet').map((r) => `- ${r.name} (\`${r.id}\`) asks for something this work carries out; not carried out yet.`),
      ...(twin ? [`- The records disagree on this work: ${twin}; this one says ${t.progress}.`] : []),
    ];
    section('Open problems', em.open === 'skip' ? [] : em.open === 'full' ? openLines : capped(openLines.filter((l) => l.length), 5, 'open problems'));
    if (request.taskVersion) section('Version check', versionCheck(store, t, scope.references, request.taskVersion, cites));

    // ── `Code entry and recent changes` (D65; Spec §7.1, §7.4 item 9; CKC-12 AC-4, AC-43) ──
    // Where the code is, what changed in it lately and why, and what checking the reports about it found. No code: the
    // agent opens the current version itself.
    const where: string[] = [];
    const listed = new Set<string>();
    for (const r of store.relations.filter((x) => x.to === t.id && (x.type === 'implements' || x.type === 'verifies') && !gone(x.from))) {
      const s = store.sources.get(r.from);
      if (!s || listed.has(s.id)) continue;
      listed.add(s.id);
      where.push(`- ${locate(s)} — ${r.type} this work${text(r.claim) ? `: ${oneLine(r.claim)}` : ''}${cites.ref([s.id])}`);
    }
    const readToCheck = [...contradictions.flatMap((r) => [r.from, r.to, ...r.evidence.sourceIds]), ...stmts.filter((s) => s.type === 'Observed').flatMap((s) => s.sourceIds)]
      .map((id) => store.sources.get(id)).filter((s): s is Source => s !== undefined && isCodeSource(s) && !gone(s.id));
    for (const s of readToCheck) { if (listed.has(s.id)) continue; listed.add(s.id); where.push(`- ${locate(s)} — read to check what was reported about this work${cites.ref([s.id])}`); }
    const changedHere = store.changes.all().flatMap((c) => visibleItems(c).filter((it) => it.affects.includes(t.id)).map((it) => ({ c, it })));
    const commitIds = [...new Set([...changedHere.flatMap(({ it }) => it.sourceIds), ...ownSources, ...t.factRecordIds.flatMap((f) => store.facts.get(f)?.aboutSourceIds ?? []), ...store.relations.filter((x) => x.to === t.id && x.type === 'implements').map((x) => x.from)])]
      .filter((id) => store.sources.get(id)?.anchor.kind === 'commit' && !gone(id));
    const commitLines = commitIds.map((id) => store.sources.get(id)!).map((s) => ({ s, f: commitFacts(s), at: commitFacts(s).at ?? s.version.readAt }))
      .sort((a, b) => b.at.localeCompare(a.at))
      .map(({ s, f }) => `- commit ${s.anchor.kind === 'commit' ? s.anchor.commit.slice(0, 10) : s.id}${f.at ? ` · ${dayOf(f.at)}` : ''} · ${oneLine(f.subject)}${f.files.length ? ` — files: ${f.files.join(', ')}` : ''}${cites.ref([s.id])}`);
    const codeChanges = changedHere.filter(({ it }) => it.material === 'Code change').sort((a, b) => b.it.at.localeCompare(a.it.at))
      .map(({ c, it }) => `- ${dayOf(it.at) ?? 'undated'} · ${oneLine(it.title)} (\`${c.id}\`) — why: ${text(it.why) || 'the material gives no reason'}${cites.ref(it.sourceIds)}`);
    const checks: string[] = [];
    for (const s of claims) for (const r of heldAgainst.get(s) ?? []) checks.push(`- ${reported(s)}: “${oneLine(s.text)}” — does not hold in the code: ${oneLine(r.claim)}${cites.ref(r.evidence.sourceIds)}`);
    for (const r of contradictions.filter((x) => !answered.has(x.id))) checks.push(`- Checked against the code, and what was reported does not hold: ${oneLine(r.claim)}${cites.ref(r.evidence.sourceIds)}`);
    for (const s of stmts.filter((x) => x.type === 'Observed')) { const code = codeSourceOf(s.sourceIds); if (code) checks.push(`- Checked in the code: ${oneLine(s.text)} (${shortLocationText(fileLocation(project, code))})${cites.ref(s.sourceIds)}`); }
    const unchecked = claims.filter((s) => !heldAgainst.has(s)).length;
    if (unchecked) checks.push(`- ${unchecked} more report${unchecked === 1 ? '' : 's'} about this work ${unchecked === 1 ? 'is' : 'are'} given as reported in \`Known results & failures\`; nothing records ${unchecked === 1 ? 'it' : 'them'} being checked against the code.`);
    section('Code entry and recent changes', em.code === 'skip' ? [] : [
      ...(where.length ? [`Where the code is — ${OPEN_CURRENT}`, ...where] : []),
      ...(em.code === 'full' && (commitLines.length || codeChanges.length) ? ['Recent changes, latest first:', ...commitLines, ...codeChanges] : []),
      ...(checks.length ? ['What was reported about the code, and what checking it found:', ...checks] : []),
    ]);

    // ── `How this project works` for this work (Spec §7.4 item 10; CKC-21 AC-10; CKC-12 AC-39) ──
    const restsOn = [...ownSources, ...t.factRecordIds.flatMap((f) => store.facts.get(f)?.aboutSourceIds ?? []), ...store.relations.filter((x) => x.to === t.id).map((x) => x.from), ...t.pendingSourceIds, ...trace.path.flatMap((r) => r.sourceIds)];
    const holder = t.attribution.holder?.role ?? (t.attribution.author.kind === 'role' ? t.attribution.author.name : null);
    workFacts = {
      words: [...scopeWords, ...trace.path.flatMap((r) => [r.name, ...r.ids])],
      roles: [holder, request.recipient].filter((x): x is string => typeof x === 'string' && x.length > 0),
      kind: request.kind,
      paths: [...new Set(restsOn.map((id) => store.sources.get(id)?.anchor).filter((a) => a?.kind === 'file').map((a) => pathKey((a as { path: string }).path).replace(/\\/g, '/').toLowerCase()))],
      decidedBy: new Set([t.validityByRuleId, t.progressByRuleId, ...trace.path.map((r) => r.validityByRuleId), ...restsOn.map((id) => store.sources.get(id)?.usedAsByRuleId), ...stmts.map((s) => s.claimedBy?.untrustedRuleId)].filter((x): x is string => typeof x === 'string' && x.length > 0)),
      knownRoles: project.roles,
      workNumbers: new Set(store.threads.all().flatMap((x) => x.ids.map((n) => n.toUpperCase()))),
    };
    const facts = workFacts;
    const bearing = rules.filter((r) => ruleBearsOnWork(r, facts));
    for (const r of bearing) relatedIds.add(r.id);
    section('How this project works', rulesLines(bearing, ruleHelp, 'The project’s rules that bear on this work; all of them are in the start pack’s `How this project works`, each in full with `pk get <rule id>`.'));
  }

  // Changes since last session / recent (§7.3 item 6, §7.8). Each item says what changed and why, as the material
  // states it, whole (D59): before D59 the summary was cut at 200 characters and the reason fell off the end.
  const since = request.lastSessionAt;
  // Outside the start pack only what bears on this work or scope is listed, the rest of the project's changes are in
  // the start pack (Spec §7.4 item 11; §7.1: Review takes the changes since the last review, Investigate the recent
  // related ones); an item a later change superseded for it is no longer a change in force (§7.1 grading).
  const supersededHere = new Set(wholeProject ? [] : store.propagation.filter((j) => relatedIds.has(j.nodeId)).flatMap((j) => j.closed.filter((x) => x.close === 'Superseded by a later change').map((x) => `${x.changeId}|${x.itemId}`)));
  const shownItems = (c: ChangeRecord): ChangeItem[] => visibleItems(c).filter((it) => wholeProject || (it.affects.some((id) => relatedIds.has(id)) && !supersededHere.has(`${c.id}|${it.id}`) && !inLineage.has(`${c.id}|${it.id}`)));
  const changes = store.changes.all().filter((c) => shownItems(c).length > 0).sort((a, b) => a.at.localeCompare(b.at));
  // Without a last-session reference point, the most recent meaningful changes, mainly the decisions that changed the
  // direction and the replacements (Spec §1.12, §7.3 item 7; QC AH #12): the latest five of those first, the latest other
  // changes after them up to five, all in time order. It used to be the latest five whatever they were.
  const directional = (c: ChangeRecord) => shownItems(c).some((it) => DIRECTION_MATERIALS.has(it.material) || DIRECTION_EFFECTS.has(it.effect));
  const latestFirst = [...changes].reverse();
  const picked = [...latestFirst.filter(directional), ...latestFirst.filter((c) => !directional(c))].slice(0, 5);
  const recent = since ? changes.filter((c) => c.updatedAt > since) : changes.filter((c) => picked.includes(c));
  const isAsset = (id: string) => store.reference.has(id) || store.threads.has(id) || store.nodes.has(id);
  /** An object a change names; one since removed from the current version is named as removed (AC-35). */
  const named = (id: string) => `${nameOf(store, id)} (\`${id}\`${removed(id) ? ', removed from the current version' : ''})`;
  /** One entry per piece of work, its net changes listed under it (D56; Spec §1.8). Each one says what changed and
   *  why, as the material states it. A record written before pieces of work existed keeps the old single-line shape,
   *  so nothing gains a layer it does not need. */
  const changeLine = (c: ChangeRecord) => {
    const notJudged = (c.notJudged ?? []).filter((n) => isAsset(n.nodeId));
    // What a piece of work only recorded and never maintained — a finished work item, a session, a commit — is named
    // here and judged nowhere (D56), so the reader sees it without it turning into something to chase.
    const tail = notJudged.length ? [`  Recorded at the time, not judged: ${notJudged.map((n) => named(n.nodeId)).join('; ')}`] : [];
    if (!c.work) {
      const affects = c.affects.filter(isAsset);
      return [
        `- ${c.at.slice(0, 10)} · ${c.effect} · ${c.material} · **${oneLine(c.title)}** (\`${c.id}\`)${c.segment ? ` · from ${oneLine(c.segment.name)}` : ''}${cites.ref(c.sourceIds)}`,
        indent(c.summary, '  '),
        c.before || c.after ? `  Before: ${oneLine(c.before) || '—'} → after: ${oneLine(c.after) || '—'}` : '',
        affects.length ? `  Affects: ${affects.map(named).join('; ')}` : '',
        ...tail,
      ].filter((l) => l.length).join('\n');
    }
    const items = shownItems(c);
    return [
      `- ${c.at.slice(0, 10)} · ${c.work.kind}: **${oneLine(c.work.label)}** (\`${c.id}\`)${c.work.openEnded ? ' · still going when this round began' : ''}${items.length > 1 ? ` · ${items.length} changes` : ''}${cites.ref(items.flatMap((it) => it.sourceIds))}`,
      ...items.flatMap((it) => {
        const affects = it.affects.filter(isAsset);
        return [
          `  - ${it.effect} · ${it.material} · **${oneLine(it.title)}**${cites.ref(it.sourceIds)}`,
          indent(it.summary, '    '),
          it.before || it.after ? `    Before: ${oneLine(it.before) || '—'} → after: ${oneLine(it.after) || '—'}` : '',
          it.why ? `    Why: ${oneLine(it.why)}` : '',
          affects.length ? `    Affects: ${affects.map(named).join('; ')}` : '',
        ].filter((l) => l.length);
      }),
      ...tail,
    ].join('\n');
  };
  if (request.taskVersion && !(request.purpose === 'Work' && scope.focusThread)) section('Version check', versionCheck(store, scope.focusThread ?? null, scope.references, request.taskVersion, cites));
  // The section keeps its fixed name (§7.3); without a last-session reference point it says so and lists the most recent meaningful changes.
  if (request.purpose === 'Start' || em.recentChanges === 'full' || em.reviewChanges === 'full') section('Changes since last session', recent.length ? [...(since ? [] : ['- No last-session reference point was given; the most recent meaningful changes follow in time order — chiefly the decisions and replacements that changed the direction, then the latest others.']), ...recent.map(changeLine)] : []);

  // D15 grading: Do not revive / Not in current scope / Pending owner decisions (Spec §7.1).
  const bears = (id: string) => wholeProject || relatedIds.has(id);
  /** What the project's own `Obsolete` rule withdraws is `Do not revive` with the rule as its source (§1.15, §7.1). */
  const byObsoleteRule = (ruleId: string | null | undefined) => { const rule = ruleId ? store.rules.get(ruleId) : undefined; return rule?.category === 'Obsolete' ? rule : undefined; };
  const retiredRefs = store.reference.filter((r) => (r.validity === 'Replaced' || r.validity === 'Abandoned') && (bears(r.id) || (r.replacedBy ? bears(r.replacedBy) : false)));
  const retiredThreads = store.threads.filter((t) => (t.validity === 'Replaced' || t.validity === 'Abandoned') && (bears(t.id) || (t.replacedBy ? bears(t.replacedBy) : false)));
  const withdrawn = (ruleId: string | null | undefined) => { const rule = byObsoleteRule(ruleId); return rule ? ` — withdrawn by the project’s rule \`${rule.id}\`` : ''; };
  const retired = [...retiredRefs.map((r) => `- ${r.name} (\`${r.id}\`): ${r.validity === 'Replaced' ? `replaced by ${r.replacedBy ? `${nameOf(store, r.replacedBy)} (\`${r.replacedBy}\`)` : 'newer content'}` : 'abandoned'}${withdrawn(r.validityByRuleId)}${text(r.text) ? ` — ${oneLine(r.text)}` : ''}${cites.ref([...r.sourceIds, ...(byObsoleteRule(r.validityByRuleId)?.sourceIds ?? [])])}`),
    ...retiredThreads.map((t) => `- ${t.title} (\`${t.id}\`): ${t.validity === 'Replaced' ? `replaced by ${t.replacedBy ? `${nameOf(store, t.replacedBy)} (\`${t.replacedBy}\`)` : 'newer work'}` : 'abandoned'}${withdrawn(t.validityByRuleId)}`)];
  const withdrawnHere = new Set([...retiredRefs.map((r) => r.validityByRuleId), ...retiredThreads.map((t) => t.validityByRuleId)].filter((x): x is string => typeof x === 'string'));
  const facts = workFacts;
  const obsolete = rules.filter((r) => r.validity === 'Current' && r.category === 'Obsolete' && (wholeProject || withdrawnHere.has(r.id) || (facts !== null && ruleBearsOnWork({ ...r, category: 'Other' }, facts))))
    .map((r) => `- ${oneLine(r.summary)} (\`${r.id}\`) — the project’s own rule marks this obsolete${r.appliesTo.length ? `; it covers ${r.appliesTo.join(', ')}` : ''}${cites.ref(r.sourceIds)}`);
  const disposal = store.marks.filter((m) => m.kind === 'Disposal' && !m.closed && !gone(m.targetId) && bears(m.targetId)).map((m) => `- Disposal: ${nameOf(store, m.targetId)} (\`${m.targetId}\`) — ${oneLine(m.clue)}${cites.ref(m.clueSourceIds)}`);
  section('Do not revive', [...retired, ...obsolete, ...disposal]);
  const deferred = [...store.reference.filter((r) => r.validity === 'Deferred' && bears(r.id)).map((r) => `- ${r.name} (\`${r.id}\`): ${oneLine(r.text)}${cites.ref(r.sourceIds)}`), ...store.threads.filter((t) => t.validity === 'Deferred' && bears(t.id)).map((t) => `- ${t.title} (\`${t.id}\`): ${oneLine(t.doing)}`)];
  section('Not in current scope', deferred);
  const noteInScope = (n: Note) => wholeProject || n.mount.ids.some((id) => relatedIds.has(id)) || (n.mount.kind === 'project' && relatedText(`${latest(n).title} ${latest(n).preview}`));
  const pendingNotes = store.notes.filter((n) => waitsForOwner(n) && noteInScope(n));
  const proposed = store.reference.filter((r) => r.validity === 'Proposed' && bears(r.id));
  const proposedRules = rules.filter((r) => r.validity === 'Proposed' && bears(r.id));
  // A rule or decision a role set in the owner's place, in force now (§1.9; CKC-12 AC-37): who set it and when, and why
  // it is the owner's to decide. The agent follows it meanwhile, knowing it is not the owner's decision.
  const inForceNow = (id: string) => (store.reference.get(id)?.validity ?? store.rules.get(id)?.validity) === 'Current';
  const setWithoutOwner = store.marks.filter((m) => m.kind === 'Decided without owner' && !m.closed && checked(m) && !gone(m.targetId) && inForceNow(m.targetId) && bears(m.targetId)).map((m) => {
    const rule = store.rules.get(m.targetId);
    return `- Decided without owner, in force now: ${rule ? oneLine(rule.summary) : nameOf(store, m.targetId)} (\`${m.targetId}\`) — set by ${m.decidedBy?.who ?? 'a role the records do not name'}${m.decidedBy?.at ? ` on ${dayOf(m.decidedBy.at)}` : ''}; the owner decides because: ${oneLine(m.clue)} (\`${m.id}\`)${cites.ref(m.clueSourceIds)}`;
  });
  section('Pending owner decisions', [
    ...setWithoutOwner,
    ...proposed.map((r) => `- Proposed: ${r.name} (\`${r.id}\`) — ${oneLine(r.text)}${cites.ref(r.sourceIds)}`),
    ...proposedRules.map((r) => `- Proposed rule: ${oneLine(r.summary)} (\`${r.id}\`)${cites.ref(r.sourceIds)}`),
    ...pendingNotes.map((n) => `- For the owner’s decision: ${latest(n).title} (\`${n.id}\`) — ${oneLine(latest(n).preview)}`),
  ]);

  // Notes for you: the gist of each note whole, with its id; the full note is fetched by id (§7.3 item 9).
  const notes = store.notes.filter((n) => n.status === 'Current' && noteInScope(n));
  const noteShown = notes.slice(0, em.notes === 'full' ? 12 : 5);
  const noteLines = noteShown.map((n) => { const v = latest(n); return `- ${v.title} (\`${n.id}\` · ${v.ask}): ${oneLine(v.preview)}${v.body.keepAdjust && em.notes === 'full' ? ` Keep/adjust: ${oneLine(v.body.keepAdjust)}` : ''}${cites.ref(v.body.facts.flatMap((f) => f.sourceIds))}`; });
  if (noteShown.length < notes.length) noteLines.push(`- ${notes.length - noteShown.length} further current note${notes.length - noteShown.length === 1 ? '' : 's'} in scope are not listed here: ${notes.slice(noteShown.length).map((n) => `${latest(n).title} (\`${n.id}\`)`).join('; ')}.`);
  if (roleRecipient) for (const r of store.requests.filter((x) => !x.handled && x.holder.toLowerCase() === roleRecipient.toLowerCase())) noteLines.push(`- Modification request for ${r.holder}: ${oneLine(r.what)} — why: ${oneLine(r.why)}${r.impact.length ? ` — affects ${r.impact.filter((id) => !gone(id)).map((id) => `${nameOf(store, id)} (\`${id}\`)`).join(', ')}` : ''}${cites.ref(r.basisSourceIds)}`);
  section('Notes for you', noteLines);
  // An orchestrator's product purpose of each piece of work is on its map row (Spec §7.3); a work context has no map.
  if (isOrchestrator && request.purpose === 'Work' && scope.focusThread) {
    const contracts = store.threads.filter((t) => current(t.validity) && t.ids.length > 0).map((t) => `- ${t.ids[0]} ${t.title} (\`${t.id}\`): ${t.serves.filter((s) => !removed(s.referenceId)).map((s) => `${nameOf(store, s.referenceId)} — ${oneLine(s.claim)}`).join('; ') || 'purpose not yet established'}`);
    section('Product purpose of each piece of work in hand', contracts);
  }

  // Freshness
  const fresh: string[] = [];
  // The repository's head is not what the content covers: commits read but not yet organized are named (trial,
  // 2026-09-18: a header naming the latest commit made an agent take that commit's work as already reflected).
  const commitsSince = (coverage?.pending ?? []).filter((m) => m.kind === 'commit').map((m) => m.since).sort()[0] ?? null;
  const unorganizedCommits = commitsSince ? store.sources.filter((x) => x.anchor.kind === 'commit' && x.usedAs === null && x.version.readAt >= commitsSince).sort((a, b) => a.version.readAt.localeCompare(b.version.readAt)) : [];
  // "organized" is said only about a head this project has actually read. A home that does not watch the project sees
  // no pending commits, and the head then went unmentioned as if it were covered (cold-start trial, 2026-09-18: the
  // pack covered material up to 08:03Z and still called the 15:03Z head organized).
  const headSource = commit ? store.sources.find((x) => x.anchor.kind === 'commit' && (x.anchor.commit.startsWith(commit) || commit.startsWith(x.anchor.commit))) : undefined;
  const headState = !commit ? '' : headSource === undefined ? ', not read into the assets yet' : headSource.usedAs === null ? ', read but not organized yet' : ', organized';
  // The coverage label is written only when the scope is behind; `Up to date` is the normal state and stays in the assets (D59).
  const coverageLabel = coverage && coverage.coverage !== 'Up to date' ? ` Coverage: ${coverage.coverage}.` : '';
  fresh.push(`- As of ${asOf ?? 'unknown'}.${coverageLabel}${commit ? ` The repository is at commit ${commit.slice(0, 10)}${headState}.` : ''}`);
  if (unorganizedCommits.length) fresh.push(`- Commits read but not yet organized, so not reflected above: ${unorganizedCommits.map((x) => `${oneLine(x.title)} (\`${x.id}\`)`).join('; ')}.`);
  // The total and its parts come from the same list, so they add up (D43; CKC-12 AC-28). They used to come from two
  // records — the project scope's pending list and a store-wide tally — and the parts could exceed the total.
  const pendingList = coverage?.pending ?? [];
  const byKind = new Map<string, number>();
  for (const m of pendingList) byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
  // A file too large to read is skipped, not failed (D105): not counted here, also in a home that still lists it as failed.
  const failedCount = coverage ? realFailures([coverage]).length : 0;
  fresh.push(`- Unprocessed changes, counted when this pack was generated: ${pendingList.length}${byKind.size ? ` (${[...byKind].map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}${failedCount ? `; ${failedCount} material(s) failed to organize` : ''}.`);
  // Spec §7.1 / CKC-13 AC-22: which history is not organized, at what depth, and how to reach it.
  const tk = store.coverage.takeover;
  if (tk && tk.historyNotOrganized > 0) fresh.push(`- Takeover depth: ${tk.depth}. ${tk.historyNotOrganized} older material(s) are not organized into fact records (${tk.levels.filter((l) => l.level !== 'Read in full' && l.materials > 0).map((l) => `${l.level}: ${l.materials}`).join(', ')}). When your work touches that history, ask the Keeper to read it (Explore further) or search the sources; it is indexed, not summarised.`);
  fresh.push(`- Observed: ${project.scope.filter((i) => i.relation !== 'Excluded').map((i) => `${i.category.toLowerCase()} ${i.path}`).join('; ')}.`);
  fresh.push(`- Keeper status when generated: ${keeperStatus}.`);
  // A mark on a row of the map is written in that row, and one on the way to the owner's words in `Owner's words`; the
  // rest are listed here by name, id and kind, as an index (Spec §7.1, §7.3). Each says what differs and how to check it now.
  const staleMarks = store.marks.filter((m) => !m.closed && (m.kind === 'Suspected stale' || m.kind === 'Layer drift' || m.kind === 'Scope question') && !gone(m.targetId) && bears(m.targetId) && !onMapIds.has(m.targetId) && !shownMarkIds.has(m.id) && checked(m) && !onAnotherJudgement(m.targetId));
  const behindOffMap = [...behindOn.entries()].filter(([nodeId]) => !gone(nodeId) && bears(nodeId) && !onMapIds.has(nodeId));
  if (staleMarks.length || refPendingWritten || scope.threads.some((x) => x.pendingSourceIds.length && !onMapIds.has(x.id))) fresh.push(`- ${markLegend}`);
  for (const m of staleMarks) fresh.push(`- ${m.kind} (\`${m.id}\`) on ${nameOf(store, m.targetId)} (\`${m.targetId}\`): ${oneLine(m.clue)}${cites.ref(m.clueSourceIds)}`);
  // Still on old understanding (§7.1; D56): which object has not followed which change, and what it lacks.
  for (const [nodeId, cs] of behindOffMap) fresh.push(`- Still on old understanding: ${nameOf(store, nodeId)} (\`${nodeId}\`) has not followed ${cs.map((c) => `“${oneLine(c.title)}” (\`${c.id}\`)${c.what ? ` — ${c.what}` : ''}${cites.ref(c.sourceIds)}`).join(', ')}.`);
  for (const t of scope.threads.filter((x) => x.pendingSourceIds.length && !onMapIds.has(x.id))) fresh.push(`- ${t.title} (\`${t.id}\`): ${pendingMark(t.pendingSourceIds, t.waitsFor)}.`);
  section('Freshness', fresh);

  section('Explore further', agentUsage(project.id, where).map((l) => `- ${l}`));

  // A source that exists only in history, or that is no longer in the current version, says so where it is listed (AC-35).
  const historyLabel = (s: Source) => s.usedAs === 'History only' ? ' — history only, not the current version' : s.availability === 'No longer available' ? ' — history: no longer in the current version' : '';
  const provenance = cites.list().map((id, i) => { const s = store.sources.get(id)!; return `[${i + 1}] \`${id}\` ${s.title} — ${anchorLabel(s.anchor)}${historyLabel(s)}${s.hasCredential ? ' (contains a credential; not reproduced)' : ''}`; });
  section('Sources', provenance);

  const markdown = out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { id: newId('ctx'), projectId: project.id, request, asOf: asOf ?? 'unknown', commit, keeperStatus, markdown, citedSourceIds: cites.list(), generatedAt: new Date().toISOString(), deliveries: [] };
}
