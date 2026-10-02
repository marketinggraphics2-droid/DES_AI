import { onStop, requestStop } from './lifecycle.js'; // must stay first: catches stop requests while the database opens
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { cfg, isMock } from './config.js';
import { r } from './routes.js';
import { adminRouter, backfillGolden } from './admin.js';
import { pool, exec } from './db.js';
import fs from 'node:fs';

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: (o, cb) => cb(null, !o || cfg.allowedOrigins.length === 0 || cfg.allowedOrigins.includes(o)), credentials: false }));
app.use(express.json({ limit: '32kb' }));

// ---- access gates ----
// "Proxied" = arrived through the Cloudflare tunnel / a proxy (they add these headers); direct = this computer.
const isProxied = (req) => !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for']);
const isLocal = (req) => !isProxied(req) && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
// 1) Admin dashboard + admin API: only on this computer (or ADMIN_ALLOWED_IPS). Everyone else gets a plain 404.
app.use(['/admin', '/api/admin'], (req, res, next) => {
  if (isLocal(req) || cfg.adminAllowedIps.includes(clientIp(req))) return next();
  res.status(404).type('text/plain').send('Not found');
});
// 2) Public chat API through the tunnel: only from the approved websites (ALLOWED_ORIGINS / WEBSITE_URL).
//    Stops other sites and scripts from using the bot (and the AI credits). Local calls (dev, tests) are allowed.
//    /health is harmless; the WordPress webhook is server-to-server and checks its own HMAC signature.
const OPEN_PATHS = ['/health', '/ingest/webhook'];
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS' || OPEN_PATHS.includes(req.path) || req.path.startsWith('/admin') || !isProxied(req)) return next();
  const origin = req.headers.origin;
  if (origin && cfg.allowedOrigins.includes(origin)) return next();
  res.status(403).json({ error: 'origin_not_allowed' });
});
app.use((req, _res, next) => { req.ip_raw = req.ip; next(); });
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
// admin dashboard (data is behind ADMIN_TOKEN; the page itself is static)
app.use('/admin', express.static(fileURLToPath(new URL('../../admin', import.meta.url)), { maxAge: 0 }));
// widget files for the one-line embed (<script src=".../widget/embed.js">); any origin may load them
app.use('/widget', express.static(process.env.WIDGET_DIR || fileURLToPath(new URL('../../widget', import.meta.url)), { maxAge: '1h' }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'server_error' }); });

// idempotent schema upgrade so new columns/tables exist without a manual migrate
await exec(fs.readFileSync(fileURLToPath(new URL('../sql/schema.sql', import.meta.url)), 'utf8'));
await backfillGolden().catch((e) => console.error('approved-answer backfill', e.message));

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
  server.close();
  try { await pool.end(); } catch (e) { console.error('db close failed:', e.message); }
  process.exit(code);
}
onStop(shutdown); // signals, dev reloads and runner exit all arrive through lifecycle.js
