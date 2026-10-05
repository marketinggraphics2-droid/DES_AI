// Websites allowed to show the widget and call the chat API: ALLOWED_ORIGINS / WEBSITE_URL from .env (fixed)
// plus the ones added in the dashboard (allowed_sites table), kept in memory so requests don't hit the database.
import { cfg } from './config.js';
import { q } from './db.js';

let added = new Set();
export async function loadSites() { added = new Set((await q('select origin from allowed_sites')).rows.map((r) => r.origin)); }
export const isAllowedOrigin = (o) => !!o && (cfg.allowedOrigins.includes(o) || added.has(o));
export const anySitesConfigured = () => cfg.allowedOrigins.length > 0 || added.size > 0;

/** "https://Example.com/page?x" → "https://example.com"; null if it isn't an http(s) website address. */
export function toOrigin(s) {
  try { const u = new URL(String(s ?? '').trim()); return /^https?:$/.test(u.protocol) && u.hostname ? u.origin : null; } catch { return null; }
}
