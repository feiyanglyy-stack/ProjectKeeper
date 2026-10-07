/**
 * The ledger's queries (Spec §1.16; CKC-22 AC-1…AC-13; CKC-03 AC-26, AC-27): exact answers over what the program
 * recorded — the history map, commits, document versions and their section diffs, explicit supersessions, numbering,
 * verdicts, execution arrangements, code structure, sessions and the owner's words — plus the provenance (`How it got
 * here`) and the coverage. Every row carries its entry id (cite it; `resolve` reads it back) and when it happened with the
 * basis the program read it from. Lists are paged. The ledger states facts, never judgements: "this line reads superseded
 * by X", "no file references this file".
 *
 * Reading goes through a read-only connection; a rebuild on its worker thread never blocks it (WAL).
 */
import type { DatabaseSync } from 'node:sqlite';
import { join, sep } from 'node:path';
import { nameForm, normalizePath, pathKey, relativeDisplay } from '../util/paths.ts';
import { openLedgerReadOnly, blobTextKey } from './schema.ts';
import { catBlobs, isText, ledgerGit } from './git-read.ts';
import { boundMs, dayOf, materialTime, msOf, occurred, undated, type Occurred } from './time.ts';
import { symbolQuery, type SymbolQueryKind, type SymbolResult } from './ts-symbols.ts';
import { CLEANUP_RULE, IMPORT_RULE, MAX_DOC_BYTES, datesOf, diffSections, occurredOfLine, versionTime } from './docs.ts';
import { NOT_CODE, compilerReads, depsOf, fileNameOf, langOf, namingOf, namingThatCounts, reachOf, type CodeReach, type LanguageReach, type Naming } from './code.ts';
import { COUNTED_RULE, ENGINE_LABEL, engineDirOf, engineImportsOf, engineLanguage, engineSymbol, specifierNames, type EngineSymbolResult } from './code-engine.ts';
import { MIN_DEFINED } from './numbering.ts';
import { isReportLike } from './lines.ts';
import { MAX_LOOSE_BYTES, engineRootOf } from './rebuild.ts';

export interface Page<T> {
  readonly total: number;
  readonly offset: number;
  readonly rows: readonly T[];
  /** Where the next page starts; null on the last page. */
  readonly next: number | null;
}
export interface Paging { readonly limit?: number; readonly offset?: number }

const LIMIT = 50;
const lim = (q: Paging, max = 500): number => Math.max(1, Math.min(max, Math.floor(Number(q.limit) || LIMIT)));
const off = (q: Paging): number => Math.max(0, Math.floor(Number(q.offset) || 0));
const pageOf = <T>(total: number, rows: T[], offset: number): Page<T> => ({ total, offset, rows, next: offset + rows.length < total ? offset + rows.length : null });
const likeEscape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * Why a file other files name is not shown to be unreferenced (code.ts `NamingKind`), in words: a build or manifest file
 * naming it makes it a named entry point; code naming it, a reference no reader resolved.
 */
function namedByNote(naming: readonly Naming[]): string {
  const entry = [...new Set(naming.filter((n) => n.kind === 'entry').map((n) => fileNameOf(n.path)))];
  return [
    'No counted reference reaches this file, yet other files name it.',
    entry.length ? `It is a named entry point: named in ${entry.join(', ')} — a build or manifest file, which compiles, launches, loads or runs it.` : null,
    naming.some((n) => n.kind === 'reference') ? 'Code names it: a reference its reader did not resolve (an include directive it does not follow, a file started by its path).' : null,
    'That it is unreferenced is no computed fact here; read them.',
  ].filter(Boolean).join(' ');
}
/** The words for the files under some paths that other files name: the named entry points, and the references no reader resolved. */
function namedGaps(named: readonly { readonly path: string; readonly by: Naming }[], where: string): string[] {
  const entry = named.filter((x) => x.by.kind === 'entry');
  const code = named.filter((x) => x.by.kind !== 'entry');
  const list = (xs: typeof named) => xs.slice(0, 3).map((x) => `${x.path} (named in ${x.by.path})`).join('; ');
  return [
    ...(entry.length ? [`${plural(entry.length, 'file')}${where} no counted reference reaches ${entry.length === 1 ? 'is' : 'are'} named by a build or manifest file, so ${entry.length === 1 ? 'it is a named entry point' : 'they are named entry points'}: ${list(entry)}`] : []),
    ...(code.length ? [`${plural(code.length, 'file')}${where} no counted reference reaches ${code.length === 1 ? 'is' : 'are'} named by other files, so a reference went unresolved: ${list(code)}`] : []),
  ];
}
const clip = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const short = (h: string | null | undefined): string | null => (h ? h.slice(0, 10) : null);
const json = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };

/** One entry of the ledger as a citation needs it: its id, a label a person reads, when it happened, and its text. */
export interface LedgerEntry { readonly id: string; readonly kind: string; readonly label: string; readonly occurred: Occurred; readonly text?: string }

// ───────────────────────── row shapes ─────────────────────────

export interface CommitRow {
  readonly id: string; readonly repo: string; readonly hash: string; readonly subject: string; readonly author: string;
  /** When it happened (UTC instant), and the author's and committer's times as git wrote them (their own offset: the local day). */
  readonly occurred: Occurred; readonly authoredAt: string; readonly committedAt: string | null;
  readonly parents: number; readonly merge: boolean; readonly onTrunk: boolean; readonly reach: string; readonly files: number;
  readonly importRoot?: boolean;
}
export interface DocVersionRow {
  readonly id: string; readonly repo: string; readonly path: string; readonly commit: string; readonly change: string; readonly from: string | null;
  readonly occurred: Occurred; readonly sections: number; readonly lines: number;
  readonly diff: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] } | null;
  readonly current: boolean; readonly onTrunk: boolean; readonly importRoot: boolean;
}
export interface LineRow {
  readonly id: string; readonly repo: string | null; readonly path: string | null; readonly line: number | null;
  readonly text: string; readonly occurred: Occurred;
  readonly firstIn: string | null; readonly lastIn: string | null; readonly current: boolean;
}
export interface SupersessionRow extends LineRow { readonly source: string; readonly pattern: string; readonly target: string | null; readonly replaced: string | null; readonly replacement: string | null; readonly syntax: string | null; readonly obsoleteList: boolean; readonly list: string | null }
export interface NumRow extends LineRow { readonly num: string; readonly rule: string; readonly kind: string; readonly place: string; readonly confidence: string }
export interface VerdictRow extends LineRow { readonly kind: string; readonly verdict: string | null; readonly confidence: string }
export interface ArrangementRow {
  readonly id: string; readonly repo: string | null; readonly path: string; readonly commit: string | null; readonly kind: string; readonly ident: string | null;
  readonly parsed: boolean; readonly current: boolean; readonly occurred: Occurred; readonly data: unknown;
}
export interface SessionRow {
  readonly id: string; readonly host: string; readonly sessionId: string; readonly file: string; readonly cwd: string | null;
  readonly startedAt: string | null; readonly endedAt: string | null; readonly messages: number; readonly ownerMessages: number;
  readonly headless: boolean; readonly subagent: boolean; readonly missing: boolean; readonly unreadable: string | null;
}
export interface MessageRow {
  readonly id: string; readonly session: string; readonly index: number; readonly speaker: string; readonly occurred: Occurred;
  readonly text: string | null; readonly chars: number; readonly tools?: readonly string[];
  /** The agent message this owner message answers (verbatim), when the session has one before it. */
  readonly answers?: { readonly id: string; readonly index: number; readonly occurred: Occurred; readonly text: string | null } | null;
}
export interface WordHit {
  readonly id: string; readonly kind: string; readonly label: string; readonly occurred: Occurred; readonly snippet: string; readonly current?: boolean;
  /** A document: the last version that has the word. */
  readonly last?: { readonly id: string; readonly at: string } | null;
}

export interface ProvenanceInput {
  readonly nums?: readonly string[];
  readonly paths?: readonly string[];
  readonly commits?: readonly string[];
  readonly words?: readonly string[];
  readonly entries?: readonly string[];
  readonly repo?: string;
}
export type StepKind =
  | 'first appeared' | 'changed' | 'deleted' | 'says superseded' | 'obsolete-list row' | 'named in plan' | 'arrangement'
  | 'commit' | 'merged' | 'verdict' | 'mentioned' | 'owner said' | 'now';
export interface ProvenanceStep {
  readonly kind: StepKind;
  readonly occurred: Occurred;
  readonly title: string;
  /** The ledger entry the step is (cite it). */
  readonly entry: string;
  /** The step lies only in history: an old version, a deleted document, a side branch never merged (D82). */
  readonly history: boolean;
  /** What replaced it, when the ledger knows: the next version, the deleting commit. */
  readonly replacedBy?: string | null;
}

// ───────────────────────── the ledger ─────────────────────────

export class Ledger {
  readonly db: DatabaseSync;
  readonly path: string;

  private constructor(db: DatabaseSync, path: string) {
    this.db = db;
    this.path = path;
  }

  /** The ledger of a project directory (`<ProjectKeeper home>/projects/<id>`); null when it has never been built. */
  static openDir(projectDirPath: string): Ledger | null {
    return Ledger.openPath(join(projectDirPath, 'ledger.sqlite'));
  }
  static openPath(path: string): Ledger | null {
    const db = openLedgerReadOnly(path);
    return db ? new Ledger(db, path) : null;
  }
  close(): void { try { this.db.close(); } catch { /* already closed */ } }

  private all<T>(sql: string, ...params: (string | number | null)[]): T[] { return this.db.prepare(sql).all(...params) as T[]; }
  private one<T>(sql: string, ...params: (string | number | null)[]): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined; }

  private readerColumns: boolean | null = null;
  /** Whether the ledger already records who reads each file's references (a ledger not yet rebuilt since D98 does not). */
  private hasReader(): boolean {
    this.readerColumns ??= (this.db.prepare('PRAGMA table_info(code_files)').all() as { name: string }[]).some((c) => c.name === 'reader');
    return this.readerColumns;
  }
  /** A code file's reader: recorded, or on a ledger not yet rebuilt since D98, the TypeScript compiler's by extension. */
  private readerOf(f: { path: string; reader?: string | null }): 'compiler' | 'engine' | null {
    if (this.hasReader()) return f.reader === 'compiler' || f.reader === 'engine' ? f.reader : null;
    return compilerReads(f.path) ? 'compiler' : null;
  }
  /** The folder of a repository's (or directory's) code snapshot and index, next to this ledger. */
  private engineDir(repo: string): string { return engineDirOf(engineRootOf(this.path), repo); }

  // ───────────────────────── repositories ─────────────────────────

  repos(): { id: string; path: string; trunk: string | null; trunkTip: string | null; head: string | null; headBranch: string | null; versionFrom: string | null }[] {
    return this.all<{ id: string; path: string; trunk: string | null; trunk_tip: string | null; head: string | null; head_branch: string | null; version_from: string | null }>('SELECT * FROM repos ORDER BY rowid')
      .map((r) => ({ id: r.id, path: r.path, trunk: r.trunk, trunkTip: r.trunk_tip, head: r.head, headBranch: r.head_branch, versionFrom: r.version_from }));
  }

  /** A repository by scope item id or path (any case, any slash); the first one when none is named. Null when unknown. */
  repoId(input?: string | null): string | null {
    const all = this.repos();
    if (!input) return all[0]?.id ?? null;
    const norm = (p: string) => nameForm(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return all.find((r) => r.id === input)?.id ?? all.find((r) => norm(r.path) === norm(input))?.id ?? all.find((r) => norm(r.path).endsWith(`/${norm(input)}`))?.id ?? null;
  }
  private repoPath(id: string): string | null { return this.repos().find((r) => r.id === id)?.path ?? null; }
  private repoFilter(input: string | undefined, column = 'repo'): { sql: string; params: string[] } | string {
    if (!input) return { sql: '', params: [] };
    const id = this.repoId(input);
    if (!id) return `${input} is not a repository of this ledger. Repositories: ${this.repos().map((r) => `${r.id} (${r.path})`).join(', ')}.`;
    return { sql: ` AND ${column} = ?`, params: [id] };
  }

  /** A since / until range on a milliseconds column (a date: the whole day, UTC). */
  private timeFilter(where: string[], params: (string | number)[], column: string, q: { since?: string; until?: string }): void {
    const since = boundMs(q.since, false);
    const until = boundMs(q.until, true);
    if (since !== null) { where.push(`${column} >= ?`); params.push(since); }
    if (until !== null) { where.push(`${column} <= ?`); params.push(until); }
  }

  // ───────────────────────── occurred helpers ─────────────────────────

  private commitOccurred(hash: string, at: string, committedAt?: string | null): Occurred {
    const a = materialTime(at) ?? at;
    const c = committedAt ? materialTime(committedAt) ?? committedAt : null;
    return { at: a, basis: 'Commit', anchor: `commit:${hash.slice(0, 12)}`, ...(c && c !== a ? { other: { at: c, basis: 'Commit', anchor: 'committer time' } } : {}) };
  }
  private rowOccurred(r: { occurred_at: string; occurred_basis: string; occurred_anchor: string | null; other_at?: string | null; other_basis?: string | null; undated?: number }): Occurred {
    return {
      at: r.occurred_at, basis: r.occurred_basis as Occurred['basis'], anchor: r.occurred_anchor,
      ...(r.other_at ? { other: { at: r.other_at, basis: (r.other_basis ?? 'Commit') as Occurred['basis'], anchor: null } } : {}),
      ...(r.undated ? { undated: true } : {}),
    };
  }
  /**
   * When a document version happened: its commit, with the date the document states for itself (docs.ts, rule 4) kept as
   * the other time (§2.11: "正文写明日期的，另记"; QC AY — a version row used to drop it); for the content of an
   * import-style root commit (AC-15), the date the document states, else the file's time in the working tree, else
   * undated — with the import commit kept as the other time.
   */
  private docOccurred(d: { path: string; commit_hash: string; at: string; import_root: number; blob: string; repo: string }): Occurred {
    const anchor = `doc:${d.path}@${d.commit_hash.slice(0, 10)}`;
    const text = this.blobText(d.repo, d.blob);
    if (!d.import_root) {
      const written = text === null ? null : datesOf(`${d.repo}:${d.blob}`, text).document;
      return occurred(d.at, 'Commit', anchor, written ? { at: written.at, basis: 'Written in text', anchor: `${d.path}:${written.line}` } : null);
    }
    const root = this.repoPath(d.repo);
    return occurredOfLine({
      commit: d.commit_hash, commitAt: d.at, importRoot: true, path: d.path, firstSeen: d.at,
      fileTime: root ? versionTime(root, d.path, d.commit_hash, d.at, true, d.at).fileTime : null,
    }, datesOf(`${d.repo}:${d.blob}`, text ?? ''), null);
  }
  /**
   * When a document outside version control says something (§2.11, the table's last row; CKC-22 AC-10, AC-15): the date
   * its text writes for that line — the line's own, else its entry's, else the one the document states for itself — with
   * the file's own time kept as the other time; else the file's own time (`File time`), which the rebuild recorded with
   * the file when it last read it (`loose:<path>`: size and time); else `Undated · first seen` when the rebuild first read
   * it. `line` null asks for the document as a whole. Never a made-up time: this used to be the epoch dressed as a `File
   * time` in a word hit, and the moment of the query as "first seen" in `resolve` (QC AY).
   */
  private looseOccurred(path: string, content: string, line: number | null): Occurred {
    const state = (key: string) => this.one<{ value: string }>('SELECT value FROM state WHERE key = ?', key)?.value ?? null;
    const stamp = state(`loose:${path}`);
    const ms = stamp ? Number(stamp.slice(stamp.indexOf(':') + 1)) : Number.NaN;
    const fileTime = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
    const dates = datesOf(`loose:${path}:${fileTime ?? ''}`, content);
    const written = line === null ? dates.document : dates.at(line);
    const file = fileTime ? { at: fileTime, basis: 'File time' as const, anchor: path } : null;
    if (written) return { at: written.at, basis: 'Written in text', anchor: `${path}:${written.line}`, ...(file ? { other: file } : {}) };
    if (file) return file;
    // The rebuild records the file's time with its text, so this is for a ledger that lost the record: the rebuild that
    // first read the file, else the last one (which had read it), both said as "first seen", undated.
    return undated(state(`loosefirst:${path}`) ?? this.lastRead(), `loose:${path}`);
  }

  /** When the ledger last read the project: its last rebuild, which had read whatever it holds. */
  private lastRead(): string {
    return this.one<{ value: string }>("SELECT value FROM state WHERE key = 'lastRebuildAt'")?.value ?? this.one<{ ended_at: string }>('SELECT ended_at FROM rebuilds ORDER BY id DESC LIMIT 1')?.ended_at ?? '';
  }

  /**
   * When a file of the current version happened (§2.11; CKC-22 AC-10): its last commit; outside version control, its own
   * time as the rebuild read it (`File time`: copying and moving change it, so a weak basis); else `Undated · first seen`
   * at the rebuild that first read it — never the moment of the query. A ledger kept before the file time and the first
   * reading were recorded (schema.ts `migrate`) falls back to its last rebuild, which had read the file.
   */
  private codeFileOccurred(f: Record<string, unknown>, anchor: string): Occurred {
    if (f.last_at) return { at: materialTime(String(f.last_at)) ?? String(f.last_at), basis: 'Commit', anchor: f.last_commit ? `commit:${String(f.last_commit).slice(0, 12)}` : null };
    if (typeof f.file_at === 'string' && f.file_at) return { at: f.file_at, basis: 'File time', anchor };
    return undated(typeof f.first_seen === 'string' && f.first_seen ? f.first_seen : this.lastRead(), anchor);
  }

  private blobText(repo: string, blob: string | null): string | null {
    if (!blob) return null;
    return this.one<{ content: string }>('SELECT content FROM texts WHERE key = ?', blobTextKey(repo, blob))?.content ?? null;
  }

  // ───────────────────────── the history map (AC-1) ─────────────────────────

  /** The orientation map of the whole history, per repository, computed in one call. */
  overview(opts: { repo?: string } = {}) {
    const ids = opts.repo ? [this.repoId(opts.repo)].filter((x): x is string => Boolean(x)) : this.repos().map((r) => r.id);
    return ids.map((id) => {
      const r = this.repos().find((x) => x.id === id)!;
      const c = this.one<{ c: number; t: number; m: number; tm: number; fp: number; a: string | null; b: string | null }>(
        'SELECT count(*) c, ifnull(sum(on_trunk), 0) t, ifnull(sum(merge), 0) m, ifnull(sum(merge * on_trunk), 0) tm, ifnull(sum(first_parent_trunk), 0) fp, min(author_ms) a, max(author_ms) b FROM commits WHERE repo = ?', id)!;
      const first = this.one<{ author_at: string }>('SELECT author_at FROM commits WHERE repo = ? ORDER BY author_ms LIMIT 1', id);
      const last = this.one<{ author_at: string }>('SELECT author_at FROM commits WHERE repo = ? ORDER BY author_ms DESC LIMIT 1', id);
      const perDay = new Map<string, number>();
      for (const row of this.all<{ author_at: string }>('SELECT author_at FROM commits WHERE repo = ?', id)) {
        const d = dayOf(row.author_at) ?? '?';
        perDay.set(d, (perDay.get(d) ?? 0) + 1);
      }
      const refs: Record<string, number> = {};
      for (const x of this.all<{ namespace: string; c: number }>('SELECT namespace, count(*) c FROM refs WHERE repo = ? AND present = 1 GROUP BY namespace', id)) refs[x.namespace] = x.c;
      const otherRefs = this.all<{ refname: string; type: string; tip: string }>("SELECT refname, type, tip FROM refs WHERE repo = ? AND present = 1 AND (namespace = 'other' OR type <> 'commit') ORDER BY refname LIMIT 50", id)
        .map((x) => ({ ref: x.refname, names: x.type, object: short(x.tip) }));
      const branches = this.all<{ name: string; namespace: string; tip: string; tip_at: string | null; merged: number | null; ahead: number | null }>('SELECT * FROM branches WHERE repo = ? ORDER BY namespace, name', id);
      const worktrees = this.all<{ path: string; branch: string | null; head: string | null; merged: number | null; detached: number; uncommitted: number }>('SELECT * FROM worktrees WHERE repo = ? ORDER BY path', id);
      const cleanups = this.all<{ key: string; commit_hash: string; at: string; deleted_docs: number; deleted_total: number; catalog_before: string; catalog_after: string }>('SELECT * FROM cleanups WHERE repo = ? ORDER BY at_ms', id);
      const deleted = this.one<{ c: number; p: number }>(`SELECT count(*) c, count(DISTINCT path) p FROM deleted_docs d WHERE repo = ?
        AND NOT EXISTS (SELECT 1 FROM code_files f WHERE f.repo = d.repo AND f.path = d.path)`, id)!;
      const deletedByDir = this.all<{ dir: string; n: number }>(`SELECT CASE WHEN instr(path, '/') > 0 THEN rtrim(path, replace(path, '/', '')) ELSE './' END dir, count(DISTINCT path) n
        FROM deleted_docs d WHERE repo = ? AND NOT EXISTS (SELECT 1 FROM code_files f WHERE f.repo = d.repo AND f.path = d.path) GROUP BY dir ORDER BY n DESC LIMIT 12`, id);
      const imports = this.all<{ hash: string; author_at: string }>('SELECT hash, author_at FROM commits WHERE repo = ? AND import_root = 1', id);
      const docs = this.one<{ v: number; p: number }>('SELECT count(*) v, count(DISTINCT path) p FROM docs WHERE repo = ?', id)!;
      return {
        repo: id, path: r.path, trunk: r.trunk, trunkTip: short(r.trunkTip), head: short(r.head), headBranch: r.headBranch,
        commits: { all: c.c, trunk: c.t, trunkFirstParent: c.fp, merges: c.m, mergesIntoTrunkHistory: c.tm, sideOnly: c.c - c.t },
        span: { from: first?.author_at ?? null, to: last?.author_at ?? null, days: perDay.size },
        refs, otherRefs, commitsPerDay: Object.fromEntries([...perDay.entries()].sort()),
        branches: {
          total: branches.length, merged: branches.filter((b) => b.merged === 1).length,
          notMerged: branches.filter((b) => b.merged === 0).map((b) => ({ name: b.name, namespace: b.namespace, tip: short(b.tip), tipAt: b.tip_at, aheadOfTrunk: b.ahead })),
          merged_names: branches.filter((b) => b.merged === 1).map((b) => b.name),
        },
        worktrees: worktrees.map((w) => ({ path: w.path, branch: w.branch, head: short(w.head), mergedIntoTrunk: w.merged === null ? null : w.merged === 1, detached: w.detached === 1, uncommitted: w.uncommitted })),
        documents: { versions: docs.v, paths: docs.p, deleted: deleted.p, deletedByDirectory: deletedByDir.map((d) => ({ dir: d.dir, documents: d.n })) },
        cleanups: cleanups.map((x) => ({ id: x.key, commit: short(x.commit_hash), at: x.at, deletedDocuments: x.deleted_docs, deletedFiles: x.deleted_total, documentsBefore: json<string[]>(x.catalog_before, []).length, documentsAfter: json<string[]>(x.catalog_after, []).length })),
        importRoots: imports.map((i) => ({ id: `commit:${i.hash.slice(0, 12)}`, at: i.author_at })),
        versionHistoryFrom: imports.length ? `${dayOf(first?.author_at ?? null)} (the import commit: content before it is dated by what the text says, else file time)` : dayOf(first?.author_at ?? null),
      };
    });
  }

  // ───────────────────────── commits ─────────────────────────

  private commitRow(r: Record<string, unknown>): CommitRow {
    const hash = String(r.hash);
    return {
      id: `commit:${hash.slice(0, 12)}`, repo: String(r.repo), hash, subject: String(r.subject), author: String(r.author),
      occurred: this.commitOccurred(hash, String(r.author_at), String(r.committer_at)), authoredAt: String(r.author_at), committedAt: String(r.committer_at),
      parents: String(r.parents).split(' ').filter(Boolean).length, merge: r.merge === 1, onTrunk: r.on_trunk === 1, reach: String(r.reach ?? ''),
      files: Number(r.fc ?? 0), ...(r.import_root === 1 ? { importRoot: true } : {}),
    };
  }

  /** Commits of the whole history, newest first (or oldest first), filtered and paged. */
  commits(q: Paging & { repo?: string; path?: string; keyword?: string; num?: string; author?: string; since?: string; until?: string; merges?: boolean; trunk?: boolean; sideOnly?: boolean; importRoots?: boolean; oldestFirst?: boolean }): Page<CommitRow> | string {
    const rf = this.repoFilter(q.repo, 'c.repo');
    if (typeof rf === 'string') return rf;
    const where: string[] = ['1 = 1'];
    const params: (string | number)[] = [...rf.params];
    if (q.path) {
      const p = nameForm(q.path).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
      where.push("EXISTS (SELECT 1 FROM commit_files cf WHERE cf.repo = c.repo AND cf.hash = c.hash AND (cf.path = ? OR cf.path LIKE ? ESCAPE '\\' OR cf.old_path = ?))");
      params.push(p, `${likeEscape(p)}/%`, p);
    }
    if (q.keyword) { where.push("(c.subject LIKE ? ESCAPE '\\' OR c.body LIKE ? ESCAPE '\\')"); const k = `%${likeEscape(q.keyword)}%`; params.push(k, k); }
    if (q.num) { where.push("c.hash IN (SELECT n.commit_hash FROM nums n WHERE n.num = ? AND n.kind = 'commit')"); params.push(q.num.trim()); }
    if (q.author) { where.push("c.author LIKE ? ESCAPE '\\'"); params.push(`%${likeEscape(q.author)}%`); }
    const since = boundMs(q.since, false);
    const until = boundMs(q.until, true);
    if (since !== null) { where.push('c.author_ms >= ?'); params.push(since); }
    if (until !== null) { where.push('c.author_ms <= ?'); params.push(until); }
    if (q.merges) where.push('c.merge = 1');
    if (q.trunk) where.push('c.on_trunk = 1');
    if (q.sideOnly) where.push('c.on_trunk = 0');
    if (q.importRoots) where.push('c.import_root = 1');
    const w = `WHERE ${where.join(' AND ')}${rf.sql}`;
    const total = this.one<{ c: number }>(`SELECT count(*) c FROM commits c ${w}`, ...params)!.c;
    const rows = this.all<Record<string, unknown>>(`SELECT c.*, (SELECT count(*) FROM commit_files cf WHERE cf.repo = c.repo AND cf.hash = c.hash) fc FROM commits c ${w}
      ORDER BY c.author_ms ${q.oldestFirst ? 'ASC' : 'DESC'}, c.hash LIMIT ? OFFSET ?`, ...params, lim(q), off(q));
    return pageOf(total, rows.map((r) => this.commitRow(r)), off(q));
  }

  /** The commit a (short) hash names; ambiguity and absence are said, not guessed. */
  private findCommit(hashInput: string, repo?: string): Record<string, unknown> | string {
    const h = hashInput.trim().toLowerCase().replace(/^commit:/, '');
    if (!/^[0-9a-f]{4,40}$/.test(h)) return `“${hashInput}” is not a commit hash.`;
    const rf = this.repoFilter(repo);
    if (typeof rf === 'string') return rf;
    const hits = this.all<Record<string, unknown>>(`SELECT * FROM commits WHERE hash LIKE ?${rf.sql} LIMIT 3`, `${h}%`, ...rf.params);
    if (hits.length === 0) return `No commit ${hashInput} in the ledger${repo ? ` of ${repo}` : ''}.`;
    const distinct = new Set(hits.map((x) => x.hash));
    if (distinct.size > 1) return `${hashInput} is short for more than one commit (${[...distinct].map((x) => String(x).slice(0, 12)).join(', ')}): give more of the hash.`;
    return hits[0]!;
  }

  /** One commit: its message, both times, every file it changed, the branches that contain it and the merge that brought it into the trunk. */
  commit(hashInput: string, opts: Paging & { repo?: string } = {}) {
    const r = this.findCommit(hashInput, opts.repo);
    if (typeof r === 'string') return r;
    const hash = String(r.hash);
    const repo = String(r.repo);
    const files = this.all<{ status: string; path: string; old_path: string | null; added: number | null; deleted: number | null }>(
      'SELECT status, path, old_path, added, deleted FROM commit_files WHERE repo = ? AND hash = ? ORDER BY path', repo, hash);
    const root = this.repoPath(repo);
    let branches: string[] = [];
    let mergedInto: { id: string; subject: string; at: string } | null = null;
    if (root) {
      const b = ledgerGit(root, ['branch', '-a', '--contains', hash, '--format=%(refname:short)'], { timeoutMs: 30_000 });
      if (b.ok) branches = b.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const trunk = this.repos().find((x) => x.id === repo)?.trunkTip;
      if (trunk && r.on_trunk === 1 && r.first_parent_trunk !== 1) {
        // The first commit of the trunk's first-parent line that has it: the merge that brought it in.
        const m = ledgerGit(root, ['rev-list', '--ancestry-path', '--first-parent', '--reverse', `${hash}..${trunk}`], { timeoutMs: 30_000 });
        const first = m.ok ? m.out.split(/\s+/).find((x) => /^[0-9a-f]{40}$/.test(x)) : undefined;
        const mr = first ? this.one<{ hash: string; subject: string; author_at: string }>('SELECT hash, subject, author_at FROM commits WHERE repo = ? AND hash = ?', repo, first) : undefined;
        if (mr) mergedInto = { id: `commit:${mr.hash.slice(0, 12)}`, subject: mr.subject, at: mr.author_at };
      }
    }
    const nums = this.all<{ num: string }>("SELECT DISTINCT num FROM nums WHERE repo = ? AND kind = 'commit' AND commit_hash = ?", repo, hash).map((x) => x.num);
    const o = off(opts);
    const l = lim(opts, 1000);
    return {
      ...this.commitRow({ ...r, fc: files.length }), body: String(r.body), parentHashes: String(r.parents).split(' ').filter(Boolean).map((p) => p.slice(0, 12)),
      numbers: nums, branches, mergedIntoTrunkBy: mergedInto,
      files: pageOf(files.length, files.slice(o, o + l).map((f) => ({ status: f.status, path: f.path, ...(f.old_path ? { from: f.old_path } : {}), added: f.added, deleted: f.deleted })), o),
    };
  }

  // ───────────────────────── documents (AC-3) ─────────────────────────

  private docRow(d: Record<string, unknown>): DocVersionRow {
    const repo = String(d.repo);
    const path = String(d.path);
    const commit = String(d.commit_hash);
    return {
      id: String(d.key), repo, path, commit: commit.slice(0, 12), change: String(d.change), from: d.prev_path && d.prev_path !== path ? String(d.prev_path) : null,
      occurred: this.docOccurred({ repo, path, commit_hash: commit, at: String(d.at), import_root: Number(d.import_root), blob: String(d.blob) }),
      sections: Number(d.sections), lines: Number(d.lines),
      diff: d.added === null ? null : { added: json<string[]>(String(d.added), []), removed: json<string[]>(String(d.removed), []), changed: json<string[]>(String(d.changed), []) },
      current: Number(d.cur) > 0, onTrunk: Number(d.on_trunk) === 1, importRoot: Number(d.import_root) === 1,
    };
  }

  /** Every version of a document (following it across moves), its deletions, and which version is current. */
  docVersions(pathInput: string, opts: { repo?: string } = {}): ReturnType<Ledger['docVersionsRead']> {
    // The ledger is read only between rebuilds, and a view asks for the same document once per item that cites it (246
    // decisions in one ADR on the resident D99 run): each answer is kept until the next rebuild.
    const stamp = this.lastRead();
    if (!this.docVersionsCache || this.docVersionsCache.stamp !== stamp || this.docVersionsCache.map.size > 2000) this.docVersionsCache = { stamp, map: new Map() };
    const key = `${opts.repo ?? ''}\u0000${pathInput}`;
    const cached = this.docVersionsCache.map.get(key);
    if (cached !== undefined) return cached as ReturnType<Ledger['docVersionsRead']>;
    const answer = this.docVersionsRead(pathInput, opts);
    this.docVersionsCache.map.set(key, answer);
    return answer;
  }
  private docVersionsCache: { stamp: string; map: Map<string, unknown> } | null = null;

  private docVersionsRead(pathInput: string, opts: { repo?: string } = {}) {
    const rf = this.repoFilter(opts.repo, 'd.repo');
    if (typeof rf === 'string') return rf;
    const path = nameForm(pathInput).replace(/\\/g, '/').replace(/^\.\//, '');
    // The document's names over time: this path and every path it was moved from.
    const names = new Set([path]);
    for (let i = 0; i < 20; i++) {
      const before = names.size;
      for (const p of [...names]) for (const x of this.all<{ prev_path: string }>(`SELECT DISTINCT prev_path FROM docs d WHERE path = ? AND change IN ('Renamed', 'Copied') AND prev_path IS NOT NULL${rf.sql}`, p, ...rf.params)) names.add(x.prev_path);
      if (names.size === before) break;
    }
    const list = [...names];
    const rows = this.all<Record<string, unknown>>(`SELECT d.*, c.on_trunk, (SELECT count(*) FROM code_files f WHERE f.repo = d.repo AND f.path = d.path AND f.blob = d.blob) cur
      FROM docs d JOIN commits c ON c.repo = d.repo AND c.hash = d.commit_hash WHERE d.path IN (${list.map(() => '?').join(',')})${rf.sql} ORDER BY d.at_ms, d.commit_hash`, ...list, ...rf.params);
    if (rows.length === 0) {
      const like = this.all<{ path: string }>(`SELECT DISTINCT path FROM docs WHERE path LIKE ? ESCAPE '\\' LIMIT 8`, `%${likeEscape(path.split('/').pop() ?? path)}%`);
      return `No version of ${path} in the ledger's document history.${like.length ? ` Documents with a similar name: ${like.map((x) => x.path).join(', ')}.` : ''}`;
    }
    const deletions = this.all<{ key: string; path: string; deleted_commit: string; deleted_at: string; readable_at: string | null; cleanup: number }>(
      `SELECT * FROM deleted_docs d WHERE path IN (${list.map(() => '?').join(',')})${rf.sql} ORDER BY deleted_ms`, ...list, ...rf.params);
    return {
      path, names: list,
      versions: rows.map((r) => this.docRow(r)),
      deletions: deletions.map((d) => ({ id: d.key, path: d.path, commit: short(d.deleted_commit), occurred: this.commitOccurred(d.deleted_commit, d.deleted_at), readableAt: short(d.readable_at), cleanup: d.cleanup === 1 })),
      inCurrentVersion: this.one<{ c: number }>('SELECT count(*) c FROM code_files WHERE path = ?', path)!.c > 0,
    };
  }

  /** Which sections differ between any two versions of a document (by version id, or path and commit). */
  docCompare(from: { id?: string; path?: string; commit?: string; repo?: string }, to: { id?: string; path?: string; commit?: string; repo?: string }) {
    const a = this.docText(from, { from: 1, to: Number.MAX_SAFE_INTEGER });
    const b = this.docText(to, { from: 1, to: Number.MAX_SAFE_INTEGER });
    if (typeof a === 'string') return a;
    if (typeof b === 'string') return b;
    const whole = (x: { id: string; repo: string; path: string }) => {
      const row = this.one<{ blob: string }>('SELECT blob FROM docs WHERE key = ? LIMIT 1', x.id);
      return (row ? this.blobText(x.repo, row.blob) : null) ?? '';
    };
    return { from: { id: a.id, occurred: a.occurred }, to: { id: b.id, occurred: b.occurred }, sections: diffSections(whole(a), whole(b)) };
  }

  /** Document versions made in a period or under a directory, oldest first (what the documents did then). */
  docChanges(q: Paging & { repo?: string; dir?: string; since?: string; until?: string; change?: string } = {}) {
    const rf = this.repoFilter(q.repo, 'd.repo');
    if (typeof rf === 'string') return rf;
    const where = ['1 = 1'];
    const params: (string | number)[] = [];
    if (q.dir) { where.push("d.path LIKE ? ESCAPE '\\'"); params.push(`${likeEscape(nameForm(q.dir).replace(/\\/g, '/').replace(/\/+$/, ''))}/%`); }
    const since = boundMs(q.since, false);
    const until = boundMs(q.until, true);
    if (since !== null) { where.push('d.at_ms >= ?'); params.push(since); }
    if (until !== null) { where.push('d.at_ms <= ?'); params.push(until); }
    if (q.change) { where.push('d.change = ?'); params.push(q.change); }
    const w = `WHERE ${where.join(' AND ')}${rf.sql}`;
    const total = this.one<{ c: number }>(`SELECT count(*) c FROM docs d ${w}`, ...params, ...rf.params)!.c;
    const rows = this.all<Record<string, unknown>>(`SELECT d.*, c.on_trunk, (SELECT count(*) FROM code_files f WHERE f.repo = d.repo AND f.path = d.path AND f.blob = d.blob) cur
      FROM docs d JOIN commits c ON c.repo = d.repo AND c.hash = d.commit_hash ${w} ORDER BY d.at_ms, d.path LIMIT ? OFFSET ?`, ...params, ...rf.params, lim(q), off(q));
    return pageOf(total, rows.map((r) => this.docRow(r)), off(q));
  }

  /** A document version by its entry id, or by path and commit; its text from the ledger's copy (paged by lines). */
  docText(input: { id?: string; path?: string; commit?: string; repo?: string }, lines: { from?: number; to?: number } = {}) {
    let row: Record<string, unknown> | undefined;
    if (input.id) row = this.one('SELECT * FROM docs WHERE key = ? LIMIT 1', input.id.trim());
    else if (input.path && input.commit) {
      const c = this.findCommit(input.commit, input.repo);
      if (typeof c === 'string') return c;
      const path = nameForm(input.path).replace(/\\/g, '/');
      row = this.one('SELECT * FROM docs WHERE repo = ? AND path = ? AND commit_hash = ?', String(c.repo), path, String(c.hash));
      if (!row) {
        // Not a version the commit made: the version its tree has is the latest version up to it on its history.
        const root = this.repoPath(String(c.repo));
        const blob = root ? ledgerGit(root, ['rev-parse', '--verify', '--quiet', `${String(c.hash)}:${path}`]).out.trim() : '';
        if (/^[0-9a-f]{40}$/.test(blob)) row = this.one('SELECT * FROM docs WHERE repo = ? AND path = ? AND blob = ? ORDER BY at_ms LIMIT 1', String(c.repo), path, blob) ?? { repo: c.repo, path, commit_hash: c.hash, blob, at: c.author_at, import_root: c.import_root, key: `doc:${path}@${String(c.hash).slice(0, 10)}` };
      }
    } else return 'Give the version: its id (doc:<path>@<commit>), or path and commit.';
    if (!row) return `No such version in the ledger: ${input.id ?? `${input.path} at ${input.commit}`}. pk_ledger_doc_versions lists the versions of a document.`;
    const repo = String(row.repo);
    let text = this.blobText(repo, String(row.blob));
    if (text === null) {
      const root = this.repoPath(repo);
      const buf = root ? catBlobs(root, [String(row.blob)]).get(String(row.blob)) : null;
      if (!buf || !isText(buf)) return `${String(row.path)} at ${String(row.commit_hash).slice(0, 10)} is not text the ledger can show.`;
      text = buf.toString('utf8');
    }
    const all = text.split(/\r?\n/);
    const from = Math.min(Math.max(1, Math.floor(lines.from ?? 1)), Math.max(1, all.length));
    const cap = 60_000;
    const out: string[] = [];
    let size = 0;
    let end = from - 1;
    const last = Math.min(all.length, lines.to && lines.to >= from ? Math.floor(lines.to) : all.length);
    for (let i = from - 1; i < last; i++) {
      if (out.length && size + all[i]!.length + 1 > cap) break;
      out.push(all[i]!);
      size += all[i]!.length + 1;
      end = i + 1;
    }
    const current = this.one<{ c: number }>('SELECT count(*) c FROM code_files WHERE repo = ? AND path = ? AND blob = ?', repo, String(row.path), String(row.blob))!.c > 0;
    return {
      id: String(row.key), repo, path: String(row.path), commit: String(row.commit_hash).slice(0, 12), current,
      occurred: this.docOccurred({ repo, path: String(row.path), commit_hash: String(row.commit_hash), at: String(row.at), import_root: Number(row.import_root ?? 0), blob: String(row.blob) }),
      lines: all.length, fromLine: from, toLine: end, ...(end < last ? { nextFromLine: end + 1 } : {}), text: out.join('\n'),
    };
  }

  /**
   * The materials a sweep's brief names, as the ledger has them (Spec §3.7: the depth question counts each path's
   * materials by the question list): every version of each document at or under a named path, the current source files
   * there (not documents), and the named commits it knows (a prefix that names one commit). Keys, so a caller can take
   * the union over several briefs.
   */
  named(input: { readonly paths: readonly string[]; readonly commits: readonly string[] }): { versions: { key: string; path: string }[]; codeFiles: { key: string; lines: number }[]; commits: string[] } {
    const versions = new Map<string, string>();
    const code = new Map<string, number>();
    const commits = new Set<string>();
    for (const raw of input.paths) {
      const p = nameForm(raw).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
      if (!p) continue;
      for (const d of this.all<{ key: string; path: string }>(`SELECT key, path FROM docs WHERE path = ? OR path LIKE ? ESCAPE '\\'`, p, `${likeEscape(p)}/%`)) versions.set(d.key, d.path);
      for (const f of this.all<{ repo: string; path: string; lines: number }>(`SELECT repo, path, lines FROM code_files WHERE generated = 0 AND classification IS NULL AND lines IS NOT NULL
        AND (lang IS NULL OR lang NOT IN ('markdown', 'text')) AND (path = ? OR path LIKE ? ESCAPE '\\')`, p, `${likeEscape(p)}/%`)) code.set(`${f.repo}:${f.path}`, f.lines);
    }
    for (const c of input.commits) {
      const hits = this.all<{ hash: string }>('SELECT DISTINCT hash FROM commits WHERE hash LIKE ? LIMIT 2', `${c.toLowerCase()}%`);
      if (hits.length === 1) commits.add(hits[0]!.hash);
    }
    return { versions: [...versions].map(([key, path]) => ({ key, path })), codeFiles: [...code].map(([key, lines]) => ({ key, lines })), commits: [...commits] };
  }

  // ───────────────────────── what a deepening reads (Spec §3.7: its reading assignments) ─────────────────────────

  /**
   * Document versions by id, with what reading them needs: the repository and path, the commit and when it was made, the
   * size, and whether the version is the one the current version of its repository has. Ids the ledger lacks are left out.
   */
  versionsByKey(keys: readonly string[]): { key: string; repo: string; path: string; commit: string; blob: string; bytes: number; lines: number; atMs: number; current: boolean }[] {
    const stmt = this.db.prepare('SELECT d.key, d.repo, d.path, d.commit_hash, d.blob, d.bytes, d.lines, d.at_ms, (SELECT count(*) FROM code_files f WHERE f.repo = d.repo AND f.path = d.path AND f.blob = d.blob) cur FROM docs d WHERE d.key = ? LIMIT 1');
    const out: { key: string; repo: string; path: string; commit: string; blob: string; bytes: number; lines: number; atMs: number; current: boolean }[] = [];
    for (const key of new Set(keys)) {
      const r = stmt.get(key) as { key: string; repo: string; path: string; commit_hash: string; blob: string; bytes: number | null; lines: number | null; at_ms: number; cur: number } | undefined;
      if (r) out.push({ key: r.key, repo: r.repo, path: r.path, commit: r.commit_hash, blob: r.blob, bytes: Number(r.bytes ?? 0), lines: Number(r.lines ?? 0), atMs: Number(r.at_ms), current: Number(r.cur) > 0 });
    }
    return out;
  }

  /** A document version's whole text — the ledger's copy, else git's — by its id; null when the ledger lacks it or it is not text. */
  versionText(key: string): string | null {
    const row = this.one<{ repo: string; blob: string }>('SELECT repo, blob FROM docs WHERE key = ? LIMIT 1', key);
    if (!row) return null;
    const kept = this.blobText(row.repo, row.blob);
    if (kept !== null) return kept;
    const root = this.repoPath(row.repo);
    const buf = root ? catBlobs(root, [row.blob]).get(row.blob) : null;
    return buf && isText(buf) ? buf.toString('utf8') : null;
  }

  /** Every document version (id and path): what a kind of question counted by the ledger's totals plans whole. */
  allVersions(): { key: string; path: string }[] {
    return this.all<{ key: string; path: string }>('SELECT key, path FROM docs ORDER BY path, at_ms');
  }

  /** Every code file of the current version — not generated, not third-party, not a document — by `<repo>:<path>`, with its lines. */
  allCodeFiles(): { key: string; lines: number }[] {
    return this.all<{ repo: string; path: string; lines: number | null }>(`SELECT repo, path, lines FROM code_files WHERE generated = 0 AND classification IS NULL AND lines IS NOT NULL
      AND (lang IS NULL OR lang NOT IN ('markdown', 'text')) ORDER BY repo, path`).map((f) => ({ key: `${f.repo}:${f.path}`, lines: Number(f.lines ?? 0) }));
  }

  /** Code files by `<repo>:<path>`: their size in bytes and lines. */
  codeFilesByKey(keys: readonly string[]): { key: string; repo: string; path: string; bytes: number; lines: number }[] {
    // The repositories, and the scope items outside version control whose files the ledger keeps by their id.
    const repos = this.all<{ repo: string }>('SELECT DISTINCT repo FROM code_files').map((r) => r.repo).sort((a, b) => b.length - a.length);
    const stmt = this.db.prepare('SELECT bytes, lines FROM code_files WHERE repo = ? AND path = ? LIMIT 1');
    const out: { key: string; repo: string; path: string; bytes: number; lines: number }[] = [];
    for (const key of new Set(keys)) {
      const repo = repos.find((r) => key.startsWith(`${r}:`));
      if (!repo) continue;
      const path = key.slice(repo.length + 1);
      const r = stmt.get(repo, path) as { bytes: number | null; lines: number | null } | undefined;
      if (r) out.push({ key, repo, path, bytes: Number(r.bytes ?? 0), lines: Number(r.lines ?? 0) });
    }
    return out;
  }

  /** Every commit on every ref, by full hash. */
  allCommits(): string[] {
    return this.all<{ hash: string }>('SELECT hash FROM commits ORDER BY author_ms, hash').map((r) => r.hash);
  }

  /**
   * Commits by full hash, each with what reading it takes (its message, how many files it changed) and what it belongs with:
   * the merge that brought it into the trunk, the branch it is on when it never reached the trunk, else the trunk itself —
   * found from the parents the ledger recorded, oldest merge first.
   */
  commitsByHash(hashes: readonly string[]): { hash: string; repo: string; subject: string; bytes: number; files: number; atMs: number; group: string; groupLabel: string }[] {
    const wanted = new Set(hashes.map((h) => h.toLowerCase()));
    if (wanted.size === 0) return [];
    type Row = { repo: string; hash: string; parents: string; merge: number; on_trunk: number; first_parent_trunk: number; author_ms: number; subject: string; body: string | null };
    const rows = this.all<Row>('SELECT repo, hash, parents, merge, on_trunk, first_parent_trunk, author_ms, subject, body FROM commits ORDER BY author_ms, hash');
    const byHash = new Map(rows.map((r) => [r.hash, r]));
    const groupOf = new Map<string, { group: string; label: string }>();
    // A merge on the trunk's first-parent line takes what it brought in: what its later parents reach that the trunk had not.
    for (const m of rows.filter((r) => r.merge === 1 && r.first_parent_trunk === 1)) {
      const label = `merge ${m.hash.slice(0, 7)}: ${m.subject.slice(0, 80)}`;
      const stack = String(m.parents).split(' ').filter(Boolean).slice(1);
      while (stack.length) {
        const h = stack.pop()!;
        const c = byHash.get(h);
        if (!c || c.first_parent_trunk === 1 || groupOf.has(h)) continue;
        groupOf.set(h, { group: `merge:${m.hash}`, label });
        stack.push(...String(c.parents).split(' ').filter(Boolean));
      }
      groupOf.set(m.hash, { group: `merge:${m.hash}`, label });
    }
    // What never reached the trunk goes with the branch it is on.
    for (const b of this.all<{ repo: string; name: string; tip: string }>('SELECT repo, name, tip FROM branches ORDER BY name')) {
      const stack = [b.tip];
      while (stack.length) {
        const h = stack.pop()!;
        const c = byHash.get(h);
        if (!c || c.on_trunk === 1 || groupOf.has(h)) continue;
        groupOf.set(h, { group: `branch:${b.repo}:${b.name}`, label: `branch ${b.name}` });
        stack.push(...String(c.parents).split(' ').filter(Boolean));
      }
    }
    const files = this.db.prepare('SELECT count(*) c FROM commit_files WHERE repo = ? AND hash = ?');
    return rows.filter((r) => wanted.has(r.hash)).map((r) => {
      const g = groupOf.get(r.hash) ?? { group: `trunk:${r.repo}`, label: 'the trunk' };
      const n = Number((files.get(r.repo, r.hash) as { c: number }).c);
      return { hash: r.hash, repo: r.repo, subject: r.subject, bytes: Buffer.byteLength(`${r.subject}\n${r.body ?? ''}`) + n * 80 + 400, files: n, atMs: Number(r.author_ms), group: g.group, groupLabel: g.label };
    });
  }

  /** Every session the ledger read, by its id. */
  allSessions(): string[] {
    return this.all<{ key: string }>('SELECT key FROM sessions ORDER BY started_at IS NULL, started_at, key').map((r) => r.key);
  }

  /** Every session's log, by the session's id. */
  sessionLogs(): { key: string; file: string }[] {
    return this.all<{ key: string; file: string }>('SELECT key, file FROM sessions');
  }

  /**
   * Sessions by ledger id: host, native id, log, start, how many messages, the index range of its messages and the bytes of
   * text the ledger keeps of them (the owner's messages and the agent messages they answer; the rest by speaker and size).
   */
  sessionsByKey(keys: readonly string[]): { key: string; host: string; sessionId: string; file: string; startedAt: string | null; messages: number; firstIndex: number; lastIndex: number; textBytes: number }[] {
    const s = this.db.prepare('SELECT key, host, session_id, file, started_at, messages FROM sessions WHERE key = ?');
    const m = this.db.prepare('SELECT min(idx) a, max(idx) b, count(*) c, ifnull(sum(length(CAST(text AS BLOB))), 0) t FROM session_messages WHERE session = ?');
    const out: { key: string; host: string; sessionId: string; file: string; startedAt: string | null; messages: number; firstIndex: number; lastIndex: number; textBytes: number }[] = [];
    for (const key of new Set(keys)) {
      const r = s.get(key) as { key: string; host: string; session_id: string; file: string; started_at: string | null; messages: number } | undefined;
      if (!r) continue;
      const x = m.get(key) as { a: number | null; b: number | null; c: number; t: number };
      out.push({ key: r.key, host: r.host, sessionId: r.session_id, file: r.file, startedAt: r.started_at, messages: Number(x.c), firstIndex: Number(x.a ?? 0), lastIndex: Number(x.b ?? -1), textBytes: Number(x.t) });
    }
    return out;
  }

  /**
   * The sessions a brief names: those whose log is at or under one of these paths (absolute, any case, any slash), and those
   * whose native id begins with one of these ids (eight characters or more, so a short hash names no session by chance).
   */
  namedSessions(paths: readonly string[], ids: readonly string[] = []): string[] {
    const rows = this.all<{ key: string; file: string; session_id: string }>('SELECT key, file, session_id FROM sessions');
    const norm = (p: string) => nameForm(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const roots = paths.map(norm).filter((p) => /^([a-z]:\/|\/)/.test(p));
    const prefixes = ids.map((i) => i.toLowerCase()).filter((i) => i.length >= 8);
    return rows.filter((r) => {
      const f = norm(r.file);
      return roots.some((root) => f === root || f.startsWith(`${root}/`)) || prefixes.some((p) => r.session_id.toLowerCase().startsWith(p));
    }).map((r) => r.key);
  }

  /** Documents deleted from the history (not back in the current version), with the commit whose tree still has each in full. */
  deletedDocs(q: Paging & { repo?: string; dir?: string; cleanupsOnly?: boolean } = {}) {
    const rf = this.repoFilter(q.repo, 'd.repo');
    if (typeof rf === 'string') return rf;
    const where = ['NOT EXISTS (SELECT 1 FROM code_files f WHERE f.repo = d.repo AND f.path = d.path)'];
    const params: (string | number)[] = [];
    if (q.dir) { where.push("d.path LIKE ? ESCAPE '\\'"); params.push(`${likeEscape(nameForm(q.dir).replace(/\\/g, '/').replace(/\/+$/, ''))}/%`); }
    if (q.cleanupsOnly) where.push('d.cleanup = 1');
    const w = `WHERE ${where.join(' AND ')}${rf.sql}`;
    const total = this.one<{ c: number }>(`SELECT count(*) c FROM deleted_docs d ${w}`, ...params, ...rf.params)!.c;
    const rows = this.all<{ key: string; repo: string; path: string; deleted_commit: string; deleted_at: string; readable_at: string | null; cleanup: number }>(
      `SELECT d.* FROM deleted_docs d ${w} ORDER BY d.deleted_ms DESC, d.path LIMIT ? OFFSET ?`, ...params, ...rf.params, lim(q), off(q));
    return pageOf(total, rows.map((d) => ({
      id: d.key, repo: d.repo, path: d.path, deletedIn: `commit:${d.deleted_commit.slice(0, 12)}`, occurred: this.commitOccurred(d.deleted_commit, d.deleted_at),
      readableAt: d.readable_at ? `commit:${d.readable_at.slice(0, 12)}` : null, cleanup: d.cleanup === 1,
    })), off(q));
  }

  /** The cleanup commits (CLEANUP_RULE), each with the document catalogue before and after. */
  cleanups(opts: { repo?: string; id?: string } = {}) {
    const rf = this.repoFilter(opts.repo);
    if (typeof rf === 'string') return rf;
    const rows = this.all<{ key: string; repo: string; commit_hash: string; at: string; deleted_docs: number; deleted_total: number; catalog_before: string; catalog_after: string }>(
      `SELECT * FROM cleanups WHERE 1 = 1${opts.id ? ' AND (key = ? OR commit_hash LIKE ?)' : ''}${rf.sql} ORDER BY at_ms`, ...(opts.id ? [opts.id, `${opts.id.replace(/^cleanup:/, '')}%`] : []), ...rf.params);
    return {
      rule: CLEANUP_RULE,
      cleanups: rows.map((c) => {
        const before = json<string[]>(c.catalog_before, []);
        const after = new Set(json<string[]>(c.catalog_after, []));
        const subject = this.one<{ subject: string }>('SELECT subject FROM commits WHERE repo = ? AND hash = ?', c.repo, c.commit_hash)?.subject ?? '';
        return {
          id: c.key, commit: `commit:${c.commit_hash.slice(0, 12)}`, subject, occurred: this.commitOccurred(c.commit_hash, c.at), deletedDocuments: c.deleted_docs, deletedFiles: c.deleted_total,
          before: before.length, after: after.size, removed: before.filter((p) => !after.has(p)), added: [...after].filter((p) => !before.includes(p)),
          ...(opts.id ? { catalogBefore: before, catalogAfter: [...after] } : {}),
        };
      }),
    };
  }

  // ───────────────────────── line entries: supersessions, numbers, verdicts ─────────────────────────

  private lineBase(r: Record<string, unknown>): LineRow {
    const first = (r.first_commit ?? r.commit_hash ?? null) as string | null;
    return {
      id: String(r.key), repo: (r.repo as string | null) ?? null, path: (r.path as string | null) ?? null,
      line: (r.current_line ?? r.first_line ?? r.line ?? null) as number | null, text: String(r.text ?? r.context ?? ''),
      occurred: this.rowOccurred(r as never), firstIn: first ? `commit:${first.slice(0, 12)}` : null,
      lastIn: r.last_commit ? `commit:${String(r.last_commit).slice(0, 12)}` : null, current: r.current === 1,
    };
  }

  /** Explicit old/new readings and rows of the project's own obsolete lists (AC-4). */
  supersessions(q: Paging & { repo?: string; path?: string; pattern?: string; obsoleteOnly?: boolean; currentOnly?: boolean; source?: string; keyword?: string; since?: string; until?: string } = {}): Page<SupersessionRow> | string {
    const rf = this.repoFilter(q.repo);
    if (typeof rf === 'string') return rf;
    const where = ['1 = 1'];
    const params: (string | number)[] = [];
    if (q.path) { const p = nameForm(q.path).replace(/\\/g, '/'); where.push("(path = ? OR path LIKE ? ESCAPE '\\')"); params.push(p, `${likeEscape(p.replace(/\/+$/, ''))}/%`); }
    if (q.pattern) { where.push('pattern = ?'); params.push(q.pattern); }
    if (q.obsoleteOnly) where.push('obsolete_list = 1');
    if (q.currentOnly) where.push('current = 1');
    if (q.source) { where.push('source = ?'); params.push(q.source); }
    if (q.keyword) { where.push("(text LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\')"); const k = `%${likeEscape(q.keyword)}%`; params.push(k, k); }
    this.timeFilter(where, params, 'first_ms', q);
    const w = `WHERE ${where.join(' AND ')}${rf.sql}`;
    const total = this.one<{ c: number }>(`SELECT count(*) c FROM supersedes ${w}`, ...params, ...rf.params)!.c;
    const rows = this.all<Record<string, unknown>>(`SELECT * FROM supersedes ${w} ORDER BY first_ms IS NULL, first_ms, path, first_line LIMIT ? OFFSET ?`, ...params, ...rf.params, lim(q), off(q));
    return pageOf(total, rows.map((r) => ({
      ...this.lineBase(r), source: String(r.source), pattern: String(r.pattern), target: (r.target as string | null) ?? null,
      replaced: (r.replaced as string | null) ?? null, replacement: (r.replacement as string | null) ?? null, syntax: (r.syntax as string | null) ?? null,
      obsoleteList: r.obsolete_list === 1, list: (r.list_heading as string | null) ?? null,
      ...(r.source === 'commit' ? { firstIn: `commit:${String(r.first_commit).slice(0, 12)}`, path: null } : {}),
    })), off(q));
  }

  /**
   * The numbers a document defines as it stands now (CJ; CKC-23 AC-21): every current definition of a recognised number
   * in the file — a heading, a bold entry line, a table's first column, the front-matter id — in line order. `repo` is a
   * repository's scope item id or path; `path` is repository-relative (a directory gives the files under it).
   */
  definitionsIn(repo: string, path: string): { readonly num: string; readonly rule: string; readonly position: string; readonly line: number; readonly context: string; readonly path: string }[] {
    const id = this.repoId(repo);
    if (!id) return [];
    const p = nameForm(path).replace(/\\/g, '/').replace(/\/+$/, '');
    return this.currentLines(this.all<{ key: string; repo: string | null; num: string; rule: string; position: string | null; line: number | null; context: string; path: string }>(
      `SELECT key, repo, num, rule, position, line, context, path FROM nums WHERE repo = ? AND kind IN ('doc', 'loose') AND place = 'definition' AND current = 1
        AND (path = ? OR path LIKE ? ESCAPE '\\')`, id, p, `${likeEscape(p)}/%`,
    )).map((x) => ({ num: x.num, rule: x.rule, position: x.position ?? '', line: x.line ?? 0, context: x.context, path: x.path }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  }

  /**
   * A number's row gives the line and the words of the version it first appeared in; a document read now has it where the
   * current version has it. Each row, moved to its line in the checkout's version (`doc_items` for that blob) and given
   * that line's words; a row the current version does not place keeps what it had.
   */
  private currentLines<T extends { key: string; repo: string | null; path: string | null; line: number | null; context: string }>(rows: readonly T[]): T[] {
    const blobs = new Map<string, { blob: string | null; lines: string[] | null }>();
    const blobOf = (repo: string, path: string) => {
      const k = `${repo}\u0000${path}`;
      if (!blobs.has(k)) {
        const f = this.one<{ blob: string | null }>('SELECT blob FROM code_files WHERE repo = ? AND path = ?', repo, path);
        const text = f?.blob ? this.blobText(repo, f.blob) : null;
        blobs.set(k, { blob: f?.blob ?? null, lines: text === null ? null : text.split(/\r?\n/) });
      }
      return blobs.get(k)!;
    };
    return rows.map((r) => {
      if (!r.repo || !r.path) return r;
      const b = blobOf(r.repo, r.path);
      if (!b.blob) return r;
      const at = this.one<{ line: number }>("SELECT line FROM doc_items WHERE repo = ? AND path = ? AND blob = ? AND tbl = 'nums' AND key = ?", r.repo, r.path, b.blob, r.key);
      if (!at) return r;
      const words = b.lines?.[at.line - 1];
      return { ...r, line: at.line, context: words !== undefined ? words.trim() : r.context };
    });
  }

  /** Which of these numbers the project defines anywhere the ledger reads (documents, file and branch names, commit subjects). */
  definedNumbers(nums: readonly string[]): Set<string> {
    const out = new Set<string>();
    const wanted = [...new Set(nums.map((n) => n.trim()).filter(Boolean))];
    for (let i = 0; i < wanted.length; i += 400) {
      const chunk = wanted.slice(i, i + 400);
      for (const r of this.all<{ num: string }>(`SELECT DISTINCT num FROM nums WHERE place = 'definition' AND num IN (${chunk.map(() => '?').join(',')})`, ...chunk)) out.add(r.num);
    }
    return out;
  }

  /** The current documents where a number is defined, with the line that defines it (a number the project defines in several places has several). */
  definitionsOf(num: string): { readonly repo: string | null; readonly path: string; readonly position: string; readonly line: number; readonly context: string }[] {
    return this.currentLines(this.all<{ key: string; repo: string | null; path: string | null; position: string | null; line: number | null; context: string }>(
      "SELECT key, repo, path, position, line, context FROM nums WHERE num = ? AND place = 'definition' AND kind IN ('doc', 'loose') AND current = 1", num.trim(),
    )).filter((x) => x.path).map((x) => ({ repo: x.repo, path: x.path!, position: x.position ?? '', line: x.line ?? 0, context: x.context }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  }

  /** The current documents that define a number, without their lines (cheap: no document text is read). */
  definitionPlaces(num: string): { readonly repo: string | null; readonly path: string }[] {
    return this.all<{ repo: string | null; path: string | null }>(
      "SELECT DISTINCT repo, path FROM nums WHERE num = ? AND place = 'definition' AND kind IN ('doc', 'loose') AND current = 1", num.trim(),
    ).filter((x) => x.path).map((x) => ({ repo: x.repo, path: x.path! }));
  }

  /** The repository-relative path a ledger entry is about (a document version, a line of one, an arrangement), or null. */
  pathOfEntry(id: string): { readonly repo: string | null; readonly path: string } | null {
    for (const table of ['docs', 'deleted_docs', 'verdicts', 'nums', 'supersedes', 'plans']) {
      const r = this.one<{ repo: string | null; path: string | null }>(`SELECT repo, path FROM ${table} WHERE key = ? LIMIT 1`, id);
      if (r?.path) return { repo: r.repo, path: r.path };
    }
    return null;
  }

  /** What the arrangement files at a path are, in any version: `prompt`, `receipt` … with the work id each is about. */
  arrangementKinds(path: string): { readonly kind: string; readonly ident: string | null }[] {
    return this.all<{ kind: string; ident: string | null }>('SELECT DISTINCT kind, ident FROM plans WHERE path = ?', nameForm(path).replace(/\\/g, '/'));
  }

  /** The numbering rules the project uses, each with the basis the program recognised it by (AC-5). */
  numRules() {
    // One grouped count, not a count per rule: coverage() runs this, and a view that ran coverage() per item made the
    // process view take minutes on a project with a few hundred reference items (resident D99 run, 2026-09-30).
    const counts = new Map(this.all<{ rule: string; c: number }>('SELECT rule, count(*) c FROM nums GROUP BY rule').map((x) => [x.rule, x.c]));
    return {
      rule: `A family counts when at least ${MIN_DEFINED} different numbers of it are defined (heading or bold line start, a table's first column, a front-matter id, a file or branch name prefix, a commit subject's start); two capital letters only in an index table's first column, a front-matter id, or names where ${MIN_DEFINED}+ stand together.`,
      rules: this.all<{ rule: string; shape: string; basis: string; examples: string; defined: number }>('SELECT * FROM num_rules ORDER BY defined DESC')
        .map((r) => ({ id: `rule:${r.rule}`, rule: r.rule, shape: r.shape, defined: r.defined, examples: r.examples, basis: r.basis,
          occurrences: counts.get(r.rule) ?? 0 })),
    };
  }

  /** Every place a number shows up: documents (with first and last version), commit messages, branch, worktree and file names. */
  nums(q: Paging & { num?: string; rule?: string; kind?: string; place?: string; path?: string; repo?: string; currentOnly?: boolean; since?: string; until?: string } = {}): Page<NumRow> | string {
    const rf = this.repoFilter(q.repo);
    if (typeof rf === 'string') return rf;
    const where = ['1 = 1'];
    const params: (string | number)[] = [];
    if (q.num) { where.push('num = ?'); params.push(q.num.trim()); }
    if (q.rule) { where.push('rule = ?'); params.push(q.rule); }
    if (q.kind) { where.push('kind = ?'); params.push(q.kind); }
    if (q.place) { where.push('place = ?'); params.push(q.place); }
    if (q.path) { const p = nameForm(q.path).replace(/\\/g, '/'); where.push("(path = ? OR path LIKE ? ESCAPE '\\')"); params.push(p, `${likeEscape(p.replace(/\/+$/, ''))}/%`); }
    if (q.currentOnly) where.push('current = 1');
    const since = boundMs(q.since, false);
    const until = boundMs(q.until, true);
    if (since !== null) { where.push('first_ms >= ?'); params.push(since); }
    if (until !== null) { where.push('first_ms <= ?'); params.push(until); }
    const w = `WHERE ${where.join(' AND ')}${rf.sql}`;
    const total = this.one<{ c: number }>(`SELECT count(*) c FROM nums ${w}`, ...params, ...rf.params)!.c;
    const rows = this.all<Record<string, unknown>>(`SELECT * FROM nums ${w} ORDER BY first_ms IS NULL, first_ms, kind, path, line LIMIT ? OFFSET ?`, ...params, ...rf.params, lim(q), off(q));
    return pageOf(total, rows.map((r) => ({
      ...this.lineBase(r), num: String(r.num), rule: String(r.rule), kind: String(r.kind), place: String(r.place), confidence: String(r.confidence),
      ...(r.kind === 'branch' || r.kind === 'worktree' ? { path: String(r.context) } : {}),
    })), off(q));
  }

  /** Verdicts, test counts and numbered findings stated in reports, each with its line (AC-6). */
  verdicts(q: Paging & { repo?: string; path?: string; verdict?: string; kind?: string; confidence?: string; keyword?: string; currentOnly?: boolean; since?: string; until?: string } = {}): Page<VerdictRow> | string {
    const rf = this.repoFilter(q.repo);
    if (typeof rf === 'string') return rf;
    const where = ['1 = 1'];
    const params: (string | number)[] = [];
    if (q.path) { const p = nameForm(q.path).replace(/\\/g, '/'); where.push("(path = ? OR path LIKE ? ESCAPE '\\')"); params.push(p, `%${likeEscape(p)}%`); }
    if (q.verdict) { where.push('verdict = ?'); params.push(q.verdict); }
    if (q.kind) { where.push('kind = ?'); params.push(q.kind); }
    if (q.confidence) { where.push('confidence = ?'); params.push(q.confidence); }
    if (q.keyword) { where.push("(text LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')"); const k = `%${likeEscape(q.keyword)}%`; params.push(k, k); }
    if (q.currentOnly) where.push('current = 1');
    this.timeFilter(where, params, 'first_ms', q);
    const w = `WHERE ${where.join(' AND ')}${rf.sql}`;
    const total = this.one<{ c: number }>(`SELECT count(*) c FROM verdicts ${w}`, ...params, ...rf.params)!.c;
    const rows = this.all<Record<string, unknown>>(`SELECT * FROM verdicts ${w} ORDER BY first_ms IS NULL, first_ms, path, first_line LIMIT ? OFFSET ?`, ...params, ...rf.params, lim(q), off(q));
    return pageOf(total, rows.map((r) => ({ ...this.lineBase(r), kind: String(r.kind), verdict: (r.verdict as string | null) ?? null, confidence: String(r.confidence) })), off(q));
  }

  // ───────────────────────── execution arrangements (AC-7) ─────────────────────────

  arrangements(q: Paging & { repo?: string; kind?: string; ident?: string; path?: string; currentOnly?: boolean; unparsedOnly?: boolean; status?: string; since?: string; until?: string } = {}): Page<ArrangementRow> | string {
    const rf = this.repoFilter(q.repo);
    if (typeof rf === 'string') return rf;
    const where = ['1 = 1'];
    const params: (string | number)[] = [];
    if (q.kind) { where.push('kind = ?'); params.push(q.kind); }
    if (q.ident) { where.push('ident = ?'); params.push(q.ident); }
    if (q.path) { const p = nameForm(q.path).replace(/\\/g, '/'); where.push("(path = ? OR path LIKE ? ESCAPE '\\')"); params.push(p, `%${likeEscape(p)}%`); }
    if (q.currentOnly) where.push('current = 1');
    if (q.unparsedOnly) where.push('parsed = 0');
    if (q.status) { where.push("json_extract(data, '$.status') LIKE ? ESCAPE '\\'"); params.push(`%${likeEscape(q.status)}%`); }
    this.timeFilter(where, params, 'occurred_ms', q);
    const w = `WHERE ${where.join(' AND ')}${rf.sql}`;
    const total = this.one<{ c: number }>(`SELECT count(*) c FROM plans ${w}`, ...params, ...rf.params)!.c;
    const rows = this.all<Record<string, unknown>>(`SELECT * FROM plans ${w} ORDER BY occurred_ms IS NULL, occurred_ms DESC, path LIMIT ? OFFSET ?`, ...params, ...rf.params, lim(q), off(q));
    return pageOf(total, rows.map((r) => ({
      id: String(r.key), repo: (r.repo as string | null) ?? null, path: String(r.path), commit: r.commit_hash ? String(r.commit_hash).slice(0, 12) : null,
      kind: String(r.kind), ident: (r.ident as string | null) ?? null, parsed: r.parsed === 1, current: r.current === 1,
      occurred: this.rowOccurred(r as never), data: json<unknown>(String(r.data), {}),
    })), off(q));
  }

  /** How the arrangement fields of one work id changed over the versions (status, agent, worktree, baseline). */
  arrangementHistory(ident: string, repo?: string) {
    const rf = this.repoFilter(repo);
    if (typeof rf === 'string') return rf;
    const rows = this.all<Record<string, unknown>>(`SELECT * FROM plans WHERE ident = ?${rf.sql} ORDER BY occurred_ms, path`, ident, ...rf.params);
    const indexRows = this.all<Record<string, unknown>>(`SELECT * FROM plans WHERE kind IN ('index', 'plan')${rf.sql} ORDER BY occurred_ms`, ...rf.params)
      .flatMap((p) => {
        const data = json<{ rows?: { id: string; cells: Record<string, string>; line: number }[] }>(String(p.data), {});
        return (data.rows ?? []).filter((x) => x.id === ident).map((x) => ({ id: String(p.key), path: String(p.path), occurred: this.rowOccurred(p as never), current: p.current === 1, line: x.line, row: x.cells }));
      });
    // One row per change of the fields, per file; a later version with the same fields (a merge carrying it) only makes
    // the row current.
    const lastOf = new Map<string, { sig: string; row: { id: string; path: string; kind: string; occurred: Occurred; current: boolean; status: string | null; agent: string | null; worktree: string | null; baseline: string | null; accepted: string | null; running: boolean } }>();
    const versions: { id: string; path: string; kind: string; occurred: Occurred; current: boolean; status: string | null; agent: string | null; worktree: string | null; baseline: string | null; accepted: string | null; running: boolean }[] = [];
    for (const r of rows) {
      const data = json<{ status?: string | null; agent?: string | null; worktree?: string | null; baseline?: string | null; accepted?: string | null; running?: boolean }>(String(r.data), {});
      const sig = JSON.stringify([data.status, data.agent, data.worktree, data.baseline, data.accepted]);
      const last = lastOf.get(String(r.path));
      if (last && last.sig === sig) { if (r.current === 1) last.row.current = true; continue; }
      const row = { id: String(r.key), path: String(r.path), kind: String(r.kind), occurred: this.rowOccurred(r as never), current: r.current === 1, status: data.status ?? null, agent: data.agent ?? null, worktree: data.worktree ?? null, baseline: data.baseline ?? null, accepted: data.accepted ?? null, running: data.running === true };
      versions.push(row);
      lastOf.set(String(r.path), { sig, row });
    }
    return { ident, versions, indexRows };
  }

  // ───────────────────────── words across all history (AC-13) ─────────────────────────

  private textMatch(word: string): { sql: string; param: string } {
    const w = word.trim();
    return [...w].length >= 3
      ? { sql: 't.id IN (SELECT rowid FROM texts_fts WHERE texts_fts MATCH ?)', param: `"${w.replace(/"/g, '""')}"` }
      : { sql: "t.content LIKE ? ESCAPE '\\'", param: `%${likeEscape(w)}%` };
  }

  /** Whether any text the ledger read (a document version, a commit message, a session) has this token, as written (CJ). */
  hasToken(token: string): boolean {
    const w = token.trim();
    if (!w) return false;
    const m = this.textMatch(w);
    const re = new RegExp(`(?<![A-Za-z0-9_-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`);
    return this.all<{ content: string }>(`SELECT t.content FROM texts t WHERE ${m.sql} LIMIT 200`, m.param).some((t) => re.test(t.content));
  }

  /**
   * Where a word appears across everything the ledger read: each document it is in (the first and last version that has it,
   * and whether the current version does), each commit message, the owner's words and the agent messages they answered.
   * Case follows the trigram index: case-insensitive for three characters or more; shorter words match exactly.
   */
  word(word: string, q: Paging & { kinds?: readonly string[]; repo?: string; since?: string; until?: string; oldestFirst?: boolean } = {}): Page<WordHit> | string {
    const w = word.trim();
    if (!w) return 'Give a word to look for.';
    const m = this.textMatch(w);
    const kinds = new Set(q.kinds && q.kinds.length ? q.kinds : ['doc', 'commit', 'owner', 'agent', 'loose']);
    const hits: WordHit[] = [];
    const texts = this.all<{ id: number; key: string; kind: string; repo: string | null; content: string }>(`SELECT t.id, t.key, t.kind, t.repo, t.content FROM texts t WHERE ${m.sql}`, m.param)
      .filter((t) => kinds.has(t.kind) && (!q.repo || t.repo === this.repoId(q.repo)) && (m.sql.includes('MATCH') ? t.content.toLowerCase().includes(w.toLowerCase()) : true));
    const blobs = texts.filter((t) => t.kind === 'doc');
    // Documents: per path, the first and last version whose content has the word.
    const byPath = new Map<string, { repo: string; path: string; first: Record<string, unknown>; last: Record<string, unknown>; snippet: string; current: boolean }>();
    for (const t of blobs) {
      const blob = t.key.slice(t.key.lastIndexOf(':') + 1);
      for (const d of this.all<Record<string, unknown>>(`SELECT d.*, (SELECT count(*) FROM code_files f WHERE f.repo = d.repo AND f.path = d.path AND f.blob = d.blob) cur FROM docs d WHERE d.repo = ? AND d.blob = ?`, t.repo!, blob)) {
        const k = `${String(d.repo)}\x1f${String(d.path)}`;
        const e = byPath.get(k);
        const snippet = snippetOf(t.content, w);
        if (!e) byPath.set(k, { repo: String(d.repo), path: String(d.path), first: d, last: d, snippet, current: Number(d.cur) > 0 });
        else {
          if (Number(d.at_ms) < Number(e.first.at_ms)) { e.first = d; e.snippet = snippet; }
          if (Number(d.at_ms) > Number(e.last.at_ms)) e.last = d;
          if (Number(d.cur) > 0) e.current = true;
        }
      }
    }
    for (const e of byPath.values()) {
      const occ = this.docOccurred({ repo: e.repo, path: e.path, commit_hash: String(e.first.commit_hash), at: String(e.first.at), import_root: Number(e.first.import_root), blob: String(e.first.blob) });
      hits.push({
        id: String(e.first.key), kind: 'doc', label: `${e.path} — first in ${String(e.first.commit_hash).slice(0, 10)}, last in ${String(e.last.commit_hash).slice(0, 10)}${e.current ? ', in the current version' : ', not in the current version'}`,
        occurred: occ, snippet: e.snippet, current: e.current, last: { id: String(e.last.key), at: String(e.last.at) },
      });
    }
    for (const t of texts) {
      if (t.kind === 'commit') {
        const hash = t.key.split(':').pop()!;
        const c = this.one<{ author_at: string; committer_at: string; subject: string }>('SELECT author_at, committer_at, subject FROM commits WHERE repo = ? AND hash = ?', t.repo!, hash);
        if (c) hits.push({ id: `commit:${hash.slice(0, 12)}`, kind: 'commit', label: `${hash.slice(0, 10)} ${clip(c.subject, 100)}`, occurred: this.commitOccurred(hash, c.author_at), snippet: snippetOf(t.content, w) });
      } else if (t.kind === 'owner' || t.kind === 'agent') {
        const msg = this.one<{ key: string; idx: number; at: string | null; session: string }>('SELECT key, idx, at, session FROM session_messages WHERE key = ?', t.key);
        const s = msg ? this.one<{ host: string; session_id: string; first_seen: string }>('SELECT host, session_id, first_seen FROM sessions WHERE key = ?', msg.session) : undefined;
        if (msg && s) hits.push({ id: msg.key, kind: t.kind, label: `${t.kind === 'owner' ? 'the owner' : 'agent message the owner answered'}, ${s.host} session ${s.session_id.slice(0, 8)} [${msg.idx}]`, occurred: msg.at ? { at: materialTime(msg.at) ?? msg.at, basis: 'Session', anchor: msg.key } : { at: s.first_seen, basis: 'First observed', anchor: msg.key, undated: true }, snippet: snippetOf(t.content, w) });
      } else if (t.kind === 'loose') {
        // Dated like every line of a document outside version control: the date its text writes for the line the word is
        // on, else the file's own time — not some other line's date, and never the epoch (QC AY, CKC-22 AC-10).
        const path = t.key.slice('loose:'.length);
        hits.push({ id: t.key, kind: 'loose', label: `${path} (outside version control)`, occurred: this.looseOccurred(path, t.content, lineOf(t.content, w)), snippet: snippetOf(t.content, w), current: true });
      }
    }
    const since = boundMs(q.since, false);
    const until = boundMs(q.until, true);
    const kept = hits.filter((h) => { const ms = msOf(h.occurred.at); return (since === null || (ms !== null && ms >= since)) && (until === null || (ms !== null && ms <= until)); })
      .sort((a, b) => ((msOf(a.occurred.at) ?? 0) - (msOf(b.occurred.at) ?? 0)) * (q.oldestFirst === false ? -1 : 1));
    const o = off(q);
    return pageOf(kept.length, kept.slice(o, o + lim(q)), o);
  }

  /** The first and the last appearance of a word across all history (documents by version, commit messages, sessions). */
  wordSpan(word: string, opts: { repo?: string } = {}) {
    const all = this.word(word, { limit: 100_000, repo: opts.repo });
    if (typeof all === 'string') return all;
    const rows = [...all.rows];
    if (rows.length === 0) return { word, total: 0, first: null, last: null };
    // The last appearance of a document is its last version having the word, not the first.
    const lastOf = (h: WordHit): { at: string; id: string } => (h.last ? { at: h.last.at, id: h.last.id } : { at: h.occurred.at, id: h.id });
    const last = rows.map((h) => ({ h, l: lastOf(h) })).sort((a, b) => (msOf(b.l.at) ?? 0) - (msOf(a.l.at) ?? 0))[0]!;
    return { word, total: rows.length, byKind: countBy(rows.map((r) => r.kind)), first: rows[0], last: { ...last.h, id: last.l.id, lastAt: last.l.at } };
  }

  // ───────────────────────── code (AC-8, CKC-03 AC-27) ─────────────────────────

  /** How far a file's references are read, in words: by whom, and to which level. */
  private levelOf(f: { path: string; reader?: string | null }): string {
    const reader = this.readerOf(f);
    return reader === 'compiler' ? 'symbol level (the TypeScript compiler): its imports and references, symbols with pk_ledger_symbol'
      : reader === 'engine' ? `symbol level (${ENGINE_LABEL}): the references it resolved (${COUNTED_RULE}), symbols with pk_ledger_symbol`
      : 'file tree only: no reader of its references';
  }

  /** Who references a file, and what it references (file level; symbols with pk_ledger_symbol). */
  fileRefs(pathInput: string, opts: { repo?: string } = {}) {
    const rf = this.repoFilter(opts.repo);
    if (typeof rf === 'string') return rf;
    const path = nameForm(pathInput).replace(/\\/g, '/').replace(/^\.\//, '');
    const f = this.one<{ repo: string; path: string; lines: number | null; lang: string | null; generated: number; classification: string | null; last_commit: string | null; last_at: string | null; reader?: string | null; named_by?: string | null }>(`SELECT * FROM code_files WHERE path = ?${rf.sql}`, path, ...rf.params);
    if (!f) return `${path} is not in the current version${opts.repo ? ` of ${opts.repo}` : ''}. (File-level references cover the checkout's current version; pk_ledger_ref_history follows a reference back through history.)`;
    const by = this.all<{ src: string; kind: string }>('SELECT src, kind FROM code_deps WHERE repo = ? AND dst = ? AND external = 0 ORDER BY src', f.repo, path);
    const to = this.all<{ dst: string; kind: string; external: number }>('SELECT dst, kind, external FROM code_deps WHERE repo = ? AND src = ? ORDER BY external, dst', f.repo, path);
    const naming = namingOf(f.named_by);
    const counts = namingThatCounts(naming);
    const mentionedBy = naming.filter((n) => n.kind === 'mention').map((n) => n.path);
    return {
      id: `file:${path}`, repo: f.repo, path, lang: f.lang, lines: f.lines, generated: f.generated === 1, classification: f.classification,
      level: this.levelOf(f),
      lastChange: f.last_commit ? { id: `commit:${f.last_commit.slice(0, 12)}`, at: f.last_at } : null,
      referencedBy: by.map((x) => ({ path: x.src, kind: x.kind })),
      references: to.filter((x) => x.external === 0).map((x) => ({ path: x.dst, kind: x.kind })),
      external: to.filter((x) => x.external === 1).map((x) => x.dst),
      ...(counts.length ? { namedBy: counts.map((n) => n.path), namedByNote: namedByNote(counts) } : {}),
      ...(mentionedBy.length ? { mentionedBy, mentionedByNote: 'Documents, data or other text that name this file: said there, not referenced.' } : {}),
    };
  }

  /**
   * Files no other file references (a fact; whether one is residue is a judgement): code files whose references a reader
   * reads. `namedBy`: files that name it though no counted reference reaches it — a build or manifest file (a named entry
   * point, `entryPoint` says where) or code (a reference no reader resolved): there the fact is uncertain. `mentionedBy`:
   * other text that names it, which references nothing.
   */
  unreferenced(q: Paging & { repo?: string; dir?: string; includeTests?: boolean } = {}) {
    const rf = this.repoFilter(q.repo, 'f.repo');
    if (typeof rf === 'string') return rf;
    const read = this.hasReader() ? 'f.reader IS NOT NULL' : "f.lang IN ('typescript', 'javascript')";
    const where = [`f.generated = 0 AND f.classification IS NULL AND ${read}`,
      'NOT EXISTS (SELECT 1 FROM code_deps d WHERE d.repo = f.repo AND d.dst = f.path AND d.external = 0)'];
    const params: (string | number)[] = [];
    if (!q.includeTests) where.push('f.test = 0');
    if (q.dir) { where.push("f.path LIKE ? ESCAPE '\\'"); params.push(`${likeEscape(nameForm(q.dir).replace(/\\/g, '/').replace(/\/+$/, ''))}/%`); }
    const w = `WHERE ${where.join(' AND ')}${rf.sql}`;
    const total = this.one<{ c: number }>(`SELECT count(*) c FROM code_files f ${w}`, ...params, ...rf.params)!.c;
    const rows = this.all<{ repo: string; path: string; lang: string; ref_lang?: string | null; lines: number | null; last_commit: string | null; last_at: string | null; named_by?: string | null }>(`SELECT f.* FROM code_files f ${w} ORDER BY f.path LIMIT ? OFFSET ?`, ...params, ...rf.params, lim(q, 1000), off(q));
    return {
      note: 'An entry point (main, a route file, a test, a script run by hand) is referenced by nothing and is not residue; the judgement is yours. A row with namedBy is named by other files though no counted reference reaches it — a build or manifest file, which makes it a named entry point (entryPoint says where), or code whose reader missed a reference there: read those files before calling it unreferenced. mentionedBy: documents, data or other text that name it, which reference nothing.',
      ...pageOf(total, rows.map((r) => {
        const naming = namingOf(r.named_by);
        const counts = namingThatCounts(naming);
        const entry = [...new Set(counts.filter((n) => n.kind === 'entry').map((n) => fileNameOf(n.path)))];
        const mentionedBy = naming.filter((n) => n.kind === 'mention').map((n) => n.path);
        return {
          id: `file:${r.path}`, repo: r.repo, path: r.path, lang: r.ref_lang ?? r.lang, lines: r.lines, lastChange: r.last_commit ? `commit:${r.last_commit.slice(0, 12)}` : null,
          ...(counts.length ? { namedBy: counts.map((n) => n.path) } : {}), ...(entry.length ? { entryPoint: `named in ${entry.join(', ')}` } : {}), ...(mentionedBy.length ? { mentionedBy } : {}),
        };
      }), off(q)),
    };
  }

  /**
   * Since when a file references another (file level, from history): each version of `src` on the given history, read the
   * way its language is read now — TypeScript and JavaScript by the compiler's pre-parser, every other language by the code
   * engine's extraction of that version's imports — and the commits where the reference appears and disappears. The target
   * is matched by its file name (the engine's import specifiers by the file's stem), so a moved target is still found.
   */
  refHistory(srcInput: string, dstInput: string, opts: { repo?: string } = {}) {
    const rf = this.repoFilter(opts.repo);
    if (typeof rf === 'string') return rf;
    const src = nameForm(srcInput).replace(/\\/g, '/');
    const dstName = nameForm(dstInput).replace(/\\/g, '/').split('/').pop() ?? dstInput;
    const repo = rf.params[0] ?? this.repoId(null);
    if (!repo) return 'No repository in this ledger.';
    const root = this.repoPath(repo)!;
    const versions = this.all<{ hash: string; new_blob: string | null; status: string; author_at: string; author_ms: number; on_trunk: number; subject: string }>(
      `SELECT cf.hash, cf.new_blob, cf.status, c.author_at, c.author_ms, c.on_trunk, c.subject FROM commit_files cf JOIN commits c ON c.repo = cf.repo AND c.hash = cf.hash
       WHERE cf.repo = ? AND cf.path = ? ORDER BY c.author_ms`, repo, src);
    if (versions.length === 0) return `No commit in the ledger touched ${src}.`;
    const byCompiler = compilerReads(src);
    if (!byCompiler && engineLanguage(src) === null) return `${src} is in a language whose references the ledger does not read (neither the TypeScript compiler nor ${ENGINE_LABEL}).`;
    const contents = catBlobs(root, versions.map((v) => v.new_blob).filter((b): b is string => Boolean(b)));
    const texts = versions.map((v) => { const buf = v.new_blob ? contents.get(v.new_blob) : null; return buf ? buf.toString('utf8') : null; });
    // What each version references: the compiler's resolved paths, or the import specifiers the engine extracts.
    let targets: (readonly string[])[];
    if (byCompiler) {
      const tracked = new Set(this.all<{ path: string }>('SELECT DISTINCT path FROM commit_files WHERE repo = ?', repo).map((r) => r.path));
      targets = texts.map((t) => (t === null ? [] : depsOf(langOf(src), src, t, tracked).map((d) => d.dst)));
    } else {
      const specs = engineImportsOf(src, texts, this.engineDir(repo));
      if (typeof specs === 'string') return specs;
      targets = specs.map((s) => s ?? []);
    }
    const matches = (t: string): boolean => (byCompiler ? t.split('/').pop() === dstName || t.endsWith(`/${dstName}`) : specifierNames(t, dstName));
    let had: boolean | null = null;
    const events: { id: string; subject: string; occurred: Occurred; onTrunk: boolean; references: boolean; target: string | null }[] = [];
    versions.forEach((v, i) => {
      const hit = (targets[i] ?? []).find(matches);
      const has = Boolean(hit) && v.status !== 'D';
      if (had === null || has !== had) events.push({ id: `commit:${v.hash.slice(0, 12)}`, subject: v.subject, occurred: this.commitOccurred(v.hash, v.author_at), onTrunk: v.on_trunk === 1, references: has, target: hit ?? null });
      had = has;
    });
    const firstOnTrunk = versions.find((v) => v.on_trunk === 1 && events.some((e) => e.id === `commit:${v.hash.slice(0, 12)}` && e.references));
    return {
      src, target: dstName, readBy: byCompiler ? 'the TypeScript compiler' : ENGINE_LABEL, versionsRead: versions.length, changes: events,
      firstOnTrunk: firstOnTrunk ? `commit:${firstOnTrunk.hash.slice(0, 12)}` : null,
      referencesNow: this.one<{ c: number }>("SELECT count(*) c FROM code_deps WHERE repo = ? AND src = ? AND external = 0 AND (dst = ? OR dst LIKE ?)", repo, src, dstInput, `%/${dstName}`)!.c > 0,
    };
  }

  /** Directory sizes (product / generated / other), tests and the last change, for the current version. */
  dirs(q: Paging & { repo?: string; under?: string; depth?: number } = {}) {
    const rf = this.repoFilter(q.repo);
    if (typeof rf === 'string') return rf;
    const where = ['1 = 1'];
    const params: (string | number)[] = [];
    if (q.under) { where.push("dir LIKE ? ESCAPE '\\'"); params.push(`${likeEscape(nameForm(q.under).replace(/\\/g, '/').replace(/\/+$/, ''))}/%`); }
    if (q.depth) { where.push("(length(dir) - length(replace(dir, '/', ''))) < ?"); params.push(Math.max(1, Math.floor(q.depth))); }
    const w = `WHERE ${where.join(' AND ')}${rf.sql}`;
    const total = this.one<{ c: number }>(`SELECT count(*) c FROM dir_stats ${w}`, ...params, ...rf.params)!.c;
    const rows = this.all<Record<string, number | string | null>>(`SELECT * FROM dir_stats ${w} ORDER BY dir LIMIT ? OFFSET ?`, ...params, ...rf.params, lim(q, 2000), off(q));
    return pageOf(total, rows.map((r) => ({
      dir: String(r.dir), files: r.files, lines: r.lines, product: { files: r.product_files, lines: r.product_lines }, generated: { files: r.generated_files, lines: r.generated_lines },
      other: { files: r.other_files, lines: r.other_lines }, testFiles: r.tests, testCases: r.test_cases, lastChange: r.last_commit ? { id: `commit:${String(r.last_commit).slice(0, 12)}`, at: r.last_at } : null,
    })), off(q));
  }

  /** Which directories each merge changed (against its first parent), newest first. */
  merges(q: Paging & { repo?: string; dir?: string; trunkOnly?: boolean } = {}) {
    const rf = this.repoFilter(q.repo, 'm.repo');
    if (typeof rf === 'string') return rf;
    const where = ['1 = 1'];
    const params: (string | number)[] = [];
    if (q.trunkOnly) where.push('m.on_trunk = 1');
    if (q.dir) { where.push("m.dirs LIKE ? ESCAPE '\\'"); params.push(`%"${likeEscape(nameForm(q.dir).replace(/\\/g, '/').replace(/\/+$/, ''))}%`); }
    const w = `WHERE ${where.join(' AND ')}${rf.sql}`;
    const total = this.one<{ c: number }>(`SELECT count(*) c FROM merge_dirs m ${w}`, ...params, ...rf.params)!.c;
    const rows = this.all<{ repo: string; commit_hash: string; at: string; on_trunk: number; dirs: string }>(`SELECT m.* FROM merge_dirs m ${w} ORDER BY m.at DESC LIMIT ? OFFSET ?`, ...params, ...rf.params, lim(q), off(q));
    return pageOf(total, rows.map((m) => {
      const c = this.one<{ subject: string; author_at: string }>('SELECT subject, author_at FROM commits WHERE repo = ? AND hash = ?', m.repo, m.commit_hash);
      return { id: `commit:${m.commit_hash.slice(0, 12)}`, subject: c?.subject ?? '', occurred: this.commitOccurred(m.commit_hash, c?.author_at ?? m.at), onTrunk: m.on_trunk === 1, dirs: json<[string, number][]>(m.dirs, []).map(([dir, files]) => ({ dir, files })) };
    }), off(q));
  }

  /**
   * Symbol questions on the current version — references, implementations, callers, callees — in every language whose
   * references are read: TypeScript and JavaScript by the TypeScript language service on the checkout (compiler-exact),
   * every other language by the code engine on its snapshot. Every hit says how it was resolved and how sure that is.
   */
  symbol(kind: SymbolQueryKind, input: { file: string; line?: number; character?: number; name?: string }, opts: { repo?: string } = {}): SymbolAnswer | string {
    const rf = this.repoFilter(opts.repo);
    if (typeof rf === 'string') return rf;
    const file = nameForm(input.file).replace(/\\/g, '/').replace(/^\.?\//, '');
    const row = this.one<{ repo: string; path: string; reader?: string | null }>(`SELECT * FROM code_files WHERE path = ?${rf.sql} LIMIT 1`, file, ...rf.params);
    const repo = row?.repo ?? rf.params[0] ?? this.repoId(null);
    if (!repo) return 'No repository in this ledger.';
    const reader = row ? this.readerOf(row) : compilerReads(file) ? 'compiler' : null;
    if (reader === 'engine') return engineSymbol(this.engineDir(repo), kind, { ...input, file });
    if (reader !== 'compiler') {
      return row
        ? `${file} is in a language whose references the ledger does not read (neither the TypeScript compiler nor ${ENGINE_LABEL}): ${this.levelOf(row)}.`
        : `${file} is not in the current version the ledger read.`;
    }
    const root = this.repoPath(repo);
    if (!root) return `Repository ${repo} has no checkout in the ledger.`;
    const files = this.all<{ path: string }>("SELECT path FROM code_files WHERE repo = ? AND lang IN ('typescript', 'javascript') AND generated = 0", repo).map((r) => r.path);
    const r = symbolQuery(root, files, kind, { ...input, file });
    if (typeof r === 'string') return r;
    // The language service resolves every hit itself: exact, and counted.
    const exact = { how: 'compiler', confidence: 1, counted: true } as const;
    return {
      answeredBy: 'the TypeScript language service', ...r,
      ...(r.locations ? { locations: r.locations.map((l) => ({ ...l, ...exact })) } : {}),
      ...(r.incoming ? { incoming: r.incoming.map((l) => ({ ...l, ...exact })) } : {}),
      ...(r.outgoing ? { outgoing: r.outgoing.map((l) => ({ ...l, ...exact })) } : {}),
    };
  }

  // ───────────────────────── sessions and the owner's words (AC-9) ─────────────────────────

  sessions(q: Paging & { host?: string; withOwnerWords?: boolean; missingOnly?: boolean; since?: string; until?: string } = {}): Page<SessionRow> {
    const where = ['1 = 1'];
    const params: (string | number)[] = [];
    if (q.host) { where.push('host = ?'); params.push(q.host); }
    if (q.withOwnerWords) where.push('owner_messages > 0');
    if (q.missingOnly) where.push('(missing = 1 OR unreadable IS NOT NULL)');
    if (q.since) { where.push('ended_at >= ?'); params.push(new Date(boundMs(q.since, false) ?? 0).toISOString()); }
    if (q.until) { where.push('started_at <= ?'); params.push(new Date(boundMs(q.until, true) ?? 0).toISOString()); }
    const w = `WHERE ${where.join(' AND ')}`;
    const total = this.one<{ c: number }>(`SELECT count(*) c FROM sessions ${w}`, ...params)!.c;
    const rows = this.all<Record<string, unknown>>(`SELECT * FROM sessions ${w} ORDER BY started_at IS NULL, started_at LIMIT ? OFFSET ?`, ...params, lim(q), off(q));
    return pageOf(total, rows.map((r) => ({
      id: String(r.key), host: String(r.host), sessionId: String(r.session_id), file: String(r.file), cwd: (r.cwd as string | null) ?? null,
      startedAt: (r.started_at as string | null) ?? null, endedAt: (r.ended_at as string | null) ?? null, messages: Number(r.messages), ownerMessages: Number(r.owner_messages),
      headless: r.headless === 1, subagent: r.subagent === 1, missing: r.missing === 1, unreadable: (r.unreadable as string | null) ?? null,
    })), off(q));
  }

  /** A session by its entry id, its native id (or a prefix of it), or its log file. */
  findSession(input: string, host?: string): Record<string, unknown> | string {
    const v = input.trim();
    const rows = this.all<Record<string, unknown>>(`SELECT * FROM sessions WHERE (key = ? OR session_id = ? OR session_id LIKE ? OR lower(file) = lower(?))${host ? ' AND host = ?' : ''} LIMIT 3`, v, v, `${likeEscape(v)}%`, v, ...(host ? [host] : []));
    if (rows.length === 0) return `No session ${input} in the ledger.`;
    if (rows.length > 1 && !rows.some((r) => r.key === v || r.session_id === v)) return `${input} names more than one session: ${rows.map((r) => `${String(r.host)} ${String(r.session_id)}`).join(', ')}.`;
    return rows.find((r) => r.key === v || r.session_id === v) ?? rows[0]!;
  }

  private messageRow(m: Record<string, unknown>, s: Record<string, unknown>, withAnswer: boolean): MessageRow {
    const occ = (at: unknown, key: string): Occurred => (typeof at === 'string' && at ? { at: materialTime(at) ?? at, basis: 'Session', anchor: key } : { at: String(s.first_seen), basis: 'First observed', anchor: key, undated: true });
    let answers: MessageRow['answers'] = undefined;
    if (withAnswer && m.speaker === 'owner') {
      const a = m.answers === null || m.answers === undefined ? undefined : this.one<Record<string, unknown>>('SELECT * FROM session_messages WHERE session = ? AND idx = ?', String(m.session), Number(m.answers));
      answers = a ? { id: String(a.key), index: Number(a.idx), occurred: occ(a.at, String(a.key)), text: (a.text as string | null) ?? null } : null;
    }
    return {
      id: String(m.key), session: String(s.key), index: Number(m.idx), speaker: String(m.speaker), occurred: occ(m.at, String(m.key)), text: (m.text as string | null) ?? null, chars: Number(m.chars),
      ...(m.tools ? { tools: json<string[]>(String(m.tools), []) } : {}), ...(answers !== undefined ? { answers } : {}),
    };
  }

  /**
   * The messages of one session in order, every speaker; the text is kept for the owner's messages and the agent messages
   * they answer (the rest are recorded with speaker, time, length and tool calls).
   */
  sessionMessages(sessionInput: string, q: Paging & { host?: string; speaker?: string; fromIndex?: number } = {}) {
    const s = this.findSession(sessionInput, q.host);
    if (typeof s === 'string') return s;
    const where = ['session = ?'];
    const params: (string | number)[] = [String(s.key)];
    if (q.speaker) { where.push('speaker = ?'); params.push(q.speaker); }
    if (q.fromIndex !== undefined) { where.push('idx >= ?'); params.push(Math.floor(q.fromIndex)); }
    const w = `WHERE ${where.join(' AND ')}`;
    const total = this.one<{ c: number }>(`SELECT count(*) c FROM session_messages ${w}`, ...params)!.c;
    const rows = this.all<Record<string, unknown>>(`SELECT * FROM session_messages ${w} ORDER BY idx LIMIT ? OFFSET ?`, ...params, lim(q, 1000), off(q));
    return {
      session: { id: String(s.key), host: String(s.host), sessionId: String(s.session_id), file: String(s.file), startedAt: s.started_at, endedAt: s.ended_at, missing: s.missing === 1 },
      ...pageOf(total, rows.map((m) => this.messageRow(m, s, true)), off(q)),
    };
  }

  /** One message by its entry id, with the agent message it answers when it is the owner's. */
  message(id: string): MessageRow | null {
    const m = this.one<Record<string, unknown>>('SELECT * FROM session_messages WHERE key = ?', id.trim());
    if (!m) return null;
    const s = this.one<Record<string, unknown>>('SELECT * FROM sessions WHERE key = ?', String(m.session))!;
    return this.messageRow(m, s, true);
  }

  /** The owner's own words across the sessions, oldest first, each with the agent message it answered. */
  ownerWords(q: Paging & { since?: string; until?: string; keyword?: string; session?: string; host?: string; includeHeadless?: boolean } = {}) {
    const where = ["m.speaker = 'owner'"];
    const params: (string | number)[] = [];
    const since = boundMs(q.since, false);
    const until = boundMs(q.until, true);
    if (since !== null) { where.push('m.at >= ?'); params.push(new Date(since).toISOString()); }
    if (until !== null) { where.push('m.at <= ?'); params.push(new Date(until).toISOString()); }
    if (q.keyword) { where.push("m.text LIKE ? ESCAPE '\\'"); params.push(`%${likeEscape(q.keyword)}%`); }
    if (q.host) { where.push('s.host = ?'); params.push(q.host); }
    if (!q.includeHeadless) where.push('s.headless = 0');
    if (q.session) {
      const s = this.findSession(q.session);
      if (typeof s === 'string') return s;
      where.push('s.key = ?');
      params.push(String(s.key));
    }
    const from = `FROM session_messages m JOIN sessions s ON s.key = m.session WHERE ${where.join(' AND ')}`;
    const total = this.one<{ c: number; ch: number }>(`SELECT count(*) c, ifnull(sum(m.chars), 0) ch ${from}`, ...params)!;
    const rows = this.all<Record<string, unknown>>(`SELECT m.*, s.key skey ${from} ORDER BY m.at IS NULL, m.at, m.idx LIMIT ? OFFSET ?`, ...params, lim(q), off(q));
    const page = pageOf(total.c, rows.map((m) => {
      const s = this.one<Record<string, unknown>>('SELECT * FROM sessions WHERE key = ?', String(m.skey))!;
      return { ...this.messageRow(m, s, true), host: String(s.host), sessionId: String(s.session_id) };
    }), off(q));
    return { ...page, totalChars: total.ch };
  }

  // ───────────────────────── provenance: How it got here (AC-12) ─────────────────────────

  /**
   * The dated steps of how something got here, from the ledger alone, oldest first: where it first appeared, each version
   * that changed it (with the sections changed), lines that say it was superseded or list it as obsolete, the plans and
   * arrangements that name it, commits and merges, verdicts, the owner's words that name it, and where it stands now.
   * Steps whose material exists only in history are marked (D82). The Keeper's model steps judge what the steps mean.
   */
  provenance(input: ProvenanceInput, opts: { limitPerAnchor?: number } = {}): { steps: ProvenanceStep[]; notes: string[] } {
    const cap = Math.max(10, opts.limitPerAnchor ?? 60);
    const steps: ProvenanceStep[] = [];
    const notes: string[] = [];
    const seen = new Set<string>();
    const push = (s: ProvenanceStep) => { const k = `${s.kind}|${s.entry}`; if (!seen.has(k)) { seen.add(k); steps.push(s); } };
    const repoSql = input.repo ? this.repoFilter(input.repo) : { sql: '', params: [] as string[] };
    if (typeof repoSql === 'string') return { steps: [], notes: [repoSql] };

    for (const raw of input.paths ?? []) {
      const path = nameForm(raw).replace(/\\/g, '/').replace(/^\.\//, '');
      const v = this.docVersions(path, { repo: input.repo });
      if (typeof v !== 'string') {
        v.versions.forEach((ver, i) => {
          const next = v.versions[i + 1];
          const diff = ver.diff ? [ver.diff.added.length ? `added ${ver.diff.added.slice(0, 4).join('; ')}${ver.diff.added.length > 4 ? ' …' : ''}` : '', ver.diff.changed.length ? `changed ${ver.diff.changed.slice(0, 4).join('; ')}${ver.diff.changed.length > 4 ? ' …' : ''}` : '', ver.diff.removed.length ? `removed ${ver.diff.removed.slice(0, 4).join('; ')}${ver.diff.removed.length > 4 ? ' …' : ''}` : ''].filter(Boolean).join(' · ') : '';
          push({
            kind: i === 0 ? 'first appeared' : 'changed', occurred: ver.occurred,
            title: `${ver.path} ${i === 0 ? (ver.importRoot ? 'entered version control with the import commit' : 'first version') : ver.change.toLowerCase()} at ${ver.commit.slice(0, 10)}${ver.onTrunk ? '' : ' (side branch)'}${diff ? ` — ${diff}` : ''}`,
            entry: ver.id, history: !ver.current, replacedBy: next?.id ?? null,
          });
        });
        for (const d of v.deletions) push({ kind: 'deleted', occurred: d.occurred, title: `${d.path} deleted in ${d.commit}${d.cleanup ? ' (a cleanup commit)' : ''}; readable in full at ${d.readableAt}`, entry: d.id, history: true });
      } else notes.push(v);
      for (const s of this.all<Record<string, unknown>>(`SELECT * FROM supersedes WHERE (path = ? OR replaced LIKE ? ESCAPE '\\' OR replacement LIKE ? ESCAPE '\\')${repoSql.sql} ORDER BY first_ms LIMIT ?`, path, `%${likeEscape(path.split('/').pop() ?? path)}%`, `%${likeEscape(path.split('/').pop() ?? path)}%`, ...repoSql.params, cap)) {
        const row = this.lineBase(s);
        push({ kind: s.obsolete_list === 1 ? 'obsolete-list row' : 'says superseded', occurred: row.occurred, title: `${String(s.path ?? `commit ${String(s.first_commit).slice(0, 10)}`)}${row.line ? `:${row.line}` : ''} reads (${String(s.pattern)}): ${clip(row.text, 160)}`, entry: row.id, history: !row.current });
      }
      for (const c of this.all<Record<string, unknown>>(`SELECT DISTINCT c.* FROM commits c JOIN commit_files cf ON cf.repo = c.repo AND cf.hash = c.hash WHERE (cf.path = ? OR cf.old_path = ?)${repoSql.sql.replace('repo', 'c.repo')} ORDER BY c.author_ms LIMIT ?`, path, path, ...repoSql.params, cap)) {
        const row = this.commitRow(c);
        push({ kind: row.merge ? 'merged' : 'commit', occurred: row.occurred, title: `${row.hash.slice(0, 10)} ${clip(row.subject, 120)}`, entry: row.id, history: !row.onTrunk });
      }
      const now = this.one<Record<string, unknown> & { repo: string; last_commit: string | null }>('SELECT * FROM code_files WHERE path = ?', path);
      // Where it stands now is dated like the file (`codeFileOccurred`); a path the current version lacks, by what took it
      // out (its deletion, else its last version) — never by the moment of the query.
      const lastStep = typeof v === 'string' ? null : v.deletions[v.deletions.length - 1] ?? v.versions[v.versions.length - 1] ?? null;
      push({ kind: 'now', occurred: now ? this.codeFileOccurred(now, `file:${path}`) : lastStep?.occurred ?? undated(this.lastRead(), null),
        title: now ? (now.last_commit ? `${path} is in the current version (last changed in ${short(now.last_commit)})` : `${path} is in the current version, outside version control`) : `${path} is not in the current version`, entry: now ? `file:${path}` : lastStep?.id ?? '', history: !now });
    }

    for (const num of input.nums ?? []) {
      const all = this.nums({ num, limit: 5000 });
      if (typeof all === 'string') { notes.push(all); continue; }
      if (all.total === 0) { notes.push(`${num}: no occurrence in the ledger.`); continue; }
      // The first place per document, commit or name; definitions always.
      const firstPer = new Map<string, NumRow>();
      for (const r of all.rows) { const k = `${r.kind}|${r.path ?? r.firstIn ?? r.text}`; if (!firstPer.has(k) || r.place === 'definition') firstPer.set(k, r); }
      // Oldest first; at the same moment a definition (the number introduced) before a mention of it.
      const rows = [...firstPer.values()].sort((a, b) => (msOf(a.occurred.at) ?? 0) - (msOf(b.occurred.at) ?? 0) || Number(b.place === 'definition') - Number(a.place === 'definition'));
      rows.slice(0, cap).forEach((r, i) => {
        const where = r.kind === 'commit' ? `commit ${r.firstIn?.slice(7, 17)}` : r.kind === 'doc' || r.kind === 'loose' ? `${r.path}${r.line ? `:${r.line}` : ''}` : `${r.kind} ${r.path ?? r.text}`;
        const planDoc = r.kind === 'doc' && r.path !== null && /(^|\/)(plan|PLAN|INDEX|execution-plan)[^/]*\.md$/.test(r.path);
        push({
          kind: i === 0 ? 'first appeared' : r.kind === 'commit' ? 'commit' : planDoc ? 'named in plan' : 'mentioned', occurred: r.occurred,
          title: `${num} ${r.place === 'definition' ? 'defined' : 'named'} in ${where}: ${clip(r.text, 140)}`, entry: r.id, history: r.kind === 'doc' ? !r.current : r.kind === 'branch' ? false : false,
        });
      });
      if (rows.length > cap) notes.push(`${num}: ${rows.length - cap} more places (pk_ledger_numbers lists them all).`);
      const arr = this.arrangementHistory(num, input.repo);
      if (typeof arr !== 'string') {
        for (const a of arr.versions) push({ kind: 'arrangement', occurred: a.occurred, title: `${a.path}: ${[a.status && `status ${a.status}`, a.agent && `agent ${a.agent}`, a.worktree && `worktree ${a.worktree}`, a.baseline && `baseline ${a.baseline}`, a.accepted && `accepted ${a.accepted}`].filter(Boolean).join(', ') || a.kind}`, entry: a.id, history: !a.current });
      }
      // Verdicts of a report about this number (its name starts with it) or whose line names it; the owner's words that name it.
      const named = (text: unknown) => new RegExp(`(?<![A-Za-z0-9_])${num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`).test(String(text ?? ''));
      for (const v of this.all<Record<string, unknown>>(`SELECT * FROM verdicts WHERE (instr(text, ?) > 0 OR instr(path, ?) > 0) AND kind IN ('verdict', 'count')${repoSql.sql} ORDER BY first_ms`, num, `/${num}-`, ...repoSql.params)
        .filter((v) => String(v.path).includes(`/${num}-`) || named(v.text)).slice(0, cap)) {
        const row = this.lineBase(v);
        push({ kind: 'verdict', occurred: row.occurred, title: `${String(v.path)}:${row.line}: ${String(v.kind)} ${String(v.verdict ?? '')} (${String(v.confidence)}) — ${clip(row.text, 120)}`, entry: row.id, history: !row.current });
      }
      for (const m of this.all<Record<string, unknown>>(`SELECT m.key, m.at, m.text, s.host, s.session_id, s.first_seen FROM session_messages m JOIN sessions s ON s.key = m.session WHERE m.speaker = 'owner' AND instr(m.text, ?) > 0 ORDER BY m.at`, num)
        .filter((m) => named(m.text)).slice(0, 20)) {
        push({ kind: 'owner said', occurred: m.at ? { at: materialTime(String(m.at)) ?? String(m.at), basis: 'Session', anchor: String(m.key) } : { at: String(m.first_seen), basis: 'First observed', anchor: String(m.key), undated: true }, title: `the owner (${String(m.host)} session ${String(m.session_id).slice(0, 8)}): ${clip(String(m.text), 140)}`, entry: String(m.key), history: false });
      }
    }

    for (const h of input.commits ?? []) {
      const c = this.commit(h, { repo: input.repo, limit: 1 });
      if (typeof c === 'string') { notes.push(c); continue; }
      push({ kind: c.merge ? 'merged' : 'commit', occurred: c.occurred, title: `${c.hash.slice(0, 10)} ${clip(c.subject, 120)}`, entry: c.id, history: !c.onTrunk });
      if (c.mergedIntoTrunkBy) {
        const m = this.findCommit(c.mergedIntoTrunkBy.id);
        if (typeof m !== 'string') push({ kind: 'merged', occurred: this.commitOccurred(String(m.hash), String(m.author_at)), title: `merged into the trunk by ${String(m.hash).slice(0, 10)} ${clip(String(m.subject), 100)}`, entry: c.mergedIntoTrunkBy.id, history: false });
      }
    }

    for (const w of input.words ?? []) {
      const span = this.wordSpan(w, { repo: input.repo });
      if (typeof span === 'string') { notes.push(span); continue; }
      if (!span.first) { notes.push(`“${w}”: not found in what the ledger read.`); continue; }
      push({ kind: 'first appeared', occurred: span.first.occurred, title: `“${w}” first appears: ${span.first.label} — ${span.first.snippet}`, entry: span.first.id, history: span.first.kind === 'doc' ? span.first.current !== true : false });
      if (span.last && span.last.id !== span.first.id) {
        const at = span.last.lastAt;
        push({ kind: 'mentioned', occurred: { at: materialTime(at) ?? at, basis: span.last.kind === 'owner' || span.last.kind === 'agent' ? 'Session' : 'Commit', anchor: span.last.id }, title: `“${w}” last appears: ${span.last.label} — ${span.last.snippet}`, entry: span.last.id, history: false });
      }
    }

    for (const id of input.entries ?? []) {
      const e = this.resolve(id);
      if (!e) { notes.push(`${id} is not an entry of the ledger.`); continue; }
      push({ kind: e.kind === 'commit' ? 'commit' : e.kind === 'verdict' ? 'verdict' : e.kind === 'sup' ? 'says superseded' : 'mentioned', occurred: e.occurred, title: e.label, entry: e.id, history: false });
    }

    steps.sort((a, b) => (msOf(a.occurred.at) ?? 0) - (msOf(b.occurred.at) ?? 0) || Number(a.kind === 'now') - Number(b.kind === 'now'));
    return { steps, notes };
  }

  // ───────────────────────── coverage (§1.16 看得见, §6.7) ─────────────────────────

  /**
   * The day a repository's document version history starts when content before it is not versioned (AC-15): the day of
   * its first import root, as `coverage()` gives it, or null when it has none. For a view that needs only this, per item.
   */
  historyStart(repo: string): string | null {
    const first = this.one<{ author_at: string }>('SELECT author_at FROM commits WHERE repo = ? AND import_root = 1 ORDER BY rowid LIMIT 1', repo);
    return first ? dayOf(first.author_at) : null;
  }

  coverage() {
    const last = this.one<{ started_at: string; ended_at: string; ms: number; kind: string; commits_added: number; stats: string }>('SELECT * FROM rebuilds ORDER BY id DESC LIMIT 1');
    const repos = this.repos().map((r) => {
      const c = this.one<{ c: number; t: number; m: number; a: string | null; b: string | null }>('SELECT count(*) c, ifnull(sum(on_trunk), 0) t, ifnull(sum(merge), 0) m, min(author_ms) a, max(author_ms) b FROM commits WHERE repo = ?', r.id)!;
      const first = this.one<{ author_at: string }>('SELECT author_at FROM commits WHERE repo = ? ORDER BY author_ms LIMIT 1', r.id);
      const lastC = this.one<{ author_at: string }>('SELECT author_at FROM commits WHERE repo = ? ORDER BY author_ms DESC LIMIT 1', r.id);
      const imports = this.all<{ hash: string; author_at: string }>('SELECT hash, author_at FROM commits WHERE repo = ? AND import_root = 1', r.id);
      const branches = this.one<{ c: number }>('SELECT count(*) c FROM branches WHERE repo = ?', r.id)!.c;
      const docs = this.one<{ v: number; p: number; x: number }>('SELECT count(*) v, count(DISTINCT path) p, ifnull(sum(import_root), 0) x FROM docs WHERE repo = ?', r.id)!;
      const byBasis = this.all<{ b: string; c: number }>("SELECT occurred_basis b, count(*) c FROM nums WHERE repo = ? AND kind = 'doc' GROUP BY b", r.id);
      // Versions the ledger keeps without their text — over the size it reads to, or not text: what is in them (superseded
      // lines, numbers, verdicts) is not in the ledger, and that is said here rather than left out (QC AY).
      const noText = this.all<{ path: string; bytes: number }>(`SELECT d.path, d.bytes FROM docs d WHERE d.repo = ?
        AND NOT EXISTS (SELECT 1 FROM texts t WHERE t.key = 'blob:' || d.repo || ':' || d.blob) ORDER BY d.at_ms`, r.id);
      const noTextPaths = [...new Set(noText.map((d) => d.path))];
      return {
        repo: r.id, path: r.path, trunk: r.trunk, head: short(r.head), commits: c.c, trunkCommits: c.t, merges: c.m, branches,
        from: first?.author_at ?? null, to: lastC?.author_at ?? null,
        historyFrom: imports.length ? dayOf(imports[0]!.author_at) : dayOf(first?.author_at ?? null),
        importRoots: imports.map((i) => ({ id: `commit:${i.hash.slice(0, 12)}`, at: i.author_at, documents: docs.x })),
        documents: { paths: docs.p, versions: docs.v },
        documentsWithoutText: noText.length ? {
          versions: noText.length, overSizeLimit: noText.filter((d) => d.bytes > MAX_DOC_BYTES).length, sizeLimitBytes: MAX_DOC_BYTES,
          paths: noTextPaths.slice(0, 20), morePaths: Math.max(0, noTextPaths.length - 20),
          reports: noTextPaths.filter((p) => isReportLike(p, '')),
          effect: 'kept as versions without their text: the superseded lines, numbers and verdicts in them are not in the ledger; read one with read at its path, or pk_ledger_doc_text says it cannot show it',
        } : null,
        numberLinesDatedBy: Object.fromEntries(byBasis.map((x) => [x.b, x.c])),
        supersessions: this.one<{ c: number }>('SELECT count(*) c FROM supersedes WHERE repo = ?', r.id)!.c,
        numberOccurrences: this.one<{ c: number }>('SELECT count(*) c FROM nums WHERE repo = ?', r.id)!.c,
        verdicts: this.one<{ c: number }>('SELECT count(*) c FROM verdicts WHERE repo = ?', r.id)!.c,
        arrangements: ((a) => ({ versions: a.c, unreadableStructure: a.u }))(this.one<{ c: number; u: number }>('SELECT count(*) c, ifnull(sum(parsed = 0), 0) u FROM plans WHERE repo = ?', r.id)!),
      };
    });
    const code = this.codeCoverage();
    const sessions =this.one<{ c: number; m: number; o: number; x: number; u: number; a: string | null; b: string | null }>('SELECT count(*) c, ifnull(sum(messages), 0) m, ifnull(sum(owner_messages), 0) o, ifnull(sum(missing), 0) x, ifnull(sum(unreadable IS NOT NULL), 0) u, min(started_at) a, max(ended_at) b FROM sessions')!;
    const scanned = this.one<{ value: string }>("SELECT value FROM state WHERE key = 'sessionsScanned'")?.value ?? null;
    const loose = json<{ items: string[]; documents: number; untracked: number; tooLarge?: string[] }>(this.one<{ value: string }>("SELECT value FROM state WHERE key = 'looseDocuments'")?.value, { items: [], documents: 0, untracked: 0 });
    return {
      lastRebuild: last ? { at: last.ended_at, ms: last.ms, kind: last.kind, commitsAdded: last.commits_added } : null,
      repos,
      languages: code.languages,
      codeEngine: code.engine,
      generatedAndThirdParty:this.all<{ what: string; c: number; l: number }>(`SELECT CASE WHEN classification IS NOT NULL THEN 'classified: ' || classification ELSE 'generated' END what, count(*) c, ifnull(sum(lines), 0) l
        FROM code_files WHERE generated = 1 OR classification IS NOT NULL GROUP BY what ORDER BY c DESC`).map((x) => ({ what: x.what, files: x.c, lines: x.l })),
      sessions: {
        scanned: scanned !== null, lastScan: scanned, sessions: sessions.c, messages: sessions.m, ownerMessages: sessions.o, from: sessions.a, to: sessions.b,
        hosts: this.all<{ host: string; c: number }>('SELECT host, count(*) c FROM sessions GROUP BY host').map((h) => ({ host: h.host, sessions: h.c })),
        missing: this.all<{ key: string; host: string; session_id: string; started_at: string | null; ended_at: string | null; missing: number; unreadable: string | null }>('SELECT * FROM sessions WHERE missing = 1 OR unreadable IS NOT NULL ORDER BY started_at')
          .map((s) => ({ id: s.key, host: s.host, sessionId: s.session_id, from: s.started_at, to: s.ended_at, why: s.unreadable ? `cannot be read: ${s.unreadable}` : 'the log file is gone; what was read from it stays in the ledger' })),
        daysWithCommitsButNoSession: scanned !== null ? this.daysWithoutSessions() : null,
      },
      outsideVersionControl: {
        directories: loose.items, documents: loose.documents, untrackedInRepositories: loose.untracked,
        // Files too large to read (MAX_LOOSE_BYTES): listed, so nothing is left out without a word (QC AY).
        notRead: (loose.tooLarge ?? []).length ? { files: (loose.tooLarge ?? []).length, sizeLimitBytes: MAX_LOOSE_BYTES, paths: (loose.tooLarge ?? []).slice(0, 20), more: Math.max(0, (loose.tooLarge ?? []).length - 20) } : null,
      },
      rules: {
        importRoot: IMPORT_RULE, cleanup: CLEANUP_RULE, numbering: this.numRules().rule,
        verdicts: 'Verdicts are read in report-like documents only (a reports/qc/review/walkthrough/receipt folder or name, or a QC/review/report title): a verdict field (结论/判定/verdict/result/status: …) is stated; a verdict word in a heading, a table row or near QC words is a candidate for judgement; a line listing the choices (pass / fail / incomplete) is a template and is not recorded.',
        occurred: 'Commit: the author time (the committer time too when it differs). A document version: its commit, with the date the document states for itself kept as the other time. A line of a document: the first version that has it, with the date written in the text for that line kept as the other time; content of an import-style root commit by the rule above. Session: the message time. Outside version control: the written date (with the file time as the other time), else the file time the rebuild recorded; never a time the program did not read.',
      },
    };
  }

  /** Every repository's and directory's measured code reach (code.ts `reachOf`), by id. */
  private reaches(): Map<string, CodeReach> {
    const out = new Map<string, CodeReach>();
    for (const { repo } of this.all<{ repo: string }>('SELECT DISTINCT repo FROM code_files')) {
      const r = reachOf(this.db, repo);
      if (r) out.set(repo, r);
    }
    return out;
  }

  /**
   * How far the code structure goes, per language (§1.16 "看得见"), measured: who reads each language's references and what
   * that reached — imports resolved and not, references by resolution method (counted, and matched by a name only), files
   * nothing resolved reaches though code names them, and apart from those the named entry points (a build or manifest file
   * names them: where the code is entered, not how deep it is read). `referenceLevel` is the three-way word the views show:
   * `symbol` (the compiler; the engine where nothing was seen unresolved), `file` (the engine where something was: a residual
   * judgement there is Inferred), `file tree` (no reader). `reader` and `read` say the same as `readBy` and `level` for a
   * program to read: who reads the language's references, and how many of its files that reader read (the `Code` view).
   */
  private codeCoverage() {
    const rows = this.all<{ language: string | null; reader: string | null; c: number; l: number; sample: string }>(this.hasReader()
      ? 'SELECT ifnull(ref_lang, lang) language, reader, count(*) c, ifnull(sum(lines), 0) l, min(path) sample FROM code_files WHERE generated = 0 AND classification IS NULL GROUP BY 1, 2'
      : "SELECT lang language, CASE WHEN lang IN ('typescript', 'javascript') THEN 'compiler' END reader, count(*) c, ifnull(sum(lines), 0) l, min(path) sample FROM code_files WHERE generated = 0 AND classification IS NULL GROUP BY 1, 2");
    const reaches = this.reaches();
    const measured = new Map<string, LanguageReach[]>();
    for (const r of reaches.values()) for (const l of r.languages) measured.set(l.language, [...(measured.get(l.language) ?? []), l]);
    const sum = (xs: readonly (number | undefined)[]) => xs.reduce<number>((n, x) => n + (x ?? 0), 0);
    const merge = (xs: readonly (Readonly<Record<string, number>> | undefined)[]) => { const o: Record<string, number> = {}; for (const x of xs) for (const [k, v] of Object.entries(x ?? {})) o[k] = (o[k] ?? 0) + v; return o; };
    const byLang = new Map<string, { files: number; lines: number; read: number; reader: 'compiler' | 'engine' | null; sample: string }>();
    for (const r of rows) {
      const key = r.language ?? '(no extension)';
      const e = byLang.get(key) ?? { files: 0, lines: 0, read: 0, reader: null, sample: r.sample };
      e.files += r.c; e.lines += r.l;
      if (r.reader === 'compiler' || r.reader === 'engine') { e.read += r.c; e.reader = e.reader ?? r.reader; }
      byLang.set(key, e);
    }
    const engineErrors = [...reaches.values()].map((r) => r.error).filter((e): e is string => Boolean(e));
    const languages = [...byLang.entries()].sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0])).map(([language, e]) => {
      const m = measured.get(language) ?? [];
      const reach = m.length ? {
        imports: {
          resolved: sum(m.map((x) => x.imports.resolved)), unresolved: sum(m.map((x) => x.imports.unresolved)),
          ...(e.reader === 'engine' ? { unresolvedNamingRepoFiles: sum(m.map((x) => x.imports.unresolvedNamingRepoFiles)), sample: m.flatMap((x) => x.imports.sample ?? []).slice(0, 5) } : {}),
        },
        ...(e.reader === 'engine' ? { counted: merge(m.map((x) => x.counted)), nameOnly: merge(m.map((x) => x.nameOnly)), trackedOnly: sum(m.map((x) => x.trackedOnly)), parseErrors: sum(m.map((x) => x.parseErrors)) } : {}),
        namedButUnreferenced: sum(m.map((x) => x.namedButUnreferenced)), namedSample: m.flatMap((x) => x.namedSample).slice(0, 5),
        namedEntryPoints: sum(m.map((x) => x.namedEntryPoints)), entrySample: m.flatMap((x) => x.entrySample ?? []).slice(0, 5),
      } : null;
      const gaps: string[] = [];
      if (reach?.namedButUnreferenced) gaps.push(`${reach.namedButUnreferenced} file${reach.namedButUnreferenced === 1 ? '' : 's'} no counted reference reaches ${reach.namedButUnreferenced === 1 ? 'is' : 'are'} named by other files — references its reader did not resolve (${reach.namedSample.slice(0, 3).join('; ')})`);
      if (reach?.imports.unresolvedNamingRepoFiles) gaps.push(`${reach.imports.unresolvedNamingRepoFiles} import${reach.imports.unresolvedNamingRepoFiles === 1 ? '' : 's'} left unresolved name a file of the repository (${(reach.imports.sample ?? []).slice(0, 3).join('; ')})`);
      if (reach?.parseErrors) gaps.push(`${reach.parseErrors} file${reach.parseErrors === 1 ? '' : 's'} the engine could not parse in full`);
      if (e.reader === null && engineErrors.length && !compilerReads(e.sample) && engineLanguage(e.sample) !== null) gaps.push(`the code engine's references are missing: ${engineErrors[0]}`);
      const referenceLevel: 'symbol' | 'file' | 'file tree' = e.reader === 'compiler' ? 'symbol' : e.reader === 'engine' ? (gaps.length ? 'file' : 'symbol') : 'file tree';
      // Where the language's code is entered from a build or manifest file (code.ts NamingKind entry): not how deep it is
      // read, so no gap here; a residual call on those files is Inferred all the same (referenceReach).
      const entered = reach?.namedEntryPoints ? `; ${plural(reach.namedEntryPoints, 'named entry point')} no counted reference reaches, named by a build or manifest file (${reach.entrySample.slice(0, 3).join('; ')})` : '';
      const level = e.reader === 'compiler' ? `symbol level (the TypeScript compiler): file dependencies through its pre-parser, symbols on demand with pk_ledger_symbol${entered}`
        : e.reader === 'engine' ? `symbol level (${ENGINE_LABEL}): the references it resolved, symbols on demand with pk_ledger_symbol${e.read < e.files ? `; ${e.files - e.read} of the ${e.files} files not read (nothing in them to reference, or not indexed: over 1 MB, or in a directory the engine skips such as vendor/ or build/)` : ''}${gaps.length ? `; incomplete — ${gaps.join('; ')}` : ''}${entered}`
        : 'file tree and sizes only';
      return { language, files: e.files, lines: e.lines, reader: e.reader, read: e.read, readBy: e.reader === 'compiler' ? 'the TypeScript compiler' : e.reader === 'engine' ? ENGINE_LABEL : null, level, referenceLevel, gaps, ...(reach ? { reach } : {}) };
    });
    const engine = {
      engine: ENGINE_LABEL, counted: COUNTED_RULE,
      runs: [...reaches.entries()].filter(([, r]) => r.run || r.error).map(([repo, r]) => ({
        repo, snapshotFiles: r.snapshot?.files ?? 0, notCopied: r.snapshot?.failed.length ?? 0,
        lastRun: r.run ? { ran: r.run.ran, ok: r.run.ok, ms: r.run.ms, peakMemoryMB: r.run.peakMemoryMB, indexBytes: r.run.indexBytes } : null, error: r.error,
      })),
    };
    return { languages, engine };
  }

  /**
   * Whether a computed "nothing references this" (or "this is referenced") can stand for the code under `paths` of one
   * repository (Spec §1.19; CKC-25 AC-5): `complete` when every code file there is read by a reader — the TypeScript
   * compiler, or the code engine — and none of them is a file no counted reference reaches that another file names: a build
   * or manifest file (a named entry point) or code (a reference no reader resolved); a document or other text that only
   * mentions it leaves the fact as computed. Otherwise `gaps` says why, and a residual judgement there is Inferred. Paths
   * are repository-relative, a directory or a file.
   */
  referenceReach(repoInput: string, paths: readonly string[]): { readonly complete: boolean; readonly languages: readonly string[]; readonly gaps: readonly string[] } {
    // A repository by id or path; a directory outside version control by its scope item id.
    const repo = this.one<{ repo: string }>('SELECT repo FROM code_files WHERE repo = ? LIMIT 1', repoInput)?.repo ?? this.repoId(repoInput);
    if (!repo) return { complete: false, languages: [], gaps: [`${repoInput} is not a repository of this ledger`] };
    const under = (p: string) => paths.some((raw) => { const x = nameForm(raw).replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, ''); return x === '' || p === x || p.startsWith(`${x}/`); });
    const files = this.all<{ path: string; lang: string | null; reader?: string | null; ref_lang?: string | null; named_by?: string | null }>('SELECT * FROM code_files WHERE repo = ? AND generated = 0 AND classification IS NULL', repo).filter((f) => under(f.path));
    const code = files.filter((f) => this.readerOf(f) !== null || (f.lang !== null && !NOT_CODE.has(f.lang)));
    const languages = [...new Set(code.map((f) => f.ref_lang ?? f.lang ?? '(no extension)'))].sort();
    if (!code.length) return { complete: false, languages, gaps: ['these paths hold no code whose references the ledger reads'] };
    const gaps: string[] = [];
    const unread = code.filter((f) => this.readerOf(f) === null);
    if (unread.length) {
      const why = reachOf(this.db, repo)?.error;
      gaps.push(`the ledger reads no references of ${[...new Set(unread.map((f) => f.ref_lang ?? f.lang ?? '(no extension)'))].join(', ')} (${unread.length} file${unread.length === 1 ? '' : 's'} here${why ? `; ${why}` : ''})`);
    }
    // Files other files name (code.ts NamingKind): a named entry point, or a reference no reader resolved. A document or
    // other text that only mentions a file references nothing, and leaves the fact as computed.
    gaps.push(...namedGaps(code.flatMap((f) => { const by = namingThatCounts(namingOf(f.named_by))[0]; return by ? [{ path: f.path, by }] : []; }), ' here'));
    return { complete: gaps.length === 0, languages, gaps };
  }

  /** Days with commits in any repository and no session message of any host that day (the sessions do not cover them). */
  private daysWithoutSessions(): { from: string; to: string; commitDays: number }[] {
    const commitDays = new Set(this.all<{ author_at: string }>('SELECT author_at FROM commits WHERE on_trunk = 1').map((r) => dayOf(r.author_at)!));
    const sessionDays = new Set(this.all<{ at: string }>('SELECT at FROM session_messages WHERE at IS NOT NULL').map((r) => dayOf(r.at)!));
    // Runs of consecutive commit days (in the order commits were made) that no session covers.
    const out: { from: string; to: string; commitDays: number }[] = [];
    let run: { from: string; to: string; commitDays: number } | null = null;
    for (const d of [...commitDays].sort()) {
      if (sessionDays.has(d)) { run = null; continue; }
      if (run) { run.to = d; run.commitDays += 1; } else { run = { from: d, to: d, commitDays: 1 }; out.push(run); }
    }
    return out;
  }

  // ───────────────────────── what the ledger read last (Update pending, Spec §1.11) ─────────────────────────

  /**
   * A document as the ledger last read it, by its path on disk: the content its repository's current version has (the
   * checkout's HEAD at the last rebuild), else the file outside version control as that rebuild read it; null when the
   * ledger keeps no text of it (not a document, never read, too large). The rebuild is a round's first step, so this is
   * the version the latest round took in; what waits for the next round is compared with it section by section
   * (keeper/organize/update-pending.ts).
   */
  currentText(absPath: string): string | null {
    const key = pathKey(absPath);
    const repo = this.repos().filter((r) => key === pathKey(r.path) || key.startsWith(`${pathKey(r.path)}${sep}`)).sort((a, b) => b.path.length - a.path.length)[0];
    if (repo) {
      const rel = relativeDisplay(repo.path, absPath);
      const f = this.one<{ blob: string | null }>('SELECT blob FROM code_files WHERE repo = ? AND path = ?', repo.id, rel);
      const text = f?.blob ? this.blobText(repo.id, f.blob) : null;
      if (text !== null) return text;
    }
    return this.one<{ content: string }>('SELECT content FROM texts WHERE key = ?', `loose:${normalizePath(absPath)}`)?.content ?? null;
  }

  /** The branch a worktree of one of the ledger's repositories has checked out, by the worktree's path; null when unknown. */
  worktreeBranch(absPath: string): string | null {
    const key = pathKey(absPath);
    return this.all<{ path: string; branch: string | null }>('SELECT path, branch FROM worktrees').find((w) => pathKey(w.path) === key)?.branch ?? null;
  }

  /**
   * Where the material an entry names is on disk: a document version, a deletion, an arrangement, a file of the current
   * version, a line entry (a verdict, a number, a supersession) — the file's path; a session or one of its messages — the
   * session's log. Null for what names no place (a commit, a cleanup, a rule) and for an id the ledger does not have.
   */
  entryPlace(rawId: string): { readonly file: string } | { readonly sessionFile: string } | null {
    const id = nameForm(rawId.trim());   // an id that holds a path may have been typed from a listing
    const colon = id.indexOf(':');
    if (colon <= 0) return null;
    const kind = id.slice(0, colon);
    const rest = id.slice(colon + 1);
    const table: Record<string, string> = { doc: 'docs', del: 'deleted_docs', plan: 'plans', verdict: 'verdicts', num: 'nums', sup: 'supersedes' };
    const place = (repo: string | null, path: string | null): { file: string } | null => {
      if (!path) return null;
      if (!repo) return { file: path };
      const root = this.repoPath(repo);
      return root ? { file: join(root, ...path.split('/')) } : null;
    };
    if (table[kind]) {
      const r = this.one<{ repo: string | null; path: string | null }>(`SELECT repo, path FROM ${table[kind]} WHERE key = ? LIMIT 1`, id);
      return r ? place(r.repo, r.path) : null;
    }
    if (kind === 'file') {
      const r = this.one<{ repo: string }>('SELECT repo FROM code_files WHERE path = ? LIMIT 1', rest);
      return r ? place(r.repo, rest) : null;
    }
    if (kind === 'loose') return { file: rest };
    if (kind === 'session' || kind === 'msg') {
      const s = kind === 'session'
        ? this.one<{ file: string }>('SELECT file FROM sessions WHERE key = ?', id)
        : this.one<{ file: string }>('SELECT s.file FROM session_messages m JOIN sessions s ON s.key = m.session WHERE m.key = ?', id);
      return s ? { sessionFile: s.file } : null;
    }
    return null;
  }

  // ───────────────────────── entry ids (evidence) ─────────────────────────

  /** Read an entry back by its id: its label, when it happened, and its text (for a cited line to be checked against). */
  resolve(rawId: string): LedgerEntry | null {
    const id = nameForm(rawId.trim());   // an id that holds a path may have been typed from a listing
    const colon = id.indexOf(':');
    if (colon <= 0) return null;
    const kind = id.slice(0, colon);
    const rest = id.slice(colon + 1);
    switch (kind) {
      case 'commit': {
        const c = this.findCommit(rest);
        if (typeof c === 'string') return null;
        const hash = String(c.hash);
        return { id: `commit:${hash.slice(0, 12)}`, kind, label: `${hash.slice(0, 7)} ${String(c.subject)}`, occurred: this.commitOccurred(hash, String(c.author_at), String(c.committer_at)), text: `${String(c.subject)}\n\n${String(c.body)}`.trim() };
      }
      case 'doc': {
        const d = this.one<Record<string, unknown>>('SELECT * FROM docs WHERE key = ? LIMIT 1', id);
        if (!d) return null;
        const text = this.blobText(String(d.repo), String(d.blob));
        return { id, kind, label: `${String(d.path)} @ ${String(d.commit_hash).slice(0, 7)} (${String(d.change)})`, occurred: this.docOccurred({ repo: String(d.repo), path: String(d.path), commit_hash: String(d.commit_hash), at: String(d.at), import_root: Number(d.import_root), blob: String(d.blob) }), ...(text !== null ? { text } : {}) };
      }
      case 'del': {
        const d = this.one<Record<string, unknown>>('SELECT * FROM deleted_docs WHERE key = ? LIMIT 1', id);
        if (!d) return null;
        const text = this.blobText(String(d.repo), (d.blob as string | null) ?? null);
        return { id, kind, label: `${String(d.path)} deleted in ${String(d.deleted_commit).slice(0, 7)}${d.cleanup === 1 ? ' (cleanup commit)' : ''}; full text at ${String(d.readable_at ?? '').slice(0, 7)}`, occurred: this.commitOccurred(String(d.deleted_commit), String(d.deleted_at)), ...(text !== null ? { text } : {}) };
      }
      case 'cleanup': {
        const c = this.one<Record<string, unknown>>('SELECT * FROM cleanups WHERE key = ? LIMIT 1', id);
        if (!c) return null;
        return { id, kind, label: `cleanup commit ${String(c.commit_hash).slice(0, 7)}: ${Number(c.deleted_docs)} documents deleted (${json<string[]>(String(c.catalog_before), []).length} → ${json<string[]>(String(c.catalog_after), []).length})`, occurred: this.commitOccurred(String(c.commit_hash), String(c.at)), text: json<string[]>(String(c.catalog_before), []).filter((p) => !json<string[]>(String(c.catalog_after), []).includes(p)).join('\n') };
      }
      case 'sup': {
        const s = this.one<Record<string, unknown>>('SELECT * FROM supersedes WHERE key = ?', id);
        if (!s) return null;
        const row = this.lineBase(s);
        const where = s.source === 'commit' ? `commit ${String(s.first_commit).slice(0, 7)}` : `${String(s.path)}${row.line ? `:${row.line}` : ''}`;
        return { id, kind, label: `${where} — ${s.obsolete_list === 1 ? 'a row of the obsolete list' : `says “${String(s.pattern)}”`}: ${String(s.replaced ?? '?')} → ${String(s.replacement ?? '(no replacement named)')}${row.current ? '' : ' (not in the current version)'}`, occurred: row.occurred, text: row.text };
      }
      case 'num': {
        const n = this.one<Record<string, unknown>>('SELECT * FROM nums WHERE key = ?', id);
        if (!n) return null;
        const row = this.lineBase(n);
        const where = n.kind === 'commit' ? `commit ${String(n.commit_hash).slice(0, 7)}` : n.kind === 'doc' || n.kind === 'loose' ? `${String(n.path)}${row.line ? `:${row.line}` : ''}` : `${String(n.kind)} ${String(n.context)}`;
        return { id, kind, label: `${String(n.num)} ${n.place === 'definition' ? 'defined' : 'named'} in ${where}`, occurred: row.occurred, text: String(n.context) };
      }
      case 'rule': {
        const r = this.one<Record<string, unknown>>('SELECT * FROM num_rules WHERE rule = ?', rest);
        if (!r) return null;
        const first = this.one<Record<string, unknown>>("SELECT * FROM nums WHERE rule = ? AND place = 'definition' ORDER BY first_ms LIMIT 1", rest);
        return { id, kind, label: `numbering rule ${rest}: ${String(r.examples)}`, occurred: first ? this.rowOccurred(first as never) : undated(this.lastRead(), id), text: String(r.basis) };
      }
      case 'verdict': {
        const v = this.one<Record<string, unknown>>('SELECT * FROM verdicts WHERE key = ?', id);
        if (!v) return null;
        const row = this.lineBase(v);
        return { id, kind, label: `${String(v.path)}${row.line ? `:${row.line}` : ''} — ${String(v.kind)} ${String(v.verdict ?? '')} (${String(v.confidence)})`, occurred: row.occurred, text: row.text };
      }
      case 'plan': {
        const p = this.one<Record<string, unknown>>('SELECT * FROM plans WHERE key = ? LIMIT 1', id);
        if (!p) return null;
        const data = json<{ status?: string | null; title?: string }>(String(p.data), {});
        const text = p.repo && p.blob ? this.blobText(String(p.repo), String(p.blob)) : null;
        return { id, kind, label: `${String(p.path)}${p.commit_hash ? ` @ ${String(p.commit_hash).slice(0, 7)}` : ''} (${String(p.kind)}${p.ident ? ` ${String(p.ident)}` : ''}${data.status ? `, status ${data.status}` : ''})`, occurred: this.rowOccurred(p as never), text: text ?? String(p.data) };
      }
      case 'session': {
        const s = this.one<Record<string, unknown>>('SELECT * FROM sessions WHERE key = ?', id);
        if (!s) return null;
        return { id, kind, label: `${String(s.host)} session ${String(s.session_id).slice(0, 8)} (${String(s.started_at ?? '?').slice(0, 16)} → ${String(s.ended_at ?? '?').slice(0, 16)})${s.missing === 1 ? ', log gone' : ''}`, occurred: s.started_at ? { at: materialTime(String(s.started_at)) ?? String(s.started_at), basis: 'Session', anchor: id } : { at: String(s.first_seen), basis: 'First observed', anchor: id, undated: true } };
      }
      case 'msg': {
        const m = this.message(id);
        if (!m) return null;
        const s = this.one<Record<string, unknown>>('SELECT host, session_id FROM sessions WHERE key = ?', m.session);
        return { id, kind, label: `${m.speaker === 'owner' ? 'the owner' : m.speaker}, ${String(s?.host ?? '')} session ${String(s?.session_id ?? '').slice(0, 8)} [${m.index}]`, occurred: m.occurred, ...(m.text !== null ? { text: m.text } : {}) };
      }
      case 'file': {
        const f = this.one<Record<string, unknown>>('SELECT * FROM code_files WHERE path = ? LIMIT 1', rest);
        if (!f) return null;
        const tracked = this.repos().some((r) => r.id === f.repo);
        return { id, kind, label: `${rest} (${tracked ? 'current version' : 'outside version control'}, ${String(f.lines ?? '?')} lines)`, occurred: this.codeFileOccurred(f, id) };
      }
      case 'loose': {
        const t = this.one<{ content: string }>('SELECT content FROM texts WHERE key = ?', id);
        if (!t) return null;
        // The document's own date, else its file time — never the moment of the query as "first seen" (QC AY).
        return { id, kind, label: `${rest} (outside version control)`, occurred: this.looseOccurred(rest, t.content, null), text: t.content };
      }
      default: return null;
    }
  }
}

/** The 1-based line a word first appears on (case-insensitive, as the trigram index finds it); null when it is not there. */
function lineOf(content: string, word: string): number | null {
  const idx = content.toLowerCase().indexOf(word.toLowerCase());
  if (idx < 0) return null;
  let line = 1;
  for (let i = content.indexOf('\n'); i >= 0 && i < idx; i = content.indexOf('\n', i + 1)) line += 1;
  return line;
}

function snippetOf(content: string, word: string): string {
  const idx = content.toLowerCase().indexOf(word.toLowerCase());
  if (idx < 0) return clip(content.replace(/\s+/g, ' '), 140);
  const from = Math.max(0, idx - 60);
  const to = Math.min(content.length, idx + word.length + 60);
  return `${from > 0 ? '…' : ''}${content.slice(from, to).replace(/\s+/g, ' ')}${to < content.length ? '…' : ''}`;
}

function countBy(xs: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

export { rebuildLedger, rebuildLedgerInPlace, ledgerPath, ledgerRepos, sessionInputOf, type RebuildOptions, type RebuildStats } from './rebuild.ts';
export type { Occurred, OccurredBasis } from './time.ts';
export type { SymbolResult, SymbolQueryKind } from './ts-symbols.ts';
/** A symbol answer: the TypeScript language service's (each hit exact) or the code engine's (each hit with its method). */
export type SymbolAnswer = (SymbolResult & { readonly answeredBy: string }) | EngineSymbolResult;
