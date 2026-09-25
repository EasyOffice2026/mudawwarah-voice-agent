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

/**
 * Places the order through the Mdawra API and, for online payment, sends the
 * link. Returns the text to show the customer.
 */
export const placeOrder = async (session, settings, catalogue) => {
  const copy = t(session.lang);
  if (settings.isOpen === 'false') return copy.closed(settings.workingHours);
  const { missing, orderType } = missingForOrder(session, settings);
  if (missing.length) return missingFieldsNote(session.lang, missing);
  const { subtotal } = priceCart(session.cart, catalogue);
  if (subtotal < Number(settings.minimumOrder || 0)) return copy.minimumOrder(settings.minimumOrder);

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
  await orders.notifyKitchen(orders.orderSummaryForKitchen(order, c) + (paymentMethod === 'ONLINE' ? '\n(awaiting online payment)' : ''));
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
  const { cart, missingOptions } = applyCartChanges(session.cart, result, catalogue);
  session.cart = cart;
  applyCustomerDetails(session, result, { onlinePayment });

  const parts = [result.reply];
  if (missingOptions.length) parts.push(missingOptionsNote(session.lang, missingOptions));
  switch (result.action) {
    case 'show_cart':
      parts.push(describeCart(session.cart, catalogue, session.lang));
      break;
    case 'clear_cart':
      session.cart = [];
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
      if (!missingOptions.length) parts.push(await placeOrder(session, settings, catalogue));
      break;
    default:
      break;
  }
  const reply = parts.filter(Boolean).join('\n\n');
  sessions.remember(session, 'assistant', result.reply);
  sessions.save(session);
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
export const handleInbound = async ({ phone, waName, text, replyId, audioId, mimeType }) => {
  const session = sessions.get(phone, waName);
  const copy = () => t(session.lang);
  let utterance = text || '';
  let fromVoice = false;

  if (audioId) {
    if (!isOpenAiConfigured()) return finish(session, copy().aiUnavailable, false);
    try {
      const media = await wa.downloadMedia(audioId);
      const { text: transcript, language } = await openai.transcribe(media.buffer, mimeType || media.mimeType);
      if (!transcript) return finish(session, copy().unclearVoice, false);
      utterance = transcript;
      if (language) session.lang = language;
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

const finish = async (session, reply, voice) => {
  sessions.save(session);
  await wa.sendText(session.phone, reply);
  if (voice && config.openai.voiceReplies) {
    try {
      const spoken = reply.split('\n\n')[0];
      const audio = await openai.synthesize(spoken, session.lang);
      const mediaId = await wa.uploadMedia(audio.buffer, audio.mimeType);
      await wa.sendAudio(session.phone, mediaId);
    } catch (error) {
      console.error('[flow] voice reply failed', error.message);
    }
  }
  return reply;
};
