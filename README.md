# Mudawwarah WhatsApp Voice Sales Agent

A standalone WhatsApp sales agent for Mudawwarah restaurant. Customers send voice notes (or text) in Kuwaiti/Gulf Arabic, Arabic or English; the agent knows the complete live menu with prices, sells, takes the order, sends a payment link, forwards the order to the kitchen and follows up until the customer has rated the food and service.

It runs next to the existing Mdawra ordering platform and talks to it only through its public API (`/categories`, `/settings`, `/orders`, `/orders/track/:id`) — no shared database.

## Customer journey

| Step | What happens |
| --- | --- |
| Voice note arrives | Downloaded from Meta, transcribed with OpenAI Whisper (Arabic/English auto-detected). |
| Selling | The agent (OpenAI, strict JSON output) answers from the live catalogue: describes items, states prices, suggests one relevant extra, asks for required options (size, sauce…). It can only reference catalogue numbers/option codes, and every item, option and price is validated server-side. |
| Order details | Name, delivery/pickup, Kuwait address (area, block, street, building), payment method — collected conversationally, one or two questions at a time. |
| Finalise | The agent reads the order back; on confirmation it is created through the Mdawra API (`channel: WHATSAPP`). |
| Payment | For online payment a MyFatoorah (KNET / cards / Apple Pay) link is sent. The callback is re-verified with the gateway before the order is marked paid. Cash and card-on-delivery are also supported. |
| Kitchen | The order appears in the Mdawra admin orders panel as usual; optionally a summary is also sent to `KITCHEN_WHATSAPP_NUMBER`. |
| Status updates | The service polls the order status; the customer is told when the kitchen confirms, when it is being prepared, when it is ready / on its way and when delivered. |
| Receipt | On delivery (or ready-for-pickup) the customer gets Yes/No buttons to confirm receipt; a "not received" answer alerts the kitchen immediately. |
| Feedback | 1–5 rating, then free-text comments on the food, delivery and service. Stored in `DATA_DIR/feedback.json`, forwarded to the kitchen number, and available at `GET /feedback` (Bearer `ADMIN_TOKEN`). |

Replies are sent as text and, for voice notes, also as a spoken voice note (OpenAI TTS, OGG/Opus).

## Run locally

```bash
npm install
cp .env.example .env   # fill in the values
npm run dev            # http://localhost:4100
npm test
```

`GET /health` shows which integrations are configured.

## Configuration

| Variable | Purpose |
| --- | --- |
| `MDAWRA_API_URL`, `MDAWRA_TENANT` | The Mdawra backend and tenant slug (`https://mdawra-api.onrender.com/api`, `mdawra`). |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | Meta WhatsApp Cloud API. Point the app's webhook at `https://<host>/webhook` and subscribe to `messages`. |
| `OPENAI_API_KEY` | Transcription, sales agent and TTS. `CHAT_MODEL`, `TRANSCRIBE_MODEL`, `TTS_MODEL`, `TTS_VOICE`, `VOICE_REPLIES` tune it. |
| `PAYMENT_PROVIDER` | `myfatoorah` (needs `MYFATOORAH_API_KEY`, `MYFATOORAH_BASE_URL` — use `https://api.myfatoorah.com` in production), `mock` for demos, or `none`. |
| `PUBLIC_URL` | Public base URL of this service; payment callbacks return to `PUBLIC_URL/payments/callback`. |
| `KITCHEN_WHATSAPP_NUMBER` | Optional WhatsApp number that receives new orders, payment confirmations, problems and feedback. |
| `ORDER_POLL_SECONDS` | How often order status is checked (default 30). |
| `DATA_DIR` | Directory for `sessions.json`, `orders.json`, `feedback.json` so a restart loses nothing. |
| `ADMIN_TOKEN` | Protects `GET /feedback`. |

## Deploy

`render.yaml` defines a Render web service with a persistent disk mounted at `/var/data`. Set the secret variables in the Render dashboard, then set the resulting URL as `PUBLIC_URL` and as the Meta webhook URL.

## Layout

```
src/
  app.js       Express app: webhook, payment callback, feedback API
  index.js     Entry point (listen + start order polling)
  flow.js      One inbound message → transcription → agent → order / after-sales
  agent.js     Catalogue, strict response schema, prompt, cart/detail validation
  orders.js    Tracked orders, kitchen alerts, status polling, receipt & feedback
  payment.js   MyFatoorah + mock payment links
  mdawra.js    Mdawra API client
  openai.js    Whisper / chat completions / TTS
  whatsapp.js  Meta Graph API client + webhook helpers
  sessions.js  Per-customer conversation state
  copy.js      Bilingual system messages
```
