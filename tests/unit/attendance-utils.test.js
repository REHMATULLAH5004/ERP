'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('../helpers/load');
const { plain } = require('../helpers/plain');

const U = loadScript('assets/js/shared-attendance-utils.js',
  ['isWeeklyOffDay', 'getDayCategory', 'computeOvertime', 'effectiveYearStart', 'entitlementForYear', 'formatDateLocal']);

test('weekly off day: matches the employee\'s own off day only', () => {
  assert.equal(U.isWeeklyOffDay('Sunday', 0), true);
  assert.equal(U.isWeeklyOffDay('Sunday', 1), false);
  assert.equal(U.isWeeklyOffDay('Saturday', 6), true);
  assert.equal(U.isWeeklyOffDay('', 0), false);
  assert.equal(U.isWeeklyOffDay(null, 3), false);
});

test('day category: Off, Half (the weekend day next to the off day) or Full', () => {
  assert.equal(U.getDayCategory('Sunday', 0), 'Off');
  assert.equal(U.getDayCategory('Sunday', 6), 'Half');
  assert.equal(U.getDayCategory('Saturday', 6), 'Off');
  assert.equal(U.getDayCategory('Saturday', 0), 'Half');
  assert.equal(U.getDayCategory('Sunday', 2), 'Full');
  assert.equal(U.getDayCategory('Wednesday', 6), 'Full');
});

test('overtime: fixed-pay staff never earn overtime', () => {
  assert.deepEqual(plain(U.computeOvertime(true, true, 'Off', 12)), { isOvertime: false, overtimeHours: 0 });
});

test('overtime: every hour on a holiday or off day counts', () => {
  assert.deepEqual(plain(U.computeOvertime(false, true, 'Full', 4)), { isOvertime: true, overtimeHours: 4 });
  assert.deepEqual(plain(U.computeOvertime(false, false, 'Off', 3.5)), { isOvertime: true, overtimeHours: 3.5 });
  assert.deepEqual(plain(U.computeOvertime(false, false, 'Off', 0)), { isOvertime: false, overtimeHours: 0 });
});

test('overtime: a full day is 9 hours with 1 hour grace', () => {
  assert.equal(U.computeOvertime(false, false, 'Full', 9).isOvertime, false);
  assert.equal(U.computeOvertime(false, false, 'Full', 10).isOvertime, false);   // inside the grace hour
  const r = U.computeOvertime(false, false, 'Full', 11);
  assert.equal(r.isOvertime, true);
  assert.equal(r.overtimeHours, 2);                                              // counted from the 9h threshold
});

test('overtime: a half day is 5 hours with 1 hour grace', () => {
  assert.equal(U.computeOvertime(false, false, 'Half', 6).isOvertime, false);
  assert.equal(U.computeOvertime(false, false, 'Half', 7).overtimeHours, 2);
});

test('leave tracking starts on 1 Sep 2026: earlier years are clamped to that date', () => {
  assert.equal(U.effectiveYearStart(2025), '2026-09-01');
  assert.equal(U.effectiveYearStart(2026), '2026-09-01');
  assert.equal(U.effectiveYearStart(2027), '2027-01-01');
});

test('leave entitlement: 4 months in 2026, a full year after', () => {
  assert.equal(U.entitlementForYear(24, 2026), 8);      // Sep-Dec = 4 months at 2 days
  assert.equal(U.entitlementForYear(24, 2027), 24);
  assert.equal(U.entitlementForYear(0, 2027), 0);
  assert.equal(U.entitlementForYear(undefined, 2027), 0);
});

test('formatDateLocal: month is 0-based (JS style) and padded', () => {
  assert.equal(U.formatDateLocal(2026, 0, 5), '2026-01-05');
  assert.equal(U.formatDateLocal(2026, 11, 31), '2026-12-31');
});
