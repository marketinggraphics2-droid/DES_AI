---
kind: job
owner: Mark Jagonoy Sagaad
updated: 2026-10-01
path: JOB/Website/Website Chatbot
---
# Website Chatbot

Chatbot **DES** for the DynamIQ website: widget UI, avatar/mascot, conversation copy.

| Folder | What's here |
|---|---|
| `backend/` | Express API + Postgres/pgvector + AI via IQGateway. Start here: `backend/README.md` |
| `admin/` | admin dashboard at http://localhost:8787/admin: activity, conversations, leads, per-product approved answers and notes, review queue, website pages, facts |
| `widget/` | front-end chat widget prototype (widget.js + widget.css) |
| `docs/` | `architecture.md`, `system-instruction.md` (persona, rules, knowledge base) |
| `reference/` | website scrape (KB source, `scrape.py`) and the copied live chat-widget mockup |
| `exports/` | zipped copies for sharing |

## Run locally

```bash
cd backend
npm install        # first time only
npm run dev        # http://localhost:8787/api/health
```

Open `widget/index.html?api=http://localhost:8787/api`. Without `IQ_GATEWAY_KEY` in `backend/.env` it runs in MOCK mode.

## Log
- 2026-10-01: scraped dynamiqes.com (71 pages + 194 blog URLs) into `reference/website-scrape-2026-10-01/` (`scrape.py` re-runs it); wrote `docs/system-instruction.md` (persona, rules, full knowledge base) for the chatbot.
- 2026-10-01: wrote `docs/architecture.md` (DigitalOcean + Postgres/pgvector design, auto re-ingest of products/blogs, lead export).
- 2026-10-01: copied the live chat-widget mockup from dynamiqes.com (theme v3.1.4 `template-parts/chatbot.php` + `.dq-chat` CSS) into `reference/live-chat-widget-2026-10-01/` — open `index.html` or run launch config `chat-widget-preview` (port 8766).
- 2026-10-01: built `widget/` — working front-end (widget.js + widget.css on the live `.dq-chat` styles): in-chat onboarding (consent → name → contact → opt-in), mock answers, 👍/👎, end-of-chat survey, error → consultant fallback, returning-visitor memory, EN/FIL. Launch config `des-widget-prototype` (port 8767). Swap point for the real backend: `api.*` in widget.js.
- 2026-10-01: built `backend/` — Express API + Postgres/pgvector (embedded PGlite for local dev, `pg` for DigitalOcean) + Claude (`claude-opus-5-5`, effort low, cached system prompt; MOCK mode without a key). Session/consent, SSE chat with guardrails + hybrid retrieval + tools (save_lead, book_demo, handoff_to_human, search_kb, get_open_jobs), feedback, handoff email, KB ingest (scrape seed, sitemap sweep, WP webhook), admin JSON endpoints + CSV/JSONL exports, retention job. `scripts/smoke.js` = 19/19 passing. Widget prototype talks to it via `?api=http://localhost:8787/api`. See `backend/README.md`.
- 2026-10-01: restructured into a plain project layout (`backend/`, `widget/`, `docs/`, `reference/`, `exports/`); dropped the numbered approval folders and updated all path references.
- 2026-10-01: added `widget/embed.js` — one-line embed for WordPress (`<script src=".../widget/embed.js" data-api=".../api" defer>`); backend now serves `widget/` at `/widget`. Test page: `/widget/embed-test.html`.
- 2026-10-01: switched AI calls from the Anthropic SDK to IQGateway (`https://iqlicense.dynamiqes.com/v1`, OpenAI-compatible): streaming + tool calls, Claude effort/prompt caching via `provider_options`, cost meter from `x_gateway`, 402 out-of-credits → polite fallback. New env vars `IQ_GATEWAY_*`; `ANTHROPIC_API_KEY` removed. Local DB moved out of OneDrive (sync was corrupting it).
- 2026-10-01: AI now runs on Gemini only: `gemini-3.5-flash-lite` for chat and summaries, provider forced to `gemini`; tool schemas adapted to Gemini's format.
- 2026-10-01: first live run through IQGateway. `gemini-2.5-flash-lite` is retired for new Google accounts; now `gemini-3.5-flash-lite` with thinking level `minimal` (`GEMINI_THINKING_LEVEL`), which the gateway needs for 3.5. End-of-chat summary failures no longer crash the server.
- 2026-10-02: added the admin dashboard (`admin/`, served at `/admin`, login with `ADMIN_TOKEN`). Approved answers are now used live: matched per product on content words plus staff-written variations, injected as `<approved_answers>`; per-product notes injected as `<product_notes>`. Test box runs the real bot without saving. Fixed thumbs up/down never linking to the reply (review queue was always empty). Replaced the placeholder `ADMIN_TOKEN` with a random one.
- 2026-10-02: name + contact are now mandatory (closed the "skip after 3 tries" bypass). New `backend/src/contact.js` validates on the server: PH mobile/landline and international numbers incl. Viber/WhatsApp/WeChat/Telegram labels, emails (work vs personal, disposable and placeholder domains blocked, MX check), fake numbers (sequences, repeats), fake names, DynamIQ's own contacts. Widget mirrors the checks, asks once for a work email when a personal one is given, and locks the text box while DES is replying. Old contactless sessions are refused and re-onboarded.
- 2026-10-02: off-topic/abuse hardening after the "Im Yuu" chat: Filipino/Taglish insult and off-topic keywords, a small-model screen on every message (`CHAT_LLM_SCREEN`), long-form requests (essays, 4+ paragraphs, poems) treated as off-topic, standing scope rules appended to the system prompt in code, and 3 strikes (`CHAT_STRIKES_MAX`): redirect, warning, then the chat ends (status `ended`) and that visitor/contact can't start a new chat for 24 h. Names like "I'm Yuu" / "Ako si Juan" now save as the name only.
- 2026-10-02: ended-chat ban now follows the device (widget id), the connection (Cloudflare visitor IP) and the contact, for `CHAT_BAN_HOURS` (24). New contacts, incognito, resumes and old tokens can't start a conversation; the widget checks `GET /api/ban` on load and shows the notice with the end time, composer locked, no greeting. Local DB was corrupted again by `node --watch` hard-kills and rebuilt (test chats lost): `npm run dev` now uses `scripts/dev.js` (clean shutdown before each reload), and the PGlite DB is snapshotted on start, every 30 min and on stop (last 10, `npm run db:restore`).
- 2026-10-02: backend runs in the background with `npm run bg` / `npm run stop` (clean shutdown, log in `backend/logs/backend.log`); stop requests during startup are held until the database is open (`src/lifecycle.js`); duplicate Windows file events no longer cause double reloads. Connection-level ban shortened to `CHAT_BAN_IP_HOURS` (1 h) so one troll doesn't block a whole office; device/visitor/contact stay at `CHAT_BAN_HOURS` (24 h).
- 2026-10-02: onboarding heads-up + 5-min timeout (warning, then start over with an explanation). End-to-end test suite `npm test` in `backend/tests/` (own test backend + temp DB, real AI, widget and dashboard in jsdom): 229 checks passing. Fixed: "session expired" message was wiped by the reset.
- 2026-10-02: text box locked while a required button is on screen (consent, opt-in, survey, consultant choice, thumbs-down reasons + Skip); Settings card to lift bans; admin dashboard/API local-only (404 through the tunnel, `ADMIN_ALLOWED_IPS` for remote admins); chat API through the tunnel only from `ALLOWED_ORIGINS` and the embed stays hidden on other sites; chat pops open after 3 s once per session (`autoOpenMs`); per-device limit back to 5 new chats/day. Tests: 253 passing (`ONLY=…` runs chosen sections).

Related: `JOB/Website/Mascot UI Animation/` (robot mascot Lottie states, can serve as the chatbot avatar).
