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

// Breaks close a branch for part of a day, e.g. Friday prayer { from: "11:30", to: "13:00" }.
const inBreak = (entry, minutes) =>
  (entry?.breaks || []).some((b) => {
    const from = toMinutes(b?.from);
    const to = toMinutes(b?.to);
    if (from === null || to === null || from === to) return false;
    return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  });

/** Open now? Handles windows past midnight (18:00–02:00), equal open/close meaning 24 hours, and breaks. */
export const isBranchOpen = (branch, now = new Date()) => {
  if (!hasHours(branch)) return true;
  const { day, minutes } = kuwaitClock(now);
  const today = dayEntry(branch, day);
  if (today && !today.closed && !inBreak(today, minutes)) {
    const open = toMinutes(today.open);
    const close = toMinutes(today.close);
    if (open === null || close === null || open === close) return true;
    if (close > open ? minutes >= open && minutes < close : minutes >= open) return true;
  }
  const yesterday = dayEntry(branch, (day + 6) % 7);
  if (yesterday && !yesterday.closed && !inBreak(yesterday, minutes)) {
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
  // Checked in 15-minute steps over the coming week, so breaks (Friday prayer) and late windows are respected.
  const step = 15 * 60 * 1000;
  for (let t = Math.ceil(now.getTime() / step) * step; t < now.getTime() + 7 * 24 * 3600 * 1000; t += step) {
    if (isBranchOpen(branch, new Date(t))) {
      const { minutes } = kuwaitClock(new Date(t));
      return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    }
  }
  return null;
};

/** Delivery zones from the website; none (or no website support yet) means delivery works as before. */
export const getZones = async () => {
  try {
    const zones = await mdawra.getZones();
    return Array.isArray(zones) ? zones.filter((z) => z.isActive !== false) : [];
  } catch (error) {
    if (error.status !== 404) console.error('[zones] could not load delivery zones', error.message);
    return [];
  }
};

// Same loose matching as the website: case, "Al-" prefixes and Arabic letter forms do not matter.
const normaliseArea = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/^(ال|al[\s-]+|el[\s-]+)/, '')
    .replace(/[^a-z0-9؀-ۿ]+/g, '');

/** The zone an area name belongs to, or null. */
export const matchZone = (area, zones) => {
  const wanted = normaliseArea(area);
  return wanted ? zones.find((z) => [z.nameEn, z.nameAr].some((n) => n && normaliseArea(n) === wanted)) || null : null;
};

export const zoneName = (zone, lang) => (lang === 'ar' && zone.nameAr ? zone.nameAr : zone.nameEn);

/** Arabic name when it is real text; some branches were saved as "???????" and fall back to English. */
export const branchName = (branch, lang) => {
  const ar = String(branch.nameAr || '');
  return lang === 'ar' && ar && !/^[?\s]+$/.test(ar) ? ar : branch.nameEn;
};
