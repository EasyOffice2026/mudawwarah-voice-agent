import fs from 'fs';
import path from 'path';
import { config } from './config.js';

/**
 * Per-customer conversation state, keyed by WhatsApp number.
 *
 * Kept in memory and, when DATA_DIR is set, mirrored to a JSON file so a
 * restart does not lose a half-built order. A cart is small and the number
 * of concurrent conversations for one restaurant is tiny, so this is enough
 * without a database.
 */

const FILE = config.dataDir ? path.join(config.dataDir, 'sessions.json') : null;
const store = new Map();

const load = () => {
  if (!FILE || !fs.existsSync(FILE)) return;
  try {
    for (const [phone, session] of Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))) store.set(phone, session);
  } catch (error) {
    console.error('[sessions] could not read persisted sessions', error.message);
  }
};

let flushTimer = null;
const flush = () => {
  if (!FILE) return;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(store)));
    } catch (error) {
      console.error('[sessions] could not persist sessions', error.message);
    }
  }, 200);
};

load();

export const blank = (phone, waName) => ({
  phone,
  waName: waName || null,
  lang: null,
  cart: [],
  customer: { name: null, area: null, block: null, street: null, building: null, notes: null },
  paymentMethod: null,
  orderType: null,
  lastOrderId: null,
  lastOrderNumber: null,
  history: [],
  updatedAt: Date.now(),
});

const isExpired = (session) => Date.now() - session.updatedAt > config.whatsapp.sessionTtlMinutes * 60 * 1000;

export const get = (phone, waName) => {
  const existing = store.get(phone);
  if (!existing) {
    const session = blank(phone, waName);
    store.set(phone, session);
    return session;
  }
  if (isExpired(existing)) {
    const fresh = { ...blank(phone, waName || existing.waName), lang: existing.lang, customer: existing.customer, lastOrderId: existing.lastOrderId, lastOrderNumber: existing.lastOrderNumber };
    store.set(phone, fresh);
    return fresh;
  }
  if (waName && waName !== existing.waName) existing.waName = waName;
  return existing;
};

export const save = (session) => {
  session.updatedAt = Date.now();
  store.set(session.phone, session);
  flush();
  return session;
};

export const remember = (session, role, content) => {
  if (!content) return;
  session.history.push({ role, content: String(content).slice(0, 1500) });
  if (session.history.length > config.openai.historyLimit) session.history.splice(0, session.history.length - config.openai.historyLimit);
};

/** Empties the cart and order draft but keeps what we know about the customer. */
export const resetOrder = (session) => {
  session.cart = [];
  session.paymentMethod = null;
  session.orderType = null;
  return save(session);
};

export const clearAll = () => store.clear();
