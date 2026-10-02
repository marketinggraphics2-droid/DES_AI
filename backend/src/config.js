import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const cfg = {
  port: num(process.env.PORT, 8787),
  env: process.env.NODE_ENV || 'development',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  websiteUrl: (process.env.WEBSITE_URL || '').replace(/\/$/, ''),
  allowedOrigins: [...list(process.env.ALLOWED_ORIGINS), ...list(process.env.WEBSITE_URL).map((u) => new URL(u).origin)],
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  adminToken: process.env.ADMIN_TOKEN || '',
  // admin dashboard + admin API answer only on this computer (localhost); add public IPs here to allow remote admins
  adminAllowedIps: list(process.env.ADMIN_ALLOWED_IPS),
  databaseUrl: process.env.DATABASE_URL || 'postgres://des:des@localhost:5433/des',

  // IQGateway (OpenAI-compatible). The key is bound to one client + one product wallet.
  gateway: {
    url: (process.env.IQ_GATEWAY_URL || 'https://iqlicense.dynamiqes.com/v1').replace(/\/$/, ''),
    key: process.env.IQ_GATEWAY_KEY || '',
    provider: process.env.IQ_GATEWAY_PROVIDER || '', // blank = infer from model name (claude-* / gpt-* / gemini-*)
    anthropicCache: process.env.IQ_GATEWAY_ANTHROPIC_CACHE !== 'false',
    timeoutMs: num(process.env.IQ_GATEWAY_TIMEOUT_MS, 60000),
  },
  model: process.env.MODEL || 'gemini-3.5-flash-lite',
  guardModel: process.env.GUARD_MODEL || 'gemini-3.5-flash-lite',
  effort: process.env.EFFORT || 'low',
  // Gemini 3.x via IQGateway: the gateway's default thinking setting is rejected by 3.5 Flash-Lite, so we send a level.
  geminiThinkingLevel: process.env.GEMINI_THINKING_LEVEL || 'minimal', // minimal | low | medium | high
  chatStrikesMax: num(process.env.CHAT_STRIKES_MAX, 3),        // off-topic / abusive messages before the chat is ended
  chatBanHours: num(process.env.CHAT_BAN_HOURS, 24),             // how long an ended chat blocks that device / visitor / contact
  chatBanIpHours: num(process.env.CHAT_BAN_IP_HOURS, 1),           // shorter for the internet connection: an office shares one
  chatLlmScreen: process.env.CHAT_LLM_SCREEN !== 'false',        // small-model topic screen on every message
  maxOutputTokens: num(process.env.MAX_OUTPUT_TOKENS, 600),
  dailyBudgetUsd: num(process.env.DAILY_BUDGET_USD, 20),
  // Fallback $/1M tokens for the cost meter, used only when IQGateway's x_gateway cost is missing
  price: { in: 0.1, out: 0.4, cacheRead: 0.025 }, // fallback only; normally the gateway's x_gateway.costUSD is used. Check gemini-3.5-flash-lite pricing

  // approved answers: minimum match score (0-1) between the visitor question and a saved question / variation
  goldenMinScore: num(process.env.GOLDEN_MIN_SCORE, 0.5),
  goldenMinSim: num(process.env.GOLDEN_MIN_SIM, 0.6), // vector similarity, used only with EMBEDDINGS_PROVIDER=voyage

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
  scrapeDir: process.env.SCRAPE_DIR || '../reference/website-scrape-2026-10-01',

  consentVersion: process.env.CONSENT_VERSION || '2026-10-01',
  retentionMonths: num(process.env.RETENTION_MONTHS, 12),
  piiKey: process.env.PII_ENCRYPTION_KEY || '',
};

export const isMock = () => !cfg.gateway.key;
