import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { menu, settings, mockFetch, bodyOf, sentTexts, sentMessages } from './helpers.js';
import { config } from '../src/config.js';
import * as sessions from '../src/sessions.js';
import * as orders from '../src/orders.js';
import * as mdawra from '../src/mdawra.js';
import * as wa from '../src/whatsapp.js';
import { productListGroups, cartFromOrder, catalogProducts, syncCatalog } from '../src/catalog.js';
import { handleInbound } from '../src/flow.js';

const PHONE = '96550001111';
const item = (id, extra = {}) => ({ id, nameEn: `Item ${id}`, price: '1', image: { url: `https://cdn.test/${id}.png` }, options: [], ...extra });
const category = (id, count, extra = {}) => ({ id, nameEn: id, nameAr: `ق ${id}`, items: Array.from({ length: count }, (_, i) => item(`${id}-${i + 1}`)), ...extra });

// Shaped like the live menu: 6 categories, 40 items.
const liveLike = [category('Picks', 6), category('Sandwiches', 11), category('Boxes', 3), category('Drinks', 11), category('Khalia', 6), category('IceCream', 3)];

test('the menu is packed into product messages of at most 30 items, whole categories in menu order', () => {
  const groups = productListGroups(liveLike);
  assert.deepEqual(groups.map((g) => g.map((s) => [s.title, s.productIds.length])), [
    [['Picks', 6], ['Sandwiches', 11], ['Boxes', 3]],
    [['Drinks', 11], ['Khalia', 6], ['IceCream', 3]],
  ]);
  assert.ok(groups.every((g) => g.reduce((n, s) => n + s.productIds.length, 0) <= 30));
  assert.equal(productListGroups(liveLike, 'ar')[0][0].title, 'ق Picks');
});

test('an item listed in two categories is shown once, and unavailable items are left out', () => {
  const shared = item('shared');
  const groups = productListGroups([
    { id: 'a', nameEn: 'A', items: [shared, item('gone', { isOutOfStock: true })] },
    { id: 'b', nameEn: 'B', items: [shared, item('b1')] },
  ]);
  assert.deepEqual(groups, [[{ title: 'A', productIds: ['shared'] }, { title: 'B', productIds: ['b1'] }]]);
});

test('a WhatsApp cart order maps onto menu items; unknown products are reported, repeats merged', () => {
  const { lines, unavailable } = cartFromOrder(
    [{ retailerId: 'item-shawarma', quantity: 2 }, { retailerId: 'item-cola', quantity: 3 }, { retailerId: 'item-shawarma', quantity: 1 }, { retailerId: 'old-item', quantity: 1 }],
    menu,
  );
  assert.deepEqual(lines, [
    { menuItemId: 'item-shawarma', quantity: 3, optionIds: [] },
    { menuItemId: 'item-cola', quantity: 3, optionIds: [] },
  ]);
  assert.deepEqual(unavailable, ['old-item']);
});

test('catalogue products carry photo, KWD price, availability and the menu item ID', () => {
  const products = catalogProducts([{ id: 'c', nameEn: 'C', items: [item('x', { price: '0.65', nameAr: 'إكس', descriptionEn: 'Tasty' }), item('y', { isOutOfStock: true }), { id: 'no-photo', nameEn: 'N', price: '1' }] }]);
  assert.deepEqual(products[0], {
    id: 'x',
    title: 'Item x',
    description: 'Tasty — إكس',
    availability: 'in stock',
    condition: 'new',
    price: '0.650 KWD',
    link: 'https://www.madawarah.com/r/mdawra',
    image_link: 'https://cdn.test/x.png',
    brand: 'Mudawwarah',
  });
  assert.equal(products[1].availability, 'out of stock');
  assert.equal(products.length, 2, 'items without a photo are not uploaded');
});

test('sync uploads the menu and marks products that left the menu as out of stock', async () => {
  config.whatsapp.catalogId = 'cat-99';
  try {
    const calls = mockFetch({
      'GET /cat-99/products': () => ({ json: { data: [{ retailer_id: 'x' }, { retailer_id: 'retired' }] } }),
      'POST /cat-99/items_batch': () => ({ json: { handles: ['h1'] } }),
    });
    const result = await syncCatalog([{ id: 'c', nameEn: 'C', items: [item('x')] }]);
    assert.deepEqual(result, { uploaded: 1, retired: 1, handles: ['h1'] });
    const batch = bodyOf(calls.find((c) => c.url.includes('items_batch')));
    assert.equal(batch.allow_upsert, true);
    assert.deepEqual(batch.requests.map((r) => [r.method, r.data.id, r.data.availability]), [['UPDATE', 'x', 'in stock'], ['UPDATE', 'retired', 'out of stock']]);
  } finally {
    config.whatsapp.catalogId = '';
  }
});

test('the order webhook message is read as a cart', () => {
  assert.deepEqual(
    wa.extractInput({ type: 'order', order: { catalog_id: 'cat-99', text: 'no onions', product_items: [{ product_retailer_id: 'item-cola', quantity: '2', item_price: 0.5, currency: 'KWD' }] } }),
    { text: 'no onions', cartOrder: [{ retailerId: 'item-cola', quantity: 2, price: 0.5 }] },
  );
});

describe_withCatalogue();

function describe_withCatalogue() {
  let calls;
  let prompts;
  let modelTurns;
  let createdOrders;
  const turn = (reply, extra = {}) => ({ lang: 'en', reply, add: [], remove: [], photos: [], customer: { name: null, area: null, block: null, street: null, building: null, notes: null }, orderType: null, paymentMethod: null, action: 'none', complaint: null, ...extra });

  beforeEach(() => {
    config.whatsapp.catalogId = 'cat-99';
    sessions.clearAll();
    orders.clearAll();
    mdawra.clearCache();
    prompts = [];
    modelTurns = [];
    createdOrders = [];
    calls = mockFetch({
      'GET /categories': () => ({ json: menu }),
      'GET /settings': () => ({ json: settings }),
      'POST /orders': (_url, init) => {
        createdOrders.push(JSON.parse(init.body));
        return { json: { id: 'order-1', orderNumber: 'MD-1001', status: 'PENDING', total: '5.000', orderType: 'DELIVERY', customerName: 'Sara', customerPhone: PHONE, items: [{ nameEn: 'Chicken Shawarma', quantity: 2 }, { nameEn: 'Cola', quantity: 4 }] } };
      },
      'POST /chat/completions': (_url, init) => {
        prompts.push(JSON.parse(init.body));
        return { json: { choices: [{ message: { content: JSON.stringify(modelTurns.shift()) } }] } };
      },
      'POST /12345/messages': () => ({ json: { messages: [{ id: 'wamid.1' }] } }),
    });
  });
  afterEach(() => {
    config.whatsapp.catalogId = '';
  });

  test('with a catalogue, "menu" and "Browse the menu" send product messages instead of the category list', async () => {
    sessions.get(PHONE).greeted = true;
    await handleInbound({ phone: PHONE, text: 'menu' });
    const [productList] = sentMessages(calls);
    assert.equal(productList.body.interactive.type, 'product_list');
    assert.equal(productList.body.interactive.action.catalog_id, 'cat-99');
    assert.equal(productList.body.interactive.header.text, 'Mudawwarah menu');
    assert.deepEqual(productList.body.interactive.action.sections, [
      { title: 'Mains', product_items: [{ product_retailer_id: 'item-shawarma' }] },
      { title: 'Drinks', product_items: [{ product_retailer_id: 'item-cola' }] },
    ]);

    await handleInbound({ phone: PHONE, replyId: 'menu:browse', text: 'Browse the menu' });
    assert.equal(sentMessages(calls).at(-1).body.interactive.type, 'product_list');
    assert.equal(prompts.length, 0);
  });

  test('"Place order" from the WhatsApp cart becomes the order: details are collected, reviewed and placed', async () => {
    modelTurns.push(
      turn('Thanks! What is your name and delivery address, and how would you like to pay?'),
      turn('Got it.', { customer: { name: 'Sara', area: 'Salmiya', block: '4', street: '5', building: '12', notes: null }, orderType: 'DELIVERY', paymentMethod: 'CASH', action: 'place_order' }),
    );
    await handleInbound({ phone: PHONE, cartOrder: [{ retailerId: 'item-shawarma', quantity: 2 }, { retailerId: 'item-cola', quantity: 4 }, { retailerId: 'discontinued', quantity: 1 }], text: '' });
    const session = sessions.get(PHONE);
    assert.deepEqual(session.cart, [
      { menuItemId: 'item-shawarma', quantity: 2, optionIds: [] },
      { menuItemId: 'item-cola', quantity: 4, optionIds: [] },
    ]);
    assert.equal(prompts[0].messages.at(-1).content, '[Sent a cart from the WhatsApp catalogue: 2 × Chicken Shawarma, 4 × Cola]');
    assert.match(prompts[0].messages[0].content, /1\. 2 × Chicken Shawarma[\s\S]*2\. 4 × Cola/);
    assert.match(sentTexts(calls).at(-1).text, /^Some items in your cart are no longer available and were left out\.\n\nThanks!/);

    await handleInbound({ phone: PHONE, text: 'Sara, Salmiya block 4 street 5 building 12, cash' });
    assert.match(sentMessages(calls).at(-1).text, /Please check your order:\n1\. 2 × Chicken Shawarma — 3\.000 KWD\n2\. 4 × Cola — 2\.000 KWD/);
    await handleInbound({ phone: PHONE, replyId: 'order:confirm', text: 'Confirm order' });
    assert.deepEqual(createdOrders[0].items, [
      { menuItemId: 'item-shawarma', quantity: 2, optionIds: [] },
      { menuItemId: 'item-cola', quantity: 4, optionIds: [] },
    ]);
    assert.match(sentTexts(calls).at(-1).text, /Order MD-1001 is confirmed\.\n2 × Chicken Shawarma\n4 × Cola/);
  });

  test('if WhatsApp rejects the catalogue message, the customer gets the category list instead', async () => {
    let productListCalls = 0;
    calls = mockFetch({
      'GET /categories': () => ({ json: menu }),
      'POST /12345/messages': (_url, init) => {
        if (JSON.parse(init.body).interactive?.type === 'product_list') {
          productListCalls += 1;
          return { status: 400, json: { error: { message: 'Catalog not linked' } } };
        }
        return { json: { messages: [{ id: 'wamid.1' }] } };
      },
    });
    sessions.get(PHONE).greeted = true;
    await handleInbound({ phone: PHONE, text: 'menu' });
    assert.equal(productListCalls, 1);
    const last = sentMessages(calls).at(-1);
    assert.equal(last.body.interactive.type, 'list');
    assert.deepEqual(last.body.interactive.action.sections[0].rows.map((r) => r.id), ['cat:cat-1:0', 'cat:cat-2:0']);
  });

  test('a cart with nothing still on the menu gets a clear answer and no model call', async () => {
    await handleInbound({ phone: PHONE, cartOrder: [{ retailerId: 'discontinued', quantity: 1 }], text: '' });
    assert.match(sentTexts(calls).at(-1).text, /no longer available/);
    assert.equal(prompts.length, 0);
  });
}
