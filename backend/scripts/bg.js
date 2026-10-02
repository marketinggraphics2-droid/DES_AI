// npm run bg — start the backend in the background (no window needed), with the safe dev runner.
// Output goes to logs/backend.log. Stop it with `npm run stop` (clean shutdown, database closed properly).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT || 8787;
try {
  const r = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
  if (r.ok) { console.log(`Backend is already running on :${port}. Stop it first with: npm run stop`); process.exit(0); }
} catch { /* not running: good */ }

fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
const logFile = path.join(root, 'logs', 'backend.log');
fs.appendFileSync(logFile, `\n===== started ${new Date().toISOString()} =====\n`);
const out = fs.openSync(logFile, 'a');
const child = spawn(process.execPath, [path.join(root, 'scripts', 'dev.js')], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
child.unref();
fs.writeFileSync(path.join(root, 'logs', 'backend.pid'), String(child.pid));

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try { const r = await fetch(`http://localhost:${port}/api/health`); if (r.ok) { console.log(`Backend running in the background on http://localhost:${port}\n  dashboard: http://localhost:${port}/admin\n  log:       ${logFile}\n  stop:      npm run stop`); process.exit(0); } } catch { }
}
console.log(`Started, but it is not answering yet. Check the log: ${logFile}`);
