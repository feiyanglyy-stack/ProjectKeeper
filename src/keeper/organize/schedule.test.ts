/**
 * The schedule of daily organizing (Spec §3.8, §6.10; D105; CKC-07 AC-28～AC-30): the owner sets how often a round
 * starts by itself and at what time of day. Each frequency gives its scheduled times; a time that has come is due once;
 * times missed while ProjectKeeper was not running are made up for as one; a home from before D105 maps its rhythm.
 * Times are the machine's local time, so the dates here are built in local time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastSlot, localDate, localTime, nextSlot, parseSchedule, scheduleOf, scheduleText, scheduledDue } from './schedule.ts';
import type { OrganizeSchedule } from '../../model/types.ts';

/** A local date and time: month from 1. 2026-10-05 is a Monday. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const every: OrganizeSchedule = { frequency: 'Every day', time: '09:00', savedAt: null };

test('what the Daily page sends is checked before it is saved: each frequency, a time of day, the days, the interval', () => {
  const now = at(2026, 10, 5, 12, 0);
  const ok = (input: unknown) => { const r = parseSchedule(input, now); assert.ok('schedule' in r, JSON.stringify(r)); return r.schedule; };
  const bad = (input: unknown) => { const r = parseSchedule(input, now); assert.ok('error' in r, JSON.stringify(r)); return r.error; };
  assert.deepEqual(ok({ frequency: 'Every day', time: '9:05' }), { frequency: 'Every day', time: '09:05', savedAt: now.toISOString() });
  assert.deepEqual(ok({ frequency: 'On selected days', time: '18:30', days: [4, 1, 1] }).days, [1, 4], 'the days, each once, in order');
  const n = ok({ frequency: 'Every N days', time: '07:00', everyDays: 3 });
  assert.deepEqual([n.everyDays, n.anchor], [3, '2026-10-05'], 'counted from the day it was saved');
  assert.equal(ok({ frequency: 'Off' }).frequency, 'Off', 'Off needs no time');
  assert.equal(ok({ frequency: 'Continuous' }).frequency, 'Continuous');
  assert.match(bad({ frequency: 'Hourly', time: '09:00' }), /frequency must be one of Off, Every day, On selected days, Every N days, Continuous/);
  assert.match(bad({ frequency: 'Every day', time: '25:00' }), /time of day/);
  assert.match(bad({ frequency: 'Every day' }), /time of day/);
  assert.match(bad({ frequency: 'On selected days', time: '09:00', days: [] }), /at least one day/);
  assert.match(bad({ frequency: 'Every N days', time: '09:00', everyDays: 0 }), /whole number/);
});

test('Every day: the next time is today’s when it is still ahead, tomorrow’s after it has passed', () => {
  assert.deepEqual(nextSlot(every, at(2026, 10, 5, 8, 0)), at(2026, 10, 5, 9, 0));
  assert.deepEqual(nextSlot(every, at(2026, 10, 5, 9, 0)), at(2026, 10, 6, 9, 0), 'strictly after: the time itself is not "next"');
  assert.deepEqual(nextSlot(every, at(2026, 10, 5, 23, 59)), at(2026, 10, 6, 9, 0));
  assert.equal(scheduleText(every), 'Every day at 09:00');
});

test('On selected days: only the chosen days of the week have a time', () => {
  const s: OrganizeSchedule = { frequency: 'On selected days', time: '18:30', days: [1, 4], savedAt: null };   // Monday, Thursday
  assert.deepEqual(nextSlot(s, at(2026, 10, 5, 19, 0)), at(2026, 10, 8, 18, 30), 'from Monday evening, Thursday');
  assert.deepEqual(nextSlot(s, at(2026, 10, 8, 18, 30)), at(2026, 10, 12, 18, 30), 'from Thursday’s time, the next Monday');
  assert.deepEqual(lastSlot(s, at(2026, 10, 7, 12, 0), at(2026, 10, 1)), at(2026, 10, 5, 18, 30), 'on Wednesday the last one was Monday’s');
  assert.equal(scheduleText(s), 'On Monday, Thursday at 18:30');
});

test('Every N days: counted in whole days from the day it was saved', () => {
  const s: OrganizeSchedule = { frequency: 'Every N days', time: '07:00', everyDays: 3, anchor: '2026-10-05', savedAt: null };
  assert.deepEqual(nextSlot(s, at(2026, 10, 5, 6, 0)), at(2026, 10, 5, 7, 0), 'the day it starts from counts');
  assert.deepEqual(nextSlot(s, at(2026, 10, 5, 7, 0)), at(2026, 10, 8, 7, 0));
  assert.deepEqual(nextSlot(s, at(2026, 10, 8, 7, 0)), at(2026, 10, 11, 7, 0));
  assert.deepEqual(lastSlot(s, at(2026, 10, 10, 23, 0), at(2026, 10, 1)), at(2026, 10, 8, 7, 0));
  assert.equal(scheduleText(s), 'Every 3 days at 07:00');
});

test('Off and Continuous start nothing by the clock', () => {
  for (const frequency of ['Off', 'Continuous'] as const) {
    const s: OrganizeSchedule = { frequency, time: '09:00', savedAt: null };
    assert.equal(nextSlot(s, at(2026, 10, 5)), null);
    assert.equal(scheduledDue(s, at(2026, 10, 9), at(2026, 10, 1)), null);
  }
});

test('a scheduled time is due once it has come, not before; times before the schedule counted are not made up for', () => {
  const since = at(2026, 10, 5, 10, 0);   // saved, or the takeover done, at 10:00 on the 5th
  assert.equal(scheduledDue(every, at(2026, 10, 5, 23, 0), since), null, 'the 09:00 of the 5th was before it counted');
  assert.equal(scheduledDue(every, at(2026, 10, 6, 8, 59), since), null, 'not yet');
  const due = scheduledDue(every, at(2026, 10, 6, 9, 0), since);
  assert.deepEqual([due?.slot, due?.missed], [at(2026, 10, 6, 9, 0), 1], 'due at its time');
  // Dealt with: the planner records the time, and counts from it.
  assert.equal(scheduledDue(every, at(2026, 10, 6, 15, 0), at(2026, 10, 6, 9, 0)), null, 'the same time is not due twice');
});

test('times missed while ProjectKeeper was not running are made up for as one: the latest stands for them all', () => {
  const since = at(2026, 10, 5, 10, 0);
  const due = scheduledDue(every, at(2026, 10, 9, 14, 0), since);   // the 6th, 7th, 8th and 9th passed
  assert.deepEqual([due?.slot, due?.missed], [at(2026, 10, 9, 9, 0), 4], 'one time is due — the latest — however many were missed');
  assert.equal(scheduledDue(every, at(2026, 10, 9, 14, 30), due!.slot), null, 'once it is dealt with, none of the missed ones comes back');
});

test('the schedule in force: the one saved; else every day at the time the takeover finished; a home from before maps its rhythm', () => {
  const saved: OrganizeSchedule = { frequency: 'Off', time: '00:00', savedAt: '2026-10-05T02:00:00.000Z' };
  assert.equal(scheduleOf({ schedule: saved, organizeRhythm: 'Continuous' }), saved, 'what the owner saved stands');
  const done = at(2026, 10, 5, 13, 35).toISOString();
  assert.deepEqual(scheduleOf({}, { takeoverDoneAt: done }), { frequency: 'Every day', time: '13:35', savedAt: null }, 'never changed: every day at the time the takeover finished');
  // Before D105: `Daily` was a day after the last round ended — every day at the time of day that round ended.
  const lastRound = at(2026, 10, 7, 21, 10).toISOString();
  assert.deepEqual(scheduleOf({ organizeRhythm: 'Daily' }, { takeoverDoneAt: done, lastRoundEnd: lastRound }), { frequency: 'Every day', time: '21:10', savedAt: null });
  assert.equal(scheduleOf({ organizeRhythm: 'Continuous' }, { takeoverDoneAt: done, lastRoundEnd: lastRound }).frequency, 'Continuous', 'Continuous stays');
  assert.equal(localTime(at(2026, 1, 2, 3, 4)), '03:04');
  assert.equal(localDate(at(2026, 1, 2, 3, 4)), '2026-01-02');
});
