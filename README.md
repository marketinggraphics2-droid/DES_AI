---
kind: job
owner: Mark Jagonoy Sagaad
updated: 2026-10-01
path: JOB/Website/Website Chatbot
---
# Website Chatbot

Chatbot **DES** for the DynamIQ website: widget UI, avatar/mascot, conversation copy.

| Folder | What goes here |
|---|---|
| `1 Assets/` | brief, references, brand colours, logo, mascot files |
| `2 Working/` | UI mockups, widget sources, scripts/flows, prototypes |
| `3 Waiting Approval/` | previews and drafts for sign-off |
| `4 Approved/` | final approved designs and exports |
| `_superseded/` | replaced versions |

## Log
- 2026-10-01: scraped dynamiqes.com (71 pages + 194 blog URLs) into `1 Assets/Website Scrape 2026-10-01/` (`scrape.py` re-runs it); wrote `2 Working/system-instruction.md` (persona, rules, full knowledge base) for the chatbot.
- 2026-10-01: wrote `2 Working/architecture.md` (DigitalOcean + Postgres/pgvector design, auto re-ingest of products/blogs, lead export).
- 2026-10-01: copied the live chat-widget mockup from dynamiqes.com (theme v3.1.4 `template-parts/chatbot.php` + `.dq-chat` CSS) into `1 Assets/Live Chat Widget 2026-10-01/` — open `index.html` or run launch config `chat-widget-preview` (port 8766).
- 2026-10-01: built `3 Waiting Approval/Widget Prototype v1/` — working front-end (widget.js + widget.css on the live `.dq-chat` styles): in-chat onboarding (consent → name → contact → opt-in), mock answers, 👍/👎, end-of-chat survey, error → consultant fallback, returning-visitor memory, EN/FIL. Launch config `des-widget-prototype` (port 8767). Swap point for the real backend: `api.*` in widget.js.
- 2026-10-01: built `2 Working/backend/` — Express API + Postgres/pgvector (embedded PGlite for local dev, `pg` for DigitalOcean) + Claude (`claude-opus-5-5`, effort low, cached system prompt; MOCK mode without a key). Session/consent, SSE chat with guardrails + hybrid retrieval + tools (save_lead, book_demo, handoff_to_human, search_kb, get_open_jobs), feedback, handoff email, KB ingest (scrape seed, sitemap sweep, WP webhook), admin JSON endpoints + CSV/JSONL exports, retention job. `scripts/smoke.js` = 19/19 passing. Widget prototype talks to it via `?api=http://localhost:8787/api`. See `backend/README.md`.

Related: `JOB/Website/Mascot UI Animation/` (robot mascot Lottie states, can serve as the chatbot avatar).
