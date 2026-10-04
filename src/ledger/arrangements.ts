/**
 * Execution arrangements (Spec §1.16 row 6; CKC-22 AC-7): what the orchestrator wrote down — the prompt index, each
 * prompt's front matter, the execution plans, the run status files, the receipts — read into batches, dependencies,
 * parallel candidates, what is running, the agent and worktree bound to a piece of work, and its baseline commit. Every
 * committed version is read, so the history of a status field is kept; a file whose structure the program cannot read
 * is recorded with `parsed: false`, meaning "read it whole and judge" (交判断读).
 *
 * Which files are arrangements, by the conventions of a `subagent/` folder:
 *   …/subagent/INDEX.md                        index   (its tables: one row per work id)
 *   …/subagent/<ID>-….md                        prompt  (front matter: id, executor, status, worktree, baseline …)
 *   …/execution-plan*.md, …/subagent/*plan*.md  plan
 *   …/subagent/runs/<run>/status.json           status  (a headless run: agent, model, worktree, base commit, result)
 *   …/subagent/reports/….md, *-report*.md, 回执  receipt
 */
import type { DatabaseSync } from 'node:sqlite';
import { blobTextKey, getText, planKey, redact, tx } from './schema.ts';
import { catBlobs, isText } from './git-read.ts';
import { datesOf, occurredOfLine } from './docs.ts';
import { familyOf } from './numbering.ts';
import { materialTime, msOf, type Occurred } from './time.ts';
import type { RepoHandle } from './repo-scan.ts';

export type ArrangementKind = 'index' | 'prompt' | 'plan' | 'status' | 'receipt';

export function arrangementKind(path: string): ArrangementKind | null {
  const p = path.split('\\').join('/');
  const base = p.split('/').pop() ?? '';
  if (/^execution-plan[^/]*\.md$/i.test(base)) return 'plan';
  const m = /(?:^|\/)subagents?\/(.+)$/i.exec(p);
  if (!m) return null;
  const rest = m[1]!;
  if (/^INDEX\.md$/i.test(rest)) return 'index';
  if (/(?:^|\/)runs\/[^/]+\/status\.json$/i.test(rest)) return 'status';
  if (/(?:^|\/)reports?\/[^/]+\.md$/i.test(rest) || /-report[^/]*\.md$/i.test(base) || /回执/.test(base)) return 'receipt';
  if (/^[^/]*plan[^/]*\.md$/i.test(rest)) return 'plan';
  if (/^(?:[A-Z]{1,6}-[A-Z]?\d{1,4}|[A-Z]\d{1,4}|[A-Z]{2})[-_][^/]*\.md$/.test(rest)) return 'prompt';
  return null;
}

/** The work id a file is about: its front-matter id, else its name's (or its run directory's) number prefix. */
export function identOf(path: string, fields: Record<string, string> | null): string | null {
  if (fields?.id && familyOf(fields.id.trim())) return fields.id.trim();
  const segs = path.split('/');
  for (let i = segs.length - 1; i >= 0; i--) {
    const m = /^(?:\d{4}-\d{2}-\d{2}[_-])?([A-Z]{1,6}-[A-Z]?\d{1,4}|[A-Z]\d{1,4}|[A-Z]{2})(?=[-_.]|$)/.exec(segs[i]!);
    if (m && familyOf(m[1]!)) return m[1]!;
  }
  return null;
}

/** A small YAML-front-matter subset: `key: value` lines between `---` fences; quotes around a value are taken off. */
export function frontMatter(text: string): Record<string, string> | null {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    out[kv[1]!] = kv[2]!.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return Object.keys(out).length ? out : null;
}

export interface ArrangementData {
  readonly title?: string;
  readonly fields?: Record<string, string>;
  readonly status?: string | null;
  readonly running?: boolean;
  readonly agent?: string | null;
  readonly model?: string | null;
  readonly worktree?: string | null;
  readonly baseline?: string | null;
  readonly accepted?: string | null;
  /** Table rows keyed by their first column (an index, a plan's order table): the row's cells by column header. */
  readonly rows?: readonly { readonly id: string; readonly cells: Readonly<Record<string, string>>; readonly line: number }[];
  readonly batches?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly parallel?: readonly string[];
  readonly json?: Readonly<Record<string, unknown>>;
  /**
   * How many table rows and batch, dependency and parallel lines the file has beyond what is kept (`MAX_ROWS`,
   * `MAX_LINES`): the list goes on and says by how much, instead of stopping without a word (QC AY, CKC-22 AC-7). The
   * whole file is still read by `pk_ledger_doc_text` / `read`.
   */
  readonly omitted?: Readonly<Partial<Record<'rows' | 'batches' | 'dependencies' | 'parallel', number>>>;
}

const clip = (s: string, n = 240): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const HASH = /\b[0-9a-f]{7,40}\b/;
const RUNNING = /^(running|in[ _-]?progress|dispatched|started|queued|进行中|正在跑|执行中)$/i;
/** Table rows kept per arrangement file; batch, dependency and parallel lines kept of each. The rest are counted. */
export const MAX_ROWS = 600;
export const MAX_LINES = 60;

/** One Markdown table as written: its header cells and each data row's cells, unclipped, with 1-based line numbers. */
export interface MarkdownTable {
  /** The header row's line. */
  readonly line: number;
  /** The header cells, trimmed, with `*` and backticks taken out; an empty header cell is `col<n>`. */
  readonly header: readonly string[];
  readonly rows: readonly { readonly cells: readonly string[]; readonly line: number }[];
}

/**
 * The tables of a Markdown text as written (D99 fill-in tools, ledger arrangements): a header row, its separator row,
 * then the data rows that follow; cells are trimmed and otherwise untouched.
 */
export function markdownTables(text: string): MarkdownTable[] {
  const lines = text.split(/\r?\n/);
  const out: MarkdownTable[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i]!) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]!)) continue;
    const header = lines[i]!.split('|').slice(1, -1).map((c, k) => c.trim().replace(/[*`]/g, '') || `col${k + 1}`);
    const rows: { cells: string[]; line: number }[] = [];
    let j = i + 2;
    for (; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]!); j++) rows.push({ cells: lines[j]!.split('|').slice(1, -1).map((c) => c.trim()), line: j + 1 });
    out.push({ line: i + 1, header, rows });
    i = j - 1;
  }
  return out;
}

/** Tables of a Markdown text: each data row keyed by its first cell, cells named by the header row; `more` counts the rows past the cap. */
export function tables(text: string): { rows: { id: string; cells: Record<string, string>; line: number }[]; more: number } {
  const out: { id: string; cells: Record<string, string>; line: number }[] = [];
  let more = 0;
  for (const table of markdownTables(text)) {
    for (const row of table.rows) {
      const id = (row.cells[0] ?? '').replace(/[*`[\]]/g, '').replace(/\(.*\)$/, '').trim();
      if (!id) continue;
      if (out.length >= MAX_ROWS) { more += 1; continue; }
      const named: Record<string, string> = {};
      table.header.forEach((h, k) => { named[h] = clip(row.cells[k] ?? '', 300); });
      out.push({ id: clip(id, 80), cells: named, line: row.line });
    }
  }
  return { rows: out, more };
}

export function parseArrangement(kind: ArrangementKind, text: string): { parsed: boolean; data: ArrangementData } {
  if (kind === 'status') {
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const pre = (json.preflight ?? {}) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);
      const keep: Record<string, unknown> = {};
      for (const k of ['status', 'agent', 'mode', 'model', 'effort', 'worktree', 'started_at', 'finished_at', 'exit_code', 'reason', 'head_after', 'new_commits', 'prompt', 'report', 'timeout_seconds']) if (json[k] !== undefined) keep[k] = json[k];
      if (pre.base_commit !== undefined) keep.base_commit = pre.base_commit;
      const status = str(json.status);
      return {
        parsed: true,
        data: {
          status, running: status !== null && RUNNING.test(status), agent: str(json.agent), model: str(json.model), worktree: str(json.worktree),
          baseline: str(pre.base_commit) ?? str(json.base_commit), accepted: null, json: keep,
        },
      };
    } catch {
      return { parsed: false, data: {} };
    }
  }
  const fields = frontMatter(text);
  const title = /^\s{0,3}#\s+(.+)$/m.exec(text)?.[1]?.trim();
  const table = kind === 'index' || kind === 'plan' ? tables(text) : { rows: [], more: 0 };
  const rows = table.rows;
  const lines = text.split(/\r?\n/);
  const batches: string[] = [];
  const dependencies: string[] = [];
  const parallel: string[] = [];
  const omitted: { rows?: number; batches?: number; dependencies?: number; parallel?: number } = {};
  if (table.more) omitted.rows = table.more;
  const keep = (list: string[], which: 'batches' | 'dependencies' | 'parallel', l: string) => {
    if (list.length < MAX_LINES) list.push(clip(l));
    else omitted[which] = (omitted[which] ?? 0) + 1;
  };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l || l.length > 600) continue;
    if (/批次\s*\d|第\s*\d+\s*批|batch\s*\d|^#{1,6}\s.*(批次|batch|阶段|phase)/i.test(l)) keep(batches, 'batches', l);
    if (/依赖|depends on|blocked by|等.{0,10}完成|需要先|before it|after\s+[A-Z]{2}\b|upstream|blocks:/i.test(l)) keep(dependencies, 'dependencies', l);
    if (/并行|可并行|同时|parallel|in parallel|concurrently/i.test(l)) keep(parallel, 'parallel', l);
  }
  const f = fields ?? {};
  const pick = (...keys: string[]) => { for (const k of keys) if (f[k]) return f[k]!; return null; };
  const status = pick('status', 'state');
  const worktree = pick('worktree', 'worktree_path');
  const baseline = pick('base_commit', 'baseline_commit', 'baseline', 'base');
  const structured = Boolean(fields) || rows.length > 0 || (kind === 'receipt' && Boolean(title));
  return {
    parsed: structured,
    data: {
      ...(title ? { title: clip(title, 200) } : {}),
      ...(fields ? { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, clip(redact(v), 400)])) } : {}),
      status, running: status !== null && RUNNING.test(status.split(/[\s(（]/)[0] ?? ''),
      agent: pick('executor', 'agent', 'worker'), model: pick('requested_model', 'model', 'signed_model'),
      worktree, baseline: baseline && HASH.test(baseline) ? HASH.exec(baseline)![0] : baseline, accepted: pick('accepted_commit', 'merged', 'merge_commit'),
      ...(rows.length ? { rows } : {}),
      ...(batches.length ? { batches } : {}), ...(dependencies.length ? { dependencies } : {}), ...(parallel.length ? { parallel } : {}),
      ...(Object.keys(omitted).length ? { omitted } : {}),
    },
  };
}

/** The parsed fields as stored: credential values redacted (the markers keep the JSON valid; a value is never kept whole). */
function storedData(data: ArrangementData): string {
  const red = redact(JSON.stringify(data));
  try { JSON.parse(red); return red; } catch { return JSON.stringify({ title: data.title ?? null, status: data.status ?? null, note: 'fields left out: they held a credential' }); }
}

export interface ArrangementScanStats { readonly files: number; readonly versions: number; readonly versionsAdded: number; readonly unparsed: number }

/** Parse every committed version of every arrangement file not read yet; mark the versions the checkout has now. */
export function scanArrangements(db: DatabaseSync, repo: RepoHandle, now: string): ArrangementScanStats {
  const wanted = (db.prepare(`
    SELECT cf.hash, cf.path, cf.new_blob, c.author_at, c.author_ms, c.import_root FROM commit_files cf JOIN commits c ON c.repo = cf.repo AND c.hash = cf.hash
    WHERE cf.repo = ? AND cf.status <> 'D' AND cf.new_blob IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM plans p WHERE p.repo = cf.repo AND p.path = cf.path AND p.commit_hash = cf.hash)
    ORDER BY c.author_ms, cf.hash`).all(repo.id) as { hash: string; path: string; new_blob: string; author_at: string; author_ms: number; import_root: number }[])
    .filter((r) => arrangementKind(r.path) !== null);
  const missingText = wanted.filter((w) => getText(db, blobTextKey(repo.id, w.new_blob)) === null).map((w) => w.new_blob);
  const fetched = catBlobs(repo.path, missingText);
  const ins = db.prepare(`INSERT OR IGNORE INTO plans (key, repo, path, commit_hash, blob, kind, ident, parsed, data, occurred_at, occurred_ms, occurred_basis, occurred_anchor, other_at, other_basis, undated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let added = 0;
  tx(db, () => {
    for (const w of wanted) {
      const stored = getText(db, blobTextKey(repo.id, w.new_blob));
      const buf = stored === null ? fetched.get(w.new_blob) : null;
      const text = stored ?? (buf && isText(buf) ? buf.toString('utf8') : null);
      const kind = arrangementKind(w.path)!;
      const { parsed, data } = text === null ? { parsed: false, data: {} as ArrangementData } : parseArrangement(kind, text);
      const occ: Occurred = text === null
        ? { at: materialTime(w.author_at) ?? w.author_at, basis: 'Commit', anchor: `${w.path}@${w.hash.slice(0, 10)}` }
        : occurredOfLine({ commit: w.hash, commitAt: w.author_at, importRoot: w.import_root === 1, path: w.path, firstSeen: w.author_at, fileTime: null }, datesOf(`${repo.id}:${w.new_blob}`, text), null);
      const id = identOf(w.path, data.fields ?? null);
      if (ins.run(planKey(w.path, w.hash), repo.id, w.path, w.hash, w.new_blob, kind, id, parsed ? 1 : 0, storedData(data), occ.at, msOf(occ.at), occ.basis, occ.anchor,
        occ.other?.at ?? null, occ.other?.basis ?? null, occ.undated ? 1 : 0).changes > 0) added += 1;
    }
    db.prepare('UPDATE plans SET current = 0 WHERE repo = ?').run(repo.id);
    db.prepare('UPDATE plans SET current = 1 WHERE repo = ? AND EXISTS (SELECT 1 FROM code_files cf WHERE cf.repo = plans.repo AND cf.path = plans.path AND cf.blob = plans.blob)').run(repo.id);
  });
  void now;
  const totals = db.prepare('SELECT count(DISTINCT path) f, count(*) v, sum(parsed = 0) u FROM plans WHERE repo = ?').get(repo.id) as { f: number; v: number; u: number | null };
  return { files: totals.f, versions: totals.v, versionsAdded: added, unparsed: totals.u ?? 0 };
}

/** An arrangement file outside version control, or one not committed yet: dated by its written date, else its file time. */
export function scanLooseArrangement(db: DatabaseSync, path: string, rel: string, text: string, fileTime: string): void {
  const kind = arrangementKind(rel);
  if (!kind) return;
  const { parsed, data } = parseArrangement(kind, text);
  const w = datesOf(`loose:${path}:${fileTime}`, text).document;
  const occ: Occurred = w ? { at: w.at, basis: 'Written in text', anchor: `${path}:${w.line}`, other: { at: fileTime, basis: 'File time', anchor: path } } : { at: fileTime, basis: 'File time', anchor: path };
  db.prepare('DELETE FROM plans WHERE repo IS NULL AND path = ?').run(path);
  db.prepare(`INSERT INTO plans (key, repo, path, commit_hash, blob, kind, ident, parsed, data, current, occurred_at, occurred_ms, occurred_basis, occurred_anchor, other_at, other_basis, undated)
    VALUES (?, NULL, ?, NULL, NULL, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0)`)
    .run(planKey(path, null), path, kind, identOf(rel, data.fields ?? null), parsed ? 1 : 0, storedData(data), occ.at, msOf(occ.at), occ.basis, occ.anchor, occ.other?.at ?? null, occ.other?.basis ?? null);
}
