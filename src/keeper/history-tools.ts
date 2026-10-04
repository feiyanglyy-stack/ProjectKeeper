/**
 * The Keeper's tools for version history (Spec §1.2 `History only`, §3.1; CKC-03 AC-24), and the checks that keep what
 * it reads there out of the current picture (Spec §2.6; CKC-02 AC-23; D61). The reading itself is in
 * sources/history.ts; this module words it for the model and records what was read.
 *
 * Why the checks sit with the writes: in the takeover whose review led to D61, specifications deleted from the
 * project and read back out of git history were built into current nodes. A rule the model is asked to remember is
 * forgotten again; a write that refuses is not.
 */
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ProjectStore } from '../store/project-store.ts';
import type { Source } from '../model/types.ts';
import { anchorLabel } from '../sources/anchor.ts';
import { deletedDocuments, isHistoryOnly, pathHistory, readRevision } from '../sources/history.ts';
import type { ToolContext } from './tools.ts';

const USES = 'History only: use it to mark what current material has outdated, to cross-check current documents, or to produce the history when it is traced. It forms no current node, is never material to organize and enters no context; if you find something that was dropped but should not have been, or an intent that got buried, write a note for the owner — never revive it as current.';
const PAGE_CHARS = 60_000;
const LIST_CHARS = 90_000;

function ok(value: unknown) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  return { content: [{ type: 'text' as const, text: body.length > 120_000 ? `${body.slice(0, 120_000)}\n…(truncated)` : body }], details: {} };
}
function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }], details: {}, isError: true };
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Lines `from`..`to` (1-based, inclusive) of a text, cut to the page size; says where the next page starts. */
function page(text: string, fromLine: number, toLine: number | null): { text: string; fromLine: number; toLine: number; lines: number; nextFromLine: number | null } {
  const lines = text.split(/\r?\n/);
  const from = Math.min(Math.max(1, Math.floor(fromLine) || 1), Math.max(1, lines.length));
  const last = Math.min(lines.length, toLine && toLine >= from ? Math.floor(toLine) : lines.length);
  const out: string[] = [];
  let size = 0;
  let end = from - 1;
  for (let i = from - 1; i < last; i++) {
    const line = lines[i]!;
    if (out.length > 0 && size + line.length + 1 > PAGE_CHARS) break;
    out.push(line);
    size += line.length + 1;
    end = i + 1;
  }
  return { text: out.join('\n'), fromLine: from, toLine: end, lines: lines.length, nextFromLine: end < last ? end + 1 : null };
}

export function historyTools(ctx: ToolContext): ToolDefinition[] {
  const { store, project } = ctx;
  return [
    defineTool({
      name: 'pk_history_log', label: 'History of a path',
      description: 'Every commit in the repository’s history that touched a path — a file, or a directory (then everything under it) — newest first, including the commit that deleted it and a move away from it with where it went. Each row gives the commit, time, author, subject, what happened (Added, Modified, Deleted, Renamed …) and readAt: the commit to read that version at with pk_history_read (for a deletion, the last commit that still had it). The whole history, a page at a time: limit commits (default 100) after offset; next says where the next page starts. repo: a repository or worktree of the scope, by id or path; default the main repository (an absolute path picks the repository that holds it). Read-only.',
      parameters: Type.Object({
        path: Type.String({ description: 'relative to the repository root (or absolute inside it)' }),
        repo: Type.Optional(Type.String()), limit: Type.Optional(Type.Number({ description: 'commits per page (default 100)' })),
        offset: Type.Optional(Type.Number({ description: 'commits to skip: the next of the previous page' })),
      }),
      execute: async (_id, p) => {
        const r = pathHistory(project, { path: str(p.path), repo: str(p.repo) || undefined, limit: Number(p.limit) || undefined, offset: Number(p.offset) || undefined });
        if (typeof r === 'string') return fail(r);
        return ok({
          repo: r.target.root, path: r.target.rel, commits: r.rows, ...(r.more ? { more: true, next: r.next } : {}), ...(r.offset ? { offset: r.offset } : {}),
          ...(r.rows.length === 0 ? { note: `No commit in the history of ${r.target.root} touched ${r.target.rel}${r.offset ? ` after the first ${r.offset}` : ''}.` } : {}),
        });
      },
    }),
    defineTool({
      name: 'pk_history_read', label: 'Read an old version',
      description: `Read a file as it was at a commit — a deleted design, an earlier version of a plan, an old file of a worktree branch already merged. commit: a hash (abbreviated is fine), a branch or tag, or HEAD~n; a file deleted in some commit is read at the commit before it (pk_history_log gives it as readAt, pk_history_deleted as lastPresentIn). The version becomes a source anchored at repository, commit and path, Used as History only, which you can cite by its id. ${USES} When the version is exactly what the project has at that path now, it is current material: nothing is recorded as history and the current file’s sources are named. Long files come in pages: fromLine / toLine. Read-only.`,
      parameters: Type.Object({
        path: Type.String({ description: 'relative to the repository root (or absolute inside it)' }), commit: Type.String(),
        repo: Type.Optional(Type.String()), fromLine: Type.Optional(Type.Number()), toLine: Type.Optional(Type.Number()),
      }),
      execute: async (_id, p) => {
        const r = readRevision(store, project, { path: str(p.path), commit: str(p.commit), repo: str(p.repo) || undefined });
        if (typeof r === 'string') return fail(r);
        if (r.kind === 'current') {
          return ok({ current: true, path: r.target.rel, file: r.file, commit: r.commit, sourceIds: r.sourceIds, note: 'This is exactly what the project has at this path now: current material, not history. Read or cite the current file (its sources are listed); nothing was recorded as History only.' });
        }
        const previous = store.sources.get(r.source.id);
        if (!previous || previous.version.fingerprint !== r.source.version.fingerprint || previous.usedAs !== 'History only') {
          store.sources.put(r.source, { jobId: ctx.jobId, basisSourceIds: [r.source.id], summary: `History only: ${r.target.rel} as it was at ${r.source.version.commit!.slice(0, 10)}, read from version history` });
        }
        ctx.onSaved?.('sources', r.source.id, `History only: ${r.source.title}`);
        const pg = page(r.text, Number(p.fromLine) || 1, Number(p.toLine) || null);
        return ok({
          id: r.source.id, usedAs: 'History only', at: anchorLabel(r.source.anchor), repo: r.target.repo, commit: r.source.version.commit, path: r.target.rel,
          ...(r.meta ? { committed: { at: r.meta.at, author: r.meta.author, subject: r.meta.subject } } : {}),
          now: r.nowAtPath, chars: r.text.length, lines: pg.lines, fromLine: pg.fromLine, toLine: pg.toLine,
          ...(pg.nextFromLine ? { nextFromLine: pg.nextFromLine } : {}), text: pg.text, uses: USES,
        });
      },
    }),
    defineTool({
      name: 'pk_history_deleted', label: 'Deleted documents',
      description: 'The documents the repository’s main history deleted and the current version does not have again, grouped by directory: each with the commit that deleted it (time, author, subject) and lastPresentIn, the last commit it appears in — read it there with pk_history_read. A move is not a deletion; a deletion in the working tree not committed yet is listed as uncommitted. Documents are text documents (Markdown, text, reStructuredText …); all: true lists every kind of file. dir narrows to one directory. Deletion means the project no longer needs it: what you read stays History only. Read-only.',
      parameters: Type.Object({ repo: Type.Optional(Type.String()), dir: Type.Optional(Type.String()), all: Type.Optional(Type.Boolean()) }),
      execute: async (_id, p) => {
        const r = deletedDocuments(project, { repo: str(p.repo) || undefined, dir: str(p.dir) || undefined, all: p.all === true });
        if (typeof r === 'string') return fail(r);
        const full = { repo: r.target.root, head: r.head, documentsOnly: p.all !== true, total: r.total, directories: r.directories };
        if (JSON.stringify(full).length <= LIST_CHARS) return ok(full);
        // Too long for one answer: every directory keeps its count; the files are listed while there is room.
        let room = LIST_CHARS - JSON.stringify({ ...full, directories: [] }).length - 400;
        const directories = r.directories.map((d) => {
          const files = [];
          for (const f of d.files) { const size = JSON.stringify(f).length + 4; if (room - size < 0) break; room -= size; files.push(f); }
          return { ...d, files, ...(files.length < d.files.length ? { more: d.files.length - files.length } : {}) };
        });
        return ok({ ...full, directories, truncated: true, note: 'Not every file fits in one answer: each directory keeps its count, and dir lists one directory in full.' });
      },
    }),
  ];
}

// ───────────────────────── history stays history: the checks the writes run (CKC-02 AC-23; D61) ─────────────────────────

const known = (store: ProjectStore, ids: readonly string[]): Source[] => [...new Set(ids)].map((id) => store.sources.get(id)).filter((s): s is Source => s !== undefined);

/**
 * Why a work item may not rest on these sources, or null. A work item is a current node, and what exists only in
 * history forms none (Spec §2.6); reference-only material never becomes the project's plan or work (§1.1, §1.2). Either
 * may be cited next to the project's own current material. A `Removed` work item keeps what it rested on.
 */
export function workItemHistoryRefusal(store: ProjectStore, sourceIds: readonly string[], validity: string): string | null {
  if (validity === 'Removed') return null;
  const cited = known(store, sourceIds);
  if (cited.length === 0 || !cited.every((s) => isHistoryOnly(s) || s.usedAs === 'Reference only')) return null;
  if (cited.every(isHistoryOnly)) {
    return 'Every source this work item rests on is History only — an old version or deleted file from version history, or material the project keeps for recovery only. What exists only in history forms no current node: no work item is built from it. Use it to mark what current material has outdated, to cross-check the current plan, or to trace history; if work was dropped that should not have been, write a note for the owner.';
  }
  return 'Every source this work item rests on is History only or Reference only: neither makes a work item of the project. A work item comes from the project’s own current plan, tasks or issues; cite those.';
}

/**
 * Why a relation may not have this endpoint, or null. A source at either end of a relation is drawn as a node of its own
 * (Spec §1.5), and a History only source forms no node; it can still be the relation's evidence.
 */
export function relationEndpointHistoryRefusal(store: ProjectStore, fromId: string, toId: string): string | null {
  const end = [fromId, toId].map((id) => store.sources.get(id)).find((s): s is Source => s !== undefined && isHistoryOnly(s));
  if (!end) return null;
  return `${end.id} is History only (${anchorLabel(end.anchor)}): a source at the end of a relation becomes a node on the graph, and what exists only in history forms no node. Relate the current objects instead and cite the old version as evidence (evidenceSourceIds), or mark the current object it shows as outdated (pk_write_mark with the old version in clueSourceIds).`;
}

/**
 * Why a rule in force may not rest on these sources, or null. A rule found only in history is no longer the project's
 * rule — deletion says it is not needed — and rules in force enter the start context (Spec §1.15, §7.3), which history
 * never does (§7.1). A rule written as replaced, to record that the project changed it, may cite history.
 */
export function ruleHistoryRefusal(store: ProjectStore, sourceIds: readonly string[], validity: string): string | null {
  if (!['Current', 'Proposed', 'Deferred'].includes(validity)) return null;
  const cited = known(store, sourceIds);
  if (cited.length === 0 || !cited.every(isHistoryOnly)) return null;
  return 'Every source this rule rests on is History only: a rule that exists only in an old version or a deleted file is no longer the project’s rule, and a rule in force goes into the start context, which history never enters. Cite where the project states it now; to record that the project changed a rule, write the old one as Replaced pointing to the rule in force.';
}

/** Why this `Used as` may not be given to this source, or null: what was read from version history stays History only. */
export function usedAsHistoryRefusal(source: Source, usedAs: string): string | null {
  if (source.anchor.kind !== 'revision' || usedAs === 'History only') return null;
  return `${source.id} was read from version history (${anchorLabel(source.anchor)}), so it is History only whatever it says: deletion or replacement is the signal that the project no longer needs it. Its Used as stays History only. If the current material says the same thing, cite the current material.`;
}
