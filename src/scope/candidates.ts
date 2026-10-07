/**
 * Candidates for third-party material and generated output that nobody ignored (Spec §1.1; CKC-04 AC-13, AC-17): the
 * program offers them with what shows it — a usual build-output or dependency name, a cache tag, a license of its own, a
 * link to somewhere outside the project — and the Keeper judges them (`pk_classify_scope`); the owner can correct it.
 * Until the Keeper has judged, a candidate is treated as what it looks like, so a build cache is not organized and a
 * library's release plan is not taken for the project's plan while the judgement is pending.
 */
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { git } from '../util/git.ts';
import { canonicalPath, isWithin, nameForm, normalizePath, relativeDisplay } from '../util/paths.ts';
import { LICENSE_FILE, NEVER_WALKED, classifyName } from './skip.ts';

export interface Candidate {
  readonly path: string;
  readonly relation: 'Generated' | 'Third-party material';
  readonly kind: string;
  readonly evidence: readonly string[];
}

export interface CandidateWalk {
  /** The project's locations: a link that leads outside all of them brings in outside material. */
  readonly locations: readonly string[];
  /** Relative-path predicate from the project's ignore rules (null without version control): ignored content is listed apart. */
  readonly ignored: ((rel: string) => boolean) | null;
  /** Directories handled on their own (registered worktrees, nested repositories): not entered. */
  readonly separate: readonly string[];
  /** Whether git tracks files under `root`, to say how many of a candidate's files are tracked. */
  readonly git: boolean;
}

/** A directory's entries, each under the name names are kept in (`nameForm`): the listing of a Mac may give another Unicode form than git does. */
const read = (dir: string): Dirent[] => { try { return readdirSync(dir, { withFileTypes: true }).map((e) => { e.name = nameForm(e.name); return e; }); } catch { return []; } };
const squash = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

export function licenseIn(dir: string, entries: readonly Dirent[] = read(dir)): string | null {
  return entries.find((e) => e.isFile() && LICENSE_FILE.test(e.name))?.name ?? null;
}
const licenseText = (dir: string, name: string | null) => { if (!name) return null; try { return squash(readFileSync(join(dir, name), 'utf8').slice(0, 20_000)); } catch { return null; } };

function tracked(root: string, rel: string): number | null {
  const r = git(root, ['ls-files', '-z', '--', rel.split('\\').join('/')], 30_000);
  return r.ok ? r.out.split('\0').filter(Boolean).length : null;
}

/** Walk `root` for candidates. A candidate is not entered; neither are ignored directories, links, or directories handled on their own. */
export function findCandidates(root: string, walk: CandidateWalk): Candidate[] {
  const out: Candidate[] = [];
  const own = licenseText(root, licenseIn(root));
  const inProject = (p: string) => walk.locations.some((l) => isWithin(l, p));
  const trackedNote = (full: string) => {
    if (!walk.git) return [];
    const n = tracked(root, relativeDisplay(root, full));
    return n === null ? [] : [n === 0 ? 'none of its files are tracked in git' : `${n} of its files are tracked in git`];
  };
  const visit = (dir: string, depth: number) => {
    if (depth > 40) return;
    for (const e of read(dir)) {
      if (NEVER_WALKED.has(e.name.toLowerCase())) continue;
      const full = normalizePath(join(dir, e.name));
      const rel = relativeDisplay(root, full);
      if (walk.ignored?.(rel)) continue;
      if (walk.separate.some((s) => isWithin(s, full))) continue;
      if (e.isSymbolicLink()) {
        // Never followed. A directory linked in from outside the project is outside material; one inside is read where it lives.
        let target: string | null = null;
        try { if (statSync(full).isDirectory()) target = canonicalPath(full); } catch { target = null; }
        if (target && !inProject(target)) out.push({ path: full, relation: 'Third-party material', kind: 'linked in', evidence: [`${e.name} is a link to ${target}, outside the project`] });
        continue;
      }
      if (!e.isDirectory()) continue;
      const byName = classifyName(e.name);
      if (byName) { out.push({ path: full, relation: byName.relation, kind: byName.kind, evidence: [byName.evidence, ...trackedNote(full)] }); continue; }
      const entries = read(full);
      if (entries.some((x) => x.isFile() && x.name === 'CACHEDIR.TAG')) { out.push({ path: full, relation: 'Generated', kind: 'cache', evidence: ['CACHEDIR.TAG marks it as a cache directory', ...trackedNote(full)] }); continue; }
      const license = licenseIn(full, entries);
      if (license && (own === null || licenseText(full, license) !== own)) {
        out.push({ path: full, relation: 'Third-party material', kind: 'license of its own', evidence: [`its own license file ${rel}/${license}${own === null ? '' : ', different from the project’s'}`, ...trackedNote(full)] });
        continue;
      }
      visit(full, depth + 1);
    }
  };
  if (existsSync(root)) visit(root, 0);
  return out;
}
