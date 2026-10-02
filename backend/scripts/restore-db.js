// Restore the embedded (PGlite) database from a snapshot.
//   npm run db:restore              -> newest snapshot
//   npm run db:restore -- <file>    -> a specific .tar.gz from the backups folder
// Stop the backend first. The current database folder is kept as <folder>.broken-<time>, never deleted.
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../src/config.js';

if (!cfg.databaseUrl.startsWith('pglite:')) { console.error('DATABASE_URL is not pglite:, nothing to restore here.'); process.exit(1); }
const dir = (cfg.databaseUrl.slice('pglite:'.length) || './data/pglite').replace(/[\\/]+$/, '');
const backupDir = dir + '-backups';
const all = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => f.endsWith('.tar.gz')).sort() : [];
if (!all.length) { console.error(`No snapshots in ${backupDir}`); process.exit(1); }
const pick = process.argv[2] ? path.basename(process.argv[2]) : all[all.length - 1];
if (!all.includes(pick)) { console.error(`Not found: ${pick}\nAvailable:\n  ${all.join('\n  ')}`); process.exit(1); }

const { PGlite } = await import('@electric-sql/pglite');
const { vector } = await import('@electric-sql/pglite/vector');
if (fs.existsSync(dir)) {
  const aside = `${dir}.broken-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  fs.renameSync(dir, aside);
  console.log(`current database moved to ${aside}`);
}
const blob = new Blob([fs.readFileSync(path.join(backupDir, pick))]);
const db = await PGlite.create(dir, { extensions: { vector }, loadDataDir: blob });
const r = await db.query(`select (select count(*) from kb_chunks)::int chunks, (select count(*) from golden_answers)::int answers, (select count(*) from conversations)::int chats`);
await db.close();
console.log(`restored ${pick} → ${dir}`, r.rows[0]);
