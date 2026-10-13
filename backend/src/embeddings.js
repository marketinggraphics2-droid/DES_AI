// Embeddings. Anthropic has no embeddings endpoint; Voyage AI is the recommended provider.
// `hash` is a deterministic offline fallback (hashed bag-of-words) so the stack runs with no keys —
// retrieval quality is "keyword-ish", fine for dev, not for production.
import crypto from 'node:crypto';
import { cfg } from './config.js';

const DIM = cfg.embeddings.dim;

function hashEmbed(text) {
  const v = new Float32Array(DIM);
  const toks = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((t) => t.length > 1);
  const grams = [...toks];
  for (let i = 0; i < toks.length - 1; i++) grams.push(toks[i] + '_' + toks[i + 1]);
  for (const g of grams) {
    const h = crypto.createHash('md5').update(g).digest();
    const idx = h.readUInt32LE(0) % DIM;
    const sign = h[4] & 1 ? 1 : -1;
    v[idx] += sign;
  }
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}

async function voyageEmbed(texts, inputType) {
  const r = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.embeddings.voyageKey}` },
    body: JSON.stringify({ model: cfg.embeddings.voyageModel, input: texts, input_type: inputType, output_dimension: DIM }),
  });
  if (!r.ok) throw new Error(`voyage ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// query embeddings are cached (follow-ups, repeated questions, approved-answer matching embed the same text again)
const queryCache = new Map();
const QUERY_CACHE_MAX = 1000;

/** @param {string[]} texts  @param {'document'|'query'} inputType */
export async function embed(texts, inputType = 'document') {
  if (inputType === 'query' && texts.length === 1) {
    const key = cfg.embeddings.provider + ':' + texts[0].trim().toLowerCase();
    if (queryCache.has(key)) { const v = queryCache.get(key); queryCache.delete(key); queryCache.set(key, v); return [v]; }
    const [v] = await embedUncached(texts, inputType);
    queryCache.set(key, v);
    if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
    return [v];
  }
  return embedUncached(texts, inputType);
}
async function embedUncached(texts, inputType) {
  if (cfg.embeddings.provider === 'voyage' && cfg.embeddings.voyageKey) {
    const out = [];
    for (let i = 0; i < texts.length; i += 64) out.push(...(await voyageEmbed(texts.slice(i, i + 64), inputType)));
    return out;
  }
  return texts.map(hashEmbed);
}

export const toVector = (arr) => `[${arr.map((x) => (Math.round(x * 1e6) / 1e6)).join(',')}]`;
