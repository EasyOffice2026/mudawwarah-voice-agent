import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menu, settings } from './helpers.js';
import { buildCatalogue, applyCartChanges, applyCustomerDetails, priceCart, missingForOrder, allowedPaymentMethods, systemPrompt, RESPONSE_SCHEMA } from '../src/agent.js';
import { blank } from '../src/sessions.js';

const catalogue = buildCatalogue(menu);

test('catalogue numbers available items and codes their options', () => {
  assert.deepEqual(catalogue.items.map((c) => c.item.id), ['item-shawarma', 'item-cola']);
  assert.deepEqual(catalogue.items[0].options.map((o) => o.code), ['1a', '1b', '1c']);
  assert.match(catalogue.text, /\[1\] Chicken Shawarma \/ شاورما دجاج — 1\.500 KWD \(popular\)/);
  assert.match(catalogue.text, /REQUIRED Sauce \/ الصوص: 1a=Garlic\/ثوم, 1b=Tahini\/طحينة/);
  assert.match(catalogue.text, /optional Extras.*1c=Extra cheese\/جبن إضافي \+0\.250 KWD/);
  assert.doesNotMatch(catalogue.text, /Hidden/);
});

test('adding an item without its required option is refused and reported', () => {
  const { cart, added, missingOptions } = applyCartChanges([], { add: [{ item: 1, quantity: 2, options: [] }], remove: [] }, catalogue);
  assert.equal(cart.length, 0);
  assert.equal(added.length, 0);
  assert.deepEqual(missingOptions[0].groups, ['Sauce']);
});

test('valid additions are priced from the live menu, clamped and de-duplicated per group', () => {
  const { cart } = applyCartChanges(
    [],
    { add: [{ item: 1, quantity: 99, options: ['1a', '1b', '1c', 'zz'] }, { item: 2, quantity: 0, options: [] }, { item: 42, quantity: 1, options: [] }], remove: [] },
    catalogue,
  );
  assert.deepEqual(cart, [
    { menuItemId: 'item-shawarma', quantity: 20, optionIds: ['opt-garlic', 'opt-cheese'] },
    { menuItemId: 'item-cola', quantity: 1, optionIds: [] },
  ]);
  const priced = priceCart(cart, catalogue);
  assert.equal(priced.lines[0].unit, 1.75);
  assert.equal(priced.subtotal, 35.5);
});

test('remove uses 1-based cart line numbers and ignores bad ones', () => {
  const start = [{ menuItemId: 'item-shawarma', quantity: 1, optionIds: ['opt-garlic'] }, { menuItemId: 'item-cola', quantity: 1, optionIds: [] }];
  const { cart } = applyCartChanges(start, { add: [], remove: [1, 7] }, catalogue);
  assert.deepEqual(cart.map((l) => l.menuItemId), ['item-cola']);
});

test('customer details merge without erasing what is already known', () => {
  const session = blank('96550000000');
  applyCustomerDetails(session, { customer: { name: 'Sara', area: 'Salmiya', block: null, street: '', building: null, notes: null }, orderType: 'DELIVERY', paymentMethod: 'ONLINE' });
  applyCustomerDetails(session, { customer: { name: null, area: null, block: '4', street: null, building: null, notes: null }, orderType: null, paymentMethod: 'ONLINE' }, { onlinePayment: true });
  assert.deepEqual(session.customer, { name: 'Sara', area: 'Salmiya', block: '4', street: null, building: null, notes: null });
  assert.equal(session.orderType, 'DELIVERY');
  assert.equal(session.paymentMethod, 'ONLINE');
});

test('ONLINE payment is only accepted when a payment link provider is enabled', () => {
  const session = blank('1');
  applyCustomerDetails(session, { customer: {}, orderType: null, paymentMethod: 'ONLINE' }, { onlinePayment: false });
  assert.equal(session.paymentMethod, null);
  assert.deepEqual(allowedPaymentMethods(settings, true), ['ONLINE', 'CASH', 'CARD']);
  assert.deepEqual(allowedPaymentMethods({ paymentMethods: 'CASH' }), ['CASH']);
});

test('missingForOrder asks delivery or pickup first, then lists the address only for delivery', () => {
  const session = blank('1');
  session.cart = [{ menuItemId: 'item-cola', quantity: 1, optionIds: [] }];
  assert.deepEqual(missingForOrder(session, settings).missing, ['name', 'orderType', 'paymentMethod']);
  session.orderType = 'DELIVERY';
  assert.deepEqual(missingForOrder(session, settings).missing, ['name', 'area', 'block', 'street', 'building', 'paymentMethod']);
  assert.deepEqual(missingForOrder({ ...session, orderType: null }, { ...settings, pickupEnabled: 'false' }).missing, ['name', 'area', 'block', 'street', 'building', 'paymentMethod']);
  session.orderType = 'PICKUP';
  session.customer.name = 'Ali';
  session.paymentMethod = 'CASH';
  assert.deepEqual(missingForOrder(session, settings), { missing: [], orderType: 'PICKUP' });
});

test('system prompt carries the catalogue, the draft and the payment options', () => {
  const session = blank('1');
  session.customer.name = 'Ali';
  const prompt = systemPrompt({ settings, catalogue, session, restaurantName: 'Mudawwarah', onlinePayment: true });
  assert.match(prompt, /ONLINE \(pay now by KNET or card/);
  assert.match(prompt, /name: Ali/);
  assert.match(prompt, /\[2\] Cola/);
  assert.match(prompt, /Minimum order: 2\.000 KWD/);
});

test('response schema is strict-mode compatible (every property required, no additional properties)', () => {
  const check = (schema) => {
    if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...(schema.required || [])].sort(), Object.keys(schema.properties).sort());
      Object.values(schema.properties).forEach(check);
    }
    if (schema.items) check(schema.items);
  };
  check(RESPONSE_SCHEMA);
});
