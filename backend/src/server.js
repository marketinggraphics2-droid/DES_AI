import { onStop, requestStop } from './lifecycle.js'; // must stay first: catches stop requests while the database opens
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { cfg, isMock } from './config.js';
import { r } from './routes.js';
import { adminRouter, backfillGolden } from './admin.js';
import { upgradePrompt } from './prompt.js';
import { accessUser, adminClientIp } from './access.js';
import { adminAuth, authRouter } from './auth.js';
import { invalidateSettings } from './settings.js';
import { closeStreams } from './events.js';
import { shareAdmin, sharePage } from './share.js';
import { loadSites, isAllowedOrigin, anySitesConfigured } from './sites.js';
import { pool, exec } from './db.js';
import fs from 'node:fs';

const app = express();
app.set('trust proxy', cfg.trustProxy);
app.use(cors({ origin: (o, cb) => cb(null, !o || !anySitesConfigured() || isAllowedOrigin(o)), credentials: false }));
// the widget's last log on page close comes via navigator.sendBeacon: text/plain body (no CORS pre-check) with the token inside
app.use('/api/log', express.text({ type: 'text/plain', limit: '64kb' }), (req, _res, next) => {
  if (typeof req.body === 'string') { try { req.body = JSON.parse(req.body); } catch { req.body = {}; } }
  if (!req.headers.authorization && typeof req.body?.token === 'string') req.headers.authorization = 'Bearer ' + req.body.token;
  next();
});
app.use(express.json({ limit: '32kb' }));

// ---- access gates ----
// "Proxied" = arrived through the Cloudflare tunnel / a proxy (they add these headers); direct = this computer.
const isProxied = (req) => !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for']);
const isLocal = (req) => !isProxied(req) && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
// 1) Admin dashboard + admin API: only on this computer, ADMIN_ALLOWED_IPS, or a Cloudflare Access login. Everyone else gets a plain 404.
app.use(['/admin', '/api/admin'], async (req, res, next) => {
  req.adminIp = adminClientIp(req);
  if (isLocal(req) || cfg.adminAllowedIps.includes(req.adminIp)) return next();
  if (await accessUser(req)) return next();
  res.status(404).type('text/plain').send('Not found');
});
// 2) Public chat API through the tunnel: only from the approved websites (ALLOWED_ORIGINS / WEBSITE_URL).
//    Stops other sites and scripts from using the bot (and the AI credits). Local calls (dev, tests) are allowed.
//    /health is harmless; the WordPress webhook is server-to-server and checks its own HMAC signature.
const OPEN_PATHS = ['/health', '/ingest/webhook'];
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS' || OPEN_PATHS.includes(req.path) || req.path.startsWith('/admin') || !isProxied(req)) return next();
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) return next();
  // pages served by this backend (/widget/embed-test.html): browsers send no Origin on same-origin GETs
  if (!origin && req.headers['sec-fetch-site'] === 'same-origin') return next();
  res.status(403).json({ error: 'origin_not_allowed' });
});
app.use((req, _res, next) => { req.ip_raw = req.ip; next(); });
// dashboard: signed-in user + permission check on every /api/admin route (auth.js, permissions.js)
app.use('/api/admin', adminAuth, authRouter, shareAdmin);
app.use('/api', r);
// npm run stop: admin token + only from this computer (not through the tunnel, which adds Cloudflare headers)
app.post('/api/admin/shutdown', (req, res) => {
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['cf-connecting-ip'] && !req.headers['cf-ray'] && !req.headers['x-forwarded-for'];
  if (!cfg.adminToken || tok !== cfg.adminToken || !local) return res.status(403).json({ error: 'forbidden' });
  res.json({ ok: true, stopping: true });
  setTimeout(() => requestStop('stop requested', 99), 100); // 99 tells scripts/dev.js to exit instead of waiting
});
app.use('/api/admin', adminRouter);
// share link: the one public, read-only page outside /admin (no sign-in, no IP or website check; the token is the key)
app.get('/share/:token', sharePage);
// admin dashboard (data needs a signed-in user; the page itself is static)
app.use('/admin', express.static(fileURLToPath(new URL('../../admin', import.meta.url)), { maxAge: 0 }));
// widget files for the one-line embed (<script src=".../widget/embed.js">); any origin may load them
app.use('/widget', express.static(process.env.WIDGET_DIR || fileURLToPath(new URL('../../widget', import.meta.url)), { maxAge: '1h' }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'server_error' }); });

// idempotent schema upgrade so new columns/tables exist without a manual migrate
await exec(fs.readFileSync(fileURLToPath(new URL('../sql/schema.sql', import.meta.url)), 'utf8'));
await backfillGolden().catch((e) => console.error('approved-answer backfill', e.message));
await upgradePrompt().catch((e) => console.error('prompt upgrade', e.message));
await invalidateSettings().catch((e) => console.error('settings', e.message));
await loadSites();

const server = app.listen(cfg.port, () => {
  console.log(`DES API on :${cfg.port} · ${isMock() ? 'MOCK mode (no IQ_GATEWAY_KEY)' : 'IQGateway ' + cfg.gateway.url + ' · model ' + cfg.model} · embeddings ${cfg.embeddings.provider}`);
  const base = cfg.publicUrl || `http://localhost:${cfg.port}`;
  console.log(`WordPress embed${cfg.websiteUrl ? ' for ' + cfg.websiteUrl : ''}:
  <script src="${base}/widget/embed.js" data-api="${base}/api" defer></script>`);
  console.log(`Admin dashboard: http://localhost:${cfg.port}/admin`);
  process.send?.('ready'); // scripts/dev.js waits for this before it may ask for a reload
});
// Express 4 doesn't catch async route errors: log them instead of crashing the server
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e));
// Clean shutdown closes the embedded database properly; a hard kill can corrupt it.
let stopping = false;
async function shutdown(why, code = 0) {
  if (stopping) return; stopping = true;
  try { console.log(`stopping (${why})…`); } catch { /* console may be gone if the runner died */ }
  const force = setTimeout(() => process.exit(1), 10000); force.unref();
  closeStreams(); // open dashboard streams would keep the server from closing
  server.close();
  try { await pool.end(); } catch (e) { console.error('db close failed:', e.message); }
  process.exit(code);
}
onStop(shutdown); // signals, dev reloads and runner exit all arrive through lifecycle.js
