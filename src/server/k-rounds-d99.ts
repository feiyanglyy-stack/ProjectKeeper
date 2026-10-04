/**
 * A round run by the main agent (D99; Spec §3.3, §3.10, §6.9) as the Keeper view's round tree shows it: the main agent with
 * the stage it is in and each stage's time, the lanes it sent — what each answers, the slots it writes, its status, what it
 * read, its brief and its report — the coverage check with each account, and the missing steps the lanes looked for and
 * the spot-check confirmed. Pure reads of the round record, its jobs, its documents and the breakpoints.
 */
import type { ProjectStore } from '../store/project-store.ts';
import type { KeeperJob, Usage } from '../model/types.ts';
import type { ClerkRound, RoundDoc } from '../model/k-types.ts';
import type { RoundCoverageView, RoundDocRef, RoundLaneView, RoundMainView, RoundView } from '../model/views-k.ts';

/** A round the main agent runs: it has a stage (null before orientation) or a stage log; a round from before D99 has neither. */
export const isMainAgentRound = (r: ClerkRound): boolean => r.stage !== undefined || r.stageLog !== undefined;

const docRef = (d: RoundDoc): RoundDocRef => ({ id: d.id, kind: d.kind, title: d.title, path: d.path, at: d.at });

/** The question a lane answers, as its brief opens: the first lines that are not headings. */
export function questionOf(markdown: string, lines = 3): string | null {
  const text = markdown.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^#{1,6}\s/.test(l) && !/^[-*_]{3,}$/.test(l)).slice(0, lines);
  return text.length ? text.join('\n') : null;
}

/**
 * What jobs read, each material once, from their steps' recorded reads (`JobStep.reads`): a file as it stands, a version
 * of a file at a commit, a commit, a session. A search reads nothing; a step recorded before reads were kept counts none.
 */
export function readsOf(jobs: Iterable<KeeperJob>): RoundLaneView['read'] {
  const files = new Set<string>(), versions = new Set<string>(), commits = new Set<string>(), sessions = new Set<string>();
  for (const j of jobs) for (const s of j.steps) for (const r of s.reads ?? []) {
    if (r.session) sessions.add(r.session);
    else if (r.path && r.rev) versions.add(`${r.path.toLowerCase()}@${r.rev.toLowerCase().slice(0, 12)}`);
    else if (r.path) files.add(r.path.toLowerCase());
    else if (r.rev) commits.add(r.rev.toLowerCase().slice(0, 12));
  }
  return { files: files.size, versions: versions.size, commits: commits.size, sessions: sessions.size };
}

/** A job and every job under it (the investigations a lane sent). */
export function withSent(store: ProjectStore, job: KeeperJob): KeeperJob[] {
  const kids = store.jobs.filter((c) => c.parentJobId === job.id);
  return [job, ...kids.flatMap((k) => withSent(store, k))];
}

/** The parts of `RoundView` a main-agent round adds; `usageOf` sums a set of jobs as the round's usage does. */
export function mainAgentParts(store: ProjectStore, r: ClerkRound, jobs: readonly KeeperJob[], usageOf: (jobs: readonly KeeperJob[]) => Usage): Pick<RoundView, 'main' | 'lanes' | 'coverage' | 'missing'> {
  const docs = store.roundDocs.filter((d) => d.roundId === r.id);
  const mainJob = jobs.filter((j) => j.step!.kind === 'main').sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)).pop() ?? null;
  const log = r.stageLog ?? [];
  // D103: once handed over, the main agent is in no stage any more; its Handover document opens from the tree.
  const handoverDoc = r.handover ? store.roundDocs.get(r.handover.docId) : undefined;
  const main: RoundMainView = {
    jobId: mainJob?.id ?? null, stage: r.stage ?? null,
    stages: log.map((e, i) => ({ stage: e.stage, startedAt: e.startedAt, endedAt: e.endedAt, timing: e.timing, current: i === log.length - 1 && e.endedAt === null && e.stage === r.stage })),
    ...(r.handover ? { handover: { at: r.handover.at, doc: handoverDoc ? docRef(handoverDoc) : null } } : {}),
  };
  // The lanes the round records, in the order sent; a lane job the record does not name yet (sent a moment ago) after them.
  const recorded = r.lanes ?? [];
  const laneJobs = jobs.filter((j) => j.step!.kind === 'lane');
  const extra = laneJobs.filter((j) => !recorded.some((l) => l.jobId === j.id || l.name === j.step!.path));
  const lanes: RoundLaneView[] = [
    ...recorded.map((l) => ({ lane: l, job: laneJobs.find((j) => j.id === l.jobId) ?? store.jobs.get(l.jobId) ?? null })),
    ...extra.map((j) => ({ lane: null, job: j })),
  ].map(({ lane, job }) => {
    const name = lane?.name ?? job!.step!.path ?? job!.scope.label;
    const brief = (lane ? store.roundDocs.get(lane.briefDocId) : undefined) ?? docs.find((d) => d.kind === 'Brief' && d.path === name && d.jobId !== job?.id);
    const report = (lane?.reportDocId ? store.roundDocs.get(lane.reportDocId) : undefined)
      ?? docs.filter((d) => d.kind === 'Report' && (d.path === name || (job !== null && d.jobId === job.id))).sort((a, b) => a.at.localeCompare(b.at)).pop();
    const sent = job ? withSent(store, job) : [];
    return {
      name, kind: lane?.kind ?? job!.step!.lane?.kind ?? 'topic', slots: lane?.slots ?? job!.step!.lane?.slots ?? [],
      stage: lane?.stage ?? null, sentAt: lane?.sentAt ?? job?.queuedAt ?? null,
      question: brief ? questionOf(brief.markdown) : null,
      jobId: job?.id ?? lane?.jobId ?? null, status: job?.status ?? 'Queued', model: job?.model ?? null,
      startedAt: job?.startedAt ?? null, endedAt: job?.endedAt ?? null, timing: job?.timing ?? null,
      usage: sent.length ? usageOf(sent) : null,
      brief: brief ? docRef(brief) : null, report: report ? docRef(report) : null,
      read: readsOf(sent),
    };
  });
  const c = r.coverage ?? null;
  const coverage: RoundCoverageView | null = c ? { at: c.at, settled: c.settled, untouched: c.untouched ?? null, accounted: c.accounted } : null;
  const bps = store.breakpoints.all();
  const missing = { looked: bps.filter((b) => b.looked?.roundId === r.id).length, checked: bps.filter((b) => b.checked?.roundId === r.id).length };
  return { main, lanes, coverage, missing };
}

/** The main job's own documents, less the briefs of its lanes: those stand under each lane. */
export function mainDocsOf(docs: readonly RoundDocRef[], lanes: readonly RoundLaneView[]): RoundDocRef[] {
  const briefs = new Set(lanes.flatMap((l) => (l.brief ? [l.brief.id] : [])));
  return docs.filter((d) => !briefs.has(d.id));
}
