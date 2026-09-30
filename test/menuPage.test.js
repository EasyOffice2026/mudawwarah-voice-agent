import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { menu, settings, mockFetch, sentTexts, sentMessages } from './helpers.js';
import { config } from '../src/config.js';
import * as sessions from '../src/sessions.js';
import * as orders from '../src/orders.js';
import * as mdawra from '../src/mdawra.js';
import { createMenuToken, verifyMenuToken, cartFromPage, renderMenuPage } from '../src/menuPage.js';
import { handleInbound } from '../src/flow.js';

const { app } = await import('../src/app.js');
const PHONE = '96550001111';

test('a menu link is signed for one phone, cannot be altered and expires after 24 hours', () => {
  const now = Date.parse('2026-10-01T10:00:00Z');
  const token = createMenuToken(PHONE, now);
  assert.equal(verifyMenuToken(token, now), PHONE);
  assert.equal(verifyMenuToken(token, now + 23 * 3600 * 1000), PHONE);
  assert.equal(verifyMenuToken(token, now + 25 * 3600 * 1000), null, 'expired');
  assert.equal(verifyMenuToken(token.replace(PHONE, '96550002222'), now), null, 'someone else\'s number');
  assert.equal(verifyMenuToken(`${token.slice(0, -1)}x`, now), null, 'tampered signature');
  assert.equal(verifyMenuToken('garbage', now), null);
});

test('the page cart becomes cart lines from the live menu; prices never come from the page', () => {
  const lines = cartFromPage(
    [{ id: 'item-shawarma', qty: 2, price: 0.001 }, { id: 'item-cola', qty: 99 }, { id: 'item-hidden', qty: 1 }, { id: 'nope', qty: 1 }, { id: 'item-cola', qty: 1 }, { id: 'x', qty: 0 }],
    menu,
  );
  assert.deepEqual(lines, [
    { menuItemId: 'item-shawarma', quantity: 2, optionIds: [] },
    { menuItemId: 'item-cola', quantity: 20, optionIds: [] },
  ]);
});

test('the page embeds the menu, the current cart and the language, and cannot be broken by menu text', () => {
  const tricky = [{ id: 'c', nameEn: 'Mains', items: [{ id: 'i1', nameEn: 'Pie </script><script>alert(1)</script>', price: '1', image: { thumbnailUrl: 'https://cdn.test/t.png' } }] }];
  const html = renderMenuPage({ categories: tricky, cart: [{ menuItemId: 'i1', quantity: 3, optionIds: [] }], lang: 'ar', token: 't', minimumOrder: '2.000' });
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.doesNotMatch(html, /<\/script><script>alert/);
  const data = JSON.parse(html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(data.cart, { i1: 3 });
  assert.equal(data.minimum, 2);
  assert.equal(data.menu[0].items[0].img, 'https://cdn.test/t.png');
  assert.equal(data.menu[0].items[0].en, 'Pie </script><script>alert(1)</script>');
});

let server;
let base;
let calls;
let prompts;
let modelTurns;
let realFetch;
const turn = (reply, extra = {}) => ({ lang: 'en', reply, add: [], remove: [], photos: [], pickupBranch: null, customer: { name: null, area: null, block: null, street: null, building: null, notes: null }, orderType: null, paymentMethod: null, action: 'none', complaint: null, ...extra });

before(async () => {
  realFetch = globalThis.fetch;
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

beforeEach(() => {
  config.menuPage.enabled = true;
  sessions.clearAll();
  orders.clearAll();
  mdawra.clearCache();
  prompts = [];
  modelTurns = [];
  const mocked = mockFetch({
    'GET /categories': () => ({ json: menu }),
    'GET /settings': () => ({ json: settings }),
    'GET /pickup-locations': () => ({ json: [] }),
    'POST /chat/completions': (_url, init) => {
      prompts.push(JSON.parse(init.body));
      return { json: { choices: [{ message: { content: JSON.stringify(modelTurns.shift()) } }] } };
    },
    'GET /12345?fields=display_phone_number': () => ({ json: { display_phone_number: '+1 555-178-3581' } }),
    'POST /12345/messages': () => ({ json: { messages: [{ id: 'wamid.1' }] } }),
  });
  calls = mocked;
  const mockedFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).startsWith(base) ? realFetch(url, init) : mockedFetch(url, init));
});
afterEach(() => {
  config.menuPage.enabled = false;
});

test('"Browse the menu" and "menu" send an "Open menu" button with the customer\'s own signed link', async () => {
  sessions.get(PHONE).greeted = true;
  await handleInbound({ phone: PHONE, replyId: 'menu:browse', text: 'Browse the menu' });
  const message = sentMessages(calls).at(-1).body.interactive;
  assert.equal(message.type, 'cta_url');
  assert.equal(message.action.parameters.display_text, 'Open menu');
  const url = message.action.parameters.url;
  assert.match(url, /^https:\/\/agent\.test\/m\//);
  assert.equal(verifyMenuToken(url.split('/m/')[1]), PHONE);

  sessions.get(PHONE).lang = 'ar';
  await handleInbound({ phone: PHONE, text: 'منيو' });
  assert.equal(sentMessages(calls).at(-1).body.interactive.action.parameters.display_text, 'افتح المنيو');
  assert.equal(prompts.length, 0);
});

test('the page opens for a valid link and refuses an expired or forged one', async () => {
  Object.assign(sessions.get(PHONE), { lang: 'en', cart: [{ menuItemId: 'item-cola', quantity: 2, optionIds: [] }] });
  const ok = await fetch(`${base}/m/${createMenuToken(PHONE)}`);
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /Chicken Shawarma/);
  assert.match(html, /"cart":\{"item-cola":2\}/);

  const expired = await fetch(`${base}/m/${createMenuToken(PHONE, Date.now() - 48 * 3600 * 1000)}`);
  assert.equal(expired.status, 403);
  assert.match(await expired.text(), /expired/);
});

test('"Send order" puts the cart in the chat, the agent carries on, and the page gets a link back to WhatsApp', async () => {
  Object.assign(sessions.get(PHONE), { greeted: true, lang: 'en', cart: [{ menuItemId: 'item-cola', quantity: 1, optionIds: [] }] });
  modelTurns.push(turn('Great choice! Delivery or pickup?'));
  const res = await fetch(`${base}/m/${createMenuToken(PHONE)}/order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ id: 'item-shawarma', qty: 2 }, { id: 'item-cola', qty: 3 }] }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, whatsapp: 'https://wa.me/15551783581' });
  assert.deepEqual(sessions.get(PHONE).cart, [
    { menuItemId: 'item-shawarma', quantity: 2, optionIds: [] },
    { menuItemId: 'item-cola', quantity: 3, optionIds: [] },
  ]);
  assert.equal(prompts[0].messages.at(-1).content, '[Sent a cart from the menu page: 2 × Chicken Shawarma, 3 × Cola]');
  assert.equal(sentTexts(calls).at(-1).text, 'Great choice! Delivery or pickup?');

  const forged = await fetch(`${base}/m/${createMenuToken('96559999999').replace('96559999999', PHONE)}/order`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"items":[{"id":"item-cola","qty":1}]}' });
  assert.equal(forged.status, 403);
  const empty = await fetch(`${base}/m/${createMenuToken(PHONE)}/order`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"items":[]}' });
  assert.equal(empty.status, 400);
});

test('if the button message is refused, the link is sent as plain text', async () => {
  calls = mockFetch({
    'GET /categories': () => ({ json: menu }),
    'POST /12345/messages': (_url, init) =>
      JSON.parse(init.body).interactive?.type === 'cta_url' ? { status: 400, json: { error: { message: 'not allowed' } } } : { json: { messages: [{ id: 'wamid.1' }] } },
  });
  sessions.get(PHONE).greeted = true;
  await handleInbound({ phone: PHONE, text: 'menu' });
  assert.match(sentTexts(calls).at(-1).text, /Browse the full menu[\s\S]*https:\/\/agent\.test\/m\//);
});
