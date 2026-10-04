/**
 * The line scans (Spec §1.16 rows 3–5; CKC-22 AC-4, AC-5, AC-6): explicit supersessions, numbering, verdicts. Each
 * distinct content of each document is read once; a line found there becomes one entry per document, followed through the
 * versions: the first version that has it gives its occurred time (§2.11; for import-style root content, AC-15), the last
 * version that has it and whether the current version still does are kept beside it. A document moved to a new path keeps
 * its lines' first appearance from the old path.
 *
 * Numbering runs in two passes: the definitions (numbering.ts) decide the rules; the mentions of the recognised rules are
 * then found everywhere — documents, commit messages, branch and worktree names, file names. When the rules change, the
 * mentions are found again from the start.
 */
import type { DatabaseSync } from 'node:sqlite';
import { isDocumentPath } from '../sources/history.ts';
import { blobTextKey, getState, getText, hex12, lineIdentity, redact, setState, tx } from './schema.ts';
import { datesOf, occurredOfLine, versionTime } from './docs.ts';
import { supersessionInPath, supersessionLines, isReportLike, verdictLines } from './lines.ts';
import {
  MIN_DEFINED, NUMBERING_VERSION, definitionsInBranch, definitionsInPath, definitionsInSubject, definitionsInText, familyOf, isCommonPair, keepTwoLetterGroups, mentionMatcher,
  nameMatcher, type Definition, type Rule,
} from './numbering.ts';
import { materialTime, msOf, type Occurred } from './time.ts';
import { arrangementKind } from './arrangements.ts';
import type { RepoHandle } from './repo-scan.ts';

export interface TextScanStats {
  readonly contentsRead: number;
  readonly supersessions: number;
  readonly numRules: number;
  readonly numOccurrences: number;
  readonly verdicts: number;
  readonly rulesChanged: boolean;
}

const clip = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export const supKey = (repo: string | null, source: string, where: string, ident: string): string => `sup:${hex12(repo, source, where, ident)}`;
export const verdictKey = (repo: string | null, path: string, kind: string, ident: string): string => `verdict:${hex12(repo, path, kind, ident)}`;
export const numKey = (repo: string | null, kind: string, where: string, num: string, ident: string): string => `num:${hex12(repo, kind, where, num, ident)}`;

/**
 * Documents whose lines are not read: third-party and vendored material, test fixtures and data (a Unicode table is not
 * the project speaking). Their versions are still recorded; only the line scans leave them out.
 */
export const NOT_LINE_SCANNED = /(^|\/)(third[_-]?party|thirdparty|vendor|vendored|node_modules|external|extern|fixtures?|testdata|test_data|__snapshots__|goldens?)\//i;

// ───────────────────────── pass 1: the lines of every content not read yet ─────────────────────────

function scanContentLines(db: DatabaseSync, repo: RepoHandle): number {
  const todo = db.prepare(`SELECT DISTINCT d.path, d.blob FROM docs d
    WHERE d.repo = ? AND NOT EXISTS (SELECT 1 FROM doc_scans s WHERE s.repo = d.repo AND s.path = d.path AND s.blob = d.blob AND s.what = 'lines')`).all(repo.id) as { path: string; blob: string }[];
  const insSup = db.prepare(`INSERT OR IGNORE INTO supersedes (key, repo, source, path, pattern, target, text, ident, obsolete_list, list_heading, replaced, replacement, syntax, occurred_at, occurred_basis)
    VALUES (?, ?, 'content', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'First observed')`);
  const insVerdict = db.prepare(`INSERT OR IGNORE INTO verdicts (key, repo, path, kind, verdict, confidence, text, ident, occurred_at, occurred_basis)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'First observed')`);
  const insNum = db.prepare(`INSERT OR IGNORE INTO nums (key, num, rule, kind, place, position, repo, path, line, context, ident, confidence, occurred_at, occurred_basis)
    VALUES (?, ?, ?, 'doc', 'definition', ?, ?, ?, ?, ?, ?, 'stated', '', 'First observed')`);
  const upNumPlace = db.prepare("UPDATE nums SET place = 'definition', position = ?, confidence = 'stated' WHERE key = ?");
  const insItem = db.prepare('INSERT OR IGNORE INTO doc_items (repo, path, blob, tbl, key, line) VALUES (?, ?, ?, ?, ?, ?)');
  const done = db.prepare("INSERT OR IGNORE INTO doc_scans (repo, path, blob, what) VALUES (?, ?, ?, 'lines')");
  tx(db, () => {
    for (const { path, blob } of todo) {
      const text = NOT_LINE_SCANNED.test(path) ? null : getText(db, blobTextKey(repo.id, blob));
      if (text !== null) {
        for (const s of supersessionLines(text)) {
          const ident = lineIdentity(s.text);
          const key = supKey(repo.id, 'content', path, ident);
          insSup.run(key, repo.id, path, s.pattern, s.target ? redact(s.target) : null, redact(s.text), ident, s.obsoleteList ? 1 : 0, s.listHeading,
            s.replaced ? redact(s.replaced) : null, s.replacement ? redact(s.replacement) : null, s.syntax);
          insItem.run(repo.id, path, blob, 'supersedes', key, s.line);
        }
        // A prompt is a task, not a report: its status field is the work's, not a verdict.
        if (isReportLike(path, text) && arrangementKind(path) !== 'prompt') {
          for (const v of verdictLines(text)) {
            const ident = lineIdentity(v.text);
            const key = verdictKey(repo.id, path, v.kind, ident);
            insVerdict.run(key, repo.id, path, v.kind, v.verdict, v.confidence, redact(v.text), ident);
            insItem.run(repo.id, path, blob, 'verdicts', key, v.line);
          }
        }
        for (const d of definitionsInText(text)) {
          const ident = lineIdentity(d.context);
          const key = numKey(repo.id, 'doc', path, d.num, ident);
          if (insNum.run(key, d.num, d.family, d.position, repo.id, path, d.line, redact(d.context), ident).changes === 0) upNumPlace.run(d.position, key);
          insItem.run(repo.id, path, blob, 'nums', key, d.line ?? 1);
        }
      }
      done.run(repo.id, path, blob);
    }
  });
  return todo.length;
}

// ───────────────────────── names and commit messages ─────────────────────────

export interface NameItem { readonly kind: 'file-name' | 'branch' | 'worktree' | 'commit' | 'loose'; readonly where: string; readonly def: Definition }

/** Definitions in the repository's file names (all history), branch names and commit subjects. */
function nameDefinitions(db: DatabaseSync, repo: RepoHandle): NameItem[] {
  const ordinary = (d: Definition) => !(familyOf(d.num)?.shape === 'two-letters' && isCommonPair(d.num));
  const files: (NameItem & { readonly dir: string })[] = [];
  for (const { path } of db.prepare('SELECT DISTINCT path FROM commit_files WHERE repo = ?').all(repo.id) as { path: string }[]) {
    const segs = path.split('/');
    for (const d of definitionsInPath(path)) {
      if (!ordinary(d)) continue;
      // The directory the numbered entry stands in: two letters count where several numbered entries stand together.
      const at = segs.findIndex((s) => s.replace(/^\d{4}-\d{2}-\d{2}[_-]/, '').startsWith(d.num));
      files.push({ kind: 'file-name', where: path, def: d, dir: segs.slice(0, Math.max(0, at)).join('/') });
    }
  }
  const branches: NameItem[] = [];
  for (const { name } of db.prepare('SELECT name FROM branches WHERE repo = ?').all(repo.id) as { name: string }[]) {
    for (const d of definitionsInBranch(name)) if (ordinary(d)) branches.push({ kind: 'branch', where: name, def: d });
  }
  const subjects: NameItem[] = [];
  for (const { hash, subject } of db.prepare('SELECT hash, subject FROM commits WHERE repo = ?').all(repo.id) as { hash: string; subject: string }[]) {
    for (const d of definitionsInSubject(subject)) if (ordinary(d)) subjects.push({ kind: 'commit', where: hash, def: d });
  }
  return [
    ...keepTwoLetterGroups(files.map((f) => ({ ...f, num: f.def.num })), (f) => f.dir).map(({ dir: _d, num: _n, ...f }) => f),
    ...keepTwoLetterGroups(branches.map((b) => ({ ...b, num: b.def.num })), () => 'branches').map(({ num: _n, ...b }) => b),
    ...keepTwoLetterGroups(subjects.map((s) => ({ ...s, num: s.def.num })), () => 'subjects').map(({ num: _n, ...s }) => s),
  ];
}

// ───────────────────────── the rules ─────────────────────────

/** Recompute the numbering rules over every repository's definitions; returns the rules and whether they changed. */
export function computeNumRules(db: DatabaseSync, extra: readonly NameItem[]): { rules: Rule[]; changed: boolean } {
  const defs = [
    ...(db.prepare("SELECT num, rule, path, position FROM nums WHERE place = 'definition' AND kind = 'doc'").all() as { num: string; rule: string; path: string; position: string | null }[])
      .map((r) => ({ num: r.num, family: r.rule, position: r.position ?? 'document', where: r.path })),
    ...extra.map((e) => ({ num: e.def.num, family: e.def.family, position: e.def.position as string, where: e.where })),
  ];
  const byFamily = new Map<string, { nums: Set<string>; positions: Map<string, Set<string>>; places: Map<string, number> }>();
  for (const d of defs) {
    const f = byFamily.get(d.family) ?? { nums: new Set<string>(), positions: new Map<string, Set<string>>(), places: new Map<string, number>() };
    f.nums.add(d.num);
    const pos = f.positions.get(d.position) ?? new Set<string>();
    pos.add(d.num);
    f.positions.set(d.position, pos);
    f.places.set(d.where, (f.places.get(d.where) ?? 0) + 1);
    byFamily.set(d.family, f);
  }
  const rules: Rule[] = [];
  const rows: { rule: string; shape: string; prefix: string; basis: string; examples: string; defined: number }[] = [];
  for (const [family, f] of [...byFamily].sort((a, b) => b[1].nums.size - a[1].nums.size)) {
    if (f.nums.size < MIN_DEFINED) continue;
    const t = familyOf([...f.nums][0]!);
    if (!t) continue;
    const sorted = [...f.nums].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const topPlaces = [...f.places].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w.length > 60 ? `…${w.slice(-60)}` : w} (${n})`).join(', ');
    const basis = `${f.nums.size} different numbers defined — ${[...f.positions].map(([p, s]) => `${p}: ${s.size}`).join('; ')}; most in ${topPlaces}.`;
    rules.push({ family, shape: t.shape, defined: new Set(f.nums) });
    rows.push({ rule: family, shape: t.shape, prefix: family.replace(/<n>$/, ''), basis, examples: sorted.length > 8 ? `${sorted.slice(0, 4).join(', ')} … ${sorted.slice(-3).join(', ')}` : sorted.join(', '), defined: f.nums.size });
  }
  const signature = rules.map((r) => (r.shape === 'two-letters' ? `${r.family}:${[...r.defined].sort().join(',')}` : r.family)).sort().join('|');
  const before = (db.prepare("SELECT value FROM state WHERE key = 'numRules'").get() as { value: string } | undefined)?.value ?? null;
  tx(db, () => {
    db.prepare('DELETE FROM num_rules').run();
    const ins = db.prepare('INSERT INTO num_rules (rule, shape, prefix, basis, examples, defined) VALUES (?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(r.rule, r.shape, r.prefix, r.basis, r.examples, r.defined);
    db.prepare("INSERT OR REPLACE INTO state (key, value) VALUES ('numRules', ?)").run(signature);
  });
  return { rules, changed: before !== signature };
}

/** The rules as stored (for a scan that did not recompute them). */
export function storedRules(db: DatabaseSync): Rule[] {
  const rows = db.prepare('SELECT rule, shape FROM num_rules').all() as { rule: string; shape: Rule['shape'] }[];
  const defined = new Map<string, Set<string>>();
  for (const r of db.prepare("SELECT DISTINCT num, rule FROM nums WHERE place = 'definition'").all() as { num: string; rule: string }[]) {
    const s = defined.get(r.rule) ?? new Set<string>();
    s.add(r.num);
    defined.set(r.rule, s);
  }
  return rows.map((r) => ({ family: r.rule, shape: r.shape, defined: defined.get(r.rule) ?? new Set() }));
}

// ───────────────────────── pass 2: mentions of the recognised numbers ─────────────────────────

function scanMentions(db: DatabaseSync, repo: RepoHandle, rules: readonly Rule[], names: readonly NameItem[], now: string): void {
  const match = mentionMatcher(rules);
  const ruleOf = (num: string) => familyOf(num)?.family ?? 'unknown';
  const insItem = db.prepare('INSERT OR IGNORE INTO doc_items (repo, path, blob, tbl, key, line) VALUES (?, ?, ?, ?, ?, ?)');
  const insNum = db.prepare(`INSERT OR IGNORE INTO nums (key, num, rule, kind, place, repo, path, commit_hash, line, context, ident, confidence, first_ms, occurred_at, occurred_basis, occurred_anchor, undated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // Documents: every content not read for mentions under this rule set.
  if (match) {
    const todo = db.prepare(`SELECT DISTINCT d.path, d.blob FROM docs d
      WHERE d.repo = ? AND NOT EXISTS (SELECT 1 FROM doc_scans s WHERE s.repo = d.repo AND s.path = d.path AND s.blob = d.blob AND s.what = 'mentions')`).all(repo.id) as { path: string; blob: string }[];
    const done = db.prepare("INSERT OR IGNORE INTO doc_scans (repo, path, blob, what) VALUES (?, ?, ?, 'mentions')");
    tx(db, () => {
      for (const { path, blob } of todo) {
        const text = NOT_LINE_SCANNED.test(path) ? null : getText(db, blobTextKey(repo.id, blob));
        if (text !== null) {
          for (const m of match(text)) {
            const ident = lineIdentity(m.context);
            const key = numKey(repo.id, 'doc', path, m.num, ident);
            insNum.run(key, m.num, m.family, 'doc', 'mention', repo.id, path, null, m.line, redact(m.context), ident, m.confidence, null, '', 'First observed', null, 0);
            insItem.run(repo.id, path, blob, 'nums', key, m.line);
          }
        }
        done.run(repo.id, path, blob);
      }
    });
  }
  // Commit messages not read yet: each commit is its own entry, dated by the commit.
  const commits = db.prepare('SELECT hash, author_at, author_ms, subject, body FROM commits WHERE repo = ? AND scanned = 0').all(repo.id) as { hash: string; author_at: string; author_ms: number; subject: string; body: string }[];
  const insSup = db.prepare(`INSERT OR IGNORE INTO supersedes (key, repo, source, path, pattern, target, text, ident, replaced, replacement, syntax, first_commit, first_line, first_ms, occurred_at, occurred_basis, occurred_anchor, last_commit, last_ms)
    VALUES (?, ?, 'commit', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Commit', ?, ?, ?)`);
  const defsBySubject = new Map<string, Definition[]>();
  for (const n of names) if (n.kind === 'commit') defsBySubject.set(n.where, [...(defsBySubject.get(n.where) ?? []), n.def]);
  tx(db, () => {
    for (const c of commits) {
      const at = materialTime(c.author_at) ?? c.author_at;
      const anchor = `commit ${c.hash.slice(0, 10)}`;
      const lines = `${c.subject}\n${c.body}`.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i]!.trim();
        if (!t || t.length > 1500) continue;
        for (const s of supersessionLines(t)) {
          const ident = lineIdentity(t);
          insSup.run(supKey(repo.id, 'commit', c.hash, ident), repo.id, s.pattern, s.target ? redact(s.target) : null, redact(clip(t)), ident,
            s.replaced ? redact(s.replaced) : null, s.replacement ? redact(s.replacement) : null, s.syntax, c.hash, i + 1, c.author_ms, at, anchor, c.hash, c.author_ms);
        }
      }
      const defined = new Set((defsBySubject.get(c.hash) ?? []).map((d) => d.num));
      if (match) {
        for (const m of match(`${c.subject}\n${c.body}`)) {
          const ident = lineIdentity(m.context);
          const place = m.line === 1 && defined.has(m.num) ? 'definition' : 'mention';
          insNum.run(numKey(repo.id, 'commit', c.hash, m.num, ident), m.num, m.family, 'commit', place, repo.id, null, c.hash, m.line, redact(m.context), ident,
            place === 'definition' ? 'stated' : m.confidence, c.author_ms, at, 'Commit', anchor, 0);
        }
      }
      for (const num of defined) {
        const ident = lineIdentity(c.subject);
        insNum.run(numKey(repo.id, 'commit', c.hash, num, ident), num, ruleOf(num), 'commit', 'definition', repo.id, null, c.hash, 1, redact(clip(c.subject, 200)), ident, 'stated', c.author_ms, at, 'Commit', anchor, 0);
      }
    }
    db.prepare('UPDATE commits SET scanned = 1 WHERE repo = ? AND scanned = 0').run(repo.id);
  });
  // Names: file names (all history), branches and worktrees, recomputed each time (cheap; the entry ids are stable).
  tx(db, () => {
    db.prepare("DELETE FROM nums WHERE repo = ? AND kind IN ('file-name', 'branch', 'worktree')").run(repo.id);
    db.prepare("DELETE FROM supersedes WHERE repo = ? AND source = 'filename'").run(repo.id);
    const firstTouch = new Map((db.prepare(`SELECT cf.path, min(c.author_ms) ms FROM commit_files cf JOIN commits c ON c.repo = cf.repo AND c.hash = cf.hash WHERE cf.repo = ? GROUP BY cf.path`).all(repo.id) as { path: string; ms: number }[]).map((r) => [r.path, r.ms]));
    const firstCommit = db.prepare(`SELECT c.hash, c.author_at FROM commit_files cf JOIN commits c ON c.repo = cf.repo AND c.hash = cf.hash WHERE cf.repo = ? AND cf.path = ? ORDER BY c.author_ms, c.hash LIMIT 1`);
    const inHead = new Set((db.prepare('SELECT path FROM code_files WHERE repo = ?').all(repo.id) as { path: string }[]).map((r) => r.path));
    const whenFirst = (path: string): { at: string; hash: string | null; ms: number | null } | null => {
      if (!firstTouch.has(path)) return null;
      const r = firstCommit.get(repo.id, path) as { hash: string; author_at: string } | undefined;
      return r ? { at: materialTime(r.author_at) ?? r.author_at, hash: r.hash, ms: firstTouch.get(path) ?? null } : null;
    };
    const defs = new Map<string, Set<string>>();
    for (const n of names) if (n.kind === 'file-name' || n.kind === 'branch') defs.set(`${n.kind}:${n.where}`, new Set([...(defs.get(`${n.kind}:${n.where}`) ?? []), n.def.num]));
    const put = (kind: 'file-name' | 'branch' | 'worktree', where: string, num: string, when: { at: string; hash: string | null; ms: number | null } | null, current: boolean) => {
      const place = defs.get(`${kind}:${where}`)?.has(num) ? 'definition' : 'mention';
      const occ: Occurred = when ? { at: when.at, basis: 'Commit', anchor: when.hash ? `commit ${when.hash.slice(0, 10)}` : null } : { at: now, basis: 'First observed', anchor: `${kind} ${where}`, undated: true };
      insNum.run(numKey(repo.id, kind, where, num, where), num, ruleOf(num), kind, place, repo.id, kind === 'file-name' ? where : null, when?.hash ?? null, null, where, where, 'stated',
        when?.ms ?? null, occ.at, occ.basis, occ.anchor, occ.undated ? 1 : 0);
      if (current) db.prepare('UPDATE nums SET current = 1 WHERE key = ?').run(numKey(repo.id, kind, where, num, where));
    };
    const inName = nameMatcher(rules);
    const seenDirs = new Set<string>();
    for (const path of firstTouch.keys()) {
      const nums = new Set([...(defs.get(`file-name:${path}`) ?? []), ...inName(path)]);
      for (const num of nums) put('file-name', path, num, whenFirst(path), inHead.has(path));
      const s = supersessionInPath(path);
      if (s && !seenDirs.has(s.at)) {
        seenDirs.add(s.at);
        const under = [...firstTouch.entries()].filter(([p]) => p === s.at || p.startsWith(s.at)).sort((a, b) => a[1] - b[1])[0];
        const w = under ? whenFirst(under[0]) : null;
        const ident = lineIdentity(s.at);
        db.prepare(`INSERT OR IGNORE INTO supersedes (key, repo, source, path, pattern, target, text, ident, replaced, replacement, syntax, first_commit, first_ms, occurred_at, occurred_basis, occurred_anchor, undated, current)
          VALUES (?, ?, 'filename', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(supKey(repo.id, 'filename', s.at, ident), repo.id, s.at, s.pattern, s.target, s.at, ident, s.at, s.target, 'filename', w?.hash ?? null, w?.ms ?? null, w?.at ?? now, w ? 'Commit' : 'First observed', w?.hash ? `commit ${w.hash.slice(0, 10)}` : null, w ? 0 : 1,
            [...inHead].some((p) => p === s.at || p.startsWith(s.at)) ? 1 : 0);
      }
    }
    const tipOf = db.prepare('SELECT b.tip, c.author_at, c.author_ms FROM branches b LEFT JOIN commits c ON c.repo = b.repo AND c.hash = b.tip WHERE b.repo = ? AND b.name = ?');
    for (const { name } of db.prepare('SELECT name FROM branches WHERE repo = ?').all(repo.id) as { name: string }[]) {
      const nums = new Set([...(defs.get(`branch:${name}`) ?? []), ...inName(name)]);
      const tip = tipOf.get(repo.id, name) as { tip: string; author_at: string | null; author_ms: number | null } | undefined;
      for (const num of nums) put('branch', name, num, tip?.author_at ? { at: materialTime(tip.author_at) ?? tip.author_at, hash: tip.tip, ms: tip.author_ms } : null, true);
    }
    for (const { path, branch, head } of db.prepare('SELECT path, branch, head FROM worktrees WHERE repo = ?').all(repo.id) as { path: string; branch: string | null; head: string | null }[]) {
      const base = path.split(/[\\/]/).pop() ?? path;
      const nums = new Set(inName(base));
      const h = head ? db.prepare('SELECT author_at, author_ms FROM commits WHERE repo = ? AND hash = ?').get(repo.id, head) as { author_at: string; author_ms: number } | undefined : undefined;
      for (const num of nums) put('worktree', path, num, h ? { at: materialTime(h.author_at) ?? h.author_at, hash: head, ms: h.author_ms } : null, true);
      void branch;
    }
  });
}

// ───────────────────────── when each line happened ─────────────────────────

interface ItemVersion { key: string; path: string; commit_hash: string; at: string; at_ms: number; import_root: number; change: string; prev_path: string | null; blob: string; line: number }

/**
 * First and last version, current flag and occurred time of every document line item of a repository. The first version
 * of a line in a moved document is looked up at the old path too (the same line there, found by its normal form).
 */
function timeDocItems(db: DatabaseSync, repo: RepoHandle, now: string): void {
  const rows = db.prepare(`SELECT di.key, d.path, d.commit_hash, d.at, d.at_ms, d.import_root, d.change, d.prev_path, d.blob, di.line
    FROM doc_items di JOIN docs d ON d.repo = di.repo AND d.path = di.path AND d.blob = di.blob
    WHERE di.repo = ? ORDER BY di.key, d.at_ms, d.commit_hash`).all(repo.id) as unknown as ItemVersion[];
  const current = new Map((db.prepare(`SELECT di.key, di.line FROM doc_items di JOIN code_files cf ON cf.repo = di.repo AND cf.path = di.path AND cf.blob = di.blob WHERE di.repo = ?`).all(repo.id) as { key: string; line: number }[]).map((r) => [r.key, r.line]));
  const tableOf = new Map((db.prepare('SELECT DISTINCT key, tbl FROM doc_items WHERE repo = ?').all(repo.id) as { key: string; tbl: string }[]).map((r) => [r.key, r.tbl]));
  const span = new Map<string, { first: ItemVersion; last: ItemVersion }>();
  for (const r of rows) {
    const s = span.get(r.key);
    if (!s) span.set(r.key, { first: r, last: r });
    else s.last = r;
  }
  // Moved documents: a first version that is a rename or copy inherits the old path's first appearance of the same line.
  const identOf = (tbl: string, key: string): { ident: string; extra: string } | null => {
    const r = db.prepare(`SELECT ident${tbl === 'nums' ? ', num AS extra' : tbl === 'verdicts' ? ', kind AS extra' : ", '' AS extra"} FROM ${tbl} WHERE key = ?`).get(key) as { ident: string; extra: string } | undefined;
    return r ?? null;
  };
  const keyAt = (tbl: string, path: string, id: { ident: string; extra: string }) =>
    tbl === 'supersedes' ? supKey(repo.id, 'content', path, id.ident) : tbl === 'verdicts' ? verdictKey(repo.id, path, id.extra, id.ident) : numKey(repo.id, 'doc', path, id.extra, id.ident);
  const resolveFirst = (key: string, depth = 0): ItemVersion | null => {
    const s = span.get(key);
    if (!s) return null;
    const f = s.first;
    if (depth < 8 && (f.change === 'Renamed' || f.change === 'Copied') && f.prev_path) {
      const tbl = tableOf.get(key);
      const id = tbl ? identOf(tbl, key) : null;
      if (tbl && id) {
        const older = resolveFirst(keyAt(tbl, f.prev_path, id), depth + 1);
        if (older && older.at_ms <= f.at_ms) return older;
      }
    }
    return f;
  };
  const textCache = new Map<string, string | null>();
  const textOf = (blob: string) => {
    if (!textCache.has(blob)) { if (textCache.size > 400) textCache.clear(); textCache.set(blob, getText(db, blobTextKey(repo.id, blob))); }
    return textCache.get(blob)!;
  };
  const ups: Record<string, ReturnType<DatabaseSync['prepare']>> = {};
  for (const tbl of ['supersedes', 'verdicts', 'nums']) {
    ups[tbl] = db.prepare(`UPDATE ${tbl} SET ${tbl === 'nums' ? 'commit_hash = ?, line = ?' : 'first_commit = ?, first_line = ?'}, first_ms = ?, occurred_at = ?, occurred_basis = ?, occurred_anchor = ?,
      other_at = ?, other_basis = ?, undated = ?, last_commit = ?, last_ms = ?, current = ?${tbl === 'nums' ? '' : ', current_line = ?'} WHERE key = ?`);
  }
  tx(db, () => {
    for (const [key, s] of span) {
      const tbl = tableOf.get(key);
      if (!tbl) continue;
      const first = resolveFirst(key) ?? s.first;
      const text = textOf(first.blob) ?? '';
      const importRoot = first.import_root === 1;
      const occ = occurredOfLine({
        commit: first.commit_hash, commitAt: first.at, importRoot, path: first.path, firstSeen: first.at,
        fileTime: importRoot ? fileTimeCached(repo.path, first.path) : null,
      }, datesOf(`${repo.id}:${first.blob}`, text), first.line);
      const cur = current.get(key);
      const args: (string | number | null)[] = [first.commit_hash, first.line, first.at_ms, occ.at, occ.basis, occ.anchor, occ.other?.at ?? null, occ.other?.basis ?? null, occ.undated ? 1 : 0,
        s.last.commit_hash, s.last.at_ms, cur !== undefined ? 1 : 0];
      if (tbl !== 'nums') args.push(cur ?? null);
      args.push(key);
      ups[tbl]!.run(...args);
    }
  });
  void now;
}

const fileTimes = new Map<string, string | null>();
function fileTimeCached(root: string, rel: string): string | null {
  const k = `${root}|${rel}`;
  if (!fileTimes.has(k)) fileTimes.set(k, versionTime(root, rel, '', '', true, '').fileTime);
  return fileTimes.get(k)!;
}

// ───────────────────────── one repository ─────────────────────────

/** Pass 1 for one repository (before the rules are computed over all of them). */
export function scanTextsFirstPass(db: DatabaseSync, repo: RepoHandle): { contents: number; names: NameItem[] } {
  // CZ: when the way definitions are read changes (numbering.ts NUMBERING_VERSION), the lines of every content are read
  // again once — each line keeps its entry (the inserts are by the line's own key), and the new definitions join them.
  const key = `numbering:${repo.id}`;
  if (getState(db, key) !== NUMBERING_VERSION) {
    tx(db, () => { db.prepare("DELETE FROM doc_scans WHERE repo = ? AND what = 'lines'").run(repo.id); setState(db, key, NUMBERING_VERSION); });
  }
  const contents = scanContentLines(db, repo);
  return { contents, names: nameDefinitions(db, repo) };
}

/** Pass 2 for one repository, once the rules are known: mentions, then the timing of every line item. */
export function scanTextsSecondPass(db: DatabaseSync, repo: RepoHandle, rules: readonly Rule[], rulesChanged: boolean, names: readonly NameItem[], now: string): void {
  if (rulesChanged) {
    tx(db, () => {
      db.prepare("DELETE FROM doc_items WHERE repo = ? AND tbl = 'nums' AND key IN (SELECT key FROM nums WHERE repo = ? AND place = 'mention' AND kind = 'doc')").run(repo.id, repo.id);
      db.prepare("DELETE FROM nums WHERE repo = ? AND place = 'mention'").run(repo.id);
      db.prepare("DELETE FROM nums WHERE repo = ? AND kind = 'commit'").run(repo.id);
      db.prepare("DELETE FROM doc_scans WHERE repo = ? AND what = 'mentions'").run(repo.id);
      db.prepare("DELETE FROM supersedes WHERE repo = ? AND source = 'commit'").run(repo.id);
      db.prepare('UPDATE commits SET scanned = 0 WHERE repo = ?').run(repo.id);
    });
  }
  scanMentions(db, repo, rules, names, now);
  timeDocItems(db, repo, now);
}

export function textStats(db: DatabaseSync, repo: string, contents: number, rulesChanged: boolean): TextScanStats {
  const c = (sql: string) => (db.prepare(sql).get(repo) as { c: number }).c;
  return {
    contentsRead: contents,
    supersessions: c('SELECT count(*) c FROM supersedes WHERE repo = ?'),
    numRules: (db.prepare('SELECT count(*) c FROM num_rules').get() as { c: number }).c,
    numOccurrences: c('SELECT count(*) c FROM nums WHERE repo = ?'),
    verdicts: c('SELECT count(*) c FROM verdicts WHERE repo = ?'),
    rulesChanged,
  };
}

// ───────────────────────── material outside version control ─────────────────────────

/**
 * A document outside version control (Spec §3.7, AC-15): its lines are dated by the date written in the text, else by
 * the file's own time (`File time`, a weak basis). A changed file's rows are replaced; the entry ids stay the same for
 * the same lines.
 */
export function scanLooseDocument(db: DatabaseSync, path: string, text: string, fileTime: string, rules: readonly Rule[]): void {
  const dates = datesOf(`loose:${path}:${fileTime}`, text);
  const occ = (line: number | null): Occurred => {
    const w = line === null ? dates.document : dates.at(line);
    return w ? { at: w.at, basis: 'Written in text', anchor: `${path}:${w.line}`, other: { at: fileTime, basis: 'File time', anchor: path } } : { at: fileTime, basis: 'File time', anchor: path };
  };
  const put = (tbl: string, sql: string, args: (string | number | null)[]) => { void tbl; db.prepare(sql).run(...args); };
  db.prepare("DELETE FROM supersedes WHERE repo IS NULL AND source = 'loose' AND path = ?").run(path);
  db.prepare("DELETE FROM verdicts WHERE repo IS NULL AND path = ?").run(path);
  db.prepare("DELETE FROM nums WHERE repo IS NULL AND kind = 'loose' AND path = ?").run(path);
  for (const s of supersessionLines(text)) {
    const o = occ(s.line);
    const ident = lineIdentity(s.text);
    put('supersedes', `INSERT OR IGNORE INTO supersedes (key, repo, source, path, pattern, target, text, ident, obsolete_list, list_heading, replaced, replacement, syntax, first_line, first_ms, occurred_at, occurred_basis, occurred_anchor, other_at, other_basis, current, current_line)
      VALUES (?, NULL, 'loose', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [supKey(null, 'loose', path, ident), path, s.pattern, s.target ? redact(s.target) : null, redact(s.text), ident, s.obsoleteList ? 1 : 0, s.listHeading,
        s.replaced ? redact(s.replaced) : null, s.replacement ? redact(s.replacement) : null, s.syntax, s.line, msOf(o.at), o.at, o.basis, o.anchor, o.other?.at ?? null, o.other?.basis ?? null, s.line]);
  }
  if (isReportLike(path.split('\\').join('/'), text) && arrangementKind(path) !== 'prompt') {
    for (const v of verdictLines(text)) {
      const o = occ(v.line);
      const ident = lineIdentity(v.text);
      put('verdicts', `INSERT OR IGNORE INTO verdicts (key, repo, path, kind, verdict, confidence, text, ident, first_line, first_ms, occurred_at, occurred_basis, occurred_anchor, other_at, other_basis, current, current_line)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [verdictKey(null, path, v.kind, ident), path, v.kind, v.verdict, v.confidence, redact(v.text), ident, v.line, msOf(o.at), o.at, o.basis, o.anchor, o.other?.at ?? null, o.other?.basis ?? null, v.line]);
    }
  }
  const defs = definitionsInText(text);
  const defined = new Set(defs.map((d) => `${d.num}:${d.line}`));
  const match = mentionMatcher(rules);
  const all = [...defs.map((d) => ({ num: d.num, family: d.family, line: d.line ?? 1, context: d.context, confidence: 'stated' as const })), ...(match ? match(text) : [])];
  for (const m of all) {
    const o = occ(m.line);
    const ident = lineIdentity(m.context);
    put('nums', `INSERT OR IGNORE INTO nums (key, num, rule, kind, place, repo, path, line, context, ident, confidence, first_ms, occurred_at, occurred_basis, occurred_anchor, other_at, other_basis, current)
      VALUES (?, ?, ?, 'loose', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [numKey(null, 'loose', path, m.num, ident), m.num, m.family, defined.has(`${m.num}:${m.line}`) ? 'definition' : 'mention', path, m.line, redact(m.context), ident, m.confidence, msOf(o.at), o.at, o.basis, o.anchor, o.other?.at ?? null, o.other?.basis ?? null]);
  }
}

export { isDocumentPath };
