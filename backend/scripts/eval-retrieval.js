// Before/after evaluation of website retrieval: `npm run eval`.
// Runs the same 20 questions against two isolated test backends (RETRIEVAL_MODE=auto vs tool, real AI, temp
// databases) and writes docs/eval/retrieval-wave2.md: tokens, cost and latency per answer, searches made, and a
// key-fact checklist score per answer, with both answers side by side for a human read.
import fs from 'node:fs';
import path from 'node:path';
import { testEnv, tempDb, prepareDb, startServer, stopServer, ident, api, ADMIN } from '../tests/lib.mjs';

// [question, expected facts (each group: any of the alternatives must appear), follow-up of the previous question?]
const QUESTIONS = [
  ['What is IQ Barcode?', [/barcode|scan/i, /inventor|warehouse|stock/i]],
  ['Does IQ People compute 13th month pay?', [/13th/i, /payroll|IQ People/i]],
  ['Can SAP Business One run in the cloud?', [/cloud/i]],
  ['Do you handle BIR CAS registration?', [/BIR/i, /CAS|Computerized Accounting/i]],
  ['Can you connect Shopee or Lazada orders to SAP?', [/shopee|lazada|marketplace|e-?commerce/i, /IQ Link|IQ Ecom|integrat|connect|sync/i]],
  ['What does IQ Tax do?', [/tax/i, /BIR|form|2307|2550|1601|alphalist/i]],
  ['Which product helps with HR and timekeeping?', [/IQ People/i]],
  ['What is IQ Portal?', [/portal/i, /customer|vendor|supplier|dealer|employee|self-service/i]],
  ['Do you offer SAP Business One training?', [/training|IQ Tech Institute|course|learn/i]],
  ['What industries do you serve?', [/manufactur|distribut|retail|trading|food|pharma/i]],
  ['Who are some of your clients?', [/MacroAsia|Bridgestone|Presline|Tosoh|Florabel|Cecile|Metalink|Toyo|Kenstand|Spartans|Intelligent Skin/i]],
  ['Where is your office?', [/Quezon|Manila|Cebu|Philippines/i]],
  ['How long does an SAP Business One implementation take?', [/month|week/i]],
  ['Magkano ang SAP Business One?', [/demo|analysis|analisis|consult|proposal/i], { noPrice: true }],
  ['Ano ang IQ Ecom?', [/ecom|online|store|e-?commerce|tindahan/i]],
  ['Hi', [/help|tulong|DES|assist/i], { smallTalk: true }],
  ['What is IQ Link?', [/integrat|connect|sync|link/i]],
  ['Does it work with POS systems?', [/POS|point.of.sale/i], { followUp: true }],
  ['Tell me about SAP Business One for distributors', [/inventor|distribut|warehouse|stock/i]],
  ['what about for retail?', [/retail|store|POS|branch/i], { followUp: true }],
];

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const PRICE = /₱|\bPHP\s?\d|\$\s?\d|\d{2,3},\d{3}/;

async function runMode(mode, port) {
  const env = testEnv(port, tempDb(), { RETRIEVAL_MODE: mode, RATE_MSG_PER_10MIN: '200', CHAT_LLM_SCREEN: 'true' });
  prepareDb(env);
  const { proc, base } = await startServer(env);
  const A = api(base);
  const out = [];
  let s, id;
  for (const [question, facts, opts = {}] of QUESTIONS) {
    if (!opts.followUp) { id = ident(); s = await A.session(id); }
    const t0 = Date.now();
    const c = await A.chat(s.token, question, id);
    const ms = Date.now() - t0;
    const det = (await A.req('GET', `/api/admin/conversations/${s.json.session_id}/detail`, { admin: true })).json;
    const row = det.messages.filter((m) => m.role === 'assistant').at(-1) || {};
    const text = c.done?.text || '';
    const hits = facts.filter((re) => re.test(text)).length;
    let score = text.trim() ? hits / facts.length : 0;
    if (opts.noPrice && PRICE.test(text)) score = 0;
    out.push({ question, mode, text, blocked: c.done?.blocked || c.error?.code || null, ms, tokensIn: row.tokens_in || 0, tokensOut: row.tokens_out || 0,
      usd: Number(row.cost_usd || 0), searches: c.done?.searches || 0, sources: (c.done?.sources || []).map((x) => x.url), score, opts });
    console.log(`[${mode}] ${question} → ${Math.round(score * 100)}% · in ${row.tokens_in} out ${row.tokens_out} · $${Number(row.cost_usd || 0).toFixed(5)} · ${c.done?.searches || 0} search · ${ms} ms`);
  }
  await stopServer(base, proc);
  return out;
}

const auto = await runMode('auto', 8794);
const tool = await runMode('tool', 8795);

const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
const avg = (rows, k) => sum(rows, k) / rows.length;
const pct = (x) => Math.round(x * 100) + '%';
const usd = (x) => '$' + x.toFixed(5);
const lines = [];
lines.push('# Retrieval evaluation: automatic vs on-demand website search', '');
lines.push(`Run: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · model ${process.env.MODEL || 'gemini-3.5-flash-lite'} · ${QUESTIONS.length} questions, same questions and order in both modes.`, '');
lines.push('- **auto** (before): the 6 best website sections are attached to every message.');
lines.push('- **tool** (after): no sections attached; the AI calls `search_kb` when it needs facts (forced for product / capability questions without an approved answer), results cached per conversation.', '');
lines.push('Cost is per answer, exact, as reported by IQGateway. Token counts are estimated from the gateway credits (its streams carry no token usage). The topic screen, identical in both modes, is excluded. Quality = share of expected key facts present in the answer (0 if a price was quoted or the reply was empty).', '');
lines.push('| | auto (before) | tool (after) | change |', '|---|---|---|---|');
const row = (label, a, b, fmt, lowerIsBetter = true) => { const d = a ? (b - a) / a : 0; lines.push(`| ${label} | ${fmt(a)} | ${fmt(b)} | ${(d > 0 ? '+' : '') + Math.round(d * 100)}%${lowerIsBetter ? (d < 0 ? ' ✓' : '') : (d >= 0 ? ' ✓' : '')} |`); };
row('Input tokens per answer', avg(auto, 'tokensIn'), avg(tool, 'tokensIn'), (x) => Math.round(x).toString());
row('Output tokens per answer', avg(auto, 'tokensOut'), avg(tool, 'tokensOut'), (x) => Math.round(x).toString());
row('Cost per answer', avg(auto, 'usd'), avg(tool, 'usd'), usd);
row('Latency per answer (ms)', avg(auto, 'ms'), avg(tool, 'ms'), (x) => Math.round(x).toString());
row('Quality (key facts present)', avg(auto, 'score'), avg(tool, 'score'), pct, false);
lines.push(`| Searches made | ${sum(auto, 'searches')} | ${sum(tool, 'searches')} | |`, '');
const verdict = avg(tool, 'score') >= avg(auto, 'score') ? 'PASS: quality did not drop.' : 'HOLD: quality dropped; keep RETRIEVAL_MODE=auto until fixed.';
lines.push(`**Gate:** ${verdict}`, '');
lines.push('## Per question', '', '| # | Question | auto: quality · in/out tokens · cost | tool: quality · in/out tokens · cost · searches |', '|---|---|---|---|');
QUESTIONS.forEach(([q], i) => { const a = auto[i], b = tool[i]; lines.push(`| ${i + 1} | ${q}${QUESTIONS[i][2]?.followUp ? ' *(follow-up)*' : ''} | ${pct(a.score)} · ${a.tokensIn}/${a.tokensOut} · ${usd(a.usd)} | ${pct(b.score)} · ${b.tokensIn}/${b.tokensOut} · ${usd(b.usd)} · ${b.searches} |`); });
lines.push('', '## Answers side by side', '');
QUESTIONS.forEach(([q], i) => {
  lines.push(`### ${i + 1}. ${q}`, '', `**auto** (${pct(auto[i].score)}${auto[i].blocked ? ', ' + auto[i].blocked : ''}):`, '', '> ' + auto[i].text.replace(/\n/g, '\n> '), '',
    `**tool** (${pct(tool[i].score)}${tool[i].blocked ? ', ' + tool[i].blocked : ''}, ${tool[i].searches} search${tool[i].searches === 1 ? '' : 'es'}):`, '', '> ' + tool[i].text.replace(/\n/g, '\n> '), '');
});
const outFile = path.join(ROOT, '..', 'docs', 'eval', 'retrieval-wave2.md');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, lines.join('\n') + '\n');
console.log('\n' + lines.slice(0, 20).join('\n'));
console.log('\nreport:', outFile);
process.exit(0);
