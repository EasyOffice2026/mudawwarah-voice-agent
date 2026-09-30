/**
 * The sales agent: turns the live menu, the customer's cart and their latest
 * message into a strict JSON decision. The model only refers to menu items by
 * catalogue number and options by code, so it can never invent an item or a
 * price — everything it returns is validated against the catalogue here.
 */

export const money = (value) => `${Number(value).toFixed(3)} KWD`;
const round3 = (value) => Number(Number(value).toFixed(3));

export const ACTIONS = ['none', 'show_cart', 'place_order', 'clear_cart', 'order_status', 'human', 'show_menu', 'browse_menu', 'payment_link', 'complaint'];
export const ADDRESS_FIELDS = ['area', 'block', 'street', 'building'];

const nullableString = { type: ['string', 'null'] };

export const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lang', 'reply', 'add', 'remove', 'photos', 'customer', 'orderType', 'paymentMethod', 'action', 'complaint'],
  properties: {
    lang: { type: 'string', enum: ['en', 'ar'], description: 'Language the customer is using.' },
    reply: { type: 'string', description: 'What to say to the customer, in their language. Plain spoken text, 1-3 sentences.' },
    add: {
      type: 'array',
      description: 'Items to add to the cart now. Only when clearly requested and every REQUIRED option is known.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'quantity', 'options'],
        properties: {
          item: { type: 'integer', description: 'Catalogue number.' },
          quantity: { type: 'integer', description: 'TOTAL quantity wanted of this item with these options. Repeating an item already in the cart updates its quantity.' },
          options: { type: 'array', items: { type: 'string' }, description: 'Option codes like "3a".' },
        },
      },
    },
    remove: { type: 'array', items: { type: 'integer' }, description: 'Cart line numbers to remove.' },
    photos: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Catalogue numbers whose photo to send with this reply (at most 3). Empty unless the customer wants to see items.',
    },
    customer: {
      type: 'object',
      description: 'Newly learned details only; null for anything not mentioned in this message.',
      additionalProperties: false,
      required: ['name', 'area', 'block', 'street', 'building', 'notes'],
      properties: {
        name: nullableString,
        area: nullableString,
        block: nullableString,
        street: nullableString,
        building: nullableString,
        notes: { ...nullableString, description: 'Directions for the driver or special requests.' },
      },
    },
    orderType: { type: ['string', 'null'], enum: ['DELIVERY', 'PICKUP', null] },
    paymentMethod: {
      type: ['string', 'null'],
      enum: ['CASH', 'CARD', 'ONLINE', null],
      description: 'CASH = cash on delivery, CARD = card machine on delivery, ONLINE = pay now by KNET/card through a link.',
    },
    action: { type: 'string', enum: ACTIONS },
    complaint: {
      type: ['string', 'null'],
      description: 'With action "complaint": the problem as the customer described it, in their words; null if they have not described it yet.',
    },
  },
};

const optionCode = (itemNo, index) => `${itemNo}${String.fromCharCode(97 + index)}`;

/** Numbered catalogue built from the Mdawra `/categories` response. */
export const buildCatalogue = (categories) => {
  const items = [];
  const lines = [];
  let no = 0;
  for (const category of categories || []) {
    const available = (category.items || []).filter((item) => item.isAvailable !== false && !item.isOutOfStock);
    if (!available.length) continue;
    lines.push(`## ${category.nameEn}${category.nameAr ? ` / ${category.nameAr}` : ''}`);
    for (const item of available) {
      no += 1;
      const options = (item.options || []).map((option, index) => ({ ...option, code: optionCode(no, index) }));
      items.push({ no, item, options });
      const flags = [item.isFeatured && 'popular', item.isTopRated && 'top rated'].filter(Boolean).join(', ');
      let line = `[${no}] ${item.nameEn}${item.nameAr ? ` / ${item.nameAr}` : ''} — ${money(item.price)}${flags ? ` (${flags})` : ''}`;
      if (item.descriptionEn) line += `\n    ${item.descriptionEn}`;
      const groups = new Map();
      for (const option of options) {
        if (!groups.has(option.groupEn)) groups.set(option.groupEn, { required: Boolean(option.isRequired), ar: option.groupAr, options: [] });
        groups.get(option.groupEn).options.push(option);
      }
      for (const [group, meta] of groups) {
        const choices = meta.options
          .map((o) => `${o.code}=${o.nameEn}${o.nameAr ? `/${o.nameAr}` : ''}${Number(o.extraPrice) > 0 ? ` +${money(o.extraPrice)}` : ''}`)
          .join(', ');
        line += `\n    ${meta.required ? 'REQUIRED' : 'optional'} ${group}${meta.ar ? ` / ${meta.ar}` : ''}: ${choices}`;
      }
      lines.push(line);
    }
  }
  return { items, text: lines.join('\n') };
};

export const priceCart = (cart, catalogue) => {
  const lines = [];
  for (const line of cart || []) {
    const entry = catalogue.items.find((c) => c.item.id === line.menuItemId);
    if (!entry) continue;
    const options = (line.optionIds || []).map((id) => entry.options.find((o) => o.id === id)).filter(Boolean);
    const unit = round3(Number(entry.item.price) + options.reduce((sum, o) => sum + Number(o.extraPrice || 0), 0));
    lines.push({ line, entry, options, unit, total: round3(unit * line.quantity) });
  }
  return { lines, subtotal: round3(lines.reduce((sum, l) => sum + l.total, 0)) };
};

export const describeCart = (cart, catalogue, lang = 'en') => {
  const { lines, subtotal } = priceCart(cart, catalogue);
  if (!lines.length) return lang === 'ar' ? 'السلة فارغة' : '(empty)';
  const name = (o) => (lang === 'ar' && o.nameAr ? o.nameAr : o.nameEn);
  return `${lines
    .map((l, index) => `${index + 1}. ${l.line.quantity} × ${name(l.entry.item)}${l.options.length ? ` (${l.options.map(name).join(', ')})` : ''} — ${money(l.total)}`)
    .join('\n')}\n${lang === 'ar' ? 'المجموع' : 'Subtotal'}: ${money(subtotal)}`;
};

export const allowedPaymentMethods = (settings, onlinePayment = false) => {
  const configured = String(settings.paymentMethods || '').split(',').map((m) => m.trim().toUpperCase());
  const methods = ['CASH', 'CARD'].filter((m) => m === 'CASH' || configured.includes(m));
  if (onlinePayment) methods.unshift('ONLINE');
  return methods;
};

const PAYMENT_LABELS = {
  ONLINE: 'pay now by KNET or card through a secure link',
  CASH: 'cash on delivery',
  CARD: 'card machine on delivery',
};

/** What still has to be collected before the order can be placed. */
export const missingForOrder = (session, settings) => {
  const missing = [];
  if (!session.cart?.length) missing.push('items');
  if (!session.customer?.name) missing.push('name');
  const pickupAllowed = settings.pickupEnabled === 'true';
  const deliveryAllowed = settings.deliveryEnabled !== 'false';
  const orderType = session.orderType || (deliveryAllowed ? 'DELIVERY' : pickupAllowed ? 'PICKUP' : 'DELIVERY');
  if (orderType === 'DELIVERY') {
    for (const field of ADDRESS_FIELDS) if (!session.customer?.[field]) missing.push(field);
  }
  if (!session.paymentMethod) missing.push('paymentMethod');
  return { missing, orderType };
};

export const systemPrompt = ({ settings, catalogue, session, restaurantName, onlinePayment = false }) => {
  const isOpen = settings.isOpen !== 'false';
  const { missing, orderType } = missingForOrder(session, settings);
  const payments = allowedPaymentMethods(settings, onlinePayment);
  const c = session.customer || {};
  const known = [
    c.name && `name: ${c.name}`,
    c.area && `area: ${c.area}`,
    c.block && `block: ${c.block}`,
    c.street && `street: ${c.street}`,
    c.building && `building: ${c.building}`,
    c.notes && `notes: ${c.notes}`,
    session.orderType && `order type: ${session.orderType}`,
    session.paymentMethod && `payment: ${session.paymentMethod}`,
    session.location && 'map pin: shared',
  ].filter(Boolean);
  const pickup = settings.pickupEnabled === 'true';

  return `You are the voice sales agent of ${restaurantName}, a restaurant in Kuwait, talking to a customer over WhatsApp (voice notes and chat).

PERSONALITY
- Warm, quick, and genuinely helpful, like the best host in the restaurant. Never robotic.
- Understand Kuwaiti/Gulf Arabic, Modern Standard Arabic and English, including mixed speech and spoken numbers ("two", "اثنين", "ثنتين", "ثلاث"). Reply in the customer's language${session.lang ? ` (so far: ${session.lang === 'ar' ? 'Arabic' : 'English'})` : ''}.
- In Arabic, ALWAYS speak authentic Kuwaiti dialect, never Modern Standard Arabic or Egyptian/Levantine. Use Kuwaiti words and phrases naturally: هلا والله، حياك الله، شخبارك، خوش، وايد، شوي، يبيلك، تبي / تبين، شتبي، إي، لا، أكيد، ماكو مشكلة، على راسي، تم، الحين، عيل، صح، بس، يالله، مشكور، عساك على القوة، من عيوني، دقايق، وصل، بيت / شقة، ديرة. Address men with "تبي" and women with "تبين" when known. Say prices Kuwaiti-style: "دينار ونص"، "ثلاث دنانير وربع"، "خمسمية فلس"، "دينار وسبعمية وخمسين".
- Replies will be read aloud: 1-3 short sentences, plain text, no lists, no markdown, no emojis. In English say prices like "1.500 dinars".

SELLING
- Sell only from the CATALOGUE below. If something is not on it, say so and offer the closest item.
- Suggest at most one relevant extra per turn (a popular item, a drink or a side) when it fits naturally; never pushy, never repeat a declined suggestion.
- Add items with "add" only when the customer clearly asked for them. If an item has a REQUIRED option group the customer did not specify, do NOT add it — ask which option they want and list the choices briefly. Quantities 1-20.
- Use catalogue numbers and option codes; never state a price that is not in the catalogue. After adding, confirm what was added and the cart subtotal, then ask if they want anything else or to complete the order.
- "remove" takes cart line numbers from CURRENT CART.
- You CAN show photos: put up to 3 catalogue numbers in "photos" when the customer asks to see items, asks for pictures, or asks what something looks like. The photos arrive with the item name and price, so keep your reply short. Never say you cannot show pictures.
- Items in CURRENT CART are already added. Never put them in "add" again just to confirm them. Only when the customer changes how many they want, send the item with the new TOTAL quantity.

COMPLETING THE ORDER
- When the customer is done, collect whatever is still missing, one or two questions at a time, and record it in "customer", "orderType" and "paymentMethod" (only what was said in this message; null otherwise).
- ${pickup ? 'Delivery and pickup are both offered; ask which they prefer if unknown.' : 'Delivery only.'} Delivery needs area, block, street and building.
- Customers may share a WhatsApp location pin (it appears as "[Shared a map location …]"). Thank them; the pin goes to the driver. Take area/block/street/building from the pin's address text when it contains them, and still ask for anything missing. Payment options: ${payments.map((m) => `${m} (${PAYMENT_LABELS[m]})`).join(', ')}${onlinePayment ? ' — recommend ONLINE first; the system sends the payment link after the order is placed.' : '.'}
- When everything is known and the customer wants to finish, set action "place_order". The system then shows the customer the exact order from CURRENT CART with the total and asks them to confirm, so do not list the items or prices yourself in that reply. When the customer confirms (yes, إي، تمام، أكد), set "place_order" again and the order is placed. Never claim an order is placed or paid yourself — the system confirms it with an order number and sends the payment link.
- Once an order is placed the kitchen is notified automatically and the customer receives updates here when it is being prepared, ready, out for delivery and delivered; if asked, say so.
- Actions: "show_cart" when they ask what is in the cart; "clear_cart" only when clearly asked; "order_status" when they ask where their order is or want to track it; "human" when they want to talk to a person or a staff member.
- "show_menu" when they ask for the main menu, the options or what you can do; "browse_menu" when they want to browse the catalogue or see the categories/items list. The system sends a tappable list, so keep your reply to one short sentence.
- "payment_link" when they ask for the payment link, to pay online or by KNET/card, or just say "link"/"رابط". The system sends a link for the exact order amount; never write a link or an amount yourself.
- "complaint" when they complain or report a problem (late, wrong or missing item, cold food, rude driver…). Put their description in "complaint"; if they have not said what went wrong yet, leave it null and the system asks. Be apologetic and brief; the system gives them a reference number.
- With any of these actions (show_menu, browse_menu, payment_link, complaint, order_status, human) the system adds its own message right after your reply. So your reply is ONE short lead-in that fits it, e.g. "حاضر، تفضل" / "Sure, here you go" or a one-line apology. Never ask for an order number (the system finds their latest order), never ask them to describe a complaint they already described, and never say you will handle something yourself that the system passes to the team.
- "[Sent a cart from the WhatsApp catalogue: …]" means the customer picked items in WhatsApp's own cart and pressed Place order. Those items are ALREADY in CURRENT CART: never put them in "add". Thank them in one short sentence, then ask for what is still missing; if nothing is missing, set "place_order".
- Always use "payment_link" when they ask for the link, even if no order is placed yet; the system knows what to do.
${isOpen ? '' : `- The restaurant is CLOSED now (hours: ${settings.workingHours}). Take items into the cart if they like, but explain the order can only be placed during working hours.\n`}
RESTAURANT
- Working hours: ${settings.workingHours}. Delivery fee: ${money(settings.deliveryFee || 0)}. Minimum order: ${money(settings.minimumOrder || 0)}.${Number(settings.serviceChargePercent) > 0 ? ` Service charge: ${settings.serviceChargePercent}%.` : ''}

CURRENT CART
${describeCart(session.cart, catalogue)}

ORDER DRAFT (${orderType}${pickup ? '' : ', delivery only'})
${known.length ? known.join('\n') : '(nothing collected yet)'}
Still missing: ${missing.length ? missing.join(', ') : 'nothing — ready to place'}

CATALOGUE (prices in KWD)
${catalogue.text}`;
};

/** Validates and applies the model's cart edits. */
export const applyCartChanges = (cart, result, catalogue) => {
  const next = [...(cart || [])];
  for (const lineNo of [...new Set(result.remove || [])].sort((a, b) => b - a)) {
    if (lineNo >= 1 && lineNo <= next.length) next.splice(lineNo - 1, 1);
  }
  const added = [];
  const missingOptions = [];
  for (const add of result.add || []) {
    const entry = catalogue.items.find((c) => c.no === add.item);
    if (!entry) continue;
    const quantity = Math.min(20, Math.max(1, Math.round(Number(add.quantity) || 1)));
    const chosen = (add.options || []).map((code) => entry.options.find((o) => o.code === code)).filter(Boolean);
    const requiredGroups = [...new Set(entry.options.filter((o) => o.isRequired).map((o) => o.groupEn))];
    const unmet = requiredGroups.filter((group) => !chosen.some((o) => o.groupEn === group));
    if (unmet.length) {
      missingOptions.push({ entry, groups: unmet });
      continue;
    }
    const optionIds = [];
    const seen = new Set();
    for (const option of chosen) {
      if (seen.has(option.groupEn)) continue;
      seen.add(option.groupEn);
      optionIds.push(option.id);
    }
    // The model tends to repeat an item on later turns; the same item with the same options sets the line's
    // quantity instead of stacking a duplicate (one Dinner Box was once ordered as four this way).
    const sameKey = [...optionIds].sort().join(',');
    const existing = next.find((l) => l.menuItemId === entry.item.id && [...(l.optionIds || [])].sort().join(',') === sameKey);
    if (existing) {
      if (existing.quantity !== quantity) added.push({ entry, quantity });
      existing.quantity = quantity;
      continue;
    }
    next.push({ menuItemId: entry.item.id, quantity, optionIds });
    added.push({ entry, quantity });
  }
  return { cart: next, added, missingOptions };
};

/** Merges only the newly learned customer details into the session. */
export const applyCustomerDetails = (session, result, options = {}) => {
  const customer = { ...session.customer };
  for (const [key, value] of Object.entries(result.customer || {})) {
    if (typeof value === 'string' && value.trim()) customer[key] = value.trim();
  }
  session.customer = customer;
  if (result.orderType) session.orderType = result.orderType;
  if (result.paymentMethod && (result.paymentMethod !== 'ONLINE' || options.onlinePayment)) session.paymentMethod = result.paymentMethod;
  return session;
};

export const missingOptionsNote = (lang, missingOptions) =>
  missingOptions
    .map(({ entry, groups }) => {
      const itemLabel = lang === 'ar' && entry.item.nameAr ? entry.item.nameAr : entry.item.nameEn;
      const choices = groups
        .map((group) => {
          const options = entry.options.filter((o) => o.groupEn === group);
          const label = lang === 'ar' ? options[0]?.groupAr || group : group;
          return `${label}: ${options.map((o) => (lang === 'ar' && o.nameAr ? o.nameAr : o.nameEn)).join(' / ')}`;
        })
        .join('\n');
      return lang === 'ar' ? `قبل إضافة ${itemLabel}، اختر:\n${choices}` : `Before I add ${itemLabel}, please choose:\n${choices}`;
    })
    .join('\n\n');

const FIELD_LABELS = {
  en: { items: 'something to order', name: 'your name', area: 'your area', block: 'block', street: 'street', building: 'building/house number', paymentMethod: 'how you want to pay' },
  ar: { items: 'طلبك', name: 'اسمك', area: 'المنطقة', block: 'القطعة', street: 'الشارع', building: 'رقم المنزل/البناية', paymentMethod: 'طريقة الدفع' },
};

export const missingFieldsNote = (lang, missing) => {
  const labels = FIELD_LABELS[lang === 'ar' ? 'ar' : 'en'];
  const list = missing.map((m) => labels[m] || m).join(lang === 'ar' ? '، ' : ', ');
  return lang === 'ar' ? `قبل تأكيد الطلب أحتاج: ${list}.` : `Before I place the order I still need: ${list}.`;
};
