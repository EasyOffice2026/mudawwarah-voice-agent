import { config } from './config.js';

/**
 * Client for the Mdawra ordering API — the restaurant website's backend. The
 * agent never touches the database: the menu, settings and order creation all
 * go through the same public endpoints the customer site uses.
 */

const request = async (path, init = {}) => {
  const response = await fetch(`${config.mdawra.apiUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Tenant': config.mdawra.tenant, ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error || body?.message || `Mdawra API ${path} failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
};

const cache = new Map();
const cached = async (key, loader) => {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await loader();
  cache.set(key, { value, expires: Date.now() + config.mdawra.cacheSeconds * 1000 });
  return value;
};
export const clearCache = () => cache.clear();

/** Visible categories with their available items and customization options. */
export const getMenu = () => cached('menu', () => request('/categories'));

export const getSettings = () => cached('settings', () => request('/settings'));

/** Active pickup branches with their weekly hours, as the website's checkout shows them. */
export const getPickupLocations = () => cached('pickup-locations', () => request('/pickup-locations'));

/** Delivery zones (area → branch, fee, minimum, ETA, branch open now), as the website's checkout uses them. */
export const getZones = () => cached('zones', () => request('/zones'));

export const createOrder = (payload) => request('/orders', { method: 'POST', body: JSON.stringify(payload) });

export const trackOrder = (id) => request(`/orders/track/${id}`);
