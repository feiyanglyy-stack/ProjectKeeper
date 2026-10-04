/**
 * How a note came about (Spec §4.1, §4.2; D47 supplement, D56 item 5): `Product re-look`, `Change follow-up`,
 * `Investigation`, `Owner question`, `Organizing` (written while material was being organized) or `Takeover` (written
 * while the project was being taken over), named from the work that wrote it. A note from a change follow-up also names
 * the changes it is about, so the owner can tell at a glance which reminders it brought (§6.2).
 *
 * By the clerk method (Spec v3.0 §3.3) a note is written by a step of a round — the synthesis, which is the round's product
 * re-look, or the spot-check — and the round says how it came about: a note of a Follow up round came from following the
 * changes up; one of the first usable round or a deepening, from taking the project over. The D59 scopes this used to
 * read (`follow-up`, `change-follow-up`, `round`, `frame`, `takeover`) belong to jobs nothing creates any more.
 */
import type { KeeperJob, NoteCameFrom } from '../model/types.ts';
import type { NoteOrigin } from '../model/vocab.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { clerkRoundOfJob } from './roles.ts';

/** How a note came about from the kind of work outside a round: a re-look, an investigation, the owner's conversation. */
export function originOfJob(job: Pick<KeeperJob, 'kind' | 'scope'> | undefined | null): NoteOrigin | null {
  if (!job) return null;
  if (job.kind === 'Product re-look') return 'Product re-look';
  if (job.kind === 'Investigation') return 'Investigation';
  if (job.kind === 'Answering' || job.kind === 'Your request') return 'Owner question';
  if (job.kind === 'Organizing') return 'Organizing';
  return null;
}

/**
 * The changes a follow-up note is about: of the changes the round took up (every change when that is not known), those
 * whose downstream includes the object the note is mounted on.
 */
export function followUpChangesFor(store: ProjectStore, mountIds: readonly string[], candidates: readonly string[] | null): string[] {
  const pool = candidates ? candidates.flatMap((id) => store.changes.get(id) ?? []) : store.changes.all();
  return pool.filter((c) => c.propagation.some((p) => mountIds.includes(p.nodeId)) || c.affects.some((id) => mountIds.includes(id))).map((c) => c.id);
}

/** The changes a Follow up round took up: those its cross-check judged objects against, in the round's record (§5.5). */
function changesOfFollowUp(store: ProjectStore, recordId: string | null): string[] | null {
  if (!recordId) return null;
  const ids = store.propagation.filter((j) => j.roundId === recordId).flatMap((j) => [...j.covers, ...j.followed, ...j.lacks].map((i) => i.changeId));
  return ids.length ? [...new Set(ids)] : null;
}

export function cameFromFor(
  store: ProjectStore, job: KeeperJob | undefined | null, mountIds: readonly string[],
  opts: { readonly given?: readonly string[]; readonly candidates?: readonly string[] | null } = {},
): NoteCameFrom {
  const round = job ? clerkRoundOfJob(store, job) : null;
  const kind: NoteOrigin | null = round ? (round.kind === 'Follow up' ? 'Change follow-up' : 'Takeover') : originOfJob(job);
  let changeIds: string[] = [];
  if (kind === 'Change follow-up') {
    const given = (opts.given ?? []).filter((id) => store.changes.has(id));
    const known = opts.candidates ?? changesOfFollowUp(store, round?.followUpRoundId ?? null);
    changeIds = given.length ? given : followUpChangesFor(store, mountIds, known);
  }
  return { kind, jobKind: job?.kind ?? null, jobId: job?.id ?? null, changeIds };
}
