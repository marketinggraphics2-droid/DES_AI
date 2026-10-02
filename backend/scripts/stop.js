// npm run stop — clean shutdown of the running backend (closes the database properly, writes a final snapshot).
import 'dotenv/config';
const port = process.env.PORT || 8787;
const base = `http://127.0.0.1:${port}`;
try {
  const r = await fetch(base + '/api/admin/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + (process.env.ADMIN_TOKEN || '') } });
  if (!r.ok) { console.log(`The backend refused to stop (${r.status}). Is ADMIN_TOKEN in .env correct?`); process.exit(1); }
} catch { console.log(`Nothing is running on :${port}.`); process.exit(0); }
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try { await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) }); } catch { console.log('Backend stopped cleanly.'); process.exit(0); }
}
console.log('Asked the backend to stop, but it is still answering after 15 s. Check logs/backend.log.');
