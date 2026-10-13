# Production: how DES is deployed and how to update it

DES runs on a small DigitalOcean droplet. Visitors reach it at **https://des.dynamiqes.org** through a Cloudflare Tunnel, and the droplet itself only has SSH open to the internet.

> This repo is public. Keep secrets (keys, tokens, passwords) and the server IP out of it. Ask the project owner for the server address and SSH access.

## How it fits together

```
visitor's browser ──HTTPS──> Cloudflare (des.dynamiqes.org)
                                  │  tunnel (outbound from the droplet, no open web ports)
                                  ▼
droplet:  cloudflared (systemd) ──> 127.0.0.1:8787 ──> Docker: api (Node)  ──> Docker: db (Postgres + pgvector)
```

| What | Where |
|---|---|
| Code (git clone of this repo) | `/opt/des` |
| Secrets and settings | `/opt/des/backend/.env` (root only, never committed) |
| Server-only compose settings | `/opt/des/backend/docker-compose.override.yml` (not in git). It binds the API to localhost, gives the database no public port, uses the random DB password from `.env`, sets restart policies, and mounts `admin/` and `docs/` |
| Database data | Docker volume `backend_des-pg` |
| Tunnel | `cloudflared` systemd service, token-based. The hostname → `http://localhost:8787` mapping lives in the Cloudflare dashboard (Zero Trust → Networks → Tunnels) |
| Nightly jobs | `/etc/cron.d/des`: website re-ingest at 02:00 and data retention at 02:30 Manila time. Logs: `/var/log/des-ingest.log`, `/var/log/des-retention.log` |
| Firewall | `ufw`: only SSH allowed. nginx is installed but disabled; the tunnel replaced it |

### What gets baked in vs. mounted

- **`backend/`**: copied into the Docker image, so changes need a **rebuild** (`--build`).
- **`admin/`, `widget/`, `docs/`, `reference/website-scrape-*`**: mounted read-only from `/opt/des`, so a `git pull` is enough. The exception is `docs/system-instruction.md`, covered below.
- **Database schema**: `backend/sql/schema.sql` is idempotent and runs on every API start. New tables and columns appear by themselves; there's no separate migration step.

## Getting access

1. Send your **public** SSH key (`~/.ssh/id_ed25519.pub`) to the project owner. They add it to `/root/.ssh/authorized_keys` on the droplet.
2. `ssh root@<server-ip>`
3. If SSH times out, the droplet is up but your network is being cut off. This has happened from the office network after several connections in a row. Use the **DigitalOcean web console** instead: Droplet → Access → Launch Droplet Console.

## Updating production (the normal case)

Merge to `main` on GitHub first. Then, on the droplet:

```bash
cd /opt/des
git pull --ff-only                 # fails safely if someone edited files on the server, see Troubleshooting
cd backend
docker compose up -d --build       # rebuilds the API image and restarts it (~1 min), database untouched
docker compose logs api --tail 20  # look for "DES API on :8787 · IQGateway ..."
curl -s http://127.0.0.1:8787/api/health   # want {"ok":true,"mock":false,...}
```

Then check from your own browser:
- https://des.dynamiqes.org/widget/embed-test.html: the launcher appears bottom-right; send one real test message.
- https://des.dynamiqes.org/admin: the dashboard loads.

### Before a risky update (schema changes, big refactors): back up the database

```bash
cd /opt/des/backend
docker compose exec -T db pg_dump -U des des | gzip > /root/des-backup-$(date +%F-%H%M).sql.gz
```

### Rolling back

```bash
cd /opt/des
git log --oneline -10              # find the last good commit
git checkout <good-sha>            # detached HEAD is fine on the server
cd backend && docker compose up -d --build
# later, to go back to tracking main:  cd /opt/des && git checkout main && git pull --ff-only
```

To restore a backup (this **replaces** all data):
```bash
cd /opt/des/backend
gunzip -c /root/des-backup-XXXX.sql.gz | docker compose exec -T db psql -U des -d des
```

### Changed only the widget, the dashboard or docs?

- **`widget/` or `admin/`**: `git pull` is enough. Browsers and Cloudflare cache these files, though:
  - widget files for up to an hour. Bump `data-v="..."` in the embed code on the website to force a refresh.
  - the dashboard: press Ctrl+Shift+R. If Cloudflare's "Browser Cache TTL" isn't set to *Respect Existing Headers*, browsers can keep the old dashboard for 4 hours.
- **`docs/system-instruction.md` (the bot's persona and rules)**: it's only read **once**, the first time the database has no active instructions. After that the active version lives in the database. To change the bot's instructions, use **Dashboard → Settings → Bot instructions (advanced)** instead.

## Changing settings (`.env`)

```bash
nano /opt/des/backend/.env
cd /opt/des/backend && docker compose up -d     # "up -d" recreates the container; "restart" does NOT reload .env
```

Paste a secret without it ending up in shell history:
```bash
read -rsp "Value: " V; echo; sed -i "s|^IQ_GATEWAY_KEY=.*|IQ_GATEWAY_KEY=$V|" /opt/des/backend/.env; unset V
```

| Setting | What it does |
|---|---|
| `IQ_GATEWAY_KEY` | AI access through IQGateway. Empty = mock mode (canned answers) |
| `PUBLIC_URL` | `https://des.dynamiqes.org`. Used in the embed code the dashboard shows |
| `ALLOWED_ORIGINS` | Fixed list of websites allowed to show the chat. More sites can be added in **Dashboard → Settings → Website widget** without touching `.env` |
| `ADMIN_TOKEN` | Machine token for `npm run stop` only. People sign in with their own accounts: create the first one with `npm run user:create -- --role superuser --email …` (stop the backend first if it uses the embedded database) |
| `TRUST_PROXY` | `1` behind the DigitalOcean load balancer, so the real visitor IP is used; `loopback` with cloudflared on the same machine |
| `ADMIN_ALLOWED_IPS` | IPs that may open `/admin` (currently the office IP). Everyone else gets 404 |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | Optional: lets people signed in through Cloudflare Access open `/admin` from anywhere |
| `EMBEDDINGS_PROVIDER`, `VOYAGE_API_KEY` | `hash` = basic keyword search. `voyage` + key = better search; re-run the ingest after switching |
| `SMTP_*` | Consultant handoff emails. Empty = emails only appear in the API log |
| `TURNSTILE_SECRET` | Cloudflare bot check on "I agree". Empty = off |
| `DB_PASSWORD` | Random Postgres password, used by the override file. Don't change it after the first start; Postgres keeps the original |

## Common tasks

| Task | How |
|---|---|
| Allow the chat on a new website | Dashboard → Settings → Website widget → **+ Add website** |
| Get the embed code | Dashboard → Settings → Website widget → **Copy code** |
| Re-read the website now | `cd /opt/des/backend && docker compose exec -T api node scripts/ingest.js --sitemap` |
| Re-load the scrape in the repo | `docker compose exec -T api node scripts/ingest.js` |
| Logs | `docker compose logs api -f --tail 100` (in `/opt/des/backend`) |
| Restart | `docker compose restart api` |
| Lift chat bans | Dashboard → Settings → **Lift all bans** |
| Tunnel status | `systemctl status cloudflared` · `journalctl -u cloudflared -n 50` |

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Chat replies or a dashboard page fail with `server_error` | Run `docker compose logs api --tail 50`. An `ENOENT ... /docs/...` error means the `docs/` mount is missing from the compose files |
| Widget doesn't appear on a website | That site isn't allowed. The browser console shows `[DES] chat not enabled for this website`. Add it in Settings → Website widget. Pages opened as `file://` can never be allowed |
| `/admin` shows "Not found" | Your IP isn't in `ADMIN_ALLOWED_IPS` and you're not signed in through Cloudflare Access |
| Dashboard looks out of date after an update | Browser cache: press Ctrl+Shift+R |
| Site down, `https://des.dynamiqes.org` shows a Cloudflare 1033/502 error | Check `systemctl status cloudflared`, then `docker compose ps` (both containers should be `Up`) |
| `git pull` says local changes would be overwritten | Someone edited files on the server. `git status` shows which. If GitHub already has the change: `git fetch && git reset --hard origin/main`. This keeps `.env` and the override file, which git doesn't track |
| Bot gives canned answers | `IQ_GATEWAY_KEY` is empty or wrong. Health shows `"mock":true` |
| "Out of credits" style replies | The IQGateway product wallet is empty: top it up in IQLicense |
