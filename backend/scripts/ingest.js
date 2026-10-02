// node scripts/ingest.js            → seed from the local scrape folder (SCRAPE_DIR)
// node scripts/ingest.js --sitemap  → live sweep of dynamiqes.com sitemap
// node scripts/ingest.js <url>      → one URL
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from '../src/config.js';
import { pool, q } from '../src/db.js';
import { ingestScrapeDir, sweepSitemap, ingestUrl } from '../src/ingest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2];
let out;
if (arg === '--sitemap') out = await sweepSitemap();
else if (arg) out = await ingestUrl(arg, { source: 'manual' });
else out = await ingestScrapeDir(path.resolve(here, '..', cfg.scrapeDir));
console.log(JSON.stringify(out, null, 1).slice(0, 4000));
const n = (await q('select count(*)::int c from kb_chunks')).rows[0].c;
await q('create index if not exists kb_chunks_emb_idx on kb_chunks using hnsw (embedding vector_cosine_ops)');
console.log('total chunks:', n);
await pool.end();
