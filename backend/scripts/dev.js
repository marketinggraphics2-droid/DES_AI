// Safe dev runner (npm run dev). Restarts the server when src/ or sql/ change, like `node --watch`,
// but asks it to shut down cleanly first so the embedded PGlite database is never killed mid-write
// (`node --watch` hard-kills on Windows, which corrupted the local database several times).
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'server.js');
let child = null, restarting = false, quitting = false, pending = false;

let ready = null; // resolves when the current server has opened the database and is listening
function start() {
  child = fork(entry, [], { cwd: root, stdio: 'inherit' });
  let markReady; ready = new Promise((r) => { markReady = r; });
  child.on('message', (m) => { if (m === 'ready') markReady(); });
  child.on('exit', (code) => {
    markReady();
    child = null;
    if (quitting) process.exit(0);
    if (code === 99) { console.log('[dev] stopped (npm run stop)'); process.exit(0); }
    if (restarting) return;
    console.log(`[dev] server exited (${code}). Waiting for a file change to restart…`);
  });
}

async function stopChild() {
  // never interrupt a server that is still opening the database: wait until it is listening (max 30 s)
  if (child && ready) await Promise.race([ready, new Promise((r) => setTimeout(r, 30000))]);
  return new Promise((resolve) => {
    if (!child) return resolve();
    const c = child;
    const hard = setTimeout(() => { console.log('[dev] server did not stop in 12 s, forcing'); c.kill(); }, 12000);
    c.once('exit', () => { clearTimeout(hard); resolve(); });
    try { c.send('shutdown'); } catch { c.kill(); }
  });
}

async function restart(file) {
  if (restarting) { pending = true; return; }
  restarting = true;
  console.log(`[dev] ${file} changed, restarting cleanly…`);
  await stopChild();
  restarting = false;
  start();
  if (pending) { pending = false; restart('more files'); }
}

let timer = null, lastFile = '';
const seen = new Map(); // file -> last modified time; Windows fires several events per save, only real changes count
for (const dir of ['src', 'sql']) {
  fs.watch(path.join(root, dir), { recursive: true }, (_ev, file) => {
    if (!file || !/\.(js|sql)$/.test(file)) return;
    let mtime = 0; try { mtime = fs.statSync(path.join(root, dir, file)).mtimeMs; } catch { }
    const key = `${dir}/${file}`;
    if (seen.get(key) === mtime) return;
    seen.set(key, mtime);
    lastFile = key;
    clearTimeout(timer); timer = setTimeout(() => restart(lastFile), 500); // debounce bursts of saves
  });
}

async function quit() {
  if (quitting) return; quitting = true;
  await stopChild();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, quit);

console.log('[dev] safe dev runner: restarts on changes in src/ and sql/, stop with Ctrl+C');
start();
