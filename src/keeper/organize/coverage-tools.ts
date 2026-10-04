/**
 * The coverage check of a deepening (D99; Spec §3.3 "每份材料都有交代", §3.7; CKC-23 AC-20). Coverage is a check after
 * the lanes, not the unit work is handed out by: once the lanes the main agent sent have ended, the program holds what
 * they read against the plan and lists what no lane touched; the main agent accounts for it — not needed, or read in
 * part, with why — or sends a follow-up lane, whose reads settle what it read; what it did not read is listed again once
 * it has ended. The cross-check of a `Full` deepening starts only when every planned material is read whole or
 * accounted for (`coverageSettled`, coverage-gate.ts).
 *
 * The plan (Spec §3.3: 计划):
 * - what the organizing plan says to read closely (reading.ts `readCloselyOf`), as the plan names it — its own targets
 *   decide, as they do for the rest of the organizing;
 * - what this round's lane briefs name (`namedInBrief`, resolved through the ledger the way the plan's entries are);
 * - a brief or plan entry that names a kind of material and nothing the ledger can count (a lane named for the owner's
 *   meaning, the document chain, the process and checks, or the code, `sweepKindsOf`) plans that whole category: the
 *   ledger's current documents, its code files, every commit, every session — each category once, however many lanes
 *   name it;
 * - what the project's rules settle is left out (§1.15: the places its material rules keep for reference, recovery or
 *   as obsolete, the organizing plan's own rule entries, the files a rule set `Reference only` or `History only`).
 * Material is counted by file, commit and session: a document is one material, and its older versions are never
 * separate items — history is looked up by question (§3.3 按问题深挖).
 *
 * What was read is the program's record, never the lanes' own account (Spec §3.3: 读了什么由程序记): the reads the
 * runtime recorded on the round's lane jobs, everything they sent, and the main job (`tallyReads`). A document counts
 * as read whole when the file as it stands was read whole — a deleted one when its last version was; a code file when
 * it was read whole; a commit when it was read (its message and every file it changed); a session when every message
 * was shown. The clerk's own skills folder is not the project's material and does not count.
 *
 * Items are grouped by category and top directory (a nested repository's folder and the directory under it), commits by
 * repository and sessions by host, so the main agent can account for a group in one call.
 *
 * What a listed group holds (DA; E156, the flash run: 637 materials in 17 groups written off in 80 seconds with "no open
 * item points here", no lane sent, 35 reports unread). For each listed group the program counts what its materials hold
 * that nothing on the workbench carries (`materialHolds`), with a few examples:
 * - verdict lines: the ledger's stated verdicts in its documents (the detection the process and the QC facts use) that
 *   no link and no fact of a work item cites;
 * - numbers: the numbers its documents define as their own entries (entries.ts) that no item carries and no account
 *   names (entry-gate.ts);
 * - the owner's lines not looked at yet (owner-lines.ts) that its documents quote, or its sessions hold.
 * A group that holds any of these is not accounted for as a group: the main agent sends a lane for it, or accounts for
 * each holding material by its key, with its own reason. A group that holds nothing is accounted for as before — a
 * project without reports, a decision log or sessions has nothing held, and nothing is refused. Code files and commits
 * hold none of the three: the ledger reads verdicts and entry definitions in documents, and on copies of the CQ and
 * flash runs neither kind of group held anything a count could mean. The same measurement set the narrowing above — the
 * ledger's candidate verdict words, its test counts and its findings lit up on prose, dates and table cells, and a
 * contract's acceptance rows are the contract's points.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ClerkRound, ClerkStage, GroupHolds, HoldCount, MaterialAccount, ReadingMaterial, RoundCoverage } from '../../model/k-types.ts';
import type { KeeperJob, OrganizingPlanContent, Project } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { Ledger } from '../../ledger/index.ts';
import { definitionsInPath, familyOf } from '../../ledger/numbering.ts';
import { readJson } from '../../store/json-file.ts';
import { workspaceFile } from '../../store/paths.ts';
import { isWithin, pathKey } from '../../util/paths.ts';
import { STAGE_WRITERS } from '../clerk-steps.ts';
import { planEntryFor } from '../rules.ts';
import type { ToolContext } from '../tools.ts';
import { DEEPENING_PATHS, sweepKindsOf, type SweepKind } from './clerk-prompts.ts';
import { tallyReads, type ReadTally } from './clerk-coverage.ts';
import { accountedEntries, carriedNumbers } from './entry-gate.ts';
import { entryDefinitions, headingLines } from './entries.ts';
import { DISTINCT_WORDS, fold, lineKey, uncitedOwnerLines } from './owner-lines.ts';
import { isClerkSkillPath } from './skills.ts';
import { settledAwayMaterials } from './materials.ts';
import { ORGANIZING_PLAN_ID, readCloselyNow, readCloselyOf, readsOf, settlingDirs, underAny, withDescendants, type NamedMaterials } from './reading.ts';

// ───────────────────────── documents, one material each ─────────────────────────

/** One version of a document as the ledger has it. */
interface VersionRow { readonly key: string; readonly repo: string; readonly path: string; readonly commit: string; readonly bytes: number; readonly lines: number; readonly atMs: number; readonly current: boolean }

/**
 * The version that stands for each document (Spec §3.3: 一份文档的各个旧版本不单列): the one the file as it stands has,
 * else its latest — for a deleted document, its last. One entry per document, in the order first met.
 */
export function standingVersions(ledger: Ledger, versions: readonly { readonly key: string }[], rows: readonly VersionRow[] = ledger.versionsByKey(versions.map((x) => x.key))): VersionRow[] {
  const byDoc = new Map<string, VersionRow>();
  for (const v of rows) {
    const doc = `${v.repo}:${v.path}`;
    const had = byDoc.get(doc);
    if (!had || (v.current && !had.current) || (v.current === had.current && v.atMs > had.atMs)) byDoc.set(doc, v);
  }
  return [...byDoc.values()];
}

/** `standingVersions` as the `{ key, path }` lists the depth question counts with (takeover-clerk.ts). */
export function oneVersionPerDocument(ledger: Ledger, versions: readonly { readonly key: string; readonly path: string }[]): { key: string; path: string }[] {
  if (!versions.length) return [];
  const rows = ledger.versionsByKey(versions.map((v) => v.key));
  const standing = standingVersions(ledger, versions, rows);
  // A version the ledger no longer has rows for is kept as it was named: nothing is dropped silently.
  const known = new Set(rows.map((v) => v.key));
  const kept = new Map<string, { key: string; path: string }>();
  for (const v of standing) kept.set(`${v.repo}:${v.path}`, { key: v.key, path: v.path });
  const unknown = versions.filter((v) => !known.has(v.key));
  return [...kept.values(), ...new Map(unknown.map((v) => [v.path, { key: v.key, path: v.path }])).values()];
}

const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };

/** The ledger's documents that are in the project now (on disk), one per document, with the version that stands for each. */
export function currentDocuments(ledger: Ledger): { readonly row: VersionRow; readonly file: string }[] {
  const roots = new Map(ledger.repos().map((r) => [r.id, r.path]));
  return standingVersions(ledger, ledger.allVersions()).flatMap((row) => {
    const root = roots.get(row.repo);
    const file = root ? join(root, ...row.path.split('/')) : null;
    return file && isFile(file) ? [{ row, file }] : [];
  });
}

// ───────────────────────── the items the check holds against what was read ─────────────────────────

export type CoverageCategory = 'documents' | 'code files' | 'commits' | 'sessions';
const CATEGORY_ORDER: readonly CoverageCategory[] = ['documents', 'code files', 'commits', 'sessions'];
/** The category a kind of question plans whole when its brief names nothing countable. */
const KIND_CATEGORY: Readonly<Record<SweepKind, CoverageCategory>> = {
  [DEEPENING_PATHS[0]]: 'sessions', [DEEPENING_PATHS[1]]: 'documents', [DEEPENING_PATHS[2]]: 'commits', [DEEPENING_PATHS[3]]: 'code files',
} as Record<SweepKind, CoverageCategory>;

/** One planned material: what the main agent sees, and what its reads are held against (reading.ts `readsOf`). */
export interface CoverageItem {
  /** `doc:<path>`, `file:<path>` (paths as the project names them), `commit:<hash>`, or the ledger's session id. */
  readonly key: string;
  readonly category: CoverageCategory;
  readonly label: string;
  /** Its top directory (a nested repository's folder with the directory under it), a commit's repository, a session's host. */
  readonly dir: string;
  readonly bytes: number;
  readonly material: ReadingMaterial;
}

/** One group of listed items, as `pk_coverage_check` returns it. */
export interface CoverageGroup {
  readonly group: string;
  readonly category: CoverageCategory;
  readonly dir: string;
  readonly count: number;
  readonly bytes: number;
  readonly keys: readonly string[];
  /** Added to the W0 shape: nothing of these was read (`none`), or only a part (`part`: account with outcome part and why). */
  readonly read: 'none' | 'part';
  /** Added: how many keys are not shown (the first 20 are, unless the group was asked for). */
  readonly more?: number;
  /** DA: what the group holds that nothing carries; absent when it holds nothing. */
  readonly holds?: GroupHolds;
}

/** The coverage of a round as it stands now. */
export interface CoverageState {
  /** Every planned material, each once. */
  readonly items: ReadonlyMap<string, CoverageItem>;
  /** How far each was read, by the program's record. */
  readonly read: ReadonlyMap<string, 'whole' | 'part' | 'none'>;
  /** The main agent's accounts (and any the program wrote). */
  readonly accounted: readonly MaterialAccount[];
  /** What is settled by an account. */
  readonly accountedKeys: ReadonlySet<string>;
  /**
   * What is neither read whole nor accounted for: what the check lists (Spec §3.3). A follow-up lane settles what it
   * reads; what it was sent for and did not read is listed again once it has ended, for the main agent to account for.
   */
  readonly open: readonly CoverageItem[];
  readonly settled: boolean;
  /** Words the plan used that the ledger has nothing for: said, not dropped. */
  readonly unresolved: readonly string[];
  /**
   * CM: the reports and prompts no lane read whole that a ticket or a decision entry of the workbench already cites, each
   * with what cites it. The program accounts for them (they are among `accounted`, by the program), so a follow-up lane
   * reads only uncited material.
   */
  readonly cited: ReadonlyMap<string, string>;
}

/** How the program's account of cited reports and prompts begins (it is recomputed at every check, never doubled). */
export const CITED_WHY = 'Cited already: ';

/**
 * The reports and prompts among `items` that the workbench already cites (CM, E151; CK fix 13): a work item carries the
 * number the file is named for (its prompt, its report, its run's result — the program ties them to the ticket's process),
 * a decision entry names the file, or a link or a fact cites a source of it. On the gated run the coverage stage took 20
 * minutes against 2, and a follow-up lane read 57 such files for $3.90 and wrote nothing.
 */
export function citedMaterials(store: ProjectStore, ledger: Ledger, items: readonly CoverageItem[]): Map<string, string> {
  const out = new Map<string, string>();
  const docs = items.filter((i) => i.category === 'documents' && i.material.file);
  if (!docs.length) return out;
  const roots = ledger.repos().map((r) => r.path.replace(/\\/g, '/').replace(/\/+$/, ''));
  const relOf = (abs: string): string => { const n = abs.replace(/\\/g, '/'); const root = roots.find((r) => n.toLowerCase().startsWith(`${r.toLowerCase()}/`)); return root ? n.slice(root.length + 1) : n; };
  const receipts = store.layers.filter((l) => l.layer === 'QC and receipts').map((l) => l.path.replace(/\\/g, '/').replace(/\/+$/, ''));
  const ticketOf = new Map<string, string>();
  for (const t of store.threads.all()) if (t.validity !== 'Removed') for (const i of t.ids) ticketOf.set(i.toUpperCase(), t.ids[0] ?? t.title);
  const decisions = store.reference.filter((r) => r.category === 'Decision' && r.validity !== 'Removed');
  const entryText = decisions.map((d) => d.text).join('\n').toLowerCase();
  const citedFiles = new Set<string>();
  const cite = (sourceId: string) => { const a = store.sources.get(sourceId)?.anchor; if (a?.kind === 'file') citedFiles.add(pathKey(a.path)); };
  for (const l of store.links.all()) { if (l.evidence?.kind === 'source') cite(l.evidence.id); }
  for (const t of store.threads.all()) { for (const f of t.factRecordIds) for (const sid of store.facts.get(f)?.aboutSourceIds ?? []) cite(sid); for (const st of [...t.executionFacts, ...t.qcFacts]) for (const sid of st.sourceIds) cite(sid); }
  for (const item of docs) {
    const rel = relOf(item.material.file!);
    const kinds = ledger.arrangementKinds(rel);
    if (!kinds.length && !receipts.some((r) => rel === r || rel.startsWith(`${r}/`))) continue;
    const owner = definitionsInPath(rel).map((d) => ticketOf.get(d.num.toUpperCase())).find(Boolean) ?? kinds.map((k) => (k.ident ? ticketOf.get(k.ident.toUpperCase()) : undefined)).find(Boolean);
    if (owner) { out.set(item.key, `the work item ${owner}`); continue; }
    const base = rel.split('/').pop()!.toLowerCase();
    if (base.length >= 8 && entryText.includes(base)) {
      const d = decisions.find((x) => x.text.toLowerCase().includes(base));
      out.set(item.key, `the decision entry ${d?.ids[0] ?? d?.name.slice(0, 40) ?? ''}`.trim());
      continue;
    }
    if (citedFiles.has(pathKey(item.material.file!))) out.set(item.key, 'a link or a fact of a work item');
  }
  return out;
}

/** The part-read variant of a group's id. */
const PART = ' (read in part)';
export const groupIdOf = (item: CoverageItem, read: 'none' | 'part' | 'whole' | undefined): string => `${item.category}:${item.dir}${read === 'part' ? PART : ''}`;

/** A tally without the clerk's own skill files (skills.ts `isClerkSkillPath`, resolved from the running install; `tallyReads` leaves them out already). */
function withoutSkills(tally: ReadTally): ReadTally {
  for (const key of [...tally.files.keys()]) if (isClerkSkillPath(key)) tally.files.delete(key);
  for (const key of [...tally.versions.keys()]) if (isClerkSkillPath(key)) tally.versions.delete(key);
  return tally;
}

/** Where things are: the project's folder, the repositories and scope items the ledger keys files by. */
class Places {
  readonly root: string;
  private readonly rootOf: Map<string, string>;
  private readonly roots: string[];
  constructor(ledger: Ledger, project: Project) {
    const repos = ledger.repos();
    this.rootOf = new Map<string, string>([...project.scope.map((i) => [i.id, i.path] as const), ...repos.map((r) => [r.id, r.path] as const)]);
    this.roots = [...this.rootOf.keys()].sort((a, b) => b.length - a.length);
    this.root = project.locations[0] ?? repos[0]?.path ?? '';
  }
  abs(repo: string, rel: string): string | null { const r = this.rootOf.get(repo); return r ? join(r, ...rel.split('/')) : null; }
  /** A code file key's repository and path. */
  split(key: string): { repo: string; rel: string } | null { const repo = this.roots.find((id) => key.startsWith(`${id}:`)); return repo ? { repo, rel: key.slice(repo.length + 1) } : null; }
  /** A path as the project names it: relative to its folder, with forward slashes; absolute when outside it. */
  shown(abs: string): string {
    const rel = this.root ? relative(this.root, abs) : abs;
    if (this.root && rel === '') return '.';
    return (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs).split('\\').join('/');
  }
  /** A repository's folder as the project names it: '' for the project's own. */
  repoShown(repo: string): string { const r = this.rootOf.get(repo); if (!r) return repo; const s = this.shown(r); return s === '.' || s === '' ? '' : s; }
  /** The top directory of a file: its repository's folder (when nested) and the first directory under it; '.' at a root. */
  dirOf(repo: string, rel: string): string {
    const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '.';
    const folder = this.repoShown(repo);
    return folder ? (top === '.' ? folder : `${folder}/${top}`) : top;
  }
}

/** What the project's rules settle (§1.15): by place — theirs and the organizing plan's — and by how a rule set a file used. */
function settlement(store: ProjectStore, project: Project, plan: OrganizingPlanContent | null | undefined): (repoRel: string, shown: string, abs: string | null) => boolean {
  const dirs = settlingDirs(store);
  const inForce = (ruleId: string) => store.rules.get(ruleId)?.validity === 'Current';
  const away = new Set(settledAwayMaterials(store, project, new Set()).map((m) => pathKey(m.key.slice('file:'.length))));
  return (repoRel, shown, abs) => {
    if (underAny(dirs, repoRel) || underAny(dirs, shown)) return true;
    if (plan) for (const p of [repoRel, shown]) { const e = planEntryFor(plan, p); if (e && inForce(e.ruleId)) return true; }
    return abs !== null && away.has(pathKey(abs));
  };
}

/** Builds the items of the plan: resolves the ledger's names into items, each once. */
class Planner {
  readonly items = new Map<string, CoverageItem>();
  private readonly places: Places;
  private readonly settled: ReturnType<typeof settlement>;
  /** What the project's scope leaves out (relation Excluded: the Keeper's own project folder among them, CKC-26): never the project's material. */
  private readonly excluded: readonly string[];
  private readonly ledger: Ledger;
  private readonly store: ProjectStore;
  constructor(ledger: Ledger, store: ProjectStore, project: Project, plan: OrganizingPlanContent | null | undefined) {
    this.ledger = ledger;
    this.store = store;
    this.places = new Places(ledger, project);
    this.settled = settlement(store, project, plan);
    this.excluded = project.scope.filter((i) => i.relation === 'Excluded').map((i) => i.path);
  }

  private outOfScope(file: string | null): boolean {
    return file !== null && this.excluded.some((x) => isWithin(x, file));
  }

  /** Materials as the ledger names them, as items; `byRule`: leave out what the rules settle. Returns their keys. */
  add(named: NamedMaterials, byRule: boolean): string[] {
    const keys: string[] = [];
    const put = (item: CoverageItem) => { if (!this.items.has(item.key)) this.items.set(item.key, item); keys.push(item.key); };
    for (const v of standingVersions(this.ledger, named.versions)) {
      const file = this.places.abs(v.repo, v.path);
      const shown = file ? this.places.shown(file) : v.path;
      if (this.outOfScope(file) || (byRule && this.settled(v.path, shown, file))) continue;
      const exists = file !== null && isFile(file);
      put({
        key: `doc:${shown}`, category: 'documents', label: exists ? shown : `${shown} (deleted; its last version is at ${v.commit.slice(0, 7)})`, dir: this.places.dirOf(v.repo, v.path), bytes: v.bytes,
        material: { key: `doc:${shown}`, category: 'document versions', label: shown, group: '', bytes: v.bytes, how: '', file, rev: v.commit, current: exists, lines: v.lines || null },
      });
    }
    for (const f of this.ledger.codeFilesByKey(named.codeFiles.map((c) => c.key))) {
      const file = this.places.abs(f.repo, f.path);
      const shown = file ? this.places.shown(file) : f.path;
      if (this.outOfScope(file) || (byRule && this.settled(f.path, shown, file))) continue;
      put({
        key: `file:${shown}`, category: 'code files', label: shown, dir: this.places.dirOf(f.repo, f.path), bytes: f.bytes,
        material: { key: `file:${shown}`, category: 'code files', label: shown, group: '', bytes: f.bytes, how: '', file, lines: f.lines || null },
      });
    }
    for (const c of this.ledger.commitsByHash(named.commits)) {
      const label = `${c.hash.slice(0, 7)} ${c.subject.slice(0, 100)}`;
      put({ key: `commit:${c.hash}`, category: 'commits', label, dir: this.places.repoShown(c.repo) || '.', bytes: c.bytes, material: { key: `commit:${c.hash}`, category: 'commits', label, group: '', bytes: c.bytes, how: '', rev: c.hash } });
    }
    for (const s of this.ledger.sessionsByKey(named.sessions)) {
      const label = `${s.host} session ${s.sessionId.slice(0, 8)} (${s.messages} messages${s.startedAt ? `, from ${s.startedAt.slice(0, 10)}` : ''})`;
      const bytes = s.textBytes + s.messages * 150;
      put({ key: s.key, category: 'sessions', label, dir: s.host, bytes, material: { key: s.key, category: 'sessions', label, group: '', bytes, how: '', session: s.key, messages: s.messages, file: s.file } });
    }
    return keys;
  }

  /** A whole category, as the ledger has it now (Spec §3.3: 只写了一类、没点名的，按账本里这一类的全部算), once per category. */
  private readonly wholes = new Map<CoverageCategory, string[]>();
  whole(category: CoverageCategory): string[] {
    let keys = this.wholes.get(category);
    if (!keys) {
      const l = this.ledger;
      const named: NamedMaterials = category === 'documents' ? { versions: currentDocuments(l).map((d) => ({ key: d.row.key, path: d.row.path })), codeFiles: [], commits: [], sessions: [] }
        : category === 'code files' ? { versions: [], codeFiles: l.allCodeFiles(), commits: [], sessions: [] }
          : category === 'commits' ? { versions: [], codeFiles: [], commits: l.allCommits(), sessions: [] }
            : { versions: [], codeFiles: [], commits: [], sessions: l.allSessions() };
      keys = this.add(named, true);
      this.wholes.set(category, keys);
    }
    return keys;
  }

  /** What a text names (a brief, a plan entry) — resolved the way the organizing plan's entries are — or the categories its name says. */
  named(text: string, names: readonly string[], plan: OrganizingPlanContent | null | undefined): { keys: string[]; unresolved: string[] } {
    const found = readCloselyOf(this.ledger, this.store, { byRule: plan?.byRule ?? [], readClosely: [{ what: text, targets: [], why: '' }], focus: [], order: [] });
    const keys = this.add(found, true);
    const counted = found.versions.length + found.codeFiles.length + found.commits.length + found.sessions.length > 0;
    if (counted) return { keys, unresolved: found.unresolved.filter((u) => u !== text) };
    const kinds = new Set(names.flatMap((n) => sweepKindsOf(n)));
    return { keys: [...kinds].flatMap((k) => this.whole(KIND_CATEGORY[k])), unresolved: [] };
  }
}

/** The jobs whose reads count: the round's main job and its lanes, and everything they sent. */
function readingJobs(store: ProjectStore, round: ClerkRound): KeeperJob[] {
  const ids = new Set((round.lanes ?? []).map((l) => l.jobId));
  const jobs = store.jobs.filter((j) => ids.has(j.id) || (j.step?.roundId === round.id && (j.step.kind === 'main' || j.step.kind === 'lane')));
  return withDescendants(store, jobs);
}

/**
 * The coverage of a round as it stands (Spec §3.3 每份材料都有交代): every planned material, what the round's jobs read of
 * it, what is accounted for, and what the check lists. Without a ledger nothing can be planned, and nothing is listed.
 */
export function coverageOf(store: ProjectStore, round: ClerkRound, ledger: Ledger | null, project: Project): CoverageState {
  // The main agent's accounts; the program's account of cited material is worked out afresh below.
  const given = (round.coverage?.accounted ?? []).filter((a) => !(a.by === 'program' && a.why.startsWith(CITED_WHY)));
  let accounted: readonly MaterialAccount[] = given;
  if (!ledger) return { items: new Map(), read: new Map(), accounted, accountedKeys: new Set(), open: [], settled: true, unresolved: [], cited: new Map() };
  const plan = store.plans.get(ORGANIZING_PLAN_ID);
  const planner = new Planner(ledger, store, project, plan);
  const unresolved: string[] = [];
  // What the organizing plan says to read closely: its targets decide, as they do for the rest of the organizing.
  const closely = readCloselyNow(ledger, store, plan);
  planner.add(closely, false);
  for (const u of closely.unresolved) {
    const kinds = sweepKindsOf(u);
    if (kinds.length) for (const k of kinds) planner.whole(KIND_CATEGORY[k]); else unresolved.push(u);
  }
  // What each lane's brief names, or the category its name says.
  for (const lane of round.lanes ?? []) {
    const brief = store.roundDocs.get(lane.briefDocId);
    const r = planner.named(brief?.markdown ?? '', [lane.name, brief?.title ?? '', brief?.path ?? ''], plan);
    unresolved.push(...r.unresolved);
  }
  const items = planner.items;
  // What was read, by the program's record.
  const materials = [...items.values()].map((i) => i.material);
  const reads = readsOf(materials, withoutSkills(tallyReads(readingJobs(store, round), project)));
  const read = new Map<string, 'whole' | 'part' | 'none'>([...items.keys()].map((k) => [k, reads.get(k)?.outcome ?? 'none']));
  // What is accounted for: by its keys, or — an account that names only a group — by the group it names.
  const accountedKeys = new Set<string>();
  for (const a of accounted) {
    if (a.keys?.length) { for (const k of a.keys) accountedKeys.add(k); continue; }
    if (a.group) for (const item of items.values()) if (inGroup(item, read.get(item.key), a.group)) accountedKeys.add(item.key);
  }
  // CM: the reports and prompts a ticket or a decision entry already cites are the program's to account for.
  let cited = new Map<string, string>();
  try { cited = citedMaterials(store, ledger, [...items.values()].filter((i) => read.get(i.key) !== 'whole' && !accountedKeys.has(i.key))); } catch { cited = new Map(); }
  if (cited.size) {
    const by = new Map<string, number>();
    for (const what of cited.values()) { const k = what.startsWith('the work item') ? 'a work item carrying its number' : what.startsWith('the decision entry') ? 'a decision entry naming it' : what; by.set(k, (by.get(k) ?? 0) + 1); }
    accounted = [...given, { keys: [...cited.keys()], outcome: 'part', why: `${CITED_WHY}${cited.size} report${cited.size === 1 ? '' : 's'} and prompt${cited.size === 1 ? '' : 's'} the workbench cites (${[...by].map(([k, n]) => `${n} by ${k}`).join(', ')}); a follow-up lane reads the uncited material only.`, by: 'program', at: new Date().toISOString() }];
    for (const k of cited.keys()) accountedKeys.add(k);
  }
  const open = [...items.values()].filter((i) => read.get(i.key) !== 'whole' && !accountedKeys.has(i.key));
  return { items, read, accounted, accountedKeys, open, settled: open.length === 0, unresolved: [...new Set(unresolved)], cited };
}

/**
 * Whether an item is in a group as the main agent names it: its group's id exactly, or its category (all its groups).
 * DA: `documents:subagent` is the group nothing was read of; its part-read twin is `documents:subagent (read in part)`,
 * a group of its own with its own account (on the flash run the unread group's "not needed" swallowed the twin).
 */
function inGroup(item: CoverageItem, read: 'none' | 'part' | 'whole' | undefined, group: string): boolean {
  const g = group.trim();
  return g === groupIdOf(item, read) || g === item.category;
}

/** The listed items as groups, by category, then directory; the first `limit` keys of each. */
export function coverageGroups(state: CoverageState, limit: number | null = 20): CoverageGroup[] {
  const groups = new Map<string, { category: CoverageCategory; dir: string; read: 'none' | 'part'; keys: string[]; bytes: number }>();
  for (const item of state.open) {
    const read = state.read.get(item.key) === 'part' ? 'part' : 'none';
    const id = groupIdOf(item, read);
    const g = groups.get(id) ?? { category: item.category, dir: item.dir, read, keys: [], bytes: 0 };
    g.keys.push(item.key);
    g.bytes += item.bytes;
    groups.set(id, g);
  }
  return [...groups].sort(([a, x], [b, y]) => CATEGORY_ORDER.indexOf(x.category) - CATEGORY_ORDER.indexOf(y.category) || a.localeCompare(b)).map(([group, g]) => {
    const shown = limit === null ? g.keys : g.keys.slice(0, limit);
    return { group, category: g.category, dir: g.dir, count: g.keys.length, bytes: g.bytes, keys: shown, read: g.read, ...(shown.length < g.keys.length ? { more: g.keys.length - shown.length } : {}) };
  });
}

// ───────────────────────── what a listed material holds that nothing carries (DA) ─────────────────────────

/** What one listed material holds that nothing on the workbench carries; each entry is one line, number or owner's line, as an example names it. */
export interface MaterialHolds {
  readonly verdictLines: readonly string[];
  readonly numbers: readonly string[];
  readonly ownerQuotes: readonly string[];
}

const holdsAny = (h: MaterialHolds | undefined): h is MaterialHolds => !!h && h.verdictLines.length + h.numbers.length + h.ownerQuotes.length > 0;
const clipTo = (s: string, n: number): string => { const flat = s.trim().replace(/\s+/g, ' '); return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat; };
const slashed = (p: string): string => p.split('\\').join('/');

/** The files a link or a fact of a work item cites: a verdict line in one of them is linked. */
function linkedFiles(store: ProjectStore, ledger: Ledger): Set<string> {
  const out = new Set<string>();
  const cite = (sourceId: string) => { const a = store.sources.get(sourceId)?.anchor; if (a?.kind === 'file') out.add(pathKey(a.path)); };
  for (const l of store.links.all()) {
    if (l.evidence?.kind === 'source') cite(l.evidence.id);
    try { const place = ledger.entryPlace(l.ledgerRef); if (place && 'file' in place) out.add(pathKey(place.file)); } catch { /* a ref the ledger no longer resolves links nothing */ }
  }
  for (const t of store.threads.all()) {
    for (const f of t.factRecordIds) for (const sid of store.facts.get(f)?.aboutSourceIds ?? []) cite(sid);
    for (const st of [...t.executionFacts, ...t.qcFacts]) for (const sid of st.sourceIds) cite(sid);
  }
  return out;
}

/** Quoted words in a document: between corner or curly quotation marks, or a blockquote line. */
const QUOTED = /「([^「」\n]{2,600})」|『([^『』\n]{2,600})』|“([^“”\n]{2,600})”|^\s{0,3}>\s?(.{2,600})$/gmu;

/**
 * What each of `items` holds that nothing carries (see the module comment). Documents: the stated verdict lines no link
 * or fact cites; the numbers it defines as its own entries that no item carries and no account names — in a document
 * that is itself a numbered entry (its path, front matter or title heading defines a number), bold lines and table rows
 * of another family are that entry's points, not entries; the owner's lines not looked at yet whose words it quotes.
 * Sessions: their owner's lines not looked at yet. Code files and commits hold none. Only materials that hold something
 * are in the result.
 */
export function materialHolds(store: ProjectStore, ledger: Ledger, items: readonly CoverageItem[]): Map<string, MaterialHolds> {
  const out = new Map<string, MaterialHolds>();
  const docs = items.filter((i) => i.category === 'documents' && i.material.file);
  const sessions = items.filter((i) => i.category === 'sessions');
  if (!docs.length && !sessions.length) return out;
  const repos = ledger.repos().map((r) => ({ id: r.id, root: slashed(r.path).replace(/\/+$/, '').toLowerCase() })).sort((a, b) => b.root.length - a.root.length);
  const placeOf = (abs: string): { repo: string; rel: string } | null => {
    const n = slashed(abs);
    const repo = repos.find((r) => n.toLowerCase().startsWith(`${r.root}/`));
    return repo ? { repo: repo.id, rel: n.slice(repo.root.length + 1) } : null;
  };
  // The owner's lines not looked at yet, by their words (a line too short to tell apart is not looked for in a document).
  let open: ReturnType<typeof uncitedOwnerLines>['lines'] = [];
  try { open = uncitedOwnerLines(store, ledger).lines; } catch { open = []; }
  const quotable = open.map((l) => ({ l, words: fold(l.text) })).filter((x) => x.words.length >= DISTINCT_WORDS);
  const linked = docs.length ? linkedFiles(store, ledger) : new Set<string>();
  const carried = docs.length ? carriedNumbers(store) : new Set<string>();
  const accounts = docs.length ? accountedEntries(store) : new Map<string, Map<string, unknown>>();
  const family = (num: string): string => familyOf(num)?.family ?? num;
  for (const item of docs) {
    const abs = item.material.file!;
    const place = placeOf(abs);
    if (!place) continue;
    const verdictLines: string[] = [];
    const numbers: string[] = [];
    const ownerQuotes: string[] = [];
    // Verdict lines: stated verdicts of the document as it stands, when no link or fact cites the document.
    if (!linked.has(pathKey(abs))) {
      const page = ledger.verdicts({ repo: place.repo, path: place.rel, kind: 'verdict', confidence: 'stated', currentOnly: true, limit: 500 });
      if (typeof page !== 'string') for (const v of page.rows) if (v.path === place.rel) verdictLines.push(`${item.label}:${v.line ?? '?'} — ${clipTo(v.text, 100)}`);
    }
    // Numbers: its own entries nothing carries.
    const all = ledger.definitionsIn(place.repo, place.rel).filter((d) => d.path === place.rel);
    const entryDefs = all.filter((d) => d.position === 'heading' || d.position === 'bold entry' || d.position === 'table first column');
    let text: string | null = null;
    try { text = ledger.currentText(abs); } catch { text = null; }
    if (text === null) { try { text = readFileSync(abs, 'utf8'); } catch { text = null; } }
    const lines = text === null ? null : text.split(/\r?\n/);
    if (entryDefs.length) {
      const own = entryDefinitions(entryDefs.map((d) => ({ ...d, position: d.position as 'heading' })), lines);
      const first = lines ? headingLines(lines)[0] : undefined;
      const docOwn = new Set<string>([
        ...definitionsInPath(place.rel).map((d) => d.family),
        ...all.filter((d) => d.position === 'front matter').map((d) => family(d.num)),
        ...(first ? entryDefs.filter((d) => d.position === 'heading' && d.line === first.line).map((d) => family(d.num)) : []),
      ]);
      const entries = docOwn.size ? own.filter((d) => d.position === 'heading' || docOwn.has(family(d.num))) : own;
      const accounted = accounts.get(place.rel);
      for (const d of entries) if (!numbers.includes(d.num) && !carried.has(d.num.toUpperCase()) && !accounted?.has(d.num)) numbers.push(d.num);
    }
    // The owner's lines not looked at yet that it quotes.
    if (quotable.length && text) {
      const seen = new Set<string>();
      for (const m of text.matchAll(QUOTED)) {
        // A blockquote line may carry its own quotation marks: the example shows the words once.
        const said = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim().replace(/^[「『“"]+|[」』”"]+$/g, '');
        const span = fold(said);
        if (span.length < DISTINCT_WORDS) continue;
        const hit = quotable.find((x) => x.words.includes(span));
        if (!hit || seen.has(lineKey(hit.l.draftId, hit.l.ref))) continue;
        seen.add(lineKey(hit.l.draftId, hit.l.ref));
        ownerQuotes.push(`${item.label}: 「${clipTo(said, 80)}」 (the owner, ${hit.l.at.slice(0, 10) || 'time unknown'}; line ${lineKey(hit.l.draftId, hit.l.ref)})`);
      }
    }
    if (verdictLines.length + numbers.length + ownerQuotes.length) out.set(item.key, { verdictLines, numbers, ownerQuotes });
  }
  if (sessions.length && open.length) {
    const drafts = new Map(store.drafts.all().map((d) => [d.id, d]));
    for (const item of sessions) {
      const file = item.material.file ? pathKey(item.material.file) : null;
      const own = open.filter((l) => { const d = drafts.get(l.draftId); return !!d && file !== null && !!d.session.file && pathKey(d.session.file) === file; });
      if (own.length) out.set(item.key, { verdictLines: [], numbers: [], ownerQuotes: own.map((l) => `${item.label}: 「${clipTo(l.text, 80)}」 (line ${lineKey(l.draftId, l.ref)})`) });
    }
  }
  return out;
}

/** How many examples of each kind a group shows. */
const HOLD_EXAMPLES = 3;

/** What a material holds, in one line: for a refusal, and for the account that names it. */
export function holdsLine(h: MaterialHolds): string {
  const parts: string[] = [];
  if (h.verdictLines.length) parts.push(`${h.verdictLines.length} verdict line${h.verdictLines.length === 1 ? '' : 's'} no work item links`);
  if (h.numbers.length) parts.push(`${h.numbers.length} number${h.numbers.length === 1 ? '' : 's'} no item carries (${h.numbers.slice(0, 6).join(', ')}${h.numbers.length > 6 ? ', …' : ''})`);
  if (h.ownerQuotes.length) parts.push(`${h.ownerQuotes.length} owner's line${h.ownerQuotes.length === 1 ? '' : 's'} not looked at yet`);
  return parts.join('; ');
}

/** The holds of the listed groups, by group id: the three counts, a few examples of each, and the materials that hold them. */
export function groupHoldsOf(state: CoverageState, holds: ReadonlyMap<string, MaterialHolds>): Map<string, GroupHolds> {
  const acc = new Map<string, { verdicts: string[]; numbers: number; numberDocs: string[]; quotes: string[]; materials: string[] }>();
  for (const item of state.open) {
    const h = holds.get(item.key);
    if (!holdsAny(h)) continue;
    const id = groupIdOf(item, state.read.get(item.key));
    const g = acc.get(id) ?? { verdicts: [], numbers: 0, numberDocs: [], quotes: [], materials: [] };
    g.verdicts.push(...h.verdictLines);
    if (h.numbers.length) { g.numbers += h.numbers.length; g.numberDocs.push(`${item.label}: ${h.numbers.slice(0, 8).join(', ')}${h.numbers.length > 8 ? `, and ${h.numbers.length - 8} more` : ''}`); }
    g.quotes.push(...h.ownerQuotes);
    g.materials.push(item.key);
    acc.set(id, g);
  }
  const count = (n: number, examples: readonly string[]): HoldCount | undefined => (n ? { count: n, examples: examples.slice(0, HOLD_EXAMPLES) } : undefined);
  return new Map([...acc].map(([id, g]): [string, GroupHolds] => {
    const verdictLines = count(g.verdicts.length, g.verdicts);
    const numbers = count(g.numbers, g.numberDocs);
    const ownerQuotes = count(g.quotes.length, g.quotes);
    return [id, { ...(verdictLines ? { verdictLines } : {}), ...(numbers ? { numbers } : {}), ...(ownerQuotes ? { ownerQuotes } : {}), materials: g.materials }];
  }));
}

// ───────────────────────── the project and the ledger, when only the store is at hand ─────────────────────────

/** The project a store belongs to, from the workspace next to it; null when the store is not in a home. */
export function projectOfStore(store: ProjectStore): Project | null {
  const home = dirname(dirname(store.dir));
  const data = readJson<{ projects?: Project[] }>(workspaceFile(home), {});
  return data.projects?.find((p) => p.id === store.projectId) ?? null;
}

/** A project that knows only where the ledger's repositories are: enough to place the material and count the reads. */
const bareProject = (store: ProjectStore, ledger: Ledger | null): Project => ({ id: store.projectId, locations: ledger?.repos().slice(0, 1).map((r) => r.path) ?? [], scope: [] }) as unknown as Project;

/**
 * Whether the round's coverage is settled (the gate into a `Full` deepening's cross-check, E148): every planned material
 * read whole or accounted for (a follow-up lane settles only what it reads). `opts`: the project and ledger when the caller has
 * them; else the project is read from the workspace beside the store and the ledger opened from the store's folder.
 * Without a ledger nothing is planned, so nothing holds the gate.
 */
export function coverageSettledNow(store: ProjectStore, round: ClerkRound, opts: { readonly project?: Project | null; readonly ledger?: Ledger | null } = {}): boolean {
  const own = opts.ledger === undefined ? Ledger.openDir(store.dir) : null;
  const ledger = opts.ledger ?? own;
  try {
    const project = opts.project ?? projectOfStore(store) ?? bareProject(store, ledger);
    return coverageOf(store, round, ledger, project).settled;
  } finally {
    own?.close();
  }
}

// ───────────────────────── the tools ─────────────────────────

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }], details: {} });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: `ERROR: ${message}` }], details: {}, isError: true });
const now = () => new Date().toISOString();

/** The stages whose writers include a tool (clerk-steps.ts `STAGE_WRITERS`). */
const stagesOf = (tool: string): ClerkStage[] => (Object.keys(STAGE_WRITERS) as ClerkStage[]).filter((s) => STAGE_WRITERS[s].includes(tool));

/**
 * The round's coverage record with what the check found now: whether it is settled (`open`: what is neither read whole
 * nor accounted for), the accounts, and what no lane read whole (`untouched`, the first 20 keys of each group) — the
 * accounts standing beside it, not taking it away — which the Keeper view shows (Spec §6.9).
 */
function recordCoverage(store: ProjectStore, round: ClerkRound, state: CoverageState, open: readonly CoverageItem[], accounted: readonly MaterialAccount[], jobId: string, summary: string, holds?: ReadonlyMap<string, GroupHolds>): void {
  // DA: what each group holds, as this check counted it; an account between checks keeps what the last check recorded.
  const before = new Map((round.coverage?.untouched ?? []).flatMap((g) => (g.holds ? [[g.group, g.holds] as const] : [])));
  const untouched = coverageGroups({ ...state, open: [...state.items.values()].filter((i) => state.read.get(i.key) !== 'whole') })
    .map((g) => { const h = holds ? holds.get(g.group) : before.get(g.group); return h ? { ...g, holds: h } : g; });
  const coverage: RoundCoverage = { at: now(), accounted, settled: open.length === 0, untouched };
  store.clerkRounds.put({ ...round, coverage, updatedAt: coverage.at }, { jobId, summary, basisSourceIds: [] });
}

/**
 * `pk_coverage_check` and `pk_account_material` (D99; W0 contract §6). A job that is no part of a round has no coverage;
 * only the round's main agent accounts, in the stages whose writers list it.
 */
export function coverageTools(ctx: ToolContext): ToolDefinition[] {
  const { store, project } = ctx;
  const roundOf = (): ClerkRound | string => {
    const id = ctx.step?.roundId;
    if (!id) return 'this job is no part of a round of the clerk method, so there is no coverage to check.';
    return store.clerkRounds.get(id) ?? `round ${id} is not in the assets.`;
  };
  const withState = <T>(fn: (round: ClerkRound, state: CoverageState, ledger: Ledger | null) => T): T | ReturnType<typeof fail> => {
    const round = roundOf();
    if (typeof round === 'string') return fail(round);
    const ledger = Ledger.openDir(store.dir);
    try {
      return fn(round, coverageOf(store, round, ledger, project), ledger);
    } catch (error) {
      return fail(`the coverage could not be computed: ${(error as Error).message}`);
    } finally {
      ledger?.close();
    }
  };
  return [
    defineTool({
      name: 'pk_coverage_check', label: 'What no lane touched',
      description: 'The coverage check (every material the round planned to read gets an outcome): after your lanes have ended, what of the plan no lane read in full — what the organizing plan says to read closely, what your lane briefs name, and the whole category where a brief names only a kind of material — grouped by category and top directory. The program counts what was read from the lanes\' recorded reads (and yours), not from their reports. A document is one material: its older versions are never listed. What the project\'s rules settle is not listed. `read: part` groups were read only in part. `holds` on a group is what its materials hold that nothing on the workbench carries — verdict lines no work item links, numbers no item carries, the owner\'s lines not looked at yet — as counts with a few examples and the materials that hold them. For each group: account for it with pk_account_material (not needed, or read in part, with why), or send a follow-up lane for it (pk_send_lanes, kind follow-up, its brief naming the group\'s files), then check again: what a follow-up lane did not read is listed again. A group with `holds` is not accounted for as a group: a lane reads the materials it names, or you account for each of them by its key, with its own reason. The cross-check of a Full deepening waits until settled is true. group: give one group\'s id to see all its keys (otherwise the first 20 of each).',
      parameters: Type.Object({ group: Type.Optional(Type.String({ description: 'one group id as listed, to see all its keys' })) }),
      execute: async (_id, p) => withState((round, state, ledger) => {
        const only = text(p.group).trim();
        // DA: what each listed group holds that nothing carries; a count that cannot be computed is left out, never guessed.
        let held = new Map<string, GroupHolds>();
        try { if (ledger) held = groupHoldsOf(state, materialHolds(store, ledger, state.open)); } catch { held = new Map(); }
        const groups = coverageGroups(state, only ? null : 20).filter((g) => !only || g.group === only || g.category === only)
          .map((g) => { const h = held.get(g.group); return h ? { ...g, holds: only ? h : { ...h, materials: h.materials.slice(0, 20) } } : g; });
        if (only && !groups.length) return fail(`no listed group is ${only}; the listed groups are: ${coverageGroups(state).map((g) => g.group).join(', ') || 'none — everything is settled'}.`);
        // Recorded at every check, so the Keeper view shows what this check listed (Spec §6.9).
        recordCoverage(store, round, state, state.open, state.accounted, ctx.jobId, `Coverage check: ${state.open.length} of ${state.items.size} planned materials listed`, held);
        const whole = [...state.read.values()].filter((r) => r === 'whole').length;
        const citedBy = [...state.cited].slice(0, 8).map(([key, what]) => `${key.replace(/^doc:/, '')} — ${what}`);
        return ok({
          untouched: groups, accounted: state.accounted.map((a) => (a.by === 'program' && (a.keys?.length ?? 0) > 12 ? { ...a, keys: [...a.keys!.slice(0, 12), `… ${a.keys!.length - 12} more`] } : a)), settled: state.settled,
          ...(state.cited.size ? { cited: { count: state.cited.size, note: 'Reports and prompts no lane read whole that a work item or a decision entry already cites: the program accounted for them, so they are not listed. A follow-up lane reads the listed (uncited) material only.', examples: citedBy } } : {}),
          totals: { planned: state.items.size, readWhole: whole, accounted: state.accountedKeys.size, listed: state.open.length },
          ...(state.unresolved.length ? { unresolved: state.unresolved } : {}),
        });
      }),
    }),
    defineTool({
      name: 'pk_account_material',
      label: 'Account for material no lane read',
      description: 'Account for listed material (pk_coverage_check) that no lane read in full: outcome "not needed" — it need not be read for this round\'s questions, and why — or "part" — only a part of it was read (a `read: part` group), and why that is enough. Give keys (as listed) or one group (its id exactly as listed — the "(read in part)" group is a group of its own — or a category: its unread groups for "not needed", its part-read groups for "part"). A group that holds something nothing carries (`holds` in pk_coverage_check) is not accounted for as a group: send a follow-up lane for the materials that hold it, or account for each of them by its key with its own reason — one key in keys, or each: [{ key, why }] for several in one call; the rest of the group is then accounted for as a group. The account is recorded on the round, in your words, and shows in the Keeper view. Account honestly: what should be read, send a follow-up lane for instead.',
      parameters: Type.Object({
        keys: Type.Optional(Type.Array(Type.String())),
        group: Type.Optional(Type.String({ description: 'a group id exactly as pk_coverage_check lists it, or a category (documents, code files, commits, sessions)' })),
        each: Type.Optional(Type.Array(Type.Object({ key: Type.String(), why: Type.String() }), { description: 'materials accounted for one by one, each with its own reason: for materials that hold something nothing carries' })),
        outcome: Type.String({ description: 'not needed | part' }),
        why: Type.Optional(Type.String({ description: 'the reason for the keys or the group; each carries its own' })),
      }),
      execute: async (_id, p) => withState((round, state, ledger) => {
        const allowed = stagesOf('pk_account_material');
        if (ctx.step?.kind !== 'main') return fail('pk_account_material records the main agent\'s account of the coverage; this job is not the round\'s main agent, so nothing was recorded.');
        if (round.stage && !allowed.includes(round.stage)) return fail(`pk_account_material is written in the ${allowed.join(', ')} stage; the round is in ${round.stage}, so nothing was recorded. Move there with pk_stage first.`);
        const outcome = text(p.outcome).trim();
        if (outcome !== 'not needed' && outcome !== 'part') return fail('outcome must be "not needed" or "part".');
        const each = (Array.isArray(p.each) ? p.each as unknown[] : []).map((e) => ({ key: text((e as Record<string, unknown>)?.key).trim(), why: text((e as Record<string, unknown>)?.why).trim() })).filter((e) => e.key);
        const keys = Array.isArray(p.keys) ? (p.keys as unknown[]).map(text).map((k) => k.trim()).filter(Boolean) : [];
        const group = text(p.group).trim();
        if (each.length && (keys.length || group)) return fail('give each alone — one reason per material — or keys or a group with one why. Nothing was recorded.');
        const why = text(p.why).trim();
        if (!each.length && !why) return fail('why is empty: say why this material need not be read, or why the part read is enough.');
        if (!each.length && !keys.length && !group) return fail('give keys or a group, as pk_coverage_check lists them, or each.');
        const noReason = each.filter((e) => !e.why).map((e) => e.key);
        if (noReason.length) return fail(`each material has its own reason; none was given for ${noReason.slice(0, 12).join(', ')}. Nothing was recorded.`);
        const open = new Map(state.open.map((i) => [i.key, i]));
        const chosen = new Set<string>();
        const settledAlready: string[] = [];
        const unknown: string[] = [];
        for (const k of each.length ? each.map((e) => e.key) : keys) { if (open.has(k)) chosen.add(k); else if (state.items.has(k)) settledAlready.push(k); else unknown.push(k); }
        // A category stands for its groups of the outcome given: what was read in part is accounted for as "part" (DA).
        const isCategory = (CATEGORY_ORDER as readonly string[]).includes(group);
        let otherTwin = 0;
        if (group) {
          const before = chosen.size;
          for (const item of state.open) {
            if (!inGroup(item, state.read.get(item.key), group)) continue;
            if (isCategory && (state.read.get(item.key) === 'part') !== (outcome === 'part')) { otherTwin++; continue; }
            chosen.add(item.key);
          }
          if (chosen.size === before && !otherTwin) unknown.push(group);
        }
        if (!chosen.size) {
          return fail(`nothing listed matches${unknown.length ? ` (${unknown.join(', ')})` : ''}${settledAlready.length ? `; already read or accounted for: ${settledAlready.join(', ')}` : ''}${otherTwin ? `; the ${otherTwin} listed material${otherTwin === 1 ? '' : 's'} of ${group} ${outcome === 'part' ? 'were not read at all: account for them as not needed' : 'were read in part: account for them with outcome part'}` : ''}. Listed groups: ${coverageGroups(state).map((g) => g.group).join(', ') || 'none — everything is settled'}.`);
        }
        if (outcome === 'part') {
          const unread = [...chosen].filter((k) => state.read.get(k) !== 'part');
          if (unread.length) return fail(`outcome part is for material read in part, and no lane read any of ${unread.slice(0, 20).join(', ')}${unread.length > 20 ? ` and ${unread.length - 20} more` : ''}: account for it as not needed, with why, or send a follow-up lane for it. Nothing was recorded.`);
        }
        // DA: what the chosen materials hold that nothing carries. A group that holds something is not written off whole,
        // and a material that holds something is accounted for by its own reason.
        let holds = new Map<string, MaterialHolds>();
        try { if (ledger) holds = materialHolds(store, ledger, [...chosen].map((k) => open.get(k)!)); } catch { holds = new Map(); }
        const holding = [...chosen].filter((k) => holds.has(k));
        if (holding.length && (group || (!each.length && chosen.size > 1))) {
          const total = { verdicts: 0, numbers: 0, quotes: 0 };
          for (const k of holding) { const h = holds.get(k)!; total.verdicts += h.verdictLines.length; total.numbers += h.numbers.length; total.quotes += h.ownerQuotes.length; }
          const what = [total.verdicts ? `${total.verdicts} verdict line${total.verdicts === 1 ? '' : 's'} no work item links` : '', total.numbers ? `${total.numbers} number${total.numbers === 1 ? '' : 's'} no item carries` : '', total.quotes ? `${total.quotes} owner's line${total.quotes === 1 ? '' : 's'} not looked at yet` : ''].filter(Boolean).join(', ');
          const named = holding.slice(0, 20).map((k) => `- ${k}: ${holdsLine(holds.get(k)!)}`).join('\n');
          return fail(`${group ? `${group} is not accounted for as a group` : 'These materials are not accounted for with one reason'}: ${holding.length} of the ${chosen.size} material${chosen.size === 1 ? '' : 's'} hold${holding.length === 1 ? 's' : ''} what nothing on the workbench carries — ${what}:\n${named}${holding.length > 20 ? `\n- and ${holding.length - 20} more (pk_coverage_check with the group lists them all)` : ''}\nSend a follow-up lane for them (pk_send_lanes, kind follow-up, its brief naming them), or account for each by its key with its own reason: pk_account_material { each: [{ key, why }], outcome }. The rest${group ? ' of the group' : ''} is then accounted for as before. Nothing was recorded.`);
        }
        const at = now();
        const reasonOf = new Map(each.map((e) => [e.key, e.why]));
        const written: MaterialAccount[] = each.length
          ? [...chosen].map((k) => ({ keys: [k], group: null, outcome, why: reasonOf.get(k)!, by: 'main' as const, at, ...(holds.has(k) ? { holds: holdsLine(holds.get(k)!) } : {}) }))
          : [{ keys: [...chosen], group: group || null, outcome, why, by: 'main', at, ...(holding.length === 1 ? { holds: holdsLine(holds.get(holding[0]!)!) } : {}) }];
        const accounted = [...state.accounted, ...written];
        const rest = state.open.filter((i) => !chosen.has(i.key));
        const left = rest.length;
        recordCoverage(store, round, state, rest, accounted, ctx.jobId, `Coverage: ${chosen.size} material${chosen.size === 1 ? '' : 's'} accounted for as ${outcome}`);
        return ok({ accounted: chosen.size, settled: left === 0, left, ...(holding.length ? { held: holding.length } : {}), ...(otherTwin ? { leftListed: `${otherTwin} material${otherTwin === 1 ? '' : 's'} of ${group} ${outcome === 'part' ? 'not read at all (account for them as not needed)' : 'read in part (account for them with outcome part)'}` } : {}), ...(unknown.length ? { unknown } : {}), ...(settledAlready.length ? { alreadySettled: settledAlready } : {}) });
      }),
    }),
  ];
}
