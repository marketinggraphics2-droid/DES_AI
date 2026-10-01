// Nightly: Data Privacy Act retention. Deletes visitors (cascades conversations/messages/leads/feedback)
// older than RETENTION_MONTHS unless their lead is still being worked; purges ip hashes after 7 days; trims rate events.
import { cfg } from '../src/config.js';
import { pool, q } from '../src/db.js';

const del = await q(`delete from visitors v where v.created_at < now() - ($1 || ' months')::interval
  and not exists (select 1 from leads l where l.visitor_id = v.id and l.status in ('contacted','qualified'))`, [String(cfg.retentionMonths)]);
await q(`update visitors set ip_hash = null where ip_hash is not null and created_at < now() - interval '7 days'`);
await q(`delete from rate_events where at < now() - interval '2 days'`);
console.log('retention: removed', del.rowCount, 'visitors');
await pool.end();
