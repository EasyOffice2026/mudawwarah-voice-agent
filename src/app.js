import express from 'express';
import { config, isWhatsappConfigured, isOpenAiConfigured } from './config.js';
import * as wa from './whatsapp.js';
import * as orders from './orders.js';
import * as payment from './payment.js';
import { handleInbound } from './flow.js';

export const app = express();
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    whatsapp: isWhatsappConfigured(),
    openai: isOpenAiConfigured(),
    payment: payment.isOnlinePaymentEnabled() ? config.payment.provider : 'none',
    tenant: config.mdawra.tenant,
  }),
);

// Meta webhook verification handshake.
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.whatsapp.verifyToken) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  return res.sendStatus(403);
});

// Meta retries a webhook it did not get a 200 for, and a customer sends the
// same voice note twice occasionally; remembering recent ids avoids double
// orders. Bounded so it cannot grow forever.
const seen = new Map();
const isDuplicate = (id) => {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.set(id, Date.now());
  if (seen.size > 5000) for (const key of [...seen.keys()].slice(0, 1000)) seen.delete(key);
  return false;
};

app.post('/webhook', (req, res) => {
  if (!wa.verifySignature(req.rawBody, req.get('x-hub-signature-256'))) {
    console.error('[webhook] rejected: invalid signature (check WHATSAPP_APP_SECRET)');
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  const fields = (req.body?.entry || []).flatMap((e) => (e.changes || []).map((c) => c.field));
  console.log('[webhook] received', fields.join(',') || '(no changes)');
  for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      if (config.whatsapp.phoneNumberId && value.metadata?.phone_number_id && value.metadata.phone_number_id !== config.whatsapp.phoneNumberId) continue;
      const contacts = value.contacts || [];
      for (const message of value.messages || []) {
        if (isDuplicate(message.id)) continue;
        const waName = contacts.find((c) => c.wa_id === message.from)?.profile?.name;
        const input = wa.extractInput(message);
        wa.markAsRead(message.id);
        handleInbound({ phone: message.from, waName, ...input, mimeType: message.audio?.mime_type }).catch((error) =>
          console.error('[webhook] failed handling message', message.id, error),
        );
      }
    }
  }
});

// Payment gateway return / webhook. The result is always re-checked with the
// provider before an order is treated as paid.
app.all('/payments/callback', async (req, res) => {
  if (!payment.isOnlinePaymentEnabled()) return res.status(404).send('Online payment is not enabled');
  try {
    const status = await payment.getPaymentStatus({ ...req.query, ...(req.body || {}) });
    const entry = orders.byPaymentReference(status.reference);
    if (entry) {
      if (status.paid) await orders.markPaid(entry);
      else if (status.failed) await orders.markPaymentFailed(entry);
    }
    const lang = entry?.lang || 'en';
    const text = status.paid ? (lang === 'ar' ? 'تم الدفع بنجاح، ارجع إلى واتساب.' : 'Payment successful — you can return to WhatsApp.') : lang === 'ar' ? 'لم يتم الدفع.' : 'Payment was not completed.';
    return res.status(200).type('html').send(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding:3rem"><h2>${text}</h2></body>`);
  } catch (error) {
    console.error('[payments] callback failed', error.message);
    return res.status(502).send('Could not verify payment');
  }
});

// Demo gateway: opening the link pays the invoice.
app.get('/payments/mock/pay', (req, res) => {
  if (config.payment.provider !== 'mock') return res.sendStatus(404);
  payment.markMockPaid(String(req.query.ref || ''));
  return res.redirect(`/payments/callback?ref=${encodeURIComponent(String(req.query.ref || ''))}`);
});

const requireAdmin = (req, res, next) => {
  if (!config.adminToken) return res.status(404).json({ error: 'ADMIN_TOKEN not configured' });
  if (req.get('authorization') !== `Bearer ${config.adminToken}`) return res.sendStatus(401);
  return next();
};

// Customer comments on order, food and service, newest first.
app.get('/feedback', requireAdmin, (_req, res) => res.json(orders.listFeedback()));

// Complaints customers logged from the WhatsApp menu or by describing a problem, newest first.
app.get('/complaints', requireAdmin, (_req, res) => res.json(orders.listComplaints()));
