/**
 * What a round found when it put out a breakpoint about delivery (Spec §2.12; §1.4: links tie what the program could not
 * tie by ids). A cross-check that puts out `No trace of done` or `Not started` cites what shows the step did happen; the
 * commits it cites are the work's delivery, which the program could not tie by the work's number. They become confirmed
 * `Delivered` links — the links pk_link_process writes, under the same ids — so the process view and the work's execution
 * read them (work.ts `executionOf`). Seen on the resident run: the cross-check put out 16 `No trace of done`, each citing
 * the work's own commits, and the List still said `Not started` beside every one.
 */
import type { Breakpoint, EvidenceRef, ProcessLink } from '../model/k-types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { stableId } from '../model/ids.ts';
import { pathKey } from '../util/paths.ts';

const ABOUT_DELIVERY: ReadonlySet<string> = new Set(['No trace of done', 'Not started']);

/** The id pk_link_process gives a work item, fact and step: linking the same again updates it. */
export function linkId(projectId: string, workId: string, ledgerRef: string, stepKind: string, fact: EvidenceRef): string {
  return stableId('link', projectId, workId, ledgerRef, stepKind, fact.line ?? '', ...(fact.repo ? [pathKey(fact.repo)] : []));
}

/** The commits a put-out breakpoint about delivery cites, as confirmed `Delivered` links of its work item. Returns how many were written. */
export function deliveryLinksFrom(
  store: ProjectStore, bp: Breakpoint, evidence: readonly EvidenceRef[], why: string,
  meta: { readonly roundId: string | null; readonly jobId: string | null; readonly at: string },
): number {
  if (!ABOUT_DELIVERY.has(bp.kind) || !store.threads.get(bp.targetId)) return 0;
  let written = 0;
  for (const fact of evidence) {
    if (fact.kind !== 'commit') continue;
    const ledgerRef = `commit:${fact.id}`;
    const id = linkId(bp.projectId, bp.targetId, ledgerRef, 'Delivered', fact);
    if (store.links.get(id)?.confirmed) continue;
    const link: ProcessLink = {
      id, projectId: bp.projectId, workId: bp.targetId, ledgerRef, evidence: fact, stepKind: 'Delivered', why, basis: 'Inferred', confirmed: true,
      roundId: meta.roundId, jobId: meta.jobId, at: meta.at,
    };
    store.links.put(link, { jobId: meta.jobId, basisSourceIds: [], summary: `Link Delivered: ${fact.label} → ${bp.targetId} (the round put out ${bp.kind} citing it)` });
    written++;
  }
  return written;
}

/** At start: breakpoints a round put out before this existed tie the commits they cite too. Returns how many links were written. */
export function linkPutOutDeliveries(store: ProjectStore): number {
  let written = 0;
  for (const bp of store.breakpoints.filter((b) => b.out?.by === 'model' && ABOUT_DELIVERY.has(b.kind))) {
    written += deliveryLinksFrom(store, bp, bp.out!.evidence ?? [], `The round put out ${bp.kind} citing this commit as the work's delivery`, {
      roundId: bp.out!.decision?.roundId ?? null, jobId: null, at: bp.out!.at,
    });
  }
  return written;
}
