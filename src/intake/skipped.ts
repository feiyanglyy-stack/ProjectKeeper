/**
 * `Skipped: too large` (Spec §1.11, §3.10, §6.7; D105; CKC-04 AC-18, CKC-07 AC-10): a file over the size intake reads
 * of one file is not read, and that is not a failure. It is recorded with its size and the limit, listed in Project
 * scope, and counted nowhere in the top bar. The owner, of an archived export page that stayed red: 「超过 2 MB 的上限
 * 这个不要红色的」.
 *
 * The reader still reports it the way it always did (`larger than N bytes`, sources/files.ts); here that report is told
 * apart from what really failed — unreadable, a broken session log, a step of a round that did not finish. A home written
 * before D105 holds such a file among its failures: every pass that writes the coverage moves it over, so it shows as
 * skipped with no step by the owner.
 */
import { statSync } from 'node:fs';
import type { CoverageScope, Project, SkippedMaterial } from '../model/types.ts';
import { isWithin } from '../util/paths.ts';

type Failure = CoverageScope['failed'][number];

const TOO_LARGE = /^larger than (\d+) bytes$/;

/** The limit a `larger than N bytes` report names, or null for any other reason. */
export function tooLargeLimit(reason: string): number | null {
  const m = TOO_LARGE.exec(reason.trim());
  return m ? Number(m[1]) : null;
}

function sizeOf(path: string): number | null {
  try { return statSync(path).size; } catch { return null; }
}

/** The locations the scope leaves out: a skipped file under one is no longer listed (the owner can exclude it, §6.7). */
export function excludedLocations(project: Project): string[] {
  return project.scope.filter((i) => i.relation === 'Excluded' && i.category !== 'Session source').map((i) => i.path);
}

/** One entry per file, the latest, in the order the kept ones came. */
function latestSkipped(list: readonly SkippedMaterial[]): SkippedMaterial[] {
  const byRef = new Map<string, SkippedMaterial>();
  for (const s of list) {
    const before = byRef.get(s.ref);
    if (before && before.at > s.at) continue;
    byRef.delete(s.ref);
    byRef.set(s.ref, s);
  }
  return [...byRef.values()];
}

/**
 * What intake could not take in, told apart: `failed` keeps what went wrong; a file too large to read goes to `skipped`
 * with its size now and the limit. `before` is what was skipped already; an entry of the same file is replaced by the
 * later one. `excluded`: locations the owner left out of the scope — a skipped file under one is no longer listed.
 */
export function splitTooLarge(failed: readonly Failure[], before: readonly SkippedMaterial[] = [], excluded: readonly string[] = []): { failed: Failure[]; skipped: SkippedMaterial[] } {
  const real: Failure[] = [];
  const moved: SkippedMaterial[] = [];
  for (const f of failed) {
    const limit = tooLargeLimit(f.reason);
    if (limit === null) real.push(f);
    else moved.push({ ref: f.ref, bytes: sizeOf(f.ref), limit, at: f.at });
  }
  const skipped = latestSkipped([...before, ...moved]).filter((s) => !excluded.some((root) => isWithin(root, s.ref)));
  return { failed: real, skipped };
}

/** Everything skipped as too large across the coverage's scopes, also what an older home still holds among its failures. */
export function skippedOf(scopes: readonly CoverageScope[]): SkippedMaterial[] {
  return latestSkipped(scopes.flatMap((s) => splitTooLarge(s.failed, s.skipped ?? []).skipped));
}

/** What really failed across the coverage's scopes: not a file too large to read. */
export function failuresOf(scopes: readonly CoverageScope[]): Failure[] {
  return scopes.flatMap((s) => s.failed.filter((f) => tooLargeLimit(f.reason) === null));
}
