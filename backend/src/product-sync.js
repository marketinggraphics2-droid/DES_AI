// Product check: reads the website's /products/ page (one card per launched product) and brings the product list in line.
// A card not seen before becomes a product straight away (named from the card heading, marked New so staff add nicknames);
// a product missing from the page twice in a row is switched off as "page gone". Every listed product page is read again
// so DES's website passages stay current (unchanged pages cost one fetch, no embedding).
// Runs from the "Check for new products" button (Fine-tune answers) and every PRODUCT_CHECK_HOURS in the server.
import { cfg } from './config.js';
import { q } from './db.js';
import { ingestUrl } from './ingest.js';
import { ensureProducts, loadProducts, slugOf } from './products.js';

const MAX_NAME = 60;
const GONE_AFTER = 2; // checks in a row a product must be missing before DES stops naming it

const decode = (s) => String(s || '')
  .replace(/&#0?39;|&#8217;|&rsquo;/g, '’').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const text = (html) => decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const abs = (u, base) => { try { const x = new URL(decode(u), base); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
/** The real image address: lazy-loaded images keep it in data-src and a blank placeholder in src. */
const imgSrc = (tag, base) => {
  if (!tag) return null;
  const src = tag.match(/\sdata-src="([^"]+)"/)?.[1] || tag.match(/\ssrc="([^"]+)"/)?.[1];
  return src && !src.startsWith('data:') ? abs(src, base) : null;
};

/**
 * The product cards on the /products/ page: [{ slug, url, name, description, logo, image }] in page order.
 * Falls back to plain links to /products/<page>/ (e.g. the menu) when the card layout changes, so a redesign
 * still finds products, just without text and pictures.
 */
export function parseProductCards(html, base = cfg.productsPageUrl) {
  const out = new Map();
  for (const block of String(html || '').split(/<article\b/i).slice(1)) {
    const art = block.split(/<\/article>/i)[0];
    const hrefs = [...art.matchAll(/href="([^"]+)"/g)].map((m) => abs(m[1], base)).filter((u) => u && slugOf(u));
    const url = hrefs[0];
    if (!url) continue;
    const slug = slugOf(url);
    if (out.has(slug)) continue;
    const imgs = art.match(/<img\b[^>]*>/gi) || [];
    const isLogo = (t) => /class="[^"]*logo[^"]*"/i.test(t);
    const logoTag = imgs.find(isLogo);
    const name = text(art.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i)?.[1]) || text(logoTag?.match(/\salt="([^"]*)"/)?.[1]);
    // the card text, without image captions
    const description = [...art.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)].filter((m) => !/caption/i.test(m[1])).map((m) => text(m[2])).filter(Boolean).join(' ').slice(0, 700);
    const logo = imgSrc(logoTag, base);
    const image = imgSrc(imgs.find((t) => !isLogo(t)), base);
    out.set(slug, { slug, url: `${new URL(url).origin}/products/${slug}/`, name: name.slice(0, MAX_NAME), description: description || null, logo, image });
  }
  // links anywhere on the page (menu, footer): fill in names, and catch products when there are no cards at all
  for (const m of String(html || '').matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = abs(m[1], base), slug = url && slugOf(url), label = text(m[2]);
    if (!slug || !label || /^view product|^learn more|^read more/i.test(label) || label.length > MAX_NAME) continue;
    const cur = out.get(slug);
    if (!cur) { if (!out.size || ![...out.values()].some((c) => c.description)) out.set(slug, { slug, url: `${new URL(url).origin}/products/${slug}/`, name: label, description: null, logo: null, image: null }); }
    else if (!cur.name) cur.name = label;
  }
  return [...out.values()];
}

async function freeName(name, slug) {
  let n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  if (n.length < 2 || /^(general|unknown|auto)$/i.test(n)) n = slug.replace(/^dynamiq-/, '').split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  if ((await q('select 1 from products where lower(name)=lower($1)', [n])).rowCount) n = `${n} (${slug})`.slice(0, MAX_NAME);
  return n;
}

async function record(r) {
  await q(`insert into product_checks(id, checked_at, ok, found, added, gone, detail) values(1, now(), $1, $2, $3, $4, $5)
           on conflict(id) do update set checked_at=now(), ok=excluded.ok, found=excluded.found, added=excluded.added, gone=excluded.gone, detail=excluded.detail`,
  [r.ok, r.found ?? null, r.added || [], r.gone || [], r.detail || null]);
}

/** The last check, for the dashboard: { checked_at, ok, found, added, gone, detail } or null. */
export async function lastProductCheck() {
  return (await q('select checked_at, ok, found, added, gone, detail from product_checks where id=1')).rows[0] || null;
}

let running = null;
/** Check the website now. Two clicks at once share one check. Never throws; the result says what happened. */
export function checkProducts({ source = 'products-check' } = {}) {
  return (running ||= run(source).finally(() => { running = null; }));
}

async function run(source) {
  let cards;
  try {
    await ensureProducts();
    const res = await fetch(cfg.productsPageUrl, { headers: { 'user-agent': 'DES-KB-Ingest/1.0 (+https://dynamiqes.com)' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`the products page answered HTTP ${res.status}`);
    cards = parseProductCards(await res.text(), cfg.productsPageUrl);
    // an empty page is a broken page, not "every product was removed": change nothing
    if (!cards.length) throw new Error('no products found on the products page');
  } catch (e) {
    const r = { ok: false, detail: e.name === 'TimeoutError' ? 'the products page did not answer in time' : e.message };
    await record(r).catch(() => {});
    return { ...r, checked_at: new Date().toISOString(), added: [], gone: [], updated: [] };
  }

  const known = new Map((await q('select name, slug, on_website, missed_checks from products where slug is not null')).rows.map((p) => [p.slug, p]));
  const added = [], gone = [], updated = [], failed = [];
  for (const [i, c] of cards.entries()) {
    const site = [c.name || null, c.description, c.logo, c.image];
    if (known.has(c.slug)) {
      await q(`update products set website_name=$2, description=$3, logo_url=$4, image_url=$5, last_seen_at=now(), missed_checks=0, sort=$6,
               on_website=true, updated_at=case when on_website then updated_at else now() end where slug=$1`, [c.slug, ...site, i]);
    } else {
      const name = await freeName(c.name, c.slug);
      const r = await q(`insert into products(name, slug, aliases, needs_review, sort, website_name, description, logo_url, image_url, last_seen_at)
                         values($1,$2,'{}',true,$3,$4,$5,$6,$7,now()) on conflict do nothing`, [name, c.slug, i, ...site]);
      if (r.rowCount) added.push(name);
    }
  }
  const listed = new Set(cards.map((c) => c.slug));
  for (const p of known.values()) {
    if (listed.has(p.slug) || !p.on_website) continue;
    const missed = (p.missed_checks || 0) + 1;
    await q(`update products set missed_checks=$2::int, on_website=case when $2::int >= $3::int then false else on_website end,
             updated_at=case when $2::int >= $3::int then now() else updated_at end where slug=$1`, [p.slug, missed, GONE_AFTER]);
    if (missed >= GONE_AFTER) gone.push(p.name);
  }
  await loadProducts();

  // read each product page so its passages exist (new products) and stay current (changed pages)
  for (const c of cards) {
    const r = await ingestUrl(c.url, { source, sitemapKind: 'dq_product' });
    if (r.error) failed.push(c.url);
    else if (r.action === 'created' || r.action === 'updated') updated.push(c.url);
  }
  const result = { ok: true, found: cards.length, added, gone, updated, failed, detail: failed.length ? `${failed.length} product page(s) could not be read` : null };
  await record(result);
  if (added.length || gone.length) console.log(`products check: ${cards.length} on the website${added.length ? ' · added ' + added.join(', ') : ''}${gone.length ? ' · gone ' + gone.join(', ') : ''}`);
  return { ...result, checked_at: new Date().toISOString() };
}

let timer = null;
/** Server start: first check shortly after start-up, then every PRODUCT_CHECK_HOURS (0 = button only). */
export function startProductChecks(hours = cfg.productCheckHours) {
  if (timer || !(hours > 0)) return;
  const tick = () => checkProducts({ source: 'products-check' }).catch((e) => console.error('products check', e.message));
  const first = setTimeout(tick, 30 * 1000); first.unref?.();
  timer = setInterval(tick, hours * 3600 * 1000); timer.unref?.();
}
