/**
 * Per-project asset store (Spec §8.5). One JSON file per collection under
 * `~/.projectkeeper/projects/<id>/`, written atomically and debounced; `trace.jsonl` records
 * every write with its basis so the owner can ask "why do you think so" (§3.10).
 *
 * The store emits `change` events ({collection, ids}) that the server forwards to open views.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AreaUnderstanding, Authorization, ChangeRecord, ContextPackage, Coverage, EntryMark, FactRecord,
  FollowUpRound, GraphNode, GraphRelation, JudgementRecord, KeeperJob, MergeRecord, ModificationRequest, Note,
  ObjectJudgement, OrganizingPlan, ProjectRule, ReferenceItem, ScopeJudgement, Source, TraceEntry, WorkThread,
} from '../model/types.ts';
import type {
  Breakpoint, ClerkRound, CodeTerritory, Generation, KeeperNumber, LayerEntry, ProcessLink, RoundDoc, SemanticPatch, SendBack, SessionDraft,
} from '../model/k-types.ts';
import { appendJsonLine, readJson, readJsonLines, writeJsonAtomic } from './json-file.ts';
import { projectKeeperHome, projectDir } from './paths.ts';

export interface TraceInfo {
  readonly jobId: string | null;
  readonly basisSourceIds?: readonly string[];
  readonly summary: string;
}

export interface Identified { readonly id: string }

export class Collection<T extends Identified> {
  readonly name: string;
  private readonly items = new Map<string, T>();
  private readonly store: ProjectStore;

  constructor(name: string, store: ProjectStore, initial: readonly T[]) {
    this.name = name;
    this.store = store;
    for (const item of initial) this.items.set(item.id, item);
  }

  all(): T[] { return [...this.items.values()]; }
  get(id: string): T | undefined { return this.items.get(id); }
  has(id: string): boolean { return this.items.has(id); }
  get size(): number { return this.items.size; }
  find(predicate: (item: T) => boolean): T | undefined {
    for (const item of this.items.values()) if (predicate(item)) return item;
    return undefined;
  }
  filter(predicate: (item: T) => boolean): T[] { return this.all().filter(predicate); }

  put(item: T, trace?: TraceInfo): T {
    this.items.set(item.id, item);
    this.store.markDirty(this.name, [item.id]);
    if (trace) this.store.trace({ collection: this.name, id: item.id, op: 'put', ...trace });
    return item;
  }

  putMany(items: readonly T[], trace?: TraceInfo): void {
    if (items.length === 0) return;
    for (const item of items) this.items.set(item.id, item);
    this.store.markDirty(this.name, items.map((i) => i.id));
    if (trace) for (const item of items) this.store.trace({ collection: this.name, id: item.id, op: 'put', ...trace });
  }

  remove(id: string, trace?: TraceInfo): boolean {
    const existed = this.items.delete(id);
    if (existed) {
      this.store.markDirty(this.name, [id]);
      if (trace) this.store.trace({ collection: this.name, id, op: 'remove', ...trace });
    }
    return existed;
  }

  snapshot(): T[] { return this.all(); }

  /** Forget every item, without writing or tracing: the store's `clearAll` removes the files and tells the views. */
  drop(): void { this.items.clear(); }
}

export interface ChangeEvent {
  readonly projectId: string;
  readonly collection: string;
  readonly ids: readonly string[];
}

const COLLECTIONS = [
  'sources', 'facts', 'threads', 'areas', 'reference', 'nodes', 'relations', 'notes', 'changes',
  'marks', 'judgements', 'jobs', 'authorizations', 'requests', 'contexts', 'propagation', 'rounds',
  'rules', 'plans', 'merges', 'scopeJudgements',
  // Increment K (Spec v3.0): the clerk method's positions and markers.
  'breakpoints', 'sendbacks', 'patches', 'numbers', 'drafts', 'territories', 'generations', 'layers', 'roundDocs', 'links', 'clerkRounds',
] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

function emptyCoverage(projectId: string): Coverage {
  return {
    // A project with no assets has not been organized (Spec §1.11, §6.14; D105).
    projectId, state: 'Not organized yet', scopes: [], missingSourceKinds: [], processedByKind: {},
    pendingByKind: {}, updatedAt: new Date().toISOString(),
  };
}

export class ProjectStore extends EventEmitter {
  readonly projectId: string;
  readonly dir: string;
  readonly sources: Collection<Source>;
  readonly facts: Collection<FactRecord>;
  readonly threads: Collection<WorkThread>;
  readonly areas: Collection<AreaUnderstanding>;
  readonly reference: Collection<ReferenceItem>;
  readonly nodes: Collection<GraphNode>;
  readonly relations: Collection<GraphRelation>;
  readonly notes: Collection<Note>;
  readonly changes: Collection<ChangeRecord>;
  readonly marks: Collection<EntryMark>;
  readonly judgements: Collection<JudgementRecord>;
  readonly jobs: Collection<KeeperJob>;
  readonly authorizations: Collection<Authorization>;
  readonly requests: Collection<ModificationRequest>;
  readonly contexts: Collection<ContextPackage>;
  /** §2.10 one judgement per object per round; the entries inside the change records follow from these. */
  readonly propagation: Collection<ObjectJudgement>;
  /** §5.5 one round of Follow up, with its one result. */
  readonly rounds: Collection<FollowUpRound>;
  /** §1.15 the rules the project set for itself: about its material, and about how it works (D62, D64). */
  readonly rules: Collection<ProjectRule>;
  /** §3.7 the plan and focus of the organizing after the framing round (D62); one per project. */
  readonly plans: Collection<OrganizingPlan>;
  /** §1.4 duplicates merged into the work item kept (E64, E65); the merged id resolves through these. */
  readonly merges: Collection<MergeRecord>;
  /** §1.1 the Keeper's classification of scope locations and the owner's corrections (CKC-04 AC-13, AC-17). */
  readonly scopeJudgements: Collection<ScopeJudgement>;
  /** §2.12 breakpoints: a due next step without a trace, hanging on an object (CKC-24 AC-7). */
  readonly breakpoints: Collection<Breakpoint>;
  /** §1.18 send-backs to Work or Plan: Suggested → Returned → Closed (CKC-24 AC-9, AC-10). */
  readonly sendbacks: Collection<SendBack>;
  /** §1.17 semantic patches: what a docs change of meaning withdrew and what replaced it (CKC-26). */
  readonly patches: Collection<SemanticPatch>;
  /** §1.17 the numbers the Keeper gave to what the project did not number (D72). */
  readonly numbers: Collection<KeeperNumber>;
  /** §3.11 one session draft per session (D88). */
  readonly drafts: Collection<SessionDraft>;
  /** §1.19 the judged half of the code territories (CKC-25). */
  readonly territories: Collection<CodeTerritory>;
  /** §2.12 earlier generations of plans (D85). */
  readonly generations: Collection<Generation>;
  /** §3.3 orientation's map of which file is which layer. */
  readonly layers: Collection<LayerEntry>;
  /** §3.3 what a round leaves behind: history map, questions, briefs, reports, adoption record, spot check, result. */
  readonly roundDocs: Collection<RoundDoc>;
  /** §1.4 links between work and ledger entries the program could not make from ids alone. */
  readonly links: Collection<ProcessLink>;
  /** §3.3 the rounds of the clerk method, with what each produced. */
  readonly clerkRounds: Collection<ClerkRound>;
  private coverageDoc: Coverage;
  private readonly dirty = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | null = null;
  private pendingFlush: Promise<void> | null = null;
  private resolveFlush: (() => void) | null = null;

  private constructor(projectId: string, dir: string) {
    super();
    this.projectId = projectId;
    this.dir = dir;
    const load = <T extends Identified>(name: string): T[] => readJson<T[]>(join(dir, `${name}.json`), []);
    this.sources = new Collection('sources', this, load<Source>('sources'));
    this.facts = new Collection('facts', this, load<FactRecord>('facts'));
    this.threads = new Collection('threads', this, load<WorkThread>('threads'));
    this.areas = new Collection('areas', this, load<AreaUnderstanding>('areas'));
    this.reference = new Collection('reference', this, load<ReferenceItem>('reference'));
    this.nodes = new Collection('nodes', this, load<GraphNode>('nodes'));
    this.relations = new Collection('relations', this, load<GraphRelation>('relations'));
    this.notes = new Collection('notes', this, load<Note>('notes'));
    this.changes = new Collection('changes', this, load<ChangeRecord>('changes'));
    this.marks = new Collection('marks', this, load<EntryMark>('marks'));
    this.judgements = new Collection('judgements', this, load<JudgementRecord>('judgements'));
    this.jobs = new Collection('jobs', this, load<KeeperJob>('jobs'));
    this.authorizations = new Collection('authorizations', this, load<Authorization>('authorizations'));
    this.requests = new Collection('requests', this, load<ModificationRequest>('requests'));
    this.contexts = new Collection('contexts', this, load<ContextPackage>('contexts'));
    this.propagation = new Collection('propagation', this, load<ObjectJudgement>('propagation'));
    this.rounds = new Collection('rounds', this, load<FollowUpRound>('rounds'));
    // Added with Spec v2.8. A home written before them has no such files and opens with them empty.
    this.rules = new Collection('rules', this, load<ProjectRule>('rules'));
    this.plans = new Collection('plans', this, load<OrganizingPlan>('plans'));
    this.merges = new Collection('merges', this, load<MergeRecord>('merges'));
    this.scopeJudgements = new Collection('scopeJudgements', this, load<ScopeJudgement>('scopeJudgements'));
    // Added with Spec v3.0 (increment K). A home written before them opens with them empty.
    this.breakpoints = new Collection('breakpoints', this, load<Breakpoint>('breakpoints'));
    this.sendbacks = new Collection('sendbacks', this, load<SendBack>('sendbacks'));
    this.patches = new Collection('patches', this, load<SemanticPatch>('patches'));
    this.numbers = new Collection('numbers', this, load<KeeperNumber>('numbers'));
    this.drafts = new Collection('drafts', this, load<SessionDraft>('drafts'));
    this.territories = new Collection('territories', this, load<CodeTerritory>('territories'));
    this.generations = new Collection('generations', this, load<Generation>('generations'));
    this.layers = new Collection('layers', this, load<LayerEntry>('layers'));
    this.roundDocs = new Collection('roundDocs', this, load<RoundDoc>('roundDocs'));
    this.links = new Collection('links', this, load<ProcessLink>('links'));
    this.clerkRounds = new Collection('clerkRounds', this, load<ClerkRound>('clerkRounds'));
    this.coverageDoc = readJson<Coverage>(join(dir, 'coverage.json'), emptyCoverage(projectId));
  }

  static open(projectId: string, home = projectKeeperHome()): ProjectStore {
    const dir = projectDir(projectId, home);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return new ProjectStore(projectId, dir);
  }

  collection(name: CollectionName): Collection<Identified> {
    return this[name] as unknown as Collection<Identified>;
  }

  get coverage(): Coverage { return this.coverageDoc; }
  setCoverage(coverage: Coverage, trace?: TraceInfo): void {
    this.coverageDoc = { ...coverage, updatedAt: new Date().toISOString() };
    this.markDirty('coverage', ['coverage']);
    if (trace) this.trace({ collection: 'coverage', id: 'coverage', op: 'put', ...trace });
  }

  trace(entry: { collection: string; id: string; op: 'put' | 'remove' } & TraceInfo): void {
    const record: TraceEntry = {
      at: new Date().toISOString(), jobId: entry.jobId, collection: entry.collection, id: entry.id,
      op: entry.op, basisSourceIds: entry.basisSourceIds ?? [], summary: entry.summary,
    };
    appendJsonLine(join(this.dir, 'trace.jsonl'), record);
  }

  traceFor(collection: string, id: string, limit = 50): TraceEntry[] {
    return readJsonLines<TraceEntry>(join(this.dir, 'trace.jsonl'))
      .filter((e) => e.collection === collection && e.id === id).slice(-limit);
  }

  traceByJob(jobId: string, limit = 200): TraceEntry[] {
    return readJsonLines<TraceEntry>(join(this.dir, 'trace.jsonl')).filter((e) => e.jobId === jobId).slice(-limit);
  }

  markDirty(collection: string, ids: readonly string[]): void {
    let set = this.dirty.get(collection);
    if (!set) { set = new Set(); this.dirty.set(collection, set); }
    for (const id of ids) set.add(id);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flushNow(), 40);
      this.timer.unref?.();
    }
  }

  /**
   * Remove every asset of the project (Spec §3.7 清空, §8.5): every collection, the coverage, the trace, and whatever
   * else lies in the project's asset directory — the ledger, the kept versions, the code index. The store stays open,
   * empty; the views are told that everything changed. Returns the entries of the directory that could not be removed
   * (a file another process still holds), so the caller can say so. Nothing outside this directory is touched.
   */
  clearAll(): string[] {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.dirty.clear();
    for (const name of COLLECTIONS) this.collection(name).drop();
    this.coverageDoc = emptyCoverage(this.projectId);
    const left: string[] = [];
    for (const entry of existsSync(this.dir) ? readdirSync(this.dir) : []) {
      try { rmSync(join(this.dir, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch { left.push(entry); }
    }
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    for (const name of [...COLLECTIONS, 'coverage']) this.emit('change', { projectId: this.projectId, collection: name, ids: [] } satisfies ChangeEvent);
    return left;
  }

  /** Persist everything dirty. Resolves once the files are on disk. */
  flush(): Promise<void> {
    if (this.dirty.size === 0 && !this.timer) return Promise.resolve();
    this.flushNow();
    return Promise.resolve();
  }

  private flushNow(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const changed = [...this.dirty.entries()];
    this.dirty.clear();
    for (const [collection] of changed) {
      if (collection === 'coverage') writeJsonAtomic(join(this.dir, 'coverage.json'), this.coverageDoc);
      else if ((COLLECTIONS as readonly string[]).includes(collection)) {
        writeJsonAtomic(join(this.dir, `${collection}.json`), this.collection(collection as CollectionName).snapshot());
      }
    }
    for (const [collection, ids] of changed) {
      const event: ChangeEvent = { projectId: this.projectId, collection, ids: [...ids] };
      this.emit('change', event);
    }
    if (this.resolveFlush) { this.resolveFlush(); this.resolveFlush = null; this.pendingFlush = null; }
  }
}
