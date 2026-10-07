/** Session scope identity shared by discovery and live watching (Spec §1.1). */
import type { ScopeItem } from '../../model/types.ts';
import type { SessionHost } from '../../model/vocab.ts';
import { homedir } from 'node:os';
import { sameDirectory, samePath } from '../../util/paths.ts';

/**
 * Session items recorded before `sessionCwd` named the directory in their reason. An owner edit wraps the old reason
 * in text such as "Excluded by the owner (was: …)", so the expression deliberately is not anchored.
 */
const REASON_CWD = /sessions whose working directory is (.+?)(?: \(the original of a copy; read-only\))?: \d+ found/;

/** The complete working directory represented by a session item, including the legacy on-disk shape. */
export function sessionCwdOf(item: ScopeItem): string | null {
  return item.sessionCwd ?? REASON_CWD.exec(item.reason)?.[1] ?? null;
}

/** Find only the item for this host and complete cwd. There is intentionally no first-item fallback. */
export function sessionItemForCwd(scope: readonly ScopeItem[], host: SessionHost, cwd: string): ScopeItem | undefined {
  return scope.find((item) => {
    if (item.category !== 'Session source' || item.sessionHost !== host) return false;
    const itemCwd = sessionCwdOf(item);
    return itemCwd !== null && samePath(itemCwd, cwd);
  });
}

/** The native home a source reads; a copy's frozen root is recorded on the corresponding session item. */
export function sessionStoreRootOf(scope: readonly ScopeItem[], host: 'claude' | 'codex', cwd: string, defaultHome = homedir()): string {
  return sessionItemForCwd(scope, host, cwd)?.sessionStoreRoot ?? defaultHome;
}

/**
 * Same session-source identity across the pre-D5 and current persisted shapes. An item recorded before locations were
 * kept in the file system's spelling names its directory the way the project was given then — through a junction,
 * say — and is still that directory's item: what the owner decided about it holds for the item discovery finds now.
 */
export function sameSessionItem(a: ScopeItem, b: ScopeItem): boolean {
  if (a.category !== 'Session source' || b.category !== 'Session source' || a.sessionHost !== b.sessionHost) return false;
  const aCwd = sessionCwdOf(a);
  const bCwd = sessionCwdOf(b);
  return aCwd !== null && bCwd !== null && sameDirectory(aCwd, bCwd);
}
