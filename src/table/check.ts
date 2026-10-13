/**
 * `pk check`: the program's side of the ProjectKeeper table (template/FILLING-IN.md, "What the program checks"). Two
 * layers, both hard: the shape against template/projectkeeper.schema.json, then the facts — ids, references, the rules
 * that tie a status to its fields, and every source against the project as it stood at the table's `asOf` commits.
 * Nothing here judges what an entry says or where it was put; that is the filler's (D107). Read-only throughout.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Schema from 'typebox/schema';
import { git, gitShow } from '../util/git.ts';

export interface TableProblem {
  /** Where in the table: a JSON pointer such as /work/3/sources/0. */
  readonly at: string;
  readonly problem: string;
}

/** One message of the session material: the source a `session` entry can cite. */
export interface SessionMessage {
  readonly session: string;
  readonly message: number;
  readonly text: string;
}

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_FILE = resolve(here, '..', '..', 'template', 'projectkeeper.schema.json');

type Json = Record<string, unknown>;
export type TableSource = { file?: string; lines?: string; quote?: string; commit?: string; repo?: string; session?: string; message?: number };
/** A repository of the table's `asOf`: its folder relative to the project (normalised), the commit, and its folder on disk. */
export type Repo = { path: string; commit: string; dir: string };

/** Whitespace does not decide whether a quote stands in its source: line breaks and runs of spaces read as one space. */
const an = (word: string): string => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Every list of the table that holds entries with ids, and the singular name its entries go by in messages. */
const LISTS: readonly (readonly [string, string])[] = [
  ['ownerWants', 'owner want'], ['goals', 'goal'], ['areas', 'area'], ['requirements', 'requirement'], ['designs', 'design'],
  ['decisions', 'decision'], ['plans', 'plan'], ['work', 'work item'], ['code', 'territory'], ['notes', 'note'],
];
const INTENT_LISTS = ['requirements', 'designs', 'decisions'];

export function checkShape(table: unknown): TableProblem[] {
  const schema = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'));
  const [ok, errors] = Schema.Errors(schema, table);
  if (ok) return [];
  return errors.map((e) => ({ at: e.instancePath || '/', problem: e.message ?? 'does not match the schema' }));
}

/**
 * The facts. `projectDir` is the project folder the table's paths are relative to; `sessions` is the session material,
 * needed only when the table cites a session.
 */
export function checkFacts(table: Json, projectDir: string, sessions: readonly SessionMessage[] | null): TableProblem[] {
  const problems: TableProblem[] = [];
  const add = (at: string, problem: string) => problems.push({ at, problem });

  // ── ids: one namespace for the whole table ──
  const kindOf = new Map<string, string>();
  const product = table.product as Json;
  if (product?.id) kindOf.set(String(product.id), 'product');
  for (const [list, kind] of LISTS) {
    ((table[list] as Json[]) ?? []).forEach((entry, i) => {
      const id = String(entry.id);
      if (kindOf.has(id)) add(`/${list}/${i}/id`, `the id "${id}" is already used by ${an(kindOf.get(id)!)}`);
      else kindOf.set(id, list === 'decisions' && entry.boundary ? 'decision' : kind);
    });
  }
  const refTo = (at: string, id: unknown, kinds: readonly string[]) => {
    if (typeof id !== 'string') return;
    const kind = kindOf.get(id);
    if (!kind) add(at, `"${id}" is not an id in this table`);
    else if (!kinds.includes(kind)) add(at, `"${id}" is ${an(kind)}; this needs ${kinds.map(an).join(' or ')}`);
  };
  const ANY_PROJECT = ['product', 'goal', 'area', 'requirement', 'design', 'decision', 'plan', 'work item', 'territory'];
  const INTENT = ['requirement', 'design', 'decision'];

  // ── references and the rules that tie a status to its fields ──
  const statusRules = (at: string, e: Json, sameKinds: readonly string[]) => {
    if (e.replacedBy !== undefined) refTo(`${at}/replacedBy`, e.replacedBy, sameKinds);
    if (e.status === 'Replaced' && e.replacedBy === undefined) add(`${at}`, 'it is Replaced, so replacedBy must name what took its place');
    if ((e.status === 'Abandoned' || e.status === 'Deferred') && e.why === undefined) add(`${at}`, `it is ${e.status}, so why must say what happened`);
    if (e.replacedBy !== undefined && e.replacedBy === e.id) add(`${at}/replacedBy`, 'an entry cannot replace itself');
  };
  ((table.ownerWants as Json[]) ?? []).forEach((w, i) => {
    const at = `/ownerWants/${i}`;
    if (w.replacedBy !== undefined) refTo(`${at}/replacedBy`, w.replacedBy, ['owner want']);
    if (w.status === 'Replaced' && w.replacedBy === undefined) add(at, 'it is Replaced, so replacedBy must name the want that holds now');
    ((w.reflectedIn as unknown[]) ?? []).forEach((id, j) => refTo(`${at}/reflectedIn/${j}`, id, ANY_PROJECT));
  });
  ((table.goals as Json[]) ?? []).forEach((g, i) => statusRules(`/goals/${i}`, g, ['goal']));
  ((table.areas as Json[]) ?? []).forEach((a, i) => {
    statusRules(`/areas/${i}`, a, ['area']);
    ((a.goals as unknown[]) ?? []).forEach((id, j) => refTo(`/areas/${i}/goals/${j}`, id, ['goal']));
  });
  for (const list of INTENT_LISTS) {
    ((table[list] as Json[]) ?? []).forEach((e, i) => {
      const at = `/${list}/${i}`;
      statusRules(at, e, INTENT);
      const place = (e.place ?? {}) as Json;
      if (place.area !== undefined) refTo(`${at}/place/area`, place.area, ['area']);
      ((place.areas as unknown[]) ?? []).forEach((id, j) => refTo(`${at}/place/areas/${j}`, id, ['area']));
      if (place.plan !== undefined) refTo(`${at}/place/plan`, place.plan, ['plan']);
      ((e.partlyReplaced as Json[]) ?? []).forEach((p, j) => {
        refTo(`${at}/partlyReplaced/${j}/by`, p.by, INTENT);
        if (p.by === e.id) add(`${at}/partlyReplaced/${j}/by`, 'an entry cannot replace part of itself');
      });
      if (e.partlyReplaced !== undefined && e.status === 'Replaced') add(at, 'it is Replaced as a whole, so partlyReplaced does not apply');
    });
  }
  const plans = new Map(((table.plans as Json[]) ?? []).map((p) => [String(p.id), p]));
  ((table.plans as Json[]) ?? []).forEach((p, i) => statusRules(`/plans/${i}`, p, ['plan']));
  ((table.work as Json[]) ?? []).forEach((w, i) => {
    const at = `/work/${i}`;
    statusRules(at, w, ['work item']);
    refTo(`${at}/plan`, w.plan, ['plan']);
    if (w.area !== undefined) refTo(`${at}/area`, w.area, ['area']);
    ((w.alsoAreas as unknown[]) ?? []).forEach((id, j) => refTo(`${at}/alsoAreas/${j}`, id, ['area']));
    ((w.implements as unknown[]) ?? []).forEach((id, j) => refTo(`${at}/implements/${j}`, id, INTENT));
    ((w.dependsOn as unknown[]) ?? []).forEach((id, j) => refTo(`${at}/dependsOn/${j}`, id, ['work item']));
    const became = (w.became ?? null) as Json | null;
    if (became?.carriedOnBy !== undefined) refTo(`${at}/became/carriedOnBy`, became.carriedOnBy, ['work item']);
    if (became?.movedTo !== undefined) refTo(`${at}/became/movedTo`, became.movedTo, ['plan']);
    if (plans.get(String(w.plan))?.status === 'Replaced' && !became) add(at, `its plan ${String(w.plan)} is Replaced, so became must say what became of it`);
  });
  ((table.code as Json[]) ?? []).forEach((t, i) => {
    refTo(`/code/${i}/area`, t.area, ['area']);
    ((t.alsoAreas as unknown[]) ?? []).forEach((id, j) => refTo(`/code/${i}/alsoAreas/${j}`, id, ['area']));
  });
  ((table.notes as Json[]) ?? []).forEach((n, i) => {
    ((n.on as unknown[]) ?? []).forEach((id, j) => refTo(`/notes/${i}/on/${j}`, id, [...ANY_PROJECT, 'owner want']));
  });

  // ── sources, against the project at its asOf commits ──
  const repos = resolveRepos(table, projectDir, add);
  const sessionIndex = sessions ? new Map(sessions.map((m) => [`${m.session}#${m.message}`, m.text])) : null;
  const fileCache = new Map<string, string | null>();
  const checkSource = (at: string, s: TableSource) => {
    if (s.file !== undefined) {
      const text = fileAt(s.file, repos, projectDir, fileCache);
      if (text === null) { add(at, `the file ${s.file} is not in the project at its asOf commit`); return; }
      let cited = text;
      if (s.lines !== undefined) {
        const [from, to = from] = s.lines.split('-').map(Number) as [number, number?];
        const all = text.split(/\r?\n/);
        if (from < 1 || to < from || to > all.length) { add(at, `lines ${s.lines} are outside ${s.file}, which has ${all.length} lines`); return; }
        cited = all.slice(from - 1, to).join('\n');
      }
      if (s.quote !== undefined && !squash(cited).includes(squash(s.quote))) add(`${at}/quote`, `the quote does not stand word for word in ${s.file}${s.lines ? ` lines ${s.lines}` : ''}`);
    } else if (s.commit !== undefined) {
      const repo = repos.find((r) => normal(r.path) === normal(s.repo ?? '.'));
      const dir = repo?.dir ?? join(projectDir, s.repo ?? '.');
      if (!git(dir, ['cat-file', '-e', `${s.commit}^{commit}`]).ok) add(at, `the commit ${s.commit} is not in ${s.repo ?? 'the project repository'}`);
    } else if (s.session !== undefined) {
      if (!sessionIndex) { unchecked++; return; }
      const text = sessionIndex.get(`${s.session}#${s.message}`);
      if (text === undefined) { add(at, `message ${s.message} of ${s.session} is not in the session material`); return; }
      if (s.quote !== undefined && !squash(text).includes(squash(s.quote))) add(`${at}/quote`, `the quote does not stand word for word in message ${s.message} of ${s.session}`);
    }
  };
  let unchecked = 0;
  walkSources(table, '', checkSource);
  if (unchecked) add('/', `the table cites sessions ${unchecked} time${unchecked === 1 ? '' : 's'}; check it with the session material (--sessions <file>)`);

  // ── code paths ──
  ((table.code as Json[]) ?? []).forEach((t, i) => {
    ((t.paths as string[]) ?? []).forEach((p, j) => {
      if (!pathAt(p, repos, projectDir)) add(`/code/${i}/paths/${j}`, `${p} is not in the project at its asOf commit`);
    });
  });
  return problems;
}

/** Check a table file: the shape first, and the facts only when the shape holds. */
export function checkTableFile(tableFile: string, options: { projectDir?: string; sessions?: readonly SessionMessage[] | null } = {}): TableProblem[] {
  let table: unknown;
  try { table = JSON.parse(readFileSync(tableFile, 'utf8')); } catch (e) { return [{ at: '/', problem: `not readable as JSON: ${(e as Error).message}` }]; }
  const shape = checkShape(table);
  if (shape.length) return shape;
  const projectDir = options.projectDir ?? resolve(dirname(tableFile), '..');
  return checkFacts(table as Json, projectDir, options.sessions ?? null);
}

/** The session material as `pk` writes it: one JSON object per line with session, message and text. */
export function readSessionMaterial(file: string): SessionMessage[] {
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as SessionMessage);
}

// ───────────────────────── helpers ─────────────────────────

const normal = (p: string): string => p.split('\\').join('/').replace(/^\.\/?/, '').replace(/\/$/, '');

export function resolveRepos(table: Json, projectDir: string, add: (at: string, problem: string) => void): Repo[] {
  const header = table.project as Json;
  const listed = ((header?.asOf as Json)?.repos as { path: string; commit: string }[]) ?? [];
  const repos: Repo[] = [];
  listed.forEach((r, i) => {
    const dir = resolve(projectDir, r.path);
    if (!existsSync(dir)) { add(`/project/asOf/repos/${i}/path`, `${r.path} is not a folder of the project`); return; }
    if (!git(dir, ['cat-file', '-e', `${r.commit}^{commit}`]).ok) { add(`/project/asOf/repos/${i}/commit`, `the commit ${r.commit} is not in ${r.path}`); return; }
    repos.push({ path: normal(r.path), commit: r.commit, dir });
  });
  // The deepest repository holding a path is the one it belongs to.
  return repos.sort((a, b) => b.path.length - a.path.length);
}

export function owningRepo(path: string, repos: readonly Repo[]): { repo: Repo; inner: string } | null {
  const p = normal(path);
  for (const repo of repos) {
    if (repo.path === '') return { repo, inner: p };
    if (p === repo.path || p.startsWith(`${repo.path}/`)) return { repo, inner: p.slice(repo.path.length + 1) };
  }
  return null;
}

/** A file's text at its repository's asOf commit; a file no repository tracks is read from the folder as it is. */
export function fileAt(path: string, repos: readonly Repo[], projectDir: string, cache: Map<string, string | null>): string | null {
  const key = normal(path);
  if (cache.has(key)) return cache.get(key)!;
  let text: string | null = null;
  const owner = owningRepo(path, repos);
  if (owner) text = gitShow(owner.repo.dir, owner.repo.commit, owner.inner);
  if (text === null) {
    const full = resolve(projectDir, key);
    if (inside(projectDir, full) && existsSync(full) && statSync(full).isFile()) text = readFileSync(full, 'utf8');
  }
  cache.set(key, text);
  return text;
}

/** Whether a file or a folder is there at its repository's asOf commit (or, untracked, in the folder). */
function pathAt(path: string, repos: readonly Repo[], projectDir: string): boolean {
  const owner = owningRepo(path, repos);
  if (owner && git(owner.repo.dir, ['cat-file', '-e', `${owner.repo.commit}:${owner.inner || '.'}`]).ok) return true;
  const full = resolve(projectDir, normal(path));
  return inside(projectDir, full) && existsSync(full);
}

function inside(root: string, full: string): boolean {
  const rel = relative(resolve(root), full);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`) && !/^[A-Za-z]:/.test(rel));
}

/** Every source anywhere in the table, with its pointer: `sources`, `said`, `source`, `accepted`. */
export function walkSources(node: unknown, at: string, visit: (at: string, s: TableSource) => void): void {
  if (Array.isArray(node)) { node.forEach((v, i) => walkSources(v, `${at}/${i}`, visit)); return; }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === 'sources' || key === 'said') (value as TableSource[]).forEach((s, i) => visit(`${at}/${key}/${i}`, s));
    else if (key === 'source' || key === 'accepted') visit(`${at}/${key}`, value as TableSource);
    else walkSources(value, `${at}/${key}`, visit);
  }
}
