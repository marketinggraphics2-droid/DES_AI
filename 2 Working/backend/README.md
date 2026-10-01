# DES chat backend

Express + Postgres (pgvector) + Claude. Implements `../architecture.md` and serves the widget in `../../3 Waiting Approval/Widget Prototype v1`.

## Run locally (no accounts needed)

```bash
cp .env.example .env            # defaults = MOCK mode, hash embeddings
docker compose up -d db         # Postgres 16 + pgvector on :5433
npm install
npm run db:migrate
npm run ingest                  # seeds the KB from "1 Assets/Website Scrape 2026-10-01" (71 pages)
npm run dev                     # http://localhost:8787/api/health
```

Then open the widget prototype with `?api=http://localhost:8787/api` (or set `window.DES_CFG.apiBase`) — onboarding, chat, survey and handoff now hit the real API. In MOCK mode replies are built from retrieved chunks and prefixed `[MOCK]`.

Switch on the real model: set `ANTHROPIC_API_KEY` (and `EMBEDDINGS_PROVIDER=voyage` + `VOYAGE_API_KEY` for proper retrieval), restart, re-run `npm run ingest` once so chunks are re-embedded.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | – | status, mock flag, today's budget |
| POST | `/api/session` | Turnstile | after in-chat onboarding → `visitors` + `conversations`, returns JWT (2 h) |
| POST | `/api/session/resume` | JWT | returning visitor → new conversation |
| POST | `/api/chat` | JWT | SSE: `text` deltas, `event` (lead / handoff), `replace` (guardrail swapped the reply), `done`, `error` |
| POST | `/api/feedback` | JWT | survey / thumbs |
| POST | `/api/handoff` | JWT | visitor-initiated "Connect to a consultant" |
| POST | `/api/end` | JWT | close + one-line summary |
| POST | `/api/ingest/webhook` | HMAC `x-des-signature` | WordPress publish/update/trash → re-ingest one URL |
| GET | `/api/admin/leads` · `/admin/conversations/:id` · `/admin/feedback/summary` · `/admin/review-queue` · `/admin/kb` | `ADMIN_TOKEN` | admin data |
| POST | `/api/admin/golden` · `/admin/ingest` · `/admin/prompt` · PUT `/admin/facts/:key` · DELETE `/admin/visitors/:id` | `ADMIN_TOKEN` | review queue, re-ingest, prompt version, facts, DPA erasure |
| GET | `/api/admin/export/leads.csv` · `/admin/export/finetune.jsonl` | `ADMIN_TOKEN` | exports |

## Request flow (`/api/chat`)

rate limit → PII mask → injection screen → regex topic classifier → budget check → hybrid retrieval (pgvector + tsvector, product filter) → system prompt (cached) + `<facts>/<kb>/<lang>` context → Claude with tools (`save_lead`, `book_demo`, `handoff_to_human`, `search_kb`, `get_open_jobs`) → output filters (price, claims, links, format, leak) → log + cost meter. Any exception → automatic handoff + `error` event; the widget shows "Connect to a consultant".

## Model

`MODEL=claude-opus-5-5` with `output_config.effort=low` (right for short chat answers), system prompt cached (`cache_control` 5-min TTL, ~90 % cheaper on repeats), `max_tokens` 600. `GUARD_MODEL=claude-haiku-4-5` for summaries / optional classifier. Cost meter uses $4/$20 per MTok; the bot drops to lead-form mode at `DAILY_BUDGET_USD`. Set a hard spend limit on the Anthropic console too.

## Jobs

- `npm run ingest:sitemap` — nightly sweep (DO App Platform scheduled job or cron)
- `npm run retention` — nightly DPA retention
- WordPress: a tiny plugin / WP Webhooks posting `{url, action}` to `/api/ingest/webhook` signed with `WP_WEBHOOK_SECRET` (HMAC-SHA256 of the JSON body, hex, header `x-des-signature`).

## Not done yet

Google SSO on `/admin` (bearer token for now), admin UI pages, Turnstile widget key wiring on the front end, Teams/Viber handoff webhook, production Dockerfile hardening, tests.
