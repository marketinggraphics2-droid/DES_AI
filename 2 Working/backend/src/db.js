// Database adapter: real Postgres (pg) in production, or embedded PGlite (Postgres-in-WASM with pgvector)
// when DATABASE_URL starts with "pglite:" — zero-install local dev. Same `q()` / `withTx()` API for both.
import crypto from 'node:crypto';
import { cfg } from './config.js';

let backend;
if (cfg.databaseUrl.startsWith('pglite:')) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite/vector');
  const dir = cfg.databaseUrl.slice('pglite:'.length) || './data/pglite';
  (await import('node:fs')).mkdirSync(dir, { recursive: true });
  const db = await PGlite.create(dir, { extensions: { vector } });
  const norm = (r) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows.length });
  backend = {
    kind: 'pglite',
    query: async (text, params) => norm(await db.query(text, params)),
    exec: (sql) => db.exec(sql),
    withTx: (fn) => db.transaction(async (tx) => fn({ query: async (t, p) => norm(await tx.query(t, p)) })),
    end: () => db.close(),
  };
} else {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 10 });
  backend = {
    kind: 'pg',
    query: (text, params) => pool.query(text, params),
    exec: (sql) => pool.query(sql),
    withTx: async (fn) => { const c = await pool.connect(); try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } },
    end: () => pool.end(),
  };
}

export const q = backend.query;
export const exec = backend.exec;
export const withTx = backend.withTx;
export const pool = { end: backend.end, kind: backend.kind };

// ---- PII helpers ----
const key = cfg.piiKey ? Buffer.from(cfg.piiKey, 'base64') : null;
export function encrypt(plain) {
  if (!plain) return null;
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
export function decrypt(v) {
  if (!v || !v.startsWith('enc:')) return v;
  if (!key) return '[encrypted]';
  const [, iv, tag, data] = v.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
export const hmac = (v) => crypto.createHmac('sha256', cfg.jwtSecret).update(String(v).toLowerCase()).digest('hex').slice(0, 32);

// ---- rate limiting (sliding window on rate_events) ----
export async function hit(bucket, kind) { await q('insert into rate_events(bucket,kind) values($1,$2)', [bucket, kind]); }
export async function count(bucket, kind, windowSec) {
  const r = await q(`select count(*)::int c from rate_events where bucket=$1 and kind=$2 and at > now() - make_interval(secs => $3)`, [bucket, kind, windowSec]);
  return r.rows[0].c;
}
export async function isBlocked(...keys) {
  const r = await q('select 1 from blocked where key = any($1::text[]) limit 1', [keys]);
  return r.rows.length > 0;
}

// ---- cost meter ----
export async function addUsage(tokensIn, tokensOut, cacheRead) {
  const cost = (tokensIn * cfg.price.in + tokensOut * cfg.price.out + (cacheRead || 0) * cfg.price.cacheRead) / 1e6;
  await q(`insert into usage_daily(day,requests,tokens_in,tokens_out,cost_usd) values(current_date,1,$1,$2,$3)
           on conflict(day) do update set requests=usage_daily.requests+1, tokens_in=usage_daily.tokens_in+$1, tokens_out=usage_daily.tokens_out+$2, cost_usd=usage_daily.cost_usd+$3`, [tokensIn, tokensOut, cost]);
  return cost;
}
export async function budgetState() {
  const r = await q('select cost_usd from usage_daily where day=current_date');
  const spent = Number(r.rows[0]?.cost_usd || 0);
  return { spent, budget: cfg.dailyBudgetUsd, ratio: cfg.dailyBudgetUsd ? spent / cfg.dailyBudgetUsd : 0 };
}
