// Sample chats for local testing: imported leads (npm run import:leads) come without their chat, so the dashboard shows
// empty transcripts. This writes a believable chat for each one, built from the lead's own need and products.
//   npm run sample:chats             add sample chats to imported conversations that have no messages
//   npm run sample:chats -- --remove delete every sample message again and put the import summary back
// Every message it writes has source = 'sample', and the conversation summary starts with "Sample chat", so nobody takes
// them for real chats. For a local / test database only: it refuses to run when NODE_ENV=production.
// With the embedded database (DATABASE_URL=pglite:…) stop the backend first: only one program may open it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from '../src/config.js';

const remove = process.argv.includes('--remove');
const fail = (m) => { console.error(m); process.exit(1); };
if (process.env.NODE_ENV === 'production') fail('Sample chats are for a local or test database only (NODE_ENV=production).');
if (cfg.databaseUrl.startsWith('pglite:')) {
  try { await fetch(`http://127.0.0.1:${cfg.port}/api/health`, { signal: AbortSignal.timeout(1500) }); fail(`The backend is running on :${cfg.port}. Stop it first (npm run stop): the embedded database can only be opened by one program.`); }
  catch { /* not running: safe to open the database */ }
}
const { q, exec, pool } = await import('../src/db.js');
const here = path.dirname(fileURLToPath(import.meta.url));
await exec(fs.readFileSync(path.join(here, '../sql/schema.sql'), 'utf8'));
const IMPORT_SUMMARY = 'Imported lead (the chat itself was not part of the export).';

if (remove) {
  const convs = (await q(`select distinct conversation_id id from messages where source = 'sample'`)).rows;
  const del = await q(`delete from messages where source = 'sample'`);
  for (const c of convs) await q(`update conversations set turns = 0, last_seq = 0, summary = $2 where id = $1`, [c.id, IMPORT_SUMMARY]);
  console.log(`Removed ${del.rowCount} sample messages from ${convs.length} conversations.`);
  await pool.end(); process.exit(0);
}

// What DES would say about each product (no prices: the live bot never quotes them either)
const ANSWERS = {
  'SAP Business One': 'SAP Business One puts accounting, inventory, sales and purchasing in one system, with real-time reports for owners and managers. It is BIR-compliant and fits growing businesses from a handful of users up.',
  'IQ Ecom': 'IQ Ecom connects your online store to inventory and accounting, so orders, stock and invoices update in one place. It works with the major marketplaces and your own website.',
  'IQ Tax': 'IQ Tax prepares your BIR forms and filings straight from your transactions, including VAT and non-VAT returns and withholding tax, so month-end and quarter-end take far less manual work.',
  'IQ Barcode': 'IQ Barcode updates your inventory in real time as items are scanned in and out, with smartphones or dedicated scanners, which cuts manual counting errors.',
  'IQ People': 'IQ People handles HR and payroll: time and attendance (including biometrics), leave, payroll computation with government contributions, and 13th month pay.',
  'BIR CAS Accreditation': 'We help you get your computerized accounting system registered with the BIR (CAS), from preparing the requirements to the system demo the BIR asks for.',
  'IQ Ai': 'IQ Ai adds AI assistants to your business systems, for example answering customer questions or summarising reports from your own data.',
};
const answerFor = (products) => {
  const known = products.filter((p) => ANSWERS[p]);
  const parts = known.length ? known.slice(0, 2).map((p) => ANSWERS[p]) : ['DynamIQ implements business systems for Philippine companies: SAP Business One for ERP, plus our IQ products for e-commerce, tax, inventory and HR.'];
  return `${parts.join('\n\n')}\n\nWould you like a free business analysis or a demo so a consultant can show how it fits your setup?`;
};
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

const targets = (await q(`select c.id, c.started_at, v.name, l.need, l.product_interest, l.demo_requested, l.company
  from conversations c join visitors v on v.id = c.visitor_id join leads l on l.conversation_id = c.id
  where v.consent_method = 'import' and not exists (select 1 from messages m where m.conversation_id = c.id)
  order by c.started_at`)).rows;

let added = 0;
for (const c of targets) {
  const products = (c.product_interest || []).filter(Boolean);
  const product = products[0] || null;
  const need = String(c.need || '').trim();
  const question = !need || /^demo requested\.?$/i.test(need) ? (product ? `Can I see a demo of ${product}?` : 'I would like to request a demo.') : need;
  let t = new Date(c.started_at).getTime(), seq = 0, turns = 0;
  const at = (sec) => new Date((t += sec * 1000));
  const msg = async (role, content, { kind = 'chat', prod = null, tool = null } = {}) => {
    seq++; if (role === 'user' && kind === 'chat') turns++;
    await q(`insert into messages(conversation_id, role, content, tool_name, product, seq, kind, source, created_at) values($1,$2,$3,$4,$5,$6,$7,'sample',$8)`,
      [c.id, role, content, tool, prod, seq, kind, at(kind === 'script' ? 8 : 25)]);
  };
  await msg('assistant', "Hi there! I'm DES, DynamIQ's assistant. Something slowing your business down? Let's figure it out together.", { kind: 'script' });
  await msg('user', question, { prod: product });
  await msg('assistant', 'Happy to help with that. So I can follow up properly, may I have your name?', { kind: 'script' });
  await msg('user', c.name, { kind: 'script' });
  await msg('assistant', `Nice to meet you, ${firstName(c.name)}! What's the best mobile number to reach you?`, { kind: 'script' });
  await msg('user', '[phone]', { kind: 'script' }); // the live widget never stores the number in the chat either
  await msg('assistant', answerFor(products), { prod: product });
  await msg('tool', 'save_lead', { tool: 'save_lead' });
  if (c.demo_requested) {
    await msg('user', 'Yes, please set up a demo.', { prod: product });
    await msg('assistant', `Great! I've passed your demo request to our team${c.company ? ` for ${c.company}` : ''}. A consultant will call you on your mobile number to agree on a time.`, { prod: product });
    await msg('tool', 'book_demo', { tool: 'book_demo' });
  } else {
    await msg('user', 'Thanks, that helps. Someone can contact me.', { prod: product });
    await msg('assistant', 'You’re welcome! A consultant will reach out on your mobile number. Is there anything else I can help with?', { prod: product });
  }
  await msg('assistant', 'If you have a moment, I’d love to hear how this went.', { kind: 'script' });
  const summary = `Sample chat (generated for testing). Asked about ${products.length ? products.join(', ') : 'DynamIQ solutions'}${c.demo_requested ? ' and requested a demo' : ''}.`;
  await q(`update conversations set turns = $2, last_seq = $3, last_activity_at = $4, summary = $5 where id = $1`, [c.id, turns, seq, new Date(t), summary]);
  added++;
}
console.log(`Added sample chats to ${added} imported conversation${added === 1 ? '' : 's'} (${targets.length - added} skipped). Remove them with: npm run sample:chats -- --remove`);
await pool.end();
process.exit(0);
