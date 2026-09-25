import { app } from './app.js';
import { config, isWhatsappConfigured, isOpenAiConfigured } from './config.js';
import * as orders from './orders.js';

app.listen(config.port, () => {
  console.log(`Mudawwarah voice agent listening on :${config.port} (tenant ${config.mdawra.tenant}, payment ${config.payment.provider})`);
  if (!isWhatsappConfigured()) console.warn('WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set — replies will not be delivered');
  if (!isOpenAiConfigured()) console.warn('OPENAI_API_KEY not set — voice notes cannot be transcribed');
  orders.startPolling();
});
