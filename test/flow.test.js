import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { menu, settings, mockFetch, bodyOf, sentTexts } from './helpers.js';
import * as sessions from '../src/sessions.js';
import * as orders from '../src/orders.js';
import * as mdawra from '../src/mdawra.js';
import { handleInbound } from '../src/flow.js';

const PHONE = '96550001111';
const KITCHEN = '96599990000';

const turn = (lang, reply, extra = {}) => ({
  lang,
  reply,
  add: [],
  remove: [],
  customer: { name: null, area: null, block: null, street: null, building: null, notes: null },
  orderType: null,
  paymentMethod: null,
  action: 'none',
  ...extra,
});

let modelTurns = [];
let prompts = [];
let createdOrders = [];
let calls;
let orderStatus = 'PENDING';

beforeEach(() => {
  sessions.clearAll();
  orders.clearAll();
  mdawra.clearCache();
  modelTurns = [];
  prompts = [];
  createdOrders = [];
  orderStatus = 'PENDING';
  calls = mockFetch({
    'GET /categories': () => ({ json: menu }),
    'GET /settings': () => ({ json: settings }),
    'POST /orders': (_url, init) => {
      const payload = JSON.parse(init.body);
      createdOrders.push(payload);
      return { json: { id: 'order-1', orderNumber: 'MD-1001', status: 'PENDING', total: '4.000', orderType: payload.orderType, paymentMethod: payload.paymentMethod, customerName: payload.customerName, customerPhone: payload.customerPhone, address: payload.address, items: [{ nameEn: 'Chicken Shawarma', quantity: 2, customizations: [{ nameEn: 'Garlic' }] }] } };
    },
    'GET /orders/track/order-1': () => ({ json: { id: 'order-1', orderNumber: 'MD-1001', status: orderStatus, orderType: 'DELIVERY' } }),
    'POST /chat/completions': (_url, init) => {
      prompts.push(JSON.parse(init.body));
      const next = modelTurns.shift();
      assert.ok(next, 'model called more times than scripted');
      return { json: { choices: [{ message: { content: JSON.stringify(next) } }] } };
    },
    'POST /audio/transcriptions': () => ({ json: { text: 'أبي شاورما دجاج ثنتين بثوم', language: 'arabic' } }),
    'POST /audio/speech': () => ({ buffer: Buffer.from('OggS'), contentType: 'audio/ogg' }),
    'GET /media-1': () => ({ json: { url: 'https://cdn.test/voice.ogg', mime_type: 'audio/ogg' } }),
    'GET https://cdn.test/voice.ogg': () => ({ buffer: Buffer.from('voice'), contentType: 'audio/ogg' }),
    'POST /12345/media': () => ({ json: { id: 'media-out-1' } }),
    'POST /12345/messages': () => ({ json: { messages: [{ id: 'wamid.1' }] } }),
  });
});

test('a voice note is transcribed, sold against the live menu and answered with text + voice', async () => {
  modelTurns.push(turn('ar', 'ضفت لك شاورمتين بالثوم، المجموع ثلاث دنانير. تحب كولا معها؟', { add: [{ item: 1, quantity: 2, options: ['1a'] }] }));
  await handleInbound({ phone: PHONE, waName: 'Sara', audioId: 'media-1', mimeType: 'audio/ogg' });

  const session = sessions.get(PHONE);
  assert.equal(session.lang, 'ar');
  assert.deepEqual(session.cart, [{ menuItemId: 'item-shawarma', quantity: 2, optionIds: ['opt-garlic'] }]);
  assert.equal(prompts[0].messages.at(-1).content, 'أبي شاورما دجاج ثنتين بثوم');
  assert.match(prompts[0].messages[0].content, /\[1\] Chicken Shawarma/);

  const outbound = calls.filter((c) => c.url.includes('/12345/messages')).map(bodyOf);
  assert.deepEqual(outbound.map((m) => m.type), ['text', 'audio']);
  assert.equal(outbound[1].audio.id, 'media-out-1');
});

test('the agent cannot add an item whose required option is missing; the customer is asked', async () => {
  modelTurns.push(turn('en', 'Sure, one shawarma coming up.', { add: [{ item: 1, quantity: 1, options: [] }] }));
  await handleInbound({ phone: PHONE, text: 'one shawarma please' });
  assert.equal(sessions.get(PHONE).cart.length, 0);
  assert.match(sentTexts(calls)[0].text, /Before I add Chicken Shawarma, please choose:\nSauce: Garlic \/ Tahini/);
});

test('full order: details collected, order placed via Mdawra API, payment link sent, kitchen alerted, then status → receipt → feedback', async () => {
  modelTurns.push(
    turn('en', 'Added two garlic shawarmas. Delivery or pickup?', { add: [{ item: 1, quantity: 2, options: ['1a'] }] }),
    turn('en', 'Got it. What is your name and address?', { orderType: 'DELIVERY' }),
    turn('en', 'Thanks Sara. How would you like to pay?', { customer: { name: 'Sara', area: 'Salmiya', block: '4', street: '5', building: '12', notes: null } }),
    turn('en', 'Placing your order now.', { paymentMethod: 'ONLINE', action: 'place_order' }),
  );
  await handleInbound({ phone: PHONE, text: 'two chicken shawarma with garlic' });
  await handleInbound({ phone: PHONE, text: 'delivery' });
  await handleInbound({ phone: PHONE, text: 'Sara, Salmiya block 4 street 5 building 12' });
  await handleInbound({ phone: PHONE, text: 'pay by link please' });

  assert.equal(createdOrders.length, 1);
  assert.deepEqual(createdOrders[0].items, [{ menuItemId: 'item-shawarma', quantity: 2, optionIds: ['opt-garlic'] }]);
  assert.equal(createdOrders[0].paymentMethod, 'KNET');
  assert.equal(createdOrders[0].channel, 'WHATSAPP');
  assert.equal(createdOrders[0].address, 'Area Salmiya, Block 4, Street 5, Building 12');
  assert.equal(calls.find((c) => c.url.includes('/orders') && c.method === 'POST').init.headers['X-Tenant'], 'mdawra');

  let texts = sentTexts(calls);
  const toCustomer = texts.filter((m) => m.to === PHONE).at(-1).text;
  assert.match(toCustomer, /Order MD-1001 is reserved — total 4\.000 KWD/);
  assert.match(toCustomer, /https:\/\/agent\.test\/payments\/mock\/pay\?ref=order-1/);
  const toKitchen = texts.filter((m) => m.to === KITCHEN);
  assert.match(toKitchen[0].text, /New WhatsApp order MD-1001\n2 × Chicken Shawarma \(Garlic\)\nTotal: KWD 4\.000 — KNET\nDelivery: Area Salmiya/);
  assert.match(toKitchen[0].text, /awaiting online payment/);

  const session = sessions.get(PHONE);
  assert.deepEqual(session.cart, []);
  assert.equal(session.lastOrderNumber, 'MD-1001');
  assert.equal(session.customer.name, 'Sara');

  // Payment confirmed by the gateway callback.
  const entry = orders.byPaymentReference('order-1');
  assert.equal(entry.paid, false);
  await orders.markPaid(entry);
  texts = sentTexts(calls);
  assert.match(texts.at(-2).text, /Payment received for order MD-1001/);
  assert.match(texts.at(-1).text, /PAID online/);

  // Kitchen moves the order along in the Mdawra admin; the poller relays it.
  orderStatus = 'PREPARING';
  await orders.pollOnce();
  orderStatus = 'READY';
  await orders.pollOnce();
  orderStatus = 'DELIVERED';
  await orders.pollOnce();
  texts = sentTexts(calls).filter((m) => m.to === PHONE);
  assert.match(texts.at(-3).text, /being prepared/);
  assert.match(texts.at(-2).text, /ready and on its way/);
  assert.match(texts.at(-1).text, /has been delivered/);
  const buttons = calls.filter((c) => c.url.includes('/12345/messages')).map(bodyOf).filter((b) => b.type === 'interactive').at(-1);
  assert.deepEqual(buttons.interactive.action.buttons.map((b) => b.reply.id), ['received:order-1', 'notreceived:order-1']);

  // Receipt confirmation → rating → comments, no model involved.
  await handleInbound({ phone: PHONE, replyId: 'received:order-1', text: 'Yes, received' });
  assert.match(sentTexts(calls).at(-1).text, /Rate your experience from 1 to 5/);
  await handleInbound({ phone: PHONE, text: 'great' });
  assert.match(sentTexts(calls).at(-1).text, /Please reply with a number/);
  await handleInbound({ phone: PHONE, text: '5' });
  assert.match(sentTexts(calls).at(-1).text, /Any comments on the food/);
  await handleInbound({ phone: PHONE, text: 'Food was hot, driver was polite' });
  texts = sentTexts(calls);
  assert.match(texts.at(-1).text, /Thank you for your feedback/);
  assert.match(texts.at(-2).text, /Feedback for order MD-1001: 5\/5 — "Food was hot, driver was polite"/);
  assert.deepEqual(orders.listFeedback().map((f) => [f.orderNumber, f.rating, f.comment]), [['MD-1001', 5, 'Food was hot, driver was polite']]);
  assert.equal(orders.get('order-1'), null);
  assert.equal(modelTurns.length, 0);
});

test('place_order with missing details asks for them instead of calling the API', async () => {
  modelTurns.push(turn('en', 'Placing it.', { add: [{ item: 2, quantity: 4, options: [] }], action: 'place_order' }));
  await handleInbound({ phone: PHONE, text: 'four colas, order now' });
  assert.equal(createdOrders.length, 0);
  assert.match(sentTexts(calls)[0].text, /Before I place the order I still need: your name, your area, block, street, building\/house number, how you want to pay/);
});

test('a not-received reply alerts the kitchen', async () => {
  orders.track({ order: { id: 'order-9', orderNumber: 'MD-9', status: 'DELIVERED', total: '3', orderType: 'DELIVERY' }, phone: PHONE, lang: 'ar', paymentMethod: 'CASH' });
  await handleInbound({ phone: PHONE, replyId: 'notreceived:order-9', text: 'ليس بعد' });
  const texts = sentTexts(calls);
  assert.match(texts.find((m) => m.to === KITCHEN).text, /MD-9 NOT received/);
  assert.match(texts.find((m) => m.to === PHONE).text, /نعتذر منك/);
  assert.equal(orders.get('order-9'), null);
});
