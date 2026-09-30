import { config, isOpenAiConfigured } from './config.js';
import * as sessions from './sessions.js';
import * as mdawra from './mdawra.js';
import * as openai from './openai.js';
import * as wa from './whatsapp.js';
import * as orders from './orders.js';
import * as payment from './payment.js';
import { t } from './copy.js';
import { isCatalogEnabled, productListGroups, cartFromOrder } from './catalog.js';
import { getBranches, isBranchOpen, todaysHours, nextOpening, branchName } from './branches.js';
import {
  RESPONSE_SCHEMA,
  money,
  buildCatalogue,
  priceCart,
  describeCart,
  missingForOrder,
  systemPrompt,
  applyCartChanges,
  applyCustomerDetails,
  missingOptionsNote,
  missingFieldsNote,
} from './agent.js';

const RESTAURANT_NAME = 'Mudawwarah';

const detectLang = (text, fallback) => (/[\u0600-\u06FF]/.test(text || '') ? 'ar' : /[a-z]/i.test(text || '') ? 'en' : fallback || 'en');

const composeAddress = (c) => [c.area && `Area ${c.area}`, c.block && `Block ${c.block}`, c.street && `Street ${c.street}`, c.building && `Building ${c.building}`].filter(Boolean).join(', ');

/** Mdawra's payment enum has no ONLINE value; a payment link in Kuwait is KNET. */
const mdawraPaymentMethod = (method) => (method === 'ONLINE' ? 'KNET' : method || 'CASH');

/** The pickup branch the customer chose, when the order is for pickup. */
const chosenBranch = (session, branches) => (session.orderType === 'PICKUP' ? branches.find((b) => b.id === session.pickupLocationId) || null : null);

/** Why the order cannot be placed yet, as a message for the customer, or null when it can. */
const orderBlocker = (session, settings, catalogue, branches = []) => {
  const copy = t(session.lang);
  if (settings.isOpen === 'false') return copy.closed(settings.workingHours);
  const { missing } = missingForOrder(session, settings, branches);
  if (missing.length) return missingFieldsNote(session.lang, missing);
  const branch = chosenBranch(session, branches);
  if (branch && !isBranchOpen(branch)) return copy.branchClosed(branchName(branch, session.lang), nextOpening(branch));
  const { subtotal } = priceCart(session.cart, catalogue);
  if (subtotal < Number(settings.minimumOrder || 0)) return copy.minimumOrder(settings.minimumOrder);
  return null;
};

/**
 * Shows the customer exactly what will reach the kitchen — built from the real
 * cart, not the model's memory — and waits for them to confirm it.
 */
export const reviewOrder = (session, settings, catalogue, branches = []) => {
  const blocker = orderBlocker(session, settings, catalogue, branches);
  if (blocker) return blocker;
  const { orderType } = missingForOrder(session, settings, branches);
  const branch = chosenBranch(session, branches);
  session.awaitingConfirmation = true;
  return t(session.lang).reviewOrder({
    cart: describeCart(session.cart, catalogue, session.lang),
    customer: session.customer,
    orderType,
    deliveryFee: Number(settings.deliveryFee || 0),
    paymentMethod: session.paymentMethod,
    hasPin: Boolean(session.location),
    branch: branch ? { name: branchName(branch, session.lang), prep: branch.prepMinutes || 15 } : null,
  });
};

const confirmButtons = (lang) => [
  { id: 'order:confirm', title: t(lang).confirmButton },
  { id: 'order:change', title: t(lang).changeButton },
];

/** Everything the customer confirmed; any change after the review needs a new review. */
const orderSnapshot = (session) =>
  JSON.stringify([session.cart, session.customer, session.orderType, session.paymentMethod, session.location, session.pickupLocationId]);

/** Photo messages for the catalogue numbers the agent picked (max 3), captioned with name and price. */
const photosFor = (numbers, catalogue, lang) =>
  [...new Set(numbers || [])]
    .map((no) => catalogue.items.find((c) => c.no === no))
    .filter((entry) => entry?.item.image?.url)
    .slice(0, 3)
    .map(({ item }) => ({ url: item.image.url, caption: `${lang === 'ar' && item.nameAr ? item.nameAr : item.nameEn} — ${money(item.price)}` }));

/**
 * Places the order through the Mdawra API and, for online payment, sends the
 * link. Returns the text to show the customer.
 */
export const placeOrder = async (session, settings, catalogue, branches = []) => {
  const copy = t(session.lang);
  const blocker = orderBlocker(session, settings, catalogue, branches);
  if (blocker) return blocker;
  const { orderType } = missingForOrder(session, settings, branches);
  const branch = chosenBranch(session, branches);

  const c = session.customer;
  let order;
  try {
    order = await mdawra.createOrder({
      customerName: c.name,
      customerPhone: session.phone,
      orderType,
      address: orderType === 'DELIVERY' ? composeAddress(c) : undefined,
      area: c.area,
      block: c.block,
      street: c.street,
      building: c.building,
      notes: c.notes || undefined,
      deliveryLat: orderType === 'DELIVERY' && session.location ? session.location.lat : undefined,
      deliveryLng: orderType === 'DELIVERY' && session.location ? session.location.lng : undefined,
      pickupLocationId: branch ? branch.id : undefined,
      paymentMethod: mdawraPaymentMethod(session.paymentMethod),
      channel: 'WHATSAPP',
      items: session.cart.map((line) => ({ menuItemId: line.menuItemId, quantity: line.quantity, optionIds: line.optionIds })),
    });
  } catch (error) {
    console.error('[flow] order creation failed', error.message);
    return error.status === 409 || error.status === 422 ? error.message : copy.orderFailed;
  }

  session.lastOrderId = order.id;
  session.lastOrderNumber = order.orderNumber;
  const items = orderItemsText(order, session.lang);
  let paymentMethod = session.paymentMethod;
  let paymentReference = null;
  let paymentUrl = null;
  let reply;
  if (paymentMethod === 'ONLINE' && payment.isOnlinePaymentEnabled()) {
    try {
      const link = await payment.createPaymentLink({ order, phone: session.phone, lang: session.lang });
      paymentReference = link.reference;
      paymentUrl = link.url;
      reply = copy.payNow(order.orderNumber, order.total, link.url, items);
    } catch (error) {
      console.error('[flow] payment link failed', error.message);
      paymentMethod = 'CASH';
      reply = `${copy.orderPlaced(order.orderNumber, order.total, items)}\n${copy.paymentLinkUnavailable}`;
    }
  } else {
    paymentMethod = paymentMethod === 'ONLINE' ? 'CASH' : paymentMethod;
    reply = copy.orderPlaced(order.orderNumber, order.total, items);
  }
  orders.track({ order, phone: session.phone, lang: session.lang, paymentMethod, paymentReference, paymentUrl, pickupBranch: branch ? branchName(branch, session.lang) : null });
  await orders.notifyKitchen(orders.orderSummaryForKitchen(order, c, session.location) + (paymentMethod === 'ONLINE' ? '\n(awaiting online payment)' : ''));
  sessions.resetOrder(session);
  return reply;
};

/** The order's lines as the kitchen recorded them, so the customer sees exactly what was ordered. */
const orderItemsText = (order, lang) =>
  (order.items || [])
    .map((i) => {
      const name = (o) => (lang === 'ar' && o.nameAr ? o.nameAr : o.nameEn);
      const extras = (i.customizations || []).map(name).filter(Boolean);
      return `${i.quantity} × ${name(i)}${extras.length ? ` (${extras.join(', ')})` : ''}`;
    })
    .join('\n');

const orderStatus = async (session) => {
  const copy = t(session.lang);
  if (!session.lastOrderId) return copy.noOrders;
  try {
    const order = await mdawra.trackOrder(session.lastOrderId);
    return copy.lastOrderStatus(order.orderNumber, order.status);
  } catch {
    return copy.noOrders;
  }
};

/** Categories and items a customer can order right now, in menu order. */
const orderableCategories = (categories) =>
  (categories || [])
    .map((category) => ({ ...category, items: (category.items || []).filter((item) => item.isAvailable !== false && !item.isOutOfStock) }))
    .filter((category) => category.items.length);

const localName = (o, lang) => (lang === 'ar' && o.nameAr ? o.nameAr : o.nameEn);

/** The main menu: greeting or prompt plus a tappable list of what the bot can do. */
const mainMenu = (lang, intro) => {
  const copy = t(lang);
  return { text: intro || copy.menuPrompt, list: { button: copy.menuButton, sections: [{ title: copy.menuTitle, rows: copy.menuRows }] } };
};

/** The catalogue's first level: one row per category (WhatsApp shows at most 10 rows). */
const categoriesMenu = async (lang) => {
  const copy = t(lang);
  const categories = orderableCategories(await mdawra.getMenu()).slice(0, 10);
  const rows = categories.map((c) => ({ id: `cat:${c.id}:0`, title: localName(c, lang), description: `${c.items.length} ${lang === 'ar' ? 'صنف' : 'items'}` }));
  return { text: copy.browseIntro, list: { button: copy.categoriesButton, sections: [{ title: copy.menuTitle, rows }] } };
};

/**
 * "Menu": with a WhatsApp catalogue, product messages with photos and a cart
 * (split by category when there are more than 30 items); without one, the
 * category list.
 */
const catalogueMenu = async (lang) => {
  if (!isCatalogEnabled()) return categoriesMenu(lang);
  const copy = t(lang);
  const groups = productListGroups(await mdawra.getMenu(), lang);
  if (!groups.length) return categoriesMenu(lang);
  return {
    productLists: groups.map((sections, index) => ({
      catalogId: config.whatsapp.catalogId,
      header: groups.length > 1 ? `${copy.catalogHeader} (${index + 1}/${groups.length})` : copy.catalogHeader,
      body: copy.catalogBody,
      sections,
    })),
  };
};

/** Open now, today's hours and next opening, as the prompt and the branch list show them. */
const branchStatus = (branch) => ({ open: isBranchOpen(branch), hours: todaysHours(branch), opens: nextOpening(branch) });

/** The agent picked a branch by its number in PICKUP BRANCHES: the order becomes pickup from there. */
const applyBranchChoice = (session, result, branches) => {
  const branch = Number.isInteger(result.pickupBranch) ? branches[result.pickupBranch - 1] : null;
  if (branch) {
    session.pickupLocationId = branch.id;
    session.orderType = 'PICKUP';
  }
  if (session.orderType === 'DELIVERY') session.pickupLocationId = null;
};

/** "Pickup branches": every active branch with open/closed, today's hours and prep time, like the website. */
const branchesMenu = async (lang) => {
  const copy = t(lang);
  const [settings, branches] = await Promise.all([mdawra.getSettings(), getBranches()]);
  if (settings.pickupEnabled !== 'true' || !branches.length) return copy.pickupUnavailable;
  const rows = branches.slice(0, 10).map((b) => {
    const { open, hours } = branchStatus(b);
    return { id: `branch:${b.id}`, title: branchName(b, lang), description: copy.branchRow(open, hours, b.prepMinutes || 15) };
  });
  return { text: copy.pickupIntro, list: { button: copy.branchesButton, sections: [{ title: copy.branchesButton, rows }] } };
};

/** Tapping a branch: the order becomes pickup from it; the reply shows its hours and where to go next. */
const chooseBranch = async (session, branchId) => {
  const copy = t(session.lang);
  const branch = (await getBranches()).find((b) => b.id === branchId);
  if (!branch) return branchesMenu(session.lang);
  session.orderType = 'PICKUP';
  session.pickupLocationId = branch.id;
  session.awaitingConfirmation = false;
  const { open, hours, opens } = branchStatus(branch);
  const ar = session.lang === 'ar';
  const details = [ar ? branch.addressAr || branch.addressEn : branch.addressEn, ar ? branch.directionsAr || branch.directionsEn : branch.directionsEn, branch.phone && `☎️ ${branch.phone}`]
    .filter(Boolean)
    .join('\n');
  const name = branchName(branch, session.lang);
  sessions.remember(session, 'assistant', `Pickup from the ${branch.nameEn} branch is set.`);
  const buttons = [
    { id: 'menu:browse', title: copy.browseButton },
    { id: 'menu:pickup', title: copy.changeBranchButton },
    ...(session.cart?.length ? [{ id: 'order:review', title: copy.reviewButton }] : []),
  ];
  return { text: copy.branchChosen({ name, open, hours, opens, prep: branch.prepMinutes || 15, details }), buttons };
};

const ITEMS_PER_PAGE = 9;

/** One category's items with name and price; a "More items…" row pages through long categories. */
const itemsMenu = async (lang, categoryId, page) => {
  const copy = t(lang);
  const category = orderableCategories(await mdawra.getMenu()).find((c) => c.id === categoryId);
  if (!category) return categoriesMenu(lang);
  const start = page * ITEMS_PER_PAGE;
  const rows = category.items.slice(start, start + ITEMS_PER_PAGE).map((item) => ({
    id: `item:${item.id}`,
    title: localName(item, lang),
    description: `${money(item.price)}${localName(item, lang).length > 24 ? ` · ${localName(item, lang)}` : ''}`,
  }));
  if (category.items.length > start + ITEMS_PER_PAGE) rows.push({ id: `cat:${category.id}:${page + 1}`, title: copy.moreItems });
  return { text: copy.itemsIntro(localName(category, lang)), list: { button: copy.itemsButton, sections: [{ title: localName(category, lang), rows }] } };
};

/**
 * "link": a payment link for the exact amount of the customer's latest open
 * order. A cash order is switched to online payment; an order still being put
 * together is reviewed again with online payment so the link follows the yes.
 */
const paymentLinkReply = async (session) => {
  const copy = t(session.lang);
  if (!payment.isOnlinePaymentEnabled()) return copy.onlinePaymentOff;
  const entry = orders
    .forPhone(session.phone)
    .find((o) => !['DELIVERED', 'CANCELLED'].includes(o.status) && (o.paymentMethod !== 'ONLINE' || !o.paid));
  if (entry) {
    if (!entry.paymentUrl || entry.paymentMethod !== 'ONLINE') {
      const link = await payment.createPaymentLink({
        order: { id: entry.id, orderNumber: entry.orderNumber, total: entry.total, customerName: session.customer?.name || session.waName || 'Customer' },
        phone: session.phone,
        lang: session.lang,
      });
      const switched = entry.paymentMethod !== 'ONLINE';
      Object.assign(entry, { paymentMethod: 'ONLINE', paid: false, paymentUrl: link.url, paymentReference: link.reference, paymentRequestedAt: Date.now() });
      orders.update(entry);
      if (switched) await orders.notifyKitchen(t('en').kitchenPayOnline(entry.orderNumber));
    }
    return copy.payNow(entry.orderNumber, entry.total, entry.paymentUrl);
  }
  if (session.cart?.length) {
    const [categories, settings, branches] = await Promise.all([mdawra.getMenu(), mdawra.getSettings(), getBranches()]);
    session.paymentMethod = 'ONLINE';
    session.awaitingConfirmation = false;
    const text = reviewOrder(session, settings, buildCatalogue(categories), branches);
    return { text, buttons: session.awaitingConfirmation ? confirmButtons(session.lang) : null };
  }
  return copy.noOrderToPay;
};

/** Logs the complaint, alerts the team and gives the customer a reference. */
const logComplaint = async (session, text) => {
  const record = orders.recordComplaint({ phone: session.phone, name: session.customer?.name || session.waName, orderNumber: session.lastOrderNumber, text });
  await orders.notifyKitchen(t('en').kitchenComplaint(record.ref, session.phone, record.orderNumber, text));
  return t(session.lang).complaintLogged(record.ref);
};

const MENU_WORDS = /^(main menu|options|help|القائمة|قائمة|القائمة الرئيسية|مساعدة)[\s!.؟?]*$/i;
const CATALOGUE_WORDS = /^(menu|the menu|catalog(ue)?|المنيو|منيو)[\s!.؟?]*$/i;
// A short message that mentions the link ("link", "send link", "أبي الرابط", "ابي رابط الدفع لو سمحت").
const asksForLink = (typed) => typed.split(/\s+/).length <= 6 && /(\blink\b|رابط|لينك|الرابط)/i.test(typed);
const GREETING = /^(hi+|hello+|hey+|hala|salam|good (morning|evening)|السلام عليكم|سلام|هلا|هلا والله|هلا وغلا|مرحبا|مرحبًا|أهلا|اهلا|مساء الخير|صباح الخير)[\s!.,،؟?]*$/i;

/** Taps on the main menu and the catalogue lists, plus the "menu" and "link" keywords. */
const handleMenu = async (session, { replyId, text }) => {
  const copy = t(session.lang);
  const typed = (text || '').trim();
  if (replyId === 'menu:browse') return catalogueMenu(session.lang);
  if (replyId === 'menu:pickup') return branchesMenu(session.lang);
  const branchTap = /^branch:(.+)$/.exec(replyId || '');
  if (branchTap) return chooseBranch(session, branchTap[1]);
  if (replyId === 'menu:track') return orderStatus(session);
  if (replyId === 'menu:pay' || (!replyId && asksForLink(typed))) return paymentLinkReply(session);
  if (replyId === 'menu:complaint') {
    session.complaint = { stage: 'DESCRIBE' };
    return copy.complaintAsk;
  }
  if (replyId === 'menu:team') {
    await orders.notifyKitchen(t('en').kitchenHuman(session.phone, 'Tapped "Talk to our team"'));
    return copy.humanHandoff;
  }
  const category = /^cat:(.+):(\d+)$/.exec(replyId || '');
  if (category) return itemsMenu(session.lang, category[1], Number(category[2]));
  if (!replyId && MENU_WORDS.test(typed)) return mainMenu(session.lang);
  if (!replyId && CATALOGUE_WORDS.test(typed)) return catalogueMenu(session.lang);
  return null;
};

/** Runs the AI sales agent for one customer utterance and applies its decisions. */
export const runAgent = async (session, text) => {
  const copy = t(session.lang);
  if (!isOpenAiConfigured()) return copy.aiUnavailable;
  const [categories, settings, branches] = await Promise.all([mdawra.getMenu(), mdawra.getSettings(), getBranches()]);
  const catalogue = buildCatalogue(categories);
  const onlinePayment = payment.isOnlinePaymentEnabled();

  sessions.remember(session, 'user', text);
  let result;
  try {
    result = await openai.completeJson({
      system: systemPrompt({ settings, catalogue, session, restaurantName: settings.restaurantName || RESTAURANT_NAME, onlinePayment, branches, branchStatus }),
      messages: session.history.map((h) => ({ role: h.role, content: h.content })),
      schema: RESPONSE_SCHEMA,
      schemaName: 'sales_turn',
    });
  } catch (error) {
    console.error('[flow] completion failed', error.message);
    return copy.aiUnavailable;
  }

  if (result.lang === 'ar' || result.lang === 'en') session.lang = result.lang;
  const before = orderSnapshot(session);
  const { cart, missingOptions } = applyCartChanges(session.cart, result, catalogue);
  session.cart = cart;
  applyCustomerDetails(session, result, { onlinePayment });
  applyBranchChoice(session, result, branches);
  if (orderSnapshot(session) !== before) session.awaitingConfirmation = false;

  const parts = [result.reply];
  let buttons = null;
  let list = null;
  let productLists = null;
  /** Adds a reply that may carry buttons, a list or catalogue messages alongside its text. */
  const attach = (extra) => {
    if (!extra) return;
    if (typeof extra === 'string') return parts.push(extra);
    parts.push(extra.text);
    buttons = extra.buttons || buttons;
    list = extra.list || list;
    productLists = extra.productLists || productLists;
  };
  if (missingOptions.length) parts.push(missingOptionsNote(session.lang, missingOptions));
  switch (result.action) {
    case 'show_menu':
      list = mainMenu(session.lang).list;
      break;
    case 'browse_menu':
      attach({ ...(await catalogueMenu(session.lang)), text: '' });
      break;
    case 'payment_link':
      attach(await paymentLinkReply(session));
      break;
    case 'complaint':
      if (result.complaint?.trim()) {
        parts.push(await logComplaint(session, result.complaint.trim()));
      } else {
        session.complaint = { stage: 'DESCRIBE' };
        parts.push(t(session.lang).complaintAsk);
      }
      break;
    case 'show_cart':
      parts.push(describeCart(session.cart, catalogue, session.lang));
      break;
    case 'clear_cart':
      session.cart = [];
      session.awaitingConfirmation = false;
      parts.push(t(session.lang).cartCleared);
      break;
    case 'order_status':
      parts.push(await orderStatus(session));
      break;
    case 'human':
      await orders.notifyKitchen(t('en').kitchenHuman(session.phone, text));
      parts.push(t(session.lang).humanHandoff);
      break;
    case 'place_order':
      // First request shows the real order for a yes; only the confirmation afterwards places it.
      if (missingOptions.length) break;
      if (session.awaitingConfirmation) {
        parts.push(await placeOrder(session, settings, catalogue, branches));
      } else {
        parts.push(reviewOrder(session, settings, catalogue, branches));
        if (session.awaitingConfirmation) buttons = confirmButtons(session.lang);
      }
      break;
    default:
      break;
  }
  sessions.remember(session, 'assistant', result.reply);
  sessions.save(session);
  return { text: parts.filter(Boolean).join('\n\n'), buttons, list, productLists, photos: photosFor(result.photos, catalogue, session.lang) };
};

/** Confirm / Change buttons under the order review; confirming places the order without asking the model. */
const handleOrderButton = async (session, replyId, title) => {
  if (replyId === 'order:change') {
    session.awaitingConfirmation = false;
    sessions.remember(session, 'user', title);
    sessions.remember(session, 'assistant', t(session.lang).whatToChange);
    return t(session.lang).whatToChange;
  }
  if (replyId === 'order:review') {
    // "Review my order" under a chosen branch: the order summary with Confirm / Change, or what is still missing.
    const [categories, settings, branches] = await Promise.all([mdawra.getMenu(), mdawra.getSettings(), getBranches()]);
    session.awaitingConfirmation = false;
    const text = reviewOrder(session, settings, buildCatalogue(categories), branches);
    return { text, buttons: session.awaitingConfirmation ? confirmButtons(session.lang) : null };
  }
  if (replyId !== 'order:confirm' || !session.awaitingConfirmation) return null;
  const [categories, settings, branches] = await Promise.all([mdawra.getMenu(), mdawra.getSettings(), getBranches()]);
  const reply = await placeOrder(session, settings, buildCatalogue(categories), branches);
  sessions.remember(session, 'user', title);
  sessions.remember(session, 'assistant', reply);
  return reply;
};

/**
 * Post-delivery conversation: receipt confirmation → 1-5 rating → comments.
 * Returns null when the message is not part of that flow.
 */
export const handleAfterSales = async (session, { text, replyId }) => {
  const copy = t(session.lang);
  const buttonMatch = /^(received|notreceived):(.+)$/.exec(replyId || '');
  if (buttonMatch) {
    const entry = orders.get(buttonMatch[2]);
    if (!entry) return null;
    if (buttonMatch[1] === 'notreceived') {
      await orders.notifyKitchen(t('en').kitchenProblem(entry.orderNumber, entry.phone));
      orders.untrack(entry.id);
      return copy.receiptProblem;
    }
    session.feedback = { orderId: entry.id, stage: 'RATING' };
    return `${copy.receiptThanks} ${copy.askRating}`;
  }

  const pending = session.feedback;
  if (!pending) return null;
  const entry = orders.get(pending.orderId);
  if (!entry) {
    session.feedback = null;
    return null;
  }
  if (pending.stage === 'RATING') {
    const rating = Number((text || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).match(/[1-5]/)?.[0]);
    if (!rating) return copy.invalidRating;
    pending.rating = rating;
    pending.stage = 'COMMENT';
    return copy.askComments;
  }
  const skip = /^(no|nope|none|لا|لأ|skip)\.?$/i.test((text || '').trim());
  const record = orders.recordFeedback({ entry, rating: pending.rating, comment: skip ? null : text });
  await orders.notifyKitchen(t('en').kitchenFeedback(record.orderNumber, record.rating, record.comment));
  session.feedback = null;
  return copy.feedbackThanks;
};

/** Entry point for one inbound WhatsApp message. */
export const handleInbound = async ({ phone, waName, text, replyId, audioId, mimeType, location, unsupported, cartOrder }) => {
  const session = sessions.get(phone, waName);
  const copy = () => t(session.lang);
  let utterance = text || '';
  let fromVoice = false;

  if (unsupported) return finish(session, copy().unsupportedMessage, false);
  if (location && Number.isFinite(location.lat) && Number.isFinite(location.lng)) {
    session.location = { lat: location.lat, lng: location.lng };
    utterance = `[Shared a map location${location.label ? `: ${location.label}` : ''}]`;
  }

  const orderButton = await handleOrderButton(session, replyId, text);
  if (orderButton) return finish(session, orderButton, false);

  // "Place order" from the WhatsApp cart: the cart becomes the order draft and
  // the agent carries on with whatever is still missing (address, payment…).
  let unavailableNote = null;
  if (cartOrder) {
    session.greeted = true;
    if (!session.lang) session.lang = detectLang(text, 'en');
    const categories = await mdawra.getMenu();
    const { lines, unavailable } = cartFromOrder(cartOrder, categories);
    if (!lines.length) return finish(session, copy().cartUnavailable, false);
    session.cart = lines;
    session.awaitingConfirmation = false;
    if (unavailable.length) unavailableNote = copy().someUnavailable;
    const catalogue = buildCatalogue(categories);
    const summary = lines.map((l) => `${l.quantity} × ${localName(catalogue.items.find((c) => c.item.id === l.menuItemId).item, session.lang)}`).join(', ');
    utterance = `[Sent a cart from the WhatsApp catalogue: ${summary}]${text ? ` ${text}` : ''}`;
  }

  if (audioId) {
    if (!isOpenAiConfigured()) return finish(session, copy().aiUnavailable, false);
    try {
      const media = await wa.downloadMedia(audioId);
      const { text: transcript, language } = await openai.transcribe(media.buffer, mimeType || media.mimeType);
      if (!transcript) return finish(session, copy().unclearVoice, false);
      utterance = transcript;
      // The script of what was said beats the model's language label, which can be wrong on short, noisy notes.
      session.lang = detectLang(transcript, language || session.lang);
      fromVoice = true;
    } catch (error) {
      console.error('[flow] transcription failed', error.message);
      return finish(session, copy().unclearVoice, false);
    }
  }

  if (!session.lang) session.lang = detectLang(utterance, 'en');

  const menuReply = await handleMenu(session, { replyId, text: utterance });
  if (menuReply) return finish(session, menuReply, false);

  // Tapping an item in the catalogue list is the same as asking for it: the agent adds it or asks for its options.
  let tapPhotos = [];
  const itemTap = /^item:(.+)$/.exec(replyId || '');
  if (itemTap) {
    const catalogue = buildCatalogue(await mdawra.getMenu());
    const entry = catalogue.items.find((c) => c.item.id === itemTap[1]);
    if (entry) {
      utterance = copy().wantItem(localName(entry.item, session.lang));
      tapPhotos = photosFor([entry.no], catalogue, session.lang);
    }
  }

  // A greeting ("hi", "السلام عليكم", "هلا"…) always gets the welcome and the main menu, and so does an empty
  // first message. A message that already asks for something goes to the agent.
  const firstContact = !session.greeted && !session.history.length;
  session.greeted = true;
  const greeting = GREETING.test(utterance.trim());
  if (!replyId && !cartOrder && (greeting || (firstContact && !utterance.trim()))) {
    if (greeting) session.lang = detectLang(utterance, session.lang);
    return finish(session, mainMenu(session.lang, copy().welcome), false);
  }

  const afterSales = await handleAfterSales(session, { text: utterance, replyId });
  if (afterSales) return finish(session, afterSales, fromVoice);

  if (session.complaint?.stage === 'DESCRIBE' && utterance.trim() && !cartOrder) {
    session.complaint = null;
    return finish(session, await logComplaint(session, utterance.trim()), fromVoice);
  }

  if (!utterance.trim()) return finish(session, copy().unclearVoice, false);
  const reply = await runAgent(session, utterance);
  if (tapPhotos.length && typeof reply === 'object') {
    const seen = new Set(tapPhotos.map((p) => p.url));
    reply.photos = [...tapPhotos, ...(reply.photos || []).filter((p) => !seen.has(p.url))].slice(0, 3);
  }
  if (unavailableNote && typeof reply === 'object') reply.text = `${unavailableNote}\n\n${reply.text}`;
  return finish(session, reply, fromVoice);
};

/** Sends a reply: photos first, then the text (with a list or buttons when given), then an optional voice note. */
const finish = async (session, reply, voice) => {
  const { text: rawText, buttons, list, photos, productLists } = typeof reply === 'string' ? { text: reply } : reply;
  const text = rawText || (list ? t(session.lang).menuPrompt : '');
  sessions.save(session);
  for (const photo of photos || []) {
    try {
      await wa.sendImage(session.phone, photo.url, photo.caption);
    } catch (error) {
      console.error('[flow] photo failed', photo.url, error.message);
    }
  }
  if (productLists?.length) {
    if (text) await wa.sendText(session.phone, text);
    try {
      for (const productList of productLists) await wa.sendProductList(session.phone, productList);
      return text || t(session.lang).catalogBody;
    } catch (error) {
      // e.g. the catalogue is not (or no longer) linked to this number: fall back to the category list.
      console.error('[flow] catalogue message failed, sending the category list instead', error.message);
      const fallback = await categoriesMenu(session.lang);
      await wa.sendList(session.phone, fallback.text, fallback.list.button, fallback.list.sections);
      return fallback.text;
    }
  }
  if (list) {
    if (text.length <= 1024) {
      await wa.sendList(session.phone, text, list.button, list.sections);
    } else {
      await wa.sendText(session.phone, text);
      await wa.sendList(session.phone, t(session.lang).menuPrompt, list.button, list.sections);
    }
  } else if (buttons?.length && text.length <= 1024) {
    await wa.sendButtons(session.phone, text, buttons);
  } else {
    await wa.sendText(session.phone, text);
    if (buttons?.length) await wa.sendButtons(session.phone, t(session.lang).confirmPrompt, buttons);
  }
  if (voice && config.openai.voiceReplies) {
    try {
      const spoken = text.split('\n\n')[0];
      const audio = await openai.synthesize(spoken, session.lang);
      const mediaId = await wa.uploadMedia(audio.buffer, audio.mimeType);
      await wa.sendAudio(session.phone, mediaId);
    } catch (error) {
      console.error('[flow] voice reply failed', error.message);
    }
  }
  return text;
};
