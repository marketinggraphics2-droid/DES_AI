// Tools the model may call. Strict JSON schemas; the server validates and owns all side effects.
// Contact details never come from the model — they come from the onboarding record.
import { q } from './db.js';
import { searchCached, PRODUCTS } from './retrieval.js';
import { sendHandoff } from './mailer.js';
import { addMessage } from './log.js';
import { publish } from './events.js';

export const toolDefs = [
  {
    name: 'save_lead',
    description: 'Record or update what the visitor needs so Sales can follow up. Call as soon as the need and likely product are clear; call again to add details.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        need: { type: 'string', description: 'One sentence: the problem or goal in the visitor\'s words', maxLength: 300 },
        product_interest: { type: 'array', items: { type: 'string', enum: ['SAP Business One', 'IQ Ai', 'IQ People', 'IQ Ecom', 'IQ Portal', 'IQ Tax', 'IQ Workplace', 'IQ Desk', 'IQ Barcode', 'IQ Link', 'IQ Tech Institute', 'IQ REM', 'BIR CAS Accreditation', 'Unknown'] } },
        company: { type: ['string', 'null'], maxLength: 120 },
        industry: { type: ['string', 'null'], maxLength: 80 },
        team_size: { type: ['string', 'null'], maxLength: 40 },
        current_system: { type: ['string', 'null'], maxLength: 80 },
      },
      required: ['need', 'product_interest', 'company', 'industry', 'team_size', 'current_system'],
      additionalProperties: false,
    },
  },
  {
    name: 'book_demo',
    description: 'The visitor agreed to a free demo / business analysis. Flags the lead and notifies Sales. Idempotent per conversation.',
    strict: true,
    input_schema: { type: 'object', properties: { preferred_time: { type: ['string', 'null'], description: 'Free text, e.g. "next week mornings"', maxLength: 120 } }, required: ['preferred_time'], additionalProperties: false },
  },
  {
    name: 'handoff_to_human',
    description: 'Hand the conversation to a sales consultant. Use whenever you cannot help cleanly, the visitor asks for a person, pricing, contracts, or anything only a person can decide. Idempotent per conversation.',
    strict: true,
    input_schema: { type: 'object', properties: { reason: { type: 'string', maxLength: 200 } }, required: ['reason'], additionalProperties: false },
  },
  {
    name: 'search_kb',
    description: 'Search the content of dynamiqes.com. Call it BEFORE answering any question about what a DynamIQ product or service does, its features, modules, integrations, BIR / tax compliance, implementation, cloud or on-premise setup, industries served, clients, events or company details. '
      + 'Write a short keyword query in English (translate Filipino). Set product when the question is about one product, otherwise null. Do not call it for greetings, thanks or small talk. Results repeated within this chat are instant.',
    strict: true,
    input_schema: { type: 'object', properties: {
      query: { type: 'string', maxLength: 200, description: 'Short keyword query, e.g. "IQ People 13th month pay computation"' },
      product: { type: ['string', 'null'], enum: [...PRODUCTS, null], description: 'Limit to one product, or null' },
    }, required: ['query', 'product'], additionalProperties: false },
  },
  {
    name: 'get_open_jobs',
    description: 'List current job openings from the careers pages.',
    strict: true,
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** @returns {Promise<{result: string, event?: object}>} */
export async function runTool(name, input, ctx) {
  const { conversationId, visitorId } = ctx;
  switch (name) {
    case 'save_lead': {
      const pi = (input.product_interest || []).filter((p) => p !== 'Unknown');
      await q(`insert into leads(visitor_id, conversation_id, need, product_interest, company, industry, team_size, current_system)
               values($1,$2,$3,$4,$5,$6,$7,$8)
               on conflict (conversation_id) do update set
                 need = coalesce(excluded.need, leads.need),
                 product_interest = (select array(select distinct unnest(leads.product_interest || excluded.product_interest))),
                 company = coalesce(excluded.company, leads.company), industry = coalesce(excluded.industry, leads.industry),
                 team_size = coalesce(excluded.team_size, leads.team_size), current_system = coalesce(excluded.current_system, leads.current_system),
                 updated_at = now()`,
        [visitorId, conversationId, input.need?.slice(0, 300) || null, pi, input.company, input.industry, input.team_size, input.current_system]);
      publish('lead.update', { conversation_id: conversationId, product_interest: pi, need: input.need?.slice(0, 300) || null });
      return { result: 'Lead saved.', event: { type: 'lead', product_interest: pi } };
    }
    case 'book_demo': {
      await q(`insert into leads(visitor_id, conversation_id, need, demo_requested) values($1,$2,'demo requested',true)
               on conflict (conversation_id) do update set demo_requested = true, updated_at = now()`, [visitorId, conversationId]);
      publish('lead.update', { conversation_id: conversationId, demo_requested: true });
      const h = await handoff(ctx, `demo requested${input.preferred_time ? ' · ' + input.preferred_time : ''}`);
      return { result: h.already ? 'Demo already requested; Sales notified earlier.' : 'Demo request sent to Sales. Tell the visitor the team will reach them within 24 hours (Mon–Fri) at the contact they gave.', event: { type: 'handoff', reason: 'demo' } };
    }
    case 'handoff_to_human': {
      const h = await handoff(ctx, input.reason);
      return { result: h.already ? 'Already handed off to Sales in this conversation.' : 'Handed off. Tell the visitor a consultant will reach them within 24 hours (Mon–Fri) and give the direct contact.', event: { type: 'handoff', reason: input.reason } };
    }
    case 'search_kb': {
      const product = PRODUCTS.includes(input.product) ? input.product : null;
      const { rows, cached } = await searchCached(ctx.conversationId, String(input.query || '').slice(0, 200), { k: 4, product });
      (ctx.sources ||= []).push(...rows);
      ctx.searches = (ctx.searches || 0) + 1; if (cached) ctx.cachedSearches = (ctx.cachedSearches || 0) + 1;
      return { result: rows.length ? rows.map((r) => `<doc url="${r.url}" title="${(r.title || '').replace(/"/g, "'")}"${r.section ? ` section="${r.section.replace(/"/g, "'")}"` : ''}>\n${r.chunk}\n</doc>`).join('\n') : 'No matching content on dynamiqes.com. Do not guess: offer a consultant.' };
    }
    case 'get_open_jobs': {
      const r = await q(`select title, url from kb_documents where kind='career' and status='active' order by title`);
      return { result: r.rows.length ? r.rows.map((j) => `- ${j.title.replace(/\s*[-–|].*DynamIQ.*$/i, '')} — ${j.url}`).join('\n') : 'No openings listed right now; HR keeps CVs on file at hr@dynamiqes.com.' };
    }
    default:
      return { result: `Unknown tool ${name}` };
  }
}

export async function handoff(ctx, reason) {
  const { conversationId } = ctx;
  const prev = await q('select 1 from handoffs where conversation_id=$1 limit 1', [conversationId]);
  if (prev.rowCount) return { already: true };
  await q(`insert into handoffs(conversation_id, reason) values($1,$2)`, [conversationId, reason]);
  await q(`update conversations set status='handed_off' where id=$1`, [conversationId]);
  publish('conversation.update', { id: conversationId, status: 'handed_off', handoff: reason });
  await addMessage(conversationId, { role: 'system', kind: 'event', content: 'Handed to Sales: ' + reason }).catch(() => { });
  try {
    await sendHandoff(conversationId, reason);
    await q('update handoffs set emailed_at=now() where conversation_id=$1', [conversationId]);
  } catch (e) { console.error('handoff mail failed', e.message); }
  return { already: false };
}
