import { config, isOpenAiConfigured } from './config.js';
import * as sessions from './sessions.js';
import * as mdawra from './mdawra.js';
import * as openai from './openai.js';
import * as wa from './whatsapp.js';
import * as orders from './orders.js';
import * as payment from './payment.js';
import { t } from './copy.js';
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

/** Why the order cannot be placed yet, as a message for the customer, or null when it can. */
const orderBlocker = (session, settings, catalogue) => {
  const copy = t(session.lang);
  if (settings.isOpen === 'false') return copy.closed(settings.workingHours);
  const { missing } = missingForOrder(session, settings);
  if (missing.length) return missingFieldsNote(session.lang, missing);
  const { subtotal } = priceCart(session.cart, catalogue);
  if (subtotal < Number(settings.minimumOrder || 0)) return copy.minimumOrder(settings.minimumOrder);
  return null;
};

/**
 * Shows the customer exactly what will reach the kitchen — built from the real
 * cart, not the model's memory — and waits for them to confirm it.
 */
export const reviewOrder = (session, settings, catalogue) => {
  const blocker = orderBlocker(session, settings, catalogue);
  if (blocker) return blocker;
  const { orderType } = missingForOrder(session, settings);
  session.awaitingConfirmation = true;
  return t(session.lang).reviewOrder({
    cart: describeCart(session.cart, catalogue, session.lang),
    customer: session.customer,
    orderType,
    deliveryFee: Number(settings.deliveryFee || 0),
    paymentMethod: session.paymentMethod,
    hasPin: Boolean(session.location),
  });
};

const confirmButtons = (lang) => [
  { id: 'order:confirm', title: t(lang).confirmButton },
  { id: 'order:change', title: t(lang).changeButton },
];

/** Everything the customer confirmed; any change after the review needs a new review. */
const orderSnapshot = (session) => JSON.stringify([session.cart, session.customer, session.orderType, session.paymentMethod, session.location]);

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
export const placeOrder = async (session, settings, catalogue) => {
  const copy = t(session.lang);
  const blocker = orderBlocker(session, settings, catalogue);
  if (blocker) return blocker;
  const { orderType } = missingForOrder(session, settings);

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
  let paymentMethod = session.paymentMethod;
  let paymentReference = null;
  let reply;
  if (paymentMethod === 'ONLINE' && payment.isOnlinePaymentEnabled()) {
    try {
      const link = await payment.createPaymentLink({ order, phone: session.phone, lang: session.lang });
      paymentReference = link.reference;
      reply = copy.payNow(order.orderNumber, order.total, link.url);
    } catch (error) {
      console.error('[flow] payment link failed', error.message);
      paymentMethod = 'CASH';
      reply = `${copy.orderPlaced(order.orderNumber, order.total)}\n${copy.paymentLinkUnavailable}`;
    }
  } else {
    paymentMethod = paymentMethod === 'ONLINE' ? 'CASH' : paymentMethod;
    reply = copy.orderPlaced(order.orderNumber, order.total);
  }
  orders.track({ order, phone: session.phone, lang: session.lang, paymentMethod, paymentReference });
  await orders.notifyKitchen(orders.orderSummaryForKitchen(order, c, session.location) + (paymentMethod === 'ONLINE' ? '\n(awaiting online payment)' : ''));
  sessions.resetOrder(session);
  return reply;
};

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

/** Runs the AI sales agent for one customer utterance and applies its decisions. */
export const runAgent = async (session, text) => {
  const copy = t(session.lang);
  if (!isOpenAiConfigured()) return copy.aiUnavailable;
  const [categories, settings] = await Promise.all([mdawra.getMenu(), mdawra.getSettings()]);
  const catalogue = buildCatalogue(categories);
  const onlinePayment = payment.isOnlinePaymentEnabled();

  sessions.remember(session, 'user', text);
  let result;
  try {
    result = await openai.completeJson({
      system: systemPrompt({ settings, catalogue, session, restaurantName: settings.restaurantName || RESTAURANT_NAME, onlinePayment }),
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
  if (orderSnapshot(session) !== before) session.awaitingConfirmation = false;

  const parts = [result.reply];
  let buttons = null;
  if (missingOptions.length) parts.push(missingOptionsNote(session.lang, missingOptions));
  switch (result.action) {
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
        parts.push(await placeOrder(session, settings, catalogue));
      } else {
        parts.push(reviewOrder(session, settings, catalogue));
        if (session.awaitingConfirmation) buttons = confirmButtons(session.lang);
      }
      break;
    default:
      break;
  }
  sessions.remember(session, 'assistant', result.reply);
  sessions.save(session);
  return { text: parts.filter(Boolean).join('\n\n'), buttons, photos: photosFor(result.photos, catalogue, session.lang) };
};

/** Confirm / Change buttons under the order review; confirming places the order without asking the model. */
const handleOrderButton = async (session, replyId, title) => {
  if (replyId === 'order:change') {
    session.awaitingConfirmation = false;
    sessions.remember(session, 'user', title);
    sessions.remember(session, 'assistant', t(session.lang).whatToChange);
    return t(session.lang).whatToChange;
  }
  if (replyId !== 'order:confirm' || !session.awaitingConfirmation) return null;
  const [categories, settings] = await Promise.all([mdawra.getMenu(), mdawra.getSettings()]);
  const reply = await placeOrder(session, settings, buildCatalogue(categories));
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
export const handleInbound = async ({ phone, waName, text, replyId, audioId, mimeType, location, unsupported }) => {
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

  const afterSales = await handleAfterSales(session, { text: utterance, replyId });
  if (afterSales) return finish(session, afterSales, fromVoice);

  if (!utterance.trim()) return finish(session, copy().unclearVoice, false);
  const reply = await runAgent(session, utterance);
  return finish(session, reply, fromVoice);
};

/** Sends a reply: photos first, then the text (with buttons when given), then an optional voice note. */
const finish = async (session, reply, voice) => {
  const { text, buttons, photos } = typeof reply === 'string' ? { text: reply } : reply;
  sessions.save(session);
  for (const photo of photos || []) {
    try {
      await wa.sendImage(session.phone, photo.url, photo.caption);
    } catch (error) {
      console.error('[flow] photo failed', photo.url, error.message);
    }
  }
  if (buttons?.length && text.length <= 1024) {
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
