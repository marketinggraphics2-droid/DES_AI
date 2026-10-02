# DES chat backend

Express + Postgres (pgvector) + AI through IQGateway. Implements `../docs/architecture.md` and serves the widget in `../widget`.

## Run locally (no accounts needed)

```bash
cp .env.example .env            # defaults = MOCK mode, hash embeddings
docker compose up -d db         # Postgres 16 + pgvector on :5433
npm install
npm run db:migrate
npm run ingest                  # seeds the KB from "reference/website-scrape-2026-10-01" (71 pages)
npm run dev                     # http://localhost:8787/api/health
```

Then open the widget prototype with `?api=http://localhost:8787/api` (or set `window.DES_CFG.apiBase`) — onboarding, chat, survey and handoff now hit the real API. In MOCK mode replies are built from retrieved chunks and prefixed `[MOCK]`.

Switch on the real model: set `IQ_GATEWAY_KEY` (a `gws_…` key from IQLicense → API keys, bound to this client + product wallet) (and `EMBEDDINGS_PROVIDER=voyage` + `VOYAGE_API_KEY` for proper retrieval), restart, re-run `npm run ingest` once so chunks are re-embedded.

## Admin dashboard

`http://localhost:8787/admin` (served from `../admin`). Sign in with `ADMIN_TOKEN` from `.env`.

- **Overview**: chats, questions, leads, handoffs, ratings, approved-answer use, AI cost, questions per day, product interest, activity feed.
- **Conversations / Leads**: transcripts with tool calls, guardrail changes and feedback; lead status; CSV export; visitor data erasure.
- **Fine-tune answers** (per product): approved answers (question, variations, answer, live toggle), product notes, visitor questions with 👍/👎, the product's website pages, and a test box (`POST /api/admin/test`, real model, no tools, nothing saved).
- **Needs review**: thumbs-down replies to turn into approved answers.
- **Website knowledge / Settings**: pause or re-read pages, facts, glossary, bot instructions.

How approved answers reach the model: each visitor message is matched against active `golden_answers` (same product or General) by content-word overlap (filler words and product names ignored, light stemming) across the question and its `variations`; matches at or above `GOLDEN_MIN_SCORE` (default 0.5) go into the user turn as `<approved_answers>`. With Voyage embeddings a vector similarity (`GOLDEN_MIN_SIM`) is also considered. `product_notes` for the detected product go in as `<product_notes>`. Both apply from the next message; no restart. The schema upgrade runs on server start.

## Local database safety

The local database (PGlite) is a folder of files and a hard kill can corrupt it.
- `npm run bg` starts the backend in the background (no window; log in `logs/backend.log`), `npm run stop` stops it cleanly. Use these for day-to-day running.
- `npm run dev` runs `scripts/dev.js`: it reloads on changes in `src/` and `sql/` but asks the server to shut down cleanly first. Stop it with Ctrl+C, never by closing the window or force-killing node.
- Snapshots go to `<db folder>-backups/` on start, every 30 minutes and on clean stop (last 10 kept).
- Restore: stop the backend, then `npm run db:restore` (newest) or `npm run db:restore -- <file>`. The current folder is kept as `.broken-<time>`.

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
| GET/POST/PUT/DELETE | `/api/admin/overview` · `/activity` · `/conversations` · `/conversations/:id/detail` · `/products` · `/products/:name` · `/products/:name/notes` · `/golden` · `/golden/:id` · `/match` · `/test` · `/kb/:id` · `/facts` · `/glossary` · `/prompt` · `/status` · `/leads/:id` | `ADMIN_TOKEN` | dashboard API (`src/admin.js`) |

## Request flow (`/api/chat`)

rate limit → PII mask → injection screen → regex topic classifier → budget check → hybrid retrieval (pgvector + tsvector, product filter) → system prompt (cached) + `<facts>/<kb>/<lang>` context → Claude with tools (`save_lead`, `book_demo`, `handoff_to_human`, `search_kb`, `get_open_jobs`) → output filters (price, claims, links, format, leak) → log + cost meter. Any exception → automatic handoff + `error` event; the widget shows "Connect to a consultant".

## Model (via IQGateway)

All AI calls go through IQGateway (`IQ_GATEWAY_URL`, default `https://iqlicense.dynamiqes.com/v1`), which speaks the OpenAI chat-completions API and routes by model name: `claude-*` → Anthropic, `gpt-*` → OpenAI, `gemini-*` → Gemini. Force a provider with `IQ_GATEWAY_PROVIDER`. The provider must be enabled under **AI providers** in IQLicense, or calls fail with 500.

- `MODEL=gemini-3.5-flash-lite` for chat and `GUARD_MODEL=gemini-3.5-flash-lite` for summaries / the optional classifier, with `IQ_GATEWAY_PROVIDER=gemini`. Gemini must be enabled under **AI providers** in IQLicense. Google no longer serves `gemini-2.5-flash-lite` to new accounts. Gemini 3.x models are sent `GEMINI_THINKING_LEVEL` (default `minimal`) via `provider_options`, because 3.5 Flash-Lite rejects the gateway's default thinking setting.
- Tool schemas are reduced to Gemini's OpenAPI subset before sending (nullable instead of type arrays, no `additionalProperties` / `maxLength`, no empty parameter objects).
- Claude models: `EFFORT` is sent as `output_config.effort` and the system prompt is cached (`cache_control`), both via the gateway's `provider_options`. Turn caching off with `IQ_GATEWAY_ANTHROPIC_CACHE=false`. GPT-5 / o-series get `reasoning_effort`.
- Tools are sent as OpenAI function tools; the gateway translates them for Anthropic/Gemini, including in the stream.
- Cost meter: uses the USD cost in each response's `x_gateway` object; falls back to `cfg.price` token rates if it is missing. The bot drops to lead-form mode at `DAILY_BUDGET_USD`.
- Gateway `402` (wallet out of credits or daily cap reached) shows the same polite "taking a short break" message and hands off to Sales. Top up the product wallet on the client's page in IQLicense.
- Embeddings are not routed through the gateway (it has no documented embeddings endpoint): keep `EMBEDDINGS_PROVIDER=hash` for dev or `voyage` in production.

## Jobs

- `npm run ingest:sitemap` — nightly sweep (DO App Platform scheduled job or cron)
- `npm run retention` — nightly DPA retention
- WordPress: a tiny plugin / WP Webhooks posting `{url, action}` to `/api/ingest/webhook` signed with `WP_WEBHOOK_SECRET` (HMAC-SHA256 of the JSON body, hex, header `x-des-signature`).

## Not done yet

Google SSO on `/admin` (bearer token for now), admin UI pages, Turnstile widget key wiring on the front end, Teams/Viber handoff webhook, production Dockerfile hardening, tests.
