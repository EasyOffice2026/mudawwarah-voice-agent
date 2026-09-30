import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { menu, settings, mockFetch, sentTexts, sentMessages } from './helpers.js';
import { config } from '../src/config.js';
import * as sessions from '../src/sessions.js';
import * as orders from '../src/orders.js';
import * as mdawra from '../src/mdawra.js';
import * as wa from '../src/whatsapp.js';
import { buildOrderFlow, cartFromFlowReply } from '../src/orderFlow.js';
import { handleInbound } from '../src/flow.js';

const PHONE = '96550001111';
const bigMenu = [
  { id: 'c1', nameEn: 'Sandwiches', nameAr: 'سندويتشات', items: Array.from({ length: 20 }, (_, i) => ({ id: `s-${i}`, nameEn: `Sandwich ${i}`, nameAr: `سندويتش ${i}`, price: '0.65', options: [] })) },
  { id: 'c2', nameEn: 'Drinks', items: Array.from({ length: 12 }, (_, i) => ({ id: `d-${i}`, nameEn: `Drink ${i}`, price: '0.15', options: [] })) },
];

test('the order form has a quantity picker per item, fits WhatsApp limits and carries every answer to the end', () => {
  const flow = buildOrderFlow(bigMenu);
  assert.equal(flow.version, '6.0');
  assert.deepEqual(flow.screens.map((s) => s.id), ['MENU_A', 'MENU_B']);
  assert.ok(flow.screens.every((s) => s.layout.children.length <= 50));

  const [first, second] = flow.screens;
  assert.deepEqual(first.layout.children.slice(0, 3), [
    { type: 'TextSubheading', text: 'سندويتشات · Sandwiches' },
    { type: 'TextBody', text: 'سندويتش 0 · Sandwich 0 — 0.650 KWD' },
    { type: 'Dropdown', name: 'q_s_0', label: 'الكمية · Qty', required: false, 'data-source': Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), title: String(i + 1) })) },
  ]);
  const next = first.layout.children.at(-1)['on-click-action'];
  assert.equal(next.name, 'navigate');
  assert.equal(next.next.name, 'MENU_B');
  assert.equal(next.payload.q_s_0, '${form.q_s_0}');

  assert.equal(second.terminal, true);
  assert.deepEqual(second.data.q_s_19, { type: 'string', __example__: '1' });
  const done = second.layout.children.at(-1)['on-click-action'];
  assert.equal(done.name, 'complete');
  assert.equal(done.payload.q_s_0, '${data.q_s_0}');
  assert.equal(done.payload.q_d_11, '${form.q_d_11}');
  assert.equal(Object.keys(done.payload).length, 32);
});

test('a completed form becomes cart lines; empty answers are ignored and unknown items reported', () => {
  const { lines, unavailable } = cartFromFlowReply({ flow_token: 'menu-1', q_item_shawarma: '2', q_item_cola: '', q_old_item: '1', q_item_hidden: '3' }, menu);
  assert.deepEqual(lines, [{ menuItemId: 'item-shawarma', quantity: 2, optionIds: [] }]);
  assert.deepEqual(unavailable, ['q_old_item', 'q_item_hidden']);
});

test('the Flow reply webhook message is read as form answers', () => {
  assert.deepEqual(
    wa.extractInput({ type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: '{"flow_token":"menu-1","q_item_cola":"3"}' } } }),
    { text: '', flowReply: { flow_token: 'menu-1', q_item_cola: '3' } },
  );
});

let calls;
let prompts;
let modelTurns;
const turn = (reply, extra = {}) => ({ lang: 'en', reply, add: [], remove: [], photos: [], pickupBranch: null, customer: { name: null, area: null, block: null, street: null, building: null, notes: null }, orderType: null, paymentMethod: null, action: 'none', complaint: null, ...extra });

beforeEach(() => {
  config.whatsapp.orderFlowId = 'flow-77';
  sessions.clearAll();
  orders.clearAll();
  mdawra.clearCache();
  prompts = [];
  modelTurns = [];
  calls = mockFetch({
    'GET /categories': () => ({ json: menu }),
    'GET /settings': () => ({ json: settings }),
    'GET /pickup-locations': () => ({ json: [] }),
    'POST /chat/completions': (_url, init) => {
      prompts.push(JSON.parse(init.body));
      return { json: { choices: [{ message: { content: JSON.stringify(modelTurns.shift()) } }] } };
    },
    'POST /12345/messages': () => ({ json: { messages: [{ id: 'wamid.1' }] } }),
  });
});
afterEach(() => {
  config.whatsapp.orderFlowId = '';
});

test('with the order form set up, "Browse the menu" and "menu" send the form instead of the category list', async () => {
  sessions.get(PHONE).greeted = true;
  await handleInbound({ phone: PHONE, replyId: 'menu:browse', text: 'Browse the menu' });
  const form = sentMessages(calls).at(-1).body.interactive;
  assert.equal(form.type, 'flow');
  assert.equal(form.action.parameters.flow_id, 'flow-77');
  assert.equal(form.action.parameters.flow_cta, 'Open menu');
  assert.deepEqual(form.action.parameters.flow_action_payload, { screen: 'MENU_A' });
  assert.equal(form.action.parameters.mode, undefined, 'published forms are sent without a mode');

  config.whatsapp.orderFlowMode = 'draft';
  await handleInbound({ phone: PHONE, replyId: 'menu:browse', text: 'Browse the menu' });
  assert.equal(sentMessages(calls).at(-1).body.interactive.action.parameters.mode, 'draft');
  config.whatsapp.orderFlowMode = 'published';

  sessions.get(PHONE).lang = 'ar';
  await handleInbound({ phone: PHONE, text: 'منيو' });
  assert.equal(sentMessages(calls).at(-1).body.interactive.action.parameters.flow_cta, 'افتح المنيو');
  assert.equal(prompts.length, 0);
});

test('the form answers are added to the cart together and the agent carries on with the order', async () => {
  Object.assign(sessions.get(PHONE), { greeted: true, cart: [{ menuItemId: 'item-cola', quantity: 1, optionIds: [] }] });
  modelTurns.push(turn('Got it! Delivery or pickup?'));
  await handleInbound({ phone: PHONE, text: '', flowReply: { flow_token: 'menu-1', q_item_shawarma: '2', q_item_cola: '4' } });
  assert.deepEqual(sessions.get(PHONE).cart, [
    { menuItemId: 'item-cola', quantity: 4, optionIds: [] },
    { menuItemId: 'item-shawarma', quantity: 2, optionIds: [] },
  ]);
  assert.equal(prompts[0].messages.at(-1).content, '[Picked in the WhatsApp order form: 2 × Chicken Shawarma, 4 × Cola]');
  assert.match(prompts[0].messages[0].content, /Picked in the WhatsApp order form/);
  assert.equal(sentTexts(calls).at(-1).text, 'Got it! Delivery or pickup?');
});

test('a form sent with no quantities gets a clear hint and no model call', async () => {
  sessions.get(PHONE).greeted = true;
  await handleInbound({ phone: PHONE, text: '', flowReply: { flow_token: 'menu-1', q_item_shawarma: '' } });
  assert.match(sentTexts(calls).at(-1).text, /did not choose any quantities/);
  assert.equal(prompts.length, 0);
});

test('if WhatsApp rejects the form, the customer gets the category list instead', async () => {
  calls = mockFetch({
    'GET /categories': () => ({ json: menu }),
    'POST /12345/messages': (_url, init) =>
      JSON.parse(init.body).interactive?.type === 'flow' ? { status: 400, json: { error: { message: 'Flow is deprecated' } } } : { json: { messages: [{ id: 'wamid.1' }] } },
  });
  sessions.get(PHONE).greeted = true;
  await handleInbound({ phone: PHONE, text: 'menu' });
  assert.equal(sentMessages(calls).at(-1).body.interactive.type, 'list');
});
