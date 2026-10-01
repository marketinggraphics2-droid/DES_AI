import express from 'express';
import cors from 'cors';
import { cfg, isMock } from './config.js';
import { r } from './routes.js';
import { pool } from './db.js';

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: (o, cb) => cb(null, !o || cfg.allowedOrigins.length === 0 || cfg.allowedOrigins.includes(o)), credentials: false }));
app.use(express.json({ limit: '32kb' }));
app.use((req, _res, next) => { req.ip_raw = req.ip; next(); });
app.use('/api', r);
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'server_error' }); });

const server = app.listen(cfg.port, () => {
  console.log(`DES API on :${cfg.port} · ${isMock() ? 'MOCK mode (no ANTHROPIC_API_KEY)' : 'model ' + cfg.model} · embeddings ${cfg.embeddings.provider}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(() => pool.end().then(() => process.exit(0))); });
