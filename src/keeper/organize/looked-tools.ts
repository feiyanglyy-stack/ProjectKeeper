/**
 * Where a lane looked for a breakpoint's missing step (Spec §2.12 没有痕迹，要读过才算; D99; W0 contract
 * `pk_record_looked({ breakpointId, where })` → `{ id, looked }`).
 *
 * The program's breakpoints are candidates: a lookup by number that found nothing. A lane reads where the step would be
 * written — the execution arrangement, the milestone summaries, the receipts, the QC reports, the ledger — and either
 * finds it, and links it (pk_link_process; a delivery link puts the candidate out), or does not, and records here where
 * it looked. Only then can the round's spot-check light it (process/breakpoint-candidates.ts). The record is kept while
 * the candidate holds on the same evidence (breakpoints.ts `reconcile`).
 */
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Breakpoint } from '../../model/k-types.ts';
import type { ClerkToolContext } from '../clerk-tools.ts';

/** The jobs that record where they looked: the lanes the main agent sends (clerk-steps.ts `LANE_ALWAYS`). */
const LOOKERS: readonly string[] = ['lane'];

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }], details: {} });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: `ERROR: ${message}` }], details: {}, isError: true });

export function lookedTools(ctx: ClerkToolContext): ToolDefinition[] {
  const { store } = ctx;
  return [defineTool({
    name: 'pk_record_looked', label: 'Record where you looked for a missing step',
    description: 'A lane (a missing step counts only after reading): for a breakpoint candidate the program computed — a lookup by number that found nothing — record where you read for the missing step and did not find it. Name each place as the spot-check can open it: a file with its section or lines, a ledger query, a commit range. If you found the step, do not call this: link what you found (pk_link_process), which puts the candidate out. Only a candidate a lane looked for can be lit, and only by the round’s independent spot-check. Calling it again replaces where you looked.',
    parameters: Type.Object({
      breakpointId: Type.String({ description: 'the breakpoint candidate’s id (bp_…)' }),
      where: Type.Array(Type.String(), { description: 'each place you read for the missing step, as the spot-check can open it again' }),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const step = ctx.step;
      if (!step || !LOOKERS.includes(step.kind)) {
        return fail(`pk_record_looked records where a lane looked for a breakpoint's missing step; this job is ${step ? `the round's ${step.kind}` : 'no step of a round'}, so nothing was written.`);
      }
      const id = typeof p.breakpointId === 'string' ? p.breakpointId.trim() : '';
      const bp = store.breakpoints.get(id);
      if (!bp) return fail(`${id || '(empty)'} is not a breakpoint of the assets.`);
      if (bp.out) {
        return fail(`${id} (${bp.kind} on ${bp.targetId}) is already out (${bp.out.by}${bp.ownerResponse ? ': the owner answered No action needed' : ''}, ${bp.out.at}): there is no missing step to look for. Nothing was written.`);
      }
      const where = [...new Set((Array.isArray(p.where) ? p.where : []).filter((w): w is string => typeof w === 'string').map((w) => w.trim()).filter(Boolean))];
      if (where.length === 0) return fail('where: each place you read for the missing step (a file and its section or lines, a ledger query, a commit range), so the spot-check can read it again. Nothing was written.');
      const at = new Date().toISOString();
      const looked: NonNullable<Breakpoint['looked']> = { roundId: step.roundId, jobId: ctx.jobId, where, at };
      store.breakpoints.put({ ...bp, looked, updatedAt: at }, {
        jobId: ctx.jobId, summary: `Looked for ${bp.kind} on ${bp.targetId}, not found: ${where.join('; ').slice(0, 200)}`,
      });
      ctx.onSaved?.('breakpoints', id, `Looked: ${bp.kind}`);
      return ok({ id, looked });
    },
  })];
}
