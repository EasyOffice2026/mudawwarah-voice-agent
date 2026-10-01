/**
 * The menu as a small web page served by this bot: photos, categories, +/−
 * quantities and a cart, opened from a button in the WhatsApp chat (in the
 * phone's browser: WhatsApp has no in-app browser on iPhone). "Send order" posts the cart back here, returns the customer to the chat, and the chat
 * carries on. It needs no Meta approval, unlike the catalogue or WhatsApp Flows.
 *
 * Each link is signed for one customer's phone number and expires, so a cart can
 * only ever reach the chat it was opened from. Prices are never taken from the
 * page: the cart holds item IDs and quantities, and Mdawra prices the order.
 */
import crypto from 'crypto';
import { config } from './config.js';

const LINK_HOURS = 24;

export const isMenuPageEnabled = () => config.menuPage.enabled && /^https:\/\//.test(config.publicUrl);

const secret = () => config.menuPage.secret || config.whatsapp.appSecret || config.adminToken || 'mudawwarah-menu';
const sign = (value) => crypto.createHmac('sha256', secret()).update(value).digest('base64url').slice(0, 32);

/** A link token for this phone: "<phone>.<expiry>.<signature>", URL-safe. */
export const createMenuToken = (phone, now = Date.now()) => {
  const body = `${String(phone).replace(/\D/g, '')}.${Math.floor(now / 1000) + LINK_HOURS * 3600}`;
  return `${body}.${sign(body)}`;
};

/** The phone number a token was issued for, or null when it is forged, malformed or expired. */
export const verifyMenuToken = (token, now = Date.now()) => {
  const match = /^(\d{6,15})\.(\d{9,11})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!match) return null;
  const expected = sign(`${match[1]}.${match[2]}`);
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(match[3]))) return null;
  if (Number(match[2]) * 1000 < now) return null;
  return match[1];
};

export const menuPageUrl = (phone) => `${config.publicUrl}/m/${createMenuToken(phone)}`;

const orderable = (categories) =>
  (categories || [])
    .map((category) => ({ ...category, items: (category.items || []).filter((item) => item.isAvailable !== false && !item.isOutOfStock) }))
    .filter((category) => category.items.length);

/** Maps the page's cart ({ id, qty }) onto cart lines; unknown or unavailable items are dropped. */
export const cartFromPage = (items, categories) => {
  const byId = new Map(orderable(categories).flatMap((c) => c.items.map((i) => [i.id, i])));
  const lines = [];
  for (const entry of Array.isArray(items) ? items : []) {
    const item = byId.get(String(entry?.id));
    const quantity = Math.min(20, Math.round(Number(entry?.qty) || 0));
    if (!item || quantity <= 0 || lines.some((l) => l.menuItemId === item.id)) continue;
    lines.push({ menuItemId: item.id, quantity, optionIds: [] });
  }
  return lines;
};

/** What the page needs: categories with items (shown once each), names in both languages, price and photo. */
const pageMenu = (categories) => {
  const shown = new Set();
  return orderable(categories)
    .map((category) => ({
      id: category.id,
      en: category.nameEn,
      ar: category.nameAr || category.nameEn,
      items: category.items
        .filter((item) => !shown.has(item.id) && shown.add(item.id))
        .map((item) => ({
          id: item.id,
          en: item.nameEn,
          ar: item.nameAr || item.nameEn,
          den: item.descriptionEn || '',
          dar: item.descriptionAr || '',
          price: Number(item.price),
          img: item.image?.thumbnailUrl || item.image?.url || '',
        })),
    }))
    .filter((category) => category.items.length);
};

// JSON inside <script>: escape "<" so a menu name can never close the tag.
const safeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

/** The page: server-rendered shell with the menu and the customer's current cart embedded as JSON. */
export const renderMenuPage = ({ categories, cart = [], lang = 'en', token, minimumOrder = 0, restaurantName = 'Mudawwarah' }) => {
  const ar = lang === 'ar';
  const data = {
    lang: ar ? 'ar' : 'en',
    token,
    minimum: Number(minimumOrder) || 0,
    menu: pageMenu(categories),
    cart: Object.fromEntries((cart || []).filter((l) => !(l.optionIds || []).length).map((l) => [l.menuItemId, l.quantity])),
  };
  return `<!doctype html>
<html lang="${data.lang}" dir="${ar ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${ar ? 'منيو مدورة' : `${restaurantName} menu`}</title>
<style>
  :root { --brand: #6d0f1f; --brand-soft: #f6e9eb; --text: #1d1d1f; --muted: #6b6b70; --line: #ececef; --bg: #faf8f7; --card: #fff; --ok: #1f7a4d; }
  @media (prefers-color-scheme: dark) {
    :root { --brand: #e0707f; --brand-soft: #3a1c21; --text: #f2f2f4; --muted: #a3a3aa; --line: #2c2c30; --bg: #151517; --card: #1e1e21; --ok: #4cc38a; }
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Arabic", Tahoma, sans-serif; }
  header { background: var(--brand); color: #fff; padding: 16px 16px 12px; }
  header h1 { margin: 0; font-size: 20px; }
  header p { margin: 2px 0 0; opacity: .85; font-size: 13px; }
  nav { position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--line); display: flex; gap: 8px; overflow-x: auto; padding: 10px 16px; scrollbar-width: none; }
  nav::-webkit-scrollbar { display: none; }
  nav a { flex: none; padding: 7px 14px; border-radius: 999px; background: var(--card); border: 1px solid var(--line); color: var(--text); text-decoration: none; font-size: 14px; white-space: nowrap; }
  nav a.active { background: var(--brand); border-color: var(--brand); color: #fff; }
  main { padding: 4px 16px 120px; max-width: 720px; margin: 0 auto; }
  h2 { font-size: 17px; margin: 18px 0 10px; scroll-margin-top: 64px; }
  .item { display: flex; gap: 12px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 10px; margin-bottom: 10px; }
  .item img, .item .ph { width: 88px; height: 88px; border-radius: 10px; object-fit: cover; flex: none; background: var(--brand-soft); }
  .info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .name { font-weight: 600; }
  .alt { color: var(--muted); font-size: 12px; }
  .desc { color: var(--muted); font-size: 13px; margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .row { display: flex; align-items: center; justify-content: space-between; margin-top: auto; padding-top: 6px; gap: 8px; }
  .price { font-weight: 600; color: var(--brand); }
  .add { border: 0; background: var(--brand); color: #fff; border-radius: 999px; padding: 7px 16px; font: inherit; font-weight: 600; }
  .qty { display: inline-flex; align-items: center; border: 1px solid var(--brand); border-radius: 999px; overflow: hidden; }
  .qty button { border: 0; background: transparent; color: var(--brand); width: 34px; height: 32px; font-size: 20px; line-height: 1; }
  .qty span { min-width: 26px; text-align: center; font-weight: 600; }
  .bar { position: fixed; inset-inline: 0; bottom: 0; padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); background: linear-gradient(to top, var(--bg) 70%, transparent); }
  .bar button { width: 100%; max-width: 688px; display: flex; margin: 0 auto; justify-content: space-between; align-items: center; border: 0; border-radius: 14px; padding: 14px 18px; background: var(--brand); color: #fff; font: inherit; font-weight: 600; font-size: 16px; }
  .bar button:disabled { opacity: .45; }
  .sheet { position: fixed; inset: 0; z-index: 10; display: none; background: rgba(0,0,0,.45); }
  .sheet.open { display: block; }
  .panel { position: absolute; inset-inline: 0; bottom: 0; max-height: 85vh; overflow-y: auto; background: var(--card); border-radius: 18px 18px 0 0; padding: 16px 16px calc(16px + env(safe-area-inset-bottom)); max-width: 720px; margin: 0 auto; }
  .panel h3 { margin: 0 0 12px; font-size: 18px; display: flex; justify-content: space-between; align-items: center; }
  .close { border: 0; background: transparent; color: var(--muted); font-size: 26px; line-height: 1; }
  .line { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); }
  .line .n { flex: 1; min-width: 0; }
  .line .t { font-weight: 600; min-width: 84px; text-align: end; }
  .total { display: flex; justify-content: space-between; font-weight: 700; font-size: 17px; margin: 14px 0 4px; }
  .note { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
  .send { width: 100%; border: 0; border-radius: 14px; padding: 15px; background: var(--brand); color: #fff; font: inherit; font-weight: 700; font-size: 16px; }
  .send:disabled { opacity: .5; }
  .done { text-align: center; padding: 48px 20px; }
  .done .tick { width: 64px; height: 64px; border-radius: 50%; background: var(--ok); color: #fff; font-size: 36px; line-height: 64px; margin: 0 auto 16px; }
  .done a { display: inline-block; margin-top: 18px; padding: 13px 22px; border-radius: 14px; background: var(--brand); color: #fff; text-decoration: none; font-weight: 700; }
  .error { color: #c62828; font-size: 14px; margin-top: 8px; text-align: center; }
</style>
</head>
<body>
<header><h1>${ar ? 'مدورة' : restaurantName}</h1><p id="sub"></p></header>
<nav id="tabs"></nav>
<main id="menu"></main>
<div class="bar"><button id="open" disabled><span id="count"></span><span id="sum"></span></button></div>
<div class="sheet" id="sheet"><div class="panel">
  <h3><span id="cartTitle"></span><button class="close" id="closeSheet" aria-label="close">×</button></h3>
  <div id="lines"></div>
  <div class="total"><span id="totalLabel"></span><span id="total"></span></div>
  <p class="note" id="note"></p>
  <button class="send" id="send"></button>
  <p class="error" id="error" hidden></p>
</div></div>
<script id="data" type="application/json">${safeJson(data)}</script>
<script>
(() => {
  const D = JSON.parse(document.getElementById('data').textContent);
  const ar = D.lang === 'ar';
  const T = ar
    ? { sub: 'اختر الأصناف والكمية، وبعدين أرسل الطلب', add: 'أضف', cart: 'السلة', items: (n) => n + (n === 1 ? ' صنف' : ' أصناف'), view: 'عرض السلة', total: 'المجموع', send: 'أرسل الطلب للواتساب', sending: 'جاري الإرسال…', empty: 'السلة فاضية', min: (m) => 'الحد الأدنى للطلب ' + m + ' — تقدر تكمل بالواتساب.', note: 'رسوم التوصيل (إن وجدت) تنضاف في الواتساب.', doneTitle: 'وصل طلبك للواتساب ✅', doneText: 'ارجع للمحادثة عشان نكمل: التوصيل أو الاستلام والدفع.', back: 'رجوع للواتساب', fail: 'ما قدرنا نرسل الطلب. تأكد من الإنترنت وجرّب مرة ثانية.', expired: 'انتهت صلاحية الرابط. اكتب "منيو" في الواتساب عشان يوصلك رابط جديد.' }
    : { sub: 'Pick your items and quantities, then send your order', add: 'Add', cart: 'Your cart', items: (n) => n + (n === 1 ? ' item' : ' items'), view: 'View cart', total: 'Total', send: 'Send order to WhatsApp', sending: 'Sending…', empty: 'Your cart is empty', min: (m) => 'Minimum order is ' + m + ' — you can still continue in WhatsApp.', note: 'Any delivery fee is added in WhatsApp.', doneTitle: 'Your order is in the chat ✅', doneText: 'Go back to WhatsApp to finish: delivery or pickup, and payment.', back: 'Back to WhatsApp', fail: 'We could not send your order. Check your connection and try again.', expired: 'This link has expired. Type "menu" in WhatsApp to get a new one.' };
  const money = (v) => v.toFixed(3) + ' KWD';
  const name = (o) => (ar ? o.ar : o.en);
  const alt = (o) => (ar ? o.en : o.ar !== o.en ? o.ar : '');
  const items = new Map(D.menu.flatMap((c) => c.items.map((i) => [i.id, i])));
  const cart = new Map(Object.entries(D.cart).filter(([id, q]) => items.has(id) && q > 0));
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  $('sub').textContent = T.sub;
  $('cartTitle').textContent = T.cart;
  $('totalLabel').textContent = T.total;
  $('send').textContent = T.send;

  const control = (id) => {
    const box = el('div');
    const q = cart.get(id) || 0;
    if (!q) {
      const b = el('button', 'add', T.add);
      b.onclick = () => set(id, 1);
      box.append(b);
    } else {
      const w = el('div', 'qty');
      const minus = el('button', '', '−');
      const plus = el('button', '', '+');
      minus.setAttribute('aria-label', '-');
      plus.setAttribute('aria-label', '+');
      minus.onclick = () => set(id, q - 1);
      plus.onclick = () => set(id, Math.min(20, q + 1));
      w.append(minus, el('span', '', String(q)), plus);
      box.append(w);
    }
    box.dataset.for = id;
    return box;
  };

  // Menu: tabs + sections, built once; only quantity controls re-render.
  D.menu.forEach((c, index) => {
    const a = el('a', index ? '' : 'active', name(c));
    a.href = '#c' + index;
    $('tabs').append(a);
    const h = el('h2', '', name(c));
    h.id = 'c' + index;
    $('menu').append(h);
    for (const i of c.items) {
      const card = el('div', 'item');
      if (i.img) { const img = el('img'); img.loading = 'lazy'; img.alt = ''; img.src = i.img; card.append(img); } else card.append(el('div', 'ph'));
      const info = el('div', 'info');
      info.append(el('div', 'name', name(i)));
      if (alt(i)) info.append(el('div', 'alt', alt(i)));
      const d = ar ? i.dar || i.den : i.den;
      if (d) info.append(el('div', 'desc', d));
      const row = el('div', 'row');
      row.append(el('span', 'price', money(i.price)), control(i.id));
      info.append(row);
      card.append(info);
      $('menu').append(card);
    }
  });

  // Highlight the tab of the section in view.
  const heads = [...document.querySelectorAll('main h2')];
  const tabs = [...document.querySelectorAll('nav a')];
  addEventListener('scroll', () => {
    let current = 0;
    heads.forEach((h, i) => { if (h.getBoundingClientRect().top < 90) current = i; });
    tabs.forEach((t, i) => t.classList.toggle('active', i === current));
  }, { passive: true });

  const totals = () => {
    let count = 0, sum = 0;
    for (const [id, q] of cart) { count += q; sum += items.get(id).price * q; }
    return { count, sum };
  };
  function set(id, q) {
    if (q > 0) cart.set(id, q); else cart.delete(id);
    document.querySelectorAll('[data-for="' + id + '"]').forEach((box) => box.replaceWith(control(id)));
    refresh();
  }
  function refresh() {
    const { count, sum } = totals();
    $('open').disabled = !count;
    $('count').textContent = count ? T.view + ' · ' + T.items(count) : T.empty;
    $('sum').textContent = count ? money(sum) : '';
    $('total').textContent = money(sum);
    $('note').textContent = (D.minimum && sum < D.minimum ? T.min(money(D.minimum)) + ' ' : '') + T.note;
    $('send').disabled = !count;
    const lines = $('lines');
    lines.replaceChildren();
    if (!count) lines.append(el('p', 'note', T.empty));
    for (const [id, q] of cart) {
      const i = items.get(id);
      const line = el('div', 'line');
      line.append(el('div', 'n', name(i)), control(id), el('div', 't', money(i.price * q)));
      lines.append(line);
    }
    if (!count) $('sheet').classList.remove('open');
  }
  $('open').onclick = () => $('sheet').classList.add('open');
  $('closeSheet').onclick = () => $('sheet').classList.remove('open');
  $('sheet').onclick = (e) => { if (e.target.id === 'sheet') $('sheet').classList.remove('open'); };

  $('send').onclick = async () => {
    const button = $('send');
    button.disabled = true;
    button.textContent = T.sending;
    $('error').hidden = true;
    try {
      const res = await fetch(location.pathname.replace(/\\/$/, '') + '/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [...cart].map(([id, qty]) => ({ id, qty })) }),
      });
      if (res.status === 403) throw new Error(T.expired);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(T.fail);
      const done = el('div', 'done');
      done.append(el('div', 'tick', '✓'), el('h2', '', T.doneTitle), el('p', '', T.doneText));
      if (body.whatsapp) { const a = el('a', '', T.back); a.href = body.whatsapp; done.append(a); }
      document.body.replaceChildren(done);
      scrollTo(0, 0);
      // Links open in the phone's browser, not inside WhatsApp: go straight back to the chat.
      if (body.whatsapp) setTimeout(() => { location.href = body.whatsapp; }, 1200);
    } catch (error) {
      $('error').textContent = error.message || T.fail;
      $('error').hidden = false;
      button.disabled = false;
      button.textContent = T.send;
    }
  };
  refresh();
})();
</script>
</body>
</html>`;
};
