import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { q, encrypt, decrypt, hmac, hit, count, isBlocked, budgetState } from './db.js';
import { search, glossaryHits, facts, detectProduct } from './retrieval.js';
import { stablePrompt, buildContext, invalidatePrompt } from './prompt.js';
import { answer, summarize } from './llm.js';
import { maskPII, injectionScore, classify, detectLang, filterOutput, CANNED, MAX_INPUT_CHARS } from './guardrails.js';
import { handoff } from './tools.js';
import { ingestUrl, sweepSitemap } from './ingest.js';

export const r = Router();
const ipHash = (req) => hmac((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, PH_MOBILE = /^(\+?63|0)9\d{9}$/;

function auth(req, res, next) {
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  try { req.session = jwt.verify(tok, cfg.jwtSecret); next(); } catch { res.status(401).json({ error: 'invalid_session' }); }
}
function admin(req, res, next) {
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (cfg.adminToken && tok === cfg.adminToken) return next();
  res.status(401).json({ error: 'admin_only' });
}
async function verifyTurnstile(token, ip) {
  if (!cfg.turnstileSecret) return true;
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: cfg.turnstileSecret, response: token, remoteip: ip }) });
  return (await r.json()).success === true;
}

// ---------- health ----------
r.get('/health', async (_req, res) => { const b = await budgetState(); res.json({ ok: true, mock: !cfg.anthropicKey, model: cfg.model, budget: b }); });

// ---------- session (after in-chat onboarding) ----------
r.post('/session', async (req, res) => {
  const { name, contact, consent, marketing_opt_in, lang, page_url, turnstile } = req.body || {};
  const ip = ipHash(req);
  if (await isBlocked('ip:' + ip)) return res.status(429).json({ error: 'blocked' });
  if (!(await verifyTurnstile(turnstile, req.ip))) return res.status(400).json({ error: 'turnstile_failed' });
  if (typeof name !== 'string' || !/^[\p{L} .'-]{2,60}$/u.test(name.trim())) return res.status(400).json({ error: 'bad_name' });
  if (!consent || consent.version !== cfg.consentVersion) return res.status(400).json({ error: 'consent_required', consent_version: cfg.consentVersion });

  let c = null, ctype = null;
  if (contact) {
    const s = String(contact).trim().replace(/[\s()-]/g, '');
    if (EMAIL.test(s)) { c = s.toLowerCase(); ctype = 'email'; }
    else if (PH_MOBILE.test(s)) { c = '+63' + s.replace(/^(\+?63|0)/, ''); ctype = 'mobile'; }
    else return res.status(400).json({ error: 'bad_contact' });
  }
  if ((await count('ip:' + ip, 'session', 86400)) >= cfg.rate.sessionsPerIpDay) return res.status(429).json({ error: 'too_many_sessions' });
  if (c && (await count('contact:' + hmac(c), 'session', 86400)) >= cfg.rate.sessionsPerContactDay) return res.status(429).json({ error: 'too_many_sessions' });

  const v = await q(`insert into visitors(name, contact, contact_hash, contact_type, consent_at, consent_version, consent_method, marketing_opt_in, lang, first_page_url, ip_hash)
                     values($1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10) returning id`,
    [name.trim(), encrypt(c), c ? hmac(c) : null, ctype, consent.version, consent.method || 'chip', !!marketing_opt_in, lang === 'fil' ? 'fil' : 'en', (page_url || '').slice(0, 500), ip]);
  const conv = await q('insert into conversations(visitor_id, lang) values($1,$2) returning id', [v.rows[0].id, lang === 'fil' ? 'fil' : 'en']);
  await hit('ip:' + ip, 'session'); if (c) await hit('contact:' + hmac(c), 'session');

  const token = jwt.sign({ vid: v.rows[0].id, cid: conv.rows[0].id, first: name.trim().split(/\s+/)[0] }, cfg.jwtSecret, { expiresIn: '2h' });
  res.json({ session_id: conv.rows[0].id, token, first_name: name.trim().split(/\s+/)[0] });
});

// returning visitor: new conversation, same visitor
r.post('/session/resume', auth, async (req, res) => {
  const conv = await q('insert into conversations(visitor_id, lang) values($1,$2) returning id', [req.session.vid, req.body?.lang === 'fil' ? 'fil' : 'en']);
  const token = jwt.sign({ vid: req.session.vid, cid: conv.rows[0].id, first: req.session.first }, cfg.jwtSecret, { expiresIn: '2h' });
  res.json({ session_id: conv.rows[0].id, token, first_name: req.session.first });
});

// ---------- chat (SSE) ----------
r.post('/chat', auth, async (req, res) => {
  const { cid, vid, first } = req.session;
  const raw = String(req.body?.message || '').trim();
  res.setHeader('content-type', 'text/event-stream'); res.setHeader('cache-control', 'no-cache'); res.flushHeaders();
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  const finish = async (text, { blocked = null, lang = 'en' } = {}) => {
    await q('insert into messages(conversation_id, role, content, blocked_reason) values($1,$2,$3,$4)', [cid, 'assistant', text, blocked]);
    send('done', { text, blocked, lang }); res.end();
  };

  try {
    const conv = (await q('select lang, turns, status from conversations where id=$1', [cid])).rows[0];
    if (!conv) { send('error', { code: 'no_conversation' }); return res.end(); }
    const lang = raw ? detectLang(raw) : conv.lang;
    const C = CANNED[lang] || CANNED.en;

    // input guardrails
    if (!raw) { send('error', { code: 'empty' }); return res.end(); }
    if (raw.length > MAX_INPUT_CHARS) { send('text', { delta: C.tooLong }); return finish(C.tooLong, { blocked: 'too_long', lang }); }
    if (await isBlocked('session:' + cid)) { send('error', { code: 'blocked' }); return res.end(); }
    if ((await count('session:' + cid, 'msg', 600)) >= cfg.rate.msgPer10Min || (await count('session:' + cid, 'msg', 86400)) >= cfg.rate.msgPerDay) { send('error', { code: 'rate_limited' }); return res.end(); }
    await hit('session:' + cid, 'msg');

    const { text: masked, hits: piiHits } = maskPII(raw);
    await q('insert into messages(conversation_id, role, content) values($1,$2,$3)', [cid, 'user', masked]);
    await q('update conversations set turns = turns + 1, lang = $2 where id=$1', [cid, lang]);

    if (conv.turns + 1 > cfg.rate.maxTurns) { await handoff({ conversationId: cid, visitorId: vid }, 'turn cap'); send('text', { delta: C.trouble }); return finish(C.trouble, { blocked: 'turn_cap', lang }); }
    if (injectionScore(masked) >= 1) {
      const n = (await count('session:' + cid, 'inj', 3600)) + 1; await hit('session:' + cid, 'inj');
      if (n >= 3) await q(`insert into blocked(key, reason) values($1,'injection x3') on conflict do nothing`, ['session:' + cid]);
      send('text', { delta: C.injection }); return finish(C.injection, { blocked: 'injection', lang });
    }
    const cls = classify(masked);
    if (cls === 'abuse') { send('text', { delta: C.abuse }); return finish(C.abuse, { blocked: 'abuse', lang }); }
    if (cls === 'support_request') { send('text', { delta: C.support }); return finish(C.support, { blocked: 'support', lang }); }
    if (cls === 'off_topic') { send('text', { delta: C.offtopic }); return finish(C.offtopic, { blocked: 'off_topic', lang }); }

    const budget = await budgetState();
    if (budget.ratio >= 1) { await handoff({ conversationId: cid, visitorId: vid }, 'budget exhausted'); send('text', { delta: C.budget }); return finish(C.budget, { blocked: 'budget', lang }); }

    // retrieval
    const product = detectProduct(masked);
    const [chunks, gl, f, system] = await Promise.all([search(masked, { k: 6, product }), glossaryHits(masked), facts(), stablePrompt()]);
    const context = buildContext({ facts: f, chunks, glossary: gl, lang, visitorName: first });
    const userTurn = `${context}\n<message>\n${masked}${piiHits ? '\n(Note: the visitor pasted sensitive numbers which were redacted; remind them gently not to share those here.)' : ''}\n</message>`;

    // history (last 10 turns, text only)
    const hist = (await q(`select role, content from messages where conversation_id=$1 and role in ('user','assistant') and blocked_reason is null order by id desc limit 21`, [cid])).rows.reverse();
    hist.pop(); // the message we just inserted is sent as userTurn
    const history = hist.map((m) => ({ role: m.role, content: m.content }));

    const ctx = { conversationId: cid, visitorId: vid };
    let streamed = '';
    const out = await answer({ system, history, userTurn, ctx, onText: (d) => { streamed += d; send('text', { delta: d }); }, onEvent: (ev) => send('event', ev) });

    // output guardrails
    const visitorContact = decrypt((await q('select contact from visitors where id=$1', [vid])).rows[0]?.contact) || '';
    let { text, reasons } = filterOutput(out.text, { systemPrompt: system, visitorContact });
    let blocked = null;
    if (reasons.includes('price')) { text = C.price; blocked = 'price'; }
    else if (reasons.length) { text = C.trouble; blocked = reasons.join(','); }
    if (blocked || text !== streamed) send('replace', { text });

    for (const t of out.toolCalls) await q('insert into messages(conversation_id, role, content, tool_name, tool_input, tool_output) values($1,$2,$3,$4,$5,$6)', [cid, 'tool', t.output?.slice(0, 2000) || '', t.name, t.input || null, { result: t.output?.slice(0, 2000) }]);
    await q('insert into messages(conversation_id, role, content, tokens_in, tokens_out, cache_read, blocked_reason) values($1,$2,$3,$4,$5,$6,$7)', [cid, 'assistant', text, out.usage.in, out.usage.out, out.usage.cache, blocked]);
    send('done', { text, blocked, lang, sources: chunks.slice(0, 3).map((c) => ({ title: c.title, url: c.url })) });
    res.end();
  } catch (e) {
    console.error('chat error', e);
    try { await handoff({ conversationId: cid, visitorId: vid }, 'system: ' + e.message); } catch { }
    send('error', { code: 'llm_error' }); res.end();
  }
});

// ---------- feedback / handoff / end ----------
r.post('/feedback', auth, async (req, res) => {
  const { kind, trigger, rating, thumb, reasons, comment, resolved, dismissed, message_id } = req.body || {};
  if (!['survey', 'thumb', 'thumb_reason'].includes(kind)) return res.status(400).json({ error: 'bad_kind' });
  await q(`insert into feedback(conversation_id, message_id, kind, trigger, rating, thumb, reasons, comment, resolved, dismissed) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [req.session.cid, Number.isInteger(message_id) ? message_id : null, kind, trigger || null, rating ?? null, thumb ?? null, Array.isArray(reasons) ? reasons.slice(0, 5) : null, comment ? maskPII(String(comment)).text.slice(0, 300) : null, resolved || null, !!dismissed]);
  res.json({ ok: true });
});
r.post('/handoff', auth, async (req, res) => {
  const h = await handoff({ conversationId: req.session.cid, visitorId: req.session.vid }, String(req.body?.reason || 'visitor').slice(0, 200));
  res.json({ ok: true, already: h.already });
});
r.post('/end', auth, async (req, res) => {
  const msgs = (await q(`select role, content from messages where conversation_id=$1 and role in ('user','assistant') order by id`, [req.session.cid])).rows;
  const summary = msgs.length ? await summarize(msgs.map((m) => `${m.role}: ${m.content}`).join('\n')) : null;
  await q(`update conversations set ended_at = now(), status = case when status='open' then 'closed' else status end, summary=$2 where id=$1`, [req.session.cid, summary]);
  res.json({ ok: true });
});

// ---------- knowledge base ingest ----------
r.post('/ingest/webhook', async (req, res) => {
  const sig = req.headers['x-des-signature'];
  const expected = crypto.createHmac('sha256', cfg.wpWebhookSecret).update(JSON.stringify(req.body || {})).digest('hex');
  if (!cfg.wpWebhookSecret || sig !== expected) return res.status(401).json({ error: 'bad_signature' });
  const { url, action } = req.body || {};
  if (!url || !url.startsWith(cfg.siteOrigin)) return res.status(400).json({ error: 'bad_url' });
  res.json({ accepted: true });
  ingestUrl(url, { action: action || 'update', source: 'webhook' }).catch((e) => console.error('webhook ingest', e));
});

// ---------- admin (temporary bearer token; replace with Google SSO) ----------
r.get('/admin/leads', admin, async (req, res) => {
  const rows = (await q(`select l.*, v.name, v.contact, v.contact_type, v.marketing_opt_in, c.summary, c.status as conv_status, c.started_at
                         from leads l join visitors v on v.id=l.visitor_id left join conversations c on c.id=l.conversation_id order by l.updated_at desc limit 500`)).rows;
  res.json(rows.map((x) => ({ ...x, contact: decrypt(x.contact) })));
});
r.get('/admin/conversations/:id', admin, async (req, res) => {
  const conv = (await q(`select c.*, v.name, v.contact, v.contact_type from conversations c join visitors v on v.id=c.visitor_id where c.id=$1`, [req.params.id])).rows[0];
  if (!conv) return res.status(404).end();
  const messages = (await q('select id, role, content, tool_name, tool_input, blocked_reason, tokens_in, tokens_out, created_at from messages where conversation_id=$1 order by id', [req.params.id])).rows;
  const feedback = (await q('select * from feedback where conversation_id=$1 order by id', [req.params.id])).rows;
  res.json({ ...conv, contact: decrypt(conv.contact), messages, feedback });
});
r.get('/admin/feedback/summary', admin, async (_req, res) => {
  const s = (await q(`select count(*) filter (where kind='survey' and not dismissed)::int surveys, round(avg(rating) filter (where kind='survey'),2) avg_rating,
                      count(*) filter (where resolved='yes')::int resolved_yes, count(*) filter (where resolved='partly')::int resolved_partly, count(*) filter (where resolved='no')::int resolved_no,
                      count(*) filter (where kind='thumb' and thumb=1)::int thumbs_up, count(*) filter (where kind='thumb' and thumb=-1)::int thumbs_down from feedback where created_at > now() - interval '30 days'`)).rows[0];
  const reasons = (await q(`select unnest(reasons) reason, count(*)::int n from feedback where created_at > now() - interval '30 days' group by 1 order by 2 desc`)).rows;
  const blocked = (await q(`select blocked_reason, count(*)::int n from messages where blocked_reason is not null and created_at > now() - interval '30 days' group by 1 order by 2 desc`)).rows;
  const usage = (await q(`select * from usage_daily order by day desc limit 30`)).rows;
  res.json({ ...s, reasons, blocked, usage });
});
r.get('/admin/review-queue', admin, async (_req, res) => {
  const rows = (await q(`select m.id message_id, m.conversation_id, m.content answer, f.reasons, f.rating, f.thumb,
                         (select content from messages u where u.conversation_id=m.conversation_id and u.role='user' and u.id < m.id order by u.id desc limit 1) question
                         from feedback f join messages m on m.id = f.message_id where (f.thumb = -1) and not exists (select 1 from golden_answers g where g.message_id = m.id)
                         order by f.created_at desc limit 100`)).rows;
  res.json(rows);
});
r.post('/admin/golden', admin, async (req, res) => {
  const { message_id, question, context, ideal_answer, product, reviewed_by } = req.body || {};
  if (!question || !ideal_answer) return res.status(400).json({ error: 'missing' });
  await q('insert into golden_answers(message_id, question, context, ideal_answer, product, reviewed_by) values($1,$2,$3,$4,$5,$6)', [message_id || null, question, context || null, ideal_answer, product || null, reviewed_by || null]);
  res.json({ ok: true });
});
r.get('/admin/export/finetune.jsonl', admin, async (_req, res) => {
  const sys = await stablePrompt();
  const rows = (await q('select question, context, ideal_answer from golden_answers order by id')).rows;
  res.setHeader('content-type', 'application/x-ndjson');
  for (const g of rows) res.write(JSON.stringify({ messages: [{ role: 'system', content: sys }, { role: 'user', content: `${g.context || ''}\n<message>\n${g.question}\n</message>` }, { role: 'assistant', content: g.ideal_answer }] }) + '\n');
  res.end();
});
r.get('/admin/export/leads.csv', admin, async (_req, res) => {
  const rows = (await q(`select l.created_at, v.name, v.contact, v.contact_type, l.company, l.industry, l.team_size, l.current_system, l.need, array_to_string(l.product_interest, '; ') products, l.demo_requested, l.status, v.marketing_opt_in, l.conversation_id
                         from leads l join visitors v on v.id=l.visitor_id order by l.created_at desc`)).rows;
  res.setHeader('content-type', 'text/csv'); res.setHeader('content-disposition', 'attachment; filename=des-leads.csv');
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.write(Object.keys(rows[0] || { created_at: 1 }).join(',') + '\n');
  for (const x of rows) res.write(Object.values({ ...x, contact: decrypt(x.contact) }).map(esc).join(',') + '\n');
  res.end();
});
r.post('/admin/ingest', admin, async (req, res) => { const url = req.body?.url; if (url) { res.json(await ingestUrl(url, { source: 'manual' })); } else { res.json({ started: true }); sweepSitemap().catch(console.error); } });
r.get('/admin/kb', admin, async (_req, res) => {
  const docs = (await q(`select d.id, d.url, d.title, d.kind, d.status, d.lastmod, d.updated_at, count(c.id)::int chunks from kb_documents d left join kb_chunks c on c.document_id=d.id group by d.id order by d.kind, d.title`)).rows;
  const log = (await q('select * from ingest_log order by id desc limit 50')).rows;
  res.json({ docs, log });
});
r.put('/admin/facts/:key', admin, async (req, res) => { await q('insert into facts(key,value) values($1,$2) on conflict(key) do update set value=excluded.value, updated_at=now()', [req.params.key, String(req.body?.value || '')]); res.json({ ok: true }); });
r.post('/admin/prompt', admin, async (req, res) => { await q('update system_prompts set active=false'); await q('insert into system_prompts(version,text,active) values($1,$2,true)', [req.body?.version || new Date().toISOString(), String(req.body?.text || '')]); invalidatePrompt(); res.json({ ok: true }); });
r.delete('/admin/visitors/:id', admin, async (req, res) => { await q('delete from visitors where id=$1', [req.params.id]); res.json({ ok: true }); }); // DPA erasure (cascades)
