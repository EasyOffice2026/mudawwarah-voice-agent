import { config } from './config.js';

/**
 * Payment links. `myfatoorah` is the real gateway (KNET, cards, Apple Pay in
 * Kuwait); `mock` hands out a link on this server that marks the invoice paid
 * when opened, for demos and tests. `none` means orders are cash/card on
 * delivery only.
 */

const myfatoorahRequest = async (path, body) => {
  const { apiKey, baseUrl } = config.payment.myfatoorah;
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.IsSuccess === false) throw new Error(data.Message || `MyFatoorah request failed with status ${response.status}`);
  return data.Data ?? data;
};

const myfatoorah = {
  createPaymentLink: async ({ order, phone, lang, callbackUrl }) => {
    const data = await myfatoorahRequest('/v2/SendPayment', {
      CustomerName: order.customerName,
      NotificationOption: 'LNK',
      InvoiceValue: Number(order.total),
      DisplayCurrencyIso: config.payment.myfatoorah.currency,
      CustomerMobile: String(phone).replace(/^965/, '').replace(/\D/g, '').slice(-8),
      MobileCountryCode: '+965',
      Language: lang === 'ar' ? 'ar' : 'en',
      CustomerReference: order.orderNumber,
      CallBackUrl: callbackUrl,
      ErrorUrl: callbackUrl,
    });
    return { url: data.InvoiceURL, reference: String(data.InvoiceId) };
  },
  /** Confirms with MyFatoorah directly so a spoofed callback cannot mark an order paid. */
  getPaymentStatus: async (query) => {
    const paymentId = query.paymentId || query.PaymentId;
    const invoiceId = query.invoiceId || query.InvoiceId || query.Id;
    const data = await myfatoorahRequest('/v2/GetPaymentStatus', paymentId ? { Key: paymentId, KeyType: 'PaymentId' } : { Key: String(invoiceId), KeyType: 'InvoiceId' });
    const status = String(data.InvoiceStatus || '').toLowerCase();
    return { reference: String(data.InvoiceId), paid: status === 'paid', failed: ['failed', 'canceled', 'cancelled', 'expired'].includes(status) };
  },
};

const mockPaid = new Set();
const mock = {
  createPaymentLink: async ({ order }) => ({
    url: `${config.publicUrl}/payments/mock/pay?ref=${encodeURIComponent(order.id)}`,
    reference: order.id,
  }),
  getPaymentStatus: async (query) => {
    const reference = String(query.ref || query.reference || '');
    return { reference, paid: mockPaid.has(reference), failed: false };
  },
  markPaid: (reference) => mockPaid.add(reference),
};

const providers = { myfatoorah, mock };

export const provider = () => providers[config.payment.provider] || null;

export const isOnlinePaymentEnabled = () => {
  if (config.payment.provider === 'myfatoorah') return Boolean(config.payment.myfatoorah.apiKey);
  return config.payment.provider === 'mock';
};

export const createPaymentLink = ({ order, phone, lang }) =>
  provider().createPaymentLink({ order, phone, lang, callbackUrl: `${config.publicUrl}/payments/callback` });

export const getPaymentStatus = (query) => provider().getPaymentStatus(query);

export const markMockPaid = (reference) => mock.markPaid(reference);
