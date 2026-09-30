// Publishes the live Mdawra menu as the WhatsApp order form (a WhatsApp Flow):
// every item with a quantity picker, so customers choose several items at once.
// Published Flows cannot be edited, so run this again after menu changes: it
// creates a new Flow, deprecates the previous one and prints the new ID for .env.
//
//   npm run flow:sync              validate and publish
//   npm run flow:sync -- --check   validate only (creates a draft, nothing is published)
//
// Needs WHATSAPP_BUSINESS_ACCOUNT_ID and a token with whatsapp_business_management.
import { config } from '../src/config.js';
import { publishOrderFlow } from '../src/orderFlow.js';
import * as mdawra from '../src/mdawra.js';

const check = process.argv.includes('--check');
try {
  if (!config.whatsapp.wabaId) throw new Error('WHATSAPP_BUSINESS_ACCOUNT_ID is not set');
  const { flowId, validationErrors } = await publishOrderFlow({
    wabaId: config.whatsapp.wabaId,
    categories: await mdawra.getMenu(),
    previousFlowId: config.whatsapp.orderFlowId || null,
    publish: !check,
  });
  if (validationErrors.length) {
    console.error(`Meta rejected the form (draft ${flowId}):`);
    for (const error of validationErrors) console.error(`- ${error.message} (${error.pointers?.[0]?.path || 'flow'})`);
    process.exit(1);
  }
  console.log(check ? `Form is valid (draft ${flowId}, not published).` : `Order form published. Put this in .env:\nWHATSAPP_ORDER_FLOW_ID=${flowId}`);
} catch (error) {
  console.error(`Order form sync failed: ${error.message}`);
  process.exit(1);
}
