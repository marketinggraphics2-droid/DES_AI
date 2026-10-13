// Conversation log: every message the visitor sees or sends goes through addMessage(), which gives it the next
// per-conversation sequence number. The dashboard and the AI history order by seq, so rows written by overlapping
// requests (or logged later by the widget) still read in the order the visitor saw them.
import { q } from './db.js';
import { maskPII } from './guardrails.js';
import { publish, touch } from './events.js';

const COLS = ['role', 'content', 'kind', 'tool_name', 'tool_input', 'tool_output', 'tokens_in', 'tokens_out', 'cache_read', 'cost_usd', 'blocked_reason',
  'product', 'golden_ids', 'incomplete', 'delivered', 'original_content', 'source', 'held'];

/** Insert one message with the next sequence number. Returns {id, seq}. */
export async function addMessage(conversationId, row) {
  const seq = (await q('update conversations set last_seq = coalesce(last_seq, 0) + 1, last_activity_at = now() where id=$1 returning last_seq', [conversationId])).rows[0]?.last_seq;
  if (seq === undefined) throw new Error('conversation not found');
  const cols = COLS.filter((c) => row[c] !== undefined);
  const r = await q(`insert into messages(conversation_id, seq, ${cols.join(', ')}) values($1, $2, ${cols.map((_, i) => '$' + (i + 3)).join(', ')}) returning id, created_at`,
    [conversationId, seq, ...cols.map((c) => row[c])]);
  const id = Number(r.rows[0].id);
  // live dashboard: the new row as the conversation view shows it
  touch(conversationId);
  publish('message.new', { conversation_id: conversationId, id, seq, created_at: r.rows[0].created_at, kind: row.kind || 'chat',
    ...Object.fromEntries(['role', 'content', 'tool_name', 'blocked_reason', 'product', 'golden_ids', 'incomplete', 'delivered', 'original_content', 'source', 'tokens_in', 'tokens_out', 'cost_usd'].map((k) => [k, row[k] ?? null])) });
  return { id, seq };
}

/** Update a stored message (final text of a streamed reply, flags). */
export async function updateMessage(id, fields) {
  const cols = Object.keys(fields).filter((c) => COLS.includes(c));
  if (!cols.length) return;
  await q(`update messages set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id=$1`, [id, ...cols.map((c) => fields[c])]);
}

// One chat turn at a time per conversation: a second message waits for the first reply instead of interleaving with it.
const chains = new Map();
export function serialize(conversationId, fn) {
  const prev = chains.get(conversationId) || Promise.resolve();
  const run = prev.catch(() => { }).then(fn);
  const tail = run.catch(() => { });
  chains.set(conversationId, tail);
  tail.then(() => { if (chains.get(conversationId) === tail) chains.delete(conversationId); });
  return run;
}

// Text the widget logs (sign-up replies, survey comments…): card / ID numbers masked like chat messages, and the
// contact details typed during sign-up replaced, because contact details live only in the visitors table.
// keep: DynamIQ's own contacts (normalised, as in routes.js) — shown in handoff / help bubbles, so they stay readable.
const EMAIL = /[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[a-z]{2,}/gi;
const PHONE = /(?:\+|\b00)?\d[\d\s().-]{6,}\d/g;
export function maskWidgetText(text, keep = []) {
  const own = (m) => { const d = m.toLowerCase().replace(/[^0-9a-z@.]/g, '').replace(/^0/, '63').replace(/^63/, ''); return keep.some((x) => x === d || (x.length > 6 && d.endsWith(x))); };
  return maskPII(String(text || '')).text
    .replace(EMAIL, (m) => (own(m) ? m : '[email]'))
    .replace(PHONE, (m) => (m.replace(/\D/g, '').length < 7 || own(m) ? m : '[phone]'));
}
