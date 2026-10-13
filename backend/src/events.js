// Live dashboard updates. Server-Sent Events: the updates only flow server → dashboard, SSE works with the session
// cookie, reconnects by itself and sends Last-Event-ID, so missed events are replayed from a short buffer.
// One server process is assumed; with several instances, swap the EventEmitter for Postgres LISTEN/NOTIFY here.
import { EventEmitter } from 'node:events';
import { can, maskContacts } from './permissions.js';

const bus = new EventEmitter(); bus.setMaxListeners(0);
const BUFFER = 1000;           // replay buffer for reconnects (~15 minutes at a busy pace)
const ACTIVE_MS = 2 * 60e3;    // a conversation is "live" for 2 minutes after its last activity
const TYPING_MS = 6000;        // a typing indicator without a refresh disappears after 6 s
const buf = [];
let lastId = 0;
const BOOT = Date.now().toString(36); // ids restart with the process; the dashboard resyncs when the boot id changes

/** permission needed to receive each event type */
const NEED = {
  'conversation.new': 'conversations.view', 'conversation.update': 'conversations.view', 'message.new': 'conversations.view',
  typing: 'conversations.view', presence: 'conversations.view', 'lead.update': 'leads.view',
  'review.count': 'finetune.manage', 'overview.tick': 'overview.view',
};

export function publish(type, data) {
  const ev = { id: ++lastId, type, data };
  buf.push(ev); if (buf.length > BUFFER) buf.shift();
  bus.emit('event', ev);
  if (type !== 'overview.tick' && type !== 'typing' && type !== 'presence') tickOverview();
}
// the Overview numbers are re-read by the dashboard at most every 5 s
let tickTimer = null;
function tickOverview() { if (!tickTimer) tickTimer = setTimeout(() => { tickTimer = null; publish('overview.tick', {}); }, 5000); tickTimer.unref?.(); }

// ---- presence: which conversations are active right now ----
const active = new Map(); // conversationId -> last activity (ms)
/** Something happened in a conversation (message, typing, open chat request). */
export function touch(conversationId) {
  if (!conversationId) return;
  const was = active.has(conversationId);
  active.set(conversationId, Date.now());
  if (!was) publish('presence', { conversation_id: conversationId, active: true });
}
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [id, at] of active) if (now - at > ACTIVE_MS) { active.delete(id); publish('presence', { conversation_id: id, active: false }); }
}, 15000); sweep.unref();
export const activeConversations = () => [...active.keys()];

// ---- typing: start / stop only, never the text; at most one start per conversation every 1.5 s ----
const lastTyping = new Map();
export function typing(conversationId, name, state) {
  const now = Date.now();
  if (state === 'start' && now - (lastTyping.get(conversationId) || 0) < 1500) return false;
  lastTyping.set(conversationId, state === 'start' ? now : 0);
  touch(conversationId);
  publish('typing', { conversation_id: conversationId, name: String(name || '').slice(0, 40), state: state === 'start' ? 'start' : 'stop', expires_ms: TYPING_MS });
  return true;
}

// ---- the stream (GET /api/admin/stream) ----
const clients = new Set();
export function streamHandler(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const role = req.user.role, full = can(role, 'contacts.full');
  const write = (ev) => {
    const need = NEED[ev.type];
    if (need && !can(role, need)) return; // e.g. a User never gets the Needs-review count
    res.write(`id: ${BOOT}.${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(full ? ev.data : maskContacts(ev.data))}\n\n`);
  };
  res.write('retry: 3000\n\n');
  // reconnect: replay what was missed, or ask for a full reload when the buffer no longer has it (or the server restarted)
  const [boot, seen] = String(req.get('last-event-id') || req.query.last_event_id || '').split('.');
  const since = Number(seen);
  if (boot && seen !== undefined) {
    const oldest = buf[0]?.id ?? lastId + 1;
    if (boot !== BOOT || !(since >= oldest - 1) || since > lastId) res.write('event: resync\ndata: {}\n\n');
    else for (const ev of buf) if (ev.id > since) write(ev);
  }
  res.write(`id: ${BOOT}.${lastId}\nevent: hello\ndata: ${JSON.stringify({ active: activeConversations() })}\n\n`);
  const on = (ev) => write(ev);
  bus.on('event', on);
  const hb = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  const client = { close() { clearInterval(hb); bus.off('event', on); try { res.end(); } catch { } } };
  clients.add(client);
  req.on('close', () => { client.close(); clients.delete(client); });
}
/** Server shutdown: end every open stream so the server can close. */
export function closeStreams() { for (const c of clients) c.close(); clients.clear(); }
