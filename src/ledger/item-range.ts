import type { DatabaseSync } from 'node:sqlite';

export interface LineRange { readonly from: number; readonly to: number }

/** A source may point at a whole chapter or table. An object's own definition gives its actual row or entry span. */
export function itemRanges(db: DatabaseSync, repo: string | null, path: string, ids: readonly string[], source: LineRange): LineRange[] {
  if (ids.length === 0) return [source];
  const defs = db.prepare(`SELECT num, line, position FROM nums WHERE repo IS ? AND path = ? AND kind IN ('doc','loose')
    AND place = 'definition' AND current = 1 AND line BETWEEN ? AND ? ORDER BY line`).all(repo, path, source.from, source.to) as { num: string; line: number; position: string | null }[];
  const own = defs.filter((d) => ids.includes(d.num));
  if (own.length === 0) return [source];
  return own.map((d) => {
    const next = defs.find((x) => x.line > d.line);
    return { from: d.line, to: d.position?.includes('table') ? d.line : Math.min(source.to, (next?.line ?? source.to + 1) - 1) };
  });
}
