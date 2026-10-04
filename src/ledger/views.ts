/**
 * The workbench's increment K views built from the ledger (src/model/views-k.ts; Spec §6.3 versions, §6.4 `How it got
 * here`, §6.7 coverage, §6.17 `Code`). The ledger gives the facts — versions, dated steps, sizes, dependencies, tests,
 * last changes, merges; the assets give what was judged — which document an object is, the semantic patches, the
 * send-backs, the code territories and their anomalies. What neither has is left empty rather than invented.
 */
import type { ProjectStore } from '../store/project-store.ts';
import type { Project, Source } from '../model/types.ts';
import type { CodeTerritory, EvidenceRef, Occurred } from '../model/k-types.ts';
import type {
  CodeFileView, CodeView, DocCurrentView, LineageStepKind, LineageStepView, LineageView, ScopeKView, TerritoryDetailView, TerritoryView, VersionView, VersionsView,
} from '../model/views-k.ts';
import { isWithin, normalizePath, pathKey } from '../util/paths.ts';
import { dayOf, materialTime, msOf, undated } from './time.ts';
import type { Ledger, ProvenanceStep } from './index.ts';
import { CodeMapIndex, codeLevels } from '../codemap/facts.ts';
import { replacedNumbers } from './lines.ts';
import { splitMarkdown } from '../sources/files.ts';
import { itemRanges } from './item-range.ts';

// ───────────────────────── which material an object is ─────────────────────────

interface Anchors { readonly paths: { repo: string; path: string }[]; readonly nums: string[]; readonly commits: string[] }

/** The object behind an id: a reference item, a work item, or a graph node pointing at one of them. */
function objectOf(store: ProjectStore, objectId: string): { kind: 'reference' | 'thread' | 'node'; ids: readonly string[]; sourceIds: readonly string[]; name: string } | null {
  const ref = store.reference.get(objectId);
  if (ref) return { kind: 'reference', ids: ref.ids, sourceIds: ref.sourceIds, name: ref.name };
  const thread = store.threads.get(objectId);
  if (thread) {
    const facts = thread.factRecordIds.flatMap((f) => store.facts.get(f)?.aboutSourceIds ?? []);
    return { kind: 'thread', ids: thread.ids, sourceIds: [...facts, ...thread.executionFacts.flatMap((s) => s.sourceIds), ...thread.qcFacts.flatMap((s) => s.sourceIds)], name: thread.title };
  }
  const node = store.nodes.get(objectId);
  if (node) {
    if (node.refKind === 'reference' || node.refKind === 'thread') {
      const inner = objectOf(store, node.refId);
      if (inner) return { ...inner, sourceIds: [...inner.sourceIds, ...node.sourceIds] };
    }
    return { kind: 'node', ids: [], sourceIds: node.sourceIds, name: node.label };
  }
  return null;
}

/** Repository-relative paths, numbers and commits an object's sources point at, by the repositories of the ledger. */
function anchorsOf(ledger: Ledger, store: ProjectStore, objectId: string): Anchors | null {
  const o = objectOf(store, objectId);
  if (!o) return null;
  const repos = ledger.repos();
  const paths: { repo: string; path: string }[] = [];
  const commits: string[] = [];
  const add = (repo: string, path: string) => { if (!paths.some((p) => p.repo === repo && p.path === path)) paths.push({ repo, path }); };
  for (const id of o.sourceIds) {
    const s: Source | undefined = store.sources.get(id);
    if (!s) continue;
    const a = s.anchor;
    if (a.kind === 'file') {
      const repo = repos.filter((r) => isWithin(r.path, a.path)).sort((x, y) => y.path.length - x.path.length)[0];
      if (repo) add(repo.id, normalizePath(a.path).slice(normalizePath(repo.path).length + 1).split('\\').join('/'));
    } else if (a.kind === 'revision') {
      const repo = repos.find((r) => pathKey(r.path) === pathKey(a.repo));
      if (repo) add(repo.id, a.path);
    } else if (a.kind === 'commit') commits.push(a.commit);
  }
  return { paths, nums: [...o.ids], commits };
}

/** The document an object mainly is: the path most of its sources are in. */
function mainPath(anchors: Anchors, store: ProjectStore, objectId: string): { repo: string; path: string } | null {
  if (anchors.paths.length === 0) return null;
  const o = objectOf(store, objectId);
  const count = new Map<string, number>();
  for (const id of o?.sourceIds ?? []) {
    const a = store.sources.get(id)?.anchor;
    const p = a?.kind === 'file' ? a.path : a?.kind === 'revision' ? a.path : null;
    if (!p) continue;
    const hit = anchors.paths.find((x) => normalizePath(p).split('\\').join('/').endsWith(x.path));
    if (hit) count.set(`${hit.repo}\x1f${hit.path}`, (count.get(`${hit.repo}\x1f${hit.path}`) ?? 0) + 1);
  }
  const best = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? `${anchors.paths[0]!.repo}\x1f${anchors.paths[0]!.path}`;
  const [repo, path] = best.split('\x1f') as [string, string];
  return { repo, path };
}

/** The project's own label for a version (`v3.0` in its title or first lines), else its short commit. */
function versionLabel(ledger: Ledger, id: string, commit: string): string {
  const e = ledger.resolve(id);
  const head = (e?.text ?? '').split(/\r?\n/).slice(0, 8).join('\n');
  const m = /(?:^|[\s(（【·*])[vV](\d+(?:\.\d+)+)(?![\d.])/.exec(head);
  return m ? `v${m[1]}` : commit.slice(0, 7);
}

const ev = (id: string, label: string, occurred: Occurred, line: string | null = null): EvidenceRef => ({ kind: 'ledger', id, label, line, occurred });

// ───────────────────────── versions and the current one ─────────────────────────

export function versionsView(ledger: Ledger, store: ProjectStore, objectId: string): VersionsView | null {
  const anchors = anchorsOf(ledger, store, objectId);
  if (!anchors) return null;
  const main = mainPath(anchors, store, objectId);
  if (!main) return { objectId, versions: [], historyFrom: null, document: null };
  const v = ledger.docVersions(main.path, { repo: main.repo });
  if (typeof v === 'string') return { objectId, versions: [], historyFrom: historyFrom(ledger, main.repo), document: main.path };
  const patches = store.patches.filter((p) => p.status !== 'Rejected');
  const versions: VersionView[] = v.versions.map((ver, i) => {
    const next = v.versions[i + 1];
    const verMs = msOf(ver.occurred.at) ?? 0;
    // A semantic patch withdrew (part of) this version when it names this version, or a line this version has, or the
    // document itself, and was made after this version and before the next one replaced it.
    const patch = patches.find((p) => [p.oldAnchor, p.candidate].some((a) => {
      if (!a) return false;
      if (a.id === ver.id) return true;
      if (a.kind === 'ledger' && a.id.startsWith('sup:')) {
        const s = ledger.resolve(a.id);
        return Boolean(s && s.label.startsWith(`${ver.path}:`) && (msOf(s.occurred.at) ?? 0) <= verMs);
      }
      return a.kind === 'file' && a.id === ver.path && (msOf(p.occurred.at) ?? 0) >= verMs && (!next || (msOf(p.occurred.at) ?? 0) < (msOf(next.occurred.at) ?? Infinity));
    }));
    return {
      label: versionLabel(ledger, ver.id, ver.commit), commit: ver.commit, occurred: ver.occurred,
      sections: ver.diff ? { added: ver.diff.added, removed: ver.diff.removed, changed: ver.diff.changed } : { added: [], removed: [], changed: [] },
      supersededBy: patch ? { patchId: patch.id, number: patch.number, title: patch.title, partial: patch.partial } : null,
      current: ver.current, history: !ver.current,
    };
  });
  return { objectId, versions, historyFrom: historyFrom(ledger, main.repo), document: main.path };
}

/** The day a repository's document version history starts, when content before it is not versioned (AC-15); else null. */
function historyFrom(ledger: Ledger, repo: string): string | null {
  return ledger.historyStart(repo);
}

export function docCurrentView(ledger: Ledger, store: ProjectStore, objectId: string): DocCurrentView | null {
  const anchors = anchorsOf(ledger, store, objectId);
  if (!anchors) return null;
  const main = mainPath(anchors, store, objectId);
  if (!main) return null;
  const v = ledger.docVersions(main.path, { repo: main.repo });
  if (typeof v === 'string') return null;
  const cur = [...v.versions].reverse().find((x) => x.current) ?? null;
  return {
    objectId, versions: v.versions.length, historyFrom: historyFrom(ledger, main.repo),
    current: cur ? `${versionLabel(ledger, cur.id, cur.commit)}${versionLabel(ledger, cur.id, cur.commit).startsWith('v') ? ` · ${cur.commit.slice(0, 7)}` : ''} · ${dayOf(cur.occurred.at)}` : null,
  };
}

// ───────────────────────── How it got here ─────────────────────────

const STEP_KIND: Record<ProvenanceStep['kind'], LineageStepKind | null> = {
  'first appeared': 'First appeared', changed: 'Changed', deleted: 'Changed', 'says superseded': 'Replaced', 'obsolete-list row': 'Replaced',
  'named in plan': 'Planned', arrangement: 'Work', commit: 'Commit', merged: 'Merged', verdict: 'Verdict', mentioned: null, 'owner said': null, now: 'Now',
};

export function lineageView(ledger: Ledger, store: ProjectStore, objectId: string): LineageView | null {
  const anchors = anchorsOf(ledger, store, objectId);
  if (!anchors) return null;
  const main = mainPath(anchors, store, objectId);
  const sourceIds = objectOf(store, objectId)?.sourceIds ?? [];
  const wholeFile = anchors.nums.length === 0 && sourceIds.some((id) => {
    const a = store.sources.get(id)?.anchor;
    return a?.kind === 'file' && a.headingPath.length === 0;
  });
  // Two traces, kept apart (owner 2026-09-30: a decision's popover read the history of DECISIONS.md — its 15 versions,
  // the patch that archived a whole generation — as the decision's own): the object's own (its numbers, its commits)
  // and the document it sits in (the document's versions, commits, where it stands now). An object that is the whole
  // document owns the document's trace.
  const docPaths = main ? [main.path] : anchors.paths.map((p) => p.path).slice(0, 3);
  const ownProv = ledger.provenance({ nums: anchors.nums, commits: anchors.commits.slice(0, 10), repo: main?.repo }).steps;
  const ownKeys = new Set(ownProv.map((s) => `${s.kind}|${s.entry}`));
  const docAbout = wholeFile ? 'object' as const : 'document' as const;
  const traced = [
    ...ledger.provenance({ paths: docPaths, repo: main?.repo }).steps.filter((s) => !ownKeys.has(`${s.kind}|${s.entry}`)).map((s) => ({ s, about: docAbout })),
    ...ownProv.map((s) => ({ s, about: 'object' as const })),
  ].sort((a, b) => (msOf(a.s.occurred.at) ?? 0) - (msOf(b.s.occurred.at) ?? 0) || Number(a.s.kind === 'now') - Number(b.s.kind === 'now'));
  const steps: LineageStepView[] = [];
  const earliest = traced.find(({ s }) => s.kind !== 'now')?.s;
  for (const { s, about } of traced) {
    if (s.kind === 'says superseded' || s.kind === 'obsolete-list row') continue;
    let kind = STEP_KIND[s.kind];
    if (s.kind === 'owner said' && s === earliest) kind = 'First appeared';
    if (!kind) continue;
    steps.push({ kind, occurred: s.occurred, title: s.title, evidence: s.entry ? [ev(s.entry, s.title, s.occurred)] : [], history: s.history, about });
  }
  const ranges = sourceIds.flatMap((id) => {
    const a = store.sources.get(id)?.anchor;
    if (a?.kind !== 'file' || !main || !normalizePath(a.path).split('\\').join('/').endsWith(main.path)) return [];
    return a.lineStart > 0 && a.lineEnd >= a.lineStart ? itemRanges(ledger.db, main.repo, main.path, anchors.nums, { from: a.lineStart, to: a.lineEnd }) : [];
  });
  if (ranges.length === 0 && main) {
    const row = ledger.db.prepare("SELECT t.content FROM code_files f JOIN texts t ON t.key = 'blob:' || f.repo || ':' || f.blob WHERE f.repo = ? AND f.path = ? LIMIT 1").get(main.repo, main.path) as { content: string } | undefined;
    if (row) {
      const sections = splitMarkdown(row.content);
      for (const id of sourceIds) {
        const a = store.sources.get(id)?.anchor;
        if (a?.kind !== 'file' || a.headingPath.length === 0) continue;
        for (const section of sections) if (a.headingPath.join('\x1f') === section.headingPath.join('\x1f'))
          ranges.push({ from: section.lineStart, to: section.lineEnd });
      }
    }
  }
  const ownNumbers = new Set(anchors.nums);
  const seenSupersessions = new Set<string>();
  for (const row of ledger.db.prepare("SELECT key, repo, source, path, replaced, replacement, pattern, syntax, text, first_line, current_line, current, first_commit FROM supersedes").all() as Record<string, unknown>[]) {
    const id = String(row.key);
    if (seenSupersessions.has(id)) continue;
    const path = String(row.path ?? '');
    const line = Number(row.current_line ?? row.first_line ?? 0);
    const ownPath = !!main && String(row.repo ?? '') === main.repo && path === main.path;
    const withinRange = ownPath && (wholeFile || ranges.some((r) => line >= r.from && line <= r.to));
    const oldNumbers = replacedNumbers(typeof row.replaced === 'string' ? row.replaced : null);
    const explicitlyOld = (!main || String(row.repo ?? '') === main.repo) && oldNumbers.some((n) => ownNumbers.has(n));
    if (!withinRange && !explicitlyOld) continue;
    seenSupersessions.add(id);
    const resolved = ledger.resolve(id);
    if (!resolved) continue;
    const where = row.source === 'commit' ? `commit ${String(row.first_commit ?? '').slice(0, 10)}` : `${path}${line ? `:${line}` : ''}`;
    const title = `${where} reads (${String(row.syntax ?? row.pattern)}): ${String(row.text).slice(0, 160)}`;
    const kind = explicitlyOld ? 'Replaced' : 'Replaces';
    steps.push({ kind, occurred: resolved.occurred, title, evidence: [ev(id, title, resolved.occurred)], history: Number(row.current) !== 1, about: 'object' });
  }
  // What the assets judged: the semantic patches that withdrew it or that it made, the send-backs aimed at it.
  for (const p of store.patches.filter((x) => x.status !== 'Rejected')) {
    const own = p.affects.includes(objectId);
    const affects = own || (anchors.nums.length === 0 && [p.oldAnchor, p.newAnchor, p.decision].some((a) => a && main && (a.id === main.path || a.id.startsWith(`doc:${main.path}@`))));
    if (!affects) continue;
    steps.push({ kind: 'Replaced', occurred: p.occurred, title: `${p.number} ${p.title}: ${p.invalidated} → ${p.replacedBy}`, evidence: [p.candidate, ...(p.decision ? [p.decision] : [])], history: false, about: own ? 'object' : docAbout });
  }
  for (const sb of store.sendbacks.filter((x) => x.targetId === objectId)) {
    steps.push({ kind: 'Send-back', occurred: sb.occurred, title: `Send-back to ${sb.to} (${sb.stage}): ${sb.what}`, evidence: sb.evidence, history: sb.stage === 'Closed', about: 'object' });
  }
  steps.sort((a, b) => (msOf(a.occurred.at) ?? 0) - (msOf(b.occurred.at) ?? 0) || Number(a.kind === 'Now') - Number(b.kind === 'Now'));
  return { objectId, steps, document: main?.path ?? null };
}

// ───────────────────────── Project scope: what the ledger covers ─────────────────────────

export function coverageView(ledger: Ledger): NonNullable<ScopeKView['ledger']> {
  const c = ledger.coverage();
  // How deep each language of the code is read, as `Code` says it (codemap `codeLevels`): the same data, not a second rule.
  const read = new Map(codeLevels(c.languages).map((l) => [l.language, l]));
  const missing = [
    ...c.sessions.missing.map((m) => ({ host: m.host, from: m.from, to: m.to, why: m.why })),
    ...(c.sessions.daysWithCommitsButNoSession ?? []).map((g) => ({ host: 'all hosts', from: g.from, to: g.to, why: `${g.commitDays} day${g.commitDays === 1 ? '' : 's'} with commits on the trunk and no readable session` })),
  ];
  return {
    repos: c.repos.map((r) => ({ repo: r.path, commits: r.commits, trunkCommits: r.trunkCommits, branches: r.branches, merges: r.merges, from: r.from, to: r.to, historyFrom: r.importRoots.length ? r.historyFrom : null })),
    // Every language the project has, each with how far the ledger goes in it, measured (D98); a file tree only is said as
    // such (QC AY). A language of the code carries what `Code` says of it.
    languages: c.languages.map((l) => { const code = read.get(l.language); return { language: l.language, level: l.referenceLevel, files: l.files, ...(code ? { code } : {}) }; }),
    sessions: { read: c.sessions.sessions, hosts: c.sessions.hosts.map((h) => h.host), missing },
    unversionedDocs: c.outsideVersionControl.documents,
    lastRebuild: c.lastRebuild ? { at: c.lastRebuild.at, ms: c.lastRebuild.ms } : null,
    notRead: notReadOf(c),
  };
}

/** What the ledger keeps without reading it, for Project scope to say (QC AY): null when it read everything. */
function notReadOf(c: ReturnType<Ledger['coverage']>): NonNullable<NonNullable<ScopeKView['ledger']>['notRead']> | null {
  const noText = c.repos.flatMap((r) => (r.documentsWithoutText ? [r.documentsWithoutText] : []));
  const loose = c.outsideVersionControl.notRead;
  if (!noText.length && !loose) return null;
  const paths = noText.flatMap((n) => n.paths);
  return {
    versionsWithoutText: noText.reduce((n, x) => n + x.versions, 0),
    paths: paths.slice(0, 20),
    morePaths: Math.max(0, paths.length - 20) + noText.reduce((n, x) => n + x.morePaths, 0),
    reports: noText.flatMap((n) => n.reports),
    unversionedTooLarge: loose?.files ?? 0,
    unversionedPaths: loose?.paths ?? [],
    effect: 'The ledger keeps these without their text: the superseded lines, numbers and verdicts in them are not in it. Read one in full at its path when a question needs it.',
  };
}

// ───────────────────────── Code ─────────────────────────

interface FileRow { repo: string; path: string; lines: number | null; generated: number; classification: string | null; test: number; test_cases: number; last_commit: string | null; last_at: string | null; lang: string | null }

const under = (paths: readonly string[], p: string): boolean => paths.some((t) => { const x = t.replace(/\\/g, '/').replace(/\/+$/, ''); return p === x || p.startsWith(`${x}/`); });
/** Dart and Flutter keep a directory's tests under `test/` mirroring `lib/`: those count for the territory too. */
const testMirror = (paths: readonly string[]): string[] => paths.flatMap((p) => { const m = /^(.*?)(?:^|\/)lib(\/.*)?$/.exec(p.replace(/\\/g, '/')); return m ? [`${m[1] ? `${m[1]}/` : ''}test${m[2] ?? ''}`] : []; });

function commitFacts(ledger: Ledger, hash: string | null): { commit: string; occurred: Occurred; subject: string } | null {
  if (!hash) return null;
  const e = ledger.resolve(`commit:${hash.slice(0, 12)}`);
  return e ? { commit: hash.slice(0, 12), occurred: e.occurred, subject: e.label.slice(8) } : null;
}

/** Until the model draws territories, show actual disjoint directories with their own measured facts. */
function unmappedTerritories(ledger: Ledger, repo: string): CodeTerritory[] {
  const paths = (ledger.db.prepare('SELECT path FROM code_files WHERE repo = ?').all(repo) as { path: string }[]).map((r) => r.path);
  let depth = 1;
  let groups = new Set(paths.map((p) => p.split('/').slice(0, depth).join('/')));
  while (groups.size === 1 && paths.every((p) => p.split('/').length > depth) && depth < 8) {
    depth++;
    groups = new Set(paths.map((p) => p.split('/').slice(0, depth).join('/')));
  }
  return [...groups].sort().map((path) => ({
    id: `unmapped:${repo}:${path}`, projectId: '', name: path, summary: 'No territories drawn yet', repo, paths: [path],
    kind: 'shared', areaId: null, alsoServes: [], anomalies: [], roundId: null, jobId: null, updatedAt: '',
  }));
}

export function codeView(ledger: Ledger, store: ProjectStore, project: Project): CodeView | null {
  const repos = ledger.repos();
  const main = repos[0];
  if (!main) return null;
  const headFacts = commitFacts(ledger, main.head);
  const judged = store.territories.filter((t) => t.projectId === project.id);
  const territories = judged.length ? judged : repos.flatMap((r) => unmappedTerritories(ledger, r.id));
  const repoOf = (t: { repo: string }) => repos.find((r) => r.id === t.repo || pathKey(r.path) === pathKey(t.repo) || r.path.toLowerCase().endsWith(`/${t.repo.toLowerCase()}`)) ?? main;
  const files = new Map<string, FileRow[]>();
  const filesOf = (repo: string): FileRow[] => {
    if (!files.has(repo)) files.set(repo, ledger.db.prepare('SELECT * FROM code_files WHERE repo = ?').all(repo) as unknown as FileRow[]);
    return files.get(repo)!;
  };
  const indexes = new Map(repos.map((r) => [r.id, new CodeMapIndex(ledger, store, r.id)]));
  const areaName = (id: string) => store.reference.get(id)?.name ?? id;
  const views: TerritoryView[] = territories.map((t) => {
    const repo = repoOf(t);
    const index = indexes.get(repo.id)!;
    const mine = filesOf(repo.id).filter((f) => under(t.paths, f.path));
    const product = mine.filter((f) => !f.generated && !f.classification);
    const gen = mine.filter((f) => f.generated);
    const others = territories.filter((o) => o.id !== t.id && repoOf(o).id === repo.id);
    const inMine = (p: string) => under(t.paths, p);
    const counts = index.dependencyCounts(t.paths, others);
    const dependsOn = Object.keys(counts.dependsOn);
    const dependedBy = Object.keys(counts.dependedBy);
    const tests = filesOf(repo.id).filter((f) => f.test && (inMine(f.path) || under(testMirror(t.paths), f.path)));
    const last = [...mine].filter((f) => f.last_at).sort((a, b) => (msOf(materialTime(b.last_at!) ?? b.last_at) ?? 0) - (msOf(materialTime(a.last_at!) ?? a.last_at) ?? 0))[0];
    const builtBy = index.builtBy(t.paths);
    return {
      id: t.id, name: t.name, summary: t.summary, repo: repo.path, paths: t.paths,
      row: t.kind === 'area' && t.areaId ? { kind: 'area', areaId: t.areaId, areaName: areaName(t.areaId) } : t.kind === 'non-product' ? { kind: 'non-product' } : { kind: 'shared' },
      size: { files: t.kind === 'non-product' ? mine.length : product.length, lines: (t.kind === 'non-product' ? mine : product).reduce((n, f) => n + (f.lines ?? 0), 0), generatedFiles: gen.length, generatedLines: gen.reduce((n, f) => n + (f.lines ?? 0), 0) },
      dependsOn, dependedBy, dependsOnCounts: counts.dependsOn, dependedByCounts: counts.dependedBy,
      alsoServes: t.alsoServes.map((a) => ({ areaId: a, areaName: areaName(a) })),
      builtBy, generations: index.generationOrigins(t.paths).map((g) => ({ generationId: g.generationId, name: g.name, share: g.share, works: g.work })), currentUse: index.currentUse(t.paths),
      tests: tests.reduce((n, f) => n + (f.test_cases || 1), 0),
      lastChange: last ? commitFacts(ledger, last.last_commit) : null,
      anomalies: t.anomalies.map((a) => ({ kind: a.kind, text: a.text, evidence: a.evidence, basis: a.basis === 'Explicit' ? 'Explicit' : 'Inferred', sendBackId: a.sendBackId, noteIds: a.noteIds })),
    };
  });
  const coverage = ledger.coverage();
  return {
    projectId: project.id,
    // A head the ledger has no commit for is first seen by the rebuild that read it, not at the moment of the query (CKC-22 AC-10).
    version: { repo: main.path, branch: main.headBranch, commit: (main.head ?? '').slice(0, 12), occurred: headFacts?.occurred ?? undated(coverage.lastRebuild?.at ?? '', null) },
    // How deep each language of the code is read, from the coverage the ledger measured (codemap `codeLevels`, D98 补).
    levels: codeLevels(coverage.languages),
    generatedAt: coverage.lastRebuild?.at ?? new Date().toISOString(),
    territories: views,
  };
}

export function territoryView(ledger: Ledger, store: ProjectStore, territoryId: string): TerritoryDetailView | null {
  const t = store.territories.get(territoryId) ?? ledger.repos().flatMap((r) => unmappedTerritories(ledger, r.id)).find((x) => x.id === territoryId);
  if (!t) return null;
  const repos = ledger.repos();
  const repo = repos.find((r) => r.id === t.repo || pathKey(r.path) === pathKey(t.repo)) ?? repos[0];
  if (!repo) return null;
  const files = (ledger.db.prepare('SELECT * FROM code_files WHERE repo = ?').all(repo.id) as unknown as FileRow[]).filter((f) => under(t.paths, f.path));
  const edges = ledger.db.prepare('SELECT src, dst FROM code_deps WHERE repo = ? AND external = 0').all(repo.id) as { src: string; dst: string }[];
  const index = new CodeMapIndex(ledger, store, repo.id);
  const out: CodeFileView[] = files.sort((a, b) => a.path.localeCompare(b.path)).map((f) => {
    const work = index.workForCommit(f.last_commit);
    return {
      path: f.path, lines: f.lines ?? 0, generated: f.generated === 1,
      importedBy: [...new Set(edges.filter((e) => e.dst === f.path).map((e) => e.src))].sort(),
      imports: [...new Set(edges.filter((e) => e.src === f.path).map((e) => e.dst))].sort(),
      lastCommit: commitFacts(ledger, f.last_commit),
      workId: work?.id ?? null, workLabel: work?.label ?? null,
    };
  });
  return { territoryId, files: out };
}
