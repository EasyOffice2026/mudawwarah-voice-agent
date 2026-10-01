import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { isBranchOpen, todaysHours, nextOpening, branchName, matchZone } from '../src/branches.js';

// Kuwait is UTC+3: 2026-10-01 is a Thursday (day 4). 10:00 Kuwait = 07:00 UTC.
const at = (kuwaitTime, date = '2026-10-01') => new Date(`${date}T${kuwaitTime}:00+03:00`);
const week = (entry, overrides = {}) => Array.from({ length: 7 }, (_, day) => ({ day, ...entry, ...(overrides[day] || {}) }));

test('open during the day window, closed outside it, in Kuwait time', () => {
  const branch = { hours: week({ open: '09:00', close: '23:00', closed: false }) };
  assert.equal(isBranchOpen(branch, at('08:59')), false);
  assert.equal(isBranchOpen(branch, at('09:00')), true);
  assert.equal(isBranchOpen(branch, at('22:59')), true);
  assert.equal(isBranchOpen(branch, at('23:00')), false);
  assert.equal(todaysHours(branch, at('12:00')), '09:00–23:00');
  assert.equal(nextOpening(branch, at('07:00')), '09:00');
  assert.equal(nextOpening(branch, at('23:30')), '09:00');
});

test('hours past midnight count for the day they started, and equal open/close means 24 hours', () => {
  const late = { hours: week({ open: '18:00', close: '02:00', closed: false }, { 4: { closed: true } }) };
  // Thursday is closed, but Wednesday's 18:00–02:00 still covers Thursday 01:00.
  assert.equal(isBranchOpen(late, at('01:00')), true);
  assert.equal(isBranchOpen(late, at('03:00')), false);
  assert.equal(isBranchOpen(late, at('19:00')), false);
  assert.equal(todaysHours(late, at('19:00')), 'closed');
  assert.equal(isBranchOpen({ hours: week({ open: '00:00', close: '00:00', closed: false }) }, at('04:00')), true);
});

test('a branch without hours is treated as open', () => {
  assert.equal(isBranchOpen({ hours: null }), true);
  assert.equal(todaysHours({ hours: [] }), null);
});

test('Arabic names saved as question marks fall back to English', () => {
  assert.equal(branchName({ nameEn: 'Al Jahra', nameAr: '???????' }, 'ar'), 'Al Jahra');
  assert.equal(branchName({ nameEn: 'Al Jahra', nameAr: 'الجهراء' }, 'ar'), 'الجهراء');
  assert.equal(branchName({ nameEn: 'Al Jahra', nameAr: 'الجهراء' }, 'en'), 'Al Jahra');
});

test('breaks close a branch for part of the day (Friday prayer), and "opens at" knows it', () => {
  // 2026-10-02 is a Friday (day 5).
  const branch = { hours: week({ open: '00:00', close: '00:00', closed: false }, { 5: { breaks: [{ from: '11:30', to: '13:00' }] } }) };
  assert.equal(isBranchOpen(branch, at('11:29', '2026-10-02')), true);
  assert.equal(isBranchOpen(branch, at('12:00', '2026-10-02')), false);
  assert.equal(isBranchOpen(branch, at('13:00', '2026-10-02')), true);
  assert.equal(isBranchOpen(branch, at('12:00', '2026-10-01')), true, 'Thursday has no break');
  assert.equal(nextOpening(branch, at('12:00', '2026-10-02')), '13:00');
});

test('areas match zones loosely: case, "Al-" and Arabic letter forms do not matter', () => {
  const zones = [{ id: 'z1', nameEn: 'Jahra', nameAr: 'الجهراء' }, { id: 'z2', nameEn: 'Sabah Al Ahmad', nameAr: 'صباح الأحمد' }];
  assert.equal(matchZone('al-jahra', zones).id, 'z1');
  assert.equal(matchZone('الجهراء', zones).id, 'z1');
  assert.equal(matchZone('صباح الاحمد', zones).id, 'z2');
  assert.equal(matchZone('Salmiya', zones), null);
  assert.equal(matchZone('', zones), null);
});
