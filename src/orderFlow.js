/**
 * The menu as a WhatsApp Flow: one "Order" button opens a form inside WhatsApp
 * listing every item (grouped by category, with name and price) and a quantity
 * picker for each, so a customer picks several items and quantities at once and
 * sends them together. The reply arrives as an `nfm_reply` interactive message.
 *
 * The form is generated from the live menu and published through the Flows API
 * (npm run flow:sync). Field names carry the Mdawra menu item ID, so a reply maps
 * straight back onto the menu and is priced by Mdawra, never by the form.
 */
import { config } from './config.js';

export const isOrderFlowEnabled = () => Boolean(config.whatsapp.orderFlowId);

export const FLOW_JSON_VERSION = '6.0';
// WhatsApp allows at most 50 components per screen; each item uses two (name line + quantity).
const MAX_COMPONENTS = 48;
const QUANTITIES = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), title: String(i + 1) }));

// Screen IDs may only contain letters and underscores: MENU_A, MENU_B…
export const screenId = (index) => `MENU_${String.fromCharCode(65 + index)}`;
const fieldFor = (itemId) => `q_${String(itemId).replace(/[^A-Za-z0-9]/g, '_')}`;
const money = (value) => `${Number(value).toFixed(3)} KWD`;
const label = (o) => (o.nameAr && o.nameAr !== o.nameEn ? `${o.nameAr} · ${o.nameEn}` : o.nameEn);

const orderable = (categories) =>
  (categories || [])
    .map((category) => ({ ...category, items: (category.items || []).filter((item) => item.isAvailable !== false && !item.isOutOfStock) }))
    .filter((category) => category.items.length);

/** Splits the menu into screens of whole categories that fit the component limit; items shown once. */
const screensFor = (categories) => {
  const screens = [];
  const shown = new Set();
  let current = null;
  for (const category of orderable(categories)) {
    const items = category.items.filter((item) => !shown.has(item.id));
    if (!items.length) continue;
    items.forEach((item) => shown.add(item.id));
    const size = 1 + items.length * 2;
    if (!current || current.size + size > MAX_COMPONENTS) {
      current = { size: 0, categories: [] };
      screens.push(current);
    }
    current.categories.push({ ...category, items });
    current.size += size;
  }
  return screens;
};

/** The Flow JSON: one screen per group of categories, quantities carried forward, completed on the last. */
export const buildOrderFlow = (categories) => {
  const groups = screensFor(categories);
  const fieldsSoFar = [];
  const screens = groups.map((group, index) => {
    const id = screenId(index);
    const last = index === groups.length - 1;
    const previous = [...fieldsSoFar];
    const own = group.categories.flatMap((c) => c.items.map((item) => fieldFor(item.id)));
    fieldsSoFar.push(...own);
    const carry = Object.fromEntries([...previous.map((f) => [f, `\${data.${f}}`]), ...own.map((f) => [f, `\${form.${f}}`])]);
    const children = group.categories.flatMap((category) => [
      { type: 'TextSubheading', text: label(category) },
      ...category.items.flatMap((item) => [
        { type: 'TextBody', text: `${label(item)} — ${money(item.price)}` },
        { type: 'Dropdown', name: fieldFor(item.id), label: 'الكمية · Qty', required: false, 'data-source': QUANTITIES },
      ]),
    ]);
    children.push({
      type: 'Footer',
      label: last ? 'أضف للطلب · Add to order' : 'التالي · Next',
      'on-click-action': last
        ? { name: 'complete', payload: carry }
        : { name: 'navigate', next: { type: 'screen', name: screenId(index + 1) }, payload: carry },
    });
    return {
      id,
      title: groups.length > 1 ? `المنيو · Menu (${index + 1}/${groups.length})` : 'المنيو · Menu',
      ...(last ? { terminal: true, success: true } : {}),
      data: Object.fromEntries(previous.map((f) => [f, { type: 'string', __example__: '1' }])),
      layout: { type: 'SingleColumnLayout', children },
    };
  });
  return { version: FLOW_JSON_VERSION, screens };
};

/** Maps a completed form (field → quantity) onto cart lines; unknown items are reported, not added. */
export const cartFromFlowReply = (response, categories) => {
  const byField = new Map(orderable(categories).flatMap((c) => c.items.map((i) => [fieldFor(i.id), i])));
  const lines = [];
  const unavailable = [];
  for (const [field, value] of Object.entries(response || {})) {
    if (!field.startsWith('q_')) continue;
    const quantity = Math.min(20, Math.round(Number(value) || 0));
    if (quantity <= 0) continue;
    const item = byField.get(field);
    if (!item) {
      unavailable.push(field);
      continue;
    }
    if (!lines.some((l) => l.menuItemId === item.id)) lines.push({ menuItemId: item.id, quantity, optionIds: [] });
  }
  return { lines, unavailable };
};

const graph = async (path, { method = 'GET', body, form } = {}) => {
  const response = await fetch(`https://graph.facebook.com/${config.whatsapp.apiVersion}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = data?.error?.error_user_msg || data?.error?.message;
    throw new Error(details || `Graph API ${method} ${path} failed with status ${response.status}`);
  }
  return data;
};

/**
 * Publishes the current menu as a new Flow. Published Flows cannot be edited, so
 * each menu change creates a new one and the previous one is deprecated.
 * Returns { flowId, validationErrors }; nothing is published when validation fails.
 */
export const publishOrderFlow = async ({ wabaId, categories, previousFlowId = null, publish = true }) => {
  const created = await graph(`${wabaId}/flows`, { method: 'POST', body: { name: `Mudawwarah menu ${new Date().toISOString().slice(0, 16)}`, categories: ['OTHER'] } });
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append('file', new Blob([JSON.stringify(buildOrderFlow(categories))], { type: 'application/json' }), 'flow.json');
  const upload = await graph(`${created.id}/assets`, { method: 'POST', form });
  const validationErrors = upload.validation_errors || [];
  if (validationErrors.length || !publish) return { flowId: created.id, validationErrors };
  await graph(`${created.id}/publish`, { method: 'POST' });
  if (previousFlowId) await graph(`${previousFlowId}/deprecate`, { method: 'POST' }).catch(() => {});
  return { flowId: created.id, validationErrors };
};
