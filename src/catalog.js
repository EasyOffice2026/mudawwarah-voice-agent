/**
 * WhatsApp's native catalogue: the menu as Meta Commerce products, shown in
 * multi-product messages with photos, a built-in cart and +/− quantities.
 * The customer's "Place order" arrives as an `order` webhook message.
 *
 * Product retailer IDs are Mdawra menu item IDs, so an order maps straight back
 * onto the menu and is still priced by Mdawra, never by the catalogue.
 */
import { config } from './config.js';

// WhatsApp limits for one product-list message.
const MAX_ITEMS = 30;
const MAX_SECTIONS = 10;

export const isCatalogEnabled = () => Boolean(config.whatsapp.catalogId);

const orderable = (categories) =>
  (categories || [])
    .map((category) => ({ ...category, items: (category.items || []).filter((item) => item.isAvailable !== false && !item.isOutOfStock) }))
    .filter((category) => category.items.length);

/**
 * Packs categories into as few product-list messages as the limits allow,
 * keeping each category whole and in menu order (40 items → two messages).
 * An item that sits in two categories is shown once, in the first.
 */
export const productListGroups = (categories, lang = 'en') => {
  const groups = [];
  const shown = new Set();
  let current = null;
  for (const category of orderable(categories)) {
    const ids = category.items.map((i) => i.id).filter((id) => !shown.has(id)).slice(0, MAX_ITEMS);
    if (!ids.length) continue;
    ids.forEach((id) => shown.add(id));
    if (!current || current.count + ids.length > MAX_ITEMS || current.sections.length >= MAX_SECTIONS) {
      current = { count: 0, sections: [] };
      groups.push(current);
    }
    current.sections.push({ title: (lang === 'ar' && category.nameAr) || category.nameEn, productIds: ids });
    current.count += ids.length;
  }
  return groups.map((g) => g.sections);
};

/** Maps a WhatsApp cart order onto cart lines; unknown or unavailable products are reported, not added. */
export const cartFromOrder = (productItems, categories) => {
  const byId = new Map(orderable(categories).flatMap((c) => c.items.map((i) => [i.id, i])));
  const lines = [];
  const unavailable = [];
  for (const product of productItems || []) {
    const item = byId.get(String(product.retailerId));
    const quantity = Math.min(20, Math.max(1, Math.round(Number(product.quantity) || 1)));
    if (!item) {
      unavailable.push(product.retailerId);
      continue;
    }
    const existing = lines.find((l) => l.menuItemId === item.id);
    if (existing) existing.quantity = Math.min(20, existing.quantity + quantity);
    else lines.push({ menuItemId: item.id, quantity, optionIds: [] });
  }
  return { lines, unavailable };
};

const siteUrl = () => (config.whatsapp.catalogSiteUrl || 'https://www.madawarah.com').replace(/\/$/, '');

/** One Meta catalogue product per menu item, for the items_batch API. */
export const catalogProducts = (categories) => {
  const products = new Map();
  for (const category of categories || []) {
    for (const item of category.items || []) {
      if (products.has(item.id)) continue;
      const available = item.isAvailable !== false && !item.isOutOfStock;
      products.set(item.id, {
        id: item.id,
        title: item.nameEn,
        description: [item.descriptionEn, item.nameAr].filter(Boolean).join(' — ') || item.nameEn,
        availability: available ? 'in stock' : 'out of stock',
        condition: 'new',
        price: `${Number(item.price).toFixed(3)} KWD`,
        link: `${siteUrl()}/r/${config.mdawra.tenant}`,
        image_link: item.image?.url || undefined,
        brand: 'Mudawwarah',
      });
    }
  }
  return [...products.values()].filter((p) => p.image_link);
};

const FEED_COLUMNS = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'brand'];
const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * The same products as a CSV data feed, for Commerce Manager's scheduled
 * feed. It keeps the catalogue in sync without the catalog_management permission.
 */
export const catalogFeedCsv = (categories) =>
  `﻿${[FEED_COLUMNS.join(','), ...catalogProducts(categories).map((p) => FEED_COLUMNS.map((c) => csvCell(p[c])).join(','))].join('\n')}\n`;

const graph = async (path, { method = 'GET', body, token = config.whatsapp.catalogToken || config.whatsapp.token } = {}) => {
  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${path}`;
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Graph API ${method} ${path} failed with status ${response.status}`);
  return data;
};

/**
 * Uploads the menu to the catalogue (create or update every item) and marks
 * catalogue products that left the menu as out of stock. Returns a summary.
 */
export const syncCatalog = async (categories) => {
  const catalogId = config.whatsapp.catalogId;
  if (!catalogId) throw new Error('WHATSAPP_CATALOG_ID is not set');
  const products = catalogProducts(categories);
  const onMenu = new Set(products.map((p) => p.id));

  const existing = [];
  let next = `${catalogId}/products?fields=retailer_id&limit=200`;
  while (next) {
    const page = await graph(next);
    existing.push(...(page.data || []).map((p) => p.retailer_id));
    next = page.paging?.next ? page.paging.next.replace(/^https:\/\/graph\.facebook\.com\/[^/]+\//, '') : null;
  }
  const retired = existing.filter((id) => !onMenu.has(id));

  const requests = [
    ...products.map((data) => ({ method: 'UPDATE', data })),
    ...retired.map((id) => ({ method: 'UPDATE', data: { id, availability: 'out of stock' } })),
  ];
  const result = await graph(`${catalogId}/items_batch`, { method: 'POST', body: { item_type: 'PRODUCT_ITEM', allow_upsert: true, requests } });
  return { uploaded: products.length, retired: retired.length, handles: result.handles || [] };
};

/** Shows the catalogue and the cart button on the business's WhatsApp number. */
export const enableCommerceSettings = () =>
  graph(`${config.whatsapp.phoneNumberId}/whatsapp_commerce_settings?is_catalog_visible=true&is_cart_enabled=true`, { method: 'POST', token: config.whatsapp.token });
