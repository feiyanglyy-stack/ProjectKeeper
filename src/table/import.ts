/**
 * `pk import`: the ProjectKeeper table taken into a home (template/FILLING-IN.md, "How it is drawn"). The table is
 * checked first, as `pk check` checks it, and a table with any problem is refused before anything is opened or written.
 * A table that holds replaces the picture the Keeper wrote for the project — the product reference, the work items,
 * the relations, the generations, the process links, the code territories and the notes — with the table's content;
 * what intake read (sources) and the ledger stay. The graph is then derived from it as after any round (graph.ts), so
 * the Graph, the List and the Code view draw the table (D107: the filler judges, the program draws).
 *
 * `mapTable` is the mapping alone: table in, store records out, given how each cited source resolves. `resolveSources`
 * reads the cited lines, commits and session messages at the table's `asOf`; `importTable` does the rest.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CodeTerritory, EvidenceRef, Generation, Occurred, ProcessLink, StepKind } from '../model/k-types.ts';
import type {
  Attribution, FactRecord, GraphRelation, JobInputs, Note, NoteFact, ReferenceItem, ServesClaim, Source, Statement, WorkThread,
} from '../model/types.ts';
import type { Basis, NoteAsk, Progress, SessionHost, Validity } from '../model/vocab.ts';
import { fingerprint, stableId } from '../model/ids.ts';
import { extractIds, makeFileSource, makeSessionSource, redactCredentials } from '../sources/anchor.ts';
import { git } from '../util/git.ts';
import { canonicalPath, normalizePath, pathKey, samePath } from '../util/paths.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { withTableProject } from './project-home.ts';
import { checkTableFile, fileAt, owningRepo, resolveRepos, walkSources, type Repo, type SessionMessage, type TableProblem, type TableSource } from './check.ts';

// ───────────────────────── the table, as the schema shapes it ─────────────────────────

type Status = 'Current' | 'Proposed' | 'Deferred' | 'Replaced' | 'Abandoned';
interface Entry { readonly id: string; readonly name: string; readonly summary: string; readonly status: Status; readonly replacedBy?: string; readonly why?: string; readonly sources: readonly TableSource[] }
interface OwnerWant {
  readonly id: string; readonly want: string; readonly kind: 'Product' | 'Way of working';
  readonly status: 'Current' | 'Replaced' | 'Open' | 'Not raised again'; readonly replacedBy?: string;
  readonly said: readonly TableSource[]; readonly approvedProposal?: { readonly part: string; readonly source: TableSource };
  readonly changed?: readonly { readonly before: string; readonly after: string; readonly source: TableSource }[];
  readonly reflectedIn?: readonly string[];
}
type Place = { readonly area: string } | { readonly areas: readonly string[] } | { readonly plan: string } | { readonly wholeProduct: string };
interface Intent extends Entry { readonly boundary?: boolean; readonly place: Place; readonly inferred?: boolean; readonly partlyReplaced?: readonly { readonly by: string; readonly part: string }[] }
interface Area extends Entry { readonly goals?: readonly string[]; readonly foundation?: boolean }
interface Plan extends Entry { readonly ended?: string }
type Became = { readonly carriedOnBy: string } | { readonly movedTo: string } | { readonly deferred: string } | { readonly dropped: string } | { readonly finished: string };
interface Step { readonly kind: StepKind; readonly at?: string; readonly verdict?: string; readonly source: TableSource }
interface Work extends Entry {
  readonly plan: string; readonly area?: string; readonly alsoAreas?: readonly string[]; readonly wholePlan?: string;
  readonly implements?: readonly string[]; readonly dependsOn?: readonly string[]; readonly progress: Progress;
  readonly accepted?: TableSource; readonly open?: string; readonly became?: Became; readonly steps?: readonly Step[];
}
interface Territory {
  readonly id: string; readonly name: string; readonly summary: string; readonly area: string; readonly alsoAreas?: readonly string[];
  readonly paths: readonly string[];
  readonly anomalies?: readonly { readonly kind: CodeTerritory['anomalies'][number]['kind']; readonly text: string; readonly sources?: readonly TableSource[] }[];
}
interface TableNote {
  readonly id: string; readonly title: string; readonly kind: 'Anomaly' | 'Owner and project differ' | 'Question'; readonly ask: NoteAsk;
  readonly by: "Owner's words" | 'Project' | 'Main agent'; readonly on: readonly string[]; readonly text: string;
  readonly options?: readonly { readonly choice: string; readonly consequence: string }[]; readonly sources: readonly TableSource[];
}
export interface Table {
  readonly format: 'projectkeeper.table/1';
  readonly project: { readonly name: string; readonly asOf: { readonly date: string; readonly repos: readonly { readonly path: string; readonly commit: string }[] }; readonly filledBy: { readonly agent: string; readonly at: string; readonly read?: string } };
  readonly ownerWants: readonly OwnerWant[];
  readonly product: { readonly id: string; readonly name: string; readonly summary: string; readonly forWhom: string; readonly sources: readonly TableSource[] };
  readonly goals: readonly Entry[];
  readonly areas: readonly Area[];
  readonly requirements: readonly Intent[];
  readonly designs: readonly Intent[];
  readonly decisions: readonly Intent[];
  readonly plans: readonly Plan[];
  readonly work: readonly Work[];
  readonly code: readonly Territory[];
  readonly notes: readonly TableNote[];
}

// ───────────────────────── sources ─────────────────────────

const slash = (p: string): string => p.split('\\').join('/').replace(/^\.\/?/, '').replace(/\/$/, '');
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** One key per cited place, whatever quote it carries: the same lines cited twice are one source. */
export function sourceKey(s: TableSource): string {
  if (s.file !== undefined) return `file:${slash(s.file)}#${s.lines ?? ''}`;
  if (s.commit !== undefined) return `commit:${slash(s.repo ?? '.')}@${s.commit}`;
  return `session:${s.session ?? ''}#${s.message ?? ''}`;
}

/** The lines a file source cites, 1-based and inclusive: its `lines`, else the whole file (a final newline is no line). */
function citedRange(text: string, lines: string | undefined): { from: number; to: number; all: string[] } {
  const all = text.split(/\r?\n/);
  if (all.length > 1 && all[all.length - 1] === '') all.pop();
  if (lines === undefined) return { from: 1, to: Math.max(1, all.length), all };
  const [from, to = from] = lines.split('-').map(Number) as [number, number?];
  return { from, to, all };
}

/** The session material's name for a session, `host:id`, as the store's anchor has it. */
function sessionParts(session: string): { host: SessionHost; id: string } {
  const at = session.indexOf(':');
  // The material names every session with its host (claude:…, codex:…); a host the store has no word for is kept as given.
  return at > 0 ? { host: session.slice(0, at) as SessionHost, id: session.slice(at + 1) } : { host: 'claude', id: session };
}

export interface ResolvedSources {
  /** The store source each cited place stands for, by `sourceKey`. */
  readonly byKey: ReadonlyMap<string, Source>;
  /** The sources the import writes: the ones intake had not read as they are cited. */
  readonly fresh: readonly Source[];
  /** How many cited places were found already read by intake, unchanged. */
  readonly reused: number;
}

/**
 * Every source the table cites, as a store source: a file's cited lines as they stood at the `asOf` commit (an intake
 * source of exactly those lines with the same text is used as it is), a commit by its full hash (intake's commit source
 * when it read it), a session message with its text from the session material. Reads git; writes nothing.
 */
export function resolveSources(table: Table, options: {
  readonly projectId: string; readonly projectDir: string; readonly repos: readonly Repo[]; readonly existing: readonly Source[];
  readonly sessions: readonly SessionMessage[] | null; readonly scopeItemId: string; readonly at: string;
}): ResolvedSources {
  const { projectId, projectDir, repos, existing } = options;
  const byKey = new Map<string, Source>();
  const fresh: Source[] = [];
  let reused = 0;
  const cache = new Map<string, string | null>();
  const sessionText = new Map((options.sessions ?? []).map((m) => [`${m.session}#${m.message}`, m.text]));
  const keep = (key: string, source: Source, isNew: boolean) => { byKey.set(key, source); if (isNew) fresh.push(source); else reused++; };
  walkSources(table, '', (_at, s) => {
    const key = sourceKey(s);
    if (byKey.has(key)) return;
    if (s.file !== undefined) {
      const text = fileAt(s.file, repos, projectDir, cache);
      if (text === null) throw new Error(`${s.file} is not in the project at its asOf commit`);   // the check said it is
      const path = normalizePath(join(projectDir, slash(s.file)));
      const { from, to, all } = citedRange(text, s.lines);
      const cited = all.slice(from - 1, to).join('\n');
      const sameFile = existing.filter((x) => x.anchor.kind === 'file' && samePath(x.anchor.path, path));
      const same = sameFile.find((x) => x.anchor.kind === 'file' && x.anchor.lineStart === from && x.anchor.lineEnd === to && !x.availability && squash(x.excerpt) === squash(cited));
      if (same) { keep(key, same, false); return; }
      // Shown under the section intake read the first cited line in, when it read one; judged as intake's source of it was.
      const section = sameFile.find((x) => x.anchor.kind === 'file' && x.anchor.lineStart <= from && from <= x.anchor.lineEnd);
      const headingPath = section?.anchor.kind === 'file' ? section.anchor.headingPath : [];
      const owner = owningRepo(s.file, repos);
      const made = makeFileSource({
        projectId, path, headingPath, lineStart: from, lineEnd: to, excerpt: cited, fileText: text,
        scopeItemId: section?.scopeItemId ?? sameFile[0]?.scopeItemId ?? options.scopeItemId, ids: extractIds(cited),
        commit: owner?.repo.commit ?? null, readAt: options.at,
        title: `${headingPath.length ? headingPath[headingPath.length - 1] : basename(path)} · L${from}–L${to}`,
      });
      // Its own id: intake's id for a section is the path and the heading, and these are the table's lines of it.
      keep(key, { ...made, id: stableId('src', 'table', pathKey(path), from, to), usedAs: section?.usedAs ?? null, usedAsBy: section?.usedAsBy ?? null }, true);
      return;
    }
    if (s.commit !== undefined) {
      const repo = repos.find((r) => r.path === slash(s.repo ?? '.'));
      const dir = canonicalPath(repo?.dir ?? join(projectDir, s.repo ?? '.'));
      const full = git(dir, ['rev-parse', '--verify', `${s.commit}^{commit}`]).out.trim() || s.commit;
      const id = stableId('src', 'commit', pathKey(dir), full);   // anchor.ts commitSourceId: intake's own id for it
      const read = existing.find((x) => x.id === id);
      if (read) { keep(key, read, false); return; }
      const [subject = '', author = '', when = ''] = git(dir, ['show', '-s', '--format=%s%n%an%n%aI', full]).out.split('\n');
      const files = git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', full]).out.split('\n').filter(Boolean);
      const excerpt = `${subject}\n\nauthor: ${author}\nat: ${when}\nfiles:\n${files.map((f) => `  ${f}`).join('\n')}`;
      const red = redactCredentials(excerpt);
      keep(key, {
        id, projectId, title: `${full.slice(0, 8)} ${subject.slice(0, 80)}`, anchor: { kind: 'commit', repo: dir, commit: full, ...(when ? { at: when } : {}) },
        ids: extractIds(subject), version: { fingerprint: fingerprint(excerpt), readAt: options.at, commit: full }, excerpt: red.text,
        usedAs: null, usedAsBy: null, availability: null, movedTo: null, scopeItemId: options.scopeItemId, hasCredential: red.found, bytes: Buffer.byteLength(excerpt),
      }, true);
      return;
    }
    const session = s.session ?? '';
    const message = s.message ?? 0;
    const { host, id } = sessionParts(session);
    const text = sessionText.get(`${session}#${message}`) ?? '';
    const made = makeSessionSource({
      projectId, host, sessionId: id, file: '', cwd: projectDir, messageStart: message, messageEnd: message, at: null,
      excerpt: text, title: `${host} session ${id.slice(0, 8)} · message ${message}`, scopeItemId: options.scopeItemId, readAt: options.at,
    });
    // The material numbers a session's messages its own way, not by their place in the native log intake segments by:
    // the table's message gets an id of its own so it never stands in for an intake segment.
    keep(key, { ...made, id: stableId('src', 'table', 'session', session, message), usedAs: 'Session', usedAsBy: null }, true);
  });
  return { byKey, fresh, reused };
}

// ───────────────────────── the mapping ─────────────────────────

export interface MapContext {
  readonly projectId: string;
  readonly projectDir: string;
  /** The table's repositories (check.ts `resolveRepos`), for the code territories and the steps' evidence. */
  readonly repos: readonly Repo[];
  /** The store source a cited place resolves to (`resolveSources`). */
  readonly source: (s: TableSource) => Source;
}

export interface MappedTable {
  readonly reference: readonly ReferenceItem[];
  readonly threads: readonly WorkThread[];
  readonly facts: readonly FactRecord[];
  readonly relations: readonly GraphRelation[];
  readonly generations: readonly Generation[];
  readonly links: readonly ProcessLink[];
  readonly territories: readonly CodeTerritory[];
  readonly notes: readonly Note[];
  /** Table id → store id, for every entry of the table. */
  readonly ids: ReadonlyMap<string, string>;
}

const JOB = 'table-import';
const language = (text: string): string => (/[\u3400-\u9fff]/.test(text) ? 'zh' : 'en');
/** `A1 · Capture` as the Keeper names items (the fixture's `'A1 · Capture 快速收藏'`); a name that starts with its id keeps it once. */
const named = (id: string, name: string): string => (name.trim().startsWith(id) ? name.trim() : `${id} · ${name.trim()}`);
const withWhy = (text: string, why: string | undefined): string => (why ? `${text}\n\n${why}` : text);
const uniq = <T,>(list: readonly T[]): T[] => [...new Set(list)];

/** The table's store ids: stable per project and table id, prefixed by what the store keeps them as. */
export function storeIdsOf(table: Table, projectId: string): Map<string, string> {
  const ids = new Map<string, string>();
  const ref = (id: string) => ids.set(id, stableId('ref', projectId, 'table', id));
  ref(table.product.id);
  for (const list of [table.ownerWants, table.goals, table.areas, table.requirements, table.designs, table.decisions, table.plans]) for (const e of list) ref(e.id);
  for (const w of table.work) ids.set(w.id, stableId('thread', projectId, 'table', w.id));
  for (const t of table.code) ids.set(t.id, stableId('terr', projectId, 'table', t.id));
  for (const n of table.notes) ids.set(n.id, stableId('note', projectId, 'table', n.id));
  return ids;
}

/** The table mapped onto the store's records. Pure: every source is resolved by `ctx.source`. */
export function mapTable(table: Table, ctx: MapContext): MappedTable {
  const { projectId } = ctx;
  const at = table.project.filledBy.at;
  const ids = storeIdsOf(table, projectId);
  const id = (tableId: string): string => ids.get(tableId)!;
  const sids = (list: readonly (TableSource | undefined)[]): string[] => uniq(list.filter((s): s is TableSource => s !== undefined).map((s) => ctx.source(s).id));
  const inputs = (sourceIds: readonly string[]): JobInputs => ({ jobId: JOB, sourceIds, factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: ctx.projectDir });
  // Whose the content is. The owner's words are the owner's own statements (author owner, identity Decision: tools.ts
  // pk_write_reference); the rest is the project's material as the filler read it — who wrote that material the table
  // does not say — and what no document states is the filler's own reading.
  const byOwner: Attribution = { author: { kind: 'owner', name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' };
  const byMaterial: Attribution = { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' };
  const byFiller: Attribution = { author: { kind: 'agent', name: table.project.filledBy.agent, window: null, host: null, model: null }, holder: null, identity: 'Interpretation' };

  // ── what carries each owner want out: the reference items refine it, the work items serve it ──
  const reflectingRefs = new Map<string, string[]>();
  const reflectingWork = new Map<string, ServesClaim[]>();
  const workIds = new Set(table.work.map((w) => w.id));
  const territoryIds = new Set(table.code.map((t) => t.id));
  for (const w of table.ownerWants) for (const r of w.reflectedIn ?? []) {
    if (territoryIds.has(r)) continue;   // a territory is no node of the graph: nothing to draw the link on
    if (workIds.has(r)) reflectingWork.set(r, [...(reflectingWork.get(r) ?? []), { referenceId: id(w.id), claim: `carries out the owner's want ${w.id}`, basis: 'Explicit' }]);
    else reflectingRefs.set(r, [...(reflectingRefs.get(r) ?? []), id(w.id)]);
  }

  const reference: ReferenceItem[] = [];
  const item = (tableId: string, category: ReferenceItem['category'], name: string, text: string, sourceIds: readonly string[], over: Partial<ReferenceItem> = {}) => {
    reference.push({
      id: id(tableId), projectId, category, name, ids: [tableId], text, quote: null, basis: 'Explicit', validity: 'Current', progress: null,
      attribution: byMaterial, sourceIds, replacedBy: null, inputs: null, asOf: at, updatedAt: at, ...over,
      refines: uniq([...(over.refines ?? []), ...(reflectingRefs.get(tableId) ?? [])]),
    });
  };
  const productId = id(table.product.id);

  // ── the owner's words (D63): the want in a sentence, the owner's own words as the quote, where they were said ──
  const WANT_VALIDITY: Record<OwnerWant['status'], Validity> = { Current: 'Current', Replaced: 'Replaced', Open: 'Proposed', 'Not raised again': 'Unjudged' };
  for (const w of table.ownerWants) {
    const turns = (w.changed ?? []).map((c) => `Earlier: ${c.before} → ${c.after}`);
    item(w.id, "Owner's words", w.want, [w.want, ...turns].join('\n\n'), sids([...w.said, w.approvedProposal?.source, ...(w.changed ?? []).map((c) => c.source)]), {
      quote: w.said.find((s) => s.quote)?.quote ?? w.want, attribution: byOwner, validity: WANT_VALIDITY[w.status],
      replacedBy: w.replacedBy ? id(w.replacedBy) : null, ...(w.approvedProposal ? { answers: w.approvedProposal.part } : {}),
    });
  }
  const p = table.product;
  item(p.id, 'Product', named(p.id, p.name), `${p.summary}\n\nFor: ${p.forWhom}`, sids(p.sources));
  const entry = (e: Entry) => ({ validity: e.status as Validity, replacedBy: e.replacedBy ? id(e.replacedBy) : null });
  for (const g of table.goals) item(g.id, 'Goal', named(g.id, g.name), withWhy(g.summary, g.why), sids(g.sources), { ...entry(g), refines: [productId] });
  for (const a of table.areas) {
    item(a.id, 'Area', named(a.id, a.name), withWhy(a.summary, a.why), sids(a.sources), {
      ...entry(a), refines: a.goals?.length ? a.goals.map(id) : [productId], ...(a.foundation ? { foundation: true } : {}),
    });
  }
  const intents: readonly (readonly [readonly Intent[], 'Requirement' | 'Design' | 'Decision'])[] = [[table.requirements, 'Requirement'], [table.designs, 'Design'], [table.decisions, 'Decision']];
  for (const [list, category] of intents) {
    for (const e of list) {
      const place = e.place as Partial<{ area: string; areas: string[]; plan: string; wholeProduct: string }>;
      // Each place is what the story map reads (ui/placement.js): an area's column, several areas' ring, the plan whose
      // execution it records, or the whole product with the written reason (CM).
      const refines = place.area ? [id(place.area)] : place.areas ? place.areas.map(id) : place.plan ? [id(place.plan)] : [productId];
      // A part a later entry overturned stays on the item for the program (supersededParts, §5.5) and is said in its text,
      // which is where the popover shows it; the item itself stays in force.
      const parts = e.partlyReplaced ?? [];
      const text = [withWhy(e.summary, e.why), ...parts.map((p) => `No longer holds: ${p.part} (${p.by})`)].join('\n\n');
      item(e.id, category === 'Decision' && e.boundary ? 'Boundary' : category, named(e.id, e.name), text, sids(e.sources), {
        ...entry(e), refines, basis: e.inferred ? 'Inferred' : 'Explicit', attribution: e.inferred ? byFiller : byMaterial,
        ...(parts.length ? { supersededParts: parts.map((p) => ({ part: p.part, byId: id(p.by), basis: 'Explicit' as const, at: table.project.filledBy.at })) } : {}),
        ...(place.wholeProduct ? { wholeProductWhy: place.wholeProduct } : {}),
      });
    }
  }
  // Plans: a plan's progress is its work's, so none is written here.
  for (const pl of table.plans) item(pl.id, 'Plan', named(pl.id, pl.name), withWhy(pl.summary, pl.why), sids(pl.sources), { ...entry(pl), refines: [productId] });

  // ── work items: their place by `serves` (area first, then the other areas, then the plan), their sources in a fact record ──
  const threads: WorkThread[] = [];
  const facts: FactRecord[] = [];
  const relations: GraphRelation[] = [];
  const links: ProcessLink[] = [];
  const intentKind = new Map<string, string>();
  for (const [list, category] of intents) for (const e of list) intentKind.set(e.id, category === 'Decision' ? 'Decision' : category);
  for (const w of table.work) {
    const tid = id(w.id);
    const label = named(w.id, w.name);
    const sourceIds = sids([...w.sources, w.accepted]);
    const factId = stableId('fact', projectId, 'table', w.id);
    const statements: Statement[] = [{ id: `${factId}_summary`, type: 'Observed', text: w.summary, sourceIds: sids(w.sources) }];
    if (w.open) statements.push({ id: `${factId}_open`, type: 'Open', text: w.open, sourceIds: sids(w.sources) });
    if (w.accepted) statements.push({ id: `${factId}_accepted`, type: 'Observed', text: 'The owner accepted it.', sourceIds: sids([w.accepted]) });
    facts.push({
      id: factId, projectId, title: `${label} · from the table`, aboutSourceIds: sourceIds, statements, decisions: [], changes: [],
      openQuestions: w.open ? [w.open] : [], executionFacts: [], language: language(`${w.name} ${w.summary}`), inputs: inputs(sourceIds), asOf: at, updatedAt: at, pendingSourceIds: [],
    });
    const serves: ServesClaim[] = [
      ...(w.area ? [{ referenceId: id(w.area), claim: `the table puts ${w.id} in ${w.area}`, basis: 'Explicit' as Basis }] : []),
      ...(w.alsoAreas ?? []).map((a) => ({ referenceId: id(a), claim: `the table also puts ${w.id} in ${a}`, basis: 'Explicit' as Basis })),
      { referenceId: id(w.plan), claim: `the table plans ${w.id} in ${w.plan}`, basis: 'Explicit' },
    ];
    let validity: Validity = w.status;
    let replacedBy: string | null = w.replacedBy ? id(w.replacedBy) : null;
    let progress: Progress = w.progress;
    const changed: string[] = w.why ? [w.why] : [];
    // What became of an earlier generation's work (Spec §2.12, D100), the way the band reads where it went
    // (ui/placement.js): carried on by a current item it was replaced by; moved into a current plan it now serves too;
    // deferred; dropped (abandoned); finished under the earlier plan.
    const b = w.became as Partial<{ carriedOnBy: string; movedTo: string; deferred: string; dropped: string; finished: string }> | undefined;
    if (b?.carriedOnBy) { validity = 'Replaced'; replacedBy = id(b.carriedOnBy); changed.push(`Carried on by ${b.carriedOnBy}.`); }
    if (b?.movedTo) { serves.push({ referenceId: id(b.movedTo), claim: `moved from ${w.plan} into ${b.movedTo} unchanged`, basis: 'Explicit' }); changed.push(`Moved into ${b.movedTo}.`); }
    if (b?.deferred) { validity = 'Deferred'; changed.push(`Deferred: ${b.deferred}`); }
    if (b?.dropped) { validity = 'Abandoned'; changed.push(`Dropped: ${b.dropped}`); }
    if (b?.finished) { progress = 'Done'; changed.push(`Finished: ${b.finished}`); }
    threads.push({
      id: tid, projectId, title: w.name, ids: [w.id], doing: w.summary, changed: changed.join(' '), results: '', unresolved: w.open ?? '',
      ...(w.accepted ? { acceptance: 'Accepted' as const } : {}),
      executionFacts: [], qcFacts: [], factRecordIds: [factId], serves: [...serves, ...(reflectingWork.get(w.id) ?? [])],
      dependsOn: (w.dependsOn ?? []).map((d) => ({ threadId: id(d), claim: `the table says ${w.id} depends on ${d}`, basis: 'Explicit' as Basis })),
      progress, validity, replacedBy, attribution: byMaterial, inputs: inputs(sourceIds), asOf: at, updatedAt: at, pendingSourceIds: [],
      ...(w.wholePlan ? { wholePlanWhy: w.wholePlan } : {}),
    });
    // What it carries out: a requirement or design it implements (a contract, ui/placement.js), a decision it carries out.
    for (const target of w.implements ?? []) {
      const type: GraphRelation['type'] = intentKind.get(target) === 'Decision' ? 'carries out' : 'implements';
      relations.push({
        id: stableId('rel', type, tid, id(target)), projectId, type, from: tid, to: id(target), claim: `${w.id} ${type} ${target} (the table)`, basis: 'Explicit',
        evidence: { sourceIds: sids(w.sources), factRecordIds: [factId], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: at,
      });
    }
    // A step the program cannot find by the work's number, with its evidence (process/work.ts takes a confirmed link as a step).
    (w.steps ?? []).forEach((s, i) => {
      const ev = evidenceOf(ctx, s.source, s.at ? { at: s.at, basis: 'Written in text', anchor: sourceKey(s.source) } : null, s.verdict ?? s.source.quote ?? null);
      links.push({
        id: stableId('link', projectId, 'table', w.id, i), projectId, workId: tid, ledgerRef: ledgerRefOf(ctx, s.source, ev), evidence: ev, stepKind: s.kind,
        why: `${s.kind} of ${w.id}, as the table records it${s.verdict ? `: ${s.verdict}` : ''}`, basis: 'Inferred', confirmed: true, roundId: null, jobId: null, at: s.at ?? at,
      });
    });
  }

  // ── earlier generations: one per replaced plan, holding the work planned in it (Spec §2.12, D85) ──
  const generations: Generation[] = table.plans.filter((pl) => pl.status === 'Replaced').map((pl) => {
    const first = pl.sources[0]!;
    const src = ctx.source(first);
    return {
      id: stableId('gen', projectId, 'table', pl.id), projectId, name: named(pl.id, pl.name), started: null,
      ended: pl.ended ? { at: pl.ended, basis: 'Written in text', anchor: src.id } : { at, basis: 'First observed', anchor: null, undated: true },
      endedBy: { kind: 'source', id: src.id, label: pl.replacedBy ? `${pl.id} replaced by ${pl.replacedBy}` : src.title, line: pl.why ?? first.quote ?? null },
      // The plan itself, by its id: a document of it would draw every plan the same file holds into this band (generations.ts).
      planRefs: [{ kind: 'object', id: id(pl.id), label: named(pl.id, pl.name) }],
      workIds: table.work.filter((w) => w.plan === pl.id).map((w) => id(w.id)), roundId: null, updatedAt: at,
    };
  });

  // ── code territories: the judged half (§1.19); paths by the repository that holds them ──
  const territories: CodeTerritory[] = [];
  const notesOnTerritory = new Map<string, string[]>();
  for (const n of table.notes) for (const o of n.on) if (territoryIds.has(o)) notesOnTerritory.set(o, [...(notesOnTerritory.get(o) ?? []), id(n.id)]);
  for (const t of table.code) {
    const groups = new Map<string, { dir: string; paths: string[] }>();
    for (const path of t.paths) {
      const owner = owningRepo(path, ctx.repos);
      const dir = owner ? owner.repo.dir : ctx.projectDir;
      const inner = owner ? owner.inner : slash(path);
      const key = pathKey(dir);
      if (!groups.has(key)) groups.set(key, { dir, paths: [] });
      groups.get(key)!.paths.push(inner || '.');
    }
    const anomalies = (t.anomalies ?? []).map((a) => ({
      kind: a.kind, text: a.text, evidence: (a.sources ?? []).map((s) => evidenceOf(ctx, s, null, s.quote ?? null)), basis: 'Explicit' as Basis,
      sendBackId: null, noteIds: notesOnTerritory.get(t.id) ?? [], sixThing: a.kind === 'Looks residual, is live' ? 6 as const : null,
    }));
    // A territory whose paths lie in two repositories is one territory per repository: a territory's paths are its repository's.
    [...groups.values()].forEach((g, i) => territories.push({
      id: i === 0 ? id(t.id) : stableId('terr', projectId, 'table', t.id, i), projectId, name: t.name, summary: t.summary, repo: canonicalPath(g.dir), paths: g.paths,
      kind: 'area', areaId: id(t.area), alsoServes: (t.alsoAreas ?? []).map(id), anomalies, roundId: null, jobId: null, updatedAt: at,
    }));
  }

  // ── notes: on each object they name (the ❓ there), with how they came about ──
  const notes: Note[] = table.notes.map((n) => {
    const facts: NoteFact[] = n.sources.map((s) => ({ text: s.quote ?? labelOf(ctx.source(s)), sourceIds: [ctx.source(s).id], inferred: false }));
    return {
      id: id(n.id), projectId, mount: { kind: 'node', ids: n.on.map(id) }, status: 'Current', ownerResponse: null,
      versions: [{
        version: 1, at, title: n.title, preview: n.text, ask: n.ask, judgementRecordId: '', reason: 'Taken in from the ProjectKeeper table',
        body: { ...(n.options?.length ? { options: n.options.map((o) => ({ option: o.choice, then: o.consequence })) } : {}), currentView: n.text, whyItMatters: null, facts, otherExplanations: null, keepAdjust: null, whatWouldSettleIt: null },
      }],
      discussion: [], followUps: [], author: { agent: table.project.filledBy.agent, model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null,
      // Spec §4.1: a note written while taking the project over. The table's kind and the step that wrote it ride on the job kind.
      cameFrom: { kind: 'Takeover', jobKind: `ProjectKeeper table · ${n.kind} · by ${n.by}`, jobId: null, changeIds: [] },
      language: language(`${n.title} ${n.text}`), updatedAt: at,
    };
  });

  return { reference, threads, facts, relations, generations, links, territories, notes, ids };
}

const labelOf = (s: Source): string => (s.anchor.kind === 'file' ? `${basename(s.anchor.path)} L${s.anchor.lineStart}–L${s.anchor.lineEnd}` : s.title);

/** A cited place as the workbench names evidence: a file by its repository-relative path, a commit, a session's source. */
function evidenceOf(ctx: MapContext, s: TableSource, occurred: Occurred | null, line: string | null): EvidenceRef {
  const src = ctx.source(s);
  if (s.file !== undefined) {
    const owner = owningRepo(s.file, ctx.repos);
    return { kind: 'file', id: owner ? owner.inner : slash(s.file), label: `${slash(s.file)}${s.lines ? ` lines ${s.lines}` : ''}`, line, occurred, repo: canonicalPath(owner?.repo.dir ?? ctx.projectDir) };
  }
  if (s.commit !== undefined && src.anchor.kind === 'commit') return { kind: 'commit', id: src.anchor.commit, label: src.title, line, occurred, repo: src.anchor.repo };
  return { kind: 'source', id: src.id, label: src.title, line, occurred };
}

/** The ledger's id for the entry a step rests on, as the ledger writes it (`file:<path>`, `commit:<12>`); a session's source id. */
function ledgerRefOf(ctx: MapContext, s: TableSource, ev: EvidenceRef): string {
  if (ev.kind === 'file') return `file:${ev.id}`;
  if (ev.kind === 'commit') return `commit:${ev.id.slice(0, 12)}`;
  return ctx.source(s).id;
}

// ───────────────────────── the import ─────────────────────────

/** The collections that hold the Keeper's picture of a project; intake's sources, the ledger and the rest stay. */
const PICTURE = ['reference', 'threads', 'facts', 'areas', 'relations', 'nodes', 'generations', 'links', 'territories', 'notes', 'breakpoints', 'sendbacks'] as const;

export interface ImportResult {
  readonly problems: readonly TableProblem[];
  readonly projectId?: string;
  readonly projectName?: string;
  readonly home?: string;
  readonly added?: boolean;
  readonly counts?: {
    readonly removed: Readonly<Record<string, number>>;
    readonly sources: { readonly cited: number; readonly reused: number; readonly written: number };
    readonly reference: Readonly<Record<string, number>>;
    readonly threads: number; readonly facts: number; readonly relations: number; readonly generations: number;
    readonly links: number; readonly territories: number; readonly notes: number;
    readonly graph: { readonly nodes: number; readonly relations: number };
  };
  readonly warnings?: readonly string[];
}

export interface ImportOptions {
  readonly tableFile: string;
  /** The project folder; by default the folder holding `projectkeeper/`. */
  readonly projectDir?: string;
  /** The ProjectKeeper home; by default the user's (store/paths.ts). */
  readonly home?: string;
  /** The project's name when it is added; by default the table's. */
  readonly name?: string;
  readonly sessions?: readonly SessionMessage[] | null;
}

/**
 * Check the table, and when it holds take it into the home: the project found by its folder or added and read in, the
 * ledger brought up to date, the Keeper's picture replaced by the table's, the graph derived. Nothing is opened or
 * written for a table with a problem.
 */
export async function importTable(options: ImportOptions): Promise<ImportResult> {
  const projectDir = canonicalPath(options.projectDir ?? join(options.tableFile, '..', '..'));
  const sessions = options.sessions ?? null;
  const problems = checkTableFile(options.tableFile, { projectDir, sessions });
  if (problems.length) return { problems };
  const table = JSON.parse(readFileSync(options.tableFile, 'utf8')) as Table;

  // Loaded only now: a refused table opens nothing.
  const { deriveGraph } = await import('../keeper/organize/graph.ts');
  const { writeClerkCoverage } = await import('../keeper/organize/service.ts');
  return withTableProject({ projectDir, home: options.home, name: options.name ?? table.project.name }, async ({ app, project: opened, home, added, warnings }) => {
    let project = opened;
    const store = app.store(project.id);
    const at = new Date().toISOString();
    const repos = resolveRepos(table as unknown as Record<string, unknown>, projectDir, () => undefined);
    const mainItem = project.scope.find((i) => samePath(i.path, projectDir)) ?? project.scope[0];
    const resolved = resolveSources(table, { projectId: project.id, projectDir, repos, existing: store.sources.all(), sessions, scopeItemId: mainItem?.id ?? 'scope_table', at });
    const mapped = mapTable(table, { projectId: project.id, projectDir, repos, source: (s) => resolved.byKey.get(sourceKey(s))! });

    const trace = { jobId: null, summary: `Taken in from the ProjectKeeper table ${options.tableFile}` };
    const removed: Record<string, number> = {};
    for (const name of PICTURE) {
      const collection = store.collection(name);
      const before = collection.all();
      for (const x of before) collection.remove(x.id, { jobId: null, summary: 'Replaced by the ProjectKeeper table' });
      if (before.length) removed[name] = before.length;
    }
    store.sources.putMany(resolved.fresh, trace);
    store.reference.putMany(mapped.reference, trace);
    store.threads.putMany(mapped.threads, trace);
    store.facts.putMany(mapped.facts, trace);
    store.relations.putMany(mapped.relations, trace);
    store.generations.putMany(mapped.generations, trace);
    store.links.putMany(mapped.links, trace);
    store.territories.putMany(mapped.territories, trace);
    store.notes.putMany(mapped.notes, trace);
    // Nodes and the relations the items' claims state, as after any round (scripts/seed-ui-fixture.ts).
    const graph = deriveGraph(store, project);
    // D107: taking the table in is the takeover; the workbench then opens on the picture, not on the Takeover page.
    const filled = (table.project as { filledBy: { agent: string; at: string } }).filledBy;
    project = app.updateProject({ ...app.project(project.id), takenOverByTable: { at: filled.at, by: filled.agent, file: options.tableFile } });
    // The top bar and the opening view read the coverage state ("Not organized yet" sends a project to its Takeover page).
    writeClerkCoverage(app, project.id);
    await store.flush();
    const reference: Record<string, number> = {};
    for (const r of mapped.reference) reference[r.category] = (reference[r.category] ?? 0) + 1;
    return {
      problems: [], projectId: project.id, projectName: project.name, home, added, warnings,
      counts: {
        removed, sources: { cited: resolved.byKey.size, reused: resolved.reused, written: resolved.fresh.length }, reference,
        threads: mapped.threads.length, facts: mapped.facts.length, relations: mapped.relations.length, generations: mapped.generations.length,
        links: mapped.links.length, territories: mapped.territories.length, notes: mapped.notes.length,
        graph: { nodes: graph.nodes, relations: graph.relations },
      },
    };
  });
}

/** For callers that only hold the store (tests): the picture collections' sizes. */
export function pictureSizes(store: ProjectStore): Record<string, number> {
  return Object.fromEntries(PICTURE.map((name) => [name, store.collection(name).size]));
}
