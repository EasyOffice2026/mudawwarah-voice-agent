// Uploads the live Mdawra menu to the WhatsApp (Meta Commerce) catalogue:
// every item with photo, name, price and availability, keyed by its menu item ID.
// Items removed from the menu are marked out of stock in the catalogue.
//
//   npm run catalog:sync             upload / update the menu
//   npm run catalog:sync -- --enable also show the catalogue and cart on the WhatsApp number
//
// Needs WHATSAPP_CATALOG_ID, and a token with catalog_management
// (WHATSAPP_CATALOG_TOKEN, or WHATSAPP_TOKEN if it has that permission).
import { syncCatalog, enableCommerceSettings } from '../src/catalog.js';
import * as mdawra from '../src/mdawra.js';

try {
  const menu = await mdawra.getMenu();
  const result = await syncCatalog(menu);
  console.log(`Catalogue updated: ${result.uploaded} items uploaded, ${result.retired} old items marked out of stock.`);
  if (process.argv.includes('--enable')) {
    await enableCommerceSettings();
    console.log('Catalogue and cart are now visible on the WhatsApp number.');
  }
} catch (error) {
  console.error(`Catalogue sync failed: ${error.message}`);
  process.exit(1);
}
