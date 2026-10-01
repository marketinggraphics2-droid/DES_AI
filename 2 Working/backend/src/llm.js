// Claude call with tools + streaming (manual loop so we control SSE, guardrails and the tool side effects).
// MOCK mode (no ANTHROPIC_API_KEY): answers from the retrieved chunks with canned phrasing so the stack runs offline.
import Anthropic from '@anthropic-ai/sdk';
import { cfg, isMock } from './config.js';
import { toolDefs, runTool } from './tools.js';
import { addUsage } from './db.js';

const client = isMock() ? null : new Anthropic({ apiKey: cfg.anthropicKey });

/**
 * @param {object} p
 * @param {string} p.system            stable system prompt (cached)
 * @param {Array}  p.history           prior turns [{role, content}]
 * @param {string} p.userTurn          context block + the visitor message
 * @param {object} p.ctx               {conversationId, visitorId}
 * @param {(delta:string)=>void} p.onText
 * @param {(ev:object)=>void}  p.onEvent
 * @returns {Promise<{text:string, usage:{in:number,out:number,cache:number}, toolCalls:Array}>}
 */
export async function answer({ system, history, userTurn, ctx, onText, onEvent }) {
  if (isMock()) return mockAnswer({ userTurn, ctx, onText, onEvent });

  const messages = [...history, { role: 'user', content: userTurn }];
  const usage = { in: 0, out: 0, cache: 0 };
  const toolCalls = [];
  let finalText = '';

  for (let round = 0; round < 4; round++) {
    const stream = client.messages.stream({
      model: cfg.model,
      max_tokens: cfg.maxOutputTokens,
      output_config: { effort: cfg.effort },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: toolDefs,
      messages,
    });
    let roundText = '';
    stream.on('text', (delta) => { roundText += delta; onText?.(delta); });
    const msg = await stream.finalMessage();

    usage.in += msg.usage.input_tokens; usage.out += msg.usage.output_tokens; usage.cache += msg.usage.cache_read_input_tokens || 0;
    finalText += roundText;

    if (msg.stop_reason === 'refusal') { onEvent?.({ type: 'refusal', category: msg.stop_details?.category || null }); break; }
    if (msg.stop_reason === 'max_tokens' && msg.content.some((b) => b.type === 'tool_use')) { onEvent?.({ type: 'error', message: 'tool input truncated' }); break; }
    const toolUses = msg.content.filter((b) => b.type === 'tool_use');
    if (msg.stop_reason !== 'tool_use' || toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: msg.content });
    const results = [];
    for (const tu of toolUses) {
      let out;
      try { out = await runTool(tu.name, tu.input, ctx); }
      catch (e) { out = { result: `Tool error: ${e.message}` }; }
      toolCalls.push({ name: tu.name, input: tu.input, output: out.result });
      if (out.event) onEvent?.(out.event);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.result });
    }
    messages.push({ role: 'user', content: results });
  }

  await addUsage(usage.in, usage.out, usage.cache);
  return { text: finalText.trim(), usage, toolCalls };
}

/** Optional Haiku classifier for ambiguous inputs (regex classifier runs first in guardrails.js). */
export async function classifyLLM(text) {
  if (isMock()) return 'on_topic';
  const r = await client.messages.create({
    model: cfg.guardModel, max_tokens: 10,
    system: 'Classify the website-chat message for a Philippine SAP/ERP reseller. Reply with exactly one label: on_topic | off_topic | abuse | competitor_probe | support_request',
    messages: [{ role: 'user', content: text.slice(0, 600) }],
  });
  const label = r.content.find((b) => b.type === 'text')?.text.trim().toLowerCase() || 'on_topic';
  await addUsage(r.usage.input_tokens, r.usage.output_tokens, 0);
  return ['on_topic', 'off_topic', 'abuse', 'competitor_probe', 'support_request'].includes(label) ? label : 'on_topic';
}

export async function summarize(transcript) {
  if (isMock()) return transcript.slice(0, 140);
  const r = await client.messages.create({
    model: cfg.guardModel, max_tokens: 80,
    system: 'Summarize this sales-chat transcript in one line (max 20 words) for a CRM list: who, what they need, which product.',
    messages: [{ role: 'user', content: transcript.slice(0, 6000) }],
  });
  await addUsage(r.usage.input_tokens, r.usage.output_tokens, 0);
  return r.content.find((b) => b.type === 'text')?.text.trim() || '';
}

// ---------------- mock ----------------
async function mockAnswer({ userTurn, ctx, onText, onEvent }) {
  const msg = (userTurn.match(/<message>([\s\S]*?)<\/message>/) || [, userTurn])[1].trim();
  const lang = (userTurn.match(/<lang>(\w+)<\/lang>/) || [, 'en'])[1];
  const docs = [...userTurn.matchAll(/<doc url="([^"]+)" title="([^"]*)"[^>]*>\n([\s\S]*?)<\/doc>/g)].map((m) => ({ url: m[1], title: m[2], chunk: m[3] }));
  const toolCalls = [];
  let text;
  if (/demo|consultant|talk to|human|agent|kausapin/i.test(msg)) {
    const out = await runTool('handoff_to_human', { reason: 'mock: visitor asked for a person/demo' }, ctx); toolCalls.push({ name: 'handoff_to_human', output: out.result }); onEvent?.(out.event);
    text = lang === 'fil' ? 'Sige — ikokonekta kita sa sales consultant namin. Kokontakin ka nila sa loob ng 24 oras (Lun–Biy). Pwede ka ring tumawag sa +63 917-630-4848.' : "Sure — I'll connect you with one of our sales consultants. They'll reach you within 24 hours (Mon–Fri) at the contact you gave, or you can call +63 917-630-4848.";
  } else if (docs.length) {
    const d = docs[0];
    const first = d.chunk.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/).slice(0, 2).join(' ');
    const out = await runTool('save_lead', { need: msg.slice(0, 200), product_interest: [docs[0].title.match(/IQ \w+|SAP Business One/)?.[0] || 'Unknown'], company: null, industry: null, team_size: null, current_system: null }, ctx);
    toolCalls.push({ name: 'save_lead', output: out.result }); onEvent?.(out.event);
    text = `${lang === 'fil' ? '[MOCK] Base sa aming website:' : '[MOCK] From our website:'} ${first}\n\n${lang === 'fil' ? 'Higit pa dito' : 'More here'}: ${d.url}\n\n${lang === 'fil' ? 'Ano ang ginagawa ng negosyo mo, para mairekomenda ko ang tamang fit?' : 'What does your business do, so I can point you to the right fit?'}`;
  } else {
    text = lang === 'fil' ? '[MOCK] Wala akong sapat na impormasyon diyan. Ikokonekta kita sa consultant: sales@dynamiqes.com / +63 917-630-4848.' : "[MOCK] I don't have good material on that. Let me connect you with a consultant: sales@dynamiqes.com / +63 917-630-4848.";
  }
  for (const w of text.split(/(?<=\s)/)) { onText?.(w); await new Promise((r) => setTimeout(r, 8)); }
  return { text, usage: { in: 0, out: 0, cache: 0 }, toolCalls };
}
