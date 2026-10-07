/**
 * Recompute the ledger (Spec §1.16; CKC-22 AC-2, AC-16). No model is involved and nothing here touches the network; git
 * is only read. `rebuildLedger` runs the work on a worker thread so the workbench's event loop keeps answering; queries go
 * through their own read-only connections (WAL), which a rebuild never blocks.
 *
 * Incremental (AC-2): a ref's recorded tip, each distinct document content, each loose file's size and time and each
 * session log's size and time decide what is read again; the first build of a ledger reads everything.
 *
 * Which repositories: every `Repository` item of the scope the project reads (its own repository, a nested independent
 * repository such as ContextKeeper's `app/`, a copy), each on its own; a worktree folds into its main repository, whose
 * worktree list the ledger reads. Material outside version control — `Directory` items, and documents a repository's
 * checkout has but has never committed — is read from disk and dated by its written dates, else its file time (§3.7).
 *
 * The code engine (code-engine.ts) keeps its snapshots and indexes next to the ledger, in `code-index/` of the project's
 * ProjectKeeper directory; the one of a repository or directory the scope no longer holds is removed with its entries.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import type { Project, ScopeItem } from '../model/types.ts';
import { projectDir } from '../store/paths.ts';
import { isSkippedName, treatmentOf } from '../scope/skip.ts';
import { sessionCwdOf, sessionStoreRootOf } from '../sources/sessions/scope.ts';
import { isDocumentPath } from '../sources/history.ts';
import { isWithin, nameForm, normalizePath, pathKey } from '../util/paths.ts';
import { getState, openLedgerForWrite, putText, redact, setState, tx } from './schema.ts';
import { scanRepo, type RepoHandle, type RepoScanStats } from './repo-scan.ts';
import { MAX_DOC_BYTES, scanDocs, type DocScanStats } from './docs.ts';
import { computeNumRules, numKey, scanLooseDocument, scanTextsFirstPass, scanTextsSecondPass, textStats, type NameItem, type TextScanStats } from './text-scan.ts';
import { definitionsInText, familyOf } from './numbering.ts';
import { msOf } from './time.ts';
import { arrangementKind, scanArrangements, scanLooseArrangement, type ArrangementScanStats } from './arrangements.ts';
import { reachOf, scanCode, scanLooseCode, type CodeScanStats } from './code.ts';
import { dropEngineDir, engineDirOf } from './code-engine.ts';
import { scanBlame, type BlameScanStats } from './blame.ts';
import { scanSessions, type SessionScanInput, type SessionScanStats } from './sessions.ts';
import { ledgerGit } from './git-read.ts';
import { OWN_TS_WORKER_OPTIONS } from '../util/own-ts.ts';

export function ledgerPath(projectId: string, home?: string): string {
  return join(projectDir(projectId, home), 'ledger.sqlite');
}

/** Where the code engine keeps a project's snapshots and indexes: `code-index/` next to its ledger (never in the project). */
export const engineRootOf = (dbPath: string): string => join(dirname(dbPath), 'code-index');

export interface RebuildOptions {
  /** Session logs to read; null or absent: sessions are not part of this rebuild (the coverage says so). */
  readonly sessions?: SessionScanInput | null;
  /** Recompute the parts whose inputs did not move too. */
  readonly force?: boolean;
  /**
   * The numbers the Keeper gave to what the project did not number (Spec §1.17, D72; CKC-22 AC-5: "Keeper 编的号也在账本
   * 里"). Recorded as the ledger's `keeper` occurrences, so such a number is found in the ledger whether or not the
   * project folder holds it — before, it reached the ledger only once `projectkeeper/keeper-numbers.md` was authorized,
   * committed and read (QC AY). Absent or null: the Keeper's rows stay as the last rebuild that had them recorded them.
   */
  readonly keeperNumbers?: readonly KeeperNumberInput[] | null;
}

/** A Keeper number as the ledger records it (model/k-types.ts `KeeperNumber`). */
export interface KeeperNumberInput {
  readonly number: string;
  readonly objectId: string;
  readonly objectKind: string;
  /** The project's own number, once it numbers the object itself: the Keeper's stays an alias. */
  readonly projectNumber: string | null;
  /** When the Keeper gave it. */
  readonly at: string;
}

/** The Keeper's numbers, all of them, in place of the ones the last rebuild recorded. */
function recordKeeperNumbers(db: DatabaseSync, numbers: readonly KeeperNumberInput[]): number {
  let n = 0;
  tx(db, () => {
    db.prepare("DELETE FROM nums WHERE kind = 'keeper'").run();
    const ins = db.prepare(`INSERT OR IGNORE INTO nums (key, num, rule, kind, place, position, repo, path, commit_hash, line, context, ident, confidence, first_ms, occurred_at, occurred_basis, occurred_anchor, undated, current)
      VALUES (?, ?, ?, 'keeper', 'definition', 'Keeper number', NULL, NULL, NULL, NULL, ?, ?, 'stated', ?, ?, 'First observed', ?, 0, 1)`);
    for (const k of numbers) {
      const context = `The Keeper's number for ${k.objectKind} ${k.objectId}${k.projectNumber ? `; the project numbers it ${k.projectNumber}, which comes first` : ''}`;
      // When the Keeper gave the number is when the program first saw it: it recorded it then.
      if (ins.run(numKey(null, 'keeper', k.objectId, k.number, k.number), k.number, familyOf(k.number)?.family ?? 'Keeper number', redact(context), k.number, msOf(k.at), k.at, `keeper-number:${k.number}`).changes > 0) n += 1;
    }
  });
  return n;
}

export interface RepoRebuildStats extends RepoScanStats {
  readonly docs: DocScanStats;
  readonly texts: TextScanStats;
  readonly arrangements: ArrangementScanStats;
  readonly code: CodeScanStats;
  readonly blame: BlameScanStats;
  readonly ms: number;
}

export interface RebuildStats {
  readonly kind: 'full' | 'incremental';
  readonly startedAt: string;
  readonly endedAt: string;
  readonly ms: number;
  readonly commitsAdded: number;
  readonly repos: readonly RepoRebuildStats[];
  readonly loose: { readonly items: number; readonly files: number; readonly documents: number; readonly read: number; readonly untrackedDocuments: number };
  readonly sessions: SessionScanStats | 'not scanned';
  readonly numRules: number;
  /** What could not be read, in words (a repository git cannot open, a session log that fails to parse …). */
  readonly notes: readonly string[];
}

/** The repositories whose history the ledger records (see the module comment). */
export function ledgerRepos(project: Project): RepoHandle[] {
  const out: RepoHandle[] = [];
  const seen = new Set<string>();
  const add = (id: string, path: string) => {
    const key = pathKey(path);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, path: normalizePath(path) });
  };
  const repos = project.scope.filter((i) => i.category === 'Repository' && !i.missing && i.versionControl !== 'none' && treatmentOf(i) === 'read');
  for (const i of [...repos].sort((a, b) => Number(b.relation === 'Main project') - Number(a.relation === 'Main project'))) add(i.id, i.path);
  // A worktree whose main repository is not itself a scope item: the main repository is read in its place.
  for (const w of project.scope.filter((i) => i.category === 'Worktree' && !i.missing && i.worktreeOf && i.relation !== 'Excluded')) {
    if (!repos.some((r) => pathKey(r.path) === pathKey(w.worktreeOf!))) add(w.id, w.worktreeOf!);
  }
  return out;
}

/** Scope items outside version control whose material the ledger reads from disk. */
export function looseItems(project: Project): ScopeItem[] {
  return project.scope.filter((i) => i.category === 'Directory' && !i.missing && treatmentOf(i) === 'read' && i.versionControl !== 'git');
}

/** The sessions of a project: the working directories of its scope and of its session items, each in its own native home. */
export function sessionInputOf(project: Project): SessionScanInput {
  const cwds = new Set<string>();
  for (const i of project.scope) {
    if ((i.category === 'Directory' || i.category === 'Repository' || i.category === 'Worktree') && i.relation !== 'Excluded' && !i.missing) cwds.add(i.path);
    if (i.copyOf) cwds.add(i.copyOf);
    const c = sessionCwdOf(i);
    if (i.category === 'Session source' && c && i.relation !== 'Excluded') cwds.add(c);
  }
  const homes: { host: 'claude' | 'codex'; cwd: string; home: string }[] = [];
  for (const cwd of cwds) for (const host of ['claude', 'codex'] as const) {
    const home = sessionStoreRootOf(project.scope, host, cwd, homedir());
    if (pathKey(home) !== pathKey(homedir())) homes.push({ host, cwd, home });
  }
  return { cwds: [...cwds], homes };
}

/** The scope's classification of the location holding a path (innermost wins), for the code structure. */
function classifier(scope: readonly ScopeItem[]): (abs: string) => string | null {
  const classified = scope.filter((i) => i.category !== 'Session source' && (i.classification?.kind || i.relation === 'Third-party material' || i.relation === 'Generated'));
  return (abs) => {
    const hit = classified.filter((i) => isWithin(i.path, abs)).sort((a, b) => b.path.length - a.path.length)[0];
    return hit ? (hit.classification?.kind ?? hit.relation) : null;
  };
}

/** A file outside version control larger than this is not read; the rebuild says which (`notes`, the coverage). */
export const MAX_LOOSE_BYTES = 2_000_000;

/** The first few of a list, and how many more: what a note says without printing every path. */
function listSome(items: readonly string[], n = 12): string {
  return `${items.slice(0, n).join(', ')}${items.length > n ? `, and ${items.length - n} more` : ''}`;
}

/** What the code engine could not read in one repository or directory, for the rebuild's notes (the coverage says it too). */
function codeEngineNote(db: DatabaseSync, id: string, path: string): string | null {
  const reach = reachOf(db, id);
  if (!reach) return null;
  const parts: string[] = [];
  if (reach.error) parts.push(`the code engine's references are missing: ${reach.error}`);
  const failed = reach.snapshot?.failed ?? [];
  if (failed.length) parts.push(`${failed.length} file${failed.length === 1 ? '' : 's'} could not be copied into the engine's snapshot, so ${failed.length === 1 ? 'its' : 'their'} references are not read: ${listSome(failed, 5)}`);
  return parts.length ? `${path}: ${parts.join('; ')}.` : null;
}

interface LooseFile { readonly abs: string; readonly rel: string; readonly size: number; readonly mtimeMs: number }

function walkDocs(root: string, skip: (abs: string) => boolean, into: LooseFile[], rel = '', depth = 0): void {
  if (depth > 20) return;
  let entries;
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const name = nameForm(e.name);
    const r = rel ? `${rel}/${name}` : name;
    const abs = join(root, ...r.split('/'));
    if (e.isDirectory()) { if (!isSkippedName(name) && name !== '.git' && !skip(abs)) walkDocs(root, skip, into, r, depth + 1); continue; }
    if (!e.isFile() || !(isDocumentPath(r) || arrangementKind(r) !== null)) continue;
    try { const st = statSync(abs); into.push({ abs, rel: r, size: st.size, mtimeMs: st.mtimeMs }); } catch { continue; }
  }
}

/** Documents a checkout has and has never committed (untracked, not ignored): outside version control too. */
function untrackedDocs(repo: RepoHandle): LooseFile[] {
  const r = ledgerGit(repo.path, ['status', '--porcelain', '-z', '--untracked-files=all'], { timeoutMs: 120_000 });
  if (!r.ok) return [];
  const out: LooseFile[] = [];
  for (const entry of r.out.split('\0')) {
    if (!entry.startsWith('?? ')) continue;
    const rel = entry.slice(3);
    if (!(isDocumentPath(rel) || arrangementKind(rel) !== null)) continue;
    const abs = join(repo.path, ...rel.split('/'));
    try { const st = statSync(abs); if (st.isFile()) out.push({ abs, rel, size: st.size, mtimeMs: st.mtimeMs }); } catch { continue; }
  }
  return out;
}

/** Everything the ledger recorded of one repository (or one directory outside version control) removed, its code snapshot too. */
function dropRepo(db: DatabaseSync, id: string, engineRoot: string): void {
  tx(db, () => {
    for (const t of ['refs', 'commits', 'commit_files', 'branches', 'worktrees', 'docs', 'deleted_docs', 'cleanups', 'doc_items', 'doc_scans', 'supersedes', 'nums', 'verdicts', 'plans', 'code_files', 'code_deps', 'code_blame', 'dir_stats', 'merge_dirs']) {
      db.prepare(`DELETE FROM ${t} WHERE repo = ?`).run(id);
    }
    for (const { rowid } of db.prepare('SELECT id AS rowid FROM texts WHERE repo = ?').all(id) as { rowid: number }[]) {
      db.prepare('DELETE FROM texts_fts WHERE rowid = ?').run(rowid);
      db.prepare('DELETE FROM texts WHERE id = ?').run(rowid);
    }
    db.prepare('DELETE FROM repos WHERE id = ?').run(id);
    db.prepare("DELETE FROM state WHERE key LIKE ? OR key LIKE ? OR key = ? OR key = ?").run(`ref:${id}:%`, `importRoots:${id}`, `code:${id}`, `codeReach:${id}`);
  });
  dropEngineDir(engineDirOf(engineRoot, id));
}

/** The whole recompute, synchronously, on whatever thread calls it. */
export function rebuildLedgerInPlace(dbPath: string, project: Project, opts: RebuildOptions = {}): RebuildStats {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const db = openLedgerForWrite(dbPath);
  const notes: string[] = [];
  const engineRoot = engineRootOf(dbPath);
  try {
    const hadCommits = (db.prepare('SELECT count(*) c FROM commits').get() as { c: number }).c > 0;
    const classify = classifier(project.scope);
    const repos = ledgerRepos(project);
    // A repository the scope no longer holds (excluded, gone) leaves the ledger with everything recorded of it.
    for (const { id } of db.prepare('SELECT id FROM repos').all() as { id: string }[]) {
      if (!repos.some((r) => r.id === id)) { dropRepo(db, id, engineRoot); notes.push(`${id}: no longer a repository of the scope; its history left the ledger.`); }
    }
    const perRepo: { repo: RepoHandle; scan: RepoScanStats; docs: DocScanStats; code: CodeScanStats; blame: BlameScanStats; contents: number; ms: number }[] = [];
    const names: NameItem[] = [];
    for (const repo of repos) {
      const t0 = Date.now();
      const scan = scanRepo(db, repo, startedAt);
      if (scan.refs === 0 && scan.commits === 0) notes.push(`${repo.path}: git shows no ref and no commit there (not a repository, or git cannot open it).`);
      if (scan.unreadCommits > 0) notes.push(`${repo.path}: ${scan.unreadCommits} commits could not be read.`);
      const docs = scanDocs(db, repo, startedAt);
      const unread = docs.withoutTextPaths ?? [];
      if (unread.length) notes.push(`${repo.path}: ${unread.length} document version${unread.length === 1 ? '' : 's'} recorded without text (over ${MAX_DOC_BYTES / 1_000_000} MB, or not text), so the superseded lines, numbers and verdicts in ${unread.length === 1 ? 'it' : 'them'} are not in the ledger: ${listSome(unread.map((u) => `${u.path}@${u.commit.slice(0, 7)} (${Math.round(u.bytes / 1000)} kB)`))}.`);
      const code = scanCode(db, repo, { classify, engineRoot }, { force: opts.force, now: startedAt });
      const reachNote = codeEngineNote(db, repo.id, repo.path);
      if (reachNote) notes.push(reachNote);
      const blame = scanBlame(db, repo, opts.force === true);
      if (blame.failed) notes.push(`${repo.path}: git blame could not cover ${blame.failed} current source files.`);
      const first = scanTextsFirstPass(db, repo);
      names.push(...first.names);
      perRepo.push({ repo, scan, docs, code, blame, contents: first.contents, ms: Date.now() - t0 });
    }

    // Material outside version control: directories of the scope, and documents a checkout never committed.
    const loose: LooseFile[] = [];
    const items = looseItems(project);
    const otherItems = project.scope.filter((i) => i.category !== 'Session source');
    for (const item of items) {
      // Another scope item inside this directory (a nested repository, an excluded folder) is left to itself.
      const skip = (abs: string) => otherItems.some((o) => o.id !== item.id && pathKey(o.path) === pathKey(abs));
      walkDocs(item.path, skip, loose);
      scanLooseCode(db, item.id, item.path, skip, { classify, engineRoot }, opts.force === true, startedAt);
      const reachNote = codeEngineNote(db, item.id, item.path);
      if (reachNote) notes.push(reachNote);
    }
    // A directory the scope no longer holds leaves the code structure, its code snapshot with it.
    const held = new Set([...repos.map((r) => r.id), ...items.map((i) => i.id)]);
    for (const { repo } of db.prepare('SELECT DISTINCT repo FROM code_files').all() as { repo: string }[]) {
      if (held.has(repo)) continue;
      tx(db, () => { for (const t of ['code_files', 'code_deps', 'dir_stats']) db.prepare(`DELETE FROM ${t} WHERE repo = ?`).run(repo); db.prepare('DELETE FROM state WHERE key = ? OR key = ?').run(`loosecode:${repo}`, `codeReach:${repo}`); });
      dropEngineDir(engineDirOf(engineRoot, repo));
    }
    const untracked = repos.flatMap((r) => untrackedDocs(r));
    const allLoose = [...loose, ...untracked];
    // Too large to read: listed and said, not left out without a word (QC AY).
    const tooLarge = allLoose.filter((f) => f.size > MAX_LOOSE_BYTES).map((f) => normalizePath(f.abs));
    if (tooLarge.length) notes.push(`${tooLarge.length} file${tooLarge.length === 1 ? '' : 's'} outside version control over ${MAX_LOOSE_BYTES / 1_000_000} MB not read (their dates, superseded lines, numbers and verdicts are not in the ledger): ${listSome(tooLarge)}.`);
    const looseTexts = new Map<string, string>();
    for (const f of allLoose) {
      if (f.size > MAX_LOOSE_BYTES) continue;
      try {
        const text = readFileSync(f.abs, 'utf8');
        if (!text.slice(0, 8000).includes('\0')) looseTexts.set(f.abs, text);
      } catch { continue; }
    }
    for (const f of allLoose) {
      const text = looseTexts.get(f.abs);
      if (text === undefined || !isDocumentPath(f.rel)) continue;
      for (const d of definitionsInText(text)) names.push({ kind: 'loose', where: normalizePath(f.abs), def: d });
    }

    const { rules, changed } = computeNumRules(db, names);
    const repoStats: RepoRebuildStats[] = [];
    for (const r of perRepo) {
      const t0 = Date.now();
      scanTextsSecondPass(db, r.repo, rules, changed, names.filter((n) => n.kind !== 'loose'), startedAt);
      const arrangements = scanArrangements(db, r.repo, startedAt);
      repoStats.push({ ...r.scan, docs: r.docs, code: r.code, blame: r.blame, texts: textStats(db, r.repo.id, r.contents, changed), arrangements, ms: r.ms + Date.now() - t0 });
    }

    let read = 0;
    tx(db, () => {
      const seen = new Set<string>();
      for (const f of allLoose) {
        const path = normalizePath(f.abs);
        seen.add(path);
        const text = looseTexts.get(f.abs);
        if (text === undefined) continue;
        const stamp = `${f.size}:${Math.round(f.mtimeMs)}`;
        if (!changed && !opts.force && getState(db, `loose:${path}`) === stamp) continue;
        const fileTime = new Date(f.mtimeMs).toISOString();
        if (isDocumentPath(f.rel)) {
          putText(db, `loose:${path}`, 'loose', null, text);
          scanLooseDocument(db, path, text, fileTime, rules);
        }
        if (arrangementKind(f.rel)) scanLooseArrangement(db, path, f.rel, text, fileTime);
        setState(db, `loose:${path}`, stamp);
        // When the program first read it: the `first seen` of a document that gives no time of its own (§2.11).
        if (getState(db, `loosefirst:${path}`) === null) setState(db, `loosefirst:${path}`, startedAt);
        read += 1;
      }
      // A loose file gone from disk: its rows go (the file never had a version to keep).
      for (const { key } of db.prepare("SELECT key FROM state WHERE key LIKE 'loose:%'").all() as { key: string }[]) {
        const path = key.slice('loose:'.length);
        if (seen.has(path)) continue;
        db.prepare("DELETE FROM supersedes WHERE repo IS NULL AND source = 'loose' AND path = ?").run(path);
        db.prepare('DELETE FROM verdicts WHERE repo IS NULL AND path = ?').run(path);
        db.prepare("DELETE FROM nums WHERE repo IS NULL AND kind = 'loose' AND path = ?").run(path);
        db.prepare('DELETE FROM plans WHERE repo IS NULL AND path = ?').run(path);
        db.prepare('DELETE FROM state WHERE key = ? OR key = ?').run(key, `loosefirst:${path}`);
        const t = db.prepare('SELECT id FROM texts WHERE key = ?').get(`loose:${path}`) as { id: number } | undefined;
        if (t) { db.prepare('DELETE FROM texts_fts WHERE rowid = ?').run(t.id); db.prepare('DELETE FROM texts WHERE id = ?').run(t.id); }
      }
      setState(db, 'looseDocuments', JSON.stringify({ items: items.map((i) => i.path), documents: allLoose.filter((f) => isDocumentPath(f.rel)).length, untracked: untracked.filter((f) => isDocumentPath(f.rel)).length, tooLarge }));
    });

    const sessions = opts.sessions ? scanSessions(db, opts.sessions, startedAt) : ('not scanned' as const);
    if (opts.sessions) setState(db, 'sessionsScanned', startedAt);
    if (opts.keeperNumbers) recordKeeperNumbers(db, opts.keeperNumbers);
    if (sessions !== 'not scanned' && sessions.unreadable > 0) notes.push(`${sessions.unreadable} session logs could not be read (listed with their reason).`);

    const endedAt = new Date().toISOString();
    const commitsAdded = repoStats.reduce((n, r) => n + r.commitsAdded, 0);
    const stats: RebuildStats = {
      kind: hadCommits && !opts.force ? 'incremental' : 'full', startedAt, endedAt, ms: Date.now() - started, commitsAdded,
      repos: repoStats,
      loose: { items: items.length, files: allLoose.length, documents: allLoose.filter((f) => isDocumentPath(f.rel)).length, read, untrackedDocuments: untracked.filter((f) => isDocumentPath(f.rel)).length },
      sessions, numRules: rules.length, notes,
    };
    db.prepare('INSERT INTO rebuilds (started_at, ended_at, ms, kind, commits_added, stats) VALUES (?, ?, ?, ?, ?, ?)')
      .run(startedAt, endedAt, stats.ms, stats.kind, commitsAdded, JSON.stringify(stats));
    setState(db, 'lastRebuildAt', endedAt);
    setState(db, 'repos', JSON.stringify(repos));
    return stats;
  } finally {
    db.close();
  }
}

/** The same recompute on a worker thread, so the workbench keeps answering (CKC-22 AC-16: no model involved). */
export function rebuildLedger(dbPath: string, project: Project, opts: RebuildOptions = {}): Promise<RebuildStats> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./rebuild-worker.ts', import.meta.url), { workerData: { dbPath, project, opts }, ...OWN_TS_WORKER_OPTIONS });
    let settled = false;
    worker.once('message', (msg: { ok: true; stats: RebuildStats } | { ok: false; error: string }) => {
      settled = true;
      if (msg.ok) resolve(msg.stats);
      else reject(new Error(msg.error));
      void worker.terminate();
    });
    worker.once('error', (error) => { if (!settled) { settled = true; reject(error); } });
    worker.once('exit', (code) => { if (!settled) { settled = true; reject(new Error(`the ledger's rebuild worker exited with code ${code}`)); } });
  });
}

export type { DatabaseSync };
