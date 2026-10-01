import express from 'express';
import { config, isWhatsappConfigured, isOpenAiConfigured } from './config.js';
import * as wa from './whatsapp.js';
import * as orders from './orders.js';
import * as payment from './payment.js';
import { handleInbound } from './flow.js';
import * as mdawra from './mdawra.js';
import * as sessions from './sessions.js';
import { catalogFeedCsv } from './catalog.js';
import { verifyMenuToken, renderMenuPage, cartFromPage } from './menuPage.js';

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

// The web menu page a customer opens from the chat. The link is signed for their number and expires.
const expiredPage = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><body style="font-family:system-ui,sans-serif;text-align:center;padding:3rem 1.5rem"><h2>This link has expired · انتهت صلاحية الرابط</h2><p>Type "menu" in WhatsApp to get a new one.<br>اكتب "منيو" في الواتساب عشان يوصلك رابط جديد.</p></body>';

app.get('/m/:token', async (req, res) => {
  const phone = verifyMenuToken(req.params.token);
  if (!phone) return res.status(403).type('html').send(expiredPage);
  try {
    const [categories, settings] = await Promise.all([mdawra.getMenu(), mdawra.getSettings()]);
    const session = sessions.get(phone);
    res.set('Cache-Control', 'no-store');
    return res.type('html').send(
      renderMenuPage({ categories, cart: session.cart, lang: session.lang, token: req.params.token, minimumOrder: settings.minimumOrder, restaurantName: settings.restaurantName || 'Mudawwarah' }),
    );
  } catch (error) {
    console.error('[menu-page] could not render', error.message);
    return res.status(502).type('html').send('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;text-align:center;padding:3rem">Menu unavailable — please try again in a moment.</body>');
  }
});

// "Send order" on the menu page: the cart goes to the customer's chat and the bot carries on there.
app.post('/m/:token/order', async (req, res) => {
  const phone = verifyMenuToken(req.params.token);
  if (!phone) return res.status(403).json({ error: 'expired' });
  try {
    const lines = cartFromPage(req.body?.items, await mdawra.getMenu());
    if (!lines.length) return res.status(400).json({ error: 'empty' });
    await handleInbound({ phone, text: '', pageCart: lines });
    return res.json({ ok: true, whatsapp: await wa.chatLink() });
  } catch (error) {
    console.error('[menu-page] order failed', error.message);
    return res.status(502).json({ error: 'failed' });
  }
});

// The menu as a product data feed for the WhatsApp catalogue (Commerce Manager → Data sources → Scheduled feed).
// Public on purpose: it holds only what the website menu already shows.
app.get('/catalog/feed.csv', async (_req, res) => {
  try {
    res.type('text/csv; charset=utf-8').send(catalogFeedCsv(await mdawra.getMenu()));
  } catch (error) {
    console.error('[catalog] feed failed', error.message);
    res.status(502).send('Menu unavailable');
  }
});
