// LLM calls through IQGateway (IQ_GATEWAY_URL, default https://iqlicense.dynamiqes.com/v1). The gateway speaks the
// OpenAI chat-completions API and routes claude-* / gpt-* / gemini-* models to the matching upstream.
// Default model: gemini-3.5-flash-lite for both chat and summaries.
// Manual tool loop so we control SSE, guardrails and tool side effects.
// MOCK mode (no IQ_GATEWAY_KEY): answers from the retrieved chunks with canned phrasing so the stack runs offline.
import { cfg, isMock } from './config.js';
import { toolDefs, runTool } from './tools.js';
import { addUsage } from './db.js';

// tools.js keeps Anthropic-style defs; convert to OpenAI function tools.
const toOpenAI = (t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema, ...(t.strict ? { strict: true } : {}) },
});

// Gemini accepts only an OpenAPI subset: no type arrays (use nullable), no additionalProperties / maxLength,
// and an OBJECT must have properties. The server still validates and owns every side effect.
function geminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (['additionalProperties', 'maxLength', 'minLength', '$schema'].includes(k)) continue;
    if (k === 'type' && Array.isArray(v)) {
      const real = v.filter((x) => x !== 'null');
      out.type = real[0] || 'string';
      if (v.includes('null')) out.nullable = true;
    } else if (k === 'properties') {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, geminiSchema(pv)]));
    } else if (k === 'items') {
      out.items = geminiSchema(v);
    } else out[k] = v;
  }
  return out;
}
const toGemini = (t) => {
  const hasProps = Object.keys(t.input_schema?.properties || {}).length > 0;
  return { type: 'function', function: { name: t.name, description: t.description, ...(hasProps ? { parameters: geminiSchema(t.input_schema) } : {}) } };
};

const isGemini = (model) => /^gemini-/i.test(model) || cfg.gateway.provider === 'gemini';
const openaiTools = toolDefs.map(toOpenAI);
const geminiTools = toolDefs.map(toGemini);
const toolsFor = (model) => (isGemini(model) ? geminiTools : openaiTools);

export class GatewayError extends Error {
  constructor(status, body) {
    super(`IQGateway ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
    // 402 = wallet out of credits or daily cap reached -> handled like our own budget cap.
    this.code = status === 402 ? 'gateway_credits' : status === 401 ? 'gateway_auth' : 'gateway_error';
  }
}

const isClaude = (model) => /^claude-/i.test(model);

/** Request body shared by every call. Claude models get effort + a cached system block via provider_options. */
function buildBody({ model, system, messages, maxTokens, stream, withTools }) {
  const body = {
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    max_tokens: maxTokens,
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };
  if (withTools) body.tools = toolsFor(model);
  if (cfg.gateway.provider) body.provider = cfg.gateway.provider;
  if (isClaude(model)) {
    const po = {};
    if (withTools && cfg.effort) po.output_config = { effort: cfg.effort };
    // Replaces the translated system prompt with a cache_control block (~90 % cheaper input on repeat turns).
    if (cfg.gateway.anthropicCache) po.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    if (Object.keys(po).length) body.provider_options = po;
  } else if (/^gemini-(3|[4-9])/i.test(model)) {
    // Gemini 3.x: set the thinking level explicitly (3.5 Flash-Lite rejects the gateway default with "invalid argument").
    // provider_options replaces generationConfig, so the output cap goes in here too.
    body.provider_options = { generationConfig: { thinkingConfig: { thinkingLevel: cfg.geminiThinkingLevel }, maxOutputTokens: maxTokens } };
  } else if (withTools && cfg.effort && /^(gpt-5|o\d)/i.test(model)) {
    body.reasoning_effort = cfg.effort;
  }
  return body;
}

async function post(body) {
  const res = await fetch(`${cfg.gateway.url}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.gateway.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.gateway.timeoutMs),
  });
  if (!res.ok) throw new GatewayError(res.status, await res.text().catch(() => ''));
  return res;
}

/** USD cost from the gateway's x_gateway object, when it reports one. */
function gatewayUsd(xg) {
  if (!xg || typeof xg !== 'object') return null;
  for (const k of ['usd_cost', 'cost_usd', 'usd', 'cost']) if (typeof xg[k] === 'number') return xg[k];
  for (const [k, v] of Object.entries(xg)) if (/usd/i.test(k) && typeof v === 'number') return v;
  return null;
}

const readUsage = (u) => ({
  in: u?.prompt_tokens || 0,
  out: u?.completion_tokens || 0,
  cache: u?.prompt_tokens_details?.cached_tokens || 0,
});

/** Streams one completion. Returns {text, toolCalls:[{id,name,arguments}], finish, usage, usd}. */
async function streamOnce(body, onText) {
  const res = await post(body);
  const dec = new TextDecoder();
  let buf = '', text = '', finish = null, usage = { in: 0, out: 0, cache: 0 }, usd = null;
  const calls = [];
  const handle = (data) => {
    if (!data || data === '[DONE]') return;
    let j; try { j = JSON.parse(data); } catch { return; }
    if (j.error) throw new GatewayError(502, JSON.stringify(j.error));
    if (j.x_gateway) { const c = gatewayUsd(j.x_gateway); if (c !== null) usd = c; }
    if (j.usage) usage = readUsage(j.usage);
    const ch = j.choices?.[0];
    if (!ch) return;
    const d = ch.delta || {};
    if (d.content) { text += d.content; onText?.(d.content); }
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? calls.length;
      calls[i] ||= { id: '', name: '', arguments: '' };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].name += tc.function.name;
      if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  };
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) handle(line.slice(5).trim());
    }
  }
  if (buf.trim().startsWith('data:')) handle(buf.trim().slice(5).trim());
  calls.forEach((c, i) => { if (c && !c.id) c.id = `call_${i}`; });
  return { text, toolCalls: calls.filter(Boolean), finish, usage, usd };
}

/** Non-streaming single-turn call (summaries, classifier). */
async function complete({ model, system, user, maxTokens }) {
  const res = await post(buildBody({ model, system, messages: [{ role: 'user', content: user }], maxTokens, stream: false, withTools: false }));
  const j = await res.json();
  const u = readUsage(j.usage);
  await addUsage(u.in, u.out, u.cache, gatewayUsd(j.x_gateway));
  return (j.choices?.[0]?.message?.content || '').trim();
}

/**
 * @param {object} p
 * @param {string} p.system            stable system prompt (cached on Claude models)
 * @param {Array}  p.history           prior turns [{role, content}]
 * @param {string} p.userTurn          context block + the visitor message
 * @param {object} p.ctx               {conversationId, visitorId}
 * @param {(delta:string)=>void} p.onText
 * @param {(ev:object)=>void}  p.onEvent
 * @returns {Promise<{text:string, usage:{in:number,out:number,cache:number}, toolCalls:Array}>}
 */
export async function answer({ system, history, userTurn, ctx, onText, onEvent, dry = false }) {
  if (isMock()) return mockAnswer({ userTurn, ctx, onText, onEvent, dry });

  const messages = [...history, { role: 'user', content: userTurn }];
  const usage = { in: 0, out: 0, cache: 0 };
  let usd = 0, usdKnown = true;
  const toolCalls = [];
  let finalText = '';

  try {
    for (let round = 0; round < 4; round++) {
      const r = await streamOnce(buildBody({ model: cfg.model, system, messages, maxTokens: cfg.maxOutputTokens, stream: true, withTools: !dry }), onText);
      usage.in += r.usage.in; usage.out += r.usage.out; usage.cache += r.usage.cache;
      if (r.usd === null) usdKnown = false; else usd += r.usd;
      finalText += r.text;

      if (r.finish === 'content_filter') { onEvent?.({ type: 'refusal', category: null }); break; }
      if (r.finish === 'length' && r.toolCalls.length) { onEvent?.({ type: 'error', message: 'tool input truncated' }); break; }
      if (!r.toolCalls.length) break;

      messages.push({
        role: 'assistant',
        content: r.text || null,
        tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
      });
      for (const c of r.toolCalls) {
        let input = {}, out;
        try { input = JSON.parse(c.arguments || '{}'); } catch { }
        try { out = await runTool(c.name, input, ctx); }
        catch (e) { out = { result: `Tool error: ${e.message}` }; }
        toolCalls.push({ name: c.name, input, output: out.result });
        if (out.event) onEvent?.(out.event);
        messages.push({ role: 'tool', tool_call_id: c.id, content: String(out.result ?? '') });
      }
    }
  } finally {
    if (usage.in || usage.out || usd) await addUsage(usage.in, usage.out, usage.cache, usdKnown ? usd : null);
  }
  return { text: finalText.trim(), usage, toolCalls };
}

/** Small-model screen for every message the regex lets through. Fails open (on_topic) so real visitors are never blocked by an outage. */
const SCREEN = `You screen messages sent to DES, the website assistant of DynamIQ, a Philippine SAP Business One partner (ERP, accounting, inventory, HR/payroll, BIR CAS compliance, e-commerce, barcode, IT services, training, careers at DynamIQ). Messages may be in English, Filipino, Taglish or slang.
Reply with exactly one word:
on_topic: about the visitor's business, DynamIQ or its products, services, pricing, demos, careers or company info; SAP, ERP, accounting, HR, tax or IT topics; or short polite small talk (greetings, thanks, "who are you", "what's my name", yes/no, "tell me more", follow-ups to the previous answer).
off_topic: anything else, e.g. recipes or cooking, coding or HTML help, homework, essays, poems, songs, stories, jokes, games, general knowledge, news, politics, sports, entertainment, dating, flirting or meeting up, asking the assistant to role-play or talk in a certain persona or style, or requests for long content (more than 3 paragraphs, articles, essays) even about SAP.
abuse: insults, profanity, harassment, sexual content or threats in any language (e.g. gago, tanga, bobo, kupal, ulol, putang ina, "kupal ka ba").
support_request: an existing customer reporting a technical problem with their system.
If unsure, answer on_topic.`;
export async function classifyLLM(text) {
  if (isMock()) return 'on_topic';
  try {
    const label = (await complete({ model: cfg.guardModel, maxTokens: 8, system: SCREEN, user: text.slice(0, 600) })).toLowerCase().replace(/[^a-z_]/g, '');
    return ['on_topic', 'off_topic', 'abuse', 'support_request'].includes(label) ? label : 'on_topic';
  } catch (e) { console.error('screen failed (allowed):', e.message); return 'on_topic'; }
}

export async function summarize(transcript) {
  if (isMock()) return transcript.slice(0, 140);
  return complete({
    model: cfg.guardModel, maxTokens: 80,
    system: 'Summarize this sales-chat transcript in one line (max 20 words) for a CRM list: who, what they need, which product.',
    user: transcript.slice(0, 6000),
  });
}

// ---------------- mock ----------------
async function mockAnswer({ userTurn, ctx, onText, onEvent, dry = false }) {
  const msg = (userTurn.match(/<message>([\s\S]*?)<\/message>/) || [, userTurn])[1].trim();
  const lang = (userTurn.match(/<lang>(\w+)<\/lang>/) || [, 'en'])[1];
  const docs = [...userTurn.matchAll(/<doc url="([^"]+)" title="([^"]*)"[^>]*>\n([\s\S]*?)<\/doc>/g)].map((m) => ({ url: m[1], title: m[2], chunk: m[3] }));
  const toolCalls = [];
  let text;
  const approved = userTurn.match(/<answer[^>]*>\n([\s\S]*?)\n<\/answer>/);
  if (approved) text = '[MOCK · approved answer] ' + approved[1].trim();
  else if (dry) text = docs.length ? `[MOCK] From our website: ${docs[0].chunk.replace(/\s+/g, ' ').slice(0, 240)}… ${docs[0].url}` : '[MOCK] No matching material.';
  else if (/demo|consultant|talk to|human|agent|kausapin/i.test(msg)) {
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
