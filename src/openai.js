import { config } from './config.js';

const headers = (extra = {}) => ({ Authorization: `Bearer ${config.openai.apiKey}`, ...extra });

const fail = async (response, what) => {
  const body = await response.json().catch(() => ({}));
  throw new Error(body?.error?.message || `${what} failed with status ${response.status}`);
};

const EXTENSIONS = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
};
const extensionFor = (mimeType) => EXTENSIONS[String(mimeType || '').split(';')[0].trim()] || 'ogg';

const languageCode = (value) => {
  const v = String(value || '').toLowerCase();
  if (!v) return null;
  if (v.startsWith('ar')) return 'ar';
  if (v.startsWith('en')) return 'en';
  return v.slice(0, 2);
};

/** Speech-to-text. Returns `{ text, language }`; language is an ISO-639-1 code when known. */
export const transcribe = async (buffer, mimeType) => {
  const form = new FormData();
  form.append('model', config.openai.transcribeModel);
  form.append('response_format', 'verbose_json');
  form.append('prompt', 'Restaurant food order in Kuwaiti Arabic or English. Menu items, quantities, delivery address.');
  form.append('file', new Blob([buffer], { type: mimeType }), `voice.${extensionFor(mimeType)}`);
  const response = await fetch(`${config.openai.baseUrl}/audio/transcriptions`, { method: 'POST', headers: headers(), body: form });
  if (!response.ok) await fail(response, 'Transcription');
  const data = await response.json();
  return { text: String(data.text || '').trim(), language: languageCode(data.language) };
};

/** Chat completion constrained to a strict JSON schema; returns the parsed object. */
export const completeJson = async ({ system, messages, schema, schemaName }) => {
  const response = await fetch(`${config.openai.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model: config.openai.chatModel,
      temperature: 0.3,
      messages: [{ role: 'system', content: system }, ...messages],
      response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
    }),
  });
  if (!response.ok) await fail(response, 'Chat completion');
  const data = await response.json();
  return JSON.parse(data.choices?.[0]?.message?.content || '{}');
};

/** Text-to-speech as OGG/Opus — the container WhatsApp plays as a voice note. */
export const synthesize = async (text, lang) => {
  const response = await fetch(`${config.openai.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model: config.openai.ttsModel,
      voice: config.openai.ttsVoice,
      input: text,
      response_format: 'opus',
      instructions:
        lang === 'ar'
          ? 'Speak warm, natural Gulf (Kuwaiti) Arabic like a friendly restaurant host. Say prices clearly.'
          : 'Speak as a warm, upbeat restaurant host. Say prices clearly.',
    }),
  });
  if (!response.ok) await fail(response, 'Speech synthesis');
  return { buffer: Buffer.from(await response.arrayBuffer()), mimeType: 'audio/ogg' };
};
