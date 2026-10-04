/**
 * The gate into a `Full` deepening's cross-check (D99; Spec §3.3 每份材料都有交代; CKC-23 AC-20; E148): `pk_stage`
 * (W1+W2) lets the main agent into `cross-check` only when the round's coverage is settled — every planned material read
 * whole or accounted for by the main agent; a follow-up lane settles only what it reads (Spec §3.3). The check itself is
 * coverage-tools.ts.
 */
import type { ClerkRound } from '../../model/k-types.ts';
import type { Project } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import type { Ledger } from '../../ledger/index.ts';
import { coverageSettledNow } from './coverage-tools.ts';

/**
 * Whether the round's coverage is settled. `opts` (optional): the project and the ledger when the caller has them; else
 * the project is read from the workspace beside the store and the ledger opened from the store's folder.
 */
export function coverageSettled(store: ProjectStore, round: ClerkRound, opts: { readonly project?: Project | null; readonly ledger?: Ledger | null } = {}): boolean {
  return coverageSettledNow(store, round, opts);
}
