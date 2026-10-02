import nodemailer from 'nodemailer';
import { cfg } from './config.js';
import { q, decrypt } from './db.js';

const transport = cfg.smtp.host
  ? nodemailer.createTransport({ host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.port === 465, auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined })
  : nodemailer.createTransport({ jsonTransport: true }); // dev: logs JSON to console

export async function sendHandoff(conversationId, reason) {
  const c = (await q(`select c.id, c.lang, v.name, v.contact, v.contact_type, v.first_page_url, l.need, l.product_interest, l.company, l.industry, l.team_size, l.current_system, l.demo_requested
                      from conversations c join visitors v on v.id=c.visitor_id left join leads l on l.conversation_id=c.id where c.id=$1`, [conversationId])).rows[0];
  if (!c) return;
  const msgs = (await q(`select role, content, created_at from messages where conversation_id=$1 and role in ('user','assistant') order by id`, [conversationId])).rows;
  const transcript = msgs.map((m) => `[${m.created_at.toISOString().slice(11, 16)}] ${m.role === 'user' ? c.name : 'DES'}: ${m.content}`).join('\n');
  const subject = `[DES] ${c.demo_requested ? 'Demo request' : 'Handoff'} — ${c.name}${c.company ? ' · ' + c.company : ''}${c.product_interest?.length ? ' · ' + c.product_interest.join(', ') : ''}`;
  const text = `Visitor: ${c.name}
Contact: ${decrypt(c.contact) || '(none given)'} (${c.contact_type || '-'})
Company: ${c.company || '-'} · Industry: ${c.industry || '-'} · Team: ${c.team_size || '-'} · Current system: ${c.current_system || '-'}
Need: ${c.need || '-'}
Products: ${(c.product_interest || []).join(', ') || '-'}
Reason: ${reason}
Page: ${c.first_page_url || '-'}
Conversation: ${c.id}

--- Transcript ---
${transcript}
`;
  const info = await transport.sendMail({ from: cfg.mailFrom, to: cfg.salesEmail, subject, text });
  if (!cfg.smtp.host) console.log('[mail:dev]', subject, '\n', text.slice(0, 600));
  return info;
}
