process.env.PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER || 'mock';
process.env.PUBLIC_URL = 'https://agent.test';
process.env.MDAWRA_API_URL = 'https://mdawra.test/api';
process.env.WHATSAPP_TOKEN = 'wa-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '12345';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.OPENAI_API_KEY = 'sk-test';
process.env.KITCHEN_WHATSAPP_NUMBER = '96599990000';
process.env.ADMIN_TOKEN = 'admin-secret';
process.env.VOICE_REPLIES = 'true';
process.env.ORDER_POLL_SECONDS = '0';
// Empty rather than deleted: dotenv only fills unset variables, so deleting it let .env point the tests at the real data folder.
// The same goes for every live setting that changes behaviour: tests switch these on themselves when they need them.
process.env.DATA_DIR = '';
process.env.MENU_PAGE = 'false';
for (const key of ['WHATSAPP_CATALOG_ID', 'WHATSAPP_CATALOG_TOKEN', 'WHATSAPP_ORDER_FLOW_ID', 'WHATSAPP_ORDER_FLOW_MODE', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_APP_SECRET']) {
  process.env[key] ??= '';
}

export const menu = [
  {
    id: 'cat-1',
    nameEn: 'Mains',
    nameAr: 'الأطباق الرئيسية',
    items: [
      {
        id: 'item-shawarma',
        nameEn: 'Chicken Shawarma',
        nameAr: 'شاورما دجاج',
        price: '1.500',
        isFeatured: true,
        image: { url: 'https://cdn.test/shawarma.png' },
        options: [
          { id: 'opt-garlic', nameEn: 'Garlic', nameAr: 'ثوم', groupEn: 'Sauce', groupAr: 'الصوص', isRequired: true, extraPrice: '0' },
          { id: 'opt-tahini', nameEn: 'Tahini', nameAr: 'طحينة', groupEn: 'Sauce', groupAr: 'الصوص', isRequired: true, extraPrice: '0' },
          { id: 'opt-cheese', nameEn: 'Extra cheese', nameAr: 'جبن إضافي', groupEn: 'Extras', groupAr: 'إضافات', isRequired: false, extraPrice: '0.250' },
        ],
      },
      { id: 'item-hidden', nameEn: 'Hidden', price: '9', isAvailable: false, options: [] },
    ],
  },
  {
    id: 'cat-2',
    nameEn: 'Drinks',
    items: [{ id: 'item-cola', nameEn: 'Cola', nameAr: 'كولا', price: '0.500', options: [] }],
  },
];

export const settings = {
  restaurantName: 'Mudawwarah',
  isOpen: 'true',
  workingHours: '11:00 - 23:00',
  deliveryFee: '1.000',
  minimumOrder: '2.000',
  paymentMethods: 'CASH,CARD',
  deliveryEnabled: 'true',
  pickupEnabled: 'true',
};

/**
 * Replaces global fetch with a router keyed by "METHOD url-substring". Each
 * handler receives (url, init) and returns { status?, json?, text?, buffer? }.
 */
export const mockFetch = (routes) => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url: String(url), init });
    for (const [key, handler] of Object.entries(routes)) {
      const [m, fragment] = key.split(' ');
      if (m === method && String(url).includes(fragment)) {
        const out = (await handler(String(url), init)) || {};
        const status = out.status || 200;
        if (out.buffer) return new Response(out.buffer, { status, headers: { 'content-type': out.contentType || 'audio/ogg' } });
        if (out.text !== undefined) return new Response(out.text, { status });
        return new Response(JSON.stringify(out.json ?? {}), { status, headers: { 'content-type': 'application/json' } });
      }
    }
    throw new Error(`unmocked fetch ${method} ${url}`);
  };
  return calls;
};

export const bodyOf = (call) => JSON.parse(call.init.body);
/** Every outbound message with its readable text: body, button prompt or photo caption. */
export const sentMessages = (calls) =>
  calls
    .filter((c) => c.url.includes('/12345/messages'))
    .map(bodyOf)
    .filter((b) => b.type !== undefined)
    .map((b) => ({ to: b.to, type: b.type, text: b.text?.body ?? b.interactive?.body?.text ?? b.image?.caption ?? '', body: b }));
export const sentTexts = (calls) =>
  calls.filter((c) => c.url.includes('/12345/messages')).map((c) => bodyOf(c)).filter((b) => b.type === 'text').map((b) => ({ to: b.to, text: b.text.body }));
