/**
 * Whether automatic organizing is held right now (Spec §3.8, §3.10). Pausing holds the rounds that open by themselves;
 * a round the owner starts with Follow up runs anyway, and when it has run out of work the pause holds again. The
 * owner's own questions, corrections and requests, and execution agents' queries, have their own lane and are never
 * held by the pause or the rhythm.
 */
import type { Project } from '../model/types.ts';

export function ownerRoundOpen(p: Pick<Project, 'followUpAt' | 'lastRoundAt'>): boolean {
  return Boolean(p.followUpAt && (!p.lastRoundAt || p.lastRoundAt < p.followUpAt));
}

export function organizingHeld(p: Pick<Project, 'organizingPaused' | 'followUpAt' | 'lastRoundAt'>): boolean {
  return Boolean(p.organizingPaused) && !ownerRoundOpen(p);
}
