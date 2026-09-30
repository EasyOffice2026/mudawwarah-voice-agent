import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.WHATSAPP_APP_SECRET = 'app-secret';
const { mockFetch, sentTexts, sentMessages, menu, settings } = await import('./helpers.js');
const { app } = await import('../src/app.js');
const orders = await import('../src/orders.js');
const wa = await import('../src/whatsapp.js');

let server;
let base;
let calls;
let realFetch;

before(async () => {
  realFetch = globalThis.fetch;
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

beforeEach(() => {
  orders.clearAll();
  const mocked = mockFetch({
    'GET /categories': () => ({ json: menu }),
    'GET /settings': () => ({ json: settings }),
    'POST /12345/messages': () => ({ json: {} }),
    'POST /chat/completions': () => ({ json: { choices: [{ message: { content: JSON.stringify({ lang: 'en', reply: 'Hello!', add: [], remove: [], customer: {}, orderType: null, paymentMethod: null, action: 'none' }) } }] } }),
  });
  calls = mocked;
  const mockedFetch = globalThis.fetch;
  // Requests to the app itself go to the real network; everything else is mocked.
  globalThis.fetch = (url, init) => (String(url).startsWith(base) ? realFetch(url, init) : mockedFetch(url, init));
});

const sign = (body) => `sha256=${crypto.createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
const webhookBody = (message) =>
  JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '12345' }, contacts: [{ wa_id: '96555', profile: { name: 'Ali' } }], messages: [message] } }] }] });

test('health reports what is configured', async () => {
  const res = await fetch(`${base}/health`);
  assert.deepEqual(await res.json(), { ok: true, whatsapp: true, openai: true, payment: 'mock', tenant: 'mdawra' });
});

test('the catalogue feed lists every menu item with photo and KWD price, CSV-escaped', async () => {
  const res = await fetch(`${base}/catalog/feed.csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const lines = (await res.text()).replace(/^﻿/, '').trim().split('\n');
  assert.equal(lines[0], 'id,title,description,availability,condition,price,link,image_link,brand');
  assert.equal(lines[1], 'item-shawarma,Chicken Shawarma,شاورما دجاج,in stock,new,1.500 KWD,https://www.madawarah.com/r/mdawra,https://cdn.test/shawarma.png,Mudawwarah');
  assert.equal(lines.length, 2, 'items without a photo are left out');
});

test('webhook verification handshake', async () => {
  const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
  assert.equal(await ok.text(), '42');
  const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`);
  assert.equal(bad.status, 403);
});

test('webhook rejects bad signatures, accepts good ones and ignores duplicates', async () => {
  const body = webhookBody({ id: 'wamid.dup', from: '96555', type: 'text', text: { body: 'hi' } });
  const unsigned = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=bad' }, body });
  assert.equal(unsigned.status, 401);
  for (let i = 0; i < 2; i += 1) {
    const res = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
    assert.equal(res.status, 200);
  }
  await new Promise((r) => setTimeout(r, 50));
  // A first "hi" is greeted with the welcome and the main menu list — once, despite the duplicate delivery.
  const replies = sentMessages(calls).filter((m) => m.to === '96555');
  assert.deepEqual(replies.map((m) => m.type), ['interactive']);
  assert.match(replies[0].text, /Welcome to Mudawwarah/);
  assert.equal(replies[0].body.interactive.type, 'list');
  assert.ok(wa.verifySignature(Buffer.from(body), sign(body)));
});

test('mock payment link marks the order paid through the callback', async () => {
  orders.track({ order: { id: 'order-7', orderNumber: 'MD-7', status: 'PENDING', total: '5', orderType: 'PICKUP' }, phone: '96555', lang: 'en', paymentMethod: 'ONLINE', paymentReference: 'order-7' });
  const res = await fetch(`${base}/payments/mock/pay?ref=order-7`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Payment successful/);
  assert.equal(orders.get('order-7').paid, true);
  const texts = sentTexts(calls);
  assert.match(texts.find((m) => m.to === '96555').text, /Payment received for order MD-7/);
  assert.match(texts.find((m) => m.to === '96599990000').text, /MD-7 PAID online/);
});

test('feedback endpoint requires the admin token', async () => {
  assert.equal((await fetch(`${base}/feedback`)).status, 401);
  const res = await fetch(`${base}/feedback`, { headers: { authorization: 'Bearer admin-secret' } });
  assert.deepEqual(await res.json(), []);
});
