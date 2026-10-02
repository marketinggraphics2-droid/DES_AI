// Hybrid retrieval: pgvector cosine + Postgres full-text, fused with reciprocal rank.
import { q } from './db.js';
import { cfg } from './config.js';
import { embed, toVector } from './embeddings.js';

export const PRODUCTS = ['SAP Business One', 'IQ Ai', 'IQ People', 'IQ Ecom', 'IQ Portal', 'IQ Tax', 'IQ Workplace', 'IQ Desk', 'IQ Barcode', 'IQ Link', 'IQ Tech Institute', 'IQ REM'];
const ALIASES = { 'sap b1': 'SAP Business One', sap: 'SAP Business One', 'iq ai': 'IQ Ai', iqai: 'IQ Ai', payroll: 'IQ People', hris: 'IQ People', ecom: 'IQ Ecom', ecommerce: 'IQ Ecom', 'e-commerce': 'IQ Ecom', portal: 'IQ Portal', tax: 'IQ Tax', 'bir cas': 'IQ Tax', cas: 'IQ Tax', workplace: 'IQ Workplace', desk: 'IQ Desk', helpdesk: 'IQ Desk', barcode: 'IQ Barcode', scanner: 'IQ Barcode', link: 'IQ Link', integration: 'IQ Link', lms: 'IQ Tech Institute', training: 'IQ Tech Institute', rem: 'IQ REM', 'real estate': 'IQ REM' };

export function detectProduct(text) {
  const t = text.toLowerCase();
  for (const p of PRODUCTS) if (t.includes(p.toLowerCase())) return p;
  for (const [a, p] of Object.entries(ALIASES)) if (new RegExp(`\\b${a.replace(/[-\s]/g, '[-\\s]?')}\\b`, 'i').test(t)) return p;
  return null;
}

/** Returns [{chunk, section, title, url, kind, product, updated_at, score}] */
export async function search(query, { k = 6, product = null } = {}) {
  const [vec] = await embed([query], 'query');
  const v = toVector(vec);
  const prodFilter = product ? 'and (c.product = $3 or c.product is null)' : '';
  const params = product ? [v, k * 3, product] : [v, k * 3];

  const vecRows = (await q(`
    select c.id, c.chunk, c.section, c.product, d.title, d.url, d.kind, d.updated_at,
           1 - (c.embedding <=> $1::vector) as sim
    from kb_chunks c join kb_documents d on d.id = c.document_id
    where d.status = 'active' ${prodFilter}
    order by c.embedding <=> $1::vector limit $2`, params)).rows;

  const ftsParams = product ? [query, k * 3, product] : [query, k * 3];
  const ftsRows = (await q(`
    select c.id, c.chunk, c.section, c.product, d.title, d.url, d.kind, d.updated_at,
           ts_rank_cd(c.tsv, websearch_to_tsquery('english', $1)) as rank
    from kb_chunks c join kb_documents d on d.id = c.document_id
    where d.status = 'active' and c.tsv @@ websearch_to_tsquery('english', $1) ${prodFilter}
    order by rank desc limit $2`, ftsParams)).rows;

  // reciprocal rank fusion; boost product pages slightly
  const scores = new Map(); const rows = new Map();
  const add = (list, w) => list.forEach((r, i) => { rows.set(r.id, r); scores.set(r.id, (scores.get(r.id) || 0) + w / (60 + i)); });
  add(vecRows, 1); add(ftsRows, 1);
  for (const [id, r] of rows) if (r.kind === 'product') scores.set(id, scores.get(id) * 1.15);
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id, s]) => ({ ...rows.get(id), score: s }));
}

export async function glossaryHits(text) {
  const r = await q('select term, definition from glossary');
  const t = text.toLowerCase();
  return r.rows.filter((g) => new RegExp(`\\b${g.term.toLowerCase().replace(/\s+/g, '\\s+')}\\b`).test(t));
}

export async function facts() {
  const r = await q('select key, value from facts');
  return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
}

export async function productList() {
  const r = await q(`select title, url from kb_documents where kind='product' and status='active' order by title`);
  return r.rows;
}

// ---- approved answers -------------------------------------------------------------------------
// Matching is lexical on content words (filler words and product names removed, light stemming), so it works
// with the offline hash embeddings and across rewordings. Staff add "variations" for other phrasings (incl. Filipino).
// With Voyage embeddings a vector similarity on the main question is also considered.
const STOP = new Set(('a an the and or but if then so to of in on at by for with from about into over as is are was were be been being am do does did done ' +
  'can could would should will shall may might must have has had having i me my we our us you your yours he she it its they them their this that these those ' +
  'what which who whom whose when where why how there here any some all each every no not yes please pls hi hello hey thanks thank ok okay ' +
  'also just only very really much many more most such than too get got give make need want like know tell let use using used ' +
  'system software solution solutions company business businesses product products offer offers service services dynamiq des ' +
  'ba ng mga ang sa si ni po ko ka mo kayo kami namin natin ninyo niyo ito iyan yan yung lang din rin naman pa na ay may meron wala ' +
  'paano ano saan sino bakit kailan pwede puwede gusto kailangan sana salamat kumusta hindi oo sige').split(/\s+/));
const PRODUCT_WORDS = new Set(['iq', 'sap', 'b1', 'one', 'people', 'ai', 'iqai', 'ecom', 'portal', 'tax', 'workplace', 'desk', 'barcode', 'link', 'tech', 'institute', 'rem']);
const stem = (w) => {
  for (const suf of ['ations', 'ation', 'ings', 'ing', 'ments', 'ment', 'ions', 'ion', 'ers', 'er', 'ed', 'es', 'ly', 's', 'e']) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
  }
  return w;
};
export function contentWords(text) {
  const toks = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  return new Set(toks.filter((w) => !STOP.has(w) && !PRODUCT_WORDS.has(w) && (w.length > 1 || /\d/.test(w))).map(stem));
}
/** 0-1. Dice overlap, or most of the saved phrasing found inside a longer visitor question. */
export function phraseScore(visitorWords, savedText) {
  const g = contentWords(savedText);
  if (!g.size || !visitorWords.size) return 0;
  let ov = 0; for (const w of g) if (visitorWords.has(w)) ov++;
  const dice = (2 * ov) / (g.size + visitorWords.size);
  const cover = g.size >= 2 ? (ov / g.size) * 0.85 : 0;
  return Math.max(dice, cover);
}

/** Approved answers that match the visitor's question. [{id, question, ideal_answer, product, sim, matched}] */
export async function goldenMatches(query, { product = null, k = 2 } = {}) {
  const params = [];
  let filter = '';
  if (product) { params.push(product); filter = 'and (g.product = $1 or g.product is null)'; }
  const rows = (await q(`select g.id, g.question, g.variations, g.ideal_answer, g.product from golden_answers g where g.active is not false ${filter}`, params)).rows;
  if (!rows.length) return [];
  const words = contentWords(query);
  let vecSims = new Map();
  if (cfg.embeddings.provider === 'voyage' && cfg.embeddings.voyageKey) {
    const [vec] = await embed([query], 'query');
    const vp = [toVector(vec), rows.map((r) => r.id)];
    vecSims = new Map((await q('select id, 1 - (embedding <=> $1::vector) as sim from golden_answers where id = any($2::bigint[]) and embedding is not null', vp)).rows.map((r) => [String(r.id), Number(r.sim)]));
  }
  const scored = rows.map((r) => {
    const phrasings = [r.question, ...String(r.variations || '').split('\n').map((s) => s.trim()).filter(Boolean)];
    let best = 0, matched = r.question;
    for (const ph of phrasings) { const s = phraseScore(words, ph); if (s > best) { best = s; matched = ph; } }
    const vs = vecSims.get(String(r.id));
    if (vs !== undefined && vs >= cfg.goldenMinSim && vs > best) { best = Math.max(best, cfg.goldenMinScore + (vs - cfg.goldenMinSim)); matched = r.question; }
    return { id: r.id, question: r.question, ideal_answer: r.ideal_answer, product: r.product, sim: Math.round(best * 100) / 100, matched };
  });
  return scored.filter((r) => r.sim >= cfg.goldenMinScore).sort((a, b) => b.sim - a.sim).slice(0, k);
}

export async function productNotes(product) {
  if (!product) return null;
  const r = await q('select notes from product_notes where product=$1', [product]);
  return r.rows[0]?.notes?.trim() || null;
}
