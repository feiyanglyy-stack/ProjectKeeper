/**
 * A project's schedule against its own record (Spec §3.8; CKC-07 AC-28～AC-30): the schedule in force, the scheduled
 * time that is due, and the next one. The planner (clerk.ts) and the `Daily` page (keeper-page.ts) read the same
 * functions, so the page says what the planner will do.
 */
import type { OrganizeSchedule, Project } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { nextSlot, scheduleOf, scheduledDue } from './schedule.ts';

type ScheduleProject = Pick<Project, 'schedule' | 'organizeRhythm' | 'scheduleHandled'>;

/** When the project's latest round ended; null when none has. */
export function lastRoundEnd(store: ProjectStore): string | null {
  return store.clerkRounds.all().reduce<string | null>((at, r) => (r.endedAt && (!at || r.endedAt > at) ? r.endedAt : at), null);
}

/** The schedule in force: the one saved, or the default from when the takeover finished (§3.8). */
export function scheduleInForce(project: ScheduleProject, takeoverDoneAt: string | null): OrganizeSchedule {
  return scheduleOf(project, { takeoverDoneAt });
}

/**
 * From when scheduled times count: the latest of when the schedule was saved, when the takeover finished, and the last
 * scheduled time already dealt with. Times before it are not made up for.
 */
function since(schedule: OrganizeSchedule, project: ScheduleProject, takeoverDoneAt: string | null): Date {
  return new Date([schedule.savedAt, takeoverDoneAt, project.scheduleHandled?.slot].reduce<number>((at, x) => Math.max(at, x ? Date.parse(x) : 0), 0));
}

/** The scheduled time that has come and was not dealt with, with how many were missed; null when none. */
export function scheduleDueFor(_store: ProjectStore, project: ScheduleProject, takeoverDoneAt: string | null, now: number): { readonly slot: Date; readonly missed: number } | null {
  const schedule = scheduleInForce(project, takeoverDoneAt);
  return scheduledDue(schedule, new Date(now), since(schedule, project, takeoverDoneAt));
}

/** The next scheduled time after now; null when the schedule starts nothing by the clock (`Off`, `Continuous`). */
export function nextScheduled(project: ScheduleProject, takeoverDoneAt: string | null, now: number): Date | null {
  return nextSlot(scheduleInForce(project, takeoverDoneAt), new Date(now));
}
