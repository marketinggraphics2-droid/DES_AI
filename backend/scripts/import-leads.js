// Import a leads CSV exported from a DES dashboard (Conversations & leads → Export → Download leads CSV) into this database.
//   npm run import:leads -- path/to/des-leads-YYYY-MM-DD.csv [--dry-run]
// Each row becomes a visitor, a conversation (same id as in the source when given) and a lead. Phone and email are stored
// encrypted with this server's keys, exactly like a sign-up. The CSV has no messages, so imported conversations have none.
// Safe to run again: rows whose conversation already exists here are skipped.
// With the embedded database (DATABASE_URL=pglite:…) stop the backend first: only one program may open it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from '../src/config.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry-run');
const fail = (m) => { console.error(m); process.exit(1); };
if (!file || !fs.existsSync(file)) fail('Give the CSV file: npm run import:leads -- path/to/des-leads.csv');

if (cfg.databaseUrl.startsWith('pglite:')) {
  try { await fetch(`http://127.0.0.1:${cfg.port}/api/health`, { signal: AbortSignal.timeout(1500) }); fail(`The backend is running on :${cfg.port}. Stop it first (npm run stop): the embedded database can only be opened by one program.`); }
  catch { /* not running: safe to open the database */ }
}

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((x) => x !== '')) rows.push(row); }
  return rows;
}
const [header, ...records] = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const need = ['created_at', 'name', 'phone', 'status'];
for (const k of need) if (!header.includes(k)) fail(`Not a DES leads CSV: column "${k}" is missing. Columns found: ${header.join(', ')}`);
const rowsIn = records.map((r) => Object.fromEntries(header.map((k, i) => [k, (r[i] ?? '').trim()])));

const { q, exec, pool, encrypt, hmac } = await import('../src/db.js');
const here = path.dirname(fileURLToPath(import.meta.url));
await exec(fs.readFileSync(path.join(here, '../sql/schema.sql'), 'utf8'));

const STATUSES = ['new', 'contacted', 'call_again', 'qualified', 'not_interested'];
const OLD_STATUS = { closed: 'not_interested', interested: 'qualified' }; // statuses from older exports
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const when = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? new Date() : d; };
const yes = (v) => /^(true|t|1|yes)$/i.test(v);
let added = 0, skipped = 0, bad = 0;
for (const r of rowsIn) {
  if (!r.name || (!r.phone && !r.email)) { bad++; continue; } // older sign-ups may have an email but no mobile
  const convId = uuid.test(r.conversation_id) ? r.conversation_id : null;
  if (convId && (await q('select 1 from conversations where id = $1', [convId])).rowCount) { skipped++; continue; }
  if (dry) { added++; continue; }
  const at = when(r.created_at);
  const [first, ...rest] = r.name.split(/\s+/);
  const phoneHash = r.phone ? hmac(r.phone) : null, emailHash = r.email ? hmac(r.email) : null;
  const phoneEnc = r.phone ? encrypt(r.phone) : null, emailEnc = r.email ? encrypt(r.email) : null;
  // contact mirrors the phone (or the email when there is no phone), like a sign-up does
  const v = await q(`insert into visitors(name, first_name, last_name, phone, phone_hash, phone_type, email, email_hash, email_type, contact, contact_hash, contact_type,
                     consent_at, consent_version, consent_method, marketing_opt_in, lang, person_key, created_at)
                     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$12,$13,$14,$10,'imported','import',$11,'en',$13,$10) returning id`,
    [r.name, first, rest.join(' ') || null, phoneEnc, phoneHash, r.phone ? (r.phone_type || 'mobile') : null, emailEnc, emailHash, r.email_type || null, at, yes(r.marketing_opt_in),
      phoneEnc || emailEnc, phoneHash || emailHash, r.phone ? 'mobile' : 'email']);
  const c = await q(`insert into conversations(${convId ? 'id, ' : ''}visitor_id, started_at, last_activity_at, status, lang, turns, summary)
                     values(${convId ? '$5, ' : ''}$1, $2, $2, $3, 'en', 0, $4) returning id`,
    [v.rows[0].id, at, 'closed', 'Imported lead (the chat itself was not part of the export).', ...(convId ? [convId] : [])]);
  await q(`insert into leads(visitor_id, conversation_id, company, industry, need, team_size, current_system, product_interest, demo_requested, status, created_at, updated_at)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
    [v.rows[0].id, c.rows[0].id, r.company || null, r.industry || null, r.need || null, r.team_size || null, r.current_system || null,
      (r.products || '').split(/;\s*/).map((x) => x.trim()).filter(Boolean), yes(r.demo_requested), STATUSES.includes(OLD_STATUS[r.status] || r.status) ? (OLD_STATUS[r.status] || r.status) : 'new', at]);
  added++;
}
console.log(`${dry ? 'Dry run: would import' : 'Imported'} ${added} lead${added === 1 ? '' : 's'} · ${skipped} already here · ${bad} skipped (no name, or neither mobile nor email).`);
await pool.end();
process.exit(0);
