// Dashboard accounts: email + password sign-in, session cookie, lockout, permissions on every admin route, audit log,
// user management and system settings (superuser). Roles and permissions: permissions.js.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { q } from './db.js';
import { ROLES, can, permissionsOf, routePermission, maskContacts } from './permissions.js';
import { invalidateSettings, SETTINGS } from './settings.js';

const COOKIE = 'des_admin';
const SESSION_HOURS = 12;
const LOCK_AFTER = 5, LOCK_MINUTES = 15;
export const MIN_PASSWORD = 10;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12); // same work for unknown emails
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

export const hashPassword = (p) => bcrypt.hash(String(p), 12);
export function passwordProblem(p) {
  const s = String(p || '');
  if (s.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (/^(.)\1+$/.test(s) || /^(password|1234567890|qwertyuiop)/i.test(s)) return 'Choose a less guessable password.';
  return null;
}

function readCookie(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}
function setCookie(req, res, value, maxAgeSec) {
  // Secure everywhere except plain http on this computer (browsers keep Secure cookies off non-https sites)
  const host = String(req.headers.host || '').split(':')[0];
  const localHttp = !req.secure && req.headers['x-forwarded-proto'] !== 'https' && ['localhost', '127.0.0.1', '[::1]'].includes(host);
  res.append('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${localHttp ? '' : '; Secure'}`);
}

/** Who did what, when. Never throws. */
export async function audit(req, action, target = null, detail = null, who = req.user) {
  try {
    await q('insert into audit_log(user_id, user_email, action, target, detail, ip) values($1,$2,$3,$4,$5,$6)',
      [who?.id || null, who?.email || null, action, target == null ? null : String(target).slice(0, 200), detail, req.adminIp || null]);
  } catch (e) { console.error('audit failed', e.message); }
}

/** Session check + permission check for every /api/admin request. Unlisted routes are refused. */
export async function adminAuth(req, res, next) {
  try {
    if (req.path === '/auth/login' || req.path === '/shutdown') return next(); // shutdown checks its own machine token
    const tok = readCookie(req);
    const s = tok && (await q(`select s.token_hash, s.expires_at, u.id, u.email, u.name, u.role, u.disabled
                               from admin_sessions s join users u on u.id = s.user_id where s.token_hash = $1`, [sha(tok)])).rows[0];
    if (!s || s.disabled || new Date(s.expires_at) < new Date()) return res.status(401).json({ error: 'login_required' });
    q('update admin_sessions set last_seen_at = now() where token_hash = $1', [s.token_hash]).catch(() => { });
    req.user = { id: s.id, email: s.email, name: s.name, role: s.role }; req.sessionHash = s.token_hash;
    // changes need a header a cross-site form or image cannot send (with SameSite=Strict on the cookie)
    if (!['GET', 'HEAD'].includes(req.method) && req.get('x-des-admin') !== '1') return res.status(403).json({ error: 'csrf' });
    const perm = routePermission(req.method, req.path);
    if (!perm || !can(s.role, perm)) return res.status(403).json({ error: 'forbidden', permission: perm });
    if (!can(s.role, 'contacts.full')) { const json = res.json.bind(res); res.json = (b) => json(maskContacts(b)); }
    next();
  } catch (e) { next(e); }
}

export const authRouter = Router();
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, disabled: !!u.disabled, locked_until: u.locked_until, last_login_at: u.last_login_at, created_at: u.created_at });

authRouter.post('/auth/login', wrap(async (req, res) => {
  const email = normEmail(req.body?.email), password = String(req.body?.password || '');
  const u = (await q('select * from users where email = $1', [email])).rows[0];
  if (u?.locked_until && new Date(u.locked_until) > new Date()) {
    await audit(req, 'login.locked', email, null, u);
    return res.status(423).json({ error: 'account_locked', until: u.locked_until });
  }
  const ok = await bcrypt.compare(password, u?.password_hash || DUMMY_HASH);
  if (!u || !ok || u.disabled) {
    if (u && !u.disabled) {
      const r = (await q(`update users set failed_logins = failed_logins + 1,
                          locked_until = case when failed_logins + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end
                          where id = $1 returning failed_logins, locked_until`, [u.id, LOCK_AFTER, LOCK_MINUTES])).rows[0];
      await audit(req, r.failed_logins >= LOCK_AFTER ? 'login.locked' : 'login.failed', email, { attempts: r.failed_logins }, u);
    } else await audit(req, 'login.failed', email, { reason: u ? 'disabled' : 'unknown email' }, null);
    return res.status(401).json({ error: 'invalid_login' });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await q(`insert into admin_sessions(token_hash, user_id, expires_at, ip, user_agent) values($1, $2, now() + make_interval(hours => $3), $4, $5)`,
    [sha(token), u.id, SESSION_HOURS, req.adminIp || null, String(req.headers['user-agent'] || '').slice(0, 200)]);
  await q('update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1', [u.id]);
  await q(`delete from admin_sessions where expires_at < now()`);
  setCookie(req, res, token, SESSION_HOURS * 3600);
  await audit(req, 'login', u.email, null, u);
  res.json({ ok: true, user: publicUser(u), permissions: permissionsOf(u.role) });
}));

authRouter.post('/auth/logout', wrap(async (req, res) => {
  await q('delete from admin_sessions where token_hash = $1', [req.sessionHash]);
  setCookie(req, res, '', 0);
  await audit(req, 'logout');
  res.json({ ok: true });
}));

authRouter.get('/auth/me', (req, res) => res.json({ user: req.user, permissions: permissionsOf(req.user.role) }));

authRouter.post('/auth/password', wrap(async (req, res) => {
  const u = (await q('select * from users where id = $1', [req.user.id])).rows[0];
  if (!(await bcrypt.compare(String(req.body?.current || ''), u.password_hash))) return res.status(400).json({ error: 'wrong_password' });
  const bad = passwordProblem(req.body?.password);
  if (bad) return res.status(400).json({ error: 'weak_password', message: bad });
  await q('update users set password_hash = $2 where id = $1', [u.id, await hashPassword(req.body.password)]);
  await q('delete from admin_sessions where user_id = $1 and token_hash <> $2', [u.id, req.sessionHash]); // sign out other devices
  await audit(req, 'password.changed', u.email);
  res.json({ ok: true });
}));

// ---- user management (superuser) ----
authRouter.get('/users', wrap(async (_req, res) => {
  res.json((await q('select * from users order by created_at')).rows.map(publicUser));
}));
authRouter.post('/users', wrap(async (req, res) => {
  const email = normEmail(req.body?.email), role = req.body?.role, name = String(req.body?.name || '').trim().slice(0, 80) || null;
  if (!validEmail(email)) return res.status(400).json({ error: 'bad_email' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'bad_role' });
  const bad = passwordProblem(req.body?.password);
  if (bad) return res.status(400).json({ error: 'weak_password', message: bad });
  if ((await q('select 1 from users where email = $1', [email])).rowCount) return res.status(409).json({ error: 'email_taken' });
  const u = (await q('insert into users(email, name, role, password_hash) values($1,$2,$3,$4) returning *', [email, name, role, await hashPassword(req.body.password)])).rows[0];
  await audit(req, 'user.created', email, { role });
  res.json(publicUser(u));
}));
/** The last active superuser can't be demoted or disabled (nobody could manage users any more). */
async function lastSuperuser(id) {
  const r = (await q(`select count(*)::int n from users where role = 'superuser' and not disabled and id <> $1`, [id])).rows[0];
  return r.n === 0;
}
authRouter.put('/users/:id', wrap(async (req, res) => {
  const u = (await q('select * from users where id = $1', [req.params.id])).rows[0];
  if (!u) return res.status(404).json({ error: 'not_found' });
  const { role, disabled, name, unlock } = req.body || {};
  if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ error: 'bad_role' });
  if (u.role === 'superuser' && ((role && role !== 'superuser') || disabled === true) && (await lastSuperuser(u.id))) return res.status(400).json({ error: 'last_superuser' });
  if (role !== undefined && role !== u.role) { await q('update users set role = $2 where id = $1', [u.id, role]); await audit(req, 'user.role_changed', u.email, { from: u.role, to: role }); }
  if (disabled !== undefined && !!disabled !== !!u.disabled) {
    await q('update users set disabled = $2 where id = $1', [u.id, !!disabled]);
    if (disabled) await q('delete from admin_sessions where user_id = $1', [u.id]);
    await audit(req, disabled ? 'user.disabled' : 'user.enabled', u.email);
  }
  if (name !== undefined) await q('update users set name = $2 where id = $1', [u.id, String(name).trim().slice(0, 80) || null]);
  if (unlock) { await q('update users set failed_logins = 0, locked_until = null where id = $1', [u.id]); await audit(req, 'user.unlocked', u.email); }
  res.json(publicUser((await q('select * from users where id = $1', [u.id])).rows[0]));
}));
authRouter.post('/users/:id/password', wrap(async (req, res) => {
  const u = (await q('select * from users where id = $1', [req.params.id])).rows[0];
  if (!u) return res.status(404).json({ error: 'not_found' });
  const bad = passwordProblem(req.body?.password);
  if (bad) return res.status(400).json({ error: 'weak_password', message: bad });
  await q('update users set password_hash = $2, failed_logins = 0, locked_until = null where id = $1', [u.id, await hashPassword(req.body.password)]);
  await q('delete from admin_sessions where user_id = $1', [u.id]);
  await audit(req, 'user.password_reset', u.email);
  res.json({ ok: true });
}));

// ---- audit log (superuser) ----
authRouter.get('/audit', wrap(async (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 100), offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const action = req.query.action ? String(req.query.action).slice(0, 60) + '%' : null, who = req.query.user ? '%' + String(req.query.user).slice(0, 80) + '%' : null;
  const where = `($1::text is null or action like $1) and ($2::text is null or user_email ilike $2)`;
  const rows = (await q(`select * from audit_log where ${where} order by id desc limit $3 offset $4`, [action, who, limit, offset])).rows;
  const total = (await q(`select count(*)::int n from audit_log where ${where}`, [action, who])).rows[0].n;
  res.set('x-total-count', String(total)).json(rows);
}));

// ---- system settings (superuser): values that override .env without a restart ----
authRouter.get('/settings', wrap(async (_req, res) => {
  const rows = Object.fromEntries((await q('select key, value, updated_by, updated_at from app_settings')).rows.map((r) => [r.key, r]));
  res.json(SETTINGS.map((s) => ({ ...s, value: rows[s.key]?.value ?? null, effective: s.current(), updated_by: rows[s.key]?.updated_by || null, updated_at: rows[s.key]?.updated_at || null })));
}));
authRouter.put('/settings', wrap(async (req, res) => {
  const changed = {};
  for (const s of SETTINGS) {
    if (!(s.key in (req.body || {}))) continue;
    const raw = req.body[s.key];
    if (raw === null || raw === '') { await q('delete from app_settings where key = $1', [s.key]); changed[s.key] = '(default)'; continue; }
    const v = s.parse(raw);
    if (v === null) return res.status(400).json({ error: 'bad_value', key: s.key });
    await q(`insert into app_settings(key, value, updated_by, updated_at) values($1,$2,$3,now()) on conflict(key) do update set value=excluded.value, updated_by=excluded.updated_by, updated_at=now()`, [s.key, String(v), req.user.email]);
    changed[s.key] = v;
  }
  await invalidateSettings();
  await audit(req, 'settings.changed', null, changed);
  res.json({ ok: true });
}));
