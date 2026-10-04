/**
 * Ledger storage (CKC-22, Spec §1.16): one `ledger.sqlite` per project in its ProjectKeeper project directory, in WAL
 * mode so the read-only connections the workbench and the Keeper's tools query through never wait on a recompute. No
 * dependency beyond Node's own `node:sqlite`. Full-text search is FTS5 with the trigram tokenizer: a query of three
 * characters or more uses the index; a shorter one (a two-character Chinese word) is answered by a substring scan.
 *
 * Every row a query hands out carries an entry id (`key`) derived from what the row is — repository, commit, path, the
 * line's words, the session and message — never from a row number, so the same fact keeps the same id across
 * incremental and full rebuilds and a judgement that cites it stays resolvable (keeper/evidence.ts `LedgerHook`).
 *
 * Credential values never enter the ledger (Spec §3.1): every text is redacted on the way in (`putText`, `redact`).
 */
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactCredentials } from '../sources/anchor.ts';

/** node:sqlite loads when a ledger is first opened: a process that never opens one — the CLI's client commands, which
 *  print what an agent reads — prints no experimental-feature warning. */
const requireBuiltin = createRequire(import.meta.url);
const sqlite = (): typeof import('node:sqlite') => requireBuiltin('node:sqlite') as typeof import('node:sqlite');

/** Bumped when the tables change shape; an older ledger file is set aside and rebuilt in full. */
export const SCHEMA_VERSION = 3;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- §1.16 版本历史 --------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,                 -- scope item id
  path TEXT NOT NULL,                  -- the repository's own checkout (a worktree folds into its main repository)
  trunk TEXT, trunk_tip TEXT,          -- default branch and its tip; null when git gives none
  head TEXT, head_branch TEXT,         -- what the checkout has now (the code structure is read from it)
  version_from TEXT,                   -- author time of the earliest commit
  import_rule TEXT                     -- why a root commit was (not) taken as import-style (AC-15), in words
);
CREATE TABLE IF NOT EXISTS refs (
  repo TEXT NOT NULL, refname TEXT NOT NULL,
  namespace TEXT NOT NULL,             -- heads | tags | remotes | stash | other (e.g. refs/codex/turn-diffs/…)
  type TEXT NOT NULL DEFAULT 'commit', -- what it names: commit, or tree / blob (no history to walk)
  tip TEXT NOT NULL, present INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, refname)
);
CREATE TABLE IF NOT EXISTS commits (
  key TEXT NOT NULL,                   -- commit:<hash12> (repositories that share history share the entry)
  repo TEXT NOT NULL, hash TEXT NOT NULL,
  parents TEXT NOT NULL,               -- space-separated full hashes
  author_at TEXT NOT NULL, author_ms INTEGER NOT NULL,
  committer_at TEXT NOT NULL, committer_ms INTEGER NOT NULL,
  author TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  merge INTEGER NOT NULL DEFAULT 0,    -- two parents or more
  on_trunk INTEGER NOT NULL DEFAULT 0, -- reachable from the trunk tip
  first_parent_trunk INTEGER NOT NULL DEFAULT 0, -- on the trunk's first-parent line (a merge into the trunk is one)
  reach TEXT NOT NULL DEFAULT '',      -- ref namespaces it is reachable from, e.g. "heads,remotes"
  import_root INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  scanned INTEGER NOT NULL DEFAULT 0,  -- the text scans have read its message
  PRIMARY KEY (repo, hash)
);
CREATE INDEX IF NOT EXISTS commits_ms ON commits (repo, author_ms);
CREATE INDEX IF NOT EXISTS commits_key ON commits (key);
CREATE TABLE IF NOT EXISTS commit_files (
  repo TEXT NOT NULL, hash TEXT NOT NULL,
  status TEXT NOT NULL,                -- A M D R C T (against the first parent; a merge: what it brought into that line)
  path TEXT NOT NULL, old_path TEXT,
  old_blob TEXT, new_blob TEXT,        -- null on the side that does not exist
  added INTEGER, deleted INTEGER,      -- null for binary
  PRIMARY KEY (repo, hash, path)
);
CREATE INDEX IF NOT EXISTS commit_files_path ON commit_files (repo, path);
CREATE INDEX IF NOT EXISTS commit_files_old ON commit_files (repo, old_path);
CREATE TABLE IF NOT EXISTS branches (
  repo TEXT NOT NULL, name TEXT NOT NULL, namespace TEXT NOT NULL,   -- heads | remotes
  tip TEXT NOT NULL, tip_at TEXT,
  merged INTEGER,                      -- tip is an ancestor of the trunk tip; null when git could not tell
  ahead INTEGER,                       -- commits it has that the trunk does not
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, name)
);
CREATE TABLE IF NOT EXISTS worktrees (
  repo TEXT NOT NULL, path TEXT NOT NULL,
  branch TEXT, head TEXT, merged INTEGER, detached INTEGER NOT NULL DEFAULT 0,
  uncommitted INTEGER NOT NULL DEFAULT 0, uncommitted_list TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, path)
);

-- §1.16 文档的每一版 ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS docs (
  key TEXT NOT NULL,                   -- doc:<path>@<hash10>
  repo TEXT NOT NULL, path TEXT NOT NULL, commit_hash TEXT NOT NULL,
  blob TEXT NOT NULL, prev_blob TEXT, prev_path TEXT,
  at TEXT NOT NULL, at_ms INTEGER NOT NULL,
  change TEXT NOT NULL,                -- Added | Modified | Renamed | Copied
  sections INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, lines INTEGER NOT NULL DEFAULT 0,
  import_root INTEGER NOT NULL DEFAULT 0,
  added TEXT, removed TEXT, changed TEXT,   -- section diff against the previous version (JSON heading paths)
  scanned INTEGER NOT NULL DEFAULT 0,
  UNIQUE (repo, path, commit_hash)
);
CREATE INDEX IF NOT EXISTS docs_path ON docs (repo, path, at_ms);
CREATE INDEX IF NOT EXISTS docs_blob ON docs (repo, blob);
CREATE INDEX IF NOT EXISTS docs_key ON docs (key);
CREATE TABLE IF NOT EXISTS deleted_docs (
  key TEXT NOT NULL,                   -- del:<path>@<hash10>
  repo TEXT NOT NULL, path TEXT NOT NULL,
  deleted_commit TEXT NOT NULL, deleted_at TEXT NOT NULL, deleted_ms INTEGER NOT NULL,
  readable_at TEXT,                    -- the commit whose tree still has the full text (the deleting commit's first parent)
  blob TEXT,                           -- the last version's content
  cleanup INTEGER NOT NULL DEFAULT 0,
  UNIQUE (repo, path, deleted_commit)
);
CREATE INDEX IF NOT EXISTS deleted_docs_key ON deleted_docs (key);
CREATE TABLE IF NOT EXISTS cleanups (
  key TEXT NOT NULL,                   -- cleanup:<hash10>
  repo TEXT NOT NULL, commit_hash TEXT NOT NULL, at TEXT NOT NULL, at_ms INTEGER NOT NULL,
  deleted_docs INTEGER NOT NULL, deleted_total INTEGER NOT NULL,
  catalog_before TEXT NOT NULL, catalog_after TEXT NOT NULL,   -- JSON: document paths before / after
  UNIQUE (repo, commit_hash)
);
CREATE INDEX IF NOT EXISTS cleanups_key ON cleanups (key);

-- A line of the material, kept once per document and followed through its versions: the first version it appears in
-- (its occurred time), the last, and whether the current version still has it. Used by the three line scans below:
-- doc_items says which content of which document has which line item, at which line.
CREATE TABLE IF NOT EXISTS doc_items (
  repo TEXT NOT NULL, path TEXT NOT NULL, blob TEXT NOT NULL,
  tbl TEXT NOT NULL,                   -- supersedes | verdicts | nums
  key TEXT NOT NULL, line INTEGER NOT NULL,
  PRIMARY KEY (repo, path, blob, key)
);
CREATE INDEX IF NOT EXISTS doc_items_key ON doc_items (key);
CREATE TABLE IF NOT EXISTS doc_scans (
  repo TEXT NOT NULL, path TEXT NOT NULL, blob TEXT NOT NULL,
  what TEXT NOT NULL,                  -- lines (supersessions, verdicts, number definitions) | mentions (numbers, per rule set)
  PRIMARY KEY (repo, path, blob, what)
);
-- §1.16 明写的取代
CREATE TABLE IF NOT EXISTS supersedes (
  key TEXT NOT NULL UNIQUE,            -- sup:<hex12>
  repo TEXT, source TEXT NOT NULL,     -- content | filename | commit | loose (outside version control)
  path TEXT, pattern TEXT NOT NULL, target TEXT, text TEXT NOT NULL,
  replaced TEXT, replacement TEXT, syntax TEXT,
  ident TEXT NOT NULL,                 -- the line in its normal form: the same line in another document or at the old path of a move
  obsolete_list INTEGER NOT NULL DEFAULT 0, list_heading TEXT,
  first_commit TEXT, first_line INTEGER, first_ms INTEGER,
  occurred_at TEXT NOT NULL, occurred_basis TEXT NOT NULL, occurred_anchor TEXT,
  other_at TEXT, other_basis TEXT, undated INTEGER NOT NULL DEFAULT 0,
  last_commit TEXT, last_ms INTEGER, current INTEGER NOT NULL DEFAULT 0, current_line INTEGER
);
CREATE INDEX IF NOT EXISTS supersedes_path ON supersedes (repo, path);
-- §1.16 编号
CREATE TABLE IF NOT EXISTS num_rules (
  rule TEXT PRIMARY KEY,               -- the family, e.g. "D<n>", "CKC-<n>", "two letters"
  shape TEXT NOT NULL, prefix TEXT NOT NULL,
  basis TEXT NOT NULL,                 -- where the program saw it defined, and how often
  examples TEXT NOT NULL, defined INTEGER NOT NULL, occurrences INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS nums (
  key TEXT NOT NULL UNIQUE,            -- num:<hex12>
  num TEXT NOT NULL, rule TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- doc | commit | branch | worktree | file-name | loose
  place TEXT NOT NULL,                 -- definition | mention
  position TEXT,                       -- where a definition stands: heading, bold entry, table first column, front matter …
  repo TEXT, path TEXT, commit_hash TEXT, line INTEGER, context TEXT NOT NULL,
  ident TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'stated',   -- candidate: a two-letter id that is also an ordinary word, in prose
  first_ms INTEGER, occurred_at TEXT NOT NULL, occurred_basis TEXT NOT NULL, occurred_anchor TEXT,
  other_at TEXT, other_basis TEXT, undated INTEGER NOT NULL DEFAULT 0,
  last_commit TEXT, last_ms INTEGER, current INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS nums_num ON nums (num);
CREATE INDEX IF NOT EXISTS nums_path ON nums (repo, path);
CREATE INDEX IF NOT EXISTS nums_commit ON nums (kind, commit_hash);
-- §1.16 判定
CREATE TABLE IF NOT EXISTS verdicts (
  key TEXT NOT NULL UNIQUE,            -- verdict:<hex12>
  repo TEXT, path TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- verdict | count | finding
  verdict TEXT,                        -- normalised: pass | fail | incomplete | needs-repair | partial | done | not-done; count: "511/511"
  confidence TEXT NOT NULL,            -- stated | candidate (AC-6)
  text TEXT NOT NULL,
  ident TEXT NOT NULL,
  first_commit TEXT, first_line INTEGER, first_ms INTEGER,
  occurred_at TEXT NOT NULL, occurred_basis TEXT NOT NULL, occurred_anchor TEXT,
  other_at TEXT, other_basis TEXT, undated INTEGER NOT NULL DEFAULT 0,
  last_commit TEXT, last_ms INTEGER, current INTEGER NOT NULL DEFAULT 0, current_line INTEGER
);
CREATE INDEX IF NOT EXISTS verdicts_path ON verdicts (repo, path);
-- §1.16 执行安排: every committed version of every arrangement file, parsed.
CREATE TABLE IF NOT EXISTS plans (
  key TEXT NOT NULL,                   -- plan:<path>@<hash10>, or plan:<path> outside version control
  repo TEXT, path TEXT NOT NULL, commit_hash TEXT, blob TEXT,
  kind TEXT NOT NULL,                  -- index | prompt | plan | status | receipt
  ident TEXT,                          -- the work id it is about (AP, T5 …) when its name or fields say
  parsed INTEGER NOT NULL,             -- 0: structure unreadable — 交判断读 (AC-7)
  data TEXT NOT NULL,                  -- JSON
  current INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL, occurred_ms INTEGER, occurred_basis TEXT NOT NULL, occurred_anchor TEXT,
  other_at TEXT, other_basis TEXT, undated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS plans_path ON plans (repo, path);
CREATE INDEX IF NOT EXISTS plans_key ON plans (key);
CREATE UNIQUE INDEX IF NOT EXISTS plans_version ON plans (ifnull(repo, ''), path, ifnull(commit_hash, ''));

-- §1.16 代码结构 (the version the checkout has) -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS code_files (
  repo TEXT NOT NULL, path TEXT NOT NULL,
  bytes INTEGER NOT NULL, lines INTEGER,     -- null lines: binary or not read
  lang TEXT,
  generated INTEGER NOT NULL DEFAULT 0, generated_how TEXT,
  blob TEXT,                                 -- content id: the documents' current version is the one with this content
  classification TEXT,                       -- the scope's classification (third-party, generated …): not product code
  test INTEGER NOT NULL DEFAULT 0, test_cases INTEGER NOT NULL DEFAULT 0,
  last_commit TEXT, last_at TEXT,
  file_at TEXT,                              -- outside version control: the file's own time when the rebuild read it (File time)
  first_seen TEXT,                           -- when a rebuild first read the file (Undated · first seen)
  reader TEXT,                               -- who reads its references: compiler (TypeScript, JavaScript) | engine | null (none)
  ref_lang TEXT,                             -- its language as that reader names it (the engine's for a file the engine tracks)
  named_by TEXT,                             -- JSON: files naming it though no counted reference reaches it, and how (code.ts NamingKind)
  PRIMARY KEY (repo, path)
);
CREATE TABLE IF NOT EXISTS code_deps (
  repo TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- import | reference (TypeScript); the code engine's: import | calls | references | instantiates | extends | implements …
  external INTEGER NOT NULL DEFAULT 0,       -- dst is a package or a path outside the repository's files
  PRIMARY KEY (repo, src, dst, kind)
);
CREATE INDEX IF NOT EXISTS code_deps_dst ON code_deps (repo, dst);
-- Current tracked source lines: compact contiguous blame ranges, keyed by the content fingerprint.
-- No source text is stored here. A changed blob invalidates only its own file's ranges.
CREATE TABLE IF NOT EXISTS code_blame (
  repo TEXT NOT NULL, path TEXT NOT NULL, blob TEXT NOT NULL,
  lines INTEGER NOT NULL, segments TEXT NOT NULL, computed_at TEXT NOT NULL,
  PRIMARY KEY (repo, path)
);
CREATE TABLE IF NOT EXISTS dir_stats (
  repo TEXT NOT NULL, dir TEXT NOT NULL,
  files INTEGER NOT NULL, lines INTEGER NOT NULL,
  product_files INTEGER NOT NULL, product_lines INTEGER NOT NULL,
  generated_files INTEGER NOT NULL, generated_lines INTEGER NOT NULL,
  other_files INTEGER NOT NULL, other_lines INTEGER NOT NULL,   -- third-party and other classified material
  tests INTEGER NOT NULL, test_cases INTEGER NOT NULL,
  last_at TEXT, last_commit TEXT,
  PRIMARY KEY (repo, dir)
);
CREATE TABLE IF NOT EXISTS merge_dirs (
  repo TEXT NOT NULL, commit_hash TEXT NOT NULL, at TEXT NOT NULL, on_trunk INTEGER NOT NULL,
  dirs TEXT NOT NULL,                        -- JSON: [dir, files changed]
  PRIMARY KEY (repo, commit_hash)
);

-- §1.16 会话 ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  key TEXT NOT NULL UNIQUE,            -- session:<hex12> of host + native session id + log file
  host TEXT NOT NULL, session_id TEXT NOT NULL, file TEXT NOT NULL,
  cwd TEXT, started_at TEXT, ended_at TEXT,
  messages INTEGER NOT NULL DEFAULT 0, owner_messages INTEGER NOT NULL DEFAULT 0,
  headless INTEGER NOT NULL DEFAULT 0, subagent INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0, mtime_ms INTEGER NOT NULL DEFAULT 0, broken_lines INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,  -- read before, the log is gone now (§3.11)
  unreadable TEXT,                     -- why it could not be read, when it could not
  first_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_messages (
  key TEXT NOT NULL UNIQUE,            -- msg:<hex12> of the session key + message position
  session TEXT NOT NULL,               -- sessions.key
  idx INTEGER NOT NULL,                -- position in the native log, as the session transcripts number it
  role TEXT NOT NULL,                  -- user | assistant
  speaker TEXT NOT NULL,               -- owner | agent | subagent | host (by the session's structure: read.ts isOwnerMessage)
  at TEXT,
  text TEXT,                           -- verbatim (redacted) for the owner's words and the agent message each answers
  chars INTEGER NOT NULL DEFAULT 0,
  tools TEXT,                          -- the agent's tool calls in one line each (JSON), for agent messages
  answers INTEGER,                     -- owner message: the position of the agent message right before it
  UNIQUE (session, idx)
);
CREATE INDEX IF NOT EXISTS session_messages_at ON session_messages (at);

-- Everything the ledger read that a word can be searched in: document contents (once per distinct content), commit
-- messages, the owner's words and the agent messages they answer, documents outside version control.
CREATE TABLE IF NOT EXISTS texts (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,            -- blob:<repo>:<blob> | commit:<hash12> | msg:<hex12> | loose:<path>
  kind TEXT NOT NULL,                  -- doc | commit | owner | agent | loose
  repo TEXT,
  content TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS texts_fts USING fts5(content, tokenize='trigram');

CREATE TABLE IF NOT EXISTS rebuilds (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL, ended_at TEXT NOT NULL, ms INTEGER NOT NULL,
  kind TEXT NOT NULL,                  -- full | incremental
  commits_added INTEGER NOT NULL DEFAULT 0,
  stats TEXT NOT NULL
);
`;

/** Open the ledger for writing: created when missing, WAL, and rebuilt from nothing when its schema is older. */
export function openLedgerForWrite(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new (sqlite().DatabaseSync)(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 10000');
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  const version = hasMeta ? (db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion') as { value: string } | undefined) : undefined;
  const tables = (db.prepare("SELECT count(*) c FROM sqlite_master WHERE type = 'table'").get() as { c: number }).c;
  if (tables > 0 && (!version || Number(version.value) !== SCHEMA_VERSION)) {
    // A ledger of another shape is set aside (never deleted) and this one is built in full.
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(path + suffix)) renameSync(path + suffix, `${path}.schema-${version?.value ?? 'unknown'}-${Date.now()}.bak${suffix}`);
    }
    return openLedgerForWrite(path);
  }
  db.exec(DDL);
  migrate(db);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schemaVersion', String(SCHEMA_VERSION));
  return db;
}

/**
 * Additive changes to a ledger of this schema version, made in place — nothing is set aside or rebuilt from nothing — and
 * filled from what the ledger holds:
 * - `code_files.file_at` and `code_files.first_seen` (CKC-22 AC-10, Spec §2.11): a code file outside version control is
 *   dated by its own time, else by the rebuild that first read it, never by the moment of a query. A file read before
 *   they were kept was read by the ledger's last rebuild at the latest, which stands as its first reading; the
 *   directories outside version control are read again at this rebuild, which records their files' own times.
 * - `supersedes.replaced`, `replacement`, and `syntax`: old word-match rows are removed and saved document blobs and
 *   commit messages are scanned again at the next rebuild; their two sides cannot be inferred from a legacy `target`.
 * - `code_files.reader`, `ref_lang` and `named_by` (D98: the code engine reads every language the TypeScript path does
 *   not): the code of every repository and directory is read again at the next rebuild, which fills them.
 * Readers of a ledger not yet migrated see none of these columns and fall back (index.ts `codeFileOccurred`, `hasReader`).
 */
function migrate(db: DatabaseSync): void {
  const codeColumns = new Set((db.prepare('PRAGMA table_info(code_files)').all() as { name: string }[]).map((c) => c.name));
  const supColumns = new Set((db.prepare('PRAGMA table_info(supersedes)').all() as { name: string }[]).map((c) => c.name));
  const readerColumns = ['reader', 'ref_lang', 'named_by'];
  if (codeColumns.has('file_at') && codeColumns.has('first_seen') && supColumns.has('replaced') && supColumns.has('replacement') && supColumns.has('syntax') && readerColumns.every((c) => codeColumns.has(c))) return;
  tx(db, () => {
    if (!readerColumns.every((c) => codeColumns.has(c))) {
      for (const c of readerColumns) if (!codeColumns.has(c)) db.exec(`ALTER TABLE code_files ADD COLUMN ${c} TEXT`);
      db.prepare("DELETE FROM state WHERE key LIKE 'code:%' OR key LIKE 'loosecode:%'").run();
    }
    if (!codeColumns.has('file_at') || !codeColumns.has('first_seen')) {
      if (!codeColumns.has('file_at')) db.exec('ALTER TABLE code_files ADD COLUMN file_at TEXT');
      if (!codeColumns.has('first_seen')) db.exec('ALTER TABLE code_files ADD COLUMN first_seen TEXT');
      const last = getState(db, 'lastRebuildAt') ?? (db.prepare('SELECT max(ended_at) at FROM rebuilds').get() as { at: string | null } | undefined)?.at ?? null;
      if (last) db.prepare('UPDATE code_files SET first_seen = ? WHERE first_seen IS NULL').run(last);
      db.prepare("DELETE FROM state WHERE key LIKE 'loosecode:%'").run();
    }
    if (!supColumns.has('replaced') || !supColumns.has('replacement') || !supColumns.has('syntax')) {
      if (!supColumns.has('replaced')) db.exec('ALTER TABLE supersedes ADD COLUMN replaced TEXT');
      if (!supColumns.has('replacement')) db.exec('ALTER TABLE supersedes ADD COLUMN replacement TEXT');
      if (!supColumns.has('syntax')) db.exec('ALTER TABLE supersedes ADD COLUMN syntax TEXT');
      // The previous word-match rows cannot be migrated by guessing sides. Re-read saved document blobs and commits.
      db.prepare("DELETE FROM doc_items WHERE tbl = 'supersedes'").run();
      db.prepare('DELETE FROM supersedes').run();
      db.prepare("DELETE FROM doc_scans WHERE what = 'lines'").run();
      db.prepare('UPDATE commits SET scanned = 0').run();
    }
  });
}

/** Open the ledger read-only for queries; null when it has never been built or has another shape. */
export function openLedgerReadOnly(path: string): DatabaseSync | null {
  if (!existsSync(path)) return null;
  try {
    const db = new (sqlite().DatabaseSync)(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 10000');
    const v = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string } | undefined;
    if (!v || Number(v.value) !== SCHEMA_VERSION) { db.close(); return null; }
    return db;
  } catch {
    return null;
  }
}

export const getState = (db: DatabaseSync, key: string): string | null =>
  (db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

export const setState = (db: DatabaseSync, key: string, value: string): void => {
  db.prepare('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)').run(key, value);
};

/** Run `fn` in one transaction (the rebuild writes in large batches; one fsync per batch). */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// ───────────────────────── entry ids ─────────────────────────

/** Twelve hex digits of a SHA-1: enough to keep a project's entries apart, short enough to cite. */
export const hex12 = (...parts: readonly (string | number | null | undefined)[]): string =>
  createHash('sha1').update(parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('\x1f')).digest('hex').slice(0, 12);

export const commitKey = (hash: string): string => `commit:${hash.slice(0, 12)}`;
export const docKey = (path: string, commit: string): string => `doc:${path}@${commit.slice(0, 10)}`;
export const delKey = (path: string, commit: string): string => `del:${path}@${commit.slice(0, 10)}`;
export const cleanupKey = (commit: string): string => `cleanup:${commit.slice(0, 10)}`;
export const blobTextKey = (repo: string, blob: string): string => `blob:${repo}:${blob}`;
export const planKey = (path: string, commit: string | null): string => (commit ? `plan:${path}@${commit.slice(0, 10)}` : `plan:${path}`);

/** A line of the material in its normal form: what makes two versions' lines the same line. */
export const lineIdentity = (line: string): string => line.normalize('NFC').replace(/\s+/g, ' ').trim();

// ───────────────────────── searchable text ─────────────────────────

/** Credential values replaced by a marker; the fact that one was there stays visible (Spec §3.1). */
export const redact = (text: string): string => redactCredentials(text).text;

/** Store a searchable text under its key (redacted), keeping the FTS index in step. Unchanged text is not rewritten. */
export function putText(db: DatabaseSync, key: string, kind: string, repo: string | null, content: string): void {
  const red = redact(content);
  const existing = db.prepare('SELECT id, content FROM texts WHERE key = ?').get(key) as { id: number; content: string } | undefined;
  if (existing) {
    if (existing.content === red) return;
    db.prepare('DELETE FROM texts_fts WHERE rowid = ?').run(existing.id);
    db.prepare('UPDATE texts SET kind = ?, repo = ?, content = ? WHERE id = ?').run(kind, repo, red, existing.id);
    db.prepare('INSERT INTO texts_fts (rowid, content) VALUES (?, ?)').run(existing.id, red);
    return;
  }
  const w = db.prepare('INSERT INTO texts (key, kind, repo, content) VALUES (?, ?, ?, ?)').run(key, kind, repo, red);
  db.prepare('INSERT INTO texts_fts (rowid, content) VALUES (?, ?)').run(Number(w.lastInsertRowid), red);
}

export function getText(db: DatabaseSync, key: string): string | null {
  return (db.prepare('SELECT content FROM texts WHERE key = ?').get(key) as { content: string } | undefined)?.content ?? null;
}

export function deleteText(db: DatabaseSync, key: string): void {
  const row = db.prepare('SELECT id FROM texts WHERE key = ?').get(key) as { id: number } | undefined;
  if (!row) return;
  db.prepare('DELETE FROM texts_fts WHERE rowid = ?').run(row.id);
  db.prepare('DELETE FROM texts WHERE id = ?').run(row.id);
}
