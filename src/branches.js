/**
 * Pickup branches from the Mdawra API, with open/closed worked out in Kuwait
 * time (UTC+3, no daylight saving) from each branch's weekly hours:
 * [{ day: 0-6 (Sunday = 0), open: "09:00", close: "23:00", closed: false }].
 */
import * as mdawra from './mdawra.js';

const KUWAIT_OFFSET_MINUTES = 180;

/** Branches are optional: without them (or if the API fails) pickup works without choosing one. */
export const getBranches = async () => {
  try {
    const branches = await mdawra.getPickupLocations();
    return (Array.isArray(branches) ? branches : []).filter((b) => b.isActive !== false);
  } catch (error) {
    console.error('[branches] could not load pickup branches', error.message);
    return [];
  }
};

const kuwaitClock = (now) => {
  const local = new Date(now.getTime() + KUWAIT_OFFSET_MINUTES * 60 * 1000);
  return { day: local.getUTCDay(), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
};

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null;
};

const hasHours = (branch) => Array.isArray(branch.hours) && branch.hours.length > 0;
const dayEntry = (branch, day) => (hasHours(branch) ? branch.hours.find((h) => Number(h.day) === day) : null);

/** Open now? Handles windows past midnight (18:00–02:00) and equal open/close meaning 24 hours. */
export const isBranchOpen = (branch, now = new Date()) => {
  if (!hasHours(branch)) return true;
  const { day, minutes } = kuwaitClock(now);
  const today = dayEntry(branch, day);
  if (today && !today.closed) {
    const open = toMinutes(today.open);
    const close = toMinutes(today.close);
    if (open === null || close === null || open === close) return true;
    if (close > open ? minutes >= open && minutes < close : minutes >= open) return true;
  }
  const yesterday = dayEntry(branch, (day + 6) % 7);
  if (yesterday && !yesterday.closed) {
    const open = toMinutes(yesterday.open);
    const close = toMinutes(yesterday.close);
    if (open !== null && close !== null && close < open && minutes < close) return true;
  }
  return false;
};

/** Today's hours as "09:00–23:00", "24 hours", "closed today", or null when the branch has none. */
export const todaysHours = (branch, now = new Date()) => {
  const today = dayEntry(branch, kuwaitClock(now).day);
  if (!today) return null;
  if (today.closed) return 'closed';
  return today.open === today.close ? '24h' : `${today.open}–${today.close}`;
};

/** The next opening time ("09:00") within the coming week, or null. */
export const nextOpening = (branch, now = new Date()) => {
  if (!hasHours(branch)) return null;
  const { day, minutes } = kuwaitClock(now);
  for (let offset = 0; offset < 7; offset += 1) {
    const entry = dayEntry(branch, (day + offset) % 7);
    if (!entry || entry.closed) continue;
    const open = toMinutes(entry.open);
    if (open === null) continue;
    if (offset > 0 || open > minutes) return entry.open;
  }
  return null;
};

/** Arabic name when it is real text; some branches were saved as "???????" and fall back to English. */
export const branchName = (branch, lang) => {
  const ar = String(branch.nameAr || '');
  return lang === 'ar' && ar && !/^[?\s]+$/.test(ar) ? ar : branch.nameEn;
};
