// Dashboard accounts from the command line.
//   npm run user:create -- --role superuser --email you@dynamiqes.com [--name "Your Name"]
//   npm run user:reset-password -- --email you@dynamiqes.com
// The password is asked for (hidden), or read from standard input with --password-stdin.
// With the embedded database (DATABASE_URL=pglite:…) stop the backend first: only one program may open it.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { cfg } from '../src/config.js';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const flag = (k) => args.includes('--' + k);
const reset = flag('reset') || process.env.npm_lifecycle_event === 'user:reset-password';
const fail = (m) => { console.error(m); process.exit(1); };

const email = String(opt('email') || '').trim().toLowerCase();
const role = opt('role') || (reset ? undefined : 'user');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail('Give an email: --email name@company.com');

if (cfg.databaseUrl.startsWith('pglite:')) {
  try { await fetch(`http://127.0.0.1:${cfg.port}/api/health`, { signal: AbortSignal.timeout(1500) }); fail(`The backend is running on :${cfg.port}. Stop it first (npm run stop): the embedded database can only be opened by one program.`); }
  catch { /* not running: safe to open the database */ }
}

async function askHidden(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(s); }; // don't echo what is typed
  const a = await new Promise((r) => rl.question(prompt, r)); rl.close(); process.stdout.write('\n'); return a;
}
let password;
if (flag('password-stdin')) password = fs.readFileSync(0, 'utf8').split(/\r?\n/)[0];
else {
  password = await askHidden('Password: ');
  if ((await askHidden('Repeat password: ')) !== password) fail('The passwords do not match.');
}

const { q, exec, pool } = await import('../src/db.js');
const { hashPassword, passwordProblem } = await import('../src/auth.js');
const { ROLES } = await import('../src/permissions.js');
const done = async (code, msg) => { if (msg) console.log(msg); await pool.end(); process.exit(code); };
const bad = passwordProblem(password);
if (bad) await done(1, bad);
const here = path.dirname(fileURLToPath(import.meta.url));
await exec(fs.readFileSync(path.join(here, '../sql/schema.sql'), 'utf8')); // users table exists even on a fresh database

const existing = (await q('select id, role from users where email = $1', [email])).rows[0];
if (reset) {
  if (!existing) await done(1, `No user ${email}.`);
  await q('update users set password_hash = $2, failed_logins = 0, locked_until = null where id = $1', [existing.id, await hashPassword(password)]);
  await q('delete from admin_sessions where user_id = $1', [existing.id]);
  await q(`insert into audit_log(user_email, action, target, detail) values($1, 'user.password_reset', $1, '{"via":"command line"}')`, [email]);
  await done(0, `Password reset for ${email}. Other sessions were signed out.`);
}
if (!ROLES.includes(role)) await done(1, `--role must be one of: ${ROLES.join(', ')}`);
if (existing) await done(1, `${email} already exists (${existing.role}). Use npm run user:reset-password to change the password.`);
await q('insert into users(email, name, role, password_hash) values($1, $2, $3, $4)', [email, opt('name') || null, role, await hashPassword(password)]);
await q(`insert into audit_log(user_email, action, target, detail) values($1, 'user.created', $1, $2)`, [email, { role, via: 'command line' }]);
await done(0, `Created ${role} ${email}. Sign in at http://localhost:${cfg.port}/admin`);
