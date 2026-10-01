import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const cfg = {
  port: num(process.env.PORT, 8787),
  env: process.env.NODE_ENV || 'development',
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  adminToken: process.env.ADMIN_TOKEN || '',
  databaseUrl: process.env.DATABASE_URL || 'postgres://des:des@localhost:5433/des',

  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.MODEL || 'claude-opus-5-5',
  guardModel: process.env.GUARD_MODEL || 'claude-haiku-4-5',
  effort: process.env.EFFORT || 'low',
  maxOutputTokens: num(process.env.MAX_OUTPUT_TOKENS, 600),
  dailyBudgetUsd: num(process.env.DAILY_BUDGET_USD, 20),
  // $/1M tokens for the cost meter (claude-opus-5-5: $4 in / $20 out / $0.20 cache read)
  price: { in: 4, out: 20, cacheRead: 0.2 },

  embeddings: {
    provider: process.env.EMBEDDINGS_PROVIDER || 'hash',
    voyageKey: process.env.VOYAGE_API_KEY || '',
    voyageModel: process.env.VOYAGE_MODEL || 'voyage-3-lite',
    dim: num(process.env.EMBEDDING_DIM, 1024),
  },

  turnstileSecret: process.env.TURNSTILE_SECRET || '',
  rate: {
    msgPer10Min: num(process.env.RATE_MSG_PER_10MIN, 30),
    msgPerDay: num(process.env.RATE_MSG_PER_DAY, 80),
    sessionsPerIpDay: num(process.env.RATE_SESSIONS_PER_IP_DAY, 5),
    sessionsPerContactDay: num(process.env.RATE_SESSIONS_PER_CONTACT_DAY, 3),
    maxTurns: num(process.env.MAX_TURNS_PER_CONVERSATION, 40),
  },

  salesEmail: process.env.SALES_EMAIL || 'sales@dynamiqes.com',
  smtp: { host: process.env.SMTP_HOST || '', port: num(process.env.SMTP_PORT, 587), user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '' },
  mailFrom: process.env.MAIL_FROM || 'DES <no-reply@dynamiqes.com>',

  siteOrigin: process.env.SITE_ORIGIN || 'https://dynamiqes.com',
  sitemapUrl: process.env.SITEMAP_URL || 'https://dynamiqes.com/sitemap_index.xml',
  wpWebhookSecret: process.env.WP_WEBHOOK_SECRET || '',
  scrapeDir: process.env.SCRAPE_DIR || '../../1 Assets/Website Scrape 2026-10-01',

  consentVersion: process.env.CONSENT_VERSION || '2026-10-01',
  retentionMonths: num(process.env.RETENTION_MONTHS, 12),
  piiKey: process.env.PII_ENCRYPTION_KEY || '',
};

export const isMock = () => !cfg.anthropicKey;
