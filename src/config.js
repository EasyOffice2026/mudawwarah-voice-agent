import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const bool = (value, fallback) => (value === undefined || value === '' ? fallback : value === 'true');

export const config = {
  port: Number(process.env.PORT || 4100),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4100}`).replace(/\/$/, ''),
  adminToken: process.env.ADMIN_TOKEN || '',
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null,
  mdawra: {
    apiUrl: (process.env.MDAWRA_API_URL || 'http://localhost:4000/api').replace(/\/$/, ''),
    tenant: process.env.MDAWRA_TENANT || 'mdawra',
    cacheSeconds: Number(process.env.MENU_CACHE_SECONDS || 120),
  },
  whatsapp: {
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    sessionTtlMinutes: Number(process.env.SESSION_TTL_MINUTES || 120),
    // Meta Commerce catalogue linked to the WhatsApp number; when set, "menu" opens it with photos and a cart.
    catalogId: process.env.WHATSAPP_CATALOG_ID || '',
    // Token with catalog_management for uploading the menu (defaults to WHATSAPP_TOKEN).
    catalogToken: process.env.WHATSAPP_CATALOG_TOKEN || '',
    catalogSiteUrl: process.env.CATALOG_SITE_URL || '',
  },
  payment: {
    provider: (process.env.PAYMENT_PROVIDER || 'none').toLowerCase(),
    myfatoorah: {
      apiKey: process.env.MYFATOORAH_API_KEY || '',
      baseUrl: (process.env.MYFATOORAH_BASE_URL || 'https://apitest.myfatoorah.com').replace(/\/$/, ''),
      currency: process.env.MYFATOORAH_CURRENCY || 'KWD',
    },
  },
  kitchen: {
    // WhatsApp number (digits only, with country code) that receives a copy of every new order.
    whatsappNumber: process.env.KITCHEN_WHATSAPP_NUMBER || '',
    pollSeconds: Number(process.env.ORDER_POLL_SECONDS || 30),
    // After this long an unpaid online order is treated as abandoned and stops being tracked.
    paymentTimeoutMinutes: Number(process.env.PAYMENT_TIMEOUT_MINUTES || 60),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    chatModel: process.env.CHAT_MODEL || 'gpt-4o-mini',
    transcribeModel: process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
    ttsModel: process.env.TTS_MODEL || 'gpt-4o-mini-tts',
    ttsVoice: process.env.TTS_VOICE || 'alloy',
    // Off by default: the restaurant prefers text replies; voice notes are still understood.
    voiceReplies: bool(process.env.VOICE_REPLIES, false),
    historyLimit: Number(process.env.HISTORY_LIMIT || 16),
  },
};

export const isWhatsappConfigured = () => Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId);
export const isOpenAiConfigured = () => Boolean(config.openai.apiKey);
