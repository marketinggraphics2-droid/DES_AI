// The product list. dynamiqes.com is the source: every page under /products/<page>/ is one product.
// The product check (product-sync.js: the /products/ page, every few hours or on "Check for new products") adds launched
// products under their card heading; the sweep / webhook registers a product page it meets under a name guessed from its title and flags it for review;
// staff fix the name and nicknames in the dashboard (Fine-tune answers → product → Details).
// Code reads an in-memory copy (sync): it reloads on start, after every change, and every few minutes, because the
// nightly sweep runs in its own process.
import { q, withTx } from './db.js';

/** First run only: the products as they were before the list became dynamic, with their nicknames. */
const SEED = [
  ['SAP Business One', 'sap-business-one-philippines', ['sap b1', 'sap']],
  ['IQ Ai', 'dynamiq-ai-sap-b1', ['iqai']],
  ['IQ People', 'iq-people', ['payroll', 'hris']],
  ['IQ Ecom', 'sap-b1-ecom-platform', ['ecom', 'ecommerce', 'e-commerce']],
  ['IQ Portal', 'dynamiq-portal', ['portal']],
  ['IQ Tax', 'dynamiq-tax-module', ['tax', 'bir cas', 'cas']],
  ['IQ Workplace', 'iq-workplace', ['workplace']],
  ['IQ Desk', 'sap-b1-it-desk', ['desk', 'helpdesk']],
  ['IQ Barcode', 'dynamiq-barcoding', ['barcode', 'scanner']],
  ['IQ Link', 'dynamiq-iq-link', ['link', 'integration']],
  ['IQ Tech Institute', 'iq-tech-institute', ['lms', 'training']],
  ['IQ REM', 'dynamiq-real-estate-management', ['rem', 'real estate']],
];
// words that are part of product names but carry no meaning for approved-answer matching
const BASE_WORDS = ['iq', 'sap', 'b1', 'one', 'iqai'];
const MAX_NAME = 60;

let rows = SEED.map(([name, slug, aliases], i) => ({ name, slug, aliases, active: true, on_website: true, needs_review: false, sort: i }));
let live = [], aliasRes = [], words = new Set(), signature = '';
const listeners = new Set();
rebuild();

function rebuild() {
  live = rows.filter((p) => p.active && p.on_website);
  aliasRes = live.flatMap((p) => (p.aliases || []).filter(Boolean).map((a) => [new RegExp(`\\b${a.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-\s]+/g, '[-\\s]?')}\\b`, 'i'), p.name]));
  words = new Set([...BASE_WORDS, ...live.flatMap((p) => p.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))]);
  const sig = JSON.stringify(live.map((p) => [p.name, p.aliases]));
  if (sig !== signature) { const first = !signature; signature = sig; if (!first) for (const fn of listeners) fn(); }
}

/** Names of the products DES talks about (switched on and still on the website), in display order. */
export const productNames = () => live.map((p) => p.name);
export const isProduct = (name) => live.some((p) => p.name === name);
/** Lower-case words that make up product names (ignored when matching approved answers). */
export const productWords = () => words;
/** Called when the list of names or nicknames changes (e.g. to rebuild the cached prompt and tool list). */
export const onProductsChange = (fn) => { listeners.add(fn); };

/** The product a piece of text is about: a product name first, then a nickname. */
export function detectProduct(text) {
  const t = String(text || '').toLowerCase();
  for (const p of live) if (t.includes(p.name.toLowerCase())) return p.name;
  for (const [re, name] of aliasRes) if (re.test(t)) return name;
  return null;
}

/** "/products/<slug>/" → slug; null for the /products/ index and every other page. */
export function slugOf(url) {
  try { return new URL(url).pathname.match(/^\/products\/([^/]+)\/?$/)?.[1]?.toLowerCase() || null; } catch { return null; }
}

/** A readable first guess from an SEO title, e.g. "AI Module for SAP Business One ERP - DynamIQ" → "AI Module". Staff confirm it. */
export function guessName(title, slug) {
  let t = String(title || '').split(/\s+[|–—-]\s+/)[0].replace(/\s+(module\s+)?for\s+sap\b.*$/i, (m) => (/^\s+module/i.test(m) ? ' Module' : '')).trim();
  if (t.length < 2) t = String(slug || '').replace(/^dynamiq-/, '').split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return t.slice(0, MAX_NAME).trim() || 'New product';
}

export async function loadProducts() {
  rows = (await q('select name, slug, aliases, active, on_website, needs_review, sort, created_at, updated_at, website_name, description, logo_url, image_url, last_seen_at from products order by sort nulls last, created_at, name')).rows;
  rebuild();
  return rows;
}
/** Every product, including switched-off ones and ones whose page is gone (dashboard). */
export const allProducts = () => rows;

async function fillIfEmpty() {
  if ((await q('select 1 from products limit 1')).rowCount) return;
  for (const [i, [name, slug, aliases]] of SEED.entries()) {
    await q('insert into products(name, slug, aliases, sort) values($1,$2,$3,$4) on conflict do nothing', [name, slug, aliases, i]);
  }
}
let ready = null; // once per process: the ingest script can run before the server ever started
const ensureReady = () => (ready ||= fillIfEmpty().then(loadProducts).catch((e) => { ready = null; throw e; }));
/** The table exists and has the original products (first run). */
export const ensureProducts = () => ensureReady();

/** Fills the table on the very first run and tags website passages by product page. Safe to run on every start. */
export async function seedProducts() {
  await ensureReady();
  await loadProducts();
  await retagChunks();
}

let timer = null;
export function startProductRefresh(ms = 5 * 60 * 1000) {
  if (timer) return;
  timer = setInterval(() => loadProducts().catch((e) => console.error('products reload', e.message)), ms);
  timer.unref?.();
}

/** Website passages carry the product of the page they come from. */
export async function retagChunks() {
  await q(`update kb_chunks c set product = p.name from kb_documents d, products p
           where c.document_id = d.id and p.slug is not null and rtrim(lower(d.url), '/') like '%/products/' || p.slug
             and c.product is distinct from p.name`);
}

/**
 * Called when a product page is read (sweep, webhook, re-read). Returns the product name for its passages.
 * A page not seen before becomes a new product (guessed name, flagged for review); a page that comes back is marked live again.
 */
export async function productForPage(url, title) {
  const slug = slugOf(url);
  if (!slug) return null;
  await ensureReady();
  const known = (await q('select name, on_website from products where slug=$1', [slug])).rows[0];
  if (known) {
    if (!known.on_website) { await q('update products set on_website=true, updated_at=now() where slug=$1', [slug]); await loadProducts(); }
    return known.name;
  }
  let name = guessName(title, slug);
  if ((await q('select 1 from products where lower(name)=lower($1)', [name])).rowCount) name = `${name} (${slug})`.slice(0, MAX_NAME);
  await q(`insert into products(name, slug, aliases, needs_review, sort) values($1,$2,'{}',true,(select coalesce(max(sort),0)+1 from products))
           on conflict do nothing`, [name, slug]);
  await loadProducts();
  return (await q('select name from products where slug=$1', [slug])).rows[0]?.name || null;
}

/** The product page left the website: DES stops naming the product (staff can still see it in the dashboard). */
export async function productPageGone(url) {
  const slug = slugOf(url);
  if (!slug) return;
  const r = await q('update products set on_website=false, updated_at=now() where slug=$1 and on_website', [slug]);
  if (r.rowCount) await loadProducts();
}

const cleanAliases = (list) => [...new Set((Array.isArray(list) ? list : String(list || '').split(/[,\n]/))
  .map((a) => String(a).toLowerCase().replace(/\s+/g, ' ').trim()).filter((a) => a.length >= 2 && a.length <= 40))].slice(0, 30);

/**
 * Dashboard edit: name, nicknames, page, on/off, reviewed. A rename carries over to leads, approved answers, notes,
 * website passages and visitor questions so nothing is left under the old name.
 */
export async function updateProduct(name, patch = {}) {
  const cur = (await q('select * from products where name=$1', [name])).rows[0];
  if (!cur) return { error: 'unknown_product', status: 404 };
  const next = String(patch.name ?? cur.name).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  if (next.length < 2) return { error: 'name_required', status: 400 };
  if (/^(general|unknown|auto)$/i.test(next)) return { error: 'name_reserved', status: 400 };
  if (next.toLowerCase() !== cur.name.toLowerCase() && (await q('select 1 from products where lower(name)=lower($1)', [next])).rowCount) return { error: 'name_taken', status: 409 };
  let slug = cur.slug;
  if (patch.url !== undefined || patch.slug !== undefined) {
    const raw = String(patch.url ?? patch.slug ?? '').trim();
    slug = raw ? (slugOf(raw) || (/^[a-z0-9-]+$/i.test(raw) ? raw.toLowerCase() : undefined)) : null;
    if (slug === undefined) return { error: 'bad_product_page', status: 400 };
    if (slug && slug !== cur.slug && (await q('select 1 from products where slug=$1', [slug])).rowCount) return { error: 'page_taken', status: 409 };
  }
  const aliases = patch.aliases !== undefined ? cleanAliases(patch.aliases) : cur.aliases;
  const active = patch.active !== undefined ? patch.active !== false : cur.active;
  const needsReview = patch.reviewed === true ? false : cur.needs_review;
  await withTx(async (tx) => {
    await tx.query('update products set name=$2, slug=$3, aliases=$4, active=$5, needs_review=$6, on_website=case when $3::text is distinct from $7::text then true else on_website end, updated_at=now() where name=$1',
      [cur.name, next, slug, aliases, active, needsReview, cur.slug]);
    if (next !== cur.name) {
      await tx.query('update leads set product_interest = array_replace(product_interest, $1, $2) where $1 = any(product_interest)', [cur.name, next]);
      await tx.query('update golden_answers set product=$2 where product=$1', [cur.name, next]);
      await tx.query('update kb_chunks set product=$2 where product=$1', [cur.name, next]);
      await tx.query('update messages set product=$2 where product=$1', [cur.name, next]);
      // a leftover notes row under the new name (from an older product) gives way to this product's notes
      await tx.query('delete from product_notes where product=$2 and exists(select 1 from product_notes where product=$1)', [cur.name, next]);
      await tx.query('update product_notes set product=$2 where product=$1', [cur.name, next]);
    }
  });
  if (slug !== cur.slug) await retagChunks();
  await loadProducts();
  return { product: rows.find((p) => p.name === next) };
}
