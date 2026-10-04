/**
 * Time as the material gives it (Spec §1.8; CKC-02 AC-27), and the fixed way a claim is attributed (Spec §2.4).
 *
 * A time the material gives only as a date is kept as that date. It used to be completed to midnight UTC, and a date
 * completed that way is shown on the previous or the next day as soon as it is displayed in another time zone: the
 * precision the material never had became an error. A time with a clock keeps its instant, stored in UTC as before.
 *
 * These are pure functions for the views and the context to call; nothing here reads the assets.
 */

/** A calendar value with no clock time: a year, a year and month, or a date — the precision the material gave. */
const CALENDAR = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/** Whether the value is a calendar date with no clock time (`2026-09-17`). */
export function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test((value ?? '').trim());
}

/** Whether the value names a day, a month or a year and no clock time. */
function isCalendarOnly(value: string): boolean {
  return CALENDAR.test((value ?? '').trim());
}

/** A calendar value that names a real year, month or day, or null. */
function realCalendar(value: string): string | null {
  const v = value.trim();
  const m = CALENDAR.exec(v);
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] === undefined ? 1 : Number(m[2]);
  const day = m[3] === undefined ? 1 : Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? v : null;
}

/**
 * The time to store for what the material gives: a date (or a month, or a year) stays as given; a time with a clock
 * becomes its ISO instant; anything that is not a time is null, so the caller can say so instead of storing a guess.
 */
export function normalizeMaterialTime(value: string): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (isCalendarOnly(v)) return realCalendar(v);
  // A bare year-month-day with anything but a clock after it is not a time the material gave.
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function partsIn(ms: number, timeZone: string | undefined) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

/**
 * The day to show. A date-only value is its own day in every time zone; a time with a clock is shown on the day it
 * falls on where it is shown (`timeZone`, default the machine's own). What cannot be read is shown as written.
 */
export function materialDate(value: string, timeZone?: string): string {
  const v = (value ?? '').trim();
  if (isCalendarOnly(v)) return v;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? v : partsIn(ms, timeZone).date;
}

/** The date, and the clock time when the material gave one (`2026-09-17` or `2026-09-17 23:30`). */
export function displayMaterialTime(value: string, timeZone?: string): string {
  const v = (value ?? '').trim();
  if (isCalendarOnly(v)) return v;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return v;
  const p = partsIn(ms, timeZone);
  return `${p.date} ${p.time}`;
}

/**
 * How a claim is attributed wherever the interface or a context quotes it (Spec §2.4, D63): the fixed English words
 * `Reported by <who>, <date>`. Keeper text in the project's own language says it in that language instead.
 */
export function reportedBy(claim: { readonly who: string; readonly at: string }, timeZone?: string): string {
  return `Reported by ${claim.who.trim()}, ${materialDate(claim.at, timeZone)}`;
}
