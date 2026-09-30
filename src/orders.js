import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import * as mdawra from './mdawra.js';
import * as wa from './whatsapp.js';
import { t } from './copy.js';

/**
 * Everything that happens after an order is placed: waiting for the payment,
 * relaying kitchen status changes (preparing / ready / delivered) to the
 * customer, asking them to confirm receipt and collecting their feedback.
 *
 * The kitchen works in the Mdawra admin panel, so status is read from the
 * public tracking endpoint on a timer rather than pushed; a restaurant has
 * only a handful of live orders so polling is cheap.
 */

const FILE = config.dataDir ? path.join(config.dataDir, 'orders.json') : null;
const FEEDBACK_FILE = config.dataDir ? path.join(config.dataDir, 'feedback.json') : null;
const COMPLAINTS_FILE = config.dataDir ? path.join(config.dataDir, 'complaints.json') : null;
const tracked = new Map();
const feedback = [];
const complaints = [];

const readJson = (file, fallback) => {
  if (!file || !fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error('[orders] could not read', file, error.message);
    return fallback;
  }
};
const writeJson = (file, value) => {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  } catch (error) {
    console.error('[orders] could not write', file, error.message);
  }
};

for (const [id, order] of Object.entries(readJson(FILE, {}))) tracked.set(id, order);
feedback.push(...readJson(FEEDBACK_FILE, []));
complaints.push(...readJson(COMPLAINTS_FILE, []));

const persist = () => writeJson(FILE, Object.fromEntries(tracked));

export const track = ({ order, phone, lang, paymentMethod, paymentReference = null, paymentUrl = null, pickupBranch = null }) => {
  const entry = {
    id: order.id,
    orderNumber: order.orderNumber,
    phone,
    lang: lang || 'en',
    orderType: order.orderType,
    total: Number(order.total),
    paymentMethod,
    paymentReference,
    paymentUrl,
    pickupBranch,
    paid: paymentMethod !== 'ONLINE',
    status: order.status || 'PENDING',
    receiptAsked: false,
    createdAt: Date.now(),
  };
  tracked.set(order.id, entry);
  persist();
  return entry;
};

export const get = (id) => tracked.get(id) || null;
export const forPhone = (phone) => [...tracked.values()].filter((o) => o.phone === phone).sort((a, b) => b.createdAt - a.createdAt);
export const byPaymentReference = (reference) => [...tracked.values()].find((o) => o.paymentReference === String(reference)) || null;
export const untrack = (id) => {
  tracked.delete(id);
  persist();
};
export const clearAll = () => {
  tracked.clear();
  feedback.length = 0;
  complaints.length = 0;
};

/** Saves changes made to a tracked entry. */
export const update = (entry) => {
  tracked.set(entry.id, entry);
  persist();
  return entry;
};

export const notifyKitchen = async (text) => {
  if (!config.kitchen.whatsappNumber) return;
  try {
    await wa.sendText(config.kitchen.whatsappNumber, text);
  } catch (error) {
    console.error('[orders] kitchen notification failed', error.message);
  }
};

export const orderSummaryForKitchen = (order, customer, location = null) => {
  const lines = (order.items || []).map((i) => `${i.quantity} × ${i.nameEn}${i.customizations?.length ? ` (${i.customizations.map((c) => c.nameEn).join(', ')})` : ''}`);
  const where = order.orderType === 'PICKUP' ? `PICKUP${order.pickupLocation?.nameEn ? ` — ${order.pickupLocation.nameEn} branch` : ''}` :`Delivery: ${order.address || [customer.area, customer.block, customer.street, customer.building].filter(Boolean).join(', ')}`;
  return [
    `New WhatsApp order ${order.orderNumber}`,
    ...lines,
    `Total: KWD ${Number(order.total).toFixed(3)} — ${order.paymentMethod}`,
    where,
    location && order.orderType !== 'PICKUP' ? `Map: https://maps.google.com/?q=${location.lat},${location.lng}` : null,
    `${order.customerName} — ${order.customerPhone}`,
    order.notes ? `Notes: ${order.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n');
};

export const markPaid = async (entry) => {
  if (entry.paid) return;
  entry.paid = true;
  persist();
  await wa.sendText(entry.phone, t(entry.lang).paymentReceived(entry.orderNumber));
  await notifyKitchen(`Order ${entry.orderNumber} PAID online — start preparing.`);
};

export const markPaymentFailed = async (entry) => {
  await wa.sendText(entry.phone, t(entry.lang).paymentFailed(entry.orderNumber));
};

/** Sends the customer the message that matches a new kitchen status. */
export const announceStatus = async (entry, status) => {
  const copy = t(entry.lang);
  const message = copy.status[status];
  if (message) await wa.sendText(entry.phone, message(entry.orderNumber, entry.orderType, entry.pickupBranch));
  if (status === 'DELIVERED' || (status === 'READY' && entry.orderType === 'PICKUP')) {
    await wa.sendButtons(entry.phone, copy.askReceipt(entry.orderNumber), [
      { id: `received:${entry.id}`, title: copy.received },
      { id: `notreceived:${entry.id}`, title: copy.notReceived },
    ]);
    entry.receiptAsked = true;
  }
};

// Timed from when the link was last sent, so a cash order switched to online later is not dropped at once.
const isAbandoned = (entry) => !entry.paid && Date.now() - (entry.paymentRequestedAt || entry.createdAt) > config.kitchen.paymentTimeoutMinutes * 60 * 1000;

/** One polling pass; exported so tests can drive it without timers. */
export const pollOnce = async () => {
  for (const entry of [...tracked.values()]) {
    if (isAbandoned(entry)) {
      untrack(entry.id);
      continue;
    }
    if (entry.receiptAsked) continue;
    let current;
    try {
      current = await mdawra.trackOrder(entry.id);
    } catch (error) {
      if (error.status === 404) untrack(entry.id);
      else console.error('[orders] poll failed for', entry.orderNumber, error.message);
      continue;
    }
    if (current.status === entry.status) continue;
    entry.status = current.status;
    persist();
    try {
      await announceStatus(entry, current.status);
      if (current.status === 'CANCELLED') untrack(entry.id);
      else persist();
    } catch (error) {
      console.error('[orders] status notification failed', error.message);
    }
  }
};

let timer = null;
export const startPolling = () => {
  if (timer || config.kitchen.pollSeconds <= 0) return;
  timer = setInterval(() => pollOnce().catch((error) => console.error('[orders] poll error', error.message)), config.kitchen.pollSeconds * 1000);
  timer.unref?.();
};
export const stopPolling = () => {
  clearInterval(timer);
  timer = null;
};

export const recordFeedback = ({ entry, rating, comment }) => {
  const record = { orderId: entry.id, orderNumber: entry.orderNumber, phone: entry.phone, rating, comment: comment || null, createdAt: new Date().toISOString() };
  feedback.push(record);
  writeJson(FEEDBACK_FILE, feedback);
  untrack(entry.id);
  return record;
};

export const listFeedback = () => [...feedback].reverse();

/** Logs a customer complaint for the team; returns the record with its reference (C-0001, C-0002, …). */
export const recordComplaint = ({ phone, name, orderNumber, text }) => {
  const record = {
    ref: `C-${String(complaints.length + 1).padStart(4, '0')}`,
    phone,
    name: name || null,
    orderNumber: orderNumber || null,
    text,
    status: 'OPEN',
    createdAt: new Date().toISOString(),
  };
  complaints.push(record);
  writeJson(COMPLAINTS_FILE, complaints);
  return record;
};

export const listComplaints = () => [...complaints].reverse();
