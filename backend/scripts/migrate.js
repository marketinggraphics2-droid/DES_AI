import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, q, exec } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(here, '../sql/schema.sql'), 'utf8');
await exec(sql);
const n = (await q('select count(*)::int c from kb_chunks')).rows[0].c;
if (n > 0) await q('create index if not exists kb_chunks_emb_idx on kb_chunks using hnsw (embedding vector_cosine_ops)');
console.log('schema ok ·', n, 'chunks');
await pool.end();
