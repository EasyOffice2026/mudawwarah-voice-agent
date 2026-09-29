import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { menu, settings, mockFetch, bodyOf, sentTexts, sentMessages } from './helpers.js';
import * as sessions from '../src/sessions.js';
import * as orders from '../src/orders.js';
import * as mdawra from '../src/mdawra.js';
import { handleInbound } from '../src/flow.js';
import { config } from '../src/config.js';
import * as wa from '../src/whatsapp.js';

const PHONE = '96550001111';
const KITCHEN = '96599990000';

const turn = (lang, reply, extra = {}) => ({
  lang,
  reply,
  add: [],
  remove: [],
  photos: [],
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

test('an Arabic voice note stays Arabic even when the transcriber labels it English', async () => {
  calls = mockFetch({
    'GET /categories': () => ({ json: menu }),
    'GET /settings': () => ({ json: settings }),
    'POST /chat/completions': (_url, init) => {
      prompts.push(JSON.parse(init.body));
      return { json: { choices: [{ message: { content: JSON.stringify(modelTurns.shift()) } }] } };
    },
    'POST /audio/transcriptions': () => ({ json: { text: 'السلام عليكم، أبي شاورما دجاج', language: 'english' } }),
    'POST /audio/speech': () => ({ buffer: Buffer.from('OggS'), contentType: 'audio/ogg' }),
    'GET /media-1': () => ({ json: { url: 'https://cdn.test/voice.ogg', mime_type: 'audio/ogg' } }),
    'GET https://cdn.test/voice.ogg': () => ({ buffer: Buffer.from('voice'), contentType: 'audio/ogg' }),
    'POST /12345/media': () => ({ json: { id: 'media-out-1' } }),
    'POST /12345/messages': () => ({ json: { messages: [{ id: 'wamid.1' }] } }),
  });
  modelTurns.push(turn('ar', 'هلا والله! شاورما دجاج بثوم ولا بطحينة؟'));
  await handleInbound({ phone: PHONE, audioId: 'media-1', mimeType: 'audio/ogg' });
  assert.equal(sessions.get(PHONE).lang, 'ar');
  assert.match(prompts[0].messages[0].content, /so far: Arabic/);
});

test('with voice replies off, a voice note is understood but answered with text only', async () => {
  config.openai.voiceReplies = false;
  try {
    modelTurns.push(turn('ar', 'ضفت لك شاورمتين بالثوم.', { add: [{ item: 1, quantity: 2, options: ['1a'] }] }));
    await handleInbound({ phone: PHONE, audioId: 'media-1', mimeType: 'audio/ogg' });
    assert.equal(prompts[0].messages.at(-1).content, 'أبي شاورما دجاج ثنتين بثوم');
    const outbound = calls.filter((c) => c.url.includes('/12345/messages')).map(bodyOf);
    assert.deepEqual(outbound.map((m) => m.type), ['text']);
    assert.equal(calls.some((c) => c.url.includes('/audio/speech')), false);
  } finally {
    config.openai.voiceReplies = true;
  }
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
    turn('en', 'Great, here is your order.', { paymentMethod: 'ONLINE', action: 'place_order' }),
    // The model repeats the item while confirming; it must not become four shawarmas.
    turn('en', 'Placing your order now.', { add: [{ item: 1, quantity: 2, options: ['1a'] }], action: 'place_order' }),
  );
  await handleInbound({ phone: PHONE, text: 'two chicken shawarma with garlic' });
  await handleInbound({ phone: PHONE, text: 'delivery' });
  await handleInbound({ phone: PHONE, text: 'Sara, Salmiya block 4 street 5 building 12' });
  await handleInbound({ phone: PHONE, text: 'pay by link please' });

  // First place_order only shows the real order and waits for a yes.
  assert.equal(createdOrders.length, 0);
  const reviewMessage = sentMessages(calls).filter((m) => m.to === PHONE).at(-1);
  const review = reviewMessage.text;
  assert.match(review, /Please check your order:\n1\. 2 × Chicken Shawarma \(Garlic\) — 3\.000 KWD\nSubtotal: 3\.000 KWD/);
  assert.match(review, /Deliver to: Area Salmiya, Block 4, Street 5, Building 12\nPayment: payment link \(KNET or card\)/);
  assert.match(review, /Tap "Confirm order" or reply "yes"/);
  assert.deepEqual(reviewMessage.body.interactive.action.buttons.map((b) => b.reply.id), ['order:confirm', 'order:change']);

  // Typing "yes" instead of tapping the button also confirms.
  await handleInbound({ phone: PHONE, text: 'yes' });
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

test('an item the model repeats on later turns stays one line with the latest quantity', async () => {
  modelTurns.push(
    turn('ar', 'ضفت لك شاورما بالثوم.', { add: [{ item: 1, quantity: 1, options: ['1a'] }] }),
    turn('ar', 'تمام، شاورما وحدة بالثوم.', { add: [{ item: 1, quantity: 1, options: ['1a'] }] }),
    turn('ar', 'خليتها ثنتين.', { add: [{ item: 1, quantity: 2, options: ['1a'] }] }),
    turn('ar', 'وضفت شاورما بالطحينة.', { add: [{ item: 1, quantity: 1, options: ['1b'] }] }),
  );
  for (const text of ['أبي شاورما بثوم', 'إي وحدة', 'لا خلها ثنتين', 'وحدة طحينة بعد']) await handleInbound({ phone: PHONE, text });
  assert.deepEqual(sessions.get(PHONE).cart, [
    { menuItemId: 'item-shawarma', quantity: 2, optionIds: ['opt-garlic'] },
    { menuItemId: 'item-shawarma', quantity: 1, optionIds: ['opt-tahini'] },
  ]);
});

test('changing the order after the review asks for confirmation again', async () => {
  const session = sessions.get(PHONE);
  Object.assign(session, {
    lang: 'ar',
    cart: [{ menuItemId: 'item-shawarma', quantity: 2, optionIds: ['opt-garlic'] }],
    customer: { name: 'Sara', area: 'Salmiya', block: '4', street: '5', building: '12', notes: null },
    orderType: 'DELIVERY',
    paymentMethod: 'CASH',
  });
  modelTurns.push(
    turn('ar', 'تمام.', { action: 'place_order' }),
    turn('ar', 'زدتها ثلاث.', { add: [{ item: 1, quantity: 3, options: ['1a'] }], action: 'place_order' }),
    turn('ar', 'يالله نأكد.', { action: 'place_order' }),
  );
  await handleInbound({ phone: PHONE, text: 'خلاص بس' });
  assert.match(sentMessages(calls).at(-1).text, /راجع طلبك لو سمحت:\n1\. 2 × شاورما دجاج \(ثوم\)/);
  await handleInbound({ phone: PHONE, text: 'لا خلها ثلاث وأكد' });
  assert.equal(createdOrders.length, 0);
  assert.match(sentMessages(calls).at(-1).text, /1\. 3 × شاورما دجاج \(ثوم\)[\s\S]*الدفع: كاش عند الاستلام[\s\S]*اضغط "تأكيد الطلب" أو رد "إي"/);
  assert.equal(sentMessages(calls).at(-1).body.interactive.action.buttons[0].reply.title, 'تأكيد الطلب');
  await handleInbound({ phone: PHONE, text: 'إي' });
  assert.equal(createdOrders.length, 1);
  assert.deepEqual(createdOrders[0].items, [{ menuItemId: 'item-shawarma', quantity: 3, optionIds: ['opt-garlic'] }]);
});

test('asked for pictures, the agent sends item photos with name and price before its reply', async () => {
  modelTurns.push(turn('ar', 'هذي الصور، شرايك؟', { photos: [1, 2, 99, 1] }));
  await handleInbound({ phone: PHONE, text: 'عندك صور؟' });
  const out = sentMessages(calls).filter((m) => m.to === PHONE);
  assert.deepEqual(out.map((m) => m.type), ['image', 'text']);
  assert.equal(out[0].body.image.link, 'https://cdn.test/shawarma.png');
  assert.equal(out[0].body.image.caption, 'شاورما دجاج — 1.500 KWD');
  assert.equal(out[1].text, 'هذي الصور، شرايك؟');
  assert.match(prompts[0].messages[0].content, /You CAN show photos/);
});

test('a location pin reaches the agent, is confirmed with the Confirm button and travels with the order', async () => {
  const session = sessions.get(PHONE);
  Object.assign(session, {
    lang: 'en',
    cart: [{ menuItemId: 'item-shawarma', quantity: 2, optionIds: ['opt-garlic'] }],
    customer: { name: 'Sara', area: 'Fahaheel', block: '2', street: '25', building: '5', notes: null },
    orderType: 'DELIVERY',
    paymentMethod: 'CASH',
  });
  modelTurns.push(turn('en', 'Thanks for the pin!', { action: 'place_order' }));
  await handleInbound({ phone: PHONE, text: '', location: { lat: 29.0806, lng: 48.1306, label: 'Fahaheel, Block 2' } });
  assert.equal(prompts[0].messages.at(-1).content, '[Shared a map location: Fahaheel, Block 2]');
  assert.match(sentMessages(calls).at(-1).text, /Building 5 \(map pin received\)/);
  assert.equal(createdOrders.length, 0);

  // Tapping Confirm places the order without another model call (none is scripted).
  await handleInbound({ phone: PHONE, replyId: 'order:confirm', text: 'Confirm order' });
  assert.equal(createdOrders.length, 1);
  assert.equal(createdOrders[0].deliveryLat, 29.0806);
  assert.equal(createdOrders[0].deliveryLng, 48.1306);
  const kitchen = sentTexts(calls).filter((m) => m.to === KITCHEN).at(-1).text;
  assert.match(kitchen, /Map: https:\/\/maps\.google\.com\/\?q=29\.0806,48\.1306/);
  assert.match(sentTexts(calls).filter((m) => m.to === PHONE).at(-1).text, /Order MD-1001 is confirmed/);
  assert.equal(sessions.get(PHONE).location, null);

  // A stale Confirm tap after the order was placed does nothing on its own; it goes to the agent as text.
  modelTurns.push(turn('en', 'Your order is already with the kitchen.'));
  await handleInbound({ phone: PHONE, replyId: 'order:confirm', text: 'Confirm order' });
  assert.equal(createdOrders.length, 1);
});

test('the Change button reopens the order instead of placing it', async () => {
  const session = sessions.get(PHONE);
  Object.assign(session, { lang: 'ar', awaitingConfirmation: true, cart: [{ menuItemId: 'item-cola', quantity: 4, optionIds: [] }] });
  await handleInbound({ phone: PHONE, replyId: 'order:change', text: 'أبي أغيّر شي' });
  assert.equal(createdOrders.length, 0);
  assert.equal(sessions.get(PHONE).awaitingConfirmation, false);
  assert.equal(sentTexts(calls).at(-1).text, 'أكيد، شنو تبي تغيّر؟');
});

test('stickers and files get a clear "text, voice or location" answer, not a voice-note error', async () => {
  sessions.get(PHONE).lang = 'ar';
  await handleInbound({ phone: PHONE, text: '', unsupported: true });
  assert.match(sentTexts(calls).at(-1).text, /أقدر أقرأ الرسائل المكتوبة والصوتية والموقع/);
  assert.equal(prompts.length, 0);
});

test('WhatsApp message types are turned into agent input', () => {
  assert.deepEqual(wa.extractInput({ type: 'location', location: { latitude: 29.08, longitude: 48.13, name: 'Home', address: 'Fahaheel' } }), {
    text: '',
    location: { lat: 29.08, lng: 48.13, label: 'Home, Fahaheel' },
  });
  assert.deepEqual(wa.extractInput({ type: 'image', image: { id: 'm1', caption: 'I want this one' } }), { text: 'I want this one' });
  assert.deepEqual(wa.extractInput({ type: 'sticker', sticker: { id: 'm2' } }), { text: '', unsupported: true });
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
