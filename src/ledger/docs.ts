/**
 * Document versions (Spec §1.16 row 2; CKC-22 AC-3, AC-15): every version of every document in the history (documents
 * as `isDocumentPath` of sources/history.ts defines them) with the commit and time it lives at; adds, renames, copies and
 * deletions; which Markdown sections (by heading path) the version added, removed or changed against the version before
 * it; the cleanup commits that delete many documents at once, with the document catalogue before and after; and for a
 * deleted document the commit whose tree still has its full text.
 *
 * "The version before it" is the content the commit changed — its first parent's version of the same document (for a
 * rename, of the old path) — so the section diff is exactly what that commit did, on whichever branch it was made.
 * Contents are stored once per distinct content (`blob:<repo>:<id>` in the searchable texts).
 *
 * Import-style root commit (AC-15), the rule: a commit without parents that adds at least `IMPORT_MIN_DOCS` documents, and
 * either one of those documents states a full date earlier than the commit's own day (so the content existed before it
 * entered version control), or its message says it puts existing material under version control. Its content is not dated
 * by the commit: see `occurredOfLine`.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isDocumentPath } from '../sources/history.ts';
import { splitMarkdown } from '../sources/files.ts';
import { blobTextKey, cleanupKey, delKey, docKey, getText, putText, tx } from './schema.ts';
import { catBlobs, isText, treeFiles } from './git-read.ts';
import { dateContext, dayOf, fullDatesIn, materialTime, occurred, undated, type DateContext, type Occurred } from './time.ts';
import type { RepoHandle } from './repo-scan.ts';

/** A cleanup commit deletes at least this many documents in one commit. */
export const CLEANUP_MIN_DOCS = 5;
/** An import-style root commit adds at least this many documents. */
export const IMPORT_MIN_DOCS = 5;
/** Words of a message that says existing material is being put under version control. */
export const IMPORT_MESSAGE = /\b(import(?:ed|ing)?|under version control|into (?:git|version control)|initial import|existing (?:files|material|documents))\b|纳入(?:版本管理|git|版本控制)|导入|迁入|入库/i;
/** Content larger than this is recorded as a version (size, sections unknown) without its text. */
export const MAX_DOC_BYTES = 4_000_000;

export const IMPORT_RULE = `A root commit (no parents) that adds at least ${IMPORT_MIN_DOCS} documents, where one of them states a full date earlier than the commit's own day, or whose message says it puts existing material under version control. Its content is dated by the date written in the text (the line's own date, else its entry's 日期/date line, else the entry heading's date, else the document's stated date); else by the file's time in the working tree (File time, a weak basis: copying and moving change it); else Undated · first seen at the import commit.`;
export const CLEANUP_RULE = `One commit that deletes at least ${CLEANUP_MIN_DOCS} documents (a move is not a deletion).`;

export interface DocScanStats {
  readonly versions: number;
  readonly versionsAdded: number;
  readonly withoutText: number;
  /** The versions this scan recorded without their text (over `MAX_DOC_BYTES`, or not text), so the rebuild says which. */
  readonly withoutTextPaths?: readonly { readonly path: string; readonly commit: string; readonly bytes: number }[];
  readonly deleted: number;
  readonly cleanups: number;
  readonly importRoots: number;
}

const CHANGE: Record<string, string> = { A: 'Added', M: 'Modified', R: 'Renamed', C: 'Copied', T: 'Type changed' };

/** The key of a section by its heading path, before a heading path used twice is told apart (`sectionMap`). */
export const sectionBase = (headingPath: readonly string[]): string => (headingPath.length ? headingPath.join(' › ') : '(before the first heading)');

/** One section of a document with the key `sectionMap` and `diffSections` give it, and where it stands. */
export interface KeyedSection {
  readonly key: string;
  readonly base: string;
  readonly headingPath: readonly string[];
  readonly lineStart: number;
  readonly lineEnd: number;
  /** The section as written, heading line included. */
  readonly text: string;
  /** What `sectionMap` compares: the section without its heading line, trimmed. */
  readonly body: string;
}

/** A document's sections in order, keyed as `sectionMap` keys them (a heading path used twice gets ` #2`). */
export function keyedSections(text: string): KeyedSection[] {
  const out: KeyedSection[] = [];
  const used = new Set<string>();
  for (const s of splitMarkdown(text)) {
    const base = sectionBase(s.headingPath);
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base} #${n}`;
    used.add(key);
    const body = s.text.split(/\r?\n/).slice(s.headingPath.length ? 1 : 0).join('\n').trim();
    out.push({ key, base, headingPath: s.headingPath, lineStart: s.lineStart, lineEnd: s.lineEnd, text: s.text, body });
  }
  return out;
}

/** Heading path → section text; a heading path used twice in one document is told apart by its position (` #2`). */
export function sectionMap(text: string): Map<string, string> {
  return new Map(keyedSections(text).map((s) => [s.key, s.body]));
}

export function diffSections(before: string | null, after: string): { added: string[]; removed: string[]; changed: string[] } {
  const a = before === null ? new Map<string, string>() : sectionMap(before);
  const b = sectionMap(after);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [k, v] of b) {
    if (!a.has(k)) added.push(k);
    else if (a.get(k) !== v) changed.push(k);
  }
  for (const k of a.keys()) if (!b.has(k)) removed.push(k);
  return { added, removed, changed };
}

const lineCount = (text: string): number => (text.length === 0 ? 0 : text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0));

// ───────────────────────── when a line of a document happened ─────────────────────────

export interface VersionTime {
  readonly commit: string;
  readonly commitAt: string;
  readonly importRoot: boolean;
  readonly path: string;
  readonly firstSeen: string;
  /** The file's time in the working tree, read for import-root content only (`versionTime`). */
  readonly fileTime: string | null;
}

/** What dates the lines of one version: its commit, and for import-root content the file's time now. */
export function versionTime(repoPath: string, path: string, commit: string, commitAt: string, importRoot: boolean, firstSeen: string): VersionTime {
  return { commit, commitAt, importRoot, path, firstSeen, fileTime: importRoot ? fileTimeOf(repoPath, path) : null };
}

/**
 * When a line of a document version happened (§2.11, AC-15). A version made by an ordinary commit: the commit's author
 * time (`Commit`), with the date written in the text kept as `other` (the table of §2.11: "另记"). With `line` null, the
 * date the document states for itself (rule 4 of time.ts) is the one written in the text. Content of an import-style
 * root commit: the written date (`Written in text`) with the import commit as `other`; else the file's time in the working
 * tree (`File time`); else `Undated · first seen`.
 */
export function occurredOfLine(v: VersionTime, dates: DateContext, line: number | null): Occurred {
  const anchor = `${v.path}@${v.commit.slice(0, 10)}${line ? `:${line}` : ''}`;
  const written = line === null ? dates.document : dates.at(line);
  const commitAt = materialTime(v.commitAt) ?? v.commitAt;
  if (!v.importRoot) {
    return occurred(commitAt, 'Commit', anchor, written ? { at: written.at, basis: 'Written in text', anchor: `${v.path}:${written.line}` } : null);
  }
  const imported = { at: commitAt, basis: 'Commit' as const, anchor: `${v.commit.slice(0, 10)} (import commit)` };
  if (written) return { at: written.at, basis: 'Written in text', anchor: `${v.path}:${written.line}`, other: imported };
  if (v.fileTime) return { at: v.fileTime, basis: 'File time', anchor: v.path, other: imported };
  return { ...undated(v.firstSeen, anchor), other: imported };
}

function fileTimeOf(root: string, rel: string): string | null {
  try {
    const st = statSync(join(root, ...rel.split('/')));
    return st.isFile() ? st.mtime.toISOString() : null;
  } catch {
    return null;
  }
}

// ───────────────────────── the scan ─────────────────────────

interface Change {
  readonly hash: string; readonly status: string; readonly path: string; readonly old_path: string | null;
  readonly old_blob: string | null; readonly new_blob: string | null;
  readonly author_at: string; readonly author_ms: number; readonly parents: string; readonly import_root: number; readonly subject: string; readonly body: string;
}

/** Decide import-style root commits among the repository's root commits not decided yet (the rule above). */
function decideImportRoots(db: DatabaseSync, repo: RepoHandle, contentOf: (blob: string) => string | null): number {
  const decided = db.prepare("SELECT value FROM state WHERE key = ?").get(`importRoots:${repo.id}`) as { value: string } | undefined;
  const done = new Set<string>(decided ? (JSON.parse(decided.value) as string[]) : []);
  const roots = db.prepare("SELECT hash, author_at, subject, body FROM commits WHERE repo = ? AND parents = ''").all(repo.id) as { hash: string; author_at: string; subject: string; body: string }[];
  let n = 0;
  for (const r of roots) {
    if (done.has(r.hash)) continue;
    done.add(r.hash);
    const adds = (db.prepare("SELECT path, new_blob FROM commit_files WHERE repo = ? AND hash = ? AND status = 'A'").all(repo.id, r.hash) as { path: string; new_blob: string | null }[])
      .filter((f) => isDocumentPath(f.path) && f.new_blob);
    if (adds.length < IMPORT_MIN_DOCS) continue;
    // The author's own day (the commit time as git wrote it, with its offset).
    const day = dayOf(r.author_at) ?? '';
    const earlier = adds.some((f) => { const t = contentOf(f.new_blob!); return t !== null && fullDatesIn(t).some((d) => d < day); });
    if (earlier || IMPORT_MESSAGE.test(`${r.subject}\n${r.body}`)) {
      db.prepare('UPDATE commits SET import_root = 1 WHERE repo = ? AND hash = ?').run(repo.id, r.hash);
      n += 1;
    }
  }
  db.prepare('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)').run(`importRoots:${repo.id}`, JSON.stringify([...done]));
  return n;
}

export function scanDocs(db: DatabaseSync, repo: RepoHandle, now: string): DocScanStats {
  const changes = (db.prepare(`
    SELECT cf.hash, cf.status, cf.path, cf.old_path, cf.old_blob, cf.new_blob, c.author_at, c.author_ms, c.parents, c.import_root, c.subject, c.body
    FROM commit_files cf JOIN commits c ON c.repo = cf.repo AND c.hash = cf.hash
    WHERE cf.repo = ? AND (
      (cf.status <> 'D' AND NOT EXISTS (SELECT 1 FROM docs d WHERE d.repo = cf.repo AND d.path = cf.path AND d.commit_hash = cf.hash))
      OR (cf.status = 'D' AND NOT EXISTS (SELECT 1 FROM deleted_docs x WHERE x.repo = cf.repo AND x.path = cf.path AND x.deleted_commit = cf.hash)))
    ORDER BY c.author_ms, cf.hash`).all(repo.id) as unknown as Change[])
    .filter((ch) => isDocumentPath(ch.path));

  // Contents: what the searchable texts already hold is not read again.
  const wantedBlobs = new Set<string>();
  const have = (blob: string) => db.prepare('SELECT 1 FROM texts WHERE key = ?').get(blobTextKey(repo.id, blob)) !== undefined;
  for (const ch of changes) {
    if (ch.new_blob && ch.status !== 'D' && !have(ch.new_blob)) wantedBlobs.add(ch.new_blob);
    if (ch.old_blob && (ch.status === 'M' || ch.status === 'R' || ch.status === 'C' || ch.status === 'T') && !have(ch.old_blob)) wantedBlobs.add(ch.old_blob);
  }
  // Root commits' added documents, for the import rule, are among the new blobs already.
  const fetched = catBlobs(repo.path, [...wantedBlobs]);
  const texts = new Map<string, string | null>();
  const contentOf = (blob: string | null): string | null => {
    if (!blob) return null;
    if (texts.has(blob)) return texts.get(blob)!;
    const stored = getText(db, blobTextKey(repo.id, blob));
    if (stored !== null) { texts.set(blob, stored); return stored; }
    const buf = fetched.get(blob);
    const t = buf && buf.length <= MAX_DOC_BYTES && isText(buf) ? buf.toString('utf8') : null;
    texts.set(blob, t);
    return t;
  };

  const importRoots = tx(db, () => decideImportRoots(db, repo, contentOf));
  const isImport = new Set((db.prepare('SELECT hash FROM commits WHERE repo = ? AND import_root = 1').all(repo.id) as { hash: string }[]).map((r) => r.hash));

  const insDoc = db.prepare(`INSERT OR IGNORE INTO docs (key, repo, path, commit_hash, blob, prev_blob, prev_path, at, at_ms, change, sections, bytes, lines, import_root, added, removed, changed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insDel = db.prepare(`INSERT OR IGNORE INTO deleted_docs (key, repo, path, deleted_commit, deleted_at, deleted_ms, readable_at, blob, cleanup)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`);
  let versionsAdded = 0;
  let withoutText = 0;
  const withoutTextPaths: { path: string; commit: string; bytes: number }[] = [];
  let deleted = 0;
  const deletionsByCommit = new Map<string, number>();
  tx(db, () => {
    for (const ch of changes) {
      const at = materialTime(ch.author_at) ?? ch.author_at;
      if (ch.status === 'D') {
        const readable = ch.parents.split(' ').filter(Boolean)[0] ?? null;
        if (insDel.run(delKey(ch.path, ch.hash), repo.id, ch.path, ch.hash, at, ch.author_ms, readable, ch.old_blob).changes > 0) {
          deleted += 1;
          deletionsByCommit.set(ch.hash, (deletionsByCommit.get(ch.hash) ?? 0) + 1);
        }
        continue;
      }
      if (!ch.new_blob) continue;
      const text = contentOf(ch.new_blob);
      if (text !== null) putText(db, blobTextKey(repo.id, ch.new_blob), 'doc', repo.id, text);
      else {
        withoutText += 1;
        withoutTextPaths.push({ path: ch.path, commit: ch.hash, bytes: fetched.get(ch.new_blob)?.length ?? 0 });
      }
      const prevBlob = ch.status === 'A' ? null : ch.old_blob;
      const prevPath = ch.status === 'R' || ch.status === 'C' ? ch.old_path : ch.status === 'A' ? null : ch.path;
      const before = prevBlob ? contentOf(prevBlob) : null;
      if (prevBlob && before !== null) putText(db, blobTextKey(repo.id, prevBlob), 'doc', repo.id, before);
      const diff = text === null ? null : diffSections(before, text);
      const w = insDoc.run(docKey(ch.path, ch.hash), repo.id, ch.path, ch.hash, ch.new_blob, prevBlob, prevPath, at, ch.author_ms,
        CHANGE[ch.status] ?? 'Modified', text === null ? 0 : splitMarkdown(text).length, fetched.get(ch.new_blob)?.length ?? Buffer.byteLength(text ?? ''),
        text === null ? 0 : lineCount(text), isImport.has(ch.hash) ? 1 : 0,
        diff ? JSON.stringify(diff.added) : null, diff ? JSON.stringify(diff.removed) : null, diff ? JSON.stringify(diff.changed) : null);
      if (w.changes > 0) versionsAdded += 1;
    }
  });

  // Cleanup commits: one commit deleting at least CLEANUP_MIN_DOCS documents; the catalogue before and after.
  let cleanups = 0;
  const bigDeletions = db.prepare(`SELECT deleted_commit h, count(*) n FROM deleted_docs WHERE repo = ? GROUP BY deleted_commit HAVING n >= ?`).all(repo.id, CLEANUP_MIN_DOCS) as { h: string; n: number }[];
  for (const { h, n } of bigDeletions) {
    if (db.prepare('SELECT 1 FROM cleanups WHERE repo = ? AND commit_hash = ?').get(repo.id, h)) continue;
    const c = db.prepare('SELECT parents, author_at, author_ms FROM commits WHERE repo = ? AND hash = ?').get(repo.id, h) as { parents: string; author_at: string; author_ms: number } | undefined;
    if (!c) continue;
    const parent = c.parents.split(' ').filter(Boolean)[0] ?? null;
    const docsAt = (ref: string) => treeFiles(repo.path, ref).filter((f) => isDocumentPath(f.path)).map((f) => f.path);
    const total = (db.prepare('SELECT count(*) c FROM commit_files WHERE repo = ? AND hash = ? AND status = ?').get(repo.id, h, 'D') as { c: number }).c;
    tx(db, () => {
      db.prepare(`INSERT OR IGNORE INTO cleanups (key, repo, commit_hash, at, at_ms, deleted_docs, deleted_total, catalog_before, catalog_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(cleanupKey(h), repo.id, h, materialTime(c.author_at) ?? c.author_at, c.author_ms, n, total, JSON.stringify(parent ? docsAt(parent) : []), JSON.stringify(docsAt(h)));
      db.prepare('UPDATE deleted_docs SET cleanup = 1 WHERE repo = ? AND deleted_commit = ?').run(repo.id, h);
    });
    cleanups += 1;
  }
  void now;
  void deletionsByCommit;
  const versions = (db.prepare('SELECT count(*) c FROM docs WHERE repo = ?').get(repo.id) as { c: number }).c;
  return { versions, versionsAdded, withoutText, withoutTextPaths, deleted, cleanups, importRoots };
}

/** Where a version's text is: the ledger's own copy of its content. */
export function versionText(db: DatabaseSync, repo: string, blob: string): string | null {
  return getText(db, blobTextKey(repo, blob));
}

/** The dates written in a version's text, read once per content. */
const contexts = new Map<string, DateContext>();
export function datesOf(key: string, text: string): DateContext {
  let c = contexts.get(key);
  if (!c) {
    if (contexts.size > 2000) contexts.clear();
    c = dateContext(text);
    contexts.set(key, c);
  }
  return c;
}
