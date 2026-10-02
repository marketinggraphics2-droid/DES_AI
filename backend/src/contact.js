// Name + contact validation for onboarding. The server is the gate: the widget mirrors the quick checks
// for instant feedback, but a session is only created when these pass.
// Contact = email (work email preferred) or a phone number usable for a call, SMS, Viber, WhatsApp, WeChat, Telegram…
import dns from 'node:dns/promises';

const FREE_EMAIL = new Set(('gmail.com googlemail.com yahoo.com yahoo.com.ph ymail.com rocketmail.com outlook.com outlook.ph hotmail.com hotmail.ph ' +
  'live.com msn.com icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me gmx.com gmx.net mail.com zoho.com zohomail.com ' +
  'yandex.com yandex.ru qq.com 163.com 126.com sina.com foxmail.com naver.com hanmail.net').split(' '));
const DISPOSABLE = new Set(('mailinator.com guerrillamail.com guerrillamail.net guerrillamail.org sharklasers.com grr.la 10minutemail.com 10minutemail.net ' +
  'tempmail.com temp-mail.org temp-mail.io tempmail.net tempmailo.com yopmail.com yopmail.net trashmail.com trashmail.de getnada.com nada.email ' +
  'dispostable.com maildrop.cc fakeinbox.com throwawaymail.com mintemail.com mohmal.com emailondeck.com tempail.com burnermail.io spamgourmet.com ' +
  'mailnesia.com moakt.com tmpmail.org tmpmail.net tmail.ws inboxkitten.com mailpoof.com getairmail.com emailfake.com fakemail.net 33mail.com ' +
  'mailcatch.com spambox.us discard.email crazymailing.com mail.tm mytemp.email luxusmail.org').split(' '));
const PLACEHOLDER_DOMAIN = new Set(('example.com example.net example.org test.com testing.com domain.com email.com sample.com fake.com fakemail.com ' +
  'asdf.com qwerty.com noemail.com none.com na.com xxx.com abc.xyz company.com yourcompany.com mycompany.com business.com website.com').split(' '));
const RESERVED_TLD = /\.(test|example|invalid|localhost|local|lan|internal)$/i;
const FAKE_LOCAL = /^(test(ing|er)?\d*|sample|demo|asdf+|qwerty|abc+d?|abc123|x{2,}|a{2,}|none|noemail|no-?reply|null|na|n-?a|nobody|someone|anonymous|anon|user\d*|admin|email|mail|fake|dummy|example|\d+|hello|hi|me|myemail|your-?email|name)$/i;

const FAKE_NAME = new Set(('test testing tester sample demo user admin administrator anonymous anon none na nobody name myname noname guest visitor customer client ' +
  'asdf asd qwerty abc abcd xyz xxx aaa unknown secret private hello hi hey bot ai chatgpt gpt des dynamiq sir maam madam mister miss ' +
  'ako me myself i yo person human someone somebody fake dummy null undefined').split(' '));
const VOWEL = /[aeiouyàáâãäåèéêëìíîïòóôõöùúûüýÿ]/i;

/** @returns {{ok:true, value:string} | {ok:false, code:'bad_name'|'fake_name'}} */
const NAME_PREFIX = /^(?:(?:hi|hello|hey|good (?:morning|afternoon|evening))[,!.\s]+)?(?:i'?m|i am|im|my name is|my name'?s|name is|name'?s|this is|it'?s|call me|ako si|ako po si|ako po|ako ay|si|ang pangalan ko ay|pangalan ko ay|pangalan ko)\s+(?=\S)/i;
export const stripNamePrefix = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').replace(NAME_PREFIX, '');
export function validateName(raw) {
  const v = stripNamePrefix(raw);
  if (!/^[\p{L} .'-]{2,60}$/u.test(v) || (v.match(/\p{L}/gu) || []).length < 2) return { ok: false, code: 'bad_name' };
  const low = v.toLowerCase().replace(/[.'-]/g, '');
  const words = low.split(' ').filter(Boolean);
  if (FAKE_NAME.has(low) || FAKE_NAME.has(low.replace(/\s/g, '')) || words.every((w) => FAKE_NAME.has(w))) return { ok: false, code: 'fake_name' };
  for (const w of words) {
    if (/^(.)\1+$/u.test(w)) return { ok: false, code: 'fake_name' };                      // aaa, zzzz
    if (w.length >= 4 && !VOWEL.test(w)) return { ok: false, code: 'fake_name' };         // sdfg, hjkl
    if (/[^aeiouy\s]{5,}/i.test(w.normalize('NFD').replace(/\p{M}/gu, ''))) return { ok: false, code: 'fake_name' }; // keyboard mash
    if (/(.)\1{3,}/u.test(w)) return { ok: false, code: 'fake_name' };                    // joooohn
  }
  return { ok: true, value: v.replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) };
}

const PLATFORM = [
  [/\b(viber)\b/i, 'viber'], [/\b(whats\s?app|wa)\b/i, 'whatsapp'], [/\b(we\s?chat|weixin)\b/i, 'wechat'],
  [/\b(telegram|tg)\b/i, 'telegram'], [/\b(signal)\b/i, 'signal'], [/\b(line)\b/i, 'line'],
];
const PHONE_WORDS = /\b(viber|whats\s?app|wa|we\s?chat|weixin|telegram|tg|signal|line|sms|text|call|mobile|mob|cell(phone)?|cp|phone|tel|telephone|landline|number|no|num|my|is|at|or|and|ph|philippines)\b|[#:]/gi;

function fakeDigits(d) {
  if (/(\d)\1{5,}/.test(d)) return true;                                   // 6+ identical in a row
  let up = 1, down = 1;
  for (let i = 1; i < d.length; i++) {
    up = (+d[i] === (+d[i - 1] + 1) % 10) ? up + 1 : 1;
    down = (+d[i] === (+d[i - 1] + 9) % 10) ? down + 1 : 1;
    if (up >= 6 || down >= 6) return true;                                 // 123456, 987654
  }
  if (/^(\d{2})\1{3,}/.test(d.slice(-8)) || /^(\d{3})\1{2,}/.test(d.slice(-9))) return true; // 12121212, 123123123
  return new Set(d.slice(-7)).size <= 2;                                   // 0101011 etc.
}

/** Phone in any common format → E.164-ish string. */
function parsePhone(raw) {
  const s = String(raw ?? '');
  const platform = (PLATFORM.find(([re]) => re.test(s)) || [])[1] || null;
  const stripped = s.replace(PHONE_WORDS, ' ').replace(/[\s().\-–/]/g, '');
  if (!/^\+?\d+$/.test(stripped)) return null;
  let d = stripped.replace(/^\+/, '');
  const intl = stripped.startsWith('+') || stripped.startsWith('00');
  if (stripped.startsWith('00')) d = d.slice(2);
  let value, type;
  if (/^(63|0)?9\d{9}$/.test(d)) { value = '+63' + d.slice(-10); type = platform || 'mobile'; }               // PH mobile
  else if (!intl && /^0[2-8]\d{7,8}$/.test(d)) { value = '+63' + d.slice(1); type = 'landline'; }             // PH landline, e.g. 02 8365 0228
  else if (/^63[2-8]\d{7,8}$/.test(d)) { value = '+' + d; type = 'landline'; }
  else if (intl && /^[1-9]\d{7,14}$/.test(d)) { value = '+' + d; type = platform || 'mobile'; }              // other countries, with country code
  else return { error: 'bad_contact' };
  if (fakeDigits(value.replace(/^\+(63)?/, ''))) return { error: 'fake_contact' };
  return { value, type };
}

const EMAIL_RE = /^([a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?)@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})$/;

function parseEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/^(e-?mail|email address|my email is|mail)\s*[:\-]?\s*/i, '');
  if (!s.includes('@')) return null;
  const m = s.match(EMAIL_RE);
  if (!m || s.includes('..')) return { error: 'bad_contact' };
  const [, local, domain] = m;
  if (DISPOSABLE.has(domain) || [...DISPOSABLE].some((d) => domain.endsWith('.' + d))) return { error: 'disposable_email' };
  if (PLACEHOLDER_DOMAIN.has(domain) || RESERVED_TLD.test(domain) || /^(test|example|sample|fake|asdf)\./.test(domain)) return { error: 'fake_contact' };
  if (FAKE_LOCAL.test(local)) return { error: 'fake_contact' };
  return { value: s, type: FREE_EMAIL.has(domain) ? 'email' : 'work_email', domain };
}

/** True when the domain can receive mail (MX, or A/AAAA fallback). Fails open on DNS trouble so real visitors are never stuck. */
async function domainReceivesMail(domain) {
  const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), 3000))]);
  try { const mx = await withTimeout(dns.resolveMx(domain)); if (mx.some((r) => r.exchange && r.exchange !== '.')) return true; }
  catch (e) { if (!['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'NXDOMAIN'].includes(e.code)) return true; }
  try { const a = await withTimeout(dns.resolve4(domain)); return a.length > 0; }
  catch (e) { return !['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(e.code); }
}

/**
 * @returns {Promise<{ok:true, value:string, type:string} | {ok:false, code:string}>}
 * types: work_email | email | mobile | landline | viber | whatsapp | wechat | telegram | signal | line
 * codes: contact_required | bad_contact | fake_contact | disposable_email | email_domain
 */
export async function validateContact(raw, { checkDns = true } = {}) {
  if (raw == null || !String(raw).trim()) return { ok: false, code: 'contact_required' };
  const e = parseEmail(raw);
  if (e) {
    if (e.error) return { ok: false, code: e.error };
    if (checkDns && !FREE_EMAIL.has(e.domain) && !(await domainReceivesMail(e.domain))) return { ok: false, code: 'email_domain' };
    return { ok: true, value: e.value, type: e.type };
  }
  const p = parsePhone(raw);
  if (!p) return { ok: false, code: 'bad_contact' };
  if (p.error) return { ok: false, code: p.error };
  return { ok: true, value: p.value, type: p.type };
}

export const isFreeEmailDomain = (d) => FREE_EMAIL.has(String(d || '').toLowerCase());
