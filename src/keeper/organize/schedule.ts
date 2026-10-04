/**
 * The schedule of daily organizing (Spec §3.8, §6.10; D105; CKC-07 AC-18, AC-28～AC-30).
 *
 * The owner sets how often a round starts by itself and at what time of day, on the `Daily` page: `Off`, `Every day`,
 * `On selected days`, `Every N days` — each of the last three with a time — or `Continuous`. Times are this machine's
 * local time. A project whose schedule was never saved runs `Every day` at the time of day its takeover finished.
 *
 * Everything here is computed: which scheduled time comes next, which one was the last to pass, and whether one is due.
 * The planner (clerk.ts) asks `scheduledDue` and stamps what it did with the time on the project (`scheduleHandled`), so
 * a time that passed while ProjectKeeper was not running, or the machine slept, is made up for with one round however
 * many were missed, and no time is dealt with twice.
 */
import type { OrganizeSchedule, Project, ScheduleFrequency } from '../../model/types.ts';

export const SCHEDULE_FREQUENCIES: readonly ScheduleFrequency[] = ['Off', 'Every day', 'On selected days', 'Every N days', 'Continuous'];
/** The frequencies that start a round at a time of day. */
export const TIMED_FREQUENCIES: readonly ScheduleFrequency[] = ['Every day', 'On selected days', 'Every N days'];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const DAY_MS = 24 * 60 * 60_000;
/** How far a search for a scheduled time looks: more than the longest `Every N days` allowed. */
const MAX_EVERY_DAYS = 365;

const pad = (n: number) => String(n).padStart(2, '0');
/** The local time of day of an instant, `HH:MM`. */
export const localTime = (at: Date): string => `${pad(at.getHours())}:${pad(at.getMinutes())}`;
/** The local date of an instant, `YYYY-MM-DD`. */
export const localDate = (at: Date): string => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

const parseTime = (time: string): { h: number; m: number } | null => {
  const x = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  return x ? { h: Number(x[1]), m: Number(x[2]) } : null;
};

/** What the owner sent from the `Daily` page, checked: the schedule to save, or why it cannot be saved. */
export function parseSchedule(input: unknown, now = new Date()): { schedule: OrganizeSchedule } | { error: string } {
  const b = (input ?? {}) as Record<string, unknown>;
  const frequency = b.frequency;
  if (typeof frequency !== 'string' || !(SCHEDULE_FREQUENCIES as readonly string[]).includes(frequency)) return { error: `frequency must be one of ${SCHEDULE_FREQUENCIES.join(', ')}` };
  const f = frequency as ScheduleFrequency;
  const timed = TIMED_FREQUENCIES.includes(f);
  const time = typeof b.time === 'string' ? b.time.trim() : '';
  const t = parseTime(time);
  if (timed && !t) return { error: 'time must be a time of day, HH:MM' };
  const base = { frequency: f, time: t ? `${pad(t.h)}:${pad(t.m)}` : '00:00', savedAt: now.toISOString() };
  if (f === 'On selected days') {
    const days = Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((x, y) => x - y) : [];
    if (!days.length) return { error: 'Choose at least one day of the week' };
    return { schedule: { ...base, days } };
  }
  if (f === 'Every N days') {
    const n = Number(b.everyDays);
    if (!Number.isInteger(n) || n < 1 || n > MAX_EVERY_DAYS) return { error: `everyDays must be a whole number from 1 to ${MAX_EVERY_DAYS}` };
    return { schedule: { ...base, everyDays: n, anchor: localDate(now) } };
  }
  return { schedule: base };
}

/**
 * The schedule in force for a project. One the owner saved stands as saved. Otherwise the default (§3.8): `Every day` at
 * the time of day the takeover finished — which is also what a home from before D105 gets from its `Daily` rhythm (its
 * last round's end, when there is one: a day after the last round is what `Daily` meant); its `Continuous` stays.
 * `takeoverDoneAt` is when the takeover finished, `lastRoundEnd` when the project's latest round ended.
 */
export function scheduleOf(project: Pick<Project, 'schedule' | 'organizeRhythm'>, when: { readonly takeoverDoneAt?: string | null; readonly lastRoundEnd?: string | null } = {}): OrganizeSchedule {
  if (project.schedule) return project.schedule;
  if (project.organizeRhythm === 'Continuous') return { frequency: 'Continuous', time: '00:00', savedAt: null };
  const from = when.lastRoundEnd ?? when.takeoverDoneAt ?? null;
  return { frequency: 'Every day', time: from ? localTime(new Date(from)) : '09:00', savedAt: null };
}

/** Whether a local calendar day is one the schedule starts a round on. */
function onDay(s: OrganizeSchedule, day: Date): boolean {
  if (s.frequency === 'Every day') return true;
  if (s.frequency === 'On selected days') return (s.days ?? []).includes(day.getDay());
  if (s.frequency === 'Every N days') {
    const n = Math.max(1, s.everyDays ?? 1);
    const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.anchor ?? '');
    const anchor = a ? new Date(Number(a[1]), Number(a[2]) - 1, Number(a[3])) : new Date(day.getFullYear(), day.getMonth(), day.getDate());
    // Whole local days between the two dates; rounding absorbs the hour a daylight-saving change adds or removes.
    const days = Math.round((new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() - anchor.getTime()) / DAY_MS);
    return days >= 0 && days % n === 0;
  }
  return false;
}

/** The scheduled time on a local calendar day. */
function slotOn(s: OrganizeSchedule, day: Date): Date {
  const t = parseTime(s.time) ?? { h: 0, m: 0 };
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), t.h, t.m, 0, 0);
}

/** The first scheduled time strictly after `after`; null when the schedule starts nothing by the clock. */
export function nextSlot(s: OrganizeSchedule, after: Date): Date | null {
  if (!TIMED_FREQUENCIES.includes(s.frequency)) return null;
  for (let i = 0; i <= MAX_EVERY_DAYS + 7; i++) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i);
    if (!onDay(s, day)) continue;
    const slot = slotOn(s, day);
    if (slot.getTime() > after.getTime()) return slot;
  }
  return null;
}

/** The latest scheduled time at or before `now`, no earlier than `notBefore`; null when none has passed since then. */
export function lastSlot(s: OrganizeSchedule, now: Date, notBefore: Date): Date | null {
  if (!TIMED_FREQUENCIES.includes(s.frequency)) return null;
  for (let i = 0; i <= MAX_EVERY_DAYS + 7; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const slot = slotOn(s, day);
    if (slot.getTime() <= notBefore.getTime()) return null;
    if (onDay(s, day) && slot.getTime() <= now.getTime()) return slot;
  }
  return null;
}

/**
 * Whether a scheduled time has come that was not dealt with yet (§3.8 到了时间). `since` is the later of: when the
 * schedule was saved, when the takeover finished, and the last scheduled time already dealt with — times before it are
 * not made up for. `missed` counts the scheduled times that passed since then; however many, one round makes up for them.
 */
export function scheduledDue(s: OrganizeSchedule, now: Date, since: Date): { readonly slot: Date; readonly missed: number } | null {
  const slot = lastSlot(s, now, since);
  if (!slot) return null;
  let missed = 0;
  for (let at = nextSlot(s, since); at && at.getTime() <= now.getTime() && missed < 1000; at = nextSlot(s, at)) missed += 1;
  return { slot, missed: Math.max(1, missed) };
}

/** The schedule in one line, as the `Daily` page and the context say it. */
export function scheduleText(s: OrganizeSchedule): string {
  if (s.frequency === 'Off') return 'Off — a round runs only when you press Follow up';
  if (s.frequency === 'Continuous') return 'Continuous — a round after each stretch of work';
  if (s.frequency === 'Every day') return `Every day at ${s.time}`;
  if (s.frequency === 'On selected days') return `On ${(s.days ?? []).map((d) => DAY_NAMES[d]).join(', ')} at ${s.time}`;
  const n = s.everyDays ?? 1;
  return `Every ${n === 1 ? 'day' : `${n} days`} at ${s.time}`;
}
