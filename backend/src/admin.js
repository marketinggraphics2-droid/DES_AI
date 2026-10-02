// Admin API for the dashboard (../admin/index.html). Everything here is behind ADMIN_TOKEN.
// Older admin endpoints (leads, conversation detail, feedback summary, review queue, KB list, exports, ingest,
// facts PUT, prompt POST, visitor erasure) stay in routes.js; the dashboard uses both.
import { Router } from 'express';
import { cfg } from './config.js';
import { q, decrypt } from './db.js';
import { embed, toVector } from './embeddings.js';
import { PRODUCTS, detectProduct, search, glossaryHits, facts, goldenMatches, productNotes, contentWords, phraseScore } from './retrieval.js';
import { stablePrompt, buildContext } from './prompt.js';
import { answer } from './llm.js';
import { detectLang, filterOutput, CANNED } from './guardrails.js';

export const adminRouter = Router();
const GENERAL = 'General'; // approved answers / questions not tied to one product
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'closed'];

adminRouter.use((req, res, next) => {
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (cfg.adminToken && tok === cfg.adminToken) return next();
  res.status(401).json({ error: 'admin_only' });
});
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const daysOf = (req) => Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
const productParam = (name) => (name === GENERAL ? null : name);
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
      (select count(*) from leads where demo_requested and updated_at > ${since})::int demos,
      (select count(*) from handoffs where created_at > ${since})::int handoffs,
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
            coalesce(c.summary, (select m.content from messages m where m.conversation_id=c.id and m.role='user' order by m.id limit 1)) as detail
       from conversations c join visitors v on v.id=c.visitor_id where c.turns > 0 order by c.started_at desc limit 25)
    union all
    (select 'lead', l.updated_at, v.name, l.conversation_id, case when l.demo_requested then 'demo' else l.status end,
            concat_ws(' · ', array_to_string(l.product_interest, ', '), l.need)
       from leads l join visitors v on v.id=l.visitor_id order by l.updated_at desc limit 25)
    union all
    (select 'handoff', h.created_at, v.name, h.conversation_id, 'handoff', h.reason
       from handoffs h join conversations c on c.id=h.conversation_id join visitors v on v.id=c.visitor_id order by h.created_at desc limit 25)
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
adminRouter.get('/conversations', wrap(async (req, res) => {
  const status = ['open', 'handed_off', 'closed', 'ended'].includes(req.query.status) ? req.query.status : null;
  const search_ = req.query.q ? `%${clean(req.query.q, 100)}%` : null;
  const product = req.query.product ? clean(req.query.product, 60) : null;
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const rows = (await q(`
    select c.id, c.started_at, c.ended_at, c.status, c.lang, c.turns, c.summary, v.name, v.contact, v.contact_type,
      (select m.content from messages m where m.conversation_id=c.id and m.role='user' order by m.id limit 1) first_question,
      (select array_agg(distinct m.product) from messages m where m.conversation_id=c.id and m.product is not null) products,
      exists(select 1 from leads l where l.conversation_id=c.id) has_lead,
      exists(select 1 from leads l where l.conversation_id=c.id and l.demo_requested) demo,
      (select count(*) from feedback f where f.conversation_id=c.id and f.thumb=-1)::int thumbs_down,
      (select count(*) from messages m where m.conversation_id=c.id and m.golden_ids is not null)::int approved_used,
      (select round(avg(f.rating), 1) from feedback f where f.conversation_id=c.id and f.kind='survey')::float rating
    from conversations c join visitors v on v.id=c.visitor_id
    where (c.turns > 0 or $6::boolean)
      and ($1::text is null or c.status=$1)
      and ($2::text is null or v.name ilike $2 or exists(select 1 from messages m where m.conversation_id=c.id and m.content ilike $2))
      and ($3::text is null or exists(select 1 from messages m where m.conversation_id=c.id and m.product=$3))
    order by c.started_at desc limit $4 offset $5`, [status, search_, product, limit, offset, req.query.all === '1'])).rows;
  res.json(rows.map((x) => ({ ...x, contact: decrypt(x.contact) })));
}));

adminRouter.get('/conversations/:id/detail', wrap(async (req, res) => {
  const conv = (await q(`select c.*, v.name, v.contact, v.contact_type, v.marketing_opt_in, v.first_page_url from conversations c join visitors v on v.id=c.visitor_id where c.id=$1`, [req.params.id])).rows[0];
  if (!conv) return res.status(404).json({ error: 'not_found' });
  const messages = (await q(`select id, role, content, tool_name, tool_input, blocked_reason, product, golden_ids, tokens_in, tokens_out, created_at
                             from messages where conversation_id=$1 order by id`, [req.params.id])).rows;
  const ids = [...new Set(messages.flatMap((m) => m.golden_ids || []).map(Number))];
  const golden = ids.length ? (await q('select id, question, product from golden_answers where id = any($1::bigint[])', [ids])).rows : [];
  const feedback = (await q('select * from feedback where conversation_id=$1 order by id', [req.params.id])).rows;
  const lead = (await q('select * from leads where conversation_id=$1', [req.params.id])).rows[0] || null;
  const handoffs = (await q('select * from handoffs where conversation_id=$1 order by id', [req.params.id])).rows;
  res.json({ ...conv, contact: decrypt(conv.contact), messages, golden, feedback, lead, handoffs });
}));

adminRouter.put('/leads/:id', wrap(async (req, res) => {
  const status = req.body?.status;
  if (!LEAD_STATUSES.includes(status)) return res.status(400).json({ error: 'bad_status' });
  await q('update leads set status=$2, updated_at=now() where id=$1', [req.params.id, status]);
  res.json({ ok: true });
}));

// ---------------- products (fine-tuning) ----------------
adminRouter.get('/products', wrap(async (_req, res) => {
  const by = async (sql) => Object.fromEntries((await q(sql)).rows.map((r) => [r.k ?? GENERAL, r]));
  const [chunks, golden, questions, down, leadsBy, notes] = await Promise.all([
    by(`select product k, count(*)::int chunks, count(distinct document_id)::int docs from kb_chunks where product is not null group by product`),
    by(`select coalesce(product, '${GENERAL}') k, count(*) filter (where active is not false)::int active, count(*)::int total, coalesce(sum(use_count), 0)::int used from golden_answers group by 1`),
    by(`select coalesce(product, '${GENERAL}') k, count(*)::int n from messages where role='user' and created_at > now() - interval '30 days' group by 1`),
    by(`select coalesce(m.product, '${GENERAL}') k, count(*)::int n from feedback f join messages m on m.id=f.message_id where f.thumb=-1 group by 1`),
    by(`select p k, count(*)::int n from leads, unnest(product_interest) p group by p`),
    by(`select product k, length(trim(notes)) > 0 has, updated_at from product_notes`),
  ]);
  res.json([...PRODUCTS, GENERAL].map((p) => ({
    product: p,
    docs: chunks[p]?.docs || 0, chunks: chunks[p]?.chunks || 0,
    approved: golden[p]?.active || 0, approved_total: golden[p]?.total || 0, approved_used: golden[p]?.used || 0,
    questions_30d: questions[p]?.n || 0, thumbs_down: down[p]?.n || 0, leads: leadsBy[p]?.n || 0,
    has_notes: !!notes[p]?.has, notes_updated_at: notes[p]?.updated_at || null,
  })));
}));

adminRouter.get('/products/:name', wrap(async (req, res) => {
  const name = clean(req.params.name, 60);
  if (![...PRODUCTS, GENERAL].includes(name)) return res.status(404).json({ error: 'unknown_product' });
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
    order by u.id desc limit 60`, [p])).rows;
  const docs = p ? (await q(`select d.id, d.url, d.title, d.kind, d.status, d.updated_at, count(c.id)::int chunks
                             from kb_documents d join kb_chunks c on c.document_id=d.id where c.product=$1 group by d.id order by d.title`, [p])).rows : [];
  res.json({ product: name, notes: notes.notes, notes_updated_at: notes.updated_at, golden, questions, docs });
}));

adminRouter.put('/products/:name/notes', wrap(async (req, res) => {
  const name = clean(req.params.name, 60);
  if (![...PRODUCTS, GENERAL].includes(name)) return res.status(404).json({ error: 'unknown_product' });
  await q(`insert into product_notes(product, notes) values($1,$2) on conflict(product) do update set notes=excluded.notes, updated_at=now()`, [name, clean(req.body?.notes, 6000)]);
  res.json({ ok: true });
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
  if (product && !PRODUCTS.includes(product)) return res.status(400).json({ error: 'unknown_product' });
  const msgId = Number.isInteger(req.body?.message_id) ? req.body.message_id : null;
  const row = (await q(`insert into golden_answers(message_id, question, variations, context, ideal_answer, product, reviewed_by, active, embedding)
                        values($1,$2,$3,$4,$5,$6,$7,$8,$9::vector) returning id`,
    [msgId, question, cleanVariations(req.body?.variations), clean(req.body?.context, 2000) || null, ideal, product, clean(req.body?.reviewed_by, 80) || 'dashboard', req.body?.active !== false, await embedOne(question)])).rows[0];
  res.json({ ok: true, id: Number(row.id) });
}));

adminRouter.put('/golden/:id', wrap(async (req, res) => {
  const cur = (await q('select * from golden_answers where id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'not_found' });
  const question = req.body?.question !== undefined ? clean(req.body.question, 500) : cur.question;
  const ideal = req.body?.ideal_answer !== undefined ? clean(req.body.ideal_answer, 3000) : cur.ideal_answer;
  if (!question || !ideal) return res.status(400).json({ error: 'question_and_answer_required' });
  let product = cur.product;
  if (req.body?.product !== undefined) {
    product = req.body.product && req.body.product !== GENERAL ? clean(req.body.product, 60) : null;
    if (product && !PRODUCTS.includes(product)) return res.status(400).json({ error: 'unknown_product' });
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
  res.json({ model: cfg.model, gateway: cfg.gateway.url, mock: !cfg.gateway.key, embeddings: cfg.embeddings.provider, golden_min_score: cfg.goldenMinScore, daily_budget_usd: cfg.dailyBudgetUsd, products: [...PRODUCTS, GENERAL] });
}));

/** Which approved answers would a question match, and how strongly? (no AI call) */
adminRouter.post('/match', wrap(async (req, res) => {
  const question = clean(req.body?.question, 1000);
  const product = req.body?.product && req.body.product !== 'auto' ? productParam(clean(req.body.product, 60)) : detectProduct(question);
  const all = await goldenMatches(question, { product, k: 10 });
  res.json({ product: product || GENERAL, min_score: cfg.goldenMinScore, matches: all.map((a) => ({ id: Number(a.id), question: a.question, matched: a.matched, score: a.sim })) });
}));
