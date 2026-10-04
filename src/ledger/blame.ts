/**
 * Current source-line provenance. Git is read only; the cache stores ranges, never source text. Source is the code whose
 * references a reader reads (code_files.reader: the TypeScript compiler, or the code engine for every other language).
 */
import type { DatabaseSync } from 'node:sqlite';
import { ledgerGit } from './git-read.ts';
import type { RepoHandle } from './repo-scan.ts';
import { tx } from './schema.ts';

export interface BlameSegment { readonly start: number; readonly end: number; readonly commit: string }
export interface BlameScanStats { readonly scanned: number; readonly reused: number; readonly failed: number; readonly ms: number }

/** `--incremental` prints one range header per contiguous run, in arbitrary range order. */
export function parseBlame(output: string, expectedLines: number): BlameSegment[] | null {
  const segments: BlameSegment[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\^?([0-9a-f]{40}) \d+ (\d+) (\d+)$/.exec(line);
    if (!m) continue;
    const start = Number(m[2]);
    const count = Number(m[3]);
    if (start < 1 || count < 1) return null;
    segments.push({ start, end: start + count - 1, commit: m[1]! });
  }
  segments.sort((a, b) => a.start - b.start);
  let next = 1;
  for (const s of segments) { if (s.start !== next) return null; next = s.end + 1; }
  return next - 1 === expectedLines ? segments : null;
}

/** A changed content id is blamed once; unchanged files survive an incremental rebuild untouched. */
export function scanBlame(db: DatabaseSync, repo: RepoHandle, force = false): BlameScanStats {
  const started = Date.now();
  const head = (db.prepare('SELECT head FROM repos WHERE id = ?').get(repo.id) as { head: string | null } | undefined)?.head;
  const source = db.prepare('SELECT path, blob, lines FROM code_files WHERE repo = ? AND generated = 0 AND classification IS NULL AND blob IS NOT NULL AND lines IS NOT NULL AND reader IS NOT NULL')
    .all(repo.id) as { path: string; blob: string; lines: number }[];
  const existing = new Map((db.prepare('SELECT path, blob FROM code_blame WHERE repo = ?').all(repo.id) as { path: string; blob: string }[]).map((r) => [r.path, r.blob]));
  const keep = new Set(source.map((f) => f.path));
  let scanned = 0;
  let reused = 0;
  let failed = 0;
  const updates: { path: string; blob: string; lines: number; segments: BlameSegment[] }[] = [];
  if (head) for (const f of source) {
    if (!force && existing.get(f.path) === f.blob) { reused++; continue; }
    if (f.lines === 0) { updates.push({ ...f, segments: [] }); scanned++; continue; }
    const result = ledgerGit(repo.path, ['blame', '--incremental', head, '--', f.path], { timeoutMs: 180_000 });
    const segments = result.ok ? parseBlame(result.out, f.lines) : null;
    if (!segments) { failed++; continue; }
    updates.push({ ...f, segments });
    scanned++;
  }
  tx(db, () => {
    const put = db.prepare('INSERT OR REPLACE INTO code_blame (repo, path, blob, lines, segments, computed_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const u of updates) put.run(repo.id, u.path, u.blob, u.lines, JSON.stringify(u.segments), new Date().toISOString());
    const del = db.prepare('DELETE FROM code_blame WHERE repo = ? AND path = ?');
    for (const path of existing.keys()) if (!keep.has(path)) del.run(repo.id, path);
  });
  return { scanned, reused, failed, ms: Date.now() - started };
}
