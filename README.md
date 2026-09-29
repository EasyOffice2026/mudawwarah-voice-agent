# Mudawwarah WhatsApp Voice Sales Agent

A standalone WhatsApp sales agent for Mudawwarah restaurant. Customers send voice notes (or text) in Kuwaiti/Gulf Arabic, Arabic or English; the agent knows the complete live menu with prices, sells, takes the order, sends a payment link, forwards the order to the kitchen and follows up until the customer has rated the food and service.

It runs next to the existing Mdawra ordering platform and talks to it only through its public API (`/categories`, `/settings`, `/orders`, `/orders/track/:id`) — no shared database.

## Customer journey

| Step | What happens |
| --- | --- |
| Voice note arrives | Downloaded from Meta, transcribed with OpenAI (gpt-4o-mini-transcribe; Arabic/English, never translated). |
| Selling | The agent (OpenAI, strict JSON output) answers from the live catalogue: describes items, states prices, suggests one relevant extra, asks for required options (size, sauce…). It can only reference catalogue numbers/option codes, and every item, option and price is validated server-side. Asked for pictures, it sends up to three menu photos captioned with name and price. Repeating an item updates its quantity instead of adding a duplicate. |
| Order details | Name, delivery/pickup, Kuwait address (area, block, street, building), payment method — collected conversationally, one or two questions at a time. A WhatsApp location pin is accepted: it is sent to Mdawra as `deliveryLat`/`deliveryLng` and to the kitchen as a Google Maps link. Stickers and files get a short "text, voice or location" reply. |
| Finalise | The system shows the exact order from the real cart (items, delivery fee, address, payment) with **Confirm order** / **Change something** buttons. Only a confirmation (button or "yes") creates it through the Mdawra API (`channel: WHATSAPP`); any change after the review triggers a new review. |
| Payment | For online payment a MyFatoorah (KNET / cards / Apple Pay) link is sent. The callback is re-verified with the gateway before the order is marked paid. Cash and card-on-delivery are also supported. |
| Kitchen | The order appears in the Mdawra admin orders panel as usual; optionally a summary is also sent to `KITCHEN_WHATSAPP_NUMBER`. |
| Status updates | The service polls the order status; the customer is told when the kitchen confirms, when it is being prepared, when it is ready / on its way and when delivered. |
| Receipt | On delivery (or ready-for-pickup) the customer gets Yes/No buttons to confirm receipt; a "not received" answer alerts the kitchen immediately. |
| Feedback | 1–5 rating, then free-text comments on the food, delivery and service. Stored in `DATA_DIR/feedback.json`, forwarded to the kitchen number, and available at `GET /feedback` (Bearer `ADMIN_TOKEN`). |

Replies are sent as text. Set `VOICE_REPLIES=true` to also answer voice notes with a spoken voice note (OpenAI TTS, OGG/Opus).

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
  openai.js    Transcription / chat completions / TTS
  whatsapp.js  Meta Graph API client + webhook helpers
  sessions.js  Per-customer conversation state
  copy.js      Bilingual system messages
```
