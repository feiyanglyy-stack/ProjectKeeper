/**
 * The ledger as the rest of the app uses it — the four interfaces the clerk method and the workbench were built against:
 *
 * - `LedgerHook` (keeper/evidence.ts): an entry id read back as a label, when it happened (the ledger's, never the
 *   model's) and its text, so evidence `{ kind: 'ledger', id, line? }` can be checked; plus, for session drafts, a
 *   session's messages and the agent message an owner line answers (`LedgerHookPlus`).
 * - `LedgerRunner` (keeper/organize/clerk.ts): step 0 of a round, an incremental rebuild on a worker thread.
 * - `KEngines.ledger` (server/k-views.ts): coverage, versions, `How it got here`, the current version of a document,
 *   `Code` and a territory's files.
 * - the `pk_ledger_*` tools (keeper/ledger-tools.ts), which open the ledger from the store's directory themselves.
 *
 * One `LedgerService` per ProjectKeeper home holds them. Reads go through read-only connections, kept for a short while
 * per project and dropped when a rebuild of that project ends; rebuilds never block them (WAL).
 */
import type { Project } from '../model/types.ts';
import type { LedgerEntry, LedgerHook } from '../keeper/evidence.ts';
import type { LedgerRunner } from '../keeper/organize/clerk.ts';
import type { KEngines } from '../server/k-views.ts';
import { projectKeeperHome } from '../store/paths.ts';
import { Ledger } from './index.ts';
import { ledgerPath, rebuildLedger, rebuildLedgerInPlace, sessionInputOf, type RebuildOptions, type RebuildStats } from './rebuild.ts';
import { codeView, coverageView, docCurrentView, lineageView, territoryView, versionsView } from './views.ts';
import { materialTime } from './time.ts';

/** A session as the ledger recorded it: every message with its speaker and time; the text of the owner's messages and of the agent messages they answer. */
export interface LedgerSessionView {
  readonly id: string;
  readonly host: string;
  readonly sessionId: string;
  readonly file: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** The log is gone since it was read: the ledger is the only copy left (D71). */
  readonly missing: boolean;
  readonly messages: readonly {
    /** The ledger's message id (`msg:…`): what a session draft's line refers to. */
    readonly id: string;
    /** Position in the session, as the transcripts number it (`[n]`). */
    readonly index: number;
    readonly speaker: 'owner' | 'agent' | 'subagent' | 'host';
    readonly at: string | null;
    readonly text: string | null;
    /** An owner message: the position of the agent message it answers. */
    readonly answers: number | null;
  }[];
}

/** The agent message an owner line answers, verbatim. */
export interface AnsweredMessage { readonly id: string; readonly index: number; readonly at: string | null; readonly text: string | null }

/** `LedgerHook` and what the session drafts need besides. */
export interface LedgerHookPlus extends LedgerHook {
  resolve(id: string): (LedgerEntry & { readonly id: string; readonly kind: string }) | null;
  /** A session by host and native id (or a prefix of it, or its ledger id); null when the ledger has not read it. */
  session(host: string, sessionId: string): LedgerSessionView | null;
  /** The agent message right before an owner line (by the owner message's ledger id), or null when there is none. */
  agentBefore(ownerMessageId: string): AnsweredMessage | null;
}

const KEEP_MS = 60_000;

export class LedgerService {
  readonly home: string;
  private readonly open = new Map<string, { ledger: Ledger; at: number }>();
  private readonly running = new Map<string, Promise<RebuildStats>>();

  constructor(opts: { home?: string } = {}) {
    this.home = opts.home ?? projectKeeperHome();
  }

  /** Where a project's ledger file is. */
  file(projectId: string): string {
    return ledgerPath(projectId, this.home);
  }

  /** A read-only view of a project's ledger (kept a short while); null when it has never been built. */
  ledger(projectId: string): Ledger | null {
    const hit = this.open.get(projectId);
    if (hit && Date.now() - hit.at < KEEP_MS) return hit.ledger;
    hit?.ledger.close();
    this.open.delete(projectId);
    const l = Ledger.openPath(this.file(projectId));
    if (l) this.open.set(projectId, { ledger: l, at: Date.now() });
    return l;
  }

  /** Resolves once no rebuild of the project's ledger is under way (a project being cleared waits for it). */
  async idle(projectId: string): Promise<void> {
    await this.running.get(projectId)?.catch(() => undefined);
  }

  /** Drop the kept connection of a project (after a rebuild, or when the project goes away). */
  release(projectId?: string): void {
    for (const [id, e] of this.open) if (!projectId || id === projectId) { e.ledger.close(); this.open.delete(id); }
  }

  /**
   * Bring a project's ledger up to date on a worker thread; a rebuild already under way for the project is joined, not
   * started twice. Sessions are those of the project's scope (their own native homes).
   */
  rebuild(project: Project, opts: RebuildOptions = {}): Promise<RebuildStats> {
    const current = this.running.get(project.id);
    if (current) return current;
    const run = rebuildLedger(this.file(project.id), project, { sessions: sessionInputOf(project), ...opts })
      .finally(() => { this.running.delete(project.id); this.release(project.id); });
    this.running.set(project.id, run);
    return run;
  }

  /** The same on the calling thread (a script, a test). */
  rebuildNow(project: Project, opts: RebuildOptions = {}): RebuildStats {
    try {
      return rebuildLedgerInPlace(this.file(project.id), project, { sessions: sessionInputOf(project), ...opts });
    } finally {
      this.release(project.id);
    }
  }

  /**
   * Step 0 of a round (clerk.ts `LedgerRunner`): how many commits it added, and in words what else happened. The Keeper's
   * numbers the round hands over are recorded with the rest (CKC-22 AC-5).
   */
  readonly runner: LedgerRunner = {
    run: async (project: Project, extra) => {
      const stats = await this.rebuild(project, extra?.keeperNumbers ? { keeperNumbers: extra.keeperNumbers.map((k) => ({ number: k.number, objectId: k.objectId, objectKind: k.objectKind, projectNumber: k.projectNumber, at: k.at })) } : {});
      return { commitsAdded: stats.commitsAdded, note: runNote(stats) };
    },
  };

  /** The hook the evidence resolver and the clerk tools read the ledger through, for one project. */
  hook(projectId: string): LedgerHookPlus {
    return {
      resolve: (id: string) => this.ledger(projectId)?.resolve(id) ?? null,
      session: (host: string, sessionId: string) => {
        const l = this.ledger(projectId);
        if (!l) return null;
        const s = l.findSession(sessionId, host || undefined);
        if (typeof s === 'string') return null;
        const rows = l.db.prepare('SELECT * FROM session_messages WHERE session = ? ORDER BY idx').all(String(s.key)) as { key: string; idx: number; speaker: string; at: string | null; text: string | null; answers: number | null }[];
        return {
          id: String(s.key), host: String(s.host), sessionId: String(s.session_id), file: String(s.file),
          startedAt: (s.started_at as string | null) ?? null, endedAt: (s.ended_at as string | null) ?? null, missing: s.missing === 1,
          messages: rows.map((m) => ({ id: m.key, index: m.idx, speaker: m.speaker as 'owner', at: m.at ? materialTime(m.at) ?? m.at : null, text: m.text, answers: m.answers })),
        };
      },
      agentBefore: (ownerMessageId: string) => {
        const m = this.ledger(projectId)?.message(ownerMessageId);
        if (!m || m.speaker !== 'owner' || !m.answers) return null;
        return { id: m.answers.id, index: m.answers.index, at: m.answers.occurred.undated ? null : m.answers.occurred.at, text: m.answers.text };
      },
    };
  }

  /** `KEngines.ledger` for the workbench's increment K views. */
  engines(): NonNullable<KEngines['ledger']> {
    const withLedger = <T>(project: Project, fn: (l: Ledger) => T | null): T | null => {
      const l = this.ledger(project.id);
      if (!l) return null;
      try { return fn(l); } catch { return null; }
    };
    return {
      coverage: (project) => withLedger(project, (l) => coverageView(l)),
      versions: (store, project, objectId) => withLedger(project, (l) => versionsView(l, store, objectId)),
      lineage: (store, project, objectId) => withLedger(project, (l) => lineageView(l, store, objectId)),
      docCurrent: (store, project, objectId) => withLedger(project, (l) => docCurrentView(l, store, objectId)),
      code: (store, project) => withLedger(project, (l) => codeView(l, store, project)),
      territory: (store, project, territoryId) => withLedger(project, (l) => territoryView(l, store, territoryId)),
    };
  }
}

/** What a rebuild did, in one line for the round's program step. */
export function runNote(s: RebuildStats): string {
  const commits = s.repos.reduce((n, r) => n + r.commits, 0);
  const docs = s.repos.reduce((n, r) => n + r.docs.versions, 0);
  const docsAdded = s.repos.reduce((n, r) => n + r.docs.versionsAdded, 0);
  const sessions = s.sessions === 'not scanned' ? 'sessions not read' : `${s.sessions.sessions} sessions (${s.sessions.read} read now${s.sessions.unreadable ? `, ${s.sessions.unreadable} unreadable` : ''}${s.sessions.missing ? `, ${s.sessions.missing} logs gone` : ''})`;
  const parts = [
    `Ledger ${s.kind === 'full' ? 'built' : 'brought up to date'} in ${(s.ms / 1000).toFixed(1)} s`,
    `${commits} commits in ${s.repos.length} ${s.repos.length === 1 ? 'repository' : 'repositories'} (${s.commitsAdded} new)`,
    `${docs} document versions (${docsAdded} new)`,
    sessions,
    `${s.numRules} numbering rules`,
  ];
  return `${parts.join(' · ')}${s.notes.length ? `. Not read: ${s.notes.join(' ')}` : ''}`;
}
