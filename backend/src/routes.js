import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { cfg, isMock } from './config.js';
import { q, encrypt, decrypt, hmac, hit, count, isBlocked, budgetState } from './db.js';
import { search, glossaryHits, facts, detectProduct, goldenMatches, productNotes, needsKb, isSmallTalk, foundEarlier } from './retrieval.js';
import { stablePrompt, buildContext, invalidatePrompt } from './prompt.js';
import { answer, summarize, classifyLLM } from './llm.js';
import { maskPII, injectionScore, classify, detectLang, filterOutput, CANNED, MAX_INPUT_CHARS } from './guardrails.js';
import { handoff } from './tools.js';
import { validateName, validatePhone, validateEmail } from './contact.js';
import { ingestUrl, sweepSitemap } from './ingest.js';
import { addMessage, serialize, maskWidgetText } from './log.js';
import { audit } from './auth.js';

export const r = Router();
// real visitor address: Cloudflare's header first (the tunnel / proxy sets it), then X-Forwarded-For, then the socket
const ipHash = (req) => hmac((req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim());
// random id the widget keeps in localStorage and sends on every call (x-des-device)
const deviceId = (req) => { const d = String(req.headers['x-des-device'] || ''); return /^[a-z0-9-]{16,64}$/i.test(d) ? d : null; };

// ---- ban after a chat is ended for repeated off-topic / abuse ----
// Stored as rate_events(kind='ended') on every identity we have; any one of them blocks new chats until it expires.
const banKeys = (req, { vid = null, phoneHash = null, emailHash = null } = {}) => [
  'ip:' + ipHash(req), deviceId(req) && 'device:' + deviceId(req), vid && 'visitor:' + vid, phoneHash && 'contact:' + phoneHash, emailHash && 'contact:' + emailHash,
].filter(Boolean);
const banHours = (bucket) => (bucket.startsWith('ip:') ? cfg.chatBanIpHours : cfg.chatBanHours);
/** Latest expiry across the given identities (device / visitor / contact: CHAT_BAN_HOURS, connection: CHAT_BAN_IP_HOURS), or null. */
async function banUntil(keys) {
  if (!keys.length) return null;
  const r = await q(`select bucket, max(at) last from rate_events where kind='ended' and bucket = any($1::text[]) and at > now() - make_interval(hours => $2) group by bucket`,
    [keys, Math.max(cfg.chatBanHours, cfg.chatBanIpHours)]);
  let until = 0;
  for (const row of r.rows) until = Math.max(until, new Date(row.last).getTime() + banHours(row.bucket) * 3600e3);
  return until > Date.now() ? new Date(until).toISOString() : null;
}
async function banIdentity(keys) { for (const k of keys) await hit(k, 'ended'); }

// A token is only valid if its visitor (and, except for /session/resume, its conversation) still exist.
// Tokens outlive DB rebuilds and DPA erasures; without this check they hit foreign-key errors.
async function auth(req, res, next) {
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  let s;
  try { s = jwt.verify(tok, cfg.jwtSecret); } catch { return res.status(401).json({ error: 'invalid_session' }); }
  try {
    const v = await q('select phone from visitors where id=$1', [s.vid]);
    if (!v.rows.length) return res.status(401).json({ error: 'session_gone' });
    // a phone number is required to chat; visitors from before that rule add one first (POST /session/phone)
    if (!v.rows[0].phone && req.path !== '/session/phone') return res.status(401).json({ error: 'phone_required', first_name: s.first });
    if (!['/session/resume', '/session/phone'].includes(req.path)) {
      const c = await q('select 1 from conversations where id=$1 and visitor_id=$2', [s.cid, s.vid]);
      if (!c.rows.length) return res.status(401).json({ error: 'session_gone' });
    }
    req.session = s; next();
  } catch (e) { console.error('auth check failed', e.message); res.status(500).json({ error: 'server_error' }); }
}
// DynamIQ's own numbers / emails (company facts): refused as a visitor contact, left unmasked in logged bubbles
const normContact = (v) => String(v || '').toLowerCase().replace(/[^0-9a-z@.]/g, '').replace(/^0/, '63').replace(/^63/, '');
async function ownContacts() {
  const own = await facts();
  return ['sales_mobile', 'landline', 'hr_mobile', 'sales_email', 'hr_email', 'dpo_email'].map((k) => normContact(own[k])).filter(Boolean);
}
const isOwnContact = (value, own) => { const mine = normContact(value); return own.some((x) => x === mine || (x.length > 6 && mine.endsWith(x))); };
async function verifyTurnstile(token, ip) {
  if (!cfg.turnstileSecret) return true;
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: cfg.turnstileSecret, response: token, remoteip: ip }) });
  return (await r.json()).success === true;
}

// ---------- health ----------
r.get('/health', async (_req, res) => { const b = await budgetState(); res.json({ ok: true, mock: isMock(), gateway: cfg.gateway.url, model: cfg.model, budget: b }); });

// ---------- session (after in-chat onboarding) ----------
/** Is this device / connection paused after an ended chat? The widget checks this on load so a banned visitor never has to type. */
r.get('/ban', async (req, res) => {
  const until = await banUntil(banKeys(req));
  res.set('cache-control', 'no-store').json({ banned: !!until, until });
});

r.post('/session', async (req, res) => {
  const { name, consent, marketing_opt_in, lang, page_url, turnstile, transcript } = req.body || {};
  const phoneRaw = req.body?.phone ?? (req.body?.email == null ? req.body?.contact : null); // `contact`: widgets cached from before this change
  const ip = ipHash(req);
  if (await isBlocked('ip:' + ip)) return res.status(429).json({ error: 'blocked' });
  if (!(await verifyTurnstile(turnstile, req.ip))) return res.status(400).json({ error: 'turnstile_failed' });
  // name + mobile number are required before the AI; email is optional (the widget asks for it only in the demo / handoff form)
  const nm = validateName(name);
  if (!nm.ok) return res.status(400).json({ error: nm.code });
  if (!consent || consent.version !== cfg.consentVersion) return res.status(400).json({ error: 'consent_required', consent_version: cfg.consentVersion });
  const own = await ownContacts();
  const ph = await checkPhone(phoneRaw, req.body?.phone_type ?? req.body?.contact_type, own);
  if (!ph.ok) return res.status(400).json({ error: ph.code, field: 'phone' });
  const em = await validateEmail(req.body?.email);
  if (!em.ok) return res.status(400).json({ error: em.code, field: 'email' });
  if (em.value && isOwnContact(em.value, own)) return res.status(400).json({ error: 'own_email', field: 'email' });
  const phoneHash = hmac(ph.value), emailHash = em.value ? hmac(em.value) : null;
  const cleanName = nm.value;
  const sessionBan = await banUntil(banKeys(req, { phoneHash, emailHash }));
  if (sessionBan) return res.status(403).json({ error: 'chat_ended', until: sessionBan });
  if ((await count('ip:' + ip, 'session', 86400)) >= cfg.rate.sessionsPerIpDay) return res.status(429).json({ error: 'too_many_sessions' });
  for (const h of [phoneHash, emailHash].filter(Boolean)) if ((await count('contact:' + h, 'session', 86400)) >= cfg.rate.sessionsPerContactDay) return res.status(429).json({ error: 'too_many_sessions' });

  // contact / contact_hash / contact_type mirror the phone for older code paths and reports
  const [firstName, ...rest] = cleanName.split(' '); const lastName = rest.join(' ') || null; // one word: first name only
  const v = await q(`insert into visitors(name, first_name, last_name, phone, phone_hash, phone_type, email, email_hash, email_type, contact, contact_hash, contact_type,
                     consent_at, consent_version, consent_method, marketing_opt_in, lang, first_page_url, ip_hash, person_key)
                     values($1,$14,$15,$2,$3,$4,$5,$6,$7,$2,$3,$4,now(),$8,$9,$10,$11,$12,$13,$3) returning id`,
    [cleanName, encrypt(ph.value), phoneHash, ph.type, em.value ? encrypt(em.value) : null, emailHash, em.type, consent.version, consent.method || 'chip', !!marketing_opt_in, lang === 'fil' ? 'fil' : 'en', (page_url || '').slice(0, 500), ip, firstName, lastName]);
  const conv = await q('insert into conversations(visitor_id, lang) values($1,$2) returning id', [v.rows[0].id, lang === 'fil' ? 'fil' : 'en']);
  await hit('ip:' + ip, 'session'); for (const h of [phoneHash, emailHash].filter(Boolean)) await hit('contact:' + h, 'session');
  // what the visitor saw and typed before the session existed (greeting, sign-up), so the dashboard has the whole chat
  if (Array.isArray(transcript)) {
    const keep = await ownContacts();
    for (const it of transcript.slice(0, 40)) {
      const isHeld = it?.held === true && it?.role === 'user';
      const content = isHeld ? maskPII(String(it.content || '')).text.slice(0, 4000) : maskWidgetText(String(it?.content || '').slice(0, 1000), keep);
      if (content.trim()) await addMessage(conv.rows[0].id, { role: it?.role === 'user' ? 'user' : 'assistant', content, kind: isHeld ? 'chat' : 'script', source: 'widget', held: isHeld });
    }
  }

  const first = cleanName.split(/\s+/)[0];
  const token = jwt.sign({ vid: v.rows[0].id, cid: conv.rows[0].id, first }, cfg.jwtSecret, { expiresIn: '2h' });
  res.json({ session_id: conv.rows[0].id, token, first_name: first, last_name: lastName, name: cleanName, phone: ph.value, phone_type: ph.type, email: em.value, email_type: em.type });
});

/** Phone checks shared by sign-up and /session/phone. The widget sends the platform it saw ("viber: 0917…"); keep that label. */
async function checkPhone(raw, label, own) {
  const p = validatePhone(raw);
  if (!p.ok) return p;
  if (isOwnContact(p.value, own)) return { ok: false, code: 'own_phone' };
  const type = p.type === 'mobile' && ['viber', 'whatsapp', 'wechat', 'telegram', 'signal', 'line'].includes(label) ? label : p.type;
  return { ok: true, value: p.value, type };
}

// returning visitor from before phone numbers were required: add one, keep everything else
r.post('/session/phone', auth, async (req, res) => {
  const ph = await checkPhone(req.body?.phone, req.body?.phone_type, await ownContacts());
  if (!ph.ok) return res.status(400).json({ error: ph.code, field: 'phone' });
  const phoneHash = hmac(ph.value);
  const ban = await banUntil(banKeys(req, { vid: req.session.vid, phoneHash }));
  if (ban) return res.status(403).json({ error: 'chat_ended', until: ban });
  await q(`update visitors set phone=$2, phone_hash=$3, phone_type=$4, person_key=$3 where id=$1`, [req.session.vid, encrypt(ph.value), phoneHash, ph.type]);
  res.json({ ok: true, phone: ph.value, phone_type: ph.type });
});

// returning visitor: continue the recent conversation (same visit), or start a new one for the same visitor
r.post('/session/resume', auth, async (req, res) => {
  const resumeBan = await banUntil(banKeys(req, { vid: req.session.vid }));
  if (resumeBan) return res.status(403).json({ error: 'chat_ended', until: resumeBan });
  const last = (await q(`select id from conversations where visitor_id=$1 and status in ('open','handed_off')
                         and coalesce(last_activity_at, started_at) > now() - make_interval(mins => $2) order by started_at desc limit 1`, [req.session.vid, cfg.resumeWindowMin])).rows[0];
  const cid = last?.id || (await q('insert into conversations(visitor_id, lang) values($1,$2) returning id', [req.session.vid, req.body?.lang === 'fil' ? 'fil' : 'en'])).rows[0].id;
  const token = jwt.sign({ vid: req.session.vid, cid, first: req.session.first }, cfg.jwtSecret, { expiresIn: '2h' });
  res.json({ session_id: cid, token, first_name: req.session.first, continued: !!last });
});

// ---------- widget log: bubbles the browser showed that the server did not produce ----------
// Sign-up prompts, survey, handoff confirmation, error and timeout notices. Stored as kind='script' so they are
// visible in the dashboard but never sent to the AI. Contact details and card / ID numbers are masked.
r.post('/log', auth, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items || !items.length || items.length > 20) return res.status(400).json({ error: 'bad_items' });
  const cid = req.session.cid;
  if ((await count('session:' + cid, 'log', 600)) >= 120) return res.status(429).json({ error: 'rate_limited' });
  await hit('session:' + cid, 'log');
  const keep = await ownContacts();
  await serialize(cid, async () => {
    for (const it of items) {
      const role = it?.role === 'user' ? 'user' : 'assistant';
      const content = maskWidgetText(String(it?.content || '').slice(0, 1000), keep);
      if (content.trim()) await addMessage(cid, { role, content, kind: 'script', source: 'widget' });
    }
  });
  res.json({ ok: true });
});

// ---------- chat (SSE) ----------
r.post('/chat', auth, async (req, res) => {
  res.setHeader('content-type', 'text/event-stream'); res.setHeader('cache-control', 'no-cache'); res.flushHeaders();
  // the visitor closed the page / the widget gave up waiting: stop the AI call and remember the reply was not delivered
  const ac = new AbortController(); let gone = false;
  res.on('close', () => { if (!res.writableEnded) { gone = true; ac.abort(); } });
  await serialize(req.session.cid, () => chatTurn(req, res, ac, () => gone));
});

async function chatTurn(req, res, ac, isGone) {
  const { cid, vid, first } = req.session;
  const raw = String(req.body?.message || '').trim();
  const held = req.body?.held === true;
  const prefix = held ? maskWidgetText(String(req.body?.prefix || '').slice(0, 80)) : ''; // "Thanks, Ana. " shown before the answer
  const hooks = cfg.testHooks ? { append: req.get('x-des-test-append') || '', fail: req.get('x-des-test-fail') || '' } : {};
  const send = (ev, data) => { if (!isGone()) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
  let userRowId = null;
  /** The visitor's message. The question held during sign-up was already stored with the sign-up transcript. */
  const storeUser = async (text, product = null) => {
    if (held) {
      const h = (await q(`select id from messages where conversation_id=$1 and role='user' and held order by seq desc limit 1`, [cid])).rows[0];
      // the widget may have added questions typed during sign-up to the held one: store what the AI is answering
      if (h) { await q('update messages set held=false, product=$2, content=$3 where id=$1', [h.id, product, text]); userRowId = Number(h.id); }
    }
    if (!userRowId) userRowId = (await addMessage(cid, { role: 'user', content: text, product })).id;
    await q('update conversations set turns = turns + 1 where id=$1', [cid]);
  };
  /** Store a reply the visitor sees, then end the stream. */
  const finish = async (text, { blocked = null, lang = 'en', ended = false, until = null, kind = 'chat' } = {}) => {
    const m = await addMessage(cid, { role: 'assistant', content: prefix + text, blocked_reason: blocked, kind, delivered: !isGone() });
    send('done', { text, blocked, lang, ended, until, message_id: m.id }); res.end();
  };
  /** A message refused without a server reply bubble (the widget shows and logs its own notice). */
  const refuse = async (code, note) => {
    if (raw) await storeUser(maskPII(raw).text.slice(0, 4000));
    await addMessage(cid, { role: 'system', kind: 'event', content: note });
    send('error', { code }); res.end();
  };
  /** Off-topic / abusive / injection message: redirect, warn on the second-to-last strike, end the chat on the last. */
  const strike = async (kind, lang) => {
    const C = CANNED[lang] || CANNED.en;
    const prior = Number((await q(`select count(*) n from messages where conversation_id=$1 and role='assistant' and blocked_reason in ('off_topic','abuse','injection')`, [cid])).rows[0].n);
    const n = prior + 1;
    if (n >= cfg.chatStrikesMax) {
      await q(`update conversations set status='ended', ended_at=now(), summary=coalesce(summary, 'Ended by DES: repeated off-topic or abusive messages') where id=$1`, [cid]);
      const v = (await q('select phone_hash, email_hash from visitors where id=$1', [vid])).rows[0];
      await banIdentity(banKeys(req, { vid, phoneHash: v?.phone_hash, emailHash: v?.email_hash }));
      const until = await banUntil(banKeys(req, { vid }));
      send('event', { type: 'ended', until }); send('text', { delta: C.ended });
      return finish(C.ended, { blocked: kind, lang, ended: true, until });
    }
    const base = kind === 'abuse' ? C.abuse : kind === 'injection' ? C.injection : C.offtopic;
    const msg = n === cfg.chatStrikesMax - 1 ? `${base} ${C.strikeWarn}` : base;
    send('text', { delta: msg }); return finish(msg, { blocked: kind, lang });
  };

  let streamed = '', saved = false;
  try {
    const conv = (await q('select lang, turns, status from conversations where id=$1', [cid])).rows[0];
    if (!conv) { send('error', { code: 'no_conversation' }); return res.end(); }
    const lang = raw ? detectLang(raw) : conv.lang;
    const C = CANNED[lang] || CANNED.en;
    const bannedUntil = await banUntil(banKeys(req, { vid }));
    if (conv.status === 'ended' || bannedUntil) {
      const until = bannedUntil || (await banUntil(banKeys(req, { vid })));
      if (raw) await storeUser(maskPII(raw).text.slice(0, 4000));
      send('event', { type: 'ended', until });
      return finish(C.ended, { blocked: 'ended', lang, ended: true, until, kind: 'event' });
    }

    // input guardrails
    if (!raw) { send('error', { code: 'empty' }); return res.end(); }
    if (raw.length > MAX_INPUT_CHARS) { await storeUser(maskPII(raw).text.slice(0, 4000)); send('text', { delta: C.tooLong }); return finish(C.tooLong, { blocked: 'too_long', lang }); }
    if (await isBlocked('session:' + cid)) return refuse('blocked', 'Not answered: this chat is blocked (repeated prompt-injection attempts).');
    if ((await count('session:' + cid, 'msg', 600)) >= cfg.rate.msgPer10Min || (await count('session:' + cid, 'msg', 86400)) >= cfg.rate.msgPerDay) return refuse('rate_limited', 'Not answered: too many messages (rate limit).');
    await hit('session:' + cid, 'msg');

    const { text: masked, hits: piiHits } = maskPII(raw);
    const product = detectProduct(masked);
    await storeUser(masked, product);
    await q('update conversations set lang = $2 where id=$1', [cid, lang]);

    if (conv.turns + 1 > cfg.rate.maxTurns) { await handoff({ conversationId: cid, visitorId: vid }, 'turn cap'); send('text', { delta: C.trouble }); return finish(C.trouble, { blocked: 'turn_cap', lang }); }
    if (injectionScore(masked) >= 1) {
      const n = (await count('session:' + cid, 'inj', 3600)) + 1; await hit('session:' + cid, 'inj');
      if (n >= 3) await q(`insert into blocked(key, reason) values($1,'injection x3') on conflict do nothing`, ['session:' + cid]);
      return strike('injection', lang);
    }
    let cls = classify(masked);
    // the regex catches the obvious; the small model catches Filipino, Taglish, slang and disguised requests
    if (cls === 'on_topic' && cfg.chatLlmScreen) cls = await classifyLLM(masked);
    if (cls === 'abuse' || cls === 'off_topic') return strike(cls, lang);
    if (cls === 'support_request') { send('text', { delta: C.support }); return finish(C.support, { blocked: 'support', lang }); }

    const budget = await budgetState();
    if (budget.ratio >= 1) { await handoff({ conversationId: cid, visitorId: vid }, 'budget exhausted'); send('text', { delta: C.budget }); return finish(C.budget, { blocked: 'budget', lang }); }

    // retrieval: "auto" attaches the 6 best website sections to every message; "tool" lets the AI search only when needed
    // (mock mode has no tool loop, so it keeps auto)
    const auto = cfg.retrievalMode === 'auto' || isMock();
    const smallTalk = isSmallTalk(masked);
    const [chunks, gl, f, system, approved, notes] = await Promise.all([auto && !smallTalk ? search(masked, { k: 6, product }) : (auto ? [] : null), glossaryHits(masked), facts(), stablePrompt(), smallTalk ? [] : goldenMatches(masked, { product }), productNotes(product)]);
    const context = buildContext({ facts: f, chunks, glossary: gl, lang, visitorName: first, approved, product, notes, found: auto ? [] : foundEarlier(cid) });
    // a product / capability question with no approved answer must be grounded in a website search
    const requireSearch = !auto && !approved.length && needsKb(masked, product);
    if (approved.length) await q('update golden_answers set use_count = use_count + 1, last_used_at = now() where id = any($1::bigint[])', [approved.map((a) => a.id)]);
    const userTurn = `${context}\n<message>\n${masked}${piiHits ? '\n(Note: the visitor pasted sensitive numbers which were redacted; remind them gently not to share those here.)' : ''}\n</message>`;

    // history (last 10 turns): the AI conversation only, no scripted widget bubbles, notices or cut-off replies
    const hist = (await q(`select role, content from messages where conversation_id=$1 and role in ('user','assistant') and kind='chat' and blocked_reason is null
                           and not coalesce(incomplete, false) and id <> $2 order by seq desc, id desc limit 20`, [cid, userRowId])).rows.reverse();
    const history = hist.map((m) => ({ role: m.role, content: m.content }));

    const ctx = { conversationId: cid, visitorId: vid, sources: [] };
    const onText = (d) => {
      streamed += d; send('text', { delta: d });
      if (hooks.fail === 'midstream' && streamed.length > 20) throw new Error('test hook: failure mid-reply');
    };
    const onTool = (t) => addMessage(cid, { role: 'tool', content: t.output?.slice(0, 2000) || '', tool_name: t.name, tool_input: t.input || null, tool_output: { result: t.output?.slice(0, 2000) } });
    let out;
    try { out = await answer({ system, history, userTurn, ctx, onText, onEvent: (ev) => send('event', ev), onTool, signal: ac.signal, requireSearch, noTools: smallTalk }); }
    finally { if (!out) ac.abort(); } // stop reading the gateway stream after an error
    if (isGone()) throw Object.assign(new Error('visitor left'), { code: 'visitor_left' });
    if (hooks.append) { out.text += hooks.append; streamed += hooks.append; send('text', { delta: hooks.append }); }

    // output guardrails
    const vc = (await q('select phone, email from visitors where id=$1', [vid])).rows[0] || {};
    let { text, reasons } = filterOutput(out.text, { systemPrompt: system, visitorContact: [decrypt(vc.phone), decrypt(vc.email)].filter(Boolean) });
    let blocked = null;
    if (reasons.includes('price')) { text = C.price; blocked = 'price'; }
    else if (reasons.length) { text = C.trouble; blocked = reasons.join(','); }
    if (blocked || text !== streamed) send('replace', { text });

    const m = await addMessage(cid, { role: 'assistant', content: prefix + text, original_content: text !== out.text ? out.text : null, tokens_in: out.usage.in, tokens_out: out.usage.out, cache_read: out.usage.cache, cost_usd: out.usd,
      blocked_reason: blocked, product, golden_ids: approved.length ? approved.map((a) => a.id) : null, delivered: !isGone() });
    saved = true;
    const used = [...(chunks || []), ...ctx.sources];
    const sources = [...new Map(used.map((c) => [c.url, { title: c.title, url: c.url }])).values()].slice(0, 3);
    send('done', { text, blocked, lang, message_id: m.id, sources, searches: ctx.searches || 0 });
    res.end();
  } catch (e) {
    // keep whatever part of the reply the visitor already saw (or would have seen), marked as cut short
    if (!saved && userRowId && (streamed || isGone())) {
      try { await addMessage(cid, { role: 'assistant', content: prefix + streamed, incomplete: true, delivered: !isGone(), blocked_reason: isGone() ? 'visitor_left' : 'error' }); saved = true; } catch (e2) { console.error('partial reply not saved', e2.message); }
    }
    if (isGone()) return; // nobody to answer, and not a fault worth a Sales email
    console.error('chat error', e);
    try { await handoff({ conversationId: cid, visitorId: vid }, 'system: ' + e.message); } catch { }
    if (e.code === 'gateway_credits') { // IQGateway wallet empty or daily cap reached: same polite text as our own budget cap
      const lang = detectLang(raw);
      const msg = (CANNED[lang] || CANNED.en).budget;
      await addMessage(cid, { role: 'assistant', content: msg, blocked_reason: 'budget', kind: 'event' }).catch(() => { });
      send('replace', { text: msg }); send('done', { text: msg, blocked: 'budget', lang, sources: [] }); return res.end();
    }
    send('error', { code: 'llm_error' }); res.end();
  }
}

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
  const msgs = (await q(`select role, content from messages where conversation_id=$1 and role in ('user','assistant') order by seq, id`, [req.session.cid])).rows;
  const summary = msgs.length ? await summarize(msgs.map((m) => `${m.role}: ${m.content}`).join('\n')).catch((e) => { console.error('summary failed', e.message); return null; }) : null;
  await q(`update conversations set ended_at = now(), status = case when status='open' then 'closed' else status end, summary=coalesce($2, summary) where id=$1`, [req.session.cid, summary]);
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

// ---------- admin (older endpoints; sign-in and permissions are checked by adminAuth, server.js) ----------
r.get('/admin/leads', async (req, res) => {
  const rows = (await q(`select l.*, v.name, v.phone, v.phone_type, v.email, v.email_type, v.marketing_opt_in, c.summary, c.status as conv_status, c.started_at
                         from leads l join visitors v on v.id=l.visitor_id left join conversations c on c.id=l.conversation_id order by l.updated_at desc limit 500`)).rows;
  res.json(rows.map((x) => ({ ...x, phone: decrypt(x.phone), email: decrypt(x.email) })));
});
r.get('/admin/conversations/:id', async (req, res) => {
  const conv = (await q(`select c.*, v.name, v.phone, v.phone_type, v.email, v.email_type from conversations c join visitors v on v.id=c.visitor_id where c.id=$1`, [req.params.id])).rows[0];
  if (!conv) return res.status(404).end();
  const messages = (await q('select id, role, content, tool_name, tool_input, blocked_reason, tokens_in, tokens_out, created_at from messages where conversation_id=$1 order by seq, id', [req.params.id])).rows;
  const feedback = (await q('select * from feedback where conversation_id=$1 order by id', [req.params.id])).rows;
  res.json({ ...conv, phone: decrypt(conv.phone), email: decrypt(conv.email), messages, feedback });
});
r.get('/admin/feedback/summary', async (_req, res) => {
  const s = (await q(`select count(*) filter (where kind='survey' and not dismissed)::int surveys, round(avg(rating) filter (where kind='survey'),2) avg_rating,
                      count(*) filter (where resolved='yes')::int resolved_yes, count(*) filter (where resolved='partly')::int resolved_partly, count(*) filter (where resolved='no')::int resolved_no,
                      count(*) filter (where kind='thumb' and thumb=1)::int thumbs_up, count(*) filter (where kind='thumb' and thumb=-1)::int thumbs_down from feedback where created_at > now() - interval '30 days'`)).rows[0];
  const reasons = (await q(`select unnest(reasons) reason, count(*)::int n from feedback where created_at > now() - interval '30 days' group by 1 order by 2 desc`)).rows;
  const blocked = (await q(`select blocked_reason, count(*)::int n from messages where blocked_reason is not null and created_at > now() - interval '30 days' group by 1 order by 2 desc`)).rows;
  const usage = (await q(`select * from usage_daily order by day desc limit 30`)).rows;
  res.json({ ...s, reasons, blocked, usage });
});
r.get('/admin/review-queue', async (_req, res) => {
  const rows = (await q(`select m.id message_id, m.conversation_id, m.content answer, m.product,
                         coalesce((select array_agg(distinct x) from feedback r, unnest(r.reasons) x where r.message_id = m.id and r.kind = 'thumb_reason'), f.reasons) reasons, f.rating, f.thumb,
                         (select content from messages u where u.conversation_id=m.conversation_id and u.role='user' and u.id < m.id order by u.id desc limit 1) question
                         from feedback f join messages m on m.id = f.message_id where (f.thumb = -1) and not exists (select 1 from golden_answers g where g.message_id = m.id)
                         order by f.created_at desc limit 300`)).rows;
  res.json(rows);
});
// POST /admin/golden lives in admin.js (it embeds the question so the answer can be matched live)
r.get('/admin/export/finetune.jsonl', async (req, res) => {
  const sys = await stablePrompt();
  const rows = (await q('select question, context, ideal_answer from golden_answers order by id')).rows;
  await audit(req, 'export.finetune', null, { rows: rows.length });
  res.setHeader('content-type', 'application/x-ndjson');
  for (const g of rows) res.write(JSON.stringify({ messages: [{ role: 'system', content: sys }, { role: 'user', content: `${g.context || ''}\n<message>\n${g.question}\n</message>` }, { role: 'assistant', content: g.ideal_answer }] }) + '\n');
  res.end();
});
r.get('/admin/export/leads.csv', async (req, res) => {
  const rows = (await q(`select l.created_at, v.name, v.phone, v.phone_type, v.email, v.email_type, l.company, l.industry, l.team_size, l.current_system, l.need, array_to_string(l.product_interest, '; ') products, l.demo_requested, l.status, v.marketing_opt_in, l.conversation_id
                         from leads l join visitors v on v.id=l.visitor_id order by l.created_at desc`)).rows;
  await audit(req, 'export.leads', null, { rows: rows.length });
  res.setHeader('content-type', 'text/csv'); res.setHeader('content-disposition', 'attachment; filename=des-leads.csv');
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cols = ['created_at', 'name', 'phone', 'phone_type', 'email', 'email_type', 'company', 'industry', 'team_size', 'current_system', 'need', 'products', 'demo_requested', 'status', 'marketing_opt_in', 'conversation_id'];
  res.write(cols.join(',') + '\n');
  for (const x of rows) { const y = { ...x, phone: decrypt(x.phone), email: decrypt(x.email) }; res.write(cols.map((k) => esc(y[k])).join(',') + '\n'); }
  res.end();
});
r.post('/admin/ingest', async (req, res) => { const url = req.body?.url; if (url) { res.json(await ingestUrl(url, { source: 'manual' })); } else { res.json({ started: true }); sweepSitemap().catch(console.error); } });
r.get('/admin/kb', async (_req, res) => {
  const docs = (await q(`select d.id, d.url, d.title, d.kind, d.status, d.lastmod, d.updated_at, count(c.id)::int chunks from kb_documents d left join kb_chunks c on c.document_id=d.id group by d.id order by d.kind, d.title`)).rows;
  const log = (await q('select * from ingest_log order by id desc limit 50')).rows;
  res.json({ docs, log });
});
r.put('/admin/facts/:key', async (req, res) => { await q('insert into facts(key,value) values($1,$2) on conflict(key) do update set value=excluded.value, updated_at=now()', [req.params.key, String(req.body?.value || '')]); res.json({ ok: true }); });
r.post('/admin/prompt', async (req, res) => {
  const version = req.body?.version || new Date().toISOString();
  await q('update system_prompts set active=false'); await q('insert into system_prompts(version,text,active) values($1,$2,true)', [version, String(req.body?.text || '')]); invalidatePrompt();
  await audit(req, 'prompt.changed', version, { chars: String(req.body?.text || '').length });
  res.json({ ok: true });
});
r.delete('/admin/visitors/:id', async (req, res) => { // DPA erasure (cascades)
  const v = (await q('select name from visitors where id=$1', [req.params.id])).rows[0];
  await q('delete from visitors where id=$1', [req.params.id]);
  await audit(req, 'visitor.deleted', req.params.id, { name: v?.name || null });
  res.json({ ok: true });
});
