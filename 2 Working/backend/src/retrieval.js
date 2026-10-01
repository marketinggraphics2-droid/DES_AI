// Hybrid retrieval: pgvector cosine + Postgres full-text, fused with reciprocal rank.
import { q } from './db.js';
import { embed, toVector } from './embeddings.js';

const PRODUCTS = ['SAP Business One', 'IQ Ai', 'IQ People', 'IQ Ecom', 'IQ Portal', 'IQ Tax', 'IQ Workplace', 'IQ Desk', 'IQ Barcode', 'IQ Link', 'IQ Tech Institute', 'IQ REM'];
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
