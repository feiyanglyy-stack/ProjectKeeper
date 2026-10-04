/**
 * Where a project's takeover stands (Spec §3.7, §6.10; D105; CKC-13 AC-19, AC-20, AC-23).
 *
 * A project that was added does nothing until the owner chooses a depth on the `Takeover` page and presses `Start`.
 * From then on the three depths cannot be pressed; when the takeover is done the page says which depth ran. That is read
 * from the rounds — a deepening records the depth it started at — never from the last button pressed: on 2026-10-02 the
 * owner pressed `Focused` after a `Full` deepening had finished, no round ran, and the page then said `Focused`.
 * A depth deeper than the one that ran stays selectable and continues from what is done; the same and shallower ones
 * need a `Clear` first.
 */
import type { KeeperJob, Project } from '../../model/types.ts';
import type { ClerkRound } from '../../model/k-types.ts';
import type { TakeoverDepth } from '../../model/vocab.ts';
import { TAKEOVER_DEPTH } from '../../model/vocab.ts';
import type { ProjectStore } from '../../store/project-store.ts';

export const DEPTH_RANK: Readonly<Record<TakeoverDepth, number>> = { 'First picture only': 0, Focused: 1, Full: 2 };
const deeper = (a: TakeoverDepth, b: TakeoverDepth | null): boolean => b === null || DEPTH_RANK[a] > DEPTH_RANK[b];
const isDepth = (v: unknown): v is TakeoverDepth => (TAKEOVER_DEPTH as readonly unknown[]).includes(v);

export type TakeoverPhase = 'Not started' | 'Under way' | 'Done';

export interface TakeoverState {
  readonly phase: TakeoverPhase;
  /** The depth the takeover runs to: what the owner pressed `Start` with. Null before the start. */
  readonly chosen: TakeoverDepth | null;
  /** The deepest depth that actually finished, from the rounds. Null until the first usable round is done. */
  readonly ran: TakeoverDepth | null;
  readonly startedAt: string | null;
  /** When the chosen depth was reached: the end of the round that reached it. */
  readonly completedAt: string | null;
  /** The takeover's rounds, oldest first. */
  readonly rounds: readonly ClerkRound[];
  /** Each depth: whether it can be chosen now, and when not, why — said on the page beside it. */
  readonly options: readonly { readonly depth: TakeoverDepth; readonly selectable: boolean; readonly why: string | null; readonly ran: boolean; readonly chosen: boolean }[];
}

/**
 * The depth a deepening round ran at: recorded on the round since D105; on a round from before, read from the label its
 * own record was given when it started (`Takeover round 2: deepening (Full)`), which was written from the depth in force
 * then and not touched since.
 */
export function roundDepth(round: ClerkRound, rootJob: KeeperJob | undefined): TakeoverDepth | null {
  if (round.kind !== 'Deepen') return null;
  if (isDepth(round.depth)) return round.depth;
  const m = /deepening \(([^)]+)\)/.exec(rootJob?.scope.label ?? '');
  return m && isDepth(m[1]) ? m[1] : null;
}

type StateProject = Pick<Project, 'takeoverDepth' | 'takeoverStartedAt' | 'takeoverDepthChosenAt' | 'createdAt'>;

export function takeoverState(store: ProjectStore, project: StateProject): TakeoverState {
  const rounds = store.clerkRounds.filter((r) => r.kind === 'First usable' || r.kind === 'Deepen').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const first = rounds.filter((r) => r.kind === 'First usable').pop();
  const firstDone = first?.status === 'Done';
  // The deepest depth a finished round reached. A deepening from before D105 whose depth cannot be read was `Full` or
  // `Focused`; it is taken as the shallower, so a deeper choice is never refused on a guess.
  let ran: TakeoverDepth | null = firstDone ? 'First picture only' : null;
  let reachedAt: string | null = firstDone ? first!.endedAt : null;
  if (firstDone) {
    for (const r of rounds.filter((x) => x.kind === 'Deepen' && x.status === 'Done')) {
      const d = roundDepth(r, store.jobs.get(r.rootJobId)) ?? 'Focused';
      if (deeper(d, ran)) { ran = d; reachedAt = r.endedAt; }
    }
  }
  const started = Boolean(project.takeoverStartedAt) || rounds.length > 0;
  // What the takeover runs to. A home from before D105 whose first usable round ran with no depth chosen stood at the
  // old depth question, which behaved as `First picture only`; one whose field was overwritten after a deeper round
  // finished runs to what ran.
  let chosen: TakeoverDepth | null = started ? (isDepth(project.takeoverDepth) ? project.takeoverDepth : 'First picture only') : null;
  if (chosen && ran && deeper(ran, chosen)) chosen = ran;
  const phase: TakeoverPhase = !started ? 'Not started' : ran !== null && chosen !== null && DEPTH_RANK[ran] >= DEPTH_RANK[chosen] ? 'Done' : 'Under way';
  const options = TAKEOVER_DEPTH.map((depth) => {
    const base = { depth, ran: ran === depth && phase === 'Done', chosen: chosen === depth };
    if (phase === 'Not started') return { ...base, selectable: true, why: null };
    if (phase === 'Under way') return { ...base, selectable: false, why: `The takeover is under way at ${chosen}. Stop the round to pause it, or Clear to choose again.` };
    if (deeper(depth, ran)) return { ...base, selectable: true, why: null };
    return { ...base, selectable: false, why: depth === ran ? `${depth} has run. To run it again from the beginning, Clear first.` : `${ran} has run, which goes deeper than ${depth}. To go shallower, Clear first.` };
  });
  return {
    phase, chosen, ran, rounds, options,
    startedAt: started ? project.takeoverStartedAt ?? rounds[0]?.startedAt ?? null : null,
    completedAt: phase === 'Done' ? reachedAt : null,
  };
}

/**
 * Whether `Start` may be pressed with this depth now, and when not, why (§3.7 规则; CKC-13 AC-19, AC-23). `keyUsable`:
 * whether a model with a usable key is there; without one the takeover would start and do nothing.
 */
export function startRefusal(state: TakeoverState, depth: unknown, keyUsable: boolean): string | null {
  if (!isDepth(depth)) return `Choose a depth: ${TAKEOVER_DEPTH.join(', ')}`;
  const option = state.options.find((o) => o.depth === depth)!;
  if (!option.selectable) return option.why ?? `${depth} cannot be chosen now`;
  if (!keyUsable) return 'No usable key: set a key and a model in Model provider first';
  return null;
}

/** Whether the takeover is done, so the schedule and Follow up apply (§3.8; CKC-07 AC-17, AC-28). */
export const takeoverDone = (store: ProjectStore, project: StateProject): boolean => takeoverState(store, project).phase === 'Done';
