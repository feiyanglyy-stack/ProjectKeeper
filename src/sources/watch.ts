/**
 * Watch the scope for change (Spec §3.2): files in included directories, native session logs
 * for the scoped working directories, and repository heads. Changes are reported as pending
 * material; a piece of work counts as "settled" after a quiet period so active writing is
 * gathered instead of re-done on every keystroke. The rhythm parameters are execution-layer
 * knobs (D31), not product premises.
 */
import { EventEmitter } from 'node:events';
import { existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { PendingMaterial, Project, ScopeItem } from '../model/types.ts';
import { isWithin, normalizePath, pathKey } from '../util/paths.ts';
import { gitHead } from '../util/git.ts';
import { claudeSessionFolders, codexSessionRoots, cwdMatcher, readCodexSessionHeader } from './sessions/locate.ts';
import { sessionItemForCwd, sessionStoreRootOf } from './sessions/scope.ts';
import { isDocumentPath, isReadRoot, overridesIgnoreRules, readingOf, skippedSegment, treatmentOf } from '../scope/skip.ts';
import { isIgnored } from '../scope/ignore.ts';
import { ignoredPlaceOf } from '../scope/ignored-place.ts';

export interface WatchSettings {
  /** A file whose last change is older than this is considered settled. */
  readonly fileQuietMs: number;
  /** A session log whose last growth is older than this is considered settled. */
  readonly sessionQuietMs: number;
  /** How often to poll repository heads and re-check quiet periods. */
  readonly pollMs: number;
}
export const DEFAULT_WATCH: WatchSettings = { fileQuietMs: 45_000, sessionQuietMs: 4 * 60_000, pollMs: 15_000 };

export interface PendingChange extends PendingMaterial {
  readonly lastEventAt: number;
  readonly scopeItemId: string;
}

/** Repositories and worktrees whose new commits are the project's (not a vendored library's upstream history). */
const committing = (scope: readonly ScopeItem[]) => scope.filter((i) => (i.category === 'Repository' || i.category === 'Worktree') && isReadRoot(scope, i) && ['read', 'changes'].includes(treatmentOf(i)));

export class ScopeWatcher extends EventEmitter {
  private readonly watchers: FSWatcher[] = [];
  private readonly pending = new Map<string, PendingChange>();
  private readonly heads = new Map<string, string | null>();
  /** What git's ignore rules said about a file already seen (the check runs once per path). */
  private readonly ignoredCache = new Map<string, boolean>();
  /** Whether a scope item lies in a place a repository around it ignores (asked once per item between starts). */
  private readonly placeCache = new Map<string, boolean>();
  private keep = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private readonly settings: WatchSettings;
  private project: Project;

  constructor(project: Project, settings: Partial<WatchSettings> = {}) {
    super();
    this.project = project;
    this.settings = { ...DEFAULT_WATCH, ...settings };
  }

  /**
   * The scope item a changed file belongs to, when the scan would read it (Spec §1.1): not what the one skip list or
   * the project's ignore rules leave out, not generated output, only documents of third-party material, and nothing
   * under a location that is left out. Nor a file of a location that itself lies where a repository around it ignores —
   * a worktree under an ignored directory (D105): its working files are no change to take in; its commits are polled.
   */
  private accept(file: string): ScopeItem | null {
    const scope = this.project.scope;
    const { item, treatment } = readingOf(scope, file);
    if (!item || treatment === 'none' || !isReadRoot(scope, item)) return null;
    const rel = relative(item.path, file).split('\\').join('/');
    if (skippedSegment(rel) !== null) return null;
    if (treatment === 'documents' && !isDocumentPath(file)) return null;
    let inIgnoredPlace = this.placeCache.get(item.id);
    if (inIgnoredPlace === undefined) { inIgnoredPlace = ignoredPlaceOf(scope, item) !== null; this.placeCache.set(item.id, inIgnoredPlace); }
    if (inIgnoredPlace) return null;
    if (item.versionControl !== 'none' && !overridesIgnoreRules(scope, item) && !this.keep.has(pathKey(file))) {
      const key = pathKey(file);
      let ignored = this.ignoredCache.get(key);
      if (ignored === undefined) { ignored = isIgnored(item.path, rel); this.ignoredCache.set(key, ignored); }
      if (ignored) return null;
    }
    return item;
  }

  start(): void {
    this.stop();
    const p = this.project;
    this.ignoredCache.clear();
    this.placeCache.clear();
    this.keep = new Set(p.scope.filter((i) => i.relation !== 'Excluded' && i.ignoredBy?.paths).flatMap((i) => (i.ignoredBy!.paths ?? []).map((f) => pathKey(join(dirname(i.path), f.split('/').pop()!)))));
    const roots = p.scope.filter((i) => i.category !== 'Session source' && isReadRoot(p.scope, i));
    // One recursive watch per outermost location; each change is attributed to the deepest item that holds it (CKC-07 AC-1).
    const outer = roots.filter((r) => !roots.some((o) => o !== r && isWithin(o.path, r.path) && pathKey(o.path) !== pathKey(r.path)));
    for (const root of outer) {
      this.watchDir(root.path, (file) => {
        const owner = this.accept(file);
        if (!owner) return;
        this.note({ kind: 'file', ref: file, label: file, since: new Date().toISOString(), lastEventAt: Date.now(), scopeItemId: owner.id });
      });
    }
    for (const repo of committing(p.scope)) {
      this.heads.set(repo.id, gitHead(repo.path));
    }
    // Session logs: Claude's per-project directory and both Codex homes.
    const cwds = new Set<string>();
    for (const item of roots) cwds.add(item.path);
    for (const item of p.scope) if (item.copyOf) cwds.add(item.copyOf);
    const home = homedir();
    /** The directories whose sessions one host keeps in the same native home, home by home. */
    const byHome = (host: 'claude' | 'codex'): { home: string; cwds: string[] }[] => {
      const groups = new Map<string, { home: string; cwds: string[] }>();
      for (const cwd of cwds) {
        const selected = sessionStoreRootOf(p.scope, host, cwd, home);
        const key = pathKey(selected);
        const group = groups.get(key) ?? { home: selected, cwds: [] };
        group.cwds.push(cwd);
        groups.set(key, group);
      }
      return [...groups.values()];
    };
    for (const group of byHome('claude')) {
      // The folder named after the directory, and any named after another spelling of it (through a junction, say).
      for (const { dir, cwd } of claudeSessionFolders(group.cwds, group.home)) {
        // The full normalised path is the identity. A substring lets D:\x steal events from D:\x-y, depending on order.
        const item = sessionItemForCwd(p.scope, 'claude', cwd);
        // Removing a discovered session source records an owner exclusion. Keep watching a cwd with no item so its
        // first new session is still caught, but an item the owner explicitly excluded stays quiet.
        if (item?.relation === 'Excluded') continue;
        this.watchDir(dir, (file) => {
          if (!file.endsWith('.jsonl')) return;
          this.note({ kind: 'session', ref: file, label: `Claude Code session ${file.split(/[\\/]/).pop()}`, since: new Date().toISOString(), lastEventAt: Date.now(), scopeItemId: item?.id ?? '' });
        });
      }
    }
    for (const group of byHome('codex')) {
      const matched = cwdMatcher(group.cwds);
      for (const rootDir of codexSessionRoots(group.home)) {
        this.watchDir(rootDir, (file) => {
          if (!file.endsWith('.jsonl')) return;
          // A native home can contain every project. Only the header's complete cwd selects its session source: one of
          // these directories, in whatever spelling the log records it.
          const header = readCodexSessionHeader(file);
          const cwd = header ? matched(header.cwd) : null;
          if (!cwd) return;
          const item = sessionItemForCwd(p.scope, 'codex', cwd);
          if (item?.relation === 'Excluded') return;
          this.note({ kind: 'session', ref: file, label: `Codex session ${file.split(/[\\/]/).pop()}`, since: new Date().toISOString(), lastEventAt: Date.now(), scopeItemId: item?.id ?? '' });
        });
      }
    }
    this.timer = setInterval(() => this.poll(), this.settings.pollMs);
    this.timer.unref?.();
  }

  update(project: Project): void {
    this.project = project;
    this.start();
  }

  stop(): void {
    for (const w of this.watchers) { try { w.close(); } catch { /* ignore */ } }
    this.watchers.length = 0;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private watchDir(dir: string, onFile: (file: string) => void): void {
    try {
      const w = watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) return;
        const file = normalizePath(join(dir, String(filename)));
        onFile(file);
      });
      w.on('error', () => { /* a vanished directory just stops being watched */ });
      this.watchers.push(w);
    } catch (error) {
      this.emit('warning', `Cannot watch ${dir}: ${(error as Error).message}`);
    }
  }

  private note(change: PendingChange): void {
    const key = `${change.kind}:${pathKey(change.ref)}`;
    const existing = this.pending.get(key);
    this.pending.set(key, existing ? { ...existing, lastEventAt: change.lastEventAt } : change);
    this.emit('pending', this.list());
  }

  /** Everything seen changed and not yet handed to organizing. */
  list(): PendingChange[] { return [...this.pending.values()]; }

  /** Changes whose quiet period has passed: work that has settled (§3.2). */
  settled(now = Date.now()): PendingChange[] {
    return this.list().filter((c) => {
      const quiet = c.kind === 'session' ? this.settings.sessionQuietMs : this.settings.fileQuietMs;
      return now - c.lastEventAt >= quiet;
    });
  }

  take(changes: readonly PendingChange[]): void {
    for (const c of changes) this.pending.delete(`${c.kind}:${pathKey(c.ref)}`);
  }

  private poll(): void {
    for (const repo of committing(this.project.scope)) {
      const head = gitHead(repo.path);
      if (head !== this.heads.get(repo.id)) {
        this.heads.set(repo.id, head);
        this.note({ kind: 'commit', ref: `${repo.path}@${head ?? 'none'}`, label: `${repo.path.split(/[\\/]/).pop()} head → ${head?.slice(0, 8) ?? 'none'}`, since: new Date().toISOString(), lastEventAt: 0, scopeItemId: repo.id });
      }
    }
    const settled = this.settled();
    if (settled.length > 0) this.emit('settled', settled);
    for (const c of this.list()) {
      if (c.kind === 'file' && !existsSync(c.ref)) continue;
      if (c.kind === 'file') { try { const st = statSync(c.ref); if (st.mtimeMs > c.lastEventAt) this.note({ ...c, lastEventAt: st.mtimeMs }); } catch { /* removed */ } }
    }
  }
}
