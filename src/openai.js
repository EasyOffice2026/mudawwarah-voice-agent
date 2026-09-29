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

// Arabic first: with an English-only prompt, Whisper tends to answer Kuwaiti voice notes in English.
const TRANSCRIBE_PROMPT = 'طلب أكل من مطعم مدورة في الكويت، باللهجة الكويتية أو بالإنجليزي. أصناف المنيو، الكمية، عنوان التوصيل. Restaurant order in Kuwaiti Arabic or English; write it in the language spoken, never translate.';

/** Speech-to-text. Returns `{ text, language }`; language is an ISO-639-1 code when the model reports one. */
export const transcribe = async (buffer, mimeType) => {
  const model = config.openai.transcribeModel;
  const form = new FormData();
  form.append('model', model);
  // Only whisper-1 supports verbose_json (which adds the detected language); the gpt-4o transcribe models take json.
  form.append('response_format', model.startsWith('whisper') ? 'verbose_json' : 'json');
  form.append('prompt', TRANSCRIBE_PROMPT);
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

const ARABIC_VOICE = [
  'Accent: native Kuwaiti Arabic speaker from Kuwait City. Pronounce the text exactly as a Kuwaiti would in everyday speech, not Modern Standard Arabic and not Egyptian or Levantine.',
  'Kuwaiti phonetics: pronounce ج as a soft "y" sound where Kuwaitis do (e.g. "ديرة", "يالله"), ق as "g" in colloquial words (e.g. "قال" -> "gaal"), ك as "ch" where natural (e.g. "شخبارك" -> "shakhbaarich" for a woman). Relaxed Gulf vowels, drop case endings entirely.',
  'Persona: a warm, friendly Kuwaiti restaurant host, hospitable and unhurried, with a light smile in the voice. Natural pauses between sentences.',
  'Say prices and numbers clearly in Kuwaiti colloquial form (e.g. "دينار ونص", "ثلاث دنانير", "خمسمية فلس").',
].join(' ');

const ENGLISH_VOICE =
  'Speak as a warm, upbeat Kuwaiti restaurant host speaking clear English with a light Gulf Arabic accent. Say prices clearly.';

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
      instructions: lang === 'ar' ? ARABIC_VOICE : ENGLISH_VOICE,
    }),
  });
  if (!response.ok) await fail(response, 'Speech synthesis');
  return { buffer: Buffer.from(await response.arrayBuffer()), mimeType: 'audio/ogg' };
};
