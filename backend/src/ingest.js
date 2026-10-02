// Knowledge-base ingest (architecture.md §2b): fetch → strip → chunk by heading → embed → upsert.
// Sources: a live URL (webhook / sweep), or the local scrape folder (first seed).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { q, withTx } from './db.js';
import { embed, toVector } from './embeddings.js';
import { detectProduct } from './retrieval.js';

const KIND_BY_PATH = [[/\/products\//, 'product'], [/\/careers\//, 'career'], [/\/testimonials\//, 'testimonial'], [/\/news-event\//, 'news'], [/^https?:\/\/[^/]+\/(blogs\/)?$/, 'page']];
export function kindOf(url, sitemapKind) {
  if (sitemapKind) return { post: 'blog', page: 'page', dq_product: 'product', careers: 'career', customer_testimonial: 'testimonial', 'news-events': 'news' }[sitemapKind] || 'page';
  for (const [re, k] of KIND_BY_PATH) if (re.test(url)) return k;
  return 'page';
}

// ---- HTML → text (mirrors scrape.py) ----
export function htmlToText(html) {
  let h = html.replace(/<(script|style|noscript|svg|iframe|nav|footer|form)[\s\S]*?<\/\1>/gi, ' ');
  const main = h.match(/<main[\s\S]*?<\/main>/i); if (main) h = main[0];
  h = h.replace(/<(h[1-4])[^>]*>/gi, '\n\n## ').replace(/<li[^>]*>/gi, '\n- ').replace(/<(p|div|br|tr|section|article|td|th|ul|ol|blockquote)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
  h = h.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8217;|&rsquo;/g, '’').replace(/&#8211;|&ndash;/g, '–').replace(/&quot;/g, '"').replace(/&#\d+;/g, '');
  return h.replace(/[ \t\xa0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function titleOf(html) { return (html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim(); }

// ---- chunking: split on "## " headings, cap ~2200 chars (~500 tokens), carry title+section ----
export function chunkText(text, title, { max = 2200, blogIntroOnly = false } = {}) {
  const parts = text.split(/\n(?=## )/);
  const out = [];
  for (const p of parts) {
    const m = p.match(/^## (.*)\n?([\s\S]*)$/);
    const section = m ? m[1].trim() : '';
    let body = (m ? m[2] : p).trim();
    if (!body || /^(we'?d like to hear from you|get in touch|frequently asked questions)/i.test(section) && body.length < 80) continue;
    if (/get your free business analysis|tel:\+63|monday-friday 8:00/i.test(body) && body.length < 400) continue; // CTA / footer blocks
    while (body.length > max) { let cut = body.lastIndexOf('\n', max); if (cut < max * 0.5) cut = body.lastIndexOf('. ', max); if (cut < max * 0.5) cut = max; out.push({ section, chunk: body.slice(0, cut).trim() }); body = body.slice(cut).trim(); }
    if (body) out.push({ section, chunk: body });
    if (blogIntroOnly && out.length >= 4) break; // blogs: title + intro + first sections only
  }
  return out.filter((c) => c.chunk.length > 40).map((c) => ({ ...c, chunk: `${title}${c.section ? ' › ' + c.section : ''}\n${c.chunk}` }));
}

async function upsert({ url, title, kind, text, lastmod, source }) {
  const hash = crypto.createHash('sha1').update(text).digest('hex');
  const existing = (await q('select id, content_hash from kb_documents where url=$1', [url])).rows[0];
  if (existing && existing.content_hash === hash) {
    await q(`update kb_documents set status='active', lastmod=coalesce($2,lastmod) where id=$1`, [existing.id, lastmod]);
    return { url, action: 'unchanged' };
  }
  const chunks = chunkText(text, title, { blogIntroOnly: kind === 'blog' });
  const product = kind === 'product' ? detectProduct(title + ' ' + text.slice(0, 500)) : null;
  const vecs = await embed(chunks.map((c) => c.chunk), 'document');
  await withTx(async (tx) => {
    const doc = await tx.query(`insert into kb_documents(url,title,kind,lastmod,content_hash,status,updated_at) values($1,$2,$3,$4,$5,'active',now())
                                on conflict(url) do update set title=excluded.title, kind=excluded.kind, lastmod=excluded.lastmod, content_hash=excluded.content_hash, status='active', updated_at=now() returning id`, [url, title, kind, lastmod, hash]);
    const id = doc.rows[0].id;
    await tx.query('delete from kb_chunks where document_id=$1', [id]);
    for (let i = 0; i < chunks.length; i++) await tx.query('insert into kb_chunks(document_id, section, chunk, product, embedding) values($1,$2,$3,$4,$5::vector)', [id, chunks[i].section, chunks[i].chunk, product, toVector(vecs[i])]);
  });
  await q('insert into ingest_log(source,url,action,ok,detail) values($1,$2,$3,true,$4)', [source, url, existing ? 'updated' : 'created', `${chunks.length} chunks`]);
  return { url, action: existing ? 'updated' : 'created', chunks: chunks.length };
}

export async function ingestUrl(url, { action = 'update', source = 'manual', sitemapKind = null, lastmod = null } = {}) {
  try {
    if (action === 'trash' || action === 'delete') {
      await q(`update kb_documents set status='archived', updated_at=now() where url=$1`, [url]);
      await q('insert into ingest_log(source,url,action,ok) values($1,$2,$3,true)', [source, url, 'archived']);
      return { url, action: 'archived' };
    }
    const res = await fetch(url, { headers: { 'user-agent': 'DES-KB-Ingest/1.0 (+https://dynamiqes.com)' } });
    if (res.status === 404 || res.status === 410) return ingestUrl(url, { action: 'trash', source });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const text = htmlToText(html);
    return await upsert({ url, title: titleOf(html).replace(/\s*[-|–]\s*DynamIQ.*$/i, '').trim() || url, kind: kindOf(url, sitemapKind), text, lastmod, source });
  } catch (e) {
    await q('insert into ingest_log(source,url,action,ok,detail) values($1,$2,$3,false,$4)', [source, url, action, e.message]);
    return { url, error: e.message };
  }
}

/** Seed from the local scrape folder (no network). */
export async function ingestScrapeDir(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt'));
  const results = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const url = raw.match(/^URL: (.*)$/m)?.[1]?.trim(); if (!url) continue;
    const title = (raw.match(/^TITLE: (.*)$/m)?.[1] || '').replace(/\s*[-|–]\s*DynamIQ.*$/i, '').trim() || url;
    const body = raw.split(/\n\n/).slice(1).join('\n\n');
    const sitemapKind = f.split('__')[0];
    results.push(await upsert({ url, title, kind: kindOf(url, sitemapKind), text: body, lastmod: null, source: 'scrape' }));
  }
  return results;
}

/** Nightly: walk the Yoast sitemap index; ingest new/changed; archive missing. */
export async function sweepSitemap() {
  const idx = await (await fetch(cfg.sitemapUrl)).text();
  const maps = [...idx.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]).filter((u) => !/(category|post_tag|author)-sitemap/.test(u));
  const seen = new Set(); const results = [];
  for (const sm of maps) {
    const kind = sm.match(/\/([a-z_-]+)-sitemap\.xml/)?.[1];
    const xml = await (await fetch(sm)).text();
    for (const m of xml.matchAll(/<url>\s*<loc>(.*?)<\/loc>(?:\s*<lastmod>(.*?)<\/lastmod>)?/g)) {
      const url = m[1], lastmod = m[2] ? new Date(m[2]) : null;
      if (/\/(thank-you|application-form)/.test(url)) continue;
      seen.add(url);
      const row = (await q('select lastmod, status from kb_documents where url=$1', [url])).rows[0];
      if (row && row.status === 'active' && lastmod && row.lastmod && new Date(row.lastmod) >= lastmod) continue;
      results.push(await ingestUrl(url, { source: 'sweep', sitemapKind: kind, lastmod }));
    }
  }
  const gone = (await q(`select url from kb_documents where status='active'`)).rows.map((r) => r.url).filter((u) => !seen.has(u));
  for (const u of gone) await ingestUrl(u, { action: 'trash', source: 'sweep' });
  await q(`delete from kb_documents where status='archived' and updated_at < now() - interval '30 days'`);
  return { checked: seen.size, changed: results.length, archived: gone.length };
}
