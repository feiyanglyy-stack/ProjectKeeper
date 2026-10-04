/**
 * The notes still current from earlier rounds (E153, the owner, 2026-10-01: 「first usable 不去full synthesis check 理论上
 * 第二轮应该其实是比较容易看出矛盾的，但是我不确定第二轮是确定会纠正么。」).
 *
 * On the CM run the first usable round's two notes — one of them For your decision — were untouched by the deepening
 * (still version 1) and were not among its spot-check's targets: nothing made a later round look at them again. So in a
 * deepening and a Follow up:
 * - the synthesis is given every note that was current when the round began (`standingNotesBlock`) and gives each one
 *   result — **confirmed** as still holding, with what it read (`pk_confirm_note`, recorded in its judgement record);
 *   **updated** (`pk_write_note` with its id: a new version); or **withdrawn**, with why (`pk_close_note`: Resolved or
 *   Withdrawn);
 * - a standing note with no result is an open item of the round (`pk_round_state` open `standingNotes`), and the round
 *   keeps the three counts (`standingCounts`);
 * - the spot-check checks every note current at the end of the round, this round's and the standing ones, in full
 *   (process/breakpoint-candidates.ts `spotCheckTargets`).
 *
 * The first usable round has no earlier round, and gets no such list.
 *
 * The program reads the result off the records: the note was closed since the round began (withdrawn; the note states
 * Resolved or Withdrawn, Spec §2.7), it has a version written since the round began (updated), or the judgement record of
 * this round's synthesis says it still holds, with what was read (confirmed; CKC-08 AC-25 — no new version is written).
 */
import type { ClerkRound } from '../../model/k-types.ts';
import type { Note } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';

export type StandingResult = 'confirmed' | 'updated' | 'withdrawn';

export interface StandingNote {
  readonly note: Note;
  /** What this round did with it; null while it has no result. */
  readonly result: StandingResult | null;
}

export interface StandingCounts {
  /** The notes that were current when the round began. */
  readonly standing: number;
  readonly confirmed: number;
  readonly updated: number;
  readonly withdrawn: number;
  /** Those with no result yet. */
  readonly open: number;
}

type RoundRef = Pick<ClerkRound, 'id' | 'kind' | 'startedAt'>;

const firstAt = (n: Note): string => n.versions[0]?.at ?? n.updatedAt;
const lastOf = (n: Note) => n.versions[n.versions.length - 1];

/**
 * A note the program wrote itself (the takeover's depth question, service.ts `writeDepthNote`): the planner's question to
 * the owner, not a judgement of a round — no synthesis gives it a result and no spot-check checks it.
 */
export const isProgramNote = (note: Pick<Note, 'author'>): boolean => note.author.agent === 'ProjectKeeper';

/** Whether a round looks at the standing notes: a deepening and a Follow up; the first usable round has none before it. */
export const looksAtStandingNotes = (round: Pick<ClerkRound, 'kind'>): boolean => round.kind !== 'First usable';

/**
 * The notes that were current when the round began, each with what the round did with it. A note written before the
 * round began is standing when it is current now, or was closed since the round began (it stood, and the round — or the
 * owner meanwhile — withdrew it).
 */
export function standingNotes(store: ProjectStore, round: RoundRef): StandingNote[] {
  if (!looksAtStandingNotes(round)) return [];
  const held = stillHolding(store, round.id);
  const out: StandingNote[] = [];
  for (const note of store.notes.all()) {
    if (isProgramNote(note)) continue;
    if (firstAt(note) >= round.startedAt) continue;   // written in this round: not standing
    if (note.status !== 'Current') {
      if (note.updatedAt >= round.startedAt) out.push({ note, result: 'withdrawn' });
      continue;
    }
    const result: StandingResult | null = (lastOf(note)?.at ?? '') >= round.startedAt ? 'updated' : held.has(note.id) ? 'confirmed' : null;
    out.push({ note, result });
  }
  return out.sort((a, b) => firstAt(a.note).localeCompare(firstAt(b.note)) || a.note.id.localeCompare(b.note.id));
}

/** The notes the judgement records of this round's jobs say still hold, each with what was read (the latest say). */
export function stillHolding(store: ProjectStore, roundId: string): Map<string, { readonly read: readonly string[]; readonly at: string }> {
  const jobs = new Set(store.jobs.filter((j) => j.step?.roundId === roundId).map((j) => j.id));
  const out = new Map<string, { read: readonly string[]; at: string }>();
  for (const j of store.judgements.filter((x) => jobs.has(x.jobId))) for (const h of j.outcome.stillHolds ?? []) {
    if ((out.get(h.noteId)?.at ?? '') <= h.at) out.set(h.noteId, { read: h.read, at: h.at });
  }
  return out;
}

/** The standing notes counted by result. */
export function standingCounts(store: ProjectStore, round: RoundRef): StandingCounts {
  const all = standingNotes(store, round);
  const n = (r: StandingResult | null) => all.filter((s) => s.result === r).length;
  return { standing: all.length, confirmed: n('confirmed'), updated: n('updated'), withdrawn: n('withdrawn'), open: n(null) };
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const one = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** What a standing note is mounted on, in a few words. */
function mountOf(store: ProjectStore, note: Note): string {
  if (note.mount.kind === 'project' || !note.mount.ids.length) return 'the project';
  const name = (id: string): string => {
    const t = store.threads.get(id);
    if (t) return `${t.ids[0] ? `${t.ids[0]} ` : ''}${t.title} (${id})`;
    const r = store.reference.get(id);
    return r ? `${r.category} ${r.name} (${id})` : id;
  };
  return note.mount.ids.slice(0, 3).map(name).join(', ') + (note.mount.ids.length > 3 ? `, and ${note.mount.ids.length - 3} more` : '');
}

/** A standing note as the open list and the synthesis' block give it: its id, title, ask, what it claims and its sources. */
export function standingItem(store: ProjectStore, s: StandingNote): { readonly id: string; readonly name: string; readonly ask: string; readonly since: string; readonly on: string; readonly claims: string; readonly sources: readonly string[] } {
  const v = lastOf(s.note);
  const sources = [...new Set((v?.body.facts ?? []).flatMap((f) => f.sourceIds))];
  return { id: s.note.id, name: v?.title ?? s.note.id, ask: v?.ask ?? '', since: firstAt(s.note).slice(0, 10), on: mountOf(store, s.note), claims: clip(one(v?.preview ?? ''), 320), sources };
}

/** How many source ids of a note the synthesis' block names; the note itself holds them all. */
const SOURCES_SHOWN = 6;

/**
 * The synthesis' block of the notes still current from earlier rounds: each with its id, title, ask, what it claims and
 * its sources, and the one result it is to get. Empty for a round with none.
 */
export function standingNotesBlock(store: ProjectStore, round: RoundRef): string | null {
  const all = standingNotes(store, round);
  if (!all.length) return null;
  const lines = [
    `=== Notes still current from earlier rounds (${all.length}): give each one result`,
    'The owner still reads each of these as the Keeper\'s view. Check each against what this round found, then give it one result: it still holds — pk_confirm_note({ id, read }) with what you read that shows it; it holds in part or needs more — pk_write_note({ id, … }), which writes a new version; it no longer holds — pk_close_note({ id, status, reason }) (Resolved when the situation is gone, Withdrawn when the judgement was wrong). One with no result stays listed as open (pk_round_state open standingNotes). Read a note in full with pk_read_assets kind note.',
  ];
  for (const s of all) {
    const i = standingItem(store, s);
    lines.push(`- ${i.id} · “${clip(i.name, 120)}” · ${i.ask} · since ${i.since} · on ${i.on}${s.result ? ` · ${s.result} this round` : ''}`);
    if (i.claims) lines.push(`  claims: ${i.claims}`);
    if (i.sources.length) lines.push(`  sources: ${i.sources.slice(0, SOURCES_SHOWN).join(', ')}${i.sources.length > SOURCES_SHOWN ? `, and ${i.sources.length - SOURCES_SHOWN} more` : ''}`);
  }
  return lines.join('\n');
}
