// Share links: one conversation as a read-only page someone can open without signing in (e.g. a manager).
// The link carries a random 256-bit token (only its hash is stored), expires (24 h / 7 days / 30 days), can be revoked,
// and every creation, view and revocation is in the audit log. GET /share/:token is the only public addition: no
// scripts, noindex, no caching, no referrer.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { cfg } from './config.js';
import { q, decrypt, hmac, hit, count } from './db.js';
import { audit } from './auth.js';
import { shareSummary } from './llm.js';

const TTL = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, ...(cfg.testHooks ? { 'test-2s': 2 } : {}) }; // seconds
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const linkBase = (req) => cfg.publicUrl || `${req.protocol}://${req.get('host')}`;

export const shareAdmin = Router();
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

/** POST /api/admin/conversations/:id/share {ttl} → {url, expires_at}. The URL is shown once. */
shareAdmin.post('/conversations/:id/share', wrap(async (req, res) => {
  const c = (await q('select c.id, v.name from conversations c join visitors v on v.id = c.visitor_id where c.id = $1', [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ error: 'not_found' });
  const ttl = TTL[req.body?.ttl] ? req.body.ttl : '7d';
  const summary = await buildSummary(c.id).catch((e) => { console.error('share summary', e.message); return null; });
  const token = crypto.randomBytes(32).toString('base64url');
  const row = (await q(`insert into share_links(token_hash, conversation_id, created_by, created_by_email, expires_at, summary)
                        values($1, $2, $3, $4, now() + make_interval(secs => $5), $6) returning id, expires_at`,
    [sha(token), c.id, req.user.id, req.user.email, TTL[ttl], summary])).rows[0];
  await audit(req, 'share.created', c.id, { link_id: Number(row.id), ttl, visitor: c.name });
  res.json({ id: Number(row.id), url: `${linkBase(req)}/share/${token}`, expires_at: row.expires_at, ttl });
}));

/** GET /api/admin/shares[?conversation_id=] → active links: who created them, expiry, views. */
shareAdmin.get('/shares', wrap(async (req, res) => {
  const rows = (await q(`select s.id, s.conversation_id, s.created_by_email, s.created_at, s.expires_at, s.view_count, s.last_viewed_at, v.name
                         from share_links s join conversations c on c.id = s.conversation_id join visitors v on v.id = c.visitor_id
                         where s.revoked_at is null and s.expires_at > now() and ($1::uuid is null or s.conversation_id = $1)
                         order by s.created_at desc limit 200`, [req.query.conversation_id || null])).rows;
  res.json(rows.map((r) => ({ ...r, id: Number(r.id) })));
}));

/** DELETE /api/admin/shares/:id → the link stops working at once. */
shareAdmin.delete('/shares/:id', wrap(async (req, res) => {
  const r = (await q('update share_links set revoked_at = now(), revoked_by_email = $2 where id = $1 and revoked_at is null returning conversation_id', [req.params.id, req.user.email])).rows[0];
  if (!r) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'share.revoked', r.conversation_id, { link_id: Number(req.params.id) });
  res.json({ ok: true });
}));

/** 2–3 sentence summary for the shared page (AI), written once when the link is created. */
async function buildSummary(conversationId) {
  const msgs = (await q(`select role, content from messages where conversation_id = $1 and role in ('user', 'assistant') and kind = 'chat' order by seq, id`, [conversationId])).rows;
  if (!msgs.length) return null;
  return shareSummary(msgs.map((m) => `${m.role === 'user' ? 'Visitor' : 'DES'}: ${m.content}`).join('\n'));
}

// ---------------- the public page ----------------
const LOGO = (() => { try { return 'data:image/svg+xml;base64,' + fs.readFileSync(fileURLToPath(new URL('../../widget/IQ_Logo.svg', import.meta.url))).toString('base64'); } catch { return ''; } })();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Escape first, then the same light formatting as the dashboard: bold, italic, links, bullet / numbered lists. */
function fmt(raw) {
  const inline = (s) => esc(s).replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+?)(?=[.,!?;:]?(?:[\s)]|$))/g, '$1<a href="$2" rel="noopener noreferrer" target="_blank">$2</a>');
  const out = []; let list = null, para = [];
  const flush = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`); list = null; } };
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  for (const line of String(raw || '').split('\n')) {
    const ul = line.match(/^\s*[-*•]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) { flushPara(); const tag = ul ? 'ul' : 'ol'; if (!list || list.tag !== tag) { flush(); list = { tag, items: [] }; } list.items.push(inline((ul || ol)[1])); }
    else if (!line.trim()) { flush(); flushPara(); } else { flush(); para.push(inline(line)); }
  }
  flush(); flushPara(); return out.join('');
}
const when = (d) => new Date(d).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
const time = (d) => new Date(d).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });

const CSS = `:root{--brand:#F88F10;--brand-dark:#D97400;--ink:#252324;--ink-2:#4F5257;--ink-3:#8A8D91;--bg:#F5F4F2;--surface:#fff;--line:#E6E4E1;--soft:#FEF1E0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 Roboto,"Segoe UI",system-ui,sans-serif;-webkit-text-size-adjust:100%}
.bar{height:4px;background:var(--brand)}.wrap{max-width:760px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;align-items:center;gap:12px;margin-bottom:18px}header img{width:36px;height:36px}header b{display:block;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--brand-dark)}header span{font-size:13px;color:var(--ink-3)}
h1{font-size:24px;margin:0 0 4px}.sub{color:var(--ink-3);font-size:13px;margin:0 0 18px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:16px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}dt{color:var(--ink-3);font-size:13px}dd{margin:0;word-break:break-word}
.tags span{display:inline-block;background:var(--soft);color:#8A4A00;border-radius:99px;padding:1px 10px;font-size:12px;font-weight:600;margin:0 4px 4px 0}
h2{font-size:15px;margin:0 0 10px}.summary{white-space:pre-wrap}
.thread{display:grid;gap:10px}.m{max-width:88%}.m p{margin:0 0 6px}.m p:last-child{margin:0}.m ul,.m ol{margin:0 0 6px;padding-left:18px}
.b{padding:10px 13px;border-radius:4px 14px 14px 14px;background:var(--surface);border:1px solid var(--line)}.u{justify-self:end}.u .b{background:var(--ink);color:#fff;border:0;border-radius:14px 4px 14px 14px}.u .b a{color:#fff}
.s .b{background:#FBFAF8;color:var(--ink-2);border-style:dashed}.e{justify-self:center;font-size:12px;color:var(--ink-3);background:#EFEDEA;border-radius:99px;padding:3px 12px}
.t{font-size:11px;color:var(--ink-3);margin-top:3px}.u .t{text-align:right}a{color:var(--brand-dark)}
footer{margin-top:24px;font-size:12px;color:var(--ink-3)}@media(max-width:520px){dl{grid-template-columns:1fr}dt{margin-top:6px}}`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="bar"></div><div class="wrap"><header>${LOGO ? `<img src="${LOGO}" alt="">` : ''}<div><b>DynamIQ</b><span>DES website assistant · shared conversation</span></div></header>${body}</div></body></html>`;
}
function headers(res) {
  res.set({
    'Cache-Control': 'no-store, private', Pragma: 'no-cache', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  });
}
const gone = (res, status) => { headers(res); res.status(status).type('html').send(page('Link not available', `<div class="card"><h1>This link is no longer available</h1><p class="sub">Ask the person who sent it for a new one.</p></div>`)); };

/** GET /share/:token — public, rate-limited per connection. */
export async function sharePage(req, res, next) {
  try {
    const ipKey = 'share:' + hmac(String(req.headers['cf-connecting-ip'] || req.ip || ''));
    if ((await count(ipKey, 'view', 600)) >= 60) { headers(res); return res.status(429).type('text/plain').send('Too many requests'); }
    await hit(ipKey, 'view');
    const token = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return gone(res, 404);
    const link = (await q('select * from share_links where token_hash = $1', [sha(token)])).rows[0];
    if (!link) return gone(res, 404);
    if (link.revoked_at || new Date(link.expires_at) < new Date()) return gone(res, 410);
    await q('update share_links set view_count = view_count + 1, last_viewed_at = now() where id = $1', [link.id]);
    await audit(Object.assign(req, { adminIp: String(req.headers['cf-connecting-ip'] || req.ip || '') }), 'share.viewed', link.conversation_id, { link_id: Number(link.id) }, null);
    const c = (await q(`select c.started_at, c.status, c.summary, v.name, v.phone, v.phone_type, v.email, l.company, l.industry, l.team_size, l.current_system, l.need, l.product_interest, l.demo_requested
                        from conversations c join visitors v on v.id = c.visitor_id left join leads l on l.conversation_id = c.id where c.id = $1`, [link.conversation_id])).rows[0];
    if (!c) return gone(res, 410); // visitor data was deleted
    const msgs = (await q(`select role, kind, content, created_at, tool_name from messages where conversation_id = $1 order by seq, id`, [link.conversation_id])).rows;
    const phone = decrypt(c.phone), email = decrypt(c.email);
    const row = (k, v) => (v ? `<dt>${esc(k)}</dt><dd>${v}</dd>` : '');
    const thread = msgs.map((m) => {
      if (m.role === 'tool') return m.tool_name === 'handoff_to_human' || m.tool_name === 'book_demo' ? `<div class="e">Passed to Sales</div>` : '';
      if (m.role === 'system') return `<div class="e">${esc(m.content)}</div>`;
      const cls = (m.role === 'user' ? 'u' : 'a') + (m.kind === 'script' ? ' s' : '');
      return `<div class="m ${cls}"><div class="b">${m.role === 'user' ? esc(m.content).replace(/\n/g, '<br>') : fmt(m.content)}</div><div class="t">${m.role === 'user' ? esc(c.name.split(' ')[0]) : 'DES'} · ${time(m.created_at)}</div></div>`;
    }).join('');
    headers(res);
    res.type('html').send(page(`Conversation with ${c.name}`, `
<h1>${esc(c.name)}</h1><p class="sub">Chat started ${esc(when(c.started_at))} (Philippine time) · link expires ${esc(when(link.expires_at))}</p>
<div class="card"><dl>
${row('Mobile', phone ? `<a href="tel:${esc(phone)}">${esc(phone)}</a>${c.phone_type && c.phone_type !== 'mobile' ? ' · ' + esc(c.phone_type) : ''}` : '')}
${row('Email', email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : '')}
${row('Company', esc(c.company))}${row('Industry', esc(c.industry))}${row('Team size', esc(c.team_size))}${row('Current system', esc(c.current_system))}
${row('Interested in', (c.product_interest || []).length ? `<span class="tags">${c.product_interest.map((p) => `<span>${esc(p)}</span>`).join('')}</span>` : '')}
${row('Demo', c.demo_requested ? 'Requested' : '')}
</dl></div>
<div class="card"><h2>What they need</h2>${c.need ? `<p>${esc(c.need)}</p>` : ''}${link.summary ? `<p class="summary">${esc(link.summary)}</p>` : !c.need ? '<p class="sub">No summary yet.</p>' : ''}</div>
<div class="card"><h2>Conversation</h2><div class="thread">${thread || '<p class="sub">No messages.</p>'}</div></div>
<footer>Shared from the DES dashboard. Card, TIN and ID numbers in messages are hidden. Please don't forward this link.</footer>`));
  } catch (e) { next(e); }
}
