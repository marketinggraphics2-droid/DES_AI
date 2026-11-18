// Admin API for the dashboard (../admin/index.html). Everything here needs a signed-in user with the right role.
// Older admin endpoints (leads, conversation detail, feedback summary, review queue, KB list, exports, ingest,
// facts PUT, prompt POST, visitor erasure) stay in routes.js; the dashboard uses both.
import { Router } from 'express';
import { cfg } from './config.js';
import { q, decrypt } from './db.js';
import { embed, toVector } from './embeddings.js';
import { detectProduct, search, glossaryHits, facts, goldenMatches, productNotes, contentWords, phraseScore } from './retrieval.js';
import { stablePrompt, buildContext } from './prompt.js';
import { answer } from './llm.js';
import { detectLang, filterOutput, CANNED } from './guardrails.js';
import { loadSites, toOrigin } from './sites.js';
import { audit } from './auth.js';
import { productNames, allProducts, updateProduct } from './products.js';
import { checkProducts, lastProductCheck } from './product-sync.js';
import { publish, streamHandler } from './events.js';
import { addMessage, handBack } from './log.js';

export const adminRouter = Router();
const GENERAL = 'General'; // approved answers / questions not tied to one product
const LEAD_STATUSES = ['new', 'contacted', 'call_again', 'qualified', 'not_interested']; // new = not called yet; contacted = spoke with them; qualified is set by hand

// conversations of the same person as visitor $2: same visitor row, same phone (person_key), or same email on another sign-up
const SAME_PERSON = `(c.visitor_id = $2 or exists (select 1 from visitors me where me.id = $2 and ((me.person_key is not null and v.person_key = me.person_key) or (me.email_hash is not null and v.email_hash = me.email_hash))))`;
const MSG_COLS = 'id, seq, role, kind, source, author, content, original_content, incomplete, delivered, tool_name, tool_input, blocked_reason, product, golden_ids, tokens_in, tokens_out, cost_usd, created_at';
// sign-in and permissions: adminAuth (auth.js) runs before this router
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const daysOf = (req) => Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
const productParam = (name) => (name === GENERAL ? null : name);
/** Any product in the list, also switched-off ones and ones whose page left the website (their history stays reachable). */
const knownProduct = (name) => name === GENERAL || allProducts().some((p) => p.name === name);
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const cleanVariations = (v) => (Array.isArray(v) ? v.join('\n') : String(v ?? '')).split('\n').map((s) => s.trim().slice(0, 300)).filter(Boolean).slice(0, 30).join('\n') || null;

async function embedOne(text) { const [v] = await embed([text], 'document'); return toVector(v); }

/** Approved answers saved before this change have no embedding yet; give them one so they can match. */
export async function backfillGolden() {
  const rows = (await q('select id, question from golden_answers where embedding is null')).rows;
  for (const r of rows) await q('update golden_answers set embedding=$2::vector where id=$1', [r.id, await embedOne(r.question)]);
  if (rows.length) console.log(`approved answers: embedded ${rows.length} older question(s)`);
}

// ---------------- overview ----------------
adminRouter.get('/overview', wrap(async (req, res) => {
  const d = daysOf(req);
  const since = `now() - make_interval(days => $1)`;
  const k = (await q(`select
      (select count(*) from conversations where turns > 0 and started_at > ${since})::int conversations,
      (select count(distinct visitor_id) from conversations where turns > 0 and started_at > ${since})::int visitors,
      (select count(*) from messages where role='user' and created_at > ${since})::int questions,
      (select count(*) from leads where created_at > ${since})::int leads,
      (select count(*) from leads where qualified_at > ${since})::int qualified,
      (select count(*) from leads where demo_requested and updated_at > ${since})::int demos,
      (select count(*) from messages where role='assistant' and blocked_reason is not null and created_at > ${since})::int blocked,
      (select count(*) from messages where role='assistant' and golden_ids is not null and created_at > ${since})::int approved_used,
      (select count(*) from feedback where kind='thumb' and thumb=1 and created_at > ${since})::int thumbs_up,
      (select count(*) from feedback where kind='thumb' and thumb=-1 and created_at > ${since})::int thumbs_down,
      (select round(avg(rating), 2) from feedback where kind='survey' and rating is not null and created_at > ${since})::float avg_rating,
      (select count(*) from feedback where kind='survey' and rating is not null and created_at > ${since})::int surveys,
      (select coalesce(sum(cost_usd), 0) from usage_daily where day > current_date - $1::int)::float cost_usd,
      (select coalesce(sum(requests), 0) from usage_daily where day > current_date - $1::int)::int ai_calls`, [d])).rows[0];

  const daily = (await q(`select to_char(g.day, 'YYYY-MM-DD') as day,
      (select count(*) from conversations c where c.turns > 0 and c.started_at::date = g.day)::int conversations,
      (select count(*) from messages m where m.role='user' and m.created_at::date = g.day)::int questions,
      (select count(*) from leads l where l.created_at::date = g.day)::int leads,
      coalesce((select cost_usd from usage_daily u where u.day = g.day), 0)::float cost
    from (select generate_series(current_date - ($1::int - 1), current_date, interval '1 day')::date as day) g order by g.day`, [d])).rows;

  const products = (await q(`select coalesce(product, '${GENERAL}') product, count(*)::int n from messages
      where role='user' and created_at > ${since} group by 1 order by 2 desc`, [d])).rows;
  const leadProducts = (await q(`select p product, count(*)::int n from leads, unnest(product_interest) p
      where created_at > ${since} group by 1 order by 2 desc`, [d])).rows;
  const blocked = (await q(`select blocked_reason reason, count(*)::int n from messages
      where blocked_reason is not null and created_at > ${since} group by 1 order by 2 desc`, [d])).rows;
  res.json({ days: d, kpi: k, daily, products, leadProducts, blocked });
}));

adminRouter.get('/activity', wrap(async (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 40);
  const rows = (await q(`
    (select 'conversation' as type, c.started_at as at, v.name as who, c.id as conversation_id, c.status as status,
            coalesce(c.summary, (select m.content from messages m where m.conversation_id=c.id and m.role='user' and m.kind='chat' order by m.seq, m.id limit 1)) as detail
       from conversations c join visitors v on v.id=c.visitor_id where c.turns > 0 order by c.started_at desc limit 25)
    union all
    (select 'lead', l.updated_at, v.name, l.conversation_id, case when l.demo_requested then 'demo' else l.status end,
            concat_ws(' · ', array_to_string(l.product_interest, ', '), l.need)
       from leads l join visitors v on v.id=l.visitor_id
       where l.need is not null or l.demo_requested or coalesce(cardinality(l.product_interest), 0) > 0 or l.status <> 'new'
       order by l.updated_at desc limit 25)
    union all
    (select 'feedback', f.created_at, v.name, f.conversation_id,
            case when f.kind='survey' then 'rating' when f.thumb=1 then 'up' else 'down' end,
            case when f.kind='survey' then concat('Rated ', f.rating, '/5', coalesce(' · ' || f.comment, '')) else coalesce(array_to_string(f.reasons, ', '), '') end
       from feedback f join conversations c on c.id=f.conversation_id join visitors v on v.id=c.visitor_id
       where (f.kind='survey' and f.rating is not null) or f.kind='thumb' order by f.created_at desc limit 25)
    order by at desc limit $1`, [limit])).rows;
  res.json(rows);
}));

// ---------------- conversations ----------------
// lead filter: '' = everyone · lead = has a lead (every sign-up has one) · uncalled = not called yet and no remark · new / call_again / qualified / not_interested
// tocall = the call queue. Not called yet: now. Call again: at its time (no time = now; after "No answer" the retry schedule).
// Contacted: once more for a follow-up, 2 working days later. Qualified (counted, Sales takes over) and Not interested: never.
const LEAD_FILTERS = ['lead', 'uncalled', 'tocall', ...LEAD_STATUSES];
const TO_CALL = `((l.status = 'new' and not exists(select 1 from remarks r where r.conversation_id=c.id)) or (l.status = 'call_again' and coalesce(l.next_action_at, now()) <= now()) or (l.status = 'contacted' and l.next_action_at <= now()))`;
const QUEUE_ORDER = 'l.next_action_at asc nulls last, c.started_at desc'; // due follow-ups first (oldest due first), then new leads, newest first
/** Filters shared by the list and the chip counts. status / product may be comma lists; days = started in the last N days. */
const CHAT_STATUSES = ['open', 'closed', 'ended'];
function conversationFilters(req) {
  const list = (v, max) => String(v || '').split(',').map((x) => clean(x, max)).filter(Boolean).slice(0, 30);
  const status = list(req.query.status, 20).filter((s) => CHAT_STATUSES.includes(s));
  const product = list(req.query.product, 60);
  const days = parseInt(req.query.days, 10);
  return {
    status: status.length ? status : null, search: req.query.q ? `%${clean(req.query.q, 100)}%` : null, product: product.length ? product : null,
    all: req.query.all === '1', days: days > 0 ? Math.min(3650, days) : null,
  };
}
// $1 status[] · $2 search · $3 product[] · $4 include empty chats · $5 days · $6 lead filter
const CONV_WHERE = `($4::boolean or c.turns > 0 or l.id is not null)
      and ($1::text[] is null or c.status = any($1))
      and ($2::text is null or v.name ilike $2 or l.company ilike $2 or exists(select 1 from messages m where m.conversation_id=c.id and m.content ilike $2) or exists(select 1 from remarks r where r.conversation_id=c.id and r.body ilike $2))
      and ($3::text[] is null or exists(select 1 from messages m where m.conversation_id=c.id and m.product = any($3)) or l.product_interest && $3)
      and ($5::int is null or c.started_at > now() - make_interval(days => $5))
      and ($6::text is null or ($6 = 'lead' and l.id is not null) or ($6 = 'uncalled' and l.status = 'new' and not exists(select 1 from remarks r where r.conversation_id=c.id)) or ($6 = 'tocall' and ${TO_CALL}) or l.status = any(string_to_array($6, ',')))`; // $6 may also be several statuses: 'call_again,qualified'
const CONV_SORT = {
  newest: 'c.started_at desc', oldest: 'c.started_at asc',
  followup: `(l.status = 'new' and not exists(select 1 from remarks r where r.conversation_id=c.id)) desc, (l.status = 'new') desc, c.started_at asc`,
  questions: 'c.turns desc, c.started_at desc',
};
// counts for the quick chips (All · Not called yet · Call again · Qualified · Not interested) under the other filters
adminRouter.get('/conversation-counts', wrap(async (req, res) => {
  const f = conversationFilters(req);
  const r = (await q(`select count(*)::int "all", count(l.id)::int lead,
      count(*) filter (where l.status = 'new' and not exists(select 1 from remarks r where r.conversation_id=c.id))::int uncalled,
      count(*) filter (where ${TO_CALL})::int tocall,
      count(*) filter (where l.status='new')::int new, count(*) filter (where l.status='contacted')::int contacted, count(*) filter (where l.status='call_again')::int call_again,
      count(*) filter (where l.status='qualified')::int qualified, count(*) filter (where l.status='not_interested')::int not_interested
    from conversations c join visitors v on v.id=c.visitor_id left join leads l on l.conversation_id=c.id
    where ${CONV_WHERE}`, [f.status, f.search, f.product, f.all, f.days, null])).rows[0];
  res.json(r);
}));
adminRouter.get('/conversations', wrap(async (req, res) => {
  const f = conversationFilters(req);
  const raw = String(req.query.lead || ''), parts = raw.split(',').filter(Boolean);
  const lead = LEAD_FILTERS.includes(raw) ? raw : parts.length && parts.every((p) => LEAD_STATUSES.includes(p)) ? parts.join(',') : null;
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  // the call queue keeps its own order unless another sort is picked
  const order = lead === 'tocall' && (!req.query.sort || req.query.sort === 'newest') ? QUEUE_ORDER : CONV_SORT[req.query.sort] || CONV_SORT.newest;
  // the same filters for the page and the total; leads are shown even when the chat had no messages
  const where = CONV_WHERE;
  const params = [f.status, f.search, f.product, f.all, f.days, lead, limit, offset];
  const rows = (await q(`
    select c.id, c.started_at, c.ended_at, c.status, c.lang, c.turns, c.summary, c.agent_id, c.agent_name, v.name, v.phone, v.phone_type, v.email, v.email_type,
      l.id lead_id, l.status lead_status, l.need, l.company, l.industry, l.team_size, l.product_interest, l.demo_requested, v.marketing_opt_in,
      l.next_action_at, l.attempts, l.last_attempt_at, l.lost_reason,
      (select count(*) from remarks r where r.conversation_id=c.id)::int remarks_count,
      (select json_build_object('body', r.body, 'by', coalesce(r.user_name, r.user_email), 'at', r.created_at) from remarks r where r.conversation_id=c.id order by r.id desc limit 1) last_remark,
      (select m.content from messages m where m.conversation_id=c.id and m.role='user' and m.kind='chat' order by m.seq, m.id limit 1) first_question,
      (select array_agg(distinct m.product) from messages m where m.conversation_id=c.id and m.product is not null) products,
      exists(select 1 from leads l where l.conversation_id=c.id) has_lead,
      exists(select 1 from leads l where l.conversation_id=c.id and l.demo_requested) demo,
      (select count(*) from feedback f where f.conversation_id=c.id and f.thumb=-1)::int thumbs_down,
      (select count(*) from messages m where m.conversation_id=c.id and m.golden_ids is not null)::int approved_used,
      (select round(avg(f.rating), 1) from feedback f where f.conversation_id=c.id and f.kind='survey')::float rating
    from conversations c join visitors v on v.id=c.visitor_id left join leads l on l.conversation_id=c.id
    where ${where}
    order by ${order} limit $7 offset $8`, params)).rows;
  const total = (await q(`select count(*)::int n from conversations c join visitors v on v.id=c.visitor_id left join leads l on l.conversation_id=c.id
    where ${where}`, params.slice(0, 6))).rows[0].n;
  res.set('x-total-count', String(total)).set('access-control-expose-headers', 'x-total-count');
  res.json(rows.map((x) => ({ ...x, phone: decrypt(x.phone), email: decrypt(x.email) })));
}));

// ---------------- call outcomes ----------------
// One click records the call: a remark, the lead's status and what happens next. Undo puts the lead back as it was.
const OUTCOMES = {
  qualified: { label: 'Qualified', status: 'qualified' },
  callback: { label: 'Call again', status: 'call_again', needsTime: true },
  not_interested: { label: 'Not interested', status: 'not_interested' },
  no_answer: { label: 'No answer', status: 'call_again', attempt: true },
  wrong_number: { label: 'Wrong number', status: 'not_interested' },
};
const MAX_ATTEMPTS = 5; // after this many unanswered calls the lead is set aside as unreachable
const MANILA = 8 * 3600e3; // UTC+8, no daylight saving
/** 9 AM Manila, `days` working days after `from` (Mon–Sat; Sunday skipped). */
function workingMorning(from, days) {
  const d = new Date(from + MANILA);
  let left = days; while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() !== 0) left--; }
  d.setUTCHours(9, 0, 0, 0);
  return new Date(d.getTime() - MANILA);
}
/** When to try again after an unanswered call: 4 h, then the next working morning, then every 2 working days. */
const retryAt = (attempts, now) => (attempts <= 1 ? new Date(now + 4 * 3600e3) : workingMorning(now, attempts === 2 ? 1 : 2));
const manilaTime = new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
const LEAD_STATE = ['status', 'next_action_at', 'attempts', 'last_attempt_at', 'lost_reason', 'qualified_at'];
const QUALIFIED_AT = "case when $2 = 'qualified' then coalesce(case when status = 'qualified' then qualified_at end, now()) end"; // $2 = the new status
adminRouter.post('/conversations/:id/outcome', wrap(async (req, res) => {
  const key = String(req.body?.outcome || ''), o = OUTCOMES[key];
  if (!o) return res.status(400).json({ error: 'bad_outcome' });
  const lead = (await q('select * from leads where conversation_id=$1', [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: 'no_lead' });
  const note = clean(req.body?.note, 2000), reason = clean(req.body?.reason, 80) || null;
  let at = req.body?.at ? new Date(req.body.at) : null; if (at && Number.isNaN(at.getTime())) at = null;
  if (o.needsTime && !at) return res.status(400).json({ error: 'time_needed', message: 'Pick when to call back.' });
  const now = Date.now(), previous = Object.fromEntries(LEAD_STATE.map((k) => [k, lead[k] ?? null]));
  let status = o.status, attempts = (lead.attempts || 0) + (o.attempt ? 1 : 0), next = null, lost = null;
  if (key === 'no_answer') {
    if (attempts >= MAX_ATTEMPTS) { status = 'not_interested'; lost = `unreachable (no answer after ${attempts} calls)`; } else next = retryAt(attempts, now);
  } else if (key === 'callback') next = at;
  else if (key === 'not_interested') lost = reason || 'not interested';
  else if (key === 'wrong_number') lost = 'wrong number';
  const when = next ? manilaTime.format(next) : null;
  const what = key === 'no_answer' ? (lost ? `No answer (${attempts} calls): set aside as unreachable` : `No answer (call ${attempts}). Next try ${when}`)
    : key === 'callback' ? `Call again ${when}`
    : key === 'qualified' ? 'Qualified'
    : key === 'not_interested' ? `Not interested${reason ? ` (${reason})` : ''}` : 'Wrong number';
  const body = note ? `${what}. ${note}` : what;
  const r = (await q(`insert into remarks(conversation_id, user_id, user_email, user_name, body, outcome) values($1,$2,$3,$4,$5,$6)
    returning id, user_id, user_email, user_name, body, outcome, created_at`, [req.params.id, req.user.id, req.user.email, req.user.name || null, body, key])).rows[0];
  const l = (await q(`update leads set status=$2, next_action_at=$3, attempts=$4, last_attempt_at = case when $5 then now() else last_attempt_at end,
    lost_reason=$6, qualified_at = ${QUALIFIED_AT}, updated_at=now() where id=$1 returning *`,
    [lead.id, status, next, attempts, !!o.attempt, lost])).rows[0];
  publish('remark.new', { conversation_id: req.params.id, ...r, id: Number(r.id) });
  publish('lead.update', { id: l.id, conversation_id: req.params.id, status: l.status, next_action_at: l.next_action_at, attempts: l.attempts });
  res.json({ remark: { ...r, id: Number(r.id) }, lead: l, previous });
}));
adminRouter.post('/conversations/:id/outcome/undo', wrap(async (req, res) => {
  const rid = Number(req.body?.remark_id), p = req.body?.previous || {};
  if (!rid || !LEAD_STATUSES.includes(p.status)) return res.status(400).json({ error: 'bad_undo' });
  const del = await q('delete from remarks where id=$1 and conversation_id=$2 and outcome is not null returning id', [rid, req.params.id]);
  if (!del.rowCount) return res.status(404).json({ error: 'not_found' });
  const ts = (v) => (v && !Number.isNaN(new Date(v).getTime()) ? new Date(v) : null);
  const l = (await q(`update leads set status=$2, next_action_at=$3, attempts=$4, last_attempt_at=$5, lost_reason=$6, qualified_at=$7, updated_at=now() where conversation_id=$1 returning *`,
    [req.params.id, p.status, ts(p.next_action_at), Math.max(0, parseInt(p.attempts, 10) || 0), ts(p.last_attempt_at), p.lost_reason ? clean(p.lost_reason, 120) : null, p.status === 'qualified' ? ts(p.qualified_at) || new Date() : null])).rows[0];
  publish('remark.deleted', { conversation_id: req.params.id, id: rid });
  if (l) publish('lead.update', { id: l.id, conversation_id: req.params.id, status: l.status, next_action_at: l.next_action_at, attempts: l.attempts });
  res.json({ ok: true, lead: l || null });
}));

// ---------------- live takeover ----------------
// A team member takes over a chat that is happening: DES stays silent, the visitor sees their messages, "Hand back" ends it.
const agentFirstName = (u) => String(u.name || u.email.split('@')[0]).trim().split(/\s+/)[0];
adminRouter.post('/conversations/:id/takeover', wrap(async (req, res) => {
  const c = (await q('select id, status, agent_id, agent_name from conversations where id=$1', [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ error: 'not_found' });
  if (c.status === 'ended') return res.status(409).json({ error: 'chat_ended', message: 'DES ended this chat, so it cannot be taken over.' });
  const name = agentFirstName(req.user);
  await q('update conversations set agent_id=$2, agent_name=$3, agent_last_at=now() where id=$1', [c.id, req.user.id, name]);
  if (c.agent_id !== req.user.id) await addMessage(c.id, { role: 'system', kind: 'event', source: 'agent', author: name, content: `${name} from DynamIQ joined the chat` });
  publish('conversation.update', { id: c.id, agent_id: req.user.id, agent_name: name });
  await audit(req, 'chat.takeover', c.id, { from: c.agent_name || 'DES' });
  res.json({ ok: true, agent_id: req.user.id, agent_name: name });
}));
adminRouter.post('/conversations/:id/reply', wrap(async (req, res) => {
  const text = clean(req.body?.text, 2000);
  if (!text) return res.status(400).json({ error: 'empty' });
  const c = (await q('select id, agent_id, agent_name from conversations where id=$1', [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ error: 'not_found' });
  if (c.agent_id !== req.user.id) return res.status(409).json({ error: 'not_yours', message: c.agent_id ? `${c.agent_name} is chatting now. Take over first.` : 'Take over the chat first.' });
  const m = await addMessage(c.id, { role: 'assistant', kind: 'chat', source: 'agent', author: c.agent_name, content: text });
  await q('update conversations set agent_last_at=now() where id=$1', [c.id]);
  res.json({ ok: true, id: m.id, seq: m.seq });
}));
adminRouter.post('/conversations/:id/handback', wrap(async (req, res) => {
  const c = (await q('select id, agent_name from conversations where id=$1', [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ error: 'not_found' });
  if (await handBack(c.id)) await audit(req, 'chat.handback', c.id, { from: c.agent_name });
  res.json({ ok: true });
}));

adminRouter.get('/conversations/:id/detail', wrap(async (req, res) => {
  const conv = (await q(`select c.*, v.name, v.phone, v.phone_type, v.email, v.email_type, v.marketing_opt_in, v.first_page_url from conversations c join visitors v on v.id=c.visitor_id where c.id=$1`, [req.params.id])).rows[0];
  if (!conv) return res.status(404).json({ error: 'not_found' });
  const messages = (await q(`select ${MSG_COLS} from messages where conversation_id=$1 order by seq, id`, [req.params.id])).rows;
  const ids = [...new Set(messages.flatMap((m) => m.golden_ids || []).map(Number))];
  const golden = ids.length ? (await q('select id, question, product from golden_answers where id = any($1::bigint[])', [ids])).rows : [];
  const feedback = (await q('select * from feedback where conversation_id=$1 order by id', [req.params.id])).rows;
  const lead = (await q('select * from leads where conversation_id=$1', [req.params.id])).rows[0] || null;
  const remarks = (await q('select id, user_id, user_email, user_name, body, created_at from remarks where conversation_id=$1 order by id', [req.params.id])).rows;
  const others = (await q(`select count(*)::int n from conversations c join visitors v on v.id=c.visitor_id
                           where c.id <> $1 and ${SAME_PERSON}`, [req.params.id, conv.visitor_id])).rows[0].n;
  res.json({ ...conv, phone: decrypt(conv.phone), email: decrypt(conv.email), messages, golden, feedback, lead, remarks, other_conversations: others });
}));

// Everything the same person said across visits and sign-ups (same visitor, or same contact on a new sign-up), oldest first.
adminRouter.get('/conversations/:id/history', wrap(async (req, res) => {
  const me = (await q('select v.id, v.name from conversations c join visitors v on v.id=c.visitor_id where c.id=$1', [req.params.id])).rows[0];
  if (!me) return res.status(404).json({ error: 'not_found' });
  const convs = (await q(`select c.id, c.started_at, c.ended_at, c.status, c.summary, v.name from conversations c join visitors v on v.id=c.visitor_id
                          where ${SAME_PERSON.replace(/\$2/g, '$1')} order by c.started_at`, [me.id])).rows;
  const msgs = convs.length ? (await q(`select conversation_id, ${MSG_COLS} from messages where conversation_id = any($1::uuid[]) order by seq, id`, [convs.map((c) => c.id)])).rows : [];
  res.json({ name: me.name, conversations: convs.map((c) => ({ ...c, messages: msgs.filter((m) => m.conversation_id === c.id) })) });
}));

adminRouter.put('/leads/:id', wrap(async (req, res) => {
  const status = req.body?.status;
  if (!LEAD_STATUSES.includes(status)) return res.status(400).json({ error: 'bad_status' });
  // when the lead comes back to "To call": contacted in 2 working days; call again right away; the others not at all
  const next = status === 'contacted' ? workingMorning(Date.now(), 2) : null;
  const l = (await q(`update leads set status=$2, next_action_at=$3, lost_reason = case when $2 = 'not_interested' then lost_reason end, qualified_at = ${QUALIFIED_AT}, updated_at=now()
    where id=$1 returning *`, [req.params.id, status, next])).rows[0];
  if (l) publish('lead.update', { id: req.params.id, conversation_id: l.conversation_id, status, next_action_at: l.next_action_at });
  res.json({ ok: true, lead: l || null });
}));

// ---------------- remarks (call notes by the sales / telemarketing team) ----------------
adminRouter.get('/conversations/:id/remarks', wrap(async (req, res) => {
  res.json((await q('select id, user_id, user_email, user_name, body, created_at from remarks where conversation_id=$1 order by id', [req.params.id])).rows);
}));
adminRouter.post('/conversations/:id/remarks', wrap(async (req, res) => {
  const body = clean(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: 'empty' });
  if (!(await q('select 1 from conversations where id=$1', [req.params.id])).rowCount) return res.status(404).json({ error: 'not_found' });
  const r = (await q('insert into remarks(conversation_id, user_id, user_email, user_name, body) values($1,$2,$3,$4,$5) returning id, user_id, user_email, user_name, body, created_at',
    [req.params.id, req.user.id, req.user.email, req.user.name || null, body])).rows[0];
  // a remark means someone called: a lead not called yet moves to "call again" (the caller sets Qualified / Not interested)
  if (req.body?.contacted !== false) {
    const l = (await q(`update leads set status='contacted', next_action_at=$2, updated_at=now() where conversation_id=$1 and status='new' returning id, next_action_at`, [req.params.id, workingMorning(Date.now(), 2)])).rows[0];
    if (l) publish('lead.update', { id: l.id, conversation_id: req.params.id, status: 'contacted', next_action_at: l.next_action_at });
  }
  publish('remark.new', { conversation_id: req.params.id, ...r, id: Number(r.id) });
  res.json({ ...r, id: Number(r.id) });
}));
adminRouter.delete('/remarks/:id', wrap(async (req, res) => {
  const r = (await q('select id, conversation_id, user_id from remarks where id=$1', [req.params.id])).rows[0];
  if (!r) return res.status(404).json({ error: 'not_found' });
  if (r.user_id !== req.user.id && req.user.role !== 'superuser') return res.status(403).json({ error: 'not_your_remark' });
  await q('delete from remarks where id=$1', [r.id]);
  publish('remark.deleted', { conversation_id: r.conversation_id, id: Number(r.id) });
  res.json({ ok: true });
}));

// ---------------- products (fine-tuning) ----------------
adminRouter.get('/products', wrap(async (_req, res) => {
  const by = async (sql) => Object.fromEntries((await q(sql)).rows.map((r) => [r.k ?? GENERAL, r]));
  const [chunks, golden, questions, down, leadsBy, notes, cover, pages] = await Promise.all([
    by(`select product k, count(*)::int chunks, count(distinct document_id)::int docs from kb_chunks where product is not null group by product`),
    by(`select coalesce(product, '${GENERAL}') k, count(*) filter (where active is not false)::int active, count(*)::int total, coalesce(sum(use_count), 0)::int used from golden_answers group by 1`),
    by(`select coalesce(product, '${GENERAL}') k, count(*)::int n from messages where role='user' and created_at > now() - interval '30 days' group by 1`),
    by(`select coalesce(m.product, '${GENERAL}') k, count(*)::int n from feedback f join messages m on m.id=f.message_id where f.thumb=-1 group by 1`),
    by(`select p k, count(*)::int n from leads, unnest(product_interest) p group by p`),
    by(`select product k, length(trim(notes)) > 0 has, updated_at from product_notes`),
    // coverage: of DES's replies in 30 days, how many were based on an approved answer
    by(`select coalesce(product, '${GENERAL}') k, count(*)::int replies, count(*) filter (where cardinality(golden_ids) > 0)::int covered
        from messages where role='assistant' and created_at > now() - interval '30 days' group by 1`),
    by(`select c.product k, max(d.updated_at) read_at from kb_chunks c join kb_documents d on d.id=c.document_id where c.product is not null and d.kind='product' group by 1`),
  ]);
  const meta = Object.fromEntries(allProducts().map((p) => [p.name, p]));
  res.json([...allProducts().map((p) => p.name), GENERAL].map((p) => ({
    product: p,
    ...(meta[p] ? { aliases: meta[p].aliases || [], url: meta[p].slug ? `${cfg.siteOrigin.replace(/\/$/, '')}/products/${meta[p].slug}/` : null,
      active: meta[p].active, on_website: meta[p].on_website, live: meta[p].active && meta[p].on_website, needs_review: meta[p].needs_review, added_at: meta[p].created_at,
      website_name: meta[p].website_name || null, description: meta[p].description || null, logo_url: meta[p].logo_url || null, image_url: meta[p].image_url || null,
      last_seen_at: meta[p].last_seen_at || null, page_read_at: pages[p]?.read_at || null } : { live: true }),
    docs: chunks[p]?.docs || 0, chunks: chunks[p]?.chunks || 0,
    approved: golden[p]?.active || 0, approved_total: golden[p]?.total || 0, approved_used: golden[p]?.used || 0,
    questions_30d: questions[p]?.n || 0, thumbs_down: down[p]?.n || 0, leads: leadsBy[p]?.n || 0,
    has_notes: !!notes[p]?.has, notes_updated_at: notes[p]?.updated_at || null,
    replies_30d: cover[p]?.replies || 0, covered_30d: cover[p]?.covered || 0,
  })));
}));

/** "Check for new products": read the website's /products/ page now and add any product not seen before. */
adminRouter.post('/products/check', wrap(async (req, res) => {
  const r = await checkProducts({ source: 'products-check' });
  if (r.ok && (r.added.length || r.gone.length)) await audit(req, 'products.checked', null, { added: r.added, gone: r.gone });
  res.json(r);
}));

adminRouter.get('/products/:name', wrap(async (req, res) => {
  const name = clean(req.params.name, 60);
  if (!knownProduct(name)) return res.status(404).json({ error: 'unknown_product' });
  const p = productParam(name);
  const notes = (await q('select notes, updated_at from product_notes where product=$1', [name])).rows[0] || { notes: '', updated_at: null };
  const golden = (await q(`select id, question, variations, ideal_answer, product, active, use_count, last_used_at, created_at, updated_at, message_id
                           from golden_answers where ($1::text is null and product is null) or product=$1 order by updated_at desc nulls last, id desc`, [p])).rows;
  const questions = (await q(`
    select u.id, u.content question, u.created_at, u.conversation_id,
           a.id answer_id, a.content answer, a.blocked_reason, a.golden_ids,
           (select f.thumb from feedback f where f.message_id=a.id and f.kind='thumb' order by f.id desc limit 1) thumb
    from messages u
    left join lateral (select x.* from messages x where x.conversation_id=u.conversation_id and x.role='assistant' and x.id > u.id order by x.id limit 1) a on true
    where u.role='user' and (($1::text is null and u.product is null) or u.product=$1)
    order by u.id desc limit 300`, [p])).rows;
  const docs = p ? (await q(`select d.id, d.url, d.title, d.kind, d.status, d.updated_at, count(c.id)::int chunks
                             from kb_documents d join kb_chunks c on c.document_id=d.id where c.product=$1 group by d.id order by d.title`, [p])).rows : [];
  res.json({ product: name, notes: notes.notes, notes_updated_at: notes.updated_at, golden, questions, docs });
}));

adminRouter.put('/products/:name/notes', wrap(async (req, res) => {
  const name = clean(req.params.name, 60);
  if (!knownProduct(name)) return res.status(404).json({ error: 'unknown_product' });
  await q(`insert into product_notes(product, notes) values($1,$2) on conflict(product) do update set notes=excluded.notes, updated_at=now()`, [name, clean(req.body?.notes, 6000)]);
  res.json({ ok: true });
}));

/** Name, nicknames, product page, on/off, "checked". A rename carries over to leads, answers, notes and history. */
adminRouter.put('/products/:name', wrap(async (req, res) => {
  const name = clean(req.params.name, 60);
  const b = req.body || {};
  const r = await updateProduct(name, { name: b.name, aliases: b.aliases, url: b.url, active: b.active, reviewed: b.reviewed });
  if (r.error) return res.status(r.status).json({ error: r.error });
  await audit(req, 'product.updated', name, { name: r.product.name !== name ? r.product.name : undefined, aliases: b.aliases !== undefined ? r.product.aliases : undefined, active: b.active, url: b.url });
  res.json(r.product);
}));

// ---------------- approved answers ----------------
adminRouter.get('/golden', wrap(async (req, res) => {
  const name = req.query.product ? clean(req.query.product, 60) : null;
  const rows = (await q(`select id, question, variations, ideal_answer, product, active, use_count, last_used_at, created_at, updated_at from golden_answers
                         where $1::text is null or ($1 = '${GENERAL}' and product is null) or product=$1 order by id desc`, [name])).rows;
  res.json(rows);
}));

adminRouter.post('/golden', wrap(async (req, res) => {
  const question = clean(req.body?.question, 500), ideal = clean(req.body?.ideal_answer, 3000);
  if (!question || !ideal) return res.status(400).json({ error: 'question_and_answer_required' });
  const product = req.body?.product && req.body.product !== GENERAL ? clean(req.body.product, 60) : null;
  if (product && !knownProduct(product)) return res.status(400).json({ error: 'unknown_product' });
  const msgId = Number.isInteger(req.body?.message_id) ? req.body.message_id : null;
  const row = (await q(`insert into golden_answers(message_id, question, variations, context, ideal_answer, product, reviewed_by, active, embedding)
                        values($1,$2,$3,$4,$5,$6,$7,$8,$9::vector) returning id`,
    [msgId, question, cleanVariations(req.body?.variations), clean(req.body?.context, 2000) || null, ideal, product, req.user?.email || clean(req.body?.reviewed_by, 80) || 'dashboard', req.body?.active !== false, await embedOne(question)])).rows[0];
  publish('review.count', {});
  res.json({ ok: true, id: Number(row.id) });
}));

// live updates for the dashboard (events.js): Server-Sent Events, filtered and masked per role
adminRouter.get('/stream', streamHandler);

adminRouter.put('/golden/:id', wrap(async (req, res) => {
  const cur = (await q('select * from golden_answers where id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  const question = req.body?.question !== undefined ? clean(req.body.question, 500) : cur.question;
  const ideal = req.body?.ideal_answer !== undefined ? clean(req.body.ideal_answer, 3000) : cur.ideal_answer;
  if (!question || !ideal) return res.status(400).json({ error: 'question_and_answer_required' });
  let product = cur.product;
  if (req.body?.product !== undefined) {
    product = req.body.product && req.body.product !== GENERAL ? clean(req.body.product, 60) : null;
    if (product && !knownProduct(product)) return res.status(400).json({ error: 'unknown_product' });
  }
  const active = req.body?.active !== undefined ? !!req.body.active : cur.active !== false;
  const variations = req.body?.variations !== undefined ? cleanVariations(req.body.variations) : cur.variations;
  const emb = question !== cur.question || !cur.embedding ? await embedOne(question) : null;
  await q(`update golden_answers set question=$2, ideal_answer=$3, product=$4, active=$5, variations=$6, updated_at=now()${emb ? ', embedding=$7::vector' : ''} where id=$1`,
    emb ? [req.params.id, question, ideal, product, active, variations, emb] : [req.params.id, question, ideal, product, active, variations]);
  res.json({ ok: true });
}));

adminRouter.delete('/golden/:id', wrap(async (req, res) => {
  await q('delete from golden_answers where id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------------- test box: what would DES answer? (no tools, nothing saved) ----------------
adminRouter.post('/test', wrap(async (req, res) => {
  const question = clean(req.body?.question, 1000);
  if (!question) return res.status(400).json({ error: 'question_required' });
  const forced = req.body?.product && req.body.product !== 'auto' ? productParam(clean(req.body.product, 60)) : undefined;
  const product = forced !== undefined ? forced : detectProduct(question);
  const lang = ['en', 'fil'].includes(req.body?.lang) ? req.body.lang : detectLang(question);
  const [chunks, gl, f, system, approved, notes] = await Promise.all([
    search(question, { k: 6, product }), glossaryHits(question), facts(), stablePrompt(), goldenMatches(question, { product }), productNotes(product)]);
  const context = buildContext({ facts: f, chunks, glossary: gl, lang, visitorName: '', approved, product, notes });
  const userTurn = `${context}\n<message>\n${question}\n</message>`;
  const t0 = Date.now();
  const out = await answer({ system, history: [], userTurn, ctx: null, dry: true });
  const { text, reasons } = filterOutput(out.text, { systemPrompt: system });
  const C = CANNED[lang] || CANNED.en;
  const blocked = reasons.includes('price') ? 'price' : reasons.length ? reasons.join(',') : null;
  res.json({
    question, product: product || GENERAL, lang, ms: Date.now() - t0, model: cfg.model,
    answer: blocked === 'price' ? C.price : blocked ? C.trouble : text, raw: out.text, blocked,
    approved: approved.map((a) => ({ id: Number(a.id), question: a.question, matched: a.matched, product: a.product || GENERAL, score: a.sim })),
    notes_used: !!notes,
    sources: chunks.map((c) => ({ title: c.title, url: c.url, product: c.product, score: Math.round(c.score * 1000) / 1000 })),
  });
}));

// ---------------- knowledge base, facts, glossary, prompt ----------------
adminRouter.put('/kb/:id', wrap(async (req, res) => {
  const status = req.body?.status;
  if (!['active', 'archived'].includes(status)) return res.status(400).json({ error: 'bad_status' });
  await q('update kb_documents set status=$2, updated_at=now() where id=$1', [req.params.id, status]);
  res.json({ ok: true });
}));

adminRouter.get('/facts', wrap(async (_req, res) => { res.json((await q('select key, value, updated_at from facts order by key')).rows); }));
adminRouter.delete('/facts/:key', wrap(async (req, res) => { await q('delete from facts where key=$1', [req.params.key]); res.json({ ok: true }); }));

adminRouter.get('/glossary', wrap(async (_req, res) => { res.json((await q('select term, definition from glossary order by term')).rows); }));
adminRouter.put('/glossary/:term', wrap(async (req, res) => {
  const term = clean(req.params.term, 60), def = clean(req.body?.definition, 600);
  if (!term || !def) return res.status(400).json({ error: 'term_and_definition_required' });
  await q('insert into glossary(term, definition) values($1,$2) on conflict(term) do update set definition=excluded.definition', [term, def]);
  res.json({ ok: true });
}));
adminRouter.delete('/glossary/:term', wrap(async (req, res) => { await q('delete from glossary where term=$1', [req.params.term]); res.json({ ok: true }); }));

adminRouter.get('/prompt', wrap(async (_req, res) => {
  const row = (await q('select version, text, created_at from system_prompts where active=true order by id desc limit 1')).rows[0];
  res.json(row || { version: null, text: await stablePrompt(), created_at: null });
}));

adminRouter.get('/status', wrap(async (_req, res) => {
  res.json({ model: cfg.model, gateway: cfg.gateway.url, mock: !cfg.gateway.key, embeddings: cfg.embeddings.provider, golden_min_score: cfg.goldenMinScore, daily_budget_usd: cfg.dailyBudgetUsd, products: [...productNames(), GENERAL],
    products_new: allProducts().filter((p) => p.needs_review && p.active && p.on_website).map((p) => p.name),
    products_check: await lastProductCheck().catch(() => null), products_check_hours: cfg.productCheckHours });
}));

/** Which approved answers would a question match, and how strongly? (no AI call) */
adminRouter.post('/match', wrap(async (req, res) => {
  const question = clean(req.body?.question, 1000);
  const product = req.body?.product && req.body.product !== 'auto' ? productParam(clean(req.body.product, 60)) : detectProduct(question);
  const all = await goldenMatches(question, { product, k: 10 });
  res.json({ product: product || GENERAL, min_score: cfg.goldenMinScore, matches: all.map((a) => ({ id: Number(a.id), question: a.question, matched: a.matched, score: a.sim })) });
}));

// ---------------- bans after ended chats ----------------
const banKind = (b) => b.split(':')[0]; // ip | device | visitor | contact
adminRouter.get('/bans', wrap(async (_req, res) => {
  const hours = Math.max(cfg.chatBanHours, cfg.chatBanIpHours);
  const rows = (await q(`select bucket, max(at) last from rate_events where kind='ended' and at > now() - make_interval(hours => $1) group by bucket order by 2 desc`, [hours])).rows;
  const active = rows.map((r) => {
    const h = banKind(r.bucket) === 'ip' ? cfg.chatBanIpHours : cfg.chatBanHours;
    return { kind: banKind(r.bucket), at: r.last, until: new Date(new Date(r.last).getTime() + h * 3600e3).toISOString() };
  }).filter((b) => new Date(b.until) > new Date());
  const ended = (await q(`select count(*)::int n from conversations where status='ended' and ended_at > now() - make_interval(hours => $1)`, [hours])).rows[0].n;
  res.json({ active: active.length, by_kind: active.reduce((m, b) => ({ ...m, [b.kind]: (m[b.kind] || 0) + 1 }), {}), ended_chats: ended, bans: active });
}));
adminRouter.delete('/bans', wrap(async (req, res) => {
  const r = await q(`delete from rate_events where kind='ended'`);
  await audit(req, 'bans.lifted', null, { lifted: r.rowCount });
  res.json({ ok: true, lifted: r.rowCount });
}));

// ---------------- embed code + websites allowed to show the widget ----------------
adminRouter.get('/sites', wrap(async (req, res) => {
  const rows = (await q('select origin, note, added_at from allowed_sites order by added_at')).rows;
  res.json({ base: cfg.publicUrl || `${req.protocol}://${req.get('host')}`, fixed: [...new Set(cfg.allowedOrigins)], sites: rows });
}));
adminRouter.post('/sites', wrap(async (req, res) => {
  const origin = toOrigin(req.body?.origin);
  if (!origin) return res.status(400).json({ error: 'Enter a full website address starting with https:// or http://' });
  if (cfg.allowedOrigins.includes(origin)) return res.status(409).json({ error: 'That website is already allowed in the server settings' });
  await q('insert into allowed_sites(origin, note) values($1, $2) on conflict (origin) do update set note=excluded.note', [origin, clean(req.body?.note, 120) || null]);
  await loadSites();
  await audit(req, 'site.added', origin);
  res.json({ ok: true, origin });
}));
adminRouter.delete('/sites', wrap(async (req, res) => {
  const r = await q('delete from allowed_sites where origin=$1', [String(req.query.origin || '')]);
  await loadSites();
  await audit(req, 'site.removed', String(req.query.origin || ''));
  res.json({ ok: true, removed: r.rowCount });
}));
