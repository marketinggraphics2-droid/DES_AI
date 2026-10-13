// Test helpers: an isolated test backend (own port + temp database), HTTP/SSE helpers, a jsdom loader, result tracking.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { validatePhone } from '../src/contact.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 10000, step = 60) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch { } await sleep(step); } return false; }

// ---------------- results ----------------
export const results = [];
let section = '';
export function sec(name) { section = name; console.log(`\n## ${name}`); }
export function ok(label, cond, extra = '') {
  results.push({ section, label, status: cond ? 'pass' : 'fail', extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + String(extra).replace(/\s+/g, ' ').slice(0, 140) : ''}`);
}
/** Non-deterministic AI behaviour (e.g. whether the model chose to call a tool): reported, never a failure. */
export function info(label, extra = '') {
  results.push({ section, label, status: 'info', extra });
  console.log(`INFO  ${label}${extra ? ' — ' + String(extra).replace(/\s+/g, ' ').slice(0, 140) : ''}`);
}
/** Runs a section; a crash or a hang (default 6 min) is reported as a failure instead of stopping the run. */
export async function guard(label, fn, ms = 360000) {
  let timer; const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('section timed out after ' + Math.round(ms / 1000) + ' s')), ms); });
  try { await Promise.race([fn(), limit]); } catch (e) { ok(label + (/timed out/.test(e.message) ? ' (timed out)' : ' (crashed)'), false, e.stack || e.message); } finally { clearTimeout(timer); }
}

// ---------------- isolated test backend ----------------
export const ADMIN = 'test-admin-token-' + Math.random().toString(36).slice(2); // machine token: only npm run stop / shutdown
/** Dashboard accounts created in every test database (npm run user:create). */
export const PASSWORD = 'Test-password-4821';
export const USERS = { superuser: 'super@des-test.dev', admin: 'admin@des-test.dev', user: 'user@des-test.dev' };
export function createUser(env, role, email, password = PASSWORD) {
  return spawnSync(process.execPath, ['scripts/user.js', '--role', role, '--email', email, '--name', role + ' tester', '--password-stdin'], { cwd: ROOT, env, input: password + '\n', encoding: 'utf8' });
}
export function testEnv(port, dbDir, extra = {}) {
  return {
    ...process.env, PORT: String(port), DATABASE_URL: 'pglite:' + dbDir, ADMIN_TOKEN: ADMIN, DES_TEST_HOOKS: '1',
    TURNSTILE_SECRET: '', SMTP_HOST: '', PUBLIC_URL: '', WEBSITE_URL: '',
    ALLOWED_ORIGINS: [process.env.ALLOWED_ORIGINS, 'http://localhost:' + port].filter(Boolean).join(','), // the test backend's own pages count as an approved site
    RATE_SESSIONS_PER_IP_DAY: '1000', RATE_SESSIONS_PER_CONTACT_DAY: '3', RATE_MSG_PER_10MIN: '30', ...extra,
  };
}
export function tempDb() { return fs.mkdtempSync(path.join(os.tmpdir(), 'des-test-')).replace(/\\/g, '/') + '/db'; }
export function prepareDb(env) {
  for (const s of ['scripts/migrate.js', 'scripts/ingest.js']) {
    const r = spawnSync(process.execPath, [s], { cwd: ROOT, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${s} failed: ${r.stderr || r.stdout}`);
  }
  for (const [role, email] of Object.entries(USERS)) {
    const r = createUser(env, role, email);
    if (r.status !== 0) throw new Error(`user:create ${role} failed: ${r.stderr || r.stdout}`);
  }
}
/** Sign in to the dashboard; returns the session cookie ("des_admin=…") or null. */
export async function login(base, role = 'superuser', password = PASSWORD) {
  const r = await fetch(base + '/api/admin/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: USERS[role] || role, password }) });
  const c = (r.headers.getSetCookie?.() || []).find((x) => x.startsWith('des_admin='));
  return r.ok && c ? c.split(';')[0] : null;
}
export async function startServer(env, { script = 'src/server.js' } = {}) {
  const proc = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.log = '';
  proc.stdout.on('data', (d) => { proc.log += d; }); proc.stderr.on('data', (d) => { proc.log += d; });
  const base = `http://localhost:${env.PORT}`;
  const up = await until(async () => (await fetch(base + '/api/health')).ok, 60000, 300);
  if (!up) throw new Error('test backend did not start:\n' + proc.log.slice(-1500));
  return { proc, base };
}
export async function stopServer(base, proc) {
  try { await fetch(base + '/api/admin/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + ADMIN } }); } catch { }
  const exited = await until(() => proc.exitCode !== null, 15000, 100);
  if (!exited) proc.kill();
  return exited;
}

// ---------------- identities (each scenario gets its own connection + device so bans never leak) ----------------
let n = 0;
export function ident() { n++; return { ip: `198.18.${Math.floor(n / 250)}.${(n % 250) + 1}`, dev: `test-device-${process.pid}-${n}`.padEnd(20, 'x') }; }
export const uniqueEmail = (tag = 'qa') => `${tag}.t${Date.now().toString(36)}${n}@dynamiqes.com`;
/** A valid, not-yet-used PH mobile number (rate limits count per number). */
const usedPhones = new Set();
export function uniquePhone(prefix = '0917') { for (;;) { const p = prefix + String(Math.floor(Math.random() * 1e7)).padStart(7, '0'); if (!usedPhones.has(p) && validatePhone(p).ok) { usedPhones.add(p); return p; } } }

// ---------------- HTTP ----------------
export function api(base) {
  const cookies = {}; // role -> session cookie, signed in on first use
  const headers = (id, token, cookie) => ({
    'content-type': 'application/json',
    ...(id ? { 'cf-connecting-ip': id.ip, 'x-des-device': id.dev, origin: base } : {}),
    ...(token ? { authorization: 'Bearer ' + token } : {}), ...(cookie ? { cookie, 'x-des-admin': '1' } : {}),
  });
  /** admin: true = signed in as the test superuser; as: 'admin' | 'user' | 'superuser' for another role; cookie: a given session */
  async function req(method, p, { body, id, token, admin, as, cookie, raw } = {}) {
    const role = as || (admin ? 'superuser' : null);
    if (role && !cookie) cookie = cookies[role] ||= await login(base, role);
    const r = await fetch(base + p, { method, headers: headers(id, token, cookie), body: body !== undefined ? JSON.stringify(body) : undefined });
    if (raw) return r;
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { }
    return { status: r.status, json, text, headers: r.headers };
  }
  async function chat(token, message, id, { held, prefix, hook } = {}) {
    const r = await fetch(base + '/api/chat', { method: 'POST', headers: { ...headers(id, token), ...(hook || {}) }, body: JSON.stringify({ message, ...(held ? { held: true } : {}), ...(prefix ? { prefix } : {}) }) });
    const text = await r.text();
    const events = text.split('\n\n').map((b) => ({ ev: b.match(/^event: (.*)$/m)?.[1], data: b.match(/^data: (.*)$/m)?.[1] })).filter((x) => x.ev).map((x) => ({ ev: x.ev, data: JSON.parse(x.data) }));
    return { status: r.status, events, done: events.find((e) => e.ev === 'done')?.data || null, error: events.find((e) => e.ev === 'error')?.data || null, types: events.filter((e) => e.ev === 'event').map((e) => e.data.type) };
  }
  const person = (o = {}) => ({ name: 'Ana Reyes', phone: uniquePhone(), consent: { version: '2026-10-01', method: 'chip' }, marketing_opt_in: false, lang: 'en', page_url: 'http://test/', ...o });
  async function session(id, o = {}) { const r = await req('POST', '/api/session', { body: person(o), id }); return { ...r, token: r.json?.token }; }
  return { req, chat, person, session };
}

// ---------------- live dashboard stream ----------------
/** Reads GET /api/admin/stream; events land in .events as {ev, id, data}. */
export async function openStream(base, cookie, lastEventId) {
  const ac = new AbortController(); const events = [];
  const r = await fetch(base + '/api/admin/stream', { headers: { ...(cookie ? { cookie } : {}), ...(lastEventId ? { 'last-event-id': lastEventId } : {}) }, signal: ac.signal });
  if (r.ok) (async () => {
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const blk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = blk.match(/^event: (.*)$/m)?.[1]; if (!ev) continue;
          const d = blk.match(/^data: (.*)$/m)?.[1];
          events.push({ ev, id: blk.match(/^id: (.*)$/m)?.[1] || null, data: d ? JSON.parse(d) : null });
        }
      }
    } catch { /* aborted */ }
  })();
  return { status: r.status, events, close: () => ac.abort(), find: (ev, pred = () => true) => events.find((e) => e.ev === ev && pred(e.data || {})) };
}

// ---------------- jsdom (widget / dashboard) ----------------
/** jsdom's AbortSignal is not Node's: Node's fetch rejects it, so mirror it onto a Node one. */
function nodeSignal(s) {
  if (!s) return undefined;
  const ac = new AbortController();
  if (s.aborted) ac.abort(); else s.addEventListener('abort', () => ac.abort());
  return ac.signal;
}
export async function loadPage(base, pagePath, { id, cfg = '', storage = {}, beforeScripts, cookie } = {}) {
  let html = await (await fetch(base + pagePath.split('?')[0])).text();
  html = html.replace('window.DES_CFG = { idleSurveyMs: 90 * 1000 };', `window.DES_CFG = { idleSurveyMs: 90 * 1000, typingMs: [0, 0], autoOpenMs: 0${cfg ? ', ' + cfg : ''} };`);
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Could not load link|stylesheet|fonts\.googleapis|Could not parse CSS/i.test(e.message)) errors.push((e.detail?.stack || e.message).slice(0, 300)); });
  const dom = new JSDOM(html, {
    url: base + pagePath, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      // Node's fetch has no cookie jar: carry the dashboard session cookie by hand, and keep one set by a sign-in
      const jar = { cookie };
      w.fetch = async (u, o = {}) => {
        const r = await fetch(new URL(u, base), { ...o, signal: nodeSignal(o.signal), headers: { ...(o.headers || {}), ...(id ? { 'cf-connecting-ip': id.ip, origin: base } : {}), ...(jar.cookie ? { cookie: jar.cookie } : {}) } });
        const c = (r.headers.getSetCookie?.() || []).find((x) => x.startsWith('des_admin='));
        if (c) jar.cookie = /Max-Age=0/i.test(c) ? null : c.split(';')[0];
        return r;
      };
      w.__jar = jar;
      // jsdom has no EventSource: a small one on Node's fetch (same cookie), enough for the dashboard's live updates
      const streams = (w.__streams = []);
      const safe = (fn, e) => { try { fn?.(e); } catch { /* page already closed */ } };
      w.EventSource = class {
        constructor(url) {
          this.readyState = 0; this.listeners = {}; this.ac = new AbortController(); streams.push(this);
          (async () => {
            try {
              const r = await fetch(new URL(url, base), { headers: jar.cookie ? { cookie: jar.cookie } : {}, signal: this.ac.signal });
              if (!r.ok) { this.readyState = 2; if (!this.closed) safe(this.onerror, {}); return; }
              this.readyState = 1; safe(this.onopen, {});
              const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
              for (;;) {
                const { value, done } = await rd.read(); if (done) break;
                buf += dec.decode(value, { stream: true });
                let i; while ((i = buf.indexOf('\n\n')) >= 0) {
                  const blk = buf.slice(0, i); buf = buf.slice(i + 2);
                  const type = blk.match(/^event: (.*)$/m)?.[1]; if (!type) continue;
                  const e = { type, data: blk.match(/^data: (.*)$/m)?.[1] || '', lastEventId: blk.match(/^id: (.*)$/m)?.[1] || '' };
                  if (!this.closed) (this.listeners[type] || []).forEach((fn) => safe(fn, e));
                }
              }
            } catch { /* closed */ }
            if (this.readyState !== 2) { this.readyState = 2; if (!this.closed) safe(this.onerror, {}); }
          })();
        }
        addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
        close() { this.closed = true; this.readyState = 2; this.ac.abort(); }
      };
      w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
      w.ResizeObserver = class { observe() { } disconnect() { } };
      w.scrollTo = () => { }; w.Element.prototype.scrollTo = () => { }; w.HTMLElement.prototype.scrollIntoView = () => { };
      w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
      w.confirm = () => true;
      if (id) w.localStorage.setItem('des:device', JSON.stringify(id.dev));
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
      beforeScripts?.(w);
    },
  });
  const w = dom.window, d = w.document;
  w.addEventListener('error', (e) => errors.push('window: ' + (e.error?.stack || e.message)));
  return { dom, w, d, errors, $: (s) => d.querySelector(s), $$: (s) => [...d.querySelectorAll(s)], close: () => { (w.__streams || []).forEach((s) => s.close()); w.close(); } };
}

/** Widget driver: open the chat, type, tap chips, read bot bubbles. */
export async function widget(base, opts = {}) {
  const p = await loadPage(base, opts.path || '/widget/index.html', opts);
  await until(() => p.$('.dq-chat__composer input'), 8000);
  await sleep(1200);
  const input = p.$('.dq-chat__composer input');
  const bots = () => p.$$('.dq-chat__msg.is-bot:not(.is-typing) .dq-chat__bubble').map((b) => b.textContent.replace(/\s+/g, ' ').trim());
  const settle = async (n) => { await until(() => bots().length > n, 15000); let last = bots().length; for (let i = 0; i < 20; i++) { await sleep(150); if (bots().length === last && i > 4) break; last = bots().length; } };
  const open = async () => { const t = p.$('#dqChatToggle'); if (!t.checked) { t.checked = true; t.dispatchEvent(new p.w.Event('change')); } await sleep(700); };
  const say = async (text) => { const n0 = bots().length; input.value = text; input.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle(n0); return bots().at(-1) || ''; };
  // only buttons whose choice is still open; waits briefly for them to appear
  const chip = async (re) => { const n0 = bots().length; const find = () => p.$$('.dq-chat__chips:not(.is-done) button').reverse().find((x) => re.test(x.textContent)); await until(find, 6000, 50); const b = find(); if (!b) return false; b.click(); await settle(n0); return true; };
  const waitIdle = (ms = 40000) => until(() => !input.disabled || /ended|Tapos/i.test(input.placeholder), ms, 50);
  return { ...p, input, bots, say, chip, open, waitIdle, status: () => p.$('.dq-chat__status')?.textContent.trim() || '' };
}
