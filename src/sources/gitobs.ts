/**
 * Observe repositories in scope: recent commits become commit sources; the current branch,
 * head and uncommitted changes become one status source per repository. Read-only.
 *
 * When a commit was made goes on its anchor, where the program reads it (how recent a repository's commits are); the
 * excerpt is the commit as people read it, never parsed back into facts.
 */
import type { ScopeItem, Source } from '../model/types.ts';
import { fingerprint, stableId } from '../model/ids.ts';
import { gitRecentCommits, gitStatus } from '../util/git.ts';
import { pathKey } from '../util/paths.ts';
import { commitSourceId, extractIds, redactCredentials } from './anchor.ts';

/** Commit sources of a repository: every commit reachable from HEAD (since `since`), unless `limit` asks for fewer (D77). */
export function commitSources(projectId: string, repo: ScopeItem, since: string | null, limit: number | null = null, notFrom: string | null = null): Source[] {
  const readAt = new Date().toISOString();
  return gitRecentCommits(repo.path, since, limit, notFrom).map((c) => {
    const excerpt = `${c.subject}\n\nauthor: ${c.author}\nat: ${c.at}\nfiles:\n${c.files.map((f) => `  ${f}`).join('\n')}`;
    const red = redactCredentials(excerpt);
    return {
      id: commitSourceId(repo.path, c.hash), projectId, title: `${c.hash.slice(0, 8)} ${c.subject.slice(0, 80)}`,
      anchor: { kind: 'commit', repo: repo.path, commit: c.hash, ...(c.at ? { at: c.at } : {}) }, ids: extractIds(c.subject),
      version: { fingerprint: fingerprint(excerpt), readAt, commit: c.hash }, excerpt: red.text, usedAs: null, usedAsBy: null,
      availability: null, movedTo: null, scopeItemId: repo.id, hasCredential: red.found, bytes: Buffer.byteLength(excerpt),
    };
  });
}

export function statusSource(projectId: string, repo: ScopeItem): Source | null {
  const st = gitStatus(repo.path);
  if (!st) return null;
  const readAt = new Date().toISOString();
  const description = `git status of ${repo.path}`;
  const excerpt = `branch: ${st.branch ?? '(detached)'}\nhead: ${st.head ?? '(none)'}\nuncommitted: ${st.dirty.length}\n${st.dirty.slice(0, 80).map((l) => `  ${l}`).join('\n')}${st.dirty.length > 80 ? `\n  …${st.dirty.length - 80} more` : ''}`;
  return {
    id: stableId('src', 'status', pathKey(repo.path)), projectId, title: `Repository status · ${repo.path.split(/[\\/]/).pop()}`,
    anchor: { kind: 'status', description, at: readAt }, ids: [],
    version: { fingerprint: fingerprint(excerpt), readAt, commit: st.head }, excerpt, usedAs: 'Status', usedAsBy: null,
    availability: null, movedTo: null, scopeItemId: repo.id, hasCredential: false, bytes: Buffer.byteLength(excerpt),
  };
}
