/** Program-computed code-map facts. All counts come from the ledger's git and code tables. */
import { linkHolds } from '../model/k-types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import type { Project } from '../model/types.ts';
import type { CodeTerritory, CurrentUse, EvidenceRef, Generation } from '../model/k-types.ts';
import type { CodeLanguageView, TerritoryView, WorkTerritoryView } from '../model/views-k.ts';
import type { Ledger } from '../ledger/index.ts';
import type { BlameSegment } from '../ledger/blame.ts';
import { LANG_BY_EXT, NOT_CODE, compilerReads, fileNameOf, namingOf, namingThatCounts, type Naming } from '../ledger/code.ts';
import { ledgerGit } from '../ledger/git-read.ts';
import { endsWithPath, pathKey } from '../util/paths.ts';
import { earlierWork } from '../keeper/organize/carried-on.ts';

export interface CodeMapFile {
  readonly path: string; readonly lines: number | null; readonly blob: string | null;
  readonly generated: number; readonly classification: string | null; readonly test: number;
  readonly lang: string | null; readonly last_commit: string | null; readonly last_at: string | null;
  readonly test_cases: number;
  /** Who reads its references (`code_files.reader`): `compiler` (the TypeScript compiler), `engine` (the code engine), or nobody (null). */
  readonly reader: string | null;
  /** The reader's name for its language (`code_files.ref_lang`); null when nothing read it. */
  readonly ref_lang: string | null;
  /**
   * The files naming it though no counted reference reaches it, and how (`code_files.named_by`, ledger/code.ts
   * `NamingKind`): a build or manifest file (a named entry point), code (a reference no reader resolved), other text (a mention).
   */
  readonly naming: readonly Naming[];
}

/**
 * What counts as code (Spec §1.19; D98, D98 补), decided by the ledger rather than a list of languages: a file whose
 * references a reader reads — the TypeScript compiler, or the code engine for every other language — or one in a language
 * the ledger knows is code though nothing reads it (code.ts `NOT_CODE` names what is prose or data). The same rule
 * `Ledger.referenceReach` weighs a residual judgement by. Generated, third-party and test files are no territory's code.
 */
export const isCodeFile = (f: Pick<CodeMapFile, 'generated' | 'classification' | 'test' | 'lang' | 'reader'>): boolean =>
  !f.generated && !f.classification && !f.test && (Boolean(f.reader) || (f.lang !== null && !NOT_CODE.has(f.lang)));
/** A file whose own references a reader reads: that nothing reaches it is then a computed fact. */
const isRead = (f: CodeMapFile): boolean => Boolean(f.reader);
/** The language a person reads for a file: its reader's name for it, else the ledger's by extension. */
const languageOf = (f: CodeMapFile): string => f.ref_lang ?? f.lang ?? '(no extension)';
/** The languages the ledger knows are code: its extension table, prose and data left out. */
const CODE_LANGUAGES: ReadonlySet<string> = new Set(Object.values(LANG_BY_EXT).filter((l) => !NOT_CODE.has(l)));

/** One language of the ledger's measured coverage (`Ledger.coverage().languages`). */
type CoverageLanguage = ReturnType<Ledger['coverage']>['languages'][number];

/**
 * How deep the ledger reads each language of the code (Spec §1.16 "看得见", §6.17; D98 补), from the coverage it measured:
 * every language a reader reads, and every language the ledger knows is code but reads nothing of; prose and data are no
 * code. The compiler reads to symbols; the code engine to symbols as far as it resolved them — the imports it resolved to a
 * file of the repository, those it left unresolved though they name one, and the files other files name that no counted
 * reference reaches; a language not read has its files and sizes only. `complete` when every file is read and nothing was
 * measured unresolved: only there can a residual call rest on computed references alone (CKC-25 AC-5).
 */
export function codeLevels(languages: readonly CoverageLanguage[]): CodeLanguageView[] {
  return languages.filter((l) => l.reader !== null || CODE_LANGUAGES.has(l.language)).map((l) => ({
    language: l.language, files: l.files, read: l.read, readBy: l.reader,
    imports: l.reader === 'engine' ? { resolved: l.reach?.imports.resolved ?? 0, unresolvedNamingRepoFiles: l.reach?.imports.unresolvedNamingRepoFiles ?? 0 } : null,
    namedButUnreferenced: l.reach?.namedButUnreferenced ?? 0, parseErrors: l.reach?.parseErrors ?? 0,
    complete: l.reader !== null && l.read === l.files && l.gaps.length === 0, gaps: l.gaps,
  }));
}
export interface CodeMapEdge { readonly src: string; readonly dst: string; readonly kind: string }
interface Commit { hash: string; parents: string; subject: string; body: string; author_at: string; author_ms: number; first_parent_trunk: number; on_trunk: number }
interface Change { hash: string; path: string; old_path: string | null }
type Work = { id: string; label: string };
export interface GenerationOrigin { readonly generationId: string | null; readonly name: string; readonly lines: number; readonly share: number; readonly work: readonly { readonly workId: string | null; readonly label: string; readonly lines: number }[] }
export type CodeAnomalyCandidate = {
  readonly kind: 'Unreferenced file' | 'Unreferenced block' | 'Residual name, referenced' | 'Unclaimed integrated commit' | 'Territory path gone';
  readonly repo: string; readonly territoryId: string | null; readonly path: string | null;
  readonly commit: string | null; readonly detail: string; readonly evidence: readonly EvidenceRef[];
};

export const within = (paths: readonly string[], path: string): boolean => paths.some((raw) => {
  const prefix = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  return path === prefix || path.startsWith(`${prefix}/`);
});
const idIn = (text: string, id: string): boolean => new RegExp(`(^|[^A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^A-Za-z0-9])`, 'i').test(text);
const fileEvidence = (path: string, repo: string): EvidenceRef => ({ kind: 'ledger', id: `file:${path}`, label: path, repo });
const commitEvidence = (hash: string): EvidenceRef => ({ kind: 'ledger', id: `commit:${hash.slice(0, 12)}`, label: hash.slice(0, 12) });
const dateMs = (at: string): number => Date.parse(/^\d{4}-\d\d-\d\d$/.test(at) ? `${at}T23:59:59.999Z` : at);
/** A file with at least 95% older lines is an older-generation importer. */
export const PREVIOUS_GENERATION_THRESHOLD = 0.95;
const entrypoint = (path: string): boolean => /(?:^|\/)(?:main|app|index|cli|bootstrap|application|routes?|router)\.[^.\/]+$/i.test(path);
// Generic words only: whether a name looks residual in one project (a folder still called after the
// product's first idea) is the cross-check's judgement from that project's history, never a rule written for every project (QC AY).
const residualName = (path: string): boolean => /(?:^|[\/_.-])(legacy|old|deprecated|backup|v1)(?=$|[\/_.-])/i.test(path);

/** One index per repository per view. A fresh index uses the current ledger and current workbench assets. */
export class CodeMapIndex {
  readonly files: readonly CodeMapFile[];
  readonly edges: readonly CodeMapEdge[];
  readonly repo: string;
  private readonly ledger: Ledger;
  private readonly store: ProjectStore;
  private readonly fileByPath: Map<string, CodeMapFile>;
  private readonly commits: Map<string, Commit>;
  private readonly changes: readonly Change[];
  private readonly work = new Map<string, Work>();
  private readonly blame: Map<string, BlameSegment[]>;
  private readonly oldGenerations: readonly Generation[];
  private readonly unused: Set<string>;
  /** Unused code that nothing references by no computed fact, with the named file it is reached from (`findUncertain`). */
  private readonly uncertain: Map<string, string>;

  constructor(ledger: Ledger, store: ProjectStore, repo: string) {
    this.ledger = ledger;
    this.store = store;
    this.repo = repo;
    // A ledger not rebuilt since D98 has no `reader` column: the TypeScript compiler's files by extension, as the ledger
    // itself reads it then (Ledger.readerOf); the next rebuild records every reader.
    const recorded = ledger.db.prepare('SELECT * FROM code_files WHERE repo = ?').all(repo) as unknown as (Omit<CodeMapFile, 'reader' | 'ref_lang' | 'naming'> & { reader?: string | null; ref_lang?: string | null; named_by?: string | null })[];
    this.files = recorded.map((r) => ({
      path: r.path, lines: r.lines, blob: r.blob, generated: r.generated, classification: r.classification, test: r.test, lang: r.lang,
      last_commit: r.last_commit, last_at: r.last_at, test_cases: r.test_cases,
      reader: r.reader !== undefined ? r.reader : compilerReads(r.path) ? 'compiler' : null, ref_lang: r.ref_lang ?? null, naming: namingOf(r.named_by),
    }));
    this.fileByPath = new Map(this.files.map((f) => [f.path, f]));
    this.edges = ledger.db.prepare('SELECT src, dst, kind FROM code_deps WHERE repo = ? AND external = 0').all(repo) as unknown as CodeMapEdge[];
    const rows = ledger.db.prepare('SELECT hash, parents, subject, body, author_at, author_ms, first_parent_trunk, on_trunk FROM commits WHERE repo = ?').all(repo) as unknown as Commit[];
    this.commits = new Map(rows.map((r) => [r.hash, r]));
    this.changes = ledger.db.prepare('SELECT hash, path, old_path FROM commit_files WHERE repo = ?').all(repo) as unknown as Change[];
    const cached = ledger.db.prepare('SELECT b.path, b.segments FROM code_blame b JOIN code_files f ON f.repo = b.repo AND f.path = b.path AND f.blob = b.blob WHERE b.repo = ?').all(repo) as { path: string; segments: string }[];
    this.blame = new Map(cached.map((r) => [r.path, JSON.parse(r.segments) as BlameSegment[]]));
    this.oldGenerations = store.generations.filter((g) => g.projectId === store.projectId).sort((a, b) => dateMs(a.ended.at) - dateMs(b.ended.at));
    this.assignWork();
    const { unused, outgoing } = this.findUnused();
    this.unused = unused;
    this.uncertain = this.findUncertain(outgoing);
  }

  private assignWork(): void {
    const names = new Map<string, Work>();
    for (const t of this.store.threads.all()) {
      const label = `${t.ids[0] ?? ''} ${t.title}`.trim();
      for (const id of t.ids) names.set(id.toLowerCase(), { id: t.id, label });
    }
    for (const n of this.store.numbers.all()) {
      if (n.objectKind !== 'work') continue;
      const t = this.store.threads.get(n.objectId);
      if (!t) continue;
      for (const id of [n.number, n.projectNumber].filter((x): x is string => Boolean(x))) names.set(id.toLowerCase(), { id: t.id, label: `${t.ids[0] ?? n.number} ${t.title}`.trim() });
    }
    const uniqueMatch = (text: string): Work | null => {
      const found = new Map<string, Work>();
      for (const [id, w] of names) if (idIn(text, id)) found.set(w.id, w);
      return found.size === 1 ? [...found.values()][0]! : null;
    };
    const numbers = this.ledger.db.prepare("SELECT commit_hash, num FROM nums WHERE repo = ? AND kind = 'commit'").all(this.repo) as { commit_hash: string; num: string }[];
    const byHash = new Map<string, string[]>();
    for (const n of numbers) byHash.set(n.commit_hash, [...(byHash.get(n.commit_hash) ?? []), n.num]);
    for (const c of this.commits.values()) {
      const ledgerNums = byHash.get(c.hash)?.map((n) => names.get(n.toLowerCase())).filter((w): w is Work => Boolean(w)) ?? [];
      const fromNums = new Map(ledgerNums.map((w) => [w.id, w]));
      const fromText = uniqueMatch(`${c.subject}\n${c.body}`);
      if (fromText) this.work.set(c.hash, fromText);
      else if (fromNums.size === 1) this.work.set(c.hash, [...fromNums.values()][0]!);
    }
    // Confirmed process links take precedence over textual guesses.
    for (const link of this.store.links.all()) {
      if (!linkHolds(link) || !this.store.threads.has(link.workId)) continue;
      const ref = link.ledgerRef.replace(/^commit:/, '').toLowerCase();
      if (!/^[0-9a-f]{7,40}$/.test(ref)) continue;
      const commit = [...this.commits.keys()].find((h) => h.startsWith(ref));
      if (commit) { const t = this.store.threads.get(link.workId)!; this.work.set(commit, { id: t.id, label: `${t.ids[0] ?? ''} ${t.title}`.trim() }); }
    }
    const branches = this.ledger.db.prepare('SELECT name, tip FROM branches WHERE repo = ? AND merged = 1').all(this.repo) as { name: string; tip: string }[];
    const branchWork = new Map<string, Work>();
    for (const b of branches) { const w = uniqueMatch(b.name); if (w) branchWork.set(b.tip, w); }
    // A retained branch identifies its tip. On a merge it also identifies the merge that integrated the tip.
    for (const [tip, w] of branchWork) {
      if (!this.work.has(tip)) this.work.set(tip, w);
      for (const c of this.commits.values()) if (c.first_parent_trunk && c.parents.split(' ').slice(1).includes(tip) && !this.work.has(c.hash)) this.work.set(c.hash, w);
    }
    const repoPath = this.ledger.repos().find((r) => r.id === this.repo)?.path;
    const trunk = this.ledger.repos().find((r) => r.id === this.repo)?.trunkTip;
    const ordered = repoPath && trunk ? ledgerGit(repoPath, ['rev-list', '--first-parent', trunk]) : null;
    const first = ordered?.ok ? ordered.out.trim().split(/\s+/).filter(Boolean) : [...this.commits.values()].filter((c) => c.first_parent_trunk).sort((a, b) => b.author_ms - a.author_ms).map((c) => c.hash);
    // Fast-forward branches have no merge commit. Attribute the contiguous run back to the previous integration or
    // explicitly labelled work, never across a merge or a different known work item.
    for (const [tip, w] of branchWork) {
      if (!this.commits.get(tip)?.first_parent_trunk) continue;
      const start = first.indexOf(tip);
      for (let i = start + 1; start >= 0 && i < first.length; i++) {
        const c = this.commits.get(first[i]!);
        if (!c || c.parents.split(' ').length > 1 || (this.work.has(c.hash) && this.work.get(c.hash)?.id !== w.id)) break;
        if (!this.work.has(c.hash)) this.work.set(c.hash, w);
      }
    }
    // A side commit's blame belongs to the work integrated by the first-parent merge that brought it in.
    for (const hash of [...first].reverse()) {
      const merge = this.commits.get(hash);
      const parents = merge?.parents.split(' ').filter(Boolean) ?? [];
      const w = this.work.get(hash);
      if (!w || parents.length < 2) continue;
      const base = new Set<string>();
      const visit = (start: string, into: Set<string>) => {
        const stack = [start];
        while (stack.length) { const h = stack.pop()!; if (into.has(h)) continue; into.add(h); stack.push(...(this.commits.get(h)?.parents.split(' ').filter(Boolean) ?? [])); }
      };
      visit(parents[0]!, base);
      const side = new Set<string>();
      for (const p of parents.slice(1)) visit(p, side);
      for (const h of side) if (!base.has(h) && !this.work.has(h)) this.work.set(h, w);
    }
  }

  workForCommit(hash: string | null): Work | null { return hash ? this.work.get(hash) ?? null : null; }
  generationForCommit(hash: string): Generation | null {
    const commit = this.commits.get(hash);
    if (!commit) return null;
    return this.oldGenerations.find((g) => /^\d{4}-\d\d-\d\d$/.test(g.ended.at)
      ? commit.author_at.slice(0, 10) <= g.ended.at : commit.author_ms <= dateMs(g.ended.at)) ?? null;
  }
  private linesOf(path: string): BlameSegment[] { return this.blame.get(path) ?? []; }
  private oldShare(path: string): number {
    const segments = this.linesOf(path);
    const total = segments.reduce((n, s) => n + s.end - s.start + 1, 0);
    return total ? segments.reduce((n, s) => n + (this.generationForCommit(s.commit) ? s.end - s.start + 1 : 0), 0) / total : 0;
  }
  /**
   * Code no reference walk from an anchor reaches, over every code file: what a reader reads counts exactly as TypeScript
   * does, and code nothing reads can still be reached by a reference from code that is read. That nothing reaches a file
   * whose own references nobody reads is a candidate, not a computed fact (`currentUse`, `anomalies`).
   */
  private findUnused(): { unused: Set<string>; outgoing: Map<string, string[]> } {
    const source = new Set(this.files.filter(isCodeFile).map((f) => f.path));
    const outgoing = new Map<string, string[]>();
    for (const e of this.edges) if (source.has(e.src) && source.has(e.dst)) outgoing.set(e.src, [...(outgoing.get(e.src) ?? []), e.dst]);
    const roots = new Set(this.files.filter((f) => source.has(f.path) && entrypoint(f.path)).map((f) => f.path));
    // Entry points and files directly owned by current work are explicit anchors. Without either, an isolated component
    // remains a candidate: one a build or manifest file names says so (`findUncertain`); model review can recognise it,
    // and dynamic registration, reflection or manually run scripts.
    for (const f of this.files) if (source.has(f.path) && f.last_commit && this.workForCommit(f.last_commit)
      && !this.generationForCommit(f.last_commit) && !this.oldWork().has(this.workForCommit(f.last_commit)!.id)) roots.add(f.path);
    const reached = new Set<string>();
    const stack = [...roots];
    while (stack.length) { const path = stack.pop()!; if (reached.has(path)) continue; reached.add(path); stack.push(...(outgoing.get(path) ?? [])); }
    return { unused: new Set([...source].filter((p) => !reached.has(p))), outgoing };
  }
  /**
   * Unused code of which it is no computed fact that nothing uses it (ledger/code.ts `NamingKind`): what a build or manifest
   * file names (a named entry point), what code the walk reaches names (a reference its reader did not resolve), and the
   * unused code only such files reach through file references — each with the named file it is reached from (itself, when
   * it is named). Code named only by code nothing reaches, or by tests, stays unreferenced as computed: whatever that
   * reference is, it comes from code that is not live. A mention in a document or other text references nothing.
   */
  private findUncertain(outgoing: ReadonlyMap<string, readonly string[]>): Map<string, string> {
    const live = (n: Naming) => n.kind === 'entry' || (n.kind === 'reference' && !this.unused.has(n.path) && !this.fileByPath.get(n.path)?.test);
    const from = new Map<string, string>();
    const stack: string[] = [];
    for (const f of this.files) if (this.unused.has(f.path) && f.naming.some(live)) { from.set(f.path, f.path); stack.push(f.path); }
    while (stack.length) {
      const path = stack.pop()!;
      for (const next of outgoing.get(path) ?? []) if (this.unused.has(next) && !from.has(next)) { from.set(next, from.get(path)!); stack.push(next); }
    }
    return from;
  }
  isUnused(path: string): boolean { return this.unused.has(path); }
  /**
   * What an Unreferenced file candidate says beyond the walk: that nothing reads its references; that a build or manifest
   * file names it — a named entry point, "named in AndroidManifest.xml"; that code names it — a reference its reader did not
   * resolve; that only such files reach it. Any of these makes a judgement there Inferred (Ledger.referenceReach). A
   * mention in a document or other text is said too; it references nothing.
   */
  private namedWords(f: CodeMapFile): string {
    const of = (kind: Naming['kind']) => f.naming.filter((n) => n.kind === kind).map((n) => n.path);
    const entry = of('entry');
    const code = of('reference');
    const mention = of('mention');
    const via = this.uncertain.get(f.path);
    const why = [
      isRead(f) ? null : `The ledger reads no references of this ${languageOf(f)} file, so a use from code nobody reads would not show.`,
      entry.length ? `It is a named entry point: named in ${entry.map((p) => `${fileNameOf(p)} (${p})`).join(', ')}, a build or manifest file, which compiles, launches, loads or runs it.` : null,
      code.length ? `Named in ${code.map((p) => `${p}${this.unused.has(p) ? ', which nothing reaches either' : ''}`).join('; ')}: a reference its reader did not resolve.` : null,
      via && via !== f.path ? `Only files other files name reach it, from ${via} (${[...new Set(namingThatCounts(this.fileByPath.get(via)?.naming ?? []).map((n) => `named in ${fileNameOf(n.path)}`))].join(', ')}).` : null,
    ].filter((x): x is string => x !== null);
    return `${why.length ? ` ${why.join(' ')} A judgement here is Inferred.` : ''}${mention.length ? ` Mentioned in ${mention.join(', ')}, which reference${mention.length === 1 ? 's' : ''} nothing.` : ''}`;
  }
  /**
   * Code that nothing reaches, some of it read by a reader, none of it named by live files: nothing reaching code whose
   * references are read is a computed fact. Code nothing reads and nothing reaches is not shown to be unreferenced — nobody
   * reads the references that would; nor is code holding a named entry point, a file live code names, or code only they
   * reach (`findUncertain`): it may be entered from there.
   */
  private allUnused(files: readonly CodeMapFile[]): boolean {
    return files.length > 0 && files.every((f) => this.unused.has(f.path)) && files.some(isRead) && !files.some((f) => this.uncertain.has(f.path));
  }

  builtBy(paths: readonly string[]): TerritoryView['builtBy'] {
    const rows = new Map<string, { workId: string | null; label: string; commits: Set<string>; files: Set<string> }>();
    for (const change of this.changes) {
      if (!this.commits.get(change.hash)?.first_parent_trunk || !(within(paths, change.path) || (change.old_path && within(paths, change.old_path)))) continue;
      const w = this.workForCommit(change.hash);
      const key = w?.id ?? `commit:${change.hash}`;
      const c = this.commits.get(change.hash)!;
      const row = rows.get(key) ?? { workId: w?.id ?? null, label: w?.label ?? `Unclaimed · ${c.subject}`, commits: new Set<string>(), files: new Set<string>() };
      row.commits.add(change.hash.slice(0, 12));
      row.files.add(change.path);
      rows.set(key, row);
    }
    return [...rows.values()].sort((a, b) => b.files.size - a.files.size || a.label.localeCompare(b.label)).map((r) => ({ workId: r.workId, label: r.label, commits: [...r.commits], files: r.files.size }));
  }

  generationOrigins(paths: readonly string[]): GenerationOrigin[] {
    const groups = new Map<string, { generationId: string | null; name: string; lines: number; work: Map<string, { workId: string | null; label: string; lines: number }> }>();
    let total = 0;
    for (const f of this.files) {
      if (!within(paths, f.path) || !isCodeFile(f)) continue;
      // The rebuild blames the files a reader reads (ledger/blame.ts): code nothing reads adds no lines here.
      for (const s of this.linesOf(f.path)) {
        const n = s.end - s.start + 1;
        const generation = this.generationForCommit(s.commit);
        const key = generation?.id ?? 'current';
        const row = groups.get(key) ?? { generationId: generation?.id ?? null, name: generation?.name ?? 'Current generation', lines: 0, work: new Map() };
        const w = this.workForCommit(s.commit);
        const wk = w?.id ?? `commit:${s.commit}`;
        const wr = row.work.get(wk) ?? { workId: w?.id ?? null, label: w?.label ?? `Unclaimed · ${s.commit.slice(0, 12)}`, lines: 0 };
        wr.lines += n; row.work.set(wk, wr); row.lines += n; total += n;
        groups.set(key, row);
      }
    }
    return [...groups.values()].sort((a, b) => b.lines - a.lines).map((r) => ({ generationId: r.generationId, name: r.name, lines: r.lines, share: total ? r.lines / total : 0, work: [...r.work.values()].sort((a, b) => b.lines - a.lines) }));
  }

  /**
   * Whether the current plan still uses this code (§1.19, D85). The references say whether current code reaches it; the
   * plan's own objects say whether anything current points at it: `In current plan` needs both (QC AY: it had been given
   * on the references alone). `paths` are a territory's; the territory itself (its area) is found by them in the store.
   */
  currentUse(paths: readonly string[]): CurrentUse {
    const mine = this.files.filter((f) => within(paths, f.path) && isCodeFile(f));
    // No code here: its use can be neither shown nor ruled out (§1.16).
    if (!mine.length) return 'Not known';
    if (this.allUnused(mine)) return 'Unreferenced';
    // Nothing reaches it, and nobody reads the references of any of it, or it holds a named entry point or code live files
    // name (`findUncertain`): not shown either way.
    if (mine.every((f) => this.unused.has(f.path))) return 'Not known';
    const incoming = this.edges.filter((e) => within(paths, e.dst) && !within(paths, e.src) && !this.fileByPath.get(e.src)?.test && !this.unused.has(e.src));
    if (incoming.length && incoming.every((e) => this.oldShare(e.src) >= PREVIOUS_GENERATION_THRESHOLD)) return 'Previous generation only';
    return this.pointedAtByPlan(paths) ? 'In current plan' : 'In use, not in current plan';
  }

  /**
   * The work items of earlier generations (`Generation.workIds`): not current work, whatever their progress. CZ: less
   * the items carried on under the same number, which are the current plan's.
   */
  private oldWork(): Set<string> {
    return earlierWork(this.store);
  }

  /** A work item that is current: in force, and not planned in an earlier generation. */
  private currentWork(workId: string, old = this.oldWork()): boolean {
    const t = this.store.threads.get(workId);
    return Boolean(t && t.validity === 'Current' && !old.has(workId));
  }

  /**
   * Current work or requirements point at this code (§1.19 "被现行的工作和需求指着"): a current work item of the current
   * generation changed it (its trunk commits and merges, as `Built by` counts them), or the area the territory serves —
   * mainly or also — has requirements, designs, decisions, plans or work items in force. The territory's area is the
   * cross-check's judgement; the objects in force are the assets'.
   */
  pointedAtByPlan(paths: readonly string[]): boolean {
    const old = this.oldWork();
    for (const change of this.changes) {
      if (!this.commits.get(change.hash)?.first_parent_trunk || !(within(paths, change.path) || (change.old_path && within(paths, change.old_path)))) continue;
      const w = this.workForCommit(change.hash);
      if (w && this.currentWork(w.id, old) && !this.generationForCommit(change.hash)) return true;
    }
    const territory = this.territoryOf(paths);
    const areas = new Set([territory?.areaId, ...(territory?.alsoServes ?? [])].filter((a): a is string => Boolean(a)));
    if (!areas.size) return false;
    const PLAN = new Set(['Requirement', 'Design', 'Decision', 'Plan', 'Work item']);
    return this.store.nodes.find((n) => n.areaId !== null && areas.has(n.areaId) && PLAN.has(n.category) && n.validity === 'Current'
      && (n.category !== 'Work item' || this.currentWork(n.refId, old))) !== undefined;
  }

  /** The territory of this repository drawn on exactly these paths, when there is one (the unmapped directories have none).
   *  Its repository is matched as `Code` matches it (ledger/views.ts `repoOf`): by id, path or the path's last part, else the main one. */
  private territoryOf(paths: readonly string[]): CodeTerritory | undefined {
    const norm = (ps: readonly string[]) => [...ps].map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '')).sort().join('\n');
    const key = norm(paths);
    const repos = this.ledger.repos();
    const repoOf = (t: CodeTerritory) => (repos.find((r) => r.id === t.repo || pathKey(r.path) === pathKey(t.repo) || endsWithPath(r.path, t.repo)) ?? repos[0])?.id;
    return this.store.territories.find((t) => norm(t.paths) === key && repoOf(t) === this.repo);
  }

  /** The paths the current version has no file at or under: deleted or moved since the territory was drawn (CKC-25 AC-10). */
  gonePaths(paths: readonly string[]): string[] {
    return paths.filter((p) => !this.files.some((f) => within([p], f.path)));
  }

  /**
   * The territories each work item changed (§6.17 "从过程视图的工作跳到它改过的领地"), by work id: the files its trunk
   * commits and merges changed in each, counted exactly as `builtBy` counts them — so a territory's `Built by` and the
   * work's jump back to it give the same number. Most files first.
   */
  territoriesByWork(territories: readonly Pick<CodeTerritory, 'id' | 'name' | 'paths'>[]): Map<string, WorkTerritoryView[]> {
    const acc = new Map<string, Map<string, { name: string; files: Set<string>; commits: Set<string> }>>();
    for (const change of this.changes) {
      if (!this.commits.get(change.hash)?.first_parent_trunk) continue;
      const w = this.workForCommit(change.hash);
      if (!w) continue;
      for (const t of territories) {
        if (!(within(t.paths, change.path) || (change.old_path && within(t.paths, change.old_path)))) continue;
        const byTerritory = acc.get(w.id) ?? new Map();
        const row = byTerritory.get(t.id) ?? { name: t.name, files: new Set<string>(), commits: new Set<string>() };
        row.files.add(change.path);
        row.commits.add(change.hash);
        byTerritory.set(t.id, row);
        acc.set(w.id, byTerritory);
      }
    }
    const byTime = (a: string, b: string) => (this.commits.get(a)?.author_ms ?? 0) - (this.commits.get(b)?.author_ms ?? 0);
    return new Map([...acc].map(([workId, rows]) => [workId, [...rows].map(([territoryId, r]) => ({
      territoryId, name: r.name, files: r.files.size, commits: [...r.commits].sort(byTime).map((h) => h.slice(0, 12)),
    })).sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))]));
  }

  dependencyCounts(paths: readonly string[], other: readonly { id: string; paths: readonly string[] }[]): { dependsOn: Record<string, number>; dependedBy: Record<string, number> } {
    const dependsOn: Record<string, number> = {};
    const dependedBy: Record<string, number> = {};
    const seen = new Set<string>();
    for (const e of this.edges) {
      if (this.fileByPath.get(e.src)?.test || this.fileByPath.get(e.dst)?.test) continue;
      const pair = `${e.src}\0${e.dst}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      for (const o of other) {
        if (within(paths, e.src) && within(o.paths, e.dst) && !within(paths, e.dst)) dependsOn[o.id] = (dependsOn[o.id] ?? 0) + 1;
        if (within(o.paths, e.src) && within(paths, e.dst) && !within(paths, e.src)) dependedBy[o.id] = (dependedBy[o.id] ?? 0) + 1;
      }
    }
    return { dependsOn, dependedBy };
  }

  anomalies(territories: readonly Pick<CodeTerritory, 'id' | 'paths'>[]): CodeAnomalyCandidate[] {
    const out: CodeAnomalyCandidate[] = [];
    const territory = (path: string) => territories.find((t) => within(t.paths, path))?.id ?? null;
    for (const f of this.files.filter(isCodeFile)) {
      // Code nothing reads is a candidate too (D98 补): what would show its use may be in references nobody reads, so the
      // detail says so and the judgement's basis follows Ledger.referenceReach (Inferred there). So does code other files
      // name: a named entry point, a reference no reader resolved, and what only such code reaches.
      if (this.unused.has(f.path)) out.push({ kind: 'Unreferenced file', repo: this.repo, territoryId: territory(f.path), path: f.path, commit: null,
        detail: `No path from a conventional entry point or currently claimed work through non-test file references.${this.namedWords(f)}`,
        evidence: [fileEvidence(f.path, this.repo), ...f.naming.map((n) => fileEvidence(n.path, this.repo))] });
      const refs = this.edges.filter((e) => e.dst === f.path && !this.fileByPath.get(e.src)?.test);
      if (residualName(f.path) && refs.length) out.push({ kind: 'Residual name, referenced', repo: this.repo, territoryId: territory(f.path), path: f.path, commit: null,
        detail: `${refs.length} non-test file references`, evidence: [fileEvidence(f.path, this.repo), ...refs.map((e) => fileEvidence(e.src, this.repo))] });
    }
    for (const t of territories) {
      // A territory drawn on a path the current version no longer has: its numbers shrink to what is left, so the round
      // redraws it on the current paths rather than let it count nothing in silence (CKC-25 AC-10; QC AY B13).
      const gone = this.gonePaths(t.paths);
      if (gone.length) {
        const history = gone.map((p) => ({ p, last: [...this.changes].filter((c) => within([p], c.path) || (c.old_path !== null && within([p], c.old_path))).sort((a, b) => (this.commits.get(b.hash)?.author_ms ?? 0) - (this.commits.get(a.hash)?.author_ms ?? 0))[0] ?? null }));
        out.push({ kind: 'Territory path gone', repo: this.repo, territoryId: t.id, path: gone.join(', '), commit: history.find((h) => h.last)?.last?.hash.slice(0, 12) ?? null,
          detail: `${gone.length === t.paths.length ? `none of its paths is in the current version any more (${gone.join(', ')})` : `${gone.length} of its ${t.paths.length} paths ${gone.length === 1 ? 'is' : 'are'} no longer in the current version (${gone.join(', ')})`}; redraw it on the paths its code has now (pk_write_territory with its id), or let it go if its code went elsewhere`,
          evidence: history.flatMap((h) => (h.last ? [commitEvidence(h.last.hash)] : [])) });
      }
      const files = this.files.filter((f) => within(t.paths, f.path) && isCodeFile(f));
      // As `currentUse` says `Unreferenced`: nothing reaches it, some of it is read, and nothing in it is named by live files.
      const notRead = files.filter((f) => !isRead(f)).length;
      if (this.allUnused(files)) out.push({ kind: 'Unreferenced block', repo: this.repo, territoryId: t.id, path: t.paths.join(', '), commit: null,
        detail: `${files.length} current source files are outside the non-test reference closure${notRead ? `; the ledger reads no references of ${notRead} of them` : ''}`, evidence: files.map((f) => fileEvidence(f.path, this.repo)) });
      if (t.paths.some(residualName)) {
        const referenced = files.filter((f) => this.edges.some((e) => e.dst === f.path && !this.fileByPath.get(e.src)?.test && !within(t.paths, e.src)));
        if (referenced.length) out.push({ kind: 'Residual name, referenced', repo: this.repo, territoryId: t.id, path: t.paths.join(', '), commit: null,
          detail: `${referenced.length} current source files have non-test external references`, evidence: referenced.map((f) => fileEvidence(f.path, this.repo)) });
      }
    }
    const unclaimed = new Map<string, { hash: string; territoryId: string | null; paths: Set<string> }>();
    for (const c of this.changes) {
      if (!this.commits.get(c.hash)?.first_parent_trunk || this.workForCommit(c.hash)) continue;
      const tid = territory(c.path);
      const key = `${c.hash}\0${tid ?? ''}`;
      const row = unclaimed.get(key) ?? { hash: c.hash, territoryId: tid, paths: new Set<string>() };
      row.paths.add(c.path);
      unclaimed.set(key, row);
    }
    for (const row of unclaimed.values()) {
      const paths = [...row.paths].sort();
      out.push({ kind: 'Unclaimed integrated commit', repo: this.repo, territoryId: row.territoryId, path: paths[0] ?? null, commit: row.hash.slice(0, 12),
        detail: `${this.commits.get(row.hash)!.subject}: ${paths.length} changed files on the trunk without a work item match`,
        evidence: [commitEvidence(row.hash), ...paths.map((p) => fileEvidence(p, this.repo))] });
    }
    return out;
  }
}

/** The cross-check's input; these are candidates, never the model's anomaly judgement. */
export function codeAnomalyCandidates(ledger: Ledger, store: ProjectStore, project: Project): CodeAnomalyCandidate[] {
  const out: CodeAnomalyCandidate[] = [];
  for (const repo of ledger.repos()) {
    const t = store.territories.filter((x) => x.projectId === project.id && (x.repo === repo.id || x.repo === repo.path));
    const index = new CodeMapIndex(ledger, store, repo.id);
    const blocks = t.length ? t : [...new Set(index.files.filter(isCodeFile).map((f) => f.path.split('/').slice(0, -1).join('/')).filter(Boolean))]
      .map((path) => ({ id: `directory:${repo.id}:${path}`, paths: [path] }));
    out.push(...index.anomalies(blocks));
  }
  return out;
}
