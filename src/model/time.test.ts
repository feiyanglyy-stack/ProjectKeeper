/**
 * Time precision (Spec §1.8; CKC-02 AC-27) and the fixed way a claim is attributed (Spec §2.4; CKC-06 AC-22).
 *
 * A time the material gives only as a date is a date: stored as a date and shown as a date. Turning it into
 * midnight UTC is what moved it to another day as soon as it was shown in a different time zone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayMaterialTime, isDateOnly, materialDate, normalizeMaterialTime, reportedBy } from './time.ts';

test('a time given only as a date stays a date, and no time zone moves it to another day (CKC-02 AC-27)', () => {
  assert.equal(isDateOnly('2026-09-17'), true);
  assert.equal(isDateOnly('2026-09-17T00:00:00.000Z'), false);
  assert.equal(normalizeMaterialTime('2026-09-17'), '2026-09-17', 'no clock time is added to a date');
  assert.equal(normalizeMaterialTime(' 2026-09-17 '), '2026-09-17');
  assert.equal(normalizeMaterialTime('2026-02-30'), null, 'a date that does not exist is not a time');
  assert.equal(normalizeMaterialTime('2026-09'), '2026-09', 'a month stays a month');
  assert.equal(normalizeMaterialTime('2026'), '2026', 'and a year a year');
  assert.equal(normalizeMaterialTime('2026/09/17'), null, 'a date in another notation is refused rather than completed to a midnight');
  assert.equal(materialDate('2026-09', 'Pacific/Pago_Pago'), '2026-09');
  assert.equal(normalizeMaterialTime('next week'), null);
  assert.equal(normalizeMaterialTime(''), null);
  // A time with a clock keeps its instant, as before.
  assert.equal(normalizeMaterialTime('2026-09-17T08:30:00+08:00'), '2026-09-17T00:30:00.000Z');
  for (const zone of ['Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
    assert.equal(materialDate('2026-09-17', zone), '2026-09-17', `the date shown in ${zone}`);
    assert.equal(displayMaterialTime('2026-09-17', zone), '2026-09-17', `no clock time shown in ${zone}`);
  }
});

test('a time with a clock is shown on the day it falls on where it is shown', () => {
  // The same instant is the 17th in one place and the 18th in another; that is the time zone, not a shift.
  assert.equal(materialDate('2026-09-17T23:30:00.000Z', 'UTC'), '2026-09-17');
  assert.equal(materialDate('2026-09-17T23:30:00.000Z', 'Asia/Shanghai'), '2026-09-18');
  assert.equal(displayMaterialTime('2026-09-17T23:30:00.000Z', 'UTC'), '2026-09-17 23:30');
  assert.equal(displayMaterialTime('2026-09-17T23:30:00.000Z', 'Asia/Shanghai'), '2026-09-18 07:30');
  assert.equal(materialDate('not a time', 'UTC'), 'not a time', 'what cannot be read is shown as written, never as a made-up date');
});

test('a claim is attributed as "Reported by <who>, <date>" (Spec §2.4)', () => {
  assert.equal(reportedBy({ who: 'Worker agent', at: '2026-09-17' }, 'America/Los_Angeles'), 'Reported by Worker agent, 2026-09-17');
  assert.equal(reportedBy({ who: 'the receipt of batch 3', at: '2026-09-17T02:00:00.000Z' }, 'Asia/Shanghai'), 'Reported by the receipt of batch 3, 2026-09-17');
});
