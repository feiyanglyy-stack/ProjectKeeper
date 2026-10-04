/**
 * `KEngines.codemap` (server/k-views.ts): what the process view and `Code` need from the code map besides the ledger's
 * own views (Spec v3.0 §6.17, §1.19; CKC-25 AC-6, AC-7, AC-10):
 * - which territories each work item changed — the jump from a work to its territories, counted as `Built by` counts;
 * - which of a territory's paths the current version no longer has;
 * - a file of the current version, found through the ledger's `fileRefs` and read from the tree the ledger read.
 *
 * Program facts only, read from the ledger's tables and the assets; nothing is judged. One `CodeMapIndex` per repository
 * is kept while neither the ledger nor the assets it reads have changed.
 */
import type { Ledger } from '../ledger/index.ts';
import type { LedgerService } from '../ledger/adapters.ts';
import type { Project } from '../model/types.ts';
import type { CodeFileTextView, WorkTerritoryView } from '../model/views-k.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { pathKey } from '../util/paths.ts';
import { CodeMapIndex } from './facts.ts';

export interface CodeMapEngines {
  /** The territories each work item changed, by work id; null without a ledger. */
  workTerritories(store: ProjectStore, project: Project): Readonly<Record<string, readonly WorkTerritoryView[]>> | null;
  /** The paths of each territory the current version no longer has, by territory id (only territories with some); null without a ledger. */
  gonePaths(store: ProjectStore, project: Project): Readonly<Record<string, readonly string[]>> | null;
  /** A file of the current version (§6.17 "点文件打开原文阅读"), a page of it from `fromLine`; a string says why not; null without a ledger. */
  fileText(project: Project, input: { readonly path: string; readonly repo?: string | null; readonly fromLine?: number | null }): CodeFileTextView | string | null;
}

/** What the index reads of the assets: when any of it changes, the index is built again. */
function storeMark(store: ProjectStore): string {
  const part = (xs: readonly { readonly id: string; readonly updatedAt?: string }[]) => `${xs.length}:${xs.reduce((m, x) => ((x.updatedAt ?? '') > m ? x.updatedAt ?? '' : m), '')}`;
  return [
    part(store.threads.all()), part(store.territories.all()), part(store.generations.all()), part(store.nodes.all()),
    part(store.numbers.all().map((n) => ({ id: n.id, updatedAt: n.at }))), part(store.links.all().map((l) => ({ id: `${l.id}${l.confirmed ? '+' : l.check?.passed ? '~' : ''}`, updatedAt: l.at }))),
  ].join('|');
}

function ledgerMark(ledger: Ledger): string {
  const r = ledger.db.prepare('SELECT max(id) id, max(ended_at) at FROM rebuilds').get() as { id: number | null; at: string | null } | undefined;
  return `${r?.id ?? 0}:${r?.at ?? ''}`;
}

/** The territories of one repository of the ledger, matched as `Code` matches them (ledger/views.ts `repoOf`): by id, by
 *  path, by the path's last part; one that matches none is the main repository's. */
function territoriesOf(store: ProjectStore, project: Project, ledger: Ledger, repoId: string) {
  const repos = ledger.repos();
  const repoOf = (t: { repo: string }) => (repos.find((r) => r.id === t.repo || pathKey(r.path) === pathKey(t.repo) || r.path.toLowerCase().endsWith(`/${t.repo.toLowerCase()}`)) ?? repos[0])?.id;
  return store.territories.filter((t) => t.projectId === project.id && repoOf(t) === repoId);
}

export function codeMapEngines(ledgerService: LedgerService): CodeMapEngines {
  const cache = new Map<string, { ledger: Ledger; store: ProjectStore; mark: string; index: CodeMapIndex }>();
  const indexOf = (store: ProjectStore, project: Project, ledger: Ledger, repoId: string): CodeMapIndex => {
    const key = `${project.id}\x1f${repoId}`;
    const mark = `${ledgerMark(ledger)}#${storeMark(store)}`;
    const hit = cache.get(key);
    if (hit && hit.ledger === ledger && hit.store === store && hit.mark === mark) return hit.index;
    const index = new CodeMapIndex(ledger, store, repoId);
    cache.set(key, { ledger, store, mark, index });
    return index;
  };
  const withLedger = <T>(project: Project, fn: (l: Ledger) => T): T | null => {
    const l = ledgerService.ledger(project.id);
    if (!l) return null;
    try { return fn(l); } catch { return null; }
  };
  return {
    workTerritories: (store, project) => withLedger(project, (l) => {
      const out: Record<string, WorkTerritoryView[]> = {};
      for (const r of l.repos()) {
        const territories = territoriesOf(store, project, l, r.id);
        if (!territories.length) continue;
        for (const [workId, rows] of indexOf(store, project, l, r.id).territoriesByWork(territories)) out[workId] = [...(out[workId] ?? []), ...rows];
      }
      for (const rows of Object.values(out)) rows.sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
      return out;
    }),
    gonePaths: (store, project) => withLedger(project, (l) => {
      const out: Record<string, string[]> = {};
      for (const r of l.repos()) {
        const territories = territoriesOf(store, project, l, r.id);
        if (!territories.length) continue;
        const index = indexOf(store, project, l, r.id);
        for (const t of territories) { const gone = index.gonePaths(t.paths); if (gone.length) out[t.id] = gone; }
      }
      return out;
    }),
    fileText: (project, input) => withLedger(project, (l) => {
      const repoId = l.repoId(input.repo ?? null);
      if (input.repo && !repoId) return `${input.repo} is not a repository of this project's ledger.`;
      const refs = l.fileRefs(input.path, repoId ? { repo: repoId } : {});
      if (typeof refs === 'string') return refs;
      const repo = l.repos().find((r) => r.id === refs.repo);
      if (!repo?.head) return `The ledger has no current version of ${refs.path}.`;
      const page = l.docText({ path: refs.path, commit: repo.head, repo: refs.repo }, { from: input.fromLine ?? 1 });
      if (typeof page === 'string') return page;
      return {
        repo: repo.path, path: refs.path, lang: refs.lang, commit: page.commit, occurred: page.occurred, lines: page.lines,
        fromLine: page.fromLine, toLine: page.toLine, nextFromLine: page.nextFromLine ?? null, text: page.text, generated: refs.generated,
      };
    }),
  };
}
