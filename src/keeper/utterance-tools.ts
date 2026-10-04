/**
 * `pk_owner_utterances`: the owner's own words out of the project's sessions, for the framing round's "原话整理"
 * (Spec §3.3, §1.3, §3.7; CKC-05 AC-13). The rule of what counts is in sources/sessions/utterances.ts; this module pages
 * it for the model and reports how much there is (D37: how long this step takes grows with it).
 *
 * Interface (agreed with the framing round's prompts):
 *   pk_owner_utterances({ cursor?, limit?, since?, sessionSourceId? })
 *     → { utterances: [{ sourceId, host, at, text, chars, pasted?, headless?, truncated? }], next, total, totalChars, notYetRead? }
 */
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { ownerUtterances } from '../sources/sessions/utterances.ts';
import type { ToolContext } from './tools.ts';

/** One answer stays well inside what a tool result carries (120,000 characters); the cursor fetches the rest. */
const PAGE_CHARS = 80_000;

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }], details: {} };
}
function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }], details: {}, isError: true };
}

export function ownerUtteranceTools(ctx: ToolContext): ToolDefinition[] {
  return [defineTool({
    name: 'pk_owner_utterances', label: 'The owner’s own words',
    description: 'What the owner typed in this project’s sessions (Claude Code, Codex) and said in the Keeper conversation, oldest first — the input for the Owner’s words layer. Only the owner’s own messages: never tool results, blocks the host or system injected, command wrappers, compaction summaries, subagent branches, or the instruction files and environment Codex injects. Each message comes whole, as typed: sourceId (the session source to cite, whose excerpt holds these words), host, at, text, chars. pasted marks text inside the message that is recognisably pasted from elsewhere (a report, a log, code): character ranges of text with what makes them recognisable — the message is not cut; judge for yourself what the owner meant. headless: true marks a non-interactive run (codex exec, an SDK run), whose prompt is usually a program’s or an agent’s, not the owner’s. total and totalChars count everything that matches, not just this page; next is the cursor for the following page (null at the end). since: an ISO time or a date; sessionSourceId: any source of a session (or its session id) for that whole session.',
    parameters: Type.Object({
      cursor: Type.Optional(Type.String({ description: 'the next value of the previous answer' })),
      limit: Type.Optional(Type.Number({ description: 'most utterances per page (default 50, at most 500); a page also stops before it gets too long to answer' })),
      since: Type.Optional(Type.String({ description: 'only what was said at or after this ISO time or date' })),
      sessionSourceId: Type.Optional(Type.String({ description: 'one session: any of its source ids, or its session id' })),
    }),
    execute: async (_id, p) => {
      const found = ownerUtterances(ctx.store, { since: typeof p.since === 'string' ? p.since : null, sessionSourceId: typeof p.sessionSourceId === 'string' ? p.sessionSourceId : null });
      if (typeof found === 'string') return fail(found);
      const all = found.utterances;
      const cursor = typeof p.cursor === 'string' && p.cursor.trim() ? Number(p.cursor) : 0;
      if (!Number.isInteger(cursor) || cursor < 0 || cursor > all.length) return fail(`cursor “${p.cursor}” is not one this tool gave; start without a cursor.`);
      const limit = Math.max(1, Math.min(500, Math.floor(Number(p.limit) || 50)));
      const page: Record<string, unknown>[] = [];
      let room = PAGE_CHARS;
      let i = cursor;
      for (; i < all.length && page.length < limit; i++) {
        const u = all[i]!;
        const size = u.text.length + 300;
        if (page.length > 0 && size > room) break;
        // A single message longer than a page is given as far as a page goes; its source holds all of it.
        const truncated = u.text.length > PAGE_CHARS;
        page.push({
          sourceId: u.sourceId, host: u.host, at: u.at, text: truncated ? u.text.slice(0, PAGE_CHARS) : u.text, chars: u.chars,
          ...(u.pasted.length ? { pasted: u.pasted } : {}), ...(u.headless ? { headless: true } : {}), ...(truncated ? { truncated: true } : {}),
        });
        room -= size;
      }
      const totalChars = all.reduce((n, u) => n + u.chars, 0);
      return ok({
        utterances: page, next: i < all.length ? String(i) : null, total: all.length, totalChars,
        ...(found.notYetRead ? { notYetRead: found.notYetRead, note: `${found.notYetRead} owner message(s) in the session logs are in a part not read into the assets yet; they can be cited once it is (the next intake reads them).` } : {}),
      });
    },
  })];
}
