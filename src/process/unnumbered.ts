/**
 * Merged work that carries no task number (Spec v3.0 §2.12, §1.17; the owner's rule of 2026-09-28): the branches merged
 * and the direct commits whose messages carry none of the numbers the project gives its tasks, and that no process link
 * ties to a work item yet. The program lists them with what the step judges each one from — its commits and when, its
 * merges, the size of the change, what its messages name, whose files it changed, where the records name it — and the
 * step applies the owner's rule: work that changes behaviour, a contract or the architecture, or is clearly worth
 * tracking, becomes its own work item; a pure repair, a test-stability fix or a supporting fix a task needed folds into
 * that task's work and is named in its results.
 *
 * Found in test-C-1: the Claude-subagent packages — the clerk tools, the process engine, the long-output fix, the
 * cleanup, QC AY's packages — were merged into k-clerk with no number of their own, and the round made no work item for
 * any of them; they showed only inside the contracts' work.
 *
 * Numbered is what the project numbered: the process engine ties the commit to a task (units.ts), its subject opens with
 * a task number (`B0 foundation: …`), or a merge names the task where a merge names what it merges. A message that only
 * mentions a number — a fix saying which QC findings it answers (`(QC AY B3, B13)`) — does not make the work that task's;
 * the numbers it names are listed as what the work served. Commits that changed only documents and execution records
 * (the project's own records, the document chain's versions) are counted apart: the document chain has its versions in
 * the skeleton, and the records are the project's arrangements.
 */
import type { Ledger } from '../ledger/index.ts';
import type { Project, WorkThread } from '../model/types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { within } from '../codemap/facts.ts';
import { langOf } from '../ledger/code.ts';
import { definitionsInSubject } from '../ledger/numbering.ts';
import { Facts, type CommitFact } from './facts.ts';
import type { Integration } from './integration.ts';
import { clip } from './text.ts';
import { baseNumber, buildUnits, isArrangementPath, mergeNamesIn, type UnitIndex } from './units.ts';

// ───────────────────────── what a piece of work is made of ─────────────────────────

export type FileKind = 'code' | 'test' | 'config' | 'doc' | 'record';

/** Languages of programs, as the ledger names them (ledger/code.ts); markup, data and prose are not among them. */
const PROGRAM = new Set(['typescript', 'javascript', 'dart', 'python', 'java', 'kotlin', 'swift', 'go', 'rust', 'csharp', 'c', 'cpp', 'css', 'html', 'shell', 'sql']);
/** The working folders of the agents that work on a project: their settings are not the project's product. */
const AGENT_DIR = /(?:^|\/)\.(?:claude|codex|cursor|pi|gemini|kimi|zcode|windsurf|aider|continue)\//i;

/**
 * What a changed file is, by its path: the execution records (prompts, receipts, execution plans, the agents' own
 * folders), tests, documents (prose, and whatever lies under docs/, design/ or mockups/), code (a program's language, by
 * the ledger's table), or configuration (the rest: data files, build files, dotfiles).
 */
export function fileKind(path: string): FileKind {
  if (isArrangementPath(path) || AGENT_DIR.test(path)) return 'record';
  if (/(?:^|\/)(?:tests?|__tests__|spec|specs)\//i.test(path) || /[._-](?:test|spec)\.[a-z0-9]+$/i.test(path) || /_test\.[a-z0-9]+$/i.test(path)) return 'test';
  const lang = langOf(path);
  if (lang === 'markdown' || lang === 'text' || /\.(?:mdx|rst|adoc)$/i.test(path) || /(?:^|\/)(?:docs?|design|mockups?)\//i.test(path)) return 'doc';
  return lang && PROGRAM.has(lang) ? 'code' : 'config';
}
/** Code, tests and configuration are the work; documents and records are not. */
const isWork = (k: FileKind): boolean => k === 'code' || k === 'test' || k === 'config';

export interface SizePart { readonly files: number; readonly added: number; readonly deleted: number }
export interface Size extends SizePart { readonly byKind: Readonly<Partial<Record<FileKind, SizePart>>> }

export interface TiedWork {
  readonly workId: string;
  readonly label: string;
  readonly stepKind: string;
  readonly confirmed: boolean;
  /** The work item's results name the branch, its merge or one of its commits (the owner's rule: a folded fix is listed there). */
  readonly namedInResults: boolean;
}

export interface UnnumberedPiece {
  readonly repo: string;
  readonly kind: 'branch' | 'direct';
  /** The branch a merge names, or whose tip it merged; null for direct commits and for a merge that names none. */
  readonly branch: string | null;
  /** The merges that integrated it, oldest first (a branch merged several times as it went is one piece). */
  readonly merges: readonly Integration[];
  /** Its merges into another branch that only kept that branch up to date (`Merge k-clerk into k-ledger`). */
  readonly syncs: readonly Integration[];
  /** The trunk's merges that brought its merges into the trunk, when they are not the trunk's own. */
  readonly trunkMerges: readonly CommitFact[];
  /** Its own commits that carry no task number (merges left out), oldest first. */
  readonly commits: readonly CommitFact[];
  /** Commits of the same branch that do carry one, with the task. */
  readonly numbered: readonly { readonly commit: CommitFact; readonly tasks: readonly string[] }[];
  readonly files: readonly { readonly path: string; readonly kind: FileKind }[];
  readonly size: Size;
  /** The project's numbers its messages name, most named first. */
  readonly names: readonly { readonly num: string; readonly count: number }[];
  /** Work items whose numbers its messages name. */
  readonly workNamed: readonly { readonly workId: string; readonly label: string }[];
  /** Numbers its messages name that exactly one work item's own document defines (a contract's acceptance criterion). */
  readonly definedIn: readonly { readonly num: string; readonly work: string }[];
  /** Numbered work whose own commits changed the same files. */
  readonly workByFiles: readonly { readonly workId: string; readonly label: string; readonly files: number }[];
  readonly territories: readonly { readonly id: string; readonly name: string; readonly area: string | null; readonly files: number }[];
  /** Top directories of its files outside the code territories. */
  readonly dirs: readonly { readonly dir: string; readonly files: number }[];
  /** Documents that name the branch (the project's records of it: a dispatch, a receipt, a decision). */
  readonly records: readonly { readonly id: string; readonly label: string; readonly snippet: string }[];
  /** Work items a process link already ties it to. */
  readonly tied: readonly TiedWork[];
  /** Its latest commit or merge, in ms. */
  readonly lastMs: number;
  /** It changed code, tests or configuration (else only documents and execution records). */
  readonly work: boolean;
}

const short = (h: string): string => h.slice(0, 7);
const at = (c: CommitFact): string => c.occurred.at.replace('T', ' ').slice(0, 16);
const threadLabel = (t: WorkThread): string => `${t.ids[0] && !t.title.startsWith(t.ids[0]) ? `${t.ids[0]} ` : ''}${t.title}`;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The commit a link's ledger ref names (`commit:<hash>`, full or short). */
function linkedHash(ref: string, facts: Facts): string | null {
  const m = /^commit:([0-9a-f]{7,40})$/i.exec(ref.trim());
  return m ? facts.commitByPrefix(m[1]!)?.hash ?? null : null;
}

/**
 * The numbers the project gives its tasks: its work items' numbers (and the Keeper's numbers for work), what its
 * execution arrangements are about, and the rows of its execution plans and prompt index — ContextKeeper's batches B0–B9
 * were rows of its first execution plan before the two-letter numbers began.
 */
export function taskNumbers(store: ProjectStore, facts: Facts, index: UnitIndex): Set<string> {
  const out = new Set<string>([...index.units.keys()].map(baseNumber));
  for (const t of store.threads.all()) for (const n of t.ids) out.add(n);
  for (const k of store.numbers.all()) if (k.objectKind === 'work') for (const n of [k.number, k.projectNumber]) if (n) out.add(n);
  for (const a of facts.arrangements) {
    if (a.ident) out.add(a.ident);
    for (const r of a.data.rows ?? []) if (/^[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/.test(r.id.trim())) out.add(r.id.trim());
  }
  return out;
}

/** The pieces of merged work no task number claims (see the module comment), oldest first. */
export function unnumberedWork(store: ProjectStore, facts: Facts, index: UnitIndex = buildUnits(store, facts)): UnnumberedPiece[] {
  const db = facts.ledger.db;
  const integrations = index.integrations;
  const tasks = taskNumbers(store, facts, index);
  const numberedMerges = new Set([...index.units.values()].flatMap((u) => u.merges.map((m) => m.hash)));
  /** The tasks a commit carries: the process engine's, the task number its subject opens with, or the one a merge names as merged. */
  const tasksOf = (c: CommitFact): string[] => {
    const engine = index.commitUnits.get(c.hash) ?? [];
    if (engine.length) return [...engine];
    const opens = definitionsInSubject(c.subject).map((d) => d.num).filter((n) => tasks.has(n));
    if (opens.length) return opens;
    return c.merge ? mergeNamesIn(c.subject).filter((n) => tasks.has(n)) : [];
  };
  const threadByNum = new Map<string, WorkThread>();
  for (const t of store.threads.all()) for (const n of t.ids) if (!threadByNum.has(n)) threadByNum.set(n, t);
  for (const k of store.numbers.all()) { const t = k.objectKind === 'work' ? store.threads.get(k.objectId) : undefined; if (t) for (const n of [k.number, k.projectNumber]) if (n && !threadByNum.has(n)) threadByNum.set(n, t); }
  const commitFiles = db.prepare('SELECT path, added, deleted FROM commit_files WHERE repo = ? AND hash = ?');
  const filesOf = new Map<string, { path: string; added: number | null; deleted: number | null }[]>();
  const changed = (c: CommitFact) => {
    if (!filesOf.has(c.hash)) filesOf.set(c.hash, commitFiles.all(c.repo, c.hash) as { path: string; added: number | null; deleted: number | null }[]);
    return filesOf.get(c.hash)!;
  };
  /** A commit that changed only documents and execution records. */
  const recordOnly = (c: CommitFact) => changed(c).length > 0 && !changed(c).some((f) => isWork(fileKind(f.path)));

  // ── the branches: the commits each integrating merge brought in as the innermost one, by the branch it names ──
  const groups = new Map<string, { repo: string; branch: string | null; merges: Integration[]; commits: CommitFact[] }>();
  const keyOf = (m: Integration) => `${m.merge.repo}\x1f${m.source ?? `merge:${m.merge.hash}`}`;
  for (const m of integrations.merges) {
    const g = groups.get(keyOf(m)) ?? { repo: m.merge.repo, branch: m.source, merges: [], commits: [] };
    g.merges.push(m);
    groups.set(keyOf(m), g);
  }
  for (const c of facts.commits.values()) {
    if (c.merge || !c.onTrunk) continue;
    const m = integrations.innermost.get(c.hash);
    if (m) groups.get(keyOf(m))!.commits.push(c);
  }
  // A merge into a branch that is itself merged elsewhere only kept that branch up to date.
  const merged = new Set(integrations.merges.map((m) => `${m.merge.repo}\x1f${m.source ?? ''}`));
  const isSync = (m: Integration) => m.target !== null && merged.has(`${m.merge.repo}\x1f${m.target}`);

  // ── direct commits: on the trunk and brought in by no integrating merge, in runs between numbered commits and merges ──
  const runs: { repo: string; commits: CommitFact[] }[] = [];
  let recordsLeftOut = 0;
  for (const [repo, list] of facts.commitsByRepo) {
    let run: CommitFact[] = [];
    const close = () => { if (run.length) runs.push({ repo, commits: run }); run = []; };
    for (const c of list) {
      if (!c.onTrunk) continue;
      if (c.merge) { if (c.fpTrunk) close(); continue; }
      if (integrations.innermost.has(c.hash)) continue;
      if (tasksOf(c).length) { close(); continue; }
      if (recordOnly(c)) { recordsLeftOut++; continue; }
      run.push(c);
    }
    close();
  }

  // ── the ties a round already made ──
  const linksByHash = new Map<string, TiedWork[]>();
  for (const l of store.links.all()) {
    const h = linkedHash(l.ledgerRef, facts);
    const t = store.threads.get(l.workId);
    if (!h || !t) continue;
    linksByHash.set(h, [...(linksByHash.get(h) ?? []), { workId: t.id, label: threadLabel(t), stepKind: l.stepKind, confirmed: l.confirmed, namedInResults: false }]);
  }

  const numsOfCommit = db.prepare("SELECT num FROM nums WHERE kind = 'commit' AND commit_hash = ?");
  const defsOf = db.prepare("SELECT DISTINCT path FROM nums WHERE num = ? AND place = 'definition' AND kind = 'doc' AND path IS NOT NULL");
  const touching = db.prepare('SELECT DISTINCT hash FROM commit_files WHERE repo = ? AND (path = ? OR old_path = ?)');
  const territories = store.territories.all();
  const repoPath = (id: string) => facts.ledger.repos().find((r) => r.id === id)?.path;
  const areaName = (id: string | null) => (id ? store.reference.get(id)?.name ?? null : null);

  const describe = (repo: string, kind: UnnumberedPiece['kind'], branch: string | null, allMerges: Integration[], allCommits: CommitFact[]): UnnumberedPiece | null => {
    const merges = allMerges.filter((m) => !isSync(m)).sort((a, b) => a.merge.ms - b.merge.ms);
    const syncs = allMerges.filter(isSync).sort((a, b) => a.merge.ms - b.merge.ms);
    // A merge that names the task it merged makes the whole branch that task's.
    if (merges.some((m) => tasksOf(m.merge).length)) return null;
    const sorted = [...allCommits].sort((a, b) => a.ms - b.ms);
    const numbered = sorted.map((c) => ({ commit: c, tasks: tasksOf(c) })).filter((x) => x.tasks.length);
    const own = sorted.filter((c) => !tasksOf(c).length);
    if (own.length === 0) return null;
    // The size: what its merges brought into their line when they brought only this piece's commits; else the commits.
    const mine = new Set(own.map((c) => c.hash));
    const netByMerge = kind === 'branch' && merges.length > 0 && !numbered.length && !syncs.length
      && merges.every((m) => [...m.brought].every((h) => facts.commits.get(h)?.merge || mine.has(h)));
    const changes = new Map<string, { kind: FileKind; added: number; deleted: number }>();
    for (const c of netByMerge ? merges.map((m) => m.merge) : own) {
      for (const f of changed(c)) {
        const e = changes.get(f.path) ?? { kind: fileKind(f.path), added: 0, deleted: 0 };
        e.added += f.added ?? 0;
        e.deleted += f.deleted ?? 0;
        changes.set(f.path, e);
      }
    }
    const byKind: Partial<Record<FileKind, { files: number; added: number; deleted: number }>> = {};
    for (const e of changes.values()) {
      const k = (byKind[e.kind] ??= { files: 0, added: 0, deleted: 0 });
      k.files++; k.added += e.added; k.deleted += e.deleted;
    }
    const size: Size = { files: changes.size, added: [...changes.values()].reduce((n, e) => n + e.added, 0), deleted: [...changes.values()].reduce((n, e) => n + e.deleted, 0), byKind };
    const files = [...changes].map(([path, e]) => ({ path, kind: e.kind })).sort((a, b) => a.path.localeCompare(b.path));
    // What its messages name.
    const counts = new Map<string, number>();
    for (const c of [...own, ...merges.map((m) => m.merge)]) for (const r of numsOfCommit.all(c.hash) as { num: string }[]) counts.set(r.num, (counts.get(r.num) ?? 0) + 1);
    const names = [...counts].map(([num, count]) => ({ num, count })).sort((a, b) => b.count - a.count || a.num.localeCompare(b.num));
    const workNamed = [...new Map(names.flatMap((x) => { const t = threadByNum.get(x.num); return t ? [[t.id, { workId: t.id, label: threadLabel(t) }] as const] : []; })).values()];
    const definedIn = names.filter((x) => !threadByNum.has(x.num)).flatMap((x) => {
      const work = new Set<string>();
      for (const r of defsOf.all(x.num) as { path: string }[]) {
        const base = r.path.split('/').pop() ?? r.path;
        for (const [num, t] of threadByNum) if (new RegExp(`(?:^|[^A-Za-z0-9])${escapeRe(num)}(?![A-Za-z0-9])`).test(base)) work.add(threadLabel(t));
      }
      return work.size === 1 ? [{ num: x.num, work: [...work][0]! }] : [];
    });
    // Numbered work whose own commits changed the same files.
    const shared = new Map<string, { t: WorkThread; files: Set<string> }>();
    for (const f of files) {
      for (const r of touching.all(repo, f.path, f.path) as { hash: string }[]) {
        if (mine.has(r.hash)) continue;
        for (const u of index.commitUnits.get(r.hash) ?? []) {
          const tid = index.threadOf.get(u);
          const t = tid ? store.threads.get(tid) : undefined;
          if (!t) continue;
          const e = shared.get(t.id) ?? { t, files: new Set<string>() };
          e.files.add(f.path);
          shared.set(t.id, e);
        }
      }
    }
    const workByFiles = [...shared.values()].map((e) => ({ workId: e.t.id, label: threadLabel(e.t), files: e.files.size })).sort((a, b) => b.files - a.files || a.label.localeCompare(b.label));
    const ofRepo = territories.filter((t) => t.repo === repo || t.repo === repoPath(repo));
    const inTerritory = ofRepo.map((t) => ({ id: t.id, name: t.name, area: areaName(t.areaId), files: files.filter((f) => within(t.paths, f.path)).length }))
      .filter((t) => t.files > 0).sort((a, b) => b.files - a.files);
    const dirCount = new Map<string, number>();
    for (const f of files) {
      if (ofRepo.some((t) => within(t.paths, f.path))) continue;
      const parts = f.path.split('/');
      const dir = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length === 2 ? parts[0]! : '(root)';
      dirCount.set(dir, (dirCount.get(dir) ?? 0) + 1);
    }
    const dirs = [...dirCount].map(([dir, n]) => ({ dir, files: n })).sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir));
    // The records that name the branch.
    let records: UnnumberedPiece['records'] = [];
    if (branch && branch.length >= 3) {
      // The branch's own name, not a longer one it begins (`k-clerk` in `k-clerk-tools`).
      const whole = new RegExp(`(?<![\\w/.-])${escapeRe(branch)}(?![\\w-])`, 'i');
      const hits = facts.ledger.word(branch, { kinds: ['doc', 'loose'], limit: 500 });
      if (typeof hits !== 'string') records = hits.rows.filter((h) => whole.test(h.snippet)).map((h) => ({ id: h.id, label: h.label, snippet: h.snippet }));
    }
    // What already ties it to a work item — a link on one of its commits, or on a merge that brought in nothing else (a
    // link on the trunk's merge of a whole integration branch is about that landing, not this piece) — and whether that
    // work's results name it.
    const ofBranch = new Set(sorted.map((c) => c.hash));
    const ownMerges = merges.filter((m) => [...m.brought].every((h) => facts.commits.get(h)?.merge || ofBranch.has(h)));
    const tiedTo = new Set([...mine, ...ownMerges.map((m) => m.merge.hash)]);
    const tiedBy = new Map<string, TiedWork>();
    for (const h of tiedTo) for (const t of linksByHash.get(h) ?? []) if (!tiedBy.has(`${t.workId}\x1f${t.stepKind}`)) tiedBy.set(`${t.workId}\x1f${t.stepKind}`, t);
    const tied = [...tiedBy.values()].map((t) => {
      const w = store.threads.get(t.workId);
      const text = `${w?.results ?? ''}\n${w?.changed ?? ''}`;
      const named = (branch !== null && text.includes(branch)) || [...tiedTo].some((h) => new RegExp(`(?<![0-9a-f])${h.slice(0, 7)}`, 'i').test(text));
      return { ...t, namedInResults: named };
    });
    const lastMs = Math.max(...own.map((c) => c.ms), ...merges.map((m) => m.merge.ms));
    const trunkMerges = [...new Map(merges.map((m) => integrations.trunkMergeOf(m.merge.hash)).filter((t): t is CommitFact => t !== null && !merges.some((m) => m.merge.hash === t.hash)).map((t) => [t.hash, t])).values()];
    const work = files.some((f) => isWork(f.kind));
    return { repo, kind, branch, merges, syncs, trunkMerges, commits: own, numbered, files, size, names, workNamed, definedIn, workByFiles, territories: inTerritory, dirs, records, tied, lastMs, work };
  };

  const out: UnnumberedPiece[] = [];
  for (const g of groups.values()) { const p = describe(g.repo, 'branch', g.branch, g.merges, g.commits); if (p) out.push(p); }
  for (const r of runs) { const p = describe(r.repo, 'direct', null, [], r.commits); if (p) out.push(p); }
  const sorted = out.sort((a, b) => a.lastMs - b.lastMs);
  return Object.assign(sorted, { recordsLeftOut });
}

// ───────────────────────── the block a step is given ─────────────────────────

const n = (x: number): string => x.toLocaleString('en-US');
const sizeText = (s: SizePart): string => `${n(s.files)} file${s.files === 1 ? '' : 's'}, +${n(s.added)} −${n(s.deleted)}`;
const KIND_LABEL: Record<FileKind, string> = { code: 'code', test: 'tests', config: 'configuration', doc: 'documents', record: 'execution records' };

function repoLabel(ledger: Ledger, repo: string): string {
  const r = ledger.repos().find((x) => x.id === repo);
  return r ? (r.path.split(/[\\/]/).filter(Boolean).pop() ?? r.path) : repo;
}

function pieceTitle(ledger: Ledger, p: UnnumberedPiece): string {
  const where = repoLabel(ledger, p.repo);
  if (p.kind === 'direct') {
    const first = p.commits[0]!;
    const last = p.commits[p.commits.length - 1]!;
    return `direct commits on the trunk · ${where} · ${p.commits.length === 1 ? short(first.hash) : `${short(first.hash)}…${short(last.hash)}`}`;
  }
  const first = p.merges[0] ?? p.syncs[0];
  return `${p.branch ? `branch ${p.branch}` : `merge ${first ? short(first.merge.hash) : '?'} (it names no branch)`} · ${where}`;
}

/** One piece as the step reads it. */
export function pieceLines(ledger: Ledger, p: UnnumberedPiece, i: number): string[] {
  const lines: string[] = [`${i}. ${pieceTitle(ledger, p)}`];
  if (p.merges.length) lines.push(`   merged: ${p.merges.map((m) => `${short(m.merge.hash)} ${at(m.merge)} “${clip(m.merge.subject, 140)}”${m.target ? ` (into ${m.target})` : ''}`).join('; ')}`);
  if (p.trunkMerges.length) lines.push(`   reached the trunk with: ${p.trunkMerges.map((t) => `${short(t.hash)} ${at(t)} “${clip(t.subject, 120)}”`).join('; ')}`);
  if (p.syncs.length) lines.push(`   also merged into ${[...new Set(p.syncs.map((m) => m.target))].join(', ')} to keep ${p.syncs.length === 1 ? 'it' : 'them'} up to date: ${p.syncs.map((m) => short(m.merge.hash)).join(', ')}`);
  const kinds = (Object.keys(KIND_LABEL) as FileKind[]).filter((k) => p.size.byKind[k]);
  lines.push(`   size: ${sizeText(p.size)}${kinds.length > 1 ? ` (${kinds.map((k) => `${KIND_LABEL[k]} ${sizeText(p.size.byKind[k]!)}`).join(' · ')})` : kinds.length === 1 ? ` (${KIND_LABEL[kinds[0]!]})` : ''}`);
  lines.push(`   commits (${p.commits.length}, ${at(p.commits[0]!)} → ${at(p.commits[p.commits.length - 1]!)}):`);
  for (const c of p.commits) lines.push(`   - ${short(c.hash)} ${at(c)} ${clip(c.subject, 160)}`);
  if (p.numbered.length) lines.push(`   on the same branch, carrying a task number: ${p.numbered.map((x) => `${short(x.commit.hash)} (${x.tasks.join(', ')})`).join(', ')}`);
  if (p.names.length) lines.push(`   numbers its messages name: ${p.names.map((x) => `${x.num}${x.count > 1 ? ` ×${x.count}` : ''}`).join(', ')}`);
  if (p.workNamed.length) lines.push(`   work items among them: ${p.workNamed.map((w) => `${w.label} (${w.workId})`).join('; ')}`);
  if (p.definedIn.length) lines.push(`   defined in one work item's own document: ${p.definedIn.map((d) => `${d.num} → ${d.work}`).join('; ')}`);
  if (p.workByFiles.length) lines.push(`   numbered work whose own commits changed the same files: ${p.workByFiles.map((w) => `${w.label} (${w.workId}) ${w.files} file${w.files === 1 ? '' : 's'}`).join('; ')}`);
  if (p.territories.length) lines.push(`   code territories: ${p.territories.map((t) => `${t.name}${t.area ? ` (serves ${t.area})` : ''} ${t.files} file${t.files === 1 ? '' : 's'}`).join('; ')}`);
  if (p.dirs.length) lines.push(`   ${p.territories.length ? 'outside the territories' : 'directories'}: ${p.dirs.map((d) => `${d.dir} ${d.files}`).join(', ')}`);
  if (p.records.length) {
    lines.push(`   records that name ${p.branch} (${p.records.length}; the first line naming it in each):`);
    for (const r of p.records) lines.push(`   · ${r.id}: “${clip(r.snippet.replace(/\s+/g, ' ').trim(), 160)}”`);
  }
  if (p.tied.length) lines.push(`   tied by a process link to: ${p.tied.map((t) => `${t.label} (${t.workId}) as ${t.stepKind}${t.confirmed ? ', confirmed' : ''}${t.namedInResults ? '' : ' — its results do not name it yet'}`).join('; ')}`);
  return lines;
}

/** One line for a piece listed without its details (the ledger has them). */
function pieceLine(ledger: Ledger, p: UnnumberedPiece): string {
  const span = ` (${at(p.commits[0]!)} → ${at(p.commits[p.commits.length - 1]!)})`;
  const names = p.names.slice(0, 8).map((x) => x.num).join(', ');
  return `- ${pieceTitle(ledger, p)} · ${p.commits.length} commit${p.commits.length === 1 ? '' : 's'}${span} · ${sizeText(p.size)}${p.merges.length ? ` · merged ${p.merges.map((m) => short(m.merge.hash)).join(', ')}` : ''}${names ? ` · names ${names}${p.names.length > 8 ? ' …' : ''}` : ''}`;
}

export interface UnnumberedBlockOptions {
  /** A Follow up: what was merged since this time is listed in full; what was merged before and is still tied to nothing, one line each. */
  readonly since?: string | null;
  /** The ledger's facts and the units, when the caller already read them for another block of the same step. */
  readonly analysis?: (() => { readonly facts: Facts; readonly index: UnitIndex } | null) | null;
}

/**
 * The block for the skeleton (and a Follow up's cross-check): each piece of merged work with no task number, with what
 * the step judges it from. The owner's rule is in the method text; the program only lists. Work of an earlier generation
 * (merged before a generation the round recorded ended) is history: one line each, to put under its generation when it
 * matters, never as current work (D82).
 */
export function unnumberedWorkBlock(store: ProjectStore, project: Project, ledger: Ledger | null, opts: UnnumberedBlockOptions = {}): string {
  const head = "=== Work merged without a task number (the program's list from the ledger: merged branches and direct commits whose messages carry none of the project's task numbers and that no process link ties to a work item; apply the owner's rule to each)";
  if (!ledger) return `${head}\nThe ledger is not available, so no merged work was listed.`;
  void project;
  let pieces: UnnumberedPiece[] & { recordsLeftOut?: number };
  try {
    const shared = opts.analysis?.() ?? null;
    const facts = shared?.facts ?? new Facts(ledger);
    pieces = unnumberedWork(store, facts, shared?.index ?? buildUnits(store, facts));
  } catch (e) { return `${head}\nThe ledger could not be read for it: ${(e as Error).message}`; }
  const sinceMs = opts.since ? Date.parse(opts.since) || 0 : 0;
  const generations = store.generations.all().map((g) => ({ g, ms: Date.parse(g.ended.at) || 0 })).filter((x) => x.ms > 0).sort((a, b) => a.ms - b.ms);
  const generationOf = (p: UnnumberedPiece) => generations.find((x) => p.lastMs <= x.ms)?.g ?? null;
  const work = pieces.filter((p) => p.work);
  const open = work.filter((p) => !p.tied.length);
  const history = open.filter((p) => generationOf(p) !== null);
  const current = open.filter((p) => generationOf(p) === null);
  const recent = sinceMs ? current.filter((p) => p.lastMs >= sinceMs) : current;
  const earlier = sinceMs ? current.filter((p) => p.lastMs < sinceMs) : [];
  const tied = work.filter((p) => p.tied.length);
  const docsOnly = pieces.filter((p) => !p.work && !p.tied.length);
  const lines: string[] = [head];
  lines.push([
    `${work.length} piece${work.length === 1 ? '' : 's'} changed code, tests or configuration:`,
    `${recent.length} of the current generation tied to no work item${sinceMs ? `, merged since ${opts.since!.slice(0, 16).replace('T', ' ')}` : ''} (in full below)`,
    ...(earlier.length ? [`${earlier.length} merged before that and still tied to none`] : []),
    ...(history.length ? [`${history.length} of an earlier generation`] : []),
    `${tied.length} already tied to a work item by a process link.`,
    `Left out: ${docsOnly.length} merged branch${docsOnly.length === 1 ? '' : 'es'} and ${pieces.recordsLeftOut ?? 0} direct commit${pieces.recordsLeftOut === 1 ? '' : 's'} that changed only documents and execution records.`,
  ].join(' · '));
  recent.forEach((p, i) => lines.push(...pieceLines(ledger, p, i + 1)));
  if (earlier.length) {
    lines.push(`Merged before the last round and still tied to no work item (${earlier.length}; pk_ledger_commit or pk_ledger_commits for any of them in full):`);
    for (const p of earlier) lines.push(pieceLine(ledger, p));
  }
  for (const x of generations) {
    const of = history.filter((p) => generationOf(p)?.id === x.g.id);
    if (!of.length) continue;
    lines.push(`Of the earlier generation “${x.g.name}” (ended ${x.g.ended.at.slice(0, 16).replace('T', ' ')}; history — pk_ledger_commit for any of them in full) (${of.length}):`);
    for (const p of of) lines.push(pieceLine(ledger, p));
  }
  if (tied.length) {
    lines.push(`Already tied to a work item (${tied.length}):`);
    for (const p of tied) lines.push(`- ${pieceTitle(ledger, p)} → ${p.tied.map((t) => `${t.label} (${t.workId}) as ${t.stepKind}${t.namedInResults ? '' : ' — its results do not name it yet'}`).join('; ')}`);
  }
  if (docsOnly.length) {
    lines.push(`Merged branches that changed only documents and execution records (${docsOnly.length}):`);
    for (const p of docsOnly) lines.push(pieceLine(ledger, p));
  }
  if (!work.length && !docsOnly.length) lines.push('None: every merged branch and direct commit carries a task number or is tied to a work item.');
  return lines.join('\n');
}
